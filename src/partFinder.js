/**
 * Finding the parts of a model that come off, from its slices alone: a lid
 * inside a circle on a planar face (the dome and cap inside a handle's legs,
 * a roof, a cap) and a base that twists off from underneath (a plug through a
 * solid bottom). No boolean of the whole model is made, so the suggestions
 * come in a second or two on a model of a million triangles; the exact carve
 * happens once the user takes one.
 *
 * The model is sliced across its height (`PART_LEVELS` levels whatever its
 * size, so a part is found the same at every scale) and each slice split into
 * islands, joined level to level where they overlap: a graph whose loops are
 * handles and bails. About the model's axis, and the centre of every sizeable
 * hole for lids off the axis, a circle of radius R is free at a level when no
 * island there crosses it. A lid's face is a level where the circle holds
 * material and stays free up to its cap, the first level where its disc is
 * empty. Each lid found is put on the printer's layers – the lowest face whose
 * rim prints apart from the body beside it – and sized for a twist-lock; its
 * way out is found on slices, and the least scale a lock (and a tea light)
 * needs is worked out from the same slices. A base comes from the floor under
 * the model's inside.
 *
 * What `findParts` returns is plain data (it crosses from the worker): the
 * card of suggestions and the pick mode's hover (`pickPart`) read it without
 * the engine. Every length is in mm of the model as it is now, z up; a
 * least scale is a factor on the model as it is now.
 */
import { manifold } from './manifold.js';
import { collarFor, collarReach, collarSlope, leastScale, plugAt, plugDims, plugFor, scalePercent, sizes, takesTeaLight } from './locks.js';

/** The levels the model is sliced at across its height, at the middle of each step. */
export const PART_LEVELS = 240;
/** Islands smaller than this share of the model's width, squared, are specks of the mesh, not material. */
export const SPECK = 1 / 400;
/** A hole this share of its island's outline or more may be an opening with a lid over it. */
const HOLE_SHARE = 0.05;
/** Hole centres are put on a grid of the model's width over this, and two closer than this share of it are one. */
const CENTRE_GRID = 400;
const CENTRE_SAME = 0.01;
/** At most this many hole centres are tried besides the axis, the largest holes first. */
const CENTRES = 8;
/** What lies over a lid inside its circle covers this share of it at most: more, and the lid is inside the model. */
export const COVER_MOST = 1 / 3;
/** A lid holds this share of the model's volume at least, and its face this share of the largest lid's face. */
const LID_VOLUME = 0.005;
const LID_FACE = 0.05;
/** The opening under a lid leads this share of the model's height down at least (or its own width, if less). */
const LEADS = 0.1;
/** An open top is this share of the model's width across at least: a hanging hole or a vent is no open top. */
const OPEN_SHARE = 0.2;
/** What stands on a base's floor and comes away with it is this share of the model's volume at most. */
const PLUG_MOST = 1 / 3;
/** One lid at several faces: caps this many levels apart at most, centres this share of the width. */
const FAMILY_LEVELS = 2;
const FAMILY_CENTRE = 0.05;
/** Lids taken further than the candidates: the largest this many. */
const LIDS = 4;
/**
 * A loop in the graph is a handle (or a bail) when its top is a bar under this share of the largest slice, its arms
 * stand this share of the width apart, its top is in this top share of the height and it is this share of it tall.
 */
const HANDLE_BAR = 0.05;
const HANDLE_ARMS = 0.1;
const HANDLE_TOP = 0.25;
const HANDLE_TALL = 0.05;
/**
 * The way out: the lid's slices and its lifts are this share of the model's height apart, its first lift without a
 * lock this share; it slides out in this many directions, and lifted further than this share it is not coming out.
 */
export const WAY_STEP = 1 / 200;
export const WAY_START = 1 / 250;
const WAY_DIRS = 16;
const WAY_MOST = 0.3;
/** A face's fine slices reach this far over it (mm); the levels take over above. */
export const FINE_REACH = 1;
/** Fine slices are taken this far (mm) over the heights they stand for, off any flat face of the model there. */
export const OVER = 1e-4;
/** Fine slices keep islands of this share of a speck and more: a sliver at the face would close a window. */
export const FINE_SPECK = 0.01;
/** The least scale is looked for up to this many times the model's size now, and checked this many 5 % steps up. */
const LEAST_MOST = 6;
const LEAST_TRIES = 4;

/** Collects temporaries so they are all deleted, even when something throws (the engine's pattern). */
function scope() {
  const items = [];
  return {
    add(m) {
      items.push(m);
      return m;
    },
    dispose() {
      for (const m of items) m?.delete?.();
      items.length = 0;
    },
  };
}

// ---------- islands ----------

/** A ring's points as one flat array, x and y in turn. */
function flatRing(points) {
  const a = new Float64Array(points.length * 2);
  points.forEach(([x, y], i) => {
    a[2 * i] = x;
    a[2 * i + 1] = y;
  });
  return a;
}

/** A flat ring's area, signed: positive for an outline (anticlockwise), negative for a hole. */
function ringArea(a) {
  let s = 0;
  for (let i = 0, n = a.length; i < n; i += 2) {
    const j = i + 2 === n ? 0 : i + 2;
    s += a[i] * a[j + 1] - a[j] * a[i + 1];
  }
  return s / 2;
}

/** A flat ring's centroid. */
function ringCentroid(a) {
  let s = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = a.length; i < n; i += 2) {
    const j = i + 2 === n ? 0 : i + 2;
    const k = a[i] * a[j + 1] - a[j] * a[i + 1];
    s += k;
    cx += (a[i] + a[j]) * k;
    cy += (a[i + 1] + a[j + 1]) * k;
  }
  return s ? [cx / (3 * s), cy / (3 * s)] : [a[0], a[1]];
}

/**
 * One island of a slice as plain data: its rings (flat), their signed areas, which is its outline, its area, box
 * and centroid, and its holes. `up` and `down` are the islands of the levels either side it overlaps.
 */
function islandOf(points, area) {
  const rings = points.map(flatRing);
  const areas = rings.map(ringArea);
  let outer = 0;
  areas.forEach((a, k) => {
    if (a > areas[outer]) outer = k;
  });
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  let cx = 0;
  let cy = 0;
  let sum = 0;
  const holes = [];
  rings.forEach((a, k) => {
    for (let i = 0; i < a.length; i += 2) {
      box[0] = Math.min(box[0], a[i]);
      box[1] = Math.min(box[1], a[i + 1]);
      box[2] = Math.max(box[2], a[i]);
      box[3] = Math.max(box[3], a[i + 1]);
    }
    const c = ringCentroid(a);
    cx += c[0] * areas[k];
    cy += c[1] * areas[k];
    sum += areas[k];
    if (areas[k] < 0) holes.push({ k, area: -areas[k], c });
  });
  return { rings, areas, outer, area, box, c: sum ? [cx / sum, cy / sum] : [box[0], box[1]], holes, up: [], down: [] };
}

/** The islands of a cross-section of `minArea` and more; `keep` gets each island's CrossSection (else deleted). */
function islandsIn(cs, minArea, keep = null) {
  const out = [];
  for (const piece of cs.decompose()) {
    const area = piece.area();
    if (area < minArea) {
      piece.delete();
      continue;
    }
    out.push(islandOf(piece.toPolygons(), area));
    if (keep) keep.push(piece);
    else piece.delete();
  }
  return out;
}

/**
 * An island seen from a centre: `dmin` the least distance of its material (0 when the centre is in it), `dmax` its
 * farthest point – a circle of radius R crosses it when dmin ≤ R ≤ dmax – whether its outline goes round the centre
 * (`encl`) and how near (`outerMin`), and the hole the centre is in, if any (`hole`: its area and how near and how
 * far its edge is). Worked out once per island and centre.
 */
