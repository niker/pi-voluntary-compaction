import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import { Type, type Message, type Static } from "@earendil-works/pi-ai";
import { config, DEFAULT_CONFIG, type Config } from "./config.js";
import {
  countReadFileLinesWithinTokenBudget,
  estimateLineTokens,
  estimateReadFileStats,
  readReadFileFull,
  resolveReadSourcePath,
  type ReadFileRange,
} from "./output-stream.js";

type PendingJump = { target: string; checkpointId: number; payload: string; taskCompleted: boolean; subagent: boolean; autoResume: boolean };
type PendingJumpOffer = { target: string; checkpointId: number; payload: string; allowed: boolean };
type BufferedToolOutput = { kind: "memory"; content: any[]; details: unknown; estimatedTokens: number; lineCount: number };
type ClippedRead = { offset: number; requestedLines?: number; actualLines: number };
const EXTENSION_TYPE = "pi-voluntary-compaction";
const CONFIG_ENTRY_TYPE = "pi-voluntary-compaction-config";
const CONFIG_FILE_KEY = "voluntaryCompaction";
// Private local switch for detailed interceptor diagnostics; keep disabled by default.
const ENABLE_INTERCEPTOR_LOGGING = false;
// These tools are bookkeeping for this extension, not conversation content.
// Ignore their calls/results when choosing the latest meaningful checkpoint target.
const INTERNAL_TOOLS = new Set([
  "checkpoint_create", "subagent_checkpoint_create",
  "checkpoint_jump", "subagent_checkpoint_jump", "checkpoint_list",
]);
const CHECKPOINT_JUMP_TOOL_NAMES = ["checkpoint_jump", "subagent_checkpoint_jump"] as const;
const PASSIVE_ENTRIES = new Set(["custom", "label", "session_info", "model_change", "thinking_level_change"]);

type CheckpointJumpStreamState = "jump" | "unknown" | "other" | "none";
function checkpointJumpStreamState(message: any, finalized = false): CheckpointJumpStreamState {
  const calls = Array.isArray(message?.content)
    ? message.content.filter((part: any) => part?.type === "toolCall")
    : [];
  // During streaming, tool-call parts can temporarily disappear from partial
  // message snapshots. Distinguish that from a finalized response with no call
  // so the caller can retain any already-detected jump state.
  if (calls.length === 0) return finalized ? "other" : "none";

  let jumpCandidate = false;
  let unresolvedName = false;
  for (const call of calls) {
    const name = typeof call.name === "string" ? call.name : "";
    if (CHECKPOINT_JUMP_TOOL_NAMES.includes(name as (typeof CHECKPOINT_JUMP_TOOL_NAMES)[number])) {
      jumpCandidate = true;
    } else if (name && CHECKPOINT_JUMP_TOOL_NAMES.some((jumpName) => jumpName.startsWith(name))) {
      unresolvedName = true;
    } else if (!name) {
      unresolvedName = true;
    } else {
      // A mixed tool batch must not be protected just because it also contains
      // a checkpoint jump; non-jump calls remain subject to hard interruption.
      return "other";
    }
  }
  if (unresolvedName && !finalized) return "unknown";
  return jumpCandidate && !unresolvedName ? "jump" : "other";
}
const manager = (ctx: ExtensionContext) => ctx.sessionManager as unknown as SessionManager;
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
// A jump payload is the only state that survives the branch prune. Weak models
// sometimes submit a placeholder (e.g. "-- payload omited --") instead of real
// state; accepting it destroys the conversation irrecoverably, so reject it.
const MIN_PAYLOAD_CHARS = 40;
const PAYLOAD_PLACEHOLDER_PATTERN = /\b(omitted|omited|elided|redacted|placeholder)\b|\(payload\)/i;
function jumpPayloadError(payload: string): string | undefined {
  const trimmed = payload.trim();
  if (!trimmed) return "The payload is empty. Write a payload that preserves relevant knowledge since the checkpoint and includes planned next steps, then call the jump tool again.";
  if (PAYLOAD_PLACEHOLDER_PATTERN.test(trimmed)) return `The payload looks like a placeholder (${JSON.stringify(trimmed)}). It must contain the actual accumulated state and next steps. Rewrite it and call the jump tool again; no jump was performed.`;
  if (trimmed.length < MIN_PAYLOAD_CHARS) return `The payload is too short (${trimmed.length} characters). It must preserve relevant knowledge since the checkpoint and include planned next steps. Expand it and call the jump tool again; no jump was performed.`;
  return undefined;
}
const payloadResult = (text: string, payload: string) => ({ content: [{ type: "text" as const, text }], details: { payload } });

function estimateTextTokens(text: string): number {
  return textLines(text).reduce((total, line) => total + estimateLineTokens(line), 0);
}

function estimateContentTokens(content: readonly any[]): number {
  return content.reduce((total, part) =>
    total + (part?.type === "text" && typeof part.text === "string" ? estimateTextTokens(part.text) : 0), 0);
}

function contentText(content: readonly any[]): string {
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

function formatClippedReadNotice(read: ClippedRead): string {
  return `[Your workspace is full and read limit was reduced to fit; jump to previous checkpoint immediatelly. Use offset=${read.offset + read.actualLines} to continue reading after jump.]`;
}

function appendNoticeToContent(content: readonly any[], notice: string): any[] {
  const result = content.map((part) => ({ ...part }));
  for (let index = result.length - 1; index >= 0; index--) {
    if (result[index].type === "text" && typeof result[index].text === "string") {
      // Replace Pi's generic continuation footer: it doesn't mention that the
      // requested limit was clipped and competes with the jump instruction.
      const text = result[index].text
        .replace(/\s*\[\d+ more lines in file\. Use offset=\d+ to continue\.\]\s*$/, "")
        .trimEnd();
      result[index].text = `${text}${text ? "\n\n" : ""}${notice}`;
      return result;
    }
  }
  result.push({ type: "text", text: notice });
  return result;
}

function textLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function countLinesWithinTokenBudget(text: string, offset: number, tokenBudget: number): number {
  if (tokenBudget <= 0) return 0;
  const lines = textLines(text);
  let usedTokens = 0;
  let count = 0;
  for (const line of lines.slice(Math.max(0, offset - 1))) {
    const lineTokens = estimateLineTokens(line);
    if (usedTokens + lineTokens > tokenBudget) break;
    usedTokens += lineTokens;
    count++;
  }
  return count;
}

function paginateContentByLines(content: readonly any[], offset: number, limit: number): string {
  const text = contentText(content);
  const lines = textLines(text);
  const start = Math.max(0, offset - 1);
  const end = Math.min(lines.length, start + limit);
  const selected = lines.slice(start, end);
  const page = selected.join("\n");
  return end < lines.length && selected.length ? `${page}\n` : page;
}

function countOutputLinesWithinBudget(output: BufferedToolOutput, offset: number, tokenBudget: number): number {
  return countLinesWithinTokenBudget(contentText(output.content), offset, tokenBudget);
}

function formatOutputPage(pageText: string, id: number, offset: number, pageLines: number, totalLines: number): string {
  const nextOffset = offset + pageLines;
  const continuation = nextOffset > totalLines
    ? "[This was the last page.]"
    : `[To continue, call 'output_receive_paginate' with id ${id}, offset ${nextOffset} and a suitable limit.]`;
  return pageText
    ? `${pageText}${pageText.endsWith("\n") ? "\n" : "\n\n"}${continuation}`
    : continuation;
}

function outputPageWithinBudget(
  output: BufferedToolOutput,
  id: number,
  offset: number,
  tokenBudget: number,
): { text: string; lineCount: number } | null {
  const remainingLines = Math.max(0, output.lineCount - offset + 1);
  const maxLines = Math.min(remainingLines, countOutputLinesWithinBudget(output, offset, tokenBudget));
  for (let lineCount = maxLines; lineCount > 0; lineCount--) {
    const pageText = paginateContentByLines(output.content, offset, lineCount);
    const text = formatOutputPage(pageText, id, offset, lineCount, output.lineCount);
    if (estimateTextTokens(text) <= tokenBudget) return { text, lineCount };
  }
  return null;
}

function renderJumpCall(toolName: string, args: any, theme: any, context: any): Text {
  const target = Number.isFinite(args?.target) ? `#${args.target}` : "#?";
  const payload = typeof args?.payload === "string" ? args.payload : "";
  const title = theme.fg("toolTitle", theme.bold(`${toolName} `));
  if (context?.expanded) {
    return new Text(`${title}${theme.fg("accent", target)}\n${theme.fg("muted", "payload:")}\n${payload}`, 0, 0);
  }
  const text = `${title}${theme.fg("accent", target)}${theme.fg("muted", ` (payload carried forward; ${payload.length} chars)`)}`;
  return new Text(text, 0, 0);
}

function renderJumpResult(result: any, _options: { expanded: boolean }, _theme: any): Text {
  // The branch summary carries the payload after the jump; keep the result
  // compact so expanding it does not print the same payload a second time.
  const text = result.content?.find((part: any) => part.type === "text")?.text ?? "";
  return new Text(text, 0, 0);
}

function usagePercent(ctx: ExtensionContext): number | null {
  const usage = ctx.getContextUsage();
  if (!usage) return null;
  if (typeof usage.percent === "number") return usage.percent;
  return usage.contextWindow > 0 && usage.tokens != null ? usage.tokens / usage.contextWindow * 100 : null;
}

// Mirror pi-ai's lightweight estimates locally instead of importing its utils
// subpath, which is not resolvable in some supported Pi installations.
function estimatePiTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimatePiMessageTokens(message: Message): number {
  let chars = 0;
  if (message.role === "user") {
    if (typeof message.content === "string") return estimatePiTextTokens(message.content);
    for (const block of message.content) chars += block.type === "text" ? block.text.length : 4800;
    return Math.ceil(chars / 4);
  }
  if (message.role === "toolResult") {
    for (const block of message.content) chars += block.type === "text" ? block.text.length : 4800;
    return Math.ceil(chars / 4);
  }
  for (const block of message.content) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "thinking") chars += block.thinking.length;
    else chars += block.name.length + JSON.stringify(block.arguments).length;
  }
  return Math.ceil(chars / 4);
}

