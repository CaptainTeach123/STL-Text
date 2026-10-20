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
import { batLanternSolid, roundLanternSolid, stlFileCheck } from './lanternFixture.js';
import { hurricaneSolid } from './partFixtures.js';

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

  it('lays wide text over a sheet that bends up towards its ends, on its front', async () => {
    // a wavy banner: 2 mm thick, rising 42 mm at the ends (z = x² / 240); a flat text plane tangent at its middle
    // runs inside the sheet towards the ends, and the underside is then the surface nearest the plane
    const flat = wasm.Manifold.cube([200, 40, 2], true).refineToLength(2);
    const sheet = flat.warpBatch((verts, count) => {
      for (let i = 0; i < count; i++) verts[i * 3 + 2] += (verts[i * 3] * verts[i * 3]) / 240;
    });
    await client.loadBase({ kind: 'stl', bytes: stlOf(sheet), name: 'banner', version: ++version });
    const r = await client.preview(topItem('Candy Cane Lane', { size: 12, position: [0, 0, 1] }), version); // 140 mm wide: the ends rise 20 mm
    expect(r.stats.conformed).toBe(true);
    expect(r.notes.map((n) => n.code)).not.toContain('NOT_TOUCHING');
    expect(r.notes.map((n) => n.code)).not.toContain('OVERHANG');
    const p = r.geometry.positions;
    let deepest = Infinity;
    let highest = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const above = p[i + 2] - (p[i] * p[i]) / 240; // height over the sheet's top at that x (text-local = model frame here, 1 mm up)
      deepest = Math.min(deepest, above);
      highest = Math.max(highest, above);
    }
    expect(deepest).toBeGreaterThan(-0.7); // sunk by no more than the overlap
    expect(highest).toBeGreaterThan(0.9); // and the letters stand their full height above the sheet
    flat.delete();
    sheet.delete();
  });

  it('wraps text round a mug as far as it is long: every letter on the surface, none lost from the export', async () => {
    // a mug R 30: 'Candy Cane Lane' at 8 mm is about 93 mm long, so it wraps nearly half way round (about 180°);
    // projected from the click it would reach past the mug's silhouette and its end letters would float off
    const outer = wasm.Manifold.cylinder(90, 30, 30, 256, false);
    const inner = wasm.Manifold.cylinder(90, 26, 26, 256, false).translate([0, 0, 6]);
    const mug = outer.subtract(inner);
    await client.loadBase({ kind: 'stl', bytes: stlOf(mug), name: 'mug', version: ++version });
    const item = createItem({ text: 'Candy Cane Lane', fontId: 'inter', size: 8, depth: 1.5, position: [0, -30, 45], normal: [0, -1, 0] });
    const r = await client.preview(item, version);
    const codes = r.notes.map((n) => n.code);
    expect(codes).not.toContain('OVERHANG');
    expect(codes).not.toContain('TOO_CURVED');
    expect(r.stats.wrapDeg).toBeGreaterThan(150);
    const ex = await client.export([item], version, 'mug');
    expect(ex.notes?.map((n) => n.code) ?? []).not.toContain('FRAGMENTS_REMOVED');
    const m = geometryToManifold(parseSTL(ex.stl));
    expect(m.decompose().length).toBe(1);
    // the letters add what they add on a flat face of the same size, within the shell factor of the curve
    const flatBox = wasm.Manifold.cube([200, 40, 20], true);
    await client.loadBase({ kind: 'stl', bytes: stlOf(flatBox), name: 'flat', version: ++version });
    const onFlat = await client.export([createItem({ text: 'Candy Cane Lane', fontId: 'inter', size: 8, depth: 1.5, position: [0, 0, 10], normal: [0, 0, 1] })], version, 'flat');
    const addedFlat = volumeOfStl(onFlat.stl) - flatBox.volume();
    const added = m.volume() - mug.volume();
    expect(added / addedFlat).toBeGreaterThan(0.95);
    expect(added / addedFlat).toBeLessThan(1.1);
    [m, mug, outer, inner, flatBox].forEach((x) => x.delete());
  });

  it('leaves out, and names, the letters that hang past the edge of the model', async () => {
    const box = wasm.Manifold.cube([40, 40, 10], true);
    await client.loadBase({ kind: 'stl', bytes: stlOf(box), name: 'box', version: ++version });
    // about 70 mm of text whose middle is 10 mm right of the box's centre: the last letters lie wholly past its edge
    const item = topItem('HELLO WORLD', { size: 8, position: [10, 0, 5], depth: 1.5 });
    const r = await client.result([item], version);
    const off = r.notes.find((n) => n.code === 'LETTERS_OFF_MODEL');
    expect(off).toBeDefined();
    expect(off.count).toBeGreaterThanOrEqual(2);
    expect(off.level).toBe('warn');
    expect(r.notes.map((n) => n.code)).not.toContain('FRAGMENTS_REMOVED');
    const ex = await client.export([item], version, 'box');
    const m = geometryToManifold(parseSTL(ex.stl));
    expect(m.decompose().length).toBe(1); // nothing loose in the download
    m.delete();
    // cut in, the letters off the model cut nothing, and say so
    const cut = await client.result([topItem('HELLO WORLD', { size: 8, position: [10, 0, 5], mode: 'engrave', depth: 1 })], version);
    expect(cut.notes.find((n) => n.code === 'LETTERS_OFF_MODEL')?.text).toMatch(/cut nothing/);
    box.delete();
  });

  it('curves a line of text either way, its plate with it, and says when it is too short to curve that far', async () => {
    await client.loadBase({ kind: 'sample', version: ++version });
    const shape = async (extra) => {
      const r = await client.preview(topItem('Candy Cane Lane', { size: 10, position: [0, 0, 60], conform: false, ...extra }), version);
      const p = r.geometry.positions;
      let maxX = 0;
      for (let i = 0; i < p.length; i += 3) maxX = Math.max(maxX, Math.abs(p[i]));
      let mid = 0, nMid = 0, end = 0, nEnd = 0;
      for (let i = 0; i < p.length; i += 3) {
        if (Math.abs(p[i]) < 0.1 * maxX) (mid += p[i + 1]), nMid++;
        else if (Math.abs(p[i]) > 0.8 * maxX) (end += p[i + 1]), nEnd++;
      }
      return { r, rise: mid / nMid - end / nEnd };
    };
    const straight = await shape({});
    const arch = await shape({ curve: 90 });
    const smile = await shape({ curve: -90 });
    expect(Math.abs(straight.rise)).toBeLessThan(1);
    expect(arch.rise).toBeGreaterThan(8); // the middle above the ends
    expect(smile.rise).toBeLessThan(-8); // the middle below the ends
    expect(arch.r.size[0]).toBeLessThan(straight.r.size[0]);
    expect(arch.r.notes.map((n) => n.code)).not.toContain('CURVE_LIMITED');
    // with a banner plate the plate bends too: it is as tall as the bend makes it, not a flat strip
    const plated = await shape({ curve: 90, plate: 'banner' });
    expect(plated.r.size[1]).toBeGreaterThan(straight.r.size[1] + 15);
    // a short word cannot go most of the way round a circle: it is curved as far as it can be, and the note says so
    const short = await client.preview(topItem('Hi', { size: 10, position: [0, 0, 60], conform: false, curve: 300 }), version);
    const note = short.notes.find((n) => n.code === 'CURVE_LIMITED');
    expect(note).toBeDefined();
    expect(note.applied).toBeLessThan(300);
  });

  it('says what held a curve back, judges gaps as bent, and sees no overhang in the empty middle of an arch', async () => {
    await client.loadBase({ kind: 'sample', version: ++version });
    const notesOf = async (text, extra) => (await client.preview(topItem(text, { size: 10, position: [0, 0, 60], conform: false, ...extra }), version)).notes;
    // a banner bent most of the way round: its tails would meet, not its inside fold
    const banner = (await notesOf('Candy Cane Lane', { curve: 330, plate: 'banner' })).find((n) => n.code === 'CURVE_LIMITED');
    expect(banner.text).toMatch(/ends of the plate/);
    expect(banner.applied).toBeLessThan(330);
    const short = (await notesOf('Hi', { curve: 300 })).find((n) => n.code === 'CURVE_LIMITED');
    expect(short.text).toMatch(/fold/);
    // a long line goes as far round as asked
    expect((await notesOf('Candy Cane Lane', { curve: 330 })).map((n) => n.code)).not.toContain('CURVE_LIMITED');
    // the gaps between letters on the inside of a tight arch are squeezed below what the nozzle can print
    expect((await notesOf('HELLO', { size: 8, curve: 0 })).map((n) => n.code)).not.toContain('NARROW_GAPS');
    expect((await notesOf('HELLO', { size: 8, curve: 330 })).map((n) => n.code)).toContain('NARROW_GAPS');

    // text arched along the rim of a medal: every letter on it, the corners of the arch's box past the rim
    const disc = wasm.Manifold.cylinder(4, 40, 40, 256, true);
    await client.loadBase({ kind: 'stl', bytes: stlOf(disc), name: 'medal', version: ++version });
    const arch = await client.preview(topItem('CANDY CANE LANE', { size: 6, curve: 150, position: [0, 20, 2] }), version);
    expect(arch.stats.missFraction).toBeLessThan(0.02);
    expect(arch.notes.map((n) => n.code)).not.toContain('OVERHANG');
    disc.delete();
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
  it('a request for a model version the engine does not have is superseded, not a reason to reload the model', async () => {
    // the engine says BASE_MISSING with the version it does have: the request was simply overtaken by a newer base
    const seen = [];
    const have = { current: 7 };
    const engine = {
      handle: async (req) => {
        seen.push(req.type);
        if (req.type === 'base.load' || req.type === 'base.update') {
          have.current = req.version;
          return { message: { id: req.id, ok: true, result: { info: { version: req.version } } }, transfer: [] };
        }
        if (req.baseVersion !== have.current) {
          return { message: { id: req.id, ok: false, error: { code: 'BASE_MISSING', message: 'no', details: { version: req.baseVersion, have: have.current } } }, transfer: [] };
        }
        return { message: { id: req.id, ok: true, result: { fine: true } }, transfer: [] };
      },
    };
    const c = createEngineClient({ createWorker: () => createLocalWorker(Promise.resolve(engine)) });
    await c.loadBase({ kind: 'sample', version: 7 });
    expect(await c.preview(topItem('x'), 5)).toBeUndefined(); // stale: resolves like a superseded request
    expect(seen.filter((t) => t === 'base.load')).toHaveLength(1); // and the model was NOT loaded again
    expect(await c.preview(topItem('x'), 7)).toEqual({ fine: true });
    // a fresh worker that really lost the model (no version at all) is still rehydrated
    have.current = null;
    expect(await c.preview(topItem('x'), 7)).toEqual({ fine: true });
    expect(seen.filter((t) => t === 'base.load')).toHaveLength(2);
  });

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

describe('parts that come off', () => {
  it("mode 'parts' finds the lid and the base, keeps the model's slices and answers again at once", async () => {
    const fx = batLanternSolid();
    const big = fx.scale([3, 3, 3]);
    await client.loadBase({ kind: 'stl', bytes: stlOf(big), name: 'bat', version: ++version });
    fx.delete();
    big.delete();
    // the slices of the model the engine reads, counted
    const binding = Object.getPrototypeOf(wasm.Manifold.prototype);
    const slice = binding.slice;
    let sliced = 0;
    binding.slice = function counted(...args) {
      sliced++;
      return slice.apply(this, args);
    };
    try {
      const printing = { nozzle: 0.4, layerHeight: 0.2 };
      const parts = (clearance) => client.parts([], version, { printing, split: { clearance } });
      progress.length = 0;
      const first = await parts(0.15);
      expect(progress).toContain('Finding the parts that come off…');
      const firstSliced = sliced;
      expect(firstSliced).toBeGreaterThan(240);
      expect(first.parts.map((e) => [e.kind, e.name])).toEqual([['lid', 'Dome and cap'], ['plug', 'Base']]);
      expect(first.parts[0]).toMatchObject({ face: 86, lock: { mech: 'twist', theta: 27, tabs: 3 }, handle: { legs: 2 } });
      expect(first.parts[0].lock.r0).toBeCloseTo(15.88, 1);
      expect(first.parts[1].lock).toMatchObject({ mech: 'plug', R: 21.4 });
      expect(first.scale).toBe(1);
      // the final result is not built yet: read off the model alone, and said so
      expect(first.estimate).toBe(true);
      expect((await client.call('ping', {})).caches.parts).toBe(1);
      // asked again: the same table, no slice read
      progress.length = 0;
      sliced = 0;
      expect(await parts(0.15)).toEqual(first);
      expect(progress).not.toContain('Finding the parts that come off…');
      expect(sliced).toBe(0);
      // another clearance moves the faces and sizes the locks again from the levels kept: only the slices near the
      // faces and the way out are read
      const looser = await parts(0.3);
      expect(sliced).toBeGreaterThan(0);
      expect(sliced).toBeLessThanOrEqual(firstSliced - 240);
      expect(looser.parts[0].lock.r0).toBeLessThan(first.parts[0].lock.r0);
      expect((await client.call('ping', {})).caches.parts).toBe(2);
      // once the result is built the table is the result's, the same parts
      await client.result([], version, { printing });
      const built = await parts(0.15);
      expect(built.estimate).toBeUndefined();
      expect(built.parts).toEqual(first.parts);
      // scaled on: the table says how far, against the model loaded
      await client.updateBase({ version: ++version, transforms: [new Matrix4().makeScale(4 / 3, 4 / 3, 4 / 3).toArray()], simplify: null });
      const at4 = await parts(0.15);
      expect(at4.scale).toBeCloseTo(4 / 3, 6);
      expect(at4.parts[0]).toMatchObject({ face: 114.6, lock: { theta: 18, tabs: 6, teaLight: true } });
    } finally {
      binding.slice = slice;
    }
  });

  it('a model with gaps has no parts to offer, and says why', async () => {
    const open = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(open), name: 'open', version: ++version });
    const r = await client.parts([], version, { printing: { nozzle: 0.4, layerHeight: 0.2 }, split: {} });
    expect(r).toMatchObject({ parts: [], handles: [], open: null, solid: false });
    expect(r.notes.map((n) => n.code)).toEqual(['SPLIT_UNAVAILABLE']);
  });
});

