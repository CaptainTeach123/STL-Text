// The tea-light seat on a base: read off the model's slices (`seatOf`) on models made for one rule each and on the
// fixture modelled on the user's lantern, and cut as the base's lock is (`seatSolid`, `lockSolids`). The engine's side
// of it – the pieces, the notes and the download – is in engine.test.js.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { manifold } from '../src/manifold.js';
import { FINE_SPECK, findParts, fineSlices, seatOf, sliceStack } from '../src/partFinder.js';
import { LOCK_SEGMENTS, lockSolids, seatSolid } from '../src/lockGeometry.js';
import { SEAT_WORD, plugDims, sizes } from '../src/locks.js';
import { setup } from './helpers.js';
import { batLanternSolid } from './lanternFixture.js';

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

/**
 * A round lantern's lower half: a pot 80 mm across, its floor solid up to `floor`, its wall 4 mm thick up to 60 mm,
 * and on its floor what the test asks for: a cup 34 mm across and 7.6 tall (the fixture's, as the user's lantern has
 * one), eight ribs `ribs` tall from r 5 out to `to`, a top that rises `slope` mm across it, a sealed hollow under the
 * middle (`hollow`: from and to), a roof closing it `roof` mm over the floor, or a post 12 mm across from the floor up
 * to the roof (`post`).
 */
function pot({ floor = 26.4, cup = false, ribs = 0, to = 35, slope = 0, hollow = null, roof = null, post = false } = {}) {
  const { Manifold } = wasm;
  const t = [];
  const k = (m) => {
    t.push(m);
    return m;
  };
  try {
    const cyl = (h, r, z) => k(k(Manifold.cylinder(h, r, r, 128)).translate([0, 0, z]));
    const tube = (h, rin, rout, z) => k(cyl(h, rout, z).subtract(cyl(h + 0.02, rin, z - 0.01)));
    const parts = [];
    if (slope) {
      // the top a plane rising along x, from floor − slope at x = −40 to the floor at x = 40
      const pts = [];
      for (let i = 0; i < 128; i++) {
        const a = (2 * Math.PI * i) / 128;
        const [x, y] = [40 * Math.cos(a), 40 * Math.sin(a)];
        pts.push([x, y, 0], [x, y, floor - slope + (slope * (x + 40)) / 80]);
      }
      parts.push(k(Manifold.hull(pts)));
    } else parts.push(cyl(floor, 40, 0));
    parts.push(tube(60 - floor, 36, 40, floor - 0.5));
    if (cup) parts.push(tube(7.6, 13.2, 17.2, floor - 0.2));
    for (let i = 0; i < (ribs ? 8 : 0); i++) parts.push(k(k(k(Manifold.cube([to - 5, 2, ribs + 0.2])).translate([5, -1, floor - 0.2])).rotate([0, 0, 45 * i])));
    if (roof != null) parts.push(cyl(2, 40, floor + roof));
    if (post) parts.push(cyl(roof + 1, 6, floor - 0.2));
    let m = k(Manifold.union(parts));
    if (hollow) m = k(m.subtract(cyl(hollow[1] - hollow[0], 15, hollow[0])));
    return m.translate([0, 0, 0]);
  } finally {
    t.forEach((m) => m.delete());
  }
}

/** The seat a base of bore R gets on `model`, standing on z = 0, with its lock under it (none: `lock` false). */
function seatIn(model, { R = 28.8, lock = true, S = sizes() } = {}) {
  const m = own(model);
  const stack = sliceStack(m);
  const fine = fineSlices(m, stack.speck * FINE_SPECK);
  return seatOf(stack, fine, [0, 0], R, S, stack.zmin, { lockTop: lock ? plugDims(S, R).top : null });
}