export function reach(isl, c) {
  isl.about ??= new Map();
  const key = `${c[0]},${c[1]}`;
  const kept = isl.about.get(key);
  if (kept) return kept;
  const [px, py] = c;
  let near2 = Infinity;
  let far2 = 0;
  let wind = 0;
  let encl = false;
  let outerMin = Infinity;
  let hole = null;
  isl.rings.forEach((a, k) => {
    let ringNear = Infinity;
    let ringFar = 0;
    let w = 0;
    for (let i = 0, n = a.length; i < n; i += 2) {
      const j = i + 2 === n ? 0 : i + 2;
      const x0 = a[i];
      const y0 = a[i + 1];
      const ex = a[j] - x0;
      const ey = a[j + 1] - y0;
      const L2 = ex * ex + ey * ey;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * ex + (py - y0) * ey) / L2)) : 0;
      const dx = x0 + t * ex - px;
      const dy = y0 + t * ey - py;
      ringNear = Math.min(ringNear, dx * dx + dy * dy);
      ringFar = Math.max(ringFar, (x0 - px) ** 2 + (y0 - py) ** 2);
      const cross = ex * (py - y0) - (px - x0) * ey;
      if (y0 <= py) {
        if (a[j + 1] > py && cross > 0) w++;
      } else if (a[j + 1] <= py && cross < 0) w--;
    }
    near2 = Math.min(near2, ringNear);
    far2 = Math.max(far2, ringFar);
    wind += w;
    if (k === isl.outer) {
      outerMin = Math.sqrt(ringNear);
      encl = w !== 0;
    } else if (w !== 0) hole = { area: -isl.areas[k], near: Math.sqrt(ringNear), far: Math.sqrt(ringFar) };
  });
  const r = { dmin: wind !== 0 ? 0 : Math.sqrt(near2), dmax: Math.sqrt(far2), encl, outerMin, hole: wind === 0 && encl ? hole : null };
  isl.about.set(key, r);
  return r;
}

/** The radii an island blocks about a centre: [dmin, dmax]. */
const span = (isl, c) => {
  const r = reach(isl, c);
  return [r.dmin, r.dmax];
};

// ---------- the slice stack ----------

/**
 * The model sliced across z at `levels` heights, the middle of each step, each slice split into islands (specks
 * dropped) and each island joined to those of the levels either side whose material it overlaps. Plain data: it
 * holds no Manifold object, so it can be kept with the model.
 * @returns {{ levels: { i: number, z: number, islands: object[] }[], all: object[], h: number, zmin: number,
 *   zmax: number, height: number, box: { min: number[], max: number[] }, width: number, speck: number,
 *   maxArea: number, volume: number }}
 */
export function sliceStack(solid, { levels = PART_LEVELS } = {}) {
  const bb = solid.boundingBox();
  const zmin = bb.min[2];
  const zmax = bb.max[2];
  const height = zmax - zmin;
  const h = height / levels;
  const width = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]);
  const speck = (width * SPECK) ** 2;
  const out = [];
  const all = [];
  const sections = [];
  try {
    for (let i = 0; i < levels; i++) {
      const z = zmin + (i + 0.5) * h;
      const cs = solid.slice(z);
      const kept = [];
      let islands;
      try {
        islands = islandsIn(cs, speck, kept);
      } finally {
        cs.delete();
      }
      islands.forEach((isl, j) => {
        Object.assign(isl, { id: all.length, level: i, z });
        all.push(isl);
        sections[isl.id] = kept[j];
      });
      out.push({ i, z, islands });
    }
    // joined where they overlap by more than a tenth of a speck: a touch at a corner is no join
    for (let i = 0; i + 1 < out.length; i++) {
      for (const a of out[i].islands) {
        for (const b of out[i + 1].islands) {
          if (a.box[2] < b.box[0] || b.box[2] < a.box[0] || a.box[3] < b.box[1] || b.box[3] < a.box[1]) continue;
          const both = sections[a.id].intersect(sections[b.id]);
          const area = both.area();
          both.delete();
          if (area > speck / 10) {
            a.up.push(b);
            b.down.push(a);
          }
        }
      }
    }
  } finally {
    for (const cs of sections) cs?.delete();
  }
  const maxArea = Math.max(0, ...all.map((x) => x.area));
  const volume = all.reduce((v, x) => v + x.area * h, 0);
  return { levels: out, all, h, zmin, zmax, height, box: { min: [...bb.min], max: [...bb.max] }, width, speck, maxArea, volume };
}

/** Each level's islands about a centre as the radii they block, [dmin, dmax]; kept with the stack per centre. */
function rowsAbout(stack, c) {
  stack.rows ??= new Map();
  const key = `${c[0]},${c[1]}`;
  if (!stack.rows.has(key)) stack.rows.set(key, stack.levels.map((lv) => lv.islands.map((isl) => span(isl, c))));
  return stack.rows.get(key);
}

/**
 * The model's up axis through its round parts: the median centroid of the islands that go round the middle of its
 * box and are of some size (a ring band, a dome, a base), else that middle.
 */
export function axisOf(stack) {
  const c0 = [(stack.box.min[0] + stack.box.max[0]) / 2, (stack.box.min[1] + stack.box.max[1]) / 2];
  const xs = [];
  const ys = [];
  for (const isl of stack.all) {
    if (isl.area > 0.02 * stack.width ** 2 && reach(isl, c0).encl) {
      xs.push(isl.c[0]);
      ys.push(isl.c[1]);
    }
  }
  const median = (a) => [...a].sort((p, q) => p - q)[a.length >> 1];
  return xs.length ? [median(xs), median(ys)] : c0;
}

/**
 * Where a lid's circle may be centred: the axis, then the centre of every hole of some size (a lid off the axis sits
 * over a hole of its own), on a grid and without two the same, the largest holes first.
 */
function centresOf(stack, axis) {
  const q = stack.width / CENTRE_GRID;
  const same = CENTRE_SAME * stack.width;
  const holes = [];
  for (const isl of stack.all) {
    const outline = isl.areas[isl.outer];
    for (const hole of isl.holes) if (hole.area >= HOLE_SHARE * outline) holes.push(hole);
  }
  holes.sort((a, b) => b.area - a.area);
  const out = [axis];
  for (const hole of holes) {
    if (out.length > CENTRES) break;
    const c = [Math.round(hole.c[0] / q) * q, Math.round(hole.c[1] / q) * q];
    if (!out.some((o) => Math.hypot(o[0] - c[0], o[1] - c[1]) < same)) out.push(c);
  }
  return out;
}

// ---------- free circles ----------

/** What is left of the gap [lo, hi] once the radii `blocked` ([dmin, dmax] each) are taken out of it. */
function gapsOf(lo, hi, blocked) {
  const over = blocked.filter(([a, b]) => a < hi && b > lo).sort((p, q) => p[0] - q[0]);
  const out = [];
  let from = lo;
  for (const [a, b] of over) {
    if (a > from) out.push([from, a]);
    from = Math.max(from, b);
    if (from >= hi) break;
  }
  if (from < hi) out.push([from, hi]);
  return out;
}

/**
 * The circles free over a face, exactly: going up `rows` (each a slice's islands as the radii they block, the face
 * first), the radii R that hold material at the face and cross nothing up to their cap, the first row where the
 * disc of radius R is empty. A window of radii shares one cap. `cap` is that row's index (`rows.length` when the
 * disc never empties); `hi` is Infinity when nothing stands round the circle at all.
 * @param {number[][][]} rows
 * @returns {{ lo: number, hi: number, cap: number }[]}
 */
