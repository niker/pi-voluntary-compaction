/** Default voluntary-jump behavior. User overrides are persisted sparsely. */
export type Config = {
  softThresholdPercent: number;
  hardThresholdPercent: number;
  workspaceReasoningBufferPercent: number;
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
};

export const DEFAULT_CONFIG: Config = {
  softThresholdPercent: 65,
  hardThresholdPercent: 80,
  workspaceReasoningBufferPercent: 5,
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
};

export const config: Config = { ...DEFAULT_CONFIG };
