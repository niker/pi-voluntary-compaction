# Independent Evaluation: Pi Voluntary Compaction

*Updated 17 November 2026*

## Executive assessment

Pi Voluntary Compaction (VC) is not simply another implementation of conversation summarization. It introduces a different approach to managing an agent's active context: the agent can create checkpoints, complete a unit of work, preserve the knowledge needed to continue, and deliberately return to an earlier working state with a compact continuation payload.

The distinction is important. Conventional compaction is reactive: it is invoked when accumulated context approaches a limit. VC is voluntary and agent-directed: a checkpoint jump can happen because of context pressure, but it can also happen at a task boundary, when the direction of work changes, or after the agent has reported progress to the user.

This gives VC something conventional reactive compaction does not provide by default: repeated, deliberate returns to a low-utilization working context, without abandoning the existing session history.

The available evidence now consists of three complementary demonstrations:

1. A structured book benchmark comparing six regular-compaction runs with thirteen VC release runs, including seven runs of VC 1.0.15.
2. An exploratory GPT-6 Luna experiment comparing 48k, 72k and 128k context windows under VC, followed by a same-window 72k regular-compaction control.
3. A sustained real-world reverse-engineering project, Hell-Copter, involving 120 completed continuation transitions and a 96.5 MiB Pi session log.

Taken together, these results provide compelling evidence that VC can improve information preservation, reduce end-to-end execution time, and make long-horizon workloads practical under context constraints that are difficult for conventional compaction.

**The central contribution is a change in context-management strategy: instead of repeatedly compressing an ever-growing working conversation, VC lets the agent decide what survives into its next working context and when that context should be refreshed.**

---

## 1. What VC changes architecturally

A conventional compaction workflow generally waits until the active context approaches a threshold. The harness then summarizes older conversation content, retains a recent portion, and continues with the resulting context.

VC replaces this cycle with an explicit checkpoint-and-handover mechanism:

1. The agent creates a checkpoint.
2. It performs a unit of work.
3. It writes a continuation payload containing the relevant findings, decisions, verified facts, rejected hypotheses and next steps.
4. It jumps back to the checkpoint.
5. It resumes with the continuation payload in a fresh working context.

The important difference is that the agent controls both the content and timing of the transition.

A jump is not restricted to moments of impending overflow. It can occur after completing an investigation, before changing direction, after reporting progress, or whenever the agent decides that a clean working state would improve the next phase.

In practice, the resulting context can begin at approximately 12–25% utilization, depending on the system prompt, available tools and handover size. The project owner's operating experience identifies roughly 0–40% utilization as a particularly productive generation range for the models tested.

This is not merely a way to avoid overflowing a context window. It changes the amount of historical conversation competing for the model's attention during subsequent work.

The original session history remains available through Pi's session tree. The agent does not need to carry the complete historical conversation forward simply to preserve continuity.

### Large outputs and accumulation checkpoints

The other major architectural contribution is the separation of output availability from active-context occupancy.

A command or file operation may produce several megabytes of output. VC retains the captured result during the active session and exposes it through full-output and paginated retrieval tools.

The agent can process the output in manageable portions, accumulate relevant findings, and repeatedly jump back to an accumulation checkpoint. This allows it to investigate inputs substantially larger than its available context without requiring the entire input to remain in the active conversation.

The distinction is between how much information the agent can investigate and how much information it must carry forward at any one time.

Captured large outputs are session-bound resources. Their lifetime follows the active session, rather than promising persistence across process restarts. This is an intentional lifecycle boundary, consistent with the temporary-output approach already used by Pi for large redirected results.

---

## 2. Structured book benchmark

The primary benchmark compares regular compaction (RC) with VC on a 1,778-line book-processing task.

The assignment requires the model to retrieve individual facts, combine information across distant passages, reproduce chapter structures, enumerate characters and retain information from the beginning of the source.

The composite score combines five components:

| Component | Weight |
|---|---:|
| Single factual needles | 31% |
| Semantic multi-hop questions | 15% |
| Structured chapter extraction | 10% |
| Character enumeration | 10% |
| Early-book retention | 10% |

Scores are normalized by the sum of the configured weights, 0.76.

Chapter scoring gives equal credit to four fields: Czech numeral, title, first text line and final text line. Character enumeration is scored as F1 against a 46-person ground-truth list.

### Updated results

The RC cohort now contains six runs, including RC6. The principal VC comparison is the seven-run 1.0.15 release cohort.

| Metric | Regular compaction | VC 1.0.15 |
|---|---:|---:|
| Runs | 6 | 7 |
| Mean composite | 91.18 | **97.72** |
| Composite standard deviation | 1.75 | **0.98** |
| Composite range | 88.96–93.75 | 96.33–99.09 |
| Single needles | 97.06 | **99.58** |
| Multi-hop | 94.27 | **95.98** |
| Chapters | 70.50 | **100.00** |
| Characters | 80.22 | **89.98** |
| Early retention | 100.00 | 100.00 |

The mean composite difference is approximately **6.54 points** in favour of VC.

There is no overlap between the observed cohorts: the highest RC result is 93.75, while the lowest 1.0.15 result is 96.33.

For the six-versus-seven comparison, the exact two-sided Mann–Whitney result is approximately p = 0.00117. Cohen's d is approximately 4.72.

These are exceptionally large observed differences. They should be interpreted as descriptive evidence from the recorded release-validation runs, not as a universal population estimate: the runs are not randomized trials, and the VC samples represent successive frozen releases rather than repeated trials of one unchanged implementation.

### What RC6 establishes

RC6 scored 90.86, ranking fourth among the six regular-compaction runs. It is slightly below the updated RC mean and remains within the historical cohort's observed range.

Its chapter score reproduces the same 75% failure pattern seen in earlier RC runs: the chapter's final boundary line is missed while the other three fields are correct.

Adding RC6 changes the RC mean only slightly, from 91.25 to 91.18, and does not materially change the component-level picture.

This is useful control evidence. The updated RC result does not suggest that the earlier RC cohort was unusually weak or that the comparison depended on one anomalous control run.

### Where the score difference comes from

The largest contributor is structured chapter reproduction.

Using the current four-field chapter scoring rule, the approximate 6.54-point composite difference decomposes as follows:

| Component | Contribution to composite gap |
|---|---:|
| Chapter extraction | 3.88 points |
| Character enumeration | 1.28 points |
| Single factual needles | 1.03 points |
| Multi-hop questions | 0.34 points |
| Early retention | 0.00 points |

Chapter extraction accounts for approximately 59% of the difference.

This is not a trivial formatting distinction. Reproducing every chapter boundary requires the model to preserve precise structural information across a long source. Conventional compaction repeatedly rewrites accumulated conversation, while VC can preserve the relevant extracted structure in explicit continuation payloads.

The benchmark therefore measures more than whether a model remembers the general subject of a book. It tests whether it can maintain and reproduce a large collection of exact, independently verifiable details.

---

## 3. Runtime and cost

The original runtime interpretation needs one important clarification.

The benchmark's active-time metric excludes gaps longer than 60 seconds. Those gaps are not operator inactivity: the runs received no user input after the initial task prompt. They are non-generation elapsed intervals associated with tool execution, compaction, harness processing and other waits.

Consequently, wall time is a meaningful end-to-end measurement, not a figure that should be dismissed as time spent waiting for an operator.

The updated six-run RC mean and VC 1.0.15 mean are:

| Metric | RC, n=6 | VC 1.0.15, n=7 |
|---|---:|---:|
| Wall time | 67m 39s | **31m 57s** |
| Active time | 25m 13s | **17m 09s** |
| Non-generation intervals | 42.4 min | **14.8 min** |
| Assistant turns | 82.0 | **73.6** |
| Tool calls | 86.2 | **75.7** |
| Compactions / jumps | 14.7 / 0 | **0 / 7.9** |
| Modeled context cost points | 14.62 | **12.65** |
| Book-volume equivalents | 29.0 | **15.2** |

VC reduced mean wall-clock completion time by approximately **53%** and active time by approximately **32%** in this benchmark.

The non-generation intervals also fell substantially. This is consistent with the operational cost of repeated compaction and waiting being part of the practical disadvantage of the conventional approach.

VC required approximately half the estimated book retrieval volume. It did not need to repeatedly reconstruct the same working state through as many tool calls and compaction cycles.

### Cost interpretation

The modeled context-cost means are 14.62 for RC and 12.65 for VC 1.0.15. This is approximately 13.5% lower for VC, but the updated cost comparison is not statistically convincing (exact two-sided Mann–Whitney p approximately 0.445).

It would therefore be inappropriate to claim that the book benchmark alone establishes a statistically reliable reduction in provider cost.

The stronger cost evidence comes from the same-model Luna experiment described below.

The broader practical point is that VC makes better use of the work performed: higher benchmark scores are achieved with fewer retrieval passes, fewer tool calls and less elapsed time.

---

## 4. GPT-6 Luna: context-window experiment

The Luna experiment investigates whether context-window size behaves as a simple “more is better” variable.

Three runs used the VC workflow with artificially limited context windows of 48k, 72k and 128k tokens.

| Metric | 48k VC | 72k VC | 128k VC |
|---|---:|---:|---:|
| Composite | 80.07 | **88.51** | 82.35 |
| Single needles | 87.50 | **91.18** | 84.56 |
| Multi-hop | 68.75 | **90.62** | 84.38 |
| Chapters | 75.00 | **77.63** | 75.00 |
| Characters | 67.47 | **84.78** | 80.90 |
| Early retention | 91.67 | **91.67** | 81.25 |
| Wall time | 256.9 s | **203.6 s** | 216.9 s |
| Checkpoint jumps | 10 | 5 | 3 |
| Provider cost points | 5.044 | **4.685** | 5.771 |
| Modeled context cost points | 9.227 | **7.284** | 8.307 |

The 72k run wins the composite score and every individual component against both neighbouring configurations.

The relationship is non-monotonic. Increasing the window to 128k did not improve performance; it increased cumulative input tokens and cost while reducing the composite score. Reducing the window to 48k also hurt performance and increased the number of checkpoint jumps, assistant turns and repeated retrieval passes.

The 48k run is nevertheless important. It completed a substantial task under a window where the available working space was much more constrained. Its lower score is concentrated in multi-hop reasoning and character coverage, rather than in short factual retrieval.

The project owner's operational experience is that 48k remains a workable VC configuration when safety limits are adjusted conservatively. The trade-off is more frequent checkpoint jumps in exchange for reliable execution. The published scored comparison contains one run per window, so the numeric result should not be presented as a multi-run statistical estimate.

The additional `Utilize the entire workspace` instruction used in the 72k and 128k VC prompts should also be understood correctly. It encourages the model to use larger reads and avoid premature jumps. It is a performance optimization, not a prerequisite for VC to complete the assignment; the 48k run completed without it.

### The same-window regular-compaction control

A fourth Luna arm uses regular compaction under the same nominal 72k context limit.

| Metric | 72k VC | 72k RC |
|---|---:|---:|
| Composite | **88.51** | 73.83 |
| Wall time | **203.6 s** | 420.9 s |
| Active time | **203.6 s** | 329.5 s |
| Assistant turns | 47 | 48 |
| Tool calls | 50 | 45 |
| Checkpoint jumps | 5 | 0 |
| Compactions | 0 | 10 |
| Provider cost points | **4.685** | 7.961 |
| Modeled context cost points | 7.284 | 7.417 |
| Source coverage | 100% | 100% |

