import { appendFileSync, existsSync, mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import { Type, type Message, type Static } from "@earendil-works/pi-ai";
import { config, DEFAULT_CONFIG, type Config } from "./config.js";
import {
  countReadFileLinesFromOffset,
  countReadFileLinesWithinTokenBudget,
  estimateLineTokens,
  estimateReadFileStats,
  estimateTokensSafe,
  readReadFileFull,
  resolveReadSourcePath,
  type ReadFileRange,
} from "./output-stream.js";
import { createUnlimitedBashToolDefinition } from "./unlimited-bash.js";

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
  "checkpoint_create", "checkpoint_jump", "checkpoint_list",
]);
const CHECKPOINT_JUMP_TOOL_NAMES = ["checkpoint_jump"] as const;
// A headless session is a spawned child. The header's parentSession is
// necessary but not sufficient: branched or forked main sessions inherit a
// parentSession too, and server-hosted sessions report hasUI=false like
// children do. The short fresh history guards the header path; the decisive
// signal is the pi-subagents prompt marker, visible at before_agent_start.
// The bound must stay above the handful of bootstrap entries a fresh child
// carries at session_start.
const HEADLESS_MAX_START_ENTRIES = 16;
// Prompt markers pi-subagents writes into every child prompt (replace mode
// adds "You are a pi coding agent sub-agent", append mode adds
// <sub_agent_context>); both modes always carry the <active_agent> tag.
const SUBAGENT_PROMPT_MARKERS = [
  '<active_agent name=',
  "You are a pi coding agent sub-agent",
  "<sub_agent_context>",
];
// The extension module instance is shared by every session in a server
// process, so the headless latch must be keyed per session id instead of
// living in a single module-level boolean (only the first session would ever
// run detection).
interface HeadlessLatch {
  headless: boolean;
  identity: string;
  detectedAt: string;
  source: string;
  signals: { parentSession: boolean; hasUI: boolean; startEntries: number; marker: boolean };
}
const headlessSessions = new Map<string, HeadlessLatch>();
// Identity strings recorded in the durable detection entry so a session file
// shows which contract was latched.
const HEADLESS_IDENTITY = "I am headless subagent";
const AGENT_IDENTITY = "I am agent";
function isHeadlessSession(sm: { getSessionId(): string }): boolean {
  return headlessSessions.has(sm.getSessionId());
}
// Records one detection per session id: a durable session entry and the
// in-memory latch used for tool contracts and instructions. appendEntry is
// provided by each call site's pi handle.
function latchHeadlessSession(
  pi: { appendEntry(type: string, data: unknown): void },
  sessionId: string,
  headless: boolean,
  source: string,
  signals: HeadlessLatch["signals"],
): HeadlessLatch {
  const identity = headless ? HEADLESS_IDENTITY : AGENT_IDENTITY;
  const detectedAt = new Date().toISOString();
  const latch: HeadlessLatch = { headless, identity, detectedAt, source, signals };
  headlessSessions.set(sessionId, latch);
  pi.appendEntry(HEADLESS_SESSION_ENTRY_TYPE, {
    ...latch,
    maxStartEntries: HEADLESS_MAX_START_ENTRIES,
  });
  return latch;
}
const IMAGE_READ_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const SMALL_TOOL_OUTPUT_MAX_CHARS = 500;
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
function jumpPayloadError(payload: string): string | undefined {
  const trimmed = payload.trim();
  if (!trimmed) return "The payload is empty. Write a payload that preserves relevant knowledge since the checkpoint and includes planned next steps, then call the jump tool again.";
  if (trimmed.length < MIN_PAYLOAD_CHARS) return `The payload is too short (${trimmed.length} characters). It must preserve relevant knowledge since the checkpoint and include planned next steps. Expand it and call the jump tool again; no jump was performed.`;
  return undefined;
}
const payloadResult = (text: string, payload: string) => ({ content: [{ type: "text" as const, text }], details: { payload } });

function isImageReadPath(input: string, cwd: string): boolean {
  try {
    return IMAGE_READ_EXTENSIONS.has(extname(resolveReadSourcePath(input, cwd)).toLowerCase());
  } catch {
    return IMAGE_READ_EXTENSIONS.has(extname(input).toLowerCase());
  }
}

