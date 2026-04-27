// Entry point. Wires detector → tracker → counter + ground-reset + UI + recording.
const _v = "?v=4";
const { BallDetector } = await import("./detector.js" + _v);
const { BallTracker } = await import("./tracker.js" + _v);
const { JuggleCounter } = await import("./counter.js" + _v);
const { GroundResetDetector } = await import("./ground.js" + _v);

const $ = (id) => document.getElementById(id);

// ---------- Debug logger ----------
const debug = {
  log: [],
  stats: { fps: 0, yolo: 0, flow: 0, extrap: 0, miss: 0, juggles: 0, frames: 0 },
  push(msg) {
    const ts = ((performance.now() - this.t0) / 1000).toFixed(1);
    const line = `${ts}s ${msg}`;
    this.log.push(line);
    if (this.log.length > 400) this.log.shift();
    this.render();
  },
  bump(k) { this.stats[k] = (this.stats[k] || 0) + 1; },
  set(k, v) { this.stats[k] = v; },
  render() {
    const panel = document.getElementById("debug-panel");
    if (panel.classList.contains("hidden")) return;
    const s = this.stats;
    document.getElementById("debug-stats").textContent =
      `fps=${s.fps.toFixed(1)} provider=${s.provider||"?"} ` +
      `frames=${s.frames} yolo=${s.yolo} flow=${s.flow} ` +
      `extrap=${s.extrap} miss=${s.miss} juggles=${s.juggles}`;
    document.getElementById("debug-log").textContent = this.log.slice(-15).join("\n");
  },
  fullDump() {
    const s = this.stats;
    return `JUGGLE COUNTER DEBUG LOG\n` +
      `ua: ${navigator.userAgent}\n` +
      `provider: ${s.provider}\n` +
      `final stats: ${JSON.stringify(s, null, 2)}\n\n` +
      `--- events ---\n${this.log.join("\n")}\n`;
  },
  t0: performance.now(),
};
window._debug = debug;

const els = {
  startScreen: $("start-screen"),
  startBtn:    $("start-btn"),
  uploadInput: $("upload-input"),
  modelLoad:   $("model-load"),
  video:       $("video"),
  overlay:     $("overlay"),
  count:       $("count"),
  status:      $("status"),
  resetBtn:    $("reset-btn"),
  recordBtn:   $("record-btn"),
  stopBtn:     $("stop-btn"),
};

const detector = new BallDetector();
const tracker  = new BallTracker(detector);
const counter  = new JuggleCounter({ fps: 30 });
const ground   = new GroundResetDetector();

let running = false;
let frameIdx = 0;
let lastFrameTs = 0;
let fpsEMA = 30;
let recorder = null;
let recordedChunks = [];

counter.onJuggle = (frame) => {
  els.count.textContent = counter.getCount();
  els.count.style.transform = "scale(1.15)";
  setTimeout(() => (els.count.style.transform = "scale(1)"), 120);
  if (navigator.vibrate) navigator.vibrate(30);
  debug.bump("juggles");
  debug.push(`JUGGLE #${counter.getCount()} @frame=${frame}`);
};

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle("error", isError);
}

async function initModel() {
  try {
    debug.push("loading YOLO model");
    await detector.load("model/yolov8n.onnx", (m) => {
      els.modelLoad.textContent = m;
      debug.push(`model: ${m}`);
    });
    debug.set("provider", detector.provider);
    debug.push(`provider=${detector.provider}`);
    els.modelLoad.textContent = "Loading OpenCV…";
    await tracker.init((m) => {
      els.modelLoad.textContent = m;
      debug.push(`opencv: ${m}`);
    });
    els.modelLoad.textContent = `Model ready ✓ (${detector.provider})`;
    els.startBtn.disabled = false;
  } catch (err) {
    els.modelLoad.textContent = `Model load failed: ${err.message}`;
    debug.push(`ERR: ${err.message}`);
    console.error(err);
  }
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    els.video.srcObject = stream;
    await els.video.play();
    els.startScreen.classList.add("hidden");
    startProcessing();
  } catch (err) {
    alert(`Camera access failed: ${err.message}\n\n` +
          "On iPhone you must open this page in Safari over HTTPS.");
    console.error(err);
  }
}

async function startVideoFile(file) {
  els.video.srcObject = null;
  els.video.src = URL.createObjectURL(file);
  els.video.loop = false;
  els.video.muted = true;
  els.video.style.transform = "none"; // don't mirror uploaded videos
  await els.video.play();
  els.startScreen.classList.add("hidden");
  startProcessing();
}

function sizeOverlay() {
  const v = els.video;
  els.overlay.width = v.videoWidth || 1280;
  els.overlay.height = v.videoHeight || 720;
}

