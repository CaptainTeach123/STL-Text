import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { manifold } from '../src/manifold.js';
import { LAY_DOWN, yawMat4 } from '../src/split.js';
import { OVERHANG_NZ, PRINT_CHECK, areaWords, checkNote, checkNoteWords, checkRow, checkWords, everyWords, printCheck, stepLines } from '../src/printCheck.js';
import { setup } from './helpers.js';

let M;
beforeAll(async () => {
  await setup();
  M = manifold().Manifold;
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

const block = (lo, hi) => own(own(M.cube(hi.map((v, a) => v - lo[a]))).translate(lo));
const join = (...solids) => own(M.union(solids));
const hull = (points) => own(M.hull(points));
/** The check of a solid, lying `down`. */
const check = (solid, down = '-z', options = {}) => {
  const mesh = solid.getMesh();
  return printCheck(mesh.vertProperties, mesh.numProp, mesh.triVerts, { turn: LAY_DOWN[down], ...options });
};
/** A post 10 × 10 × 30 with a bar 40 × 10 × 10 across its top: 300 mm² of the bar hangs over the bed, in two places. */
const tee = () => join(block([-5, -5, 0], [5, 5, 30]), block([-20, -5, 30], [20, 5, 40]));
/** A box 100 × 80 whose top leans `deg` degrees along x (`up`), or whose underside does, on a foot. */
const leaning = (deg, up = true) => {
  const rise = 100 * Math.tan((deg * Math.PI) / 180);
  const corners = (z0, z1) => [[0, 0, z0], [100, 0, z1], [0, 80, z0], [100, 80, z1]];
  return up
    ? hull([...corners(0, 0), ...corners(20, 20 + rise)])
    : join(block([40, 30, 0], [60, 50, 10]), hull([...corners(10 + rise, 10), ...corners(40, 40)]));
};

describe('supports: the faces that may need them', () => {
  it('a block needs none, and stands on its whole underside', () => {
    const c = check(block([0, 0, 0], [40, 30, 20]));
    expect(c.supports).toEqual({ area: 0, skin: 0, seam: 0, bed: 0, piece: 0, shallow: 0, places: 0, bridged: 0, span: 0, reach: 0, joints: 0 });
    expect(c.height).toBeCloseTo(20, 6);
    expect(c.box).toEqual([40, 30]);
    expect(c.foot).toMatchObject({ flat: true, tip: false, small: false, off: false, across: [40, 30], base: 30 });
    expect(c.foot.contact).toBeCloseTo(1200, 3);
    expect(c.leaning).toEqual([]);
  });

  it('a bar across a post hangs over the bed in two places; stood on the bar it hangs nowhere', () => {
    const c = check(tee());
    expect(c.supports.area).toBeCloseTo(300, 3);
    expect(c.supports).toMatchObject({ places: 2, bridged: 0, seam: 0, piece: 0, joints: 0 });
    expect(c.supports.skin).toBeCloseTo(300, 3);
    expect(c.supports.bed).toBeCloseTo(300, 3);
    expect(c.supports.shallow).toBeCloseTo(300, 3);
    const turned = check(tee(), '+z');
    expect(turned.supports.area).toBe(0);
    expect(turned.foot.contact).toBeCloseTo(400, 3);
  });

  it('counts what is seen from below: a face 30° from level by its shadow, not its own area', () => {
    // a wedge: its underside climbs 30° from the edge it stands on
    const run = 40;
    const rise = run * Math.tan(Math.PI / 6);
    const wedge = join(block([-10, 0, 0], [0, 20, rise]), hull([[0, 0, 0], [0, 20, 0], [0, 0, rise], [0, 20, rise], [run, 0, rise], [run, 20, rise]]));
    const c = check(wedge);
    expect(c.supports.area).toBeCloseTo(run * 20, 1);
    expect(c.supports.shallow).toBeCloseTo(0, 6); // at 30° exactly it is not under 30°
    expect(c.supports.bed).toBeCloseTo(run * 20, 1);
  });

  it('a face drawn at exactly 45° never counts, however the piece is turned; one at 40° from level counts in full', () => {
    expect(OVERHANG_NZ).toBeCloseTo(-Math.sin((46.5 * Math.PI) / 180), 12);
    // a prism 40 × 20 × 60 with 6 mm chamfers along both bottom edges
    const section = [[-14, 0], [14, 0], [20, 6], [20, 60], [-20, 60], [-20, 6]];
    const prism = (yaw) => {
      const flat = own(new (manifold().CrossSection)([section]));
      return own(own(own(flat.extrude(20)).rotate([90, 0, 0])).rotate([0, 0, yaw]));
    };
    for (const yaw of [0, 17, 33, 45, 71]) {
      const c = check(prism(yaw));
      expect(c.supports.area, `yaw ${yaw}`).toBe(0);
      expect(c.supports.places, `yaw ${yaw}`).toBe(0);
    }
    // the same with the chamfers 40° from level: 7.15 mm out for 6 mm up
    const out = 6 / Math.tan((40 * Math.PI) / 180);
    const shallow = [[-20 + out, 0], [20 - out, 0], [20, 6], [20, 60], [-20, 60], [-20, 6]];
    for (const yaw of [0, 17, 33]) {
      const flat = own(new (manifold().CrossSection)([shallow]));
      const c = check(own(own(own(flat.extrude(20)).rotate([90, 0, 0])).rotate([0, 0, yaw])));
      expect(c.supports.area, `yaw ${yaw}`).toBeCloseTo(2 * out * 20, 1);
      expect(c.supports.places, `yaw ${yaw}`).toBe(2);
    }
  });

  it('tells a glue face from the model\'s own: a face on a cut plane is the seam\'s', () => {
    const c = check(tee(), '-z', { planes: [{ axis: 2, at: 30 }] });
    expect(c.supports.seam).toBeCloseTo(300, 3);
    expect(c.supports.skin).toBe(0);
    // a plane elsewhere, or across another axis, is not it
    expect(check(tee(), '-z', { planes: [{ axis: 2, at: 29.9 }, { axis: 0, at: 30 }] }).supports.seam).toBe(0);
  });

  it('leaves the joints\' own faces out: they are shaped to print as they lie', () => {
    const solid = tee();
    const mesh = solid.getMesh();
    // every face of the bar's underside called a joint's
    const flags = new Uint8Array(mesh.triVerts.length / 3);
    for (let t = 0; t < flags.length; t++) {
      const z = [0, 1, 2].map((k) => mesh.vertProperties[mesh.triVerts[3 * t + k] * mesh.numProp + 2]);
      if (z.every((v) => Math.abs(v - 30) < 1e-6)) flags[t] = 1;
    }
    const c = printCheck(mesh.vertProperties, mesh.numProp, mesh.triVerts, { made: flags });
    expect(c.supports.area).toBe(0);
    expect(c.supports.joints).toBeCloseTo(300, 3);
    // but a glue face is a glue face, whoever made it
    const seam = printCheck(mesh.vertProperties, mesh.numProp, mesh.triVerts, { made: flags, planes: [{ axis: 2, at: 30 }] });
    expect(seam.supports.seam).toBeCloseTo(300, 3);
    expect(seam.supports.joints).toBe(0);
  });

  it('says where the supports would stand: on the bed, or on the piece itself', () => {
    // a table: its top hangs over the bed
    expect(check(join(block([-5, -5, 0], [5, 5, 30]), block([-20, -20, 30], [20, 20, 35]))).supports).toMatchObject({ piece: 0, places: 1 });
    // a spool: its top hangs over its own base
    const spool = check(join(block([-20, -20, 0], [20, 20, 5]), block([-5, -5, 5], [5, 5, 30]), block([-20, -20, 30], [20, 20, 35])));
    expect(spool.supports.area).toBeCloseTo(1500, 3);
    expect(spool.supports.piece).toBeCloseTo(1500, 3);
    expect(spool.supports.bed).toBe(0);
    // half over a base, half over the bed
    const half = check(join(block([-20, -20, 0], [0, 20, 5]), block([-5, -5, 0], [5, 5, 30]), block([-20, -20, 30], [20, 20, 35])));
    expect(half.supports.piece).toBeGreaterThan(500);
    expect(half.supports.bed).toBeGreaterThan(500);
    expect(half.supports.piece + half.supports.bed).toBeCloseTo(half.supports.area, 6);
  });

  it('a short level ceiling between two walls is bridged; a shelf of the same width is not', () => {
    // a tunnel 6 mm wide through a block
    const tunnel = own(block([0, 0, 0], [30, 30, 20]).subtract(block([12, -1, 5], [18, 31, 12])));
    expect(check(tunnel).supports).toMatchObject({ area: 0, places: 0, bridged: 1 });
    // a hole that ends inside the block: its end is held all round
    const blind = own(block([0, 0, 0], [30, 30, 20]).subtract(block([12, 12, -1], [18, 18, 8])));
    expect(check(blind).supports).toMatchObject({ area: 0, bridged: 1 });
    // a tunnel 14 mm wide is a longer span, held at both ends all the same: told of apart, not as supports
    const wide = check(own(block([0, 0, 0], [30, 30, 20]).subtract(block([8, -1, 5], [22, 31, 12]))));
    expect(wide.supports).toMatchObject({ area: 0, places: 0, bridged: 0 });
    expect(wide.supports.span).toBeCloseTo(14 * 30, 3);
    expect(wide.supports.reach).toBeCloseTo(14, 3);
    expect(checkWords(checkRow(wide, 0.2))).toEqual(['no supports needed', 'bridges a level span of about 14 mm']);
    // one of 30 mm, the span of the app's own clips, still is; one of 34 mm may need supports
    const tunnel30 = check(own(block([0, 0, 0], [50, 30, 20]).subtract(block([10, -1, 5], [40, 31, 12]))));
    expect(tunnel30.supports).toMatchObject({ area: 0, places: 0 });
    expect(tunnel30.supports.reach).toBeCloseTo(30, 3);
    const tunnel34 = check(own(block([0, 0, 0], [50, 30, 20]).subtract(block([8, -1, 5], [42, 31, 12]))));
    expect(tunnel34.supports.area).toBeCloseTo(34 * 30, 3);
    expect(tunnel34.supports).toMatchObject({ places: 1, span: 0, reach: 0 });
    // a slot that runs askew is measured across, not by its box
    const askew = check(own(block([-30, -30, 0], [30, 30, 20]).subtract(own(block([-3, -60, 5], [3, 60, 12]).rotate([0, 0, 30])))));
    expect(askew.supports).toMatchObject({ area: 0, places: 0, bridged: 1 });
    // a shelf 6 mm wide along a wall hangs free
    const shelf = check(join(block([0, 0, 0], [10, 30, 20]), block([10, 0, 14], [16, 30, 20])));
    expect(shelf.supports.area).toBeCloseTo(6 * 30, 3);
    expect(shelf.supports.bridged).toBe(0);
  });

  it('a ledge held along one side only is no span, however long it is for its depth', () => {
    // a wall 20 × 100 × 40 with a ledge 8 mm deep along all of it: its ends are flush with the wall's
    const ledge = check(join(block([0, 0, 0], [20, 100, 40]), block([20, 0, 30], [28, 100, 34])));
    expect(ledge.supports.area).toBeCloseTo(8 * 100, 3);
    expect(ledge.supports).toMatchObject({ places: 1, bridged: 0, span: 0 });
    expect(checkWords(checkRow(ledge, 0.2))[0]).toBe('may need supports: about 8 cm², standing on the bed');
    // the same 10 mm short of each end, 10 mm deep, and one on each side of the wall
    const inset = check(join(block([0, 0, 0], [20, 100, 40]), block([20, 10, 30], [30, 90, 34])));
    expect(inset.supports.area).toBeCloseTo(10 * 80, 3);
    expect(inset.supports.bridged).toBe(0);
    const both = check(join(block([0, 0, 0], [20, 100, 40]), block([20, 0, 30], [30, 100, 34]), block([-10, 0, 30], [0, 100, 34])));
    expect(both.supports.area).toBeCloseTo(2 * 10 * 100, 3);
    expect(both.supports).toMatchObject({ places: 2, bridged: 0, span: 0 });
    // a ledge 1.5 mm proud – the underside of a raised letter – is left out; one 3 mm proud is not
    const proud = (by) => check(join(block([0, 0, 0], [20, 100, 40]), block([20, 10, 20], [20 + by, 90, 34])));
    expect(proud(1.5).supports).toMatchObject({ area: 0, places: 0, bridged: 1 });
    expect(proud(2).supports).toMatchObject({ area: 0, places: 0, bridged: 1 });
    expect(proud(3).supports.area).toBeCloseTo(3 * 80, 3);
    // a shelf between two cheeks is held at its back and both ends, and still hangs free at the front
    const cheeks = check(join(block([0, 0, 0], [20, 100, 40]), block([20, 0, 0], [28, 5, 40]), block([20, 95, 0], [28, 100, 40]), block([20, 5, 30], [28, 95, 34])));
    expect(cheeks.supports.area).toBeCloseTo(8 * 90, 3);
  });

  it('a span is measured the same however finely the ceiling is meshed', () => {
    // a tunnel 24 mm wide and 40 mm long under a roof; and a slot 8 mm wide, 10 mm long
    const tunnel = () => own(block([0, 0, 0], [40, 40, 20]).subtract(block([8, -1, -1], [32, 41, 12])));
    const slot = () => own(block([0, 0, 0], [30, 10, 20]).subtract(block([11, -1, -1], [19, 11, 12])));
    const coarse = check(tunnel());
    expect(coarse.supports).toMatchObject({ area: 0, places: 0, bridged: 0 });
    expect(coarse.supports.span).toBeCloseTo(24 * 40, 3);
    expect(check(slot()).supports).toMatchObject({ area: 0, span: 0, bridged: 1 });
    for (const n of [20, 40, 60]) {
      const mesh = own(tunnel().refine(n)).getMesh();
      expect(mesh.triVerts.length / 3).toBeGreaterThan(n * n * 20);
      const fine = check(own(tunnel().refine(n)));
      expect(fine.supports).toMatchObject({ area: 0, places: 0, bridged: 0 });
      expect(fine.supports.span).toBeCloseTo(24 * 40, 2);
      expect(fine.supports.reach).toBeCloseTo(24, 3);
      expect(checkWords(checkRow(fine, 0.2))).toEqual(checkWords(checkRow(coarse, 0.2)));
      expect(check(own(slot().refine(n))).supports).toMatchObject({ area: 0, span: 0, bridged: 1 });
    }
    // with next to no work allowed, near faces share a measure: the ceiling is still measured, never counted whole
    const dense = own(tunnel().refine(40));
    const spared = check(dense, '-z', { work: 1 });
    expect(spared.supports).toMatchObject({ area: 0, places: 0, bridged: 0 });
    expect(spared.supports.span).toBeCloseTo(24 * 40, 2);
    expect(spared.supports.reach).toBeCloseTo(24, 3);
    // and a ledge on a fine mesh is still a ledge
    const ledge = check(own(join(block([0, 0, 0], [20, 60, 40]), block([20, 0, 30], [28, 60, 34])).refine(30)), '-z', { work: 1 });
    expect(ledge.supports.area).toBeCloseTo(8 * 60, 2);
    expect(ledge.supports.span).toBe(0);
    // so is a 34 mm tunnel, too long to bridge, right into the corners of its open ends; askew as well
    const long = () => own(block([0, 0, 0], [50, 30, 20]).subtract(block([8, -1, 5], [42, 31, 12])));
    expect(check(own(long().refine(30))).supports.area).toBeCloseTo(34 * 30, 2);
    expect(check(own(own(long().refine(30)).rotate([0, 0, 20]))).supports.area).toBeCloseTo(34 * 30, 0);
    // and a small step 1.5 mm proud of its wall is still left out
    const proud = check(own(join(block([0, 0, 0], [20, 100, 40]), block([20, 10, 20], [21.5, 90, 34])).refine(30)));
    expect(proud.supports).toMatchObject({ area: 0, places: 0, bridged: 1 });
  });

  it('a very fine ceiling is measured in good time', () => {
    const tunnel = own(own(block([0, 0, 0], [40, 40, 20]).subtract(block([8, -1, -1], [32, 41, 12]))).refine(120));
    expect(tunnel.numTri()).toBeGreaterThan(400000);
    const from = Date.now();
    const c = check(tunnel);
    expect(Date.now() - from).toBeLessThan(5000);
    expect(c.supports.area).toBe(0);
    expect(c.supports.span).toBeCloseTo(24 * 40, 1);
  });

  it('a roof that slopes is no span to bridge, however little it slopes', () => {
    // a block 50 × 60 × 40 with a tunnel 28 mm wide through it whose roof leans `deg` degrees from wall to wall
    const sloped = (deg, wide = 28) => {
      const rise = wide * Math.tan((deg * Math.PI) / 180);
      const x0 = 25 - wide / 2, x1 = 25 + wide / 2;
      const hole = hull([[x0, -1, -1], [x1, -1, -1], [x0, 61, -1], [x1, 61, -1], [x0, -1, 15], [x0, 61, 15], [x1, -1, 15 + rise], [x1, 61, 15 + rise]]);
      return check(own(block([0, 0, 0], [50, 60, 40]).subtract(hole)));
    };
    expect(sloped(0).supports).toMatchObject({ area: 0, places: 0 });
    expect(sloped(0).supports.reach).toBeCloseTo(28, 3);
    for (const deg of [2, 5, 9, 11]) {
      const c = sloped(deg);
      expect(c.supports.area).toBeCloseTo(28 * 60, 2);
      expect(c.supports).toMatchObject({ places: 1, span: 0, reach: 0, bridged: 0 });
      expect(checkWords(checkRow(c, 0.2))).toEqual(['may need supports: about 17 cm², standing on the bed']);
    }
    // nor is a short one: a 6 mm slot under a 5° roof is not left out
    expect(sloped(5, 6).supports.area).toBeCloseTo(6 * 60, 2);
    // a gabled ceiling 26 mm wide, pitched 5°
    const ridge = 13 * Math.tan((5 * Math.PI) / 180);
    const gable = hull([[12, -1, -1], [38, -1, -1], [12, 61, -1], [38, 61, -1], [12, -1, 15], [12, 61, 15], [38, -1, 15], [38, 61, 15], [25, -1, 15 + ridge], [25, 61, 15 + ridge]]);
    const g = check(own(block([0, 0, 0], [50, 60, 40]).subtract(gable)));
    expect(g.supports.area).toBeCloseTo(26 * 60, 2);
    expect(g.supports.span).toBe(0);
    // a ceiling a hair off level – under a degree, and under a layer in all – still is one
    expect(sloped(0.3, 28).supports).toMatchObject({ area: 0, places: 0 });
    expect(PRINT_CHECK.level).toBeLessThanOrEqual(1);
  });

  it('a rounded bottom edge is left out; a wide underside that rises from the bed is not', () => {
    // boxes rounded all round their edges
    const rounded = (w, d, h, r, n = 48) => {
      const ball = own(M.sphere(r, n));
      return hull([-1, 1].flatMap((i) => [-1, 1].flatMap((j) => [r, h - r].map((z) => own(ball.translate([i * (w / 2 - r), j * (d / 2 - r), z]))))));
    };
    for (const [w, d, h, r] of [[200, 150, 30, 3], [80, 60, 30, 3], [80, 60, 30, 6]]) {
      const c = check(rounded(w, d, h, r));
      expect(c.supports).toMatchObject({ area: 0, places: 0, bridged: 1 });
      const row = checkRow(c, 0.2);
      expect(checkWords(row)).toEqual(['no supports needed']);
      expect(checkNote(row)).toBe(null);
    }
    // coarsely faceted, the same
    expect(check(rounded(80, 60, 30, 6, 12)).supports).toMatchObject({ area: 0, places: 0 });
    // a box rounded with a 20 mm radius hangs a good way over the bed
    expect(check(rounded(120, 100, 60, 20)).supports.area).toBeGreaterThan(1500);
    // a plate on a low foot: the foot's sloping side rises from the bed, the plate's level underside is 1.5 mm over it
    const foot = hull([[-10, -10, 0], [10, -10, 0], [-10, 10, 0], [10, 10, 0], [-13, -13, 1.5], [13, -13, 1.5], [-13, 13, 1.5], [13, 13, 1.5]]);
    const table = check(join(foot, block([-30, -30, 1.5], [30, 30, 6])));
    expect(table.supports.area).toBeGreaterThan(60 * 60 - 26 * 26 - 1);
    // a wide shallow slope from the bed, 2 mm up over 12 mm: no rounded edge
    const keel = hull([[-10, -30, 0], [10, -30, 0], [-10, 30, 0], [10, 30, 0], [-22, -30, 2], [22, -30, 2], [-22, 30, 2], [22, 30, 2], [-22, -30, 10], [22, -30, 10], [-22, 30, 10], [22, 30, 10]]);
    expect(check(keel).supports.area).toBeGreaterThan(1000);
    // the same rounded edge well off the bed – under a ledge – is counted with it
    const high = check(join(block([-10, -10, 0], [10, 10, 20]), own(rounded(80, 60, 20, 3).translate([0, 0, 20]))));
    expect(high.supports.area).toBeGreaterThan(4000);
  });

  it('a mesh of very many long thin faces is checked without the work running away', () => {
    // a cone of 40,000 slivers on a stem: its rim hangs over the bed, and every sliver of its top crosses the grid
    const cone = join(own(M.cylinder(5, 10, 10, 32)), own(own(M.cylinder(30, 50, 0, 40000)).translate([0, 0, 5])));
    const from = Date.now();
    const c = check(cone);
    expect(Date.now() - from).toBeLessThan(5000);
    expect(c.supports.area).toBeGreaterThan(7000);
    expect(c.supports.bed).toBeCloseTo(c.supports.area, 3);
    expect(c.supports.piece).toBe(0);
    // and the grid still tells a face over the piece from one over the bed
    const spool = join(own(M.cylinder(5, 50, 50, 20000)), own(own(M.cylinder(25, 10, 10, 32)).translate([0, 0, 5])), own(own(M.cylinder(5, 50, 50, 20000)).translate([0, 0, 30])));
    const s = check(spool);
    expect(s.supports.piece).toBeCloseTo(s.supports.area, 3);
    expect(s.supports.area).toBeGreaterThan(7000);
  });

  it('leaves out specks, and what the first layer holds', () => {
    // a 1.5 × 1.5 mm nub on a wall: 2.25 mm² hangs
    expect(check(join(block([0, 0, 0], [10, 10, 20]), block([10, 4, 10], [11.5, 5.5, 12]))).supports).toMatchObject({ area: 0, places: 0 });
    // a rim 0.2 mm off the bed all round a block
    expect(check(join(block([0, 0, 0], [20, 20, 10]), block([-2, -2, 0.2], [22, 22, 10]))).supports.area).toBe(0);
    expect(PRINT_CHECK.firstLayer).toBeGreaterThanOrEqual(0.28);
  });

  it('an empty mesh is nothing to check', () => {
    const c = printCheck(new Float32Array(0), 3, new Uint32Array(0));
    expect(c).toMatchObject({ height: 0, box: [0, 0], leaning: [], foot: { contact: 0, flat: false, tip: false, small: false } });
  });
});

describe('step lines: the big faces that lean a little off level', () => {
  it('a top leaning 3° is one face; its lines are 3.8 mm apart at 0.2 mm layers and 1.9 mm at 0.1 mm', () => {
    const c = check(leaning(3));
    expect(c.leaning).toHaveLength(1);
    expect(c.leaning[0].facing).toBe('up');
    expect(c.leaning[0].tilt).toBeCloseTo(3, 2);
    expect(c.leaning[0].area).toBeCloseTo((100 / Math.cos((3 * Math.PI) / 180)) * 80, 1);
    expect(c.leaning[0].rise).toBeCloseTo(5.24, 2);
    expect(stepLines(c.leaning, 0.2)).toEqual([expect.objectContaining({ facing: 'up', lines: 26 })]);
    expect(stepLines(c.leaning, 0.2)[0].every).toBeCloseTo(3.82, 2);
    expect(stepLines(c.leaning, 0.1)[0].every).toBeCloseTo(1.91, 2);
    expect(stepLines(c.leaning, 0)[0].every).toBeCloseTo(3.82, 2); // no layer height given: 0.2 mm
    // a top that looks up needs no supports
    expect(c.supports.area).toBe(0);
  });

  it('1° gives a line every 11.5 mm; turned about z it is the same face', () => {
    expect(stepLines(check(leaning(1)).leaning, 0.2)[0].every).toBeCloseTo(11.46, 2);
    for (const yaw of [17, 45, 90, 213]) {
      const mesh = leaning(3).getMesh();
      const c = printCheck(mesh.vertProperties, mesh.numProp, mesh.triVerts, { turn: yawMat4(yaw) });
      expect(c.leaning, `yaw ${yaw}`).toHaveLength(1);
      expect(c.leaning[0].tilt, `yaw ${yaw}`).toBeCloseTo(3, 2);
    }
  });

  it('a level top, a steep one and a curved one are not told of', () => {
    expect(check(block([0, 0, 0], [100, 80, 20])).leaning).toEqual([]);
    expect(check(leaning(20)).leaning).toEqual([]);
    expect(check(leaning(0.1)).leaning).toEqual([]);
    const ball = own(M.sphere(50, 128));
    expect(check(ball).leaning).toEqual([]);
    // a shallow dome: a ball's cap 100 mm across and 10 mm high
    const dome = own(own(own(M.sphere(130, 256)).translate([0, 0, -120])).intersect(block([-60, -60, 0], [60, 60, 20])));
    expect(check(dome).leaning).toEqual([]);
  });

  it('a small leaning face is not told of, nor one that climbs under two layers', () => {
    // 12 × 12 mm leaning 3° on a 100 × 80 block
    const small = join(block([0, 0, 0], [100, 80, 20]), hull([[0, 0, 20], [12, 0, 20], [0, 12, 20], [12, 12, 20], [0, 0, 20.1], [12, 0, 20.73], [0, 12, 20.1], [12, 12, 20.73]]));
    expect(check(small).leaning).toEqual([]);
    // 0.3° over 60 mm climbs 0.31 mm: one layer and a half
    const low = hull([[0, 0, 0], [60, 0, 0], [0, 60, 0], [60, 60, 0], [0, 0, 20], [60, 0, 20.314], [0, 60, 20], [60, 60, 20.314]]);
    expect(check(low).leaning).toHaveLength(1);
    expect(stepLines(check(low).leaning, 0.2)).toEqual([]);
    expect(stepLines(check(low).leaning, 0.1)).toHaveLength(1);
  });

  it('an underside that leans faces down, and is a matter for supports', () => {
    const c = check(leaning(3, false));
    expect(c.leaning).toEqual([expect.objectContaining({ facing: 'down' })]);
    expect(c.leaning[0].tilt).toBeCloseTo(3, 2);
    expect(c.supports.area).toBeGreaterThan(7000);
    expect(checkRow(c, 0.2).steps).toEqual([expect.objectContaining({ facing: 'down', tilt: 3, every: 3.8 })]);
    // the piece's line speaks of step lines on top only
    expect(checkWords(checkRow(c, 0.2)).join('; ')).not.toMatch(/step/);
  });
});

describe('what a piece stands on', () => {
  it('a tall thin post may tip, and wants the wider brim; lying down it is steady', () => {
    const post = block([0, 0, 0], [10, 10, 150]);
    expect(check(post).foot).toMatchObject({ flat: true, tip: true, small: true, off: false, base: 10, ratio: 15 });
    expect(checkRow(check(post), 0.2).foot).toEqual({ contact: 100, across: [10, 10], flat: true, tip: true, small: true, strip: false, brim: PRINT_CHECK.brimTall });
    expect(check(post, '-x').foot).toMatchObject({ flat: true, tip: false, small: false });
    expect(checkRow(check(post, '-x'), 0.2).foot.brim).toBe(0);
    // five times as tall as it is wide is still steady; a little more is not
    expect(check(block([0, 0, 0], [20, 20, 100])).foot.tip).toBe(false);
    expect(check(block([0, 0, 0], [20, 20, 102])).foot).toMatchObject({ tip: true });
    expect(checkRow(check(block([0, 0, 0], [20, 20, 102])), 0.2).foot.brim).toBe(PRINT_CHECK.brim);
    // a wall 35 mm thick and 141 mm tall is no tower
    expect(check(block([0, 0, 0], [35, 150, 141])).foot.tip).toBe(false);
  });

  it('a block on a small foot has a small foot', () => {
    const c = check(join(block([-8, -8, 0], [8, 8, 4]), block([-30, -30, 4], [30, 30, 44])));
    // a foot a quarter of the outline is not small
    expect(check(join(block([-15, -15, 0], [15, 15, 4]), block([-30, -30, 4], [30, 30, 44]))).foot.small).toBe(false);
    expect(c.foot).toMatchObject({ flat: true, small: true, tip: false });
    expect(checkRow(c, 0.2).foot.brim).toBe(PRINT_CHECK.brim);
    // a small thing on its whole underside has not
    expect(check(block([0, 0, 0], [10, 10, 15])).foot).toMatchObject({ small: false, tip: false });
  });

  it('a tube standing on its ring is as steady as a block, and a plate lying flat is', () => {
    const tube = own(own(M.cylinder(50, 50, 50, 96)).subtract(own(own(M.cylinder(52, 49, 49, 96)).translate([0, 0, -1]))));
    const c = check(tube);
    expect(c.foot.contact).toBeLessThan(400);
    expect(c.foot).toMatchObject({ flat: true, tip: false, small: false, off: false });
    expect(checkRow(c, 0.2).foot.brim).toBe(0);
    expect(checkNote(checkRow(c, 0.2))).toBeNull();
    expect(check(block([0, 0, 0], [100, 100, 4])).foot).toMatchObject({ tip: false, small: false });
    // thin small tubes stand on very little, but all round their outline: across, wall, height
    for (const [d, wall, h] of [[40, 1.2, 60], [30, 1.6, 50], [20, 2, 40], [60, 0.8, 30], [40, 1, 25]]) {
      const ring = own(own(M.cylinder(h, d / 2, d / 2, 96)).subtract(own(own(M.cylinder(h + 2, d / 2 - wall, d / 2 - wall, 96)).translate([0, 0, -1]))));
      const r = check(ring);
      expect(r.foot.contact, `${d} × ${wall} × ${h}`).toBeLessThan(PRINT_CHECK.smallFoot);
      expect(r.foot, `${d} × ${wall} × ${h}`).toMatchObject({ flat: true, tip: false, small: false, strip: false });
      expect(checkWords(checkRow(r, 0.2)), `${d} × ${wall} × ${h}`).toEqual(['no supports needed']);
    }
    // a thin tall rod on as little is told of
    expect(check(block([0, 0, 0], [8, 8, 40])).foot).toMatchObject({ small: true, tip: false });
  });

  it('a round bar lying down rests on a strip: no foot to tip on, a brim all the same', () => {
    // 12 mm across and 120 mm long, drawn with 48 sides and lying on one of them: a facet 0.8 mm wide
    const rod = own(own(own(M.cylinder(120, 6, 6, 48)).rotate([0, 90, 0])).rotate([3.75, 0, 0]));
    const c = check(rod);
    expect(c.foot.contact).toBeGreaterThan(PRINT_CHECK.steady);
    expect(c.foot.base).toBeLessThan(PRINT_CHECK.strip);
    expect(c.foot).toMatchObject({ flat: true, strip: true, tip: false, small: false });
    const r = checkRow(c, 0.2);
    expect(r.foot).toMatchObject({ strip: true, brim: PRINT_CHECK.brim });
    expect(checkWords(r).slice(1)).toEqual(['rests on a narrow strip: add a brim, 5 mm wide']);
    expect(checkNoteWords('Piece 1', { foot: checkNote(r).foot, height: r.height })).toBe(
      'Piece 1 rests on a narrow strip of the bed and may come loose: add a brim about 5 mm wide in your slicer, or lay it another way.',
    );
    // a thin wall standing on its whole edge is as narrow, but that is all of it: it may tip
    expect(check(block([0, 0, 0], [2, 60, 40])).foot).toMatchObject({ strip: false, tip: true });
  });

  it('a piece whose weight hangs past its foot may tip', () => {
    // an L standing on its short leg, its long arm out to one side
    const c = check(join(block([0, 0, 0], [20, 20, 30]), block([0, 0, 30], [120, 20, 50])));
    expect(c.foot).toMatchObject({ flat: true, off: true, tip: true });
  });

  it('a ball has nothing flat to stand on', () => {
    const c = check(own(M.sphere(20, 64)));
    expect(c.foot).toMatchObject({ flat: false, tip: false, small: false, across: null });
    expect(checkWords(checkRow(c, 0.2))).toContain('nothing flat to stand on');
  });
});

describe('the words of the check', () => {
  const row = (solid, down, options, layer = 0.2) => checkRow(check(solid, down, options), layer);

  it('areas and distances in plain words', () => {
    expect(areaWords(40)).toBe('under 1 cm²');
    expect(areaWords(149)).toBe('about 1 cm²');
    expect(areaWords(8011)).toBe('about 80 cm²');
    expect(everyWords(3.82)).toBe('about every 4 mm');
    expect(everyWords(1.91)).toBe('about every 2 mm');
    expect(everyWords(0.76)).toBe('about every 1 mm');
    expect(everyWords(0.2)).toBe('about every 0.5 mm');
  });

  it('the row is rounded, with the layer height it was made for', () => {
    expect(row(tee())).toEqual({
      layer: 0.2,
      height: 40,
      supports: { area: 300, skin: 300, seam: 0, bed: 300, piece: 0, shallow: 300, places: 2, bridged: 0, span: 0, reach: 0 },
      steps: [],
      foot: { contact: 100, across: [10, 10], flat: true, tip: false, small: true, strip: false, brim: 5 },
    });
    expect(row(leaning(3), '-z', {}, 0.1).steps).toEqual([{ facing: 'up', tilt: 3, area: 8011, every: 1.9 }]);
  });

  it('one short clause each for supports, step lines, the foot and the pin holes', () => {
    expect(checkWords(row(block([0, 0, 0], [40, 30, 20])))).toEqual(['no supports needed']);
    expect(checkWords(row(block([0, 0, 0], [40, 30, 20])), { upright: 2, pointed: 1, flat: 1, round: 0 })).toEqual(['no supports needed', 'its 4 pin holes need no supports']);
    expect(checkWords(row(block([0, 0, 0], [40, 30, 20])), { upright: 1 })).toEqual(['no supports needed', 'its pin hole needs no supports']);
    expect(checkWords(row(block([0, 0, 0], [40, 30, 20])), { upright: 0, pointed: 0, flat: 0, round: 0 })).toEqual(['no supports needed']);
    expect(checkWords(null, { upright: 1, pointed: 0, flat: 0, round: 2 })).toEqual(['2 of its 3 pin holes may need supports']);
    expect(checkWords(null, null)).toEqual([]);
    // where the pin holes that need none are said once for all the pieces, only those that may need some are said
    expect(checkWords(row(block([0, 0, 0], [40, 30, 20])), { upright: 2, pointed: 1, flat: 1, round: 0 }, { fine: false })).toEqual(['no supports needed']);
    expect(checkWords(null, { upright: 1, pointed: 0, flat: 0, round: 2 }, { fine: false })).toEqual(['2 of its 3 pin holes may need supports']);
    expect(checkWords(row(tee()))).toEqual(['may need supports: about 3 cm², standing on the bed', 'small foot: add a brim, 5 mm wide']);
    expect(checkWords(row(tee(), '-z', { planes: [{ axis: 2, at: 30 }] }))[0]).toBe('may need supports: about 3 cm², under a glue face, standing on the bed');
    expect(checkWords(row(leaning(3)))).toEqual(['no supports needed', 'step lines about every 4 mm on a big face on top']);
    expect(checkWords(row(block([0, 0, 0], [10, 10, 150])))).toEqual(['no supports needed', 'may tip: add a brim, 8 mm wide']);
    const spool = join(block([-20, -20, 0], [20, 20, 5]), block([-5, -5, 5], [5, 5, 30]), block([-20, -20, 30], [20, 20, 35]));
    expect(checkWords(row(spool))).toEqual(['may need supports: about 15 cm², standing on the piece itself']);
  });

  it('a note only for what is worth one', () => {
    expect(checkNote(null)).toBeNull();
    expect(checkNote(row(block([0, 0, 0], [40, 30, 20])))).toBeNull();
    // a little overhang is not – the piece's line says it: a bar 4 mm proud of its post, and one with 3 cm² under it
    expect(checkNote(row(join(block([-10, -10, 0], [10, 10, 30]), block([-14, -5, 30], [14, 5, 40]))))).toBeNull();
    expect(checkNote(row(tee()))).toEqual({ foot: expect.objectContaining({ small: true, brim: 5 }), layer: 0.2, height: 40 });
    expect(checkNote(row(join(block([-10, -10, 0], [10, 10, 30]), block([-17.5, -10, 30], [17.5, 10, 40]))))).toBeNull();
    expect(PRINT_CHECK.note).toBeGreaterThanOrEqual(500);
    // 6 cm² is, and 3 cm² of a glue face is: it prints rough on supports
    expect(checkNote(row(join(block([-10, -10, 0], [10, 10, 30]), block([-25, -10, 30], [25, 10, 40]))))).toMatchObject({ supports: { skin: 600 } });
    expect(checkNote(row(tee(), '-z', { planes: [{ axis: 2, at: 30 }] }))).toMatchObject({ supports: { seam: 300, skin: 0 } });
    expect(checkNote(row(tee()))).not.toHaveProperty('steps');
    expect(checkNote(row(leaning(3)))).toEqual({ steps: { facing: 'up', tilt: 3, area: 8011, every: 3.8 }, layer: 0.2, height: 25.2 });
    // an underside that leans is supports, not steps
    expect(checkNote(row(leaning(3, false)))).not.toHaveProperty('steps');
  });

  it('the note says what, about how much, and what to do', () => {
    expect(checkNoteWords('Piece 3', checkNote(row(leaning(3))))).toBe(
      'Piece 3 has a big face on top (about 80 cm²) that leans 3° off level: at 0.2 mm layers it prints with a step line about every 4 mm. Another way to lay it, or finer layers, shows them less.',
    );
    expect(checkNoteWords('Piece 1', checkNote(row(block([0, 0, 0], [10, 10, 150]))))).toBe(
      'Piece 1 stands 150 mm tall on a 10 × 10 mm foot and may tip or come loose: add a brim about 8 mm wide in your slicer, or lay it another way.',
    );
    const table = join(block([-5, -5, 0], [5, 5, 30]), block([-20, -20, 30], [20, 20, 35]));
    expect(checkNoteWords('Piece 2', checkNote(row(table)))).toBe(
      "Piece 2 may need supports under about 15 cm² of the model's own faces, standing on the bed. Laid another way it may need less. "
      + 'It stands on a 10 × 10 mm foot, small for its size, and may come loose: add a brim about 5 mm wide in your slicer, or lay it another way.',
    );
    // a piece laid the way that needs least already is not told to try another
    expect(checkNoteWords('Piece 2', { ...checkNote(row(table)), auto: true })).toBe(
      "Piece 2 may need supports under about 15 cm² of the model's own faces, standing on the bed. "
      + 'It stands on a 10 × 10 mm foot, small for its size, and may come loose: add a brim about 5 mm wide in your slicer, or lay it another way.',
    );
    expect(checkNoteWords('Piece 2', checkNote(row(table, '-z', { planes: [{ axis: 2, at: 30 }] })))).toMatch(
      /^Piece 2 may need supports under about 15 cm² of a glue face, standing on the bed\. Laid another way it may need less\. A glue face on supports prints rough and may want light sanding before you glue it\. It stands on/,
    );
    // a model printed whole has no Lay pieces to try
    expect(checkNoteWords('The model', { ...checkNote(row(table)), whole: true })).toBe(
      'The model may need supports under about 15 cm² of its faces, standing on the bed. Turned another way it may need less. '
      + 'It stands on a 10 × 10 mm foot, small for its size, and may come loose: add a brim about 5 mm wide in your slicer.',
    );
    expect(checkNoteWords('The model', { ...checkNote(row(leaning(3))), whole: true })).toMatch(/Turning the model so that the face is level or upright, or finer layers, shows them less\.$/);
  });
});
