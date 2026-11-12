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
  /**
   * Buffer that a forced jump payload must fit in when no reasoning is emitted:
   * this margin plus the forced-jump output floor (`outputMarginFloorTokens`, or
   * pi's fixed 4096-token margin when that key is null). It defines the emergency
   * zone — usage at or above `contextWindow - buffer` leaves only this much real
   * room for the jump, so past it every extra token rapidly lowers the chance the
   * payload lands. Inside the zone an open write/edit batch stops being deferred
   * (the committed call still reaches disk) and thinking is forced off in favour
   * of the reasoning-model notice: an ongoing write and thinking before a jump
   * put it in jeopardy the same way, so both get the same answer. Unlike every
   * other threshold this one is measured from the context window ceiling, not
   * from the hard percent. Default 3000. Range: 0-32768.
   */
  emergencyWriteMargin: number;
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
  emergencyWriteMargin: 3000,
};

export const config: Config = { ...DEFAULT_CONFIG };
