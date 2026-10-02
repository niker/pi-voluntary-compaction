import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "@earendil-works/pi-ai";
import { config, DEFAULT_CONFIG, type Config } from "./config.js";
import {
  estimateReadFileTokens,
  readReadFileFull,
  readReadFilePage,
  resolveReadSourcePath,
  type ReadFileRange,
} from "./output-stream.js";

type PendingJump = { target: string; checkpointId: number; payload: string; taskCompleted: boolean; subagent: boolean; autoResume: boolean };
type PendingJumpOffer = { target: string; checkpointId: number; payload: string; allowed: boolean };
type BufferedToolOutput =
  | { kind: "memory"; content: any[]; details: unknown; estimatedTokens: number }
  | { kind: "file"; file: ReadFileRange; estimatedTokens: number };
const EXTENSION_TYPE = "pi-voluntary-compaction";
const CONFIG_ENTRY_TYPE = "pi-voluntary-compaction-config";
const CONFIG_FILE_KEY = "voluntaryCompaction";
// These tools are bookkeeping for this extension, not conversation content.
// Ignore their calls/results when choosing the latest meaningful checkpoint target.
const INTERNAL_TOOLS = new Set([
  "checkpoint_create", "subagent_checkpoint_create",
  "checkpoint_jump", "subagent_checkpoint_jump", "checkpoint_list",
]);
const PASSIVE_ENTRIES = new Set(["custom", "label", "session_info", "model_change", "thinking_level_change"]);
const manager = (ctx: ExtensionContext) => ctx.sessionManager as unknown as SessionManager;
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const payloadResult = (text: string, payload: string) => ({ content: [{ type: "text" as const, text }], details: { payload } });

function contentPartTokenEstimate(part: any): number {
  if (part?.type === "text" && typeof part.text === "string") return Math.ceil(Array.from(part.text).length / 4);
  return 0;
}

function estimateContentTokens(content: readonly any[]): number {
  return content.reduce((total, part) => total + contentPartTokenEstimate(part), 0);
}

function paginateContent(content: readonly any[], offset: number, take: number): any[] {
  const end = offset + take;
  const page: any[] = [];
  let cursor = 0;
  for (const part of content) {
    const partTokens = contentPartTokenEstimate(part);
    const partStart = cursor;
    const partEnd = cursor + partTokens;
    cursor = partEnd;
    if (!partTokens || end <= partStart || offset >= partEnd) continue;
    if (part.type !== "text" || typeof part.text !== "string") continue;
    const startToken = Math.max(0, offset - partStart);
    const endToken = Math.min(partTokens, end - partStart);
    const characters = Array.from(part.text);
    const startChar = Math.floor(startToken / partTokens * characters.length);
    const endChar = Math.floor(endToken / partTokens * characters.length);
    if (endChar > startChar) page.push({ ...part, text: characters.slice(startChar, endChar).join("") });
  }
  return page;
}

function renderJumpResult(result: any, { expanded }: { expanded: boolean }, theme: any): Text {
  const text = result.content?.find((part: any) => part.type === "text")?.text ?? "";
  const payload = result.details?.payload;
  const displayed = expanded && typeof payload === "string" && payload.length
    ? `${text}\n\n${theme.fg("muted", payload)}`
    : text;
  return new Text(displayed, 0, 0);
}

function usagePercent(ctx: ExtensionContext): number | null {
  const usage = ctx.getContextUsage();
  if (!usage) return null;
  if (typeof usage.percent === "number") return usage.percent;
  return usage.contextWindow > 0 && usage.tokens != null ? usage.tokens / usage.contextWindow * 100 : null;
}

const CHECKPOINT_ENTRY_TYPE = "pi-voluntary-compaction-checkpoint";

type CheckpointLabel = { id: number; name: string };
type CheckpointRecord = CheckpointLabel & { targetId: string };
type StoredCheckpoint = { checkpoint: CheckpointLabel; targetId: string };

