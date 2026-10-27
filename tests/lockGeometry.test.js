// The twist-locks built: the collar twist-lock a lid gets and the plug twist-lock a base gets, on the fixture modelled
// on the user's lantern (design §10.1) and a few models made for one rule each. Each lock is built as the engine builds
// it – sized on the model's slices (`checkPart`), carved (`carveParts`) and drilled (`drillPiece`) – with the model
// moved so the joint is at z = 0 on the circle's axis, and checked as the two pieces would meet: seated, pulled,
// turned, entered, clicked, turned the wrong way and slid out. The engine's side of it is in engine.test.js.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { manifold } from '../src/manifold.js';
import { FINE_SPECK, SPECK, WAY_START, findParts, fineSlices, plugLockOf, sliceStack } from '../src/partFinder.js';
import { bandFor, buildSplitDisplay, carveParts, checkPart, cutTwist, drillPiece, lockFaces, lockIds, lockMatrix, lockPieces, lockPoints, wayOverlaps } from '../src/splitGeometry.js';
import { displayBuffers } from '../src/mesh.js';
import { unmarkJoint } from '../src/viewer.js';
import { LOCK_SEGMENTS, lockSolids, plugCoupon, plugLockSolids, twistCoupon, twistLockSolids } from '../src/lockGeometry.js';
import { camOut, layout, plugDims, plugHold, plugLayoutOk, plugRing, sizes, slitBridge } from '../src/locks.js';
import { setup } from './helpers.js';
import { batLanternSolid, overhangs, roundLanternSolid, stlCheck } from './lanternFixture.js';

let wasm;
beforeAll(async () => {
  await setup();
  wasm = manifold();
});

// every Manifold a test makes goes in here and is deleted after it
const made = [];
const own = (m) => {
  made.push(m);
  return m;
};
afterEach(() => {
  for (const m of made.splice(0)) m.delete();
});

const r4 = (v) => +v.toFixed(4);
/** An (r, z) outline revolved about z. */
const rev = (pts, seg = LOCK_SEGMENTS) => own(own(new wasm.CrossSection(pts, 'Positive')).revolve(seg));
const volume = (m) => m.volume();
/** How much two solids share (mm³). */
const overlap = (a, b) => own(a.intersect(b)).volume();
/** The piece turned phi° about the joint's axis and lifted dz, and what it shares with the body there. */
const fitAt = (body, piece, phi, dz) => overlap(body, own(own(piece.rotate([0, 0, phi])).translate([0, 0, dz])));
/** A point in the plane turned a° about the axis. */
const turned = (a, [x, y]) => {
  const t = (a * Math.PI) / 180;
  return [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)];
};
/** Whether the piece has material at (x, y, z): a 0.02 mm square there on its slice. */
const solidAt = (piece, [x, y], z) => own(own(piece.slice(z)).intersect(own(own(wasm.CrossSection.square([0.02, 0.02], true)).translate([x, y])))).area() > 1e-6;
/** The same, at radius r and angle a (degrees). */
const solidPolar = (piece, r, a, z) => solidAt(piece, turned(a, [r, 0]), z);

/**
 * A part of `model` – its face at z0, its circle's centre c and radius R – sized, carved and drilled as the engine
 * does it, with the model moved so the face is at z = 0 on the circle's axis: the lock's own frame.
 */
function built(model, { c = [0, 0], z0, R }, { S = sizes(), socket = 'ring' } = {}) {
  const m = own(model.translate([-c[0], -c[1], -z0]));
  const stack = sliceStack(m);
  const fine = fineSlices(m, stack.speck * FINE_SPECK);
  const grid = { from: m.boundingBox().min[2], step: S.hl };
  const got = checkPart(m, stack, fine, { c: [0, 0], z0: 0, R }, { hl: S.hl, gmin: S.gmin, grid, letter: 'A', minLift: WAY_START * stack.height, S });
  const plug = got.kind === 'plug';
  const carved = carveParts(m, [{ frame: null, c: [0, 0], z0: got.z0, R, top: got.top, plug }]);
  own(carved.body);
  own(carved.lids[0].solid);
  const mech = got.lock?.mech ?? null;
  const lock = {
    cutId: 'c1', letter: 'A', mech, kind: plug ? 'plug' : 'lid', frame: null, c: [0, 0], z0: got.z0, S,
    ...(mech === 'twist' ? { r0: got.lock.r0, theta: got.lock.theta, slope: got.lock.slope, above: got.lock.above, below: got.lock.below, socket } : {}),
    ...(plug ? { R, top: got.top - got.z0 } : {}),
    sides: [{ piece: 1, role: 'body' }, { piece: 2, role: 'part' }],
  };
  const plan = { dowels: [], pegs: [], lips: [], labels: [], locks: mech || plug ? [lock] : [] };
  const marks = { body: [], part: [] };
  const body = own(drillPiece(carved.body, plan, 1, { marks: marks.body }));
  const part = own(drillPiece(carved.lids[0].solid, plan, 2, { marks: marks.part }));
  // the part as the lock leaves it before its click's ridges go on: the lock's own fit, without the click (its
  // solids are in its own frame, the face at z = 0: where a face moved up a layer, they move with it)
  let rigid = part;
  if (mech) {
    const L = lockSolids(lock);
    const at = (x) => (x ? own(own(x).transform(lockMatrix(lock))) : null);
    const add = at(L.part.add);
    const cut = at(L.part.cut);
    for (const x of [L.body.add, L.body.cut, L.part.after]) if (x) own(x);
    rigid = own(own(add ? carved.lids[0].solid.add(add) : carved.lids[0].solid.translate([0, 0, 0])).subtract(cut));
  }
  return { m, got, lock, plan, carved, body, part, rigid, marks };
}

/** The bat lantern fixture at s times its size. */
const bat = (s) => own(own(batLanternSolid()).scale([s, s, s]));
/** The fixture's dome and cap and its base, as the finder places them (§10.1). */
const LID = { 3: { z0: 86, R: 23.6286 }, 4: { z0: 114.6, R: 31.5052 } };
const BASE = { 3: { z0: 0, R: 21.4 }, 4: { z0: 0, R: 28.8 } };

