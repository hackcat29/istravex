export type Backend = 'webgpu' | 'webgl2' | 'canvas2d';

/** Contract every scene module implements. Mounted lazily by <SceneMount>. */
export interface SceneHandle {
  backend: Backend;
  /** Pause rendering when offscreen; resume when visible. */
  setActive(active: boolean): void;
  dispose(): void;
}

export interface SceneContext {
  canvas: HTMLCanvasElement;
  reducedMotion: boolean;
}
