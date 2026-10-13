import { BufferGeometry, DoubleSide, Ray, Triangle, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { manifoldToGeometry } from './mesh.js';

/**
 * Make flat text follow a curved surface.
 *
 * Text is built as a flat extrusion in a local frame (X/Y in the text plane,
 * +Z = outward surface normal, origin = the clicked point). On a curved model a
 * flat slab cuts too deep in the middle or floats at the ends, so the slab is
 * laid onto the surface like a sticker: a grid is walked over the surface from
 * the clicked point – along the reading direction, then up and down from each
 * node – in steps of a fixed length along the surface, and every vertex of the
 * (refined) slab goes to the surface point its flat (x, y) reaches and out
 * along the surface normal there by its height. The letters keep their size
 * and spacing measured along the surface, wrap round a mug, a cane or the
 * inside of a ring as far as the text is long, and stand square on the
 * surface at the same height or depth everywhere.
 *
 * Rigid parts (and samplers that cannot walk) use a projection instead: the
 * surface height h(x, y) under the text plane, sampled along the text's
 * normal and followed outward from the clicked point.
 */

/** Grid nodes per axis above which the sample spacing is enlarged. */
const MAX_GRID = 400;

/**
 * Squared distance from the point (px, py, pz) to the triangle whose corners start at a, b and c in `pos` (the
 * nearest point by its region: a corner, an edge or the inside; Ericson, Real-Time Collision Detection, 5.1.5).
 */
function pointTriangleDistance2(px, py, pz, pos, a, b, c) {
  const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
  const abx = pos[b] - ax, aby = pos[b + 1] - ay, abz = pos[b + 2] - az;
  const acx = pos[c] - ax, acy = pos[c + 1] - ay, acz = pos[c + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) {
    qx = ax; qy = ay; qz = az;
  } else {
    const bpx = px - pos[b], bpy = py - pos[b + 1], bpz = pz - pos[b + 2];
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - pos[c], cpy = py - pos[c + 1], cpz = pz - pos[c + 2];
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2;
    const vb = d5 * d2 - d1 * d6;
    const va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) {
      qx = pos[b]; qy = pos[b + 1]; qz = pos[b + 2];
    } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz;
    } else if (d6 >= 0 && d5 <= d6) {
      qx = pos[c]; qy = pos[c + 1]; qz = pos[c + 2];
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz;
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      qx = pos[b] + w * (pos[c] - pos[b]); qy = pos[b + 1] + w * (pos[c + 1] - pos[b + 1]); qz = pos[b + 2] + w * (pos[c + 2] - pos[b + 2]);
    } else {
      const denom = 1 / (va + vb + vc);
      const v = vb * denom;
      const w = vc * denom;
      qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
    }
  }
  return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
}

/** Triangles facing within this of the walk's own normal count towards the surface's mean facing around a point ... */
const WIDE_AROUND = Math.cos((75 * Math.PI) / 180);
/** ... and then those within this of that mean. */
const AGREE_AROUND = Math.cos((37 * Math.PI) / 180);

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
 * Of a column's hits, the front-facing one (the outside of the model as seen from the item) nearest `target`, or
 * the nearest of any kind when none faces the item (the column starts inside a solid); NaN when there is none.
 */
function nearestHit(hits, target) {
  let best = NaN;
  let bestD = Infinity;
  let any = NaN;
  let anyD = Infinity;
  for (const { z, front } of hits) {
    const d = Math.abs(z - target);
    if (front && d < bestD) {
      bestD = d;
      best = z;
    }
    if (d < anyD) {
      anyD = d;
      any = z;
    }
  }
  return Number.isNaN(best) ? any : best;
}

/** The distance from height `z` down to the next crossing of the column: the wall thickness there. */
function wallBelow(hits, z) {
  let wall = Infinity;
  if (Number.isFinite(z)) for (const h of hits) if (h.z < z - 1e-6) wall = Math.min(wall, z - h.z);
  return wall;
}

