/**
 * Split for printing, the pure half: plain JavaScript on plain data, with no
 * Manifold and no three.js, so the main thread, the viewer and the worker
 * share one copy of the rules. It holds the printer's bed, how cuts are read
 * and checked, the frames the geometry is built in, where Fit to my printer
 * puts its cuts, where pins go on a face, how each piece lies on the bed,
 * the colours of the pieces, the file names and the glue sheet, and the
 * sizes of the lip a cut that comes apart gets.
 *
 * Conventions used throughout:
 *  - an axis is 0, 1 or 2 (x, y, z); a direction is one of '+x' … '-z';
 *  - a cut as the document stores it is `{ id, position, normal }`, with
 *    `joint: 'apart'` and its `hold` when it comes apart; once normalised it
 *    is `{ id, letter, axis, at }`, with `apart: { hold }` when it comes apart;
 *  - a cut that comes apart may take out only a part, the model inside a
 *    circle on one side of its plane (stored `part: { r, side, auto }`);
 *    normalised, a part is `{ id, letter, axis, at, centre, r, side, hold,
 *    auto }`, kept apart from the cuts, which make the grid;
 *  - matrices are 16 numbers, column-major, like `toMat4` and
 *    `Manifold.transform`;
 *  - a cell is `[i, j, k]`, the slot of a piece in the grid the cuts make;
 *  - piece numbers are 1-based, as in "piece 2 of 3" and the label "2A".
 */
import { TEA_LIGHT, roundAngle, roundOpening, wayWords } from './locks.js';

// ---------- printers ----------

/** Printers to choose from, with their build volume in mm (`custom` uses the size the user typed). */
export const BED_PRESETS = Object.freeze({
  generic: Object.freeze({ label: 'Generic / Ender-3 class', size: Object.freeze([220, 220, 250]) }),
  a1mini: Object.freeze({ label: 'Bambu Lab A1 mini', size: Object.freeze([180, 180, 180]) }),
  bambu256: Object.freeze({ label: 'Bambu Lab A1 / P1S / X1', size: Object.freeze([256, 256, 256]) }),
  mk4s: Object.freeze({ label: 'Prusa MK4S', size: Object.freeze([250, 210, 220]) }),
  coreone: Object.freeze({ label: 'Prusa CORE One', size: Object.freeze([250, 220, 270]) }),
  coreonel: Object.freeze({ label: 'Prusa CORE One L', size: Object.freeze([300, 300, 330]) }),
  custom: Object.freeze({ label: 'Custom', size: null }),
});

/**
 * The bed setting a new user starts with. A piece that is too big ruins a
 * print while an extra seam only costs a glue joint, so the default is a
 * common small printer. Copy the size array before changing it.
 */
export const BED_DEFAULTS = Object.freeze({ preset: 'generic', size: Object.freeze([220, 220, 250]), margin: 5 });

const clamp = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** The printer's own build volume [x, y, z] in mm, from a preset or the size typed for `custom`. */
export function bedSize(bed = BED_DEFAULTS) {
  const size = BED_PRESETS[bed?.preset]?.size ?? bed?.size;
  // a blank or nonsense box keeps the default for that side (Number('') and Number(null) are 0, not NaN)
  return [0, 1, 2].map((a) => {
    const v = Number(size?.[a]);
    return v > 0 ? Math.min(10000, v) : BED_DEFAULTS.size[a];
  });
}

/**
 * The room a piece may use [x, y, z]: the margin is kept clear on every side
 * of the bed (a brim, the purge line, clips), and 1 mm is kept below the
 * top of the build volume.
 */
export function usableBed(bed = BED_DEFAULTS) {
  const [x, y, z] = bedSize(bed);
  const m = clamp(Number(bed?.margin), 0, 20, BED_DEFAULTS.margin);
  return [Math.max(1, x - 2 * m), Math.max(1, y - 2 * m), Math.max(1, z - 1)];
}

// ---------- settings and limits ----------

/**
 * A split's settings as the document stores them (`cuts` hold `{ id, position, normal }` in model mm, and
 * `joint: 'apart'` with its `hold` on a cut that comes apart, and its `part` on one that takes out only a part). They
 * are for the glued cuts: one that comes apart has a lip, whatever `joint` says.
 */
export const SPLIT_DEFAULTS = Object.freeze({
  cuts: Object.freeze([]),
  joint: 'auto', // 'auto' | 'dowels' | 'pegs' (built-in square pegs) | 'dovetail' | 'none'
  diameter: 0, // mm: 0 = auto | 1.75 (filament) | 3 | 4 | 5 | 6 | 8 | 10; with pegs, the peg's side (1.75 is read as 3)
  depth: 0, // mm per side: 0 = auto | 3–30; with pegs, how far a peg stands out of its face
  clearance: 0.15, // mm per side (radial), on holes, peg sockets and dovetail sockets only
  count: 0, // pins per face: 0 = auto | 1–6
  pins: 'print', // 'print' (a pins file) | 'own' (holes only)
  orient: 'auto', // 'auto' | 'cut' (a cut face down) | 'model' (as modelled)
  labels: true, // engrave <piece><letter> on each pinned face
});

/** Most cuts, cells (pieces) and pins one split may have. */
export const SPLIT_LIMITS = Object.freeze({ cuts: 12, cells: 64, dowels: 48 });

/** Drilled pieces are kept in the worker only up to this many triangles in all; above it they are rebuilt for a download. */
export const SPLIT_KEEP_TRIANGLES = 1_000_000;

/** Pin diameters on offer (mm); 1.75 is filament. */
export const PIN_DIAMETERS = Object.freeze([1.75, 3, 4, 5, 6, 8, 10]);

/** The sizes the automatic sizing pass tries, largest first. */
export const AUTO_DIAMETERS = Object.freeze([8, 6, 5, 4, 3]);

export const FILAMENT = 1.75;

export const JOINTS = Object.freeze(['auto', 'dowels', 'pegs', 'dovetail', 'none']);
export const ORIENT_MODES = Object.freeze(['auto', 'cut', 'model']);

/** Cuts closer than this to the model's ends, or to each other on one axis, are treated as missing or the same cut (mm). */
export const CUT_TOLERANCE = 0.01;

/** True when the split has any cuts, i.e. the model is to be cut into pieces. */
export const splitActive = (split) => (split?.cuts?.length ?? 0) > 0;

/** A split that cannot be carried out at all; the engine reports it with its `code` (`SPLIT_INVALID`). */
export class SplitError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SplitError';
    this.code = code;
    this.details = details;
  }
}

/** The letter of the i-th cut in the list (0 → A, 25 → Z, 26 → AA), shown on its plane, its faces and the glue sheet. */
export function letterFor(i) {
  let n = Math.max(0, Math.floor(i)) + 1;
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export const AXES = Object.freeze(['x', 'y', 'z']);

/** Reads a cut as a plane along X, Y or Z; `straight` is false when its normal is not along one of them. */
function snapCut(cut) {
  if (Number.isInteger(cut?.axis) && cut.axis >= 0 && cut.axis < 3) return { straight: true, axis: cut.axis, at: Number(cut.at) };
  const n = [0, 1, 2].map((a) => Number(cut?.normal?.[a]) || 0);
  const len = Math.hypot(...n);
  if (!(len > 0)) return { straight: false };
  let axis = 0;
  for (let a = 1; a < 3; a++) if (Math.abs(n[a]) > Math.abs(n[axis])) axis = a;
  // the sign does not matter for a full plane; anything tilted is left out rather than guessed at
  if (Math.abs(n[axis]) / len < 1 - 1e-6) return { straight: false };
  return { straight: true, axis, at: Number(cut?.position?.[axis]) };
}

/**
 * The plane of a cut: `{ axis, at }`, or null when it is not straight along
 * X, Y or Z or has no position. Takes a stored cut (`{ position, normal }`)
 * or a normalised one (`{ axis, at }`).
 */
export function cutPlane(cut) {
  const s = snapCut(cut);
  return s.straight && Number.isFinite(s.at) ? { axis: s.axis, at: s.at } : null;
}

/** The nearest pin diameter on offer; 0 (or anything not positive) means automatic. */
function snapDiameter(d) {
  const v = Number(d);
  if (!(v > 0)) return 0;
  let best = PIN_DIAMETERS[0];
  for (const s of PIN_DIAMETERS) if (Math.abs(s - v) < Math.abs(best - v)) best = s;
  return best;
}

/**
 * The take-apart flag of a cut, stored (`joint: 'apart'` and `hold`) or
 * normalised (`apart: { hold }`), as `{ hold }` with a hold there is (Clicks
 * on for any other); null for a glued cut.
 */
function apartOf(cut) {
  if (cut?.joint !== 'apart' && !cut?.apart) return null;
  const hold = cut.hold ?? cut.apart?.hold;
  return { hold: APART_HOLDS.includes(hold) ? hold : 'snap' };
}

/**
 * The part a cut takes out, stored (`part` on a cut that comes apart, its
 * side read along the normal) or normalised (`centre`, `r` and `side` read
 * along the axis), as `{ r, side, auto, hold, seat? }`; null for a cut across
 * the whole model, or a circle with no size. A part twist-locks or lifts off,
 * as the document keeps it; `seat` when a base is to have a tea-light seat
 * on its top wherever one fits (a part stored without it has none).
 */
function partOf(cut) {
  const p = Array.isArray(cut?.centre) ? cut : cut?.joint === 'apart' ? cut.part : null;
  const r = Number(p?.r);
  if (!(r > 0 && Number.isFinite(r))) return null;
  return { r, side: Number(p.side) < 0 ? -1 : 1, auto: p.auto === true, hold: cut.hold === 'lift' ? 'lift' : 'lock', ...(p.seat === true ? { seat: true } : {}) };
}

/**
 * True when a part takes nothing out of the model in `bounds`: its side of
 * the plane holds less than the tolerance, the plane lies past the model's
 * end on its other side, or its circle misses the model's box. A part's
 * plane may be the model's own end, as a base taken out from below is.
 */
function partMisses({ axis, at, centre, r, side }, bounds) {
  const shift = side > 0 ? -CUT_TOLERANCE : CUT_TOLERANCE;
  if (!(at > bounds.min[axis] + shift && at < bounds.max[axis] + shift)) return true;
  // how far the circle's centre is from the box's outline across the plane, read as TO_PLANE reads it
  const off = centre.map((c, i) => {
    const a = (axis + 1 + i) % 3;
    return Math.max(bounds.min[a] - c, 0, c - bounds.max[a]);
  });
  return Math.hypot(...off) >= r - CUT_TOLERANCE;
}

/**
 * Settings clamped to their ranges, and the cuts snapped to the axes,
 * checked against the model and put in their canonical order (x, then y,
 * then z, then position). Each cut keeps the letter of its place in the
 * stored list, so letters never jump about when a cut is left out. Cuts in
 * one place are one, and it comes apart when any of them did, held as the
 * first of those in the list is. A cut that takes out only a part is no
 * plane of the grid: it is never merged with another, makes no cells and
 * comes out in `parts`, in the order listed, though it counts as one of the
 * 12 cuts. Its side and centre are read in its plane's frame (`TO_PLANE`):
 * `side` +1 when the part lies towards +axis, and `centre` the circle's (u,
 * v) there, which for a cut across Z is its (x, y).
 * @param {object|null} split the document's split (missing fields take their defaults)
 * @param {{ min: number[], max: number[] }|null} bounds the solid's bounds with the unrepaired triangles; null skips the miss test
 * @returns {{ spec: object, cuts: { id: string, letter: string, axis: number, at: number, apart?: { hold: string } }[],
 *   parts: { id: string, letter: string, axis: number, at: number, centre: number[], r: number, side: number, hold: string,
 *   auto: boolean, seat?: true }[], notes: object[], grid: number[] }} `spec` holds the clamped settings (no cuts), `grid`
 *   the number of cuts on each axis; `apart` only on a cut that comes apart; `seat` only on a part whose base is to have
 *   a tea-light seat. No cuts left means: export unsplit, with the notes.
 * @throws {SplitError} `SPLIT_INVALID` for more than 12 cuts and parts or 64 pieces
 */
export function normaliseSplit(split, bounds = null) {
  const s = split ?? {};
  const diameter = snapDiameter(s.diameter);
  const depth = Number(s.depth) > 0 ? clamp(Number(s.depth), 3, 30, 0) : 0;
  const spec = {
    joint: JOINTS.includes(s.joint) ? s.joint : SPLIT_DEFAULTS.joint,
    diameter,
    depth: Math.round(depth * 100) / 100,
    clearance: Math.round(clamp(Number(s.clearance), 0, 0.5, SPLIT_DEFAULTS.clearance) * 1000) / 1000,
    count: Math.round(clamp(Number(s.count), 0, 6, SPLIT_DEFAULTS.count)),
    // filament comes off the spool: there is nothing to print
    pins: diameter === FILAMENT || s.pins === 'own' ? 'own' : 'print',
    orient: ORIENT_MODES.includes(s.orient) ? s.orient : SPLIT_DEFAULTS.orient,
    labels: typeof s.labels === 'boolean' ? s.labels : SPLIT_DEFAULTS.labels,
  };
  const notes = [];
  const kept = [];
  const parts = [];
  (Array.isArray(s.cuts) ? s.cuts : []).forEach((cut, index) => {
    const letter = letterFor(index);
    const id = cut?.id ?? `c${index + 1}`;
    const plane = snapCut(cut);
    if (!plane.straight) {
      notes.push(splitNote('CUT_NOT_STRAIGHT', { cutId: id, letter }));
      return;
    }
    const { axis, at } = plane;
    const part = partOf(cut);
    if (part) {
      const { r, auto, hold, seat } = part;
      const normalised = Array.isArray(cut.centre);
      // a stored part's side is along its normal, which may point either way along the axis
      const side = !normalised && Number(cut.normal?.[axis]) < 0 ? -part.side : part.side;
      const centre = normalised ? [Number(cut.centre[0]), Number(cut.centre[1])] : [1, 2].map((i) => Number(cut.position?.[(axis + i) % 3]));
      const found = { id, letter, axis, at, centre, r, side, hold, auto, ...(seat ? { seat } : {}) };
      if (!Number.isFinite(at) || !centre.every(Number.isFinite) || (bounds && partMisses(found, bounds))) notes.push(splitNote('CUT_MISSES', { cutId: id, letter }));
      else parts.push(found);
      return;
    }
    const misses = !Number.isFinite(at) || (bounds && (at <= bounds.min[axis] + CUT_TOLERANCE || at >= bounds.max[axis] - CUT_TOLERANCE));
    if (misses) {
      notes.push(splitNote('CUT_MISSES', { cutId: id, letter }));
      return;
    }
    const apart = apartOf(cut);
    kept.push({ id, letter, axis, at, index, ...(apart ? { apart } : {}) });
  });
  // cuts on one axis less than the tolerance apart are one cut: the earliest in the list stays
  kept.sort((a, b) => a.axis - b.axis || a.at - b.at || a.index - b.index);
  const groups = [];
  for (const c of kept) {
    const g = groups[groups.length - 1];
    const last = g?.[g.length - 1];
    if (last && last.axis === c.axis && c.at - last.at < CUT_TOLERANCE) g.push(c);
    else groups.push([c]);
  }
  const cuts = groups.map((g) => {
    const byIndex = [...g].sort((a, b) => a.index - b.index);
    if (g.length > 1) notes.push(splitNote('CUTS_MERGED', { cutIds: byIndex.map((c) => c.id), letters: byIndex.map((c) => c.letter) }));
    const { id, letter, axis, at } = byIndex[0];
    const apart = byIndex.find((c) => c.apart)?.apart;
    return { id, letter, axis, at, ...(apart ? { apart: { ...apart } } : {}) };
  });
  cuts.sort((a, b) => a.axis - b.axis || a.at - b.at);
  const grid = [0, 1, 2].map((a) => cuts.filter((c) => c.axis === a).length);
  const cells = (grid[0] + 1) * (grid[1] + 1) * (grid[2] + 1);
  const count = cuts.length + parts.length;
  if (count > SPLIT_LIMITS.cuts || cells > SPLIT_LIMITS.cells) {
    throw new SplitError('SPLIT_INVALID', `A split can have up to ${SPLIT_LIMITS.cuts} cuts and ${SPLIT_LIMITS.cells} pieces – remove some cuts.`, { cuts: count, cells });
  }
  return { spec, cuts, parts, notes, grid };
}

/**
 * Cut positions per axis, sorted: `[[x…], [y…], [z…]]`. Takes stored or
 * normalised cuts; ones that are not straight are skipped. With `bounds`,
 * cuts that miss the box are skipped too and near-duplicates kept once.
 */
export function axisCuts(cuts = [], bounds = null) {
  const out = [[], [], []];
  for (const cut of cuts) {
    const p = cutPlane(cut);
    if (!p) continue;
    if (bounds && (p.at <= bounds.min[p.axis] + CUT_TOLERANCE || p.at >= bounds.max[p.axis] - CUT_TOLERANCE)) continue;
    out[p.axis].push(p.at);
  }
  return out.map((list) => {
    list.sort((a, b) => a - b);
    return bounds ? list.filter((t, i) => i === 0 || t - list[i - 1] >= CUT_TOLERANCE) : list;
  });
}

// ---------- frames (exact signed permutations, column-major) ----------

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** The transpose of a 4×4 matrix (the inverse of a rotation). */
export function transposeMat4(m) {
  const t = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) t[c * 4 + r] = m[r * 4 + c];
  return t;
}

/** a · b for column-major 4×4 matrices (b is applied first). */
export function mulMat4(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3] + 0;
    }
  }
  return out;
}

