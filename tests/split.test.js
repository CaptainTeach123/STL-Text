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
import { SPLIT_DEFAULTS, cellSizes, isSymmetric, sizesFor } from '../src/split.js';
import { clearSplitCaches, dowelHole, halfHole, pinAt, pinSolid } from '../src/splitGeometry.js';
import { setup, soupOf as soupGeometry } from './helpers.js';

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
      expect(m.volume()).toBeCloseTo(72000 - 2 * 209.945, 0);
    }
    // the volume each half-hole takes out of the solid, from the shape itself
    const above = cube([100, 100, 100], [0, 0, 50]);
    expect(overlap(own(halfHole({ R: 2.65, h: 8.5, ch: 0.5 })), above)).toBeCloseTo(209.945, 2);
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
    // a teardrop hole takes 372.735 mm³ from each side, a round one would take 348.232
    for (const f of piecesOf(ex)) expect(volumeOfStl(f.stl)).toBeCloseTo(120000 - 2 * 372.735, 0);
    // the pins fit one way only: turned half round, the face would not match
    expect(isSymmetric(seam.dowels.map((d) => [d.centre[1], d.centre[2]]), [0, 0], 3)).toBe(false);
    expect(noteOf(ex, 'SPLIT').text).toBe('Cut into 2 pieces with 2 pins Ø6 × 19 mm.');
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
    expect(holes).toBeCloseTo(4 * 372.735, 1);
    const pieces = piecesOf(ex).reduce((s, f) => s + volumeOfStl(f.stl), 0);
    expect(pieces + holes).toBeCloseTo(solid.volume(), 0);
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
