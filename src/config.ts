/** Default voluntary-jump behavior. User overrides are persisted sparsely. */
export type Config = {
  softThresholdPercent: number;
  hardThresholdPercent: number;
  /** Reasoning reserve applied to retrieval/read sizing hints. */
  workspaceReasoningBufferPercent: number;
  maxToolOutputTokens: number;
  minimumJumpDistance: number;
  softMessage: string;
  hardReasoningMessage: string;
  hardNonReasoningMessage: string;
  /** null means use instructions/context-management.md. */
  instructions: string | null;
  /** When false, do not append the checkpoint instructions to the system prompt. */
  advertiseVoluntaryCompaction: boolean;
  /** Default decision for a task-completed checkpoint jump in the TUI. */
  afterTaskCompaction: "denied" | "allowed";
  /**
   * Output tokens guaranteed to the forced-jump answer once retrieval workspace
   * is exhausted at the hard threshold, replacing pi's fixed 4096-token output
   * margin. Default 256: tool-output interception already bounds oversized
   * results, so only a safety sliver is needed for extreme cases. null keeps
   * pi's behavior. Range: 256-8192.
   */
  outputMarginFloorTokens: number | null;
};

export const DEFAULT_CONFIG: Config = {
  softThresholdPercent: 75,
  hardThresholdPercent: 85,
  workspaceReasoningBufferPercent: 2.5,
  maxToolOutputTokens: 8000,
  minimumJumpDistance: 7.5,
  softMessage: [
    "[CHECKPOINT JUMP RECOMMENDED]",
    "Finish the current narrow unit of work and write all drafts to target files, then use `checkpoint_jump` to earliest convenient checkpoint with a complete payload.",
  ].join("\n"),
  hardReasoningMessage: [
    "<think>",
    "Checkpoint jump required.",
    "</think>",
    "[CHECKPOINT JUMP REQUIRED]",
    "Use `checkpoint_jump` to the earliest suitable checkpoint NOW with a complete payload.",
  ].join("\n"),
  hardNonReasoningMessage: "[CHECKPOINT JUMP REQUIRED]: Use `checkpoint_jump` to earliest suitable checkpoint NOW with a complete payload.",
  instructions: null,
  advertiseVoluntaryCompaction: true,
  afterTaskCompaction: "allowed",
  outputMarginFloorTokens: 256,
};

export const config: Config = { ...DEFAULT_CONFIG };
