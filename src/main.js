// Entry point. Wires detector → tracker → counter + ground-reset + UI + recording.
const _v = "?v=15";
const { BallDetector } = await import("./detector.js" + _v);
const { BallTracker } = await import("./tracker.js" + _v);
const { JuggleCounter } = await import("./counter.js" + _v);
const { GroundResetDetector } = await import("./ground.js" + _v);

const $ = (id) => document.getElementById(id);

// ---------- Debug logger ----------
// Each session is mirrored to a private GitHub Gist owned by the user. The
// PAT (scope: gist) lives in localStorage on the phone — never in the repo.
// The agent reads logs by calling the GitHub API for that user's gists.
const GIST_DESC_PREFIX = "juggle-debug";
const debug = {
  log: [],
  stats: { fps: 0, yolo: 0, flow: 0, extrap: 0, miss: 0, juggles: 0, frames: 0 },
  _gistId: null,
  _gistDirty: false,
  _gistFlushTimer: null,
  _pat: null,
  initRemote() {
    this._pat = localStorage.getItem("ghPat") || null;
    if (!this._pat) return;
    // Create a fresh gist for this session
    fetch("https://api.github.com/gists", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this._pat}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        description: `${GIST_DESC_PREFIX} ${new Date().toISOString()}`,
        public: false,
        files: { "log.txt": { content: "(session starting)\n" } },
      }),
    }).then(r => r.json()).then(g => {
      this._gistId = g.id;
      console.log("debug gist:", g.html_url);
      this._scheduleFlush();
    }).catch(e => console.warn("gist create failed", e));
  },
  _scheduleFlush() {
    if (!this._gistId || !this._pat) return;
    this._gistDirty = true;
    if (this._gistFlushTimer) return;
    this._gistFlushTimer = setTimeout(() => {
      this._gistFlushTimer = null;
      if (!this._gistDirty) return;
      this._gistDirty = false;
      const body = this.fullDump();
      fetch(`https://api.github.com/gists/${this._gistId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${this._pat}`,
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({ files: { "log.txt": { content: body } } }),
      }).catch(e => console.warn("gist patch failed", e));
    }, 1500);
  },
  push(msg) {
    const ts = ((performance.now() - this.t0) / 1000).toFixed(1);
    const line = `${ts}s ${msg}`;
    this.log.push(line);
    if (this.log.length > 400) this.log.shift();
    this.render();
    this._scheduleFlush();
  },
  bump(k) { this.stats[k] = (this.stats[k] || 0) + 1; this._scheduleFlush(); },
  set(k, v) { this.stats[k] = v; this._scheduleFlush(); },
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
debug.initRemote();
debug.push(`====== SESSION START ${new Date().toISOString()} ua=${navigator.userAgent.slice(0,60)} ======`);

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
  debug.push(`upload: ${file.name} ${file.type} ${(file.size/1e6).toFixed(1)}MB`);
  els.video.srcObject = null;
  els.video.src = URL.createObjectURL(file);
  els.video.loop = false;
  els.video.muted = true;
  els.video.playsInline = true;
  els.video.style.transform = "none";

  // Wait for metadata so videoWidth/Height are set
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("metadata timeout 8s")), 8000);
    els.video.addEventListener("loadedmetadata", () => { clearTimeout(t); resolve(); }, { once: true });
    els.video.addEventListener("error", (e) => { clearTimeout(t); reject(new Error("video error")); }, { once: true });
  }).catch(e => debug.push(`meta err: ${e.message}`));
  debug.push(`meta: ${els.video.videoWidth}x${els.video.videoHeight} dur=${els.video.duration?.toFixed(1)}s rs=${els.video.readyState}`);

  try {
    await els.video.play();
    // Slow down playback so on-device WebGPU can hit every frame.
    // (Real-time camera doesn't have this luxury — file mode only.)
    els.video.playbackRate = 0.25;
    debug.push(`play() ok, paused=${els.video.paused} rs=${els.video.readyState} rate=${els.video.playbackRate}`);
  } catch (e) {
    debug.push(`play() ERR: ${e.message}`);
    alert("Couldn't play that video on iOS Safari: " + e.message);
    return;
  }

  els.startScreen.classList.add("hidden");
  startProcessing();
}

function sizeOverlay() {
  const v = els.video;
  els.overlay.width = v.videoWidth || 1280;
  els.overlay.height = v.videoHeight || 720;
}

function startProcessing() {
  debug.push(`startProcessing: video ${els.video.videoWidth}x${els.video.videoHeight} rs=${els.video.readyState}`);
  running = true;
  frameIdx = 0;
  counter.reset();
  ground.reset();
  tracker.reset();
  els.count.textContent = "0";
  sizeOverlay();
  requestAnimationFrame(loop);
  // Belt-and-braces: confirm rAF is firing
  setTimeout(() => debug.push(`1s: frames=${debug.stats.frames}`), 1000);
  setTimeout(() => debug.push(`5s: frames=${debug.stats.frames}`), 5000);
  setTimeout(() => debug.push(`15s: frames=${debug.stats.frames}`), 15000);
}

let _waitLogged = false;
let _firstLoop = true;
async function loop(ts) {
  if (_firstLoop) { debug.push(`loop: first tick`); _firstLoop = false; }
  if (!running) { debug.push(`loop: !running, exit`); return; }
  if (els.video.readyState < 2) {
    if (!_waitLogged) { debug.push(`waiting on video rs=${els.video.readyState}`); _waitLogged = true; }
    requestAnimationFrame(loop);
    return;
  }
  if (_waitLogged) { debug.push(`video ready rs=${els.video.readyState}`); _waitLogged = false; }

  if (els.overlay.width !== els.video.videoWidth) sizeOverlay();

  const dt = lastFrameTs ? (ts - lastFrameTs) : 33;
  lastFrameTs = ts;
  fpsEMA = 0.9 * fpsEMA + 0.1 * (1000 / Math.max(1, dt));

  if (frameIdx < 3) debug.push(`f${frameIdx}: pre-track`);
  const t0 = performance.now();
  let pos;
  try {
    pos = await tracker.track(els.video, frameIdx);
  } catch (e) {
    debug.push(`track ERR f${frameIdx}: ${e.message}`);
    requestAnimationFrame(loop);
    return;
  }
  const elapsed = performance.now() - t0;
  if (frameIdx < 3) debug.push(`f${frameIdx}: track ok ${elapsed.toFixed(0)}ms src=${pos?.source||"none"}`);

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

// PAT input
function refreshPatStatus() {
  const el = document.getElementById("pat-status");
  if (!el) return;
  const pat = localStorage.getItem("ghPat");
  el.textContent = pat ? `PAT set (…${pat.slice(-4)})` : "no PAT — logs local only";
  el.style.color = pat ? "#3ecf8e" : "#5a6478";
}
document.getElementById("pat-save")?.addEventListener("click", () => {
  const v = document.getElementById("pat-input").value.trim();
  if (!v) return;
  localStorage.setItem("ghPat", v);
  document.getElementById("pat-input").value = "";
  refreshPatStatus();
  alert("PAT saved. Reload to start a new logging session.");
});
document.getElementById("pat-clear")?.addEventListener("click", () => {
  localStorage.removeItem("ghPat");
  refreshPatStatus();
});
refreshPatStatus();

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