describe("the dome and cap's collar twist-lock, on the fixture modelled on the user's lantern", () => {
  it('is the lock the finder offers, built in one piece each: seated, held, turned free, clicked and opened as designed', () => {
    const want = {
      // at 300 % the band ends 0.894 mm short of where the collar's underside meets its inside: the collar runs on
      // under it 0.894 / 1.72 mm, where at 400 % it lands on the band
      3: { r0: 15.88, opening: 28.56, theta: 27, tabs: 3, lift: 4.1, reach: 8.25 + 0.894 / 1.72, hang: 0.894 / 1.72, pulled: 0.7711, click: 0.5912 },
      4: { r0: 23.71, opening: 44.22, theta: 18, tabs: 6, lift: 5.6, reach: 9.75, hang: 0, pulled: 0.7641, click: 1.1727 },
    };
    for (const s of [3, 4]) {
      const model = bat(s);
      const w = want[s];
      const b = built(model, LID[s]);
      const { got, lock, body, part, rigid } = b;
      expect(got).toMatchObject({ ok: true, kind: 'lid', z0: 0, name: 'Dome and cap', handle: true });
      // sized as the finder's table sizes it, on the same slices: the lock offered is the lock built
      const offered = findParts(model).parts.find((e) => e.kind === 'lid').lock;
      expect(got.lock).toMatchObject({ mech: 'twist', r0: w.r0, opening: w.opening, theta: w.theta, tabs: w.tabs, slope: 1.72 });
      expect([offered.r0, offered.opening, offered.theta, offered.tabs]).toEqual([w.r0, w.opening, w.theta, w.tabs]);
      expect(got.lock.reach).toBeCloseTo(w.reach, 3);
      expect(got.lock.hang).toBeCloseTo(w.hang, 3);
      // the way out starts at the lock's own lift, the neck and the play over it: 2.6 mm, then up by 0.25·s
      expect(got.way).toMatchObject({ up: false, lift: w.lift, dir: [0, 1] });
      // one piece each, the ring socket enough, and no hollow sealed in the body
      expect(lockPieces(part, lock)).toBe('whole');
      expect([body, part].map((x) => x.decompose().map((y) => (y.delete(), 1)).length)).toEqual([1, 1]);
      // as a slicer reads them, the lock leaves no sliver of no area in either piece
      expect(stlCheck(part)).toEqual({ degenerate: 0, open: 0 });
      expect(stlCheck(body)).toEqual(stlCheck(b.carved.body));
      // the lock adds to the body and takes from inside the lid
      expect(volume(body)).toBeGreaterThan(volume(b.carved.body) + 1000);
      const near = own(body.intersect(rev([[0, -16], [40, -16], [40, 16], [0, 16]])));
      expect(overlap(near, part)).toBe(0);
      // pulled up the axial play and a tenth: the lugs bear on the ledges
      expect(r4(fitAt(near, rigid, 0, lock.S.cz + 0.1))).toBeCloseTo(w.pulled, 3);
      expect(fitAt(near, rigid, 0, lock.S.cz + 0.1)).toBeGreaterThan(0.3);
      // turned the open way, nothing but the click meets: free at both ends, the ridges over the neck between
      for (let phi = 0; phi <= lock.theta; phi += 2) expect(fitAt(near, rigid, phi, 0)).toBe(0);
      expect([fitAt(near, part, 0, 0), fitAt(near, part, lock.theta, 0)]).toEqual([0, 0]);
      expect(r4(fitAt(near, part, lock.theta / 2, 0))).toBeCloseTo(w.click, 3);
      // and at the open angle it lifts straight off the neck
      for (let dz = 0; dz <= lock.S.H + 1; dz += 0.5) expect(fitAt(near, part, lock.theta, dz)).toBe(0);
      // the wrong way, the lugs run into the slots' ends
      expect(fitAt(near, rigid, -lock.theta, 0)).toBeGreaterThan(0.5);
    }
  });

  it('comes out the way the slices found: clear along ±Y at their lift once turned free, blocked along X', () => {
    const b = built(bat(3), LID[3]);
    const { got } = b;
    const way = { frame: null, c: [0, 0], z0: 0, turn: got.lock.theta, lift: got.way.lift, reach: got.way.reach };
    for (const dir of [[0, 1], [0, -1]]) expect(wayOverlaps(b.carved.body, b.carved.lids[0].solid, { ...way, dir })).toMatchObject({ clear: true });
    const alongX = wayOverlaps(b.carved.body, b.carved.lids[0].solid, { ...way, dir: [1, 0] });
    expect(alongX.clear).toBe(false);
    expect(Math.max(...alongX.overlaps)).toBeGreaterThan(100);
    // the start, then eight steps to the reach
    expect(alongX.overlaps).toHaveLength(9);
    expect(alongX.overlaps[0]).toBe(0);
  });

  it('keeps the skin: nothing of the lock shows outside either piece, and its lugs, slots and tabs are where the layout says', () => {
    const b = built(bat(4), LID[4]);
    const { lock, body, part } = b;
    const S = lock.S;
    const L = twistLockSolids(S, lock.r0, { theta: lock.theta });
    for (const x of [L.neck, L.lugs, L.grooves, L.cutters, L.disc, L.ridges]) own(x);
    // the lid's cutters stay two lines inside its real outside: none of them in the air round it, moved in by the skin
    const above = lock.above;
    const big = 50;
    const env = rev([[0, 0], ...above, [0, above[above.length - 1][1]]]);
    const filled = own(b.carved.lids[0].solid.add(own(rev([[0, 0], [big, 0], [big, 12], [0, 12]]).intersect(env))));
    const air = own(rev([[0, 0.01], [big, 0.01], [big, 10], [0, 10]]).subtract(filled));
    const d = S.skin;
    const near = own(wasm.Manifold.union([air, ...[[0, 0, -d], [0.7 * d, 0, -0.7 * d], [-0.7 * d, 0, -0.7 * d], [0, 0.7 * d, -0.7 * d], [0, -0.7 * d, -0.7 * d]].map((v) => own(air.translate(v)))]));
    expect(overlap(L.cutters, near)).toBe(0);
    // the body's additions stay two lines inside its own least outside radius under the face, or inside the lid's
    // socket over it
    const added = own(body.subtract(b.carved.body));
    const skinIn = [...lock.below].reverse().map(([r, z]) => [r - S.skin + 0.01, z]);
    const inside = own(rev([[0, lock.below[lock.below.length - 1][1]], ...skinIn, [0, 0]]).add(rev([[0, 0], [L.rs + 1, 0], [L.rs + 1, S.H + 1], [0, S.H + 1]])));
    expect(volume(added)).toBeGreaterThan(1000);
    expect(volume(own(added.subtract(inside)))).toBeLessThan(1e-3);
    // the lugs: three arcs of the neck at 0°, 120° and 240°, the key lug 6.5 mm wide against 5
    const arcs = (cs) => cs.decompose().map((p) => {
      const bb = p.bounds();
      const a = (Math.atan2((bb.min[1] + bb.max[1]) / 2, (bb.min[0] + bb.max[0]) / 2) * 180) / Math.PI;
      const out = { at: (a + 360) % 360, area: p.area() };
      p.delete();
      return out;
    }).filter((x) => x.area > 0.02);
    const ring = (r1, r2) => own(own(wasm.CrossSection.circle(r2, 720)).subtract(own(wasm.CrossSection.circle(r1, 720))));
    const lugs = arcs(own(own(body.slice(S.zl + S.a / 2)).intersect(ring(lock.r0 + 0.08, lock.r0 + S.c + S.e - 0.05)))).sort((p, q) => p.at - q.at);
    const lay = layout(S, lock.r0, { theta: lock.theta });
    expect(lugs.map((x) => Math.round(x.at))).toEqual(lay.lugs.map((x) => x.phi));
    expect(lugs[0].area / lugs[1].area).toBeCloseTo(6.5 / 5, 1);
    // the click tabs: the slit behind each, where the layout puts it
    const rs = lock.r0 + S.c;
    const slits = arcs(own(ring(rs + S.td + 0.1, rs + S.td + S.g - 0.1).subtract(own(part.slice(0.6))))).sort((p, q) => p.at - q.at);
    const base = S.fb + 2 * (S.dd + S.c + 0.2);
    const deg = (x) => (x * 180) / Math.PI;
    const mid = lay.tabs.map(({ psi }) => {
      const freeEnd = psi - deg((base / 2 + 0.1) / rs);
      return (freeEnd - deg(S.g / rs) + freeEnd + deg(S.Ld / rs)) / 2;
    });
    expect(slits).toHaveLength(6);
    slits.forEach((x, i) => expect(Math.abs(x.at - mid[i])).toBeLessThan(0.5));
  });

  it("has every margin a printer needs: mouths on the bed edges, lead-ins, slits clear of the tab, room in the grooves", () => {
    const b = built(bat(4), LID[4]);
    const { lock, body, part } = b;
    const S = lock.S;
    const deg = (x) => (x * 180) / Math.PI;
    const { r0, theta } = lock;
    const rs = r0 + S.c;
    const rf = r0 + 2 * S.c + S.e;
    const lay = layout(S, r0, { theta });
    const { phi, w, half } = lay.lugs[1];
    const cw = deg(S.c / r0);
    // the socket's 45° mouth on the bed: at 0.1 mm up it is 0.3 mm wider than the socket, under a slot's ledge too
    expect(solidPolar(part, rs + 0.15, phi, 0.1)).toBe(false);
    expect(solidPolar(part, rs + 0.5, phi, 0.1)).toBe(true);
    // each slot's entry widens towards the bed, past the slot's outer wall
    expect(solidPolar(part, rf + 0.15, phi - theta, 0.1)).toBe(false);
    expect(solidPolar(part, rf + 0.15, phi - theta, 0.5)).toBe(true);
    // the ledge's end at the entry is led in 45°, 0.3 mm: lower 0.15 mm into it, whole 1 mm in
    const ledgeEnd = phi - theta + half + cw;
    const r = r0 + S.c + 0.2;
    expect(solidPolar(part, r, ledgeEnd + deg(0.15 / r), S.armFloor - 0.08)).toBe(false);
    expect(solidPolar(part, r, ledgeEnd + deg(1 / r), S.armFloor - 0.08)).toBe(true);
    // each click tab is free at its end – a slit across it, with a mouth on the bed – and fixed at its root
    const base = S.fb + 2 * (S.dd + S.c + 0.2);
    for (const { psi } of lay.tabs) {
      const freeEnd = psi - deg((base / 2 + 0.1) / rs);
      const mid = rs + S.td / 2;
      expect(solidPolar(part, mid, freeEnd - deg(S.g / rs) / 2, 0.6)).toBe(false);
      expect(solidPolar(part, mid, freeEnd + deg(1 / rs), 0.6)).toBe(true);
      expect(solidPolar(part, mid, freeEnd + deg(0.1 / rs), 0.05)).toBe(false);
      expect(solidPolar(part, mid, freeEnd + deg(0.1 / rs), 0.6)).toBe(true);
      // the neck's groove at the locked angle reaches the ridge's depth and a tenth more than the clearance under it
      expect(solidPolar(body, r0 - S.dd - S.c - 0.05, psi, 0.6)).toBe(false);
      expect(solidPolar(body, r0 - S.dd - S.c - 0.2, psi, 0.6)).toBe(true);
    }
    // the lug's root is sunk into the neck, filling under the neck's chamfered top; beside the lug the chamfer is bare
    expect(solidPolar(body, r0 - 0.05, phi, S.zl + S.a - 0.1)).toBe(true);
    expect(solidPolar(body, r0 - 0.05, phi + half + 1, S.zl + S.a - 0.1)).toBe(false);
    // the lug's tip has its corners led in 45° in plan, 0.3 mm…
    const tip = r0 + S.c + S.e + 0.01;
    const x = r0 + 0.4;
    const plan = w / 2 - S.lead + (tip - x);
    expect(plan).toBeLessThan(x * Math.tan((half * Math.PI) / 180) - 0.04);
    expect(solidAt(body, turned(phi, [x, plan + 0.05]), S.zl + S.a / 2)).toBe(false);
    expect(solidAt(body, turned(phi, [x, plan - 0.05]), S.zl + S.a / 2)).toBe(true);
    // …and both its ends' undersides: 0.12 mm in from its end, 0.1 mm over its underside, is air
    const endIn = turned(phi + half, [r0 + S.c + 0.1, -0.12]);
    expect(solidAt(body, endIn, S.zl + 0.1)).toBe(false);
    expect(solidAt(body, endIn, S.zl + S.a / 2)).toBe(true);
  });

  it('prints as it is saved: the lid adds only bridged ceilings, the body its lugs\' shoulders and the collar\'s steps', () => {
    // what hangs over the layer under it that the plain carve did not have (the same layer, the same area)
    const added = (with_, without) => with_.filter((o) => !without.some((p) => p.z === o.z && Math.abs(p.area - o.area) <= 0.01 * o.area));
    // at 300 % too, where the collar runs on under the band's end rather than stopping in a ledge over the windows:
    // nothing it adds hangs out more than half a millimetre past the layer under it, where the model did not already
    const at3 = built(bat(3), LID[3]);
    const under3 = rev([[0, -12], [50, -12], [50, at3.lock.S.H + 0.3], [0, at3.lock.S.H + 0.3]]);
    const new3 = overhangs(own(at3.body.intersect(under3)), -12, at3.lock.S.H, 0.2, 0.02, own(at3.carved.body.intersect(under3)));
    expect(new3.length).toBeGreaterThan(0);
    for (const o of new3) expect(o.width).toBeLessThanOrEqual(0.5);
    // what runs on under the band's end stands inside the band's inside (a hair into it) and ends where the underside
    // meets it, the collar's reach
    const [r, low, rin] = at3.lock.below[at3.lock.below.length - 1];
    const wall = Math.min(rin, r - at3.lock.S.skin);
    const hung = own(at3.body.subtract(at3.carved.body));
    const outsideAt = (z, rr) => own(own(hung.slice(z)).subtract(own(wasm.CrossSection.circle(rr, 720)))).area();
    expect(own(hung.slice(low - 0.1)).area()).toBeGreaterThan(1);
    for (const z of [low - 0.1, low - 0.3, low - 0.5]) expect(outsideAt(z, wall + 0.06)).toBe(0);
    expect(own(hung.slice(-at3.got.lock.reach - 0.05)).area()).toBe(0);
    const b = built(bat(4), LID[4]);
    const { lock, body, part } = b;
    const S = lock.S;
    // the lid prints on its face: what the lock adds that hangs out is a ceiling bridged across a slot, a slit or the
    // socket – the slits' 1.78 mm across – never wider than 2 mm
    const near = rev([[0, 0], [50, 0], [50, S.sockTop + 2], [0, S.sockTop + 2]]);
    const lidNew = added(overhangs(own(part.intersect(near)), 0.1, S.sockTop + 1.8), overhangs(own(b.carved.lids[0].solid.intersect(near)), 0.1, S.sockTop + 1.8));
    expect(lidNew.filter((o) => o.width > 1.7)).toHaveLength(6);
    for (const o of lidNew) expect(o.width).toBeLessThanOrEqual(2);
    // the body stands as modelled: under the face only the collar's steps and the lugs' shoulders hang out, under
    // half a millimetre; the dome's own underside, over the collar now, no longer does
    const under = rev([[0, -12], [50, -12], [50, S.H + 0.3], [0, S.H + 0.3]]);
    const plainUnder = overhangs(own(b.carved.body.intersect(under)), -12, S.H);
    const bodyUnder = overhangs(own(body.intersect(under)), -12, S.H);
    const bodyNew = added(bodyUnder, plainUnder);
    expect(bodyNew.length).toBeGreaterThan(0);
    for (const o of bodyNew) expect(o.width).toBeLessThanOrEqual(0.5);
    expect(added(plainUnder, bodyUnder).some((o) => o.width > 3)).toBe(true);
  });

  it("bridges its click tabs' slits no further than the print note says: the roof over each, along its middle", () => {
    // the slit over each tab, cut through to the outside of the slots' arms: an island a tab, its length round the axis
    // at the middle of the strip the roof spans – 10.4 mm at 300 %, a wide nozzle's longer tab more
    for (const [n, hl, r0, long] of [[0.4, 0.2, 15.88, 10.41], [0.4, 0.2, 23.71, 10.21], [0.6, 0.3, 23.71, 12.97]]) {
      const S = sizes(n, hl, 0.15);
      const L = twistLockSolids(S, r0);
      [L.neck, L.lugs, L.grooves, L.cutters, L.disc, L.ridges].forEach(own);
      const rs = r0 + S.c;
      const ro = rs + S.td + S.g;
      const band = own(own(wasm.CrossSection.circle(ro - 0.05, 720)).subtract(own(wasm.CrossSection.circle(r0 + 2 * S.c + S.e + 0.05, 720))));
      const roofs = own(own(L.cutters.slice(S.b + S.gTop - 0.05)).intersect(band)).decompose().map(own);
      expect(roofs).toHaveLength(L.layout.tabs.length);
      for (const roof of roofs) {
        const points = roof.toPolygons().flat();
        const mid = Math.atan2(points.reduce((a, p) => a + p[1], 0), points.reduce((a, p) => a + p[0], 0));
        const off = points.map(([x, y]) => Math.atan2(x * Math.sin(-mid) + y * Math.cos(-mid), x * Math.cos(-mid) - y * Math.sin(-mid)));
        expect((Math.max(...off) - Math.min(...off)) * (rs + ro) / 2).toBeCloseTo(slitBridge(S, r0).long, 2);
      }
      expect(slitBridge(S, r0)).toEqual({ long: expect.closeTo(long, 2), across: r4(S.td + S.g) });
    }
  });

  it('a looser clearance gives a smaller neck that still fits, its face a layer up; at 200 % no tab fits, and nothing is drilled', () => {
    const b = built(bat(4), LID[4], { S: sizes(0.4, 0.2, 0.3) });
    expect(b.got.lock).toMatchObject({ mech: 'twist', theta: 19, tabs: 6 });
    expect(b.got.lock.r0).toBeLessThan(23.71);
    expect([b.body, b.part].map((x) => x.decompose().map((y) => (y.delete(), 1)).length)).toEqual([1, 1]);
    const near = own(b.body.intersect(rev([[0, -16], [40, -16], [40, 16], [0, 16]])));
    expect(overlap(near, b.part)).toBeLessThan(1e-9);
    expect(fitAt(near, b.rigid, 0, b.lock.S.cz + 0.1)).toBeGreaterThan(0.3);
    expect(fitAt(near, b.part, b.lock.theta, 0)).toBeLessThan(1e-9);
    expect(fitAt(near, b.part, b.lock.theta / 2, 0)).toBeGreaterThan(0.1);
    // at c 0.4 the rim needs 1.4 mm to the legs: the face goes up a layer, and the lock the table offers there is built
    const m3 = bat(3);
    const loose = built(m3, LID[3], { S: sizes(0.4, 0.2, 0.4) });
    expect(loose.got.z0).toBeCloseTo(0.2, 9);
    expect(loose.got.lock).toMatchObject({ mech: 'twist', r0: 14.98, opening: 26.76, theta: 30, tabs: 3 });
    expect(findParts(m3, { c: 0.4 }).parts.find((e) => e.kind === 'lid').lock).toMatchObject({ r0: 14.98, theta: 30, tabs: 3 });
    expect(lockPieces(loose.part, loose.lock)).toBe('whole');
    // at 200 % the neck (r0 8.09) has no room for a click tab in every gap: no lock, and the lid lifts off as carved
    const small = built(bat(2), { z0: 57.4, R: 15.752 });
    expect(small.got.lock).toEqual({ mech: null, why: 'tabs' });
    expect(small.plan.locks).toEqual([]);
    expect(volume(small.part)).toBeCloseTo(volume(small.carved.lids[0].solid), 6);
  });

  it("is built from the layout's own numbers: each primitive revolved at 160 segments a turn, the key lug first", () => {
    const S = sizes();
    const L = twistLockSolids(S, 21.39);
    for (const x of [L.neck, L.lugs, L.grooves, L.cutters, L.disc, L.ridges]) own(x);
    expect(L.layout.tabs.map((t) => +t.psi.toFixed(2))).toEqual([16.02, 49.54, 134.01, 167.53, 254.01, 287.53]);
    expect([L.rn, L.rs, +L.rf.toFixed(6), L.theta]).toEqual([19.79, 21.54, 22.19, 20]);
    // the neck is a 160-gon ring from the bore to r0, 0.5 under the face to H
    const nb = L.neck.boundingBox();
    expect(nb.min[2]).toBe(-0.5);
    expect(nb.max[2]).toBeCloseTo(S.H, 6);
    expect(Math.max(nb.max[0], nb.max[1])).toBeCloseTo(21.39, 6);
    // five edges of its outline, each swept round in 160 steps
    expect(L.neck.numTri()).toBe(5 * 2 * LOCK_SEGMENTS);
    // the full disc: a 160-gon on the socket's face, from under the bed to the socket's ceiling
    expect(volume(L.disc)).toBeCloseTo((LOCK_SEGMENTS / 2) * 21.54 ** 2 * Math.sin((2 * Math.PI) / LOCK_SEGMENTS) * (S.sockTop + 1), 3);
    // every primitive's id, and none twice
    expect(new Set(L.ids).size).toBe(L.ids.length);
    expect(L.ids.length).toBeGreaterThan(40);
  });
});

