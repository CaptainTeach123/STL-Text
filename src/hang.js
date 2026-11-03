// The slice graph: what a cut leaves loose, and what it leaves held on only near its face.
//
// A model is sliced across one axis at a couple of hundred places (the planner's samples). Each slice is drawn into a
// raster of the plane, a row of spans at a time (`rasterRings` from outlines, `rasterMesh` from the triangles in one
// pass). In each column the other axes' cuts make, a slice's material falls into islands, and an island is joined to
// the next slice's where the two lie over each other: the graph's components between two cuts are the shells the cut
// stage makes of that box. All but the largest are loose; and what comes loose when the w mm of the box next to a cut
// are left out is held on only within w of it, on a root that may snap. `looseTable` gives what every box of a column
// leaves loose (from every sample to every other), `boxHang` what a box between two cuts costs the planner for that
// (`hangAt` a cut, with the boxes either side), and `heldParts` the parts themselves, with where they are, for the notes.
//
// Plain numbers only: no solids, nothing to free.

/** The graph's sizes, and what the planner pays for what a cut leaves. */
export const HANG = Object.freeze({
  least: 0.5, // mm²: an island of a slice smaller than this is no material
  overlap: 0.25, // mm²: islands of neighbouring slices this much over each other are one
  loose: 1000, // mm³: a part this big or more counts as loose
  // and only when it is no more than this share of its box's largest: shells of a size – a U's two arms, a bookcase's
  // shelves – are pieces of their own, as the give-back (`cutPieces`) leaves them, not bits left loose
  share: 0.25,
  held: 5000, // mm³: a part this big or more counts as held on a short root
  reach: 30, // mm: held within this of the face costs the planner (H), less the further from the face
  warn: 15, // mm: held within this of the face, the notes warn
  whole: 5000, // mm³: a part this big costs the most (V0)
  costLoose: 100, // the cost of a whole part left loose, as much as a cut through letters
  costHeld: 50, // the cost of a whole part held right at the face
  // and of one held within `warn` on top, which the notes would warn of: of two plans that leave as much hanging, the
  // planner takes the one it need not warn about (a ribbon held 20 mm either side over one held 30 mm and 10 mm)
  costWarn: 25,
  pixels: 200000, // about how many pixels a slice's raster has at most
  finest: 0.1, // mm: the finest pixel
});

/**
 * The raster a model's slices across `axis` are drawn into: square pixels of `res` mm over the model's box in the
 * plane (u, v) = (axis + 1, axis + 2) mod 3, as `TO_PLANE` turns it, with a pixel to spare all round. A pixel is
 * material when its centre is.
 * @param {{ min: number[], max: number[] }} bounds the model's box
 * @param {number} axis 0, 1 or 2
 */
export function planeGrid(bounds, axis, { pixels = HANG.pixels, finest = HANG.finest, res = null } = {}) {
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const Eu = Math.max(bounds.max[u] - bounds.min[u], 1e-6);
  const Ev = Math.max(bounds.max[v] - bounds.min[v], 1e-6);
  const r = res ?? Math.min(1, Math.max(finest, Math.sqrt((Eu * Ev) / pixels)));
  return { axis, u, v, res: r, u0: bounds.min[u] - r, v0: bounds.min[v] - r, nu: Math.ceil(Eu / r) + 2, nv: Math.ceil(Ev / r) + 2 };
}

/** Where an edge from (pu, pv) to (qu, qv) crosses the rows' centre lines: a row counts it where one end is above. */
function addEdge(rows, xs, grid, pu, pv, qu, qv) {
  if (pv === qv) return;
  const { v0, res, nv } = grid;
  const lo = pv < qv ? pv : qv;
  const hi = pv < qv ? qv : pv;
  let j0 = Math.ceil((lo - v0) / res - 0.5);
  let j1 = Math.ceil((hi - v0) / res - 0.5);
  if (j0 < 0) j0 = 0;
  if (j1 > nv) j1 = nv;
  const k = (qu - pu) / (qv - pv);
  for (let j = j0; j < j1; j++) {
    rows.push(j);
    xs.push(pu + (v0 + (j + 0.5) * res - pv) * k);
  }
}

