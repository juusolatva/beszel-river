# CPU lowest free slot: X280 on AC, Chrome and Firefox — 2026-11-28

**Result: accepted.** After a budget drop from the full pool to 2,500, taking the lowest free slot cuts callback work
by 17–24 % in three of four cells (Chrome full screen: −4 %, ranges overlapping) and by 27 % in Firefox's verification,
and uploads 78 KB per callback instead of 312 KB. A full pool costs the same. A first version slowed Firefox's full pool by about 5 % (p95 11 %) because its step loop
called a method on every death; with that call inlined the full pool costs the same as before (Firefox +0.04 ms
median, p95 equal; Chrome within noise). Change: [PLAN, "Lowest free slot"](../PLAN.md); found by an external
performance review (finding 1.1).

## Setup

`test/gpu-sequence.html` with "GPU prototype runs" cleared (CPU only), headed on the X280 itself (Fedora 44, UHD
Graphics 620, 60 Hz), on AC at 100 %, nothing else running, browsers driven over CDP (Chrome 158) and WebDriver BiDi
(Firefox 161, `privacy.reduceTimerPrecision` off, kiosk mode for full screen). 30 s warmup, 60 s measured, seed 42,
capacity 10,000. Both variants ran the same harness from the branch; only `frontend/src/sim/particles.ts` differed:
"old" is `main`'s (`ee633e4`, a stack of freed slots), "new" the branch's.

Workloads: `dense-10000` (a full pool, where the allocator should change nothing) and the new `drop-2500` (the full
pool, then the limit drops to 2,500 at 15 s, measured from 30 s, after every particle from before the drop has died).

## 1. Paired sets: old against the first version

Four 12-run sets (two workloads, both viewports, three repetitions), Chrome old then new, then Firefox new then old.
The new code here is the first version, which freed slots through a `releaseSlot()` call in the step loop.
Callback work in ms, old → new: median of the three runs (range), then p95.

| Browser | Viewport | Workload | Median | p95 | Upload per callback |
|---|---|---|---|---|---|
| Chrome | 960×640 | dense-10000 | 5.1 (5.1–5.4) → 5.2 (4.9–5.3), +2 % | 7.0 → 7.0 | 312 → 312 KB |
| Chrome | 960×640 | drop-2500 | 2.9 (2.8–3.0) → 2.2 (2.2–2.5), −24 % | 3.9 → 3.1, −21 % | 312 → 78 KB |
| Chrome | full | dense-10000 | 5.0 (4.8–5.0) → 5.0 (4.9–5.2), 0 % | 6.9 → 7.1 | 312 → 312 KB |
| Chrome | full | drop-2500 | 2.8 (2.7–2.8) → 2.7 (2.5–2.8), −4 % | 4.0 → 3.8, −5 % | 312 → 78 KB |
| Firefox | 960×640 | dense-10000 | 4.56 (4.20–5.14) → 4.76 (4.58–4.78), +4 % | 6.66 → 7.18, +8 % | 312 → 312 KB |
| Firefox | 960×640 | drop-2500 | 3.00 (2.90–3.72) → 2.50 (2.26–2.68), −17 % | 3.98 → 3.20, −20 % | 312 → 78 KB |
| Firefox | full | dense-10000 | 4.40 (4.32–4.52) → 4.64 (4.64–4.74), +5 % | 6.42 → 7.14, +11 % | 312 → 312 KB |
| Firefox | full | drop-2500 | 3.24 (3.20–3.26) → 2.52 (2.48–2.56), −22 % | 4.00 → 3.02, −25 % | 312 → 78 KB |

All 48 runs completed; one run missed a display period (Firefox, old, `dense-10000`, 960×640). Firefox's full-pool
cell got slower with ranges apart, but its new set ran first, straight after an hour of Chrome runs, and its old set
last, after a 20-minute idle gap, so drift could explain it.

## 2. Tie-break: Firefox `dense-10000`, full screen, alternating

Six single runs, old and new alternating (old, new, old, new, old, new), laptop temperature 49–66 °C.

| | Old | New (first version) |
|---|---|---|
| Callback median | 4.44, 4.50, 4.30 ms | 4.62, 4.66, 6.16 ms |
| p95 | 6.48, 6.54, 6.44 ms | 7.16, 7.18, 7.60 ms |

Every new run was slower than every old run, so the slowdown was real. The step loop's death branch had gained a
`releaseSlot()` method call; Firefox runs this loop slower with any call left in it, as Task 3 found for the centre
lookup. The bit operations are now inline in the loop.

## 3. Verification of the inlined version, alternating

Single runs in the balanced order old, new, new, old (old, new for the last Firefox pair of dense runs), at full
screen.

| Browser | Workload | Old | New (inlined) | Median, p95 |
|---|---|---|---|---|
| Firefox | dense-10000 | 4.34, 4.38, 4.38 ms; p95 6.42–6.48 | 4.42, 4.48, 4.42 ms; p95 6.32–6.48 | 4.38 → 4.42 (+1 %), 6.46 → 6.46 |
| Firefox | drop-2500 | 3.32, 3.26 ms; p95 4.02, 3.96 | 2.38, 2.40 ms; p95 2.84, 2.84 | −27 %, −29 % |
| Chrome | dense-10000 | 5.0, 5.4 ms; p95 7.1, 7.5 | 5.0, 5.0 ms; p95 7.1, 7.1 | −4 %, −3 % (ranges overlap) |

All 14 runs completed with no missed display periods. The full pool is back to the stack's cost: in Firefox the
median differs by 0.04 ms and the p95 not at all, against +5 % and +11 % before the inlining.

## Files

Raw exports, unchanged except for a final newline: the paired sets
`2026-11-28-cpu-sequence-x280-ac-{chrome,firefox}-lfs-{old,new}` ([chrome old](2026-11-28-cpu-sequence-x280-ac-chrome-lfs-old.json),
[chrome new](2026-11-28-cpu-sequence-x280-ac-chrome-lfs-new.json), [firefox old](2026-11-28-cpu-sequence-x280-ac-firefox-lfs-old.json),
[firefox new](2026-11-28-cpu-sequence-x280-ac-firefox-lfs-new.json), each with its `.md` ledger rows). The tie-break and
verification ran one sequence per run; their exports are collected unchanged, in run order, in
`2026-11-28-cpu-tiebreak-x280-ac` ([`.json`](2026-11-28-cpu-tiebreak-x280-ac.json), [`.md`](2026-11-28-cpu-tiebreak-x280-ac.md)) and
`2026-11-28-cpu-verify-x280-ac` ([`.json`](2026-11-28-cpu-verify-x280-ac.json), [`.md`](2026-11-28-cpu-verify-x280-ac.md)).

## Harness note

The first submissions in each browser came back empty: a finished sequence's state stays in local storage, and the page
then shows its results instead of setting up the form, so a fill after the load found no form. Clearing the stored
state before reloading, then waiting for the form, fixed it. No run was affected; the empty submissions started nothing.
