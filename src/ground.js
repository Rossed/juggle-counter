// Ground-reset detector.
//
// Triggers a reset when the ball appears to have hit the floor. Heuristics:
//   1. Ball Y-center is in the bottom 12% of the frame for a sustained period
//      (>= 400ms), AND the vertical speed has dropped near zero.
//   2. Ball has been missing for more than `missResetMs` — implies it rolled
//      out of frame after hitting the ground.
//
// Both signals are intentionally conservative so the count doesn't reset mid-juggle.

const DEFAULTS = {
  bottomFrac: 0.12,       // bottom 12% of the frame is "floor zone"
  stillMs: 400,           // must be in floor zone this long
  stillSpeedPxPerSec: 80, // max vertical speed to still count as "still"
  // Miss-based reset disabled. At low fps the detector legitimately loses the
  // ball for several seconds during normal juggling, which was firing false
  // resets. Floor-zone reset (below) still catches genuine ground-hits.
  missResetMs: Number.POSITIVE_INFINITY,
  cooldownMs: 2500,       // don't double-fire resets
};

export class GroundResetDetector {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.reset();
  }

  reset() {
    this.floorEntryMs = 0;
    this.lastSeenMs = 0;
    this.lastResetMs = -Infinity;
    this.history = []; // { ts, y }
  }

  // Returns true if a reset should fire now.
  update({ ts, frameHeight, pos }) {
    if (this.lastSeenMs === 0) this.lastSeenMs = ts;
    if (ts - this.lastResetMs < this.cfg.cooldownMs) {
      if (pos) this.lastSeenMs = ts;
      return false;
    }

    if (pos) {
      this.lastSeenMs = ts;
      const inFloorZone = pos.cy > frameHeight * (1 - this.cfg.bottomFrac);
      this.history.push({ ts, y: pos.cy });
      while (this.history.length && ts - this.history[0].ts > this.cfg.stillMs * 2) {
        this.history.shift();
      }

      if (inFloorZone) {
        if (!this.floorEntryMs) this.floorEntryMs = ts;
        const sustained = ts - this.floorEntryMs >= this.cfg.stillMs;

        // Measure speed over the window
        if (sustained && this.history.length >= 2) {
          const a = this.history[0];
          const b = this.history[this.history.length - 1];
          const dtSec = Math.max(0.001, (b.ts - a.ts) / 1000);
          const speed = Math.abs(b.y - a.y) / dtSec;
          if (speed < this.cfg.stillSpeedPxPerSec) {
            this.lastResetMs = ts;
            this.floorEntryMs = 0;
            this.history = [];
            return true;
          }
        }
      } else {
        this.floorEntryMs = 0;
      }
    } else {
      // Missing: check miss timeout
      if (ts - this.lastSeenMs >= this.cfg.missResetMs) {
        this.lastResetMs = ts;
        this.floorEntryMs = 0;
        this.history = [];
        return true;
      }
    }

    return false;
  }
}
