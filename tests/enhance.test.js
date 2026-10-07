import { beforeAll, describe, expect, it } from 'vitest';
import { CAP_FACTOR, ENHANCE_DEFAULTS, enhanceMesh, isEnhanceActive } from '../src/enhance.js';
import { manifold } from '../src/manifold.js';
import { setup } from './helpers.js';

let wasm;

/** { positions, index } of a Manifold, welded and indexed. */
function meshOf(solid) {
  const m = solid.getMesh();
  const stride = m.numProp;
  const V = m.vertProperties.length / stride;
  const positions = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) {
    positions[i * 3] = m.vertProperties[i * stride];
    positions[i * 3 + 1] = m.vertProperties[i * stride + 1];
    positions[i * 3 + 2] = m.vertProperties[i * stride + 2];
  }
  return { positions, index: m.triVerts.slice() };
}

const build = (fn) => {
  const solid = fn(wasm.Manifold);
  const mesh = meshOf(solid);
  solid.delete();
  return mesh;
};

/** Deterministic pseudo-random numbers in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform Laplacian smoothing: rounds every edge of the mesh (a "soft" model). */
function soften(mesh, lambda, passes) {
  const { index } = mesh;
  const V = mesh.positions.length / 3;
  let pos = Float64Array.from(mesh.positions);
  const cnt = new Int32Array(V);
  const acc = new Float64Array(V * 3);
  for (let p = 0; p < passes; p++) {
    cnt.fill(0);
    acc.fill(0);
    for (let t = 0; t < index.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = index[t + k];
        const b = index[t + ((k + 1) % 3)];
        for (let c = 0; c < 3; c++) {
          acc[a * 3 + c] += pos[b * 3 + c];
          acc[b * 3 + c] += pos[a * 3 + c];
        }
        cnt[a]++;
        cnt[b]++;
      }
    }
    const next = new Float64Array(V * 3);
    for (let v = 0; v < V; v++) for (let c = 0; c < 3; c++) next[v * 3 + c] = cnt[v] ? pos[v * 3 + c] + lambda * (acc[v * 3 + c] / cnt[v] - pos[v * 3 + c]) : pos[v * 3 + c];
    pos = next;
  }
  return { positions: Float32Array.from(pos), index };
}

function vertexNormals(positions, index) {
  const V = positions.length / 3;
  const n = new Float64Array(V * 3);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      n[v * 3] += nx;
      n[v * 3 + 1] += ny;
      n[v * 3 + 2] += nz;
    }
  }
  for (let v = 0; v < V; v++) {
    const l = Math.hypot(n[v * 3], n[v * 3 + 1], n[v * 3 + 2]) || 1;
    n[v * 3] /= l;
    n[v * 3 + 1] /= l;
    n[v * 3 + 2] /= l;
  }
  return n;
}

/** Per-vertex noise along the normals (bumpy, low-quality surface). */
function addNoise(mesh, amplitude, seed) {
  const rnd = mulberry32(seed);
  const n = vertexNormals(mesh.positions, mesh.index);
  const positions = Float32Array.from(mesh.positions);
  for (let v = 0; v < positions.length / 3; v++) {
    const d = (rnd() * 2 - 1) * amplitude;
    positions[v * 3] += d * n[v * 3];
    positions[v * 3 + 1] += d * n[v * 3 + 1];
    positions[v * 3 + 2] += d * n[v * 3 + 2];
  }
  return { positions, index: mesh.index };
}

/* ---- metrics ---- */

function faceNormalsAreas(positions, index) {
  const T = index.length / 3;
  const n = new Float64Array(T * 3);
  const area = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2];
    const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    area[t] = l / 2;
    if (l > 0) {
      n[t * 3] = nx / l;
      n[t * 3 + 1] = ny / l;
      n[t * 3 + 2] = nz / l;
    }
  }
  return { n, area };
}

/** Fraction of the surface area whose normal points within `deg` of an axis direction – how "boxy" a shape is. */
function axisFraction(positions, index, deg = 5) {
  const { n, area } = faceNormalsAreas(positions, index);
  const c = Math.cos((deg * Math.PI) / 180);
  let ok = 0;
  let tot = 0;
  for (let t = 0; t < area.length; t++) {
    tot += area[t];
    if (Math.max(Math.abs(n[t * 3]), Math.abs(n[t * 3 + 1]), Math.abs(n[t * 3 + 2])) >= c) ok += area[t];
  }
  return ok / tot;
}

