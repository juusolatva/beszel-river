# GPU active horizon: X280 on AC, Chrome and Firefox — 2026-11-27

**Result: the active horizon removes the GPU path's empty-pool penalty and makes sparse pools cheaper,
in both browsers.** With no particles alive, the GPU path's callback work now matches the CPU path's
(Chrome +0 to +14 %, Firefox −2 to +2 %, medians). On 2026-11-24, without the horizon, it cost 43–63 % more.
At a fixed limit of 2,500 the GPU path saves 46–52 % of callback work in Chrome and 25–28 % in Firefox.
Every gated run passed occupancy parity, and every final state matched its validation replay. These are AC
runs on one laptop; the phone replay at limit 2,500, where the GPU path cost 14 % more, is still to do.

## Runs

`test/gpu-sequence.html` (README, "GPU performance benchmark"), focused plan from the
[active-horizon item](../PLAN.md#prototype-review--2026-11-25): workloads `dense-2500` (new, opt-in),
`dense-1000` and `drained`, both viewports, three repetitions with CPU/GPU order alternating, 30 s warmup,
60 s measured, seed 42, capacity 10,000, no discovery or schedule replays: 36 runs per browser. Commit
`b335fc0`: `main` at `a162cae` (with #146 and #147) plus the `dense-2500` workload. Both browsers ran headed
on the X280 itself (Fedora 44, UHD Graphics 620, 60 Hz), on AC with the battery at 91 %, with nothing else
running. A script pressed Continue and switched to full screen, as on 2026-11-24.

| Set | Conditions as entered | Renderer as reported | Viewports (framebuffer @ DPR) | Runs | Span (UTC) |
|---|---|---|---|---|---|
| Chrome 158 | X280, on AC, powersave governor with balance_performance EPP, Google Chrome 158, visible window driven over CDP, idle PC | ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6) | 1155×770, full 1921×1080 @ 1.20 | 36/36 | 19:11–20:21 |
| Firefox 161 | X280, on AC, same governor, Firefox 161 with privacy.reduceTimerPrecision off, visible window driven over WebDriver BiDi, kiosk mode for full screen, idle PC | Intel(R) HD Graphics 400, or similar (masked by Firefox) | 1152×768, full 1920×1080 @ 1.20 | 36/36 | 20:23–21:33 |

Firefox moved from 160 to 161 since the 2026-11-24 runs; Chrome is the same version. Raw exports,
unchanged except for a final newline: `2026-11-27-gpu-horizon-x280-ac-chrome`
([`.json`](2026-11-27-gpu-horizon-x280-ac-chrome.json), [`.md`](2026-11-27-gpu-horizon-x280-ac-chrome.md)) and
`2026-11-27-gpu-horizon-x280-ac-firefox` ([`.json`](2026-11-27-gpu-horizon-x280-ac-firefox.json),
[`.md`](2026-11-27-gpu-horizon-x280-ac-firefox.md)).

## Callback work

Median of the three per-run values in ms, CPU / GPU, with the range in brackets where the runs differ. The
2026-11-24 columns are the [runs on `7deb629`](2026-11-24-gpu-task6-x280-ac.md), before #146 (idle-scan skip
and other small changes) and #147 (the horizon); they had no `dense-2500` workload.

| Viewport | Workload | Chrome 11-24 | Chrome now | Firefox 11-24 | Firefox now |
|---|---|---|---|---|---|
| 960×640 | dense-2500 | — | 2.5 (2.1–2.5) / 1.2 (1.2–1.4) (−52 %) | — | 2.10 (2.02–2.20) / 1.52 (1.44–1.62) (−28 %) |
| 960×640 | dense-1000 | 1.7 / 1.4 (−18 %) | 1.7 (1.7–1.8) / 1.2 (1.2–1.4) (−29 %) | 1.68 / 1.64 (−2 %) | 1.68 / 1.52 (1.34–1.54) (−10 %) |
| 960×640 | drained | 0.7 / 1.0 (+43 %) | 0.7 (0.6–0.7) / 0.7 (0.6–0.7) (±0 %) | 0.92 / 1.50 (+63 %) | 0.88 / 0.86 (−2 %) |
| full | dense-2500 | — | 2.6 (2.3–2.8) / 1.4 (−46 %) | — | 2.36 (2.36–2.46) / 1.78 (1.64–1.78) (−25 %) |
| full | dense-1000 | 1.9 / 1.6 (−16 %) | 1.7 / 1.4 (−18 %) | 1.94 / 1.84 (−5 %) | 1.88 (1.80–1.94) / 1.62 (1.60–1.64) (−14 %) |
| full | drained | 0.8 / 1.2 (+50 %) | 0.7 / 0.8 (+14 %) | 1.10 / 1.66 (+51 %) | 0.98 (0.96–1.06) / 1.00 (0.96–1.08) (+2 %) |

Callback p95, CPU / GPU:

| Viewport | Workload | Chrome 11-24 | Chrome now | Firefox 11-24 | Firefox now |
|---|---|---|---|---|---|
| 960×640 | dense-2500 | — | 3.5 / 1.7 (−51 %) | — | 2.84 / 2.08 (−27 %) |
| 960×640 | dense-1000 | 2.4 / 2.0 (−17 %) | 2.4 / 1.5 (−37 %) | 2.22 / 2.18 (−2 %) | 2.24 / 2.10 (−6 %) |
| 960×640 | drained | 0.9 / 1.4 (+56 %) | 0.9 / 0.9 (±0 %) | 1.22 / 2.04 (+67 %) | 1.34 / 1.16 (−13 %) |
| full | dense-2500 | — | 3.7 / 2.0 (−46 %) | — | 2.86 / 2.26 (−21 %) |
| full | dense-1000 | 2.8 / 2.2 (−21 %) | 2.6 / 2.0 (−23 %) | 2.34 / 2.28 (−3 %) | 2.56 / 2.04 (−20 %) |
| full | drained | 1.1 / 1.6 (+45 %) | 1.0 / 1.1 (+10 %) | 1.46 / 2.12 (+45 %) | 1.48 / 1.40 (−5 %) |

- **Empty pool:** the GPU path's extra 0.3–0.6 ms is gone. The CPU medians are unchanged from 2026-11-24
  (Chrome 0.7–0.8 ms, Firefox 0.9–1.1 ms), so the change is on the GPU side. With the limit at zero for longer
  than the drain deadline, the horizon reaches 0 and a step does no scan, feedback or draw.
- **Sparse pools:** at limit 1,000 the GPU path saves 0.2–0.5 ms more than on 2026-11-24; in Firefox it went
  from roughly even to 10–14 % cheaper.
- **Limit 2,500:** a clear gain in both browsers, with no overlap between the backends' ranges. The phone's
  CPU-schedule replay at this limit, which cost 14 % more with the GPU path at 960×640 before the horizon,
  has not been rerun.
- **Missed display periods:** 2 in one Chrome GPU run (960×640, `dense-2500`), none elsewhere.

## GPU time (Chrome)

Median GPU execution time per step in ms (`EXT_disjoint_timer_query_webgl2`; Firefox has none), split into
simulation and rendering:

| Viewport | Workload | GPU-path simulation 11-24 | GPU-path simulation now | Rendering now, CPU / GPU per run |
|---|---|---|---|---|
| 960×640 | dense-2500 | — | 0.11, 0.10, 0.28 | 2.13, 2.24, 2.26 / 1.98, 2.00, 2.10 |
| 960×640 | dense-1000 | 0.53, 0.52, 0.39 | 0.09, 0.07, 0.07 | 2.13, 2.14, 2.13 / 2.05, 1.99, 2.00 |
| 960×640 | drained | 0.54, 0.54, 0.45 | 0.00, 0.00, 0.00 | 1.96, 1.96, 1.97 / 1.96, 1.96, 1.96 |
| full | dense-2500 | — | 0.15, 0.15, 0.09 | 5.23, 4.73, 2.75 / 3.15, 3.16, 2.55 |
| full | dense-1000 | 0.29, 0.22, 0.29 | 0.07, 0.33, 0.07 | 4.64, 4.64, 4.64 / 4.41, 3.61, 4.35 |
| full | drained | 0.21, 0.28, 0.28 | 0.00, 0.00, 0.00 | 2.33, 3.37, 3.30 / 3.67, 2.41, 2.69 |

- **Simulation:** the GPU path's per-run median simulation time fell from 0.2–0.5 ms to 0.07–0.33 ms, and to
  zero with an empty pool. Slower steps remain: per-run p95 is 0.2–1.1 ms and p99 0.2–3.0 ms with particles
  alive. The export does not say which steps those are, so they cannot be attributed to the scan, which runs
  only on steps with birth requests.
- **Rendering at full screen:** the per-run times change between about 2.4 and 5.2 ms on both backends in the
  same cell, without a pattern by backend or order. The full-screen GPU `dense-1000` rendering
  is 3.6–4.4 ms now against 2.4 ms on 2026-11-24, while the CPU path's rendering in the same cell was 4.6 ms
  both times. The horizon only lowers the instances drawn, and the trail passes dominate at full screen, so this
  reads as the GPU's clock mode, not a cost the change added. Compare GPU time per run, not across sets.

## What this settles

- The active horizon's acceptance runs in Chrome and Firefox on the X280 are done: it targets both measured GPU
  regressions, and the X280 one (empty pool) is gone. The phone CPU-schedule replay, asked for "if available",
  remains.
- **Radix-16 scan:** not pursued for now. Per-run simulation medians stay below 0.35 ms of GPU time, the GPU
  path's callback work is well below the CPU path's, and these runs missed 2 display periods in all. They do not
  show whether the slower steps (p95 up to 1.1 ms, p99 up to 3.0 ms) are scan steps; revisit if phone GPU time
  or missed periods point there.
