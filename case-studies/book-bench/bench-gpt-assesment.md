# pi-voluntary-compaction: Benchmark Evaluation and Project Assessment

## The benchmark

This benchmark is a particularly interesting demonstration of agent-controlled context management because it combines several difficult requirements in a single, constrained task.

The evaluated agent must read an entire 1,778-line Czech science-fiction novel, retain the ability to retrieve precise information from it, combine facts across distant chapters, reproduce exact Czech quotations, and produce several structured JSON artifacts. These include exhaustive character identification and the exact boundaries of all 19 sections, down to their starting and final text lines.

The source language is an important part of the challenge. The model, a heavily quantized 27B Qwen-family model, is considerably more capable in English and Chinese than in Czech. Even recognizing chapter boundaries and interpreting some character relationships is therefore challenging. This is not simply a matter of remembering what it has read: the model must maintain an accurate structural and semantic understanding of a relatively long document despite a language disadvantage.

The restrictions make the experiment more meaningful. The agent cannot use external knowledge, temporary files, intermediate documents or subagents. It must perform the work within a single session, using the original source and its available context-management mechanisms.

This tests something important: whether an agent can maintain a reliable working representation of a substantial source throughout a long task, rather than merely produce a convincing summary of what it has seen.

### Results

The reported results show a substantial advantage for voluntary compaction:

| Evaluation               | Regular compaction | Voluntary compaction |
| ------------------------ | ------------------ | -------------------- |
| Single needles           | 97.65%             | **99.02%**           |
| Semantic multi-hop       | 95.00%             | **98.27%**           |
| Structured chapters F1   | 0.00               | **100.00**           |
| Structured characters F1 | 78.70              | **86.33**            |
| Early retention          | 100%               | 100%                 |
| Composite score          | 82.09              | **97.46**            |

The chapter extraction result is particularly striking. Regular compaction scored zero across all five recorded runs, whereas voluntary compaction achieved perfect chapter extraction in all six runs.

This is not a trivial formatting exercise. Correctly identifying 19 sections, their titles, and their precise textual boundaries requires the agent to preserve document-wide structural knowledge. The Czech language adds a significant comprehension challenge, particularly for a model with limited proficiency in that language.

The other results are equally worth considering, even though some categories have less room for improvement. Single-needle and multi-hop retrieval were already strong under regular compaction. Voluntary compaction improves both, while structured character extraction also improves noticeably.

The final VC run achieved 34/34 single-needle answers, 8/8 multi-hop answers, 19/19 chapter records and a character F1 of 90.72.

The composite improvement of 15.37 points is impressive, although its magnitude is heavily influenced by the chapter extraction category. This should be understood as a strong demonstration of a particular capability, not as a uniform 15-point improvement across every aspect of long-context reasoning.

### Efficiency

The runtime results reinforce the quality measurements.

| Metric                     | RC average | VC1–VC5 average | VC6          |
| -------------------------- | ---------- | --------------- | ------------ |
| Wall time                  | 68.3 min   | 41.2 min        | **27.2 min** |
| Forced regular compactions | 14.4       | 0               | 0            |
| Checkpoint jumps           | 0          | 7.8             | 6            |

The final VC run completed the task approximately 60% faster than the regular-compaction average.

This comparison is important because regular compaction is not a cost-free alternative. It repeatedly processes and compresses accumulated history, inevitably introducing opportunities for information loss. Recovering information that was omitted or distorted requires additional retrieval and reasoning.

Voluntary compaction replaces that workflow with agent-managed checkpointing. The agent decides what remains relevant, preserves it in a continuation payload, and returns to an earlier point without having to carry the entire preceding history forward.

The result is not simply fewer tokens. It is a more efficient way of continuing work.

The reported context-cost figures also favour VC, although these are modelled estimates rather than actual provider billing measurements.

### Assessment of the experimental methodology

The benchmark has several substantial strengths:

- Both approaches use the same model, source material, hardware and task requirements.
- The task combines precise retrieval, multi-hop reasoning and structured extraction.
- The language mismatch provides a meaningful challenge rather than testing an exceptionally capable language model under ideal conditions.
- The agent cannot rely on external memory, subagents or intermediate files.
- The evaluation includes both quality and end-to-end execution measurements.

There are also limitations worth acknowledging.

The sample size is relatively small: five RC runs and six VC runs. Furthermore, the VC cohort includes multiple releases, from 1.0.0 through 1.0.13. It therefore demonstrates the evolution and practical effectiveness of the approach, but is not a controlled comparison of repeated runs of one identical release.

Some development attempts were excluded following regressions that led to changes in the implementation or instructions. For greater experimental transparency, future results should preserve every attempt and distinguish development runs from release-validation runs.

