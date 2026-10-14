/**
 * Split for printing, the solid half: the Manifold builders behind it. Holes,
 * pins, the fit test, dovetail tabs through thin plates, cutting the model
 * into one piece per cell, finding room for pins and labels on each cut
 * face, and drilling the pieces. Every function takes Manifolds and plain
 * specs and returns Manifolds or plain data; the rules themselves (sizes,
 * frames, where pins go, how pieces lie, notes) live in split.js.
 *
 * Ownership: a Manifold or CrossSection passed in is borrowed and never
 * deleted; one returned belongs to the caller, who must `.delete()` it.
 * Plane coordinates (u, v, w) are those of `TO_PLANE[axis]`, w along the
 * cut's axis.
 */
import { manifold } from './manifold.js';
import { displayBuffers } from './mesh.js';
import { buildCrossSectionInfo, printLimits, thinStrokeReport } from './textGeometry.js';
import {
  AUTO_DIAMETERS,
  AXES,
  CUT_TOLERANCE,
  FILAMENT,
  HOLE_SEGMENTS,
  POLYGON_K,
  PLATE_THICKNESS,
  SPLIT_DEFAULTS,
  SPLIT_LIMITS,
  SplitError,
  TO_PLANE,
  TO_WORLD,
  applyMat4,
  axisCuts,
  cellOf,
  cellOfPoint,
  chooseCentres,
  gridPoints,
  localFrame,
  orientationStats,
  polygonsCentroid,
  dovetailSize,
  flatProbes,
  sizesFor,
  sizesForRoom,
  splitNote,
  teardropApex,
} from './split.js';

/** Shells smaller than this (mm³) are dust that a cut along a flat face of the model leaves behind, not material. */
const DUST = 1e-3;
/** Face patches smaller than this (mm²) are left alone. */
const MIN_PATCH = 0.5;
/** The sizing pass only looks at patches at least this big (mm²): slivers would make every pin tiny. */
const SIZING_PATCH = 50;
/** Islands of a cut face smaller than this (mm²) are ignored by the plate test. */
const MIN_ISLAND = 1;
/** The strip a crossing cut takes out of a face, so each patch belongs to one pair of pieces (mm). */
const TRACE = 0.02;
/** Labels are engraved this deep and stand this proud of the face, so the cut through the face is clean (mm). */
const LABEL_DEPTH = 0.6;
const LABEL_PROUD = 0.4;
/** Labels keep this far from a face's edge, this far from a hole's mouth, and this much room round the text (mm). */
const LABEL_EDGE = 1.5;
const LABEL_HOLE_GAP = 2;
const LABEL_MARGIN = 1;
/** The columns under a label must be solid this far either side of the face (mm). */
const LABEL_REACH = 2.2;
/** Label sizes tried (cap height, mm), largest first in 1 mm steps. */
const LABEL_LARGEST = 8;
const LABEL_SMALLEST = 3;
/** The gap between pins on a sheet and between the parts of the fit test (mm). */
const PIN_GAP = 3;
const COUPON_GAP = 5;
/** A dovetail tab's root on its own side, the room it needs inside the plate, and the rounding of every corner (mm). */
const TAB_ROOT = 2;
const TAB_INSIDE = 2;
const TAB_ROUND = 0.8;
/** How far something must stand out of a plate (mm) before its tabs keep clear of it; less is the plate's own unevenness. */
const PROUD = 0.3;

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

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A Manifold's bounding box as plain arrays. */
function boxOf(m) {
  const { min, max } = m.boundingBox();
  return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
}

/** The world axes of plane coordinates u and v for a cut on `axis`. */
const planeAxes = (axis) => [(axis + 1) % 3, (axis + 2) % 3];