function checkpointRecord(value: unknown): CheckpointRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<CheckpointRecord>;
  if (typeof record.id !== "number" || !Number.isInteger(record.id) || record.id < 1
    || typeof record.name !== "string" || !record.name.trim()
    || typeof record.targetId !== "string" || !record.targetId) return undefined;
  const id = record.id;
  const name = record.name;
  const targetId = record.targetId;
  return { id, name, targetId };
}

function persistedCheckpointEntries(sm: SessionManager): StoredCheckpoint[] {
  return sm.getEntries()
    .filter((entry): entry is SessionEntry & { type: "custom"; customType: string; data?: unknown } =>
      entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY_TYPE)
    .map((entry) => {
      const record = checkpointRecord(entry.data);
      return record ? { checkpoint: { id: record.id, name: record.name }, targetId: record.targetId } : undefined;
    })
    .filter((entry): entry is StoredCheckpoint => entry !== undefined);
}

function checkpointEntries(sm: SessionManager): StoredCheckpoint[] {
  return persistedCheckpointEntries(sm);
}

function nextCheckpointId(sm: SessionManager): number {
  return checkpointEntries(sm).reduce((max, item) => Math.max(max, item.checkpoint.id), 0) + 1;
}

function resolveCheckpointId(sm: SessionManager, id: number): string | undefined {
  const targetId = checkpointEntries(sm).find((item) => item.checkpoint.id === id)?.targetId;
  if (!targetId) return undefined;
  return sm.getEntry(targetId) ? targetId : undefined;
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
  "maxToolOutputTokens", "softThresholdPercent", "hardThresholdPercent", "softMessage",
  "hardReasoningMessage", "hardNonReasoningMessage", "instructions",
  "advertiseVoluntaryCompaction", "afterTaskCompaction",
];
type ConfigOverrides = Partial<Config>;

function validConfig(value: any): value is Config {
  if (!value || typeof value !== "object") return false;
  return Number.isInteger(value.maxToolOutputTokens)
    && value.maxToolOutputTokens >= 0
    && Number.isFinite(value.softThresholdPercent)
    && Number.isFinite(value.hardThresholdPercent)
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
    if (key === "maxToolOutputTokens") return Number.isInteger(item) && item >= 0;
    if (key === "advertiseVoluntaryCompaction") return typeof item === "boolean";
    if (key === "afterTaskCompaction") return item === "denied" || item === "allowed";
    if (key.endsWith("Message")) return typeof item === "string";
    return typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 100;
  });
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
    if (validOverrides(value)) return value;
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
    item.type === "custom" && item.customType === CONFIG_ENTRY_TYPE && validOverrides(item.data));
  return entry ? { ...(entry as any).data } : {};
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
  maxToolOutputTokens: "Agent is able to use tool output pagination above this estimated token count.",
  softThresholdPercent: "Soft warning threshold: when reached, the model receives an advisory to finish its current sub-task and preserve useful results in a checkpoint payload.",
  hardThresholdPercent: "Hard warning threshold: when context usage reaches this percentage, the model is urgently instructed to return to a checkpoint; reasoning models also receive a synthetic interruption.",
  softMessage: "Message sent to the model at the soft threshold. Use it to explain how the model should prepare before context becomes critical.",
  hardReasoningMessage: "Synthetic assistant message appended for reasoning models at the hard threshold to interrupt active reasoning and force checkpoint return.",
  hardNonReasoningMessage: "Urgent message sent to non-reasoning models at the hard threshold. It asks for immediate checkpoint return.",
  instructions: "Instructions appended to the system prompt. The package Markdown is used when this is set to the default (null); custom text replaces it.",
  advertiseVoluntaryCompaction: "Controls whether checkpoint and voluntary-compaction instructions are advertised in the system prompt. Pressure warnings and tools remain active when disabled.",
  afterTaskCompaction: "Default decision shown after the agent requests task compaction. Alt+C toggles it in the TUI; pi-web provides /jump and /nojump commands before the next message applies it.",
};

