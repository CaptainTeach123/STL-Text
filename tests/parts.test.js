import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createEngine, plateShape } from '../src/engine.js';
import { createEngineClient, createLocalWorker } from '../src/engineClient.js';
import { createItem, createPart } from '../src/document.js';
import { manifold } from '../src/manifold.js';
import { parseSTL, writeBinarySTL } from '../src/stl.js';
import { geometryToManifold } from '../src/mesh.js';
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
const BASE_VOLUME = 60 * 30 * 6;
const PART = [20, 6, 3]; // a small bar: 360 mm³

beforeAll(async () => {
  await setup();
  wasm = manifold();
  const engine = createEngine({ wasm });
  client = createEngineClient({ createWorker: () => createLocalWorker(Promise.resolve(engine)) });
  await client.addFont('inter', fontBytes('inter', 'inter-latin-700-normal.woff'));
  const bar = wasm.Manifold.cube(PART, true);
  const r = await client.addPart('bar', stlOf(bar), 'bar');
  expect(r.info.size.map(Math.round)).toEqual(PART);
  bar.delete();
});

const loadBox = async () => {
  const box = wasm.Manifold.cube([60, 30, 6], true);
  await client.loadBase({ kind: 'stl', bytes: stlOf(box), name: 'box', version: ++version });
  box.delete();
};
const onTop = (extra = {}) => createPart('bar', 'bar', { position: [0, 0, 3], normal: [0, 0, 1], ...extra });

describe('attached parts', () => {
  it('fuses a part into the model, sunk by the chosen depth', async () => {
    await loadBox();
    const ex = await client.export([onTop({ join: 'fuse', sink: 0.4 })], version, 'x');
    const added = volumeOfStl(ex.stl) - BASE_VOLUME;
    expect(added).toBeCloseTo(360 - 20 * 6 * 0.4, 0); // the sunk slice is shared with the model
    const m = solidOfStl(ex.stl);
    expect(m.decompose().length).toBe(1);
    expect(m.boundingBox().max[2]).toBeCloseTo(3 + 3 - 0.4, 3);
    m.delete();
  });

  it('a fillet skirt adds material around the foot and stays one solid', async () => {
    await loadBox();
    const plain = await client.export([onTop({ join: 'fuse' })], version, 'x');
    const filleted = await client.export([onTop({ join: 'fillet', filletRadius: 1.5 })], version, 'x');
    const extra = volumeOfStl(filleted.stl) - volumeOfStl(plain.stl);
    // a quarter-round fillet of radius r around a perimeter P adds about (1 - π/4)·r²·P
    const perimeter = 2 * (PART[0] + PART[1]);
    const expected = (1 - Math.PI / 4) * 1.5 * 1.5 * perimeter;
    expect(extra).toBeGreaterThan(expected * 0.6);
    expect(extra).toBeLessThan(expected * 1.6);
    const m = solidOfStl(filleted.stl);
    expect(m.decompose().length).toBe(1);
    m.delete();
    const preview = await client.preview(onTop({ join: 'fillet', filletRadius: 1.5 }), version);
    expect(preview.part.name).toBe('bar');
    expect(preview.bounds.min[2]).toBeLessThan(-0.3); // the skirt reaches into the surface
  });

  it('pegs: the model gets holes and the part is exported separately with pegs', async () => {
    await loadBox();
    const item = onTop({ join: 'pegs', pegCount: 2, pegDiameter: 3, pegLength: 5, pegClearance: 0.15 });
    const ex = await client.export([item], version, 'x');
    const holeRadius = 1.5 + 0.15;
    const removed = BASE_VOLUME - volumeOfStl(ex.stl);
    expect(removed).toBeCloseTo(2 * Math.PI * holeRadius * holeRadius * 5.15, -1); // two holes 5.15 deep (length + clearance)
    expect(ex.extra).toHaveLength(1);
    expect(ex.extra[0].name).toBe('bar');
    const part = solidOfStl(ex.extra[0].stl);
    expect(part.volume()).toBeCloseTo(360 + 2 * Math.PI * 1.5 * 1.5 * 5, -1); // bar + two pegs
    expect(part.boundingBox().min[2]).toBeCloseTo(3 - 5, 2); // pegs hang 5 mm below the contact plane (z = 3)
    part.delete();
    const r = await client.result([item], version);
    expect(r.notes.map((n) => n.code)).toEqual([]);
    expect(r.display.index.length).toBeGreaterThan(0);
  });

  it('attach side, scale and tilt change the part orientation', async () => {
    await loadBox();
    const bottom = await client.preview(onTop(), version);
    expect(bottom.bounds.max[2]).toBeCloseTo(3 - 0.4, 3); // 3 mm tall bar, sunk 0.4
    const front = await client.preview(onTop({ attach: 'front' }), version);
    expect(front.bounds.max[2]).toBeCloseTo(6 - 0.4, 3); // standing on its 6 mm side
    expect(front.size[0]).toBeCloseTo(20, 3);
    const left = await client.preview(onTop({ attach: 'left' }), version);
    expect(left.bounds.max[2]).toBeCloseTo(20 - 0.4, 3); // standing on its end
    const doubled = await client.preview(onTop({ scale: 2 }), version);
    expect(doubled.size[0]).toBeCloseTo(40, 3);
    const tilted = await client.preview(onTop({ tilt: 30 }), version);
    expect(tilted.bounds.max[2]).toBeGreaterThan(bottom.bounds.max[2]); // leaning raises one edge
  });

  it('a part can also cut into the model, and a missing part is reported', async () => {
    await loadBox();
    const ex = await client.export([onTop({ mode: 'engrave', sink: 1 })], version, 'x');
    expect(BASE_VOLUME - volumeOfStl(ex.stl)).toBeCloseTo(20 * 6 * 1, 0);
    await expect(client.preview(createPart('nope', 'nope', { position: [0, 0, 3] }), version)).rejects.toMatchObject({ code: 'PART_MISSING', details: { partIds: ['nope'] } });
    await expect(client.addPart('open', writeBinarySTL(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])), 'open')).rejects.toMatchObject({ code: 'PART_INVALID' });
  });

  it('parts are rehydrated after a restart', async () => {
    const engines = [];
    const c2 = createEngineClient({
      createWorker: () => {
        const e = createEngine({ wasm });
        engines.push(e);
        return createLocalWorker(Promise.resolve(e));
      },
    });
    const bar = wasm.Manifold.cube(PART, true);
    await c2.addPart('bar', stlOf(bar), 'bar');
    const box = wasm.Manifold.cube([60, 30, 6], true);
    await c2.loadBase({ kind: 'stl', bytes: stlOf(box), name: 'box', version: 1 });
    c2.restart();
    const r = await c2.preview(onTop(), 1);
    expect(r.geometry.positions.length).toBeGreaterThan(0);
    expect((await c2.call('ping', {})).parts).toEqual(['bar']);
    engines.forEach((e) => e.dispose());
    bar.delete();
    box.delete();
  });
});

