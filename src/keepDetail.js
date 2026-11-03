/**
 * Keep a detail whole: from a click on the model, the thin detail it lies on – a ribbon round a column, a handle, a
 * tail – and the box round it that no cut may run through (`split.keep`, `crosses` in Fit to my printer).
 *
 * The model is filled into a grid of 2 mm cubes. A ball of 6 mm radius rolled round inside it reaches the
 * body; what it cannot reach is thin (an opening: the cubes deeper than 6 mm, grown back by 6 mm, are the body). The
 * thin cubes within 3 mm of the body are its skin – low relief, such as stripes on a horn – and are left out, so a
 * detail that stands off the body is a piece of its own. The click picks the one it lies on; grown back over the skin
 * it stands on, its box (1 mm past the half cube its material may reach beyond its cubes) is what to keep. The sizes
 * are for a model 260 mm long: a longer or shorter one has them all in proportion.
 *
 * Pure: plain arrays in, plain numbers out. The distances are exact (`edt`, Felzenszwalb and Huttenlocher's
 * separable squared distance), in cubes.
 */

/**
 * The finder's sizes (mm): the grid's cube, the ball's radius, the skin left out and how far round a click it looks,
 * for a model `length` mm long; a longer or shorter one has them all in proportion (`finderScales`), so a model scaled
 * up or down finds the same detail. At most `cubes` cubes in the grid; `margin` how far a detail's box goes past the
 * half cube its material may reach beyond its cubes' sides.
 */
export const KEEP_FINDER = Object.freeze({ cell: 2, ball: 6, skin: 3, reach: 6, least: 32, length: 260, cubes: 16e6, margin: 1 });

/**
 * The scales the finder's sizes are tried at, in turn, for a model whose longest side is `length` mm: in proportion
 * to it against `KEEP_FINDER.length` (¼ to 3), then – where that finds only part of a detail – half an octave either
 * side of that.
 */
export function finderScales(length) {
  const s0 = Math.min(3, Math.max(0.25, length > 0 ? length / KEEP_FINDER.length : 1));
  return [s0, Math.min(3, s0 * Math.SQRT2), Math.max(0.25, s0 / Math.SQRT2)].filter((x, i, all) => all.indexOf(x) === i);
}

/** The finder's sizes at a scale (`finderScales`), the cube no smaller than a grid of `KEEP_FINDER.cubes` over `bounds` allows. */
export function finderSizes(scale, bounds = null) {
  const F = KEEP_FINDER;
  let cell = F.cell * scale;
  if (bounds) {
    const room = bounds.max.reduce((v, x, a) => v * (x - bounds.min[a] + 4 * cell), 1);
    cell = Math.max(cell, Math.cbrt(room / F.cubes));
  }
  return { cell, ball: F.ball * scale, skin: F.skin * scale, reach: F.reach * scale, least: F.least * scale ** 3 };
}

/** What each cube of the grid is, as bits. */
const SOLID = 1;
const BODY = 2; // deeper than the ball's radius: the ball's centre may go there
const OPENED = 4; // what the ball reaches
const FAR = 8; // thin, and off the body's skin
const SEEN = 16; // a search's own mark, cleared before it returns

/** Far enough to stand for no feature at all, in squared cubes (exact in a Float32). */
const FAR_AWAY = 1e7;

/**
 * The model filled into a grid of cubes `cell` mm a side: a cube is solid when its centre is inside, by the winding
 * of the triangles a line along Z through it crosses. Two cubes of air are kept round the model's box.
 * @param {ArrayLike<number>} positions x, y, z per vertex (`numProp` numbers each)
 * @param {ArrayLike<number>} triangles three vertex indices each
 * @param {{ cell?: number, numProp?: number }} options
 * @returns {{ origin: number[], cell: number, dims: number[], flags: Uint8Array }} the cube (i, j, k) is
 *   `flags[(k * dims[1] + j) * dims[0] + i]`, its centre at origin + (index + 0.5) · cell
 */
