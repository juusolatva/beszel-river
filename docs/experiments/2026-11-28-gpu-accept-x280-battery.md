# GPU acceptance run 1: X280 on battery, Chrome and Firefox — 2026-11-28

**Result: on battery the GPU path cuts callback work as much as on AC, in both browsers, but saves no battery
power.** With 10,000 particles it does 70–76 % less callback work than the CPU path, and 27–48 % less at a limit
of 2,500. With an empty pool the two paths cost the same. Occupancy parity passed in all 72 runs and every final
state matched its validation replay. Whole-laptop battery power is the same within noise in every cell. The one
difference beyond noise goes the other way: in Chrome at full screen with 10,000 particles, the GPU path drew
about 0.5 W more (+4 %). One cell misses the
[gate](../PLAN.md#gpu-production-proposal--2026-11-28) on one count: a single missed display period, described
under "Gate" below.

## Runs

`test/gpu-sequence.html` (README, "GPU performance benchmark"), the proposal's acceptance run 1: workloads
`dense-10000`, `dense-2500` and `drained`, both viewports, three repetitions with CPU/GPU order alternating,
30 s warmup (60 s for `drained`), 60 s measured, seed 42, capacity 10,000, no discovery or schedule replays:
36 runs per browser. Commit `a83faf3` (`main` after #156). Both browsers ran headed on the X280 itself
(Fedora 44, UHD Graphics 620, 60 Hz), on battery from 100 %, screen brightness at minimum, with nothing else
running. A script pressed Continue and switched to full screen, as in the AC runs, and logged
`/sys/class/power_supply/BAT0` every 5 s.

| Set | Conditions as entered | Renderer as reported | Viewports (framebuffer @ DPR) | Runs | Span (UTC) | Battery |
|---|---|---|---|---|---|---|
| Chrome 158 | X280, on battery, screen brightness at minimum, powersave governor, Google Chrome 158, visible window driven over CDP, idle PC | ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6) | 1155×770, full 1921×1080 @ 1.20 | 36/36 | 08:12–09:35 | 100 → 68 % (12.4 Wh in 83 min, 9.0 W mean) |
| Firefox 161 | X280, on battery, same, Firefox 161 with privacy.reduceTimerPrecision off, visible window driven over WebDriver BiDi, kiosk mode for full screen, idle PC | Intel(R) HD Graphics 400, or similar (masked by Firefox) | 1152×768, full 1920×1080 @ 1.20 | 36/36 | 12:05–13:28 | 100 → 63 % (14.4 Wh in 85 min, 10.2 W mean) |

Raw exports, unchanged except for a final newline: `2026-11-28-gpu-accept-x280-battery-chrome`
([`.json`](2026-11-28-gpu-accept-x280-battery-chrome.json), [`.md`](2026-11-28-gpu-accept-x280-battery-chrome.md))
and `2026-11-28-gpu-accept-x280-battery-firefox`
([`.json`](2026-11-28-gpu-accept-x280-battery-firefox.json), [`.md`](2026-11-28-gpu-accept-x280-battery-firefox.md)).
Power logs: [Chrome](2026-11-28-gpu-accept-x280-battery-chrome-power.csv),
[Firefox](2026-11-28-gpu-accept-x280-battery-firefox-power.csv) (Unix ms, `power_now` µW, `energy_now` µWh,
capacity %).

## Callback work

Median of the three per-run values in ms, CPU / GPU, with the range in brackets where the runs differ.

| Viewport | Workload | Chrome median | Chrome p95 | Firefox median | Firefox p95 |
|---|---|---|---|---|---|
| 960×640 | dense-10000 | 6.1 (6.0–6.1) / 1.6 (1.5–1.6) (−74 %) | 7.3 (7.1–7.6) / 2.0 (−73 %) | 6.46 (6.34–6.48) / 1.76 (1.66–1.76) (−73 %) | 7.74 (7.14–8.18) / 2.26 (2.16–2.34) (−71 %) |
| 960×640 | dense-2500 | 2.7 (2.5–2.8) / 1.6 (1.5–1.6) (−41 %) | 3.6 (3.3–3.6) / 2.0 (−44 %) | 2.82 (2.48–2.84) / 1.68 (1.60–1.68) (−40 %) | 3.56 (2.90–3.62) / 2.20 (2.12–2.24) (−38 %) |
| 960×640 | drained | 0.8 / 0.8 (±0 %) | 1.0 / 1.0 (±0 %) | 1.00 (0.98–1.00) / 1.00 (0.98–1.02) (±0 %) | 1.30 (1.22–1.36) / 1.40 (1.22–1.42) (+8 %) |
| full | dense-10000 | 6.6 / 1.6 (−76 %) | 8.6 (8.6–8.8) / 2.1 (−76 %) | 6.50 (6.38–6.52) / 1.96 (1.94–1.98) (−70 %) | 7.78 (7.60–8.42) / 2.50 (−68 %) |
| full | dense-2500 | 3.1 (3.0–3.1) / 1.6 (1.5–1.6) (−48 %) | 3.9 (3.9–4.0) / 2.1 (−46 %) | 2.58 (2.56–2.58) / 1.88 (1.76–1.88) (−27 %) | 3.46 (2.98–3.62) / 2.40 (2.24–2.46) (−31 %) |
| full | drained | 0.8 / 0.8 (±0 %) | 1.1 / 1.1 (±0 %) | 1.08 (1.04–1.08) / 1.06 (1.04–1.06) (−2 %) | 1.62 (1.62–1.64) / 1.64 (1.40–1.66) (+1 %) |

- **Dense pool:** the battery savings match the AC runs (Chrome −69 to −76 %, Firefox −61 to −67 % on
  [2026-11-24](2026-11-24-gpu-task6-x280-ac.md)); Firefox gains a little more on battery.
- **Limit 2,500:** Chrome −41 to −48 % (AC −46 to −52 % on [2026-11-27](2026-11-27-gpu-horizon-x280-ac.md)),
  Firefox −27 to −40 % (AC −25 to −28 %).
- **Empty pool:** equal in both browsers. The Firefox `drained` p95 values are higher on the GPU path at
  960×640 (+8 %), within overlapping run ranges.
- **Missed display periods:** Firefox's CPU path missed 1–2 in five of its six `dense-10000` runs (7 in all);
  its GPU path missed none. Chrome missed one, in its last run (full, `drained`, GPU); none elsewhere.

Chrome GPU time per step (`EXT_disjoint_timer_query_webgl2`, median of run medians, ms, CPU / GPU): 960×640
`dense-10000` 2.46 / 2.81, `dense-2500` 2.20 / 2.52, `drained` 1.96 / 1.96; full 3.56 / 3.19, 3.16 / 2.88,
2.73 / 2.77. Firefox has no timer extension.

## Battery power

Mean `power_now` in W over each run's measured minute, estimated as warmup + 10 s to warmup + 60 s after the run
started (the export has no measurement timestamps, so the first 10 s are left out for page load), 9–10 samples
per run. Median of three runs, CPU / GPU, range in brackets.

| Viewport | Workload | Chrome | Firefox |
|---|---|---|---|
| 960×640 | dense-10000 | 8.57 (8.02–8.69) / 8.58 (7.93–8.63) (±0 %) | 9.94 (6.23–9.97) / 9.56 (8.69–9.80) (−4 %) |
| 960×640 | dense-2500 | 8.20 (8.19–8.35) / 8.44 (8.31–8.72) (+3 %) | 10.78 (8.32–11.07) / 9.43 (8.36–9.68) (−12 %) |
| 960×640 | drained | 8.11 (8.03–8.11) / 8.06 (8.05–8.18) (−1 %) | 9.51 (9.37–10.29) / 9.99 (9.29–10.68) (+5 %) |
| full | dense-10000 | 11.55 (11.46–11.96) / 12.06 (12.02–12.09) (+4 %) | 15.66 (12.01–15.89) / 15.32 (14.86–15.74) (−2 %) |
| full | dense-2500 | 11.14 (11.13–11.64) / 11.43 (11.35–11.46) (+3 %) | 12.67 (11.21–14.00) / 12.19 (11.25–14.43) (−4 %) |
| full | drained | 10.94 (10.89–10.96) / 10.97 (10.95–11.19) (±0 %) | 14.18 (12.25–14.21) / 14.28 (10.81–14.55) (+1 %) |

- **No saving:** every Firefox cell and all but one Chrome cell have overlapping ranges. The exception is Chrome
  full `dense-10000`, where the GPU path drew 0.5 W more with the ranges apart. Taking 4.5 ms of simulation off
  the CPU each frame does not show up in whole-laptop power: the display, the trail passes and the rest of the
  system dominate it, and the powersave governor already runs the CPU slowly.
- **Viewport and browser cost more than the backend:** full screen draws about 3 W more than 960×640 in Chrome
  and 3–5 W more in Firefox, and Firefox draws 1.5–4 W more than Chrome in the same cell. Its readings also
  spread more (up to 3.7 W between repetitions).
- **Limits:** `power_now` is whole-system power as the battery's firmware reports it; windows are estimated, not
  taken from the export. Differences below about 0.5 W in Chrome and 2 W in Firefox are within the spread
  between repetitions.

## Gate

The proposal's gate for run 1: no cell where the GPU path's median or p95 callback work exceeds the CPU path's
beyond its run-to-run range; occupancy parity in every gated run; no more missed display periods than the CPU
path.

- **Callback work:** passed in every cell of both browsers. The only cells where the GPU path is higher at all
  are Firefox `drained` p95 (+8 % and +1 %), with overlapping ranges.
- **Occupancy parity:** 72 of 72 gated runs passed; every final state matched its validation replay.
- **Missed display periods:** passed in Firefox (GPU 0, CPU 7) and in five of Chrome's six cells. **Chrome full
  `drained`: GPU 1, CPU 0.** One period in 3,602 callbacks, in the set's last run, in a cell where both
  paths do the same callback work (0.8 ms median, 1.1 ms p95) and draw nothing after the active horizon.
  Strictly this misses the gate; it is recorded here for the user's decision.

## What this settles

- Acceptance run 1 is done. The callback-work and parity gates pass; the missed-period result above awaits a
  decision.
- The case for the GPU default is callback headroom and missed display periods (Firefox's CPU path missed 7,
  its GPU path none), not battery life: on this laptop the GPU path draws the same power, and 4 % more in
  Chrome at full screen with a dense pool.
- Not measured: thermal behaviour, and power on a phone (acceptance run 2).
