import { BufferGeometry, DoubleSide, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { manifoldToGeometry } from './mesh.js';

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
  if (geometry.boundsTree) return geometry.boundsTree; // built by the engine for picking
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

  const sample = (x, y) => {
    if (!bvh) return { z: NaN, wall: Infinity };
    ray.origin.set(x, y, above).applyMatrix4(placement);
    const hits = bvh.raycast(ray, DoubleSide, 0, above + below);
    let best = NaN;
    let bestAbs = Infinity;
    const zs = [];
    for (const hit of hits) {
      const z = local.copy(hit.point).applyMatrix4(inverse).z;
      zs.push(z);
      if (Math.abs(z) < bestAbs) {
        bestAbs = Math.abs(z);
        best = z;
      }
    }
    // the next surface crossing behind the chosen one = the wall thickness there
    let wall = Infinity;
    for (const z of zs) if (z < best - 1e-6) wall = Math.min(wall, best - z);
    return { z: best, wall };
  };

  return {
    /** Local-Z height of the surface at (x, y) and the wall thickness behind it. */
    sample,
    heightAt(x, y) {
      return sample(x, y).z;
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
  const maxSlopeDeg = options.maxSlopeDeg ?? 60;
  const reach = options.reach ?? 5;
  const wallLimit = options.wallLimit ?? Infinity;
  const emptyStats = {
    samples: 0, misses: 0, missFraction: 0, touches: false, minHeight: NaN, maxHeight: NaN, meanHeight: NaN,
    minWall: Infinity, thinCells: 0, maxSlopeDeg: 0, steep: false, crossesEdge: false, rMin: Infinity,
    cell: NaN, maxEdge: NaN, grid: [0, 0],
  };
  const result = (solid, conformed, stats) => ({
    solid,
    conformed,
    stats: { ...emptyStats, ...stats, conformed, triangles: solid.numTri() },
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
  const valid = new Uint8Array(nx * ny);
  let misses = 0;
  let sum = 0;
  let lo = Infinity;
  let hi = -Infinity;
  let minWall = Infinity;
  let thinCells = 0;
  let touches = false;
  const probe = sampler.sample ?? ((x, y) => ({ z: sampler.heightAt(x, y), wall: Infinity }));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const { z, wall } = probe(x0 + i * cell, y0 + j * cell);
      const k = j * nx + i;
      if (Number.isFinite(z)) {
        h[k] = z;
        valid[k] = 1;
        sum += z;
        if (z < lo) lo = z;
        if (z > hi) hi = z;
        if (Math.abs(z) <= reach) touches = true;
        if (wall < minWall) minWall = wall;
        if (wall < wallLimit) thinCells++;
      } else {
        h[k] = NaN;
        misses++;
      }
    }
  }
  const stats = {
    samples: h.length, misses, missFraction: misses / h.length, touches,
    minHeight: lo, maxHeight: hi, meanHeight: misses === h.length ? NaN : sum / (h.length - misses),
    minWall, thinCells, cell, grid: [nx, ny],
  };
  if (misses === h.length) return result(flatSolid.translate(0, 0, 0), false, { ...stats, minHeight: NaN, maxHeight: NaN });

  // slope, steps and curvature from the cells that really hit the surface.
  // A step is a sudden slope change next to a gentle surface (a ledge, a
  // groove); a smooth surface that merely turns away from the text normal
  // (the side of a cylinder) is "steep", not a step.
  const tanMax = Math.tan((maxSlopeDeg * Math.PI) / 180);
  const tanGentle = Math.tan(Math.PI / 6);
  let maxSlope = 0;
  let crossesEdge = false;
  let rMin = Infinity;
  const at = (i, j) => h[j * nx + i];
  const ok = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && valid[j * nx + i];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!ok(i, j)) continue;
      let slopeX = 0;
      let slopeY = 0;
      let step = false;
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        if (!ok(i - di, j - dj) || !ok(i + di, j + dj)) continue;
        const left = (at(i, j) - at(i - di, j - dj)) / cell;
        const right = (at(i + di, j + dj) - at(i, j)) / cell;
        const change = Math.abs(right - left); // second difference per cell
        if (change > tanMax && Math.min(Math.abs(left), Math.abs(right)) < tanGentle) {
          step = true;
          continue;
        }
        const g = (left + right) / 2;
        if (di) slopeX = g;
        else slopeY = g;
        // curvature over a two-cell stencil, so the facets of a coarse model don't register as tight bends
        const wide = ok(i - 2 * di, j - 2 * dj) && ok(i + 2 * di, j + 2 * dj)
          ? (at(i + 2 * di, j + 2 * dj) - 2 * at(i, j) + at(i - 2 * di, j - 2 * dj)) / (4 * cell * cell)
          : change / cell;
        const hpp = Math.abs(wide);
        if (hpp > 1e-6) rMin = Math.min(rMin, (1 + g * g) ** 1.5 / hpp);
      }
      if (step) {
        crossesEdge = true;
        continue; // the wall of a step is not "the surface is too curved"
      }
      maxSlope = Math.max(maxSlope, Math.hypot(slopeX, slopeY));
    }
  }
  stats.maxSlopeDeg = (Math.atan(maxSlope) * 180) / Math.PI;
  stats.steep = stats.maxSlopeDeg > maxSlopeDeg;
  stats.crossesEdge = crossesEdge;
  stats.rMin = rMin;

  if (hi - lo <= flatTolerance) {
    return result(flatSolid.translate(0, 0, stats.meanHeight), false, stats);
  }
  if (misses) fillMisses(h, nx, ny);

  // refine just finely enough that the warped facets stay within the chord error
  const chordError = options.chordError ?? 0.02;
  let maxEdge = options.maxEdge;
  if (!(maxEdge > 0)) {
    maxEdge = Number.isFinite(rMin) ? Math.sqrt(8 * rMin * chordError) : 2;
    maxEdge = Math.min(Math.max(maxEdge, 0.25), 2, Math.min(width, height) / 3);
  }
  stats.maxEdge = maxEdge;

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

  const refined = flatSolid.refineToLength(maxEdge);
  const solid = refined.warpBatch((verts, count) => {
    for (let i = 0; i < count; i++) verts[i * 3 + 2] += heightAt(verts[i * 3], verts[i * 3 + 1]);
  });
  refined.delete();
  return result(solid, true, stats);
}

