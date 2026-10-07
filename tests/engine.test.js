import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Matrix4 } from 'three';
import { createEngine, passthroughRangesOf } from '../src/engine.js';
import { createEngineClient, createLocalWorker } from '../src/engineClient.js';
import { createItem } from '../src/document.js';
import { manifold } from '../src/manifold.js';
import { parseSTL, writeBinarySTL } from '../src/stl.js';
import { geometryToManifold } from '../src/mesh.js';
import { setup, soupOf as soupGeometry } from './helpers.js';

const soupOf = (solid, opts) => soupGeometry(solid, opts).attributes.position.array;

const fontBytes = (pkg, file) => {
  const buf = fs.readFileSync(path.resolve('node_modules/@fontsource', pkg, 'files', file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

let wasm;
let engine;
let client;
let version = 0;
const progress = [];

/** Worker-like round trip (structured clone both ways) through the local worker. */
function newClient(e = engine) {
  const fatal = [];
  const c = createEngineClient({
    createWorker: () => createLocalWorker(Promise.resolve(e)),
    onProgress: (p) => progress.push(p.stage),
    onFatal: (err) => fatal.push(err),
  });
  c.fatal = fatal;
  return c;
}

const stlOf = (solid, opts) => writeBinarySTL(soupGeometry(solid, opts));
const volumeOfStl = (buffer) => {
  const m = geometryToManifold(parseSTL(buffer));
  const v = m.volume();
  m.delete();
  return v;
};
const topItem = (text, extra = {}) => createItem({ text, fontId: 'inter', position: [0, 0, 3], normal: [0, 0, 1], ...extra });

beforeAll(async () => {
  await setup();
  wasm = manifold();
  engine = createEngine({ wasm });
  client = newClient();
  await client.addFont('inter', fontBytes('inter', 'inter-latin-700-normal.woff'));
});

describe('fonts and errors', () => {
  it('parses fonts and reports labels; rejects bad bytes with a code', async () => {
    const r = await client.addFont('pacifico', fontBytes('pacifico', 'pacifico-latin-400-normal.woff'));
    expect(r.label).toMatch(/Pacifico/);
    // several fonts added at once all arrive (one scheduler channel per font)
    const many = await Promise.all([
      ['bebas', 'bebas-neue', 'bebas-neue-latin-400-normal.woff'],
      ['slab', 'roboto-slab', 'roboto-slab-latin-700-normal.woff'],
      ['orbitron', 'orbitron', 'orbitron-latin-700-normal.woff'],
    ].map(([id, pkg, file]) => client.addFont(id, fontBytes(pkg, file))));
    expect(many.map((m) => m.fontId)).toEqual(['bebas', 'slab', 'orbitron']);
    await expect(client.addFont('bad', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).rejects.toMatchObject({ code: 'FONT_INVALID' });
    await expect(client.addFont('woff2', new TextEncoder().encode('wOF2xxxxxxxx').buffer)).rejects.toMatchObject({ code: 'FONT_INVALID', message: /WOFF2/ });
  });

  it('answers unknown requests and unknown fonts with coded errors', async () => {
    await expect(client.call('nope', {})).rejects.toMatchObject({ code: 'INTERNAL' });
    await client.loadBase({ kind: 'sample', version: ++version });
    const item = topItem('Hi', { fontId: 'missing-font', position: [0, 0, 4] });
    await expect(client.preview(item, version)).rejects.toMatchObject({ code: 'FONT_MISSING' });
  });
});

describe('base loading', () => {
  it('loads the sample plaque with display buffers and a BVH', async () => {
    const r = await client.loadBase({ kind: 'sample', version: ++version });
    expect(r.info.size.map((v) => Math.round(v))).toEqual([70, 30, 4]);
    expect(r.info.watertight).toBe(true);
    expect(r.display.positions).toBeInstanceOf(Float32Array);
    expect(r.display.normals.length).toBe(r.display.positions.length);
    expect(r.display.index.length / 3).toBe(r.info.triangles);
    expect(r.display.bvhRoots.length).toBeGreaterThan(0);
    expect(r.display.bvhRoots[0]).toBeInstanceOf(ArrayBuffer);
    expect(r.display.passthroughStart).toBe(r.info.triangles);
  });

  it('loads an STL soup, repairs it and reports; a broken piece passes through', async () => {
    const box = wasm.Manifold.cube([40, 25, 15], true);
    const stl = stlOf(box, { flip: true, dropTriangles: 1 });
    const r = await client.loadBase({ kind: 'stl', bytes: stl, name: 'box', version: ++version });
    expect(r.info.watertight).toBe(true);
    expect(r.info.repaired).toBe(true);
    expect(r.report.summary).toMatch(/Repaired/);
    expect(r.info.size.map((v) => Math.round(v))).toEqual([40, 25, 15]);

    const loose = new Float32Array([100, 0, 0, 101, 0, 0, 100, 1, 0]);
    const soup = soupOf(box);
    const both = new Float32Array(soup.length + 9);
    both.set(soup);
    both.set(loose, soup.length);
    const r2 = await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(both), name: 'box2', version: ++version });
    expect(r2.info.passthroughTriangles).toBe(1);
    expect(r2.display.passthroughStart).toBe(r2.info.triangles - 1);
    expect(r2.report.summary).toMatch(/kept as-is/);
    box.delete();
  });

  it('marks the unrepaired triangles correctly even after the BVH reorders the index', async () => {
    const box = wasm.Manifold.cube([40, 25, 15], true);
    const loose = new Float32Array([-100, 0, 0, -99, 0, 0, -100, 1, 0]); // sorts to the FRONT of a spatial index
    const soup = soupOf(box);
    const both = new Float32Array(soup.length + 9);
    both.set(soup);
    both.set(loose, soup.length);
    const r = await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(both), name: 'loose', version: ++version });
    expect(r.display.passthroughRanges.reduce((n, [, c]) => n + c, 0)).toBe(1);
    for (const [start, count] of r.display.passthroughRanges) {
      for (let t = start; t < start + count; t++) {
        const v = r.display.index[t * 3];
        expect(r.display.positions[v * 3]).toBeLessThan(-98); // the loose triangle, wherever it ended up
      }
    }
    expect(passthroughRangesOf(new Uint32Array([0, 1, 2, 9, 10, 11, 3, 4, 5, 12, 13, 14, 15, 16, 17]), 9)).toEqual([[1, 1], [3, 2]]);
    box.delete();
  });

  it('rejects an unreadable file with STL_INVALID and keeps working', async () => {
    await expect(client.loadBase({ kind: 'stl', bytes: new ArrayBuffer(10), name: 'x', version: ++version })).rejects.toMatchObject({ code: 'STL_INVALID' });
    const r = await client.loadBase({ kind: 'sample', version: ++version });
    expect(r.info.watertight).toBe(true);
  });

  it('suggests unit and orientation fixes from the bounding box', async () => {
    const inch = wasm.Manifold.cube([2.8, 0.1, 1.1], true); // flat, thin along Y
    const r = await client.loadBase({ kind: 'stl', bytes: stlOf(inch), name: 'inch', version: ++version });
    expect(r.info.suggestions.map((s) => s.code)).toEqual(['INCHES', 'Y_UP']);
    inch.delete();
  });

  it('base.update re-derives from the original: transforms compose, simplify applies', async () => {
    const box = wasm.Manifold.cube([40, 25, 15], true);
    await client.loadBase({ kind: 'stl', bytes: stlOf(box), name: 'box', version: ++version });
    const scale = new Matrix4().makeScale(25.4, 25.4, 25.4).toArray();
    const rot = new Matrix4().makeRotationX(Math.PI / 2).toArray();
    const r = await client.updateBase({ version: ++version, transforms: [scale, rot], simplify: null });
    expect(r.info.size.map((v) => Math.round(v))).toEqual([1016, 381, 635]);
    expect(r.info.suggestions).toEqual([]);
    const back = await client.updateBase({ version: ++version, transforms: [], simplify: null });
    expect(back.info.size.map((v) => Math.round(v))).toEqual([40, 25, 15]);
    const dense = wasm.Manifold.sphere(20, 200);
    await client.loadBase({ kind: 'stl', bytes: stlOf(dense), name: 'ball', version: ++version });
    const simpler = await client.updateBase({ version: ++version, transforms: [], simplify: 0.05 });
    expect(simpler.info.triangles).toBeLessThan(dense.numTri());
    expect(simpler.info.triangles).toBeGreaterThan(100);
    box.delete();
    dense.delete();
  });
});

