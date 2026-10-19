import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { createEngine } from '../src/engine.js';
import { createEngineClient, createLocalWorker } from '../src/engineClient.js';
import { createItem, createPart } from '../src/document.js';
import { manifold } from '../src/manifold.js';
import { parseSTL, writeBinarySTL } from '../src/stl.js';
import { geometryToManifold } from '../src/mesh.js';
import {
  APART_HOLDS, FILAMENT, SPLIT_DEFAULTS, TO_PLANE, cellSizes, cellSupport, fitPieces, isSymmetric, orientationStats, pegSizesFor, sizesFor,
} from '../src/split.js';
import { clearSplitCaches, dowelHole, halfHole, pegAt, pinAt, pinSolid, socketAt } from '../src/splitGeometry.js';
import { setup, soupOf as soupGeometry } from './helpers.js';
import { box, gothicSolid, lanternSolid, lidBoxSolid, lift, loggiaSolid, roundLanternSolid, slenderTowerSolid, stlCheck } from './lanternFixture.js';

const fontBytes = (pkg, file) => {
  const buf = fs.readFileSync(path.resolve('node_modules/@fontsource', pkg, 'files', file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};
const stlOf = (solid) => writeBinarySTL(soupGeometry(solid));
const solidOfStl = (buffer) => geometryToManifold(parseSTL(buffer));
const volumeOfStl = (buffer) => {
  const m = solidOfStl(buffer);
  const v = m.volume();
  m.delete();
  return v;
};

let wasm;
let client;
let version = 0;
const stages = [];

beforeAll(async () => {
  await setup();
  wasm = manifold();
  const engine = createEngine({ wasm });
  client = createEngineClient({ createWorker: () => createLocalWorker(Promise.resolve(engine)), onProgress: (p) => stages.push(p.stage) });
  await client.addFont('inter', fontBytes('inter', 'inter-latin-700-normal.woff'));
  const bar = wasm.Manifold.cube([20, 6, 3], true);
  await client.addPart('bar', stlOf(bar), 'bar');
  bar.delete();
});

// every Manifold a test makes goes in here and is deleted after it
const made = [];
const own = (m) => {
  made.push(m);
  return m;
};
afterEach(() => {
  for (const m of made.splice(0)) m.delete();
});

const BED = [210, 210, 249]; // the default printer's room: 220 × 220 × 250 less a 5 mm margin
const printing = { nozzle: 0.4, layerHeight: 0.2 };
const cutAt = (axis, at, id = 'c1') => ({ id, position: [0, 1, 2].map((a) => (a === axis ? at : 0)), normal: [0, 1, 2].map((a) => (a === axis ? 1 : 0)) });
const S = (patch = {}) => ({ ...SPLIT_DEFAULTS, cuts: [cutAt(0, 0)], ...patch });
const cube = (size, at = [0, 0, 0]) => own(own(wasm.Manifold.cube(size, true)).translate(at));
const boxOf = (m) => {
  const { min, max } = m.boundingBox();
  return { min: [...min], max: [...max], size: [0, 1, 2].map((a) => max[a] - min[a]) };
};
const overlap = (a, b) => own(a.intersect(b)).volume();

async function load(solid, name = 'box') {
  await client.loadBase({ kind: 'stl', bytes: stlOf(solid), name, version: ++version });
}
/** A model given as a triangle soup (for unrepaired triangles). */
async function loadSoup(soup, name) {
  await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(soup), name, version: ++version });
}
const soupOf = (solid) => soupGeometry(solid).attributes.position.array;
const withTriangle = (solid, tri) => {
  const soup = soupOf(solid);
  const both = new Float32Array(soup.length + 9);
  both.set(soup);
  both.set(tri, soup.length);
  return both;
};

const exportSplit = (split, { items = [], name = 'box', bed = BED, archive = 'files' } = {}) => client.export(items, version, name, { printing, split, bed, archive });
const resultSplit = (split, { items = [], bed = BED } = {}) => client.result(items, version, { printing, split, bed });
const piecesOf = (ex) => ex.files.filter((f) => f.kind === 'piece');
const pieceSolid = (f) => own(solidOfStl(f.stl));
/** A piece put back where it was in the model: its file read back, moved by its print → world matrix. */
const assembled = (f) => own(pieceSolid(f).transform(f.matrix));
const codes = (r) => r.notes.map((n) => n.code);
const noteOf = (r, code) => r.notes.find((n) => n.code === code);
const dowelsOf = (r) => r.seams.flatMap((s) => s.dowels);
/** Both halves of every dowel's hole, rebuilt in place from the reply. */
const holesOf = (r) => dowelsOf(r).flatMap((d) => [0, 1].map((side) => ({ dowel: d, side, m: own(dowelHole(d, side)) })));

/**
 * Counts the Manifolds and CrossSections the bindings hand out while it
 * runs that have not been deleted: every method and constructor of both
 * classes is wrapped to remember what it returns (a deleted one says so).
 * The engine's own counts of what it caches cannot see a solid it forgot.
 */
function trackSolids() {
  const tracked = new Set();
  const restore = [];
  const remember = (v) => {
    if (Array.isArray(v)) v.forEach(remember);
    else if (v instanceof wasm.Manifold || v instanceof wasm.CrossSection) tracked.add(v);
    return v;
  };
  for (const Class of [wasm.Manifold, wasm.CrossSection]) {
    // the instances' methods sit on the bindings' own class, one step up from the class the module hands out
    for (const target of new Set([Class, Class.prototype, Object.getPrototypeOf(Class.prototype)])) {
      for (const key of Object.getOwnPropertyNames(target)) {
        const d = Object.getOwnPropertyDescriptor(target, key);
        if (typeof d.value !== 'function' || !d.writable || /^(constructor|delete|deleteLater|isDeleted|isAliasOf)$/.test(key)) continue;
        const fn = d.value;
        target[key] = function remembered(...args) {
          return remember(fn.apply(this, args));
        };
        restore.push(() => {
          target[key] = fn;
        });
      }
    }
  }
  return {
    made: () => tracked.size,
    // the few shapes the layout keeps between splits (holes, pins, label outlines) are bounded: they are let go first
    live: () => {
      clearSplitCaches();
      return [...tracked].filter((m) => !m.isDeleted()).length;
    },
    stop: () => restore.forEach((r) => r()),
  };
}

/** Every hole lies inside the model and keeps at least a wall's thickness from its outside. */
function expectHolesInside(solid, r) {
  const b = boxOf(solid);
  const air = own(cube(b.size.map((v) => v + 40), b.min.map((v, a) => (v + b.max[a]) / 2)).subtract(solid));
  for (const { dowel, m } of holesOf(r)) {
    const wall = sizesFor(dowel.d).wall;
    expect(own(m.subtract(solid)).volume()).toBeLessThan(1e-6);
    expect(m.minGap(air, wall + 1)).toBeGreaterThanOrEqual(wall - 1e-6);
  }
}

describe('cutting a model into pieces', () => {
  it('a cut box comes out as two watertight pieces, standing on their cut faces, with round chamfered cone-ended holes', async () => {
    await load(cube([120, 40, 30]));
    const ex = await exportSplit(S({ diameter: 5, depth: 8, count: 2, labels: false }));
    expect(ex.stl).toBeNull();
    expect(ex.zip).toBeUndefined();
    expect(piecesOf(ex).map((f) => f.name)).toEqual(['box-piece-1-of-2', 'box-piece-2-of-2']);
    expect(piecesOf(ex).map((f) => f.file)).toEqual(['box-piece-1-of-2.stl', 'box-piece-2-of-2.stl']);
    expect(ex.pieces.map((p) => [p.index, p.lies, p.fits, p.dowels])).toEqual([[1, 'on a cut face', true, 2], [2, 'on a cut face', true, 2]]);
    expect(codes(ex)).toEqual(['SPLIT', 'PINS']);
    for (const f of piecesOf(ex)) {
      expect(new DataView(f.stl).getUint32(80, true)).toBe(f.triangles);
      const m = pieceSolid(f);
      expect(m.status()).toBe('NoError');
      expect(m.decompose().map(own)).toHaveLength(1);
      expect(m.genus()).toBe(0);
      const b = boxOf(m);
      expect(b.min[2]).toBeCloseTo(0, 3);
      expect(b.size[2]).toBeCloseTo(60, 2);
      expect([b.size[0], b.size[1]].sort((p, q) => p - q).map((v) => v.toFixed(3))).toEqual(['30.000', '40.000']);
      // the face on the bed: outline and two holes, the chamfers narrowing to the bore
      const low = own(m.slice(0.05));
      const high = own(m.slice(0.6));
      expect(low.area()).toBeCloseTo(1139.39, 1);
      expect(high.area()).toBeCloseTo(1155.734, 2);
      expect(high.numContour()).toBe(3);
      expect(m.volume()).toBeCloseTo(72000 - 2 * 209.901, 0);
    }
    // the volume each half-hole takes out of the solid, from the shape itself
    const above = cube([100, 100, 100], [0, 0, 50]);
    expect(overlap(own(halfHole({ R: 2.65, h: 8.5, ch: 0.5 })), above)).toBeCloseTo(209.901, 2);
  });

  it('auto lays bar halves flat, picks Ø6 pins from the 20 mm thickness, and gives the horizontal holes a teardrop roof', async () => {
    await load(cube([300, 40, 20]), 'bar');
    const ex = await exportSplit(S({ labels: false }), { name: 'bar' });
    expect(ex.diameter).toBe(6);
    for (const p of ex.pieces) {
      expect(p.lies).toBe('flat as modelled');
      expect(p.size.map((v) => +v.toFixed(3))).toEqual([150, 40, 20]);
    }
    const [seam] = ex.seams;
    expect(seam).toMatchObject({ letter: 'A', axis: 0, at: 0, pieces: [1, 2], joint: 'dowels', labels: null });
    expect(seam.dowels).toHaveLength(2);
    for (const d of seam.dowels) expect(d).toMatchObject({ d: 6, depth: 9.5, tear: [true, true], cell: [0.5, 0, 0] });
    // a teardrop hole takes 372.679 mm³ from each side, a round one would take 348.180
    for (const f of piecesOf(ex)) expect(volumeOfStl(f.stl)).toBeCloseTo(120000 - 2 * 372.679, 0);
    // the pins fit one way only: turned half round, the face would not match
    expect(isSymmetric(seam.dowels.map((d) => [d.centre[1], d.centre[2]]), [0, 0], 3)).toBe(false);
    expect(noteOf(ex, 'SPLIT').text).toBe('Cut into 2 pieces with 2 pins Ø6 × 19 mm.');
  });

  it('pieces with Ø8 holes are saved with no zero-area triangles, every edge met once each way', async () => {
    // a 500 mm tower in three: Auto takes Ø8 pins, and the pieces stand on their cut faces with round holes
    await load(cube([60, 60, 500], [0, 0, 250]), 'tower');
    const ex = await exportSplit(S({ cuts: [cutAt(2, 500 / 3, 'c1'), cutAt(2, 1000 / 3, 'c2')], labels: false }), { name: 'tower' });
    expect(new Set(dowelsOf(ex).map((d) => d.d))).toEqual(new Set([8]));
    for (const f of piecesOf(ex)) {
      // read as a slicer reads it: float32 corners, matched exactly
      const p = parseSTL(f.stl).attributes.position.array;
      const key = (i) => `${p[i]},${p[i + 1]},${p[i + 2]}`;
      const edges = new Map();
      let degenerate = 0;
      for (let t = 0; t < p.length; t += 9) {
        const k = [key(t), key(t + 3), key(t + 6)];
        if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) degenerate++;
        for (let i = 0; i < 3; i++) edges.set(`${k[i]}|${k[(i + 1) % 3]}`, (edges.get(`${k[i]}|${k[(i + 1) % 3]}`) ?? 0) + 1);
      }
      let open = 0;
      for (const [e, n] of edges) if (n !== 1 || edges.get(e.split('|').reverse().join('|')) !== 1) open++;
      expect({ degenerate, open }, f.file).toEqual({ degenerate: 0, open: 0 });
    }
  });

  it('pins fit their holes with the clearance at any turn, and the pieces never overlap', async () => {
    await load(cube([120, 40, 30]));
    const ex = await exportSplit(S({ diameter: 5, depth: 8, count: 2, labels: false }));
    const [A, B] = piecesOf(ex).map(assembled);
    expect(overlap(A, B)).toBeLessThan(0.01); // float32 files: never isEmpty() between touching faces
    expect(boxOf(A).max[0]).toBeCloseTo(0, 4);
    expect(boxOf(B).min[0]).toBeCloseTo(0, 4);
    for (const d of dowelsOf(ex)) {
      expect(own(pinAt(d)).volume()).toBeCloseTo(own(pinSolid({ r: 2.5, L: 16, e: 0.4 })).volume(), 9);
      let least = Infinity;
      let worst = 0;
      for (let deg = 0; deg <= 45; deg += 0.5) {
        const pin = pinAt(d, deg);
        least = Math.min(least, pin.minGap(A, 1), pin.minGap(B, 1));
        for (const piece of [A, B]) {
          const both = pin.intersect(piece);
          worst = Math.max(worst, both.volume());
          both.delete();
        }
        pin.delete();
      }
      expect(worst).toBeLessThan(1e-6);
      // the files hold float32 coordinates, a few millionths of a millimetre off the designed surface
      expect(least).toBeGreaterThanOrEqual(0.15 - 1e-5);
      expect(least).toBeCloseTo(0.15, 3);
    }
  });

  it('the summary counts one pin size cut to two lengths as two lengths', async () => {
    // the cut near the end has room for shallower holes only
    await load(cube([300, 40, 20]), 'bar');
    const ex = await exportSplit(S({ cuts: [cutAt(0, -135, 'c1'), cutAt(0, 0, 'c2')], labels: false }), { name: 'bar' });
    expect(ex.diameter).toBe(6);
    expect(noteOf(ex, 'CONNECTORS_SHORTER')).toMatchObject({ letter: 'A' });
    const lengths = dowelsOf(ex).map((d) => 2 * d.depth).sort((p, q) => p - q);
    expect(lengths).toEqual([17.8, 17.8, 19, 19]);
    expect(noteOf(ex, 'SPLIT').text).toBe('Cut into 3 pieces with 4 pins Ø6 mm (2 × 19 mm, 2 × 17.8 mm).');
    expect(ex.notes.filter((n) => n.code === 'PINS').map((n) => n.length)).toEqual([19, 17.8]);
  });

  it('the summary counts every pin, of every size: the filament that narrow faces fall back to never hides the main pins', async () => {
    // a 40 × 20 bar takes Ø6 pins; three 8 mm rods beside it are too narrow for them and take a filament pin each
    const rods = [40, 55, 70].map((y) => cube([300, 8, 8], [0, y, 4]));
    await load(own(wasm.Manifold.union([cube([300, 40, 20], [0, 0, 10]), ...rods])), 'rack');
    const ex = await exportSplit(S({ labels: false }), { name: 'rack' });
    expect(dowelsOf(ex).map((d) => d.d).sort((p, q) => q - p)).toEqual([6, 6, FILAMENT, FILAMENT, FILAMENT]);
    expect(noteOf(ex, 'SPLIT')).toMatchObject({ dowels: 5, diameter: 6, text: 'Cut into 2 pieces with 5 pins (2 × Ø6 × 19 mm, 3 × Ø1.75 × 8 mm).' });
  });

  it('the pins file holds one pin per hole pair plus a spare, lying flat', async () => {
    await load(cube([120, 40, 30]));
    const ex = await exportSplit(S({ diameter: 5, depth: 8, count: 2, labels: false }));
    const sheet = ex.files.find((f) => f.kind === 'pins');
    expect(sheet).toMatchObject({ name: 'box-pins-3x-5x16mm', d: 5, length: 16, count: 3, spares: 1, fits: true });
    const pins = pieceSolid(sheet).decompose().map(own);
    expect(pins).toHaveLength(3);
    for (const p of pins) {
      expect(boxOf(p).size.map((v) => v.toFixed(3))).toEqual(['16.000', '4.619', '4.619']);
      expect(p.volume()).toBeCloseTo(280.701, 1);
    }
    expect(noteOf(ex, 'PINS')).toMatchObject({ count: 2, spares: 1, diameter: 5, length: 16 });
    // your own dowels: the same holes, no pins file
    const mine = await exportSplit(S({ diameter: 5, depth: 8, count: 2, labels: false, pins: 'own' }));
    expect(mine.files.some((f) => f.kind === 'pins')).toBe(false);
    expect(noteOf(mine, 'PINS').text).toMatch(/cut 2 Ø5 mm dowels to 16 mm/);
    expect(piecesOf(mine).map((f) => f.triangles)).toEqual(piecesOf(ex).map((f) => f.triangles));
  });
});

describe('where the pins go', () => {
  it('no hole breaks out or comes closer than the wall to an outside surface', async () => {
    const tube = (w) => own(cube([60, 60, 200], [0, 0, 100]).subtract(cube([60 - 2 * w, 60 - 2 * w, 210], [0, 0, 100])));
    const across = S({ cuts: [cutAt(2, 100)], labels: false });
    let solid = tube(10);
    await load(solid, 'tube');
    let r = await resultSplit({ ...across, diameter: 5 });
    expect(dowelsOf(r).length).toBeGreaterThanOrEqual(2);
    for (const d of dowelsOf(r)) expect(Math.min(Math.abs(d.centre[0]), Math.abs(d.centre[1]))).toBeGreaterThan(20); // in the corners
    expectHolesInside(solid, r);

    solid = tube(8);
    await load(solid, 'tube');
    r = await resultSplit({ ...across, diameter: 5 });
    expect(dowelsOf(r).map((d) => d.d)).toEqual([1.75, 1.75]);
    expect(noteOf(r, 'CONNECTORS_FILAMENT')).toMatchObject({ letter: 'A', count: 2, diameter: 5 });
    expectHolesInside(solid, r);
    r = await resultSplit(across);
    expect(r.diameter).toBe(3);
    expect(dowelsOf(r).map((d) => d.d)).toEqual([3, 3]);
    expectHolesInside(solid, r);

    await load(tube(3), 'tube');
    const ex = await exportSplit(across, { name: 'tube' });
    expect(noteOf(ex, 'CONNECTORS_DROPPED')).toMatchObject({ level: 'warn', letter: 'A' });
    expect(dowelsOf(ex)).toHaveLength(0);
    expect(ex.files.some((f) => f.kind === 'pins')).toBe(false);
    expect(piecesOf(ex)).toHaveLength(2);
    for (const f of piecesOf(ex)) {
      const m = pieceSolid(f);
      expect(m.status()).toBe('NoError');
      expect(m.genus()).toBe(1); // a ring
    }

    // a pocket 1 mm behind the face, and a cone's slanted side
    solid = own(cube([60, 40, 40]).subtract(cube([20, 10, 4], [0, 0, 3])));
    await load(solid, 'pocket');
    r = await resultSplit({ ...S({ cuts: [cutAt(2, 0)], labels: false }), diameter: 5 });
    expect(dowelsOf(r).length).toBeGreaterThanOrEqual(2);
    expectHolesInside(solid, r);
    solid = own(wasm.Manifold.cylinder(100, 30, 5, 64));
    await load(solid, 'cone');
    r = await resultSplit(S({ cuts: [cutAt(2, 50)], labels: false }));
    expect(dowelsOf(r).length).toBeGreaterThanOrEqual(2);
    expectHolesInside(solid, r);
  });

  it('each patch gets its own pins; crossing cuts never let holes meet', async () => {
    const U = own(own(wasm.Manifold.cube([60, 20, 50])).subtract(own(own(wasm.Manifold.cube([40, 30, 40])).translate([10, -5, 15]))));
    await load(U, 'u');
    let r = await resultSplit(S({ cuts: [cutAt(2, 30)], labels: false }));
    expect(r.pieces.map((p) => p.shells)).toEqual([1, 2]);
    expect(r.seams).toHaveLength(1);
    expect([0, 1].map((k) => r.seams[0].dowels.filter((d) => d.patch === k).length)).toEqual([2, 2]);
    expectHolesInside(U, r);

    // a plate cut on X and Y (a regression: the pieces once came out with holes through them)
    await load(cube([400, 300, 20]), 'plate');
    let ex = await exportSplit(S({ cuts: [cutAt(0, 0, 'c1'), cutAt(1, 10, 'c2')], labels: false }), { name: 'plate' });
    expect(piecesOf(ex)).toHaveLength(4);
    for (const f of piecesOf(ex)) expect(pieceSolid(f).genus()).toBe(0);

    const block = cube([200, 200, 80]);
    await load(block, 'block');
    ex = await exportSplit(S({ cuts: [cutAt(0, 0, 'c1'), cutAt(1, 0, 'c2'), cutAt(2, 0, 'c3')], labels: false }), { name: 'block' });
    expect(piecesOf(ex)).toHaveLength(8);
    for (const f of piecesOf(ex)) {
      const m = pieceSolid(f);
      expect(m.decompose().map(own)).toHaveLength(1);
      expect(m.genus()).toBe(0);
    }
    expect(dowelsOf(ex).length).toBeLessThanOrEqual(48);
    const holes = holesOf(ex);
    const wall = sizesFor(ex.diameter).wall;
    for (let i = 0; i < holes.length; i++) {
      for (let j = i + 1; j < holes.length; j++) {
        if (holes[i].dowel === holes[j].dowel) continue;
        expect(holes[i].m.minGap(holes[j].m, wall + 1)).toBeGreaterThanOrEqual(wall - 1e-6);
      }
    }
  });

  it('a thin middle piece between two parallel cuts never gets holes that meet', async () => {
    await load(cube([300, 60, 60]), 'bar');
    const ex = await exportSplit(S({ cuts: [cutAt(0, -5, 'c1'), cutAt(0, 5, 'c2')], diameter: 5, labels: false }), { name: 'bar' });
    const middle = pieceSolid(piecesOf(ex)[1]);
    expect(middle.decompose().map(own)).toHaveLength(1);
    expect(middle.genus()).toBe(0);
    const holes = holesOf(ex).filter((x) => x.dowel.sides[x.side].piece === 2);
    expect(holes.length).toBeGreaterThanOrEqual(4);
    const wall = sizesFor(5).wall;
    for (const { dowel } of holes) expect(dowel.h + dowel.R + wall).toBeLessThanOrEqual(10 + 1e-9);
    const fromA = holes.filter((x) => x.dowel.centre[0] < 0);
    const fromB = holes.filter((x) => x.dowel.centre[0] > 0);
    for (const a of fromA) for (const b of fromB) expect(a.m.minGap(b.m, 5)).toBeGreaterThanOrEqual(wall - 1e-6);
    expect(ex.notes.filter((n) => n.code === 'CONNECTORS_SHORTER').map((n) => [n.letter, n.depth])).toEqual([['A', 4.8], ['B', 4.8]]);
  });
});

