import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { manifold } from '../src/manifold.js';
import {
  AXES, FILAMENT, PIN_DIAMETERS, TO_PLANE, apartMales, applyMat4, chooseOrientation, isSymmetric, normaliseSplit, pegMales, pegSizesFor, sizesFor,
} from '../src/split.js';
import {
  bandFor,
  buildSplitDisplay,
  clearSplitCaches,
  cutPieces,
  dovetailCells,
  dovetailTabs,
  dowelHole,
  drillPiece,
  fitTestCoupon,
  halfHole,
  labelSolid,
  layoutSplit,
  lipAt,
  lipCavityAt,
  lipFor,
  lipFrame,
  lipRegions,
  lipSolids,
  overFor,
  pegAt,
  pegSolid,
  pinAt,
  pinSheet,
  pinSolid,
  pinSpares,
  pinsPerSheet,
  planDovetails,
  shadowFor,
  socketAt,
  socketSolid,
} from '../src/splitGeometry.js';
import { inter, setup } from './helpers.js';
import { box as boxAt, gothicSolid, lanternSolid, lift, overhangs, stlCheck } from './lanternFixture.js';

let wasm;
let font;
beforeAll(async () => {
  await setup();
  wasm = manifold();
  font = inter();
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

const BED = [210, 210, 249];
const boxOf = (m) => {
  const { min, max } = m.boundingBox();
  return { min: [...min], max: [...max], size: [0, 1, 2].map((a) => max[a] - min[a]) };
};
const cube = (size, at = [0, 0, 0]) => own(own(wasm.Manifold.cube(size, true)).translate(at));
const overlap = (a, b) => own(a.intersect(b)).volume();
const shells = (m) => {
  const list = m.decompose();
  list.forEach(own);
  return list;
};

/** Cuts as the document stores them, normalised against the solid: [axis, at] pairs, lettered in list order. */
function cutsFor(solid, list, patch = {}) {
  const stored = list.map(([axis, at], i) => {
    const position = [0, 0, 0];
    const normal = [0, 0, 0];
    position[axis] = at;
    normal[axis] = 1;
    return { id: `c${i + 1}`, position, normal };
  });
  return normaliseSplit({ cuts: stored, ...patch }, boxOf(solid));
}

/** The whole stage chain on a solid: plate test, pieces, each piece's way up on BED, pins and labels, drilling. */
function split(solid, list, patch = {}, { passthrough = false } = {}) {
  const { spec, cuts } = cutsFor(solid, list, patch);
  const plan = planDovetails(solid, cuts, spec, { passthrough });
  const cut = cutPieces(solid, cuts, { dove: plan.dove, tabs: plan.tabs });
  cut.pieces.forEach((p) => own(p.solid));
  const pieces = cut.pieces.map((p) => {
    const lying = chooseOrientation(p.stats, BED, spec.orient, { pieceIndex: p.index });
    return { ...p, lying, up: lying.up };
  });
  const males = spec.joint === 'pegs' ? pegMales(pieces, BED, spec.orient) : null;
  const layout = layoutSplit(solid, cuts, pieces, spec, { joints: plan.joints, tabs: plan.tabs, font, pegMales: males });
  const drilled = pieces.map((p) => own(drillPiece(p.solid, layout, p.index, { font })));
  return { spec, cuts, plan, cut, pieces, layout, drilled };
}

/** Both halves of every dowel's hole, in place. */
const holesOf = (layout) => layout.dowels.flatMap((d) => [0, 1].map((side) => ({ dowel: d, side, m: own(dowelHole(d, side)) })));

/** Every hole lies inside the model and keeps at least a wall's thickness from its outside. */
function expectHolesInside(solid, layout) {
  const b = boxOf(solid);
  const air = own(cube(b.size.map((v) => v + 40), b.min.map((v, a) => (v + b.max[a]) / 2)).subtract(solid));
  for (const { dowel, m } of holesOf(layout)) {
    const wall = sizesFor(dowel.d).wall;
    expect(own(m.subtract(solid)).volume()).toBeLessThan(1e-6);
    expect(m.minGap(air, wall + 1)).toBeGreaterThanOrEqual(wall - 1e-6);
  }
}

describe('holes and pins', () => {
  it('half-holes remove the verified volumes and leave a drilled block whole', () => {
    const above = cube([100, 100, 100], [0, 0, 50]);
    // exactly the designed shape's: the chamfer's frustum, the bore and the cone on the profile's own area
    for (const [D, depth, tear, volume] of [[5, 8, false, 209.9005], [5, 8, true, 224.6701], [6, 9.5, false, 348.1798], [6, 9.5, true, 372.6793]]) {
      const s = sizesFor(D);
      expect(s.depth).toBe(depth);
      const hole = own(halfHole({ R: s.R, h: s.h, ch: s.ch, tear }));
      expect(overlap(hole, above)).toBeCloseTo(volume, 3);
      const block = cube([40, 40, 30], [0, 0, 15]);
      const drilled = own(block.subtract(hole));
      expect(drilled.status()).toBe('NoError');
      expect(drilled.genus()).toBe(0);
      expect(shells(drilled)).toHaveLength(1);
    }
  });

  it('half-holes have no corners a hair apart, at any size and depth, so a piece\'s STL keeps no zero-area triangles', () => {
    const close = (m) => {
      const { vertProperties: P, numProp: k } = m.getMesh();
      let n = 0;
      for (let i = 0; i < P.length; i += k) for (let j = i + k; j < P.length; j += k) if (Math.hypot(P[i] - P[j], P[i + 1] - P[j + 1], P[i + 2] - P[j + 2]) < 1e-3) n++;
      return n;
    };
    for (const D of PIN_DIAMETERS) {
      for (const depth of [0, 10, 15, 20, 25, 30]) {
        const s = sizesFor(D, 0.15, 0.4, depth);
        for (const tear of [false, true]) expect(close(own(halfHole({ R: s.R, h: s.h, ch: s.ch, tear }))), `Ø${D} ${depth} mm ${tear}`).toBe(0);
      }
    }
  });

  it('pins have the verified sizes, and a pins sheet lays them on a flat side by side on the bed', () => {
    const s5 = sizesFor(5);
    expect(own(pinSolid({ r: s5.r, L: s5.pinLength, e: s5.pinChamfer })).volume()).toBeCloseTo(280.701, 3);
    const one = own(pinSheet({ d: 6, length: 19, count: 1 }, BED));
    expect(boxOf(one).size.map((v) => +v.toFixed(3))).toEqual([19, 5.543, 5.543]);
    expect(one.volume()).toBeCloseTo(481.066, 3);
    const sheet = own(pinSheet({ d: 5, length: 16, count: 3 }, BED));
    const pins = shells(sheet);
    expect(pins).toHaveLength(3);
    for (const p of pins) {
      expect(boxOf(p).size.map((v) => +v.toFixed(3))).toEqual([16, 4.619, 4.619]);
      expect(p.volume()).toBeCloseTo(280.701, 1);
    }
    const b = boxOf(sheet);
    expect(b.min[2]).toBeCloseTo(0, 6);
    expect(b.min[0] + b.max[0]).toBeCloseTo(0, 6);
    // a long run wraps to the bed's width
    const many = boxOf(own(pinSheet({ d: 5, length: 16, count: 30 }, BED)));
    expect(many.size[0]).toBeLessThanOrEqual(BED[0]);
    expect(many.size[1]).toBeGreaterThan(3 * 4.619);
    expect([1, 2, 4, 5, 8, 9].map(pinSpares)).toEqual([1, 1, 1, 2, 2, 3]);
  });

  it('a pins file holds no more pins than the bed takes lying as they are laid out', () => {
    // 60 Ø8 pins on a 110 mm bed (a 120 mm printer): rows of three, as many rows as the depth takes
    const U = [110, 110, 119];
    const { perSheet, size } = pinsPerSheet({ d: 8, length: 26 }, U);
    expect(size.map((v) => +v.toFixed(3))).toEqual([26, 7.391, 7.391]);
    expect(perSheet).toBe(3 * 10);
    const full = boxOf(own(pinSheet({ d: 8, length: 26, count: perSheet }, U)));
    expect(full.size[0]).toBeLessThanOrEqual(U[0]);
    expect(full.size[1]).toBeLessThanOrEqual(U[1]);
    // one more would need another row: the bed has no room for it
    expect(boxOf(own(pinSheet({ d: 8, length: 26, count: perSheet + 1 }, U))).size[1]).toBeGreaterThan(U[1]);
  });

  for (const tear of [false, true]) {
    it(`an octagonal pin keeps the clearance in a ${tear ? 'teardrop' : 'round'} hole at any turn, and never touches`, () => {
      const s = sizesFor(6);
      const dowel = {
        axis: 2, centre: [0, 0, 0], d: 6, depth: s.depth, R: s.R, h: s.h, ch: s.ch,
        sides: [{ piece: 1, tear, apex: tear ? [0, 1, 0] : null }, { piece: 2, tear, apex: tear ? [0, 1, 0] : null }],
      };
      const layout = { dowels: [dowel], labels: [] };
      const lower = own(drillPiece(cube([40, 40, 30], [0, 0, -15]), layout, 1));
      const upper = own(drillPiece(cube([40, 40, 30], [0, 0, 15]), layout, 2));
      let least = Infinity;
      let most = 0;
      let worst = 0;
      for (let deg = 0; deg <= 45; deg += 0.5) {
        const pin = own(pinAt(dowel, deg));
        const gap = Math.min(pin.minGap(lower, 1), pin.minGap(upper, 1));
        least = Math.min(least, gap);
        most = Math.max(most, gap);
        worst = Math.max(worst, overlap(pin, lower) + overlap(pin, upper));
      }
      expect(least).toBeGreaterThanOrEqual(0.15 - 1e-6);
      expect(least).toBeCloseTo(0.15, 4);
      expect(most).toBeCloseTo(0.1644, 4);
      expect(worst).toBe(0);
    });
  }

  it('a face printed on the bed with two round Ø5 holes slices to the verified areas', () => {
    const s = sizesFor(5);
    const dowel = (u, v) => ({ axis: 2, centre: [u, v, 0], d: 5, depth: s.depth, R: s.R, h: s.h, ch: s.ch, sides: [{ piece: 1, tear: false, apex: null }, { piece: 2, tear: false, apex: null }] });
    const block = cube([40, 30, 60], [0, 0, 30]);
    const drilled = own(drillPiece(block, { dowels: [dowel(-10, -5), dowel(10, 4)], labels: [] }, 2));
    const low = own(drilled.slice(0.05));
    const high = own(drilled.slice(0.6));
    expect(low.area()).toBeCloseTo(1139.424, 3);
    expect(high.area()).toBeCloseTo(1155.734, 3);
    expect(high.numContour()).toBe(3);
    expect(drilled.genus()).toBe(0);
    expect(block.volume() - drilled.volume()).toBeCloseTo(2 * 209.901, 2);
  });

  it('the fit test is an upright-hole block, a lying teardrop-hole block and a pin; filament has no pin, dovetails add two plates', () => {
    const coupon = own(fitTestCoupon({ diameter: 5, clearance: 0.15 }, 0.4));
    expect(coupon.status()).toBe('NoError');
    expect(shells(coupon)).toHaveLength(3);
    expect(boxOf(coupon).min[2]).toBeCloseTo(0, 6);
    const long = 8.5 + 2.65 + 2 + 2;
    expect(coupon.volume()).toBeCloseTo(2 * 24 * 24 * long - 209.901 - 224.670 + 280.701, 1);
    expect(shells(own(fitTestCoupon({ diameter: 1.75 }, 0.4)))).toHaveLength(2);
    expect(shells(own(fitTestCoupon({ diameter: 5, pins: 'own' }, 0.4)))).toHaveLength(2);
    const dove = own(fitTestCoupon({ diameter: 5, joint: 'dovetail' }, 0.4));
    expect(dove.status()).toBe('NoError');
    expect(shells(dove)).toHaveLength(5);
    // a split held by tabs alone tries just the tab in its socket
    const tabs = shells(own(fitTestCoupon({ diameter: 5 }, 0.4, { dovetail: true, pins: false })));
    expect(tabs.map((m) => +boxOf(m).size[2].toFixed(6))).toEqual([5, 5]);
  });
});

describe('built-in square pegs', () => {
  const p = pegSizesFor(6, 0.15, 0.4);
  const w = 6 + 2 * 0.15; // the socket's side
  const m = w + 2 * 0.5; // its mouth's, chamfer counted
  const lead = 6 - 2 * p.e; // the side of the peg's tip
  /** What a peg adds beyond its face, and what its socket takes from the other piece: from the shapes' sizes. */
  const pegOut = 36 * (p.length - p.e) + (p.e / 3) * (36 + lead * lead + 6 * lead);
  const socketIn = (0.5 / 3) * (m * m + w * w + m * w) + w * w * (p.h - 0.5) + (w * w * p.tip) / 3;
  /** A peg standing out of a face at x = 0 into the piece beyond it, at (y, z) = (10, 5). */
  const placed = { axis: 0, at: 0, centre: [0, 10, 5], dir: 1, ...p };
  /** The steepest a solid's faces look down for a piece lying with `up` up, leaving out those on the bed (n·up, −1 straight down). */
  function steepest(solid, up) {
    const { vertProperties: P, numProp, triVerts: T } = solid.getMesh();
    const at = (i, a) => P[T[i] * numProp + a];
    let bed = Infinity;
    for (let i = 0; i < T.length; i++) bed = Math.min(bed, [0, 1, 2].reduce((sum, a) => sum + at(i, a) * up[a], 0));
    let worst = 1;
    for (let t = 0; t < T.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => [0, 1, 2].map((x) => at(t + k, x)));
      const u = b.map((v, k) => v - a[k]);
      const v = c.map((x, k) => x - a[k]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(...n);
      const height = Math.max(...[a, b, c].map((q) => q[0] * up[0] + q[1] * up[1] + q[2] * up[2]));
      if (!(len > 0) || height <= bed + 1e-4) continue;
      worst = Math.min(worst, (n[0] * up[0] + n[1] * up[1] + n[2] * up[2]) / len);
    }
    return worst;
  }
  const ups = [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  it('a peg and its socket are whole solids: the peg s square with a lead-in, the socket s + 2c with its chamfer, room for glue and a point', () => {
    const peg = own(pegSolid(p));
    const socket = own(socketSolid(p));
    for (const solid of [peg, socket]) {
      expect(solid.status()).toBe('NoError');
      expect(solid.genus()).toBe(0);
      expect(shells(solid)).toHaveLength(1);
    }
    // a square turned 45°: its corners on x and y, 6 mm sides, from 0.5 mm inside the face out to its length
    const r = 3 * Math.SQRT2;
    expect(boxOf(peg).min.map((v) => +v.toFixed(6))).toEqual([-r, -r, -0.5].map((v) => +v.toFixed(6)));
    expect(boxOf(peg).max.map((v) => +v.toFixed(6))).toEqual([r, r, 9].map((v) => +v.toFixed(6)));
    expect(own(peg.slice(4)).area()).toBeCloseTo(36, 6);
    expect(peg.volume()).toBeCloseTo(36 * 0.5 + pegOut, 6);
    expect(socket.volume()).toBeCloseTo(m * m + socketIn, 6);
    // past the peg's tip the socket runs on at full size for 0.5 mm of glue, then closes to a point 3.15 mm on
    expect(own(peg.slice(9.25)).isEmpty()).toBe(true);
    expect(own(socket.slice(9.25)).area()).toBeCloseTo(w * w, 6);
    expect(own(socket.slice(0.25)).area()).toBeCloseTo((w + 0.5) ** 2, 6); // half way down the mouth's chamfer
    expect(boxOf(socket).max[2]).toBeCloseTo(p.h + p.tip, 9);
    expect(p.h - p.length).toBeCloseTo(0.5, 12);
  });

  it('a peg sits in its socket with the clearance on each side, and touches it nowhere', () => {
    const female = own(cube([30, 40, 40], [15, 10, 5]).subtract(own(socketAt(placed))));
    const peg = own(pegAt(placed));
    expect(female.status()).toBe('NoError');
    expect(female.volume()).toBeCloseTo(30 * 40 * 40 - socketIn, 4);
    expect(boxOf(peg).size.map((v) => +v.toFixed(6))).toEqual([9.5, 6 * Math.SQRT2, 6 * Math.SQRT2].map((v) => +v.toFixed(6)));
    expect(overlap(peg, female)).toBeLessThan(1e-9);
    expect(peg.minGap(female, 1)).toBeCloseTo(0.15, 6);
    // pushed square to each side a little less than the clearance it still clears; a little more and it hits
    for (const [dy, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const n = [0, dy * Math.SQRT1_2, dz * Math.SQRT1_2];
      expect(overlap(own(peg.translate(n.map((v) => v * 0.14))), female)).toBeLessThan(1e-9);
      expect(overlap(own(peg.translate(n.map((v) => v * 0.16))), female)).toBeGreaterThan(0.1);
    }
    // all the way in along its axis, with 0.5 mm to spare at the tip
    expect(overlap(own(peg.translate([0.49, 0, 0])), female)).toBeLessThan(1e-9);
  });

  it('needs no support: no face of a peg lying down, or of a socket printed mouth down or lying down, looks down steeper than 45°', () => {
    const peg = own(pegAt(placed));
    for (const up of ups) expect(steepest(peg, up), `peg, up ${up}`).toBeCloseTo(-Math.SQRT1_2, 5);
    // pointing up is fine too: nothing of it faces down
    expect(steepest(peg, [1, 0, 0])).toBeGreaterThan(-1e-9);
    const female = own(cube([30, 40, 40], [15, 10, 5]).subtract(own(socketAt(placed))));
    // mouth down, on its face on the bed, and lying down any way
    for (const up of [[1, 0, 0], ...ups]) expect(steepest(female, up), `socket, up ${up}`).toBeGreaterThanOrEqual(-Math.SQRT1_2 - 1e-5);
    expect(steepest(female, [1, 0, 0])).toBeCloseTo(-Math.SQRT1_2, 5);
    // what the check catches: a round hole lying down has a flat roof
    const round = own(cube([30, 40, 40], [15, 10, 5]).subtract(own(own(halfHole({ R: 3.15, h: 9.5, ch: 0.5 })).transform([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 10, 5, 1]))));
    expect(steepest(round, [0, 0, 1])).toBeLessThan(-0.99);
  });

  it('the fit test for built-in pegs is a block with one peg and a block with its socket, both lying as a bar\'s halves do', () => {
    const coupon = own(fitTestCoupon({ diameter: 6, clearance: 0.15, joint: 'pegs' }, 0.4));
    expect(coupon.status()).toBe('NoError');
    const [a, b] = shells(coupon);
    expect([a.genus(), b.genus()]).toEqual([0, 0]);
    expect(boxOf(coupon).min[2]).toBeCloseTo(0, 6);
    const side = 20;
    const long = p.h + p.tip + p.wall + 2;
    expect(coupon.volume()).toBeCloseTo(side ** 3 + pegOut + side * side * long - socketIn, 4);
    // the peg stands out of its block's side, its corners up and down: it needs no support
    const male = [a, b].find((x) => x.volume() > side ** 3);
    expect(boxOf(male).size.map((v) => +v.toFixed(6))).toEqual([side, side + 9, side]);
    expect(steepest(male, [0, 0, 1])).toBeCloseTo(-Math.SQRT1_2, 5);
    // with dovetails as well, the plates come after
    expect(shells(own(fitTestCoupon({ diameter: 6, joint: 'pegs' }, 0.4, { dovetail: true })))).toHaveLength(4);
  });

  it('a box cut with built-in pegs: one piece carries them all, the other has their sockets, no pins or teardrops, labels clear of both', () => {
    const box = own(wasm.Manifold.cube([120, 40, 30], true));
    const s = split(box, [[0, 0]], { joint: 'pegs' });
    expect(s.plan.joints).toEqual({ c1: 'pegs' });
    expect(s.layout).toMatchObject({ diameter: null, pegSize: 6, dowels: [] });
    expect(s.layout.pegs).toHaveLength(2);
    // both halves stand on their cut faces: the first carries the pegs, and will lie another way
    for (const g of s.layout.pegs) {
      expect(g).toMatchObject({ s: 6, length: 9, male: 0, dir: 1, axis: 0 });
      expect(g.sides).toEqual([{ piece: 1, peg: true }, { piece: 2, peg: false }]);
    }
    expect(isSymmetric(s.layout.pegs.map((g) => g.uv), [0, 0], 3)).toBe(false);
    expect(s.layout.seams).toEqual([expect.objectContaining({ letter: 'A', pieces: [1, 2], joint: 'pegs', male: 1, labels: ['1A', '2A'] })]);
    expect(s.layout.notes).toEqual([]);
    const [male, female] = s.drilled;
    for (const piece of s.drilled) {
      expect(piece.status()).toBe('NoError');
      expect(shells(piece)).toHaveLength(1);
      expect(piece.genus()).toBe(0);
    }
    // the labels are engraved 2 mm or more from the sockets' mouths, never into a peg or a socket
    for (const g of s.layout.pegs) {
      expect(own(own(pegAt(g)).subtract(male)).volume()).toBeLessThan(1e-6);
      expect(overlap(own(socketAt(g)), female)).toBeLessThan(1e-6);
    }
    expect(s.layout.labels).toHaveLength(1);
    for (const label of s.layout.labels) {
      for (const side of label.sides) {
        const cutter = own(labelSolid({ text: side.text, size: label.size, font, centre: label.centre, outward: side.outward, axis: label.axis }));
        for (const g of s.layout.pegs) expect(cutter.minGap(own(socketAt(g)), 5)).toBeGreaterThanOrEqual(2);
      }
    }
    expect(boxOf(male).max[0]).toBeCloseTo(9, 9);
    expect(boxOf(female).min[0]).toBeCloseTo(0, 9);
  });
});

describe('built-in pegs on the cut faces', () => {
  it('a plate\'s cut takes dovetail tabs; one through a plate thin the other way on the same axis takes pegs and says so', () => {
    const corner = own(wasm.Manifold.union([cube([200, 100, 5], [100, 50, 2.5]), cube([205, 5, 100], [297.5, 2.5, 50])]));
    const { spec, cuts } = cutsFor(corner, [[0, 100], [0, 300]], { joint: 'pegs' });
    const plan = planDovetails(corner, cuts, spec);
    expect(plan.joints).toEqual({ c1: 'dovetail', c2: 'pegs' });
    expect(plan.notes).toEqual([expect.objectContaining({ code: 'DOVETAIL_NOT_PLATE', pegs: true, text: 'Cut B isn\'t through a thin plate, so it uses built-in pegs.' })]);
  });

  it('a peg\'s shadow reaches as far as its socket on one side and just past the face on the other', () => {
    // 3 mm of solid under the face and 20 mm over it: a socket above and a peg below meet no air, a hole either way does
    const slab = cube([30, 30, 23], [0, 0, 8.5]);
    const cut = { axis: 2, at: 0 };
    const band = own(bandFor(slab, cut, 10));
    const face = own(band.slice(0));
    const left = (reach) => own(face.subtract(own(shadowFor(band, cut, reach)))).area();
    expect(left({ below: 1, above: 10 })).toBeCloseTo(900, 6);
    expect(left({ below: 10, above: 10 })).toBe(0);
    expect(left(10)).toBe(0);
    // the other way round, the socket below meets the air 3 mm down
    expect(left({ below: 10, above: 1 })).toBe(0);
    expect(left({ below: 2.5, above: 10 })).toBeCloseTo(900, 6);
  });

  /** Every peg and socket lies inside the model, the sockets a wall's thickness from its outside. */
  function expectPegsInside(solid, layout) {
    const b = boxOf(solid);
    const air = own(cube(b.size.map((v) => v + 40), b.min.map((v, a) => (v + b.max[a]) / 2)).subtract(solid));
    for (const g of layout.pegs) {
      const socket = own(socketAt(g));
      expect(own(socket.subtract(solid)).volume()).toBeLessThan(1e-6);
      expect(own(own(pegAt(g)).subtract(solid)).volume()).toBeLessThan(1e-6);
      expect(socket.minGap(air, 5)).toBeGreaterThanOrEqual(pegSizesFor(g.s).wall - 1e-6);
    }
  }

  it('a lid too thin for a socket carries the pegs, though the box under it would have, and the box takes the sockets', () => {
    // the box stands on its foot and the 6 mm lid on its cut face, so the box would carry them, its sockets in the lid
    const lidded = cube([150, 150, 100], [0, 0, 50]);
    const s = split(lidded, [[2, 94]], { joint: 'pegs', labels: false });
    expect(s.pieces.map((p) => p.lying.down)).toEqual(['-z', '-z']);
    expect(s.layout.seams).toEqual([expect.objectContaining({ pieces: [1, 2], joint: 'pegs', male: 2 })]);
    expect(s.layout.pegs.length).toBeGreaterThanOrEqual(2);
    for (const g of s.layout.pegs) expect(g).toMatchObject({ s: 8, length: 12, male: 1, dir: -1 });
    expect(s.layout.notes).toEqual([]);
    expectPegsInside(lidded, s.layout);
    for (const piece of s.drilled) {
      expect(piece.status()).toBe('NoError');
      expect(piece.genus()).toBe(0);
    }
    // with no say in which piece carries them, the one below does, unless only it has room for the sockets
    const bare = layoutSplit(lidded, s.cuts, s.pieces, s.spec, { joints: s.plan.joints, tabs: s.plan.tabs });
    expect(bare.seams).toEqual([expect.objectContaining({ joint: 'pegs', male: 2 })]);
  });

  it('the sockets go into the piece with more room for them, whichever side of the cut it is', () => {
    // a sealed void 8 mm behind the face on one side: the pegs stand on that piece, over the void, and their sockets go
    // deep into the other; mirrored, the same. Before, the lower-numbered piece carried them, and on one side they were
    // 4 mm and 3 mm long, the face told too narrow for 8 mm
    for (const side of [1, -1]) {
      const hollow = own(cube([200, 40, 40]).subtract(cube([52, 30, 30], [34 * side, 0, 0])));
      for (const diameter of [0, 8]) {
        const s = split(hollow, [[0, 0]], { joint: 'pegs', labels: false, diameter });
        expect(s.layout.pegs.map((g) => [g.s, g.length, g.dir])).toEqual([[8, 12, -side], [8, 12, -side]]);
        expect(s.layout.notes).toEqual([]);
        expectPegsInside(hollow, s.layout);
      }
    }
    // a box with 12 mm walls and an 8 mm lid: the lid lies on its cut face, so the box would carry them, their sockets
    // 3.7 mm deep in the lid; the lid lies as well on its top, so it carries them and the sockets go into the walls
    const lidded = own(cube([120, 120, 108], [0, 0, 54]).subtract(cube([96, 96, 94], [0, 0, 53])));
    const s = split(lidded, [[2, 100]], { joint: 'pegs', labels: false });
    expect(s.layout.seams).toEqual([expect.objectContaining({ pieces: [1, 2], joint: 'pegs', male: 2 })]);
    expect(s.layout.pegs.length).toBeGreaterThanOrEqual(2);
    for (const g of s.layout.pegs) expect(g).toMatchObject({ s: 4, length: 6, dir: -1 });
    expectPegsInside(lidded, s.layout);
  });

  it('Auto sizes the pegs on the side their sockets go into, and only on faces that get them', () => {
    // an 8 mm base under a 20 mm block: the base could take 4 mm sockets, but the block takes them, and 8 mm ones
    const base = own(wasm.Manifold.union([cube([160, 100, 8], [0, 0, 4]), cube([160, 100, 20], [0, 0, 18])]));
    let s = split(base, [[2, 8]], { joint: 'pegs', labels: false });
    expect(s.layout.pegSize).toBe(8);
    for (const g of s.layout.pegs) expect(g).toMatchObject({ s: 8, length: 12, male: 0, dir: 1 });
    expect(s.layout.notes).toEqual([]);
    expectPegsInside(base, s.layout);
    // a frame cut across a 40 mm bar and a 17 mm one, with a pocket 3 mm behind the narrow bar's face on the right: only
    // the left has room for its sockets, and it takes 5 mm pegs, the wide bar 6 mm ones
    const frame = own(own(wasm.Manifold.union([
      cube([200, 17, 30], [100, 8.5, 15]), cube([200, 40, 30], [100, 180, 15]), cube([40, 200, 30], [20, 100, 15]), cube([40, 200, 30], [180, 100, 15]),
    ])).subtract(cube([47, 11, 24], [126.5, 8.5, 15])));
    // with the sockets on the left, both bars get pegs, of the narrow bar's size; before, the left piece carried them
    s = split(frame, [[0, 100]], { joint: 'pegs', labels: false });
    expect(s.layout.seams).toEqual([expect.objectContaining({ joint: 'pegs', male: 2 })]);
    expect(s.layout.pegs.map((g) => g.s)).toEqual([5, 5, 5, 5]);
    expect(s.layout.pegs.filter((g) => g.centre[1] < 17)).toHaveLength(2);
    expect(s.layout.notes).toEqual([]);
    expectPegsInside(frame, s.layout);
    // made to go into the right, the narrow bar is glued, and its size is none of the model's
    const { spec, cuts, plan, pieces } = s;
    const right = layoutSplit(frame, cuts, pieces, spec, { joints: plan.joints, tabs: plan.tabs, pegMales: (pairs) => pairs.map(() => 0) });
    expect(right.pegSize).toBe(6);
    expect(right.pegs.map((g) => [g.s, g.centre[1] > 160])).toEqual([[6, true], [6, true]]);
    expect(right.notes).toEqual([expect.objectContaining({ code: 'CONNECTORS_DROPPED', count: 1, total: 2 })]);
  });

  it('a peg stands on a wall\'s thickness of solid, not on the skin over a void', () => {
    // a box with a void whose roof is 1.5 mm under the cut: the lower piece carries the pegs, none of them over it
    const hollow = own(cube([200, 140, 80], [0, 0, 40]).subtract(cube([150, 90, 18.5], [0, 0, 29.25])));
    const s = split(hollow, [[2, 40]], { joint: 'pegs', labels: false });
    expect(s.layout.pegs.length).toBe(6);
    for (const g of s.layout.pegs) {
      expect(g).toMatchObject({ s: 8, dir: 1 });
      // the peg's diamond, as deep into its piece as its root must be solid
      const r = g.s / Math.SQRT2;
      const root = 0.5 + pegSizesFor(g.s).wall;
      const diamond = own(new wasm.CrossSection([[[r, 0], [0, r], [-r, 0], [0, -r]]]));
      const under = own(own(wasm.Manifold.extrude(diamond, root)).translate([g.centre[0], g.centre[1], g.at - root]));
      expect(own(under.subtract(hollow)).volume()).toBeLessThan(1e-6);
    }
    expectPegsInside(hollow, s.layout);
  });

  it('names the cuts whose faces would take pins instead: not a plate too thin for sockets, which carries the pegs', () => {
    const plated = (t) => own(wasm.Manifold.union([cube([140, 90, t], [0, 0, t / 2]), cube([140, 90, 30], [0, 0, t + 15])]));
    // a 5 mm plate has no room for a 3 mm pin's holes; a 10 mm one has
    expect(split(plated(5), [[2, 5]], { joint: 'pegs', labels: false }).layout).toMatchObject({ pinnable: [], seams: [expect.objectContaining({ joint: 'pegs' })] });
    expect(split(plated(10), [[2, 10]], { joint: 'pegs', labels: false }).layout).toMatchObject({ pinnable: ['c1'], seams: [expect.objectContaining({ joint: 'pegs' })] });
  });

  it('keep a wall from the air and from each other: a void behind the face takes shorter pegs, parallel cuts never meet', () => {
    // a sealed void 8 mm behind the face on both sides: a 4 mm peg's socket reaches it, a 3 mm peg's does not
    const hollow = own(own(cube([200, 40, 40]).subtract(cube([52, 30, 30], [34, 0, 0]))).subtract(cube([52, 30, 30], [-34, 0, 0])));
    let s = split(hollow, [[0, 0]], { joint: 'pegs', labels: false });
    expect(s.layout.pegs.map((g) => [g.s, g.length])).toEqual([[4, 3], [4, 3]]);
    expect(s.layout.notes).toEqual([expect.objectContaining({ code: 'CONNECTORS_SHORTER', pegs: true, depth: 3 })]);
    expectPegsInside(hollow, s.layout);
    // a middle piece 20 mm long between two cuts gets sockets from both: the second cut's keep clear of the first's
    const bar = own(wasm.Manifold.cube([300, 40, 20], true));
    s = split(bar, [[0, 0], [0, 20]], { joint: 'pegs', labels: false });
    expect(s.layout.seams.map((x) => [x.pieces, x.male])).toEqual([[[1, 2], 1], [[2, 3], 3]]);
    expectPegsInside(bar, s.layout);
    const [first, second] = ['c1', 'c2'].map((id) => s.layout.pegs.filter((g) => g.cutId === id));
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(second.length).toBeGreaterThanOrEqual(2);
    for (const g of first) {
      const used = own(own(socketAt(g)).add(own(pegAt(g))));
      for (const h of second) expect(used.minGap(own(own(socketAt(h)).add(own(pegAt(h)))), 10)).toBeGreaterThanOrEqual(pegSizesFor(h.s).wall - 1e-6);
    }
    for (const piece of s.drilled) {
      expect(piece.status()).toBe('NoError');
      expect(piece.genus()).toBe(0);
    }
  });
});

describe('labels', () => {
  /** The y (or x) of a label's first character, against its second: which side of the label the text starts on. */
  function firstOnTheLeft(outward, axis, along) {
    const label = own(labelSolid({ text: '1A', size: 8, font, centre: [0, 0, 0], outward, axis }));
    const [one, a] = shells(label).sort((p, q) => p.volume() - q.volume());
    const centre = (m) => (boxOf(m).min[along] + boxOf(m).max[along]) / 2;
    return { first: centre(one), second: centre(a), box: boxOf(label) };
  }

  it('engrave 0.6 mm into the face and read left to right from outside on both faces of a cut', () => {
    // seen from +x with +z up, right is +y; from −x it is −y
    let r = firstOnTheLeft('+x', 0, 1);
    expect(r.first).toBeLessThan(r.second);
    expect(r.box.min[0]).toBeCloseTo(-0.6, 6);
    expect(r.box.max[0]).toBeCloseTo(0.4, 6);
    r = firstOnTheLeft('-x', 0, 1);
    expect(r.first).toBeGreaterThan(r.second);
    expect(r.box.min[0]).toBeCloseTo(-0.4, 6);
    // a Z cut: +y up; seen from above, right is +x
    r = firstOnTheLeft('+z', 2, 0);
    expect(r.first).toBeLessThan(r.second);
    r = firstOnTheLeft('-z', 2, 0);
    expect(r.first).toBeGreaterThan(r.second);
    // the cap height lies along world z on an X cut
    expect(r.box.size[1]).toBeCloseTo(8, 0);
  });

  it('each pinned face carries its piece number and the cut letter, in the same spot on both pieces', () => {
    const box = own(wasm.Manifold.cube([120, 40, 30], true));
    const plain = split(box, [[0, 0]], { diameter: 5, depth: 8, count: 2, labels: false });
    const s = split(box, [[0, 0]], { diameter: 5, depth: 8, count: 2 });
    expect(s.layout.labels).toHaveLength(1);
    const [label] = s.layout.labels;
    expect(label.sides.map((x) => x.text)).toEqual(['1A', '2A']);
    expect(s.layout.seams[0].labels).toEqual(['1A', '2A']);
    expect(label.size).toBe(8);
    // both pieces lie on their cut faces: outline, two holes, the digit, and the A with its counter
    s.drilled.forEach((piece, k) => {
      const inPlane = own(piece.transform(TO_PLANE[0]));
      const face = own(inPlane.slice(k === 0 ? -0.05 : 0.05));
      expect(face.numContour()).toBe(6);
      expect(plain.drilled[k].volume() - piece.volume()).toBeGreaterThan(5);
      expect(piece.genus()).toBe(0);
    });
    expect(plain.drilled[0].volume()).toBeCloseTo(72000 - 2 * 209.901, 2);
  });
});

describe('dovetail tabs through thin plates', () => {
  it('reproduce the verification probe for one tab: locked in the plane, lowered into place, the clearance at the flanks', () => {
    // the probe's second tab was empty (a clockwise polygon), so its numbers are those of the first tab alone. It
    // took a push (B moved 1 mm into A, 402.552 mm³) for the lock, but pushed together the faces meet whatever the
    // tabs: the lock is that the pieces can be neither pulled apart nor slid along the seam.
    const plate = cube([300, 80, 5], [0, 0, 2.5]);
    const N = 9.6;
    const H = 1.4 * N;
    const l = -40 + H / 2 + 3 + (0.5 * (80 - H - 6)) / 2;
    const plan = { w: 2, seams: [{ cutId: 'c1', letter: 'A', axis: 0, at: 0, tabs: [{ l, dir: 1, N, H, E: N }] }] };
    const [axis] = dovetailCells(plan, [{ id: 'c1', letter: 'A', axis: 0, at: 0 }], boxOf(plate), 0.15);
    axis.cells.forEach((c) => own(c.solid));
    const [A, B] = axis.cells.map((c) => own(plate.intersect(c.solid)));
    const moved = (x, y, z) => overlap(A, own(B.translate([x, y, z])));
    expect(plate.volume() - A.volume() - B.volume()).toBeCloseTo(24.65, 2);
    // pulled apart, the head bites once the side clearance is taken up (0.15 mm on its 1:5 flank, about 0.77 mm)
    expect(moved(0.75, 0, 0)).toBeLessThan(1e-6);
    expect(moved(2, 0, 0)).toBeCloseTo(15.863, 2);
    // slid 1 mm along the seam either way, the flanks meet
    expect(moved(0, 1, 0)).toBeCloseTo(39.897, 2);
    expect(moved(0, -1, 0)).toBeCloseTo(39.897, 2);
    expect(moved(0, 0, 6)).toBe(0);
    expect(moved(0, 0.1, 0)).toBeLessThan(1e-5); // the probe printed 0.00000
    expect(moved(0, 0.14, 0)).toBeCloseTo(0.00234, 4);
    expect(moved(0, 0.2, 0)).toBeCloseTo(2.09016, 3);
  });

  it('a thin sign gets two tabs, one from each side, that lock both ways and go together by lowering', () => {
    const sign = own(wasm.Manifold.union([cube([300, 80, 5], [0, 0, 2.5]), cube([20, 20, 10], [-80, 0, 10])]));
    const s = split(sign, [[0, 0]]);
    expect(s.plan.joints).toEqual({ c1: 'dovetail' });
    expect(s.plan.dove).toEqual({ ids: ['c1'], w: 2, clearance: 0.15 });
    expect(s.cut.dovetails).toEqual([{ cutId: 'c1', letter: 'A', axis: 0, at: 0, w: 2, tabs: 2 }]);
    expect(s.plan.tabs.seams[0].tabs.map((t) => t.dir)).toEqual([1, -1]);
    expect(s.layout.dowels).toHaveLength(0);
    expect(s.layout.seams).toEqual([expect.objectContaining({ pieces: [1, 2], joint: 'dovetail', labels: null })]);
    const [A, B] = s.cut.pieces.map((p) => p.solid);
    for (const p of s.pieces) {
      expect(p.solid.status()).toBe('NoError');
      expect(p.shells).toBe(1);
      expect(p.solid.genus()).toBe(0);
      expect(p.stats.allowed).toEqual(['-z', '+z']);
      expect(p.up).toBe('+z');
    }
    const moved = (x, y, z) => overlap(A, own(B.translate([x, y, z])));
    expect(moved(0, 0, 0)).toBeLessThan(1e-6);
    expect(s.cut.gap).toBeCloseTo(2 * 24.65, 1);
    expect(s.cut.notes).toEqual([]);
    // pulled apart, the heads bite once the side clearance is taken up: 0.15 mm on a 1:5 flank is about 0.77 mm
    expect(moved(0.75, 0, 0)).toBeLessThan(1e-6);
    expect(moved(2, 0, 0)).toBeGreaterThan(30);
    expect(moved(-1, 0, 0)).toBeGreaterThan(400); // pushed together: the faces meet
    expect(moved(0, 1, 0)).toBeGreaterThan(70);
    expect(moved(0, -1, 0)).toBeGreaterThan(70);
    expect(moved(0, 0, 6)).toBeLessThan(1e-6);
    expect(Math.max(moved(0, 0.1, 0), moved(0, -0.1, 0))).toBeLessThan(1e-4);
    expect(Math.min(moved(0, 0.2, 0), moved(0, -0.2, 0))).toBeGreaterThan(1);
  });

  it('tabs keep clear of letters standing beside the cut, so no piece takes a slice of the other\'s', () => {
    // raised 'letters' 4 mm either side of the cut, inside a tab's reach: the tabs go above and below them
    const sign = own(wasm.Manifold.union([cube([300, 100, 4], [0, 0, 2]), cube([10, 40, 2], [-9, 0, 5]), cube([10, 40, 2], [9, 0, 5])]));
    const s = split(sign, [[0, 0]]);
    expect(s.plan.joints).toEqual({ c1: 'dovetail' });
    const tabs = s.plan.tabs.seams[0].tabs;
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) expect(Math.abs(tab.l) - tab.H / 2).toBeGreaterThanOrEqual(20 + 2 - 1e-9);
    const [A, B] = s.cut.pieces.map((p) => p.solid);
    // above the plate, each piece holds its own letter whole and nothing of the other
    const raised = (x) => cube([150, 200, 10], [x, 0, 9.001]);
    expect(overlap(A, raised(75))).toBeLessThan(1e-6);
    expect(overlap(B, raised(-75))).toBeLessThan(1e-6);
    expect(overlap(A, raised(-75))).toBeCloseTo(10 * 40 * (6 - 4.001), 3);
    expect(overlap(B, raised(75))).toBeCloseTo(10 * 40 * (6 - 4.001), 3);
    // letters along the whole cut leave no room: a flat glue joint, said so
    const crowded = own(wasm.Manifold.union([cube([300, 100, 4], [0, 0, 2]), cube([10, 90, 2], [-9, 0, 5]), cube([10, 90, 2], [9, 0, 5])]));
    const c = split(crowded, [[0, 0]]);
    expect(c.plan.joints).toEqual({ c1: 'none' });
    expect(c.plan.notes).toEqual([expect.objectContaining({ code: 'CONNECTORS_DROPPED', dovetail: true })]);
  });

  it('tabs go only where the plate is solid right through: never across a sealed pocket or an engraving beside the cut', () => {
    // an 8 mm plate with sealed magnet pockets in its lower half every 40 mm, and a 2 mm-deep engraved bar in its top
    // beside the cut: neither reaches the plate's middle, where a tab was once checked
    const pockets = [];
    for (let x = -180; x <= 180; x += 40) for (const y of [-50, 0, 50]) pockets.push(cube([10.4, 10.4, 3.2], [x, y, 2.2]));
    const sign = own(own(cube([400, 150, 8], [0, 0, 4]).subtract(own(wasm.Manifold.union(pockets)))).subtract(cube([30, 20, 4], [-20, -25, 8])));
    const s = split(sign, [[0, -68.66], [0, 68.66]], { labels: false });
    expect(s.plan.joints).toEqual({ c1: 'dovetail', c2: 'dovetail' });
    expect(s.plan.tabs.seams.map((x) => x.tabs.length)).toEqual([3, 3]);
    // every pocket stays sealed, whole, in the piece its column is in
    const hollows = s.cut.pieces.map((p) => shells(p.solid).filter((m) => m.volume() < 0));
    expect(hollows.map((list) => list.length)).toEqual([9, 12, 9]);
    for (const m of hollows.flat()) expect(m.volume()).toBeCloseTo(-10.4 * 10.4 * 3.2, 3);
    // the engraving is the middle piece's alone: no tab's socket runs through it
    const groove = cube([30, 20, 2], [-20, -25, 7]);
    expect(overlap(s.cut.pieces[0].solid, cube([40, 30, 4], [-20, -25, 6]))).toBeLessThan(1e-6);
    expect(overlap(s.cut.pieces[1].solid, groove)).toBeLessThan(1e-6);
    expect(own(cube([30, 20, 4], [-20, -25, 4]).subtract(groove)).volume() - overlap(s.cut.pieces[1].solid, cube([30, 20, 4], [-20, -25, 4]))).toBeCloseTo(0, 3);
  });

  it('a tab never cuts through another plate at another height', () => {
    // a lower plate, and a narrower upper one 15 mm above it, joined at one end
    const rack = own(wasm.Manifold.union([cube([300, 100, 5], [0, 0, 2.5]), cube([300, 30, 5], [0, 25, 22.5]), cube([10, 100, 25], [-145, 0, 12.5])]));
    // its pieces cannot lie flat on either plate with the other held over the bed, so the cut takes pins…
    expect(split(rack, [[0, 0]], { labels: false }).plan.joints).toEqual({ c1: 'dowels' });
    // …but tabs placed through it all the same never carry a slice of the other plate across
    const { cuts } = cutsFor(rack, [[0, 0]]);
    const dove = { ids: ['c1'], w: 2, clearance: 0.15 };
    const tabs = dovetailTabs(rack, cuts, dove);
    expect(tabs.seams[0].tabs.length).toBeGreaterThan(0);
    const cut = cutPieces(rack, cuts, { dove, tabs });
    cut.pieces.forEach((p) => own(p.solid));
    const lost = (z) => {
      const slices = cut.pieces.map((p) => own(p.solid.slice(z)));
      const missing = own(own(rack.slice(z)).subtract(own(wasm.CrossSection.union(slices))));
      // the clearance round a tab is a 0.15 mm kerf: opening by 0.25 mm leaves only a real hole
      return own(own(missing.offset(-0.25, 'Round')).offset(0.25, 'Round')).area();
    };
    expect(lost(2.5)).toBeLessThan(0.01);
    expect(lost(22.5)).toBeLessThan(0.01);
    expect(cut.pieces).toHaveLength(2);
  });

  it('a U cut across both legs takes pins, its pieces standing; tabs forced through both legs are each wholly inside both', () => {
    // a base 150 × 50 × 8 and two legs 8 × 50 × 300: laid flat on one leg, the other would be a roof 142 mm over the bed
    const U = own(wasm.Manifold.union([cube([150, 50, 8], [75, 25, 4]), cube([8, 50, 300], [4, 25, 150]), cube([8, 50, 300], [146, 25, 150])]));
    const pinned = split(U, [[2, 150]], { labels: false });
    expect(pinned.plan.joints).toEqual({ c1: 'dowels' });
    expect(pinned.plan.notes).toEqual([]);
    expect(pinned.layout.dowels.length).toBeGreaterThanOrEqual(4);
    expect(pinned.pieces.map((p) => p.stats.allowed.length)).toEqual([6, 6]);
    expect(pinned.pieces.map((p) => chooseOrientation(p.stats, BED).down)).toEqual(['-z', '-z']);
    // asked for, tabs are explained away
    expect(split(U, [[2, 150]], { joint: 'dovetail', labels: false }).plan.notes).toEqual([expect.objectContaining({ code: 'DOVETAIL_NOT_PLATE', lying: true })]);
    // the same tabs through both legs, placed as they would be: each wholly inside both legs
    const { cuts } = cutsFor(U, [[2, 150]]);
    const dove = { ids: ['c1'], w: 0, clearance: 0.15 };
    const tabs = dovetailTabs(U, cuts, dove);
    expect(tabs.seams[0].tabs.map((t) => t.dir)).toEqual([1, -1]);
    const cut = cutPieces(U, cuts, { dove, tabs });
    const [A, B] = cut.pieces.map((p) => own(p.solid));
    for (const p of cut.pieces) {
      expect(p.solid.status()).toBe('NoError');
      expect(shells(p.solid)).toHaveLength(p.index === 1 ? 1 : 2);
    }
    // no slice of a leg changes hands: each leg's part above the cut is the upper piece's, tabs and sockets aside
    const sum = cut.pieces.reduce((v, p) => v + p.volume, 0);
    expect(sum + cut.gap).toBeCloseTo(U.volume(), 3);
    // both legs lock: pulled apart the heads bite in each leg, and the pieces slide together along x
    const moved = (x, y, z) => overlap(A, own(B.translate([x, y, z])));
    expect(moved(0, 0, 0)).toBeLessThan(1e-6);
    for (const x of [4, 146]) expect(overlap(own(A.intersect(cube([12, 60, 60], [x, 25, 150]))), own(B.translate([0, 0, 2])))).toBeGreaterThan(10);
    for (const x of [20, 70, 142]) expect(moved(x, 0, 0)).toBeLessThan(1e-6);
  });

  it('tabs only where every piece beside the cut can lie flat on its plate: a double skin and a sword\'s guard take pins', () => {
    // two 4 mm skins 30 mm apart, closed at the ends: laid on one skin, the other is a roof over the bed
    const panel = own(wasm.Manifold.union([cube([420, 150, 4], [0, 0, 2]), cube([420, 150, 4], [0, 0, 32]), cube([10, 150, 34], [-205, 0, 17]), cube([10, 150, 34], [205, 0, 17])]));
    expect(split(panel, [[0, 0]], { labels: false }).plan.joints).toEqual({ c1: 'dowels' });
    // a blade with a guard and a round grip: the piece holding them would lie on the grip's curve, the blade in the air
    const grip = own(own(own(wasm.Manifold.cylinder(180, 15, 15, 48)).rotate([0, -90, 0])).translate([-20, 0, 0]));
    const sword = own(wasm.Manifold.union([cube([300, 50, 8], [150, 0, 0]), cube([20, 160, 24], [-10, 0, 0]), grip]));
    const guarded = split(sword, [[0, 100]], { labels: false });
    expect(guarded.plan.joints).toEqual({ c1: 'dowels' });
    expect(guarded.plan.plates.c1.reason).toBe('lying');
    // a tapered tip only a few millimetres over the bed lies flat well enough, and keeps its tabs
    const tip = own(wasm.Manifold.hull([cube([200, 50, 8], [100, 0, 0]), cube([2, 2, 2], [299, 0, 0])]));
    const tipped = split(tip, [[0, 150]], { labels: false });
    expect(tipped.plan.joints).toEqual({ c1: 'dovetail' });
    expect(tipped.pieces.map((p) => chooseOrientation(p.stats, BED).down[1])).toEqual(['z', 'z']);
  });

  it('crossing dovetail cuts never close off a loose corner of a piece', () => {
    const plate = cube([300, 200, 5], [0, 0, 2.5]);
    for (const [x, y] of [[20, 8], [24, 4], [28, 10], [20, 2]]) {
      const s = split(plate, [[0, x], [1, y]], { labels: false });
      expect(s.plan.joints).toEqual({ c1: 'dovetail', c2: 'dovetail' });
      expect(s.cut.dovetails.every((d) => d.tabs >= 1)).toBe(true);
      for (const p of s.cut.pieces) {
        expect(p.shells).toBe(1);
        expect(shells(p.solid)).toHaveLength(1);
      }
      expect(s.cut.notes).toEqual([]);
    }
  });

  it('the pin holes of a crossing cut keep out of the dovetail sockets', () => {
    // a plate with a tall block standing just past a dovetail cut, and a crossing cut through both that takes pins
    const model = own(wasm.Manifold.union([cube([300, 100, 5], [0, 0, 2.5]), cube([149, 100, 30], [75.5, 0, 15])]));
    const s = split(model, [[0, 0], [1, -7.3]], { labels: false });
    expect(s.plan.joints).toEqual({ c1: 'dovetail', c2: 'dowels' });
    expect(s.layout.dowels.length).toBeGreaterThanOrEqual(2);
    for (const d of s.layout.dowels) {
      const pin = own(pinAt(d));
      for (const piece of s.drilled) expect(overlap(pin, piece)).toBeLessThan(1e-6);
    }
  });

  it('both arms of an L of thin plates get tabs, each through its own plate', () => {
    // the base is thin along z, the upright along x; a cut along z elsewhere does not rule out the base's tabs
    const L = own(wasm.Manifold.union([cube([120, 30, 6], [60, 15, 3]), cube([6, 30, 120], [3, 15, 60])]));
    const s = split(L, [[0, 60], [2, 60]], { labels: false });
    expect(s.plan.joints).toEqual({ c1: 'dovetail', c2: 'dovetail' });
    expect(s.plan.dove.w).toEqual({ c1: 2, c2: 0 });
    expect(s.cut.dovetails.map((d) => [d.cutId, d.w, d.tabs])).toEqual([['c1', 2, 1], ['c2', 0, 1]]);
    expect(s.cut.pieces).toHaveLength(3);
    for (const p of s.cut.pieces) {
      expect(p.solid.status()).toBe('NoError');
      expect(shells(p.solid)).toHaveLength(1);
    }
    // the corner piece holds a socket or tab of each: it may lie on either plate
    expect(s.cut.pieces[0].stats.allowed).toEqual(['-z', '+z', '-x', '+x']);
    expect(s.cut.pieces[1].stats.allowed).toEqual(['-z', '+z']);
    expect(s.cut.pieces[2].stats.allowed).toEqual(['-x', '+x']);
    const sum = s.cut.pieces.reduce((v, p) => v + p.volume, 0);
    expect(sum + s.cut.gap).toBeCloseTo(L.volume(), 3);
    expect(s.layout.seams.map((x) => x.joint)).toEqual(['dovetail', 'dovetail']);
  });

  it('a letter standing on the plate where the cut crosses it does not make the plate a block', () => {
    // a 3 mm sign with one stroke 8 mm wide and 3 mm tall running across the cut: the strip is the plate's own 3 mm
    const sign = own(wasm.Manifold.union([cube([300, 100, 3], [0, 0, 1.5]), cube([40, 8, 3], [0, 0, 4.5])]));
    const s = split(sign, [[0, 0]], { labels: false });
    expect(s.plan.joints).toEqual({ c1: 'dovetail' });
    expect(s.plan.plates.c1.islands[0]).toMatchObject({ t: 3, band: [0, 3] });
    expect(s.cut.dovetails[0].tabs).toBe(2);
    // the tabs keep clear of the stroke
    for (const tab of s.plan.tabs.seams[0].tabs) expect(Math.abs(tab.l) - tab.H / 2).toBeGreaterThanOrEqual(4 - 1e-9);
    // a U is still not a plate
    const channel = own(wasm.Manifold.union([cube([300, 40, 2], [0, 0, 1]), cube([300, 2, 20], [0, -19, 10]), cube([300, 2, 20], [0, 19, 10])]));
    expect(split(channel, [[0, 0]], { joint: 'dovetail', labels: false }).plan.joints).toEqual({ c1: 'dowels' });
  });

  it('a curved panel takes no tabs: its pieces would have to lie on their curve', () => {
    // a 5 mm slice of a tube of radius 600, 400 wide and 100 tall, bowing out along y
    const tube = own(own(wasm.Manifold.cylinder(100, 600, 600, 256)).subtract(own(wasm.Manifold.cylinder(102, 595, 595, 256).translate([0, 0, -1]))));
    const panel = own(tube.intersect(cube([400, 60, 100], [0, 580, 50])));
    const curved = split(panel, [[0, 0]], { labels: false });
    expect(curved.plan.joints).toEqual({ c1: 'dowels' });
    expect(curved.plan.plates.c1.reason).toBe('curved');
    expect(curved.pieces.map((p) => p.stats.allowed.length)).toEqual([6, 6]);
    // flat, the same panel takes them; and a disc, which is only shorter away from its middle
    expect(split(cube([400, 5, 100]), [[0, 0]], { labels: false }).plan.joints).toEqual({ c1: 'dovetail' });
    const disc = own(wasm.Manifold.cylinder(4, 200, 200, 96));
    expect(split(disc, [[0, -66.7], [0, 66.7]], { labels: false }).plan.joints).toEqual({ c1: 'dovetail', c2: 'dovetail' });
    // nor does a big hole where the plate is looked at make it a curve
    const holed = own(cube([400, 100, 5], [0, 0, 2.5]).subtract(cube([60, 60, 10], [100, 0, 2.5])));
    expect(split(holed, [[0, 0]], { labels: false }).plan.joints).toEqual({ c1: 'dovetail' });
  });

  it('use pins instead where the cut is not through a plate, there are unrepaired triangles, or a tab has no room; glue under 2 mm', () => {
    const sign = cube([300, 80, 5], [0, 0, 2.5]);
    let { plan } = split(sign, [[0, 0]], {}, { passthrough: true });
    expect(plan.joints).toEqual({ c1: 'dowels' });
    expect(plan.dove).toBeNull();
    ({ plan } = split(cube([120, 40, 30]), [[0, 0]], { joint: 'dovetail' }));
    expect(plan.joints).toEqual({ c1: 'dowels' });
    expect(plan.notes.map((n) => n.code)).toEqual(['DOVETAIL_NOT_PLATE']);
    ({ plan } = split(cube([120, 40, 30]), [[0, 0]]));
    expect(plan.notes).toEqual([]);
    // a strip too short for a tab's head and its margins (12 < 1.4 × 6 + 6)
    ({ plan } = split(cube([300, 12, 2]), [[0, 0]]));
    expect(plan.joints).toEqual({ c1: 'none' });
    expect(plan.notes[0]).toMatchObject({ code: 'CONNECTORS_DROPPED', dovetail: true });
    // a cut along the plate's thickness rules dovetails out for every cut
    ({ plan } = split(sign, [[0, 0], [2, 2.5]]));
    expect(plan.joints.c1).toBe('dowels');
    const thin = split(cube([300, 80, 1.5]), [[0, 0]]);
    expect(thin.plan.joints).toEqual({ c1: 'none' });
    expect(thin.layout.dowels).toHaveLength(0);
    expect(thin.drilled.map((d) => d.status())).toEqual(['NoError', 'NoError']);
  });
});

describe('cutting into pieces', () => {
  it('numbers pieces bottom layer first, then front to back, then left to right, and keeps every bit of material', () => {
    const block = cube([200, 200, 80]);
    const { cuts } = cutsFor(block, [[2, 0], [0, 0], [1, 0]]);
    const r = cutPieces(block, cuts);
    r.pieces.forEach((p) => own(p.solid));
    expect(r.grid).toEqual([1, 1, 1]);
    expect(r.pieces.map((p) => p.cell.join(''))).toEqual(['000', '100', '010', '110', '001', '101', '011', '111']);
    expect(r.pieces.map((p) => p.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const p of r.pieces) {
      expect(p.volume).toBeCloseTo(400000, 3);
      expect(p.solid.genus()).toBe(0);
      expect(p.cuts).toHaveLength(3);
    }
    expect(r.notes).toEqual([]);
    expect(r.pieces[0].stats.dirs['+x'].cutArea).toBeCloseTo(100 * 40, 6);
  });

  it('keep every shell of a cell in one piece, leave nothing of a face a cut lies along, and warn about thin pieces', () => {
    const U = own(own(wasm.Manifold.cube([60, 20, 50])).subtract(own(own(wasm.Manifold.cube([40, 30, 40])).translate([10, -5, 15]))));
    const { cuts } = cutsFor(U, [[2, 30]]);
    const r = cutPieces(U, cuts);
    r.pieces.forEach((p) => own(p.solid));
    expect(r.pieces.map((p) => p.shells)).toEqual([1, 2]);
    // a stepped block cut exactly at its step: the step comes away as a clean 50 × 40 × 10 block, with no
    // paper-thin flap of the lower block's top face joined to it (it once set the piece's box and spoilt its file)
    const step = own(wasm.Manifold.union([cube([100, 40, 30], [0, 0, 15]), cube([50, 40, 10], [-25, 0, 35])]));
    const s = cutPieces(step, cutsFor(step, [[2, 30]]).cuts);
    s.pieces.forEach((p) => own(p.solid));
    expect(s.pieces).toHaveLength(2);
    expect(s.pieces.map((p) => p.volume)).toEqual([expect.closeTo(120000, 3), expect.closeTo(20000, 3)]);
    expect(s.pieces[1].bbox).toEqual({ min: [-50, -20, 30], max: [0, 20, 40] });
    expect(s.pieces[1].solid.surfaceArea()).toBeCloseTo(2 * (50 * 40 + 50 * 10 + 40 * 10), 6);
    expect(s.pieces[1].stats.dims).toEqual([50, 40, 10]);
    expect(s.notes).toEqual([]);
    // the same along X (an L at its inner corner) and on a plate whose raised blocks start on the cut
    const L = own(wasm.Manifold.union([cube([60, 40, 20], [20, 0, 10]), cube([20, 40, 40], [-20, 0, 20])]));
    const l = cutPieces(L, cutsFor(L, [[0, -10]]).cuts);
    l.pieces.forEach((p) => own(p.solid));
    expect(l.pieces.map((p) => p.bbox.max[2])).toEqual([40, 20]);
    const plaque = own(wasm.Manifold.union([cube([200, 60, 4], [0, 0, 2]), cube([30, 20, 6], [-50, 0, 3]), cube([30, 20, 6], [50, 0, 3])]));
    const q = cutPieces(plaque, cutsFor(plaque, [[2, 4]]).cuts);
    q.pieces.forEach((p) => own(p.solid));
    expect(q.pieces[1]).toMatchObject({ shells: 2, bbox: { min: [-65, -10, 4], max: [65, 10, 6] } });
    const thin = cutPieces(cube([120, 40, 30]), cutsFor(cube([120, 40, 30]), [[0, 58]]).cuts);
    thin.pieces.forEach((p) => own(p.solid));
    expect(thin.notes).toEqual([expect.objectContaining({ code: 'SMALL_PIECE', pieceIndex: 2, cutId: 'c1', letters: ['A'] })]);
    expect(thin.notes[0].thickness).toBeCloseTo(2, 6);
  });

  it('keep a sealed hollow no cut opens inside its piece: a magnet pocket is not a sliver to throw away', () => {
    // a 400 × 40 × 12 bar with a sealed 10 × 10 × 3.2 pocket for a magnet dropped in at a pause, cut away from it
    const bar = own(cube([400, 40, 12], [0, 0, 6]).subtract(cube([10, 10, 3.2], [120, 0, 6])));
    const { cuts } = cutsFor(bar, [[0, 0]]);
    const r = cutPieces(bar, cuts);
    r.pieces.forEach((p) => own(p.solid));
    expect(r.notes).toEqual([]);
    expect(r.pieces.map((p) => p.shells)).toEqual([1, 1]);
    expect(r.pieces.map((p) => p.volume)).toEqual([expect.closeTo(96000, 3), expect.closeTo(96000 - 320, 3)]);
    expect(r.pieces[1].solid.volume()).toBeCloseTo(96000 - 320, 3);
    // the pocket is still a closed hollow inside the piece; its roof is bridged over, so the bar still lies as modelled
    expect(shells(r.pieces[1].solid).map((m) => Math.round(m.volume()))).toEqual([96000, -320]);
    expect(r.pieces.map((p) => chooseOrientation(p.stats, BED).down)).toEqual(['-z', '-z']);
  });
});

describe('pins on the cut faces', () => {
  it('a cut box: Ø5 pins, round holes, as the pieces stand on their cut faces', () => {
    const box = own(wasm.Manifold.cube([120, 40, 30], true));
    const s = split(box, [[0, 0]], { diameter: 5, depth: 8, count: 2, labels: false });
    expect(s.pieces.map((p) => p.up)).toEqual(['-x', '+x']);
    expect(s.layout.dowels).toHaveLength(2);
    for (const d of s.layout.dowels) expect(d.sides.map((x) => x.tear)).toEqual([false, false]);
    for (const piece of s.drilled) {
      expect(piece.volume()).toBeCloseTo(72000 - 2 * 209.901, 2);
      expect(shells(piece)).toHaveLength(1);
      expect(piece.genus()).toBe(0);
    }
    expectHolesInside(box, s.layout);
  });

  it('auto picks Ø6 from a 20 mm bar lying flat, with teardrop roofs, placed so the face fits only one way', () => {
    const bar = own(wasm.Manifold.cube([300, 40, 20], true));
    const s = split(bar, [[0, 0]], { labels: false });
    expect(s.pieces.map((p) => p.up)).toEqual(['+z', '+z']);
    expect(s.layout.diameter).toBe(6);
    expect(s.layout.dowels).toHaveLength(2);
    for (const d of s.layout.dowels) {
      expect(d).toMatchObject({ d: 6, depth: 9.5, cell: [0.5, 0, 0] });
      expect(d.sides).toEqual([{ piece: 1, tear: true, apex: [0, 0, 1] }, { piece: 2, tear: true, apex: [0, 0, 1] }]);
    }
    expect(isSymmetric(s.layout.dowels.map((d) => d.uv), [0, 0], 3)).toBe(false);
    for (const piece of s.drilled) expect(piece.volume()).toBeCloseTo(120000 - 2 * 372.679, 2);
    expect(s.layout.seams).toEqual([expect.objectContaining({ letter: 'A', pieces: [1, 2], joint: 'dowels', patches: 1 })]);
    expect(s.layout.notes).toEqual([]);
  });

  it('holes never break out of a tube, falling back to filament, a smaller size or glue as the walls get thinner', () => {
    const tube = (w) => own(cube([60, 60, 200]).subtract(cube([60 - 2 * w, 60 - 2 * w, 210])));
    let s = split(tube(10), [[2, 0]], { diameter: 5 });
    expect(s.layout.dowels.length).toBeGreaterThanOrEqual(2);
    for (const d of s.layout.dowels) expect(Math.min(Math.abs(d.centre[0]), Math.abs(d.centre[1]))).toBeGreaterThan(20); // in the corners
    expectHolesInside(tube(10), s.layout);
    s = split(tube(8), [[2, 0]], { diameter: 5 });
    expect(s.layout.dowels.map((d) => d.d)).toEqual([1.75, 1.75]);
    expect(s.layout.notes.find((n) => n.code === 'CONNECTORS_FILAMENT')).toMatchObject({ letter: 'A', count: 2, diameter: 5, length: 8, suggestedDiameter: 4 });
    expectHolesInside(tube(8), s.layout);
    s = split(tube(8), [[2, 0]]);
    expect(s.layout.diameter).toBe(3);
    expect(s.layout.dowels.map((d) => d.d)).toEqual([3, 3]);
    expectHolesInside(tube(8), s.layout);
    s = split(tube(3), [[2, 0]]);
    expect(s.layout.dowels).toHaveLength(0);
    // standing on their cut faces the holes are round: filament needs walls of twice its 2.53 mm inset
    expect(s.layout.notes).toEqual([expect.objectContaining({ code: 'CONNECTORS_DROPPED', level: 'warn', count: 1, total: 1, wall: 5.1 })]);
    expect(s.layout.seams[0].joint).toBe('none');
    for (const piece of s.drilled) expect(piece.status()).toBe('NoError');
  });

  it('says how thick walls must be for filament: 6.2 mm where the holes lie on their side', () => {
    // bar halves lying flat take horizontal (teardrop) holes: filament needs 2 × 3.08 mm round each
    const bar = (t) => split(cube([300, 40, t]), [[0, 0]], { joint: 'dowels', labels: false });
    for (const t of [6, 6.1]) {
      const s = bar(t);
      expect(s.layout.dowels).toHaveLength(0);
      expect(s.layout.notes).toEqual([expect.objectContaining({ code: 'CONNECTORS_DROPPED', wall: 6.2 })]);
      expect(s.layout.notes[0].text).toContain('(walls under 6.2 mm)');
    }
    const thick = bar(6.3);
    expect(thick.layout.dowels.map((d) => d.d)).toEqual([1.75, 1.75]);
    expect(thick.layout.notes.map((n) => n.code)).toEqual(['CONNECTORS_FILAMENT']);
  });

  it('a cut whose filament holes come in two depths says to cut each length, never all of them to the longer', () => {
    // a bar that takes Ø6 pins and two 8 mm rods too narrow for them; a pocket 6.2 mm behind the cut in the far rod
    // makes its holes 3 mm deep, the other rod's 4 mm: an 8 mm rod in the shallower pair would hold the seam open
    const rack = own(own(wasm.Manifold.union([cube([300, 40, 20], [0, 20, 10]), cube([300, 8, 8], [0, 50, 4]), cube([300, 8, 8], [0, 66, 4]), cube([10, 70, 8], [-145, 35, 4]), cube([10, 70, 8], [145, 35, 4])]))
      .subtract(cube([3, 4, 7], [7.7, 66, 2.5])));
    const s = split(rack, [[0, 0]], { labels: false });
    expect(s.layout.dowels.filter((d) => d.d === FILAMENT).map((d) => d.depth).sort()).toEqual([3, 4]);
    const note = s.layout.notes.find((n) => n.code === 'CONNECTORS_FILAMENT');
    expect(note).toMatchObject({ count: 2, length: 8, lengths: [{ length: 8, count: 1 }, { length: 6, count: 1 }] });
    expect(note.text).toBe('Cut A is too narrow for Ø6 pins: its holes take 1.75 mm filament – cut 1 piece 8 mm long and 1 piece 6 mm long.');
  });

  it('holes keep clear of a hidden pocket behind the face and of a cone\'s slanted side', () => {
    const pocket = own(cube([60, 40, 40]).subtract(cube([20, 10, 4], [0, 0, 3])));
    let s = split(pocket, [[2, 0]], { diameter: 5 });
    expect(s.layout.dowels.length).toBeGreaterThanOrEqual(2);
    expectHolesInside(pocket, s.layout);
    const cone = own(wasm.Manifold.cylinder(100, 30, 5, 64));
    s = split(cone, [[2, 50]]);
    expect(s.layout.dowels.length).toBeGreaterThanOrEqual(2);
    expectHolesInside(cone, s.layout);
    s.drilled.forEach((p) => expect(p.genus()).toBe(0));
  });

  it('each patch of a U gets its own pins', () => {
    const U = own(own(wasm.Manifold.cube([60, 20, 50])).subtract(own(own(wasm.Manifold.cube([40, 30, 40])).translate([10, -5, 15]))));
    const s = split(U, [[2, 30]]);
    expect(s.layout.seams).toEqual([expect.objectContaining({ pieces: [1, 2], patches: 2 })]);
    expect([0, 1].map((k) => s.layout.dowels.filter((d) => d.patch === k).length)).toEqual([2, 2]);
    expectHolesInside(U, s.layout);
  });

  it('a thin middle piece between two parallel cuts never gets holes that meet', () => {
    const bar = own(wasm.Manifold.cube([300, 60, 60], true));
    for (const at of [8, 5]) {
      const s = split(bar, [[0, -at], [0, at]], { diameter: 5 });
      const middle = s.drilled[1];
      expect(shells(middle)).toHaveLength(1);
      expect(middle.genus()).toBe(0);
      const holes = holesOf(s.layout).filter((x) => x.dowel.sides[x.side].piece === 2);
      expect(holes.length).toBeGreaterThanOrEqual(4);
      for (const { dowel } of holes) expect(dowel.h + dowel.R + sizesFor(5).wall).toBeLessThanOrEqual(2 * at + 1e-9);
      const fromA = holes.filter((x) => x.dowel.cutId === 'c1');
      const fromB = holes.filter((x) => x.dowel.cutId === 'c2');
      for (const a of fromA) for (const b of fromB) expect(a.m.minGap(b.m, 5)).toBeGreaterThanOrEqual(sizesFor(5).wall - 1e-6);
      if (at === 8) {
        // a 16 mm piece has room for full Ø5 holes from each side (13.15 mm with the cone and the wall), so there is no
        // note to give: the holes stay full depth and the earlier cut's holes keep the later cut's apart
        expect(s.layout.notes).toEqual([]);
        expect(s.layout.dowels.every((d) => d.depth === 8)).toBe(true);
      } else {
        // at ±5 the room is 10 mm: the holes are made shallower and the note says so
        expect(s.layout.notes.filter((n) => n.code === 'CONNECTORS_SHORTER')).toEqual([
          expect.objectContaining({ letter: 'A', depth: 4.8 }),
          expect.objectContaining({ letter: 'B', depth: 4.8 }),
        ]);
      }
    }
  });

  it('crossing cuts give whole pieces whose holes never meet, at most 48 pins in all', () => {
    const block = own(wasm.Manifold.cube([200, 200, 80], true));
    const s = split(block, [[0, 0], [1, 0], [2, 0]]);
    expect(s.drilled).toHaveLength(8);
    for (const piece of s.drilled) {
      expect(shells(piece)).toHaveLength(1);
      expect(piece.genus()).toBe(0);
    }
    expect(s.layout.dowels.length).toBeLessThanOrEqual(48);
    expect(s.layout.seams).toHaveLength(12);
    expect(s.layout.seams.every((seam) => seam.dowels.length >= 2)).toBe(true);
    const holes = holesOf(s.layout);
    const wall = sizesFor(s.layout.diameter).wall;
    for (let i = 0; i < holes.length; i++) {
      for (let j = i + 1; j < holes.length; j++) {
        if (holes[i].dowel === holes[j].dowel) continue;
        expect(holes[i].m.minGap(holes[j].m, wall + 1)).toBeGreaterThanOrEqual(wall - 1e-6);
      }
    }
    expectHolesInside(block, s.layout);
    const plate = own(wasm.Manifold.cube([400, 300, 20], true));
    const p = split(plate, [[0, 0], [1, 10]], { labels: false });
    expect(p.drilled).toHaveLength(4);
    for (const piece of p.drilled) expect(piece.genus()).toBe(0);
  });
});

describe('progress', () => {
  it('the pins stage is told before the work it names, not after the faces have been measured', () => {
    const bar = own(wasm.Manifold.cube([300, 40, 20], true));
    const { spec, cuts } = cutsFor(bar, [[0, -50], [0, 50]], { labels: false });
    const r = cutPieces(bar, cuts);
    r.pieces.forEach((p) => own(p.solid));
    const log = [];
    // the band round each cut is the layout's first boolean on the whole model
    const intersect = Object.getPrototypeOf(bar).intersect;
    bar.intersect = function band(...args) {
      log.push('band');
      return intersect.apply(this, args);
    };
    try {
      layoutSplit(bar, cuts, r.pieces.map((p) => ({ ...p, up: '+z' })), spec, { progress: (stage, p) => log.push(`${stage} ${p.done}/${p.total}`) });
    } finally {
      delete bar.intersect;
    }
    expect(log[0]).toBe('Finding room for pins… 0/5');
    expect(log.filter((x) => x !== 'band')).toEqual(['Finding room for pins… 0/5', 'Finding room for pins… 1/5', 'Finding room for pins… 2/5', 'Finding room for pins… 3/5', 'Finding room for pins… 4/5']);
  });
});

describe('odd shapes', () => {
  it('an L cut on X and Y has three pieces, numbered past the empty cell, and seams only where material meets', () => {
    const L = own(wasm.Manifold.union([cube([100, 40, 20], [50, 20, 10]), cube([40, 100, 20], [20, 50, 10])]));
    const s = split(L, [[0, 50], [1, 50]], { labels: false });
    expect(s.pieces.map((p) => [p.index, p.cell.join('')])).toEqual([[1, '000'], [2, '100'], [3, '010']]);
    expect(s.layout.seams.map((x) => [x.letter, x.pieces])).toEqual([['A', [1, 2]], ['B', [1, 3]]]);
    expect(s.layout.seams.every((x) => x.dowels.length >= 2)).toBe(true);
    s.drilled.forEach((p) => expect(p.genus()).toBe(0));
    expectHolesInside(L, s.layout);
  });

  it('a cut through a gap cuts nothing and asks for no pins; labels need a font', () => {
    const two = own(wasm.Manifold.union([cube([40, 20, 10], [-30, 0, 0]), cube([40, 20, 10], [30, 0, 0])]));
    const s = split(two, [[0, 0]]);
    expect(s.pieces.map((p) => p.volume)).toEqual([8000, 8000]);
    expect(s.layout).toMatchObject({ dowels: [], labels: [], seams: [], notes: [] });
    const box = own(wasm.Manifold.cube([120, 40, 30], true));
    const { spec, cuts } = cutsFor(box, [[0, 0]], { diameter: 5 });
    const r = cutPieces(box, cuts);
    r.pieces.forEach((p) => own(p.solid));
    const layout = layoutSplit(box, cuts, r.pieces, spec);
    expect(layout.dowels).toHaveLength(2);
    expect(layout.labels).toEqual([]);
    expect(layout.notes).toEqual([]);
  });
});

describe('the pieces view', () => {
  it('lays each piece and pin out as one contiguous range', () => {
    const box = own(wasm.Manifold.cube([120, 40, 30], true));
    const s = split(box, [[0, 0]], { diameter: 5, count: 2, labels: false });
    const pins = s.layout.dowels.map((d) => own(pinAt(d)));
    const soup = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const d = buildSplitDisplay([
      ...s.drilled.map((solid, k) => ({ solid, soup: k === 1 ? soup : null, part: { kind: 'piece', index: k + 1 } })),
      ...pins.map((solid, k) => ({ solid, part: { kind: 'pin', cell: s.layout.dowels[k].cell } })),
    ]);
    expect(d.parts.map((p) => p.kind)).toEqual(['piece', 'piece', 'pin', 'pin']);
    expect(d.parts[2].cell).toEqual([0.5, 0, 0]);
    let next = 0;
    let vNext = 0;
    for (const [t0, n, v0, nv] of d.ranges) {
      expect(t0).toBe(next);
      expect(v0).toBe(vNext);
      next += n;
      vNext += nv;
      for (let i = t0 * 3; i < (t0 + n) * 3; i++) {
        expect(d.index[i]).toBeGreaterThanOrEqual(v0);
        expect(d.index[i]).toBeLessThan(v0 + nv);
      }
    }
    expect(next).toBe(d.index.length / 3);
    expect(vNext).toBe(d.positions.length / 3);
    const [, second] = d.ranges;
    expect(d.passthroughRanges).toEqual([[second[0] + second[1] - 1, 1]]);
    expect(d.passthroughStart).toBe(second[0] + second[1] - 1);
  });
});

// ---------- cuts that come apart ----------

/**
 * Cuts through the stage chain as the engine runs it, each coming apart unless it is `[axis, at, false]`: the pieces
 * lie on `bed`, and the piece that carries each lip is split.js's choice (`apartMales`), or the one on side `male` (0
 * the one below the cut) when asked. `pairs` are what the layout asked about, with both sides' lips.
 */
function apartSplit(solid, list, { hold = 'snap', clearance = 0.15, joint = 'auto', orient = null, male = null, bed = BED, labels = false, progress = null } = {}) {
  const stored = list.map(([axis, at, apart = true], i) => {
    const position = [0, 0, 0];
    const normal = [0, 0, 0];
    position[axis] = at;
    normal[axis] = 1;
    return { id: `c${i + 1}`, position, normal, ...(apart ? { joint: 'apart', hold } : {}) };
  });
  const { spec, cuts } = normaliseSplit({ cuts: stored, clearance, joint, labels, ...(orient ? { orient } : {}) }, boxOf(solid));
  const plan = planDovetails(solid, cuts, spec);
  const cut = cutPieces(solid, cuts, { dove: plan.dove, tabs: plan.tabs });
  cut.pieces.forEach((p) => own(p.solid));
  const pieces = cut.pieces.map((p) => {
    const lying = chooseOrientation(p.stats, bed, spec.orient, { pieceIndex: p.index });
    return { ...p, lying, up: lying.up };
  });
  const pairs = [];
  const forcedSeen = [];
  const chooser = apartMales(pieces, bed, spec.orient);
  const side = (pair, k) => ({ male: k, piece: k === 0 ? pair.lo : pair.hi, down: `${k === 0 ? '-' : '+'}${AXES[pair.axis]}` });
  const layout = layoutSplit(solid, cuts, pieces, spec, {
    joints: plan.joints,
    tabs: plan.tabs,
    font: labels ? font : null,
    progress,
    apartMales: (asked, given) => {
      pairs.push(...asked);
      return male === null ? chooser(asked, given) : asked.map((pair) => side(pair, male));
    },
    pegMales: spec.joint === 'pegs'
      ? (asked, length, forced) => {
        forcedSeen.push(forced);
        return pegMales(pieces, bed, spec.orient, { forced })(asked, length);
      }
      : null,
  });
  const drilled = pieces.map((p) => own(drillPiece(p.solid, layout, p.index, { font })));
  return { spec, cuts, plan, pieces, layout, drilled, pairs, forcedSeen, notes: [...plan.notes, ...layout.notes] };
}

/** A lip's solids where they stand (world), and its frame. */
function lipParts(lip) {
  const s = lipSolids(lip);
  const frame = lipFrame(lip.axis, lip.at, lip.dir);
  const placed = (m) => own(own(m).transform(frame));
  return { tongue: placed(s.tongue), cutters: placed(s.cutters), catches: s.catches.map(placed), recesses: s.recesses.map(placed), frame };
}

/** What of a solid lies within `below` and `above` of a cut along its axis: the lip's neighbourhood, quick to test. */
function nearCut(m, axis, at, below, above) {
  const b = boxOf(m);
  const min = b.min.map((v) => v - 1);
  const max = b.max.map((v) => v + 1);
  min[axis] = at - below;
  max[axis] = at + above;
  return own(m.intersect(own(boxAt(min, max))));
}

const positiveShells = (m) => shells(m).filter((x) => x.volume() > 0).length;
const near = (x, want, tol) => Math.abs(x - want) <= tol;

/**
 * The most the lips' catches, moved in by s (as the clips bow to let go), meet the female piece lifted 0…top off
 * them: 0 means it comes off. Only the female round each catch is tested, which is all a catch can meet.
 */
function release(lips, female, s, { top = 9, step = 0.25, early = false } = {}) {
  const { Manifold } = wasm;
  const moved = [];
  const around = [];
  for (const lip of lips) {
    const parts = lipParts(lip);
    const o = applyMat4(parts.frame, [0, 0, 0]);
    lip.windows.forEach((w, k) => {
      const out = applyMat4(parts.frame, [w.chord.out[0], w.chord.out[1], 0]).map((v, a) => v - o[a]);
      moved.push(own(parts.catches[k].translate(out.map((v) => -s * v))));
      const b = boxOf(parts.catches[k]);
      const min = b.min.map((v) => v - 1.5);
      const max = b.max.map((v) => v + 1.5);
      if (lip.dir > 0) min[lip.axis] -= top + 1;
      else max[lip.axis] += top + 1;
      around.push(own(boxAt(min, max)));
    });
  }
  if (!moved.length) return 0;
  const catches = own(Manifold.union(moved));
  const crop = own(female.intersect(own(Manifold.union(around))));
  let worst = 0;
  for (let dz = 0; dz <= top + 1e-9; dz += step) {
    const d = [0, 0, 0];
    d[lips[0].axis] = dz * lips[0].dir;
    worst = Math.max(worst, lift(catches, crop, d));
    if (early && worst > 1e-6) break;
  }
  return worst;
}

/**
 * The most each whole clip of a lip (the bridge over its slot, with its catch), bowed in by the interference and a
 * little, meets the female lifted 0…8 mm: 0 means the clips have room to bow and let go.
 */
function bowed(lip, female) {
  const parts = lipParts(lip);
  const o = applyMat4(parts.frame, [0, 0, 0]);
  const bridges = lip.windows.map((w) => {
    const slot = own(new wasm.CrossSection(w.slot, 'Positive'));
    const column = own(own(own(wasm.Manifold.extrude(slot, 17)).translate([0, 0, 3.001])).transform(parts.frame));
    const out = applyMat4(parts.frame, [w.chord.out[0], w.chord.out[1], 0]).map((v, a) => v - o[a]);
    return own(own(parts.tongue.intersect(column)).translate(out.map((v) => -(lip.i + 0.05) * v)));
  });
  const bent = own(wasm.Manifold.union(bridges));
  let worst = 0;
  for (let dz = 0; dz <= 8; dz += 0.5) {
    const d = [0, 0, 0];
    d[lip.axis] = dz * lip.dir;
    worst = Math.max(worst, lift(bent, female, d));
  }
  return worst;
}

/** How far the catches must move in before the female comes off (bisection, to 0.002 mm). */
function deflection(lips, female) {
  let lo = 0;
  let hi = 0.8;
  for (let k = 0; k < 9; k++) {
    const mid = (lo + hi) / 2;
    if (release(lips, female, mid, { top: 7, step: 0.1, early: true }) > 1e-6) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** How far the female lifts off the male before they meet (0.01 mm steps up to 1 mm). */
function freePlay(male, female, dir) {
  let free = 0;
  for (let k = 1; k <= 100; k++) {
    if (lift(male, female, dir.map((v) => (v * k) / 100)) > 1e-6) break;
    free = k / 100;
  }
  return free;
}

/** A slicer's overhangs (`overhangs`) over 0.05 mm², as width × length @ height above `z0`. */
const overhangList = (m, from, to, z0) => overhangs(m, from, to, 0.2).filter((o) => o.area > 0.05).map((o) => ({ width: o.width, long: o.long, z: +(o.z - z0).toFixed(2) }));

/** A hollow box open at the top: outside `size` (centred on x and y), walls `wall` thick, a floor `floor` thick. */
function tray(size, wall, floor = 2) {
  const [x, y, z] = size;
  return own(own(boxAt([-x / 2, -y / 2, 0], [x / 2, y / 2, z])).subtract(own(boxAt([-x / 2 + wall, -y / 2 + wall, floor], [x / 2 - wall, y / 2 - wall, z + 1]))));
}

describe('take-apart lips', () => {
  it('the lantern fixture is the model the lip\'s numbers were measured on', () => {
    const lantern = own(lanternSolid());
    expect(lantern.volume()).toBeCloseTo(303965.2, 0);
    expect(lantern.genus()).toBe(8);
    expect(lantern.numTri()).toBe(808);
    expect(boxOf(lantern)).toMatchObject({ min: [-55, -55, 0], max: [55, 55, 291] });
    const face = own(lantern.slice(190));
    expect(face.area()).toBeCloseTo(1728, 3);
    expect(shells(face)).toHaveLength(1);
    expect(stlCheck(lantern)).toEqual({ degenerate: 0, open: 0 });
  });

  it('the lantern\'s top clicks onto a 6 mm lip with 4 clips and a key, sits tight, holds and pulls off again', () => {
    const lantern = own(lanternSolid());
    const r = apartSplit(lantern, [[2, 190]]);
    expect(r.plan.joints).toEqual({ c1: 'lip' });
    expect(r.layout.lips).toHaveLength(1);
    const [lip] = r.layout.lips;
    expect(lip).toMatchObject({ kind: 'opening', H: 6, clips: 4, male: 0, dir: 1, down: '-z', hold: 'snap', p: 0.4, i: 0.25, zTop: 8.15, why: [] });
    expect(lip.sides).toEqual([{ piece: 1, male: true }, { piece: 2, male: false }]);
    const middles = lip.windows.map((w) => w.chord.p);
    for (const want of [[47.7, 0], [0, 47.7], [-47.7, 0], [0, -47.7]]) expect(middles.some((m) => near(m[0], want[0], 0.05) && near(m[1], want[1], 0.05))).toBe(true);
    expect(near(lip.key.p[0], -46.91, 0.1) && near(lip.key.p[1], -47.02, 0.1)).toBe(true);
    expect(lip.area).toBeCloseTo(590.83, 0);

    const [body, lid] = r.drilled;
    expect([body.genus(), lid.genus()]).toEqual([12, 1]);
    for (const piece of [body, lid]) {
      expect(piece.status()).toBe('NoError');
      expect(positiveShells(piece)).toBe(1);
      expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
    }
    const b = nearCut(body, 2, 190, 2, 10);
    const l = nearCut(lid, 2, 190, 2, 14);
    const parts = lipParts(lip);
    // seated: touching nowhere, with the clearance all round, and no room to slide
    expect(lift(b, l)).toBeLessThan(1e-9);
    expect(parts.tongue.minGap(lid, 1)).toBeGreaterThanOrEqual(0.149);
    expect(lift(b, l, [0.14, 0, 0])).toBeLessThan(1e-6);
    expect(lift(b, l, [0.16, 0, 0])).toBeGreaterThan(1);
    // held: lifted, the catches meet their recesses' tops
    expect(lift(b, l, [0, 0, 0.2])).toBeLessThan(1e-6);
    expect(near(lift(b, l, [0, 0, 0.25]), 0.206, 0.01)).toBe(true);
    expect(near(lift(b, l, [0, 0, 0.5]), 1.569, 0.03)).toBe(true);
    expect(near(freePlay(b, l, [0, 0, 1]), 0.21, 0.01)).toBe(true);
    // released: with the clips bowed in by the interference and a little, it lifts all the way off
    expect(release(r.layout.lips, lid, lip.i + 0.05)).toBeLessThan(1e-6);
    expect(near(deflection(r.layout.lips, lid), 0.25, 0.01)).toBe(true);
    // and each whole clip has room to bow in that far
    expect(bowed(lip, l)).toBeLessThan(1e-6);
    // the key: turned a quarter, a half or three quarters, the top doesn't go on
    for (const turn of [90, 180, 270]) expect(lift(b, own(l.rotate([0, 0, turn])))).toBeGreaterThan(40);

    // printing: the body upright has only the four clips' bridges over their slots; the lid prints on its cut face,
    // or upside down, as the plain lid does
    const bodyOver = overhangList(body, 190.1, 198, 190);
    expect(bodyOver).toHaveLength(4);
    for (const o of bodyOver) {
      expect(near(o.width, 1.6, 0.05) && near(o.long, 39.6, 0.2)).toBe(true);
      expect(o.z).toBeCloseTo(3.1, 5);
    }
    const plainLid = r.pieces[1].solid;
    const top = 190 + lip.zTop + 1.5;
    expect(overhangList(lid, 190.1, top, 190)).toEqual(overhangList(plainLid, 190.1, top, 190));
    expect(overhangList(own(lid.rotate([180, 0, 0])), -top, -190.1, -190)).toEqual(overhangList(own(plainLid.rotate([180, 0, 0])), -top, -190.1, -190));
    // an elephant's foot on the lid's first layers still clears the lip
    const first = own(lid.slice(190.1));
    for (const e of [0.1, 0.2, 0.3]) {
      const foot = own(own(wasm.Manifold.extrude(own(own(first.offset(e, 'Round', 2, 32)).subtract(first)), 0.3)).translate([0, 0, 190]));
      expect(lift(foot, body)).toBeLessThan(1e-6);
    }
    // nothing changes outside the face's own columns: the outside and the opening are as they were
    const columns = own(own(wasm.Manifold.extrude(own(own(lantern.slice(190)).offset(0.06, 'Round', 2, 32)), 40)).translate([0, 0, 170]));
    expect(own(own(body.subtract(r.pieces[0].solid)).subtract(columns)).volume()).toBeLessThan(1e-4);
    expect(own(own(plainLid.subtract(lid)).subtract(columns)).volume()).toBeLessThan(1e-4);
  });

  it('the clearance tunes the click: the catch stands 0.4 mm out of the clip, at least 0.1 more than the clearance', () => {
    for (const [c, p, i, bend] of [[0.05, 0.4, 0.35, 0.35], [0.3, 0.4, 0.1, 0.1], [0.45, 0.55, 0.1, 0.1]]) {
      const r = apartSplit(own(lanternSolid()), [[2, 190]], { clearance: c });
      const [lip] = r.layout.lips;
      expect(lip).toMatchObject({ H: 6, clips: 4, c });
      expect(lip.p).toBeCloseTo(p, 9);
      expect(lip.i).toBeCloseTo(i, 9);
      expect(near(deflection(r.layout.lips, r.drilled[1]), bend, 0.01)).toBe(true);
      if (c === 0.45) expect(near(lift(nearCut(r.drilled[0], 2, 190, 2, 10), nearCut(r.drilled[1], 2, 190, 2, 14), [0, 0, 1]), 0.727, 0.02)).toBe(true);
    }
  });

  it('Light click has smaller catches; Lifts off has none, and the top lifts straight off', () => {
    const light = apartSplit(own(lanternSolid()), [[2, 190]], { hold: 'light' });
    expect(light.layout.lips[0]).toMatchObject({ hold: 'light', clips: 4, p: 0.25 });
    expect(near(deflection(light.layout.lips, light.drilled[1]), 0.1, 0.01)).toBe(true);
    expect(near(lift(nearCut(light.drilled[0], 2, 190, 2, 10), nearCut(light.drilled[1], 2, 190, 2, 14), [0, 0, 0.25]), 0.085, 0.01)).toBe(true);
    const off = apartSplit(own(lanternSolid()), [[2, 190]], { hold: 'lift' });
    expect(off.layout.lips[0]).toMatchObject({ hold: 'lift', H: 6, clips: 0, windows: [], why: [] });
    expect(off.layout.lips[0].key).not.toBeNull();
    expect(off.drilled[0].genus()).toBe(8);
    const b = nearCut(off.drilled[0], 2, 190, 2, 10);
    const l = nearCut(off.drilled[1], 2, 190, 2, 14);
    let worst = 0;
    for (let dz = 0; dz <= 9; dz += 0.25) worst = Math.max(worst, lift(b, l, [0, 0, dz]));
    expect(worst).toBeLessThan(1e-6);
    expect(off.notes.map((n) => n.code)).toEqual(['APART']);
    expect(off.notes[0].text).toBe('Cut A comes apart: the top (piece 2) sits on a 6 mm lip on piece 1 and lifts straight off.');
  });

  it('a lip on the piece above the cut is the same lip mirrored: the lantern upside down', () => {
    const r = apartSplit(own(own(lanternSolid()).rotate([180, 0, 0])), [[2, -190]]);
    const [lip] = r.layout.lips;
    // the body is above the cut now, and lies on its floor with the lip standing up out of it
    expect(lip).toMatchObject({ male: 1, dir: -1, down: '+z', H: 6, clips: 4 });
    expect(lip.area).toBeCloseTo(590.83, 0);
    const [roof, body] = r.drilled;
    expect([roof.genus(), body.genus()]).toEqual([1, 12]);
    for (const piece of [roof, body]) expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
    const b = nearCut(body, 2, -190, 10, 2);
    const l = nearCut(roof, 2, -190, 14, 2);
    expect(lift(b, l)).toBeLessThan(1e-9);
    expect(near(lift(b, l, [0, 0, -0.25]), 0.206, 0.01)).toBe(true);
    expect(release(r.layout.lips, roof, lip.i + 0.05)).toBeLessThan(1e-6);
    expect(r.layout.seams[0]).toMatchObject({ joint: 'lip', male: 2, apart: { lip: true, clips: 4 } });
  });

  it('a cut too near the roof gets a shorter lip, or none, and says where a lip with clips would fit', () => {
    const at192 = apartSplit(own(lanternSolid()), [[2, 192]]);
    expect(at192.layout.lips[0]).toMatchObject({ H: 4.5, clips: 0, why: ['height'], room: 7.85, suggestedAt: 190.5 });
    expect(at192.notes.map((n) => n.code)).toEqual(['APART', 'APART_NO_CLIPS']);
    expect(at192.notes[1]).toMatchObject({ why: 'height', height: 4.5, suggestedAt: 190.5 });
    expect(at192.notes[1].text).toBe('Cut A\'s lip is only 4.5 mm tall, so it has no clips and the top just lifts off: a lip that clicks on needs 9.4 mm of plain wall in piece 2 past the cut. Move the cut to 190.5 mm.');
    expect(apartSplit(own(lanternSolid()), [[2, 190.5]]).layout.lips[0]).toMatchObject({ H: 6, clips: 4 });
    // on the body the groove's piece has no room at all. The top would take the lip, but only standing on its handle:
    // the body prints as well, so the cut has no lip here and the note says where the body has one
    for (const at of [194, 196]) {
      const r = apartSplit(own(lanternSolid()), [[2, at]]);
      expect(r.layout.lips).toEqual([]);
      expect(r.pairs[0].quality[0]).toBeNull();
      expect(r.pairs[0].quality[1]).toMatchObject({ H: 6, clips: 4 });
      expect(r.notes.map((n) => n.code)).toEqual(['APART_FLAT']);
      expect(r.notes[0]).toMatchObject({ why: 'room', suggestedAt: 190.5 });
      expect(r.notes[0].text).toBe('Cut A has no room for a lip – piece 2 has under 6.4 mm of plain wall past the cut before a roof, a ledge or an opening. Move the cut to 190.5 mm.');
      expect(r.layout.seams[0]).toMatchObject({ joint: 'none', male: null, apart: { lip: false, faces: 0, flat: 1 } });
    }
    // on a printer 195 mm tall the body fits, but not with a lip standing 6 mm out of it, and the top would carry it
    // standing on its handle: no lip, and the note says where the body has room to carry it
    const short = apartSplit(own(lanternSolid()), [[2, 190]], { bed: [210, 210, 195] });
    expect(short.layout.lips).toEqual([]);
    expect(short.notes.map((n) => [n.code, n.why, n.suggestedAt])).toEqual([['APART_FLAT', 'tall', 189]]);
    expect(short.notes[0].text).toBe('Cut A has no lip: piece 1 would be too tall for your printer standing up with one, and piece 2 would need supports carrying it. Move the cut to 189 mm.');
    expect(apartSplit(own(lanternSolid()), [[2, 189]], { bed: [210, 210, 195] }).layout.lips[0]).toMatchObject({ male: 0, H: 6, clips: 4 });
    // with nowhere to move to (the windows below), the top carries it, on its handle, rather than none at all
    const low = apartSplit(own(lanternSolid()), [[2, 190]], { bed: [210, 210, 150] });
    expect(low.layout.lips[0]).toMatchObject({ male: 1, down: '+z', H: 6, clips: 4 });
  });

  it('a move the notes offer is tried there first: past the roof\'s slope, or up off the top of the windows', () => {
    // in the roof the slope is in the way wherever the cut goes down to the eaves: the move goes on to below them
    for (const at of [203, 205]) {
      const r = apartSplit(own(lanternSolid()), [[2, at]]);
      expect(r.notes.map((n) => [n.code, n.why, n.suggestedAt])).toEqual([['APART_FLAT', 'room', 190.5]]);
    }
    // right at the top of the windows the tongue's foot stands over them, broken into short stretches; down only goes
    // into the windows, half a millimetre up the wall is whole
    const edge = apartSplit(own(lanternSolid()), [[2, 160]]);
    expect(edge.layout.lips[0]).toMatchObject({ H: 6, clips: 0, why: ['short'], root: true, suggestedAt: 160.5 });
    expect(edge.notes[1]).toMatchObject({ code: 'APART_NO_CLIPS', why: 'edge', suggestedAt: 160.5 });
    expect(edge.notes[1].text).toBe('Cut A runs along the edge of an opening or a ledge, which breaks its lip into short stretches, so it has no clips and the top just lifts off. Move the cut to 160.5 mm.');
    expect(apartSplit(own(lanternSolid()), [[2, 160.5]]).layout.lips[0]).toMatchObject({ H: 6, clips: 4, root: false, suggestedAt: null });
    // a jar cut in its shoulder: a move by the room the shoulder leaves takes more of it into the top, so it goes on to
    // below the shoulder, as far as the room there says
    const jar = () => {
      const { Manifold } = wasm;
      const outer = own(Manifold.union([own(Manifold.cylinder(100, 45, 45, 96)), own(own(Manifold.cylinder(20, 45, 18, 96)).translate([0, 0, 100])), own(own(Manifold.cylinder(25, 18, 18, 96)).translate([0, 0, 120]))]));
      const inner = own(Manifold.union([own(own(Manifold.cylinder(97, 42, 42, 96)).translate([0, 0, 3])), own(own(Manifold.cylinder(20, 42, 15, 96)).translate([0, 0, 100])), own(own(Manifold.cylinder(27, 15, 15, 96)).translate([0, 0, 120]))]));
      return own(outer.subtract(inner));
    };
    for (const at of [110, 100.5]) expect(apartSplit(jar(), [[2, at]]).notes.map((n) => [n.code, n.why, n.suggestedAt])).toEqual([['APART_FLAT', 'room', 90.5]]);
    expect(apartSplit(jar(), [[2, 91]]).notes.map((n) => [n.code, n.why, n.suggestedAt])).toEqual([['APART', undefined, undefined], ['APART_NO_CLIPS', 'height', 90.5]]);
    // there it has as good a lip as a round wall takes – no straight stretch for a clip – and no more move
    expect(apartSplit(jar(), [[2, 90.5]]).notes.map((n) => [n.code, n.why, n.suggestedAt])).toEqual([['APART', undefined, undefined], ['APART_NO_CLIPS', 'short', undefined]]);
  });

  it('a cut through the windows has only small faces: no lip, and the note says to cut through a solid band', () => {
    const r = apartSplit(own(lanternSolid()), [[2, 100]]);
    expect(r.layout.lips).toEqual([]);
    expect(r.notes.map((n) => [n.code, n.why])).toEqual([['APART_FLAT', 'small']]);
    expect(r.layout.seams[0]).toMatchObject({ joint: 'none', labels: null, apart: { hold: 'snap', lip: false, clips: 0, faces: 0, flat: 8 } });
  });

  it('crossed by a glued cut, each half of the face gets its own lip with 3 clips, and the cut one key', () => {
    const r = apartSplit(own(lanternSolid()), [[0, 0, false], [2, 190]]);
    expect(r.layout.lips).toHaveLength(2);
    expect(r.layout.lips.map((l) => l.clips)).toEqual([3, 3]);
    expect(r.layout.lips.filter((l) => l.key)).toHaveLength(1);
    for (const piece of r.drilled) {
      expect(piece.status()).toBe('NoError');
      expect(positiveShells(piece)).toBe(1);
      expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
    }
    const lower = r.drilled.filter((d, k) => r.pieces[k].cell[2] === 0);
    const upper = r.drilled.filter((d, k) => r.pieces[k].cell[2] === 1);
    const body = own(lower[0].add(lower[1]));
    const lid = own(upper[0].add(upper[1]));
    expect(lift(body, lid)).toBeLessThan(1e-9);
    expect(release(r.layout.lips, lid, r.layout.lips[0].i + 0.05)).toBeLessThan(1e-6);
    expect(r.notes.find((n) => n.code === 'APART').text).toBe('Cut B comes apart: the top (pieces 3 and 4) clicks onto a 6 mm lip on pieces 1 and 2 – 6 clips hold it, and it pulls off again by hand.');
  });

  it('the fit test for a cut that comes apart is a small box and its lid with the same lip and clips', () => {
    const coupon = own(fitTestCoupon({ clearance: 0.15 }, 0.4, { pins: false, apart: 'snap' }));
    const parts = shells(coupon);
    expect(parts).toHaveLength(2);
    const sizes = parts.map((p) => boxOf(p).size.map((v) => +v.toFixed(2)));
    const k = sizes.findIndex((x) => x[2] > 15);
    expect(sizes[k]).toEqual([60, 30, 18]);
    expect(sizes[1 - k]).toEqual([60, 30, 12]);
    for (const p of parts) expect(stlCheck(p)).toEqual({ degenerate: 0, open: 0 });
    // the lid put back on the box: seated, and held by the clips
    const lid = own(parts[1 - k].translate([boxOf(parts[k]).min[0] - boxOf(parts[1 - k]).min[0], 0, 12]));
    expect(lift(parts[k], lid)).toBeLessThan(1e-9);
    expect(near(lift(parts[k], lid, [0, 0, 0.25]), 0.103, 0.01)).toBe(true);
    // with pins too, they come first in the row
    expect(shells(own(fitTestCoupon({ clearance: 0.15 }, 0.4, { apart: 'lift' })))).toHaveLength(5);
  });
});

describe('take-apart lips on other shapes', () => {
  it('a wall needs 2.7 mm for a lip; the catches\' recesses keep two nozzles of skin, and every lip lets go', () => {
    const { Manifold } = wasm;
    const outside = own(own(boxAt([-80, -80, 30], [80, 80, 70])).subtract(own(boxAt([-50, -50, 20], [50, 50, 80]))));
    const thin = apartSplit(tray([100, 100, 100], 2.6), [[2, 50]]);
    expect(thin.layout.lips).toEqual([]);
    expect(thin.notes.map((n) => [n.code, n.why, n.wall])).toEqual([['APART_FLAT', 'thin', 2.7]]);
    expect(thin.notes[0].text).toBe('Cut A has no room for a lip – its walls are under 2.7 mm thick – so the top just rests on piece 1, with nothing to line it up or hold it.');
    for (const [wall, skin, area] of [[2.7, 0.8, null], [3, null, 584.4], [6, 3.75, null]]) {
      const r = apartSplit(tray([100, 100, 100], wall), [[2, 50]]);
      const [lip] = r.layout.lips;
      expect(lip).toMatchObject({ kind: 'opening', H: 6, clips: 4 });
      if (skin !== null) expect(own(Manifold.union(lipParts(lip).recesses)).minGap(outside, 5)).toBeCloseTo(skin, 2);
      if (area !== null) expect(near(lip.area, area, 0.5)).toBe(true);
      expect(release(r.layout.lips, r.drilled[1], lip.i + 0.05)).toBeLessThan(1e-6);
      for (const piece of r.drilled) expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
    }
  });

  it('a solid face gets a channel round a core: clips with room to bow in, and the groove\'s piece has only its roof to bridge', () => {
    const { Manifold } = wasm;
    const post = own(boxAt([-30, -30, 0], [30, 30, 100]));
    const holed = own(own(post.subtract(own(own(Manifold.cylinder(120, 4, 4, 32)).translate([10, 10, -10])))).subtract(own(own(Manifold.cylinder(120, 2, 2, 32)).translate([-15, 5, -10]))));
    for (const solid of [post, holed]) {
      const r = apartSplit(solid, [[2, 50]]);
      const [lip] = r.layout.lips;
      expect(lip).toMatchObject({ kind: 'channel', H: 6, clips: 4 });
      expect(lip.key).not.toBeNull();
      const [body, lid] = r.drilled;
      for (const piece of r.drilled) expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
      expect(lift(body, lid)).toBeLessThan(1e-9);
      expect(lipParts(lip).tongue.minGap(lid, 1)).toBeGreaterThanOrEqual(0.147);
      expect(release(r.layout.lips, lid, lip.i + 0.05)).toBeLessThan(1e-6);
      // the core inside the tongue is relieved behind each clip, so it has room to bow in
      expect(bowed(lip, lid)).toBeLessThan(1e-6);
      const over = overhangList(lid, 50.1, 50 + lip.zTop + 1.5, 50);
      expect(over).toHaveLength(1);
      expect(over[0].width).toBeLessThanOrEqual(2.6);
    }
    expect(apartSplit(own(boxAt([-6, -30, 0], [6, 30, 100])), [[2, 50]]).layout.lips[0]).toMatchObject({ kind: 'channel', clips: 2 });
  });

  it('a clip gives way where its catch\'s recess would leave under two nozzles of skin, or its relief would come near a hole', () => {
    const { Manifold } = wasm;
    // at 0.45 mm clearance a 3 mm wall has room for the lip, not for the catches' recesses outside it
    const tight = apartSplit(tray([100, 100, 100], 3), [[2, 50]], { clearance: 0.45 });
    expect(tight.layout.lips[0]).toMatchObject({ H: 6, clips: 0, why: ['skin'] });
    expect(tight.notes[1]).toMatchObject({ code: 'APART_NO_CLIPS', why: 'skin' });
    expect(tight.notes[1].text).toBe('Cut A\'s walls are too thin for the clips\' catches, so the top just lifts off.');
    expect(apartSplit(tray([100, 100, 100], 3), [[2, 50]], { clearance: 0.3 }).layout.lips[0].clips).toBe(4);
    // a solid post with a Ø2 hole 6 mm in from one side: that side's clip would bow into a relief too near the hole
    const hole = own(own(Manifold.cylinder(120, 1, 1, 32)).translate([24, 0, -10]));
    const post = own(own(boxAt([-30, -30, 0], [30, 30, 100])).subtract(hole));
    const r = apartSplit(post, [[2, 50]]);
    expect(r.layout.lips[0]).toMatchObject({ kind: 'channel', clips: 3, why: ['flex'] });
    expect(own(lipCavityAt(r.layout.lips[0])).minGap(hole, 3)).toBeGreaterThanOrEqual(1.2 - 1e-3);
    for (const piece of r.drilled) expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
  });

  it('a move the notes offer stays on the model: a box 10 mm tall cut 4 mm up has nowhere to move to', () => {
    const closed = own(own(boxAt([-40, -40, 0], [40, 40, 10])).subtract(own(boxAt([-36, -36, 2], [36, 36, 8]))));
    const r = apartSplit(closed, [[2, 4]], { male: 0 });
    expect(r.notes.map((n) => [n.code, n.why])).toEqual([['APART_FLAT', 'room']]);
    expect(r.notes[0].suggestedAt).toBeUndefined();
    expect(r.notes[0].text).toBe('Cut A has no room for a lip – piece 2 has under 6.4 mm of plain wall past the cut before a roof, a ledge or an opening.');
  });

  it('a box of compartments: its dividers are passed over, and keep their full height and width up to the rim', () => {
    // a box 120 × 120 × 40 with 4 mm walls, 3 mm dividers and a closed top, 16 compartments each too small to be an
    // opening by itself: with no room for a channel's tongue the compartments are the openings, and the thin dividers
    // between them run together, so the tongue hugs the outside wall
    const compartments = (size, wall, divider, n, m) => {
      const [X, Y, Z] = size;
      const cw = (X - 2 * wall - (n - 1) * divider) / n;
      const ch = (Y - 2 * wall - (m - 1) * divider) / m;
      const cells = [];
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < m; j++) {
          const x0 = -X / 2 + wall + i * (cw + divider);
          const y0 = -Y / 2 + wall + j * (ch + divider);
          cells.push(own(boxAt([x0, y0, 2], [x0 + cw, y0 + ch, Z - 2])));
        }
      }
      return own(own(boxAt([-X / 2, -Y / 2, 0], [X / 2, Y / 2, Z])).subtract(own(wasm.Manifold.union(cells))));
    };
    const r = apartSplit(compartments([120, 120, 40], 4, 3, 4, 4), [[2, 34]]);
    expect(r.layout.lips).toHaveLength(1);
    expect(r.layout.lips[0]).toMatchObject({ kind: 'opening', H: 6, clips: 5 });
    expect(r.notes.map((n) => n.code)).toEqual(['APART']);
    for (const piece of r.drilled) expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
    expect(lift(r.drilled[0], r.drilled[1])).toBeLessThan(1e-9);
    const face = own(compartments([120, 120, 40], 4, 3, 4, 4).slice(34));
    const regions = lipRegions(face, 0.15);
    [regions.fill, regions.A, regions.smallHoles].forEach(own);
    expect(regions.kind).toBe('opening');
    expect(regions.A.area()).toBeCloseTo(112 * 112, 0); // the 16 compartments and the dividers between them
    // two compartments with a divider under two grooves and a wall (4.9 mm): the box's divider is only notched at its
    // ends, its full width every way up to the rim, where the grooves once left it a 0.3 mm fin or took its top off
    const across = (piece, d, z) => {
      const window = own(wasm.CrossSection.square([d + 4, 60], true));
      return own(own(piece.slice(z)).intersect(window)).area() / 60;
    };
    for (const d of [2, 4]) {
      const two = apartSplit(compartments([160, 80, 60], 3, d, 2, 1), [[2, 50]]);
      // the lid carries the lip, and the box below has the grooves
      expect(two.layout.lips[0]).toMatchObject({ male: 1, H: 6, clips: 5 });
      const box = two.drilled[0];
      for (const z of [44, 46, 48, 49.5]) expect(across(box, d, z)).toBeCloseTo(d, 3);
    }
    // a 5 mm divider takes a groove each side and keeps a wall between them
    const wide = apartSplit(compartments([160, 80, 60], 3, 5, 2, 1), [[2, 50]]);
    expect(wide.layout.lips[0]).toMatchObject({ male: 1, H: 6, clips: 8 });
    const box = wide.drilled[0];
    for (const z of [44, 46, 48, 49.5]) expect(across(box, 5, z)).toBeGreaterThanOrEqual(1.2 - 1e-3);
  });

  it('round and many-sided tubes: clips only where the outline turns little, framed on its chord; a hexagon\'s key lets it on one way only', () => {
    const { Manifold } = wasm;
    const round = (D, wall, h, n) => own(own(Manifold.cylinder(h, D / 2, D / 2, n)).subtract(own(own(Manifold.cylinder(h + 2, D / 2 - wall, D / 2 - wall, n)).translate([0, 0, 2]))));
    const small = apartSplit(round(100, 4, 100, 96), [[2, 50]]);
    expect(small.layout.lips[0]).toMatchObject({ clips: 0 });
    expect(small.layout.lips[0].key).not.toBeNull();
    expect(small.notes.find((n) => n.code === 'APART_NO_CLIPS').text).toBe('Cut A\'s lip has no straight stretch 46 mm long for a clip, so the top just lifts off.');
    for (const piece of small.drilled) expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
    const big = apartSplit(round(300, 4, 60, 256), [[2, 30]]);
    expect(big.layout.lips[0].clips).toBe(8);
    for (const piece of big.drilled) expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
    expect(near(deflection(big.layout.lips, big.drilled[1]), 0.245, 0.02)).toBe(true);
    expect(release(big.layout.lips, big.drilled[1], big.layout.lips[0].i + 0.05)).toBeLessThan(1e-6);
    const hex = own(own(Manifold.cylinder(80, 60, 60, 6)).subtract(own(own(Manifold.cylinder(82, 56, 56, 6)).translate([0, 0, 2]))));
    const r = apartSplit(hex, [[2, 40]]);
    expect(r.layout.lips[0].clips).toBe(6);
    for (const piece of r.drilled) expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
    const b = nearCut(r.drilled[0], 2, 40, 2, 10);
    const l = nearCut(r.drilled[1], 2, 40, 2, 14);
    for (const turn of [60, 120, 180, 240, 300]) expect(near(lift(b, own(l.rotate([0, 0, turn]))), 51.5, 1)).toBe(true);
  });

  it('a ceiling just past the cut moves the tongue out: with a 4 mm wall it has no room for clips, with 5 mm it has', () => {
    const ceiling = own(own(lanternSolid()).add(own(boxAt([-46, -46, 194], [46, 46, 196]))));
    const r = apartSplit(ceiling, [[2, 190]]);
    expect(r.layout.lips[0]).toMatchObject({ H: 6, clips: 0, why: ['flex'], hasOver: true });
    expect(near(r.layout.lips[0].area, 507.9, 1)).toBe(true);
    expect(r.notes[1]).toMatchObject({ code: 'APART_NO_CLIPS', why: 'flex' });
    for (const piece of r.drilled) expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
    expect(lift(r.drilled[0], r.drilled[1])).toBeLessThan(1e-9);
    const wall5 = own(own(own(boxAt([-50, -50, 0], [50, 50, 200])).subtract(own(boxAt([-45, -45, 4], [45, 45, 194])))).subtract(own(boxAt([-45, -45, 196], [45, 45, 201]))));
    const thick = apartSplit(wall5, [[2, 190]]);
    expect(thick.layout.lips[0]).toMatchObject({ H: 6, clips: 4, hasOver: true });
    expect(release(thick.layout.lips, thick.drilled[1], thick.layout.lips[0].i + 0.05)).toBeLessThan(1e-6);
  });

  it('a box with an 8 mm lid: the lid carries the lip with 4 clips, where the box would have a 4.5 mm lip and none', () => {
    const closed = own(own(boxAt([-40, -40, 0], [40, 40, 60])).subtract(own(boxAt([-36, -36, 2], [36, 36, 58]))));
    const r = apartSplit(closed, [[2, 52]]);
    expect(r.pairs[0].quality[0]).toMatchObject({ H: 4.5, clips: 0 });
    expect(r.pairs[0].quality[1]).toMatchObject({ H: 6, clips: 4 });
    expect(r.layout.lips[0]).toMatchObject({ male: 1, dir: -1, down: '+z', H: 6, clips: 4 });
    expect(r.notes[0].text).toBe('Cut A comes apart: the top (piece 2) clicks into piece 1 on a 6 mm lip – 4 clips hold it, and it pulls off again by hand.');
    for (const piece of r.drilled) expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
    expect(release(r.layout.lips, r.drilled[0], r.layout.lips[0].i + 0.05)).toBeLessThan(1e-6);
  });

  it('a Gothic lantern: a lip with clips through its band, and under its roof a note to move the cut to where one fits', () => {
    const at158 = apartSplit(own(gothicSolid()), [[2, 158]]);
    expect(at158.layout.lips[0]).toMatchObject({ H: 6, clips: 4 });
    for (const piece of at158.drilled) expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
    expect(release(at158.layout.lips, at158.drilled[1], at158.layout.lips[0].i + 0.05)).toBeLessThan(1e-6);
    const at166 = apartSplit(own(gothicSolid()), [[2, 166]]);
    expect(at166.layout.lips).toEqual([]);
    expect(at166.notes.map((n) => n.code)).toEqual(['APART_FLAT']);
    expect(at166.notes[0]).toMatchObject({ code: 'APART_FLAT', why: 'room', suggestedAt: 160.5 });
    expect(apartSplit(own(gothicSolid()), [[2, 160.5]]).layout.lips[0]).toMatchObject({ H: 6, clips: 4 });
  });
});

describe('take-apart lips in the layout', () => {
  it('a cut that comes apart through a thin plate keeps unglued dovetail tabs, under 2 mm nothing, anywhere else a lip', () => {
    const sign = cube([300, 80, 4], [0, 0, 2]);
    const tabs = apartSplit(sign, [[0, 0]]);
    expect(tabs.plan.joints).toEqual({ c1: 'dovetail' });
    expect(tabs.plan.dove.ids).toEqual(['c1']);
    expect(tabs.notes).toEqual([]);
    expect(tabs.layout.lips).toEqual([]);
    expect(tabs.layout.seams).toHaveLength(1);
    expect(tabs.layout.seams[0]).toMatchObject({ joint: 'dovetail', apart: { hold: 'snap', lip: false, clips: 0 } });
    expect(tabs.layout.seams[0].apart.tabs).toBeGreaterThan(0);
    // the Joints are for the glued cuts only: with none, a glued cut gets nothing and the one that comes apart its tabs
    const { spec, cuts } = normaliseSplit({
      joint: 'none',
      cuts: [{ id: 'c1', position: [-50, 0, 0], normal: [1, 0, 0], joint: 'apart', hold: 'snap' }, { id: 'c2', position: [50, 0, 0], normal: [1, 0, 0] }],
    }, boxOf(sign));
    expect(planDovetails(sign, cuts, spec).joints).toEqual({ c1: 'dovetail', c2: 'none' });
    const foil = apartSplit(cube([300, 80, 1.5], [0, 0, 0.75]), [[0, 0]]);
    expect(foil.plan.joints).toEqual({ c1: 'none' });
    expect(foil.notes.map((n) => [n.code, n.why, n.wall])).toEqual([['APART_FLAT', 'thin', 2]]);
    expect(foil.layout.seams[0]).toMatchObject({ joint: 'none', apart: { lip: false } });
    // through a box it gets a lip whatever the Joints say, and is never told it isn't a plate
    const block = tray([120, 60, 60], 4);
    for (const joint of ['dovetail', 'dowels', 'none', 'pegs']) {
      const r = apartSplit(block, [[2, 30]], { joint });
      expect(r.plan.joints).toEqual({ c1: 'lip' });
      expect(r.notes.map((n) => n.code)).toEqual(['APART']);
      expect(r.layout.lips[0]).toMatchObject({ H: 6, clips: 4 });
    }
  });

  it('a piece a lip stands out of lies with it standing up, and the teardrops of the other cuts on it follow', () => {
    const { Manifold } = wasm;
    const thick = own(own(own(Manifold.cube([160, 80, 60])).translate([-80, -40, 0])).subtract(own(own(Manifold.cube([136, 56, 60])).translate([-68, -28, 10]))));
    const glued = apartSplit(thick, [[0, 0, false], [2, 45, false]], { orient: 'cut' });
    const r = apartSplit(thick, [[0, 0, false], [2, 45]], { orient: 'cut' });
    // laid on a cut face, the two lower pieces would lie upside down, their X face's holes pointing down
    expect(r.pieces.filter((p) => p.cell[2] === 0).map((p) => p.up)).toEqual(['-z', '-z']);
    expect(r.layout.lips.map((l) => l.down)).toEqual(['-z', '-z']);
    const lowerSides = (layout) => layout.dowels.filter((d) => d.axis === 0 && d.centre[2] < 45).flatMap((d) => d.sides);
    expect(lowerSides(glued.layout).length).toBeGreaterThan(0);
    for (const s of lowerSides(glued.layout)) expect(s.apex).toEqual([0, 0, -1]);
    expect(lowerSides(r.layout).length).toBeGreaterThan(0);
    for (const s of lowerSides(r.layout)) expect(s).toMatchObject({ tear: true, apex: [0, 0, 1] });
    expect(r.pieces.map((p) => p.up)).toEqual(glued.pieces.map((p) => p.up)); // the caller's pieces are left alone
  });

  it('the other cuts\' pins, pegs and labels keep clear of the lips, and built-in pegs know which pieces a lip holds', () => {
    const { Manifold } = wasm;
    const thick = own(own(own(Manifold.cube([160, 80, 60])).translate([-80, -40, 0])).subtract(own(own(Manifold.cube([136, 56, 60])).translate([-68, -28, 10]))));
    const seen = [];
    const r = apartSplit(thick, [[0, 0, false], [2, 45]], { labels: true, progress: (stage) => seen.push(stage) });
    expect(seen).toContain('Fitting the lip…');
    expect(r.layout.lips).toHaveLength(2);
    const lips = r.layout.lips.flatMap((l) => [{ m: own(lipAt(l)), side: l.male }, { m: own(lipCavityAt(l)), side: 1 - l.male }]);
    expect(r.layout.dowels.length).toBeGreaterThan(0);
    for (const d of r.layout.dowels) {
      const { wall } = sizesFor(d.d);
      for (const side of [0, 1]) {
        const hole = own(dowelHole(d, side));
        for (const l of lips) expect(hole.minGap(l.m, wall + 1)).toBeGreaterThanOrEqual(wall - 1e-3);
      }
    }
    // the lip's face has no label and is never said to lack one
    expect(r.layout.labels.every((x) => x.letter === 'A')).toBe(true);
    expect(r.notes.filter((n) => n.code === 'LABELS_SKIPPED').every((n) => !n.letters.includes('B'))).toBe(true);
    expect(r.layout.seams.filter((x) => x.letter === 'B').every((x) => x.labels === null && x.joint === 'lip')).toBe(true);
    for (const piece of r.drilled) expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
    const pegged = apartSplit(thick, [[0, 0, false], [2, 45]], { joint: 'pegs' });
    expect(pegged.forcedSeen).toHaveLength(1);
    expect([...pegged.forcedSeen[0]].sort()).toEqual([[1, '-z'], [2, '-z']]);
    expect(pegged.layout.pegs.length).toBeGreaterThan(0);
    const lipsHere = pegged.layout.lips.flatMap((l) => [own(lipAt(l)), own(lipCavityAt(l))]);
    for (const g of pegged.layout.pegs) {
      for (const m of [own(pegAt(g)), own(socketAt(g))]) for (const l of lipsHere) expect(lift(m, l)).toBeLessThan(1e-6);
    }
  });

  it('a lip neither piece can lie under on the printer, standing up, is left out, and the note says why', () => {
    // a tube cut in two halves 100 mm tall, on a printer 103 mm tall: each fits, but not with a 6 mm lip standing up
    const r = apartSplit(tray([60, 60, 200], 4), [[2, 100]], { bed: [200, 200, 103] });
    expect(r.pairs[0].quality.every(Boolean)).toBe(true);
    expect(r.layout.lips).toEqual([]);
    expect(r.notes.map((n) => [n.code, n.why])).toEqual([['APART_FLAT', 'lying']]);
    expect(r.notes[0].text).toBe('Cut A has no lip: neither piece fits your printer lying with the lip standing up out of it, so the pieces just rest on each other.');
    expect(r.layout.seams[0]).toMatchObject({ joint: 'none', male: null, apart: { lip: false, flat: 1 } });
  });

  it('two cuts that come apart across each other: the later one\'s lips keep clear of the earlier one\'s, and no two pieces meet', () => {
    // a closed box 200 × 100 × 80 cut across X and Z, both coming apart: the four pieces fit together with nothing of
    // two of them in one place (the two cuts' tongues stood in one corner before)
    const closed = own(own(boxAt([-100, -50, 0], [100, 50, 80])).subtract(own(boxAt([-96, -46, 4], [96, 46, 76]))));
    const r = apartSplit(closed, [[2, 60], [0, 0]]);
    expect(r.layout.lips.map((l) => l.letter).sort()).toEqual(['A', 'B', 'B']);
    for (let i = 0; i < r.drilled.length; i++) {
      expect(shells(r.drilled[i])).toHaveLength(1);
      for (let j = i + 1; j < r.drilled.length; j++) expect(lift(r.drilled[i], r.drilled[j])).toBeLessThan(1e-6);
    }
    // the face of the Z cut whose two pieces already lie on their sides for the X cut's lips says so
    expect(r.notes.map((n) => n.text)).toEqual([
      'Cut B comes apart: pieces 2 and 4 click onto a 6 mm lip on pieces 1 and 3 – 4 clips hold them, and they pull off again by hand.',
      'Cut A comes apart: the top (piece 4) clicks onto a 6 mm lip on piece 2 – 3 clips hold it, and it pulls off again by hand. On 1 other face neither piece can lie with a lip standing up, so the pieces there just rest on each other.',
    ]);
  });

  it('two cuts that come apart 6 mm apart: a groove never reaches past the next cut, so no lip is left loose', () => {
    const closed = own(own(boxAt([-50, -50, 0], [50, 50, 160])).subtract(own(boxAt([-46, -46, 4], [46, 46, 156]))));
    // the piece between them lies on its top for the first cut's lip, so the second has none, and says why
    const r = apartSplit(closed, [[2, 60], [2, 66]]);
    expect(r.layout.lips).toHaveLength(1);
    expect(r.layout.lips[0]).toMatchObject({ letter: 'A', male: 1, H: 6, clips: 4 });
    for (const piece of r.drilled) expect(shells(piece)).toHaveLength(1);
    expect(r.notes[1]).toMatchObject({ code: 'APART_FLAT', why: 'lying', by: ['A'], fixed: 2 });
    expect(r.notes[1].text).toBe('Cut B has no lip: piece 2 already lies another way for cut A\'s lip, and the other piece can\'t carry one, so the pieces just rest on each other.');
    // 8 mm apart the second cut's groove has room for a 3 mm lip in the piece between, its roof clear of the first's tongue
    const eight = apartSplit(closed, [[2, 60], [2, 68]]);
    expect(eight.layout.lips.map((l) => [l.letter, l.male, l.H])).toEqual([['A', 1, 6], ['B', 1, 3]]);
    for (const piece of eight.drilled) expect(shells(piece)).toHaveLength(1);
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(lift(eight.drilled[i], eight.drilled[j])).toBeLessThan(1e-6);
  });

  it('lays out lips, drills the pieces and builds the fit test without leaving a solid behind', () => {
    // a ceiling over the opening, so the groove's piece holds material over it too
    const lantern = own(own(lanternSolid()).add(own(boxAt([-46, -46, 194], [46, 46, 196]))));
    const run = () => {
      apartSplit(lantern, [[0, 0, false], [2, 190]], { labels: true });
      own(fitTestCoupon({ clearance: 0.15 }, 0.4, { apart: 'snap' }));
    };
    run();
    clearSplitCaches();
    // every Manifold and CrossSection made from here on, as `trackSolids` in split.test.js sees them
    const tracked = new Set();
    const restore = [];
    const remember = (v) => {
      if (Array.isArray(v)) v.forEach(remember);
      else if (v instanceof wasm.Manifold || v instanceof wasm.CrossSection) tracked.add(v);
      return v;
    };
    for (const Class of [wasm.Manifold, wasm.CrossSection]) {
      for (const target of new Set([Class, Class.prototype, Object.getPrototypeOf(Class.prototype)])) {
        for (const key of Object.getOwnPropertyNames(target)) {
          const d = Object.getOwnPropertyDescriptor(target, key);
          if (typeof d.value !== 'function' || !d.writable || /^(constructor|delete|deleteLater|isDeleted|isAliasOf)$/.test(key)) continue;
          const fn = d.value;
          target[key] = function remembered(...args) {
            return remember(fn.apply(this, args));
          };
          restore.push(() => {
            target[key] = fn;
          });
        }
      }
    }
    try {
      const kept = made.length;
      run();
      for (const m of made.splice(kept)) m.delete();
      clearSplitCaches();
      expect(tracked.size).toBeGreaterThan(500);
      expect([...tracked].filter((m) => !m.isDeleted())).toHaveLength(0);
    } finally {
      restore.forEach((r) => r());
    }
  });

  it('obstacles on the groove\'s side: the air past the face, and the groove\'s own piece over the openings', () => {
    const lantern = own(own(lanternSolid()).add(own(boxAt([-46, -46, 194], [46, 46, 196]))));
    const cut = { axis: 2, at: 190 };
    const band = own(bandFor(lantern, cut, 10.5));
    const island = own(own(band.slice(190)).simplify(0.02));
    // the ceiling 4 mm up is over the opening within 9.35 mm above the cut, not within 3 mm, and never below it
    expect(own(overFor(band, cut, 1, 9.35, island)).area()).toBeCloseTo(91.9 * 91.9, 0);
    expect(overFor(band, cut, 1, 3, island)).toBeNull();
    expect(overFor(band, cut, 0, 9.35, island)).toBeNull();
    const shadow = own(shadowFor(band, cut, { below: 0.5, above: 9.35 }));
    const block = own(shadow.intersect(own(island.offset(-0.05, 'Miter', 4))));
    const { plan, tries } = lipFor(island, { obstaclesAt: () => ({ block: block.isEmpty() ? null : block, over: own(overFor(band, cut, 1, 9.55, island)) }) });
    expect(tries.map((x) => [x.H, x.clips, x.over])).toEqual([[6, true, true], [6, false, true]]);
    expect(plan).toMatchObject({ H: 6, hasOver: true, why: ['flex'] });
  });
});

describe('take-apart lips over a sweep of outlines', () => {
  /** The outlines the lip was swept over: rings 2.7–6 mm, polygons of 5–128 sides, rectangles, an L tube and solids. */
  function sweepModels() {
    const { Manifold } = wasm;
    const poly = (n, r, w, h) => own(own(own(Manifold.cylinder(h, r, r, n)).subtract(own(own(Manifold.cylinder(h + 2, r - w, r - w, n)).translate([0, 0, 2])))).rotate([0, 0, 7]));
    const list = [];
    for (let k = 0; k <= 33; k++) list.push(tray([100, 100, 60], +(2.7 + k / 10).toFixed(2)));
    for (const n of [5, 6, 7, 8, 12, 24, 48, 64, 96, 128]) for (const w of [3, 4, 5]) list.push(poly(n, 60, w, 60));
    for (const [a, b] of [[80, 40], [120, 60], [70, 70], [160, 80], [45, 200]]) list.push(tray([a, b, 60], 3.5));
    const L = own(own(own(own(boxAt([-50, -50, 0], [50, 50, 60])).subtract(own(boxAt([0, 0, -1], [60, 60, 70])))).subtract(own(boxAt([-46, -46, 2], [-4, 46, 61])))).subtract(own(boxAt([-46, -46, 2], [46, -4, 61]))));
    list.push(L, own(boxAt([-15, -15, 0], [15, 15, 60])), own(Manifold.cylinder(60, 12.5, 12.5, 48)), own(boxAt([-40, -10, 0], [40, 10, 60])));
    return list;
  }

  it('every lip built over 73 outlines, at clearances 0.1, 0.15 and 0.2 in turn, is clean, seated and keeps its clearance', () => {
    const models = sweepModels();
    expect(models).toHaveLength(73);
    let built = 0;
    models.forEach((m, k) => {
      const c = [0.1, 0.15, 0.2][k % 3];
      const r = apartSplit(m, [[2, 30]], { clearance: c });
      // walls under the least a lip needs (2.7 mm, and more with more clearance; a hexagon's 3 mm across its corners)
      // take none, and say so
      if (!r.layout.lips.length) {
        expect(r.notes.map((n) => [n.code, n.why])).toEqual([['APART_FLAT', 'thin']]);
        return;
      }
      built++;
      const [body, lid] = r.drilled;
      for (const piece of [body, lid]) {
        expect(piece.status()).toBe('NoError');
        expect(positiveShells(piece)).toBe(1);
        expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
      }
      expect(lift(body, lid)).toBeLessThan(1e-6);
      expect(lipParts(r.layout.lips[0]).tongue.minGap(lid, 1)).toBeGreaterThanOrEqual(c - 0.005);
    });
    expect(built).toBeGreaterThanOrEqual(70);
  });
});

describe('take-apart lips on dense faces', () => {
  it('a dense face is eased before its lip is planned: a 4096-sided wobbly tube plans in under a second and builds clean', () => {
    const { Manifold, CrossSection } = wasm;
    const n = 4096;
    const ring = (r) => Array.from({ length: n }, (_, k) => {
      const t = (2 * Math.PI * k) / n;
      const q = r + 0.3 * Math.sin(37 * t) + 0.2 * Math.sin(91 * t);
      return [q * Math.cos(t), q * Math.sin(t)];
    });
    const tube = own(Manifold.extrude(own(new CrossSection([ring(60), ring(56).reverse()], 'Positive')), 60));
    // a straight tube has nothing in the way of its lip: the plan alone is timed
    const face = own(own(tube.slice(30)).simplify(0.02));
    const t0 = performance.now();
    const { plan } = lipFor(face);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(plan).toMatchObject({ kind: 'opening', H: 6 });
    const s = lipSolids(plan);
    [s.tongue, s.cutters, ...s.catches, ...s.recesses].forEach(own);
    const body = own(own(own(tube.trimByPlane([0, 0, -1], -30)).translate([0, 0, -30])).add(s.tongue));
    const lid = own(own(own(tube.trimByPlane([0, 0, 1], 30)).translate([0, 0, -30])).subtract(s.cutters));
    for (const piece of [body, lid]) expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
    expect(lift(body, lid)).toBeLessThan(1e-6);
    // the layout eases every lip's face the same way: a 512-sided tube's tongue keeps under 300 corners, not 1,015
    const round = own(own(Manifold.cylinder(60, 60, 60, 512)).subtract(own(own(Manifold.cylinder(62, 56, 56, 512)).translate([0, 0, -1]))));
    const r = apartSplit(round, [[2, 30]]);
    expect(r.layout.lips).toHaveLength(1);
    for (const outline of r.layout.lips[0].T) expect(outline.length).toBeLessThan(300);
    for (const piece of r.drilled) expect(stlCheck(piece)).toEqual({ degenerate: 0, open: 0 });
  });
});
