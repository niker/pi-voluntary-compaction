# Case Study: Reverse-Engineering Hell-Copter with Voluntary Compaction

## Overview

This case study documents a sustained reverse-engineering effort in which a local language model was tasked with restoring a late-1990s Windows game, Hell-Copter, to a playable state on Linux.

The work was performed in Pi using **Swift 1.5 IQ3_S**, a quantized Qwen 3.8 Flash Next
&#x20;model fine-tune, with a 72K context window. The local machine had an AMD Radeon RX 9070 XT with 16 GB VRAM and 64 GB system RAM.

The objective was considerably more involved than getting an executable to start. The game had to run with real hardware-accelerated 3D rendering, accept keyboard and mouse input correctly, render its world and textures, and be delivered with a reliable launcher and technical documentation.

The project eventually involved binary analysis, DirectInput and Wine compatibility work, graphics API tracing, shader investigation, runtime instrumentation, texture processing, and repeated live testing.

According to the project owner, the initial reverse-engineering effort took two overnight runs. On returning after the second night, they found a working game.

This is a useful practical example of VC being applied to a task that naturally generates context pressure: a long sequence of technical investigations in which each new result depends heavily on preserving the exact findings, failed hypotheses, environmental details, and current project state from previous work.

## The outcome

The original objective was achieved: Hell-Copter became playable on Linux with hardware-accelerated 3D rendering.

The work included:

- Establishing a working 32-bit Wine/Proton environment and game prefix.
- Investigating and resolving input problems, including DirectInput-related keyboard behaviour.
- Reverse-engineering the rendering path to diagnose the black 3D world and texture problems.
- Building custom tracing, analysis, and runtime-instrumentation tools.
- Correcting visual issues, including night fog and sprite/particle rendering.
- Implementing texture processing and upscaling.
- Producing a launcher and project documentation, with changes committed to Git.

The user's own validation provides an important distinction between a technical prototype and an actually playable result. On November 12, the owner reported that the textures were correct and the keyboard worked, then confirmed that the game worked perfectly and that they had finished the first mission. At that point, the remaining functional complaints were resolution and frame rate.

Subsequent work expanded the scope to higher frame rates, resolution handling, and additional visual refinements. Those follow-on improvements should not be confused with the initial playable baseline: the game had already reached a state the owner considered working and playable.

## Scale of the session

The supplied Pi JSONL session log is approximately **96.5 MiB** and contains 8,933 records. It spans October 30 to November 13, 2026, with work resumed across several dates rather than one uninterrupted session.

The trace records:

| Measure                              |       Observed |
| ------------------------------------ | -------------: |
| Session log                          |       96.5 MiB |
| JSONL records                        |          8,933 |
| Assistant responses                  |          3,671 |
| Tool-call invocations                |          3,503 |
| Bash calls                           |          2,596 |
| File-read calls                      |            280 |
| VC checkpoint records                |            201 |
| Completed branch-summary transitions |            120 |
| Characters in branch summaries       |        970,652 |
| Aggregate token accounting           | 133.65 million |

The 133.65 million figure is cumulative token accounting across model requests, not the size of a single context or the number of unique tokens in the project. Approximately 125.37 million of those tokens were cache reads.

The largest observed request processed approximately 72,016 input and cached-context tokens, close to the configured 72,192-token context window.

The 120 branch summaries averaged approximately 8,089 characters each. In total, they represent almost one million characters of deliberately carried-forward technical state.

These figures are useful because they show the scale of the actual context-management activity. This was not a short task with one or two compactions. The agent repeatedly completed a unit of work, preserved a continuation payload, and resumed from a selected checkpoint.

## What the reverse-engineering actually involved

The session trace demonstrates why continuity was particularly important.

A representative problem was the black 3D world. The menus and HUD could render, but the actual game environment remained black. The agent could not solve this by changing a graphics setting or blindly trying compatibility layers.

It progressively built an evidence chain:

1. Captured and inspected a 702 MB graphics trace.
2. Produced a 1.6-million-line API-call dump.
3. Counted rendering operations and established that geometry was actually being submitted.
4. Inspected shader programs, uniforms, texture formats, framebuffer operations, and draw state.
5. Extracted and inspected texture data to distinguish bad source assets from rendering failures.
6. Tested competing explanations and explicitly rejected several of them.
7. Built a 32-bit runtime GL instrumentation shim to investigate the game's rendering behaviour more directly.

This is the kind of work where losing a seemingly minor detail can invalidate a later investigation. Knowing that a particular hypothesis was already disproven is just as valuable as knowing the current leading explanation. Repeating an experiment that has already failed is not merely wasteful: it can send the investigation back into an obsolete line of reasoning.

The same pattern appeared elsewhere. The agent maintained information about the Wine environment, game state, process IDs, tool scripts, exact menu coordinates, binary addresses, patch locations, trace files, and pending measurements. Those details were repeatedly incorporated into continuation payloads.

The branch summaries were not generic conversation summaries. They frequently recorded:

- Verified environmental facts that should not be rediscovered.
- Specific conclusions and the evidence supporting them.
- Hypotheses that had been ruled out.
- Files and tools created or modified.
- Current runtime and process state.
- Exact commands or measurements needed next.
- The remaining work, in priority order.

That is a particularly good match for VC's design: preserve the operational state needed to continue the work, rather than trying to compress the entire accumulated conversation into one increasingly lossy narrative.

## How VC influenced the work

The log records 201 VC checkpoint events and 120 completed branch-summary transitions.

This is direct evidence that VC was actively used throughout the project. The agent was not attempting to hold the entire investigation in one continuously growing context. It repeatedly moved to selected checkpoints and continued with a fresh, task-specific payload.

Three aspects appear especially important.

### 1. Continuity across many independent investigations

The project was not one linear debugging problem. It consisted of many interdependent investigations: compatibility, input, rendering, texture formats, shader behaviour, performance, and game-specific reverse engineering.

VC provided a way to finish one investigative unit and resume from a deliberately selected state. This made it possible to preserve the results of earlier work without retaining every intermediate exchange and tool output in the active working context.

### 2. Preservation of negative results

The investigation generated many hypotheses that turned out to be wrong. For example, the trace analysis explicitly ruled out several possible explanations for the black world, including fog-related and rendering-state theories.

Preserving those negative results matters. A future continuation should not treat a disproven theory as an open question simply because its supporting diagnostic conversation was compressed away.

The continuation payloads repeatedly carried forward both established facts and rejected explanations. This is one of the clearest practical advantages visible in this session.

### 3. Repeated recovery to a clean working state

The 120 completed transitions are significant not just because they happened, but because they repeatedly changed the active context.

Instead of continuously accumulating old hypotheses, transient tool output, and obsolete assumptions, the agent could resume from a selected checkpoint with a new continuation payload.

This is consistent with VC's intended negative context-rot pressure: accumulated conversational state does not have to become permanent working context. The agent can carry forward validated knowledge while leaving behind stale or disproven material.

In the terminology of the project, this is an example of the mechanism supporting **zero context rot**. It is not a universal mathematical proof of that property, but the session provides a substantial real-world demonstration of the intended behaviour.

## The context-overflow incident

An objective account should also include the failure.

During the November 10 overnight work, a regression in VC 1.0.12 allowed the agent's context to reach its limit. The owner noticed the problem and intervened, instructing the agent to jump back to an earlier checkpoint rather than continue in the saturated context.

The trace records the workspace at 100% utilization at that point.

This incident became the basis for the emergency-zone experiment in VC 1.0.13. Version 1.0.14 then hardened the mechanism. According to the project owner, that hardening did not materially affect task performance and this task served as a sufficient confirmation of correctness, so the usual book analysis benchmark was not re-run for 1.0.14.

This is important for two reasons:

- VC 1.0.12 was not flawless. The regression exposed a real failure mode under sustained unattended work.
- The incident produced a concrete engineering improvement in VC itself. The emergency-zone mechanism was motivated by an actual failure encountered during a demanding real-world task.

The session log contains several checkpoint snapshots recorded at 100% utilization; these should not be interpreted as several independent overflow incidents but an attempted automatic recovery. The November 10 event is the one explicitly identified by the owner as the actual context-overflow failure.

## Comparison with a hypothetical regular-compaction run

There was no matched regular-compaction control run using the same model, machine, instructions, project state, and time budget. Consequently, it would be incorrect to claim a measured percentage improvement or to say that regular compaction would certainly have failed.

A capable model using regular compaction could potentially complete the task, particularly if it also maintained external notes and project documentation.

However, the session gives us a strong basis for assessing the likely difference.

Regular compaction would repeatedly summarize an evolving conversation as context pressure increased. The summarizer would have to decide which details to preserve from a growing history containing thousands of tool calls, large diagnostic outputs, failed experiments, changing project priorities, and low-level implementation findings.

That creates a difficult preservation problem. A compact summary might retain the broad objective while losing the precise details needed to continue an investigation: a binary address, a texture-format distinction, a rejected hypothesis, a tool's current behaviour, or the exact next experiment.

The agent could recover some of that information from files, but doing so would require locating, rereading, and reconstructing the relevant state. This session already had substantial persistent notes and artifacts, so those would have helped a regular-compaction run as well. They do not, however, eliminate the difference between retrieving old information and resuming from an intentionally selected checkpoint with a purpose-built continuation payload.

VC made that transition an explicit part of the workflow.

The likely practical consequences of using regular compaction instead would have been:

- More repeated investigation and rereading of existing artifacts.
- Greater risk of losing low-level findings among the broad project summary.
- More difficulty distinguishing verified facts from outdated assumptions.
- More reliance on the model reconstructing the current project state from historical notes.
- A greater chance that context pressure would eventually interrupt an unattended run.

These are reasoned expectations, not measured outcomes. The trace does not contain the counterfactual run needed to quantify them.

The important point is that VC was not compared against doing nothing. It was used in a task where the realistic alternative was repeated regular compaction, with its associated summarization and recovery burden.

## Limitations of the evidence

This case study has several limitations:

- It is one project and one extended session, not a controlled benchmark.
- There is no parallel run using regular compaction.
- The user remained involved: they supplied requirements, corrected misunderstandings, performed live play-testing, and intervened during the context-overflow incident.
- The project also maintained persistent files, scripts, logs, and Git history. VC was not the only source of durable state.
- The session log measures activity and context-management events, but does not independently validate every code change or every technical conclusion.

These limitations prevent a precise causal or performance claim. They do not diminish the value of the trace as evidence of how VC operated in a demanding real-world workflow.

## Assessment

This is a substantially more meaningful demonstration than a conventional long-document retrieval benchmark.

The book benchmark tested whether a model could retain and retrieve information from a large source. Hell-Copter tested something different: whether a relatively small local model could sustain a complex engineering investigation, accumulate technical knowledge, reject failed approaches, modify and instrument software, and continue making progress through many cycles of work.

The model operated with a 72K context window, while the session accumulated more than 133 million tokens of total request accounting. VC recorded 201 checkpoints and 120 completed continuation transitions. The work reached a functioning, user-validated game, with the owner reporting that the initial reverse-engineering effort took two overnight runs.

The most defensible conclusion is that **VC was a material operational enabler of this result**. The trace shows it doing the work it was designed to do: repeatedly converting a large, evolving task history into manageable, actionable working contexts.

We cannot prove that regular compaction would have failed. We can say that reproducing this particular workflow without VC would likely have required more repeated reconstruction and would have faced a substantially harder context-management problem.

Most importantly, this was not a synthetic task designed around VC. It was real reverse engineering, with real debugging, real failures, real implementation work, and a working result validated by the owner.

That is precisely the kind of long-horizon work for which agent-driven voluntary context management is intended.
