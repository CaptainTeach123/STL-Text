/**
 * Twist-locks, the solid half: the Manifolds of the collar twist-lock a lid
 * gets and of the plug twist-lock a base gets. `locks.js` sizes them and lays
 * them out; this builds exactly that layout, so a test of the layout is a
 * test of the lock.
 *
 * Each lock is built in its own frame and handed over as what each of its two
 * pieces gets: material added before its cutters, the cutters, and material
 * added after them – so drilling a piece takes one boolean on it, however
 * many small ones the lock took to make.
 *  - The collar's frame: z = 0 is the joint face, the body below it and the
 *    lid above (the lid prints on that face), centred on the circle.
 *  - The plug's frame: z = 0 is the bed (the model's bottom), the plug inside
 *    r = R, coming out along −z.
 * Angles are degrees, anticlockwise seen from +z.
 *
 * Every solid a lock is made of is a primitive of its own – a revolve, a hull,
 * an extrusion – whose faces keep that primitive's original id through every
 * boolean after, so `ids` names the lock's own faces on the pieces (for the
 * view to paint). Nothing here calls `asOriginal()`, which would lose them.
 *
 * Ownership as in splitGeometry.js: a Manifold passed in is borrowed, one
 * returned is the caller's.
 */
import { manifold } from './manifold.js';
import { collarReach, layout, plugDims, plugLayoutOk, twistFor } from './locks.js';

/** Segments for a full turn of every revolve: 0.008 mm inside the circle at r 40, far under any clearance. */
export const LOCK_SEGMENTS = 160;
/** How far a lug's root is sunk into the neck or the plug (mm), so it grows out of it, not off its face. */
const SINK = 0.3;
/** The coin slot across a plug's bottom (mm): its width, its walls' height and its gable's ridge. */
const COIN = Object.freeze({ width: 2.4, wall: 1.2, ridge: 2.4 });
/** How far past a plug's own height its wall's gap is cut (mm), and past the bed under it. */
const WALL_PAST = 1;
/**
 * How far a bed mouth runs on into the cutter it widens (mm), past the face it meets: no edge of one lies on another
 * cutter's face, where the union would leave slivers of no area that a slicer reads as open edges.
 */
const INTO = 0.05;

const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

/** What a lock is built from: temporaries to delete, and the original id of every primitive made. */
function kit() {
  const items = [];
  const ids = [];
  return {
    ids,
    add(m) {
      items.push(m);
      return m;
    },
    /** A primitive: its id is the lock's. */
    made(m) {
      ids.push(m.originalID());
      items.push(m);
      return m;
    },
    dispose() {
      for (const m of items) m?.delete?.();
      items.length = 0;
    },
  };
}

/** An outline turned anticlockwise, as a cross-section's positive fill wants it. */
function ccw(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return a < 0 ? [...poly].reverse() : poly;
}

/** `Manifold.revolve` or `.extrude` of a cross-section, freeing the outline the binding passes on (splitGeometry.js). */
function fromOutline(k, poly, build, fallback) {
  const wasm = manifold();
  const cs = k.add(new wasm.CrossSection(ccw(poly), 'Positive'));
  if (typeof cs._ToPolygons !== 'function') return k.made(fallback(cs));
  const vec = cs._ToPolygons();
  try {
    return k.made(build(wasm, vec));
  } finally {
    vec.delete();
  }
}

/** An (r, z) outline revolved from angle a0 to a1, `LOCK_SEGMENTS` a turn. */
function revolve(k, poly, a0 = 0, a1 = 360) {
  const span = a1 - a0;
  const segs = Math.max(3, Math.ceil((LOCK_SEGMENTS * span) / 360 - 1e-9));
  const r = fromOutline(k, poly, (wasm, vec) => wasm._Revolve(vec, segs, span), (cs) => cs.revolve(segs, span));
  return Math.abs(a0) < 1e-12 ? r : k.add(r.rotate([0, 0, a0]));
}

