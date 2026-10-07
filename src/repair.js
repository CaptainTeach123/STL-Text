import { manifold } from './manifold.js';

/**
 * @typedef {object} RepairReport
 * @property {boolean} watertight        true when `manifold` is non-null
 * @property {boolean} repaired          true when any repair step changed the mesh
 * @property {number} inputTriangles
 * @property {number} outputTriangles    triangles in the returned manifold (0 when null)
 * @property {number} degenerateRemoved  NaN / zero-area / duplicate triangles removed
 * @property {number} weldTolerance      tolerance that finally produced a manifold (0 = exact)
 * @property {number} holesFilled        boundary loops filled
 * @property {number} trianglesFlipped   triangles re-wound for consistent orientation
 * @property {number} shellsInverted     whole shells turned right-side-out
 * @property {number} shells             closed shells found
 * @property {number} shellsDropped      shells that could not be repaired (not in the result)
 * @property {string[]} notes            human-readable lines for the UI, e.g. "Filled 3 holes"
 */

/** Weld tolerances tried after the exact attempt, as fractions of the bbox diagonal. */
const WELD_LADDER = [1e-7, 1e-6, 1e-5, 1e-4];
const NO_PROGRESS = () => {};

/**
 * Turn an STL triangle soup into a Manifold solid, repairing common defects:
 * degenerate / duplicate triangles, tiny gaps, inconsistent winding,
 * inside-out shells, holes, T-junctions, non-manifold edges and overlapping
 * shells. Shells that cannot be repaired are dropped and reported.
 * @param {Float32Array} soup  9 floats per triangle, as produced by triangleSoup()
 * @param {object} [options]
 * @param {number} [options.maxWeldFraction=1e-3]  largest weld tolerance tried, as a fraction of the bbox diagonal
 * @param {number} [options.maxHoleEdges=2000]      boundary loops longer than this are not filled
 * @param {(stage: string) => void} [options.onProgress]
 * @returns {{ manifold: import('manifold-3d').Manifold|null, report: RepairReport }}
 *   The caller owns the manifold and must `.delete()` it.
 */
export function repairToManifold(soup, options = {}) {
  const { maxWeldFraction = 1e-3, maxWeldAbsolute = 0.05, maxHoleEdges = 2000, onProgress = NO_PROGRESS } = options;
  const report = {
    watertight: false,
    repaired: false,
    inputTriangles: Math.floor(soup.length / 9),
    outputTriangles: 0,
    degenerateRemoved: 0,
    weldTolerance: 0,
    holesFilled: 0,
    trianglesFlipped: 0,
    shellsInverted: 0,
    shells: 0,
    shellsDropped: 0,
    passthroughTriangles: 0,
    notes: [],
  };
  const passthroughs = []; // soups of triangles that could not join a closed shell
  const finish = (solid) => {
    const passthrough = concatSoups(passthroughs);
    report.passthroughTriangles = passthrough.length / 9;
    if (report.shellsDropped) {
      const faces = report.passthroughTriangles.toLocaleString('en-US');
      report.notes.push(
        report.shellsDropped === 1
          ? `One piece (${faces} faces) couldn't be repaired — it is kept as-is in your download`
          : `${report.shellsDropped} pieces (${faces} faces) couldn't be repaired — they are kept as-is in your download`,
      );
    }
    report.watertight = solid !== null;
    report.outputTriangles = solid ? solid.numTri() : 0;
    report.repaired = report.notes.length > 0;
    return { manifold: solid, passthrough, report };
  };

  // 1. Drop NaN, zero-area and duplicate triangles; weld exactly coincident corners.
  onProgress('Removing degenerate triangles');
  const clean = cleanSoup(soup);
  let { vp, tri } = clean;
  report.degenerateRemoved = clean.removed;
  if (report.degenerateRemoved) report.notes.push(`Removed ${plural(report.degenerateRemoved, 'degenerate triangle')}`);
  if (!tri.length) {
    report.notes.push('No usable triangles');
    return finish(null);
  }
  const bbox = boundsOf(vp);
  const referenceVolume = Math.abs(signedVolume(vp, tri));
  const rejected = [];
  // A tolerant weld must not change the shape: refuse rungs that empty the
  // mesh, move its volume by more than 1 % or shrink its bounding box.
  const acceptable = (m, tolerance) => {
    if (m.isEmpty()) return false;
    const volume = Math.abs(m.volume());
    if (referenceVolume > 0 && Math.abs(volume - referenceVolume) > 0.01 * referenceVolume) return false;
    const { min, max } = m.boundingBox();
    for (let a = 0; a < 3; a++) {
      if (min[a] - bbox.min[a] > tolerance + 1e-9 || bbox.max[a] - max[a] > tolerance + 1e-9) return false;
    }
    return true;
  };

  // 2. Weld with Manifold's own merge(): exactly first, then with ever larger
  //    tolerances (only when open-edge vertices are close enough for that to matter).
  onProgress('Welding vertices');
  const V = vp.length / 3;
  let solid = null;
  let edges = null; // half-edge structure of `tri`, reused by the topology repair
  let weldedVertices = 0;
  let collapsed = 0;
  const attempt = (tolerance) => {
    const before = { tri, edges, weldedVertices, collapsed, weldTolerance: report.weldTolerance };
    const mesh = mergedMesh(vp, tri, tolerance);
    const merged = mesh.mergeFromVert?.length ?? 0;
    if (merged) { // carry the welds over to our own index buffer
      const dropped = dropDegenerate(applyMerge(tri, mesh.mergeFromVert, mesh.mergeToVert, V));
      const deduped = dedupeTriangles(dropped.tri);
      tri = deduped.tri;
      edges = null;
      weldedVertices += merged;
      collapsed += dropped.removed + deduped.removed;
      report.weldTolerance = tolerance;
    }
    if (merged || tolerance === 0) solid = tryOfMesh(mesh); // otherwise the outcome is unchanged
    if (solid && tolerance > 0 && !acceptable(solid, tolerance)) {
      solid.delete();
      solid = null;
      ({ tri, edges, weldedVertices, collapsed } = before);
      report.weldTolerance = before.weldTolerance;
      rejected.push(tolerance);
    }
  };
  attempt(0);
  if (!solid) {
    edges = buildEdges(tri, V);
    const ladder = weldLadder(clean.diag, maxWeldFraction, maxWeldAbsolute);
    if (ladder.length && hasCloseBoundaryVertices(vp, tri, edges, ladder[ladder.length - 1])) {
      for (const tolerance of ladder) {
        attempt(tolerance);
        if (solid) break;
      }
    }
  }
  if (weldedVertices) {
    report.notes.push(`Welded ${plural(weldedVertices, 'vertex', 'vertices')}${
      report.weldTolerance ? ` (gaps up to ${formatLength(report.weldTolerance)} mm)` : ''}`);
  }
  if (collapsed) {
    report.degenerateRemoved += collapsed;
    report.notes.push(`Removed ${plural(collapsed, 'triangle')} collapsed by welding`);
  }

  let parts;
  if (solid) {
    parts = solid.decompose();
    solid.delete();
  } else {
    // 3. Explicit topology repair on the index buffer.
    onProgress('Repairing topology');
    let fillStart;
    ({ vp, tri, fillStart } = repairTopology(vp, tri, edges, maxHoleEdges, report, onProgress));
    onProgress('Building solid');
    ({ parts } = buildShells(vp, tri, report.weldTolerance, report, passthroughs, fillStart));
  }

  onProgress('Combining shells');
  let result = assembleShells(parts, report, passthroughs);
  if (result && report.weldTolerance > 0) {
    // don't let a coarse weld tolerance propagate into every later boolean
    const tightened = result.setTolerance(Math.max(1e-6 * clean.diag, 1e-5));
    result.delete();
    result = tightened;
  }
  return finish(result);
}