export function freeWindows(rows) {
  const first = rows[0] ?? [];
  let active = gapsOf(0, Infinity, first).filter(([lo]) => first.some(([, b]) => b <= lo));
  const out = [];
  for (let j = 1; j <= rows.length && active.length; j++) {
    const row = rows[j] ?? [];
    const next = [];
    for (const [lo, hi] of active) {
      for (const [p, q] of gapsOf(lo, hi, row)) {
        // something still inside the circle here: the lid goes on up; nothing, and its disc is empty – the cap
        if (row.some(([, b]) => b <= p)) next.push([p, q]);
        else out.push({ lo: p, hi: q, cap: j });
      }
    }
    active = next;
  }
  return out;
}

// ---------- handles ----------

/**
 * The loops of the island graph, scanning down from the top with a union-find of everything above: an island joined
 * to two or more islands above that are already one piece closes a loop there. Its top is the lowest island both
 * arms reach going up. A handle (or bail) is a loop that arches over something: a thin bar on top, arms well apart,
 * high on the model and of some height; the fretwork of a wall, a cupola's columns and a cup on a floor are not.
 * @returns {{ foot: object, top: object|null, arms: number, footZ: number, topZ: number|null, topArea: number|null,
 *   gap: number, handle: boolean, span: number[]|null }[]}
 */
export function findLoops(stack) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const above = (start) => {
    const seen = new Map([[start.id, start]]);
    const queue = [start];
    while (queue.length) {
      for (const y of queue.pop().up) {
        if (!seen.has(y.id)) {
          seen.set(y.id, y);
          queue.push(y);
        }
      }
    }
    return seen;
  };
  const loops = [];
  for (let i = stack.levels.length - 1; i >= 0; i--) {
    for (const a of stack.levels[i].islands) {
      parent.set(a.id, a.id);
      const roots = new Map();
      for (const b of a.up) {
        const r = find(b.id);
        if (!roots.has(r)) roots.set(r, []);
        roots.get(r).push(b);
      }
      for (const arms of roots.values()) {
        if (arms.length < 2) continue;
        const ups = arms.map(above);
        let top = null;
        for (const [id, isl] of ups[0]) if (ups.slice(1).every((u) => u.has(id)) && (!top || isl.level < top.level)) top = isl;
        // the air between the first two arms half-way up, from their boxes
        let gap = 0;
        let span = null;
        if (top) {
          const mid = Math.round((a.level + top.level) / 2);
          const at = ups.slice(0, 2).map((u) => [...u.values()].find((x) => x.level === mid));
          if (at.every(Boolean)) {
            const [p, q] = at.map((x) => x.box);
            gap = Math.max(q[0] - p[2], p[0] - q[2], q[1] - p[3], p[1] - q[3]);
            const [m, n] = at.map((x) => [(x.box[0] + x.box[2]) / 2, (x.box[1] + x.box[3]) / 2]);
            const len = Math.hypot(n[0] - m[0], n[1] - m[1]);
            span = len > 0 ? [(n[0] - m[0]) / len, (n[1] - m[1]) / len] : null;
          }
        }
        loops.push({ foot: a, top, arms: arms.length, footZ: a.z, topZ: top?.z ?? null, topArea: top?.area ?? null, gap, span });
      }
      for (const r of roots.keys()) parent.set(r, a.id);
    }
  }
  // one handle closes a loop at each place its feet meet the body (the legs fuse into a dome, its spires into a
  // band): loops over the same top are one, kept at the foot nearest it
  const byTop = new Map();
  for (const L of loops) {
    const key = L.top?.id ?? `foot${L.foot.id}`;
    const kept = byTop.get(key);
    if (!kept || L.footZ > kept.footZ) byTop.set(key, L);
  }
  const out = [...byTop.values()];
  for (const L of out) {
    L.handle = !!L.top && L.topArea < HANDLE_BAR * stack.maxArea && L.gap >= HANDLE_ARMS * stack.width
      && L.topZ - L.footZ >= HANDLE_TALL * stack.height && L.topZ >= stack.zmax - HANDLE_TOP * stack.height;
  }
  return out;
}

/**
 * What stays over a lid, traced down: the body's islands from the lid's face up that are joined to what lies over
 * the lid inside its circle. On a lantern that is the handle – its crown, arch, bosses and the legs that reach down
 * beside the lid to the body. Its islands per level as boxes (for the pick mode), how many stand at the face (the
 * legs) and the way their span runs in plan.
 */
export function traceOver(stack, lid) {
  const { c, k, cap } = lid;
  const seen = new Set();
  const queue = [];
  for (let j = cap; j < stack.levels.length; j++) {
    for (const x of stack.levels[j].islands) {
      if (reach(x, c).dmin < lid.R) {
        seen.add(x.id);
        queue.push(x);
      }
    }
  }
  if (!queue.length) return null;
  // flood through the joins, never under the face; never into the lid either, as nothing round the circle overlaps
  // anything inside it from the face to the cap
  while (queue.length) {
    const x = queue.pop();
    for (const y of [...x.up, ...x.down]) {
      if (seen.has(y.id) || y.level < k) continue;
      seen.add(y.id);
      queue.push(y);
    }
  }
  const levels = [];
  for (let j = k; j < stack.levels.length; j++) {
    const boxes = stack.levels[j].islands.filter((x) => seen.has(x.id)).map((x) => x.box.map((v) => +v.toFixed(4)));
    if (boxes.length) levels.push({ z: stack.levels[j].z, boxes });
  }
  const feet = stack.levels[k].islands.filter((x) => seen.has(x.id));
  let span = null;
  if (feet.length >= 2) {
    // the two feet farthest apart
    let best = 0;
    for (const p of feet) {
      for (const q of feet) {
        const d = Math.hypot(q.c[0] - p.c[0], q.c[1] - p.c[1]);
        if (d > best) {
          best = d;
          span = [(q.c[0] - p.c[0]) / d, (q.c[1] - p.c[1]) / d];
        }
      }
    }
  }
  return { legs: feet.length, span, levels, ids: seen };
}

// ---------- lids ----------

/** A flat ring as points again, for a CrossSection. */
function ringPoints(a) {
  const out = [];
  for (let i = 0; i < a.length; i += 2) out.push([a[i], a[i + 1]]);
  return out;
}

/**
 * The lids about one centre on the levels: each face level and window of radii where the circle holds a ring of
 * material round an opening that leads somewhere – a floor or a cupola's columns being no lid's face – and stays free
 * up to its cap, with something of the lid over the opening (an open top is no lid) and something of the body round
 * the circle (else it is a full plane: today's cuts), the lid holding some of the model. Whether the face is that
 * ring alone is asked where the face is put on the layers (`placeLid`), which decides it.
 */
function lidCandidates(stack, c) {
  const rows = rowsAbout(stack, c);
  const out = [];
  for (let k = 1; k < rows.length; k++) {
    if (!rows[k].length) continue;
    for (const w of freeWindows(rows.slice(k))) {
      if (!Number.isFinite(w.hi)) continue;
      const cap = k + w.cap;
      const R = (w.lo + w.hi) / 2;
      const ring = stack.levels[k].islands.find((x) => reach(x, c).dmax <= w.lo && reach(x, c).hole);
      const opening = ring && reach(ring, c).hole;
      if (!opening || opening.area < HOLE_SHARE * ring.areas[ring.outer]) continue;
      // the opening leads somewhere: a cup standing on a floor is no opening
      let depth = 0;
      for (let j = k - 1; j >= 0 && !stack.levels[j].islands.some((x) => reach(x, c).dmin === 0); j--) depth += stack.h;
      if (depth < Math.min(2 * Math.sqrt(opening.area / Math.PI), LEADS * stack.height)) continue;
      let closes = false;
      let volume = 0;
      let far = 0;
      for (let j = k; j < Math.min(cap, rows.length); j++) {
        for (const x of stack.levels[j].islands) {
          const r = reach(x, c);
          if (r.dmax > w.lo) continue;
          volume += x.area * stack.h;
          far = Math.max(far, r.dmax);
          if (j > k && r.dmin === 0) closes = true;
        }
      }
      if (!closes || volume < LID_VOLUME * stack.volume) continue;
      out.push({ c, k, lo: w.lo, hi: w.hi, cap, R, faceArea: ring.area, volume, far });
    }
  }
  return out;
}