/**
 * Build a sampler of the model surface in the text's local frame.
 * @param {BufferGeometry} geometry  the model (indexed or not); it is not modified
 * @param {import('three').Matrix4} placement  text-local -> model space (see placementMatrix())
 * @param {{ searchAbove?: number, searchBelow?: number }} [options]
 *   how far (model units) above / below the text plane a surface may be to
 *   count; default 50 each, Infinity for unlimited.
 * @returns {{ heightAt(x: number, y: number): number, dispose(): void }}
 *   heightAt gives the local-Z height of the model surface at (x, y): of the
 *   hits of a ray cast along -normal whose face looks the text's way, the one
 *   closest to the text plane (the clicked surface, z = 0), or NaN when
 *   nothing is hit within the search range.
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

  /** Every crossing of the column at (x, y): local-Z height and whether the face looks the item's way. */
  const hitsAt = (x, y) => {
    if (!bvh) return [];
    ray.origin.set(x, y, above).applyMatrix4(placement);
    return bvh.raycast(ray, DoubleSide, 0, above + below).map((hit) => ({
      z: local.copy(hit.point).applyMatrix4(inverse).z,
      front: hit.face.normal.dot(normal) > 0,
    }));
  };

  const sample = (x, y) => {
    const hits = hitsAt(x, y);
    // the surface an item sits on faces its way: of the hits whose face points along the item's normal (the outside
    // of the model as seen from the item) the one closest to the item's plane; a thin sheet bending towards the item
    // would otherwise offer its back, and letters there would sink into it. Only when no hit faces the item (the
    // ray enters a solid from inside) the closest hit of any kind counts
    const best = nearestHit(hits, 0);
    return { z: best, wall: wallBelow(hits, best) };
  };

  // walking primitives, all in the item's local frame
  const q = new Vector3();
  const dir = new Vector3();
  const tri = new Triangle();
  const faceNormal = (faceIndex, out) => {
    const g = bvh.geometry;
    const idx = g.index;
    const pos = g.attributes.position;
    tri.setFromAttributeAndIndices(pos, idx.getX(faceIndex * 3), idx.getX(faceIndex * 3 + 1), idx.getX(faceIndex * 3 + 2));
    return tri.getNormal(out);
  };
  const toLocal = (point, n) => {
    const p = point.clone().applyMatrix4(inverse);
    const m = n.clone().transformDirection(inverse);
    return { p: [p.x, p.y, p.z], n: [m.x, m.y, m.z] };
  };
  const closestTarget = { point: new Vector3(), distance: 0, faceIndex: 0 };

  return {
    /** Local-Z height of the surface at (x, y) and the wall thickness behind it. */
    sample,
    /**
     * The point of the surface nearest the local point p within `maxDistance`, with its face's normal (local), or
     * null.
     */
    closest(p, maxDistance = Infinity) {
      if (!bvh) return null;
      q.set(p[0], p[1], p[2]).applyMatrix4(placement);
      const found = bvh.closestPointToPoint(q, closestTarget, 0, maxDistance);
      if (!found) return null;
      return { ...toLocal(found.point, faceNormal(found.faceIndex, new Vector3())), distance: found.distance };
    },
    /**
     * The way the surface faces around the local point p: the area-weighted mean of the (local) normals of the
     * triangles within `radius` that face within 37° of `ref` – bumps smaller than the disc average out, a crease
     * (the edge of a top, the other side of a sheet) never counts. Null when no triangle qualifies.
     */
    normalAround(p, ref, radius, budget = 384) {
      if (!bvh) return null;
      const c = q.set(p[0], p[1], p[2]).applyMatrix4(placement);
      const r = dir.set(ref[0], ref[1], ref[2]).transformDirection(placement);
      const cx = c.x, cy = c.y, cz = c.z;
      // the leaves near the point, then at most `budget` of their triangles (every k-th, in the tree's order, which
      // scatters them over the disc): a dense scan has thousands of triangles in a few millimetres, and their mean
      // facing needs only a few hundred
      const ranges = [];
      let total = 0;
      bvh.shapecast({
        intersectsBounds: (box) => box.distanceToPoint(c) <= radius,
        intersectsRange: (offset, count) => {
          ranges.push(offset, count);
          total += count;
          return false;
        },
      });
      if (!total) return null;
      const g = bvh.geometry;
      const pos = g.attributes.position.array;
      const idx = g.index.array;
      const step = Math.max(1, Math.floor(total / budget));
      const r2 = radius * radius;
      const quarter = (Math.PI * r2) / 4;
      const near = [];
      let skip = 0;
      for (let k = 0; k < ranges.length; k += 2) {
        const end = ranges[k] + ranges[k + 1];
        for (let t = ranges[k] + skip; t < end; t += step) {
          const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, e = idx[t * 3 + 2] * 3;
          const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
          const vx = pos[e] - pos[a], vy = pos[e + 1] - pos[a + 1], vz = pos[e + 2] - pos[a + 2];
          // a triangle counts when its nearest point lies in the disc; by its area, but a large triangle of a coarse
          // model (a CAD face) as at most a quarter of the disc, so it cannot outweigh a fillet next to it
          if (pointTriangleDistance2(cx, cy, cz, pos, a, b, e) > r2) continue;
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (l > 0) near.push(nx / l, ny / l, nz / l, Math.min(l / 2, quarter));
        }
        skip = (skip + step - (ranges[k + 1] % step)) % step;
      }
      // two passes: the mean of everything facing roughly the walk's way (only walls and the far side of a sheet left
      // out), then the mean of what faces within 37° of that – a reference taken from the walk itself would carry
      // any lean from one step to the next
      const mean = (rx, ry, rz, cos) => {
        let ax = 0, ay = 0, az = 0;
        for (let i = 0; i < near.length; i += 4) {
          if (near[i] * rx + near[i + 1] * ry + near[i + 2] * rz < cos) continue;
          ax += near[i + 3] * near[i];
          ay += near[i + 3] * near[i + 1];
          az += near[i + 3] * near[i + 2];
        }
        const l = Math.hypot(ax, ay, az);
        return l > 0 ? [ax / l, ay / l, az / l] : null;
      };
      const wide = mean(r.x, r.y, r.z, WIDE_AROUND);
      if (!wide) return null;
      const m = mean(wide[0], wide[1], wide[2], AGREE_AROUND) ?? wide;
      const v = new Vector3(m[0], m[1], m[2]).transformDirection(inverse);
      return [v.x, v.y, v.z];
    },
    /** Every surface crossed going from the local point p along the local direction d within `length`: { p, n, distance }. */
    castAll(p, d, length) {
      if (!bvh) return [];
      const r = new Ray(q.set(p[0], p[1], p[2]).applyMatrix4(placement), dir.set(d[0], d[1], d[2]).transformDirection(placement));
      return bvh.raycast(r, DoubleSide, 0, length).map((hit) => ({ ...toLocal(hit.point, faceNormal(hit.faceIndex, new Vector3())), distance: hit.distance }));
    },
    /** The first surface crossed going from the local point p along the local direction d, within `length`, or null. */
    cast(p, d, length) {
      if (!bvh) return null;
      const r = new Ray(q.set(p[0], p[1], p[2]).applyMatrix4(placement), dir.set(d[0], d[1], d[2]).transformDirection(placement));
      const hit = bvh.raycastFirst(r, DoubleSide, 0, length);
      if (!hit) return null;
      return { ...toLocal(hit.point, faceNormal(hit.faceIndex, new Vector3())), distance: hit.distance };
    },
    /** Every crossing of the surface along the column at (x, y), unsorted: { z, front }. */
    hitsAt,
    heightAt(x, y) {
      return sample(x, y).z;
    },
    /**
     * Every crossing of the surface along the column at (x, y), sorted by local-Z height: { z, exit } where
     * `exit` is true when going up (+Z) leaves the solid there (the face points up). Duplicate hits on shared
     * edges are merged; a grazing touch (an entry and an exit at the same height) is dropped.
     */
    crossingsAt(x, y) {
      if (!bvh) return [];
      ray.origin.set(x, y, above).applyMatrix4(placement);
      const hits = bvh.raycast(ray, DoubleSide, 0, above + below);
      const out = hits
        .map((hit) => ({ z: local.copy(hit.point).applyMatrix4(inverse).z, exit: hit.face.normal.dot(normal) > 0 }))
        .sort((a, b) => a.z - b.z);
      const merged = [];
      for (const c of out) {
        const last = merged[merged.length - 1];
        if (last && Math.abs(last.z - c.z) < 1e-6) {
          if (last.exit !== c.exit) merged.pop(); // a touch: in and out at once
          continue;
        }
        merged.push(c);
      }
      return merged;
    },
    dispose() {
      if (bvh && bvhCache.get(geometry) === bvh) bvhCache.delete(geometry);
      bvh = null;
    },
  };
}

/**
 * A test of whether a point (model space) lies inside the closed model: the parity of the surface crossings along a
 * ray from it. Null when the geometry is empty.
 * @param {BufferGeometry} geometry
 * @returns {((point: number[]) => boolean) | null}
 */
export function createInsideTest(geometry) {
  const bvh = bvhFor(geometry);
  if (!bvh) return null;
  // an awkward direction, so the ray does not run along an edge or a face of a box-like model
  const ray = new Ray(new Vector3(), new Vector3(0.3192, 0.5377, 0.7803).normalize());
  return (point) => {
    ray.origin.set(point[0], point[1], point[2]);
    return bvh.raycast(ray, DoubleSide).length % 2 === 1;
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
/**
 * Which nodes of a grid (nx × ny nodes `cell` apart from [x0, y0]) lie within `grow` of the solid's footprint (its
 * shadow on the XY plane): 1 for those, 0 for the rest.
 */
function footprintMask(solid, { nx, ny, x0, y0, cell, grow }) {
  const mask = new Uint8Array(nx * ny);
  const shadow = solid.project();
  const grown = shadow.offset(grow, 'Round', 2, 8);
  const polygons = grown.toPolygons();
  shadow.delete();
  grown.delete();
  // each row: where it crosses the outlines, filled between alternate crossings
  const xs = [];
  for (let j = 0; j < ny; j++) {
    const y = y0 + j * cell;
    xs.length = 0;
    for (const poly of polygons) {
      for (let a = 0; a < poly.length; a++) {
        const p = poly[a];
        const q = poly[(a + 1) % poly.length];
        if (p[1] <= y === q[1] <= y) continue;
        xs.push(p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1]));
      }
    }
    xs.sort((a, b) => a - b);
    for (let c = 0; c + 1 < xs.length; c += 2) {
      const from = Math.max(0, Math.ceil((xs[c] - x0) / cell));
      const to = Math.min(nx - 1, Math.floor((xs[c + 1] - x0) / cell));
      for (let i = from; i <= to; i++) mask[j * nx + i] = 1;
    }
  }
  return mask;
}

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
 * The surface under a grid, followed outward from the node nearest the item's origin (the clicked point): every
 * node takes the front-facing hit nearest the height its resolved neighbours predict (their height carried on by
 * their slope), so the grid stays on the clicked surface where the column also crosses another one – the back of a
 * thin sheet, a scroll curling behind or over the face, a part of the model far below an edge. A node whose nearest
 * front-facing hit is further than `jump` from the prediction is a miss: the surface ended there (the text hangs
 * over an edge), it did not move to another layer. Returns a probe (x, y, i, j) => { z, wall } for the grid loop.
 */
