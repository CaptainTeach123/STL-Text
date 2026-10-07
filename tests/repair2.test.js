import { beforeAll, describe, expect, it } from 'vitest';
import { describeRepair, repairToManifold } from '../src/repair.js';
import { manifold } from '../src/manifold.js';
import { setup, soupOf as soupGeometry } from './helpers.js';

const soupOf = (solid, opts) => soupGeometry(solid, opts).attributes.position.array;

let M;
beforeAll(async () => {
  await setup();
  M = manifold().Manifold;
});

const concat = (...soups) => {
  const out = new Float32Array(soups.reduce((n, s) => n + s.length, 0));
  let o = 0;
  for (const s of soups) {
    out.set(s, o);
    o += s.length;
  }
  return out;
};

/** Deterministic ±amplitude jitter of every corner. */
function perturb(soup, amplitude, seed = 7) {
  const out = soup.slice();
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < out.length; i++) out[i] += rnd() * amplitude;
  return out;
}

describe('passthrough', () => {
  it('keeps an unrepairable open triangle alongside the repaired solid', () => {
    const cube = soupOf(M.cube([10, 10, 10], true));
    const loose = new Float32Array([100, 0, 0, 101, 0, 0, 100, 1, 0]);
    const { manifold: m, passthrough, report } = repairToManifold(concat(cube, loose));
    expect(m.volume()).toBeCloseTo(1000, 3);
    expect(passthrough.length).toBe(9);
    expect(Array.from(passthrough)).toEqual(Array.from(loose));
    expect(report.passthroughTriangles).toBe(1);
    expect(report.shellsDropped).toBe(1);
    expect(describeRepair(report)).toMatch(/couldn't be repaired/);
    expect(describeRepair(report)).toMatch(/kept as-is/);
    m.delete();
  });

  it('passes a shell with an unfillable hole through, keeps the other shell solid', () => {
    const cube = soupOf(M.cube([10, 10, 10], true));
    const sphere = M.sphere(10, 32);
    const holey = soupOf(sphere.translate(50, 0, 0), { dropTriangles: 40 });
    const { manifold: m, passthrough, report } = repairToManifold(concat(cube, holey), { maxHoleEdges: 3 });
    expect(m.volume()).toBeCloseTo(1000, 3);
    expect(passthrough.length).toBe(holey.length);
    expect(report.shellsDropped).toBe(1);
    expect(report.passthroughTriangles).toBe(holey.length / 9);
    m.delete();
  });

  it('is an empty Float32Array for a clean mesh', () => {
    const { manifold: m, passthrough } = repairToManifold(soupOf(M.cube([10, 10, 10], true)));
    expect(passthrough).toBeInstanceOf(Float32Array);
    expect(passthrough.length).toBe(0);
    m.delete();
  });
});

describe('tolerance ladder cap and gates', () => {
  it('welds a thin sheet with tiny gaps without emptying it', () => {
    const sheet = perturb(soupOf(M.cube([10, 10, 0.2], true)), 1e-5);
    const { manifold: m, report } = repairToManifold(sheet);
    expect(m).not.toBeNull();
    expect(Math.abs(m.volume() - 20) / 20).toBeLessThan(0.01);
    expect(report.weldTolerance).toBeGreaterThan(0);
    expect(report.weldTolerance).toBeLessThan(0.05);
    expect(m.tolerance()).toBeLessThanOrEqual(1e-4); // setTolerance tightened it again
    expect(report.notes.join(' ')).toMatch(/gaps up to/);
    m.delete();
  });

  it('never exceeds the absolute cap even on a huge model', () => {
    const big = perturb(soupOf(M.cube([2000, 2000, 2000], true)), 0.1);
    const out = repairToManifold(big);
    expect(out.report.weldTolerance).toBeLessThanOrEqual(0.05);
    expect(out.manifold !== null || out.passthrough.length > 0).toBe(true);
    out.manifold?.delete();
  });

  it('does not throw when the ladder is effectively disabled', () => {
    const sheet = perturb(soupOf(M.cube([10, 10, 0.2], true)), 1e-5);
    const out = repairToManifold(sheet, { maxWeldAbsolute: 1e-9 });
    expect(out.report.weldTolerance).toBeLessThanOrEqual(1e-9);
    expect(out.manifold !== null || out.passthrough.length > 0).toBe(true);
    out.manifold?.delete();
  });

  it('refuses a rung that would fuse two sheets (volume gate)', () => {
    // two 10x10x0.1 sheets 0.3 mm apart, each with 1e-6 jitter: a 0.15 mm rung would glue them together
    const a = perturb(soupOf(M.cube([10, 10, 0.1], true)), 1e-6, 3);
    const b = perturb(soupOf(M.cube([10, 10, 0.1], true).translate(0, 0, 0.3)), 1e-6, 5);
    const out = repairToManifold(concat(a, b), { maxWeldFraction: 0.02, maxWeldAbsolute: 0.2 });
    const volume = (out.manifold?.volume() ?? 0);
    expect(out.manifold === null || Math.abs(volume - 20) / 20 < 0.01).toBe(true);
    expect(out.manifold !== null || out.passthrough.length > 0).toBe(true);
    out.manifold?.delete();
  });
});