/**
 * The same lid at several faces: candidates about one centre (within a share of the width, so a hole's centre a
 * hair off the axis finds the axis's lid again) whose caps are a level or two apart, on levels close together. Each
 * family is one part to suggest, about the centre of its lowest face – the axis's when that is as low – which is
 * where the search for the printed face starts.
 */
function familiesOf(cands, stack) {
  const same = FAMILY_CENTRE * stack.width;
  const out = [];
  // by level, the axis's first at each level (the candidates come centre by centre, the axis first)
  for (const x of [...cands].sort((a, b) => a.k - b.k)) {
    const f = out.find((F) => Math.hypot(F.c[0] - x.c[0], F.c[1] - x.c[1]) < same && Math.abs(F.cap - x.cap) <= FAMILY_LEVELS
      && x.k - F.last.k <= FAMILY_LEVELS);
    if (f) {
      f.items.push(x);
      if (x.k > f.last.k) f.last = x;
    } else out.push({ c: x.c, cap: x.cap, items: [x], last: x });
  }
  return out;
}

/** How much of a lid what lies over it inside its circle covers (0–1): a handle's crown covers a fifth of a dome. */
export function coverOf(stack, lid) {
  const { CrossSection } = manifold();
  const temps = scope();
  try {
    const over = [];
    for (let j = lid.cap; j < stack.levels.length; j++) {
      for (const x of stack.levels[j].islands) {
        if (reach(x, lid.c).dmin < lid.R) over.push(temps.add(new CrossSection(x.rings.map(ringPoints), 'Positive')));
      }
    }
    if (!over.length) return 0;
    const disc = temps.add(temps.add(CrossSection.circle(lid.far, 96)).translate(lid.c));
    const covered = temps.add(temps.add(CrossSection.union(over)).intersect(disc));
    return covered.area() / disc.area();
  } finally {
    temps.dispose();
  }
}

/** Slices of the model at the heights asked for, as islands, kept for one search. */
export function fineSlices(solid, minArea) {
  const kept = new Map();
  return (z) => {
    const key = z.toFixed(6);
    let row = kept.get(key);
    if (!row) {
      const cs = solid.slice(z);
      try {
        row = islandsIn(cs, minArea);
      } finally {
        cs.delete();
      }
      kept.set(key, row);
    }
    return row;
  };
}

/** The least outside radius of the island that goes round the centre (the largest that does), or null. */
export function ringRadius(islands, c) {
  return ringWall(islands, c)?.r ?? null;
}

/**
 * The wall round the centre (the largest island that goes round it): its least outside radius `r`, and `rin` the
 * farthest point of its inside – 0 when it is solid over the centre – or null when no island goes round it.
 */
function ringWall(islands, c) {
  let best = null;
  for (const x of islands) if (reach(x, c).encl && (!best || x.area > best.area)) best = x;
  if (!best) return null;
  const r = reach(best, c);
  return { r: r.outerMin, rin: r.dmin === 0 ? 0 : r.hole?.far ?? r.outerMin };
}

/** Linear interpolation in rows [{ z, [key] }] at z (rows rising, evenly spaced from rows[0].z by `step`). */
function between(rows, z, key, step) {
  const t = (z - rows[0].z) / step;
  const i = Math.max(0, Math.min(rows.length - 1, Math.floor(t + 1e-9)));
  const f = Math.max(0, Math.min(1, t - i));
  const a = rows[i][key];
  const b = rows[Math.min(rows.length - 1, i + 1)][key];
  if (a == null || b == null) return f < 0.5 ? a : b;
  return a + (b - a) * (f < 1e-9 ? 0 : f);
}

/**
 * One lid put on the printer at q times the model's size now (1: as it is): the lowest face on the layers there –
 * hl/q apart on the model as it is, from its bottom – from a level under the family's lowest face up, where the
 * circle's free window, grown q times, is at least `gmin`: the lid's rim prints apart from the body beside it,
 * elephant's foot and all; with one island inside the circle at the face; R the window's middle. The slices it reads
 * are the model's at the heights the finder would slice it scaled q times, so the face and the lock it gives are the
 * ones found at that size. With `rows`, the windows and the lid's outside are kept every half layer from a level
 * under the family up, for a quick reading at any other scale (`lidLockNear`).
 */
function placeLid(stack, fam, fine, S, zBed, q = 1, rows = false) {
  const { c } = fam;
  const half = S.hl / q / 2;
  const reachFine = FINE_REACH / q;
  const levels = rowsAbout(stack, c);
  const mine = fam.items.filter((x) => x.c === c);
  const own = [Math.min(...mine.map((x) => x.lo)), Math.max(...mine.map((x) => x.hi))];
  const zOf = (m) => zBed + m * half;
  const at = (m) => fine(zOf(m) + OVER);
  const windowAt = (m) => {
    const z0 = zOf(m);
    const seq = [];
    const zs = [];
    for (let j = 0; j * half <= reachFine + 1e-9; j++) {
      seq.push(at(m + j).map((x) => span(x, c)));
      zs.push(zOf(m + j));
    }
    stack.levels.forEach((lv, i) => {
      if (lv.z > z0 + reachFine) {
        seq.push(levels[i]);
        zs.push(lv.z);
      }
    });
    let best = null;
    for (const w of freeWindows(seq)) {
      // this family's lid, round its circle: not another lid's beside it, nor a full plane
      if (!Number.isFinite(w.hi) || w.hi < own[0] - stack.h || w.lo > own[1] + stack.h) continue;
      if (!best || w.hi - w.lo > best.hi - best.lo) best = { lo: w.lo, hi: w.hi, cap: w.cap < zs.length ? zs[w.cap] : stack.zmax };
    }
    const face = best ? at(m).filter((x) => reach(x, c).dmax <= best.lo) : [];
    return { m, z: z0, width: best ? best.hi - best.lo : 0, lo: best?.lo ?? null, hi: best?.hi ?? null, cap: best?.cap ?? null, ok: face.length === 1 && !!reach(face[0], c).hole };
  };
  const mA = Math.max(0, Math.floor((stack.levels[fam.items[0].k - 1].z - zBed) / half));
  const mB = Math.ceil((stack.levels[fam.last.k].z + stack.h - zBed) / half);
  const W = [];
  let face = null;
  // faces are on the layers (even half layers); the quick reading wants every half layer, a layer past the face
  for (let m = rows ? mA : mA + (mA % 2); m <= mB && (!face || (rows && m <= face.m + 2)); m += rows ? 1 : 2) {
    const w = windowAt(m);
    W.push(w);
    if (!face && m % 2 === 0 && w.ok && w.width * q >= S.gmin - 1e-9) face = w;
  }
  if (!face) return null;
  // the lid's outside over the face (over every face tried, for the quick reading), for the lock
  const tall = (S.sockTop + S.skin + 1) / q;
  const outside = [];
  for (let m = rows ? mA : face.m; zOf(m) <= face.z + 2 * half + tall + half + 1e-9; m++) outside.push({ z: zOf(m), r: ringRadius(at(m), c) });
  return { face, W, outside, half, zBed, q, at };
}

/** The collar twist-lock the lid's outside over a face at z0 takes at q times the size now (`collarFor`). */
function collarOver(outside, z0, r0, S, q) {
  if (r0 == null) return { lock: null, why: 'room' };
  const outer = [[q * r0, 0]];
  for (const o of outside) {
    if (o.z <= z0 + 1e-9) continue;
    if (o.r == null || q * (o.z - z0) > S.sockTop + S.skin + 1 + S.hl) break;
    outer.push([q * o.r, q * (o.z - z0)]);
  }
  if (outer.length < 2) return { lock: null, why: 'room' };
  const lock = collarFor(outer, S);
  return { lock: lock.why ? null : lock, why: lock.why ?? null };
}

