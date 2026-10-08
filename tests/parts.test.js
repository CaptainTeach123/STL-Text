import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createEngine, plateShape } from '../src/engine.js';
import { createEngineClient, createLocalWorker } from '../src/engineClient.js';
import { createItem, createPart } from '../src/document.js';
import { sideFacing, snapPartTo } from '../src/placement.js';
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
    expect(part.decompose().length).toBe(1);
    // the downloaded part lies on its face with the pegs pointing up, ready to print
    const pb = part.boundingBox();
    expect(pb.min[2]).toBeCloseTo(0, 3);
    expect(pb.max[2]).toBeCloseTo(3 + 5, 2);
    const body = part.slice(1);
    const pegTops = part.slice(7);
    expect(body.area()).toBeCloseTo(20 * 6, 0);
    expect(pegTops.area()).toBeCloseTo(2 * Math.PI * 1.5 * 1.5, 0);
    body.delete();
    pegTops.delete();
    part.delete();
    const r = await client.result([item], version);
    expect(r.notes.map((n) => n.code)).toEqual([]);
    expect(r.display.index.length).toBeGreaterThan(0);
    expect((await client.preview(item, version)).notes.map((n) => n.code)).toEqual(['PEGS']);
  });

  it('pegs only go where they fit: one under each foot of a bridge, none under a part too small for them', async () => {
    await loadBox();
    // a bridge: two 4×6 feet 20 mm apart joined by a bar on top
    const foot = wasm.Manifold.cube([4, 6, 4], true);
    const bar = wasm.Manifold.cube([24, 6, 2], true).translate(0, 0, 3);
    const bridge = wasm.Manifold.union([foot.translate(-10, 0, 0), foot.translate(10, 0, 0), bar]);
    await client.addPart('bridge', stlOf(bridge), 'bridge');
    const item = createPart('bridge', 'bridge', { position: [0, 0, 3], normal: [0, 0, 1], join: 'pegs', pegCount: 2, pegDiameter: 2, pegLength: 4 });
    const ex = await client.export([item], version, 'x');
    const part = solidOfStl(ex.extra[0].stl);
    expect(part.decompose().length).toBe(1); // no loose pegs floating in the gap
    expect(part.volume()).toBeCloseTo(bridge.volume() + 2 * Math.PI * 1 * 1 * 4, -1);
    const pegTops = part.slice(part.boundingBox().max[2] - 1);
    expect(pegTops.decompose().length).toBe(2);
    const xs = pegTops.decompose().map((p) => (p.bounds().min[0] + p.bounds().max[0]) / 2).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-10, 0); // one peg centred under each foot
    expect(xs[1]).toBeCloseTo(10, 0);
    pegTops.delete();
    part.delete();
    const r = await client.preview(item, version);
    expect(r.notes.map((n) => n.code)).toEqual(['PEGS']);
    // a peg wider than the part cannot fit: nothing is cut and the user is told
    const wide = createPart('bar', 'bar', { position: [0, 0, 3], normal: [0, 0, 1], join: 'pegs', pegCount: 2, pegDiameter: 8, pegLength: 4 });
    const r2 = await client.preview(wide, version);
    expect(r2.notes.map((n) => n.code)).toContain('PEGS_DROPPED');
    const ex2 = await client.export([wide], version, 'x');
    expect(ex2.extra).toHaveLength(0);
    expect(volumeOfStl(ex2.stl)).toBeGreaterThan(BASE_VOLUME); // fused instead, no holes
    bridge.delete();
    bar.delete();
    foot.delete();
  });

  it('pegs need holes: without a watertight model the part is fused and the user is told', async () => {
    const open = new Float32Array([0, 0, 0, 30, 0, 0, 0, 30, 0]);
    await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(open), name: 'open', version: ++version });
    const item = createPart('bar', 'bar', { position: [8, 8, 0], normal: [0, 0, 1], join: 'pegs', pegCount: 2, pegDiameter: 3, pegLength: 5 });
    const r = await client.preview(item, version);
    expect(r.notes.map((n) => n.code)).toContain('PEGS_UNAVAILABLE');
    expect(r.notes.map((n) => n.code)).not.toContain('PEGS');
    const ex = await client.export([item], version, 'x');
    expect(ex.extra).toHaveLength(0);
    // and without any model the part itself is downloaded, sitting on the build plate
    await client.loadBase({ kind: 'none', version: ++version });
    const alone = await client.export([createPart('bar', 'bar', { join: 'pegs', sink: 1 })], version, 'x');
    expect(alone.extra).toHaveLength(0);
    const m = solidOfStl(alone.stl);
    expect(m.boundingBox().min[2]).toBeCloseTo(0, 3);
    expect(m.volume()).toBeCloseTo(360, 0);
    m.delete();
  });

  it('a fillet never grows taller than a thin part, and a turned part rests on whatever is lowest', async () => {
    await loadBox();
    const thin = wasm.Manifold.cube([20, 10, 1], true);
    await client.addPart('thin', stlOf(thin), 'thin');
    const plate = createPart('thin', 'thin', { position: [0, 0, 3], normal: [0, 0, 1], join: 'fillet', filletRadius: 1.5, sink: 0.4 });
    const p = await client.preview(plate, version);
    expect(p.bounds.max[2]).toBeCloseTo(1 - 0.4, 2); // the skirt stops at the part's top
    const ex = await client.export([plate], version, 'x');
    const m = solidOfStl(ex.stl);
    expect(m.decompose().length).toBe(1);
    expect(m.boundingBox().max[2]).toBeCloseTo(3 + 1 - 0.4, 2);
    m.delete();
    // tilt: the bar leans, its low edge resting on the surface (sunk by the sink), and the user is warned that only an edge touches
    const tilted = await client.preview(onTop({ tilt: 30, sink: 0.4 }), version);
    expect(tilted.bounds.min[2]).toBeCloseTo(-0.4, 2);
    expect(tilted.bounds.max[2]).toBeCloseTo(3 * Math.cos(Math.PI / 6) + 6 * Math.sin(Math.PI / 6) - 0.4, 1);
    expect(tilted.notes.map((n) => n.code)).toContain('EDGE_CONTACT');
    // roll by 90°: the bar stands on its end, a whole face down, centred on the clicked point
    const rolled = await client.preview(onTop({ roll: 90, sink: 0.4 }), version);
    expect(rolled.bounds.max[2]).toBeCloseTo(20 - 0.4, 2);
    expect(rolled.size.map((v) => Math.round(v))).toEqual([3, 6]);
    expect(Math.abs(rolled.bounds.min[0] + rolled.bounds.max[0])).toBeLessThan(0.01);
    expect(rolled.notes.map((n) => n.code)).not.toContain('EDGE_CONTACT');
    // tilt and roll together are one rotation; a part never pokes below its contact plane except by the sink
    const both = await client.preview(onTop({ tilt: 45, roll: 30, sink: 0 }), version);
    expect(both.bounds.min[2]).toBeCloseTo(0, 2);
    // the tilted fillet still hugs the part where it meets the surface
    const tf = await client.export([onTop({ tilt: 30, join: 'fillet', filletRadius: 1.5, sink: 0.4 })], version, 'x');
    const tm = solidOfStl(tf.stl);
    expect(tm.decompose().length).toBe(1);
    tm.delete();
    thin.delete();
  });

  it('a part used as a cutter ignores its connection and cuts as deep as its sink', async () => {
    await loadBox();
    const plain = await client.export([onTop({ mode: 'engrave', sink: 1, join: 'fuse' })], version, 'x');
    const pegged = await client.export([onTop({ mode: 'engrave', sink: 1, join: 'pegs' })], version, 'x');
    const filleted = await client.export([onTop({ mode: 'engrave', sink: 1, join: 'fillet', filletRadius: 2 })], version, 'x');
    expect(pegged.extra).toHaveLength(0);
    expect(volumeOfStl(pegged.stl)).toBeCloseTo(volumeOfStl(plain.stl), 1);
    expect(volumeOfStl(filleted.stl)).toBeCloseTo(volumeOfStl(plain.stl), 1);
    // cutting deeper than the wall is reported against the real cut depth (the sink)
    const through = await client.preview(onTop({ mode: 'engrave', sink: 7 }), version);
    const note = through.notes.find((n) => n.code === 'CUT_THROUGH');
    expect(note).toBeTruthy();
    expect(note.text).toMatch(/^7 mm/);
    const shallow = await client.preview(onTop({ mode: 'engrave', sink: 1 }), version);
    expect(shallow.notes.map((n) => n.code)).not.toContain('CUT_THROUGH');
    // pegs longer than the wall are reported too
    const longPegs = await client.preview(onTop({ join: 'pegs', pegLength: 7 }), version);
    expect(longPegs.notes.map((n) => n.code)).toContain('CUT_THROUGH');
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

describe('parts really merge with the model', () => {
  it('a part placed a little above the surface comes down to rest on it, so the result is one solid', async () => {
    await loadBox();
    const high = onTop({ position: [0, 0, 5] }); // 2 mm above the top of the box (z = 3)
    const p = await client.preview(high, version);
    expect(p.notes.map((n) => n.code)).toContain('SETTLED');
    expect(p.notes.map((n) => n.code)).not.toContain('NOT_TOUCHING');
    expect(p.bounds.min[2]).toBeCloseTo(-2 - 0.4, 2); // lowered by the gap, then sunk
    const ex = await client.export([high], version, 'x');
    expect(ex.notes.map((n) => n.code)).not.toContain('NOT_MERGED');
    const m = solidOfStl(ex.stl);
    expect(m.decompose().length).toBe(1);
    expect(m.boundingBox().max[2]).toBeCloseTo(3 + 3 - 0.4, 2);
    expect(m.volume() - BASE_VOLUME).toBeCloseTo(360 - 20 * 6 * 0.4, 0);
    m.delete();
    // pegs follow the part down: the holes start at the surface, not 2 mm above it
    const pegged = onTop({ position: [0, 0, 5], join: 'pegs', pegCount: 2, pegDiameter: 3, pegLength: 5, pegClearance: 0.15 });
    const exp = await client.export([pegged], version, 'x');
    const holeRadius = 1.65;
    expect(BASE_VOLUME - volumeOfStl(exp.stl)).toBeCloseTo(2 * Math.PI * holeRadius * holeRadius * 5.15, -1);
    // far above the surface it is simply not touching
    const far = onTop({ position: [0, 0, 10] });
    expect((await client.preview(far, version)).notes.map((n) => n.code)).toContain('NOT_TOUCHING');
  });

  it('"Snap to model" lays a part standing on its edge beside the model flat against it, so it merges', async () => {
    await loadBox(); // 60 × 30 × 6, its -Y wall at y = -15
    const plate = wasm.Manifold.cube([20, 6, 1], true); // a thin plate, like a banner
    await client.addPart('plate', stlOf(plate), 'plate');
    plate.delete();
    // standing on its bottom edge (tilt 90) in the air south of the wall, like a banner dropped beside a trophy
    const standing = createPart('plate', 'plate', { position: [0, -19, 0], normal: [0, 0, 1], tilt: 90 });
    const before = await client.preview(standing, version);
    expect(before.notes.map((n) => n.code)).toContain('NOT_TOUCHING');
    expect(before.bounds.max[2] - before.bounds.min[2]).toBeCloseTo(6, 3); // it stands 6 mm tall
    // the UI snaps from the part's centre to the nearest surface point: the wall, whose outward normal is -Y
    expect(sideFacing(standing, [0, 1, 0])).toBe('bottom'); // the big face points at the wall
    const snapped = { ...standing, ...snapPartTo(standing, { point: [0, -15, 0], normal: [0, -1, 0] }) };
    expect(snapped).toMatchObject({ attach: 'bottom', tilt: 0, roll: 0, normal: [0, -1, 0] });
    const after = await client.preview(snapped, version);
    expect(after.notes.map((n) => n.code)).not.toContain('NOT_TOUCHING');
    expect(after.notes.map((n) => n.code)).not.toContain('EDGE_CONTACT');
    expect(after.stats.touches).toBe(true);
    expect(after.bounds.max[2] - after.bounds.min[2]).toBeCloseTo(1, 3); // flat: 1 mm thick along the wall normal
    expect(after.bounds.min[2]).toBeCloseTo(-0.4, 3); // sunk into the wall
    const ex = await client.export([snapped], version, 'x');
    expect(ex.notes.map((n) => n.code)).not.toContain('NOT_MERGED');
    const m = solidOfStl(ex.stl);
    expect(m.decompose().length).toBe(1);
    const bb = m.boundingBox();
    expect(bb.min[1]).toBeCloseTo(-15 - 1 + 0.4, 2); // the plate stands proud of the wall by 0.6 mm
    expect(m.volume() - BASE_VOLUME).toBeCloseTo(20 * 6 * (1 - 0.4), 0);
    m.delete();
  });

  it('a scroll attached by its hollow side is pushed in until its back meets a cane, so it wraps it instead of hovering', async () => {
    // model: a vertical cane on a plinth
    const cane = wasm.Manifold.cylinder(120, 12, 12, 96);
    const plinth = wasm.Manifold.cube([60, 60, 10], true).translate(0, 0, -5);
    const trophy = cane.add(plinth);
    await client.loadBase({ kind: 'stl', bytes: stlOf(trophy), name: 'trophy', version: ++version });
    cane.delete();
    plinth.delete();
    trophy.delete();
    // part: a half-pipe scroll, 40 wide, 60 long, 20 deep; attached by its "bottom" (its hollow side after the turn below)
    const ring = wasm.CrossSection.circle(20, 96).subtract(wasm.CrossSection.circle(17, 96));
    const half = ring.intersect(wasm.CrossSection.square([40, 20]).translate(-20, 0));
    const scroll = wasm.Manifold.extrude(half, 60).rotate([90, 0, 0]);
    await client.addPart('scroll', stlOf(scroll), 'scroll');
    ring.delete();
    half.delete();
    scroll.delete();
    // the scroll beside the cane, hollow side toward it: its tips (40 apart) clear the cane (24 wide) on both sides
    const beside = createPart('scroll', 'scroll', { position: [12, 0, 60], normal: [1, 0, 0], attach: 'bottom' });
    const fitted = await client.preview(beside, version);
    const codes = fitted.notes.map((n) => n.code);
    expect(codes).not.toContain('NOT_TOUCHING');
    expect(codes).toContain('SETTLED');
    expect(fitted.notes.find((n) => n.code === 'SETTLED').text).toMatch(/body meets the model/);
    expect(fitted.stats.settled).toBeGreaterThan(15); // the back of the scroll comes down to the cane (~17 mm)
    expect(fitted.stats.settled).toBeLessThan(20);
    expect(codes).not.toContain('TOO_CURVED'); // notes about stretching letters do not apply to a part
    const ex = await client.export([beside], version, 'x');
    expect(ex.notes.map((n) => n.code)).not.toContain('NOT_MERGED');
    const m = solidOfStl(ex.stl);
    expect(m.decompose().length).toBe(1); // one solid: the cane passes through the scroll's hollow
    m.delete();
    expect(fitted.bounds.max[2]).toBeLessThan(20 - 15); // the scroll sits around the cane (its back ~3 mm out), not 20 mm out in the air
    // without the fit the scroll stays where its tips touch the contact plane: its back hovers 20 mm out
    const loose = await client.preview({ ...beside, fit: false }, version);
    expect(loose.stats.settled ?? 0).toBeLessThan(0.1);
    expect(loose.bounds.max[2]).toBeGreaterThan(19);
  });

  it('a flat plate across a cylinder sinks a little past the tangent line; on flat ground it stays put', async () => {
    const cane = wasm.Manifold.cylinder(120, 12, 12, 96);
    await client.loadBase({ kind: 'stl', bytes: stlOf(cane), name: 'cane', version: ++version });
    cane.delete();
    const plate = wasm.Manifold.cube([40, 30, 3], true);
    await client.addPart('plate', stlOf(plate), 'plate');
    plate.delete();
    const across = createPart('plate', 'plate', { position: [12, 0, 60], normal: [1, 0, 0] });
    const p = await client.preview(across, version);
    expect(p.stats.settled).toBeGreaterThan(0.3);
    expect(p.stats.settled).toBeLessThan(3);
    expect(p.notes.map((n) => n.code)).not.toContain('NOT_TOUCHING');
    const flat = await client.preview({ ...across, fit: false }, version);
    expect(flat.stats.settled ?? 0).toBeLessThan(0.1); // first contact only
    await loadBox();
    const onBox = await client.preview(createPart('plate', 'plate', { position: [0, 0, 3], normal: [0, 0, 1] }), version);
    expect(onBox.stats.settled ?? 0).toBeLessThan(1e-6);
  });

  it('a raised text that hovers without overlapping is reported as not merged', async () => {
    await loadBox();
    const hover = createItem({ text: 'Hi', fontId: 'inter', size: 8, position: [0, 0, 4], normal: [0, 0, 1], conform: false, overlap: 0.4 });
    const ex = await client.export([hover], version, 'x');
    const note = ex.notes.find((n) => n.code === 'NOT_MERGED');
    expect(note).toBeTruthy();
    expect(note.itemId).toBe(hover.id);
    const m = solidOfStl(ex.stl);
    expect(m.decompose().length).toBeGreaterThan(1); // the box plus the loose letters
    m.delete();
    // the same text on the surface merges and gets no such note
    const onIt = createItem({ text: 'Hi', fontId: 'inter', size: 8, position: [0, 0, 3], normal: [0, 0, 1], conform: false, overlap: 0.4 });
    const ex2 = await client.export([onIt], version, 'x');
    expect(ex2.notes.map((n) => n.code)).not.toContain('NOT_MERGED');
  });

  it('on a model with gaps a part explains that it cannot be merged', async () => {
    const open = new Float32Array([0, 0, 0, 30, 0, 0, 0, 30, 0]);
    await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(open), name: 'open', version: ++version });
    const p = await client.preview(createPart('bar', 'bar', { position: [8, 8, 0], normal: [0, 0, 1] }), version);
    expect(p.notes.map((n) => n.code)).toContain('FUSE_UNAVAILABLE');
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
