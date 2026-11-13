# GPU occupancy investigation — 2026-11-13

The rejected Task 3 result is reproducible. Its dominant cause is comparing
different random realizations in a saturated, stream-prioritized pool. The
investigation found no request, free-rank allocation or live-ownership error in
these fixtures. A separate spawn-rounding boundary difference remains observable.
**The original acceptance gate still fails; Task 4 remains stopped.**

## Method

[`gpu-occupancy.browser.ts`](../../frontend/test/gpu-occupancy.browser.ts) runs the
unchanged GPU implementation and five CPU controls. It uses the original two
plain/filament scenarios: capacity and limit 10,000, seed 42, aspect 1.5,
Float32(0.1) steps, 60 simulated seconds, expansion 1 → 4 → 32 at 15/30 seconds,
and the same five-second windows starting at 10, 25, 45, 50 and 55 seconds.

The CPU controls change only the random source and/or free-list ordering through
test-only private-state access. Production CPU math, spawning rates and motion
remain unchanged. The PCG control uses the shader's uint32 arithmetic, top-24-bit
conversion and seed/index/generation/birth-counter key. Generation is always one
in these expansion-only scenarios. The ascending control rebuilds its free stack
so spawning pops the lowest inactive index, as the GPU prefix scan does. This
test-only sorting, state copying and synchronous readback are not runtime or
performance proposals.

For every callback, an independent request/carry calculation is checked against
the GPU commands. Every particle's previous active flag, free rank, birth counter
and new owner are then checked against the expected accepted request interval.
Existing live owners must remain unchanged. Births are counted even if they die
in that callback. The full raw results are in
[`2026-11-13-gpu-occupancy.json`](2026-11-13-gpu-occupancy.json).

## Results

All 330 original CPU/GPU/seed-43 control window means reproduce exactly, including
the 43 GPU failures and 49 different-seed CPU failures. All 12,000,000 particle
allocation decisions pass; 132,298 GPU births were accepted across 1,200 callbacks.

| Comparison | Failed five-second comparisons / 330 |
| --- | ---: |
| Original GPU vs original CPU | 43 |
| CPU seed 43 vs original CPU seed 42 | 49 |
| CPU ascending free order only vs original CPU | 0 |
| CPU PCG only, original LIFO order vs original CPU | 45 |
| CPU PCG + ascending order vs original CPU | 44 |
| GPU vs CPU PCG + ascending order | 0 |

Each row uses the unchanged `max(5 particles, 5% of the comparison CPU mean)`
bound. For the last row, that comparison CPU is the diagnostic PCG/ascending
control, **not** the frozen reference; passing it does not satisfy the gate.

Changing free-slot order alone leaves every per-stream CPU count identical on
every callback. With the CPU's sequential random source, particle storage index
does not choose the random draws. The GPU's random key includes the storage index
and birth counter, so its free order changes which draws each accepted birth gets.
Matching both choices removes all window failures. The filament control matches
every active identity and per-stream count on all 600 callbacks. In the plain
control the largest window-mean difference is 3.44 particles.

## Why saturation makes the differences large

Requests exceed available room on 486/600 plain callbacks and 519/600 filament
callbacks. During the final 15 seconds, each of the 32 streams requests 674
births. In the GPU plain run, slot 0 receives all 674 while slot 31 receives only
11; in the filament run, slot 31 receives only 4. The original CPU also prioritizes
early streams: slot 31 receives only 5 plain births and 2 filament births in that
interval. This is the specified CPU-style stream-index priority, not a GPU
allocation omission. The raw results retain all per-stream accepted counts.

Random lifetimes, speeds and spawn positions determine deaths. Those deaths
determine the room left for later streams at the next callback. Slightly
different death histories therefore produce quite different populations in the
late streams even when total occupancy agrees. A five-second average does not
remove this effect: adjacent counts share the same surviving particles and are
strongly correlated. The different-seed CPU control independently demonstrates
that the fixed bound can reject the unchanged CPU implementation against itself.

## Remaining rounding difference

The first active-state mismatch in the matched plain control occurs at simulated
6.5000000969 s, particle index 674, on a birth. CPU spawn x is
−0.09998229146; GPU spawn x is −0.10000331700, a difference of about 0.0000210.
The GPU immediately kills the birth at the −0.1 boundary; the CPU keeps it. Both
lifetimes are 8.5031852722 s. This is a Float32 shader spawn calculation versus
CPU double calculation crossing a strict death boundary, before motion runs.
The trace identifies the boundary effect, not a particular driver's individual
transcendental operation as its cause.

That one discrepancy changes subsequent free-slot reuse and random keys. The
paired control is consequently no longer a particle-for-particle trajectory
comparison after this point, though all its occupancy windows remain within the
original numeric bound. Motion-only tests with injected identical starting
states do not cover independently calculated spawn positions. Exact lifetime
and boundary rules should remain tested with injected state; matching separate
spawn calculations bit-for-bit is a different requirement.

## Next decision

No production or prototype behavior was changed, and no tolerance was relaxed.
These results explain this failed candidate; they do not establish distribution
equivalence across seeds, browsers or hardware, or make a performance claim.

Before resuming Task 4, revise the validation plan explicitly: retain exact
allocation/ownership checks and common-input motion/death checks, and specify a
separate multi-seed distribution comparison calibrated against CPU-vs-CPU
variation. Fix its seed set, windows, statistics and rejection criteria before
collecting acceptance results. For any later paired performance comparison,
control the workload so random occupancy differences cannot masquerade as a
speedup. Changing allocation fairness would alter the CPU reference's behavior
and needs its own design decision; it is not a repair demonstrated by this
investigation.

Verification: headless Firefox 160 executed the diagnostic; a separate comparison
of its raw output with the historical artifact confirmed exact reproduction of
all original means. Typecheck, build and 368 unit tests with coverage passed;
frontend coverage used the established local 15 s timeout for the CPU drain
tests, with all thresholds unchanged. The production asset remains
`index-wbx5Usbf.js`. Local review checked the control's PRNG, free-list mutation,
generation-one assumption, birth-before-death counting and result attribution.