function unaffectablePrefixTokens(ctx: ExtensionContext): number {
  const branch = manager(ctx).getBranch();
  const firstUserIndex = branch.findIndex((entry) =>
    entry.type === "message" && entry.message.role === "user");
  if (firstUserIndex < 0) return 0;

  const firstUser = branch[firstUserIndex];
  if (firstUser.type !== "message" || firstUser.message.role !== "user") return 0;
  const firstAssistantIndex = branch.findIndex((entry, index) => index > firstUserIndex
    && entry.type === "message" && entry.message.role === "assistant");
  if (firstAssistantIndex >= 0) {
    const firstAssistant = branch[firstAssistantIndex];
    if (firstAssistant.type === "message" && firstAssistant.message.role === "assistant") {
      const usage = firstAssistant.message.usage;
      const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
      if (Number.isFinite(promptTokens) && promptTokens > 0) {
        // If multiple user messages were queued before the first response,
        // exclude those after the first one from the fixed prefix estimate.
        const laterUserTokens = branch.slice(firstUserIndex + 1, firstAssistantIndex)
          .filter((entry) => entry.type === "message" && entry.message.role === "user")
          .reduce((total, entry) => entry.type === "message"
            ? total + estimatePiMessageTokens(entry.message as Message)
            : total, 0);
        return Math.max(0, promptTokens - laterUserTokens);
      }
    }
  }

  // Fallback for providers that do not report input-token usage.
  return estimatePiTextTokens(ctx.getSystemPrompt()) + estimatePiMessageTokens(firstUser.message as Message);
}

function workspaceUsedPercent(ctx: ExtensionContext): number | null {
  const usage = ctx.getContextUsage();
  if (!usage || usage.contextWindow <= 0) return null;
  const tokens = usage.tokens ?? (usage.percent == null ? null : usage.percent / 100 * usage.contextWindow);
  const capacityPercent = config.hardThresholdPercent - config.workspaceReasoningBufferPercent;
  if (tokens == null || !Number.isFinite(tokens) || capacityPercent <= 0) return null;
  const capacityTokens = usage.contextWindow * capacityPercent / 100;
  // This percentage is only shown to the agent. Remove the fixed prompt prefix
  // through its first user message from both usage and capacity, so the initial
  // feed history is 0% and later percentages measure only agent-affectable use.
  // Operational workspace calculations (retrieval limits and hard-pressure
  // checks) continue to use full usage.
  const prefixTokens = unaffectablePrefixTokens(ctx);
  const reportableTokens = Math.max(0, tokens - prefixTokens);
  const reportableCapacityTokens = capacityTokens - prefixTokens;
  if (reportableCapacityTokens <= 0) return reportableTokens === 0 ? 0 : 100;
  return Math.min(100, Math.max(0, reportableTokens / reportableCapacityTokens * 100));
}

function retrievalWorkspaceTokens(ctx: ExtensionContext): number | null {
  const usage = ctx.getContextUsage();
  if (!usage || usage.contextWindow <= 0) return null;
  const tokens = usage.tokens ?? (usage.percent == null ? null : usage.percent / 100 * usage.contextWindow);
  if (tokens == null || !Number.isFinite(tokens)) return null;
  return Math.floor(usage.contextWindow * config.hardThresholdPercent / 100 - tokens - usage.contextWindow * config.workspaceReasoningBufferPercent / 100);
}

const CHECKPOINT_ENTRY_TYPE = "pi-voluntary-compaction-checkpoint";
const CHECKPOINT_VISIBILITY_ENTRY_TYPE = "pi-voluntary-compaction-checkpoint-visibility";

const WORKSPACE_PERCENT_VERSION = 3;
type CheckpointLabel = { id: number; name: string; workspaceUsedPercent?: number };
type CheckpointRecord = CheckpointLabel & { targetId: string; workspacePercentVersion?: number };
type StoredCheckpoint = { checkpoint: CheckpointLabel; targetId: string };

function legacyContextPercentToWorkspaceUsedPercent(contextUsedPercent: number): number {
  const workspaceCapacityPercent = config.hardThresholdPercent - config.workspaceReasoningBufferPercent;
  if (workspaceCapacityPercent <= 0) return 100;
  return Math.min(100, Math.max(0, contextUsedPercent / workspaceCapacityPercent * 100));
}

function checkpointRecord(value: unknown): CheckpointRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<CheckpointRecord>;
  if (typeof record.id !== "number" || !Number.isInteger(record.id) || record.id < 0
    || typeof record.name !== "string" || !record.name.trim()
    || typeof record.targetId !== "string" || !record.targetId) return undefined;
  const id = record.id;
  const name = record.name;
  const targetId = record.targetId;
  const storedPercent = typeof record.workspaceUsedPercent === "number"
    && Number.isFinite(record.workspaceUsedPercent)
    && record.workspaceUsedPercent >= 0
    && record.workspaceUsedPercent <= 100
    ? record.workspaceUsedPercent
    : undefined;
  const workspaceUsedPercent = storedPercent === undefined
    ? undefined
    : record.workspacePercentVersion === WORKSPACE_PERCENT_VERSION || record.workspacePercentVersion === 2
      ? storedPercent
      : legacyContextPercentToWorkspaceUsedPercent(storedPercent);
  return {
    id,
    name,
    targetId,
    ...(workspaceUsedPercent === undefined ? {} : { workspaceUsedPercent }),
    workspacePercentVersion: WORKSPACE_PERCENT_VERSION,
  };
}

function formatCheckpointLabel(checkpoint: CheckpointLabel): string {
  const percentage = checkpoint.workspaceUsedPercent;
  if (percentage === undefined) return `[${checkpoint.id}]: ${checkpoint.name}`;
  const formatted = Number.isInteger(percentage) ? String(percentage) : percentage.toFixed(1);
  return `[${checkpoint.id}]: ${checkpoint.name} (${formatted}% workspace used)`;
}

function persistedCheckpointEntries(sm: SessionManager): StoredCheckpoint[] {
  return sm.getEntries()
    .filter((entry): entry is SessionEntry & { type: "custom"; customType: string; data?: unknown } =>
      entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY_TYPE)
    .map((entry) => {
      const record = checkpointRecord(entry.data);
      return record ? {
        checkpoint: {
          id: record.id,
          name: record.name,
          ...(record.workspaceUsedPercent === undefined ? {} : { workspaceUsedPercent: record.workspaceUsedPercent }),
        },
        targetId: record.targetId,
      } : undefined;
    })
    .filter((entry): entry is StoredCheckpoint => entry !== undefined);
}

function checkpointVisibilityIds(value: unknown): number[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const ids = (value as { checkpointIds?: unknown }).checkpointIds;
  if (!Array.isArray(ids)) return undefined;
  return [...new Set(ids.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id >= 0))];
}

function checkpointEntries(sm: SessionManager): StoredCheckpoint[] {
  const persisted = persistedCheckpointEntries(sm);
  const byId = new Map(persisted.map((entry) => [entry.checkpoint.id, entry]));
  const visibleIds = new Set<number>();
  for (const entry of sm.getBranch()) {
    if (entry.type !== "custom") continue;
    if (entry.customType === CHECKPOINT_ENTRY_TYPE) {
      const checkpoint = checkpointRecord(entry.data);
      if (checkpoint) visibleIds.add(checkpoint.id);
    } else if (entry.customType === CHECKPOINT_VISIBILITY_ENTRY_TYPE) {
      const snapshot = checkpointVisibilityIds(entry.data);
      if (snapshot) {
        visibleIds.clear();
        for (const id of snapshot) {
          if (byId.has(id)) visibleIds.add(id);
        }
      }
    }
  }
  return [...visibleIds]
    .map((id) => byId.get(id))
    .filter((entry): entry is StoredCheckpoint => entry !== undefined)
    .sort((left, right) => left.checkpoint.id - right.checkpoint.id);
}

function checkpointJumpNotice(sm: SessionManager, id: number): string {
  const checkpoint = checkpointEntries(sm).find((entry) => entry.checkpoint.id === id)?.checkpoint;
  const notice = id === 0
    ? "Jumped to checkpoint, continue from the payload"
    : `Jumped to checkpoint [${id}], continue from the payload`;
  const percentage = checkpoint?.workspaceUsedPercent;
  if (percentage === undefined) return `[${notice}.]`;
  const formatted = Number.isInteger(percentage) ? String(percentage) : percentage.toFixed(1);
  const generosity = percentage <= 45 ? "generous " : "";
  return `[${notice}; workspace was cleared to ${generosity}${formatted}% utilization.]`;
}

function nextCheckpointId(sm: SessionManager): number {
  return persistedCheckpointEntries(sm).reduce((max, item) => Math.max(max, item.checkpoint.id), 0) + 1;
}

function persistCheckpoint(pi: ExtensionAPI, ctx: ExtensionContext, name: string, id?: number): CheckpointRecord | undefined {
  const sm = manager(ctx);
  const targetId = latestMeaningfulNode(sm);
  if (!targetId) return undefined;
  const workspaceUsedPercentAtCreation = workspaceUsedPercent(ctx);
  const record: CheckpointRecord = {
    id: id ?? nextCheckpointId(sm),
    name,
    targetId,
    workspacePercentVersion: WORKSPACE_PERCENT_VERSION,
    ...(workspaceUsedPercentAtCreation === null ? {} : { workspaceUsedPercent: workspaceUsedPercentAtCreation }),
  };
  pi.appendEntry(CHECKPOINT_ENTRY_TYPE, record);
  return record;
}

function listedCheckpointEntries(sm: SessionManager): StoredCheckpoint[] {
  return checkpointEntries(sm).filter(({ checkpoint }) => checkpoint.id !== 0);
}

function resolveCheckpointId(sm: SessionManager, id: number): string | undefined {
  const targetId = checkpointEntries(sm).find((item) => item.checkpoint.id === id)?.targetId;
  if (!targetId) return undefined;
  return sm.getEntry(targetId) ? targetId : undefined;
}

function branchWithCheckpointVisibilitySnapshot(
  pi: ExtensionAPI,
  sm: SessionManager,
  targetId: string,
  checkpointId: number,
  payload: string,
): void {
  const visibleCheckpointIds = checkpointEntries(sm)
    .map(({ checkpoint }) => checkpoint.id)
    .filter((id) => id <= checkpointId);
  sm.branchWithSummary(targetId, `(payload)\n${payload}`, undefined, true);
  pi.appendEntry(CHECKPOINT_VISIBILITY_ENTRY_TYPE, { checkpointIds: visibleCheckpointIds });
}