describe('the twist-lock\'s fit test', () => {
  it('is the lock on two small rings: one piece each, seated, held pulled, clicked half-way, free turned to its entry', () => {
    const S = sizes();
    const { body, lid, d } = twistCoupon(S, 23.71, { theta: 18 });
    own(body);
    own(lid);
    // two lines and 1.2 mm past the slits behind the click tabs
    expect(d).toBeCloseTo(2 * (23.71 + S.c + S.td + S.g + S.skin + 1.2), 9);
    expect([body, lid].map((x) => x.decompose().map((y) => (y.delete(), 1)).length)).toEqual([1, 1]);
    // each stands on the bed: the body on its ring, the neck up; the lid on its cut face
    expect(body.boundingBox().min[2]).toBeCloseTo(0, 6);
    expect(lid.boundingBox().min[2]).toBeCloseTo(0, 6);
    const neck = own(body.translate([0, 0, -12 * S.hl]));
    expect(overlap(neck, lid)).toBe(0);
    // pulled the axial play and a tenth, the lugs hold it; half-way round the ridges click over the neck; at its
    // entry, turned θ, it lifts off
    const L = twistLockSolids(S, 23.71, { theta: 18 });
    for (const x of [L.neck, L.lugs, L.grooves, L.cutters, L.disc, L.ridges]) own(x);
    const rigid = own(lid.subtract(L.ridges));
    expect(fitAt(neck, rigid, 0, S.cz + 0.1)).toBeGreaterThan(0.3);
    expect(fitAt(neck, lid, 9, 0)).toBeGreaterThan(0.1);
    for (let dz = 0; dz <= S.H + 1; dz += 0.5) expect(fitAt(neck, lid, 18, dz)).toBe(0);
  });
});

