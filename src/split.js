/**
 * Split for printing, the pure half: plain JavaScript on plain data, with no
 * Manifold and no three.js, so the main thread, the viewer and the worker
 * share one copy of the rules. It holds the printer's bed, how cuts are read
 * and checked, the frames the geometry is built in, where Fit to my printer
 * puts its cuts, where pins go on a face, how each piece lies on the bed,
 * the colours of the pieces, the file names and the glue sheet.
 *
 * Conventions used throughout:
 *  - an axis is 0, 1 or 2 (x, y, z); a direction is one of '+x' … '-z';
 *  - a cut as the document stores it is `{ id, position, normal }`; once
 *    normalised it is `{ id, letter, axis, at }`;
 *  - matrices are 16 numbers, column-major, like `toMat4` and
 *    `Manifold.transform`;
 *  - a cell is `[i, j, k]`, the slot of a piece in the grid the cuts make;
 *  - piece numbers are 1-based, as in "piece 2 of 3" and the label "2A".
 */

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

/** A split's settings as the document stores them (`cuts` hold `{ id, position, normal }` in model mm). */
export const SPLIT_DEFAULTS = Object.freeze({
  cuts: Object.freeze([]),
  joint: 'auto', // 'auto' | 'dowels' | 'dovetail' | 'none'
  diameter: 0, // mm: 0 = auto | 1.75 (filament) | 3 | 4 | 5 | 6 | 8 | 10
  depth: 0, // mm per side: 0 = auto | 3–30
  clearance: 0.15, // mm per side (radial), on holes and dovetail sockets only
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

export const JOINTS = Object.freeze(['auto', 'dowels', 'dovetail', 'none']);
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
 * Settings clamped to their ranges, and the cuts snapped to the axes,
 * checked against the model and put in their canonical order (x, then y,
 * then z, then position). Each cut keeps the letter of its place in the
 * stored list, so letters never jump about when a cut is left out.
 * @param {object|null} split the document's split (missing fields take their defaults)
 * @param {{ min: number[], max: number[] }|null} bounds the solid's bounds with the unrepaired triangles; null skips the miss test
 * @returns {{ spec: object, cuts: { id: string, letter: string, axis: number, at: number }[], notes: object[], grid: number[] }}
 *   `spec` holds the clamped settings (no cuts), `grid` the number of cuts on each axis. No cuts left means: export unsplit, with the notes.
 * @throws {SplitError} `SPLIT_INVALID` for more than 12 cuts or 64 pieces
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
  (Array.isArray(s.cuts) ? s.cuts : []).forEach((cut, index) => {
    const letter = letterFor(index);
    const id = cut?.id ?? `c${index + 1}`;
    const plane = snapCut(cut);
    if (!plane.straight) {
      notes.push(splitNote('CUT_NOT_STRAIGHT', { cutId: id, letter }));
      return;
    }
    const { axis, at } = plane;
    const misses = !Number.isFinite(at) || (bounds && (at <= bounds.min[axis] + CUT_TOLERANCE || at >= bounds.max[axis] - CUT_TOLERANCE));
    if (misses) {
      notes.push(splitNote('CUT_MISSES', { cutId: id, letter }));
      return;
    }
    kept.push({ id, letter, axis, at, index });
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
    return { id, letter, axis, at };
  });
  cuts.sort((a, b) => a.axis - b.axis || a.at - b.at);
  const grid = [0, 1, 2].map((a) => cuts.filter((c) => c.axis === a).length);
  const cells = (grid[0] + 1) * (grid[1] + 1) * (grid[2] + 1);
  if (cuts.length > SPLIT_LIMITS.cuts || cells > SPLIT_LIMITS.cells) {
    throw new SplitError('SPLIT_INVALID', `A split can have up to ${SPLIT_LIMITS.cuts} cuts and ${SPLIT_LIMITS.cells} pieces – remove some cuts.`, { cuts: cuts.length, cells });
  }
  return { spec, cuts, notes, grid };
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
 * @param {{ flat?: number|null, grow?: number[] }} options `flat` as for `fitsBed` (every piece lies flat on that
 *   axis); `grow` how far the pieces reach past each cut on each axis (dovetail tabs, see `evenCell`)
 * @returns {{ k: number[], pieces: number }[]}
 */
export function gridCandidates(E, U, { flat = null, grow = [0, 0, 0] } = {}) {
  const found = [];
  const most = [0, 1, 2].map((a) => (a === flat ? 0 : SPLIT_LIMITS.cuts));
  for (let kx = 0; kx <= most[0]; kx++) {
    for (let ky = 0; ky <= most[1]; ky++) {
      for (let kz = 0; kz <= most[2]; kz++) {
        const pieces = (kx + 1) * (ky + 1) * (kz + 1);
        if (pieces > SPLIT_LIMITS.cells || kx + ky + kz > SPLIT_LIMITS.cuts) break; // more Z cuts only make more
        const k = [kx, ky, kz];
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
 * What the pieces of a model with extents E will be allowed, for counting
 * them before anything has been sliced (the "Split into N pieces" note): a
 * thin plate lies flat, and when its joints may be dovetails (Auto or
 * Dovetails, 2–10 mm thick, no unrepaired triangles) every cut across it
 * makes the pieces either side a tab's length longer. The engine's own plan
 * looks at each cut face instead.
 * @param {number[]} E the model's extents
 * @param {{ joint?: string }} spec the split's settings
 * @param {{ passthrough?: boolean }} options whether the model has unrepaired triangles (they rule dovetails out)
 * @returns {{ flat: number|null, grow: number[] }} the options of `gridCounts`
 */
export function planAllowance(E, spec = {}, { passthrough = false } = {}) {
  const flat = plateAxis(E);
  const grow = [0, 0, 0];
  const joint = spec?.joint ?? SPLIT_DEFAULTS.joint;
  if (flat !== null && !passthrough && (joint === 'auto' || joint === 'dovetail') && E[flat] >= PLATE_THICKNESS.min) {
    for (let a = 0; a < 3; a++) if (a !== flat) grow[a] = dovetailSize(E[3 - a - flat])?.E ?? 0;
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
  const lying = slab === null ? 0 : gridCounts(E, U, { flat: slab }).pieces;
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
  islands: 2, // each island needs its own pins
  noRoom: 5, // prefer faces that take pins
  perimeter: 1, // seam length: the glue line and how much it shows
  // per even piece's length a cut moves from its even position: uneven pieces must buy something real. Above the
  // perimeter's pull on purpose: on a round shell every slice has the same area and only the ring shrinks towards
  // the ends, so a weaker pull sends every cut to the end of its room, a sliver beside a piece too big to fit
  even: 2,
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
 * @param {{ t: number, area: number, perimeter: number, islands: number, noRoom: number, letters: boolean,
 *   nearLetters?: boolean }[]} profile sorted by t: the slice's area and perimeter, its islands, the share of its area
 *   (0–1) in islands with no room for two pins, whether any letter's solid is cut there, and whether one is within
 *   2 mm (looked at apart from the samples; when it is not given, the samples within 2 mm tell)
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
    cost += W.islands * Math.max(0, (p.islands ?? 1) - 1);
    cost += W.noRoom * clamp(Number(p.noRoom), 0, 1, 0);
    if (medianP > 0) cost += (W.perimeter * (p.perimeter || 0)) / medianP;
    return cost;
  });
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
 * `Sflat` once their tabs are counted.
 * @param {number[]} samples positions, ascending (from `planSamples`)
 * @param {number[]} costs one per sample (from `planCost`)
 * @param {{ lo: number, hi: number, k: number, S?: number, Sflat?: number, minEnd?: number, minMid?: number,
 *   grow?: ({ below: number, above: number }|null)[] }} limits
 *   lo/hi the model's extent on the axis, S the longest piece that fits (`maxCellLength`), Sflat the longest that fits
 *   lying flat; `grow` per sample, for a cut there with dovetail tabs, how far the piece below it (`below`) and the
 *   piece above it (`above`) reach past it. The minimums are for the pieces between the cuts, tabs left out.
 * @returns {{ offsets: number[], cost: number, relaxed: boolean }|null} null when no choice keeps every piece within S
 */
export function chooseOffsets(samples, costs, { lo, hi, k, S = Infinity, Sflat = S, minEnd = 0, minMid = 0, grow = null }) {
  const n = samples.length;
  const E = hi - lo;
  const tol = 1e-6;
  const even = (j) => lo + (E * (j + 1)) / (k + 1);
  const cell = E / (k + 1) || 1;
  const own = (i, j) => costs[i] + (PLAN_WEIGHTS.even * Math.abs(samples[i] - even(j))) / cell;
  const tabs = (i) => grow?.[i] ?? null;
  // a piece between a cut `a` under it and a cut `b` over it (either may be the model's end): its length, then with
  // the tabs that reach past its cuts against what fits the way it may lie
  const ok = (len, min, a, b) => len > tol && len >= min - tol
    && len + (a ? a.above : 0) + (b ? b.below : 0) <= (a || b ? Sflat : S) + tol;
  const run = (mEnd, mMid) => {
    let prev = new Float64Array(n).fill(Infinity);
    for (let i = 0; i < n; i++) if (ok(samples[i] - lo, mEnd, null, tabs(i))) prev[i] = own(i, 0);
    const back = [];
    for (let j = 1; j < k; j++) {
      const cur = new Float64Array(n).fill(Infinity);
      const from = new Int32Array(n).fill(-1);
      for (let i = 0; i < n; i++) {
        for (let p = 0; p < i; p++) {
          if (prev[p] === Infinity || !ok(samples[i] - samples[p], mMid, tabs(p), tabs(i))) continue;
          const c = prev[p] + own(i, j);
          if (c < cur[i]) {
            cur[i] = c;
            from[i] = p;
          }
        }
      }
      back.push(from);
      prev = cur;
    }
    let best = -1;
    for (let i = 0; i < n; i++) if (prev[i] < (best < 0 ? Infinity : prev[best]) && ok(hi - samples[i], mEnd, tabs(i), null)) best = i;
    if (best < 0) return null;
    const idx = [best];
    for (let j = k - 2; j >= 0; j--) idx.unshift(back[j][idx[0]]);
    return { offsets: idx.map((i) => samples[i]), cost: prev[best] };
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
 * every side as far as it fits: a grid whose even pieces fit is never lost.
 *
 * A dovetail cut keeps its tabs as the cut stage would: not when a cut
 * along the plate's thickness runs through that plate (it would part the
 * tabs into layers), and on each axis only through plates as thick along
 * the same axis as the first. With `support` (what each box holds of the
 * model), boxes that hold nothing are no pieces, and a piece must be able
 * to lie on something flat – one of its cut faces, or a flat side of the
 * model where it ends – unless `stable` is false.
 * @param {number[]} k cuts per axis
 * @param {{ E: number[], U: number[], bounds: { min: number[], max: number[] }, flat?: number|null, minEnd?: number,
 *   minMid?: number, profileOf: function, support?: function|null, stable?: boolean }} options E the model's extents,
 *   `flat` the axis every piece lies flat on (a thin plate, or a slab planned lying flat) or null; `profileOf(axis, k)`
 *   gives `{ samples, costs, tabs }` for k cuts on that axis, `tabs` per sample `{ below, above, w, span }` when a cut
 *   there would take dovetail tabs (see `chooseOffsets`; `span` the plate's extent along w), else null;
 *   `support(cutsByAxis)` gives `cellSupport`'s map
 * @returns {{ k: number[], offsets: number[][], cost: number, pieces: { cell: number[], size: number[], fits: true }[] }|null}
 *   `pieces` every box that makes a piece, as it will print, tabs counted
 */
export function planGrid(k, { E, U, bounds, flat = null, minEnd = 0, minMid = 0, profileOf, support = null, stable = true }) {
  const axes = [0, 1, 2].filter((a) => k[a] > 0);
  const profile = new Map(axes.map((a) => [a, profileOf(a, k[a])]));
  const tabsOf = new Map(axes.map((a) => [a, profile.get(a).tabs]));
  const grow = [0, 1, 2].map((a) => (k[a] ? Math.max(0, ...tabsOf.get(a).map((x) => (x ? Math.max(x.below, x.above) : 0))) : 0));
  const ws = [...new Set(axes.flatMap((a) => tabsOf.get(a)).filter(Boolean).map((x) => x.w))].sort();
  const even = evenCell(E, k, grow);
  // `room`: when given, no piece may be longer on an axis than it says
  const run = (lengths, room = null) => {
    const offsets = [[], [], []];
    let cost = 0;
    for (const a of axes) {
      const cell = lengths.map((v, b) => (b === a ? even[a] : v));
      const S = Math.min(maxCellLength(cell, a, U, { flat }), room?.any[a] ?? Infinity);
      const Sflat = flat === null && ws.length ? Math.min(maxCellLength(cell, a, U, { flat: ws }), room?.flat[a] ?? Infinity) : S;
      const others = axes.some((b) => b !== a && grow[b] > 0);
      const { samples, costs } = profile.get(a);
      const choice = chooseOffsets(samples, costs, { lo: bounds.min[a], hi: bounds.max[a], k: k[a], S: others ? Sflat : S, Sflat, minEnd, minMid, grow: tabsOf.get(a) });
      if (!choice) return null;
      offsets[a] = choice.offsets;
      cost += choice.cost;
    }
    // the pieces as they will print: a tab's length longer past each dovetail cut that keeps its tabs, and flat beside one
    const chosen = axes.flatMap((a) => offsets[a].map((t) => ({ axis: a, at: t, tabs: tabsOf.get(a)[profile.get(a).samples.indexOf(t)] })));
    const thickness = [null, null, null];
    const cuts = chosen.map(({ axis, at, tabs }) => {
      // without its span, a plate is taken to run right through the model along w
      const [w0, w1] = tabs?.span ?? [-Infinity, Infinity];
      const through = tabs && chosen.some((c) => c.axis === tabs.w && c.at > w0 + CUT_TOLERANCE && c.at < w1 - CUT_TOLERANCE);
      const kept = tabs && !through && (thickness[axis] ?? tabs.w) === tabs.w;
      if (kept) thickness[axis] = tabs.w;
      return { axis, at, ...(kept ? { reach: [tabs.below, tabs.above], w: tabs.w } : {}) };
    });
    const { cells } = cellSizes(bounds, cuts);
    const held = support ? support(axisCuts(cuts)) : null;
    const pieces = [];
    for (const c of cells) {
      const s = held?.get(c.cell.join(','));
      if (held && !s?.filled) continue;
      // a piece lies on a cut face, or where the model it holds is flat; a plate's, or one beside dovetails, lies flat,
      // and so does a slab's when `flat` asks it to (with nothing flat on that side it cannot)
      let ways = c.flat;
      if (ways === null && held && stable) ways = [0, 1, 2].filter((a) => c.cell[a] > 0 || c.cell[a] < k[a] || s.rests[a]);
      if (c.flat === null && flat !== null) ways = ways === null || [].concat(ways).includes(flat) ? flat : [];
      pieces.push({ cell: c.cell, size: c.size, fits: fitsBed(c.size, U, { flat: ways }).fits });
    }
    return { k, offsets, cost, cells, pieces };
  };
  const fitted = (p) => p && p.pieces.length > 0 && p.pieces.every((x) => x.fits);
  let plan = run(even);
  if (plan && !fitted(plan)) {
    const longest = [0, 1, 2].map((b) => Math.max(...plan.cells.map((c) => c.size[b])));
    plan = run(longest);
  }
  if (!fitted(plan)) {
    // each axis is planned against the others' even pieces, so all of them may take their room the same way and
    // leave a corner piece too big for any bed they were planned against. The even pieces fit, so the grid is
    // planned once more with every piece held to the even one grown alike on every side, as far as that fits
    const any = sharedRoom(even, U, flat);
    const room = any && { any, flat: flat === null && ws.length ? sharedRoom(even, U, ws) ?? any : any };
    if (room) plan = run(even, room);
  }
  if (!fitted(plan)) return null;
  const { cells, ...rest } = plan;
  return rest;
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
 * Each triangle's box and, for one facing along an axis, which way, its area and where its corner furthest from that
 * end lies, worked out once per mesh.
 */
const meshFacts = new WeakMap();
function factsOf(mesh) {
  if (meshFacts.has(mesh)) return meshFacts.get(mesh);
  const { vertProperties: P, numProp, triVerts: T } = mesh;
  const n = Math.floor(T.length / 3);
  const box = new Float64Array(n * 6);
  const face = new Int8Array(n).fill(-1);
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
    if (Math.abs(along) / len <= FLAT) continue;
    face[t] = axis * 2 + (along < 0 ? 0 : 1);
    area[t] = len / 2;
    // the corner furthest from the bed it would lie on: a facet is bed only when all of it is at the end, as
    // `orientationStats` counts it; the facets round a ball's pole lean a little, so their centres are there and
    // their outer corners are not
    pos[t] = along < 0 ? box[6 * t + 3 + axis] : box[6 * t + axis];
  }
  const facts = { n, box, face, area, pos, min, max };
  meshFacts.set(mesh, facts);
  return facts;
}

/**
 * What each box of a grid holds of a mesh, for the planner: whether it
 * holds any of the model (a box no triangle reaches is wholly inside the
 * model or wholly outside it: a ray from its centre tells which), and on
 * which axes the model it holds rests on something flat where it ends –
 * facets facing that way, wholly within 0.1 mm of the furthest the box's
 * material goes, of 25 mm² or more: the bed `orientationStats` counts. A
 * ball's quarter has nothing flat but its cut faces, and a bowl's half
 * cannot stand on the tip of its curve. What is worked out from the
 * mesh alone is kept with it, so trying grid after grid costs little.
 * @param {{ vertProperties: Float32Array|number[], numProp: number, triVerts: Uint32Array|number[] }} mesh
 * @param {number[][]} cutsByAxis sorted positions per axis (`axisCuts`)
 * @returns {Map<string, { cell: number[], filled: boolean, rests: boolean[] }>} by 'i,j,k', every box of the grid
 */
export function cellSupport(mesh, cutsByAxis) {
  const { n: count, box, face, area, pos, min, max } = factsOf(mesh);
  const cuts = [0, 1, 2].map((a) => cutsByAxis[a] ?? []);
  const n = cuts.map((c) => c.length + 1);
  const boxes = n[0] * n[1] * n[2];
  const lo = new Float64Array(boxes * 3).fill(Infinity);
  const hi = new Float64Array(boxes * 3).fill(-Infinity);
  const touched = new Uint8Array(boxes);
  const facets = new Map(); // `${box}|${dir}` → [position along the axis, area, …]
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
  for (let t = 0; t < count; t++) {
    for (let a = 0; a < 3; a++) {
      from[a] = first(a, box[6 * t + a]);
      to[a] = first(a, box[6 * t + 3 + a]);
    }
    const f = face[t];
    for (let k = from[2]; k <= to[2]; k++) {
      for (let j = from[1]; j <= to[1]; j++) {
        for (let i = from[0]; i <= to[0]; i++) {
          const b = i + n[0] * (j + n[1] * k);
          cell[0] = i;
          cell[1] = j;
          cell[2] = k;
          touched[b] = 1;
          for (let a = 0; a < 3; a++) {
            lo[b * 3 + a] = Math.min(lo[b * 3 + a], Math.max(box[6 * t + a], edgeLo(a, cell[a])));
            hi[b * 3 + a] = Math.max(hi[b * 3 + a], Math.min(box[6 * t + 3 + a], edgeHi(a, cell[a])));
          }
          if (f < 0) continue;
          // a facet facing along an axis: what the box could rest on, its area shared between the boxes it spans
          let share = 1;
          for (let a = 0; a < 3; a++) {
            const blo = box[6 * t + a];
            const bhi = box[6 * t + 3 + a];
            if (a === f >> 1 || !(bhi > blo)) continue;
            share *= (Math.min(bhi, edgeHi(a, cell[a])) - Math.max(blo, edgeLo(a, cell[a]))) / (bhi - blo);
          }
          const key = `${b}|${f}`;
          if (!facets.has(key)) facets.set(key, []);
          facets.get(key).push(pos[t], area[t] * share);
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
        const rests = [0, 1, 2].map((a) => touched[b] === 1 && [0, 1].some((dir) => {
          const end = dir ? hi[b * 3 + a] : lo[b * 3 + a];
          const list = facets.get(`${b}|${a * 2 + dir}`) ?? [];
          let sum = 0;
          for (let x = 0; x < list.length; x += 2) if (Math.abs(list[x] - end) <= 0.1) sum += list[x + 1];
          return sum >= STEADY;
        }));
        out.set(at.join(','), { cell: at, filled, rests });
      }
    }
  }
  return out;
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
 * its thickness, joints or not.
 * @returns {{ grid: number[], cells: { cell: number[], min: number[], max: number[], size: number[],
 *   flat: number|number[]|null }[] }}
 */
export function cellSizes(bounds, cuts = []) {
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
          const under = cell[a] > 0 ? tabs[a].get(min[a]) : null;
          const over = cell[a] < by[a].length ? tabs[a].get(max[a]) : null;
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

/**
 * What each way down would mean for a piece, from its own mesh: for each of
 * the six directions d, its extent along d, the area that would rest on the
 * bed (facets facing d within 0.1 mm of the piece's extreme along d) and the
 * area of the box that bed spans, the area that would need support (facets
 * facing within 45° of d, not on the bed) and the area of its own cut faces
 * facing d.
 * @param {Float32Array|number[]} vertProperties
 * @param {number} numProp
 * @param {Uint32Array|number[]} triVerts
 * @param {({ axis: number, at: number }|{ position: number[], normal: number[] })[]} cutsOnPiece the cuts this piece touches
 * @param {{ allowed?: string[] }} options `allowed`: the ways down to consider (pieces on a dovetail seam lie flat: ±w only)
 * @returns {{ bbox: { min: number[], max: number[] }, dims: number[], allowed: string[],
 *   dirs: Object<string, { extent: number, bed: number, footprint: number, support: number, cutArea: number }> }}
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
  const T = triVerts;
  for (let t = 0; t + 2 < T.length; t += 3) {
    const a = T[t] * numProp;
    const b = T[t + 1] * numProp;
    const c = T[t + 2] * numProp;
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
  }
  for (const d of DIR_KEYS) {
    const [u0, v0, u1, v1] = spread[d];
    if (u1 > u0 && v1 > v0) dirs[d].footprint = (u1 - u0) * (v1 - v0);
  }
  return {
    bbox: { min, max },
    dims: max.map((v, k) => v - min[k]),
    allowed: DIR_KEYS.filter((d) => allowed.includes(d)),
    dirs,
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

/**
 * Lower is better: support, mating faces printed upright (weaker, holes horizontal), slender towers, a small footprint.
 * How slender a piece stands is judged by the box its bed spans: a tube's ring holds it as steady as a block.
 */
function orientationScore(stats, down) {
  const s = stats.dirs[down];
  const axis = dirAxis(down);
  let cutV = 0;
  for (const d of DIR_KEYS) if (dirAxis(d) !== axis) cutV += stats.dirs[d].cutArea;
  const bed = Math.max(s.bed, s.footprint ?? 0, 1);
  const tall = s.extent / Math.sqrt(bed);
  const slender = tall > 2 ? 50 * (tall - 2) ** 2 * Math.sqrt(bed) : 0;
  const unstable = s.bed < STEADY ? 1e4 : 0;
  return s.support + 0.5 * cutV + slender + unstable;
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
 * straight, a quarter turn or across the diagonal), the best by score.
 * Scores within 1 % tie, and then the model's own down wins, then a cut
 * face down, then the lower height, then no turn. `orient: 'cut'` takes the
 * largest cut face that fits and `'model'` the model's own down; if that
 * does not fit, the best way is used with `ORIENT_FALLBACK`. If nothing
 * fits, the best way regardless (`fits: false`, `PIECE_TOO_BIG`). A piece
 * that fits only resting on a point or an edge is told of (`PIECE_UNSTABLE`).
 * A piece of a slab (`flat`, as Fit plans it) lies flat on it whenever it
 * fits that way and has something flat there to rest on.
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
    return { down, h, yaw, fits: yaw !== null, score: orientationScore(stats, down), cut: stats.dirs[down].cutArea > 1e-6 };
  });
  const order = (o) => DIR_KEYS.indexOf(o.down);
  const pick = (list) => {
    if (!list.length) return null;
    const best = Math.min(...list.map((o) => o.score));
    const tied = list.filter((o) => o.score <= best + Math.max(0.01 * Math.abs(best), EPS));
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

const NOTE_LEVELS = Object.freeze({
  SPLIT: 'ok',
  PINS: 'info',
  DOVETAIL: 'info',
  CONNECTORS_SHORTER: 'info',
  CONNECTORS_FILAMENT: 'info',
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
});

/** Every note code a split can give, with its level. */
export const SPLIT_NOTE_CODES = Object.freeze(Object.keys(NOTE_LEVELS));

const NOTE_TEXT = {
  SPLIT: ({ pieces, dowels = 0, diameter, length, lengths = [], dovetails = 0, pairs = [] }) => {
    let s = `Cut into ${plural(pieces, 'piece')}`;
    // one size of pin cut to two lengths (holes made shallower near an end) says how many of each
    if (dowels > 0 && lengths.length > 1) s += ` with ${plural(dowels, 'pin')} Ø${mm(diameter)} mm (${lengths.map((g) => `${g.count} × ${mm(g.length)} mm`).join(', ')})`;
    else if (dowels > 0) s += ` with ${plural(dowels, 'pin')} Ø${mm(diameter)} × ${mm(length)} mm`;
    if (dovetails > 0) s += `${dowels > 0 ? ' and' : ' with'} dovetail tabs`;
    s += '.';
    if (pairs.length) s += ` Glue matching letters together: ${pairs.join(', ')}.`;
    return s;
  },
  PINS: ({ count, spares = 0, diameter, length, own = false }) => {
    if (diameter === FILAMENT) return `No pins file – cut ${plural(count, 'piece')} of 1.75 mm filament ${mm(length)} mm long.`;
    if (own) return `No pins file – cut ${count} Ø${mm(diameter)} mm dowels to ${mm(length)} mm.`;
    const spare = spares ? `, ${spares === 1 ? 'one spare' : `${spares} spares`}` : '';
    return `Print the pins file (${plural(count + spares, 'pin')}${spare}) lying flat – or use Ø${mm(diameter)} mm wooden dowels cut to ${mm(length)} mm.`;
  },
  DOVETAIL: ({ letter, tabs, pieces = [] }) => `Cut ${letter} goes through a thin plate, so it has ${plural(tabs, 'dovetail tab')} instead of pins – lay both pieces flat and lower piece ${pieces[1] ?? 2} onto piece ${pieces[0] ?? 1}.`,
  CONNECTORS_SHORTER: ({ letter, depth }) => `Cut ${letter} uses ${mm(depth)} mm-deep holes – deeper ones would break through the side.`,
  CONNECTORS_FILAMENT: ({ letter, count, diameter, length }) => `Cut ${letter} is too narrow for ${diameter ? `Ø${mm(diameter)} ` : ''}pins: its holes take 1.75 mm filament – cut ${plural(count, 'piece')} ${mm(length)} mm long.`,
  CONNECTORS_DROPPED: ({ letter, count = 1, total = count, wall = null, suggestedDiameter = null, dovetail = false }) => {
    if (dovetail) return `Cut ${letter} has no room for dovetail tabs – it is a flat glue joint. A strip glued behind it makes it stronger.`;
    let s = `No pin fits on ${count} of ${plural(total, 'face')} at cut ${letter}${wall ? ` (walls under ${mm(wall)} mm)` : ''} – ${count === 1 ? 'it is a flat glue joint' : 'they are flat glue joints'}. A strip glued inside makes it stronger.`;
    if (suggestedDiameter) s += ` Ø${mm(suggestedDiameter)} mm pins would fit.`;
    return s;
  },
  ONE_CONNECTOR: ({ letter }) => `Only one pin fits on part of cut ${letter} – line the pieces up while the glue sets.`,
  DOWELS_CAPPED: ({ placed, dropped }) => `${plural(placed, 'pin')} placed; ${plural(dropped, 'small face is', 'small faces are')} glued flat.`,
  LABELS_SKIPPED: ({ letters = [] }) => `No room for a label at ${letters.length > 1 ? 'cuts' : 'cut'} ${listOf(letters)}.`,
  PIECE_TOO_BIG: ({ pieceIndex, size, bed }) => `${pieceName(pieceIndex)} (${formatSize(size)}) doesn't fit your printer in any position${bed ? ` – it has room for ${formatSize(bed)}` : ''}.`,
  PIECE_UNSTABLE: ({ pieceIndex }) => `${pieceName(pieceIndex)} has nothing flat to stand on where it fits your printer – it rests on a curve or an edge and needs supports. Another cut through it gives it a flat face to lie on.`,
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
  CUT_THROUGH_TEXT: ({ letter, name, pieces = [] }) => `Cut ${letter} runs through ${quoted(name)} – its letters are split between ${pieces.length > 1 ? `pieces ${listOf(pieces)}` : 'pieces'}.`,
  PART_SPANS_CUT: ({ name, letter }) => `${quoted(name)} prints separately and spans cut ${letter} – glue it on after the pieces.`,
  DOVETAIL_NOT_PLATE: ({ letter }) => `Cut ${letter} isn't through a thin plate, so it uses pins.`,
  ORIENT_FALLBACK: ({ pieceIndex, mode, lies }) => `${pieceName(pieceIndex)} can't lie ${mode === 'model' ? 'as modelled' : 'on its cut face'} on your printer – it lies ${lies}.`,
  SPLIT_UNREPAIRED: ({ count }) => `${plural(count, 'triangle')} that couldn't be repaired ${count === 1 ? 'was' : 'were'} cut with the pieces but ${count === 1 ? 'has' : 'have'} no pins or labels.`,
  SPLIT_UNAVAILABLE: () => 'Splitting needs a solid model – this one couldn\'t be repaired.',
  SPLIT_NOT_NEEDED: ({ yaw = 0, down = '-z' }) => (down && down !== '-z'
    ? `This model already fits your printer lying on its ${down.replace('-', '−').toUpperCase()} side${yaw ? `, turned ${yaw}° on the bed` : ''} – no need to split, but turn it that way in your slicer.`
    : `This model already fits your printer${yaw ? ` (turned ${yaw}° on the bed)` : ''} – no need to split.`),
  PLAN_TOO_MANY: () => `This would need more than ${SPLIT_LIMITS.cells} pieces – scale the model down or choose a bigger printer.`,
  BED_TOO_SMALL: ({ size, bed }) => `${formatSize(size)} – bigger than your ${formatSize(bed)} printer.`,
};

/**
 * A split note `{ level, code, text, …fields }` in the app's voice. The
 * fields each code reads are those of the design's notes table, plus:
 * SPLIT `{ pieces, dowels, diameter, length, lengths: [{ length, count }] (when the pins of that size come in more than
 * one length), dovetails, pairs: ['1A ↔ 2A'] }`;
 * PINS `{ count, spares, diameter, length, own }`; DOVETAIL `{ letter, tabs, pieces }`;
 * CONNECTORS_SHORTER `{ letter, depth }`; CONNECTORS_FILAMENT `{ letter, count, diameter, length }`;
 * CONNECTORS_DROPPED `{ letter, count, total, wall, suggestedDiameter, dovetail }`;
 * DOWELS_CAPPED `{ placed, dropped }`; LABELS_SKIPPED `{ letters }`;
 * PIECE_TOO_BIG `{ pieceIndex, size, bed }`; SMALL_PIECE `{ pieceIndex, thickness, letters, cutId }`;
 * CUTS_MERGED `{ letters, cutIds }`; SPLIT_CHECK `{ ratio }` (signed, (pieces − model) / model);
 * CUT_THROUGH_TEXT `{ itemId, cutId, letter, name, pieces }`; PART_SPANS_CUT `{ itemId, name, letter }`;
 * ORIENT_FALLBACK `{ pieceIndex, mode, lies }`; PIECE_UNSTABLE `{ pieceIndex }`; PART_TOO_BIG `{ name, size, bed, pins }`
 * (a part printed separately, or with `pins` a single pin, too big for the bed); SPLIT_NOT_NEEDED `{ yaw, down }` (down
 * other than '-z' when it fits only on its side); BED_TOO_SMALL `{ size, bed, pieces }`.
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

/**
 * The order to glue the pieces in, so that no step ever locks: the X seams
 * along each row, then the Y seams joining rows, then the Z seams joining
 * layers. Each step joins two rigid assemblies across one plane with
 * parallel pins.
 * @param {{ pieces: { index: number, cell: number[] }[], seams: { letter: string, axis: number, at: number, pieces: number[],
 *   joint: 'dowels'|'dovetail'|'none', dowels: number|object[], labels: string[]|null }[] }} plan
 *   piece numbers are 1-based; `labels` are the two faces' labels in the order of `pieces`
 * @returns {{ letter: string, axis: number, pieces: number[], joins: number[], pins: number, text: string }[]}
 *   `pieces` already in place, `joins` the ones put on in this step
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
    if (!groups.has(key)) groups.set(key, { sort: [a, ...line, seam.at ?? 0], letter: seam.letter, axis: a, seams: [] });
    groups.get(key).seams.push({ p, q, lp, lq, joint: seam.joint, pins: dowelCount(seam) });
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
    return { letter, axis, pieces: lower, joins: upper, pins, text: stepText(letter, group, lower, upper, pins) };
  });
}

function stepText(letter, group, lower, upper, pins) {
  const pieceList = (list) => `${list.length > 1 ? 'pieces' : 'piece'} ${listOf(list)}`;
  if (group.every((s) => s.joint === 'dovetail')) {
    return `Cut ${letter}: a thin film of glue on the tabs, lay ${pieceList(lower)} flat and lower ${pieceList(upper)} onto ${lower.length > 1 ? 'them' : 'it'}. Hold 1 minute.`;
  }
  const lowerLabels = group.map((s) => s.lp).filter(Boolean);
  const upperLabels = group.map((s) => s.lq).filter(Boolean);
  const faces = group.length > 1 ? 'faces' : 'face';
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
 * (cuts only between letters), that there is nothing to glue.
 * @param {{ name: string, pieces: { index: number, cell: number[], size: number[], lies: string, yaw?: number, fits?: boolean, shells?: number }[],
 *   seams: object[], pins?: { d: number, length: number, count: number, spares?: number, own?: boolean }[],
 *   parts?: { name: string }[], clearance?: number, bed?: number[], printer?: { size: number[], margin: number }|null, steps?: object[] }} plan
 *   `seams` as for `assemblySteps`; `pins` one group per pin size (count without spares); `bed` the usable bed;
 *   `printer` the printer itself, when known, for the heading
 * @returns {string}
 */
export function howToGlueText(plan) {
  const { name = 'model', pieces = [], seams = [], parts = [], clearance = SPLIT_DEFAULTS.clearance, bed = null, printer = null } = plan;
  const pins = (Array.isArray(plan.pins) ? plan.pins : plan.pins ? [plan.pins] : []).filter((g) => g.count > 0);
  const steps = plan.steps ?? assemblySteps({ pieces, seams });
  const n = pieces.length;
  const anyPins = seams.some((s) => dowelCount(s) > 0);
  const anyTabs = seams.some((s) => s.joint === 'dovetail');
  const where = printer?.size
    ? `a ${formatSize(printer.size)} printer${printer.margin ? ` (${mm(printer.margin)} mm margin)` : ''}`
    : bed ? `a printer with room for ${formatSize(bed)}` : 'your printer';
  const out = [`${name} – ${plural(n, 'piece')} for ${where} – STL Text`, ''];

  out.push(`PRINT (each file is already turned the way to print it${anyPins ? '; holes need no supports' : ''})`);
  const sizes = pieces.map((p) => size1(p.size));
  const width = Math.max(0, ...sizes.map((s) => s.length));
  [...pieces].sort((p, q) => p.index - q.index).forEach((p) => {
    const extra = [p.fits === false ? 'TOO BIG for this printer' : 'fits'];
    if (p.yaw && p.yaw !== 90) extra.push(`turned ${p.yaw}° to fit`); // a quarter turn is already in the file and looks ordinary
    if (p.shells > 1) extra.push(`${p.shells} parts`);
    out.push(`  ${pad(`piece ${p.index} of ${n}`, 12)}${pad(size1(p.size), width)}${pad(`lies ${p.lies}`, 0)}${extra.join(', ')}`);
  });
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
  if (anyPins || anyTabs) out.push('  Not sure about the fit? Print the fit test first (Split card → Download fit test).');
  out.push('');

  if (!steps.length) {
    // the cuts ran only through gaps (between the letters of a sign, say): no two pieces touch
    out.push('NOTHING TO GLUE');
    out.push('  The cuts run through gaps, so no two pieces touch. Lay them out as in the model – on a backing board to keep them together.');
    return `${out.join('\n')}\n`;
  }

  out.push('DRY-FIT FIRST');
  if (anyPins) out.push('  Pins should slide in by hand. Too tight: raise Clearance by 0.05 mm and download again.');
  if (anyTabs) out.push('  Tabs should drop into their sockets by hand. Too tight: raise Clearance by 0.05 mm and download again.');
  if (!anyPins && !anyTabs) out.push('  Hold the pieces together and check that the faces meet all round.');
  out.push('');

  const pairs = seams.filter((s) => s.labels?.length === 2).map((s) => `${s.labels[0]} ↔ ${s.labels[1]}`);
  const room = anyPins ? `; holes have ${mm(clearance)} mm of room per side` : '';
  out.push(`GLUE – ${pairs.length ? 'put each letter on the same letter' : 'in this order'} (medium/thick CA or 5-minute epoxy${room})`);
  if (pairs.length) out.push(`  Matching faces: ${pairs.join(', ')}`);
  steps.forEach((s, i) => out.push(`  ${i + 1}. ${s.text}`));
  return `${out.join('\n')}\n`;
}

// ---------- the viewer ----------

/** Cut planes, their badges and the card's letters. */
export const CUT_COLOR = 0x8b5cf6;

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
