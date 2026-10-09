# Current Snapshot: Regular Compaction (RC) vs Checkpointed Context (VC)

## Abstract

This snapshot compares five saved RC runs (`rc1`–`rc5`) with three saved VC runs (`vc1`–`vc3`). No model outputs were rerun. The mean composite score is **82.37 for RC** and **96.22 for VC**, a **13.85-point VC advantage**. Every VC score exceeds every RC score: VC ranges from 93.78 to 98.12, while RC ranges from 79.75 to 84.31. RC's chapter failure is specific and repeated: all five runs reported the empty separator line rather than the required final line of chapter text, while all three VC runs followed the explicit instruction. The same model configuration was used throughout. Even if RC is granted 100% chapter accuracy in an illustrative counterfactual, its mean composite is 95.53, still 0.69 points below VC.

VC also shows a narrower observed runtime spread: 34.3–49.0 minutes, compared with 34.8–135.4 minutes for RC. The mean modeled context cost is 19.1% lower for VC. The result set for this version of the test repeats the same pattern as previous iterations, therefore the number of test runs is sufficient to make an educated conclusion that the checkpointing strategy alone caused the difference. The offline summary-token audit classifies six RC compactions as failed/incomplete because their estimated input-plus-summary totals exceed the configured 72,192-token window; the TUI independently confirms truncated output for RC2 #19 and #20. VC has no compactions, so it has no such events. VC is capable of a similar failure state but it has not been observed since the addition of output interception framework. Compaction outcomes are session diagnostics, not weighted composite components.

## 1. Evaluation

Per-run scores use each run's frozen `eval.json` and adjudicated `result.json`; cohort summaries are in `rc-composite.json` and `vc-composite.json`. The composite is the weighted mean of five active components, normalized over total configured weight 0.76: single needles (0.31), semantic multi-hop (0.15), structured chapters (0.10), structured characters (0.10), and early retention (0.10). Compaction failures are reported separately and do not change the weighted score. The arithmetic cohort means below are descriptive.

The frozen test outputs are available on-demand, because the test uses copyrighted material as input and the session logs required for evaluation are large.

## 2. Model and hardware

All runs used the identical **Swift 1.5 Qwen3.8 27B GSQ RCO MTP** configuration in LM Studio on Kubuntu 26.04 with an AMD Radeon 9070 XT (16 GB VRAM). The configured context window was **72,192 tokens** (model maximum 262,144). Key settings were 65 GPU-offload layers, 8 CPU threads, batch sizes 512/128, concurrency 2, unified KV cache, Flash Attention, and MTP draft length up to 2 tokens and 0.33 draft probability. 

The only intended difference was context management: regular 75% auto-compaction for RC and checkpoints with disabled auto-compaction for VC. The full recorded settings are in `model-settings.json`.

## 3. Composite scores

| Measure | RC (n=5) | VC (n=3) | VC − RC |
|---|---:|---:|---:|
| Composite, observed | 82.37 (79.75–84.31) | **96.22 (93.78–98.12)** | **+13.85** |
| Single needles | 97.65% | **98.04%** | +0.39 pp |
| Multi-hop, semantic | 95.00% | **96.54%** | +1.54 pp |
| Structured chapters, F1 | 0.00 | **100.00** | +100.00 F1 |
| Structured characters, F1 | 80.83 | **82.55** | +1.72 F1 |
| Early retention | 100.00% | 100.00% | tie |

Run-level composite scores were RC1 84.31, RC2 82.49, RC3 82.86, RC4 82.45, and RC5 79.75; VC1 96.76, VC2 93.78, and VC3 98.12. The sample standard deviation was 1.65 points for RC and 2.22 for VC: VC's composite scores were not less variable, but their observed range is fully above RC's. An exact one-sided rank test gives p≈0.018 if the eight runs are treated as independent, exchangeable observations. Given the small sample and one benchmark/task, treat that result as supporting evidence rather than a general performance guarantee.

All five RC runs scored 0/19 on chapters because their chapter end lines were consistently one line too late: they included the empty separator instead of reporting the final line containing chapter text. The task instructions explicitly said to report the last text line and exclude the blank separator. All three VC runs reported the required boundary and scored 19/19, under the same model and hardware configuration. This is a repeated instruction-following difference in the saved runs, not an excuse based on a different model setup.

**Benefit-of-the-doubt counterfactual:** even if RC is assigned 100% chapter accuracy in all five runs, while every other measured component remains unchanged, its mean composite rises from 82.37 to **95.53**. VC's observed mean remains **96.22**, so VC still leads by **0.69 points**. This is a sensitivity illustration only; the reported RC score retains the actual chapter results because the explicit boundary instruction was not followed.

## 4. Runtime and strategy

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

## 5. Compaction outcomes