describe("the base's fit test", () => {
  it('is the plug lock on a ring and a short plug: one piece each, seated, held pulled down, turned free, clicked, out at the entry – as the real lock is', () => {
    // the real lock's own numbers at 300 % and 400 % (the base's plug twist-lock, below): the coupon is the same lock
    const want = {
      21.4: { theta: 23, pulled: 1.4108, click: 0.519, wrong: 28.7382, d: 56.2 },
      28.8: { theta: 17, pulled: 1.4031, click: 0.5233, wrong: 28.585, d: 74.8 },
    };
    const S = sizes();
    for (const [R, w] of Object.entries(want).map(([r, x]) => [+r, x])) {
      const { body, plug, d } = plugCoupon(S, R);
      own(body);
      own(plug);
      expect(d).toBe(w.d);
      expect([body, plug].map((x) => x.decompose().map((y) => (y.delete(), 1)).length)).toEqual([1, 1]);
      // clean as a slicer reads it
      expect([stlCheck(body), stlCheck(plug)]).toEqual([{ degenerate: 0, open: 0 }, { degenerate: 0, open: 0 }]);
      // each stands on its bottom on the bed, as the lantern and its base print, as tall as the lock and a millimetre over
      const h = Math.ceil((plugDims(S, R).top + 1) / S.hl - 1e-9) * S.hl;
      for (const x of [body, plug]) expect([x.boundingBox().min[2], x.boundingBox().max[2]]).toEqual([0, expect.closeTo(h, 6)]);
      // the plug before its click's ridges go on: the lock's own fit
      const L = lockSolids({ mech: 'plug', S, R, top: h });
      for (const x of [L.body.cut, L.part.add, L.part.cut, L.part.after]) own(x);
      const rigid = own(plug.subtract(L.part.after));
      expect(overlap(body, plug)).toBeLessThan(1e-9);
      expect(r4(fitAt(body, rigid, 0, -0.3))).toBeCloseTo(w.pulled, 3);
      for (let phi = 0; phi <= w.theta; phi += 1) expect(fitAt(body, rigid, -phi, 0)).toBeLessThan(1e-9);
      expect(fitAt(body, plug, -w.theta, 0)).toBeLessThan(1e-9);
      expect(r4(fitAt(body, plug, -w.theta / 2, 0))).toBeCloseTo(w.click, 3);
      for (let dz = -0.25; dz >= -(h + 1); dz -= 0.25) expect(fitAt(body, rigid, -w.theta, dz)).toBeLessThan(1e-9);
      expect(r4(fitAt(body, rigid, w.theta, 0))).toBeCloseTo(w.wrong, 2);
      // printed on their bottoms, nothing hangs out more than a layer's slope: no support
      for (const x of [body, plug]) for (const o of overhangs(x, 0.1, h)) expect(o.width).toBeLessThanOrEqual(0.25);
      // the coin slot across the plug's bottom: 2.4 wide, along X, a millimetre inside the tabs' slits
      const strip = (z, x0, x1, wd) => own(own(plug.slice(z)).intersect(own(wasm.CrossSection.square([x1 - x0, wd]).translate([x0, -wd / 2])))).area();
      const half = plugDims(S, R).coin / 2;
      expect(strip(0.6, -half + 0.1, half - 0.1, 2.3)).toBe(0);
      expect(strip(0.6, -half + 0.1, half - 0.1, 3)).toBeGreaterThan(1);
      // the ring as thin as the plug rule lets a body be round this bore: a tenth of a millimetre less spreads before
      // three times the plug's hold
      const out = d / 2;
      expect(out).toBe(plugRing(S, R));
      expect(camOut(S, R, plugDims(S, R), out - 0.1)).toBeLessThan(3 * Math.round(plugHold(S)));
    }
  });

  it('is light: a few grams more than its ring, the plug a band inside its tabs with a bar across for the coin', () => {
    const S = sizes();
    const { body, plug } = plugCoupon(S, 21.4);
    own(body);
    own(plug);
    const solidDisc = rev([[0, 0], [21.25, 0], [21.25, 6.4], [0, 6.4]]);
    expect(plug.volume()).toBeLessThan(0.5 * solidDisc.volume());
    expect(Math.round((body.volume() + plug.volume()) * 1.24e-3)).toBe(12);
    // the middle is open: nothing at the axis but the bar, nothing over the bar
    expect(solidAt(plug, [0, 8], 1)).toBe(false);
    expect(solidAt(plug, [8, 0], 4)).toBe(false);
    expect(solidAt(plug, [8, 2], 1)).toBe(true);
  });
});