describe('where a base has room for a tea-light seat', () => {
  it('cuts it a depth under a level floor: its floor on a layer, over the lock and solid under it', () => {
    const seat = seatIn(pot());
    expect(seat).toMatchObject({ d: 39.5, r: 19.75, lead: 0.6, zf: 23.4 });
    // the floor is found to a few thousandths: the floor goes the whole depth under it, never a layer more
    expect(seat.mouth).toBeGreaterThanOrEqual(26.4);
    expect(seat.mouth).toBeLessThan(26.403);
    expect(seat.depth).toBeCloseTo(3, 2);
  });

  it("takes a generated model's ribbing as the top, and its own detail standing higher as the model's, which the seat takes the place of", () => {
    // ribs 1.6 mm proud are the floor's: the seat cuts them, a depth under the floor between them
    const ribbed = seatIn(pot({ ribs: 1.6 }));
    expect(ribbed).toMatchObject({ zf: 23.4 });
    expect(ribbed).not.toHaveProperty('clears');
    // ribs 3.5 mm proud, more than the seat is deep, are the model's own inside the seat's mouth: the seat cuts them
    // away; running out past it, they are a top that isn't level round it
    expect(seatIn(pot({ ribs: 3.5, to: 18 }))).toMatchObject({ zf: 23.4, clears: { across: expect.closeTo(36, 0) } });
    expect(seatIn(pot({ ribs: 3.5 }))).toMatchObject({ why: 'level', h: expect.closeTo(3.5, 0) });
    // a cup on the floor, as the user's lantern has: 7.6 mm tall (read to the levels the model is sliced at), 34.4 mm
    // across – the seat goes where it stood, cut on up past its top at 33.8
    const cup = seatIn(pot({ cup: true }));
    expect(cup).toMatchObject({ d: 39.5, zf: 23.4, clears: { across: expect.closeTo(34.4, 1) } });
    expect(cup.clears.h).toBeGreaterThan(7);
    expect(cup.clears.h).toBeLessThanOrEqual(7.6);
    expect(cup.clears.top).toBeGreaterThan(33.8 + 1);
    expect(cup.clears.top).toBeLessThan(33.8 + 2);
    // a post running on up into a roof over it is the model's, and no seat goes there
    expect(seatIn(pot({ roof: 50, post: true }))).toMatchObject({ why: 'detail', d: 39.5, across: 80 });
  });

  it('refuses a top that rises round the seat more than the seat is deep, and one just level enough takes it', () => {
    // 10 mm across 80: 5.6 mm across the ring round the seat's mouth, from its low side to its high side (the high side
    // read to the levels the model is sliced at, a quarter of a millimetre apart)
    expect(seatIn(pot({ slope: 10 }))).toMatchObject({ why: 'level', rough: 3, h: expect.closeTo(5.55, 1) });
    expect(seatIn(pot({ slope: 4 }))).toMatchObject({ d: 39.5 });
  });

  it('refuses a base hollow under the seat, too thin over its lock, or with the model closing too low over it', () => {
    expect(seatIn(pot({ hollow: [12, 18] }))).toEqual({ why: 'hollow' });
    // a floor 9 mm thick leaves the seat 3.7 mm over the lock's 5.26: it needs 4.14
    expect(seatIn(pot({ floor: 9 }))).toMatchObject({ why: 'thin', lock: true, t: expect.closeTo(3.74, 2) });
    // with no lock under it, 2 mm of floor is enough
    expect(seatIn(pot({ floor: 9 }), { lock: false })).toMatchObject({ zf: 6 });
    expect(seatIn(pot({ floor: 4.5 }), { lock: false })).toMatchObject({ why: 'thin', lock: false });
    // a roof 12 mm over the floor: 15 over the seat's; 20 over it leaves room for a wax tea light, not for the LED one
    // the notes say to use, 45 mm tall with its flame; 44 over it is room enough
    expect(seatIn(pot({ roof: 12 }))).toMatchObject({ why: 'low', tall: 45, room: expect.closeTo(15, 0) });
    expect(seatIn(pot({ roof: 20 }))).toMatchObject({ why: 'low', tall: 45, room: expect.closeTo(23, 0) });
    expect(seatIn(pot({ roof: 44 }))).toMatchObject({ d: 39.5 });
  });

  it("refuses a base a tea light can't go through, or with no room for a wall round the seat, before reading a slice", () => {
    const m = own(pot());
    let slices = 0;
    const stack = sliceStack(m);
    const fine = (z) => {
      slices++;
      return fineSlices(m, stack.speck * FINE_SPECK)(z);
    };
    expect(seatOf(stack, fine, [0, 0], 15, sizes(), 0)).toEqual({ why: 'narrow', opening: 30, need: 38.3 });
    expect(seatOf(stack, fine, [0, 0], 21.2, sizes(), 0)).toEqual({ why: 'room', opening: 42.4, need: 42.6 });
    expect(slices).toBe(0);
  });

  it("finds the seat on the fixture's base at 400 % with nothing on its floor, and in place of its cup where it has one", () => {
    const table = (cup) => findParts(own(own(batLanternSolid({ cup })).scale([4, 4, 4])), {}).parts.find((e) => e.kind === 'plug');
    const bare = table(false);
    expect(bare).toMatchObject({ r: 28.8, lock: { mech: 'plug', teaLight: true }, seat: { d: 39.5, zf: 23.4 } });
    expect(bare.seat).not.toHaveProperty('clears');
    expect(table(true).seat).toMatchObject({ d: 39.5, zf: 23.4, clears: { across: 34.4 } });
  });
});

