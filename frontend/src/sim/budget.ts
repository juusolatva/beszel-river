/** Slowest display refresh assumed, s: a steady 11 fps is a slow device, not an 11 Hz screen. */
const MAX_PERIOD = 1 / 30;
/** Frames this much slower than the display period count as overloaded, but never faster than 45 fps. */
const SLOW = 1.5;
const SLOW_FLOOR = 1 / 45;
/** Frames within this factor of the period count as keeping up, and so does anything from 55 fps. */
const FAST = 1.2;
const FAST_FLOOR = 1 / 55;
/** Intervals longer than this are pauses (tab switch, debugger), not load, s. */
const PAUSE = 0.25;

/**
 * Live particle limit for devices that cannot draw the whole pool. After 2 s of frames well behind the
 * display it drops by a fifth, down to a quarter of the pool; after 10 s of keeping up it rises by a
 * tenth again, and each drop doubles that wait (up to 2 min).
 *
 * The display period is the fastest frame interval seen, at most 1/30 s, so a 30 Hz display or a
 * throttled browser is not taken for overload. A page starts with an empty pool, so its first frames
 * show the display's own rate. It never creeps back up: that would follow an overloaded device down
 * and stop seeing the overload. Switching to a 30 Hz power-saving mode mid-session can therefore thin
 * the river, at most to the quarter-pool floor.
 */
export class ParticleBudget {
  limit: number;
  private period = MAX_PERIOD;
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

  /** Feeds one frame interval, s; returns whether the limit changed. */
  update(interval: number): boolean {
    if (this.fixed || interval <= 0 || interval > PAUSE) return false;
    this.period = Math.min(this.period, interval);

    if (interval > Math.max(SLOW * this.period, SLOW_FLOOR)) {
      this.slowTime += interval;
      this.fastTime = 0;
    } else {
      this.slowTime = Math.max(0, this.slowTime - interval);
      this.fastTime = interval < Math.max(FAST * this.period, FAST_FLOOR) ? this.fastTime + interval : 0;
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
