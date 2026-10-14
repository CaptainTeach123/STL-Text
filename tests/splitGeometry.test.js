import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { manifold } from '../src/manifold.js';
import { FILAMENT, PIN_DIAMETERS, TO_PLANE, chooseOrientation, isSymmetric, normaliseSplit, sizesFor } from '../src/split.js';
import {
  buildSplitDisplay,
  cutPieces,
  dovetailCells,
  dovetailTabs,
  dowelHole,
  drillPiece,
  fitTestCoupon,
  halfHole,
  labelSolid,
  layoutSplit,
  pinAt,
  pinSheet,
  pinSolid,
  pinSpares,
  pinsPerSheet,
  planDovetails,
} from '../src/splitGeometry.js';
import { inter, setup } from './helpers.js';

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
  const pieces = cut.pieces.map((p) => ({ ...p, up: chooseOrientation(p.stats, BED, spec.orient, { pieceIndex: p.index }).up }));
  const layout = layoutSplit(solid, cuts, pieces, spec, { joints: plan.joints, tabs: plan.tabs, font });
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
