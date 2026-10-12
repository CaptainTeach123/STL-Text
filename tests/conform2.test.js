import { beforeAll, describe, expect, it } from 'vitest';
import { conformNotes, conformSolid, createSurfaceSampler } from '../src/conform.js';
import { manifold } from '../src/manifold.js';
import { manifoldToGeometry } from '../src/mesh.js';
import { placementMatrix } from '../src/placement.js';
import { setup } from './helpers.js';

let M;
beforeAll(async () => {
  await setup();
  M = manifold().Manifold;
});

const top = (z) => placementMatrix({ position: [0, 0, z], normal: [0, 0, 1] });
const slab = (w, d, z0, z1) => M.cube([w, d, z1 - z0], true).translate(0, 0, (z0 + z1) / 2);
const run = (model, placement, s, options) => {
  const geometry = manifoldToGeometry(model);
  const sampler = createSurfaceSampler(geometry, placement);
  const out = conformSolid(s, sampler, options);
  sampler.dispose();
  return out;
};

describe('sampler.sample', () => {
  it('reports height and wall thickness', () => {
    const box = M.cube([40, 40, 10], true);
    const sampler = createSurfaceSampler(manifoldToGeometry(box), top(5));
    const s = sampler.sample(0, 0);
    expect(s.z).toBeCloseTo(0, 5);
    expect(s.wall).toBeCloseTo(10, 5);
    const off = sampler.sample(100, 100);
    expect(off.z).toBeNaN();
    expect(off.wall).toBe(Infinity);
    const hollow = M.cube([40, 40, 10], true).subtract(M.cube([36, 36, 6], true));
    const hs = createSurfaceSampler(manifoldToGeometry(hollow), top(5)).sample(0, 0);
    expect(hs.z).toBeCloseTo(0, 5);
    expect(hs.wall).toBeCloseTo(2, 5);
  });
});

describe('conformSolid stats', () => {
  it('wall thickness: hollow box warns about cutting through', () => {
    const hollow = M.cube([40, 40, 10], true).subtract(M.cube([36, 36, 6], true));
    const { stats } = run(hollow, top(5), slab(20, 6, -1.5, 0.4));
    expect(stats.minWall).toBeCloseTo(2, 3);
    const warn = conformNotes(stats, { mode: 'engrave', depth: 3 });
    const cut = warn.find((n) => n.code === 'CUT_THROUGH');
    expect(cut).toBeDefined();
    expect(cut.suggestedDepth).toBeCloseTo(1.6, 6);
    expect(conformNotes(stats, { mode: 'engrave', depth: 1 }).some((n) => n.code === 'CUT_THROUGH')).toBe(false);
    expect(conformNotes(stats, { mode: 'emboss', depth: 3 }).some((n) => n.code === 'CUT_THROUGH')).toBe(false);
  });

  it('finds the thin half of a footprint (boss next to a 1 mm roof)', () => {
    // pocket from z = -5.5 to 3.5 under the left half leaves a 1.5 mm roof there
    const model = M.cube([40, 40, 10], true).subtract(M.cube([16, 30, 9], true).translate(-10, 0, -1));
    const { stats } = run(model, top(5), slab(30, 6, -1, 0.4), { wallLimit: 2 });
    expect(stats.minWall).toBeCloseTo(1.5, 2);
    expect(stats.thinCells).toBeGreaterThan(0);
  });

  it('overhang and not-touching', () => {
    const box = M.cube([40, 40, 10], true);
    const over = run(box, top(5), slab(60, 6, -0.4, 1.5));
    expect(over.stats.missFraction).toBeGreaterThan(0.02);
    expect(over.stats.touches).toBe(true);
    expect(conformNotes(over.stats).some((n) => n.code === 'OVERHANG')).toBe(true);
    expect(over.solid.status()).toBe('NoError');

    const floating = run(box, top(25), slab(20, 6, -0.4, 1.5));
    expect(floating.stats.touches).toBe(false);
    expect(conformNotes(floating.stats)[0].code).toBe('NOT_TOUCHING');
  });

  it('wraps round a cylinder as far as the text is long, without stretching; a sphere stretches big text', () => {
    const cyl = M.cylinder(60, 20, 20, 128, true).rotate([90, 0, 0]);
    // 30, 38 and 48 mm along a R = 20 surface: 43°, 54° and 69° either side of the middle, all wrapped evenly
    for (const [w, deg] of [[30, 43], [38, 54], [48, 69]]) {
      const out = run(cyl, top(20), slab(w, 6, -0.4, 2));
      expect(out.stats.maxSlopeDeg).toBeGreaterThan(deg - 4);
      expect(out.stats.maxSlopeDeg).toBeLessThan(deg + 4);
      expect(out.stats.steep).toBe(false);
      expect(out.stats.crossesEdge).toBe(false); // a smooth curve is not a step
      expect(out.stats.missFraction).toBe(0);
      expect(conformNotes(out.stats).map((n) => n.code)).toEqual(['FOLLOWS_CURVE']);
    }
    // longer than the way round: it meets itself
    const round = run(cyl, top(20), slab(140, 6, -0.4, 2));
    expect(round.stats.wrapsAround).toBe(true);
    expect(conformNotes(round.stats).map((n) => n.code)).toContain('WRAPS_AROUND');
    // a sphere curves two ways: a block of text as tall as the sphere's radius cannot lie on it unstretched
    const ball = M.sphere(15, 128);
    const big = run(ball, top(15), slab(30, 30, -0.4, 1));
    expect(big.stats.steep).toBe(true);
    expect(conformNotes(big.stats).map((n) => n.code)).toContain('TOO_CURVED');
    const small = run(ball, top(15), slab(10, 4, -0.4, 1));
    expect(small.stats.steep).toBe(false);
  });

  it('detects a step inside the footprint and still returns a valid solid', () => {
    const stepped = M.cube([40, 40, 10], true).add(M.cube([20, 40, 2], true).translate(10, 0, 6));
    const out = run(stepped, top(5), slab(30, 6, -0.4, 1.5));
    expect(out.stats.crossesEdge).toBe(true);
    expect(out.stats.steep).toBe(false); // the step's wall is not "too curved"
    expect(conformNotes(out.stats).some((n) => n.code === 'TOO_CURVED')).toBe(false);
    expect(conformNotes(out.stats).some((n) => n.code === 'CROSSES_EDGE')).toBe(true);
    expect(out.solid.status()).toBe('NoError');
  });

  it('adaptive refinement uses fewer triangles than a fixed 0.5 mm edge', () => {
    const cyl = M.cylinder(60, 20, 20, 128, true).rotate([90, 0, 0]);
    const s = slab(30, 6, -0.4, 2);
    const adaptive = run(cyl, top(20), s);
    const fixed = run(cyl, top(20), s, { maxEdge: 0.5 });
    expect(adaptive.stats.maxEdge).toBeGreaterThan(0.5);
    expect(adaptive.stats.triangles).toBeLessThan(fixed.stats.triangles);
    expect(adaptive.stats.rMin).toBeGreaterThan(15);
    expect(adaptive.stats.rMin).toBeLessThan(25);
    // wrapped round the cylinder, 30 mm along its surface: a sector of the ring between R - 0.4 and R + 2
    const volume = 6 * (30 / 20) * (22 ** 2 - 19.6 ** 2) / 2;
    expect(Math.abs(adaptive.solid.volume() - volume) / volume).toBeLessThan(0.03);
    expect(adaptive.solid.boundingBox().min[2]).toBeCloseTo(19.6 * Math.cos(0.75) - 20, 0);
  });
});