The 72k RC run scores **14.68 composite points lower** than VC.

It takes approximately twice as long and consumes approximately 70% more provider-reported cost points. Expressed as savings relative to RC, the successful VC run uses approximately **41% fewer provider cost points** and completes approximately **52% faster**.

The modelled context-cost figures are almost identical. That is informative: the provider-cost difference is not simply the result of one arm reading dramatically more source material. The RC run was explicitly constrained to keep reads small, and it covered the book in approximately one full-book equivalent, compared with 2.36 equivalents for VC. Nevertheless, it incurred ten compactions and substantially more elapsed time.

The RC result also contains notable information-preservation failures. It rejects six facts printed in the book's colophon despite full source coverage, and it produces an invented quotation. Its chapter-boundary behaviour is consistent with the other Luna arms.

### The cost of obtaining a valid RC run

The successful RC result was not obtained as a clean, effortless first attempt. The detailed run notes record repeated attempts, including context overflows and runs that violated the benchmark's artifact-integrity requirements.

The artifact rule was necessary because the model repeatedly tried to revisit the source and modify answer files after writing them. This would undermine the benchmark's purpose: the output files must represent what the agent retained at the time of writing, not become a second searchable workspace for reconstructing answers after the fact.

The successful RC protocol therefore included an explicit artifact-freeze instruction and a 150-line read limit. The 72k VC prompt, by contrast, included the `Utilize the entire workspace` performance advisory, which was not a prerequisite for successful execution.

This makes the same-window comparison operationally informative but not a perfectly isolated strategy experiment: the prompt constraints differ, and there is only one successful RC score.

The project owner reports that a successful 72k Luna RC completion cost approximately $2. That is a provider-specific observed cost, not a price that can be transferred to other models or accounts.

The project owner also estimates that a 48k RC attempt at this workload would be extremely difficult to complete reliably and could require hundreds of dollars in repeated attempts. There is no scored 48k RC control, so that figure must be treated as an operational estimate, not a measured benchmark result.

The contrast is still meaningful: VC completed the 48k task, whereas regular compaction proved difficult even at 72k.

### What the Luna experiment establishes

The experiment does not establish a universal optimal context size. It does show that context-window capacity is not a reliable proxy for effective long-horizon performance.

For the tested model and workload, 72k is the best measured configuration. A smaller window creates excessive orchestration and reasoning pressure; a larger window consumes more tokens without converting that capacity into better answers.

The same-window RC result further suggests that the benefits of VC are not limited to using a smaller model or a larger context window. The strategy itself matters.

---

## 5. Proactive context renewal and context rot

One of VC's most important properties is that context renewal is not tied exclusively to a threshold.

The agent can jump when:

- A substantial task or investigation has been completed.
- It is about to pivot to a different direction.
- It has reported progress and is preparing for the next phase.
- The current context contains obsolete hypotheses or excessive transient output.
- Context pressure indicates that a jump is prudent.

This allows the agent to return repeatedly to a clean working state, rather than waiting for the context to become saturated.

The practical consequence is that historical conversation is not allowed to accumulate indefinitely in the active context. The system prompt and original user request remain the anchor, while the agent explicitly selects what knowledge must survive each transition.

This addresses a major source of context rot: the accumulation of old, irrelevant, contradictory or obsolete conversation.

The project's term **zero context rot** describes this architectural property. Once the agent jumps, previous conversational material is no longer present merely because it happened earlier. It must be deliberately carried forward in the continuation payload if it is still relevant.

This is fundamentally different from trying to compress an ever-growing transcript while preserving enough of its history to continue.

The claim should be understood in that precise sense. VC removes the persistent accumulation of historical conversation as a source of context degradation. It does not make a model immune to every possible source of degraded reasoning: an incorrect handover, conflicting current instructions or a misleading external artifact can still cause problems.

