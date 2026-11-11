// The print check: what a finished piece will ask of the printer, lying the way its file lies. Plain numbers only –
// no Manifold, no three.js – so it runs in the worker and in Node tests alike. One pass over the piece's triangles
// gives the faces that may need supports (and whether those would stand on the bed or on the piece itself, and
// whether they are glue faces or the model's own), the big faces that lean a little off level and so print with
// step lines, and what the piece stands on. It is an estimate, not a slicer: every word made from it says "about"
// and "may".

const RAD = Math.PI / 180;

/**
 * The rules of the check, in one place.
 * - `angle`, `tolerance`: a face less than `angle` degrees from level may need supports – the safe rule; a slicer's
 *   own default is often 30. The `tolerance` keeps a face drawn at exactly 45° (a chamfer, a teardrop's roof) from
 *   counting whichever way its numbers round.
 * - `shallow`: under this many degrees from level a slicer supports a face by default.
 * - `firstLayer`: what lies within this much of the bed (mm) is the first layer, and rests on the bed.
 * - `flat`, `onBed`: a face is on the bed when it is level (its normal's z under −`flat`) and within `onBed` mm of it.
 * - `place`: a patch of overhang under this much (mm², seen from below) is left out: the underside of a letter.
 * - `bridge`, `level`, `held`: a level ceiling (within `level` degrees) no wider than `bridge` mm, with walls under
 *   at least `held` of its rim, is a short span a printer bridges without supports.
 * - `none`: under this much overhang in all (mm²) a piece needs no supports.
 * - `stepMin`, `stepMax`: a face leaning between these many degrees off level prints with step lines that show.
 * - `stepArea`, `stepShare`: only a big face is told of – this much (mm²) and this share of the piece's outline on
 *   the bed at least; a curved top is many small ones.
 * - `stepMerge`: faces within this many degrees of each other are one face.
 * - `stepCount`: a face that rises fewer layers than this shows no steps to speak of.
 * - `steady`: with less than this on the bed (mm²) a piece stands on a point or an edge.
 * - `smallFoot`, `tall`: under this much on the bed (mm²), a piece taller than `tall` mm has a small foot.
 * - `footShare`: so has one whose foot spans less than this share of its outline.
 * - `tipRatio`: a piece more than this many times as tall as its foot is wide may tip.
 * - `brim`, `brimTall`, `tallRatio`: the brim to add (mm), the wider one for a piece more than `tallRatio` times as
 *   tall as its foot is wide.
 * - `note`: this much overhang (mm²) on the model's own faces, or on glue faces, is worth a note.
 * - `steps`: how many leaning faces a piece's row keeps, the largest first.
 */
export const PRINT_CHECK = Object.freeze({
  angle: 45,
  tolerance: 1.5,
  shallow: 30,
  firstLayer: 0.3,
  flat: 0.999,
  onBed: 0.1,
  place: 4,
  bridge: 10,
  level: 10,
  held: 0.45,
  none: 20,
  stepMin: 0.25,
  stepMax: 15,
  stepArea: 200,
  stepShare: 0.05,
  stepMerge: 1,
  stepCount: 2,
  steady: 25,
  smallFoot: 150,
  tall: 20,
  footShare: 0.1,
  tipRatio: 5,
  brim: 5,
  brimTall: 8,
  tallRatio: 8,
  note: 100,
  steps: 3,
});

/** A face whose normal's z, as it prints, is under this may need supports: more than 46.5° from upright. */
export const OVERHANG_NZ = -Math.sin((PRINT_CHECK.angle + PRINT_CHECK.tolerance) * RAD);

const TILT_BINS = Math.ceil(PRINT_CHECK.stepMax / 0.5);
const TURN_BINS = 72;

/** The union-find's root of `i`, the path to it halved on the way. */
function rootOf(parent, i) {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
}

/**
 * The faces that look up, in a grid across the bed: `under(x, y, z)` says whether any of them lies straight below a
 * point, which is where a support under it would stand if not on the bed.
 */
