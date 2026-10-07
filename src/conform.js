import { BufferGeometry, DoubleSide, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/**
 * Make flat text follow a curved surface.
 *
 * Text is built as a flat extrusion in a local frame (X/Y in the text plane,
 * +Z = outward surface normal, origin = the clicked point). On a curved model a
 * flat slab cuts too deep in the middle or floats at the ends, so we sample the
 * model surface height h(x, y) above the text plane on a grid and shift every
 * vertex of the (refined) slab along local Z by that height.
 */

/** Grid nodes per axis above which the sample spacing is enlarged. */
const MAX_GRID = 400;

/** BVHs per model geometry, so repeated samplers / thickness probes reuse one. */
const bvhCache = new WeakMap();

/**
 * MeshBVH over `geometry`, built on a shallow copy so the model is never
 * touched (MeshBVH reorders, or adds, the index of the geometry it is built on).
 */
function bvhFor(geometry) {
  const position = geometry?.attributes?.position;
  if (!position || position.count < 3) return null;
  let bvh = bvhCache.get(geometry);
  if (!bvh) {
    const copy = new BufferGeometry();
    copy.setAttribute('position', position);
    if (geometry.index) copy.setIndex(geometry.index.clone());
    bvh = new MeshBVH(copy);
    bvhCache.set(geometry, bvh);
  }
  return bvh;
}

/** Farthest the geometry reaches from `origin`, for "unlimited" searches. */
function reachFrom(bvh, origin) {
  const geometry = bvh.geometry;
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox;
  let reach = 0;
  for (let k = 0; k < 8; k++) {
    const corner = new Vector3(k & 1 ? max.x : min.x, k & 2 ? max.y : min.y, k & 4 ? max.z : min.z);
    reach = Math.max(reach, corner.distanceTo(origin));
  }
  return reach + 1;
}

const toVector = (v) => (v?.isVector3 ? v.clone() : new Vector3(...v));

/**
 * Build a sampler of the model surface in the text's local frame.
 * @param {BufferGeometry} geometry  the model (indexed or not); it is not modified
 * @param {import('three').Matrix4} placement  text-local -> model space (see placementMatrix())
 * @param {{ searchAbove?: number, searchBelow?: number }} [options]
 *   how far (model units) above / below the text plane a surface may be to
 *   count; default 50 each, Infinity for unlimited.
 * @returns {{ heightAt(x: number, y: number): number, dispose(): void }}
 *   heightAt gives the local-Z height of the model surface at (x, y): the hit
 *   of a ray cast along -normal that is closest to the text plane (the clicked
 *   surface, z = 0), or NaN when nothing is hit within the search range.
 */
export function createSurfaceSampler(geometry, placement, options = {}) {
  let bvh = bvhFor(geometry);
  const inverse = placement.clone().invert();
  const normal = new Vector3().setFromMatrixColumn(placement, 2).normalize();
  const ray = new Ray(new Vector3(), normal.clone().negate());
  const local = new Vector3();

  let above = options.searchAbove ?? 50;
  let below = options.searchBelow ?? 50;
  if (bvh && !(Number.isFinite(above) && Number.isFinite(below))) {
    const reach = reachFrom(bvh, new Vector3().setFromMatrixPosition(placement));
    above = Math.min(above, reach);
    below = Math.min(below, reach);
  }

  return {
    heightAt(x, y) {
      if (!bvh) return NaN;
      ray.origin.set(x, y, above).applyMatrix4(placement);
      const hits = bvh.raycast(ray, DoubleSide, 0, above + below);
      let best = NaN;
      let bestAbs = Infinity;
      for (const hit of hits) {
        const z = local.copy(hit.point).applyMatrix4(inverse).z;
        if (Math.abs(z) < bestAbs) {
          bestAbs = Math.abs(z);
          best = z;
        }
      }
      return best;
    },
    dispose() {
      if (bvh && bvhCache.get(geometry) === bvh) bvhCache.delete(geometry);
      bvh = null;
    },
  };
}

/**
 * Thickness of the model wall under a surface point: the distance from the
 * surface at `position` along -normal to the next surface crossing.
 * @param {BufferGeometry} geometry
 * @param {number[]|Vector3} position  point on the surface (model space)
 * @param {number[]|Vector3} normal    outward surface normal there
 * @param {number} [maxDistance]       give up (-> Infinity) beyond this
 * @returns {number} wall thickness, or Infinity when nothing is behind the surface
 */
export function wallThicknessAt(geometry, position, normal, maxDistance = 1000) {
  const bvh = bvhFor(geometry);
  if (!bvh) return Infinity;
  const eps = 1e-3;
  const dir = toVector(normal).normalize();
  const ray = new Ray(toVector(position).addScaledVector(dir, eps), dir.negate());
  let thickness = Infinity;
  for (const hit of bvh.raycast(ray, DoubleSide, 0, maxDistance + eps)) {
    // skip the surface the point lies on (hit at ~eps, possibly several times)
    if (hit.distance > 2 * eps) thickness = Math.min(thickness, hit.distance - eps);
  }
  return thickness;
}

/** Fill NaN cells with the value of the nearest valid cell (multi-source BFS). */
function fillMisses(h, nx, ny) {
  const queue = [];
  for (let k = 0; k < h.length; k++) if (!Number.isNaN(h[k])) queue.push(k);
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q];
    const i = k % nx;
    const j = (k - i) / nx;
    const spread = (n) => {
      if (Number.isNaN(h[n])) {
        h[n] = h[k];
        queue.push(n);
      }
    };
    if (i > 0) spread(k - 1);
    if (i < nx - 1) spread(k + 1);
    if (j > 0) spread(k - nx);
    if (j < ny - 1) spread(k + nx);
  }
}

