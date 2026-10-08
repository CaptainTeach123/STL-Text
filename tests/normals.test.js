import { beforeAll, describe, expect, it } from 'vitest';
import { manifold } from '../src/manifold.js';
import { cornerNormals, normalsTopology } from '../src/normals.js';
import { setup } from './helpers.js';

let wasm;

beforeAll(async () => {
  await setup();
  wasm = manifold();
});

/* ------------------------------------------------------------------ helpers */

/** { positions, index } of a Manifold (its mesh has numProp 3). */
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

/**
 * Manifold's own answer. `calculateNormals(0, deg)` stores the normals in
 * properties 3–5 and keeps the triangle order; every shaded vertex comes from
 * exactly one source vertex, so corner c of both meshes is the same corner.
 * Returns the normals per corner (3 * C) and how many shaded vertices there are.
 */
function manifoldNormals(solid, mesh, deg = 36) {
  const shaded = solid.calculateNormals(0, deg);
  const m = shaded.getMesh();
  shaded.delete();
  expect(m.numProp).toBe(6);
  expect(m.triVerts.length).toBe(mesh.index.length);
  const normals = new Float32Array(mesh.index.length * 3);
  for (let c = 0; c < mesh.index.length; c++) {
    const v0 = mesh.index[c] * 3;
    const v1 = m.triVerts[c] * 6;
    for (let a = 0; a < 3; a++) {
      if (mesh.positions[v0 + a] !== m.vertProperties[v1 + a]) throw new Error(`corner ${c} is not the same vertex in the shaded mesh`);
      normals[3 * c + a] = m.vertProperties[v1 + 3 + a];
    }
  }
  return { normals, shadedVertices: m.vertProperties.length / 6 };
}

const toDeg = (dot) => (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;

/** Angle in degrees between the vectors a[3i..3i+2] and b[3j..3j+2]. */
function angleBetween(a, i, b, j) {
  const ax = a[3 * i], ay = a[3 * i + 1], az = a[3 * i + 2];
  const bx = b[3 * j], by = b[3 * j + 1], bz = b[3 * j + 2];
  return toDeg((ax * bx + ay * by + az * bz) / (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz)));
}

/** Corner-wise comparison of two normal sets: the largest angle and the share within 1°. */
function compare(ours, ref) {
  const C = ours.length / 3;
  let max = 0;
  let within = 0;
  for (let c = 0; c < C; c++) {
    const d = angleBetween(ours, c, ref, c);
    if (d > max) max = d;
    if (d <= 1) within++;
  }
  return { max, within: within / C };
}

