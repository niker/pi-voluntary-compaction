# Current Snapshot: Regular Compaction (RC) vs Checkpointed Context (VC)

## Abstract

This snapshot compares five saved regular-compaction runs (`rc1`–`rc5`) with five checkpointed runs (`vc1`–`vc5`). The VC runs span three releases: vc1–vc3 used 1.0.0, vc4 used 1.0.10, and vc5 used 1.0.11. Across all five VC attempts, the mean composite is **97.30** (range 94.38–98.86), versus **82.37** for RC (79.75–84.31). The VC 1.0.0 cohort averaged **96.42**; vc4 scored 98.37 and vc5 scored 98.86. Every VC run exceeded every RC run; even the lowest VC score was 10.07 points above the highest RC score. All five VC attempts followed the required final-text-line chapter boundary, while all five RC attempts did not.

Across the five runs, VC's mean wall time was 41.2 minutes versus 68.3 minutes for RC, and its mean modeled context cost was 19.8% lower. VC5 took 45.5 minutes—10.1% longer than VC4, but shorter than VC3—while the five-run VC mean remained below RC's. The offline summary-token audit flags six RC compactions because estimated input-plus-summary totals exceed the configured 72,192-token window; the TUI independently confirms truncated output for RC2 #19 and #20. VC has no forced compactions. Compaction outcomes are session diagnostics, not weighted composite components.

## 1. Evaluation

Per-run scores use each run's frozen `eval.json` and adjudicated `result.json`; cohort summaries are in `rc-composite.json` and `vc-composite.json`. The composite is the weighted mean of five active components, normalized over total configured weight 0.76: single needles (0.31), semantic multi-hop (0.15), structured chapters (0.10), structured characters (0.10), and early retention (0.10). Compaction failures are reported separately and do not change the weighted score. The arithmetic cohort means below are descriptive.

The frozen test outputs are available on-demand, because the test uses copyrighted material as input and the session logs required for evaluation are large.

## 2. Model and hardware

All runs used the identical **Swift 1.5 Qwen3.8 27B GSQ RCO MTP** configuration in LM Studio on Kubuntu 26.04 with an AMD Radeon 9070 XT (16 GB VRAM). The configured context window was **72,192 tokens** (model maximum 262,144). Key settings were 65 GPU-offload layers, 8 CPU threads, batch sizes 512/128, concurrency 2, unified KV cache, Flash Attention, and MTP draft length up to 2 tokens and 0.33 draft probability. 

The only intended difference was context management: regular 75% auto-compaction for RC and checkpoints with disabled auto-compaction for VC. The full recorded settings are in `model-settings.json`.

## 3. Composite scores

| Measure | RC (n=5) | VC (n=5) | VC − RC |
|---|---:|---:|---:|
| Composite, observed | 82.37 (79.75–84.31) | **97.30 (94.38–98.86)** | **+14.93** |
| Single needles | 97.65% | **98.82%** | +1.17 pp |
| Multi-hop, semantic | 95.00% | **97.93%** | +2.93 pp |
| Structured chapters, F1 | 0.00 | **100.00** | +100.00 F1 |
| Structured characters, F1 | 80.83 | **86.21** | +5.38 F1 |
| Early retention | 100.00% | 100.00% | tie |

The VC mean combines distinct releases, so version-level results are also important: vc1–vc3 (1.0.0) averaged **96.42** (94.38–98.12); vc4 (1.0.10) scored **98.37**; vc5 (1.0.11) scored **98.86**. RC1, the best of the five RC attempts, scored 84.31. Every VC run exceeded every RC score; VC5 was 14.55 points above RC1. The five-run sample standard deviations were 1.81 points for VC and 1.65 for RC; the VC set spans software releases and is tested as first-try on each new version.

