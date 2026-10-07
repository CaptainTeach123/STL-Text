import { beforeAll, describe, expect, it } from 'vitest';
import { BufferGeometry } from 'three';
import { conformSolid, createSurfaceSampler, wallThicknessAt } from '../src/conform.js';
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
    const flat = slab(30, 6, -0.4, 2); // 30 x 6 x 2.4 = 432
    const { solid, conformed, stats } = conformSolid(flat, sampler);
    expect(solid.status()).toBe('NoError');
    expect(conformed).toBe(true);
    expect(stats.triangles).toBeGreaterThan(flat.numTri());
    expect(Math.abs(solid.volume() - 432) / 432).toBeLessThan(0.03);
    // the slab bottom (z = -0.4) sinks to the surface height at the ends
    expect(Math.abs(bounds(solid).min[2] - (cylinderHeight(15) - 0.4))).toBeLessThan(0.15);
    expect(isClosed(manifoldToGeometry(solid))).toBe(true);

    const expected = 30 * 6 * 2; // footprint x height above the surface
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
    const expected = 30 * 6 * 1.5;
    expect(Math.abs(removed - expected) / expected).toBeLessThan(0.05);
    [cut, placed, solid, flat, cyl].forEach((s) => s.delete());
    sampler.dispose();
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
