# Regular Compaction (RC) vs Checkpointed Context (VC)

## Abstract

This report compares five regular-compaction runs (RC1–RC5) with six checkpointed-context runs (VC1–VC6) on the same benchmark. The mean composite score was **82.09** for RC and **97.46** for VC, a descriptive difference of 15.37 points. VC6 (release **1.0.13**) scored **98.78**, 1.58 points above the preceding VC1–VC5 mean of 97.20. VC6 also had the shortest wall time and lowest estimated context cost among the six VC runs. It introduced a third, emergency checkpoint guard intended to permit more context use before jumping while retaining a forced-jump safety limit.
## 1. Model and hardware

All runs used the identical **Swift 1.5 Qwen3.8 27B GSQ RCO MTP** configuration in LM Studio on Kubuntu 26.04 with an AMD Radeon 9070 XT (16 GB VRAM). The configured context window was **72,192 tokens** (model maximum 262,144). Key settings were 65 GPU-offload layers, 8 CPU threads, batch sizes 512/128, concurrency 2, unified KV cache, Flash Attention, and MTP draft length up to 2 tokens and 0.33 draft probability. 

The only intended difference was context management: regular 75% auto-compaction for RC and checkpoints with disabled auto-compaction for VC. The full recorded settings are in `model-settings.json`.


## 2. Evaluation and methods

All runs use frozen per-run `eval.json` and adjudicated `result.json`; cohort summaries are in `rc-composite.json`, `vc-composite.json`, and `comparison_results.json`. The composite is the weighted mean of five components, normalized by the configured weight sum of 0.76: single needles (0.31), semantic multi-hop (0.15), structured chapters (0.10), structured characters (0.10), and early retention (0.10). The current character key contains **46 canonical people**. Character adjudications and chapter judgments were kept unchanged for this update; chapter scores continue to use the exact final-text-line rule.

RC1–RC5 used regular compaction without the extension installed.
VC1–VC3 used release 1.0.0; VC4 used 1.0.10; VC5 used 1.0.11; VC6 used 1.0.13. The versions are evaluated as recorded, first attempt immediately before version public release. Attempts with obvious regressions that prompted a code or instruction change are omited.

VC6 adds an experimental third checkpoint-jump guard. The soft threshold is **75%** of the context budget: it warns and wraps up. The hard threshold is **85%**: it interrupts and orders a checkpoint jump, but allows the model to continue reasoning. From the hard threshold up to the emergency threshold, writes are allowed after a warning. The emergency threshold is **100% - 3,256 tokens**: it disables reasoning and forces an immediate jump; unlike the hard threshold, it can interrupt an ongoing write. This design permits temporary use near 90–95% of the context boundary, whereas RC's regular compaction threshold remains at 75% (and does not guarantee safety from overflow). The intended effect of the experimental enhancements are to avoid unnecessary early jumps and maintain agent's reasoning boost to intelligence while assembling a jump strategy and payload.

## 3. Composite results

| Measure | RC (n=5) | VC (n=6) | VC − RC |
|---|---:|---:|---:|
| Composite score, mean (range) | 82.09 (79.74–83.88) | **97.46 (94.01–98.78)** | **+15.37** |
| Single needles | 97.65% | **99.02%** | +1.37 pp |
| Semantic multi-hop | 95.00% | **98.27%** | +3.27 pp |
| Structured chapters, F1 | 0.00 | **100.00** | +100.00 |
| Structured characters, F1 | 78.70 | **86.33** | +7.62 |
| Early retention | 100.00% | 100.00% | tie |

The VC1–VC5 mean was **97.20** (range 94.01–98.75); VC6 scored **98.78**, 1.58 points above that mean. The run-level scores are shown below.

| Run | VC release | Composite | Needles | Multi-hop | Chapters F1 | Characters F1 | Early retention |
|---|---|---:|---:|---:|---:|---:|---:|
| RC1 | — | 83.88 | 98.53% | 100.00% | 0.00 | 82.05 | 100% |
| RC2 | — | 82.38 | 98.53% | 87.50% | 0.00 | 89.41 | 100% |
| RC3 | — | 82.44 | 97.06% | 100.00% | 0.00 | 75.68 | 100% |
| RC4 | — | 82.03 | 98.53% | 93.75% | 0.00 | 77.33 | 100% |
| RC5 | — | 79.74 | 95.59% | 93.75% | 0.00 | 69.05 | 100% |
| VC1 | 1.0.0 | 96.36 | 97.06% | 95.88% | 100.00 | 87.64 | 100% |
| VC2 | 1.0.0 | 94.01 | 98.53% | 93.75% | 100.00 | 68.42 | 100% |
| VC3 | 1.0.0 | 98.60 | 100.00% | 100.00% | 100.00 | 89.36 | 100% |
| VC4 | 1.0.10 | 98.26 | 98.53% | 100.00% | 100.00 | 91.30 | 100% |
| VC5 | 1.0.11 | 98.75 | 100.00% | 100.00% | 100.00 | 90.53 | 100% |
| VC6 | 1.0.13 | **98.78** | 100.00% | 100.00% | 100.00 | 90.72 | 100% |

Across the five RC runs, character F1 averages 78.70; across six VC runs it averages 86.33. VC6's character F1 is 90.72 (44 true positives, 7 false positives, 2 false negatives) against the 46-person key. VC6 also scored 34/34 on needles, 8/8 on multi-hop, 19/19 on chapters, and 6/6 on early retention.

## 4. Context strategy and runtime

| Cohort/run | Wall time | Tool calls | Forced compactions | Checkpoint jumps |
|---|---:|---:|---:|---:|
| RC1–RC5, mean | 4,099.2 s (68.3 min) | 83.4 | 14.4 | 0 |
| VC1–VC5, mean | 2,471.8 s (41.2 min) | — | 0 | 7.8 |
| VC6 | **1,633.1 s (27.2 min)** | 51 | 0 | 6 |

VC6 was 33.9% faster than the preceding five-run VC mean and 60.2% faster than the RC mean. It completed with no forced compactions and six checkpoint jumps. The five RC traces recorded 72 regular compactions in total. Session counts and wall time are descriptive and may be affected by run conditions; they do not by themselves show that the guard improved speed.

## 5. Estimated context cost and retrieval

| Cohort/run | Mean estimated context cost |
|---|---:|
| RC1–RC5 | 14.2414 points |
| VC1–VC5 | 11.4262 points |
| VC6 | **9.3277 points** |

VC6's estimated cost was 18.4% below the VC1–VC5 mean and 34.5% below the RC mean. The estimate is a model, not a provider invoice. It uses provider-reported token totals and an inferred cached/uncached split; cached classification is not observed cache telemetry. Retrieval and session-trace measurements are best-effort diagnostics, not evidence of attention or efficiency. Trace-to-output provenance is provisional because the logs name original roots unavailable in this workspace.

## 6. Interpretation and limitations

In these stored runs, VC scores higher on average than RC, while the 1.0.13 VC6 run scored slightly above the preceding VC1–VC5 mean and had lower observed wall time and modeled cost than that mean. VC runs used checkpoint jumps without forced compaction; RC runs used regular compaction. The VC cohort spans several releases, the sample is small, and the two strategies were not compared in matched randomized trials. The run-level differences therefore do not establish that checkpointing—or the third guard specifically—caused the score or resource differences. Further repeated trials under controlled conditions are needed for that conclusion.
