import { buildTopology, faceData, pairEdges, smoothField } from './enhance.js';

/**
 * The "base" of a mesh: its surface smoothed at a scale larger than the
 * details standing on it, so that berries, leaves and the like are gone
 * while the shape they stand on remains. Plain smoothing also shrinks a
 * curved surface; that bias varies slowly, so it is taken as the local mean
 * of the raw height over a window far larger than any detail and removed,
 * and the base of a plain cane is the cane itself.
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
  const F = featureSize > 0 ? featureSize : Math.max(10 * hMean, 0.15 * diag);
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
  const h = new Float64Array(V);
  for (let v = 0; v < V; v++) {
    h[v] = (pos[v * 3] - q[v * 3]) * normals[v * 3] + (pos[v * 3 + 1] - q[v * 3 + 1]) * normals[v * 3 + 1] + (pos[v * 3 + 2] - q[v * 3 + 2]) * normals[v * 3 + 2];
  }
  // smoothing also pulls a curved surface inwards, by an amount that varies slowly with the curvature: that bias is
  // the local mean of the raw height over a window far larger than any detail, which details themselves barely move.
  // The mean is weighted by area (the smoothed height-times-area over the smoothed area), so that a detail meshed
  // much more densely than what it stands on does not sway it
  const passes = Math.min(4 * K, 2400);
  const weighted = smoothField(Float64Array.from(h, (x, v) => x * areas[v]), topo, lam, passes, 1);
  const weight = smoothField(areas, topo, lam, passes, 1);
  const base = new Float64Array(V * 3);
  const height = new Float64Array(V);
  for (let v = 0; v < V; v++) {
    const bias = weight[v] > 1e-12 ? weighted[v] / weight[v] : 0;
    height[v] = h[v] - bias;
    base[v * 3] = pos[v * 3] - height[v] * normals[v * 3];
    base[v * 3 + 1] = pos[v * 3 + 1] - height[v] * normals[v * 3 + 1];
    base[v * 3 + 2] = pos[v * 3 + 2] - height[v] * normals[v * 3 + 2];
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
 *   (0: automatic, 15 % of the model's extent)
 * @param {number} [options.minHeight]    details lower than this are ignored, mm (0: automatic)
 * @param {number} [options.maxCount]     at most this many details, the tallest first (default 400)
 * @returns {{ details: Detail[], featureSize: number, threshold: number }}
 *   Detail = { id, kind: 'round' | 'other', center, normal, radius, size, height, crest, sag, vertices, roundness, walls,
 *     footLevel, direction, length, width, middle, lobes, lobeDirection, elongation }
 *   where `center` is the fitted sphere's centre (round) or the region's centroid (other), `normal` the
 *   base surface direction there, `radius` the fitted radius (round) or half the region's extent (other),
 *   `height` how far the detail stands above the smoothed base (an underestimate for low relief) and `crest` how
 *   far its top stands above its foot, `sag` how far the surface under it falls away across its footprint, and
 *   `direction`/`length`/`width`/`middle`/`lobes`/`lobeDirection`/`elongation` the shape of its footprint
 *   (see describeShape), all in the mesh's own frame.
 */
