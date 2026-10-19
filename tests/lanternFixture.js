// Models and measures for the cuts that come apart: a lantern whose top lifts off to change its light, a Gothic one
// closer to a real print, and the checks a slicer and a printer would make of the pieces. Call setup() first.
import { manifold } from '../src/manifold.js';

/** A box from min to max (mm). */
export function box(min, max) {
  return manifold().Manifold.cube(max.map((v, a) => v - min[a])).translate(min);
}

/**
 * The lantern: a hollow square tower 100 × 100 × 200 (4 mm walls and floor), two windows 30 × 120 on each side
 * (z 40–160), corner posts 8 × 8 standing out of the corners from z 150 to 200 (with `gargoyles`), a hollow pyramid
 * roof (a 4 mm shell, 110 × 110 at its eaves on z 200, its apex at 260) open to the tower, and a ring handle standing
 * on the apex. 291 mm tall, genus 8, 808 triangles; its face at z 190 is one 1,728 mm² ring.
 */
export function lanternSolid({ gargoyles = true } = {}) {
  const { Manifold } = manifold();
  const temps = [];
  const t = (m) => {
    temps.push(m);
    return m;
  };
  try {
    const parts = [];
    let tower = t(t(box([-50, -50, 0], [50, 50, 200])).subtract(t(box([-46, -46, 4], [46, 46, 201]))));
    const windows = [];
    for (const x of [-22.5, 22.5]) {
      windows.push(t(box([x - 15, -60, 40], [x + 15, 60, 160])));
      windows.push(t(box([-60, x - 15, 40], [60, x + 15, 160])));
    }
    tower = t(tower.subtract(t(Manifold.union(windows))));
    parts.push(tower);
    if (gargoyles) {
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) parts.push(t(box([sx > 0 ? 46 : -54, sy > 0 ? 46 : -54, 150], [sx > 0 ? 54 : -46, sy > 0 ? 54 : -46, 200])));
      }
    }
    // the roof's inside parallel to its outside, 4 mm in along the normal, and open to the tower below
    const pyramid = (half, z0, h) => Manifold.hull([[-half, -half, z0], [half, -half, z0], [half, half, z0], [-half, half, z0], [0, 0, z0 + h]]);
    const slope = 60 / 55;
    const drop = 4 * Math.sqrt(1 + 1 / (slope * slope)) * slope;
    const inside = t(t(pyramid(55, 200 - drop, 60)).intersect(t(box([-60, -60, 199.999], [60, 60, 300]))));
    parts.push(t(t(pyramid(55, 200, 60)).subtract(inside)));
    const ring = t(t(Manifold.cylinder(6, 21, 21, 64, true)).subtract(t(Manifold.cylinder(7, 15, 15, 64, true))));
    parts.push(t(t(ring.rotate([90, 0, 0])).translate([0, 0, 270])));
    return Manifold.union(parts);
  } finally {
    for (const m of temps) m.delete();
  }
}

/**
 * A Gothic lantern: 110 mm square, 3 mm fretwork walls (16 windows a side), 10 mm corner posts, gargoyles at the
 * corners from z 150 to 162, a stepped roof from its ceiling at z 170 (`roof` 'solid', or 'hollow': 4 mm shells closed
 * at 194) and a handle; `band` thickens the walls from z 140 to 170.
 */
export function gothicSolid({ band = 3, roof = 'solid', gargoyles = true } = {}) {
  const { Manifold } = manifold();
  const temps = [];
  const t = (m) => {
    temps.push(m);
    return m;
  };
  const b = (min, max) => t(box(min, max));
  try {
    const parts = [];
    let tower = t(b([-55, -55, 0], [55, 55, 170]).subtract(b([-52, -52, 4], [52, 52, 171])));
    if (band > 3) tower = t(tower.add(t(b([-55, -55, 140], [55, 55, 170]).subtract(b([-55 + band, -55 + band, 139], [55 - band, 55 - band, 171])))));
    const windows = [];
    for (const u of [-30, -10, 10, 30]) {
      for (const z of [20, 50, 80, 110]) windows.push(b([u - 6, -60, z], [u + 6, 60, z + 24]), b([-60, u - 6, z], [60, u + 6, z + 24]));
    }
    parts.push(t(tower.subtract(t(Manifold.union(windows)))));
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        parts.push(b([sx > 0 ? 45 : -55, sy > 0 ? 45 : -55, 0], [sx > 0 ? 55 : -45, sy > 0 ? 55 : -45, 170]));
        if (gargoyles) parts.push(b([sx > 0 ? 50 : -62, sy > 0 ? 50 : -62, 150], [sx > 0 ? 62 : -50, sy > 0 ? 62 : -50, 162]));
      }
    }
    if (roof === 'solid') {
      parts.push(b([-60, -60, 170], [60, 60, 174]), b([-50, -50, 174], [50, 50, 184]), b([-40, -40, 184], [40, 40, 194]), b([-20, -20, 194], [20, 20, 206]));
    } else {
      parts.push(t(b([-60, -60, 170], [60, 60, 174]).subtract(b([-46, -46, 169], [46, 46, 175]))));
      parts.push(t(b([-50, -50, 174], [50, 50, 184]).subtract(b([-46, -46, 173], [46, 46, 185]))));
      parts.push(t(b([-46, -46, 184], [46, 46, 186]).subtract(b([-36, -36, 183], [36, 36, 187]))));
      parts.push(t(b([-40, -40, 186], [40, 40, 194]).subtract(b([-36, -36, 185], [36, 36, 190]))));
      parts.push(b([-20, -20, 194], [20, 20, 206]));
    }
    parts.push(b([-18, -3, 206], [-12, 3, 236]), b([12, -3, 206], [18, 3, 236]), b([-18, -3, 230], [18, 3, 236]));
    return Manifold.union(parts);
  } finally {
    for (const m of temps) m.delete();
  }
}

