/**
 * Per-corner display normals for an indexed triangle mesh, without Manifold
 * or three.js. Reproduces the shading rule of Manifold's
 * `calculateNormals(0, minSharpAngle)` (verified corner by corner against
 * Manifold 3.5.4 in tests/normals.test.js) so the viewer can shade any mesh –
 * the display geometry straight from the worker, an STL that never went
 * through Manifold – the way Manifold would:
 *
 *  - An edge is *sharp* when the angle between the unit normals of its two
 *    faces exceeds `creaseDeg` (strictly). Open edges (no neighbour) and
 *    non-manifold edges (more than two faces) are sharp as well.
 *  - Around each vertex the fan of incident faces is cut into groups at the
 *    sharp edges. Each group gets one normal: the normalised sum of its faces'
 *    unit normals, each weighted by the angle of that face's corner at this
 *    vertex (the angle-weighted pseudo-normal). Every face of the group uses
 *    that normal at this corner, so a vertex with fewer than two sharp edges
 *    keeps a single normal, a cube corner gets three and a cylinder rim two.
 *    Manifold does not special-case coplanar faces here: a 20° chamfer is
 *    smoothed into a many-triangle flat face like any other shallow edge.
 *  - Degenerate faces (zero area) contribute nothing to a group and are never
 *    sharp against their neighbours (the fan walk sees through them); a group
 *    whose sum vanishes falls back to the face normal, and to +Z for a
 *    degenerate face on its own.
 *
 * Everything is typed arrays and linear in the number of corners (a million
 * triangles shade in a fraction of a second). The connectivity only depends on
 * `index`; build it once with `normalsTopology()` and pass it to every reshade
 * of a deforming mesh.
 */

const DEG = Math.PI / 180;

/** Corner after `c` in its triangle (corner ids are 3 * tri + k). */
const next = (c) => (c % 3 === 2 ? c - 2 : c + 1);
/** Corner before `c` in its triangle. */
const prev = (c) => (c % 3 === 0 ? c + 2 : c - 1);
/** Triangle of corner `c`. */
const tri = (c) => (c - (c % 3)) / 3;

/**
 * Connectivity of an indexed triangle mesh, reusable for every `cornerNormals`
 * call with the same `index`.
 *
 * Corner `c = 3 * tri + k` doubles as the half-edge `index[c] → index[next(c)]`.
 *
 * @param {Uint32Array|Uint16Array|number[]} index 3 vertex ids per triangle
 * @param {number} [vertexCount] number of vertices (default: largest id + 1)
 * @returns {{
 *   vertexCount: number,
 *   cornerCount: number,
 *   offsets: Uint32Array,  // CSR: the corners of vertex v are corners[offsets[v] .. offsets[v + 1])
 *   corners: Uint32Array,  // ... sorted by the half-edge's end vertex
 *   twin: Int32Array,      // opposite half-edge of each corner; -1 on open and non-manifold edges
 *   maxDegree: number,     // most corners at one vertex
 * }}
 */
export function normalsTopology(index, vertexCount) {
  const C = index.length;
  if (C % 3 !== 0) throw new Error('normalsTopology: index length must be a multiple of 3');
  let V = vertexCount;
  if (V === undefined) {
    V = 0;
    for (let c = 0; c < C; c++) if (index[c] >= V) V = index[c] + 1;
  }

  // Counting-sort the half-edges by end vertex, then stably by start vertex:
  // a CSR list of every vertex's outgoing half-edges in which each slice is
  // sorted by end vertex, so a twin is found by binary search.
  const byEnd = new Uint32Array(C);
  {
    const count = new Uint32Array(V + 1);
    for (let c = 0; c < C; c++) count[index[next(c)] + 1]++;
    for (let v = 0; v < V; v++) count[v + 1] += count[v];
    for (let c = 0; c < C; c++) byEnd[count[index[next(c)]]++] = c;
  }
  const offsets = new Uint32Array(V + 1);
  for (let c = 0; c < C; c++) offsets[index[c] + 1]++;
  let maxDegree = 0;
  for (let v = 0; v < V; v++) {
    if (offsets[v + 1] > maxDegree) maxDegree = offsets[v + 1];
    offsets[v + 1] += offsets[v];
  }
  const corners = new Uint32Array(C);
  {
    const cursor = offsets.slice(0, V);
    for (let i = 0; i < C; i++) {
      const c = byEnd[i];
      corners[cursor[index[c]]++] = c;
    }
  }

  // A triangle that repeats a vertex id has no area and no real edges; keep its
  // half-edges out of the pairing so they cannot spoil a genuine edge.
  const collapsed = (c) => {
    const t = 3 * tri(c);
    return index[t] === index[t + 1] || index[t + 1] === index[t + 2] || index[t] === index[t + 2];
  };

  // Twins: half-edge c runs a → b, its twin runs b → a and lives in b's slice.
  // An edge with several half-edges in one direction is non-manifold and gets
  // no twin on either side.
  const twin = new Int32Array(C).fill(-1);
  for (let c = 0; c < C; c++) {
    if (collapsed(c)) continue;
    const a = index[c];
    const b = index[next(c)];
    let lo = offsets[b];
    const end = offsets[b + 1];
    let hi = end;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (index[next(corners[mid])] < a) lo = mid + 1;
      else hi = mid;
    }
    let found = -1;
    for (let i = lo; i < end && index[next(corners[i])] === a; i++) {
      if (collapsed(corners[i])) continue;
      if (found >= 0) {
        found = -1; // b → a twice or more
        break;
      }
      found = corners[i];
    }
    twin[c] = found;
  }
  for (let c = 0; c < C; c++) {
    const t = twin[c];
    if (t >= 0 && twin[t] !== c) twin[c] = -1; // c itself is duplicated: unpair this side too
  }

  return { vertexCount: V, cornerCount: C, offsets, corners, twin, maxDegree };
}