/**
 * Plain-language notes about a conformed placement, for the UI.
 * Each note is { level: 'warn' | 'info', code, text, ...extras }.
 */
export function conformNotes(stats, { mode = 'emboss', depth = 1, overlap = 0.4, nozzle = 0.4 } = {}) {
  const notes = [];
  if (!stats) return notes;
  if (!stats.touches) {
    notes.push({ level: 'warn', code: 'NOT_TOUCHING', text: "This text isn't touching the model. Click the model to place it on the surface." });
  }
  if (stats.missFraction > 0.02) {
    notes.push({ level: 'warn', code: 'OVERHANG', text: 'Part of the text hangs over the edge of the surface.' });
  }
  if (stats.steep) {
    notes.push({
      level: 'warn',
      code: 'TOO_CURVED',
      text: 'The text is wider than this curve can hold; letters near the ends stretch. Try shorter text, smaller letters or two lines.',
    });
  }
  if (stats.crossesEdge) {
    notes.push({ level: 'warn', code: 'CROSSES_EDGE', text: 'The text crosses an edge or step in the model here.' });
  }
  if (mode === 'engrave' && Number.isFinite(stats.minWall) && stats.minWall < depth + nozzle) {
    notes.push({
      level: 'warn',
      code: 'CUT_THROUGH',
      text: `${depth} mm deep would cut through — the wall here is ${stats.minWall.toFixed(1)} mm.`,
      suggestedDepth: Math.max(0.1, Math.floor((stats.minWall - nozzle) * 10) / 10),
    });
  }
  if (stats.conformed && stats.maxSlopeDeg > 10) {
    notes.push({ level: 'info', code: 'FOLLOWS_CURVE', text: 'Text follows the curve here.' });
  }
  void overlap;
  return notes;
}

/**
 * Sampler of a rigid part's underside in its own (seated) frame: the lowest
 * z of the part at (x, y), or NaN where the part does not reach.
 * @param {import('manifold-3d').Manifold} partSolid  the part as placed, before any lowering
 */
export function createUndersideSampler(partSolid) {
  const geometry = manifoldToGeometry(partSolid);
  const bvh = new MeshBVH(geometry);
  const { min, max } = partSolid.boundingBox();
  const ray = new Ray(new Vector3(), new Vector3(0, 0, 1));
  return {
    bounds: { min, max },
    heightAt(x, y) {
      ray.origin.set(x, y, min[2] - 1);
      const hit = bvh.raycastFirst(ray, DoubleSide);
      return hit ? hit.point.z : NaN;
    },
  };
}

/**
 * How far a rigid part has to come down (local -Z) so that its body – not
 * just its nearest point – meets the model: the gap between the part's
 * underside and the surface is measured on a grid over the part, and the
 * part is lowered by the gap that 30 % of its covered area has closed. A
 * flat part on a flat surface stays where it is (gap 0 everywhere); a flat
 * part across a cylinder sinks a little past the tangent line; a scroll
 * attached by its hollow side comes down until its back rests on the model
 * while its tips pass into it. The depth is capped by the part's own height:
 * a part hovering farther away than that is not touching the model at all.
 * @param {{ bounds, heightAt }} underside  from createUndersideSampler()
 * @param {{ heightAt(x: number, y: number): number }} surface  from createSurfaceSampler()
 * @returns {{ depth: number, reachable: boolean, firstContact: number, cells: number, covered: number }}
 *   `depth` ≥ 0 (0 when the part already meets or penetrates the surface),
 *   `reachable` false when the body cannot reach the surface within the
 *   part's height (`depth` then holds the capped value), `firstContact` the
 *   smallest gap (negative when the surface already pokes into the part).
 */
export function fitDepth(underside, surface, { fraction = 0.3 } = {}) {
  const { min, max } = underside.bounds;
  const width = max[0] - min[0];
  const height = max[1] - min[1];
  const tall = max[2] - min[2];
  const empty = { depth: 0, reachable: false, firstContact: NaN, cells: 0, covered: 0 };
  if (!(width > 0 && height > 0 && tall > 0)) return empty;
  let cell = Math.max(0.4, Math.min(width, height) / 24);
  cell = Math.max(cell, width / (MAX_GRID - 1), height / (MAX_GRID - 1));
  const gaps = [];
  let covered = 0;
  for (let y = min[1] + cell / 2; y < max[1]; y += cell) {
    for (let x = min[0] + cell / 2; x < max[0]; x += cell) {
      const u = underside.heightAt(x, y);
      if (!Number.isFinite(u)) continue;
      covered++;
      const h = surface.heightAt(x, y);
      if (Number.isFinite(h)) gaps.push(u - h);
    }
  }
  if (!gaps.length) return { ...empty, covered };
  gaps.sort((a, b) => a - b);
  const gap = gaps[Math.min(gaps.length - 1, Math.floor(fraction * gaps.length))];
  const depth = Math.max(0, gap);
  return { depth: Math.min(depth, tall), reachable: depth <= tall, firstContact: gaps[0], cells: gaps.length, covered };
}
