/** Slowest display refresh assumed, s: a steady 11 fps is a slow device, not an 11 Hz screen. */
const MAX_PERIOD = 1 / 30;
/** Frames this much slower than the display period count as overloaded, but never faster than 45 fps. */
const SLOW = 1.5;
const SLOW_FLOOR = 1 / 45;
/** Frames within this factor of the period count as keeping up, and so does anything from 55 fps. */
const FAST = 1.2;
const FAST_FLOOR = 1 / 55;
/** Leave time for browser and GPU work beyond the callback; recover only with more headroom. */
const WORK_SLOW = 0.7;
const WORK_FAST = 0.5;
/** Intervals longer than this are pauses (tab switch, debugger), not load, s. */
const PAUSE = 0.25;

/**
 * Live particle limit for devices that cannot draw the whole pool. After 2 s of callback work above
 * 70% of the display period or frames well behind the display, it drops by a fifth, down to a quarter
 * of the pool; after 10 s of keeping up with work below 50% of the period it rises by a
 * tenth again, and each drop doubles that wait (up to 2 min). A drop only stops spawning, and the
 * particles above the new limit live on for up to `LOOK.lifeRange` s, so slow frames count only once
 * they are gone; otherwise one overload would cut the limit several times over.
 *
 * The display period is the fastest confirmed cadence, at most 1/30 s. Three similar faster intervals
 * confirm a new cadence, so one timing glitch cannot poison it. A page starts with an empty pool, so
 * its first frames show the display's own rate. It never creeps back up: that would follow an
 * overloaded device down and stop seeing the overload. Switching to a 30 Hz power-saving mode
 * mid-session can therefore thin the river, at most to the quarter-pool floor.
 */
export class ParticleBudget {
  limit: number;
  private period = MAX_PERIOD;
  private candidatePeriod = MAX_PERIOD;
  private candidateSamples = 0;
  private slowTime = 0;
  private fastTime = 0;
  /** Seconds of keeping up before a rise; doubles on every drop, so the limit settles instead of swinging. */
  private raiseAfter = 10;

  constructor(
    private readonly capacity: number,
    /** `?particles=N` asks for an exact count, so the limit stays put. */
    private readonly fixed: boolean,
  ) {
    this.limit = capacity;
  }

  /** Feeds frame interval and callback work in seconds, plus live count; reports a limit change. */
  update(interval: number, live: number, workSeconds: number): boolean {
    if (this.fixed || !Number.isFinite(interval) || interval <= 0 || !Number.isFinite(workSeconds) || workSeconds < 0) return false;
    if (interval > PAUSE) {
      // Separate sustained-load windows on either side of a hidden tab or debugger stop.
      this.slowTime = 0;
      this.fastTime = 0;
      this.candidateSamples = 0;
      return false;
    }
    // Require a repeatable faster cadence; one short callback gap must not poison the budget.
    if (interval < this.period) {
      if (this.candidateSamples > 0 && Math.abs(interval - this.candidatePeriod) <= this.candidatePeriod * 0.1) this.candidateSamples++;
      else {
        this.candidatePeriod = interval;
        this.candidateSamples = 1;
      }
      if (this.candidateSamples >= 3) {
        this.period = Math.min(this.period, this.candidatePeriod);
        this.candidateSamples = 0;
      }
    } else this.candidateSamples = 0;

    if (workSeconds > WORK_SLOW * this.period || interval > Math.max(SLOW * this.period, SLOW_FLOOR)) {
      if (live <= this.limit) this.slowTime += interval;
      this.fastTime = 0;
    } else {
      this.slowTime = Math.max(0, this.slowTime - interval);
      this.fastTime = workSeconds < WORK_FAST * this.period && interval < Math.max(FAST * this.period, FAST_FLOOR) ? this.fastTime + interval : 0;
    }

    const before = this.limit;
    if (this.slowTime > 2) {
      this.limit = Math.max(Math.round(this.limit * 0.8), Math.round(this.capacity / 4));
      this.slowTime = 0;
      this.raiseAfter = Math.min(this.raiseAfter * 2, 120);
    } else if (this.fastTime > this.raiseAfter && this.limit < this.capacity) {
      this.limit = Math.min(Math.round(this.limit * 1.1), this.capacity);
      this.fastTime = 0;
    }
    return this.limit !== before;
  }

  /** Brightness factor that keeps a thinned river about as bright as a full one. */
  get intensityScale(): number {
    return Math.min(Math.sqrt(this.capacity / this.limit), 2);
  }
}
