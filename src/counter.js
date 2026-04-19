// Port of the validated Python counting logic.
// Validated on IMG_4146.MOV (truth=22) against Python-generated Y trace:
//   sigma_s = 0.03, prom_frac = 0.03, min_dist_s = 0.35 → count=23 (±1 OK)
//
// Unlike the Python version (which post-processes the full trajectory), this
// operates on a rolling ring buffer so it works in real time.
//
// Call `push(frameIdx, y)` every frame. Call `getCount()` at any time.
// Call `reset()` when the ball hits the ground.

const DEFAULTS = {
  fps: 30,
  sigmaS: 0.03,    // gaussian smoothing sigma in seconds
  promFrac: 0.03,  // prominence as fraction of y-range
  minDistS: 0.35,  // minimum seconds between juggles (~170 bpm max)
  bufferS: 4,      // rolling buffer length in seconds
};

export class JuggleCounter {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.reset();
  }

  reset() {
    this.count = 0;
    this.lastJuggleFrame = -Infinity;
    this.yBuffer = []; // { frame, y }
    this.lastReportedPeakFrame = -Infinity;
  }

  push(frameIdx, y) {
    const bufLen = Math.ceil(this.cfg.fps * this.cfg.bufferS);
    this.yBuffer.push({ frame: frameIdx, y });
    if (this.yBuffer.length > bufLen) this.yBuffer.shift();
    this._detect();
  }

  _gaussianSmooth(arr, sigma) {
    // 1D gaussian kernel; radius = 3*sigma
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const kernel = new Float32Array(radius * 2 + 1);
    let ksum = 0;
    for (let i = -radius; i <= radius; i++) {
      const w = Math.exp(-(i * i) / (2 * sigma * sigma));
      kernel[i + radius] = w;
      ksum += w;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;

    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let s = 0, wsum = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = i + k;
        if (j < 0 || j >= arr.length) continue;
        const w = kernel[k + radius];
        s += arr[j] * w;
        wsum += w;
      }
      out[i] = s / wsum;
    }
    return out;
  }

  _detect() {
    if (this.yBuffer.length < 8) return;

    // Build a uniform-frame array (fill gaps via linear interp)
    const first = this.yBuffer[0].frame;
    const last = this.yBuffer[this.yBuffer.length - 1].frame;
    const N = last - first + 1;
    const y = new Float32Array(N);

    // Linear interpolation
    let bi = 0;
    for (let i = 0; i < N; i++) {
      const f = first + i;
      while (bi + 1 < this.yBuffer.length && this.yBuffer[bi + 1].frame <= f) bi++;
      const a = this.yBuffer[bi];
      const b = this.yBuffer[Math.min(bi + 1, this.yBuffer.length - 1)];
      if (b.frame === a.frame) {
        y[i] = a.y;
      } else {
        const t = (f - a.frame) / (b.frame - a.frame);
        y[i] = a.y + t * (b.y - a.y);
      }
    }

    const sigma = Math.max(1.0, this.cfg.fps * this.cfg.sigmaS);
    const ys = this._gaussianSmooth(y, sigma);

    // Find peaks (maxima in Y = ball at lowest point = foot contact).
    // In real-time mode, we look for a confirmed peak: a point whose neighbours
    // on both sides are lower and is at least minDist frames from the last one.
    const minDistFrames = Math.max(3, Math.floor(this.cfg.fps * this.cfg.minDistS));
    let yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < ys.length; i++) {
      if (ys[i] < yMin) yMin = ys[i];
      if (ys[i] > yMax) yMax = ys[i];
    }
    const yRange = yMax - yMin;
    const prominence = Math.max(3, yRange * this.cfg.promFrac);

    // Confirm peaks with a small lookahead (3 frames) — this adds ~100ms latency
    // but avoids counting the same peak twice.
    const lookahead = 3;
    for (let i = lookahead; i < ys.length - lookahead; i++) {
      const absFrame = first + i;
      if (absFrame - this.lastReportedPeakFrame < minDistFrames) continue;

      // Is this a local max in [i-lookahead, i+lookahead]?
      let isMax = true;
      for (let k = -lookahead; k <= lookahead; k++) {
        if (k === 0) continue;
        if (ys[i + k] > ys[i]) { isMax = false; break; }
      }
      if (!isMax) continue;

      // Prominence check: difference to the local minimum in the window
      let localMin = ys[i];
      for (let k = -minDistFrames; k <= minDistFrames; k++) {
        const j = i + k;
        if (j < 0 || j >= ys.length) continue;
        if (ys[j] < localMin) localMin = ys[j];
      }
      if (ys[i] - localMin < prominence) continue;

      // Confirmed peak
      this.count += 1;
      this.lastJuggleFrame = absFrame;
      this.lastReportedPeakFrame = absFrame;
      this.onJuggle?.(absFrame);
    }
  }

  getCount() { return this.count; }
}
