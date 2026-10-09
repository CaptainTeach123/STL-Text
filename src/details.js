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
  const F = featureSize > 0 ? featureSize : Math.max(10 * hMean, Math.max(6, Math.min(40, 0.03 * diag)));
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
 *   (0: automatic, 3 % of the model's extent, between 6 and 40 mm)
 * @param {number} [options.minHeight]    details lower than this are ignored, mm (0: automatic)
 * @param {number} [options.maxCount]     at most this many details, the tallest first (default 400)
 * @returns {{ details: Detail[], featureSize: number, threshold: number }}
 *   Detail = { id, kind: 'round' | 'rosette' | 'other', center, normal, radius, size, height, crest, sag, vertices, roundness,
 *     walls, source, footLevel, direction, length, width, middle, lobes, lobeDirection, elongation, footLength, footWidth,
 *     footMiddle, crumple? }
 *   where `center` is the fitted sphere's centre (round) or the region's centroid (other), `normal` the
 *   base surface direction there, `radius` the fitted radius (round) or half the region's extent (other),
 *   `height` how far the detail stands above the smoothed base (an underestimate for low relief) and `crest` how
 *   far its top stands above its foot, `sag` how far the surface under it falls away across its footprint,
 *   `source` where its direction came from ('ground' round it, the 'plane' of its base, or its own 'facets'),
 *   `direction`/`length`/`width`/`middle`/`lobes`/`lobeDirection`/`elongation` the shape of its footprint
 *   (see describeShape), all in the mesh's own frame, and `crumple` how crumpled it is once crumpleOf has run.
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
  // The noise is the vertex-to-vertex roughness of the heights (how far each differs from the mean of its
  // neighbours), not their spread: on a richly modelled body the heights above the smoothed base swing by
  // millimetres over its ridges and mouldings, which are not noise, while the smudge of a generated surface is
  let plainIdx = [];
  for (let v = 0; v < V; v++) if (!nearCrease[v]) plainIdx.push(v);
  if (plainIdx.length < 0.2 * V) plainIdx = Array.from({ length: V }, (_, v) => v);
  const sorted = Float64Array.from(plainIdx, (v) => r[v]).sort();
  const median = sorted[sorted.length >> 1];
  const rough = new Float64Array(plainIdx.length);
  for (let i = 0; i < plainIdx.length; i++) {
    const v = plainIdx[i];
    const s0 = adjStart[v], e0 = adjStart[v + 1];
    if (e0 === s0) continue;
    let m = 0;
    for (let k = s0; k < e0; k++) m += r[adj[k]];
    rough[i] = Math.abs(r[v] - m / (e0 - s0));
  }
  const roughSorted = Float64Array.from(rough).sort();
  const mad = roughSorted[roughSorted.length >> 1] * 1.4826 * 2; // the roughness of a height over a few vertices
  const high = Math.max(minHeight, 0.025 * F, median + 4 * mad);
  const low = median + 0.25 * (high - median);

  // regions: grow from the clearly-raised vertices over everything moderately raised, then on down each detail's
  // flanks while the height keeps falling, to the foot where the surrounding surface begins (the smoothed base
  // lifts under a detail, so its lower flanks read as low or even sunken, yet they are the detail's)
  const label = new Int32Array(V).fill(-1);
  // the plane through a ring of vertices (a region's rim, a core's boundary): its normal, unoriented, and
  // centroid, or null when the ring is too small or not flat enough to give a direction
  const planeOf = (verts) => {
    if (verts.length < 12) return null;
    let mx = 0, my = 0, mz = 0;
    for (const v of verts) { mx += pos[v * 3]; my += pos[v * 3 + 1]; mz += pos[v * 3 + 2]; }
    mx /= verts.length; my /= verts.length; mz /= verts.length;
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (const v of verts) {
      const dx = pos[v * 3] - mx, dy = pos[v * 3 + 1] - my, dz = pos[v * 3 + 2] - mz;
      xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz;
    }
    const eig = smallestEigen([xx, xy, xz, yy, yz, zz]);
    if (!eig || eig.value >= 0.3 * eig.middle) return null;
    return { normal: eig.vector, centroid: [mx, my, mz], spread: Math.sqrt(eig.middle / verts.length) };
  };
  // the surface round a set of vertices: the normals of the ground within the feature scale of them – vertices
  // outside the set not standing proud (the moat the smoothing leaves round a tall detail is ground, and so is the
  // low flank of a neighbouring region; a berry's undercut, which the growth leaves outside, stands proud and is
  // not) – averaged: their mean direction, how many there were, and how far they agree (1 when every normal
  // agrees, small round a region that wraps round the body)
  const groundSeen = new Int32Array(V).fill(-1);
  let groundStamp = 0;
  const groundRings = Math.max(6, Math.ceil(F / topo.hMean));
  const groundAround = (ring, isInside) => {
    groundStamp++;
    let gx = 0, gy = 0, gz = 0, ga = 0, count = 0;
    let frontier = ring;
    for (let hop = 0; hop < groundRings && frontier.length && count < 48; hop++) {
      const next = [];
      for (const v of frontier) {
        for (let i = adjStart[v]; i < adjStart[v + 1]; i++) {
          const o = adj[i];
          if (isInside(o) || groundSeen[o] === groundStamp) continue;
          groundSeen[o] = groundStamp;
          next.push(o);
          if (r[o] > high) continue;
          gx += vn[o * 3] * va[o]; gy += vn[o * 3 + 1] * va[o]; gz += vn[o * 3 + 2] * va[o];
          ga += va[o];
          count++;
        }
      }
      frontier = next;
    }
    const gl = Math.hypot(gx, gy, gz);
    return { normal: gl > 1e-12 ? [gx / gl, gy / gl, gz / gl] : null, count, coherence: ga > 0 ? gl / ga : 0 };
  };
  // the direction a core stands on, the surest way available: the ground round it, when there is enough and it
  // agrees (the surface a detail stands on faces one way round its foot); else the axis of the plane through the
  // core's boundary ring, turned the way the ground or the core's own normals say; else the core's own normals
  // averaged (a star's facets lean every way round its axis and average to it, a berry's top to its direction –
  // though a tall spiky detail's flanks cancel out and say little)
  const directionOf = (core, inCore) => {
    const ring = [];
    let sx = 0, sy = 0, sz = 0, nx = 0, ny = 0, nz = 0, area = 0;
    for (const v of core) {
      sx += pos[v * 3]; sy += pos[v * 3 + 1]; sz += pos[v * 3 + 2];
      nx += vn[v * 3] * va[v]; ny += vn[v * 3 + 1] * va[v]; nz += vn[v * 3 + 2] * va[v];
      area += va[v];
      for (let i = adjStart[v]; i < adjStart[v + 1]; i++) if (!inCore(adj[i])) { ring.push(v); break; }
    }
    sx /= core.length || 1; sy /= core.length || 1; sz /= core.length || 1;
    const fl = Math.hypot(nx, ny, nz);
    const facets = fl > 1e-12 ? [nx / fl, ny / fl, nz / fl] : null;
    const facetAgreement = area > 0 ? fl / area : 0;
    const ground = groundAround(ring, inCore);
    const plane = planeOf(ring);
    if (trace && core.length > 300) trace({ reason: 'direction', n: core.length, ring: ring.length, centroid: [+sx.toFixed(1), +sy.toFixed(1), +sz.toFixed(1)], facets: facets?.map((x) => +x.toFixed(2)), facetAgreement: +facetAgreement.toFixed(2), ground: { count: ground.count, coherence: +ground.coherence.toFixed(2), normal: ground.normal?.map((x) => +x.toFixed(2)) }, plane: plane && { axis: plane.normal.map((x) => +x.toFixed(2)), centroid: plane.centroid.map((x) => +x.toFixed(1)), spread: +plane.spread.toFixed(1) } });
    if (ground.count >= 12 && ground.coherence >= 0.6) return { normal: ground.normal, source: 'ground', ground };
    if (plane) {
      const axis = plane.normal;
      const onGround = ground.normal ? axis[0] * ground.normal[0] + axis[1] * ground.normal[1] + axis[2] * ground.normal[2] : 0;
      const onFacets = facets ? axis[0] * facets[0] + axis[1] * facets[1] + axis[2] * facets[2] : 0;
      const side = (sx - plane.centroid[0]) * axis[0] + (sy - plane.centroid[1]) * axis[1] + (sz - plane.centroid[2]) * axis[2];
      // which way along the axis: the ground's way when the ground agrees with itself, else the way the core's own
      // normals lean when they agree, else the ground's anyway, else towards the core's middle
      const sign = ground.count >= 6 && ground.coherence >= 0.5 && Math.abs(onGround) >= 0.3 ? onGround
        : facetAgreement >= 0.2 && Math.abs(onFacets) >= 0.3 ? onFacets
        : ground.count >= 6 && Math.abs(onGround) >= 0.3 ? onGround
        : side;
      const flip = sign < 0 ? -1 : 1;
      return { normal: [flip * axis[0], flip * axis[1], flip * axis[2]], source: 'plane', ground };
    }
    if (ground.count >= 6) return { normal: ground.normal, source: 'ground', ground };
    return { normal: facets ?? [0, 0, 1], source: 'facets', ground };
  };
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
    // the way the core faces
    const N = directionOf(members, (o) => label[o] === id).normal;
    let sx = 0, sy = 0, sz = 0;
    for (const v of members) {
      sx += pos[v * 3];
      sy += pos[v * 3 + 1];
      sz += pos[v * 3 + 2];
    }
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
    // (the core of a big star is its creases: its facets between them are filled in, out to a little beyond the
    // core; a core far larger than any detail is a ridge network of the body, taken with no more than its flanks)
    const coreR = Math.sqrt(coreFar);
    const reach2 = Math.min(coreR <= 1.5 * F ? Math.max(0.75 * F, 1.1 * coreR) : 0.75 * F, 1.25 * coreR + 0.6 * crest) ** 2;
    const coreCount = members.length;
    const coreSize = 2 * Math.sqrt(coreFar);
    const step = Math.max(1e-6, 0.002 * crest);
    const flat = Math.cos((12 * Math.PI) / 180); // a flank slopes; the surface around (plate or gently curved) does not
    // (within the core's own footprint the growth also climbs: the middle of a big star stands above the creases
    // round it that the smoothing picked out, and is the star's)
    const inside2 = Math.min(0.8 * coreR, F) ** 2;
    for (let i = 0; i < members.length; i++) {
      const v = members[i];
      const gv = g(v);
      for (let k = adjStart[v]; k < adjStart[v + 1]; k++) {
        const o = adj[k];
        if (label[o] >= 0 || concave[o]) continue; // the foot ring is where the detail ends
        const go = g(o);
        if (go < floor) continue;
        const d2 = (pos[o * 3] - sx) ** 2 + (pos[o * 3 + 1] - sy) ** 2 + (pos[o * 3 + 2] - sz) ** 2;
        if (go >= gv - step && !(d2 < inside2 && go > gv + 0.15 * topo.hMean)) continue;
        const facing = vn[o * 3] * N[0] + vn[o * 3 + 1] * N[1] + vn[o * 3 + 2] * N[2];
        if (facing > flat && go < gv) continue;
        if (facing < -0.5) continue; // the far side of an edge or ridge of the body the detail stands near: never its flank
        if (d2 > reach2) continue;
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
        if (!outside && head >= patch) {
          // sunken: the rim around a dent or a hole; level or raised and large: the rim of a plateau (the sharp edge
          // of a cap or a block, rounded off by the smoothing) – a detail never surrounds a patch of the surface
          const verdict = depth / head < sunken ? 'rings a hollow' : head >= 0.3 * members.length ? 'rims a plateau' : null;
          if (verdict) {
            trace?.({ reason: 'hollow', flood: head, depth: depth / head, sunken, verdict, start: [pos[u * 3], pos[u * 3 + 1], pos[u * 3 + 2]], level });
            return verdict;
          }
          // a smaller patch at the region's level or above is part of the detail (the middle of a big star, which
          // the smoothing hardly raises): the region takes it in
          for (let i = 0; i < head; i++) { label[queue[i]] = id; members.push(queue[i]); }
        } else if (!outside) {
          for (let i = 0; i < head; i++) { label[queue[i]] = id; members.push(queue[i]); }
        }
      }
    }
    return null;
  };

  // a region's frame: its direction (area-weighted mean normal) and the level of its foot along it (where its rim
  // runs – the growth stopped at the foot – or failing a rim, the low end of the members' base points)
  const inCore = new Int32Array(V).fill(-1);
  let coreStamp = 0;
  const frameOf = (members, id) => {
    // the direction of the surface the region stands on: the normals of the ground just outside it – the surface
    // round its foot, at the base's own level (not the detail's flanks, which lean every way, nor its undercut, which
    // the growth may have left outside and which stands well off the base); the ground round a region that wraps
    // round the body (a ridge spiralling round it) faces every way, and its mean comes out short
    const rimVerts = [];
    for (const v of members) {
      for (let i = adjStart[v]; i < adjStart[v + 1]; i++) if (label[adj[i]] !== id) { rimVerts.push(v); break; }
    }
    // the direction the region stands on, from its core (see directionOf); how far the ground round it agrees
    // tells a compact detail from a region that wraps round the body
    const coreCount = members.coreCount > 0 ? Math.min(members.length, members.coreCount) : members.length;
    coreStamp++;
    for (let i = 0; i < coreCount; i++) inCore[members[i]] = coreStamp;
    const faced = directionOf(members.slice(0, coreCount), (o) => inCore[o] === coreStamp);
    const normal = faced.normal;
    const coherence = faced.ground.count >= 6 ? faced.ground.coherence : faced.source === 'plane' ? 1 : 0.5;
    const found = faced.ground.count;
    const under = faced.source;
    const alongN = (arr, v) => arr[v * 3] * normal[0] + arr[v * 3 + 1] * normal[1] + arr[v * 3 + 2] * normal[2];
    const rim = rimVerts.map((v) => alongN(pos, v)).sort((a, b) => a - b);
    const along = Float64Array.from(members, (v) => alongN(base, v)).sort();
    const footLevel = rim.length >= 3 ? rim[rim.length >> 1] : along[Math.floor(0.1 * (along.length - 1))];
    return { normal, alongN, rim, rimVerts, footLevel, coherence, ground: found, source: under, coreCount };
  };

  // a region that rings or borders a hollow is judged whole, before it is split into the details that touch: the
  // rim around a dent only reads as a ring when it is one region
  const besideHollow = (members, id, alongN, footLevel, height) => {
    let beside = 0, around = 0;
    const deep = Math.min(sunken, -1.2 * height);
    for (const v of members) {
      for (let i = adjStart[v]; i < adjStart[v + 1]; i++) {
        const o = adj[i];
        if (label[o] === id) continue;
        around++;
        if (alongN(pos, o) - footLevel < deep) beside++;
      }
    }
    return around > 0 && beside > 0.3 * around;
  };
  for (let id = 0; id < regions.length; id++) {
    const members = regions[id];
    if (members.length < 6) continue;
    const { normal, alongN, footLevel } = frameOf(members, id);
    let height = 0;
    for (const v of members) if (r[v] > height) height = r[v];
    members.verdict = enclosesHollow(members, id, normal, footLevel) ?? (besideHollow(members, id, alongN, footLevel, height) ? 'beside a hollow' : null);
  }

  // details that touch (a star against a sprig, berries in a cluster) grow into one region: each region is split
  // at the saddles between its height peaks – a watershed from the peaks down, basins merging where the saddle
  // between them is high (a leaf's spikes, a star's points), staying apart where it is low (two details)
  const basin = new Int32Array(V).fill(-1);
  const splitRegion = (members, id) => {
    {
      // only a region larger than one detail could be is split (a detail of its own stays whole, smudge and all)
      let ext = 0;
      if (members.length >= 24) {
        // (the extent of the region: the diagonal of its bounding box)
        let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (const v of members) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pos[v * 3 + k]); mx[k] = Math.max(mx[k], pos[v * 3 + k]); }
        ext = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
      }
      if (members.length < 24 || ext < 1.2 * F) return null;
      // the watershed runs on the geometric height above the region's foot (the smoothed height is pulled down
      // under a detail's middle, which would make two peaks of one star)
      const { normal, alongN, footLevel, coherence, source } = frameOf(members, id);
      const gh = new Map();
      // a region wrapping round the body (a ridge spiralling round it) has no one direction: its smoothed height
      // serves instead
      // (only a region with no sure direction – none from its base plane or the ground – that is long enough to
      // wrap round the body is taken to)
      const wraps = source === 'facets' && coherence < 0.4 && ext > 3 * F;
      for (const v of members) gh.set(v, wraps ? r[v] - median : alongN(pos, v) - footLevel);
      const sortedMembers = members.slice().sort((a, b) => gh.get(b) - gh.get(a));
      // raw basins: each vertex, from the highest down, joins the basin of its highest neighbour already placed, or
      // starts one at a peak
      const peaks = [];
      for (const v of sortedMembers) {
        let best = -1, bestG = -Infinity;
        for (let i = adjStart[v]; i < adjStart[v + 1]; i++) {
          const o = adj[i];
          if (label[o] !== label[v] || basin[o] < 0) continue;
          const g0 = gh.get(o);
          if (g0 > bestG) { bestG = g0; best = basin[o]; }
        }
        if (best < 0) { best = peaks.length; peaks.push(gh.get(v)); }
        basin[v] = best;
      }
      // each basin's size, peak and footprint shape in the plane of the region's base: a long thin basin is a
      // ridge of the body (a moulding, a rib) that a detail happens to touch, never part of it
      const B = peaks.length;
      const count = new Int32Array(B);
      const sx = new Float64Array(B), sy = new Float64Array(B), sxx = new Float64Array(B), sxy = new Float64Array(B), syy = new Float64Array(B);
      const ax = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const ux = [ax[1] * normal[2] - ax[2] * normal[1], ax[2] * normal[0] - ax[0] * normal[2], ax[0] * normal[1] - ax[1] * normal[0]];
      const ul = Math.hypot(...ux) || 1;
      ux[0] /= ul; ux[1] /= ul; ux[2] /= ul;
      const uy = [normal[1] * ux[2] - normal[2] * ux[1], normal[2] * ux[0] - normal[0] * ux[2], normal[0] * ux[1] - normal[1] * ux[0]];
      for (const v of members) {
        const b = basin[v];
        const x = pos[v * 3] * ux[0] + pos[v * 3 + 1] * ux[1] + pos[v * 3 + 2] * ux[2];
        const y = pos[v * 3] * uy[0] + pos[v * 3 + 1] * uy[1] + pos[v * 3 + 2] * uy[2];
        count[b]++; sx[b] += x; sy[b] += y; sxx[b] += x * x; sxy[b] += x * y; syy[b] += y * y;
      }
      const structure = new Uint8Array(B);
      for (let b = 0; b < B; b++) {
        if (count[b] < 24) continue;
        const n0 = count[b];
        const cxx = sxx[b] / n0 - (sx[b] / n0) ** 2, cxy = sxy[b] / n0 - (sx[b] / n0) * (sy[b] / n0), cyy = syy[b] / n0 - (sy[b] / n0) ** 2;
        const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
        const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
        const l1 = tr / 2 + disc, l2 = Math.max(1e-12, tr / 2 - disc);
        const length = 4 * Math.sqrt(Math.max(0, l1));
        if (Math.sqrt(l1 / l2) > 3 && length > 0.8 * F) structure[b] = 1;
      }
      // the saddles between adjacent basins: the highest point along their shared border
      const saddles = new Map();
      for (const v of members) {
        const bv = basin[v];
        for (let i = adjStart[v]; i < adjStart[v + 1]; i++) {
          const o = adj[i];
          if (label[o] !== label[v] || basin[o] === bv) continue;
          const key = bv < basin[o] ? bv * B + basin[o] : basin[o] * B + bv;
          const h0 = Math.min(gh.get(v), gh.get(o));
          if (!(saddles.get(key) >= h0)) saddles.set(key, h0);
        }
      }
      // basins merge across their highest saddles first: two that share a saddle a fair part of the lower peak are
      // one detail (a leaf's spikes, a star's points); a ridge of the body never merges into a detail; a few
      // vertices of noise join whatever they lean on
      const parent = Array.from({ length: B }, (_, i) => i);
      const peakOf = Float64Array.from(peaks);
      const sizeOf = Int32Array.from(count);
      const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      const tinyLimit = Math.max(6, Math.min(40, 0.02 * members.length));
      const pairs = [...saddles.entries()].map(([key, h0]) => ({ a: Math.floor(key / B), b: key % B, h: h0 })).sort((p, q) => q.h - p.h);
      for (const { a, b, h: h0 } of pairs) {
        const ra = find(a), rb = find(b);
        if (ra === rb) continue;
        const tinyA = sizeOf[ra] < tinyLimit, tinyB = sizeOf[rb] < tinyLimit;
        if (!tinyA && !tinyB && (structure[ra] || structure[rb])) continue;
        if (!tinyA && !tinyB && h0 <= 0.55 * Math.min(peakOf[ra], peakOf[rb])) continue;
        // merge the lower into the higher
        const [hi, lo] = peakOf[ra] >= peakOf[rb] ? [ra, rb] : [rb, ra];
        parent[lo] = hi;
        sizeOf[hi] += sizeOf[lo];
        if (structure[lo] && sizeOf[lo] >= tinyLimit) structure[hi] = 1;
      }
      if (trace && members.length > 1000) {
        const info = [];
        for (let b = 0; b < B; b++) if (count[b] >= 24) info.push({ b, root: find(b), n: count[b], peak: +peakOf[b].toFixed(1), structure: structure[b] });
        trace({ reason: 'basins', id, n: members.length, raw: B, big: info, merged: new Set(info.map((i) => i.root)).size, coherence, normal, footLevel });
      }
      for (const v of members) basin[v] = find(basin[v]);
      const byBasin = new Map();
      for (const v of members) {
        const b = basin[v];
        if (!byBasin.has(b)) byBasin.set(b, []);
        byBasin.get(b).push(v);
      }
      if (byBasin.size === 1) return null;
      // small basins (a few vertices of noise) join the largest neighbouring one
      const parts = [...byBasin.values()].sort((a, b) => b.length - a.length);
      const keepers = parts.filter((p) => p.length >= Math.max(6, 0.04 * members.length));
      if (keepers.length <= 1) return null;
      trace?.({ reason: 'split', n: members.length, pieces: keepers.length, sizes: keepers.map((k) => k.length) });
      const keeperOf = new Map();
      keepers.forEach((p, i) => p.forEach((v) => keeperOf.set(v, i)));
      for (const p of parts) {
        if (keepers.includes(p)) continue;
        // the keeper most of its boundary touches, else the largest
        const votes = new Map();
        for (const v of p) for (let i = adjStart[v]; i < adjStart[v + 1]; i++) { const k = keeperOf.get(adj[i]); if (k !== undefined) votes.set(k, (votes.get(k) ?? 0) + 1); }
        let to = 0, most = -1;
        for (const [k, n] of votes) if (n > most) { most = n; to = k; }
        keepers[to].push(...p);
        p.forEach((v) => keeperOf.set(v, to));
      }
      // a detail standing on a ridge of the body floods down the ridge into one long basin: the part of such a
      // basin standing well above its ridge, when it is compact, is the detail; the ridge itself is left
      const shapeOf = (verts) => {
        let n0 = 0, mx = 0, my = 0, xx = 0, xy = 0, yy = 0;
        for (const v of verts) {
          const x = pos[v * 3] * ux[0] + pos[v * 3 + 1] * ux[1] + pos[v * 3 + 2] * ux[2];
          const y = pos[v * 3] * uy[0] + pos[v * 3 + 1] * uy[1] + pos[v * 3 + 2] * uy[2];
          n0++; mx += x; my += y; xx += x * x; xy += x * y; yy += y * y;
        }
        const cxx = xx / n0 - (mx / n0) ** 2, cxy = xy / n0 - (mx / n0) * (my / n0), cyy = yy / n0 - (my / n0) ** 2;
        const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
        const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
        return { elongation: Math.sqrt((tr / 2 + disc) / Math.max(1e-12, tr / 2 - disc)), length: 4 * Math.sqrt(Math.max(0, tr / 2 + disc)) };
      };
      for (let i = 0; i < keepers.length; i++) {
        const p = keepers[i];
        const root = basin[p[0]];
        if (!structure[root]) continue;
        const peak = peakOf[root];
        const inPiece = new Set(p);
        let top = p[0];
        for (const v of p) if (gh.get(v) > gh.get(top)) top = v;
        for (const frac of [0.45, 0.6, 0.75]) {
          const cut = frac * peak;
          const comp = [top];
          const seen = new Set(comp);
          for (let k = 0; k < comp.length; k++) {
            const v = comp[k];
            for (let j = adjStart[v]; j < adjStart[v + 1]; j++) {
              const o = adj[j];
              if (seen.has(o) || !inPiece.has(o) || gh.get(o) < cut) continue;
              seen.add(o);
              comp.push(o);
            }
          }
          if (comp.length < 24) break;
          const sh = shapeOf(comp);
          if (sh.elongation < 2.5) {
            // the detail: its upper part grown back down to its foot while the height keeps falling, within the piece
            const grown = comp.slice();
            const inGrown = new Set(grown);
            for (let k = 0; k < grown.length; k++) {
              const v = grown[k];
              for (let j = adjStart[v]; j < adjStart[v + 1]; j++) {
                const o = adj[j];
                if (inGrown.has(o) || !inPiece.has(o) || gh.get(o) >= gh.get(v) || gh.get(o) < 0.25 * cut) continue;
                inGrown.add(o);
                grown.push(o);
              }
            }
            if (shapeOf(grown).elongation < 2.5) { keepers[i] = grown; grown.detail = true; } else { keepers[i] = comp; comp.detail = true; }
            break;
          }
        }
      }
      // a piece counts only when it stands clearly above the saddles to its neighbours (its prominence): the
      // uneven top of a cap or a band splits into basins that are no details, and are left to the whole region
      const pieces = [];
      for (const p of keepers) {
        const root = basin[p[0]];
        let maxSaddle = -Infinity;
        for (const { a, b, h: h0 } of pairs) {
          const ra = find(a), rb = find(b);
          if (ra === rb || (ra !== root && rb !== root)) continue;
          if (h0 > maxSaddle) maxSaddle = h0;
        }
        const prominence = Number.isFinite(maxSaddle) ? peakOf[root] - maxSaddle : peakOf[root];
        if (prominence < Math.max(0.3 * peakOf[root], 0.05 * F)) continue;
        const piece = p.slice();
        piece.coreCount = piece.length;
        piece.coreSize = members.coreSize;
        piece.verdict = members.verdict;
        piece.structure = !!structure[root] && !p.detail;
        pieces.push(piece);
      }
      return pieces;
    }
  };


  const details = [];
  const evaluate = (members, id) => {
    if (members.length < 6) return null; // vertex-scale noise
    if (members.structure) { trace?.({ reason: 'structure', n: members.length }); return null; } // a ridge of the body, split off a detail
    const { normal, alongN, rim, rimVerts, footLevel, ground, source } = frameOf(members, id);
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
    if (body.length < 6) return null;
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
    // the surface just outside the region: at the end of the body it turns down into the body's wall
    let outside = 0, outsideWalls = 0;
    for (const v of members) {
      for (let i = adjStart[v]; i < adjStart[v + 1]; i++) {
        const o = adj[i];
        if (label[o] === id) continue;
        outside++;
        if (vn[o * 3] * normal[0] + vn[o * 3 + 1] * normal[1] + vn[o * 3 + 2] * normal[2] < 0.34) outsideWalls++;
      }
    }
    let far = 0;
    for (const v of body) {
      const d = (pos[v * 3] - cx) ** 2 + (pos[v * 3 + 1] - cy) ** 2 + (pos[v * 3 + 2] - cz) ** 2;
      if (d > far) far = d;
    }
    const size = 2 * Math.sqrt(far);
    if (rimVerts.length >= 3) sag *= size / 2 / Math.max(1e-9, sagSize / 2);
    const drop = (reason) => {
      members.lastDrop = reason;
      trace?.({ reason, size, height, n, area, far, walls: walls / n, edge: outside ? outsideWalls / outside : 0, center: [cx, cy, cz], normal, ground, source, footLevel, crest, members: members.length, id });
      return null;
    };
    if (size < 0.15 * F) return drop('tiny');
    if (size > 3.5 * F) return drop('too large');
    const shape = describeShape(pos, body, normal, [cx, cy, cz]);
    // larger than a detail usually is: only a compact footprint (a big star, a big rosette) can be one; a long one
    // is a stretch of the body (the rim of an end, a moulding)
    if (size > 1.5 * F && shape.elongation > 1.6) return drop('too large');
    if (area < 0.12 * Math.PI * far) return drop('thin'); // long and thin: the rim of an edge, not a detail (a star covers 0.4 of its circle)
    if (crest < 0.07 * size) return drop('low'); // broad and very low: not something standing on the surface
    if (height < 1.25 * high || crest < 0.05 * F) return drop('faint'); // barely over the threshold, or hardly standing up at this scale: noise, the edge of a dent
    if (members.verdict) return drop(members.verdict); // rings or borders a hollow (judged on the whole region)
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
      if (roundness < 0.08 && fit.radius > 0.35 * size && fit.radius < 1.1 * size && coverage > 0.2 && crest > 0.35 * fit.radius) {
        kind = 'round';
        center = fit.center;
        radius = fit.radius;
      }
    }
    // a flat round disc with a worked top (radial petals, a wheel) that no sphere fits: a rosette
    if (kind === 'other' && shape.elongation < 1.3 && (shape.lobes < 4 || (shape.lobes < 5 && crest < 0.12 * size)) && crest < 0.2 * size && !(fit && roundness < 0.08 && fit.radius < 1.1 * size)) kind = 'rosette';
    // the footprint at the foot: the whole region's extent along the body's direction (the body stops short of it)
    const foot = describeShape(pos, members, normal, [cx, cy, cz], shape.direction);
    return { id, kind, center, normal, radius, size, height, crest, sag, vertices: n, roundness, walls: walls / n, source, footLevel, ...shape, footLength: foot.length, footWidth: foot.width, footMiddle: foot.middle };
  };

  // each region is judged whole; one too large to be a detail, or accepted but large enough to be two touching
  // (a star against a sprig, berries in a cluster, a detail on a ridge of the body), is split at the saddles
  // between its height peaks and its pieces judged – unless nothing comes of the pieces, when the whole stands
  const parentCount = regions.length; // pieces are appended as they are made; they are judged where they are made
  for (let id = 0; id < parentCount; id++) {
    const members = regions[id];
    const out = evaluate(members, id);
    const splitWorth = out ? out.size > 1.2 * F : !!members.lastDrop && !members.verdict;
    const pieces = splitWorth && members.length >= 24 ? splitRegion(members, id) : null;
    if (pieces && pieces.length >= 2) {
      const ids = pieces.map((piece) => {
        const pid = regions.length;
        piece.parent = id;
        regions.push(piece);
        for (const v of piece) label[v] = pid;
        return pid;
      });
      const got = pieces.map((piece, k) => evaluate(piece, ids[k])).filter(Boolean);
      if (got.length) { details.push(...got); continue; }
      for (const piece of pieces) for (const v of piece) label[v] = id; // nothing in the pieces: the whole stands
    }
    if (out) details.push(out);
  }

  if (trace) {
    // every region with its verdict and vertices, for drawing a trace over the model
    const kept = new Map(details.map((d) => [d.id, d.kind]));
    for (let id = 0; id < regions.length; id++) {
      const m = regions[id];
      const p = new Float32Array(m.length * 3);
      m.forEach((v, i) => { p[i * 3] = pos[v * 3]; p[i * 3 + 1] = pos[v * 3 + 1]; p[i * 3 + 2] = pos[v * 3 + 2]; });
      trace({ reason: 'region', id, parent: m.parent ?? -1, n: m.length, coreCount: m.coreCount ?? m.length, verdict: kept.has(id) ? `kept ${kept.get(id)}` : m.structure ? 'structure' : m.lastDrop ?? 'none', pos: Array.from(p, (x) => +x.toFixed(2)) });
    }
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

/**
 * How crumpled each detail's surface is, judged on the model's own mesh
 * (the lightened copy the finder works on has the fine crumples smoothed
 * away): the share of the mesh edges within the detail's footprint that bend
 * inwards by more than a slight angle. A clean berry bends outwards
 * everywhere, a clean star or leaf only along its few valleys; a smudged or
 * crumpled one rolls in and out all over. Sets `crumple` (0..1) on each
 * detail.
 *
 * @param {Detail[]} details
 * @param {{ positions: Float32Array|Float64Array, index: Uint32Array }} mesh  the model's own mesh
 */
export function crumpleOf(details, mesh) {
  const pos = mesh.positions;
  const index = mesh.index;
  const T = index.length / 3;
  const V = pos.length / 3;
  if (!details.length || T < 4) return;
  const fd = faceData(pos, index);
  const edges = pairEdges(index, V);
  // which detail each face belongs to: inside the detail's footprint (an ellipse in the plane of its base along
  // its direction, a little larger than measured) and standing above its foot
  const owner = new Int32Array(T).fill(-1);
  const frames = details.map((d) => {
    const N = d.normal;
    const a = Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let ux = a[1] * N[2] - a[2] * N[1], uy = a[2] * N[0] - a[0] * N[2], uz = a[0] * N[1] - a[1] * N[0];
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = N[1] * uz - N[2] * uy, vy = N[2] * ux - N[0] * uz, vz = N[0] * uy - N[1] * ux;
    let dir = d.direction && Math.hypot(...d.direction) > 1e-6 ? d.direction : [ux, uy, uz];
    const dl = Math.hypot(...dir) || 1;
    dir = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
    const du = dir[0] * ux + dir[1] * uy + dir[2] * uz, dv = dir[0] * vx + dir[1] * vy + dir[2] * vz;
    const dn = Math.hypot(du, dv) || 1;
    const mid = d.footMiddle ?? d.middle ?? d.center;
    const foot = d.footLevel ?? (mid[0] * N[0] + mid[1] * N[1] + mid[2] * N[2]);
    const half = { l: 0.55 * (d.footLength ?? d.length ?? d.size), w: 0.55 * (d.footWidth ?? d.width ?? d.size) };
    if (d.kind === 'round') { half.l = half.w = 1.1 * d.radius; }
    return { N, u: [ux, uy, uz], v: [vx, vy, vz], cs: du / dn, sn: dv / dn, mid, foot, half, crest: d.crest ?? d.height ?? 1, reach: Math.max(half.l, half.w) };
  });
  // a grid of the details by position, so each face is tested against the few near it
  const cell = Math.max(1e-6, 2 * Math.max(...frames.map((f) => f.reach)));
  const grid = new Map();
  const keyOf = (i, j, k) => (i * 73856093) ^ (j * 19349663) ^ (k * 83492791); // one integer per cell
  frames.forEach((f, i) => {
    const k = keyOf(Math.floor(f.mid[0] / cell), Math.floor(f.mid[1] / cell), Math.floor(f.mid[2] / cell));
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(i);
  });
  for (let t = 0; t < T; t++) {
    const cx = fd.c[t * 3], cy = fd.c[t * 3 + 1], cz = fd.c[t * 3 + 2];
    const i0 = Math.floor(cx / cell), j0 = Math.floor(cy / cell), k0 = Math.floor(cz / cell);
    let best = -1, bestScore = Infinity;
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      for (let j = j0 - 1; j <= j0 + 1; j++) {
        for (let k = k0 - 1; k <= k0 + 1; k++) {
          const list = grid.get(keyOf(i, j, k));
          if (!list) continue;
          for (const di of list) {
            const f = frames[di];
            const rx = cx - f.mid[0], ry = cy - f.mid[1], rz = cz - f.mid[2];
            const above = rx * f.N[0] + ry * f.N[1] + rz * f.N[2] + (f.mid[0] * f.N[0] + f.mid[1] * f.N[1] + f.mid[2] * f.N[2]) - f.foot;
            if (above < 0.1 * f.crest || above > 1.5 * f.crest + 0.5) continue;
            const pu = rx * f.u[0] + ry * f.u[1] + rz * f.u[2], pv = rx * f.v[0] + ry * f.v[1] + rz * f.v[2];
            const along = pu * f.cs + pv * f.sn, across = -pu * f.sn + pv * f.cs;
            const score = (along / f.half.l) ** 2 + (across / f.half.w) ** 2;
            if (score < 1 && score < bestScore) { bestScore = score; best = di; }
          }
        }
      }
    }
    owner[t] = best;
  }
  const bent = new Float64Array(details.length);
  const all = new Float64Array(details.length);
  // a crumple is a slight to moderate inward bend; a sharp one is a clean valley (between a star's points, where a
  // leaf's halves meet), which is left out
  const cosSlight = Math.cos((3 * Math.PI) / 180), cosSharp = Math.cos((25 * Math.PI) / 180);
  for (let e = 0; e < edges.count; e++) {
    const a = edges.faceA[e], b = edges.faceB[e];
    const o = owner[a];
    if (o < 0 || owner[b] !== o) continue;
    all[o]++;
    const dot = fd.n[a * 3] * fd.n[b * 3] + fd.n[a * 3 + 1] * fd.n[b * 3 + 1] + fd.n[a * 3 + 2] * fd.n[b * 3 + 2];
    if (dot >= cosSlight || dot < cosSharp) continue;
    // concave when face b bends up above face a's plane: its centroid lies on the outer side of a
    const concave = (fd.c[b * 3] - fd.c[a * 3]) * fd.n[a * 3] + (fd.c[b * 3 + 1] - fd.c[a * 3 + 1]) * fd.n[a * 3 + 1] + (fd.c[b * 3 + 2] - fd.c[a * 3 + 2]) * fd.n[a * 3 + 2] > 0;
    if (concave) bent[o]++;
  }
  details.forEach((d, i) => { d.crumple = all[i] >= 12 ? bent[i] / all[i] : 0; });
}

/**
 * The smallest eigenvalue and eigenvector of a symmetric 3x3 matrix given as
 * [xx, xy, xz, yy, yz, zz] (Jacobi rotations), with the middle eigenvalue
 * for judging how flat the spread is; null for a degenerate matrix.
 */
function smallestEigen(m) {
  let a = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-18 * (a[0][0] * a[0][0] + a[1][1] * a[1][1] + a[2][2] * a[2][2] + 1e-300)) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = [a[0][0], a[1][1], a[2][2]];
  const order = [0, 1, 2].sort((i, j) => values[i] - values[j]);
  if (!Number.isFinite(values[order[0]]) || values[order[2]] <= 0) return null;
  const i = order[0];
  return { value: values[i], middle: values[order[1]], largest: values[order[2]], vector: [v[0][i], v[1][i], v[2][i]] };
}