/** An (x, y) outline extruded from z0 to z1. */
function extrude(k, poly, z0, z1) {
  const h = z1 - z0;
  const m = fromOutline(k, poly, (wasm, vec) => wasm._Extrude(vec, h, 0, 0, { x: 1, y: 1 }), (cs) => cs.extrude(h));
  return k.add(m.translate([0, 0, z0]));
}

/** The convex hull of points. */
const hull = (k, pts) => k.made(manifold().Manifold.hull(pts));

/** A point at radius r and angle a (degrees), height z. */
const at = (r, a, z) => [r * Math.cos(rad(a)), r * Math.sin(rad(a)), z];

/**
 * A hull of arcs, so its faces follow the arc rather than a chord: for each `[z, grow]` level, points every 0.5° from
 * angle a0 − grow/rRef to a1 + grow/rRef at radii rIn and rOut + grow. A mouth that widens towards the bed.
 */
function arcHull(k, levels, a0, a1, rIn, rOut, rRef) {
  const pts = [];
  for (const [z, grow] of levels) {
    const b0 = a0 - deg(grow / rRef);
    const b1 = a1 + deg(grow / rRef);
    const n = Math.max(2, Math.ceil((b1 - b0) / 0.5));
    for (let i = 0; i <= n; i++) for (const r of [rIn, rOut + grow]) pts.push(at(r, b0 + ((b1 - b0) * i) / n, z));
  }
  return hull(k, pts);
}

/**
 * A prism whose (z, y) outline – z its height, y along the turn – runs out radially from x0 to x1 and is then turned
 * to angle `a`: a lead-in across a lug's end, or a ledge's.
 */
function radialPrism(k, poly, x0, x1, a) {
  const ex = extrude(k, poly.map(([z, y]) => [-z, y]), 0, x1 - x0);
  // (x, y, z) → (z, y, −x): the outline's −z back to height, the extrusion along +x
  return k.add(k.add(k.add(ex.rotate([0, 90, 0])).translate([x0, 0, 0])).rotate([0, 0, a]));
}

/** A prism from an (x, y) outline in a lug's frame (x out along angle `a`), from height z0 to z1. */
const planPrism = (k, poly, z0, z1, a) => k.add(extrude(k, poly, z0, z1).rotate([0, 0, a]));

/** The union of a list (null when it is empty); the caller's. */
function unionOf(list) {
  const { Manifold } = manifold();
  if (!list.length) return null;
  return list.length === 1 ? list[0].translate([0, 0, 0]) : Manifold.union(list);
}

/**
 * The collar twist-lock's own solids, in its frame, for a neck of radius r0 (`collarFor`): the neck and its three
 * lugs (the body's), the grooves the click tabs' ridges drop into at the locked and the open angle (cut from the
 * body's), the lid's cutters – the socket ring the neck turns in, with a 45° mouth on its bed edge, the L-slots (an
 * arm each, entered from the bed at the lug's place turned θ, its ledge's end led in), the slits that free the click
 * tabs – and the ridges on the tabs, added to the lid after the cutters. Lug 0 is the wide key, so the lid goes on one
 * way round; the lid is set on turned θ anticlockwise seen from above and locks turning clockwise.
 * @param {object} S `sizes()`
 * @param {number} r0 the neck's outside radius
 * @param {{ theta?: number, phi0?: number }} options
 * @returns {{ neck: Manifold, lugs: Manifold, grooves: Manifold, cutters: Manifold, disc: Manifold, ridges: Manifold,
 *   layout: object, rn: number, rs: number, rf: number, theta: number, ids: number[], lugIds: number[],
 *   points: object[] }} the caller's; `disc` the full-disc socket (r < rs under its ceiling), for a lid the ring would
 *   leave bits of inside the bore; `lugIds` the lugs' own among `ids`; `points` where a lug, a slot and a click tab are,
 *   for the view's words
 */