function trackSurface(sampler, { nx, ny, x0, y0, cell, jump }) {
  const N = nx * ny;
  const hits = new Array(N);
  const fronts = new Array(N);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      hits[k] = sampler.hitsAt(x0 + i * cell, y0 + j * cell);
      const f = hits[k].filter((h) => h.front);
      fronts[k] = f.length ? f : hits[k];
    }
  }
  const z = new Float64Array(N).fill(NaN);
  const done = new Uint8Array(N); // visited: resolved (z finite) or judged a miss from the neighbours seen then
  const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const resolved = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && Number.isFinite(z[j * nx + i]);
  const grow = (queue) => {
    for (let q = 0; q < queue.length; q++) {
      const k = queue[q];
      const i = k % nx;
      const j = (k - i) / nx;
      for (const [di, dj] of steps) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const n = b * nx + a;
        if (done[n]) continue;
        done[n] = 1;
        // the prediction: each resolved neighbour's height, carried on by its slope where the node behind it is known too
        let sum = 0;
        let count = 0;
        for (const [ei, ej] of steps) {
          const p = a + ei, r = b + ej;
          if (!resolved(p, r)) continue;
          const zp = z[r * nx + p];
          sum += resolved(p + ei, r + ej) ? 2 * zp - z[(r + ej) * nx + p + ei] : zp;
          count++;
        }
        const predicted = sum / count;
        const best = nearestHit(fronts[n], predicted);
        if (Number.isFinite(best) && Math.abs(best - predicted) <= jump) {
          z[n] = best;
          queue.push(n);
        }
      }
    }
  };
  // the seed: the node nearest the origin that has a hit, on the surface nearest the item's plane
  let seed = -1;
  let seedD = Infinity;
  for (let k = 0; k < N; k++) {
    if (!hits[k].length) continue;
    const d = (x0 + (k % nx) * cell) ** 2 + (y0 + Math.floor(k / nx) * cell) ** 2;
    if (d < seedD) {
      seedD = d;
      seed = k;
    }
  }
  if (seed < 0) return () => ({ z: NaN, wall: Infinity });
  z[seed] = nearestHit(hits[seed], 0);
  done[seed] = 1;
  grow([seed]);
  // across a gap (a slot, a hole, a cut-out letter of the model) the surface carries on: the nodes beyond it that lie
  // where the surface before the gap leads (its height carried across, nearest node first) seed the growth again
  for (let round = 0; round < 8; round++) {
    const carried = Float64Array.from(z);
    const queue = [];
    for (let k = 0; k < N; k++) if (Number.isFinite(carried[k])) queue.push(k);
    for (let q = 0; q < queue.length; q++) {
      const k = queue[q];
      const i = k % nx;
      const j = (k - i) / nx;
      for (const [di, dj] of steps) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const n = b * nx + a;
        if (Number.isFinite(carried[n])) continue;
        carried[n] = carried[k];
        queue.push(n);
      }
    }
    const seeds = [];
    for (let k = 0; k < N; k++) {
      if (Number.isFinite(z[k]) || !hits[k].length) continue;
      const best = nearestHit(fronts[k], carried[k]);
      if (Number.isFinite(best) && Math.abs(best - carried[k]) <= jump) {
        z[k] = best;
        done[k] = 1;
        seeds.push(k);
      }
    }
    if (!seeds.length) break;
    grow(seeds);
  }
  return (x, y, i, j) => {
    const k = j * nx + i;
    return { z: z[k], wall: wallBelow(hits[k], z[k]) };
  };
}

/* --------------------------------------------------------------- walking */

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const along = (p, d, t) => [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
const unit3 = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};
const angleOf = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot3(a, b))));

/** A turn of the surface sharper than this within one step is an edge, not a curve to wrap round. */
const SHARP = Math.cos((50 * Math.PI) / 180);
/** Text never wraps on to surface facing more than this away from the text's own direction (the back of a sheet). */
const AWAY = Math.cos((120 * Math.PI) / 180);

/** The heading d carried from a surface with normal n on to one with normal m (turned as n turns into m). */
function transport(d, n, m) {
  const axis = cross3(n, m);
  const s = Math.hypot(axis[0], axis[1], axis[2]);
  let out = d;
  if (s > 1e-9) {
    const k = [axis[0] / s, axis[1] / s, axis[2] / s];
    const c = dot3(n, m);
    const kd = cross3(k, d);
    const kk = dot3(k, d) * (1 - c);
    out = [d[0] * c + kd[0] * s + k[0] * kk, d[1] * c + kd[1] * s + k[1] * kk, d[2] * c + kd[2] * s + k[2] * kk];
  }
  const t = dot3(out, m);
  return unit3([out[0] - t * m[0], out[1] - t * m[1], out[2] - t * m[2]]) ?? d;
}

/** v with its component along the unit vector k removed, as a unit vector (null when nothing is left). */
const inPlane = (v, k) => {
  const t = dot3(v, k);
  return unit3([v[0] - t * k[0], v[1] - t * k[1], v[2] - t * k[2]]);
};

/**
 * One step of length ds from p heading d. The heading is kept along the surface as it faces around p (its normal n
 * averaged over `smooth` mm, so bumps smaller than that neither steer the walk nor lengthen it) – and, when `plane`
 * is given, within that plane. The surface is met along the way it faces at the point ahead (a lump between the two
 * points then moves the new one up or down, not along the line); where that misses – the walk is going over a
 * small rounded edge the averaged normal has not yet turned for – the surface point nearest the point ahead is taken
 * instead, as long as the surface turns there no more sharply than 50° from `raw` (the face last stepped on).
 * Returns { p, n, raw, d } with n the averaged normal there and d the heading that arrived; null where the surface
 * ends within the step or turns sharply (an edge, a ledge, the rim of a sheet); AWAY_FROM_TEXT where it curves on
 * round the back further than text may wrap.
 */
