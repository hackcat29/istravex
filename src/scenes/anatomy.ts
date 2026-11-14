/**
 * Fixture anatomy — Babylon.js WebGPUEngine (falls back to the WebGL2 Engine).
 * Renders the XDR tree of a muxed-payment fixture. The path from the envelope
 * to the selected field lights up and a packet travels down it.
 */
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { Engine } from '@babylonjs/core/Engines/engine';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreatePolyhedron } from '@babylonjs/core/Meshes/Builders/polyhedronBuilder';
import { CreateTube } from '@babylonjs/core/Meshes/Builders/tubeBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import '@babylonjs/core/Culling/ray';
import type { XdrNode } from '../content';
import type { SceneContext, SceneHandle } from './types';
import { preferWebGPU } from '../lib/gpu';

export interface AnatomyOptions {
  nodes: XdrNode[];
  initial: string;
  onSelect: (id: string) => void;
  /** Absolutely-positioned label elements, keyed by node id. */
  getLabel: (id: string) => HTMLElement | null | undefined;
}

export interface AnatomyHandle extends SceneHandle {
  select(id: string): void;
}

const hex = (h: string) => Color3.FromHexString(h);
const C = {
  idle: hex('#2b2b30'),
  idleLeaf: hex('#45454b'),
  path: hex('#d4ff3f'),
  line: hex('#34343a'),
  hover: hex('#f1efe9'),
};