describe("the base's plug twist-lock, on the fixture", () => {
  it('locks at 300 % and 400 %: one piece each, seated, held pulled down, turned free, clicked, out at the entry', () => {
    const want = {
      3: { R: 21.4, theta: 23, wall: 5.68, camOutN: 1840, pulled: 1.4108, click: 0.519, wrong: 28.7382, coin: 36.5 },
      4: { R: 28.8, theta: 17, wall: 7.63, camOutN: 1858, pulled: 1.4031, click: 0.5233, wrong: 28.585, coin: 51.3 },
    };
    for (const s of [3, 4]) {
      const w = want[s];
      const b = built(bat(s), BASE[s]);
      const { got, body, part, rigid } = b;
      const { theta } = got.lock;
      expect(got).toMatchObject({ ok: true, kind: 'plug', name: 'Base', way: { up: true, lift: 0 } });
      expect(got.lock).toMatchObject({ mech: 'plug', R: w.R, opening: 2 * w.R, theta: w.theta, tabs: 3, camOutN: w.camOutN, coin: w.coin, zl: 2.8 });
      expect(got.lock.wall).toBeCloseTo(w.wall, 2);
      expect([body, part].map((x) => x.decompose().map((y) => (y.delete(), 1)).length)).toEqual([1, 1]);
      // as a slicer reads them, the lock leaves no sliver of no area in either piece: its entries' mouths run on into
      // the entries, and the coin slot and its gable are one solid
      expect(stlCheck(part)).toEqual({ degenerate: 0, open: 0 });
      expect(stlCheck(body)).toEqual(stlCheck(b.carved.body));
      const near = own(body.intersect(rev([[0, -2], [w.R + 14, -2], [w.R + 14, 30], [0, 30]])));
      expect(overlap(near, part)).toBe(0);
      // pulled down 0.3 mm the lugs bear on the body's 45° ledges: held
      expect(r4(fitAt(near, rigid, 0, -0.3))).toBeCloseTo(w.pulled, 3);
      // it locks turning anticlockwise seen from above – clockwise as one fits it, the lantern upside down – so it is
      // free turned back clockwise to its entry, clicks between, and drops out there
      for (let phi = 0; phi <= theta; phi += 1) expect(fitAt(near, rigid, -phi, 0)).toBe(0);
      expect(fitAt(near, part, -theta, 0)).toBe(0);
      expect(r4(fitAt(near, part, -theta / 2, 0))).toBeCloseTo(w.click, 3);
      for (let dz = -0.25; dz >= -(got.lock.zl + 4); dz -= 0.25) expect(fitAt(near, rigid, -theta, dz)).toBe(0);
      expect(r4(fitAt(near, rigid, theta, 0))).toBeCloseTo(w.wrong, 2);
    }
  });

  it('adds no overhang and no bridge, keeps its wall clear of the bore, and has a coin slot across its bottom', () => {
    const b = built(bat(3), BASE[3]);
    const { lock, part, body } = b;
    const S = lock.S;
    // printed on its bottom, nothing the plug's lock makes hangs out more than a layer's slope; nor does the body's,
    // standing on its own
    const plainPlug = overhangs(own(b.carved.lids[0].solid.intersect(rev([[0, -1], [40, -1], [40, 9], [0, 9]]))), 0.1, 8);
    const plug = overhangs(own(part.intersect(rev([[0, -1], [40, -1], [40, 9], [0, 9]]))), 0.1, 8);
    for (const o of plug) expect(o.width).toBeLessThanOrEqual(0.25);
    expect(plug.length).toBeGreaterThanOrEqual(plainPlug.length);
    for (const o of overhangs(own(body.intersect(rev([[0, -1], [40, -1], [40, 9], [0, 9]]))), 0.1, 8)) expect(o.width).toBeLessThanOrEqual(0.25);
    // its bottom edge has a 45° mouth: 0.1 mm up, 0.2 mm in from its face is air, at a lug and between them
    const rp = lock.R - S.c;
    for (const a of [90, 120]) {
      expect(solidPolar(part, rp - 0.2, a, 0.1)).toBe(false);
      expect(solidPolar(part, rp - 0.2, a, 2)).toBe(true);
    }
    // between its lugs the plug is turned down to its wall's gap, R − c, so it goes into the bore as printed
    const mid = own(part.slice(1.4));
    const bb = mid.bounds();
    expect(Math.max(...bb.max, ...bb.min.map((v) => -v))).toBeLessThanOrEqual(lock.R - S.c + 0.01);
    // the coin slot runs along X, 36.5 mm long: 2.4 wide between vertical walls 1.2 high, then a 45° gable to 2.4
    const strip = (z, x0, x1, w) => own(own(part.slice(z)).intersect(own(wasm.CrossSection.square([x1 - x0, w]).translate([x0, -w / 2])))).area();
    expect(strip(0.6, -18.2, 18.2, 2.3)).toBe(0);
    expect(strip(0.6, 18.4, 19, 2.3)).toBeGreaterThan(0.1);
    expect(strip(1.8, -10, 10, 1.1)).toBe(0);
    expect(strip(1.8, -10, 10, 1.4)).toBeGreaterThan(0);
    expect(strip(2.5, -10, 10, 0.2)).toBeGreaterThan(3);
  });

  it('is laid out as the plug layout says, mirrored: lugs at −30° − 120k, the key lug first, three tabs between', () => {
    const S = sizes();
    const P = plugLockSolids(S, 21.4);
    for (const x of [P.lugs, P.bodyCut, P.plugCut, P.ridges]) own(x);
    const L = plugLayoutOk(S, 21.4);
    expect(P.layout).toEqual(L);
    expect(L.lugs.map((x) => Math.round(x.phi))).toEqual([330, 210, 90]);
    // each lug where the layout says: the plug sliced through the lugs' tips, outside its own face
    const cs = own(own(P.lugs.slice(L.lugs.length && 3.3)).intersect(own(own(wasm.CrossSection.circle(23, 720)).subtract(own(wasm.CrossSection.circle(21.5, 720))))));
    const at = cs.decompose().map((p) => {
      const bb = p.bounds();
      const a = (Math.atan2((bb.min[1] + bb.max[1]) / 2, (bb.min[0] + bb.max[0]) / 2) * 180) / Math.PI;
      p.delete();
      return Math.round((a + 360) % 360);
    }).sort((a, b) => a - b);
    expect(at).toEqual([90, 210, 330]);
  });

  it('a base that lifts off gets only its wall\'s gap: it drops in and out of the bore as printed', () => {
    const b = built(bat(3), BASE[3], { S: sizes() });
    // as a part whose hold is to lift off: no lock sized, the plain plug turned down by the clearance
    const plain = { ...b.lock, mech: null };
    const plan = { dowels: [], pegs: [], lips: [], labels: [], locks: [plain] };
    const part = own(drillPiece(b.carved.lids[0].solid, plan, 2));
    const body = own(drillPiece(b.carved.body, plan, 1));
    expect(volume(body)).toBeCloseTo(volume(b.carved.body), 6);
    const bb = part.boundingBox();
    expect(Math.max(...bb.max.slice(0, 2), ...bb.min.slice(0, 2).map((v) => -v))).toBeLessThanOrEqual(21.4 - 0.15 + 0.01);
    expect(overlap(body, part)).toBe(0);
    // it drops straight out, and nothing is cut in it but the gap
    expect(fitAt(body, part, 0, -2)).toBe(0);
    expect(volume(b.carved.lids[0].solid) - volume(part)).toBeCloseTo(volume(own(b.carved.lids[0].solid.subtract(rev([[0, -3], [21.25, -3], [21.25, 60], [0, 60]])))), 3);
  });
});

