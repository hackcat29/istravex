/**
 * Hero scene — Three.js WebGPURenderer + TSL (falls back to WebGL2 automatically).
 * A stream of fixtures flows through the replay harness ring. Each one that
 * crosses the ring resolves to a verdict: correct, incorrect, or dropped.
 */
import * as THREE from 'three/webgpu';
import { color, fract, mix, step, time, uv } from 'three/tsl';
import type { Verdict } from '../content';
import type { SceneContext, SceneHandle } from './types';
import { preferWebGPU } from '../lib/gpu';

const INK = 0x0b0b0c;
const NEUTRAL = new THREE.Color(0x4f4e4a);
const LIME = new THREE.Color(0xd4ff3f);
const CORAL = new THREE.Color(0xff5c49);

const SPAN = 34; // stream length in world units
const HALF = SPAN / 2;

type Cube = {
  r: number;
  a: number;
  speed: number;
  x: number;
  spin: number;
  size: number;
  verdict: Verdict | null;
};

export interface HeroOptions {
  /** Verdicts to cycle through as fixtures cross the ring (the real replay + pilot results). */
  verdicts?: Verdict[];
  onVerdict?: (v: Verdict) => void;
}

export async function createHeroScene(
  { canvas, reducedMotion }: SceneContext,
  { verdicts = ['correct'], onVerdict }: HeroOptions = {},
): Promise<SceneHandle> {
  let next = Math.floor(Math.random() * verdicts.length);
  const pickVerdict = (): Verdict => verdicts[next++ % verdicts.length];
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true, forceWebGL: !(await preferWebGPU()) });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(INK, 0);
  await renderer.init();
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? 'webgpu'
    : 'webgl2';

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(INK, 18, 36);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);

  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(4, 8, 10);
  scene.add(key);
  const glow = new THREE.PointLight(0xd4ff3f, 26, 7, 1.6);
  glow.position.set(0.6, 0, 0);
  scene.add(glow);

  const root = new THREE.Group();
  root.rotation.set(0.18, -0.42, 0);
  scene.add(root);

  // ── Harness ring: TSL stripes that rotate around the torus ──────────────
  const ringMat = new THREE.MeshBasicNodeMaterial();
  const stripes = step(0.5, fract(uv().x.mul(42).sub(time.mul(0.9))));
  ringMat.colorNode = mix(color(0x2a2a2e), color(0xd4ff3f), stripes);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.25, 0.07, 20, 220), ringMat);
  ring.rotation.y = Math.PI / 2;
  root.add(ring);

  const haloMat = new THREE.MeshBasicNodeMaterial({ color: 0x34343a });
  const halo = new THREE.Mesh(new THREE.TorusGeometry(2.85, 0.012, 8, 220), haloMat);
  halo.rotation.y = Math.PI / 2;
  root.add(halo);

  const tickMat = new THREE.MeshBasicNodeMaterial();
  tickMat.colorNode = mix(
    color(0x0b0b0c),
    color(0x8d8b85),
    step(0.82, fract(uv().x.mul(96).add(time.mul(0.15)))),
  );
  tickMat.transparent = true;
  const ticks = new THREE.Mesh(new THREE.TorusGeometry(3.35, 0.02, 6, 300), tickMat);
  ticks.rotation.y = Math.PI / 2;
  root.add(ticks);

  // ── Ledger floor ─────────────────────────────────────────────────────────
  const grid = new THREE.GridHelper(60, 60, 0x26262a, 0x1b1b1e);
  grid.position.y = -3.6;
  root.add(grid);

  // ── Fixture stream ───────────────────────────────────────────────────────
  const isNarrow = canvas.clientWidth < 640;
  const COUNT = isNarrow ? 260 : 460;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.38, metalness: 0.15 });
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(mesh);

  const cubes: Cube[] = Array.from({ length: COUNT }, () => {
    const x = -HALF + Math.random() * SPAN;
    return {
      r: Math.sqrt(Math.random()) * 1.65,
      a: Math.random() * Math.PI * 2,
      speed: 1.2 + Math.random() * 1.1,
      x,
      spin: (Math.random() - 0.5) * 2.4,
      size: 0.09 + Math.random() * 0.13,
      verdict: x > 0 ? pickVerdict() : null,
    };
  });

  const dummy = new THREE.Object3D();
  const tmp = new THREE.Color();
  let elapsed = 0;

  function writeInstances(dt: number) {
    for (let i = 0; i < COUNT; i++) {
      const c = cubes[i];
      const prevX = c.x;
      c.x += c.speed * dt;
      if (c.x > HALF) {
        c.x -= SPAN;
        c.verdict = null;
      }
      if (prevX < 0 && c.x >= 0) {
        c.verdict = pickVerdict();
        onVerdict?.(c.verdict);
      }

      const twist = c.a + c.x * 0.09 + elapsed * 0.05;
      // Bundle tightens as it passes the ring, then relaxes.
      const squeeze = 1 - 0.38 * Math.exp(-(c.x * c.x) / 6);
      let y = Math.sin(twist) * c.r * squeeze;
      const z = Math.cos(twist) * c.r * squeeze;
      let s = c.size;

      if (c.verdict === 'dropped') {
        s *= Math.max(0, 1 - c.x / 1.4);
      } else if (c.verdict === 'incorrect') {
        y += Math.sin(elapsed * 30 + i) * 0.03 * Math.max(0, 1 - c.x / 6);
      }

      dummy.position.set(c.x, y, z);
      dummy.rotation.set(elapsed * c.spin + i, elapsed * c.spin * 0.7, 0);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      tmp.copy(
        c.verdict === 'correct' ? LIME : c.verdict === 'incorrect' ? CORAL : NEUTRAL,
      );
      mesh.setColorAt(i, tmp);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  // ── Layout ───────────────────────────────────────────────────────────────
  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Keep the ring and a good stretch of stream framed on any aspect.
    const dist = camera.aspect < 1 ? 15 / Math.max(camera.aspect, 0.55) : 17;
    camera.position.set(0, 1.6, dist);
    camera.lookAt(0, 0, 0);
    // Canvas is full-bleed behind the copy. Wide: push the ring right.
    // Tall (mobile): drop it below the headline, behind the buttons.
    if (camera.aspect > 1.3) camera.setViewOffset(w, h, -w * 0.2, 0, w, h);
    else if (camera.aspect < 0.9) camera.setViewOffset(w, h, 0, -h * 0.16, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  // ── Interaction: pointer parallax + horizontal drag ─────────────────────
  let px = 0;
  let py = 0;
  let yaw = 0;
  let yawVel = 0;
  let dragging = false;
  let lastX = 0;
  const onMove = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    px = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    py = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    if (dragging) {
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      yawVel = dx * 0.006;
      yaw += yawVel;
    }
  };
  const onDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
  };
  const onUp = () => {
    dragging = false;
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', () => {
    px = 0;
    py = 0;
  });

  let last = performance.now();
  function frame() {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += dt;

    if (!dragging) {
      yaw += yawVel;
      yawVel *= 0.94;
      yaw *= 0.985; // ease back home
    }
    root.rotation.y += (-0.42 + px * 0.22 + yaw - root.rotation.y) * 0.06;
    root.rotation.x += (0.18 + py * 0.08 - root.rotation.x) * 0.06;
    halo.rotation.x = elapsed * 0.12;

    writeInstances(dt);
    renderer.render(scene, camera);
  }

  writeInstances(0);
  renderer.render(scene, camera);

  let running = false;
  return {
    backend,
    setActive(active) {
      if (reducedMotion || active === running) return;
      running = active;
      last = performance.now();
      renderer.setAnimationLoop(active ? frame : null);
    },
    dispose() {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      window.removeEventListener('pointerup', onUp);
      geo.dispose();
      mat.dispose();
      ringMat.dispose();
      haloMat.dispose();
      tickMat.dispose();
      renderer.dispose();
    },
  };
}
