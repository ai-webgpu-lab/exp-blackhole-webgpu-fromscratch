// Real raw-WebGPU blackhole render pipeline sketch for exp-blackhole-webgpu-fromscratch.
//
// Gated by ?mode=real-bhraw. Default deterministic harness path is untouched.
// `loadWebGpuFromBrowser` is parameterized so tests can inject a stub.

const VERTEX_SHADER = /* wgsl */ `
@vertex
fn main(@builtin(vertex_index) vertex : u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 6>(
    vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
    vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0)
  );
  let p = positions[vertex];
  return vec4<f32>(p, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = /* wgsl */ `
struct Frame {
  resolution : vec2<f32>,
  time       : f32,
  ray_steps  : u32,
};

@group(0) @binding(0) var<uniform> frame : Frame;

fn sdSphere(p : vec3<f32>, r : f32) -> f32 {
  return length(p) - r;
}

@fragment
fn main(@builtin(position) coord : vec4<f32>) -> @location(0) vec4<f32> {
  let aspect = frame.resolution.x / frame.resolution.y;
  let uv = (coord.xy / frame.resolution - vec2<f32>(0.5, 0.5)) * vec2<f32>(2.0 * aspect, 2.0);
  let ray_origin = vec3<f32>(0.0, 0.0, -3.0);
  let ray_dir = normalize(vec3<f32>(uv, 1.0));
  var t = 0.0;
  var color = vec3<f32>(0.0);
  for (var i : u32 = 0u; i < frame.ray_steps; i = i + 1u) {
    let p = ray_origin + ray_dir * t;
    let d = sdSphere(p, 0.45);
    if (d < 0.001) {
      color = vec3<f32>(0.05, 0.02, 0.08);
      break;
    }
    let r = max(length(p), 0.5);
    color = color + vec3<f32>(0.9, 0.55, 0.25) * (0.04 / (r * r));
    t = t + max(d, 0.05);
    if (t > 12.0) { break; }
  }
  return vec4<f32>(color * (0.65 + 0.35 * sin(frame.time)), 1.0);
}
`;

export async function loadWebGpuFromBrowser({ navigatorGpu = (typeof navigator !== "undefined" ? navigator.gpu : null) } = {}) {
  if (!navigatorGpu) {
    throw new Error("navigator.gpu unavailable");
  }
  const adapter = await navigatorGpu.requestAdapter();
  if (!adapter) {
    throw new Error("no GPU adapter available");
  }
  const device = await adapter.requestDevice();
  return { adapter, device };
}

export function buildRealBlackholeRawAdapter({ device, version = "raw-webgpu-1" }) {
  if (!device || typeof device.createShaderModule !== "function") {
    throw new Error("buildRealBlackholeRawAdapter requires a GPUDevice");
  }
  const id = `blackhole-rawgpu-${version.replace(/[^0-9]/g, "") || "1"}`;
  let pipeline = null;
  let frameBuffer = null;
  let bindGroup = null;
  let context = null;

  return {
    id,
    label: `Raw WebGPU blackhole render pipeline (${version})`,
    version,
    capabilities: ["scene-load", "frame-pace", "real-render", "shader-pipeline", "fullscreen-pass"],
    backendHint: "webgpu",
    isReal: true,
    async createRenderer({ canvas } = {}) {
      const target = canvas || (typeof document !== "undefined" ? document.querySelector("canvas") : null);
      if (!target) {
        throw new Error("real renderer requires a <canvas> element");
      }
      context = typeof target.getContext === "function" ? target.getContext("webgpu") : null;
      const format = context && typeof context.getPreferredFormat === "function"
        ? context.getPreferredFormat()
        : "bgra8unorm";
      if (context && typeof context.configure === "function") {
        context.configure({ device, format, alphaMode: "premultiplied" });
      }
      const vertexModule = device.createShaderModule({ code: VERTEX_SHADER });
      const fragmentModule = device.createShaderModule({ code: FRAGMENT_SHADER });
      pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: vertexModule, entryPoint: "main" },
        fragment: { module: fragmentModule, entryPoint: "main", targets: [{ format }] },
        primitive: { topology: "triangle-list" }
      });
      return pipeline;
    },
    async loadScene({ rayStepBudget = 96 } = {}) {
      if (!pipeline) {
        throw new Error("createRenderer() must run before loadScene()");
      }
      frameBuffer = device.createBuffer({
        size: 16,
        usage: 0x40 | 0x08
      });
      const layout = pipeline.getBindGroupLayout(0);
      bindGroup = device.createBindGroup({
        layout,
        entries: [{ binding: 0, resource: { buffer: frameBuffer } }]
      });
      return { rayStepBudget };
    },
    async renderFrame({ frameIndex = 0, rayStepBudget = 96, width = 1280, height = 720 } = {}) {
      if (!pipeline || !frameBuffer || !bindGroup) {
        throw new Error("loadScene() must run before renderFrame()");
      }
      const startedAt = performance.now();
      const data = new ArrayBuffer(16);
      const view = new DataView(data);
      view.setFloat32(0, width, true);
      view.setFloat32(4, height, true);
      view.setFloat32(8, frameIndex * 0.016, true);
      view.setUint32(12, rayStepBudget, true);
      device.queue.writeBuffer(frameBuffer, 0, data);
      const encoder = device.createCommandEncoder();
      const view2 = context && typeof context.getCurrentTexture === "function"
        ? context.getCurrentTexture().createView()
        : null;
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: view2,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6);
      pass.end();
      device.queue.submit([encoder.finish()]);
      return { frameMs: performance.now() - startedAt, frameIndex, rayStepBudget };
    }
  };
}

export async function connectRealBlackholeRaw({
  registry = typeof window !== "undefined" ? window.__aiWebGpuLabRendererRegistry : null,
  loader = loadWebGpuFromBrowser,
  version = "raw-webgpu-1"
} = {}) {
  if (!registry) {
    throw new Error("renderer registry not available");
  }
  const { device } = await loader({});
  const adapter = buildRealBlackholeRawAdapter({ device, version });
  registry.register(adapter);
  return { adapter, device };
}

if (typeof window !== "undefined" && window.location && typeof window.location.search === "string") {
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") === "real-bhraw" && !window.__aiWebGpuLabRealBlackholeRawBootstrapping) {
    window.__aiWebGpuLabRealBlackholeRawBootstrapping = true;
    connectRealBlackholeRaw().catch((error) => {
      console.warn(`[real-bhraw] bootstrap failed: ${error.message}`);
      window.__aiWebGpuLabRealBlackholeRawBootstrapError = error.message;
    });
  }
}