export default function (pi: ExtensionAPI): void {
  const pendingToolOutputs = new Map<number, BufferedToolOutput>();
  let nextToolOutputId = 1;
  let softFired = false;
  let hardFired = false;
  let hardJumpPending = false;
  let hardInterruptionPending = false;
  let assistantBumpPending = false;
  let hardThinkingPrevious: ReturnType<ExtensionAPI["getThinkingLevel"]> | null = null;
  const activeToolCalls = new Set<string>();
  let rebuildPending = false;
  let jumpPending = false;
  let pendingJump: PendingJump | null = null;
  let pendingJumpOffer: PendingJumpOffer | null = null;
  let removeTerminalInput: (() => void) | null = null;

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
    assistantBumpPending = false;
    restoreHardThinking();
  };

  const applyOfferedJump = (ctx: ExtensionContext): boolean => {
    const request = pendingJumpOffer;
    if (!request) return false;
    clearJumpOffer(ctx);
    try {
      manager(ctx).branchWithSummary(request.target, `(payload)\n${request.payload}`, undefined, true);
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
    if (!pendingJumpOffer || (event.source !== "interactive" && event.source !== "rpc") || !event.text.trim()) return;
    // The user's next message applies the selected decision. With the default
    // denied state this simply dismisses the offer; allowed branches first.
    if (pendingJumpOffer.allowed) applyOfferedJump(ctx);
    else clearJumpOffer(ctx);
  });

  if (!validConfig(config)) {
    throw new Error("pi-voluntary-compaction: max tool output must be a nonnegative integer; soft threshold must be below hard threshold and both must be between 0 and 100");
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
        ["maxToolOutputTokens", "Max tool output"],
        ["softThresholdPercent", "Soft threshold"],
        ["hardThresholdPercent", "Hard threshold"],
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

        if (key === "maxToolOutputTokens") {
          const value = await ctx.ui.editor(`Edit ${selected} (tokens)\n\n${description}`, String(edited.maxToolOutputTokens));
          if (value == null) continue;
          const number = Number(value);
          if (!Number.isInteger(number) || number < 0) {
            ctx.ui.notify("Max tool output must be a nonnegative integer token count.", "error");
          } else {
            edited.maxToolOutputTokens = number;
            editedKeys.add(key);
          }
        } else if (key === "softThresholdPercent" || key === "hardThresholdPercent") {
          const value = await ctx.ui.editor(`Edit ${selected}\n\n${description}`, String(edited[key]));
          if (value == null) continue;
          const number = Number(value);
          if (!Number.isFinite(number) || number < 0 || number > 100) {
            ctx.ui.notify("Thresholds must be numbers between 0 and 100.", "error");
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
        ctx.ui.notify("Settings were not saved: soft threshold must be below hard threshold.", "error");
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
    const checkpoints = checkpointEntries(manager(ctx))
      .sort((left, right) => left.checkpoint.id - right.checkpoint.id);
    if (!checkpoints.length) return "(no checkpoints)";
    return checkpoints.map(({ checkpoint }) => `[${checkpoint.id}]: ${checkpoint.name}`).join("\n");
  };

  const dispatchHardInterruption = (ctx: ExtensionContext): void => {
    if (!hardInterruptionPending) return;
    const message = `${ctx.model?.reasoning === true ? config.hardReasoningMessage : config.hardNonReasoningMessage}

Available checkpoints (use one of these IDs; do not call checkpoint_list):
${checkpointListForInterruption(ctx)}`;
    try {
      // Re-apply this immediately before queuing the follow-up. The runtime
      // can prepare the next turn after turn_end and overwrite the level that
      // was set while the tool result was being incorporated.
      // hardThinkingPrevious is retained so checkpoint completion still
      // restores the user's original level.
      pi.setThinkingLevel("off");
      // Hard pressure must interrupt the current model turn immediately. A
      // steer is delivered ahead of any further model reasoning, even when a
      // tool is still producing output; losing the tail of that output is
      // preferable to continuing into an unusable context. The idle case can
      // use followUp because there is no active turn to steer.
      pi.sendUserMessage(message, { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
      hardInterruptionPending = false;
    } catch {
      // A rejected message must not leave thinking disabled forever. The
      // threshold is re-armed so the next lifecycle event can retry it.
      hardFired = false;
      hardJumpPending = false;
      hardInterruptionPending = false;
      assistantBumpPending = false;
      restoreHardThinking();
    }
  };

  const evaluatePressure = (ctx: ExtensionContext) => {
    // Do not inject a pressure warning while a terminating checkpoint_jump
    // is waiting for agent_end to apply its payload.
    if (jumpPending) return;
    const percent = usagePercent(ctx);
    if (percent == null) return;
    // Each warning re-arms independently when usage falls below its threshold.
    // This matters after voluntary compaction: usage may fall below hard while
    // remaining above soft, and the next hard breach must still warn again.
    if (percent < config.softThresholdPercent) softFired = false;
    if (percent < config.hardThresholdPercent) {
      hardFired = false;
      assistantBumpPending = false;
    }
    if (percent < config.softThresholdPercent) return;
    if (percent >= config.hardThresholdPercent) {
      if (hardFired) return;
      try {
        // Reasoning can consume the remaining output budget while the agent
        // debates how to summarize. Preserve the user's level and disable it
        // until checkpoint_jump either completes or fails.
        if (hardThinkingPrevious === null) {
          hardThinkingPrevious = pi.getThinkingLevel();
          pi.setThinkingLevel("off");
        }
        // Arm the forced jump before dispatching. The hard interruption is
        // intentionally sent immediately; waiting for tool-result persistence
        // can allow critical context pressure to consume the remaining budget.
        hardJumpPending = true;
        hardInterruptionPending = true;
        hardFired = true;
        // Do not add a synthetic assistant message here. With an immediate
        // steer, that synthetic stop can make reasoning providers return an
        // empty assistant response instead of executing checkpoint_jump.
        // Do not wait for agent_settled: at the hard threshold the current
        // response/tool output may already be consuming the last safe context.
        dispatchHardInterruption(ctx);
        if (ctx.hasUI) ctx.ui.notify(`pi-voluntary-compaction: hard warning (${config.hardThresholdPercent}%)`, "error");
      } catch {
        hardFired = false;
        hardJumpPending = false;
        hardInterruptionPending = false;
        restoreHardThinking();
      }
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
    nextToolOutputId = 1;
    softFired = false;
    hardFired = false;
    hardJumpPending = false;
    hardInterruptionPending = false;
    assistantBumpPending = false;
    activeToolCalls.clear();
    restoreHardThinking();
    rebuildPending = false;
    jumpPending = false;
    pendingJump = null;
    clearJumpOffer(ctx);
    if (autoCompactionEnabled(ctx) && ctx.hasUI) {
      ctx.ui.notify("pi-voluntary-compaction replaces built-in auto-compact; disable auto-compact to avoid competing compaction flows.", "warning");
    }
    evaluatePressure(ctx);
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName.startsWith("output_receive_")
      || event.toolName.startsWith("checkpoint_")
      || event.toolName.startsWith("subagent_checkpoint_")) return;

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
        const estimatedTokens = await estimateReadFileTokens(file, ctx.signal);
        if (estimatedTokens <= config.maxToolOutputTokens) {
          return {
            content: [{ type: "text" as const, text: await readReadFileFull(file, ctx.signal) }],
            details: {},
          };
        }
        const id = nextToolOutputId++;
        pendingToolOutputs.set(id, { kind: "file", file, estimatedTokens });
        return {
          content: [{
            type: "text" as const,
            text: `Tool output ID ${id} was too large (~${estimatedTokens} tokens). Retrieve using 'output_receive_full' or 'output_receive_paginate'.`,
          }],
          details: {},
        };
      } catch {
        // If the source file cannot be reopened or streamed, leave Pi's original
        // truncated result intact rather than advertising an unusable output ID.
        return;
      }
    }

    const estimatedTokens = estimateContentTokens(event.content);
    if (estimatedTokens <= config.maxToolOutputTokens) return;
    const id = nextToolOutputId++;
    pendingToolOutputs.set(id, {
      kind: "memory",
      content: event.content.map((part: any) => part.type === "text" ? { ...part } : part),
      details: (event as any).details,
      estimatedTokens,
    });
    const notice = {
      type: "text" as const,
      text: `Tool output ID ${id} was too large (~${estimatedTokens} tokens). Retrieve using 'output_receive_full' or 'output_receive_paginate'.`,
    };
    // Keep related images intact and in context; only the oversized text is paginated.
    const content: any[] = [];
    let noticeInserted = false;
    for (const part of event.content) {
      if (part.type === "image") content.push(part);
      else if (!noticeInserted) {
        content.push(notice);
        noticeInserted = true;
      }
    }
    return { content, details: {} };
  });
  pi.on("turn_start", (_event, ctx) => evaluatePressure(ctx));
  pi.on("tool_execution_start", (event) => {
    activeToolCalls.add(event.toolCallId);
  });
  pi.on("tool_execution_end", (event) => {
    activeToolCalls.delete(event.toolCallId);
  });
  pi.on("agent_end", () => {
    // A cancelled tool may not emit tool_execution_end. The settled event
    // below is the synchronization point for the follow-up, so only release
    // the bookkeeping guard here.
    activeToolCalls.clear();
  });
  pi.on("agent_settled", () => {
    // Hard pressure is dispatched immediately by evaluatePressure. Keep this
    // lifecycle hook only for defensive tool bookkeeping; it must not delay
    // the interruption until the agent is settled.
    activeToolCalls.clear();
  });
  pi.on("turn_end", (_event, ctx) => {
    // If a tool delayed the hard interruption, preserve the synthetic bump
    // for the follow-up request that is about to be queued. Otherwise it is
    // only relevant to this request.
    if (!hardInterruptionPending) assistantBumpPending = false;
    // Usage can cross a threshold during a long turn; checking only at
    // turn_start would postpone the warning until after another turn.
    evaluatePressure(ctx);
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

  const createParams = Type.Object({
    name: Type.String({ description: "Descriptive checkpoint name; it does not need to be unique." }),
  });
  const createCheckpoint = async (_id: string, params: Static<typeof createParams>, _signal: AbortSignal, _update: (update: any) => void, ctx: ExtensionContext) => {
    const name = params.name.trim();
    if (!name) return textResult("Checkpoint name cannot be empty.");
    const sm = manager(ctx);
    const targetId = latestMeaningfulNode(sm);
    if (!targetId) return textResult("No history node is available for a checkpoint.");
    const checkpointId = nextCheckpointId(sm);
    const record: CheckpointRecord = { id: checkpointId, name, targetId };
    pi.appendEntry(CHECKPOINT_ENTRY_TYPE, record);
    return textResult(`[${checkpointId}]: ${name}`);
  };
  for (const [name, label] of [["checkpoint_create", "Create checkpoint"], ["subagent_checkpoint_create", "Create subagent checkpoint"]] as const) {
    pi.registerTool({
      name, label,
      description: "Mark a point so you can return to it later and return its numeric ID and label.",
      promptSnippet: "Create a checkpoint before any substantive external action.",
      promptGuidelines: ["Create a checkpoint before reading, searching, downloading, or otherwise advancing the task."],
      parameters: createParams,
      execute: createCheckpoint,
    });
  }

  const listParams = Type.Object({ limit: Type.Optional(Type.Number({ description: "Maximum checkpoints to show (default: 50)." })) });
  pi.registerTool({
    name: "checkpoint_list", label: "List checkpoint history",
    description: "List available checkpoints and their numeric IDs.",
    promptSnippet: "List checkpoint IDs and names before choosing a return target.",
    parameters: listParams,
    async execute(_id, params: Static<typeof listParams>, _signal, _update, ctx) {
      const sm = manager(ctx);
      const limit = Math.max(1, Math.floor(params.limit ?? 50));
      const checkpoints = checkpointEntries(sm)
        .sort((left, right) => left.checkpoint.id - right.checkpoint.id)
        .slice(-limit);
      const lines = checkpoints.map(({ checkpoint }) => `[${checkpoint.id}]: ${checkpoint.name}`);
      return textResult(lines.join("\n") || "(no checkpoints)");
    },
  });

  const jumpParams = Type.Object({
    target: Type.Number({ minimum: 1, multipleOf: 1, description: "Numeric checkpoint ID returned by checkpoint_create or shown by checkpoint_list." }),
    payload: Type.String({ description: "Relevant facts, decisions, completed actions, side effects, unresolved issues, and next action learned since the target checkpoint." }),
    task_completed: Type.Optional(Type.Boolean({ description: "When true, stop after the jump and wait for user input instead of starting another turn." })),
  });
  const subagentJumpParams = Type.Object({
    target: Type.Number({ minimum: 1, multipleOf: 1, description: "Numeric checkpoint ID returned by subagent_checkpoint_create." }),
    payload: Type.String({ description: "Relevant facts, decisions, completed actions, side effects, unresolved issues, and next action learned since the target checkpoint." }),
  });
  pi.registerTool({
    name: "checkpoint_jump", label: "Jump to checkpoint",
    description: "Jump to a numeric checkpoint and continue with the supplied payload.",
    promptSnippet: "Jump to a checkpoint after completing a substantive unit of work; include all relevant results in the payload.",
    promptGuidelines: ["Include relevant facts, decisions, completed actions, side effects, unresolved issues, and the next action in the payload."],
    parameters: jumpParams,
    renderResult: renderJumpResult,
    async execute(_id, params: Static<typeof jumpParams>, _signal, _update, ctx) {
      const sm = manager(ctx);
      const target = resolveCheckpointId(sm, params.target);
      if (!target) return textResult(`Checkpoint #${params.target} was not found. Use checkpoint_list to inspect available checkpoints.`);
      const leaf = sm.getLeafId();
      const autoResume = hardJumpPending;
      if (leaf === target) {
        if (autoResume) {
          hardJumpPending = false;
          hardInterruptionPending = false;
          assistantBumpPending = false;
          restoreHardThinking();
        }
        return textResult(`Already at checkpoint [${params.target}].`);
      }
      hardJumpPending = false;
      hardInterruptionPending = false;
      const taskCompleted = autoResume ? false : (params.task_completed ?? false);
      jumpPending = true;
      pendingJump = { target, checkpointId: params.target, payload: params.payload, taskCompleted, subagent: false, autoResume };
      return {
        ...payloadResult(taskCompleted
          ? `Jump to checkpoint [${params.target}] is pending after next user input.`
          : `Jump to checkpoint [${params.target}] and continue from the payload.`, params.payload),
        terminate: true,
      };
    },
  });
  const outputIdParam = Type.Number({ minimum: 1, multipleOf: 1, description: "Tool output ID returned by the tool-result pagination notice." });
  const receiveFullParams = Type.Object({ id: outputIdParam });
  pi.registerTool({
    name: "output_receive_full", label: "Receive full tool output",
    description: "Retrieve the complete oversized tool output when you accept its size above the configured safe limit. Output does not persist between sessions.",
    parameters: receiveFullParams,
    async execute(_toolCallId, params: Static<typeof receiveFullParams>, signal) {
      const output = pendingToolOutputs.get(params.id);
      if (!output) return textResult(`Requested output ID ${params.id} was not found.`);
      if (output.kind === "memory") return { content: output.content, details: output.details };
      try {
        const text = await readReadFileFull(output.file, signal);
        return { content: [{ type: "text" as const, text }], details: {} };
      } catch (error) {
        return textResult(`Could not retrieve output ID ${params.id} from its source file: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  const receivePaginateParams = Type.Object({
    id: outputIdParam,
    take: Type.Number({ minimum: 1, multipleOf: 1, description: "Maximum estimated text-token count to retrieve in this chunk. Images are kept intact in the original result and are not paginated." }),
    offset: Type.Number({ minimum: 0, multipleOf: 1, description: "Estimated text-token offset from the beginning of the output." }),
  });
  pi.registerTool({
    name: "output_receive_paginate", label: "Paginate tool output",
    description: "Retrieve a chunk of oversized tool text using an estimated-token offset and size. Images remain intact in the original result and are not paginated. Use successive offsets and checkpoint_jump to process large outputs incrementally. Output does not persist between sessions.",
    parameters: receivePaginateParams,
    async execute(_toolCallId, params: Static<typeof receivePaginateParams>, signal) {
      const output = pendingToolOutputs.get(params.id);
      if (!output) return textResult(`Requested output ID ${params.id} was not found.`);
      const offset = Math.min(params.offset, output.estimatedTokens);
      const take = Math.min(params.take, output.estimatedTokens - offset);
      try {
        const content = output.kind === "memory"
          ? paginateContent(output.content, offset, take)
          : [{ type: "text" as const, text: await readReadFilePage(output.file, offset, take, signal) }];
        return {
          content,
          details: {
            outputId: params.id,
            offset,
            take,
            totalEstimatedTokens: output.estimatedTokens,
            nextOffset: offset + take,
          },
        };
      } catch (error) {
        return textResult(`Could not retrieve output ID ${params.id} from its source file: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  pi.registerTool({
    name: "subagent_checkpoint_jump", label: "Jump to checkpoint as subagent",
    description: "Jump to a numeric checkpoint and continue with the supplied payload as a subagent.",
    promptSnippet: "Jump to a checkpoint with a complete payload after completing a substantive unit of work.",
    promptGuidelines: ["Trust the payload and continue the task without reconstructing omitted work."],
    parameters: subagentJumpParams,
    renderResult: renderJumpResult,
    async execute(_id, params: Static<typeof subagentJumpParams>, _signal, _update, ctx) {
      const sm = manager(ctx);
      const target = resolveCheckpointId(sm, params.target);
      if (!target) return textResult(`Checkpoint #${params.target} was not found. Use checkpoint_list to inspect available checkpoints.`);
      if (sm.getLeafId() === target) return textResult(`Already at checkpoint [${params.target}].`);
      jumpPending = true;
      // Do not terminate a subagent's prompt at the jump tool. The parent
      // runner treats termination as the end of the invocation and can return
      // an empty result before a deferred continuation is observed. The tool
      // result already carries the payload, so let the model finish naturally.
      pendingJump = { target, checkpointId: params.target, payload: params.payload, taskCompleted: false, subagent: true, autoResume: false };
      return payloadResult(`Jump to checkpoint [${params.target}] and continue from the payload.`, params.payload);
    },
  });

  pi.on("agent_end", (_event, ctx) => {
    const request = pendingJump;
    pendingJump = null;
    if (!request) return;

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
          sm.branchWithSummary(request.target, `(payload)\n${request.payload}`, undefined, true);
          markCompactionComplete();
          if ((!request.taskCompleted || request.autoResume) && !request.subagent) {
            // Start only after the branch write and agent_end cleanup have settled.
            // This avoids losing the trigger when the runtime is still completing
            // the terminating turn that contained checkpoint_jump.
            setTimeout(() => {
              pi.sendMessage({ customType: EXTENSION_TYPE, content: "checkpoint_jump complete. Continue from the payload and execute its next step.", display: false }, { triggerTurn: true, deliverAs: "followUp" });
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
      }
    }, 0);
  });
}