| Run | VC release | Composite | Needles | Multi-hop | Chapters F1 | Characters F1 | Early retention |
|---|---|---:|---:|---:|---:|---:|---:|
| RC1 (best of 5) | — | 84.31 | 98.53% | 100.00% | 0.00 | 85.33 | 100% |
| RC2 | — | 82.49 | 98.53% | 87.50% | 0.00 | 90.24 | 100% |
| RC3 | — | 82.86 | 97.06% | 100.00% | 0.00 | 78.87 | 100% |
| RC4 | — | 82.45 | 98.53% | 93.75% | 0.00 | 80.56 | 100% |
| RC5 | — | 79.75 | 95.59% | 93.75% | 0.00 | 69.14 | 100% |
| VC1 | 1.0.0 | 96.76 | 97.06% | 95.88% | 100.00 | 90.70 | 100% |
| VC2 | 1.0.0 | 94.38 | 98.53% | 93.75% | 100.00 | 71.23 | 100% |
| VC3 | 1.0.0 | 98.12 | 100.00% | 100.00% | 100.00 | 85.71 | 100% |
| VC4 | 1.0.10 | 98.37 | 98.53% | 100.00% | 100.00 | 92.13 | 100% |
| VC5 | 1.0.11 | 98.86 | 100.00% | 100.00% | 100.00 | 91.30 | 100% |

All five VC runs reported the required final-text-line chapter boundaries and scored 19/19; all five RC runs scored 0/19 because their reported end lines extend one line beyond the required final text line, into the blank separator. This instruction-following difference is directly scored by the benchmark; no one-line tolerance was applied.

**Boundary sensitivity:** if RC is assigned 100% chapter F1 in all five runs, its mean composite rises from 82.37 to **95.53**, still 1.77 points below the pooled VC mean of 97.30. This is an illustrative sensitivity analysis, not a correction to reported scores.

## 4. Runtime and strategy

| Run | Composite | Wall time | Tool calls | Compactions / checkpoint jumps |
|---|---:|---:|---:|---:|
| RC1 | 84.31 | 4,122.0 s (68.7 min) | 73 | 16 / 0 |
| RC2 | 82.49 | 8,121.2 s (135.4 min) | 90 | 20 / 0 |
| RC3 | 82.86 | 3,094.4 s (51.6 min) | 119 | 13 / 0 |
| RC4 | 82.45 | 2,085.5 s (34.8 min) | 78 | 9 / 0 |
| RC5 | 79.75 | 3,072.9 s (51.2 min) | 57 | 14 / 0 |
| VC1 (1.0.0) | 96.76 | 2,147.0 s (35.8 min) | 102 | 0 / 6 |
| VC2 (1.0.0) | 94.38 | 2,057.1 s (34.3 min) | 113 | 0 / 8 |
| VC3 (1.0.0) | 98.12 | 2,941.1 s (49.0 min) | 103 | 0 / 10 |
| VC4 (1.0.10) | 98.37 | 2,481.7 s (41.4 min) | 103 | 0 / 7 |
| VC5 (1.0.11) | 98.86 | 2,731.9 s (45.5 min) | 55 | 0 / 8 |

Mean wall time is 4,099.2 s for RC and 2,471.8 s for VC, about **39.7% lower for VC**. Runtime sample standard deviations are 2,360.9 s for RC and 376.0 s for VC. VC5 took 45.5 minutes—10.1% longer than VC4, though shorter than VC3—and had the fewest tool calls among VC runs (55). The longest RC run, RC2, lasted 135.4 minutes.

## 5. Compaction outcomes