function volume(positions, index) {
  let v = 0;
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    v +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return v / 6;
}

/** Triangles whose normal turned against the input normal (or collapsed). */
function flips(pos0, pos1, index) {
  const A = faceNormalsAreas(pos0, index);
  const B = faceNormalsAreas(pos1, index);
  let bad = 0;
  for (let t = 0; t < A.area.length; t++) {
    if (A.area[t] === 0) continue;
    const d = A.n[t * 3] * B.n[t * 3] + A.n[t * 3 + 1] * B.n[t * 3 + 1] + A.n[t * 3 + 2] * B.n[t * 3 + 2];
    if (d <= 0 || B.area[t] === 0) bad++;
  }
  return bad;
}

function displacements(pos0, pos1) {
  let max = 0;
  let sum = 0;
  for (let v = 0; v < pos0.length; v += 3) {
    const d = Math.hypot(pos1[v] - pos0[v], pos1[v + 1] - pos0[v + 1], pos1[v + 2] - pos0[v + 2]);
    if (d > max) max = d;
    sum += d;
  }
  return { max, mean: sum / (pos0.length / 3) };
}

/** Local mean edge length per vertex (the cap is a fraction of it). */
function localEdge(positions, index) {
  const V = positions.length / 3;
  const sum = new Float64Array(V);
  const cnt = new Int32Array(V);
  for (let t = 0; t < index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = index[t + k], b = index[t + ((k + 1) % 3)];
      const l = Math.hypot(positions[a * 3] - positions[b * 3], positions[a * 3 + 1] - positions[b * 3 + 1], positions[a * 3 + 2] - positions[b * 3 + 2]);
      sum[a] += l;
      cnt[a]++;
      sum[b] += l;
      cnt[b]++;
    }
  }
  return sum.map((s, v) => (cnt[v] ? s / cnt[v] : 0));
}

/** RMS deviation of the plate's top-face vertices from z = zTop (away from the edges). */
function topRms(ref, pos, zTop, half, margin = 1.5) {
  let s = 0;
  let c = 0;
  for (let v = 0; v < ref.length; v += 3) {
    if (Math.abs(ref[v + 2] - zTop) > 0.5) continue;
    if (Math.abs(ref[v]) > half - margin || Math.abs(ref[v + 1]) > half - margin) continue;
    s += (pos[v + 2] - zTop) ** 2;
    c++;
  }
  return Math.sqrt(s / c);
}

function manifoldOf(positions, index) {
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(positions), triVerts: index });
  return wasm.Manifold.ofMesh(mesh);
}

/** The invariants every enhancement must keep. */
function expectSound(mesh, out, { volumeTolerance = 0.02 } = {}) {
  expect(out.positions).toBeInstanceOf(Float32Array);
  expect(out.positions.length).toBe(mesh.positions.length);
  expect(out.positions.every(Number.isFinite)).toBe(true);
  expect(flips(mesh.positions, out.positions, mesh.index)).toBe(0);
  const edge = localEdge(mesh.positions, mesh.index);
  for (let v = 0; v < edge.length; v++) {
    const d = Math.hypot(out.positions[v * 3] - mesh.positions[v * 3], out.positions[v * 3 + 1] - mesh.positions[v * 3 + 1], out.positions[v * 3 + 2] - mesh.positions[v * 3 + 2]);
    expect(d).toBeLessThanOrEqual(CAP_FACTOR * edge[v] + 1e-5);
  }
  const m = manifoldOf(out.positions, mesh.index);
  expect(m.status()).toBe('NoError');
  expect(m.isEmpty()).toBe(false);
  m.delete();
  const v0 = volume(mesh.positions, mesh.index);
  const v1 = volume(out.positions, mesh.index);
  expect(Math.abs(v1 - v0) / v0).toBeLessThan(volumeTolerance);
  expect(out.stats.verticesMoved).toBeLessThanOrEqual(mesh.positions.length / 3);
  expect(out.stats.maxDisplacement).toBeGreaterThanOrEqual(out.stats.meanDisplacement);
  expect(Number.isInteger(out.stats.flipsPrevented)).toBe(true);
}