/** The spans of material in each row, from the crossings: in and out by turns, as the outlines are closed. */
function spansOf(rows, xs, grid) {
  const { nv, nu, u0, res } = grid;
  const m = rows.length;
  const start = new Int32Array(nv + 1);
  for (let t = 0; t < m; t++) start[rows[t] + 1]++;
  for (let j = 0; j < nv; j++) start[j + 1] += start[j];
  const fill = start.slice(0, nv);
  const sorted = new Float64Array(m);
  for (let t = 0; t < m; t++) sorted[fill[rows[t]]++] = xs[t];
  const at = new Int32Array(nv + 1);
  const out = [];
  let pixels = 0;
  for (let j = 0; j < nv; j++) {
    at[j] = out.length / 2;
    const row = sorted.subarray(start[j], start[j + 1]);
    row.sort();
    for (let t = 0; t + 1 < row.length; t += 2) {
      const a = Math.max(0, Math.ceil((row[t] - u0) / res - 0.5));
      const b = Math.min(nu, Math.ceil((row[t + 1] - u0) / res - 0.5));
      if (a >= b) continue;
      const last = out.length - 1;
      if (out.length / 2 > at[j] && out[last] >= a) {
        if (b > out[last]) {
          pixels += b - out[last];
          out[last] = b;
        }
      } else {
        out.push(a, b);
        pixels += b - a;
      }
    }
  }
  at[nv] = out.length / 2;
  return { rows: at, spans: Int32Array.from(out), pixels };
}

/**
 * A slice drawn from its outlines (closed rings in plane coordinates, as `CrossSection.toPolygons()` gives them).
 * @returns {{ rows: Int32Array, spans: Int32Array, pixels: number }} the spans [a, b) of pixel columns, row by row
 *   (`rows[j]` the first span of row j), and how many pixels are material
 */
export function rasterRings(rings, grid) {
  const rows = [];
  const xs = [];
  for (const ring of rings ?? []) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      addEdge(rows, xs, grid, p[0], p[1], q[0], q[1]);
    }
  }
  return spansOf(rows, xs, grid);
}

/**
 * The slices of a closed mesh across `grid.axis` at each of `at`, drawn in one pass over its triangles: a vertex on
 * a sample's plane counts as below it, and an edge is cut from its lower-numbered end, so the pieces of each outline
 * meet exactly.
 * @param {{ vertProperties: Float32Array, numProp: number, triVerts: Uint32Array }} mesh
 * @param {number[]} at the places along the axis, in any order
 * @returns {{ rows: Int32Array, spans: Int32Array, pixels: number }[]} one per place, in the order given
 */
export function rasterMesh({ vertProperties: P, numProp: np, triVerts: T }, at, grid) {
  const { axis, u, v } = grid;
  const order = at.map((_, k) => k).sort((p, q) => at[p] - at[q]);
  const samples = order.map((k) => at[k]);
  const n = samples.length;
  const rows = samples.map(() => []);
  const xs = samples.map(() => []);
  const e = [0, 0, 0, 0, 0, 0];
  for (let t = 0; t + 2 < T.length; t += 3) {
    const i0 = T[t];
    const i1 = T[t + 1];
    const i2 = T[t + 2];
    const a0 = P[i0 * np + axis];
    const a1 = P[i1 * np + axis];
    const a2 = P[i2 * np + axis];
    const amin = Math.min(a0, a1, a2);
    const amax = Math.max(a0, a1, a2);
    if (!(amax > amin)) continue;
    // the first sample at or over the triangle's lowest corner
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid] < amin) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < n && samples[k] < amax; k++) {
      const s = samples[k];
      let got = 0;
      for (let c = 0; c < 3; c++) {
        const x = c === 0 ? i0 : c === 1 ? i1 : i2;
        const y = c === 0 ? i1 : c === 1 ? i2 : i0;
        const ax = c === 0 ? a0 : c === 1 ? a1 : a2;
        const ay = c === 0 ? a1 : c === 1 ? a2 : a0;
        if (ax > s === ay > s) continue;
        const [p, q, ap, aq] = x < y ? [x, y, ax, ay] : [y, x, ay, ax];
        const f = (s - ap) / (aq - ap);
        e[got * 2] = P[p * np + u] + f * (P[q * np + u] - P[p * np + u]);
        e[got * 2 + 1] = P[p * np + v] + f * (P[q * np + v] - P[p * np + v]);
        got++;
      }
      if (got === 2) addEdge(rows[k], xs[k], grid, e[0], e[1], e[2], e[3]);
    }
  }
  const out = new Array(n);
  order.forEach((k, j) => {
    out[k] = spansOf(rows[j], xs[j], grid);
  });
  return out;
}

