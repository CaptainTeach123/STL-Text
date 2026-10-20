import { describe, expect, it } from 'vitest';
import {
  MATERIALS, PLUG, STEEP, TEA_LIGHT, arcBeam, camOut, click, collarFor, collarReach, collarSlope, ddOf, domeRoom, gminOf, layout, leastScale,
  lugHold, offerPercent, plugAt, plugDims, plugFor, plugHold, plugLayoutOk, rAt, ringCompliance, roundAngle, roundForce, roundLift, roundOpening,
  roundZ, scalePercent, sizes, skinAt, slideWords, takesTeaLight, twistFor, wayWords,
} from '../src/locks.js';

const two = (v) => +v.toFixed(2);
const psis = (L) => L.tabs.map((t) => two(t.psi));
/** Whether angle a (degrees) lies in the arc [a0, a1], however many turns either is off. */
const inArc = (a, [a0, a1]) => ((((a - a0) % 360) + 360) % 360) <= a1 - a0 + 1e-9;

/**
 * A dome's outside as the lock sees it: a cone 30° from horizontal through r 7.1·s at the joint face, up to 6·s over
 * it. The user's lantern's dome is 7.1–7.2 mm out at its face at 100 % and slopes 27–28° from horizontal.
 */
const cone = (s) => {
  const out = [];
  for (let k = 0; k <= 60; k++) {
    const z = (k / 10) * s;
    if (7.1 * s - z * Math.sqrt(3) > 0) out.push([7.1 * s - z * Math.sqrt(3), +z.toFixed(4)]);
  }
  return out;
};

describe('the twist-lock\'s sizes', () => {
  it('every size follows the printer as the table has it: whole layers, a layer more under ceilings, wide slits', () => {
    const rows = ['cz', 'ledge', 'zl', 'a', 't', 'H', 'td', 'Ld', 'g', 'b', 'gTop', 'sockTop', 'armTop', 'armFloor', 'slitTop', 'Hc', 'skin', 'dd', 'gmin'];
    const table = [
      // n, hl, c: cz ledge zl a t H td Ld g b gTop sockTop armTop armFloor slitTop Hc skin dd gmin
      [[0.4, 0.2, 0.15], [0.2, 0.8, 1, 1, 1.6, 2.4, 1.2, 9, 0.8, 1.2, 0.8, 2.8, 2.4, 0.8, 2, 1.2, 0.8, 0.3, 0.9]],
      [[0.4, 0.2, 0.3], [0.4, 0.8, 1.2, 1, 1.6, 2.6, 1.2, 9, 0.8, 1.2, 0.8, 3.2, 2.8, 0.8, 2, 1.2, 0.8, 0.15, 1.2]],
      [[0.4, 0.2, 0.4], [0.4, 0.8, 1.2, 1, 1.6, 2.6, 1.2, 9, 1, 1.2, 0.8, 3.2, 2.8, 0.8, 2, 1.2, 0.8, 0.15, 1.4]],
      [[0.25, 0.12, 0.15], [0.24, 0.8, 1.04, 1.08, 1.6, 2.36, 1.2, 9, 0.8, 1.2, 0.8, 2.72, 2.48, 0.8, 2, 1.2, 0.5, 0.3, 0.9]],
      // a wide nozzle's tab is three of its lines thick, and so longer, to bend no further
      [[0.6, 0.3, 0.15], [0.3, 1.2, 1.5, 1.5, 2.4, 3.6, 1.8, 11, 1.2, 1.2, 1.2, 4.2, 3.6, 1.2, 2.4, 1.2, 1.2, 0.3, 0.9]],
    ];
    for (const [[n, hl, c], values] of table) {
      const S = sizes(n, hl, c);
      expect([n, hl, c, rows.map((k) => S[k])]).toEqual([n, hl, c, values]);
      // what the printer does not change: the lugs, the lead-ins and the mouths
      expect(S).toMatchObject({ n, hl, c, e: 0.5, N: 3, w: 5, wKey: 6.5, fb: 0.3, lead: 0.3, mouth: 0.4, slitMouth: 0.3 });
    }
    expect(sizes()).toEqual(sizes(0.4, 0.2, 0.15));
  });

  it('the click\'s ridge is drawn less proud as the clearance grows, and the free gap a lid\'s rim needs grows with it', () => {
    expect([0.15, 0.2, 0.25, 0.3, 0.4, 0.5].map(ddOf)).toEqual([0.3, 0.25, 0.2, 0.15, 0.15, 0.15]);
    expect([0.05, 0.1].map(ddOf)).toEqual([0.3, 0.3]);
    expect([0.15, 0.3, 0.4].map(gminOf)).toEqual([0.9, 1.2, 1.4]);
  });
});

