/**
 * Whether scenes should render with WebGPU. Only hardware adapters qualify:
 * software fallbacks (e.g. SwiftShader on CI and some VMs) are slower than
 * WebGL2 and tend to lose their device, so scenes use WebGL2 / Canvas 2D there.
 * Resolved once per page and shared by every scene.
 */
let decision: Promise<boolean> | null = null;

export function preferWebGPU(): Promise<boolean> {
  decision ??= (async () => {
    try {
      const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
      if (!gpu) return false;
      const adapter = await gpu.requestAdapter();
      if (!adapter) return false;
      const info = adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean };
      const legacy = (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter;
      return !(info?.isFallbackAdapter ?? legacy ?? false);
    } catch {
      return false;
    }
  })();
  return decision;
}