describe('when the lock meets something else', () => {
  it('takes the full disc for its socket where the ring leaves bits inside the bore: the round lantern\'s eave', () => {
    const model = own(roundLanternSolid());
    // at z 150 the face runs through the eave: the ring socket leaves a sliver of it loose inside the bore
    const ring = built(model, { z0: 150, R: 80 });
    expect(ring.got).toMatchObject({ kind: 'full', lock: { mech: 'twist', theta: 10, tabs: 6, slope: 1, hang: 0 } });
    expect(ring.got.lock.r0).toBeCloseTo(44.02, 2);
    expect(ring.part.decompose().map((y) => (y.delete(), 1)).length).toBe(2);
    expect(lockPieces(ring.part, ring.lock)).toBe('bore');
    const disc = built(model, { z0: 150, R: 80 }, { socket: 'disc' });
    expect(lockPieces(disc.part, disc.lock)).toBe('whole');
    const near = own(disc.body.intersect(rev([[0, -12], [60, -12], [60, 12], [0, 12]])));
    expect(overlap(near, disc.part)).toBe(0);
    expect(r4(fitAt(near, disc.rigid, 0, disc.lock.S.cz + 0.1))).toBeCloseTo(0.7578, 3);
    expect(fitAt(near, disc.part, disc.lock.theta, 0)).toBe(0);
    // under the eave, a 3 mm wall: the ring is enough. The neck is held to the wall under the eave, its slits' mouths
    // 2n inside it (the top corners alone, in the eave, allowed 42.43 and left the slits 0.54 mm from the outside)
    const low = built(model, { z0: 146.6, R: 80 });
    expect(low.got.lock.r0).toBeCloseTo(41.72, 2);
    expect(lockPieces(low.part, low.lock)).toBe('whole');
    // the wall under it is upright, so the collar slopes out at 45°: 1.5 mm down it reaches 0.3 mm past its bore
    const rn = low.got.lock.rn;
    expect(solidPolar(low.body, rn + 0.4, 30, -1.5)).toBe(true);
    expect(solidPolar(low.body, rn + 0.4, 30, -1.7)).toBe(false);
  });

  it('fills a pocket the collar seals against the model under it, and keeps the model\'s own sealed hollows', () => {
    const { Manifold } = wasm;
    const tube = (h, rin, rout, z) => own(own(own(Manifold.cylinder(h, rout, rout, 96)).subtract(own(Manifold.cylinder(h + 0.02, rin, rin, 96).translate([0, 0, -0.01])))).translate([0, 0, z]));
    // a cup with a gutter just under its rim and a thick lid on it; a hollow sealed in the lid's foot, far from the lock
    const bits = [
      tube(30, 19, 21, 0), tube(0.5, 16.6, 19, 15), tube(3, 16.6, 17.1, 15.5), own(Manifold.cylinder(2, 21, 21, 96).translate([0, 0, 30])),
    ];
    const solid = own(own(Manifold.union(bits)).subtract(own(Manifold.cube([2, 2, 2], true).translate([0, 18, 10]))));
    const sealed = own(Manifold.union([solid, own(Manifold.cube([4, 4, 4], true).translate([0, 18, 10]))]));
    const hollow = own(sealed.subtract(own(Manifold.cube([2, 2, 2], true).translate([0, 18, 10]))));
    const shells = (m) => {
      const out = { solids: 0, hollows: 0 };
      for (const x of m.decompose()) {
        if (x.volume() > 0) out.solids++;
        else out.hollows++;
        x.delete();
      }
      return out;
    };
    expect(shells(hollow)).toEqual({ solids: 1, hollows: 1 });
    const b = built(hollow, { z0: 20, R: 25 });
    expect(b.got.lock).toMatchObject({ mech: 'twist', slope: 1, hang: 0 });
    // the collar lands on the cup's wall and roofs the gutter over: the air left under it is filled, the model's own
    // hollow kept
    expect(shells(b.body)).toEqual({ solids: 1, hollows: 1 });
    const unfilled = own(b.carved.body.add(own(lockSolids(b.lock).body.add)));
    expect(shells(unfilled)).toEqual({ solids: 1, hollows: 2 });
    expect(volume(b.body)).toBeGreaterThan(volume(unfilled) + 1);
    // the lid is a tube like the cup: its socket ring fills its inside from the socket out, 4 mm over the socket's ceiling
    const rs = b.got.lock.rs;
    expect(solidPolar(b.part, (rs + 19) / 2, 30, b.lock.S.sockTop + 3)).toBe(true);
    expect(solidPolar(b.part, (rs + 19) / 2, 30, b.lock.S.sockTop + 5)).toBe(false);
  });

  it('puts no collar where no wall goes round the axis under the face to carry it: a stool\'s seat on its legs', () => {
    const { Manifold } = wasm;
    const legs = [[12, 0], [-12, 0], [0, 12], [0, -12]].map(([x, y]) => own(Manifold.cylinder(10, 2, 2, 32).translate([x, y, 0])));
    const stool = own(Manifold.union([...legs, own(Manifold.cylinder(6, 20, 20, 96).translate([0, 0, 10]))]));
    const b = built(stool, { z0: 10, R: 25 });
    expect(b.got).toMatchObject({ ok: true, kind: 'full' });
    expect(b.got.lock).toEqual({ mech: null, why: 'collar' });
    expect(b.plan.locks).toEqual([]);
  });

  it("tells loose bits in the bore, which the full disc takes, from a part the socket cuts in two", () => {
    const { Manifold } = wasm;
    // a tube with a web across it and a column on the web: the socket cuts the web where it meets the tube
    const parts = [
      own(own(Manifold.cylinder(40, 24, 24, 96)).subtract(own(Manifold.cylinder(40.02, 20, 20, 96).translate([0, 0, -0.01])))),
      own(Manifold.cylinder(2, 20.5, 20.5, 96).translate([0, 0, 20.5])), own(Manifold.cylinder(17.5, 10, 10, 96).translate([0, 0, 22.5])),
    ];
    const b = built(own(Manifold.union(parts)), { z0: 20, R: 26 });
    expect(b.got.lock).toMatchObject({ mech: 'twist' });
    expect(b.part.decompose().map((y) => (y.delete(), 1)).length).toBe(2);
    expect(lockPieces(b.part, b.lock)).toBe('pieces');
  });

  it('a square box\'s collar ends where it meets the box\'s outside, inset by the skin: its inside corners are further out', () => {
    const { Manifold } = wasm;
    const box = own(own(Manifold.cube([40, 40, 26], true)).translate([0, 0, 13]));
    const inside = own(own(Manifold.cube([36, 36, 20.02], true)).translate([0, 0, 10]));
    const b = built(own(box.subtract(inside)), { z0: 20, R: 30 });
    // the neck 0.3 narrower than its slits' faces alone allow, for their mouths at the bed: the collar lands lower
    expect(b.got.lock).toMatchObject({ mech: 'twist', r0: 16.75, slope: 1, hang: 0, reach: 5.25 });
    expect([b.body, b.part].map((x) => x.decompose().map((y) => (y.delete(), 1)).length)).toEqual([1, 1]);
    expect(lockPieces(b.part, b.lock)).toBe('whole');
  });

  it("a base too thin over its lock takes none, and a solid one is no floor; the plug's gap is cut all the same", () => {
    const { Manifold } = wasm;
    const cup = own(own(Manifold.cylinder(20, 15, 15, 96)).subtract(own(Manifold.cylinder(20, 12, 12, 96).translate([0, 0, 3]))));
    const b = built(cup, { z0: 0, R: 10 });
    expect(b.got).toMatchObject({ ok: true, kind: 'plug', lock: { mech: null, why: 'floor' } });
    expect(b.plan.locks).toHaveLength(1);
    expect(volume(b.part)).toBeLessThan(volume(b.carved.lids[0].solid) - 1);
    const rod = own(Manifold.cylinder(20, 15, 15, 96));
    const stack = sliceStack(rod);
    expect(plugLockOf(stack, fineSlices(rod, stack.speck * FINE_SPECK), [0, 0], 10, sizes(), 0)).toEqual({ R: 10, why: 'floor' });
  });

  it('turns the part to its open angle before it slides out: a bar goes through a gate one way round only', () => {
    const { Manifold } = wasm;
    // a bar 3 mm wide and 10 long, its centre at (5, 0); a gate 4 mm wide across its way out along +y
    const bar = own(own(Manifold.cube([3, 10, 2], true)).translate([5, 0, 1]));
    const gate = own(Manifold.union([own(Manifold.cube([18, 2, 10]).translate([-15, 8, 0])), own(Manifold.cube([18, 2, 10]).translate([7, 8, 0]))]));
    const way = { frame: null, c: [5, 0], z0: 0, lift: 1, dir: [0, 1], reach: 20 };
    expect(wayOverlaps(gate, bar, { ...way, turn: 0 }).clear).toBe(true);
    expect(wayOverlaps(gate, bar, { ...way, turn: 90 }).clear).toBe(false);
    // lifted, never lowered: at the start it is clear of a plate under its face
    const plate = own(Manifold.cube([40, 40, 1]).translate([-15, -20, -1]));
    expect(wayOverlaps(plate, bar, { ...way, turn: 0 }).overlaps[0]).toBe(0);
  });

  it('says where its lugs, slots and click tabs are, each on the piece it is part of, for the words the view puts on them', () => {
    const b = built(bat(3), LID[3]);
    const points = lockPoints(b.lock);
    const of = (name) => points.filter((x) => x.name === name);
    expect(of('lug').length).toBe(3);
    expect(of('slot').length).toBe(3);
    expect(of('click tab').length).toBe(b.lock.S ? layout(b.lock.S, b.lock.r0, { theta: b.lock.theta }).tabs.length : 0);
    expect(of('lug').every((x) => x.on === 'body') && [...of('slot'), ...of('click tab')].every((x) => x.on === 'part')).toBe(true);
    // a lug and a click tab are material of their piece, a slot is the air the lug turns in
    const { Manifold } = wasm;
    const inside = (m, at) => !own(m.intersect(own(Manifold.cube([0.2, 0.2, 0.2], true).translate(at)))).isEmpty();
    expect(of('lug').every((x) => inside(b.body, x.at))).toBe(true);
    expect(of('click tab').every((x) => inside(b.part, x.at))).toBe(true);
    expect(of('slot').some((x) => inside(b.part, x.at))).toBe(false);
    expect(of('slot').every((x) => inside(own(b.part.hull()), x.at))).toBe(true);
  });

  it("marks the lock's own faces: each piece's mesh keeps its primitives' ids through the drilling", () => {
    const b = built(bat(3), LID[3]);
    const ids = new Set(lockIds(b.lock));
    expect(ids.size).toBeGreaterThan(40);
    expect(new Set(b.marks.body)).toEqual(ids);
    expect(new Set(b.marks.part)).toEqual(ids);
    const runsOf = (m) => {
      const mesh = m.getMesh();
      const runs = new Map();
      for (let r = 0; r < mesh.runOriginalID.length; r++) {
        const tris = (mesh.runIndex[r + 1] - mesh.runIndex[r]) / 3;
        if (ids.has(mesh.runOriginalID[r])) runs.set(mesh.runOriginalID[r], (runs.get(mesh.runOriginalID[r]) ?? 0) + tris);
      }
      return runs;
    };
    // the body's neck, lugs and collar; the lid's socket, slots, tabs and ridges
    const body = runsOf(b.body);
    const part = runsOf(b.part);
    expect(body.size).toBeGreaterThan(5);
    expect(part.size).toBeGreaterThan(10);
    expect([...body.values()].reduce((x, y) => x + y, 0)).toBeGreaterThan(500);
    expect([...part.values()].reduce((x, y) => x + y, 0)).toBeGreaterThan(500);
    // the model's own faces carry none of them
    expect(runsOf(b.carved.body).size).toBe(0);
    // what carries the lock – the collar, the socket ring – told from the lock itself, for the view to paint lighter;
    // and its lugs, painted apart so they stand out of the neck: on the body only
    const faces = lockFaces(b.lock);
    expect(faces.carry.length).toBeGreaterThan(0);
    expect(faces.lug.length).toBeGreaterThan(0);
    expect(new Set([...faces.lock, ...faces.carry, ...faces.lug])).toEqual(ids);
    expect(faces.lock.some((id) => faces.carry.includes(id) || faces.lug.includes(id))).toBe(false);
    expect(faces.lug.some((id) => faces.carry.includes(id))).toBe(false);
    expect(faces.lug.reduce((n, id) => n + (body.get(id) ?? 0), 0)).toBeGreaterThan(50);
    expect(faces.lug.some((id) => part.has(id))).toBe(false);
    // the view's buffers mark those runs' triangles, neighbouring runs of one mark joined, and the pieces view lays each
    // piece's marks after the pieces before it
    const marks = new Map([...faces.lock.map((id) => [id, 0]), ...faces.carry.map((id) => [id, 1]), ...faces.lug.map((id) => [id, 2])]);
    const total = (ranges, m = null) => ranges.filter((x) => m == null || x[2] === m).reduce((n, x) => n + x[1], 0);
    const own = displayBuffers(b.body, null, marks);
    expect(total(own.markRanges)).toBe([...body.values()].reduce((x, y) => x + y, 0));
    expect(total(own.markRanges, 0)).toBeGreaterThan(500);
    expect(total(own.markRanges, 1)).toBeGreaterThan(100);
    for (let i = 1; i < own.markRanges.length; i++) {
      const [p, q] = [own.markRanges[i - 1], own.markRanges[i]];
      expect(q[0]).toBeGreaterThanOrEqual(p[0] + p[1]);
      expect(q[0] === p[0] + p[1] && q[2] === p[2]).toBe(false);
    }
    expect(displayBuffers(b.body).markRanges).toBeUndefined();
    expect(displayBuffers(b.carved.body, null, marks).markRanges).toEqual([]);
    const both = buildSplitDisplay([{ solid: b.body, marks }, { solid: b.part, marks }, { solid: b.carved.body }]);
    const [[, n1], [s2, n2]] = both.ranges;
    const lidOwn = displayBuffers(b.part, null, marks);
    expect(both.markRanges).toEqual([...own.markRanges, ...lidOwn.markRanges.map(([t, n, m]) => [t + s2, n, m])]);
    expect(both.markRanges.every(([t, n]) => t + n <= n1 || (t >= s2 && t + n <= s2 + n2))).toBe(true);
    // the collar is added flush with the body's face, so some of the face's triangles come out with its id: the view
    // gives those back to the face, and keeps the collar's own (under the face, out of its plane)
    const cls = new Uint8Array(own.index.length / 3);
    for (const [t, n, m] of own.markRanges) cls.fill(m + 2, t, t + n);
    const carried = () => cls.reduce((n, k) => n + (k === 3), 0);
    const onFace = () => {
      let n = 0;
      for (let t = 0; t < cls.length; t++) if (cls[t] === 3 && [0, 1, 2].every((k) => Math.abs(own.positions[own.index[t * 3 + k] * 3 + 2]) < 1e-3)) n++;
      return n;
    };
    const [was, wasOnFace] = [carried(), onFace()];
    expect(wasOnFace).toBeGreaterThan(10);
    expect(unmarkJoint(cls, 3, own.index, own.positions, [0, 0, 0], [0, 0, 1])).toBe(wasOnFace);
    expect([onFace(), carried()]).toEqual([0, was - wasOnFace]);
    expect(carried()).toBeGreaterThan(100);
    // the lock's own faces (class 2) are left alone, and a plane elsewhere takes nothing
    expect(unmarkJoint(cls, 2, own.index, own.positions, [0, 0, 0], [0, 0, 1])).toBe(0);
    expect(unmarkJoint(cls, 3, own.index, own.positions, [0, 0, -0.5], [0, 0, 2])).toBe(0);
  });

  it("paints none of a base's own outside: its wall, turned down to the bore's clearance, is no part of its lock", () => {
    const b = built(bat(3), BASE[3]);
    const faces = lockFaces(b.lock);
    const wall = lockIds(b.lock).filter((id) => !faces.lock.includes(id));
    expect([faces.carry, wall.length > 0]).toEqual([[], true]);
    // the plug's marked triangles: its lugs, slits, tabs, mouths and coin slot – hardly any of its wall at r = R − c
    const d = displayBuffers(b.part, null, new Map(faces.lock.map((id) => [id, 0])));
    const R = BASE[3].R;
    const marked = new Set(d.markRanges.flatMap(([t0, n]) => Array.from({ length: n }, (_, i) => t0 + i)));
    const area = { wall: 0, painted: 0 };
    let lugs = 0;
    for (let t = 0; t < d.index.length / 3; t++) {
      const p = [0, 1, 2].map((k) => [...d.positions.subarray(d.index[t * 3 + k] * 3, d.index[t * 3 + k] * 3 + 3)]);
      const r = p.map(([x, y]) => Math.hypot(x, y));
      if (marked.has(t) && r.some((x) => x > R)) lugs++;
      // a face of the wall: every corner on it
      if (!r.every((x) => Math.abs(x - (R - b.lock.S.c)) < 0.02)) continue;
      const [u, v] = [1, 2].map((k) => p[k].map((c, a) => c - p[0][a]));
      const a = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
      area.wall += a;
      if (marked.has(t)) area.painted += a;
    }
    expect(area.wall).toBeGreaterThan(500);
    expect(area.painted / area.wall).toBeLessThan(0.05);
    expect(lugs).toBeGreaterThan(20); // the lugs stand out past the bore
    expect(marked.size).toBeGreaterThan(300);
  });
});