export function twistLockSolids(S, r0, { theta = twistFor(S, r0), phi0 = 0 } = {}) {
  const k = kit();
  try {
    const { c, e, a, zl, t, H, lead, mouth, slitMouth: sm, td, g, b, gTop, Ld, dd, fb, sockTop, armTop, armFloor } = S;
    const rn = r0 - t;
    const rs = r0 + c;
    const rf = r0 + 2 * c + e;
    const h = c + e;
    const L = layout(S, r0, { phi0, theta });
    const neck = revolve(k, [[rn, -0.5], [r0, -0.5], [r0, H - 0.6], [r0 - 0.6, H], [rn, H]]);
    // the lug: its root sunk into the neck, the clearance under a 45° chamfer so the square shoulder bears e at any c
    const lugPoly = [[r0 - SINK, zl - c - SINK], [r0 + c, zl], [r0 + h, zl], [r0 + h, zl + a], [r0 - SINK, zl + a]];
    const lugs = [];
    const grooves = [];
    const cutters = [];
    const ridges = [];
    const lugIds = []; // the lugs' own faces, which the view paints apart from the neck they stand on
    const points = []; // where the view says which is a lug, a slot, a click tab: in the lock's frame, on the body or the part
    const cw = deg(c / r0);
    for (const { phi, w, half } of L.lugs) {
      const first = k.ids.length;
      let lug = revolve(k, lugPoly, phi - half, phi + half);
      // the tip's corners led in 45° in plan, so a drooped edge rides into the slot instead of snagging
      const tip = r0 + h + 0.01;
      const x1 = tip - w / 2 - lead;
      const xin = Math.min(r0 - 2, x1 - 0.5);
      const taper = planPrism(k, [[xin, -w], [x1, -w], [tip, -(w / 2 - lead)], [tip, w / 2 - lead], [x1, w], [xin, w]], zl - 2, zl + a + 2, phi);
      lug = k.add(lug.intersect(taper));
      // and both ends' undersides, in the turn's plane
      for (const s of [-1, 1]) {
        const tri = [[zl + lead + 0.5, -0.5], [zl - 1, -0.5], [zl - 1, lead + 1]].map(([z, y]) => [z, -s * y]);
        lug = k.add(lug.subtract(radialPrism(k, tri, r0 + c - 0.01, tip + 1, phi + s * half)));
      }
      lugIds.push(...k.ids.slice(first));
      lugs.push(lug);
      points.push({ name: 'lug', on: 'body', at: at(r0 + 0.7 * h, phi, zl + a / 2) });
      // its slot in the lid: half-way along the arm it turns in
      points.push({ name: 'slot', on: 'part', at: at((r0 + rf) / 2, phi - theta / 2, (armFloor + armTop) / 2) });
      // the lid's L-slot: the arm from the entry (θ back) to just past the lug, its ceiling flat and bridged
      const from = phi - theta - half - cw;
      cutters.push(revolve(k, [[r0 - 0.05, armFloor], [rf, armFloor], [rf, armTop], [r0 - 0.05, armTop]], from, phi + half + cw));
      cutters.push(revolve(k, [[r0 - 0.05, -1], [rf, -1], [rf, armTop], [r0 - 0.05, armTop]], from, phi - theta + half + cw));
      // the entry's mouth on the bed, following the arc
      cutters.push(arcHull(k, [[-0.01, mouth], [mouth + INTO, -INTO]], from, phi - theta + half + cw, r0, rf, r0));
      // the ledge's end at the entry, its top corner taken off 45°, so a drooped lug rides up onto it
      const ledge = [[armFloor + 0.5, -0.5], [armFloor - lead - 0.5, -0.5], [armFloor + 0.5, lead + 0.5]];
      cutters.push(radialPrism(k, ledge, r0 + c - 0.05, rf + 0.01, phi - theta + half + cw));
    }
    // the socket the neck turns in, a ring bridged across under a flat ceiling, with a 45° mouth on its bore
    cutters.push(revolve(k, [[rn - c, -1], [rs + mouth, -1], [rs + mouth, 0], [rs, mouth], [rs, sockTop], [rn - c, sockTop]]));
    const disc = revolve(k, [[0, -1], [rs, -1], [rs, sockTop], [0, sockTop]]);
    // the click tabs, each a curved cantilever on the bed in the socket's wall, freed by slits behind it, over it and
    // at its free end; its ridge just inside the free end, clicking into a groove at the locked and the open angle
    const base = fb + 2 * (dd + c + 0.2);
    const ro = rs + td + g;
    const gA = deg(g / rs);
    const wedge = (r1, r2, z1, z2, a0, a1) => revolve(k, [[r1, z1], [r2, z1], [r2, z2], [r1, z2]], a0, a1);
    for (const { psi } of L.tabs) {
      const freeEnd = psi - deg((base / 2 + 0.1) / rs);
      const root = freeEnd + deg(Ld / rs);
      points.push({ name: 'click tab', on: 'part', at: at(rs + td / 2, (freeEnd + root) / 2, b / 2) });
      cutters.push(wedge(rs + td, ro, -1, b + gTop, freeEnd - gA, root));
      cutters.push(wedge(rs - 0.05, ro, b, b + gTop, freeEnd - gA, root));
      cutters.push(wedge(rs - 0.05, ro, -1, b + gTop, freeEnd - gA, freeEnd));
      // the slits' mouths on the bed, so the elephant's foot does not weld the tab back on
      cutters.push(revolve(k, [[rs + td - sm, -1], [ro + sm, -1], [ro + sm, 0], [ro - INTO, sm + INTO], [rs + td + INTO, sm + INTO], [rs + td - sm, 0]], freeEnd - gA, root));
      cutters.push(arcHull(k, [[-0.01, sm], [sm + INTO, -INTO]], freeEnd - gA, freeEnd, rs + INTO, ro, rs));
      // the ridge: 45° flanks from the tab's face to a flat dd past the neck's face, its bed edge eased, its top a hair
      // into the slit over the tab rather than flush with the tab's top
      const pts = [];
      for (const [r, w] of [[r0 - dd, fb], [rs + 0.2, base]]) {
        for (const s of [-1, 1]) {
          const ang = psi + s * deg(w / 2 / r);
          for (const z of [0.3, b + INTO]) pts.push(at(r, ang, z));
          pts.push(at(Math.min(rs + 0.2, r + 0.3), ang, 0));
        }
      }
      ridges.push(hull(k, pts));
      // the neck's grooves: the ridge grown by c and a tenth, full height and open at the top
      const cg = c + 0.1;
      const flat = fb + 2 * cg * Math.tan(Math.PI / 8);
      for (const where of [psi, psi + theta]) {
        const gp = [];
        for (const [r, w] of [[r0 - dd - cg, flat], [r0 + 0.3, flat + 2 * (dd + cg + 0.3)]]) {
          for (const s of [-1, 1]) for (const z of [-1, H + 1]) gp.push(at(r, where + s * deg(w / 2 / r), z));
        }
        grooves.push(hull(k, gp));
      }
    }
    return {
      neck: neck.translate([0, 0, 0]), lugs: unionOf(lugs), grooves: unionOf(grooves), cutters: unionOf(cutters), disc: disc.translate([0, 0, 0]),
      ridges: unionOf(ridges), layout: L, rn, rs, rf, theta, ids: [...k.ids], lugIds, points,
    };
  } finally {
    k.dispose();
  }
}