function facesBelow(X, T, up, lo, hi) {
  const n = Math.max(4, Math.min(256, Math.ceil(Math.sqrt(up.length))));
  const w = Math.max(hi[0] - lo[0], 1e-9) / n;
  const h = Math.max(hi[1] - lo[1], 1e-9) / n;
  const cellOf = (v, from, step) => Math.max(0, Math.min(n - 1, Math.floor((v - from) / step)));
  const span = (t) => {
    const a = T[3 * t] * 3, b = T[3 * t + 1] * 3, c = T[3 * t + 2] * 3;
    return [
      cellOf(Math.min(X[a], X[b], X[c]), lo[0], w), cellOf(Math.max(X[a], X[b], X[c]), lo[0], w),
      cellOf(Math.min(X[a + 1], X[b + 1], X[c + 1]), lo[1], h), cellOf(Math.max(X[a + 1], X[b + 1], X[c + 1]), lo[1], h),
    ];
  };
  const start = new Uint32Array(n * n + 1);
  for (const t of up) {
    const [i0, i1, j0, j1] = span(t);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) start[j * n + i + 1]++;
  }
  for (let k = 0; k < n * n; k++) start[k + 1] += start[k];
  const list = new Uint32Array(start[n * n]);
  const at = start.slice(0, n * n);
  for (const t of up) {
    const [i0, i1, j0, j1] = span(t);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) list[at[j * n + i]++] = t;
  }
  return (x, y, z) => {
    const k = cellOf(y, lo[1], h) * n + cellOf(x, lo[0], w);
    for (let q = start[k]; q < start[k + 1]; q++) {
      const t = list[q];
      const a = T[3 * t] * 3, b = T[3 * t + 1] * 3, c = T[3 * t + 2] * 3;
      const d = (X[b + 1] - X[c + 1]) * (X[a] - X[c]) + (X[c] - X[b]) * (X[a + 1] - X[c + 1]);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((X[b + 1] - X[c + 1]) * (x - X[c]) + (X[c] - X[b]) * (y - X[c + 1])) / d;
      const v = ((X[c + 1] - X[a + 1]) * (x - X[c]) + (X[a] - X[c]) * (y - X[c + 1])) / d;
      if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
      if (u * X[a + 2] + v * X[b + 2] + (1 - u - v) * X[c + 2] < z - 1e-4) return true;
    }
    return false;
  };
}

/**
 * The big faces that lean a little off level, from the bins the pass filled: bins within `stepMerge` degrees of the
 * largest left are one face with it, and a face is kept when it is big enough for the piece.
 */
function leaningFaces(bins, least) {
  const list = [...bins.values()].sort((p, q) => q.area - p.area);
  const near = Math.cos(PRINT_CHECK.stepMerge * RAD);
  const unit = list.map((b) => {
    const len = Math.hypot(b.n[0], b.n[1], b.n[2]) || 1;
    return b.n.map((v) => v / len);
  });
  const used = new Uint8Array(list.length);
  const faces = [];
  for (let i = 0; i < list.length; i++) {
    if (used[i]) continue;
    const face = { area: list[i].area, n: [...list[i].n], lo: list[i].lo, hi: list[i].hi };
    for (let j = i + 1; j < list.length; j++) {
      if (used[j] || unit[i][0] * unit[j][0] + unit[i][1] * unit[j][1] + unit[i][2] * unit[j][2] < near) continue;
      used[j] = 1;
      face.area += list[j].area;
      for (let a = 0; a < 3; a++) face.n[a] += list[j].n[a];
      face.lo = Math.min(face.lo, list[j].lo);
      face.hi = Math.max(face.hi, list[j].hi);
    }
    if (face.area < least) continue;
    const len = Math.hypot(face.n[0], face.n[1], face.n[2]) || 1;
    faces.push({
      facing: face.n[2] > 0 ? 'up' : 'down',
      tilt: Math.acos(Math.min(1, Math.abs(face.n[2]) / len)) / RAD,
      area: face.area,
      rise: face.hi - face.lo,
    });
  }
  return faces.sort((p, q) => q.area - p.area);
}