const sphereStats = (p) => {
  let sum = 0;
  const rs = [];
  for (let v = 0; v < p.length; v += 3) {
    const R = Math.hypot(p[v], p[v + 1], p[v + 2]);
    rs.push(R);
    sum += R;
  }
  const mean = sum / rs.length;
  let va = 0;
  for (const R of rs) va += (R - mean) ** 2;
  return { mean, std: Math.sqrt(va / rs.length) };
};

function bumpySphere() {
  const base = build((M) => M.sphere(10, 64));
  const rnd = mulberry32(5);
  const centres = [];
  for (let i = 0; i < 16; i++) {
    const z = 2 * rnd() - 1;
    const phi = 2 * Math.PI * rnd();
    const r = Math.sqrt(1 - z * z);
    centres.push([10 * r * Math.cos(phi), 10 * r * Math.sin(phi), 10 * z, rnd() < 0.5 ? -1 : 1]);
  }
  const p = Float32Array.from(base.positions);
  for (let v = 0; v < p.length; v += 3) {
    const R = Math.hypot(p[v], p[v + 1], p[v + 2]);
    let d = 0;
    for (const [cx, cy, cz, sign] of centres) {
      const dist = Math.hypot(p[v] - cx, p[v + 1] - cy, p[v + 2] - cz);
      d += sign * 0.3 * Math.exp(-(dist * dist) / (2 * 1.5 * 1.5));
    }
    const k = (R + d) / R;
    p[v] *= k;
    p[v + 1] *= k;
    p[v + 2] *= k;
  }
  return { positions: p, index: base.index };
}

beforeAll(async () => {
  await setup();
  wasm = manifold();
});

describe('enhanceMesh: sharpen', () => {
  it('turns the rounded edges of a softened cube back into crisp ones', () => {
    const cube = build((M) => M.cube([20, 20, 20], true).refineToLength(1));
    const soft = soften(cube, 0.5, 2);
    const before = axisFraction(soft.positions, soft.index);
    expect(before).toBeLessThan(0.9);
    const out = enhanceMesh(soft, { sharpen: 1 });
    expectSound(soft, out);
    expect(axisFraction(out.positions, out.index ?? soft.index)).toBeGreaterThan(0.95);
    expect(out.stats.verticesMoved).toBeGreaterThan(soft.positions.length / 6);
    expect(out.stats.featureEdges).toBeGreaterThan(100); // the 12 edges, 20 segments each
    // half the amount is half the way there
    const half = enhanceMesh(soft, { sharpen: 0.5 });
    expectSound(soft, half);
    expect(displacements(soft.positions, half.positions).max).toBeCloseTo(displacements(soft.positions, out.positions).max / 2, 1);
  });

  it('leaves an already sharp cube, a sphere and a cylinder alone', () => {
    const cube = build((M) => M.cube([20, 20, 20], true).refineToLength(1));
    const same = enhanceMesh(cube, { sharpen: 1, smooth: 1, detail: 1 });
    expect(displacements(cube.positions, same.positions).max).toBeLessThan(1e-9);
    const sphere = build((M) => M.sphere(10, 64));
    expect(displacements(sphere.positions, enhanceMesh(sphere, { sharpen: 1 }).positions).max).toBeLessThan(0.01);
    const cylinder = build((M) => M.cylinder(20, 10, 10, 96, true).refineToLength(0.7));
    expect(displacements(cylinder.positions, enhanceMesh(cylinder, { sharpen: 1 }).positions).max).toBeLessThan(0.02);
    expect(displacements(cylinder.positions, enhanceMesh(cylinder, { detail: 1 }).positions).max).toBeLessThan(1e-9);
  });

  it('a larger movement allowance sharpens a wider rounding further', () => {
    const rounded = build((M) => {
      const core = M.cube([20, 20, 8], true);
      const ball = M.sphere(1.5, 12);
      const r = core.minkowskiSum(ball).refineToLength(0.8);
      core.delete();
      ball.delete();
      return r;
    });
    const before = axisFraction(rounded.positions, rounded.index);
    const auto = enhanceMesh(rounded, { sharpen: 1 });
    expectSound(rounded, auto);
    const wide = enhanceMesh(rounded, { sharpen: 1, maxMove: 0.6 });
    expect(flips(rounded.positions, wide.positions, rounded.index)).toBe(0);
    expect(wide.stats.maxDisplacement).toBeLessThanOrEqual(0.6 + 1e-6);
    expect(wide.stats.maxDisplacement).toBeGreaterThan(auto.stats.maxDisplacement);
    expect(axisFraction(auto.positions, rounded.index)).toBeGreaterThan(before + 0.05);
  });
});

