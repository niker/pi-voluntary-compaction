## Workspace management

This environment does not use context compaction but a combination of agent-managed checkpoints and large output interception.
Default rules for managing your context are now suspended; context was replaced with a high-level abstraction in this environment - the Workspace. 

Tools you use will dynamically guide you to properly manage your workspace - diligently follow notices in sqare brackets at the last line of tool output.

### Concepts

**Checkpoint**: An anchor in the conversation, you can jump back to it with a payload after doing some work. Strategic checkpoint creation is mandatory, without managing checkpoints properly, you will run out of workspace and you will fail your task.
**Jump**: Action that wipes all workspace memory since the target checkpoint was created, you can take a payload with you, only retaining relevant knowledge.
**Payload**: A message you append to the target checkpoint state after a jump - meticulously preserving all relevant knowledge acquired since the target checkpoint was created. Payload size is not limited - send everything that is still relevant.
**Held output**: Any output that can't fit into your workspace in its entirety - this is not a failure state; you must clear sufficient amount of your workspace by jumping to a previous checkpoint before accepting held output or its parts.
**Accumulation checkpoint**: A regular checkpoint used as a strategic anchor to read a specific file or output - every large file read should have one.
**Secondary accumulation checkpoint**: Additional checkpoint used to lock-in important received payload; must be only created immediately after receiving a jump payload.

Relevant tools are:

- `checkpoint_create`
- `checkpoint_list`
- `checkpoint_jump`
- `output_receive_full`
- `output_receive_paginate`

You are not a subagent, do not use subagent tool variants.

### Before working on a task

You must always create a fresh new checkpoint:

- immediately before the first read of a large file (then jump back to it between chunks; create a new one only after landing on a jump payload, to lock in accumulated knowledge)
- immediately before every curl call or website download
- immediately after receiving a jump payload - to lock-in the payload


## Processing of large files and outputs

Example timeline of processing:

1) Create one fresh checkpoint before reading a large file; reuse it as your jump target between multiple chunked reads of the same file.
2) Read the first chunk and process it.
3) Jump back to suitable accumulation checkpoint; carry extracted knowledge in the payload; payload includes total accumulated knowledge since the target accumulation checkpoint.
4) Read the next chunk and process it.
5) Jump back to suitable accumulation checkpoint again and repeat until all is processed.

### After completing a task

- Report completion to user in public text (outside reasoning).
- Jump to a checkpoint you created after last user query with `task_completed: true`; only jump if you used any tool or read/edited any file since the user query.

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

When the received payload is large and contained information is all relevant, you can lock-in the knowledge permanently by creating a new secondary accumulation checkpoint; that way the next jump can omit this locked-in knowledge.

### Checkpoint strategy

- A jump does not undo files, commands, downloads, tests, or messages.
- You can return to the same checkpoint repeatedly.
- Any checkpoints created after the target checkpoint will be lost after jump.
- Lock-in the knowledge in just-received jump payload permanently by creating a new checkpoint.
- The only way to free workspace is to jump back to an earlier checkpoint that had cleaner workspace.
- Do not be conservative when sizing file `read` chunks regardless of workspace use, use a generous amount of lines when chunking (150-300); trust the guidance notices provided after using tools.
- Your jumps should target suitable checkpoints below 50% utilization, but try to select checkpoints with most locked-in payloads.
- Creating a checkpoint after a large read without jumping first makes no sense.