/**
 * The collar under the joint: a revolved ring from the neck's bore rn outwards, `S.Hc` deep at the bore, its
 * underside sloping out and down at `slope` (`collarSlope`), clipped to the body's least outside radius under the face
 * (`below`) inset by the skin, so nothing of it shows outside. It carries the neck. Where the wall ends before the
 * underside lands on it (`collarReach`), the collar runs on under the wall's end, its outside standing straight down
 * a hair into the wall's inside, to where its underside meets that: no flat shelf over air.
 * @param {number} rn the neck's bore
 * @param {object} S `sizes()`
 * @param {number[][]} below `[[r, z, rin], …]` by falling z from z = 0, down to where the collar lands on the wall or
 *   the wall ends (`collarAt`)
 * @param {number} slope r per z (`collarSlope`)
 * @returns {{ solid: Manifold, ids: number[] }} the caller's
 */
export function collarSolid(rn, S, below, slope) {
  const k = kit();
  try {
    const low = below[below.length - 1][1];
    const inset = (r) => Math.max(0.01, r - S.skin);
    const down = collarReach(below, rn, S, slope);
    const hang = down?.hang > 0 ? Math.min(down.r + INTO, inset(below[below.length - 1][0])) : null;
    const bottom = hang == null ? [[0, low]] : [[0, -down.depth - 1], [hang, -down.depth - 1], [hang, low]];
    const big = Math.max(...below.map(([r]) => r)) + 1;
    const env = revolve(k, [...bottom, ...[...below].reverse().map(([r, z]) => [inset(r), z]), [0, 0]]);
    const cone = revolve(k, [[rn, 0], [big, 0], [big, -S.Hc - (big - rn) / slope], [rn, -S.Hc]]);
    return { solid: cone.intersect(env), ids: [...k.ids] };
  } finally {
    k.dispose();
  }
}

