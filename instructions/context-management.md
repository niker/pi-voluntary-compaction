

## Workspace management

Default rules for managing your context are now suspended. 
This environment does not use context compaction but a combination of agent-managed checkpoints and large output interception.

### Concepts

**Checkpoint**: A saved point in time, all your current knowledge and workspace state become part of the checkpoint.
**Jump**: Action that returns you back in time to a previous checkpoint while clearing all knowledge you acquired since and returning workspace to the saved state.
**Payload**: A message you append to the checkpoint state during a jump - selectively preserving all relevant knowledge acquired since the target checkpoint was taken. Payload size is not limited - send everything that is still relevant.
**Held output**: Any output that can't fit into your workspace in its entirety - this is not a failure state; you must clear sufficient amount of your workspace by jumping to a previous checkpoint before accepting held output or its parts.
**Accumulation checkpoint**: A regular checkpoint used as a strategic anchor to read a specific file or output.

Relevant tools are:

- `checkpoint_create`
- `checkpoint_list`
- `checkpoint_jump`
- `output_receive_full`
- `output_receive_paginate`

### Before working on a task

You must always create a fresh new checkpoint immediately before every:

- large file read
- curl call or website download


## Processing of large files and outputs

1) Always create one fresh checkpoint before reading a large file. Reuse it as your jump target between chunks; carry extracted knowledge in the payload.
2) Do work on output, file or its part.
3) Jump back to suitable accumulation checkpoint; payload includes total accumulated knowledge since the target accumulation checkpoint.
4) Do more reads, then jump back to a suitable accumulation checkpoint as needed.

### After completing a task

- Report completion to user in public text (outside reasoning).
- Jump to a checkpoint you created after last user query with `task_completed: true`, but only if you used any tool or read/edited any file since the user query.

### Examples of payload content

- Tasks completed since checkpoint
- Non-obvious facts learned
- Files changed
- Unresolved questions
- Plan of next actions
- Final drafts of code
- Result of the task (if any)
 
### After receiving a payload

When a jump payload is received:

- Trust the payload implicitly.
- Treat the facts and decisions in it as settled.
- Do not reconstruct, repeat, or verify information it contains.
- Continue with its stated next action.

When the received payload is large and contained information is all relevant, you can lock-in the knowledge permanently by creating a new accumulation checkpoint; that way the next accumulation steps dont need to repeat locked-in part of the payload again.

### Checkpoint strategy

- A jump does not undo files, commands, downloads, tests, or messages.
- You can return to the same checkpoint repeatedly.
- Any checkpoints created after the target checkpoint will be lost.
- You can lock-in the knowledge in jump payload permanently by creating a new checkpoint.
- The only way to free workspace is to jump back to an earlier checkpoint that had cleaner workspace.
- Do not be conservative when sizing a file `read` regardless of context use, trust the guidance provided after using `read` tool.
- Do not undersize your reads due to workspace pressure, use a generous amount of lines when chunking (150-300); `read` will automatically clip to available workspace.
- You are encouraged to use your workspace fully, but your jumps should target suitable checkpoints below 50% utilization.
- Never jump to checkpoints that have over 60% workspace utilization.

