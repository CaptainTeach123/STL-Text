import { beforeAll, describe, expect, it } from 'vitest';
import { findDetails } from '../src/details.js';
import { manifold } from '../src/manifold.js';
import { setup } from './helpers.js';

let wasm;
beforeAll(async () => {
  await setup();
  wasm = manifold();
});

/** A cane-like cylinder with four berries and two leaves standing on its side, optionally made smudgy. */
function trophyFixture({ noise = 0 } = {}) {
  const { Manifold } = wasm;
  const temps = [];
  const keep = (m) => (temps.push(m), m);
  let model = keep(keep(Manifold.cylinder(60, 12, 12, 96)).refineToLength(0.8)); // an evenly dense mesh, like a generated model
  const berries = [];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const c = [13.2 * Math.cos(a), 13.2 * Math.sin(a), 15 + i * 10];
    berries.push({ center: c, radius: 2.5 });
    model = keep(model.add(keep(Manifold.sphere(2.5, 32).translate(...c))));
  }
  for (let i = 0; i < 2; i++) {
    const a = Math.PI / 4 + i * Math.PI;
    const leaf = keep(keep(Manifold.sphere(1, 48).scale([3, 1.6, 0.9])).rotate([0, 0, (a * 180) / Math.PI + 90]).translate(12.3 * Math.cos(a), 12.3 * Math.sin(a), 30 + i * 8));
    model = keep(model.add(leaf));
  }
  if (noise > 0) {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    model = keep(model.warpBatch((v, n) => {
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) v[i * 3 + k] += noise * rnd();
    }));
  }
  const m = model.getMesh();
  const mesh = { positions: m.vertProperties, index: m.triVerts };
  temps.forEach((t) => t.delete());
  return { mesh, berries };
}

describe('findDetails', () => {
  it('finds the berries as round details with their size, and the leaves as other details', () => {
    const { mesh, berries } = trophyFixture();
    const { details, featureSize } = findDetails(mesh, { featureSize: 14 }); // about three berry diameters
    expect(featureSize).toBe(14);
    const round = details.filter((d) => d.kind === 'round');
    const other = details.filter((d) => d.kind === 'other');
    expect(round).toHaveLength(4);
    expect(other).toHaveLength(2);
    for (const b of berries) {
      const found = round.find((d) => Math.hypot(d.center[0] - b.center[0], d.center[1] - b.center[1], d.center[2] - b.center[2]) < 1);
      expect(found).toBeTruthy();
      expect(found.radius).toBeCloseTo(b.radius, 0);
      // its base normal points away from the cane's axis
      const out = [b.center[0], b.center[1], 0];
      const l = Math.hypot(...out);
      expect(found.normal[0] * out[0] / l + found.normal[1] * out[1] / l).toBeGreaterThan(0.8);
    }
    expect(Math.max(...other.map((d) => d.size))).toBeGreaterThan(4); // a leaf is about 6 mm long
  });

  it('still finds them on a smudgy copy, and nothing on a plain cylinder', () => {
    const { details } = findDetails(trophyFixture({ noise: 0.12 }).mesh, { featureSize: 14 });
    expect(details.filter((d) => d.kind === 'round').length).toBeGreaterThanOrEqual(3);
    expect(details.length).toBeLessThanOrEqual(8);
    const coarse = wasm.Manifold.cylinder(60, 12, 12, 96);
    const plain = coarse.refineToLength(0.8);
    const m = plain.getMesh();
    coarse.delete();
    plain.delete();
    expect(findDetails({ positions: m.vertProperties, index: m.triVerts }, { featureSize: 14 }).details).toHaveLength(0);
  });

  it('reports nothing on the ends of a plain cylinder at any feature size, nor on dents', () => {
    const { Manifold } = wasm;
    const temps = [];
    const keep = (m) => (temps.push(m), m);
    const plain = keep(keep(Manifold.cylinder(60, 12, 12, 96)).refineToLength(0.8));
    const pm = plain.getMesh();
    for (const featureSize of [18, 25, 32]) {
      // the rounded-off end of the body stands above its smoothed base too, but has a sharp rim around it
      expect(findDetails({ positions: pm.vertProperties, index: pm.triVerts }, { featureSize }).details).toHaveLength(0);
    }
    let dented = plain;
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI * 2) / 3;
      dented = keep(dented.subtract(keep(Manifold.sphere(2.5 + i, 32).translate(13 * Math.cos(a), 13 * Math.sin(a), 15 + i * 12))));
    }
    const dm = dented.getMesh();
    for (const featureSize of [10, 14, 20]) {
      // the rim around a dent is not a detail standing on the surface
      expect(findDetails({ positions: dm.vertProperties, index: dm.triVerts }, { featureSize }).details).toHaveLength(0);
    }
    // the same on a flat plate, where the rim around the hole is flat and stands above the sunken base around it
    const plate = keep(keep(Manifold.cube([80, 80, 6], true)).refineToLength(0.7));
    for (const [cz, sizes] of [[3.5, [10]], [3, [8, 10]]]) {
      const holed = keep(plate.subtract(keep(Manifold.sphere(2.5, 32).translate(25, -20, cz))));
      const hm = holed.getMesh();
      for (const featureSize of sizes) {
        expect(findDetails({ positions: hm.vertProperties, index: hm.triVerts }, { featureSize }).details).toHaveLength(0);
      }
    }
    temps.forEach((t) => t.delete());
  });

  it('is deterministic and honours featureSize and minHeight', () => {
    const { mesh } = trophyFixture();
    const a = findDetails(mesh, { featureSize: 14 });
    const b = findDetails(mesh, { featureSize: 14 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(findDetails(mesh, { minHeight: 100 }).details).toHaveLength(0);
  });
});