describe('text on a plate', () => {
  const text = (extra = {}) => createItem({ text: 'Hi', fontId: 'inter', size: 8, position: [0, 0, 3], normal: [0, 0, 1], ...extra });

  it('plaque: the plate is larger than the text by the padding and carries raised text', async () => {
    await loadBox();
    const bare = await client.preview(text(), version);
    const plated = await client.preview(text({ plate: 'plaque', platePadding: 3, plateThickness: 2, depth: 1 }), version);
    expect(plated.size[0]).toBeCloseTo(bare.size[0] + 6, 1);
    expect(plated.size[1]).toBeCloseTo(bare.size[1] + 6, 1);
    expect(plated.bounds.max[2]).toBeCloseTo(2 + 1, 3); // plate top + text height
    expect(plated.bounds.min[2]).toBeCloseTo(-0.4, 3); // the plate sinks by the overlap
    const ex = await client.export([text({ plate: 'plaque', plateThickness: 2, depth: 1 })], version, 'x');
    const m = solidOfStl(ex.stl);
    expect(m.decompose().length).toBe(1);
    expect(m.volume()).toBeGreaterThan(BASE_VOLUME + plated.size[0] * plated.size[1] * 2 * 0.7);
    m.delete();
  });

  it('cut-in text on a plate is engraved into the plate, which is still raised on the model', async () => {
    await loadBox();
    const raised = await client.preview(text({ plate: 'plaque', plateThickness: 2, depth: 1, mode: 'emboss' }), version);
    const cut = await client.preview(text({ plate: 'plaque', plateThickness: 2, depth: 1, mode: 'engrave' }), version);
    expect(cut.bounds.max[2]).toBeCloseTo(2, 3);
    expect(cut.notes.map((n) => n.code)).not.toContain('ENGRAVE_UNAVAILABLE');
    const exRaised = await client.export([text({ plate: 'plaque', plateThickness: 2, depth: 1, mode: 'emboss' })], version, 'x');
    const exCut = await client.export([text({ plate: 'plaque', plateThickness: 2, depth: 1, mode: 'engrave' })], version, 'x');
    expect(volumeOfStl(exCut.stl)).toBeLessThan(volumeOfStl(exRaised.stl));
    expect(volumeOfStl(exCut.stl)).toBeGreaterThan(BASE_VOLUME); // the plate still adds material
    void raised;
    // on a model with gaps a plated cut-in text is still fine (it only cuts the plate)
    const open = new Float32Array([0, 0, 0, 30, 0, 0, 0, 30, 0]);
    await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(open), name: 'open', version: ++version });
    const r = await client.preview(text({ plate: 'plaque', mode: 'engrave', position: [8, 8, 0] }), version);
    expect(r.notes.map((n) => n.code)).not.toContain('ENGRAVE_UNAVAILABLE');
  });

  it('banner outline has swallow tails and is wider than a plaque of the same text', () => {
    const plaque = plateShape(wasm, 'plaque', 30, 10);
    const banner = plateShape(wasm, 'banner', 30, 10);
    const pb = plaque.bounds();
    const bb = banner.bounds();
    expect(bb.max[0] - bb.min[0]).toBeGreaterThan(pb.max[0] - pb.min[0]);
    expect(banner.area()).toBeLessThan((bb.max[0] - bb.min[0]) * 10); // the notches take area away
    expect(plaque.numContour()).toBe(1);
    plaque.delete();
    banner.delete();
  });
});

describe('display level of detail', () => {
  it('dense models are shown simplified but exported in full', async () => {
    const dense = wasm.Manifold.sphere(20, 200); // 20 000 triangles
    const engine = createEngine({ wasm, lodTriangles: 5000, lodTolerance: 0.05 });
    const c = createEngineClient({ createWorker: () => createLocalWorker(Promise.resolve(engine)) });
    const r = await c.loadBase({ kind: 'stl', bytes: stlOf(dense), name: 'ball', version: 1 });
    expect(r.info.triangles).toBe(dense.numTri());
    expect(r.info.simplifiedView).toBe(true);
    expect(r.info.displayTriangles).toBeLessThan(dense.numTri() / 2);
    expect(r.display.index.length / 3).toBe(r.info.displayTriangles);
    const ex = await c.export([], 1, 'ball');
    expect(ex.triangles).toBe(dense.numTri());
    const small = await c.loadBase({ kind: 'sample', version: 2 });
    expect(small.info.simplifiedView).toBe(false);
    engine.dispose();
    dense.delete();
  });
});