describe('preview', () => {
  it('returns conformed geometry, size, notes and matrix; blank text is empty', async () => {
    await client.loadBase({ kind: 'sample', version: ++version });
    const item = topItem('Hello', { position: [0, 0, 4] });
    const r = await client.preview(item, version);
    expect(r.geometry.positions).toBeInstanceOf(Float32Array);
    expect(r.geometry.index).toBeInstanceOf(Uint32Array);
    expect(r.size[1]).toBeCloseTo(10, 0);
    expect(r.matrix).toHaveLength(16);
    expect(r.stats.conformed).toBe(false); // flat plaque: no refinement
    expect(r.notes.map((n) => n.code)).toEqual([]);
    expect(await client.preview({ ...item, lines: [{ ...item.lines[0], text: '  ' }] }, version)).toEqual({ empty: true });
  });

  it('warns: thin strokes, cut-through, not touching, engrave on an unrepairable model', async () => {
    const tiny = await client.preview(topItem('Hello', { size: 3, position: [0, 0, 4] }), version);
    expect(tiny.notes.map((n) => n.code)).toContain('THIN_STROKES');
    const deep = await client.preview(topItem('Hi', { mode: 'engrave', depth: 6, position: [0, 0, 4] }), version);
    expect(deep.notes.find((n) => n.code === 'CUT_THROUGH')).toMatchObject({ suggestedDepth: expect.any(Number) });
    const floating = await client.preview(topItem('Hi', { position: [0, 0, 30] }), version);
    expect(floating.notes.map((n) => n.code)).toContain('NOT_TOUCHING');
    const shallow = await client.preview(topItem('Hi', { depth: 0.2, position: [0, 0, 4] }), version);
    expect(shallow.notes.map((n) => n.code)).toContain('SHALLOW');

    const open = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(open), name: 'open', version: ++version });
    const r = await client.preview(topItem('Hi', { mode: 'engrave', position: [2, 2, 0] }), version);
    expect(r.notes[0].code).toBe('ENGRAVE_UNAVAILABLE');
  });

  it('stacks lines in different fonts and sizes; a missing font in any line is reported', async () => {
    await client.loadBase({ kind: 'sample', version: ++version });
    const item = createItem({
      lines: [{ text: 'TITLE', fontId: 'inter', size: 9 }, { text: 'name', fontId: 'pacifico', size: 5 }],
      position: [0, 0, 4],
      normal: [0, 0, 1],
    });
    const r = await client.preview(item, version);
    expect(r.size[1]).toBeGreaterThan(9); // taller than the title alone: two stacked lines
    expect(r.size[1]).toBeLessThan(9 + 5 + 1.7 * 7); // but not two full pitches
    const one = await client.preview(createItem({ lines: [{ text: 'TITLE', fontId: 'inter', size: 9 }], position: [0, 0, 4] }), version);
    expect(r.size[0]).toBeCloseTo(one.size[0], 1); // the title is the widest line
    const missing = { ...item, lines: [{ ...item.lines[0], fontId: 'nope' }, { ...item.lines[1], fontId: 'nada' }] };
    await expect(client.preview(missing, version)).rejects.toMatchObject({ code: 'FONT_MISSING', details: { fontId: 'nope', fontIds: ['nope', 'nada'] } });
  });

  it('follows a curved surface', async () => {
    const cyl = wasm.Manifold.cylinder(60, 20, 20, 128, true).rotate([90, 0, 0]);
    await client.loadBase({ kind: 'stl', bytes: stlOf(cyl), name: 'cyl', version: ++version });
    const r = await client.preview(topItem('HELLO', { position: [0, 0, 20] }), version);
    expect(r.stats.conformed).toBe(true);
    expect(r.notes.map((n) => n.code)).toContain('FOLLOWS_CURVE');
    const zs = r.geometry.positions.filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeLessThan(-2); // the ends drop with the cylinder
    const flat = await client.preview(topItem('HELLO', { position: [0, 0, 20], conform: false }), version);
    expect(flat.stats).toBeNull();
    cyl.delete();
  });
});