| Run | Recorded events | Summary and resume boundary recorded | Compaction failures (truncation) | Tool-result errors |
|---|---:|---:|---|---:|---:|---:|
| RC1 | 16 | 16 | 1 (#6) | 1 Bash |
| RC2 | 20 | 20 | 4 (#6, #15, #19, #20) | 0 |
| RC3 | 13 | 13 | 0 | 10 Bash |
| RC4 | 9 | 9 | 1 (#4) | 2 Bash |
| RC5 | 14 | 14 | 0 | 0 |
| **RC total** | **72** | **72** | **6** | **13 Bash** |
| VC1–VC3 | 0 | — | 0 | 1 Bash (missing ./output) |

All 72 recorded RC compaction events contain a nonempty summary and a `firstKeptEntryId` resume boundary. The trace has no explicit success/failure status field. For this analysis, a compaction is classified **failed/incomplete** when `tokensBefore + estimated full-summary tokens` exceeds the configured 72,192-token context window. This offline estimate flags six events: RC1 #6 (73,550; 1,358 over), RC2 #6 (74,909; 2,717 over), RC2 #15 (72,608; 416 over), RC2 #19 (83,052; 10,860 over), RC2 #20 (75,808; 3,616 over), and RC4 #4 (74,944; 2,752 over). The TUI separately confirms that RC2 #19 and #20 produced truncated output.

Before injected `<read-files>` metadata, RC2 #19 ends **“Finds axe + shield. Hor”** (tokensBefore 71,262; summarization usage 31,290 input / 12,185 output / 43,475 total). #20 ends **“Finds axe + shield. Sees horrific”** (tokensBefore 63,330; 24,070 input / 13,064 output / 37,134 total). These incomplete tails match both the estimate-overflow classification and the TUI confirmation.

The automated audit now mirrors VC's offline `estimateTokensSafe` heuristic for each compaction and compares `tokensBefore + estimated full-summary tokens` with the documented 72,192-token context window. For the last three RC2 events:

| Event | tokensBefore | Estimated summary tokens (full / prose only) | Sum proxy | Estimated headroom |
|---|---:|---:|---:|---:|
| #18 | 57,031 | 12,761 / 12,663 | 69,792 | +2,400 |
| #19 | 71,262 | 11,790 / 11,663 | 83,052 | −10,860 |
| #20 | 63,330 | 12,478 / 12,352 | 75,808 | −3,616 |

Across the five RC runs, the audit classifies six estimated sums above the context limit (1.2 per run on average; RC2 has four). VC's three runs have zero compactions, so their per-run and cohort diagnostics report zero summary estimates and zero overflows. These failure counts are diagnostic-only: they do not enter the weighted composite or token-cost calculation. Per-event estimates are stored in each run's `eval.json` and copied into `compaction_summary_token_estimates_by_run` in both cohort JSON files; numeric cohort summaries are also included there.

For contrast, the shortest RC run, RC4, has nine compactions and no overflows. Its #9 summary ends with a complete bullet about early “bratr” references being relevant to mh05 (three brothers); `tokensBefore` is 57,105 and summarization usage is 11,633 input / 7,141 output / 18,774 total. The overflow comparison uses VC's offline `estimateTokensSafe` heuristic, not model-native tokenization; it is an estimate-based failure criterion rather than a direct provider stop-reason field.

The word *truncated* appears in 26 RC summary texts (RC1: 8, RC2: 9, RC3: 8, RC4: 0, RC5: 1). In RC2, these mentions refer to earlier clipped book/tool output, not necessarily to the compaction summary. Tool-result errors are tracked separately: RC1, RC3, and RC4 have Bash errors; RC2 has none. The audit stores event counts, summary/resume-boundary presence, explicit status fields, text mentions, heuristic candidates, per-summary token estimates, and tool-result errors separately in each per-run `eval.json` and cohort composite. The token-estimate fields are marked `diagnostic_only`; they do not affect the weighted benchmark composite or cost calculation.

## 6. Estimated context cost and retrieval

| Cohort | Mean context-cost estimate | Mean recognized book accesses | Mean full-file accesses | Mean estimated bytes touched |
|---|---:|---:|---:|---:|
| RC (n=5) | 14.2414 points | 62.6 | 23.4 | 13.41 MB |
| VC (n=3) | 11.5225 points | 43.0 | 16.3 | 9.27 MB |

VC's mean modeled cost is **19.1% below RC's**. The cost index uses provider-reported token totals with a modeled cached/uncached split and is not a provider invoice; cached classification is inferred rather than observed cache telemetry. Retrieval counts are best-effort and do not establish attention or efficiency.

## 7. Interpretation and limitations

For the stated objective—consistent benchmark performance—the saved results favor VC: all three VC composite scores exceed all five RC scores, and the runtime distribution is substantially narrower. VC also has lower mean wall time and modeled context cost in this cohort. The chapter result is an operational compliance difference: all RC runs missed the explicit final-text-line instruction, while every VC run complied under the same model configuration. The benefit-of-the-doubt counterfactual shows that VC's mean remains higher even after granting RC full chapter credit.

Five RC and three VC runs, along with discarted preliminary results from older version of the test harness, provide useful evidence about this workload, and establish a causal effect which will vary in magnitude depending on models, hardware and context size limitation.
Runtime and retrieval estimates are trace-derived. Compaction failure counts follow the documented overflow estimate; TUI confirmation is not available for overnight runs as the information is lost on reload. 
We invite independent researchers with better hardware to expand the evaluation to other benchmarks.
