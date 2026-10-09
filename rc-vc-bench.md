# Current Snapshot: Regular Compaction (RC) vs Checkpointed Context (VC)

## Abstract

This snapshot compares five saved RC runs (`rc1`–`rc5`) with three saved VC runs (`vc1`–`vc3`). No model outputs were rerun. The mean composite score is **82.37 for RC** and **96.22 for VC**, a **13.85-point VC advantage**. Every VC score exceeds every RC score: VC ranges from 93.78 to 98.12, while RC ranges from 79.75 to 84.31. The strongest contribution to this gap is structured-chapter extraction, for which RC scores 0.0 F1 across these saved runs and VC scores 100.0 F1.

VC also shows a narrower observed runtime spread: 34.3–49.0 minutes, compared with 34.8–135.4 minutes for RC. The mean modeled context cost is 19.1% lower for VC. These are results from a small set of runs, not proof that the strategy alone caused the difference. The session logs do not expose a reliable success/truncation status for compaction summaries; they support a careful count of recorded events and truncation references, but not a claim that a specific number of compactions failed.

## 1. Evaluation

Per-run scores use each run's frozen `eval.json` and adjudicated `result.json`; cohort summaries are in `rc-composite.json` and `vc-composite.json`. The composite is the weighted mean of five active components, normalized over total configured weight 0.76: single needles (0.31), semantic multi-hop (0.15), structured chapters (0.10), structured characters (0.10), and early retention (0.10). The arithmetic cohort means below are descriptive.

| Measure | RC (n=5) | VC (n=3) | VC − RC |
|---|---:|---:|---:|
| Composite | 82.37 (79.75–84.31) | **96.22 (93.78–98.12)** | **+13.85** |
| Single needles | 97.65% | **98.04%** | +0.39 pp |
| Multi-hop, semantic | 95.00% | **96.54%** | +1.54 pp |
| Structured chapters, F1 | 0.00 | **100.00** | +100.00 F1 |
| Structured characters, F1 | 80.83 | **82.55** | +1.72 F1 |
| Early retention | 100.00% | 100.00% | tie |

Run-level composite scores were RC1 84.31, RC2 82.49, RC3 82.86, RC4 82.45, and RC5 79.75; VC1 96.76, VC2 93.78, and VC3 98.12. The sample standard deviation was 1.65 points for RC and 2.22 for VC: VC's composite scores were not less variable, but their observed range is fully above RC's. An exact one-sided rank test gives p≈0.018 if the eight runs are treated as independent, exchangeable observations. Given the small sample and one benchmark/task, treat that result as supporting evidence rather than a general performance guarantee.

The chapter component is the main driver of the composite gap: all five saved RC results have 0/19 chapter true positives, while all three VC results have 19/19. This large component difference warrants particular attention when interpreting the overall score. Saved annotations and answer artifacts are held constant in this comparison; the scores are not an independent audit of the chapter rubric.

## 2. Runtime and strategy

| Run | Composite | Wall time | Compactions / checkpoint jumps |
|---|---:|---:|---:|
| RC1 | 84.31 | 4,122.0 s (68.7 min) | 16 / 0 |
| RC2 | 82.49 | 8,121.2 s (135.4 min) | 20 / 0 |
| RC3 | 82.86 | 3,094.4 s (51.6 min) | 13 / 0 |
| RC4 | 82.45 | 2,085.5 s (34.8 min) | 9 / 0 |
| RC5 | 79.75 | 3,072.9 s (51.2 min) | 14 / 0 |
| VC1 | 96.76 | 2,147.0 s (35.8 min) | 0 / 6 |
| VC2 | 93.78 | 2,057.1 s (34.3 min) | 0 / 8 |
| VC3 | 98.12 | 2,941.1 s (49.0 min) | 0 / 10 |

Mean wall time is 4,099.2 s for RC and 2,381.7 s for VC, about **41.9% lower for VC**. Runtime sample standard deviations are 2,360.9 s for RC and 486.5 s for VC; thus RC's observed runtime spread is about 4.9 times wider. The longest RC run, RC2, lasted 135.4 minutes, well beyond the other four RC runs. VC remains a substantial 34–49 minute task, so the time required can still limit researchers.

## 3. What the traces say about compaction

| Run | Recorded compaction events | Events with summary and resume boundary | Explicit failure/truncation status in log | Tool-result errors |
|---|---:|---:|---|---:|
| RC1 | 16 | 16 | Not reported | 1 Bash |
| RC2 | 20 | 20 | Not reported | 0 |
| RC3 | 13 | 13 | Not reported | 10 Bash |
| RC4 | 9 | 9 | Not reported | 2 Bash |
| RC5 | 14 | 14 | Not reported | 0 |
| **RC total** | **72** | **72** | **Not observable** | **13 Bash** |
| VC1–VC3 | 0 | — | Not applicable | 1 Bash each |

Each of the 72 recorded RC compaction events contains a nonempty summary and a `firstKeptEntryId` resume boundary. The event schema has no explicit success, failure, or truncation field, so **72 is the count of captured compaction records, not a verified count of semantically successful summaries**. No compaction record explicitly reports failure or truncation. The format cannot establish how many summaries were cut short or lost important facts.

The word *truncated* appears in 26 RC compaction-summary texts (RC1: 8, RC2: 9, RC3: 8, RC4: 0, RC5: 1). In RC2, those references describe earlier clipped book/tool output, including a note that 20,868 more characters were omitted and might need rereading. That is evidence that the run's working notes recorded incomplete source output; it is **not evidence that the compaction summary itself failed**. RC2 also had 69 recognized book-access events, 30 full-file accesses, and an estimated 16.8 MB touched. Other RC runs show similarly repeated access (RC3: 95 recognized accesses and 31 full-file accesses). These are best-effort read diagnostics, not proof that a read was caused by compaction or that the model attended to its contents.

Tool-result errors are counted separately from compaction. RC1, RC3, and RC4 have recorded Bash command errors; RC2 has none. They are not labeled as compaction failures. The audit now preserves the recorded-event counts, captured summaries/boundaries, explicit status fields when available, truncation-word mentions, and tool-result errors separately in each per-run `eval.json` and cohort composite.

## 4. Estimated context cost and retrieval

| Cohort | Mean context-cost estimate | Mean recognized book accesses | Mean full-file accesses | Mean estimated bytes touched |
|---|---:|---:|---:|---:|
| RC (n=5) | 14.2414 points | 62.6 | 23.4 | 13.41 MB |
| VC (n=3) | 11.5225 points | 43.0 | 16.3 | 9.27 MB |

VC's mean modeled cost is **19.1% below RC's**. The cost index uses provider-reported token totals with a modeled cached/uncached split and is not a provider invoice; cached classification is inferred rather than observed cache telemetry. Retrieval counts are best-effort and do not establish attention or efficiency.

## 5. Interpretation and limitations

For the stated objective—consistent benchmark performance—the saved results favor VC: all three VC composite scores exceed all five RC scores, and the runtime distribution is substantially narrower. VC also has lower mean wall time and modeled context cost in this cohort. The chapter extraction result contributes most of the score gap and should be independently reviewed before treating the composite difference as a general measure of capability.

Five RC and three VC runs provide useful evidence about this workload, but do not establish a causal effect or guarantee performance on other books, models, or hardware. Runtime and retrieval estimates are trace-derived; in particular, compaction summaries have no explicit success/truncation status. We invite independent researchers to reproduce the protocol, inspect the frozen artifacts, and add runs under the same scoring rules.