/** Axis-aligned bounds of a vertex array. */
function boundsOf(vp) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vp.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = vp[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

/** Signed volume of an indexed triangle mesh (sum of origin tetrahedra). */
function signedVolume(vp, tri) {
  let six = 0;
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
    const ax = vp[a], ay = vp[a + 1], az = vp[a + 2];
    const bx = vp[b], by = vp[b + 1], bz = vp[b + 2];
    const cx = vp[c], cy = vp[c + 1], cz = vp[c + 2];
    six += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return six / 6;
}

/** Triangle soup (9 floats per triangle) of an indexed mesh. */
function soupOf(vp, tri) {
  const out = new Float32Array(tri.length * 3);
  for (let i = 0; i < tri.length; i++) {
    const v = tri[i] * 3;
    out[i * 3] = vp[v];
    out[i * 3 + 1] = vp[v + 1];
    out[i * 3 + 2] = vp[v + 2];
  }
  return out;
}

/** Triangle soup of a Manifold's surface. */
function soupOfManifold(m) {
  const mesh = m.getMesh();
  const stride = mesh.numProp;
  const tri = mesh.triVerts;
  const out = new Float32Array(tri.length * 3);
  for (let i = 0; i < tri.length; i++) {
    const v = tri[i] * stride;
    out[i * 3] = mesh.vertProperties[v];
    out[i * 3 + 1] = mesh.vertProperties[v + 1];
    out[i * 3 + 2] = mesh.vertProperties[v + 2];
  }
  return out;
}

/** Concatenate triangle soups (an empty Float32Array when there are none). */
function concatSoups(soups) {
  const parts = soups.filter((s) => s && s.length);
  if (!parts.length) return new Float32Array(0);
  if (parts.length === 1) return parts[0];
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Human sentence summarising a report, e.g. "Repaired: filled 3 holes, flipped
 * 12 triangles." Returns '' when nothing was done.
 * @param {RepairReport} report
 */
export function describeRepair(report) {
  if (!report || !report.notes.length) return '';
  const lines = report.notes.map((n) => n[0].toLowerCase() + n.slice(1));
  return `${report.watertight ? 'Repaired' : 'Could not repair'}: ${lines.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Step 1: cleaning + exact welding

/**
 * Remove non-finite, zero-area and duplicate triangles and weld exactly
 * coincident corners into an indexed mesh.
 * @returns {{ vp: Float32Array, tri: Uint32Array, diag: number, removed: number }}
 */
function cleanSoup(soup) {
  const T = Math.floor(soup.length / 9);
  const finite = new Uint8Array(T);
  let removed = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let t = 0; t < T; t++) {
    const o = t * 9;
    let ok = true;
    for (let k = 0; k < 9; k++) if (!Number.isFinite(soup[o + k])) { ok = false; break; }
    if (!ok) { removed++; continue; }
    finite[t] = 1;
    for (let k = 0; k < 9; k += 3) {
      const x = soup[o + k], y = soup[o + k + 1], z = soup[o + k + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  const diag = removed === T ? 1 : Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const minCross2 = (1e-6 * diag) ** 4; // |cross| below (1e-6 * diag)^2 counts as zero area

  // Exact weld: hash the float bit patterns of each corner.
  const bits = new Uint32Array(soup.buffer, soup.byteOffset, T * 9);
  const vbits = new Uint32Array(T * 9); // unique vertices (worst case: all corners unique)
  const cap = nextPow2(T * 6);
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  let V = 0;
  const weld = (i) => {
    let x = bits[i], y = bits[i + 1], z = bits[i + 2];
    if (x === 0x80000000) x = 0; // -0 → +0
    if (y === 0x80000000) y = 0;
    if (z === 0x80000000) z = 0;
    let h = hash3(x, y, z) & mask;
    for (;;) {
      const v = table[h];
      if (v < 0) {
        table[h] = V;
        vbits[V * 3] = x;
        vbits[V * 3 + 1] = y;
        vbits[V * 3 + 2] = z;
        return V++;
      }
      if (vbits[v * 3] === x && vbits[v * 3 + 1] === y && vbits[v * 3 + 2] === z) return v;
      h = (h + 1) & mask;
    }
  };

  const tri = new Uint32Array(T * 3);
  let n = 0;
  for (let t = 0; t < T; t++) {
    if (!finite[t]) continue;
    const o = t * 9;
    const ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
    const ux = soup[o + 3] - ax, uy = soup[o + 4] - ay, uz = soup[o + 5] - az;
    const vx = soup[o + 6] - ax, vy = soup[o + 7] - ay, vz = soup[o + 8] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < minCross2) { removed++; continue; }
    const a = weld(o), b = weld(o + 3), c = weld(o + 6);
    if (a === b || b === c || a === c) { removed++; continue; }
    tri[n++] = a;
    tri[n++] = b;
    tri[n++] = c;
  }
  const vp = new Float32Array(vbits.buffer, 0, V * 3).slice();
  const deduped = dedupeTriangles(tri.subarray(0, n));
  return { vp, tri: deduped.tri, diag, removed: removed + deduped.removed };
}

/** Remove triangles with the same three vertices (in any order). */
function dedupeTriangles(tri) {
  const T = tri.length / 3;
  const cap = nextPow2(T * 2);
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const out = new Uint32Array(tri.length);
  let n = 0;
  let removed = 0;
  for (let t = 0; t < T; t++) {
    let a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
    if (a > b) [a, b] = [b, a];
    if (b > c) [b, c] = [c, b];
    if (a > b) [a, b] = [b, a];
    let h = hash3(a, b, c) & mask;
    let dup = false;
    for (;;) {
      const s = table[h];
      if (s < 0) { table[h] = n / 3; break; }
      let p = out[s * 3], q = out[s * 3 + 1], r = out[s * 3 + 2];
      if (p > q) [p, q] = [q, p];
      if (q > r) [q, r] = [r, q];
      if (p > q) [p, q] = [q, p];
      if (p === a && q === b && r === c) { dup = true; break; }
      h = (h + 1) & mask;
    }
    if (dup) { removed++; continue; }
    out[n++] = tri[t * 3];
    out[n++] = tri[t * 3 + 1];
    out[n++] = tri[t * 3 + 2];
  }
  return { tri: out.subarray(0, n), removed };
}

/** Remove triangles that reference the same vertex twice. */
function dropDegenerate(tri) {
  const out = new Uint32Array(tri.length);
  let n = 0;
  let removed = 0;
  for (let i = 0; i < tri.length; i += 3) {
    const a = tri[i], b = tri[i + 1], c = tri[i + 2];
    if (a === b || b === c || a === c) { removed++; continue; }
    out[n++] = a;
    out[n++] = b;
    out[n++] = c;
  }
  return { tri: out.subarray(0, n), removed };
}

// ---------------------------------------------------------------------------
// Step 2: welding with Manifold

/** Positive weld tolerances to try, in increasing order. */
function weldLadder(diag, maxWeldFraction, maxAbsolute = Infinity) {
  if (!(maxWeldFraction > 0)) return [];
  const rungs = [...WELD_LADDER.filter((f) => f < maxWeldFraction), maxWeldFraction]
    .map((f) => Math.min(f * diag, maxAbsolute))
    .filter((t) => t > 0);
  return [...new Set(rungs)].sort((a, b) => a - b);
}

/**
 * Whether two vertices on open edges that are not already joined by an open
 * edge lie within `tol` of each other, i.e. whether welding at tolerances up
 * to `tol` could change anything. Uses a grid with spacing tol over the
 * (usually few) boundary vertices.
 */
function hasCloseBoundaryVertices(vp, tri, edges, tol) {
  const V = vp.length / 3;
  const mark = new Uint8Array(V);
  const verts = [];
  const joined = new Set(); // boundary edges, as packed vertex pairs
  const pairKey = (a, b) => (V < 67108864 ? Math.min(a, b) * V + Math.max(a, b) : `${Math.min(a, b)}_${Math.max(a, b)}`);
  for (let e = 0; e < edges.E; e++) {
    if (edgeCount(edges, e) !== 1) continue;
    const h = edges.edgeHalf[edges.edgeStart[e]];
    const a = tri[h], b = tri[nextHalf(h)];
    joined.add(pairKey(a, b));
    if (!mark[a]) { mark[a] = 1; verts.push(a); }
    if (!mark[b]) { mark[b] = 1; verts.push(b); }
  }
  if (verts.length < 2) return false;
  let minX = Infinity, minY = Infinity, minZ = Infinity, span = 0;
  for (const v of verts) {
    minX = Math.min(minX, vp[v * 3]);
    minY = Math.min(minY, vp[v * 3 + 1]);
    minZ = Math.min(minZ, vp[v * 3 + 2]);
  }
  for (const v of verts) span = Math.max(span, vp[v * 3] - minX, vp[v * 3 + 1] - minY, vp[v * 3 + 2] - minZ);
  const numeric = span / tol + 3 < 131072; // three 17-bit cell indices fit a double exactly
  const cellKey = (ix, iy, iz) => (numeric ? (ix * 131072 + iy) * 131072 + iz : `${ix},${iy},${iz}`);
  const cells = new Map(); // cell → vertices in it
  const cell = new Int32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i] * 3;
    const ix = Math.floor((vp[v] - minX) / tol) + 1;
    const iy = Math.floor((vp[v + 1] - minY) / tol) + 1;
    const iz = Math.floor((vp[v + 2] - minZ) / tol) + 1;
    const k = cellKey(ix, iy, iz);
    const list = cells.get(k);
    if (list) list.push(verts[i]);
    else cells.set(k, [verts[i]]);
    cell[i * 3] = ix; cell[i * 3 + 1] = iy; cell[i * 3 + 2] = iz;
  }
  const tol2 = tol * tol;
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    const x = vp[v * 3], y = vp[v * 3 + 1], z = vp[v * 3 + 2];
    const ix = cell[i * 3], iy = cell[i * 3 + 1], iz = cell[i * 3 + 2];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = cells.get(cellKey(ix + dx, iy + dy, iz + dz));
          if (!list) continue;
          for (const w of list) {
            if (w <= v || joined.has(pairKey(v, w))) continue;
            const d2 = (vp[w * 3] - x) ** 2 + (vp[w * 3 + 1] - y) ** 2 + (vp[w * 3 + 2] - z) ** 2;
            if (d2 <= tol2) return true;
          }
        }
      }
    }
  }
  return false;
}

/** Mesh with its merge vectors computed for the given tolerance. */
function mergedMesh(vp, tri, tolerance) {
  const { Mesh } = manifold();
  const mesh = new Mesh({ numProp: 3, vertProperties: vp, triVerts: tri, tolerance });
  mesh.merge();
  return mesh;
}

/** Manifold.ofMesh that returns null instead of throwing / yielding an empty or broken solid. */
function tryOfMesh(mesh) {
  const { Manifold } = manifold();
  try {
    const m = Manifold.ofMesh(mesh);
    if (m.status() === 'NoError' && !m.isEmpty()) return m;
    m.delete();
  } catch {
    // not manifold
  }
  return null;
}

/** Re-index triangles through Manifold's merge vectors (from → to, chains resolved). */
function applyMerge(tri, from, to, V) {
  const canon = new Int32Array(V);
  for (let v = 0; v < V; v++) canon[v] = v;
  for (let i = 0; i < from.length; i++) canon[from[i]] = to[i];
  for (let v = 0; v < V; v++) {
    let r = v;
    for (let steps = 0; canon[r] !== r && steps < 64; steps++) r = canon[r];
    canon[v] = r;
  }
  const out = new Uint32Array(tri.length);
  for (let i = 0; i < tri.length; i++) out[i] = canon[tri[i]];
  return out;
}

// ---------------------------------------------------------------------------
// Step 3: topology repair

/**
 * Half-edge → edge grouping. Half-edge h belongs to triangle h/3 and runs
 * from tri[h] to tri[nextHalf(h)]. edgeOf[h] is its edge id; the half-edges
 * of edge e are edgeHalf[edgeStart[e] .. edgeStart[e+1]).
 */
function buildEdges(tri, V) {
  const H = tri.length;
  const lo = new Int32Array(H);
  const hi = new Int32Array(H);
  const start = new Int32Array(V + 2);
  for (let h = 0; h < H; h += 3) {
    const a = tri[h], b = tri[h + 1], c = tri[h + 2];
    lo[h] = a < b ? a : b; hi[h] = a < b ? b : a;
    lo[h + 1] = b < c ? b : c; hi[h + 1] = b < c ? c : b;
    lo[h + 2] = c < a ? c : a; hi[h + 2] = c < a ? a : c;
    start[lo[h] + 2]++;
    start[lo[h + 1] + 2]++;
    start[lo[h + 2] + 2]++;
  }
  for (let v = 2; v <= V + 1; v++) start[v] += start[v - 1];
  // start[v+1] is now the first slot of bucket v; start[v] is used as the cursor.
  const order = new Int32Array(H);
  for (let h = 0; h < H; h++) order[start[lo[h] + 1]++] = h;
  // After the loop start[v+1] is the end of bucket v and start[v] its beginning.

  const edgeOf = new Int32Array(H).fill(-1);
  let E = 0;
  let bigBucket = null;
  for (let v = 0; v < V; v++) {
    const s = start[v], e = start[v + 1];
    if (e - s > 48) {
      bigBucket ??= new Map();
      bigBucket.clear();
      for (let i = s; i < e; i++) {
        const h = order[i];
        const id = bigBucket.get(hi[h]);
        if (id === undefined) { bigBucket.set(hi[h], E); edgeOf[h] = E++; } else edgeOf[h] = id;
      }
      continue;
    }
    for (let i = s; i < e; i++) {
      const h = order[i];
      if (edgeOf[h] >= 0) continue;
      const id = E++;
      edgeOf[h] = id;
      for (let j = i + 1; j < e; j++) {
        const g = order[j];
        if (edgeOf[g] < 0 && hi[g] === hi[h]) edgeOf[g] = id;
      }
    }
  }
  const edgeStart = new Int32Array(E + 2);
  for (let h = 0; h < H; h++) edgeStart[edgeOf[h] + 2]++;
  for (let e = 2; e <= E + 1; e++) edgeStart[e] += edgeStart[e - 1];
  const edgeHalf = new Int32Array(H);
  for (let h = 0; h < H; h++) edgeHalf[edgeStart[edgeOf[h] + 1]++] = h;
  return { E, edgeOf, edgeStart, edgeHalf };
}

const nextHalf = (h) => (h % 3 === 2 ? h - 2 : h + 1);
const edgeCount = (edges, e) => edges.edgeStart[e + 1] - edges.edgeStart[e];

/** Remove every triangle touching an edge shared by more than two triangles. */
function removeNonManifold(tri, edges) {
  const T = tri.length / 3;
  const keep = new Uint8Array(T).fill(1);
  let removed = 0;
  for (let e = 0; e < edges.E; e++) {
    if (edgeCount(edges, e) <= 2) continue;
    for (let i = edges.edgeStart[e]; i < edges.edgeStart[e + 1]; i++) {
      const t = (edges.edgeHalf[i] / 3) | 0;
      if (keep[t]) { keep[t] = 0; removed++; }
    }
  }
  if (!removed) return { tri, removed };
  const out = new Uint32Array((T - removed) * 3);
  for (let t = 0, n = 0; t < T; t++) {
    if (!keep[t]) continue;
    out[n++] = tri[t * 3];
    out[n++] = tri[t * 3 + 1];
    out[n++] = tri[t * 3 + 2];
  }
  return { tri: out, removed };
}

/**
 * Make winding consistent within each connected component (BFS across
 * two-triangle edges), flipping the minority. Modifies tri in place.
 * @returns {number} triangles flipped
 */
function fixWinding(tri, edges) {
  const T = tri.length / 3;
  const visited = new Uint8Array(T);
  const flipped = new Uint8Array(T);
  const queue = new Int32Array(T);
  const { edgeOf, edgeStart, edgeHalf } = edges;
  let flips = 0;
  for (let seed = 0; seed < T; seed++) {
    if (visited[seed]) continue;
    let head = 0, tail = 0, compFlips = 0;
    queue[tail++] = seed;
    visited[seed] = 1;
    while (head < tail) {
      const t = queue[head++];
      for (let k = 0; k < 3; k++) {
        const h = t * 3 + k;
        const e = edgeOf[h];
        const s = edgeStart[e];
        if (edgeStart[e + 1] - s !== 2) continue;
        const h2 = edgeHalf[s] === h ? edgeHalf[s + 1] : edgeHalf[s];
        const t2 = (h2 / 3) | 0;
        if (visited[t2]) continue;
        const from1 = flipped[t] ? tri[nextHalf(h)] : tri[h];
        if (from1 === tri[h2]) { flipped[t2] = 1; compFlips++; } // same direction → neighbour is reversed
        visited[t2] = 1;
        queue[tail++] = t2;
      }
    }
    if (compFlips * 2 > tail) { // flip the minority instead
      for (let i = 0; i < tail; i++) flipped[queue[i]] ^= 1;
      compFlips = tail - compFlips;
    }
    flips += compFlips;
  }
  if (flips) {
    for (let t = 0; t < T; t++) {
      if (!flipped[t]) continue;
      const tmp = tri[t * 3 + 1];
      tri[t * 3 + 1] = tri[t * 3 + 2];
      tri[t * 3 + 2] = tmp;
    }
  }
  return flips;
}

/**
 * Chain boundary half-edges into loops and triangulate them. Returns the
 * extended index/vertex buffers plus counts.
 */
function fillHoles(vp, tri, edges, maxHoleEdges) {
  const V = vp.length / 3;
  const { edgeOf, edgeStart, edgeHalf, E } = edges;
  // Boundary half-edges bucketed by their start vertex.
  const bStart = new Int32Array(V + 2);
  let B = 0;
  for (let e = 0; e < E; e++) {
    if (edgeCount(edges, e) !== 1) continue;
    bStart[tri[edgeHalf[edgeStart[e]]] + 2]++;
    B++;
  }
  if (!B) return { vp, tri, filled: 0, skipped: 0 };
  for (let v = 2; v <= V + 1; v++) bStart[v] += bStart[v - 1];
  const bList = new Int32Array(B);
  for (let e = 0; e < E; e++) {
    if (edgeCount(edges, e) !== 1) continue;
    const h = edgeHalf[edgeStart[e]];
    bList[bStart[tri[h] + 1]++] = h;
  }

  const used = new Uint8Array(tri.length);
  const posInLoop = new Int32Array(V).fill(-1);
  const fills = [];
  const extra = [];
  let filled = 0;
  let skipped = 0;
  const emit = (loop) => {
    for (const h of loop) posInLoop[tri[h]] = -1;
    if (loop.length < 3) return;
    const poly = new Int32Array(loop.length);
    for (let i = 0; i < loop.length; i++) poly[i] = tri[loop[loop.length - 1 - i]]; // reversed → opposite winding
    if (poly.length === 3) fills.push(poly[0], poly[1], poly[2]);
    else if (!earClip(poly, vp, fills)) centroidFan(poly, vp, V + extra.length / 3, extra, fills);
    filled++;
  };

  for (let b = 0; b < B; b++) {
    const h0 = bList[b];
    if (used[h0]) continue;
    const loop = [h0];
    used[h0] = 1;
    posInLoop[tri[h0]] = 0;
    let cur = tri[nextHalf(h0)];
    let ok = true;
    while (cur !== tri[h0]) {
      const p = posInLoop[cur];
      if (p > 0) emit(loop.splice(p)); // pinch vertex: close the sub-loop and carry on
      let next = -1;
      for (let i = bStart[cur]; i < bStart[cur + 1]; i++) {
        if (!used[bList[i]]) { next = bList[i]; break; }
      }
      if (next < 0) { ok = false; break; } // dangling chain: leave it open
      used[next] = 1;
      posInLoop[cur] = loop.length;
      loop.push(next);
      cur = tri[nextHalf(next)];
    }
    if (ok && loop.length <= maxHoleEdges) emit(loop);
    else {
      skipped++;
      for (const h of loop) posInLoop[tri[h]] = -1;
    }
  }

  const outTri = new Uint32Array(tri.length + fills.length);
  outTri.set(tri);
  outTri.set(fills, tri.length);
  let outVp = vp;
  if (extra.length) {
    outVp = new Float32Array(vp.length + extra.length);
    outVp.set(vp);
    outVp.set(extra, vp.length);
  }
  return { vp: outVp, tri: outTri, filled, skipped };
}

/**
 * Ear-clip a polygon (vertex indices, consistently wound) projected onto its
 * Newell best-fit plane. Appends triangles to out; returns false (appending
 * nothing) when the polygon is degenerate or the clipper gets stuck.
 */
function earClip(poly, vp, out) {
  const n = poly.length;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const p = poly[i] * 3, q = poly[(i + 1) % n] * 3;
    nx += (vp[p + 1] - vp[q + 1]) * (vp[p + 2] + vp[q + 2]);
    ny += (vp[p + 2] - vp[q + 2]) * (vp[p] + vp[q]);
    nz += (vp[p] - vp[q]) * (vp[p + 1] + vp[q + 1]);
  }
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 0)) return false;
  nx /= len; ny /= len; nz /= len;
  // Basis (u, v) in the plane: u ⟂ N, v = N × u.
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  let ux, uy, uz;
  if (ax <= ay && ax <= az) { ux = 0; uy = -nz; uz = ny; }
  else if (ay <= az) { ux = -nz; uy = 0; uz = nx; }
  else { ux = -ny; uy = nx; uz = 0; }
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const wx = ny * uz - nz * uy, wy = nz * ux - nx * uz, wz = nx * uy - ny * ux;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  let span = 0;
  for (let i = 0; i < n; i++) {
    const p = poly[i] * 3;
    xs[i] = vp[p] * ux + vp[p + 1] * uy + vp[p + 2] * uz;
    ys[i] = vp[p] * wx + vp[p + 1] * wy + vp[p + 2] * wz;
    span = Math.max(span, Math.abs(xs[i]), Math.abs(ys[i]));
  }
  const eps = 1e-12 * span * span;
  if (len < eps) return false; // all but collinear

  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  for (let i = 0; i < n; i++) { prev[i] = (i + n - 1) % n; next[i] = (i + 1) % n; }
  const cross = (a, b, c) => (xs[b] - xs[a]) * (ys[c] - ys[b]) - (ys[b] - ys[a]) * (xs[c] - xs[b]);
  const inside = (a, b, c, r) => cross(a, b, r) >= -eps && cross(b, c, r) >= -eps && cross(c, a, r) >= -eps;
  const isEar = (i) => {
    const p = prev[i], q = next[i];
    if (!(cross(p, i, q) > eps)) return false;
    for (let r = next[q]; r !== p; r = next[r]) if (inside(p, i, q, r)) return false;
    return true;
  };
  const diagonal2 = (i) => {
    const a = poly[prev[i]] * 3, b = poly[next[i]] * 3;
    return (vp[a] - vp[b]) ** 2 + (vp[a + 1] - vp[b + 1]) ** 2 + (vp[a + 2] - vp[b + 2]) ** 2;
  };
  const tmp = [];
  let remaining = n;
  let i = 0;
  let stuck = 0;
  while (remaining > 3) {
    if (stuck > remaining) return false;
    let ear = -1;
    if (remaining <= 64) {
      // Small loops (the common case, and non-planar ones): clip the ear with the
      // shortest 3D diagonal, which keeps the fill close to the surrounding surface.
      let best = Infinity;
      for (let j = i, k = 0; k < remaining; j = next[j], k++) {
        if (!isEar(j)) continue;
        const d = diagonal2(j);
        if (d < best) { best = d; ear = j; }
      }
      if (ear < 0) return false;
    } else if (isEar(i)) ear = i;
    if (ear < 0) { stuck++; i = next[i]; continue; }
    const p = prev[ear], q = next[ear];
    tmp.push(poly[p], poly[ear], poly[q]);
    next[p] = q;
    prev[q] = p;
    remaining--;
    stuck = 0;
    i = q;
  }
  tmp.push(poly[prev[i]], poly[i], poly[next[i]]);
  for (const v of tmp) out.push(v);
  return true;
}

/** Fan a loop around a new centroid vertex (index `c`, coordinates appended to extra). */
function centroidFan(poly, vp, c, extra, out) {
  const n = poly.length;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    const p = poly[i] * 3;
    cx += vp[p]; cy += vp[p + 1]; cz += vp[p + 2];
  }
  extra.push(cx / n, cy / n, cz / n);
  for (let i = 0; i < n; i++) out.push(poly[i], poly[(i + 1) % n], c);
}

/** Connected components (shells) over shared edges: compOf[t] = component id. */
function components(tri, edges) {
  const T = tri.length / 3;
  const compOf = new Int32Array(T).fill(-1);
  const queue = new Int32Array(T);
  const { edgeOf, edgeStart, edgeHalf } = edges;
  let count = 0;
  for (let seed = 0; seed < T; seed++) {
    if (compOf[seed] >= 0) continue;
    const id = count++;
    let head = 0, tail = 0;
    queue[tail++] = seed;
    compOf[seed] = id;
    while (head < tail) {
      const t = queue[head++];
      for (let k = 0; k < 3; k++) {
        const e = edgeOf[t * 3 + k];
        for (let i = edgeStart[e]; i < edgeStart[e + 1]; i++) {
          const t2 = (edgeHalf[i] / 3) | 0;
          if (compOf[t2] < 0) { compOf[t2] = id; queue[tail++] = t2; }
        }
      }
    }
  }
  return { count, compOf };
}

/** Steps 3a–3d: non-manifold edges, winding, holes. Updates report counters. */
function repairTopology(vp, tri, edges, maxHoleEdges, report, onProgress) {
  const V = vp.length / 3;
  edges ??= buildEdges(tri, V);

  const cut = removeNonManifold(tri, edges);
  if (cut.removed) {
    tri = cut.tri;
    edges = buildEdges(tri, V);
    report.notes.push(`Removed ${plural(cut.removed, 'triangle')} on non-manifold edges`);
  }

  const flips = fixWinding(tri, edges);
  if (flips) {
    edges = buildEdges(tri, V);
    report.trianglesFlipped = flips;
    report.notes.push(`Flipped ${plural(flips, 'triangle')}`);
  }

  onProgress('Filling holes');
  const fillStart = tri.length; // fill triangles are appended after the originals
  const holes = fillHoles(vp, tri, edges, maxHoleEdges);
  if (holes.filled) {
    report.holesFilled = holes.filled;
    report.notes.push(`Filled ${plural(holes.filled, 'hole')}`);
  }
  if (holes.skipped) report.notes.push(`Skipped ${plural(holes.skipped, 'hole')} with more than ${maxHoleEdges} edges`);
  return { vp: holes.vp, tri: holes.tri, fillStart };
}

/** Step 3e: one Manifold per connected shell; shells that fail are dropped. */
function buildShells(vp, tri, tolerance, report, passthroughs = [], fillStart = tri.length) {
  const V = vp.length / 3;
  const { count, compOf } = components(tri, buildEdges(tri, V));
  const parts = [];
  // A shell that cannot be closed, or closes to nothing, passes through with
  // the triangles the file actually contained (never with our fill patches).
  const solidOrPass = (shellVp, shellTri, originals) => {
    const m = tryOfMesh(mergedMesh(shellVp, shellTri, tolerance));
    if (m && Math.abs(m.volume()) > 0) {
      parts.push(m);
      return;
    }
    m?.delete();
    report.shellsDropped++;
    passthroughs.push(originals);
  };
  if (count <= 1) {
    solidOrPass(vp, tri, soupOf(vp, tri.subarray(0, fillStart)));
    return { parts };
  }
  // Bucket triangles by component, then compact each shell's vertices.
  const T = tri.length / 3;
  const compStart = new Int32Array(count + 2);
  for (let t = 0; t < T; t++) compStart[compOf[t] + 2]++;
  for (let c = 2; c <= count + 1; c++) compStart[c] += compStart[c - 1];
  const compTris = new Int32Array(T);
  for (let t = 0; t < T; t++) compTris[compStart[compOf[t] + 1]++] = t;
  const map = new Int32Array(V).fill(-1);
  for (let c = 0; c < count; c++) {
    const s = compStart[c], e = compStart[c + 1];
    const shellTri = new Uint32Array((e - s) * 3);
    const verts = [];
    for (let i = s, n = 0; i < e; i++) {
      const t = compTris[i] * 3;
      for (let k = 0; k < 3; k++) {
        const v = tri[t + k];
        if (map[v] < 0) { map[v] = verts.length; verts.push(v); }
        shellTri[n++] = map[v];
      }
    }
    const shellVp = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) {
      shellVp[i * 3] = vp[verts[i] * 3];
      shellVp[i * 3 + 1] = vp[verts[i] * 3 + 1];
      shellVp[i * 3 + 2] = vp[verts[i] * 3 + 2];
      map[verts[i]] = -1;
    }
    // original (non-fill) triangles of this component, in input coordinates
    const originalIds = [];
    for (let i = s; i < e; i++) if (compTris[i] * 3 < fillStart) originalIds.push(compTris[i]);
    const originals = new Uint32Array(originalIds.length * 3);
    originalIds.forEach((t, n) => originals.set(tri.subarray(t * 3, t * 3 + 3), n * 3));
    solidOrPass(shellVp, shellTri, soupOf(vp, originals));
  }
  return { parts };
}

// ---------------------------------------------------------------------------
// Step 4: orientation + combining shells

/** Rebuild a solid with every triangle's winding reversed. */
function flipSolid(solid) {
  const { Mesh } = manifold();
  const mesh = solid.getMesh();
  const triVerts = mesh.triVerts.slice();
  for (let i = 0; i < triVerts.length; i += 3) {
    const tmp = triVerts[i + 1];
    triVerts[i + 1] = triVerts[i + 2];
    triVerts[i + 2] = tmp;
  }
  solid.delete();
  return tryOfMesh(new Mesh({
    numProp: mesh.numProp, vertProperties: mesh.vertProperties, triVerts, tolerance: mesh.tolerance,
  }));
}

const containsBox = (outer, inner) =>
  inner.min.every((v, i) => v >= outer.min[i]) && inner.max.every((v, i) => v <= outer.max[i]);

/** Boolean union of a list of solids; consumes (deletes) the inputs. */
/** Union of several solids. Consumes the inputs on success; leaves them to the caller on failure. */
function unionAll(solids) {
  if (solids.length === 1) return solids[0];
  const { Manifold } = manifold();
  const u = Manifold.union(solids);
  const ok = u.status() === 'NoError' && !u.isEmpty();
  if (ok) {
    solids.forEach((s) => s.delete());
    return u;
  }
  u.delete();
  return null;
}

/**
 * Orient and combine shells: an inside-out model is flipped as a whole,
 * inverted shells inside another shell are kept as cavities, other inverted
 * shells are turned right-side-out, and overlapping shells are unioned.
 * Consumes the parts; returns the single result or null.
 */
function assembleShells(parts, report, passthroughs = []) {
  const { Manifold } = manifold();
  let vols = parts.map((p) => p.volume());
  let inverted = 0;
  if (vols.reduce((s, v) => s + v, 0) < 0) { // the whole model is inside-out
    const flipped = parts.map((p) => {
      const backup = soupOfManifold(p);
      const f = flipSolid(p);
      if (!f) {
        report.shellsDropped++;
        passthroughs.push(backup);
      }
      return f;
    });
    inverted += parts.length;
    parts = flipped.filter(Boolean);
    vols = parts.map((p) => p.volume());
  }
  const positives = [];
  const cavities = [];
  let expected = 0;
  for (let i = 0; i < parts.length; i++) if (vols[i] > 0) positives.push(parts[i]);
  const outerBoxes = positives.map((p) => p.boundingBox());
  for (let i = 0; i < parts.length; i++) {
    if (vols[i] > 0) { expected += vols[i]; continue; }
    if (vols[i] === 0) {
      passthroughs.push(soupOfManifold(parts[i]));
      parts[i].delete();
      report.shellsDropped++;
      continue;
    }
    const box = parts[i].boundingBox();
    const backup = soupOfManifold(parts[i]);
    const flipped = flipSolid(parts[i]);
    if (!flipped) {
      report.shellsDropped++;
      passthroughs.push(backup);
      continue;
    }
    if (outerBoxes.some((outer) => containsBox(outer, box))) {
      cavities.push(flipped);
      expected += vols[i];
    } else {
      positives.push(flipped);
      expected -= vols[i];
      inverted++;
    }
  }
  if (inverted) {
    report.shellsInverted += inverted;
    report.notes.push(`Turned ${plural(inverted, 'shell')} right-side-out`);
  }
  report.shells = positives.length + cavities.length;
  if (!positives.length) {
    cavities.forEach((c) => c.delete());
    return null;
  }

  let result = unionAll(positives);
  if (result && cavities.length) {
    const hole = unionAll(cavities);
    if (hole) {
      const carved = Manifold.difference(result, hole);
      carved.status();
      result.delete();
      hole.delete();
      result = carved;
    } else {
      // the cavities could not be combined: keep their triangles rather than lose them
      report.notes.push('Boolean combination of cavities failed');
      for (const c of cavities) {
        passthroughs.push(soupOfManifold(c));
        c.delete();
      }
      report.shellsDropped += cavities.length;
    }
  }
  if (!result) {
    report.notes.push('Boolean combination of shells failed');
    for (const p of [...positives, ...cavities]) {
      passthroughs.push(soupOfManifold(p));
      p.delete();
    }
    report.shellsDropped += positives.length + cavities.length;
    return null;
  }
  if (report.shells > 1 && Math.abs(result.volume() - expected) > 1e-6 * Math.abs(expected)) {
    report.notes.push(`Merged ${report.shells} overlapping shells`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// helpers

function hash3(a, b, c) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ b, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ c, 0x27d4eb2f);
  return (h ^ (h >>> 15)) >>> 0;
}

function nextPow2(n) {
  let p = 16;
  while (p < n) p *= 2;
  return p;
}

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

const formatLength = (x) => Number(x.toPrecision(2)).toString();
