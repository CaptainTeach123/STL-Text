import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { manifold } from '../src/manifold.js';
import { PART_LEVELS, axisOf, findLoops, findParts, freeWindows, pickPart, reach, sliceStack } from '../src/partFinder.js';
import { gminOf, scalePercent } from '../src/locks.js';
import { setup } from './helpers.js';
import { batLanternSolid, box, gothicSolid, lanternSolid, lidBoxSolid, loggiaSolid, roundLanternSolid, slenderTowerSolid } from './lanternFixture.js';
import { bailBoxSolid, blockSolid, chimneyBoxSolid, hexLanternSolid, jarSolid, mugSolid } from './partFixtures.js';

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

const scaled = (m, s) => (s === 1 ? m : own(m.scale([s, s, s])));
const lidOf = (table) => table.parts.find((e) => e.kind === 'lid');
const baseOf = (table) => table.parts.find((e) => e.kind === 'plug');

describe('free circles', () => {
  it('a window holds material at the face, crosses nothing to its cap, and is cut where an island stands', () => {
    // a ring r 2–3 under a wall r 8–9; a lid's material over the ring; then only the wall, wider
    const rows = [[[2, 3], [8, 9]], [[0, 2.5], [8, 9]], [[7, 9]]];
    expect(freeWindows(rows)).toEqual([{ lo: 3, hi: 7, cap: 2 }, { lo: 9, hi: Infinity, cap: 3 }]);
    // the disc empty at the face holds nothing: no lid there
    expect(freeWindows([[[5, 6]], [[5, 6]]])).toEqual([{ lo: 6, hi: Infinity, cap: 2 }]);
    // an island crossing the circle on the way up closes the window; one beside it narrows it
    expect(freeWindows([[[0, 3], [8, 9]], [[0, 2], [2.5, 5]], []])).toEqual([{ lo: 5, hi: 8, cap: 2 }, { lo: 9, hi: Infinity, cap: 2 }]);
    expect(freeWindows([[[0, 3], [8, 9]], [[0, 2], [2.5, 9.5]], []])).toEqual([{ lo: 9.5, hi: Infinity, cap: 2 }]);
  });

  it('an island seen from a centre: how near and far its material is, whether it goes round it and its hole', () => {
    const { Manifold } = wasm;
    const tube = own(own(Manifold.cylinder(10, 5, 5, 64)).subtract(own(own(Manifold.cylinder(12, 3, 3, 64)).translate([0, 0, -1]))));
    const stack = sliceStack(tube);
    expect(stack.levels).toHaveLength(PART_LEVELS);
    const ring = stack.levels[100].islands[0];
    const r = reach(ring, [0, 0]);
    expect(r.dmin).toBeCloseTo(3 * Math.cos(Math.PI / 64), 6);
    expect(r.dmax).toBeCloseTo(5, 6);
    expect(r).toMatchObject({ encl: true, hole: { near: expect.closeTo(3 * Math.cos(Math.PI / 64), 6) } });
    expect(r.outerMin).toBeCloseTo(5 * Math.cos(Math.PI / 64), 6);
    // from a point in its wall the material is at 0, from outside it does not go round
    expect(reach(ring, [4, 0]).dmin).toBe(0);
    expect(reach(ring, [9, 0])).toMatchObject({ encl: false, hole: null });
    // each level's island overlaps the next one's: one chain
    expect(stack.levels.slice(0, -1).every((lv) => lv.islands[0].up.length === 1)).toBe(true);
    expect(stack.volume).toBeCloseTo(tube.volume(), 0);
  });

  it("finds a lantern's axis through its round parts, wherever it stands", () => {
    const fx = own(own(batLanternSolid()).translate([5, -3, 0]));
    const axis = axisOf(sliceStack(fx));
    expect(axis[0]).toBeCloseTo(5, 3);
    expect(axis[1]).toBeCloseTo(-3, 3);
  });
});