function latestMeaningfulNode(sm: SessionManager): string {
  for (const entry of [...sm.getBranch()].reverse()) {
    if (entry.type !== "message") continue;
    const message = entry.message as any;
    if (message.role === "toolResult" && INTERNAL_TOOLS.has(message.toolName)) continue;
    if (message.role === "assistant" && message.content?.some((part: any) => part.type === "toolCall" && INTERNAL_TOOLS.has(part.name))) continue;
    return entry.id;
  }
  return sm.getLeafId() ?? "";
}

function conversationAdvanced(branch: readonly SessionEntry[], leaf: string | null): boolean {
  if (!leaf) return true;
  const index = branch.findIndex((entry) => entry.id === leaf);
  return index < 0 || branch.slice(index + 1).some((entry) => !PASSIVE_ENTRIES.has(entry.type));
}

function autoCompactionEnabled(ctx: ExtensionContext): boolean {
  const runtime = ctx as any;
  return runtime.agentSession?.autoCompactionEnabled === true
    || runtime.session?.agentSession?.autoCompactionEnabled === true
    || runtime.session?.autoCompactionEnabled === true
    || runtime.autoCompactionEnabled === true
    || runtime.autoCompact === true
    || runtime.settings?.autoCompactionEnabled === true
    || runtime.settings?.autoCompact === true
    || runtime.config?.autoCompactionEnabled === true
    || runtime.config?.autoCompact === true;
}

function loadAgentInstructions(): string {
  const candidates = [
    new URL("../instructions/context-management.md", import.meta.url),
    new URL("./instructions/context-management.md", import.meta.url),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error("pi-voluntary-compaction: instructions/context-management.md was not found beside the extension");
  }
  return readFileSync(path, "utf8").trim();
}

const CONFIG_KEYS: (keyof Config)[] = [
  "softThresholdPercent", "hardThresholdPercent", "workspaceReasoningBufferPercent", "softMessage",
  "hardReasoningMessage", "hardNonReasoningMessage", "instructions",
  "advertiseVoluntaryCompaction", "afterTaskCompaction",
];
type ConfigOverrides = Partial<Config>;

function validConfig(value: any): value is Config {
  if (!value || typeof value !== "object") return false;
  return Number.isFinite(value.softThresholdPercent)
    && Number.isFinite(value.hardThresholdPercent)
    && Number.isFinite(value.workspaceReasoningBufferPercent)
    && value.workspaceReasoningBufferPercent >= 0
    && value.workspaceReasoningBufferPercent <= 25
    && value.softThresholdPercent >= 0
    && value.softThresholdPercent < value.hardThresholdPercent
    && value.hardThresholdPercent <= 100
    && typeof value.softMessage === "string"
    && typeof value.hardReasoningMessage === "string"
    && typeof value.hardNonReasoningMessage === "string"
    && (value.instructions === null || typeof value.instructions === "string")
    && typeof value.advertiseVoluntaryCompaction === "boolean"
    && (value.afterTaskCompaction === "denied" || value.afterTaskCompaction === "allowed");
}

function validOverrides(value: any): value is ConfigOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => {
    if (!CONFIG_KEYS.includes(key as keyof Config)) return false;
    const item = value[key];
    if (key === "instructions") return item === null || typeof item === "string";
    if (key === "workspaceReasoningBufferPercent") return typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 25;
    if (key === "advertiseVoluntaryCompaction") return typeof item === "boolean";
    if (key === "afterTaskCompaction") return item === "denied" || item === "allowed";
    if (key.endsWith("Message")) return typeof item === "string";
    return typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 100;
  });
}

function normalizeConfigOverrides(value: any): ConfigOverrides | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const normalized = { ...value };
  // Ignore the temporary initial-query option if it was saved by an earlier build.
  delete normalized.autoCheckpointInitialUserQuery;
  return validOverrides(normalized) ? normalized : undefined;
}

function sparseConfig(value: Config): ConfigOverrides {
  const result: ConfigOverrides = {};
  for (const key of CONFIG_KEYS) {
    if (value[key] !== DEFAULT_CONFIG[key]) result[key] = value[key] as never;
  }
  return result;
}

function configText(value = config): string {
  return JSON.stringify(value, null, 2);
}

function readConfigFile(path: string): ConfigOverrides | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"))?.[CONFIG_FILE_KEY];
    const overrides = normalizeConfigOverrides(value);
    if (overrides) return overrides;
  } catch {
    // Ignore missing or malformed settings files.
  }
  return undefined;
}

function saveConfigFile(path: string, overrides: ConfigOverrides): void {
  let settings: Record<string, any> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
  } catch {
    // Create a new settings file when it does not exist or is empty.
  }
  if (Object.keys(overrides).length) settings[CONFIG_FILE_KEY] = overrides;
  else delete settings[CONFIG_FILE_KEY];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function sessionOverrides(ctx: ExtensionContext): ConfigOverrides {
  const entry = [...manager(ctx).getBranch()].reverse().find((item: any) =>
    item.type === "custom" && item.customType === CONFIG_ENTRY_TYPE && normalizeConfigOverrides(item.data));
  return entry ? normalizeConfigOverrides((entry as any).data) ?? {} : {};
}

function loadSavedConfig(ctx: ExtensionContext): void {
  Object.assign(config, DEFAULT_CONFIG);
  const global = readConfigFile(join(homedir(), ".pi", "agent", "settings.json"));
  if (global) Object.assign(config, global);
  if (ctx.isProjectTrusted()) {
    const project = readConfigFile(join(ctx.cwd, ".pi", "settings.json"));
    if (project) Object.assign(config, project);
  }
  Object.assign(config, sessionOverrides(ctx));
}

const SETTING_DESCRIPTIONS: Record<keyof Config, string> = {
  softThresholdPercent: "Soft warning threshold: when reached, the model receives an advisory to finish its current sub-task and preserve useful results in a checkpoint payload.",
  hardThresholdPercent: "Hard warning threshold: when context usage reaches this percentage, the model is urgently instructed to return to a checkpoint; reasoning models also receive a synthetic interruption.",
  workspaceReasoningBufferPercent: "Context reserved for reasoning while deciding whether a read or retrieved output fits in the available workspace. Range: 0-25%.",
  softMessage: "Message sent to the model at the soft threshold. Use it to explain how the model should prepare before context becomes critical.",
  hardReasoningMessage: "Synthetic assistant message appended for reasoning models at the hard threshold to interrupt active reasoning and force checkpoint return.",
  hardNonReasoningMessage: "Urgent message sent to non-reasoning models at the hard threshold. It asks for immediate checkpoint return.",
  instructions: "Instructions appended to the system prompt. The package Markdown is used when this is set to the default (null); custom text replaces it.",
  advertiseVoluntaryCompaction: "Controls whether checkpoint and voluntary-compaction instructions are advertised in the system prompt. Pressure warnings and tools remain active when disabled.",
  afterTaskCompaction: "Default decision shown after the agent requests task compaction. Alt+C toggles it in the TUI; pi-web provides /jump and /nojump commands before the next message applies it.",
};