/** Whether a point lies inside polygons (even-odd), as `polygonsOf` gives them. */
function insidePolygons(polys, x, y) {
  let inside = false;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** A point well inside polygons: the centroid when it is inside, else the grid point nearest to it. */
function insidePoint(polys, centroid) {
  if (centroid && insidePolygons(polys, centroid[0], centroid[1])) return centroid;
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (const poly of polys) {
    for (const [u, v] of poly) {
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
  }
  const c = centroid ?? [(minU + maxU) / 2, (minV + maxV) / 2];
  for (const div of [50, 500]) {
    const pts = gridPoints(polys, Math.max(maxU - minU, maxV - minV) / div);
    if (!pts.length) continue;
    let best = pts[0];
    for (const p of pts) if (Math.hypot(p[0] - c[0], p[1] - c[1]) < Math.hypot(best[0] - c[0], best[1] - c[1])) best = p;
    return best;
  }
  return polys[0]?.[0] ?? c;
}

/**
 * The largest inset (mm) at which a cross-section still has area, by
 * bisection, or `cap` as soon as an inset of `cap` has: insets close to
 * collapse are slow on dense outlines, and callers only need to know a
 * width up to what their largest size needs. 0 when it is empty.
 */
function largestInset(cs, cap = Infinity) {
  if (cs.isEmpty()) return 0;
  const hasArea = (d) => {
    const inset = cs.offset(-d, 'Round', 2, 16);
    const left = !inset.isEmpty() && inset.area() > 1e-6;
    inset.delete();
    return left;
  };
  const { min, max } = cs.bounds();
  let lo = 0;
  let hi = Math.min(max[0] - min[0], max[1] - min[1]) / 2 + 0.01;
  if (cap < hi) {
    if (hasArea(cap)) return cap;
    hi = cap;
  }
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (hasArea(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * The solid turned into each axis's plane frame, made once per axis and
 * shared by every slice along it. `frame(axis)` may lend the engine's own
 * copy instead.
 */
function planeFrames(solid, frame = null) {
  const made = new Map();
  return {
    get(axis) {
      if (axis === 2) return solid;
      if (frame) return frame(axis);
      if (!made.has(axis)) made.set(axis, solid.transform(TO_PLANE[axis]));
      return made.get(axis);
    },
    dispose() {
      for (const m of made.values()) m.delete();
      made.clear();
    },
  };
}

// ---------- around the binding's leaks ----------

// manifold-3d 3.5.4's JavaScript glue leaks WASM memory in calls this module makes many times per split:
// toPolygons() never frees the inner vectors it reads, extrude() and revolve() never free the outline they
// pass on, and Manifold.revolve(points) never deletes the cross-section it makes. The helpers below do the
// same work and free everything (falling back to the plain calls if the glue changes), and the shapes built
// from text or points are kept between calls, so laying a split out again and again does not grow the heap.
// What is left is a few hundred bytes per outline built from points (a dovetail tab), in the glue itself.

/** A cross-section's outlines as point lists, exactly as `toPolygons()` gives them. */
function polygonsOf(cs) {
  if (typeof cs._ToPolygons !== 'function') return cs.toPolygons();
  const vec = cs._ToPolygons();
  const out = [];
  try {
    for (let i = 0, n = vec.size(); i < n; i++) {
      const ring = vec.get(i);
      const poly = [];
      for (let j = 0, m = ring.size(); j < m; j++) {
        const pt = ring.get(j);
        poly.push([pt.x, pt.y]);
      }
      ring.delete();
      out.push(poly);
    }
  } finally {
    vec.delete();
  }
  return out;
}

/** `Manifold.extrude(cs, height)`, freeing the outline it passes on. */
function extrudeSection(cs, height) {
  const wasm = manifold();
  if (typeof cs._ToPolygons !== 'function' || typeof wasm._Extrude !== 'function') return wasm.Manifold.extrude(cs, height);
  const vec = cs._ToPolygons();
  try {
    return wasm._Extrude(vec, height, 0, 0, { x: 1, y: 1 });
  } finally {
    vec.delete();
  }
}

/** `cs.revolve(segments)`, freeing the outline it passes on. */
function revolveSection(cs, segments) {
  const wasm = manifold();
  if (typeof cs._ToPolygons !== 'function' || typeof wasm._Revolve !== 'function') return cs.revolve(segments);
  const vec = cs._ToPolygons();
  try {
    return wasm._Revolve(vec, segments, 360);
  } finally {
    vec.delete();
  }
}

/** A few shapes kept between calls, by key, the least recently used deleted beyond `limit`. Never delete one you get. */
function keptShapes(limit, dispose = (v) => v?.delete?.()) {
  const map = new Map();
  return {
    get(key, make) {
      if (map.has(key)) {
        const v = map.get(key);
        map.delete(key);
        map.set(key, v);
        return v;
      }
      const v = make();
      map.set(key, v);
      while (map.size > limit) {
        const [oldest] = map.keys();
        dispose(map.get(oldest));
        map.delete(oldest);
      }
      return v;
    },
    clear() {
      for (const v of map.values()) dispose(v);
      map.clear();
    },
  };
}

// half-holes and pins by size (a split uses one or two sizes many times), and label texts by font, text and size
const HOLES = keptShapes(16);
const PINS = keptShapes(16);
const LABELS = keptShapes(64, (e) => {
  e?.cs?.delete();
  e?.solid?.delete();
});

/** Deletes the shapes kept between calls (when the engine lets go of everything it holds). */
export function clearSplitCaches() {
  HOLES.clear();
  PINS.clear();
  LABELS.clear();
}

// ---------- holes and pins ----------

/** A 32-gon drawn outside a circle (its flats on the circle), with a teardrop point towards +y when asked. */
function holeProfile(rad, tear) {
  const { CrossSection } = manifold();
  const circle = CrossSection.circle(rad * POLYGON_K, HOLE_SEGMENTS);
  if (!tear) return circle;
  // the point sits where 45° tangents from the circle meet, so the roof needs no bridge
  const drop = CrossSection.hull([circle, [[0, Math.SQRT2 * rad * POLYGON_K]]]);
  circle.delete();
  return drop;
}

/**
 * The half-hole of these sizes in its own frame, kept: never delete it, transform or copy it. It is two convex hulls of
 * the profile's own corners, the bore with its cone end and the chamfered mouth, which meet on the bore's corners at
 * z = ch: built from thin slabs, it had corners a few millionths of a millimetre apart that an STL's float32 merges
 * into zero-area triangles.
 */
function cachedHalfHole(R, h, ch, tear) {
  return HOLES.get([R, h, ch, tear].join('|'), () => {
    const { Manifold } = manifold();
    const t = scope();
    try {
      const ring = (rad) => {
        const p = holeProfile(rad, tear);
        try {
          return polygonsOf(p).flat();
        } finally {
          p.delete();
        }
      };
      const at = (pts, z) => pts.map(([x, y]) => [x, y, z]);
      const bore = ring(R);
      const tipped = t.add(Manifold.hull([...at(bore, -1), ...at(bore, h), [0, 0, h + R]]));
      const mouth = t.add(Manifold.hull([...at(ring(R + ch), -1), ...at(ring(R + ch), 0), ...at(bore, ch)]));
      return Manifold.union([tipped, mouth]);
    } finally {
      t.dispose();
    }
  });
}

/**
 * One half of a pin's hole, in its own frame: the mouth at z = 0 and the
 * hole running into the piece along +z. The bore starts 1 mm outside the
 * face (in the air) so the cut is clean, the mouth has a 45° chamfer of
 * `ch`, and the blind end is a 45° cone, so nothing needs a bridge. With
 * `tear` the profile has a teardrop point towards +y, for a hole the piece
 * prints lying down.
 * @param {{ R: number, h: number, ch: number, tear?: boolean }} sizes R the hole radius (pin radius plus clearance),
 *   h the bore's depth before the cone, ch the chamfer
 * @returns {Manifold}
 */
export function halfHole({ R, h, ch, tear = false }) {
  return cachedHalfHole(R, h, ch, Boolean(tear)).translate([0, 0, 0]);
}

/**
 * A printed pin: an octagon with its corners on radius r, from z = 0 to
 * z = L, with end chamfers of e. Turned any way in a hole drawn outside the
 * circle of r + c, it keeps at least c of clearance; its flats leave room
 * for glue and air.
 * @param {{ r: number, L: number, e: number }} pin
 * @returns {Manifold}
 */
export function pinSolid({ r, L, e }) {
  return cachedPin(r, L, e).translate([0, 0, 0]);
}

/** The pin of these sizes, kept: never delete it, transform or copy it. */
function cachedPin(r, L, e) {
  return PINS.get([r, L, e].join('|'), () => {
    const profile = manifold().CrossSection.ofPolygons([[[0, 0], [r - e, 0], [r, e], [r, L - e], [r - e, L], [0, L]]], 'Positive');
    try {
      return revolveSection(profile, 8);
    } finally {
      profile.delete();
    }
  });
}

/** The pin of a dowel's size: radius d/2, as long as both holes are deep, the usual end chamfer. */
const pinOf = (d, depth) => ({ r: d / 2, L: 2 * depth, e: Math.min(0.4, 0.1 * d) });

/**
 * A dowel's pin where it sits in the assembled model (world), centred on
 * the cut along the cut's axis, turned `turn` degrees about its own axis.
 * For the pieces view and for checking the fit.
 * @param {{ axis: number, centre: number[], d: number, depth: number }} dowel a dowel from `layoutSplit`
 * @returns {Manifold}
 */
export function pinAt(dowel, turn = 0) {
  const t = scope();
  try {
    const { r, L, e } = pinOf(dowel.d, dowel.depth);
    const centred = t.add(cachedPin(r, L, e).translate([0, 0, -dowel.depth]));
    const turned = turn ? t.add(centred.rotate([0, 0, turn])) : centred;
    return turned.transform(localFrame(`+${AXES[dowel.axis]}`, null, dowel.centre));
  } finally {
    t.dispose();
  }
}

/** How many spare pins go on a sheet for n holes: one in four, rounded up. */
export const pinSpares = (n) => Math.ceil(n / 4);

/** A pin lying on one of its flats, its axis along +x from x = 0. */
function lyingPin(pin) {
  const t = scope();
  try {
    return t.add(cachedPin(pin.r, pin.L, pin.e).rotate([0, 0, 22.5])).rotate([0, 90, 0]);
  } finally {
    t.dispose();
  }
}

/** Shells laid out in a row along x, `gap` apart, the row centred on x = y = 0 and standing on z = 0. */
function rowOf(shells, gap) {
  const { Manifold } = manifold();
  const t = scope();
  try {
    const boxes = shells.map(boxOf);
    const width = boxes.reduce((s, b) => s + b.max[0] - b.min[0], 0) + gap * (shells.length - 1);
    let x = -width / 2;
    const placed = shells.map((m, i) => {
      const b = boxes[i];
      const moved = t.add(m.translate([x - b.min[0], -(b.min[1] + b.max[1]) / 2, -b.min[2]]));
      x += b.max[0] - b.min[0] + gap;
      return moved;
    });
    return Manifold.compose(placed);
  } finally {
    t.dispose();
  }
}

/** The box of one pin as the pins file lays it. */
function lyingPinBox(d, length) {
  const one = lyingPin({ r: d / 2, L: length, e: Math.min(0.4, 0.1 * d) });
  try {
    return boxOf(one);
  } finally {
    one.delete();
  }
}

/**
 * How many pins of Ø d × length one pins file can hold so that it fits the
 * bed lying as laid out: rows wrapped to the bed's width, as many rows as
 * its depth takes (at least one pin, even one too long for the bed).
 * @param {{ d: number, length: number }} group
 * @param {number[]} U the usable bed
 * @returns {{ perSheet: number, size: number[] }} `size` one pin's box as laid
 */
export function pinsPerSheet({ d, length }, U) {
  const b = lyingPinBox(d, length);
  const size = b.max.map((v, a) => v - b.min[a]);
  const perRow = Math.max(1, Math.floor((U[0] + PIN_GAP) / (size[0] + PIN_GAP)));
  const rows = Math.max(1, Math.floor((U[1] + PIN_GAP) / (size[1] + PIN_GAP)));
  return { perSheet: perRow * rows, size };
}

/**
 * The pins file: `count` pins of Ø d × length, each lying on a flat (no
 * supports, strongest across the layers), end to end along x with 3 mm
 * gaps, in rows wrapped to the bed's width. Centred on x = y = 0, standing
 * on z = 0. Put spares in `count` (`pinSpares`); more than the bed takes
 * (`pinsPerSheet`) go in more than one file.
 * @param {{ d: number, length: number, count: number }} group
 * @param {number[]|null} U the usable bed (only its x is used)
 * @returns {Manifold}
 */
export function pinSheet({ d, length, count }, U = null) {
  const { Manifold } = manifold();
  const t = scope();
  try {
    const one = t.add(lyingPin({ r: d / 2, L: length, e: Math.min(0.4, 0.1 * d) }));
    const b = boxOf(one);
    const sx = b.max[0] - b.min[0];
    const sy = b.max[1] - b.min[1];
    const perRow = Math.max(1, Math.floor(((U?.[0] ?? 200) + PIN_GAP) / (sx + PIN_GAP)));
    const rows = Math.ceil(count / perRow);
    const cols = Math.min(count, perRow);
    const x0 = -(cols * sx + (cols - 1) * PIN_GAP) / 2 - b.min[0];
    const y0 = -(rows * sy + (rows - 1) * PIN_GAP) / 2 - b.min[1];
    const pins = [];
    for (let i = 0; i < count; i++) {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      pins.push(t.add(one.translate([x0 + col * (sx + PIN_GAP), y0 + row * (sy + PIN_GAP), -b.min[2]])));
    }
    return Manifold.compose(pins);
  } finally {
    t.dispose();
  }
}

/**
 * The fit test: one small print that tries the holes and pins before the
 * whole model is printed. A block with an upright round hole (mouth on the
 * bed, as on a piece printed cut face down), a block with a lying teardrop
 * hole (as on a piece printed on its side) and one pin; for dovetails two
 * small plates with one tab (N = 6). Filament and your own dowels get no
 * pin. In a row with 5 mm gaps, centred, standing on z = 0.
 * @param {object} spec the split settings: diameter (0 = 5 mm), depth, clearance, pins, joint
 * @param {number} nozzle
 * @param {{ dovetail?: boolean, pins?: boolean }} options `dovetail` adds the plates (default: when the joint is set
 *   to dovetails); `pins: false` leaves the blocks and the pin out, for a split held by tabs alone
 * @returns {Manifold}
 */
export function fitTestCoupon(spec = {}, nozzle = 0.4, { dovetail = spec.joint === 'dovetail', pins = true } = {}) {
  const { Manifold } = manifold();
  const t = scope();
  try {
    const D = Number(spec.diameter) > 0 ? Number(spec.diameter) : 5;
    const c = Number.isFinite(spec.clearance) ? spec.clearance : SPLIT_DEFAULTS.clearance;
    const shells = [];
    if (pins || !dovetail) {
      const s = sizesFor(D, c, nozzle, Number(spec.depth) > 0 ? Number(spec.depth) : 0);
      const side = Math.max(24, Math.ceil(2 * s.rhoTear + 2));
      const long = s.h + s.R + s.wall + 2;
      const hole = { R: s.R, h: s.h, ch: s.ch };
      const upright = t.add(t.add(Manifold.cube([side, side, long])).translate([-side / 2, -side / 2, 0]));
      shells.push(t.add(upright.subtract(t.add(halfHole(hole)))));
      const lying = t.add(t.add(Manifold.cube([side, long, side])).translate([-side / 2, 0, 0]));
      const drop = t.add(t.add(halfHole({ ...hole, tear: true })).transform(localFrame('+y', '+z', [0, 0, side / 2])));
      shells.push(t.add(lying.subtract(drop)));
      if (D !== FILAMENT && spec.pins !== 'own') shells.push(t.add(lyingPin(pinOf(D, s.depth))));
    }
    if (dovetail) {
      const plate = t.add(t.add(Manifold.cube([80, 30, 5], true)).translate([0, 0, 2.5]));
      const cut = { id: 'fit', letter: 'A', axis: 0, at: 0 };
      const plan = { w: 2, seams: [{ cutId: 'fit', letter: 'A', axis: 0, at: 0, tabs: [{ l: 0, dir: 1, N: 6, H: 8.4, E: 6 }] }] };
      const [axis] = dovetailCells(plan, [cut], boxOf(plate), c);
      for (const cell of axis.cells) {
        t.add(cell.solid);
        shells.push(t.add(plate.intersect(cell.solid)));
      }
    }
    return rowOf(shells, COUPON_GAP);
  } finally {
    t.dispose();
  }
}

/**
 * One side's half of a dowel's hole, in place (world): into the lower
 * piece (side 0) or the upper one (side 1), with its teardrop point
 * towards that piece's up when it prints the hole lying down.
 * @param {object} dowel from `layoutSplit`
 * @param {0|1} side
 * @returns {Manifold}
 */
export function dowelHole(dowel, side) {
  const s = dowel.sides[side];
  const local = cachedHalfHole(dowel.R, dowel.h, dowel.ch, Boolean(s.tear));
  return local.transform(localFrame(`${side === 0 ? '-' : '+'}${AXES[dowel.axis]}`, s.tear ? s.apex : null, dowel.centre));
}

// ---------- labels ----------

/** A number per font, so labels in different fonts are kept apart. */
const fontIds = new WeakMap();
let fontCount = 0;

/**
 * A label's text, kept: its outline centred on the origin, half its width
 * and height, whether it is too thin to engrave (per nozzle), and its
 * cutter in its own frame once made; null when the font gives no outline.
 * Never delete what it holds.
 */
function labelEntry(font, text, size) {
  if (!fontIds.has(font)) fontIds.set(font, ++fontCount);
  return LABELS.get(`${fontIds.get(font)}|${text}|${size}`, () => {
    const cs = buildCrossSectionInfo([{ font, text, size }], {}).cs;
    if (!cs) return null;
    if (cs.isEmpty()) {
      cs.delete();
      return null;
    }
    const { min, max } = cs.bounds();
    return { cs, cx: (min[0] + max[0]) / 2, cy: (min[1] + max[1]) / 2, hx: (max[0] - min[0]) / 2, hy: (max[1] - min[1]) / 2, thin: new Map(), solid: null };
  });
}

/** A label outline extruded from 0.6 mm below its face to 0.4 mm above, centred on the origin. */
function labelCutter(cs, cx, cy) {
  const prism = extrudeSection(cs, LABEL_DEPTH + LABEL_PROUD);
  try {
    return prism.translate([-cx, -cy, -LABEL_DEPTH]);
  } finally {
    prism.delete();
  }
}

/** A label's frame: z out of the face, y up (world +z, or +y on a Z cut), so it reads left to right from outside. */
const labelFrame = (outward, axis, centre) => localFrame(outward, axis === 2 ? '+y' : '+z', centre);

/**
 * An engraved label's cutter, in place: the text extruded from 0.6 mm
 * inside the face to 0.4 mm out of it (the same depth as engraved text),
 * centred on `centre`, reading upright from outside the face.
 * @param {{ text?: string, size?: number, font?: object, cs?: CrossSection, centre: number[], outward: string, axis: number }} label
 *   `cs` a ready shape (borrowed), else `text` at cap height `size` in `font` (an opentype.js font)
 * @returns {Manifold|null} null when the text has no outline
 */
export function labelSolid({ text, size, font = null, cs = null, centre, outward, axis }) {
  const frame = labelFrame(outward, axis, centre);
  if (cs) {
    if (cs.isEmpty()) return null;
    const { min, max } = cs.bounds();
    const local = labelCutter(cs, (min[0] + max[0]) / 2, (min[1] + max[1]) / 2);
    try {
      return local.transform(frame);
    } finally {
      local.delete();
    }
  }
  if (!font) throw new Error("labelSolid needs the label's font or its shape.");
  const entry = labelEntry(font, text, size);
  if (!entry) return null;
  entry.solid ??= labelCutter(entry.cs, entry.cx, entry.cy);
  return entry.solid.transform(frame);
}

// ---------- dovetail tabs through thin plates ----------

/** The slice of the solid at a cut, in the cut's plane coordinates. */
const faceOf = (frames, cut) => frames.get(cut.axis).slice(cut.at);

/** A rectangle lo…hi along the plane coordinates u and v (`[u, v]` pairs). */
function rectSection(lo, hi) {
  const { CrossSection } = manifold();
  const square = CrossSection.square([hi[0] - lo[0], hi[1] - lo[1]]);
  try {
    return square.translate(lo);
  } finally {
    square.delete();
  }
}

/**
 * Whether a cut runs through a thin plate, from its face. Every island
 * (≥ 1 mm²) must be a solid strip at least 4 times as long as it is thick
 * and 2–10 mm thick, all thin along the same world axis w. The plate's own
 * thickness is taken where most of the island has it (`plateBand`), so a
 * letter or a boss standing on it where the cut crosses does not count:
 * the strip is solid when at least 0.6 of that band is material and what
 * stands outside it is no more than half as much again (a U or a ring is
 * not a plate). Then no cut along w may run through the plate (its tabs
 * would come apart in layers), there may be no unrepaired triangles, and
 * the plate must stay where it is across the pieces either side (each of
 * `probes`, positions along the cut's axis sliced by `sliceAt`, must pass
 * `plateStays`), or the pieces of a curved panel would have to lie on their
 * curve. Thinner than 2 mm is glued.
 * @param {CrossSection} face the cut's face in its plane coordinates (borrowed)
 * @param {{ axis: number, at: number }} cut
 * @param {{ cuts?: object[], passthrough?: boolean, sliceAt?: function|null, probes?: number[] }} options every cut of
 *   the split; whether there are unrepaired triangles; `sliceAt(t)` lends the solid's slice at t on the cut's axis,
 *   in the same plane coordinates, and `probes` where to look (`flatProbes`)
 * @returns {{ joint: 'dovetail'|'dowels'|'none', w: number|null, islands: object[], reason: string|null }}
 *   islands `{ area, axes: [uAxis, vAxis], min: [u, v], max: [u, v], t, long, w, band, l, span }`: `band` the plate's
 *   own extent along w and `l` the island's along the plate, `span` everything the island holds along w (plane mm)
 */
export function plateTest(face, cut, { cuts = [], passthrough = false, sliceAt = null, probes = [] } = {}) {
  const axes = planeAxes(cut.axis);
  const islands = [];
  const parts = face.decompose();
  const t = scope();
  let block = false;
  try {
    for (const p of parts) {
      const area = p.area();
      if (area < MIN_ISLAND) continue;
      const { min, max } = p.bounds();
      const kw = max[0] - min[0] <= max[1] - min[1] ? 0 : 1;
      const kl = 1 - kw;
      const l = [min[kl], max[kl]];
      // a strip has at most 1.5 times a 10 mm band's area: anything more is a block, told without tracing its outline
      if (area > 1.5 * (l[1] - l[0]) * PLATE_THICKNESS.max) {
        block = true;
        break;
      }
      const band = plateBand(polygonsOf(p), kl, kw, l[0], l[1]) ?? [min[kw], max[kw]];
      const thick = band[1] - band[0];
      const long = l[1] - l[0];
      let inBand = 0;
      if (thick > 0) {
        const lo = [0, 0];
        const hi = [0, 0];
        [lo[kl], hi[kl], lo[kw], hi[kw]] = [l[0] - 1, l[1] + 1, band[0], band[1]];
        inBand = t.add(p.intersect(t.add(rectSection(lo, hi)))).area();
      }
      const strip = thick > 0 && inBand >= 0.6 * long * thick && area - inBand <= 0.5 * inBand && long >= 4 * thick;
      islands.push({
        area, axes, min: [min[0], min[1]], max: [max[0], max[1]], t: thick, long, w: axes[kw], strip, band, l, span: [min[kw], max[kw]], kl, kw,
      });
    }
  } finally {
    parts.forEach((p) => p.delete());
    t.dispose();
  }
  if (block) return { joint: 'dowels', w: null, islands, reason: 'shape' };
  if (!islands.length) return { joint: 'dowels', w: null, islands, reason: 'empty' };
  const w = islands[0].w;
  if (!islands.every((i) => i.strip && i.t <= 10 && i.w === w)) return { joint: 'dowels', w: null, islands, reason: 'shape' };
  // thinner than 2 mm takes neither tabs nor pins
  if (islands.some((i) => i.t < 2)) return { joint: 'none', w, islands, reason: 'thin' };
  // only a cut through the plate itself matters: a cut along w elsewhere in the model (the other arm of an L) does not
  const through = (c) => c.axis === w && islands.some((i) => c.at > i.span[0] + CUT_TOLERANCE && c.at < i.span[1] - CUT_TOLERANCE);
  if (cuts.some(through)) return { joint: 'dowels', w, islands, reason: 'cut along the thickness' };
  if (passthrough) return { joint: 'dowels', w, islands, reason: 'unrepaired triangles' };
  if (sliceAt && !probes.every((at) => plateStays(sliceAt(at), islands))) return { joint: 'dowels', w, islands, reason: 'curved' };
  return { joint: 'dovetail', w, islands, reason: null };
}

/**
 * Whether a slice elsewhere along the cut's axis (borrowed) still has each
 * island's plate where it was. Over the island's length, either most of the
 * material there lies in the plate's band (a plate with a hole through it,
 * or a disc, shorter away from its middle), or the band is mostly filled
 * over the stretch where there is material (a wall the plate runs into
 * fills it, and more): at least 0.6 either way. A curved panel has moved
 * off its band.
 */
function plateStays(slice, islands) {
  if (!slice || slice.isEmpty()) return true; // nothing there to lie on either way: no evidence of a curve
  const t = scope();
  try {
    const { min, max } = slice.bounds();
    return islands.every((i) => {
      const lo = [0, 0];
      const hi = [0, 0];
      [lo[i.kl], hi[i.kl], lo[i.kw], hi[i.kw]] = [i.l[0], i.l[1], min[i.kw] - 1, max[i.kw] + 1];
      const there = t.add(slice.intersect(t.add(rectSection(lo, hi))));
      if (there.isEmpty()) return true;
      [lo[i.kw], hi[i.kw]] = i.band;
      if (t.add(there.intersect(t.add(rectSection(lo, hi)))).area() >= 0.6 * there.area()) return true;
      const reach = there.bounds();
      [lo[i.kl], hi[i.kl]] = [reach.min[i.kl], reach.max[i.kl]];
      if (!(hi[i.kl] > lo[i.kl])) return true;
      const rect = t.add(rectSection(lo, hi));
      return t.add(there.intersect(rect)).area() >= 0.6 * rect.area();
    });
  } finally {
    t.dispose();
  }
}

/**
 * The dovetail tabs a cut at this face would get if it runs through a thin
 * plate, for the planner: how far the piece below the cut (`below`) and the
 * one above it (`above`) may reach past it, the plate's thickness axis w
 * and how far along w the plate's islands go (`span`, world mm: a cut along
 * w inside it would rule the tabs out); null when the cut would take pins.
 * Either piece may hold a tab, even where an island takes only one (it
 * points the other way when something stands proud on the far side), and
 * tabs that later find no room are counted all the same: the plan must
 * never be smaller than the pieces.
 * @param {CrossSection} face the cut's face in its plane coordinates (borrowed)
 * @param {{ axis: number, at: number }} cut
 * @param {{ sliceAt?: function|null, probes?: number[] }} options as for `plateTest`: whether the plate stays flat
 * @returns {{ below: number, above: number, w: number, span: number[] }|null}
 */
export function tabsAcross(face, cut, { sliceAt = null, probes = [] } = {}) {
  const test = plateTest(face, cut, { sliceAt, probes });
  if (test.joint !== 'dovetail') return null;
  const reach = Math.max(0, ...test.islands.map((island) => dovetailSize(island.long)?.E ?? 0));
  const span = [Math.min(...test.islands.map((i) => i.span[0])), Math.max(...test.islands.map((i) => i.span[1]))];
  return reach > 0 ? { below: reach, above: reach, w: test.w, span } : null;
}

/** The rectangle s0…s1 along the cut axis s by l0…l1 along the plate, in the plane frame of w (as `tabSection`). */
function planeRect(s0, s1, l0, l1, s, w) {
  const { CrossSection } = manifold();
  const sIsP = (w + 1) % 3 === s;
  const square = CrossSection.square(sIsP ? [s1 - s0, l1 - l0] : [l1 - l0, s1 - s0]);
  try {
    return square.translate(sIsP ? [s0, l0] : [l0, s0]);
  } finally {
    square.delete();
  }
}

/**
 * A tab's footprint pointing along `dir` (±1 on the cut axis s) from the
 * line s = at, with its root 2 mm back on its own side so unions with that
 * side are clean, in the plane frame of w, grown by `grow` with `join`.
 */
function tabSection(tab, at, s, w, grow = 0, join = 'Miter') {
  const { CrossSection } = manifold();
  const { l, dir, N, H, E } = tab;
  const pts = [[-TAB_ROOT, -N / 2], [0, -N / 2], [E, -H / 2], [E, H / 2], [0, N / 2], [-TAB_ROOT, N / 2]].map(([ds, dl]) => [at + dir * ds, l + dl]);
  // (s, l) → (p, q) of TO_PLANE[w]; s is p when it is w's u axis. NonZero fills either winding (a mirrored tab is clockwise).
  const cs = new CrossSection([(w + 1) % 3 === s ? pts : pts.map(([a, b]) => [b, a])], 'NonZero');
  if (!grow) return cs;
  const grown = cs.offset(grow, join, 2, 32);
  cs.delete();
  return grown;
}

/**
 * The plate's own thickness at a cut, from its face island's outline: the
 * top and bottom along w where most of the island has them (a quarter of
 * the way in from the extremes), so letters or a boss crossing the cut do
 * not count as plate.
 */
function plateBand(polygons, kl, kw, l0, l1) {
  const tops = [];
  const bottoms = [];
  for (let i = 0; i < 32; i++) {
    const at = l0 + ((i + 0.5) * (l1 - l0)) / 32;
    let lo = Infinity;
    let hi = -Infinity;
    for (const poly of polygons) {
      for (let j = 0, k = poly.length - 1; j < poly.length; k = j++) {
        const a = poly[k];
        const b = poly[j];
        if ((a[kl] <= at) === (b[kl] <= at)) continue;
        const x = a[kw] + ((at - a[kl]) / (b[kl] - a[kl])) * (b[kw] - a[kw]);
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    }
    if (lo <= hi) {
      tops.push(hi);
      bottoms.push(lo);
    }
  }
  if (!tops.length) return null;
  tops.sort((p, q) => p - q);
  bottoms.sort((p, q) => q - p);
  const quarter = Math.floor(tops.length / 4);
  return [bottoms[quarter], tops[quarter]];
}

/**
 * Where the dovetail tabs go on each dovetail cut. Per plate island of
 * length L (`dovetailSize`): neck N = clamp(0.12·L, 6, 12), head 1.4·N, tab
 * length N, clamp(⌊L / (2.5·head)⌋, 1, 8) tabs spread evenly inside the
 * island (head/2 + 3 from its ends), alternating sides, the lower-numbered
 * piece's first. A tab is extruded right through the model, so it may only
 * go where it and 2 mm round it hold nothing but its own plate: inside the
 * plate at mid-thickness, clear of anything standing 0.3 mm or more proud
 * of the plate above or below within reach of the cut (letters, a boss, a
 * plate at another height: a tab there would carry a slice of it into the
 * other piece), head/2 + 3 from a crossing cut's trace and as much again as
 * a crossing dovetail cut's tabs reach (or two tabs close off a corner of a
 * piece). Another plate the same cut runs through (the other leg of a U)
 * may lie in a tab's way if the tab lies wholly inside it too: it makes the
 * same tab there, and serves that plate as its own. A tab whose even spot
 * is taken moves along the plate to the nearest free one; the cut must be
 * N + 2 from parallel ones.
 * @param {Manifold} solid (borrowed)
 * @param {{ id, letter, axis, at }[]} cuts every cut, normalised
 * @param {{ ids: string[], w: number|Object<string, number> }} dove the dovetail cuts and the plates' thickness axis
 *   (one for all, or each cut's by id)
 * @param {{ frame?: function }} options `frame(axis)` lends the solid in that axis's plane frame
 * @returns {{ w: number|null, seams: { cutId, letter, axis, at, w, tabs: { l, dir, N, H, E }[] }[] }} l along the plate,
 *   in world mm; `w` each seam's plate thickness axis (the top-level one when they all share it)
 */
export function dovetailTabs(solid, cuts, dove, { frame = null } = {}) {
  const { CrossSection, Manifold } = manifold();
  const frames = planeFrames(solid, frame);
  const outlines = new Map();
  const box = boxOf(solid);
  const t = scope();
  try {
    const outlineAt = (w, wMid) => {
      const key = `${w}|${wMid.toFixed(6)}`;
      if (!outlines.has(key)) outlines.set(key, t.add(frames.get(w).slice(wMid)));
      return outlines.get(key);
    };
    // every dovetail cut's plate islands first: a crossing one's tabs must be known to reach before any are placed
    const plates = cuts.filter((c) => dove.ids.includes(c.id)).map((cut) => {
      const s = cut.axis;
      const w = wOfCut(dove, cut.id);
      const l = 3 - s - w;
      const [kl, kw] = [l, w].map((axis) => planeAxes(s).indexOf(axis));
      const face = faceOf(frames, cut);
      const islands = [];
      try {
        for (const p of face.decompose()) {
          if (p.area() >= MIN_ISLAND) {
            const { min, max } = p.bounds();
            const polygons = polygonsOf(p);
            const band = plateBand(polygons, kl, kw, min[kl], max[kl]);
            islands.push({ l0: min[kl], l1: max[kl], band: band ?? [min[kw], max[kw]], size: dovetailSize(max[kl] - min[kl]) });
          }
          p.delete();
        }
      } finally {
        face.delete();
      }
      return { cut, s, w, l, islands, reach: Math.max(0, ...islands.map((i) => i.size?.E ?? 0)) };
    });
    const reachOf = new Map(plates.map((x) => [x.cut.id, x.reach]));
    const seams = [];
    for (const { cut, s, w, l, islands, reach } of plates) {
      const parallel = cuts.filter((c) => c.axis === s && c.id !== cut.id);
      const crossing = cuts.filter((c) => c.axis === l).map((c) => ({ at: c.at, keep: reachOf.get(c.id) ?? 0 }));
      // the model within a tab's reach of the cut, once for the cut: what stands proud of each island is taken from it
      let near = null;
      const nearCut = () => {
        if (!near) {
          const size = box.max.map((v, k) => v - box.min[k] + 4);
          size[s] = 2 * (reach + TAB_INSIDE + 1);
          const centre = box.min.map((v, k) => (v + box.max[k]) / 2);
          centre[s] = cut.at;
          near = t.add(solid.intersect(t.add(t.add(Manifold.cube(size, true)).translate(centre))));
        }
        return near;
      };
      const tabs = [];
      // the model near the cut between a and b along w, seen along w (null when there is none)
      const seen = ([a, b]) => {
        const sz = box.max.map((v, k) => v - box.min[k] + 4);
        sz[w] = b - a;
        const at = box.min.map((v, k) => (v + box.max[k]) / 2);
        at[w] = (a + b) / 2;
        const there = t.add(nearCut().intersect(t.add(t.add(Manifold.cube(sz, true)).translate(at))));
        return there.isEmpty() ? null : t.add(t.add(there.transform(TO_PLANE[w])).project());
      };
      for (const island of islands) {
        const { size, l0, l1 } = island;
        if (!size || parallel.some((c) => Math.abs(c.at - cut.at) < size.N + 2)) continue;
        const { N, H, E, count: m, span } = size;
        const [pw0, pw1] = island.band;
        const outline = outlineAt(w, (pw0 + pw1) / 2);
        // the other plates this cut runs through at other heights (the legs of a U, the shelves of a rack): a tab is
        // extruded through them too, and is welcome there as long as it lies wholly inside one or misses it
        const others = islands.filter((o) => o !== island && (o.band[1] < pw0 || o.band[0] > pw1)).map((o) => ({
          outline: outlineAt(w, (o.band[0] + o.band[1]) / 2),
          layer: seen([o.band[0] - PROUD, o.band[1] + PROUD]),
          gap: [o.band[0] - PROUD, o.band[1] + PROUD],
        }));
        // anything else standing proud of this island's plate near the cut, seen along w
        let stretches = [[box.min[w] - 2, pw0 - PROUD], [pw1 + PROUD, box.max[w] + 2]];
        for (const { gap: [g0, g1] } of others) stretches = stretches.flatMap(([a, b]) => [[a, Math.min(b, g0)], [Math.max(a, g1), b]]);
        const beyond = stretches.filter(([a, b]) => b > a && b > box.min[w] && a < box.max[w]).map(seen).filter(Boolean);
        const proud = beyond.length > 1 ? t.add(CrossSection.union(beyond)) : beyond[0] ?? null;
        const lo = l0 + H / 2 + 3;
        const placed = [];
        const near = (p, l) => Math.abs(p.l - l) < (p.H + H) / 2 + 2 * TAB_INSIDE;
        const inside = (tab, u) => u.add(u.add(tabSection(tab, cut.at, s, w, TAB_INSIDE, 'Round')).subtract(outline)).area() < 0.01;
        const free = (tab) => {
          if (crossing.some((c) => Math.abs(c.at - tab.l) < H / 2 + 3 + c.keep)) return false;
          // the tabs of this cut's other plates run through this one too
          if ([...tabs, ...placed].some((p) => near(p, tab.l))) return false;
          const u = scope();
          try {
            const grown = u.add(tabSection(tab, cut.at, s, w, TAB_INSIDE, 'Round'));
            if (u.add(grown.subtract(outline)).area() >= 0.01) return false;
            // only the far side of the cut changes hands (and a millimetre more, for the rounded corners at the root)
            const [s0, s1] = tab.dir > 0 ? [cut.at - 1, cut.at + E + TAB_INSIDE + 1] : [cut.at - E - TAB_INSIDE - 1, cut.at + 1];
            const far = u.add(u.add(planeRect(s0, s1, tab.l - H, tab.l + H, s, w)).intersect(grown));
            if (proud && u.add(far.intersect(proud)).area() >= 0.01) return false;
            return others.every((o) => !o.layer || u.add(far.intersect(o.layer)).area() < 0.01 || u.add(grown.subtract(o.outline)).area() < 0.01);
          } finally {
            u.dispose();
          }
        };
        for (let j = 0; j < m; j++) {
          const ideal = lo + ((j + 0.5) * span) / m;
          // a tab of another plate of this cut, through this one already and inside it, takes the place of this one
          const served = scope();
          try {
            if (tabs.some((p) => near(p, ideal) && inside(p, served))) continue;
          } finally {
            served.dispose();
          }
          const dir = j % 2 ? -1 : 1;
          // the even spot when it is free, pointing the other way if need be, else the nearest free spot along the
          // plate, a millimetre at a time
          let tab = null;
          for (let d = 0; d <= span + 1e-9 && !tab; d += 1) {
            for (const at of d ? [ideal - d, ideal + d] : [ideal]) {
              if (at < lo - 1e-9 || at > lo + span + 1e-9) continue;
              tab = [dir, -dir].map((way) => ({ l: at, dir: way, N, H, E })).find(free) ?? null;
              if (tab) break;
            }
          }
          if (tab) placed.push(tab);
        }
        tabs.push(...placed);
      }
      seams.push({ cutId: cut.id, letter: cut.letter, axis: s, at: cut.at, w, tabs });
    }
    const ws = new Set(seams.map((x) => x.w));
    return { w: ws.size === 1 ? [...ws][0] : null, seams };
  } finally {
    t.dispose();
    frames.dispose();
  }
}

/**
 * The solid of every cell along each axis that has dovetail seams: the
 * slab between its cuts, plus its own tabs shrunk by c/2, minus the
 * neighbours' tabs grown by c/2, every corner rounded by 0.8 mm, extruded
 * through the whole model along w. Flat parts of a seam butt with no gap;
 * the tab flanks get the clearance c. The cells are disjoint. Each axis's
 * cells are extruded along the thickness axis its seams share.
 * @param {{ w: number|null, seams: object[] }} plan from `dovetailTabs` (a seam without its own `w` takes the plan's)
 * @param {{ id, axis, at }[]} cuts every cut (the planar ones on the same axis bound cells too)
 * @param {{ min: number[], max: number[] }} bounds the solid's
 * @param {number} clearance per side (mm)
 * @returns {{ axis: number, w: number, reach: number, cells: { index: number, min: number, max: number, solid: Manifold }[] }[]}
 *   one entry per axis; `reach` how far a tab reaches past its cut; the cell solids belong to the caller
 */
export function dovetailCells(plan, cuts, bounds, clearance = SPLIT_DEFAULTS.clearance) {
  const { CrossSection, Manifold } = manifold();
  const out = [];
  try {
    for (const s of [...new Set(plan.seams.map((x) => x.axis))].sort((p, q) => p - q)) {
      const w = plan.seams.find((x) => x.axis === s).w ?? plan.w;
      const l = 3 - s - w;
      const onAxis = cuts.filter((c) => c.axis === s).sort((p, q) => p.at - q.at);
      const tabsOf = new Map(plan.seams.filter((x) => x.axis === s).map((x) => [x.cutId, x.tabs]));
      const reach = Math.max(0, ...[...tabsOf.values()].flat().map((tb) => tb.E));
      const pad = reach + 5;
      const edges = [bounds.min[s] - pad, ...onAxis.map((c) => c.at), bounds.max[s] + pad];
      const [l0, l1] = [bounds.min[l] - pad, bounds.max[l] + pad];
      const w0 = bounds.min[w] - 1;
      const wLen = bounds.max[w] - bounds.min[w] + 2;
      const entry = { axis: s, w, reach, cells: [] };
      out.push(entry);
      for (let i = 0; i < edges.length - 1; i++) {
        const t = scope();
        try {
          // the slab between the cell's cuts, along s, and right across the model along l, in (p, q)
          const along = [edges[i + 1] - edges[i], l1 - l0];
          const from = [edges[i], l0];
          const sIsP = (w + 1) % 3 === s;
          let region = t.add(t.add(CrossSection.square(sIsP ? along : [along[1], along[0]])).translate(sIsP ? from : [from[1], from[0]]));
          const own = [];
          const theirs = [];
          // the cut below this cell: tabs pointing −s come from this cell; the cut above: tabs pointing +s do
          const below = onAxis[i - 1];
          const above = onAxis[i];
          for (const tab of (below && tabsOf.get(below.id)) ?? []) (tab.dir < 0 ? own : theirs).push([tab, below.at]);
          for (const tab of (above && tabsOf.get(above.id)) ?? []) (tab.dir > 0 ? own : theirs).push([tab, above.at]);
          for (const [tab, at] of own) region = t.add(region.add(t.add(tabSection(tab, at, s, w, -clearance / 2))));
          for (const [tab, at] of theirs) region = t.add(region.subtract(t.add(tabSection(tab, at, s, w, clearance / 2))));
          if (own.length || theirs.length) {
            region = t.add(region.offset(TAB_ROUND, 'Round', 2, 32));
            region = t.add(region.offset(-2 * TAB_ROUND, 'Round', 2, 32));
            region = t.add(region.offset(TAB_ROUND, 'Round', 2, 32));
          }
          const prism = t.add(extrudeSection(region, wLen));
          const placed = t.add(prism.translate([0, 0, w0]));
          entry.cells.push({ index: i, min: edges[i], max: edges[i + 1], solid: placed.transform(TO_WORLD[w]) });
        } finally {
          t.dispose();
        }
      }
    }
    return out;
  } catch (err) {
    out.forEach((e) => e.cells.forEach((c) => c.solid.delete()));
    throw err;
  }
}

/**
 * Which cuts take dovetail tabs, from the settings and the plate test:
 * 'auto' gives plates tabs and everything else pins, 'dovetail' gives
 * plates tabs and says when a cut isn't one, 'dowels' and 'none' skip the
 * test. A plate under 2 mm thick is glued; one whose tabs all fall outside
 * the plate is glued too. The dovetail cuts on one axis share one
 * thickness axis w (their cells are extruded along it); cuts on another
 * axis may go through another plate (the two arms of an L).
 * @param {Manifold} solid (borrowed)
 * @param {{ id, letter, axis, at }[]} cuts normalised, in canonical order
 * @param {object} spec the normalised settings (`joint`, `clearance`)
 * @param {{ passthrough?: boolean, frame?: function }} options whether there are unrepaired triangles;
 *   `frame(axis)` lends the solid in that axis's plane frame
 * @returns {{ dove: { ids: string[], w: number|Object<string, number>, clearance: number }|null,
 *   joints: Object<string, 'dowels'|'dovetail'|'none'>, plates: Object<string, object>, tabs: object|null, notes: object[] }}
 *   `dove` is what the cut stage's key holds: `w` the plates' thickness axis, or each cut's by id when they differ
 */
export function planDovetails(solid, cuts, spec = {}, { passthrough = false, frame = null } = {}) {
  const mode = spec.joint ?? SPLIT_DEFAULTS.joint;
  const joints = {};
  const plates = {};
  const notes = [];
  if (mode === 'none' || mode === 'dowels') {
    for (const cut of cuts) joints[cut.id] = mode;
    return { dove: null, joints, plates, tabs: null, notes };
  }
  const frames = planeFrames(solid, frame);
  const box = boxOf(solid);
  const by = axisCuts(cuts);
  const t = scope();
  try {
    const wOf = {};
    const axisW = [null, null, null];
    const ids = [];
    for (const cut of cuts) {
      const face = faceOf(frames, cut);
      // the plate must stay flat out to the next cuts either side, or the model's ends
      const along = by[cut.axis];
      const i = along.indexOf(cut.at);
      const probes = flatProbes(cut.at, i > 0 ? along[i - 1] : box.min[cut.axis], i < along.length - 1 ? along[i + 1] : box.max[cut.axis]);
      let test;
      try {
        test = plateTest(face, cut, { cuts, passthrough, sliceAt: (at) => t.add(frames.get(cut.axis).slice(at)), probes });
      } finally {
        face.delete();
      }
      plates[cut.id] = test;
      if (test.joint === 'none') {
        joints[cut.id] = 'none';
        const n = test.islands.length;
        notes.push(splitNote('CONNECTORS_DROPPED', { letter: cut.letter, cutId: cut.id, count: n, total: n, wall: 2 }));
      } else if (test.joint === 'dovetail' && (axisW[cut.axis] === null || axisW[cut.axis] === test.w)) {
        axisW[cut.axis] = test.w;
        wOf[cut.id] = test.w;
        ids.push(cut.id);
        joints[cut.id] = 'dovetail';
      } else {
        joints[cut.id] = 'dowels';
        if (mode === 'dovetail' || test.joint === 'dovetail') notes.push(splitNote('DOVETAIL_NOT_PLATE', { letter: cut.letter, cutId: cut.id }));
      }
    }
    if (!ids.length) return { dove: null, joints, plates, tabs: null, notes };
    const shared = new Set(Object.values(wOf)).size === 1;
    const w = shared ? wOf[ids[0]] : wOf;
    const tabs = dovetailTabs(solid, cuts, { ids, w }, { frame: (axis) => frames.get(axis) });
    const kept = [];
    for (const seam of tabs.seams) {
      if (seam.tabs.length) {
        kept.push(seam.cutId);
        continue;
      }
      joints[seam.cutId] = 'none';
      notes.push(splitNote('CONNECTORS_DROPPED', { letter: seam.letter, cutId: seam.cutId, dovetail: true }));
    }
    tabs.seams = tabs.seams.filter((x) => x.tabs.length);
    const clearance = Number.isFinite(spec.clearance) ? spec.clearance : SPLIT_DEFAULTS.clearance;
    const keptW = new Set(kept.map((id) => wOf[id]));
    tabs.w = keptW.size === 1 ? [...keptW][0] : null;
    const dove = kept.length ? { ids: kept, w: keptW.size === 1 ? [...keptW][0] : Object.fromEntries(kept.map((id) => [id, wOf[id]])), clearance } : null;
    return { dove, joints, plates, tabs: kept.length ? tabs : null, notes };
  } finally {
    t.dispose();
    frames.dispose();
  }
}

/** A dovetail cut's plate thickness axis, from `dove.w` (one axis for all, or one per cut id). */
const wOfCut = (dove, id) => (typeof dove.w === 'number' ? dove.w : dove.w?.[id] ?? null);

// ---------- cutting into pieces ----------

/**
 * The model cut into one piece per cell, axis by axis (x, y, z). A planar
 * axis is cut by taking away the boxes over every other cell, then the
 * rest; a dovetail axis by taking away everything outside each cell's
 * solid. Shells under 1e-3 mm³ are removed as dust; every other shell goes
 * to the cell its box overlaps most, and a cell's shells make one piece.
 * Pieces are numbered bottom layer first, then front to back, then left to
 * right. Each comes with its orientation statistics; pieces on a dovetail
 * seam may only lie flat (±w, either plate's where dovetails through two
 * plates meet at a piece), and every piece of a thin plate (`flat`) lies
 * flat on it.
 * @param {Manifold} solid the model (borrowed, never deleted)
 * @param {{ id, letter, axis, at }[]} cuts normalised
 * @param {{ dove?: { ids: string[], w: number|object, clearance: number }|null, tabs?: object|null, bounds?: object,
 *   flat?: number|null, frame?: function, progress?: function }} options `tabs` the tabs `planDovetails` placed for
 *   `dove` (worked out again when missing); `flat` the thickness axis when the whole model is a thin plate (`plateAxis`)
 * @returns {{ pieces: { index: number, cell: number[], solid: Manifold, shells: number, volume: number,
 *   bbox: { min: number[], max: number[] }, cuts: string[], stats: object }[], grid: number[],
 *   dovetails: { cutId, letter, axis, at, w, tabs: number }[], notes: object[], dust: number, gap: number, volume: number }}
 *   the piece solids belong to the caller; `gap` is the volume the dovetail clearances took, `dust` the slivers removed
 * @throws {SplitError} `INTERNAL` when a piece comes out broken
 */
export function cutPieces(solid, cuts, { dove = null, tabs = null, bounds = null, flat = null, frame = null, progress = null } = {}) {
  const { Manifold } = manifold();
  const box = bounds ?? boxOf(solid);
  const by = axisCuts(cuts);
  const notes = [];
  const temps = scope();
  const owned = new Set();
  const own = (m) => {
    owned.add(m);
    return m;
  };
  const drop = (m) => {
    if (owned.delete(m)) m.delete();
  };
  try {
    const plan = dove?.ids?.length ? tabs ?? dovetailTabs(solid, cuts, dove, { frame }) : null;
    const doveAxes = plan ? dovetailCells(plan, cuts, box, dove.clearance) : [];
    doveAxes.forEach((x) => x.cells.forEach((c) => temps.add(c.solid)));
    const doveCuts = new Map((plan?.seams ?? []).map((x) => [x.cutId, x]));
    // a dovetail cell's piece is likewise what is left when everything outside the cell is taken away (see below)
    const room = temps.add(temps.add(Manifold.cube(box.max.map((v, k) => v - box.min[k] + 4), true)).translate(box.min.map((v, k) => (v + box.max[k]) / 2)));
    const outside = new Map();
    const outsideOf = (cell) => {
      if (!outside.has(cell)) outside.set(cell, temps.add(room.subtract(cell.solid)));
      return outside.get(cell);
    };

    let parts = [solid];
    let gap = 0;
    const axesUsed = [0, 1, 2].filter((a) => by[a].length);
    axesUsed.forEach((a, done) => {
      progress?.('Cutting into pieces…', { done, total: axesUsed.length });
      const ts = by[a];
      const dax = doveAxes.find((x) => x.axis === a);
      const next = [];
      if (dax) {
        const near = dax.reach + 1;
        for (const p of parts) {
          const pb = boxOf(p);
          if (!ts.some((t) => t > pb.min[a] - near && t < pb.max[a] + near)) {
            next.push(p);
            continue;
          }
          const before = p.volume();
          let after = 0;
          for (const cell of dax.cells) {
            if (cell.max + near < pb.min[a] || cell.min - near > pb.max[a]) continue;
            const q = p.subtract(outsideOf(cell));
            if (q.isEmpty()) q.delete();
            else {
              after += q.volume();
              next.push(own(q));
            }
          }
          gap += before - after;
          drop(p);
        }
      } else {
        const lo = box.min[a] - 1;
        const hi = box.max[a] + 1;
        const edges = [lo, ...ts, hi];
        const size = box.max.map((v, k) => v - box.min[k] + 4);
        const centre = box.min.map((v, k) => (v + box.max[k]) / 2);
        // every other cell's slab, and the rest: each side of the cuts is what is left when the other side is
        // taken away. Where a cut lies along a flat face of the model, the intersection `split()` makes leaves a
        // paper-thin flap of that face joined to the piece – no shell of its own, so no dust filter finds it – which
        // spoils the piece's size and file; a subtraction leaves none (and costs about a third more).
        const sides = [0, 1].map((first) => {
          const slabs = [];
          for (let i = first; i < edges.length - 1; i += 2) {
            const sz = [...size];
            sz[a] = edges[i + 1] - edges[i];
            const at = [...centre];
            at[a] = (edges[i] + edges[i + 1]) / 2;
            slabs.push(temps.add(temps.add(Manifold.cube(sz, true)).translate(at)));
          }
          return temps.add(Manifold.compose(slabs));
        });
        for (const p of parts) {
          const pb = boxOf(p);
          if (!ts.some((t) => t > pb.min[a] + CUT_TOLERANCE && t < pb.max[a] - CUT_TOLERANCE)) {
            next.push(p);
            continue;
          }
          for (const other of sides) {
            const q = p.subtract(other);
            if (q.isEmpty()) q.delete();
            else next.push(own(q));
          }
          drop(p);
        }
      }
      parts = next;
    });

    let dust = 0;
    let dustCount = 0;
    const shells = [];
    for (const p of parts) {
      const list = p.decompose();
      drop(p);
      for (const m of list) {
        const v = m.volume();
        if (v < DUST) {
          dust += Math.max(0, v);
          dustCount++;
          m.delete();
        } else shells.push({ m: own(m), v, box: boxOf(m) });
      }
    }
    if (dustCount) notes.push(splitNote('SLIVER_REMOVED', { count: dustCount }));

    const groups = new Map();
    for (const sh of shells) {
      const cell = cellOf(sh.box, by);
      const key = cell.join(',');
      if (!groups.has(key)) groups.set(key, { cell, list: [] });
      groups.get(key).list.push(sh);
    }
    const ordered = [...groups.values()].sort((p, q) => p.cell[2] - q.cell[2] || p.cell[1] - q.cell[1] || p.cell[0] - q.cell[0]);
    const pieces = ordered.map(({ cell, list }, n) => {
      let m = list[0].m;
      if (list.length > 1) {
        m = own(Manifold.compose(list.map((x) => x.m)));
        list.forEach((x) => drop(x.m));
      }
      const index = n + 1;
      const status = m.status();
      if (status !== 'NoError') throw new SplitError('INTERNAL', `Piece ${index} came out broken (${status}).`, { pieceIndex: index, status });
      const bbox = boxOf(m);
      const reachOf = (c) => (doveCuts.has(c.id) ? Math.max(...doveCuts.get(c.id).tabs.map((tb) => tb.E)) : 0);
      const touching = cuts.filter((c) => c.at >= bbox.min[c.axis] - 0.02 - reachOf(c) && c.at <= bbox.max[c.axis] + 0.02 + reachOf(c));
      // a plate lies flat on its thickness; a piece on a dovetail seam on its plate's
      const flatOn = flat !== null ? [flat] : [...new Set(touching.filter((c) => doveCuts.has(c.id)).map((c) => doveCuts.get(c.id).w ?? plan.w))];
      const allowed = flatOn.length ? flatOn.flatMap((a) => [`-${AXES[a]}`, `+${AXES[a]}`]) : undefined;
      const mesh = m.getMesh();
      const stats = orientationStats(mesh.vertProperties, mesh.numProp, mesh.triVerts, touching, allowed ? { allowed } : {});
      return { index, cell, solid: m, shells: list.length, volume: list.reduce((s, x) => s + x.v, 0), bbox, cuts: touching.map((c) => c.id), stats };
    });

    // a piece thinner than 5 mm between its cut faces prints and glues badly
    for (const piece of pieces) {
      let thin = null;
      for (let a = 0; a < 3; a++) {
        const along = cuts.filter((c) => c.axis === a && piece.cuts.includes(c.id));
        const extent = piece.bbox.max[a] - piece.bbox.min[a];
        if (along.length && extent < 5 && (!thin || extent < thin.thickness)) thin = { thickness: extent, along };
      }
      if (thin) {
        notes.push(splitNote('SMALL_PIECE', { pieceIndex: piece.index, thickness: thin.thickness, letters: thin.along.map((c) => c.letter), cutId: thin.along[0].id }));
      }
    }

    const volume = solid.volume();
    const sum = pieces.reduce((s, p) => s + p.volume, 0);
    const ratio = volume > 0 ? (sum + dust + gap - volume) / volume : 0;
    if (Math.abs(ratio) > 1e-4) notes.push(splitNote('SPLIT_CHECK', { ratio }));
    const dovetails = (plan?.seams ?? []).map((x) => ({ cutId: x.cutId, letter: x.letter, axis: x.axis, at: x.at, w: x.w ?? plan.w, tabs: x.tabs.length }));
    for (const p of pieces) owned.delete(p.solid);
    return { pieces, grid: by.map((l) => l.length), dovetails, notes, dust, gap, volume };
  } finally {
    for (const m of owned) m.delete();
    owned.clear();
    temps.dispose();
  }
}

// ---------- room for pins on a cut face ----------

/**
 * The solid within ±(reach + 0.5) mm of a cut, in the cut's plane
 * coordinates: the one full-size boolean of the layout, with a small
 * result. It is 0.5 mm thicker than any slab tested against it, so
 * `project()` never meets coincident faces.
 * @param {Manifold} solid (borrowed)
 * @param {{ axis: number, at: number }} cut
 * @param {number} reach the largest reach the cut may use (mm)
 * @param {{ min: number[], max: number[] }} [bounds] the solid's
 * @returns {Manifold}
 */
export function bandFor(solid, cut, reach, bounds = null) {
  const { Manifold } = manifold();
  const b = bounds ?? boxOf(solid);
  const t = scope();
  try {
    const size = b.max.map((v, k) => v - b.min[k] + 4);
    size[cut.axis] = 2 * (reach + 0.5);
    const centre = b.min.map((v, k) => (v + b.max[k]) / 2);
    centre[cut.axis] = cut.at;
    const slab = t.add(t.add(Manifold.cube(size, true)).translate(centre));
    return t.add(solid.intersect(slab)).transform(TO_PLANE[cut.axis]);
  } finally {
    t.dispose();
  }
}

/**
 * A cut's face split into patches, one per island and per pair of pieces:
 * the face minus a 0.02 mm strip along each crossing cut, patches under
 * 0.5 mm² dropped. A hollow face stays one patch with a hole; a U gives two.
 * @param {Manifold} band from `bandFor` (borrowed)
 * @param {{ axis: number, at: number }} cut
 * @param {{ axis: number, at: number }[]} cuts every cut (those on other axes cross this one)
 * @returns {{ face: CrossSection, patches: { cs: CrossSection, area: number, polygons: number[][][], centroid: number[] }[] }}
 *   in plane coordinates; the caller deletes `face` and every patch's `cs`
 */
export function patchesFor(band, cut, cuts = []) {
  const { CrossSection } = manifold();
  const face = band.slice(cut.at);
  const t = scope();
  try {
    let rest = face;
    if (!face.isEmpty()) {
      const { min, max } = face.bounds();
      const [ua, va] = planeAxes(cut.axis);
      const W = max[0] - min[0] + 20;
      const H = max[1] - min[1] + 20;
      const cu = (min[0] + max[0]) / 2;
      const cv = (min[1] + max[1]) / 2;
      const strips = [];
      for (const c of cuts) {
        if (c.axis === ua && c.at > min[0] && c.at < max[0]) strips.push(t.add(t.add(CrossSection.square([TRACE, H], true)).translate(c.at, cv)));
        if (c.axis === va && c.at > min[1] && c.at < max[1]) strips.push(t.add(t.add(CrossSection.square([W, TRACE], true)).translate(cu, c.at)));
      }
      if (strips.length) rest = t.add(face.subtract(t.add(CrossSection.union(strips))));
    }
    const patches = [];
    for (const cs of rest.decompose()) {
      const area = cs.area();
      if (area < MIN_PATCH) {
        cs.delete();
        continue;
      }
      const polygons = polygonsOf(cs);
      patches.push({ cs, area, polygons, centroid: polygonsCentroid(polygons) });
    }
    return { face, patches };
  } catch (err) {
    face.delete();
    throw err;
  } finally {
    t.dispose();
  }
}

/**
 * Every column of a cut face (in plane coordinates) where a hole of this
 * reach would meet air within ±reach of the face, plus the holes already
 * placed: the hole centres must keep their inset away from it. Exact for
 * hidden pockets, slanted walls and cones, unlike an inset of the face.
 * @param {Manifold} band from `bandFor` (borrowed), at least 0.5 mm thicker than the reach
 * @param {{ axis: number, at: number }} cut
 * @param {number} reach (mm)
 * @param {{ obstacles?: Manifold[], air?: boolean }} options `obstacles` the holes placed so far, in world
 *   coordinates (borrowed), each a valid solid on its own (disjoint shells composed together are fine);
 *   `air: false` leaves out the air and gives the obstacles' shadow alone (the air's is the costly part on a big
 *   model, and the same for every set of obstacles)
 * @returns {CrossSection}
 */
export function shadowFor(band, cut, reach, { obstacles = [], air = true } = {}) {
  const { CrossSection, Manifold } = manifold();
  const t = scope();
  try {
    if (band.isEmpty()) return CrossSection.square([0, 0]); // empty (new CrossSection([]) throws)
    const { min, max } = band.boundingBox();
    const slab = t.add(t.add(Manifold.cube([max[0] - min[0] + 4, max[1] - min[1] + 4, 2 * reach], true)).translate([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, cut.at]));
    let shadow = air ? t.add(t.add(slab.subtract(band)).project()) : t.add(CrossSection.square([0, 0]));
    for (const obstacle of obstacles ?? []) {
      if (obstacle.isEmpty()) continue;
      const inPlane = t.add(obstacle.transform(TO_PLANE[cut.axis]));
      shadow = t.add(shadow.add(t.add(t.add(inPlane.intersect(slab)).project())));
    }
    return shadow.translate(0, 0);
  } finally {
    t.dispose();
  }
}

/**
 * Every dovetail tab's column through the model (world): the tab grown by
 * its socket's clearance and corner rounding, extruded along w right
 * through the model as the cells are. Where a tab reaches, its piece and
 * the neighbour's socket change places at every height, so no pin hole of
 * another cut may run into it.
 */
function socketsOf(plan, cuts, bounds, clearance) {
  const { Manifold } = manifold();
  const t = scope();
  try {
    const columns = [];
    for (const seam of plan.seams) {
      const w = seam.w ?? plan.w;
      for (const tab of seam.tabs) {
        const section = t.add(tabSection(tab, seam.at, seam.axis, w, clearance / 2 + TAB_ROUND, 'Round'));
        const prism = t.add(t.add(extrudeSection(section, bounds.max[w] - bounds.min[w] + 2)).translate([0, 0, bounds.min[w] - 1]));
        columns.push(t.add(prism.transform(TO_WORLD[w])));
      }
    }
    return Manifold.union(columns);
  } finally {
    t.dispose();
  }
}

/** How far a cut's holes may reach: to the nearest parallel cut, or the model's end, on the nearer side. */
function roomAround(cut, by, bounds) {
  const list = by[cut.axis];
  const below = list.filter((t) => t < cut.at - CUT_TOLERANCE);
  const above = list.filter((t) => t > cut.at + CUT_TOLERANCE);
  const lo = below.length ? below[below.length - 1] : bounds.min[cut.axis];
  const hi = above.length ? above[0] : bounds.max[cut.axis];
  return Math.min(cut.at - lo, hi - cut.at);
}

/**
 * The pins and labels of a split, cut by cut in canonical order. For each
 * cut: the band of solid round it, the face's patches (one per pair of
 * pieces), the exact shadow of air and of holes placed by earlier cuts,
 * and hole depths capped by the parallel cuts either side. With an
 * automatic diameter a sizing pass first picks one size for the whole
 * model (the largest of 8, 6, 5, 4, 3 mm that takes two pins on every
 * patch that can take any, at most a third of its width). Then each patch
 * gets its pins, falling back to shallower holes, then 1.75 mm filament,
 * then glue only; at most 48 pins in all, larger patches first. Labels
 * ("2A") go on each pinned face, in the same spot on both pieces.
 * @param {Manifold} solid the model (borrowed)
 * @param {{ id, letter, axis, at }[]} cuts normalised, in canonical order
 * @param {{ index: number, cell: number[], up?: string }[]} pieces from `cutPieces`, with the way each prints up
 *   (`chooseOrientation(...).up`); a hole is a teardrop on a piece whose up is not along the cut
 * @param {object} spec the normalised settings (diameter, depth, clearance, count, labels)
 * @param {{ nozzle?: number, joints?: Object<string, string>, tabs?: object|null, font?: object, bounds?: object, progress?: function }} options
 *   `joints` per cut id (from `planDovetails`; dowels when missing); `tabs` its dovetail tabs, whose sockets reach past
 *   their cut right through the model, so the holes of a crossing cut keep out of them as out of an earlier cut's
 *   holes; `font` the labels' (Inter), labels are skipped without it
 * @returns {{ diameter: number|null, dowels: object[], labels: object[], seams: object[], notes: object[] }}
 *   dowel `{ cutId, letter, patch, axis, at, centre, uv, d, depth, R, h, ch, cell, sides: [{ piece, tear, apex }, …] }`
 *   (side 0 the lower piece, `cell` the pin's half-cell for the exploded view);
 *   label `{ cutId, letter, patch, axis, at, size, centre, uv, sides: [{ piece, text, outward }, …] }`;
 *   seam `{ cutId, letter, axis, at, pieces: [lo, hi], joint, patches, dowels, labels: [text, text]|null }`
 */
export function layoutSplit(solid, cuts, pieces, spec = {}, options = {}) {
  const { CrossSection, Manifold } = manifold();
  const { nozzle = 0.4, joints = {}, tabs = null, font = null, progress = null } = options;
  const bounds = options.bounds ?? boxOf(solid);
  const by = axisCuts(cuts);
  const c = Number.isFinite(spec.clearance) ? spec.clearance : SPLIT_DEFAULTS.clearance;
  const depth = Number(spec.depth) > 0 ? Number(spec.depth) : 0;
  const manual = Number(spec.diameter) > 0 ? Number(spec.diameter) : 0;
  const wanted = Number(spec.count) > 0 ? Math.round(Number(spec.count)) : 0;
  const labelsOn = spec.labels !== false && Boolean(font);
  const pieceAt = new Map(pieces.map((p) => [p.cell.join(','), p]));
  const reachMax = Math.max(LABEL_REACH, sizesFor(manual || AUTO_DIAMETERS[0], c, nozzle, depth).reach);
  const notes = [];
  const dowels = [];
  const labels = [];
  const contexts = [];
  const placed = []; // { m, side, box }: every half-hole placed so far, world
  const keep = scope(); // bands, patches, shadows and obstacles that live until the layout is done

  /** A cut's shadow at a reach, kept for the layout: the air's once per reach, the earlier holes' added on top. */
  const shadowAt = (ctx, reach, withObstacles) => {
    const key = reach.toFixed(4);
    if (!ctx.shadows.has(key)) ctx.shadows.set(key, keep.add(shadowFor(ctx.band, ctx.cut, reach)));
    if (!withObstacles || !ctx.obstacles.length) return ctx.shadows.get(key);
    if (!ctx.shadows.has(`${key}|holes`)) {
      const holes = keep.add(shadowFor(ctx.band, ctx.cut, reach, { obstacles: ctx.obstacles, air: false }));
      ctx.shadows.set(`${key}|holes`, keep.add(ctx.shadows.get(key).add(holes)));
    }
    return ctx.shadows.get(`${key}|holes`);
  };

  /** Pin centres for a patch at these sizes, or none. */
  const centresFor = (ctx, patch, s, n, withObstacles, t) => {
    const free = t.add(patch.cs.subtract(shadowAt(ctx, s.reach, withObstacles)));
    const tear = patch.apex.some(Boolean);
    const safe = t.add(free.offset(-(tear ? s.rhoTear : s.rho), 'Round', 2, 32));
    if (safe.isEmpty()) return [];
    return chooseCentres(polygonsOf(safe), n, s.sMin, patch.centroid, { d: s.d });
  };

  /**
   * The sizing pass: per patch of at least 50 mm², the largest standard
   * size with D ≤ W/3 (W twice the deepest inset of the patch's solid
   * columns) that takes two pins, first against the shadow of the Ø8
   * reach, which is conservative for every size; patches that find none
   * try again with each size's own reach. The model's size is the
   * smallest found. Null when no patch takes any.
   */
  function sizePass(list) {
    let best = null;
    const need = Math.min(2, wanted || 2);
    const widest = sizesFor(AUTO_DIAMETERS[0], c, nozzle, depth);
    const widthCap = (3 * AUTO_DIAMETERS[0]) / 2; // D ≤ W/3, so no width beyond 3 × 8 mm changes the answer
    for (const ctx of list) {
      for (const patch of ctx.patches) {
        if (patch.skip || patch.area < SIZING_PATCH) continue;
        const t = scope();
        try {
          let found = null;
          const free = t.add(patch.cs.subtract(shadowAt(ctx, widest.reach, false)));
          const W = 2 * largestInset(free, widthCap);
          for (const D of AUTO_DIAMETERS) {
            const s = sizesForRoom(D, c, nozzle, depth, ctx.room);
            if (!s || D > W / 3 + 1e-9) continue;
            const tear = patch.apex.some(Boolean);
            const safe = t.add(free.offset(-(tear ? s.rhoTear : s.rho), 'Round', 2, 32));
            if (!safe.isEmpty() && chooseCentres(polygonsOf(safe), need, s.sMin, patch.centroid, { d: D }).length >= need) {
              found = D;
              break;
            }
          }
          if (found === null) {
            const small = sizesForRoom(AUTO_DIAMETERS[AUTO_DIAMETERS.length - 1], c, nozzle, depth, ctx.room);
            const W3 = small ? 2 * largestInset(t.add(patch.cs.subtract(shadowAt(ctx, small.reach, false))), widthCap) : 0;
            for (const D of AUTO_DIAMETERS) {
              const s = sizesForRoom(D, c, nozzle, depth, ctx.room);
              if (!s || D > W3 / 3 + 1e-9) continue;
              if (centresFor(ctx, patch, s, need, false, t).length >= need) {
                found = D;
                break;
              }
            }
          }
          if (found !== null) best = best === null ? found : Math.min(best, found);
        } finally {
          t.dispose();
        }
      }
    }
    return best;
  }

  /** The pins of one cut: each patch tries its options in turn; the notes say what had to give. */
  function layoutCut(ctx, D) {
    const { cut } = ctx;
    const a = cut.axis;
    const full = D === FILAMENT ? sizesFor(FILAMENT, c, nozzle, depth).depth : sizesFor(D, c, nozzle, depth).depth;
    const tries = D === FILAMENT
      ? [[FILAMENT, depth], [FILAMENT, 3]]
      : [[D, depth], [D, sizesFor(D, c, nozzle).minDepth], [FILAMENT, 4], [FILAMENT, 3]];
    let shorter = null;
    let filament = null;
    let one = false;
    let dropped = 0;
    let total = 0;
    let suggested = null;
    const suggest = (d) => {
      if (d) suggested = Math.max(suggested ?? 0, d);
    };
    // the thinnest wall filament fits in: twice its inset from the edge, a teardrop's when the holes lie on their side
    let thinWalls = 0;
    const fil = sizesFor(FILAMENT, c, nozzle);
    ctx.patches.forEach((patch, patchIndex) => {
      if (patch.skip || patch.capped || !patch.alloc) return;
      total++;
      const need = Math.min(2, patch.alloc);
      const t = scope();
      try {
        let chosen = null;
        let single = null;
        const seen = new Set();
        for (const [d, dep] of tries) {
          const s = sizesForRoom(d, c, nozzle, dep, ctx.room);
          if (!s || seen.has(`${d}|${s.depth}`)) continue;
          seen.add(`${d}|${s.depth}`);
          const pts = centresFor(ctx, patch, s, patch.alloc, true, t);
          if (pts.length >= need) {
            chosen = { s, pts };
            break;
          }
          if (pts.length === 1 && !single) single = { s, pts };
        }
        chosen ??= single;
        if (!chosen) {
          dropped++;
          // what to say about it: slivers are glued and need no explaining
          if (patch.area >= SIZING_PATCH) {
            const need = 2 * (patch.apex.some(Boolean) ? fil.rhoTear : fil.rho);
            if (2 * largestInset(patch.cs, need / 2 + 0.05) < need) thinWalls = Math.max(thinWalls, Math.ceil(need * 10 - 1e-6) / 10);
            suggest(smallerFit(ctx, patch, D, need, t));
          }
          return;
        }
        const { s, pts } = chosen;
        if (pts.length < need) one = true;
        if (s.d === FILAMENT && D !== FILAMENT) {
          filament = { count: (filament?.count ?? 0) + pts.length, length: Math.max(filament?.length ?? 0, 2 * s.depth) };
          suggest(smallerFit(ctx, patch, D, need, t));
        } else if (s.depth < full - 1e-9) shorter = Math.min(shorter ?? Infinity, s.depth);
        for (const [u, v] of pts) {
          const cell = cellOfPoint(applyMat4(TO_WORLD[a], [u, v, cut.at]), by);
          cell[a] += 0.5;
          const dowel = {
            cutId: cut.id,
            letter: cut.letter,
            patch: patchIndex,
            axis: a,
            at: cut.at,
            centre: applyMat4(TO_WORLD[a], [u, v, cut.at]),
            uv: [u, v],
            d: s.d,
            depth: s.depth,
            R: s.R,
            h: s.h,
            ch: s.ch,
            cell,
            sides: [patch.lo, patch.hi].map((piece, k) => ({ piece: piece.index, tear: Boolean(patch.apex[k]), apex: patch.apex[k] })),
          };
          patch.dowels.push(dowel);
          dowels.push(dowel);
        }
      } finally {
        t.dispose();
      }
    });
    const base = { letter: cut.letter, cutId: cut.id };
    if (shorter !== null) notes.push(splitNote('CONNECTORS_SHORTER', { ...base, depth: shorter }));
    if (filament) notes.push(splitNote('CONNECTORS_FILAMENT', { ...base, count: filament.count, diameter: D, length: filament.length, ...(suggested ? { suggestedDiameter: suggested } : {}) }));
    if (dropped) {
      notes.push(splitNote('CONNECTORS_DROPPED', { ...base, count: dropped, total, ...(thinWalls ? { wall: thinWalls } : {}), ...(suggested && !filament ? { suggestedDiameter: suggested } : {}) }));
    }
    if (one) notes.push(splitNote('ONE_CONNECTOR', base));
  }

  /** The largest standard size under D that would take the patch's pins, for a note's suggestion; null when none. */
  function smallerFit(ctx, patch, D, need, t) {
    for (const d of AUTO_DIAMETERS) {
      if (d >= D) continue;
      for (const dep of [depth, sizesFor(d, c, nozzle).minDepth]) {
        const s = sizesForRoom(d, c, nozzle, dep, ctx.room);
        if (s && centresFor(ctx, patch, s, need, true, t).length >= need) return d;
      }
    }
    return null;
  }

  /** A text's label at a size: its half-extents, and whether its strokes are too thin to engrave with this nozzle. */
  function shapeOf(text, size) {
    const entry = labelEntry(font, text, size);
    if (!entry) return null;
    if (!entry.thin.has(nozzle)) entry.thin.set(nozzle, thinStrokeReport(entry.cs, printLimits({ nozzle, mode: 'engrave' })).thin);
    return { hx: entry.hx, hy: entry.hy, thin: entry.thin.get(nozzle) };
  }

  /**
   * A label for each side of a pinned patch, at the same spot: the largest
   * size (8 mm down to 3 mm) whose text, with 1 mm round it, fits the
   * room left on the face, the spot nearest the face's centroid.
   */
  function placeLabel(ctx, patch) {
    const { cut } = ctx;
    const a = cut.axis;
    const texts = [`${patch.lo.index}${cut.letter}`, `${patch.hi.index}${cut.letter}`];
    const outward = [`+${AXES[a]}`, `-${AXES[a]}`];
    const tear = patch.apex.some(Boolean);
    const t = scope();
    try {
      const shadow = shadowAt(ctx, LABEL_REACH, true);
      const free = t.add(patch.cs.subtract(shadow));
      const W = 2 * largestInset(free, LABEL_LARGEST);
      let room = t.add(t.add(patch.cs.offset(-LABEL_EDGE, 'Round', 2, 32)).subtract(shadow));
      const circles = patch.dowels.map((d) => {
        const mouth = (d.R + d.ch) * POLYGON_K;
        return t.add(t.add(CrossSection.circle((tear ? Math.SQRT2 * mouth : mouth) + LABEL_HOLE_GAP, 32)).translate(d.uv[0], d.uv[1]));
      });
      if (circles.length) room = t.add(room.subtract(t.add(CrossSection.union(circles))));
      if (room.isEmpty()) return null;
      const roomPolys = polygonsOf(room);
      const [ua] = planeAxes(a);
      for (let size = Math.min(LABEL_LARGEST, W / 2); size >= LABEL_SMALLEST - 1e-9; size -= 1) {
        const looks = texts.map((text) => shapeOf(text, size));
        if (looks.some((s) => !s || s.thin)) continue;
        // each side's text, with its margin, as half-extents along u and v (the frames are signed permutations)
        let hu = 0;
        let hv = 0;
        looks.forEach((look, k) => {
          const X = labelFrame(outward[k], a, [0, 0, 0]).slice(0, 3);
          const alongU = Math.abs(X[ua]) > 0.5;
          hu = Math.max(hu, (alongU ? look.hx : look.hy) + LABEL_MARGIN);
          hv = Math.max(hv, (alongU ? look.hy : look.hx) + LABEL_MARGIN);
        });
        const inner = t.add(room.offset(-Math.min(hu, hv), 'Round', 2, 16));
        if (inner.isEmpty()) continue;
        const step = clamp(Math.sqrt(inner.area()) / 30, 0.25, 2);
        const [cu, cv] = patch.centroid ?? [0, 0];
        const candidates = gridPoints(polygonsOf(inner), step).sort((p, q) => Math.hypot(p[0] - cu, p[1] - cv) - Math.hypot(q[0] - cu, q[1] - cv));
        for (const [u, v] of candidates) {
          const corners = [[u - hu, v - hv], [u + hu, v - hv], [u + hu, v + hv], [u - hu, v + hv]];
          if (!corners.every(([x, y]) => insidePolygons(roomPolys, x, y))) continue;
          const rect = t.add(t.add(CrossSection.square([2 * hu, 2 * hv], true)).translate(u, v));
          if (t.add(rect.subtract(room)).area() >= 0.01) continue;
          const centre = applyMat4(TO_WORLD[a], [u, v, cut.at]);
          return {
            cutId: cut.id,
            letter: cut.letter,
            patch: ctx.patches.indexOf(patch),
            axis: a,
            at: cut.at,
            size,
            centre,
            uv: [u, v],
            sides: [patch.lo, patch.hi].map((piece, k) => ({ piece: piece.index, text: texts[k], outward: outward[k] })),
          };
        }
      }
      return null;
    } finally {
      t.dispose();
    }
  }

  // the stage is told from the start: on a dense model the bands and the sizing pass take seconds before any pin is placed
  const pinCuts = cuts.filter((cut) => (joints[cut.id] ?? (spec.joint === 'none' ? 'none' : 'dowels')) === 'dowels').length;
  const steps = cuts.length + 1 + pinCuts;
  try {
    // ---- every cut's face, its patches and the pieces either side ----
    for (const cut of cuts) {
      progress?.('Finding room for pins…', { done: contexts.length, total: steps });
      const joint = joints[cut.id] ?? (spec.joint === 'none' ? 'none' : 'dowels');
      const band = keep.add(bandFor(solid, cut, joint === 'dowels' ? reachMax : 0.5, bounds));
      const { face, patches } = patchesFor(band, cut, cuts);
      face.delete();
      const a = cut.axis;
      const lo = by[a].indexOf(cut.at);
      for (const patch of patches) {
        keep.add(patch.cs);
        const [u, v] = insidePoint(patch.polygons, patch.centroid);
        const cell = cellOfPoint(applyMat4(TO_WORLD[a], [u, v, cut.at]), by);
        cell[a] = lo;
        patch.lo = pieceAt.get(cell.join(','));
        cell[a] = lo + 1;
        patch.hi = pieceAt.get(cell.join(','));
        patch.skip = !patch.lo || !patch.hi;
        patch.apex = patch.skip ? [null, null] : [teardropApex(patch.lo.up ?? '+z', a), teardropApex(patch.hi.up ?? '+z', a)];
        patch.dowels = [];
        patch.label = null;
        patch.alloc = 0;
      }
      contexts.push({ cut, joint, band, patches, room: roomAround(cut, by, bounds), shadows: new Map(), obstacles: [] });
    }
    const pinned = contexts.filter((x) => x.joint === 'dowels');
    const sockets = pinned.length && tabs?.seams?.some((x) => x.tabs.length) ? keep.add(socketsOf(tabs, cuts, bounds, c)) : null;

    // ---- one diameter for the whole model ----
    progress?.('Finding room for pins…', { done: cuts.length, total: steps });
    const D = manual || sizePass(pinned) || AUTO_DIAMETERS[AUTO_DIAMETERS.length - 1];

    // ---- at most 48 pins: every patch its first two, larger patches first, then the rest the same way ----
    const asks = pinned.flatMap((ctx) => ctx.patches.filter((p) => !p.skip).map((patch) => ({ patch, n: wanted || clamp(1 + Math.round(patch.area / 1500), 2, 6) })));
    asks.sort((p, q) => q.patch.area - p.patch.area);
    let left = SPLIT_LIMITS.dowels;
    let capped = 0;
    for (const ask of asks) {
      const first = Math.min(2, ask.n);
      if (left >= first) {
        ask.patch.alloc = first;
        left -= first;
      } else {
        ask.patch.capped = true;
        capped++;
      }
    }
    for (const { patch, n } of asks) {
      if (patch.capped) continue;
      const more = Math.min(n - patch.alloc, left);
      patch.alloc += more;
      left -= more;
    }

    // ---- pins, cut by cut, each cut avoiding the holes of the ones before and the dovetail sockets ----
    pinned.forEach((ctx, done) => {
      progress?.('Finding room for pins…', { done: cuts.length + 1 + done, total: steps });
      const a = ctx.cut.axis;
      // the two halves of one hole overlap at the face, so each side's halves are composed (and projected) apart
      ctx.obstacles = [0, 1].map((side) => {
        const near = placed.filter((x) => x.side === side && x.box.max[a] > ctx.cut.at - reachMax && x.box.min[a] < ctx.cut.at + reachMax);
        return near.length ? keep.add(Manifold.compose(near.map((x) => x.m))) : null;
      }).filter(Boolean);
      if (sockets) ctx.obstacles.push(sockets);
      layoutCut(ctx, D);
      for (const dowel of dowels.filter((x) => x.cutId === ctx.cut.id)) {
        for (const side of [0, 1]) {
          const m = keep.add(dowelHole(dowel, side));
          placed.push({ m, side, box: boxOf(m) });
        }
      }
    });
    if (capped) notes.push(splitNote('DOWELS_CAPPED', { placed: dowels.length, dropped: capped }));

    // ---- labels ----
    if (labelsOn) {
      progress?.('Engraving labels…');
      const skipped = [];
      for (const ctx of pinned) {
        let missing = false;
        for (const patch of ctx.patches) {
          if (patch.skip || !patch.dowels.length) continue;
          patch.label = placeLabel(ctx, patch);
          if (patch.label) labels.push(patch.label);
          else missing = true;
        }
        if (missing) skipped.push(ctx.cut.letter);
      }
      if (skipped.length) notes.push(splitNote('LABELS_SKIPPED', { letters: skipped }));
    }

    // ---- one seam per pair of pieces across each cut ----
    const seams = [];
    for (const ctx of contexts) {
      const pairs = new Map();
      for (const patch of ctx.patches) {
        if (patch.skip) continue;
        const key = `${patch.lo.index}|${patch.hi.index}`;
        if (!pairs.has(key)) {
          const { id: cutId, letter, axis, at } = ctx.cut;
          pairs.set(key, { cutId, letter, axis, at, pieces: [patch.lo.index, patch.hi.index], joint: ctx.joint, patches: 0, dowels: [], labels: null });
        }
        const seam = pairs.get(key);
        seam.patches++;
        seam.dowels.push(...patch.dowels);
        if (patch.label && !seam.labels) seam.labels = patch.label.sides.map((s) => s.text);
      }
      for (const seam of pairs.values()) {
        if (seam.joint === 'dowels' && !seam.dowels.length) seam.joint = 'none';
        seams.push(seam);
      }
    }
    return { diameter: pinned.length ? D : null, dowels, labels, seams, notes };
  } finally {
    keep.dispose();
  }
}

// ---------- drilling ----------

/**
 * A piece with its own half-holes and labels taken out: one boolean, the
 * cutters being disjoint by construction (pin spacing, label room). A
 * piece with nothing to drill comes back as a copy.
 * @param {Manifold} solid the piece (borrowed)
 * @param {{ dowels: object[], labels: object[] }} layout from `layoutSplit`
 * @param {number} pieceIndex the piece's number (1-based)
 * @param {{ font?: object }} options the labels' font (needed when the piece has labels)
 * @returns {Manifold}
 * @throws {SplitError} `INTERNAL` when the drilled piece comes out broken
 */
export function drillPiece(solid, layout, pieceIndex, { font = null } = {}) {
  const { Manifold } = manifold();
  const t = scope();
  try {
    const cutters = [];
    for (const dowel of layout.dowels ?? []) {
      dowel.sides.forEach((s, k) => {
        if (s.piece === pieceIndex) cutters.push(t.add(dowelHole(dowel, k)));
      });
    }
    for (const label of layout.labels ?? []) {
      for (const s of label.sides) {
        if (s.piece !== pieceIndex) continue;
        if (!font) throw new Error('drillPiece needs the labels\' font.');
        const m = labelSolid({ text: s.text, size: label.size, font, centre: label.centre, outward: s.outward, axis: label.axis });
        if (m) cutters.push(t.add(m));
      }
    }
    if (!cutters.length) return solid.translate(0, 0, 0);
    const drilled = solid.subtract(t.add(Manifold.compose(cutters)));
    const status = drilled.status();
    if (status !== 'NoError') {
      drilled.delete();
      throw new SplitError('INTERNAL', `Piece ${pieceIndex} came out broken when drilled (${status}).`, { pieceIndex, status });
    }
    return drilled;
  } finally {
    t.dispose();
  }
}

// ---------- the pieces view ----------

/**
 * Display buffers for the pieces view: each entry's `displayBuffers` laid
 * end to end, vertex ids shifted, so every piece (and pin, and part) is one
 * contiguous range the viewer can move on its own. No BVH, so the ranges
 * stay in order.
 * @param {{ solid?: Manifold|null, soup?: Float32Array|null, part?: object }[]} entries solids borrowed; `soup` unrepaired
 *   triangles of that piece; `part` what the range is (`{ kind: 'piece', index }`, `{ kind: 'pin', cell }`, …)
 * @returns {{ positions: Float32Array, normals: Float32Array, index: Uint32Array, passthroughStart: number,
 *   passthroughRanges: number[][], ranges: number[][], parts: object[], bvhRoots: [] }}
 *   ranges `[triStart, triCount, vertStart, vertCount]`, one per entry
 */
export function buildSplitDisplay(entries) {
  const built = entries.map(({ solid = null, soup = null }) => displayBuffers(solid, soup));
  const verts = built.reduce((n, b) => n + b.positions.length / 3, 0);
  const tris = built.reduce((n, b) => n + b.index.length / 3, 0);
  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  const index = new Uint32Array(tris * 3);
  const ranges = [];
  const passthroughRanges = [];
  let v0 = 0;
  let t0 = 0;
  built.forEach((b) => {
    const nv = b.positions.length / 3;
    const nt = b.index.length / 3;
    positions.set(b.positions, v0 * 3);
    normals.set(b.normals, v0 * 3);
    for (let i = 0; i < b.index.length; i++) index[t0 * 3 + i] = b.index[i] + v0;
    ranges.push([t0, nt, v0, nv]);
    if (b.passthroughStart < nt) passthroughRanges.push([t0 + b.passthroughStart, nt - b.passthroughStart]);
    v0 += nv;
    t0 += nt;
  });
  return {
    positions,
    normals,
    index,
    passthroughStart: passthroughRanges.length ? passthroughRanges[0][0] : tris,
    passthroughRanges,
    ranges,
    parts: entries.map((e) => e.part ?? null),
    bvhRoots: [],
  };
}