/** The lock a placed lid gets at the scale it was placed for. */
const lidLockOn = (placed, S) => collarOver(placed.outside, placed.face.z, placed.outside.find((o) => o.z >= placed.face.z - 1e-9)?.r ?? null, S, placed.q);

/**
 * The lid's lock at q times the model's size now, read quickly from the slices `placeLid` kept at the size now: the
 * face on the layers there (hl/q apart on the model as it is), its window – read between half layers – grown q
 * times, and the lock its outside over that face takes. Near where a lock starts to fit the face it finds can be a
 * layer off the one the finder finds at that size, so a least scale read this way is checked (`leastOf`).
 */
function lidLockNear(placed, S, q) {
  const { W, outside, half, zBed } = placed;
  const step = S.hl / q;
  const last = W[W.length - 1].z;
  for (let j = Math.ceil((W[0].z - zBed) / step - 1e-9); ; j++) {
    const z0 = zBed + j * step;
    if (z0 > last + 1e-9) return null;
    const width = between(W, z0, 'width', half);
    const row = W[Math.min(W.length - 1, Math.max(0, Math.round((z0 - W[0].z) / half)))];
    if (!row.ok || width * q < S.gmin - 1e-9) continue;
    return { z0, ...collarOver(outside, z0, between(outside, z0, 'r', half), S, q) };
  }
}

/**
 * The least scale at which `exact` holds, as a factor on the size now: read quickly (`near`, `leastScale`), then
 * made a whole 5 % of the model as loaded – the scales the texts give – and checked at that size with the finder's
 * own reading, a step up at a time (a few at most) while it does not hold there. Null when none does up to
 * `LEAST_MOST`.
 */
function leastOf(near, exact, scale) {
  const q0 = leastScale(near, { from: 1, to: LEAST_MOST });
  if (q0 == null) return null;
  for (let p = scalePercent(q0 * scale), k = 0; k < LEAST_TRIES && p / 100 / scale <= LEAST_MOST + 1e-9; p += 5, k++) {
    if (exact(p / 100 / scale)) return p / 100 / scale;
  }
  return null;
}