describe('a split that takes parts out', () => {
  const printing = { nozzle: 0.4, layerHeight: 0.2 };
  /** A cut that takes out a part, as the document stores it: a circle on a plane across Z. */
  const partCut = (id, centre, at, r, { hold = 'lock', side = 1, normal = [0, 0, 1] } = {}) => ({
    id, position: [centre[0], centre[1], at], normal, joint: 'apart', hold, part: { r, side, auto: false },
  });
  const load = async (solid, name = 'bat') => {
    await client.loadBase({ kind: 'stl', bytes: stlOf(solid), name, version: ++version });
    solid.delete();
  };
  const exportFiles = (split, p = printing) => client.export([], version, 'bat', { printing: p, split: { clearance: 0.15, ...split }, archive: 'files' });
  /** Slices the engine reads while `run` runs, counted. */
  const slicesDuring = async (run) => {
    const binding = Object.getPrototypeOf(wasm.Manifold.prototype);
    const slice = binding.slice;
    let n = 0;
    binding.slice = function counted(...args) {
      n++;
      return slice.apply(this, args);
    };
    try {
      return { value: await run(), slices: n };
    } finally {
      binding.slice = slice;
    }
  };
  const solidOf = (file) => geometryToManifold(parseSTL(file.stl));

  it('takes the dome and cap and the base out of the lantern at 300 %, each twist-locking: the handle stays, each lies on its face', async () => {
    const model = batLanternSolid().scale([3, 3, 3]);
    // the material the lid has on its face, inside its circle
    const faceArea = (() => {
      const cs = model.slice(86 + 1e-4);
      const islands = cs.decompose();
      const area = islands.filter((x) => {
        const b = x.bounds();
        return Math.max(...[b.min[0], b.min[1], b.max[0], b.max[1]].map(Math.abs)) < 23.6;
      }).reduce((sum, x) => sum + x.area(), 0);
      islands.forEach((x) => x.delete());
      cs.delete();
      return area;
    })();
    await load(model);
    const table = await client.parts([], version, { printing, split: {} });
    const lid = table.parts.find((e) => e.kind === 'lid');
    const base = table.parts.find((e) => e.kind === 'plug');
    expect([lid.face, lid.r, base.face, base.r]).toEqual([86, 23.6286, 0, 21.4]);
    const cuts = (hold) => [partCut('c1', lid.centre, lid.face, lid.r, { hold }), partCut('c2', base.centre, base.face, base.r, { hold })];
    progress.length = 0;
    const ex = await exportFiles({ cuts: cuts('lock') });
    expect(progress).toContain('Cutting the dome and cap…');
    expect(progress).toContain('Cutting the base…');
    expect(progress).toContain('Building the twist-lock…');
    expect(ex.pieces.map((p) => [p.index, p.name, p.lies, p.down, p.part ?? null, p.lids])).toEqual([
      [1, 'Lantern, with the handle', 'flat as modelled', '-z', null, []],
      [2, 'Dome and cap', 'on a cut face', '-z', 'c1', ['A']],
      [3, 'Base', 'flat as modelled', '-z', 'c2', ['B']],
    ]);
    // the part's cell is past the grid, for its colour and number only
    expect(ex.pieces.map((p) => p.cell)).toEqual([[0, 0, 0], [0, 0, 1], [0, 0, 2]]);
    expect(ex.seams).toHaveLength(2);
    // the lock the table offered, built: the lid comes out turned 27° free, lifted from the lock's own lift
    expect(ex.seams[0]).toMatchObject({
      cutId: 'c1', letter: 'A', axis: 2, at: 86, pieces: [1, 2], joint: 'part', labels: null,
      apart: { hold: 'lock', lip: false, clips: 0, mech: 'twist', r0: lid.lock.r0, opening: lid.lock.opening, theta: 27, tabs: 3, teaLight: false, socket: 'ring', slope: 1.72 },
      part: { kind: 'lid', name: 'Dome and cap', centre: lid.centre, r: lid.r, side: 1, handle: true, span: [-1, 0, 0], way: { turn: 27, up: false, lift: 4.1, dir: [0, 1, 0], out: [0, 0, 1] } },
    });
    // the band ends 0.894 mm short of where the collar's underside meets its inside: the collar runs on under it
    expect(ex.seams[0].apart.hang).toBeCloseTo(0.894 / 1.72, 3);
    expect(ex.seams[0].part.cap).toBeCloseTo(lid.cap, 2);
    expect(ex.seams[0].part.top).toBeCloseTo(lid.top, 2);
    expect(ex.seams[1]).toMatchObject({
      letter: 'B', at: 0, pieces: [1, 3], apart: { hold: 'lock', mech: 'plug', R: 21.4, opening: 42.8, theta: 23, tabs: 3, teaLight: true, coin: 36.5 },
      part: { kind: 'plug', name: 'Base', way: { turn: 23, up: true, lift: 0, dir: null, out: [0, 0, -1] } },
    });
    const notes = ex.notes.map((n) => `${n.code}: ${n.text}`);
    expect(notes).toEqual([
      "SPLIT: Cut into 3 pieces. Cuts A and B come apart – don't glue them.",
      'PART_LOCK: Cut A: the dome and cap (piece 2) twist-lock onto piece 1 and the handle stays on piece 1. To fit it: set it on turned 27° to the left so the wide lug finds its wide slot, push down and turn it right until it clicks. To open it: turn it left until it clicks again, lift it 4.5 mm and slide it out under the handle, square to it.',
      'PART_PLUG: Cut B: the base (piece 3) twists off underneath. Turn the lantern over, set the base in turned 23° to the left, push it in and turn it right until it clicks – a coin in its slot helps. To open it: turn it left until it clicks and lift it out. Its Ø 43 mm opening takes a 38 mm tea light.',
    ]);
    expect(ex.notes.slice(1).map((n) => n.level)).toEqual(['info', 'info']);
    expect(ex.assembly).toEqual([
      'Do not glue cut B: it comes apart. Base: turn piece 1 over, set the base in turned 23° to the left, push in and turn it right until it clicks (a coin in the slot helps). To open: turn it left and lift it out.',
      'Do not glue cut A: it comes apart. Dome and cap: set it on turned 27° to the left so the wide lug finds its wide slot, push down and turn it right until it clicks. To open: turn it left until it clicks again, lift it 4.5 mm and slide it out under the handle, square to it.',
    ]);
    const glue = ex.files.find((f) => f.kind === 'text').text;
    expect(glue).toContain('comes off at cut A (the dome and cap)');
    expect(glue).toContain('comes off at cut B (the base)');
    // the same parts lifting off, for what the locks add and take
    const plain = await exportFiles({ cuts: cuts('lift') });
    expect(plain.seams.map((x) => x.apart.mech)).toEqual([null, null]);
    expect(plain.notes.map((n) => n.code)).toEqual(['SPLIT', 'PART_LIFTS', 'PART_LIFTS']);
    // saved as a slicer reads them: no sliver of the locks' booleans rounded to nothing, in any file
    for (const f of ex.files.filter((x) => x.stl)) expect([f.file, stlFileCheck(f.stl)]).toEqual([f.file, { degenerate: 0, open: 0 }]);
    // the files: each one piece; the body stands as modelled with the handle's crown on it and the collar under the
    // face; the lid lies on its face, its socket ring added inside it; the plug on its bottom, its lugs standing out
    const [body, dome, plug] = ex.files.filter((f) => f.stl).map(solidOf);
    const [body0, dome0, plug0] = plain.files.filter((f) => f.stl).map(solidOf);
    try {
      expect([body, dome, plug].map((m) => m.decompose().map((x) => (x.delete(), 1)).length)).toEqual([1, 1, 1]);
      expect(body.volume()).toBeGreaterThan(body0.volume() + 5000);
      expect(dome.volume()).not.toBeCloseTo(dome0.volume(), 0);
      const bb = body.boundingBox();
      expect([bb.min[2], bb.max[2]]).toEqual([0, expect.closeTo(150, 3)]);
      expect(bb.max[0] - bb.min[0]).toBeCloseTo(75, 3);
      const db = dome.boundingBox();
      expect(db.min[2]).toBe(0);
      // its spire's tip, a little over the cap the slices read
      expect(db.max[2]).toBeCloseTo(38.7 * 3 - 86, 3);
      const bottom = dome.slice(0.1);
      expect(bottom.area()).toBeGreaterThanOrEqual(0.9 * faceArea);
      bottom.delete();
      const pb = plug.boundingBox();
      expect(pb.max[2]).toBeCloseTo(25.5, 2);
      // its lugs reach 0.8 mm past the bore; lifting off, it is turned down to the bore less the clearance
      expect(Math.max(pb.max[0] - pb.min[0], pb.max[1] - pb.min[1])).toBeGreaterThan(2 * 21.4);
      const qb = plug0.boundingBox();
      expect(Math.max(qb.max[0] - qb.min[0], qb.max[1] - qb.min[1])).toBeLessThanOrEqual(2 * (21.4 - 0.15) + 0.01);
    } finally {
      [body, dome, plug, body0, dome0, plug0].forEach((m) => m.delete());
    }
    // the pieces view: one range per piece
    const shown = await client.result([], version, { printing, split: { cuts: [partCut('c1', lid.centre, lid.face, lid.r)] } });
    expect(shown.display.parts).toEqual([{ kind: 'piece', index: 1 }, { kind: 'piece', index: 2 }]);
    expect((await client.call('ping', {})).caches.carved).toBe(1);
    // the parts gone, so is what they kept: with no cut at all, or only full ones
    await client.result([], version, { printing });
    expect((await client.call('ping', {})).caches.carved).toBe(0);
    await client.result([], version, { printing, split: { cuts: [partCut('c1', lid.centre, lid.face, lid.r)] } });
    expect((await client.call('ping', {})).caches.carved).toBe(1);
    await client.result([], version, { printing, split: { cuts: [{ id: 'c1', position: [0, 0, 100], normal: [0, 0, 1] }] } });
    expect((await client.call('ping', {})).caches.carved).toBe(0);
  });

  it('builds the lock again for a new clearance, nozzle or layer height, and carves nothing while the face stays', async () => {
    const model = batLanternSolid().scale([3, 3, 3]);
    await load(model);
    const split = (extra = {}) => ({ clearance: 0.15, cuts: [partCut('c1', [0, 0], 86, 23.6286)], ...extra });
    const run = async (s, p = printing) => {
      progress.length = 0;
      const ex = await exportFiles(s, p);
      return { ex, carved: progress.includes('Cutting the dome and cap…'), built: progress.includes('Building the twist-lock…') };
    };
    let r = await run(split());
    expect([r.carved, r.built]).toEqual([true, true]);
    expect(r.ex.seams[0].apart).toMatchObject({ mech: 'twist', r0: 15.88, theta: 27 });
    // asked again: nothing carved or built, and the way out not checked on the solids again
    const binding = Object.getPrototypeOf(wasm.Manifold.prototype);
    const { intersect } = binding;
    let intersects = 0;
    binding.intersect = function counted(...args) {
      intersects++;
      return intersect.apply(this, args);
    };
    try {
      r = await run(split());
    } finally {
      binding.intersect = intersect;
    }
    expect([r.carved, r.built]).toEqual([false, false]);
    expect(intersects).toBe(0);
    // a tighter clearance keeps the face (86): the lock is sized and built again, the carve kept
    r = await run(split({ clearance: 0.1 }));
    expect([r.carved, r.built]).toEqual([false, true]);
    expect(r.ex.seams[0].at).toBe(86);
    expect(r.ex.seams[0].apart.r0).toBeGreaterThan(15.88);
    // a finer nozzle, then a layer height whose layers have 86 too
    r = await run(split(), { nozzle: 0.25, layerHeight: 0.2 });
    expect([r.carved, r.built]).toEqual([false, true]);
    expect(r.ex.seams[0].apart.r0).toBeGreaterThan(15.88);
    r = await run(split(), { nozzle: 0.4, layerHeight: 0.25 });
    expect([r.carved, r.built]).toEqual([false, true]);
    expect(r.ex.seams[0].at).toBe(86);
    // lifting off: no lock, nothing built
    r = await run({ ...split(), cuts: [partCut('c1', [0, 0], 86, 23.6286, { hold: 'lift' })] });
    expect([r.carved, r.built]).toEqual([false, false]);
    expect(r.ex.seams[0].apart.mech).toBeNull();
    expect(r.ex.seams[0].part.way).toMatchObject({ turn: 0, lift: 4.35 });
  });

  it('builds the same lock on a part under its plane: the lantern at 300 % turned over', async () => {
    const upright = batLanternSolid().scale([3, 3, 3]);
    const turned = upright.rotate([180, 0, 0]);
    await load(upright);
    const a = await exportFiles({ cuts: [partCut('c1', [0, 0], 86, 23.6286)] });
    await load(turned);
    const b = await exportFiles({ cuts: [partCut('c1', [0, 0], -86, 23.6286, { side: -1 })] });
    expect(b.seams[0].apart).toEqual(a.seams[0].apart);
    expect(b.seams[0].part.way).toMatchObject({ turn: 27, lift: 4.1, out: [0, 0, -1] });
    expect(b.seams[0].part.way.dir[1]).toBeCloseTo(-1, 6);
    expect(b.notes.map((n) => n.text)).toEqual(a.notes.map((n) => n.text));
    // the same pieces, turned: each file holds as much as the upright one
    const volumes = (ex) => ex.files.filter((f) => f.stl).map((f) => volumeOfStl(f.stl));
    const [va, vb] = [volumes(a), volumes(b)];
    expect(vb).toHaveLength(2);
    vb.forEach((v, i) => expect(v).toBeCloseTo(va[i], 1));
  });

  it('takes the full disc for the socket where the ring would leave a sliver loose in the bore: the round lantern at its eave', async () => {
    await load(roundLanternSolid());
    const ex = await exportFiles({ cuts: [partCut('c1', [0, 0], 150, 80)] });
    expect(ex.seams[0].apart).toMatchObject({ hold: 'lock', mech: 'twist', theta: 10, tabs: 6, socket: 'disc', slope: 1, hang: 0 });
    expect(ex.seams[0].apart.r0).toBeCloseTo(44.02, 2);
    const files = ex.files.filter((f) => f.stl).map(solidOf);
    try {
      expect(files.map((m) => m.decompose().map((x) => (x.delete(), 1)).length)).toEqual([1, 1]);
    } finally {
      files.forEach((m) => m.delete());
    }
    // under the eave, through its 3 mm wall, the ring is enough
    const low = await exportFiles({ cuts: [partCut('c1', [0, 0], 146.6, 80)] });
    expect(low.seams[0].apart).toMatchObject({ mech: 'twist', socket: 'ring' });
  });

  it('checks the way out on the solids: lifts higher past what lies between the slices, and refuses what it cannot clear', async () => {
    const { Manifold } = wasm;
    // the lid lifts off 0.95 mm and slides out along +Y; a thin sheet over its way, loose in the model, between the
    // heights the slices are read at: at z 30.1 the lid clears it two steps higher, at 31.1 never
    const lift = async (z) => {
      const fx = batLanternSolid();
      const sheet = Manifold.cube([6, 3, 0.2]).translate([-3, 9, z]);
      await load(z == null ? fx : Manifold.compose([fx, sheet]));
      if (z != null) fx.delete();
      sheet.delete();
      return exportFiles({ cuts: [partCut('c1', [0, 0], 29, 7.8732, { hold: 'lift' })] });
    };
    let ex = await lift(null);
    expect(ex.seams[0].part.way).toMatchObject({ lift: 0.95, dir: [0, 1, 0] });
    ex = await lift(30.1);
    expect(ex.seams.find((x) => x.part).part.way).toMatchObject({ lift: 1.45, dir: [0, 1, 0] });
    ex = await lift(31.1);
    expect(ex.notes.map((n) => `${n.code}: ${n.text}`)).toEqual([
      "PART_STUCK: Cut A's dome and cap can't come out: the handle's crown is over it and a leg is beside it. Try a smaller circle, or a face higher up.",
    ]);
    expect(ex.pieces).toBeUndefined();
  });

  it("does not build a lock that would leave the part in pieces, socket ring or full disc: it lifts off, the body left as carved", async () => {
    const { Manifold } = wasm;
    // a tube with a web across it and a column standing on the web: the socket cuts the web where it meets the tube,
    // leaving the web and its column loose – more than a sliver inside the bore, so no lock goes on
    const tube = Manifold.cylinder(40, 24, 24, 96).subtract(Manifold.cylinder(40.02, 20, 20, 96).translate([0, 0, -0.01]));
    const web = Manifold.cylinder(2, 20.5, 20.5, 96).translate([0, 0, 20.5]);
    const column = Manifold.cylinder(17.5, 10, 10, 96).translate([0, 0, 22.5]);
    await load(Manifold.union([tube, web, column]));
    [tube, web, column].forEach((m) => m.delete());
    const ex = await exportFiles({ cuts: [partCut('c1', [0, 0], 20, 26)] });
    expect(ex.seams[0].apart).toMatchObject({ hold: 'lock', mech: null, why: 'pieces' });
    expect(ex.seams[0].part.way.turn).toBe(0);
    expect(ex.notes.map((n) => n.code)).toEqual(['SPLIT', 'PART_LIFTS']);
    const [body, top] = ex.files.filter((f) => f.stl).map(solidOf);
    try {
      expect([body, top].map((m) => m.decompose().map((x) => (x.delete(), 1)).length)).toEqual([1, 1]);
      // the tube under the face as it was: no collar, no neck
      // a 96-sided tube, 20 mm of it
      expect(body.volume()).toBeCloseTo(48 * Math.sin((2 * Math.PI) / 96) * (24 ** 2 - 20 ** 2) * 20, 1);
      expect(body.boundingBox().max[2]).toBeCloseTo(20, 6);
    } finally {
      body.delete();
      top.delete();
    }
  });

  it("carves again only for a part's new shape: the same split, a clearance or layer height that keeps the face, carve nothing", async () => {
    await load(batLanternSolid());
    const lid = { centre: [0, 0], face: 29, r: 7.8732 };
    const at = (r = lid.r) => ({ cuts: [partCut('c1', lid.centre, lid.face, r)] });
    progress.length = 0;
    await exportFiles(at());
    expect(progress).toContain('Cutting the dome and cap…');
    // asked again: no slice read, nothing carved
    progress.length = 0;
    let run = await slicesDuring(() => exportFiles(at()));
    expect(run.slices).toBe(0);
    expect(progress).not.toContain('Cutting the dome and cap…');
    // a wider clearance checks the face again (1.2 mm now) and finds it as it was: the carve stays
    progress.length = 0;
    run = await slicesDuring(() => exportFiles({ ...at(), clearance: 0.3 }));
    expect(run.slices).toBeGreaterThan(0);
    expect(progress).not.toContain('Cutting the dome and cap…');
    // so does another layer height, whose layers have 29.0 too
    progress.length = 0;
    run = await slicesDuring(() => exportFiles(at(), { nozzle: 0.4, layerHeight: 0.25 }));
    expect(run.slices).toBeGreaterThan(0);
    expect(progress).not.toContain('Cutting the dome and cap…');
    // another radius is another part
    progress.length = 0;
    const wider = await exportFiles(at(8.2));
    expect(progress).toContain('Cutting the dome and cap…');
    expect(wider.seams[0].part.r).toBe(8.2);
    // turned the other way, its circle is under the plane: there the legs' feet fuse into the dome, and it is refused
    const under = await exportFiles({ cuts: [partCut('c1', lid.centre, lid.face, lid.r, { normal: [0, 0, -1] })] });
    expect(under.notes.map((n) => n.code)).toContain('PART_GAP');
  });

  it('moves a face too near the legs to print apart, and refuses what cannot come off, saying why', async () => {
    await load(batLanternSolid());
    const one = async (cut) => {
      const ex = await exportFiles({ cuts: [cut] });
      return { ex, notes: ex.notes.filter((n) => n.code !== 'SPLIT').map((n) => `${n.level} ${n.code}: ${n.text}`) };
    };
    // a layer under the face: moved up to it
    let r = await one(partCut('c1', [0, 0], 28.8, 7.8732));
    expect(r.notes).toEqual([
      "warn PART_GAP: Cut A: at Z 28.8 the dome and cap's edge is 0.79 mm from the handle's feet – it needs 0.9 mm to print apart. Moved to Z 29.",
      'info PART_LIFTS: Cut A: the dome and cap lift off – nothing holds them.',
    ]);
    expect(r.ex.seams[0].at).toBe(29);
    // where the legs fuse into the dome: refused, with the nearest face that would do; the model comes out whole
    r = await one(partCut('c1', [0, 0], 28.4, 7.8732));
    expect(r.notes).toEqual([
      "warn PART_GAP: Cut A: at Z 28.4 the dome and cap's edge runs into the handle's feet – it needs 0.9 mm to print apart. No face near here leaves it – the nearest that does is Z 29.",
    ]);
    expect(r.ex.stl).not.toBeNull();
    expect(r.ex.pieces).toBeUndefined();
    // the cupola's columns: a face in 12 pieces
    r = await one(partCut('c1', [0, 0], 31.6, 4.5));
    expect(r.notes).toEqual([
      "warn PART_GAP: Cut A: at Z 31.6 the dome and cap's face is in 12 separate pieces – it needs one face to sit on. No face near here is one piece – the nearest that is is Z 32.6.",
    ]);
    // the floor cup under the dome: nothing gets it out
    r = await one(partCut('c1', [0, 0], 7.6, 6));
    expect(r.notes).toEqual(["warn PART_STUCK: Cut A's part can't come out: the rest of the model closes it in. Try a smaller circle, or a face higher up."]);
    // a circle in the air under the dome takes nothing
    r = await one(partCut('c1', [0, 0], 20, 5));
    expect(r.notes).toEqual(["warn CUT_MISSES: Cut A doesn't cross the model – it cuts nothing."]);
    // a full cut through the lid: the part is left out, the cut cuts the lantern as ever
    r = await one(partCut('c1', [0, 0], 29, 7.8732));
    const crossed = await exportFiles({ cuts: [partCut('c1', [0, 0], 29, 7.8732), { id: 'c2', position: [0, 0, 33], normal: [0, 0, 1] }] });
    expect(crossed.notes.map((n) => `${n.code}: ${n.text}`)).toContain('PART_CROSSED: Cut B runs through the part of cut A – move one of them.');
    expect(crossed.pieces).toHaveLength(2);
    expect(crossed.pieces.some((p) => p.part)).toBe(false);
    // one under it: three pieces, the lid's face on the layers of the piece over the cut
    const under = await exportFiles({ cuts: [partCut('c1', [0, 0], 29.1, 7.8732), { id: 'c2', position: [0, 0, 20.1], normal: [0, 0, 1] }] });
    expect(under.pieces.map((p) => p.name)).toEqual(['piece 1 of 3', 'piece 2 of 3', 'Dome and cap']);
    expect(under.seams.find((x) => x.joint === 'part')).toMatchObject({ at: 29.1, pieces: [2, 3] });
    // the piece the lid comes out of stands as modelled
    expect(under.pieces[1].down).toBe('-z');
  });

  it('takes the base out of a bottom that is not one flat face: recessed inside a foot\'s rim, or a little tilted', async () => {
    const { Manifold } = wasm;
    const bat4 = () => batLanternSolid().scale([4, 4, 4]);
    const recess = Manifold.cylinder(1.2, 30, 30, 96).translate([0, 0, -1]);
    const models = { tilted: bat4().rotate([0.2, 0, 0]), footed: bat4().subtract(recess) };
    recess.delete();
    for (const [name, model] of Object.entries(models)) {
      await load(model, name);
      const base = (await client.parts([], version, { printing, split: {} })).parts.find((e) => e.kind === 'plug');
      expect([name, base.lock]).toMatchObject([name, { mech: 'plug' }]);
      const ex = await exportFiles({ cuts: [partCut('c1', base.centre, base.face, base.r)] });
      // (the tilted base's bottom is tilted too: it has nothing flat to stand on, and says so)
      expect([name, ex.notes.map((n) => n.code).slice(0, 2)]).toEqual([name, ['SPLIT', 'PART_PLUG']]);
      expect(ex.seams[0].apart).toMatchObject({ mech: 'plug', R: base.r });
    }
  });

  it('takes a dome out from under a bail on side pivots: lifted the lock\'s own lift, it slides out under the arch', async () => {
    // the arch comes down near the cap only over the rim of the dome, 40 mm under it: lifted 2.6 mm the cap is far
    // under the arch, and the dome slides out along ±Y between the arms
    await load(hurricaneSolid(), 'hurricane');
    const table = await client.parts([], version, { printing, split: {} });
    const lid = table.parts.find((e) => e.kind === 'lid');
    expect(lid).toMatchObject({ name: 'Dome and cap', lock: { mech: 'twist' }, way: { up: false, lift: 2.6 } });
    expect(Math.abs(lid.way.dir[1])).toBeCloseTo(1, 6);
    const ex = await exportFiles({ cuts: [partCut('c1', lid.centre, lid.face, lid.r)] });
    expect(ex.notes.map((n) => n.code)).toEqual(['SPLIT', 'PART_LOCK']);
    expect(ex.seams[0].apart.mech).toBe('twist');
    expect(ex.seams[0].part.way).toMatchObject({ up: false, lift: 2.6 });
  });

  it('Fit to my printer keeps a part that comes off as it is stored, and plans the other cuts on the body round it', async () => {
    await load(batLanternSolid().scale([3, 3, 3]));
    const table = await client.parts([], version, { printing, split: {} });
    const lid = table.parts.find((e) => e.kind === 'lid');
    const part = partCut('c1', lid.centre, lid.face, lid.r);
    const plan = (cuts, bed) => client.planSplit([], version, { printing, split: { clearance: 0.15, cuts }, bed, mode: 'fit' });
    // it fits whole: a glued cut goes and the part stays, the pieces offered the body and the part
    const whole = await plan([part, { id: 'c2', position: [0, 0, 40], normal: [0, 0, 1] }], [250, 250, 250]);
    expect(whole.cuts).toEqual([part]);
    expect(whole.notes.map((n) => n.text)).toEqual(['This model fits your printer with cut A as it is – no more cuts needed.']);
    expect(whole.pieces).toHaveLength(2);
    // 75 mm across on a 70 mm bed: the part comes first, as stored, then cuts across X and Y that miss the dome it
    // holds (±23.1 mm), where the model's own plan cuts through the middle
    const small = await plan([part], [70, 70, 160]);
    expect(small.cuts[0]).toEqual(part);
    expect(small.cuts.slice(1).map((c) => c.normal)).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(small.cuts.slice(1).every((c, i) => Math.abs(c.position[i]) > 23.2)).toBe(true);
    expect(small.notes.map((n) => n.code)).toEqual(['APART_KEPT']);
    // taken as the document numbers it, the split keeps the part: the files are the pieces offered
    const cuts = small.cuts.map((c, i) => (c.id ? c : { ...c, id: `c${i + 1}` }));
    const ex = await exportFiles({ cuts });
    expect(ex.notes.map((n) => n.code)).toContain('PART_LOCK');
    expect(ex.notes.map((n) => n.code)).not.toContain('PART_CROSSED');
    expect(ex.pieces.map((p) => p.name)).toEqual(['piece 1 of 4', 'piece 2 of 4', 'piece 3 of 4', 'Dome and cap']);
    expect(small.pieces).toHaveLength(ex.pieces.length);
  });

  it("can't take the dome and cap out from under a crown lowered onto them, and says what is in the way", async () => {
    const fx = batLanternSolid();
    const bar = wasm.Manifold.cube([21, 2.3, 1], true).translate([0, 0, 39.5]);
    await load(wasm.Manifold.union([fx, bar]));
    fx.delete();
    bar.delete();
    const ex = await exportFiles({ cuts: [partCut('c1', [0, 0], 29, 7.8732)] });
    expect(ex.notes.map((n) => `${n.code}: ${n.text}`)).toEqual([
      "PART_STUCK: Cut A's dome and cap can't come out: the handle's crown is over it and a leg is beside it. Try a smaller circle, or a face higher up.",
    ]);
    expect(ex.stl).not.toBeNull();
  });

  it("refuses a circle that crosses the model above its plane, or leaves the rest of it in pieces", async () => {
    const { Manifold } = wasm;
    // a post on a disc under a flange: round the post, the circle runs into the flange
    const cyl = (h, r, z = 0) => Manifold.cylinder(h, r, r, 64).translate([0, 0, z]);
    const parts = [cyl(5, 10), cyl(15, 5, 5), cyl(2, 15, 20)];
    await load(Manifold.union(parts));
    parts.forEach((m) => m.delete());
    let ex = await exportFiles({ cuts: [partCut('c1', [0, 0], 10, 8)] });
    expect(ex.notes.map((n) => `${n.code}: ${n.text}`)).toEqual([
      "PART_MIXED: Cut A's circle crosses the model above and around its plane – use a full cut there, or move it to where the circle crosses only air.",
    ]);
    // a bar with a post at each end: a base taken out of its middle leaves the two ends apart
    const bits = [Manifold.cube([30, 6, 3], true).translate([0, 0, 1.5]), Manifold.cube([3, 4, 17], true).translate([12.5, 0, 11.5]), Manifold.cube([3, 4, 17], true).translate([-12.5, 0, 11.5])];
    await load(Manifold.union(bits));
    bits.forEach((m) => m.delete());
    ex = await exportFiles({ cuts: [partCut('c1', [0, 0], 0, 10)] });
    expect(ex.notes.map((n) => `${n.code}: ${n.text}`)).toEqual(["PART_SPLIT: Cut A's circle leaves the rest of the model in 2 pieces – make it smaller or use Find again."]);
    // with a post's top as a part too: the one that breaks the body is found and left out, the other carved (their
    // boxes meet, their circles do not)
    const both = { cuts: [partCut('c1', [12.5, 0], 15, 3), partCut('c2', [0, 0], 0, 9.2)] };
    progress.length = 0;
    ex = await exportFiles(both);
    // (the post's top stands on 12 mm²: unsteady, as any piece that small)
    expect(ex.notes.map((n) => n.code)).toEqual(['SPLIT', 'PART_SPLIT', 'PART_LIFTS', 'PIECE_UNSTABLE']);
    expect(ex.notes[1]).toMatchObject({ letter: 'B', body: true, pieces: 2 });
    expect(ex.pieces.map((p) => p.name)).toEqual(['piece 1 of 2', 'Top']);
    expect(progress.filter((x) => x === 'Cutting the base…')).toHaveLength(1);
    // asked again, the carve that broke the body is known: nothing carved
    progress.length = 0;
    ex = await exportFiles(both);
    expect(ex.notes.map((n) => n.code)).toEqual(['SPLIT', 'PART_SPLIT', 'PART_LIFTS', 'PIECE_UNSTABLE']);
    expect(progress.filter((x) => /^Cutting the/.test(x))).toEqual([]);
    // a part the slices see whole but that comes out in two: a sliver of a post beside it on the plane
    const sliver = [Manifold.cylinder(3, 20, 20, 64), Manifold.cylinder(7, 3, 3, 64).translate([0, 0, 3]), Manifold.cube([0.005, 0.005, 3]).translate([5, 0, 3])];
    await load(Manifold.compose([Manifold.union(sliver.slice(0, 2)), sliver[2]]));
    sliver.forEach((m) => m.delete());
    ex = await exportFiles({ cuts: [partCut('c1', [0, 0], 5, 8)] });
    expect(ex.notes.map((n) => `${n.code}: ${n.text}`)).toEqual(["PART_SPLIT: Cut A's circle cuts the top into 2 pieces – make it smaller or use Find again."]);
    // a circle round the whole of a block's bottom takes all of it
    const block = Manifold.cube([10, 10, 10]);
    await load(block.translate([0, 0, 0]));
    block.delete();
    ex = await exportFiles({ cuts: [partCut('c1', [5, 5], 0, 20)] });
    expect(ex.notes.map((n) => `${n.code}: ${n.text}`)).toEqual(["PART_SPLIT: Cut A's circle takes the whole model – make it smaller or use Find again."]);
    // a base and a post's top whose boxes meet but whose circles do not: both come out
    const diagonal = [Manifold.cube([40, 40, 3], true).translate([0, 0, 1.5]), Manifold.cube([3, 3, 17], true).translate([10, 10, 11.5])];
    await load(Manifold.union(diagonal));
    diagonal.forEach((m) => m.delete());
    ex = await exportFiles({ cuts: [partCut('c1', [0, 0], 0, 9), partCut('c2', [10, 10], 15, 3)] });
    expect(ex.pieces.map((p) => p.name)).toEqual(['piece 1 of 3', 'Base', 'Top']);
    // the same part twice: the second runs into the first, and is left out
    ex = await exportFiles({ cuts: [partCut('c1', [10, 10], 15, 3), partCut('c2', [10, 10], 15.2, 3)] });
    expect(ex.notes.map((n) => `${n.code}: ${n.text}`)).toContain('PART_CROSSED: Cut A runs through the part of cut B – move one of them.');
    expect(ex.pieces).toHaveLength(2);
  });

  it('pieces too big to keep are cut again with the parts, and no turned copy of the model is kept while they are', async () => {
    const lean = createEngine({ wasm, splitKeepTriangles: 1000 });
    const c = createEngineClient({ createWorker: () => createLocalWorker(Promise.resolve(lean)) });
    await c.addFont('inter', fontBytes('inter', 'inter-latin-700-normal.woff'));
    const fx = batLanternSolid();
    await c.loadBase({ kind: 'stl', bytes: stlOf(fx), name: 'bat', version: 1 });
    fx.delete();
    const split = { clearance: 0.15, cuts: [partCut('c1', [0, 0], 29, 7.8732)] };
    // a cut across X measured: the model turned for it is kept for the next measure
    const measure = () => c.planSplit([], 1, { printing, split: { cuts: [{ id: 'c2', position: [3, 0, 0], normal: [1, 0, 0] }] }, mode: 'measure' });
    await c.result([], 1, { printing });
    // the turned copies the measure makes, and whether they are let go by the time the body is carved
    const binding = Object.getPrototypeOf(wasm.Manifold.prototype);
    const { transform, intersect } = binding;
    const turned = [];
    let atCarve = null;
    binding.transform = function kept(m, ...rest) {
      const out = transform.call(this, m, ...rest);
      if (Array.isArray(m) && m.join() === [0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1].join()) turned.push(out);
      return out;
    };
    binding.intersect = function first(...args) {
      atCarve ??= turned.map((m) => m.isDeleted());
      return intersect.apply(this, args);
    };
    let first;
    try {
      await measure();
      expect((await c.call('ping', {})).caches.frame).toBe(1);
      // carving the parts lets it go first
      first = await c.export([], 1, 'bat', { printing, split, archive: 'files' });
    } finally {
      binding.transform = transform;
      binding.intersect = intersect;
    }
    expect(atCarve).toEqual([true]);
    expect((await c.call('ping', {})).caches.frame).toBe(0);
    // and cutting the body's pieces again for another download too
    await measure();
    expect((await c.call('ping', {})).caches.frame).toBe(1);
    const again = await c.export([], 1, 'bat', { printing, split, archive: 'files' });
    expect((await c.call('ping', {})).caches.frame).toBe(0);
    // the same pieces as an engine that kept them, the part with them
    const kept = await (async () => {
      await load(batLanternSolid());
      return exportFiles(split);
    })();
    for (const ex of [first, again]) {
      expect(ex.pieces.map((p) => p.name)).toEqual(['Lantern, with the handle', 'Dome and cap']);
      const files = ex.files.filter((f) => f.stl);
      files.forEach((f, k) => expect(volumeOfStl(f.stl)).toBeCloseTo(volumeOfStl(kept.files.filter((x) => x.stl)[k].stl), 6));
    }
    c.dispose();
  });

  it('lets go of the body and the parts once no part is asked for', async () => {
    await load(batLanternSolid());
    await client.result([], version, { printing });
    // what the carve makes, followed
    const binding = Object.getPrototypeOf(wasm.Manifold.prototype);
    const { subtract } = binding;
    const made = [];
    binding.subtract = function followed(...args) {
      const out = subtract.apply(this, args);
      made.push(out);
      return out;
    };
    try {
      await client.result([], version, { printing, split: { cuts: [partCut('c1', [0, 0], 29, 7.8732)] } });
    } finally {
      binding.subtract = subtract;
    }
    expect(made.filter((m) => !m.isDeleted())).toHaveLength(1);
    await client.result([], version, { printing });
    expect(made.filter((m) => !m.isDeleted())).toHaveLength(0);
  });

  it('a part lies on its face, however else it would rather lie', async () => {
    // a mushroom: the top of its stem and its cap come off, and would lie best on the cap
    const { Manifold } = wasm;
    const bits = [Manifold.cylinder(5, 10, 10, 64), Manifold.cylinder(10, 2, 2, 64).translate([0, 0, 5]), Manifold.cylinder(2, 8, 8, 64).translate([0, 0, 15])];
    await load(Manifold.union(bits));
    bits.forEach((m) => m.delete());
    const ex = await exportFiles({ cuts: [partCut('c1', [0, 0], 10, 9)] });
    expect(ex.pieces.map((p) => [p.name, p.down, p.lies])).toEqual([['piece 1 of 2', '-z', 'flat as modelled'], ['Top', '-z', 'on a cut face']]);
  });

  it('takes a part out of a lantern turned over: under its plane, lying on its face', async () => {
    const upright = batLanternSolid();
    await load(upright.rotate([180, 0, 0]));
    upright.delete();
    // the dome hangs under z −29 now: the part lies along −Z from its plane
    const ex = await exportFiles({ cuts: [partCut('c1', [0, 0], -29, 7.8732, { side: -1 })] });
    // the body stands as modelled, on the handle's crown now, and the part lies on its face
    expect(ex.pieces.map((p) => [p.name, p.down, p.lies])).toEqual([['Lantern, with the handle', '-z', 'on a curve'], ['Dome and cap', '+z', 'on a cut face']]);
    expect(ex.seams[0]).toMatchObject({ at: -29, part: { side: -1, way: { up: false, lift: 0.95, out: [0, 0, -1] } } });
    expect(ex.seams[0].part.way.dir[1]).toBeCloseTo(-1, 6);
    const lid = solidOf(ex.files[1]);
    try {
      expect(lid.volume()).toBeCloseTo(203.99, 1);
      expect(lid.boundingBox().min[2]).toBe(0);
    } finally {
      lid.delete();
    }
  });
});