/**
 * The lid's socket ring: material from the socket's face rs out to the lid's least outside radius at each height
 * (`above`, `[[r, z], …]` by rising z from z = 0), up to 4 mm over the socket's ceiling, so the socket, the slots and
 * the tabs are cut from solid inside the lid's own outside.
 * @returns {{ solid: Manifold, ids: number[] }} the caller's
 */
export function socketRing(rs, S, above) {
  const k = kit();
  try {
    const high = above[above.length - 1][1];
    const big = Math.max(...above.map(([r]) => r)) + 1;
    const env = revolve(k, [[0, 0], ...above, [0, high]]);
    const ring = revolve(k, [[rs, 0], [big, 0], [big, S.sockTop + 4], [rs, S.sockTop + 4]]);
    return { solid: ring.intersect(env), ids: [...k.ids] };
  } finally {
    k.dispose();
  }
}

/**
 * The plug twist-lock's own solids for a bore of radius R (`plugAt`), in its frame, every face 45° or kinder as each
 * piece prints (the plug on its bottom, the body standing on its own), so it adds no overhang and no bridge: the
 * plug's three lugs (lug 0 the wide key), 45° under and over; the body's cutters – an L-slot per lug (the lug grown by
 * c, so its floor and roof are 45° too), entered from the bed with an arc-following mouth, a 45° mouth on the bore and
 * the grooves the click ridges drop into at the locked and the open angle; the plug's cutters – the click tabs' slits,
 * roofed at 45°, with mouths on the bed, a 45° mouth round its bottom edge and a coin slot across its bottom (vertical
 * walls, then a 45° gable); and the ridges, added after. Mirrored as `plugLayoutOk` lays it out: set in turned θ
 * clockwise seen from above, it locks turning anticlockwise – clockwise, as one fits a base with the model upside down.
 * @param {object} S `sizes()`
 * @param {number} R the body's bore
 * @returns {{ lugs: Manifold, bodyCut: Manifold, plugCut: Manifold, ridges: Manifold, layout: object, theta: number,
 *   rp: number, ids: number[], lugIds: number[], points: object[] }} the caller's; `lugIds` the lugs' own among `ids`,
 *   `points` where a lug, a slot and a click tab are, for the view's words
 */