describe('enhanceMesh: smooth', () => {
  it('flattens a bumpy plate while keeping its edges square', () => {
    const plate = build((M) => M.cube([30, 30, 4], true).refineToLength(0.5));
    const noisy = addNoise(plate, 0.1, 7);
    const before = topRms(plate.positions, noisy.positions, 2, 15);
    const out = enhanceMesh(noisy, { smooth: 1 });
    expectSound(noisy, out);
    const after = topRms(plate.positions, out.positions, 2, 15);
    expect(after).toBeLessThan(before * 0.5);
    expect(axisFraction(out.positions, noisy.index)).toBeGreaterThan(0.97); // faces flat again …
    expect(out.stats.featureEdges).toBeGreaterThan(200); // … and the 12 edges still there (30 / 0.5 segments each)
    // a milder amount also helps (the two amounts end up close on noise this small)
    const mild = enhanceMesh(noisy, { smooth: 0.5 });
    expectSound(noisy, mild);
    expect(topRms(plate.positions, mild.positions, 2, 15)).toBeLessThan(before * 0.75);
  });
});

describe('enhanceMesh: detail', () => {
  it('amplifies relief on a bumpy sphere without inflating it, more with more amount', () => {
    const bumpy = bumpySphere();
    const s0 = sphereStats(bumpy.positions);
    const full = enhanceMesh(bumpy, { detail: 1 });
    expectSound(bumpy, full);
    const s1 = sphereStats(full.positions);
    expect(s1.std / s0.std).toBeGreaterThan(1.25);
    expect(Math.abs(s1.mean / s0.mean - 1)).toBeLessThan(0.005);
    const half = enhanceMesh(bumpy, { detail: 0.5 });
    const sh = sphereStats(half.positions);
    expect(sh.std).toBeGreaterThan(s0.std * 1.1);
    expect(sh.std).toBeLessThan(s1.std);
    // an explicit relief size equal to the automatic one (five edge lengths) boosts the same; a wider one still boosts
    const sized = enhanceMesh(bumpy, { detail: 1, featureSize: 6 });
    expect(sphereStats(sized.positions).std / s0.std).toBeGreaterThan(1.25);
    const wide = enhanceMesh(bumpy, { detail: 1, featureSize: 9 });
    expect(sphereStats(wide.positions).std / s0.std).toBeGreaterThan(1.1);
  });

  it('does not turn surface noise into relief', () => {
    const plate = build((M) => M.cube([30, 30, 4], true).refineToLength(0.5));
    const noisy = addNoise(plate, 0.05, 7);
    const before = topRms(plate.positions, noisy.positions, 2, 15);
    const out = enhanceMesh(noisy, { detail: 1 });
    expectSound(noisy, out);
    expect(topRms(plate.positions, out.positions, 2, 15)).toBeLessThan(before * 1.5);
  });

  it('pins creases: sharp relief on a flat block stays bit-for-bit where it is', () => {
    const emboss = build((M) => {
      const base = M.cube([20, 20, 10], true);
      const top = M.cube([8, 8, 1], true).translate(0, 0, 5.5);
      const r = base.add(top).refineToLength(0.5);
      base.delete();
      top.delete();
      return r;
    });
    const out = enhanceMesh(emboss, { detail: 1 });
    expect(displacements(emboss.positions, out.positions).max).toBeLessThan(1e-9);
    expect(out.stats.featureEdges).toBeGreaterThan(0);
  });
});

