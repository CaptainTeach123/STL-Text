import { beforeAll, describe, expect, it } from 'vitest';
import { BufferGeometry } from 'three';
import { conformNotes, conformSolid, createSurfaceSampler, wallThicknessAt } from '../src/conform.js';
import { manifold } from '../src/manifold.js';
import { manifoldToGeometry } from '../src/mesh.js';
import { placementMatrix, toMat4 } from '../src/placement.js';
import { bounds, isClosed, setup } from './helpers.js';

beforeAll(async () => {
  await setup();
});

const top = (z) => placementMatrix({ position: [0, 0, z], normal: [0, 0, 1] });

/** Text-local solid -> model space, as the editor does before a boolean. */
const place = (solid, placement) => solid.transform(toMat4(placement));

/** Sampler over a Manifold's surface; returns it with the solid's geometry. */
function samplerFor(solid, placement, options) {
  return createSurfaceSampler(manifoldToGeometry(solid), placement, options);
}

/** Cylinder of radius 20, 60 long, axis along Y (so its top is curved along X). */
const cylinderY = () => manifold().Manifold.cylinder(60, 20, 20, 128, true).rotate([90, 0, 0]);

/** Height of the cylinder's top surface above the text plane at local x. */
const cylinderHeight = (x) => Math.sqrt(400 - x * x) - 20;

/**
 * Volume of a slab z0..z1 of width 2·half and depth `d` along the axis once it is wrapped round the cylinder of
 * radius R (its width measured along the surface): a sector of the ring between R + z0 and R + z1.
 */
const shellVolume = (R, half, d, z0, z1) => d * ((2 * half) / R) * ((R + z1) ** 2 - (R + z0) ** 2) / 2;

/** Distance of every vertex of a text-local solid from the axis of cylinderY() placed under top(20). */
function radii(solid) {
  const v = solid.getMesh().vertProperties;
  const out = [];
  for (let i = 0; i < v.length; i += 3) out.push(Math.hypot(v[i], v[i + 2] + 20));
  return out;
}

/** A thin sheet 120 wide that bends up towards its ends (z = x² / 200), 2 thick. */
function bentSheet() {
  const { Manifold } = manifold();
  const flat = Manifold.cube([120, 40, 2], true).refineToLength(2);
  const bent = flat.warpBatch((verts, count) => {
    for (let i = 0; i < count; i++) verts[i * 3 + 2] += (verts[i * 3] * verts[i * 3]) / 200;
  });
  flat.delete();
  return bent;
}

/** Slab spanning local z0..z1 with a `w` x `d` footprint. */
function slab(w, d, z0, z1) {
  return manifold().Manifold.cube([w, d, z1 - z0], true).translate(0, 0, (z0 + z1) / 2);
}

const hasNaN = (solid) => solid.getMesh().vertProperties.some((v) => Number.isNaN(v));