/**
 * The print check of one piece: its triangles as they are in the model, and how the piece is turned to print.
 * Nothing in it depends on the layer height: `stepLines` and `checkRow` bring that in.
 * @param {Float32Array|number[]} vertProperties the piece's points, `numProp` numbers each (x, y, z first)
 * @param {number} numProp
 * @param {Uint32Array|number[]} triVerts three points a triangle; triangles that meet share their points
 * @param {{ turn?: number[]|null, planes?: { axis: number, at: number }[], made?: ArrayLike<number>|null }} options
 *   `turn` the 4 × 4 matrix (column-major) that turns the piece the way it prints, +z up – only its turn is used, the
 *   piece's lowest point is the bed; `planes` the cuts the piece touches, as it is in the model: a face on one is a
 *   glue face; `made` one number a triangle, not 0 for a face the app made for a joint (a hole, a socket, a lip, a
 *   lock, a label): those print without supports by design and are counted apart
 * @returns {{ height: number, box: number[],
 *   supports: { area: number, skin: number, seam: number, bed: number, piece: number, shallow: number, places: number,
 *   bridged: number, joints: number },
 *   leaning: { facing: 'up'|'down', tilt: number, area: number, rise: number }[],
 *   foot: { contact: number, across: number[]|null, base: number, ratio: number, flat: boolean, tip: boolean,
 *   small: boolean, off: boolean } }}
 *   `height` and `box` (its two sides on the bed) as it lies. `supports`, all mm² as seen from below: `area` what may
 *   need supports, of which `skin` on the model's own faces and `seam` on glue faces; of which `bed` where a support
 *   would stand on the bed and `piece` where it would stand on the piece itself; `shallow` the part under 30° from
 *   level; `places` how many patches it is in; `bridged` the short level spans left out, and `joints` the area of the
 *   joints' own faces left out. `leaning` the big faces a little off level, largest first (`tilt` degrees off level,
 *   `rise` how far the face climbs, mm). `foot`: `contact` the area on the bed, `across` the two sides of the box it
 *   spans, `base` the shorter of them, `ratio` the piece's height over that, `flat` whether it has a flat foot at
 *   all, `tip` whether it may tip, `small` whether its foot is small, `off` whether its weight hangs past its foot
 */
