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
 * - `bridge`, `bridgeLong`, `level`: a level ceiling (every face of it within `level` degrees, and the whole of it
 *   within a first layer's height) with a wall under it on two opposite sides is a span the printer bridges: up to
 *   `bridge` mm from wall to wall it is left out, up to `bridgeLong` mm (the span of the app's own clips) it is told
 *   of apart, as a span to bridge, and beyond that it may need supports. A ledge held along one side only is no
 *   span, however long it is for its depth. Nor is a roof that slopes, however little: each layer of it hangs from
 *   one side only.
 * - `lip`: but a level ledge that stands no more than this far (mm) out of the wall it is on is left out as well:
 *   the underside of a raised letter, a small step.
 * - `skirt`, `skirtWide`: a patch that rises straight off the first layer and is steep enough within `skirt` mm of
 *   the bed, in a band no more than `skirtWide` mm wide, is left out: a rounded bottom edge, which nobody supports.
 * - `spanTurns`, `spanWork`, `spanCells`: a span is measured at every face of a ceiling, in this many directions.
 *   Past `spanWork` steps of that for one ceiling, a face takes the span measured for a face near it – in the same
 *   cell of a grid across the piece, `spanCells` a side – where there is one. However fine the mesh, a ceiling is
 *   always measured.
 * - `grid`: where supports would stand is told from a grid across the bed, this many cells a side.
 * - `none`: under this much overhang in all (mm²) a piece needs no supports.
 * - `stepMin`, `stepMax`: a face leaning between these many degrees off level prints with step lines that show.
 * - `stepArea`, `stepShare`: only a big face is told of – this much (mm²) and this share of the piece's outline on
 *   the bed at least; a curved top is many small ones.
 * - `stepMerge`: faces within this many degrees of each other are one face.
 * - `stepCount`: a face that rises fewer layers than this shows no steps to speak of.
 * - `steady`: with less than this on the bed (mm²) a piece stands on a point or an edge.
 * - `smallFoot`, `tall`, `slim`, `ringShare`: under this much on the bed (mm²), a piece taller than `tall` mm has a
 *   small foot – where it is also more than `slim` times as tall as its foot is wide, or its foot spans less than
 *   `ringShare` of its outline. A thin tube on its ring stands on little, but that little spans all of it.
 * - `footShare`: so has one whose foot spans less than this share of its outline.
 * - `strip`: a foot narrower than this (mm), and under half as wide as the piece, is a strip: a round bar lying down.
 * - `tipRatio`: a piece more than this many times as tall as its foot is wide may tip.
 * - `brim`, `brimTall`, `tallRatio`: the brim to add (mm), the wider one for a piece more than `tallRatio` times as
 *   tall as its foot is wide.
 * - `note`, `noteSeam`: this much overhang (mm²) on the model's own faces, or this much on glue faces, is worth a
 *   note; less is said on the piece's line only.
 * - `steps`: how many leaning faces a piece's row keeps, the largest first.
 * - `tipMax`: a piece is tipped in its file to print a leaning face level (`levelFace`) only where the face leans
 *   this many degrees at most: tipped further, it would stand on tall supports and a steep edge.
 * - `tipRest`: a tipped piece rests on an edge where its points within `tipNear` mm of the bed lie at least this far
 *   apart (mm), else on a corner.
 * - `tipGain`: and only where, tipped, it shows step lines on less than this share of what it shows them on now.
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
  bridgeLong: 30,
  lip: 2,
  level: 1,
  skirt: 3,
  skirtWide: 5,
  spanTurns: 12,
  spanWork: 2e7,
  spanCells: 256,
  grid: 512,
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
  slim: 3,
  ringShare: 0.5,
  footShare: 0.1,
  strip: 2.5,
  tipRatio: 5,
  brim: 5,
  brimTall: 8,
  tallRatio: 8,
  note: 500,
  noteSeam: 100,
  steps: 3,
  tipMax: 8,
  tipGain: 0.5,
  tipRest: 5,
  tipNear: 0.1,
});

/** A face whose normal's z, as it prints, is under this may need supports: more than 46.5° from upright. */
export const OVERHANG_NZ = -Math.sin((PRINT_CHECK.angle + PRINT_CHECK.tolerance) * RAD);

/**
 * What a face is to the check, for a picture of it: nothing to say, one that may need supports (the model's own, or
 * a glue face), or part of a level span the printer is left to bridge. `printCheck` gives one number a triangle
 * (`faces`): this in its low two bits (`faceKind`), and above them which of the piece's leaning faces the triangle is
 * part of (`faceLean`: its number in `leaning` from 1, 0 for none; where a piece has more of them than the number
 * holds, the last number stands for all the rest). A triangle on top that leans as little but is part of no face big
 * enough to be told of – one of the many small faces of a rounded top – has `LEAN_REST`.
 */
export const FACE = Object.freeze({ none: 0, skin: 1, seam: 2, span: 3 });
/** What a triangle is, from its number in `faces`: one of `FACE`. */
export const faceKind = (b) => b & 3;
/** Which leaning face a triangle is part of, from its number in `faces`: from 1, 0 for none. */
export const faceLean = (b) => b >> 2;
/** How many leaning faces `faces` can tell apart. */
const LEAN_FACES = 62;
/** What `faceLean` gives for a triangle on top that leans a little off level but is part of no big leaning face. */
export const LEAN_REST = 63;

const TILT_BINS = Math.ceil(PRINT_CHECK.stepMax / 0.5);
const TURN_BINS = 72;
/** A line meets a wall squarely when it is within 10° of square to it (the sine of the angle between them). */
const SQUARE = Math.cos(10 * RAD);

/** The union-find's root of `i`, the path to it halved on the way. */
function rootOf(parent, i) {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
}

/**
 * The faces that look up, as a grid across the bed of how low the lowest of them lies in each cell: `under(x, y, z)`
 * says whether any of them lies below a point, which is where a support under it would stand if not on the bed. A
 * face is written into the cells it crosses, row by row, so the work grows with what the faces cover and never
 * with how many of them there are times the grid: long thin faces by the hundred thousand cost no more than small
 * ones. The answer is good to a cell, a five-hundredth of the piece.
 */