export async function createAnatomyScene(
  { canvas, reducedMotion }: SceneContext,
  { nodes, initial, onSelect, getLabel }: AnatomyOptions,
): Promise<AnatomyHandle> {
  let engine: AbstractEngine;
  let backend: SceneHandle['backend'] = 'webgl2';
  const engineOpts = { antialias: true, adaptToDeviceRatio: true, doNotHandleTouchAction: true };

  if (await preferWebGPU()) {
    try {
      const gpu = new WebGPUEngine(canvas, engineOpts);
      await gpu.initAsync();
      engine = gpu;
      backend = 'webgpu';
    } catch {
      engine = new Engine(canvas, true, engineOpts, true);
    }
  } else {
    engine = new Engine(canvas, true, engineOpts, true);
  }
  engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio, 2));

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 0);
  scene.skipPointerMovePicking = false;

  const camera = new ArcRotateCamera('cam', -Math.PI / 2 - 0.35, Math.PI / 2.25, 15, Vector3.Zero(), scene);
  camera.minZ = 0.1;
  camera.lowerBetaLimit = camera.upperBetaLimit = camera.beta; // horizontal orbit only
  camera.lowerRadiusLimit = camera.upperRadiusLimit = camera.radius;
  camera.panningSensibility = 0;
  camera.angularSensibilityX = 1400;
  camera.attachControl(canvas, true);
  // Keep wheel for page scroll.
  camera.inputs.removeByType('ArcRotateCameraMouseWheelInput');

  new HemisphericLight('sky', new Vector3(0.2, 1, -0.4), scene).intensity = 0.9;
  const key = new DirectionalLight('key', new Vector3(-0.4, -0.6, 0.8), scene);
  key.intensity = 0.7;

  // ── Layout: x by depth, y by leaf order, z by a gentle helix ────────────
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, XdrNode[]>();
  for (const n of nodes) {
    if (!n.parent) continue;
    children.set(n.parent, [...(children.get(n.parent) ?? []), n]);
  }
  const rootNode = nodes.find((n) => !n.parent)!;
  const pos = new Map<string, Vector3>();
  const depth = new Map<string, number>();
  let leaf = 0;
  const place = (n: XdrNode, d: number): number => {
    depth.set(n.id, d);
    const kids = children.get(n.id) ?? [];
    let y: number;
    if (!kids.length) y = leaf++;
    else {
      const ys = kids.map((k) => place(k, d + 1));
      y = (Math.min(...ys) + Math.max(...ys)) / 2;
    }
    pos.set(n.id, new Vector3(d, y, 0));
    return y;
  };
  place(rootNode, 0);
  const maxDepth = Math.max(...depth.values());
  for (const [id, p] of pos) {
    const d = depth.get(id)!;
    p.x = (d - maxDepth / 2) * Math.min(2.15, 15 / maxDepth); // keep ~15 units wide
    p.y = -(p.y - (leaf - 1) / 2) * 0.95;
    p.z = Math.sin(d * 1.1 + p.y * 0.6) * 1.1;
  }

  // ── Meshes ───────────────────────────────────────────────────────────────
  const mat = (c: Color3, name: string) => {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor = c;
    m.specularColor = new Color3(0.15, 0.15, 0.15);
    m.emissiveColor = c.scale(0.35);
    return m;
  };
  const idleMat = mat(C.idle, 'idle');
  const idleLeafMat = mat(C.idleLeaf, 'idleLeaf');
  const pathMat = mat(C.path, 'path');
  pathMat.emissiveColor = C.path.scale(0.8);
  const hoverMat = mat(C.hover, 'hover');
  const lineMat = mat(C.line, 'line');
  lineMat.disableLighting = true;
  lineMat.emissiveColor = C.line;
  const pathLineMat = mat(C.path, 'pathLine');
  pathLineMat.disableLighting = true;
  pathLineMat.emissiveColor = C.path;

  const nodeMesh = new Map<string, Mesh>();
  for (const n of nodes) {
    const isLeaf = !children.has(n.id);
    const m = isLeaf
      ? CreatePolyhedron(n.id, { type: 1, size: 0.2 }, scene)
      : CreateBox(n.id, { size: 0.34 }, scene);
    m.position.copyFrom(pos.get(n.id)!);
    m.metadata = { id: n.id, leaf: isLeaf };
    m.material = isLeaf ? idleLeafMat : idleMat;
    nodeMesh.set(n.id, m);
  }

  const edgePoints = new Map<string, Vector3[]>();
  const edgeMesh = new Map<string, Mesh>();
  for (const n of nodes) {
    if (!n.parent) continue;
    const a = pos.get(n.parent)!;
    const b = pos.get(n.id)!;
    const mx = (a.x + b.x) / 2;
    const pts = [a, new Vector3(mx, a.y, a.z), new Vector3(mx, b.y, b.z), b];
    edgePoints.set(n.id, pts);
    const t = CreateTube(`e-${n.id}`, { path: pts, radius: 0.022, tessellation: 8 }, scene);
    t.material = lineMat;
    t.isPickable = false;
    edgeMesh.set(n.id, t);
  }

  const packet = CreateSphere('packet', { diameter: 0.16, segments: 12 }, scene);
  packet.material = pathMat;
  packet.isPickable = false;

  // ── Selection ────────────────────────────────────────────────────────────
  let selected = initial;
  let hovered: string | null = null;
  let pathIds: string[] = [];
  let packetPath: Vector3[] = [];
  let packetLen = 0;

  const ancestry = (id: string) => {
    const out: string[] = [];
    for (let cur: XdrNode | undefined = byId.get(id); cur; cur = cur.parent ? byId.get(cur.parent) : undefined) {
      out.unshift(cur.id);
    }
    return out;
  };

  function paint() {
    const onPath = new Set(pathIds);
    for (const [id, m] of nodeMesh) {
      const leafy = (m.metadata as { leaf: boolean }).leaf;
      m.material = id === hovered && !onPath.has(id) ? hoverMat : onPath.has(id) ? pathMat : leafy ? idleLeafMat : idleMat;
      m.scaling.setAll(id === selected ? 1.55 : 1);
    }
    for (const [id, t] of edgeMesh) t.material = onPath.has(id) ? pathLineMat : lineMat;
    for (const n of nodes) {
      const el = getLabel(n.id);
      if (!el) continue;
      el.dataset.state = n.id === selected ? 'selected' : onPath.has(n.id) ? 'path' : 'idle';
    }
  }

  function select(id: string) {
    if (!byId.has(id)) return;
    selected = id;
    pathIds = ancestry(id);
    packetPath = [];
    for (let i = 1; i < pathIds.length; i++) {
      const pts = edgePoints.get(pathIds[i])!;
      packetPath.push(...(i === 1 ? pts : pts.slice(1)));
    }
    if (!packetPath.length) packetPath = [pos.get(id)!.clone()];
    packetLen = 0;
    for (let i = 1; i < packetPath.length; i++) packetLen += Vector3.Distance(packetPath[i - 1], packetPath[i]);
    paint();
  }

  const packetAt = (u: number) => {
    if (packetPath.length < 2) return packetPath[0];
    let target = u * packetLen;
    for (let i = 1; i < packetPath.length; i++) {
      const seg = Vector3.Distance(packetPath[i - 1], packetPath[i]);
      if (target <= seg) return Vector3.Lerp(packetPath[i - 1], packetPath[i], seg ? target / seg : 0);
      target -= seg;
    }
    return packetPath[packetPath.length - 1];
  };

  scene.onPointerObservable.add((info) => {
    const hit = info.pickInfo?.hit ? (info.pickInfo.pickedMesh?.metadata as { id?: string } | null)?.id : undefined;
    if (info.type === PointerEventTypes.POINTERTAP && hit) {
      select(hit);
      onSelect(hit);
    } else if (info.type === PointerEventTypes.POINTERMOVE) {
      const next = hit ?? null;
      if (next !== hovered) {
        hovered = next;
        canvas.style.cursor = next ? 'pointer' : 'grab';
        paint();
      }
    }
  });

  // ── Fit + labels ─────────────────────────────────────────────────────────
  // Resize between frames, never mid-frame (WebGPU swap-chain safety).
  let needsResize = true;
  const fit = () => {
    if (!needsResize) return;
    needsResize = false;
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    const aspect = w / h;
    // Fit the tree's ~16-unit width: half-width = r·tan(fov/2)·aspect.
    const r = Math.max(15.5, 8.6 / (Math.tan(camera.fov / 2) * aspect));
    camera.radius = camera.lowerRadiusLimit = camera.upperRadiusLimit = r;
    engine.resize();
  };
  const ro = new ResizeObserver(() => {
    needsResize = true;
  });
  ro.observe(canvas);
  fit();

  const tmp = new Vector3();
  function placeLabels() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const vp = camera.viewport.toGlobal(w, h);
    const transform = scene.getTransformMatrix();
    for (const n of nodes) {
      const el = getLabel(n.id);
      if (!el) continue;
      const m = nodeMesh.get(n.id)!;
      Vector3.ProjectToRef(m.position, Matrix.IdentityReadOnly, transform, vp, tmp);
      el.style.transform = `translate3d(${tmp.x.toFixed(1)}px, ${tmp.y.toFixed(1)}px, 0)`;
    }
  }

  // ── Loop ─────────────────────────────────────────────────────────────────
  const home = camera.alpha;
  let t = 0;
  let idleFor = 0;
  let lastAlpha = camera.alpha;
  scene.onBeforeRenderObservable.add(() => {
    const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
    t += dt;
    if (Math.abs(camera.alpha - lastAlpha) > 1e-4) idleFor = 0;
    else idleFor += dt;
    if (!reducedMotion && idleFor > 2.5) camera.alpha += (home + Math.sin(t * 0.25) * 0.38 - camera.alpha) * 0.02;
    lastAlpha = camera.alpha;
    const u = reducedMotion ? 1 : (t * 0.45) % 1.25;
    packet.position.copyFrom(packetAt(Math.min(u, 1)));
    packet.isVisible = u <= 1;
    const pulse = reducedMotion ? 1.55 : 1.45 + Math.sin(t * 5) * 0.12;
    nodeMesh.get(selected)?.scaling.setAll(pulse);
  });
  scene.onAfterRenderObservable.add(placeLabels);

  select(initial);
  canvas.style.cursor = 'grab';

  let running = false;
  const loop = () => {
    fit();
    scene.render();
  };
  // First frame comes from runRenderLoop (it wraps beginFrame/endFrame; a bare
  // scene.render() here leaves a swap-chain texture pending under WebGPU).
  return {
    backend,
    select,
    setActive(active) {
      if (active === running) return;
      running = active;
      if (active) engine.runRenderLoop(loop);
      else engine.stopRenderLoop(loop);
    },
    dispose() {
      ro.disconnect();
      engine.stopRenderLoop();
      scene.dispose();
      engine.dispose();
    },
  };
}
