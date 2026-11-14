# GPU occupancy gate — 2026-11-14

The GPU prototype **passes** the [revised occupancy gate](../superpowers/plans/2026-11-13-gpu-prototype.md#revised-occupancy-gate--approved-2026-11-14):
calibration passed in the browser, and all 330 GPU comparisons are within their
bounds. Task 4 is unblocked.

## Run

One `runGpuOccupancyGate()` session (README, "GPU occupancy gate") on the target
laptop: ThinkPad X280, Firefox 159 on Linux, renderer reported as "Intel(R) HD
Graphics 400, or similar" (Firefox masks the real name). 160 runs of 600 steps,
20 per group and scenario, in 317 seconds, on battery. Thermal conditions were
not recorded; the gate compares occupancy, not timing.

[`2026-11-14-gpu-occupancy-gate.json`](2026-11-14-gpu-occupancy-gate.json) is the
output of `summarize-gpu-occupancy-gate.ts`. Its `metadata`, `gpuSkipped`,
`calibration` and `runs` are the browser export, unchanged; `comparisons` and
`summary` are derived from `runs` by the processor and can be regenerated from them.

## Results

Each group is compared with CPU seeds 1–20 over 2 scenarios × 5 windows × 33 series.
"Ratio" is |difference| / bound over the 212 series either side used; the other 118
are unused slots, zero on both sides.

| Group (seeds) | Failures / 330 | Largest ratio | Median ratio | Largest total difference | Median 90 % detectable |
|---|---|---|---|---|---|
| CPU calibration (21–40) | 0 | 0.575 | 0.131 | 1.14 particles | 3.7 % |
| PCG-keyed CPU control (1001–1020) | 0 | 0.471 | 0.098 | 1.26 particles | 3.6 % |
| GPU (1001–1020) | **0** | 0.487 | 0.099 | 1.27 particles | — |

Both controls meet the sensitivity requirement (median 90 % detectable difference
at most 5 % over slots above 20 particles), so the gate could have caught a
difference that changes the look. The browser's CPU groups reproduce the Node
preview recorded in the plan (largest calibration ratio 57 %, totals within 1.1
particles), so Firefox and V8 in Node give the same CPU reference.

The GPU's closest comparisons are the same series as the PCG-keyed control's, with
nearly the same differences (for example, occupancy window 4, slot 5: GPU 423.00 and
control 422.79 against the CPU's 417.68). With the same random keys and free order
the GPU behaves like the CPU; the remaining spread is ordinary seed variation, and
the `cos()` precision difference found in the
[spawn check](2026-11-14-gpu-spawn.json) does not show up in occupancy.

## Scope

This clears only the occupancy gate. The exact allocation, ownership, motion and
lifecycle checks still apply, as do Task 4's visual comparison and the separate
performance acceptance. It authorizes no production GPU migration.
