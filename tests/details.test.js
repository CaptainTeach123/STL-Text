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
    expect(removed).toBeGreaterThan(0.5 * berryVolume); // most of the berry is gone (part of it was inside the cane)
    expect(removed).toBeLessThan(1.3 * berryVolume); // and nothing but the berry
    expect(m2.decompose().length).toBe(1);
    // the cane's surface under it is intact: the model still reaches the cane radius there
    const probe = Manifold.cube([2, 6, 6], true).translate(11, target[1], target[2]);
    const kept = m2.intersect(probe);
    expect(kept.volume()).toBeGreaterThan(2 * 6 * 6 * 0.4);
    [m2, probe, kept, model].forEach((x) => x.delete());
  });
});
