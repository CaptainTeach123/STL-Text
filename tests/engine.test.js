import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Matrix4 } from 'three';
import { createEngine, partSmall, passthroughRangesOf } from '../src/engine.js';
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

  it('a model put in mm by Inches → mm is still 100 % as downloaded: the sizes the table gives are shares of it in mm', async () => {
    const fx = batLanternSolid();
    const inches = fx.scale([3 / 25.4, 3 / 25.4, 3 / 25.4]); // the lantern as a file in inches has it
    await client.loadBase({ kind: 'stl', bytes: stlOf(inches), name: 'bat', version: ++version });
    fx.delete();
    inches.delete();
    const mm = new Matrix4().makeScale(25.4, 25.4, 25.4).toArray();
    const printing = { nozzle: 0.4, layerHeight: 0.2 };
    await client.updateBase({ version: ++version, transforms: [mm], units: 25.4, simplify: null });
    const converted = await client.parts([], version, { printing, split: {} });
    expect(converted.scale).toBe(1);
    expect(converted.parts.map((e) => e.kind)).toEqual(['lid', 'plug']);
    // the same transforms with no units – a Scale of 2540 % – is that share of it, not the table read before
    await client.updateBase({ version: ++version, transforms: [mm], simplify: null });
    expect((await client.parts([], version, { printing, split: {} })).scale).toBe(25.4);
  });

  it("mode 'part' tries a part's face where it is put, as the split places it: on the layers, moved up to print apart, with its bands", async () => {
    const fx = batLanternSolid();
    const big = fx.scale([3, 3, 3]);
    await client.loadBase({ kind: 'stl', bytes: stlOf(big), name: 'bat', version: ++version });
    fx.delete();
    big.delete();
    const printing = { nozzle: 0.4, layerHeight: 0.2 };
    const lid = (await client.parts([], version, { printing, split: {} })).parts.find((e) => e.kind === 'lid');
    const at = (z, r = lid.r, split = {}) => client.partAt([], version, { centre: lid.centre, at: z, r, printing, split });
    // the finder's face: taken as it is, the circle in the middle of its free band
    const face = await at(lid.face);
    expect(face).toMatchObject({ ok: true, why: null, asked: 86, z0: 86, kind: 'lid', gmin: 0.9 });
    expect(face.windows.some(([lo, hi]) => lo < lid.r && lid.r < hi && Math.abs((lo + hi) / 2 - lid.r) < 1e-3)).toBe(true);
    // off the layers: put on them first
    expect(await at(85.93)).toMatchObject({ ok: true, asked: 86, z0: 86 });
    // a face too low runs into the handle's feet: refused there, with the nearest face that prints apart
    const low = await at(85);
    expect(low).toMatchObject({ ok: false, why: 'gap', asked: 85, nearest: 86 });
    expect(low.tried.gap).toBeLessThan(0.9);
    // a little low: moved up a layer or two by the split itself
    const near = await at(85.8);
    expect(near.ok).toBe(true);
    expect(near.z0).toBeGreaterThan(85.8);
    // a circle as wide as the lantern crosses its band: mixed; over the top of the model, nothing to take
    expect((await at(86, 34)).why).toBe('mixed');
    expect((await at(160)).why).toBe('empty');
    // a full cut under it moves the layers it prints on
    expect(await at(86, lid.r, { cuts: [{ id: 'c1', position: [0, 0, 40.05], normal: [0, 0, 1] }] })).toMatchObject({ asked: 86.05 });
  });

  it('a model with gaps has no parts to offer, and says why', async () => {
    const open = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(open), name: 'open', version: ++version });
    const r = await client.parts([], version, { printing: { nozzle: 0.4, layerHeight: 0.2 }, split: {} });
    expect(r).toMatchObject({ parts: [], handles: [], open: null, solid: false });
    expect(r.notes.map((n) => n.code)).toEqual(['SPLIT_UNAVAILABLE']);
  });
});

