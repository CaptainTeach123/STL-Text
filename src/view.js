import { BufferGeometry, Float32BufferAttribute } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { cornerNormals, normalsTopology } from './normals.js';

const CREASE_DEGREES = 36;
const EMPTY = new Float32Array(0);

/**
 * Which triangles of a (BVH-reordered) corner index belong to the soup that
 * was appended after the solid's corners: [start, count] triangle ranges.
 */
export function passthroughRangesOf(index, solidCorners) {
  const ranges = [];
  let start = -1;
  const triangles = index.length / 3;
  for (let t = 0; t < triangles; t++) {
    const pass = index[t * 3] >= solidCorners;
    if (pass && start < 0) start = t;
    if (!pass && start >= 0) {
      ranges.push([start, t - start]);
      start = -1;
    }
  }
  if (start >= 0) ranges.push([start, triangles - start]);
  return ranges;
}

/**
 * Display views of meshes for the main thread and for surface sampling.
 *
 * A view has one vertex per triangle corner, lit with creased normals (smooth
 * within 36°, like Manifold's own shading), so smooth groups never have to
 * split or merge shared vertices, and a BVH for picking and sampling. Views
 * are cached per topology – the mesh's index array object – so that moving
 * the vertices (an enhancement, a clean-up spot, a different transform) only
 * recomputes positions and normals and *refits* the existing BVH instead of
 * building a new one, which is 10–20× cheaper on large models.
 */
export class ViewCache {
  #byIndex = new WeakMap(); // index -> { geometry, bvh, topology, corners }

  /**
   * @param {{ positions: Float32Array, index: Uint32Array }} mesh  the solid part of the view
   * @param {object} [options]
   * @param {Float32Array|null} [options.normals]  per-corner normals of `mesh`, computed when absent
   * @param {Float32Array} [options.passthrough]   triangle soup shown alongside the solid (flat shaded)
   * @returns {{ display: object, transfer: ArrayBuffer[], geometry: BufferGeometry|null, normals: Float32Array, bounds: object|null }}
   *   `display` is what the main thread renders (positions, normals, index, passthroughStart, passthroughRanges,
   *   bvhRoots, bvhVersion); `geometry` is the worker's own copy with its boundsTree, for sampling (null when empty);
   *   `normals` are the solid's per-corner normals, for the caller to cache.
   */
  build(mesh, { normals = null, passthrough = EMPTY } = {}) {
    const { positions: p, index } = mesh;
    const solidCorners = index.length;
    const soupTriangles = Math.floor(passthrough.length / 9);
    const corners = solidCorners + soupTriangles * 3;
    const positions = new Float32Array(corners * 3);
    for (let c = 0; c < solidCorners; c++) {
      const v = index[c] * 3;
      positions[c * 3] = p[v];
      positions[c * 3 + 1] = p[v + 1];
      positions[c * 3 + 2] = p[v + 2];
    }
    positions.set(passthrough, solidCorners * 3);

    let entry = this.#byIndex.get(index);
    if (entry && entry.corners !== corners) entry = null; // the soup changed size: not the same view
    const solidNormals = normals ?? (solidCorners ? cornerNormals(p, index, CREASE_DEGREES, (entry ??= {}).topology ??= normalsTopology(index, p.length / 3)) : EMPTY);
    const outNormals = new Float32Array(corners * 3);
    outNormals.set(solidNormals);
    for (let t = 0; t < soupTriangles; t++) {
      const i = t * 9;
      const ax = passthrough[i], ay = passthrough[i + 1], az = passthrough[i + 2];
      const ux = passthrough[i + 3] - ax, uy = passthrough[i + 4] - ay, uz = passthrough[i + 5] - az;
      const vx = passthrough[i + 6] - ax, vy = passthrough[i + 7] - ay, vz = passthrough[i + 8] - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const o = (solidCorners + t * 3) * 3;
      for (let k = 0; k < 3; k++) {
        outNormals[o + k * 3] = nx;
        outNormals[o + k * 3 + 1] = ny;
        outNormals[o + k * 3 + 2] = nz;
      }
    }

    if (!corners) {
      return {
        display: { positions, normals: outNormals, index: new Uint32Array(0), passthroughStart: 0, passthroughRanges: [], bvhRoots: [], bvhVersion: null },
        transfer: [positions.buffer, outNormals.buffer],
        geometry: null,
        normals: solidNormals,
        bounds: null,
      };
    }

    if (!entry?.geometry) {
      // first time for this topology: the BVH reorders the (trivial) corner index in place
      entry = entry ?? {};
      entry.corners = corners;
      entry.geometry = new BufferGeometry();
      entry.geometry.setAttribute('position', new Float32BufferAttribute(positions.slice(), 3));
      entry.bvh = new MeshBVH(entry.geometry, { indirect: false });
      entry.geometry.boundsTree = entry.bvh;
      this.#byIndex.set(index, entry);
    } else {
      entry.geometry.attributes.position.array.set(positions);
      entry.geometry.attributes.position.needsUpdate = true;
      entry.bvh.refit();
    }
    entry.geometry.computeBoundingBox();
    const bb = entry.geometry.boundingBox;
    const serialized = MeshBVH.serialize(entry.bvh, { cloneBuffers: true });
    const order = serialized.index; // the reordered corner index, a fresh copy for the main thread
    return {
      display: {
        positions,
        normals: outNormals,
        index: order,
        passthroughStart: solidCorners / 3,
        passthroughRanges: passthroughRangesOf(order, solidCorners),
        bvhRoots: serialized.roots,
        bvhVersion: serialized.version,
      },
      transfer: [positions.buffer, outNormals.buffer, order.buffer, ...serialized.roots],
      geometry: entry.geometry,
      normals: solidNormals,
      bounds: { min: bb.min.toArray(), max: bb.max.toArray() },
    };
  }
}
