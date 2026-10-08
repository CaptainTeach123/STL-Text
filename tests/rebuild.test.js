import { beforeAll, describe, expect, it } from 'vitest';
import { decoratedFixture } from './decorFixture.js';
import { planRebuild, specForKind } from '../src/rebuild.js';
import { decorPartId } from '../src/decor.js';
import { manifold } from '../src/manifold.js';
import { setup } from './helpers.js';

let wasm;
beforeAll(async () => {
  await setup();
  wasm = manifold();
});

async function engineClient() {
  const { createEngine } = await import('../src/engine.js');
  const { createEngineClient, createLocalWorker } = await import('../src/engineClient.js');
  const engine = createEngine({ wasm });
  return createEngineClient({ createWorker: () => createLocalWorker(Promise.resolve(engine)) });
}

const near = (item, at, within = 2.5) => Math.hypot(item.position[0] - at[0], item.position[1] - at[1]) < within;
const spinNear = (spin, truth, period) => {
  let d = ((spin - truth) % period + period) % period;
  if (d > period / 2) d = period - d;
  return d;
};

describe('the rebuild plan', () => {
  it('reads a berry, a five-point star and two leaves on a decorated plate, with their sizes and directions', async () => {
    const client = await engineClient();
    const { writeBinarySTL } = await import('../src/stl.js');
    const { manifoldToSoup } = await import('../src/mesh.js');
    const f = decoratedFixture({ blur: 6, noise: 0.03 }); // smudged a little, like a generated model
    await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(manifoldToSoup(f.solid)), name: 'decorated', version: 1 });
    f.solid.delete();
    const found = await client.findDetails(1, { featureSize: 14 });
    const { items } = planRebuild(found.details, { featureSize: 14 });
    const berry = items.find((i) => near(i, [-28, 24]));
    expect(berry?.kind).toBe('berry');
    expect(berry.spec.radius).toBeCloseTo(2.5, 0);
    const star = items.find((i) => near(i, [0, 24]));
    expect(star?.kind).toBe('star');
    expect(star.spec.points).toBe(5);
    expect(star.spec.radius).toBeGreaterThan(4.5);
    expect(star.spec.radius).toBeLessThan(7);
    expect(spinNear(star.spin, 20, 72)).toBeLessThan(15); // its tips point where the smudgy star's did
    const leaf = items.find((i) => near(i, [28, 24]));
    expect(['leaf', 'holly']).toContain(leaf?.kind);
    expect(leaf.spec.length).toBeGreaterThan(9);
    expect(leaf.spec.length).toBeLessThan(15);
    expect(leaf.spec.width).toBeGreaterThan(4);
    expect(leaf.spec.width).toBeLessThan(8);
    expect(spinNear(leaf.spin, -35, 180)).toBeLessThan(15);
    const holly = items.find((i) => near(i, [2, -4]));
    expect(['leaf', 'holly']).toContain(holly?.kind);
    expect(spinNear(holly.spin, 60, 180)).toBeLessThan(15);
    // every item stands on the plate's top, facing up, with a modest sink for its skirt
    for (const i of items) {
      expect(i.normal[2]).toBeGreaterThan(0.95);
      expect(Math.abs(i.position[2] - 3)).toBeLessThan(0.8);
      expect(i.sink).toBeGreaterThan(0.3);
      expect(i.sink).toBeLessThan(3.5);
      expect(i.confidence).toBeGreaterThan(0);
      expect(i.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('rebuilds: removing spots cut the smudgy originals away and clean parts fuse in their place as one solid', async () => {
    const client = await engineClient();
    const { writeBinarySTL, parseSTL } = await import('../src/stl.js');
    const { manifoldToSoup, geometryToManifold } = await import('../src/mesh.js');
    const { createPart, createSpot } = await import('../src/document.js');
    const { Manifold } = wasm;
    const f = decoratedFixture({ blur: 6, noise: 0.03, decorations: [{ kind: 'star', radius: 6, height: 1.6, at: [0, 20], spin: 20 }, { kind: 'berry', radius: 2.5, at: [-20, -15] }] });
    await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(manifoldToSoup(f.solid)), name: 'two', version: 1 });
    const before = f.solid.volume();
    f.solid.delete();
    const found = await client.findDetails(1, { featureSize: 14 });
    const { items } = planRebuild(found.details, { featureSize: 14 });
    expect(items.map((i) => i.kind).sort()).toEqual(['berry', 'star']);
    // as the app does it: a removing spot per detail plus the clean part
    const added = [];
    for (const item of items) {
      const radius = Math.round(Math.max(1.5, 0.55 * item.size + 0.5) * 2) / 2;
      added.push(createSpot({ radius, remove: true, position: item.position, normal: item.normal }));
      const partId = decorPartId(item.spec);
      await client.addGeneratedPart(partId, item.spec, item.kind);
      added.push(createPart(partId, item.kind, { attach: 'bottom', sink: item.sink, spin: item.spin, fit: false, cover: false, join: 'fuse', position: item.position, normal: item.normal }));
    }
    const spots = added.filter((i) => i.kind === 'spot');
    const shown = await client.updateBase({ version: 2, transforms: [], simplify: null, enhance: null, spots: [], covers: spots });
    expect(shown.info.covered).toBe(2);
    const ex = await client.export(added, 2, 'rebuilt');
    const out = geometryToManifold(parseSTL(ex.stl));
    expect(out.decompose().length).toBe(1);
    // the plate's top under the star is clean: a thin slab just above the plate holds only the star's facets, which
    // rise from the outline, so it is mostly empty; and the star's volume is about what a clean star of that size has
    const probe = Manifold.cube([16, 16, 0.2], true).translate(0, 20, 3.2);
    const slice = out.intersect(probe);
    expect(slice.volume()).toBeLessThan(0.6 * probe.volume());
    expect(Math.abs(out.volume() - before) / before).toBeLessThan(0.02);
    [out, probe, slice].forEach((m) => m.delete());
  });

  it('sizes a detail read as another kind from what was measured', () => {
    const item = { size: 10, height: 1.5, spec: { kind: 'leaf', length: 10, width: 5, height: 1.5, skirt: 0.5 } };
    expect(specForKind('star', item)).toMatchObject({ kind: 'star', radius: 5, height: 1.5, points: 5, skirt: 0.5 });
    expect(specForKind('holly', item)).toMatchObject({ kind: 'holly', length: 10, width: 5 });
    expect(specForKind('berry', item)).toMatchObject({ kind: 'berry', radius: 4 });
    expect(specForKind('sprig', { size: 20, height: 2 })).toMatchObject({ kind: 'sprig', length: 20, width: 10, height: 2 });
  });
});
