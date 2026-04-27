// YOLOv8n ball detector using ONNX Runtime Web.
// Class 32 = "sports ball" in COCO.

const BALL_CLASS = 32;
const IMG_SIZE = 480;          // 480² runs ~1.8x faster than 640² on WebGPU
const CONF_THRESHOLD = 0.2;
const IOU_THRESHOLD = 0.45;

export class BallDetector {
  constructor() {
    this.session = null;
    this.canvas = document.createElement("canvas");
    this.canvas.width = IMG_SIZE;
    this.canvas.height = IMG_SIZE;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
  }

  async load(modelUrl, onProgress) {
    onProgress?.("loading model…");
    ort.env.wasm.simd = true;
    ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
    ort.env.wasm.wasmPaths =
      "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/";

    // Prefer WebGPU (iOS 18+, Chrome/Edge desktop) — ~5-10x faster than WASM.
    // Fall back to WASM if unavailable or fails to initialize.
    const tryProviders = async (providers) => {
      this.session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: providers,
        graphOptimizationLevel: "all",
      });
    };

    let provider = "wasm";
    this.providerError = null;
    if ("gpu" in navigator) {
      try {
        onProgress?.("requesting GPU adapter…");
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
          this.providerError = "no GPU adapter (flag off?)";
        } else {
          onProgress?.("trying WebGPU…");
          await tryProviders(["webgpu"]);
          provider = "webgpu";
        }
      } catch (e) {
        this.providerError = `webgpu err: ${e.message}`;
        console.warn("WebGPU init failed, falling back to WASM:", e);
        this.session = null;
      }
    } else {
      this.providerError = "navigator.gpu missing";
    }
    if (!this.session) {
      onProgress?.(`WASM fallback (${this.providerError || "no webgpu"})`);
      await tryProviders(["wasm"]);
    }
    this.provider = provider;
    onProgress?.(`model ready (${provider})`);
  }

  // Preprocess: source frame → letterboxed 640x640 CHW float32 [0,1].
  // Returns { tensor, scale, padX, padY } for post-processing.
  _preprocess(source) {
    const sw = source.videoWidth || source.width;
    const sh = source.videoHeight || source.height;
    const scale = Math.min(IMG_SIZE / sw, IMG_SIZE / sh);
    const dw = Math.round(sw * scale);
    const dh = Math.round(sh * scale);
    const padX = Math.floor((IMG_SIZE - dw) / 2);
    const padY = Math.floor((IMG_SIZE - dh) / 2);

    this.ctx.fillStyle = "rgb(114, 114, 114)"; // YOLO standard letterbox grey
    this.ctx.fillRect(0, 0, IMG_SIZE, IMG_SIZE);
    this.ctx.drawImage(source, padX, padY, dw, dh);
    const { data } = this.ctx.getImageData(0, 0, IMG_SIZE, IMG_SIZE);

    // HWC RGBA uint8 → CHW RGB float32 / 255
    const chw = new Float32Array(3 * IMG_SIZE * IMG_SIZE);
    const plane = IMG_SIZE * IMG_SIZE;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      chw[p] = data[i] / 255;              // R
      chw[plane + p] = data[i + 1] / 255;  // G
      chw[2 * plane + p] = data[i + 2] / 255; // B
    }
    return {
      tensor: new ort.Tensor("float32", chw, [1, 3, IMG_SIZE, IMG_SIZE]),
      scale, padX, padY, sw, sh,
    };
  }

  // Returns the best ball detection for the frame, or null.
  //   { cx, cy, w, h, conf } in source image coords.
  async detect(source) {
    if (!this.session) return null;
    const pre = this._preprocess(source);
    const inputName = this.session.inputNames[0];
    const feeds = { [inputName]: pre.tensor };
    const out = await this.session.run(feeds);
    // YOLOv8 output shape: [1, 84, 8400]  (4 bbox + 80 class scores)
    const outputName = this.session.outputNames[0];
    const pred = out[outputName];
    return this._postprocess(pred, pre);
  }

  _postprocess(pred, pre) {
    const { data, dims } = pred;   // dims = [1, 84, 8400]
    const numBoxes = dims[2];
    const numClasses = dims[1] - 4;
    if (BALL_CLASS >= numClasses) return null;

    const ballScoreOffset = (4 + BALL_CLASS) * numBoxes;
    let bestI = -1, bestScore = CONF_THRESHOLD;
    for (let i = 0; i < numBoxes; i++) {
      const s = data[ballScoreOffset + i];
      if (s > bestScore) { bestScore = s; bestI = i; }
    }
    if (bestI < 0) return null;

    // Un-letterbox to source coords
    const cx_l = data[0 * numBoxes + bestI];
    const cy_l = data[1 * numBoxes + bestI];
    const w_l  = data[2 * numBoxes + bestI];
    const h_l  = data[3 * numBoxes + bestI];
    const cx = (cx_l - pre.padX) / pre.scale;
    const cy = (cy_l - pre.padY) / pre.scale;
    const w  = w_l / pre.scale;
    const h  = h_l / pre.scale;

    // Clip to source bounds
    if (cx < 0 || cy < 0 || cx > pre.sw || cy > pre.sh) return null;
    return { cx, cy, w, h, conf: bestScore };
  }
}
