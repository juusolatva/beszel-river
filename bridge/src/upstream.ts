/** A hub connection lost for this long dries up every stream; a hub restart (about 12 s) does not. */
export const UPSTREAM_GRACE_MS = 30_000;

/**
 * Debounced view of the hub connection. Without it, a hub that went away or a token that expired
 * would leave the river flowing on its last values until the bridge restarted.
 */
export class UpstreamWatch {
  /** Starts live: the bridge only begins checking after its first successful connect. */
  live = true;
  private lostAt: number | null = null;

  constructor(
    private readonly connected: () => boolean,
    private readonly graceMs = UPSTREAM_GRACE_MS,
  ) {}

  /** Reads the connection at `now` (ms); returns whether `live` changed. Live again at once, lost only after `graceMs`. */
  update(now = Date.now()): boolean {
    if (this.connected()) {
      this.lostAt = null;
      if (this.live) return false;
      this.live = true;
      return true;
    }
    this.lostAt ??= now;
    if (!this.live || now - this.lostAt < this.graceMs) return false;
    this.live = false;
    return true;
  }
}
