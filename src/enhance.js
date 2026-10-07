/**
 * Mesh enhancement for soft, low-definition models (what AI generators tend
 * to produce): edges that should be crisp are rounded, flat panels wobble,
 * fine relief is mushy. Three operations, each bounded so the mesh stays a
 * valid, printable solid (same triangles, no flipped triangle, no vertex
 * moving further than a fraction of its edges):
 *
 *   smooth  – feature-preserving denoising: face normals are averaged with
 *             their neighbours (bilateral: by distance and by how alike the
 *             normals already are, never across an edge sharper than
 *             `edgeAngle`), then vertices are moved to fit the new normals.
 *             Only groups of faces whose filtered normals agree are fitted as
 *             planes; a face on its own (a coarse facet of a curved surface)
 *             is left where it is, so nothing gets lumpy.
 *   sharpen – guided normal filtering: a face next to a markedly flatter
 *             patch adopts that patch's normal, so rounded edges turn into
 *             two flat faces meeting at a crease; isolated curved surfaces
 *             (spheres, berries) are left alone.
 *   detail  – mesh unsharp masking: relief height = how far a vertex sits
 *             above the locally smoothed base shape; its band-passed part is
 *             amplified along the vertex normal. Flat and smooth regions are
 *             masked out ("coring") and creases are pinned.
 *
 * Everything runs on typed arrays with CSR adjacency; the per-face and
 * per-vertex loops allocate nothing; deterministic. Meant for meshes whose
 * triangles are small next to the features (what generators produce); on
 * very coarse meshes the relief boost can still mistake an irregular vertex
 * for relief, and smoothing/sharpening simply leave coarse facets alone.
 */

export const ENHANCE_DEFAULTS = Object.freeze({ sharpen: 0, detail: 0, smooth: 0, edgeAngle: 30, featureSize: 0, maxMove: 0 });

/** The cap on vertex movement when none is given: this fraction of the local mean edge length. */
export const CAP_FACTOR = 0.35;

export function isEnhanceActive(options) {
  return !!options && ((options.sharpen ?? 0) > 0 || (options.detail ?? 0) > 0 || (options.smooth ?? 0) > 0);
}

const chord = (deg) => 2 * Math.sin((deg * Math.PI) / 360); // |n1 - n2| for unit normals `deg` apart
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/* ------------------------------------------------------------ connectivity */

/**
 * CSR connectivity of an indexed triangle mesh: vertex→faces, face→faces
 * sharing a vertex (the face 1-ring, deduplicated), vertex→vertices
 * (deduplicated), local mean edge length per vertex, global mean edge length
 * and the bounding-box diagonal.
 */
export function buildTopology(pos, index) {
  const V = pos.length / 3;
  const T = index.length / 3;
  // vertex -> faces
  const vfStart = new Int32Array(V + 1);
  for (let i = 0; i < index.length; i++) vfStart[index[i] + 1]++;
  for (let v = 0; v < V; v++) vfStart[v + 1] += vfStart[v];
  const vfList = new Int32Array(index.length);
  const cursor = vfStart.slice(0, V);
  for (let t = 0; t < T; t++) {
    vfList[cursor[index[t * 3]]++] = t;
    vfList[cursor[index[t * 3 + 1]]++] = t;
    vfList[cursor[index[t * 3 + 2]]++] = t;
  }
  // local mean edge length (each edge seen from both faces: fine for a mean)
  const hv = new Float64Array(V);
  const hc = new Int32Array(V);
  let hsum = 0;
  let hcount = 0;
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const a = index[t * 3 + k];
      const b = index[t * 3 + ((k + 1) % 3)];
      const dx = pos[a * 3] - pos[b * 3];
      const dy = pos[a * 3 + 1] - pos[b * 3 + 1];
      const dz = pos[a * 3 + 2] - pos[b * 3 + 2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      hv[a] += l;
      hc[a]++;
      hv[b] += l;
      hc[b]++;
      hsum += l;
      hcount++;
    }
  }
  for (let v = 0; v < V; v++) hv[v] = hc[v] ? hv[v] / hc[v] : 0;
  const hMean = hcount ? hsum / hcount : 1;
  // face -> faces sharing a vertex (excluding itself), deduplicated with a stamp
  const stamp = new Int32Array(T);
  const nbStart = new Int32Array(T + 1);
  let nbList = null;
  for (let pass = 0; pass < 2; pass++) {
    stamp.fill(0);
    let n = 0;
    for (let t = 0; t < T; t++) {
      stamp[t] = t + 1;
      for (let k = 0; k < 3; k++) {
        const v = index[t * 3 + k];
        for (let i = vfStart[v]; i < vfStart[v + 1]; i++) {
          const g = vfList[i];
          if (stamp[g] !== t + 1) {
            stamp[g] = t + 1;
            if (pass) nbList[n] = g;
            n++;
          }
        }
      }
      if (!pass) nbStart[t + 1] = n;
    }
    if (!pass) nbList = new Int32Array(n);
  }
  // vertex -> vertices (deduplicated; rows are tiny, so a sort is cheap)
  const vStart = new Int32Array(V + 2);
  for (let h = 0; h < index.length; h++) vStart[index[h] + 2]++;
  for (let v = 2; v <= V + 1; v++) vStart[v] += vStart[v - 1];
  const raw = new Int32Array(index.length);
  for (let h = 0; h < index.length; h++) {
    const a = index[h];
    const b = index[h % 3 === 2 ? h - 2 : h + 1];
    raw[vStart[a + 1]++] = b;
  }
  const adj = new Int32Array(index.length);
  const adjStart = new Int32Array(V + 1);
  let m = 0;
  for (let v = 0; v < V; v++) {
    const s = vStart[v];
    const e = vStart[v + 1];
    adjStart[v] = m;
    const row = raw.subarray(s, e).sort();
    for (let i = 0; i < row.length; i++) {
      if (i > 0 && row[i] === row[i - 1]) continue;
      adj[m++] = row[i];
    }
  }
  adjStart[V] = m;
  // bounding box diagonal
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < V; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const diag = V ? Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2) : 0;
  return { V, T, vfStart, vfList, nbStart, nbList, adjStart, adj: adj.subarray(0, m), hv, hMean, diag };
}