function facesBelow(X, T, up, lo, hi) {
  const n = PRINT_CHECK.grid;
  const w = Math.max(hi[0] - lo[0], 1e-9) / n;
  const h = Math.max(hi[1] - lo[1], 1e-9) / n;
  const cellOf = (v, from, step) => Math.max(0, Math.min(n - 1, Math.floor((v - from) / step)));
  const low = new Float32Array(n * n).fill(Infinity);
  for (const t of up) {
    const a = T[3 * t] * 3, b = T[3 * t + 1] * 3, c = T[3 * t + 2] * 3;
    const px = [X[a], X[b], X[c]];
    const py = [X[a + 1], X[b + 1], X[c + 1]];
    const pz = [X[a + 2], X[b + 2], X[c + 2]];
    // the face's plane: z = pz[0] + gx (x − px[0]) + gy (y − py[0])
    const nx = (py[1] - py[0]) * (pz[2] - pz[0]) - (pz[1] - pz[0]) * (py[2] - py[0]);
    const ny = (pz[1] - pz[0]) * (px[2] - px[0]) - (px[1] - px[0]) * (pz[2] - pz[0]);
    const nz = (px[1] - px[0]) * (py[2] - py[0]) - (py[1] - py[0]) * (px[2] - px[0]);
    if (!(nz > 0)) continue;
    const gx = -nx / nz, gy = -ny / nz;
    const zLo = Math.min(pz[0], pz[1], pz[2]), zHi = Math.max(pz[0], pz[1], pz[2]);
    const j1 = cellOf(Math.max(py[0], py[1], py[2]), lo[1], h);
    for (let j = cellOf(Math.min(py[0], py[1], py[2]), lo[1], h); j <= j1; j++) {
      // what of the face lies in this row of cells: its edges, cut to the row
      const y0 = lo[1] + j * h, y1 = y0 + h;
      let x0 = Infinity, x1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const q = (k + 1) % 3;
        const ya = py[k], yb = py[q];
        if ((ya < y0 && yb < y0) || (ya > y1 && yb > y1)) continue;
        const run = yb - ya;
        for (const y of [y0, y1]) {
          const s = run === 0 ? 0 : Math.max(0, Math.min(1, (y - ya) / run));
          const x = px[k] + s * (px[q] - px[k]);
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
        }
        if (run === 0) {
          x0 = Math.min(x0, px[q]);
          x1 = Math.max(x1, px[q]);
        }
      }
      if (x0 > x1) continue;
      const i1 = cellOf(x1, lo[0], w);
      const y = y0 + h / 2 - py[0];
      for (let i = cellOf(x0, lo[0], w); i <= i1; i++) {
        const z = Math.max(zLo, Math.min(zHi, pz[0] + gx * (lo[0] + (i + 0.5) * w - px[0]) + gy * y));
        if (z < low[j * n + i]) low[j * n + i] = z;
      }
    }
  }
  return (x, y, z) => low[cellOf(y, lo[1], h) * n + cellOf(x, lo[0], w)] < z - 1e-4;
}

/**
 * The measure of a level ceiling's spans: `at(x, y)` says how far the ceiling spans at a point of it, from a wall
 * under it on one side to a wall under it on the other – the shortest such way across, looked for in `spanTurns`
 * directions; Infinity where no direction has a wall at both ends: a ledge, held on one side and free on the other.
 * And how far such a ledge stands out there: the shortest way across from a wall under it, square out of the wall,
 * to a free edge.
 *
 * For each direction the rim's edges are sorted into bands that run along it, so a line across the ceiling is tried
 * against the few edges in its own band and not against all of them: the work grows with the faces plus the edges,
 * not with one times the other, and a finely meshed ceiling is measured as a coarse one is.
 * @param {number[]} rim the ceiling's rim, five numbers an edge: x, y of each end, and 1 where a wall under it holds it
 * @returns {{ at: (x: number, y: number) => number[], spent: () => number }} `at` gives the span and the ledge's
 *   depth, mm, Infinity for none; `spent` how many edges have been tried so far
 */
function spanMeasure(rim) {
  const edges = rim.length / 5;
  const bands = Math.max(1, Math.min(4096, Math.ceil(edges / 4)));
  const turns = [];
  for (let k = 0; k < PRINT_CHECK.spanTurns; k++) {
    const dx = Math.cos((k * Math.PI) / PRINT_CHECK.spanTurns);
    const dy = Math.sin((k * Math.PI) / PRINT_CHECK.spanTurns);
    // how far to the side of the direction each edge reaches, and so which bands it crosses
    const side = new Float64Array(edges * 2);
    let from = Infinity, to = -Infinity;
    for (let e = 0; e < edges; e++) {
      const p = rim[5 * e + 1] * dx - rim[5 * e] * dy;
      const q = rim[5 * e + 3] * dx - rim[5 * e + 2] * dy;
      side[2 * e] = Math.min(p, q) - 1e-6;
      side[2 * e + 1] = Math.max(p, q) + 1e-6;
      from = Math.min(from, side[2 * e]);
      to = Math.max(to, side[2 * e + 1]);
    }
    const step = Math.max(to - from, 1e-9) / bands;
    const bandOf = (v) => Math.max(0, Math.min(bands - 1, Math.floor((v - from) / step)));
    const start = new Int32Array(bands + 1);
    for (let e = 0; e < edges; e++) for (let j = bandOf(side[2 * e]); j <= bandOf(side[2 * e + 1]); j++) start[j + 1]++;
    for (let j = 0; j < bands; j++) start[j + 1] += start[j];
    const list = new Int32Array(start[bands]);
    const fill = start.slice(0, bands);
    for (let e = 0; e < edges; e++) for (let j = bandOf(side[2 * e]); j <= bandOf(side[2 * e + 1]); j++) list[fill[j]++] = 5 * e;
    turns.push({ dx, dy, bandOf, start, list });
  }
  let spent = 0;
  const at = (x, y) => {
    let best = Infinity;
    let ledge = Infinity;
    for (const { dx, dy, bandOf, start, list } of turns) {
      // the nearest edge of the rim each way along the line, whether it is held, and how squarely the line meets it
      let ahead = Infinity, back = -Infinity, heldAhead = false, heldBack = false, squareAhead = 0, squareBack = 0;
      const band = bandOf(y * dx - x * dy);
      spent += start[band + 1] - start[band];
      for (let j = start[band]; j < start[band + 1]; j++) {
        const e = list[j];
        const ex = rim[e + 2] - rim[e], ey = rim[e + 3] - rim[e + 1];
        const d = dx * ey - dy * ex;
        if (Math.abs(d) < 1e-12) continue;
        const wx = rim[e] - x, wy = rim[e + 1] - y;
        const s = (wx * dy - wy * dx) / d;
        if (s < -1e-9 || s > 1 + 1e-9) continue;
        const t = (wx * ey - wy * ex) / d;
        const held = rim[e + 4] === 1;
        const square = Math.abs(d) / Math.hypot(ex, ey);
        // where two edges meet on the line, a free one tells
        if (t > 0) {
          if (t < ahead - 1e-9) (ahead = t), (heldAhead = held), (squareAhead = square);
          else if (t < ahead + 1e-9) (heldAhead = heldAhead && held), (squareAhead = Math.min(squareAhead, square));
        } else if (t > back + 1e-9) (back = t), (heldBack = held), (squareBack = square);
        else if (t > back - 1e-9) (heldBack = heldBack && held), (squareBack = Math.min(squareBack, square));
      }
      if (!(ahead - back < Infinity)) continue;
      if (heldAhead && heldBack) best = Math.min(best, ahead - back);
      // a ledge's depth is measured square out of its wall: aslant, a face in its corner would seem to stand out little
      else if ((heldAhead && squareAhead >= SQUARE) || (heldBack && squareBack >= SQUARE)) ledge = Math.min(ledge, ahead - back);
    }
    return [best, ledge];
  };
  return { at, spent: () => spent };
}

