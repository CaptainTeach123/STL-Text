/**
 * Split for printing, the solid half: the Manifold builders behind it. Holes,
 * pins, built-in square pegs and their sockets, the lips and grooves of the
 * cuts that come apart, the fit test, dovetail tabs through thin plates,
 * cutting the model into one piece per cell, finding room for lips, pins,
 * pegs and labels on each cut face, and drilling the pieces. Every function
 * takes Manifolds and plain specs and returns Manifolds or plain data; the
 * rules themselves (sizes, frames, where pins and pegs go, how pieces lie,
 * notes) live in split.js.
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
  AUTO_PEGS,
  AXES,
  CLIP,
  CUT_TOLERANCE,
  FILAMENT,
  HOLE_SEGMENTS,
  LIP,
  POLYGON_K,
  PLATE_THICKNESS,
  SPLIT_DEFAULTS,
  SPLIT_LIMITS,
  SplitError,
  TO_PLANE,
  TO_WORLD,
  applyMat4,
  axisCuts,
  boxesBeside,
  catchSizes,
  clipShape,
  cellOf,
  cellOfPoint,
  cellSupport,
  chooseCentres,
  gridPoints,
  liesFlat,
  lipMale,
  lipReach,
  lipSizesFor,
  localFrame,
  mergeStats,
  mulMat4,
  oppositeDir,
  orientationStats,
  pegSizeOf,
  pegSizesFor,
  pegSizesForRoom,
  polygonsCentroid,
  dovetailSize,
  flatProbes,
  sizesFor,
  sizesForRoom,
  smallPieceNotes,
  splitNote,
  teardropApex,
  translationMat4,
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
/**
 * How deep behind its face a built-in peg's own piece must be solid (mm): the peg starts 0.5 mm inside it, and a
 * wall's thickness under that keeps it on material, not on a skin over a pocket or the sliver of a shelf a cut leaves.
 * Only the socket runs deep, into the other piece.
 */
const pegRoot = (s) => 0.5 + s.wall;

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

// half-holes, pins, pegs and sockets by size (a split uses one or two sizes many times), and label texts by font, text
// and size
const HOLES = keptShapes(16);
const PINS = keptShapes(16);
const PEGS = keptShapes(16);
const LABELS = keptShapes(64, (e) => {
  e?.cs?.delete();
  e?.solid?.delete();
});
// a lip's tongue and groove by its plan: drilling each piece again takes them again
const LIPS = keptShapes(16, (e) => {
  e?.tongue?.delete();
  e?.cutters?.delete();
});