describe('enhanceMesh: coarse and curved shapes are respected', () => {
  it('smoothing and sharpening leave coarse faceted spheres exactly alone, boosting leaves fine ones alone', () => {
    for (const segments of [16, 24, 32, 64]) {
      const sphere = build((M) => M.sphere(10, segments));
      for (const opts of [{ smooth: 1 }, { sharpen: 1, smooth: 1 }]) {
        const out = enhanceMesh(sphere, opts);
        expect(displacements(sphere.positions, out.positions).max).toBeLessThan(1e-9);
      }
    }
    const fine = build((M) => M.sphere(10, 64));
    expect(displacements(fine.positions, enhanceMesh(fine, { detail: 1 }).positions).max).toBeLessThan(1e-9);
    // a coarser sphere may show a little, bounded, and keeps its volume
    const coarse = build((M) => M.sphere(10, 32));
    const out = enhanceMesh(coarse, { detail: 1 });
    expectSound(coarse, out, { volumeTolerance: 0.01 });
    expect(out.stats.maxDisplacement).toBeLessThan(0.1 * 1.9); // a tenth of its ~1.9 mm edges
  });

  it('coarse cylinders keep their facets under sharpening', () => {
    for (const [segments, edge] of [[24, 1], [32, 1]]) {
      const cylinder = build((M) => M.cylinder(20, 10, 10, segments, true).refineToLength(edge));
      const out = enhanceMesh(cylinder, { sharpen: 1 });
      expect(displacements(cylinder.positions, out.positions).max).toBeLessThan(0.1);
      expect(flips(cylinder.positions, out.positions, cylinder.index)).toBe(0);
    }
  });

  it('the sharpen amount is continuous and monotone even with smoothing on', () => {
    const cube = build((M) => M.cube([20, 20, 20], true).refineToLength(1));
    const soft = soften(cube, 0.5, 2);
    let last = -1;
    let lastMax = 0;
    for (const sharpen of [0, 0.05, 0.25, 0.5, 0.75, 1]) {
      const out = enhanceMesh(soft, { sharpen, smooth: 0.5 });
      expectSound(soft, out);
      const axis = axisFraction(out.positions, soft.index);
      const max = displacements(soft.positions, out.positions).max;
      expect(axis).toBeGreaterThanOrEqual(last - 0.005);
      if (sharpen === 0.05) expect(Math.abs(max - lastMax)).toBeLessThan(0.05); // no jump when the slider leaves zero
      last = axis;
      lastMax = max;
    }
    expect(last).toBeGreaterThan(0.92);
  });
});