/** The pixel range [from, to) of the rows or columns whose centres lie in [lo, hi) mm (either may be infinite). */
export function pixelRange(lo, hi, origin, res, count) {
  const at = (x) => (x === -Infinity ? 0 : x === Infinity ? count : Math.min(count, Math.max(0, Math.ceil((x - origin) / res - 0.5))));
  return [at(lo), at(hi)];
}

/**
 * The columns the other axes' cuts make for cuts across `grid.axis`, in pixels: `[iu0, jv0, iu1, jv1]` each, and the
 * cell it is along u and v.
 * @param {number[][]} cutsByAxis sorted positions per axis (`axisCuts`)
 */
export function columnsOf(grid, cutsByAxis) {
  const eu = [-Infinity, ...(cutsByAxis[grid.u] ?? []), Infinity];
  const ev = [-Infinity, ...(cutsByAxis[grid.v] ?? []), Infinity];
  const out = [];
  for (let i = 0; i + 1 < eu.length; i++) {
    const [iu0, iu1] = pixelRange(eu[i], eu[i + 1], grid.u0, grid.res, grid.nu);
    for (let j = 0; j + 1 < ev.length; j++) {
      const [jv0, jv1] = pixelRange(ev[j], ev[j + 1], grid.v0, grid.res, grid.nv);
      out.push({ rect: [iu0, jv0, iu1, jv1], i, j });
    }
  }
  return out;
}

/**
 * One column's graph: each slice's islands within `rect` (pixels, as `columnsOf` gives), of `least` mm² or more,
 * with their areas (mm²) and pixel boxes, and the islands of each slice joined to the next one's where they lie over
 * each other by more than `overlap` mm².
 * @param {{ rows: Int32Array, spans: Int32Array }[]} slices one per sample
 * @returns {{ n: number, areas: Float64Array[], boxes: Int32Array[], links: Int32Array[] }} `boxes` per sample
 *   [iu0, iu1, jv0, jv1] (pixels, the ends past) per island; `links[q]` pairs [island of q − 1, island of q] (none
 *   for q = 0)
 */