/**
 * The big faces that lean a little off level, from the bins the pass filled: bins within `stepMerge` degrees of the
 * largest left are one face with it, and a face is kept when it is big enough for the piece. Each bin is left with
 * the number of the face it went into (`face`, from 1 in the list returned; 0 for none).
 */
function leaningFaces(bins, least) {
  const list = [...bins.values()].sort((p, q) => q.area - p.area);
  for (const bin of list) bin.face = 0;
  const near = Math.cos(PRINT_CHECK.stepMerge * RAD);
  const unit = list.map((b) => {
    const len = Math.hypot(b.n[0], b.n[1], b.n[2]) || 1;
    return b.n.map((v) => v / len);
  });
  const used = new Uint8Array(list.length);
  const faces = [];
  for (let i = 0; i < list.length; i++) {
    if (used[i]) continue;
    const face = { area: list[i].area, n: [...list[i].n], lo: list[i].lo, hi: list[i].hi, bins: [list[i]] };
    for (let j = i + 1; j < list.length; j++) {
      if (used[j] || unit[i][0] * unit[j][0] + unit[i][1] * unit[j][1] + unit[i][2] * unit[j][2] < near) continue;
      used[j] = 1;
      face.bins.push(list[j]);
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
      normal: face.n.map((v) => v / len),
      bins: face.bins,
    });
  }
  faces.sort((p, q) => q.area - p.area);
  // each bin knows which face it went into: its number in the list, from 1
  return faces.map(({ bins: own, ...face }, i) => {
    for (const bin of own) bin.face = i + 1;
    return face;
  });
}

/**
 * The print check of one piece: its triangles as they are in the model, and how the piece is turned to print.
 * Nothing in it depends on the layer height: `stepLines` and `checkRow` bring that in.
 * @param {Float32Array|number[]} vertProperties the piece's points, `numProp` numbers each (x, y, z first)
 * @param {number} numProp
 * @param {Uint32Array|number[]} triVerts three points a triangle; triangles that meet share their points
 * @param {{ turn?: number[]|null, planes?: { axis: number, at: number }[], made?: ArrayLike<number>|null,
 *   work?: number, faces?: boolean, skirt?: boolean }} options
 *   `turn` the 4 × 4 matrix (column-major) that turns the piece the way it prints, +z up – only its turn is used, the
 *   piece's lowest point is the bed; `planes` the cuts the piece touches, as it is in the model: a face on one is a
 *   glue face; `made` one number a triangle, not 0 for a face the app made for a joint (a hole, a socket, a lip, a
 *   lock, a label): those print without supports by design and are counted apart; `work` how many steps
 *   one ceiling's spans may take before near faces share a measure (`PRINT_CHECK.spanWork`); `faces: true` also
 *   gives `faces`, what each triangle was counted as (`FACE`, `faceKind`, `faceLean`): the very triangles the areas
 *   below are sums of, for a picture that says what the words say; `skirt: false` leaves no narrow band at the bed
 *   out as a rounded bottom edge – for a piece tipped in its file, whose flat underside rises off the bed like one
 * @returns {{ height: number, box: number[], faces?: Uint8Array,
 *   supports: { area: number, skin: number, seam: number, bed: number, piece: number, shallow: number, places: number,
 *   bridged: number, span: number, reach: number, joints: number },
 *   leaning: { facing: 'up'|'down', tilt: number, area: number, rise: number, normal: number[] }[],
 *   foot: { contact: number, across: number[]|null, base: number, ratio: number, flat: boolean, tip: boolean,
 *   small: boolean, strip: boolean, off: boolean } }}
 *   `height` and `box` (its two sides on the bed) as it lies. `supports`, all mm² as seen from below: `area` what may
 *   need supports, of which `skin` on the model's own faces and `seam` on glue faces; of which `bed` where a support
 *   would stand on the bed and `piece` where it would stand on the piece itself; `shallow` the part under 30° from
 *   level; `places` how many patches it is in; `bridged` the short level spans, small ledges and rounded bottom edges left out; `span` the
 *   area of the longer level spans the printer is left to bridge (not in `area`) and `reach` the longest of them, mm;
 *   `joints` the area of the joints' own faces left out. A glue face among them (`seam`) is a safeguard: a straight
 *   cut's face that looks down is what its piece lies on, so the pieces of a split do not normally have one.
 *   `leaning` the big faces a little off level, largest first (`tilt` degrees off level,
 *   `rise` how far the face climbs, mm, `normal` the way it looks as the piece lies, one long). `foot`: `contact` the area on the bed, `across` the two sides of the box it
 *   spans, `base` the shorter of them, `ratio` the piece's height over that, `flat` whether it has a flat foot at
 *   all, `tip` whether it may tip, `small` whether its foot is small, `strip` whether it is a narrow strip under a
 *   wider piece (a round bar lying down), `off` whether its weight hangs past its foot
 */