/** Deletes the shapes kept between calls (when the engine lets go of everything it holds). */
export function clearSplitCaches() {
  HOLES.clear();
  PINS.clear();
  PEGS.clear();
  LABELS.clear();
  LIPS.clear();
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
 * hole (as on a piece printed on its side) and one pin; for built-in pegs
 * instead a block with one peg and a block with its socket, both lying on
 * their side as a bar's halves print them; for dovetails two small plates
 * with one tab (N = 6). Filament and your own dowels get no pin. Where a
 * cut comes apart, a small closed box (60 × 30 × 24 mm, 4 mm walls, a 2 mm
 * floor and top) cut at 12 mm, with the same lip, clips and key at the same
 * clearance: the box standing upright, its lid on its cut face, as the
 * pieces of a lantern print. A wider nozzle's lip is thicker and its groove
 * reaches further, so there the walls are ten lines thick round the same
 * inside and the lid as tall as the full lip needs: the lid gets the clips
 * the model's lip has. In a row with 5 mm gaps, centred, standing on z = 0.
 * @param {object} spec the split settings: diameter (0 = 5 mm; with pegs, the peg's side), depth, clearance, pins, joint
 * @param {number} nozzle
 * @param {{ dovetail?: boolean, pins?: boolean, pegs?: boolean, apart?: string|null }} options `dovetail` adds the
 *   plates (default: when the joint is set to dovetails); `pins: false` leaves the blocks and the pin out, for a split
 *   held by tabs or lips alone; `pegs` gives the peg and socket blocks in their place (default: when the joint is set
 *   to built-in pegs); `apart` the hold of a cut that comes apart, for the box and its lid
 * @returns {Manifold}
 */
export function fitTestCoupon(spec = {}, nozzle = 0.4, { dovetail = spec.joint === 'dovetail', pins = true, pegs = spec.joint === 'pegs', apart = null } = {}) {
  const { Manifold } = manifold();
  const t = scope();
  try {
    const D = Number(spec.diameter) > 0 ? Number(spec.diameter) : 5;
    const c = Number.isFinite(spec.clearance) ? spec.clearance : SPLIT_DEFAULTS.clearance;
    const shells = [];
    if (pegs) {
      const p = pegSizesFor(pegSizeOf(D), c, nozzle, Number(spec.depth) > 0 ? Number(spec.depth) : 0);
      const side = Math.max(20, Math.ceil(2 * p.rho + 2));
      const long = p.h + p.tip + p.wall + 2;
      // each block's face is the plane y = 0, the peg standing out of it along +y with its corners up and down
      const frame = localFrame('+y', '+z', [0, 0, side / 2]);
      const male = t.add(t.add(Manifold.cube([side, side, side])).translate([-side / 2, -side, 0]));
      shells.push(t.add(male.add(t.add(t.add(pegSolid(p)).transform(frame)))));
      const female = t.add(t.add(Manifold.cube([side, long, side])).translate([-side / 2, 0, 0]));
      shells.push(t.add(female.subtract(t.add(t.add(socketSolid(p)).transform(frame)))));
    } else if (pins || (!dovetail && !apart)) {
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
    if (apart) {
      // 4 mm walls and 10 mm inside the lid, or more where the full lip needs them: its groove's reach, and half a
      // millimetre over it, to the mm
      const wall = Math.max(4, Math.round(10 * nozzle * 1e6) / 1e6);
      const R = lipReach(LIP.heights[0], 'opening', c, catchSizes(apart, c)?.i ?? 0, false, nozzle).reach;
      const inside = R < 10 ? 10 : Math.ceil(R + 0.5);
      const [X, Y] = [52 + 2 * wall, 22 + 2 * wall];
      const outside = t.add(t.add(Manifold.cube([X, Y, 14 + inside])).translate([-X / 2, -Y / 2, 0]));
      const closed = t.add(outside.subtract(t.add(t.add(Manifold.cube([52, 22, 10 + inside])).translate([-26, -11, 2]))));
      const lip = lipOnFace(closed, { id: 'fit', letter: 'A', axis: 2, at: 12 }, { c, hold: apart, nozzle });
      const box = t.add(closed.trimByPlane([0, 0, -1], -12));
      const lid = t.add(closed.trimByPlane([0, 0, 1], 12));
      shells.push(lip ? t.add(box.add(t.add(lipAt(lip)))) : box, lip ? t.add(lid.subtract(t.add(lipCavityAt(lip)))) : lid);
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

// ---------- built-in square pegs ----------

/** The corners of a square turned 45°, `r` from its centre along x and y (its half-diagonal), at height z. */
const diamond = (r, z) => [[r, 0, z], [0, r, z], [-r, 0, z], [0, -r, z]];

/**
 * A built-in peg in its own frame: a square of side s turned 45° (its
 * corners on x and y), from 0.5 mm inside the face (z = −0.5, so the union
 * with its piece is clean) to z = L, the last `e` a 45° lead-in. Exactly s
 * square: the clearance is all on the socket.
 * @param {{ s: number, length: number, e: number }} sizes from `pegSizesFor`
 * @returns {Manifold}
 */
export function pegSolid({ s, length, e }) {
  return cachedPeg(s, length, e).translate([0, 0, 0]);
}

/** The peg of these sizes, kept: never delete it, transform or copy it. */
function cachedPeg(s, L, e) {
  return PEGS.get(['peg', s, L, e].join('|'), () => {
    const r = s / Math.SQRT2;
    return manifold().Manifold.hull([...diamond(r, -0.5), ...diamond(r, L - e), ...diamond(r - e * Math.SQRT2, L)]);
  });
}

/**
 * A peg's socket in its own frame: the mouth at z = 0 and the socket running
 * into the piece along +z. It starts 1 mm outside the face (in the air) so
 * the cut is clean; its square (side s + 2c, turned as the peg) opens out by
 * a 45° chamfer of `ch` at the mouth, runs `h` deep and ends in a square
 * pyramid with 45° faces, `tip` high. Like a half-hole, two convex hulls that
 * meet on the bore's corners at z = ch.
 * @param {{ half: number, h: number, ch: number, tip: number }} sizes from `pegSizesFor`
 * @returns {Manifold}
 */
export function socketSolid({ half, h, ch, tip }) {
  return cachedSocket(half, h, ch, tip).translate([0, 0, 0]);
}

/** The socket of these sizes, kept: never delete it, transform or copy it. */
function cachedSocket(half, h, ch, tip) {
  return PEGS.get(['socket', half, h, ch, tip].join('|'), () => {
    const { Manifold } = manifold();
    const t = scope();
    try {
      const r = half * Math.SQRT2;
      const m = (half + ch) * Math.SQRT2;
      const bore = t.add(Manifold.hull([...diamond(r, -1), ...diamond(r, h), [0, 0, h + tip]]));
      const mouth = t.add(Manifold.hull([...diamond(m, -1), ...diamond(m, 0), ...diamond(r, ch)]));
      return Manifold.union([bore, mouth]);
    } finally {
      t.dispose();
    }
  });
}

/** A peg's frame: z along the way it points out of its piece (`dir` along the cut's axis), at its centre on the cut. */
const pegFrame = (peg) => localFrame(`${peg.dir > 0 ? '+' : '-'}${AXES[peg.axis]}`, null, peg.centre);

/**
 * A built-in peg where it stands in the assembled model (world), fused to
 * the piece that carries it; the frame's x and y are world axes, so its
 * corners lie along the cut plane's axes.
 * @param {object} peg from `layoutSplit`
 * @returns {Manifold}
 */
export function pegAt(peg) {
  return cachedPeg(peg.s, peg.length, peg.e).transform(pegFrame(peg));
}

/**
 * A peg's socket in place (world), in the piece across the cut from the one
 * that carries the peg.
 * @param {object} peg from `layoutSplit`
 * @returns {Manifold}
 */
export function socketAt(peg) {
  return cachedSocket(peg.half, peg.h, peg.ch, peg.tip).transform(pegFrame(peg));
}

// ---------- lips for the cuts that come apart ----------

// A cut that comes apart joins its pieces with a lip: a tongue standing out of one piece (the male) round the inside
// edge of its wall, a groove for it in the other (the female), spring clips on the tongue that click into that piece,
// and a key, a gap in the tongue the groove's piece fills, so the top goes on one way round only. Everything is
// planned in the plane frame of the cut, the face at w = 0 and the male below it, w pointing into the female: a male
// above the cut is the same lip mirrored (`lipFrame`). A plan is plain data, so the layout can be kept and the pieces
// drilled from it again.

/** A ring's signed area: positive for an outline, negative for a hole. */
const ringArea = (r) => r.reduce((s, p, i) => s + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0) / 2;
const ringLength = (r) => r.reduce((s, p, i) => s + Math.hypot(r[(i + 1) % r.length][0] - p[0], r[(i + 1) % r.length][1] - p[1]), 0);

/** An empty cross-section (new CrossSection([]) throws). */
const emptySection = () => manifold().CrossSection.square([0, 0]);

/** A cross-section with every part narrower than 2r taken off, the rest as it was with its corners rounded. */
function openSection(cs, r) {
  const shrunk = cs.offset(-r, 'Round', 2, 32);
  try {
    return shrunk.offset(r, 'Round', 2, 32);
  } finally {
    shrunk.delete();
  }
}

/**
 * An outline moved out by d (in for d < 0) keeping its corners sharp: the lip's own bands follow the opening's
 * corners exactly, and a rounded mouth left slivers on a channel's post and a round tube (a copy for d = 0).
 */
const offMiter = (cs, d) => (Math.abs(d) < 1e-9 ? cs.translate(0, 0) : cs.offset(d, 'Miter', 4));

/** An outline as a prism from z0 to z1 (plane frame). */
function prism(cs, z0, z1) {
  const m = extrudeSection(cs, z1 - z0);
  try {
    return m.translate([0, 0, z0]);
  } finally {
    m.delete();
  }
}

/** The point, the tangent and the outward normal at arc s along a run of the tongue's outside. */
function along(run, s) {
  const e = run.edges.find((x) => s <= x.at + x.l + 1e-9) ?? run.edges[run.edges.length - 1];
  const f = (s - e.at) / e.l;
  return { p: [e.a[0] + f * (e.b[0] - e.a[0]), e.a[1] + f * (e.b[1] - e.a[1])], dir: e.dir, out: e.out };
}

/** How far (degrees) a run turns between arcs s0 and s1. */
const turning = (run, s0, s1) => run.edges.filter((e) => e.at > s0 && e.at < s1).reduce((s, e) => s + e.turnIn, 0);

/** A strip over arcs s0…s1 of a run, from `outside` mm out of the tongue to `inside` mm into it. */
function stripSection(run, s0, s1, outside, inside) {
  const steps = [s0, ...run.edges.map((e) => e.at).filter((a) => a > s0 && a < s1), s1];
  const outer = steps.map((s) => {
    const q = along(run, s);
    return [q.p[0] + outside * q.out[0], q.p[1] + outside * q.out[1]];
  });
  const inner = steps.map((s) => {
    const q = along(run, s);
    return [q.p[0] - inside * q.out[0], q.p[1] - inside * q.out[1]];
  });
  return new (manifold().CrossSection)([[...outer, ...inner.reverse()]], 'Positive');
}

/**
 * The tongue's outside in runs: the edges of its outer rings that face the other piece's skin (`Q`, the face less
 * the tongue; the point 0.3 mm out of each edge's middle lies on it), broken where the outline turns more than 15°
 * within 1.5 mm. A tongue cut in two by a crossing cut has its cut ends on the same ring: they face no skin. Point
 * tests, not booleans: a dense outline has thousands of edges.
 * @param {CrossSection|number[][][]} T the tongue (borrowed), or its polygons
 * @param {CrossSection|number[][][]} Q the skin (borrowed), or its polygons
 * @returns {{ edges: { a, b, l, out, dir, onQ, at, turnIn }[], length: number, closed: boolean }[]} `at` each edge's
 *   arc from the run's start, `turnIn` how far the run turns into it (degrees); `closed` a whole ring with no corner
 */
export function lipRuns(T, Q) {
  const qp = Array.isArray(Q) ? Q : polygonsOf(Q);
  const tp = Array.isArray(T) ? T : polygonsOf(T);
  const out = [];
  for (const ring of tp.filter((r) => ringArea(r) > 0)) {
    const n = ring.length;
    const edges = ring.map((a, i) => {
      const b = ring[(i + 1) % n];
      const d = [b[0] - a[0], b[1] - a[1]];
      const l = Math.hypot(d[0], d[1]);
      const o = [d[1] / l, -d[0] / l];
      const onQ = insidePolygons(qp, (a[0] + b[0]) / 2 + 0.3 * o[0], (a[1] + b[1]) / 2 + 0.3 * o[1]);
      return { a, b, l, out: o, dir: [d[0] / l, d[1] / l], onQ };
    });
    const turnAt = edges.map((e, i) => {
      const q = edges[(i - 1 + n) % n].dir;
      return (Math.abs(Math.atan2(q[0] * e.dir[1] - q[1] * e.dir[0], q[0] * e.dir[0] + q[1] * e.dir[1])) * 180) / Math.PI;
    });
    const arcAt = [];
    let total = 0;
    for (const e of edges) {
      arcAt.push(total);
      total += e.l;
    }
    // a vertex is a corner when the turning at the vertices within 1.5 mm of it adds up to more than 15°: two
    // pointers over the ring laid out three times, so a dense ring takes no longer than its length
    const corner = new Array(n).fill(false);
    const ext = [];
    for (let k = -n; k < 2 * n; k++) ext.push({ arc: arcAt[((k % n) + n) % n] + Math.floor(k / n) * total, turn: turnAt[((k % n) + n) % n] });
    let lo = 0;
    let hi = 0;
    let sum = 0;
    for (let i = n; i < 2 * n; i++) {
      while (hi < ext.length && ext[hi].arc <= ext[i].arc + CLIP.cornerReach) sum += ext[hi++].turn;
      while (ext[lo].arc < ext[i].arc - CLIP.cornerReach) sum -= ext[lo++].turn;
      corner[i - n] = sum > CLIP.corner;
    }
    let start = edges.findIndex((e, i) => !e.onQ || corner[i]);
    const closed = start < 0;
    if (closed) start = 0;
    let cur = null;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      const e = edges[i];
      if ((!e.onQ || corner[i]) && cur) {
        out.push(cur);
        cur = null;
      }
      if (!e.onQ) continue;
      if (!cur) cur = { edges: [], length: 0, closed };
      cur.edges.push({ ...e, at: cur.length, turnIn: cur.edges.length ? turnAt[i] : 0 });
      cur.length += e.l;
    }
    if (cur) out.push(cur);
  }
  return out;
}

/**
 * Where the clips go: `n` windows a clip's span long, spread over the runs long enough for one with its margins,
 * one per run first, longest run first, each centred in its share of the run; a window is kept only where the run
 * turns no more than 20° over it and its margins, and `ok(run, window)` holds.
 */
function clipWindows(runs, n, ok) {
  const need = CLIP.span + 2 * CLIP.margin;
  // a run takes another clip for every span, its margins and 4 mm more between them
  const cap = runs.map((r) => (r.length >= need ? Math.floor((r.length + 4) / (need + 4)) : 0));
  const order = runs.map((r, i) => i).sort((i, j) => runs[j].length - runs[i].length);
  const got = runs.map(() => 0);
  let left = n;
  while (left > 0 && order.some((i) => got[i] < cap[i])) {
    for (const i of order) {
      if (left > 0 && got[i] < cap[i]) {
        got[i]++;
        left--;
      }
    }
  }
  const windows = [];
  runs.forEach((run, i) => {
    for (let k = 0; k < got[i]; k++) {
      const centre = (run.length * (k + 0.5)) / got[i];
      const w = { run: i, s0: centre - CLIP.span / 2, s1: centre + CLIP.span / 2 };
      if (turning(run, w.s0 - CLIP.margin, w.s1 + CLIP.margin) <= CLIP.turn && ok(run, w)) windows.push(w);
    }
  });
  return windows;
}

/**
 * Where the key goes: on the tongue's outside only (edges facing the other piece's skin, `Q`), at the middle of the
 * longest stretch of it that no clip window (with its margin and half the key) takes, across a corner as often as
 * not. A C-shaped tongue, a face halved by a crossing cut, has its inner face on the same ring: those edges face no
 * skin and never take it, or the key would cut a clip in two. The point on the tongue's middle line there, the free
 * stretch's length, or null when there is none.
 * @param {CrossSection|number[][][]} T the tongue (borrowed), or its polygons
 * @param {CrossSection|number[][][]} Q the skin (borrowed), or its polygons
 * @returns {{ s: number, p: number[], len: number }|null}
 */
export function keyOn(T, Q, runs, windows, t = LIP.t) {
  const qp = Array.isArray(Q) ? Q : polygonsOf(Q);
  const tp = Array.isArray(T) ? T : polygonsOf(T);
  let best = null;
  for (const ring of tp.filter((r) => ringArea(r) > 0)) {
    const n = ring.length;
    const edges = ring.map((a, i) => {
      const b = ring[(i + 1) % n];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const out = [(b[1] - a[1]) / l, -(b[0] - a[0]) / l];
      return { a, b, l, out, onQ: insidePolygons(qp, (a[0] + b[0]) / 2 + 0.3 * out[0], (a[1] + b[1]) / 2 + 0.3 * out[1]) };
    });
    const arc = [0];
    for (const e of edges) arc.push(arc[arc.length - 1] + e.l);
    const total = arc[n];
    const nearest = (p) => {
      let bestS = 0;
      let d = Infinity;
      edges.forEach((e, i) => {
        const ab = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
        const f = Math.max(0, Math.min(1, ((p[0] - e.a[0]) * ab[0] + (p[1] - e.a[1]) * ab[1]) / (e.l * e.l)));
        const q = [e.a[0] + f * ab[0], e.a[1] + f * ab[1]];
        const dd = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (dd < d) {
          d = dd;
          bestS = arc[i] + f * e.l;
        }
      });
      return { s: bestS, d };
    };
    // the arcs it may not take: edges facing no skin (with half a key either side), each clip window with its margin
    const blocked = [];
    edges.forEach((e, i) => {
      if (!e.onQ) blocked.push([arc[i] - CLIP.key / 2, arc[i + 1] + CLIP.key / 2]);
    });
    for (const w of windows) {
      const a = nearest(along(runs[w.run], w.s0).p);
      const b = nearest(along(runs[w.run], w.s1).p);
      if (a.d > 0.1 || b.d > 0.1) continue; // on another ring
      let [s0, s1] = [a.s, b.s];
      if (s1 < s0) s1 += total;
      blocked.push([s0 - CLIP.margin - CLIP.key / 2, s1 + CLIP.margin + CLIP.key / 2]);
    }
    if (!blocked.length) {
      if (!best || total > best.len) best = { len: total, s: total / 2, edges, arc };
      continue;
    }
    // the free stretches between the blocked arcs, round the ring
    const sorted = blocked.map(([x, y]) => [((x % total) + total) % total, ((x % total) + total) % total + (y - x)]).sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const [x, y] of sorted) {
      const last = merged[merged.length - 1];
      if (last && x <= last[1]) last[1] = Math.max(last[1], y);
      else merged.push([x, y]);
    }
    merged.forEach(([, y], i) => {
      const next = i + 1 < merged.length ? merged[i + 1][0] : merged[0][0] + total;
      if (next - y > (best?.len ?? 1e-9)) best = { len: next - y, s: ((((y + next) / 2) % total) + total) % total, edges, arc };
    });
  }
  if (!best) return null;
  const i = best.arc.findIndex((a, k) => k < best.edges.length && best.s >= a && best.s <= best.arc[k + 1]);
  const e = best.edges[i];
  const f = (best.s - best.arc[i]) / e.l;
  const p = [e.a[0] + f * (e.b[0] - e.a[0]) - (t / 2) * e.out[0], e.a[1] + f * (e.b[1] - e.a[1]) - (t / 2) * e.out[1]];
  return { s: best.s, p, len: best.len };
}

/**
 * A clip's catch (c = 0) or the recess for it in the other piece (grown by c), in the plane frame: a convex hull
 * `length` along the clip (6 mm) with a 0.4 mm flat tip standing `p` out of it, 45° flanks at its ends, its foot
 * sunk 0.2 mm into the clip (a recess reaches 0.6 back, into the gap), centred `zc` above the face. Its flank
 * towards the face, which the top's wall bears on as it is pulled off, is at `retention` from the way it is pulled
 * (degrees), and the one away from the face, which the wall rides over as the top is pressed on, at `lead`: both 45°
 * on a plain catch. Grown by c, a flank at α moves its edge on the tip by c·tan(α/2). Framed on the chord of the run
 * under it (`chord`: its middle `p`, its way along `dir` and out of the tongue `out`): a curved run bulges past the
 * chord by its sagitta only, and on the edge its middle falls on the catch would stand further out.
 * @returns {Manifold}
 */
export function catchSolid(chord, { zc, p, c = 0, retention = 45, lead = 45, length = CLIP.length }) {
  // at 45° exactly as the plain catch always was: tan 45° in floating point is a hair under 1
  const edge = (deg) => c * (deg === 45 ? Math.SQRT2 - 1 : Math.tan((deg * Math.PI) / 360));
  const slope = (deg) => (deg === 45 ? 1 : Math.tan((deg * Math.PI) / 180));
  const grow = c * (Math.SQRT2 - 1);
  const P = p + c;
  const tipHalfL = length / 2 - p + grow;
  // [towards the face, away from it]: each flank's edge on the tip, and how far out it goes per mm along the pull
  const tipHalfH = [CLIP.flat / 2 + edge(retention), CLIP.flat / 2 + edge(lead)];
  const s = [slope(retention), slope(lead)];
  const back = -CLIP.sink - (c ? 0.4 : 0);
  const at = (a, o, z) => [chord.p[0] + a * chord.dir[0] + o * chord.out[0], chord.p[1] + a * chord.dir[1] + o * chord.out[1], zc + z];
  const pts = [];
  for (const sa of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const k = sz < 0 ? 0 : 1;
      pts.push(at(sa * tipHalfL, P, sz * tipHalfH[k]));
      pts.push(at(sa * (tipHalfL + P - back), back, sz * (tipHalfH[k] + P / s[k] - back / s[k])));
    }
  }
  return manifold().Manifold.hull(pts);
}

/**
 * How far a clip's catch (`catchSolid`, c = 0) reaches from its centre at its foot: [down towards the face, up away
 * from it]. Alike for a plain catch; a lock's shallow lead flank reaches up further than its steep flank down.
 */
export function catchReach(p, { retention = 45, lead = 45 } = {}) {
  const slope = (deg) => (deg === 45 ? 1 : Math.tan((deg * Math.PI) / 180));
  return [retention, lead].map((deg) => CLIP.flat / 2 + p / slope(deg) + CLIP.sink / slope(deg));
}

/** The chord a clip's catch is framed on (`catchSolid`): the catch's length either side of the window's middle. */
function chordOf(run, w, length = CLIP.length) {
  const mid = (w.s0 + w.s1) / 2;
  const a = along(run, mid - length / 2).p;
  const b = along(run, mid + length / 2).p;
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const dir = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  return { p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dir, out: [dir[1], -dir[0]] };
}

/**
 * The regions of a face's island a lip is planned in: its outline filled (`fill`), and the kind. A hole whose
 * outline is at least a quarter of the island's is an opening, and the tongue hugs the openings (`A`, kind
 * 'opening'), openings with a wall too thin for two grooves between them taken as one; smaller holes are kept
 * clear of (`smallHoles`). A face with no opening (a solid post) gets a channel:
 * the tongue round a core (`A`) a skirt and a tongue in from the outside, and kind 'channel' when there is a core
 * wider than a wall; null when there is none. Where the holes leave a channel's tongue no room at all, even with
 * nothing else in the way – a box of many compartments, each too small to be an opening by itself – every hole is an
 * opening, and the tongue hugs each.
 * @param {CrossSection} island (borrowed)
 * @param {number} c clearance per side
 * @param {{ t: number, tMin: number, wall: number }} sizes `lipSizesFor`'s
 * @returns {{ kind: 'opening'|'channel'|null, fill: CrossSection, A: CrossSection, g0: number, smallHoles: CrossSection }}
 *   the cross-sections the caller's; `g0` how far back from A's edge the tongue's inside face stands
 */
export function lipRegions(island, c, sizes = lipSizesFor(c)) {
  const { CrossSection } = manifold();
  const rings = polygonsOf(island);
  const outer = rings.filter((r) => ringArea(r) > 0);
  const holes = rings.filter((r) => ringArea(r) < 0);
  if (!outer.length) return { kind: null, fill: emptySection(), A: emptySection(), g0: c, smallHoles: emptySection() };
  const outerLength = outer.reduce((n, r) => n + ringLength(r), 0);
  const fill = new CrossSection(outer, 'Positive');
  // openings with a wall between them too thin for a groove each side and a wall between those (a box's dividers)
  // are one: the tongue runs along the outside wall past the divider, whose end its groove just notches
  const openingsOf = (list) => {
    const hollows = list.map((r) => [...r].reverse());
    const t = scope();
    try {
      let kept = hollows;
      if (hollows.length > 1) {
        // an opening on its own keeps its own outline exactly; only those run together take the closed one
        const d = LIP.g0 + sizes.t + c + sizes.wall / 2;
        const closed = t.add(offMiter(t.add(offMiter(t.add(new CrossSection(hollows, 'Positive')), d)), -d));
        kept = closed.decompose().map((x) => t.add(x)).flatMap((part) => {
          const outline = polygonsOf(part);
          const inside = hollows.filter((r) => {
            const [x, y] = insidePoint([r], polygonsCentroid([r]));
            return insidePolygons(outline, x, y);
          });
          return inside.length === 1 ? inside : outline;
        });
      }
      const raw = t.add(new CrossSection(kept, 'Positive'));
      return { kind: 'opening', fill, A: raw.simplify(LIP.eps), g0: LIP.g0, smallHoles: emptySection() };
    } finally {
      t.dispose();
    }
  };
  const openings = holes.filter((r) => ringLength(r) >= LIP.opening * outerLength);
  const small = holes.filter((r) => ringLength(r) < LIP.opening * outerLength);
  if (openings.length) {
    const regions = openingsOf(openings);
    if (small.length) {
      regions.smallHoles.delete();
      regions.smallHoles = new CrossSection(small.map((r) => [...r].reverse()), 'Positive');
    }
    return regions;
  }
  const smallHoles = small.length ? new CrossSection(small.map((r) => [...r].reverse()), 'Positive') : emptySection();
  const t = scope();
  try {
    const inset = t.add(fill.offset(-(LIP.skirt + sizes.t + 2 * c), 'Round', 2, 32));
    const A = t.add(openSection(inset, sizes.wall / 2)).simplify(LIP.eps);
    if (!A.isEmpty() && small.length) {
      // the channel's tongue as `planLip` would lay it with only the holes in the way: none left, and the holes are
      // the openings
      const tMin = sizes.tMin ?? LIP.tMin;
      const d0 = 2 * c + sizes.t;
      const groove = t.add(t.add(t.add(t.add(offMiter(A, d0)).subtract(A)).intersect(t.add(fill.offset(-sizes.wall, 'Round', 2, 32))))
        .subtract(t.add(smallHoles.offset(sizes.wall, 'Round', 2, 32))));
      const band = t.add(t.add(t.add(offMiter(A, c + sizes.t)).subtract(t.add(offMiter(A, c)))).intersect(t.add(fill.offset(-(sizes.wall + c), 'Round', 2, 32))));
      const tongue = t.add(tidyTongue(t.add(band.intersect(t.add(groove.offset(-c, 'Round', 2, 32)))), tMin));
      if (tongue.isEmpty()) {
        A.delete();
        smallHoles.delete();
        return openingsOf(holes);
      }
    }
    return { kind: A.isEmpty() ? null : 'channel', fill, A, g0: c, smallHoles };
  } finally {
    t.dispose();
  }
}

/** A tongue with its parts thinner than the thinnest kept taken off and the pieces under 25 mm² dropped. */
function tidyTongue(T, tMin) {
  const { CrossSection } = manifold();
  const opened = openSection(T, tMin / 2);
  const parts = opened.decompose();
  try {
    const kept = parts.filter((x) => x.area() >= LIP.minPiece);
    const whole = kept.length ? CrossSection.union(kept) : emptySection();
    try {
      return whole.simplify(LIP.eps);
    } finally {
      whole.delete();
    }
  } finally {
    opened.delete();
    parts.forEach((x) => x.delete());
  }
}

/**
 * The 2D plan of one patch's lip at height H, in the plane frame, or null
 * when no tongue is left. The groove's piece keeps a wall's width (three
 * lines) from every obstacle on its side: the face's columns that meet air
 * or something placed within its reach (`block`), its own material over the
 * island's openings there (`over`: a ceiling just past the cut), and the
 * face's small holes. Where something stands over the opening the tongue
 * moves out, a wall and the inside gap away from it. The groove's largest
 * region is c past the tongue's outside and 0.5 mm into an opening (c round
 * a channel's core); the tongue keeps c inside it, so it always keeps c from
 * the other piece's material. Then the clips (a full lip only, at least two
 * for every 95 mm of the tongue's outside, at most eight): each where its
 * catch's recess keeps two nozzles of skin from the outside and from every
 * obstacle (else `why` 'skin'), and where it has room to bow in, the strip
 * inward of it i + 0.1 deep being the groove's air (an opening) or its
 * relief (a channel; else 'flex'). Then the key, on the patch that takes
 * it: where the clips leave it no free stretch, the clip on the shortest run
 * gives way ('key').
 * @param {CrossSection} patch the patch, plane frame (borrowed)
 * @param {{ island?: CrossSection, c?: number, nozzle?: number, H?: number, hold?: string, key?: boolean,
 *   block?: CrossSection|null, over?: CrossSection|null, clips?: boolean }} options `island` the face's island the patch
 *   lies in (a face a crossing cut halves takes its openings from the whole island), all borrowed
 * @returns {object|null} plain data: `{ kind, hasOver, H, c, p, i, t, g0, d0, gIn, hold, zTop, reach, want, why, key:
 *   { p, len }|null, windows: [{ s0, s1, slot, chord }], area, T, Tc, A }` – `T` the tongue, `Tc` the groove and `A`
 *   the region its inside follows as polygons, `area` the tongue's (mm²), `slot` the polygon of the slot under each
 *   clip, `chord` the frame of its catch (`catchSolid`), `want` how many clips were looked for
 */
export function planLip(patch, options = {}) {
  const { island = patch, c = SPLIT_DEFAULTS.clearance, nozzle = 0.4, H = LIP.heights[0], hold = 'snap', key = true, block = null, over = null, clips = true } = options;
  const { CrossSection } = manifold();
  const t = scope();
  try {
    // clips only on a full lip: under 6 mm there is no room for both the slot and the catch
    const withClips = clips && H >= LIP.heights[0] && catchSizes(hold, c) !== null;
    const sizes = lipSizesFor(c, nozzle, withClips ? hold : 'lift');
    const { t: th, tMin, wall, skin, p, i, gIn } = sizes;
    const regions = lipRegions(island, c, sizes);
    const { kind, g0 } = regions;
    const fill = t.add(regions.fill);
    const A = t.add(regions.A);
    const smallHoles = t.add(regions.smallHoles);
    if (!kind) return null;
    const obst = [block, over, smallHoles].filter((x) => x && !x.isEmpty());
    const obstacles = t.add(obst.length ? CrossSection.union(obst) : emptySection());
    const keepOff = obstacles.isEmpty() ? null : t.add(obstacles.offset(wall, 'Round', 2, 32));
    const hasOver = kind === 'opening' && Boolean(over) && !over.isEmpty();
    const Ae = hasOver ? t.add(t.add(A.add(t.add(over.offset(wall + gIn - g0, 'Round', 2, 32)))).simplify(LIP.eps)) : A;
    const d0 = g0 + th + c;
    const inner = t.add(kind === 'opening' ? offMiter(A, -LIP.into) : offMiter(A, g0 - c));
    const walled = t.add(fill.offset(-wall, 'Round', 2, 32));
    let Tc0 = t.add(t.add(t.add(offMiter(Ae, d0)).subtract(inner)).intersect(walled));
    if (keepOff) Tc0 = t.add(Tc0.subtract(keepOff));
    Tc0 = t.add(Tc0.simplify(LIP.eps));
    const keep = t.add(fill.offset(-(wall + c), 'Round', 2, 32));
    const bandOf = t.add(t.add(t.add(offMiter(Ae, g0 + th)).subtract(t.add(offMiter(Ae, g0)))).intersect(keep));
    const band = t.add(bandOf.intersect(patch));
    const T0 = t.add(tidyTongue(t.add(band.intersect(t.add(Tc0.offset(-c, 'Round', 2, 32)))), tMin));
    if (T0.isEmpty()) return null;
    const skinQ = t.add(patch.subtract(T0));
    const tPolys = polygonsOf(T0);
    const qPolys = polygonsOf(skinQ);
    const runs = lipRuns(tPolys, qPolys);
    const clipLength = runs.reduce((s, r) => s + r.length, 0);
    const takes = runs.filter((r) => r.length >= CLIP.span + 2 * CLIP.margin).length;
    const want = withClips ? Math.min(CLIP.most, Math.max(2, takes, Math.round(clipLength / CLIP.every))) : 0;
    const lidSide = t.add(patch.subtract(obstacles)); // where the other piece's skin is sure to stand over the face
    const why = new Set();
    const reliefOf = (run, w) => stripSection(run, w.s0 - 1, w.s1 + 1, -(th - 0.05), th + c + (c + i + 0.3));
    const grownLittle = withClips ? t.add(T0.offset(0.01, 'Round', 2, 16)) : null;
    const grownFlex = withClips ? t.add(T0.offset(i + 0.1, 'Round', 2, 16)) : null;
    const area = (cs) => t.add(cs).area();
    // the catch's recess keeps two nozzles of skin outside it, from the outline and from every obstacle
    const skinOk = (run, w) => area(t.add(stripSection(run, w.s0 + 1, w.s1 - 1, c + p + skin, 0)).subtract(lidSide)) < 1e-3;
    // room to bow in: inward of the clip, i + 0.1 deep, is the groove's air (an opening) or its relief (a channel),
    // the relief keeping a wall from the outline, the holes and every obstacle
    const flexOk = (run, w) => {
      if (kind === 'opening') {
        const room = t.add(t.add(t.add(stripSection(run, w.s0 + 1, w.s1 - 1, 0, th + 1)).intersect(grownFlex)).subtract(grownLittle));
        return area(room.subtract(Tc0)) < 1e-3;
      }
      const r = t.add(reliefOf(run, w));
      return !(area(r.subtract(walled)) > 1e-3 || (keepOff && area(r.intersect(keepOff)) > 1e-3));
    };
    const ok = (run, w) => {
      if (!skinOk(run, w)) {
        why.add('skin');
        return false;
      }
      if (!flexOk(run, w)) {
        why.add('flex');
        return false;
      }
      return true;
    };
    const windows = withClips ? clipWindows(runs, want, ok) : [];
    if (withClips && !windows.length && !takes) why.add('short');
    if (!withClips && hold !== 'lift') why.add(H >= LIP.heights[0] ? 'flex' : 'height');
    // the key always has room: where the clips leave it no free stretch, the clip on the shortest run gives way
    let keyAt = key ? keyOn(tPolys, qPolys, runs, windows, th) : null;
    while (key && windows.length && !keyAt) {
      let drop = 0;
      windows.forEach((w, k) => {
        if (runs[w.run].length < runs[windows[drop].run].length) drop = k;
      });
      windows.splice(drop, 1);
      why.add('key');
      keyAt = keyOn(tPolys, qPolys, runs, windows, th);
    }
    // a 32-gon turned half a step: no corner of it lies on a line through its centre along u or v, where a roof
    // step's edge may run
    const disc = keyAt ? t.add(t.add(t.add(CrossSection.circle(CLIP.key / 2, 32)).rotate(180 / 32)).translate(keyAt.p[0], keyAt.p[1])) : null;
    const T = disc ? t.add(t.add(T0.subtract(disc)).simplify(LIP.eps)) : T0;
    // the groove only where the tongue is, c + 0.6 round the whole tongue (the key's gap not counted, or the groove's
    // roof would step round it), less the key's plug
    let Tc = t.add(Tc0.intersect(t.add(T0.offset(c + 0.6, 'Round', 2, 32))));
    if (disc) Tc = t.add(Tc.subtract(t.add(disc.offset(-c, 'Round', 2, 32))));
    // a channel's clips bow into reliefs cut into the core behind them, under the same flat roof
    if (kind === 'channel' && windows.length) Tc = t.add(Tc.add(t.add(CrossSection.union(windows.map((w) => t.add(reliefOf(runs[w.run], w)))))));
    Tc = t.add(Tc.simplify(LIP.eps));
    const { zTop, reach } = lipReach(H, kind, c, i, hasOver, nozzle);
    // a lock's bridge is the middle of its window, and its catch longer: the window, and so the room it needs, is the same
    const shape = withClips ? clipShape(hold, c, th) : null;
    const slotOf = (w) => {
      if (!shape || shape.span >= CLIP.span) return [w.s0, w.s1];
      const mid = (w.s0 + w.s1) / 2;
      return [mid - shape.span / 2, mid + shape.span / 2];
    };
    // a wider nozzle's thicker tongue is thinned from the inside along each bridge, down to the clip's own thickness:
    // a clip is stiffer as the cube of it
    const thin = (w) => (shape && shape.t < th - 1e-9 ? { thin: polygonsOf(t.add(stripSection(runs[w.run], ...slotOf(w), -shape.t, th + 0.6))) } : {});
    return {
      kind, hasOver, H, c, p, i, t: th, g0, d0, gIn, hold, zTop, reach, want, why: [...why],
      key: keyAt ? { p: keyAt.p, len: keyAt.len } : null,
      windows: windows.map((w) => ({
        s0: w.s0, s1: w.s1, slot: polygonsOf(t.add(stripSection(runs[w.run], ...slotOf(w), 0.5, th + 0.5))), chord: chordOf(runs[w.run], w, shape?.length),
        ...thin(w),
      })),
      area: T.area(), T: polygonsOf(T), Tc: polygonsOf(Tc), A: polygonsOf(Ae),
    };
  } finally {
    t.dispose();
  }
}

/**
 * A patch's lip with its fallbacks: 6 mm with clips (on a hold that has
 * them), 6 mm without (where moving the tongue out for the clips to bow in
 * leaves none), then 4.5 and 3 mm; the first that leaves a tongue. Each
 * height's obstacles are taken at the reach a plain opening needs, and only
 * where something stands over the opening there, again at the reach the
 * moved-out tongue's roof needs.
 * @param {CrossSection} patch plane frame (borrowed)
 * @param {{ island?: CrossSection, c?: number, nozzle?: number, hold?: string, key?: boolean, heights?: number[],
 *   obstaclesAt?: (R: number) => { block: CrossSection|null, over: CrossSection|null } }} options `obstaclesAt` the
 *   obstacles on the groove's side within R of the face (borrowed; none when not given)
 * @returns {{ plan: object|null, kind: string|null, tries: { H, clips, R, area, block, over }[] }} `plan` `planLip`'s
 */
export function lipFor(patch, options = {}) {
  const { island = patch, c = SPLIT_DEFAULTS.clearance, nozzle = 0.4, hold = 'snap', key = true, heights = LIP.heights, obstaclesAt = null } = options;
  const tries = [];
  const regions = lipRegions(island, c, lipSizesFor(c, nozzle, 'lift'));
  const { kind } = regions;
  for (const cs of [regions.fill, regions.A, regions.smallHoles]) cs.delete();
  if (!kind) return { plan: null, kind: null, tries };
  const caught = catchSizes(hold, c);
  const ladder = heights.flatMap((H) => (H >= LIP.heights[0] && caught ? [[H, true], [H, false]] : [[H, false]]));
  const at = (H, i, over) => {
    const R = lipReach(H, kind, c, i, over, nozzle).reach;
    return { R, ...(obstaclesAt?.(R) ?? { block: null, over: null }) };
  };
  for (const [H, clips] of ladder) {
    const i = clips ? caught.i : 0;
    let o = at(H, i, false);
    if (o.over) o = at(H, i, true);
    const plan = planLip(patch, { island, c, nozzle, H, hold, key, block: o.block, over: o.over, clips });
    tries.push({ H, clips, R: o.R, area: plan?.area ?? 0, block: Boolean(o.block), over: Boolean(o.over) });
    if (plan) return { plan, kind, tries };
  }
  return { plan: null, kind, tries };
}

/**
 * How much room a patch's groove has on its side of the face (mm), in
 * 0.5 mm steps down from the reach a full lip needs (`R6`): the largest
 * reach whose obstacles miss the zone the tongue and its groove take, a wall
 * round it. A cut moved `shift` away from the groove's piece has that reach
 * – a lantern cut 2 mm under its roof's eaves is moved 1.5 mm down – as long
 * as the shape between does not change, which the caller checks. Apart from
 * that, whether something is in the way in the tongue's own foot, the
 * 0.5 mm it sinks into its piece (`root`: a lantern cut right at the top of
 * its windows), which no move away from the groove's piece clears.
 * @param {CrossSection} patch plane frame (borrowed)
 * @param {{ island?: CrossSection, c?: number, nozzle?: number, hold?: string, obstaclesAt: function,
 *   rootAt?: () => CrossSection|null }} options as for `lipFor`, `obstaclesAt` those on the groove's side alone, and
 *   `rootAt` those in the tongue's foot (borrowed)
 * @returns {{ room: number, R6: number, shift: number, root: boolean }|null} null when the face takes no lip of any
 *   kind
 */
export function lipRoom(patch, { island = patch, c = SPLIT_DEFAULTS.clearance, nozzle = 0.4, hold = 'snap', obstaclesAt, rootAt = null } = {}) {
  const t = scope();
  try {
    const sizes = lipSizesFor(c, nozzle, hold);
    const regions = lipRegions(island, c, sizes);
    for (const cs of [regions.fill, regions.A, regions.smallHoles]) t.add(cs);
    if (!regions.kind) return null;
    const R6 = lipReach(LIP.heights[0], regions.kind, c, sizes.i, false, nozzle).reach;
    const near = t.add(patch.offset(1, 'Round', 2, 32));
    const band = regions.kind === 'opening'
      ? t.add(t.add(offMiter(regions.A, regions.g0 + sizes.t + c + LIP.mouth)).subtract(t.add(offMiter(regions.A, -LIP.into))))
      : patch;
    const zone = t.add(t.add(band.intersect(near)).offset(sizes.wall, 'Round', 2, 32));
    const meets = (x) => Boolean(x) && t.add(x.intersect(zone)).area() > 1e-3;
    const root = meets(rootAt?.());
    const hits = (R) => {
      const { block, over } = obstaclesAt(R);
      return meets(block) || meets(over);
    };
    // obstacles only grow with the reach, so the largest step clear of them is found by bisection
    const steps = Math.ceil(R6 / 0.5 - 1e-9); // reaches R6 − 0.5k for k < steps are above 0
    if (!hits(R6)) return { room: R6, R6, shift: 0, root };
    let lo = 0; // hits
    let hi = steps; // clear (no reach at all)
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (hits(R6 - 0.5 * mid)) lo = mid;
      else hi = mid;
    }
    return hi < steps ? { room: R6 - 0.5 * hi, R6, shift: 0.5 * hi, root } : { room: 0, R6, shift: 0.5 * steps, root };
  } finally {
    t.dispose();
  }
}

/**
 * What the groove's piece holds over a face's openings within R of it,
 * projected (plane frame): its material between 0.001 mm and R past the face
 * on its side, over the island's holes (its outline filled less the island
 * grown 0.05 mm). A ceiling just above a lantern's cut is such material.
 * @param {Manifold} band from `bandFor` (borrowed), reaching R + 0.5 past the face
 * @param {{ axis: number, at: number }} cut
 * @param {0|1} side the groove's piece: 0 the one below the cut, 1 the one above
 * @param {number} R
 * @param {CrossSection} island the face's island, plane frame (borrowed)
 * @returns {CrossSection|null} the caller's; null when there is none
 */
export function overFor(band, cut, side, R, island) {
  const { CrossSection, Manifold } = manifold();
  if (band.isEmpty()) return null;
  const t = scope();
  try {
    const { min, max } = band.boundingBox();
    const [w0, w1] = side === 1 ? [cut.at + 1e-3, cut.at + R] : [cut.at - R, cut.at - 1e-3];
    const slab = t.add(t.add(Manifold.cube([max[0] - min[0] + 4, max[1] - min[1] + 4, w1 - w0])).translate([min[0] - 2, min[1] - 2, w0]));
    const upper = t.add(t.add(band.intersect(slab)).project());
    const outer = polygonsOf(island).filter((r) => ringArea(r) > 0);
    if (!outer.length) return null;
    const holes = t.add(t.add(new CrossSection(outer, 'Positive')).subtract(t.add(island.offset(0.05, 'Miter', 4))));
    const over = upper.intersect(holes);
    if (over.area() > 1e-3) return over;
    over.delete();
    return null;
  } finally {
    t.dispose();
  }
}

/**
 * The solids of a lip's plan, in the plane frame (the male below): the
 * tongue to add to the male and the cutters to take out of the female. The
 * tongue is one prism from 0.5 mm inside its piece to H, its top edge taken
 * off 0.6 at 45° by nested cutters, each with its own outline (and the
 * inside edge too where the other piece has material inside it), a slot
 * under each clip so that the clip is a bridge held at both ends, and the
 * catches. The groove is one prism with the other piece's material over its
 * roof given back in nested 45° steps from the outside in (a channel's roof
 * is flat), its mouth widened 0.4 and 0.2 over its first two layers, and the
 * catches' recesses. Every nested prism has a foot and an outline of its
 * own, so no two faces of the result lie in one plane.
 * @param {object} lip a plan (`planLip`) or a layout's lip
 * @returns {{ tongue: Manifold, cutters: Manifold, catches: Manifold[], recesses: Manifold[], zc: number }} the
 *   caller's; `zc` the catches' height
 */
export function lipSolids(lip) {
  const { CrossSection, Manifold } = manifold();
  const t = scope();
  try {
    const { kind, H, c, p, g0, d0, zTop } = lip;
    const th = lip.t ?? LIP.t;
    const S = LIP.step;
    const T = t.add(new CrossSection(lip.T, 'Positive'));
    const Tc = t.add(new CrossSection(lip.Tc, 'Positive'));
    const A = t.add(new CrossSection(lip.A, 'Positive'));
    let tongue = t.add(prism(T, -LIP.root, H));
    const leads = [];
    for (let k = 0; k < Math.round(LIP.lead / S); k++) {
      const reachOut = t.add(T.offset(1 + 0.05 * k, 'Round', 2, 16));
      let L = t.add(reachOut.subtract(t.add(offMiter(A, g0 + th - S * (k + 1)))));
      if (kind === 'channel' || lip.hasOver) L = t.add(L.add(t.add(reachOut.intersect(t.add(offMiter(A, g0 + S * (k + 1)))))));
      leads.push(t.add(prism(L, H - LIP.lead + S * k, H + 1 + 0.05 * k)));
    }
    tongue = t.add(tongue.subtract(t.add(Manifold.union(leads))));
    let cavity = t.add(prism(Tc, -1, zTop));
    if (kind === 'opening') {
      // step 0 would give back nothing (the groove lies within d0) and only lay a face on the groove's own wall
      const material = [];
      for (let k = 1; k < Math.round((zTop - H - c) / S); k++) {
        const M = t.add(t.add(Tc.offset(1 + 0.05 * k, 'Round', 2, 16)).subtract(t.add(offMiter(A, d0 - k * S))));
        material.push(t.add(prism(M, H + c + k * S, zTop + 1 + 0.05 * k)));
      }
      if (material.length) cavity = t.add(cavity.subtract(t.add(Manifold.union(material))));
    }
    const mouths = [];
    for (let j = 0; j < Math.round(LIP.mouth / S); j++) mouths.push(t.add(prism(t.add(Tc.offset(LIP.mouth - S * j, 'Miter', 4)), -1.1 - 0.1 * j, S * (j + 1))));
    cavity = t.add(cavity.add(t.add(Manifold.union(mouths))));
    const slots = [];
    const catches = [];
    const recesses = [];
    // a lock's catch is longer, with a steep flank that holds and a shallow one it goes on over; the others' are plain
    const shape = lip.hold === 'lock' && lip.windows.length ? clipShape('lock', c, th) : null;
    const flanks = shape ? { retention: shape.retention, lead: shape.lead, length: shape.length } : {};
    // the catch, foot and all, sits in the middle of the clip's band, between the slot and the tongue's lead-in: a
    // lock's reaches up further than down, so it sits lower – up into the lead-in it would leave slivers of itself
    const [down, up] = catchReach(p, flanks);
    const zc = (CLIP.slot + H - LIP.lead) / 2 + (down - up) / 2;
    for (const w of lip.windows) {
      slots.push(t.add(prism(t.add(new CrossSection(w.slot, 'Positive')), -0.6, CLIP.slot)));
      // a foot and a top of its own, inside the slot and over the lead-in's cutters
      if (w.thin) slots.push(t.add(prism(t.add(new CrossSection(w.thin, 'Positive')), 1, H + 1.15)));
      catches.push(t.add(catchSolid(w.chord, { zc, p, ...flanks })));
      recesses.push(t.add(catchSolid(w.chord, { zc, p, c, ...flanks })));
    }
    if (slots.length) tongue = t.add(t.add(tongue.subtract(t.add(Manifold.union(slots)))).add(t.add(Manifold.union(catches))));
    const cutters = recesses.length ? Manifold.union([cavity, ...recesses]) : cavity.translate([0, 0, 0]);
    // copies, as the scope deletes what it holds
    const copy = (m) => m.translate([0, 0, 0]);
    return { tongue: copy(tongue), cutters, catches: catches.map(copy), recesses: recesses.map(copy), zc };
  } finally {
    t.dispose();
  }
}

/** What a lip's solids are built from, as a key: the same plan builds the same solids. */
const lipKey = (lip) => JSON.stringify([
  lip.kind, Boolean(lip.hasOver), lip.H, lip.c, lip.p, lip.t, lip.g0, lip.d0, lip.zTop, lip.T, lip.Tc, lip.A,
  lip.windows.map((w) => [w.slot, w.chord, w.thin ?? null]), lip.hold === 'lock',
]);

/** A lip's tongue and cutters, kept: never delete them, transform or copy them. */
function cachedLip(lip) {
  return LIPS.get(lipKey(lip), () => {
    const s = lipSolids(lip);
    for (const m of [...s.catches, ...s.recesses]) m.delete();
    return { tongue: s.tongue, cutters: s.cutters };
  });
}

/**
 * A lip's plane frame (male below, w into the female) → world: the cut's
 * plane coordinates moved to the cut, mirrored in w for a male above it
 * (`dir` −1): a mirrored solid is as valid as the one it mirrors.
 * @returns {number[]} column-major 4×4
 */
export function lipFrame(axis, at, dir = 1) {
  const flip = dir < 0 ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return mulMat4(TO_WORLD[axis], mulMat4(translationMat4([0, 0, at]), flip));
}

/**
 * A lip's tongue where it stands in the assembled model (world), to fuse to
 * its male piece.
 * @param {object} lip from `layoutSplit`'s `lips`
 * @returns {Manifold}
 */
export function lipAt(lip) {
  return cachedLip(lip).tongue.transform(lipFrame(lip.axis, lip.at, lip.dir));
}

/**
 * A lip's groove, its mouth and its catches' recesses in place (world), to
 * take out of its female piece.
 * @param {object} lip from `layoutSplit`'s `lips`
 * @returns {Manifold}
 */
export function lipCavityAt(lip) {
  return cachedLip(lip).cutters.transform(lipFrame(lip.axis, lip.at, lip.dir));
}

/**
 * The lip of a solid's largest face at a cut, standing out of the piece
 * below it, as `layoutSplit` lays one out (its plain data), or null when the
 * face takes none: the fit test's box and lid.
 */
function lipOnFace(solid, cut, { c, hold, nozzle }) {
  const t = scope();
  try {
    const band = t.add(bandFor(solid, cut, lipReach(LIP.heights[0], 'opening', c, catchSizes('snap', c).i, true, nozzle).reach));
    const { face, patches } = patchesFor(band, cut, []);
    t.add(face);
    patches.forEach((x) => t.add(x.cs));
    const largest = patches.reduce((best, x) => (!best || x.area > best.area ? x : best), null);
    if (!largest) return null;
    const patch = t.add(largest.cs.simplify(LIP.faceTolerance));
    const inset = t.add(patch.offset(-0.05, 'Miter', 4));
    const obstaclesAt = (R) => {
      const block = t.add(t.add(shadowFor(band, cut, { below: LIP.root, above: R })).intersect(inset));
      const over = overFor(band, cut, 1, R, patch);
      return { block: block.isEmpty() ? null : block, over: over ? t.add(over) : null };
    };
    const { plan } = lipFor(patch, { c, nozzle, hold, obstaclesAt });
    if (!plan) return null;
    return {
      ...plan, cutId: cut.id, letter: cut.letter, patch: 0, axis: cut.axis, at: cut.at, dir: 1, male: 0, down: `-${AXES[cut.axis]}`,
      sides: [{ piece: 1, male: true }, { piece: 2, male: false }], clips: plan.windows.length, room: null, suggestedAt: null,
    };
  } finally {
    t.dispose();
  }
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
 * w inside it would rule the tabs out), and the plate's thickness (`t`, the
 * thickest island's: what the pieces beside it may need support under is
 * weighed against it, `liesFlat`); null when the cut would take pins.
 * Either piece may hold a tab, even where an island takes only one (it
 * points the other way when something stands proud on the far side), and
 * tabs that later find no room are counted all the same: the plan must
 * never be smaller than the pieces.
 * @param {CrossSection} face the cut's face in its plane coordinates (borrowed)
 * @param {{ axis: number, at: number }} cut
 * @param {{ sliceAt?: function|null, probes?: number[] }} options as for `plateTest`: whether the plate stays flat
 * @returns {{ below: number, above: number, w: number, span: number[], t: number }|null}
 */
export function tabsAcross(face, cut, { sliceAt = null, probes = [] } = {}) {
  const test = plateTest(face, cut, { sliceAt, probes });
  if (test.joint !== 'dovetail') return null;
  const reach = Math.max(0, ...test.islands.map((island) => dovetailSize(island.long)?.E ?? 0));
  const span = [Math.min(...test.islands.map((i) => i.span[0])), Math.max(...test.islands.map((i) => i.span[1]))];
  return reach > 0 ? { below: reach, above: reach, w: test.w, span, t: Math.max(...test.islands.map((i) => i.t)) } : null;
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
 * go where it and 2 mm round it hold nothing but its own plate: where the
 * plate is solid right through its thickness (a sealed pocket or an
 * engraving 0.3 mm deep or more is air, which the tab's outline and its
 * clearance would cut through), clear of anything standing 0.3 mm or more
 * proud of the plate above or below within reach of the cut (letters, a
 * boss, a plate at another height: a tab there would carry a slice of it
 * into the other piece), head/2 + 3 from a crossing cut's trace and as much
 * again as a crossing dovetail cut's tabs reach (or two tabs close off a
 * corner of a piece). Another plate the same cut runs through (the other
 * leg of a U) may lie in a tab's way if the tab lies wholly inside it too:
 * it makes the same tab there, and serves that plate as its own. A tab
 * whose even spot is taken moves along the plate to the nearest free one;
 * the cut must be N + 2 from parallel ones.
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
      // where the model near the cut is solid right through a plate's band (all but its outer 0.3 mm, the plate's own
      // unevenness), seen along w: a tab and its socket are extruded right through the plate, so they go only there,
      // never through a sealed pocket below the plate's middle or an engraving shallower than half of it
      const solidThrough = ([a, b]) => {
        const outline = outlineAt(w, (a + b) / 2);
        if (!(b - a > 2 * PROUD)) return outline;
        const sz = box.max.map((v, k) => v - box.min[k] + 4);
        sz[s] = 2 * (reach + TAB_INSIDE + 1);
        sz[w] = b - a - 2 * PROUD;
        const at = box.min.map((v, k) => (v + box.max[k]) / 2);
        at[s] = cut.at;
        at[w] = (a + b) / 2;
        const air = t.add(t.add(t.add(Manifold.cube(sz, true)).translate(at)).subtract(nearCut()));
        return air.isEmpty() ? outline : t.add(outline.subtract(t.add(t.add(air.transform(TO_PLANE[w])).project())));
      };
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
        const outline = solidThrough(island.band);
        // the other plates this cut runs through at other heights (the legs of a U, the shelves of a rack): a tab is
        // extruded through them too, and is welcome there as long as it lies wholly inside one or misses it
        const others = islands.filter((o) => o !== island && (o.band[1] < pw0 || o.band[0] > pw1)).map((o) => ({
          outline: solidThrough(o.band),
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
 * 'auto' gives plates tabs and everything else pins, 'pegs' gives plates
 * tabs (built in too, where pegs have no room) and everything else built-in
 * pegs, 'dovetail' gives plates tabs and says when a cut isn't one,
 * 'dowels' and 'none' skip the test. A plate under 2 mm thick is glued; one
 * whose tabs all fall outside the plate is glued too. Tabs make the pieces
 * either side lie flat on the plate, so a cut takes them only where each of
 * those pieces can (`liesFlat`, from the model each box of the cuts holds):
 * through the legs of a U one leg would be held over the bed, and beside a
 * sword's guard the blade would lie on the round grip; such a cut takes
 * pins (or pegs). The dovetail cuts on one axis share one thickness axis w
 * (their cells are extruded along it); cuts on another axis may go through
 * another plate (the two arms of an L). A cut that comes apart is tested
 * whatever the Joints are, and is never glued: through a thin plate its
 * pieces lie flat on unglued tabs, under 2 mm they just rest on each other
 * (`APART_FLAT`), and anywhere else it gets a lip (`'lip'`); it is never
 * told it isn't a plate.
 * @param {Manifold} solid (borrowed)
 * @param {{ id, letter, axis, at, apart? }[]} cuts normalised, in canonical order
 * @param {object} spec the normalised settings (`joint`, `clearance`)
 * @param {{ passthrough?: boolean, frame?: function }} options whether there are unrepaired triangles;
 *   `frame(axis)` lends the solid in that axis's plane frame
 * @returns {{ dove: { ids: string[], w: number|Object<string, number>, clearance: number }|null,
 *   joints: Object<string, 'dowels'|'pegs'|'dovetail'|'lip'|'none'>, plates: Object<string, object>, tabs: object|null, notes: object[] }}
 *   `dove` is what the cut stage's key holds: `w` the plates' thickness axis, or each cut's by id when they differ
 */
export function planDovetails(solid, cuts, spec = {}, { passthrough = false, frame = null } = {}) {
  const mode = spec.joint ?? SPLIT_DEFAULTS.joint;
  const joints = {};
  const plates = {};
  const notes = [];
  // the glued cuts take tabs under Auto and Dovetails only; a cut that comes apart is always tested, whatever the
  // Joints say: through a thin plate unglued tabs line its pieces up, anywhere else it gets a lip
  const glueTabs = mode !== 'none' && mode !== 'dowels';
  if (!glueTabs && !cuts.some((cut) => cut.apart)) {
    for (const cut of cuts) joints[cut.id] = mode;
    return { dove: null, joints, plates, tabs: null, notes };
  }
  const frames = planeFrames(solid, frame);
  const box = boxOf(solid);
  const by = axisCuts(cuts);
  const t = scope();
  let held = null; // what each box of the cuts holds of the model: made once, when a cut first passes the plate test
  try {
    const wOf = {};
    const axisW = [null, null, null];
    const ids = [];
    for (const cut of cuts) {
      if (!glueTabs && !cut.apart) {
        joints[cut.id] = mode;
        continue;
      }
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
      if (test.joint === 'dovetail') {
        held ??= cellSupport(solid.getMesh(), by);
        const thickness = Math.max(...test.islands.map((x) => x.t));
        if (!boxesBeside(held, cut.axis, i, cut.at).every((s) => liesFlat(s, test.w, thickness))) test = { ...test, joint: 'dowels', reason: 'lying' };
      }
      plates[cut.id] = test;
      if (cut.apart) {
        if (test.joint === 'dovetail' && (axisW[cut.axis] === null || axisW[cut.axis] === test.w)) {
          axisW[cut.axis] = test.w;
          wOf[cut.id] = test.w;
          ids.push(cut.id);
          joints[cut.id] = 'dovetail';
        } else if (test.joint === 'none') {
          // under 2 mm a plate takes nothing at all: its pieces just rest on each other
          joints[cut.id] = 'none';
          notes.push(splitNote('APART_FLAT', { letter: cut.letter, cutId: cut.id, axis: cut.axis, why: 'thin', wall: 2 }));
        } else joints[cut.id] = 'lip';
        continue;
      }
      if (test.joint === 'none') {
        joints[cut.id] = 'none';
        const n = test.islands.length;
        notes.push(splitNote('CONNECTORS_DROPPED', { letter: cut.letter, cutId: cut.id, count: n, total: n, wall: 2, ...(mode === 'pegs' ? { pegs: true } : {}) }));
      } else if (test.joint === 'dovetail' && (axisW[cut.axis] === null || axisW[cut.axis] === test.w)) {
        axisW[cut.axis] = test.w;
        wOf[cut.id] = test.w;
        ids.push(cut.id);
        joints[cut.id] = 'dovetail';
      } else {
        joints[cut.id] = mode === 'pegs' ? 'pegs' : 'dowels';
        // where tabs would not do, Auto gives pins and Built-in pegs gives pegs, as a matter of course: only asked-for
        // tabs are explained
        const why = { ...(test.reason === 'lying' ? { lying: true } : {}), ...(mode === 'pegs' ? { pegs: true } : {}) };
        if (mode === 'dovetail' || test.joint === 'dovetail') notes.push(splitNote('DOVETAIL_NOT_PLATE', { letter: cut.letter, cutId: cut.id, ...why }));
      }
    }
    if (!ids.length) return { dove: null, joints, plates, tabs: null, notes };
    const shared = new Set(Object.values(wOf)).size === 1;
    const w = shared ? wOf[ids[0]] : wOf;
    const tabs = dovetailTabs(solid, cuts, { ids, w }, { frame: (axis) => frames.get(axis) });
    const kept = [];
    const apart = new Set(cuts.filter((cut) => cut.apart).map((cut) => cut.id));
    for (const seam of tabs.seams) {
      if (seam.tabs.length) {
        kept.push(seam.cutId);
        continue;
      }
      // a cut that comes apart with no room for its tabs is given a lip to try instead, which tells what it gets
      if (apart.has(seam.cutId)) {
        joints[seam.cutId] = 'lip';
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
 * Gives each sealed hollow no cut opens (a magnet pocket, a void to save material) to the smallest shell around it.
 * `decompose()` gives such a hollow as a shell of its own, turned inside out, which no compose keeps: `fill(m)` makes
 * what is taken out of the shell again once it is composed, and the hollow's volume comes off the shell's.
 * @param {{ m: Manifold, v: number, box: object, hollows: Manifold[] }[]} solids the outer shells
 * @param {{ m: Manifold, v: number, box: object }[]} hollows
 */
function hostHollows(solids, hollows, fill) {
  for (const h of hollows) {
    const around = solids.filter((x) => [0, 1, 2].every((a) => x.box.min[a] <= h.box.min[a] + 1e-6 && x.box.max[a] >= h.box.max[a] - 1e-6));
    const host = around.sort((x, y) => x.v - y.v)[0];
    if (host) {
      host.hollows.push(fill(h.m));
      host.v += h.v;
    }
  }
}

/**
 * A piece parted into groups of its shells that print apart (`layPieces`):
 * each group's shells composed, their sealed hollows kept.
 * @param {Manifold} solid the piece (borrowed)
 * @param {{ box: object }[]} parts its shells, as `cutPieces` lists them
 * @param {number[][]} groups indices into `parts`
 * @returns {Manifold[]} one per group, the caller's
 */
export function partedSolids(solid, parts, groups) {
  const { Manifold } = manifold();
  const t = scope();
  const out = [];
  try {
    const solids = [];
    const hollows = [];
    for (const m of solid.decompose()) {
      t.add(m);
      const v = m.volume();
      (v > 0 ? solids : hollows).push({ m, v, box: boxOf(m), hollows: [] });
    }
    hostHollows(solids, hollows, (h) => t.add(insideOut(h)));
    // a shell is known by its box, which taking its hollows out does not change
    const gap = (p, x) => Math.max(...[0, 1, 2].flatMap((a) => [Math.abs(p.box.min[a] - x.box.min[a]), Math.abs(p.box.max[a] - x.box.max[a])]));
    const groupOf = new Map();
    for (const x of solids) {
      let best = 0;
      parts.forEach((p, i) => {
        if (gap(p, x) < gap(parts[best], x)) best = i;
      });
      groupOf.set(x, groups.findIndex((g) => g.includes(best)));
    }
    groups.forEach((_, k) => {
      const mine = solids.filter((x) => groupOf.get(x) === k);
      if (!mine.length) throw new SplitError('INTERNAL', 'A piece\'s shells came apart differently from how they were cut.');
      const whole = mine.length > 1 ? t.add(Manifold.compose(mine.map((x) => x.m))) : mine[0].m;
      const hollow = mine.flatMap((x) => x.hollows);
      out.push(hollow.length ? whole.subtract(hollow.length > 1 ? t.add(Manifold.compose(hollow)) : hollow[0]) : whole.translate([0, 0, 0]));
    });
    return out;
  } catch (err) {
    out.forEach((m) => m.delete());
    throw err;
  } finally {
    t.dispose();
  }
}

/** A closed surface turned inside out: a sealed hollow, as `decompose()` gives it, made the solid that fills it. */
function insideOut(m) {
  const wasm = manifold();
  const mesh = m.getMesh();
  const triVerts = Uint32Array.from(mesh.triVerts);
  for (let i = 0; i + 2 < triVerts.length; i += 3) [triVerts[i + 1], triVerts[i + 2]] = [triVerts[i + 2], triVerts[i + 1]];
  return wasm.Manifold.ofMesh(new wasm.Mesh({ numProp: mesh.numProp, vertProperties: mesh.vertProperties, triVerts }));
}

/**
 * The model cut into one piece per cell, axis by axis (x, y, z). A planar
 * axis is cut by taking away the boxes over every other cell, then the
 * rest; a dovetail axis by taking away everything outside each cell's
 * solid. Shells under 1e-3 mm³ are removed as dust; every other shell goes
 * to the cell its box overlaps most, and a cell's shells make one piece
 * (`layPieces` may print some of them apart). A sealed hollow that no cut
 * opens stays inside the shell around it. Pieces are numbered bottom layer
 * first, then front to back, then left to right. Each shell comes with its
 * orientation statistics, and the piece with theirs together: a shell whose
 * material meets a dovetail seam may only lie flat (±w, either plate's where
 * dovetails through two plates meet at it), and every shell of a thin plate
 * (`flat`) lies flat on it.
 * @param {Manifold} solid the model (borrowed, never deleted)
 * @param {{ id, letter, axis, at }[]} cuts normalised
 * @param {{ dove?: { ids: string[], w: number|object, clearance: number }|null, tabs?: object|null, bounds?: object,
 *   flat?: number|null, frame?: function, progress?: function }} options `tabs` the tabs `planDovetails` placed for
 *   `dove` (worked out again when missing); `flat` the thickness axis when the whole model is a thin plate (`plateAxis`)
 * @returns {{ pieces: { index: number, cell: number[], solid: Manifold, shells: number, volume: number,
 *   bbox: { min: number[], max: number[] }, cuts: string[], stats: object,
 *   parts?: { box: object, volume: number, cuts: string[], stats: object }[] }[], grid: number[],
 *   dovetails: { cutId, letter, axis, at, w, tabs: number }[], notes: object[], dust: number, gap: number, volume: number }}
 *   the piece solids belong to the caller; `parts` each shell of a piece with more than one, in the order
 *   `partedSolids` reads; `gap` is the volume the dovetail clearances took, `dust` the slivers removed
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
      const solids = [];
      const hollows = [];
      for (const m of list) {
        const v = m.volume();
        if (Math.abs(v) < DUST) {
          dust += Math.max(0, v);
          dustCount++;
          m.delete();
        } else (v > 0 ? solids : hollows).push({ m: own(m), v, box: boxOf(m), hollows: [] });
      }
      hostHollows(solids, hollows, (h) => temps.add(insideOut(h)));
      hollows.forEach((h) => drop(h.m));
      shells.push(...solids);
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
      const index = n + 1;
      // each shell's own statistics, judged from its outside: a sealed hollow's roof is bridged over, never held up by
      // supports that could not come out, so a magnet pocket is no reason to stand a bar on its edge
      const info = list.map((x) => {
        // the cuts the shell's own material meets: one that ends a few millimetres short of a dovetail cut holds none of
        // its plate (nothing near it changes hands, as the tabs keep clear of it), so the tabs ask nothing of how it lies
        const touching = cuts.filter((c) => c.at >= x.box.min[c.axis] - 0.02 && c.at <= x.box.max[c.axis] + 0.02);
        // a plate lies flat on its thickness; a shell on a dovetail seam on its plate's
        const flatOn = flat !== null ? [flat] : [...new Set(touching.filter((c) => doveCuts.has(c.id)).map((c) => doveCuts.get(c.id).w ?? plan.w))];
        const allowed = flatOn.length ? flatOn.flatMap((a) => [`-${AXES[a]}`, `+${AXES[a]}`]) : undefined;
        const mesh = x.m.getMesh();
        const stats = orientationStats(mesh.vertProperties, mesh.numProp, mesh.triVerts, touching, allowed ? { allowed } : {});
        return { box: x.box, volume: x.v, cuts: touching.map((c) => c.id), stats };
      });
      let m = list[0].m;
      if (list.length > 1) {
        m = own(Manifold.compose(list.map((x) => x.m)));
        list.forEach((x) => drop(x.m));
      }
      const hollow = list.flatMap((x) => x.hollows);
      if (hollow.length) {
        const emptied = own(m.subtract(hollow.length > 1 ? temps.add(Manifold.compose(hollow)) : hollow[0]));
        drop(m);
        m = emptied;
      }
      const status = m.status();
      if (status !== 'NoError') throw new SplitError('INTERNAL', `Piece ${index} came out broken (${status}).`, { pieceIndex: index, status });
      const ids = new Set(info.flatMap((x) => x.cuts));
      return {
        index,
        cell,
        solid: m,
        shells: list.length,
        volume: list.reduce((s, x) => s + x.v, 0),
        bbox: boxOf(m),
        cuts: cuts.filter((c) => ids.has(c.id)).map((c) => c.id),
        stats: mergeStats(info.map((x) => x.stats)),
        ...(info.length > 1 ? { parts: info } : {}),
      };
    });

    notes.push(...smallPieceNotes(pieces, cuts));

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
 * A pin's hole goes as far into both pieces; a built-in peg's socket goes
 * deep into one and its peg only just into the other, so its reach is told
 * for each side.
 * @param {Manifold} band from `bandFor` (borrowed), at least 0.5 mm thicker than the reach
 * @param {{ axis: number, at: number }} cut
 * @param {number|{ below: number, above: number }} reach (mm): as far either way, or how far below the face (towards
 *   −w, into the piece below the cut) and above it
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
    const { below, above } = typeof reach === 'number' ? { below: reach, above: reach } : reach;
    const slab = t.add(t.add(Manifold.cube([max[0] - min[0] + 4, max[1] - min[1] + 4, below + above], true))
      .translate([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, cut.at + (above - below) / 2]));
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

/**
 * How far a cut's holes may reach on each side: to the nearest parallel cut, or the model's end, below it (towards
 * −axis) and above it. A pin's holes go into both pieces and take the nearer; a peg's socket goes into one of them.
 */
function roomAround(cut, by, bounds) {
  const list = by[cut.axis];
  const below = list.filter((t) => t < cut.at - CUT_TOLERANCE);
  const above = list.filter((t) => t > cut.at + CUT_TOLERANCE);
  const lo = below.length ? below[below.length - 1] : bounds.min[cut.axis];
  const hi = above.length ? above[0] : bounds.max[cut.axis];
  return { below: cut.at - lo, above: hi - cut.at };
}

/**
 * The lips of the cuts that come apart, worked out face by face as the layout works them out: the shadow of the air
 * (and of what was placed before) at a reach, the obstacles on the groove's side, the lip each piece would carry
 * (`lipFor`), the better of two, and the cut tried a little way off for where a full lip fits (`moveFor`). Shared by
 * `layoutSplit` and `probeLip`, so a cut tried while it is being placed gets the lip and the move the download gives it.
 * @param {{ solid: Manifold, cuts: object[], bounds: { min: number[], max: number[] }, c: number, nozzle: number,
 *   keep: object, lipBand: number, source?: object|null }} options `keep` the scope that holds what is made until the
 *   caller is done; `source` where a cut's band, shadows and ceilings come from (`slicedSource`), the solid's own band
 *   and its booleans (`bandFor`, `shadowFor`, `overFor`) when not given
 */
function lipKit({ solid, cuts, bounds, c, nozzle, keep, lipBand, source = null }) {
  /** A cut's shadow at a reach (as `shadowFor`), kept for the layout: the air's once per reach, the earlier holes' added on top. */
  const shadowAt = (ctx, reach, withObstacles) => {
    const key = typeof reach === 'number' ? reach.toFixed(4) : `${reach.below.toFixed(4)}/${reach.above.toFixed(4)}`;
    if (!ctx.shadows.has(key)) ctx.shadows.set(key, keep.add(source ? source.shadow(ctx, reach) : shadowFor(ctx.band, ctx.cut, reach)));
    if (!withObstacles || !ctx.obstacles.length) return ctx.shadows.get(key);
    if (!ctx.shadows.has(`${key}|holes`)) {
      const holes = keep.add(shadowFor(ctx.band, ctx.cut, reach, { obstacles: ctx.obstacles, air: false }));
      ctx.shadows.set(`${key}|holes`, keep.add(ctx.shadows.get(key).add(holes)));
    }
    return ctx.shadows.get(`${key}|holes`);
  };

  /**
   * The obstacles on the groove's side of a patch of a cut that comes apart, the lip standing out of side k (0 the
   * piece below the cut), within R of the face: its columns that meet air there or a lip of a cut that came apart
   * before it (`ctx.obstacles`: two crossing cuts' tongues would fill one corner), and `root` the other way, where the
   * tongue's foot sinks into its own piece; and the groove's piece's own material over the island's openings
   * (`overFor`). Past the next cut on the groove's side its piece ends, so a reach beyond that meets the whole face (a
   * groove there would cut through to the next cut's lip). Kept for the layout, by reach.
   */
  const lipObstacles = (ctx, patch, k, root = LIP.root) => {
    const seen = new Map();
    return (R) => {
      const key = R.toFixed(4);
      if (!seen.has(key)) {
        patch.lipInset ??= keep.add(patch.lip.offset(-0.05, 'Miter', 4));
        const reach = k === 0 ? { below: root, above: R } : { below: R, above: root };
        const block = R > ctx.rooms[1 - k] + 1e-9 ? patch.lipInset : keep.add(shadowAt(ctx, reach, true).intersect(patch.lipInset));
        const over = !(R > 0) ? null : source ? source.over(ctx, 1 - k, R, patch.island) : overFor(ctx.band, ctx.cut, 1 - k, R, patch.island);
        if (over) keep.add(over);
        seen.set(key, { block: block.isEmpty() ? null : block, over });
      }
      return seen.get(key);
    };
  };
  /** What stands in the tongue's foot on side k of a patch: the air, and earlier lips, in the 0.5 mm it sinks in. */
  const lipRootAt = (ctx, patch, k) => () => {
    patch.lipRoot ??= new Map();
    if (!patch.lipRoot.has(k)) {
      patch.lipInset ??= keep.add(patch.lip.offset(-0.05, 'Miter', 4));
      const reach = k === 0 ? { below: LIP.root, above: 0 } : { below: 0, above: LIP.root };
      const r = keep.add(shadowAt(ctx, reach, true).intersect(patch.lipInset));
      patch.lipRoot.set(k, r.isEmpty() ? null : r);
    }
    return patch.lipRoot.get(k);
  };

  /** Each patch of a cut that comes apart planned with its lip on either piece (`lipFor`), the largest taking the key. */
  function planLipSides(ctx) {
    const hold = ctx.cut.apart?.hold ?? 'snap';
    const live = ctx.patches.filter((patch) => !patch.skip);
    const largest = live.reduce((best, patch) => (!best || patch.area > best.area ? patch : best), null);
    for (const patch of live) {
      patch.lipSides = [0, 1].map((k) => {
        const obstaclesAt = lipObstacles(ctx, patch, k);
        const { plan, kind } = lipFor(patch.lip, { island: patch.island, c, nozzle, hold, key: patch === largest, obstaclesAt });
        return { plan, kind, obstaclesAt, roomAt: lipObstacles(ctx, patch, k, 0), rootAt: lipRootAt(ctx, patch, k) };
      });
    }
  }

  // the lip each piece of a pair would carry, the better first in order: one at all, with clips, taller, more clips,
  // more tongue; the one below when they are as good
  const lipRank = (q) => (q ? [1, q.clips > 0 ? 1 : 0, q.H, q.clips, q.area] : [0, 0, 0, 0, 0]);
  const qualityOfPlan = (plan) => (plan ? { H: plan.H, clips: plan.windows.length, area: plan.area } : null);
  const betterLip = (pair) => {
    const [r0, r1] = pair.quality.map(lipRank);
    const i = r0.findIndex((x, n) => Math.abs(x - r1[n]) > 1e-6);
    const k = i < 0 || r0[i] > r1[i] ? 0 : 1;
    return pair.quality[k] ? { male: k, piece: k === 0 ? pair.lo : pair.hi, down: `${k === 0 ? '-' : '+'}${AXES[pair.axis]}` } : null;
  };

  /**
   * A cut that comes apart moved to `at` (kept, once a place): its band and its face's patches there, each with its
   * island, as the layout first takes a face, for trying the lip there.
   */
  const movedTo = (ctx, at) => {
    ctx.movedTo ??= new Map();
    const key = at.toFixed(6);
    if (!ctx.movedTo.has(key)) {
      const cut = { ...ctx.cut, at };
      const band = keep.add(source ? source.band(cut, lipBand) : bandFor(solid, cut, lipBand, bounds));
      const { face, patches } = patchesFor(band, cut, cuts);
      const islands = [];
      for (const raw of face.decompose()) {
        const cs = keep.add(raw.simplify(LIP.faceTolerance));
        raw.delete();
        islands.push({ cs, polygons: polygonsOf(cs) });
      }
      face.delete();
      for (const patch of patches) {
        keep.add(patch.cs);
        patch.uv = insidePoint(patch.polygons, patch.centroid);
        patch.lip = keep.add(patch.cs.simplify(LIP.faceTolerance));
        patch.island = (islands.find((isl) => insidePolygons(isl.polygons, patch.uv[0], patch.uv[1])) ?? islands[0])?.cs ?? patch.lip;
      }
      const d = at - ctx.cut.at;
      ctx.movedTo.set(key, { cut, band, patches, shadows: new Map(), obstacles: ctx.obstacles, rooms: [ctx.rooms[0] + d, ctx.rooms[1] - d] });
    }
    return ctx.movedTo.get(key);
  };

  /**
   * Where a cut that comes apart would give side k of a patch a full lip –
   * nothing in the way of a 6 mm lip, so as good a lip as the face takes
   * there, and better than the one it has (at least as good, for a move of
   * at least `least` mm) – each place tried as the cut there would have it,
   * in 0.5 mm steps. Something in the tongue's own foot (a cut right at the
   * top of a lantern's windows) is cleared a step or two towards the
   * groove's piece; anything else by moving away from it, as far as the room
   * at each place says, until a place has the room: a cut under a roof's
   * eaves, or in a jar's shoulder, where the move takes more of the slope
   * into the groove's piece and the next place says how much further. Null
   * when no place within six moves has it, or a move would leave the model
   * or reach another cut – or go past `within` ([lo, hi] along the axis,
   * where the caller has no use for a place beyond). The lip the place gives,
   * as that one patch would have it, is kept for `movedLip`.
   */
  const moveFor = (ctx, patch, k, least = 0, within = null) => {
    ctx.moveFor ??= new Map();
    ctx.movedLips ??= new Map();
    const key = `${ctx.patches.indexOf(patch)}|${k}|${least}${within ? `|${within.join('/')}` : ''}`;
    if (ctx.moveFor.has(key)) return ctx.moveFor.get(key);
    const hold = ctx.cut.apart?.hold ?? 'snap';
    const toward = k === 0 ? 1 : -1; // along the axis, the way to the groove's piece
    const now = lipRank(qualityOfPlan(patch.lipSides[k].plan)).slice(0, 4);
    const clear = (at) => {
      const d = at - ctx.cut.at;
      if (within && !(at >= within[0] - 1e-9 && at <= within[1] + 1e-9)) return false;
      return ctx.rooms[0] + d > CUT_TOLERANCE && ctx.rooms[1] - d > CUT_TOLERANCE;
    };
    const roomOf = (where, there) => lipRoom(there.lip, {
      island: there.island, c, nozzle, hold, obstaclesAt: lipObstacles(where, there, k, 0), rootAt: lipRootAt(where, there, k),
    });
    // a place with nothing in the way, where the lip is better than this one (or as good, moved for another reason)
    const full = (where, there, r) => {
      if (!r || r.shift > 0 || r.root) return null;
      const { plan } = lipFor(there.lip, { island: there.island, c, nozzle, hold, key: true, obstaclesAt: lipObstacles(where, there, k), heights: [LIP.heights[0]] });
      const quality = qualityOfPlan(plan);
      const rank = lipRank(quality).slice(0, 4);
      const n = rank.findIndex((x, i) => Math.abs(x - now[i]) > 1e-6);
      return (n < 0 ? least > 0 && rank[0] > 0 : rank[n] > now[n]) ? quality : null;
    };
    const tryAt = (at) => {
      if (!clear(at)) return null;
      const where = movedTo(ctx, at);
      const [u, v] = patch.uv;
      const there = where.patches.find((x) => insidePolygons(x.polygons, u, v)) ?? where.patches.reduce((b, x) => (!b || x.area > b.area ? x : b), null);
      if (!there) return null;
      const r = roomOf(where, there);
      const lip = full(where, there, r);
      return { at, r, ok: !!lip, lip };
    };
    const step = (at, d) => Math.round((at + d) * 1e6) / 1e6;
    const r0 = roomOf(ctx, patch);
    let found = null;
    let lip = null;
    if (r0?.root && !(least > 0)) {
      for (const d of [0.5, 1]) {
        const t = tryAt(step(ctx.cut.at, toward * d));
        if (t?.ok) {
          ({ at: found, lip } = t);
          break;
        }
      }
    }
    if (found == null && r0) {
      // a sloping wall leaves no foot anywhere near: half a step on at a time, as far as the six moves go
      let at = ctx.cut.at;
      let shift = Math.max(r0.shift, least, r0.root ? 0.5 : 0);
      for (let n = 0; n < 6 && shift > 0; n++) {
        const t = tryAt(step(at, -toward * Math.ceil(shift / 0.5 - 1e-9) * 0.5));
        if (!t?.r) break;
        if (t.ok) {
          ({ at: found, lip } = t);
          break;
        }
        at = t.at;
        shift = t.r.shift > 0 ? t.r.shift : t.r.root ? 0.5 : 0;
      }
    }
    ctx.moveFor.set(key, found);
    ctx.movedLips.set(key, lip);
    return found;
  };

  /** The lip the place `moveFor` found gives that patch (`{ H, clips, area }`), or null: what a move there is for. */
  const movedLip = (ctx, patch, k, least = 0, within = null) => (moveFor(ctx, patch, k, least, within) == null
    ? null
    : ctx.movedLips.get(`${ctx.patches.indexOf(patch)}|${k}|${least}${within ? `|${within.join('/')}` : ''}`));

  return { shadowAt, lipObstacles, lipRootAt, planLipSides, lipRank, qualityOfPlan, betterLip, movedTo, moveFor, movedLip };
}

/**
 * What stands round a cut, read from slices of the model rather than from a
 * band of it: the layout's shadows and ceilings (`shadowFor`, `overFor`) as
 * far as slices every `step` mm show them, and slices just inside each end of
 * a reach. A face's column meets air within a reach where some slice there
 * lacks it, and the groove's piece holds something over an opening where
 * some slice has it – or where it starts at the reach's very end, as the band
 * has it (a roof's shelf whose underside is exactly as far from the cut as
 * the groove reaches), so where the model has a face square to the axis
 * there (`flats`), a slice just past that end is read too. A slice of
 * a dense model costs a millisecond and the caller keeps them, where a band
 * of a million triangles and each shadow of it is a boolean of the lot: a
 * cut tried here and there while it is being placed reads a few dozen
 * slices. The step slices met or joined from the cut outwards are kept
 * (`keep`) as they are worked out, so a reach a little further meets only
 * the slices it adds. As close as the slices are: a ledge thinner than
 * `step` between two of them is missed, a slope read to within its rise
 * over `step`.
 * @param {(t: number) => CrossSection} sliceAt the model's slice at t, in the cut axis's plane frame (borrowed: the
 *   caller keeps them)
 * @param {{ step?: number, keep: { add: function }, flats?: number[] }} options `keep` holds what is worked out on the
 *   way, until the caller is done with the source; `flats` the heights of the model's faces square to the axis
 * @returns {{ band: function, shadow: function, over: function }} `lipKit`'s `source`: a stand-in for the band that
 *   gives only its slices, the shadow of the air at a reach within the face, and what is over the island's openings
 */
export function slicedSource(sliceAt, { step = 0.5, keep, flats = [] } = {}) {
  const { CrossSection } = manifold();
  const inside = 1e-4;
  const flatAt = (t) => flats.some((f) => Math.abs(f - t) < 1e-3);
  // the step heights strictly between lo and hi, a hair inside each: the first and the last
  const first = (lo) => Math.ceil((lo + inside) / step + 1e-9);
  const last = (hi) => {
    let k = Math.floor((hi - inside) / step);
    while (k * step >= hi - inside - 1e-9) k--;
    while ((k + 1) * step < hi - inside - 1e-9) k++;
    return k;
  };
  // the slices on the step heights from k0 on, one way (`dir`), met one after another from `seed` (a face) or joined
  const runs = new Map();
  const run = (key, k0, dir, seed) => {
    if (!runs.has(key)) runs.set(key, { k0, dir, seed, made: [] });
    return runs.get(key);
  };
  const upTo = (r, n) => {
    while (r.made.length < n) {
      const k = r.k0 + r.dir * r.made.length;
      const prev = r.made.length ? r.made[r.made.length - 1] : r.seed;
      const cs = sliceAt(k * step);
      r.made.push(keep.add(prev ? (r.seed ? prev.intersect(cs) : prev.add(cs)) : cs.translate(0, 0)));
    }
    return n ? r.made[n - 1] : r.seed;
  };
  return {
    band: () => ({ slice: (t) => sliceAt(t).translate(0, 0), delete() {} }),
    shadow(ctx, reach) {
      const { below, above } = typeof reach === 'number' ? { below: reach, above: reach } : reach;
      const at = ctx.cut.at;
      const face = sliceAt(at);
      const [lo, hi] = [at - below, at + above];
      const [k0, k1] = [first(lo), last(hi)];
      // the step heights at or under the cut, down from it, and over it, up from it
      const kd = Math.floor(at / step + 1e-9);
      const [top, bottom] = [Math.min(kd, k1), Math.max(kd + 1, k0)];
      const down = Math.max(0, top - k0 + 1);
      const up = Math.max(0, k1 - bottom + 1);
      const t = scope();
      try {
        let solid = down ? upTo(run(`m|${at}|-1|${top}`, top, -1, face), down) : face;
        if (up) {
          const over = upTo(run(`m|${at}|1|${bottom}`, bottom, 1, face), up);
          solid = down ? t.add(solid.intersect(over)) : over;
        }
        for (const h of [lo + inside, hi - inside]) solid = t.add(solid.intersect(sliceAt(h)));
        return face.subtract(solid);
      } finally {
        t.dispose();
      }
    },
    over(ctx, side, R, island) {
      const at = ctx.cut.at;
      const [lo, hi] = side === 1 ? [at + 1e-3, at + R] : [at - R, at - 1e-3];
      const outer = polygonsOf(island).filter((r) => ringArea(r) > 0);
      if (!outer.length || !(hi > lo)) return null;
      const [k0, k1] = [first(lo), last(hi)];
      const n = Math.max(0, k1 - k0 + 1);
      const t = scope();
      try {
        let held = side === 1 ? upTo(run(`j|1|${k0}`, k0, 1, null), n) : upTo(run(`j|-1|${k1}`, k1, -1, null), n);
        // the near end read a hair from the face, as the shadows read it: nothing ends between the two
        const ends = side === 1 ? [at + inside, hi - inside, ...(flatAt(hi) ? [hi + inside] : [])] : [...(flatAt(lo) ? [lo - inside] : []), lo + inside, at - inside];
        for (const h of ends) held = held ? t.add(held.add(sliceAt(h))) : sliceAt(h);
        const holes = t.add(t.add(new CrossSection(outer, 'Positive')).subtract(t.add(island.offset(0.05, 'Miter', 4))));
        const over = held.intersect(holes);
        if (over.area() > 1e-3) return over;
        over.delete();
        return null;
      } finally {
        t.dispose();
      }
    },
  };
}

/**
 * The lip a cut that comes apart would get there, before the model is cut
 * and with no other cut about: its face taken as the layout takes a face,
 * each patch planned with the lip on either piece (`lipFor`), the piece that
 * carries it chosen as `lipMale` chooses – `asWell` the caller's guess of
 * which piece would print as well with it (`endsAsWell`) – and, short of a
 * full lip, where the layout's moves find one (`suggestedAt`, as the notes
 * offer it). Where the piece that prints as well has no room for the lip and
 * a move gives it room, the cut has no lip here, as in the download. No
 * lip is built, nor the band round the cut when slices are given. Where
 * the caller has no use for a move (`moves` false), or none beyond
 * `within`, none is looked for that far.
 * @param {Manifold} solid (borrowed)
 * @param {{ axis: number, at: number }} cut
 * @param {{ c?: number, nozzle?: number, hold?: string, bounds?: { min: number[], max: number[] }, asWell?: boolean[],
 *   sliceAt?: (t: number) => CrossSection, flats?: number[], moves?: boolean, within?: number[]|null }} options
 *   `bounds` the model's, as the layout has them;
 *   `sliceAt` the model's slices along the cut's axis (plane frame, borrowed, kept by the caller), to read what stands
 *   round the cut from (`slicedSource`, with `flats` the heights of the model's faces square to the axis) – without it,
 *   the band round the cut and its booleans, as the layout reads them
 * @returns {{ patches: number, male: 0|1|null, lip: { H: number, clips: number, why: string|null, kind: string, broken: boolean }|null,
 *   noLip: 'miss'|'small'|'thin'|'room'|null, suggestedAt: number|null, suggestedLip: { H: number, clips: number }|null,
 *   quality: object[] }} `lip` over all the faces (the tallest, every clip; `why` as APART_NO_CLIPS has it, null with
 *   clips or on a hold with none; `broken` whether its main face's tongue comes in more than one stretch), `noLip`
 *   why there is none: the cut misses the model, its faces are too small (it
 *   runs through openings, or a small solid part), its walls too thin, or the piece past it has no room;
 *   `suggestedLip` the lip the move gives its main face – taller, or with clips; `quality` the lip each piece would
 *   carry, [below, above]
 */
export function probeLip(solid, cut, { c = SPLIT_DEFAULTS.clearance, nozzle = 0.4, hold = 'snap', bounds = null, asWell = [true, true], sliceAt = null, flats = [], moves = true, within = null } = {}) {
  const b = bounds ?? boxOf(solid);
  const one = { id: 'probe', letter: 'A', axis: cut.axis, at: cut.at, apart: { hold } };
  const keep = scope();
  try {
    const lipBand = lipReach(LIP.heights[0], 'opening', c, catchSizes('snap', c).i, true, nozzle).reach;
    const kit = lipKit({ solid, cuts: [one], bounds: b, c, nozzle, keep, lipBand, source: sliceAt ? slicedSource(sliceAt, { keep, flats }) : null });
    // the cut's face, its patches and islands, as a cut moved here has them
    const ctx = kit.movedTo({ cut: one, obstacles: [], rooms: [one.at - b.min[one.axis], b.max[one.axis] - one.at] }, one.at);
    const live = ctx.patches;
    // the lip a move gives, as the readout says what the move is for
    const lipOf = (q) => (q ? { H: q.H, clips: q.clips } : null);
    const none = (noLip, suggestedAt = null, male = null, quality = [null, null], suggestedLip = null) => ({
      patches: live.length, male, lip: null, noLip, suggestedAt, suggestedLip: lipOf(suggestedLip), quality,
    });
    if (!live.length) return none('miss');
    kit.planLipSides(ctx);
    // where the moves would give a full lip, for the readout: none asked (`moves`), or none past `within`
    const suggest = (patch, k) => (moves ? kit.moveFor(ctx, patch, k, 0, within) : null);
    const suggested = (patch, k) => (moves ? kit.movedLip(ctx, patch, k, 0, within) : null);
    const qualityOf = (k) => {
      const plans = live.map((patch) => patch.lipSides[k].plan).filter(Boolean);
      if (!plans.length) return null;
      return { H: Math.max(...plans.map((x) => x.H)), clips: plans.reduce((n, x) => n + x.windows.length, 0), area: plans.reduce((n, x) => n + x.area, 0) };
    };
    const quality = [qualityOf(0), qualityOf(1)];
    const largest = (list) => list.reduce((x, y) => (y.area > x.area ? y : x));
    const chosen = lipMale(quality, asWell);
    // the piece that prints as well has no room here: no lip, and where a move gives it one
    if (chosen?.alt != null) {
      const at = kit.moveFor(ctx, largest(live), chosen.alt, 0);
      if (at != null) return none('room', at, null, quality, kit.movedLip(ctx, largest(live), chosen.alt, 0));
    }
    if (chosen) {
      const k = chosen.male;
      // the notes speak of the face with the most tongue
      const main = live.filter((patch) => patch.lipSides[k].plan).reduce((x, y) => (y.lipSides[k].plan.area > x.lipSides[k].plan.area ? y : x));
      const side = main.lipSides[k];
      const { plan } = side;
      const caught = catchSizes(hold, c);
      const clips = quality[k].clips;
      // short of a full lip, how much room its groove has and where the cut would have enough, as the layout says it
      const full = plan.H >= LIP.heights[0] && (plan.windows.length > 0 || !caught);
      const r = full ? null : lipRoom(main.lip, { island: main.island, c, nozzle, hold, obstaclesAt: side.roomAt, rootAt: side.rootAt });
      let why = null;
      if (caught && !clips) {
        why = plan.H < LIP.heights[0] ? 'height' : ['flex', 'skin', 'short'].find((w) => plan.why.includes(w)) ?? 'short';
        if (why === 'short' && r?.root) why = 'edge';
      }
      // a tongue in more than one stretch: an opening's edge in its foot cuts it (just over a row of windows' tips)
      const broken = plan.T.filter((ring) => ringArea(ring) > 0).length > 1;
      return {
        patches: live.length, male: k, lip: { H: quality[k].H, clips, why, kind: plan.kind, broken }, noLip: null,
        suggestedAt: r ? suggest(main, k) : null, suggestedLip: r ? lipOf(suggested(main, k)) : null, quality,
      };
    }
    // no lip on offer: the faces too small for one, the walls too thin even with nothing in the way, or no room
    const sized = live.filter((patch) => patch.lipSides[0].kind);
    if (!sized.length) return none('small', null, null, quality);
    const main = largest(sized);
    const bare = planLip(main.lip, { island: main.island, c, nozzle, H: LIP.heights[LIP.heights.length - 1], hold: 'lift', key: false });
    if (!bare) return none('thin', null, null, quality);
    return none('room', suggest(main, 0), null, quality, suggested(main, 0));
  } finally {
    keep.dispose();
  }
}

/**
 * The pins, built-in pegs and labels of a split, cut by cut in canonical
 * order. For each cut: the band of solid round it, the face's patches (one
 * per pair of pieces), the exact shadow of air and of holes (or pegs and
 * sockets) placed by earlier cuts, and hole depths capped by the parallel
 * cuts either side. With an automatic diameter a sizing pass first picks
 * one size for the whole model (the largest of 8, 6, 5, 4, 3 mm that takes
 * two pins on every patch that can take any, at most a third of its width).
 * Then each patch gets its pins, falling back to shallower holes, then
 * 1.75 mm filament, then glue only; at most 48 pins in all, larger patches
 * first. A cut with built-in pegs is laid out the same way with square
 * pegs (8, 6, 5 or 4 mm, `pegSizesFor`), their socket's reach and inset, and
 * falls back to smaller pegs, then shorter ones, then glue only – never to
 * anything that must be printed or bought apart. A socket goes into one
 * piece only, so its reach and its depth cap are those of that piece's side,
 * and the peg needs only a wall's thickness of solid under its root
 * (`pegRoot`): a thin plate under a thick top carries the pegs and the top
 * takes the sockets. One piece of each pair across it carries all of that
 * face's pegs (`pegMales`), never one whose neighbour has no room for their
 * sockets, and where both have room, rather the one across from more of it
 * (`prefer`); the other gets the sockets. The model's peg size is sized on
 * the side each face's sockets go into. Labels ("2A") go on each pinned or
 * pegged face, in the same spot on both pieces. The cuts that come apart
 * are laid out first, one after another: each patch of a cut's faces is
 * planned with the lip on either piece (`lipFor`, the groove's side taking
 * the air past the face, the lips of the cuts before it, its own material
 * over the openings and the next cut as obstacles), one piece of each pair
 * is chosen to carry it (`apartMales`), lying the one way that keeps its
 * lip standing up – which the teardrops of the other cuts then follow –
 * unless the cut moved a little would let a piece that prints better carry
 * it, which the notes then offer; and the tongues and grooves are placed
 * before any pin, peg or label of the other cuts, which keep clear of them.
 * A lip short of full is tried at the places the notes would offer, and
 * only one found to have a full lip there is offered (`suggestedAt`). A
 * lip's face gets no label and counts towards no cap.
 * @param {Manifold} solid the model (borrowed)
 * @param {{ id, letter, axis, at }[]} cuts normalised, in canonical order
 * @param {{ index: number, cell: number[], up?: string, boxes?: object[] }[]} pieces from `cutPieces`, or `layPieces`, with
 *   the way each prints up (`chooseOrientation(...).up`); a hole is a teardrop on a piece whose up is not along the cut.
 *   Where a cell holds more than one, `boxes` (its shells') tell which holds each face
 * @param {object} spec the normalised settings (joint, diameter, depth, clearance, count, labels)
 * @param {{ nozzle?: number, joints?: Object<string, string>, tabs?: object|null, font?: object, bounds?: object,
 *   progress?: function, pegMales?: function|null, apartMales?: function|null }} options
 *   `joints` per cut id (from `planDovetails`; dowels when missing, pegs when the joint is built-in pegs, a lip on a cut
 *   that comes apart); `tabs` its
 *   dovetail tabs, whose sockets reach past their cut right through the model, so the holes of a crossing cut keep out
 *   of them as out of an earlier cut's holes; `font` the labels' (Inter), labels are skipped without it;
 *   `pegMales(pairs, length)` which of the pieces either side of each pegged face carries its pegs (split.js
 *   `pegMales`: for each `{ axis, lo, hi, sockets, prefer }`, 0 the one below the cut, 1 the one above, null neither,
 *   and so glue only; `sockets` which of the two has room for the sockets of the smallest peg the cut may take, [below,
 *   above]; `prefer`, where both have, the one across from more room for them – more of the faces, then larger pegs,
 *   then longer ones – or null; `length` how far the model's pegs stand out at most; `forced` the way down of each
 *   piece a lip stands out of, a Map by its number, for split.js `pegMales`' `forced`); when not given the one below, or
 *   the one across from the only one with room for the sockets, or from more of it, or neither when neither has;
 *   `apartMales(pairs, given)` which piece of each pair across a cut that comes apart carries its lip, asked cut by
 *   cut (split.js `apartMales`: for each `{ axis, lo, hi, quality: [below, above] }`, `quality` the lip each would carry,
 *   `{ H, clips, area }` or null, `{ male, piece, down, alt? }` or null; `given` the ways down the lips of the cuts
 *   before have given pieces, a Map by number); when not given the one with the better lip, else the one below
 * @returns {{ diameter: number|null, pegSize: number|null, dowels: object[], pegs: object[], labels: object[],
 *   lips: object[], seams: object[], notes: object[], pinnable: string[] }} `pinnable` the ids of the cuts with pegs
 *   whose faces would take pins instead (3 mm or larger), for the note on pegs printed standing up
 *   dowel `{ cutId, letter, patch, axis, at, centre, uv, d, depth, R, h, ch, cell, sides: [{ piece, tear, apex }, …] }`
 *   (side 0 the lower piece, `cell` the pin's half-cell for the exploded view);
 *   peg `{ cutId, letter, patch, axis, at, centre, uv, s, length, c, half, ch, e, h, tip, a, cell, male, dir, sides:
 *   [{ piece, peg }, …] }` (`male` the side that carries it, `dir` the way it points along the axis, ±1, `sides[k].peg`
 *   whether that side's piece carries it, the other having its socket);
 *   label `{ cutId, letter, patch, axis, at, size, centre, uv, sides: [{ piece, text, outward }, …] }`;
 *   lip, plain data, `{ cutId, letter, patch, axis, at, dir, male, down, sides: [{ piece, male }, …], hold, kind, hasOver,
 *   H, c, p, i, t, g0, d0, zTop, T, Tc, A, windows: [{ s0, s1, slot, chord }], key, clips, why, room, root,
 *   suggestedAt }` (`male` the side that carries it, `dir` the way it points along the axis, ±1, `down` the way its male
 *   lies, `T`, `Tc` and `A` its plan's polygons, `planLip`; `room`, `root` and `suggestedAt` where a full lip did not
 *   fit: the room its groove has, whether something stands in its tongue's foot, and where the cut was tried and has a
 *   full lip, or null);
 *   seam `{ cutId, letter, axis, at, pieces: [lo, hi], joint, patches, dowels, pegs, male, labels: [text, text]|null,
 *   apart? }` (`male` the number of the piece carrying its pegs or its lip, else null; `apart` on a cut that comes
 *   apart, `{ hold, lip, clips, height, key, faces, flat, tabs? }`: whether it has a lip, its clips, its height, whether
 *   it has the key, how many of the pair's faces have a lip and how many just rest, and its dovetail tabs' count)
 */
export function layoutSplit(solid, cuts, pieces, spec = {}, options = {}) {
  const { CrossSection, Manifold } = manifold();
  const { nozzle = 0.4, joints = {}, tabs = null, font = null, progress = null, pegMales = null, apartMales = null } = options;
  const bounds = options.bounds ?? boxOf(solid);
  const by = axisCuts(cuts);
  const c = Number.isFinite(spec.clearance) ? spec.clearance : SPLIT_DEFAULTS.clearance;
  const depth = Number(spec.depth) > 0 ? Number(spec.depth) : 0;
  const manual = Number(spec.diameter) > 0 ? Number(spec.diameter) : 0;
  const wanted = Number(spec.count) > 0 ? Math.round(Number(spec.count)) : 0;
  const labelsOn = spec.labels !== false && Boolean(font);
  // copies: a piece a lip stands out of is given its way up here, and the caller's stay as they were
  const own = pieces.map((p) => ({ ...p }));
  const inCell = new Map();
  for (const p of own) {
    const key = p.cell.join(',');
    if (!inCell.has(key)) inCell.set(key, []);
    inCell.get(key).push(p);
  }
  // the piece of a cell that holds a point of a face: a cell's shells printed apart are pieces of their own, and the
  // point lies in the box of one of their shells (the smallest, where boxes nest)
  const pieceAt = (cell, point) => {
    const list = inCell.get(cell.join(','));
    if (!list || list.length === 1) return list?.[0];
    let best = list[0];
    let room = Infinity;
    for (const p of list) {
      for (const b of p.boxes ?? []) {
        if (![0, 1, 2].every((a) => point[a] >= b.min[a] - 1e-3 && point[a] <= b.max[a] + 1e-3)) continue;
        const size = (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
        if (size < room) {
          best = p;
          room = size;
        }
      }
    }
    return best;
  };
  const reachMax = Math.max(LABEL_REACH, sizesFor(manual || AUTO_DIAMETERS[0], c, nozzle, depth).reach);
  const pegManual = pegSizeOf(manual);
  const pegReach = Math.max(LABEL_REACH, pegSizesFor(pegManual || AUTO_PEGS[0], c, nozzle, depth).reach);
  // what pins and pegs differ in: their sizes, the sizes Auto tries and how far into a piece they may reach
  const PIN = {
    auto: AUTO_DIAMETERS, full: (d, dep) => sizesFor(d, c, nozzle, dep), room: (d, dep, room) => sizesForRoom(d, c, nozzle, dep, room), reach: reachMax,
  };
  const PEG = {
    auto: AUTO_PEGS, full: (d, dep) => pegSizesFor(d, c, nozzle, dep), room: (d, dep, room) => pegSizesForRoom(d, c, nozzle, dep, room), reach: pegReach,
  };
  const jointOf = (cut) => joints[cut.id] ?? (cut.apart ? 'lip' : spec.joint === 'none' ? 'none' : spec.joint === 'pegs' ? 'pegs' : 'dowels');
  // a lip's band reaches as far as the tallest groove with clips over a ceiling may need (10.3 mm at 0.5 clearance)
  const lipBand = lipReach(LIP.heights[0], 'opening', c, catchSizes('snap', c).i, true, nozzle).reach;
  const notes = [];
  const dowels = [];
  const pegs = [];
  const labels = [];
  const contexts = [];
  const placed = []; // { m, side, box }: every half-hole placed so far, world
  const lipForced = new Map(); // piece -> the letter of the cut whose lip says how it lies
  const keep = scope(); // bands, patches, shadows and obstacles that live until the layout is done

  const { shadowAt, planLipSides, betterLip, moveFor } = lipKit({ solid, cuts, bounds, c, nozzle, keep, lipBand });

  /**
   * How far a peg of these sizes reaches either side of its face with its socket in the piece on side k (0 the one
   * below the cut): the socket and its wall into that piece, the peg's root into the other.
   */
  const socketReach = (s, k) => (k === 0 ? { below: s.reach, above: pegRoot(s) } : { below: pegRoot(s), above: s.reach });
  // pegs whose sockets go into side k of a cut: the socket needs its room on that side, and the peg's own piece its
  // root's depth before the next cut on the other (the shadow only sees the model, so a sliver between two cuts would
  // otherwise carry pegs on 1.5 mm of material)
  const pegsInto = (ctx, k) => ({
    ...PEG,
    room: (d, dep, room) => {
      const s = PEG.room(d, dep, room);
      return s && ctx.rooms[1 - k] >= pegRoot(s) - 1e-9 ? s : null;
    },
  });

  /** Pin (or peg) centres for a patch at these sizes, their holes (or socket and peg) reaching this far, or none. */
  const centresFor = (ctx, patch, s, n, withObstacles, t, reach = s.reach) => {
    const free = t.add(patch.cs.subtract(shadowAt(ctx, reach, withObstacles)));
    const tear = patch.apex.some(Boolean);
    const safe = t.add(free.offset(-(tear ? s.rhoTear : s.rho), 'Round', 2, 32));
    if (safe.isEmpty()) return [];
    return chooseCentres(polygonsOf(safe), n, s.sMin, patch.centroid, { d: s.d });
  };

  /**
   * The largest of `sizes` with D ≤ W/3 (W twice the deepest inset of the
   * patch's solid columns) that takes two pins (or pegs, `kind`) on a patch,
   * their holes reaching `reachOf(sizes)` from the face, within `room` of it:
   * first against the shadow of the largest size's reach, which is
   * conservative for every size, then, finding none, with each size's own
   * reach. Its sizes (`kind.room`'s, as deep as the room lets them go), or
   * null when none takes two.
   */
  function sizeOn(ctx, patch, kind, sizes, reachOf, room, t) {
    const need = Math.min(2, wanted || 2);
    const widest = kind.full(sizes[0], depth);
    const widthCap = (3 * sizes[0]) / 2; // D ≤ W/3, so no width beyond three of the largest size changes the answer
    const free = t.add(patch.cs.subtract(shadowAt(ctx, reachOf(widest), false)));
    const W = 2 * largestInset(free, widthCap);
    const tear = patch.apex.some(Boolean);
    for (const D of sizes) {
      const s = kind.room(D, depth, room);
      if (!s || D > W / 3 + 1e-9) continue;
      const safe = t.add(free.offset(-(tear ? s.rhoTear : s.rho), 'Round', 2, 32));
      if (!safe.isEmpty() && chooseCentres(polygonsOf(safe), need, s.sMin, patch.centroid, { d: D }).length >= need) return s;
    }
    const small = kind.room(sizes[sizes.length - 1], depth, room);
    const W3 = small ? 2 * largestInset(t.add(patch.cs.subtract(shadowAt(ctx, reachOf(small), false))), widthCap) : 0;
    for (const D of sizes) {
      const s = kind.room(D, depth, room);
      if (!s || D > W3 / 3 + 1e-9) continue;
      if (centresFor(ctx, patch, s, need, false, t, reachOf(s)).length >= need) return s;
    }
    return null;
  }

  /**
   * The pins' sizing pass: per patch of at least 50 mm², the largest
   * automatic size it takes (`sizeOn`); the model's diameter is the smallest
   * found. Null when no patch takes any.
   */
  function sizePass(list) {
    let best = null;
    for (const ctx of list) {
      for (const patch of ctx.patches) {
        if (patch.skip || patch.area < SIZING_PATCH) continue;
        const t = scope();
        try {
          const found = sizeOn(ctx, patch, PIN, PIN.auto, (s) => s.reach, ctx.room, t)?.d ?? null;
          if (found !== null) best = best === null ? found : Math.min(best, found);
        } finally {
          t.dispose();
        }
      }
    }
    return best;
  }

  /**
   * Whether pins of the smallest size Auto gives (3 mm) would join a pegged
   * cut's faces in place of its pegs, as `layoutCut` looks for room for
   * them: holes in both pieces, on every face that has pegs. A plate too thin
   * for sockets is mostly too thin for pin holes too.
   */
  function pinsFit(ctx) {
    const faces = ctx.patches.filter((patch) => !patch.skip && patch.pegs.length);
    if (!faces.length) return false;
    const d = AUTO_DIAMETERS[AUTO_DIAMETERS.length - 1];
    const room = Math.min(ctx.room, PEG.reach - 0.01); // no deeper than the band the cut's faces were measured in
    const t = scope();
    try {
      return faces.every((patch) => {
        const need = Math.min(2, patch.pegs.length);
        return [depth, sizesFor(d, c, nozzle).minDepth].some((dep) => {
          const s = sizesForRoom(d, c, nozzle, dep, room);
          return Boolean(s) && centresFor(ctx, patch, s, need, false, t).length >= need;
        });
      });
    } finally {
      t.dispose();
    }
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
          // holes made shallower where air lies behind the face take shorter filament: each length is told apart
          filament ??= new Map();
          filament.set(2 * s.depth, (filament.get(2 * s.depth) ?? 0) + pts.length);
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
    if (filament) {
      const lengths = [...filament].sort((p, q) => q[0] - p[0]).map(([length, count]) => ({ length, count }));
      notes.push(splitNote('CONNECTORS_FILAMENT', {
        ...base, count: lengths.reduce((n, g) => n + g.count, 0), diameter: D, length: lengths[0].length,
        ...(lengths.length > 1 ? { lengths } : {}), ...(suggested ? { suggestedDiameter: suggested } : {}),
      }));
    }
    if (dropped) {
      notes.push(splitNote('CONNECTORS_DROPPED', { ...base, count: dropped, total, ...(thinWalls ? { wall: thinWalls } : {}), ...(suggested && !filament ? { suggestedDiameter: suggested } : {}) }));
    }
    if (one) notes.push(splitNote('ONE_CONNECTOR', base));
  }

  /**
   * The built-in pegs of one cut: each patch tries the size chosen, then
   * the smaller ones, then each of them shorter, and is glued when none
   * fits; never anything printed or bought apart. All the pegs of a patch
   * stand on the piece `pegMales` chose for its pair, their sockets reaching
   * into the other one only, as deep as its side has room for. The notes say
   * what had to give.
   */
  function layoutPegs(ctx, D) {
    const { cut } = ctx;
    const a = cut.axis;
    const sizes = [D, ...AUTO_PEGS.filter((x) => x < D)];
    const tries = [...sizes.map((x) => [x, depth]), ...sizes.map((x) => [x, pegSizesFor(x, c, nozzle).minDepth])];
    const least = pegSizesFor(sizes[sizes.length - 1], c, nozzle);
    let shorter = null;
    const smaller = new Map();
    let one = false;
    let dropped = 0;
    let unlaid = 0;
    let thin = 0;
    let total = 0;
    let thinWalls = 0;
    ctx.patches.forEach((patch, patchIndex) => {
      if (patch.skip || patch.capped || !patch.alloc) return;
      total++;
      // a pair neither of whose pieces can lie on the bed carrying the pegs is glued: when one of them has no room for
      // the sockets, it is the one that can't
      if (patch.male === null && patch.sockets.some(Boolean)) {
        unlaid++;
        if (!patch.sockets.every(Boolean)) thin++;
        return;
      }
      // the sockets go into the piece across from the one carrying the pegs; a face with room for them on neither
      // side tries nothing, and is told of as one no peg fits
      const k = 1 - patch.male;
      const need = Math.min(2, patch.alloc);
      const t = scope();
      try {
        let chosen = null;
        let single = null;
        const seen = new Set();
        for (const [x, dep] of patch.male === null ? [] : tries) {
          const s = pegsInto(ctx, k).room(x, dep, ctx.rooms[k]);
          if (!s || seen.has(`${x}|${s.length}`)) continue;
          seen.add(`${x}|${s.length}`);
          const pts = centresFor(ctx, patch, s, patch.alloc, true, t, socketReach(s, k));
          if (pts.length >= need) {
            chosen = { s, pts };
            break;
          }
          if (pts.length === 1 && !single) single = { s, pts };
        }
        chosen ??= single;
        if (!chosen) {
          dropped++;
          // how thick a wall the smallest peg needs, told where the face is too thin for it (slivers need no word)
          if (patch.area >= SIZING_PATCH && 2 * largestInset(patch.cs, least.rho + 0.05) < 2 * least.rho) {
            thinWalls = Math.max(thinWalls, Math.ceil(2 * least.rho * 10 - 1e-6) / 10);
          }
          return;
        }
        const { s, pts } = chosen;
        if (pts.length < need) one = true;
        if (s.s < D) smaller.set(s.s, (smaller.get(s.s) ?? 0) + pts.length);
        else if (s.length < PEG.full(s.s, depth).length - 1e-9) shorter = Math.min(shorter ?? Infinity, s.length);
        for (const [u, v] of pts) {
          const centre = applyMat4(TO_WORLD[a], [u, v, cut.at]);
          const cell = cellOfPoint(centre, by);
          cell[a] += 0.5;
          const peg = {
            cutId: cut.id,
            letter: cut.letter,
            patch: patchIndex,
            axis: a,
            at: cut.at,
            centre,
            uv: [u, v],
            s: s.s,
            length: s.length,
            c,
            half: s.half,
            ch: s.ch,
            e: s.e,
            h: s.h,
            tip: s.tip,
            a: s.a,
            cell,
            male: patch.male,
            dir: patch.male === 0 ? 1 : -1,
            sides: [patch.lo, patch.hi].map((piece, k) => ({ piece: piece.index, peg: k === patch.male })),
          };
          patch.pegs.push(peg);
          pegs.push(peg);
        }
      } finally {
        t.dispose();
      }
    });
    const base = { letter: cut.letter, cutId: cut.id, pegs: true };
    if (shorter !== null) notes.push(splitNote('CONNECTORS_SHORTER', { ...base, depth: shorter }));
    if (smaller.size) {
      notes.push(splitNote('PEGS_SMALLER', { ...base, asked: D, pegSizes: [...smaller].sort((p, q) => q[0] - p[0]).map(([size, count]) => ({ size, count })) }));
    }
    // faces too thin for a peg are told of as such; when none is, only that no piece could carry them, or that the
    // piece too thin for the sockets could not
    if (dropped || unlaid) {
      const why = dropped ? {} : thin === unlaid ? { thin: true } : { lying: true };
      notes.push(splitNote('CONNECTORS_DROPPED', { ...base, count: dropped + unlaid, total, ...(thinWalls ? { wall: thinWalls } : {}), ...why }));
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
   * A label for each side of a pinned or pegged patch, at the same spot: the
   * largest size (8 mm down to 3 mm) whose text, with 1 mm round it, fits
   * the room left on the face clear of the holes, pegs and sockets with their
   * chamfers, the spot nearest the face's centroid.
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
      // a peg's socket mouth reaches its half-diagonal out along the plane's axes; the peg stands within it
      for (const g of patch.pegs) circles.push(t.add(t.add(CrossSection.circle(g.a + LABEL_HOLE_GAP, 32)).translate(g.uv[0], g.uv[1])));
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

  /**
   * The notes of a cut that comes apart: how it goes together, or why its
   * lip has no clips, or why it has no lip at all – its faces too small (it
   * runs through openings), its walls too thin, no piece that may lie with
   * the lip standing up, no room in the groove's piece past the cut, or the
   * piece that prints as well with it too tall then for the printer – with
   * where the cut would have one.
   */
  function lipNotes(ctx) {
    const { cut } = ctx;
    const hold = cut.apart?.hold ?? 'snap';
    const caught = catchSizes(hold, c);
    const base = { letter: cut.letter, cutId: cut.id, axis: cut.axis };
    const live = ctx.patches.filter((patch) => !patch.skip);
    if (!live.length) return;
    const one = (set) => {
      const list = [...set].sort((x, y) => x - y);
      return list.length === 1 ? list[0] : list;
    };
    const here = live.filter((patch) => patch.lipOn).map((patch) => patch.lipOn);
    // the faces with a lip on offer that no piece may carry, lying as it must already, and those with none
    const lying = live.filter((patch) => !patch.lipPair?.male && !patch.lipPair?.moved && patch.lipPair?.pair.quality.some(Boolean));
    if (here.length) {
      const male = new Set(here.map((l) => l.sides[l.male].piece));
      const female = new Set(here.map((l) => l.sides[1 - l.male].piece));
      const clips = here.reduce((n, l) => n + l.clips, 0);
      const height = Math.max(...here.map((l) => l.H));
      notes.push(splitNote('APART', {
        ...base, above: here.some((l) => l.male === 1), male: one(male), female: one(female), hold, clips, height, faces: here.length,
        flat: live.length - here.length - lying.length, lying: lying.length,
      }));
      if (caught && !clips) {
        const main = here.reduce((x, y) => (y.area > x.area ? y : x));
        let why = main.H < LIP.heights[0] ? 'height' : ['flex', 'skin', 'short'].find((w) => main.why.includes(w)) ?? 'short';
        // a tongue cut short by an opening right under the cut, not by the outline's shape
        if (why === 'short' && main.root) why = 'edge';
        notes.push(splitNote('APART_NO_CLIPS', {
          ...base, female: one(female), why, height, need: lipReach(LIP.heights[0], main.kind, c, caught.i, false, nozzle).reach,
          ...(main.suggestedAt != null ? { suggestedAt: main.suggestedAt } : {}),
        }));
      }
      return;
    }
    const flat = { ...base, pieces: [one(new Set(live.map((patch) => patch.lo.index))), one(new Set(live.map((patch) => patch.hi.index)))] };
    const sized = live.filter((patch) => patch.lipSides[0].kind);
    if (!sized.length) {
      notes.push(splitNote('APART_FLAT', { ...flat, why: 'small' }));
      return;
    }
    // the piece that prints as well would carry it, moved: where to
    const moved = live.map((patch) => patch.lipPair?.moved).find(Boolean);
    if (moved) {
      const main = sized.reduce((x, y) => (y.area > x.area ? y : x));
      notes.push(splitNote('APART_FLAT', {
        ...flat, why: moved.why, need: lipReach(LIP.heights[LIP.heights.length - 1], main.lipSides[moved.k].kind, c, 0, false, nozzle).reach,
        ...(moved.why === 'tall' ? { piece: moved.piece, other: moved.other } : {}), suggestedAt: moved.at,
      }));
      return;
    }
    if (lying.length) {
      // pieces another cut's lip already lies one way, by that cut's letter
      const by = [...new Set(lying.flatMap((patch) => [patch.lo.index, patch.hi.index]).filter((i) => lipForced.has(i)).map((i) => lipForced.get(i)))].sort();
      const fixed = [...new Set(lying.flatMap((patch) => [patch.lo.index, patch.hi.index]).filter((i) => lipForced.has(i)))].sort((x, y) => x - y);
      notes.push(splitNote('APART_FLAT', { ...flat, why: 'lying', ...(by.length ? { by, fixed: one(fixed) } : {}) }));
      return;
    }
    // walls too thin take no lip even with nothing in the way; else what is in the way is why, on the side the groove
    // was to go (beyond the cut, unless its piece was chosen to carry the lip)
    const main = sized.reduce((x, y) => (y.area > x.area ? y : x));
    const k = main.lipPair?.male?.male ?? 0;
    const lowest = LIP.heights[LIP.heights.length - 1];
    const bare = planLip(main.lip, { island: main.island, c, nozzle, H: lowest, hold: 'lift', key: false });
    if (!bare) {
      const sizes = lipSizesFor(c, nozzle, 'lift');
      notes.push(splitNote('APART_FLAT', { ...flat, why: 'thin', wall: Math.ceil((LIP.g0 + sizes.tMin + sizes.wall + c) * 10 - 1e-6) / 10 }));
      return;
    }
    const suggestedAt = moveFor(ctx, main, k);
    notes.push(splitNote('APART_FLAT', {
      ...flat, why: 'room', need: lipReach(lowest, main.lipSides[k].kind, c, 0, false, nozzle).reach, ...(suggestedAt != null ? { suggestedAt } : {}),
    }));
  }

  // the stage is told from the start: on a dense model the bands and the sizing pass take seconds before any pin is placed
  const joined = cuts.filter((cut) => jointOf(cut) === 'dowels' || jointOf(cut) === 'pegs');
  const stage = !joined.length && cuts.some((cut) => jointOf(cut) === 'lip')
    ? 'Fitting the lip…'
    : joined.length && joined.every((cut) => jointOf(cut) === 'pegs') ? 'Finding room for pegs…' : 'Finding room for pins…';
  const steps = cuts.length + 1 + joined.length;
  try {
    // ---- every cut's face, its patches and the pieces either side ----
    for (const cut of cuts) {
      progress?.(stage, { done: contexts.length, total: steps });
      const joint = jointOf(cut);
      const kind = joint === 'pegs' ? PEG : PIN;
      const band = keep.add(bandFor(solid, cut, joint === 'dowels' || joint === 'pegs' ? kind.reach : joint === 'lip' ? lipBand : 0.5, bounds));
      const { face, patches } = patchesFor(band, cut, cuts);
      // a lip takes its openings from the face's whole island (a crossing cut halves it), the outlines eased by
      // 0.02 mm, so a dense one plans in a moment
      const islands = [];
      if (joint === 'lip') {
        for (const raw of face.decompose()) {
          const cs = keep.add(raw.simplify(LIP.faceTolerance));
          raw.delete();
          islands.push({ cs, polygons: polygonsOf(cs) });
        }
      }
      face.delete();
      const a = cut.axis;
      const lo = by[a].indexOf(cut.at);
      for (const patch of patches) {
        keep.add(patch.cs);
        const [u, v] = insidePoint(patch.polygons, patch.centroid);
        patch.uv = [u, v];
        const point = applyMat4(TO_WORLD[a], [u, v, cut.at]);
        const cell = cellOfPoint(point, by);
        cell[a] = lo;
        patch.lo = pieceAt(cell, point);
        cell[a] = lo + 1;
        patch.hi = pieceAt(cell, point);
        patch.skip = !patch.lo || !patch.hi;
        patch.apex = patch.skip ? [null, null] : [teardropApex(patch.lo.up ?? '+z', a), teardropApex(patch.hi.up ?? '+z', a)];
        patch.dowels = [];
        patch.pegs = [];
        patch.male = null;
        patch.sockets = [true, true];
        patch.fit = [null, null];
        patch.label = null;
        patch.alloc = 0;
        if (joint === 'lip') {
          patch.lip = keep.add(patch.cs.simplify(LIP.faceTolerance));
          patch.island = (islands.find((isl) => insidePolygons(isl.polygons, u, v)) ?? islands[0])?.cs ?? patch.lip;
        }
      }
      // a pin's holes go into both pieces and take the nearer room; a peg's socket only that of its own side
      const room = roomAround(cut, by, bounds);
      contexts.push({ cut, joint, kind, band, patches, room: Math.min(room.below, room.above), rooms: [room.below, room.above], shadows: new Map(), obstacles: [] });
    }
    const pinned = contexts.filter((x) => x.joint === 'dowels');
    const pegged = contexts.filter((x) => x.joint === 'pegs');
    const connected = contexts.filter((x) => x.joint === 'dowels' || x.joint === 'pegs');
    const lipped = contexts.filter((x) => x.joint === 'lip');
    const sockets = connected.length && tabs?.seams?.some((x) => x.tabs.length) ? keep.add(socketsOf(tabs, cuts, bounds, c)) : null;

    // ---- the lips of the cuts that come apart, first: which piece carries each decides how that piece lies, which
    // the other cuts' teardrops then follow, and every pin, peg and label keeps clear of them ----
    const forced = new Map();
    const lips = [];
    if (lipped.length) {
      const byIndex = new Map(own.map((p) => [p.index, p]));
      // the lip each piece of a pair would carry over all the pair's faces: the tallest, every clip, all the tongue
      const qualityOf = (list, k) => {
        const plans = list.map((patch) => patch.lipSides[k].plan).filter(Boolean);
        if (!plans.length) return null;
        return { H: Math.max(...plans.map((x) => x.H)), clips: plans.reduce((n, x) => n + x.windows.length, 0), area: plans.reduce((n, x) => n + x.area, 0) };
      };
      // cut by cut, each keeping clear of the lips placed before it, as of air (two crossing cuts' tongues would fill
      // one corner), and of the ways their pieces must lie
      lipped.forEach((ctx, done) => {
        progress?.('Fitting the lip…', { done, total: lipped.length });
        const near = placed.filter((x) => x.box.max[ctx.cut.axis] > ctx.cut.at - lipBand && x.box.min[ctx.cut.axis] < ctx.cut.at + lipBand);
        ctx.obstacles = near.length ? [keep.add(Manifold.compose(near.map((x) => x.m)))] : [];
        planLipSides(ctx);
        const lipPairs = new Map();
        for (const patch of ctx.patches) {
          if (patch.skip) continue;
          const key = `${patch.lo.index}|${patch.hi.index}`;
          if (!lipPairs.has(key)) lipPairs.set(key, { ctx, patches: [] });
          lipPairs.get(key).patches.push(patch);
        }
        const groups = [...lipPairs.values()];
        const list = groups.map(({ patches }) => ({
          axis: ctx.cut.axis, lo: patches[0].lo.index, hi: patches[0].hi.index, quality: [qualityOf(patches, 0), qualityOf(patches, 1)],
        }));
        const chosen = apartMales ? apartMales(list, forced) : list.map(betterLip);
        groups.forEach((g, n) => {
          g.pair = list[n];
          g.male = chosen[n] ?? null;
          for (const patch of g.patches) patch.lipPair = g;
          // a piece that would print worse with the lip, where the other would print as well carrying it once the
          // cut moves: no lip here, and the note says where
          const alt = g.male?.alt;
          if (alt) {
            const main = g.patches.reduce((x, y) => (y.area > x.area ? y : x));
            const at = moveFor(ctx, main, alt.k, alt.why === 'tall' ? alt.over : 0);
            if (at != null) {
              g.moved = { at, why: alt.why, k: alt.k, piece: alt.piece, other: g.male.piece };
              g.male = null;
            }
          }
          if (!g.male) return;
          forced.set(g.male.piece, g.male.down);
          lipForced.set(g.male.piece, ctx.cut.letter);
          byIndex.get(g.male.piece).up = oppositeDir(g.male.down);
        });
        const hold = ctx.cut.apart?.hold ?? 'snap';
        for (const g of groups) {
          if (!g.male) continue;
          const k = g.male.male;
          for (const patch of g.patches) {
            const side = patch.lipSides[k];
            const plan = side.plan;
            if (!plan) continue;
            // short of a full lip (6 mm, with clips on a hold that has them): how much room the groove has, and where
            // the cut would have enough
            const full = plan.H >= LIP.heights[0] && (plan.windows.length > 0 || !catchSizes(hold, c));
            const r = full ? null : lipRoom(patch.lip, { island: patch.island, c, nozzle, hold, obstaclesAt: side.roomAt, rootAt: side.rootAt });
            const lip = {
              cutId: ctx.cut.id,
              letter: ctx.cut.letter,
              patch: ctx.patches.indexOf(patch),
              axis: ctx.cut.axis,
              at: ctx.cut.at,
              dir: k === 0 ? 1 : -1,
              male: k,
              down: g.male.down,
              sides: [patch.lo, patch.hi].map((piece, j) => ({ piece: piece.index, male: j === k })),
              hold,
              kind: plan.kind,
              hasOver: plan.hasOver,
              H: plan.H,
              c,
              p: plan.p,
              i: plan.i,
              t: plan.t,
              g0: plan.g0,
              d0: plan.d0,
              zTop: plan.zTop,
              T: plan.T,
              Tc: plan.Tc,
              A: plan.A,
              windows: plan.windows,
              key: plan.key,
              clips: plan.windows.length,
              why: plan.why,
              area: plan.area,
              room: r ? r.room : null,
              root: Boolean(r?.root),
              suggestedAt: r ? moveFor(ctx, patch, k) : null,
            };
            patch.lipOn = lip;
            lips.push(lip);
            // the tongue is its male's and the groove its female's: placed apart, as a hole's two halves are
            const tongue = keep.add(lipAt(lip));
            const groove = keep.add(lipCavityAt(lip));
            placed.push({ m: tongue, side: k, box: boxOf(tongue) }, { m: groove, side: 1 - k, box: boxOf(groove) });
          }
        }
      });
      for (const ctx of contexts) {
        for (const patch of ctx.patches) {
          if (!patch.skip) patch.apex = [teardropApex(patch.lo.up ?? '+z', ctx.cut.axis), teardropApex(patch.hi.up ?? '+z', ctx.cut.axis)];
        }
      }
      for (const ctx of lipped) lipNotes(ctx);
    }

    // ---- which side of each pegged face has room for its sockets at all: the smallest peg the cut may fall back to,
    // as short as it may be, fits there. A plate under a thick top has none, and carries the pegs instead ----
    progress?.(stage, { done: cuts.length, total: steps });
    const leastPeg = Math.min(pegManual || Infinity, AUTO_PEGS[AUTO_PEGS.length - 1]);
    const { minDepth } = pegSizesFor(leastPeg, c, nozzle);
    const shortest = depth > 0 ? Math.min(depth, minDepth) : minDepth;
    for (const ctx of pegged) {
      for (const patch of ctx.patches) {
        if (patch.skip) continue;
        const t = scope();
        try {
          patch.sockets = [0, 1].map((k) => {
            const s = pegsInto(ctx, k).room(leastPeg, shortest, ctx.rooms[k]);
            return Boolean(s) && centresFor(ctx, patch, s, 1, false, t, socketReach(s, k)).length > 0;
          });
        } finally {
          t.dispose();
        }
      }
    }

    // ---- the largest peg each side's sockets take on each face of 50 mm² or more (`sizeOn`): the model's size is
    // that of the side its sockets go into, and the two sides are told apart by it. With a size set, it is only
    // needed where both sides have room ----
    const sizesOn = pegManual ? [pegManual, ...AUTO_PEGS.filter((x) => x < pegManual)] : AUTO_PEGS;
    for (const ctx of pegged) {
      for (const patch of ctx.patches) {
        if (patch.skip || patch.area < SIZING_PATCH || (pegManual && !patch.sockets.every(Boolean))) continue;
        const t = scope();
        try {
          patch.fit = [0, 1].map((k) => (patch.sockets[k] ? sizeOn(ctx, patch, pegsInto(ctx, k), sizesOn, (s) => socketReach(s, k), ctx.rooms[k], t) : null));
        } finally {
          t.dispose();
        }
      }
    }

    // ---- one diameter for the whole model ----
    const D = pinned.length ? manual || sizePass(pinned) || AUTO_DIAMETERS[AUTO_DIAMETERS.length - 1] : null;

    // ---- which piece of each pair across a pegged face carries the pegs: one for all of that face's, never one
    // whose neighbour has no room for their sockets, and where both have room, rather the one across from more of it:
    // more of the pair's faces, then the larger pegs its narrowest face takes, then the longer (at the smallest size,
    // on faces too narrow for Auto to size) ----
    const pairs = new Map();
    for (const ctx of pegged) {
      for (const patch of ctx.patches) {
        if (patch.skip) continue;
        const key = `${ctx.cut.id}|${patch.lo.index}|${patch.hi.index}`;
        if (!pairs.has(key)) pairs.set(key, { pair: { axis: ctx.cut.axis, lo: patch.lo.index, hi: patch.hi.index, sockets: [false, false], prefer: null }, ctx, patches: [] });
        pairs.get(key).patches.push(patch);
      }
    }
    // the room a pair's faces have for sockets on side k: the area of those that take any, the size the narrowest takes
    // (0 where Auto sizes none), and how long that size, or the smallest, may be there
    const roomIn = (ctx, patches, k) => {
      const taking = patches.filter((patch) => patch.sockets[k]);
      const sized = taking.filter((patch) => patch.area >= SIZING_PATCH);
      const size = sized.length ? Math.min(...sized.map((patch) => patch.fit[k]?.d ?? 0)) : 0;
      return [taking.reduce((sum, patch) => sum + patch.area, 0), size, PEG.room(size || leastPeg, depth, ctx.rooms[k])?.length ?? 0];
    };
    // whether room x beats room y, in that order
    const roomier = (x, y) => {
      if (Math.abs(x[0] - y[0]) > 1e-6 * Math.max(1, y[0])) return x[0] > y[0];
      return x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2] + 1e-9;
    };
    for (const { pair, ctx, patches } of pairs.values()) {
      pair.sockets = [0, 1].map((k) => patches.some((patch) => patch.sockets[k]));
      if (!pair.sockets.every(Boolean)) continue;
      const room = [roomIn(ctx, patches, 0), roomIn(ctx, patches, 1)];
      pair.prefer = roomier(room[1], room[0]) ? 0 : roomier(room[0], room[1]) ? 1 : null;
    }
    // whether a piece still fits carrying them is judged at their length at the size of the better side of each face:
    // the size they get is no larger
    const fitOf = (patch, k) => patch.fit[k]?.d ?? null;
    const faces = pegged.flatMap((ctx) => ctx.patches.filter((patch) => !patch.skip));
    const better = faces.map((patch) => Math.max(fitOf(patch, 0) ?? 0, fitOf(patch, 1) ?? 0)).filter((x) => x > 0);
    const longest = PEG.full(pegManual || (better.length ? Math.min(...better) : AUTO_PEGS[AUTO_PEGS.length - 1]), depth).length;
    const list = [...pairs.values()].map((x) => x.pair);
    const males = pegMales
      ? pegMales(list, longest, forced)
      : list.map((pair) => (!pair.sockets[1] ? (pair.sockets[0] ? 1 : null) : !pair.sockets[0] ? 0 : pair.prefer ?? 0));
    const maleOf = new Map([...pairs.keys()].map((key, i) => [key, males[i]]));
    for (const ctx of pegged) {
      for (const patch of ctx.patches) if (!patch.skip) patch.male = maleOf.get(`${ctx.cut.id}|${patch.lo.index}|${patch.hi.index}`);
    }

    // ---- one peg size for the whole model: the smallest that a face's sockets take on the side they go into ----
    const found = faces.filter((patch) => patch.male !== null).map((patch) => fitOf(patch, 1 - patch.male)).filter((x) => x !== null);
    const P = pegged.length ? pegManual || (found.length ? Math.min(...found) : AUTO_PEGS[AUTO_PEGS.length - 1]) : null;

    // ---- at most 48 pins or pegs: every patch its first two, larger patches first, then the rest the same way ----
    const asks = connected.flatMap((ctx) => ctx.patches.filter((p) => !p.skip).map((patch) => ({ patch, n: wanted || clamp(1 + Math.round(patch.area / 1500), 2, 6) })));
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

    // ---- pins and pegs, cut by cut, each cut avoiding the holes, pegs and sockets of the ones before and the
    // dovetail sockets ----
    connected.forEach((ctx, done) => {
      progress?.(stage, { done: cuts.length + 1 + done, total: steps });
      const a = ctx.cut.axis;
      const reach = ctx.kind.reach;
      // the two halves of one hole overlap at the face, and so do a peg and its socket: each side's (or each kind's)
      // are composed (and projected) apart
      ctx.obstacles = [0, 1].map((side) => {
        const near = placed.filter((x) => x.side === side && x.box.max[a] > ctx.cut.at - reach && x.box.min[a] < ctx.cut.at + reach);
        return near.length ? keep.add(Manifold.compose(near.map((x) => x.m))) : null;
      }).filter(Boolean);
      if (sockets) ctx.obstacles.push(sockets);
      if (ctx.joint === 'pegs') {
        layoutPegs(ctx, P);
        ctx.pinnable = pinsFit(ctx);
        for (const peg of pegs.filter((x) => x.cutId === ctx.cut.id)) {
          // side 0 the sockets, side 1 the pegs (a pegged split has no pins)
          for (const [side, m] of [[0, keep.add(socketAt(peg))], [1, keep.add(pegAt(peg))]]) placed.push({ m, side, box: boxOf(m) });
        }
        return;
      }
      layoutCut(ctx, D);
      for (const dowel of dowels.filter((x) => x.cutId === ctx.cut.id)) {
        for (const side of [0, 1]) {
          const m = keep.add(dowelHole(dowel, side));
          placed.push({ m, side, box: boxOf(m) });
        }
      }
    });
    if (capped) notes.push(splitNote('DOWELS_CAPPED', { placed: dowels.length + pegs.length, dropped: capped, ...(pegged.length && !pinned.length ? { pegs: true } : {}) }));

    // ---- labels ----
    if (labelsOn) {
      progress?.('Engraving labels…');
      const skipped = [];
      for (const ctx of connected) {
        let missing = false;
        for (const patch of ctx.patches) {
          if (patch.skip || !(patch.dowels.length || patch.pegs.length)) continue;
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
      const lipsOf = new Map();
      for (const patch of ctx.patches) {
        if (patch.skip) continue;
        const key = `${patch.lo.index}|${patch.hi.index}`;
        if (!pairs.has(key)) {
          const { id: cutId, letter, axis, at } = ctx.cut;
          pairs.set(key, { cutId, letter, axis, at, pieces: [patch.lo.index, patch.hi.index], joint: ctx.joint, patches: 0, dowels: [], pegs: [], male: null, labels: null });
          lipsOf.set(key, []);
        }
        const seam = pairs.get(key);
        seam.patches++;
        seam.dowels.push(...patch.dowels);
        seam.pegs.push(...patch.pegs);
        if (patch.pegs.length) seam.male = seam.pieces[patch.male];
        if (patch.lipOn) {
          seam.male = patch.lipOn.sides[patch.lipOn.male].piece;
          lipsOf.get(key).push(patch.lipOn);
        }
        if (patch.label && !seam.labels) seam.labels = patch.label.sides.map((s) => s.text);
      }
      for (const [key, seam] of pairs) {
        const here = lipsOf.get(key);
        const empty = { dowels: !seam.dowels.length, pegs: !seam.pegs.length, lip: !here.length };
        if (empty[seam.joint]) seam.joint = 'none';
        if (ctx.cut.apart) {
          // a cut that comes apart is never glued: how it holds instead, for the glue sheet and the pieces list
          const hold = ctx.cut.apart.hold ?? 'snap';
          if (seam.joint === 'dovetail') {
            const tabCount = tabs?.seams?.find((x) => x.cutId === seam.cutId)?.tabs.length ?? 0;
            seam.apart = { hold, lip: false, clips: 0, height: 0, key: false, faces: 0, flat: 0, tabs: tabCount };
          } else {
            seam.apart = {
              hold, lip: here.length > 0, clips: here.reduce((n, l) => n + l.clips, 0), height: here.length ? Math.max(...here.map((l) => l.H)) : 0,
              key: here.some((l) => Boolean(l.key)), faces: here.length, flat: seam.patches - here.length,
            };
          }
        }
        seams.push(seam);
      }
    }
    return { diameter: D, pegSize: P, dowels, pegs, labels, lips, seams, notes, pinnable: pegged.filter((ctx) => ctx.pinnable).map((ctx) => ctx.cut.id) };
  } finally {
    keep.dispose();
  }
}

// ---------- drilling ----------

/**
 * A piece with its own built-in pegs and lip tongues added and its
 * half-holes, sockets, grooves and labels taken out: one boolean each, the
 * pegs and tongues and the cutters being disjoint by construction (pin and
 * peg spacing, label room, the other cuts keeping clear of the lips). A
 * piece with nothing to drill comes back as a copy.
 * @param {Manifold} solid the piece (borrowed)
 * @param {{ dowels: object[], pegs?: object[], lips?: object[], labels: object[] }} layout from `layoutSplit`
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
    const grown = [];
    for (const dowel of layout.dowels ?? []) {
      dowel.sides.forEach((s, k) => {
        if (s.piece === pieceIndex) cutters.push(t.add(dowelHole(dowel, k)));
      });
    }
    for (const peg of layout.pegs ?? []) {
      for (const s of peg.sides) if (s.piece === pieceIndex) (s.peg ? grown : cutters).push(t.add(s.peg ? pegAt(peg) : socketAt(peg)));
    }
    for (const lip of layout.lips ?? []) {
      for (const s of lip.sides) if (s.piece === pieceIndex) (s.male ? grown : cutters).push(t.add(s.male ? lipAt(lip) : lipCavityAt(lip)));
    }
    for (const label of layout.labels ?? []) {
      for (const s of label.sides) {
        if (s.piece !== pieceIndex) continue;
        if (!font) throw new Error('drillPiece needs the labels\' font.');
        const m = labelSolid({ text: s.text, size: label.size, font, centre: label.centre, outward: s.outward, axis: label.axis });
        if (m) cutters.push(t.add(m));
      }
    }
    const whole = grown.length ? t.add(solid.add(t.add(Manifold.compose(grown)))) : solid;
    if (!cutters.length) return whole.translate(0, 0, 0);
    const drilled = whole.subtract(t.add(Manifold.compose(cutters)));
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