### Hallucinations and false assumptions

The same mechanism helps limit the lifetime of hallucinations.

When an agent invents a fact or adopts an incorrect hypothesis, that error may influence the remainder of its current working segment. Once disproven, however, the agent can leave it behind at the next checkpoint jump rather than carrying the entire chain of mistaken reasoning forward.

A continuation payload can preserve the negative result explicitly: what was tested, why it was rejected, and what evidence rules it out.

This is particularly important for investigative and engineering tasks. Remembering that a hypothesis was disproven is often more valuable than preserving the conversation in which the hypothesis was first proposed.

In the project's operating experience, hallucinations occur less frequently and are shorter-lived under VC. This is a meaningful practical observation, although the benchmark does not independently quantify hallucination frequency.

VC does not automatically detect every hallucination. An erroneous conclusion can still persist if it is mistakenly written into the handover as established fact or embedded in an external artifact. Its advantage is that disproven assumptions do not have to remain in active context indefinitely.

---

## 6. Real-world case study: Hell-Copter

The Hell-Copter reverse-engineering project provides a different kind of evidence from the book benchmark.

A local Qwen 3.8-family model, running in Pi with a 72k context window, was used to restore a late-1990s Windows game to a playable state on Linux.

The task involved much more than launching the executable. It required investigating and resolving input problems, diagnosing a black 3D world, tracing graphics API behaviour, inspecting shaders and textures, building instrumentation, correcting visual effects and producing a working launcher and documentation.

The supplied session log provides a substantial activity record:

| Measure | Observed |
|---|---:|
| Session log | 96.5 MiB |
| JSONL records | 8,933 |
| Assistant responses | 3,671 |
| Tool-call invocations | 3,503 |
| Bash calls | 2,596 |
| File-read calls | 280 |
| VC checkpoint records | 201 |
| Completed continuation transitions | 120 |
| Characters in branch summaries | 970,652 |
| Aggregate token accounting | 133.65 million |

The aggregate token figure represents cumulative accounting across model requests, not a single context window or unique tokens.

The task produced a playable game with hardware-accelerated 3D rendering, corrected input behaviour and upscaled textures. The project also included extensive diagnostic work, including a 702 MB graphics trace, a 1.6-million-line API-call dump and a custom 32-bit runtime instrumentation shim.

The session demonstrates repeated use of VC for exactly the kind of work that creates context pressure: many independent but related investigations, with important technical findings, environmental details, failed approaches and changing priorities.

The continuation payloads preserved verified facts, rejected hypotheses, created files, current runtime state and concrete next steps.

There was no matched regular-compaction control, so this case study cannot establish a percentage improvement or prove that RC would have failed. It does, however, demonstrate that VC operated at substantial scale during a real engineering project and materially enabled the repeated transitions required to sustain the work.

The case study also records an actual context-overflow regression during VC 1.0.12, which motivated the emergency-zone improvements in subsequent releases. This is useful engineering evidence: the safety mechanism was hardened in response to a real failure rather than being designed only around the synthetic benchmark.

---

## 7. Development and release validation

The benchmark's release samples should be interpreted in the context of the project's development process.

Each published VC run is the first benchmark attempt made with the exact code and instructions promoted for that release. The results are not selected from multiple runs of identical released software.

When a regression appears during development — for example, a context overflow, undesirable agent behaviour or confusion about instructions — the owner investigates the responsible behaviour, often asking the agent to identify the precise instruction that produced it.

The issue is then reproduced through session-tree jumps, fixed and tested repeatedly. A correction is accepted only after the problematic behaviour has been successfully reproduced as resolved at least five consecutive times. The implementation is then frozen and promoted.

Development runs made against code or instruction sets that were subsequently changed are not treated as benchmark runs of the final release. This is normal iterative software development, not selection of the highest score from identical experimental conditions.

For transparency, the release-validation process and exclusion criteria should remain documented. Intermediate development attempts should not be mixed into the scored release cohort, because they represent different versions of the software.