/** The cap of a lid (where its disc empties) and the next thing inside the circle over it, to a fine height. */
function capOf(stack, fam, fine, c, R) {
  const L = stack.levels;
  const inDisc = (z) => fine(z).some((x) => reach(x, c).dmin < R);
  const bisect = (lo, hi, want) => {
    // lo has the disc as `want` is not, hi as it is
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      if (inDisc(mid) === want) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  if (fam.cap >= L.length) return { cap: stack.zmax, next: null, top: stack.zmax + 1 };
  // the levels drop specks, so a spire's tip may run on past the level where the disc looks empty: up a level at a
  // time until a fine slice finds it empty too
  let lo = L[fam.cap - 1].z;
  let hi = L[fam.cap].z;
  while (hi < stack.zmax && inDisc(hi)) {
    lo = hi;
    hi += stack.h;
  }
  if (hi >= stack.zmax) return { cap: stack.zmax, next: null, top: stack.zmax + 1 };
  const cap = bisect(lo, hi, false);
  let j = fam.cap;
  while (j < L.length && (L[j].z <= cap || !L[j].islands.some((x) => reach(x, c).dmin < R))) j++;
  const next = j < L.length ? bisect(Math.max(cap, L[j - 1].z), L[j].z, true) : null;
  // the part's prism ends half-way to the next thing, or a millimetre past the model's top
  return { cap, next, top: next == null ? stack.zmax + 1 : (cap + next) / 2 };
}

// ---------- the way out ----------

/**
 * How a lid comes out, from slices: straight up, when none of its slices meets anything over it; else lifted L (from
 * the lock's own lift, in steps, no higher than it lifts clear straight up, `upClear`) and slid out in one of 16
 * directions in the plane, each slice of the lid swept as the hull of itself and its moved copy against the body at
 * its height lifted, the lid's own islands left out of it. The first lift with a clear direction wins; `dir` is the
 * middle of the widest run of clear directions there.
 * @returns {{ up: boolean, lift: number|null, dir: number[]|null, dirs: number[], reach: number, upClear: number }}
 */
export function wayOut(solid, stack, lid, minLift) {
  const { CrossSection } = manifold();
  const { c, r: R, face, cap } = lid;
  const step = WAY_STEP * stack.height;
  const tiny = stack.speck * FINE_SPECK;
  const temps = scope();
  /** The model's slice at z: the lid's islands and the rest, each composed (null when none). */
  const sliceAt = (z) => {
    const cs = solid.slice(z);
    if (!(z >= face && z < cap)) return { lid: null, body: temps.add(cs) };
    const mine = [];
    const rest = [];
    try {
      for (const piece of cs.decompose()) {
        const isl = islandOf(piece.toPolygons(), 0);
        (reach(isl, c).dmax < R ? mine : rest).push(temps.add(piece));
      }
    } finally {
      cs.delete();
    }
    return { lid: mine.length ? temps.add(CrossSection.compose(mine)) : null, body: rest.length ? temps.add(CrossSection.compose(rest)) : null };
  };
  const hits = (a, b) => {
    if (!a || !b) return false;
    const p = a.bounds();
    const q = b.bounds();
    if (p.max[0] < q.min[0] || q.max[0] < p.min[0] || p.max[1] < q.min[1] || q.max[1] < p.min[1]) return false;
    const both = a.intersect(b);
    const area = both.area();
    both.delete();
    return area > tiny;
  };
  try {
    const slices = [];
    for (let z = face + step / 2; z < cap; z += step) {
      const s = sliceAt(z);
      if (s.lid) slices.push({ z, cs: s.lid, hull: temps.add(s.lid.hull()) });
    }
    const reachOut = Math.hypot(stack.box.max[0] - stack.box.min[0], stack.box.max[1] - stack.box.min[1]) / 2 + R + 1;
    if (!slices.length) return { up: true, lift: 0, dir: null, dirs: [], reach: reachOut, upClear: Infinity };
    // how far the lid lifts straight up before one of its slices meets what stands over its cap (under the cap nothing
    // round the circle reaches into it), each slice from its own height: a bail's arch comes down beside a narrow cap
    // and over the dome's wide rim, which lies far below it
    const over = [];
    const overAt = (j) => {
      while (over.length <= j) over.push(sliceAt(cap + (over.length * step) / 2).body);
      return over[j];
    };
    let upClear = Infinity;
    for (let i = slices.length - 1; i >= 0 && cap - slices[i].z < upClear; i--) {
      for (let j = 0; cap + (j * step) / 2 <= stack.zmax + step; j++) {
        if (hits(overAt(j), slices[i].cs)) {
          upClear = Math.min(upClear, cap + (j * step) / 2 - slices[i].z);
          break;
        }
      }
    }
    if (upClear === Infinity) return { up: true, lift: 0, dir: null, dirs: [], reach: reachOut, upClear };
    for (let L = minLift; L <= Math.min(WAY_MOST * stack.height, upClear) + 1e-9; L += step) {
      const bodies = slices.map((s) => sliceAt(s.z + L).body);
      const dirs = [];
      for (let a = 0; a < WAY_DIRS; a++) {
        const ang = (2 * Math.PI * a) / WAY_DIRS;
        const d = [Math.cos(ang) * reachOut, Math.sin(ang) * reachOut];
        const blocked = slices.some((s, j) => {
          const moved = s.hull.translate(d);
          const sweep = CrossSection.hull([s.hull, moved]);
          moved.delete();
          try {
            return hits(sweep, bodies[j]);
          } finally {
            sweep.delete();
          }
        });
        if (!blocked) dirs.push(+((ang * 180) / Math.PI).toFixed(1));
      }
      if (dirs.length) {
        const dir = middleOfRuns(dirs);
        return { up: false, lift: +L.toFixed(4), dir: [+Math.cos((dir * Math.PI) / 180).toFixed(6), +Math.sin((dir * Math.PI) / 180).toFixed(6)], dirs, reach: reachOut, upClear };
      }
    }
    return { up: false, lift: null, dir: null, dirs: [], reach: reachOut, upClear };
  } finally {
    temps.dispose();
  }
}

/** The middle of the widest run of directions (degrees, each 360 / WAY_DIRS apart, going round), the first if tied. */
function middleOfRuns(dirs) {
  const stepDeg = 360 / WAY_DIRS;
  const on = new Set(dirs.map((d) => Math.round(d / stepDeg)));
  if (on.size === WAY_DIRS) return 0;
  let best = null;
  for (let i = 0; i < WAY_DIRS; i++) {
    if (!on.has(i) || on.has((i + WAY_DIRS - 1) % WAY_DIRS)) continue;
    let n = 0;
    while (on.has((i + n) % WAY_DIRS)) n++;
    if (!best || n > best.n) best = { i, n };
  }
  return (((best.i + (best.n - 1) / 2) * stepDeg) % 360 + 360) % 360;
}

// ---------- the base ----------

/**
 * The model's floor under a centre: the first run of levels in its lowest third that are solid there (`j0` to `k`,
 * `floorTop` the last one's height); `{ solid: true }` when that runs to the top, null with no floor.
 */
export function floorOf(stack, c) {
  const { levels, height } = stack;
  const solidAt = (j) => levels[j].islands.some((x) => reach(x, c).dmin === 0);
  let j0 = levels.findIndex((lv) => lv.islands.length);
  if (j0 < 0) return null;
  while (j0 < levels.length && !solidAt(j0) && levels[j0].z < stack.zmin + height / 3) j0++;
  if (j0 >= levels.length || !solidAt(j0)) return null;
  let k = j0;
  while (k + 1 < levels.length && solidAt(k + 1)) k++;
  if (k + 1 >= levels.length) return { solid: true };
  return { j0, k, floorTop: levels[k].z };
}

/**
 * A base that twists off from underneath: under the model's middle a floor (the first run of levels, in its lowest
 * third, that are solid there) with the inside opening over it; the ring the body keeps round it is the floor's
 * least outside radius; and the widest circle (from that ring inwards) whose wall crosses nothing standing on the
 * floor – a cup on it goes with the base, a post or a wall it would cut rules the radius out, and so does taking
 * more than `PLUG_MOST` of the model with it (the lantern on a plate wider than itself) – and comes near nothing
 * else just over it. A ragged floor top (a scan's or a generated mesh's) counts as the joint, not as things
 * standing on it. `{ solid: true }` when the model is solid all through its middle; null with no floor there.
 */
function plugCandidate(stack, c) {
  const { levels, h, height } = stack;
  const gap = CENTRE_SAME * stack.width;
  const floor = floorOf(stack, c);
  if (!floor || floor.solid) return floor;
  const { j0, k, floorTop } = floor;
  const cores = levels.slice(j0, k + 1).flatMap((lv) => lv.islands.filter((x) => reach(x, c).dmin === 0));
  const largest = Math.max(...cores.map((x) => x.area));
  const rOut = Math.min(...cores.filter((x) => x.area >= 0.5 * largest).map((x) => reach(x, c).outerMin));
  const outerReach = Math.max(...cores.map((x) => reach(x, c).dmax));
  const rag = Math.max(2 * h, 0.01 * height);
  const tryR = (R) => {
    const starts = levels[k].islands.filter((x) => reach(x, c).dmin < R);
    const seen = new Set(starts.map((x) => x.id));
    const queue = [...starts];
    let top = floorTop;
    let volume = 0;
    while (queue.length) {
      const x = queue.pop();
      for (const y of [...x.up, ...x.down]) {
        if (y.level <= k || seen.has(y.id)) continue;
        if (y.z <= floorTop + rag) {
          seen.add(y.id);
          queue.push(y);
          continue;
        }
        const r = reach(y, c);
        if (r.dmin >= R) continue; // outside the circle: it stays on the body
        if (r.dmax > R - gap) return null; // crossed by the circle, or too near it
        seen.add(y.id);
        queue.push(y);
        top = Math.max(top, y.z);
        volume += y.area * h;
        // a circle round the walls of a lantern standing on a wider plate would take the lantern with its base
        if (volume > PLUG_MOST * stack.volume) return null;
      }
    }
    // nothing else may come near the circle just over the floor: a post on the floor's edge, joined to it only lower
    // down, would be cut by the circle's wall
    const band = Math.max(top, floorTop + rag) + Math.max(4 * h, 0.05 * height);
    for (let j = k + 1; j < levels.length && levels[j].z <= band; j++) {
      if (levels[j].z <= floorTop + rag) continue;
      for (const y of levels[j].islands) if (!seen.has(y.id) && reach(y, c).dmin < R + gap) return null;
    }
    return { top };
  };
  for (let R = rOut - gap; R > gap; R -= h / 4) {
    const got = tryR(R);
    if (got) return { c, R, rOut, floorTop, top: got.top, reach: outerReach };
  }
  return null;
}

/** The base's ring radius over its bottom, slice by slice, for the plug's lock at any scale (`plugLockAt`). */
export function ringRows(fine, c, zBed, S) {
  const half = S.hl / 2;
  const reachUp = plugDims(S, 10).top + 0.5 + S.hl;
  const out = [];
  for (let m = 1; m * half <= reachUp + 1e-9; m++) out.push({ dz: m * half, r: ringRadius(fine(zBed + m * half + OVER), c) });
  return out;
}

/**
 * The base's ring's least outside radius from over the bed layer and the bore's mouth (cut anyway, and where a
 * model's bottom edge is rounded or ragged) up to zMax, from its slices (`ringRows`), at q times the model's size now:
 * zMax is a height of the model at that size.
 */
function ringOutOf(rings, S, q) {
  const from = Math.max(S.hl, S.mouth) / q;
  return (zMax) => {
    let least = Infinity;
    for (const { dz, r } of rings) if (dz > from + 1e-9 && dz <= zMax / q + 1e-9) least = Math.min(least, r ?? 0);
    return q * least;
  };
}

/** The base's plug twist-lock at q times the model's size now (`plugFor`), from its ring's slices (`ringRows`). */
function plugLockAt(cand, rings, S, zBed, q) {
  return plugFor(S, { Rwindow: q * cand.R, solidTop: q * (cand.floorTop - zBed), ringOutAt: ringOutOf(rings, S, q) });
}

/**
 * The plug twist-lock a base with its circle at radius R gets, as the engine builds it: by `plugFor`'s rule at R
 * itself (`plugAt`) – the circle is the part's own – on the floor and ring the finder reads under centre c from the
 * model's bottom zBed.
 * @returns {object} `plugAt`'s
 */
export function plugLockOf(stack, fine, c, R, S, zBed) {
  const floor = floorOf(stack, c);
  if (!floor || floor.solid) return { R, why: 'floor' };
  return plugAt(S, R, { solidTop: floor.floorTop - zBed, ringOutAt: ringOutOf(ringRows(fine, c, zBed, S), S, 1) });
}

/** How far apart (mm) the body's outside is read under a lid's face, for its collar. */
const BELOW_STEP = 0.25;

/**
 * The collar twist-lock a lid with its face at z0 gets, as the engine builds it: sized on the lid's outside over the
 * face (`collarFor`), read every half layer as the finder reads it, so the lock is the one the table offered; then the
 * collar's slope (`collarSlope`) and how deep it reaches (`collarReach`) from the body's wall under the face, read
 * every `BELOW_STEP` down to where the collar lands on it or the wall round the axis ends.
 * @param {(z: number) => object[]} fine the model's islands at a height (`fineSlices`)
 * @param {number[]} c the circle's centre
 * @param {number} z0 the face
 * @param {object} S `sizes()`
 * @param {number} zmin the model's bottom
 * @returns {object} `collarFor`'s with `slope`, `reach`, `hang` (`collarReach`) and the profiles the solids are
 *   clipped to, in the lock's frame (`above` the lid's outside up to the socket ring's top, `[[r, z], …]`; `below` the
 *   body's wall down to where the collar lands on it or it ends, `[[r, z, rin], …]`); or `{ r0, why }`, `why` also
 *   'collar' when no wall goes round the axis as deep as the collar's own depth twice, so nothing would carry it, or
 *   the collar would run on out of the model's bottom (`zmin`) before it lands
 */
export function collarAt(fine, c, z0, S, zmin) {
  const half = S.hl / 2;
  const above = [];
  for (let j = 0; j * half <= S.sockTop + 4 + S.hl + 1e-9; j++) {
    const r = ringRadius(fine(z0 + j * half + OVER), c);
    if (r == null) break;
    above.push([r, round(j * half, 6)]);
  }
  const outer = above.filter(([, z]) => z <= S.sockTop + S.skin + 1 + S.hl + 1e-9);
  if (outer.length < 2) return { r0: null, why: 'room' };
  const lock = collarFor(outer, S);
  if (lock.why) return { r0: lock.r0, why: lock.why };
  const below = [];
  let slope = null;
  for (let j = 0; z0 - j * BELOW_STEP > zmin; j++) {
    const wall = ringWall(fine(z0 - j * BELOW_STEP - OVER), c);
    if (!wall) break;
    below.push([wall.r, -j * BELOW_STEP, wall.rin]);
    slope ??= collarSlope(below, S);
    if (slope != null && collarReach(below, lock.rn, S, slope)?.hang === 0) break;
  }
  const down = slope == null ? null : collarReach(below, lock.rn, S, slope);
  // a collar that runs on under the wall's end stays inside the model (or its piece)
  if (!down || z0 - down.depth <= zmin + 1e-9) return { r0: lock.r0, why: 'collar' };
  return { ...lock, slope: round(slope, 6), reach: down.depth, hang: down.hang, above, below };
}

/**
 * Whether the wall under a lid's face round the axis carries a collar from a bore of radius rn at q times the size
 * now, by `collarAt`'s rule: `walls` the wall read off the levels under the face at the size now (`[[r, z, rin], …]`
 * by falling z), grown q times, `depth` how far the model reaches under the face. Where the levels are coarse the
 * least scales it finds are checked on the finder's own reading at that size.
 */
function carried(walls, rn, depth, S, q) {
  const below = walls.map(([r, z, rin]) => [q * r, q * z, q * rin]);
  const slope = collarSlope(below, S);
  const down = slope == null ? null : collarReach(below, rn, S, slope);
  return !!down && down.depth < q * depth - 1e-9;
}

// ---------- the open top ----------

/**
 * Whether the model is open at the top already: down its axis from the top, air until a ring goes round it (its
 * hole Ø d, at least `OPEN_SHARE` of the model's width), then air on down at least as far as an opening that size
 * leads. A mug is; a lantern with a finial or a crown over its middle is not, nor one with a hanging hole through
 * its crown or a vent down its finial: that ring covers the middle but for a hole nothing goes through.
 */
function openTop(stack, c) {
  const { levels } = stack;
  let j = levels.length - 1;
  let rim = null;
  for (; j >= 0; j--) {
    const here = levels[j].islands.map((x) => reach(x, c));
    if (here.some((r) => r.dmin === 0)) return null;
    rim = here.find((r) => r.hole);
    if (rim) break;
  }
  if (!rim) return null;
  const d = 2 * rim.hole.near;
  if (d < OPEN_SHARE * stack.width) return null;
  let depth = 0;
  for (; j >= 0 && !levels[j].islands.some((x) => reach(x, c).dmin === 0); j--) depth += stack.h;
  return depth >= Math.min(d, LEADS * stack.height) ? { d } : null;
}

// ---------- the table ----------

const round = (v, k = 4) => (v == null ? null : +v.toFixed(k));

/** A lid's entry in the table: placed, locked, traced and its way out found; null when no face prints apart. */
function lidEntry(solid, stack, fam, fine, S, { zBed, handles, cover, scale }) {
  const placed = placeLid(stack, fam, fine, S, zBed, 1, true);
  if (!placed) return null;
  const { face, at, half } = placed;
  const c = fam.c;
  const R = (face.lo + face.hi) / 2;
  // the lock at this size as the engine builds it: sized on the lid's outside, and carried by a wall under the face
  // round the axis (`collarAt`) – a dome on a band too thin for the collar gets none
  let now = lidLockOn(placed, S);
  if (now.lock) {
    const built = collarAt(fine, c, face.z, S, stack.zmin);
    if (built.why) now = { lock: null, why: built.why };
  }
  // the wall under the face round the axis, read off the levels for the collar at other sizes
  const walls = [];
  for (let k = stack.levels.length - 1; k >= 0; k--) {
    const lv = stack.levels[k];
    if (lv.z >= face.z) continue;
    const wall = ringWall(lv.islands, c);
    if (!wall) break;
    walls.push([wall.r, lv.z - face.z, wall.rin]);
  }
  // a lock (and a tea light through it) at q times the size now, its collar carried: read quickly, and checked at
  // that size
  const fits = (lock, tea, q) => !!lock && (!tea || takesTeaLight(lock.opening, S.c)) && carried(walls, lock.rn, face.z - stack.zmin, S, q);
  const exact = (tea) => (q) => {
    const there = placeLid(stack, fam, fine, S, zBed, q);
    return !!there && fits(lidLockOn(there, S).lock, tea, q);
  };
  const least = {
    lock: now.lock ? null : leastOf((q) => fits(lidLockNear(placed, S, q)?.lock, false, q), exact(false), scale),
    tea: now.lock && takesTeaLight(now.lock.opening, S.c) ? null : leastOf((q) => fits(lidLockNear(placed, S, q)?.lock, true, q), exact(true), scale),
  };
  const ends = capOf(stack, fam, fine, c, R);
  // the coarse level of the face, for the handle's trace and the pick mode
  const kFace = stack.levels.findIndex((lv) => lv.z >= face.z);
  const lid = { c, k: kFace < 0 ? stack.levels.length - 1 : kFace, cap: fam.cap, R };
  const trace = traceOver(stack, lid);
  const takesHandle = handles.some((H) => H.top.level >= lid.k && H.top.level < fam.cap && reach(H.top, c).dmax < R);
  // how fast the body's least outside radius falls going up to the face (mm per mm), over the collar's depth twice:
  // the collar under the face slopes out as far as the model beside it does, up to `STEEP` (`collarSlope`)
  const below = face.m - Math.ceil((2 * S.Hc) / half - 1e-9);
  const rings = [ringRadius(at(below), c), ringRadius(at(face.m), c)];
  const underSlope = rings.every((r) => r != null) ? (rings[0] - rings[1]) / ((face.m - below) * half) : null;
  const entry = {
    kind: 'lid', name: trace ? 'Dome and cap' : 'Top', centre: c.map((v) => round(v, 6)), face: round(face.z), side: 1, r: round(R),
    window: [round(face.lo), round(face.hi)], gap: round(face.hi - face.lo), cap: round(ends.cap), next: round(ends.next), top: round(ends.top),
    from: round(stack.levels[fam.items[0].k].z), to: round(stack.levels[fam.last.k].z), covered: round(cover, 3), volume: round(fam.items[0].volume, 1),
    takesHandle, handle: trace && { legs: trace.legs, span: trace.span?.map((v) => round(v, 6)) ?? null, levels: trace.levels },
    lock: now.lock && lockWords(now.lock, S), why: now.lock ? null : now.why, least, underSlope: round(underSlope, 3),
  };
  const minLift = now.lock ? S.H + S.cz : WAY_START * stack.height;
  const way = wayOut(solid, stack, { c, r: R, face: face.z, cap: ends.cap }, minLift);
  entry.way = { up: way.up, lift: round(way.lift), dir: way.dir, dirs: way.dirs, reach: round(way.reach, 2) };
  return entry;
}

/** What the table keeps of a collar lock: plain numbers, and whether a tea light goes through it. */
function lockWords(lock, S) {
  const { r0, rn, rs, rf, opening, theta, tabs, tabR } = lock;
  return { mech: 'twist', r0, rn, rs, rf, opening, theta, tabs, tabR, teaLight: takesTeaLight(opening, S.c) };
}

/** The base's entry: its window, ring and lock, and the least scales. */
function plugEntry(stack, cand, fine, S, zBed) {
  const rings = ringRows(fine, cand.c, zBed, S);
  const now = plugLockAt(cand, rings, S, zBed, 1);
  // the base's window, floor and ring grow with the model, so its lock at another scale is read straight off them
  const fits = (tea) => (q) => {
    const P = plugLockAt(cand, rings, S, zBed, q);
    return !!P && (!tea || takesTeaLight(P.opening, S.c));
  };
  const least = {
    lock: now ? null : leastScale(fits(false), { from: 1, to: LEAST_MOST }),
    tea: fits(true)(1) ? null : leastScale(fits(true), { from: 1, to: LEAST_MOST }),
  };
  const lock = now && {
    mech: 'plug', R: now.R, opening: now.opening, theta: now.theta, wall: now.wall, camOutN: now.camOutN, ringOut: now.ringOut, tabs: now.tabs,
    tabR: now.tabR, coin: now.coin, teaLight: takesTeaLight(now.opening, S.c),
  };
  return {
    kind: 'plug', name: 'Base', centre: cand.c.map((v) => round(v, 6)), face: round(zBed), side: 1, r: round(now ? now.R : cand.R),
    window: [0, round(cand.R)], ringOut: round(cand.rOut), solidTop: round(cand.floorTop), top: round(cand.top), reach: round(cand.reach),
    takesHandle: false, handle: null, lock, why: now ? null : 'room', least, underSlope: null, way: { up: true, lift: 0, dir: null, dirs: [], reach: 0 },
  };
}

/**
 * The order the card lists parts in: those whose lock fits at this size first; a part that leaves every handle on
 * the body before one that takes a handle; lids before bases (a lantern's top is what is changed most); one that
 * takes a tea light first, then the wider opening; then the least scale a lock needs.
 */
function rankParts(parts) {
  const key = (e) => [e.lock ? 0 : 1, e.takesHandle ? 1 : 0, e.kind === 'lid' ? 0 : 1, e.lock?.teaLight ? 0 : 1, -(e.lock?.opening ?? 0), e.least.lock ?? Infinity];
  return [...parts].sort((a, b) => {
    const p = key(a);
    const q = key(b);
    for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i] - q[i];
    return 0;
  });
}