describe('thin plates and labels', () => {
  it('a thin sign gets dovetail tabs that lock in the plane and go together by lowering', async () => {
    const sign = own(wasm.Manifold.union([cube([300, 80, 5], [0, 0, 2.5]), cube([20, 20, 10], [-80, 0, 10])]));
    await load(sign, 'sign');
    const m = await client.planSplit([], version, { printing, split: S(), bed: BED, mode: 'measure' });
    expect(m.cuts).toEqual([expect.objectContaining({ id: 'c1', letter: 'A', axis: 0, at: 0, joint: 'dovetail', islands: 1, tabs: 2, w: 2 })]);
    expect(m.cuts[0].area).toBeCloseTo(400, 6);
    // how far the tabs reach either way: the main thread sizes the pieces with them, lying flat
    expect(m.cuts[0].reach.map((v) => +v.toFixed(6))).toEqual([9.6, 9.6]);
    const { cells } = cellSizes(m.bounds, [{ ...S().cuts[0], reach: m.cuts[0].reach, w: m.cuts[0].w }]);
    expect(cells.map((c) => [+c.size[0].toFixed(6), c.flat])).toEqual([[159.6, 2], [159.6, 2]]);
    const ex = await exportSplit(S(), { name: 'sign' });
    expect(noteOf(ex, 'DOVETAIL')).toMatchObject({ letter: 'A', tabs: 2, pieces: [1, 2] });
    expect(ex.seams).toEqual([expect.objectContaining({ joint: 'dovetail', tabs: 2, labels: null, dowels: [] })]);
    expect(ex.files.some((f) => f.kind === 'pins')).toBe(false);
    for (const f of piecesOf(ex)) {
      const p = pieceSolid(f);
      expect(p.decompose().map(own)).toHaveLength(1);
      expect(boxOf(p).min[2]).toBeCloseTo(0, 4);
    }
    expect(ex.pieces.map((p) => p.lies)).toEqual(['flat as modelled', 'flat as modelled']);
    const [A, B] = piecesOf(ex).map(assembled);
    const moved = (x, y, z) => overlap(A, own(B.translate([x, y, z])));
    // the files' float32 coordinates leave a sliver of overlap (about 0.001 mm³) where the flat parts of the seam butt
    expect(moved(0, 0, 0)).toBeLessThan(0.01);
    // locked: pulled apart, the heads bite once the side clearance is taken up; slid 1 mm along the seam, the flanks meet
    // (pushing them together proves nothing: the faces meet whatever the tabs)
    expect(moved(2, 0, 0)).toBeGreaterThan(30);
    expect(moved(0, 1, 0)).toBeGreaterThan(70);
    expect(moved(0, -1, 0)).toBeGreaterThan(70);
    expect(moved(0, 0, 6)).toBeLessThan(1e-3); // lifted clear: they go together by lowering
    expect(moved(0, 0.1, 0)).toBeLessThan(0.01); // the flanks have the clearance: no more than that round-off
    expect(moved(0, 0.2, 0)).toBeGreaterThan(1);
    // unrepaired triangles can't follow a tab's outline: pins instead
    await loadSoup(withTriangle(sign, [100, 60, 0, 101, 60, 0, 100, 61, 0]), 'sign');
    const loose = await exportSplit(S(), { name: 'sign' });
    expect(codes(loose)).not.toContain('DOVETAIL');
    expect(loose.seams[0].joint).toMatch(/^(dowels|none)$/);
  });

  it('labels: each dowel face carries its piece number and the cut letter', async () => {
    await load(cube([120, 40, 30]));
    const plain = await exportSplit(S({ diameter: 5, depth: 8, count: 2, labels: false }));
    const ex = await exportSplit(S({ diameter: 5, depth: 8, count: 2 }));
    expect(ex.seams[0].labels).toEqual(['1A', '2A']);
    expect(noteOf(ex, 'SPLIT').text).toMatch(/1A ↔ 2A/);
    piecesOf(ex).forEach((f, k) => {
      const m = pieceSolid(f);
      // standing on its cut face: the outline, two holes, the digit, and the A with its counter
      expect(own(m.slice(0.05)).numContour()).toBe(6);
      expect(m.genus()).toBe(0);
      expect(volumeOfStl(piecesOf(plain)[k].stl) - m.volume()).toBeGreaterThan(5);
    });
  });
});

describe('checking and planning cuts', () => {
  it('cuts are checked: off the model, duplicated, or exactly on a flat face', async () => {
    await load(cube([120, 40, 30]));
    let ex = await exportSplit(S({ cuts: [cutAt(0, 100)] }));
    expect(ex.stl).toBeInstanceOf(ArrayBuffer);
    expect(ex.zip).toBeUndefined();
    expect(ex.files).toBeUndefined();
    expect(noteOf(ex, 'CUT_MISSES')).toMatchObject({ level: 'warn', cutId: 'c1', letter: 'A' });
    expect(volumeOfStl(ex.stl)).toBeCloseTo(144000, 2);
    ex = await exportSplit(S({ cuts: [cutAt(1, 0, 'c1'), cutAt(1, 0.001, 'c2')], labels: false }));
    expect(noteOf(ex, 'CUTS_MERGED')).toMatchObject({ letters: ['A', 'B'] });
    expect(piecesOf(ex)).toHaveLength(2);
    // too many cuts is refused with its own code
    const many = Array.from({ length: 13 }, (_, i) => cutAt(0, -55 + 9 * i, `c${i + 1}`));
    await expect(exportSplit(S({ cuts: many }))).rejects.toMatchObject({ code: 'SPLIT_INVALID' });
    // a stepped block cut exactly at its step: two pieces, nothing lost, and the step comes away as it is – no
    // paper-thin flap of the face below joined to it, stretching its box and spoiling its file
    const step = own(wasm.Manifold.union([cube([100, 40, 30], [0, 0, 15]), cube([50, 40, 10], [-25, 0, 35])]));
    await load(step, 'step');
    ex = await exportSplit(S({ cuts: [cutAt(2, 30)], labels: false }), { name: 'step' });
    expect(piecesOf(ex)).toHaveLength(2);
    expect(codes(ex)).not.toContain('SPLIT_CHECK');
    expect([...ex.pieces[1].size].sort((p, q) => p - q)).toEqual([10, 40, 50]);
    // with its pins, the step's file reads back as the step less two half-holes (a flap made it 14286 mm³)
    const pinned = await exportSplit(S({ cuts: [cutAt(2, 30)], labels: false, diameter: 5, depth: 8 }), { name: 'step' });
    const upper = pieceSolid(piecesOf(pinned)[1]);
    expect(boxOf(upper).size.sort((p, q) => p - q).map((v) => +v.toFixed(3))).toEqual([10, 40, 50]);
    const taken = holesOf(pinned).filter((x) => x.dowel.sides[x.side].piece === 2).reduce((v, x) => v + overlap(x.m, cube([50, 40, 10], [-25, 0, 35])), 0);
    expect(taken).toBeGreaterThan(100);
    expect(upper.volume()).toBeCloseTo(20000 - taken, 0);
    // a tower on a base cut where it stands: the tower fits lying down, not taken for a 200 mm wide piece
    await load(own(wasm.Manifold.union([cube([200, 200, 30], [0, 0, 15]), cube([20, 20, 260], [0, 0, 160])])), 'tower');
    ex = await exportSplit(S({ cuts: [cutAt(2, 30)], labels: false }), { name: 'tower' });
    expect(codes(ex)).not.toContain('PIECE_TOO_BIG');
    expect([...ex.pieces[1].size].sort((p, q) => p - q)).toEqual([20, 20, 260]);
  });

  it('Fit to my printer plans the fewest cuts and avoids letters', async () => {
    const plan = (split = SPLIT_DEFAULTS, items = [], bed = BED) => client.planSplit(items, version, { printing, split, bed, mode: 'fit' });
    await load(cube([300, 40, 20]), 'bar');
    let p = await plan();
    expect(p.counts).toEqual([1, 0, 0]);
    expect(p.cuts).toHaveLength(1);
    expect(p.cuts[0].normal).toEqual([1, 0, 0]);
    expect(p.cuts[0].position[0]).toBeCloseTo(0, 6);
    expect(p.pieces.map((x) => [x.size.map((v) => +v.toFixed(3)), x.fits])).toEqual([[[150, 40, 20], true], [[150, 40, 20], true]]);
    // two equal halves of 300 do fit; 600 needs three pieces
    await load(cube([600, 40, 20]), 'long');
    p = await plan();
    expect(p.cuts.map((c) => c.position[0])).toEqual([expect.closeTo(-100, 3), expect.closeTo(100, 3)]);
    await load(cube([240, 40, 20]), 'short');
    p = await plan();
    expect(p.cuts).toEqual([]);
    expect(noteOf(p, 'SPLIT_NOT_NEEDED').text).toMatch(/turned 40°/);
    await client.loadBase({ kind: 'sample', version: ++version });
    expect(codes(await plan())).toEqual(['SPLIT_NOT_NEEDED']);

    // raised text across the middle of the bar: the cut goes beside it
    await load(cube([300, 40, 20]), 'bar');
    const hello = createItem({ text: 'HELLO', fontId: 'inter', size: 12, position: [0, 0, 10], normal: [0, 0, 1] });
    const shown = await client.preview(hello, version);
    const [x0, x1] = [shown.bounds.min[0], shown.bounds.max[0]];
    expect(x1 - x0).toBeGreaterThan(40);
    p = await plan(SPLIT_DEFAULTS, [hello]);
    const at = p.cuts[0].position[0];
    expect(at < x0 - 1 || at > x1 + 1).toBe(true);
    const beside = await exportSplit({ ...SPLIT_DEFAULTS, cuts: [{ id: 'c1', ...p.cuts[0] }], labels: false }, { items: [hello], name: 'bar' });
    expect(codes(beside)).not.toContain('CUT_THROUGH_TEXT');
    const m = await client.planSplit([hello], version, { printing, split: S({ cuts: [cutAt(0, 0, 'c1'), cutAt(0, at, 'c2'), cutAt(0, 400, 'c3')] }), bed: BED, mode: 'measure' });
    expect(m.cuts.map((c) => [c.letter, c.joint, c.crosses])).toEqual([['A', 'dowels', [hello.id]], ['B', 'dowels', []], ['C', 'miss', []]]);
    expect(m.bounds.max[2]).toBeGreaterThan(10); // the text stands on the bar

    // a piece too long for the bed is still made, with a warning
    const ex = await exportSplit(S({ cuts: [cutAt(0, -140)], labels: false }), { name: 'bar' });
    expect(noteOf(ex, 'PIECE_TOO_BIG')).toMatchObject({ level: 'warn', pieceIndex: 2 });
    expect(ex.pieces.map((x) => x.fits)).toEqual([true, false]);
    expect(piecesOf(ex)).toHaveLength(2);
  });

  it('Fit to my printer plans thin plates lying flat, with their dovetail tabs counted', async () => {
    const plan = (items = []) => client.planSplit(items, version, { printing, split: SPLIT_DEFAULTS, bed: BED, mode: 'fit' });
    /** Fit, then the download of that plan: every piece fits and is no bigger than planned (tabs counted). */
    const fitted = async (name, items = [], { filled = true } = {}) => {
      const p = await plan(items);
      const split = { ...SPLIT_DEFAULTS, cuts: p.cuts.map((c, i) => ({ id: `c${i + 1}`, ...c })) };
      const ex = await exportSplit(split, { items, name });
      expect(codes(ex)).not.toContain('PIECE_TOO_BIG');
      expect(ex.pieces.map((x) => x.fits)).toEqual(p.pieces.map(() => true));
      expect(p.pieces.every((x) => x.fits)).toBe(true);
      // the plan's boxes hold the tabs: a piece that fills its box comes out the size planned, less half the
      // clearance at each tab's end
      ex.pieces.forEach((x, i) => {
        const planned = [...p.pieces[i].size].sort((a, b) => a - b);
        [...x.size].sort((a, b) => a - b).forEach((v, a) => {
          expect(v).toBeLessThanOrEqual(planned[a] + 1e-6);
          if (filled) expect(v).toBeGreaterThan(planned[a] - 0.2);
        });
      });
      return { p, ex };
    };
    // a 400 mm sign: two halves would be 212 mm with their tabs, so it takes three
    await load(cube([400, 100, 4]), 'sign');
    let { p, ex } = await fitted('sign');
    expect(p.counts).toEqual([2, 0, 0]);
    expect(ex.seams.map((s) => s.joint)).toEqual(['dovetail', 'dovetail']);
    expect(ex.pieces.map((x) => x.lies)).toEqual(['flat as modelled', 'flat as modelled', 'flat as modelled']);
    // the same sign standing up: its pieces are laid flat, so it is cut across both ways
    await load(cube([300, 5, 260]), 'standing');
    ({ p, ex } = await fitted('standing'));
    expect(p.counts).toEqual([1, 0, 1]);
    for (const x of ex.pieces) expect(['-y', '+y']).toContain(x.down);
    // raised text on a sign: the cut goes between the words and the longer piece still fits with its tab
    await load(cube([300, 90, 4]), 'sign');
    const words = createItem({ text: 'HELLO WORLD', fontId: 'inter', size: 24, position: [0, 0, 2], normal: [0, 0, 1] });
    ({ p, ex } = await fitted('sign', [words], { filled: false }));
    expect(p.counts).toEqual([1, 0, 0]);
    expect(ex.pieces.every((x) => x.down === '-z')).toBe(true);
    // and the tabs keep clear of the letters beside the cut: no piece takes a slice of a letter on the other side
    expect(ex.seams[0]).toMatchObject({ joint: 'dovetail' });
    const at = p.cuts[0].position[0];
    const [left, right] = piecesOf(ex).map(assembled);
    const raised = (lo, hi) => cube([hi - lo, 400, 50], [(lo + hi) / 2, 0, 27.001]);
    expect(overlap(left, raised(at + 0.001, 400))).toBeLessThan(0.01);
    expect(overlap(right, raised(-400, at - 0.001))).toBeLessThan(0.01);
    // letters with no model: three pieces lying flat, not two standing on their edges
    await client.loadBase({ kind: 'none', version: ++version });
    const big = createItem({ text: 'HELLO WORLD', fontId: 'inter', size: 60 });
    ({ p, ex } = await fitted('sign', [big], { filled: false }));
    expect(p.counts).toEqual([2, 0, 0]);
    expect(ex.pieces.map((x) => x.lies)).toEqual(['flat as modelled', 'flat as modelled', 'flat as modelled']);
  });

  it('text across a cut is split with the model', async () => {
    const bar = cube([300, 40, 20]);
    await load(bar, 'bar');
    const hello = createItem({ text: 'HELLO', fontId: 'inter', size: 12, position: [0, 0, 10], normal: [0, 0, 1] });
    const whole = await client.export([hello], version, 'bar', { printing });
    const ex = await exportSplit(S({ labels: false }), { items: [hello], name: 'bar' });
    expect(noteOf(ex, 'CUT_THROUGH_TEXT')).toMatchObject({ level: 'info', itemId: hello.id, cutId: 'c1', letter: 'A', pieces: [1, 2] });
    // nothing is lost: the pieces plus what their holes took out of the solid make the whole (each half-hole
    // starts 1 mm out in the other half, so it is measured against its own half)
    const solid = own(solidOfStl(whole.stl));
    const halves = [-200, 200].map((x) => own(solid.intersect(cube([400, 400, 400], [x, 0, 0]))));
    const holes = holesOf(ex).reduce((s, x) => s + overlap(x.m, halves[x.side]), 0);
    expect(holes).toBeCloseTo(4 * 372.679, 1);
    const pieces = piecesOf(ex).reduce((s, f) => s + volumeOfStl(f.stl), 0);
    expect(pieces + holes).toBeCloseTo(solid.volume(), 0);
  });

  it('a cut through letters in both rows of a grid names both pairs of pieces they are split between', async () => {
    // three upright bars, the middle one on cut A, all three across cut B: each cut splits letters in two columns
    await load(cube([300, 100, 4], [0, 0, 2]), 'sign');
    const bars = createItem({ text: 'III', fontId: 'inter', size: 40, depth: 3, position: [0, 0, 4], normal: [0, 0, 1] });
    const ex = await exportSplit(S({ cuts: [cutAt(0, 0, 'c1'), cutAt(1, 0, 'c2')], joint: 'none', labels: false }), { items: [bars], name: 'sign' });
    const notes = ex.notes.filter((n) => n.code === 'CUT_THROUGH_TEXT');
    expect(notes.map((n) => [n.letter, n.pairs, n.pieces])).toEqual([['A', [[1, 2], [3, 4]], [1, 2, 3, 4]], ['B', [[1, 3], [2, 4]], [1, 2, 3, 4]]]);
    expect(notes[0].text).toBe('Cut A runs through “III” – its letters are split where piece 1 meets piece 2 and piece 3 meets piece 4.');
  });

  it('a text-only sign splits by cell, at the word gap', async () => {
    await client.loadBase({ kind: 'none', version: ++version });
    const sign = createItem({ text: 'HELLO WORLD', fontId: 'inter', size: 20 });
    const bed = [90, 90, 99]; // a 100 mm printer
    const p = await client.planSplit([sign], version, { printing, split: SPLIT_DEFAULTS, bed, mode: 'fit' });
    expect(p.cuts).toHaveLength(1);
    const split = { ...SPLIT_DEFAULTS, cuts: [{ id: 'c1', ...p.cuts[0] }] };
    const m = await client.planSplit([sign], version, { printing, split, bed, mode: 'measure' });
    expect(m.cuts[0].area).toBe(0); // between the letters
    const ex = await exportSplit(split, { items: [sign], name: 'sign', bed });
    expect(piecesOf(ex)).toHaveLength(2); // the letters are grouped by cell, not one file each
    expect(ex.pieces[0].shells).toBeGreaterThan(1);
    expect(ex.pieces.every((x) => x.fits)).toBe(true);
    expect(codes(ex)).not.toContain('CUT_THROUGH_TEXT');
  });

  it('unrepaired triangles go with their piece; an unrepairable model cannot be split', async () => {
    const box = cube([120, 40, 30]);
    await load(box);
    const clean = await exportSplit(S({ diameter: 5, labels: false }));
    await loadSoup(withTriangle(box, [-5, 30, 0, 5, 30, 0, 1, 35, 0]), 'box');
    const ex = await exportSplit(S({ diameter: 5, labels: false }));
    expect(noteOf(ex, 'SPLIT_UNREPAIRED')).toMatchObject({ level: 'warn', count: 1 });
    // the loose triangle crosses the cut: clipped in three, one side's part with each piece
    expect(ex.pieces.map((p) => p.unrepaired)).toEqual([1, 2]);
    expect(piecesOf(ex).map((f) => f.triangles)).toEqual(piecesOf(clean).map((f, k) => f.triangles + [1, 2][k]));
    const r = await resultSplit(S({ diameter: 5, labels: false }));
    expect(r.display.passthroughRanges.reduce((n, [, c]) => n + c, 0)).toBe(3);

    // a cut beyond the solid that crosses only a loose triangle cuts nothing: the model goes out whole
    await loadSoup(withTriangle(box, [100, 0, 0, 101, 0, 0, 100, 1, 0]), 'box');
    const beyond = await exportSplit(S({ cuts: [cutAt(0, 80)], labels: false }));
    expect(noteOf(beyond, 'CUT_MISSES')).toMatchObject({ letter: 'A' });
    expect(beyond.stl).toBeInstanceOf(ArrayBuffer);
    expect(beyond.files).toBeUndefined();
    const measured = await client.planSplit([], version, { printing, split: S({ cuts: [cutAt(0, 80)] }), bed: BED, mode: 'measure' });
    expect(measured.cuts[0].joint).toBe('miss');
    // and Fit to my printer never plans a cut in the gap between them
    await loadSoup(withTriangle(cube([300, 40, 20]), [250, 0, 0, 251, 0, 0, 250, 1, 0]), 'bar');
    const p = await client.planSplit([], version, { printing, split: SPLIT_DEFAULTS, bed: BED, mode: 'fit' });
    expect(p.cuts).toHaveLength(1);
    expect(Math.abs(p.cuts[0].position[0])).toBeLessThan(150);

    await loadSoup(new Float32Array([0, 0, 0, 30, 0, 0, 0, 30, 0]), 'open');
    const one = await exportSplit(S({ cuts: [cutAt(0, 10)] }), { name: 'open' });
    expect(codes(one)).toEqual(['SPLIT_UNAVAILABLE']);
    expect(one.stl).toBeInstanceOf(ArrayBuffer);
    expect(new DataView(one.stl).getUint32(80, true)).toBe(1);
    expect(codes(await client.planSplit([], version, { printing, split: S(), bed: BED, mode: 'fit' }))).toEqual(['SPLIT_UNAVAILABLE']);
  });

  it('a part printed on its own goes in the download as it is, with a note when it spans a cut', async () => {
    await load(cube([120, 40, 30]));
    const part = createPart('bar', 'bar', { position: [4, 0, 15], normal: [0, 0, 1], join: 'pegs', pegCount: 2, pegDiameter: 2, pegLength: 3 });
    const ex = await exportSplit(S({ labels: false }), { items: [part] });
    expect(noteOf(ex, 'PART_SPANS_CUT')).toMatchObject({ itemId: part.id, letter: 'A' });
    const file = ex.files.find((f) => f.kind === 'part');
    expect(file).toMatchObject({ name: 'box-part-1-bar', id: part.id });
    expect(boxOf(pieceSolid(file)).min[2]).toBeCloseTo(0, 4);
    const r = await resultSplit(S({ labels: false }), { items: [part] });
    expect(r.display.parts.at(-1)).toEqual({ kind: 'part', id: part.id, cell: [1, 0, 0] });
    expect(codes(ex)).not.toContain('PART_TOO_BIG');
    // on a printer too small for it the part, which is never cut, is told of
    const small = await exportSplit(S({ labels: false }), { items: [part], bed: [15, 15, 50] });
    expect(noteOf(small, 'PART_TOO_BIG')).toMatchObject({ level: 'warn', itemId: part.id, name: 'bar' });
    expect(small.files.find((f) => f.kind === 'part').fits).toBe(false);
  });

  it('pins go in as many files as the bed needs, each fitting lying as it is laid out', async () => {
    await load(cube([120, 40, 30]));
    // three Ø5 × 16 pins (one spare) on a bed with room for two side by side and one row
    const ex = await exportSplit(S({ diameter: 5, depth: 8, count: 2, labels: false }), { bed: [40, 12, 100] });
    const pins = ex.files.filter((f) => f.kind === 'pins');
    expect(pins.map((f) => [f.name, f.count, f.fits])).toEqual([['box-pins-2x-5x16mm-1-of-2', 2, true], ['box-pins-1x-5x16mm-2-of-2', 1, true]]);
    expect(codes(ex)).not.toContain('PART_TOO_BIG');
    // with room for one row of many, one file as before
    expect(ex.files.filter((f) => f.kind === 'pins')).toHaveLength(2);
    const roomy = await exportSplit(S({ diameter: 5, depth: 8, count: 2, labels: false }));
    expect(roomy.files.filter((f) => f.kind === 'pins').map((f) => [f.name, f.count])).toEqual([['box-pins-3x-5x16mm', 3]]);
  });
});