export function findDetails(mesh, { featureSize = 0, minHeight = 0, maxCount = 400, trace = null } = {}) {
  const pos = Float64Array.from(mesh.positions);
  const index = mesh.index;
  const V = pos.length / 3;
  const T = index.length / 3;
  if (V < 4 || T < 4) return { details: [], featureSize: 0, threshold: 0 };
  const { normals: vn, height: r, areas: va, base, topo, featureSize: F } = baseSurface(mesh, { featureSize, pinBorder: false });
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
        // the edge's vertices are the two the faces share
        for (let k = 0; k < 3; k++) {
          const v = index[a + k];
          if (index[b] === v || index[b + 1] === v || index[b + 2] === v) sharp[v] = 1;
        }
      }
    }
  }

  // concave vertices: where the surface turns up around them (the mean of the neighbours lies above the tangent
  // plane) by more than a slight angle per edge, smoothed a little so vertex noise counts less – the foot of a
  // detail, where its flank meets the surface it stands on, is such a ring
  const concave = new Uint8Array(V);
  {
    const conc = new Float64Array(V);
    for (let v = 0; v < V; v++) {
      const s0 = adjStart[v], e0 = adjStart[v + 1];
      if (e0 === s0) continue;
      let mx = 0, my = 0, mz = 0;
      for (let i = s0; i < e0; i++) {
        const j = adj[i] * 3;
        mx += pos[j];
        my += pos[j + 1];
        mz += pos[j + 2];
      }
      const n0 = e0 - s0;
      conc[v] = (mx / n0 - pos[v * 3]) * vn[v * 3] + (my / n0 - pos[v * 3 + 1]) * vn[v * 3 + 1] + (mz / n0 - pos[v * 3 + 2]) * vn[v * 3 + 2];
    }
    const half = new Float64Array(V).fill(0.5);
    const smooth = smoothField(conc, topo, half, 1, 1);
    const limit = 0.03 * topo.hMean;
    for (let v = 0; v < V; v++) if (smooth[v] > limit) concave[v] = 1;
  }

  // threshold: clearly above the noise of the surface, and a fair fraction of the feature scale. The noise is
  // measured away from creases: the smoothing rounds every edge of the body off, and the heights that leaves
  // along them are not the surface's noise
  const nearCrease = new Uint8Array(V);
  {
    const rings = Math.max(1, Math.min(40, Math.ceil((0.5 * F) / topo.hMean)));
    let front = [];
    for (let v = 0; v < V; v++) if (sharp[v]) { nearCrease[v] = 1; front.push(v); }
    for (let ring = 0; ring < rings && front.length; ring++) {
      const next = [];
      for (const v of front) {
        for (let i = adjStart[v]; i < adjStart[v + 1]; i++) {
          const o = adj[i];
          if (nearCrease[o]) continue;
          nearCrease[o] = 1;
          next.push(o);
        }
      }
      front = next;
    }
  }
  let plain = [];
  for (let v = 0; v < V; v++) if (!nearCrease[v]) plain.push(r[v]);
  if (plain.length < 0.2 * V) plain = Array.from(r);
  const sorted = Float64Array.from(plain).sort();
  const median = sorted[sorted.length >> 1];
  const dev = Float64Array.from(plain, (x) => Math.abs(x - median)).sort();
  const mad = dev[dev.length >> 1] * 1.4826;
  const high = Math.max(minHeight, 0.025 * F, median + 4 * mad);
  const low = median + 0.25 * (high - median);

  // regions: grow from the clearly-raised vertices over everything moderately raised, then on down each detail's
  // flanks while the height keeps falling, to the foot where the surrounding surface begins (the smoothed base
  // lifts under a detail, so its lower flanks read as low or even sunken, yet they are the detail's)
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
    // down the flanks, by geometric height above the core's foot (the smoothed height is unreliable there: the
    // base lifts under a detail): a breadth-first growth to neighbours lower than where it came from, not below the
    // foot, so the detail is taken whole down to where the surrounding surface begins and no further
    let nx = 0, ny = 0, nz = 0, sx = 0, sy = 0, sz = 0;
    for (const v of members) {
      nx += vn[v * 3] * va[v];
      ny += vn[v * 3 + 1] * va[v];
      nz += vn[v * 3 + 2] * va[v];
      sx += pos[v * 3];
      sy += pos[v * 3 + 1];
      sz += pos[v * 3 + 2];
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    const N = [nx / nl, ny / nl, nz / nl];
    sx /= members.length; sy /= members.length; sz /= members.length;
    const g = (v) => pos[v * 3] * N[0] + pos[v * 3 + 1] * N[1] + pos[v * 3 + 2] * N[2];
    const bases = Float64Array.from(members, (v) => base[v * 3] * N[0] + base[v * 3 + 1] * N[1] + base[v * 3 + 2] * N[2]).sort();
    const foot = bases[Math.floor(0.1 * (bases.length - 1))];
    let crest = 0;
    for (const v of members) crest = Math.max(crest, g(v) - foot);
    const floor = foot - 0.5 * crest;
    // how far the flanks can run: a little beyond the core, and out by a fair part of the height they come down
    let coreFar = 0;
    for (const v of members) coreFar = Math.max(coreFar, (pos[v * 3] - sx) ** 2 + (pos[v * 3 + 1] - sy) ** 2 + (pos[v * 3 + 2] - sz) ** 2);
    const reach2 = Math.min(0.75 * F, 1.25 * Math.sqrt(coreFar) + 0.6 * crest) ** 2;
    const coreCount = members.length;
    const coreSize = 2 * Math.sqrt(coreFar);
    const step = Math.max(1e-6, 0.002 * crest);
    const flat = Math.cos((12 * Math.PI) / 180); // a flank slopes; the surface around (plate or gently curved) does not
    for (let i = 0; i < members.length; i++) {
      const v = members[i];
      const gv = g(v);
      for (let k = adjStart[v]; k < adjStart[v + 1]; k++) {
        const o = adj[k];
        if (label[o] >= 0 || concave[o]) continue; // the foot ring is where the detail ends
        const go = g(o);
        if (go >= gv - step || go < floor) continue;
        if (vn[o * 3] * N[0] + vn[o * 3 + 1] * N[1] + vn[o * 3 + 2] * N[2] > flat) continue;
        if ((pos[o * 3] - sx) ** 2 + (pos[o * 3 + 1] - sy) ** 2 + (pos[o * 3 + 2] - sz) ** 2 > reach2) continue;
        label[o] = id;
        members.push(o);
      }
    }
    members.coreCount = coreCount;
    members.coreSize = coreSize;
    regions.push(members);
  }

  // a region that rings a hollow – the rim around a dent or a hole, which stands above the sunken base too – is not a
  // detail: what a detail's region encloses is raised as well. The flood beyond a region's neighbour stops at the
  // region; one that stays small is what the region encloses, and the region goes if that lies, on average, below
  // the level of the region's own foot along the region's direction (judging each vertex along its own normal would
  // not do: a thin fin's flanks read as sunken that way, and a bowl's steep walls as hardly sunken at all)
  const sunken = median - (high - median);
  const mark = new Int32Array(V).fill(-1);
  const queue = new Int32Array(V);
  const enclosesHollow = (members, id, N, level) => {
    const cap = 4 * members.length + 50;
    const patch = Math.max(6, 0.03 * members.length);
    for (const m of members) {
      for (let i = adjStart[m]; i < adjStart[m + 1]; i++) {
        const u = adj[i];
        if (label[u] === id || mark[u] === id) continue;
        let head = 0, tail = 0, depth = 0, outside = false;
        queue[tail++] = u;
        mark[u] = id;
        while (head < tail) {
          const v = queue[head++];
          depth += pos[v * 3] * N[0] + pos[v * 3 + 1] * N[1] + pos[v * 3 + 2] * N[2] - level;
          if (tail > cap) {
            outside = true;
            break;
          }
          for (let k = adjStart[v]; k < adjStart[v + 1]; k++) {
            const w = adj[k];
            if (label[w] === id || mark[w] === id) continue;
            mark[w] = id;
            queue[tail++] = w;
          }
        }
        if (!outside && head >= patch && depth / head < sunken) {
          trace?.({ reason: 'hollow', flood: head, depth: depth / head, sunken, start: [pos[u * 3], pos[u * 3 + 1], pos[u * 3 + 2]], level });
          return true;
        }
      }
    }
    return false;
  };

  const details = [];
  for (let id = 0; id < regions.length; id++) {
    const members = regions[id];
    if (members.length < 6) continue; // vertex-scale noise
    // the region's direction: its area-weighted mean normal
    let nx = 0, ny = 0, nz = 0;
    for (const v of members) {
      nx += vn[v * 3] * va[v];
      ny += vn[v * 3 + 1] * va[v];
      nz += vn[v * 3 + 2] * va[v];
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    const normal = [nx / nl, ny / nl, nz / nl];
    const alongN = (arr, v) => arr[v * 3] * normal[0] + arr[v * 3 + 1] * normal[1] + arr[v * 3 + 2] * normal[2];
    // the foot level: where the surface the region stands on runs, along the region's direction (a low percentile
    // of the members' base points, since the base under a detail's flanks lies off to the side)
    const rim = [];
    const rimVerts = [];
    for (const v of members) {
      for (let i = adjStart[v]; i < adjStart[v + 1]; i++) if (label[adj[i]] !== id) { rim.push(alongN(pos, v)); rimVerts.push(v); break; }
    }
    rim.sort((a, b) => a - b);
    const along = Float64Array.from(members, (v) => alongN(base, v)).sort();
    // the foot level: where the region's rim runs (the growth stopped at the foot), or failing a rim, the low end of
    // the members' base points
    const footLevel = rim.length >= 3 ? rim[rim.length >> 1] : along[Math.floor(0.1 * (along.length - 1))];
    // how far the surface under the detail falls away across its footprint (a curved body): from how far the
    // surface's normals at the lower half of the rim lean away from the region's direction (on a body of radius R,
    // a rim point `a` from the middle leans by a/R and lies a·sin(lean)/2 below the tangent plane)
    let sag = 0;
    const sagSize = 1; // scaled by the real size once that is known
    if (rimVerts.length >= 3) {
      const cut = rim[rim.length >> 1];
      const leans = [];
      for (const v of rimVerts) {
        if (alongN(pos, v) > cut) continue;
        leans.push(Math.acos(Math.max(-1, Math.min(1, vn[v * 3] * normal[0] + vn[v * 3 + 1] * normal[1] + vn[v * 3 + 2] * normal[2]))));
      }
      leans.sort((a, b) => a - b);
      const lean = leans.length ? Math.min(Math.PI / 3, leans[Math.floor(0.9 * (leans.length - 1))]) : 0;
      sag = 0.5 * (sagSize / 2) * Math.sin(lean);
    }
    // the detail's body: what stands above the foot, leaving out any surrounding surface the growth ran onto; a
    // growth that ran away (far beyond the clearly raised core, down a coarse or noisy surface) is dropped back to
    // the core
    let crest = 0;
    for (const v of members) crest = Math.max(crest, alongN(pos, v) - footLevel);
    let body = members.filter((v) => alongN(pos, v) - footLevel > 0.03 * crest);
    {
      let bx = 0, by = 0, bz = 0;
      for (const v of body) { bx += pos[v * 3]; by += pos[v * 3 + 1]; bz += pos[v * 3 + 2]; }
      bx /= body.length || 1; by /= body.length || 1; bz /= body.length || 1;
      let bodyFar = 0;
      for (const v of body) bodyFar = Math.max(bodyFar, (pos[v * 3] - bx) ** 2 + (pos[v * 3 + 1] - by) ** 2 + (pos[v * 3 + 2] - bz) ** 2);
      if (2 * Math.sqrt(bodyFar) > 1.6 * members.coreSize) body = members.slice(0, members.coreCount);
    }
    if (body.length < 6) continue;
    let cx = 0, cy = 0, cz = 0, area = 0, height = 0, walls = 0, creased = 0;
    for (const v of body) {
      creased += sharp[v];
      cx += pos[v * 3];
      cy += pos[v * 3 + 1];
      cz += pos[v * 3 + 2];
      area += va[v];
      if (r[v] > height) height = r[v];
      // a region that turns the corner of the body (the end of a cylinder, the edge of a block, rounded off by the
      // smoothing) has walls in it; a detail standing on the surface does not, round ones excepted (see below)
      if (vn[v * 3] * normal[0] + vn[v * 3 + 1] * normal[1] + vn[v * 3 + 2] * normal[2] < 0.34) walls++;
    }
    const n = body.length;
    cx /= n;
    cy /= n;
    cz /= n;
    let far = 0;
    for (const v of body) {
      const d = (pos[v * 3] - cx) ** 2 + (pos[v * 3 + 1] - cy) ** 2 + (pos[v * 3 + 2] - cz) ** 2;
      if (d > far) far = d;
    }
    const size = 2 * Math.sqrt(far);
    if (rimVerts.length >= 3) sag *= size / 2 / Math.max(1e-9, sagSize / 2);
    const drop = (reason) => trace?.({ reason, size, height, n, area, far, walls: walls / n, center: [cx, cy, cz] });
    if (size < 0.15 * F || size > 1.5 * F) { drop(size < 0.15 * F ? 'tiny' : 'too large'); continue; }
    if (area < 0.12 * Math.PI * far) { drop('thin'); continue; } // long and thin: the rim of an edge, not a detail (a star covers 0.4 of its circle)
    if (height < 0.04 * size) { drop('low'); continue; } // broad and very low: not something standing on the surface
    if (height < 1.25 * high) { drop('faint'); continue; } // barely over the threshold: noise, the edge of a dent
    if (enclosesHollow(members, id, normal, footLevel)) { drop('rings a hollow'); continue; }
    // the rim of a dent need not ring it whole to stand above the sunken base: a region with a fair share of its
    // neighbours well below its foot (deeper than half its own height, and below the noise) is beside a hollow
    {
      let beside = 0, around = 0;
      const deep = Math.min(sunken, -0.5 * height);
      for (const v of members) {
        for (let i = adjStart[v]; i < adjStart[v + 1]; i++) {
          const o = adj[i];
          if (label[o] === id) continue;
          around++;
          if (alongN(pos, o) - footLevel < deep) beside++;
        }
      }
      if (around && beside > 0.2 * around) { drop('beside a hollow'); continue; }
    }
    const fit = fitSphere(pos, body);
    let kind = 'other';
    let center = [cx, cy, cz];
    let radius = size / 2;
    let roundness = NaN;
    if (fit) {
      roundness = fit.rms / fit.radius;
      const coverage = area / (4 * Math.PI * fit.radius * fit.radius);
      // round: a tight fit, a radius in keeping with the extent, a fair share of the sphere covered, and standing
      // a fair part of that radius proud of the base (the rounded end of a body fits a big sphere but barely rises)
      if (roundness < 0.08 && fit.radius > 0.35 * size && fit.radius < 1.1 * size && coverage > 0.2 && height > 0.35 * fit.radius) {
        kind = 'round';
        center = fit.center;
        radius = fit.radius;
      }
    }
    // the end of the body – a cylinder's cap, the edge of a block, rounded off by the smoothing – is large, has a
    // sharp crease running most of the way round it and turns the corner into the body's walls; a detail with walls
    // of its own (an upright fin) is small, a creased leaf has no walls
    if (kind !== 'round' && size > 0.8 * F && creased > 0.3 * ((Math.PI * size) / topo.hMean) && walls > 0.25 * n) { drop('end of the body'); continue; }
    const shape = describeShape(pos, body, normal, [cx, cy, cz]);
    // the footprint at the foot: the whole region's extent along the body's direction (the body stops short of it)
    const foot = describeShape(pos, members, normal, [cx, cy, cz], shape.direction);
    details.push({ id, kind, center, normal, radius, size, height, crest, sag, vertices: n, roundness, walls: walls / n, footLevel, ...shape, footLength: foot.length, footWidth: foot.width, footMiddle: foot.middle });
  }
  details.sort((a, b) => b.height - a.height);
  return { details: details.slice(0, maxCount), featureSize: F, threshold: high };
}