describe("the seat's solid", () => {
  const seat = { r: 19.75, zf: 23.4, mouth: 26.4, lead: 0.6, top: 30.4 };

  it('is a round pocket down to its floor, led in 45° at its mouth, a primitive of its own', () => {
    const { solid, ids } = seatSolid(seat);
    own(solid);
    expect(ids).toEqual([solid.originalID()]);
    const b = solid.boundingBox();
    // its revolve's corners lie on the circle: the lead-in's top 20.35 out
    expect(b.min[2]).toBeCloseTo(23.4, 6);
    expect(b.max[2]).toBeCloseTo(30.4, 6);
    expect(b.max[0]).toBeCloseTo(20.35, 6);
    const lead = (Math.PI * 0.6 * (3 * 19.75 ** 2 + 3 * 19.75 * 0.6 + 0.6 ** 2)) / 3 - Math.PI * 19.75 ** 2 * 0.6;
    const want = Math.PI * 19.75 ** 2 * 3 + lead + Math.PI * 20.35 ** 2 * 4;
    // a 160-gon a turn, a hair inside the circle
    expect(solid.volume()).toBeLessThan(want);
    expect(solid.volume()).toBeGreaterThan(want * 0.9995);
    expect(LOCK_SEGMENTS).toBe(160);
  });

  it("is cut from the base with its lock's cutters, or with its wall's gap alone, its faces named apart from the lock's", () => {
    const S = sizes();
    const base = { mech: 'plug', kind: 'plug', S, R: 28.8, top: 30 };
    const plain = lockSolids(base);
    const seated = lockSolids({ ...base, seat });
    for (const L of [plain, seated]) [L.body.cut, L.part.add, L.part.cut, L.part.after].forEach(own);
    // the seat is in the part's cutters and nowhere else: the body's slots are as they were
    expect(own(seated.part.cut.subtract(plain.part.cut)).volume()).toBeCloseTo(own(seatSolid(seat).solid).volume(), 3);
    expect(own(plain.part.cut.subtract(seated.part.cut)).volume()).toBe(0);
    expect(seated.body.cut.volume()).toBeCloseTo(plain.body.cut.volume(), 6);
    expect(plain.seat).toEqual([]);
    expect(seated.seat).toHaveLength(1);
    expect(seated.ids).toEqual([...plain.ids.map(() => expect.any(Number)), seated.seat[0]]);
    expect(seated.lugs.some((id) => seated.seat.includes(id))).toBe(false);
    // the word on the seat, in the middle of its mouth, on the part
    expect(seated.points.at(-1)).toEqual({ name: SEAT_WORD, on: 'part', at: [0, 0, 26.4] });
    expect(plain.points.some((x) => x.name === SEAT_WORD)).toBe(false);
    // a base with no lock: its wall's gap and the seat
    const lifting = lockSolids({ mech: null, kind: 'plug', S, R: 28.8, top: 30, seat });
    const wall = lockSolids({ mech: null, kind: 'plug', S, R: 28.8, top: 30 });
    for (const L of [lifting, wall]) own(L.part.cut);
    expect(own(lifting.part.cut.subtract(wall.part.cut)).volume()).toBeCloseTo(own(seatSolid(seat).solid).volume(), 3);
    expect([lifting.seat.length, lifting.points.map((x) => x.name)]).toEqual([1, [SEAT_WORD]]);
  });
});