describe('the bat lantern fixture (n 0.4, layers 0.2, clearance 0.15)', () => {
  const tables = {};
  beforeAll(() => {
    const fx = own(batLanternSolid());
    // scaled as the user scales it: the least scales are 5 % steps of the model as loaded
    for (const s of [1, 2, 3, 4]) tables[s] = findParts(scaled(fx, s), { scale: s });
  });

  it('is the 8,004-triangle model the design measured', () => {
    const fx = own(batLanternSolid());
    expect([fx.numTri(), fx.genus(), fx.decompose().map(own).length]).toEqual([8004, 26, 1]);
    expect(fx.volume()).toBeCloseTo(3693.05, 1);
  });

  it('finds one handle, the arch over the cap, and one lid inside it: the dome and cap', () => {
    for (const s of [1, 2, 3, 4]) {
      const t = tables[s];
      expect(t.handles).toHaveLength(1);
      expect(t.handles[0].foot / s).toBeGreaterThan(28);
      expect(t.handles[0].foot / s).toBeLessThan(29);
      expect(t.handles[0].top / s).toBeGreaterThan(49);
      expect(t.parts.map((e) => e.kind).sort()).toEqual(['lid', 'plug']);
      const lid = lidOf(t);
      expect(lid).toMatchObject({ name: 'Dome and cap', side: 1, takesHandle: false, handle: { legs: 2 } });
      expect(Math.abs(lid.handle.span[0])).toBeCloseTo(1, 6);
      expect(lid.covered).toBeCloseTo(0.188, 2);
      expect(Math.hypot(...lid.centre)).toBeLessThan(1e-6);
    }
  });

  it('puts the face on the layers where the rim prints apart from the legs, the circle in the middle of the gap', () => {
    // §10.1: faces 29.0 / 57.4 / 86.0 / 114.6 (±1 layer), R 7.872 / 15.752 / 23.629 / 31.505 (±0.05·s)
    const want = { 1: [29.0, 7.872], 2: [57.4, 15.752], 3: [86.0, 23.629], 4: [114.6, 31.505] };
    for (const s of [1, 2, 3, 4]) {
      const lid = lidOf(tables[s]);
      expect(Math.abs(lid.face - want[s][0])).toBeLessThanOrEqual(0.2 + 1e-9);
      expect(Math.abs(lid.r - want[s][1])).toBeLessThanOrEqual(0.05 * s);
      expect(Math.round(lid.face / 0.2) * 0.2).toBeCloseTo(lid.face, 9);
      expect(lid.gap).toBeGreaterThanOrEqual(gminOf(0.15));
      expect(lid.window[0] < lid.r && lid.r < lid.window[1]).toBe(true);
      // the cap at the spire's tip (38.7·s), the part's top half-way to the crown (42.25·s)
      expect(lid.cap / s).toBeCloseTo(38.7, 1);
      expect(lid.top / s).toBeCloseTo(42.25, 1);
    }
    // a face read just over the layer – where the legs' feet still narrow the gap – passes at 300 % and 400 %, and at
    // 100 % one layer up (29.0 against the design's own); at 200 % the 57.4 face reads 0.88 at its layer, so 57.6
    expect([1, 2, 3, 4].map((s) => lidOf(tables[s]).face)).toEqual([29, 57.6, 86, 114.6]);
  });

  it('a wider clearance needs a wider gap: the face moves up', () => {
    const fx = own(batLanternSolid());
    const lid = lidOf(findParts(scaled(fx, 3), { c: 0.4 }));
    expect(lidOf(tables[3]).gap).toBeLessThan(gminOf(0.4));
    expect(lid.face).toBeGreaterThan(lidOf(tables[3]).face);
    expect(lid.gap).toBeGreaterThanOrEqual(gminOf(0.4));
  });

  it("sizes the lid's twist-lock from its outside over the face", () => {
    expect(lidOf(tables[1])).toMatchObject({ lock: null, why: 'room' });
    expect(lidOf(tables[2])).toMatchObject({ lock: null, why: 'tabs' });
    // §10.1: r0 15.87, Ø 28.54, 27°, 3 tabs at 300 %; r0 23.71, Ø 44.22, 18°, 6 tabs at 400 %
    const at3 = lidOf(tables[3]).lock;
    const at4 = lidOf(tables[4]).lock;
    expect(at3).toMatchObject({ mech: 'twist', theta: 27, tabs: 3, teaLight: false });
    expect(at3.r0).toBeCloseTo(15.87, 1);
    expect(Math.abs(at3.opening - 28.54)).toBeLessThan(0.5);
    expect(at4).toMatchObject({ mech: 'twist', r0: 23.71, opening: 44.22, theta: 18, tabs: 6, teaLight: true });
  });

  it('finds the way out on slices: lifted past the spires and the lock, then slid out under the handle', () => {
    // §10.1: lift 0.95 / 2.4 / 4.1 / 5.6, along ±Y ± 22.5°
    const lifts = [1, 2, 3, 4].map((s) => lidOf(tables[s]).way.lift);
    expect(lifts.map((v) => +v.toFixed(3))).toEqual([0.95, 2.4, 4.1, 5.6]);
    for (const s of [1, 2, 3, 4]) {
      const { way } = lidOf(tables[s]);
      expect(way).toMatchObject({ up: false, dirs: [67.5, 90, 112.5, 247.5, 270, 292.5] });
      expect(way.dir[0]).toBeCloseTo(0, 6);
      expect(way.dir[1]).toBeCloseTo(1, 6);
    }
  });

  it('reads how the body slopes under the face, for the collar', () => {
    // the cone 30° from horizontal: 1.73 mm out per mm down; at 100 % the 2.4 mm under the face reach the upright band
    for (const s of [2, 3, 4]) expect(lidOf(tables[s]).underSlope).toBeCloseTo(1 / Math.tan(Math.PI / 6), 1);
    expect(lidOf(tables[1]).underSlope).toBeLessThan(1.5);
  });

  it('finds the base that twists off underneath, and its lock from 300 %', () => {
    expect(baseOf(tables[1])).toMatchObject({ name: 'Base', lock: null, face: 0, side: 1 });
    expect(baseOf(tables[2]).lock).toBeNull();
    // §10.1: R 21.4, Ø 42.8, 23°, wall 5.68, cam-out 1,840 N at 300 %; R 28.8, Ø 57.6, 17° at 400 %
    expect(baseOf(tables[3]).lock).toMatchObject({ mech: 'plug', R: 21.4, opening: 42.8, theta: 23, camOutN: 1840, tabs: 3, teaLight: true });
    expect(baseOf(tables[3]).lock.wall).toBeCloseTo(5.68, 2);
    expect(baseOf(tables[4]).lock).toMatchObject({ R: 28.8, opening: 57.6, theta: 17 });
    // the floor's top, the ring round the bore and the window grow with the model
    for (const s of [1, 2, 3, 4]) {
      const b = baseOf(tables[s]);
      expect(b.ringOut / s).toBeCloseTo(9.345, 2);
      expect(b.window[1] / s).toBeCloseTo(8.94, 1);
      expect(b.solidTop / s).toBeGreaterThan(6.2);
    }
  });

  it('works out the least scales: a lid lock from 265 %, a tea light through it from 365 %; the base 205 % and 275 %', () => {
    const { least } = lidOf(tables[1]);
    expect([scalePercent(least.lock), scalePercent(least.tea)]).toEqual([265, 365]);
    const b = baseOf(tables[1]).least;
    expect([scalePercent(b.lock), scalePercent(b.tea)]).toEqual([205, 275]);
    // as factors on the size now, whole 5 % of the model as loaded: at 200 % the lid locks from 132.5 % of it, and
    // with a lock there is none to give
    expect(lidOf(tables[2]).least.lock * 2).toBeCloseTo(2.65, 9);
    expect(lidOf(tables[4]).least).toEqual({ lock: null, tea: null });
    expect(lidOf(tables[3]).least.lock).toBeNull();
    expect(lidOf(tables[3]).least.tea * 3).toBeCloseTo(3.65, 9);
  });

  it('the least scale it names is one where the finder finds the lock, and 5 % under it it does not', () => {
    // with a 0.8 mm nozzle the window read quickly at 100 %, between half layers, puts the face at 340 % a layer
    // lower than the finder finds it there, where the tabs fit; at that size they first fit at 350 %
    const fx = own(batLanternSolid());
    const stack = sliceStack(fx);
    for (const [n, hl, c, want] of [[0.4, 0.2, 0.3, 275], [0.8, 0.4, 0.15, 350]]) {
      const pc = scalePercent(lidOf(findParts(fx, { n, hl, c, stack })).least.lock);
      const at = (p) => !!lidOf(findParts(scaled(fx, p / 100), { n, hl, c })).lock;
      expect([pc, at(pc), at(pc - 5)]).toEqual([want, true, false]);
    }
  });

  it('lists the lid first when both lock or neither does, and the one that locks first otherwise', () => {
    for (const s of [1, 2, 3, 4]) expect(tables[s].parts.map((e) => e.kind)).toEqual(['lid', 'plug']);
    // at 250 % the base locks (from 205 %) and the lid does not yet (from 265 %)
    const t = findParts(scaled(own(batLanternSolid()), 2.5), { scale: 2.5 });
    expect(t.parts.map((e) => [e.kind, !!e.lock])).toEqual([['plug', true], ['lid', false]]);
  });

  it('picks the lid on the dome or the finial, the lid under the handle on the handle, the base on the bottom', () => {
    for (const s of [1, 2, 3, 4]) {
      const at = (p) => {
        const r = pickPart(tables[s], p.map((v) => v * s));
        return r.part ? `${r.part.kind} ${r.on}` : 'none';
      };
      expect([at([0, 6.6, 29.6]), at([0, 0, 38.5])]).toEqual(['lid lid', 'lid lid']);
      expect([at([10.1, 0, 36]), at([0, 0, 49.8]), at([12.1, 0, 31.6])]).toEqual(['lid handle', 'lid handle', 'lid handle']);
      expect([at([0, 10.4, 26.5]), at([10.6, 0, 15])]).toEqual(['none', 'none']);
      expect([at([0, 10.3, 5]), at([0, 3, 0])]).toEqual(['plug base', 'plug base']);
    }
  });
});

