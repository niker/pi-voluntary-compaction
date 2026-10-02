# pi-voluntary-compaction

## Architecture

This PI extesion operates as a harness-level agent-controlled garbage-collection mechanism.

This allows even small and medium models to perform long-running complex tasks on huge amounts of data with `zero context rot`, `no classic compaction` and using relatively `small context length`.


Context **auto-compaction must be disabled** in settings for this extension to work correctly.

It relies on two primary mechanics:

### 1. Voluntary checkpointing and time-jumps

Imagine the usual compaction as a lobotomy performed by third party. 
Voluntary compaction lets the agent decide what is important and gives the agent time to outline a detailed plan for future self. 
The jump payload is not limited in size when done voluntarily.
When the agent reaches a hard threshold of 80% context (configurable), the extension forces the agent to act immediately and jump with payload size up to 20% of context window.

The strategy to prevent cumulative context degradation across multi-stage tasks:

1. The agent establishes state anchor checkpoints (`checkpoint_create`) before initiating a potentially context-heavy operation.
2. Then executes tool calls, reads, performs complex reasoning or noisy shell commands.
3. Upon task completion or a milestone, the agent decides what information is still relevant or needed to complete the task and prepares a minimal payload that it sends itself into the past via `checkpoint_jump`.
4. The harness prunes all conversation between the checkpoint and current state, then hands the payload back to the agent to continue work.
5a. The agent resumes work with all the necessary context and a plan. At worst it needs to re-read some files before edits.
5b. If the agent jumped with information that the task is completed, control is given back to the user and waits for input. The user is presented with an option to `deny` the jump and continue the conversation without compaction - this is good for many simple low-latency tasks but not strictly necessary as the payload usually carries enough information to perform repeated tasks seamlessly. 
   
This strategy maintains optimal attention performance and low context utilization without losing high-level task focus.


### 2. Tool Output Interception

This layer effectively prevents the model from choking itself on massive console output or website and allows it to seamlessly read files beyond the usual 2000-line/50kb limit of PI.

When any agent tool returns an oversized output (messy bash output, huge text files), the harness intercepts the payload before it enters the model's context. The raw text is held in-memory or streamed from the source file, only metadata containing approximate token size and a handle to the output are sent to the agent. 
The model then decides whether to brute-force the output via `output_receive_full` or processes it by smaller chunks using pagination (`output_receive_paginate`).


## Agent tools

### Checkpointing

- `checkpoint_create` — create a checkpoint with arbitrary name and receive its numeric ID.
- `checkpoint_list` — list checkpoint IDs and names in the form `[1]: Checkpoint name`.
- `checkpoint_jump` — jump to a checkpoint with a payload and continue. Set `task_completed: true` to stop and wait for user input. In interactive TUI mode this leaves a decision line above the editor; **Alt+C** toggles whether the jump is applied when the next message arrives. In pi-web sessions, use `/jump` or `/nojump` before the next real message to choose the pending decision; omitting either command keeps the configured default.


### Subagents

Subagents and headless agents must use this variant, that has stripped user-facing interaction, regular tools will return to main agent on jump.

- `subagent_checkpoint_create` — checkpoint creation tool for subagents.
- `subagent_checkpoint_jump` — jump tool for subagents.


### Tool output

Large tool outputs receive numerical IDs and are session-bound.
- `output_receive_full` - retrieves the complete output by `id` regardless of size
- `output_receive_paginate` - allows agent to process output by `id` in smaller chunks with `take`, and `offset`.

Agents can freely create a checkpoint between a tool call and output_receive, but buffered output data is lost when session exits - output processing can't be resumed in-flight.


## Configuration

You can configure pretty much everything important:
- soft/hard context utilization limits
- soft/hard limit messages that steer the agent
- max tool output size that is not intercepted
- built-in injected system prompt that teaches agent voluntary compaction
- default jump allow/deny after task completion
- outright disable any context injection

All settings can be set globally or for project or session in TUI.

The defaults are currently fine-tuned for `Qwen 3.8` family of models and `GPT Luna`. Should work out of the box for better models. Might need some fine-tuning for weaker models. 

My current favorite is `swift-1.5-qwen3.8-27b-gsq-rco @ IQ3-S; 72k context, K:Q8, V:IQ4_NL, MTP 0-2 @ 0.33`, running AMD 9070XT with 16GB VRAM, 700-900tps prefill, 45-65tps gen. 


## Interoperability

The extension supports `pi-subagents` extension and `pi-web.dev` GUI.

## Installation

Install with:

```sh
pi install npm:pi-voluntary-compaction
```