export function columnGraph(slices, grid, rect, { least = HANG.least, overlap = HANG.overlap } = {}) {
  const [iu0, jv0, iu1, jv1] = rect;
  const px = grid.res * grid.res;
  const n = slices.length;
  const areas = [];
  const boxes = [];
  const links = [];
  let prev = null;
  for (let q = 0; q < n; q++) {
    const { rows, spans } = slices[q];
    // the spans within the column: row, from, to
    const cl = [];
    if (iu0 < iu1) {
      for (let j = jv0; j < jv1; j++) {
        for (let s = rows[j]; s < rows[j + 1]; s++) {
          const a = spans[2 * s] > iu0 ? spans[2 * s] : iu0;
          const b = spans[2 * s + 1] < iu1 ? spans[2 * s + 1] : iu1;
          if (a < b) cl.push(j, a, b);
        }
      }
    }
    const m = cl.length / 3;
    const parent = new Int32Array(m);
    for (let s = 0; s < m; s++) parent[s] = s;
    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    // spans of neighbouring rows that share a pixel column are one island
    let ps = 0;
    let pe = 0;
    for (let s = 0; s < m;) {
      const j = cl[3 * s];
      let e = s;
      while (e < m && cl[3 * e] === j) e++;
      if (pe > ps && cl[3 * ps] === j - 1) {
        let p = ps;
        let c = s;
        while (p < pe && c < e) {
          const pa = cl[3 * p + 1];
          const pb = cl[3 * p + 2];
          const ca = cl[3 * c + 1];
          const cb = cl[3 * c + 2];
          if (pa < cb && ca < pb) {
            const x = find(p);
            const y = find(c);
            if (x !== y) parent[x] = y;
          }
          if (pb < cb) p++;
          else c++;
        }
      }
      ps = s;
      pe = e;
      s = e;
    }
    const count = new Float64Array(m);
    const box = new Int32Array(4 * m);
    for (let s = 0; s < m; s++) {
      const r = find(s);
      const [j, a, b] = [cl[3 * s], cl[3 * s + 1], cl[3 * s + 2]];
      if (count[r] === 0) {
        box[4 * r] = a;
        box[4 * r + 1] = b;
        box[4 * r + 2] = j;
        box[4 * r + 3] = j + 1;
      } else {
        if (a < box[4 * r]) box[4 * r] = a;
        if (b > box[4 * r + 1]) box[4 * r + 1] = b;
        if (j < box[4 * r + 2]) box[4 * r + 2] = j;
        if (j + 1 > box[4 * r + 3]) box[4 * r + 3] = j + 1;
      }
      count[r] += b - a;
    }
    const island = new Int32Array(m).fill(-1);
    const area = [];
    const kept = [];
    for (let s = 0; s < m; s++) {
      if (parent[s] !== s || count[s] * px < least) continue;
      island[s] = area.length;
      area.push(count[s] * px);
      kept.push(box[4 * s], box[4 * s + 1], box[4 * s + 2], box[4 * s + 3]);
    }
    const of = new Int32Array(m);
    for (let s = 0; s < m; s++) of[s] = island[find(s)];
    areas.push(Float64Array.from(area));
    boxes.push(Int32Array.from(kept));
    // the islands of this slice over those of the one before, pixel by pixel in each row
    const pairs = [];
    if (prev) {
      const over = new Map();
      const K = area.length + 1;
      let p = 0;
      let c = 0;
      const pm = prev.cl.length / 3;
      while (p < pm && c < m) {
        const pj = prev.cl[3 * p];
        const cj = cl[3 * c];
        if (pj < cj) {
          p++;
          continue;
        }
        if (cj < pj) {
          c++;
          continue;
        }
        const pa = prev.cl[3 * p + 1];
        const pb = prev.cl[3 * p + 2];
        const ca = cl[3 * c + 1];
        const cb = cl[3 * c + 2];
        const d = Math.min(pb, cb) - Math.max(pa, ca);
        if (d > 0 && prev.of[p] >= 0 && of[c] >= 0) {
          const key = prev.of[p] * K + of[c];
          over.set(key, (over.get(key) ?? 0) + d);
        }
        if (pb < cb) p++;
        else c++;
      }
      for (const [key, d] of over) if (d * px > overlap) pairs.push(Math.floor(key / K), key % K);
    }
    links.push(Int32Array.from(pairs));
    prev = { cl, of };
  }
  return { n, areas, boxes, links };
}

/**
 * How far along the axis each sample's slice stands for: `down` from half way to the sample before (or the model's
 * start, for the first) and `up` to half way to the next (or the model's end).
 * @param {number[]} samples ascending
 * @param {number} lo the model's start on the axis
 * @param {number} hi its end
 */
export function sampleWidths(samples, lo, hi) {
  const n = samples.length;
  const down = new Float64Array(n);
  const up = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    down[i] = i > 0 ? (samples[i] - samples[i - 1]) / 2 : Math.max(0, samples[0] - lo);
    up[i] = i < n - 1 ? (samples[i + 1] - samples[i]) / 2 : Math.max(0, hi - samples[n - 1]);
  }
  return { down, up };
}

// The boxes of a column are named by the samples their cuts are at: −1 is the model's start and n its end, as
// `chooseOffsets` names them. The box from p to q holds the slices between, the one at p for its far half (`up`) and
// the one at q for its near half (`down`).

/** The islands of a graph numbered in one row, sample by sample: `offset[q]` the first of sample q. */
function islandIndex(graph) {
  const offset = new Int32Array(graph.n + 1);
  for (let q = 0; q < graph.n; q++) offset[q + 1] = offset[q] + graph.areas[q].length;
  return offset;
}