export function plugLockSolids(S, R) {
  const k = kit();
  try {
    const { c, td, g, b, gTop, Ld, dd, fb, mouth, slitMouth: sm } = S;
    const d = plugDims(S, R);
    const { e, a, zl, rp } = d;
    const L = plugLayoutOk(S, R, d);
    const { theta } = L;
    // built as laid out before the mirror (angle a → −a), then mirrored across the X axis
    const flip = (x) => (720 - x) % 360;
    const rb = R;
    const tipR = rb + e;
    const rise = tipR - (rp - SINK);
    const lugPoly = [[rp - SINK, zl - rise], [tipR, zl], [tipR, zl + a], [rp - SINK, zl + a + rise]];
    // the slot: the lug grown by c in (r, z); a 45° face grown by c moves c√2 along z
    const c45 = c * Math.SQRT2;
    const inner = rb - 0.05 - (rp - SINK);
    const armPoly = [[rb - 0.05, zl - rise - c45 + inner], [tipR + c, zl - c45 + c], [tipR + c, zl + a + c45 - c], [rb - 0.05, zl + a + rise + c45 - inner]];
    // the entry a hair wider and higher than the arm it opens into, its roof as steep: two revolves of other spans on
    // one face would meet chord against chord
    const entryPoly = [[rb - 0.05, -1], [tipR + c + INTO, -1], [tipR + c + INTO, armPoly[2][1]], [rb - 0.05, armPoly[3][1] + INTO]];
    const lugs = [];
    const bodyCut = [];
    const plugCut = [];
    const ridges = [];
    const lugIds = []; // the lugs' own faces, which the view paints apart from the plug they stand on
    const points = []; // where the view says which is a lug, a slot, a click tab, in the lock's frame once mirrored
    const mirrored = (r, a, z) => at(r, -a, z);
    const cw = deg(c / rb);
    L.lugs.forEach(({ phi: mirroredPhi, half }) => {
      const phi = flip(mirroredPhi);
      const first = k.ids.length;
      lugs.push(revolve(k, lugPoly, phi - half, phi + half));
      lugIds.push(...k.ids.slice(first));
      points.push({ name: 'lug', on: 'part', at: mirrored((rp + tipR) / 2, phi, zl + a / 2) });
      points.push({ name: 'slot', on: 'body', at: mirrored((rb + tipR + c) / 2, phi + theta / 2, zl + a / 2) });
      // the lug locks at phi and goes in at phi + θ
      bodyCut.push(revolve(k, armPoly, phi - half - cw, phi + theta + half + cw));
      bodyCut.push(revolve(k, entryPoly, phi + theta - half - cw, phi + theta + half + cw));
      // the entry's mouth on the bed, running on into the entry past its face
      bodyCut.push(arcHull(k, [[-0.01, mouth], [mouth + INTO, -INTO]], phi + theta - half - cw, phi + theta + half + cw, rb - 0.05, tipR + c, rb));
    });
    // the bed mouths: the body's bore and the plug's bottom edge
    bodyCut.push(revolve(k, [[rb - 0.05, -1], [rb + mouth + 1, -1], [rb - 0.05, mouth + 0.05]]));
    plugCut.push(revolve(k, [[rp - mouth - 1, -1], [rp + 2, -1], [rp + 2, mouth + 2]]));
    const base = fb + 2 * (dd + c + 0.2);
    const gA = deg(g / rp);
    const ri = rp - td - g;
    // the slit over the tab rises 45° out to the plug's face: no bridge
    const roofTop = b + gTop + (rp + 0.05 - ri);
    for (const { psi: mirroredPsi } of L.tabs) {
      const psi = flip(mirroredPsi);
      const freeEnd = psi - deg((base / 2 + 0.1) / rp);
      const root = freeEnd + deg(Ld / rp);
      points.push({ name: 'click tab', on: 'part', at: mirrored(rp - td / 2, (freeEnd + root) / 2, b / 2) });
      plugCut.push(revolve(k, [[ri, -1], [rp - td, -1], [rp - td, b], [rp + 0.05, b], [rp + 0.05, roofTop], [ri, b + gTop]], freeEnd - gA, root));
      plugCut.push(revolve(k, [[ri, -1], [rp + 0.05, -1], [rp + 0.05, roofTop], [ri, b + gTop]], freeEnd - gA, freeEnd));
      plugCut.push(revolve(k, [[ri - sm, -1], [rp - td + sm, -1], [rp - td + sm, 0], [rp - td, sm], [ri, sm], [ri - sm, 0]], freeEnd - gA, root));
      // the ridge: from the tab's face out to dd past the bore, 45° flanks, its bed edge eased, its top a hair into the
      // slit over the tab rather than flush with the tab's top
      const pts = [];
      for (const [r, w] of [[rb + dd, fb], [rp - 0.2, base]]) {
        for (const s of [-1, 1]) {
          const ang = psi + s * deg(w / 2 / r);
          for (const z of [0.3, b + INTO]) pts.push(at(r, ang, z));
          pts.push(at(Math.max(rp - 0.2, r - 0.3), ang, 0));
        }
      }
      ridges.push(hull(k, pts));
      // the body's grooves at the locked and the open angle: the ridge grown by c, from under the bed up past the tab
      const flat = fb + 2 * c * Math.tan(Math.PI / 8);
      for (const where of [psi, psi + theta]) {
        const gp = [];
        for (const [r, w] of [[rb + dd + c, flat], [rb - 0.3, flat + 2 * (dd + c + 0.3)]]) {
          for (const s of [-1, 1]) for (const z of [-1, b + c + 0.2]) gp.push(at(r, where + s * deg(w / 2 / r), z));
        }
        bodyCut.push(hull(k, gp));
      }
    }
    // the coin slot along x, stopping a millimetre inside the tabs' slits: its walls and its gable one hull, so no face
    // of one lies on the other's
    const { width: cwd, wall, ridge } = COIN;
    const ends = [-d.coin / 2, d.coin / 2];
    plugCut.push(hull(k, ends.flatMap((x) => [[x, -cwd / 2, -1], [x, cwd / 2, -1], [x, -cwd / 2, wall], [x, cwd / 2, wall], [x, 0, ridge]])));
    const mirror = (m) => {
      const out = m.mirror([0, 1, 0]);
      m.delete();
      return out;
    };
    return {
      lugs: mirror(unionOf(lugs)), bodyCut: mirror(unionOf(bodyCut)), plugCut: mirror(unionOf(plugCut)), ridges: mirror(unionOf(ridges)),
      layout: L, theta, rp, ids: [...k.ids], lugIds, points,
    };
  } finally {
    k.dispose();
  }
}