function stepOver(sampler, p, n, raw, d, ds, plane, smooth, lateral = null) {
  let ahead = plane ? unit3(cross3(plane, inPlane(n, plane) ?? n)) : d;
  if (!ahead) return null;
  if (dot3(ahead, d) < 0) ahead = [-ahead[0], -ahead[1], -ahead[2]];
  const target = along(p, ahead, ds);
  const aroundTarget = sampler.normalAround(target, n, smooth);
  let mt = aroundTarget ?? n;
  // the surface is met within the plane of the heading (the walk's plane, or the plane through the heading and the
  // surface's wider facing): a lump leaning sideways then moves the point up or down, never sideways, so a walk over
  // lumps does not drift off its line step by step
  const side = plane ?? lateral;
  if (side) mt = inPlane(mt, side) ?? mt;
  if (dot3(mt, n) < SHARP) mt = n;
  const reach = Math.max(1.5 * ds, 1.5);
  let best = null;
  let bestD = Infinity;
  for (const h of sampler.castAll(along(target, mt, reach), [-mt[0], -mt[1], -mt[2]], 2 * reach)) {
    if (dot3(h.n, mt) < 0.2) continue; // the far side of a sheet, or a wall facing across the walk
    const dist = Math.abs(h.distance - reach);
    if (dist < bestD) {
      bestD = dist;
      best = h;
    }
  }
  if (!best) {
    // round a small rounded edge: the nearest surface point, if the surface turns there gently enough
    const c = sampler.closest(target, ds);
    if (!c || dot3(c.n, raw) < SHARP || dot3(c.n, n) < 0.2) return null;
    if (dot3([c.p[0] - p[0], c.p[1] - p[1], c.p[2] - p[2]], ahead) < 0.3 * ds) return null;
    // on a rounded edge the nearest point lies under the point ahead, along the surface's normal; past a sharp edge
    // (the rim of a disc) it is the edge itself, off to the side: the text does not crawl along the rim
    const v = [target[0] - c.p[0], target[1] - c.p[1], target[2] - c.p[2]];
    const off = Math.hypot(v[0], v[1], v[2]);
    const square = Math.abs(dot3(v, c.n));
    if (off > 0.05 * ds && square < 0.8 * off) return null;
    best = c;
  }
  // the averaged normal at the landed point: the one at the point ahead serves when the two are close
  const near = Math.hypot(best.p[0] - target[0], best.p[1] - target[1], best.p[2] - target[2]) < 0.25 * smooth;
  const around = (near && aroundTarget) || sampler.normalAround(best.p, mt, smooth) || best.n;
  if (dot3(around, n) < SHARP) return null;
  if (around[2] < AWAY) return AWAY_FROM_TEXT;
  return { p: best.p, n: around, raw: best.n, d: ahead };
}

/** stepOver's answer where the surface curves on round the back, past what the text may wrap. */
const AWAY_FROM_TEXT = Object.freeze({ away: true });

/**
 * The surface under a point carried past an edge: of the surfaces crossed along -n (kept in the walk's plane) within
 * `jump` either side of the point, the one facing the text's way nearest it (the far side of a slot, the top of a
 * ledge, the floor below a step), with its averaged normal.
 */
function landAt(sampler, c, n, jump, plane, smooth) {
  const m = (plane && inPlane(n, plane)) || n;
  let best = null;
  let bestD = Infinity;
  for (const h of sampler.castAll(along(c, m, jump), [-m[0], -m[1], -m[2]], 2 * jump)) {
    if (dot3(h.n, m) < 0.2 || h.n[2] < AWAY) continue; // walls across the way, the far side of a sheet
    const d = Math.abs(h.distance - jump);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  if (!best) return null;
  const around = sampler.normalAround(best.p, m, smooth) ?? best.n;
  if (dot3(around, m) < 0.2 || around[2] < AWAY) return null;
  return { p: best.p, n: around, raw: best.n };
}

/**
 * Walk `count` steps of length ds over the surface from `start` ({ p, n, raw, on, lost }) heading d, calling
 * emit(k, p, n, d, on, sharp, lost) after each. Without `plane` the walk goes straight on along the (averaged)
 * surface – a geodesic, the way a strip of tape lies, which on a cylinder is a helix at any angle; with `plane` it
 * stays in the plane through the start with that normal. Smooth curvature is wrapped round; at a sharp turn the walk
 * carries on straight and lands on the surface it finds there (`sharp` is then set), or carries on in the air (`on`
 * false) where there is none, trying to land again at every step. `lost` says why the walk left the surface: EDGE
 * (the text hangs over an edge) or ROUND_THE_BACK (the surface curves on round the back, further than text may wrap).
 */
function walk(sampler, start, d, count, ds, jump, emit, plane, smooth, steer = smooth) {
  let { p, n, raw = start.n, on, lost = 0 } = start;
  // the heading is carried along the surface as it faces over a wider disc (`steer` mm): lumps the size of letters
  // then do not turn it, while a cane or a mug, whose mean facing over any disc centred on it is its own normal, still
  // does – so on a cylinder the line is a helix, as tape would lie
  let ns = (!plane && steer > smooth && sampler.normalAround(p, n, steer, 256)) || n;
  d = (plane ? inPlane(d, plane) : inPlane(d, ns)) ?? d;
  for (let k = 1; k <= count; k++) {
    const lateral = plane ? null : unit3(cross3(ns, d));
    let next = on ? stepOver(sampler, p, n, raw, d, ds, plane, smooth, lateral) : null;
    if (next?.away) {
      next = null;
      lost = ROUND_THE_BACK;
    } else if (on && !next) {
      lost = EDGE;
    }
    const sharp = on && !next;
    if (!next) {
      const carried = along(p, d, ds);
      const landed = landAt(sampler, carried, n, jump, plane, smooth);
      if (!landed) {
        p = carried;
        on = false;
        emit(k, p, n, d, false, sharp, lost);
        continue;
      }
      next = landed;
    }
    // the heading for the next step: carried on to the new point's surface (turned as the normal turns), or kept in
    // the plane
    let ahead = next.d ?? d;
    if (plane) {
      const m = inPlane(next.n, plane);
      const t = m && unit3(cross3(plane, m));
      if (t) ahead = dot3(t, ahead) < 0 ? [-t[0], -t[1], -t[2]] : t;
    } else {
      const nsNext = (steer > smooth && sampler.normalAround(next.p, next.n, steer, 256)) || next.n;
      ahead = transport(ahead, ns, nsNext);
      ns = nsNext;
    }
    d = ahead;
    p = next.p;
    n = next.n;
    raw = next.raw ?? next.n;
    on = true;
    lost = 0;
    emit(k, p, n, d, true, sharp, 0);
  }
}

/** Why a walk left the surface. */
const EDGE = 1;
const ROUND_THE_BACK = 2;

/**
 * A grid walked over the surface: node (i, j) is the surface point reached from the seed by walking (i - i0)·cell
 * along the reading direction and then (j - j0)·cell along the up direction, both measured along the surface.
 * Returns the points, the walked (face) normals, whether each node is on the surface, and where a sharp turn was
 * crossed.
 */
function walkChart(sampler, { nx, ny, i0, j0, cell, jump, seed, smooth, chord = smooth, steer = chord, planar = 'auto' }) {
  const N = nx * ny;
  const P = new Float64Array(N * 3);
  const W = new Float64Array(N * 3);
  const on = new Uint8Array(N);
  const sharp = new Uint8Array(N);
  const lost = new Uint8Array(N);
  const set = (k, p, n, onSurface, isSharp, why = 0) => {
    P[k * 3] = p[0];
    P[k * 3 + 1] = p[1];
    P[k * 3 + 2] = p[2];
    W[k * 3] = n[0];
    W[k * 3 + 1] = n[1];
    W[k * 3 + 2] = n[2];
    on[k] = onSurface ? 1 : 0;
    sharp[k] = isSharp ? 1 : 0;
    lost[k] = onSurface ? 0 : why;
  };
  const heading = new Array(nx);
  const n0 = sampler.normalAround(seed.p, seed.n, smooth) ?? seed.n;
  const x = inPlane([1, 0, 0], unit3(n0) ?? [0, 0, 1]) ?? [1, 0, 0];
  const start = { p: seed.p, n: n0, on: true };
  const walkSpine = (plane) => {
    set(j0 * nx + i0, seed.p, n0, true, false);
    heading[i0] = x;
    walk(sampler, start, x, nx - 1 - i0, cell, jump, (k, p, n, d, o, sh, why) => {
      set(j0 * nx + i0 + k, p, n, o, sh, why);
      heading[i0 + k] = d;
    }, plane, smooth, steer);
    walk(sampler, start, [-x[0], -x[1], -x[2]], i0, cell, jump, (k, p, n, d, o, sh, why) => {
      set(j0 * nx + i0 - k, p, n, o, sh, why);
      heading[i0 - k] = [-d[0], -d[1], -d[2]];
    }, plane, smooth, steer);
  };
  // the reading line first stays in the plane through the clicked point spanned by the reading direction and the
  // normal: seen from where the text was placed it runs straight, however the surface undulates under it. Where the
  // surface under it turns steadily about one axis tilted from that plane – a cane or a mug with the text set at an
  // angle – a straight line in that plane would fan the letters out, and the text is laid on like tape instead (a
  // helix round a cylinder)
  const spine = [0, 1, 0];
  walkSpine(spine);
  const span = Math.max(1, Math.round(chord / cell));
  let planarWalk = planar !== false;
  if (planar === 'auto') {
    let ax = 0, ay = 0, az = 0, turn = 0;
    for (let i = 0; i + span < nx; i += span) {
      const a = j0 * nx + i;
      const b = a + span;
      if (!on[a] || !on[b]) continue;
      const c = cross3([W[a * 3], W[a * 3 + 1], W[a * 3 + 2]], [W[b * 3], W[b * 3 + 1], W[b * 3 + 2]]);
      ax += c[0];
      ay += c[1];
      az += c[2];
      turn += Math.hypot(c[0], c[1], c[2]);
    }
    const total = Math.hypot(ax, ay, az);
    const coherent = turn > 0.35 && total > 0.85 * turn; // turns by more than 20°, nearly all of it about one axis
    const tilted = total > 0 && Math.abs(ay) / total < Math.cos((10 * Math.PI) / 180); // that axis is not the plane's
    if (coherent && tilted) {
      planarWalk = false;
      walkSpine(null);
    }
  }
  planar = planarWalk;
  // each column stays in the plane across the reading line there, its direction taken as the chord over `chord` mm
  // either side: on a circle that chord is exactly the tangent at its middle, while the tilt of lumps shorter than it
  // averages out, so a lump under one node does not lean its column into its neighbours (laid like tape, it goes
  // straight on along the surface across the line)
  for (let i = 0; i < nx; i++) {
    const k = j0 * nx + i;
    const p = [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]];
    const n = [W[k * 3], W[k * 3 + 1], W[k * 3 + 2]];
    let a = Math.max(0, i - span);
    let b = Math.min(nx - 1, i + span);
    while (a < i && !(on[j0 * nx + a] && !sharp[j0 * nx + a + 1])) a++;
    while (b > i && !(on[j0 * nx + b] && !sharp[j0 * nx + b])) b--;
    const ka = j0 * nx + a;
    const kb = j0 * nx + b;
    let along3 = a < b ? unit3([P[kb * 3] - P[ka * 3], P[kb * 3 + 1] - P[ka * 3 + 1], P[kb * 3 + 2] - P[ka * 3 + 2]]) : null;
    if (!along3 || dot3(along3, heading[i]) < 0.5) along3 = heading[i];
    const across = along3;
    const up = unit3(cross3(n, across)) ?? [0, 1, 0];
    const from = { p, n, on: !!on[k], lost: lost[k] };
    const plane = planar ? across : null;
    walk(sampler, from, up, ny - 1 - j0, cell, jump, (m, q, nn, d, o, sh, why) => set((j0 + m) * nx + i, q, nn, o, sh, why), plane, smooth, steer);
    walk(sampler, from, [-up[0], -up[1], -up[2]], j0, cell, jump, (m, q, nn, d, o, sh, why) => set((j0 - m) * nx + i, q, nn, o, sh, why), plane, smooth, steer);
  }
  return { P, W, on, sharp, lost };
}