/**
 * The shape of a region's body in the plane of its base: the principal
 * direction (a unit vector in the mesh's frame, along the base), the extent
 * along it (`length`) and across it (`width`), the mid-point of those
 * extents (`middle`, where a clean part of that length and width sits), and
 * the lobes of its outline: the number of peaks of the radial profile around
 * the middle, each at least a fifth of the mean radius proud of its dips – a
 * five-point star has 5, a rosette its petals, a leaf 2 (its tips), a berry
 * or dome 0 or 1.
 */
function describeShape(pos, body, N, centroid, fixedDirection = null) {
  // a frame in the base plane
  const a = Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = a[1] * N[2] - a[2] * N[1], uy = a[2] * N[0] - a[0] * N[2], uz = a[0] * N[1] - a[1] * N[0];
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  const vx = N[1] * uz - N[2] * uy, vy = N[2] * ux - N[0] * uz, vz = N[0] * uy - N[1] * ux;
  const n = body.length;
  const px = new Float64Array(n), py = new Float64Array(n);
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const v = body[i];
    const dx = pos[v * 3] - centroid[0], dy = pos[v * 3 + 1] - centroid[1], dz = pos[v * 3 + 2] - centroid[2];
    px[i] = dx * ux + dy * uy + dz * uz;
    py[i] = dx * vx + dy * vy + dz * vz;
    sxx += px[i] * px[i];
    sxy += px[i] * py[i];
    syy += py[i] * py[i];
  }
  // principal direction of the in-plane covariance (or the direction given)
  let theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  if (fixedDirection) theta = Math.atan2(fixedDirection[0] * vx + fixedDirection[1] * vy + fixedDirection[2] * vz, fixedDirection[0] * ux + fixedDirection[1] * uy + fixedDirection[2] * uz);
  const c = Math.cos(theta), s = Math.sin(theta);
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (let i = 0; i < n; i++) {
    const along = px[i] * c + py[i] * s;
    const across = -px[i] * s + py[i] * c;
    if (along < minA) minA = along;
    if (along > maxA) maxA = along;
    if (across < minB) minB = across;
    if (across > maxB) maxB = across;
  }
  const length = maxA - minA, width = maxB - minB;
  const midA = (minA + maxA) / 2, midB = (minB + maxB) / 2;
  // back to the mesh frame
  const dir = [c * ux + s * vx, c * uy + s * vy, c * uz + s * vz];
  const mx = midA * c - midB * s, my = midA * s + midB * c; // the middle in the (u, v) frame
  const middle = [centroid[0] + mx * ux + my * vx, centroid[1] + mx * uy + my * vy, centroid[2] + mx * uz + my * vz];
  // the radial profile around the middle: the outline's farthest reach per angular bin
  const BINS = 36;
  const profile = new Float64Array(BINS);
  for (let i = 0; i < n; i++) {
    const x = px[i] - mx, y = py[i] - my;
    const bin = (Math.floor(((Math.atan2(y, x) + Math.PI) / (2 * Math.PI)) * BINS) + BINS) % BINS;
    const rr = Math.hypot(x, y);
    if (rr > profile[bin]) profile[bin] = rr;
  }
  // smooth once, then count peaks a fifth of the mean radius proud of the dips either side
  const sm = new Float64Array(BINS);
  let mean = 0;
  for (let b = 0; b < BINS; b++) {
    sm[b] = 0.25 * profile[(b + BINS - 1) % BINS] + 0.5 * profile[b] + 0.25 * profile[(b + 1) % BINS];
    mean += sm[b] / BINS;
  }
  let lobes = 0;
  for (let b = 0; b < BINS; b++) {
    const here = sm[b];
    if (here <= sm[(b + BINS - 1) % BINS] || here < sm[(b + 1) % BINS]) continue; // not a peak
    // the dips: the lowest value before the next peak either way
    let dipL = here, dipR = here;
    for (let k = 1; k < BINS / 2; k++) {
      const l = sm[(b + BINS - k) % BINS], rgt = sm[(b + k) % BINS];
      if (l < dipL) dipL = l;
      if (rgt < dipR) dipR = rgt;
      if (l > here || rgt > here) break;
    }
    if (here - Math.max(dipL, dipR) > 0.2 * mean) lobes++;
  }
  const lobeAngle = (() => {
    let best = 0, bb = -1;
    for (let b = 0; b < BINS; b++) if (sm[b] > best) { best = sm[b]; bb = b; }
    return bb < 0 ? 0 : ((bb + 0.5) / BINS) * 2 * Math.PI - Math.PI; // where the outline reaches farthest, in the (u, v) frame
  })();
  const lobeDir = [Math.cos(lobeAngle) * ux + Math.sin(lobeAngle) * vx, Math.cos(lobeAngle) * uy + Math.sin(lobeAngle) * vy, Math.cos(lobeAngle) * uz + Math.sin(lobeAngle) * vz];
  return { direction: dir, length, width, middle, lobes, lobeDirection: lobeDir, elongation: width > 1e-9 ? length / width : 1 };
}