/** The volume two solids share (mm³), `b` moved by `d` first. */
export function lift(a, b, d = [0, 0, 0]) {
  const moved = b.translate(d);
  const both = a.intersect(moved);
  try {
    return both.volume();
  } finally {
    both.delete();
    moved.delete();
  }
}

/**
 * A solid's STL as a file holds it: triangles with two corners the same in float32 (`degenerate`), and edges not
 * met exactly once each way (`open`). A clean piece has none of either.
 */
export function stlCheck(solid) {
  const { vertProperties: P, numProp: n, triVerts: T } = solid.getMesh();
  const f = new Float32Array(1);
  const key = (v) => [0, 1, 2].map((a) => {
    f[0] = P[v * n + a];
    return f[0];
  }).join(',');
  const edges = new Map();
  let degenerate = 0;
  for (let t = 0; t < T.length; t += 3) {
    const k = [key(T[t]), key(T[t + 1]), key(T[t + 2])];
    if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) degenerate++;
    for (let i = 0; i < 3; i++) edges.set(`${k[i]}|${k[(i + 1) % 3]}`, (edges.get(`${k[i]}|${k[(i + 1) % 3]}`) ?? 0) + 1);
  }
  let open = 0;
  for (const [e, c] of edges) if (c !== 1 || edges.get(e.split('|').reverse().join('|')) !== 1) open++;
  return { degenerate, open };
}

/**
 * Overhangs as a slicer sees them, the solid printed with +z up: sliced every `step` from z0 to z1, what of each
 * slice lies further than `step + tol` out from the slice below, as parts with their area, narrowest width
 * (twice the deepest inset), length and height. Parts under 0.01 mm² are left out.
 */
export function overhangs(solid, z0, z1, step = 0.2, tol = 0.02) {
  const out = [];
  let below = solid.slice(z0);
  for (let z = z0 + step; z <= z1 + 1e-9; z += step) {
    const cur = solid.slice(z);
    const grown = below.offset(step + tol, 'Round', 2, 32);
    const over = cur.subtract(grown);
    for (const part of over.decompose()) {
      const area = part.area();
      if (area >= 0.01) {
        let lo = 0;
        let hi = 20;
        for (let i = 0; i < 20; i++) {
          const mid = (lo + hi) / 2;
          const inset = part.offset(-mid, 'Round', 2, 16);
          if (inset.isEmpty()) hi = mid;
          else lo = mid;
          inset.delete();
        }
        const b = part.bounds();
        out.push({ z: +z.toFixed(2), area: +area.toFixed(2), width: +(2 * lo).toFixed(2), long: +Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]).toFixed(1) });
      }
      part.delete();
    }
    grown.delete();
    over.delete();
    below.delete();
    below = cur;
  }
  below.delete();
  return out;
}

/**
 * A box with a lid that overhangs it: a 100 × 100 box with 4 mm walls and floor, up to z 50.5, and a lid 102 × 102 from
 * z 50 to 60, closed 4 mm thick at the top (the hollow runs up to 56). Its seam, where the outline widens, is z 50.
 */
export function lidBoxSolid() {
  const parts = [box([-50, -50, 0], [50, 50, 50.5]), box([-51, -51, 50], [51, 51, 60])];
  const hollow = box([-46, -46, 4], [46, 46, 56]);
  try {
    const outside = parts[0].add(parts[1]);
    try {
      return outside.subtract(hollow);
    } finally {
      outside.delete();
    }
  } finally {
    [...parts, hollow].forEach((m) => m.delete());
  }
}

/**
 * A tower whose middle is a loggia of four hollow corner posts: a 120 mm square with 4 mm walls and floor up to z 100,
 * four posts 56 mm square from z 99 to 181 (4 mm walls, 6 mm from z 140), a band like the tower from z 180 to 230 and a
 * hollow pyramid roof (128 mm at its eaves on z 230, 4 mm thick, apex at 290). A cut through the loggia runs through
 * four separate posts.
 */
export function loggiaSolid() {
  const { Manifold } = manifold();
  const temps = [];
  const t = (m) => {
    temps.push(m);
    return m;
  };
  try {
    const ring = (h, z0, z1) => t(t(box([-h, -h, z0], [h, h, z1])).subtract(t(box([-h + 4, -h + 4, z0 - 1], [h - 4, h - 4, z1 + 1]))));
    const parts = [t(box([-60, -60, 0], [60, 60, 4])), ring(60, 2, 100), ring(60, 180, 230)];
    for (const x0 of [-60, 4]) {
      for (const y0 of [-60, 4]) {
        const post = (z0, z1, w) => t(t(box([x0, y0, z0], [x0 + 56, y0 + 56, z1])).subtract(t(box([x0 + w, y0 + w, z0 - 1], [x0 + 56 - w, y0 + 56 - w, z1 + 1]))));
        parts.push(post(99, 141, 4), post(140, 181, 6));
      }
    }
    const pyramid = (half, z0, h) => t(Manifold.hull([[-half, -half, z0], [half, -half, z0], [half, half, z0], [-half, half, z0], [0, 0, z0 + h]]));
    parts.push(t(pyramid(64, 230, 60).subtract(pyramid(60, 226, 60))));
    return Manifold.union(parts);
  } finally {
    for (const m of temps) m.delete();
  }
}
