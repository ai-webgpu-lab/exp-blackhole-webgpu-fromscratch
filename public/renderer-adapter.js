// Renderer adapter contract for exp-three-webgpu-core.
//
// A real renderer (three.js WebGPURenderer, raw WebGPU pipeline, etc.) graduates
// from the deterministic harness by implementing this shape and registering
// itself before app.js boots:
//
//   window.__aiWebGpuLabRendererRegistry.register(myRenderer);
//
// The harness consults the registry only when it needs renderer metadata for the
// result draft. Existing deterministic scenarios stay unchanged.

class RendererAdapterRegistry {
  constructor() {
    this.adapters = new Map();
    this.deterministic = {
      id: "deterministic-three-style",
      label: "Deterministic Three-style",
      version: "1.0.0",
      capabilities: ["scene-load", "frame-pace", "fallback-record"],
      backendHint: "synthetic",
      isReal: false
    };
  }

  register(adapter) {
    if (!adapter || typeof adapter !== "object") {
      throw new Error("renderer adapter must be an object");
    }
    for (const field of ["id", "label", "version"]) {
      if (typeof adapter[field] !== "string" || !adapter[field]) {
        throw new Error(`renderer adapter.${field} is required`);
      }
    }
    for (const method of ["createRenderer", "loadScene", "renderFrame"]) {
      if (typeof adapter[method] !== "function") {
        throw new Error(`renderer adapter.${method} must be a function`);
      }
    }
    this.adapters.set(adapter.id, {
      ...adapter,
      isReal: true,
      capabilities: Array.isArray(adapter.capabilities) ? adapter.capabilities : []
    });
    return adapter.id;
  }

  list() {
    return [...this.adapters.values()];
  }

  describe(modeId) {
    const reportRealAdapter = modeId === "adapter-stub" || (typeof modeId === "string" && modeId.startsWith("real-"));
    if (reportRealAdapter) {
      const registered = [...this.adapters.values()];
      if (registered.length === 0) {
        return {
          id: "stub-not-connected",
          label: "Renderer Adapter Stub (not connected)",
          status: "not-connected",
          isReal: false,
          version: "n/a",
          capabilities: this.deterministic.capabilities,
          backendHint: "stub",
          message: `No real renderer adapter has registered for mode='${modeId}'. Falling back to the deterministic harness.`
        };
      }
      const primary = registered[0];
      return {
        id: primary.id,
        label: primary.label,
        status: "connected",
        isReal: true,
        version: primary.version,
        capabilities: primary.capabilities,
        backendHint: primary.backendHint || "unknown",
        message: `Real renderer adapter '${primary.id}' is connected.`
      };
    }
    return {
      ...this.deterministic,
      status: "deterministic",
      message: "Deterministic harness — replace by registering a real renderer."
    };
  }
}

if (typeof window !== "undefined") {
  if (!window.__aiWebGpuLabRendererRegistry) {
    window.__aiWebGpuLabRendererRegistry = new RendererAdapterRegistry();
  }
}

export { RendererAdapterRegistry };