/** A point [x, y, z] moved by a column-major 4×4 matrix. */
export function applyMat4(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** A translation as a column-major 4×4 matrix. */
export const translationMat4 = ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/** The inverse of a rotation plus translation (no scale). */
export function invertRigid(m) {
  const out = transposeMat4([...m.slice(0, 12), 0, 0, 0, 1]);
  out[3] = out[7] = out[11] = 0;
  for (let r = 0; r < 3; r++) out[12 + r] = -(out[r] * m[12] + out[4 + r] * m[13] + out[8 + r] * m[14]) + 0;
  out[15] = 1;
  return out;
}

/**
 * World → plane coordinates (u, v, w) for a cut on each axis, w along the
 * cut's axis. Cyclic permutations, so nothing is mirrored: x → (y, z, x),
 * y → (z, x, y), z → (x, y, z).
 */
export const TO_PLANE = Object.freeze([
  Object.freeze([0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]),
  Object.freeze([0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1]),
  IDENTITY,
]);

/** Plane → world coordinates: the transpose of each `TO_PLANE`. */
export const TO_WORLD = Object.freeze(TO_PLANE.map((m) => Object.freeze(transposeMat4(m))));

/** The six directions, the model's own down (−z) first. */
export const DIRECTIONS = Object.freeze({
  '-z': Object.freeze([0, 0, -1]),
  '+z': Object.freeze([0, 0, 1]),
  '-x': Object.freeze([-1, 0, 0]),
  '+x': Object.freeze([1, 0, 0]),
  '-y': Object.freeze([0, -1, 0]),
  '+y': Object.freeze([0, 1, 0]),
});
const DIR_KEYS = Object.keys(DIRECTIONS);

/** The axis (0, 1, 2) of a direction such as '-y'. */
export const dirAxis = (dir) => AXES.indexOf(dir[1]);

/** The opposite direction: '-z' ↔ '+z'. */
export const oppositeDir = (dir) => (dir[0] === '-' ? '+' : '-') + dir[1];

/** The direction of a unit axis vector (snapped to its largest component), e.g. [0, -1, 0] → '-y'. */
export function dirOf(v) {
  let axis = 0;
  for (let a = 1; a < 3; a++) if (Math.abs(v[a]) > Math.abs(v[axis])) axis = a;
  return (v[axis] < 0 ? '-' : '+') + AXES[axis];
}

/**
 * For each direction, the rotation that turns that side of a piece to face
 * down (−z), so it lies on the bed. Each is a signed permutation with
 * determinant +1: exact, and never a mirror image.
 */
export const LAY_DOWN = Object.freeze({
  '-z': IDENTITY,
  '+z': Object.freeze([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]),
  '-x': Object.freeze([0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1]),
  '+x': Object.freeze([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]),
  '-y': Object.freeze([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]),
  '+y': Object.freeze([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]),
});

/** A quarter turn about +z (x → y). */
export const YAW90 = Object.freeze([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A turn about +z by whole degrees; exact for 0 and 90. */
export function yawMat4(deg) {
  if (!deg) return [...IDENTITY];
  if (deg === 90) return [...YAW90];
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

const axisVector = (v) => (typeof v === 'string' ? [...DIRECTIONS[v]] : [...DIRECTIONS[dirOf(v)]]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1] + 0, a[2] * b[0] - a[0] * b[2] + 0, a[0] * b[1] - a[1] * b[0] + 0];

/**
 * Local → world frame with the given local z and y axes, both along X, Y or
 * Z (a direction such as '+x', or a vector, snapped to its axis); x = y × z,
 * so the frame is a signed permutation with determinant +1. A y that is
 * missing or not square to z is replaced by +y for a z along Z, else +z.
 * Places half-holes (z into the piece, y towards the teardrop's point),
 * labels (z out of the face, y up) and dovetail cells.
 * @returns {number[]} column-major 4×4, moved to `origin`
 */
export function localFrame(z, y = null, origin = [0, 0, 0]) {
  const Z = axisVector(z);
  let Y = y == null ? null : axisVector(y);
  if (!Y || Y[0] * Z[0] + Y[1] * Z[1] + Y[2] * Z[2] !== 0) Y = Math.abs(Z[2]) === 1 ? [0, 1, 0] : [0, 0, 1];
  const X = cross(Y, Z);
  return [...X, 0, ...Y, 0, ...Z, 0, origin[0] + 0, origin[1] + 0, origin[2] + 0, 1];
}

// ---------- pin and hole sizes ----------

/** A 32-gon drawn with its flats on a circle reaches 1/cos(π/32) of the radius at its corners. */
export const HOLE_SEGMENTS = 32;
export const POLYGON_K = 1 / Math.cos(Math.PI / HOLE_SEGMENTS);

/**
 * Every size that follows from a pin diameter.
 * @param {number} D pin diameter (mm); 1.75 is filament
 * @param {number} c clearance per side (mm), on the hole only
 * @param {number} nozzle nozzle width (mm): walls are at least three lines
 * @param {number} depth hole depth per side (mm); 0 = automatic
 * @returns {{ d: number, r: number, R: number, c: number, ch: number, wall: number, depth: number, h: number,
 *   reach: number, a: number, rho: number, rhoTear: number, sMin: number, minDepth: number, pinLength: number, pinChamfer: number }}
 *   r pin radius, R hole radius, ch mouth chamfer, h bore before the cone end, reach how far the hole and its wall
 *   go into the piece, a the mouth's outer radius, rho / rhoTear the inset from a face's edge to a hole centre
 *   (round / teardrop), sMin the closest two centres may be, pinLength and pinChamfer the pin's.
 */
export function sizesFor(D, c = SPLIT_DEFAULTS.clearance, nozzle = 0.4, depth = 0) {
  const filament = Math.abs(D - FILAMENT) < 1e-9;
  const r = D / 2;
  const R = r + c;
  const ch = filament ? 0.3 : 0.5;
  const wall = Math.round(Math.max(1.2, 3 * nozzle, 0.4 * D) * 1e6) / 1e6; // rounded: 3 × 0.4 is not 1.2 in floating point
  const d = depth > 0 ? depth : filament ? 4 : Math.round(1.6 * D * 2) / 2;
  const h = d + 0.5; // the extra 0.5 mm plus the cone leave a pocket for glue at the blind end
  const reach = h + R + wall + 0.01;
  // the inset includes the chamfer and the polygon's corners, or the wall left beside a hole is too thin
  const a = (R + ch) * POLYGON_K;
  const rho = a + wall;
  const rhoTear = Math.SQRT2 * a + wall;
  // spaced so that a wall stands between two mouths even when both are teardrops, and three diameters apart
  // so that two pins stop the pieces turning
  const sMin = Math.max(2 * rhoTear - wall, 3 * D);
  return { d: D, r, R, c, ch, wall, depth: d, h, reach, a, rho, rhoTear, sMin, minDepth: Math.max(3, 0.6 * D), pinLength: 2 * d, pinChamfer: Math.min(0.4, 0.1 * D) };
}

/**
 * Sizes for a hole that must stay within `room` mm of the face (the
 * distance to the next parallel cut or the model's end): the full depth if
 * it fits, else as deep as fits, or null when that is under the minimum.
 */
export function sizesForRoom(D, c, nozzle, depth, room) {
  const s = sizesFor(D, c, nozzle, depth);
  if (s.h + s.R + s.wall <= room) return s;
  const capped = Math.floor((room - s.R - s.wall - 0.5) * 10) / 10;
  return capped >= s.minDepth ? sizesFor(D, c, nozzle, capped) : null;
}

/** The world direction of a horizontal hole's teardrop point (the piece's up), or null when its piece prints the hole upright. */
export function teardropApex(up, axis) {
  return dirAxis(up) === axis ? null : [...DIRECTIONS[up]];
}

// ---------- built-in square pegs ----------

/** The peg sizes (side, mm) the automatic sizing pass tries, largest first; a smaller one is what a narrow face falls back to. */
export const AUTO_PEGS = Object.freeze([8, 6, 5, 4]);

/** The smallest peg there is (mm): a smaller size asked for (filament) is read as this. */
export const SMALLEST_PEG = 3;

/** The peg side the Pin size setting asks for: 0 for automatic, else at least `SMALLEST_PEG`. */
export const pegSizeOf = (diameter) => (Number(diameter) > 0 ? Math.max(SMALLEST_PEG, Number(diameter)) : 0);

/**
 * Every size that follows from a built-in peg of side s. The peg is a square
 * turned 45° in the cut's plane, its corners along the plane's axes: every
 * way a piece can lie is a quarter turn, so a peg or socket printed lying
 * down is a diamond to the piece's up, two 45° faces under it and a 45° roof,
 * and needs no support. The peg is s square exactly; the clearance goes on
 * the socket, which is s + 2c square with a 45° chamfer of `ch` round its
 * mouth (squeeze-out, elephant's foot), `h` deep (the peg's length and 0.5 mm
 * for glue) and then a square pyramid with 45° faces, `tip` high, so it needs
 * no bridge printed mouth down either.
 * @param {number} s the peg's side (mm)
 * @param {number} c clearance per side (mm), on the socket only
 * @param {number} nozzle nozzle width (mm): walls are at least three lines
 * @param {number} depth how far the peg stands out of its face (mm); 0 = automatic, 1.5·s to the half millimetre
 * @returns {{ s: number, d: number, c: number, half: number, ch: number, e: number, wall: number, length: number,
 *   depth: number, h: number, tip: number, reach: number, a: number, rho: number, rhoTear: number, sMin: number,
 *   minDepth: number }} `half` the socket's side from its axis, `e` the peg's lead-in chamfer at its tip, `reach` how
 *   far the socket and its wall go into the other piece, `a` the half-diagonal of the socket's mouth, `rho` the inset
 *   from a face's edge to a peg's centre (`rhoTear` the same: a peg needs no teardrop), `sMin` the closest two centres
 *   may be; `d` and `depth` repeat `s` and `length` for what pins and pegs share
 */
export function pegSizesFor(s, c = SPLIT_DEFAULTS.clearance, nozzle = 0.4, depth = 0) {
  const half = s / 2 + c;
  const ch = 0.5;
  const e = clamp(0.08 * s, 0.4, 0.5, 0.4);
  const wall = Math.round(Math.max(1.2, 3 * nozzle, 0.4 * s) * 1e6) / 1e6;
  const length = depth > 0 ? depth : Math.round(1.5 * s * 2) / 2;
  const h = length + 0.5; // room for glue past the peg's tip
  const tip = half; // 45° faces up to the point
  const a = (half + ch) * Math.SQRT2;
  const rho = a + wall;
  // a wall between two mouths, and three sides apart, as pins are three diameters
  const sMin = Math.max(2 * a + wall, 3 * s);
  return { s, d: s, c, half, ch, e, wall, length, depth: length, h, tip, reach: h + tip + wall + 0.01, a, rho, rhoTear: rho, sMin, minDepth: Math.max(3, 0.6 * s) };
}

/**
 * Sizes for a peg whose socket must stay within `room` mm of the face (the
 * distance to the next parallel cut or the model's end): the full length if
 * it fits, else as long as fits, or null when that is under the minimum.
 */
export function pegSizesForRoom(s, c, nozzle, depth, room) {
  const p = pegSizesFor(s, c, nozzle, depth);
  if (p.h + p.tip + p.wall <= room) return p;
  const capped = Math.floor((room - p.tip - p.wall - 0.5) * 10) / 10;
  return capped >= p.minDepth ? pegSizesFor(s, c, nozzle, capped) : null;
}

/**
 * How far a piece may reach past a cut with built-in pegs, for planning
 * before the pegs are laid out: the longest peg the cut's faces can take.
 * That is the peg's length at the size set, or at the largest automatic
 * size; with `face`, the extents of the box the cut's faces lie in, no
 * larger than a face that narrow takes – Auto never picks a peg wider than a
 * third of a face (`layoutSplit`'s sizing pass), and a size set falls back to
 * the smaller ones where its socket and wall are wider than the face – so a
 * 20 mm bar is planned with the 9 mm pegs it gets, not 12 mm ones. Only one
 * piece of the two either side carries them (`pegSides`).
 * @param {{ diameter?: number, depth?: number }} spec the split's settings
 * @param {number[]|null} face the extents of the cut's faces along the plane's two axes (mm), or null for any
 * @returns {number} mm
 */
export function pegAllowance(spec = {}, face = null) {
  const depth = Number(spec?.depth) > 0 ? Number(spec.depth) : 0;
  const asked = pegSizeOf(spec?.diameter);
  let s = asked || AUTO_PEGS[0];
  if (face) {
    const narrow = Math.min(...face);
    const sizes = asked ? [asked, ...AUTO_PEGS.filter((x) => x < asked)] : AUTO_PEGS;
    // no clearance and the thinnest wall: never a smaller peg than a face could take
    const takes = (x) => (asked ? 2 * pegSizesFor(x, 0, 0.4).rho : 3 * x) <= narrow + 1e-9;
    s = sizes.find(takes) ?? sizes[sizes.length - 1];
  }
  return pegSizesFor(s, 0, 0.4, depth).length;
}

// ---------- cuts that come apart ----------

/**
 * How a cut that comes apart holds (the document's `CUT_HOLDS`), firmest
 * first: its top locks on (`lock`), clicks on (`snap`), clicks on lightly
 * (`light`), or just lifts off (`lift`).
 */
export const APART_HOLDS = Object.freeze(['lock', 'snap', 'light', 'lift']);

/**
 * The lip of a cut that comes apart (mm): a tongue standing out of one piece
 * round the inside edge of its wall, and a groove for it in the other. Its
 * sizes are for a 0.4 mm nozzle; `lipSizesFor` widens them for a wider one.
 */
export const LIP = Object.freeze({
  t: 1.6, // the tongue's thickness: four lines
  tMin: 1.2, // the thinnest tongue kept: three lines
  skirt: 1.6, // a solid face's skirt: how far the groove round its core keeps from the outside
  wall: 1.2, // the thinnest wall the groove's piece keeps beside and over the groove: three lines
  g0: 0.1, // the tongue's inside face this far back from the opening's edge
  into: 0.5, // the groove reaches this far into an opening's air
  step: 0.2, // the groove's roof, its mouth and the tongue's lead-in step 0.2 in for 0.2 up: 45°
  lead: 0.6, // the tongue's top edge taken off this much
  mouth: 0.4, // the groove's mouth widened this much at the face (squeeze-out, elephant's foot)
  heights: Object.freeze([6, 4.5, 3]), // the lip's heights, tried in turn where the other piece has less room
  opening: 0.25, // a hole in a face is an opening when its outline is at least this share of the face's
  minPiece: 25, // mm²: smaller pieces of tongue are dropped
  root: 0.5, // how far the tongue's foot is sunk into its own piece
  faceTolerance: 0.02, // a face's outline is simplified this far before its lip is planned
  eps: 0.001, // the lip's own outlines are simplified this far
});

/**
 * The spring clips of a lip that clicks on (mm, degrees): each a stretch of
 * the tongue `span` long over a slot `slot` high, so a bridge held at both
 * ends, with a catch on its outside that clicks into a recess in the other
 * piece. `lock`, `snap` and `light` give each hold's catch: `P` how far it
 * stands out of the clip, at least `floor` more than the clearance. A lock's
 * catch stands out as far as Clicks on's, so its lip takes the same room,
 * but it holds far harder: its slot is a shorter bridge (`bridge`), so the
 * clip is stiffer, its catch is longer (`length`), and its flank that holds
 * is steeper (`retention`, from the way the top is pulled off) while the one
 * the top is pressed on over is shallower (`lead`) – it goes on with a click
 * and takes a firm pull to come off. The steep flank looks down as it prints,
 * so it stays steep only while the catch stands out at most `overhang`, a
 * line's width the printer draws out over the air; further out the catch is
 * a plain one, 45° both ways, as the shallow flank would then reach up past
 * the band into the tongue's lead-in.
 */
export const CLIP = Object.freeze({
  span: 40, // a clip's length along the tongue
  margin: 3, // kept clear of a clip at each end of its run
  turn: 20, // the most a run may turn under a clip and its margins
  corner: 15, // a run ends where the outline turns more than this ...
  cornerReach: 1.5, // ... within this distance
  length: 6, // the catch's length along the clip
  flat: 0.4, // the catch's flat tip
  sink: 0.2, // the catch's foot sunk into the clip
  every: 95, // one clip per this much of the tongue's outside
  most: 8, // clips on one face at most
  key: 6, // the gap in the tongue that lets the top on one way round only
  slot: 3, // the slot under a clip, from the face up
  snap: Object.freeze({ P: 0.4, floor: 0.1 }),
  light: Object.freeze({ P: 0.25, floor: 0.05 }),
  lock: Object.freeze({ P: 0.4, floor: 0.1, bridge: 30, length: 8, retention: 60, lead: 30, overhang: 0.5 }),
});

/** How far a cut's tongue stands out of its piece (mm), as the planner, the measure and the pieces' sizes count it. */
export const LIP_ALLOWANCE = 6;

/** How a cut that comes apart reaches past it for the planner: a tongue's height on the one piece that carries it. */
const APART_GROW = Object.freeze({ below: LIP_ALLOWANCE, above: LIP_ALLOWANCE, peg: true });

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * How far a clip's catch stands out of it (`p`) and how far it reaches past
 * the clearance into the other piece (`i`, the interference) for a hold and
 * a clearance c: `p` is fixed while the clearance is small, so a clearance
 * tuned to the printer leaves the catch reaching i past the gap it prints,
 * whatever the printer. Null for a hold with no catch (Lifts off).
 * @returns {{ p: number, i: number }|null}
 */
export function catchSizes(hold, c = SPLIT_DEFAULTS.clearance) {
  const h = hold === 'lock' || hold === 'snap' || hold === 'light' ? CLIP[hold] : null;
  if (!h) return null;
  const p = round6(Math.max(h.P, c + h.floor));
  return { p, i: round6(p - c) };
}

/**
 * A hold's clip at a clearance c on a tongue t thick (`lipSizesFor`), whole:
 * the catch (`p`, `i`, as `catchSizes`), the clip's thickness (`t`), the
 * bridge's length (`span`), the catch's length along it and its flanks'
 * angles from the way the top is pulled off (degrees: 45 a plain ramp, 90 a
 * square shoulder that never lets go) – `retention` the flank that holds the
 * top on, `lead` the one it is pressed on over. A clip is stiffer as the cube
 * of its thickness, so where a wider nozzle thickens the tongue its clips are
 * thinned from the inside to the 1.6 mm the clips are sized for – a 0.8 mm
 * nozzle's two lines – and only past that are they two lines thick, a lock's
 * bridge then as much longer as its clip is thicker, up to Clicks on's: a
 * lock holds alike on any nozzle up to 1 mm, the others up to 0.8 mm. Null
 * for a hold with no catch (Lifts off).
 * @returns {{ p: number, i: number, t: number, span: number, length: number, retention: number, lead: number }|null}
 */
export function clipShape(hold, c = SPLIT_DEFAULTS.clearance, t = LIP.t) {
  const sizes = catchSizes(hold, c);
  if (!sizes) return null;
  const band = round6(Math.min(t, Math.max(LIP.t, t / 2)));
  if (hold !== 'lock') return { ...sizes, t: band, span: CLIP.span, length: CLIP.length, retention: 45, lead: 45 };
  const h = CLIP.lock;
  const steep = sizes.p <= h.overhang + 1e-9;
  const span = round6(Math.min(CLIP.span, (h.bridge * band) / LIP.t));
  return { ...sizes, t: band, span, length: h.length, retention: steep ? h.retention : 45, lead: steep ? h.lead : 45 };
}

/** The gap inside the tongue where the other piece holds material there: c, or i + 0.15 where clips must bow in. */
const gapIn = (c, i) => (i > 0 ? Math.max(c, round6(i + 0.15)) : c);

/**
 * Every size of a lip that follows from the clearance, the nozzle and the
 * hold: the tongue (`t`, at least four lines; `tMin` the thinnest kept), the
 * wall kept round the groove (three lines), the skin kept outside a catch's
 * recess (two lines), how far the groove reaches from the opening's edge
 * (`d0`), the catch (`p`, `i`: 0 for Lifts off) and the gap inside the tongue
 * where the other piece has material there (`gIn`).
 * @returns {{ c: number, hold: string, t: number, tMin: number, wall: number, skin: number, g0: number, d0: number,
 *   p: number, i: number, gIn: number }}
 */
export function lipSizesFor(c = SPLIT_DEFAULTS.clearance, nozzle = 0.4, hold = 'snap') {
  const t = round6(Math.max(LIP.t, 4 * nozzle));
  const wall = round6(Math.max(LIP.wall, 3 * nozzle));
  const sizes = catchSizes(hold, c);
  const i = sizes?.i ?? 0;
  return {
    c, hold, t, tMin: round6(Math.max(LIP.tMin, 3 * nozzle)), wall, skin: round6(2 * nozzle), g0: LIP.g0,
    d0: round6(LIP.g0 + t + c), p: sizes?.p ?? 0, i, gIn: gapIn(c, i),
  };
}

/**
 * How far a lip H mm tall reaches into the piece with its groove: the
 * groove's top over the face (`zTop`) and, a wall over that, `reach`. A
 * hollow face's groove (`kind` 'opening') has a 45° roof that steps in from
 * the outside past the opening's edge – past the inside gap too where
 * something over the opening moves the tongue out (`over`); a solid face's
 * groove round its core (`kind` 'channel') has a flat one.
 * @param {number} H the lip's height
 * @param {'opening'|'channel'} kind
 * @param {number} c clearance per side
 * @param {number} i the catch's interference (`catchSizes`), 0 with no clips
 * @param {boolean} over whether the other piece has material over the opening just past the cut
 * @returns {{ zTop: number, reach: number }} at c = 0.15: 9.35 for a 6 mm lip, 7.85 for 4.5 mm, 6.35 for 3 mm
 */
export function lipReach(H, kind = 'opening', c = SPLIT_DEFAULTS.clearance, i = 0, over = false, nozzle = 0.4) {
  const { d0, wall } = lipSizesFor(c, nozzle, 'lift');
  const past = over ? gapIn(c, i) - LIP.g0 : 0;
  const zTop = kind === 'channel' ? H + c : H + c + Math.ceil((d0 + past) / LIP.step - 1e-9) * LIP.step;
  return { zTop: round6(zTop), reach: round6(zTop + wall) };
}

/** A clip's section as built (mm⁴, bending towards the inside, lead-in counted), 1.6 mm thick. */
const CLIP_SECTION = 0.937;

/**
 * The force (N) to push a lip's clips past their catches' flank at `angle`
 * from the way the top moves: each clip a bridge `span` long held at both
 * ends, k = 192·E·I / L³, bowed in by the interference i over a slope with
 * friction μ, k·i·(tan α + μ)/(1 − μ·tan α) – (1 + μ)/(1 − μ) at 45°. By
 * default with a weak print's stiffness (PLA at 2.5 GPa, μ 0.2;
 * `conservative: false` takes 3.5 GPa and 0.3). A thicker clip (`t`, the
 * clip's own: `clipShape`) is stiffer as its cube.
 */
function clipForce(clips, { t = LIP.t, i = 0, conservative = true, span = CLIP.span }, angle) {
  const n = Array.isArray(clips) ? clips.length : Number(clips) || 0;
  if (!(n > 0) || !(i > 0)) return 0;
  const [E, mu] = conservative ? [2500, 0.2] : [3500, 0.3];
  const k = (192 * E * CLIP_SECTION * (t / LIP.t) ** 3) / span ** 3;
  // a 45° ramp exactly as it always was: tan 45° in floating point is a hair under 1
  const slope = angle === 45 ? 1 : Math.tan((angle * Math.PI) / 180);
  return (n * k * i * (slope + mu)) / (1 - mu * slope);
}

/**
 * About how hard a lip's clips hold (N): what it takes to pull the top off
 * over the catches' retention flank (`clipForce`). Worked out, not measured
 * – the fit test is the real check. Pass a hold's `clipShape` for its clip's
 * thickness, bridge and flank; without one it is Clicks on's 1.6 mm clip, its
 * 40 mm bridge and 45° ramp.
 * @param {number|object[]} clips how many (or the clips)
 * @param {{ t?: number, i?: number, conservative?: boolean, span?: number, retention?: number }} options `i` the
 *   interference (`catchSizes`)
 * @returns {number} about 10.5 N for four Clicks on clips at the default clearance, 49 N for four that lock
 */
export function clipHold(clips, { retention = 45, ...options } = {}) {
  return clipForce(clips, options, retention);
}

/**
 * About how hard the top must be pressed on (N): the clips pushed past the
 * catches' lead-in flank (`clipForce`), as `clipHold` pulls them off over the
 * other. A lock's shallow lead-in takes under a third of its pull-off.
 * @param {number|object[]} clips how many (or the clips)
 * @param {{ t?: number, i?: number, conservative?: boolean, span?: number, lead?: number }} options
 * @returns {number}
 */
export function clipPush(clips, { lead = 45, ...options } = {}) {
  return clipForce(clips, options, lead);
}

// ---------- fitting the bed ----------

const EPS = 1e-9;
const RAD = Math.PI / 180;

/**
 * The smallest turn (whole degrees) that fits an a × b footprint inside the
 * bed's [x, y]: straight (0), a quarter turn (90), then 1…89 across the
 * diagonal. Null when none fits.
 */
export function footprintYaw(a, b, U) {
  const ux = U[0] + EPS;
  const uy = U[1] + EPS;
  if (a <= ux && b <= uy) return 0;
  if (b <= ux && a <= uy) return 90;
  // turning cannot help a footprint wider, in every direction, than the bed is narrow
  if (Math.min(a, b) > Math.min(ux, uy)) return null;
  for (let deg = 1; deg < 90; deg++) {
    const c = Math.cos(deg * RAD);
    const s = Math.sin(deg * RAD);
    if (a * c + b * s <= ux && a * s + b * c <= uy) return deg;
  }
  return null;
}

/**
 * Whether a box of `dims` fits the usable bed U lying any way down, turned
 * if need be. Of the ways that fit it picks the lowest, then the least turn
 * (straight, a quarter turn, then the smallest diagonal angle), then the
 * model's own down. The turn is measured from the box as it lies after
 * `LAY_DOWN[down]`, so for −z it is the turn from the model as loaded.
 * @param {number[]} dims
 * @param {number[]} U
 * @param {{ flat?: number|number[]|null }} options `flat`: the axis the box must lie flat on (a thin plate, or a
 *   piece on a dovetail seam, never stands on its edge), or the axes it may lie on; null lets it lie any way
 * @returns {{ fits: boolean, down: string|null, height: number|null, yaw: number|null, footprint: number[]|null }}
 *   `footprint` the box's sides along the bed's x and y before the turn
 */
export function fitsBed(dims, U, { flat = null } = {}) {
  let best = null;
  const ways = flat == null ? [0, 1, 2] : [].concat(flat);
  for (const down of ['-z', '-y', '-x'].filter((d) => ways.includes(dirAxis(d)))) {
    const [a, b, h] = laidDims(dims, down);
    if (h > U[2] + EPS) continue;
    const yaw = footprintYaw(a, b, U);
    if (yaw === null) continue;
    const rank = yaw === 0 ? 0 : yaw === 90 ? 1 : 1 + yaw;
    if (!best || h < best.height - EPS || (Math.abs(h - best.height) <= EPS && rank < best.rank)) best = { down, height: h, yaw, rank, footprint: [a, b] };
  }
  if (!best) return { fits: false, down: null, height: null, yaw: null, footprint: null };
  const { down, height, yaw, footprint } = best;
  return { fits: true, down, height, yaw, footprint };
}

/**
 * The cell of a grid with `k` cuts on each axis when the pieces share the
 * model out evenly: a cut on an axis whose pieces reach `grow` mm past it
 * (dovetail tabs) makes both its neighbours that much longer, so k cuts add
 * 2·k·grow to the length the k + 1 pieces share.
 */
export const evenCell = (E, k, grow = [0, 0, 0]) => E.map((e, a) => (e + 2 * k[a] * (grow[a] || 0)) / (k[a] + 1));

/**
 * Every grid of cuts per axis (as many as the limits allow: 64 cells and 12
 * cuts, so up to 12 on one axis) whose even cells fit the bed, fewest
 * pieces first, then fewest axes, then fewest Z cuts (a tall stack is the
 * least welcome). A thin plate is never cut through its thickness: it lies
 * flat, so that only makes layers to glue.
 * @param {number[]} E the model's extents [x, y, z]
 * @param {number[]} U the usable bed
 * @param {{ flat?: number|null, grow?: number[], minCounts?: number[]|null }} options `flat` as for `fitsBed` (every
 *   piece lies flat on that axis); `grow` how far the pieces reach past each cut on each axis (dovetail tabs, see
 *   `evenCell`); `minCounts` the fewest cuts each axis may have (the cuts that come apart, which stay)
 * @returns {{ k: number[], pieces: number }[]}
 */
export function gridCandidates(E, U, { flat = null, grow = [0, 0, 0], minCounts = null } = {}) {
  const found = [];
  const most = [0, 1, 2].map((a) => (a === flat ? 0 : SPLIT_LIMITS.cuts));
  for (let kx = 0; kx <= most[0]; kx++) {
    for (let ky = 0; ky <= most[1]; ky++) {
      for (let kz = 0; kz <= most[2]; kz++) {
        const pieces = (kx + 1) * (ky + 1) * (kz + 1);
        if (pieces > SPLIT_LIMITS.cells || kx + ky + kz > SPLIT_LIMITS.cuts) break; // more Z cuts only make more
        const k = [kx, ky, kz];
        if (minCounts && k.some((v, a) => v < (minCounts[a] || 0))) continue;
        if (fitsBed(evenCell(E, k, grow), U, { flat }).fits) found.push({ k, pieces });
      }
    }
  }
  const axesUsed = (k) => k.filter((v) => v > 0).length;
  return found.sort((p, q) => p.pieces - q.pieces || axesUsed(p.k) - axesUsed(q.k) || p.k[2] - q.k[2]);
}

/**
 * The fewest pieces that fit the bed: every grid of cuts per axis whose
 * even cells fit, keeping all with the smallest piece count, in the order
 * of `gridCandidates`.
 * @param {number[]} E the model's extents [x, y, z]
 * @param {number[]} U the usable bed
 * @param {{ flat?: number|null, grow?: number[] }} options as for `gridCandidates` (`planAllowance` gives them)
 * @returns {{ pieces: number, candidates: number[][] }} `pieces` 1 (candidate [0, 0, 0]) when no split is needed, 0 when nothing fits
 */
export function gridCounts(E, U, options = {}) {
  const all = gridCandidates(E, U, options);
  if (!all.length) return { pieces: 0, candidates: [] };
  return { pieces: all[0].pieces, candidates: all.filter((c) => c.pieces === all[0].pieces).map((c) => c.k) };
}

/**
 * The longest a cell may be along `axis` and still fit the bed, the other
 * sides staying as given (bisection on `fitsBed`); 0 when the cell as
 * given does not fit. `options` as for `fitsBed`.
 */
export function maxCellLength(cell, axis, U, options = {}) {
  const fits = (len) => fitsBed(cell.map((v, a) => (a === axis ? len : v)), U, options).fits;
  let lo = cell[axis];
  if (!fits(lo)) return 0;
  let hi = Math.hypot(...U) + 1; // nothing longer than the bed's diagonal fits
  for (let i = 0; i < 48 && hi - lo > 1e-9; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// ---------- thin plates ----------

/**
 * How thick a plate may be for dovetail tabs through it (mm); thinner than `min` is glued, thicker takes pins. A slab
 * up to `slab` thick (a plaque) is planned lying flat too, when some grid of flat pieces fits.
 */
export const PLATE_THICKNESS = Object.freeze({ min: 2, max: 10, slab: 25 });

/**
 * The dovetail tabs along a cut through a plate island L mm long (along the
 * cut): neck N = clamp(0.12·L, 6, 12), head H = 1.4·N, each tab reaching
 * E = N past the cut, clamp(⌊L / (2.5·H)⌋, 1, 8) of them spread over
 * `span`, what is left once half a head and 3 mm are kept clear at each
 * end. Null when the island is too short for a tab. Shared by the tabs
 * themselves and by everything that has to know how far they reach.
 * @returns {{ N: number, H: number, E: number, count: number, span: number }|null}
 */
export function dovetailSize(L) {
  const N = clamp(0.12 * L, 6, 12, 6);
  const H = 1.4 * N;
  const span = L - H - 6;
  if (!(span >= 0)) return null;
  return { N, H, E: N, count: clamp(Math.floor(L / (2.5 * H)), 1, 8, 1), span };
}

/**
 * The axis a box of these sides is a thin plate across – at most 10 mm
 * thick (`thickest`) and at least four times as wide both ways – or null. A
 * thin plate prints lying flat: stood on its edge it is a wobbly wall, and
 * the letters of a sign would stand upright.
 */
export function plateAxis(dims, thickest = PLATE_THICKNESS.max) {
  let a = 0;
  for (let b = 1; b < 3; b++) if (dims[b] < dims[a]) a = b;
  const width = Math.min(...dims.filter((_, b) => b !== a));
  return dims[a] > 0 && dims[a] <= thickest && width >= 4 * dims[a] ? a : null;
}

/**
 * The axis a box of these sides is a slab across – too thick for a thin
 * plate but at most 25 mm, and at least four times as wide both ways, as a
 * 15 mm plaque is – or null. Its pieces lie flat where they fit that way,
 * for the same reasons as a plate's, but may stand on an edge when not.
 */
export const slabAxis = (dims) => (plateAxis(dims) === null ? plateAxis(dims, PLATE_THICKNESS.slab) : null);

/**
 * The axis a model stands on a base plate across – a terrain tile's, a
 * diorama's, a figure's – or null: a plate of `orientationStats`' `plates`,
 * at most a slab thick, at one end of the model along that axis, as wide as
 * the model both ways (to 90 %), and with what stands on it topped by flat
 * faces of under half its area – a tower or a figure, not another plate
 * over it (the second leg of a U, a bookcase's shelves). Its pieces are
 * planned lying flat on it first, as a slab's are: stood on a cut edge, a
 * piece would be a wall of the plate with a tower or a figure's foot beside it.
 * @param {object} stats `orientationStats` (or `modelPlates`) of the whole model
 */
export function baseAxis(stats) {
  let best = null;
  (stats.plates ?? []).forEach((plate, w) => {
    if (!plate) return;
    const [u, v] = [(w + 1) % 3, (w + 2) % 3];
    const wide = plate.box[2] - plate.box[0] >= 0.9 * stats.dims[u] && plate.box[3] - plate.box[1] >= 0.9 * stats.dims[v];
    const under = plate.lo <= stats.bbox.min[w] + 0.01 && plate.above < 0.5 * plate.area;
    const over = plate.hi >= stats.bbox.max[w] - 0.01 && plate.below < 0.5 * plate.area;
    if (wide && (under || over) && (!best || plate.area > best.area)) best = { w, area: plate.area };
  });
  return best?.w ?? null;
}

/**
 * What the pieces of a model with extents E will be allowed, for counting
 * them before anything has been sliced (the "Split into N pieces" note): a
 * thin plate lies flat, and when its joints may be dovetails (Auto, Built-in
 * pegs or Dovetails, 2–10 mm thick, no unrepaired triangles) every cut
 * across it makes the pieces either side a tab's length longer. With
 * built-in pegs every other cut makes one of them a peg's length longer
 * (`pegAllowance`, for faces as wide as the model across that axis): counted
 * as half a peg either side, as `evenCell` shares a reach out, k cuts' pegs
 * are shared among the k + 1 pieces, as the planner shares them by moving
 * each cut towards the piece that carries its pegs; a thin plate has no room
 * for pegs. The engine's own plan looks at each cut face instead.
 * @param {number[]} E the model's extents
 * @param {{ joint?: string, diameter?: number, depth?: number }} spec the split's settings
 * @param {{ passthrough?: boolean }} options whether the model has unrepaired triangles (they rule dovetails out)
 * @returns {{ flat: number|null, grow: number[] }} the options of `gridCounts`
 */
export function planAllowance(E, spec = {}, { passthrough = false } = {}) {
  const flat = plateAxis(E);
  const grow = [0, 0, 0];
  const joint = spec?.joint ?? SPLIT_DEFAULTS.joint;
  if (flat !== null && !passthrough && (joint === 'auto' || joint === 'dovetail' || joint === 'pegs') && E[flat] >= PLATE_THICKNESS.min) {
    for (let a = 0; a < 3; a++) if (a !== flat) grow[a] = dovetailSize(E[3 - a - flat])?.E ?? 0;
  } else if (joint === 'pegs' && flat === null) {
    for (let a = 0; a < 3; a++) grow[a] = pegAllowance(spec, [E[(a + 1) % 3], E[(a + 2) % 3]]) / 2;
  }
  return { flat, grow };
}

/**
 * What Fit to my printer will make of a model whose box is E, from the box
 * alone (for the "Split into N pieces" note and the offer when a model is
 * loaded): the same plate rule, tab allowance and grids as the plan, and a
 * slab (`slabAxis`) counted lying flat when that can be done. The plan
 * itself may end with fewer pieces where some boxes hold nothing (an L
 * shape), or more where a piece would have nothing flat to stand on.
 * @param {number[]} E the model's extents
 * @param {number[]} U the usable bed
 * @param {{ joint?: string }} spec the split's settings
 * @param {{ passthrough?: boolean }} options whether the model has unrepaired triangles
 * @returns {{ fits: boolean, pieces: number, down: string|null, yaw: number|null }} `fits` when it fits as it is
 *   (`pieces` 1, `down` and `yaw` how it must lie); else `pieces` as the plan counts them, 0 when 64 would not do
 */
export function fitPieces(E, U, spec = {}, { passthrough = false } = {}) {
  const allowance = planAllowance(E, spec, { passthrough });
  const whole = fitsBed(E, U, { flat: allowance.flat });
  if (whole.fits) return { fits: true, pieces: 1, down: whole.down, yaw: whole.yaw };
  const slab = slabAxis(E);
  const lying = slab === null ? 0 : gridCounts(E, U, { flat: slab, grow: allowance.grow }).pieces;
  return { fits: false, pieces: lying || gridCounts(E, U, allowance).pieces, down: null, yaw: null };
}

// ---------- planning where the cuts go ----------

/** Weights of the planner's cost terms (see `planCost`). */
export const PLAN_WEIGHTS = Object.freeze({
  letters: 100, // a cut through letter strokes leaves slivers that print and glue badly
  nearLetters: 30, // room for the chamfer and squeeze-out next to letters
  itemBox: 8, // a word gap is fine; outside the text is better
  ledge: 4, // a ledge or fine detail close by makes a sliver or a weak seam
  neck: 6, // a narrow neck makes a weak joint
  islands: 2, // each island that takes pins needs its own: one with no room for them is glued either way
  noRoom: 5, // prefer faces that take pins
  perimeter: 1, // seam length: the glue line and how much it shows
  // per area of the model's broadest side that its pieces need support under, lying the best way they can: a piece
  // that must lie with a leg held over the bed as a roof costs more than a seam in the wrong place (see `planGrid`)
  support: 10,
  // per even piece's length a cut moves from its even position: uneven pieces must buy something real. Above the
  // perimeter's pull on purpose: on a round shell every slice has the same area and only the ring shrinks towards
  // the ends, so a weaker pull sends every cut to the end of its room, a sliver beside a piece too big to fit
  even: 2,
  // per piece, or loose part of one, the cuts make (see `planGrid`): each is one more joint to glue, as an island is
  parts: 2,
  // per piece, or loose part of one, thinner along the cut axis than a quarter of an even piece (or than an end
  // piece may be): it prints and glues as badly as a slice of letters. A cut just inside a table's apron leaves the
  // boxes between its legs a sliver of it each, one through its stretcher a strip held loose over the rest, and one
  // moved to the very end of a gear plate to empty two corner boxes a strip of its rim
  sliver: 100,
});

/**
 * Where to sample one axis for `k` cuts across [lo, hi]: interior positions
 * on a grid of at most about 200 steps, anchored so that the even positions
 * lo + (hi − lo)·j/(k + 1) are samples exactly.
 */
export function planSamples(lo, hi, k) {
  const E = hi - lo;
  const cell = E / (k + 1);
  const m = Math.max(1, Math.ceil(cell / Math.max(1, E / 200) - 1e-9));
  const N = (k + 1) * m;
  const t = [];
  for (let i = 1; i < N; i++) t.push(lo + (E * i) / N);
  return t;
}

function median(values) {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Less of a slice than this (mm²) in a column is no model there, for counting the pieces a grid's boxes make. */
const MIN_HELD = 1;

/** A ring of an outline clipped to the rectangle [u0, v0, u1, v1] (Sutherland–Hodgman): its corners, none when it misses. */
export function clipRing(ring, [u0, v0, u1, v1]) {
  let lo0 = Infinity;
  let lo1 = Infinity;
  let hi0 = -Infinity;
  let hi1 = -Infinity;
  for (const [x, y] of ring) {
    lo0 = Math.min(lo0, x);
    hi0 = Math.max(hi0, x);
    lo1 = Math.min(lo1, y);
    hi1 = Math.max(hi1, y);
  }
  if (hi0 <= u0 || lo0 >= u1 || hi1 <= v0 || lo1 >= v1) return [];
  let pts = ring;
  for (const [k, bound, keepAbove] of [[0, u0, true], [0, u1, false], [1, v0, true], [1, v1, false]]) {
    const inside = (p) => (keepAbove ? p[k] >= bound : p[k] <= bound);
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      if (inside(p)) out.push(p);
      if (inside(p) !== inside(q)) {
        const f = (bound - p[k]) / (q[k] - p[k]);
        out.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]);
      }
    }
    pts = out;
    if (!pts.length) break;
  }
  return pts;
}

/** The signed area of a ring (counter-clockwise positive). */
function ringArea(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    sum += (x0 * y1 - x1 * y0) / 2;
  }
  return sum;
}

/**
 * The signed area of outlines (outer rings counter-clockwise, holes clockwise, as `CrossSection.toPolygons()` gives
 * them) within the rectangle [u0, v0, u1, v1]: each ring clipped to it, so a ring's hole leaves a column inside it
 * empty.
 */
export function clippedArea(rings, rect) {
  return rings.reduce((sum, ring) => sum + ringArea(clipRing(ring, rect)), 0);
}

/**
 * Where an outline on a cut (in the cut axis's plane coordinates, `TO_PLANE`) lies in the columns the other cuts
 * make: for each column it reaches with more than `least` mm², the cells either side of the cut and the box the
 * outline spans there, in the world. The cut is the `index`-th on its axis.
 * @param {number[][][]} rings the outline (`CrossSection.toPolygons()`)
 * @param {{ axis: number, at: number }} cut
 * @param {number} index
 * @param {number[][]} cutsByAxis sorted positions per axis (`axisCuts`)
 * @returns {{ cells: number[][], min: number[], max: number[] }[]}
 */
export function outlineColumns(rings, { axis, at }, index, cutsByAxis, least = 0.01) {
  const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
  const eu = [-Infinity, ...(cutsByAxis[u] ?? []), Infinity];
  const ev = [-Infinity, ...(cutsByAxis[v] ?? []), Infinity];
  const out = [];
  for (let i = 0; i + 1 < eu.length; i++) {
    for (let j = 0; j + 1 < ev.length; j++) {
      const clipped = rings.map((ring) => clipRing(ring, [eu[i], ev[j], eu[i + 1], ev[j + 1]]));
      if (!(clipped.reduce((sum, pts) => sum + ringArea(pts), 0) > least)) continue;
      const min = [0, 0, 0];
      const max = [0, 0, 0];
      min[axis] = max[axis] = at;
      min[u] = min[v] = Infinity;
      max[u] = max[v] = -Infinity;
      for (const [x, y] of clipped.flat()) {
        min[u] = Math.min(min[u], x);
        max[u] = Math.max(max[u], x);
        min[v] = Math.min(min[v], y);
        max[v] = Math.max(max[v], y);
      }
      const cell = (k) => [0, 1, 2].map((a) => (a === axis ? k : a === u ? i : j));
      out.push({ cells: [cell(index), cell(index + 1)], min, max });
    }
  }
  return out;
}

/** Linear interpolation of the profile's area at t, held at the end values beyond the samples. */
function areaAt(profile, t) {
  const n = profile.length;
  if (t <= profile[0].t) return profile[0].area || 0;
  if (t >= profile[n - 1].t) return profile[n - 1].area || 0;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (profile[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = profile[lo];
  const b = profile[hi];
  const f = (t - a.t) / (b.t - a.t || 1);
  return (a.area || 0) + ((b.area || 0) - (a.area || 0)) * f;
}

/**
 * The cost of cutting at each sample of one axis's profile (lower is better).
 * @param {{ t: number, area: number, perimeter: number, islands: number, roomy?: number, noRoom: number, letters: boolean,
 *   nearLetters?: boolean }[]} profile sorted by t: the slice's area and perimeter, its islands and how many of them
 *   have room for two pins (all of them when not given), the share of its area (0–1) in islands with no room for two
 *   pins, whether any letter's solid is cut there, and whether one is within 2 mm (looked at apart from the samples;
 *   when it is not given, the samples within 2 mm tell)
 * @param {{ items?: number[][] }} options `items`: the text items' extents [lo, hi] along this axis
 * @returns {number[]} a cost per sample; a sample with no material costs only the item-box term
 */
export function planCost(profile, { items = [] } = {}) {
  const W = PLAN_WEIGHTS;
  const solid = profile.filter((p) => p.area > 0);
  const medianA = median(solid.map((p) => p.area));
  const medianP = median(solid.map((p) => p.perimeter || 0));
  const letterTs = profile.filter((p) => p.letters).map((p) => p.t);
  return profile.map((p) => {
    const t = p.t;
    let cost = items.some(([lo, hi]) => t >= lo - 1 && t <= hi + 1) ? W.itemBox : 0;
    if (!(p.area > 0)) return cost; // between shells, e.g. a word gap: nothing is cut
    if (p.letters) cost += W.letters;
    // on a long model the samples are further apart than 2 mm, so a letter that close is looked for on its own
    if (p.nearLetters || letterTs.some((lt) => lt !== t && Math.abs(lt - t) <= 2 + EPS)) cost += W.nearLetters;
    cost += W.ledge * Math.min(2, Math.abs(areaAt(profile, t + 2) - areaAt(profile, t - 2)) / Math.max(p.area, 1));
    if (medianA > 0) cost += W.neck * Math.max(0, 1 - p.area / (0.5 * medianA));
    cost += W.islands * Math.max(0, (p.roomy ?? p.islands ?? 1) - 1);
    cost += W.noRoom * clamp(Number(p.noRoom), 0, 1, 0);
    if (medianP > 0) cost += (W.perimeter * (p.perimeter || 0)) / medianP;
    return cost;
  });
}

/**
 * The runs of model in each column of a grid along one axis, for the
 * planner: `(p, i)` tells, for the box from the cut at sample p to the one
 * at sample i (−1 and the sample count: the model's ends), how many runs of
 * model its columns hold (`count`), how many of its columns hold any
 * (`filled`), and how many of the runs are slivers, shorter along the axis
 * than `sliver` (`thin`). The faces of both cuts are counted in, as each side
 * of a cut through model has some.
 * @param {number[]} samples positions, ascending
 * @param {Uint8Array[]} occupied per sample, a flag per column
 * @param {{ lo: number, hi: number, sliver: number }} options the model's extent on the axis, and the sliver length
 * @returns {(p: number, i: number) => { count: number, filled: number, thin: number }}
 */
export function runsOf(samples, occupied, { lo, hi, sliver }) {
  const n = samples.length;
  const columns = occupied[0]?.length ?? 0;
  const spans = Array.from({ length: columns }, () => []);
  for (let c = 0; c < columns; c++) {
    for (let j = 0; j < n; j++) {
      if (!occupied[j][c]) continue;
      if (j > 0 && occupied[j - 1][c]) spans[c][spans[c].length - 1][1] = j;
      else spans[c].push([j, j]);
    }
  }
  return (p, i) => {
    const first = Math.max(p, 0);
    const last = Math.min(i, n - 1);
    let count = 0;
    let filled = 0;
    let thin = 0;
    for (const list of spans) {
      let any = false;
      for (const [j0, j1] of list) {
        const a = Math.max(j0, first);
        const b = Math.min(j1, last);
        if (a > b) continue;
        count++;
        any = true;
        // as far as the model reaches: half way to the samples either side of the run, or to the cut
        const from = a === p ? samples[p] : a > 0 ? (samples[a - 1] + samples[a]) / 2 : lo;
        const to = b === i ? samples[i] : b < n - 1 ? (samples[b] + samples[b + 1]) / 2 : hi;
        if (to - from < sliver - 1e-6) thin++;
      }
      if (any) filled++;
    }
    return { count, filled, thin };
  };
}

/**
 * Where to put k cuts on one axis: the samples t₁ < … < t_k with the least
 * total cost (plus a pull towards even pieces, `PLAN_WEIGHTS.even` per even
 * piece's length a cut is off its even position), found by dynamic
 * programming. End pieces must be between `minEnd` and `S` long and middle
 * pieces between `minMid` and `S`; when that is impossible both minimums
 * drop to 0 (`relaxed`).
 *
 * A cut through a thin plate gets dovetail tabs (`grow`): the pieces either
 * side reach past it, and they may only lie flat, so they must fit within
 * `Sflat` once their tabs are counted. A cut with built-in pegs (`peg: true`)
 * makes one of them reach past it, the one below or the one above, as is
 * chosen with the cuts (below where either will do, as `pegMales` does on a
 * tie), and lays nothing flat: they must fit within S. So a cut moves a
 * little towards the piece that carries the pegs, which then fits with them.
 *
 * With `occupied` (whether each column the other axes' cuts make holds model
 * at each sample), every run of model in a column between two cuts is a
 * piece, or a loose part of one, and costs `PLAN_WEIGHTS.parts`, and much
 * more (`PLAN_WEIGHTS.sliver`) when it is a sliver: shorter along the axis
 * than a quarter of an even piece, or than an end piece may be.
 *
 * Cuts that come apart stay where they are (`fixed`): each is one of the k
 * cuts, at its own sample, and reaches a tongue's height past it on one side
 * (`LIP_ALLOWANCE`, chosen as pegs are), whatever `grow` says there – never
 * tabs. The others are planned round them.
 * @param {number[]} samples positions, ascending (from `planSamples`)
 * @param {number[]} costs one per sample (from `planCost`)
 * @param {{ lo: number, hi: number, k: number, S?: number, Sflat?: number, minEnd?: number, minMid?: number,
 *   grow?: ({ below: number, above: number, peg?: boolean }|null)[], occupied?: Uint8Array[]|null,
 *   fixed?: number[]|null }} limits
 *   lo/hi the model's extent on the axis, S the longest piece that fits (`maxCellLength`), Sflat the longest that fits
 *   lying flat; `grow` per sample, for a cut there with dovetail tabs (or pegs, `peg`), how far the piece below it
 *   (`below`) and the piece above it (`above`) reach past it. The minimums are for the pieces between the cuts, tabs
 *   left out.
 *   `occupied` per sample, a flag per column; `fixed` the indices of the samples where a cut must be (counted in k)
 * @returns {{ offsets: number[], reach: (number[]|null)[], cost: number, parts: number|null, slivers: number|null,
 *   relaxed: boolean }|null} null when no choice keeps every piece within S; `reach` per cut [below, above] as counted
 *   (a peg's length on one side for pegs), null for a plain one; `cost` leaves the parts out, `parts` and `slivers`
 *   count them (null without `occupied`)
 */
export function chooseOffsets(samples, costs, { lo, hi, k, S = Infinity, Sflat = S, minEnd = 0, minMid = 0, grow = null, occupied = null, fixed = null }) {
  const n = samples.length;
  const E = hi - lo;
  const tol = 1e-6;
  const even = (j) => lo + (E * (j + 1)) / (k + 1);
  const cell = E / (k + 1) || 1;
  const own = (i, j) => costs[i] + (PLAN_WEIGHTS.even * Math.abs(samples[i] - even(j))) / cell;
  // the cuts that come apart: no step from one cut to the next passes one, the first cut is at or before the first of
  // them and the last at or after the last, so every one of them is a cut
  const must = fixed?.length ? [...fixed].sort((a, b) => a - b) : null;
  const passes = (p, i) => must !== null && must.some((f) => f > p && f < i);
  const firstOk = (i) => must === null || i <= must[0];
  const lastOk = (i) => must === null || i >= must[must.length - 1];
  const tabs = (i) => (must !== null && must.includes(i) ? APART_GROW : grow?.[i] ?? null);
  // the ways a cut at each sample may reach: its tabs, or its pegs on the piece below it, then on the one above
  const wayList = samples.map((_, i) => {
    const g = tabs(i);
    if (!g?.peg) return [g];
    const L = Math.max(g.below, g.above);
    return [{ below: L, above: 0, peg: true }, { below: 0, above: L, peg: true }];
  });
  const ways = (i) => wayList[i];
  const W = 2; // states per sample: a cut there with each of its ways
  // each run of model a box between two cuts holds is a piece, or a loose part of one, and a thin one a sliver
  const runs = occupied?.length === n ? runsOf(samples, occupied, { lo, hi, sliver: Math.max(minEnd, cell / 4) }) : null;
  const parts = (p, i) => {
    if (!runs) return 0;
    const { count, thin } = runs(p, i);
    return PLAN_WEIGHTS.parts * count + PLAN_WEIGHTS.sliver * thin;
  };
  // a piece between a cut `a` under it and a cut `b` over it (either may be the model's end): its length, then with
  // the tabs or pegs that reach past its cuts against what fits the way it may lie (tabs lay it flat, pegs do not)
  const flatBy = (x) => Boolean(x) && !x.peg;
  const ok = (len, min, a, b) => len > tol && len >= min - tol
    && len + (a ? a.above : 0) + (b ? b.below : 0) <= (flatBy(a) || flatBy(b) ? Sflat : S) + tol;
  const run = (mEnd, mMid) => {
    // the cheapest choice so far by state (a sample and one of its ways); the first found of equal ones stays, so the
    // pegs go below a cut where either side will do
    let prev = new Float64Array(n * W).fill(Infinity);
    for (let i = 0; i < n; i++) {
      ways(i).forEach((g, v) => {
        if (firstOk(i) && ok(samples[i] - lo, mEnd, null, g)) prev[i * W + v] = own(i, 0) + parts(-1, i);
      });
    }
    const back = [];
    for (let j = 1; j < k; j++) {
      const cur = new Float64Array(n * W).fill(Infinity);
      const from = new Int32Array(n * W).fill(-1);
      for (let i = 0; i < n; i++) {
        const here = ways(i);
        for (let p = 0; p < i; p++) {
          const there = ways(p);
          for (let u = 0; u < there.length; u++) {
            if (prev[p * W + u] === Infinity || passes(p, i)) continue;
            for (let v = 0; v < here.length; v++) {
              if (!ok(samples[i] - samples[p], mMid, there[u], here[v])) continue;
              const c = prev[p * W + u] + own(i, j) + parts(p, i);
              if (c < cur[i * W + v]) {
                cur[i * W + v] = c;
                from[i * W + v] = p * W + u;
              }
            }
          }
        }
      }
      back.push(from);
      prev = cur;
    }
    let best = -1;
    const total = (x) => prev[x] + parts(Math.floor(x / W), n);
    for (let x = 0; x < n * W; x++) {
      const g = ways(Math.floor(x / W))[x % W];
      if (g === undefined || prev[x] === Infinity) continue;
      if (!lastOk(Math.floor(x / W))) continue;
      if (total(x) < (best < 0 ? Infinity : total(best)) && ok(hi - samples[Math.floor(x / W)], mEnd, g, null)) best = x;
    }
    if (best < 0) return null;
    const states = [best];
    for (let j = k - 2; j >= 0; j--) states.unshift(back[j][states[0]]);
    const idx = states.map((x) => Math.floor(x / W));
    const ends = [-1, ...idx, n];
    const boxes = runs ? ends.slice(1).map((i, j) => runs(ends[j], i)) : null;
    return {
      offsets: idx.map((i) => samples[i]),
      reach: states.map((x) => {
        const g = ways(Math.floor(x / W))[x % W];
        return g ? [g.below, g.above] : null;
      }),
      cost: idx.reduce((c, i, j) => c + own(i, j), 0),
      parts: boxes ? boxes.reduce((m, x) => m + x.count, 0) : null,
      slivers: boxes ? boxes.reduce((m, x) => m + x.thin, 0) : null,
    };
  };
  if (!(k > 0) || !n) return null;
  const strict = run(minEnd, minMid);
  if (strict) return { ...strict, relaxed: false };
  const loose = run(0, 0);
  return loose ? { ...loose, relaxed: true } : null;
}

/**
 * Where the cuts of one grid go, or null when its pieces cannot all fit.
 * Each axis is planned by `chooseOffsets` against the longest piece that
 * fits with the other axes' pieces even (their tabs shared out); a piece
 * next to a dovetail cut is held to what fits lying flat, and so is every
 * piece when another axis has dovetail cuts (each of its cuts runs right
 * across the model). The pieces that come out are then checked as they will
 * print, tabs counted; if one is too big because another axis's pieces came
 * out longer than even, the axes are planned again against those lengths,
 * and failing that with every piece held to the even one grown alike on
 * every side as far as it fits. All of that is first tried with room for
 * the longest tabs any cut could have; then, as the cuts may well miss the
 * plates (a gap between a box and its lid laid beside it), with none: a
 * grid whose even pieces fit is never lost.
 *
 * Each axis planned on its own cannot see the boxes the cuts make together:
 * with the outlines sliced at each sample (`rings`), every axis is planned
 * once more against the others' cuts, each run of model in a box being a
 * piece or a loose part of one, and a thin one a sliver
 * (`PLAN_WEIGHTS.parts`, `PLAN_WEIGHTS.sliver`): a cut just inside a
 * table's apron gives the boxes between its legs a sliver of it, one
 * through its stretcher a strip held loose over the rest. The plan so moved
 * stands when its pieces fit.
 *
 * A dovetail cut keeps its tabs as the cut stage would: not when a cut
 * along the plate's thickness runs through that plate (it would part the
 * tabs into layers), not when a piece beside it cannot lie flat on the
 * plate (`liesFlat`: a U's second leg would be held over the bed), and on
 * each axis only through plates as thick along the same axis as the first.
 * With built-in pegs (`peg`, their length) a cut that keeps no tabs has
 * pegs instead. A cut's pegs make one of the pieces either side that much
 * longer, the one `pegSides` gives them, as the pieces fit best; and as
 * pegs lay nothing flat, the pieces are first planned lying the way the even
 * ones would with no pegs: so a 30 mm slab's quarters still lie flat, its
 * cuts a little off centre and the shorter pieces carrying the pegs.
 * With `support` (what each box holds of the model), boxes that hold
 * nothing are no pieces, a piece must be able to lie on something flat –
 * one of its cut faces, or a flat side of the model where it ends – unless
 * `stable` is false, and the support the pieces need lying the best way
 * they fit is added to the cost (`PLAN_WEIGHTS.support`), so of two grids
 * the one whose pieces stand up wins over one whose pieces lie with a leg
 * held over the bed.
 *
 * Cuts that come apart (`fixed`) are never moved or left out: each is one of
 * its axis's cuts, at its own sample, and reaches a tongue's height past it on
 * the side `pegSides` gives it, as pegs do (`chooseOffsets`). A grid with fewer
 * cuts on an axis than stay there is no plan.
 * @param {number[]} k cuts per axis
 * @param {{ E: number[], U: number[], bounds: { min: number[], max: number[] }, flat?: number|null, minEnd?: number,
 *   minMid?: number, profileOf: function, support?: function|null, stable?: boolean, peg?: number|number[],
 *   fixed?: number[][]|null }} options E the
 *   model's extents, `flat` the axis every piece lies flat on (a thin plate, or a slab planned lying flat) or null;
 *   `profileOf(axis, k)` gives `{ samples, costs, tabs, rings? }` for k cuts on that axis, `tabs` per sample
 *   `{ below, above, w, span, t }` when a cut there would take dovetail tabs (see `chooseOffsets`; `span` the plate's
 *   extent along w, `t` its thickness), `{ below, above, peg: true }` when it would take built-in pegs, else null, and
 *   `rings` per sample the slice's outlines in the axis's plane coordinates (`TO_PLANE`); `support(cutsByAxis)` gives
 *   `cellSupport`'s map; `peg` the pegs' length when the joints are built-in pegs (per axis, or one for all), else 0;
 *   `fixed` per axis the positions of the cuts that come apart, each one of the samples `profileOf` gives (a plan
 *   whose samples miss one is null)
 * @returns {{ k: number[], offsets: number[][], cost: number, support: number, pieces: { cell: number[], size: number[],
 *   fits: true }[] }|null} `pieces` every box that makes a piece, as it will print, tabs and pegs counted; `support` the area
 *   (mm²) they need support under, as far as the boxes tell
 */
export function planGrid(k, options) {
  const { E, U, flat = null, fixed = null } = options;
  if (fixed && [0, 1, 2].some((a) => (fixed[a]?.length ?? 0) > k[a])) return null;
  const profileOf = fixed ? keptCuts(options.profileOf, fixed) : options.profileOf;
  const planned = fixed ? { ...options, profileOf } : options;
  // pegs lay nothing flat, but a piece that would lie flat with pins should with pegs too, where the cuts can give it
  // room: a 30 mm slab's quarters, not stood on their edges for a peg's length. So the pieces are planned lying as the
  // even ones with no pegs would, then any way
  if (flat === null && [0, 1, 2].some((a) => k[a] > 0 && profileOf(a, k[a]).tabs.some((x) => x?.peg))) {
    const lie = fitsBed(evenCell(E, k), U).down;
    const lying = lie ? gridPlan(k, { ...planned, flat: dirAxis(lie) }) : null;
    if (lying) return lying;
  }
  return gridPlan(k, planned);
}

/**
 * `profileOf` for a plan that keeps the cuts that come apart (`fixed`, their
 * positions per axis): each axis's profile also gives the indices of their
 * samples (`fixed`, −1 for one it lacks), and a tongue's reach there instead
 * of any tabs.
 */
const keptCuts = (profileOf, fixed) => (a, k) => {
  const profile = profileOf(a, k);
  const at = fixed[a] ?? [];
  if (!at.length) return profile;
  const idx = at.map((t) => profile.samples.findIndex((x) => Math.abs(x - t) <= 1e-6));
  return { ...profile, fixed: idx, tabs: profile.tabs.map((x, i) => (idx.includes(i) ? APART_GROW : x)) };
};

/** `planGrid` for one way of laying the pieces (`flat`, or any way). */
function gridPlan(k, { E, U, bounds, flat = null, minEnd = 0, minMid = 0, profileOf, support = null, stable = true, peg = 0 }) {
  const axes = [0, 1, 2].filter((a) => k[a] > 0);
  const profile = new Map(axes.map((a) => [a, profileOf(a, k[a])]));
  // a cut that comes apart and is not among the samples cannot be kept
  if (axes.some((a) => profile.get(a).fixed?.includes(-1))) return null;
  const tabsOf = new Map(axes.map((a) => [a, profile.get(a).tabs]));
  // a cut's tabs make both pieces either side longer, its pegs only one of them: half a peg either side shares them out
  // as `evenCell` counts
  const reach = [0, 1, 2].map((a) => (k[a] ? Math.max(0, ...tabsOf.get(a).map((x) => (x ? Math.max(x.below, x.above) / (x.peg ? 2 : 1) : 0))) : 0));
  const pegOn = (a) => (Array.isArray(peg) ? peg[a] : peg) || 0;
  // only tabs lay pieces flat: pegs make them longer and leave them free to lie any way
  const ws = [...new Set(axes.flatMap((a) => tabsOf.get(a)).filter((x) => x && !x.peg).map((x) => x.w))].sort();
  const [, e1, e2] = [...E].sort((p, q) => p - q);
  const broadest = Math.max(e1 * e2, EPS);
  // whether each column the other axes' cuts make holds model at each sample of axis a, from the outlines sliced there
  const occupancy = (a, offsets) => {
    const [u, v] = [(a + 1) % 3, (a + 2) % 3];
    const eu = [bounds.min[u], ...offsets[u], bounds.max[u]];
    const ev = [bounds.min[v], ...offsets[v], bounds.max[v]];
    const rects = [];
    for (let i = 0; i + 1 < eu.length; i++) for (let j = 0; j + 1 < ev.length; j++) rects.push([eu[i], ev[j], eu[i + 1], ev[j + 1]]);
    return profile.get(a).rings.map((rings) => Uint8Array.from(rects, (r) => (rings?.length && clippedArea(rings, r) > MIN_HELD ? 1 : 0)));
  };
  // `grow` how far the pieces are taken to reach past the cuts of each axis; `room`: when given, no piece may be
  // longer on an axis than it says
  const run = (grow, even, lengths, room = null) => {
    const offsets = [[], [], []];
    const limits = new Map();
    const costs = new Map();
    for (const a of axes) {
      const cell = lengths.map((v, b) => (b === a ? even[a] : v));
      const S = Math.min(maxCellLength(cell, a, U, { flat }), room?.any[a] ?? Infinity);
      const Sflat = flat === null && ws.length ? Math.min(maxCellLength(cell, a, U, { flat: ws }), room?.flat[a] ?? Infinity) : S;
      const others = axes.some((b) => b !== a && grow[b] > 0);
      const fixed = profile.get(a).fixed ?? null;
      limits.set(a, { lo: bounds.min[a], hi: bounds.max[a], k: k[a], S: others ? Sflat : S, Sflat, minEnd, minMid, grow: tabsOf.get(a), ...(fixed ? { fixed } : {}) });
      const choice = chooseOffsets(profile.get(a).samples, profile.get(a).costs, limits.get(a));
      if (!choice) return null;
      offsets[a] = choice.offsets;
      costs.set(a, choice.cost);
    }
    if (!axes.every((a) => profile.get(a).rings)) return assess(offsets, [...costs.values()].reduce((c, x) => c + x, 0));
    const first = assess(offsets, [...costs.values()].reduce((c, x) => c + x, 0) + loose(offsets));
    // each axis again, now that the others' cuts are known: every run of model in a box between them is a piece, or a
    // loose part of one, so the cuts move to leave few and no slivers (one just inside a table's apron leaves the boxes
    // between its legs a sliver of it each). Twice round, as an axis's new cuts change the others' boxes
    const better = offsets.map((list) => [...list]);
    let moved = false;
    for (let round = 0; round < 2; round++) {
      let again = false;
      for (const a of axes) {
        const choice = chooseOffsets(profile.get(a).samples, profile.get(a).costs, { ...limits.get(a), occupied: occupancy(a, better) });
        if (!choice || choice.offsets.every((t, i) => t === better[a][i])) continue;
        better[a] = choice.offsets;
        costs.set(a, choice.cost);
        again = moved = true;
      }
      if (!again) break;
    }
    if (!moved) return first;
    const second = assess(better, [...costs.values()].reduce((c, x) => c + x, 0) + loose(better));
    return second && (!fitted(first) || fitted(second)) ? second : first;
  };
  // what a grid's loose parts and slivers cost, beyond one piece to a box: so that, of two grids with as many boxes,
  // the one that leaves none wins too
  const loose = (offsets) => {
    let cost = 0;
    for (const a of axes) {
      const { samples } = profile.get(a);
      const runs = runsOf(samples, occupancy(a, offsets), { lo: bounds.min[a], hi: bounds.max[a], sliver: Math.max(minEnd, E[a] / (k[a] + 1) / 4) });
      const ends = [-1, ...offsets[a].map((t) => samples.indexOf(t)), samples.length];
      for (let j = 1; j < ends.length; j++) {
        const { count, filled, thin } = runs(ends[j - 1], ends[j]);
        cost += PLAN_WEIGHTS.parts * (count - filled) + PLAN_WEIGHTS.sliver * thin;
      }
    }
    return cost;
  };
  // the pieces of a grid with these cuts, as they will print, and what they cost
  const assess = (offsets, cost) => {
    // the pieces as they will print: a tab's length longer past each dovetail cut that keeps its tabs, and flat beside one
    const chosen = axes.flatMap((a) => offsets[a].map((t) => ({ axis: a, at: t, tabs: tabsOf.get(a)[profile.get(a).samples.indexOf(t)] })));
    const by = axisCuts(chosen);
    const held = support ? support(by) : null;
    const thickness = [null, null, null];
    const cuts = chosen.map(({ axis, at, tabs }) => {
      // a cut with pegs reaches a peg's length past it on the side `pegSides` gives them
      if (tabs?.peg) return { axis, at, peg: Math.max(tabs.below, tabs.above) };
      // without its span, a plate is taken to run right through the model along w
      const [w0, w1] = tabs?.span ?? [-Infinity, Infinity];
      const through = tabs && chosen.some((c) => c.axis === tabs.w && c.at > w0 + CUT_TOLERANCE && c.at < w1 - CUT_TOLERANCE);
      const lie = tabs && held && tabs.t ? boxesBeside(held, axis, by[axis].indexOf(at), at).every((s) => liesFlat(s, tabs.w, tabs.t)) : true;
      const kept = tabs && !through && lie && (thickness[axis] ?? tabs.w) === tabs.w;
      if (kept) thickness[axis] = tabs.w;
      // through a plate but keeping no tabs when the joints are pegs, it has pegs instead
      return { axis, at, ...(kept ? { reach: [tabs.below, tabs.above], w: tabs.w } : tabs && pegOn(axis) > 0 ? { peg: pegOn(axis) } : {}) };
    });
    // a box whose model stops short of a dovetail cut holds none of its plate, as the cut stage judges each shell
    const meets = held ? (cell, a, at) => {
      const s = held.get(cell.join(','));
      return !s?.extent || (s.extent.min[a] <= at + 0.02 && s.extent.max[a] >= at - 0.02);
    } : null;
    // a piece lies on a cut face, or where the model it holds is flat; a plate's, or one beside dovetails, lies flat,
    // and so does a slab's when `flat` asks it to (with nothing flat on that side it cannot)
    const waysOf = (c, s) => {
      let ways = c.flat;
      if (ways === null && held && stable) ways = [0, 1, 2].filter((a) => c.cell[a] > 0 || c.cell[a] < k[a] || s.rests[a]);
      if (c.flat === null && flat !== null) ways = ways === null || [].concat(ways).includes(flat) ? flat : [];
      return ways;
    };
    const fitting = (c) => {
      const s = held?.get(c.cell.join(','));
      return (held && !s?.filled) || fitsBed(c.size, U, { flat: waysOf(c, s) }).fits;
    };
    const { cells } = cellSizes(bounds, pegSides(bounds, cuts, fitting, { meets }), { meets });
    const pieces = [];
    let need = 0;
    for (const c of cells) {
      const s = held?.get(c.cell.join(','));
      if (held && !s?.filled) continue;
      const ways = waysOf(c, s);
      pieces.push({ cell: c.cell, size: c.size, fits: fitsBed(c.size, U, { flat: ways }).fits });
      if (s?.lying) need += leastSupport(s, c.size, ways, U);
    }
    return { k, offsets, cost: cost + (PLAN_WEIGHTS.support * need) / broadest, support: need, cells, pieces };
  };
  const fitted = (p) => p && p.pieces.length > 0 && p.pieces.every((x) => x.fits);
  const attempt = (grow) => {
    const even = evenCell(E, k, grow);
    let plan = run(grow, even, even);
    if (plan && !fitted(plan)) {
      const longest = [0, 1, 2].map((b) => Math.max(...plan.cells.map((c) => c.size[b])));
      plan = run(grow, even, longest);
    }
    if (!fitted(plan)) {
      // each axis is planned against the others' even pieces, so all of them may take their room the same way and
      // leave a corner piece too big for any bed they were planned against. The even pieces fit, so the grid is
      // planned once more with every piece held to the even one grown alike on every side, as far as that fits
      const any = sharedRoom(even, U, flat);
      const room = any && { any, flat: flat === null && ws.length ? sharedRoom(even, U, ws) ?? any : any };
      if (room) plan = run(grow, even, even, room);
    }
    return fitted(plan) ? plan : null;
  };
  const plan = attempt(reach) ?? (reach.some((v) => v > 0) ? attempt([0, 0, 0]) : null);
  if (!plan) return null;
  const { cells, ...rest } = plan;
  return rest;
}

/**
 * The boxes of `cellSupport`'s map that hold model on either side of the
 * cut at `at`, the `index`-th on its axis, and reach it: the pieces a
 * joint across that cut joins.
 */
export function boxesBeside(held, axis, index, at) {
  const out = [];
  for (const s of held.values()) {
    if (!s.filled || !s.extent) continue;
    if (s.cell[axis] === index && s.extent.max[axis] >= at - 0.02) out.push(s);
    else if (s.cell[axis] === index + 1 && s.extent.min[axis] <= at + 0.02) out.push(s);
  }
  return out;
}

/**
 * The least support (mm²) a box's model needs lying a way it fits the bed: on the axes it may lie on (`ways`, null
 * for any), resting on something there when it can.
 */
function leastSupport(held, size, ways, U) {
  const options = [];
  for (const a of ways === null ? [0, 1, 2] : [].concat(ways)) {
    if (!fitsBed(size, U, { flat: a }).fits) continue;
    for (const s of ['-', '+']) options.push(held.lying[`${s}${AXES[a]}`]);
  }
  const resting = options.filter((x) => x.bed >= STEADY || x.cut);
  const list = resting.length ? resting : options;
  return list.length ? Math.min(...list.map((x) => x.support)) : 0;
}

/**
 * A box grown alike on every side as far as it fits the bed (bisection on
 * `fitsBed`, `flat` as there), or null when it does not fit as it is.
 */
function sharedRoom(box, U, flat) {
  const fits = (f) => fitsBed(box.map((v) => v * f), U, { flat }).fits;
  if (!fits(1)) return null;
  let lo = 1;
  let hi = (Math.hypot(...U) + 1) / Math.max(EPS, Math.min(...box)); // nothing longer than the bed's diagonal fits
  for (let i = 0; i < 48 && hi - lo > 1e-9; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return box.map((v) => v * lo);
}

/**
 * Where to look along a cut's axis to see that the plate it runs through
 * stays where it is across the pieces either side: half way along each and
 * most of the way to its far end (`lo` and `hi`: the next cuts, or the
 * model's ends). A side shorter than 10 mm is not looked at.
 */
export function flatProbes(at, lo, hi) {
  const out = [];
  for (const end of [lo, hi]) {
    const len = Math.abs(end - at);
    if (!(len >= 10)) continue;
    const dir = Math.sign(end - at);
    out.push(at + dir * 0.5 * len, at + dir * 0.9 * len);
  }
  return out;
}

/**
 * Each triangle's box and, for one facing within 45° of an axis, which way, whether it faces that way squarely
 * (`FLAT`), its area and where its corner furthest from that end lies, worked out once per mesh.
 */
const meshFacts = new WeakMap();
function factsOf(mesh) {
  if (meshFacts.has(mesh)) return meshFacts.get(mesh);
  const { vertProperties: P, numProp, triVerts: T } = mesh;
  const n = Math.floor(T.length / 3);
  const box = new Float64Array(n * 6);
  const face = new Int8Array(n).fill(-1);
  const square = new Uint8Array(n);
  const area = new Float64Array(n);
  const pos = new Float64Array(n);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < n; t++) {
    const a = T[3 * t] * numProp;
    const b = T[3 * t + 1] * numProp;
    const c = T[3 * t + 2] * numProp;
    for (let k = 0; k < 3; k++) {
      const lo = Math.min(P[a + k], P[b + k], P[c + k]);
      const hi = Math.max(P[a + k], P[b + k], P[c + k]);
      box[6 * t + k] = lo;
      box[6 * t + 3 + k] = hi;
      if (lo < min[k]) min[k] = lo;
      if (hi > max[k]) max[k] = hi;
    }
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) continue;
    const axis = Math.abs(nx) >= Math.abs(ny) && Math.abs(nx) >= Math.abs(nz) ? 0 : Math.abs(ny) >= Math.abs(nz) ? 1 : 2;
    const along = axis === 0 ? nx : axis === 1 ? ny : nz;
    // facing within 45° of the axis: what would need support lying that way, or the bed when it faces it squarely
    if (!(Math.abs(along) / len > COS45)) continue;
    face[t] = axis * 2 + (along < 0 ? 0 : 1);
    square[t] = Math.abs(along) / len > FLAT ? 1 : 0;
    area[t] = len / 2;
    // the corner furthest from the bed it would lie on: a facet is bed only when all of it is at the end, as
    // `orientationStats` counts it; the facets round a ball's pole lean a little, so their centres are there and
    // their outer corners are not
    pos[t] = along < 0 ? box[6 * t + 3 + axis] : box[6 * t + axis];
  }
  const facts = { n, box, face, square, area, pos, min, max };
  meshFacts.set(mesh, facts);
  return facts;
}

/** How far inside a cut a triangle must reach to put material in the box beyond it (mm): a face lying on the cut puts none. */
const BOX_SKIN = 1e-4;

/**
 * Whether a triangle (`t`: its corners' x, y, z one after another) meets the
 * box [lo, hi]: no separating axis among the box's three, the triangle's
 * normal and the nine crossings of the two's edges. The box must be finite.
 */
export function triangleMeetsBox(t, lo, hi) {
  const c0 = (lo[0] + hi[0]) / 2;
  const c1 = (lo[1] + hi[1]) / 2;
  const c2 = (lo[2] + hi[2]) / 2;
  const h0 = (hi[0] - lo[0]) / 2;
  const h1 = (hi[1] - lo[1]) / 2;
  const h2 = (hi[2] - lo[2]) / 2;
  const ax = t[0] - c0, ay = t[1] - c1, az = t[2] - c2;
  const bx = t[3] - c0, by = t[4] - c1, bz = t[5] - c2;
  const cx = t[6] - c0, cy = t[7] - c1, cz = t[8] - c2;
  const apart = (p, q, s, r) => Math.min(p, q, s) > r || Math.max(p, q, s) < -r;
  if (apart(ax, bx, cx, h0) || apart(ay, by, cy, h1) || apart(az, bz, cz, h2)) return false;
  for (const [ex, ey, ez] of [[bx - ax, by - ay, bz - az], [cx - bx, cy - by, cz - bz], [ax - cx, ay - cy, az - cz]]) {
    // the box's x, y and z each crossed with this edge
    if (apart(ey * az - ez * ay, ey * bz - ez * by, ey * cz - ez * cy, h1 * Math.abs(ez) + h2 * Math.abs(ey))) return false;
    if (apart(ez * ax - ex * az, ez * bx - ex * bz, ez * cx - ex * cz, h0 * Math.abs(ez) + h2 * Math.abs(ex))) return false;
    if (apart(ex * ay - ey * ax, ex * by - ey * bx, ex * cy - ey * cx, h0 * Math.abs(ey) + h1 * Math.abs(ex))) return false;
  }
  const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
  const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return Math.abs(nx * ax + ny * ay + nz * az) <= h0 * Math.abs(nx) + h1 * Math.abs(ny) + h2 * Math.abs(nz);
}

/**
 * Whether a triangle whose box is [tlo, thi] reaches into the box between `lo` and `hi` (either may be infinite: the
 * grid's outer boxes run on past the model), more than `BOX_SKIN` past a side of it that is a cut: its box can
 * overlap a box the triangle itself misses, as the long side of a cone overlaps the empty corners round its tip.
 */
export function triangleInBox(t, tlo, thi, lo, hi) {
  const blo = [0, 0, 0];
  const bhi = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    blo[a] = Math.max(tlo[a], lo[a] + BOX_SKIN);
    bhi[a] = Math.min(thi[a], hi[a] - BOX_SKIN);
    if (blo[a] > bhi[a]) return false;
  }
  return triangleMeetsBox(t, blo, bhi);
}

/**
 * What each box of a grid holds of a mesh, for the planner: whether it
 * holds any of the model (a box no triangle enters is wholly inside the
 * model or wholly outside it: a ray from its centre tells which; a
 * triangle's own box is no guide, as a cone's long sides span the empty
 * boxes round its tip), and on
 * which axes the model it holds rests on something flat where it ends –
 * facets facing that way, wholly within 0.1 mm of the furthest the box's
 * material goes, of 25 mm² or more: the bed `orientationStats` counts. A
 * ball's quarter has nothing flat but its cut faces, and a bowl's half
 * cannot stand on the tip of its curve. For a box the surface reaches, it
 * also tells, for each way down, what the model it holds would rest on
 * and need under it lying that way (`lying`, as `orientationStats` counts
 * a piece's, cut faces aside: they rest on the bed or stand upright), and
 * where that material ends (`extent`). What is worked out from the mesh
 * alone is kept with it, so trying grid after grid costs little.
 * @param {{ vertProperties: Float32Array|number[], numProp: number, triVerts: Uint32Array|number[] }} mesh
 * @param {number[][]} cutsByAxis sorted positions per axis (`axisCuts`)
 * @returns {Map<string, { cell: number[], filled: boolean, rests: boolean[], extent?: { min: number[], max: number[] },
 *   lying?: Object<string, { bed: number, support: number, volume: number, cut: boolean }> }>} by 'i,j,k', every box
 *   of the grid; `lying` by direction ('-z' …): `bed` the area on the bed, `support` the area that would need support
 *   and `volume` that area times its height over the bed, `cut` whether a cut face of the box lies on the bed there
 */
export function cellSupport(mesh, cutsByAxis) {
  const { n: count, box, face, square, area, pos, min, max } = factsOf(mesh);
  const cuts = [0, 1, 2].map((a) => cutsByAxis[a] ?? []);
  const n = cuts.map((c) => c.length + 1);
  const boxes = n[0] * n[1] * n[2];
  const lo = new Float64Array(boxes * 3).fill(Infinity);
  const hi = new Float64Array(boxes * 3).fill(-Infinity);
  const touched = new Uint8Array(boxes);
  // per box and way (box · 6 + face): the area of every facet facing that way, and that area times its middle along
  // the axis, for the support under the box and its height; the square facets one by one, for what it rests on
  const facing = new Float64Array(boxes * 6);
  const moment = new Float64Array(boxes * 6);
  const facets = new Map(); // `${box}|${face}` → [position along the axis, area, middle, …] of the square facets
  const edgeLo = (a, c) => (c > 0 ? cuts[a][c - 1] : -Infinity);
  const edgeHi = (a, c) => (c < cuts[a].length ? cuts[a][c] : Infinity);
  const first = (a, v) => {
    let c = 0;
    while (c < cuts[a].length && v > cuts[a][c]) c++;
    return c;
  };
  const from = [0, 0, 0];
  const to = [0, 0, 0];
  const cell = [0, 0, 0];
  const corners = new Float64Array(9);
  const tlo = [0, 0, 0];
  const thi = [0, 0, 0];
  const blo = [0, 0, 0];
  const bhi = [0, 0, 0];
  const { vertProperties: P, numProp, triVerts: T } = mesh;
  for (let t = 0; t < count; t++) {
    for (let a = 0; a < 3; a++) {
      from[a] = first(a, box[6 * t + a]);
      to[a] = first(a, box[6 * t + 3 + a]);
    }
    const f = face[t];
    // a triangle across a cut is looked at box by box: its own box overlaps boxes it never enters
    const across = from[0] !== to[0] || from[1] !== to[1] || from[2] !== to[2];
    if (across) {
      for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) corners[3 * v + a] = P[T[3 * t + v] * numProp + a];
      for (let a = 0; a < 3; a++) {
        tlo[a] = box[6 * t + a];
        thi[a] = box[6 * t + 3 + a];
      }
    }
    for (let k = from[2]; k <= to[2]; k++) {
      for (let j = from[1]; j <= to[1]; j++) {
        for (let i = from[0]; i <= to[0]; i++) {
          const b = i + n[0] * (j + n[1] * k);
          cell[0] = i;
          cell[1] = j;
          cell[2] = k;
          if (across) {
            for (let a = 0; a < 3; a++) {
              blo[a] = edgeLo(a, cell[a]);
              bhi[a] = edgeHi(a, cell[a]);
            }
            if (!triangleInBox(corners, tlo, thi, blo, bhi)) continue;
          }
          touched[b] = 1;
          for (let a = 0; a < 3; a++) {
            lo[b * 3 + a] = Math.min(lo[b * 3 + a], Math.max(box[6 * t + a], edgeLo(a, cell[a])));
            hi[b * 3 + a] = Math.max(hi[b * 3 + a], Math.min(box[6 * t + 3 + a], edgeHi(a, cell[a])));
          }
          if (f < 0) continue;
          // a facet facing along an axis: what the box could rest on, or would need support under, its area shared
          // between the boxes it spans (along its own axis too, when it leans and so spans that axis)
          const axis = f >> 1;
          let share = 1;
          for (let a = 0; a < 3; a++) {
            const blo = box[6 * t + a];
            const bhi = box[6 * t + 3 + a];
            if ((a === axis && square[t]) || !(bhi > blo)) continue;
            share *= (Math.min(bhi, edgeHi(a, cell[a])) - Math.max(blo, edgeLo(a, cell[a]))) / (bhi - blo);
          }
          const mid = (Math.max(box[6 * t + axis], edgeLo(axis, cell[axis])) + Math.min(box[6 * t + 3 + axis], edgeHi(axis, cell[axis]))) / 2;
          facing[b * 6 + f] += area[t] * share;
          moment[b * 6 + f] += area[t] * share * mid;
          if (!square[t]) continue;
          const key = `${b}|${f}`;
          if (!facets.has(key)) facets.set(key, []);
          facets.get(key).push(pos[t], area[t] * share, mid);
        }
      }
    }
  }
  const out = new Map();
  for (let k = 0; k < n[2]; k++) {
    for (let j = 0; j < n[1]; j++) {
      for (let i = 0; i < n[0]; i++) {
        const b = i + n[0] * (j + n[1] * k);
        const at = [i, j, k];
        let filled = touched[b] === 1;
        if (!filled && min[0] <= max[0]) {
          const centre = at.map((c, a) => (Math.max(min[a], edgeLo(a, c)) + Math.min(max[a], edgeHi(a, c))) / 2);
          filled = insideMesh(mesh.vertProperties, mesh.numProp, mesh.triVerts, centre);
        }
        if (touched[b] !== 1) {
          out.set(at.join(','), { cell: at, filled, rests: [false, false, false] });
          continue;
        }
        const lying = {};
        for (let a = 0; a < 3; a++) {
          for (const dir of [0, 1]) {
            const end = dir ? hi[b * 3 + a] : lo[b * 3 + a];
            const list = facets.get(`${b}|${a * 2 + dir}`) ?? [];
            let bed = 0;
            let bedMoment = 0;
            for (let x = 0; x < list.length; x += 3) {
              if (Math.abs(list[x] - end) > 0.1) continue;
              bed += list[x + 1];
              bedMoment += list[x + 1] * list[x + 2];
            }
            // what is not on the bed needs support, as high over it as its middle
            const support = Math.max(0, facing[b * 6 + a * 2 + dir] - bed);
            const lifted = moment[b * 6 + a * 2 + dir] - bedMoment;
            const volume = Math.max(0, dir ? end * support - lifted : lifted - end * support);
            // the box's own cut face on that side, when the model it holds reaches it
            const cut = dir ? at[a] < cuts[a].length && end >= cuts[a][at[a]] - 0.02 : at[a] > 0 && end <= cuts[a][at[a] - 1] + 0.02;
            lying[`${dir ? '+' : '-'}${AXES[a]}`] = { bed, support, volume, cut };
          }
        }
        const rests = [0, 1, 2].map((a) => lying[`-${AXES[a]}`].bed >= STEADY || lying[`+${AXES[a]}`].bed >= STEADY);
        const extent = { min: [0, 1, 2].map((a) => lo[b * 3 + a]), max: [0, 1, 2].map((a) => hi[b * 3 + a]) };
        out.set(at.join(','), { cell: at, filled, rests, extent, lying });
      }
    }
  }
  return out;
}

/**
 * Whether the model a box holds (an entry of `cellSupport`) may lie flat
 * on axis w, as every piece beside a dovetail cut through a plate as thick
 * as `thickness` must: one way or the other it rests on the bed (or on a
 * cut face), and needs little more support than the least it needs any way
 * down – height counted, at most a quarter of the plate's own volume over
 * its footprint. A tapered tip a few millimetres over the bed is fine; a
 * second leg or skin held over the bed, or a round grip that leaves the
 * plate in the air, is not. A box the surface never reaches is solid
 * through, and lies any way.
 */
export function liesFlat(held, w, thickness) {
  if (!held?.lying) return true;
  const least = Math.min(...Object.values(held.lying).map((x) => x.volume));
  const side = (a) => held.extent.max[a] - held.extent.min[a];
  const slack = 0.25 * side((w + 1) % 3) * side((w + 2) % 3) * thickness;
  return ['-', '+'].some((s) => {
    const way = held.lying[`${s}${AXES[w]}`];
    return (way.bed >= STEADY || way.cut) && way.volume <= least + slack;
  });
}

/** Whether a point lies inside a closed mesh: a ray along +x from it crosses the surface an odd number of times. */
function insideMesh(P, numProp, T, p) {
  // nudged off the grid, so the ray is unlikely to run along an edge
  const y = p[1] + 1.234567e-5;
  const z = p[2] + 2.345678e-5;
  let crossings = 0;
  for (let t = 0; t + 2 < T.length; t += 3) {
    const a = T[t] * numProp;
    const b = T[t + 1] * numProp;
    const c = T[t + 2] * numProp;
    const d = (P[b + 1] - P[a + 1]) * (P[c + 2] - P[a + 2]) - (P[c + 1] - P[a + 1]) * (P[b + 2] - P[a + 2]);
    if (!d) continue;
    const s = ((y - P[a + 1]) * (P[c + 2] - P[a + 2]) - (P[c + 1] - P[a + 1]) * (z - P[a + 2])) / d;
    const r = ((P[b + 1] - P[a + 1]) * (z - P[a + 2]) - (y - P[a + 1]) * (P[b + 2] - P[a + 2])) / d;
    if (s < 0 || r < 0 || s + r > 1) continue;
    if (P[a] + s * (P[b] - P[a]) + r * (P[c] - P[a]) > p[0]) crossings++;
  }
  return crossings % 2 === 1;
}

// ---------- cells ----------

/**
 * The cell [i, j, k] of a shell: on each axis, the cell its extent overlaps
 * most. A dovetail tab that pushes a box over the line does not move it.
 * @param {{ min: number[], max: number[] }} bounds the shell's bounding box
 * @param {number[][]} cutsByAxis sorted positions per axis (`axisCuts`)
 */
export function cellOf(bounds, cutsByAxis) {
  return [0, 1, 2].map((a) => {
    const cuts = cutsByAxis[a] ?? [];
    const lo = bounds.min[a];
    const hi = bounds.max[a];
    if (!cuts.length) return 0;
    if (!(hi - lo > EPS)) return cellIndex(lo, cuts);
    let best = 0;
    let bestLen = -Infinity;
    for (let i = 0; i <= cuts.length; i++) {
      const len = Math.min(hi, i === cuts.length ? Infinity : cuts[i]) - Math.max(lo, i === 0 ? -Infinity : cuts[i - 1]);
      if (len > bestLen + EPS) {
        best = i;
        bestLen = len;
      }
    }
    return best;
  });
}

const cellIndex = (t, cuts) => {
  let i = 0;
  while (i < cuts.length && t > cuts[i]) i++;
  return i;
};

/** The cell [i, j, k] holding a point (a point on a cut belongs to the lower cell). */
export const cellOfPoint = (p, cutsByAxis) => [0, 1, 2].map((a) => cellIndex(p[a], cutsByAxis[a] ?? []));

/**
 * The box of every cell the cuts make inside `bounds`, bottom layer first,
 * then front to back, then left to right (the order pieces are numbered in).
 * Takes stored or normalised cuts; ones that miss are ignored. A cut with
 * dovetail tabs may say so, as the engine's measure of it does: `reach`
 * [below, above], how far the pieces either side reach past it, and `w`,
 * the axis those pieces must lie flat on. A cell's `size` then counts its
 * tabs, and its `flat` is that axis (the axes, when dovetail cuts on two
 * plates meet at it). When `bounds` is a thin plate every cell lies flat on
 * its thickness, joints or not. With `meets`, a cell whose material stops
 * short of a dovetail cut holds none of its plate: the tabs neither grow it
 * nor lay it flat.
 * @param {{ min: number[], max: number[] }} bounds
 * @param {object[]} cuts
 * @param {{ meets?: ((cell: number[], axis: number, at: number) => boolean)|null }} options whether a cell's material
 *   reaches the cut at `at` on `axis` (all of them when not given)
 * @returns {{ grid: number[], cells: { cell: number[], min: number[], max: number[], size: number[],
 *   flat: number|number[]|null }[] }}
 */
export function cellSizes(bounds, cuts = [], { meets = null } = {}) {
  const by = axisCuts(cuts, bounds);
  const plate = plateAxis([0, 1, 2].map((a) => bounds.max[a] - bounds.min[a]));
  const tabs = [new Map(), new Map(), new Map()];
  for (const cut of cuts) {
    const p = cutPlane(cut);
    if (p && Array.isArray(cut.reach) && !tabs[p.axis].has(p.at)) tabs[p.axis].set(p.at, { below: Number(cut.reach[0]) || 0, above: Number(cut.reach[1]) || 0, w: cut.w ?? null });
  }
  const edges = [0, 1, 2].map((a) => [bounds.min[a], ...by[a], bounds.max[a]]);
  const cells = [];
  for (let k = 0; k < edges[2].length - 1; k++) {
    for (let j = 0; j < edges[1].length - 1; j++) {
      for (let i = 0; i < edges[0].length - 1; i++) {
        const cell = [i, j, k];
        const min = cell.map((c, a) => edges[a][c]);
        const max = cell.map((c, a) => edges[a][c + 1]);
        const ws = new Set();
        const size = max.map((v, a) => {
          // the cut under the cell lends it the tabs of the piece above that cut, the cut over it those of the piece below
          const under = cell[a] > 0 && (!meets || meets(cell, a, min[a])) ? tabs[a].get(min[a]) : null;
          const over = cell[a] < by[a].length && (!meets || meets(cell, a, max[a])) ? tabs[a].get(max[a]) : null;
          for (const t of [under, over]) if (t?.w != null) ws.add(t.w);
          return v - min[a] + (under?.above ?? 0) + (over?.below ?? 0);
        });
        const flat = plate ?? (ws.size > 1 ? [...ws].sort() : ws.size ? [...ws][0] : null);
        cells.push({ cell, min, max, size, flat });
      }
    }
  }
  return { grid: by.map((l) => l.length), cells };
}

/** Whether a cell from `cellSizes` fits the bed, tabs counted, lying flat when it is a plate's or a dovetail seam says so. */
export const cellFits = (cell, U) => fitsBed(cell.size, U, { flat: cell.flat ?? null }).fits;

/**
 * Which side of each cut with built-in pegs carries them, as far as the
 * boxes between the cuts tell, so that they count a peg's length on one
 * side only, as the pieces will (`pegMales` gives the pegs to a piece that
 * still fits with them). Along each axis, the pegs of its cuts go on the box
 * below each cut or the one above it so that as few boxes as can be are too
 * big (`fits`), below where either does as well, as `pegMales` does on a tie
 * – so the middle pieces of a post carry the pegs of the cut over them only,
 * not of both; twice round the axes, as one's choice changes the others'
 * boxes. Without `fits`, every cut's pegs go below it.
 * @param {{ min: number[], max: number[] }} bounds
 * @param {object[]} cuts as for `cellSizes`; those with built-in pegs have `peg`, how far they stand out (mm)
 * @param {((cell: object) => boolean)|null} fits whether a box from `cellSizes` fits the bed (or is no piece)
 * @param {{ meets?: function|null }} options as for `cellSizes`
 * @returns {object[]} the cuts, those with built-in pegs with `reach` [below, above]
 */
export function pegSides(bounds, cuts, fits = null, { meets = null } = {}) {
  const out = cuts.map((c) => (c.peg > 0 ? { ...c, reach: [c.peg, 0] } : c));
  if (!fits || !out.some((c) => c.peg > 0)) return out;
  const misfits = (list, slab = null) => cellSizes(bounds, list, { meets }).cells.filter((c) => (!slab || c.cell[slab[0]] === slab[1]) && !fits(c)).length;
  if (!misfits(out)) return out;
  const way = (i, v) => ({ ...out[i], reach: v ? [0, out[i].peg] : [out[i].peg, 0] });
  for (let round = 0; round < 2; round++) {
    for (let a = 0; a < 3; a++) {
      const along = axisCuts(out, bounds)[a];
      // the cut `cellSizes` takes each plane's reach from (the first with one), when it has pegs
      const which = along.map((t) => {
        const i = out.findIndex((c) => Array.isArray(c.reach) && cutPlane(c)?.axis === a && cutPlane(c).at === t);
        return i >= 0 && out[i].peg > 0 ? i : -1;
      });
      if (!which.some((i) => i >= 0)) continue;
      const states = (j) => (j < 0 || j >= which.length || which[j] < 0 ? [null] : [0, 1]);
      // the boxes between cut j − 1 and cut j that are too big with those cuts' pegs on these sides
      const cost = (j, u, v) => misfits(out.map((c, i) => (i === which[j - 1] && u !== null ? way(i, u) : i === which[j] && v !== null ? way(i, v) : c)), [a, j]);
      // the fewest boxes too big up to each cut, by the side its pegs are on (the first found of equal ones kept)
      let best = states(0).map((v) => ({ cost: cost(0, null, v), path: [v] }));
      for (let j = 1; j <= which.length; j++) {
        best = states(j).map((v) => {
          let pick = null;
          states(j - 1).forEach((u, k) => {
            const c = best[k].cost + cost(j, u, v);
            if (!pick || c < pick.cost) pick = { cost: c, path: [...best[k].path, v] };
          });
          return pick;
        });
      }
      best[0].path.forEach((v, j) => {
        if (v !== null && j < which.length) out[which[j]] = way(which[j], v);
      });
    }
  }
  return out;
}

/**
 * Where "+ Cut" puts the next cut: across the middle of the longest piece,
 * along its longest side, as a stored cut `{ position, normal }` (position
 * at the centre of the bounds on the other axes). When that would break the
 * limits the next-longest choice is taken; null when no cut can be added.
 */
export function nextCut(bounds, cuts = []) {
  if (cuts.length >= SPLIT_LIMITS.cuts) return null;
  const { grid, cells } = cellSizes(bounds, cuts);
  const options = [];
  for (const c of cells) for (let a = 0; a < 3; a++) options.push({ c, a, len: c.size[a] });
  options.sort((p, q) => q.len - p.len); // stable: ties keep the cell order, then x, y, z
  for (const { c, a, len } of options) {
    if (len < 4 * CUT_TOLERANCE) break;
    const g = grid.map((v, i) => v + (i === a ? 1 : 0));
    if ((g[0] + 1) * (g[1] + 1) * (g[2] + 1) > SPLIT_LIMITS.cells) continue;
    const position = [0, 1, 2].map((i) => (i === a ? (c.min[a] + c.max[a]) / 2 : (bounds.min[i] + bounds.max[i]) / 2));
    const normal = [0, 0, 0];
    normal[a] = 1;
    return { position, normal };
  }
  return null;
}

// ---------- where pins go on a face ----------

/** The area of polygons as `CrossSection.toPolygons()` gives them (outlines counter-clockwise, holes clockwise). */
export function polygonsArea(polygons) {
  let sum = 0;
  for (const poly of polygons) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % poly.length];
      sum += x0 * y1 - x1 * y0;
    }
  }
  return Math.abs(sum / 2);
}