describe('the collar twist-lock\'s layout', () => {
  it('lays out the lantern\'s lid at 300 % and 400 % and the print study\'s, as the solids are built', () => {
    const S = sizes();
    expect(twistFor(S, 14.62)).toBe(29);
    const at300 = layout(S, 14.62);
    expect([at300.ok, at300.theta, psis(at300)]).toEqual([true, 29, [23.41, 140.47, 260.47]]);
    const at400 = layout(S, 22.4);
    expect([at400.ok, at400.theta, psis(at400)]).toEqual([true, 19, [15.3, 47.32, 133.38, 165.4, 253.38, 285.4]]);
    const print = layout(S, 21.39);
    expect([print.ok, print.theta, psis(print)]).toEqual([true, 20, [16.02, 49.54, 134.01, 167.53, 254.01, 287.53]]);
    // the lugs: the key first, wider, the slots' arms running back θ from each to its entry
    expect(at400.lugs.map((l) => [l.phi, l.w])).toEqual([[0, 6.5], [120, 5], [240, 5]]);
    expect(at400.arms[1][0]).toBeCloseTo(120 - 19 - (2.5 / 22.4 + 0.15 / 22.4) * (180 / Math.PI), 9);
  });

  it('a neck too small for a click tab in every gap is refused, not laid out with gaps that would loosen the socket', () => {
    const S = sizes();
    const small = layout(S, 6.54);
    expect(small.ok).toBe(false);
    expect(small.theta).toBe(64);
    // at c 0.4 the lantern's 300 % neck fits no tab, and one a little wider fits one only
    expect(layout(sizes(0.4, 0.2, 0.4), 13.73).tabs).toHaveLength(0);
    const one = layout(sizes(0.4, 0.2, 0.4), 13.95);
    expect([one.ok, one.tabs.length]).toEqual([false, 1]);
  });

  it('never puts a tab inside a slot\'s arm, nor a ridge where it would run into a lug while the lid turns', () => {
    // a tab at a fixed angle once fell inside an arm's arc and cut the lid's socket ring into four pieces
    let laid = 0;
    const wrong = [];
    for (const c of [0.1, 0.15, 0.3, 0.4]) {
      for (const n of [0.4, 0.6]) {
        const S = sizes(n, 0.2, c);
        const base = S.fb + 2 * (S.dd + c + 0.2);
        for (let k = 600; k <= 4500; k += 7) {
          const r0 = k / 100;
          const L = layout(S, r0);
          if (!L.ok) continue;
          laid++;
          const d = (mm, r = r0 + c) => (mm / r) * (180 / Math.PI);
          for (const { psi } of L.tabs) {
            // the tab from its end slit to its root, and the ridge's path from locked (ψ) to open (ψ + θ)
            const freeEnd = psi - d(base / 2 + 0.1);
            for (let a = freeEnd - d(S.g); a <= freeEnd + d(S.Ld); a += 0.25) {
              if (L.arms.some((arm) => inArc(a, arm))) wrong.push({ c, n, r0, psi, a, in: 'arm' });
            }
            for (let a = psi - d(base / 2, r0); a <= psi + L.theta + d(base / 2, r0); a += 0.25) {
              if (L.lugs.some((lug) => inArc(a, [lug.phi - lug.half, lug.phi + lug.half]))) wrong.push({ c, n, r0, psi, a, in: 'lug' });
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(laid).toBeGreaterThan(1500);
  });

  it('a ridge never passes another tab\'s groove while the lid turns, so it clicks only open and locked – even on a neck so wide the twist is 2°', () => {
    const wrong = [];
    let laid = 0;
    for (const c of [0.1, 0.15, 0.3, 0.4]) {
      const S = sizes(0.4, 0.2, c);
      for (let k = 600; k <= 100000; k += 97) {
        const L = layout(S, k / 100);
        if (!L.ok) continue;
        laid++;
        // the grooves are at each tab's locked and open angles; a ridge sweeps between its own two
        const grooves = L.tabs.flatMap((t) => [t.psi, t.psi + L.theta]);
        for (const t of L.tabs) {
          if (grooves.some((g) => inArc(g, [t.psi + 1e-6, t.psi + L.theta - 1e-6]))) wrong.push({ c, r0: k / 100, psi: t.psi });
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(laid).toBeGreaterThan(3000);
    // past 330 mm the twist is 2°, and a second tab in a gap would run over the first one's grooves: one tab a gap
    expect(layout(sizes(), 331)).toMatchObject({ theta: 2, ok: true, tabs: [{ k: 0 }, { k: 1 }, { k: 2 }] });
  });
});

describe('how wide a neck a lid has room for', () => {
  it('reads the outside profile: its radius at a height, and the skin to it square to a sloping wall', () => {
    const outer = [[10, 0], [8, 2], [8, 4]];
    expect([rAt(outer, -1), rAt(outer, 0), rAt(outer, 1), rAt(outer, 3), rAt(outer, 9)]).toEqual([10, 10, 9, 8, 8]);
    // 45° wall: the point (8, 0) is √2 from it, square to it; past the outside the skin is negative
    expect(skinAt(outer, 8, 0)).toBeCloseTo(Math.SQRT2, 9);
    expect(skinAt(outer, 7, 3)).toBeCloseTo(1, 9);
    expect(skinAt(outer, 9, 3)).toBeCloseTo(-1, 9);
  });

  it('on a dome like the lantern\'s: no lock at 100 % or 200 %, a twist-lock with 3 clicks at 300 % and 6 at 400 %', () => {
    const S = sizes();
    expect(domeRoom(cone(1), S)).toBeNull();
    expect(collarFor(cone(1), S)).toEqual({ r0: null, why: 'room' });
    // at 200 % a neck fits under the skin, but no gap between its slots has room for a click tab
    const at200 = collarFor(cone(2), S);
    expect([at200.r0, at200.why]).toEqual([6.98, 'tabs']);
    // at 150 % a neck would fit, but its bore would be under 2 mm across
    expect(collarFor(cone(1.5), S)).toEqual({ r0: 3.43, why: 'room' });
    const at300 = collarFor(cone(3), S);
    expect(at300).toMatchObject({ r0: 14.08, rn: 12.48, rs: 14.23, rf: 14.88, opening: 24.96, theta: 30, tabs: 3, tabR: 14.83 });
    expect(psis(at300.layout)).toEqual([24.3, 141.25, 261.25]);
    expect(collarFor(cone(4), S)).toMatchObject({ r0: 21.18, opening: 39.16, theta: 20, tabs: 6 });
    // the neck is the largest in whole hundredths that keeps 2n of skin over the cutters' top outer corners
    const keeps = (r0) => [[r0 + S.c, S.sockTop], [r0 + 2 * S.c + S.e, S.armTop], [r0 + S.c + S.td + S.g, S.slitTop]].every(([r, z]) => skinAt(cone(3), r, z) >= S.skin);
    expect([keeps(14.08), keeps(14.09)]).toEqual([true, false]);
  });

  it('holds a lid whose outside steps in under the cutters\' top corners to its wall there, the mouths at the bed too: a round wall under its eave', () => {
    const S = sizes();
    // a tube r 45 up to 1.45 mm over the face, then an eave r 50: the top corners all stand in the eave
    const outer = Array.from({ length: 49 }, (_, k) => [k / 10 < 1.45 ? 45 : 50, k / 10]);
    // the slits' outer face (r0 + c + td + g), 0.3 wider still at its mouth on the bed, keeps 2n from the tube's wall
    expect(domeRoom(outer, S)).toBe(41.75);
    expect(45 - (41.75 + S.c + S.td + S.g + S.slitMouth)).toBeCloseTo(S.skin, 9);
    // the top corners alone would take a neck 0.57 wider, its slits 0.53 from the outside beside the tube
    const corners = (r0) => [[r0 + S.c, S.sockTop], [r0 + 2 * S.c + S.e, S.armTop], [r0 + S.c + S.td + S.g, S.slitTop]].every(([r, z]) => skinAt(outer, r, z) >= S.skin);
    expect([corners(42.32), corners(42.33)]).toEqual([true, false]);
    // a plain tube: the slits' mouths decide, 0.3 in from where their faces alone would
    const tube = Array.from({ length: 49 }, (_, k) => [45, k / 10]);
    expect(domeRoom(tube, S)).toBe(41.75);
  });

  it('a larger clearance or nozzle leaves a narrower neck: at c 0.4 the dome at 300 % fits one click tab, so no lock', () => {
    expect(collarFor(cone(4), sizes(0.4, 0.2, 0.3))).toMatchObject({ r0: 20.85, opening: 38.5, theta: 21, tabs: 6 });
    expect(collarFor(cone(3), sizes(0.4, 0.2, 0.4))).toMatchObject({ r0: 13.55, why: 'tabs' });
    expect(collarFor(cone(4), sizes(0.6, 0.3, 0.15))).toMatchObject({ r0: 18.57, opening: 32.34, theta: 23, tabs: 3 });
    expect(collarFor(cone(3), sizes(0.25, 0.12, 0.15))).toMatchObject({ r0: 14.68, opening: 26.16, theta: 29, tabs: 3 });
  });
});

describe('the collar under the joint', () => {
  // a wall under the face: its outside r and its inside rin every 0.25 mm down, as the engine reads it
  const wall = (out, inside, depth) => {
    const rows = [];
    for (let d = 0; d <= depth + 1e-9; d += 0.25) rows.push([out(d), -d, inside(d)]);
    return rows;
  };
  const S = sizes();

  it('slopes out as far as the model\'s own outside does over twice its depth, never past 59.8° nor under 45°', () => {
    expect(S.Hc).toBe(1.2);
    expect(STEEP).toBe(1.72);
    // the user's dome reads 1.62–1.64 r per mm under the face: the collar slopes as it does (58.4°)
    expect(collarSlope(wall((d) => 22.229 + 1.625 * d, (d) => 19 + 1.6 * d, 3), S)).toBeCloseTo(1.625, 9);
    // the fixture's 30° cone is flatter than 59.8°: no further
    expect(collarSlope(wall((d) => 23.13 + 1.745 * d, (d) => 18.49 + 1.527 * d, 3), S)).toBe(STEEP);
    // a vertical wall (the round lantern under its eave), or one that leans in: 45°
    expect(collarSlope(wall(() => 44.98, () => 42, 3), S)).toBe(1);
    expect(collarSlope(wall((d) => 30 - d, () => 20, 3), S)).toBe(1);
    // read twice the collar's depth down between rows: 2.4 mm lies between the rows at 2.25 and 2.5
    const kinked = wall((d) => (d <= 2.25 ? 20 + 1.5 * d : 23.375 + 0.5 * (d - 2.25)), () => 15, 3);
    expect(collarSlope(kinked, S)).toBeCloseTo((23.375 + 0.5 * 0.15 - 20) / 2.4, 9);
    // a wall that ends before twice the collar's depth carries no collar
    expect(collarSlope(wall((d) => 20 + d, () => 15, 2.25), S)).toBeNull();
    expect(collarSlope([], S)).toBeNull();
  });

  it('reaches down to where it lands on the wall\'s inside, or runs on under the wall\'s end until it meets it there', () => {
    // the round lantern under its eave: from the bore 42.41 out at 45°, onto the wall's inside at 42 at once
    const eave = wall(() => 44.98, () => 42, 20);
    expect(collarReach(eave, 42.41, S, 1)).toEqual({ depth: 1.25, hang: 0, r: null });
    // the fixture at 400 %: lands on the band's inside (36.4) 9.75 mm down
    const band = (d) => (d < 4.75 ? 24.75 + 1.527 * d : 36.4);
    expect(collarReach(wall((d) => 41.78, band, 10.75), 22.11, S, 1.72)).toEqual({ depth: 9.75, hang: 0, r: null });
    // at 300 % the band ends 8.25 mm down, the collar's underside 0.894 mm short of its inside: rather than stop there
    // in a flat shelf over air, it runs on under the band's end, its outside straight down from the band's inside,
    // until its underside meets that, 0.894 / 1.72 further down
    const short = collarReach(wall(() => 31.33, (d) => (d < 4 ? 18.49 + 1.527 * d : 27.3), 8.25), 14.28, S, 1.72);
    const gap = 27.3 - (14.28 + 1.72 * 7.05);
    expect(gap).toBeCloseTo(0.894, 9);
    expect(short.r).toBe(27.3);
    expect(short.hang).toBeCloseTo(gap / 1.72, 6);
    expect(short.depth).toBeCloseTo(8.25 + gap / 1.72, 6);
    // a wall solid over the axis carries it straight away, at the collar's own depth; none under it, nothing
    expect(collarReach(wall(() => 30, () => 0, 3), 20, S, 1.72)).toEqual({ depth: 1.25, hang: 0, r: null });
    expect(collarReach(wall(() => 30, () => 25, 1), 20, S, 1.72)).toBeNull();
    // a square tube 40 mm across and 2 mm thick: its inside's corner (25.46) lies past its outside's nearest point (20),
    // so the collar ends where it meets the outside inset by the skin, 19.2 mm out
    const square = wall(() => 20, () => 18 * Math.SQRT2, 8);
    expect(collarReach(square, 15.45, S, 1)).toEqual({ depth: 5, hang: 0, r: null });
    // and ended by a wall that stops short of both: it runs on from the nearer, the outside inset
    const stops = collarReach(wall(() => 20, () => 18 * Math.SQRT2, 3), 15.45, S, 1);
    expect(stops.r).toBe(19.2);
    expect(stops.hang).toBeCloseTo(19.2 - 17.25, 6);
    expect(stops.depth).toBeCloseTo(3 + 19.2 - 17.25, 6);
  });
});

describe('the plug twist-lock', () => {
  // a base ring 9.32·s out, solid 6.5·s up, its bore at most 8.6·s across: the lantern's base
  const base = (s) => ({ Rwindow: 8.6 * s, solidTop: 6.5 * s, ringOutAt: () => 9.32 * s });

  it('sizes the lantern\'s base by one rule at every scale: none at 200 %, R 21.3 at 300 % and 28.7 at 400 %', () => {
    const S = sizes();
    expect(plugFor(S, base(1))).toBeNull();
    expect(plugFor(S, base(2))).toBeNull();
    expect(plugFor(S, base(3))).toMatchObject({ R: 21.3, opening: 42.6, theta: 23, wall: 5.71, camOutN: 1881, zl: 2.8, rp: 21.15, coin: 36.3, tabs: 3, tabR: 20.55 });
    expect(plugFor(S, base(4))).toMatchObject({ R: 28.7, opening: 57.4, theta: 17, wall: 7.63, camOutN: 1873, coin: 51.1 });
    // whenever a plug is accepted, its ring takes three times the plug's 605 N before its lugs could spread it
    let accepted = 0;
    for (let k = 100; k <= 600; k += 5) {
      for (const [n, hl, c] of [[0.4, 0.2, 0.15], [0.4, 0.2, 0.3], [0.6, 0.3, 0.4], [0.25, 0.12, 0.15]]) {
        const p = plugFor(sizes(n, hl, c), base(k / 100));
        if (!p) continue;
        accepted++;
        expect(p.camOutN).toBeGreaterThanOrEqual(1815);
        expect(p.wall).toBeGreaterThanOrEqual(2 * n + 1 - 1e-9);
      }
    }
    expect(accepted).toBeGreaterThan(300);
  });

  it('each rule turns a plug away: a ring its lugs could spread, no room for its tabs, a bottom too thin for the lock', () => {
    const S = sizes();
    const d = plugDims(S, 21.3);
    expect(d).toMatchObject({ e: 0.8, a: 1, w: 6, zl: 2.8, rise: 1.25, top: 5.262132, rp: 21.15, coin: 36.3 });
    // a ring 2.75 mm thick behind the slots keeps more than two lines and a millimetre, but its lugs could spread it
    // at 277 N: the bore narrows until the ring is thick enough
    expect(Math.round(camOut(S, 21.3, d, 25))).toBe(277);
    expect(camOut(S, 21.3, d, 22.25)).toBe(0);
    expect(Math.round(camOut(S, 21.3, d, 27.96))).toBe(1881);
    expect(plugFor(S, { Rwindow: 21.3, solidTop: 20, ringOutAt: () => 25 })).toMatchObject({ R: 19, camOutN: 1830, wall: 5.05 });
    // round a 27.8 mm bore no click tab fits, whatever the ring, and round a 28.8 mm one only
    expect(plugLayoutOk(S, 13.9)).toMatchObject({ ok: false, theta: 35 });
    expect(plugLayoutOk(S, 13.9).tabs).toHaveLength(0);
    expect(plugLayoutOk(S, 14.4).tabs).toHaveLength(1);
    expect(plugFor(S, { Rwindow: 14.4, solidTop: 20, ringOutAt: () => 40 })).toBeNull();
    // three times the plug's hold is 1815 N: a ring spread at 1814.8 N is not enough
    const s = 2.65;
    expect(Math.round(camOut(S, 18.1, plugDims(S, 18.1), 9 * s) * 10) / 10).toBe(1814.8);
    expect(plugFor(S, { Rwindow: 8.6 * s, solidTop: 6.5 * s, ringOutAt: () => 9 * s })).toMatchObject({ R: 18, camOutN: 1934 });
    // a 2 mm nozzle's ring keeps two of its lines and a millimetre behind the slots: 4.9 mm is too thin, though it
    // would hold (and its tabs, six of its lines thick, are then too long to go round the bore)
    const wide = { solidTop: 30, ringOutAt: () => 25 };
    expect(plugAt(sizes(2, 0.3, 0.3), 19, wide)).toEqual({ R: 19, why: 'wall' });
    expect(plugAt(sizes(2, 0.3, 0.3), 18.9, wide)).toEqual({ R: 18.9, why: 'tabs' });
    // the lock stands 5.26 mm over the bed: a bottom solid less than a millimetre over that takes none
    expect(plugFor(S, { Rwindow: 30, solidTop: 6.26, ringOutAt: () => 60 })).toBeNull();
    expect(plugFor(S, { Rwindow: 30, solidTop: 6.27, ringOutAt: () => 60 })).not.toBeNull();
  });

  it('judges a base\'s own circle by the same rule, and says which part of it turns the circle away', () => {
    const S = sizes();
    // the plug a part asks for is its own circle: the rule at that radius, not the largest under it
    for (let k = 100; k <= 600; k += 5) {
      const model = base(k / 100);
      const best = plugFor(S, model);
      if (best) expect(plugAt(S, best.R, model)).toEqual(best);
    }
    expect(plugAt(S, 21.3, base(3))).toMatchObject({ R: 21.3, theta: 23, camOutN: 1881 });
    // just past the rule's own radius the ring behind the slots is too thin to hold the lugs, then to keep its lines
    expect(plugAt(S, 21.4, base(3))).toEqual({ R: 21.4, why: 'cam' });
    expect(plugAt(S, 25, base(3))).toEqual({ R: 25, why: 'cam' });
    expect(plugAt(S, 25.5, base(3))).toEqual({ R: 25.5, why: 'wall' });
    expect(plugAt(S, 13.9, { solidTop: 20, ringOutAt: () => 40 })).toEqual({ R: 13.9, why: 'tabs' });
    expect(plugAt(S, 21.3, { ...base(3), solidTop: 6.26 })).toEqual({ R: 21.3, why: 'floor' });
  });

  it('never puts a plug\'s tab over its lugs, nor a ridge where it would drop into a slot while the plug turns', () => {
    const wrong = [];
    let laid = 0;
    for (const [n, hl] of [[0.4, 0.2], [0.6, 0.3], [1, 0.3], [2, 0.5]]) {
      for (const c of [0.1, 0.15, 0.3, 0.6]) {
        const S = sizes(n, hl, c);
        const base = S.fb + 2 * (S.dd + c + 0.2);
        for (let k = 30; k <= 5000; k += 3) {
          const R = k / 10;
          const L = plugLayoutOk(S, R);
          if (!L.ok) continue;
          laid++;
          const rp = R - c;
          const d = (mm) => (mm / rp) * (180 / Math.PI);
          // the plug's middle, inside the tabs' slits, has room for its coin slot
          if (rp - S.td - S.g <= 3) wrong.push({ n, c, R, in: 'middle' });
          for (const { psi } of L.tabs) {
            // the tab runs clockwise from its free end, the ridge just inside it, to its root; the plug goes in
            // turned θ clockwise, so the ridge sweeps from ψ − θ (open) to ψ (locked)
            const freeEnd = psi + d(base / 2 + 0.1);
            for (let a = freeEnd - d(S.Ld); a <= freeEnd + d(S.g); a += 0.25) {
              if (L.lugs.some((lug) => inArc(a, [lug.phi - lug.half, lug.phi + lug.half]))) wrong.push({ n, c, R, psi, in: 'lug' });
            }
            for (let a = psi - L.theta - d(base / 2); a <= psi + d(base / 2); a += 0.25) {
              if (L.arms.some((arm) => inArc(a, arm))) wrong.push({ n, c, R, psi, in: 'slot' });
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(laid).toBeGreaterThan(15000);
  });

  it('lays out the plug\'s lugs, slots and tabs as the print study built them, mirrored to lock clockwise seen from below', () => {
    const S = sizes();
    // the study's plug had its tabs at 79.34, 196.88 and 316.88° (R 17.6), 70.61, 188.57, 308.57 (21.3) and 60.04,
    // 178.54, 298.54 (28.7), locking clockwise seen from above
    for (const [R, theta, at] of [[17.6, 28, [280.66, 163.12, 43.12]], [21.3, 23, [289.39, 171.43, 51.43]], [28.7, 17, [299.96, 181.46, 61.46]]]) {
      const L = plugLayoutOk(S, R);
      expect([R, L.ok, L.theta, psis(L)]).toEqual([R, true, theta, at]);
      expect(L.lugs.map((l) => l.phi)).toEqual([360 - PLUG.phi0, 240 - PLUG.phi0, 120 - PLUG.phi0]);
      // each slot's entry is θ clockwise of where its lug locks
      L.arms.forEach(([a0, a1], k) => {
        expect(a1 - L.lugs[k].phi).toBeCloseTo(L.lugs[k].half + (S.c / R) * (180 / Math.PI), 9);
        expect(L.lugs[k].phi - a0).toBeCloseTo(theta + L.lugs[k].half + (S.c / R) * (180 / Math.PI), 9);
      });
    }
  });
});

describe('springs, holds and clicks', () => {
  it('the ring and the curved beam give the textbook values for a ring under point loads and straight beams', () => {
    const E = 2500;
    const ring = (N) => ringCompliance({ R: 10, E: 1, I: 1, A: 1e12, N }) / 1000;
    expect(ring(2)).toBeCloseTo(0.0744, 4);
    expect(ring(3)).toBeCloseTo(0.0159, 4);
    expect(ring(4)).toBeCloseTo(0.0061, 4);
    const I = (b, t) => (b * t ** 3) / 12;
    const bridge = arcBeam({ span: 40, b: 3, t: 1.6, E, ends: 'both' });
    expect(bridge.k / ((192 * E * I(3, 1.6)) / 40 ** 3)).toBeCloseTo(1, 4);
    expect(bridge.strainPerMm / ((12 * 1.6) / 40 ** 2)).toBeCloseTo(1, 3);
    const tab = arcBeam({ span: 10, b: 2, t: 1.2, E, ends: 'one' });
    expect(tab.k / ((3 * E * I(2, 1.2)) / 10 ** 3)).toBeCloseTo(1, 4);
    expect(tab.strainPerMm / ((1.5 * 1.2) / 10 ** 2)).toBeCloseTo(1, 3);
    // curved round a ring it is a little stiffer than straight
    expect(arcBeam({ R: 15, span: 10, b: 2, t: 1.2, E, ends: 'one' }).k).toBeGreaterThan(tab.k);
  });

  it('a lid\'s three lugs hold 250 N at the default clearance, less as it grows; a plug 605 N', () => {
    expect([0.15, 0.3, 0.4].map((c) => Math.round(lugHold(sizes(0.4, 0.2, c)).pull))).toEqual([250, 182, 154]);
    expect(lugHold(sizes())).toMatchObject({ by: 'bending' });
    expect(lugHold(sizes()).perLug).toBeCloseTo(83.33, 2);
    expect(plugHold(sizes())).toBeCloseTo(604.8, 9);
    expect(lugHold(sizes(), 'PETG').pull).toBeCloseTo(lugHold(sizes()).pull, 9);
  });

  it('the clicks take the turns worked out for the lantern\'s lid and base, and the 9 mm tab keeps PLA under its strain', () => {
    // [tab radius, tabs, c] → PLA weak/nominal on a tuned printer, the same on a typical one, PETG weak tuned (N·m)
    const rows = [
      [15.37, 3, 0.15, [0.071, 0.124, 0.089, 0.154, 0.048]],
      [23.15, 6, 0.15, [0.208, 0.361, 0.26, 0.451, 0.142]],
      [20.55, 3, 0.15, [0.093, 0.161, 0.116, 0.202, 0.063]],
      [27.95, 3, 0.15, [0.125, 0.216, 0.156, 0.27, 0.085]],
      [23.15, 6, 0.3, [0.13, 0.226, 0.182, 0.316, 0.089]],
    ];
    for (const [r, tabs, c, want] of rows) {
      const S = sizes(0.4, 0.2, c);
      const got = [{}, { nominal: true }, { printer: 'typical' }, { printer: 'typical', nominal: true }, { material: 'PETG' }].map((o) => click(S, r, tabs, o).torque);
      got.forEach((v, i) => expect([r, c, i, Math.abs(v / want[i] - 1) < 0.02]).toEqual([r, c, i, true]));
    }
    // the printed interference: drawn 0.3, and twice the printer's wall error
    expect(click(sizes(), 23.15, 6).i).toBe(0.4);
    expect(click(sizes(), 23.15, 6, { printer: 'typical' }).i).toBe(0.5);
    expect(two(click(sizes(), 23.15, 6).strain)).toBe(1.1);
    const typical = click(sizes(), 23.15, 6, { printer: 'typical' });
    expect([two(typical.strain), typical.ok]).toEqual([1.38, true]);
    expect(two(click(sizes(0.4, 0.2, 0.3), 23.15, 6, { printer: 'typical' }).strain)).toBe(0.96);
    // an 8 mm tab, pushed where its ridge is, 0.9 mm from its free end, bends 1.8 % as a typical printer prints it: too
    // much for PLA, though PETG takes it
    const short = { ...sizes(), Ld: 8 };
    const eight = click(short, 15.37, 3, { printer: 'typical' });
    expect([two(eight.strain), eight.ok]).toEqual([1.8, false]);
    expect(click(short, 15.37, 3, { printer: 'typical', material: 'PETG' }).ok).toBe(true);
    expect(MATERIALS.PLA.strain).toBe(1.5);
  });

  it('a wide nozzle\'s thicker tab is longer, so every tab bends under PLA\'s 1.5 % where its ridge pushes it', () => {
    // the tab is three lines thick and its strain grows with its thickness: kept 8 mm long, a 0.6 mm nozzle's would
    // bend 2.7 % and a 0.8 mm one's 3.6 %, and crack or take a set after a few turns
    const at = (n) => sizes(n, n / 2, 0.15);
    expect([0.25, 0.4, 0.5, 0.6, 0.8].map((n) => [at(n).td, at(n).Ld])).toEqual([[1.2, 9], [1.2, 9], [1.5, 10], [1.8, 11], [2.4, 12.5]]);
    let accepted = 0;
    for (const n of [0.25, 0.4, 0.5, 0.6, 0.8, 1]) {
      for (const c of [0.1, 0.15, 0.3, 0.4]) {
        const S = sizes(n, Math.min(0.3, n / 2), c);
        for (const r of [15, 25, 45]) expect([n, c, r, click(S, r, 3, { printer: 'typical' }).strain <= 1.5]).toEqual([n, c, r, true]);
        // and on every lid a lock is laid out for, however small
        for (let k = 20; k <= 80; k += 4) {
          const lock = collarFor(cone(k / 10), S);
          if (lock.why) continue;
          accepted++;
          expect([n, c, k, click(S, lock.tabR, lock.tabs, { printer: 'typical' }).strain <= 1.5]).toEqual([n, c, k, true]);
        }
      }
    }
    expect(accepted).toBeGreaterThan(200);
    // nor is a lock built whose tabs would: a 0.6 mm nozzle's tab as long as a 0.4 mm one's is turned away, lid or base
    const S6 = sizes(0.6, 0.3, 0.15);
    const outer = cone(4);
    expect(collarFor(outer, S6)).toMatchObject({ tabs: 3, tabR: 19.62 });
    expect(collarFor(outer, { ...S6, Ld: 8 })).toMatchObject({ why: 'tabs' });
    const base4 = { Rwindow: 8.6 * 4, solidTop: 6.5 * 4, ringOutAt: () => 9.32 * 4 };
    expect(plugFor(S6, base4)).toMatchObject({ R: 28.8, tabs: 3 });
    expect(plugAt({ ...S6, Ld: 8 }, 28.8, base4)).toEqual({ R: 28.8, why: 'tabs' });
  });
});

describe('the least scale', () => {
  it('finds where a lock first fits to within a quarter of a percent, and says it as the first whole 5 % that fits', () => {
    for (const [n, hl] of [[0.25, 0.12], [0.4, 0.2], [0.6, 0.3]]) {
      for (const c of [0.15, 0.3, 0.4]) {
        const S = sizes(n, hl, c);
        const fits = (s) => !collarFor(cone(s), S).why;
        const least = leastScale(fits);
        // nothing fits under 250 % (the scan says so), so the brute force starts there
        expect([n, c, [1, 1.5, 2, 2.5].some(fits)]).toEqual([n, c, false]);
        // every 0.5 % is fine enough to check a quarter-percent answer, and half the cost on a slow runner
        let brute = null;
        for (let k = 500; brute == null && k <= 1200; k++) if (fits(k / 200)) brute = k / 200;
        expect([n, c, Math.abs(least / brute - 1) < 0.005, fits(least), fits(least - 0.0025)]).toEqual([n, c, true, true, false]);
        const said = scalePercent(least);
        expect([n, c, fits(said / 100), fits(said / 100 - 0.05)]).toEqual([n, c, true, false]);
      }
    }
    const S = sizes();
    expect(scalePercent(leastScale((s) => !collarFor(cone(s), S).why))).toBe(295);
  }, 240_000);

  it('a larger clearance or a wider nozzle never lowers it', () => {
    const at = (n, hl, c) => leastScale((s) => !collarFor(cone(s), sizes(n, hl, c)).why);
    for (const [n, hl] of [[0.25, 0.12], [0.4, 0.2], [0.6, 0.3]]) {
      const byC = [0.15, 0.3, 0.4].map((c) => at(n, hl, c));
      expect(byC).toEqual([...byC].sort((p, q) => p - q));
    }
    for (const c of [0.15, 0.3, 0.4]) {
      const byN = [[0.25, 0.12], [0.4, 0.2], [0.6, 0.3]].map(([n, hl]) => at(n, hl, c));
      expect(byN).toEqual([...byN].sort((p, q) => p - q));
    }
  });

  it('fits at the start, never, or now and then: the start, null, and the first whole step that fits', () => {
    expect(leastScale(() => true)).toBe(1);
    expect(leastScale(() => true, { from: 2.5 })).toBe(2.5);
    expect(leastScale(() => false)).toBeNull();
    expect(leastScale((s) => s >= 7)).toBeNull();
    // a lock that fits at 2.69 only, then from 2.7712: the scan steps over 2.69, and 280 % is what fits
    const patchy = (s) => (s > 2.689 && s < 2.691) || s >= 2.7712;
    const least = leastScale(patchy);
    expect(least).toBeGreaterThanOrEqual(2.7712);
    expect(least - 2.7712).toBeLessThan(0.0025);
    expect(scalePercent(least)).toBe(280);
    // a base that fits from 2.05: 205 %, offered as 300 %
    expect(scalePercent(leastScale((s) => s >= 2.0469))).toBe(205);
  });
});

describe('the words', () => {
  it('rounds as the texts do: openings whole, Z to a tenth, lifts up to a half, degrees whole, forces to 10 N', () => {
    expect([41.6, 26.04, 42.6, 57.4, 23.06, 63.16].map(roundOpening)).toEqual([42, 26, 43, 57, 23, 63]);
    expect([115.6, 86.80000001, 29.2].map(roundZ)).toEqual([115.6, 86.8, 29.2]);
    expect([4.6, 3.35, 0.95, 2.5, 2.4, 5].map(roundLift)).toEqual([5, 3.5, 1, 2.5, 2.5, 5]);
    expect([18.67, 29, 22.5].map(roundAngle)).toEqual([19, 29, 23]);
    expect([250, 182, 154, 604.8].map(roundForce)).toEqual([250, 180, 150, 600]);
  });

  it('least scales go up to the next 5 %, and a [Make it N %] up to the next 100 %', () => {
    expect([2.76875, 2.8, 2.05, 2.046875, 3.779688, 3.0].map(scalePercent)).toEqual([280, 280, 205, 205, 380, 300]);
    expect([2.76875, 3.779688, 2.05, 3, 3.0001].map(offerPercent)).toEqual([300, 400, 300, 300, 400]);
  });

  it('a tea light goes through an opening 38 mm and the clearance either side across', () => {
    expect(TEA_LIGHT).toBe(38);
    expect([takesTeaLight(41.6, 0.15), takesTeaLight(38.3, 0.15), takesTeaLight(38.29, 0.15), takesTeaLight(38.5, 0.3)]).toEqual([true, true, false, false]);
  });

  it('says which way a lid comes out: under the handle, square to it; sideways with no handle; straight off', () => {
    const along = [1, 0];
    const lantern = { turn: 19, lift: 4.6, dir: [0, 1] };
    expect(wayWords(lantern, along)).toBe('lift it 5 mm and slide it out under the handle, square to it');
    expect(wayWords({ ...lantern, lift: 3.35, dir: [0, -1] }, along)).toBe('lift it 3.5 mm and slide it out under the handle, square to it');
    // the clear ways out on the lantern run ±22.5° either side of square to the handle
    const tilted = [Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
    expect(slideWords(tilted, along)).toBe('under the handle, square to it');
    expect(slideWords([1, 0.2], along)).toBe('sideways');
    expect(wayWords(lantern, null)).toBe('lift it 5 mm and slide it out sideways');
    expect(wayWords({ lift: 0, dir: null }, along)).toBe('lift it off');
    expect(wayWords({ lift: 0, dir: [0, 0] }, null)).toBe('lift it off');
    // in the world, whatever the part's axis: a lid across X under a handle spanning Y slides out along Z
    expect(slideWords([0, 0, 1], [0, 1, 0])).toBe('under the handle, square to it');
    expect(slideWords([0, 0.8, 0.6], [0, 1, 0])).toBe('sideways');
    expect(wayWords({ lift: 4.6, dir: [0, 1, 0] }, [-1, 0, 0])).toBe('lift it 5 mm and slide it out under the handle, square to it');
    expect(wayWords({ lift: 0, dir: [0, 0, 0] }, [-1, 0, 0])).toBe('lift it off');
    // along the handle in the world is along it, whichever axis that is
    expect(slideWords([0, 0, 1], [0, 0, -1])).toBe('sideways');
  });
});