/**
 * The parts of a model that come off, with what each would get: the table the card of suggestions, the pick mode
 * and the refit after a Scale read. `stack` is the model's `sliceStack` when it is kept; `scale` is the model's
 * size now against the one loaded, echoed for the texts. Lengths in mm, least scales as factors on the size now.
 * @param {object} solid the model (a Manifold, borrowed)
 * @param {{ n?: number, hl?: number, c?: number, stack?: object, scale?: number }} options nozzle, layer height and
 *   clearance
 * @returns {{ centre: number[], h: number, zmin: number, zmax: number, width: number, scale: number, solid: boolean,
 *   open: { d: number }|null, handles: object[], parts: object[], ms: object }}
 */
export function findParts(solid, { n = 0.4, hl = 0.2, c = 0.15, stack = null, scale = 1 } = {}) {
  const t0 = performance.now();
  const ms = {};
  const lap = (name, t) => {
    ms[name] = Math.round(performance.now() - t);
    return performance.now();
  };
  let t = t0;
  stack ??= sliceStack(solid);
  t = lap('stack', t);
  const S = sizes(n, hl, c);
  const zBed = stack.zmin;
  const axis = axisOf(stack);
  const loops = findLoops(stack);
  const handles = loops.filter((L) => L.handle);
  t = lap('loops', t);
  const fine = fineSlices(solid, stack.speck * FINE_SPECK);
  const open = openTop(stack, axis);
  const base = plugCandidate(stack, axis);
  const parts = [];
  if (!open) {
    const fams = familiesOf(centresOf(stack, axis).flatMap((x) => lidCandidates(stack, x)), stack);
    const largest = Math.max(0, ...fams.map((f) => f.items[0].faceArea));
    const kept = fams.filter((f) => f.items[0].faceArea >= LID_FACE * largest).sort((a, b) => b.items[0].volume - a.items[0].volume);
    t = lap('candidates', t);
    for (const fam of kept) {
      if (parts.length >= LIDS) break;
      const cover = coverOf(stack, fam.items[0]);
      if (cover > COVER_MOST) continue;
      const lid = lidEntry(solid, stack, fam, fine, S, { zBed, handles, cover, scale });
      // a lid that can't come out, lifted and slid however, is no part to offer
      if (lid && (lid.way.up || lid.way.lift != null)) parts.push(lid);
    }
    t = lap('lids', t);
    if (base && !base.solid) parts.push(plugEntry(stack, base, fine, S, zBed));
    t = lap('base', t);
  }
  ms.all = Math.round(performance.now() - t0);
  return {
    centre: axis.map((v) => round(v, 6)), h: round(stack.h, 6), zmin: round(stack.zmin), zmax: round(stack.zmax), width: round(stack.width),
    scale, solid: !!base?.solid && !parts.length, open: open && { d: round(open.d, 3) },
    handles: handles.map((H) => ({ foot: round(H.footZ), top: round(H.topZ), span: H.span })),
    parts: rankParts(parts), ms,
  };
}