export function printCheck(vertProperties, numProp, triVerts, { turn = null, planes = [], made = null } = {}) {
  const P = vertProperties;
  const T = triVerts;
  const count = Math.floor(P.length / numProp);
  const tris = Math.floor(T.length / 3);
  const m = turn ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  // the points as the piece prints
  const X = new Float32Array(count * 3);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const x = P[i * numProp], y = P[i * numProp + 1], z = P[i * numProp + 2];
    for (let a = 0; a < 3; a++) {
      const v = m[a] * x + m[4 + a] * y + m[8 + a] * z;
      X[i * 3 + a] = v;
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
  }
  if (!(lo[0] <= hi[0])) {
    lo.fill(0);
    hi.fill(0);
  }
  const z0 = lo[2];
  const height = hi[2] - z0;
  const box = [hi[0] - lo[0], hi[1] - lo[1]];
  const R = PRINT_CHECK;
  const leanLo = Math.cos(R.stepMax * RAD);
  const leanHi = Math.cos(R.stepMin * RAD);
  const shallowNz = -Math.cos(R.shallow * RAD);
  const levelNz = -Math.cos(R.level * RAD);
  const onPlane = (a, b, c) => planes.some((p) => Math.max(Math.abs(P[a + p.axis] - p.at), Math.abs(P[b + p.axis] - p.at), Math.abs(P[c + p.axis] - p.at)) <= 0.01);

  let contact = 0;
  const spread = [Infinity, Infinity, -Infinity, -Infinity];
  let joints = 0;
  // the weight's middle, from the tetrahedra the triangles make with a point: the box's low corner
  let volume = 0;
  const com = [0, 0, 0];
  const bins = new Map();
  const over = []; // the triangles that may need supports
  const info = []; // for each: what is seen of it from below, its normal's z, and whether it is a glue face
  const up = [];
  for (let t = 0; t < tris; t++) {
    const a = T[3 * t] * 3, b = T[3 * t + 1] * 3, c = T[3 * t + 2] * 3;
    const ax = X[a] - lo[0], ay = X[a + 1] - lo[1], az = X[a + 2] - z0;
    const bx = X[b] - lo[0], by = X[b + 1] - lo[1], bz = X[b + 2] - z0;
    const cx = X[c] - lo[0], cy = X[c + 1] - lo[1], cz = X[c + 2] - z0;
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nzRaw = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const v = (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    volume += v;
    com[0] += (v * (ax + bx + cx)) / 4;
    com[1] += (v * (ay + by + cy)) / 4;
    com[2] += (v * (az + bz + cz)) / 4;
    const len = Math.hypot(nx, ny, nzRaw);
    if (!(len > 0)) continue;
    const area = len / 2;
    const nz = nzRaw / len;
    if (nz > 1e-6) up.push(t);
    const top = Math.max(az, bz, cz);
    if (nz < -R.flat && top <= R.onBed) {
      contact += area;
      spread[0] = Math.min(spread[0], ax, bx, cx);
      spread[1] = Math.min(spread[1], ay, by, cy);
      spread[2] = Math.max(spread[2], ax, bx, cx);
      spread[3] = Math.max(spread[3], ay, by, cy);
      continue;
    }
    const joint = Boolean(made?.[t]);
    const steep = Math.abs(nz);
    if (!joint && steep > leanLo && steep < leanHi) {
      const tilt = Math.min(TILT_BINS - 1, Math.floor(Math.acos(steep) / RAD / 0.5));
      const round = Math.min(TURN_BINS - 1, Math.floor(((Math.atan2(ny, nx) / RAD + 180) / 360) * TURN_BINS));
      const key = ((nz > 0 ? 1 : 0) * TILT_BINS + tilt) * TURN_BINS + round;
      let bin = bins.get(key);
      if (!bin) bins.set(key, (bin = { area: 0, n: [0, 0, 0], lo: Infinity, hi: -Infinity }));
      bin.area += area;
      bin.n[0] += nx / 2;
      bin.n[1] += ny / 2;
      bin.n[2] += nzRaw / 2;
      bin.lo = Math.min(bin.lo, az, bz, cz);
      bin.hi = Math.max(bin.hi, top);
    }
    if (!(nz < OVERHANG_NZ) || top <= R.firstLayer) continue;
    const seam = planes.length > 0 && onPlane(T[3 * t] * numProp, T[3 * t + 1] * numProp, T[3 * t + 2] * numProp);
    if (joint && !seam) {
      joints += area * -nz;
      continue;
    }
    over.push(t);
    info.push(area * -nz, nz, seam ? 1 : 0);
  }

  const supports = { area: 0, skin: 0, seam: 0, bed: 0, piece: 0, shallow: 0, places: 0, bridged: 0, joints };
  if (over.length) {
    // the patches: overhanging triangles that share a point are one place
    const parent = Int32Array.from(over, (_, i) => i);
    const first = new Map();
    const edges = new Map(); // an edge only one of them has -> which, and the edge's lowest point
    over.forEach((t, i) => {
      for (let k = 0; k < 3; k++) {
        const p = T[3 * t + k];
        const q = T[3 * t + ((k + 1) % 3)];
        if (first.has(p)) parent[rootOf(parent, i)] = rootOf(parent, first.get(p));
        else first.set(p, i);
        const key = p < q ? p * count + q : q * count + p;
        if (edges.has(key)) edges.delete(key);
        else edges.set(key, i);
      }
    });
    const places = new Map();
    const placeOf = (i) => {
      const r = rootOf(parent, i);
      let place = places.get(r);
      if (!place) places.set(r, (place = { area: 0, level: true, box: [Infinity, Infinity, -Infinity, -Infinity], held: 0, open: 0, list: [] }));
      return place;
    };
    over.forEach((t, i) => {
      const place = placeOf(i);
      place.area += info[3 * i];
      if (info[3 * i + 1] > levelNz) place.level = false;
      for (let k = 0; k < 3; k++) {
        const p = T[3 * t + k] * 3;
        place.box[0] = Math.min(place.box[0], X[p]);
        place.box[1] = Math.min(place.box[1], X[p + 1]);
        place.box[2] = Math.max(place.box[2], X[p]);
        place.box[3] = Math.max(place.box[3], X[p + 1]);
      }
      place.list.push(i);
    });
    // a level place's rim: held where the face beside it goes down from it (a wall under a ceiling), open where it
    // does not (the free edge of a shelf)
    if ([...places.values()].some((p) => p.level && p.area >= R.place)) {
      const isOver = new Uint8Array(tris);
      for (const t of over) isOver[t] = 1;
      for (let t = 0; t < tris && edges.size; t++) {
        if (isOver[t]) continue;
        for (let k = 0; k < 3; k++) {
          const p = T[3 * t + k];
          const q = T[3 * t + ((k + 1) % 3)];
          const i = edges.get(p < q ? p * count + q : q * count + p);
          if (i === undefined) continue;
          const third = X[T[3 * t + ((k + 2) % 3)] * 3 + 2];
          const length = Math.hypot(X[p * 3] - X[q * 3], X[p * 3 + 1] - X[q * 3 + 1], X[p * 3 + 2] - X[q * 3 + 2]);
          const place = placeOf(i);
          if (third < Math.min(X[p * 3 + 2], X[q * 3 + 2]) - 1e-6) place.held += length;
          else place.open += length;
        }
      }
    }
    let under = null;
    for (const place of places.values()) {
      if (place.area < R.place) continue;
      const narrow = Math.min(place.box[2] - place.box[0], place.box[3] - place.box[1]);
      if (place.level && narrow <= R.bridge && place.held >= R.held * (place.held + place.open) && place.held > 0) {
        supports.bridged++;
        continue;
      }
      supports.places++;
      under ??= facesBelow(X, T, up, lo, hi);
      for (const i of place.list) {
        const t = over[i];
        const a = T[3 * t] * 3, b = T[3 * t + 1] * 3, c = T[3 * t + 2] * 3;
        const seen = info[3 * i];
        supports.area += seen;
        supports[info[3 * i + 2] ? 'seam' : 'skin'] += seen;
        if (info[3 * i + 1] < shallowNz) supports.shallow += seen;
        const onPiece = under((X[a] + X[b] + X[c]) / 3, (X[a + 1] + X[b + 1] + X[c + 1]) / 3, (X[a + 2] + X[b + 2] + X[c + 2]) / 3);
        supports[onPiece ? 'piece' : 'bed'] += seen;
      }
    }
  }

  const flat = contact >= R.steady;
  const across = flat ? [spread[2] - spread[0], spread[3] - spread[1]] : null;
  const base = across ? Math.min(across[0], across[1]) : 0;
  const ratio = base > 0 ? height / base : Infinity;
  // the weight's middle past the box its foot spans: it hangs over, and may pull the piece off the bed
  const mid = volume > 1e-9 ? [com[0] / volume, com[1] / volume] : [box[0] / 2, box[1] / 2];
  const off = flat && (mid[0] < spread[0] - 1e-6 || mid[0] > spread[2] + 1e-6 || mid[1] < spread[1] - 1e-6 || mid[1] > spread[3] + 1e-6);
  const tip = flat && (ratio > R.tipRatio || off);
  const small = flat && height > R.tall && (contact < R.smallFoot || across[0] * across[1] < R.footShare * box[0] * box[1]);
  return {
    height,
    box,
    supports,
    leaning: leaningFaces(bins, Math.max(R.stepArea, R.stepShare * box[0] * box[1])),
    foot: { contact, across, base, ratio, flat, tip, small, off },
  };
}

/**
 * The step lines of a piece's leaning faces at a layer height: a face `tilt` degrees off level climbs one layer every
 * `layer / tan(tilt)` mm, and the edge of each layer shows as a line across it. A face that climbs fewer than two
 * layers shows none to speak of.
 * @param {{ facing: string, tilt: number, area: number, rise: number }[]} leaning from `printCheck`
 * @param {number} layer the layer height, mm
 * @returns {{ facing: 'up'|'down', tilt: number, area: number, every: number, lines: number }[]} `every` how far
 *   apart the lines are across the face (mm), `lines` about how many there are
 */
export function stepLines(leaning, layer = 0.2) {
  const h = layer > 0 ? layer : 0.2;
  return (leaning ?? [])
    .map((f) => ({ facing: f.facing, tilt: f.tilt, area: f.area, every: h / Math.tan(f.tilt * RAD), lines: Math.floor(f.rise / h + 1e-6) }))
    .filter((f) => f.lines >= PRINT_CHECK.stepCount);
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * A piece's check as its row carries it: rounded, with the step lines of the layer height and the brim a risky foot
 * wants.
 * @param {object} check from `printCheck`
 * @param {number} layer the layer height, mm
 * @returns {{ layer: number, height: number,
 *   supports: { area: number, skin: number, seam: number, bed: number, piece: number, shallow: number, places: number,
 *   bridged: number },
 *   steps: { facing: 'up'|'down', tilt: number, area: number, every: number }[],
 *   foot: { contact: number, across: number[]|null, flat: boolean, tip: boolean, small: boolean, brim: number } }}
 *   areas in whole mm²; `steps` the largest few, those facing up first; `brim` the brim to add in mm, 0 for none
 */
export function checkRow(check, layer = 0.2) {
  const s = check.supports;
  const steps = stepLines(check.leaning, layer)
    .sort((p, q) => (p.facing === 'up' ? 0 : 1) - (q.facing === 'up' ? 0 : 1) || q.area - p.area)
    .slice(0, PRINT_CHECK.steps)
    .map((f) => ({ facing: f.facing, tilt: round1(f.tilt), area: Math.round(f.area), every: round1(f.every) }));
  const f = check.foot;
  const risky = f.tip || f.small;
  return {
    layer,
    height: round1(check.height),
    supports: {
      area: Math.round(s.area), skin: Math.round(s.skin), seam: Math.round(s.seam), bed: Math.round(s.bed), piece: Math.round(s.piece),
      shallow: Math.round(s.shallow), places: s.places, bridged: s.bridged,
    },
    steps,
    foot: {
      contact: Math.round(f.contact),
      across: f.across ? f.across.map(round1) : null,
      flat: f.flat,
      tip: f.tip,
      small: f.small,
      brim: risky ? (f.ratio > PRINT_CHECK.tallRatio ? PRINT_CHECK.brimTall : PRINT_CHECK.brim) : 0,
    },
  };
}

/** An area in plain words: "under 1 cm²", "about 12 cm²". */
export function areaWords(mm2) {
  return mm2 < 100 ? 'under 1 cm²' : `about ${Math.round(mm2 / 100)} cm²`;
}

/** A length in plain words, to the millimetre from 3 mm up and to half a millimetre under it. */
const lengthWords = (v) => (v >= 3 ? String(Math.round(v)) : String(Math.max(0.5, Math.round(v * 2) / 2)));

/** How far apart a leaning face's step lines are: "about every 4 mm". */
export const everyWords = (every) => `about every ${lengthWords(every)} mm`;

/** Where the supports of a piece would stand: on the bed, on the piece itself, or some on each. */
function standWords(s, whole = false) {
  if (s.piece < 0.1 * s.area) return 'standing on the bed';
  const itself = whole ? 'the model itself' : 'the piece itself';
  return s.bed < 0.1 * s.area ? `standing on ${itself}` : `some standing on ${itself}`;
}

/** Whether what the supports hold up is a glue face: mostly, partly or not at all (''). */
function seamWords(s) {
  if (s.seam >= 0.9 * s.area) return 'under a glue face';
  return s.seam >= Math.max(PRINT_CHECK.none, 0.1 * s.area) ? 'partly under a glue face' : '';
}

/**
 * A piece's check in a few short clauses, for its line in the pieces list and on the sheet: supports, step lines,
 * what it stands on, and how its pin holes print.
 * @param {object|null} row from `checkRow`
 * @param {{ upright?: number, pointed?: number, flat?: number, round?: number }|null} holes the piece's pin holes by
 *   how they print (split.js `holeSummary`)
 * @returns {string[]} empty without a check and without holes
 */
export function checkWords(row, holes = null) {
  const out = [];
  if (row) {
    const s = row.supports;
    if (s.area < PRINT_CHECK.none) out.push('no supports needed');
    else out.push(`may need supports: ${[areaWords(s.area), seamWords(s), standWords(s)].filter(Boolean).join(', ')}`);
    const top = row.steps.find((f) => f.facing === 'up');
    if (top) out.push(`step lines ${everyWords(top.every)} on a big face on top`);
    if (!row.foot.flat) out.push('nothing flat to stand on');
    else if (row.foot.tip) out.push(`may tip: add a brim, ${row.foot.brim} mm wide`);
    else if (row.foot.small) out.push(`small foot: add a brim, ${row.foot.brim} mm wide`);
  }
  const n = holes ? (holes.upright ?? 0) + (holes.pointed ?? 0) + (holes.flat ?? 0) + (holes.round ?? 0) : 0;
  if (n) {
    const round = holes.round ?? 0;
    out.push(round
      ? `${round} of its ${n} pin holes may need supports`
      : `${n === 1 ? 'its pin hole needs' : `its ${n} pin holes need`} no supports`);
  }
  return out;
}

/**
 * What of a piece's check is worth a note, as the note's fields; null when nothing is. Supports under the model's
 * own faces or under a glue face (which prints rough on them), a big face on top that will show step lines, and a
 * piece that may tip or stands on a small foot.
 * @param {object|null} row from `checkRow`
 * @returns {{ supports?: object, steps?: object, foot?: object, layer: number, height: number }|null}
 */
export function checkNote(row) {
  if (!row) return null;
  const s = row.supports;
  const top = row.steps.find((f) => f.facing === 'up');
  const risky = row.foot.flat && (row.foot.tip || row.foot.small);
  const supported = s.skin >= PRINT_CHECK.note || s.seam >= PRINT_CHECK.note;
  if (!supported && !top && !risky) return null;
  return {
    ...(supported ? { supports: s } : {}),
    ...(top ? { steps: top } : {}),
    ...(risky ? { foot: row.foot } : {}),
    layer: row.layer,
    height: row.height,
  };
}

/**
 * The words of a print-check note, after the piece's name (or "The model"): each thing to know in a sentence, with
 * what can be done about it.
 * @param {string} who "Piece 3", "The model"
 * @param {{ supports?: object, steps?: object, foot?: object, layer?: number, height?: number, whole?: boolean }} fields
 *   from `checkNote`; `whole` for a model printed in one piece, which has no Lay pieces setting to try
 * @returns {string}
 */
export function checkNoteWords(who, { supports = null, steps = null, foot = null, layer = 0.2, height = 0, whole = false }) {
  const out = [];
  const name = () => (out.length ? 'It' : who);
  if (supports) {
    const own = supports.skin >= PRINT_CHECK.note;
    const what = own ? `${areaWords(supports.skin)} of ${whole ? 'its' : "the model's own"} faces` : `${areaWords(supports.seam)} of a glue face`;
    out.push(`${name()} may need supports under ${what}, ${standWords(supports, whole)}. ${whole ? 'Turned another way it may need less' : 'Another way to lay it (Lay pieces) may need less'}.`);
    if (supports.seam >= PRINT_CHECK.note) out.push('A glue face on supports prints rough and may want light sanding before you glue it.');
  }
  if (steps) {
    out.push(`${name()} has a big face on top (${areaWords(steps.area)}) that leans ${lengthWords(steps.tilt)}° off level: at ${layer} mm layers it prints with a step line ${everyWords(steps.every)}. ${whole ? 'Turning the model so that the face is level or upright' : 'Another way to lay it'}, or finer layers, shows them less.`);
  }
  if (foot) {
    const on = foot.across ? `a ${foot.across.map(lengthWords).join(' × ')} mm foot` : 'a small foot';
    const what = foot.tip ? `${name()} stands ${lengthWords(height)} mm tall on ${on} and may tip or come loose` : `${name()} stands on ${on}, small for its size, and may come loose`;
    out.push(`${what}: add a brim about ${foot.brim} mm wide in your slicer${whole ? '' : ', or lay it another way'}.`);
  }
  return out.join(' ');
}
