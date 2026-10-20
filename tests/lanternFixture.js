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
 * A binary STL file as a slicer reads it, its float32 corners matched exactly: as `stlCheck`, of the file itself.
 * @param {ArrayBuffer} buf
 */
export function stlFileCheck(buf) {
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  const edges = new Map();
  let degenerate = 0;
  for (let t = 0; t < n; t++) {
    const k = [0, 1, 2].map((j) => [0, 1, 2].map((a) => dv.getFloat32(84 + t * 50 + 12 + (j * 3 + a) * 4, true)).join(','));
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
 * (twice the deepest inset), length and height. Parts under 0.01 mm² are left out. With `besides` (another solid,
 * the same piece without what was added to it), what overhangs there at the same layer is left out too: only the
 * overhangs the addition makes.
 */
export function overhangs(solid, z0, z1, step = 0.2, tol = 0.02, besides = null) {
  const out = [];
  const overAt = (m, below, z) => {
    const cur = m.slice(z);
    const grown = below.offset(step + tol, 'Round', 2, 32);
    const over = cur.subtract(grown);
    grown.delete();
    return { cur, over };
  };
  let below = solid.slice(z0);
  let other = besides?.slice(z0) ?? null;
  for (let z = z0 + step; z <= z1 + 1e-9; z += step) {
    const { cur, over: own } = overAt(solid, below, z);
    let over = own;
    if (besides) {
      const theirs = overAt(besides, other, z);
      over = own.subtract(theirs.over);
      own.delete();
      theirs.over.delete();
      other.delete();
      other = theirs.cur;
    }
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
    over.delete();
    below.delete();
    below = cur;
  }
  below.delete();
  other?.delete();
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

/**
 * A round Gothic lantern like the user's: a plinth (r 50 to z 5, r 47.5 to 8.5), a fretwork body – a tube r 45, 3 mm
 * walls, from z 8 to 148, two tiers of 12 pointed windows 10 wide (z 20–58 and 80–116, their tips 8.66 higher) and a
 * row of 12 round holes between – an eave ring r `eaveR` from 148 to 152 (none when `eaveR` is 0, the dome then on
 * the body), a hollow dome r `domeR` (3 mm) on it, spikes round its rim, a columned cap with a finial on top and an
 * arched handle on two bosses. `seg` sides to every circle. With no eave, a dome wider than the body's walls (`domeR`
 * 49) stands on the body's top edge without touching it: a roof modelled as a shell of its own.
 */
export function roundLanternSolid({ seg = 96, eaveR = 50, domeR = 47 } = {}) {
  const { Manifold, CrossSection } = manifold();
  const temps = [];
  const t = (m) => {
    temps.push(m);
    return m;
  };
  try {
    const cyl = (r0, r1, z0, z1, n = seg) => t(t(Manifold.cylinder(z1 - z0, r0, r1, n)).translate([0, 0, z0]));
    const b = (min, max) => t(box(min, max));
    const parts = [cyl(50, 50, 0, 5), cyl(47.5, 47.5, 5, 8.5)];
    let body = t(cyl(45, 45, 8, 148).subtract(cyl(42, 42, 7.9, 148.1)));
    // a pointed window: two circles of its width's radius either side of its middle, springing at z1
    const lancet = (z0, z1) => {
      const arc = (y) => t(t(t(Manifold.cylinder(40, 10, 10, 48, true)).rotate([0, 90, 0])).translate([45, y, z1]));
      const arch = t(t(arc(5).intersect(arc(-5))).intersect(b([30, -10, z1], [60, 10, z1 + 10])));
      return t(b([30, -5, z0], [60, 5, z1]).add(arch));
    };
    const cutters = [];
    for (let k = 0; k < 12; k++) {
      cutters.push(t(lancet(20, 58).rotate([0, 0, k * 30])), t(lancet(80, 116).rotate([0, 0, k * 30])));
      cutters.push(t(t(t(t(Manifold.cylinder(40, 3.5, 3.5, 24, true)).rotate([0, 90, 0])).translate([45, 0, 73])).rotate([0, 0, k * 30 + 15])));
    }
    body = t(body.subtract(t(Manifold.union(cutters))));
    parts.push(body);
    const foot = eaveR ? 152 : 148; // where the dome stands
    if (eaveR) parts.push(t(cyl(eaveR, eaveR, 148, 152).subtract(cyl(42, 42, 147.9, 152.1))));
    const dome = t(t(t(Manifold.sphere(domeR, seg)).translate([0, 0, foot])).subtract(t(t(Manifold.sphere(domeR - 3, seg)).translate([0, 0, foot]))));
    parts.push(t(dome.intersect(b([-60, -60, foot], [60, 60, 260]))));
    const ring = eaveR ? eaveR - 2.2 : domeR - 1.5;
    for (let k = 0; k < 16; k++) {
      const a = (2 * Math.PI * k) / 16;
      parts.push(t(t(Manifold.cylinder(14, 2, 0.3, 24)).translate([ring * Math.cos(a), ring * Math.sin(a), foot])));
    }
    // the cap on the dome's top: a plinth, six columns, a cap disc, a dome and a finial
    const top = foot + domeR;
    parts.push(cyl(11, 11, top - 3, top + 1.5, 48));
    for (let k = 0; k < 6; k++) parts.push(t(t(Manifold.cylinder(10, 1.6, 1.6, 16)).translate([8 * Math.cos((k * Math.PI) / 3), 8 * Math.sin((k * Math.PI) / 3), top + 1.4])));
    parts.push(cyl(12, 12, top + 11.3, top + 14.5, 48));
    parts.push(t(t(t(Manifold.sphere(8, 48)).translate([0, 0, top + 14.4])).intersect(b([-9, -9, top + 14.4], [9, 9, top + 23]))));
    parts.push(t(t(Manifold.cylinder(18, 2.6, 0.4, 24)).translate([0, 0, top + 21])));
    // the handle: two bosses on the dome and an arch over the cap
    const boss = foot + Math.sqrt(domeR * domeR - 34 * 34);
    for (const x of [-34, 34]) parts.push(t(cyl(5, 5, boss - 3.4, boss + 5.1, 32).translate([x, 0, 0])));
    const tube = t(t(CrossSection.circle(3.2, 24)).translate([34, 0]));
    parts.push(t(t(t(Manifold.revolve(tube, 64, 180)).rotate([90, 0, 0])).translate([0, 0, boss + 5])));
    return Manifold.union(parts);
  } finally {
    for (const m of temps) m.delete();
  }
}

/**
 * A slender square lantern: a 70 × 70 tower (3 mm walls, a 4 mm floor) up to z 230 with two windows 16 wide a side
 * from z 40 to 190, eaves 80 × 80 from 230 to 234 and a hollow hipped roof (5 mm) up to a flat top 40 × 40 at 262,
 * closed. Its top would stand on that small flat roof to carry a lip, 220 mm tall.
 */
export function slenderTowerSolid() {
  const { Manifold } = manifold();
  const temps = [];
  const t = (m) => {
    temps.push(m);
    return m;
  };
  try {
    const b = (min, max) => t(box(min, max));
    let tower = t(b([-35, -35, 0], [35, 35, 230]).subtract(b([-32, -32, 4], [32, 32, 231])));
    const windows = [];
    for (const x of [-17.5, 17.5]) windows.push(b([x - 8, -40, 40], [x + 8, 40, 190]), b([-40, x - 8, 40], [40, x + 8, 190]));
    tower = t(tower.subtract(t(Manifold.union(windows))));
    const eaves = t(b([-40, -40, 230], [40, 40, 234]).subtract(b([-32, -32, 229], [32, 32, 235])));
    const frustum = (s0, s1, z0, z1) => t(Manifold.hull([[-s0, -s0, z0], [s0, -s0, z0], [s0, s0, z0], [-s0, s0, z0], [-s1, -s1, z1], [s1, -s1, z1], [s1, s1, z1], [-s1, s1, z1]]));
    const roof = t(frustum(40, 20, 234, 262).subtract(frustum(35, 15, 233.99, 258)));
    return Manifold.union([tower, eaves, roof]);
  } finally {
    for (const m of temps) m.delete();
  }
}

/**
 * A small bat lantern like the user's, at its 100 % size (25 × 25 × 50 mm): a solid base disc with a recessed band
 * (r 10, 9.35 from z 1 to 4.5, 10.3 from 4.5 to 6.6) on 8 feet, a floor cup, 8 posts to z 26, a 1.5 mm ring band, a
 * conical dome shell 30° from horizontal (0.6 mm thick square to it) from the band to a flange, a cupola of 12 columns
 * with a spire to z 38.7, 8 spires on the band and a handle in the XZ plane: two legs whose feet bend in and fuse into
 * the dome's outside at r 7.75–9.3, z 27.9–28.9, a boss on each and an arch over the cap to its crown at z 50. One
 * shell, genus 26, 8,004 triangles. The lid that leaves the handle on is the dome and cap over z ≈ 29 inside r ≈ 7.9.
 */
export function batLanternSolid({ seg = 96 } = {}) {
  const { Manifold, CrossSection } = manifold();
  const temps = [];
  const t = (m) => {
    temps.push(m);
    return m;
  };
  try {
    const parts = [];
    const cyl = (h, r1, r2 = r1, z = 0) => t(t(Manifold.cylinder(h, r1, r2, seg)).translate([0, 0, z]));
    const tube = (h, rin, rout, z) => t(cyl(h, rout, rout, z).subtract(cyl(h + 0.02, rin, rin, z - 0.01)));
    const b = (min, max) => t(box(min, max));
    const rev = (pts) => {
      const cs = t(new CrossSection(pts, 'Positive'));
      return t(cs.revolve(seg));
    };
    // the base and the 8 feet under the posts
    parts.push(cyl(1, 10.0), cyl(3.5, 9.35, 9.35, 1), cyl(2.1, 10.3, 10.3, 4.5));
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      parts.push(t(b([-1.2, -1.2, 0], [1.2, 1.2, 6.6]).translate([11.3 * Math.cos(a), 11.3 * Math.sin(a), 0])));
    }
    parts.push(tube(1.95, 3.3, 4.3, 6.55));
    // the posts, every other one wider
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const w = k % 2 ? 2.8 : 1.5;
      parts.push(t(t(b([-w / 2, -w / 2, 6.5], [w / 2, w / 2, 26]).rotate([0, 0, (a * 180) / Math.PI])).translate([10.6 * Math.cos(a), 10.6 * Math.sin(a), 0])));
    }
    parts.push(tube(1.5, 9.1, 10.45, 25.9));
    // the dome: a conical shell from the band (z 27.3, r 10.1 outside) to the flange (z 30.05, r 5.3), 1.25 mm across
    parts.push(rev([[10.1 - 1.25 - 0.6, 27.3], [10.1, 27.3], [5.3, 30.05], [5.3 - 1.25, 30.05]]));
    // the flange and the cupola: 12 columns, a roof cone, a drum and the spire
    parts.push(tube(0.7, 3.3, 5.5, 30.0));
    for (let k = 0; k < 12; k++) parts.push(t(t(b([-0.5, -0.58, 30.6], [0.5, 0.58, 32.5]).translate([3.6, 0, 0])).rotate([0, 0, k * 30])));
    parts.push(rev([[0, 32.45], [4.35, 32.45], [4.35, 32.8], [1.9, 34.5], [1.4, 34.5], [1.4, 36.3], [0.9, 36.3], [0, 38.7]]));
    // 8 spires on the band, their tips at z 29.4 (between the axes) and 30 (on them)
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const r = k % 2 ? 10.9 : 10.6;
      const top = k % 2 ? 29.4 : 30.0;
      parts.push(t(t(Manifold.cylinder(top - 27.0, 0.8, 0.05, 16)).translate([r * Math.cos(a), r * Math.sin(a), 27.0])));
    }
    // the handle: legs at x ±(9.65–10.5), y ±1.15, z 28.9–41.2, their feet bent in onto the dome; a boss Ø 2.4 on
    // each at z 31.6; the arch from z 41 to its crown at z 50, 0.85 thick
    for (const sx of [-1, 1]) {
      const leg = b([9.65, -1.15, 28.9], [10.5, 1.15, 41.2]);
      const foot = t(Manifold.hull([b([9.65, -1.15, 28.9], [10.5, 1.15, 29.6]), b([7.75, -1.15, 27.9], [9.3, 1.15, 28.5])]));
      const boss = t(t(Manifold.sphere(1.2, 24)).translate([11.0, 0, 31.6]));
      const one = t(Manifold.union([leg, foot, boss]));
      parts.push(sx > 0 ? one : t(one.mirror([1, 0, 0])));
    }
    const ring = t(t(t(CrossSection.circle(10.5, seg)).subtract(t(CrossSection.circle(9.65, seg)))).intersect(t(t(CrossSection.square([22, 11])).translate([-11, 0]))));
    parts.push(t(t(t(t(t(ring.extrude(2.3)).translate([0, 0, -1.15])).rotate([90, 0, 0])).scale([1, 1, 9 / 10.5])).translate([0, 0, 41])));
    // worked out while its parts are still held, as the lantern was measured: let go first, the union batches its
    // booleans another way and the same solid comes out in 8,008 triangles
    const solid = Manifold.union(parts);
    solid.numTri();
    return solid;
  } finally {
    for (const m of temps) m.delete();
  }
}