export function voxelise(positions, triangles, { cell = KEEP_FINDER.cell, numProp = 3 } = {}) {
  const nv = Math.floor(positions.length / numProp);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < nv; v++) {
    for (let a = 0; a < 3; a++) {
      const x = positions[v * numProp + a];
      if (x < min[a]) min[a] = x;
      if (x > max[a]) max[a] = x;
    }
  }
  if (!(nv > 0)) return { origin: [0, 0, 0], cell, dims: [0, 0, 0], flags: new Uint8Array(0) };
  const pad = 2;
  const origin = min.map((m) => m - pad * cell);
  const dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil((max[a] - min[a]) / cell) + 2 * pad));
  const [nx, ny, nz] = dims;
  const flags = new Uint8Array(nx * ny * nz);
  // the lines run a hair off the cubes' centres, so that they never pass exactly through an edge or a corner
  const jx = cell * 1.234567e-4;
  const jy = cell * 2.345678e-4;
  // each line's crossings: where along Z, and which way the triangle faces (+1 entering, −1 leaving)
  let at = new Float64Array(1 << 16);
  let line = new Int32Array(1 << 16);
  let way = new Int8Array(1 << 16);
  let n = 0;
  const push = (l, z, w) => {
    if (n === at.length) {
      const grow = (Old, old) => {
        const next = new Old(old.length * 2);
        next.set(old);
        return next;
      };
      at = grow(Float64Array, at);
      line = grow(Int32Array, line);
      way = grow(Int8Array, way);
    }
    at[n] = z;
    line[n] = l;
    way[n] = w;
    n++;
  };
  const nt = Math.floor(triangles.length / 3);
  const [ox, oy] = origin;
  for (let t = 0; t < nt; t++) {
    const a = triangles[3 * t] * numProp;
    const b = triangles[3 * t + 1] * numProp;
    const c = triangles[3 * t + 2] * numProp;
    const x0 = positions[a], y0 = positions[a + 1], z0 = positions[a + 2];
    const x1 = positions[b], y1 = positions[b + 1], z1 = positions[b + 2];
    const x2 = positions[c], y2 = positions[c + 1], z2 = positions[c + 2];
    const d = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (d === 0) continue; // edge on, seen along Z
    const i0 = Math.max(0, Math.ceil((Math.min(x0, x1, x2) - ox - jx) / cell - 0.5));
    const i1 = Math.min(nx - 1, Math.floor((Math.max(x0, x1, x2) - ox - jx) / cell - 0.5));
    if (i0 > i1) continue;
    const j0 = Math.max(0, Math.ceil((Math.min(y0, y1, y2) - oy - jy) / cell - 0.5));
    const j1 = Math.min(ny - 1, Math.floor((Math.max(y0, y1, y2) - oy - jy) / cell - 0.5));
    if (j0 > j1) continue;
    const w = d > 0 ? -1 : 1; // facing up: a line going up leaves the solid there
    for (let j = j0; j <= j1; j++) {
      const cy = oy + (j + 0.5) * cell + jy;
      for (let i = i0; i <= i1; i++) {
        const cx = ox + (i + 0.5) * cell + jx;
        const w0 = (x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy);
        const w1 = (x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy);
        const w2 = d - w0 - w1;
        if (d > 0 ? w0 < 0 || w1 < 0 || w2 < 0 : w0 > 0 || w1 > 0 || w2 > 0) continue;
        push(j * nx + i, (w0 * z0 + w1 * z1 + w2 * z2) / d, w);
      }
    }
  }
  // the crossings line by line (a counting sort), then up each line: inside where the winding is above 0
  const lines = nx * ny;
  const start = new Int32Array(lines + 1);
  for (let q = 0; q < n; q++) start[line[q] + 1]++;
  for (let l = 0; l < lines; l++) start[l + 1] += start[l];
  const fill = start.slice(0, lines);
  const order = new Int32Array(n);
  for (let q = 0; q < n; q++) order[fill[line[q]]++] = q;
  const oz = origin[2];
  const slab = nx * ny;
  const zs = [];
  for (let l = 0; l < lines; l++) {
    if (start[l + 1] - start[l] < 2) continue;
    zs.length = 0;
    for (let q = start[l]; q < start[l + 1]; q++) zs.push(order[q]);
    zs.sort((p, q) => at[p] - at[q]);
    // inside from where the winding rises above 0 to where it drops back: the cubes whose centres lie between
    let winding = 0;
    let from = 0;
    for (const q of zs) {
      const next = winding + way[q];
      if (winding <= 0 && next > 0) from = at[q];
      else if (winding > 0 && next <= 0) {
        const k0 = Math.max(0, Math.ceil((from - oz) / cell - 0.5));
        const k1 = Math.min(nz - 1, Math.ceil((at[q] - oz) / cell - 0.5) - 1);
        for (let k = k0; k <= k1; k++) flags[k * slab + l] = SOLID;
      }
      winding = next;
    }
  }
  return { origin, cell, dims, flags };
}

