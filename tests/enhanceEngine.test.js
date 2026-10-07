import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine.js';
import { createEngineClient, createLocalWorker } from '../src/engineClient.js';
import { createItem } from '../src/document.js';
import { manifold } from '../src/manifold.js';
import { parseSTL, writeBinarySTL } from '../src/stl.js';
import { geometryToManifold } from '../src/mesh.js';
import { setup, soupOf as soupGeometry } from './helpers.js';

const stlOf = (solid) => writeBinarySTL(soupGeometry(solid));
const solidOfStl = (buffer) => geometryToManifold(parseSTL(buffer));

let wasm;
let engine;
let client;
let version = 0;
const progress = [];

/** A cube whose edges were rounded off (what a soft, low-definition model looks like). */
function softCube() {
  const { Manifold } = wasm;
  const core = Manifold.cube([20, 20, 8], true);
  const ball = Manifold.sphere(1.5, 12);
  const soft = core.minkowskiSum(ball);
  const dense = soft.refineToLength(0.8);
  core.delete();
  ball.delete();
  soft.delete();
  return dense;
}

beforeAll(async () => {
  await setup();
  wasm = manifold();
  engine = createEngine({ wasm });
  client = createEngineClient({ createWorker: () => createLocalWorker(Promise.resolve(engine)), onProgress: (p) => progress.push(p.stage) });
});

const load = async (solid) => {
  const r = await client.loadBase({ kind: 'stl', bytes: stlOf(solid), name: 'soft', version: ++version });
  return r;
};

describe('model enhancement in the engine', () => {
  it('sharpening a soft cube makes it crisper: same triangles, volume kept, info reports the change', async () => {
    const soft = softCube();
    const before = await load(soft);
    expect(before.info.enhanced).toBeNull();
    const plain = await client.export([], version, 'x');
    const r = await client.updateBase({ version: ++version, transforms: [], simplify: null, enhance: { sharpen: 1, detail: 0, smooth: 0, edgeAngle: 30, featureSize: 0, maxMove: 0 } });
    expect(r.info.enhanced).toBeTruthy();
    expect(r.info.enhanced.failed).toBe(false);
    expect(r.info.enhanced.verticesMoved).toBeGreaterThan(0);
    expect(r.info.enhanced.maxDisplacement).toBeGreaterThan(0);
    expect(r.info.triangles).toBe(before.info.triangles);
    expect(r.info.suggestions).toEqual([]);
    const ex = await client.export([], version, 'x');
    const a = solidOfStl(plain.stl);
    const b = solidOfStl(ex.stl);
    expect(b.status()).toBe('NoError');
    expect(Math.abs(b.volume() - a.volume()) / a.volume()).toBeLessThan(0.03);
    // crisper: more of the surface faces straight along an axis
    const axisFraction = (m) => {
      const mesh = m.getMesh();
      const p = mesh.vertProperties;
      const t = mesh.triVerts;
      let on = 0;
      let all = 0;
      for (let i = 0; i < t.length; i += 3) {
        const [a0, b0, c0] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
        const ux = p[b0] - p[a0], uy = p[b0 + 1] - p[a0 + 1], uz = p[b0 + 2] - p[a0 + 2];
        const vx = p[c0] - p[a0], vy = p[c0 + 1] - p[a0 + 1], vz = p[c0 + 2] - p[a0 + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (!len) continue;
        const best = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz)) / len;
        all += len;
        if (best > Math.cos((5 * Math.PI) / 180)) on += len;
      }
      return on / all;
    };
    expect(axisFraction(b)).toBeGreaterThan(axisFraction(a) + 0.05);
    a.delete();
    b.delete();
    soft.delete();
  });

  it('is cached: toggling the enhancement off and on again does not recompute, and text still conforms to the enhanced model', async () => {
    const soft = softCube();
    await load(soft);
    const settings = { sharpen: 0.8, detail: 0.3, smooth: 0.5, edgeAngle: 30, featureSize: 0, maxMove: 0 };
    progress.length = 0;
    await client.updateBase({ version: ++version, transforms: [], simplify: null, enhance: settings });
    expect(progress.some((s) => /Enhancing/.test(s))).toBe(true);
    const off = await client.updateBase({ version: ++version, transforms: [], simplify: null, enhance: null });
    expect(off.info.enhanced).toBeNull();
    progress.length = 0;
    const on = await client.updateBase({ version: ++version, transforms: [], simplify: null, enhance: settings });
    expect(on.info.enhanced.failed).toBe(false);
    // the cached result is reused: no per-step progress from the enhancer itself
    expect(progress.filter((s) => /Enhancing/.test(s)).length).toBeLessThanOrEqual(1);
    const text = createItem({ text: 'Hi', fontId: 'inter', size: 6, position: [0, 0, 5.5], normal: [0, 0, 1] });
    await client.addFont('inter', (await import('node:fs')).readFileSync('node_modules/@fontsource/inter/files/inter-latin-700-normal.woff').buffer);
    const preview = await client.preview(text, version);
    expect(preview.notes.map((n) => n.code)).not.toContain('NOT_TOUCHING');
    soft.delete();
  });

  it('all amounts zero means no enhancement at all', async () => {
    const soft = softCube();
    await load(soft);
    const r = await client.updateBase({ version: ++version, transforms: [], simplify: null, enhance: { sharpen: 0, detail: 0, smooth: 0, edgeAngle: 30, featureSize: 0, maxMove: 0 } });
    expect(r.info.enhanced).toBeNull();
    soft.delete();
  });
});
