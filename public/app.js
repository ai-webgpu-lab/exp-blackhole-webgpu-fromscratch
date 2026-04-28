const pipelineConfig = {
  raySteps: 112,
  frameCount: 78,
  bindGroupCount: 2,
  uniformBytes: 256,
  storageBufferKB: 384,
  shaderLineCount: 146,
  workgroupSize: 64,
  renderPasses: 2,
  taaEnabled: true,
  resolutionScale: 0.78
};

const requestedMode = typeof window !== "undefined"
  ? new URLSearchParams(window.location.search).get("mode")
  : null;
const isRealRendererMode = typeof requestedMode === "string" && requestedMode.startsWith("real-");
const REAL_ADAPTER_WAIT_MS = 5000;
const REAL_ADAPTER_LOAD_MS = 20000;

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function findRegisteredRealRenderer() {
  const registry = typeof window !== "undefined" ? window.__aiWebGpuLabRendererRegistry : null;
  if (!registry || typeof registry.list !== "function") return null;
  return registry.list().find((adapter) => adapter && adapter.isReal === true) || null;
}

async function awaitRealRenderer(timeoutMs = REAL_ADAPTER_WAIT_MS) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const adapter = findRegisteredRealRenderer();
    if (adapter) return adapter;
    if (typeof window !== "undefined" && window.__aiWebGpuLabRealBlackholeRawBootstrapError) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

const state = {
  startedAt: performance.now(),
  environment: buildEnvironment(),
  capability: null,
  run: null,
  active: false,
  realAdapterError: null,
  logs: []
};

const elements = {
  statusRow: document.getElementById("status-row"),
  summary: document.getElementById("summary"),
  probeCapability: document.getElementById("probe-capability"),
  runScene: document.getElementById("run-scene"),
  downloadJson: document.getElementById("download-json"),
  canvas: document.getElementById("scene-canvas"),
  metricGrid: document.getElementById("metric-grid"),
  metaGrid: document.getElementById("meta-grid"),
  logList: document.getElementById("log-list"),
  resultJson: document.getElementById("result-json")
};

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function parseBrowser() {
  const ua = navigator.userAgent;
  for (const [needle, name] of [["Edg/", "Edge"], ["Chrome/", "Chrome"], ["Firefox/", "Firefox"], ["Version/", "Safari"]]) {
    const marker = ua.indexOf(needle);
    if (marker >= 0) return { name, version: ua.slice(marker + needle.length).split(/[\s)/;]/)[0] || "unknown" };
  }
  return { name: "Unknown", version: "unknown" };
}

function parseOs() {
  const ua = navigator.userAgent;
  if (/Windows NT/i.test(ua)) return { name: "Windows", version: (ua.match(/Windows NT ([0-9.]+)/i) || [])[1] || "unknown" };
  if (/Mac OS X/i.test(ua)) return { name: "macOS", version: ((ua.match(/Mac OS X ([0-9_]+)/i) || [])[1] || "unknown").replace(/_/g, ".") };
  if (/Linux/i.test(ua)) return { name: "Linux", version: "unknown" };
  return { name: "Unknown", version: "unknown" };
}

function inferDeviceClass() {
  const threads = navigator.hardwareConcurrency || 0;
  const memory = navigator.deviceMemory || 0;
  if (memory >= 16 && threads >= 12) return "desktop-high";
  if (memory >= 8 && threads >= 8) return "desktop-mid";
  if (threads >= 4) return "laptop";
  return "unknown";
}