| Run | Recorded events | Summary and resume boundary recorded | Compaction failures (truncation) | Tool-result errors |
|---|---:|---:|---:|---:|
| RC1 | 16 | 16 | 1 (#6) | 1 Bash |
| RC2 | 20 | 20 | 4 (#6, #15, #19, #20) | 0 |
| RC3 | 13 | 13 | 0 | 10 Bash |
| RC4 | 9 | 9 | 1 (#4) | 2 Bash |
| RC5 | 14 | 14 | 0 | 0 |
| **RC total** | **72** | **72** | **6** | **13 Bash** |
| VC1–VC5 | 0 | — | 0 | 1-3 Bash total (VC1: 1, VC2: 1, VC3: 1, VC4: 3, VC5: 3) |

All 72 recorded RC compaction events contain a nonempty summary and a `firstKeptEntryId` resume boundary. The trace has no explicit success/failure status field. For this analysis, a compaction is classified **failed/incomplete** when `tokensBefore + estimated full-summary tokens` exceeds the configured 72,192-token context window. This offline estimate flags six events: RC1 #6 (73,550; 1,358 over), RC2 #6 (74,909; 2,717 over), RC2 #15 (72,608; 416 over), RC2 #19 (83,052; 10,860 over), RC2 #20 (75,808; 3,616 over), and RC4 #4 (74,944; 2,752 over). The TUI separately confirms that RC2 #19 and #20 produced truncated output.

Before injected `<read-files>` metadata, RC2 #19 ends **“Finds axe + shield. Hor”** (tokensBefore 71,262; summarization usage 31,290 input / 12,185 output / 43,475 total). #20 ends **“Finds axe + shield. Sees horrific”** (tokensBefore 63,330; 24,070 input / 13,064 output / 37,134 total). These incomplete tails match both the estimate-overflow classification and the TUI confirmation.

The automated audit now mirrors VC's offline `estimateTokensSafe` heuristic for each compaction and compares `tokensBefore + estimated full-summary tokens` with the documented 72,192-token context window. For the last three RC2 events:

| Event | tokensBefore | Estimated summary tokens (full / prose only) | Sum proxy | Estimated headroom |
|---|---:|---:|---:|---:|
| #18 | 57,031 | 12,761 / 12,663 | 69,792 | +2,400 |
| #19 | 71,262 | 11,790 / 11,663 | 83,052 | −10,860 |
| #20 | 63,330 | 12,478 / 12,352 | 75,808 | −3,616 |

Across the five RC runs, the audit classifies six estimated sums above the context limit (1.2 per run on average; RC2 has four). All five VC runs have zero compactions, so their per-run and cohort diagnostics report zero summary estimates and zero overflows. These failure counts are diagnostic-only: they do not enter the weighted composite or token-cost calculation. Per-event estimates are stored in each run's `eval.json` and copied into `compaction_summary_token_estimates_by_run` in both cohort JSON files; numeric cohort summaries are also included there.

For contrast, the shortest RC run, RC4, has nine compactions and no overflows. Its #9 summary ends with a complete bullet about early “bratr” references being relevant to mh05 (three brothers); `tokensBefore` is 57,105 and summarization usage is 11,633 input / 7,141 output / 18,774 total. The overflow comparison uses VC's offline `estimateTokensSafe` heuristic, not model-native tokenization; it is an estimate-based failure criterion rather than a direct provider stop-reason field.

The word *truncated* appears in 26 RC summary texts (RC1: 8, RC2: 9, RC3: 8, RC4: 0, RC5: 1). In RC2, these mentions refer to earlier clipped book/tool output, not necessarily to the compaction summary. Tool-result errors are tracked separately: RC1, RC3, and RC4 have Bash errors; RC2 has none. The audit stores event counts, summary/resume-boundary presence, explicit status fields, text mentions, heuristic candidates, per-summary token estimates, and tool-result errors separately in each per-run `eval.json` and cohort composite. The token-estimate fields are marked `diagnostic_only`; they do not affect the weighted benchmark composite or cost calculation.

## 6. Estimated context cost and retrieval

| Cohort | Mean context-cost estimate | Mean recognized book accesses | Mean full-file accesses | Mean estimated bytes touched |
|---|---:|---:|---:|---:|
| RC (n=5) | 14.2414 points | 62.6 | 23.4 | 13.41 MB |
| VC (n=5) | 11.4262 points | 39.6 | 15.6 | 8.87 MB |

VC's mean modeled cost is **19.8% below RC's**; vc5's estimate is 10.6010 points. VC also has fewer recognized accesses and fewer estimated bytes touched on average, hinting at superior efficiency for long tasks. The cost index uses provider-reported token totals with a modeled cached/uncached split and is not a provider invoice; cached classification is inferred rather than observed cache telemetry. Retrieval counts are best-effort and do not establish attention or efficiency.

## 7. Interpretation and limitations

Across all saved runs, VC's mean composite is 97.30 versus 82.37 for RC, and VC also has lower mean wall time and modeled context cost. VC5 scored 98.86, above RC1's selected best-of-five score of 84.31. All VC runs scored 19/19 on chapters, while every RC run scored zero. Even if RC's chapter scores were set to 100% in a sensitivity analysis, its mean composite (95.53) would remain 1.77 points below the VC mean.

The evaluation heavily advantages RC, working with best-of-five result. In comparison VC is reported as a five separate first-try runs spanning three releases. Runtime and retrieval estimates are trace-derived. Compaction failure counts follow the documented overflow estimate.

## 8. Conclusion

VC is showing progressive improvement over time even though the baseline was already superior to RC in every aspect. Across ten runs on the same model and unchanged test, VC averaged 97.30 versus RC's 82.37; even the lowest VC score exceeded RC's best-of-five. The potential cost saving of up to 20% for VC also needs to be mentioned as well as time savings for the same task. There is strong evidence of VC general superiority on this benchmark.