/** The centroid of polygons (outlines counter-clockwise, holes clockwise); null when they have no area. */
export function polygonsCentroid(polygons) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (const poly of polygons) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % poly.length];
      const w = x0 * y1 - x1 * y0;
      a += w;
      cx += (x0 + x1) * w;
      cy += (y0 + y1) * w;
    }
  }
  return Math.abs(a) > 1e-12 ? [cx / (3 * a), cy / (3 * a)] : null;
}

/**
 * Grid points strictly inside polygons (even-odd), on a grid of `step`
 * centred on their bounding box, sorted by (u, v). Rows are filled by
 * scanline, so large faces stay cheap.
 */
export function gridPoints(polygons, step) {
  const polys = polygons.filter((p) => p.length >= 3);
  if (!polys.length || !(step > 0)) return [];
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
  const nu = Math.floor((maxU - minU) / step) + 1;
  const nv = Math.floor((maxV - minV) / step) + 1;
  const u0 = (minU + maxU) / 2 - ((nu - 1) * step) / 2;
  const v0 = (minV + maxV) / 2 - ((nv - 1) * step) / 2;
  const out = [];
  for (let j = 0; j < nv; j++) {
    const v = v0 + j * step;
    const xs = [];
    for (const poly of polys) {
      for (let i = 0; i < poly.length; i++) {
        const [x0, y0] = poly[i];
        const [x1, y1] = poly[(i + 1) % poly.length];
        if ((y0 <= v && y1 > v) || (y1 <= v && y0 > v)) xs.push(x0 + ((v - y0) / (y1 - y0)) * (x1 - x0));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.floor((xs[k] - u0) / step) + 1);
      const i1 = Math.min(nu - 1, Math.ceil((xs[k + 1] - u0) / step) - 1);
      for (let i = i0; i <= i1; i++) {
        const u = u0 + i * step;
        if (u > xs[k] && u < xs[k + 1]) out.push([u, v]);
      }
    }
  }
  return out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

/**
 * Whether a set of points maps onto itself when turned 180° about `centre`:
 * every p has a q within `tol` of 2·centre − p. A face whose pins are
 * symmetric like that can be glued on the wrong way round.
 */
export function isSymmetric(points, centre, tol) {
  return points.every((p) => points.some((q) => Math.hypot(q[0] + p[0] - 2 * centre[0], q[1] + p[1] - 2 * centre[1]) <= tol));
}

/**
 * Pin centres in a face's safe region, deterministically: candidates on a
 * grid inside `safe`, the first the farthest from the face's centroid, then
 * each next the farthest from those chosen while it stays `sMin` from all
 * of them. When the pins would fit a half-turned face too, the last one is
 * swapped for the candidate that breaks the symmetry and keeps the spacing,
 * the one farthest from the others.
 * @param {number[][][]} safe polygons [[u, v], …] (`CrossSection.toPolygons()`)
 * @param {number} n how many pins are wanted
 * @param {number} sMin the closest two centres may be
 * @param {number[]} centroid the whole face's centroid [u, v]
 * @param {{ d?: number, step?: number }} options `d` the pin diameter (the symmetry tolerance is max(1, d/2)), `step` the grid
 * @returns {number[][]} up to n centres [u, v]; fewer when no more fit
 */
export function chooseCentres(safe, n, sMin, centroid, { d = 0, step = null } = {}) {
  const polys = (safe ?? []).filter((p) => p.length >= 3);
  const area = polygonsArea(polys);
  if (!(area > 0) || !(n >= 1)) return [];
  const cands = gridPoints(polys, step ?? clamp(Math.sqrt(area) / 30, 0.25, 2, 1));
  if (!cands.length) return [];
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  let first = 0;
  for (let i = 1; i < cands.length; i++) if (dist(cands[i], centroid) > dist(cands[first], centroid) + 1e-12) first = i;
  const chosen = [cands[first]];
  const nearest = cands.map((p) => dist(p, cands[first]));
  while (chosen.length < n) {
    let bi = 0;
    for (let i = 1; i < cands.length; i++) if (nearest[i] > nearest[bi] + 1e-12) bi = i;
    if (nearest[bi] < sMin - EPS) break;
    chosen.push(cands[bi]);
    for (let i = 0; i < cands.length; i++) nearest[i] = Math.min(nearest[i], dist(cands[i], cands[bi]));
  }
  const tol = Math.max(1, d / 2);
  if (chosen.length >= 2 && isSymmetric(chosen, centroid, tol)) {
    const others = chosen.slice(0, -1);
    let swap = null;
    let swapDist = -1;
    for (const p of cands) {
      const m = Math.min(...others.map((q) => dist(p, q)));
      if (m < sMin - EPS || m <= swapDist + 1e-12) continue;
      if (isSymmetric([...others, p], centroid, tol)) continue;
      swap = p;
      swapDist = m;
    }
    if (swap) chosen[chosen.length - 1] = swap;
  }
  return chosen.map((p) => [p[0], p[1]]);
}

// ---------- how each piece lies on the bed ----------

const COS45 = Math.SQRT1_2;
const FLAT = 0.999;
/** Less than this much on the bed (mm²) and a piece stands on a point or an edge: it needs supports. */
const STEADY = 25;
/** A model's flat end more than this many times its cut face's area would hang past the face, the piece upside down. */
const SOCKET_END = 1.05;
/** How many slices of a piece along each axis `orientationStats` measures its spread in. */
const BANDS = 16;

/**
 * Widen the band boxes of one axis (`band`: `{ lo, step, boxes }`, four numbers a band, [u0, v0, u1, v1]) with a
 * triangle, given as its corners' positions along the axis (`t`) and across it (`u`, `v`): in each band it crosses,
 * the part of it that lies in that band.
 */
function spreadInBands(band, t, u, v) {
  const { lo, step, boxes } = band;
  const last = boxes.length / 4 - 1;
  const k0 = Math.min(last, Math.max(0, Math.floor((Math.min(t[0], t[1], t[2]) - lo) / step)));
  const k1 = Math.min(last, Math.max(0, Math.floor((Math.max(t[0], t[1], t[2]) - lo) / step)));
  const widen = (k, x, y) => {
    if (x < boxes[4 * k]) boxes[4 * k] = x;
    if (y < boxes[4 * k + 1]) boxes[4 * k + 1] = y;
    if (x > boxes[4 * k + 2]) boxes[4 * k + 2] = x;
    if (y > boxes[4 * k + 3]) boxes[4 * k + 3] = y;
  };
  if (k0 === k1) {
    // most triangles of a fine mesh lie in one slice
    for (let i = 0; i < 3; i++) widen(k0, u[i], v[i]);
    return;
  }
  for (let k = k0; k <= k1; k++) {
    const s0 = k === k0 ? -Infinity : lo + k * step;
    const s1 = k === k1 ? Infinity : lo + (k + 1) * step;
    for (let i = 0; i < 3; i++) {
      if (t[i] >= s0 && t[i] <= s1) widen(k, u[i], v[i]);
      const j = (i + 1) % 3;
      for (const s of [s0, s1]) {
        if (!((t[i] - s) * (t[j] - s) < 0)) continue;
        const f = (s - t[i]) / (t[j] - t[i]);
        widen(k, u[i] + (u[j] - u[i]) * f, v[i] + (v[j] - v[i]) * f);
      }
    }
  }
}

/** Empty band boxes for an axis of a piece from `lo` to `hi`. */
const emptyBands = (lo, hi) => ({
  lo, step: Math.max((hi - lo) / BANDS, EPS), boxes: Array.from({ length: 4 * BANDS }, (_, i) => (i % 4 < 2 ? Infinity : -Infinity)),
});

/** How many of a direction's largest flat faces are paired up when looking for a plate. */
const PLATE_FACES = 32;

/**
 * File a triangle (corners at offsets a, b, c of P) facing along `axis` (`plus`: its positive way) with the flat
 * faces square to that axis (`faces`: by direction, then by position to 0.01 mm), when all of it lies at one position.
 */
function binFace(faces, P, a, b, c, axis, plus, area) {
  const pa = P[a + axis];
  const pb = P[b + axis];
  const pc = P[c + axis];
  if (!(Math.max(pa, pb, pc) - Math.min(pa, pb, pc) <= 0.01)) return;
  const at = (pa + pb + pc) / 3;
  const bin = faces[(plus ? '+' : '-') + AXES[axis]];
  const key = Math.round(at * 100);
  if (!bin.has(key)) bin.set(key, { at, area: 0, box: [Infinity, Infinity, -Infinity, -Infinity] });
  const f = bin.get(key);
  f.area += area;
  for (let i = 0; i < 2; i++) {
    const k = (axis + 1 + i) % 3;
    f.box[i] = Math.min(f.box[i], P[a + k], P[b + k], P[c + k]);
    f.box[2 + i] = Math.max(f.box[2 + i], P[a + k], P[b + k], P[c + k]);
  }
}

/**
 * The box of a whole model and the thin plate across each axis it holds (as `orientationStats` gives them, without
 * the rest), for `baseAxis`: only its flat faces are looked at.
 */
export function modelPlates(vertProperties, numProp, triVerts) {
  const P = vertProperties;
  const T = triVerts;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const faces = Object.fromEntries(DIR_KEYS.map((d) => [d, new Map()]));
  for (let t = 0; t + 2 < T.length; t += 3) {
    const a = T[t] * numProp;
    const b = T[t + 1] * numProp;
    const c = T[t + 2] * numProp;
    for (let k = 0; k < 3; k++) {
      const lo = Math.min(P[a + k], P[b + k], P[c + k]);
      const hi = Math.max(P[a + k], P[b + k], P[c + k]);
      if (lo < min[k]) min[k] = lo;
      if (hi > max[k]) max[k] = hi;
    }
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!(len > 0)) continue;
    let axis = 0;
    for (let k = 1; k < 3; k++) if (Math.abs(n[k]) > Math.abs(n[axis])) axis = k;
    if (!(Math.abs(n[axis]) / len > FLAT)) continue;
    binFace(faces, P, a, b, c, axis, n[axis] > 0, len / 2);
  }
  return { bbox: { min, max }, dims: max.map((v, k) => v - min[k]), plates: [0, 1, 2].map((w) => plateOf(faces, w)) };
}