/**
 * conformSolid's wrapping path: the slab laid on to a grid walked over the surface (see walkChart). Null when the
 * clicked point is not on the surface (the projection path then reports the text as not touching).
 */
function wrapSolid(flatSolid, sampler, { min, max, width, height, flatTolerance, reach, wallLimit, options, result }) {
  const z0 = nearestHit(sampler.hitsAt(0, 0), 0);
  if (!Number.isFinite(z0) || Math.abs(z0) > reach) return null;
  // the size of the letters (or plate): what the grid, the smoothing and the jumps are scaled to – a curved line of
  // text spans a box much taller than its letters
  const scale = options.scale ?? Math.min(width, height);
  // a grid with a node at the origin, covering the footprint and a margin
  let cell = options.cell ?? Math.max(0.4, scale / 12);
  const margin = options.margin ?? cell;
  const xLo = Math.min(min[0] - margin, 0);
  const xHi = Math.max(max[0] + margin, 0);
  const yLo = Math.min(min[1] - margin, 0);
  const yHi = Math.max(max[1] + margin, 0);
  cell = Math.max(cell, (xHi - xLo) / (MAX_GRID - 1), (yHi - yLo) / (MAX_GRID - 1));
  const i0 = Math.ceil(-xLo / cell);
  const j0 = Math.ceil(-yLo / cell);
  const nx = i0 + Math.ceil(xHi / cell) + 1;
  const ny = j0 + Math.ceil(yHi / cell) + 1;
  const x0 = -i0 * cell;
  const y0 = -j0 * cell;
  const N = nx * ny;
  const jump = Math.max(3, 0.6 * scale, 6 * cell);
  // bumps smaller than about a quarter of the letters' height are texture the text lies over, not a shape it follows
  const smooth = Math.min(4, Math.max(1, 0.25 * scale));
  const chord = Math.max(smooth, 0.5 * scale);
  const { P, W, on, sharp, lost } = walkChart(sampler, { nx, ny, i0, j0, cell, jump, smooth, chord, planar: 'auto', seed: { p: [0, 0, z0], n: [0, 0, 1] } });
  const pt = (k) => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]];
  const wn = (k) => [W[k * 3], W[k * 3 + 1], W[k * 3 + 2]];

  // smooth normals from the grid itself (central differences over a few nodes, more for a taller slab so its top
  // layer does not fold on a tight concave bend), never across a sharp turn: there the side that agrees is used
  const zr = Math.max(Math.abs(min[2]), Math.abs(max[2]));
  const span = Math.max(1, Math.min(3, Math.round((1.5 * zr) / cell)));
  const agree = (a, b) => on[a] === on[b] && dot3(wn(a), wn(b)) > Math.cos(Math.PI / 6);
  const G = new Float64Array(N * 3);
  const diff = (kc, kLo, kHi) => {
    const a = kLo !== kc && agree(kLo, kc) ? kLo : kc;
    const b = kHi !== kc && agree(kHi, kc) ? kHi : kc;
    if (a === b) return null;
    return [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const dx = diff(k, j * nx + Math.max(0, i - span), j * nx + Math.min(nx - 1, i + span));
      const dy = diff(k, Math.max(0, j - span) * nx + i, Math.min(ny - 1, j + span) * nx + i);
      let n = dx && dy ? unit3(cross3(dx, dy)) : null;
      const w = wn(k);
      if (!n) n = unit3(w) ?? [0, 0, 1];
      else if (dot3(n, w) < 0) n = [-n[0], -n[1], -n[2]];
      G[k * 3] = n[0];
      G[k * 3 + 1] = n[1];
      G[k * 3 + 2] = n[2];
    }
  }
  const gn = (k) => [G[k * 3], G[k * 3 + 1], G[k * 3 + 2]];

  // statistics behind the notes, over the nodes under the slab: within its box and within half a letter of its
  // footprint – a straight line or a plate covers its box, but an arc of text leaves most of it empty, and what lies
  // there (the inside of the arch, past the rim of a medal) is no part of the text
  const near = footprintMask(flatSolid, { nx, ny, x0, y0, cell, grow: Math.max(cell, 0.5 * scale) });
  const inBox = (i, j) => {
    const x = x0 + i * cell, y = y0 + j * cell;
    return x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1];
  };
  const any = near.includes(1);
  const inside = (i, j) => inBox(i, j) && (!any || near[j * nx + i] === 1);
  const buriedAt = (p) => sampler.castAll(p, [0, 0, 1], 1e4).length % 2 === 1; // an odd number of crossings above: inside
  let misses = 0;
  let buried = 0;
  let roundTheBack = 0;
  let squeezed = 0;
  let footprint = 0; // nodes under the footprint
  let missesUnder = 0; // ... missing the surface
  let sum = 0;
  let count = 0;
  let lo = Infinity;
  let hi = -Infinity;
  let maxSlope = 0;
  let rMin = Infinity;
  let pairs = 0; // neighbouring nodes under the slab, both on the surface
  let edgePairs = 0; // ... with a ledge, a slot or a sharp turn between them
  const rowsUnder = new Set();
  let minWall = Infinity;
  let thinCells = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const under = inside(i, j);
      if (under) footprint++;
      if (!on[k]) {
        misses++;
        if (!under) continue;
        missesUnder++;
        if (lost[k] === ROUND_THE_BACK) roundTheBack++;
        else if (buriedAt(pt(k))) buried++;
        continue;
      }
      const z = P[k * 3 + 2];
      sum += z;
      count++;
      if (z < lo) lo = z;
      if (z > hi) hi = z;
      if (!under) continue;
      rowsUnder.add(j);
      maxSlope = Math.max(maxSlope, angleOf(gn(k), [0, 0, 1]));
      if (sharp[k]) edgePairs++;
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        if (i + di >= nx || j + dj >= ny) continue;
        const n = (j + dj) * nx + i + di;
        if (!on[n]) continue;
        const turn = angleOf(gn(k), gn(n));
        pairs++;
        if (turn > Math.PI / 4) {
          edgePairs++;
          continue;
        }
        const step = [P[n * 3] - P[k * 3], P[n * 3 + 1] - P[k * 3 + 1], P[n * 3 + 2] - P[k * 3 + 2]];
        const rise = Math.abs(dot3(step, gn(k)));
        const run = Math.sqrt(Math.max(0, dot3(step, step) - rise * rise));
        if (sharp[n] || (rise > 0.3 && (rise > 1.2 * run || Math.hypot(rise, run) > 2 * cell))) {
          edgePairs++; // the walk landed past a ledge or a slot between these nodes (a jump, not a slope)
          continue;
        }
        if (turn > 1e-6) rMin = Math.min(rMin, cell / turn);
      }
      // the wall behind the surface, along its own normal
      const g = gn(k);
      const behind = sampler.cast(along(pt(k), g, -0.01), [-g[0], -g[1], -g[2]], 1e4);
      const wall = behind ? behind.distance + 0.01 : Infinity;
      if (wall < minWall) minWall = wall;
      if (wall < wallLimit) thinCells++;
      // and the room in front of it: a part of the model hanging over the surface (a scroll curling over a banner's
      // face) closer than the letters are tall leaves no room for them
      if (max[2] > 0 && sampler.cast(along(pt(k), g, 0.01), g, max[2] + 0.5)) squeezed++;
    }
  }
  // how the letters' shape survives: each grid cell under the slab, its sides along the surface, compared with the
  // flat square – stretched, squeezed or sheared (a line running obliquely round a cane fans its letters out). The
  // cells' shapes are averaged over a few cells around each first: a lump distorts a cell or two one way and the next
  // ones the other, a fan distorts them all alike
  const CX = new Float64Array(N).fill(NaN);
  const CY = new Float64Array(N).fill(NaN);
  const CA = new Float64Array(N).fill(NaN);
  const CS = new Float64Array(N).fill(NaN);
  for (let j = 0; j + 1 < ny; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const k = j * nx + i;
      if (!inside(i, j) || !on[k] || !on[k + 1] || !on[k + nx] || sharp[k + 1] || sharp[k + nx]) continue;
      const g = gn(k);
      const tangential = (a, b) => {
        const v = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
        const t = dot3(v, g);
        return [v[0] - t * g[0], v[1] - t * g[1], v[2] - t * g[2]];
      };
      const ex = tangential(k, k + 1);
      const ey = tangential(k, k + nx);
      const lx = Math.hypot(ex[0], ex[1], ex[2]) / cell;
      const ly = Math.hypot(ey[0], ey[1], ey[2]) / cell;
      if (lx > 2 || ly > 2) continue; // a jump (a ledge, a slot), not a stretch
      const c = cross3(ex, ey);
      CX[k] = lx;
      CY[k] = ly;
      CA[k] = Math.hypot(c[0], c[1], c[2]) / (cell * cell);
      CS[k] = dot3(ex, ey) / Math.max(1e-12, lx * ly * cell * cell); // cos of the cell's corner angle (signed)
    }
  }
  const around = Math.max(1, Math.round(smooth / cell));
  let cells = 0;
  let distorted = 0;
  for (let j = 0; j + 1 < ny; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      if (Number.isNaN(CX[j * nx + i])) continue;
      let sx = 0, sy = 0, sa = 0, ss = 0, n = 0;
      for (let b = Math.max(0, j - around); b <= Math.min(ny - 2, j + around); b++) {
        for (let a = Math.max(0, i - around); a <= Math.min(nx - 2, i + around); a++) {
          const m = b * nx + a;
          if (Number.isNaN(CX[m])) continue;
          sx += CX[m];
          sy += CY[m];
          sa += CA[m];
          ss += CS[m];
          n++;
        }
      }
      sx /= n;
      sy /= n;
      sa /= n;
      ss /= n;
      cells++;
      if (sx > 1.2 || sx < 0.83 || sy > 1.2 || sy < 0.83 || sa > 1.3 || sa < 0.75 || Math.abs(ss) > 0.25) distorted++;
    }
  }
  // an edge runs across the text: a line of jumps, not a stray one where the surface is rough; distortion shows
  // over more than a few cells
  const crossesEdge = edgePairs >= Math.max(3, 0.3 * rowsUnder.size);
  const steep = distorted > 0.03 * Math.max(1, cells);
  // how far the reading line turns from end to end
  let wrapDeg = 0;
  for (let i = 1; i < nx; i++) {
    const a = j0 * nx + i - 1;
    const b = a + 1;
    if (on[a] && on[b] && !sharp[b]) wrapDeg += (angleOf(gn(a), gn(b)) * 180) / Math.PI;
  }
  const stats = {
    samples: N,
    misses,
    buried,
    missFraction: footprint ? (missesUnder - buried - roundTheBack) / footprint : 0,
    buriedFraction: footprint ? buried / footprint : 0,
    squeezedFraction: footprint ? squeezed / footprint : 0,
    touches: true,
    minHeight: lo,
    maxHeight: hi,
    meanHeight: count ? sum / count : NaN,
    minWall,
    thinCells,
    cell,
    grid: [nx, ny],
    maxSlopeDeg: (maxSlope * 180) / Math.PI,
    distortedFraction: cells ? distorted / cells : 0,
    steep,
    wrapDeg,
    wrapsAround: roundTheBack > 0.02 * footprint,
    crossesEdge,
    rMin,
    wrapped: true,
  };
  if (hi - lo <= flatTolerance && stats.maxSlopeDeg < 0.5 && !crossesEdge) {
    return result(flatSolid.translate(0, 0, stats.meanHeight), false, stats);
  }

  // refine just finely enough that the warped facets stay within the chord error
  const chordError = options.chordError ?? 0.02;
  let maxEdge = options.maxEdge;
  if (!(maxEdge > 0)) {
    maxEdge = Number.isFinite(rMin) ? Math.sqrt(8 * rMin * chordError) : 2;
    maxEdge = Math.min(Math.max(maxEdge, 0.25), 2, Math.min(width, height) / 3);
  }
  stats.maxEdge = maxEdge;

  const refined = flatSolid.refineToLength(maxEdge);
  const solid = refined.warpBatch((verts, n) => {
    for (let v = 0; v < n; v++) {
      const x = verts[v * 3], y = verts[v * 3 + 1], z = verts[v * 3 + 2];
      const u = Math.min(Math.max((x - x0) / cell, 0), nx - 1);
      const w = Math.min(Math.max((y - y0) / cell, 0), ny - 1);
      const i = Math.min(Math.floor(u), nx - 2);
      const j = Math.min(Math.floor(w), ny - 2);
      const fx = u - i;
      const fy = w - j;
      const k = j * nx + i;
      const c00 = (1 - fx) * (1 - fy), c10 = fx * (1 - fy), c01 = (1 - fx) * fy, c11 = fx * fy;
      const at = (a, c) => c00 * a[k * 3 + c] + c10 * a[(k + 1) * 3 + c] + c01 * a[(k + nx) * 3 + c] + c11 * a[(k + nx + 1) * 3 + c];
      let gx = at(G, 0), gy = at(G, 1), gz = at(G, 2);
      const l = Math.hypot(gx, gy, gz) || 1;
      gx /= l;
      gy /= l;
      gz /= l;
      verts[v * 3] = at(P, 0) + z * gx;
      verts[v * 3 + 1] = at(P, 1) + z * gy;
      verts[v * 3 + 2] = at(P, 2) + z * gz;
    }
  });
  refined.delete();
  return result(solid, true, stats);
}