/**
 * Unit face normals (zero for degenerate faces) and the angle at every corner,
 * computed the way Manifold does (unit edge vectors, third angle by
 * difference) so the two agree to float precision.
 */
function faceData(positions, index) {
  const C = index.length;
  const T = C / 3;
  const normal = new Float64Array(T * 3); // double, so the crease test is as exact as the positions allow
  const angle = new Float32Array(C);
  for (let t = 0; t < T; t++) {
    const a = index[3 * t] * 3;
    const b = index[3 * t + 1] * 3;
    const c = index[3 * t + 2] * 3;
    // Edges e0 = B - A, e1 = C - B, e2 = A - C.
    const e0x = positions[b] - positions[a], e0y = positions[b + 1] - positions[a + 1], e0z = positions[b + 2] - positions[a + 2];
    const e1x = positions[c] - positions[b], e1y = positions[c + 1] - positions[b + 1], e1z = positions[c + 2] - positions[b + 2];
    const e2x = positions[a] - positions[c], e2y = positions[a + 1] - positions[c + 1], e2z = positions[a + 2] - positions[c + 2];
    const l0 = Math.hypot(e0x, e0y, e0z);
    const l1 = Math.hypot(e1x, e1y, e1z);
    const l2 = Math.hypot(e2x, e2y, e2z);
    const nx = e0y * e1z - e0z * e1y;
    const ny = e0z * e1x - e0x * e1z;
    const nz = e0x * e1y - e0y * e1x;
    const len = Math.hypot(nx, ny, nz);
    // |e0 × e1| = l0 l1 sin θ: a face thinner than 1e-10 rad has no usable
    // direction (its cross product is rounding noise) and counts as degenerate.
    if (!(len > 1e-10 * l0 * l1)) continue; // normal and angles stay 0
    normal[3 * t] = nx / len;
    normal[3 * t + 1] = ny / len;
    normal[3 * t + 2] = nz / len;
    const d0 = -(e2x * e0x + e2y * e0y + e2z * e0z) / (l2 * l0);
    const d1 = -(e0x * e1x + e0y * e1y + e0z * e1z) / (l0 * l1);
    const phi0 = d0 >= 1 ? 0 : d0 <= -1 ? Math.PI : Math.acos(d0);
    const phi1 = d1 >= 1 ? 0 : d1 <= -1 ? Math.PI : Math.acos(d1);
    angle[3 * t] = phi0;
    angle[3 * t + 1] = phi1;
    angle[3 * t + 2] = Math.max(0, Math.PI - phi0 - phi1);
  }
  return { normal, angle };
}

/**
 * Per-corner normals with smooth groups split at sharp edges, like Manifold's
 * `calculateNormals(0, creaseDeg)`.
 *
 * @param {Float32Array} positions  xyz per vertex
 * @param {Uint32Array} index       3 vertex ids per triangle
 * @param {number} [creaseDeg=36]   edges whose dihedral angle exceeds this are sharp
 * @param {object} [topology]       reusable connectivity from `normalsTopology(index, vertexCount)`
 * @returns {Float32Array}          3 * index.length numbers: the unit normal of
 *   each corner, in triangle order (corner c = 3 * tri + k at out[3c .. 3c + 2])
 */