/**
 * Fit the round details' spheres again to another mesh of the same surface –
 * the model itself, when the details were found on a lightened copy whose
 * vertices lie a little off the surface. Each sphere is refitted to the
 * vertices within a band around it, the band narrowing with each pass, so
 * the surrounding surface drops out of the fit. Details are updated in
 * place; a fit that drifts away from the found one is left as it was.
 * @param {Array<{ kind: string, center: number[], radius: number }>} details
 * @param {Float32Array|Float64Array} positions
 */
export function refitSpheres(details, positions) {
  const round = details.filter((d) => d.kind === 'round');
  if (!round.length) return;
  const V = positions.length / 3;
  // a grid of the vertices, cells as large as the biggest sphere's reach
  const cell = Math.max(1e-6, 1.5 * Math.max(...round.map((d) => d.radius)));
  const grid = new Map();
  const keyOf = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let v = 0; v < V; v++) {
    const k = keyOf(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(v);
  }
  for (const d of round) {
    let { center, radius } = d;
    const found = { center, radius };
    let ok = true;
    for (const band of [0.25, 0.12, 0.08]) {
      const members = [];
      const reach = radius * (1 + band);
      const i0 = Math.floor((center[0] - reach) / cell), i1 = Math.floor((center[0] + reach) / cell);
      const j0 = Math.floor((center[1] - reach) / cell), j1 = Math.floor((center[1] + reach) / cell);
      const k0 = Math.floor((center[2] - reach) / cell), k1 = Math.floor((center[2] + reach) / cell);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          for (let k = k0; k <= k1; k++) {
            const list = grid.get(`${i},${j},${k}`);
            if (!list) continue;
            for (const v of list) {
              const dist = Math.hypot(positions[v * 3] - center[0], positions[v * 3 + 1] - center[1], positions[v * 3 + 2] - center[2]);
              if (Math.abs(dist - radius) <= band * radius) members.push(v);
            }
          }
        }
      }
      const fit = members.length >= 12 ? fitSphere(positions, members) : null;
      if (!fit || fit.rms > 0.1 * fit.radius) {
        ok = false;
        break;
      }
      center = fit.center;
      radius = fit.radius;
    }
    // the refit stays with what was found: a sphere that wandered off or changed size a lot is not the same detail
    const drift = Math.hypot(center[0] - found.center[0], center[1] - found.center[1], center[2] - found.center[2]);
    if (!ok || drift > 0.3 * found.radius || radius < 0.7 * found.radius || radius > 1.3 * found.radius) continue;
    d.center = center;
    d.radius = radius;
  }
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