describe('createSurfaceSampler', () => {
  it('reads the height of a flat face in the text frame', () => {
    const { Manifold } = manifold();
    const box = Manifold.cube([40, 40, 10], true);
    const sampler = samplerFor(box, top(5));
    expect(sampler.heightAt(0, 0)).toBeCloseTo(0, 6);
    expect(sampler.heightAt(10, 10)).toBeCloseTo(0, 6);
    expect(sampler.heightAt(100, 100)).toBeNaN();
    sampler.dispose();

    const front = samplerFor(box, placementMatrix({ position: [0, -20, 0], normal: [0, -1, 0] }));
    expect(front.heightAt(5, 2)).toBeCloseTo(0, 6);
    front.dispose();
    box.delete();
  });

  it('follows a sphere and prefers the surface nearest the text plane', () => {
    const sphere = manifold().Manifold.sphere(20, 128);
    const sampler = samplerFor(sphere, top(20));
    expect(sampler.heightAt(0, 0)).toBeCloseTo(0, 2);
    const h = sampler.heightAt(10, 0);
    expect(Math.abs(h - (Math.sqrt(300) - 20))).toBeLessThan(0.05);
    expect(h).toBeGreaterThan(-5); // the top of the sphere, not the bottom at z ~ -40
    sampler.dispose();
    sphere.delete();
  });

  it('reads the front of a thin sheet that bends towards the text, not its back', () => {
    const sheet = bentSheet();
    const sampler = samplerFor(sheet, placementMatrix({ position: [0, 0, 1], normal: [0, 0, 1] }));
    expect(sampler.heightAt(0, 0)).toBeCloseTo(0, 2);
    // at x = 50 the top is 12.5 above the plane and the underside 10.5: the underside is nearer the plane, but it faces away
    expect(Math.abs(sampler.heightAt(50, 0) - 12.5)).toBeLessThan(0.1);
    expect(Math.abs(sampler.heightAt(-55, 10) - 15.125)).toBeLessThan(0.1);
    expect(sampler.sample(50, 0).wall).toBeCloseTo(2, 1);
    sampler.dispose();
    sheet.delete();
  });

  it('accepts an unlimited search range and goes blind after dispose()', () => {
    const box = manifold().Manifold.cube([40, 40, 10], true);
    const sampler = samplerFor(box, top(5), { searchAbove: Infinity, searchBelow: Infinity });
    expect(sampler.heightAt(3, -4)).toBeCloseTo(0, 6);
    sampler.dispose();
    expect(sampler.heightAt(3, -4)).toBeNaN();
    box.delete();
  });
});