/**
 * The thin plate across axis w among a piece's flat faces (`faces`: per direction, by position, `{ at, area, box }`,
 * the box across the other two axes in their cyclic order): a face looking down w with one looking up it at most a
 * slab's thickness above, material between them (two faces looking at each other have air between), as much of
 * both as they share, and four times as wide both ways as it is thick. The one with the most area, or null; with
 * the area of the flat faces past it either way that look away from it (`above`, `below`): the tops of what stands
 * on it, or of another plate over it.
 */
function plateOf(faces, w) {
  const largest = (d) => [...faces[d].values()].sort((p, q) => q.area - p.area).slice(0, PLATE_FACES);
  let best = null;
  for (const under of largest(`-${AXES[w]}`)) {
    for (const over of largest(`+${AXES[w]}`)) {
      const t = over.at - under.at;
      if (!(t > 0 && t <= PLATE_THICKNESS.slab)) continue;
      const box = [Math.max(under.box[0], over.box[0]), Math.max(under.box[1], over.box[1]), Math.min(under.box[2], over.box[2]), Math.min(under.box[3], over.box[3])];
      const du = box[2] - box[0];
      const dv = box[3] - box[1];
      if (!(du >= 4 * t && dv >= 4 * t)) continue;
      const area = Math.min(under.area, over.area, du * dv);
      if (!best || area > best.area) best = { t, lo: under.at, hi: over.at, box, area };
    }
  }
  if (!best) return null;
  const past = (d, beyond) => [...faces[d].values()].reduce((sum, f) => sum + (beyond(f.at) ? f.area : 0), 0);
  return { ...best, above: past(`+${AXES[w]}`, (at) => at > best.hi + 0.01), below: past(`-${AXES[w]}`, (at) => at < best.lo - 0.01) };
}

/**
 * What each way down would mean for a piece, from its own mesh: for each of
 * the six directions d, its extent along d, the area that would rest on the
 * bed (facets facing d within 0.1 mm of the piece's extreme along d) and the
 * area of the box that bed spans, the area that would need support (facets
 * facing within 45° of d, not on the bed) and the area of its own cut faces
 * facing d; and for each axis, how far it spreads across the other two in
 * each of 16 slices along it (`bands`) and the thin plate across it, if it
 * holds one (`plates`), for how slender it stands.
 * @param {Float32Array|number[]} vertProperties
 * @param {number} numProp
 * @param {Uint32Array|number[]} triVerts
 * @param {({ axis: number, at: number }|{ position: number[], normal: number[] })[]} cutsOnPiece the cuts this piece touches
 * @param {{ allowed?: string[] }} options `allowed`: the ways down to consider (pieces on a dovetail seam lie flat: ±w only)
 * @returns {{ bbox: { min: number[], max: number[] }, dims: number[], allowed: string[],
 *   dirs: Object<string, { extent: number, bed: number, footprint: number, support: number, cutArea: number,
 *   spread: number[]|null }>, bands: { lo: number, step: number, boxes: number[] }[], plates: ({ t: number, lo: number,
 *   hi: number, box: number[], area: number }|null)[] }} `spread` the box the bed spans across the other two axes, in
 *   their cyclic order ([u0, v0, u1, v1]), null with nothing on the bed; `bands` per axis, from `lo` in slices `step`
 *   long, the box each slice's material spans the same way (four numbers each, empty as [∞, ∞, −∞, −∞]); `plates` per
 *   axis, a plate `t` thick between its faces at `lo` and `hi` along it, spanning `box` across it
 */
export function orientationStats(vertProperties, numProp, triVerts, cutsOnPiece = [], { allowed = DIR_KEYS } = {}) {
  const P = vertProperties;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < P.length; i += numProp) {
    for (let a = 0; a < 3; a++) {
      if (P[i + a] < min[a]) min[a] = P[i + a];
      if (P[i + a] > max[a]) max[a] = P[i + a];
    }
  }
  if (!(min[0] <= max[0])) {
    min.fill(0);
    max.fill(0);
  }
  const dirs = {};
  for (const d of DIR_KEYS) dirs[d] = { extent: max[dirAxis(d)] - min[dirAxis(d)], bed: 0, support: 0, cutArea: 0, footprint: 0 };
  // how far the bed spreads across the other two axes, for each way down: a hollow section stands on a thin ring, but
  // the ring's whole outline keeps it steady
  const spread = Object.fromEntries(DIR_KEYS.map((d) => [d, [Infinity, Infinity, -Infinity, -Infinity]]));
  const planes = cutsOnPiece.map(cutPlane).filter(Boolean);
  const bands = [0, 1, 2].map((k) => emptyBands(min[k], max[k]));
  // the faces square to an axis, by direction and position: a thin plate is two of them, a slab's thickness apart
  const faces = Object.fromEntries(DIR_KEYS.map((d) => [d, new Map()]));
  const along = [0, 0, 0];
  const across = [[0, 0, 0], [0, 0, 0]];
  const T = triVerts;
  for (let t = 0; t + 2 < T.length; t += 3) {
    const a = T[t] * numProp;
    const b = T[t + 1] * numProp;
    const c = T[t + 2] * numProp;
    for (let k = 0; k < 3; k++) {
      const u = (k + 1) % 3;
      const v = (k + 2) % 3;
      along[0] = P[a + k];
      along[1] = P[b + k];
      along[2] = P[c + k];
      across[0][0] = P[a + u];
      across[0][1] = P[b + u];
      across[0][2] = P[c + u];
      across[1][0] = P[a + v];
      across[1][1] = P[b + v];
      across[1][2] = P[c + v];
      spreadInBands(bands[k], along, across[0], across[1]);
    }
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!(len > 0)) continue;
    // a unit normal is within 45° of at most one of the six directions: its largest component's
    let axis = 0;
    for (let k = 1; k < 3; k++) if (Math.abs(n[k]) > Math.abs(n[axis])) axis = k;
    const nd = Math.abs(n[axis]) / len;
    if (!(nd > COS45)) continue;
    const plus = n[axis] > 0;
    const s = dirs[(plus ? '+' : '-') + AXES[axis]];
    const area = len / 2;
    const pa = P[a + axis], pb = P[b + axis], pc = P[c + axis];
    const onBed = plus ? Math.min(pa, pb, pc) >= max[axis] - 0.1 : Math.max(pa, pb, pc) <= min[axis] + 0.1;
    if (nd > FLAT && onBed) {
      s.bed += area;
      const box = spread[(plus ? '+' : '-') + AXES[axis]];
      [(axis + 1) % 3, (axis + 2) % 3].forEach((k, i) => {
        box[i] = Math.min(box[i], P[a + k], P[b + k], P[c + k]);
        box[2 + i] = Math.max(box[2 + i], P[a + k], P[b + k], P[c + k]);
      });
    } else s.support += area;
    if (nd > FLAT && planes.some((p) => p.axis === axis && Math.max(Math.abs(pa - p.at), Math.abs(pb - p.at), Math.abs(pc - p.at)) <= 0.01)) s.cutArea += area;
    binFace(faces, P, a, b, c, axis, plus, area);
  }
  for (const d of DIR_KEYS) {
    const [u0, v0, u1, v1] = spread[d];
    if (u1 > u0 && v1 > v0) dirs[d].footprint = (u1 - u0) * (v1 - v0);
    dirs[d].spread = u1 >= u0 && v1 >= v0 ? spread[d] : null;
  }
  return {
    bbox: { min, max },
    dims: max.map((v, k) => v - min[k]),
    allowed: DIR_KEYS.filter((d) => allowed.includes(d)),
    dirs,
    bands,
    plates: [0, 1, 2].map((w) => plateOf(faces, w)),
  };
}

/**
 * A piece's statistics once loose triangles (9 numbers each) go in its file
 * too: its box and extents take them in, so the piece is turned and judged
 * against the bed as the file will be. They rest on nothing and add no bed.
 */
export function statsWithSoup(stats, soup) {
  if (!soup?.length) return stats;
  const min = [...stats.bbox.min];
  const max = [...stats.bbox.max];
  for (let i = 0; i + 2 < soup.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (soup[i + a] < min[a]) min[a] = soup[i + a];
      if (soup[i + a] > max[a]) max[a] = soup[i + a];
    }
  }
  const dirs = {};
  for (const d of DIR_KEYS) dirs[d] = { ...stats.dirs[d], extent: max[dirAxis(d)] - min[dirAxis(d)] };
  return { ...stats, bbox: { min, max }, dims: max.map((v, k) => v - min[k]), dirs };
}

/** The piece's sides along print x, y and z once `down` is on the bed (before any turn). */
function laidDims(dims, down) {
  const L = LAY_DOWN[down];
  return [0, 1, 2].map((r) => Math.abs(L[r]) * dims[0] + Math.abs(L[4 + r]) * dims[1] + Math.abs(L[8 + r]) * dims[2]);
}

/** What standing `tall` over a base of `base` mm² costs: nothing up to twice the base's side, then fast more. */
const slenderCost = (tall, base) => (tall > 2 ? 50 * (tall - 2) ** 2 * Math.sqrt(base) : 0);

/**
 * How slender a thin plate in a piece (`orientationStats`' `plates`) stands lying `down`, on its edge: a wall as
 * tall as the plate runs up and as thick as it, however far a tower or a figure's foot beside it spreads the bed –
 * when it stands alone (a slice of the piece holds nothing across the plate but the plate) over half its run or
 * more. One held up along most of its run (the strip under a row of letters, the floor of a box between its
 * walls) is no wall.
 */
function wallCost(stats, down) {
  const a = dirAxis(down);
  const band = stats.bands?.[a];
  if (!band || !stats.plates) return 0;
  let worst = 0;
  stats.plates.forEach((plate, w) => {
    if (!plate || w === a) return;
    // the plate's box across w: its run along the way up, and its length along the third axis
    const along = (a - w + 3) % 3 - 1; // 0 when a follows w, 1 when it comes after that
    const [r0, r1] = [plate.box[along], plate.box[2 + along]];
    const length = plate.box[3 - along] - plate.box[1 - along];
    const across = w === (a + 1) % 3 ? 0 : 1; // where w's extent is in a slice's box
    let alone = 0;
    for (let k = 0; k < BANDS; k++) {
      const s0 = Math.max(r0, band.lo + k * band.step);
      const s1 = Math.min(r1, band.lo + (k + 1) * band.step);
      if (s1 > s0 && band.boxes[4 * k + 2 + across] - band.boxes[4 * k + across] <= plate.t + 0.5) alone += s1 - s0;
    }
    if (!(alone >= 0.5 * (r1 - r0))) return;
    const base = plate.t * length;
    worst = Math.max(worst, slenderCost((r1 - r0) / Math.sqrt(base), base));
  });
  return worst;
}

/**
 * Whether lying `down` puts a piece on the face of a thin plate (`orientationStats`' `plates`) that covers at least
 * half of the piece's box that way, resting on it – the only plate it holds: boards joined across one another (the
 * side of a shelf unit and its shelves) lie whichever way needs least.
 */
function onPlate(stats, down) {
  const w = dirAxis(down);
  const plate = stats.plates?.[w];
  if (!plate || stats.plates.filter(Boolean).length > 1 || stats.dirs[down].bed < STEADY) return false;
  const face = down[0] === '-' ? plate.lo <= stats.bbox.min[w] + 0.01 : plate.hi >= stats.bbox.max[w] - 0.01;
  return face && plate.area >= 0.5 * stats.dims[(w + 1) % 3] * stats.dims[(w + 2) % 3];
}

/**
 * What lying `down` costs a piece, lower being better: `need` what printing it that way takes – support, a slender
 * tower, a small footprint – and `score` that plus its mating faces printed upright (weaker, holes horizontal). How
 * slender a piece stands is judged by the box its bed spans: a tube's ring holds it as steady as a block. A thin
 * plate standing on its edge is a wall all the same where something beside it spreads the bed (`wallCost`): a
 * terrain tile's quarter stood on its cut edge rests on the cut through its tower too, but the tile above is 4 mm.
 */
function orientationScore(stats, down) {
  const s = stats.dirs[down];
  const axis = dirAxis(down);
  let cutV = 0;
  for (const d of DIR_KEYS) if (dirAxis(d) !== axis) cutV += stats.dirs[d].cutArea;
  const bed = Math.max(s.bed, s.footprint ?? 0, 1);
  const slender = Math.max(slenderCost(s.extent / Math.sqrt(bed), bed), wallCost(stats, down));
  const unstable = s.bed < STEADY ? 1e4 : 0;
  const need = s.support + slender + unstable;
  return { need, score: need + 0.5 * cutV };
}

/** How a piece lies, for the piece list and the glue sheet. */
function liesOf(stats, down) {
  if (stats.dirs[down].cutArea > 1e-6) return 'on a cut face';
  if (stats.dirs[down].bed < STEADY) return 'on a curve';
  if (down === '-z') return 'flat as modelled';
  return down === '+z' ? 'upside down' : 'on its side';
}

/**
 * The world → print transform of a piece: `down` turned to face the bed,
 * then `yaw` degrees about +z, then the box centred on x = y = 0 with its
 * bottom on z = 0.
 * @param {{ min: number[], max: number[] }} bbox the piece's world bounding box
 * @returns {{ printMatrix: number[], matrix: number[], size: number[] }} `matrix` is the inverse (print → world);
 *   `size` the piece's sides as it lies, before a diagonal turn
 */
export function printTransform(bbox, down = '-z', yaw = 0) {
  const R = mulMat4(yawMat4(yaw), LAY_DOWN[down]);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const p = applyMat4(R, [c & 1 ? bbox.max[0] : bbox.min[0], c & 2 ? bbox.max[1] : bbox.min[1], c & 4 ? bbox.max[2] : bbox.min[2]]);
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], p[a]);
      hi[a] = Math.max(hi[a], p[a]);
    }
  }
  const printMatrix = mulMat4(translationMat4([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]]), R);
  const laid = laidDims(bbox.max.map((v, a) => v - bbox.min[a]), down);
  return { printMatrix, matrix: invertRigid(printMatrix), size: yaw === 90 ? [laid[1], laid[0], laid[2]] : laid };
}

/**
 * How a piece is printed: of the allowed ways down that fit the bed (turned
 * straight, a quarter turn or across the diagonal), those that need about
 * the least support (within 10 % or 25 mm², slender towers and points
 * counted in: `orientationScore`'s `need`); of those, the ones that lay a
 * piece that is mostly a thin plate on it where there are any (`onPlate`):
 * a tile's quarter with rocks on it lies on the tile; and of those the best
 * by score, so a mating face goes down only where that costs next to no
 * support: a gear's quarter lies flat rather than standing on its cut edge
 * with its teeth over supports. Scores within 1 % tie, and then the model's
 * own down wins, then a cut face down, then the lower height, then no turn.
 * `orient: 'cut'` takes the largest cut face that fits and `'model'` the
 * model's own down; if that does not fit, the best way is used with
 * `ORIENT_FALLBACK`. If nothing fits, the best way regardless (`fits:
 * false`, `PIECE_TOO_BIG`). A piece that fits only resting on a point or an
 * edge is told of (`PIECE_UNSTABLE`). A piece of a slab (`flat`, as Fit
 * plans it) lies flat on it whenever it fits that way and has something
 * flat there to rest on.
 * @param {object} stats from `orientationStats`
 * @param {number[]} U the usable bed
 * @param {'auto'|'cut'|'model'} orient
 * @param {{ pieceIndex?: number, flat?: number|null }} options the piece's number, for the notes; `flat` the slab's
 *   thickness axis (`slabAxis`)
 * @returns {{ down: string, up: string, yaw: number, fits: boolean, size: number[], printMatrix: number[], matrix: number[],
 *   lies: 'flat as modelled'|'on a cut face'|'on its side'|'upside down'|'on a curve', score: number, notes: object[] }}
 */
export function chooseOrientation(stats, U, orient = 'auto', { pieceIndex = null, flat = null } = {}) {
  const allowed = (stats.allowed?.length ? stats.allowed : DIR_KEYS).filter((d) => LAY_DOWN[d]);
  const options = allowed.map((down) => {
    const [a, b, h] = laidDims(stats.dims, down);
    const yaw = h <= U[2] + EPS ? footprintYaw(a, b, U) : null;
    return { down, h, yaw, fits: yaw !== null, ...orientationScore(stats, down), cut: stats.dirs[down].cutArea > 1e-6 };
  });
  const order = (o) => DIR_KEYS.indexOf(o.down);
  const pick = (list) => {
    if (!list.length) return null;
    const least = Math.min(...list.map((o) => o.need));
    const near = list.filter((o) => o.need <= least + Math.max(STEADY, 0.1 * least));
    // a piece that is mostly a thin plate lies on it where that needs about as little, its cut faces upright, rather
    // than stand the plate on its cut edge
    const plated = near.filter((o) => onPlate(stats, o.down));
    const pool = plated.length ? plated : near;
    const best = Math.min(...pool.map((o) => o.score));
    const tied = pool.filter((o) => o.score <= best + Math.max(0.01 * Math.abs(best), EPS));
    const rank = (o) => [o.down === '-z' ? 0 : 1, o.cut ? 0 : 1, o.h, o.yaw ? 1 : 0, order(o)];
    return tied.sort((p, q) => {
      const rp = rank(p);
      const rq = rank(q);
      for (let i = 0; i < rp.length; i++) if (rp[i] !== rq[i]) return rp[i] - rq[i];
      return 0;
    })[0];
  };
  const fitting = options.filter((o) => o.fits);
  const forced = orient === 'cut'
    ? options.filter((o) => o.cut).sort((p, q) => stats.dirs[q.down].cutArea - stats.dirs[p.down].cutArea || p.score - q.score || order(p) - order(q))
    : orient === 'model' ? options.filter((o) => o.down === '-z') : null;
  let chosen = forced ? forced.find((o) => o.fits) : null;
  let fallback = Boolean(forced) && !chosen;
  const lyingFlat = flat === null ? [] : fitting.filter((o) => dirAxis(o.down) === flat && stats.dirs[o.down].bed >= STEADY);
  if (!chosen) chosen = pick(forced || !lyingFlat.length ? fitting : lyingFlat);
  const fits = Boolean(chosen);
  if (!chosen) {
    // nothing fits at all: a forced choice is still honoured, and turning it is no use
    fallback = false;
    chosen = forced?.[0] ?? pick(options);
  }
  const yaw = fits ? chosen.yaw : 0;
  const { printMatrix, matrix, size } = printTransform(stats.bbox, chosen.down, yaw);
  const lies = liesOf(stats, chosen.down);
  const notes = [];
  if (fallback) notes.push(splitNote('ORIENT_FALLBACK', { pieceIndex, mode: orient, lies }));
  if (!fits) notes.push(splitNote('PIECE_TOO_BIG', { pieceIndex, size, bed: U }));
  else if (stats.dirs[chosen.down].bed < STEADY) notes.push(splitNote('PIECE_UNSTABLE', { pieceIndex }));
  return { down: chosen.down, up: oppositeDir(chosen.down), yaw, fits, size, printMatrix, matrix, lies, score: chosen.score, notes };
}

/**
 * The statistics of shells printed together in one file, from each one's
 * own (`orientationStats`): their box takes them all in, and for each way
 * down only the shells that reach the bed rest on it – what any other one
 * would rest on is held over the bed, as much in need of support as an
 * overhang. They may lie the ways the shells held to their plate allow (a
 * shell beside a dovetail cut lies flat), or any way when none is.
 * @param {object[]} list `orientationStats` of each shell
 * @returns {object} as `orientationStats` gives for them all
 */
export function mergeStats(list) {
  if (list.length === 1) return list[0];
  const min = [0, 1, 2].map((a) => Math.min(...list.map((s) => s.bbox.min[a])));
  const max = [0, 1, 2].map((a) => Math.max(...list.map((s) => s.bbox.max[a])));
  const dirs = {};
  for (const d of DIR_KEYS) {
    const a = dirAxis(d);
    const out = { extent: max[a] - min[a], bed: 0, support: 0, cutArea: 0, footprint: 0, spread: null };
    for (const s of list) {
      const x = s.dirs[d];
      out.cutArea += x.cutArea;
      if (!reachesBed(s, { bbox: { min, max } }, d)) {
        out.support += x.support + x.bed;
        continue;
      }
      out.bed += x.bed;
      out.support += x.support;
      if (x.spread) out.spread = out.spread ? [0, 1, 2, 3].map((k) => (k < 2 ? Math.min : Math.max)(out.spread[k], x.spread[k])) : [...x.spread];
    }
    if (out.spread && out.spread[2] > out.spread[0] && out.spread[3] > out.spread[1]) out.footprint = (out.spread[2] - out.spread[0]) * (out.spread[3] - out.spread[1]);
    dirs[d] = out;
  }
  const held = list.filter((s) => s.allowed.length < DIR_KEYS.length);
  const allowed = held.length ? DIR_KEYS.filter((d) => held.some((s) => s.allowed.includes(d))) : [...DIR_KEYS];
  // each shell's slices widen every slice of the whole they overlap
  const bands = list.every((s) => s.bands) ? [0, 1, 2].map((a) => {
    const band = emptyBands(min[a], max[a]);
    for (const s of list) {
      const { lo, step, boxes } = s.bands[a];
      for (let k = 0; k < boxes.length / 4; k++) {
        if (!(boxes[4 * k] <= boxes[4 * k + 2])) continue;
        const k0 = Math.max(0, Math.floor((lo + k * step - band.lo) / band.step + 1e-9));
        const k1 = Math.min(BANDS - 1, Math.ceil((lo + (k + 1) * step - band.lo) / band.step - 1e-9) - 1);
        for (let j = k0; j <= k1; j++) {
          for (let i = 0; i < 4; i++) band.boxes[4 * j + i] = (i < 2 ? Math.min : Math.max)(band.boxes[4 * j + i], boxes[4 * k + i]);
        }
      }
    }
    return band;
  }) : undefined;
  // the largest plate of any shell is the piece's
  const plates = list.every((s) => s.plates) ? [0, 1, 2].map((w) => list.map((s) => s.plates[w]).filter(Boolean).sort((p, q) => q.area - p.area)[0] ?? null) : undefined;
  return { bbox: { min, max }, dims: max.map((v, k) => v - min[k]), allowed, dirs, ...(bands ? { bands } : {}), ...(plates ? { plates } : {}) };
}