/**
 * Deform a flat text solid so it follows the sampled surface.
 * @param {import('manifold-3d').Manifold} flatSolid  flat extrusion in text-local space (caller keeps ownership)
 * @param {{ heightAt(x: number, y: number): number }} sampler  from createSurfaceSampler()
 * @param {object} [options]
 * @param {number} [options.cell]           sample spacing, model units (default max(0.4, min(w, h) / 12))
 * @param {number} [options.maxEdge]        refineToLength() edge length (default: cell)
 * @param {number} [options.flatTolerance]  height range treated as flat (default 0.02); flat text is only translated
 * @param {number} [options.margin]         grid margin around the footprint (default: one cell)
 * @returns {{ solid: import('manifold-3d').Manifold, conformed: boolean, stats: object }}
 *   `solid` is always a new Manifold the caller owns. `stats`: samples, misses,
 *   minHeight, maxHeight, triangles, cell and grid [nx, ny].
 */
export function conformSolid(flatSolid, sampler, options = {}) {
  const { min, max } = flatSolid.boundingBox();
  const width = max[0] - min[0];
  const height = max[1] - min[1];
  const flatTolerance = options.flatTolerance ?? 0.02;
  const result = (solid, conformed, stats) => ({
    solid,
    conformed,
    stats: { samples: 0, misses: 0, minHeight: NaN, maxHeight: NaN, cell: NaN, grid: [0, 0], ...stats, triangles: solid.numTri() },
  });
  if (!(width > 0 && height > 0)) return result(flatSolid.translate(0, 0, 0), false, {});

  let cell = options.cell ?? Math.max(0.4, Math.min(width, height) / 12);
  const margin = options.margin ?? cell;
  const spanX = width + 2 * margin;
  const spanY = height + 2 * margin;
  cell = Math.max(cell, spanX / (MAX_GRID - 1), spanY / (MAX_GRID - 1));
  const nx = Math.ceil(spanX / cell) + 1;
  const ny = Math.ceil(spanY / cell) + 1;
  const x0 = min[0] - margin;
  const y0 = min[1] - margin;

  const h = new Float64Array(nx * ny);
  let misses = 0;
  let sum = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const z = sampler.heightAt(x0 + i * cell, y0 + j * cell);
      h[j * nx + i] = z;
      if (Number.isFinite(z)) {
        sum += z;
        if (z < lo) lo = z;
        if (z > hi) hi = z;
      } else {
        h[j * nx + i] = NaN;
        misses++;
      }
    }
  }
  const stats = { samples: h.length, misses, minHeight: lo, maxHeight: hi, cell, grid: [nx, ny] };
  if (misses === h.length) return result(flatSolid.translate(0, 0, 0), false, { ...stats, minHeight: NaN, maxHeight: NaN });
  if (hi - lo <= flatTolerance) {
    return result(flatSolid.translate(0, 0, sum / (h.length - misses)), false, stats);
  }
  if (misses) fillMisses(h, nx, ny);

  // bilinear interpolation of the grid, clamped to its edges
  const heightAt = (x, y) => {
    const u = Math.min(Math.max((x - x0) / cell, 0), nx - 1);
    const v = Math.min(Math.max((y - y0) / cell, 0), ny - 1);
    const i = Math.min(Math.floor(u), nx - 2);
    const j = Math.min(Math.floor(v), ny - 2);
    const fx = u - i;
    const fy = v - j;
    const k = j * nx + i;
    const bottom = h[k] * (1 - fx) + h[k + 1] * fx;
    const top = h[k + nx] * (1 - fx) + h[k + nx + 1] * fx;
    return bottom * (1 - fy) + top * fy;
  };

  const refined = flatSolid.refineToLength(options.maxEdge ?? cell);
  const solid = refined.warpBatch((verts, count) => {
    for (let i = 0; i < count; i++) verts[i * 3 + 2] += heightAt(verts[i * 3], verts[i * 3 + 1]);
  });
  refined.delete();
  return result(solid, true, stats);
}