/**
 * What every box of a column leaves loose: `at(p, q)` (p < q, from −1 to n) the volume (mm³) of the box's components
 * other than the largest, each of `minVolume` or more, and `bits(p, q)` of those no more than `share` of the largest –
 * in one sweep from every p, joining each next slice's islands to those they meet.
 * @returns {{ n: number, at: (p: number, q: number) => number, bits: (p: number, q: number) => number,
 *   table: Float64Array }}
 */
export function looseTable(graph, { down, up }, { minVolume = HANG.loose, share = HANG.share } = {}) {
  const { n, areas, links } = graph;
  const N = n + 2;
  const table = new Float64Array(N * N);
  const small = new Float64Array(N * N);
  const offset = islandIndex(graph);
  const total = offset[n];
  const parent = new Int32Array(total);
  const vol = new Float64Array(total);
  const minus = new Float64Array(total);
  // the roots alive, with each one's place in the list, for taking one out at once
  const live = new Int32Array(total);
  const place = new Int32Array(total);
  const read = new Float64Array(total);
  let count = 0;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const drop = (r) => {
    const k = place[r];
    live[k] = live[--count];
    place[live[k]] = k;
  };
  for (let p = -1; p < n; p++) {
    count = 0;
    const first = Math.max(p, 0);
    for (let q = first; q <= n; q++) {
      if (q < n) {
        const w = q === p ? up[q] : down[q] + up[q];
        for (let a = 0; a < areas[q].length; a++) {
          const id = offset[q] + a;
          parent[id] = id;
          vol[id] = areas[q][a] * w;
          place[id] = count;
          live[count++] = id;
        }
        if (q > first) {
          const L = links[q];
          for (let t = 0; t < L.length; t += 2) {
            const x = find(offset[q - 1] + L[t]);
            const y = find(offset[q] + L[t + 1]);
            if (x === y) continue;
            parent[x] = y;
            vol[y] += vol[x];
            drop(x);
          }
        }
      }
      if (q === p) continue;
      // the reading: the slice at q only for its near half
      if (q < n) for (let a = 0; a < areas[q].length; a++) minus[find(offset[q] + a)] += areas[q][a] * up[q];
      let largest = 0;
      let sum = 0;
      for (let k = 0; k < count; k++) {
        const r = live[k];
        const v = vol[r] - minus[r];
        minus[r] = 0;
        read[k] = v;
        if (v > largest) {
          if (largest >= minVolume) sum += largest;
          largest = v;
        } else if (v >= minVolume) sum += v;
      }
      let bits = 0;
      for (let k = 0; k < count; k++) if (read[k] >= minVolume && read[k] <= share * largest) bits += read[k];
      table[(p + 1) * N + (q + 1)] = sum;
      small[(p + 1) * N + (q + 1)] = bits;
    }
  }
  return { n, table, at: (p, q) => (q > p ? table[(p + 1) * N + (q + 1)] : 0), bits: (p, q) => (q > p ? small[(p + 1) * N + (q + 1)] : 0) };
}

/**
 * The components of the box from p to q of a column (−1 and n the model's ends): each one's volume (mm³), its box
 * (samples s0..s1, pixels iu0..iu1 by jv0..jv1, the ends past) and its islands (by `islandIndex`), largest first.
 */
export function boxComponents(graph, { down, up }, p, q) {
  const { n, areas, boxes, links } = graph;
  const offset = islandIndex(graph);
  const first = Math.max(p, 0);
  const last = Math.min(q, n - 1);
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) {
      const next = parent.get(x);
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  for (let s = first; s <= last; s++) {
    for (let a = 0; a < areas[s].length; a++) parent.set(offset[s] + a, offset[s] + a);
    if (s > first) {
      const L = links[s];
      for (let t = 0; t < L.length; t += 2) {
        const x = find(offset[s - 1] + L[t]);
        const y = find(offset[s] + L[t + 1]);
        if (x !== y) parent.set(x, y);
      }
    }
  }
  const comps = new Map();
  for (let s = first; s <= last; s++) {
    const w = (s === p ? 0 : down[s]) + (s === q ? 0 : up[s]);
    for (let a = 0; a < areas[s].length; a++) {
      const id = offset[s] + a;
      const r = find(id);
      const b = boxes[s].subarray(4 * a, 4 * a + 4);
      let c = comps.get(r);
      if (!c) comps.set(r, (c = { volume: 0, s0: s, s1: s, iu0: b[0], iu1: b[1], jv0: b[2], jv1: b[3], islands: [] }));
      c.volume += areas[s][a] * w;
      c.s0 = Math.min(c.s0, s);
      c.s1 = Math.max(c.s1, s);
      c.iu0 = Math.min(c.iu0, b[0]);
      c.iu1 = Math.max(c.iu1, b[1]);
      c.jv0 = Math.min(c.jv0, b[2]);
      c.jv1 = Math.max(c.jv1, b[3]);
      c.islands.push(id);
    }
  }
  return [...comps.values()].sort((x, y) => y.volume - x.volume);
}

