# GPU occupancy investigation — 2026-11-13

The rejected Task 3 result is reproducible. The controls demonstrate sensitivity
to random sequence and free-slot ordering in a saturated pool. The investigation
found no request, free-rank allocation or live-ownership error in these fixtures.
The plain-run control also diverges in its spawn calculation, so it does not
isolate randomness as the sole or dominant cause of that failed comparison.
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
in that callback. Browser results with a derived summary are retained in
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
With both choices matched, all five-second means pass the diagnostic bound.
The filament control matches every active identity and per-stream count on all
600 callbacks, isolating the random sequence and slot mapping in that scenario.
The plain control differs on 485/600 callbacks and 50,594 particle identity
comparisons; its largest window-mean difference is 3.44 particles. Passing means
do not make that control an exact reconstruction or establish a sole cause.

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

## Unresolved spawn-calculation difference

The first active-state mismatch in the matched plain control occurs at simulated
6.5000000969 s, particle index 674, on a birth. CPU spawn x is
−0.09998229146; GPU spawn x is −0.10000331700, a difference of about 0.0000210.
The GPU immediately kills the birth at the −0.1 boundary; the CPU keeps it. Both
lifetimes are 8.5031852722 s. This establishes a spawn-calculation discrepancy
crossing a strict death boundary before motion runs. It does not identify why
the calculations differ. The gap is about 2,800 Float32 ulps at magnitude 0.1;
attributing it to ordinary rounding at the final x store is unsupported.
Intermediate arithmetic, transcendental precision and draw-path agreement need
separate checks. The recorded values alone cannot distinguish those causes.

That one discrepancy changes subsequent free-slot reuse and random keys. The
paired control is consequently no longer a particle-for-particle trajectory
comparison after this point, though all its occupancy windows remain within the
original numeric bound. Motion-only tests with injected identical starting
states do not cover independently calculated spawn positions. Exact lifetime
and boundary rules should remain tested with injected state; matching separate
spawn calculations bit-for-bit is a different requirement.

## Next decision

No production or prototype behavior was changed, and no tolerance was relaxed.
These results narrow the investigation; they do not establish distribution
equivalence across seeds, browsers or hardware, or make a performance claim.

Before resuming Task 4, isolate the plain spawn discrepancy by comparing draw
values and intermediate spawn calculations for identical birth keys. Then
revise the validation plan explicitly: retain exact
allocation/ownership checks and common-input motion/death checks, and specify a
separate multi-seed distribution comparison calibrated against CPU-vs-CPU
variation. Fix its seed set, windows, statistics and rejection criteria before
collecting acceptance results. For any later paired performance comparison,
control the workload so random occupancy differences cannot masquerade as a
speedup. Changing allocation fairness would alter the CPU reference's behavior
and needs its own design decision; it is not a repair demonstrated by this
investigation.

## Reproduction and provenance

The browser function returns only measured `metadata` and `results`. Export it
as JSON, then run the committed `frontend/test/summarize_gpu_occupancy.py` processor
as described in README. The processor compares the complete historical window
key set and all original CPU/GPU/seed-43 means, calculates the table totals and
adds `summary`. It exits unsuccessfully if reproduction differs and rejects
missing, extra, duplicate or nonfinite windows. The metadata, including renderer,
is copied verbatim from the browser; it is neither hard-coded nor hardware
performance evidence. Earlier manually appended date/source labels have been
removed from the retained artifact. The artifact is processed evidence, not
unmodified browser output.

Verification: headless Firefox 160 executed the diagnostic. The committed
processor was run on that retained browser export and confirmed exact
reproduction of all original means; its four unit tests also pass. Typecheck,
build and 368 unit tests with coverage passed;
frontend coverage used the established local 15 s timeout for the CPU drain
tests, with all thresholds unchanged. The production asset remains
`index-wbx5Usbf.js`. Local review checked the control's PRNG, free-list mutation,
generation-one assumption, birth-before-death counting and result attribution.