export function cornerNormals(positions, index, creaseDeg = 36, topology = null) {
  const C = index.length;
  const V = positions.length / 3;
  let topo = topology;
  if (topo) {
    if (topo.cornerCount !== C || topo.vertexCount !== V) throw new Error('cornerNormals: topology does not match this mesh');
  } else {
    topo = normalsTopology(index, V);
  }
  const { offsets, corners, twin } = topo;
  const { normal: N, angle: A } = faceData(positions, index);

  const cosCrease = Math.cos(Math.min(180, Math.max(0, creaseDeg)) * DEG);
  const out = new Float32Array(C * 3);
  const visited = new Uint8Array(C);
  const fan = new Uint32Array(topo.maxDegree + 1); // corners of the fan being walked
  const cut = new Uint8Array(topo.maxDegree + 1); // cut[i]: the edge entering fan[i] is sharp

  const isZero = (t) => N[3 * t] === 0 && N[3 * t + 1] === 0 && N[3 * t + 2] === 0;

  /** Is the edge between faces t1 and t2 sharp? Degenerate faces never are. */
  const isSharp = (t1, t2) => {
    const d = N[3 * t1] * N[3 * t2] + N[3 * t1 + 1] * N[3 * t2 + 1] + N[3 * t1 + 2] * N[3 * t2 + 2];
    return d < cosCrease && !isZero(t1) && !isZero(t2);
  };

  /** Give fan positions [from, to) (indices into `fan`, modulo n) their group normal. */
  const flush = (from, to, n) => {
    let sx = 0, sy = 0, sz = 0;
    for (let j = from; j < to; j++) {
      const c = fan[j % n];
      const t = tri(c);
      const w = A[c];
      sx += w * N[3 * t];
      sy += w * N[3 * t + 1];
      sz += w * N[3 * t + 2];
    }
    const len = Math.hypot(sx, sy, sz);
    if (len > 0) {
      sx /= len;
      sy /= len;
      sz /= len;
      for (let j = from; j < to; j++) {
        const c = fan[j % n];
        out[3 * c] = sx;
        out[3 * c + 1] = sy;
        out[3 * c + 2] = sz;
      }
    } else {
      for (let j = from; j < to; j++) {
        const c = fan[j % n];
        const t = tri(c);
        if (isZero(t)) {
          out[3 * c + 2] = 1;
        } else {
          out[3 * c] = N[3 * t];
          out[3 * c + 1] = N[3 * t + 1];
          out[3 * c + 2] = N[3 * t + 2];
        }
      }
    }
  };

  /**
   * Walk the fan of corners around a vertex from `start`, stepping from a
   * corner to the corner of the face across its outgoing half-edge until the
   * fan closes or hits an open edge, then cut it into groups at sharp edges.
   */
  const walk = (start, degree) => {
    let n = 0;
    let cur = start;
    let closed = false;
    for (;;) {
      visited[cur] = 1;
      fan[n] = cur;
      if (n > 0) cut[n] = isSharp(tri(fan[n - 1]), tri(cur)) ? 1 : 0;
      n++;
      const tw = twin[cur];
      if (tw < 0 || n > degree) break; // open edge (or a damaged fan)
      const nxt = next(tw);
      if (visited[nxt]) {
        closed = nxt === start;
        break;
      }
      cur = nxt;
    }
    cut[0] = closed ? (isSharp(tri(fan[n - 1]), tri(start)) ? 1 : 0) : 1; // an open edge is sharp
    // Start at the first cut so every group is contiguous in the walk; one
    // group when there is none (or a single sharp edge, which cuts nothing).
    let s = 0;
    while (s < n && !cut[s]) s++;
    if (s === n) s = 0;
    let from = s;
    for (let j = s + 1; j < s + n; j++) {
      if (cut[j % n]) {
        flush(from, j, n);
        from = j;
      }
    }
    flush(from, s + n, n);
  };

  for (let v = 0; v < V; v++) {
    const begin = offsets[v];
    const end = offsets[v + 1];
    if (begin === end) continue;
    const degree = end - begin;
    // Open fans first, from their boundary corner, so each is walked once ...
    for (let i = begin; i < end; i++) {
      const c = corners[i];
      if (!visited[c] && twin[prev(c)] < 0) walk(c, degree);
    }
    // ... then whatever is left: closed fans (one per manifold vertex).
    for (let i = begin; i < end; i++) {
      const c = corners[i];
      if (!visited[c]) walk(c, degree);
    }
  }
  return out;
}
