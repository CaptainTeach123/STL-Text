import { buildTopology, faceData, pairEdges, smoothField } from './enhance.js';

/**
 * The "base" of a mesh: its surface smoothed at a scale larger than the
 * details standing on it, so that berries, leaves and the like are gone
 * while the shape they stand on remains. Plain smoothing also shrinks a
 * curved surface; that shrink is measured by smoothing the base once more
 * and added back, so the base of a plain cane is the cane itself.
 * Vertices on an open border (a cut-out region) are pinned.
 * @returns {{ base: Float64Array, normals: Float64Array, height: Float64Array, areas: Float64Array, topo: object, featureSize: number }}
 *   `height` is how far each vertex stands above the base along its normal.
 */
export function baseSurface(mesh, { featureSize = 0, pinBorder = true } = {}) {
  const pos = Float64Array.from(mesh.positions);
  const index = mesh.index;
  const V = pos.length / 3;
  const T = index.length / 3;
  const topo = buildTopology(pos, index);
  const { diag, adjStart, adj } = topo;
  const fd = faceData(pos, index);
  // the typical edge length: the median of the vertices' mean edge lengths, so a few long edges do not skew it
  const hv = Float64Array.from(topo.hv).sort();
  const hMean = hv[hv.length >> 1] || topo.hMean;
  // vertex normals (area weighted) and vertex areas
  const normals = new Float64Array(V * 3);
  const areas = new Float64Array(V);
  for (let t = 0; t < T; t++) {
    const a2 = fd.area[t] * 2;
    for (let k = 0; k < 3; k++) {
      const v = index[t * 3 + k];
      normals[v * 3] += a2 * fd.n[t * 3];
      normals[v * 3 + 1] += a2 * fd.n[t * 3 + 1];
      normals[v * 3 + 2] += a2 * fd.n[t * 3 + 2];
      areas[v] += fd.area[t] / 3;
    }
  }
  for (let v = 0; v < V; v++) {
    const l = Math.hypot(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
    if (l > 1e-30) {
      normals[v * 3] /= l;
      normals[v * 3 + 1] /= l;
      normals[v * 3 + 2] /= l;
    }
  }
  const F = featureSize > 0 ? featureSize : Math.max(10 * hMean, 0.05 * diag);
  const K = Math.max(2, Math.min(600, Math.round(0.5 * (F / hMean) ** 2)));
  // the step is normalised by ring size so the kernel is uniform in millimetres, and border vertices stay put
  const ring = new Float64Array(V);
  for (let v = 0; v < V; v++) {
    const s = adjStart[v], e = adjStart[v + 1];
    if (e === s) continue;
    let sum = 0;
    for (let i = s; i < e; i++) {
      const j = adj[i] * 3;
      sum += (pos[j] - pos[v * 3]) ** 2 + (pos[j + 1] - pos[v * 3 + 1]) ** 2 + (pos[j + 2] - pos[v * 3 + 2]) ** 2;
    }
    ring[v] = sum / (e - s);
  }
  const half = new Float64Array(V).fill(0.5);
  const ringBar = smoothField(ring, topo, half, Math.min(K, 64), 1);
  const free = new Uint8Array(V).fill(1);
  if (pinBorder) {
    const edges = pairEdges(index, V);
    const open = edges.open ?? edges.openVertices ?? null;
    if (open) for (let v = 0; v < V; v++) if (open[v]) free[v] = 0;
  }
  const lam = new Float64Array(V);
  for (let v = 0; v < V; v++) {
    const rho = ring[v] > 0 ? Math.max(0.5, Math.min(1.5, ringBar[v] / ring[v])) : 1;
    lam[v] = 0.5 * rho * free[v] * (adjStart[v + 1] > adjStart[v] ? 1 : 0);
  }
  const q = smoothField(pos, topo, lam, K, 3);
  const q2 = smoothField(q, topo, lam, K, 3);
  const base = new Float64Array(V * 3);
  const height = new Float64Array(V);
  for (let v = 0; v < V; v++) {
    // the shrink the smoothing causes on the base itself, measured by smoothing it again, is added back
    const sx = q[v * 3] - q2[v * 3], sy = q[v * 3 + 1] - q2[v * 3 + 1], sz = q[v * 3 + 2] - q2[v * 3 + 2];
    const shrink = sx * normals[v * 3] + sy * normals[v * 3 + 1] + sz * normals[v * 3 + 2];
    base[v * 3] = q[v * 3] + shrink * normals[v * 3];
    base[v * 3 + 1] = q[v * 3 + 1] + shrink * normals[v * 3 + 1];
    base[v * 3 + 2] = q[v * 3 + 2] + shrink * normals[v * 3 + 2];
    height[v] = (pos[v * 3] - base[v * 3]) * normals[v * 3] + (pos[v * 3 + 1] - base[v * 3 + 1]) * normals[v * 3 + 1] + (pos[v * 3 + 2] - base[v * 3 + 2]) * normals[v * 3 + 2];
  }
  return { base, normals, height, areas, topo, featureSize: F };
}

/**
 * Find the details standing on a model – berries, leaves, stars, scrolls:
 * anything that rises above the surface around it. How far each vertex
 * stands above the base (see baseSurface) is the detail height. Vertices
 * clearly above the base seed regions that grow over everything moderately
 * above it, so a detail is found whole. Each region is then measured, and a
 * sphere is fitted to it: a region the sphere fits closely and that covers
 * a fair share of it is a round detail (a berry), which can be replaced by
 * a clean sphere of the fitted size; the rest are reported with their
 * extent for a local clean-up or removal. Long thin regions (the rim of a
 * sharp edge) are not details.
 *
 * @param {{ positions: Float32Array|Float64Array, index: Uint32Array }} mesh
 * @param {object} [options]
 * @param {number} [options.featureSize]  scale of the base smoothing, mm – about three times the size of the details
 *   (0: automatic, 5 % of the model's extent)
 * @param {number} [options.minHeight]    details lower than this are ignored, mm (0: automatic)
 * @param {number} [options.maxCount]     at most this many details, the tallest first (default 400)
 * @returns {{ details: Detail[], featureSize: number, threshold: number }}
 *   Detail = { id, kind: 'round' | 'other', center, normal, radius, size, height, vertices, roundness }
 *   where `center` is the fitted sphere's centre (round) or the region's centroid (other), `normal` the
 *   base surface direction there, `radius` the fitted radius (round) or half the region's extent (other),
 *   `height` how far the detail stands above the base, all in the mesh's own frame.
 */
export function findDetails(mesh, { featureSize = 0, minHeight = 0, maxCount = 400 } = {}) {
  const pos = Float64Array.from(mesh.positions);
  const index = mesh.index;
  const V = pos.length / 3;
  const T = index.length / 3;
  if (V < 4 || T < 4) return { details: [], featureSize: 0, threshold: 0 };
  const { normals: vn, height: r, areas: va, topo, featureSize: F } = baseSurface(mesh, { featureSize, pinBorder: false });
  const { adjStart, adj } = topo;
  // vertices on a sharp crease (faces meeting at more than 50°): the rim of a plateau, the edge of a block
  const sharp = new Uint8Array(V);
  {
    const fd = faceData(pos, index);
    const edges = pairEdges(index, V);
    const cosSharp = Math.cos((50 * Math.PI) / 180);
    for (let e = 0; e < edges.count; e++) {
      const a = edges.faceA[e] * 3, b = edges.faceB[e] * 3;
      const dot = fd.n[a] * fd.n[b] + fd.n[a + 1] * fd.n[b + 1] + fd.n[a + 2] * fd.n[b + 2];
      if (dot < cosSharp) {
        sharp[edges.lo[e]] = 1;
        sharp[edges.hi[e]] = 1;
      }
    }
  }

  // threshold: clearly above the noise of the surface, and a fair fraction of the feature scale
  const sorted = Float64Array.from(r).sort();
  const median = sorted[V >> 1];
  const dev = Float64Array.from(r, (x) => Math.abs(x - median)).sort();
  const mad = dev[V >> 1] * 1.4826;
  const high = Math.max(minHeight, 0.06 * F, median + 3 * mad);
  const low = median + 0.35 * (high - median);

  // regions: grow from the clearly-raised vertices over everything moderately raised
  const label = new Int32Array(V).fill(-1);
  const regions = [];
  const stack = new Int32Array(V);
  for (let seed = 0; seed < V; seed++) {
    if (label[seed] >= 0 || r[seed] <= high) continue;
    const id = regions.length;
    const members = [];
    let top = 0;
    stack[top++] = seed;
    label[seed] = id;
    while (top > 0) {
      const v = stack[--top];
      members.push(v);
      for (let i = adjStart[v]; i < adjStart[v + 1]; i++) {
        const o = adj[i];
        if (label[o] >= 0 || r[o] <= low) continue;
        label[o] = id;
        stack[top++] = o;
      }
    }
    regions.push(members);
  }

  const details = [];
  for (let id = 0; id < regions.length; id++) {
    const members = regions[id];
    if (members.length < 6) continue;
    let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0, area = 0, height = 0, creased = 0;
    for (const v of members) {
      creased += sharp[v];
      cx += pos[v * 3];
      cy += pos[v * 3 + 1];
      cz += pos[v * 3 + 2];
      nx += vn[v * 3] * va[v];
      ny += vn[v * 3 + 1] * va[v];
      nz += vn[v * 3 + 2] * va[v];
      area += va[v];
      if (r[v] > height) height = r[v];
    }
    const n = members.length;
    cx /= n;
    cy /= n;
    cz /= n;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const normal = [nx / nl, ny / nl, nz / nl];

    let far = 0;
    for (const v of members) {
      const d = (pos[v * 3] - cx) ** 2 + (pos[v * 3 + 1] - cy) ** 2 + (pos[v * 3 + 2] - cz) ** 2;
      if (d > far) far = d;
    }
    const size = 2 * Math.sqrt(far);
    if (size < 0.15 * F || size > 1.5 * F) continue; // vertex-scale noise, or larger than what the feature scale looks for
    if (area < 0.3 * Math.PI * far) continue; // long and thin: the rim of an edge, not a detail
    if (height < 0.06 * size) continue; // broad and very low: not something standing on the surface
    if (size > 0.8 * F && creased / n > 0.1) continue; // a large region with a sharp rim: the end of the body, not a detail
    const fit = fitSphere(pos, members);
    let kind = 'other';
    let center = [cx, cy, cz];
    let radius = size / 2;
    let roundness = NaN;
    if (fit) {
      roundness = fit.rms / fit.radius;
      const coverage = area / (4 * Math.PI * fit.radius * fit.radius);
      if (roundness < 0.08 && fit.radius > 0.35 * size && fit.radius < 1.1 * size && coverage > 0.2) {
        kind = 'round';
        center = fit.center;
        radius = fit.radius;
      }
    }
    details.push({ id, kind, center, normal, radius, size, height, vertices: n, roundness });
  }
  details.sort((a, b) => b.height - a.height);
  return { details: details.slice(0, maxCount), featureSize: F, threshold: high };
}

/** Least-squares sphere through the vertices (Kåsa's algebraic fit): { center, radius, rms } or null. */
function fitSphere(pos, members) {
  // minimise Σ (|p|² − 2 p·c − k)² over c and k = R² − |c|²: normal equations of [2x 2y 2z 1] · [c; k] = |p|²
  const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const b = [0, 0, 0, 0];
  for (const v of members) {
    const row = [2 * pos[v * 3], 2 * pos[v * 3 + 1], 2 * pos[v * 3 + 2], 1];
    const rhs = pos[v * 3] ** 2 + pos[v * 3 + 1] ** 2 + pos[v * 3 + 2] ** 2;
    for (let i = 0; i < 4; i++) {
      b[i] += row[i] * rhs;
      for (let j = 0; j < 4; j++) A[i][j] += row[i] * row[j];
    }
  }
  const x = solve4(A, b);
  if (!x) return null;
  const [cx, cy, cz, k] = x;
  const r2 = k + cx * cx + cy * cy + cz * cz;
  if (!(r2 > 0)) return null;
  const radius = Math.sqrt(r2);
  let ss = 0;
  for (const v of members) {
    const d = Math.hypot(pos[v * 3] - cx, pos[v * 3 + 1] - cy, pos[v * 3 + 2] - cz) - radius;
    ss += d * d;
  }
  return { center: [cx, cy, cz], radius, rms: Math.sqrt(ss / members.length) };
}

function solve4(A, b) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[4] / row[i]);
}