/** Whether a shell (its stats) reaches the bed when the shells it prints with (their stats) lie with `down` on it. */
const reachesBed = (shell, all, down) => {
  const a = dirAxis(down);
  return down[0] === '-' ? shell.bbox.min[a] <= all.bbox.min[a] + 0.1 : shell.bbox.max[a] >= all.bbox.max[a] - 0.1;
};

/**
 * Which shells of a piece print together: lying its best way, every shell
 * that would not reach the bed is left for another file, and the rest may
 * then lie another way, so they are looked at again until all of them rest
 * on it; what was left is shared out the same way.
 * @param {object[]} list `orientationStats` of each shell
 * @returns {number[][]} indices into `list`, the shells resting the way the piece as a whole lies first
 */
function restingGroups(list, U, orient, flat) {
  const groups = [];
  let left = list.map((_, i) => i);
  while (left.length) {
    let group = left;
    for (;;) {
      const all = mergeStats(group.map((i) => list[i]));
      const { down } = chooseOrientation(all, U, orient, { flat });
      const resting = group.filter((i) => reachesBed(list[i], all, down));
      if (resting.length === group.length) break;
      group = resting; // never empty: some shell reaches the bed
    }
    groups.push(group);
    left = left.filter((i) => !group.includes(i));
  }
  return groups;
}

/**
 * How the pieces of a cut print. Each is turned to lie its best way
 * (`chooseOrientation`), and a file holds only shells that rest on the bed:
 * a box's shells that would be held over it lying that way (the loose
 * shelves of a bookcase, a strip of rail cut off from the rest) are a piece
 * of their own, laid on the bed their own best way and numbered next, with
 * their own labels and glue steps. Unrepaired triangles go in the file of
 * the piece nearest them.
 * @param {{ index: number, cell: number[], shells: number, bbox: object, cuts: string[], stats: object,
 *   parts?: { box: object, volume: number, cuts: string[], stats: object }[] }[]} pieces `cutPieces`' (`parts` each shell
 *   of a piece with more than one)
 * @param {number[]} U the usable bed
 * @param {'auto'|'cut'|'model'} orient
 * @param {{ flat?: number|null, soups?: Map<number, Float32Array>|null }} options `flat` as for `chooseOrientation`; `soups`
 *   the unrepaired triangles that go with each piece of `pieces`, by its number
 * @returns {{ index: number, cell: number[], from: number, parts: number[]|null, shells: number, volume: number,
 *   bbox: object, boxes: object[], cuts: string[], stats: object, soup: Float32Array|null, lying: object }[]} numbered anew:
 *   `from` the piece of `pieces` it comes from, `parts` which of its shells (null for all), `boxes` theirs, `lying` from
 *   `chooseOrientation`
 */
export function layPieces(pieces, U, orient = 'auto', { flat = null, soups = null } = {}) {
  const out = [];
  for (const piece of pieces) {
    const groups = !piece.parts
      ? [{ parts: null, shells: piece.shells, volume: piece.volume, bbox: piece.bbox, boxes: [piece.bbox], cuts: piece.cuts, stats: piece.stats }]
      : restingGroups(piece.parts.map((p) => p.stats), U, orient, flat).map((group, k, all) => {
        const list = group.map((i) => piece.parts[i]);
        const stats = mergeStats(list.map((p) => p.stats));
        const ids = new Set(list.flatMap((p) => p.cuts));
        return {
          parts: all.length > 1 ? group : null,
          shells: list.length,
          volume: list.reduce((s, p) => s + p.volume, 0),
          bbox: stats.bbox,
          boxes: list.map((p) => p.box),
          cuts: piece.cuts.filter((id) => ids.has(id)),
          stats,
        };
      });
    // unrepaired triangles go with the group whose box is nearest their middle
    const soup = soups?.get(piece.index) ?? null;
    let home = groups[0];
    if (soup?.length && groups.length > 1) {
      const c = [0, 1, 2].map((a) => {
        let s = 0;
        for (let i = a; i < soup.length; i += 3) s += soup[i];
        return s / (soup.length / 3);
      });
      const away = (g) => Math.hypot(...c.map((v, a) => Math.max(0, g.bbox.min[a] - v, v - g.bbox.max[a])));
      home = groups.reduce((best, g) => (away(g) < away(best) ? g : best));
    }
    for (const g of groups) {
      const index = out.length + 1;
      const own = g === home ? soup : null;
      const stats = statsWithSoup(g.stats, own);
      out.push({ ...g, index, cell: piece.cell, from: piece.index, stats, soup: own, lying: chooseOrientation(stats, U, orient, { pieceIndex: index, flat }) });
    }
  }
  return out;
}

/**
 * Which piece of each pair across a cut with built-in pegs carries them
 * (the male; the other gets the sockets), for every pair at once: one piece
 * of each face pair carries all of that face's pegs, and as they stand out
 * of its face it may not lie on it; nor may it be the one across from a
 * piece with no room for their sockets (`sockets`): a plate under a thick
 * top carries the pegs, standing up, and the top takes the sockets. Pair by
 * pair, in the order given, from the way each piece lies with no pegs
 * (`layPieces`): when only one of the two may carry them, it does, as long
 * as it then lies about as well as it does without them – it fits as well,
 * on at least half as much of the bed, needing support under no more than a
 * tenth of that more (a plaque's base lies on its underside, letters
 * engraved in it bridged) – else neither: a lid with a knob is glued rather
 * than stood on its edge, and so is the second face of a plate between two
 * cuts, which lies on the first; when one of the two lies on that face, the
 * other carries them; when both do, the one whose best way down without
 * that face costs the least more (`chooseOrientation`'s score, its pegs
 * counted in its size, a way that does not fit counting as no way), which
 * lies that way from then on, for the pairs that follow; when neither does,
 * the one that prints its pegs lying down (strong across the layers) over
 * one that prints them pointing up; ties going to the one across from more
 * room for the sockets (`prefer`), then to the lower-numbered. The one
 * across from more room also carries them wherever it prints about as well
 * as the other would – carrying them costs it no more than `STEADY` more
 * than it costs the other, and its pegs lie down if the other's would: a
 * box's 8 mm lid lies on its top carrying them, so the sockets go deep into
 * the walls. Whichever that is, when the pegs would push it off the bed and
 * the other piece may carry them and still fits with them, the other one
 * does: a piece near the bed's size never gets pegs it has no room for.
 * Then a piece left with every good way to lie pegged – fitting, and
 * needing about as little as its best
 * (`orientationScore`'s need), as the corner of a ball cut in eight is once
 * each of its three cut faces is taken in turn – hands the pegs of one of
 * those faces to the pieces across it, as long as they keep a good way of
 * their own, or can be given one the same way, and still fit; and one that
 * the pegs of all its faces push off the bed hands those of a face to the
 * pieces across it when then they all fit – never pegs that a piece across
 * may not carry: a plate too thin for sockets keeps its pegs, lying on its
 * underside, though it lies best on its cut face. A piece of several shells
 * only lies where every one of them rests on the bed, as `layPieces` laid
 * it, and one left with no way down at all never carries them. A piece a
 * take-apart cut's lip stands out of (`forced`, `apartMales`) lies the one way
 * that keeps the lip standing up, its box taking the lip in, and is judged
 * that way: it never carries pegs on the face it lies on.
 * Deterministic.
 * @param {{ index: number, stats: object, boxes?: object[], lying: { down: string, score: number, fits: boolean } }[]} given
 *   from `layPieces` (`boxes` its shells')
 * @param {number[]} U the usable bed
 * @param {'auto'|'cut'|'model'} orient
 * @param {{ flat?: number|null, length?: number, forced?: Map<number, string>|null }} options `flat` as for
 *   `chooseOrientation`; `length` how far the pegs will stand out (`pegAllowance`), for whether a piece carrying them
 *   still fits; `forced` the way down of each piece a lip stands out of, by its number
 * @returns {(pairs: { axis: number, lo: number, hi: number, sockets?: boolean[], prefer?: 0|1|null }[], length?: number)
 *   => (0|1|null)[]} for each pair (the cut's axis, the numbers of the pieces below and above it, whether each of them
 *   has room for the sockets, [below, above], both when not given, and which would rather carry them, its neighbour
 *   having more room for the sockets) 0 when the piece below carries the pegs, 1 the one above, null neither; `length`
 *   the pegs' own, once their size is known
 */
export function pegMales(given, U, orient = 'auto', { flat = null, length = 0, forced = null } = {}) {
  const laid = forced?.size ? given.map((p) => (forced.has(p.index) ? lipForced(p, forced.get(p.index), U, orient, flat) : p)) : given;
  const byIndex = new Map(laid.map((p) => [p.index, p]));
  const cost = (o) => (o ? (o.fits ? 0 : 1e9) + o.score : Infinity);
  // a piece with pegs standing `along` out of these faces of it
  const grown = (stats, faces, along) => {
    const min = [...stats.bbox.min];
    const max = [...stats.bbox.max];
    for (const d of faces) {
      if (d[0] === '+') max[dirAxis(d)] += along;
      else min[dirAxis(d)] -= along;
    }
    const dirs = Object.fromEntries(DIR_KEYS.map((d) => [d, { ...stats.dirs[d], extent: max[dirAxis(d)] - min[dirAxis(d)] }]));
    return { ...stats, bbox: { min, max }, dims: max.map((v, k) => v - min[k]), dirs };
  };
  // each piece's good ways to lie: those that fit, with every shell on the bed, and need about as little as the least
  // (as `chooseOrientation`)
  const goodWays = new Map(laid.map((p) => {
    const ways = (restingOnly(p.stats, p.boxes)?.allowed ?? []).filter((d) => {
      const [a, b, h] = laidDims(p.stats.dims, d);
      return h <= U[2] + EPS && footprintYaw(a, b, U) !== null;
    }).map((d) => ({ d, need: orientationScore(p.stats, d).need }));
    const least = Math.min(...ways.map((x) => x.need));
    return [p.index, ways.filter((x) => x.need <= least + Math.max(STEADY, 0.1 * least)).map((x) => x.d)];
  }));
  return (pairs, along = length) => {
    // how a piece lies with pegs standing out of these faces: never on them, and with every shell on the bed; null
    // when it has no way down left. With what that way needs and how much of it rests on the bed
    const lay = (p, faces) => {
      const off = offFaces(p.stats, faces);
      const stats = off && restingOnly(along > 0 ? grown(off, faces, along) : off, p.boxes);
      if (!stats) return null;
      const o = chooseOrientation(stats, U, orient, { pieceIndex: p.index, flat });
      return { ...o, need: orientationScore(stats, o.down).need, bed: stats.dirs[o.down].bed };
    };
    // whether a piece lies about as well this way as it does with no pegs: fitting as well, on at least half as much of
    // the bed, needing support under no more than a tenth of that more
    const asWell = (p, o) => {
      const { bed } = p.stats.dirs[p.lying.down];
      return (o.fits || !p.lying.fits) && o.bed >= 0.5 * bed && o.need <= orientationScore(p.stats, p.lying.down).need + Math.max(STEADY, 0.1 * bed);
    };
    const down = new Map(laid.map((p) => [p.index, p.lying.down]));
    const banned = new Map(laid.map((p) => [p.index, new Set()]));
    const best = (p, extra) => lay(p, new Set([...banned.get(p.index), ...extra]));
    const faceOf = (pair, k) => `${k === 0 ? '+' : '-'}${AXES[pair.axis]}`;
    const pieceOf = (pair, k) => (k === 0 ? pair.lo : pair.hi);
    // a piece may carry a pair's pegs only when the other one has room for their sockets
    const may = (pair, k) => pair.sockets?.[1 - k] !== false;
    const males = pairs.map((pair) => {
      const pieces = [byIndex.get(pair.lo), byIndex.get(pair.hi)];
      if (!pieces[0] || !pieces[1] || (!may(pair, 0) && !may(pair, 1))) return null;
      // the face each one's pegs would stand out of: the top of the piece below the cut, the bottom of the one above
      const face = [faceOf(pair, 0), faceOf(pair, 1)];
      const onFace = [0, 1].map((k) => down.get(pieces[k].index) === face[k]);
      const after = [0, 1].map((k) => best(pieces[k], [face[k]]));
      // the one across from more room for the sockets, where both have some
      const prefer = may(pair, 0) && may(pair, 1) ? pair.prefer ?? null : null;
      const tie = () => prefer ?? (pieces[0].index <= pieces[1].index ? 0 : 1);
      // what carrying them costs each more than its best way down now; and whether its pegs then lie along the bed
      const extra = (k) => cost(after[k]) - cost(best(pieces[k], []));
      const alongBed = (k) => Boolean(after[k]) && dirAxis(after[k].down) !== pair.axis;
      let male;
      if (onFace[0] !== onFace[1]) male = onFace[0] ? 1 : 0;
      else if (onFace[0]) {
        const more = [extra(0), extra(1)];
        male = Math.abs(more[0] - more[1]) > 1e-6 * Math.max(1, Math.abs(more[0])) ? (more[0] < more[1] ? 0 : 1) : tie();
      } else {
        const lying = [0, 1].map((k) => dirAxis(down.get(pieces[k].index)) !== pair.axis);
        male = lying[0] !== lying[1] ? (lying[0] ? 0 : 1) : tie();
      }
      // deeper sockets win wherever the piece across from them prints about as well carrying the pegs
      if (prefer !== null && male !== prefer && after[prefer] && extra(prefer) <= extra(male) + STEADY && (alongBed(prefer) || !alongBed(male))) male = prefer;
      // pegs that would push their piece off the bed go on the other one when it still fits with them
      if (after[male] && !after[male].fits && after[1 - male]?.fits && may(pair, 1 - male)) male = 1 - male;
      if (!after[male] || !may(pair, male)) male = 1 - male;
      if (!after[male] || !may(pair, male)) return null;
      // one that must carry them, its neighbour having no room for sockets, does so only lying about as well as without
      if (!may(pair, 1 - male) && !asWell(pieces[male], after[male])) return null;
      banned.get(pieces[male].index).add(face[male]);
      if (down.get(pieces[male].index) === face[male]) down.set(pieces[male].index, after[male].down);
      return male;
    });
    const pegged = (index) => new Set(pairs.flatMap((pair, i) => (males[i] !== null && pieceOf(pair, males[i]) === index ? [faceOf(pair, males[i])] : [])));
    // whether a piece still fits with the pegs it has now, as far as it did with none
    const fitsNow = (q) => {
      const o = lay(byIndex.get(q), pegged(q));
      return Boolean(o) && (o.fits || !byIndex.get(q).lying.fits);
    };
    // the pairs whose pegs stand out of a face of a piece, handed to the pieces across it: undone, and false, unless
    // `keep` holds of those pieces. Never to one across from a piece with no room for their sockets
    const hand = (index, d, keep) => {
      const mine = pairs.flatMap((pair, i) => (males[i] !== null && pieceOf(pair, males[i]) === index && faceOf(pair, males[i]) === d ? [i] : []));
      if (!mine.length || mine.some((i) => !may(pairs[i], 1 - males[i]))) return false;
      const flip = () => mine.forEach((i) => {
        males[i] = 1 - males[i];
      });
      flip();
      if (keep([...new Set(mine.map((i) => pieceOf(pairs[i], males[i])))])) return true;
      flip();
      return false;
    };
    // no piece is left with every good way pegged: one of its faces goes to the pieces across it, if they can spare it
    const stuck = (index) => {
      const ways = goodWays.get(index) ?? [];
      const faces = pegged(index);
      return ways.length > 0 && ways.every((d) => faces.has(d));
    };
    const free = (index, seen) => goodWays.get(index).some((d) => hand(index, d, (others) => others.every((q) => !seen.has(q) && fitsNow(q) && (!stuck(q) || free(q, new Set([...seen, q]))))));
    for (const p of laid) if (stuck(p.index)) free(p.index, new Set([p.index]));
    // nor pushed off the bed by its pegs, when the pieces across one of its faces can carry that face's and still fit
    for (const p of laid) {
      if (fitsNow(p.index)) continue;
      [...pegged(p.index)].some((d) => hand(p.index, d, (others) => fitsNow(p.index) && others.every(fitsNow)));
    }
    return males;
  };
}

/**
 * A laid piece (`layPieces`) with a take-apart cut's lip standing out of the
 * face across from `down`: its statistics take the lip in and allow only that
 * way down, and it lies so.
 */
function lipForced(p, down, U, orient, flat) {
  const grown = lipGrown(p.stats, oppositeDir(down), LIP_ALLOWANCE);
  const stats = restingOnly(grown, p.boxes) ?? grown;
  return { ...p, stats, lying: chooseOrientation(stats, U, orient, { pieceIndex: p.index, flat }) };
}

/**
 * A piece's statistics held to the ways down on which every one of its
 * shells (`boxes`, each one's box) rests on the bed, as `layPieces` lays a
 * piece of several: null when there is no such way. One shell rests any way.
 */
function restingOnly(stats, boxes) {
  if (!boxes || boxes.length < 2) return stats;
  const allowed = (stats.allowed?.length ? stats.allowed : DIR_KEYS).filter((d) => boxes.every((b) => reachesBed({ bbox: b }, stats, d)));
  return allowed.length ? { ...stats, allowed } : null;
}

/**
 * A piece's statistics with the faces its built-in pegs stand out of (by
 * direction) taken off the ways it may lie, and off the mating faces it
 * would rather not print upright: upright, they print their pegs lying
 * along the layers, the strong way. Null when no way down is left.
 */
function offFaces(stats, faces) {
  const allowed = stats.allowed.filter((d) => !faces.has(d));
  if (!allowed.length) return null;
  const dirs = { ...stats.dirs };
  for (const d of faces) dirs[d] = { ...dirs[d], cutArea: 0 };
  return { ...stats, allowed, dirs };
}

/**
 * A piece's statistics once the built-in pegs it carries stand out of its
 * faces: its box takes them in (half a diagonal either side of each centre
 * across the cut, its length out of the face along it), so it is turned and
 * judged against the bed as its file will be, and it may no longer lie on a
 * face they stand out of, which it would as soon print upright (`offFaces`).
 * They rest on nothing and add no bed.
 * @param {object} stats `orientationStats` of the piece (or `mergeStats`)
 * @param {{ axis: number, at: number, centre: number[], s: number, length: number, dir: number }[]} pegs `dir` the way
 *   they point along the cut's axis (±1)
 * @returns {object} as `orientationStats` gives
 */
export function statsWithPegs(stats, pegs) {
  if (!pegs?.length) return stats;
  const min = [...stats.bbox.min];
  const max = [...stats.bbox.max];
  const faces = new Set();
  for (const p of pegs) {
    const r = p.s / Math.SQRT2;
    for (let a = 0; a < 3; a++) {
      const ends = a === p.axis ? [p.at, p.at + p.dir * p.length] : [p.centre[a] - r, p.centre[a] + r];
      min[a] = Math.min(min[a], ...ends);
      max[a] = Math.max(max[a], ...ends);
    }
    faces.add(`${p.dir > 0 ? '+' : '-'}${AXES[p.axis]}`);
  }
  const dirs = {};
  for (const d of DIR_KEYS) dirs[d] = { ...stats.dirs[d], extent: max[dirAxis(d)] - min[dirAxis(d)] };
  const grown = { ...stats, bbox: { min, max }, dims: max.map((v, k) => v - min[k]), dirs };
  return offFaces(grown, faces) ?? grown;
}

/** A piece's statistics with its box grown H past its face `face` (a lip standing out of it), lying only face up. */
function lipGrown(stats, face, H) {
  const a = dirAxis(face);
  const min = [...stats.bbox.min];
  const max = [...stats.bbox.max];
  if (face[0] === '+') max[a] += H;
  else min[a] -= H;
  const dirs = {};
  for (const d of DIR_KEYS) dirs[d] = { ...stats.dirs[d], extent: max[dirAxis(d)] - min[dirAxis(d)] };
  return { ...stats, bbox: { min, max }, dims: max.map((v, k) => v - min[k]), dirs, allowed: [oppositeDir(face)] };
}

/**
 * A piece's statistics once a take-apart cut's lip stands `H` mm out of its
 * face `face` (the direction it looks out of the piece, '+z' for the top of a
 * piece below a Z cut): its box takes the lip in, and it may lie only on the
 * face across from it, the lip standing up – lying any other way, the lip's
 * band would be an overhang as tall as the lip. They rest on nothing and add
 * no bed. Null when the piece may not lie that way (one beside a dovetail
 * seam lies flat) or not every one of its shells (`boxes`) would rest on the
 * bed lying so.
 * @param {object} stats `orientationStats` of the piece (or `mergeStats`)
 * @returns {object|null} as `orientationStats` gives, `allowed` the one way down
 */
export function statsWithLip(stats, face, H = LIP_ALLOWANCE, boxes = null) {
  if (!(stats.allowed?.length ? stats.allowed : DIR_KEYS).includes(oppositeDir(face))) return null;
  return restingOnly(lipGrown(stats, face, H), boxes);
}

/**
 * Which piece of each pair across a cut that comes apart carries its lip
 * (the male; the other gets the groove), for every pair at once. The lip is
 * a band standing out of the male's face, so the male lies on the face
 * across from it, the lip standing up: on its side the band would be an
 * overhang, and upside down the lip would be on the bed. Of the two pieces,
 * each judged lying that way with the lip in its box (`statsWithLip`), only
 * one that has a way to lie so – every shell on the bed, fitting the bed if
 * it fitted without the lip – and a lip the faces' plans give it (`quality`)
 * may carry it. Of those, first one that prints about as well as without the
 * lip (`pegMales`' rule: fitting as well, on at least half as much of the
 * bed, needing support under no more than a tenth of that more), then the
 * better lip (one at all, one with clips, the taller, more clips, more
 * tongue), then the one needing the least more support, then the one below
 * the cut. A lantern's body carries its top's lip, standing on its foot as
 * it would anyway, rather than the top standing on its handle; a box with an
 * 8 mm lid gives the lid the lip, since there both print as well and only
 * the box has room for a 6 mm groove with clips. When the one chosen so
 * prints worse with the lip and the other would print as well with it but
 * has no room for it – no room past the cut for the groove (a lantern cut
 * just under its roof's eaves), or too tall for the bed with the lip
 * standing up – that one is named too (`alt`), so the cut can be moved to
 * where it can carry it. Pair by pair in the order given: a piece once given
 * a way down keeps it, as one given in `given` (by an earlier cut's lips)
 * does, so a pair whose lip would need it another way goes to the other
 * piece, or has no lip. A lip that would get no clips may take the collar
 * twist-lock in their place (`quality.twist`), which counts as clips do –
 * but only where the other piece, whose socket it is, may lie on its cut
 * face and prints as well so as it does anyway, the way a lid that comes
 * off lies: that piece is then given its way down too (`twist` on the
 * answer).
 * @param {{ index: number, stats: object, boxes?: object[], lying: { down: string, fits: boolean } }[]} laid from
 *   `layPieces`
 * @param {number[]} U the usable bed
 * @param {'auto'|'cut'|'model'} orient
 * @param {{ flat?: number|null }} options `flat` as for `chooseOrientation`
 * @returns {(pairs: { axis: number, lo: number, hi: number, quality?: ({ H: number, clips: number, area: number, twist?: boolean }|null)[] }[],
 *   given?: Map<number, string>|null) => ({ male: 0|1, piece: number, down: string, twist?: true, alt?: { k: 0|1, piece: number,
 *   down: string, why: 'room'|'tall', over?: number } }|null)[]} for each pair (the cut's axis, the numbers of the pieces
 *   below and above it, and the lip each would carry, [below, above], from the faces' plans: its height, clips and
 *   tongue area, null for none; any lip when not given) the one that carries the lip – 0 the one below the cut, 1 the
 *   one above – its number and the way it lies, with `alt` the piece that would print as well carrying it and why it
 *   cannot here (`over` how much too tall it would be, mm); null when neither may. `given` the ways down pieces were
 *   given already
 */
export function apartMales(laid, U, orient = 'auto', { flat = null } = {}) {
  const byIndex = new Map(laid.map((p) => [p.index, p]));
  const near = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  // the lip a piece would carry, best first when compared in order: one at all, with clips or the twist-lock in their
  // place, height, clips, tongue
  const rank = (q) => (q ? [1, q.clips > 0 || q.twist ? 1 : 0, q.H, q.clips ?? 0, q.area ?? 0] : [0, 0, 0, 0, 0]);
  /** How a piece prints lying down `down`, against how it prints anyway: whether it may, fits as it did and does as well. */
  const lyingAs = (p, stats, down) => {
    const o = chooseOrientation(stats, U, orient, { pieceIndex: p.index, flat });
    const bed = p.stats.dirs[p.lying.down].bed;
    const was = orientationScore(p.stats, p.lying.down).need;
    const need = orientationScore(stats, o.down).need;
    return { o, fits: o.fits || !p.lying.fits, asWell: stats.dirs[o.down].bed >= 0.5 * bed && need <= was + Math.max(STEADY, 0.1 * bed), extra: need - was };
  };
  /** Whether the piece a twist-lock's socket is cut into may lie on its cut face (`down`), printing as well so. */
  const socketLies = (p, down, forced) => {
    if (forced.has(p.index) && forced.get(p.index) !== down) return false;
    if (!(p.stats.allowed?.length ? p.stats.allowed : DIR_KEYS).includes(down)) return false;
    const stats = restingOnly({ ...p.stats, allowed: [down] }, p.boxes);
    if (!stats) return false;
    const { fits, asWell } = lyingAs(p, stats, down);
    return fits && asWell;
  };
  const better = (x, y) => {
    if (x.asWell !== y.asWell) return x.asWell ? -1 : 1;
    const [rx, ry] = [rank(x.quality), rank(y.quality)];
    for (let i = 0; i < rx.length; i++) if (!near(rx[i], ry[i])) return ry[i] - rx[i];
    if (!near(x.extra, y.extra)) return x.extra - y.extra;
    return x.k - y.k;
  };
  return (pairs, given = null) => {
    const forced = new Map(given ?? []);
    return pairs.map((pair) => {
      const pieces = [byIndex.get(pair.lo), byIndex.get(pair.hi)];
      if (!pieces[0] || !pieces[1]) return null;
      let tall = null; // a piece that would print as well carrying the lip but for the bed's height
      const options = [0, 1].flatMap((k) => {
        const quality = pair.quality ? pair.quality[k] ?? null : undefined;
        const offered = quality === undefined || quality?.H > 0 || Boolean(quality?.twist);
        const p = pieces[k];
        // the face the lip stands out of: the top of the piece below the cut, the bottom of the one above
        const face = `${k === 0 ? '+' : '-'}${AXES[pair.axis]}`;
        const down = oppositeDir(face);
        if (forced.has(p.index) && forced.get(p.index) !== down) return [];
        const stats = statsWithLip(p.stats, face, LIP_ALLOWANCE, p.boxes);
        if (!stats) return [];
        const { o, asWell, extra } = lyingAs(p, stats, down);
        if (!o.fits && p.lying.fits) {
          // only its height is in the way: lower by `over`, it would stand on the bed with the lip
          const [a, b, h] = laidDims(stats.dims, down);
          if (offered && asWell && footprintYaw(a, b, U) !== null) tall = { k, piece: p.index, down, why: 'tall', over: round6(h - U[2]) };
          return [];
        }
        // the twist-lock counts only where the other piece may lie on its cut face for its socket; without it, the lip
        // it would have had, if any
        const twist = Boolean(quality?.twist) && socketLies(pieces[1 - k], o.down, forced);
        const own = quality?.twist && !twist ? { ...quality, twist: false } : quality ?? null;
        const lip = quality === undefined || own?.H > 0 || twist;
        return [{ k, piece: p.index, down: o.down, asWell, lip, quality: own, extra, twist }];
      });
      const lipped = options.filter((o) => o.lip).sort(better);
      if (!lipped.length) return null;
      const best = lipped[0];
      forced.set(best.piece, best.down);
      if (best.twist) forced.set(pieces[1 - best.k].index, best.down);
      // one that prints worse with the lip, where the other would print as well with it given room
      const room = !best.asWell && options.find((o) => !o.lip && o.asWell);
      const alt = room ? { k: room.k, piece: room.piece, down: room.down, why: 'room' } : !best.asWell ? tall : null;
      return { male: best.k, piece: best.piece, down: best.down, ...(best.twist ? { twist: true } : {}), ...(alt ? { alt } : {}) };
    });
  };
}

/**
 * Which side of each cut that comes apart its lip will go on, as far as the
 * pieces themselves tell before their faces are planned (the measure's
 * piece sizes count the lip there): `apartMales`' choice, each piece's lip
 * judged by the room it leaves the other piece's groove – that piece's
 * length past the cut, at least the reach a lip of that height needs
 * (`lipReach`). A box's 8 mm lid would leave the box a 4.5 mm lip with no
 * clips, so the lid carries a full one, as the pieces will have it. Without
 * the pieces (`laid` null) the boxes between the cuts stand in for them,
 * and only the room decides: the better lip, the one below on a tie.
 * @param {object[]|null} laid from `layPieces`
 * @param {{ id: string, axis: number, at: number, apart?: { hold: string } }[]} cuts normalised
 * @param {number[]|null} U the usable bed
 * @param {'auto'|'cut'|'model'} orient
 * @param {{ flat?: number|null, clearance?: number, nozzle?: number, bounds?: { min: number[], max: number[] } }} options
 *   `bounds` the model's, for the boxes
 * @returns {Map<string, 0|1|null>} by cut id: 0 the piece below carries it, 1 the one above, null neither
 */
export function lipSides(laid, cuts, U, orient = 'auto', { flat = null, clearance = SPLIT_DEFAULTS.clearance, nozzle = 0.4, bounds = null } = {}) {
  const by = axisCuts(cuts);
  const choose = laid && U ? apartMales(laid, U, orient, { flat }) : null;
  const out = new Map();
  const touches = (v, at) => Math.abs(v - at) < CUT_TOLERANCE;
  const rank = (q) => (q ? [1, q.clips, q.H] : [0, 0, 0]);
  for (const cut of cuts.filter((x) => x.apart)) {
    const a = cut.axis;
    const j = by[a].indexOf(cut.at);
    const caught = catchSizes(cut.apart.hold, clearance);
    // the tallest lip whose groove the other piece has the length for
    const lipIn = (length) => {
      const H = LIP.heights.find((h) => lipReach(h, 'opening', clearance, 0, false, nozzle).reach <= length + 1e-9);
      return H ? { H, clips: H >= LIP.heights[0] && caught ? 1 : 0, area: 0 } : null;
    };
    if (!choose) {
      if (!bounds) continue;
      const along = [bounds.min[a], ...by[a], bounds.max[a]];
      const q = [lipIn(along[j + 2] - cut.at), lipIn(cut.at - along[j])];
      const [r0, r1] = q.map(rank);
      const n = r0.findIndex((x, i) => x !== r1[i]);
      out.set(cut.id, !q[0] && !q[1] ? null : n < 0 || r0[n] > r1[n] ? 0 : 1);
      continue;
    }
    const same = (p, q) => [0, 1, 2].every((n) => n === a || p.cell[n] === q.cell[n]);
    const lo = laid.filter((p) => p.cell[a] === j && touches(p.stats.bbox.max[a], cut.at));
    const hi = laid.filter((p) => p.cell[a] === j + 1 && touches(p.stats.bbox.min[a], cut.at));
    const pairs = lo.flatMap((p) => hi.filter((q) => same(p, q)).map((q) => ({
      axis: a, lo: p.index, hi: q.index, quality: [lipIn(q.stats.bbox.max[a] - cut.at), lipIn(cut.at - p.stats.bbox.min[a])],
    })));
    const chosen = choose(pairs).filter(Boolean);
    out.set(cut.id, chosen.length ? chosen[0].male : null);
  }
  return out;
}

// ---------- where a cut that comes apart goes ----------

/**
 * How the places for a cut that comes apart are found. A seam is where the
 * outline moves `sharp` mm or more between two samples, `peak` times what it
 * moves between the samples either side (a slope creeps on steadily), or
 * where its islands or holes change; narrowed down to `tolerance` mm, it must
 * still move `least` mm there (a slope's creep has gone by then), or `touch`
 * mm where islands or holes change (two that only touch move nothing). A
 * bend is where straight sides – the outline moving less than `steady` mm per
 * mm – give way to a slope moving `bend` mm per mm or more, or a slope to
 * straight sides: a roof flush with its walls, a jar's shoulder; where the
 * outline narrows and widens again within `groove` mm, a groove (round a
 * lid). How well a seam hides a cut is read from the outline seen from
 * outside with openings narrower than twice `bridge` mm bridged over: the
 * tips of a row of narrow windows are no line the outside shows, however far
 * the slice's own outline moves there. A spot is looked for within `look` mm
 * of a seam, on the 0.5 mm steps the move suggestions take (`step`); spots
 * are `apart` mm apart at least, at most `most` of them, and each scores more
 * than `floor`. A cut being placed snaps to a target within `snap` mm, or the
 * caller's tolerance when larger (a few pixels on screen).
 */
export const SPOT = Object.freeze({
  sharp: 0.5, peak: 1.25, tolerance: 0.002, least: 0.25, touch: 0.01, steady: 0.1, bend: 0.25, groove: 6, bridge: 8, look: 20, step: 0.5, apart: 8, most: 5,
  floor: 0, snap: 3,
});

/**
 * Where seams may lie along a profile of slices: between two samples where
 * the outline moves at once – at least `sharp`, and `peak` times what it
 * moves between the samples either side, so the steady creep of a roof's slope
 * is none, though a step at its foot is; or both intervals of a band two
 * intervals long that moves that much more than the samples round it (a
 * groove round a lid holding one sample: in and out of it the outline moves
 * alike) – or where the slice gains or loses islands or holes. Each is then
 * narrowed down (`locateSeam`), which tells a step from a slope for good.
 * And where straight sides give way to a slope or a slope to straight sides
 * (`by` 'bend', `straight` the side that is straight): an interval that moves
 * between one that hardly does and one that moves as a slope does, a step
 * apart from the step seams' own intervals; narrowed down by `locateBend`.
 * @param {{ t: number, islands: number, holes: number, shift: number }[]} profile the samples in order along the
 *   axis, `shift` how far the outline moves from each to the next (mm: the area the two slices do not share over
 *   their mean perimeter)
 * @returns {{ lo: number, hi: number, by: 'count'|'shift'|'bend', straight?: -1|1 }[]} the samples a seam lies
 *   between, and what showed it
 */
export function profileSeams(profile, { sharp = SPOT.sharp, peak = SPOT.peak, steady = SPOT.steady, bend = SPOT.bend } = {}) {
  const out = [];
  const n = profile.length - 1; // intervals
  const shift = (i) => (i >= 0 && i < n ? profile[i].shift : 0);
  const rate = (i) => shift(i) / Math.max(1e-9, profile[i + 1].t - profile[i].t);
  const moving = (i) => i >= 0 && i < n && shift(i) >= sharp;
  // a run of exactly two moving intervals, j and j + 1, that the samples round it hardly move beside
  const band = (j) => moving(j) && moving(j + 1) && !moving(j - 1) && !moving(j + 2) && peak * Math.max(shift(j - 1), shift(j + 2)) <= Math.min(shift(j), shift(j + 1));
  const stepped = new Set();
  for (let i = 0; i < n; i++) {
    const p = profile[i];
    const q = profile[i + 1];
    const around = Math.max(shift(i - 1), shift(i + 1));
    if (p.islands !== q.islands || p.holes !== q.holes) out.push({ lo: p.t, hi: q.t, by: 'count' });
    else if (moving(i) && (p.shift >= peak * around || band(i - 1) || band(i))) out.push({ lo: p.t, hi: q.t, by: 'shift' });
    else continue;
    stepped.add(i);
  }
  for (let j = 1; j + 1 < n; j++) {
    if (stepped.has(j)) continue; // a step at a slope's foot is a seam already
    // straight sides, then a slope: the bend in interval j or at its ends, the sample before it on the straight sides
    if (rate(j - 1) < steady && rate(j) >= steady && rate(j + 1) >= bend) out.push({ lo: profile[j - 1].t, hi: profile[j + 1].t, by: 'bend', straight: -1 });
    // a slope, then straight sides
    if (rate(j + 1) < steady && rate(j) >= steady && rate(j - 1) >= bend) out.push({ lo: profile[j].t, hi: profile[j + 2].t, by: 'bend', straight: 1 });
  }
  return out;
}

/**
 * A bend narrowed down between `lo` and `hi`: where the outline first moves
 * from the straight end (`straight` −1 the sides are straight towards −axis),
 * found by halving to within `tolerance` – the outline having moved no more
 * than `still` mm there, the slices' own noise – and then checked over a
 * `step` either side, a hair (`gap`) away from it so that a step in the same
 * place (a roof's inside a little in from the walls' inside) is left out:
 * the straight side moving under `steady` mm per mm and the slope `bend` or
 * more. A curve that turns gradually, as a dome does from its rim, is no
 * bend.
 * @param {number} lo
 * @param {number} hi
 * @param {{ shift: (a: number, b: number) => number, straight?: -1|1 }} how as for `locateSeam`
 * @returns {{ at: number, shift: number }|null} `shift` how much further the slope moves the outline than straight
 *   sides would over 3 mm, which `spotScore` reads as a step's
 */
