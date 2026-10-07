import { beforeAll, describe, expect, it } from 'vitest';
import { manifold } from '../src/manifold.js';
import { describeRepair, repairToManifold } from '../src/repair.js';
import { boxSolid, setup, soupOf } from './helpers.js';

beforeAll(setup);

/** Float32Array soup of a Manifold solid (deletes the solid). */
function soupArray(solid, opts) {
  const soup = soupOf(solid, opts).attributes.position.array;
  solid.delete();
  return soup;
}

const cubeSoup = (opts) => soupArray(boxSolid(10, 10, 10), opts);

/** Repair, collect what the tests look at and free the manifold. */
function repair(soup, options) {
  const { manifold: m, report } = repairToManifold(soup, options);
  const out = { report, status: m ? m.status() : null, volume: m ? m.volume() : 0, text: describeRepair(report) };
  m?.delete();
  return out;
}

function concat(...soups) {
  const out = new Float32Array(soups.reduce((n, s) => n + s.length, 0));
  let o = 0;
  for (const s of soups) { out.set(s, o); o += s.length; }
  return out;
}

function translated(soup, dx, dy, dz) {
  const out = soup.slice();
  for (let i = 0; i < out.length; i += 3) { out[i] += dx; out[i + 1] += dy; out[i + 2] += dz; }
  return out;
}

function dropTriangles(soup, indices) {
  const drop = new Set(indices);
  const T = soup.length / 9;
  const out = new Float32Array((T - drop.size) * 9);
  for (let t = 0, n = 0; t < T; t++) {
    if (drop.has(t)) continue;
    out.set(soup.subarray(t * 9, t * 9 + 9), n * 9);
    n++;
  }
  return out;
}

/** Swap corners 1 and 2 of the given triangles (reverses their winding). */
function flipTriangles(soup, indices) {
  const out = soup.slice();
  for (const t of indices) {
    for (let a = 0; a < 3; a++) {
      const i = t * 9 + 3 + a, j = t * 9 + 6 + a;
      [out[i], out[j]] = [out[j], out[i]];
    }
  }
  return out;
}