/**
 * Deform a flat text solid so it follows the sampled surface.
 * @param {import('manifold-3d').Manifold} flatSolid  flat extrusion in text-local space (caller keeps ownership)
 * @param {{ heightAt(x: number, y: number): number }} sampler  from createSurfaceSampler()
 * @param {object} [options]
 * @param {number} [options.scale]          the size of the letters or plate (default min(w, h)): a curved line spans a
 *                                          box taller than its letters, and the grid and smoothing follow the letters
 * @param {number} [options.cell]           sample spacing, model units (default max(0.4, scale / 12))
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
  if (options.wrap !== false && sampler.closest && sampler.castAll && sampler.hitsAt) {
    const wrapped = wrapSolid(flatSolid, sampler, { min, max, width, height, flatTolerance, reach, wallLimit, options, result });
    if (wrapped) return wrapped;
  }

  let cell = options.cell ?? Math.max(0.4, (options.scale ?? Math.min(width, height)) / 12);
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
  const probe = sampler.hitsAt
    ? trackSurface(sampler, { nx, ny, x0, y0, cell, jump: Math.max(3, 0.6 * Math.min(width, height), 6 * cell) })
    : sampler.sample ?? ((x, y) => ({ z: sampler.heightAt(x, y), wall: Infinity }));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const { z, wall } = probe(x0 + i * cell, y0 + j * cell, i, j);
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

  // the surface normal at every grid node (from central differences of the height, one-sided at the border), so the
  // slab is extruded along the surface's own normal rather than the text's: constant height on a slope, and the
  // letters' sides stand square on the surface. A step (a sudden slope change) is left out of the slope on its
  // side, so the surface next to it keeps its own normal and the step's wall is not smeared into a lean
  const gn = new Float64Array(nx * ny * 3);
  const slopeAcross = (k, kLo, kHi, stepLo, stepHi) => {
    // central difference, or the gentler one-sided difference where the other side steps or is missing
    const lo = kLo < 0 ? NaN : (h[k] - h[kLo]) / stepLo;
    const hi = kHi < 0 ? NaN : (h[kHi] - h[k]) / stepHi;
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      if (Math.abs(hi - lo) > tanMax) return Math.abs(lo) < Math.abs(hi) ? lo : hi;
      return (lo + hi) / 2;
    }
    return Number.isFinite(lo) ? lo : Number.isFinite(hi) ? hi : 0;
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const gx = slopeAcross(k, i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, cell, cell);
      const gy = slopeAcross(k, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1, cell, cell);
      const l = Math.sqrt(gx * gx + gy * gy + 1);
      gn[k * 3] = -gx / l;
      gn[k * 3 + 1] = -gy / l;
      gn[k * 3 + 2] = 1 / l;
    }
  }

  // bilinear interpolation of the grid, clamped to its edges
  const cellOf = (x, y) => {
    const u = Math.min(Math.max((x - x0) / cell, 0), nx - 1);
    const v = Math.min(Math.max((y - y0) / cell, 0), ny - 1);
    const i = Math.min(Math.floor(u), nx - 2);
    const j = Math.min(Math.floor(v), ny - 2);
    return { k: j * nx + i, fx: u - i, fy: v - j };
  };
  const lerp2 = (a, k, fx, fy, stride, c) => {
    const bottom = a[k * stride + c] * (1 - fx) + a[(k + 1) * stride + c] * fx;
    const top = a[(k + nx) * stride + c] * (1 - fx) + a[(k + nx + 1) * stride + c] * fx;
    return bottom * (1 - fy) + top * fy;
  };
  const heightAt = (x, y) => {
    const { k, fx, fy } = cellOf(x, y);
    return lerp2(h, k, fx, fy, 1, 0);
  };

  const refined = flatSolid.refineToLength(maxEdge);
  const solid = refined.warpBatch((verts, count) => {
    for (let i = 0; i < count; i++) {
      const x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
      const { k, fx, fy } = cellOf(x, y);
      let nxv = lerp2(gn, k, fx, fy, 3, 0), nyv = lerp2(gn, k, fx, fy, 3, 1), nzv = lerp2(gn, k, fx, fy, 3, 2);
      const l = Math.sqrt(nxv * nxv + nyv * nyv + nzv * nzv) || 1;
      nxv /= l;
      nyv /= l;
      nzv /= l;
      verts[i * 3] = x + z * nxv;
      verts[i * 3 + 1] = y + z * nyv;
      verts[i * 3 + 2] = lerp2(h, k, fx, fy, 1, 0) + z * nzv;
    }
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
  if (stats.buriedFraction > 0.02) {
    notes.push({
      level: 'warn',
      code: 'RUNS_INTO_MODEL',
      text: 'Part of the text runs into the model here – a floor, a ledge or a wall in its way – and is buried in it. Move it or make it smaller.',
    });
  }
  if (stats.squeezedFraction > 0.02) {
    notes.push({
      level: 'warn',
      code: 'UNDER_OVERHANG',
      text: 'Part of the text runs under a part of the model that hangs over the surface, where there is no room for the letters. Move it out from under it.',
    });
  }
  if (stats.wrapsAround) {
    notes.push({
      level: 'warn',
      code: 'WRAPS_AROUND',
      text: 'The text is longer than this curve lets it wrap: its ends would run round the back. Make it shorter or smaller, or use two lines.',
    });
  } else if (stats.steep) {
    notes.push({
      level: 'warn',
      code: 'TOO_CURVED',
      text: stats.wrapped
        ? 'The surface curves two ways here, so the letters near the ends of the text are stretched or squeezed. Try shorter text, smaller letters or two lines.'
        : 'The text is wider than this curve can hold; letters near the ends stretch. Try shorter text, smaller letters or two lines.',
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
  const down = new Ray(new Vector3(), new Vector3(0, 0, -1));
  return {
    bounds: { min, max },
    heightAt(x, y) {
      ray.origin.set(x, y, min[2] - 1);
      const hit = bvh.raycastFirst(ray, DoubleSide);
      return hit ? hit.point.z : NaN;
    },
    /** The part's top at (x, y): the highest z of the part in that column, or NaN where the part does not reach. */
    topAt(x, y) {
      down.origin.set(x, y, max[2] + 1);
      const hit = bvh.raycastFirst(down, DoubleSide);
      return hit ? hit.point.z : NaN;
    },
  };
}