export function locateBend(lo, hi, { shift, straight = -1, tolerance = SPOT.tolerance, steady = SPOT.steady, bend = SPOT.bend, step = SPOT.step, still = 0.02, gap = 0.05 }) {
  const from = straight < 0 ? lo : hi;
  let a = lo;
  let b = hi;
  while (b - a > tolerance) {
    const m = (a + b) / 2;
    const flat = (straight < 0 ? shift(from, m) : shift(m, from)) <= still;
    // still straight at m: the bend is past it, towards the slope
    if (flat === straight < 0) a = m;
    else b = m;
  }
  const at = (a + b) / 2;
  const below = shift(at - gap - step, at - gap) / step;
  const above = shift(at + gap, at + gap + step) / step;
  const [flat, slope] = straight < 0 ? [below, above] : [above, below];
  if (!(flat < steady && slope >= bend)) return null;
  return { at, shift: Math.round(3 * (slope - flat) * 1000) / 1000 };
}

/**
 * A seam narrowed down between two heights by halving: into the half the
 * outline moves more in (`by` 'shift'), or the half its islands or holes
 * change in ('count'), down to `tolerance`. A step in the outline stays as
 * big however close the heights come; a slope's creep shrinks with them, and
 * so does a change of islands where two just touch: what moves across the
 * last interval must be `least` or more (`SPOT.least`, or `SPOT.touch` where
 * the islands or holes change), else it is no seam.
 * @param {number} lo
 * @param {number} hi
 * @param {{ shift: (a: number, b: number) => number, count?: (t: number) => string|number, by?: 'shift'|'count',
 *   tolerance?: number, least?: number }} how `shift` how far the outline moves between two heights (mm), `count` the
 *   islands and holes at one, compared for equality
 * @returns {{ lo: number, hi: number, shift: number }|null} the last interval and how far the outline moves across it
 */
export function locateSeam(lo, hi, { shift, count = null, by = 'shift', tolerance = SPOT.tolerance, least = by === 'count' ? SPOT.touch : SPOT.least }) {
  let a = lo;
  let b = hi;
  if (by === 'count' && count) {
    const first = count(a);
    while (b - a > tolerance) {
      const m = (a + b) / 2;
      if (count(m) === first) a = m;
      else b = m;
    }
  } else {
    while (b - a > tolerance) {
      const m = (a + b) / 2;
      if (shift(a, m) >= shift(m, b)) b = m;
      else a = m;
    }
  }
  const moved = shift(a, b);
  return moved >= least ? { lo: a, hi: b, shift: moved } : null;
}

/**
 * What a seam is, from the slices either side of it (`below` towards −axis):
 * islands come ('opens': openings or fretwork start past it) or go
 * ('closes'), holes come ('walls': a solid floor gives way to walls) or go
 * ('top': the walls close over) – a hole that comes over solid floor, or
 * goes under a solid top, is walls starting or closing over however many
 * other holes there are (`floored`, `capped`: one of two boxes side by side
 * closing over) – or the outline seen from outside – each island with its
 * holes filled – widens past it ('widens': a roof's eaves, a lid that
 * overhangs) or narrows ('narrows': a shoulder, a cap), by whether it gains
 * more than it loses; where only the inside changes, the outline the same,
 * the walls thicken ('thickens') or thin ('thins').
 * @param {{ below: { islands: number, holes: number }, above: { islands: number, holes: number }, gained: number,
 *   lost: number, outer?: { shift: number, gained: number, lost: number }, floored?: boolean, capped?: boolean }} sides
 *   `gained` the area of the slice above that the one below lacks, `lost` the other way (mm²); `outer` the same of the
 *   outlines seen from outside, and how far they move (mm) – without it the slices' own are read as the outline's;
 *   `floored` whether a hole above stands over solid below, `capped` whether one below goes under solid above
 * @returns {'opens'|'closes'|'walls'|'top'|'widens'|'narrows'|'thickens'|'thins'}
 */
export function seamKind({ below, above, gained = 0, lost = 0, outer = null, floored = false, capped = false }) {
  if (above.islands > below.islands) return 'opens';
  if (above.islands < below.islands) return 'closes';
  if (above.holes > below.holes) return below.holes === 0 || floored ? 'walls' : 'opens';
  if (above.holes < below.holes) return above.holes === 0 || capped ? 'top' : 'closes';
  if (outer && !(outer.shift >= SPOT.least)) return gained >= lost ? 'thickens' : 'thins';
  return (outer ? outer.gained >= outer.lost : gained >= lost) ? 'widens' : 'narrows';
}

/**
 * The side of a seam a spot is looked for on (−1 towards −axis): the one that
 * leaves the seam's shape whole with the piece it belongs to, so a cut never
 * leaves a thin plate of a ledge, a band or a slope on the other piece –
 * under a ledge the shape widens past (the overhang goes with the piece past
 * it) and over one it narrows past, before openings start and after they end,
 * past a floor and before the walls close over, before walls thicken inside
 * and after they thin, and on the straight side of a bend.
 * @param {string} kind from `seamKind`, or 'slopes' / 'straightens' for a bend
 * @returns {-1|1}
 */
export const spotSide = (kind) => ({ narrows: 1, closes: 1, walls: 1, thins: 1, straightens: 1 })[kind] ?? -1;

// a spot's why, said from where it is: [below the seam, above it] along Z, and beside it along X or Y
const SPOT_WHY = Object.freeze({
  widens: ['under a ledge where the shape widens', 'above a ledge where the shape widens', 'beside a ledge where the shape widens'],
  narrows: ['at a ledge where the shape narrows', 'at a ledge where the shape narrows', 'at a ledge where the shape narrows'],
  cap: ['under a cap', 'at the foot of a cap', 'at a ledge where the shape narrows'],
  opens: ['below the openings', 'where the openings start', 'beside the openings'],
  closes: ['where the openings end', 'above the openings', 'beside the openings'],
  walls: ['where the walls start', 'where the walls start', 'where the walls start'],
  top: ['where the walls close over', 'above where the walls close over', 'beside a closed end'],
  thickens: ['below where the walls thicken', 'where the walls thicken', 'beside where the walls thicken'],
  thins: ['where the walls thin', 'above where the walls thin', 'beside where the walls thin'],
  groove: ['under a groove', 'above a groove', 'beside a groove'],
  slopes: ['below where the sides start to slope', 'where the sides start to slope', 'beside where the sides start to slope'],
  straightens: ['where the sides straighten', 'above where the sides straighten', 'beside where the sides straighten'],
});

/**
 * Why a spot is a good place, in a few plain words from the shape alone –
 * never what the part might be: the kind of seam it sits by (`seamKind`), on
 * which side, along which axis; a seam that narrows to a small part coming
 * off (`cap`) is a cap.
 * @param {string} kind from `seamKind`
 * @param {-1|1} side −1 the spot is below the seam (towards −axis), 1 above it
 * @param {number} axis 0, 1 or 2
 */
export function spotWhy(kind, side, axis = 2, { cap = false } = {}) {
  const words = SPOT_WHY[kind === 'narrows' && cap ? 'cap' : kind] ?? SPOT_WHY.narrows;
  return axis === 2 ? words[side < 0 ? 0 : 1] : words[2];
}

/**
 * A seam in a few words, for a cut that snaps to it ("snapped to the ledge
 * at 200 mm"): what changes there, from the shape alone.
 * @param {string} kind from `seamKind`
 * @param {number} axis 0, 1 or 2
 */
export function seamWords(kind, axis = 2) {
  const z = axis === 2;
  if (kind === 'opens') return z ? 'the bottom of the openings' : 'the edge of the openings';
  if (kind === 'closes') return z ? 'the top of the openings' : 'the edge of the openings';
  if (kind === 'walls') return 'where the walls start';
  if (kind === 'top') return 'where the walls close over';
  if (kind === 'thickens') return 'where the walls thicken';
  if (kind === 'thins') return 'where the walls thin';
  if (kind === 'slopes') return 'where the sides start to slope';
  if (kind === 'straightens') return 'where the sides straighten';
  return 'the ledge';
}

/**
 * The first spot to try beside a seam, on one side of it: the nearest 0.5 mm
 * step at least a quarter of a step away, so the cut never lies in the seam's
 * own face.
 * @param {number} at the seam
 * @param {-1|1} side
 */
export const spotStart = (at, side, step = SPOT.step) => (side < 0
  ? Math.floor((at - step / 2) / step + 1e-9) * step
  : Math.ceil((at + step / 2) / step - 1e-9) * step);

/**
 * Whether a spot at `at` for the seam at `seam` (on its side `side`) keeps
 * to that seam: no other seam lies between them, nor within `least` mm of
 * the spot – a move from under a roof's eaves down past a band of gargoyles
 * would cut through the band instead.
 * @param {number[]} seams every seam's place along the axis
 */
export const keepsTo = (seams, seam, side, at, least = SPOT.least) => seams.every((s) => Math.abs(s - seam) < 1e-9 || (s - seam) * side <= 0 || (s - at) * side >= least);

/**
 * The target a cut being placed at `at` snaps to: the nearest within
 * `SPOT.snap` mm, or within the caller's tolerance (mm) when that is larger
 * – a few pixels on screen, worked out by the caller. Of two as near, a spot
 * before a full lip's height before a seam.
 * @param {{ at: number, kind?: 'spot'|'lip'|'seam' }[]} targets
 * @param {number} at
 * @param {number} [tolerance]
 * @returns {object|null} the target, or null when none is that near
 */
export function snapTarget(targets, at, tolerance = 0) {
  const reach = Math.max(SPOT.snap, Number(tolerance) || 0);
  const order = { spot: 0, lip: 1, seam: 2 };
  let best = null;
  let bestD = Infinity;
  for (const target of targets ?? []) {
    const d = Math.abs(target.at - at);
    if (!(d <= reach + 1e-9)) continue;
    const nearer = d < bestD - 1e-9;
    const tie = Math.abs(d - bestD) <= 1e-9 && (order[target.kind] ?? 3) < (order[best?.kind] ?? 3);
    if (nearer || tie) {
      best = target;
      bestD = d;
    }
  }
  return best;
}

/**
 * What comes off at a cut that comes apart: the top of a Z cut (the notes'
 * "the top"), else the smaller part – a box's lid comes off it lying on its
 * side as it does standing up, whichever piece carries the lip. `side` 1 the
 * piece towards +axis, −1 the other; its length along the axis; and its share
 * of the model's volume, from the profile's slices (trapezoids between the
 * samples, the face itself at the cut, the end samples held to the model's
 * ends).
 * @param {{ t: number, area: number }[]} profile in order along the axis
 * @param {{ lo: number, hi: number, axis: number, at: number, area: number }} cut `lo`, `hi` the model's extent along
 *   the axis, `area` the face's
 * @returns {{ side: -1|1, length: number, fraction: number }}
 */
export function comesOffOf(profile, { lo, hi, axis, at, area }) {
  const points = [...profile.filter((p) => p.t > lo && p.t < hi).map((p) => [p.t, p.area])];
  if (points.length) {
    points.unshift([lo, points[0][1]]);
    points.push([hi, points[points.length - 1][1]]);
  }
  const inside = points.filter(([t]) => Math.abs(t - at) > 1e-9);
  const all = [...inside, [at, area]].sort((p, q) => p[0] - q[0]);
  let below = 0;
  let above = 0;
  for (let i = 0; i + 1 < all.length; i++) {
    const [t0, a0] = all[i];
    const [t1, a1] = all[i + 1];
    const v = ((a0 + a1) / 2) * (t1 - t0);
    if (t1 <= at + 1e-9) below += v;
    else above += v;
  }
  const total = below + above;
  const side = axis === 2 || above <= below ? 1 : -1;
  const part = side > 0 ? above : below;
  return {
    side,
    length: Math.round((side > 0 ? hi - at : at - lo) * 100) / 100,
    fraction: total > 0 ? Math.round((part / total) * 1000) / 1000 : 0,
  };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * How good a spot for a cut that comes apart is, higher better. A full lip
 * counts most (3 with clips or the twist-lock in their place, 2 without, 1
 * less where its tongue comes in stretches: an opening's edge in its foot
 * cuts it), then the seam it hides
 * in – up to 1 for an outline that moves 3 mm or more there, and up to 0.5
 * more the closer the cut is to it, all of it only for a seam that shows on
 * the outside (where the walls close over inside, or at the tips of a row of
 * narrow windows, the cut runs across plain wall and hides nowhere) – and a
 * sensible part coming off: a top or a lid of up
 * to 30 % of the model scores 1, less towards a sliver (nothing under 2 %)
 * and towards 60 %, and past that the more of the model the worse. Each
 * island beyond one takes off 0.5 (a cut through fretwork, posts or a
 * handle's legs), and cutting through letters 2.
 * @param {{ full?: boolean, clips?: number, twist?: boolean, broken?: boolean, shift?: number, distance?: number,
 *   fraction?: number, islands?: number, crosses?: number }} spot `shift` how far the outline the outside shows moves
 *   at its seam (mm), `distance` from it (mm), `fraction` the share that comes off, `crosses` how many text items it cuts
 */
export function spotScore({ full = true, clips = 0, twist = false, broken = false, shift = 0, distance = 0, fraction = 0, islands = 1, crosses = 0 }) {
  const lip = full ? (clips > 0 || twist ? 3 : 2) - (broken ? 1 : 0) : 0;
  const shows = clamp01(shift / SPOT.sharp);
  const seam = Math.min(1, Math.max(0, shift) / 3) + 0.5 * clamp01(1 - distance / SPOT.look) * shows;
  let part;
  if (fraction < 0.02) part = 0;
  else if (fraction < 0.1) part = (fraction - 0.02) / 0.08;
  else if (fraction <= 0.3) part = 1;
  else if (fraction <= 0.6) part = (0.6 - fraction) / 0.3;
  else part = -2 * ((fraction - 0.6) / 0.4);
  return lip + seam + part - 0.5 * Math.max(0, islands - 1) - (crosses > 0 ? 2 : 0);
}


/**
 * The best spots, best first: by score, each at least `apart` mm from every
 * one kept before it, at most `most`, and none scoring `floor` or less – a
 * spot whose flaws outweigh its lip (through fretwork, sixteen posts at
 * once) is no suggestion, however short the list.
 * @param {{ at: number, score: number }[]} candidates
 */
export function pickSpots(candidates, { apart = SPOT.apart, most = SPOT.most, floor = SPOT.floor } = {}) {
  const sorted = [...candidates].sort((p, q) => q.score - p.score || p.at - q.at);
  const kept = [];
  for (const c of sorted) {
    if (kept.length >= most) break;
    if (!(c.score > floor)) continue;
    if (kept.some((k) => Math.abs(k.at - c.at) < apart - 1e-9)) continue;
    kept.push(c);
  }
  return kept;
}

/**
 * Whether each piece either side of a cut would print about as well lying
 * with a lip standing up out of its cut face as it does anyway, guessed
 * before the model is cut: only when the model ends on that side in
 * something flat of 25 mm² or more, and at least half as big as the face it
 * could lie on instead. A lantern's body stands on its foot; its top would
 * stand on its handle. Given how long each piece is along the axis
 * (`lengths`), also only when standing on that end with the lip is about as
 * steady as it stands without one – on that end or on its cut face, the
 * slenderness `orientationScore` counts, each over the box its bed spans
 * (`spans`, `faceSpan`): a slender tower's top 220 mm tall would stand on a
 * small flat roof, and a lip 6 mm taller can tip a slender tower on its
 * foot past what it costs without one. `apartMales` judges the pieces
 * themselves.
 * @param {number[]} beds the flat area the model ends in on each side, [towards −axis, towards +axis] (mm²)
 * @param {number} face the cut face's area (mm²)
 * @param {{ lengths?: number[]|null, spans?: number[], faceSpan?: number }} [options] `lengths` each piece's along
 *   the axis, [below, above] (mm); `spans` the area of the box each end's bed spans, `faceSpan` the face's (mm²)
 * @returns {boolean[]} [the piece below, the one above]
 */
export function endsAsWell(beds, face, { lengths = null, spans = [0, 0], faceSpan = 0 } = {}) {
  const standing = (tall, bed, span) => {
    const base = Math.max(bed, span, 1);
    return (bed < STEADY ? 1e4 : 0) + slenderCost(tall / Math.sqrt(base), base);
  };
  return [0, 1].map((k) => {
    const bed = beds[k] ?? 0;
    if (!(bed >= Math.max(STEADY, 0.5 * face))) return false;
    if (!lengths) return true;
    const onEnd = standing(lengths[k], bed, spans[k] ?? 0);
    const onCut = standing(lengths[k], face, faceSpan);
    const [was, wasBed] = onEnd <= onCut ? [onEnd, bed] : [onCut, face];
    return standing(lengths[k] + LIP_ALLOWANCE, bed, spans[k] ?? 0) <= was + Math.max(STEADY, 0.1 * wasBed);
  });
}

/**
 * Whether each piece either side of a cut would print about as well lying
 * on its cut face – where a twist-lock's socket is cut into it – as it does
 * anyway, guessed before the model is cut from the model's ends: unless the
 * model ends on that side in something flat larger than the face itself
 * (and 25 mm² or more), which would rather be its bed – upside down on its
 * cut face, a closed tube's end would hang over its inside. An open tube's
 * rim, a solid cylinder's end, no larger than the face, lie as well either
 * way, as `apartMales`, judging the pieces themselves, finds.
 * @param {number[]} beds the flat area the model ends in on each side, [towards −axis, towards +axis] (mm²)
 * @param {number} face the cut face's area (mm²)
 * @returns {boolean[]} [the piece below, the one above]
 */
export function socketsAsWell(beds, face) {
  return [0, 1].map((k) => !((beds[k] ?? 0) >= STEADY && beds[k] > SOCKET_END * face));
}

/**
 * The flat area a model ends in at each end of each axis, as `cellSupport`
 * counts a box's bed: facets facing that way squarely, wholly within 0.1 mm
 * of the furthest the model goes. One pass over the mesh, for `endsAsWell`.
 * @param {{ vertProperties: Float32Array|number[], numProp: number, triVerts: Uint32Array|number[] }} mesh
 * @returns {number[][]} per axis, [towards −axis, towards +axis] (mm²)
 */
export const endBeds = (mesh) => endShape(mesh).beds;

/**
 * The flat area a model ends in at each end of each axis (`endBeds`), and
 * the area of the box that flat area spans across the other two axes
 * (`spans`, as `orientationStats`' footprint): a ring's whole outline holds
 * it as steady as a disc.
 * @param {{ vertProperties: Float32Array|number[], numProp: number, triVerts: Uint32Array|number[] }} mesh
 * @returns {{ beds: number[][], spans: number[][] }} per axis, [towards −axis, towards +axis] (mm²)
 */
export function endShape(mesh) {
  const { vertProperties: P, numProp, triVerts: T } = mesh;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < P.length; i += numProp) {
    for (let a = 0; a < 3; a++) {
      if (P[i + a] < min[a]) min[a] = P[i + a];
      if (P[i + a] > max[a]) max[a] = P[i + a];
    }
  }
  const beds = [[0, 0], [0, 0], [0, 0]];
  // the box each end's bed spans across the other two axes, in their cyclic order: [u0, v0, u1, v1]
  const boxes = [0, 1, 2].map(() => [0, 1].map(() => [Infinity, Infinity, -Infinity, -Infinity]));
  const n = [0, 0, 0];
  for (let t = 0; t + 2 < T.length; t += 3) {
    const a = T[t] * numProp;
    const b = T[t + 1] * numProp;
    const c = T[t + 2] * numProp;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    n[0] = uy * vz - uz * vy;
    n[1] = uz * vx - ux * vz;
    n[2] = ux * vy - uy * vx;
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!(len > 0)) continue;
    const axis = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
    if (!(Math.abs(n[axis]) / len > FLAT)) continue;
    // its corner furthest from the bed it would lie on must be at the model's end
    const [p0, p1, p2] = [P[a + axis], P[b + axis], P[c + axis]];
    if (!(n[axis] < 0 ? Math.max(p0, p1, p2) - min[axis] <= 0.1 : max[axis] - Math.min(p0, p1, p2) <= 0.1)) continue;
    const k = n[axis] < 0 ? 0 : 1;
    beds[axis][k] += len / 2;
    const box = boxes[axis][k];
    [(axis + 1) % 3, (axis + 2) % 3].forEach((w, i) => {
      box[i] = Math.min(box[i], P[a + w], P[b + w], P[c + w]);
      box[2 + i] = Math.max(box[2 + i], P[a + w], P[b + w], P[c + w]);
    });
  }
  const spans = boxes.map((ends) => ends.map(([u0, v0, u1, v1]) => (u1 > u0 && v1 > v0 ? (u1 - u0) * (v1 - v0) : 0)));
  return { beds, spans };
}

/**
 * Which piece carries a cut's lip before the model is cut, chosen as
 * `apartMales` chooses: of the pieces with a lip on offer, one that prints
 * as well with it (`asWell`, `endsAsWell`), then the better lip (one with
 * clips or the twist-lock in their place, taller, more clips, more
 * tongue), then the one below. When the one
 * chosen prints worse with it and the other would print as well but has no
 * room for one, that one is named (`alt`), so the cut can be moved to where
 * it can carry it.
 * @param {({ H: number, clips: number, area: number, twist?: boolean }|null)[]} quality the lip each would carry, [below, above]
 * @param {boolean[]} [asWell]
 * @returns {{ male: 0|1, alt: 0|1|null }|null} null when neither has a lip on offer
 */
export function lipMale(quality, asWell = [true, true]) {
  const rank = (q) => (q ? [1, q.clips > 0 || q.twist ? 1 : 0, q.H, q.clips ?? 0, q.area ?? 0] : [0, 0, 0, 0, 0]);
  const options = [0, 1].map((k) => ({ k, asWell: Boolean(asWell[k]), quality: quality[k] ?? null }));
  const better = (x, y) => {
    if (x.asWell !== y.asWell) return x.asWell ? -1 : 1;
    const [rx, ry] = [rank(x.quality), rank(y.quality)];
    for (let i = 0; i < rx.length; i++) if (Math.abs(rx[i] - ry[i]) > 1e-6 * Math.max(1, Math.abs(rx[i]))) return ry[i] - rx[i];
    return x.k - y.k;
  };
  const offered = (o) => o.quality?.H > 0 || Boolean(o.quality?.twist);
  const lipped = options.filter(offered).sort(better);
  if (!lipped.length) return null;
  const best = lipped[0];
  const room = !best.asWell ? options.find((o) => !offered(o) && o.asWell) : null;
  return { male: best.k, alt: room ? room.k : null };
}

/**
 * How the pieces print once their built-in pegs and their lips are placed
 * (`layoutSplit`'s `pegs` and `lips`): each piece that carries some is laid
 * again with them in its box, so its printed size, its fit and its file
 * count them; the rest lie as `layPieces` laid them. A piece carrying pegs
 * never lies on a face they stand out of (`statsWithPegs`); one carrying a
 * lip lies the way `apartMales` chose for it, the lip standing up
 * (`statsWithLip`), and nothing is said of a way down asked for that it
 * missed (`ORIENT_FALLBACK`): the lip is why. A piece of several shells lies again
 * only where every one of them rests on the bed (`layPieces`' rule;
 * `pegMales` and `apartMales` choose only a piece that has such a way). One
 * left with nothing flat to stand on but the face its pegs or its lip stand
 * out of (a dome cut in two) is told that they are why, not its shape
 * (`PIECE_UNSTABLE` with `pegs` or `lip`). A cut with the collar twist-lock
 * in place of its lip (`locks` of kind 'full') has its neck stand out of
 * the piece the lip would, as tall as the neck, and the piece its socket is
 * cut into lies on its cut face, as a lid that comes off does.
 * @param {object[]} laid from `layPieces`
 * @param {{ pegs?: { sides: { piece: number, peg: boolean }[] }[], lips?: { axis: number, dir?: number, down?: string,
 *   H?: number, male?: number, sides?: { piece: number, male: boolean }[] }[], locks?: { kind: string, cutId: string,
 *   down: string, S: object, sides: { piece: number, role: string }[] }[] }} layout the lips' male (its number, or
 *   the side with `male`), the way it lies (`down`, or from `dir`: +1 when the male is below the cut) and how far
 *   the lip stands out (`H`, `LIP_ALLOWANCE` when not given; none at 0)
 * @returns {object[]} `chooseOrientation`'s answer per piece of `laid`, with `pegged: true` on those laid again with
 *   pegs and `lip: true` on those with a lip
 */
export function layGrown(laid, { pegs = [], lips = [], locks = [] } = {}, U, orient = 'auto', { flat = null } = {}) {
  const maleOf = (lip) => lip.sides?.find((s) => s.male)?.piece ?? lip.male;
  const faceOf = (lip) => (lip.down ? oppositeDir(lip.down) : `${lip.dir < 0 ? '-' : '+'}${AXES[lip.axis]}`);
  const twisted = (locks ?? []).filter((x) => x.kind === 'full');
  // a twist-lock's neck stands out of its piece as a lip would, the way its lip would have: in place of its cut's lip
  const necks = twisted.map((x) => ({ sides: [{ piece: x.sides[0].piece, male: true }], down: x.down, H: x.S.H }));
  const standing = [...(lips ?? []).filter((l) => !twisted.some((x) => x.cutId === l.cutId)), ...necks];
  return laid.map((p) => {
    const own = (pegs ?? []).filter((g) => g.sides.some((s) => s.peg && s.piece === p.index));
    const tongues = standing.filter((l) => maleOf(l) === p.index && (l.H ?? LIP_ALLOWANCE) > 0);
    const sockets = twisted.filter((x) => x.sides.some((s) => s.role === 'part' && s.piece === p.index));
    if (!own.length && !tongues.length && !sockets.length) return p.lying;
    // a cut's lip may stand out of a piece on several faces (four posts cut across), all in the one plane: the box
    // takes in the tallest once, not each
    const out = new Map();
    for (const lip of tongues) out.set(faceOf(lip), Math.max(out.get(faceOf(lip)) ?? 0, lip.H ?? LIP_ALLOWANCE));
    let stats = p.stats;
    for (const [face, H] of out) stats = { ...lipGrown(stats, face, H), allowed: [oppositeDir(faceOf(tongues[0]))] };
    if (sockets.length) stats = { ...stats, allowed: [sockets[0].down] };
    if (own.length) stats = statsWithPegs(stats, own);
    const lip = tongues.length > 0;
    const o = chooseOrientation(restingOnly(stats, p.boxes) ?? stats, U, orient, { pieceIndex: p.index, flat });
    const steady = !p.lying.notes?.some((x) => x.code === 'PIECE_UNSTABLE');
    const why = lip ? { lip: true } : own.length ? { pegs: true } : null;
    const notes = o.notes
      .filter((x) => !((lip || sockets.length) && x.code === 'ORIENT_FALLBACK'))
      .map((x) => (x.code === 'PIECE_UNSTABLE' && steady && why ? splitNote('PIECE_UNSTABLE', { pieceIndex: p.index, ...why }) : x));
    return { ...o, notes, ...(own.length ? { pegged: true } : {}), ...(lip ? { lip: true } : {}) };
  });
}

/**
 * How the pieces print once their built-in pegs are placed (`layoutSplit`'s
 * `pegs`), as `layGrown` lays them with no lips.
 * @param {object[]} laid from `layPieces`
 * @param {{ sides: { piece: number, peg: boolean }[] }[]} pegs
 * @returns {object[]} `chooseOrientation`'s answer per piece of `laid`, with `pegged: true` on those laid again
 */
export function layPegged(laid, pegs, U, orient = 'auto', options = {}) {
  return layGrown(laid, { pegs: pegs ?? [] }, U, orient, options);
}

/**
 * A `PEGS_UPRIGHT` note for each cut whose built-in pegs all print standing
 * up, their pieces lying with the pegs pointing up (a plate under a thick
 * top carries them on its top): they print without supports, but are a
 * little weaker across their layers than pegs lying along the bed. Pins are
 * named as the stronger joint only where they would fit (`pinnable`): a
 * plate too thin for sockets is mostly too thin for pin holes too.
 * @param {{ cutId: string, letter: string, axis: number, dir: number, sides: { piece: number, peg: boolean }[] }[]} pegs
 *   `layoutSplit`'s
 * @param {{ index: number }[]} laid the pieces
 * @param {{ up: string }[]} lying how each piece of `laid` prints (`layPegged`)
 * @param {string[]} pinnable the ids of the cuts whose faces would take pins (`layoutSplit`'s)
 * @returns {object[]}
 */
export function uprightPegNotes(pegs, laid, lying, pinnable = []) {
  const up = new Map(laid.map((p, i) => [p.index, lying[i]?.up]));
  const cuts = new Map();
  for (const g of pegs ?? []) {
    const piece = g.sides.find((x) => x.peg)?.piece;
    if (!cuts.has(g.cutId)) cuts.set(g.cutId, { letter: g.letter, cutId: g.cutId, pieces: new Set(), upright: true });
    const cut = cuts.get(g.cutId);
    cut.pieces.add(piece);
    if (up.get(piece) !== `${g.dir > 0 ? '+' : '-'}${AXES[g.axis]}`) cut.upright = false;
  }
  return [...cuts.values()].filter((x) => x.upright).map(({ letter, cutId, pieces }) => splitNote('PEGS_UPRIGHT', {
    letter, cutId, pieces: [...pieces].sort((p, q) => p - q), ...(pinnable.includes(cutId) ? { pins: true } : {}),
  }));
}

/**
 * A piece thinner than 5 mm between its cut faces prints and glues badly:
 * a `SMALL_PIECE` note for each such piece.
 * @param {{ index: number, bbox: object, cuts: string[] }[]} pieces `cuts` the ids of the cuts each one's material meets
 * @param {{ id: string, letter: string, axis: number }[]} cuts
 * @returns {object[]}
 */
export function smallPieceNotes(pieces, cuts) {
  const notes = [];
  for (const piece of pieces) {
    let thin = null;
    for (let a = 0; a < 3; a++) {
      const along = cuts.filter((c) => c.axis === a && piece.cuts.includes(c.id));
      const extent = piece.bbox.max[a] - piece.bbox.min[a];
      if (along.length && extent < 5 && (!thin || extent < thin.thickness)) thin = { thickness: extent, along };
    }
    if (thin) notes.push(splitNote('SMALL_PIECE', { pieceIndex: piece.index, thickness: thin.thickness, letters: thin.along.map((c) => c.letter), cutId: thin.along[0].id }));
  }
  return notes;
}

/**
 * The piece of the laid-out ones (`layPieces`) from the box `cell` that
 * holds what spans the box [min, max] on a cut: the only one, or – where
 * the box's shells print apart – the one whose shells' boxes reach the cut
 * and cover the most of it. Null when the box makes no piece.
 */
export function pieceHolding(laid, cell, min, max) {
  const mine = laid.filter((p) => p.cell.every((c, a) => c === cell[a]));
  if (mine.length < 2) return mine[0]?.index ?? null;
  const slack = 0.05;
  const cover = (b) => {
    let area = 1;
    for (let a = 0; a < 3; a++) {
      const lo = Math.max(b.min[a] - slack, min[a] - slack);
      const hi = Math.min(b.max[a] + slack, max[a] + slack);
      if (hi < lo) return -1;
      if (max[a] > min[a]) area *= hi - lo; // the cut's own axis: reaching it is enough
    }
    return area;
  };
  let best = mine[0];
  let most = -1;
  for (const p of mine) {
    const c = Math.max(...(p.boxes ?? [p.bbox]).map(cover));
    if (c > most) {
      best = p;
      most = c;
    }
  }
  return best.index;
}

/**
 * A `CUT_THROUGH_TEXT` note for each cut through letters, naming the pieces
 * as they print: in every column of the boxes where the cut splits letters,
 * the piece either side that holds them (`pieceHolding`), so a sign cut in
 * a grid names each pair a cut divides letters between, and a box whose
 * lettered board prints apart names that board's piece.
 * @param {{ itemId: string, cutId: string, letter: string, name: string, columns: { cells: number[][], min: number[],
 *   max: number[] }[] }[]} crossings each cut through an item's letters, and where its face lies (`outlineColumns`)
 * @param {object[]} laid the pieces from `layPieces`
 * @returns {object[]}
 */
export function textNotes(crossings, laid) {
  return crossings.map(({ columns = [], ...fields }) => {
    const pairs = [];
    for (const { cells, min, max } of columns) {
      const [lower, upper] = cells.map((cell) => pieceHolding(laid, cell, min, max));
      if (lower && upper && lower !== upper && !pairs.some(([a, b]) => a === lower && b === upper)) pairs.push([lower, upper]);
    }
    pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const pieces = [...new Set(pairs.flat())].sort((p, q) => p - q);
    return splitNote('CUT_THROUGH_TEXT', { ...fields, pieces, ...(pairs.length > 1 ? { pairs } : {}) });
  });
}