describe('result and export', () => {
  it('emboss + engrave with fixed semantics, cached, exported as a valid STL', async () => {
    const box = wasm.Manifold.cube([60, 30, 6], true);
    await client.loadBase({ kind: 'stl', bytes: stlOf(box), name: 'box', version: ++version });
    const raised = topItem('Hello', { position: [-12, 0, 3], depth: 1.5 });
    const cut = topItem('World', { position: [14, 0, 3], mode: 'engrave', depth: 1 });
    const r = await client.result([raised, cut], version);
    expect(r.display.index.length / 3).toBeGreaterThan(12);
    expect(r.notes).toEqual([]);
    const ex = await client.export([raised, cut], version, 'box');
    expect(ex.stl).toBeInstanceOf(ArrayBuffer);
    expect(new DataView(ex.stl).getUint32(80, true)).toBe(ex.triangles);
    const volume = volumeOfStl(ex.stl);
    expect(volume).toBeGreaterThan(60 * 30 * 6 - 300);
    const m = geometryToManifold(parseSTL(ex.stl));
    expect(m.status()).toBe('NoError');
    const bb = m.boundingBox();
    expect(bb.max[2]).toBeCloseTo(4.5, 2); // raised 1.5 above z=3
    m.delete();
    // order independence
    const ex2 = await client.export([cut, raised], version, 'box');
    expect(volumeOfStl(ex2.stl)).toBeCloseTo(volume, 3);
    const stats = await client.call('ping', {});
    expect(stats.caches.result).toBe(1);
    box.delete();
  });

  it('cut-in text always cuts through raised text, and items that miss the model are left out', async () => {
    const box = wasm.Manifold.cube([60, 30, 6], true);
    await client.loadBase({ kind: 'stl', bytes: stlOf(box), name: 'box', version: ++version });
    const raised = topItem('O', { position: [0, 0, 3], size: 12, depth: 3 });
    const cut = topItem('I', { position: [0, 0, 3], size: 8, mode: 'engrave', depth: 2, spin: 90 });
    const only = await client.export([raised], version);
    const both = await client.export([raised, cut], version);
    expect(volumeOfStl(both.stl)).toBeLessThan(volumeOfStl(only.stl));

    const floating = topItem('Nope', { position: [0, 0, 40] });
    const r = await client.result([raised, floating], version);
    expect(r.skipped).toEqual([floating.id]);
    expect(r.notes[0].code).toBe('NOT_TOUCHING');
    box.delete();
  });

  it('keeps a small separate part of the model when text is added', async () => {
    const plate = wasm.Manifold.cube([100, 50, 10], true);
    const bead = wasm.Manifold.cube([3, 3, 3], true).translate(60, 0, 0); // 27 mm³ next to a 50 000 mm³ plate
    const soup = soupOf(plate);
    const beadSoup = soupOf(bead);
    const both = new Float32Array(soup.length + beadSoup.length);
    both.set(soup);
    both.set(beadSoup, soup.length);
    await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(both), name: 'beads', version: ++version });
    const ex = await client.export([topItem('Hi', { position: [0, 0, 5] })], version, 'beads');
    expect(ex.notes.map((n) => n.code)).not.toContain('FRAGMENTS_REMOVED');
    expect(volumeOfStl(ex.stl)).toBeGreaterThan(50_000 + 27 + 10); // plate + bead + text
    plate.delete();
    bead.delete();
  });

  it('printing settings change the warnings and reach result/export', async () => {
    await client.loadBase({ kind: 'sample', version: ++version });
    const item = topItem('Hello', { position: [0, 0, 4] });
    const fine = await client.preview(item, version, { printing: { nozzle: 0.4 } });
    expect(fine.notes.map((n) => n.code)).not.toContain('THIN_STROKES');
    const coarse = await client.preview(item, version, { printing: { nozzle: 1.5 } });
    expect(coarse.notes.map((n) => n.code)).toContain('THIN_STROKES');
    expect(coarse.notes.find((n) => n.code === 'THIN_STROKES').text).toMatch(/3 mm/);
    const back = await client.preview(item, version, { printing: { nozzle: 0.4 } });
    expect(back.notes.map((n) => n.code)).not.toContain('THIN_STROKES');
    // options are forwarded for result and export too
    const seen = [];
    const spyEngine = { handle: async (req) => { seen.push(req); return { message: { id: req.id, ok: true, result: {} }, transfer: [] }; } };
    const spy = createEngineClient({ createWorker: () => createLocalWorker(Promise.resolve(spyEngine)) });
    await spy.result([], 1, { printing: { nozzle: 0.6 } });
    await spy.export([], 1, 'x', { printing: { nozzle: 0.6 } });
    expect(seen.map((r) => r.printing?.nozzle)).toEqual([0.6, 0.6]);
  });

  it('no model: raised text exports on its own, cut-in text is skipped with a note', async () => {
    await client.loadBase({ kind: 'none', version: ++version });
    const item = topItem('Solo', { position: [0, 0, 0] });
    const ex = await client.export([item, topItem('x', { mode: 'engrave', position: [0, 0, 0] })], version, 'text');
    expect(ex.triangles).toBeGreaterThan(50);
    const m = geometryToManifold(parseSTL(ex.stl));
    expect(m.boundingBox().min[2]).toBeCloseTo(0, 3); // no model: text sits on the build plate
    m.delete();
    expect(ex.notes.map((n) => n.code)).toContain('ENGRAVE_UNAVAILABLE');
    await expect(client.export([], version, 'empty')).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
  });

  it('emboss on an unrepairable model exports text plus the passthrough triangles', async () => {
    const open = new Float32Array([0, 0, 0, 30, 0, 0, 0, 30, 0]);
    await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(open), name: 'open', version: ++version });
    const ex = await client.export([topItem('Hi', { position: [8, 8, 0] })], version);
    expect(ex.triangles).toBeGreaterThan(1);
    const soupTris = new DataView(ex.stl).getUint32(80, true);
    expect(soupTris).toBe(ex.triangles);
  });
});