describe('planning pieces that really print', () => {
  const plan = (items = [], bed = BED, split = SPLIT_DEFAULTS) => client.planSplit(items, version, { printing, split, bed, mode: 'fit' });
  const planned = (p, patch = {}) => ({ ...SPLIT_DEFAULTS, ...patch, cuts: p.cuts.map((c, i) => ({ id: `c${i + 1}`, ...c })) });
  const L = (t, arm) => own(wasm.Manifold.union([cube([arm, 40, t], [arm / 2, 20, t / 2]), cube([t, 40, arm], [t / 2, 20, arm / 2])]));

  it('an L bracket is cut across both arms into three pieces, and a thin one gets tabs on both', async () => {
    // cutting it lengthwise makes four boxes of four pieces; across both arms, one box is empty
    await load(L(12, 260), 'bracket');
    let p = await plan();
    expect(p.counts).toEqual([1, 0, 1]);
    expect(p.pieces).toHaveLength(3);
    let r = await resultSplit(planned(p, { labels: false }));
    expect(r.pieces.map((x) => [x.down, x.fits])).toEqual([['-z', true], ['-z', true], ['-x', true]]);
    // 6 mm arms: each cut runs through its own plate, so each gets its tabs
    await load(L(6, 300), 'shelf');
    p = await plan();
    expect(p.counts).toEqual([1, 0, 1]);
    r = await resultSplit(planned(p));
    expect(r.seams.map((x) => [x.letter, x.joint, x.tabs])).toEqual([['A', 'dovetail', 1], ['B', 'dovetail', 1]]);
    expect(r.notes.filter((n) => n.level === 'warn')).toEqual([]);
  });

  it('a square plate twice the bed is tiled flat in its own plane, never cut into layers', async () => {
    await load(cube([400, 400, 4]), 'plaque');
    const p = await plan();
    expect(p.counts).toEqual([2, 2, 0]);
    const r = await resultSplit(planned(p));
    expect(r.pieces).toHaveLength(9);
    expect(r.pieces.every((x) => x.down === '-z' && x.fits)).toBe(true);
    expect(new Set(r.seams.map((x) => x.joint))).toEqual(new Set(['dovetail']));
    expect(r.notes.filter((n) => n.level === 'warn')).toEqual([]);
  });

  it('a long rail takes as many cuts along it as it needs', async () => {
    await load(cube([2400, 40, 20]), 'rail');
    const p = await plan();
    expect(p.counts).toEqual([8, 0, 0]);
    expect(p.pieces).toHaveLength(9);
    expect(p.pieces.every((x) => x.fits)).toBe(true);
  });

  it('a ball is cut so that every piece lies on a cut face, never standing on its pole', async () => {
    await load(own(wasm.Manifold.sphere(60, 48)), 'ball');
    const bed = [105, 105, 124];
    const p = await plan([], bed);
    expect(p.counts).toEqual([1, 1, 1]);
    // quarters cut by hand fit only standing on the pole: said so
    const r = await resultSplit(S({ cuts: [cutAt(0, 0, 'c1'), cutAt(1, 0, 'c2')], joint: 'none', labels: false }), { bed });
    expect(r.pieces.map((x) => [x.lies, x.fits])).toEqual(Array(4).fill(['on a curve', true]));
    expect(r.notes.filter((n) => n.code === 'PIECE_UNSTABLE').map((n) => n.pieceIndex)).toEqual([1, 2, 3, 4]);
  });

  it('a piece rests on a side of the model only where it could lie on the bed: a ball\'s tip is no flat end', () => {
    // the facets round this sphere's tips lean 1–2°: their centres are within 0.1 mm of the end, their outer corners are not
    const ball = own(wasm.Manifold.sphere(120, 128));
    const half = own(ball.trimByPlane([0, 1, 0], 0));
    const { vertProperties, numProp, triVerts } = half.getMesh();
    const stats = orientationStats(vertProperties, numProp, triVerts, [{ axis: 1, at: 0 }]);
    expect(['+x', '-x', '+z', '-z'].map((d) => stats.dirs[d].bed)).toEqual([0, 0, 0, 0]);
    expect(cellSupport(ball.getMesh(), [[], [0], []]).get('0,1,0').rests).toEqual([false, false, false]);
  });

  it('a hollow ball or bowl is cut through its middle into even pieces, not lopsided ones round a sliver', async () => {
    // on a round shell every slice has the same area and the ring shrinks towards the ends; near an end the ring is
    // wide too, but a hole square to it breaks out of the slanted wall
    const shell = (R, wall) => own(own(wasm.Manifold.sphere(R, 64)).subtract(own(wasm.Manifold.sphere(R - wall, 64))));
    // a helmet: an egg-shaped shell open at the neck, with a visor cut out of its front. Every slice through the visor
    // has two islands, the crown and the chin bar, but neither takes pins: no reason to cut lopsided beside the opening
    const egg = (r) => own(own(wasm.Manifold.sphere(1, 64)).scale(r));
    const helmet = own(own(egg([120, 140, 150]).subtract(egg([116, 136, 146]))).subtract(cube([600, 600, 240], [0, 0, -180])).subtract(cube([150, 240, 55], [0, -180, 17.5])));
    for (const [name, solid, counts] of [
      ['globe', shell(115, 3), [1, 1, 1]],
      ['thick globe', shell(130, 8), [1, 1, 1]],
      ['bowl', own(shell(130, 6).subtract(cube([400, 400, 200], [0, 0, 100]))), [1, 1, 0]],
      ['helmet', helmet, [1, 1, 0]],
    ]) {
      await load(solid, name);
      const p = await plan();
      expect(p.counts, name).toEqual(counts);
      for (const c of p.cuts) expect(Math.abs(c.position[c.normal.indexOf(1)]), name).toBeLessThan(0.5);
      expect(p.pieces.every((x) => x.fits), name).toBe(true);
    }
  });

  it('a U bracket is cut across its legs into two pieces that stand, held by pins, on a small bed or a big one', async () => {
    // laid flat on one leg for dovetails, the other leg would print as a roof 142 mm over the bed; halved along y on a
    // 256 mm printer, each half would lie on one leg with the other over it
    const U = own(wasm.Manifold.union([cube([150, 50, 8], [75, 25, 4]), cube([8, 50, 300], [4, 25, 150]), cube([8, 50, 300], [146, 25, 150])]));
    await load(U, 'bracket');
    for (const bed of [BED, [246, 246, 255]]) {
      const p = await plan([], bed);
      expect(p.counts, `${bed}`).toEqual([0, 0, 1]);
      const r = await resultSplit(planned(p, { labels: false }), { bed });
      expect(r.seams.map((x) => [x.joint, x.dowels.length]), `${bed}`).toEqual([['dowels', 4]]);
      expect(r.pieces.map((x) => [x.down, x.fits]), `${bed}`).toEqual([['-z', true], ['-z', true]]);
    }
  });

  it('a table is cut through its legs, not just inside its apron, which would leave slivers of it as pieces of their own', async () => {
    // 600 × 350 × 300: a 20 mm top, 35 mm legs, a 60 × 15 mm apron under the top. Cut 3.5 mm inside the apron, the
    // boxes between the legs each held a 3.5 mm sliver of it: twelve pieces, two of them glued flat with no pins
    const table = (stretcher) => {
      const parts = [cube([600, 350, 20], [300, 175, 290])];
      for (const x of [37.5, 562.5]) for (const y of [37.5, 312.5]) parts.push(cube([35, 35, 280], [x, y, 140]));
      parts.push(cube([490, 15, 60], [300, 27.5, 250]), cube([490, 15, 60], [300, 322.5, 250]), cube([15, 240, 60], [27.5, 175, 250]), cube([15, 240, 60], [572.5, 175, 250]));
      // an H stretcher 50–70 mm up: cut through it, its rail left a strip held loose over the rest of a piece
      if (stretcher) parts.push(cube([520, 20, 20], [300, 175, 60]), cube([25, 242, 20], [37.5, 175, 60]), cube([25, 242, 20], [562.5, 175, 60]));
      return own(wasm.Manifold.union(parts));
    };
    for (const [name, count] of [['coffee table', 10], ['stretcher table', 11]]) {
      await load(table(name === 'stretcher table'), name);
      const p = await plan();
      expect(p.counts, name).toEqual([2, 1, 1]);
      expect(p.pieces, name).toHaveLength(count);
      const z = p.cuts.find((c) => c.normal[2] === 1).position[2];
      expect(z, name).toBeLessThan(220);
      const ex = await exportSplit(planned(p, { labels: false }), { name });
      expect(ex.pieces, name).toHaveLength(count);
      expect(ex.notes.filter((n) => n.level === 'warn'), name).toEqual([]);
      expect(ex.seams.every((s) => s.dowels.length > 0), name).toBe(true);
      for (const f of piecesOf(ex)) for (const shell of pieceSolid(f).decompose().map(own)) expect(shell.boundingBox().min[2], f.name).toBeCloseTo(0, 3);
    }
  });

  it('a gear with a hub is cut into quarters that all lie flat, none stood on its cut edge with its teeth over supports', async () => {
    // a 10 mm gear Ø300 with five lightening holes and a hub 40 mm tall: on its cut edge a quarter would put one mating
    // face down, but stand 138 mm tall and need ten times the support
    const { CrossSection } = wasm;
    const teeth = [];
    for (let i = 0; i < 40; i++) {
      const a = (2 * Math.PI * i) / 40;
      teeth.push([[138, -6], [150, -3], [150, 3], [138, 6]].map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]));
    }
    const rim = own(new CrossSection(teeth, 'NonZero'));
    const disc = own(rim.add(own(CrossSection.circle(140, 180))));
    let gear = own(wasm.Manifold.extrude(disc, 10));
    const bore = (r, at, h) => own(own(wasm.Manifold.cylinder(h + 2, r, r, 64)).translate([at[0], at[1], -1]));
    for (let i = 0; i < 5; i++) gear = own(gear.subtract(bore(25, [80 * Math.cos((2 * i + 1) * Math.PI / 5), 80 * Math.sin((2 * i + 1) * Math.PI / 5)], 10)));
    const hub = own(own(wasm.Manifold.cylinder(40, 30, 30, 64)).subtract(bore(10, [0, 0], 40)));
    await load(own(own(gear.add(hub)).subtract(bore(10, [0, 0], 40))), 'gear');
    const p = await plan();
    expect(p.counts).toEqual([1, 1, 0]);
    const r = await resultSplit(planned(p, { labels: false }));
    expect(r.pieces.map((x) => [x.down, x.lies, x.fits])).toEqual(Array(4).fill(['-z', 'flat as modelled', true]));
    expect(r.pieces.every((x) => x.size[2] === 40)).toBe(true);
  });

  it('a tile with a tower on it is cut into pieces that lie flat, never stood on a cut edge as a 4 mm wall', async () => {
    // stood on a cut edge, a quarter rested on the cut through its tower too, so it looked as steady as a block and
    // the cut face went down: a 4 mm wall 150 mm tall. On a printer where its quarters fit only on their edges the
    // tile is planned lying flat first, as a slab is
    const post = (r, h, at) => own(own(wasm.Manifold.cylinder(h + 1, r, r, 48)).translate([at[0], at[1], at[2] - 1]));
    const tile = (side, t, r, h, at) => own(wasm.Manifold.union([cube([side, side, t], [side / 2, side / 2, t / 2]), post(r, h, [...at, t])]));
    // a terrain tile: ruined walls, a tower and two rocks
    const rock = (r, at) => own(own(own(wasm.Manifold.sphere(r, 32)).translate([...at, 4])).intersect(cube([2 * r + 2, 2 * r + 2, r + 1], [at[0], at[1], 4 + (r + 1) / 2])));
    const terrain = own(wasm.Manifold.union([
      cube([300, 300, 4], [150, 150, 2]), cube([80, 20, 66], [70, 40, 37]), cube([20, 90, 51], [40, 75, 29.5]), post(25, 90, [220, 80, 4]), rock(20, [150, 220]), rock(28, [80, 230]),
    ]));
    for (const [name, model, bed] of [
      ['terrain', terrain, BED],
      ['tower in the middle', tile(300, 4, 25, 90, [150, 150]), BED],
      ['tower off centre', tile(300, 4, 25, 90, [220, 80]), BED],
      ['tower off centre on a 240 × 200 bed', tile(300, 4, 25, 90, [220, 80]), [240, 200, 219]],
      ['figure on a base', tile(320, 6, 18, 200, [160, 160]), BED],
    ]) {
      await load(model, 'tile');
      const p = await plan([], bed);
      const r = await resultSplit(planned(p, { labels: false }), { bed });
      expect(r.pieces.map((x) => [x.down, x.fits]), name).toEqual(r.pieces.map(() => ['-z', true]));
    }
  });

  it('offers the pieces Fit makes: a cone\'s cuts leave its tip boxes empty, though its long sides span them', async () => {
    const cone = own(wasm.Manifold.cylinder(320, 120, 0, 24));
    await load(cone, 'cone');
    const p = await plan();
    const ex = await exportSplit(planned(p, { labels: false }), { name: 'cone' });
    expect(p.pieces).toHaveLength(piecesOf(ex).length);
    // Fit cut the model as it planned it: the pieces view that follows cuts nothing again
    stages.length = 0;
    await plan();
    await resultSplit(planned(p, { labels: false }));
    expect(stages.some((s) => /Cutting/.test(s))).toBe(false);
  });

  it('only a piece whose material meets a dovetail cut is held flat by it: the top of a T\'s stem lies on its side', async () => {
    // the arm's cut is a dovetail 3.5 mm from the stem, closer than its tab reaches; the stem's top never meets it
    const T = (stem) => own(wasm.Manifold.union([cube([300, 40, 8], [0, 20, 4]), cube([8, 40, stem], [0, 20, stem / 2])]));
    await load(T(260), 'T');
    const p = await plan();
    expect(p.cuts.map((c) => [c.normal.indexOf(1), c.position[c.normal.indexOf(1)]])).toEqual([[0, -7.5], [2, 130]]);
    // planned without the tab's length, as the cut makes it
    expect(p.pieces[2].size).toEqual([157.5, 40, 130]);
    const r = await resultSplit(planned(p, { labels: false }));
    expect(r.seams.map((x) => [x.letter, x.pieces, x.joint])).toEqual([['A', [1, 2], 'dovetail'], ['B', [2, 3], 'dowels']]);
    expect(r.pieces[2]).toMatchObject({ lies: 'on its side', fits: true });
    // cut by hand, a 250 mm stem top fits lying across the bed's diagonal: it is not stood on its end, too tall to print
    await load(T(400), 'T');
    const tall = await resultSplit(S({ cuts: [cutAt(0, -7.5, 'c1'), cutAt(2, 150, 'c2')], labels: false }));
    expect(tall.pieces[2]).toMatchObject({ lies: 'on its side', fits: true });
    expect(codes(tall)).not.toContain('PIECE_TOO_BIG');
  });

  it('a file holds only what rests on the bed: the shelves a bookcase\'s middle box holds loose are pieces of their own', async () => {
    // on the default printer the middle box can only lie as modelled: its bottom shelf rests on the bed, and the other
    // two would be held 110 and 225 mm over it. They are pieces of their own, numbered, labelled and glued as such
    const board = (z) => cube([600, 200, 15], [300, 100, z + 7.5]);
    const bookcase = own(wasm.Manifold.union([board(0), board(110), board(225), cube([15, 200, 240], [7.5, 100, 120]), cube([15, 200, 240], [592.5, 100, 120])]));
    await load(bookcase, 'bookcase');
    const p = await plan();
    expect(p.counts).toEqual([2, 0, 0]);
    // the offer counts the shelves that print apart: as many pieces as the download holds
    expect(p.pieces).toHaveLength(4);
    const ex = await exportSplit(planned(p), { name: 'bookcase' });
    const files = piecesOf(ex);
    expect(files).toHaveLength(4);
    // and so does the measure of cuts moved by hand, for the download button before the pieces are worked out
    const moved = planned(p);
    moved.cuts[0] = cutAt(0, 202, moved.cuts[0].id);
    const m = await client.planSplit([], version, { printing, split: moved, bed: BED, mode: 'measure' });
    expect(m.pieces.map((x) => x.cell[0])).toEqual([0, 1, 1, 2]);
    expect(ex.pieces.map((x) => [x.cell[0], x.shells, x.fits])).toEqual([[0, 1, true], [1, 1, true], [1, 2, true], [2, 1, true]]);
    for (const f of files) {
      // every shell of every file starts on the bed (a sealed hollow would come back inside out, with no volume of its own)
      for (const shell of pieceSolid(f).decompose().map(own)) expect(shell.boundingBox().min[2], f.name).toBeCloseTo(0, 3);
    }
    // put back where they were, the pieces make the model: nothing lost, nothing twice
    const parts = files.map(assembled);
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) expect(overlap(parts[i], parts[j])).toBeLessThan(1e-3);
    const glued = piecesOf(await exportSplit(planned(p, { joint: 'none', labels: false }), { name: 'bookcase' })).map(assembled);
    expect(glued.reduce((v, m) => v + m.volume(), 0)).toBeCloseTo(bookcase.volume(), 0);
    // each loose shelf is joined to the ends with its own pins and labels, and the glue sheet and the view count it
    const seams = ex.seams.map((s) => [s.letter, s.pieces, s.labels, s.dowels.length > 0]);
    expect(seams.map(([letter, pieces]) => [letter, pieces])).toEqual([['A', [1, 2]], ['A', [1, 3]], ['B', [2, 4]], ['B', [3, 4]]]);
    for (const [letter, pieces, labels, pinned] of seams) {
      expect(pinned).toBe(true);
      expect(labels).toEqual(pieces.map((k) => `${k}${letter}`));
    }
    const sheet = ex.files.find((f) => f.kind === 'text').text;
    expect(sheet).toContain('bookcase – 4 pieces');
    expect(sheet).toMatch(/piece 3 of 4 .*lies on a cut face.*2 parts/);
    expect(ex.assembly).toEqual([expect.stringMatching(/^Cut A: .* push pieces 2 and 3 on together/), expect.stringMatching(/^Cut B: .* push piece 4 on/)]);
    const r = await resultSplit(planned(p));
    expect([...new Set(r.display.parts.filter((x) => x.kind === 'piece').map((x) => x.index))]).toEqual([1, 2, 3, 4]);
    expect(r.pieces.map((x) => x.index)).toEqual([1, 2, 3, 4]);
    // letters on the top board across cut A are split with the boards over the bottom one: piece 3, not 2
    const books = createItem({ text: 'BOOKS', fontId: 'inter', size: 40, depth: 3, position: [200, 100, 240], normal: [0, 0, 1] });
    const lettered = await exportSplit(planned(p, { labels: false }), { items: [books], name: 'bookcase' });
    expect(noteOf(lettered, 'CUT_THROUGH_TEXT')).toMatchObject({ letter: 'A', pieces: [1, 3] });
    const above = (f) => {
      const top = own(assembled(f).intersect(cube([700, 300, 10], [300, 100, 245])));
      return top.volume();
    };
    expect(piecesOf(lettered).map((f) => above(f) > 100)).toEqual([true, false, true, false]);
  });

  it('a box with its lid laid beside it is cut through the gap: four pieces, the lid in two', async () => {
    const body = own(cube([300, 200, 150], [150, 100, 75]).subtract(cube([294, 194, 150], [150, 100, 78])));
    const lid = own(own(cube([300, 200, 3], [150, 320, 1.5]).add(cube([293.2, 193.2, 8], [150, 320, 7]))).subtract(cube([287.2, 187.2, 10], [150, 320, 7])));
    await load(own(body.add(lid)), 'box');
    const p = await plan();
    expect(p.counts).toEqual([1, 1, 0]);
    expect(p.pieces).toHaveLength(4);
    const y = p.cuts.find((c) => c.normal[1] === 1).position[1];
    expect(y).toBeGreaterThan(200);
    expect(y).toBeLessThan(220);
  });

  it('Fit to my printer works its plan out once: asked again, the same plan comes back at once', async () => {
    await load(cube([400, 40, 20]), 'bar');
    const first = await plan();
    stages.length = 0;
    expect(await plan()).toEqual(first);
    expect(stages).not.toContain('Planning cuts…');
    // the settings Fit does not read leave it be; a bed it was not planned for is planned for
    expect(await plan([], BED, { ...SPLIT_DEFAULTS, labels: false, orient: 'cut' })).toEqual(first);
    expect(stages).not.toContain('Planning cuts…');
    await plan([], [180, 180, 180]);
    expect(stages).toContain('Planning cuts…');
  });

  it('a plaque too thick for a plate is still cut into pieces that lie flat, between the words', async () => {
    // 12 mm: no dovetails, but stood on its edge a piece would be a 200 mm wall with its words upright
    await load(cube([300, 200, 12], [0, 0, 6]), 'plaque');
    const words = [
      createItem({ text: 'IN MEMORY', fontId: 'inter', size: 30, mode: 'engrave', depth: 2, position: [0, 30, 12], normal: [0, 0, 1] }),
      createItem({ text: '1932 - 2024', fontId: 'inter', size: 22, mode: 'engrave', depth: 2, position: [0, -30, 12], normal: [0, 0, 1] }),
    ];
    const p = await plan(words);
    expect(p.counts).toEqual([1, 0, 0]);
    const r = await resultSplit(planned(p, { labels: false }), { items: words });
    expect(r.pieces.map((x) => [x.down, x.fits])).toEqual([['-z', true], ['-z', true]]);
    expect(codes(r)).not.toContain('CUT_THROUGH_TEXT');
    // counted the same way from the box alone
    expect(fitPieces([300, 200, 12], BED, SPLIT_DEFAULTS).pieces).toBe(2);
    expect(fitPieces([400, 300, 18], BED, SPLIT_DEFAULTS).pieces).toBe(4);
  });

  it('pieces of a hollow column stand on their cut faces, not on their sides with the inside of the tube to support', async () => {
    // an 80 mm square tube with 4 mm walls and a 60 mm one with 3 mm walls: they stand on a thin ring, but on its whole outline
    for (const [side, wall] of [[80, 4], [60, 3]]) {
      await load(own(cube([side, side, 600], [0, 0, 300]).subtract(cube([side - 2 * wall, side - 2 * wall, 600], [0, 0, 300 + wall]))), 'column');
      const r = await resultSplit(S({ cuts: [cutAt(2, 200, 'c1'), cutAt(2, 400, 'c2')], labels: false }));
      // the bottom piece stands on the tube's floor
      expect(r.pieces.map((x) => [x.lies, x.down[1], x.fits]), `${side} mm`).toEqual([['flat as modelled', 'z', true], ...Array(2).fill(['on a cut face', 'z', true])]);
    }
  });

  it('a thin plate cut by hand lies flat whatever its joint, and says when it is then too big', async () => {
    for (const [t, joint] of [[1.6, 'auto'], [4, 'dowels'], [4, 'none']]) {
      await load(cube([400, 100, t]), 'plate');
      const r = await resultSplit(S({ cuts: [cutAt(0, -60)], joint, labels: false }));
      expect(r.pieces.map((x) => [x.down, x.fits])).toEqual([['-z', true], ['-z', false]]);
      expect(noteOf(r, 'PIECE_TOO_BIG')).toMatchObject({ pieceIndex: 2 });
    }
  });

  it('a model that fits only stood on its side says how it must lie', async () => {
    await load(cube([240, 100, 200]), 'box');
    const p = await plan();
    expect(p.cuts).toEqual([]);
    expect(noteOf(p, 'SPLIT_NOT_NEEDED')).toMatchObject({ down: '-x', yaw: 0 });
    expect(noteOf(p, 'SPLIT_NOT_NEEDED').text).toMatch(/lying on its −X side.*turn it that way in your slicer/);
  });

  it('unrepaired triangles past the solid’s end are planned for, and a piece’s file is as long as it says', async () => {
    // an open flap 25 mm past the end of a 400 mm bar goes in the end piece's file
    const flap = [200, -20, 10, 225, -20, 10, 225, 20, 10, 200, -20, 10, 225, 20, 10, 200, 20, 10];
    const soup = soupOf(cube([400, 40, 20]));
    const both = new Float32Array(soup.length + flap.length);
    both.set(soup);
    both.set(flap, soup.length);
    await loadSoup(both, 'flap');
    const p = await plan();
    const ex = await exportSplit(planned(p, { labels: false }), { name: 'flap' });
    expect(codes(ex)).toContain('SPLIT_UNREPAIRED');
    expect(codes(ex)).not.toContain('PIECE_TOO_BIG');
    for (const f of piecesOf(ex)) {
      // the file as it is saved, turned the way it prints, lies within the bed, flap and all
      const pts = parseSTL(f.stl).attributes.position.array;
      const side = (a) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = a; i < pts.length; i += 3) {
          lo = Math.min(lo, pts[i]);
          hi = Math.max(hi, pts[i]);
        }
        return hi - lo;
      };
      expect(f.fits).toBe(true);
      expect(side(0)).toBeLessThanOrEqual(BED[0] + 1e-3);
      expect(side(1)).toBeLessThanOrEqual(BED[1] + 1e-3);
    }
  });

  it('on a long sign the cuts keep 2 mm clear of the raised letters', async () => {
    await load(cube([620, 120, 4]), 'sign');
    const words = createItem({ text: 'WELCOME TO OUR LITTLE HOUSE', fontId: 'inter', size: 36, position: [0, 0, 2], normal: [0, 0, 1] });
    const p = await plan([words]);
    expect(p.cuts.length).toBeGreaterThan(1);
    // a plane 1.9 mm either side of each cut runs through no letter
    const beside = p.cuts.flatMap((c, i) => [-1.9, 1.9].map((d) => cutAt(0, c.position[0] + d, `c${i}${d > 0 ? 'b' : 'a'}`)));
    const m = await client.planSplit([words], version, { printing, split: S({ cuts: beside }), bed: BED, mode: 'measure' });
    expect(m.cuts.map((c) => c.crosses)).toEqual(beside.map(() => []));
  });
});