/**
 * A closed solid between two height fields on a grid: for each grid node
 * (i, j) `bottom[k]` and `top[k]` (k = j * (nx + 1) + i) give the local-Z
 * extent of the column, NaN where there is none. Cells whose four nodes all
 * exist get a bottom and a top; walls close the slab where a cell meets a
 * missing one or the grid's edge. Shared nodes make it watertight.
 * @returns {{ vertProperties: Float32Array, triVerts: Uint32Array } | null}  (null when no cell exists)
 */
export function heightFieldSlab({ x0, y0, cell, nx, ny, bottom, top }) {
  const W = nx + 1;
  const node = (i, j) => j * W + i;
  const ok = (i, j) => {
    const k = node(i, j);
    return Number.isFinite(bottom[k]) && Number.isFinite(top[k]);
  };
  const active = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && ok(i, j) && ok(i + 1, j) && ok(i + 1, j + 1) && ok(i, j + 1);
  const index = new Int32Array(W * (ny + 1) * 2).fill(-1); // (node, bottom|top) -> vertex id
  const verts = [];
  const tris = [];
  const vid = (i, j, isTop) => {
    const slot = node(i, j) * 2 + (isTop ? 1 : 0);
    if (index[slot] < 0) {
      index[slot] = verts.length / 3;
      verts.push(x0 + i * cell, y0 + j * cell, isTop ? top[node(i, j)] : bottom[node(i, j)]);
    }
    return index[slot];
  };
  const tri = (a, b, c) => tris.push(a, b, c);
  const wall = (i1, j1, i2, j2) => {
    // outward winding: along the edge, then up
    const b1 = vid(i1, j1, false), b2 = vid(i2, j2, false), t1 = vid(i1, j1, true), t2 = vid(i2, j2, true);
    tri(b1, b2, t2);
    tri(b1, t2, t1);
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!active(i, j)) continue;
      // a=(i,j) b=(i+1,j) c=(i+1,j+1) d=(i,j+1), counter-clockwise seen from +Z
      const at = vid(i, j, true), bt = vid(i + 1, j, true), ct = vid(i + 1, j + 1, true), dt = vid(i, j + 1, true);
      const ab = vid(i, j, false), bb = vid(i + 1, j, false), cb = vid(i + 1, j + 1, false), db = vid(i, j + 1, false);
      tri(at, bt, ct);
      tri(at, ct, dt);
      tri(ab, cb, bb);
      tri(ab, db, cb);
      if (!active(i, j - 1)) wall(i, j, i + 1, j); // -Y side
      if (!active(i + 1, j)) wall(i + 1, j, i + 1, j + 1); // +X side
      if (!active(i, j + 1)) wall(i + 1, j + 1, i, j + 1); // +Y side
      if (!active(i - 1, j)) wall(i, j + 1, i, j); // -X side
    }
  }
  if (!tris.length) return null;
  return { vertProperties: Float32Array.from(verts), triVerts: Uint32Array.from(tris) };
}