describe('what the notes say of a part too small to lock', () => {
  // the parts table at 200 % of a model: the lid's family from z 56 up, the base with its least scale
  const table = {
    scale: 2, width: 50, h: 0.4167, parts: [
      { kind: 'lid', centre: [0, 0], from: 56, cap: 77.4, lock: null, least: { lock: 1.375, tea: 1.825, opening: 24.12 }, wall: { t: 1.47, slope: 29.8 } },
      { kind: 'plug', centre: [0, 0], lock: null, least: { lock: 1.054688, tea: 1.351563, opening: 30.2 } },
    ],
  };
  const lid = { axis: 2, side: 1, centre: [0, 0], at: 57.6, plug: false };
  const base = { axis: 2, side: 1, centre: [0, 0], at: 0, plug: true };

  it("reads the family's entry: the least scales as whole 5 % of the model as loaded, and the base's when it stays on", () => {
    expect(partSmall(table, lid, [lid])).toEqual({ now: 200, lock: 275, opening: 24.12, tea: 365, wall: { t: 1.47, slope: 29.8 }, base: 215 });
    // the base taken out too: nothing said of it; the base itself
    expect(partSmall(table, lid, [lid, base]).base).toBeNull();
    expect(partSmall(table, base, [lid, base])).toEqual({ now: 200, lock: 215, opening: 30.2, tea: 275, wall: null, base: null });
    // a base that locks at this size; a lid no lock fits as far as the finder looks
    expect(partSmall({ ...table, parts: [table.parts[0], { ...table.parts[1], lock: { mech: 'plug' } }] }, lid, [lid]).base).toBe('now');
    const never = { ...table, parts: [{ ...table.parts[0], least: { lock: null, tea: null } }] };
    expect(partSmall(never, lid, [lid])).toMatchObject({ lock: null, tea: null, most: 1200 });
  });

  it('has nothing to say of a part the table has no entry for: across X, under its plane, off the axis, or outside the family', () => {
    expect(partSmall(table, { ...lid, axis: 0 }, [lid])).toBeNull();
    expect(partSmall(table, { ...lid, side: -1 }, [lid])).toBeNull();
    expect(partSmall(table, { ...lid, centre: [5, 0] }, [lid])).toBeNull();
    expect(partSmall(table, { ...lid, at: 40 }, [lid])).toBeNull();
    expect(partSmall(table, { ...lid, at: 80 }, [lid])).toBeNull();
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

  it("reads the model's slices once for the card and the pieces, and says it builds the twist-lock, not pin holes", async () => {
    // the card's table is asked for before any final result is built (just after a Scale): on the model alone
    await load(batLanternSolid().scale([3, 3, 3]));
    const table = await client.parts([], version, { printing, split: {} });
    expect(table.estimate).toBe(true);
    const lid = table.parts.find((e) => e.kind === 'lid');
    const split = { clearance: 0.15, cuts: [partCut('c1', lid.centre, lid.face, lid.r)] };
    progress.length = 0;
    const kept = await slicesDuring(() => client.result([], version, { printing, split }));
    expect(kept.value.pieces).toHaveLength(2);
    expect(progress).not.toContain('Finding the parts that come off…');
    expect(progress).not.toContain('Drilling pin holes…');
    expect(progress).toContain('Building the twist-lock…');
    // the same model with no card asked for first slices it all for the pieces
    await load(batLanternSolid().scale([3, 3, 3]));
    progress.length = 0;
    const fresh = await slicesDuring(() => client.result([], version, { printing, split }));
    expect(progress).toContain('Finding the parts that come off…');
    expect(kept.slices).toBeLessThan(fresh.slices / 2);
  }, 120000);

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
      // a tea light goes in through the base: it goes in from underneath with the light standing on it
      "PART_PLUG: Cut B: the base (piece 3) twists off underneath, and its Ø 43 mm opening takes a 38 mm tea light. To fit it: stand the light on the middle of the base, hold the lantern up and, looking at the base's bottom, set the base in turned 23° to the left, push it in and turn it right until it clicks – a coin in its slot helps. To open it: turn it left until it clicks and lower it out. Use an LED tea light: a flame's heat softens the plastic over it.",
      // how each prints: the lid's slit bridges as built (9 mm tabs round a Ø 32 mm socket: 10.41 mm along their middle), the
      // collar as steep as the dome; the base adds no overhang
      'PART_PRINT: Print piece 2 on its cut face, as saved. The lock needs no support: its slots and click tabs are bridged (10.5 mm or less) – if your slicer puts support inside them, turn on "don\'t support bridges". The collar under the joint inside piece 1 slopes like the dome (60°), so it needs whatever support the dome needs.',
      'PART_PRINT: Print piece 3 on its bottom, as saved. Its lock needs no support: every face it adds slopes at 45° or less, with no bridge.',
      // the fit test the download makes: the lid's rings and the base's ring and plug, as the fit test's own words give them
      "PART_FIT: Print the fit test first (Download fit test): two rings Ø 40 mm with the dome and cap's twist-lock, and a ring Ø 56 mm and a plug with the base's twist-lock, about 17 g in all. If a pair won't twist together, raise the Clearance by 0.05 mm and print them again; if one rattles or doesn't click, lower it. Most printers need 0.15–0.25 mm, and PETG 0.25–0.3.",
    ]);
    expect(ex.notes.slice(1).map((n) => n.level)).toEqual(['info', 'info', 'info', 'info', 'info']);
    expect(ex.notes.find((n) => n.code === 'PART_PRINT')).toMatchObject({ cutId: 'c1', piece: 2, home: 1, mech: 'twist', bridge: expect.closeTo(10.41, 2), slope: 1.72 });
    const coupon = await client.fitTest([], version, { printing, split: { clearance: 0.15, cuts: cuts('lock') }, name: 'bat' });
    expect(ex.notes.find((n) => n.code === 'PART_FIT')).toMatchObject({
      d: coupon.twist.d, grams: coupon.twist.grams, lid: 'Dome and cap', plug: { d: coupon.plug.d, grams: coupon.plug.grams, name: 'Base' },
    });
    // with a lid and a base, both coupons in a row in one file: the lid's two rings, the base's ring and plug
    expect(coupon.plug).toEqual({ R: 21.4, opening: 42.8, theta: 23, d: 56.2, grams: 12 });
    const both = solidOf(coupon);
    try {
      const bodies = both.decompose();
      const boxes = bodies.map((x) => x.boundingBox());
      bodies.forEach((x) => x.delete());
      expect(boxes.map((b) => [+(b.max[0] - b.min[0]).toFixed(1), b.min[2]])).toEqual([[40.1, 0], [40.1, 0], [56.2, 0], [42.7, 0]]);
      expect(boxes.every((b, i) => i === 0 || b.min[0] > boxes[i - 1].max[0])).toBe(true);
    } finally {
      both.delete();
    }
    expect(ex.assembly).toEqual([
      "Do not glue cut B: it comes apart. Base: its Ø 43 mm opening takes a 38 mm tea light – stand the light on the middle of the base, hold piece 1 up and, looking at the base's bottom, set the base in turned 23° to the left, push in and turn it right until it clicks (a coin in the slot helps). To open: turn it left and lower it out.",
      'Do not glue cut A: it comes apart. Dome and cap: set it on turned 27° to the left so the wide lug finds its wide slot, push down and turn it right until it clicks. To open: turn it left until it clicks again, lift it 4.5 mm and slide it out under the handle, square to it.',
    ]);
    const glue = ex.files.find((f) => f.kind === 'text').text;
    expect(glue).toContain('comes off at cut A (the dome and cap)');
    expect(glue).toContain('comes off at cut B (the base)');
    // the lantern carries the lid's neck and the base's slots; the collar is supported as the dome is; how each should
    // twist on, and the fit test first
    expect(glue).toContain('twist-locks need no supports');
    expect(glue).toMatch(/piece 1 of 3 .* fits, twist-lock neck for cut A, twist-lock slots for cut B\n/);
    expect(glue).toContain("  The collar under cut A's neck slopes like the dome (60°): it takes whatever support the dome takes.");
    expect(glue).toContain("  The dome and cap (cut A) should twist on with a click and twist off again by hand. Try the fit test first: if it's too stiff to turn, raise Clearance by 0.05 mm; if it rattles or doesn't click, lower it.");
    expect(glue).toContain("  The base (cut B) should twist in with a click and twist out again by hand. Try the fit test first: if its plug is too stiff to turn in its ring, raise Clearance by 0.05 mm; if it rattles or doesn't click, lower it.");
    expect(glue).toContain('  Not sure about the fit? Print the fit test first (Split card → Download fit test): two rings Ø 40 mm and a ring Ø 56 mm with a plug, about 17 g.');
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
    // and paints the lock on both pieces: its own faces (the neck; the socket, slots and click tabs), its lugs apart and,
    // lighter, what carries it (the collar, the socket ring), each mark with its joint's plane
    const d = shown.display;
    expect(d.marks).toEqual([
      { cutId: 'c1', kind: 'lock', at: [lid.centre[0], lid.centre[1], 86], axis: [0, 0, 1] },
      { cutId: 'c1', kind: 'carry', at: [lid.centre[0], lid.centre[1], 86], axis: [0, 0, 1] },
      { cutId: 'c1', kind: 'lug', at: [lid.centre[0], lid.centre[1], 86], axis: [0, 0, 1] },
    ]);
    // the words the view puts on it, close up: the lugs on the lantern, the slots and click tabs in the lid
    const on = (name) => [...new Set(d.lockLabels.filter((x) => x.name === name).map((x) => x.piece))];
    expect([on('lug'), on('slot'), on('click tab')]).toEqual([[1], [2], [2]]);
    expect(d.lockLabels.filter((x) => x.name === 'lug')).toHaveLength(3);
    const r0 = lid.lock.r0;
    const seen = d.ranges.map(() => [0, 0, 0]);
    for (const [t0, n, m] of d.markRanges) {
      const piece = d.ranges.findIndex(([s0, sn]) => t0 >= s0 && t0 + n <= s0 + sn);
      expect(piece).toBeGreaterThanOrEqual(0);
      seen[piece][m] += n;
      for (let t = t0; t < t0 + n; t++) {
        for (let k = 0; k < 3; k++) {
          const v = d.index[t * 3 + k] * 3;
          const r = Math.hypot(d.positions[v] - lid.centre[0], d.positions[v + 1] - lid.centre[1]);
          const z = d.positions[v + 2] - 86;
          // the lock's own faces lie round the neck (r0 15.88), from the socket's floor a millimetre under the face to its
          // ceiling 2.8 mm over it; what carries it from the bore out to the lantern's wall, from where the collar meets
          // the wall 8.8 mm down to over the socket ring
          if (m === 0) expect([r > r0 - 2 && r < r0 + 2.6, z > -1.01 && z < 2.81]).toEqual([true, true]);
          else if (m === 2) expect([r > r0 - 0.5 && r < r0 + 1.5, z > -0.5 && z < 2.81]).toEqual([true, true]);
          else expect([r > r0 - 2 && r < 28, z > -9 && z < 4.01]).toEqual([true, true]);
        }
      }
    }
    // hundreds of triangles of each on each piece: the lantern's neck and collar, the lid's socket and its ring; the
    // lugs on the lantern only
    for (const [lock, carry] of seen) expect([lock > 1000, carry > 1000]).toEqual([true, true]);
    expect([seen[0][2] > 50, seen[1][2]]).toEqual([true, 0]);
    // nothing painted where no lock was built: the same part lifting off
    const lifting = await client.result([], version, { printing, split: { cuts: [partCut('c1', lid.centre, lid.face, lid.r, { hold: 'lift' })] } });
    expect([lifting.display.marks, lifting.display.markRanges]).toEqual([[], []]);
    expect((await client.call('ping', {})).caches.carved).toBe(1);
    // the parts gone, so is what they kept: with no cut at all, or only full ones
    await client.result([], version, { printing });
    expect((await client.call('ping', {})).caches.carved).toBe(0);
    await client.result([], version, { printing, split: { cuts: [partCut('c1', lid.centre, lid.face, lid.r)] } });
    expect((await client.call('ping', {})).caches.carved).toBe(1);
    await client.result([], version, { printing, split: { cuts: [{ id: 'c1', position: [0, 0, 100], normal: [0, 0, 1] }] } });
    expect((await client.call('ping', {})).caches.carved).toBe(0);
  });

  it("takes only the base out, the top left on: its fit test is a ring and a plug with its lock, and the notes and the glue sheet say so", async () => {
    await load(batLanternSolid().scale([3, 3, 3]));
    const table = await client.parts([], version, { printing, split: {} });
    const base = table.parts.find((e) => e.kind === 'plug');
    const split = (hold) => ({ clearance: 0.15, cuts: [partCut('c1', base.centre, base.face, base.r, { hold })] });
    // the base alone: no twist-lock rings, but its own coupon, the ring of its bore and a short plug
    const fit = await client.fitTest([], version, { printing, split: split('lock'), name: 'bat' });
    expect(fit.stl).not.toBeNull();
    expect(fit.name).toBe('bat-fit-test');
    expect(fit.twist).toBeUndefined();
    expect(fit).toMatchObject({ pins: false, pegs: false, dovetail: false, apart: null, plug: { R: 21.4, opening: 42.8, theta: 23, d: 56.2, grams: 12 } });
    expect(stlFileCheck(fit.stl)).toEqual({ degenerate: 0, open: 0 });
    const coupon = solidOf(fit);
    try {
      const bodies = coupon.decompose();
      const boxes = bodies.map((x) => x.boundingBox());
      const volumes = bodies.map((x) => x.volume());
      bodies.forEach((x) => x.delete());
      // the ring as wide as the plug rule's least ring round a 21.4 mm bore, the plug its lugs past its face; each on
      // the bed as it prints, as tall as the lock and a millimetre over it; together 12 g of PLA
      expect(boxes.map((b) => [+(b.max[0] - b.min[0]).toFixed(1), b.min[2], +b.max[2].toFixed(2)])).toEqual([[56.2, 0, 6.4], [42.7, 0, 6.4]]);
      expect(Math.round((volumes[0] + volumes[1]) * 1.24e-3)).toBe(12);
    } finally {
      coupon.delete();
    }
    const ex = await exportFiles(split('lock'));
    expect(ex.pieces.map((p) => [p.name, p.part ?? null])).toEqual([['piece 1 of 2', null], ['Base', 'c1']]);
    const note = ex.notes.find((n) => n.code === 'PART_FIT');
    expect(note).toMatchObject({ plug: { d: 56.2, grams: 12, name: 'Base' } });
    expect(note.text).toBe(
      "Print the fit test first (Download fit test): a ring Ø 56 mm and a plug with the base's twist-lock, about 12 g. If the plug won't twist into the ring, raise the Clearance by 0.05 mm and print them again; if it rattles or doesn't click, lower it. Most printers need 0.15–0.25 mm, and PETG 0.25–0.3.",
    );
    const glue = ex.files.find((f) => f.kind === 'text').text;
    // nothing is glued: the sheet is for printing the pieces and fitting the base, and is called so – glued as well
    // (a cut across the middle), it is the glue sheet again
    expect(ex.files.map((f) => f.file)).toEqual(['bat-piece-1-of-2.stl', 'bat-piece-2-of-2.stl', 'bat-how-to-print-and-fit.txt']);
    const both = await exportFiles({ ...split('lock'), cuts: [...split('lock').cuts, { id: 'c2', position: [0, 0, 75], normal: [0, 0, 1] }], joint: 'none' });
    expect(both.files.filter((f) => f.kind === 'text').map((f) => f.file)).toEqual(['bat-how-to-glue.txt']);
    expect(glue).toContain('  Not sure about the fit? Print the fit test first (Split card → Download fit test): a ring Ø 56 mm with a plug, about 12 g.');
    expect(glue).toContain("  The base (cut A) should twist in with a click and twist out again by hand. Try the fit test first: if its plug is too stiff to turn in its ring, raise Clearance by 0.05 mm; if it rattles or doesn't click, lower it.");
    // a base that only lifts out has no lock to try: no file, and no note sends you to one
    const lifts = await client.fitTest([], version, { printing, split: split('lift'), name: 'bat' });
    expect([lifts.stl, lifts.plug]).toEqual([null, undefined]);
    expect((await exportFiles(split('lift'))).notes.map((n) => n.code)).not.toContain('PART_FIT');
  });

  const baseOf = (table) => table.parts.find((e) => e.kind === 'plug');
  it('raised text under the bottom is where the base\'s lock goes: on the model alone and on the final result alike, the base gets none, and why', async () => {
    await load(batLanternSolid().scale([3, 3, 3]));
    const under = topItem('HI', { position: [0, 0, 0], normal: [0, 0, -1], size: 10, depth: 1.4 });
    // the card's table before the final result is built: read on the model alone, the text under it counted all the same
    const sketch = await client.parts([under], version, { printing, split: {} });
    expect(sketch.estimate).toBe(true);
    expect(baseOf(sketch)).toMatchObject({ lock: null, limit: 'under', least: { lock: null, tea: null } });
    // the same once the final result is built: the finder reads the letters under the bottom
    await client.result([under], version, { printing });
    const built = await client.parts([under], version, { printing, split: {} });
    expect(built.estimate).toBeUndefined();
    expect(baseOf(built)).toMatchObject({ lock: null, limit: 'under' });
    // and no text there: the base locks, on either
    expect(baseOf(await client.parts([], version, { printing, split: {} })).lock).toMatchObject({ mech: 'plug', R: 21.4 });
  }, 120000);

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
      // asked to lock at 100 %, where none fits: from what size one does, read off the parts table, and the base's
      'warn PART_SMALL: Cut A: the dome is 0.7 mm thick here and slopes 30° – too thin for a twist-lock at 100 %. A twist-lock fits from 275 % (a 24 mm opening); a 38 mm tea light needs 365 %. The base can twist off from 215 %. At this size the dome and cap just lift off.',
    ]);
    expect(r.ex.seams[0].at).toBe(29);
    expect(r.ex.seams[0].apart).toMatchObject({ hold: 'lock', mech: null, why: 'room', small: { now: 100, lock: 275, opening: 24.12, tea: 365, base: 215, wall: { t: 0.73 } } });
    // the base asked to lock at 100 %: too thin a ring round its bore, which carries one from 215 %
    r = await one(partCut('c1', [0, 0], 0, 8.9387));
    expect(r.notes).toEqual([
      'warn PART_SMALL: Cut A: the base has no room for a twist-lock at 100 %. A twist-lock fits from 215 % (a 30 mm opening); a 38 mm tea light needs 275 %. At this size the base just lifts out.',
    ]);
    expect(r.ex.seams[0].apart).toMatchObject({ mech: null, why: 'wall', small: { lock: 215, base: null } });
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

  it("cuts a tea-light seat into the base's top where it has room: one clean piece, its lock untouched, a light standing in it clear of the lantern", async () => {
    const { Manifold } = wasm;
    const kept = [];
    const own = (m) => {
      kept.push(m);
      return m;
    };
    // the fixture with nothing on its floor at 400 %: its base's top is a flat floor 26.4 mm over the bed
    await load(batLanternSolid({ cup: false }).scale([4, 4, 4]));
    const table = await client.parts([], version, { printing, split: {} });
    const base = table.parts.find((e) => e.kind === 'plug');
    expect(base).toMatchObject({ r: 28.8, lock: { mech: 'plug', teaLight: true }, seat: { d: 39.5, r: 19.75, lead: 0.6, zf: 23.4 } });
    const cut = (seat, hold = 'lock') => {
      const c = partCut('c1', base.centre, base.face, base.r, { hold });
      return { ...c, part: { ...c.part, ...(seat == null ? {} : { seat }) } };
    };
    const files = async (seat, hold) => {
      const ex = await exportFiles({ cuts: [cut(seat, hold)] });
      const placed = ex.files.filter((f) => f.stl).map((f) => {
        const m = solidOf(f);
        const w = m.transform(f.matrix);
        m.delete();
        return w;
      });
      return { ex, placed };
    };
    const seated = await files(true);
    const plain = await files(false);
    const unasked = await files(null);
    try {
      const [body, plug] = seated.placed;
      const [body0, plug0] = plain.placed;
      // one piece each, clean for a slicer
      expect([body, plug].map((m) => m.decompose().map((x) => (x.delete(), 1)).length)).toEqual([1, 1]);
      for (const f of seated.ex.files.filter((x) => x.stl)) expect([f.file, stlFileCheck(f.stl)]).toEqual([f.file, { degenerate: 0, open: 0 }]);
      // the seat: what the base lost, round its axis from its floor 23.4 up to its top, 40.7 mm across at its lead-in;
      // nothing added, and a part saved without a seat, or with it off, gets none
      const took = plug0.subtract(plug);
      const b = took.boundingBox();
      expect(b.min[2]).toBeCloseTo(23.4, 4);
      expect(b.max[2]).toBeCloseTo(26.4, 4);
      for (const k of [0, 1]) {
        expect(b.min[k]).toBeCloseTo(base.centre[k] - 20.35, 2);
        expect(b.max[k]).toBeCloseTo(base.centre[k] + 20.35, 2);
      }
      const pocket = Math.PI * 19.75 ** 2 * 3;
      expect(took.volume()).toBeGreaterThan(pocket);
      expect(took.volume()).toBeLessThan(pocket + Math.PI * 2 * 20.05 * 0.18 + 1);
      expect(own(plug.subtract(plug0)).volume()).toBe(0);
      took.delete();
      expect(unasked.placed[1].volume()).toBe(plug0.volume());
      // the lock and the coin slot under it as they were, on the base and in the lantern
      const under = own(Manifold.cube([200, 200, 24.4]).translate([-100, -100, -1]));
      expect(own(plug0.intersect(under)).volume()).toBeCloseTo(own(plug.intersect(under)).volume(), 2);
      expect(own(own(plug0.intersect(under)).subtract(plug)).volume()).toBeLessThan(0.01);
      expect(body.volume()).toBe(body0.volume());
      // a light standing in it, wax or LED, 38 or 39 mm across, meets neither the base nor the lantern over it
      for (const [d, h] of [[38, 16], [39, 16], [38, 45]]) {
        const light = own(Manifold.cylinder(h, d / 2, d / 2, 128).translate([base.centre[0], base.centre[1], 23.4 + 1e-3]));
        expect([d, h, own(plug.intersect(light)).volume(), own(body.intersect(light)).volume()]).toEqual([d, h, 0, 0]);
      }
      // and it is held there: a 38 mm light moved 0.8 mm off the middle runs into the seat's wall
      const off = own(Manifold.cylinder(2, 19, 19, 128).translate([base.centre[0] + 0.8, base.centre[1], 23.5]));
      expect(own(plug.intersect(off)).volume()).toBeGreaterThan(0);
    } finally {
      [...seated.placed, ...plain.placed, ...unasked.placed, ...kept].forEach((m) => m.delete());
    }
    // what the seam, the notes, the pieces and the glue sheet say of it
    const { ex } = seated;
    expect(ex.seams[0].apart.seat).toEqual({ d: 39.5, depth: expect.closeTo(3, 2) });
    expect(ex.seams[0].part).toMatchObject({ seat: { d: 39.5, zf: 23.4 }, wantsSeat: true });
    expect(plain.ex.seams[0].apart).not.toHaveProperty('seat');
    expect(ex.notes.find((n) => n.code === 'PART_PLUG').text).toBe(
      "Cut A: the base (piece 2) twists off underneath, and a 38 mm tea light sits in the seat on top of it (Ø 39.5 mm, 3 mm deep). To fit it: stand the light in the seat, hold piece 1 up and, looking at the base's bottom, set the base in turned 17° to the left, push it in and turn it right until it clicks – a coin in its slot helps. To open it: turn it left until it clicks and lower it out. Use an LED tea light: a flame's heat softens the plastic over it.",
    );
    expect(ex.assembly[0]).toContain('Base: a 38 mm tea light sits in the seat on top of the base (Ø 39.5 mm, 3 mm deep) – stand the light in it, hold piece 1 up');
    const glue = ex.files.find((f) => f.kind === 'text').text;
    expect(glue).toMatch(/piece 2 of 2 .*comes off at cut A \(the base\), tea-light seat Ø 39\.5 mm on top\n/);
    expect(glue).toContain('  A 38 mm tea light should drop into the seat on top of the base (cut A) and lift out with two fingers.');
    // the pieces view paints the seat apart from the lock, and puts its word on it, on the base
    const shown = await client.result([], version, { printing, split: { clearance: 0.15, cuts: [cut(true)] } });
    expect(shown.display.marks.map((m) => m.kind)).toEqual(['lock', 'carry', 'lug', 'seat']);
    const seatMark = shown.display.marks.findIndex((m) => m.kind === 'seat');
    const painted = shown.display.markRanges.filter(([, , m]) => m === seatMark).reduce((n, [, count]) => n + count, 0);
    expect(painted).toBeGreaterThan(100);
    expect(shown.display.lockLabels.filter((x) => x.name === 'tea-light seat')).toEqual([{ cutId: 'c1', name: 'tea-light seat', piece: 2, at: [expect.closeTo(base.centre[0], 6), expect.closeTo(base.centre[1], 6), expect.closeTo(26.4, 2)] }]);
    // a base that lifts out has its seat too, and says so; the view paints it and names it, with no lock round it
    const lifting = await exportFiles({ cuts: [cut(true, 'lift')] });
    expect(lifting.seams[0].apart).toMatchObject({ mech: null, seat: { d: 39.5 } });
    expect(lifting.notes.map((n) => n.code)).toEqual(['SPLIT', 'PART_LIFTS', 'PART_SEAT']);
    const lifted = await client.result([], version, { printing, split: { clearance: 0.15, cuts: [cut(true, 'lift')] } });
    expect(lifted.display.marks.map((m) => m.kind)).toEqual(['seat']);
    expect(lifted.display.markRanges.length).toBeGreaterThan(0);
    expect(lifted.display.lockLabels.map((x) => [x.name, x.piece])).toEqual([['tea-light seat', 2]]);

    // the switch is cheap: the base is carved once, and only drilled again
    progress.length = 0;
    await exportFiles({ cuts: [cut(false)] });
    expect(progress).not.toContain('Cutting the base…');
  });

  it("cuts the seat in place of the base's own cup where that stands in the middle of its top, and says so; where none fits, says why in a note to read, not a warning", async () => {
    const { Manifold } = wasm;
    const kept = [];
    const own = (m) => {
      kept.push(m);
      return m;
    };
    // the fixture as the user's lantern is, a cup 34 mm across standing 7.8 mm on its floor at 400 %
    await load(batLanternSolid().scale([4, 4, 4]));
    const base = (await client.parts([], version, { printing, split: {} })).parts.find((e) => e.kind === 'plug');
    expect(base.seat).toMatchObject({ d: 39.5, zf: 23.4, clears: { across: expect.closeTo(34.4, 4) } });
    expect(base.seat.clears.top).toBeGreaterThan(34 + 1);
    const c = partCut('c1', base.centre, base.face, base.r);
    const asked = await exportFiles({ cuts: [{ ...c, part: { ...c.part, seat: true } }] });
    const kept0 = await exportFiles({ cuts: [{ ...c, part: { ...c.part, seat: false } }] });
    const placed = (ex) => {
      const f = ex.files.find((x) => x.index === 2);
      const m = solidOf(f);
      const w = m.transform(f.matrix);
      m.delete();
      return own(w);
    };
    try {
      const [plug, plug0] = [placed(asked), placed(kept0)];
      // one clean piece, its cup gone and the pocket in its place: nothing over the floor inside the seat
      expect(plug.decompose().map((x) => (x.delete(), 1)).length).toBe(1);
      expect(stlFileCheck(asked.files.find((x) => x.index === 2).stl)).toEqual({ degenerate: 0, open: 0 });
      const inside = (m, z0, z1) => own(m.intersect(own(Manifold.cylinder(z1 - z0, 19.7, 19.7, 128).translate([base.centre[0], base.centre[1], z0])))).volume();
      expect(inside(plug0, 26.5, 34)).toBeGreaterThan(400);
      expect(inside(plug, 23.45, 40)).toBe(0);
      // the lock under it as it was
      const under = own(Manifold.cube([200, 200, 23.4]).translate([-100, -100, -1]));
      expect(own(plug.intersect(under)).volume()).toBeCloseTo(own(plug0.intersect(under)).volume(), 2);
      // the LED tea light the notes say to use stands in it clear of the base and the lantern
      const light = own(Manifold.cylinder(45, 19, 19, 128).translate([base.centre[0], base.centre[1], 23.4 + 1e-3]));
      expect(own(plug.intersect(light)).volume()).toBe(0);
      // the base comes out lower than it was cut, its cup gone: the pieces and the file say so; with the cup kept, as
      // tall as it was
      const height = (m) => m.boundingBox().max[2] - m.boundingBox().min[2];
      expect(height(plug)).toBeLessThan(27);
      expect(height(plug0)).toBeGreaterThan(33.9);
      expect(asked.pieces[1].size[2]).toBeCloseTo(height(plug), 6);
      expect(asked.files.find((x) => x.index === 2).size[2]).toBeCloseTo(height(plug), 6);
      expect(kept0.pieces[1].size[2]).toBeCloseTo(height(plug0), 3);
    } finally {
      kept.forEach((m) => m.delete());
      kept.length = 0;
    }
    expect(asked.seams[0].apart.seat).toEqual({ d: 39.5, depth: expect.closeTo(3, 2), clears: { h: expect.closeTo(7.6, 0), across: expect.closeTo(34.4, 4) } });
    expect(kept0.seams[0].apart).not.toHaveProperty('seat');
    const note = asked.notes.find((n) => n.code === 'PART_PLUG');
    expect(note.text).toMatch(/^Cut A: the base \(piece 2\) twists off underneath, and a 38 mm tea light sits in the seat on top of it \(Ø 39\.5 mm, 3 mm deep\), in place of the model's own detail there \(7\.\d mm proud, Ø 34 mm across\)\. To fit it: stand the light in the seat, /);
    expect(note.text).toMatch(/ To keep that detail instead, untick Tea-light seat\.$/);
    expect(asked.notes.some((n) => n.level === 'warn' || n.code === 'PART_NO_SEAT')).toBe(false);
    // the seat's wall is two of the nozzle's lines: at 300 % a 0.4 mm nozzle's fit round it, a 0.6 mm one's do not –
    // read again when only the nozzle changes, on a base that lifts out as on one that locks
    await load(batLanternSolid({ cup: false }).scale([3, 3, 3]));
    const b3 = (await client.parts([], version, { printing, split: {} })).parts.find((e) => e.kind === 'plug');
    const lift3 = partCut('c1', b3.centre, b3.face, b3.r, { hold: 'lift' });
    const seat3 = { ...lift3, part: { ...lift3.part, seat: true } };
    expect((await exportFiles({ cuts: [seat3] })).seams[0].apart.seat).toMatchObject({ d: 39.5 });
    const wide = await exportFiles({ cuts: [seat3] }, { nozzle: 0.6, layerHeight: 0.2 });
    expect(wide.seams[0].part.seat).toEqual({ why: 'room', opening: 42.8, need: 43.4 });
    expect(wide.seams[0].apart).not.toHaveProperty('seat');
    // the seat is asked for wherever one fits, so none fitting is a note to read, not a warning to act on (the app makes
    // a warning its red status line)
    expect(wide.notes.find((n) => n.code === 'PART_NO_SEAT')).toMatchObject({
      level: 'info', why: 'room', text: 'Cut A: no tea-light seat on the base (piece 2) – it is too narrow to keep a wall round one – that takes a Ø 43.4 mm opening.',
    });
    expect(wide.notes.some((n) => n.level === 'warn')).toBe(false);
    // at 100 % no tea light goes into the base at all: its note says from what size one does, and nothing more is said
    await load(batLanternSolid({ cup: false }));
    const small = (await client.parts([], version, { printing, split: {} })).parts.find((e) => e.kind === 'plug');
    expect(small.seat).toMatchObject({ why: 'narrow' });
    const s = partCut('c1', small.centre, small.face, small.r);
    const tiny = await exportFiles({ cuts: [{ ...s, part: { ...s.part, seat: true } }] });
    expect(tiny.notes.map((n) => n.code)).toEqual(['SPLIT', 'PART_SMALL']);
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
    expect(ex.notes.map((n) => n.code)).toEqual(['SPLIT', 'PART_LOCK', 'PART_PRINT', 'PART_FIT']);
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