/**
 * The gap round a base's wall: its plug turned down to rp = R − c, from under the bed to past its top, so it drops in
 * and out of the body's bore of radius R as printed. Where its lugs stand (`lugs`, when it locks) is left alone.
 * @returns {{ solid: Manifold, ids: number[] }} the caller's
 */
export function plugWall(S, R, top, lugs = null) {
  const k = kit();
  try {
    const ring = revolve(k, [[R - S.c, -WALL_PAST - 1], [R + 2, -WALL_PAST - 1], [R + 2, top + WALL_PAST], [R - S.c, top + WALL_PAST]]);
    return { solid: lugs ? ring.subtract(lugs) : ring.translate([0, 0, 0]), ids: [...k.ids] };
  } finally {
    k.dispose();
  }
}

/**
 * The twist-lock's fit test: the lock exactly as the pieces get it – the same neck, lugs, slots, click tabs, mouths
 * and layer heights – on two small rings, so a print of a few grams tries the clearance before the model. The body's
 * half is the neck and its lugs on a flat ring 12 layers thick, standing on the bed; the lid's half is the socket in
 * a ring with a flat top a millimetre over it, a wall of three lines round its inside so its ceiling is bridged,
 * lying on its cut face as the lid does. Both rings reach two lines and 1.2 mm past the tabs' slits.
 * @param {object} S `sizes()`
 * @param {number} r0 the neck's radius
 * @param {{ theta?: number }} options
 * @returns {{ body: Manifold, lid: Manifold, d: number }} the caller's, each standing on z = 0 about the axis; `d` the
 *   rings' outer diameter
 */
export function twistCoupon(S, r0, { theta = twistFor(S, r0) } = {}) {
  const { Manifold } = manifold();
  const k = kit();
  try {
    const L = twistLockSolids(S, r0, { theta });
    [L.neck, L.lugs, L.grooves, L.cutters, L.disc, L.ridges].forEach((m) => k.add(m));
    const rOut = r0 + S.c + S.td + S.g + S.skin + 1.2;
    const floor = 12 * S.hl;
    const ring = revolve(k, [[L.rn, -floor], [rOut, -floor], [rOut, 0], [L.rn, 0]]);
    const neck = k.add(k.add(Manifold.union([ring, L.neck, L.lugs])).subtract(L.grooves));
    const rIn = L.rn - S.c - Math.max(1.2, 3 * S.n);
    const socket = revolve(k, [[rIn, 0], [rOut, 0], [rOut, S.sockTop + 1], [rIn, S.sockTop + 1]]);
    const lid = k.add(socket.subtract(L.cutters)).add(L.ridges);
    return { body: neck.translate([0, 0, floor]), lid, d: 2 * rOut };
  } finally {
    k.dispose();
  }
}