export default function (pi: ExtensionAPI): void {
  const pendingToolOutputs = new Map<number, BufferedToolOutput>();
  const clippedReads = new Map<string, ClippedRead>();
  let nextToolOutputId = 1;
  let softFired = false;
  let hardFired = false;
  let hardJumpPending = false;
  let hardInterruptionPending = false;
  let hardInterruptionCancelledForJump = false;
  let assistantBumpPending = false;
  let hardThinkingPrevious: ReturnType<ExtensionAPI["getThinkingLevel"]> | null = null;
  const activeToolCalls = new Set<string>();
  let checkpointJumpCallInProgress = false;
  let checkpointJumpNamePending = false;
  let turnInProgress = false;
  let rebuildPending = false;
  let pendingUserQueryCheckpointName: string | null = null;
  let pendingUserQueryCheckpointIsInitial = false;
  let jumpPending = false;
  let postJumpTurnProtected = false;
  let pendingJump: PendingJump | null = null;
  let pendingJumpOffer: PendingJumpOffer | null = null;
  let removeTerminalInput: (() => void) | null = null;
  let interceptorLogPath: string | null = null;
  let interceptorLogSequence = 0;
  let streamUpdateCount = 0;

  const logInterceptor = (hook: string, details: Record<string, unknown> = {}): void => {
    if (!interceptorLogPath) return;
    try {
      appendFileSync(interceptorLogPath, `${JSON.stringify({
        seq: ++interceptorLogSequence,
        timestamp: new Date().toISOString(),
        hook,
        ...details,
      })}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Diagnostics must never interfere with tool execution or streaming.
    }
  };

  const summarizeMessageShape = (message: any): Record<string, unknown> => {
    const parts = Array.isArray(message?.content) ? message.content : [];
    return {
      role: typeof message?.role === "string" ? message.role : null,
      contentPartCount: parts.length,
      contentParts: parts.slice(0, 32).map((part: any) => part?.type === "toolCall"
        ? { type: "toolCall", name: typeof part.name === "string" ? part.name : null }
        : part?.type === "text"
          ? { type: "text", chars: typeof part.text === "string" ? part.text.length : null }
          : { type: typeof part?.type === "string" ? part.type : "unknown" }),
      omittedPartCount: Math.max(0, parts.length - 32),
    };
  };

  const pressureState = () => ({
    checkpointJumpCallInProgress,
    checkpointJumpNamePending,
    hardInterruptionPending,
    hardJumpPending,
    hardInterruptionCancelledForJump,
    jumpPending,
  });

  const renderCompactionOffer = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || !pendingJumpOffer) return;
    const decision = pendingJumpOffer.allowed ? "allowed" : "denied";
    if (process.env.PI_WEB_SESSION === "1") return;
    ctx.ui.setWidget("voluntary-compaction-offer", [
      `Checkpoint jump after your input is [${decision}].  (alt+c to toggle)`,
    ], { placement: "aboveEditor" });
  };

  const clearCompactionOfferUI = (ctx: ExtensionContext): void => {
    if (ctx.hasUI) {
      ctx.ui.setWidget("voluntary-compaction-offer", undefined);
      ctx.ui.setStatus("voluntary-compaction-offer", undefined);
    }
  };

  const clearJumpOffer = (ctx: ExtensionContext): void => {
    pendingJumpOffer = null;
    clearCompactionOfferUI(ctx);
  };

  const announceWebCompactionOffer = (offer: PendingJumpOffer): void => {
    pi.sendMessage({
      customType: EXTENSION_TYPE,
      content: offer.allowed
        ? `Jump to checkpoint [${offer.checkpointId}] will be allowed after next user input. Use /nojump to deny.`
        : `Jump to checkpoint [${offer.checkpointId}] will be denied after next user input. Use /jump to allow.`,
      display: true,
    }, { triggerTurn: false });
  };

  const markCompactionComplete = (): void => {
    rebuildPending = true;
    // Context usage can be reported from the pre-branch state for one turn.
    // Keep pressure handling quiet until the rebuilt context is observed; otherwise
    // the hard warning can immediately interrupt the continuation we are starting.
    softFired = true;
    hardFired = true;
    hardInterruptionPending = false;
    hardJumpPending = false;
    hardInterruptionCancelledForJump = false;
    postJumpTurnProtected = true;
    assistantBumpPending = false;
    restoreHardThinking();
  };

  const applyOfferedJump = (ctx: ExtensionContext): boolean => {
    const request = pendingJumpOffer;
    if (!request) return false;
    clearJumpOffer(ctx);
    try {
      branchWithCheckpointVisibilitySnapshot(pi, manager(ctx), request.target, request.checkpointId, request.payload);
      markCompactionComplete();
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`checkpoint_jump failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
    return true;
  };

  if (process.env.PI_WEB_SESSION === "1") {
    pi.registerCommand("jump", {
      description: "Allow the pending checkpoint jump on the next user input",
      handler: async (_args, _ctx) => {
        if (pendingJumpOffer) pendingJumpOffer.allowed = true;
      },
    });
    pi.registerCommand("nojump", {
      description: "Deny the pending checkpoint jump on the next user input",
      handler: async (_args, _ctx) => {
        if (pendingJumpOffer) pendingJumpOffer.allowed = false;
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    removeTerminalInput?.();
    removeTerminalInput = ctx.hasUI ? ctx.ui.onTerminalInput((data) => {
      if (!pendingJumpOffer || !matchesKey(data, "alt+c")) return;
      pendingJumpOffer.allowed = !pendingJumpOffer.allowed;
      renderCompactionOffer(ctx);
      return { consume: true };
    }) : null;
  });

  pi.on("input", (event, ctx) => {
    pendingUserQueryCheckpointName = null;
    pendingUserQueryCheckpointIsInitial = false;
    if ((event.source !== "interactive" && event.source !== "rpc") || !event.text.trim()) return;
    // The user's next message applies the selected decision. With the default
    // denied state this simply dismisses the offer; allowed branches first.
    if (pendingJumpOffer) {
      if (pendingJumpOffer.allowed) applyOfferedJump(ctx);
      else clearJumpOffer(ctx);
    }
    // Slash commands may be handled without a provider request, so they must not
    // leave a pending query checkpoint to be incorrectly applied to later input.
    if (event.text.trimStart().startsWith("/")) return;

    const querySlice = event.text.slice(0, 256);
    const normalizedQuery = querySlice.replace(/`/g, '"').replace(/[\r\n]/g, "").replace(/[ \t]+/g, " ").trim();
    const queryCharacters = Array.from(normalizedQuery);
    const queryExcerpt = queryCharacters.length > 64 || event.text.length > querySlice.length
      ? `${queryCharacters.slice(0, 64).join("")}…`
      : normalizedQuery;
    // The input hook runs before Pi appends this query to session history. Defer
    // checkpoint creation until before_provider_request, when latestMeaningfulNode
    // can target the persisted user-message entry instead of the prior turn.
    pendingUserQueryCheckpointIsInitial = !manager(ctx).getEntries().some((entry) =>
      entry.type === "message" && entry.message.role === "user");
    pendingUserQueryCheckpointName = pendingUserQueryCheckpointIsInitial
      ? "Initial user query"
      : `User query: \`${queryExcerpt}\``;
  });

  if (!validConfig(config)) {
    throw new Error("pi-voluntary-compaction: soft threshold must be below hard threshold (0-100); workspace reasoning buffer must be 0-25");
  }

  const defaultInstructions = loadAgentInstructions();
  pi.on("before_agent_start", (event) => {
    if (!config.advertiseVoluntaryCompaction) return;
    const instructions = config.instructions ?? defaultInstructions;
    if (!instructions) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Voluntary context management\n\n${instructions}`,
    };
  });

  pi.registerCommand("voluntary-compaction", {
    description: "View or edit voluntary compaction settings",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(configText(), "info");
        return;
      }

      const edited: Config = { ...config };
      const editedKeys = new Set<keyof Config>();
      const fields: Array<[keyof Config, string]> = [
        ["softThresholdPercent", "Soft threshold"],
        ["hardThresholdPercent", "Hard threshold"],
        ["workspaceReasoningBufferPercent", "Workspace reasoning buffer"],
        ["softMessage", "Soft warning message"],
        ["hardReasoningMessage", "Hard reasoning-model message"],
        ["hardNonReasoningMessage", "Hard non-reasoning-model message"],
        ["instructions", `Agent instructions (${edited.instructions === null ? "package default" : "custom"})`],
        ["advertiseVoluntaryCompaction", "Advertise voluntary compaction"],
        ["afterTaskCompaction", "After task compaction default"],
      ];

      while (true) {
        const choices = [...fields.map(([, label]) => label), "Done"];
        const selected = await ctx.ui.select("Choose a voluntary-compaction setting to edit", choices);
        if (!selected || selected === "Done") break;
        const key = fields.find(([, label]) => label === selected)?.[0];
        if (!key) continue;
        const description = SETTING_DESCRIPTIONS[key];

        if (key === "instructions") {
          const mode = await ctx.ui.select(`Agent instructions\n\n${description}`, ["Use package default", "Edit custom instructions", "Cancel"]);
          if (mode === "Use package default") {
            edited.instructions = null;
            editedKeys.add(key);
          } else if (mode === "Edit custom instructions") {
            const value = await ctx.ui.editor(`Edit agent instructions\n\n${description}`, edited.instructions ?? defaultInstructions);
            if (value != null) {
              edited.instructions = value;
              editedKeys.add(key);
            }
          }
          continue;
        }

        if (key === "advertiseVoluntaryCompaction") {
          const value = await ctx.ui.select(`Advertise voluntary compaction\n\n${description}`, ["Enabled", "Disabled", "Cancel"]);
          if (value === "Enabled") {
            edited.advertiseVoluntaryCompaction = true;
            editedKeys.add(key);
          } else if (value === "Disabled") {
            edited.advertiseVoluntaryCompaction = false;
            editedKeys.add(key);
          }
          continue;
        }

        if (key === "afterTaskCompaction") {
          const value = await ctx.ui.select(`After task compaction default\n\n${description}`, ["Denied", "Allowed", "Cancel"]);
          if (value === "Denied") {
            edited.afterTaskCompaction = "denied";
            editedKeys.add(key);
          } else if (value === "Allowed") {
            edited.afterTaskCompaction = "allowed";
            editedKeys.add(key);
          }
          continue;
        }

        if (key === "softThresholdPercent" || key === "hardThresholdPercent" || key === "workspaceReasoningBufferPercent") {
          const value = await ctx.ui.editor(`Edit ${selected}\n\n${description}`, String(edited[key]));
          if (value == null) continue;
          const number = Number(value);
          const maximum = key === "workspaceReasoningBufferPercent" ? 25 : 100;
          if (!Number.isFinite(number) || number < 0 || number > maximum) {
            ctx.ui.notify(key === "workspaceReasoningBufferPercent"
              ? "Workspace reasoning buffer must be between 0 and 25% in context."
              : "Thresholds must be numbers between 0 and 100.", "error");
          } else {
            edited[key] = number;
            editedKeys.add(key);
          }
        } else {
          const value = await ctx.ui.editor(`Edit ${selected}\n\n${description}`, edited[key]);
          if (value != null) {
            edited[key] = value;
            editedKeys.add(key);
          }
        }

        if (!(edited.softThresholdPercent < edited.hardThresholdPercent)) {
          ctx.ui.notify("The soft threshold must remain below the hard threshold.", "error");
        }
      }

      if (!validConfig(edited)) {
        ctx.ui.notify("Settings were not saved: check that the soft threshold is below the hard threshold and the workspace reasoning buffer is between 0 and 25%.", "error");
        return;
      }
      const scope = await ctx.ui.select("Apply voluntary compaction settings to", [
        "Session only", "Project settings", "Global settings", "Cancel",
      ]);
      if (!scope || scope === "Cancel") return;

      const overrides: ConfigOverrides = scope === "Session only"
        ? sessionOverrides(ctx)
        : scope === "Project settings"
          ? (readConfigFile(join(ctx.cwd, ".pi", "settings.json")) ?? {})
          : (readConfigFile(join(homedir(), ".pi", "agent", "settings.json")) ?? {});
      for (const key of editedKeys) {
        if (edited[key] === DEFAULT_CONFIG[key]) delete overrides[key];
        else overrides[key] = edited[key] as never;
      }
      try {
        if (scope === "Session only") {
          pi.appendEntry(CONFIG_ENTRY_TYPE, overrides);
        } else if (scope === "Project settings") {
          if (!ctx.isProjectTrusted()) {
            ctx.ui.notify("Project settings require a trusted project.", "error");
            return;
          }
          saveConfigFile(join(ctx.cwd, ".pi", "settings.json"), overrides);
        } else {
          saveConfigFile(join(homedir(), ".pi", "agent", "settings.json"), overrides);
        }
        loadSavedConfig(ctx);
        ctx.ui.notify(`${scope} updated. ${Object.keys(overrides).length} override(s) saved.`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not save settings: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  const restoreHardThinking = () => {
    const previous = hardThinkingPrevious;
    hardThinkingPrevious = null;
    if (previous === null) return;
    try {
      pi.setThinkingLevel(previous);
    } catch {
      // The runtime may be shutting down or switching sessions.
    }
  };

  const checkpointListForInterruption = (ctx: ExtensionContext): string => {
    const checkpoints = listedCheckpointEntries(manager(ctx))
      .sort((left, right) => left.checkpoint.id - right.checkpoint.id);
    if (!checkpoints.length) return "(no checkpoints)";
    return checkpoints.map(({ checkpoint }) => formatCheckpointLabel(checkpoint)).join("\n");
  };

  const cancelHardInterruptionForJump = (): void => {
    const hadPendingHardInterruption = hardInterruptionPending || hardJumpPending;
    assistantBumpPending = false;
    logInterceptor("hard_interruption_cancel_check", { hadPendingHardInterruption, ...pressureState() });
    if (!hadPendingHardInterruption) return;
    hardInterruptionPending = false;
    hardJumpPending = false;
    hardFired = true;
    hardInterruptionCancelledForJump = true;
    // The checkpoint jump replaces the hard-limit continuation. Keep hardFired
    // latched, but restore the user's thinking level while the jump proceeds.
    restoreHardThinking();
  };

  const dispatchHardInterruption = (ctx: ExtensionContext): void => {
    if (!hardInterruptionPending) return;
    if (jumpPending || checkpointJumpCallInProgress) {
      logInterceptor("hard_interruption_suppressed_for_jump", pressureState());
      cancelHardInterruptionForJump();
      return;
    }
    // A partial tool name is not enough to decide whether this is a jump.
    if (checkpointJumpNamePending) {
      logInterceptor("hard_interruption_deferred_for_partial_name", pressureState());
      return;
    }
    logInterceptor("hard_interruption_dispatch_attempt", pressureState());
    const message = `${ctx.model?.reasoning === true ? config.hardReasoningMessage : config.hardNonReasoningMessage}

Available checkpoints (use one of these IDs; do not call checkpoint_list):
${checkpointListForInterruption(ctx)}`;
    try {
      // Re-apply this immediately before dispatching. The runtime can prepare
      // the next turn after turn_end and overwrite the level set earlier.
      // hardThinkingPrevious is retained so checkpoint completion restores the
      // user's original level.
      pi.setThinkingLevel("off");
      // Preserve immediate interruption in every case except a checkpoint
      // jump already visible in the streamed assistant response.
      pi.sendUserMessage(message, { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
      hardInterruptionPending = false;
      logInterceptor("hard_interruption_dispatched", pressureState());
      if (ctx.hasUI) ctx.ui.notify(`pi-voluntary-compaction: hard warning (${config.hardThresholdPercent}%)`, "error");
    } catch (error) {
      logInterceptor("hard_interruption_dispatch_failed", { error: String(error), ...pressureState() });
      // A rejected message must not leave thinking disabled forever. The
      // threshold is re-armed so the next lifecycle event can retry it.
      hardFired = false;
      hardJumpPending = false;
      hardInterruptionPending = false;
      assistantBumpPending = false;
      restoreHardThinking();
    }
  };

  const triggerHardInterruption = (ctx: ExtensionContext) => {
    if (hardFired) return;
    try {
      if (hardThinkingPrevious === null) {
        hardThinkingPrevious = pi.getThinkingLevel();
        pi.setThinkingLevel("off");
      }
      hardJumpPending = true;
      hardInterruptionPending = true;
      hardFired = true;
      logInterceptor("hard_interruption_triggered", { turnInProgress, ...pressureState() });
      // During a turn, wait for the assistant response to resolve whether it
      // is a checkpoint jump. This prevents a warning at turn_start or in the
      // text prefix from interrupting before toolcall_start identifies a jump.
      // Outside a turn (e.g. session_start), dispatch immediately unless a jump
      // has already been identified.
      if (!turnInProgress && !checkpointJumpCallInProgress && !checkpointJumpNamePending) {
        dispatchHardInterruption(ctx);
      }
    } catch {
      hardFired = false;
      hardJumpPending = false;
      hardInterruptionPending = false;
      restoreHardThinking();
    }
  };

  const evaluatePressure = (ctx: ExtensionContext) => {
    // Do not inject a pressure warning while a terminating checkpoint_jump
    // is waiting for agent_end to apply its payload, or during the first turn
    // after the jump while context usage may still reflect the pre-rebuild state.
    if (jumpPending || postJumpTurnProtected) return;
    const percent = usagePercent(ctx);
    if (percent == null) return;
    // Each warning re-arms independently when usage falls below its threshold.
    // This matters after voluntary compaction: usage may fall below hard while
    // remaining above soft, and the next hard breach must still warn again.
    if (percent < config.softThresholdPercent) softFired = false;
    if (percent < config.hardThresholdPercent) {
      if (!hardJumpPending && !hardInterruptionCancelledForJump && !checkpointJumpCallInProgress) hardFired = false;
      assistantBumpPending = false;
    }
    if (percent < config.softThresholdPercent) return;
    if (percent >= config.hardThresholdPercent) {
      triggerHardInterruption(ctx);
      return;
    }
    if (!softFired) {
      // Set before sending in case triggering a turn synchronously re-enters
      // the pressure evaluator; reset if the runtime rejects the message.
      softFired = true;
      try {
        // Use a real user message so the warning is unambiguously part of the
        // model conversation. A non-triggering custom message can be displayed
        // in the TUI yet remain queued instead of steering the next request.
        pi.sendUserMessage(config.softMessage, { deliverAs: "steer" });
        if (ctx.hasUI) ctx.ui.notify(`pi-voluntary-compaction: soft warning (${config.softThresholdPercent}%)`, "warning");
      } catch {
        // Do not permanently suppress the warning if the runtime rejects it.
        softFired = false;
      }
    }
  };

  pi.on("session_start", (_event, ctx) => {
    loadSavedConfig(ctx);
    pendingToolOutputs.clear();
    clippedReads.clear();
    nextToolOutputId = 1;
    softFired = false;
    hardFired = false;
    hardJumpPending = false;
    hardInterruptionPending = false;
    hardInterruptionCancelledForJump = false;
    assistantBumpPending = false;
    activeToolCalls.clear();
    checkpointJumpCallInProgress = false;
    checkpointJumpNamePending = false;
    turnInProgress = false;
    restoreHardThinking();
    rebuildPending = false;
    pendingUserQueryCheckpointName = null;
    pendingUserQueryCheckpointIsInitial = false;
    jumpPending = false;
    postJumpTurnProtected = false;
    pendingJump = null;
    clearJumpOffer(ctx);
    interceptorLogPath = null;
    interceptorLogSequence = 0;
    streamUpdateCount = 0;
    if (ENABLE_INTERCEPTOR_LOGGING) {
      try {
        const logDirectory = join(ctx.cwd, ".pi", "agent", "sessions", "intercept");
        mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        interceptorLogPath = join(logDirectory, `intercept-${timestamp}-${randomUUID()}.jsonl`);
        logInterceptor("session_start", { cwd: ctx.cwd, logFile: interceptorLogPath });
      } catch {
        interceptorLogPath = null;
      }
    }
    if (autoCompactionEnabled(ctx) && ctx.hasUI) {
      ctx.ui.notify("pi-voluntary-compaction replaces built-in auto-compact; disable auto-compact to avoid competing compaction flows.", "warning");
    }
    evaluatePressure(ctx);
  });
  pi.on("tool_result", async (event, ctx) => {
    // File-mutation results are concise status traces (for example, "Successfully
    // wrote to ..."). Preserve them even at zero workspace so the agent can
    // distinguish a successful write/edit from an actual tool failure.
    if (event.toolName === "write" || event.toolName === "edit"
      || event.toolName.startsWith("output_receive_")
      || event.toolName.startsWith("checkpoint_")
      || event.toolName.startsWith("subagent_checkpoint_")) return;

    const clippedRead = event.toolName === "read" ? clippedReads.get(event.toolCallId) : undefined;
    if (event.toolName === "read") clippedReads.delete(event.toolCallId);
    if (clippedRead) {
      // The read already executed with a reduced line limit. Reopen that exact
      // range to bypass Pi's independent 50KB truncation, then append only the
      // workspace continuation notice. Do not re-budget against the smaller
      // post-execution workspace or preserve Pi's truncation metadata.
      if (event.isError) return;
      const readInput = event.input as { path?: unknown };
      if (typeof readInput.path !== "string") return;
      try {
        const file: ReadFileRange = {
          path: resolveReadSourcePath(readInput.path, ctx.cwd),
          startLine: Math.max(0, clippedRead.offset - 1),
          lineLimit: clippedRead.actualLines,
        };
        const text = await readReadFileFull(file, ctx.signal);
        return {
          content: appendNoticeToContent([{ type: "text" as const, text }], formatClippedReadNotice(clippedRead)),
          details: {},
        };
      } catch {
        // Preserve Pi's original result and truncation metadata if reopening fails.
        return;
      }
    }
    const readInput = event.input as { path?: unknown; offset?: unknown; limit?: unknown };
    const truncation = (event as any).details?.truncation;
    if (event.toolName === "read"
      && typeof readInput.path === "string"
      && truncation
      && (truncation.truncated === true || truncation.firstLineExceedsLimit === true)) {
      try {
        const file: ReadFileRange = {
          path: resolveReadSourcePath(readInput.path, ctx.cwd),
          startLine: typeof readInput.offset === "number" && Number.isFinite(readInput.offset)
            ? Math.max(0, Math.trunc(readInput.offset - 1))
            : 0,
          ...(typeof readInput.limit === "number" && Number.isFinite(readInput.limit)
            ? { lineLimit: Math.max(0, Math.trunc(readInput.limit)) }
            : {}),
        };
        const { estimatedTokens } = await estimateReadFileStats(file, ctx.signal);
        const workspaceTokens = retrievalWorkspaceTokens(ctx);
        if (workspaceTokens === null) return;
        const exceedsWorkspace = estimatedTokens > workspaceTokens;
        if (!exceedsWorkspace) {
          const text = await readReadFileFull(file, ctx.signal);
          return {
            content: [{ type: "text" as const, text }],
            details: {},
          };
        }
        const recommendedLines = await countReadFileLinesWithinTokenBudget(file, 1, Math.max(0, workspaceTokens), ctx.signal);
        return {
          content: [{
            type: "text" as const,
            text: `Read is too large for available workspace, only ${recommendedLines} lines would fit. To free more workspace and read bigger chunks, jump to an earlier checkpoint before trying again.`,
          }],
          details: {},
        };
      } catch {
        // If the source file cannot be reopened or streamed, leave Pi's original
        // truncated result intact.
        return;
      }
    }

    const resultContent = event.content;
    const estimatedTokens = estimateContentTokens(resultContent);
    const workspaceTokens = retrievalWorkspaceTokens(ctx);
    if (event.toolName === "read" && workspaceTokens === null) return;
    const exceedsWorkspace = workspaceTokens !== null && estimatedTokens > workspaceTokens;
    if (event.toolName === "read") {
      if (!exceedsWorkspace) return;
      const recommendedLines = countLinesWithinTokenBudget(contentText(event.content), 1, Math.max(0, workspaceTokens ?? 0));
      return {
        content: [{
          type: "text" as const,
          text: `Read is too large for available workspace, only ${recommendedLines} lines would fit. To free more workspace and read bigger chunks, jump to an earlier checkpoint before trying again.`,
        }],
        details: {},
      };
    }
    if (workspaceTokens === null || !exceedsWorkspace) return;

    const id = nextToolOutputId++;
    const bufferedContent = event.content.map((part: any) => part.type === "text" ? { ...part } : part);
    const lineCount = textLines(contentText(bufferedContent)).length;
    const output: BufferedToolOutput = {
      kind: "memory",
      content: bufferedContent,
      details: (event as any).details,
      estimatedTokens,
      lineCount,
    };
    const firstPage = outputPageWithinBudget(output, id, 1, Math.max(0, workspaceTokens));
    if (!firstPage) {
      return {
        content: [{
          type: "text" as const,
          text: "Tool output is too large for available workspace, only 0 lines would fit. To free more workspace and read bigger chunks, jump to an earlier checkpoint before trying again.",
        }],
        details: {},
      };
    }

    pendingToolOutputs.set(id, output);
    const content: any[] = [];
    let textInserted = false;
    for (const part of event.content) {
      if (part.type === "image") content.push(part);
      else if (!textInserted) {
        content.push({ type: "text" as const, text: firstPage.text });
        textInserted = true;
      }
    }
    if (!textInserted) content.push({ type: "text" as const, text: firstPage.text });
    return {
      content,
      details: {
        outputId: id,
        offset: 1,
        limit: firstPage.lineCount,
        totalLines: lineCount,
        nextOffset: 1 + firstPage.lineCount,
      },
    };
  });
  pi.on("turn_start", (_event, ctx) => {
    turnInProgress = true;
    const before = pressureState();
    evaluatePressure(ctx);
    logInterceptor("turn_start", { before, after: pressureState() });
  });
  pi.on("message_start", (event, _ctx) => {
    if (event.message.role !== "assistant") return;
    streamUpdateCount = 0;
    checkpointJumpCallInProgress = false;
    checkpointJumpNamePending = false;
    logInterceptor("message_start", { message: summarizeMessageShape(event.message), ...pressureState() });
  });
  pi.on("message_update", (event, ctx) => {
    const update = event.assistantMessageEvent;
    const rawUpdate = update as any;
    const updateIndex = ++streamUpdateCount;
    const before = pressureState();
    const partialPresent = "partial" in update;
    const partial = partialPresent ? rawUpdate.partial : event.message;
    let state = checkpointJumpStreamState(partial);
    let observedToolName: unknown = null;
    let observedToolNameSource: string | null = null;
    let observedToolCall: any = null;
    // Newer JSON/RPC runtimes send message_update deltas rather than a
    // cumulative partial message. Recognize a jump directly from toolcall_start
    // so payload deltas remain protected even when no toolCall part is present.
    if (update.type === "toolcall_start" || update.type === "toolcall_end") {
      observedToolCall = rawUpdate.toolCall
        ?? rawUpdate.partial?.content?.[rawUpdate.contentIndex];
      observedToolName = update.type === "toolcall_start"
        ? rawUpdate.toolName ?? observedToolCall?.name
        : observedToolCall?.name;
      observedToolNameSource = rawUpdate.toolName != null
        ? "toolName"
        : observedToolCall?.name != null ? "toolCall.name" : null;
      const name = observedToolName;
      state = CHECKPOINT_JUMP_TOOL_NAMES.includes(name as (typeof CHECKPOINT_JUMP_TOOL_NAMES)[number])
        ? "jump"
        : typeof name !== "string" || !name
          || (update.type === "toolcall_start"
            && CHECKPOINT_JUMP_TOOL_NAMES.some((jumpName) => jumpName.startsWith(name)))
          ? "unknown"
          : "other";
    }
    // Partial snapshots are not guaranteed to retain toolCall parts on every
    // update. Keep a recognized jump/name guard latched until a later update
    // resolves a different tool or the assistant message is finalized.
    if (state !== "none") {
      checkpointJumpCallInProgress = state === "jump";
      checkpointJumpNamePending = state === "unknown";
      if (state === "jump") cancelHardInterruptionForJump();
    }
    // Re-check usage during streaming, after observing the partial tool name.
    // This lets us steer ordinary reasoning/output immediately while shielding
    // only a checkpoint_jump call whose name is already visible (or unresolved).
    evaluatePressure(ctx);
    const dispatchRequested = hardInterruptionPending && state === "other";
    if (dispatchRequested) dispatchHardInterruption(ctx);
    const after = pressureState();
    const updateType = typeof rawUpdate.type === "string" ? rawUpdate.type : "unknown";
    const isToolCallUpdate = updateType === "toolcall_start" || updateType === "toolcall_end";
    const flagsChanged = JSON.stringify(before) !== JSON.stringify(after);
    if (isToolCallUpdate || updateIndex <= 12 || updateIndex % 32 === 0 || state !== "none" || flagsChanged) {
      logInterceptor("message_update", {
        updateIndex,
        updateType,
        partialPresent,
        partial: summarizeMessageShape(partial),
        eventMessage: summarizeMessageShape(event.message),
        observedToolName,
        observedToolNameSource,
        observedToolCallHasArguments: observedToolCall != null && "arguments" in observedToolCall,
        classifierState: state,
        dispatchRequested,
        before,
        after,
      });
    }
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const before = pressureState();
    const state = checkpointJumpStreamState(event.message, true);
    checkpointJumpCallInProgress = state === "jump";
    checkpointJumpNamePending = false;
    const dispatchRequested = hardInterruptionPending && state !== "jump";
    if (dispatchRequested) dispatchHardInterruption(ctx);
    logInterceptor("message_end", {
      classifierState: state,
      dispatchRequested,
      message: summarizeMessageShape(event.message),
      before,
      after: pressureState(),
    });
  });
  pi.on("tool_call", async (event, ctx) => {
    const before = pressureState();
    if (CHECKPOINT_JUMP_TOOL_NAMES.includes(event.toolName as (typeof CHECKPOINT_JUMP_TOOL_NAMES)[number])) {
      checkpointJumpCallInProgress = true;
      checkpointJumpNamePending = false;
      cancelHardInterruptionForJump();
    } else {
      checkpointJumpCallInProgress = false;
      checkpointJumpNamePending = false;
    }
    evaluatePressure(ctx);
    const dispatchRequested = hardInterruptionPending && !checkpointJumpCallInProgress;
    if (dispatchRequested) dispatchHardInterruption(ctx);
    logInterceptor("tool_call", {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      isCheckpointJump: CHECKPOINT_JUMP_TOOL_NAMES.includes(event.toolName as (typeof CHECKPOINT_JUMP_TOOL_NAMES)[number]),
      dispatchRequested,
      before,
      after: pressureState(),
    });

    if (event.toolName !== "read") return;
    const readInput = event.input as { path?: unknown; offset?: unknown; limit?: unknown };
    if (typeof readInput.path !== "string") return;
    try {
      const file: ReadFileRange = {
        path: resolveReadSourcePath(readInput.path, ctx.cwd),
        startLine: typeof readInput.offset === "number" && Number.isFinite(readInput.offset)
          ? Math.max(0, Math.trunc(readInput.offset - 1))
          : 0,
        ...(typeof readInput.limit === "number" && Number.isFinite(readInput.limit)
          ? { lineLimit: Math.max(0, Math.trunc(readInput.limit)) }
          : {}),
      };
      const workspaceTokens = retrievalWorkspaceTokens(ctx);
      if (workspaceTokens === null) return;
      const { estimatedTokens } = await estimateReadFileStats(file, ctx.signal);
      if (estimatedTokens <= workspaceTokens) return;

      const recommendedLines = await countReadFileLinesWithinTokenBudget(file, 1, Math.max(0, workspaceTokens), ctx.signal);
      const requestedLines = typeof readInput.limit === "number" && Number.isFinite(readInput.limit)
        ? Math.max(0, Math.trunc(readInput.limit))
        : undefined;
      if (recommendedLines > 0 && (requestedLines === undefined || recommendedLines < requestedLines)) {
        // Preserve the original request metadata before mutating the pending
        // call so tool_result can tell the model that this read was clipped.
        clippedReads.set(event.toolCallId, {
          offset: file.startLine + 1,
          ...(requestedLines === undefined ? {} : { requestedLines }),
          actualLines: recommendedLines,
        });
        readInput.limit = recommendedLines;
      }
    } catch {
      // If preflight sizing fails, leave the original read arguments intact.
    }
  });
  pi.on("tool_execution_start", (event, ctx) => {
    const before = pressureState();
    activeToolCalls.add(event.toolCallId);
    if (CHECKPOINT_JUMP_TOOL_NAMES.includes(event.toolName as (typeof CHECKPOINT_JUMP_TOOL_NAMES)[number])) {
      checkpointJumpCallInProgress = true;
      checkpointJumpNamePending = false;
      cancelHardInterruptionForJump();
    }
    evaluatePressure(ctx);
    logInterceptor("tool_execution_start", {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      isCheckpointJump: CHECKPOINT_JUMP_TOOL_NAMES.includes(event.toolName as (typeof CHECKPOINT_JUMP_TOOL_NAMES)[number]),
      before,
      after: pressureState(),
    });
  });
  pi.on("tool_execution_end", (event, ctx) => {
    activeToolCalls.delete(event.toolCallId);
    if (CHECKPOINT_JUMP_TOOL_NAMES.includes(event.toolName as (typeof CHECKPOINT_JUMP_TOOL_NAMES)[number])) {
      logInterceptor("tool_execution_end", {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        isError: event.isError,
        ...pressureState(),
      });
    }
    if (CHECKPOINT_JUMP_TOOL_NAMES.includes(event.toolName as (typeof CHECKPOINT_JUMP_TOOL_NAMES)[number]) && !jumpPending) {
      checkpointJumpCallInProgress = false;
      checkpointJumpNamePending = false;
      if (hardInterruptionCancelledForJump) {
        hardInterruptionCancelledForJump = false;
        hardFired = false;
        evaluatePressure(ctx);
      }
      if (hardInterruptionPending) dispatchHardInterruption(ctx);
    }
  });
  pi.on("agent_end", () => {
    logInterceptor("agent_end", { activeToolCallCount: activeToolCalls.size, ...pressureState() });
    // A cancelled tool may not emit tool_execution_end. The settled event
    // below is the synchronization point for the follow-up, so only release
    // the bookkeeping guard here.
    activeToolCalls.clear();
  });
  pi.on("agent_settled", () => {
    logInterceptor("agent_settled", { activeToolCallCount: activeToolCalls.size, ...pressureState() });
    // Hard pressure is dispatched immediately by evaluatePressure. Keep this
    // lifecycle hook only for defensive tool bookkeeping; it must not delay
    // the interruption until the agent is settled.
    activeToolCalls.clear();
  });
  pi.on("turn_end", (_event, ctx) => {
    const before = pressureState();
    turnInProgress = false;
    if (!hardInterruptionPending) assistantBumpPending = false;
    // Usage can cross a threshold during a long turn; checking only at
    // turn_start would postpone the warning until after another turn.
    evaluatePressure(ctx);
    if (hardInterruptionPending && !checkpointJumpCallInProgress && !checkpointJumpNamePending) {
      dispatchHardInterruption(ctx);
    }
    postJumpTurnProtected = false;
    logInterceptor("turn_end", { before, after: pressureState() });
  });

  // Rebuild only after this extension changes the active branch. This avoids
  // claiming the context hook on ordinary turns and coexists with pi-context.
  pi.on("context", (event, ctx) => {
    let messages = event.messages;
    if (rebuildPending) {
      try {
        messages = manager(ctx).buildSessionContext().messages as any;
        // Keep rebuilding on every provider request. The context hook replaces
        // only the request payload; it does not replace agent.state.messages.
        // Clearing this after one request lets the next follow-up resurrect the
        // pre-branch full history and defeats checkpoint_jump.
      } catch {
        // Keep the runtime-provided context if rebuilding is unavailable.
      }
    }
    if (assistantBumpPending && ctx.model && messages.at(-1)?.role !== "assistant") {
      messages = [...messages, {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: `${config.hardReasoningMessage}\n\nAvailable checkpoints (use one of these IDs; do not call checkpoint_list):\n${checkpointListForInterruption(ctx)}` }],
        api: ctx.model.api, provider: ctx.model.provider, model: ctx.model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const, timestamp: Date.now(),
      }];
      assistantBumpPending = false;
    }
    return messages === event.messages ? undefined : { messages };
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (pendingUserQueryCheckpointName) {
      const isInitial = pendingUserQueryCheckpointIsInitial;
      const name = pendingUserQueryCheckpointName;
      pendingUserQueryCheckpointName = null;
      pendingUserQueryCheckpointIsInitial = false;
      try {
        const sm = manager(ctx);
        const hasInitialCheckpoint = persistedCheckpointEntries(sm).some(({ checkpoint }) => checkpoint.id === 0);
        const checkpoint = isInitial
          ? hasInitialCheckpoint ? undefined : persistCheckpoint(pi, ctx, "Initial user query", 0)
          : persistCheckpoint(pi, ctx, name);
        const targetEntry = checkpoint ? sm.getEntry(checkpoint.targetId) : undefined;
        logInterceptor("automatic_user_query_checkpoint", {
          created: checkpoint !== undefined,
          initial: isInitial,
          alreadyExists: hasInitialCheckpoint && isInitial,
          checkpointId: checkpoint?.id ?? (hasInitialCheckpoint && isInitial ? 0 : null),
          targetId: checkpoint?.targetId ?? null,
          targetRole: targetEntry?.type === "message" ? targetEntry.message.role : targetEntry?.type ?? null,
        });
      } catch (error) {
        // Checkpointing is opportunistic and must never block the user's request.
        logInterceptor("automatic_user_query_checkpoint_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!postJumpTurnProtected) return;
    const asRecord = (value: unknown): Record<string, any> | undefined =>
      value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
    const payload = asRecord(event.payload);
    const request = asRecord(payload?.body) ?? payload;
    const messageList = Array.isArray(request?.messages)
      ? request.messages
      : Array.isArray(request?.input) ? request.input : [];
    const lastMessage = asRecord(messageList.at(-1));
    const lastContent = lastMessage?.content;
    const lastText = typeof lastContent === "string"
      ? lastContent
      : Array.isArray(lastContent)
        ? lastContent.map((part: any) => typeof part?.text === "string" ? part.text : "").join("\n")
        : "";
    const matchesFollowupText = lastText.includes("checkpoint_jump completed and the payload is active.")
      || lastText.includes("checkpoint_jump complete. Continue from the payload");
    const rawTools = request?.tools;
    const toolLocation = Array.isArray(rawTools) ? "tools"
      : Array.isArray(request?.functions) ? "functions"
        : Array.isArray(asRecord(rawTools)?.functionDeclarations) ? "tools.functionDeclarations"
          : null;
    const toolList = toolLocation === "tools" ? rawTools
      : toolLocation === "functions" ? request?.functions
        : toolLocation === "tools.functionDeclarations" ? asRecord(rawTools)?.functionDeclarations
          : [];
    const toolNames = toolList.slice(0, 128).map((tool: any) => {
      const fn = asRecord(tool?.function);
      const declaration = asRecord(tool?.function_declaration);
      const name = tool?.name ?? fn?.name ?? declaration?.name;
      return typeof name === "string" ? name.slice(0, 128) : null;
    });
    logInterceptor("before_provider_request_after_jump", {
      provider: ctx.model?.provider ?? null,
      model: ctx.model?.id ?? null,
      api: ctx.model?.api ?? null,
      postJumpTurnProtected,
      payloadKeys: payload ? Object.keys(payload).sort().slice(0, 64) : [],
      requestKeys: request ? Object.keys(request).sort().slice(0, 64) : [],
      toolLocation,
      toolCount: toolLocation === null ? null : toolList.length,
      toolNames,
      omittedToolNameCount: Math.max(0, toolList.length - toolNames.length),
      messageCount: messageList.length,
      lastMessageRole: typeof lastMessage?.role === "string" ? lastMessage.role : null,
      lastMessageType: typeof lastMessage?.type === "string" ? lastMessage.type : null,
      lastMessageIsCheckpointFollowup: lastMessage?.customType === EXTENSION_TYPE || matchesFollowupText,
      lastMessageMatchesFollowupText: matchesFollowupText,
      lastMessageContentChars: lastText.length,
    });
  });

  const readLoadoutOverride = {
    prepareLoadout: () => ({
      descriptions: {
        read: "Read a complete file or specific line range. Supports images (jpg, png, gif, webp, bmp), sent as attachments. Each large file requires its own accumulation checkpoint before the first read.",
      },
    }),
  };
  const createParams = Type.Object({
    name: Type.String({ description: "Descriptive checkpoint name; it does not need to be unique." }),
  });
  const createCheckpoint = async (_id: string, params: Static<typeof createParams>, _signal: AbortSignal, _update: (update: any) => void, ctx: ExtensionContext) => {
    const name = params.name.trim();
    if (!name) return textResult("Checkpoint name cannot be empty.");
    const record = persistCheckpoint(pi, ctx, name);
    if (!record) return textResult("No history node is available for a checkpoint.");
    return textResult(formatCheckpointLabel(record));
  };
  for (const [name, label] of [["checkpoint_create", "Create checkpoint"], ["subagent_checkpoint_create", "Create subagent checkpoint"]] as const) {
    pi.registerTool({
      ...readLoadoutOverride,
      name, label,
      description: "Creates a new checkpoint, so you can later jump back.",
      promptSnippet: "Save a point in time; all your current knowledge and workspace state become part of the checkpoint; you may jump to it later by ID.",
      promptGuidelines: ["Checkpoint locks-in your current memory but also your current workspace utilization; never jump to the same checkpoint you just created."],
      parameters: createParams,
      execute: createCheckpoint,
    });
  }

  const listParams = Type.Object({ limit: Type.Optional(Type.Number({ description: "Maximum checkpoints to show (default: 50)." })) });
  pi.registerTool({
    ...readLoadoutOverride,
    name: "checkpoint_list", label: "List available checkpoints",
    description: "List available checkpoints and IDs.",
    promptSnippet: "List available checkpoints, their IDs and workspace utilization at that time.",
    promptGuidelines: ["Chose a suitable jump target."],
    parameters: listParams,
    async execute(_id, params: Static<typeof listParams>, _signal, _update, ctx) {
      const sm = manager(ctx);
      const limit = Math.max(1, Math.floor(params.limit ?? 50));
      const checkpoints = listedCheckpointEntries(sm)
        .sort((left, right) => left.checkpoint.id - right.checkpoint.id)
        .slice(-limit);
      const lines = checkpoints.map(({ checkpoint }) => formatCheckpointLabel(checkpoint));
      return textResult(lines.join("\n") || "(no checkpoints)");
    },
  });

  const jumpParams = Type.Object({
    target: Type.Number({ multipleOf: 1, description: "Numeric checkpoint ID returned by checkpoint_create or shown by checkpoint_list." }),
    payload: Type.String({ description: "Payload that selectively preserves all relevant knowledge acquired since the target checkpoint was created and includes planned next steps. Must be concrete state; empty or placeholder payloads (e.g. '-- omitted --') are rejected." }),
    task_completed: Type.Optional(Type.Boolean({ description: "Use true only after you already reported task completion to the user." })),
  });
  const subagentJumpParams = Type.Object({
    target: Type.Number({ multipleOf: 1, description: "Numeric checkpoint ID returned by subagent_checkpoint_create." }),
    payload: Type.String({ description: "Payload that selectively preserves all relevant knowledge acquired since the target checkpoint was created and includes planned next steps. Must be concrete state; empty or placeholder payloads (e.g. '-- omitted --') are rejected." }),
  });
  pi.registerTool({
    ...readLoadoutOverride,
    name: "checkpoint_jump", label: "Jump to checkpoint",
    description: "Jump to a numeric checkpoint and continue with the supplied payload.",
    promptSnippet: "Jump to a checkpoint after completing a unit of work; always include a relevant payload.",
    //promptGuidelines: ["Include relevant facts, decisions, completed actions, side effects, unresolved issues, and the next action in the payload."],
    parameters: jumpParams,
    renderCall(args, theme, context) { return renderJumpCall("checkpoint_jump", args, theme, context); },
    renderResult: renderJumpResult,
    async execute(_id, params: Static<typeof jumpParams>, _signal, _update, ctx) {
      const sm = manager(ctx);
      const target = resolveCheckpointId(sm, params.target);
      if (!target) return textResult(`Checkpoint #${params.target} was not found. Use checkpoint_list to inspect available checkpoints.`);
      // Validate before clearing hard-pressure flags so a rejected forced jump
      // re-triggers on the next turn instead of silently losing state.
      const payloadError = jumpPayloadError(params.payload);
      if (payloadError) return textResult(payloadError);
      const jumpNotice = checkpointJumpNotice(sm, params.target);
      const leaf = sm.getLeafId();
      const autoResume = hardJumpPending || hardInterruptionCancelledForJump;
      if (leaf === target) {
        if (autoResume) cancelHardInterruptionForJump();
        return textResult(params.target === 0 ? "Already at checkpoint." : `Already at checkpoint [${params.target}].`);
      }
      const taskCompleted = autoResume ? false : (params.task_completed ?? false);
      jumpPending = true;
      cancelHardInterruptionForJump();
      pendingJump = { target, checkpointId: params.target, payload: params.payload, taskCompleted, subagent: false, autoResume };
      return {
        ...payloadResult(taskCompleted
          ? params.target === 0
            ? "Jump to checkpoint is pending after next user input."
            : `Jump to checkpoint [${params.target}] is pending after next user input.`
          : jumpNotice, params.payload),
        terminate: true,
      };
    },
  });
  const outputIdParam = Type.Number({ minimum: 1, multipleOf: 1, description: "Tool output ID returned with a large output's first chunk." });
  const receiveFullParams = Type.Object({ id: outputIdParam });
  pi.registerTool({
    ...readLoadoutOverride,
    name: "output_receive_full", label: "Receive full tool output",
    description: "Accept the complete large output only when the full text is necessary and fits in your available workspace.",
    parameters: receiveFullParams,
    async execute(_toolCallId, params: Static<typeof receiveFullParams>, _signal, _update, ctx) {
      const output = pendingToolOutputs.get(params.id);
      if (!output) return textResult(`Requested output ID ${params.id} was not found.`);
      const workspaceTokens = retrievalWorkspaceTokens(ctx);
      if (workspaceTokens === null) {
        return textResult(`Could not calculate available workspace for output ID ${params.id}. Jump to an earlier checkpoint before retrieving it.`);
      }
      if (output.estimatedTokens > workspaceTokens) {
        const recommendedPage = outputPageWithinBudget(output, params.id, 1, Math.max(0, workspaceTokens));
        if (!recommendedPage) {
          return textResult(`No complete lines from output ID ${params.id} fit in the available workspace. Jump to an earlier checkpoint before retrieving it using 'output_receive_full' or 'output_receive_paginate'.`);
        }
        return textResult(`Full output was not accepted because it does not fit in the available workspace. Retrieve output ID ${params.id} using output_receive_paginate with offset 1 and limit ${recommendedPage.lineCount}.`);
      }
      return { content: output.content, details: output.details };
    },
  });

  const receivePaginateParams = Type.Object({
    id: outputIdParam,
    offset: Type.Number({ minimum: 1, multipleOf: 1, description: "1-based line number to start retrieving from." }),
    limit: Type.Optional(Type.Number({ minimum: 1, multipleOf: 1, description: "Maximum number of complete lines to retrieve in this page. Omit to safely fit the available workspace." })),
  });
  pi.registerTool({
    ...readLoadoutOverride,
    name: "output_receive_paginate", label: "Paginate tool output",
    description: "Accept a page of large output using a line-based offset and optional limit. If limit is omitted, automatically choose a page size that fits the current workspace while preserving the reasoning buffer. Use successive offsets and checkpoint_jump to process large outputs incrementally.",
    parameters: receivePaginateParams,
    async execute(_toolCallId, params: Static<typeof receivePaginateParams>, _signal, _update, ctx) {
      const output = pendingToolOutputs.get(params.id);
      if (!output) return textResult(`Requested output ID ${params.id} was not found.`);
      const offset = Math.max(1, Math.floor(params.offset));
      const workspaceTokens = retrievalWorkspaceTokens(ctx);
      if (workspaceTokens === null) {
        return textResult(`Could not calculate available workspace for output ID ${params.id}. Jump to an earlier checkpoint before retrieving it.`);
      }
      const remainingLines = Math.max(0, output.lineCount - offset + 1);
      let limit: number;
      if (params.limit === undefined) {
        if (remainingLines === 0) {
          limit = 1;
        } else {
          const recommendedPage = outputPageWithinBudget(output, params.id, offset, Math.max(0, workspaceTokens));
          if (!recommendedPage) {
            return textResult(`No complete lines from output ID ${params.id} fit in the available workspace. Jump to an earlier checkpoint before retrieving the next page using 'output_receive_paginate'.`);
          }
          limit = recommendedPage.lineCount;
        }
      } else {
        limit = Math.max(1, Math.floor(params.limit));
      }
      const requestedLines = Math.min(limit, remainingLines);
      const pageText = paginateContentByLines(output.content, offset, requestedLines);
      const pageLines = requestedLines;
      const resultText = formatOutputPage(pageText, params.id, offset, pageLines, output.lineCount);
      if (workspaceTokens <= 0 || estimateTextTokens(resultText) > workspaceTokens) {
        const recommendedPage = outputPageWithinBudget(output, params.id, offset, Math.max(0, workspaceTokens));
        if (!recommendedPage) {
          return textResult(`No complete lines from output ID ${params.id} fit in the available workspace. Jump to an earlier checkpoint before retrieving the next page.`);
        }
        return textResult(`The requested page does not fit in available workspace. Retry with limit ${recommendedPage.lineCount}, or jump to an earlier checkpoint before retrieving output ID ${params.id}.`);
      }
      return {
        content: [{ type: "text" as const, text: resultText }],
        details: {
          outputId: params.id,
          offset,
          limit: pageLines,
          totalLines: output.lineCount,
          nextOffset: offset + pageLines,
        },
      };
    },
  });

  pi.registerTool({
    ...readLoadoutOverride,
    name: "subagent_checkpoint_jump", label: "Jump to checkpoint as subagent",
    description: "Jump to a numeric checkpoint and continue with the supplied payload.",
    promptSnippet: "Jump to a checkpoint after completing a unit of work; always include a relevant payload.",
    parameters: subagentJumpParams,
    renderCall(args, theme, context) { return renderJumpCall("subagent_checkpoint_jump", args, theme, context); },
    renderResult: renderJumpResult,
    async execute(_id, params: Static<typeof subagentJumpParams>, _signal, _update, ctx) {
      const sm = manager(ctx);
      const target = resolveCheckpointId(sm, params.target);
      if (!target) return textResult(`Checkpoint #${params.target} was not found. Use checkpoint_list to inspect available checkpoints.`);
      const payloadError = jumpPayloadError(params.payload);
      if (payloadError) return textResult(payloadError);
      if (sm.getLeafId() === target) return textResult(params.target === 0 ? "Already at checkpoint." : `Already at checkpoint [${params.target}].`);
      jumpPending = true;
      cancelHardInterruptionForJump();
      // Do not terminate a subagent's prompt at the jump tool. The parent
      // runner treats termination as the end of the invocation and can return
      // an empty result before a deferred continuation is observed. The tool
      // result already carries the payload, so let the model finish naturally.
      pendingJump = { target, checkpointId: params.target, payload: params.payload, taskCompleted: false, subagent: true, autoResume: false };
      return payloadResult(params.target === 0
        ? "Checkpoint jump is pending while this subagent completes; payload retained."
        : `Checkpoint jump to [${params.target}] is pending while this subagent completes; payload retained.`, params.payload);
    },
  });

  pi.on("agent_end", (_event, ctx) => {
    const request = pendingJump;
    pendingJump = null;
    if (!request) {
      // Fallback for streams that ended before a partial tool name could be
      // classified. Normal non-jump work was already interrupted immediately.
      checkpointJumpCallInProgress = false;
      checkpointJumpNamePending = false;
      if (hardInterruptionCancelledForJump) {
        hardInterruptionCancelledForJump = false;
        hardFired = false;
        evaluatePressure(ctx);
      }
      dispatchHardInterruption(ctx);
      return;
    }

    // A completed jump is already the required compaction. Cancel any deferred
    // hard-limit request so it cannot trigger a duplicate jump after this branch.
    hardInterruptionPending = false;
    hardJumpPending = false;
    assistantBumpPending = false;

    // agent_end can fire before Pi has finished persisting the terminating turn.
    // Defer first so the core loop can settle, then wait for idle before checking
    // whether a genuinely new conversation entry appeared.
    setTimeout(async () => {
      try {
        const sm = manager(ctx);
        const compactTurnLeaf = sm.getLeafId();
        for (let attempt = 0; attempt < 100 && !ctx.isIdle(); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await new Promise((resolve) => setTimeout(resolve, 0));

        if (conversationAdvanced(sm.getBranch(), compactTurnLeaf)) {
          if (ctx.hasUI) ctx.ui.notify("checkpoint_jump cancelled: conversation advanced before the payload was applied.", "warning");
          return;
        }
        if (request.taskCompleted && !request.autoResume && ctx.hasUI) {
          pendingJumpOffer = {
            target: request.target,
            checkpointId: request.checkpointId,
            payload: request.payload,
            allowed: config.afterTaskCompaction === "allowed",
          };
          renderCompactionOffer(ctx);
          if (process.env.PI_WEB_SESSION === "1") announceWebCompactionOffer(pendingJumpOffer);
        } else {
          // Headless callers retain the original task_completed behavior.
          branchWithCheckpointVisibilitySnapshot(pi, sm, request.target, request.checkpointId, request.payload);
          markCompactionComplete();
          if ((!request.taskCompleted || request.autoResume) && !request.subagent) {
            // Start only after the branch write and agent_end cleanup have settled.
            // This avoids losing the trigger when the runtime is still completing
            // the terminating turn that contained checkpoint_jump.
            setTimeout(() => {
              pi.sendMessage({ customType: EXTENSION_TYPE, content: "checkpoint_jump completed and the payload is active. Resume the task from its next step now. When action is needed, use the registered tools through real tool calls; do not print tool-call/XML markup as text. If a tool action fails because of a workspace limit, use the reported limit to choose a smaller retrieval or jump to an earlier checkpoint, then continue.", display: false }, { triggerTurn: true, deliverAs: "followUp" });
            }, 0);
          }
        }
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`checkpoint_jump failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        // Covers cancellation, branch failures, and any persistence/runtime
        // error before the payload can be applied.
        restoreHardThinking();
        jumpPending = false;
        if (hardInterruptionCancelledForJump) {
          hardInterruptionCancelledForJump = false;
          hardFired = false;
          evaluatePressure(ctx);
        }
      }
    }, 0);
  });
}