/** What of a box's components is loose: all but the largest, each of `minVolume` or more. */
const looseOf = (comps, minVolume) => comps.slice(1).filter((c) => c.volume >= minVolume);

/**
 * The parts of the box on one side of the cut at sample i that hang on only near its face: going away from the cut a
 * sample at a time, up to `reach` mm, what comes loose that was not loose before – each part of `held` mm³ or more,
 * held over `w` mm (the distance from the cut to the sample left out to). `end` is the box's other end (another
 * cut's sample, or −1 or n). Also what the box leaves loose as it is (`loose`, components of `minVolume` or more).
 * @param {object} graph `columnGraph`'s
 * @param {{ down: Float64Array, up: Float64Array }} widths `sampleWidths`
 * @param {number[]} samples
 * @param {number} i the cut's sample
 * @param {-1|1} side −1 the box below the cut, 1 the one above it
 * @param {number} end
 * @returns {{ loose: object[], parts: { w: number, volume: number, s0: number, s1: number, iu0: number, iu1: number,
 *   jv0: number, jv1: number, islands: number[] }[] }} each part's box (as `boxComponents`) and islands
 */
export function heldParts(graph, widths, samples, i, side, end, { reach = HANG.reach, held = HANG.held, minVolume = HANG.loose } = {}) {
  const box = (k) => (side > 0 ? boxComponents(graph, widths, k, end) : boxComponents(graph, widths, end, k));
  const base = box(i);
  const loose = looseOf(base, minVolume);
  const parts = [];
  let marks = new Set(loose.flatMap((c) => c.islands));
  let prev = loose.reduce((s, c) => s + c.volume, 0);
  for (let k = i + side; side > 0 ? k < end : k > end; k += side) {
    const w = Math.abs(samples[k] - samples[i]);
    if (w > reach + 1e-9) break;
    const now = looseOf(box(k), minVolume);
    const v = now.reduce((s, c) => s + c.volume, 0);
    if (v - prev >= held) {
      // what came loose here: the components none of whose islands were loose a step before
      const fresh = now.filter((c) => !c.islands.some((id) => marks.has(id)));
      if (fresh.length) {
        const got = fresh.reduce((s, c) => s + c.volume, 0);
        parts.push({
          w, volume: got,
          s0: Math.min(...fresh.map((c) => c.s0)), s1: Math.max(...fresh.map((c) => c.s1)),
          iu0: Math.min(...fresh.map((c) => c.iu0)), iu1: Math.max(...fresh.map((c) => c.iu1)),
          jv0: Math.min(...fresh.map((c) => c.jv0)), jv1: Math.max(...fresh.map((c) => c.jv1)),
          islands: fresh.flatMap((c) => c.islands),
        });
      }
      prev = v;
      marks = new Set(now.flatMap((c) => c.islands));
    } else if (v < prev) {
      prev = v;
      marks = new Set(now.flatMap((c) => c.islands));
    }
  }
  return { loose, parts };
}

/** A component's box in the world: the samples it spans along the axis, its pixels across. */
export function worldBox(c, samples, grid) {
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  min[grid.axis] = samples[c.s0];
  max[grid.axis] = samples[c.s1];
  min[grid.u] = grid.u0 + c.iu0 * grid.res;
  max[grid.u] = grid.u0 + c.iu1 * grid.res;
  min[grid.v] = grid.v0 + c.jv0 * grid.res;
  max[grid.v] = grid.v0 + c.jv1 * grid.res;
  return { min, max };
}