function estimateTextTokens(text: string): number {
  return estimateTokensSafe(text);
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

function isSmallSingleLineToolOutput(content: readonly any[]): boolean {
  // Only exempt plain-text statuses; preserve the size guard for image or other
  // non-text payloads even if their accompanying text is short.
  if (!content.every((part) => part?.type === "text" && typeof part.text === "string")) return false;
  const text = content.map((part) => part.text as string).join("");
  if (text.length > SMALL_TOOL_OUTPUT_MAX_CHARS) return false;

  const lines = text.split(/\r\n|[\r\n\u2028\u2029]/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length <= 1;
}

function formatClippedReadNotice(read: ClippedRead): string {
  return `[Your read was clipped to fit the available workspace. You must not make further attempts to read until you Jump to a previous checkpoint; then continue reading at offset=${read.offset + read.actualLines}.]`;
}

function formatReadContinuationNotice(remainingLines: number, nextOffset: number): string {
  return `[${remainingLines} more lines in file. Use offset=${nextOffset} to continue.]`;
}

function appendBottomNotice(text: string, notice: string): string {
  const body = text.replace(/[\r\n]+$/, "");
  return body ? `${body}\n\n${notice}` : notice;
}

function appendNoticeToContent(content: readonly any[], notice: string): any[] {
  const result = content.map((part) => ({ ...part }));
  for (let index = result.length - 1; index >= 0; index--) {
    if (result[index].type === "text" && typeof result[index].text === "string") {
      // Replace Pi's generic continuation footer: it doesn't mention that the
      // requested limit was clipped and competes with the jump instruction.
      const text = result[index].text
        .replace(/\s*\[\d+ more lines in file\. Use offset=\d+ to continue\.\]\s*$/, "");
      result[index].text = appendBottomNotice(text, notice);
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

function formatOutputPage(
  pageText: string,
  id: number,
  offset: number,
  pageLines: number,
  totalLines: number,
  pageNotice?: string,
): string {
  const nextOffset = offset + pageLines;
  const continuation = nextOffset > totalLines
    ? "This was the last page."
    : `To continue, call 'output_receive_paginate' with id ${id}, offset ${nextOffset} and a suitable limit.`;
  const notice = pageNotice ? `[${pageNotice}. ${continuation}]` : `[${continuation}]`;
  return appendBottomNotice(pageText, notice);
}

function outputPageWithinBudget(
  output: BufferedToolOutput,
  id: number,
  offset: number,
  tokenBudget: number,
  pageNotice?: (lineCount: number) => string,
): { text: string; lineCount: number } | null {
  const remainingLines = Math.max(0, output.lineCount - offset + 1);
  const maxLines = Math.min(remainingLines, countOutputLinesWithinBudget(output, offset, tokenBudget));
  for (let lineCount = maxLines; lineCount > 0; lineCount--) {
    const pageText = paginateContentByLines(output.content, offset, lineCount);
    const text = formatOutputPage(pageText, id, offset, lineCount, output.lineCount, pageNotice?.(lineCount));
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

// Retrieval results are the page content itself, so the generic TUI fallback
// would print raw page lines (or one wrapped single-line blob) on every call.
// Render a one-line summary collapsed and the page only when expanded.
type ReceivePageDetails = {
  outputId?: unknown;
  offset?: unknown;
  limit?: unknown;
  totalLines?: unknown;
  nextOffset?: unknown;
};
type ReceiveFullDetails = { outputReceive?: { outputId?: unknown; totalLines?: unknown } };

function finiteInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function resultText(content: readonly any[]): string {
  return content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
}

function resultImageCount(content: readonly any[]): number {
  return content.filter((part: any) => part?.type === "image").length;
}

function renderReceiveCall(toolName: string, args: any, theme: any): Text {
  const title = theme.fg("toolTitle", theme.bold(`${toolName} `));
  const id = finiteInt(args?.id);
  const idText = id === undefined ? theme.fg("muted", "#?") : theme.fg("accent", `#${id}`);
  const offset = finiteInt(args?.offset);
  const limit = finiteInt(args?.limit);
  const range = offset === undefined ? ""
    : theme.fg("muted", limit === undefined ? ` lines ${offset}+` : ` lines ${offset}-${offset + limit - 1}`);
  return new Text(`${title}${idText}${range}`, 0, 0);
}

function renderReceiveFullResult(result: any, options: { expanded: boolean }, theme: any): Text {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = resultText(content);
  if (options.expanded) return new Text(text, 0, 0);
  const details = result?.details as ReceiveFullDetails | undefined;
  const outputId = finiteInt(details?.outputReceive?.outputId);
  // No retrieval metadata means this is a rejection or error message, which is
  // short and must stay visible collapsed.
  if (outputId === undefined) return new Text(text, 0, 0);
  const totalLines = finiteInt(details?.outputReceive?.totalLines);
  const images = resultImageCount(content);
  const parts = [totalLines === undefined ? "full output" : `${totalLines} line${totalLines === 1 ? "" : "s"}`];
  if (images > 0) parts.push(`${images} image${images === 1 ? "" : "s"}`);
  const summary = `Received full output #${outputId} (${parts.join(", ")})`;
  return new Text(theme.fg("muted", summary), 0, 0);
}

function renderReceivePageResult(result: any, options: { expanded: boolean }, theme: any): Text {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = resultText(content);
  if (options.expanded) return new Text(text, 0, 0);
  const details = result?.details as ReceivePageDetails | undefined;
  const outputId = finiteInt(details?.outputId);
  const offset = finiteInt(details?.offset);
  const limit = finiteInt(details?.limit);
  const totalLines = finiteInt(details?.totalLines);
  const nextOffset = finiteInt(details?.nextOffset);
  if (outputId === undefined || offset === undefined || limit === undefined) {
    return new Text(text, 0, 0);
  }
  const lastLine = offset + Math.max(1, limit) - 1;
  const totals = totalLines === undefined ? "" : ` of ${totalLines}`;
  const continuation = totalLines === undefined || nextOffset === undefined ? ""
    : nextOffset > totalLines ? "; final page" : `; next offset ${nextOffset}`;
  const summary = `Received lines ${offset}-${lastLine}${totals} (output #${outputId}${continuation})`;
  return new Text(theme.fg("muted", summary), 0, 0);
}

function withReceiveFullDetails(details: unknown, outputId: number, totalLines: number): unknown {
  const base = details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : {};
  return { ...base, outputReceive: { outputId, totalLines } };
}

function usagePercent(ctx: ExtensionContext): number | null {
  const usage = ctx.getContextUsage();
  if (!usage) return null;
  if (typeof usage.percent === "number") return usage.percent;
  return usage.contextWindow > 0 && usage.tokens != null ? usage.tokens / usage.contextWindow * 100 : null;
}

// Use the same conservative offline estimator for prefix accounting; the
// provider tokenizer is unavailable and Pi's utility subpath is not resolvable
// in every supported installation.
function estimatePiTextTokens(text: string): number {
  return estimateTokensSafe(text);
}

function estimatePiMessageTokens(message: Message): number {
  let tokens = 0;
  if (message.role === "user") {
    if (typeof message.content === "string") return estimatePiTextTokens(message.content);
    for (const block of message.content) {
      tokens += block.type === "text" ? estimatePiTextTokens(block.text) : 4800;
    }
    return tokens;
  }
  if (message.role === "toolResult") {
    for (const block of message.content) {
      tokens += block.type === "text" ? estimatePiTextTokens(block.text) : 4800;
    }
    return tokens;
  }
  for (const block of message.content) {
    if (block.type === "text") tokens += estimatePiTextTokens(block.text);
    else if (block.type === "thinking") tokens += estimatePiTextTokens(block.thinking);
    else tokens += estimateTokensSafe(`${block.name}${JSON.stringify(block.arguments)}`);
  }
  return tokens;
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

// Raw workspace left before the hard threshold: every token of tool output
// beyond this is what exhausts the workspace and triggers the hard jump. The
// reasoning buffer deliberately does NOT shrink this figure — interception
// already bounds single results, so withholding ~3-5% of the window here only
// undersized the workspace. Pressure checks use this raw figure.
function retrievalWorkspaceTokens(ctx: ExtensionContext): number | null {
  const usage = ctx.getContextUsage();
  if (!usage || usage.contextWindow <= 0) return null;
  const tokens = usage.tokens ?? (usage.percent == null ? null : usage.percent / 100 * usage.contextWindow);
  if (tokens == null || !Number.isFinite(tokens)) return null;
  return Math.floor(usage.contextWindow * config.hardThresholdPercent / 100 - tokens);
}

// Budget quoted to the agent in retrieval/read sizing hints. Unlike raw
// workspace it reserves the reasoning buffer (the model's next reasoning turn
// plus the follow-up pagination call) and an envelope sliver for the page
// footer, refusal-notice text, and pi's tool-result framing — the advisory
// line counter measures raw lines only, so without this reserve the quoted
// page size is structurally too big and retries ratchet downward.
const ADVISORY_ENVELOPE_RESERVE_TOKENS = 256;

function advisoryWorkspaceTokens(ctx: ExtensionContext): number | null {
  const raw = retrievalWorkspaceTokens(ctx);
  if (raw === null) return null;
  const usage = ctx.getContextUsage();
  const reasoningReserve = usage && usage.contextWindow > 0
    ? Math.floor(usage.contextWindow * config.workspaceReasoningBufferPercent / 100)
    : 0;
  return Math.max(0, raw - reasoningReserve - ADVISORY_ENVELOPE_RESERVE_TOKENS);
}

const CHECKPOINT_ENTRY_TYPE = "pi-voluntary-compaction-checkpoint";
const CHECKPOINT_VISIBILITY_ENTRY_TYPE = "pi-voluntary-compaction-checkpoint-visibility";
const HEADLESS_SESSION_ENTRY_TYPE = "pi-voluntary-compaction-headless-session";
// A hard interruption forces thinking off, and pi persists that change as a
// `thinking_level_change` entry that is indistinguishable from the user choosing
// off. This hint records the level being replaced so a session that crashes
// before the jump can restore what the user actually had configured.
const THINKING_HINT_ENTRY_TYPE = "pi-voluntary-compaction-thinking";

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

function roundedPercent(value: number): string {
  return String(Math.sign(value) * Math.round(Math.abs(value)));
}

function formatCheckpointLabel(checkpoint: CheckpointLabel, workspaceDelta?: number): string {
  const percentage = checkpoint.workspaceUsedPercent;
  if (percentage === undefined) return `[${checkpoint.id}]: ${checkpoint.name}`;
  const formatted = roundedPercent(percentage);
  const delta = workspaceDelta === undefined ? "" : `, Δ ${roundedPercent(workspaceDelta)}%`;
  return `[${checkpoint.id}]: ${checkpoint.name} (utilization: ${formatted}%${delta})`;
}

type ForcedThinkingHint = { thinkingLevel: string };

function forcedThinkingHintRecord(value: unknown): ForcedThinkingHint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { thinkingLevel?: unknown };
  return typeof record.thinkingLevel === "string" && record.thinkingLevel.length > 0
    ? { thinkingLevel: record.thinkingLevel }
    : undefined;
}

// The hint is authoritative only while it is the newest thinking-level decision on
// the branch. Any `thinking_level_change` entry appended after it means the user
// changed /thinking, or that the interruption restored the level normally, so pi's
// own persisted state is correct and there is nothing to recover.
function recoverableForcedThinkingLevel(sm: SessionManager): string | undefined {
  const entries = [...sm.getBranch()];
  let hint: string | undefined;
  let hintIndex = -1;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== THINKING_HINT_ENTRY_TYPE) continue;
    const record = forcedThinkingHintRecord(entry.data);
    if (record) {
      hint = record.thinkingLevel;
      hintIndex = index;
    }
  }
  if (hint === undefined) return undefined;
  for (let index = hintIndex + 1; index < entries.length; index++) {
    if (entries[index].type === "thinking_level_change") return undefined;
  }
  return hint;
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
  const formatted = roundedPercent(percentage);
  const generosity = percentage <= 45 ? "generous " : "";
  // Application is deferred until this turn ends (or until queued input resumes
  // the run), so nothing is freed yet when this notice is produced; and the
  // figure is the target's utilisation when it was recorded, not a live reading.
  return `[${notice}; workspace will be cleared to ${generosity}${formatted}% utilization.]`;
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

function checkpointWorkspaceDelta(checkpoint: CheckpointLabel, currentWorkspacePercent: number | null): number | undefined {
  if (currentWorkspacePercent === null || checkpoint.workspaceUsedPercent === undefined) return undefined;
  return currentWorkspacePercent - checkpoint.workspaceUsedPercent;
}

function checkpointMeetsMinimumJumpDistance(checkpoint: CheckpointLabel, currentWorkspacePercent: number | null): boolean {
  const delta = checkpointWorkspaceDelta(checkpoint, currentWorkspacePercent);
  if (delta === undefined || checkpoint.workspaceUsedPercent === undefined) return false;
  return checkpoint.workspaceUsedPercent <= config.softThresholdPercent || delta >= config.minimumJumpDistance;
}

function eligibleJumpCheckpoints(
  sm: SessionManager,
  currentWorkspacePercent: number | null,
): Array<{ checkpoint: CheckpointLabel; targetId: string; workspaceDelta: number }> {
  if (currentWorkspacePercent === null) return [];
  return checkpointEntries(sm)
    .filter(({ checkpoint }) => checkpoint.id !== 0)
    .map(({ checkpoint, targetId }) => ({
      checkpoint,
      targetId,
      workspaceDelta: checkpointWorkspaceDelta(checkpoint, currentWorkspacePercent),
    }))
    .filter((entry): entry is { checkpoint: CheckpointLabel; targetId: string; workspaceDelta: number } =>
      entry.workspaceDelta !== undefined && checkpointMeetsMinimumJumpDistance(entry.checkpoint, currentWorkspacePercent))
    .sort((left, right) => left.checkpoint.id - right.checkpoint.id);
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

function configuredAutoCompaction(path: string): boolean | undefined {
  try {
    const settings = JSON.parse(readFileSync(path, "utf8"));
    const enabled = settings?.compaction?.enabled;
    return typeof enabled === "boolean" ? enabled : undefined;
  } catch {
    return undefined;
  }
}

function autoCompactionEnabled(ctx: ExtensionContext): boolean {
  const globalPath = join(homedir(), ".pi", "agent", "settings.json");
  let enabled = configuredAutoCompaction(globalPath) ?? true;
  if (ctx.isProjectTrusted()) {
    const projectPath = join(ctx.cwd, ".pi", "settings.json");
    enabled = configuredAutoCompaction(projectPath) ?? enabled;
  }
  return enabled;
}

function loadAgentInstructions(fallback?: string | null): string | null {
  const candidates = [
    new URL("../instructions/context-management.md", import.meta.url),
    new URL("./instructions/context-management.md", import.meta.url),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    if (fallback !== undefined) return fallback ?? null;
    throw new Error("pi-voluntary-compaction: instructions/context-management.md was not found beside the extension");
  }
  return readFileSync(path, "utf8").trim();
}

function loadHeadlessAgentInstructions(fallback: string | null): string | null {
  const candidates = [
    new URL("../instructions/context-management-headless.md", import.meta.url),
    new URL("./instructions/context-management-headless.md", import.meta.url),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) return fallback;
  return readFileSync(path, "utf8").trim();
}

const CONFIG_KEYS: (keyof Config)[] = [
  "softThresholdPercent", "hardThresholdPercent", "workspaceReasoningBufferPercent", "maxToolOutputTokens", "minimumJumpDistance", "softMessage",
  "hardReasoningMessage", "hardNonReasoningMessage", "instructions",
  "advertiseVoluntaryCompaction", "afterTaskCompaction", "outputMarginFloorTokens",
];
type ConfigOverrides = Partial<Config>;

function validConfig(value: any): value is Config {
  if (!value || typeof value !== "object") return false;
  return Number.isFinite(value.softThresholdPercent)
    && Number.isFinite(value.hardThresholdPercent)
    && Number.isFinite(value.workspaceReasoningBufferPercent)
    && value.workspaceReasoningBufferPercent >= 0
    && value.workspaceReasoningBufferPercent <= 25
    && Number.isSafeInteger(value.maxToolOutputTokens)
    && value.maxToolOutputTokens >= 1
    && Number.isFinite(value.minimumJumpDistance)
    && value.minimumJumpDistance >= 0
    && value.minimumJumpDistance <= 100
    && value.softThresholdPercent >= 0
    && value.softThresholdPercent < value.hardThresholdPercent
    && value.hardThresholdPercent <= 100
    && typeof value.softMessage === "string"
    && typeof value.hardReasoningMessage === "string"
    && typeof value.hardNonReasoningMessage === "string"
    && (value.instructions === null || typeof value.instructions === "string")
    && typeof value.advertiseVoluntaryCompaction === "boolean"
    && (value.afterTaskCompaction === "denied" || value.afterTaskCompaction === "allowed")
    && (value.outputMarginFloorTokens === null
      || (Number.isSafeInteger(value.outputMarginFloorTokens)
        && value.outputMarginFloorTokens >= 256
        && value.outputMarginFloorTokens <= 8192));
}

function validOverrides(value: any): value is ConfigOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => {
    if (!CONFIG_KEYS.includes(key as keyof Config)) return false;
    const item = value[key];
    if (key === "instructions") return item === null || typeof item === "string";
    if (key === "workspaceReasoningBufferPercent") return typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 25;
    if (key === "maxToolOutputTokens") return typeof item === "number" && Number.isSafeInteger(item) && item >= 1;
    if (key === "advertiseVoluntaryCompaction") return typeof item === "boolean";
    if (key === "afterTaskCompaction") return item === "denied" || item === "allowed";
    // Token counts are not percentages: validate before the generic 0-100 branch.
    if (key === "outputMarginFloorTokens") {
      return item === null
        || (typeof item === "number" && Number.isSafeInteger(item) && item >= 256 && item <= 8192);
    }
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
  workspaceReasoningBufferPercent: "Context reserved for reasoning while deciding whether a read or retrieved output fits in the available workspace. Only really useful for models that cannot turn thinking off; set it to 0 when your model supports disabling reasoning. Range: 0-25%.",
  maxToolOutputTokens: "Maximum estimated token size for a single non-read tool output before it is paginated. Checkpoint and pagination tools are excluded.",
  minimumJumpDistance: "The minimum workspace utilization difference for a checkpoint jump to be valid when the target is above the soft threshold. Range: 0-100%.",
  softMessage: "Message sent to the model at the soft threshold. Use it to explain how the model should prepare before context becomes critical.",
  hardReasoningMessage: "Synthetic assistant message appended for reasoning models at the hard threshold to interrupt active reasoning and force checkpoint return.",
  hardNonReasoningMessage: "Urgent message sent to non-reasoning models at the hard threshold. It asks for immediate checkpoint return.",
  instructions: "Instructions appended to the system prompt. The package Markdown is used when this is set to the default (null); custom text replaces it.",
  advertiseVoluntaryCompaction: "Controls whether checkpoint and voluntary-compaction instructions are advertised in the system prompt. Pressure warnings and tools remain active when disabled.",
  afterTaskCompaction: "Default decision shown after the agent requests task compaction. Alt+C toggles it in the TUI; pi-web provides /jump and /nojump commands before the next message applies it.",
  outputMarginFloorTokens: "Output tokens reserved for the forced-jump answer when workspace is exhausted at the hard threshold, replacing pi's fixed 4096-token margin. Default 256 keeps only a safety sliver because tool-output interception already bounds oversized results. Set to null (empty) to keep pi's behavior. Range: 256-8192.",
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
  // Set when the user changes /thinking to a level other than "off" while a hard
  // interruption holds thinking off. The manual choice wins over the captured value.
  let userChoseThinkingLevelDuringHardOff = false;
  const activeToolCalls = new Set<string>();
  let checkpointJumpCallInProgress = false;
  let checkpointJumpNamePending = false;
  let invalidJumpInterruptionTriggered = false;
  let turnInProgress = false;
  let rebuildPending = false;
  let pendingUserQueryCheckpointName: string | null = null;
  let pendingUserQueryCheckpointIsInitial = false;
  let jumpPending = false;
  let postJumpTurnProtected = false;
  let pendingJump: PendingJump | null = null;
  let jumpAppliedEarly = false;
  let pendingForcedJumpInterruption: string | null = null;
  // Hard-limit continuation text awaiting delivery after an immediate abort.
  // Kept separate from `pendingForcedJumpInterruption` (invalid-jump retry) so
  // the two follow-ups cannot overwrite each other.
  let pendingHardLimitFollowup: string | null = null;
  // Latched while an abort-at-hard-limit continuation is owed, so agent_end can
  // deliver or discard it exactly once.
  let hardLimitFollowupPending = false;
  // Hard interruptions injected since the assistant last produced any output or
  // tool call. A resumed session can already be over the provider's context
  // window: every request fails instantly and leaves an empty assistant turn,
  // while each injected warning only enlarges an already-rejected prompt. With
  // no progress check the evaluator re-arms forever (bug13: ~5 injections per
  // second, unbounded, until the user killed the process).
  let interruptionsSinceAssistantProgress = 0;
  let hardInterruptionStalled = false;
  // Multiple lifecycle hooks (message_end, turn_end and both agent_end handlers)
  // each dispatch once while pressure stays pending, so one turn could inject the
  // same warning twice. Every injection costs ~350 tokens of checkpoint list.
  let interruptionDispatchedThisTurn = false;
  let pendingJumpOffer: PendingJumpOffer | null = null;
  let removeTerminalInput: (() => void) | null = null;
  let interceptorLogPath: string | null = null;
  let interceptorLogSequence = 0;
  let streamUpdateCount = 0;
  let lastAutoCompactionEnabled: boolean | null = null;
  const autoCompactionWatchers: Array<{ path: string; listener: (current: Stats, previous: Stats) => void }> = [];

  const stopAutoCompactionWatchers = (): void => {
    for (const watcher of autoCompactionWatchers.splice(0)) {
      unwatchFile(watcher.path, watcher.listener);
    }
  };

  const checkAutoCompactionSetting = (ctx: ExtensionContext): void => {
    const enabled = autoCompactionEnabled(ctx);
    if (enabled === lastAutoCompactionEnabled) return;
    lastAutoCompactionEnabled = enabled;
    if (enabled && ctx.hasUI) {
      ctx.ui.notify("pi-voluntary-compaction replaces built-in auto-compact; disable auto-compact to avoid competing compaction flows.", "warning");
    }
  };

  const watchAutoCompactionSettings = (ctx: ExtensionContext): void => {
    const paths = [join(homedir(), ".pi", "agent", "settings.json")];
    if (ctx.isProjectTrusted()) paths.push(join(ctx.cwd, ".pi", "settings.json"));
    for (const path of paths) {
      const listener = (_current: Stats, _previous: Stats): void => {
        try {
          checkAutoCompactionSetting(ctx);
        } catch {
          // A context can become stale while switching sessions; the next
          // session_start installs fresh settings watchers.
        }
      };
      watchFile(path, { interval: 500, persistent: false }, listener);
      autoCompactionWatchers.push({ path, listener });
    }
  };

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
    hardLimitFollowupPending,
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

  // Pi drains queued user input before emitting agent_end, so a jump requested
  // by the terminating turn would otherwise be applied only after that input
  // already ran on the unrewound context — and its rewind would then discard
  // the user's new message along with everything appended since the jump.
  // Applying it as the queued message starts (before it is persisted) keeps the
  // message on the rewound branch. The message itself drives the continuation,
  // so no extra continuation message is needed.
  const applyPendingJumpForQueuedInput = (ctx: ExtensionContext): void => {
    const request = pendingJump;
    if (!request || request.subagent) return;
    // The task_completed offer path is applied by the next `input` event.
    if (request.taskCompleted && !request.autoResume) return;
    pendingJump = null;
    jumpAppliedEarly = true;
    hardInterruptionPending = false;
    hardJumpPending = false;
    assistantBumpPending = false;
    logInterceptor("queued_input_jump_applied", {
      checkpointId: request.checkpointId,
      targetId: request.target,
      autoResume: request.autoResume,
    });
    try {
      branchWithCheckpointVisibilitySnapshot(pi, manager(ctx), request.target, request.checkpointId, request.payload);
      markCompactionComplete();
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`checkpoint_jump failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      restoreHardThinking();
      jumpPending = false;
      if (hardInterruptionCancelledForJump) {
        // The branch never happened, so re-arm the hard warning that this jump
        // displaced; the next turn_start will evaluate pressure again.
        hardInterruptionCancelledForJump = false;
        hardFired = false;
      }
    }
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
    // Latch the headless contract once per session before any turn builds its
    // tool list: spawned children keep the private variant semantics even if
    // the same session file is later resumed with UI.
    const sessionId = manager(ctx).getSessionId();
    // Detection runs once per session id for the lifetime of this module
    // instance. Every session_start appends its durable record, so redeployed
    // or reloaded modules re-detect instead of trusting a stale one-shot latch.
    if (!headlessSessions.has(sessionId)) {
      const header = manager(ctx).getHeader();
      const startEntries = manager(ctx).getBranch().length;
      // Header-only latch: parentSession set AND a short fresh history. A
      // branched main session passes the header test but carries the parent's
      // long branch; server-hosted mains report hasUI=false, so hasUI must
      // not substitute for the history bound. Ambiguous cases stay unlatched
      // until before_agent_start reads the prompt markers.
      const headless = Boolean(header?.parentSession)
        && startEntries <= HEADLESS_MAX_START_ENTRIES;
      if (headless) {
        latchHeadlessSession(pi, sessionId, true, "header",
          { parentSession: true, hasUI: ctx.hasUI, startEntries, marker: false });
        registerHeadlessToolContracts();
      }
    }
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
  const defaultHeadlessInstructions = loadHeadlessAgentInstructions(defaultInstructions);
  pi.on("before_agent_start", (event, ctx) => {
    // Finalize the headless latch from the effective prompt: pi-subagents
    // stamps every child with an <active_agent> tag plus a sub-agent header,
    // which no main session carries. This is the decisive signal when the
    // session_start header heuristic was ambiguous (branched mains,
    // server-hosted sessions with hasUI=false).
    const sm = manager(ctx);
    const sessionId = sm.getSessionId();
    if (!headlessSessions.has(sessionId)) {
      const marker = SUBAGENT_PROMPT_MARKERS.some((marker) => event.systemPrompt.includes(marker));
      const header = sm.getHeader();
      const startEntries = sm.getBranch().length;
      if (marker || Boolean(header?.parentSession)) {
        latchHeadlessSession(pi, sessionId, marker, "before_agent_start",
          { parentSession: Boolean(header?.parentSession), hasUI: ctx.hasUI, startEntries, marker });
        if (marker) registerHeadlessToolContracts();
      }
    }
    const latch = headlessSessions.get(sessionId);
    if (!config.advertiseVoluntaryCompaction) return;
    const instructions = config.instructions
      ?? (latch?.headless ? defaultHeadlessInstructions : defaultInstructions);
    if (!instructions) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${instructions}`,
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
        ["maxToolOutputTokens", "Maximum tool output size"],
        ["minimumJumpDistance", "Minimum jump distance"],
        ["softMessage", "Soft warning message"],
        ["hardReasoningMessage", "Hard reasoning-model message"],
        ["hardNonReasoningMessage", "Hard non-reasoning-model message"],
        ["instructions", `Agent instructions (${edited.instructions === null ? "package default" : "custom"})`],
        ["advertiseVoluntaryCompaction", "Advertise voluntary compaction"],
        ["afterTaskCompaction", "After task compaction default"],
        ["outputMarginFloorTokens", "Forced-jump output floor"],
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
            const value = await ctx.ui.editor(`Edit agent instructions\n\n${description}`, edited.instructions ?? defaultInstructions ?? undefined);
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

        if (key === "outputMarginFloorTokens") {
          const current = edited.outputMarginFloorTokens;
          const value = await ctx.ui.editor(`Edit ${selected}\n\n${description}`, current === null ? "" : String(current));
          if (value == null) continue;
          const trimmed = value.trim();
          if (trimmed === "") {
            edited.outputMarginFloorTokens = null;
            editedKeys.add(key);
            continue;
          }
          const number = Number(trimmed);
          if (!Number.isSafeInteger(number) || number < 256 || number > 8192) {
            ctx.ui.notify("Forced-jump output floor must be a whole number between 256 and 8192 tokens, or empty for pi's default.", "error");
            continue;
          }
          edited.outputMarginFloorTokens = number;
          editedKeys.add(key);
          continue;
        }

        if (key === "softThresholdPercent" || key === "hardThresholdPercent" || key === "workspaceReasoningBufferPercent" || key === "maxToolOutputTokens" || key === "minimumJumpDistance") {
          const value = await ctx.ui.editor(`Edit ${selected}\n\n${description}`, String(edited[key]));
          if (value == null) continue;
          const number = Number(value);
          const maximum = key === "workspaceReasoningBufferPercent" ? 25 : 100;
          const invalidMaxToolOutput = key === "maxToolOutputTokens" && (!Number.isSafeInteger(number) || number < 1);
          if (invalidMaxToolOutput || !Number.isFinite(number) || (key !== "maxToolOutputTokens" && (number < 0 || number > maximum))) {
            ctx.ui.notify(key === "workspaceReasoningBufferPercent"
              ? "Workspace reasoning buffer must be between 0 and 25% in context."
              : key === "minimumJumpDistance"
                ? "Minimum jump distance must be between 0 and 100%."
                : key === "maxToolOutputTokens"
                  ? "Maximum tool output size must be a positive whole number of tokens."
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
        ctx.ui.notify("Settings were not saved: check the thresholds, workspace reasoning buffer, maximum tool output size, and minimum jump distance.", "error");
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
    const overridden = userChoseThinkingLevelDuringHardOff;
    hardThinkingPrevious = null;
    userChoseThinkingLevelDuringHardOff = false;
    if (previous === null) return;
    // A hard interruption leaves thinking off until the jump is applied, so any
    // other level here is a manual /thinking change made while the payload was
    // being composed. Never overwrite it: the captured value becomes stale.
    let current: ReturnType<ExtensionAPI["getThinkingLevel"]> | null = null;
    try {
      current = pi.getThinkingLevel();
    } catch {
      // The runtime may be shutting down or switching sessions.
    }
    if (overridden || (current !== null && current !== "off")) {
      logInterceptor("hard_thinking_restore_skipped_user_override", { captured: previous, current });
      return;
    }
    try {
      pi.setThinkingLevel(previous);
    } catch {
      // The runtime may be shutting down or switching sessions.
    }
  };

  pi.on("thinking_level_select", (event) => {
    // While a hard interruption holds the captured level, this extension only ever
    // sets "off", so any other selected level is the user's own choice.
    if (hardThinkingPrevious === null || event.level === "off") return;
    userChoseThinkingLevelDuringHardOff = true;
    logInterceptor("hard_thinking_user_override_recorded", {
      captured: hardThinkingPrevious,
      chosen: event.level,
    });
  });

  // Recovery for a session that crashed after a hard interruption: the branch ends
  // at the artificial "off", so restore the level persisted just before it. Runs
  // before pressure is evaluated so a new interruption captures the real level.
  const recoverThinkingAfterResume = (ctx: ExtensionContext) => {
    if (hardThinkingPrevious !== null) return;
    const level = recoverableForcedThinkingLevel(manager(ctx));
    if (!level || level === "off") return;
    let current: ReturnType<ExtensionAPI["getThinkingLevel"]> | null = null;
    try {
      current = pi.getThinkingLevel();
    } catch {
      return;
    }
    if (current === level) return;
    try {
      pi.setThinkingLevel(level as ReturnType<ExtensionAPI["getThinkingLevel"]>);
      logInterceptor("hard_thinking_resumed_from_hint", { level, before: current });
      if (ctx.hasUI) ctx.ui.notify(`pi-voluntary-compaction: restored thinking level ${level} after resume`, "info");
    } catch {
      // The runtime may reject a thinking level before the model is ready.
    }
  };

  const checkpointListForInterruption = (ctx: ExtensionContext): string => {
    const currentWorkspacePercent = workspaceUsedPercent(ctx);
    const checkpoints = eligibleJumpCheckpoints(manager(ctx), currentWorkspacePercent);
    if (!checkpoints.length) return "(no checkpoints with sufficient workspace utilization difference)";
    return checkpoints.map(({ checkpoint, workspaceDelta }) =>
      formatCheckpointLabel(checkpoint, workspaceDelta)).join("\n");
  };

  const invalidJumpTargetResult = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.notify("Checkpoint jump suppressed.", "warning");
    return textResult(`This checkpoint is invalid target, because the workspace utilization delta is too low.\n\nAvailable checkpoints (use one of these IDs; do not call checkpoint_list):\n${checkpointListForInterruption(ctx)}`);
  };

  const jumpTargetMeetsMinimumDistance = (sm: SessionManager, targetId: number, ctx: ExtensionContext): boolean => {
    const checkpoint = checkpointEntries(sm).find((entry) => entry.checkpoint.id === targetId)?.checkpoint;
    if (!checkpoint) return false;
    return checkpointMeetsMinimumJumpDistance(checkpoint, workspaceUsedPercent(ctx));
  };

  const interruptInvalidCheckpointJump = (ctx: ExtensionContext, target: unknown): void => {
    const targetLabel = typeof target === "number" || typeof target === "string"
      ? `#${target}`
      : "checkpoint";
    pendingForcedJumpInterruption = `Your checkpoint_jump was interrupted because target ${targetLabel} is not valid. Choose another ID from the available checkpoints below, then retry the jump with the payload you intended to preserve.\n\nAvailable checkpoints (use one of these IDs; do not call checkpoint_list):\n${checkpointListForInterruption(ctx)}`;
    // Unlike ordinary hard-limit steering, which waits for tool calls to
    // finish, this must abort the current model stream before the large payload
    // is completed or the invalid jump tool can execute.
    hardInterruptionPending = false;
    ctx.abort();
  };

  const inspectStreamedCheckpointJump = (
    toolName: unknown,
    args: any,
    toolCallId: unknown,
    ctx: ExtensionContext,
  ): void => {
    if (invalidJumpInterruptionTriggered
      || !CHECKPOINT_JUMP_TOOL_NAMES.includes(toolName as (typeof CHECKPOINT_JUMP_TOOL_NAMES)[number])
      || args == null
      // Partial arguments stream key by key. While `target` has not arrived yet
      // — the model may stream `payload` first — there is nothing to judge, so
      // wait rather than treating a missing target as an invalid one and
      // aborting a perfectly valid jump after a dozen streamed characters.
      || !Object.prototype.hasOwnProperty.call(args, "target")
      || !Object.prototype.hasOwnProperty.call(args, "payload")) return;

    const target = args.target;
    const sm = manager(ctx);
    const targetIsValid = typeof target === "number"
      && Number.isInteger(target)
      && resolveCheckpointId(sm, target) !== undefined
      && jumpTargetMeetsMinimumDistance(sm, target, ctx);
    if (targetIsValid) return;

    invalidJumpInterruptionTriggered = true;
    logInterceptor("invalid_checkpoint_jump_interrupted", {
      target: target ?? null,
      payloadPresent: true,
      toolCallId: toolCallId ?? null,
    });
    interruptInvalidCheckpointJump(ctx, target);
  };

  // Call only after the jump target and payload have passed validation. A
  // rejected attempt must retain the hard-limit thinking level for its retry.
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

  // Two injections give the model two chances to emit checkpoint_jump. A third
  // can only help if the assistant answered in between; otherwise it keeps
  // feeding a context that can no longer answer.
  const MAX_HARD_INTERRUPTIONS_WITHOUT_PROGRESS = 2;

  // Any assistant output or tool call proves the model can still act on a hard
  // interruption, so pressure may inject again.
  const noteAssistantProgress = (kind: string): void => {
    if (!hardInterruptionStalled && interruptionsSinceAssistantProgress === 0) return;
    logInterceptor("hard_interruption_progress_resumed", {
      kind,
      interruptionsSinceAssistantProgress,
      stalled: hardInterruptionStalled,
    });
    interruptionsSinceAssistantProgress = 0;
    hardInterruptionStalled = false;
  };

  const assistantMessageHasOutput = (message: any): boolean => {
    const parts = Array.isArray(message?.content) ? message.content : [];
    return parts.some((part: any) => part?.type === "toolCall"
      || (part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0)
      || (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim().length > 0));
  };

  const noteHardInterruptionInjected = (ctx: ExtensionContext, via: string): void => {
    interruptionDispatchedThisTurn = true;
    interruptionsSinceAssistantProgress += 1;
    if (interruptionsSinceAssistantProgress < MAX_HARD_INTERRUPTIONS_WITHOUT_PROGRESS) return;
    hardInterruptionStalled = true;
    logInterceptor("hard_interruption_stalled_no_progress", { via, ...pressureState() });
    if (ctx.hasUI) {
      ctx.ui.notify(
        `pi-voluntary-compaction: ${interruptionsSinceAssistantProgress} hard interruptions produced no assistant answer; injections stopped. Recover with /tree, then continue.`,
        "warning",
      );
    }
  };

  const dispatchHardInterruption = (ctx: ExtensionContext): void => {
    if (!hardInterruptionPending) return;
    // The model cannot answer at this context size; further injections only grow
    // a prompt the provider already rejected. Recovery is manual (pi's /tree).
    if (hardInterruptionStalled) return;
    if (interruptionDispatchedThisTurn) {
      logInterceptor("hard_interruption_suppressed_for_turn", pressureState());
      return;
    }
    if (jumpPending || checkpointJumpCallInProgress) {
      // Wait for the jump tool's distance validation. Only its accepted
      // execution may clear hard pressure and restore the prior thinking level.
      logInterceptor("hard_interruption_suppressed_for_jump", pressureState());
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

    // Ordinary hard steering is queued and lands at the next step boundary, so a
    // long assistant turn keeps adding output before pressure can act. Once
    // retrieval workspace is exhausted there is no room left for that turn: its
    // output — usually the required jump payload — truncates instead of freeing
    // context. Abort the active stream now and deliver the continuation when the
    // run settles, reusing the pattern already proven for invalid jumps. This
    // abort is unconditional: at exhausted retrieval it is the only path that
    // leaves room for the jump payload, so it is not user-configurable.
    const retrieval = retrievalWorkspaceTokens(ctx);
    if (turnInProgress && !ctx.isIdle() && retrieval !== null && retrieval <= 0) {
      try {
        pi.setThinkingLevel("off");
        hardInterruptionPending = false;
        pendingHardLimitFollowup = message;
        hardLimitFollowupPending = true;
        ctx.abort();
        logInterceptor("hard_interruption_aborted_stream", { retrievalWorkspaceTokens: retrieval, ...pressureState() });
        noteHardInterruptionInjected(ctx, "abort");
        if (ctx.hasUI) ctx.ui.notify(`pi-voluntary-compaction: hard limit aborted the active turn (${config.hardThresholdPercent}%)`, "error");
      } catch (error) {
        pendingHardLimitFollowup = null;
        hardLimitFollowupPending = false;
        hardInterruptionPending = true;
        logInterceptor("hard_interruption_abort_failed", { error: String(error), ...pressureState() });
      }
      return;
    }

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
      noteHardInterruptionInjected(ctx, "send");
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

  // `force` re-arms a hard interruption that the threshold evaluator would
  // suppress. Used when retrieval workspace is exhausted below the configured
  // hard percent, and by the zero-budget tool-output path: waiting for the raw
  // percent to cross the hard threshold leaves no room to emit the jump.
  const triggerHardInterruption = (ctx: ExtensionContext, force = false) => {
    // A stalled interruption must not be re-armed by `force`: the assistant has
    // not answered, so there is nothing new to interrupt.
    if (hardInterruptionStalled) return;
    if (hardFired && !force) return;
    if (force && (jumpPending || postJumpTurnProtected)) return;
    try {
      if (hardThinkingPrevious === null) {
        const captured = pi.getThinkingLevel();
        userChoseThinkingLevelDuringHardOff = false;
        hardThinkingPrevious = captured;
        pi.setThinkingLevel("off");
        // pi's own entry records only the artificial off, so persist the level it
        // replaced for crash recovery. Appending after the forced off is what lets
        // `recoverableForcedThinkingLevel` treat a later user change as newer.
        try {
          pi.appendEntry(THINKING_HINT_ENTRY_TYPE, { thinkingLevel: captured });
        } catch {
          // A session that cannot append entries simply cannot recover the level.
        }
      }
      hardJumpPending = true;
      hardInterruptionPending = true;
      hardFired = true;
      logInterceptor("hard_interruption_triggered", { turnInProgress, force, ...pressureState() });
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
      // Pressure relieved (a jump, /tree or ordinary work lowered usage), so a
      // later breach must be able to inject again even if the model never
      // answered while usage was high.
      interruptionsSinceAssistantProgress = 0;
      hardInterruptionStalled = false;
    }
    if (percent < config.softThresholdPercent) return;
    // Retrieval workspace is exhausted once tokens reach the configured hard
    // percent of the context window (raw retrieval figure; the reasoning buffer
    // is reserved inside sizing hints, not here).
    const retrieval = retrievalWorkspaceTokens(ctx);
    const exhausted = retrieval !== null && retrieval <= 0;
    if (percent >= config.hardThresholdPercent || exhausted) {
      triggerHardInterruption(ctx, exhausted);
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
    stopAutoCompactionWatchers();
    lastAutoCompactionEnabled = null;
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
    jumpAppliedEarly = false;
    pendingForcedJumpInterruption = null;
    pendingHardLimitFollowup = null;
    hardLimitFollowupPending = false;
    interruptionsSinceAssistantProgress = 0;
    hardInterruptionStalled = false;
    interruptionDispatchedThisTurn = false;
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
    recoverThinkingAfterResume(ctx);
    checkAutoCompactionSetting(ctx);
    watchAutoCompactionSettings(ctx);
    evaluatePressure(ctx);
  });
  pi.on("session_shutdown", () => {
    stopAutoCompactionWatchers();
  });
  pi.on("tool_result", async (event, ctx) => {
    // Preserve native image attachments. The text read preflight/reopen path
    // would otherwise treat binary image bytes as lines and can replace the
    // image result with decoded text when it decides the file is oversized.
    const imageReadInput = event.toolName === "read" ? event.input as { path?: unknown } : undefined;
    if (typeof imageReadInput?.path === "string" && isImageReadPath(imageReadInput.path, ctx.cwd)) return;

    // Keep VC's own checkpoint and pagination results out of the interceptor.
    if (event.toolName.startsWith("output_receive_")
      || event.toolName.startsWith("checkpoint_")) return;

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
        const workspaceTokens = advisoryWorkspaceTokens(ctx);
        if (workspaceTokens === null) return;
        const exceedsWorkspace = estimatedTokens > workspaceTokens;
        if (!exceedsWorkspace) {
          const text = await readReadFileFull(file, ctx.signal);
          if (file.lineLimit !== undefined) {
            const linesFromOffset = await countReadFileLinesFromOffset({ path: file.path, startLine: file.startLine }, ctx.signal);
            const selectedLines = Math.min(file.lineLimit, linesFromOffset);
            const remainingLines = linesFromOffset - selectedLines;
            if (remainingLines > 0) {
              const nextOffset = file.startLine + selectedLines + 1;
              return {
                content: [{
                  type: "text" as const,
                  text: appendBottomNotice(text, formatReadContinuationNotice(remainingLines, nextOffset)),
                }],
                details: {},
              };
            }
          }
          return {
            content: [{ type: "text" as const, text }],
            details: {},
          };
        }
        const recommendedLines = await countReadFileLinesWithinTokenBudget(file, 1, Math.max(0, workspaceTokens), ctx.signal);
        return {
          content: [{
            type: "text" as const,
            text: recommendedLines <= 0
              ? `Read is too large for available workspace; no line fits. Jump now, then read smaller chunks.`
              : `Read is too large for available workspace, only ${recommendedLines} lines would fit. To free more workspace and read bigger chunks, jump to an earlier checkpoint before trying again.`,
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
    const workspaceTokens = advisoryWorkspaceTokens(ctx);
    if (event.toolName === "read" && workspaceTokens === null) return;
    const exceedsWorkspace = workspaceTokens !== null && estimatedTokens > workspaceTokens;
    if (event.toolName === "read") {
      if (!exceedsWorkspace) return;
      const recommendedLines = countLinesWithinTokenBudget(contentText(event.content), 1, Math.max(0, workspaceTokens ?? 0));
      return {
        content: [{
          type: "text" as const,
          text: recommendedLines <= 0
            ? `Read is too large for available workspace; no line fits. Jump now, then read smaller chunks.`
            : `Read is too large for available workspace, only ${recommendedLines} lines would fit. To free more workspace and read bigger chunks, jump to an earlier checkpoint before trying again.`,
        }],
        details: {},
      };
    }
    const exceedsConfiguredLimit = estimatedTokens > config.maxToolOutputTokens;
    if (!exceedsWorkspace && !exceedsConfiguredLimit) return;
    if (isSmallSingleLineToolOutput(resultContent)) return;

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
    const pageBudget = workspaceTokens === null
      ? config.maxToolOutputTokens
      : Math.min(Math.max(0, workspaceTokens), config.maxToolOutputTokens);
    pendingToolOutputs.set(id, output);
    if (pageBudget <= 0) {
      // Workspace is exhausted. The full result stays buffered in memory, but a
      // multi-line notice would add tokens to an already saturated context on
      // every tool round; keep the shortest actionable directive instead.
      triggerHardInterruption(ctx, true);
      // No "keep the payload brief" hint here on purpose. A short payload under
      // output pressure turns a recoverable stall into a lossy jump that throws
      // away everything accumulated since the target; the objective is to never
      // reach this state, not to negotiate it badly. Output room is guaranteed
      // by `outputMarginFloorTokens` instead.
      // If even the jump payload cannot fit, the session is genuinely over the
      // ceiling and recovery is manual: pi's `/tree` navigates back to a safe
      // point and summarizes the abandoned path in its own model call. VC
      // deliberately does not automate that (see ANALYSIS-output-margin.md).
      return {
        content: [{
          type: "text" as const,
          text: `[0-token budget: jump now. Output retained as ID ${id}.]`,
        }],
        details: { outputId: id, totalLines: lineCount },
      };
    }

    const pageNotice = (pageLines: number) =>
      `Large tool output was paginated; showing lines 1-${pageLines} of ${lineCount}`;
    const firstPage = outputPageWithinBudget(output, id, 1, pageBudget, pageNotice);
    if (!firstPage) {
      return {
        content: [{
          type: "text" as const,
          text: `[Tool output is about ${estimatedTokens} tokens; no complete line fits within the current ${pageBudget}-token budget. Output is retained as ID ${id}. Jump to an earlier checkpoint, then call 'output_receive_paginate' with id ${id}, offset 1 and no limit.]`,
        }],
        details: { outputId: id, totalLines: lineCount },
      };
    }

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
    interruptionDispatchedThisTurn = false;
    const before = pressureState();
    evaluatePressure(ctx);
    logInterceptor("turn_start", { before, after: pressureState() });
  });
  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "user") {
      applyPendingJumpForQueuedInput(ctx);
      return;
    }
    if (event.message.role !== "assistant") return;
    streamUpdateCount = 0;
    checkpointJumpCallInProgress = false;
    checkpointJumpNamePending = false;
    invalidJumpInterruptionTriggered = false;
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
    if (update.type === "toolcall_start" || update.type === "toolcall_delta" || update.type === "toolcall_end") {
      observedToolCall = rawUpdate.toolCall
        ?? rawUpdate.partial?.content?.[rawUpdate.contentIndex];
      observedToolName = rawUpdate.toolName ?? observedToolCall?.name;
      observedToolNameSource = rawUpdate.toolName != null
        ? "toolName"
        : observedToolCall?.name != null ? "toolCall.name" : null;
      const name = observedToolName;
      if (update.type !== "toolcall_delta") {
        state = CHECKPOINT_JUMP_TOOL_NAMES.includes(name as (typeof CHECKPOINT_JUMP_TOOL_NAMES)[number])
          ? "jump"
          : typeof name !== "string" || !name
            || (update.type === "toolcall_start"
              && CHECKPOINT_JUMP_TOOL_NAMES.some((jumpName) => jumpName.startsWith(name)))
            ? "unknown"
            : "other";
      }
    }
    // Partial snapshots are not guaranteed to retain toolCall parts on every
    // update. Keep a recognized jump/name guard latched until a later update
    // resolves a different tool or the assistant message is finalized.
    if (state !== "none") {
      checkpointJumpCallInProgress = state === "jump";
      checkpointJumpNamePending = state === "unknown";
    }
    inspectStreamedCheckpointJump(
      observedToolName ?? observedToolCall?.name,
      observedToolCall?.arguments,
      rawUpdate.id ?? observedToolCall?.id,
      ctx,
    );
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
    // An empty assistant turn (provider error, or output clamped to nothing) is
    // not progress: it means the interruption could not be acted on.
    if (assistantMessageHasOutput(event.message)) noteAssistantProgress("assistant_output");
    for (const part of Array.isArray(event.message.content) ? event.message.content : []) {
      if (part?.type === "toolCall") {
        inspectStreamedCheckpointJump(part.name, part.arguments, part.id, ctx);
      }
    }
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
    noteAssistantProgress("tool_call");
    const before = pressureState();
    if (CHECKPOINT_JUMP_TOOL_NAMES.includes(event.toolName as (typeof CHECKPOINT_JUMP_TOOL_NAMES)[number])) {
      checkpointJumpCallInProgress = true;
      checkpointJumpNamePending = false;
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
    if (typeof readInput.path !== "string" || isImageReadPath(readInput.path, ctx.cwd)) return;
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
      const workspaceTokens = advisoryWorkspaceTokens(ctx);
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

  // Hard pressure means the agent owes a checkpoint jump and its payload must
  // still be produced. `hardFired` alone stays latched across an accepted jump
  // that is waiting for context usage to drop, so gate output-margin behavior on
  // the states that actually precede a forced-jump answer.
  const hardPressureActive = (): boolean =>
    !jumpPending && !postJumpTurnProtected && (hardFired || hardJumpPending || hardInterruptionPending);

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
    if (!postJumpTurnProtected && !hardPressureActive()) return;
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

    // pi reserves a fixed 4096-token output margin before every request. At the
    // hard threshold that reservation is pure loss: `retrievalWorkspaceTokens`
    // is already at zero, so the remaining context belongs to the forced-jump
    // answer — which runs with thinking disabled and therefore
    // needs only answer tokens. When pi's margin drives max_tokens negative it
    // clamps to 1, truncating the payload that is supposed to preserve the run.
    // Raise the cap so the jump answer gets `outputMarginFloorTokens` instead.
    if (config.outputMarginFloorTokens === null || !request || !hardPressureActive()) return;
    const usage = ctx.getContextUsage();
    const contextWindow = usage?.contextWindow ?? ctx.model?.maxTokens ?? 0;
    if (contextWindow <= 0) return;
    // The outgoing payload is the best estimate of input size for this request.
    const serializedInput = JSON.stringify(messageList.length > 0 ? messageList : request);
    const estimatedInputTokens = Math.max(usage?.tokens ?? 0, estimatePiTextTokens(serializedInput));
    // pi resolves max_tokens/max_completion_tokens internally from provider and
    // URL heuristics (getCompat), which this extension cannot observe; the field
    // name is therefore decided after the request is built, by patching whichever
    // cap the transport actually used.
    const candidateFields = ["max_tokens", "max_completion_tokens"] as const;
    const currentField = candidateFields.find((field) => typeof request[field] === "number"
      && Number.isFinite(request[field]));
    if (!currentField) return;
    const currentCap = request[currentField] as number;
    // pi's clamp: contextWindow - estimated input - CONTEXT_SAFETY_TOKENS(4096),
    // floored at 1. Give the jump answer `outputMarginFloorTokens` instead.
    const nextCap = Math.max(contextWindow - estimatedInputTokens - config.outputMarginFloorTokens, 256);
    if (currentCap >= nextCap) return;
    logInterceptor("hard_pressure_output_margin_raised", {
      model: ctx.model?.id ?? null,
      contextWindow,
      estimatedInputTokens,
      piMarginTokens: 4096,
      floorTokens: config.outputMarginFloorTokens,
      maxTokensField: currentField,
      previousMaxTokens: currentCap,
      nextMaxTokens: nextCap,
    });
    return { ...request, [currentField]: nextCap };
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
  pi.registerTool({
    ...readLoadoutOverride,
    name: "checkpoint_create", label: "Create checkpoint",
    description: "Creates a new checkpoint to which you can jump after doing work.",
    promptSnippet: "Create a checkpoint to which you can jump after doing work.",
    promptGuidelines: ["Always create a checkpoint before large reads, before series of bash commands, after initial clarification of your assignment (what does the user actually want me to do)."],
    parameters: createParams,
    execute: createCheckpoint,
  });

  const listParams = Type.Object({ limit: Type.Optional(Type.Number({ description: "Maximum checkpoints to show (default: 50)." })) });
  pi.registerTool({
    ...readLoadoutOverride,
    name: "checkpoint_list", label: "List available checkpoints",
    description: "List available checkpoints and IDs.",
    promptSnippet: "List available checkpoints, their IDs, workspace utilization at the time the checkpoint was created and workspace utilization delta from current state.",
    promptGuidelines: ["Chose a suitable jump target; balance freeing sufficient part of the workspace while retaining knowledge locked-in by secondary accumulation checkpoints. Do not automatically target the lowest utilization - be strategic."],
    parameters: listParams,
    async execute(_id, params: Static<typeof listParams>, _signal, _update, ctx) {
      const sm = manager(ctx);
      const limit = Math.max(1, Math.floor(params.limit ?? 50));
      const checkpoints = eligibleJumpCheckpoints(sm, workspaceUsedPercent(ctx)).slice(-limit);
      const lines = checkpoints.map(({ checkpoint, workspaceDelta }) =>
        formatCheckpointLabel(checkpoint, workspaceDelta));
      return textResult(lines.join("\n") || "(no checkpoints with sufficient workspace utilization difference)");
    },
  });

  // Shared parameter fragments so the headless contract can advertise the
  // jump without the interaction-only task_completed parameter.
  const jumpTargetParam = Type.Number({ multipleOf: 1, description: "Numeric checkpoint ID returned by checkpoint_create or shown by checkpoint_list; must always be the first parameter before payload." });
  const jumpPayloadParam = Type.String({ description: "Payload that meticulously preserves all relevant knowledge acquired since the target checkpoint and includes planned next steps." });
  const jumpParams = Type.Object({
    target: jumpTargetParam,
    payload: jumpPayloadParam,
    task_completed: Type.Optional(Type.Boolean({ description: "Use true only after you already reported task completion to the user." })),
  });
  const executeCheckpointJump = async (
    _id: string,
    params: { target: number; payload: string; task_completed?: boolean },
    _signal: AbortSignal | undefined,
    _update: ((update: any) => void) | undefined,
    ctx: ExtensionContext,
  ) => {
    const sm = manager(ctx);
    const target = resolveCheckpointId(sm, params.target);
    if (!target) return textResult(`Checkpoint #${params.target} was not found. Use checkpoint_list to inspect available checkpoints.`);
    // Keep hard-limit reasoning disabled until a target with enough workspace
    // distance has been accepted.
    if (!jumpTargetMeetsMinimumDistance(sm, params.target, ctx)) return invalidJumpTargetResult(ctx);
    // Validate before clearing hard-pressure flags so a rejected forced jump
    // keeps reasoning disabled until a suitable jump is accepted.
    const payloadError = jumpPayloadError(params.payload);
    if (payloadError) return textResult(payloadError);
    const jumpNotice = checkpointJumpNotice(sm, params.target);
    const leaf = sm.getLeafId();
    const autoResume = hardJumpPending || hardInterruptionCancelledForJump;
    if (leaf === target) {
      return textResult(params.target === 0 ? "Already at checkpoint." : `Already at checkpoint [${params.target}].`);
    }
    const headless = isHeadlessSession(sm);
    const taskCompleted = headless || autoResume ? false : (params.task_completed ?? false);
    jumpPending = true;
    cancelHardInterruptionForJump();
    if (headless) {
      // Do not terminate a headless session's prompt at the jump tool. The
      // parent runner treats termination as the end of the invocation and can
      // return an empty result before a deferred continuation is observed. The
      // tool result already carries the payload, so let the model finish
      // naturally.
      pendingJump = { target, checkpointId: params.target, payload: params.payload, taskCompleted: false, subagent: true, autoResume };
      return payloadResult(params.target === 0
        ? "Checkpoint jump is pending while this headless session completes; payload retained."
        : `Checkpoint jump to [${params.target}] is pending while this headless session completes; payload retained.`, params.payload);
    }
    pendingJump = { target, checkpointId: params.target, payload: params.payload, taskCompleted, subagent: false, autoResume };
    return {
      ...payloadResult(taskCompleted
        ? params.target === 0
          ? "Jump to checkpoint is pending after next user input."
          : `Jump to checkpoint [${params.target}] is pending after next user input.`
        : jumpNotice, params.payload),
      terminate: true,
    };
  };
  pi.registerTool({
    ...readLoadoutOverride,
    name: "checkpoint_jump", label: "Jump to checkpoint",
    description: "Jump to a checkpoint and continue with the supplied payload. The target id must always be the first parameter before payload.",
    promptSnippet: "Jump to a checkpoint after completing a unit of work; always include a relevant payload. Restores the workspace and conversation state to that of the target checkpoint.",
    promptGuidelines: ["Include relevant facts, decisions, completed actions, side effects, unresolved issues, and the next action in the payload."],
    parameters: jumpParams,
    renderCall(args, theme, context) { return renderJumpCall("checkpoint_jump", args, theme, context); },
    renderResult: renderJumpResult,
    execute: executeCheckpointJump,
  });
  // Headless sessions re-register the public tool names with the private
  // variant contracts: interaction-only parameters such as task_completed are
  // not advertised at all, and the post-jump continuation never waits for user
  // input that a spawned session cannot supply.
  function registerHeadlessToolContracts(): void {
    pi.registerTool({
      ...readLoadoutOverride,
      name: "checkpoint_create", label: "Create checkpoint",
      description: "Creates a new checkpoint to which you can jump after doing work.",
      promptSnippet: "Create a checkpoint to which you can jump after doing work.",
      promptGuidelines: ["Always create a checkpoint before large reads, before series of bash commands, after initial clarification of your assignment (what does the user actually want me to do)."],
      parameters: createParams,
      execute: createCheckpoint,
    });
    pi.registerTool({
      ...readLoadoutOverride,
      name: "checkpoint_jump", label: "Jump to checkpoint",
      description: "Jump to a numeric checkpoint and continue with the supplied payload. The target id must always be the first parameter before payload.",
      promptSnippet: "Jump to a checkpoint after completing a unit of work; always include a relevant payload.",
      parameters: Type.Object({
        target: Type.Number({ multipleOf: 1, description: "Numeric checkpoint ID returned by checkpoint_create." }),
        payload: jumpPayloadParam,
      }),
      renderCall(args, theme, context) { return renderJumpCall("checkpoint_jump", args, theme, context); },
      renderResult: renderJumpResult,
      execute: executeCheckpointJump,
    });
  }
  const outputIdParam = Type.Number({ minimum: 1, multipleOf: 1, description: "Tool output ID returned with a large output's first chunk." });
  const receiveFullParams = Type.Object({ id: outputIdParam });
  pi.registerTool({
    ...readLoadoutOverride,
    name: "output_receive_full", label: "Receive full tool output",
    description: "Accept the complete large output, assuming it fits in your available workspace.",
    parameters: receiveFullParams,
    renderCall(args, theme) { return renderReceiveCall("output_receive_full", args, theme); },
    renderResult: renderReceiveFullResult,
    async execute(_toolCallId, params: Static<typeof receiveFullParams>, _signal, _update, ctx) {
      const output = pendingToolOutputs.get(params.id);
      if (!output) return textResult(`Requested output ID ${params.id} was not found.`);
      const workspaceTokens = advisoryWorkspaceTokens(ctx);
      if (workspaceTokens === null) {
        return textResult(`Could not calculate available workspace for output ID ${params.id}. Jump to an earlier checkpoint before retrieving it.`);
      }
      if (output.estimatedTokens > workspaceTokens) {
        const recommendedPage = outputPageWithinBudget(output, params.id, 1, Math.max(0, workspaceTokens));
        if (!recommendedPage) {
          return textResult(`No complete lines from output ID ${params.id} fit in the available workspace. You must not make further attempts to read until you Jump to a previous checkpoint; then retrieve the output using 'output_receive_full' or 'output_receive_paginate'.`);
        }
        return textResult(`Full output was not accepted because it does not fit in the available workspace. Retrieve output ID ${params.id} using output_receive_paginate with offset 1 and limit ${recommendedPage.lineCount}.`);
      }
      return { content: output.content, details: withReceiveFullDetails(output.details, params.id, output.lineCount) };
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
    description: "Accept a page of large output using a line-based offset and optional limit. If limit is omitted, automatically choose a page size that fits the current workspace. Use successive offsets and checkpoint_jump to process large outputs incrementally.",
    parameters: receivePaginateParams,
    renderCall(args, theme) { return renderReceiveCall("output_receive_paginate", args, theme); },
    renderResult: renderReceivePageResult,
    async execute(_toolCallId, params: Static<typeof receivePaginateParams>, _signal, _update, ctx) {
      const output = pendingToolOutputs.get(params.id);
      if (!output) return textResult(`Requested output ID ${params.id} was not found.`);
      const offset = Math.max(1, Math.floor(params.offset));
      const workspaceTokens = advisoryWorkspaceTokens(ctx);
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
            return textResult(`No complete lines from output ID ${params.id} fit in the available workspace. You must not make further attempts to read until you Jump to a previous checkpoint; then retry this 'output_receive_paginate' call.`);
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
          return textResult(`No complete lines from output ID ${params.id} fit in the available workspace. You must not make further attempts to read until you Jump to a previous checkpoint; then retry this 'output_receive_paginate' call.`);
        }
        return textResult(`The requested page does not fit in available workspace. Option 1: Retry with ${recommendedPage.lineCount} line limit that currently fits; Option 2: Jump to a previous checkpoint; then retry this 'output_receive_paginate' call.`);
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

  // Replace Pi's built-in bash tool. The built-in returns only the last 2,000
  // lines / 50 KB and names a temp file for the rest; voluntary compaction
  // accepts the complete output and paginates it against the live workspace.
  pi.registerTool(createUnlimitedBashToolDefinition(process.cwd()));

  pi.on("agent_end", (_event, ctx) => {
    const request = pendingJump;
    pendingJump = null;
    if (!request) {
      // Fallback for streams that ended before a partial tool name could be
      // classified. Normal non-jump work was already interrupted immediately.
      checkpointJumpCallInProgress = false;
      checkpointJumpNamePending = false;
      if (jumpAppliedEarly) {
        // The payload was applied when queued input resumed this run; the branch
        // write, pressure bookkeeping and thinking restore already happened.
        jumpAppliedEarly = false;
        jumpPending = false;
      }
      if (hardInterruptionCancelledForJump) {
        hardInterruptionCancelledForJump = false;
        hardFired = false;
        evaluatePressure(ctx);
      }
      dispatchHardInterruption(ctx);
      const forcedInterruptions = [
        pendingForcedJumpInterruption,
        hardLimitFollowupPending ? pendingHardLimitFollowup : null,
      ].filter((text): text is string => typeof text === "string" && text.length > 0);
      pendingForcedJumpInterruption = null;
      if (hardLimitFollowupPending) {
        pendingHardLimitFollowup = null;
        hardLimitFollowupPending = false;
      }
      if (forcedInterruptions.length > 0) {
        const deliverAfterAbort = (): void => {
          if (!ctx.isIdle()) {
            setTimeout(deliverAfterAbort, 25);
            return;
          }
          for (const text of forcedInterruptions) {
            try {
              pi.sendUserMessage(text);
            } catch (error) {
              logInterceptor("forced_jump_followup_failed", { error: String(error) });
            }
          }
        };
        setTimeout(deliverAfterAbort, 0);
      }
      return;
    }

    // A completed jump is already the required compaction. Cancel any deferred
    // hard-limit request so it cannot trigger a duplicate jump after this branch.
    hardInterruptionPending = false;
    hardJumpPending = false;
    assistantBumpPending = false;
    if (hardLimitFollowupPending) {
      // The aborted stream produced the accepted jump, or its continuation
      // landed while the run settled; either way this branch already carries the
      // required compaction, so drop the queued hard-limit follow-up.
      pendingHardLimitFollowup = null;
      hardLimitFollowupPending = false;
      logInterceptor("hard_limit_followup_dropped_for_jump", pressureState());
    }

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
              pi.sendMessage({ customType: EXTENSION_TYPE, content: "checkpoint_jump completed and the payload is active. Resume the task from its next step now. When action is needed, use the registered tools through real tool calls; do not print tool-call/XML markup as text.", display: false }, { triggerTurn: true, deliverAs: "followUp" });
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