function startProcessing() {
  running = true;
  frameIdx = 0;
  counter.reset();
  ground.reset();
  tracker.reset();
  els.count.textContent = "0";
  sizeOverlay();
  requestAnimationFrame(loop);
}

async function loop(ts) {
  if (!running) return;
  if (els.video.readyState < 2) { requestAnimationFrame(loop); return; }

  if (els.overlay.width !== els.video.videoWidth) sizeOverlay();

  const dt = lastFrameTs ? (ts - lastFrameTs) : 33;
  lastFrameTs = ts;
  fpsEMA = 0.9 * fpsEMA + 0.1 * (1000 / Math.max(1, dt));

  const pos = await tracker.track(els.video, frameIdx);

  debug.bump("frames");
  if (pos) {
    debug.bump(pos.source);
    counter.push(frameIdx, pos.cy);
  } else {
    debug.bump("miss");
  }
  debug.set("fps", fpsEMA);
  if (frameIdx % 30 === 0) debug.render();
  drawOverlay(pos);

  // Ground reset
  if (ground.update({
    ts,
    frameHeight: els.video.videoHeight,
    pos: pos || null,
  })) {
    counter.reset();
    els.count.textContent = "0";
    setStatus("reset — ball on ground");
  } else {
    setStatus(`${fpsEMA.toFixed(0)} fps · ${detector.provider || "?"} · ${pos ? pos.source : "no ball"}`);
  }

  frameIdx += 1;
  requestAnimationFrame(loop);
}

function drawOverlay(pos) {
  const ctx = els.overlay.getContext("2d");
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  if (!pos) return;
  const r = 24;
  ctx.strokeStyle = pos.source === "yolo" ? "#3ecf8e" : "#ffb400";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(pos.cx, pos.cy, r, 0, Math.PI * 2);
  ctx.stroke();
}

function stopAll() {
  running = false;
  const s = els.video.srcObject;
  if (s) s.getTracks().forEach((t) => t.stop());
  els.video.srcObject = null;
  els.video.pause();
  if (recorder && recorder.state === "recording") recorder.stop();
  els.startScreen.classList.remove("hidden");
}

function toggleRecording() {
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    return;
  }
  // Composite video + overlay into a stream from the overlay canvas
  // (ideal would be a mixed stream; for PoC we record the overlay canvas on
  // top of a video element snapshot every frame via a mix canvas)
  const mix = document.createElement("canvas");
  mix.width = els.video.videoWidth;
  mix.height = els.video.videoHeight;
  const mctx = mix.getContext("2d");
  const drawMix = () => {
    if (!recorder || recorder.state !== "recording") return;
    mctx.drawImage(els.video, 0, 0);
    mctx.drawImage(els.overlay, 0, 0);
    mctx.font = "bold 64px -apple-system, sans-serif";
    mctx.fillStyle = "#3ecf8e";
    mctx.textAlign = "center";
    mctx.fillText(counter.getCount(), mix.width / 2, 80);
    requestAnimationFrame(drawMix);
  };

  const stream = mix.captureStream(30);
  recordedChunks = [];
  recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
  recorder.ondataavailable = (e) => e.data.size && recordedChunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: "video/webm" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `juggles_${counter.getCount()}.webm`;
    a.click();
    els.recordBtn.textContent = "⏺ Record";
    els.recordBtn.classList.remove("record-active");
  };
  recorder.start();
  drawMix();
  els.recordBtn.textContent = "⏹ Stop Rec";
  els.recordBtn.classList.add("record-active");
}

// Wire up UI
els.startBtn.addEventListener("click", startCamera);
els.uploadInput.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) startVideoFile(f);
});
els.resetBtn.addEventListener("click", () => {
  counter.reset();
  els.count.textContent = "0";
  setStatus("manual reset");
});
els.recordBtn.addEventListener("click", toggleRecording);
els.stopBtn.addEventListener("click", stopAll);

// Debug overlay wiring
document.getElementById("debug-toggle").addEventListener("click", () => {
  document.getElementById("debug-panel").classList.toggle("hidden");
  debug.render();
});
document.getElementById("debug-share").addEventListener("click", async () => {
  const text = debug.fullDump();
  const blob = new Blob([text], { type: "text/plain" });
  const file = new File([blob], `juggle-debug-${Date.now()}.txt`, { type: "text/plain" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "Juggle debug log" });
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      alert("Log copied to clipboard");
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = file.name;
      a.click();
    }
  } catch (e) {
    console.error(e);
    alert("Share failed: " + e.message);
  }
});

els.startBtn.disabled = true;
initModel();