/**
 * The size (mm) of what a column's box from p to q holds, as its islands tell, or null when it holds nothing: along
 * the axis from the cut (or the first slice with material, as far as it stands for) to the other cut (or the last).
 */
export function boxExtent(graph, { down, up }, samples, p, q, grid) {
  const { n, boxes } = graph;
  let first = -1;
  let last = -1;
  let iu0 = Infinity;
  let iu1 = -Infinity;
  let jv0 = Infinity;
  let jv1 = -Infinity;
  for (let s = Math.max(p, 0); s <= Math.min(q, n - 1); s++) {
    const b = boxes[s];
    if (!b.length) continue;
    if (first < 0) first = s;
    last = s;
    for (let k = 0; k < b.length; k += 4) {
      iu0 = Math.min(iu0, b[k]);
      iu1 = Math.max(iu1, b[k + 1]);
      jv0 = Math.min(jv0, b[k + 2]);
      jv1 = Math.max(jv1, b[k + 3]);
    }
  }
  if (first < 0) return null;
  const from = first === p ? samples[p] : samples[first] - down[first];
  const to = last === q ? samples[q] : samples[last] + up[last];
  const size = [0, 0, 0];
  size[grid.axis] = to - from;
  size[grid.u] = (iu1 - iu0) * grid.res;
  size[grid.v] = (jv1 - jv0) * grid.res;
  return size;
}

/**
 * Where to move the cut at sample i, the next cuts at samples L and R (−1 and n the model's ends), so that what it
 * leaves holds on: the nearest sample where it leaves nothing loose and nothing held within `HANG.reach` mm (no cost
 * at all), or failing that one where it leaves no more loose than it does now and nothing held within `HANG.warn` mm;
 * with the boxes either side at least `least` mm long and each of what they hold passing `fits` (its size), and the
 * place itself passing `allowed` (where it is along the axis: not through a detail kept whole, say). And how
 * far `part` (one of `heldParts`', on `side` of the cut in column `column`) then holds: the least w that frees any of
 * its islands there – on that side, or on the other where the cut moved past it – or null when none of it comes loose.
 * @param {{ graphs: object[], tables: object[], widths: object, samples: number[], lo: number, hi: number,
 *   grid: object }} axis the axis's columns: `graphs` and `tables` one per column
 * @returns {{ at: number, holds: number|null }|null}
 */
export function moveCut(axis, i, L, R, { part, side, column }, { fits = () => true, least = HANG.warn, allowed = () => true } = {}) {
  const { graphs, tables, widths, samples, lo, hi, grid } = axis;
  const n = samples.length;
  const start = L >= 0 ? samples[L] : lo;
  const end = R < n ? samples[R] : hi;
  const now = hangAt(tables, samples, i, L, R);
  const candidates = [];
  for (let j = L + 1; j < Math.min(R, n); j++) {
    if (j === i || samples[j] - start < least || end - samples[j] < least || !allowed(samples[j])) continue;
    candidates.push(j);
  }
  candidates.sort((p, q) => Math.abs(samples[p] - samples[i]) - Math.abs(samples[q] - samples[i]) || p - q);
  const holdsOn = (j) => graphs.every((g) => [[L, j], [j, R]].every(([p, q]) => {
    const size = boxExtent(g, widths, samples, p, q, grid);
    return !size || fits(size);
  }));
  const pick = (ok) => candidates.find((j) => ok(hangAt(tables, samples, j, L, R)) && holdsOn(j));
  const j = pick((h) => h.cost <= 1e-9) ?? pick((h) => h.loose <= now.loose + 1e-6 && !h.parts.some((x) => x.w <= HANG.warn + 1e-9));
  if (j === undefined) return null;
  // the part on the side it was on, or – the cut moved past it – on the other
  const mine = new Set(part.islands);
  for (const s of [side, -side]) {
    const there = heldParts(graphs[column], widths, samples, j, s, s < 0 ? L : R, { reach: Infinity });
    const same = there.parts.find((x) => x.islands.some((id) => mine.has(id)));
    if (same) return { at: samples[j], holds: same.w };
  }
  return { at: samples[j], holds: null };
}

