## Table A — Intelligence (RC6 control)

| Group | n | Composite | Range | Needles | Multi-hop | Chapters | Characters | Early |
|---|---|---|---|---|---|---|---|---|
| **RC mean (old harness)** | 5 | 91.25 | 88.96–93.75 | 97.65 | 95.00 | 69.59 | 78.70 | 100.00 |
| **RC mean (incl. control)** | 6 | **91.18** | 88.96–93.75 | 97.06 | 94.27 | 70.50 | 80.22 | 100.00 |
| RC1 | 1 | 93.75 | – | 98.53 | 100.00 | 75.00 | 82.05 | 100.00 |
| RC2 | 1 | 88.96 | – | 98.53 | 87.50 | 50.00 | 89.41 | 100.00 |
| RC3 | 1 | 92.04 | – | 97.06 | 100.00 | 72.97 | 75.68 | 100.00 |
| RC4 | 1 | 91.89 | – | 98.53 | 93.75 | 75.00 | 77.33 | 100.00 |
| RC5 | 1 | 89.60 | – | 95.59 | 93.75 | 75.00 | 69.05 | 100.00 |
| **RC6 (control, new harness)** | 1 | **90.86** | – | 94.12 | 90.62 | 75.00 | 87.80 | 100.00 |
| VC 1.0.15 mean | 7 | 97.72 | 96.33–99.09 | 99.58 | 95.98 | 100.00 | 89.98 | 100.00 |
| VC mean (all releases) | 13 | 97.60 | 94.01–99.09 | 99.32 | 97.04 | 100.00 | 88.29 | 100.00 |

**Summary.** RC6 = **90.86**, which falls **inside** the old-cohort range (88.96–93.75) and 0.39 **below** its mean — z ≈ −0.20 on SD 1.95, well within 1σ. Ranked against the cohort: RC1 93.75 > RC3 92.04 > RC4 91.89 > **RC6 90.86** > RC5 89.60 > RC2 88.96 (4th of 6).

