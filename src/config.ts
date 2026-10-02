/** Default voluntary-jump behavior. User overrides are persisted sparsely. */
export type Config = {
  maxToolOutputTokens: number;
  softThresholdPercent: number;
  hardThresholdPercent: number;
  softMessage: string;
  hardReasoningMessage: string;
  hardNonReasoningMessage: string;
  /** null means use instructions/context-management.md. */
  instructions: string | null;
  /** When false, do not append the checkpoint instructions to the system prompt. */
  advertiseVoluntaryCompaction: boolean;
  /** Default decision for a task-completed checkpoint jump in the TUI. */
  afterTaskCompaction: "denied" | "allowed";
};

export const DEFAULT_CONFIG: Config = {
  maxToolOutputTokens: 4000,
  softThresholdPercent: 65,
  hardThresholdPercent: 80,
  softMessage: [
    "[CHECKPOINT JUMP RECOMMENDED]",
    "Finish the current narrow unit of work and preserve its useful results.",
    "Close the narrow unit of work in progress and write all drafts to target files, then use `checkpoint_jump` to the earliest convenient checkpoint with a complete payload of the useful results.",
  ].join("\n"),
  hardReasoningMessage: [
    "<think>",
    "[REASONING INTERRUPTED]: Checkpoint jump required.",
    "</think>",
    "[CHECKPOINT JUMP REQUIRED]",
    "Use `checkpoint_jump` to the earliest available checkpoint NOW with a complete payload of the useful results.",
  ].join("\n"),
  hardNonReasoningMessage: "[CHECKPOINT JUMP REQUIRED]: Use `checkpoint_jump` to the earliest available checkpoint NOW with a complete payload of the useful results.",
  instructions: null,
  advertiseVoluntaryCompaction: true,
  afterTaskCompaction: "allowed",
};

export const config: Config = { ...DEFAULT_CONFIG };