describe('the engine around a split', () => {
  it('the split is cached, released with the model, and a bed change that keeps orientations re-runs no boolean', async () => {
    await load(cube([120, 40, 30]));
    const split = S({ diameter: 5, labels: false });
    const since = (from, re) => stages.slice(from).some((s) => re.test(s));
    await exportSplit(split);
    let from = stages.length;
    await exportSplit(split);
    expect(since(from, /Finding room|Cutting|Drilling/)).toBe(false);
    expect((await client.call('ping', {})).caches.split).toBe(1);
    // the result view shares the work: only the view is built
    from = stages.length;
    await resultSplit(split);
    expect(since(from, /Finding room|Cutting|Drilling/)).toBe(false);
    from = stages.length;
    await exportSplit(split, { bed: [230, 230, 249] });
    expect(since(from, /Drilling/)).toBe(false);
    // a bed too low for the pieces to stand on their cut faces lays them down: drilled again, never cut again
    from = stages.length;
    const low = await exportSplit(split, { bed: [210, 210, 50] });
    expect(since(from, /Drilling/)).toBe(true);
    expect(since(from, /Cutting/)).toBe(false);
    expect(low.pieces.map((p) => [p.lies, p.up])).toEqual([['flat as modelled', '+z'], ['flat as modelled', '+z']]);
    // the cuts removed: the model is shown whole and the pieces are let go
    await resultSplit({ ...split, cuts: [] });
    expect((await client.call('ping', {})).caches.split).toBe(0);
    await exportSplit(split);
    expect((await client.call('ping', {})).caches.split).toBe(1);
    await client.loadBase({ kind: 'sample', version: ++version });
    expect((await client.call('ping', {})).caches.split).toBe(0);
  });

  it('measuring the cuts while the text is edited builds no booleans, and follows the text', async () => {
    await load(cube([300, 40, 20]), 'bar');
    const split = S({ cuts: [cutAt(0, 0, 'c1'), cutAt(0, 100, 'c2')], labels: false });
    // the booleans that merge text into the model are the static union and difference
    const counted = { union: 0, difference: 0 };
    const wrapped = Object.keys(counted).map((key) => {
      const fn = wasm.Manifold[key];
      wasm.Manifold[key] = (...args) => {
        counted[key]++;
        return fn(...args);
      };
      return () => {
        wasm.Manifold[key] = fn;
      };
    });
    try {
      const measure = (items) => client.planSplit(items, version, { printing, split, bed: BED, mode: 'measure' });
      const hello = createItem({ text: 'HELLO', fontId: 'inter', size: 12, position: [0, 0, 10], normal: [0, 0, 1] });
      let m = await measure([hello]);
      expect(m.estimate).toBe(true);
      expect(m.cuts.map((c) => [c.letter, c.joint, c.crosses])).toEqual([['A', 'dowels', [hello.id]], ['B', 'dowels', []]]);
      expect(m.cuts[0].area).toBeCloseTo(800, 6); // the model's face alone
      expect(m.bounds.max[2]).toBeGreaterThan(10.5); // the raised letters stand on the bar's top at z = 10
      // the text moved over the second cut: the measure follows it, still without a boolean
      const moved = { ...hello, position: [100, 0, 10] };
      m = await measure([moved]);
      expect(m.cuts.map((c) => c.crosses)).toEqual([[], [hello.id]]);
      expect(counted).toEqual({ union: 0, difference: 0 });
      // once the final result is built for that text, the measure is taken from it; one turned copy of the model at a time
      expect((await client.call('ping', {})).caches.frame).toBe(1);
      await resultSplit(split, { items: [moved] });
      m = await measure([moved]);
      expect(m.estimate).toBeUndefined();
      expect(m.cuts[1].crosses).toEqual([hello.id]);
      expect((await client.call('ping', {})).caches.frame).toBe(1);
    } finally {
      wrapped.forEach((restore) => restore());
    }
  });

  it('a cut measured while the text is edited and then removed leaves no copy of the model behind', async () => {
    await load(cube([300, 40, 20]), 'bar');
    const hello = createItem({ text: 'HELLO', fontId: 'inter', size: 12, position: [0, 0, 10], normal: [0, 0, 1] });
    // the measure turns the whole model into the cut's frame: watch that copy, and whether it is alive at the booleans
    const copies = [];
    const proto = Object.getPrototypeOf(cube(1));
    const { transform } = proto;
    proto.transform = function (m) {
      const out = transform.call(this, m);
      if (m.every((v, i) => v === TO_PLANE[0][i]) && this.numTri() === 12) copies.push(out);
      return out;
    };
    const held = [];
    const { union } = wasm.Manifold;
    wasm.Manifold.union = (...args) => {
      held.push(copies.some((c) => !c.isDeleted()));
      return union(...args);
    };
    try {
      const m = await client.planSplit([hello], version, { printing, split: S({ cuts: [cutAt(0, 50)] }), bed: BED, mode: 'measure' });
      expect(m.estimate).toBe(true);
      expect((await client.call('ping', {})).caches.frame).toBe(1);
      // the cut is removed: the app asks for the whole model
      await client.result([hello], version, { printing });
      expect(held.length).toBeGreaterThan(0);
      expect(held.some(Boolean)).toBe(false);
      expect((await client.call('ping', {})).caches.frame).toBe(0);
      await client.export([hello], version, 'bar', { printing });
      expect((await client.call('ping', {})).caches.frame).toBe(0);
    } finally {
      proto.transform = transform;
      wasm.Manifold.union = union;
    }
  });

  it('splitting again and again leaves no solids behind', async () => {
    await load(cube([120, 40, 30]));
    const sign = own(wasm.Manifold.union([cube([300, 80, 5], [0, 0, 2.5]), cube([20, 20, 10], [-80, 0, 10])]));
    /** Every way through a split: the pieces view, the measure, the download, a fit test. */
    const round = async (i) => {
      const split = S({ cuts: [cutAt(0, -30 + 4 * i), cutAt(1, 3 - i, 'c2')], diameter: i % 2 ? 5 : 0 });
      await resultSplit(split);
      await client.planSplit([], version, { printing, split, bed: BED, mode: 'measure' });
      await exportSplit(split, { archive: 'zip' });
      await client.fitTest([], version, { printing, split, bed: BED, name: 'box' });
    };
    await round(0);
    const watch = trackSolids();
    try {
      await round(1);
      await round(2);
      const settled = watch.live();
      for (let i = 3; i < 13; i++) await round(i);
      // what the engine keeps (the last split, a few shapes it reuses) does not grow with every split
      expect(watch.made()).toBeGreaterThan(500);
      expect(watch.live()).toBeLessThanOrEqual(settled);
      // nor with dovetails, nor with the planner
      await load(sign, 'sign');
      await round(0);
      const plate = watch.live();
      for (let i = 1; i < 6; i++) {
        await resultSplit(S({ cuts: [cutAt(0, 10 * i)] }));
        await client.planSplit([], version, { printing, split: SPLIT_DEFAULTS, bed: BED, mode: 'fit' });
      }
      expect(watch.live()).toBeLessThanOrEqual(plate);
      // nor where a box's loose shelves print apart: laid as modelled, two of the middle box's three would be held over
      // the bed, so each is a piece of its own
      const board = (z) => cube([300, 100, 8], [150, 50, z + 4]);
      await load(own(wasm.Manifold.union([board(0), board(56), board(112), cube([8, 100, 120], [4, 50, 60]), cube([8, 100, 120], [296, 50, 60])])), 'shelf');
      const shelf = (i) => S({ cuts: [cutAt(0, 100 + i), cutAt(0, 200 - i, 'c2')], orient: 'model' });
      await resultSplit(shelf(0));
      await exportSplit(shelf(0), { archive: 'zip' });
      const shelves = watch.live();
      for (let i = 1; i < 4; i++) {
        expect((await resultSplit(shelf(i))).pieces).toHaveLength(5);
        await exportSplit(shelf(i), { archive: 'zip' });
      }
      expect(watch.live()).toBeLessThanOrEqual(shelves);
    } finally {
      watch.stop();
    }
  });

  it('pieces too big to keep are cut and drilled again for the download, from the layout already made', async () => {
    const seen = [];
    const lean = createEngine({ wasm, splitKeepTriangles: 0 });
    const c3 = createEngineClient({ createWorker: () => createLocalWorker(Promise.resolve(lean)), onProgress: (p) => seen.push(p.stage) });
    await c3.addFont('inter', fontBytes('inter', 'inter-latin-700-normal.woff'));
    const box = cube([120, 40, 30]);
    await c3.loadBase({ kind: 'stl', bytes: stlOf(box), name: 'box', version: 1 });
    const options = { printing, split: S({ diameter: 5, depth: 8, count: 2 }), bed: BED, archive: 'files' };
    const shown = await c3.result([], 1, options);
    expect(shown.display.parts.map((p) => p.kind)).toEqual(['piece', 'piece', 'pin', 'pin']);
    seen.length = 0;
    const ex = await c3.export([], 1, 'box', options);
    expect(seen.some((s) => /Cutting/.test(s)) && seen.some((s) => /Drilling/.test(s))).toBe(true);
    expect(seen.some((s) => /Finding room/.test(s))).toBe(false);
    // the cuts' measure leaves a turned copy of the model for the next measure; cutting the pieces again for a
    // download lets it go first, or a dense model would be held three times over while it is cut
    await c3.planSplit([], 1, { printing, split: options.split, bed: BED, mode: 'measure' });
    expect((await c3.call('ping', {})).caches.frame).toBe(1);
    seen.length = 0;
    await c3.export([], 1, 'box', options);
    expect(seen.some((s) => /Cutting/.test(s))).toBe(true);
    expect((await c3.call('ping', {})).caches.frame).toBe(0);
    // the same pieces as from an engine that kept everything (Manifold may list the triangles in another order)
    await load(box);
    const kept = await exportSplit(options.split);
    expect(piecesOf(ex).map((f) => f.triangles)).toEqual(piecesOf(kept).map((f) => f.triangles));
    piecesOf(ex).forEach((f, k) => expect(volumeOfStl(f.stl)).toBeCloseTo(volumeOfStl(piecesOf(kept)[k].stl), 6));
    expect(ex.seams).toEqual(kept.seams);
    lean.dispose();
  });

  it('split options reach the engine', async () => {
    const seen = [];
    const spyEngine = { handle: async (req) => { seen.push(req); return { message: { id: req.id, ok: true, result: {} }, transfer: [] }; } };
    const spy = createEngineClient({ createWorker: () => createLocalWorker(Promise.resolve(spyEngine)) });
    await spy.result([], 1, { printing, split: S(), bed: BED });
    await spy.export([], 1, 'x', { printing, split: S(), bed: BED, archive: 'zip' });
    await spy.planSplit([], 1, { printing, split: S(), bed: BED, mode: 'measure' });
    expect(seen.map((r) => [r.type, r.channel, r.split?.cuts?.length, r.bed])).toEqual([
      ['result', 'result', 1, BED],
      ['export', 'export', 1, BED],
      ['split.plan', 'split', 1, BED],
    ]);
    expect(seen[1].archive).toBe('zip');
    expect(seen[2].mode).toBe('measure');
  });

  it('the result view sends contiguous per-piece ranges', async () => {
    await load(cube([120, 40, 30]));
    const r = await resultSplit(S({ diameter: 5, depth: 8, count: 2, labels: false }));
    expect(r.grid).toEqual([1, 0, 0]);
    expect(r.info).toEqual({ triangles: r.display.index.length / 3, pieces: 2 });
    expect(r.display.parts.map((p) => p.kind)).toEqual(['piece', 'piece', 'pin', 'pin']);
    expect(r.display.parts.slice(0, 2).map((p) => p.index)).toEqual([1, 2]);
    for (const p of r.display.parts.slice(2)) expect(p.cell).toEqual([0.5, 0, 0]);
    let next = 0;
    let vNext = 0;
    for (const [t0, n, v0, nv] of r.display.ranges) {
      expect([t0, v0]).toEqual([next, vNext]);
      next += n;
      vNext += nv;
      for (let i = t0 * 3; i < (t0 + n) * 3; i++) {
        expect(r.display.index[i]).toBeGreaterThanOrEqual(v0);
        expect(r.display.index[i]).toBeLessThan(v0 + nv);
      }
    }
    expect(next).toBe(r.info.triangles);
    expect(vNext * 3).toBe(r.display.positions.length);
    expect(r.display.bvhRoots).toEqual([]);
  });

  it('pieces come back the same after a restart, the labels\' font with them', async () => {
    const engines = [];
    const c2 = createEngineClient({
      createWorker: () => {
        const e = createEngine({ wasm });
        engines.push(e);
        return createLocalWorker(Promise.resolve(e));
      },
    });
    await c2.addFont('inter', fontBytes('inter', 'inter-latin-700-normal.woff'));
    await c2.loadBase({ kind: 'stl', bytes: stlOf(cube([120, 40, 30])), name: 'box', version: 1 });
    const options = { printing, split: S({ diameter: 5, depth: 8, count: 2 }), bed: BED, archive: 'files' };
    const first = await c2.export([], 1, 'box', options);
    c2.restart();
    const again = await c2.export([], 1, 'box', options);
    expect(engines).toHaveLength(2);
    expect(again.seams[0].labels).toEqual(['1A', '2A']);
    expect(piecesOf(again).map((f) => f.triangles)).toEqual(piecesOf(first).map((f) => f.triangles));
    piecesOf(again).forEach((f, k) => expect(volumeOfStl(f.stl)).toBeCloseTo(volumeOfStl(piecesOf(first)[k].stl), 6));
    engines.forEach((e) => e.dispose());
  });

  it('the zip holds the pieces, the pins and the glue sheet', async () => {
    await load(cube([120, 40, 30]));
    const split = S({ diameter: 5, depth: 8, count: 2 });
    const ex = await exportSplit(split, { archive: 'zip' });
    expect(ex.zipName).toBe('box-2-pieces.zip');
    expect(ex.files.every((f) => !f.stl)).toBe(true);
    const zip = unzipSync(new Uint8Array(ex.zip));
    expect(Object.keys(zip).sort()).toEqual(['box-how-to-glue.txt', 'box-piece-1-of-2.stl', 'box-piece-2-of-2.stl', 'box-pins-3x-5x16mm.stl']);
    const text = strFromU8(zip['box-how-to-glue.txt']);
    expect(text).toContain('1A ↔ 2A');
    expect(text).toContain('DRY-FIT');
    expect(text).toContain('piece 2 of 2');
    expect(ex.assembly).toEqual(['Cut A: glue 2 pins into face 1A, a thin film on the face, push piece 2 on (2A). Hold 1 minute.']);
    const files = await exportSplit(split);
    piecesOf(files).forEach((f) => expect(new Uint8Array(f.stl)).toEqual(zip[f.file]));
  });

  it('the fit test is two drilled blocks and a pin', async () => {
    const r = await client.call('split.fitTest', { split: S({ diameter: 5 }), printing, name: 'box' });
    expect(r).toMatchObject({ name: 'box-fit-test', diameter: 5, pins: true, dovetail: false });
    const m = own(solidOfStl(r.stl));
    expect(m.status()).toBe('NoError');
    expect(m.decompose().map(own)).toHaveLength(3);
    expect(new DataView(r.stl).getUint32(80, true)).toBe(r.triangles);
  });

  it('the fit test tries what the split really uses: the pin size Auto picks, and the dovetail of a sign', async () => {
    const shellSizes = (r) => own(solidOfStl(r.stl)).decompose().map(own).map((m) => boxOf(m).size.map((v) => +v.toFixed(3)).sort((p, q) => p - q));
    // a 20 mm bar takes Ø6 pins with Auto: the fit test's pin is Ø6 × 19, not Ø5
    await load(cube([300, 40, 20]), 'bar');
    let r = await client.fitTest([], version, { printing, split: S(), bed: BED, name: 'bar' });
    expect(r).toMatchObject({ diameter: 6, pins: true, dovetail: false });
    expect(shellSizes(r)).toContainEqual([5.543, 5.543, 19]);
    // a sign joined by dovetail tabs alone (joint Auto): two plates with a tab, and no pin it would never use
    await load(cube([400, 100, 4]), 'sign');
    r = await client.fitTest([], version, { printing, split: S(), bed: BED, name: 'sign' });
    expect(r).toMatchObject({ diameter: null, pins: false, dovetail: true });
    expect(shellSizes(r).map((d) => d[0])).toEqual([5, 5]);
    // glue only: nothing to try
    r = await client.fitTest([], version, { printing, split: S({ joint: 'none' }), bed: BED, name: 'sign' });
    expect(r).toMatchObject({ stl: null, pins: false, dovetail: false });
    // no cuts yet: the settings say, Dovetails adding the plates to the pin blocks
    r = await client.fitTest([], version, { printing, split: S({ cuts: [], joint: 'dovetail' }), bed: BED, name: 'sign' });
    expect(r).toMatchObject({ diameter: 5, pins: true, dovetail: true });
    expect(shellSizes(r)).toHaveLength(5);
  });
});