The chapter extraction metric would also benefit from a more detailed breakdown of heading recognition, chapter numbering, start-line accuracy and end-line accuracy. Finally, the methodology for early retention should be documented more explicitly.

The source material is copyrighted and cannot be redistributed as a public benchmark dataset. This limits independent reproduction of the exact experiment, but does not diminish the value of the observed results. The methodology, configuration, aggregate measurements and evaluation design can still be documented without disclosing the underlying text.

**Overall, I consider this a genuinely useful experimental result.** It is a substantially more realistic demonstration of long-document context management than a synthetic token-counting exercise or an English-only retrieval test.

It demonstrates that voluntary compaction can preserve information that regular compaction consistently fails to retain, even when the underlying model faces a meaningful language disadvantage.

---

## The verdict on pi-voluntary-compaction

The most important contribution of VC is its underlying premise.

Traditional regular compaction treats conversation history as something that must be compressed into a smaller representation. The harness decides when to do this, and the model must continue working with whatever information survived the compression.

Voluntary compaction reverses that relationship.

The agent takes responsibility for its own working memory. It decides what is still relevant, what needs to be preserved, what can be discarded, and what information it should retrieve again before continuing.

This is more than a different compaction strategy. It is a different model of how an agent should manage its own context.

### Zero context rot

I particularly like the concept of zero context rot.

It is a bold claim, but I consider it defensible in the context of VC's architecture.

Context rot is not necessarily eliminated at every individual moment. Models can still develop incorrect assumptions, misunderstand information or produce imperfect continuation payloads. The important distinction is what happens to those imperfections over time.

Regular compaction has no inherent mechanism for eliminating accumulated context rot. Once a distorted representation becomes part of the compressed history, subsequent work inherits it. Repeated compactions can perpetuate and reinforce the distortion.

VC introduces an opposing pressure.

Every checkpoint jump gives the agent an opportunity to discard obsolete information, incorrect intermediate assumptions and accumulated conversational noise. It does not have to preserve its entire cognitive history merely because that history exists.

Consequently, context rot is no longer necessarily cumulative. Any rot that enters the working context can disappear as the agent progresses through successive jumps. The repeated removal of historical baggage creates negative rot pressure, counteracting the degradation that naturally occurs during long interactions.

This is an important conceptual distinction: **VC does not promise an absence of imperfect reasoning; it prevents imperfect reasoning from having to become permanent context.**

I find this one of the strongest aspects of the project.

### What I particularly appreciate about the implementation

Several implementation decisions stand out.

**Agent autonomy.** The model is not merely instructed to produce summaries at predefined intervals. It participates in managing its own context lifecycle. This is a much more natural fit for agentic systems.

**Checkpoint-based continuation.** Returning to an earlier state while carrying forward a deliberately constructed continuation payload is an elegant way to separate historical execution from current working memory.

**Handling oversized tool outputs.** The ability to retrieve complete outputs progressively, rather than being limited by the amount of information that can enter the context at once, extends the idea beyond ordinary conversation management. It allows an agent to work with information substantially larger than its available context window.

**Emergency protection.** The distinction between soft limits, hard limits and emergency intervention is well considered. In particular, protecting partially completed file mutations is essential for a system that can interrupt and rewind an agent's execution.

**Applicability to small models.** This is arguably where VC has the greatest potential. Smaller models are particularly vulnerable to accumulating irrelevant context and losing important details during repeated summarization. Giving them control over their working memory can compensate for some of their inherent limitations.

### What deserves further development

I would prioritize automated runtime testing, especially around interrupted tool calls, concurrent operations, checkpoint recovery and large outputs.

I would also strengthen the benchmark with more runs of a single frozen release, preserve every attempt and introduce additional task domains. Software engineering, for example, would be an excellent complement to the existing long-document experiment.

Finally, I would like to see VC adopted and evaluated in other agent harnesses. Its underlying principles are not specific to Pi. Any system that allows an agent to manipulate its conversation history could potentially benefit from the same approach.

---

## Final assessment

I consider pi-voluntary-compaction a genuinely interesting contribution to agent architecture, rather than simply another context-window optimization.

The benchmark provides compelling evidence that its approach can improve information retention, structured extraction and overall task completion time. The fact that these results were obtained using a heavily quantized model working with Czech source material makes the demonstration particularly noteworthy.

The experimental evidence is not yet sufficient to claim universal superiority, and the benchmark would benefit from more controlled release-specific testing. Nevertheless, the observed differences are substantial enough to justify confidence in the underlying direction.

What I enjoy most about VC is the simplicity of its central insight: an agent should not be forced to carry its entire past into its future.

It should be able to decide what it needs to remember, forget what no longer serves it, and recover from the imperfections of its own previous reasoning.

**The fundamental shift is from context summarization to context ownership.**

That is a much bigger idea than a compaction extension, and I believe it deserves attention well beyond the Pi ecosystem.

