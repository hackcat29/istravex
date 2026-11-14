/**
 * Byte field — TypeGPU compute + render pipelines (Canvas 2D fallback).
 * A dot-matrix of ledger bytes. A compute pass decays each cell, injects a
 * scan line, sparse sparks and the pointer trail. The fragment pass draws each
 * cell as a square whose size is quantised to four steps (no gradients).
 */
import tgpu from 'typegpu';
import * as d from 'typegpu/data';
import type { SceneContext, SceneHandle } from './types';
import { preferWebGPU } from '../lib/gpu';

const CELL = 14; // css px per cell

const MAX_CELLS = 400 * 200;

export async function createByteField({ canvas, reducedMotion }: SceneContext): Promise<SceneHandle> {
  const dpr = Math.min(window.devicePixelRatio, 2);
  const pointer = { x: -1e4, y: -1e4, active: 0 };

  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    pointer.x = e.clientX - r.left;
    pointer.y = e.clientY - r.top;
    pointer.active = 1;
  };
  const onLeave = () => {
    pointer.active = 0;
  };
  // Listen on the section so content above the canvas still drives it.
  const host = canvas.parentElement ?? canvas;
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerleave', onLeave);
  const detach = () => {
    host.removeEventListener('pointermove', onMove);
    host.removeEventListener('pointerleave', onLeave);
  };

  const gpu = (await preferWebGPU()) ? await createGpu().catch(() => null) : null;
  const impl = gpu ?? createCanvas2d();

  function size() {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    impl.resize(w, h);
  }
  const ro = new ResizeObserver(size);
  ro.observe(canvas);
  size();

  let raf = 0;
  let last = performance.now();
  let t = 0;
  const tick = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    t += dt;
    impl.frame(t, dt);
    raf = requestAnimationFrame(tick);
  };

  impl.frame(reducedMotion ? 3 : 0, reducedMotion ? 3 : 0.016);

  return {
    backend: gpu ? 'webgpu' : 'canvas2d',
    setActive(active) {
      cancelAnimationFrame(raf);
      if (active && !reducedMotion) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      detach();
      impl.dispose();
    },
  };

  // ── WebGPU via TypeGPU ───────────────────────────────────────────────────
  async function createGpu() {
    const Params = d.struct({
      grid: d.vec2u,
      pointer: d.vec2f,
      dpr: d.f32,
      time: d.f32,
      dt: d.f32,
      cell: d.f32,
      hover: d.f32, // note: WGSL reserves `active`
    });
    const root = await tgpu.init();
    const context = root.configureContext({ canvas, alphaMode: 'premultiplied' });

    const params = root.createUniform(Params);
    const cells = root.createMutable(d.arrayOf(d.f32, MAX_CELLS));
    let grid = { cols: 1, rows: 1 };

    const step = tgpu
      .computeFn({ in: { gid: d.builtin.globalInvocationId }, workgroupSize: [64] })
      /* wgsl */ `{
        let i = in.gid.x;
        let cols = params.grid.x;
        if (i >= cols * params.grid.y) { return; }
        let c = vec2f(f32(i % cols), f32(i / cols));
        let center = (c + 0.5) * params.cell;
        var v = cells[i] * exp(-params.dt * 1.6);

        // pointer trail
        let dp = distance(center, params.pointer);
        if (params.hover > 0.5 && dp < params.cell * 4.0) {
          v = max(v, 1.0 - dp / (params.cell * 5.0));
        }
        // scan column sweeping left to right
        let scan = fract(params.time * 0.08) * f32(cols + 24u) - 12.0;
        if (abs(c.x - scan) < 0.5) {
          let h = fract(sin(dot(c, vec2f(12.9898, 78.233))) * 43758.5453);
          if (h > 0.45) { v = max(v, 0.72); }
        }
        // sparse sparks
        let tick = floor(params.time * 6.0);
        let s = fract(sin(dot(c + tick, vec2f(39.3468, 11.135))) * 24634.6345);
        if (s > 0.9978) { v = 1.0; }

        cells[i] = clamp(v, 0.0, 1.0);
      }`.$uses({ params, cells });

    const computePipeline = root.createComputePipeline({ compute: step });

    const vert = tgpu.vertexFn({
      in: { vid: d.builtin.vertexIndex },
      out: { pos: d.builtin.position },
    }) /* wgsl */ `{
      var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
      return Out(vec4f(p[in.vid], 0.0, 1.0));
    }`;

    const frag = tgpu.fragmentFn({
      in: { pos: d.builtin.position },
      out: d.vec4f,
    }) /* wgsl */ `{
      let css = in.pos.xy / params.dpr;
      let c = floor(css / params.cell);
      if (c.x >= f32(params.grid.x) || c.y >= f32(params.grid.y)) { return vec4f(0.0); }
      let v = cells[u32(c.y) * params.grid.x + u32(c.x)];
      let level = floor(v * 4.0) / 4.0;
      let local = abs(fract(css / params.cell) - 0.5);
      let half = max(0.06, level * 0.36);
      if (max(local.x, local.y) > half) { return vec4f(0.0); }
      if (level >= 0.75) { return vec4f(0.831, 1.0, 0.247, 1.0); }
      if (level >= 0.5) { return vec4f(0.945, 0.937, 0.914, 1.0) * 0.9; }
      if (level >= 0.25) { return vec4f(0.553, 0.545, 0.522, 1.0) * 0.8; }
      return vec4f(0.149, 0.149, 0.165, 1.0);
    }`.$uses({ params, cells });

    const renderPipeline = root.createRenderPipeline({ vertex: vert, fragment: frag });

    return {
      resize(w: number, h: number) {
        grid = {
          cols: Math.min(400, Math.ceil(w / CELL)),
          rows: Math.min(200, Math.ceil(h / CELL)),
        };
      },
      frame(time: number, dt: number) {
        params.write({
          grid: d.vec2u(grid.cols, grid.rows),
          dpr,
          pointer: d.vec2f(pointer.x, pointer.y),
          time,
          dt,
          cell: CELL,
          hover: pointer.active,
        });
        computePipeline.dispatchWorkgroups(Math.ceil((grid.cols * grid.rows) / 64));
        renderPipeline
          .withColorAttachment({
            view: context,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          })
          .draw(3);
      },
      dispose() {
        root.destroy();
      },
    };
  }

  // ── Canvas 2D fallback (same rules, CPU) ─────────────────────────────────
  function createCanvas2d() {
    const ctx = canvas.getContext('2d')!;
    let cols = 1;
    let rows = 1;
    let data = new Float32Array(1);
    const hash = (x: number, y: number) => {
      const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      return s - Math.floor(s);
    };
    return {
      resize(w: number, h: number) {
        cols = Math.ceil(w / CELL);
        rows = Math.ceil(h / CELL);
        data = new Float32Array(cols * rows);
      },
      frame(time: number, dt: number) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cols * CELL, rows * CELL);
        const decay = Math.exp(-dt * 1.6);
        const scan = (((time * 0.08) % 1) * (cols + 24)) - 12;
        const tick = Math.floor(time * 6);
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            const i = y * cols + x;
            let v = data[i] * decay;
            const cx = (x + 0.5) * CELL;
            const cy = (y + 0.5) * CELL;
            if (pointer.active) {
              const dp = Math.hypot(cx - pointer.x, cy - pointer.y);
              if (dp < CELL * 4) v = Math.max(v, 1 - dp / (CELL * 5));
            }
            if (Math.abs(x - scan) < 0.5 && hash(x, y) > 0.45) v = Math.max(v, 0.72);
            if (hash(x + tick + 3.1, y + tick) > 0.9978) v = 1;
            data[i] = v;
            const level = Math.floor(v * 4) / 4;
            const half = Math.max(0.06, level * 0.36) * CELL;
            ctx.fillStyle =
              level >= 0.75 ? '#d4ff3f' : level >= 0.5 ? '#d9d7d2' : level >= 0.25 ? '#716f6a' : '#26262a';
            ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
          }
        }
      },
      dispose() {},
    };
  }
}