/**
 * Everything a part's lock gives its two pieces, in the lock's frame, from its plain data (the engine's
 * `layout.locks`): `body` for the piece it comes out of, `part` for the part, each `{ add, cut, after }` – material
 * added before the cutters, the cutters, material added after them (null when none) – and `fill`, whether a pocket
 * the body's additions seal against the model is to be filled (a collar's). A collar lock: the body gets the collar,
 * the neck and the lugs less the grooves; the lid the socket ring, the socket (the ring, or the full disc where the
 * lock says so) and slots and slits, then the ridges. A plug lock: the body loses the slots, grooves and mouths; the
 * plug gets its lugs, loses its wall's gap, slits, mouth and coin slot, then gets its ridges. A plug with no lock gets
 * its wall's gap only. `carry` names, among `ids`, what carries the lock rather than being it – the collar and the
 * socket ring – which the view paints lighter, and `bare` what is the piece's own outside, only turned down to its
 * clearance – the plug's wall – which the view leaves the piece's colour; `lugs` the lugs', which it paints apart, and
 * `points` where a lug, a slot and a click tab are, in the lock's frame, for the words it puts on them.
 * @param {{ mech: 'twist'|'plug'|null, kind: string, S: object, r0?: number, theta?: number, slope?: number,
 *   below?: number[][], above?: number[][], socket?: 'ring'|'disc', R?: number, top?: number }} lock
 * @returns {{ body: { add: Manifold|null, cut: Manifold|null, after: null }, part: { add: Manifold|null, cut: Manifold|null,
 *   after: Manifold|null }, fill: boolean, ids: number[], carry: number[], bare: number[], lugs: number[],
 *   points: object[] }} the caller's
 */
export function lockSolids(lock) {
  const { Manifold } = manifold();
  const { S } = lock;
  const k = kit();
  try {
    if (lock.mech === 'twist') {
      const L = twistLockSolids(S, lock.r0, { theta: lock.theta });
      [L.neck, L.lugs, L.grooves, L.cutters, L.disc, L.ridges].forEach((m) => k.add(m));
      const collar = collarSolid(L.rn, S, lock.below, lock.slope);
      const ring = socketRing(L.rs, S, lock.above);
      k.add(collar.solid);
      const grown = k.add(Manifold.union([collar.solid, L.neck, L.lugs]));
      const add = grown.subtract(L.grooves);
      return {
        body: { add, cut: null, after: null },
        part: { add: ring.solid, cut: lock.socket === 'disc' ? Manifold.union([L.cutters, L.disc]) : L.cutters.translate([0, 0, 0]), after: L.ridges.translate([0, 0, 0]) },
        fill: true,
        ids: [...L.ids, ...collar.ids, ...ring.ids],
        carry: [...collar.ids, ...ring.ids],
        bare: [],
        lugs: [...L.lugIds],
        points: L.points,
      };
    }
    if (lock.mech === 'plug') {
      const P = plugLockSolids(S, lock.R);
      [P.lugs, P.bodyCut, P.plugCut, P.ridges].forEach((m) => k.add(m));
      const wall = plugWall(S, lock.R, lock.top, P.lugs);
      k.add(wall.solid);
      return {
        body: { add: null, cut: P.bodyCut.translate([0, 0, 0]), after: null },
        part: { add: P.lugs.translate([0, 0, 0]), cut: Manifold.union([wall.solid, P.plugCut]), after: P.ridges.translate([0, 0, 0]) },
        fill: false,
        ids: [...P.ids, ...wall.ids],
        carry: [],
        bare: [...wall.ids],
        lugs: [...P.lugIds],
        points: P.points,
      };
    }
    const wall = plugWall(S, lock.R, lock.top);
    return { body: { add: null, cut: null, after: null }, part: { add: null, cut: wall.solid, after: null }, fill: false, ids: wall.ids, carry: [], bare: wall.ids, lugs: [], points: [] };
  } finally {
    k.dispose();
  }
}