describe('client scheduler', () => {
  it('supersedes queued previews: only the latest waiting one runs', async () => {
    await client.loadBase({ kind: 'sample', version: ++version });
    const item = topItem('A', { position: [0, 0, 4] });
    const results = await Promise.all(['A', 'AB', 'ABC', 'ABCD'].map((t) => client.preview({ ...item, lines: [{ ...item.lines[0], text: t }] }, version)));
    // a different item is never superseded by this one
    const other = await client.preview(topItem('Other', { position: [10, 0, 4] }), version);
    expect(other).toBeDefined();
    expect(results[0]).toBeDefined(); // in flight when the others arrived
    expect(results[1]).toBeUndefined();
    expect(results[2]).toBeUndefined();
    expect(results[3]).toBeDefined();
  });

  it('rehydrates fonts and the model after a restart', async () => {
    const box = wasm.Manifold.cube([40, 25, 15], true);
    await client.loadBase({ kind: 'stl', bytes: stlOf(box), name: 'box', version: ++version });
    await client.updateBase({ version: ++version, transforms: [new Matrix4().makeScale(2, 2, 2).toArray()], simplify: null });
    // every spawn gets a brand new engine that knows nothing, like a real worker restart
    const engines = [];
    const c2 = createEngineClient({
      createWorker: () => {
        const e = createEngine({ wasm });
        engines.push(e);
        return createLocalWorker(Promise.resolve(e));
      },
    });
    // replay the client's memory into the new client (what restart() does internally)
    await c2.addFont('inter', fontBytes('inter', 'inter-latin-700-normal.woff'));
    await c2.loadBase({ kind: 'stl', bytes: stlOf(box), name: 'box', version });
    await c2.addFont('pacifico', fontBytes('pacifico', 'pacifico-latin-400-normal.woff'));
    await c2.addFont('slab', fontBytes('roboto-slab', 'roboto-slab-latin-700-normal.woff'));
    c2.restart(); // throws the worker away; next request must rehydrate
    const threeFonts = createItem({
      lines: [{ text: 'A', fontId: 'inter', size: 8 }, { text: 'b', fontId: 'pacifico', size: 5 }, { text: 'C', fontId: 'slab', size: 6 }],
      position: [0, 0, 7.5],
      normal: [0, 0, 1],
    });
    const r = await c2.preview(threeFonts, version); // needs the model AND three fonts back, within the retry bound
    expect(r.geometry.positions.length).toBeGreaterThan(0);
    expect(c2.fatalError).toBeNull();
    expect(engines.length).toBe(2);
    const ping = await c2.call('ping', {});
    expect(ping.fonts.sort()).toEqual(['inter', 'pacifico', 'slab']);
    expect(ping.baseVersion).toBe(version);
    box.delete();
    engines.forEach((e) => e.dispose());
  });

  it('reports progress stages', async () => {
    progress.length = 0;
    const box = wasm.Manifold.cube([40, 25, 15], true);
    await client.loadBase({ kind: 'stl', bytes: stlOf(box), name: 'box', version: ++version });
    expect(progress.some((s) => /Reading/.test(s))).toBe(true);
    expect(progress.some((s) => /Preparing/.test(s))).toBe(true);
    box.delete();
  });

  it('manifold objects do not leak across repeated previews (cache bounded)', async () => {
    await client.loadBase({ kind: 'sample', version: ++version });
    for (let i = 0; i < 25; i++) await client.preview(topItem(`T${i}`, { position: [0, 0, 4] }), version);
    const ping = await client.call('ping', {});
    expect(ping.caches.flat).toBeLessThanOrEqual(16);
    expect(ping.caches.conformed).toBeLessThanOrEqual(16);
  });
});