/**
 * How far a rigid part has to come down (local -Z) to meet the model. The
 * gap between the part's underside and the surface is measured on a grid
 * over the part:
 *   lower – first contact: the smallest gap, i.e. how far the part can come
 *           down before any point of it touches the model (0 when it already
 *           touches or penetrates);
 *   push  – how much further it comes down so that its body, not just its
 *           nearest point, meets the model: 30 % of its covered area closes
 *           the part's OWN recess (its underside above its lowest point), but
 *           never more than the gap still open there. So a scroll attached by
 *           its hollow side comes down until its back rests on the model while
 *           its tips pass into it, a beam resting on two posts is not pushed
 *           down through them (its underside is flat: no recess), and a part
 *           already touching along its body stays put.
 * Both are capped by the part's own height: a part hovering farther away
 * than that is not touching the model at all (`reachable` false).
 * @param {{ bounds, heightAt }} underside  from createUndersideSampler()
 * @param {{ heightAt(x: number, y: number): number }} surface  from createSurfaceSampler()
 * @returns {{ lower: number, push: number, reachable: boolean, firstContact: number, cells: number, covered: number }}
 *   `firstContact` is the raw smallest gap (negative when the surface already pokes into the part).
 */
export function fitDepth(underside, surface, { fraction = 0.3 } = {}) {
  const { min, max } = underside.bounds;
  const width = max[0] - min[0];
  const height = max[1] - min[1];
  const tall = max[2] - min[2];
  const empty = { lower: 0, push: 0, reachable: false, firstContact: NaN, cells: 0, covered: 0 };
  if (!(width > 0 && height > 0 && tall > 0)) return empty;
  let cell = Math.max(0.4, Math.min(width, height) / 24);
  cell = Math.max(cell, width / (MAX_GRID - 1), height / (MAX_GRID - 1));
  const us = [];
  const gaps = [];
  let covered = 0;
  for (let y = min[1] + cell / 2; y < max[1]; y += cell) {
    for (let x = min[0] + cell / 2; x < max[0]; x += cell) {
      const u = underside.heightAt(x, y);
      if (!Number.isFinite(u)) continue;
      covered++;
      const h = surface.heightAt(x, y);
      if (!Number.isFinite(h)) continue;
      us.push(u);
      gaps.push(u - h);
    }
  }
  if (!gaps.length) return { ...empty, covered };
  let firstContact = Infinity;
  let uMin = Infinity;
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i] < firstContact) firstContact = gaps[i];
    if (us[i] < uMin) uMin = us[i];
  }
  const lower = Math.max(0, firstContact);
  if (lower > tall) return { lower, push: 0, reachable: false, firstContact, cells: gaps.length, covered };
  // what a further push may close in each cell: the part's recess there, but no more than the gap still open
  const closable = new Float64Array(gaps.length);
  for (let i = 0; i < gaps.length; i++) closable[i] = Math.max(0, Math.min(us[i] - uMin, gaps[i] - lower));
  closable.sort();
  const push = Math.min(closable[Math.min(closable.length - 1, Math.floor(fraction * closable.length))], Math.max(0, tall - lower));
  return { lower, push, reachable: true, firstContact, cells: gaps.length, covered };
}