/**
 * The squared distance (in cubes) from every cube to the nearest one where `feature(flags[i])` holds, in place in
 * `out` (FAR_AWAY and more where there is none): three passes of the exact one-dimensional transform.
 */
export function edt(flags, dims, feature, out = new Float32Array(flags.length)) {
  const [nx, ny, nz] = dims;
  for (let i = 0; i < flags.length; i++) out[i] = feature(flags[i]) ? 0 : FAR_AWAY;
  const longest = Math.max(nx, ny, nz);
  const f = new Float64Array(longest);
  const d = new Float64Array(longest);
  const v = new Int32Array(longest);
  const z = new Float64Array(longest + 1);
  // one line of `len` cubes from `base`, `step` apart: skipped when it is all features or none
  const pass = (base, step, len) => {
    let any = false;
    let all = true;
    for (let q = 0, p = base; q < len; q++, p += step) {
      const x = out[p];
      f[q] = x;
      if (x < FAR_AWAY) any = true;
      if (x !== 0) all = false;
    }
    if (!any || all) return;
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      const fq = f[q] + q * q;
      let s = (fq - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
      while (s <= z[k]) {
        k--;
        s = (fq - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      d[q] = dq * dq + f[v[k]];
    }
    for (let q = 0, p = base; q < len; q++, p += step) out[p] = d[q];
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) pass((k * ny + j) * nx, 1, nx);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) pass(k * ny * nx + i, nx, ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pass(j * nx + i, nx * ny, nz);
  return out;
}

/**
 * Mark the grid's thin cubes off the body (`FAR`), in place: the body is what a ball of radius `ball` rolled inside
 * reaches, and its skin – the thin cubes within `skin` of it – is left out.
 * @param {{ cell: number, dims: number[], flags: Uint8Array }} grid from `voxelise`
 */
export function markThin(grid, { ball = KEEP_FINDER.ball, skin = KEEP_FINDER.skin } = {}) {
  const { cell, dims, flags } = grid;
  const r2 = (ball / cell) ** 2;
  const s2 = (skin / cell) ** 2;
  const work = edt(flags, dims, (x) => !(x & SOLID));
  for (let i = 0; i < flags.length; i++) if (work[i] > r2 + 1e-9) flags[i] |= BODY;
  edt(flags, dims, (x) => x & BODY, work);
  for (let i = 0; i < flags.length; i++) if (flags[i] & SOLID && work[i] <= r2 + 1e-9) flags[i] |= OPENED;
  edt(flags, dims, (x) => x & OPENED, work);
  for (let i = 0; i < flags.length; i++) if (flags[i] & SOLID && !(flags[i] & OPENED) && work[i] > s2 + 1e-9) flags[i] |= FAR;
  return grid;
}

/**
 * The detail a click picks, on a grid marked by `markThin`: the far-thin piece (its cubes joined face, edge or
 * corner) the most of whose cubes lie nearest the click, within `reach` mm; grown back over the thin skin it stands on
 * by `skin` + 1 mm. Null when the click is on the body: no detail lies there.
 * @param {{ origin: number[], cell: number, dims: number[], flags: Uint8Array }} grid
 * @param {number[]} point the click, on the model's surface
 * @returns {{ box: { min: number[], max: number[] }, volume: number, cubes: number, partial: boolean, mask: { origin: number[], cell:
 *   number, dims: number[], data: Uint8Array } }|null} `partial` where another far-thin piece lies within the skin of it
 *   (the rest of it, cut off where it lies close to the body); `box` half a cube and `KEEP_FINDER.margin` past its cubes' sides; `volume` mm³; `mask`
 *   its cubes and those touching them over the box's cubes and one more each side, 255 where it is (for tinting it)
 */
export function detailAt(grid, point, { reach = KEEP_FINDER.reach, skin = KEEP_FINDER.skin, least = KEEP_FINDER.least } = {}) {
  const { origin, cell, dims, flags } = grid;
  const [nx, ny, nz] = dims;
  if (!flags.length || !point?.every?.(Number.isFinite)) return null;
  const at = point.map((p, a) => Math.floor((p - origin[a]) / cell));
  const index = (i, j, k) => (k * ny + j) * nx + i;
  const touched = [];
  const pieces = [];
  // a far-thin piece from one of its cubes, every cube of it marked as seen
  const flood = (start) => {
    const cubes = [start];
    flags[start] |= SEEN;
    touched.push(start);
    for (let h = 0; h < cubes.length; h++) {
      const c = cubes[h];
      const i = c % nx;
      const j = Math.floor(c / nx) % ny;
      const k = Math.floor(c / (nx * ny));
      for (let dk = -1; dk <= 1; dk++) {
        const kk = k + dk;
        if (kk < 0 || kk >= nz) continue;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= ny) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= nx) continue;
            const q = index(ii, jj, kk);
            if ((flags[q] & (FAR | SEEN)) !== FAR) continue;
            flags[q] |= SEEN;
            touched.push(q);
            cubes.push(q);
          }
        }
      }
    }
    return cubes;
  };
  let picked = null;
  try {
    const most = Math.ceil(reach / cell);
    for (let rad = 0; rad <= most && !picked; rad++) {
      // the cubes on this ring round the click: the first ring with far-thin cubes decides, by the piece most of them are of
      const counts = new Map();
      for (let k = at[2] - rad; k <= at[2] + rad; k++) {
        if (k < 0 || k >= nz) continue;
        for (let j = at[1] - rad; j <= at[1] + rad; j++) {
          if (j < 0 || j >= ny) continue;
          for (let i = at[0] - rad; i <= at[0] + rad; i++) {
            if (i < 0 || i >= nx) continue;
            if (Math.max(Math.abs(i - at[0]), Math.abs(j - at[1]), Math.abs(k - at[2])) !== rad) continue;
            const q = index(i, j, k);
            if (!(flags[q] & FAR)) continue;
            let p = pieces.findIndex((x) => x.has(q));
            if (p < 0) {
              pieces.push(new Set(flood(q)));
              p = pieces.length - 1;
            }
            counts.set(p, (counts.get(p) ?? 0) + 1);
          }
        }
      }
      let best = -1;
      for (const [p, c] of counts) if (best < 0 || c > counts.get(best)) best = p;
      if (best >= 0) picked = pieces[best];
    }
  } finally {
    for (const q of touched) flags[q] &= ~SEEN;
  }
  if (!picked || picked.size * cell ** 3 < least) return null;
  // grown back over the thin cubes within skin + 1 mm (in whole cubes) of it: the skin it stands on is its own
  const grow = Math.max(1, Math.ceil((skin + 1) / cell - 1e-9));
  const grown = new Set(picked);
  // another far-thin piece that close is the rest of it, cut off by the skin step: only part of it is found
  let partial = false;
  for (const c of picked) {
    const i = c % nx;
    const j = Math.floor(c / nx) % ny;
    const k = Math.floor(c / (nx * ny));
    for (let kk = Math.max(0, k - grow); kk <= Math.min(nz - 1, k + grow); kk++) {
      for (let jj = Math.max(0, j - grow); jj <= Math.min(ny - 1, j + grow); jj++) {
        for (let ii = Math.max(0, i - grow); ii <= Math.min(nx - 1, i + grow); ii++) {
          const q = index(ii, jj, kk);
          if (flags[q] & SOLID && !(flags[q] & OPENED)) grown.add(q);
          if (flags[q] & FAR && !picked.has(q)) partial = true;
        }
      }
    }
  }
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const c of grown) {
    const ijk = [c % nx, Math.floor(c / nx) % ny, Math.floor(c / (nx * ny))];
    for (let a = 0; a < 3; a++) {
      if (ijk[a] < lo[a]) lo[a] = ijk[a];
      if (ijk[a] > hi[a]) hi[a] = ijk[a];
    }
  }
  // the mask: one cube more each side, and each cube of it with those touching it, so the model's surface over it
  // (which may lie in a cube of air beside it) is tinted too
  const m0 = lo.map((v) => v - 1);
  const md = [0, 1, 2].map((a) => hi[a] - lo[a] + 3);
  const data = new Uint8Array(md[0] * md[1] * md[2]);
  for (const c of grown) {
    const ijk = [c % nx, Math.floor(c / nx) % ny, Math.floor(c / (nx * ny))].map((v, a) => v - m0[a]);
    for (let dk = -1; dk <= 1; dk++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) data[((ijk[2] + dk) * md[1] + ijk[1] + dj) * md[0] + ijk[0] + di] = 255;
      }
    }
  }
  // its box: its cubes stand for their middles, so its material may reach half a cube past them, and the box goes
  // `margin` past that
  const past = cell / 2 + KEEP_FINDER.margin;
  return {
    box: { min: lo.map((v, a) => origin[a] + v * cell - past), max: hi.map((v, a) => origin[a] + (v + 1) * cell + past) },
    volume: grown.size * cell ** 3,
    cubes: grown.size,
    partial,
    mask: { origin: m0.map((v, a) => origin[a] + v * cell), cell, dims: md, data },
  };
}