describe('enhanceMesh: contract', () => {
  it('rejects a broken index instead of silently doing nothing, and treats infinite caps as automatic', () => {
    const tri = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), index: new Uint32Array([0, 1, 5]) };
    expect(() => enhanceMesh(tri, { sharpen: 1 })).toThrow(/vertex 5/);
    const odd = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]), index: new Uint32Array([0, 1, 2]) };
    expect(() => enhanceMesh(odd, { sharpen: 1 })).toThrow(/3 numbers/);
    const nan = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, NaN, 0]), index: new Uint32Array([0, 1, 2]) };
    expect(() => enhanceMesh(nan, { detail: 1 })).toThrow(/non-finite/);
    const cube = build((M) => M.cube([10, 10, 10], true).refineToLength(1));
    const soft = soften(cube, 0.5, 2);
    const inf = enhanceMesh(soft, { sharpen: 1, detail: 1, maxMove: Infinity });
    expect(inf.positions.every(Number.isFinite)).toBe(true);
    expect(inf.positions).toEqual(enhanceMesh(soft, { sharpen: 1, detail: 1 }).positions);
  });

  it('zero amounts return identical positions, never touch the input, and are deterministic', () => {
    const cube = build((M) => M.cube([10, 10, 10], true).refineToLength(1));
    const soft = soften(cube, 0.5, 2);
    const before = soft.positions.slice();
    expect(isEnhanceActive(ENHANCE_DEFAULTS)).toBe(false);
    expect(isEnhanceActive({ ...ENHANCE_DEFAULTS, smooth: 0.1 })).toBe(true);
    const same = enhanceMesh(soft, { sharpen: 0, smooth: 0, detail: 0 });
    expect(same.positions).toEqual(soft.positions);
    expect(same.positions).not.toBe(soft.positions);
    const a = enhanceMesh(soft, { sharpen: 1, smooth: 0.5, detail: 0.7 });
    const b = enhanceMesh(soft, { sharpen: 1, smooth: 0.5, detail: 0.7 });
    expect(a.positions).toEqual(b.positions);
    expect(soft.positions).toEqual(before);
    expect(a.stats.iterations).toBeGreaterThan(0);
  });

  it('is independent of the model orientation', () => {
    const cube = build((M) => M.cube([20, 20, 20], true).refineToLength(1));
    const soft = soften(cube, 0.5, 2);
    const out = enhanceMesh(soft, { sharpen: 1, smooth: 0.4, detail: 0.6 }).positions;
    // rotate by an awkward angle about a skew axis, enhance, rotate back
    const ax = [0.36, 0.48, 0.8];
    const ang = 0.7;
    const rotate = (p, sign) => {
      const c = Math.cos(sign * ang), s = Math.sin(sign * ang);
      const r = new Float32Array(p.length);
      for (let v = 0; v < p.length; v += 3) {
        const x = p[v], y = p[v + 1], z = p[v + 2];
        const dot = ax[0] * x + ax[1] * y + ax[2] * z;
        const cx = ax[1] * z - ax[2] * y, cy = ax[2] * x - ax[0] * z, cz = ax[0] * y - ax[1] * x;
        r[v] = x * c + cx * s + ax[0] * dot * (1 - c);
        r[v + 1] = y * c + cy * s + ax[1] * dot * (1 - c);
        r[v + 2] = z * c + cz * s + ax[2] * dot * (1 - c);
      }
      return r;
    };
    const turned = enhanceMesh({ positions: rotate(soft.positions, 1), index: soft.index }, { sharpen: 1, smooth: 0.4, detail: 0.6 }).positions;
    const back = rotate(turned, -1);
    expect(displacements(out, back).max).toBeLessThan(0.02); // 2% of an edge: threshold effects on an exactly symmetric shape
  });

  it('survives degenerate input without NaN, moving nothing it cannot judge', () => {
    const tet = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), index: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) };
    const t = enhanceMesh(tet, { sharpen: 1, smooth: 1, detail: 1 });
    expect(t.positions.every(Number.isFinite)).toBe(true);
    expect(displacements(tet.positions, t.positions).max).toBeLessThan(1e-9);
    const m = manifoldOf(t.positions, tet.index);
    expect(m.status()).toBe('NoError');
    m.delete();
    // a zero-area triangle, an isolated vertex, and open (boundary) edges
    const odd = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 1, 5, 5, 5]), index: new Uint32Array([0, 1, 2, 0, 3, 1, 1, 3, 4, 0, 4, 3]) };
    const o = enhanceMesh(odd, { sharpen: 1, smooth: 1, detail: 1 });
    expect(o.positions.every(Number.isFinite)).toBe(true);
    expect(displacements(odd.positions, o.positions).max).toBeLessThan(1e-9);
    // an open plate (two triangles): every vertex is on a boundary, nothing moves
    const quad = { positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]), index: new Uint32Array([0, 1, 2, 0, 2, 3]) };
    const q = enhanceMesh(quad, { sharpen: 1, smooth: 1, detail: 1 });
    expect(q.positions).toEqual(quad.positions);
    // nothing at all
    expect(enhanceMesh({ positions: new Float32Array(0), index: new Uint32Array(0) }, { sharpen: 1 }).positions.length).toBe(0);
    // odd option values are clamped, not fatal
    const cube = build((M) => M.cube([10, 10, 10], true).refineToLength(1));
    const soft = soften(cube, 0.5, 2);
    const wild = enhanceMesh(soft, { sharpen: 7, smooth: -1, detail: 'x', edgeAngle: 0, featureSize: -3, maxMove: NaN });
    expectSound(soft, wild);
  });

  it('reports progress in order and stays fast on a 100k-triangle mesh', () => {
    const big = build((M) => M.cube([20, 20, 20], true).refineToLength(0.25));
    expect(big.index.length / 3).toBeGreaterThan(90_000);
    const soft = soften(big, 0.5, 2);
    const calls = [];
    const t0 = performance.now();
    const out = enhanceMesh(soft, { sharpen: 1, smooth: 1, detail: 1 }, (stage, fraction) => calls.push({ stage, fraction }));
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(3000);
    expect(flips(soft.positions, out.positions, soft.index)).toBe(0);
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.length).toBeLessThan(80);
    for (let i = 1; i < calls.length; i++) expect(calls[i].fraction).toBeGreaterThanOrEqual(calls[i - 1].fraction);
    expect(calls[0].fraction).toBe(0);
    expect(calls[calls.length - 1].fraction).toBe(1);
    expect(new Set(calls.map((c) => c.stage)).size).toBeGreaterThan(3);
  });
});