describe('built-in pegs', () => {
  /** What a peg adds beyond its face, and what its socket takes from the other piece, from their sizes. */
  const volumes = (side) => {
    const p = pegSizesFor(side, 0.15, 0.4);
    const w = side + 0.3;
    const m = w + 1;
    const lead = side - 2 * p.e;
    return {
      p,
      peg: side * side * (p.length - p.e) + (p.e / 3) * (side * side + lead * lead + side * lead),
      socket: (0.5 / 3) * (m * m + w * w + m * w) + w * w * (p.h - 0.5) + (w * w * p.tip) / 3,
    };
  };

  it('a box cut with built-in pegs: one piece carries them, the other has their sockets, and the pieces add up and fit together', async () => {
    await load(cube([120, 40, 30]));
    const ex = await exportSplit(S({ joint: 'pegs', labels: false }));
    // nothing to print or buy apart: the pieces and the glue sheet
    expect(ex.files.map((f) => f.kind)).toEqual(['piece', 'piece', 'text']);
    expect(ex).toMatchObject({ diameter: null, pegSize: 6 });
    expect(codes(ex)).toEqual(['SPLIT']);
    const [seam] = ex.seams;
    expect(seam).toMatchObject({ letter: 'A', pieces: [1, 2], joint: 'pegs', male: 1, dowels: [] });
    expect(seam.pegs).toHaveLength(2);
    const { peg, socket } = volumes(6);
    const [A, B] = piecesOf(ex);
    expect(volumeOfStl(A.stl)).toBeCloseTo(72000 + 2 * peg, 1);
    expect(volumeOfStl(B.stl)).toBeCloseTo(72000 - 2 * socket, 1);
    // put back together they never overlap, and each peg sits in its socket with the clearance all round
    const [a, b] = piecesOf(ex).map(assembled);
    expect(overlap(a, b)).toBeLessThan(0.01);
    for (const g of seam.pegs) {
      const inPlace = own(pegAt(g));
      expect(own(inPlace.subtract(a)).volume()).toBeLessThan(1e-3);
      expect(overlap(inPlace, b)).toBeLessThan(1e-3);
      expect(inPlace.minGap(b, 1)).toBeGreaterThanOrEqual(0.15 - 1e-4);
    }
    // the box halves both stood on their cut faces: the one carrying the pegs lies flat instead, its pegs along the bed,
    // and its printed size counts them
    expect(ex.pieces.map((p) => [p.lies, p.down, p.pegs, p.sockets])).toEqual([['flat as modelled', '-z', 2, 0], ['on a cut face', '-x', 0, 2]]);
    expect(ex.pieces[0].size.map((v) => +v.toFixed(3))).toEqual([69, 40, 30]);
    expect(boxOf(pieceSolid(A)).size.map((v) => +v.toFixed(3))).toEqual([69, 40, 30]);
  });

  it('says so in the summary, the steps and the glue sheet, and the zip holds no pins file', async () => {
    await load(cube([120, 40, 30]));
    const ex = await exportSplit(S({ joint: 'pegs' }), { archive: 'zip' });
    expect(Object.keys(unzipSync(new Uint8Array(ex.zip))).sort()).toEqual(['box-how-to-glue.txt', 'box-piece-1-of-2.stl', 'box-piece-2-of-2.stl']);
    expect(noteOf(ex, 'SPLIT').text).toBe('Cut into 2 pieces joined by 2 built-in pegs (6 mm square). Glue matching letters together: 1A ↔ 2A.');
    expect(ex.assembly).toEqual(['Cut A: a little glue in the sockets of face 2A and on the face, push piece 1\'s pegs (1A) in. Hold 1 minute.']);
    const text = strFromU8(unzipSync(new Uint8Array(ex.zip))['box-how-to-glue.txt']);
    expect(text).toContain('pegs and sockets need no supports');
    expect(text).toContain('Pegs should push into their sockets by hand.');
    expect(text).toContain(ex.assembly[0]);
    expect(text).not.toMatch(/\bpins?\b/);
  });

  it('a thin sign still gets dovetail tabs: they are built in too, and pegs have no room in a plate', async () => {
    await load(cube([360, 100, 4]), 'sign');
    const ex = await exportSplit(S({ joint: 'pegs', labels: false }), { name: 'sign' });
    expect(ex.seams).toEqual([expect.objectContaining({ joint: 'dovetail', pegs: [], dowels: [] })]);
    expect(ex.files.map((f) => f.kind)).toEqual(['piece', 'piece', 'text']);
    expect(noteOf(ex, 'SPLIT').text).toBe('Cut into 2 pieces with dovetail tabs.');
    expect(codes(ex)).toEqual(['SPLIT', 'DOVETAIL']);
    expect(noteOf(ex, 'DOVETAIL').text).toBe('Cut A goes through a thin plate, so it has 2 dovetail tabs instead of pegs – lay both pieces flat and lower piece 2 onto piece 1.');
  });

  it('narrower faces take smaller pegs, shorter ones or just one, then glue only – never pins', async () => {
    const tube = (w) => cube([60, 60, 200]).subtract(cube([60 - 2 * w, 60 - 2 * w, 210]));
    const cutZ = { cuts: [cutAt(2, 0)], labels: false };
    // 12 mm walls: Auto takes 4 mm pegs in the corners; asked for 6 mm, the faces take 5 mm and say so
    await load(own(tube(12)), 'tube');
    let ex = await exportSplit(S({ ...cutZ, joint: 'pegs' }), { name: 'tube' });
    expect(ex.pegSize).toBe(4);
    expect(ex.seams[0].pegs.map((g) => g.s)).toEqual([4, 4, 4]);
    ex = await exportSplit(S({ ...cutZ, joint: 'pegs', diameter: 6 }), { name: 'tube' });
    // in three of the corners, a wall's inset from both faces
    expect(ex.seams[0].pegs.map((g) => [g.s, Math.abs(g.centre[0]), Math.abs(g.centre[1])])).toEqual([[5, 23.5, 23.5], [5, 23.5, 23.5], [5, 23.5, 23.5]]);
    expect(noteOf(ex, 'PEGS_SMALLER')).toMatchObject({ level: 'info', letter: 'A', asked: 6, text: 'Cut A is too narrow for 6 mm pegs – it takes 3 × 5 mm pegs instead.' });
    expect(noteOf(ex, 'SPLIT').text).toBe('Cut into 2 pieces joined by 3 built-in pegs (5 mm square).');
    // 8 mm walls: no peg fits, and the cut is glued – no pins, no filament
    await load(own(tube(8)), 'tube');
    ex = await exportSplit(S({ ...cutZ, joint: 'pegs' }), { name: 'tube' });
    expect(ex.seams).toEqual([expect.objectContaining({ joint: 'none', pegs: [], dowels: [] })]);
    expect(ex.files.map((f) => f.kind)).toEqual(['piece', 'piece', 'text']);
    expect(noteOf(ex, 'CONNECTORS_DROPPED')).toMatchObject({
      level: 'warn', pegs: true, text: 'No peg fits on 1 of 1 face at cut A (walls under 10.7 mm) – it is a flat glue joint. A strip glued inside makes it stronger.',
    });
    // 15 mm from a bar's end the sockets have room for 8.9 mm pegs, not 9 mm ones
    await load(cube([300, 40, 20]), 'bar');
    ex = await exportSplit(S({ cuts: [cutAt(0, -135, 'c1'), cutAt(0, 0, 'c2')], joint: 'pegs', labels: false }), { name: 'bar' });
    expect(ex.seams.map((x) => x.pegs.map((g) => g.length))).toEqual([[8.9, 8.9], [9, 9]]);
    expect(noteOf(ex, 'CONNECTORS_SHORTER')).toMatchObject({ letter: 'A', depth: 8.9, text: 'Cut A uses 8.9 mm-long pegs – longer ones would break through the side.' });
    // a 14 mm rod has room for one
    await load(cube([100, 14, 14]), 'rod');
    ex = await exportSplit(S({ joint: 'pegs', labels: false }), { name: 'rod' });
    expect(ex.seams[0].pegs.map((g) => g.s)).toEqual([4]);
    expect(noteOf(ex, 'ONE_CONNECTOR').text).toBe('Only one peg fits on part of cut A – line the pieces up while the glue sets.');
    expect(ex.files.map((f) => f.kind)).toEqual(['piece', 'piece', 'text']);
  });

  it('the fit test is a block with one peg and a block with its socket, at the size the split uses', async () => {
    await load(cube([120, 40, 30]));
    const r = await client.fitTest([], version, { printing, split: S({ joint: 'pegs' }), bed: BED, name: 'box' });
    expect(r).toMatchObject({ pegs: true, pegSize: 6, pins: false, dovetail: false, diameter: null });
    const m = own(solidOfStl(r.stl));
    expect(m.status()).toBe('NoError');
    expect(m.decompose().map(own)).toHaveLength(2);
    const { p, peg, socket } = volumes(6);
    expect(m.volume()).toBeCloseTo(20 ** 3 + peg + 20 * 20 * (p.h + p.tip + p.wall + 2) - socket, 1);
    // a size no face of the split takes: the fit test is of the 6 mm pegs the pieces have, as the summary says
    await load(cube([300, 40, 20]), 'bar');
    const asked = S({ joint: 'pegs', diameter: 10, labels: false });
    expect(noteOf(await exportSplit(asked, { name: 'bar' }), 'SPLIT').text).toMatch(/\(6 mm square\)/);
    const small = await client.fitTest([], version, { printing, split: asked, bed: BED, name: 'bar' });
    expect(small).toMatchObject({ pegs: true, pegSize: 6 });
    expect(boxOf(own(solidOfStl(small.stl))).size.map((v) => +v.toFixed(2))).toEqual(boxOf(own(solidOfStl(r.stl))).size.map((v) => +v.toFixed(2)));
    await load(cube([120, 40, 30]));
    // no cuts yet: the size set, or 5 mm for Auto
    const bare = await client.fitTest([], version, { printing, split: S({ cuts: [], joint: 'pegs' }), bed: BED, name: 'box' });
    expect(bare).toMatchObject({ pegs: true, pegSize: 5, pins: false });
    // a sign joined by dovetail tabs alone: just the tab
    await load(cube([360, 100, 4]), 'sign');
    const sign = await client.fitTest([], version, { printing, split: S({ joint: 'pegs' }), bed: BED, name: 'sign' });
    expect(sign).toMatchObject({ pegs: false, pegSize: null, pins: false, dovetail: true });
  });

  it('which piece carries the pegs follows the printer: on a small one the piece that still fits with them on its end', async () => {
    await load(cube([270, 150, 150], [135, 0, 75]), 'block');
    const split = S({ cuts: [cutAt(0, 170)], joint: 'pegs', labels: false });
    let ex = await exportSplit(split, { name: 'block' });
    expect(ex.seams[0]).toMatchObject({ male: 1 });
    expect(ex.pieces.map((p) => p.fits)).toEqual([true, true]);
    // both halves stand on their cut faces either way, so the pieces lie as before: only the pegs move
    ex = await exportSplit(split, { name: 'block', bed: [170, 170, 179] });
    expect(ex.seams[0]).toMatchObject({ male: 2 });
    expect(ex.pieces.map((p) => [p.fits, p.pegs])).toEqual([[true, 0], [true, 6]]);
    expect(codes(ex)).toEqual(['SPLIT']);
    // asked to lie on their cut faces, the piece with the pegs lies another way, as it must, and is not told it could not
    await load(cube([120, 40, 30]));
    ex = await exportSplit(S({ joint: 'pegs', labels: false, orient: 'cut' }));
    expect(ex.pieces.map((p) => p.lies)).toEqual(['flat as modelled', 'on a cut face']);
    expect(codes(ex)).toEqual(['SPLIT']);
  });

  it('Fit to my printer counts the pegs on the piece that carries them: a 420 mm board takes three pieces where pins take two', async () => {
    await load(cube([420, 150, 20]), 'board');
    const pins = await client.planSplit([], version, { printing, split: { ...SPLIT_DEFAULTS, joint: 'dowels' }, bed: BED, mode: 'fit' });
    expect(pins.pieces).toHaveLength(2);
    const split = { ...SPLIT_DEFAULTS, joint: 'pegs' };
    const plan = await client.planSplit([], version, { printing, split, bed: BED, mode: 'fit' });
    expect(plan.pieces).toHaveLength(3);
    expect(plan.pieces.every((p) => p.fits)).toBe(true);
    const cuts = plan.cuts.map((c, i) => ({ id: `c${i + 1}`, ...c }));
    const ex = await exportSplit({ ...split, cuts, labels: false }, { name: 'board' });
    expect(ex.pieces.map((p) => p.fits)).toEqual([true, true, true]);
    expect(ex.pieces.map((p) => p.pegs)).toEqual([3, 3, 0]);
    // while the cuts are edited, a cut with pegs is measured as reaching as far as the 9 mm pegs a 20 mm board takes,
    // on the side that carries them, so the boxes are the pieces' lengths
    const measured = await client.planSplit([], version, { printing, split: { ...split, cuts }, bed: BED, mode: 'measure' });
    expect(measured.cuts.map((c) => [c.joint, c.reach])).toEqual([['pegs', [9, 0]], ['pegs', [9, 0]]]);
    const sorted = (size) => size.map((v) => +v.toFixed(3)).sort((p, q) => p - q);
    expect(cellSizes(measured.bounds, measured.cuts).cells.map((c) => sorted(c.size))).toEqual(ex.pieces.map((p) => sorted(p.size)));
    // a 534 mm bar fits across the bed on its side in two, with its 9 mm pegs too
    await load(cube([534, 40, 20]), 'bar');
    const bar = await client.planSplit([], version, { printing, split, bed: BED, mode: 'fit' });
    expect(bar.pieces).toHaveLength(2);
    const halves = await exportSplit({ ...split, cuts: bar.cuts.map((c, i) => ({ id: `c${i + 1}`, ...c })), labels: false }, { name: 'bar' });
    expect(halves.pieces.map((p) => [p.fits, p.pegs > 0])).toEqual([[true, true], [true, false]]);
  });

  it('a 30 mm slab cut in four with pegs still lies flat: each cut moves towards the pieces that carry its pegs', async () => {
    await load(cube([400, 400, 30]), 'slab');
    const split = { ...SPLIT_DEFAULTS, joint: 'pegs' };
    const plan = await client.planSplit([], version, { printing, split, bed: BED, mode: 'fit' });
    expect(plan.pieces).toHaveLength(4);
    const ex = await exportSplit({ ...split, cuts: plan.cuts.map((c, i) => ({ id: `c${i + 1}`, ...c })), labels: false }, { name: 'slab' });
    expect(ex.pieces.map((p) => [p.fits, p.lies, +p.size[2].toFixed(3)])).toEqual(Array.from({ length: 4 }, () => [true, 'flat as modelled', 30]));
    expect(ex.pieces.map((p) => p.pegs > 0)).toEqual([true, true, true, false]);
  });

  it('the pegs go on the piece that still fits carrying them: a column cut right of its middle, a tower cut high', async () => {
    // both halves of the column stand as modelled; the 205 mm one would be 217 mm with the pegs, so the other carries them
    await load(cube([360, 100, 240], [0, 0, 120]), 'column');
    let ex = await exportSplit(S({ cuts: [cutAt(0, 25)], joint: 'pegs', labels: false }), { name: 'column' });
    expect(ex.seams[0]).toMatchObject({ male: 2 });
    expect(ex.pieces.map((p) => [p.fits, p.pegs > 0])).toEqual([[true, false], [true, true]]);
    expect(codes(ex)).toEqual(['SPLIT']);
    // the tower's top stands on its cut face, so its foot would carry them, 252 mm tall; the top carries them instead
    await load(cube([100, 100, 400], [0, 0, 200]), 'tower');
    ex = await exportSplit(S({ cuts: [cutAt(2, 240)], joint: 'pegs', labels: false }), { name: 'tower' });
    expect(ex.seams[0]).toMatchObject({ male: 2 });
    expect(ex.pieces.map((p) => [p.fits, p.pegs > 0, p.down === '-z'])).toEqual([[true, false, true], [true, true, false]]);
    expect(codes(ex)).toEqual(['SPLIT']);
  });

  it('two stubs cut across rest together only on their cut faces: neither piece carries pegs, and the note says why', async () => {
    // lying any other way, one stub of either piece would be held over the bed (before, one carried the pegs anyway and
    // was laid flat with a stub in the air)
    await load(own(cube([20, 30, 30], [0, -25, 15]).add(cube([30, 30, 30], [0, 25, 35]))), 'stubs');
    const ex = await exportSplit(S({ joint: 'pegs', labels: false }), { name: 'stubs' });
    expect(ex.pieces.map((p) => [p.shells, p.lies, p.pegs])).toEqual([[2, 'on a cut face', 0], [2, 'on a cut face', 0]]);
    expect(noteOf(ex, 'CONNECTORS_DROPPED')).toMatchObject({
      lying: true, text: 'On 2 of 2 faces at cut A neither piece can lie on the bed with pegs standing out of it – they are flat glue joints. Pins (Joints: Pins) would join them.',
    });
  });

  it('a thin plate under a thick top carries the pegs, standing up, and the top takes the sockets', async () => {
    // a plaque cut along the top of its 5 mm base: over it a 2 mm field with 1 mm pockets, and a 15 mm rim and a 60 × 40
    // block rising 8 mm; under it, letters engraved 1 mm deep, so the base would rather lie on its cut face. It has no
    // room for a socket, so it carries the pegs; the top has room under the rim and the block (before, the room was the
    // thinner side's, and no peg fitted)
    const plaque = own(wasm.Manifold.union([
      own(cube([174, 120, 5], [0, 0, 2.5]).subtract(own(wasm.Manifold.union([cube([60, 12, 2], [-40, 0, 0]), cube([60, 12, 2], [40, 0, 0])])))),
      own(cube([174, 120, 2], [0, 0, 6]).subtract(own(wasm.Manifold.union([[-50, 30], [50, 30], [-50, -30], [50, -30]].map(([x, y]) => cube([16, 8, 2], [x, y, 7])))))),
      own(cube([174, 120, 8], [0, 0, 9]).subtract(cube([144, 90, 10], [0, 0, 9]))),
      cube([60, 40, 8], [0, 0, 9]),
    ]));
    await load(plaque, 'plaque');
    const ex = await exportSplit(S({ cuts: [cutAt(2, 5)], joint: 'pegs', labels: false }), { name: 'plaque' });
    const [seam] = ex.seams;
    expect(seam).toMatchObject({ pieces: [1, 2], joint: 'pegs', male: 1 });
    expect(seam.pegs.length).toBeGreaterThanOrEqual(2);
    const { length } = seam.pegs[0];
    expect(noteOf(ex, 'SPLIT').text).toBe(`Cut into 2 pieces joined by ${seam.pegs.length} built-in pegs (4 mm square).`);
    // the sockets go only where the top is thick enough: inside the model, a wall's thickness from the air
    const air = own(cube([200, 150, 40], [0, 0, 6.5]).subtract(plaque));
    for (const g of seam.pegs) {
      const socket = own(socketAt(g));
      expect(own(socket.subtract(plaque)).volume()).toBeLessThan(1e-6);
      expect(socket.minGap(air, 5)).toBeGreaterThanOrEqual(pegSizesFor(g.s).wall - 1e-6);
    }
    // the base lies on its underside with its pegs pointing up, its height counting them, and is told they stand up;
    // the top lies on its cut face, the sockets mouth down
    expect(ex.pieces.map((p) => [p.lies, p.down, p.pegs, p.sockets])).toEqual([['flat as modelled', '-z', seam.pegs.length, 0], ['on a cut face', '-z', 0, seam.pegs.length]]);
    expect(+ex.pieces[0].size[2].toFixed(3)).toBe(5 + length);
    // pins are not offered: the base is too thin for their holes as well
    expect(noteOf(ex, 'PEGS_UPRIGHT')).toMatchObject({
      level: 'info', letter: 'A', pieces: [1],
      text: 'Cut A\'s pegs print standing up on piece 1 – they are a little weaker across the layers than pegs lying flat.',
    });
    // put back together they never overlap, and each peg sits in its socket with the clearance all round
    const [a, b] = piecesOf(ex).map(assembled);
    expect(overlap(a, b)).toBeLessThan(0.01);
    for (const g of seam.pegs) {
      const inPlace = own(pegAt(g));
      expect(own(inPlace.subtract(a)).volume()).toBeLessThan(1e-3);
      expect(overlap(inPlace, b)).toBeLessThan(1e-3);
      expect(inPlace.minGap(b, 1)).toBeGreaterThanOrEqual(0.15 - 1e-4);
    }
  });

  it('a lid too thin for sockets is glued, lying flat, rather than carry the pegs standing on its edge or its knob', async () => {
    // a box with 12 mm walls and a 5 mm lid: the body has room for sockets, the lid none, so the lid would carry them;
    // with a knob on it, it could then only stand on its edge or rest on the knob
    const body = own(cube([120, 120, 100], [0, 0, 50]).subtract(cube([96, 96, 94], [0, 0, 53])));
    const knob = own(own(wasm.Manifold.cylinder(20, 12, 12, 48)).translate([0, 0, 105]));
    await load(own(wasm.Manifold.union([body, cube([120, 120, 5], [0, 0, 102.5]), knob])), 'knob');
    let ex = await exportSplit(S({ cuts: [cutAt(2, 100)], joint: 'pegs', labels: false }), { name: 'knob' });
    expect(ex.seams).toEqual([expect.objectContaining({ joint: 'none', pegs: [] })]);
    expect(noteOf(ex, 'CONNECTORS_DROPPED')).toMatchObject({
      level: 'warn', thin: true, text: 'On 1 of 1 face at cut A one piece is too thin for sockets and can\'t lie flat on the bed with pegs standing out of it – it is a flat glue joint.',
    });
    expect(ex.pieces.map((p) => [p.lies, p.down])).toEqual([['flat as modelled', '-z'], ['on a cut face', '-z']]);
    // a plain lid lies as well on its top, its pegs pointing up
    await load(own(wasm.Manifold.union([body, cube([120, 120, 5], [0, 0, 102.5])])), 'lid');
    ex = await exportSplit(S({ cuts: [cutAt(2, 100)], joint: 'pegs', labels: false }), { name: 'lid' });
    expect(ex.seams).toEqual([expect.objectContaining({ joint: 'pegs', male: 2 })]);
    expect(ex.pieces[1]).toMatchObject({ lies: 'upside down', down: '+z' });
  });

  it('a plate too thin for sockets between two cuts carries the pegs of one face, lying flat on the other, which is glued', async () => {
    // with the pegs of both faces it could only stand on its edge, 150 mm tall
    await load(cube([150, 150, 125], [0, 0, 62.5]), 'sandwich');
    const ex = await exportSplit(S({ cuts: [cutAt(2, 60, 'c1'), cutAt(2, 65, 'c2')], joint: 'pegs', labels: false }), { name: 'sandwich' });
    expect(ex.seams.map((x) => [x.letter, x.joint, x.male])).toEqual([['A', 'pegs', 2], ['B', 'none', null]]);
    expect(noteOf(ex, 'CONNECTORS_DROPPED')).toMatchObject({ letter: 'B', thin: true });
    const [{ length }] = ex.seams[0].pegs;
    expect(ex.pieces[1]).toMatchObject({ down: '+z', pegs: ex.seams[0].pegs.length, sockets: 0 });
    expect(+ex.pieces[1].size[2].toFixed(3)).toBe(5 + length);
  });

  it('a sliver between two cuts never carries pegs: its pegs would stand on 1.5 mm of material', async () => {
    await load(cube([150, 150, 125], [0, 0, 62.5]), 'sliver');
    const ex = await exportSplit(S({ cuts: [cutAt(2, 60, 'c1'), cutAt(2, 61.5, 'c2')], joint: 'pegs', labels: false }), { name: 'sliver' });
    // the middle one of the three boxes up the model
    const sliver = ex.pieces.find((p) => p.cell[2] === 1);
    expect(sliver).toBeDefined();
    expect(sliver.pegs).toBe(0);
    for (const seam of ex.seams) if (seam.male !== null) expect(seam.male).not.toBe(sliver.index);
  });

  it('a sheet too thin for anything is glued, and the note speaks of pegs', async () => {
    await load(cube([300, 100, 1.5]), 'sheet');
    const ex = await exportSplit(S({ joint: 'pegs', labels: false }), { name: 'sheet' });
    expect(noteOf(ex, 'CONNECTORS_DROPPED')).toMatchObject({
      pegs: true, text: 'No peg fits on 1 of 1 face at cut A (walls under 2 mm) – it is a flat glue joint. A strip glued inside makes it stronger.',
    });
  });
});

