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
    normalAround(p, ref, radius) {
      if (!bvh) return null;
      const c = q.set(p[0], p[1], p[2]).applyMatrix4(placement);
      const r = dir.set(ref[0], ref[1], ref[2]).transformDirection(placement);
      const r2 = radius * radius;
      const near = []; // [nx, ny, nz, area] of the triangles reaching into the disc
      const nn = new Vector3();
      const closest = new Vector3();
      bvh.shapecast({
        intersectsBounds: (box) => box.distanceToPoint(c) <= radius,
        intersectsTriangle: (t) => {
          t.closestPointToPoint(c, closest);
          if (closest.distanceToSquared(c) > r2) return false;
          t.getNormal(nn);
          near.push(nn.x, nn.y, nn.z, t.getArea());
          return false;
        },
      });
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
 * One step of length ds from p heading d, within the walk's plane (normal `plane`): the surface is met straight
 * under the point ds ahead along the way it faces around p (its normal averaged over `smooth` mm, so bumps smaller
 * than that neither steer the walk nor lengthen it). Returns { p, n } with n the surface's averaged normal there; null
 * where the surface ends within the step or turns sharply (an edge, a ledge, the rim of a sheet); AWAY_FROM_TEXT where
 * it curves on round the back further than text may wrap.
 */
function stepOver(sampler, p, n, d, ds, plane, smooth) {
  const m = inPlane(n, plane);
  if (!m) return null;
  let ahead = unit3(cross3(plane, m));
  if (!ahead) return null;
  if (dot3(ahead, d) < 0) ahead = [-ahead[0], -ahead[1], -ahead[2]];
  const target = along(p, ahead, ds);
  // the surface is met along the way it faces at the point ahead, not at p: a lump between them then moves the point
  // up or down, not along the line, and the steps stay even
  const there = inPlane(sampler.normalAround(target, n, smooth) ?? n, plane);
  const mt = there && dot3(there, m) > SHARP ? there : m;
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
  if (!best) return null;
  const around = sampler.normalAround(best.p, n, smooth) ?? best.n;
  if (dot3(around, n) < SHARP) return null;
  if (around[2] < AWAY) return AWAY_FROM_TEXT;
  return { p: best.p, n: around, d: ahead };
}

/** stepOver's answer where the surface curves on round the back, past what the text may wrap. */
const AWAY_FROM_TEXT = Object.freeze({ away: true });

/**
 * The surface under a point carried past an edge: of the surfaces crossed along -n (kept in the walk's plane) within
 * `jump` either side of the point, the one facing the text's way nearest it (the far side of a slot, the top of a
 * ledge, the floor below a step), with its averaged normal.
 */
function landAt(sampler, c, n, jump, plane, smooth) {
  const m = inPlane(n, plane) ?? n;
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
  return { p: best.p, n: around };
}

/**
 * Walk `count` steps of length ds over the surface from `start` ({ p, n, on, lost }) heading d, within the plane
 * through the start with normal `plane`, calling emit(k, p, n, d, on, sharp, lost) after each. Smooth curvature is
 * wrapped round; at a sharp turn the walk carries on straight and lands on the surface it finds there (`sharp` is
 * then set), or carries on in the air (`on` false) where there is none, trying to land again at every step. `lost`
 * says why the walk left the surface: EDGE (the text hangs over an edge) or ROUND_THE_BACK (the surface curves on
 * round the back, further than text may wrap).
 */
function walk(sampler, start, d, count, ds, jump, emit, plane, smooth) {
  let { p, n, on, lost = 0 } = start;
  d = inPlane(d, plane) ?? d;
  for (let k = 1; k <= count; k++) {
    let next = on ? stepOver(sampler, p, n, d, ds, plane, smooth) : null;
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
    // the heading: along the surface within the plane, onward
    let ahead = next.d ?? (inPlane(next.n, plane) && unit3(cross3(plane, inPlane(next.n, plane))));
    if (!ahead) ahead = d;
    else if (dot3(ahead, d) < 0) ahead = [-ahead[0], -ahead[1], -ahead[2]];
    // the heading for the next step follows the surface at the new point
    const m = inPlane(next.n, plane);
    if (m) {
      const t = unit3(cross3(plane, m));
      if (t) ahead = dot3(t, ahead) < 0 ? [-t[0], -t[1], -t[2]] : t;
    }
    d = ahead;
    p = next.p;
    n = next.n;
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
function walkChart(sampler, { nx, ny, i0, j0, cell, jump, seed, smooth, chord = smooth }) {
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
  // the reading line stays in the plane through the clicked point spanned by the reading direction and the normal:
  // seen from where the text was placed it runs straight, however the surface undulates under it
  const spine = [0, 1, 0];
  const n0 = sampler.normalAround(seed.p, seed.n, smooth) ?? seed.n;
  set(j0 * nx + i0, seed.p, n0, true, false);
  const x = inPlane([1, 0, 0], unit3(n0) ?? [0, 0, 1]) ?? [1, 0, 0];
  heading[i0] = x;
  const start = { p: seed.p, n: n0, on: true };
  walk(sampler, start, x, nx - 1 - i0, cell, jump, (k, p, n, d, o, sh, why) => {
    set(j0 * nx + i0 + k, p, n, o, sh, why);
    heading[i0 + k] = d;
  }, spine, smooth);
  walk(sampler, start, [-x[0], -x[1], -x[2]], i0, cell, jump, (k, p, n, d, o, sh, why) => {
    set(j0 * nx + i0 - k, p, n, o, sh, why);
    heading[i0 - k] = [-d[0], -d[1], -d[2]];
  }, spine, smooth);
  // each column stays in the plane across the reading line there, its direction taken as the chord over `chord` mm
  // either side: on a circle that chord is exactly the tangent at its middle, while the tilt of lumps shorter than it
  // averages out, so a lump under one node does not lean its column into its neighbours
  const span = Math.max(1, Math.round(chord / cell));
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
    walk(sampler, from, up, ny - 1 - j0, cell, jump, (m, q, nn, d, o, sh, why) => set((j0 + m) * nx + i, q, nn, o, sh, why), across, smooth);
    walk(sampler, from, [-up[0], -up[1], -up[2]], j0, cell, jump, (m, q, nn, d, o, sh, why) => set((j0 - m) * nx + i, q, nn, o, sh, why), across, smooth);
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
  // a grid with a node at the origin, covering the footprint and a margin
  let cell = options.cell ?? Math.max(0.4, Math.min(width, height) / 12);
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
  const jump = Math.max(3, 0.6 * Math.min(width, height), 6 * cell);
  // bumps smaller than about a quarter of the letters' height are texture the text lies over, not a shape it follows
  const smooth = Math.min(4, Math.max(1, 0.25 * Math.min(width, height)));
  const chord = Math.max(smooth, 0.5 * Math.min(width, height));
  const { P, W, on, sharp, lost } = walkChart(sampler, { nx, ny, i0, j0, cell, jump, smooth, chord, seed: { p: [0, 0, z0], n: [0, 0, 1] } });
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

  // statistics behind the notes, over the nodes under the slab's footprint
  const inside = (i, j) => {
    const x = x0 + i * cell, y = y0 + j * cell;
    return x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1];
  };
  const buriedAt = (p) => sampler.castAll(p, [0, 0, 1], 1e4).length % 2 === 1; // an odd number of crossings above: inside
  let misses = 0;
  let buried = 0;
  let roundTheBack = 0;
  let squeezed = 0;
  let footprint = 0;
  let sum = 0;
  let count = 0;
  let lo = Infinity;
  let hi = -Infinity;
  let maxSlope = 0;
  let rMin = Infinity;
  let pairs = 0; // neighbouring nodes under the slab, both on the surface
  let edgePairs = 0; // ... with a ledge, a slot or a sharp turn between them
  let steepPairs = 0; // ... stretched or squeezed apart along the surface
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
        if (lost[k] === ROUND_THE_BACK) roundTheBack++;
        else if (under && buriedAt(pt(k))) buried++;
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
        if (turn > Math.PI / 6) continue;
        const stretch = run / cell; // along the surface: bumps between the nodes are not stretch
        if (stretch > 1.3 || stretch < 0.75) steepPairs++;
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
  // an edge runs across the text: a line of jumps, not a stray one where the surface is rough; stretching shows over
  // more than a few nodes
  const crossesEdge = edgePairs >= Math.max(3, 0.3 * rowsUnder.size);
  const steep = steepPairs > 0.02 * Math.max(1, pairs);
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
    missFraction: (misses - buried - roundTheBack) / N,
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
    steep,
    wrapDeg,
    wrapsAround: roundTheBack > 0.02 * N,
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
  if (options.wrap !== false && sampler.closest && sampler.castAll && sampler.hitsAt) {
    const wrapped = wrapSolid(flatSolid, sampler, { min, max, width, height, flatTolerance, reach, wallLimit, options, result });
    if (wrapped) return wrapped;
  }

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