export function printCheck(vertProperties, numProp, triVerts, { turn = null, planes = [], made = null, work = PRINT_CHECK.spanWork, faces: tell = false, skirt = true } = {}) {
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
  const told = tell ? new Uint8Array(tris) : null; // what each triangle is counted as (`FACE`)
  const binOf = tell ? new Int32Array(tris).fill(-1) : null; // the bin of each triangle that leans a little
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
      if (binOf) binOf[t] = key;
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

  const supports = { area: 0, skin: 0, seam: 0, bed: 0, piece: 0, shallow: 0, places: 0, bridged: 0, span: 0, reach: 0, joints };
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
      if (!place) places.set(r, (place = { area: 0, level: true, lo: Infinity, hi: -Infinity, round: 0, rim: [], list: [] }));
      return place;
    };
    over.forEach((t, i) => {
      const place = placeOf(i);
      place.area += info[3 * i];
      if (info[3 * i + 1] > levelNz) place.level = false;
      for (let k = 0; k < 3; k++) {
        const z = X[T[3 * t + k] * 3 + 2] - z0;
        if (z < place.lo) place.lo = z;
        if (z > place.hi) place.hi = z;
      }
      place.list.push(i);
    });
    // how long each place's outline is, as seen from below: its area over half of that is how wide a band it is
    for (const [key, i] of edges) {
      const p = Math.floor(key / count) * 3, q = (key % count) * 3;
      placeOf(i).round += Math.hypot(X[p] - X[q], X[p + 1] - X[q + 1]);
    }
    // a ceiling is level when every face of it is and it rises less than a layer in all: a roof that slopes, however
    // little, is laid in strips that hang from one side, and no printer bridges those
    for (const place of places.values()) if (place.hi - place.lo > R.firstLayer) place.level = false;
    // a level place's rim: an edge is held where the face beside it is a wall under the ceiling – it goes down from
    // the edge and looks in under the ceiling – and free where it is not: the open edge of a shelf, or its end, flush
    // with the end of the wall it is on
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
          const place = placeOf(i);
          if (!place.level) continue;
          const r = T[3 * t + ((k + 2) % 3)] * 3;
          const px = X[p * 3], py = X[p * 3 + 1], qx = X[q * 3], qy = X[q * 3 + 1];
          // which way the face beside looks, and where the ceiling lies from the edge: its own third point
          const nx = (qy - py) * (X[r + 2] - X[p * 3 + 2]) - (X[q * 3 + 2] - X[p * 3 + 2]) * (X[r + 1] - py);
          const ny = (X[q * 3 + 2] - X[p * 3 + 2]) * (X[r] - px) - (qx - px) * (X[r + 2] - X[p * 3 + 2]);
          const mine = over[i];
          let o = T[3 * mine];
          if (o === p || o === q) o = T[3 * mine + 1];
          if (o === p || o === q) o = T[3 * mine + 2];
          const inward = nx * (X[o * 3] - (px + qx) / 2) + ny * (X[o * 3 + 1] - (py + qy) / 2) > 0;
          const down = X[r + 2] < Math.min(X[p * 3 + 2], X[q * 3 + 2]) - 1e-6;
          place.rim.push(px, py, qx, qy, down && inward ? 1 : 0);
        }
      }
    }
    let under = null;
    // a face of a level ceiling is left out where the ceiling spans little there, or – where it is no span the printer
    // bridges – stands only a little out of its wall. A span to bridge is one all the way to its open ends, where a
    // face in its corner is as near the open edge as a small ledge's would be
    const leftOut = (span, ledge) => span <= R.bridge + 0.01 || (!(span <= R.bridgeLong + 0.01) && ledge <= R.lip + 0.01);
    for (const place of places.values()) {
      if (place.area < R.place) continue;
      // a rounded bottom edge: a narrow band that starts on the first layer and is steep enough a little way up
      if (skirt && place.lo <= R.firstLayer + 1e-6 && place.hi <= R.skirt && 2 * place.area <= R.skirtWide * place.round) {
        supports.bridged++;
        continue;
      }
      // how far each of a level place's faces spans between walls, or stands out of one. Every face is measured,
      // however many there are; only past `work` steps does a face take the measure of one near it
      let spans = null;
      if (place.level && place.rim.length) {
        const measure = spanMeasure(place.rim);
        const near = new Map();
        const cell = (v, a) => Math.min(R.spanCells - 1, Math.floor(((v - lo[a]) / Math.max(hi[a] - lo[a], 1e-9)) * R.spanCells));
        spans = place.list.map((i) => {
          const t = over[i];
          const a = T[3 * t] * 3, b = T[3 * t + 1] * 3, c = T[3 * t + 2] * 3;
          const x = (X[a] + X[b] + X[c]) / 3, y = (X[a + 1] + X[b + 1] + X[c + 1]) / 3;
          const key = cell(x, 0) * R.spanCells + cell(y, 1);
          const known = near.get(key);
          if (known && measure.spent() > work) return known;
          const span = measure.at(x, y);
          if (!known) near.set(key, span);
          return span;
        });
      }
      let counted = false;
      place.list.forEach((i, at) => {
        const seen = info[3 * i];
        const [span, ledge] = spans ? spans[at] : [Infinity, Infinity];
        if (leftOut(span, ledge)) return;
        const t = over[i];
        if (span <= R.bridgeLong + 0.01) {
          supports.span += seen;
          supports.reach = Math.max(supports.reach, span);
          if (told) told[t] = FACE.span;
          return;
        }
        counted = true;
        if (told) told[t] = info[3 * i + 2] ? FACE.seam : FACE.skin;
        const a = T[3 * t] * 3, b = T[3 * t + 1] * 3, c = T[3 * t + 2] * 3;
        supports.area += seen;
        supports[info[3 * i + 2] ? 'seam' : 'skin'] += seen;
        if (info[3 * i + 1] < shallowNz) supports.shallow += seen;
        under ??= facesBelow(X, T, up, lo, hi);
        const onPiece = under((X[a] + X[b] + X[c]) / 3, (X[a + 1] + X[b + 1] + X[c + 1]) / 3, (X[a + 2] + X[b + 2] + X[c + 2]) / 3);
        supports[onPiece ? 'piece' : 'bed'] += seen;
      });
      if (counted) supports.places++;
      else if (spans.every(([span, ledge]) => leftOut(span, ledge))) supports.bridged++;
    }
  }

  const flat = contact >= R.steady;
  const across = flat ? [spread[2] - spread[0], spread[3] - spread[1]] : null;
  const base = across ? Math.min(across[0], across[1]) : 0;
  const ratio = base > 0 ? height / base : Infinity;
  // the weight's middle past the box its foot spans: it hangs over, and may pull the piece off the bed
  const mid = volume > 1e-9 ? [com[0] / volume, com[1] / volume] : [box[0] / 2, box[1] / 2];
  const off = flat && (mid[0] < spread[0] - 1e-6 || mid[0] > spread[2] + 1e-6 || mid[1] < spread[1] - 1e-6 || mid[1] > spread[3] + 1e-6);
  // a narrow strip under a wider piece – the lowest facets of a round bar lying down – is no foot to tip on
  const strip = flat && base < R.strip && base < 0.5 * Math.min(box[0], box[1]);
  const tip = flat && !strip && (ratio > R.tipRatio || off);
  // little on the bed is a small foot only where the piece is tall for it, or the foot spans little of the piece: a
  // thin tube on its ring stands on little, all round its outline
  const share = flat ? (across[0] * across[1]) / Math.max(box[0] * box[1], 1e-9) : 0;
  const small = flat && !strip && height > R.tall && ((contact < R.smallFoot && (ratio > R.slim || share < R.ringShare)) || share < R.footShare);
  const leaning = leaningFaces(bins, Math.max(R.stepArea, R.stepShare * box[0] * box[1]));
  if (told) {
    for (let t = 0; t < tris; t++) {
      const face = binOf[t] < 0 ? 0 : bins.get(binOf[t]).face;
      if (face > 0) told[t] |= Math.min(face, LEAN_FACES) << 2;
      else if (binOf[t] >= 0 && bins.get(binOf[t]).n[2] > 0) told[t] |= LEAN_REST << 2;
    }
  }
  return {
    height,
    box,
    supports,
    leaning,
    foot: { contact, across, base, ratio, flat, tip, small, strip, off },
    ...(told ? { faces: told } : {}),
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
 * The face a piece would be tipped to print level: the largest of its big leaning faces on top that shows step lines
 * at a layer height – the one its line in the list tells of. Null when it has none.
 * @param {object|null} check from `printCheck`
 * @param {number} layer the layer height, mm
 * @returns {{ normal: number[], tilt: number, area: number }|null} `normal` the way the face looks as the piece lies
 */
export function levelFace(check, layer = 0.2) {
  const h = layer > 0 ? layer : 0.2;
  const top = (check?.leaning ?? [])
    .filter((f) => f.facing === 'up' && f.normal && Math.floor(f.rise / h + 1e-6) >= PRINT_CHECK.stepCount)
    .sort((p, q) => q.area - p.area)[0];
  return top ? { normal: [...top.normal], tilt: top.tilt, area: top.area } : null;
}

/**
 * Why a piece is not tipped to print `face` (`levelFace`) level, as far as its check as it lies tells: 'none' without
 * such a face, 'steep' where the face leans more than `tipMax` degrees, 'foot' where the piece stands on little as
 * it lies (nothing flat, a small foot, a strip, or it may tip) – tipped it would rest on an edge of that – and
 * 'steps' where the other big faces on its top that show step lines, and would still show them once it is tipped,
 * make up `tipGain` of them or more (a shallow roof, a low cone: levelling one face cures too little). Null where the
 * check has nothing against it.
 * @param {object|null} check from `printCheck`, of the piece as it lies
 * @param {{ tilt: number, normal?: number[] }|null} face
 * @param {number} layer the layer height, mm
 * @returns {'none'|'steep'|'foot'|'steps'|null}
 */
export function tipBarred(check, face, layer = 0.2) {
  if (!check || !face) return 'none';
  if (face.tilt > PRINT_CHECK.tipMax) return 'steep';
  const f = check.foot;
  if (!f.flat || f.tip || f.small || f.strip) return 'foot';
  if (face.normal) {
    // once the piece is tipped, another face leans as far off level as it is from the face made level now. It still
    // shows step lines where that is within what shows them and it would still climb a good few layers (about as
    // many as now, by how its lean changes – twice `stepCount`, to be sure of it)
    const h = layer > 0 ? layer : 0.2;
    const all = (check.leaning ?? []).filter((x) => x.facing === 'up' && x.normal && Math.floor(x.rise / h + 1e-6) >= PRINT_CHECK.stepCount);
    const still = (x) => {
      const apart = Math.acos(Math.max(-1, Math.min(1, x.normal[0] * face.normal[0] + x.normal[1] * face.normal[1] + x.normal[2] * face.normal[2]))) / RAD;
      if (apart < PRINT_CHECK.stepMerge || apart > PRINT_CHECK.stepMax) return false;
      return (x.rise * Math.sin(apart * RAD)) / Math.sin(x.tilt * RAD) / h >= 2 * PRINT_CHECK.stepCount;
    };
    const whole = all.reduce((sum, x) => sum + x.area, 0);
    const left = all.filter(still).reduce((sum, x) => sum + x.area, 0);
    if (whole > 0 && left >= PRINT_CHECK.tipGain * whole * (1 - 1e-6)) return 'steps';
  }
  return null;
}

/**
 * Whether tipping a piece to print `face` level would make it print worse than the step lines it cures, from its
 * check as it lies (`before`) and tipped (`after`). The rules: tipped, it must show step lines on less than half as
 * much of its top as it does now (`tipGain`), or too little is gained ('steps': levelling one face of a shallow
 * roof makes the other lean twice as much); the supports it needs besides those under what it lay on may not grow by
 * more than the face it makes level ('supports', with that growth as `extra`, mm²); and it may not stand more than
 * `tipRatio` times as tall as it is wide on the bed ('tall'). The supports under the face it lay on are the tip's
 * known price, told on the piece's line and in its note, and no reason to refuse it.
 * @param {object} before from `printCheck`
 * @param {object|null} after from `printCheck`, the piece turned as tipped
 * @param {{ area: number }} face
 * @param {number} layer the layer height, mm
 * @returns {{ why: 'steps'|'supports'|'tall'|'unknown', extra?: number }|null} null where it may be tipped
 */
export function tipWorse(before, after, face, layer = 0.2) {
  if (!after) return { why: 'unknown' };
  // (a hair is given: the two sides of a roof are the same size but for how their numbers round)
  if (stepArea(after, layer) >= PRINT_CHECK.tipGain * stepArea(before, layer) * (1 - 1e-6)) return { why: 'steps' };
  const extra = after.supports.area - before.supports.area - before.foot.contact;
  if (extra > face.area) return { why: 'supports', extra };
  if (after.height > PRINT_CHECK.tipRatio * Math.min(after.box[0], after.box[1])) return { why: 'tall' };
  return null;
}

/** How much of a piece's top shows step lines at a layer height (mm²): its big leaning faces that look up. */
export const stepArea = (check, layer = 0.2) => stepLines(check?.leaning, layer).reduce((sum, f) => sum + (f.facing === 'up' ? f.area : 0), 0);

/** Every leaning face that shows step lines at a layer height, with them. `face` is its number in `leaning`, from 1. */
function leaningRows(leaning, layer) {
  const h = layer > 0 ? layer : 0.2;
  return (leaning ?? []).map((f, i) => ({ ...stepLines([f], h)[0], face: i + 1 })).filter((f) => f.lines >= PRINT_CHECK.stepCount);
}

/**
 * The leaning faces a piece's row keeps, with their step lines at a layer height: the largest few, those facing up
 * first. `face` is each one's number in `leaning`, from 1.
 */
function rowSteps(leaning, layer) {
  return leaningRows(leaning, layer)
    .sort((p, q) => (p.facing === 'up' ? 0 : 1) - (q.facing === 'up' ? 0 : 1) || q.area - p.area)
    .slice(0, PRINT_CHECK.steps);
}

/**
 * A piece's check as its row carries it: rounded, with the step lines of the layer height and the brim a risky foot
 * wants.
 * @param {object} check from `printCheck`
 * @param {number} layer the layer height, mm
 * @returns {{ layer: number, height: number,
 *   supports: { area: number, skin: number, seam: number, bed: number, piece: number, shallow: number, places: number,
 *   bridged: number, span: number, reach: number },
 *   steps: { facing: 'up'|'down', tilt: number, area: number, every: number }[],
 *   foot: { contact: number, across: number[]|null, flat: boolean, tip: boolean, small: boolean, strip: boolean,
 *   brim: number } }}
 *   areas in whole mm²; `steps` the largest few, those facing up first; `brim` the brim to add in mm, 0 for none
 */
export function checkRow(check, layer = 0.2) {
  const s = check.supports;
  const steps = rowSteps(check.leaning, layer).map((f) => ({ facing: f.facing, tilt: round1(f.tilt), area: Math.round(f.area), every: round1(f.every) }));
  const f = check.foot;
  const risky = f.tip || f.small || f.strip;
  return {
    layer,
    height: round1(check.height),
    supports: {
      area: Math.round(s.area), skin: Math.round(s.skin), seam: Math.round(s.seam), bed: Math.round(s.bed), piece: Math.round(s.piece),
      shallow: Math.round(s.shallow), places: s.places, bridged: s.bridged, span: Math.round(s.span), reach: Math.round(s.reach),
    },
    steps,
    foot: {
      contact: Math.round(f.contact),
      across: f.across ? f.across.map(round1) : null,
      flat: f.flat,
      tip: f.tip,
      small: f.small,
      strip: f.strip,
      brim: risky ? (!f.strip && f.ratio > PRINT_CHECK.tallRatio ? PRINT_CHECK.brimTall : PRINT_CHECK.brim) : 0,
    },
  };
}

/**
 * What of a piece's check a picture of it shows, one number a triangle (`faceKind`, `faceLean`), so that the picture
 * says what the piece's line says: the faces that may need supports only where the line says it may need them, a
 * level span only where the line tells of one, and step lines only where the line tells of them – on a big leaning
 * face on top. Then every face on top that leans as little is marked, not only the largest the line names: a shallow
 * roof that is round is many faces side by side, big and small, and its step lines run all the way round it. A
 * leaning face that looks down is never marked: it prints on supports, or on the layer under it, and shows no step
 * lines worth drawing.
 * @param {object|null} check from `printCheck` with `faces: true`
 * @param {number} layer the layer height, mm
 * @param {object|null} told the check the piece's line is made from, where that is another (the piece itself, where
 *   `check` is of a lighter copy shown in its place)
 * @returns {Uint8Array|null} null without the check's `faces`
 */
export function shownFaces(check, layer = 0.2, told = null) {
  if (!check?.faces) return null;
  const said = (told ?? check).supports;
  const supports = Math.round(said.area) >= PRINT_CHECK.none;
  const span = Math.round(said.span) >= PRINT_CHECK.none;
  const onTop = (c) => leaningRows(c.leaning, layer).filter((f) => f.facing === 'up');
  const kept = new Set(onTop(told ?? check).length ? [...onTop(check).map((f) => Math.min(f.face, LEAN_FACES)), LEAN_REST] : []);
  return check.faces.map((b) => {
    const kind = faceKind(b);
    const shown = kind === FACE.span ? span : kind !== FACE.none && supports;
    return (shown ? kind : FACE.none) | (kept.has(faceLean(b)) ? faceLean(b) << 2 : 0);
  });
}

/**
 * Where the step lines fall on a piece's leaning faces, as line segments to draw on it. A slicer reads each layer's
 * outline at the middle of the layer's height, so a line shows where the face crosses one of those levels: half a
 * layer up from the bed, and every layer from there. They are about where the printer will leave them – the first
 * layer may be of another height, and the mesh drawn may be a lighter copy.
 *
 * Not every line need be drawn. Where the lines would lie closer than `apart` mm across a face, only every second
 * level is drawn there, or every fourth, and so on, until they are that far apart: closer than a few dots of the
 * screen they would run into one dark sheet. That goes by each triangle's own lean, so a flat face is thinned alike
 * all over and a rounded one more where it is steeper. And never more than `cap` segments are made: past that every
 * triangle keeps half its levels again, as often as that leaves any; what is still too many (a fine mesh that
 * crosses few levels) is cut short. The levels kept are whole multiples of a triangle's step, so triangles that lean
 * alike keep the same ones and a line runs on from one to the next.
 * @param {ArrayLike<number>} positions the piece's points as they are in the model, three numbers each
 * @param {ArrayLike<number>} index three points a triangle
 * @param {ArrayLike<number>} faces one number a triangle (`shownFaces`): only triangles of a leaning face are cut
 * @param {{ turn?: number[]|null, layer?: number, cap?: number, apart?: number, lift?: number }} options `turn` the
 *   4 × 4 matrix (column-major) that lays the piece on the bed, the bed at z = 0; `layer` the layer height, mm; `cap`
 *   the most segments; `apart` the least distance between two lines drawn on a face, mm (0: every line is drawn);
 *   `lift` how far off the face the lines are drawn (mm), so they are not lost in it
 * @returns {{ segments: Float32Array, lines: number, every: number, thinned: boolean }} `segments` six numbers each,
 *   the two ends as they are in the model; `lines` how many; `every` 1 where every level is drawn, 2 where some
 *   triangle has every second only, …; `thinned` whether any line was left out
 */
export function stepSegments(positions, index, faces, { turn = null, layer = 0.2, cap = 400000, apart = 0, lift = 0 } = {}) {
  const h = layer > 0 ? layer : 0.2;
  const most = Math.max(1, Math.floor(cap));
  const m = turn ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const height = (v) => m[2] * positions[v] + m[6] * positions[v + 1] + m[10] * positions[v + 2] + m[14];
  // a triangle's normal as it is in the model, twice its area long
  const normal = (a, b, c) => {
    const u = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const w = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  };
  const tris = Math.min(Math.floor(index.length / 3), faces?.length ?? 0);
  // the leaning triangles that cross a level, four numbers each: which, how many levels apart its lines are drawn,
  // and the first and last level it crosses – those above its lowest point, up to its highest
  const leaning = [];
  let top = 0;
  for (let t = 0; t < tris; t++) {
    if (!faceLean(faces[t])) continue;
    const a = index[3 * t] * 3, b = index[3 * t + 1] * 3, c = index[3 * t + 2] * 3;
    const za = height(a), zb = height(b), zc = height(c);
    const from = Math.max(0, Math.floor(Math.min(za, zb, zc) / h - 0.5) + 1);
    const to = Math.floor(Math.max(za, zb, zc) / h - 0.5);
    if (to < from) continue;
    // for its lines to be `apart` from each other across it: a face `tilt` off level climbs a layer every
    // `layer / sin(tilt)` mm of itself (a hair is given, so that lines just that far apart are all kept)
    let every = 1;
    if (apart > 0) {
      const n = normal(a, b, c);
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      const up = (m[2] * n[0] + m[6] * n[1] + m[10] * n[2]) / len;
      const sine = Math.sqrt(Math.max(0, 1 - up * up));
      while (every * h < apart * sine * (1 - 1e-4) && every <= to) every *= 2;
    }
    leaning.push(t, every, from, to);
    if (to > top) top = to;
  }
  // within the cap: every triangle keeps half its levels again, while that helps
  const count = (times) => {
    let n = 0;
    for (let i = 0; i < leaning.length; i += 4) {
      const e = leaning[i + 1] * times;
      n += Math.floor(leaning[i + 3] / e) - Math.ceil(leaning[i + 2] / e) + 1;
    }
    return n;
  };
  let times = 1;
  while (times <= top && count(times) > most && count(times * 2) > 0) times *= 2;
  let every = 1;
  for (let i = 0; i < leaning.length; i += 4) every = Math.max(every, (leaning[i + 1] *= times));
  const out = [];
  let cut = false;
  for (let i = 0; i < leaning.length && !cut; i += 4) {
    const t = leaning[i];
    const e = leaning[i + 1];
    const v = [index[3 * t] * 3, index[3 * t + 1] * 3, index[3 * t + 2] * 3];
    const z = v.map(height);
    // off the face along its own normal
    let off = [0, 0, 0];
    if (lift) {
      const n = normal(v[0], v[1], v[2]);
      const len = Math.hypot(n[0], n[1], n[2]);
      if (len > 0) off = n.map((x) => (x / len) * lift);
    }
    for (let k = Math.ceil(leaning[i + 2] / e) * e; k <= leaning[i + 3]; k += e) {
      const at = (k + 0.5) * h;
      const ends = [];
      for (let s = 0; s < 3 && ends.length < 6; s++) {
        const p = s, q = (s + 1) % 3;
        if (z[p] < at === z[q] < at) continue;
        const along = (at - z[p]) / (z[q] - z[p]);
        for (let a = 0; a < 3; a++) ends.push(positions[v[p] + a] + along * (positions[v[q] + a] - positions[v[p] + a]) + off[a]);
      }
      if (ends.length !== 6) continue;
      if (out.length / 6 >= most) {
        cut = true;
        break;
      }
      out.push(...ends);
    }
  }
  return { segments: Float32Array.from(out), lines: out.length / 6, every, thinned: every > 1 || cut };
}

/**
 * How far apart the step lines drawn on the pieces should be at least (mm), for them to stay lines on the screen:
 * `dots` screen dots between two of them, where what is shown – `across` mm from corner to corner – fills a view
 * `view` dots on its shorter side.
 */
export const stepsApart = (across, view, dots = 3) => (across > 0 && view > 0 ? (dots * across) / view : 0);

/** An area in plain words: "under 1 cm²", "about 12 cm²". */
export function areaWords(mm2) {
  return mm2 < 100 ? 'under 1 cm²' : `about ${Math.round(mm2 / 100)} cm²`;
}

/** A length in plain words, to the millimetre from 3 mm up and to half a millimetre under it. */
const lengthWords = (v) => (v >= 3 ? String(Math.round(v)) : String(Math.max(0.5, Math.round(v * 2) / 2)));

/**
 * How far apart a leaning face's step lines are: "about every 4 mm"; to a tenth of a millimetre where they are under
 * one apart ("about every 0.3 mm"), so that close lines are not told as wider apart than they are.
 */
export const everyWords = (every) => `about every ${every < 0.95 ? Math.max(0.1, round1(every)) : lengthWords(every)} mm`;

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
 * what it stands on, and how its pin holes print. A piece tipped in its file to print a leaning face level (`tip`;
 * how it lies says that it is) is told what that costs it: the supports it then needs, not only may need, under
 * what it lay on, that it rests on an edge or on one corner, and that supports must be kept out of its pin holes
 * that open onto the bed – they lean with the piece, and one side of each is then flatter than the safe rule's 45°.
 * @param {object|null} row from `checkRow`
 * @param {{ upright?: number, pointed?: number, flat?: number, round?: number }|null} holes the piece's pin holes by
 *   how they print (split.js `holeSummary`)
 * @param {{ fine?: boolean, tip?: boolean|{ rest?: 'edge'|'corner', holes?: { down?: number } } }} say `fine: false`
 *   leaves out the clause for pin holes that all print without supports, where that is said once for all the pieces
 *   (the sheet's heading); `tip` for a piece that is tipped: what it rests on (`rest`) and how many of its pin
 *   holes open onto the bed (`holes.down`), as its row has them
 * @returns {string[]} empty without a check and without holes
 */
export function checkWords(row, holes = null, { fine = true, tip = false } = {}) {
  const out = [];
  if (row) {
    const s = row.supports;
    if (s.area < PRINT_CHECK.none) out.push('no supports needed');
    else out.push(`${tip ? 'needs' : 'may need'} supports: ${[areaWords(s.area), seamWords(s), standWords(s)].filter(Boolean).join(', ')}`);
    if ((s.span ?? 0) >= PRINT_CHECK.none) out.push(`bridges a level span of about ${s.reach} mm`);
    const top = row.steps.find((f) => f.facing === 'up');
    if (top) out.push(`step lines ${everyWords(top.every)} on a big face on top`);
    if (tip && !row.foot.flat) out.push(tip.rest === 'corner' ? 'rests on one corner: the supports carry it' : `rests on an edge: add a brim, ${tipBrim(row)} mm wide`);
    else if (!row.foot.flat) out.push('nothing flat to stand on');
    else if (row.foot.strip) out.push(`rests on a narrow strip: add a brim, ${row.foot.brim} mm wide`);
    else if (row.foot.tip) out.push(`may tip: add a brim, ${row.foot.brim} mm wide`);
    else if (row.foot.small) out.push(`small foot: add a brim, ${row.foot.brim} mm wide`);
    else if (tip) out.push(`${areaWords(row.foot.contact)} on the bed: add a brim, ${tipBrim(row)} mm wide`);
  }
  const n = holes ? (holes.upright ?? 0) + (holes.pointed ?? 0) + (holes.flat ?? 0) + (holes.round ?? 0) : 0;
  if (n) {
    const round = holes.round ?? 0;
    const down = (tip && tip.holes?.down) || 0;
    if (round) out.push(`${round} of its ${n} pin holes may need supports`);
    else if (down) out.push(`keep supports out of ${down === 1 ? (n === 1 ? 'its pin hole' : 'its pin hole that opens onto the bed') : down === n ? `its ${n} pin holes` : `its ${down} pin holes that open onto the bed`}`);
    else if (fine) out.push(`${n === 1 ? 'its pin hole needs' : `its ${n} pin holes need`} no supports`);
  }
  return out;
}

/** An angle in plain words, as a leaning face's is told: whole degrees from 3 up, to half a degree under it. */
export const angleWords = (deg) => lengthWords(deg);

/** The brim a tipped piece wants (mm): what its foot asks for where it has one that is risky, else the usual one. */
const tipBrim = (row) => row.foot.brim || PRINT_CHECK.brim;

/**
 * The words of the note for a piece tipped in its file so that a big leaning face prints level (split.js
 * `PIECE_TIPPED`), after the piece's name: what was done, what it costs – the supports under what it lay on, a glue
 * face printed on them, what is left on the bed – what to set in the slicer, and what there is to know of its pin
 * holes: those that lie on their side were shaped for the tip; those that open onto the bed were not, lean with the
 * piece, and must be kept free of supports.
 * @param {string} who "Piece 3"
 * @param {{ angle: number, area: number, check: object, rest?: 'edge'|'corner', holes?: { lying?: number,
 *   upright?: number, down?: number }|null }} fields the angle it is tipped by (degrees), the area of the face that
 *   prints level (mm²), the tipped piece's check (`checkRow`), whether it rests on an edge or on one corner, and
 *   its pin holes: how many lie on their side, how many stand upright, and how many of those open onto the bed
 * @returns {string}
 */
export function tipNoteWords(who, { angle = 0, area = 0, check = null, rest = 'edge', holes = null }) {
  const out = [`${who} is tipped ${angleWords(angle)}° in its file so that its big face on top (${areaWords(area)}) prints level, without step lines.`];
  if (!check) return out[0];
  const s = check.supports;
  const corner = !check.foot.flat && rest === 'corner';
  const rests = check.foot.flat ? `rests on ${areaWords(check.foot.contact)} of the bed` : corner ? 'rests on one corner' : 'rests on an edge';
  if (s.area >= PRINT_CHECK.none) {
    out.push(`What that costs: it no longer lies flat – it ${rests}, and ${areaWords(s.area)} under it prints on supports, ${standWords(s)}.`);
    if (s.seam >= PRINT_CHECK.none) out.push(`${s.seam >= 0.9 * s.area ? 'That is a glue face' : `${areaWords(s.seam)} of that is a glue face`}: on supports it prints rough and may want light sanding before you glue it.`);
  } else out.push(`What that costs: it no longer lies flat – it ${rests}.`);
  const where = s.piece < 0.1 * s.area ? '"on build plate only" is enough' : 'everywhere, not only on the build plate';
  // on one corner a brim has next to nothing to hold: the supports carry the piece
  const hold = corner ? 'The supports carry it, as it touches the bed at one corner only: a raft holds it better than a brim.' : '';
  out.push(`In your slicer turn off auto-orient and don't use "lay on face" for it${s.area >= PRINT_CHECK.none ? `, turn supports on (${where})` : ''}${corner ? '.' : ` and add a brim about ${tipBrim(check)} mm wide.`}${hold ? ` ${hold}` : ''}`);
  const lying = holes?.lying ?? 0;
  const down = holes?.down ?? 0;
  if (lying) out.push(`${(holes.upright ?? 0) ? 'Its pin holes that lie on their side' : 'Its pin holes'} are shaped for lying tipped.`);
  if (down) out.push(`${down === 1 ? 'Its pin hole that opens onto the bed leans with the piece, so one side of its end is' : `Its ${down} pin holes that open onto the bed lean with the piece, so one side of each one's end is`} a little flatter than 45°: keep supports out of ${down === 1 ? 'it' : 'them'} (a support blocker over ${down === 1 ? 'the hole' : 'each hole'}), or they are hard to dig out and the ${down === 1 ? 'pin' : 'pins'} won't go in.`);
  out.push('Untick "Tip this piece" in the pieces list to print it flat again, with the step lines.');
  return out.join(' ');
}

/**
 * What of a piece's check is worth a note, as the note's fields; null when nothing is. Supports under a good deal of
 * the model's own faces (a little is said on the piece's line only) or under a glue face (which prints rough on
 * them), a big face on top that will show step lines, and a piece that may tip, stands on a small foot or rests on
 * a narrow strip.
 * @param {object|null} row from `checkRow`
 * @returns {{ supports?: object, steps?: object, foot?: object, layer: number, height: number }|null}
 */
export function checkNote(row) {
  if (!row) return null;
  const s = row.supports;
  const top = row.steps.find((f) => f.facing === 'up');
  const risky = row.foot.flat && (row.foot.tip || row.foot.small || Boolean(row.foot.strip));
  const supported = s.skin >= PRINT_CHECK.note || s.seam >= PRINT_CHECK.noteSeam;
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
 * @param {{ supports?: object, steps?: object, foot?: object, layer?: number, height?: number, whole?: boolean,
 *   auto?: boolean }} fields from `checkNote`; `whole` for a model printed in one piece, which is not laid at all;
 *   `auto` for a piece laid the way that needs least support already, which is not told to try another
 * @returns {string}
 */
export function checkNoteWords(who, { supports = null, steps = null, foot = null, layer = 0.2, height = 0, whole = false, auto = false }) {
  const out = [];
  const name = () => (out.length ? 'It' : who);
  if (supports) {
    const own = supports.skin >= PRINT_CHECK.note;
    const what = own ? `${areaWords(supports.skin)} of ${whole ? 'its' : "the model's own"} faces` : `${areaWords(supports.seam)} of a glue face`;
    const cure = whole ? ' Turned another way it may need less.' : auto ? '' : ' Laid another way it may need less.';
    out.push(`${name()} may need supports under ${what}, ${standWords(supports, whole)}.${cure}`);
    if (supports.seam >= PRINT_CHECK.noteSeam) out.push('A glue face on supports prints rough and may want light sanding before you glue it.');
  }
  if (steps) {
    out.push(`${name()} has a big face on top (${areaWords(steps.area)}) that leans ${lengthWords(steps.tilt)}° off level: at ${layer} mm layers it prints with a step line ${everyWords(steps.every)}. ${whole ? 'Turning the model so that the face is level or upright' : 'Another way to lay it'}, or finer layers, shows them less.`);
  }
  if (foot) {
    const on = foot.across ? `a ${foot.across.map(lengthWords).join(' × ')} mm foot` : 'a small foot';
    const what = foot.strip ? `${name()} rests on a narrow strip of the bed and may come loose` : foot.tip ? `${name()} stands ${lengthWords(height)} mm tall on ${on} and may tip or come loose` : `${name()} stands on ${on}, small for its size, and may come loose`;
    out.push(`${what}: add a brim about ${foot.brim} mm wide in your slicer${whole ? '' : ', or lay it another way'}.`);
  }
  return out.join(' ');
}