describe('finding parts on other models', () => {
  it('a lid off the axis is found about its own hole', () => {
    const t = findParts(own(chimneyBoxSolid()), {});
    const lid = lidOf(t);
    expect(lid).toMatchObject({ name: 'Top', centre: [20, 0], face: 40, handle: null, takesHandle: false, window: [15, 42], way: { up: true } });
    expect(Math.hypot(...t.centre)).toBeLessThan(1e-6);
  });

  // general's sweep (§4.8): handles, lids and whether they take a handle, the base's widest circle and its ring
  const sweep = [
    ['roundLanternSolid', roundLanternSolid, { handles: 1, lid: { face: 161.6, r: 46.49, takesHandle: true }, base: [40.77, 47.47], first: 'plug' }],
    ['lanternSolid', lanternSolid, { handles: 1, base: [44.66, 50] }],
    ['lidBoxSolid', lidBoxSolid, { handles: 0, base: [44.98, 50] }],
    ['gothicSolid', gothicSolid, { handles: 1, base: [50.56, 55] }],
    ['loggiaSolid', loggiaSolid, { handles: 0, base: [54.49, 60] }],
    ['slenderTowerSolid', slenderTowerSolid, { handles: 0, base: [31.2, 35] }],
    ['jarSolid', jarSolid, { handles: 0, base: [26.36, 29.98] }],
    ['bailBoxSolid', bailBoxSolid, { handles: 1, base: [36.16, 40] }],
    ['hexLanternSolid', hexLanternSolid, { handles: 1, base: [30.64, 34.64] }],
  ];
  it.each(sweep)('%s', (name, make, want) => {
    const t = findParts(own(make()), {});
    expect(t.handles).toHaveLength(want.handles);
    expect([t.solid, t.open]).toEqual([false, null]);
    const lid = lidOf(t);
    if (want.lid) {
      expect(lid).toMatchObject({ face: want.lid.face, takesHandle: want.lid.takesHandle });
      expect(lid.r).toBeCloseTo(want.lid.r, 1);
    } else expect(lid).toBeUndefined();
    const b = baseOf(t);
    expect(b.window[1]).toBeCloseTo(want.base[0], 1);
    expect(b.ringOut).toBeCloseTo(want.base[1], 1);
    if (want.first) expect(t.parts[0].kind).toBe(want.first);
  });

  it('a mug is open already, and a solid block has nothing inside to open', () => {
    const mug = findParts(own(mugSolid()), {});
    expect(mug).toMatchObject({ solid: false, parts: [], handles: [] });
    expect(mug.open.d).toBeCloseTo(72, 0);
    expect(findParts(own(blockSolid()), {})).toMatchObject({ solid: true, open: null, parts: [] });
  });

  it("a mug's side handle is no handle; a bail on a lid is", () => {
    const loops = (m) => findLoops(sliceStack(own(m)));
    expect(loops(mugSolid()).filter((L) => L.handle)).toHaveLength(0);
    expect(loops(bailBoxSolid()).filter((L) => L.handle)).toHaveLength(1);
  });
});