/**
 * A full-plane cut through `model` at z = at, with the collar twist-lock in place of its lip as the layout sizes it
 * (`cutTwist`, the neck on the piece below) and the drill stage builds it on the two pieces, in the lock's frame (the
 * face at z = 0 on its axis). `rigid` is the top before its click's ridges go on.
 */
function fullBuilt(model, at, { S = sizes(), socket = 'ring' } = {}) {
  const { Manifold } = wasm;
  const bb = model.boundingBox();
  const cut = { axis: 2, at };
  const band = own(bandFor(model, cut, 12));
  const islands = own(band.slice(at)).decompose().map(own);
  const width = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]);
  const twist = cutTwist(band, cut, 0, islands[0], { S, rooms: [at - bb.min[2], bb.max[2] - at], minArea: (width * SPECK) ** 2 * FINE_SPECK });
  if (!twist) return { islands, twist };
  const lock = { cutId: 'c1', letter: 'A', ...twist, socket, sides: [{ piece: 1, role: 'body' }, { piece: 2, role: 'part' }] };
  const plan = { dowels: [], pegs: [], lips: [], labels: [], locks: [lock] };
  const half = (z0, z1) => own(model.intersect(own(Manifold.cube([300, 300, z1 - z0]).translate([-150, -150, z0]))));
  const [below, above] = [half(bb.min[2] - 1, at), half(at, bb.max[2] + 1)];
  const toFrame = (m) => own(m.translate([-twist.c[0], -twist.c[1], -at]));
  const drilled = [own(drillPiece(below, plan, 1)), own(drillPiece(above, plan, 2))];
  const [body, top] = drilled.map(toFrame);
  const L = lockSolids(lock);
  for (const x of [L.body.add, L.body.cut, L.part.after]) if (x) own(x);
  const rigid = own(own(toFrame(above).add(own(L.part.add))).subtract(own(L.part.cut)));
  return { islands, twist, lock, plan, below: toFrame(below), above: toFrame(above), body, top, rigid, L, drilled };
}

