// 3-tier ball tracker: YOLO → Lucas-Kanade optical flow → velocity fallback.
// Mirrors the Python pipeline. Requires OpenCV.js (window.cv).

export class BallTracker {
  constructor(detector, opts = {}) {
    this.detector = detector;
    this.maxFlowFrames = opts.maxFlowFrames ?? 30;
    this.maxVelFrames = opts.maxVelFrames ?? 2;
    this.workW = opts.workW ?? 480;
    this.cv = null;
    this.ready = false;
    this.reset();
  }

  async init(onProgress) {
    if (this.ready) return;
    onProgress?.("loading OpenCV…");
    if (!window.cv || !window.cv.Mat) {
      await new Promise((resolve) => {
        const check = () => {
          if (window.cv && window.cv.Mat) return resolve();
          if (window.cv) window.cv.onRuntimeInitialized = resolve;
          else setTimeout(check, 100);
        };
        check();
      });
    }
    this.cv = window.cv;
    this.workCanvas = document.createElement("canvas");
    this.workCtx = this.workCanvas.getContext("2d", { willReadFrequently: true });
    this.ready = true;
    onProgress?.("OpenCV ready");
  }

  reset() {
    this.history = [];
    this.prevGray = null;
    this.prevPt = null;
    this.flowStreak = 0;
    this.missStreak = 0;
  }

  _grabGray(source) {
    const w = source.videoWidth || source.width;
    const h = source.videoHeight || source.height;
    const scale = this.workW / w;
    const dw = this.workW;
    const dh = Math.round(h * scale);
    if (this.workCanvas.width !== dw || this.workCanvas.height !== dh) {
      this.workCanvas.width = dw;
      this.workCanvas.height = dh;
    }
    this.workCtx.drawImage(source, 0, 0, dw, dh);
    const imgData = this.workCtx.getImageData(0, 0, dw, dh);
    const src = this.cv.matFromImageData(imgData);
    const gray = new this.cv.Mat();
    this.cv.cvtColor(src, gray, this.cv.COLOR_RGBA2GRAY);
    src.delete();
    return { gray, scale };
  }

  _releasePrev() {
    if (this.prevGray) {
      this.prevGray.delete();
      this.prevGray = null;
    }
  }

  async track(source, frameIdx) {
    if (!this.ready) return null;
    const cv = this.cv;

    const det = await this.detector.detect(source);
    const { gray, scale } = this._grabGray(source);

    if (det) {
      const p = { frame: frameIdx, cx: det.cx, cy: det.cy, conf: det.conf, source: "yolo" };
      this._releasePrev();
      this.prevGray = gray;
      this.prevPt = [det.cx * scale, det.cy * scale];
      this.flowStreak = 0;
      this.missStreak = 0;
      this.history.push(p);
      if (this.history.length > 60) this.history.shift();
      return p;
    }

    // YOLO miss — try optical flow from last known anchor.
    if (!this.prevGray || !this.prevPt || this.flowStreak >= this.maxFlowFrames) {
      gray.delete();
      return this._velocityFallback(frameIdx);
    }

    const prevPts = cv.matFromArray(1, 1, cv.CV_32FC2, [this.prevPt[0], this.prevPt[1]]);
    const nextPts = new cv.Mat();
    const status = new cv.Mat();
    const err = new cv.Mat();
    const winSize = new cv.Size(21, 21);
    const criteria = new cv.TermCriteria(
      cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 10, 0.03
    );
    cv.calcOpticalFlowPyrLK(
      this.prevGray, gray, prevPts, nextPts, status, err, winSize, 3, criteria
    );

    const ok = status.data[0] === 1;
    const errVal = err.data32F[0];
    let result = null;

    if (ok && errVal < 20) {
      const nx = nextPts.data32F[0];
      const ny = nextPts.data32F[1];
      result = {
        frame: frameIdx,
        cx: nx / scale,
        cy: ny / scale,
        conf: 0,
        source: "flow",
      };
      this._releasePrev();
      this.prevGray = gray;
      this.prevPt = [nx, ny];
      this.flowStreak++;
      this.history.push(result);
      if (this.history.length > 60) this.history.shift();
    } else {
      gray.delete();
    }

    prevPts.delete();
    nextPts.delete();
    status.delete();
    err.delete();

    return result || this._velocityFallback(frameIdx);
  }

  _velocityFallback(frameIdx) {
    this.missStreak++;
    if (this.missStreak > this.maxVelFrames) return null;
    if (this.history.length < 2) return null;
    const a = this.history[this.history.length - 2];
    const b = this.history[this.history.length - 1];
    const df = b.frame - a.frame;
    if (df <= 0 || df > 4) return null;
    const vx = (b.cx - a.cx) / df;
    const vy = (b.cy - a.cy) / df;
    const dt = frameIdx - b.frame;
    return {
      frame: frameIdx,
      cx: b.cx + vx * dt,
      cy: b.cy + vy * dt,
      conf: 0,
      source: "extrap",
    };
  }
}