describe('cuts that come apart', () => {
  const MINI = [170, 170, 179]; // an A1 mini's room
  const apartAt = (axis, at, id = 'c1', hold = 'snap') => ({ ...cutAt(axis, at, id), joint: 'apart', hold });
  const lantern = () => load(own(lanternSolid()), 'lantern');
  // a chest 300 × 100 × 120 with 10 mm walls, floor and top
  const chest = () => own(cube([300, 100, 120], [0, 0, 60]).subtract(cube([280, 80, 100], [0, 0, 60])));
  const UP = { '+z': [0, 0, 1], '-z': [0, 0, -1] };
  /** A piece's file as a slicer reads it: float32 corners matched exactly (`stlCheck`). */
  const fileCheck = (f) => {
    const p = parseSTL(f.stl).attributes.position.array;
    return stlCheck({ getMesh: () => ({ vertProperties: p, numProp: 3, triVerts: Array.from({ length: p.length / 3 }, (_, i) => i) }) });
  };

  it('a lantern whose top comes off: the body carries a 6 mm lip with 4 clips, the top clicks onto it, and nothing is glued', async () => {
    await lantern();
    const split = S({ cuts: [apartAt(2, 190)] });
    const ex = await exportSplit(split, { name: 'lantern', archive: 'zip' });
    // the pieces and the sheet: no pins, and no labels on a face that is never glued
    const zip = unzipSync(new Uint8Array(ex.zip));
    expect(Object.keys(zip).sort()).toEqual(['lantern-how-to-glue.txt', 'lantern-piece-1-of-2.stl', 'lantern-piece-2-of-2.stl']);
    // the body stands as modelled with the lip up out of it, counted in its height; the top lies on its cut face
    expect(ex.pieces.map((p) => [p.lies, p.down, p.size.map((v) => +v.toFixed(3)), p.lips, p.lids])).toEqual([
      ['flat as modelled', '-z', [108, 108, 196], [{ letter: 'A', clips: 4 }], []],
      ['on a cut face', '-z', [110, 110, 101], [], ['A']],
    ]);
    expect(ex.seams).toEqual([expect.objectContaining({
      letter: 'A', pieces: [1, 2], joint: 'lip', male: 1, labels: null, dowels: [], pegs: [],
      apart: { hold: 'snap', lip: true, clips: 4, height: 6, key: true, faces: 1, flat: 0 },
    })]);
    // held well enough to carry the model by its top: no warning that it may not
    expect(codes(ex)).toEqual(['SPLIT', 'APART']);
    expect(noteOf(ex, 'SPLIT').text).toBe('Cut into 2 pieces. Cut A comes apart – don\'t glue it.');
    expect(noteOf(ex, 'APART').text).toBe('Cut A comes apart: the top (piece 2) clicks onto a 6 mm lip on piece 1 – 4 clips hold it, and it pulls off again by hand.');
    expect(ex.assembly).toEqual(['Do not glue cut A: it comes apart. Press the top on until it clicks. It goes on one way round only – turn it until it drops onto the lip.']);
    const text = strFromU8(zip['lantern-how-to-glue.txt']);
    expect(text).toContain('lips and clips need no supports');
    expect(text).toMatch(/piece 1 of 2 .*fits, lip for cut A\n/);
    expect(text).toMatch(/piece 2 of 2 .*fits, comes off at cut A\n/);
    expect(text).toContain('The top of cut A should click onto its lip and pull off again by hand.');
    expect(text).toContain(`PUT TOGETHER – nothing is glued\n  1. ${ex.assembly[0]}\n`);
    expect(text).not.toContain('GLUE –');
    // each file is clean as a slicer reads it, and put back where it came from the top sits on the lip with the
    // clearance all round: lifted 0.25 mm, the clips' catches still meet the top's recesses
    const files = piecesOf(await exportSplit(split, { name: 'lantern' }));
    expect(files.map(fileCheck)).toEqual([{ degenerate: 0, open: 0 }, { degenerate: 0, open: 0 }]);
    const [body, top] = files.map(pieceSolid);
    expect(Math.abs(body.volume() - 220870.9)).toBeLessThan(1);
    expect(Math.abs(top.volume() - 80826.8)).toBeLessThan(1);
    expect([body.genus(), top.genus()]).toEqual([12, 1]);
    const [a, b] = files.map(assembled);
    expect(overlap(a, b)).toBeLessThan(1e-6);
    expect(Math.abs(lift(a, b, [0, 0, 0.25]) - 0.206)).toBeLessThan(0.02);
  });

  it('a lantern whose top locks: the same pieces with stiffer clips, notes and a sheet that say it takes a hard pull to come off, and no warning', async () => {
    await lantern();
    const split = S({ cuts: [apartAt(2, 190, 'c1', 'lock')] });
    const ex = await exportSplit(split, { name: 'lantern', archive: 'zip' });
    const zip = unzipSync(new Uint8Array(ex.zip));
    expect(Object.keys(zip).sort()).toEqual(['lantern-how-to-glue.txt', 'lantern-piece-1-of-2.stl', 'lantern-piece-2-of-2.stl']);
    expect(ex.pieces.map((p) => [p.lies, p.down, p.size.map((v) => +v.toFixed(3)), p.lips, p.lids])).toEqual([
      ['flat as modelled', '-z', [108, 108, 196], [{ letter: 'A', clips: 4 }], []],
      ['on a cut face', '-z', [110, 110, 101], [], ['A']],
    ]);
    expect(ex.seams).toEqual([expect.objectContaining({
      letter: 'A', pieces: [1, 2], joint: 'lip', male: 1, labels: null, dowels: [], pegs: [],
      apart: { hold: 'lock', lip: true, clips: 4, height: 6, key: true, faces: 1, flat: 0 },
    })]);
    // four locking clips hold far more than the body weighs: no warning
    expect(codes(ex)).toEqual(['SPLIT', 'APART']);
    // the seated top hides the key's gap inside its wall, so the only way off is a hard pull: nothing says to lever it
    expect(noteOf(ex, 'APART')).toMatchObject({
      hold: 'lock', clips: 4,
      text: 'Cut A comes apart: the top (piece 2) locks onto a 6 mm lip – 4 clips hold it firmly. Press it on until it clicks; to take it off, pull hard.',
    });
    expect(noteOf(ex, 'APART')).not.toHaveProperty('key');
    expect(ex.assembly).toEqual([
      'Do not glue cut A: it comes apart. Press the top on until it clicks – it locks; pull hard to open it. It goes on one way round only – turn it until it drops onto the lip.',
    ]);
    const text = strFromU8(zip['lantern-how-to-glue.txt']);
    expect(text).not.toMatch(/lever|gap/);
    expect(text).toContain('  Clips are 30 mm bridges over a slot: print with bridging on (the default) and no supports.');
    expect(text).toContain('  The top of cut A should lock onto its lip and come off only with a firm pull. Too stiff to open: raise Clearance by 0.05 mm (or set the cut to Clicks on); too loose: lower it by 0.05 mm, and download again.');
    expect(text).toContain(`PUT TOGETHER – nothing is glued\n  1. ${ex.assembly[0]}\n`);
    // clean files; put back, the top sits with the clearance all round and is held sooner and harder than Clicks on's
    const files = piecesOf(await exportSplit(split, { name: 'lantern' }));
    expect(files.map(fileCheck)).toEqual([{ degenerate: 0, open: 0 }, { degenerate: 0, open: 0 }]);
    const [body, top] = files.map(pieceSolid);
    expect(Math.abs(body.volume() - 221066.2)).toBeLessThan(1);
    expect(Math.abs(top.volume() - 80823.0)).toBeLessThan(1);
    expect([body.genus(), top.genus()]).toEqual([12, 1]);
    const [a, b] = files.map(assembled);
    expect(overlap(a, b)).toBeLessThan(1e-6);
    expect(Math.abs(lift(a, b, [0, 0, 0.25]) - 0.572)).toBeLessThan(0.02);
    // the fit test: the box and its lid with the locking clips
    const fit = await client.fitTest([], version, { printing, split, bed: BED, name: 'lantern' });
    expect(fit).toMatchObject({ apart: 'lock', pins: false, pegs: false, dovetail: false });
    const bodies = own(solidOfStl(fit.stl)).decompose().map(own).map((m) => boxOf(m).size.map((v) => +v.toFixed(3)));
    expect(bodies.sort((p, q) => q[2] - p[2])).toEqual([[60, 30, 18], [60, 30, 12]]);
    const clicks = await client.fitTest([], version, { printing, split: S({ cuts: [apartAt(2, 190)] }), bed: BED, name: 'lantern' });
    expect(Math.abs(own(solidOfStl(fit.stl)).volume() - own(solidOfStl(clicks.stl)).volume())).toBeGreaterThan(10);
    // set to lock without the model, the settings say so too
    expect(await client.call('split.fitTest', { split: split, printing, name: 'lantern' })).toMatchObject({ apart: 'lock' });
  });

  it('a light click may not hold up the body when the model is carried by its top, and says so', async () => {
    await lantern();
    const ex = await exportSplit(S({ cuts: [apartAt(2, 190, 'c1', 'light')], labels: false }), { name: 'lantern' });
    expect(codes(ex)).toEqual(['SPLIT', 'APART', 'APART_HEAVY']);
    expect(noteOf(ex, 'APART').text).toBe('Cut A comes apart: the top (piece 2) clicks lightly onto a 6 mm lip on piece 1 – 4 clips hold it, and it pulls off again by hand.');
    // what hangs below the cut is the body as it was cut, in PLA; four light clips hold about 4.2 N, under twice its 2.7 N
    const heavy = noteOf(ex, 'APART_HEAVY');
    expect(heavy.text).toBe('Cut A\'s clips may not hold up what hangs below it (about 270 g) – carry the model by its base, not its top.');
    expect(heavy.weight).toBe(Math.round(own(own(lanternSolid()).trimByPlane([0, 0, -1], -190)).volume() * 1.24e-3));
    expect(heavy.hold).toBeCloseTo(4.2, 1);
    // Clicks on's 10.5 N would hold it up: that is the hold the note offers
    expect(heavy.firmer).toBe('snap');
  });

  it('with a heavy base under the cut Clicks on may not hold it up either: the note offers Locks, which does', async () => {
    // the lantern with a solid base, about 650 g below the cut: under 2 × 6.4 N, Clicks on's 10.5 N is too little
    await load(own(own(lanternSolid()).add(own(box([-46, -46, 3], [46, 46, 40])))), 'heavy');
    const of = async (hold) => noteOf(await exportSplit(S({ cuts: [apartAt(2, 190, 'c1', hold)], labels: false }), { name: 'heavy' }), 'APART_HEAVY');
    const [snap, light, lock] = [await of('snap'), await of('light'), await of('lock')];
    expect(snap).toMatchObject({ weight: 648, firmer: 'lock', text: 'Cut A\'s clips may not hold up what hangs below it (about 650 g) – carry the model by its base, not its top.' });
    expect(snap.hold).toBeCloseTo(10.5, 1);
    expect(light).toMatchObject({ weight: 648, firmer: 'lock' });
    expect(lock).toBeUndefined();
  });

  it('on a wider nozzle the clips are thinned to a 0.4 mm nozzle\'s, so they hold alike: a light click warns as it would, and Clicks on is enough', async () => {
    // an open box 100 × 100 × 200 with 7 mm walls, 512 g below a cut at 150 (10 N twice over); a 0.6 mm nozzle's tongue
    // is 2.4 mm
    await load(own(own(box([-50, -50, 0], [50, 50, 200])).subtract(own(box([-43, -43, 3], [43, 43, 201])))), 'tower');
    const wide = { nozzle: 0.6, layerHeight: 0.3 };
    const ex = await client.export([], version, 'tower', { printing: wide, split: S({ cuts: [apartAt(2, 150, 'c1', 'light')], labels: false }), bed: BED, archive: 'files' });
    // its clips hold as a 0.4 mm nozzle's do, 4.2 N – not the 14.2 N the whole 2.4 mm tongue would make them
    expect(codes(ex)).toEqual(['SPLIT', 'APART', 'APART_HEAVY']);
    expect(noteOf(ex, 'APART_HEAVY')).toMatchObject({ weight: 512, firmer: 'snap' });
    expect(noteOf(ex, 'APART_HEAVY').hold).toBeCloseTo(4.2, 1);
    expect(piecesOf(ex).map(fileCheck)).toEqual([{ degenerate: 0, open: 0 }, { degenerate: 0, open: 0 }]);
    // a lock's clips are its 30 mm bridges at 0.6 mm; at 1 mm, two lines thick, 37.5 mm, as long as they are thicker
    const sheet = async (nozzle, wall) => {
      await load(own(own(box([-50, -50, 0], [50, 50, 200])).subtract(own(box([-50 + wall, -50 + wall, 3], [50 - wall, 50 - wall, 201])))), 'tower');
      const r = await client.export([], version, 'tower', { printing: { nozzle, layerHeight: 0.3 }, split: S({ cuts: [apartAt(2, 150, 'c1', 'lock')], labels: false }), bed: BED, archive: 'zip' });
      return { codes: codes(r), clips: r.seams[0].apart.clips, text: strFromU8(unzipSync(new Uint8Array(r.zip))['tower-how-to-glue.txt']) };
    };
    for (const [nozzle, wall, bridge] of [[0.6, 7, 30], [1, 10, 37.5]]) {
      const got = await sheet(nozzle, wall);
      expect(got.codes).toEqual(['SPLIT', 'APART']);
      expect(got.clips).toBe(4);
      expect(got.text).toContain(`  Clips are ${bridge} mm bridges over a slot: print with bridging on (the default) and no supports.`);
    }
  });

  it('the fit test of a cut that locks has the locking clips on a wider nozzle too: its box and lid grow for the thicker lip', async () => {
    // the settings alone, glue only for any other cut: the box and its lid and nothing else
    const split = S({ joint: 'none', cuts: [apartAt(2, 190, 'c1', 'lock')] });
    const coupon = async (nozzle, hold = 'lock') => {
      const r = await client.call('split.fitTest', { split: S({ joint: 'none', cuts: [apartAt(2, 190, 'c1', hold)] }), printing: { nozzle, layerHeight: 0.2 }, name: 'lantern' });
      const solid = own(solidOfStl(r.stl));
      return { apart: r.apart, volume: solid.volume(), bodies: solid.decompose().map(own).map((m) => boxOf(m).size.map((v) => +v.toFixed(3))).sort((p, q) => q[2] - p[2]) };
    };
    expect((await client.call('split.fitTest', { split, printing, name: 'lantern' })).apart).toBe('lock');
    // a full 6 mm lip on the box, 6 mm over its 12, where a 0.5 mm nozzle and wider had only 4.5 mm and no clips
    for (const [nozzle, sizes] of [[0.4, [[60, 30, 18], [60, 30, 12]]], [0.6, [[64, 34, 18], [64, 34, 14]]], [0.8, [[68, 38, 18], [68, 38, 15]]]]) {
      const [lock, lift] = [await coupon(nozzle), await coupon(nozzle, 'lift')];
      expect(lock.apart).toBe('lock');
      expect(lock.bodies).toEqual(sizes);
      expect(lift.bodies).toEqual(sizes);
      expect(Math.abs(lock.volume - lift.volume)).toBeGreaterThan(100); // its slots and catches
    }
  });

  it('a cut glued beside one that comes apart is glued first, with its labels, and the lid goes on last; the lip lays the box', async () => {
    await load(chest(), 'chest');
    const ex = await exportSplit(S({ cuts: [apartAt(2, 95), cutAt(0, 0, 'c2')], orient: 'cut' }), { name: 'chest', archive: 'zip' });
    // asked to lie on a cut face, the box halves would lie on their tops: the lip standing up out of them lays them
    // as modelled, and nothing says they could not lie as asked
    expect(ex.pieces.map((p) => [p.lies, p.up, p.lips.map((l) => l.letter), p.lids])).toEqual([
      ['flat as modelled', '+z', ['A'], []], ['flat as modelled', '+z', ['A'], []], ['on a cut face', '+z', [], ['A']], ['on a cut face', '+z', [], ['A']],
    ]);
    expect(codes(ex)).toEqual(['SPLIT', 'PINS', 'APART', 'APART_HEAVY']);
    // the glued cut's pin holes are drilled for the way the pieces print: their teardrops point up
    const holes = ex.seams.filter((s) => s.letter === 'B').flatMap((s) => s.dowels.flatMap((d) => d.sides));
    expect(holes.length).toBeGreaterThan(0);
    for (const side of holes) expect([side.tear, side.apex]).toEqual([true, UP[ex.pieces[side.piece - 1].up]]);
    expect(ex.seams.map((s) => [s.letter, s.joint, s.labels])).toEqual([['B', 'dowels', ['1B', '2B']], ['B', 'dowels', ['3B', '4B']], ['A', 'lip', null], ['A', 'lip', null]]);
    expect(noteOf(ex, 'SPLIT').text).toBe('Cut into 4 pieces with 5 pins Ø3 × 10 mm. Glue matching letters together: 1B ↔ 2B, 3B ↔ 4B. Cut A comes apart – don\'t glue it.');
    expect(ex.assembly).toEqual([
      'Cut B: glue 3 pins into face 1B, a thin film on the face, push piece 2 on (2B). Hold 1 minute.',
      'Cut B: glue 2 pins into face 3B, a thin film on the face, push piece 4 on (4B). Hold 1 minute.',
      'Do not glue cut A: it comes apart. Press the top (pieces 3 and 4) on until it clicks. It goes on one way round only – turn it until it drops onto the lip.',
    ]);
    const text = strFromU8(unzipSync(new Uint8Array(ex.zip))['chest-how-to-glue.txt']);
    expect(text).toContain('GLUE – put each letter on the same letter');
    expect(text).toContain(`  2. ${ex.assembly[1]}\n\nLAST – DO NOT GLUE\n  3. ${ex.assembly[2]}\n`);
  });

  it('Fit to my printer keeps a cut that comes apart where it is, first, and plans the other cuts round it', async () => {
    await lantern();
    const kept = apartAt(2, 190, 'c5');
    const split = { ...SPLIT_DEFAULTS, cuts: [kept] };
    // on the default printer the pieces it makes fit already, the lip counted: it alone comes back
    let plan = await client.planSplit([], version, { printing, split, bed: BED, mode: 'fit' });
    expect(plan.cuts).toEqual([kept]);
    expect(plan.notes).toEqual([expect.objectContaining({ code: 'SPLIT_NOT_NEEDED', apart: ['A'], text: 'This model fits your printer with cut A as it is – no more cuts needed.' })]);
    // on an A1 mini the body is too tall even so: one more cut, below it
    plan = await client.planSplit([], version, { printing, split, bed: MINI, mode: 'fit' });
    expect(plan.cuts).toHaveLength(2);
    expect(plan.cuts[0]).toEqual(kept);
    expect(plan.cuts[1]).toEqual({ position: [0, 0, expect.any(Number)], normal: [0, 0, 1] });
    expect(plan.cuts[1].position[2]).toBeLessThan(190 - 20);
    expect(plan.counts).toEqual([0, 0, 2]);
    expect(plan.pieces.map((p) => p.fits)).toEqual([true, true, true]);
    expect(plan.notes).toEqual([expect.objectContaining({ code: 'APART_KEPT', text: 'Cut A comes apart, so Fit to my printer kept it where it is and planned the other cuts around it.' })]);
    // set to lift off instead, it comes back so: the plan is made again for it
    const lifting = await client.planSplit([], version, { printing, split: { ...split, cuts: [{ ...kept, hold: 'lift' }] }, bed: MINI, mode: 'fit' });
    expect(lifting.cuts[0]).toEqual({ ...kept, hold: 'lift' });
    // taken as the document numbers a new cut (one past the highest id), the split uses the pieces the plan cut, and they fit
    const from = stages.length;
    const ex = await exportSplit({ ...split, cuts: [kept, { id: 'c6', ...plan.cuts[1] }], labels: false }, { name: 'lantern', bed: MINI });
    expect(stages.slice(from)).not.toContain('Cutting into pieces…');
    expect(ex.pieces.map((p) => p.fits)).toEqual([true, true, true]);
    expect(ex.seams.find((s) => s.cutId === 'c5')).toMatchObject({ joint: 'lip', apart: { hold: 'snap', clips: 4 } });
    // a model that fits whole keeps its cut that comes apart too: Fit never takes it away
    await load(own(cube([150, 100, 120], [0, 0, 60]).subtract(cube([130, 80, 100], [0, 0, 60]))), 'tub');
    const lid = apartAt(2, 100, 'c1', 'light');
    plan = await client.planSplit([], version, { printing, split: { ...SPLIT_DEFAULTS, cuts: [lid] }, bed: BED, mode: 'fit' });
    expect(plan.cuts).toEqual([lid]);
    expect(codes(plan)).toEqual(['SPLIT_NOT_NEEDED']);
  });

  it('the measure counts a lip on the piece that will carry it, as the pieces will have it', async () => {
    await lantern();
    const m = await client.planSplit([], version, { printing, split: S({ cuts: [apartAt(2, 190)] }), bed: BED, mode: 'measure' });
    expect(m.cuts).toEqual([expect.objectContaining({ id: 'c1', letter: 'A', joint: 'lip', apart: { hold: 'snap' }, reach: [6, 0], islands: 1 })]);
    expect(m.cuts[0].area).toBeCloseTo(1728, 3);
    expect(cellSizes(m.bounds, m.cuts).cells.map((c) => +c.size[2].toFixed(3))).toEqual([196, 101]);
    // a box with an 8 mm lid: the lid leaves the box's lip no room for clips, so the lid carries it, as the pieces will
    await load(own(cube([80, 80, 60], [0, 0, 30]).subtract(cube([74, 74, 54], [0, 0, 30]))), 'lidded');
    const lid = await client.planSplit([], version, { printing, split: S({ cuts: [apartAt(2, 52)] }), bed: BED, mode: 'measure' });
    expect(lid.cuts[0]).toMatchObject({ joint: 'lip', reach: [0, 6] });
    expect(cellSizes(lid.bounds, lid.cuts).cells.map((c) => +c.size[2].toFixed(3))).toEqual([52, 14]);
    const ex = await exportSplit(S({ cuts: [apartAt(2, 52)], labels: false }), { name: 'lidded' });
    expect(ex.pieces.map((p) => +p.size[2].toFixed(3))).toEqual([52, 14]);
    // the lid is what comes off, whichever piece has the lip
    expect(ex.pieces.map((p) => [p.lips.map((l) => l.letter), p.lids])).toEqual([[[], []], [['A'], ['A']]]);
  });

  it('ticking a cut or changing how it holds drills the pieces again but never cuts them again, and the printer can move the lip', async () => {
    await load(chest(), 'chest');
    const cuts = (hold) => [hold ? apartAt(2, 95, 'c1', hold) : cutAt(2, 95, 'c1'), cutAt(0, 0, 'c2')];
    const males = (ex) => ex.seams.filter((s) => s.letter === 'A').map((s) => s.male);
    await exportSplit(S({ cuts: cuts(null), labels: false }), { name: 'chest' });
    let from = stages.length;
    let ex = await exportSplit(S({ cuts: cuts('snap'), labels: false }), { name: 'chest' });
    expect(stages.slice(from)).toContain('Fitting the lip…');
    expect(stages.slice(from)).not.toContain('Cutting into pieces…');
    expect(males(ex)).toEqual([2, 1]);
    from = stages.length;
    ex = await exportSplit(S({ cuts: cuts('lift'), labels: false }), { name: 'chest' });
    expect(stages.slice(from)).not.toContain('Cutting into pieces…');
    expect(ex.seams.find((s) => s.letter === 'A').apart).toMatchObject({ hold: 'lift', lip: true, clips: 0 });
    await exportSplit(S({ cuts: cuts('snap'), labels: false }), { name: 'chest' });
    // 100 mm tall, the printer has no room for the box halves with the lip on them, though they lie as before: the
    // lids carry it, lying on their tops
    from = stages.length;
    ex = await exportSplit(S({ cuts: cuts('snap'), labels: false }), { name: 'chest', bed: [210, 210, 100] });
    expect(stages.slice(from)).not.toContain('Cutting into pieces…');
    expect(males(ex)).toEqual([4, 3]);
    expect(ex.pieces.map((p) => [p.down, p.lips.length, +p.size[2].toFixed(3)])).toEqual([['-z', 0, 95], ['-z', 0, 95], ['+z', 1, 31], ['+z', 1, 31]]);
  });

  it('a piece its lip stands up out of never carries pegs on the face it lies on', async () => {
    // a tub with 10 mm walls, glued with pegs at z 60 and coming apart at z 100: on a printer 65 mm tall the bottom
    // piece has no room for the pegs, but the middle one lies on that face, its lip standing up
    await load(own(cube([150, 100, 120], [0, 0, 60]).subtract(cube([130, 80, 100], [0, 0, 60]))), 'tub');
    const ex = await exportSplit(S({ cuts: [cutAt(2, 60, 'c1'), apartAt(2, 100, 'c2')], joint: 'pegs', labels: false }), { name: 'tub', bed: [210, 210, 65] });
    expect(ex.pieces[1]).toMatchObject({ down: '-z', lips: [{ letter: 'B', clips: 5 }], pegs: 0 });
    expect(ex.seams.find((s) => s.letter === 'A')).toMatchObject({ joint: 'pegs', male: 1 });
  });

  it('the fit test of a cut that comes apart is a small box and its lid with the same lip', async () => {
    await lantern();
    const r = await client.fitTest([], version, { printing, split: S({ cuts: [apartAt(2, 190)] }), bed: BED, name: 'lantern' });
    // the lantern's other joints are none: no pin blocks
    expect(r).toMatchObject({ apart: 'snap', pins: false, pegs: false, dovetail: false });
    const bodies = own(solidOfStl(r.stl)).decompose().map(own).map((m) => boxOf(m).size.map((v) => +v.toFixed(3)));
    expect(bodies.sort((p, q) => q[2] - p[2])).toEqual([[60, 30, 18], [60, 30, 12]]);
    // a cut too near the roof gets a 4.5 mm lip with no clips: its coupon lifts off as the lip does, though Clicks on
    // was asked for – a coupon that clicks would tune a catch the model hasn't got
    const short = await client.fitTest([], version, { printing, split: S({ cuts: [apartAt(2, 192)] }), bed: BED, name: 'lantern' });
    const lifts = await client.fitTest([], version, { printing, split: S({ cuts: [apartAt(2, 190, 'c1', 'lift')] }), bed: BED, name: 'lantern' });
    expect(short.apart).toBe('lift');
    expect(short.triangles).toBe(lifts.triangles);
    expect(short.triangles).toBeLessThan(r.triangles);
    // a cut through the windows has no lip to try: nothing to print
    const none = await client.fitTest([], version, { printing, split: S({ cuts: [apartAt(2, 100)] }), bed: BED, name: 'lantern' });
    expect(none).toMatchObject({ stl: null, apart: null });
    // without the model the settings say: the pins Auto would use, and the box and lid held as the cut is set
    const settings = await client.call('split.fitTest', { split: S({ cuts: [apartAt(2, 190, 'c1', 'light')] }), printing, name: 'lantern' });
    expect(settings).toMatchObject({ apart: 'light', pins: true });
    expect(own(solidOfStl(settings.stl)).decompose().map(own)).toHaveLength(5);
  });

  it('a thin sign\'s cut that comes apart keeps unglued dovetail tabs', async () => {
    await load(cube([360, 100, 4]), 'sign');
    const ex = await exportSplit(S({ cuts: [apartAt(0, 0)], labels: false }), { name: 'sign' });
    expect(ex.seams).toEqual([expect.objectContaining({ joint: 'dovetail', tabs: 2, apart: expect.objectContaining({ hold: 'snap', lip: false, tabs: 2 }) })]);
    expect(codes(ex)).toEqual(['SPLIT', 'DOVETAIL']);
    expect(noteOf(ex, 'DOVETAIL')).toMatchObject({
      apart: true,
      text: 'Cut A goes through a thin plate, so it comes apart on 2 dovetail tabs – lay both pieces flat and lower piece 2 onto piece 1; lift it off again to take it apart. Don\'t glue it.',
    });
    expect(ex.assembly).toEqual(['Do not glue cut A: it comes apart. Lay pieces 1 and 2 flat and lower piece 2\'s tabs into piece 1; lift it out to take it apart.']);
  });

  it('walls too thin for a lip: the top just rests on the piece below, and the notes and the sheet say so', async () => {
    // a tower with 2.5 mm walls
    await load(own(cube([80, 80, 120], [0, 0, 60]).subtract(cube([75, 75, 120], [0, 0, 62]))), 'tower');
    const ex = await exportSplit(S({ cuts: [apartAt(2, 90)], labels: false }), { name: 'tower' });
    expect(ex.seams).toEqual([expect.objectContaining({ joint: 'none', apart: expect.objectContaining({ lip: false, faces: 0, flat: 1 }) })]);
    expect(codes(ex)).toEqual(['SPLIT', 'APART_FLAT']);
    expect(noteOf(ex, 'APART_FLAT')).toMatchObject({
      why: 'thin', text: 'Cut A has no room for a lip – its walls are under 2.7 mm thick – so the top just rests on piece 1, with nothing to line it up or hold it.',
    });
    expect(ex.assembly).toEqual(['Do not glue cut A: it comes apart. Set the top on piece 1 and line the edges up – nothing holds it.']);
    expect(ex.pieces.map((p) => [p.lips, p.lids])).toEqual([[[], []], [[], []]]);
  });

  it('splitting with cuts that come apart again and again leaves no solids behind', async () => {
    await lantern();
    /** Every way through a split: the pieces view, the measure, the download, a fit test and Fit to my printer. */
    const round = async (i) => {
      const split = S({ cuts: [apartAt(2, 189 + (i % 4), 'c1', APART_HOLDS[i % APART_HOLDS.length])], labels: false });
      await resultSplit(split);
      await client.planSplit([], version, { printing, split, bed: BED, mode: 'measure' });
      await exportSplit(split, { name: 'lantern', archive: 'zip' });
      await client.fitTest([], version, { printing, split, bed: BED, name: 'lantern' });
      await client.planSplit([], version, { printing, split, bed: MINI, mode: 'fit' });
    };
    await round(0);
    const watch = trackSolids();
    try {
      await round(1);
      await round(2);
      const settled = watch.live();
      for (let i = 3; i < 9; i++) await round(i);
      expect(watch.made()).toBeGreaterThan(500);
      expect(watch.live()).toBeLessThanOrEqual(settled);
    } finally {
      watch.stop();
    }
  });
});