describe('details in the engine', () => {
  it('finds details on the loaded model, replaces round ones with clean spheres and removes details with removing spots', async () => {
    const { createEngine } = await import('../src/engine.js');
    const { createEngineClient, createLocalWorker } = await import('../src/engineClient.js');
    const { createPart, createSpot } = await import('../src/document.js');
    const { parseSTL, writeBinarySTL } = await import('../src/stl.js');
    const { geometryToManifold, manifoldToSoup } = await import('../src/mesh.js');
    const engine = createEngine({ wasm });
    const client = createEngineClient({ createWorker: () => createLocalWorker(Promise.resolve(engine)) });
    const { Manifold } = wasm;
    // the trophy fixture as a solid
    let model = Manifold.cylinder(60, 12, 12, 96).refineToLength(0.8);
    const berries = [];
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const c = [13.2 * Math.cos(a), 13.2 * Math.sin(a), 15 + i * 10];
      berries.push(c);
      model = model.add(Manifold.sphere(2.5, 32).translate(...c));
    }
    const volume0 = model.volume();
    const bytes = writeBinarySTL(manifoldToSoup(model));
    let version = 1;
    await client.loadBase({ kind: 'stl', bytes, name: 'trophy', version });
    const found = await client.findDetails(version, { featureSize: 14 });
    expect(found.details.filter((d) => d.kind === 'round')).toHaveLength(4);
    const d = found.details.find((x) => x.kind === 'round');
    // replace: a generated sphere part that consumes the original
    const radius = Math.round(d.radius * 20) / 20;
    expect(radius).toBeCloseTo(2.5, 1);
    await client.addGeneratedPart(`sphere-${radius}`, { kind: 'sphere', radius }, 'berry');
    const sink = Math.round(radius * 0.35 * 10) / 10;
    const position = d.center.map((c, k) => c - d.normal[k] * (radius - sink));
    const sphere = createPart(`sphere-${radius}`, 'berry', { attach: 'bottom', sink, fit: false, cover: true, join: 'fuse', position, normal: d.normal });
    const ex = await client.export([sphere], version, 'x');
    const m = geometryToManifold(parseSTL(ex.stl));
    expect(m.decompose().length).toBe(1);
    expect(Math.abs(m.volume() - volume0) / volume0).toBeLessThan(0.01); // a same-size sphere where the old one was
    m.delete();
    // remove: a removing spot cuts the berry back to the cane
    const target = berries[0];
    const remover = createSpot({ radius: 3.5, remove: true, position: [target[0] + 1.2, target[1], target[2]], normal: [1, 0, 0] });
    const shown = await client.updateBase({ version: ++version, transforms: [], simplify: null, enhance: null, spots: [], covers: [remover] });
    expect(shown.info.covered).toBe(1);
    const ex2 = await client.export([remover], version, 'x');
    const m2 = geometryToManifold(parseSTL(ex2.stl));
    const berryVolume = (4 / 3) * Math.PI * 2.5 ** 3;
    const removed = volume0 - m2.volume();
    expect(removed).toBeGreaterThan(0.7 * berryVolume); // the berry is gone (about a sixth of it was inside the cane)
    expect(removed).toBeLessThan(1.3 * berryVolume); // and nothing but the berry
    expect(m2.decompose().length).toBe(1);
    // the cane's surface under it is intact: the model still reaches the cane radius there
    const probe = Manifold.cube([2, 6, 6], true).translate(11, target[1], target[2]);
    const kept = m2.intersect(probe);
    expect(kept.volume()).toBeGreaterThan(2 * 6 * 6 * 0.4);
    // a removing spot on the bare cane cuts nothing, and says so
    const idle = createSpot({ radius: 3.5, remove: true, position: [-12, 0, 45], normal: [-1, 0, 0] });
    const shown2 = await client.updateBase({ version: ++version, transforms: [], simplify: null, enhance: null, spots: [], covers: [idle] });
    expect(shown2.info.covered).toBe(0);
    expect((await client.preview(idle, version)).notes.map((n) => n.code)).toEqual(['REMOVE_EMPTY']);
    expect((await client.preview(remover, version)).notes.map((n) => n.code)).toEqual(['REMOVE_EMPTY']); // not among the covers of this version
    [m2, probe, kept, model].forEach((x) => x.delete());
  });

  it('removes low bumps with wide skirts down to the surface, not just their tops', async () => {
    const { createEngine } = await import('../src/engine.js');
    const { createEngineClient, createLocalWorker } = await import('../src/engineClient.js');
    const { createSpot } = await import('../src/document.js');
    const { parseSTL, writeBinarySTL } = await import('../src/stl.js');
    const { geometryToManifold, manifoldToSoup } = await import('../src/mesh.js');
    const engine = createEngine({ wasm });
    const client = createEngineClient({ createWorker: () => createLocalWorker(Promise.resolve(engine)) });
    const { Manifold, Mesh } = wasm;
    // a plate with two gaussian bumps that have run together, as in the end-to-end test
    const plate = Manifold.cube([30, 30, 4], true).refineToLength(0.4);
    const pm = plate.getMesh();
    const stride = pm.numProp;
    const p = new Float32Array((pm.vertProperties.length / stride) * 3);
    for (let i = 0; i < p.length / 3; i++) for (let k = 0; k < 3; k++) p[i * 3 + k] = pm.vertProperties[i * stride + k];
    const sigma = 1.2;
    for (let v = 0; v < p.length; v += 3) {
      if (Math.abs(p[v + 2] - 2) > 1e-6) continue;
      for (const bx of [-1.8, 1.8]) p[v + 2] += 0.8 * Math.exp(-((p[v] - bx) ** 2 + p[v + 1] ** 2) / (2 * sigma * sigma));
    }
    const clump = Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: p, triVerts: pm.triVerts }));
    const volume0 = clump.volume();
    const bumps = 2 * (2 * Math.PI * sigma * sigma * 0.8); // about 14.5 mm³
    await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(manifoldToSoup(clump)), name: 'clump', version: 1 });
    const found = await client.findDetails(1, { featureSize: 8 });
    // the two bumps that ran together: found as one clump or as two bumps
    expect(found.details.length).toBeGreaterThanOrEqual(1);
    expect(found.details.length).toBeLessThanOrEqual(2);
    // the spots "Remove all found" would add
    const spots = found.details.map((d) => createSpot({ radius: Math.round(Math.max(1.5, d.size * 0.65) * 2) / 2, remove: true, position: d.center, normal: d.normal }));
    await client.updateBase({ version: 2, transforms: [], simplify: null, enhance: null, spots: [], covers: spots });
    const out = geometryToManifold(parseSTL((await client.export(spots, 2, 'x')).stl));
    const removed = volume0 - out.volume();
    expect(removed).toBeGreaterThan(0.65 * bumps); // the skirts beyond the spot and a hair of skin stay
    expect(removed).toBeLessThan(1.05 * bumps);
    // the plate's top under the bumps is where it was, give or take the skin
    const probe = Manifold.cube([6, 3, 1], true).translate(0, 0, 2.5);
    const left = out.intersect(probe);
    expect(left.volume()).toBeLessThan(6 * 3 * 0.12);
    [plate, clump, out, probe, left].forEach((x) => x.delete());
  });

  it('finds a berry on a coarse CAD mesh of long thin triangles, with the right sphere, at the automatic feature size too', async () => {
    const { createEngine } = await import('../src/engine.js');
    const { createEngineClient, createLocalWorker } = await import('../src/engineClient.js');
    const { writeBinarySTL } = await import('../src/stl.js');
    const { manifoldToSoup } = await import('../src/mesh.js');
    const engine = createEngine({ wasm });
    const client = createEngineClient({ createWorker: () => createLocalWorker(Promise.resolve(engine)) });
    const { Manifold } = wasm;
    const cane = Manifold.cylinder(60, 12, 12, 96); // 60 mm long side triangles
    const berry = Manifold.sphere(2.5, 32).translate(13.2, 0, 30);
    const model = cane.add(berry);
    await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(manifoldToSoup(model)), name: 'cad', version: 1 });
    for (const featureSize of [14, 0]) {
      const found = await client.findDetails(1, { featureSize });
      expect(found.featureSize).toBeCloseTo(featureSize || Math.max(6, Math.min(40, 0.03 * Math.hypot(26.4, 26.4, 60))), 0);
      expect(found.details).toHaveLength(1);
      const d = found.details[0];
      expect(d.kind).toBe('round');
      expect(d.radius).toBeCloseTo(2.5, 1);
      expect(Math.hypot(d.center[0] - 13.2, d.center[1], d.center[2] - 30)).toBeLessThan(0.1);
    }
    [cane, berry, model].forEach((x) => x.delete());
  });
});