describe('the collar twist-lock on a full-plane cut through a round wall', () => {
  it("the round lantern cut through its eave at z 150: the full disc socket, one piece each, seated, held, turned free and clicked", () => {
    const model = own(roundLanternSolid());
    const ring = fullBuilt(model, 150);
    expect(ring.twist).toMatchObject({ mech: 'twist', kind: 'full', frame: null, z0: 150, theta: 10, tabs: 6, slope: 1, hang: 0 });
    expect(ring.twist.r0).toBeCloseTo(44.02, 2);
    expect(Math.hypot(...ring.twist.c)).toBeLessThan(1e-6);
    // the ring socket leaves the eave's inner sliver loose in the bore; the full disc takes it
    expect(lockPieces(own(ring.top.translate([0, 0, 150])), { ...ring.lock, z0: 150 })).toBe('bore');
    const b = fullBuilt(model, 150, { socket: 'disc' });
    const pieces = (m) => m.decompose().map((y) => (y.delete(), 1)).length;
    expect([pieces(b.body), pieces(b.top)]).toEqual([1, 1]);
    // as a slicer reads them, saved where they stand: no sliver of no area in either
    expect(b.drilled.map((m) => stlCheck(m))).toEqual([{ degenerate: 0, open: 0 }, { degenerate: 0, open: 0 }]);
    // the body gets the collar, the neck and the lugs; the top its socket ring, less the socket, slots and slits
    expect(volume(b.body)).toBeGreaterThan(volume(b.below) + 500);
    const near = own(b.body.intersect(rev([[0, -12], [60, -12], [60, 12], [0, 12]])));
    const { cz, H } = b.lock.S;
    expect(overlap(near, b.top)).toBe(0);
    expect(r4(fitAt(near, b.rigid, 0, cz + 0.1))).toBeCloseTo(0.7578, 3);
    for (let phi = 0; phi <= b.lock.theta; phi += 2) expect(fitAt(near, b.rigid, phi, 0)).toBe(0);
    expect(fitAt(near, b.top, b.lock.theta, 0)).toBe(0);
    expect(fitAt(near, b.top, b.lock.theta / 2, 0)).toBeGreaterThan(0.5);
    for (let dz = 0; dz <= H + 1; dz += 0.5) expect(fitAt(near, b.top, b.lock.theta, dz)).toBe(0);
    expect(fitAt(near, b.rigid, -b.lock.theta, 0)).toBeGreaterThan(0.5);
  });

  it('under the eave, a 3 mm wall: the ring socket is enough, and nothing it cuts comes within 2n of the outside', () => {
    const model = own(roundLanternSolid());
    const b = fullBuilt(model, 146.5);
    expect(b.twist).toMatchObject({ r0: 41.72, rn: 40.12, opening: 80.24, theta: 11, tabs: 6, slope: 1, reach: 3.25, hang: 0 });
    expect(lockPieces(own(b.top.translate([0, 0, 146.5])), { ...b.lock, z0: 146.5 })).toBe('whole');
    expect(b.drilled.map((m) => stlCheck(m))).toEqual([{ degenerate: 0, open: 0 }, { degenerate: 0, open: 0 }]);
    const near = own(b.body.intersect(rev([[0, -12], [60, -12], [60, 12], [0, 12]])));
    expect(overlap(near, b.top)).toBe(0);
    expect(fitAt(near, b.rigid, 0, b.lock.S.cz + 0.1)).toBeGreaterThan(0.3);
    expect(fitAt(near, b.top, b.lock.theta, 0)).toBe(0);
    expect(fitAt(near, b.rigid, -b.lock.theta, 0)).toBeGreaterThan(0.5);
    // the skin: the top's cutters within 2n of its outside (the profile it was sized on, revolved) – facets only
    const { above } = b.twist;
    const S = b.lock.S;
    const topZ = above[above.length - 1][1];
    const shell = rev([[above[0][0], -1], ...above, [above[above.length - 1][0], topZ], ...[...above].reverse().map(([r, z]) => [r - S.skin, z]), [above[0][0] - S.skin, -1]]);
    expect(overlap(b.L.part.cut, shell)).toBeLessThan(0.01);
    // and the body's additions – the collar under the face, the neck and lugs over it – stay inside its own outside, in
    // from it by the skin
    expect(volume(own(own(b.body.subtract(b.below)).subtract(rev([[0, -20], [45 - S.skin + 0.01, -20], [45 - S.skin + 0.01, S.H + 1], [0, S.H + 1]]))))).toBeLessThan(0.01);
  });

  it('takes none where no wall goes round the axis under the face to carry the collar: just over a row of windows', () => {
    const b = fullBuilt(own(roundLanternSolid()), 125.5);
    expect(b.islands).toHaveLength(1);
    expect(b.twist).toBeNull();
  });
});