describe('conformSolid', () => {
  it('only translates text on a flat surface', () => {
    const box = manifold().Manifold.cube([40, 40, 10], true);
    const sampler = samplerFor(box, top(5));
    const flat = slab(20, 5, -0.4, 1);
    const { solid, conformed, stats } = conformSolid(flat, sampler);
    expect(conformed).toBe(false);
    expect(solid).not.toBe(flat);
    expect(solid.numTri()).toBe(flat.numTri());
    expect(stats.triangles).toBe(flat.numTri());
    expect(stats.misses).toBe(0);
    expect(bounds(solid).min[2]).toBeCloseTo(-0.4, 6);
    expect(bounds(solid).max[2]).toBeCloseTo(1, 6);
    [solid, flat, box].forEach((s) => s.delete());
    sampler.dispose();
  });

  it('wraps an embossed slab around a cylinder', () => {
    const cyl = cylinderY();
    const sampler = samplerFor(cyl, top(20));
    const flat = slab(30, 6, -0.4, 2);
    const { solid, conformed, stats } = conformSolid(flat, sampler);
    expect(solid.status()).toBe('NoError');
    expect(conformed).toBe(true);
    expect(stats.triangles).toBeGreaterThan(flat.numTri());
    // the slab is wrapped round the cylinder: 30 mm along the surface, a sector of the ring between R - 0.4 and R + 2
    const volume = shellVolume(20, 15, 6, -0.4, 2);
    expect(Math.abs(solid.volume() - volume) / volume).toBeLessThan(0.03);
    // its ends sit 15 mm round the surface (0.75 rad) from the middle, the bottom corner 0.4 inside the surface
    expect(Math.abs(bounds(solid).min[2] - (19.6 * Math.cos(0.75) - 20))).toBeLessThan(0.15);
    expect(isClosed(manifoldToGeometry(solid))).toBe(true);

    const expected = shellVolume(20, 15, 6, 0, 2); // the ring sector above the surface
    const placed = place(solid, top(20));
    const placedFlat = place(flat, top(20));
    const conformedUnion = cyl.add(placed);
    const flatUnion = cyl.add(placedFlat);
    const added = conformedUnion.volume() - cyl.volume();
    const addedFlat = flatUnion.volume() - cyl.volume();
    expect(Math.abs(added - expected) / expected).toBeLessThan(0.05);
    expect(Math.abs(added - expected)).toBeLessThan(Math.abs(addedFlat - expected));
    [conformedUnion, flatUnion, placed, placedFlat, solid, flat, cyl].forEach((s) => s.delete());
    sampler.dispose();
  });

  it('engraves to a constant depth on a cylinder', () => {
    const cyl = cylinderY();
    const sampler = samplerFor(cyl, top(20));
    const flat = slab(30, 6, -1.5, 0.4);
    const { solid, conformed } = conformSolid(flat, sampler);
    expect(conformed).toBe(true);
    const placed = place(solid, top(20));
    const cut = cyl.subtract(placed);
    const removed = cyl.volume() - cut.volume();
    const expected = shellVolume(20, 15, 6, -1.5, 0); // the ring sector below the surface
    expect(Math.abs(removed - expected) / expected).toBeLessThan(0.05);
    [cut, placed, solid, flat, cyl].forEach((s) => s.delete());
    sampler.dispose();
  });

  it('keeps a constant height on a cylinder: every point of the slab sits between R - 0.4 and R + 2 from the axis', () => {
    const cyl = cylinderY();
    const sampler = samplerFor(cyl, top(20));
    const flat = slab(30, 6, -0.4, 2);
    const { solid } = conformSolid(flat, sampler);
    const r = radii(solid);
    expect(Math.min(...r)).toBeGreaterThan(19.6 - 0.05);
    expect(Math.max(...r)).toBeLessThan(22 + 0.05);
    // ... at the ends too, where the surface slopes 49°: standing square on the surface, not along the text's normal
    const v = solid.getMesh().vertProperties;
    let endTop = 0;
    for (let i = 0; i < v.length; i += 3) if (Math.abs(v[i]) > 14) endTop = Math.max(endTop, Math.hypot(v[i], v[i + 2] + 20));
    expect(endTop).toBeGreaterThan(22 - 0.05);
    [solid, flat, cyl].forEach((s) => s.delete());
    sampler.dispose();
  });

  it('lays a slab over a sheet that bends up at its ends without burying the ends', () => {
    const sheet = bentSheet();
    const placement = placementMatrix({ position: [0, 0, 1], normal: [0, 0, 1] });
    const sampler = samplerFor(sheet, placement);
    const flat = slab(110, 10, -0.4, 2);
    const { solid, conformed, stats } = conformSolid(flat, sampler);
    expect(conformed).toBe(true);
    expect(stats.misses).toBe(0);
    expect(solid.status()).toBe('NoError');
    // nothing sinks deeper than the overlap below the top surface, and the slab stands its full height above it
    const v = solid.getMesh().vertProperties;
    let deepest = Infinity;
    let highest = -Infinity;
    for (let i = 0; i < v.length; i += 3) {
      const above = v[i + 2] - (v[i] * v[i]) / 200;
      deepest = Math.min(deepest, above);
      highest = Math.max(highest, above);
    }
    expect(deepest).toBeGreaterThan(-0.6);
    expect(highest).toBeGreaterThan(1.9);
    // the raised part really sits on the sheet: the union grows by about the slab's height over its footprint
    const placed = place(solid, placement);
    const union = sheet.add(placed);
    const added = union.volume() - sheet.volume();
    expect(added).toBeGreaterThan(110 * 10 * 2 * 0.9);
    [union, placed, solid, flat, sheet].forEach((s) => s.delete());
    sampler.dispose();
  });

  it('stays on the clicked layer of a doubled ribbon: the layer behind faces the text too, and is nearer its plane', () => {
    // two sheets 2 thick, 3 apart, both bending towards the text at their ends (a banner whose tail folds behind it)
    const { Manifold } = manifold();
    const bent = (dz) => {
      const flat = Manifold.cube([120, 30, 2], true).refineToLength(2);
      const out = flat.warpBatch((verts, count) => {
        for (let i = 0; i < count; i++) verts[i * 3 + 2] += dz + (verts[i * 3] * verts[i * 3]) / 200;
      });
      flat.delete();
      return out;
    };
    const front = bent(0);
    const back = bent(-5);
    const both = front.add(back);
    const placement = placementMatrix({ position: [0, 0, 1], normal: [0, 0, 1] });
    const sampler = samplerFor(both, placement);
    // at x = 50 the front sheet's top is at 12.5, its underside at 10.5 and the back sheet's top at 7.5: the nearest
    // surface facing the text is the wrong one
    const { solid, stats } = conformSolid(slab(110, 8, -0.4, 1), sampler);
    expect(stats.misses).toBe(0);
    const v = solid.getMesh().vertProperties;
    let deepest = Infinity;
    for (let i = 0; i < v.length; i += 3) deepest = Math.min(deepest, v[i + 2] - (v[i] * v[i]) / 200);
    expect(deepest).toBeGreaterThan(-0.6); // nothing sinks below the front sheet's top by more than the overlap
    [solid, both, front, back].forEach((m) => m.delete());
    sampler.dispose();
  });

  it('does not drop the ends of the text onto a surface far below an edge it hangs over', () => {
    const { Manifold } = manifold();
    const plate = Manifold.cube([40, 40, 4], true);
    const floor = Manifold.cube([120, 60, 2], true).translate(0, 0, -30);
    const both = plate.add(floor);
    const sampler = samplerFor(both, top(2));
    const { solid, stats } = conformSolid(slab(60, 6, -0.4, 1), sampler);
    expect(stats.missFraction).toBeGreaterThan(0.2); // the overhang is reported as such ...
    expect(bounds(solid).min[2]).toBeGreaterThan(-1); // ... and the ends carry on level instead of falling 30 mm
    [solid, both, plate, floor].forEach((m) => m.delete());
    sampler.dispose();
  });

  it('carries on across a slot in the surface: the letters beyond it follow the surface again', () => {
    // a dome-topped block with a 3 mm slot across it, under the middle of the text
    const { Manifold } = manifold();
    const block = Manifold.cube([80, 30, 10], true).refineToLength(1);
    const domed = block.warpBatch((v, n) => {
      for (let i = 0; i < n; i++) if (v[i * 3 + 2] > 4.99) v[i * 3 + 2] -= (v[i * 3] * v[i * 3]) / 400;
    });
    const slot = Manifold.cube([3, 40, 20], true).translate(-8, 0, 0);
    const slotted = domed.subtract(slot);
    const sampler = samplerFor(slotted, top(5));
    const { solid } = conformSolid(slab(70, 8, -0.4, 1), sampler);
    // beyond the slot (x < -12) the text still sits on the dome (z = -x² / 400 there, 2.25 mm lower at the end than at
    // the slot), not level with the near side: every vertex lies between the letters' bottom and top above the dome
    const v = solid.getMesh().vertProperties;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < v.length; i += 3) {
      if (v[i] > -12) continue;
      const above = v[i + 2] + (v[i] * v[i]) / 400;
      lo = Math.min(lo, above);
      hi = Math.max(hi, above);
    }
    expect(lo).toBeGreaterThan(-0.5);
    expect(hi).toBeLessThan(1.1);
    expect(hi).toBeGreaterThan(0.9);
    [solid, slotted, slot, domed, block].forEach((m) => m.delete());
    sampler.dispose();
  });

  it('warns when the text runs under a part of the model hanging over the surface, with no room for its letters', () => {
    const { Manifold } = manifold();
    // a block with a shelf 1 mm over its top, covering the right half of the text
    const block = Manifold.cube([60, 30, 10], true);
    const post = Manifold.cube([4, 30, 1], true).translate(28, 0, 5.5);
    const shelf = Manifold.cube([34, 30, 2], true).translate(13, 0, 7);
    const model = block.add(post).add(shelf);
    const sampler = samplerFor(model, top(5));
    const { stats } = conformSolid(slab(40, 8, -0.4, 1.5), sampler);
    expect(stats.squeezedFraction).toBeGreaterThan(0.2);
    expect(conformNotes(stats).map((n) => n.code)).toContain('UNDER_OVERHANG');
    // with room to spare (the shelf 10 mm up) there is nothing to say
    const high = block.add(Manifold.cube([4, 30, 10], true).translate(28, 0, 10)).add(Manifold.cube([34, 30, 2], true).translate(13, 0, 16));
    const roomy = samplerFor(high, top(5));
    expect(conformSolid(slab(40, 8, -0.4, 1.5), roomy).stats.squeezedFraction).toBe(0);
    [model, block, post, shelf, high].forEach((m) => m.delete());
    sampler.dispose();
    roomy.dispose();
  });

  it('fills sample misses where the text overhangs the model', () => {
    const box = manifold().Manifold.cube([40, 40, 10], true);
    const sampler = samplerFor(box, top(5));
    const flat = slab(60, 6, -0.4, 1);
    const { solid, stats } = conformSolid(flat, sampler);
    expect(stats.misses).toBeGreaterThan(0);
    expect(stats.misses).toBeLessThan(stats.samples);
    expect(solid.status()).toBe('NoError');
    expect(hasNaN(solid)).toBe(false);
    [solid, flat, box].forEach((s) => s.delete());
    sampler.dispose();
  });

  it('returns an untouched copy when every sample misses', () => {
    const box = manifold().Manifold.cube([40, 40, 10], true);
    const sampler = samplerFor(box, placementMatrix({ position: [200, 200, 5], normal: [0, 0, 1] }));
    const flat = slab(10, 4, -0.4, 1);
    const { solid, conformed, stats } = conformSolid(flat, sampler);
    expect(conformed).toBe(false);
    expect(stats.misses).toBe(stats.samples);
    expect(solid.numTri()).toBe(flat.numTri());
    expect(bounds(solid).min[2]).toBeCloseTo(-0.4, 6);
    [solid, flat, box].forEach((s) => s.delete());
    sampler.dispose();
  });

  it('handles an 80k triangle model quickly', () => {
    const sphere = manifold().Manifold.sphere(30, 400);
    expect(sphere.numTri()).toBeGreaterThanOrEqual(80000);
    const geometry = manifoldToGeometry(sphere);
    const flat = slab(40, 10, -0.4, 1.5);
    const start = performance.now();
    const sampler = createSurfaceSampler(geometry, top(30));
    const { solid, conformed } = conformSolid(flat, sampler);
    const elapsed = performance.now() - start;
    expect(conformed).toBe(true);
    expect(solid.status()).toBe('NoError');
    expect(elapsed).toBeLessThan(2000);
    [solid, flat, sphere].forEach((s) => s.delete());
    sampler.dispose();
  }, 30000);
});

describe('wallThicknessAt', () => {
  it('measures the wall under a surface point', () => {
    const { Manifold } = manifold();
    const box = Manifold.cube([40, 40, 10], true);
    expect(wallThicknessAt(manifoldToGeometry(box), [0, 0, 5], [0, 0, 1])).toBeCloseTo(10, 3);

    const inner = Manifold.cube([36, 36, 6], true);
    const hollow = box.subtract(inner);
    expect(wallThicknessAt(manifoldToGeometry(hollow), [0, 0, 5], [0, 0, 1])).toBeCloseTo(2, 3);
    expect(wallThicknessAt(manifoldToGeometry(hollow), [0, 0, 5], [0, 0, 1], 1)).toBe(Infinity);
    [hollow, inner, box].forEach((s) => s.delete());
  });

  it('is infinite when nothing is behind the point', () => {
    expect(wallThicknessAt(new BufferGeometry(), [0, 0, 0], [0, 0, 1])).toBe(Infinity);
  });
});