/** Unit face normals (zero for degenerate faces), areas and centroids. */
export function faceData(pos, index, fd) {
  const T = index.length / 3;
  fd ??= { n: new Float64Array(T * 3), area: new Float64Array(T), c: new Float64Array(T * 3) };
  const { n, area, c } = fd;
  for (let t = 0; t < T; t++) {
    const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, k = index[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[k] - pos[a], vy = pos[k + 1] - pos[a + 1], vz = pos[k + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    area[t] = l / 2;
    if (l > 1e-30) {
      n[t * 3] = nx / l;
      n[t * 3 + 1] = ny / l;
      n[t * 3 + 2] = nz / l;
    } else {
      n[t * 3] = n[t * 3 + 1] = n[t * 3 + 2] = 0;
    }
    c[t * 3] = (pos[a] + pos[b] + pos[k]) / 3;
    c[t * 3 + 1] = (pos[a + 1] + pos[b + 1] + pos[k + 1]) / 3;
    c[t * 3 + 2] = (pos[a + 2] + pos[b + 2] + pos[k + 2]) / 3;
  }
  return fd;
}

/**
 * Pair the half-edges of the mesh. Returns the faces on either side of every
 * edge that has exactly two, and flags the vertices of edges that have one
 * (boundary) or more than two (non-manifold) – those are pinned later.
 */
export function pairEdges(index, V) {
  const H = index.length;
  const lo = new Int32Array(H);
  const hi = new Int32Array(H);
  const start = new Int32Array(V + 2);
  for (let h = 0; h < H; h++) {
    const a = index[h];
    const b = index[h % 3 === 2 ? h - 2 : h + 1];
    lo[h] = a < b ? a : b;
    hi[h] = a < b ? b : a;
    start[lo[h] + 2]++;
  }
  for (let v = 2; v <= V + 1; v++) start[v] += start[v - 1];
  const order = new Int32Array(H);
  for (let h = 0; h < H; h++) order[start[lo[h] + 1]++] = h;
  const faceA = new Int32Array(H / 2 + 1);
  const faceB = new Int32Array(H / 2 + 1);
  const open = new Uint8Array(V);
  let E = 0;
  const keys = new Float64Array(64);
  let keyBuf = keys;
  for (let v = 0; v < V; v++) {
    const s = start[v];
    const e = start[v + 1];
    if (e === s) continue;
    // sort this vertex's half-edges by their other end (tiny bucket)
    if (keyBuf.length < e - s) keyBuf = new Float64Array(e - s);
    for (let i = s; i < e; i++) keyBuf[i - s] = hi[order[i]] * 4194304 + (i - s); // stable: index in the low bits
    const bucket = keyBuf.subarray(0, e - s).sort();
    let i = 0;
    while (i < bucket.length) {
      const other = Math.floor(bucket[i] / 4194304);
      let j = i;
      while (j < bucket.length && Math.floor(bucket[j] / 4194304) === other) j++;
      if (j - i === 2) {
        const h0 = order[s + (bucket[i] % 4194304)];
        const h1 = order[s + (bucket[i + 1] % 4194304)];
        faceA[E] = (h0 / 3) | 0;
        faceB[E] = (h1 / 3) | 0;
        E++;
      } else {
        open[v] = 1;
        open[other] = 1;
      }
      i = j;
    }
  }
  return { faceA: faceA.subarray(0, E), faceB: faceB.subarray(0, E), count: E, open, lo, hi, order, start };
}

/** Dihedral angle (degrees) across every paired edge; returns the count above `edgeAngle` and the sharpest edge at each vertex. */
function dihedrals(edges, index, n, edgeAngle, V) {
  const maxDih = new Float64Array(V);
  const cosA = Math.cos((edgeAngle * Math.PI) / 180);
  let featureEdges = 0;
  for (let e = 0; e < edges.count; e++) {
    const a = edges.faceA[e], b = edges.faceB[e];
    const d = n[a * 3] * n[b * 3] + n[a * 3 + 1] * n[b * 3 + 1] + n[a * 3 + 2] * n[b * 3 + 2];
    if (d < cosA) featureEdges++;
    const ang = (Math.acos(d > 1 ? 1 : d < -1 ? -1 : d) * 180) / Math.PI;
    // the shared edge: the two vertices both faces have in common
    for (let k = 0; k < 3; k++) {
      const v = index[a * 3 + k];
      if (v === index[b * 3] || v === index[b * 3 + 1] || v === index[b * 3 + 2]) {
        if (ang > maxDih[v]) maxDih[v] = ang;
      }
    }
  }
  return { maxDih, featureEdges };
}

/* ---------------------------------------------------------- normal filters */

/**
 * One bilateral pass on face normals. For face i the neighbours j of its
 * 1-ring contribute area · exp(-|c_j-c_i|²/2σs² - |g_j-g_i|²/2σr²), with a hard
 * cut: neighbours whose guidance normal differs by more than `cut` (chord
 * units) contribute nothing, so a crease is never averaged across. With
 * `snap` the guidance normals themselves are averaged.
 */
function bilateral(topo, fd, n, g, out, sigmaS, sigmaR, cut, gate, snap) {
  const src = snap ? g : n;
  const { T, nbStart, nbList } = topo;
  const { area, c } = fd;
  const ks = -0.5 / (sigmaS * sigmaS);
  const kr = -0.5 / (sigmaR * sigmaR);
  const cut2 = cut * cut;
  for (let i = 0; i < T; i++) {
    const i3 = i * 3;
    if ((gate && !gate[i]) || area[i] === 0) {
      out[i3] = n[i3];
      out[i3 + 1] = n[i3 + 1];
      out[i3 + 2] = n[i3 + 2];
      continue;
    }
    let sx = area[i] * src[i3], sy = area[i] * src[i3 + 1], sz = area[i] * src[i3 + 2];
    const gx = g[i3], gy = g[i3 + 1], gz = g[i3 + 2];
    const cx = c[i3], cy = c[i3 + 1], cz = c[i3 + 2];
    for (let p = nbStart[i]; p < nbStart[i + 1]; p++) {
      const j = nbList[p];
      const j3 = j * 3;
      if (area[j] === 0) continue;
      const ex = g[j3] - gx, ey = g[j3 + 1] - gy, ez = g[j3 + 2] - gz;
      const r2 = ex * ex + ey * ey + ez * ez;
      if (r2 > cut2) continue;
      const dx = c[j3] - cx, dy = c[j3 + 1] - cy, dz = c[j3 + 2] - cz;
      const w = area[j] * Math.exp(ks * (dx * dx + dy * dy + dz * dz) + kr * r2);
      sx += w * src[j3];
      sy += w * src[j3 + 1];
      sz += w * src[j3 + 2];
    }
    const l = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (l > 1e-12) {
      out[i3] = sx / l;
      out[i3 + 1] = sy / l;
      out[i3 + 2] = sz / l;
    } else {
      out[i3] = n[i3];
      out[i3 + 1] = n[i3 + 1];
      out[i3 + 2] = n[i3 + 2];
    }
  }
}

/**
 * Guidance normals for sharpening. Every face's patch (itself + 1-ring) gets
 * an area-weighted mean normal, a consistency score (resultant length, penalised
 * by the steepest step inside the patch) and a centroid. A face is "gated"
 * (allowed to sharpen) only when a markedly flatter patch – steps at most a
 * quarter of the steepest step in its 2-ring – lies within two rings: that is
 * what a rounded edge between two flat faces looks like, and what an isolated
 * curved surface never looks like. A gated face adopts the mean normal of the
 * most consistent candidate patch whose plane it can actually reach within the
 * displacement cap. Returns the gated fraction.
 */
function guidance(topo, fd, n, g, S, capFace, edgeStep, cut2) {
  const { T, nbStart, nbList } = topo;
  const { area, c } = fd;
  const { mean, rho, maxd, cc, m1, m2, b1, b2, gate, flat } = S;
  for (let i = 0; i < T; i++) {
    const i3 = i * 3;
    const ai = area[i];
    let sx = ai * n[i3], sy = ai * n[i3 + 1], sz = ai * n[i3 + 2], sa = ai;
    let cx = ai * c[i3], cy = ai * c[i3 + 1], cz = ai * c[i3 + 2];
    let md = 0;
    for (let p = nbStart[i]; p < nbStart[i + 1]; p++) {
      const j = nbList[p];
      const j3 = j * 3;
      const a = area[j];
      if (a === 0) continue;
      sx += a * n[j3];
      sy += a * n[j3 + 1];
      sz += a * n[j3 + 2];
      sa += a;
      cx += a * c[j3];
      cy += a * c[j3 + 1];
      cz += a * c[j3 + 2];
      const ex = n[j3] - n[i3], ey = n[j3 + 1] - n[i3 + 1], ez = n[j3 + 2] - n[i3 + 2];
      const d = ex * ex + ey * ey + ez * ez;
      if (d > md && d <= cut2) md = d; // steps across an already-sharp crease are not "roundness" to compare against
    }
    maxd[i] = md;
    // a patch is a plane to snap to only when no crease (a step steeper than the edge angle) runs through it
    let steep = edgeStep[i];
    for (let p = nbStart[i]; p < nbStart[i + 1]; p++) {
      const v = edgeStep[nbList[p]];
      if (v > steep) steep = v;
    }
    flat[i] = steep <= cut2 ? 1 : 0;
    const l = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (l > 1e-12 && sa > 0) {
      mean[i3] = sx / l;
      mean[i3 + 1] = sy / l;
      mean[i3 + 2] = sz / l;
      rho[i] = (l / sa) * (1 - 0.25 * md);
      cc[i3] = cx / sa;
      cc[i3 + 1] = cy / sa;
      cc[i3 + 2] = cz / sa;
    } else {
      mean[i3] = n[i3];
      mean[i3 + 1] = n[i3 + 1];
      mean[i3 + 2] = n[i3 + 2];
      rho[i] = 0;
      cc[i3] = c[i3];
      cc[i3 + 1] = c[i3 + 1];
      cc[i3 + 2] = c[i3 + 2];
    }
  }
  // steepest step within one and two rings
  for (let i = 0; i < T; i++) {
    let m = maxd[i];
    for (let p = nbStart[i]; p < nbStart[i + 1]; p++) {
      const v = maxd[nbList[p]];
      if (v > m) m = v;
    }
    m1[i] = m;
  }
  for (let i = 0; i < T; i++) {
    let m = m1[i];
    for (let p = nbStart[i]; p < nbStart[i + 1]; p++) {
      const v = m1[nbList[p]];
      if (v > m) m = v;
    }
    m2[i] = m;
    b1[i] = maxd[i] * 16 <= m && m > 0 ? 1 : 0; // this patch is at least four times flatter than its surroundings
  }
  for (let i = 0; i < T; i++) {
    let b = b1[i];
    for (let p = nbStart[i]; p < nbStart[i + 1] && !b; p++) b = b1[nbList[p]];
    b2[i] = b;
  }
  let gated = 0;
  for (let i = 0; i < T; i++) {
    let b = b2[i];
    for (let p = nbStart[i]; p < nbStart[i + 1] && !b; p++) b = b2[nbList[p]];
    gate[i] = b;
    const i3 = i * 3;
    if (!b) {
      g[i3] = n[i3];
      g[i3 + 1] = n[i3 + 1];
      g[i3 + 2] = n[i3 + 2];
      continue;
    }
    gated++;
    // the most consistent patch this face belongs to, among patches without a crease inside them:
    // a patch straddling an edge that is already sharp is not a plane to snap to
    let best = -1;
    let br = -1;
    if (flat[i]) {
      best = i;
      br = rho[i];
    }
    const cap = capFace[i];
    for (let p = nbStart[i]; p < nbStart[i + 1]; p++) {
      const j = nbList[p];
      if (!flat[j] || rho[j] <= br) continue;
      const j3 = j * 3;
      const dist = Math.abs(mean[j3] * (c[i3] - cc[j3]) + mean[j3 + 1] * (c[i3 + 1] - cc[j3 + 1]) + mean[j3 + 2] * (c[i3 + 2] - cc[j3 + 2]));
      if (dist > cap) continue; // the face could not be moved onto that patch's plane anyway
      br = rho[j];
      best = j;
    }
    if (best < 0) {
      g[i3] = n[i3];
      g[i3 + 1] = n[i3 + 1];
      g[i3 + 2] = n[i3 + 2];
      continue;
    }
    g[i3] = mean[best * 3];
    g[i3 + 1] = mean[best * 3 + 1];
    g[i3 + 2] = mean[best * 3 + 2];
  }
  return T ? gated / T : 0;
}

/** Flood-fill faces into regions whose target normals agree within `epsDeg` of the seed. */
function regions(topo, fd, n, epsDeg) {
  const { T, nbStart, nbList } = topo;
  const cosE = Math.cos((epsDeg * Math.PI) / 180);
  const label = new Int32Array(T).fill(-1);
  const stack = new Int32Array(T);
  let R = 0;
  for (let s = 0; s < T; s++) {
    if (label[s] >= 0) continue;
    if (fd.area[s] === 0) {
      label[s] = R++;
      continue;
    }
    const nx = n[s * 3], ny = n[s * 3 + 1], nz = n[s * 3 + 2];
    let top = 0;
    stack[top++] = s;
    label[s] = R;
    while (top) {
      const f = stack[--top];
      for (let p = nbStart[f]; p < nbStart[f + 1]; p++) {
        const g = nbList[p];
        if (label[g] >= 0 || fd.area[g] === 0) continue;
        if (n[g * 3] * nx + n[g * 3 + 1] * ny + n[g * 3 + 2] * nz >= cosE) {
          label[g] = R;
          stack[top++] = g;
        }
      }
    }
    R++;
  }
  return { label, R };
}

/**
 * Place `out = pos + scale·disp`, scaling back the displacement of the three
 * vertices of any triangle whose new normal would turn against its input
 * normal (dot below `flipDot` of its length) or collapse. Halve up to five
 * times, then freeze; the frozen set only grows, so this terminates with no
 * flips. Returns how many triangles were ever caught.
 */
function guardedPlace(index, n0, pos, disp, scale, out, flipDot) {
  const V = scale.length;
  const T = index.length / 3;
  let prevented = 0;
  scale.fill(1);
  for (let round = 0; round < 7; round++) {
    for (let v = 0; v < V; v++) {
      const s = scale[v];
      const v3 = v * 3;
      out[v3] = pos[v3] + s * disp[v3];
      out[v3 + 1] = pos[v3 + 1] + s * disp[v3 + 1];
      out[v3 + 2] = pos[v3 + 2] + s * disp[v3 + 2];
    }
    let bad = 0;
    const f = round < 5 ? 0.5 : 0;
    for (let t = 0; t < T; t++) {
      const t3 = t * 3;
      if (n0[t3] === 0 && n0[t3 + 1] === 0 && n0[t3 + 2] === 0) continue; // degenerate in the input: nothing to protect
      const a = index[t3] * 3, b = index[t3 + 1] * 3, k = index[t3 + 2] * 3;
      const ux = out[b] - out[a], uy = out[b + 1] - out[a + 1], uz = out[b + 2] - out[a + 2];
      const vx = out[k] - out[a], vy = out[k + 1] - out[a + 1], vz = out[k + 2] - out[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const dot = nx * n0[t3] + ny * n0[t3 + 1] + nz * n0[t3 + 2];
      if (!(dot > flipDot * l) || l === 0) {
        bad++;
        scale[index[t3]] *= f;
        scale[index[t3 + 1]] *= f;
        scale[index[t3 + 2]] *= f;
      }
    }
    if (!bad) break;
    prevented += bad;
  }
  return prevented;
}

/**
 * Move vertices so the faces take their target normals. Faces are grouped
 * into regions of (nearly) equal target normal; each region is a plane whose
 * offset is the area-weighted mean over the faces already lying in it (so
 * faces still being pulled in do not drag the plane). A vertex moves to the
 * area-weighted average of its projections onto its faces' planes, clamped to
 * its cap from the ORIGINAL position, with the flip guard.
 */
function fitToNormals(topo, index, pos0, pos, nTarget, n0, iterations, cap, stats, { epsDeg = 1, anchorDeg = 5, flipDot = 0.2 } = {}) {
  const { V, T, vfStart, vfList } = topo;
  const cosAnchor = Math.cos((anchorDeg * Math.PI) / 180);
  const fd = faceData(pos, index);
  const { label, R } = regions(topo, fd, nTarget, epsDeg);
  const rn = new Float64Array(R * 3);
  const ra = new Float64Array(R);
  const rd = new Float64Array(R);
  const rd0 = new Float64Array(R); // fallback plane: the target normal through the region's ORIGINAL centroid
  const ra0 = new Float64Array(R);
  for (let f = 0; f < T; f++) {
    const r = label[f];
    const a = fd.area[f];
    rn[r * 3] += a * nTarget[f * 3];
    rn[r * 3 + 1] += a * nTarget[f * 3 + 1];
    rn[r * 3 + 2] += a * nTarget[f * 3 + 2];
  }
  for (let r = 0; r < R; r++) {
    const l = Math.sqrt(rn[r * 3] ** 2 + rn[r * 3 + 1] ** 2 + rn[r * 3 + 2] ** 2);
    if (l > 0) {
      rn[r * 3] /= l;
      rn[r * 3 + 1] /= l;
      rn[r * 3 + 2] /= l;
    }
  }
  for (let f = 0; f < T; f++) {
    const r = label[f];
    const a = fd.area[f];
    if (a === 0) continue;
    rd0[r] += a * (rn[r * 3] * fd.c[f * 3] + rn[r * 3 + 1] * fd.c[f * 3 + 1] + rn[r * 3 + 2] * fd.c[f * 3 + 2]);
    ra0[r] += a;
  }
  for (let r = 0; r < R; r++) rd0[r] = ra0[r] > 0 ? rd0[r] / ra0[r] : 0;
  // only a group of at least three faces is a plane worth fitting; a face on its own (a facet of a coarse curved surface,
  // whose filtered normal no closed mesh could take) constrains nothing, so coarse curvature is never pulled into lumps
  const MIN_PLANE = 3;
  const faces = new Int32Array(R);
  for (let f = 0; f < T; f++) faces[label[f]]++;
  const disp = new Float64Array(V * 3);
  const scale = new Float64Array(V);
  const cand = new Float64Array(V * 3);
  let prevented = 0;
  let prevResidual = Infinity;
  for (let it = 0; it < iterations; it++) {
    rd.fill(0);
    ra.fill(0);
    let residual = 0; // how far the faces still are from their target normals
    for (let f = 0; f < T; f++) {
      const r = label[f];
      const a = fd.area[f];
      if (a === 0) continue;
      const agree = fd.n[f * 3] * rn[r * 3] + fd.n[f * 3 + 1] * rn[r * 3 + 1] + fd.n[f * 3 + 2] * rn[r * 3 + 2];
      if (faces[r] >= MIN_PLANE) residual += a * (1 - agree);
      if (agree >= cosAnchor) {
        rd[r] += a * (rn[r * 3] * fd.c[f * 3] + rn[r * 3 + 1] * fd.c[f * 3 + 1] + rn[r * 3 + 2] * fd.c[f * 3 + 2]);
        ra[r] += a;
      }
    }
    // targets a closed mesh cannot take (e.g. averaged facet normals of a coarse sphere) make the fit stall: stop rather than drift to the cap
    if (residual >= prevResidual * 0.995) break;
    prevResidual = residual;
    // a plane is defined by the faces already lying in it; until one does, by the target normal through its original centroid
    for (let r = 0; r < R; r++) rd[r] = ra[r] > 0 ? rd[r] / ra[r] : rd0[r];
    for (let v = 0; v < V; v++) {
      const v3 = v * 3;
      const px = pos[v3], py = pos[v3 + 1], pz = pos[v3 + 2];
      let sx = 0, sy = 0, sz = 0, sa = 0;
      for (let p = vfStart[v]; p < vfStart[v + 1]; p++) {
        const f = vfList[p];
        const a = fd.area[f];
        const r = label[f];
        if (a === 0 || faces[r] < MIN_PLANE) continue;
        const nx = rn[r * 3], ny = rn[r * 3 + 1], nz = rn[r * 3 + 2];
        const d = rd[r] - (nx * px + ny * py + nz * pz);
        sx += a * nx * d;
        sy += a * ny * d;
        sz += a * nz * d;
        sa += a;
      }
      if (sa > 0) {
        sx /= sa;
        sy /= sa;
        sz /= sa;
      } else {
        sx = sy = sz = 0;
      }
      // clamp the total displacement from the original position
      let tx = px + sx - pos0[v3], ty = py + sy - pos0[v3 + 1], tz = pz + sz - pos0[v3 + 2];
      const c = cap[v];
      const l = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (l > c) {
        const s = c / l;
        tx *= s;
        ty *= s;
        tz *= s;
      }
      disp[v3] = pos0[v3] + tx - px;
      disp[v3 + 1] = pos0[v3 + 1] + ty - py;
      disp[v3 + 2] = pos0[v3 + 2] + tz - pz;
    }
    prevented += guardedPlace(index, n0, pos, disp, scale, cand, flipDot);
    pos.set(cand);
    faceData(pos, index, fd);
    stats.iterations++;
  }
  stats.flipsPrevented += prevented;
  stats.regions = R;
}

/* ------------------------------------------------------------------ detail */

/** One umbrella step out = x + λ·(mean of neighbours − x) on a field of `stride` values per vertex. */
function umbrella(x, out, topo, lam, stride) {
  const { adjStart: start, adj, V } = topo;
  for (let v = 0; v < V; v++) {
    const s = start[v], e = start[v + 1];
    const n = e - s;
    const l = lam[v];
    if (n === 0 || l === 0) {
      for (let k = 0; k < stride; k++) out[v * stride + k] = x[v * stride + k];
      continue;
    }
    if (stride === 3) {
      let mx = 0, my = 0, mz = 0;
      for (let i = s; i < e; i++) {
        const j = adj[i] * 3;
        mx += x[j];
        my += x[j + 1];
        mz += x[j + 2];
      }
      out[v * 3] = x[v * 3] + l * (mx / n - x[v * 3]);
      out[v * 3 + 1] = x[v * 3 + 1] + l * (my / n - x[v * 3 + 1]);
      out[v * 3 + 2] = x[v * 3 + 2] + l * (mz / n - x[v * 3 + 2]);
    } else {
      let m = 0;
      for (let i = s; i < e; i++) m += x[adj[i]];
      out[v] = x[v] + l * (m / n - x[v]);
    }
  }
}

/** K umbrella passes (ping-pong buffers); returns a new array. */
function smoothField(x, topo, lam, K, stride, progress) {
  let a = Float64Array.from(x);
  let b = new Float64Array(a.length);
  for (let k = 0; k < K; k++) {
    umbrella(a, b, topo, lam, stride);
    [a, b] = [b, a];
    progress?.(k + 1, K);
  }
  return a;
}

/**
 * Mesh unsharp masking along vertex normals. `pos` is Float64 (current
 * positions); returns the signed displacement per vertex (mm, along `vn`)
 * before the flip guard, plus the vertex normals.
 */
function reliefDisplacement(pos, index, topo, { gain, featureSize, edgeAngle, cap, pin }, progress) {
  const { V, hv, hMean, diag, adjStart, adj } = topo;
  // vertex normals (area weighted) from the current positions
  const fd = faceData(pos, index);
  const vn = new Float64Array(V * 3);
  for (let t = 0; t < index.length / 3; t++) {
    const a2 = fd.area[t] * 2;
    for (let k = 0; k < 3; k++) {
      const v = index[t * 3 + k] * 3;
      vn[v] += a2 * fd.n[t * 3];
      vn[v + 1] += a2 * fd.n[t * 3 + 1];
      vn[v + 2] += a2 * fd.n[t * 3 + 2];
    }
  }
  const f = new Float64Array(V); // freedom: 1 = free, 0 = pinned
  for (let v = 0; v < V; v++) {
    const l = Math.sqrt(vn[v * 3] ** 2 + vn[v * 3 + 1] ** 2 + vn[v * 3 + 2] ** 2);
    if (l > 1e-30) {
      vn[v * 3] /= l;
      vn[v * 3 + 1] /= l;
      vn[v * 3 + 2] /= l;
      f[v] = pin[v];
    } else {
      vn[v * 3] = vn[v * 3 + 1] = vn[v * 3 + 2] = 0;
      f[v] = 0;
    }
  }
  // kernel size: featureSize in mm -> number of umbrella passes
  const F = featureSize > 0 ? featureSize : Math.max(5 * hMean, 0.01 * diag);
  const K = Math.max(2, Math.min(64, Math.round(0.5 * (F / hMean) ** 2)));
  const K0 = Math.max(1, Math.min(4, Math.round(K / 16)));
  const K2 = 2 * K;
  const Ke = Math.max(1, K >> 1);
  // ring size and its smoothed version normalise the step so the kernel is uniform in millimetres, not in edge counts
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
  const lamU = new Float64Array(V);
  for (let v = 0; v < V; v++) lamU[v] = 0.5 * f[v];
  const ringBar = smoothField(ring, topo, lamU, K2, 1);
  const lam = new Float64Array(V);
  for (let v = 0; v < V; v++) {
    const rho = ring[v] > 0 ? Math.max(0.5, Math.min(1.5, ringBar[v] / ring[v])) : 1;
    lam[v] = 0.5 * rho * f[v];
  }
  const total = 2 * K + 2 * (K0 + K2) + K2 + Ke;
  let done = 0;
  const tick = (k, n) => {
    if (k === n || k % 8 === 0) progress?.((done + k) / total);
  };
  // base shape and relief height (tangential drift of the umbrella is parametrisation noise, not relief)
  const q = smoothField(pos, topo, lam, K, 3, tick);
  done += K;
  const h = new Float64Array(V);
  for (let v = 0; v < V; v++) {
    h[v] = f[v] * ((pos[v * 3] - q[v * 3]) * vn[v * 3] + (pos[v * 3 + 1] - q[v * 3 + 1]) * vn[v * 3 + 1] + (pos[v * 3 + 2] - q[v * 3 + 2]) * vn[v * 3 + 2]);
  }
  // band-pass: cut vertex-scale noise and subtract the local mean (the curvature shrink of the base, so spheres keep
  // their radius). The umbrella also leaves a connectivity pattern on any smooth surface (irregular vertices sit deeper
  // in the base); it shows up identically when the operator is applied to the already-smooth base, so that is
  // band-passed the same way and subtracted: a perfectly smooth coarse sphere yields no relief, real relief survives
  // the first `cut` passes drop vertex-scale noise, which must not be amplified
  const bandPass = (x, cut) => {
    const lo = smoothField(x, topo, lam, cut, 1, tick);
    done += cut;
    const mean = smoothField(x, topo, lam, K2, 1, tick);
    done += K2;
    for (let v = 0; v < V; v++) lo[v] -= mean[v];
    return lo;
  };
  const r = bandPass(h, K0);
  // the proxy: the base with its shrink added back, i.e. the model without relief but at its own size
  const hm = smoothField(h, topo, lam, K2, 1, tick);
  done += K2;
  const proxy = new Float64Array(V * 3);
  for (let v = 0; v < V; v++) {
    proxy[v * 3] = q[v * 3] + hm[v] * vn[v * 3];
    proxy[v * 3 + 1] = q[v * 3 + 1] + hm[v] * vn[v * 3 + 1];
    proxy[v * 3 + 2] = q[v * 3 + 2] + hm[v] * vn[v * 3 + 2];
  }
  const proxyBase = smoothField(proxy, topo, lam, K, 3, tick);
  done += K;
  const hq = new Float64Array(V);
  for (let v = 0; v < V; v++) {
    hq[v] = f[v] * ((proxy[v * 3] - proxyBase[v * 3]) * vn[v * 3] + (proxy[v * 3 + 1] - proxyBase[v * 3 + 1]) * vn[v * 3 + 1] + (proxy[v * 3 + 2] - proxyBase[v * 3 + 2]) * vn[v * 3 + 2]);
  }
  const rq = bandPass(hq, K0);
  for (let v = 0; v < V; v++) r[v] -= rq[v];
  // coring: flat and smooth regions (tiny band-pass energy, in edge-length units) stay put
  const energy = new Float64Array(V);
  for (let v = 0; v < V; v++) energy[v] = r[v] * r[v];
  const em = smoothField(energy, topo, lam, Ke, 1, tick);
  const disp = new Float64Array(V);
  for (let v = 0; v < V; v++) {
    const A = Math.sqrt(Math.max(0, em[v])) / (hv[v] || 1);
    const mask = f[v] * smoothstep(0.02, 0.08, A);
    const raw = 2 * gain * mask * r[v]; // the operator-pattern subtraction also takes about half of the relief signal
    const c = cap[v];
    disp[v] = c > 0 && Number.isFinite(c) && Number.isFinite(raw) ? c * Math.tanh(raw / c) : 0; // soft cap: strictly below the cap, no flat 'mesa' tops
  }
  return { disp, vn, passes: total };
}

/** A mesh the filters can work on: whole triangles, indices into the vertex list, finite coordinates. */
function validateMesh(positions, index, V, T) {
  if (positions.length % 3 !== 0 || index.length % 3 !== 0) throw new Error('enhanceMesh: positions must hold 3 numbers per vertex and index 3 per triangle');
  for (let i = 0; i < index.length; i++) {
    const v = index[i];
    if (!(v >= 0 && v < V) || v !== Math.floor(v)) throw new Error(`enhanceMesh: triangle ${Math.floor(i / 3)} refers to vertex ${v}, which does not exist`);
  }
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new Error(`enhanceMesh: vertex ${Math.floor(i / 3)} has a non-finite coordinate`);
  }
  void T;
}

/* -------------------------------------------------------------------- main */

/**
 * Enhance a welded, indexed, closed triangle mesh. Positions only change;
 * the index is kept. See the module comment for the operations.
 *
 * @param {{ positions: Float32Array|Float64Array, index: Uint32Array }} mesh
 * @param {{ sharpen?: number, detail?: number, smooth?: number, edgeAngle?: number, featureSize?: number, maxMove?: number }} options amounts 0..1, angle in degrees, sizes in mm (0 = auto)
 * @param {(stage: string, fraction: number) => void} [onProgress]
 * @returns {{ positions: Float32Array, stats: { verticesMoved: number, maxDisplacement: number, meanDisplacement: number, flipsPrevented: number, featureEdges: number, iterations: number } }}
 */
export function enhanceMesh(mesh, options = {}, onProgress) {
  const o = { ...ENHANCE_DEFAULTS, ...options };
  const sharpen = clamp01(+o.sharpen || 0);
  const smooth = clamp01(+o.smooth || 0);
  const detail = clamp01(+o.detail || 0);
  const edgeAngle = Math.min(150, Math.max(5, +o.edgeAngle || 30));
  const featureSize = Number.isFinite(+o.featureSize) ? Math.max(0, +o.featureSize) : 0;
  const maxMove = Number.isFinite(+o.maxMove) ? Math.max(0, +o.maxMove) : 0;
  const index = mesh.index;
  const V = mesh.positions.length / 3;
  const T = index.length / 3;
  const stats = { verticesMoved: 0, maxDisplacement: 0, meanDisplacement: 0, flipsPrevented: 0, featureEdges: 0, iterations: 0 };
  const identity = () => ({ positions: mesh.positions instanceof Float32Array ? mesh.positions.slice() : Float32Array.from(mesh.positions), stats });
  if (!(sharpen > 0 || smooth > 0 || detail > 0) || V === 0 || T === 0) return identity();
  validateMesh(mesh.positions, index, V, T);
  const report = (stage, fraction) => onProgress?.(stage, Math.min(1, Math.max(0, fraction)));

  report('Analysing the surface', 0);
  const pos0 = Float64Array.from(mesh.positions);
  const topo = buildTopology(pos0, index);
  const fd0 = faceData(pos0, index);
  const n0 = fd0.n.slice(); // the flip reference: input face normals
  const edges = pairEdges(index, V);
  const h = topo.hMean;
  // the budget every vertex may move, shared by all operations
  const cap = new Float64Array(V);
  for (let v = 0; v < V; v++) cap[v] = maxMove > 0 ? maxMove : CAP_FACTOR * (topo.hv[v] || h);
  // vertices on boundary or non-manifold edges never move
  for (let v = 0; v < V; v++) if (edges.open[v]) cap[v] = 0;
  report('Analysing the surface', 0.08);

  let pos = pos0.slice();

  /** Pins for the relief boost: vertices on creases (judged on the current geometry) and on open edges never move. */
  const pinsFor = (fd) => {
    const { maxDih } = dihedrals(edges, index, fd.n, edgeAngle, V);
    const pin = new Float64Array(V);
    for (let v = 0; v < V; v++) pin[v] = edges.open[v] ? 0 : 1 - smoothstep(0.75 * edgeAngle, edgeAngle, maxDih[v]);
    return pin;
  };
  /** Apply a relief displacement (along the vertex normals) with the flip guard, from the current positions. */
  const applyRelief = (fdNow, { disp, vn }, flipDot) => {
    const vec = new Float64Array(V * 3);
    for (let v = 0; v < V; v++) {
      vec[v * 3] = disp[v] * vn[v * 3];
      vec[v * 3 + 1] = disp[v] * vn[v * 3 + 1];
      vec[v * 3 + 2] = disp[v] * vn[v * 3 + 2];
    }
    const scale = new Float64Array(V);
    const out = new Float64Array(V * 3);
    stats.flipsPrevented += guardedPlace(index, fdNow.n, pos, vec, scale, out, flipDot);
    pos = out;
  };

  if (smooth > 0 || sharpen > 0) {
    const fdS = fd0;
    const tmp = new Float64Array(T * 3);
    const cut = chord(edgeAngle);
    const sigmaR = cut / 2;
    const sigmaS = featureSize > 0 ? featureSize : 1.5 * h;
    const stopCos = Math.cos((0.5 * Math.PI) / 180);
    let cur = fd0.n.slice();
    let nxt = tmp;
    let nSmooth = null; // the normals after smoothing only, for a partial sharpen amount
    const turned = () => {
      for (let i = 0; i < T * 3; i += 3) if (cur[i] * nxt[i] + cur[i + 1] * nxt[i + 1] + cur[i + 2] * nxt[i + 2] < stopCos) return true;
      return false;
    };
    if (smooth > 0) {
      // more iterations for a wider feature size: iterating a 1-ring filter approximates a wider kernel
      const extra = featureSize > 2 * h ? Math.min(6, Math.round(featureSize / h) - 2) : 0;
      const K = Math.round(2 + 4 * smooth) + extra;
      const sigmaRs = sigmaR * (0.3 + 0.7 * smooth);
      for (let k = 0; k < K; k++) {
        bilateral(topo, fd0, cur, cur, nxt, sigmaS, sigmaRs, cut, null, false);
        const more = turned();
        [cur, nxt] = [nxt, cur];
        stats.iterations++;
        report('Smoothing bumps', 0.1 + (0.2 * (k + 1)) / K);
        if (!more) break;
      }
      if (sharpen > 0 && sharpen < 1) nSmooth = cur.slice();
    }
    if (sharpen > 0) {
      const g = new Float64Array(T * 3);
      const S = {
        mean: new Float64Array(T * 3), rho: new Float64Array(T), maxd: new Float64Array(T), cc: new Float64Array(T * 3),
        m1: new Float64Array(T), m2: new Float64Array(T), b1: new Uint8Array(T), b2: new Uint8Array(T), gate: new Uint8Array(T), flat: new Uint8Array(T),
      };
      const capFace = new Float64Array(T);
      for (let f = 0; f < T; f++) capFace[f] = (cap[index[f * 3]] + cap[index[f * 3 + 1]] + cap[index[f * 3 + 2]]) / 3;
      const edgeStep = new Float64Array(T); // steepest step (chord²) between a face and the faces across its edges
      const K = 8;
      for (let k = 0; k < K; k++) {
        edgeStep.fill(0);
        for (let e = 0; e < edges.count; e++) {
          const a = edges.faceA[e] * 3, b = edges.faceB[e] * 3;
          const ex = cur[a] - cur[b], ey = cur[a + 1] - cur[b + 1], ez = cur[a + 2] - cur[b + 2];
          const d = ex * ex + ey * ey + ez * ez;
          if (d > edgeStep[edges.faceA[e]]) edgeStep[edges.faceA[e]] = d;
          if (d > edgeStep[edges.faceB[e]]) edgeStep[edges.faceB[e]] = d;
        }
        guidance(topo, fdS, cur, g, S, capFace, edgeStep, cut * cut);
        bilateral(topo, fdS, cur, g, nxt, sigmaS, sigmaR, cut, S.gate, true);
        const more = turned();
        [cur, nxt] = [nxt, cur];
        stats.iterations++;
        report('Sharpening edges', 0.3 + (0.2 * (k + 1)) / K);
        if (!more) break;
      }
    }
    report('Fitting the surface', 0.5);
    fitToNormals(topo, index, pos0, pos, cur, n0, 10, cap, stats);
    if (sharpen > 0 && sharpen < 1) {
      // a partial amount is a fraction of the way from the smoothed-only result to the fully sharpened one, re-checked for flips
      let from = pos0;
      if (nSmooth) {
        from = pos0.slice();
        fitToNormals(topo, index, pos0, from, nSmooth, n0, 10, cap, stats);
      }
      const disp = new Float64Array(V * 3);
      for (let i = 0; i < V * 3; i++) disp[i] = from[i] - pos0[i] + sharpen * (pos[i] - from[i]);
      const scale = new Float64Array(V);
      const out = new Float64Array(V * 3);
      stats.flipsPrevented += guardedPlace(index, n0, pos0, disp, scale, out, 0.2);
      pos = out;
    }
    report('Fitting the surface', 0.6);
  }

  if (detail > 0) {
    // creases (sharp edges in the current, possibly just sharpened geometry) are pinned so relief boosting never rings across them
    const fdNow = faceData(pos, index);
    const relief = reliefDisplacement(pos, index, topo, { gain: 2.5 * detail, featureSize, edgeAngle, cap, pin: pinsFor(fdNow) }, (f) => report('Boosting relief', 0.6 + 0.3 * f));
    stats.iterations += relief.passes;
    applyRelief(fdNow, relief, 0.05);
  }

  // shared budget: the total movement of a vertex never exceeds its cap, and the result has no flipped triangle
  report('Checking triangles', 0.92);
  const total = new Float64Array(V * 3);
  for (let v = 0; v < V; v++) {
    const v3 = v * 3;
    let dx = pos[v3] - pos0[v3], dy = pos[v3 + 1] - pos0[v3 + 1], dz = pos[v3 + 2] - pos0[v3 + 2];
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const c = cap[v];
    if (l > c) {
      const s = c > 0 ? c / l : 0;
      dx *= s;
      dy *= s;
      dz *= s;
    }
    total[v3] = dx;
    total[v3 + 1] = dy;
    total[v3 + 2] = dz;
  }
  const scale = new Float64Array(V);
  const final = new Float64Array(V * 3);
  stats.flipsPrevented += guardedPlace(index, n0, pos0, total, scale, final, 0.05);

  // statistics
  let moved = 0;
  let maxD = 0;
  let sumD = 0;
  for (let v = 0; v < V; v++) {
    const v3 = v * 3;
    const d = Math.sqrt((final[v3] - pos0[v3]) ** 2 + (final[v3 + 1] - pos0[v3 + 1]) ** 2 + (final[v3 + 2] - pos0[v3 + 2]) ** 2);
    if (d > 1e-4 * h) moved++;
    if (d > maxD) maxD = d;
    sumD += d;
  }
  stats.verticesMoved = moved;
  stats.maxDisplacement = maxD;
  stats.meanDisplacement = V ? sumD / V : 0;
  const fdFinal = faceData(final, index);
  stats.featureEdges = dihedrals(edges, index, fdFinal.n, edgeAngle, V).featureEdges;
  report('Checking triangles', 1);
  return { positions: Float32Array.from(final), stats };
}