/** A triangle soup (9 numbers per triangle) moved by a column-major 4×4 matrix, as a new array of the same type. */
export function applyToSoup(soup, m) {
  const out = new (ArrayBuffer.isView(soup) ? soup.constructor : Float32Array)(soup.length);
  for (let i = 0; i + 2 < soup.length; i += 3) {
    const x = soup[i];
    const y = soup[i + 1];
    const z = soup[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

// ---------- unrepaired triangles ----------

/**
 * Cuts a triangle soup (9 numbers per triangle) by the plane n·p = d
 * (Sutherland–Hodgman): `plus` holds what lies on the side n points to,
 * `minus` the rest; a triangle in the plane goes to `plus`. Each crossing
 * point is worked out from the edge's lower end (by coordinates), so the
 * two triangles that share an edge get the same point and stay joined.
 * Area is kept; the output has the input's array type (Float32Array for a
 * plain array).
 */
export function clipSoupByPlane(soup, n, d) {
  const Out = ArrayBuffer.isView(soup) ? soup.constructor : Float32Array;
  const plus = [];
  const minus = [];
  const side = (p) => p[0] * n[0] + p[1] * n[1] + p[2] * n[2] - d;
  const lower = (p, q) => p[0] < q[0] || (p[0] === q[0] && (p[1] < q[1] || (p[1] === q[1] && p[2] < q[2])));
  const crossing = (p, sp, q, sq) => {
    if (lower(q, p)) [p, sp, q, sq] = [q, sq, p, sp];
    const f = sp / (sp - sq);
    return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f];
  };
  for (let t = 0; t + 8 < soup.length; t += 9) {
    const P = [0, 3, 6].map((o) => [soup[t + o], soup[t + o + 1], soup[t + o + 2]]);
    const s = P.map(side);
    if (s[0] >= 0 && s[1] >= 0 && s[2] >= 0) {
      for (let k = 0; k < 9; k++) plus.push(soup[t + k]);
      continue;
    }
    if (s[0] <= 0 && s[1] <= 0 && s[2] <= 0) {
      for (let k = 0; k < 9; k++) minus.push(soup[t + k]);
      continue;
    }
    const up = [];
    const down = [];
    for (let k = 0; k < 3; k++) {
      const a = P[k];
      const b = P[(k + 1) % 3];
      const sa = s[k];
      const sb = s[(k + 1) % 3];
      if (sa >= 0) up.push(a);
      if (sa <= 0) down.push(a);
      if ((sa > 0 && sb < 0) || (sa < 0 && sb > 0)) {
        const x = crossing(a, sa, b, sb);
        up.push(x);
        down.push(x);
      }
    }
    // the pieces are convex, so a fan keeps the winding
    for (const [poly, out] of [[up, plus], [down, minus]]) {
      for (let k = 1; k + 1 < poly.length; k++) out.push(...poly[0], ...poly[k], ...poly[k + 1]);
    }
  }
  return { plus: Out.from(plus), minus: Out.from(minus) };
}

/**
 * A triangle soup cut by every cut and grouped by cell: each fragment goes
 * to the cell holding its centroid. Sorted bottom layer first, then front
 * to back, then left to right.
 * @param {Float32Array} soup
 * @param {{ axis: number, at: number }[]} cuts normalised cuts
 * @returns {{ cell: number[], soup: Float32Array }[]}
 */
export function soupCells(soup, cuts) {
  let rest = soup;
  for (const { axis, at } of cuts) {
    const n = [0, 0, 0];
    n[axis] = 1;
    const { plus, minus } = clipSoupByPlane(rest, n, at);
    rest = new (ArrayBuffer.isView(rest) ? rest.constructor : Float32Array)(minus.length + plus.length);
    rest.set(minus);
    rest.set(plus, minus.length);
  }
  const by = axisCuts(cuts);
  const groups = new Map();
  for (let t = 0; t + 8 < rest.length; t += 9) {
    const c = [0, 1, 2].map((a) => (rest[t + a] + rest[t + 3 + a] + rest[t + 6 + a]) / 3);
    const cell = cellOfPoint(c, by);
    const key = cell.join(',');
    if (!groups.has(key)) groups.set(key, { cell, values: [] });
    const list = groups.get(key).values;
    for (let k = 0; k < 9; k++) list.push(rest[t + k]);
  }
  const Out = ArrayBuffer.isView(soup) ? soup.constructor : Float32Array;
  return [...groups.values()]
    .sort((p, q) => p.cell[2] - q.cell[2] || p.cell[1] - q.cell[1] || p.cell[0] - q.cell[0])
    .map(({ cell, values }) => ({ cell, soup: Out.from(values) }));
}

// ---------- notes ----------

/** A length for a note: at most two decimals, none when whole (19, 3.5, 1.75). */
const mm = (v) => String(Math.round(v * 100) / 100);
const mm1 = (v) => String(Math.round(v * 10) / 10);

/** Box sides for a note: "262 × 120 × 80 mm". */
export const formatSize = (dims) => `${dims.map(mm1).join(' × ')} mm`;

/** "A", "A and B", "A, B and C". */
function listOf(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pieceName = (index) => (index ? `Piece ${index}` : 'A piece');
const quoted = (name) => (/^“/.test(name ?? '') ? name : `“${name ?? ''}”`);
/** A length that is needed, to a tenth of a millimetre and never less: 9.35 → "9.4". */
const need1 = (v) => String(Math.ceil(v * 10 - 1e-6) / 10);
/** A length that falls short, to a tenth of a millimetre and never more: 38.29 → "38.2". */
const short1 = (v) => String(Math.floor(v * 10 + 1e-6) / 10);
/** "piece 2", "pieces 3 and 4". */
const piecesOf = (list, fallback) => {
  const all = [list ?? fallback].flat().filter((x) => x != null);
  return all.length > 1 ? `pieces ${listOf(all)}` : `piece ${all[0] ?? fallback}`;
};
/** What comes off at a cut that comes apart: the top of a Z cut, else the piece named. */
const mover = (axis, piece) => (axis == null || axis === 2 ? 'the top' : piecesOf(piece, 2));
/** Whether what comes off is more than one piece by name (pieces across an X or Y cut), and its verb plural. */
const manyMove = (axis, piece) => !(axis == null || axis === 2) && [piece].flat().filter((x) => x != null).length > 1;
/** "Move the cut to 190.5 mm." when there is a place to move it to. */
const moveTo = (at) => (Number.isFinite(at) ? ` Move the cut to ${mm(at)} mm.` : '');
/** A part that comes off as a sentence names it ("Dome and cap" → "the dome and cap"; "Part B" → "the part"). */
const partCalled = (name) => (!name || /^Part\b/.test(name) ? 'part' : String(name).toLowerCase());
/** Whether a part's name reads as more than one thing, and its verb plural: the dome and cap lift off. */
const partMany = (name) => / and /.test(name ?? '');
/** Where along a part's axis its face is: "Z 115.6". */
const partAt = (axis, z) => `${(AXES[axis] ?? 'z').toUpperCase()} ${mm1(z)}`;
/** "piece 1", or what stands for it when the number is not known. */
const partPiece = (n, otherwise) => (Number.isFinite(n) ? `piece ${n}` : otherwise);
/** " (piece 2)" after a part's name, when its number is known. */
const partNumber = (n) => (Number.isFinite(n) ? ` (piece ${n})` : '');
/** How a part's collar twist-lock goes on: set on turned θ to the left, the wide lug in its wide slot, turned right. */
const twistOn = (turn) => `set it on turned ${roundAngle(turn)}° to the left so the wide lug finds its wide slot, push down and turn it right until it clicks.`;

/**
 * A base's tea-light seat in a few words: "a 38 mm tea light sits in the seat on top of the base (Ø 39.5 mm, 3 mm
 * deep)", and where it takes the place of the model's own detail (`clears`), that it does.
 */
const seatWords = ({ d = 0, depth = 0, clears = null }, base = 'the base') => {
  const instead = clears ? `, in place of the model's own detail there (${mm1(clears.h)} mm proud, Ø ${roundOpening(clears.across)} mm across)` : '';
  return `a ${TEA_LIGHT} mm tea light sits in the seat on top of ${base} (Ø ${mm1(d)} mm, ${mm1(depth)} mm deep)${instead}`;
};

/** How to keep the model's own detail a seat takes the place of, in the app: the row's switch. */
const keepDetail = (seat) => (seat?.clears ? ' To keep that detail instead, untick Tea-light seat.' : '');

/** What to light a lantern with: the plastic over a flame softens. */
const FLAME = "Use an LED tea light: a flame's heat softens the plastic over it.";

/**
 * Why a base gets no tea-light seat (`seatFor`'s refusal), as its note and its row's toggle say it: "the model's own
 * detail in the middle of its top, 7.6 mm proud, is Ø 45.3 mm across – wider than the seat, which would leave the rest
 * of it standing". An opening is said to a tenth short and what it takes to a tenth over, so the two never read alike.
 */
export function noSeatWords(fit) {
  switch (fit?.why) {
    case 'narrow':
      return `a ${TEA_LIGHT} mm tea light doesn't go through its Ø ${short1(fit.opening)} mm opening${fit.need ? ` – that takes Ø ${need1(fit.need)} mm` : ''}`;
    case 'room':
      return `it is too narrow to keep a wall round one – that takes a Ø ${need1(fit.need)} mm opening`;
    case 'detail':
      if (fit.open) return `the model's own detail in the middle of its top runs on up into the model, where the light would sit`;
      return `the model's own detail in the middle of its top, ${mm1(fit.h)} mm proud, is Ø ${need1(fit.across)} mm across – wider than the seat, which would leave the rest of it standing`;
    case 'level':
      return `its top rises ${mm1(fit.h)} mm round where the seat would go – a seat needs it level to within ${mm(fit.rough)} mm`;
    case 'thin':
      return fit.lock ? `its top is only ${mm1(fit.t)} mm over its lock – a seat needs ${need1(fit.need)} mm` : `it is only ${mm1(fit.t)} mm thick – a seat needs ${need1(fit.need)} mm`;
    case 'hollow':
      return "it isn't solid under where the seat would go";
    case 'low':
      return `there are only ${mm1(fit.room)} mm over it inside the model – a seat needs ${mm(fit.tall)} mm, room for the tallest tea light`;
    default:
      return 'no seat fits it';
  }
}

const NOTE_LEVELS = Object.freeze({
  SPLIT: 'ok',
  PINS: 'info',
  DOVETAIL: 'info',
  CONNECTORS_SHORTER: 'info',
  CONNECTORS_FILAMENT: 'info',
  PEGS_SMALLER: 'info',
  PEGS_UPRIGHT: 'info',
  APART: 'info',
  APART_TWIST: 'info',
  APART_NO_CLIPS: 'warn',
  APART_FLAT: 'warn',
  APART_HEAVY: 'info',
  APART_KEPT: 'info',
  CONNECTORS_DROPPED: 'warn',
  ONE_CONNECTOR: 'warn',
  DOWELS_CAPPED: 'info',
  LABELS_SKIPPED: 'info',
  PIECE_TOO_BIG: 'warn',
  PIECE_UNSTABLE: 'warn',
  PART_TOO_BIG: 'warn',
  SMALL_PIECE: 'warn',
  CUT_MISSES: 'warn',
  CUT_NOT_STRAIGHT: 'warn',
  CUTS_MERGED: 'info',
  SLIVER_REMOVED: 'info',
  SPLIT_CHECK: 'warn',
  CUT_THROUGH_TEXT: 'info',
  PART_SPANS_CUT: 'info',
  DOVETAIL_NOT_PLATE: 'info',
  ORIENT_FALLBACK: 'info',
  SPLIT_UNREPAIRED: 'warn',
  SPLIT_UNAVAILABLE: 'warn',
  SPLIT_NOT_NEEDED: 'info',
  PLAN_TOO_MANY: 'warn',
  BED_TOO_SMALL: 'info',
  PART_LIFTS: 'info',
  PART_LOCK: 'info',
  PART_PLUG: 'info',
  PART_SEAT: 'info',
  // the seat is asked for wherever one fits, so a base with none is nothing to act on: the note says why
  PART_NO_SEAT: 'info',
  PART_SMALL: 'warn',
  PART_PRINT: 'info',
  PART_FIT: 'info',
  PART_GAP: 'warn',
  PART_STUCK: 'warn',
  PART_SPLIT: 'warn',
  PART_MIXED: 'warn',
  PART_CROSSED: 'warn',
});

/** Every note code a split can give, with its level. */
export const SPLIT_NOTE_CODES = Object.freeze(Object.keys(NOTE_LEVELS));

const NOTE_TEXT = {
  SPLIT: ({ pieces, dowels = 0, diameter, length, lengths = [], sizes = [], pegs = 0, pegSize = null, pegSizes = [], dovetails = 0, pairs = [], apart = [] }) => {
    let s = `Cut into ${plural(pieces, 'piece')}`;
    // built-in pegs are no parts to make: their count and size, or how many of each size where narrow faces took smaller
    if (pegs > 0) {
      const size = pegSizes.length > 1 ? pegSizes.map((g) => `${g.count} × ${mm(g.size)} mm`).join(', ') : `${mm(pegSize)} mm`;
      s += ` joined by ${plural(pegs, 'built-in peg')} (${size} square)`;
    }
    // pins of more than one size (filament where a face is too narrow), or one size cut to two lengths (holes made
    // shallower near an end), say how many of each
    if (dowels > 0 && sizes.length > 1) s += ` with ${plural(dowels, 'pin')} (${sizes.map((g) => `${g.count} × Ø${mm(g.diameter)} × ${mm(g.length)} mm`).join(', ')})`;
    else if (dowels > 0 && lengths.length > 1) s += ` with ${plural(dowels, 'pin')} Ø${mm(diameter)} mm (${lengths.map((g) => `${g.count} × ${mm(g.length)} mm`).join(', ')})`;
    else if (dowels > 0) s += ` with ${plural(dowels, 'pin')} Ø${mm(diameter)} × ${mm(length)} mm`;
    if (dovetails > 0) s += `${dowels > 0 || pegs > 0 ? ' and' : ' with'} dovetail tabs`;
    s += '.';
    if (pairs.length) s += ` Glue matching letters together: ${pairs.join(', ')}.`;
    if (apart.length) s += ` ${apart.length > 1 ? `Cuts ${listOf(apart)} come apart – don't glue them.` : `Cut ${apart[0]} comes apart – don't glue it.`}`;
    return s;
  },
  PINS: ({ count, spares = 0, diameter, length, own = false }) => {
    if (diameter === FILAMENT) return `No pins file – cut ${plural(count, 'piece')} of 1.75 mm filament ${mm(length)} mm long.`;
    if (own) return `No pins file – cut ${count} Ø${mm(diameter)} mm dowels to ${mm(length)} mm.`;
    const spare = spares ? `, ${spares === 1 ? 'one spare' : `${spares} spares`}` : '';
    return `Print the pins file (${plural(count + spares, 'pin')}${spare}) lying flat – or use Ø${mm(diameter)} mm wooden dowels cut to ${mm(length)} mm.`;
  },
  DOVETAIL: ({ letter, tabs, pieces = [], pegs = false, apart = false }) => {
    const [lower, upper] = [pieces[0] ?? 1, pieces[1] ?? 2];
    return apart
      ? `Cut ${letter} goes through a thin plate, so it comes apart on ${plural(tabs, 'dovetail tab')} – lay both pieces flat and lower piece ${upper} onto piece ${lower}; lift it off again to take it apart. Don't glue it.`
      : `Cut ${letter} goes through a thin plate, so it has ${plural(tabs, 'dovetail tab')} instead of ${pegs ? 'pegs' : 'pins'} – lay both pieces flat and lower piece ${upper} onto piece ${lower}.`;
  },
  CONNECTORS_SHORTER: ({ letter, depth, pegs = false }) => (pegs
    ? `Cut ${letter} uses ${mm(depth)} mm-long pegs – longer ones would break through the side.`
    : `Cut ${letter} uses ${mm(depth)} mm-deep holes – deeper ones would break through the side.`),
  CONNECTORS_FILAMENT: ({ letter, count, diameter, length, lengths = [] }) => {
    // holes of two depths take two lengths: one cut to the longer would hold the seam open in the shallower pair
    const cut = lengths.length > 1 ? listOf(lengths.map((g) => `${plural(g.count, 'piece')} ${mm(g.length)} mm long`)) : `${plural(count, 'piece')} ${mm(length)} mm long`;
    return `Cut ${letter} is too narrow for ${diameter ? `Ø${mm(diameter)} ` : ''}pins: its holes take 1.75 mm filament – cut ${cut}.`;
  },
  PEGS_SMALLER: ({ letter, asked = null, pegSizes = [] }) => {
    const count = pegSizes.reduce((n, g) => n + g.count, 0);
    const took = pegSizes.length ? `${listOf(pegSizes.map((g) => `${g.count} × ${mm(g.size)} mm`))} ${count === 1 ? 'peg' : 'pegs'}` : 'smaller pegs';
    return `Cut ${letter} is too narrow for ${asked ? `${mm(asked)} mm` : 'full-size'} pegs – it takes ${took} instead.`;
  },
  PEGS_UPRIGHT: ({ letter, pieces = [], pins = false }) => {
    const list = [pieces].flat();
    return `Cut ${letter}'s pegs print standing up on ${list.length > 1 ? `pieces ${listOf(list)}` : `piece ${list[0] ?? ''}`} – they are a little weaker across the layers than pegs lying flat${pins ? '; pins (Joints: Pins) would be stronger' : ''}.`;
  },
  APART: ({ letter, axis = 2, above = false, male = 1, female = 2, hold = 'snap', clips = 0, height = LIP_ALLOWANCE, flat = 0, lying = 0 }) => {
    const lip = `a ${mm(height)} mm lip`;
    const z = axis == null || axis === 2;
    const clicks = clips > 0 && hold !== 'lift';
    // the top clicks onto the lip below it, or into the piece below on its own lip; across X or Y the piece that comes
    // off clicks onto the other's lip, and several such pieces click on together
    const moving = z ? `the top (${piecesOf(above ? male : female, 2)})` : piecesOf(female, 2);
    const many = manyMove(axis, female);
    const verb = (one, more) => (many ? more : one);
    const into = z && above;
    let s = `Cut ${letter} comes apart: ${moving} `;
    if (clicks && hold === 'lock') {
      // pressed on with a click, and off only with a firm pull: the seated top hides the key's gap, so there is
      // nowhere to lever it
      s += into ? `${verb('locks', 'lock')} into ${piecesOf(female, 1)} on ${lip}` : `${verb('locks', 'lock')} onto ${lip}`;
      const it = verb('it', 'them');
      s += clips === 1 ? ` – 1 clip holds ${it} firmly, on one side only.` : ` – ${clips} clips hold ${it} firmly.`;
      s += ` Press ${it} on until ${verb('it clicks', 'they click')}; to take ${it} off, pull hard.`;
    } else if (clicks) {
      const how = `${verb('clicks', 'click')}${hold === 'light' ? ' lightly' : ''}`;
      s += into ? `${how} into ${piecesOf(female, 1)} on ${lip}` : `${how} onto ${lip} on ${piecesOf(male, 1)}`;
      const it = verb('it', 'them');
      const off = `${verb('it pulls', 'they pull')} off again by hand.`;
      s += clips === 1 ? ` – 1 clip holds ${it}, on one side only, and ${off}` : ` – ${clips} clips hold ${it}, and ${off}`;
    } else {
      const sits = verb('sits', 'sit');
      const lifts = `${verb('lifts', 'lift')} straight off.`;
      s += into ? `${sits} in ${piecesOf(female, 1)} on ${lip} and ${lifts}` : `${sits} on ${lip} on ${piecesOf(male, 1)} and ${lifts}`;
    }
    if (flat > 0) s += flat === 1 ? ' 1 small face beside it just rests on the other piece.' : ` ${flat} small faces beside it just rest on each other.`;
    // a face of the cut whose pieces already lie another way for another cut's lip, or would not fit the printer so
    if (lying > 0) s += ` On ${lying === 1 ? '1 other face' : `${lying} other faces`} neither piece can lie with a lip standing up, so the pieces there just rest on each other.`;
    return s;
  },
  APART_TWIST: ({ letter, axis = 2, above = false, male = 1, female = 2, turn = 0, tabs = 0 }) => {
    // the piece with the socket goes on: the top of a Z cut, or the one under it where the top carries the neck
    const z = axis == null || axis === 2;
    const moving = z && !above ? `the top (${piecesOf(female, 2)})` : piecesOf(female, 2);
    const onto = z && above ? `the top (${piecesOf(male, 1)})` : piecesOf(male, 1);
    return `Cut ${letter} comes apart: ${moving} twist-locks onto ${onto} – 3 lugs and ${plural(tabs, 'click')}, as no clip fits its wall. To fit it: ${twistOn(turn)} To open it: turn it left until it clicks again and lift it off.`;
  },
  APART_NO_CLIPS: ({ letter, axis = 2, female = 2, why = 'height', height = 4.5, need = lipReach(LIP.heights[0]).reach, suggestedAt = null }) => {
    const off = `${mover(axis, female)} just ${manyMove(axis, female) ? 'lift' : 'lifts'} off`;
    let s;
    if (why === 'short') s = `Cut ${letter}'s lip has no straight stretch ${mm(CLIP.span + 2 * CLIP.margin)} mm long for a clip, so ${off}.`;
    else if (why === 'edge') s = `Cut ${letter} runs along the edge of an opening or a ledge, which breaks its lip into short stretches, so it has no clips and ${off}.`;
    else if (why === 'flex') s = `Cut ${letter}'s lip has no room for clips – something over the opening just above the cut leaves them no room to bow in – so ${off}.`;
    else if (why === 'skin') s = `Cut ${letter}'s walls are too thin for the clips' catches, so ${off}.`;
    else s = `Cut ${letter}'s lip is only ${mm(height)} mm tall, so it has no clips and ${off}: a lip that clicks on needs ${need1(need)} mm of plain wall in ${piecesOf(female, 2)} past the cut.`;
    return s + moveTo(suggestedAt);
  },
  APART_FLAT: ({ letter, axis = 2, pieces = [], why = 'room', wall = 2.7, need = lipReach(LIP.heights[LIP.heights.length - 1]).reach, suggestedAt = null, by = [], fixed = null, piece = 1, other = 2 }) => {
    const [lower, upper] = [pieces[0] ?? 1, pieces[1] ?? 2];
    if (why === 'thin') {
      return `Cut ${letter} has no room for a lip – its walls are under ${mm(wall)} mm thick – so ${mover(axis, upper)} just ${manyMove(axis, upper) ? 'rest' : 'rests'} on ${piecesOf(lower, 1)}, with nothing to line it up or hold it.`;
    }
    if (why === 'lying' && by.length) {
      // the pieces already lie another way for another cut's lip
      const lie = [fixed].flat().length > 1 ? 'lie' : 'lies';
      const whose = by.length > 1 ? `cuts ${listOf(by)}' lips` : `cut ${by[0]}'s lip`;
      return `Cut ${letter} has no lip: ${piecesOf(fixed, 1)} already ${lie} another way for ${whose}, and the other piece can't carry one, so the pieces just rest on each other.`;
    }
    if (why === 'lying') return `Cut ${letter} has no lip: neither piece fits your printer lying with the lip standing up out of it, so the pieces just rest on each other.`;
    if (why === 'tall') {
      return `Cut ${letter} has no lip: piece ${piece} would be too tall for your printer standing up with one, and piece ${other} would need supports carrying it.${moveTo(suggestedAt)}`;
    }
    if (why === 'small') return `Cut ${letter} runs through openings, so its faces are too small for a lip – cut through a solid band of the model.`;
    return `Cut ${letter} has no room for a lip – ${piecesOf(upper, 2)} ${[upper].flat().length > 1 ? 'have' : 'has'} under ${need1(need)} mm of plain wall past the cut before a roof, a ledge or an opening.${moveTo(suggestedAt)}`;
  },
  APART_HEAVY: ({ letter, weight = 0 }) => {
    // two figures are as near as a guess of the hold deserves
    const g = Number(weight) > 0 ? Number(Number(weight).toPrecision(2)) : 0;
    const about = g >= 1000 ? `${mm1(g / 1000)} kg` : `${g} g`;
    return `Cut ${letter}'s clips may not hold up what hangs below it (about ${about}) – carry the model by its base, not its top.`;
  },
  APART_KEPT: ({ letters = [] }) => (letters.length > 1
    ? `Cuts ${listOf(letters)} come apart, so Fit to my printer kept them where they are and planned the other cuts around them.`
    : `Cut ${letters[0] ?? ''} comes apart, so Fit to my printer kept it where it is and planned the other cuts around it.`),
  CONNECTORS_DROPPED: ({ letter, count = 1, total = count, wall = null, suggestedDiameter = null, dovetail = false, pegs = false, lying = false, thin = false }) => {
    if (dovetail) return `Cut ${letter} has no room for dovetail tabs – it is a flat glue joint. A strip glued behind it makes it stronger.`;
    if (thin) {
      return `On ${count} of ${plural(total, 'face')} at cut ${letter} one piece is too thin for sockets and can't lie flat on the bed with pegs standing out of it – ${count === 1 ? 'it is a flat glue joint' : 'they are flat glue joints'}.`;
    }
    if (lying) {
      return `On ${count} of ${plural(total, 'face')} at cut ${letter} neither piece can lie on the bed with pegs standing out of it – ${count === 1 ? 'it is a flat glue joint' : 'they are flat glue joints'}. Pins (Joints: Pins) would join them.`;
    }
    let s = `No ${pegs ? 'peg' : 'pin'} fits on ${count} of ${plural(total, 'face')} at cut ${letter}${wall ? ` (walls under ${mm(wall)} mm)` : ''} – ${count === 1 ? 'it is a flat glue joint' : 'they are flat glue joints'}. A strip glued inside makes it stronger.`;
    if (suggestedDiameter) s += ` Ø${mm(suggestedDiameter)} mm pins would fit.`;
    return s;
  },
  ONE_CONNECTOR: ({ letter, pegs = false }) => `Only one ${pegs ? 'peg' : 'pin'} fits on part of cut ${letter} – line the pieces up while the glue sets.`,
  DOWELS_CAPPED: ({ placed, dropped, pegs = false }) => `${plural(placed, pegs ? 'peg' : 'pin')} placed; ${plural(dropped, 'small face is', 'small faces are')} glued flat.`,
  LABELS_SKIPPED: ({ letters = [] }) => `No room for a label at ${letters.length > 1 ? 'cuts' : 'cut'} ${listOf(letters)}.`,
  PIECE_TOO_BIG: ({ pieceIndex, size, bed }) => `${pieceName(pieceIndex)} (${formatSize(size)}) doesn't fit your printer in any position${bed ? ` – it has room for ${formatSize(bed)}` : ''}.`,
  PIECE_UNSTABLE: ({ pieceIndex, pegs = false, lip = false }) => {
    if (lip) return `${pieceName(pieceIndex)} has nothing flat to stand on but the face its lip stands out of – it rests on a curve or an edge and needs supports.`;
    return pegs
      ? `${pieceName(pieceIndex)} has nothing flat to stand on but the face its built-in pegs stand out of – it rests on a curve or an edge and needs supports. With pins (Joints: Pins) it lies on that face.`
      : `${pieceName(pieceIndex)} has nothing flat to stand on where it fits your printer – it rests on a curve or an edge and needs supports. Another cut through it gives it a flat face to lie on.`;
  },
  PART_TOO_BIG: ({ name, size, bed, pins = false }) => {
    const room = `${formatSize(size)}${bed ? `; the printer has room for ${formatSize(bed)}` : ''}`;
    return pins
      ? `The pins are too long for your printer (${room}) – use wooden dowels, or a smaller pin size.`
      : `${quoted(name)} prints separately and is too big for your printer (${room}) – make it smaller, or join it to the model without pegs so it is cut with the pieces.`;
  },
  SMALL_PIECE: ({ pieceIndex, thickness, letters = [] }) => `Piece ${pieceIndex} is only ${mm1(thickness)} mm thick ${letters.length > 1 ? `between cuts ${listOf(letters)} – move one of them` : `beside cut ${letters[0] ?? ''} – move it`}.`,
  CUT_MISSES: ({ letter }) => `Cut ${letter} doesn't cross the model – it cuts nothing.`,
  CUT_NOT_STRAIGHT: ({ letter }) => `Cut ${letter} isn't straight along X, Y or Z and was left out.`,
  CUTS_MERGED: ({ letters = [] }) => `Cuts ${listOf(letters)} were in the same place; one was used.`,
  SLIVER_REMOVED: ({ count }) => (count === 1
    ? 'Removed 1 paper-thin sliver where a cut lies exactly on a flat face of the model.'
    : `Removed ${count} paper-thin slivers where cuts lie exactly on flat faces of the model.`),
  SPLIT_CHECK: ({ ratio }) => {
    const pct = Math.abs(ratio) * 100;
    return `The pieces add up to ${pct < 0.01 ? 'under 0.01' : pct.toFixed(2)} % ${ratio < 0 ? 'less' : 'more'} than the model – check them in your slicer.`;
  },
  CUT_THROUGH_TEXT: ({ letter, name, pieces = [], pairs = [] }) => {
    const where = pairs.length > 1
      ? `split where ${listOf(pairs.map(([a, b]) => `piece ${a} meets piece ${b}`))}`
      : `split between ${pieces.length > 1 ? `pieces ${listOf(pieces)}` : 'pieces'}`;
    return `Cut ${letter} runs through ${quoted(name)} – its letters are ${where}.`;
  },
  PART_SPANS_CUT: ({ name, letter }) => `${quoted(name)} prints separately and spans cut ${letter} – glue it on after the pieces.`,
  DOVETAIL_NOT_PLATE: ({ letter, lying = false, pegs = false }) => (lying
    ? `Cut ${letter} goes through a plate that its pieces can't lie flat on, so it uses ${pegs ? 'built-in pegs' : 'pins'}.`
    : `Cut ${letter} isn't through a thin plate, so it uses ${pegs ? 'built-in pegs' : 'pins'}.`),
  ORIENT_FALLBACK: ({ pieceIndex, mode, lies }) => `${pieceName(pieceIndex)} can't lie ${mode === 'model' ? 'as modelled' : 'on its cut face'} on your printer – it lies ${lies}.`,
  SPLIT_UNREPAIRED: ({ count }) => `${plural(count, 'triangle')} that couldn't be repaired ${count === 1 ? 'was' : 'were'} cut with the pieces but ${count === 1 ? 'has' : 'have'} no pins or labels.`,
  SPLIT_UNAVAILABLE: () => 'Splitting needs a solid model – this one couldn\'t be repaired.',
  SPLIT_NOT_NEEDED: ({ yaw = 0, down = '-z', apart = [] }) => {
    // with cuts that come apart, the pieces they make are what fits
    if (apart.length) return `This model fits your printer with ${apart.length > 1 ? `cuts ${listOf(apart)} as they are` : `cut ${apart[0]} as it is`} – no more cuts needed.`;
    return down && down !== '-z'
      ? `This model already fits your printer lying on its ${down.replace('-', '−').toUpperCase()} side${yaw ? `, turned ${yaw}° on the bed` : ''} – no need to split, but turn it that way in your slicer.`
      : `This model already fits your printer${yaw ? ` (turned ${yaw}° on the bed)` : ''} – no need to split.`;
  },
  PLAN_TOO_MANY: () => `This would need more than ${SPLIT_LIMITS.cells} pieces – scale the model down or choose a bigger printer.`,
  BED_TOO_SMALL: ({ size, bed }) => `${formatSize(size)} – bigger than your ${formatSize(bed)} printer.`,
  PART_LOCK: ({ letter, name, piece = null, home = null, handle = false, turn = 0, lift = 0, dir = null, span = null }) => {
    const verb = partMany(name) ? 'twist-lock' : 'twist-locks';
    const onto = partPiece(home, 'the model');
    const stays = handle ? ` and the handle stays on ${onto}` : '';
    return `Cut ${letter}: the ${partCalled(name)}${partNumber(piece)} ${verb} onto ${onto}${stays}. To fit it: ${twistOn(turn)} To open it: turn it left until it clicks again, ${wayWords({ lift, dir }, span)}.`;
  },
  PART_PLUG: ({ letter, name, piece = null, home = null, turn = 0, opening = 0, teaLight = false, model = null, seat = null }) => {
    const called = partCalled(name);
    const lantern = model ?? partPiece(home, 'the model');
    const turnIn = `set the ${called} in turned ${roundAngle(turn)}° to the left, push it in and turn it right until it clicks – a coin in its slot helps`;
    // with a light standing on it – in its seat, or on a base with none – the base goes in from underneath, the model
    // held up: turned over, the light would fall out. Seen from under it, the turns are the same as turned over
    const fit = `hold ${lantern} up and, looking at the ${called}'s bottom, ${turnIn}. To open it: turn it left until it clicks and lower it out.`;
    if (seat) {
      return `Cut ${letter}: the ${called}${partNumber(piece)} twists off underneath, and ${seatWords(seat, 'it')}. To fit it: stand the light in the seat, ${fit} ${FLAME}${keepDetail(seat)}`;
    }
    if (teaLight) {
      return `Cut ${letter}: the ${called}${partNumber(piece)} twists off underneath, and its Ø ${roundOpening(opening)} mm opening takes a ${TEA_LIGHT} mm tea light. To fit it: stand the light on the middle of the ${called}, ${fit} ${FLAME}`;
    }
    return `Cut ${letter}: the ${called}${partNumber(piece)} twists off underneath. Turn ${lantern} over, ${turnIn}. To open it: turn it left until it clicks and lift it out.`;
  },
  PART_SEAT: ({ letter, name, seat = null }) => `Cut ${letter}: ${seatWords(seat ?? {}, `the ${partCalled(name)}`)}. ${FLAME}${keepDetail(seat)}`,
  PART_NO_SEAT: ({ letter, name, piece = null, ...fit }) => `Cut ${letter}: no tea-light seat on the ${partCalled(name)}${partNumber(piece)} – ${noSeatWords(fit)}.`,
  PART_LIFTS: ({ letter, name }) => {
    const many = partMany(name);
    return `Cut ${letter}: the ${partCalled(name)} ${many ? 'lift' : 'lifts'} off – nothing holds ${many ? 'them' : 'it'}.`;
  },
  PART_SMALL: ({ letter, name, why = 'room', now = 100, wall = null, lock = null, opening = null, tea = null, most = null, base = null }) => {
    const called = partCalled(name);
    // the dome and cap's roof is the dome: that is what is too thin
    const roof = name === 'Dome and cap' ? 'dome' : called;
    let s;
    if (why === 'tabs') s = `Cut ${letter}: the ${roof} has no room for a twist-lock's click tabs at ${now} %.`;
    else if (why === 'collar') s = `Cut ${letter}: nothing under the ${roof} is deep enough to carry a twist-lock at ${now} %.`;
    else if (wall) s = `Cut ${letter}: the ${roof} is ${mm1(wall.t)} mm thick here and slopes ${roundAngle(wall.slope)}° – too thin for a twist-lock at ${now} %.`;
    else s = `Cut ${letter}: the ${roof} has no room for a twist-lock at ${now} %.`;
    if (lock != null) {
      const at = Number.isFinite(opening) ? ` (a ${roundOpening(opening)} mm opening)` : '';
      if (tea != null && tea > lock) s += ` A twist-lock fits from ${lock} %${at}; a ${TEA_LIGHT} mm tea light needs ${tea} %.`;
      else if (tea === lock) s += ` A twist-lock fits from ${lock} %${at}, and takes a ${TEA_LIGHT} mm tea light.`;
      else s += ` A twist-lock fits from ${lock} %${at}.`;
    } else if (most != null) s += ` No twist-lock fits it up to ${most} %.`;
    if (base === 'now') s += ' The base can twist off with a lock at this size.';
    else if (base != null) s += ` The base can twist off from ${base} %.`;
    const many = partMany(name);
    return `${s} At this size the ${called} just ${name === 'Base' ? 'lifts out' : many ? 'lift off' : 'lifts off'}.`;
  },
  PART_PRINT: ({ piece = null, home = null, name, mech = 'twist', bridge = 0, slope = 1 }) => {
    const which = partPiece(piece, `the ${partCalled(name)}`);
    if (mech === 'plug') return `Print ${which} on its bottom, as saved. Its lock needs no support: every face it adds slopes at 45° or less, with no bridge.`;
    const s = `Print ${which} on its cut face, as saved. The lock needs no support: its slots and click tabs are bridged (${need1(bridge)} mm or less) – if your slicer puts support inside them, turn on "don't support bridges".`;
    // the collar under the joint slopes out as steeply as the model beside it does, up to 60° from upright
    const inside = partPiece(home, 'the model');
    if (!(slope > 1 + 1e-6)) return `${s} The collar under the joint inside ${inside} slopes at 45°, so it needs no support either.`;
    const like = name === 'Dome and cap' ? 'the dome' : 'the model round it';
    return `${s} The collar under the joint inside ${inside} slopes like ${like} (${roundAngle((Math.atan(slope) * 180) / Math.PI)}°), so it needs whatever support ${like} needs.`;
  },
  PART_FIT: ({ d = 0, grams = 0 }) => `Print the fit test first (Download fit test): two rings Ø ${roundOpening(d)} mm, about ${grams} g. If they won't twist together, raise the Clearance by 0.05 mm and print them again; if they rattle or don't click, lower it. Most printers need 0.15–0.25 mm, and PETG 0.25–0.3.`,
  PART_GAP: ({ letter, name, axis = 2, z = 0, gap = 0, need = 0.9, by = 'the model beside it', islands = 0, movedTo = null, nearest = null }) => {
    const where = `Cut ${letter}: at ${partAt(axis, z)} the ${partCalled(name)}'s`;
    // the face in pieces, or its edge too near what stands beside it (or running into it) to print apart
    const one = islands > 1;
    const s = one
      ? `${where} face is in ${islands} separate pieces – it needs one face to sit on.`
      : `${where} edge ${gap > 0 ? `is ${mm(gap)} mm from` : 'runs into'} ${by} – it needs ${mm(need)} mm to print apart.`;
    if (Number.isFinite(movedTo)) return `${s} Moved to ${partAt(axis, movedTo)}.`;
    const none = one ? 'No face near here is one piece' : 'No face near here leaves it';
    return `${s} ${none}${Number.isFinite(nearest) ? ` – the nearest that ${one ? 'is' : 'does'} is ${partAt(axis, nearest)}` : ''}.`;
  },
  PART_STUCK: ({ letter, name, over = null, beside = null, d = null }) => {
    const what = over && beside ? `${over} is over it and ${beside} is beside it` : 'the rest of the model closes it in';
    return `Cut ${letter}'s ${partCalled(name)} can't come out: ${what}. Try ${Number.isFinite(d) ? `a circle under Ø ${mm1(d)} mm` : 'a smaller circle'}, or a face higher up.`;
  },
  PART_SPLIT: ({ letter, name, pieces = 2, d = null, body = false }) => {
    const smaller = Number.isFinite(d) ? `make it smaller than Ø ${mm1(d)} mm` : 'make it smaller';
    if (body && !(pieces > 0)) return `Cut ${letter}'s circle takes the whole model – ${smaller} or use Find again.`;
    return body
      ? `Cut ${letter}'s circle leaves the rest of the model in ${pieces} pieces – ${smaller} or use Find again.`
      : `Cut ${letter}'s circle cuts the ${partCalled(name)} into ${pieces} pieces – ${smaller} or use Find again.`;
  },
  PART_MIXED: ({ letter }) => `Cut ${letter}'s circle crosses the model above and around its plane – use a full cut there, or move it to where the circle crosses only air.`,
  PART_CROSSED: ({ letter, part = '' }) => `Cut ${letter} runs through the part of cut ${part} – move one of them.`,
};

/**
 * A split note `{ level, code, text, …fields }` in the app's voice. The
 * fields each code reads are those of the design's notes table, plus:
 * SPLIT `{ pieces, dowels, diameter, length, lengths: [{ length, count }] (when the pins of that size come in more than
 * one length), sizes: [{ diameter, length, count }] (every group, when the pins come in more than one size), pegs,
 * pegSize, pegSizes: [{ size, count }] (when the built-in pegs come in more than one size), dovetails,
 * pairs: ['1A ↔ 2A'], apart: ['A'] }` (`dowels` counts every pin, `diameter` and `length` are the main size's; `pegs`
 * every peg; `apart` the letters of the cuts that come apart);
 * PINS `{ count, spares, diameter, length, own }`; DOVETAIL `{ letter, tabs, pieces, pegs, apart }` (`pegs`: the joints are
 * built-in pegs; `apart`: the cut comes apart, its tabs unglued);
 * APART `{ letter, cutId, axis, above, male, female, hold, clips, height, faces, flat, lying }` (a cut that comes
 * apart: `male` the pieces its lip stands out of, `female` those with its groove, `above` that the male is the piece
 * above a Z cut, `height` the lip's, `faces` how many of its faces have one, `flat` how many small ones just rest and
 * `lying` how many have no piece that may lie with a lip standing up);
 * APART_TWIST `{ letter, cutId, axis, above, male, female, turn, tabs }` (a cut that takes the collar twist-lock in place
 * of a lip with no clips: `male` the piece with its neck, `female` the one with its socket, `above` that the neck is on
 * the piece above a Z cut, `turn` its twist in degrees, `tabs` its clicks);
 * APART_NO_CLIPS `{ letter, cutId, axis, female, why: 'height'|'short'|'edge'|'flex'|'skin', height, need, suggestedAt }`
 * (a lip with no clips: `height` the lip's, `need` the room a lip with clips needs in the female, 'edge' its tongue
 * broken by an opening right beside the cut, `suggestedAt` where the cut has a full lip); APART_FLAT `{ letter, cutId,
 * axis, pieces, why: 'thin'|'room'|'lying'|'tall'|'small', wall, need, suggestedAt, by, fixed, piece, other }` (no lip
 * at all: `pieces` [below, above], `wall` the thinnest wall that takes one, `need` the room the smallest lip needs,
 * `by` the letters of the cuts whose lips already lie `fixed` another way, 'tall' piece `piece` too tall for the
 * printer with a lip and `other` printing worse with it); APART_HEAVY `{ letter, cutId, weight, hold, firmer }` (`weight` in g of what hangs
 * below a Z cut, `hold` the clips' in N, `firmer` the gentlest firmer hold that would hold it up, where one would); APART_KEPT `{ letters }`;
 * CONNECTORS_SHORTER `{ letter, depth, pegs }` (`pegs`: the cut has built-in pegs, `depth` their length);
 * CONNECTORS_FILAMENT `{ letter, count, diameter, length, lengths: [{ length, count }] }`
 * (`length` the longest; `lengths` when the holes take more than one); PEGS_SMALLER `{ letter, asked, pegSizes: [{ size,
 * count }] }` (`asked` the peg size chosen for the model, `pegSizes` the smaller ones the narrow faces took);
 * PEGS_UPRIGHT `{ letter, cutId, pieces, pins }` (`pieces` those carrying the cut's pegs, which all print pointing up;
 * `pins` that pins would fit its faces);
 * CONNECTORS_DROPPED `{ letter, count, total, wall, suggestedDiameter, dovetail, pegs, lying, thin }` (`lying`: the faces could
 * take pegs, but neither piece could lie on the bed carrying them; `thin`: only one piece has room for the sockets, and the
 * other, too thin for them, could not lie flat carrying the pegs); ONE_CONNECTOR `{ letter, pegs }`;
 * DOWELS_CAPPED `{ placed, dropped, pegs }`; LABELS_SKIPPED `{ letters }`;
 * PIECE_TOO_BIG `{ pieceIndex, size, bed }`; SMALL_PIECE `{ pieceIndex, thickness, letters, cutId }`;
 * CUTS_MERGED `{ letters, cutIds }`; SPLIT_CHECK `{ ratio }` (signed, (pieces − model) / model);
 * CUT_THROUGH_TEXT `{ itemId, cutId, letter, name, pieces, pairs }` (`pairs` the pieces either side of each stretch of
 * the cut that splits letters, when there is more than one); PART_SPANS_CUT `{ itemId, name, letter }`;
 * DOVETAIL_NOT_PLATE `{ letter, lying, pegs }` (`lying`: through a plate, but a piece beside it can't lie flat on it;
 * `pegs`: it has built-in pegs instead of pins);
 * ORIENT_FALLBACK `{ pieceIndex, mode, lies }`; PIECE_UNSTABLE `{ pieceIndex, pegs, lip }` (`pegs`, `lip`: only the
 * face its pegs or its lip stand out of was flat); PART_TOO_BIG `{ name, size, bed, pins }`
 * (a part printed separately, or with `pins` a single pin, too big for the bed); SPLIT_NOT_NEEDED `{ yaw, down, apart }`
 * (down other than '-z' when it fits only on its side; `apart` the letters of the cuts that come apart, when the pieces
 * they make fit); BED_TOO_SMALL `{ size, bed, pieces }`.
 * A cut that takes out a part (`name` the part's, "Dome and cap", "Top", "Base" or "Part B"): PART_LOCK `{ letter, cutId,
 * name, piece, home, handle, turn, lift, dir, span }` (part `piece` twist-locks onto piece `home` turning `turn`°, and
 * comes out lifted `lift` mm and slid along `dir`, under a handle spanning `span` – vectors in any frame, the two
 * alike); PART_PLUG `{ letter, cutId, name, piece, home, turn, opening, teaLight, model, seat }` (a base that twists off
 * underneath, its opening Ø `opening`; `model` what is turned over to fit it, "the lantern", else piece `home` – or,
 * when a tea light goes through it (`teaLight`), held up to fit it from underneath with the light standing on it, in
 * its tea-light seat with `seat` `{ d, depth, clears? }`, which may take the place of the model's own detail);
 * PART_SEAT `{ letter, cutId, name, piece, seat }` (a base with no lock and a tea-light seat); PART_NO_SEAT `{ letter,
 * cutId, name, piece, why, … }` (a base asked for a seat where none fits, `seatFor`'s refusal: `noSeatWords`);
 * PART_LIFTS `{ letter, cutId, name }` (it comes off and nothing holds it);
 * PART_SMALL `{ letter, cutId, name, why, now, wall, lock, opening, tea, most, base }` (asked to lock, but no twist-lock
 * fits at this size – `why` a lid's 'room', 'tabs' or 'collar', or a base's 'floor', 'wall' or 'cam' (no room for one),
 * `now` the size as a share of the model as loaded (%), `wall`
 * its roof's `{ t, slope }` – so it lifts off: a twist-lock fits from `lock` % with an opening Ø `opening`, a tea light
 * from `tea` %, none up to `most` %; `base` the least scale (%) the base's own lock needs, or 'now');
 * PART_PRINT `{ letter, cutId, name, piece, home, mech, bridge, slope }` (how a locked part prints: a collar
 * twist-lock's longest bridge `bridge` mm, its collar's slope `slope` in r per z; a base prints on its bottom);
 * PART_FIT `{ d, grams }` (the fit test's two rings, Ø `d`, about `grams` g);
 * PART_GAP `{ letter, cutId, name, axis, z, gap, need, by,
 * islands, movedTo, nearest }` (at `z` its edge is `gap` mm from what stands beside it, `by` – 0 when it runs into it
 * – where it needs `need` to print apart, or its face is in `islands` pieces: moved to `movedTo`, or refused, with
 * the `nearest` face that would do); PART_STUCK `{ letter, cutId, name, over, beside, d }` (no way out: what is over
 * it and beside it, and a circle under Ø `d` that would come out, where known); PART_SPLIT `{ letter, cutId, name,
 * pieces, d, body }` (the part, or with `body` the rest of the model, comes out in `pieces` pieces); PART_MIXED
 * `{ letter, cutId }`; PART_CROSSED `{ letter, cutId, part, partId }` (cut `letter` runs through the part of cut
 * `part`, which is left out).
 * Every field passed is kept on the note.
 */
export function splitNote(code, fields = {}) {
  const text = NOTE_TEXT[code];
  if (!text) throw new Error(`Unknown split note "${code}"`);
  return { level: NOTE_LEVELS[code], code, text: text(fields), ...fields };
}

// ---------- files and the glue sheet ----------

/** A name made safe for a file: anything but letters, digits, '.', '_' and '-' becomes '_'. */
export const safeFileName = (s) => String(s ?? '').replace(/[^\w.-]+/g, '_');

/** "bar-text-piece-1-of-2" (no extension). */
export const pieceFileName = (name, i, n) => `${safeFileName(name)}-piece-${i}-of-${n}`;

/** "pins-3x-6x19mm": the count (spares included), the diameter and the length; put the model's name in front. */
export const pinsFileName = (count, d, length) => safeFileName(`pins-${count}x-${mm(d)}x${mm(length)}mm`);

/** "bar-text-part-1-Logo" (no extension). */
export const partFileName = (name, k, partName) => `${safeFileName(name)}-part-${k}-${safeFileName(partName)}`;

/** "bar-text-2-pieces.zip". */
export const zipFileName = (name, n) => `${safeFileName(name)}-${n}-pieces.zip`;

/** "bar-text-how-to-glue.txt". */
export const glueFileName = (name) => `${safeFileName(name)}-how-to-glue.txt`;

const dowelCount = (seam) => (Array.isArray(seam.dowels) ? seam.dowels.length : Number(seam.dowels) || 0);
const pegCount = (seam) => (Array.isArray(seam.pegs) ? seam.pegs.length : Number(seam.pegs) || 0);

/**
 * The order to glue the pieces in, so that no step ever locks: the X seams
 * along each row, then the Y seams joining rows, then the Z seams joining
 * layers. Each step joins two rigid assemblies across one plane with
 * parallel pins (or pegs, which are parallel to the cut's normal too). The
 * cuts that come apart are never glued: they come last, once everything
 * else is set, each step saying so first.
 * @param {{ pieces: { index: number, cell: number[] }[], seams: { letter: string, axis: number, at: number, pieces: number[],
 *   joint: 'dowels'|'pegs'|'dovetail'|'lip'|'part'|'none', dowels: number|object[], pegs?: number|object[], male?: number|null,
 *   labels: string[]|null, apart?: { hold: string, lip: boolean, clips: number, mech?: 'twist'|'plug'|null, theta?: number,
 *   opening?: number, teaLight?: boolean, seat?: { d: number, depth: number, clears?: object } }|null,
 *   part?: { name: string, way?: { lift: number, dir: number[]|null }, span?: number[]|null }|null }[] }} plan
 *   piece numbers are 1-based; `labels` are the two faces' labels in the order of `pieces`; `male` the piece that carries
 *   a seam's built-in pegs, its lip, or the neck of the twist-lock it takes instead (`apart.mech` 'twist' on a cut with
 *   no part); `apart` on a seam of a cut that comes apart, and `part` on one that takes out a
 *   part (its pieces the one it comes out of, then the part; `apart.mech` the twist-lock it has, if any, turning
 *   `theta`°, and `part.way` how it comes out once turned free; a base whose opening Ø `apart.opening` takes a tea
 *   light (`apart.teaLight`) is fitted with a light standing on it, in its tea-light seat `apart.seat` when it has one)
 * @returns {{ letter: string, axis: number, pieces: number[], joins: number[], pins: number, pegs: number, text: string,
 *   apart?: true }[]} `pieces` already in place, `joins` the ones put on in this step; `apart` on a cut that comes apart
 */
export function assemblySteps({ pieces = [], seams = [] } = {}) {
  const cells = new Map(pieces.map((p) => [p.index, p.cell]));
  const groups = new Map();
  for (const seam of seams) {
    const a = seam.axis;
    let [p, q] = seam.pieces;
    let [lp, lq] = seam.labels ?? [null, null];
    if ((cells.get(p)?.[a] ?? 0) > (cells.get(q)?.[a] ?? 0)) {
      [p, q] = [q, p];
      [lp, lq] = [lq, lp];
    }
    const cell = cells.get(p) ?? [0, 0, 0];
    // the line of the grid this seam joins along: a row for X, a layer for Y, the whole stack for Z
    const line = a === 0 ? [cell[2], cell[1]] : a === 1 ? [cell[2], 0] : [0, 0];
    const key = `${a}|${line.join(',')}|${seam.letter}`;
    // a cut that comes apart goes on after every glued one
    const apart = seam.apart ? 1 : 0;
    if (!groups.has(key)) groups.set(key, { sort: [apart, a, ...line, seam.at ?? 0], letter: seam.letter, axis: a, seams: [] });
    groups.get(key).seams.push({ p, q, lp, lq, joint: seam.joint, pins: dowelCount(seam), pegs: pegCount(seam), male: seam.male ?? null, apart: seam.apart ?? null, part: seam.part ?? null });
  }
  const list = [...groups.values()].sort((g, h) => {
    for (let i = 0; i < g.sort.length; i++) if (g.sort[i] !== h.sort[i]) return g.sort[i] - h.sort[i];
    return 0;
  });
  return list.map(({ letter, axis, seams: group }) => {
    group.sort((s, t) => s.p - t.p || s.q - t.q);
    const lower = [...new Set(group.map((s) => s.p))];
    const upper = [...new Set(group.map((s) => s.q))];
    const pins = group.reduce((n, s) => n + s.pins, 0);
    const pegs = group.reduce((n, s) => n + s.pegs, 0);
    const apart = group.some((s) => s.apart);
    return { letter, axis, pieces: lower, joins: upper, pins, pegs, text: stepText(letter, group, lower, upper, pins, axis), ...(apart ? { apart: true } : {}) };
  });
}

const pieceList = (list) => `${list.length > 1 ? 'pieces' : 'piece'} ${listOf(list)}`;

/** A sentence's first letter made a capital. */
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The step for a cut that comes apart, starting with what matters most:
 * that it is not glued. The top of a Z cut is pressed on until it clicks, or
 * set on its lip; across X or Y the piece beyond the cut is pressed onto the
 * one before it.
 */
function apartStepText(letter, group, lower, upper, axis) {
  const lead = `Do not glue cut ${letter}: it comes apart.`;
  // a part that comes off sits in its own place on the piece it came out of, and twist-locks there when it can
  const held = group.find((s) => s.part);
  if (held) {
    const { part, apart } = held;
    if (apart?.mech === 'twist') return `${lead} ${part.name}: ${twistOn(apart.theta)} To open: turn it left until it clicks again, ${wayWords(part.way, part.span)}.`;
    if (apart?.mech === 'plug') {
      const called = partCalled(part.name);
      const turnIn = `set the ${called} in turned ${roundAngle(apart.theta)}° to the left, push in and turn it right until it clicks (a coin in the slot helps)`;
      // a light standing on it, in its seat or not: the base goes in from underneath, the model held up, so the light
      // stays on it
      const fit = `hold ${pieceList(lower)} up and, looking at the ${called}'s bottom, ${turnIn}. To open: turn it left and lower it out.`;
      if (apart.seat) return `${lead} ${part.name}: ${seatWords(apart.seat, `the ${called}`)} – stand the light in it, ${fit}`;
      if (apart.teaLight) return `${lead} ${part.name}: its Ø ${roundOpening(apart.opening)} mm opening takes a ${TEA_LIGHT} mm tea light – stand the light on the middle of the ${called}, ${fit}`;
      return `${lead} ${part.name}: turn ${pieceList(lower)} over, ${turnIn}. To open: turn it left and lift it out.`;
    }
    const seated = apart?.seat ? ` ${capital(seatWords(apart.seat, `the ${partCalled(part.name)}`))}.` : '';
    return `${lead} Set the ${partCalled(part.name)} in place on ${pieceList(lower)} – nothing holds ${partMany(part.name) ? 'them' : 'it'}.${seated}`;
  }
  const z = axis === 2;
  const top = upper.length > 1 ? `the top (${pieceList(upper)})` : 'the top';
  // a cut with the collar twist-lock in place of its lip: the piece with the socket goes on the neck, turned
  const twisted = group.find((s) => s.apart?.mech === 'twist');
  if (twisted) {
    const socket = twisted.male === twisted.p ? twisted.q : twisted.p;
    const who = z && socket === twisted.q ? top.replace(/^t/, 'T') : `Piece ${socket}`;
    return `${lead} ${who}: ${twistOn(twisted.apart.theta)} To open: turn it left until it clicks again and lift it off.`;
  }
  // across X or Y, several pieces beyond the cut go on together
  const many = !z && upper.length > 1;
  const verb = (one, more) => (many ? more : one);
  const lip = group.filter((s) => s.joint === 'lip');
  const oneWay = `${verb('It goes', 'They go')} on one way round only – turn ${verb('it', 'them')} until ${verb('it drops', 'they drop')} onto the lip.`;
  if (lip.some((s) => s.apart.clips > 0 && s.apart.hold === 'lock')) {
    // it takes a firm pull to come off: the seated top hides the key's gap, so there is nowhere to lever it
    const press = z ? `Press ${top} on until it clicks` : `Press ${pieceList(upper)} onto ${pieceList(lower)} until ${verb('it clicks', 'they click')}`;
    return `${lead} ${press} – ${verb('it locks', 'they lock')}; pull hard to open it. ${oneWay}`;
  }
  if (lip.some((s) => s.apart.clips > 0 && s.apart.hold !== 'lift')) {
    const press = z ? `Press ${top} on until it clicks.` : `Press ${pieceList(upper)} onto ${pieceList(lower)} until ${verb('it clicks', 'they click')}.`;
    return `${lead} ${press} ${oneWay}`;
  }
  if (lip.length) {
    const set = z ? `Set ${top} on its lip` : `Set ${pieceList(upper)} against ${pieceList(lower)} on the lip`;
    return `${lead} ${set} – ${verb('it goes', 'they go')} on one way round only – and lift ${verb('it', 'them')} off to open it.`;
  }
  if (group.every((s) => s.joint === 'dovetail')) {
    return `${lead} Lay ${pieceList([...lower, ...upper])} flat and lower ${pieceList(upper)}'s tabs into ${pieceList(lower)}; lift ${verb('it', 'them')} out to take it apart.`;
  }
  const set = z ? `Set ${top} on ${pieceList(lower)}` : `Set ${pieceList(upper)} against ${pieceList(lower)}`;
  return `${lead} ${set} and line the edges up – nothing holds ${verb('it', 'them')}.`;
}

function stepText(letter, group, lower, upper, pins, axis) {
  if (group.some((s) => s.apart)) return apartStepText(letter, group, lower, upper, axis);
  if (group.every((s) => s.joint === 'dovetail')) {
    return `Cut ${letter}: a thin film of glue on the tabs, lay ${pieceList(lower)} flat and lower ${pieceList(upper)} onto ${lower.length > 1 ? 'them' : 'it'}. Hold 1 minute.`;
  }
  const lowerLabels = group.map((s) => s.lp).filter(Boolean);
  const upperLabels = group.map((s) => s.lq).filter(Boolean);
  const faces = group.length > 1 ? 'faces' : 'face';
  const pegged = group.filter((s) => s.pegs > 0);
  if (pegged.length) {
    // the piece with the sockets takes the glue; the one carrying the pegs is pushed in
    const female = pegged.map((s) => (s.male === s.p ? { piece: s.q, label: s.lq } : { piece: s.p, label: s.lp }));
    const male = pegged.map((s) => (s.male === s.p ? { piece: s.p, label: s.lp } : { piece: s.q, label: s.lq }));
    const labelled = female.every((f) => f.label);
    const into = labelled ? `${female.length > 1 ? 'faces' : 'face'} ${listOf(female.map((f) => f.label))}` : pieceList([...new Set(female.map((f) => f.piece))]);
    const owners = [...new Set(male.map((m) => m.piece))];
    const marks = male.map((m) => m.label).filter(Boolean);
    // faces of the cut too narrow for a peg are glued flat in the same step: their pieces are told of too
    const flat = group.filter((s) => !(s.pegs > 0));
    const also = flat.length
      ? ` and press ${pieceList([...new Set(flat.map((s) => s.q))])} onto ${pieceList([...new Set(flat.map((s) => s.p))])}`
      : '';
    return `Cut ${letter}: a little glue in the sockets of ${into} and on the ${faces}, push ${pieceList(owners)}'s pegs${marks.length ? ` (${marks.join(', ')})` : ''} in${also}. Hold 1 minute.`;
  }
  if (pins > 0) {
    const into = lowerLabels.length ? `${lowerLabels.length > 1 ? 'faces' : 'face'} ${listOf(lowerLabels)}` : pieceList(lower);
    const onto = upperLabels.length ? ` (${upperLabels.join(', ')})` : '';
    return `Cut ${letter}: glue ${plural(pins, 'pin')} into ${into}, a thin film on the ${faces}, push ${pieceList(upper)} on${upper.length > 1 ? ' together' : ''}${onto}. Hold 1 minute.`;
  }
  return `Cut ${letter}: a thin film of glue on the ${faces}, press ${pieceList(upper)} onto ${pieceList(lower)} and line the edges up. Hold until it sets.`;
}

const pad = (s, n) => (s.length >= n ? `${s}   ` : s + ' '.repeat(n - s.length + 3));
const size1 = (dims) => `${dims.map((v) => v.toFixed(1)).join(' × ')} mm`;

/**
 * The glue sheet that goes in the zip: what to print, a dry fit, and the
 * glue steps in an order that never locks – or, when no two pieces touch
 * (cuts only between letters), that there is nothing to glue. The cuts that
 * come apart are put together last, under a heading that says not to glue
 * them (or that nothing is glued, when no other cut is).
 * @param {{ name: string, pieces: { index: number, cell: number[], size: number[], lies: string, yaw?: number, fits?: boolean, shells?: number,
 *   part?: string, name?: string, lids?: string[] }[],
 *   seams: object[], pins?: { d: number, length: number, count: number, spares?: number, own?: boolean }[],
 *   parts?: { name: string }[], clearance?: number, bed?: number[], printer?: { size: number[], margin: number }|null, steps?: object[],
 *   bridges?: number[] }} plan
 *   `seams` as for `assemblySteps`; a piece that is a part taken out has its cut's id (`part`), its `name` and the
 *   cut's letter (`lids`); `pins` one group per pin size (count without spares); `bed` the usable bed;
 *   `printer` the printer itself, when known, for the heading; `bridges` the clips' bridges' lengths as built (each
 *   hold's own on a 1.6 mm tongue when not given)
 * @returns {string}
 */
export function howToGlueText(plan) {
  const { name = 'model', pieces = [], seams = [], parts = [], clearance = SPLIT_DEFAULTS.clearance, bed = null, printer = null } = plan;
  const pins = (Array.isArray(plan.pins) ? plan.pins : plan.pins ? [plan.pins] : []).filter((g) => g.count > 0);
  const steps = plan.steps ?? assemblySteps({ pieces, seams });
  const n = pieces.length;
  const anyPins = seams.some((s) => dowelCount(s) > 0);
  const anyPegs = seams.some((s) => pegCount(s) > 0);
  const anyTabs = seams.some((s) => s.joint === 'dovetail');
  // the cuts that come apart on a lip, each once: whether it clicks on (or twist-locks, the collar twist-lock in place
  // of a lip with no clips), the pieces with the lip and those that come off it – the top of a Z cut, whichever has
  // the lip, and across X or Y the piece that goes on the other's lip
  const lips = new Map();
  for (const s of seams) {
    if (s.joint !== 'lip' || !s.apart) continue;
    const lip = lips.get(s.letter) ?? { letter: s.letter, axis: s.axis, clicks: false, twist: false, hold: s.apart.hold, male: new Set(), off: new Set() };
    if (s.apart.clips > 0 && s.apart.hold !== 'lift') lip.clicks = true;
    if (s.apart.mech === 'twist') lip.twist = true;
    const [p, q] = s.pieces;
    const male = s.male ?? p;
    lip.male.add(male);
    lip.off.add(s.axis === 2 ? q : male === p ? q : p);
    lips.set(s.letter, lip);
  }
  const anyLip = lips.size > 0;
  const anyClips = [...lips.values()].some((l) => l.clicks);
  // the parts that twist-lock in their own place: a lid's collar twist-lock, or a base's from underneath
  const locked = seams.filter((s) => s.joint === 'part' && s.apart?.mech && s.part);
  // the bases with a tea-light seat on their top, whatever holds them
  const seated = seams.filter((s) => s.joint === 'part' && s.apart?.seat && s.part);
  const anyTwist = [...lips.values()].some((l) => l.twist) || locked.length > 0;
  const plainLips = [...lips.values()].some((l) => !l.twist);
  const where = printer?.size
    ? `a ${formatSize(printer.size)} printer${printer.margin ? ` (${mm(printer.margin)} mm margin)` : ''}`
    : bed ? `a printer with room for ${formatSize(bed)}` : 'your printer';
  const out = [`${name} – ${plural(n, 'piece')} for ${where} – STL Text`, ''];

  const unsupported = [anyPins && 'holes', anyPegs && 'pegs and sockets', plainLips && (anyClips ? 'lips and clips' : 'lips'), anyTwist && 'twist-locks'].filter(Boolean);
  out.push(`PRINT (each file is already turned the way to print it${unsupported.length ? `; ${listOf(unsupported)} need no supports` : ''})`);
  const sizes = pieces.map((p) => size1(p.size));
  const width = Math.max(0, ...sizes.map((s) => s.length));
  [...pieces].sort((p, q) => p.index - q.index).forEach((p) => {
    const extra = [p.fits === false ? 'TOO BIG for this printer' : 'fits'];
    if (p.yaw && p.yaw !== 90) extra.push(`turned ${p.yaw}° to fit`); // a quarter turn is already in the file and looks ordinary
    if (p.shells > 1) extra.push(`${p.shells} parts`);
    for (const l of lips.values()) {
      if (l.male.has(p.index)) extra.push(`${l.twist ? 'twist-lock neck' : 'lip'} for cut ${l.letter}`);
      if (l.off.has(p.index)) extra.push(`comes off at cut ${l.letter}`);
    }
    for (const x of locked) if (x.pieces[0] === p.index) extra.push(`${x.apart.mech === 'plug' ? 'twist-lock slots' : 'twist-lock neck'} for cut ${x.letter}`);
    if (p.part) extra.push(`comes off at cut ${listOf(p.lids ?? [])} (the ${partCalled(p.name)})`);
    for (const x of seated) if (x.pieces[1] === p.index) extra.push(`tea-light seat Ø ${mm1(x.apart.seat.d)} mm on top`);
    out.push(`  ${pad(`piece ${p.index} of ${n}`, 12)}${pad(size1(p.size), width)}${pad(`lies ${p.lies}`, 0)}${extra.join(', ')}`);
  });
  // a lid's collar slopes out under the joint as steeply as the model beside it: support the dome, support the collar
  for (const x of locked.filter((y) => y.apart.mech === 'twist' && y.apart.slope > 1 + 1e-6)) {
    const like = x.part.name === 'Dome and cap' ? 'the dome' : 'the model round it';
    out.push(`  The collar under cut ${x.letter}'s neck slopes like ${like} (${roundAngle((Math.atan(x.apart.slope) * 180) / Math.PI)}°): it takes whatever support ${like} takes.`);
  }
  const indent = ' '.repeat(17);
  for (const g of pins) {
    const spares = g.spares ?? 0;
    if (g.d === FILAMENT) out.push(`  ${pad('filament', 12)}cut ${plural(g.count, 'piece')} of 1.75 mm filament ${mm(g.length)} mm long`);
    else if (g.own) out.push(`  ${pad('pins', 12)}not printed – cut ${g.count} Ø${mm(g.d)} mm dowels to ${mm(g.length)} mm (wood or steel)`);
    else {
      const spare = spares ? ` (${spares === 1 ? 'one spare' : `${spares} spares`})` : '';
      out.push(`  ${pad('pins', 12)}${g.count + spares} × Ø${mm(g.d)} × ${mm(g.length)} mm${spare}, lying on a flat side, solid (4+ walls)`);
      out.push(`${indent}or Ø${mm(g.d)} mm wooden dowels cut to ${mm(g.length)} mm`);
    }
  }
  parts.forEach((part, i) => out.push(`  ${pad(`part ${i + 1}`, 12)}${quoted(part.name)} – prints separately; glue it on after the pieces`));
  if (anyClips) {
    // a lock's bridges are shorter than the others' – longer again where a wide nozzle makes its clips thicker
    const spans = [...new Set(plan.bridges ?? [...lips.values()].filter((l) => l.clicks).map((l) => clipShape(l.hold)?.span ?? CLIP.span))].sort((a, b) => a - b);
    out.push(`  Clips are ${listOf(spans.map(mm))} mm bridges over a slot: print with bridging on (the default) and no supports.`);
  }
  if (anyPins || anyPegs || anyTabs || anyLip || locked.length) out.push('  Not sure about the fit? Print the fit test first (Split card → Download fit test).');
  out.push('');

  if (!steps.length) {
    // the cuts ran only through gaps (between the letters of a sign, say): no two pieces touch
    out.push('NOTHING TO GLUE');
    out.push('  The cuts run through gaps, so no two pieces touch. Lay them out as in the model – on a backing board to keep them together.');
    return `${out.join('\n')}\n`;
  }

  out.push('DRY-FIT FIRST');
  if (anyPins) out.push('  Pins should slide in by hand. Too tight: raise Clearance by 0.05 mm and download again.');
  if (anyPegs) out.push('  Pegs should push into their sockets by hand. Too tight: raise Clearance by 0.05 mm and download again.');
  if (anyTabs) out.push('  Tabs should drop into their sockets by hand. Too tight: raise Clearance by 0.05 mm and download again.');
  for (const l of lips.values()) {
    const off = [...l.off].sort((p, q) => p - q);
    const who = l.axis === 2 ? `The top of cut ${l.letter}` : `${off.length > 1 ? 'Pieces' : 'Piece'} ${listOf(off)} of cut ${l.letter}`;
    const its = l.axis !== 2 && off.length > 1 ? 'their' : 'its';
    if (l.twist) {
      out.push(`  ${who} should twist on with a click and twist off again by hand. Too stiff to turn: raise Clearance by 0.05 mm; loose, or no click: lower it by 0.05 mm, and download again.`);
    } else if (!l.clicks) out.push(`  ${who} should drop onto ${its} lip and lift off freely.`);
    else if (l.hold === 'lock') {
      out.push(`  ${who} should lock onto ${its} lip and come off only with a firm pull. Too stiff to open: raise Clearance by 0.05 mm (or set the cut to Clicks on); too loose: lower it by 0.05 mm, and download again.`);
    } else {
      const lighter = l.hold === 'light' ? '' : ' (or set the cut to Light click)';
      out.push(`  ${who} should click onto ${its} lip and pull off again by hand. Too stiff: raise Clearance by 0.05 mm${lighter}; no click or too loose: lower it by 0.05 mm, and download again.`);
    }
  }
  for (const x of locked) {
    const who = `The ${partCalled(x.part.name)} (cut ${x.letter})`;
    if (x.apart.mech === 'plug') {
      out.push(`  ${who} should twist in with a click and twist out again by hand. Too stiff to turn: raise Clearance by 0.05 mm; loose, or no click: lower it by 0.05 mm, and download again.`);
    } else {
      out.push(`  ${who} should twist on with a click and twist off again by hand. Try the fit test first: if it's too stiff to turn, raise Clearance by 0.05 mm; if it rattles or doesn't click, lower it.`);
    }
  }
  for (const x of seated) out.push(`  A ${TEA_LIGHT} mm tea light should drop into the seat on top of the ${partCalled(x.part.name)} (cut ${x.letter}) and lift out with two fingers.`);
  if (!anyPins && !anyPegs && !anyTabs && !anyLip && !locked.length) out.push('  Hold the pieces together and check that the faces meet all round.');
  out.push('');

  // the glued steps, then those of the cuts that come apart, numbered on
  const glued = steps.filter((s) => !s.apart);
  const loose = steps.filter((s) => s.apart);
  if (glued.length) {
    const pairs = seams.filter((s) => s.labels?.length === 2).map((s) => `${s.labels[0]} ↔ ${s.labels[1]}`);
    const room = anyPins || anyPegs ? `; ${anyPins ? 'holes' : 'sockets'} have ${mm(clearance)} mm of room per side` : '';
    out.push(`GLUE – ${pairs.length ? 'put each letter on the same letter' : 'in this order'} (medium/thick CA or 5-minute epoxy${room})`);
    if (pairs.length) out.push(`  Matching faces: ${pairs.join(', ')}`);
    glued.forEach((s, i) => out.push(`  ${i + 1}. ${s.text}`));
  }
  if (loose.length) {
    if (glued.length) out.push('');
    out.push(glued.length ? 'LAST – DO NOT GLUE' : 'PUT TOGETHER – nothing is glued');
    loose.forEach((s, i) => out.push(`  ${glued.length + i + 1}. ${s.text}`));
  }
  return `${out.join('\n')}\n`;
}

// ---------- the viewer ----------

/** Cut planes, their badges and the card's letters. */
export const CUT_COLOR = 0x8b5cf6;

/** The planes and badges of the cuts that come apart: teal, so a joint that is never glued stands out. */
export const APART_COLOR = 0x0d9488;

/**
 * Piece colours: cool shades at even indices, warm at odd ones, so that
 * `pieceColorIndex` makes neighbours across any cut contrast.
 */
export const PIECE_COLORS = Object.freeze([0x4f8fe6, 0xe88d67, 0x5aa469, 0xd977b7, 0x7f8fa6, 0xc7b06b]);

/** Printed pins in the pieces view. */
export const PIN_COLOR = 0xb8bcc8;

/** The emissive tint of a piece too big for the bed. */
export const TOO_BIG_COLOR = 0x551111;

const mod = (v, m) => ((v % m) + m) % m;

/**
 * The colour of a cell's piece in `PIECE_COLORS`: the family (cool or warm)
 * by the parity of i + j + k, so pieces either side of a cut always differ,
 * and the shade from a small hash. It depends only on the cell, so the live
 * preview and the computed pieces agree.
 */
export const pieceColorIndex = ([i, j, k]) => mod(i + j + k, 2) + 2 * mod(7 * i + 3 * j + 5 * k, 3);

/**
 * How far a cell moves in the exploded view: Σ (cell − cuts/2)·gap along
 * each axis, so the pieces move apart evenly and each cut stays in the
 * middle of its gap. A pin uses the half-cell between its two pieces.
 * @param {number[]} cell [i, j, k]
 * @param {number[]} grid the number of cuts per axis
 * @param {number} gap mm between neighbours
 */
export const explodeOffset = (cell, grid, gap) => [0, 1, 2].map((a) => (cell[a] - grid[a] / 2) * gap + 0);

/**
 * Where a part's piece is drawn along its way out (a part seam's `part.way`) at `f`, the Spread slider: 0 seated, 1
 * out. The way's steps share 0 … 1 evenly – turned free about the way out (anticlockwise, the way it opens), lifted,
 * then slid out under what stands over it – leaving out those it has not: a part that only lifts off is not turned,
 * and one that comes straight off, or a base that drops out underneath, is not slid but moved `drop` along the way out
 * (the viewer's: its own length that way and a gap) – at least its lift. Past 1 it goes on the same way, as far again
 * by 2.
 * @param {{ turn: number, up: boolean, lift: number|null, dir: number[]|null, out: number[], reach: number }} way
 * @param {number} f
 * @param {number} drop mm
 * @returns {{ turn: number, offset: number[] }} degrees about `way.out`, and the move (mm)
 */
export function wayAt(way, f, drop = 0) {
  const slides = waySlides(way);
  const steps = waySteps(way);
  const share = (step) => (steps.includes(step) ? clamp01(f * steps.length - steps.indexOf(step)) : 0);
  const on = Math.max(0, f - 1);
  const lift = slides ? (way.lift ?? 0) * share('lift') : Math.max(way.lift ?? 0, drop) * (share('lift') + on);
  const slide = slides ? way.reach * (share('slide') + on) : 0;
  return {
    turn: (way.turn || 0) * share('turn'),
    offset: [0, 1, 2].map((a) => way.out[a] * lift + (slides ? way.dir[a] * slide : 0) + 0),
  };
}

/** Whether a part's way out slides it out sideways once lifted (not straight off, nor dropped out underneath). */
const waySlides = (way) => !way.up && !!way.dir;

/** The steps of a part's way out, in order (`wayAt`): 'turn' when it locks, 'lift', 'slide' when it slides out. */
export const waySteps = (way) => [...(way.turn ? ['turn'] : []), 'lift', ...(waySlides(way) ? ['slide'] : [])];

/**
 * Which step of its way out a part is on at `f` (`wayAt`): `{ step, n, of }`, the step and its number of how many;
 * null when it is seated (f 0) or out (f 1 or more).
 */
export function wayStep(way, f) {
  const steps = waySteps(way);
  if (!(f > 0) || f >= 1) return null;
  const k = Math.min(steps.length - 1, Math.floor(f * steps.length));
  return { step: steps[k], n: k + 1, of: steps.length };
}

/** A face of a lock that slopes further than this from vertical overhangs: past 45°, with a little rounding. */
const OVERHANG_NZ = -Math.sin((46.5 * Math.PI) / 180);
/** A face of a lock that faces down within this of straight down is a flat ceiling the printer bridges. */
const BRIDGE_NZ = -Math.cos((10 * Math.PI) / 180);

/**
 * What a face of a lock is as its piece prints, from the up component of its normal as it lies on the bed: a flat
 * ceiling the printer bridges ('bridge'), a face sloping further than 45° from vertical ('over', which needs support
 * as the model beside it does), else nothing to say (null). A face on the bed is none of them.
 * @param {number} nz the normal's z as printed
 * @param {boolean} onBed the face lies on the bed
 */
export function printedFace(nz, onBed = false) {
  if (onBed || !(nz < OVERHANG_NZ)) return null;
  return nz <= BRIDGE_NZ ? 'bridge' : 'over';
}

/**
 * The pieces laid in a row as they print, each its width along x apart with `gap` between: the x of each one's
 * middle, the row centred on 0.
 * @param {number[]} widths each piece's width along x as it lies (mm)
 * @param {number} gap mm
 * @returns {number[]}
 */
export function printedRow(widths, gap) {
  const total = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1);
  let x = -total / 2;
  return widths.map((w) => {
    const middle = x + w / 2;
    x += w + gap;
    return middle + 0;
  });
}

/**
 * Where along a cut's normal line (through p) the pointer's ray passes
 * closest, as a distance from p: dragging a cut's handle follows it. Null
 * when the ray runs (almost) along the normal and gives no position.
 * @param {number[]} o the ray's origin
 * @param {number[]} r the ray's direction
 * @param {number[]} p a point on the normal line (the handle)
 * @param {number[]} n the cut's normal
 */
export function offsetAlongRay(o, r, p, n) {
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const w = [o[0] - p[0], o[1] - p[1], o[2] - p[2]];
  const a = dot(r, r);
  const b = dot(r, n);
  const c = dot(n, n);
  const den = a * c - b * b;
  if (!(den > 1e-6 * a * c)) return null;
  return (a * dot(n, w) - b * dot(r, w)) / den;
}