/** Unit face normals, 3 numbers per triangle. */
function faceNormals(positions, index) {
  const T = index.length / 3;
  const out = new Float64Array(T * 3);
  for (let t = 0; t < T; t++) {
    const a = index[3 * t] * 3, b = index[3 * t + 1] * 3, c = index[3 * t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    out[3 * t] = nx / len;
    out[3 * t + 1] = ny / len;
    out[3 * t + 2] = nz / len;
  }
  return out;
}

const tri = (c) => Math.floor(c / 3);
const next = (c) => (c % 3 === 2 ? c - 2 : c + 1);

/** Largest angle between any two corner normals at the same vertex, over the given corners of one vertex. */
function spreadAtVertex(normals, cornerIds) {
  let max = 0;
  for (let i = 1; i < cornerIds.length; i++) max = Math.max(max, angleBetween(normals, cornerIds[0], normals, cornerIds[i]));
  return max;
}

/** The corners of every vertex, from the CSR topology. */
function cornersByVertex(topology) {
  const { offsets, corners, vertexCount } = topology;
  const out = [];
  for (let v = 0; v < vertexCount; v++) out.push(Array.from(corners.subarray(offsets[v], offsets[v + 1])));
  return out;
}

/** Compare our normals with Manifold's on `solid`, log the deviation and require 99.9% within 1°. */
function expectLikeManifold(name, solid) {
  const mesh = meshOf(solid);
  const ref = manifoldNormals(solid, mesh);
  const ours = cornerNormals(mesh.positions, mesh.index, 36);
  const { max, within } = compare(ours, ref.normals);
  console.log(`${name}: ${mesh.index.length / 3} triangles, ${ref.shadedVertices} shaded vertices for ${mesh.positions.length / 3} vertices, max deviation ${max.toFixed(4)}°, ${(within * 100).toFixed(3)}% of corners within 1°`);
  expect(within).toBeGreaterThanOrEqual(0.999);
  return { mesh, ref, ours, max };
}

/* ----------------------------------------------------------------- fixtures */

const cube = () => wasm.Manifold.cube([10, 10, 10]);
const sphere = () => wasm.Manifold.sphere(10, 64);
const cylinder = () => wasm.Manifold.cylinder(10, 5, 5, 48);

/**
 * Cube with a through hole (sharp rims, 11.25° facets inside) and its +X top
 * edge shaved off at a shallow 20°: the cutter is a big box whose bottom face
 * is tilted 20° about Y and passes through (5, 0, 3).
 */
const chamfered = () => {
  const { Manifold } = wasm;
  const hole = Manifold.cylinder(20, 2, 2, 32, true);
  const cutter = Manifold.cube([40, 40, 40], true).translate(0, 0, 20).rotate(0, 20, 0).translate(5, 0, 3);
  return Manifold.cube([10, 10, 10], true).subtract(hole).subtract(cutter);
};

const cubeSphere = () => wasm.Manifold.cube([10, 10, 10], true).add(wasm.Manifold.sphere(6.5, 48));

/** Sphere with sinusoidal bumps: smooth over most of it, sharp where the bumps are steepest. */
const bumpy = () =>
  wasm.Manifold.sphere(20, 200).warpBatch((v, n) => {
    for (let i = 0; i < n; i++) {
      const x = v[3 * i], y = v[3 * i + 1], z = v[3 * i + 2];
      const s = 1 + 0.125 * Math.sin(x) * Math.sin(1.3 * y) * Math.sin(0.7 * z);
      v[3 * i] = x * s;
      v[3 * i + 1] = y * s;
      v[3 * i + 2] = z * s;
    }
  });

/** Planar strip of n quads in z = 0, counter-clockwise seen from +Z: an open mesh. */
function strip(n) {
  const positions = new Float32Array((n + 1) * 2 * 3);
  for (let i = 0; i <= n; i++) {
    positions[6 * i] = i;
    positions[6 * i + 3] = i;
    positions[6 * i + 4] = 1;
  }
  const index = new Uint32Array(n * 6);
  for (let i = 0; i < n; i++) index.set([2 * i, 2 * i + 2, 2 * i + 3, 2 * i, 2 * i + 3, 2 * i + 1], 6 * i);
  return { positions, index };
}

/* -------------------------------------------------------------------- tests */

describe('cornerNormals reproduces Manifold.calculateNormals(0, 36)', () => {
  it('cube: every corner uses its face normal', () => {
    const solid = cube();
    const { mesh, ours } = expectLikeManifold('cube', solid);
    solid.delete();
    const fn = faceNormals(mesh.positions, mesh.index);
    for (let c = 0; c < mesh.index.length; c++) expect(angleBetween(ours, c, fn, tri(c))).toBeLessThan(0.01);
  });

  it('sphere: smooth everywhere, one normal per vertex', () => {
    const solid = sphere();
    const { mesh, ours, max } = expectLikeManifold('sphere', solid);
    solid.delete();
    expect(max).toBeLessThan(0.01);
    for (const corners of cornersByVertex(normalsTopology(mesh.index, mesh.positions.length / 3))) expect(spreadAtVertex(ours, corners)).toBeLessThan(0.01);
  });

  it('cylinder: sharp rims, smooth sides', () => {
    const solid = cylinder();
    const { mesh, ours, max } = expectLikeManifold('cylinder', solid);
    solid.delete();
    expect(max).toBeLessThan(0.01);
    const fn = faceNormals(mesh.positions, mesh.index);
    const up = [0, 0, 1];
    for (let c = 0; c < mesh.index.length; c++) {
      if (Math.abs(fn[3 * tri(c) + 2]) > 0.5) {
        // cap corner: exactly the cap normal
        expect(angleBetween(ours, c, up, 0) % 180).toBeLessThan(0.01);
      } else {
        // side corner: horizontal
        expect(Math.abs(ours[3 * c + 2])).toBeLessThan(1e-4);
      }
    }
    // all side corners of a rim vertex share one normal
    for (const corners of cornersByVertex(normalsTopology(mesh.index, mesh.positions.length / 3))) {
      const sides = corners.filter((c) => Math.abs(fn[3 * tri(c) + 2]) < 0.5);
      expect(spreadAtVertex(ours, sides)).toBeLessThan(0.01);
    }
  });

  it('cube with a hole and a 20° chamfer: sharp edges, smooth facets and a shallow edge that is smoothed over', () => {
    const solid = chamfered();
    const { mesh, ours, max } = expectLikeManifold('chamfered cube', solid);
    solid.delete();
    expect(max).toBeLessThan(0.01);
    // The fixture really has a 20° edge, and like Manifold we smooth across it:
    // both corners at either end of the edge share the bisecting normal.
    const topo = normalsTopology(mesh.index, mesh.positions.length / 3);
    const fn = faceNormals(mesh.positions, mesh.index);
    let shallow = 0;
    for (let c = 0; c < mesh.index.length; c++) {
      const tw = topo.twin[c];
      if (tw < c) continue;
      const dihedral = angleBetween(fn, tri(c), fn, tri(tw));
      if (Math.abs(dihedral - 20) < 0.01) {
        shallow++;
        expect(angleBetween(ours, c, ours, next(tw))).toBeLessThan(0.01);
        // a blend of the two faces (and whatever else is in the group), not either face normal
        expect(angleBetween(ours, c, fn, tri(c))).toBeGreaterThan(1);
        expect(angleBetween(ours, c, fn, tri(c))).toBeLessThan(19);
      }
    }
    expect(shallow).toBeGreaterThanOrEqual(1);
  });

  it('union of a cube and a sphere: mixed', () => {
    const solid = cubeSphere();
    const { mesh, ref, max } = expectLikeManifold('cube ∪ sphere', solid);
    solid.delete();
    expect(max).toBeLessThan(0.01);
    expect(ref.shadedVertices).toBeGreaterThan(mesh.positions.length / 3); // some sharp edges
    expect(ref.shadedVertices).toBeLessThan(mesh.index.length); // some smooth ones
  });

  it('bumpy sphere: mixed, with sharp creases where the bumps are steep', () => {
    const solid = bumpy();
    const { mesh, ref, max } = expectLikeManifold('bumpy sphere', solid);
    solid.delete();
    expect(max).toBeLessThan(0.01);
    const V = mesh.positions.length / 3;
    expect(ref.shadedVertices).toBeGreaterThan(V * 1.1);
    expect(ref.shadedVertices).toBeLessThan(mesh.index.length * 0.9);
  });

  it('edges exactly at the crease angle are a coin toss on both sides (logged)', () => {
    // A 10-sided prism has dihedral angles of exactly 36° between its sides. Manifold
    // decides each one from its double-precision positions, we from float32 ones, so a
    // few edges can land on different sides of the threshold; a flipped edge moves the
    // normals of its corners by half the dihedral angle, 18°, never more.
    const solid = wasm.Manifold.cylinder(10, 5, 5, 10);
    const mesh = meshOf(solid);
    const ref = manifoldNormals(solid, mesh);
    solid.delete();
    const ours = cornerNormals(mesh.positions, mesh.index, 36);
    const { max, within } = compare(ours, ref.normals);
    console.log(`36° prism (threshold case): max deviation ${max.toFixed(4)}°, ${(within * 100).toFixed(1)}% of corners within 1°`);
    expect(max).toBeLessThanOrEqual(18.01);
  });
});

describe('cornerNormals on its own', () => {
  it('is deterministic and gives identical output with a reused topology', () => {
    const solid = bumpy();
    const { positions, index } = meshOf(solid);
    solid.delete();
    const V = positions.length / 3;
    const a = cornerNormals(positions, index, 36);
    const b = cornerNormals(positions, index, 36);
    const topology = normalsTopology(index, V);
    const c = cornerNormals(positions, index, 36, topology);
    expect(a.length).toBe(index.length * 3);
    expect(b.every((x, i) => x === a[i])).toBe(true);
    expect(c.every((x, i) => x === a[i])).toBe(true);
    // the same topology serves a deformed copy of the mesh
    const squashed = positions.map((x, i) => (i % 3 === 2 ? x * 0.4 : x));
    const d = cornerNormals(squashed, index, 36, topology);
    const e = cornerNormals(squashed, index, 36);
    expect(d.every((x, i) => x === e[i])).toBe(true);
    expect(d.every((x, i) => x === a[i])).toBe(false);
    // but not a different mesh
    const other = strip(3);
    expect(() => cornerNormals(other.positions, other.index, 36, topology)).toThrow(/topology/);
  });

  it('creaseDeg 0 facets everything, 180 smooths everything', () => {
    const solid = cube();
    const { positions, index } = meshOf(solid);
    solid.delete();
    const faceted = cornerNormals(positions, index, 0);
    const fn = faceNormals(positions, index);
    for (let c = 0; c < index.length; c++) expect(angleBetween(faceted, c, fn, tri(c))).toBeLessThan(0.01);
    const smooth = cornerNormals(positions, index, 180);
    for (const corners of cornersByVertex(normalsTopology(index, positions.length / 3))) expect(spreadAtVertex(smooth, corners)).toBeLessThan(0.01);
    // a cube corner's smooth normal is the diagonal
    expect(angleBetween(smooth, 0, [Math.sign(positions[index[0] * 3] - 5), Math.sign(positions[index[0] * 3 + 1] - 5), Math.sign(positions[index[0] * 3 + 2] - 5)], 0)).toBeLessThan(0.01);
  });

  it('open edges: a planar strip is flat and a cylinder without caps shades like the full one', () => {
    const { positions, index } = strip(5);
    const topology = normalsTopology(index, positions.length / 3);
    let open = 0;
    for (let c = 0; c < index.length; c++) {
      const tw = topology.twin[c];
      if (tw < 0) open++;
      else expect(topology.twin[tw]).toBe(c);
    }
    expect(open).toBe(2 * 5 + 2);
    const n = cornerNormals(positions, index, 36, topology);
    for (let c = 0; c < index.length; c++) {
      expect(n[3 * c]).toBeCloseTo(0, 6);
      expect(n[3 * c + 1]).toBeCloseTo(0, 6);
      expect(n[3 * c + 2]).toBeCloseTo(1, 6);
    }

    const solid = cylinder();
    const full = meshOf(solid);
    solid.delete();
    const fn = faceNormals(full.positions, full.index);
    const sideTris = [];
    for (let t = 0; t < full.index.length / 3; t++) if (Math.abs(fn[3 * t + 2]) < 0.5) sideTris.push(t);
    const sides = new Uint32Array(sideTris.length * 3);
    sideTris.forEach((t, i) => sides.set(full.index.subarray(3 * t, 3 * t + 3), 3 * i));
    const closed = cornerNormals(full.positions, full.index, 36);
    const opened = cornerNormals(full.positions, sides, 36); // cap-centre vertices are now unused
    sideTris.forEach((t, i) => {
      for (let k = 0; k < 3; k++) expect(angleBetween(opened, 3 * i + k, closed, 3 * t + k)).toBeLessThan(0.001);
    });
  });

  it('degenerate triangles change nothing around them and get a finite normal', () => {
    const solid = wasm.Manifold.sphere(10, 16);
    const { positions, index } = meshOf(solid);
    solid.delete();
    const before = cornerNormals(positions, index, 36);
    const a = index[0], b = index[1];
    const V = positions.length / 3;
    // a triangle repeating a vertex id, and a needle of three coincident points
    const grown = new Float32Array((V + 2) * 3);
    grown.set(positions);
    grown.set(positions.subarray(3 * a, 3 * a + 3), 3 * V);
    grown.set(positions.subarray(3 * a, 3 * a + 3), 3 * V + 3);
    const more = new Uint32Array([...index, a, a, b, a, V, V + 1]);
    const after = cornerNormals(grown, more, 36);
    for (let c = 0; c < index.length; c++) expect(angleBetween(after, c, before, c)).toBeLessThan(1e-6);
    for (let c = index.length; c < more.length; c++) expect(Math.hypot(after[3 * c], after[3 * c + 1], after[3 * c + 2])).toBeCloseTo(1, 5);
  });

  it('a non-manifold edge is sharp', () => {
    const solid = cylinder();
    const { positions, index } = meshOf(solid);
    solid.delete();
    const V = positions.length / 3;
    const topology = normalsTopology(index, V);
    const fn = faceNormals(positions, index);
    // a vertical edge between two side quads
    let c = -1;
    for (let h = 0; h < index.length && c < 0; h++) {
      const tw = topology.twin[h];
      if (tw < 0 || Math.abs(fn[3 * tri(h) + 2]) > 0.5 || Math.abs(fn[3 * tri(tw) + 2]) > 0.5) continue;
      if (Math.abs(positions[3 * index[h] + 2] - positions[3 * index[next(h)] + 2]) > 9) c = h;
    }
    expect(c).toBeGreaterThanOrEqual(0);
    const tw = topology.twin[c];
    const a = index[c];
    const before = cornerNormals(positions, index, 36, topology);
    expect(angleBetween(before, c, before, next(tw))).toBeLessThan(0.01); // smooth side
    // glue a fin onto that edge: three faces now meet there
    const grown = new Float32Array((V + 1) * 3);
    grown.set(positions);
    grown.set([positions[3 * a] * 2, positions[3 * a + 1] * 2, positions[3 * a + 2]], 3 * V);
    const more = new Uint32Array([...index, index[next(c)], a, V]);
    const grownTopology = normalsTopology(more, V + 1);
    expect(grownTopology.twin[c]).toBe(-1);
    expect(grownTopology.twin[tw]).toBe(-1);
    expect(grownTopology.twin[index.length]).toBe(-1);
    const after = cornerNormals(grown, more, 36, grownTopology);
    expect(angleBetween(after, c, after, next(tw))).toBeGreaterThan(1); // the side split at the fin
    // far from the fin nothing changed
    let changed = 0;
    for (let k = 0; k < index.length; k++) if (angleBetween(after, k, before, k) > 0.01) changed++;
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThan(40);
  });

  it('shades 245k triangles quickly (timing logged, not asserted)', () => {
    const solid = wasm.Manifold.sphere(40, 700);
    const { positions, index } = meshOf(solid);
    solid.delete();
    const V = positions.length / 3;
    let t0 = performance.now();
    const topology = normalsTopology(index, V);
    const topologyMs = performance.now() - t0;
    let best = Infinity;
    let out;
    for (let i = 0; i < 3; i++) {
      t0 = performance.now();
      out = cornerNormals(positions, index, 36, topology);
      best = Math.min(best, performance.now() - t0);
    }
    console.log(`sphere(40, 700): ${index.length / 3} triangles – topology ${topologyMs.toFixed(0)} ms, cornerNormals with prebuilt topology ${best.toFixed(0)} ms (best of 3; target ≤ 200 ms)`);
    expect(out.length).toBe(index.length * 3);
  });
});