/**
 * Which part a point on the model picks, from the table alone (each pointer move, so no slicing): a lid when the
 * point is on it; the lid under a handle when it is on the handle the lid leaves on the body; the lid when it is
 * just under its face, on the shell it sits in; the base when it is on the model's solid bottom. `on` says which.
 * @returns {{ part: object|null, index: number, on: 'lid'|'handle'|'under'|'base'|null }}
 */
export function pickPart(table, p) {
  const { h } = table;
  const dist = (e) => Math.hypot(p[0] - e.centre[0], p[1] - e.centre[1]);
  const rules = [
    ['lid', (e) => e.kind === 'lid' && p[2] >= e.face - 1e-6 && p[2] <= e.cap + 1e-6 && dist(e) <= e.r],
    ['handle', (e) => e.kind === 'lid' && !!e.handle && onTrace(e.handle, p, 1.5 * h)],
    ['under', (e) => e.kind === 'lid' && p[2] < e.face && p[2] >= e.from - 2 * h && dist(e) <= e.window[1] + 2 * h],
    ['base', (e) => e.kind === 'plug' && p[2] <= e.solidTop + 1e-6 && dist(e) <= e.reach + 1e-6],
  ];
  for (const [on, test] of rules) {
    const index = table.parts.findIndex(test);
    if (index >= 0) return { part: table.parts[index], index, on };
  }
  return { part: null, index: -1, on: null };
}

/** Whether p is on a traced handle: inside one of its islands' boxes, grown by tol, at a level within tol of it. */
function onTrace(handle, p, tol) {
  return handle.levels.some(({ z, boxes }) => Math.abs(z - p[2]) <= tol
    && boxes.some((b) => p[0] >= b[0] - tol && p[0] <= b[2] + tol && p[1] >= b[1] - tol && p[1] <= b[3] + tol));
}