describe('what is no lid, and what is', () => {
  // small models built for one rule each: a box with a hole through its top, what stands on it, and a post beside
  const cyl = (r, z0, z1, at = [0, 0]) => own(own(wasm.Manifold.cylinder(z1 - z0, r, r, 64)).translate([at[0], at[1], z0]));
  const cube = (min, max) => own(box(min, max));
  const union = (list) => own(wasm.Manifold.union(list));
  const minus = (a, ...cut) => cut.reduce((m, x) => own(m.subtract(x)), a);
  /** A box 2·half wide and 40 tall, 3 mm walls, floor and top, a window in one wall. */
  const hollowBox = (half) => minus(cube([-half, -half, 0], [half, half, 40]), cube([-half + 3, -half + 3, 3], [half - 3, half - 3, 37]), cube([-10, -half - 5, 10], [10, -half + 5, 30]));
  const parts = (m, options = {}) => findParts(m, options).parts;
  const lids = (m) => parts(m).filter((e) => e.kind === 'lid');

  it('a knob over a vent hole: the hole is no opening', () => {
    // the vent is under 1 % of the knob's outline
    const knob = minus(union([hollowBox(40), cyl(10, 39, 50), cyl(3, 39, 70, [-25, 0])]), cyl(0.75, 30, 48));
    expect(lids(knob)).toEqual([]);
  });

  it('a capped cup on a solid block: the air under it leads nowhere', () => {
    const cup = minus(union([cube([-20, -20, 0], [20, 20, 20]), minus(cyl(8, 19.9, 24), cyl(6, 20, 22)), cyl(2, 19.9, 35, [-15, 0])]), cube([-1, -9, 20.5], [1, -5, 21.5]));
    expect(lids(cup)).toEqual([]);
  });

  it('an open collar, a bar over it: nothing of it closes the hole', () => {
    const collar = union([minus(union([hollowBox(40), cyl(14, 39, 46)]), cyl(12, 30, 47)), cyl(3, 39, 62, [-25, 0]), cube([-25, -2, 58], [25, 2, 62])]);
    expect(findParts(collar, {})).toMatchObject({ open: null });
    expect(lids(collar)).toEqual([]);
  });

  it('a cap under a canopy that covers it is inside the model', () => {
    const canopy = union([own(chimneyBoxSolid()), cube([-25, -2, 60], [20, 2, 62]), cyl(20, 60, 62, [20, 0])]);
    expect(lids(canopy)).toEqual([]);
  });

  it('a capped chimney too small to matter', () => {
    const tiny = union([minus(union([hollowBox(40), cyl(2.5, 39, 44)]), cyl(1.5, 30, 45)), cyl(3, 43.5, 46), cyl(3, 39, 70, [-25, 0])]);
    expect(lids(tiny)).toEqual([]);
  });

  it('a pillar inside the chimney: its face would be two islands', () => {
    const pillar = union([own(chimneyBoxSolid()), cyl(1.5, 2.9, 46, [26, 0])]);
    expect(lids(pillar)).toEqual([]);
  });

  it('a small lid on a big box is found, the box itself being a full plane', () => {
    const small = union([minus(union([hollowBox(50), cyl(6, 39, 46)]), cyl(5, 30, 47)), cyl(7, 45.5, 50), cyl(3, 39, 60, [-35, 0])]);
    expect(lids(small).map((e) => [e.centre, e.face])).toEqual([[[0, 0], 40]]);
  });

  it('a ball on a thin neck beside a lid: its face is too small against the lid’s', () => {
    const ball = own(own(wasm.Manifold.sphere(8, 48)).translate([-15, -20, 51]));
    const two = union([minus(union([own(chimneyBoxSolid()), cyl(3.3, 39, 44, [-15, -20])]), cyl(3, 30, 44.5, [-15, -20])), ball]);
    expect(lids(two).map((e) => e.centre)).toEqual([[20, 0]]);
  });

  it('a hole a hair off the axis finds the same lid: one dome and cap', () => {
    const cup = minus(cyl(4.3, 6.55, 8.5, [1, 0]), cyl(3.3, 6.5, 8.6, [1, 0]));
    const t = findParts(union([own(batLanternSolid()), cup]), {});
    expect(t.parts.map((e) => e.kind)).toEqual(['lid', 'plug']);
    expect(Math.hypot(...lidOf(t).centre)).toBeLessThan(0.01);
  });

  it("a raised ring on the floor's top is the base's joint, not something standing on it", () => {
    const ridge = minus(cyl(45.5, 3.9, 4.5), cyl(44, 3.8, 4.6));
    expect(baseOf(findParts(union([own(lanternSolid()), ridge]), {})).window[1]).toBeCloseTo(44.66, 1);
  });

  it("a model's rounded or ragged bottom edge under the bed mouth does not count against the base's ring", () => {
    // the 400 % fixture on a 0.3 mm foot, printed with 0.12 mm layers: the second layer is still the foot
    const footed = union([own(own(own(batLanternSolid()).scale([4, 4, 4])).translate([0, 0, 0.3])), cyl(20, 0, 0.31)]);
    expect(baseOf(findParts(footed, { n: 0.25, hl: 0.12 })).lock).toMatchObject({ R: 28.8 });
  });

  it('a dish on a block is not an open top', () => {
    expect(findParts(minus(cube([-30, -30, 0], [30, 30, 40]), cyl(20, 39, 41)), {}).open).toBeNull();
  });

  it('no handle: a frame whose top is a slab, an eyelet too small to hold, an arch low inside a box', () => {
    const handles = (m) => {
      const loops = findLoops(sliceStack(m));
      return [loops.length > 0, loops.filter((L) => L.handle).length];
    };
    const frame = union([cube([-30, -5, 0], [30, 5, 4]), cube([-30, -5, 4], [-26, 5, 50]), cube([26, -5, 4], [30, 5, 50]), cube([-30, -5, 50], [30, 5, 54])]);
    const ring = own(own(own(own(wasm.Manifold.cylinder(2, 3, 3, 48, true)).subtract(own(wasm.Manifold.cylinder(3, 2, 2, 48, true)))).rotate([90, 0, 0])).translate([0, 0, 55.9]));
    const eyelet = union([cube([-40, -40, 0], [40, 40, 53]), ring]);
    const tube = own(own(wasm.CrossSection.circle(1.5, 24)).translate([20, 0]));
    const arch = own(own(own(wasm.Manifold.revolve(tube, 64, 180)).rotate([90, 0, 0])).translate([0, 0, 3.9]));
    const low = union([own(lidBoxSolid()), arch]);
    expect([handles(frame), handles(eyelet), handles(low)]).toEqual([[true, 0], [true, 0], [true, 0]]);
  });

  it('islands that touch only along an edge are not joined', () => {
    const touching = own(wasm.Manifold.compose([cube([0, 0, 0], [10, 10, 10]), cube([10, 0, 10], [20, 10, 20])]));
    const stack = sliceStack(touching);
    const last = stack.levels.findLast((lv) => lv.z < 10);
    expect(last.islands.map((x) => x.up.length)).toEqual([0]);
    expect(stack.levels.find((lv) => lv.z > 10).islands.map((x) => x.down.length)).toEqual([0]);
  });
});