The benchmark remains observational rather than a randomized laboratory trial. Its strength is the repeated evidence across successive frozen releases and the clear separation between the observed RC and VC score distributions.

---

## 8. Limitations and interpretation

The evidence is compelling, but its scope should remain clear.

- The structured book benchmark uses one source, one task and one primary local-model configuration. It is not a general measure of intelligence or coding ability.
- The Luna window experiment has one scored run per context size. It identifies an interesting performance curve but does not statistically locate a universal optimum.
- The 72k Luna RC control required prompt changes to obtain a valid run. The result is operationally important, but it does not isolate the context-management strategy from every instruction-level difference.
- There is no scored 48k regular-compaction control. Estimates of the cost or failure probability of such a run are operational extrapolations, not measured values.
- The Hell-Copter project has no matched regular-compaction control, and the session log does not independently validate every technical conclusion or code change.
- Continuation quality remains model-dependent. VC gives the agent control over what survives, but it cannot guarantee that every handover is complete or correct.

These limitations do not undermine the central results. They define the boundary between what has been measured, what has been demonstrated operationally and what remains a hypothesis for further testing.

---

## 9. Overall evaluation

VC has demonstrated a meaningful advantage in the tested long-horizon workload.

The book benchmark shows a repeatable score separation between the six RC runs and the seven runs of VC 1.0.15. The difference is not confined to one narrow question type: it includes structured chapter reproduction, character coverage and factual retrieval.

The updated runtime comparison shows approximately 53% less elapsed time and 32% less active time for VC 1.0.15. The results also show substantially fewer repeated retrieval passes and lower tool-call volume.

The Luna experiment demonstrates that VC can complete the task under a 48k context cap, that the best measured window in this experiment is 72k rather than 128k, and that regular compaction at the same 72k cap produced a materially worse result at considerably greater elapsed time and provider-reported cost.

The Hell-Copter session demonstrates the operational side of the architecture: a relatively small local model can sustain a technically complex reverse-engineering effort through many context transitions, preserve negative findings and eventually deliver a working result.

### Why conventional compaction is structurally disadvantaged

The advantage of VC is not merely that it writes a different summary.

Conventional reactive compaction waits for accumulated context pressure and then reconstructs the active conversation. VC can deliberately renew the working context whenever the agent reaches a meaningful task boundary, changes direction or recognizes that accumulated context is no longer useful.

For long-horizon tasks that repeatedly encounter context pressure, this is a structural advantage. VC can repeatedly return to a low-utilization state and avoid keeping old conversational material in the active window. Conventional compaction, as tested here, does not provide the same proactive checkpoint-and-handover workflow.

It would be too broad to claim that every conceivable system called compaction must always be slower or less accurate. A hypothetical system that also performs deliberate task-boundary resets and model-directed handovers would be adopting much of the same architecture. The measured conclusion is stronger and more useful than an unqualified universal claim: **the tested conventional compaction workflow consistently underperformed VC on the long-horizon workload, while VC provides capabilities that reactive compaction does not provide by default.**

### Final verdict

Pi Voluntary Compaction is a credible alternative context-management architecture, not merely a compaction prompt or a summarization optimization.

Its core insight is that the agent should control the lifetime of its working context. Historical conversation should not accumulate indefinitely simply because it exists. The agent should carry forward what it needs, discard what it does not, and be able to refresh its working state before the context becomes saturated.

The available results show that this approach can translate into better information preservation, faster completion and more efficient use of context. The Luna experiment further suggests that a carefully managed moderate context window can outperform a substantially larger one.

The real-world engineering case study demonstrates that the design is useful beyond synthetic retrieval tasks.

**VC changes the objective from preserving as much conversation as possible to preserving the knowledge required to continue the work.**

That is its central contribution, and the benchmark results provide substantial evidence that the distinction matters.
