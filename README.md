# pi-voluntary-compaction - Agent-driven context management for Pi.

## TL;DR - How does this work, is it yet another compaction plugin?

No. With VC installed compaction is never ever used again.

Do you remember the cliché TV episode where the hero time-loops one day over and over? No matter what he does, he wakes up on the same morning over and over and he's the only one who remembers what happened before.

This is basically how this plugin works, except the agent can drop anchors throughout the day and jump back in time to any of the anchors, with a bag that carries any thing or information needed to get the job done.


## TL;DR - My handoff files better

While a handoff to a new session may seem like a good idea, you are handing a documentation from an experienced senior to a fresh junior every time you do it.

VC does not erase the conversation completely, only the parts the agent deems not important any more - and even so - any relevant parts of any size may be extracted by the agent and carried over.

Plus it's fully transparent and automatic (no meat proxy), the agent decides what and when is important.


> **Before using VC:** turn off Pi's automatic compaction. VC manages the conversation instead. No compaction should ever run.


## How it works

### 1. Go back in time

The agent creates a checkpoint (a save point) before a large piece of work. It does the work, notes what it learned and what needs to happen next, then goes back to that save point. The messages in between are removed from the active conversation, but the agent carries its notes forward and continues from there.

It doesn't need to keep every message. It needs to remember the things that matter for the next steps.

### 2. Handle large files and command results

A file or command can produce far more text than the agent can comfortably read at once. VC keeps the full result available during the session and lets the agent read it in smaller parts, when needed. This means the agent can work through very large inputs without filling its conversation with all of them at once.

For example a bash command, that can't be run again safely, returns 5MB of data. With VC the agent can safely read all of it, even if the file is 4x larger than the context window. This is done by employing the accumulation checkpoint strategy - the extension automatically offers pagination of large outputs, agent can read in smaller chunks and jump back to the accumulation checkpoint with distilled information. This is repeated over and over until the output is exhausted. After the last jump the real context cost of reading the entire output may be just a single-digit percentage of context.

I used a benchmark to test processing of large outputs in comparison to regular compaction:

See the [RC vs. VC benchmark](./rc-vc-bench.md) for a comparison on a large-book research task. The results are specific to the tested model and task; results may differ with other models and workloads.

### 3. Work closer to the context limit

VC is designed to use more of the available context instead of keeping a large part of it free for regular compaction.

The default settings are:

| Setting | Default |
| --- | ---: |
| Soft limit — a good time to make a checkpoint jump | 75% |
| Hard limit — the agent must make a jump | 85% |
| Reasoning buffer | 2.5% |
| Large tool output limit before it is force paginated | 8,000 estimated tokens |
| Minimum distance between checkpoint jumps | 7.5% |
| Emergency write margin | 3,000 tokens |

**Soft limit** is only advisory, agent is informed it should wrap up any ongoing task and jump.
**Hard limit** interrupts the agent unless it is actively writing, editing or jumping, but gives it a chance to reason before the jump.
The **emergency zone** is the minimum amount of tokens required for a safe jump, any reasoning or write/edit is interrupted and the agent is forced to jump without reasoning.

A successful jump has been observed at **94% use** of 72k context.
In contrast regular compaction can sometimes fail (or worse - silently truncate) even at just 80% utilization.

### 4. Multi-day workload stability on small models

Long-horizon tasks are extected to be 20-60% faster with VC.
Context rot is not an issue, agent can forget wrong assumptions autonomously.
Intelligence over long horizons improves; on every jump the agent gets fresh eyes on the problem, like partial handoffs without a complete amnesia.

Example: a long-running reverse-engineering session on Qwen.

![Long-running reverse-engineering session showing token usage and context utilization](https://github.com/user-attachments/assets/ebeb4982-a8ea-4038-a79f-918742010c32)


## Tools the agent can use

- `checkpoint_create` — save a point to return to.
- `checkpoint_list` — see the available save points.
- `checkpoint_jump` — go back to a save point and continue with a handover.
- `output_receive_full` — read a saved result in full, when it fits.
- `output_receive_paginate` — read part of a saved result.

## Configuration

You can change the limits, output size, safety margins and agent instructions globally, per project or per session in the Pi TUI. The defaults are tuned around Qwen 3.8-family models and GPT Luna; other models may need different settings.

## Installation

```sh
pi install npm:pi-voluntary-compaction
```

VC also supports `pi-subagents` and the `pi-web.dev` GUI.

## Feedback

If you find a weird behavior, feel free to drop me an issue on github.
Any interesting behavior you come across - let me know too; this is as much an ongoing research effort as it is an extension.
Just love the extension? Star the repo and spread the word!