const unit = (v) => Math.min(1, Math.max(0, v) / HANG.whole);

/** What a part of `volume` mm³ that comes loose when the w mm next to a face are left out costs the planner. */
const heldCost = (volume, w) => unit(volume) * (HANG.costHeld * (1 - w / HANG.reach) + (w <= HANG.warn + 1e-9 ? HANG.costWarn : 0));

/**
 * What the box between the cuts at samples p and q (−1 and n the model's ends) costs the planner for what it leaves,
 * from each column's `looseTable` – each column a box of its own: what it leaves loose costs `HANG.costLoose` per
 * whole part of it (at most that; only its bits count, `HANG.share`: shells of a size are pieces the planner counts
 * already, `PLAN_WEIGHTS.parts` – a U's legs cut across), and each part of `HANG.held` or more that comes
 * loose as the slab next to one of its cut faces widens to w mm costs `HANG.costHeld` per whole part, less the further
 * from the face, nothing at `HANG.reach`, and `HANG.costWarn` more within `HANG.warn` (a part the slab takes away
 * itself lowers the reading, which then starts again from there). The model's ends are no faces. Summed over a plan's
 * boxes it is what `chooseOffsets` adds to its own costs (`hang`).
 * @param {{ at: function, bits: function }[]} tables one per column
 * @param {number[]} samples
 */
export function boxHang(tables, samples, p, q) {
  const n = samples.length;
  let cost = 0;
  for (const t of tables) {
    const base = t.at(p, q);
    cost += HANG.costLoose * unit(t.bits(p, q));
    // from the face at p up, and from the one at q down, never past the other
    for (const side of [1, -1]) {
      const face = side > 0 ? p : q;
      if (face < 0 || face >= n) continue;
      let prev = base;
      for (let k = face + side; side > 0 ? k < Math.min(q, n) : k > Math.max(p, -1); k += side) {
        const w = Math.abs(samples[k] - samples[face]);
        if (w > HANG.reach + 1e-9) break;
        const v = side > 0 ? t.at(k, q) : t.at(p, k);
        if (v - prev >= HANG.held) {
          cost += heldCost(v - prev, w);
          prev = v;
        } else if (v < prev) prev = v;
      }
    }
  }
  return cost;
}

/**
 * What a cut at sample i costs the planner for what it leaves (from each column's `looseTable`): the boxes either
 * side reaching to samples L and R (the next cuts, or −1 and n). A part left loose costs `HANG.costLoose` per whole
 * part of it (at most that), whatever its share of its box – a part a note is about must not come off at all, which is
 * what `moveCut` looks for; one that comes loose as the slab next to the face widens to w mm costs `HANG.costHeld` per
 * whole part, less the further from the face, nothing at `HANG.reach`, and `HANG.costWarn` more within `HANG.warn` –
 * when it is `HANG.held` or more: a part the slab takes away itself lowers the reading, which then starts again from
 * there. Each column is a box of its own.
 * @param {{ at: function }[]} tables one per column
 * @param {number[]} samples
 * @returns {{ cost: number, loose: number, parts: { side: number, w: number, volume: number, column: number }[] }}
 */
export function hangAt(tables, samples, i, L, R) {
  const n = samples.length;
  let cost = 0;
  let loose = 0;
  const parts = [];
  tables.forEach((t, column) => {
    const left = t.at(L, i);
    const right = t.at(i, R);
    loose += left + right;
    cost += HANG.costLoose * unit(left + right);
    for (const [side, base] of [[-1, left], [1, right]]) {
      let prev = base;
      for (let k = i + side; side > 0 ? k < Math.min(R, n) : k > Math.max(L, -1); k += side) {
        const w = Math.abs(samples[k] - samples[i]);
        if (w > HANG.reach + 1e-9) break;
        const v = side < 0 ? t.at(L, k) : t.at(k, R);
        if (v - prev >= HANG.held) {
          cost += heldCost(v - prev, w);
          parts.push({ side, w, volume: v - prev, column });
          prev = v;
        } else if (v < prev) prev = v;
      }
    }
  });
  return { cost, loose, parts };
}