function triangleNormal(soup, t) {
  const o = t * 9;
  const ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
  const vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** Deterministic PRNG (mulberry32) returning floats in [0, 1). */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cube whose top face is a 3-triangle fan from an edge midpoint; the back face keeps the full edge. */
function tJunctionCube() {
  const V = [
    [-5, -5, -5], [5, -5, -5], [5, 5, -5], [-5, 5, -5],
    [-5, -5, 5], [5, -5, 5], [5, 5, 5], [-5, 5, 5],
    [0, 5, 5], // midpoint of the top back edge 6-7
  ];
  const T = [
    [0, 2, 1], [0, 3, 2], // bottom
    [4, 5, 6], [4, 6, 8], [4, 8, 7], // top, split at the midpoint
    [0, 1, 5], [0, 5, 4], // front
    [2, 3, 7], [2, 7, 6], // back: uses the whole edge 7-6
    [1, 2, 6], [1, 6, 5], // right
    [3, 0, 4], [3, 4, 7], // left
  ];
  return new Float32Array(T.flat().flatMap((v) => V[v]));
}

describe('repairToManifold', () => {
  it('passes a clean cube through untouched', () => {
    const r = repair(cubeSoup());
    expect(r.status).toBe('NoError');
    expect(r.volume).toBeCloseTo(1000, 6);
    expect(r.report).toMatchObject({
      watertight: true, repaired: false, weldTolerance: 0, inputTriangles: 12, outputTriangles: 12,
      degenerateRemoved: 0, holesFilled: 0, trianglesFlipped: 0, shellsInverted: 0, shells: 1, shellsDropped: 0,
    });
    expect(r.report.notes).toEqual([]);
    expect(r.text).toBe('');
  });

  it('turns an inside-out cube right-side-out', () => {
    const r = repair(cubeSoup({ flip: true }));
    expect(r.status).toBe('NoError');
    expect(r.volume).toBeCloseTo(1000, 6);
    expect(r.report.shellsInverted).toBe(1);
    expect(r.report.repaired).toBe(true);
    expect(r.text).toMatch(/right-side-out/);
  });

  it('fills the hole left by a missing triangle', () => {
    const r = repair(cubeSoup({ dropTriangles: 1 }));
    expect(r.status).toBe('NoError');
    expect(r.volume).toBeCloseTo(1000, 6);
    expect(r.report.holesFilled).toBe(1);
    expect(r.report.outputTriangles).toBe(12);
    expect(r.text).toBe('Repaired: filled 1 hole.');
  });

  it('fills several scattered holes in a sphere', () => {
    const { Manifold } = manifold();
    const sphere = Manifold.sphere(10, 40);
    const volume = sphere.volume();
    const soup = dropTriangles(soupArray(sphere), [0, 160, 320, 480, 640]);
    const r = repair(soup);
    expect(r.status).toBe('NoError');
    expect(r.report.holesFilled).toBe(5);
    expect(Math.abs(r.volume - volume) / volume).toBeLessThan(0.01);
  });

  it('welds vertices perturbed by tiny amounts', () => {
    const rand = prng(42);
    const soup = cubeSoup();
    for (let i = 0; i < soup.length; i++) soup[i] += (rand() - 0.5) * 2e-5;
    const r = repair(soup);
    expect(r.status).toBe('NoError');
    expect(r.volume).toBeCloseTo(1000, 1);
    expect(r.report.repaired).toBe(true);
    expect(r.report.weldTolerance).toBeGreaterThan(0);
    expect(r.report.holesFilled).toBe(0);
    expect(r.text).toMatch(/^Repaired: welded \d+ vertices \(tolerance [\d.e-]+ mm\)\.$/);
  });

  it('welds and fills holes in the same mesh', () => {
    const rand = prng(7);
    const soup = cubeSoup({ dropTriangles: 1 });
    for (let i = 0; i < soup.length; i++) soup[i] += (rand() - 0.5) * 2e-5;
    const r = repair(soup);
    expect(r.status).toBe('NoError');
    expect(r.volume).toBeCloseTo(1000, 1);
    expect(r.report.weldTolerance).toBeGreaterThan(0);
    expect(r.report.holesFilled).toBe(1);
  });

  it('re-winds flipped triangles', () => {
    const r = repair(flipTriangles(cubeSoup(), [1, 5, 9]));
    expect(r.status).toBe('NoError');
    expect(r.volume).toBeCloseTo(1000, 6);
    expect(r.report.trianglesFlipped).toBe(3);
    expect(r.report.shellsInverted).toBe(0);
    expect(r.text).toBe('Repaired: flipped 3 triangles.');
  });

  it('removes duplicate, NaN and zero-area triangles', () => {
    const cube = cubeSoup();
    const t0 = cube.subarray(0, 9);
    const t1 = cube.subarray(9, 18);
    const t2 = cube.subarray(18, 27);
    const soup = concat(
      cube,
      t0, // exact duplicate
      new Float32Array([...t1.subarray(3, 6), ...t1.subarray(6, 9), ...t1.subarray(0, 3)]), // rotated duplicate
      new Float32Array([...t2.subarray(0, 3), ...t2.subarray(6, 9), ...t2.subarray(3, 6)]), // reversed duplicate
      new Float32Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]),
      new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]), // collinear
      new Float32Array([3, 3, 3, 3, 3, 3, 4, 4, 4]), // repeated corner
    );
    const r = repair(soup);
    expect(r.status).toBe('NoError');
    expect(r.volume).toBeCloseTo(1000, 6);
    expect(r.report.inputTriangles).toBe(18);
    expect(r.report.degenerateRemoved).toBe(6);
    expect(r.report.outputTriangles).toBe(12);
    expect(r.text).toBe('Repaired: removed 6 degenerate triangles.');
  });

  it('keeps two separate cubes as two shells', () => {
    const cube = cubeSoup();
    const r = repair(concat(cube, translated(cube, 100, 0, 0)));
    expect(r.status).toBe('NoError');
    expect(r.volume).toBeCloseTo(2000, 6);
    expect(r.report.shells).toBe(2);
    expect(r.report.shellsDropped).toBe(0);
    expect(r.report.repaired).toBe(false);
  });

  it('unions overlapping cubes', () => {
    const cube = cubeSoup();
    const r = repair(concat(cube, translated(cube, 5, 0, 0)));
    expect(r.status).toBe('NoError');
    expect(r.volume).toBeCloseTo(1500, 6);
    expect(r.report.shells).toBe(2);
    expect(r.text).toBe('Repaired: merged 2 overlapping shells.');
  });

  it('keeps an inverted inner shell as a cavity', () => {
    const outer = cubeSoup();
    const inner = soupArray(boxSolid(4, 4, 4), { flip: true });
    const r = repair(concat(outer, inner));
    expect(r.status).toBe('NoError');
    expect(r.volume).toBeCloseTo(1000 - 64, 6);
    expect(r.report.shells).toBe(2);
    expect(r.report.shellsInverted).toBe(0);
    // ... and still recognises the whole thing being inside-out
    const flipped = repair(concat(cubeSoup({ flip: true }), soupArray(boxSolid(4, 4, 4))));
    expect(flipped.volume).toBeCloseTo(1000 - 64, 6);
    expect(flipped.report.shellsInverted).toBe(2);
  });

  it('repairs a T-junction', () => {
    const r = repair(tJunctionCube());
    expect(r.status).toBe('NoError');
    expect(r.volume).toBeCloseTo(1000, 6);
    expect(r.report.repaired).toBe(true);
    expect(r.report.holesFilled).toBe(1);
  });

  it('gives up on a single open triangle', () => {
    const { manifold: m, report } = repairToManifold(new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]));
    expect(m).toBeNull();
    expect(report.watertight).toBe(false);
    expect(report.shellsDropped).toBe(1);
    expect(report.shells).toBe(0);
    expect(report.outputTriangles).toBe(0);
    expect(describeRepair(report)).toMatch(/^Could not repair: .*dropped 1 shell that could not be repaired\.$/);
  });

  it('fills a big hole where a whole face is missing', () => {
    const cube = cubeSoup();
    const top = [];
    for (let t = 0; t < 12; t++) if (triangleNormal(cube, t)[2] > 0) top.push(t);
    expect(top).toHaveLength(2);
    const r = repair(dropTriangles(cube, top));
    expect(r.status).toBe('NoError');
    expect(r.volume).toBeCloseTo(1000, 6);
    expect(r.report.holesFilled).toBe(1);
    expect(r.report.outputTriangles).toBe(12);
  });

  it('removes triangles on non-manifold edges and refills', () => {
    const cube = cubeSoup();
    // A fin: an extra triangle hanging off the top back edge (y = 5, z = 5).
    const fin = new Float32Array([-5, 5, 5, 5, 5, 5, 0, 5, 12]);
    const r = repair(concat(cube, fin));
    expect(r.status).toBe('NoError');
    expect(r.volume).toBeCloseTo(1000, 6);
    expect(r.report.holesFilled).toBeGreaterThan(0);
    expect(r.text).toMatch(/removed 3 triangles on non-manifold edges/);
  });

  it('respects maxHoleEdges', () => {
    const cube = cubeSoup();
    const top = [];
    for (let t = 0; t < 12; t++) if (triangleNormal(cube, t)[2] > 0) top.push(t);
    const r = repair(dropTriangles(cube, top), { maxHoleEdges: 3 });
    expect(r.status).toBeNull();
    expect(r.report.holesFilled).toBe(0);
    expect(r.report.shellsDropped).toBe(1);
    expect(r.text).toMatch(/skipped 1 hole with more than 3 edges/);
  });

  it('reports progress stages', () => {
    const stages = [];
    repair(cubeSoup({ dropTriangles: 1 }), { onProgress: (s) => stages.push(s) });
    expect(stages[0]).toBe('Removing degenerate triangles');
    expect(stages).toContain('Welding vertices');
    expect(stages).toContain('Filling holes');
  });

  it('returns null for an empty soup', () => {
    const { manifold: m, report } = repairToManifold(new Float32Array(0));
    expect(m).toBeNull();
    expect(report.watertight).toBe(false);
    expect(report.inputTriangles).toBe(0);
  });

  it('repairs a 720k-triangle sphere soup quickly', () => {
    const { Manifold } = manifold();
    const sphere = Manifold.sphere(50, 1200);
    const volume = sphere.volume();
    const triangles = sphere.numTri();
    const soup = soupArray(sphere);
    expect(triangles).toBe(720000);
    const t0 = performance.now();
    const { manifold: m, report } = repairToManifold(soup);
    const ms = performance.now() - t0;
    expect(m).not.toBeNull();
    expect(m.status()).toBe('NoError');
    expect(m.volume()).toBeCloseTo(volume, 3);
    expect(report.watertight).toBe(true);
    expect(report.repaired).toBe(false);
    expect(report.outputTriangles).toBe(triangles);
    m.delete();
    console.log(`repairToManifold: ${triangles} triangles in ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(6000);
  }, 60000);
});

describe('describeRepair', () => {
  it('is empty for an untouched mesh', () => {
    expect(describeRepair(repairToManifold(cubeSoup()).report)).toBe('');
    expect(describeRepair(null)).toBe('');
  });

  it('lists every action taken', () => {
    const soup = concat(flipTriangles(cubeSoup({ dropTriangles: 1 }), [2]), cubeSoup().subarray(0, 9));
    const { manifold: m, report } = repairToManifold(soup);
    m.delete();
    expect(describeRepair(report)).toBe('Repaired: removed 1 degenerate triangle, flipped 1 triangle, filled 1 hole.');
  });
});