describe('the pick lookup', () => {
  // two lids and a base by hand: a lid's own place first, then a handle over it, then just under its face, then the base
  const table = {
    h: 1,
    parts: [
      { kind: 'lid', centre: [0, 0], face: 10, cap: 20, r: 5, from: 8, window: [4, 6], handle: { levels: [{ z: 22, boxes: [[-1, -1, 1, 1]] }] } },
      { kind: 'lid', centre: [30, 0], face: 10, cap: 20, r: 5, from: 10, window: [4, 6], handle: null },
      { kind: 'plug', centre: [0, 0], face: 0, solidTop: 3, reach: 12 },
    ],
  };
  const on = (p) => {
    const r = pickPart(table, p);
    return [r.index, r.on];
  };

  it('finds the part a point is on, in that order', () => {
    expect(on([1, 0, 15])).toEqual([0, 'lid']);
    expect(on([31, 0, 15])).toEqual([1, 'lid']);
    expect(on([0, 0, 22.5])).toEqual([0, 'handle']);
    expect(on([2.4, 0, 23.4])).toEqual([0, 'handle']);
    expect(on([2.6, 0, 22])).toEqual([-1, null]);
    expect(on([0, 0, 24.1])).toEqual([-1, null]);
    expect(on([5.5, 0, 9])).toEqual([0, 'under']);
    expect(on([5.5, 0, 5.9])).toEqual([-1, null]);
    expect(on([8.1, 0, 9])).toEqual([-1, null]);
    expect(on([11, 0, 2])).toEqual([2, 'base']);
    expect(on([12.5, 0, 2])).toEqual([-1, null]);
  });
});

describe('what the finder leaves behind', () => {
  it('reads only the slices it needs: the lock checked at another scale reads as far up as the lock reaches there', () => {
    const fx = own(batLanternSolid());
    const binding = Object.getPrototypeOf(wasm.Manifold.prototype);
    const slice = binding.slice;
    let sliced = 0;
    binding.slice = function counted(...args) {
      sliced++;
      return slice.apply(this, args);
    };
    try {
      expect(lidOf(findParts(fx, {})).least.lock).toBe(2.65);
    } finally {
      binding.slice = slice;
    }
    // 751 when this was written; reading the lid's outside as far up at 265 % and 365 % as at 100 % made it 945
    expect(sliced).toBeLessThan(800);
  });

  it('no Manifold or CrossSection, however many slices it reads', () => {
    const model = own(own(batLanternSolid()).scale([3, 3, 3]));
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
      const t = findParts(model, {});
      expect(lidOf(t).lock).not.toBeNull();
    } finally {
      restore.forEach((r) => r());
    }
    expect(tracked.size).toBeGreaterThan(1000);
    expect([...tracked].filter((m) => !m.isDeleted())).toHaveLength(0);
  });
});