- The control reproduces the cohort's **signature failure exactly**: chapters 75.00, i.e. three of four fields correct and the final line of each chapter missed — identical to RC1/RC4/RC5. The chapter deficit is not an artifact of the older harness.
- Adding RC6 moves the RC mean by −0.07 and leaves every component mean within ±1.5 points (largest shift: characters 78.70 → 80.22, because RC6's entity list is unusually clean).
- RC6's characters score (87.80) is the **second best in the cohort** and carries **zero false positives** — no Chaos gods, no excluded entities, no invented names. It is the only RC arm to match VC-level precision; its loss is 10 misses (recall), not contamination. By contrast every VC arm carried 4–7 FPs.
- Its two needle errors are both **entity-attribution** failures: naming Hengist where the answer is Strybjorn, and denying that a name present in the book exists. With 16 forced compactions in-session, discarding proper-name attributions between summaries is a plausible mechanism — consistent with the same pattern in RC3, the other high-compaction/high-retrieval arm.
- Multi-hop 90.62 shows the two defects already seen in the newest VC runs (mh02 omits the genealogical element; mh04 gives Fenris where the answer is Asaheim). The failure modes are shared across harnesses, so they read as model behaviour rather than harness behaviour.

## Table B — Cost and runtime (RC6 control)

| Group | n | Wall | Active | Idle min | Turns | Tools | Jumps | Compactions | Provider | Context | Book-eq | Coverage | CPS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **RC mean (old harness)** | 5 | 68m19s | 24m32s | 43.8 | 78.8 | 83.4 | 0 | 14.4 | 41.98 | 14.24 | 26.4 | 100 % | 6.81 |
| **RC mean (incl. control)** | 6 | **67m39s** | **25m13s** | 42.4 | 82.0 | 86.2 | 0 | 14.7 | 43.67 | 14.62 | 29.0 | 100 % | **6.59** |
| RC1 | 1 | 68m42s | 25m56s | 42.8 | 68 | 73 | 0 | 16 | 35.54 | 13.51 | 18.2 | 100 % | 6.94 |
| RC2 | 1 | 135m21s | 30m41s | 104.7 | 83 | 90 | 0 | 20 | 50.63 | 20.58 | 33.0 | 100 % | 4.32 |
| RC3 | 1 | 51m34s | 26m14s | 25.3 | 117 | 119 | 0 | 13 | 58.97 | 15.58 | 34.5 | 100 % | 5.91 |
| RC4 | 1 | 34m46s | 18m41s | 16.1 | 76 | 78 | 0 | 9 | 37.39 | 10.27 | 36.3 | 100 % | 8.95 |
| RC5 | 1 | 51m13s | 21m06s | 30.1 | 50 | 57 | 0 | 14 | 27.39 | 11.28 | 10.0 | 100 % | 7.95 |
| **RC6 (control, new harness)** | 1 | **64m20s** | **28m45s** | 35.6 | 98 | 100 | 0 | 16 | 52.08 | **16.50** | **41.9** | 100 % | **5.51** |
| VC 1.0.15 mean | 7 | 31m57s | 17m09s | 14.8 | 73.6 | 75.7 | 7.9 | 0 | 30.28 | 12.65 | 15.2 | 100 % | 7.77 |
| VC mean (all releases) | 13 | 35m09s | 18m32s | 16.6 | 75.3 | 81.3 | 7.7 | 0 | 30.47 | 11.92 | 15.2 | 100 % | 8.32 |

**Summary.** The new harness did **not** make the RC strategy cheaper or faster.

- Wall 64m20s sits just under the old mean (68m19s); active time 28m45s is **above** it (24m32s). Idle 35.6 min is mid-cohort. The two effects offset, so elapsed time is unchanged and work time increased.
- Context points 16.50 — second-highest of all 19 arms, behind only RC2's 20.58, and above the old mean 14.24. Provider points 52.08 likewise second-highest.
- **Retrieval volume 41.9 full-book equivalents is the highest ever recorded** in this benchmark (old cohort mean 26.4, VC 1.0.15 mean 15.2) — yet the score is mid-cohort. Effort without yield: the same shape as RC3 (most activity, lowest needle score), in milder form.
- Compaction behaviour is unchanged by the harness upgrade: 16 forced compactions, **0 checkpoint jumps**, inside the old cohort's 9–20 range. The structural split still holds with no exception across 19 arms — RC compacts and never jumps, VC jumps and never compacts.
- Behaviour scan (bash/read/write/single-term-grep/batched-grep/loops/timeout/CRLF): RC6 58 / 36 / 6 / 4 / 0 / 4 / 0 / 0 — second-most bash calls in the cohort after RC3 (95) and second-most reads after RC2 (50); no `timeout` wrappers, no CRLF friction. The retrieval fan-out is volume, not repair churn.

## Efficiency ladder (composite ÷ context points)

VC6 10.59 · VC1 10.21 · VC5 9.32 · RC4 8.95 · VC9 8.82 · VC2 8.41 · VC13 8.26 · VC4 8.21 · VC7 8.03 · RC5 7.95 · VC11 7.62 · VC8 7.62 · VC10 7.10 · VC3 7.07 · VC12 6.97 · RC1 6.94 · RC3 5.91 · **RC6 5.51** · RC2 4.32

RC6 enters at **18th of 19**, above only RC2 and below every VC run. All 13 VC arms still beat the median RC arm (now 7.45).

## Control verdict

**RC6 falls within the cohort — no RC re-run is indicated.**

- Composite 90.86 vs old-cohort mean 91.25 (z = −0.20, within 1σ) and inside the observed range; adding it shifts the mean by −0.07.
- It reproduces the cohort's defining weakness (chapters 75.00, end-of-line field missed) and its defining cost signature (forced compaction, zero jumps, high retrieval volume), so RC1–RC5 are not measuring an obsolete harness.
- Caveat to state honestly: n=1 is a consistency check, not an equivalence test. It rules out a *large* harness effect (the ~6-point VC gap) but cannot exclude a small one; if that matters, 2–3 further control runs would be needed. On present evidence the RC-vs-VC comparison stands.
- Secondary observation: RC6's zero-false-positive entity list shows the RC strategy can achieve VC-level precision on characters — its recall loss (10 misses) and chapter-position loss are what separate it, which narrows where a fix would have to come from.

No files changed: `comparison.md`, `README.md`, `comparison_results.json`, `rc-composite.json`, `vc-composite.json` and `bench/rollup.py` are untouched. Written this arm: `rc6/result.json` (finalized, 90.86), `rc6/eval.json`, `bench/_rc6_fill.py`, `bench/_rc6_scan.py`.