describe('placing a cut that comes apart', () => {
  const lantern = () => load(own(lanternSolid()), 'lantern');
  const options = (extra = {}) => ({ printing, split: SPLIT_DEFAULTS, ...extra });
  const probe = (at, extra = {}, items = []) => client.probeCut(items, version, options({ axis: 'z', at, ...extra }));
  const spots = (extra = {}, items = []) => client.cutSpots(items, version, options({ axis: 'z', ...extra }));
  const targets = (extra = {}) => client.cutTargets([], version, options({ axis: 'z', ...extra }));
  const apartAt = (at, hold = 'lock') => ({ ...cutAt(2, at), joint: 'apart', hold });

  it('finds the lantern\'s seams on its own corners: where the walls start, the windows begin, the posts, the windows end and the eaves', async () => {
    await lantern();
    const t = await targets();
    expect(t).toMatchObject({ axis: 'z', lo: 0, hi: 291, notes: [], estimate: true });
    expect(t.seams.map((s) => [s.at, s.kind])).toEqual([[4, 'walls'], [40, 'opens'], [150, 'widens'], [160, 'closes'], [200, 'widens']]);
    // the eaves move the outline most: the tower's ring gives way to the roof's
    expect(t.seams.find((s) => s.at === 200).shift).toBeGreaterThan(3);
    expect((await targets({ axis: 'x' })).seams.length).toBeGreaterThan(0);
  });

  it('suggests the lantern\'s roof base first: a full lip with 4 clips under the eaves\' ledge, its top coming off', async () => {
    await lantern();
    const r = await spots();
    expect(r.notes).toEqual([]);
    const [best, ...rest] = r.spots;
    expect(Math.abs(best.at - 190.5)).toBeLessThanOrEqual(0.5);
    expect(best).toMatchObject({ axis: 'z', lip: { H: 6, clips: 4 }, islands: 1, seam: 200, comesOff: { side: 1 } });
    expect(best.why).toMatch(/ledge/);
    expect(best.comesOff.length).toBeCloseTo(291 - best.at, 6);
    expect(best.comesOff.fraction).toBeGreaterThan(0.2);
    expect(best.comesOff.fraction).toBeLessThan(0.35);
    // best first, 8 mm apart, at most 5, and none through the windows (their posts are too small for a lip) nor up the roof
    expect(r.spots.length).toBeLessThanOrEqual(5);
    expect(r.spots.map((s) => s.score)).toEqual([...r.spots.map((s) => s.score)].sort((p, q) => q - p));
    for (const s of rest) expect(r.spots.filter((x) => Math.abs(x.at - s.at) < 8)).toHaveLength(1);
    expect(r.spots.filter((s) => (s.at > 40 && s.at < 160) || s.at > 200)).toEqual([]);
    // each one has its lip there, as the download makes it
    for (const s of r.spots) expect((await probe(s.at)).lip).toMatchObject({ H: 6, clips: 4 });
    const ex = await exportSplit(S({ cuts: [apartAt(best.at)] }), { name: 'lantern' });
    expect(ex.seams[0].apart).toMatchObject({ lip: true, clips: 4, height: 6 });
  });

  it('a box whose lid overhangs: the spot is at the lid\'s seam, the lid carrying the lip', async () => {
    await load(own(lidBoxSolid()), 'box');
    expect((await targets()).seams.map((s) => [s.at, s.kind])).toEqual([[4, 'walls'], [50, 'widens'], [56, 'top']]);
    const r = await spots();
    expect(r.spots).toHaveLength(1);
    const [spot] = r.spots;
    expect(Math.abs(spot.at - 50)).toBeLessThanOrEqual(0.5);
    expect(spot).toMatchObject({ why: 'under a ledge where the shape widens', lip: { H: 6, clips: 4 }, comesOff: { side: 1 } });
    // the download agrees: the lid, which stands on its top, carries the lip
    const ex = await exportSplit(S({ cuts: [apartAt(spot.at)] }));
    expect(ex.seams[0]).toMatchObject({ male: 2, apart: { lip: true, clips: 4, height: 6 } });
  });

  it('a solid block has no seams, so no spots', async () => {
    await load(cube([60, 60, 80], [0, 0, 40]), 'block');
    expect((await targets()).seams).toEqual([]);
    expect(await spots()).toMatchObject({ spots: [], seams: [], notes: [] });
    // a cut tried in it still gets its lip, a channel round a core
    expect((await probe(40)).lip).toMatchObject({ H: 6 });
    expect(await probe(100)).toMatchObject({ area: 0, islands: 0, lip: null, noLip: 'miss', comesOff: null });
  });

  it('a spot through the posts of a loggia ranks below the roof\'s base', async () => {
    await load(own(loggiaSolid()), 'loggia');
    const r = await spots();
    expect(r.spots[0]).toMatchObject({ at: 220.5, islands: 1, why: 'under a ledge where the shape widens', lip: { H: 6 } });
    const posts = r.spots.filter((s) => s.islands === 4);
    expect(posts.length).toBeGreaterThan(0);
    for (const s of posts) {
      expect(s.at).toBeGreaterThan(100);
      expect(s.at).toBeLessThan(180);
      expect(s.score).toBeLessThan(r.spots[0].score - 1.5);
    }
  });

  // a box 80 × 80 × 60 (3 mm walls, a flush top) with its lid line modelled as a groove 1 mm deep and `h` tall round
  // it at z 45
  // (`at` the groove's middle, `top` the box's height, `w` its width along X)
  const grooveBox = (h = 1, { at = 45, top = 60, w = 80 } = {}) => {
    const { Manifold } = wasm;
    const outer = own(Manifold.cube([w, 80, top])).translate([-w / 2, -40, 0]);
    const hollow = own(Manifold.cube([w - 6, 74, top - 6])).translate([-w / 2 + 3, -37, 3]);
    const ring = own(own(Manifold.cube([w + 2, 82, h])).translate([-w / 2 - 1, -41, at - h / 2])).subtract(own(own(Manifold.cube([w - 2, 78, h + 2])).translate([-w / 2 + 1, -39, at - 1 - h / 2])));
    return own(own(own(outer).subtract(own(hollow))).subtract(own(ring)));
  };
  // a 100 mm square tower (4 mm walls and floor) with a hollow pyramid roof flush with its walls at z 200, apex at 260
  const flushTower = () => {
    const { Manifold } = wasm;
    const pyramid = (half, z0, h) => own(Manifold.hull([[-half, -half, z0], [half, -half, z0], [half, half, z0], [-half, half, z0], [0, 0, z0 + h]]));
    const tower = own(own(box([-50, -50, 0], [50, 50, 200])).subtract(own(box([-46, -46, 4], [46, 46, 201]))));
    const drop = 4 * Math.sqrt(1 + (50 / 60) ** 2) * (60 / 50);
    const roof = own(pyramid(50, 200, 60).subtract(own(pyramid(50, 200 - drop, 60).intersect(own(box([-60, -60, 199.999], [60, 60, 300]))))));
    return own(tower.add(roof));
  };
  /** A solid of revolution round Z: `rings` [z, r] from the bottom up, and a hollow `wall` mm in from it above `floor`. */
  const turned = (outline, inside) => {
    const { Manifold } = wasm;
    const body = (rings) => own(Manifold.union(rings.slice(1).map(([z, r], k) => own(own(Manifold.cylinder(z - rings[k][0], rings[k][1], r, 96)).translate([0, 0, rings[k][0]])))));
    return own(body(outline).subtract(body(inside)));
  };

  it('offers the Gothic lantern\'s roof base, and never a spot that leaves a thin plate of its gargoyles', async () => {
    for (const roof of ['hollow', 'solid']) {
      await load(own(gothicSolid({ roof })), `gothic-${roof}`);
      const r = await spots();
      // where the roof's eaves step in at 174: a full lip with clips, the roof coming off; the hollow roof's comes first
      expect([roof, r.spots.find((s) => s.at === 174.5)]).toMatchObject([roof, { lip: { H: 6, clips: 4 }, islands: 1, seam: 174, why: 'at a ledge where the shape narrows' }]);
      if (roof === 'hollow') expect(r.spots[0].at).toBe(174.5);
      // the gargoyles stand out from 150 to 162: no spot between, and the one under them keeps them whole
      expect([roof, r.spots.filter((s) => s.at > 150 && s.at < 162)]).toEqual([roof, []]);
      expect([roof, r.spots.find((s) => s.at === 149.5)]).toMatchObject([roof, { why: 'under a ledge where the shape widens', lip: { clips: 4 } }]);
    }
    // the download agrees with the roof's spot
    expect((await exportSplit(S({ cuts: [apartAt(174.5)] }))).seams[0].apart).toMatchObject({ lip: true, clips: 4, height: 6 });
  });

  it('finds a lid line modelled as a groove round the box, and suggests the spot just over it', async () => {
    for (const [h, at] of [[1, 46], [1.5, 46.5]]) {
      await load(grooveBox(h), 'groove');
      expect((await targets()).seams.map((s) => [s.at, s.kind])).toEqual([[3, 'walls'], [45 - h / 2, 'narrows'], [45 + h / 2, 'widens'], [57, 'top']]);
      const [best] = (await spots()).spots;
      expect([h, best]).toMatchObject([h, { at, why: 'above a groove', lip: { H: 6, clips: 4 }, comesOff: { side: 1, length: 60 - at } }]);
    }
    expect((await exportSplit(S({ cuts: [apartAt(46.5)] }))).seams[0].apart).toMatchObject({ lip: true, clips: 4, height: 6 });
  });

  it('a roof flush with its walls and a jar\'s shoulder are seams where the sides bend, with spots beside them', async () => {
    await load(flushTower(), 'flush');
    expect((await targets()).seams.map((s) => [s.at, s.kind])).toEqual([[4, 'walls'], [200, 'slopes']]);
    const [roof] = (await spots()).spots;
    expect(roof).toMatchObject({ at: 190.5, seam: 200, why: 'below where the sides start to slope', lip: { H: 6, clips: 4 }, comesOff: { side: 1, length: 69.5 } });
    // a jar: its body up to 100, a shoulder narrowing to its neck at 120, the neck to 145; round, so it lifts off
    await load(turned([[0, 45], [100, 45], [120, 18], [145, 18]], [[3, 42], [100, 42], [120, 15], [146, 15]]), 'jar');
    expect((await targets()).seams.map((s) => [s.at, s.kind])).toEqual([[3, 'walls'], [100, 'slopes'], [120, 'straightens']]);
    const jar = (await spots({ hold: 'lift' })).spots;
    expect(jar.map((s) => [s.at, s.why, s.lip.H])).toEqual([[90.5, 'below where the sides start to slope', 6], [120.5, 'above where the sides straighten', 6]]);
    // a dome rising from straight sides turns gradually: no bend there
    await load(turned([[0, 30], [60, 30], ...Array.from({ length: 30 }, (_, k) => [60 + 30 * Math.sin(((k + 1) * Math.PI) / 60), 30 * Math.cos(((k + 1) * Math.PI) / 60)])], [[3, 27], [60, 27]]), 'dome');
    expect((await targets()).seams.map((s) => s.kind)).not.toContain('slopes');
  });

  it('a box lying on its side offers its lid as it does standing: the lid comes off, first', async () => {
    await load(own(lidBoxSolid()), 'box');
    const [upright] = (await spots()).spots;
    expect(upright).toMatchObject({ at: 49.5, comesOff: { side: 1, length: 10.5 } });
    for (const [turn, side] of [[[0, 90, 0], 1], [[0, -90, 0], -1]]) {
      await load(own(own(lidBoxSolid()).rotate(turn)), 'lying');
      const [best] = (await spots({ axis: 'x' })).spots;
      expect([turn, best]).toMatchObject([turn, { axis: 'x', at: side * 49.5, lip: { H: 6, clips: 4 }, comesOff: { side, length: 10.5 } }]);
      expect(best.comesOff.fraction).toBeLessThan(0.4);
    }
  });

  it('never offers a spot whose flaws outweigh its lip: the hollow Gothic roof\'s fretwork, Lifts off', async () => {
    await load(own(gothicSolid({ roof: 'hollow' })), 'gothic');
    const r = await spots({ hold: 'lift' });
    expect(r.spots.length).toBeGreaterThan(2);
    for (const s of r.spots) expect([s.at, s.score > 0, s.islands]).toEqual([s.at, true, 1]);
  });

  it('a seam where only the walls thicken inside is said so, not a ledge', async () => {
    await load(own(loggiaSolid()), 'loggia');
    expect((await targets()).seams.find((s) => s.at === 140)).toMatchObject({ kind: 'thickens' });
    const r = await spots();
    expect(r.spots.filter((s) => s.seam === 140).map((s) => s.why)).toEqual(['below where the walls thicken']);
    expect(r.spots.filter((s) => /ledge/.test(s.why)).map((s) => s.seam)).toEqual([230]);
  });

  it('a round lantern takes no clips anywhere: the spots for Locks are where a full lip fits, and a move says what it gives', async () => {
    // a tube r 50/46 with eight windows from z 30 to 120, eaves r 56 from 150 to 156 and a dome over them
    const { Manifold } = wasm;
    const tube = turned([[0, 50], [150, 50]], [[4, 46], [151, 46]]);
    const windows = own(Manifold.union(Array.from({ length: 8 }, (_, k) => own(own(own(Manifold.cube([20, 16, 90], true)).translate([50, 0, 75])).rotate([0, 0, k * 45])))));
    const eaves = turned([[150, 56], [156, 56]], [[149, 46], [157, 46]]);
    const half = own(own(Manifold.cube([200, 200, 100], true)).translate([0, 0, 206]));
    const dome = own(own(own(own(Manifold.sphere(54, 96)).translate([0, 0, 156])).subtract(own(own(Manifold.sphere(50, 96)).translate([0, 0, 156])))).intersect(half));
    await load(own(Manifold.union([own(tube.subtract(windows)), eaves, dome])), 'round');
    const r = await spots();
    expect(r.spots.length).toBeGreaterThan(0);
    for (const s of r.spots) expect([s.at, s.lip]).toEqual([s.at, { H: 6, clips: 0 }]);
    expect(r.spots[0]).toMatchObject({ at: 146.5, why: 'under a ledge where the shape widens' });
    // short of a full lip, the move is for a taller one, not for clips
    expect(await probe(147)).toMatchObject({ lip: { H: 4.5, clips: 0 }, suggestedAt: 146.5, suggestedLip: { H: 6, clips: 0 } });
    await lantern();
    expect(await probe(192)).toMatchObject({ suggestedAt: 190.5, suggestedLip: { H: 6, clips: 4 } });
  });

  it('the user\'s round lantern: its roof\'s rim comes first, slim or none; the tips of its narrow windows are no line to hide in', async () => {
    for (const eaveR of [50, 47, 0]) {
      await load(own(roundLanternSolid({ eaveR })), `round-${eaveR}`);
      const r = await spots();
      // where the roof stands on the body, its eave ring 5 mm or 2 mm over it or none: a lip without clips under it
      expect([eaveR, r.spots[0]]).toMatchObject([eaveR, { seam: 148, why: 'under a ledge where the shape widens', lip: { H: 6, clips: 0 }, islands: 1 }]);
      // over the windows' pointed tips the outline the outside shows does not move: a spot there gets nothing for it
      const tips = r.spots.find((s) => Math.abs(s.seam - 124.66) < 0.01);
      if (tips) expect(tips.score).toBeLessThan(r.spots[0].score - 1);
    }
  });

  it('just over the tips of a row of windows the tongue comes in stretches: the spot there is half a step higher, where it is whole', async () => {
    await load(own(roundLanternSolid({ eaveR: 47 })), 'round');
    expect((await probe(125)).lip).toMatchObject({ H: 6, clips: 0, why: 'edge', broken: true });
    expect((await probe(125.5)).lip).toEqual({ H: 6, clips: 0, why: 'short' });
    for (const hold of ['lock', 'lift']) {
      const tips = (await spots({ hold })).spots.find((s) => Math.abs(s.seam - 124.66) < 0.01);
      expect([hold, tips]).toMatchObject([hold, { at: 125.5, why: 'above the openings', lip: { H: 6 } }]);
    }
  });

  it('a slender tower\'s top would stand on its small flat roof to carry a lip: the probe and the spots say the lip the download makes', async () => {
    await load(own(slenderTowerSolid()), 'slender');
    const lipOf = (p) => (p.lip ? { H: p.lip.H, clips: p.lip.clips } : null);
    const madeOf = async (at) => {
      const a = (await exportSplit(S({ cuts: [apartAt(at)] }))).seams[0].apart;
      return a.lip ? { H: a.height, clips: a.clips } : null;
    };
    for (const at of [31, 35, 39.5]) expect([at, lipOf(await probe(at))]).toEqual([at, await madeOf(at)]);
    const r = await spots();
    expect(r.spots.length).toBeGreaterThan(0);
    for (const s of r.spots) expect([s.at, s.lip]).toEqual([s.at, await madeOf(s.at)]);
  });

  it('on a small round part Locks offers the full lip without clips that Lifts off finds, though no island there is wide enough for a clip', async () => {
    // a pawn: a base r 18, a body narrowing to r 7 at z 30, a collar r 11 to 33, a neck and a ball for a head
    const { Manifold } = wasm;
    const frustum = ([z0, r0], [z1, r1]) => own(own(Manifold.cylinder(z1 - z0, r0, r1, 96)).translate([0, 0, z0]));
    const outline = [[0, 18], [4, 18], [6, 16], [12, 12], [30, 7]];
    const body = outline.slice(1).map((ring, k) => frustum(outline[k], ring));
    const head = own(own(Manifold.sphere(9, 96)).translate([0, 0, 44]));
    await load(own(Manifold.union([...body, frustum([30, 11], [33, 11]), frustum([33, 6], [37, 6]), head])), 'pawn');
    const lifted = (await spots({ hold: 'lift' })).spots;
    const locked = (await spots({ hold: 'lock' })).spots;
    expect(lifted.length).toBeGreaterThan(0);
    expect(locked.map((s) => [s.at, s.lip])).toEqual(lifted.map((s) => [s.at, { H: 6, clips: 0 }]));
    expect((await exportSplit(S({ cuts: [apartAt(locked[0].at)] }))).seams[0].apart).toMatchObject({ lip: true, height: 6, clips: 0 });
  });

  it('two separate parts side by side: where the shorter one ends is no seam of the taller, whose lid line comes first', async () => {
    // canisters with lids overhanging them, 80 mm tall (the lid from 60) and 50 mm (the lid from 35), closed 3 mm thick
    const { Manifold } = wasm;
    const can = (x, h, lid) => own(Manifold.union([
      own(own(box([x - 25, -25, 0], [x + 25, 25, lid + 0.5])).subtract(own(box([x - 22, -22, 3], [x + 22, 22, h - 3])))),
      own(own(box([x - 26, -26, lid], [x + 26, 26, h])).subtract(own(box([x - 22, -22, 3], [x + 22, 22, h - 3])))),
    ]));
    await load(own(Manifold.union([can(-35, 80, 60), can(35, 50, 35)])), 'two');
    const t = await targets();
    expect(t.seams.filter((s) => Math.abs(s.at - 50) < 0.5)).toEqual([]);
    // where the short one closes over is its top, not where openings end
    expect(t.seams.find((s) => Math.abs(s.at - 47) < 0.5)).toMatchObject({ kind: 'top' });
    const r = await spots();
    expect(r.spots[0]).toMatchObject({ at: 59.5, seam: 60, why: 'under a ledge where the shape widens' });
    expect(r.spots.filter((s) => /openings/.test(s.why))).toEqual([]);
  });

  it('a lid groove on a box taller than 200 mm is found though it falls between two samples, and so is its spot', async () => {
    await load(grooveBox(1, { at: 201, top: 240, w: 120 }), 'tall');
    expect((await targets()).seams.map((s) => [s.at, s.kind])).toEqual([[3, 'walls'], [200.5, 'narrows'], [201.5, 'widens'], [237, 'top']]);
    const near = (await spots()).spots.filter((s) => Math.abs(s.at - 201) < 3);
    expect(near).toMatchObject([{ why: expect.stringMatching(/groove/), lip: { H: 6, clips: 4 } }]);
  });

  it('a groove whose first step under it has no lip: the next step is tried before a place 10 mm away, which is never offered', async () => {
    for (const at of [45.8, 45.9]) {
      await load(grooveBox(1, { at }), 'groove');
      const r = await spots();
      expect([at, r.spots.filter((s) => /groove/.test(s.why) && Math.abs(s.at - s.seam) > 3)]).toEqual([at, []]);
      expect([at, r.spots[0]]).toMatchObject([at, { why: 'above a groove', lip: { H: 6, clips: 4 } }]);
    }
    // 0.8 mm under the groove at 45.8 the lip is full, where the step just under it has no room
    expect((await probe(44.5)).lip).toMatchObject({ H: 6, clips: 4 });
  });

  it('at clearance 0.3 a ledge at the very end of the groove\'s reach is read as the download reads it', async () => {
    await load(own(gothicSolid({ roof: 'hollow' })), 'gothic');
    const split = { ...SPLIT_DEFAULTS, clearance: 0.3 };
    // 174.5 + 9.5 is the underside of the roof's shelf, at 184
    const p = await probe(174.5, { split });
    expect(p).toMatchObject({ lip: { H: 4.5, clips: 0, why: 'height' }, suggestedAt: 174 });
    expect(noteOf(await exportSplit({ ...split, cuts: [apartAt(174.5)] }), 'APART_NO_CLIPS')).toMatchObject({ why: 'height', height: 4.5, suggestedAt: 174 });
    for (const s of (await spots({ split })).spots) expect([s.at, (await exportSplit({ ...split, cuts: [apartAt(s.at)] })).seams[0].apart]).toMatchObject([s.at, { lip: true, height: s.lip.H, clips: s.lip.clips }]);
  });

  it('spots are looked for a slice of time at a time: a probe asked meanwhile is answered first, and they are the spots found in one go', async () => {
    await load(own(roundLanternSolid()), 'round');
    await targets();
    const order = [];
    const found = spots().then((r) => {
      order.push('spots');
      return r;
    });
    const tried = probe(142.5).then((r) => {
      order.push('probe');
      return r;
    });
    const [r, p] = await Promise.all([found, tried]);
    expect(order).toEqual(['probe', 'spots']);
    expect(p).toMatchObject({ at: 142.5, lip: { H: 6, clips: 0 } });
    const whole = await client.call('split.plan', { items: [], baseVersion: version, ...options({ axis: 'z', hold: 'lock' }), mode: 'spots' });
    expect(r.spots).toEqual(whole.spots);
  });

  it('tries a cut as the download makes it: a full lip at 190, a short one at 192, none at 196, and where the notes move it', async () => {
    await lantern();
    const at190 = await probe(190);
    expect(at190).toMatchObject({ axis: 'z', at: 190, area: 1728, islands: 1, lip: { H: 6, clips: 4, why: null }, noLip: null, suggestedAt: null, crosses: [] });
    expect(at190.comesOff).toEqual({ side: 1, length: 101, fraction: expect.any(Number) });
    expect((await exportSplit(S({ cuts: [apartAt(190)] }))).seams[0].apart).toMatchObject({ lip: true, clips: 4, height: 6 });
    const at192 = await probe(192);
    expect(at192).toMatchObject({ lip: { H: 4.5, clips: 0, why: 'height' }, noLip: null, suggestedAt: 190.5 });
    expect(noteOf(await exportSplit(S({ cuts: [apartAt(192)] })), 'APART_NO_CLIPS')).toMatchObject({ why: 'height', height: 4.5, suggestedAt: 190.5 });
    const at196 = await probe(196);
    expect(at196).toMatchObject({ lip: null, noLip: 'room', suggestedAt: 190.5, comesOff: { side: 1, length: 95 } });
    expect(noteOf(await exportSplit(S({ cuts: [apartAt(196)] })), 'APART_FLAT')).toMatchObject({ why: 'room', suggestedAt: 190.5 });
    // through the windows the faces are too small; Lifts off wants no clips; and the seams come with every answer
    expect(await probe(100)).toMatchObject({ islands: 8, lip: null, noLip: 'small' });
    expect(await probe(190, { hold: 'lift' })).toMatchObject({ lip: { H: 6, clips: 0, why: null }, suggestedAt: null });
    expect(at196.seams.map((s) => s.at)).toEqual([4, 40, 150, 160, 200]);
  });

  it('a later probe replaces one still waiting, and never a measure or the spots', async () => {
    await lantern();
    const split = S({ cuts: [apartAt(190)] });
    const asked = [
      client.planSplit([], version, { printing, split, bed: BED, mode: 'measure' }),
      probe(185), probe(186), probe(187),
      spots(),
    ];
    const [measured, first, waiting, last, found] = await Promise.all(asked);
    expect(measured.cuts[0]).toMatchObject({ id: 'c1', joint: 'lip' });
    expect(first).toMatchObject({ at: 185, lip: { clips: 4 } });
    expect(waiting).toBeUndefined();
    expect(last).toMatchObject({ at: 187, lip: { clips: 4 } });
    expect(found.spots[0].at).toBe(190.5);
  });

  it('never builds the final result, and says which letters a cut would run through', async () => {
    await lantern();
    const word = createItem({ text: 'LANTERN', fontId: 'inter', size: 12, depth: 1.5, position: [0, -50, 190], normal: [0, -1, 0] });
    const p = await probe(190, {}, [word]);
    expect(p).toMatchObject({ estimate: true, crosses: [word.id], lip: { H: 6, clips: 4 } });
    expect((await probe(170, {}, [word])).crosses).toEqual([]);
    expect((await client.call('ping', {})).caches.result).toBe(0);
    // the spot under the eaves would run through the letters: it is tried again just clear of them, under them, where
    // the lip is as good, and that is the spot offered
    const found = (await spots({}, [word])).spots;
    expect(found.map((s) => [s.at, s.crosses ?? []])).toEqual([[183.5, []], [160.5, []], [30.5, []]]);
    expect(found[0]).toMatchObject({ lip: { H: 6, clips: 4 }, seam: 200, why: 'under a ledge where the shape widens' });
    expect((await probe(183.5, {}, [word])).crosses).toEqual([]);
    // letters too tall to step clear of within 20 mm of the eaves: the spot through them is still offered, and says so
    const tall = createItem({ text: 'LANTERN', fontId: 'inter', size: 30, depth: 1.5, position: [0, -50, 185], normal: [0, -1, 0] });
    const through = (await spots({}, [tall])).spots.find((s) => s.seam === 200);
    expect(through).toMatchObject({ at: 190.5, crosses: [tall.id] });
    // once the result is built the probe uses it
    await resultSplit(SPLIT_DEFAULTS, { items: [word] });
    expect((await probe(170, {}, [word])).estimate).toBeUndefined();
  });

  it('a dense lantern is read in moments, and a cut tried again near one tried before answers at once', async () => {
    const dense = own(own(lanternSolid()).refine(16));
    expect(dense.numTri()).toBeGreaterThan(200_000);
    await load(dense, 'dense');
    let t0 = performance.now();
    const r = await spots();
    const spotsMs = performance.now() - t0;
    expect(r.spots.map((s) => [s.at, s.lip.clips])).toEqual([[190.5, 4], [160.5, 4], [30.5, 4]]);
    const times = [];
    for (const at of [190, 192, 196, 191, 189.5, 175]) {
      t0 = performance.now();
      const p = await probe(at);
      times.push(performance.now() - t0);
      if (at === 192) expect(p).toMatchObject({ lip: { H: 4.5, clips: 0 }, suggestedAt: 190.5 });
    }
    // about 0.6 s and 40 ms each on the machine this was written on
    expect(spotsMs).toBeLessThan(4000);
    expect(Math.max(...times)).toBeLessThan(400);
  });

  it('trying cuts keeps a bounded number of slices, lets them go with the model, and leaves no solids behind', async () => {
    const aimed = async () => (await client.call('ping', {})).caches.aim;
    const round = async (i) => {
      for (let k = 0; k < 40; k++) await probe(150 + k * 1.3 + i * 0.1);
      await spots();
      await targets({ axis: 'x' });
    };
    await lantern();
    await round(0);
    // never more than 640 slices kept
    expect(await aimed()).toBe(640);
    const watch = trackSolids();
    try {
      // what stays alive is the kept slices (the older ones going as newer come) and the X axis's copy of the model
      for (let i = 1; i < 6; i++) {
        await round(i);
        expect(watch.live()).toBeLessThanOrEqual(640 + 4);
      }
      expect(watch.made()).toBeGreaterThan(5000);
      expect(await aimed()).toBe(640);
      // and none of the lantern's once another model is loaded
      const kept = watch.live();
      await load(cube([20, 20, 20]), 'small');
      expect(await aimed()).toBe(0);
      expect(watch.live()).toBeLessThan(kept - 300);
    } finally {
      watch.stop();
    }
  });
});