function buildEnvironment() {
  return {
    browser: parseBrowser(),
    os: parseOs(),
    device: {
      name: navigator.platform || "unknown",
      class: inferDeviceClass(),
      cpu: navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency} threads` : "unknown",
      memory_gb: navigator.deviceMemory || undefined,
      power_mode: "unknown"
    },
    gpu: { adapter: "pending", required_features: [], limits: {} },
    backend: "pending",
    fallback_triggered: false,
    worker_mode: "main",
    cache_state: "warm"
  };
}

function log(message) {
  state.logs.unshift(`[${new Date().toLocaleTimeString()}] ${message}`);
  state.logs = state.logs.slice(0, 12);
  renderLogs();
}

async function probeCapability() {
  if (state.active) return;
  state.active = true;
  render();

  const hasWebGpu = typeof navigator !== "undefined" && Boolean(navigator.gpu);
  const fallbackForced = new URLSearchParams(window.location.search).get("mode") === "fallback";
  const webgpuPath = hasWebGpu && !fallbackForced;
  const adapter = webgpuPath ? "navigator.gpu available" : "canvas-fallback";

  state.capability = {
    hasWebGpu,
    adapter,
    requiredFeatures: webgpuPath ? ["shader-f16", "timestamp-query"] : []
  };
  state.environment.gpu = {
    adapter,
    required_features: state.capability.requiredFeatures,
    limits: webgpuPath ? { maxStorageBufferBindingSize: 134217728, maxBindGroups: 4, maxComputeWorkgroupSizeX: 256 } : {}
  };
  state.environment.backend = webgpuPath ? "webgpu" : "canvas";
  state.environment.fallback_triggered = !webgpuPath;
  state.active = false;

  log(webgpuPath ? "WebGPU path selected for raw blackhole pipeline readiness." : "Fallback path selected for raw blackhole pipeline readiness.");
  render();
}

function simulatePipelineDispatch(frame) {
  const startedAt = performance.now();
  let checksum = 0;
  let branchCount = 0;
  const dispatchGroups = Math.ceil((pipelineConfig.raySteps * pipelineConfig.renderPasses) / pipelineConfig.workgroupSize);

  for (let group = 0; group < dispatchGroups; group += 1) {
    for (let lane = 0; lane < pipelineConfig.workgroupSize; lane += 1) {
      const step = group * pipelineConfig.workgroupSize + lane;
      const rayPhase = frame * 0.017 + step * 0.031;
      const impact = Math.sin(rayPhase) * Math.cos(rayPhase * 0.7);
      const bend = 1 / (1.4 + Math.abs(impact) + (step % 17) * 0.012);
      checksum += bend * 0.004 + impact * 0.0007;
      if (bend > 0.48) branchCount += 1;
    }
  }

  return {
    durationMs: performance.now() - startedAt,
    checksum: round(checksum, 5),
    dispatchGroups,
    branchCount
  };
}

function drawStarField(ctx, width, height, frame) {
  ctx.fillStyle = "#010203";
  ctx.fillRect(0, 0, width, height);

  for (let index = 0; index < 180; index += 1) {
    const x = (index * 97 % width) + Math.sin(index * 0.77 + frame * 0.008) * 3;
    const y = (index * 53 % height) + Math.cos(index * 1.11 + frame * 0.006) * 3;
    const alpha = 0.24 + (index % 11) * 0.045;
    ctx.fillStyle = `rgba(237, 253, 250, ${round(alpha, 3)})`;
    ctx.fillRect(x, y, index % 19 === 0 ? 2 : 1, index % 23 === 0 ? 2 : 1);
  }
}

function drawRawLensingGrid(ctx, cx, cy, radius, frame) {
  ctx.strokeStyle = "rgba(94, 234, 212, 0.2)";
  ctx.lineWidth = 1;
  for (let row = -9; row <= 9; row += 1) {
    ctx.beginPath();
    for (let column = -30; column <= 30; column += 1) {
      const x = column * 18;
      const y = row * 20;
      const dist = Math.max(20, Math.hypot(x, y));
      const warp = (radius * radius / dist) * 0.18;
      const phase = Math.atan2(y, x) + frame * 0.004;
      const px = cx + x + Math.cos(phase + Math.PI / 2) * warp;
      const py = cy + y + Math.sin(phase + Math.PI / 2) * warp * 0.74;
      if (column === -30) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

function drawShaderPasses(ctx, cx, cy, radius, frame) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, 0.38);

  for (let pass = 0; pass < pipelineConfig.renderPasses; pass += 1) {
    const passOffset = pass * 0.018;
    for (let sample = 0; sample < 96; sample += 1) {
      const phase = (sample / 96) * Math.PI * 2 + frame * (0.021 + passOffset);
      const band = sample % 4;
      const diskRadius = 138 + band * 17 + Math.sin(phase * 2.3) * 4;
      const x = Math.cos(phase) * diskRadius;
      const y = Math.sin(phase) * diskRadius;
      const hot = Math.cos(phase) > 0 ? 1 : 0.52;
      const alpha = 0.2 + hot * (pass === 0 ? 0.36 : 0.22);
      ctx.fillStyle = pass === 0 ? `rgba(247, 195, 95, ${round(alpha, 3)})` : `rgba(248, 113, 113, ${round(alpha, 3)})`;
      ctx.beginPath();
      ctx.arc(x, y, 1.9 + band * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

function drawPipelineOverlay(ctx, cx, cy, radius, frame, dispatch) {
  for (let ring = 0; ring < 5; ring += 1) {
    ctx.strokeStyle = ring === 0 ? "rgba(237, 253, 250, 0.74)" : `rgba(94, 234, 212, ${round(0.32 - ring * 0.04, 3)})`;
    ctx.lineWidth = ring === 0 ? 2.3 : 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + ring * 10 + Math.sin(frame * 0.026 + ring) * 1.1, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.78, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(247, 195, 95, 0.27)";
  ctx.lineWidth = 1;
  for (let index = 0; index < dispatch.dispatchGroups; index += 1) {
    const phase = (index / dispatch.dispatchGroups) * Math.PI * 2 + frame * 0.012;
    const inner = radius * 1.05;
    const outer = radius * (1.52 + (index % 3) * 0.06);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(phase) * inner, cy + Math.sin(phase) * inner);
    ctx.lineTo(cx + Math.cos(phase) * outer, cy + Math.sin(phase) * outer);
    ctx.stroke();
  }
}

function drawFrame(ctx, frame, dispatch) {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.13;

  drawStarField(ctx, width, height, frame);
  drawRawLensingGrid(ctx, cx, cy, radius, frame);
  drawShaderPasses(ctx, cx, cy, radius, frame);
  drawPipelineOverlay(ctx, cx, cy, radius, frame, dispatch);

  ctx.fillStyle = "rgba(237, 253, 250, 0.9)";
  ctx.font = "14px Segoe UI";
  ctx.fillText(`frame ${frame + 1}/${pipelineConfig.frameCount}`, 18, 28);
  ctx.fillText(`${pipelineConfig.shaderLineCount} WGSL lines, ${pipelineConfig.bindGroupCount} bind groups, ${pipelineConfig.raySteps} ray steps`, 18, 50);
  ctx.fillText(`dispatch ${dispatch.dispatchGroups} groups, checksum ${dispatch.checksum}`, 18, 72);
}

async function runRealRendererBlackholeRaw(adapter) {
  log(`Connecting real renderer adapter '${adapter.id}'.`);
  const startedAt = performance.now();
  const sceneLoadStartedAt = performance.now();
  const realCanvas = document.createElement("canvas");
  realCanvas.width = elements.canvas.width;
  realCanvas.height = elements.canvas.height;
  realCanvas.style.display = "none";
  document.body.appendChild(realCanvas);
  try {
    await withTimeout(
      Promise.resolve(adapter.createRenderer({ canvas: realCanvas })),
      REAL_ADAPTER_LOAD_MS,
      `createRenderer(${adapter.id})`
    );
    await withTimeout(
      Promise.resolve(adapter.loadScene({ nodeCount: 24 })),
      REAL_ADAPTER_LOAD_MS,
      `loadScene(${adapter.id})`
    );
    const sceneLoadMs = performance.now() - sceneLoadStartedAt;

    const frameTimes = [];
    for (let index = 0; index < 32; index += 1) {
      const frameInfo = await withTimeout(
        Promise.resolve(adapter.renderFrame({ frameIndex: index })),
        REAL_ADAPTER_LOAD_MS,
        `renderFrame(${adapter.id})`
      );
      frameTimes.push(typeof frameInfo?.frameMs === "number" ? frameInfo.frameMs : 0);
    }

    const totalMs = performance.now() - startedAt;
    const avgFrame = frameTimes.reduce((sum, value) => sum + value, 0) / Math.max(frameTimes.length, 1);
    return {
      totalMs,
      sceneLoadMs,
      avgFps: 1000 / Math.max(avgFrame, 0.001),
      p95FrameMs: percentile(frameTimes, 0.95) || 0,
      frameTimes,
      sampleCount: frameTimes.length,
      realAdapter: adapter
    };
  } finally {
    realCanvas.remove();
  }
}

async function runSceneBaseline() {
  if (state.active) return;
  if (!state.capability) {
    await probeCapability();
  }

  state.active = true;
  render();

  if (isRealRendererMode) {
    log(`Mode=${requestedMode} requested; awaiting real renderer adapter registration.`);
    const adapter = await awaitRealRenderer();
    if (adapter) {
      try {
        state.run = await runRealRendererBlackholeRaw(adapter);
        state.active = false;
        log(`Real renderer '${adapter.id}' complete: avg fps ${round(state.run.avgFps, 2)}, p95 frame ${round(state.run.p95FrameMs, 2)} ms.`);
        render();
        return;
      } catch (error) {
        state.realAdapterError = error?.message || String(error);
        log(`Real renderer '${adapter.id}' failed: ${state.realAdapterError}; falling back to deterministic.`);
      }
    } else {
      const reason = (typeof window !== "undefined" && window.__aiWebGpuLabRealBlackholeRawBootstrapError) || "timed out waiting for adapter registration";
      state.realAdapterError = reason;
      log(`No real renderer adapter registered (${reason}); falling back to deterministic blackhole-from-scratch baseline.`);
    }
  }
  const ctx = elements.canvas.getContext("2d");
  const frameTimes = [];
  const dispatchTimes = [];
  const startedAt = performance.now();
  const sceneLoadStartedAt = performance.now();
  await new Promise((resolve) => setTimeout(resolve, state.environment.fallback_triggered ? 66 : 40));
  const sceneLoadMs = performance.now() - sceneLoadStartedAt;

  let previous = performance.now();
  let checksum = 0;
  let branchCount = 0;
  let dispatchGroups = 0;
  for (let frame = 0; frame < pipelineConfig.frameCount; frame += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const dispatch = simulatePipelineDispatch(frame);
    dispatchTimes.push(dispatch.durationMs);
    checksum = dispatch.checksum;
    branchCount += dispatch.branchCount;
    dispatchGroups = dispatch.dispatchGroups;
    const now = performance.now();
    frameTimes.push(now - previous);
    previous = now;
    drawFrame(ctx, frame, dispatch);
  }

  const totalMs = performance.now() - startedAt;
  const avgFrame = frameTimes.reduce((sum, value) => sum + value, 0) / Math.max(frameTimes.length, 1);
  const avgDispatch = dispatchTimes.reduce((sum, value) => sum + value, 0) / Math.max(dispatchTimes.length, 1);
  state.run = {
    totalMs,
    sceneLoadMs,
    avgFps: 1000 / Math.max(avgFrame, 0.001),
    p95FrameMs: percentile(frameTimes, 0.95) || 0,
    avgDispatchMs: avgDispatch,
    p95DispatchMs: percentile(dispatchTimes, 0.95) || 0,
    checksum,
    branchCount,
    dispatchGroups,
    sampleCount: frameTimes.length,
    artifactNote: state.environment.fallback_triggered
      ? "fallback canvas path; deterministic raw WebGPU pipeline metadata only"
      : "synthetic raw WebGPU blackhole path; WGSL pipeline not integrated yet",
    realAdapter: null
  };
  state.active = false;

  log(`Raw WebGPU blackhole baseline complete: avg fps ${round(state.run.avgFps, 2)}, p95 frame ${round(state.run.p95FrameMs, 2)} ms.`);
  render();
}

function describeRendererAdapter() {
  const registry = typeof window !== "undefined" ? window.__aiWebGpuLabRendererRegistry : null;
  const requested = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("mode")
    : null;
  if (registry) {
    return registry.describe(requested);
  }
  return {
    id: "deterministic-blackhole-raw",
    label: "Deterministic Blackhole raw WebGPU",
    status: "deterministic",
    isReal: false,
    version: "1.0.0",
    capabilities: ["scene-load", "frame-pace", "fallback-record"],
    backendHint: "synthetic",
    message: "Renderer adapter registry unavailable; using inline deterministic mock."
  };
}

function buildResult() {
  const run = state.run;
  return {
    meta: {
      repo: "exp-blackhole-webgpu-fromscratch",
      commit: "bootstrap-generated",
      timestamp: new Date().toISOString(),
      owner: "ai-webgpu-lab",
      track: "blackhole",
      scenario: run
        ? (run.realAdapter ? `blackhole-webgpu-fromscratch-real-${run.realAdapter.id}` : "blackhole-webgpu-fromscratch-readiness")
        : "blackhole-webgpu-fromscratch-pending",
      notes: run
        ? `shaderLineCount=${pipelineConfig.shaderLineCount}; bindGroupCount=${pipelineConfig.bindGroupCount}; uniformBytes=${pipelineConfig.uniformBytes}; storageBufferKB=${pipelineConfig.storageBufferKB}; workgroupSize=${pipelineConfig.workgroupSize}; renderPasses=${pipelineConfig.renderPasses}; raySteps=${pipelineConfig.raySteps}; avgDispatchMs=${round(run.avgDispatchMs, 4)}; p95DispatchMs=${round(run.p95DispatchMs, 4)}; dispatchGroups=${run.dispatchGroups}; branchCount=${run.branchCount}; backend=${state.environment.backend}; fallback=${state.environment.fallback_triggered}${run.realAdapter ? `; realAdapter=${run.realAdapter.id}` : (isRealRendererMode && state.realAdapterError ? `; realAdapter=fallback(${state.realAdapterError})` : "")}`
        : "Probe capability and run the deterministic raw WebGPU-style blackhole scene."
    },
    environment: state.environment,
    workload: {
      kind: "blackhole",
      name: "blackhole-webgpu-fromscratch-readiness",
      input_profile: "raw-webgpu-single-pass-lensing-fixture",
      renderer: "raw-webgpu-blackhole-readiness",
      model_id: "raw-webgpu-blackhole-readiness",
      resolution: `${elements.canvas.width}x${elements.canvas.height}`
    },
    metrics: {
      common: {
        time_to_interactive_ms: round(performance.now() - state.startedAt, 2) || 0,
        init_ms: run ? round(run.sceneLoadMs, 2) || 0 : 0,
        success_rate: run ? 1 : state.capability ? 0.5 : 0,
        peak_memory_note: navigator.deviceMemory ? `${navigator.deviceMemory} GB reported by browser` : "deviceMemory unavailable",
        error_type: ""
      },
      graphics: {
        avg_fps: run ? round(run.avgFps, 2) || 0 : 0,
        p95_frametime_ms: run ? round(run.p95FrameMs, 2) || 0 : 0,
        scene_load_ms: run ? round(run.sceneLoadMs, 2) || 0 : 0,
        resolution_scale: pipelineConfig.resolutionScale,
        ray_steps: pipelineConfig.raySteps,
        taa_enabled: pipelineConfig.taaEnabled,
        visual_artifact_note: run ? run.artifactNote : "pending raw WebGPU-style scene run"
      }
    },
    status: run ? "success" : state.capability ? "partial" : "pending",
    artifacts: {
      raw_logs: state.logs.slice(0, 5),
      deploy_url: "https://ai-webgpu-lab.github.io/exp-blackhole-webgpu-fromscratch/",
      renderer_adapter: describeRendererAdapter()
    }
  };
}

function renderStatus() {
  const badges = state.active
    ? ["Raw baseline running", state.environment.backend === "pending" ? "Capability pending" : state.environment.backend]
    : state.run
      ? ["Raw baseline complete", `${round(state.run.avgFps, 2)} fps`]
      : state.capability
        ? ["Capability captured", state.environment.backend]
        : ["Awaiting probe", "No baseline run"];
  elements.statusRow.innerHTML = "";
  for (const text of badges) {
    const node = document.createElement("span");
    node.className = "badge";
    node.textContent = text;
    elements.statusRow.appendChild(node);
  }
  elements.summary.textContent = state.run
    ? `Last run: ${round(state.run.avgFps, 2)} fps average, p95 frame ${round(state.run.p95FrameMs, 2)} ms, scene load ${round(state.run.sceneLoadMs, 2)} ms.`
    : "Probe capability first, then run the deterministic raw WebGPU-style lensing scene to export schema-aligned blackhole metrics.";
}

function renderMetrics() {
  const run = state.run;
  const cards = [
    ["Backend", state.environment.backend],
    ["Fallback", String(state.environment.fallback_triggered)],
    ["Avg FPS", run ? `${round(run.avgFps, 2)}` : "pending"],
    ["P95 Frame", run ? `${round(run.p95FrameMs, 2)} ms` : "pending"],
    ["Scene Load", run ? `${round(run.sceneLoadMs, 2)} ms` : "pending"],
    ["Ray Steps", String(pipelineConfig.raySteps)],
    ["Shader Lines", String(pipelineConfig.shaderLineCount)],
    ["Dispatch", run ? `${round(run.avgDispatchMs, 3)} ms` : "pending"]
  ];
  elements.metricGrid.innerHTML = "";
  for (const [label, value] of cards) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `<span class="label">${label}</span><div class="value">${value}</div>`;
    elements.metricGrid.appendChild(card);
  }
}

function renderEnvironment() {
  const info = [
    ["Browser", `${state.environment.browser.name} ${state.environment.browser.version}`],
    ["OS", `${state.environment.os.name} ${state.environment.os.version}`],
    ["Device", state.environment.device.class],
    ["CPU", state.environment.device.cpu],
    ["Memory", state.environment.device.memory_gb ? `${state.environment.device.memory_gb} GB` : "unknown"],
    ["Adapter", state.environment.gpu.adapter],
    ["Backend", state.environment.backend]
  ];
  elements.metaGrid.innerHTML = "";
  for (const [label, value] of info) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `<span class="label">${label}</span><div class="value">${value}</div>`;
    elements.metaGrid.appendChild(card);
  }
}

function renderLogs() {
  elements.logList.innerHTML = "";
  const entries = state.logs.length ? state.logs : ["No raw WebGPU blackhole activity yet."];
  for (const entry of entries) {
    const li = document.createElement("li");
    li.textContent = entry;
    elements.logList.appendChild(li);
  }
}

function render() {
  renderStatus();
  renderMetrics();
  renderEnvironment();
  renderLogs();
  elements.resultJson.textContent = JSON.stringify(buildResult(), null, 2);
}

function downloadJson() {
  const blob = new Blob([JSON.stringify(buildResult(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `exp-blackhole-webgpu-fromscratch-${state.run ? "scene-ready" : "pending"}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  log("Downloaded raw WebGPU blackhole readiness JSON draft.");
}

elements.probeCapability.addEventListener("click", probeCapability);
elements.runScene.addEventListener("click", runSceneBaseline);
elements.downloadJson.addEventListener("click", downloadJson);

log("Raw WebGPU blackhole readiness harness ready.");
render();
