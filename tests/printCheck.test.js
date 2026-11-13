import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { manifold } from '../src/manifold.js';
import { LAY_DOWN, printTransform, tipTurn, yawMat4 } from '../src/split.js';
import {
  FACE, OVERHANG_NZ, PRINT_CHECK, angleWords, areaWords, checkNote, checkNoteWords, checkRow, checkWords, everyWords, faceKind, faceLean, LEAN_REST, levelFace, printCheck, shownFaces, stepArea,
  stepLines, stepSegments, stepsApart, tipBarred, tipNoteWords, tipWorse,
} from '../src/printCheck.js';
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
    expect(everyWords(0.96)).toBe('about every 1 mm');
    // under a millimetre apart, to the tenth: close lines are not told as wider apart than they are
    expect(everyWords(0.76)).toBe('about every 0.8 mm');
    expect(everyWords(0.32)).toBe('about every 0.3 mm');
    expect(everyWords(0.2)).toBe('about every 0.2 mm');
    expect(everyWords(0.02)).toBe('about every 0.1 mm');
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

describe('the picture of the check: what each triangle was counted as', () => {
  /** The check of a solid with its faces told, its mesh, and what the triangles of each kind add up to. */
  const told = (solid, down = '-z', options = {}) => {
    const mesh = solid.getMesh();
    const turn = LAY_DOWN[down];
    const c = printCheck(mesh.vertProperties, mesh.numProp, mesh.triVerts, { turn, faces: true, ...options });
    const P = mesh.vertProperties;
    const at = (v) => [0, 1, 2].map((a) => turn[a] * P[v * 3] + turn[4 + a] * P[v * 3 + 1] + turn[8 + a] * P[v * 3 + 2]);
    // by kind what is seen from below, and by leaning face its own area
    const seen = [0, 0, 0, 0];
    const lean = [];
    const nz = [];
    for (let t = 0; t < mesh.triVerts.length / 3; t++) {
      const [a, b, d] = [0, 1, 2].map((k) => at(mesh.triVerts[3 * t + k]));
      const u = b.map((v, i) => v - a[i]), w = d.map((v, i) => v - a[i]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const area = Math.hypot(...n) / 2;
      seen[faceKind(c.faces[t])] += Math.max(0, -n[2] / 2);
      if (faceKind(c.faces[t])) nz.push(n[2] / (2 * area));
      if (faceLean(c.faces[t])) lean[faceLean(c.faces[t]) - 1] = (lean[faceLean(c.faces[t]) - 1] ?? 0) + area;
    }
    return { c, mesh, seen, lean, nz };
  };

  it('is asked for: without it a check has no faces', () => {
    expect(check(tee()).faces).toBeUndefined();
    const { c, mesh } = told(tee());
    expect(c.faces).toBeInstanceOf(Uint8Array);
    expect(c.faces.length).toBe(mesh.triVerts.length / 3);
    // and the rest of the check is the same
    const { faces, ...rest } = c;
    expect(rest).toEqual(check(tee()));
  });

  it('the triangles of each kind add up to the areas the words are made from', () => {
    // the model's own faces
    const bar = told(tee());
    expect(bar.seen[FACE.skin]).toBeCloseTo(bar.c.supports.skin, 6);
    expect(bar.seen[FACE.skin]).toBeCloseTo(300, 3);
    expect(bar.seen[FACE.seam] + bar.seen[FACE.span]).toBe(0);
    // every one of them looks down further than the rule
    expect(bar.nz.length).toBeGreaterThan(0);
    expect(Math.max(...bar.nz)).toBeLessThan(OVERHANG_NZ);
    // a glue face
    const seam = told(tee(), '-z', { planes: [{ axis: 2, at: 30 }] });
    expect(seam.seen[FACE.seam]).toBeCloseTo(seam.c.supports.seam, 6);
    expect(seam.seen[FACE.seam]).toBeCloseTo(300, 3);
    expect(seam.seen[FACE.skin]).toBe(0);
    // a level span the printer bridges, and a longer one that may need supports
    const span = told(own(block([0, 0, 0], [30, 30, 20]).subtract(block([8, -1, 5], [22, 31, 12]))));
    expect(span.seen[FACE.span]).toBeCloseTo(span.c.supports.span, 6);
    expect(span.seen[FACE.span]).toBeCloseTo(14 * 30, 3);
    expect(span.seen[FACE.skin]).toBe(0);
    const long = told(own(block([0, 0, 0], [50, 30, 20]).subtract(block([8, -1, 5], [42, 31, 12]))));
    expect(long.seen[FACE.skin]).toBeCloseTo(long.c.supports.area, 6);
    expect(long.seen[FACE.span]).toBe(0);
    // what is left out is not painted: a short span, a joint's own faces, the face on the bed
    const short = told(own(block([0, 0, 0], [30, 30, 20]).subtract(block([12, -1, 5], [18, 31, 12]))));
    expect(short.c.faces.every((b) => b === 0)).toBe(true);
    const mesh = tee().getMesh();
    const joints = printCheck(mesh.vertProperties, mesh.numProp, mesh.triVerts, { made: new Uint8Array(mesh.triVerts.length / 3).fill(1), faces: true });
    expect(joints.faces.every((b) => b === 0)).toBe(true);
    // turned another way, the faces are those of that way
    const lying = told(tee(), '+x');
    expect(lying.seen[FACE.skin]).toBeCloseTo(lying.c.supports.skin, 6);
    expect(lying.c.supports.skin).toBeGreaterThan(0);
    expect(Math.max(...lying.nz)).toBeLessThan(OVERHANG_NZ);
  });

  it('the triangles of a leaning face are told with its number in the list', () => {
    const top = told(leaning(3));
    expect(top.c.leaning.length).toBe(1);
    expect(top.lean.length).toBe(1);
    expect(top.lean[0]).toBeCloseTo(top.c.leaning[0].area, 3);
    // an underside that leans is both a leaning face and one that may need supports
    const under = told(leaning(3, false));
    const both = [...under.c.faces].filter((b) => faceLean(b) && faceKind(b) === FACE.skin).length;
    expect(both).toBeGreaterThan(0);
    // a level top and a small leaning face have no number
    expect(told(block([0, 0, 0], [40, 30, 20])).c.faces.every((b) => b === 0)).toBe(true);
  });

  it('what is shown is what the line says: nothing under the least worth saying, and the leaning faces of the row', () => {
    // a bar that hangs 15 mm² over: counted, but the line says "no supports needed"
    const little = told(join(block([0, 0, 0], [10, 10, 10]), block([10, 0, 5], [13, 5, 10])));
    expect(little.c.supports.area).toBeCloseTo(15, 3);
    expect(checkWords(checkRow(little.c, 0.2))[0]).toBe('no supports needed');
    expect(little.c.faces.some((b) => faceKind(b) === FACE.skin)).toBe(true);
    expect(shownFaces(little.c, 0.2).every((b) => b === 0)).toBe(true);
    // 300 mm²: said, and shown as counted
    const bar = told(tee());
    expect([...shownFaces(bar.c, 0.2)]).toEqual([...bar.c.faces]);
    // a lighter copy is painted where the piece's own line says so, not where its own check would
    expect(shownFaces(bar.c, 0.2, little.c).every((b) => b === 0)).toBe(true);
    expect([...shownFaces(little.c, 0.2, bar.c)]).toEqual([...little.c.faces]);
    // a level span is shown where the line tells of one
    const span = told(own(block([0, 0, 0], [30, 30, 20]).subtract(block([8, -1, 5], [22, 31, 12]))));
    expect(checkWords(checkRow(span.c, 0.2))).toContain('bridges a level span of about 14 mm');
    expect([...shownFaces(span.c, 0.2)].filter((b) => faceKind(b) === FACE.span).length).toBeGreaterThan(0);
    expect(shownFaces(span.c, 0.2, bar.c).every((b) => b === 0)).toBe(true);
    // a leaning face is shown while its row tells of it: not at a layer so thick it climbs under two of them
    const top = told(leaning(3));
    expect(checkRow(top.c, 0.2).steps.length).toBe(1);
    expect([...shownFaces(top.c, 0.2)].filter((b) => faceLean(b) === 1).length).toBe([...top.c.faces].filter((b) => faceLean(b) === 1).length);
    expect(checkRow(top.c, 3).steps).toEqual([]);
    expect(shownFaces(top.c, 3).every((b) => b === 0)).toBe(true);
    // without the faces there is nothing to show
    expect(shownFaces(check(tee()), 0.2)).toBeNull();
    expect(shownFaces(null, 0.2)).toBeNull();
  });
});

describe('where the step lines fall', () => {
  /** A solid's points and triangles, its faces as shown at `layer`, and the matrix that lays it on the bed. */
  const drawn = (solid, down = '-z', layer = 0.2) => {
    const mesh = solid.getMesh();
    const P = mesh.vertProperties;
    const c = printCheck(P, mesh.numProp, mesh.triVerts, { turn: LAY_DOWN[down], faces: true });
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) (lo[a] = Math.min(lo[a], P[i + a])), (hi[a] = Math.max(hi[a], P[i + a]));
    const { printMatrix } = printTransform({ min: lo, max: hi }, down, 0);
    return { P, T: mesh.triVerts, faces: shownFaces(c, layer), turn: printMatrix };
  };
  /**
   * A block 200 × 80 whose top climbs `rise` mm from `z0` along x, the top meshed `n` × `n` (2 n² triangles): its
   * points and triangles as `drawn` gives them, the top marked as a leaning face.
   */
  const finelyTopped = (z0, rise, n, layer = 0.2) => {
    const P = [];
    const T = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) P.push((200 * i) / n, (80 * j) / n, z0 + (rise * i) / n);
    const at = (i, j) => j * (n + 1) + i;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) T.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1));
    // the top alone is enough for the lines: every triangle of it one leaning face
    return { P: Float32Array.from(P), T: Uint32Array.from(T), faces: new Uint8Array(T.length / 3).fill(1 << 2), turn: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], layer };
  };
  const laid = (turn, p) => [0, 1, 2].map((a) => turn[a] * p[0] + turn[4 + a] * p[1] + turn[8 + a] * p[2] + turn[12 + a]);
  const ends = (segments) => Array.from({ length: segments.length / 3 }, (_, i) => [...segments.subarray(3 * i, 3 * i + 3)]);

  it('a top leaning 3° has 26 lines 3.8 mm apart at 0.2 mm layers, each at the middle of a layer', () => {
    const { P, T, faces, turn } = drawn(leaning(3));
    const { segments, lines, every } = stepSegments(P, T, faces, { turn, layer: 0.2 });
    expect(every).toBe(1);
    expect(lines).toBe(segments.length / 6);
    const points = ends(segments);
    // every end at half a layer over a whole number of them, on the leaning top
    const levels = new Set();
    for (const p of points) {
      const z = laid(turn, p)[2];
      const k = z / 0.2 - 0.5;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-3);
      levels.add(Math.round(k));
      expect(p[2]).toBeCloseTo(20 + p[0] * Math.tan((3 * Math.PI) / 180), 3);
    }
    // the top climbs from 20 to 25.24 mm: the levels 20.1, 20.3 … 25.1
    expect([...levels].sort((a, b) => a - b)).toEqual(Array.from({ length: 26 }, (_, i) => 100 + i));
    // across the whole face, 80 mm long each, and 3.8 mm from the next
    const xs = [...new Set(points.map((p) => p[0].toFixed(3)))].map(Number).sort((a, b) => a - b);
    expect(xs.length).toBe(26);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeCloseTo(0.2 / Math.tan((3 * Math.PI) / 180), 2);
    let length = 0;
    for (let i = 0; i < points.length; i += 2) length += Math.hypot(...points[i].map((v, a) => v - points[i + 1][a]));
    expect(length).toBeCloseTo(26 * 80, 2);
  });

  it('finer layers give more lines, and a piece lying another way has them where it lies', () => {
    const fine = drawn(leaning(3), '-z', 0.1);
    const xs = new Set(ends(stepSegments(fine.P, fine.T, fine.faces, { turn: fine.turn, layer: 0.1 }).segments).map((p) => p[0].toFixed(3)));
    expect(xs.size).toBe(52);
    // a block whose side leans 4° off upright, laid on that side's opposite: the side is its top, leaning 4°
    const lean = hull([[0, 0, 0], [0, 80, 0], [0, 0, 100], [0, 80, 100], [30, 0, 0], [30, 80, 0], [30 + 100 * Math.tan((4 * Math.PI) / 180), 0, 100], [30 + 100 * Math.tan((4 * Math.PI) / 180), 80, 100]]);
    const side = drawn(lean, '-x');
    expect(side.faces.some((b) => faceLean(b))).toBe(true);
    const { segments, lines } = stepSegments(side.P, side.T, side.faces, { turn: side.turn, layer: 0.2 });
    expect(lines).toBeGreaterThan(0);
    for (const p of ends(segments)) {
      const k = laid(side.turn, p)[2] / 0.2 - 0.5;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-3);
      // on the leaning side, as it is in the model
      expect(p[0]).toBeCloseTo(30 + p[2] * Math.tan((4 * Math.PI) / 180), 3);
    }
  });

  it('a piece with no leaning face shown has none, and the lines can be drawn a little off the face', () => {
    const flat = drawn(block([0, 0, 0], [40, 30, 20]));
    expect(stepSegments(flat.P, flat.T, flat.faces, { turn: flat.turn }).lines).toBe(0);
    // the tee's overhang is painted, but nothing of it leans a little
    const bar = drawn(tee());
    expect(bar.faces.some((b) => b)).toBe(true);
    expect(stepSegments(bar.P, bar.T, bar.faces, { turn: bar.turn }).lines).toBe(0);
    expect(stepSegments(bar.P, bar.T, null).lines).toBe(0);
    const { P, T, faces, turn } = drawn(leaning(3));
    const on = ends(stepSegments(P, T, faces, { turn, layer: 0.2 }).segments);
    const off = ends(stepSegments(P, T, faces, { turn, layer: 0.2, lift: 0.05 }).segments);
    expect(off.length).toBe(on.length);
    // 0.05 mm out along the face's own normal, which leans 3°
    const n = [-Math.sin((3 * Math.PI) / 180), 0, Math.cos((3 * Math.PI) / 180)];
    off.forEach((p, i) => p.forEach((v, a) => expect(v - on[i][a]).toBeCloseTo(0.05 * n[a], 4)));
  });

  it('never makes more than the cap: every second level is left out, then every fourth', () => {
    const { P, T, faces, turn } = drawn(leaning(3));
    const all = stepSegments(P, T, faces, { turn, layer: 0.2 });
    expect(all.thinned).toBe(false);
    const half = stepSegments(P, T, faces, { turn, layer: 0.2, cap: all.lines - 1 });
    expect(half.every).toBe(2);
    expect(half.thinned).toBe(true);
    expect(half.lines).toBeLessThanOrEqual(all.lines - 1);
    expect(new Set(ends(half.segments).map((p) => p[0].toFixed(3))).size).toBe(13);
    const few = stepSegments(P, T, faces, { turn, layer: 0.2, cap: 10 });
    expect(few.every).toBe(8);
    expect(few.lines).toBeLessThanOrEqual(10);
    expect(few.lines).toBeGreaterThan(0);
    // the levels kept are whole multiples of the step, so neighbouring triangles keep the same ones
    for (const p of ends(few.segments)) expect(Math.round(laid(turn, p)[2] / 0.2 - 0.5) % 8).toBe(0);
    // a fine mesh that crosses few levels, one of them a multiple of every step tried (level 64, at 12.9 mm): however
    // many levels are left out that one stays, so what is over the cap is cut short – the cap holds whatever it is
    const low = finelyTopped(12.85, 0.5, 60);
    const whole = stepSegments(low.P, low.T, low.faces, { turn: low.turn, layer: 0.2 });
    expect(whole.lines).toBeGreaterThan(300);
    for (const cap of [1000, 200, 100, 7, 1]) {
      const cut = stepSegments(low.P, low.T, low.faces, { turn: low.turn, layer: 0.2, cap });
      expect(cut.lines, `cap ${cap}`).toBeLessThanOrEqual(cap);
      expect(cut.lines).toBeGreaterThan(0);
      expect(cut.segments.length).toBe(cut.lines * 6);
      expect(cut.thinned).toBe(cut.lines < whole.lines);
    }
  });

  it('an ordinary fine mesh keeps every line: the cap counts far more than its faces need', () => {
    // a top leaning 14° meshed 150 × 150, 45,000 triangles: a line every 0.8 mm at 0.2 mm layers, every 0.4 at 0.1
    const at = (layer) => {
      const fine = finelyTopped(20, 200 * Math.tan((14 * Math.PI) / 180), 150, layer);
      const r = stepSegments(fine.P, fine.T, fine.faces, { turn: fine.turn, layer });
      const levels = new Set(ends(r.segments).map((p) => Math.round(laid(fine.turn, p)[2] / layer - 0.5)));
      return { ...r, levels: levels.size };
    };
    const coarse = at(0.2);
    expect(coarse.every).toBe(1);
    expect(coarse.thinned).toBe(false);
    expect(coarse.levels).toBe(Math.floor((200 * Math.tan((14 * Math.PI) / 180)) / 0.2));
    const fine = at(0.1);
    expect(fine.every).toBe(1);
    expect(fine.thinned).toBe(false);
    expect(fine.levels).toBeGreaterThanOrEqual(2 * coarse.levels);
  });

  it('lines closer than asked are thinned, face by face, and it says so', () => {
    // a top leaning 14° at 0.08 mm layers: a line every 0.33 mm of the face. Kept 1 mm apart, every fourth is drawn
    const steep = drawn(leaning(14), '-z', 0.08);
    const all = stepSegments(steep.P, steep.T, steep.faces, { turn: steep.turn, layer: 0.08 });
    expect(all.every).toBe(1);
    const thin = stepSegments(steep.P, steep.T, steep.faces, { turn: steep.turn, layer: 0.08, apart: 1 });
    expect(thin.every).toBe(4);
    expect(thin.thinned).toBe(true);
    const levels = [...new Set(ends(thin.segments).map((p) => Math.round(laid(steep.turn, p)[2] / 0.08 - 0.5)))].sort((a, b) => a - b);
    expect(levels.every((k) => k % 4 === 0)).toBe(true);
    expect(levels.length).toBeGreaterThan(70);
    expect(Math.abs(levels.length - new Set(ends(all.segments).map((p) => Math.round(laid(steep.turn, p)[2] / 0.08 - 0.5))).size / 4)).toBeLessThanOrEqual(1);
    // across the face they are 4 × 0.08 / sin 14° = 1.32 mm apart: no closer than asked
    const xs = [...new Set(ends(thin.segments).map((p) => p[0].toFixed(3)))].map(Number).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect((xs[i] - xs[i - 1]) / Math.cos((14 * Math.PI) / 180)).toBeCloseTo((4 * 0.08) / Math.sin((14 * Math.PI) / 180), 2);
    // lines already far enough apart are all drawn: 3.8 mm at 3° and 0.2 mm layers
    const gentle = drawn(leaning(3));
    const kept = stepSegments(gentle.P, gentle.T, gentle.faces, { turn: gentle.turn, layer: 0.2, apart: 1 });
    expect(kept.every).toBe(1);
    expect(kept.thinned).toBe(false);
    expect(kept.lines).toBe(stepSegments(gentle.P, gentle.T, gentle.faces, { turn: gentle.turn, layer: 0.2 }).lines);
    // each face by its own lean: a roof of two slopes, 3° and 12°, kept 1.5 mm apart at 0.2 mm layers – the gentle
    // one keeps every line (3.8 mm), the steep one every second (2 × 0.96 mm)
    const t3 = Math.tan((3 * Math.PI) / 180), t12 = Math.tan((12 * Math.PI) / 180);
    const slope = (x0, x1, t) => hull([[x0, 0, 0], [x1, 0, 0], [x0, 80, 0], [x1, 80, 0], [x0, 0, 20 + (x0 ? 0 : 100 * t)], [x0, 80, 20 + (x0 ? 0 : 100 * t)], [x1, 0, 20 + (x1 ? 0 : 100 * t)], [x1, 80, 20 + (x1 ? 0 : 100 * t)]]);
    const roof = drawn(join(slope(-100, 0, t3), slope(0, 100, t12)));
    const both = stepSegments(roof.P, roof.T, roof.faces, { turn: roof.turn, layer: 0.2, apart: 1.5 });
    expect(both.every).toBe(2);
    const side = (left) => new Set(ends(both.segments).filter((p) => (p[0] < 0) === left && Math.abs(p[0]) > 1e-3).map((p) => Math.round(laid(roof.turn, p)[2] / 0.2 - 0.5)));
    expect([...side(true)].some((k) => k % 2 === 1)).toBe(true);
    expect([...side(false)].every((k) => k % 2 === 0)).toBe(true);
    expect(side(false).size).toBeGreaterThan(20);
  });

  it('how far apart lines must be to stay lines on the screen goes by what is shown and the view', () => {
    // 300 mm across in a view 900 dots on its shorter side: three dots are 1 mm
    expect(stepsApart(300, 900)).toBeCloseTo(1, 9);
    expect(stepsApart(300, 390)).toBeCloseTo(2.31, 2);
    expect(stepsApart(300, 900, 6)).toBeCloseTo(2, 9);
    expect(stepsApart(0, 900)).toBe(0);
    expect(stepsApart(300, 0)).toBe(0);
  });
});

describe('step lines are drawn where the line tells of them, and all over a rounded top', () => {
  const marked = (c, layer = 0.2, told = null) => [...shownFaces(c, layer, told)].filter((b) => faceLean(b)).length;
  const withFaces = (solid, down = '-z') => {
    const mesh = solid.getMesh();
    return { mesh, c: printCheck(mesh.vertProperties, mesh.numProp, mesh.triVerts, { turn: LAY_DOWN[down], faces: true }) };
  };

  it('a leaning face that looks down is told of by nobody: no step lines are drawn on it', () => {
    const { mesh, c } = withFaces(leaning(5, false));
    const row = checkRow(c, 0.2);
    // the row keeps it, facing down; the line and the note say nothing of step lines
    expect(row.steps.map((f) => f.facing)).toEqual(['down']);
    expect(checkWords(row).join(' ')).not.toMatch(/step lines/);
    expect(checkNote(row)?.steps).toBeUndefined();
    // it is counted as a leaning face, and painted as one that may need supports – but no line is drawn on it
    expect(c.faces.some((b) => faceLean(b))).toBe(true);
    const shown = shownFaces(c, 0.2);
    expect(shown.some((b) => faceKind(b) === FACE.skin)).toBe(true);
    expect(shown.every((b) => faceLean(b) === 0)).toBe(true);
    expect(stepSegments(mesh.vertProperties, mesh.triVerts, shown, { layer: 0.2 }).lines).toBe(0);
    // a piece with one of each: only the one on top is drawn on
    const two = withFaces(join(leaning(5, false), own(leaning(3).translate([0, 0, 40]))));
    expect(checkRow(two.c, 0.2).steps.map((f) => f.facing)).toEqual(['up', 'down']);
    const up = [...shownFaces(two.c, 0.2)].map((b, t) => (faceLean(b) ? t : -1)).filter((t) => t >= 0);
    expect(up.length).toBeGreaterThan(0);
    const P = two.mesh.vertProperties, T = two.mesh.triVerts;
    for (const t of up) expect(Math.min(P[T[3 * t] * 3 + 2], P[T[3 * t + 1] * 3 + 2], P[T[3 * t + 2] * 3 + 2])).toBeGreaterThan(55);
  });

  it('a shallow cone has its step lines all the way round, not on the three faces the row names', () => {
    // half a roof rising 8° to a point, 100 mm in radius, on a 10 mm disc: 45 faces round it, which the check takes
    // for a few leaning faces side by side – some big enough to be told of, some not
    const rise = 100 * Math.tan((8 * Math.PI) / 180);
    const whole = join(own(M.cylinder(10, 100, 100, 90)), own(own(M.cylinder(rise, 100, 0, 90)).translate([0, 0, 10])));
    const { mesh, c } = withFaces(own(whole.intersect(block([0, -100, 0], [100, 100, 40]))));
    const row = checkRow(c, 0.2);
    expect(row.steps.length).toBe(3);
    expect(row.steps.reduce((sum, f) => sum + f.area, 0)).toBeLessThan(0.4 * 15900);
    expect(checkWords(row).join(' ')).toMatch(/step lines about every 1\.5 mm on a big face on top/);
    const P = mesh.vertProperties, T = mesh.triVerts;
    // every triangle of the roof: those that look up with a point above the disc's top
    const roof = [];
    for (let t = 0; t < T.length / 3; t++) {
      const [a, b, d] = [0, 1, 2].map((e) => T[3 * t + e] * 3);
      const up = (P[b] - P[a]) * (P[d + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[d] - P[a]) > 1e-6;
      if (up && Math.max(P[a + 2], P[b + 2], P[d + 2]) > 10.01) roof.push(t);
    }
    expect(roof.length).toBeGreaterThanOrEqual(45);
    // as counted, the three the row names are not all of it; as shown, all of it is marked
    expect(new Set(roof.map((t) => faceLean(c.faces[t]))).size).toBeGreaterThan(3);
    const shown = shownFaces(c, 0.2);
    expect(roof.every((t) => faceLean(shown[t]) > 0)).toBe(true);
    expect(marked(c)).toBe(roof.length);
    // and so the lines are half rings: every level is crossed from one cut edge of the roof round to the other
    const { segments, lines, thinned } = stepSegments(P, T, shown, { layer: 0.2 });
    expect(thinned).toBe(false);
    const byLevel = new Map();
    for (let i = 0; i < segments.length; i += 6) {
      const k = Math.round(segments[i + 2] / 0.2 - 0.5);
      const turn = (j) => Math.atan2(segments[j + 1], segments[j]);
      const at = byLevel.get(k) ?? byLevel.set(k, [Infinity, -Infinity]).get(k);
      at[0] = Math.min(at[0], turn(i), turn(i + 3));
      at[1] = Math.max(at[1], turn(i), turn(i + 3));
    }
    expect(lines).toBeGreaterThanOrEqual(45 * (byLevel.size - 1));
    expect(byLevel.size).toBe(Math.floor(rise / 0.2));
    // (but for the last few at the very tip, where the faces are slivers)
    for (const [k, [from, to]] of byLevel) if ((k + 0.5) * 0.2 < 10 + rise - 1) expect(to - from, `level ${k}`).toBeCloseTo(Math.PI, 1);
    // at layers so thick the roof climbs under two of them nothing is told, and nothing drawn
    expect(checkWords(checkRow(c, 8)).join(' ')).not.toMatch(/step lines/);
    expect(marked(c, 8)).toBe(0);
  });

  it('a top rounded into many small faces is marked all over, the small ones with the big', () => {
    // a low dome in three rings of 72 faces, on a disc with a wedge beside it whose top leans 3°: the wedge's top is
    // the one big face the line tells of, each ring is small faces all round
    const ring = (r0, r1, z0, z1) => own(own(M.cylinder(z1 - z0, r0, r1, 72)).translate([0, 0, z0]));
    const t = (deg) => Math.tan((deg * Math.PI) / 180);
    const z1 = 10 + 20 * t(12), z2 = z1 + 20 * t(8), z3 = z2 + 20 * t(4);
    const dome = join(own(M.cylinder(10, 80, 80, 72)), ring(80, 60, 10, z1), ring(60, 40, z1, z2), ring(40, 20, z2, z3), own(leaning(3).translate([90, -40, 0])));
    const { mesh, c } = withFaces(dome);
    expect(c.leaning.filter((f) => f.facing === 'up').length).toBe(1);
    const P = mesh.vertProperties, T = mesh.triVerts;
    const shown = shownFaces(c, 0.2);
    let slopes = 0;
    for (let k = 0; k < T.length / 3; k++) {
      const zs = [0, 1, 2].map((e) => P[T[3 * k + e] * 3 + 2]);
      const xs = [0, 1, 2].map((e) => P[T[3 * k + e] * 3]);
      // a face of a ring: over the disc, sloping
      if (Math.max(...xs) > 80.01 || Math.min(...zs) < 9.99 || Math.max(...zs) - Math.min(...zs) < 0.5) continue;
      slopes++;
      expect(faceLean(c.faces[k])).toBe(LEAN_REST);
      expect(faceLean(shown[k])).toBe(LEAN_REST);
    }
    expect(slopes).toBe(3 * 72 * 2);
    // without the wedge the line tells of no step lines, and none of the dome is marked
    const alone = withFaces(join(own(M.cylinder(10, 80, 80, 72)), ring(80, 60, 10, z1), ring(60, 40, z1, z2), ring(40, 20, z2, z3)));
    expect(checkWords(checkRow(alone.c, 0.2)).join(' ')).not.toMatch(/step lines/);
    expect(alone.c.faces.some((b) => faceLean(b) === LEAN_REST)).toBe(true);
    expect(marked(alone.c)).toBe(0);
    // a small face that leans but looks down has no number at all
    const under = withFaces(join(block([0, 0, 0], [10, 10, 10]), hull([[10, 0, 10], [20, 0, 10 + 10 * t(5)], [10, 10, 10], [20, 10, 10 + 10 * t(5)], [10, 0, 14], [20, 0, 14], [10, 10, 14], [20, 10, 14]])));
    expect(under.c.faces.every((b) => faceLean(b) === 0)).toBe(true);
  });

  it('a lighter copy is drawn on only where the piece itself is told of step lines', () => {
    const top = withFaces(leaning(3));
    const none = withFaces(block([0, 0, 0], [100, 80, 20]));
    const under = withFaces(leaning(5, false));
    expect(marked(top.c, 0.2, top.c)).toBeGreaterThan(0);
    expect(marked(top.c, 0.2, none.c)).toBe(0);
    expect(marked(top.c, 0.2, under.c)).toBe(0);
    // and where the copy has lost its leaning face there is nothing to draw on, whatever the piece's line says
    expect(marked(none.c, 0.2, top.c)).toBe(0);
  });
});

describe('tipping a piece so that its big leaning face prints level', () => {
  /** The check of a solid tipped so that `face` is level, as the engine makes it. */
  const tipped = (solid, face, down = '-z', options = {}) => check(solid, down, { turn: tipTurn(down, face.normal).turn, skirt: false, ...options });
  /** A shallow roof 100 × 80: two faces, each leaning `deg` degrees down from the ridge along the middle. */
  const roof = (deg) => {
    const rise = 50 * Math.tan((deg * Math.PI) / 180);
    return hull([[0, 0, 0], [100, 0, 0], [0, 80, 0], [100, 80, 0], [0, 0, 20], [100, 0, 20], [0, 80, 20], [100, 80, 20], [50, 0, 20 + rise], [50, 80, 20 + rise]]);
  };

  it('a leaning face is told with the way it looks, and the face to level is the largest on top that shows step lines', () => {
    const c = check(leaning(3));
    const rad = (3 * Math.PI) / 180;
    expect(c.leaning).toHaveLength(1);
    expect(Math.hypot(...c.leaning[0].normal)).toBeCloseTo(1, 9);
    c.leaning[0].normal.forEach((v, a) => expect(v).toBeCloseTo([-Math.sin(rad), 0, Math.cos(rad)][a], 5));
    const face = levelFace(c, 0.2);
    expect(face).toMatchObject({ tilt: expect.closeTo(3, 3), area: expect.closeTo(8011, 0) });
    expect(face.normal).toEqual(c.leaning[0].normal);
    expect(stepArea(c, 0.2)).toBeCloseTo(face.area, 6);
    // none on a plain block, none for a face that looks down, none where the face climbs less than two layers
    expect(levelFace(check(block([0, 0, 0], [100, 80, 20])), 0.2)).toBeNull();
    expect(levelFace(check(leaning(3, false)), 0.2)).toBeNull();
    expect(levelFace(check(leaning(0.3)), 0.4)).toBeNull();
    expect(levelFace(null)).toBeNull();
    // of two, the larger
    const two = check(join(leaning(3), own(leaning(5).scale([0.5, 0.5, 1]).translate([200, 0, 0]))));
    expect(levelFace(two, 0.2).tilt).toBeCloseTo(3, 3);
  });

  it('is barred without such a face, for one that leans more than 8°, and for a piece that stands on little as it lies', () => {
    const c = check(leaning(3));
    expect(tipBarred(c, levelFace(c))).toBeNull();
    expect(tipBarred(c, null)).toBe('none');
    expect(tipBarred(null, levelFace(c))).toBe('none');
    const steep = check(leaning(10));
    expect(PRINT_CHECK.tipMax).toBe(8);
    expect(tipBarred(steep, levelFace(steep))).toBe('steep');
    expect(tipBarred(check(leaning(8)), levelFace(check(leaning(8))))).toBe('steep'); // 8° and a hair, as it is meshed
    expect(tipBarred(check(leaning(7.9)), levelFace(check(leaning(7.9))))).toBeNull();
    // a tall post with a leaning top may tip as it stands
    const post = check(hull([[0, 0, 0], [30, 0, 0], [0, 30, 0], [30, 30, 0], [0, 0, 200], [30, 0, 202], [0, 30, 200], [30, 30, 202]]));
    expect(post.foot.tip).toBe(true);
    expect(tipBarred(post, { tilt: 3.8, area: 900, normal: [0, 0, 1] })).toBe('foot');
  });

  it('is barred before it is asked for where the other faces on top would still lean: a shallow roof, a low cone', () => {
    // a roof's two sides: level one and the other leans twice as much – half the step lines stay
    const ridge = check(roof(3));
    expect(tipBarred(ridge, levelFace(ridge), 0.2)).toBe('steps');
    // half a low cone on a disc: whichever part of it is made level, most of the others lean as much or more
    const cone = check(own(join(own(M.cylinder(10, 90, 90, 96)), own(own(M.cylinder(90 * Math.tan((5 * Math.PI) / 180), 90, 0, 96)).translate([0, 0, 10]))).trimByPlane([1, 0, 0], 0)));
    const facet = levelFace(cone, 0.2);
    expect(facet.tilt).toBeCloseTo(5, 0);
    expect(tipBarred(cone, facet, 0.2)).toBe('steps');
    // two faces that lean the same way are both made level: nothing against it
    const two = check(join(leaning(3), own(leaning(3).scale([0.5, 0.5, 1]).translate([200, 0, 0]))));
    expect(two.leaning.filter((f) => f.facing === 'up')).toHaveLength(2);
    expect(tipBarred(two, levelFace(two), 0.2)).toBeNull();
    // a small face that leans another way is too little to refuse for
    const small = check(join(leaning(3), own(own(leaning(3).scale([0.5, 0.5, 1])).rotate([0, 0, 180]).translate([300, 0, 0]))));
    expect(small.leaning.filter((f) => f.facing === 'up')).toHaveLength(2);
    expect(tipBarred(small, levelFace(small), 0.2)).toBeNull();
  });

  it('tipped, the face is level and what the piece lay on needs supports: that is its price, and no reason to refuse', () => {
    const solid = leaning(3);
    const before = check(solid);
    const face = levelFace(before);
    const after = tipped(solid, face);
    expect(stepArea(after, 0.2)).toBe(0);
    expect(after.leaning.filter((f) => f.facing === 'up')).toEqual([]);
    // the whole underside hangs over the bed now, 3° off it, and the piece rests on an edge
    expect(after.supports.area).toBeCloseTo(8000 * Math.cos((3 * Math.PI) / 180), 0);
    expect(after.supports).toMatchObject({ places: 1, piece: 0, bridged: 0 });
    expect(after.supports.bed).toBeCloseTo(after.supports.area, 6);
    expect(after.foot).toMatchObject({ flat: false, contact: 0 });
    expect(tipWorse(before, after, face, 0.2)).toBeNull();
    // a check that could not be made is no leave to tip
    expect(tipWorse(before, null, face, 0.2)).toEqual({ why: 'unknown' });
  });

  it('is worse where another face would lean instead, where new supports elsewhere outgrow the face, or where it would stand tall on an edge', () => {
    // a shallow roof: level one face and the other leans twice as much – half its top still shows step lines
    const ridge = roof(3);
    const before = check(ridge);
    const face = levelFace(before);
    expect(before.leaning.filter((f) => f.facing === 'up')).toHaveLength(2);
    const after = tipped(ridge, face);
    expect(stepArea(after, 0.2)).toBeCloseTo(stepArea(before, 0.2) / 2, -1);
    expect(tipWorse(before, after, face, 0.2)).toEqual({ why: 'steps' });
    // supports: as much again under faces that were not on the bed, and more than the face levelled
    const plain = check(leaning(3));
    const wedge = levelFace(plain);
    const more = { ...tipped(leaning(3), wedge), supports: { ...plain.supports, area: plain.foot.contact + wedge.area + 1 } };
    expect(tipWorse(plain, more, wedge, 0.2)).toEqual({ why: 'supports', extra: expect.closeTo(wedge.area + 1, 6) });
    expect(tipWorse(plain, { ...more, supports: { ...plain.supports, area: plain.foot.contact + wedge.area - 1 } }, wedge, 0.2)).toBeNull();
    // tall: more than five times as tall as it is wide on the bed
    expect(tipWorse(plain, { ...tipped(leaning(3), wedge), height: 401, box: [100, 80] }, wedge, 0.2)).toEqual({ why: 'tall' });
    expect(tipWorse(plain, { ...tipped(leaning(3), wedge), height: 399, box: [100, 80] }, wedge, 0.2)).toBeNull();
  });

  it('a tipped piece on a narrow ring is still told of its supports: its underside is no rounded bottom edge', () => {
    // a frame 100 × 80 with walls 2 mm thick, its top leaning 1.5°: tipped, its underside rises 2.6 mm off the bed
    const frame = own(leaning(1.5).subtract(block([2, 2, -1], [98, 78, 60])));
    const before = check(frame);
    const face = levelFace(before);
    expect(face).not.toBeNull();
    const turn = tipTurn('-z', face.normal).turn;
    // as an ordinary piece the narrow band rising off the bed would be left out
    expect(check(frame, '-z', { turn }).supports.area).toBeLessThan(check(frame, '-z', { turn, skirt: false }).supports.area);
    expect(check(frame, '-z', { turn, skirt: false }).supports.area).toBeGreaterThan(0.75 * before.foot.contact); // all but the wall along the edge it rests on
  });

  it("the piece's line and its note say what the tip costs", () => {
    const solid = leaning(3);
    const before = check(solid);
    const face = levelFace(before);
    const row = checkRow(tipped(solid, face), 0.2);
    expect(checkWords(row, null, { tip: true })).toEqual(['needs supports: about 80 cm², standing on the bed', 'rests on an edge: add a brim, 5 mm wide']);
    // not tipped, the same row would only be told it may need them
    expect(checkWords(row)[0]).toBe('may need supports: about 80 cm², standing on the bed');
    expect(angleWords(2.9999)).toBe('3');
    expect(angleWords(1.4)).toBe('1.5');
    expect(tipNoteWords('Piece 2', { angle: face.tilt, area: face.area, check: row })).toBe(
      'Piece 2 is tipped 3° in its file so that its big face on top (about 80 cm²) prints level, without step lines. '
      + 'What that costs: it no longer lies flat – it rests on an edge, and about 80 cm² under it prints on supports, standing on the bed. '
      + 'In your slicer turn off auto-orient and don\'t use "lay on face" for it, turn supports on ("on build plate only" is enough) and add a brim about 5 mm wide. '
      + 'Untick "Tip this piece" in the pieces list to print it flat again, with the step lines.',
    );
    // its pin holes are only spoken of where it has some: those lying on their side are shaped for the tip
    const lead = 'and add a brim about 5 mm wide. ';
    const tail = 'Untick "Tip this piece" in the pieces list to print it flat again, with the step lines.';
    const told = (holes, rest) => tipNoteWords('Piece 2', { angle: face.tilt, area: face.area, check: row, holes, ...(rest ? { rest } : {}) });
    expect(told({ lying: 0, upright: 0, down: 0 })).toContain(`${lead}${tail}`);
    expect(told({ lying: 2, upright: 0, down: 0 })).toContain(`${lead}Its pin holes are shaped for lying tipped. ${tail}`);
    // upright holes that open upwards have nothing over them: nothing to say
    expect(told({ lying: 0, upright: 3, down: 0 })).toContain(`${lead}${tail}`);
    // those that open onto the bed lean with the piece, and were not shaped for it: said, with what to do
    expect(told({ lying: 0, upright: 3, down: 3 })).toContain(`${lead}Its 3 pin holes that open onto the bed lean with the piece, so one side of each one's end is a little flatter than 45°: keep supports out of them (a support blocker over each hole), or they are hard to dig out and the pins won't go in. ${tail}`);
    expect(told({ lying: 0, upright: 3, down: 3 })).not.toContain('shaped for lying tipped');
    expect(told({ lying: 2, upright: 1, down: 1 })).toContain(`${lead}Its pin holes that lie on their side are shaped for lying tipped. Its pin hole that opens onto the bed leans with the piece, so one side of its end is a little flatter than 45°: keep supports out of it (a support blocker over the hole), or they are hard to dig out and the pin won't go in. ${tail}`);
    // the line says it too, in place of "need no supports" – and on the sheet, where that clause is left out
    expect(checkWords(row, { upright: 3 }, { tip: { holes: { down: 3 } } }).at(-1)).toBe('keep supports out of its 3 pin holes');
    expect(checkWords(row, { upright: 3 }, { fine: false, tip: { holes: { down: 3 } } }).at(-1)).toBe('keep supports out of its 3 pin holes');
    expect(checkWords(row, { upright: 1, pointed: 2 }, { tip: { holes: { down: 1 } } }).at(-1)).toBe('keep supports out of its pin hole that opens onto the bed');
    expect(checkWords(row, { upright: 2, pointed: 2 }, { tip: { holes: { down: 2 } } }).at(-1)).toBe('keep supports out of its 2 pin holes that open onto the bed');
    expect(checkWords(row, { upright: 1 }, { tip: { holes: { down: 1 } } }).at(-1)).toBe('keep supports out of its pin hole');
    expect(checkWords(row, { upright: 3 }, { tip: { holes: { down: 0 } } }).at(-1)).toBe('its 3 pin holes need no supports');
    // a piece that rests on one corner is told so: a brim has nothing to hold there
    expect(checkWords(row, null, { tip: { rest: 'corner' } })).toEqual(['needs supports: about 80 cm², standing on the bed', 'rests on one corner: the supports carry it']);
    expect(checkWords(row, null, { tip: { rest: 'edge' } })[1]).toBe('rests on an edge: add a brim, 5 mm wide');
    expect(told(null, 'corner')).toBe(
      'Piece 2 is tipped 3° in its file so that its big face on top (about 80 cm²) prints level, without step lines. '
      + 'What that costs: it no longer lies flat – it rests on one corner, and about 80 cm² under it prints on supports, standing on the bed. '
      + 'In your slicer turn off auto-orient and don\'t use "lay on face" for it, turn supports on ("on build plate only" is enough). '
      + 'The supports carry it, as it touches the bed at one corner only: a raft holds it better than a brim. '
      + 'Untick "Tip this piece" in the pieces list to print it flat again, with the step lines.',
    );
    // what it lay on was a glue face: said, with what to do about it
    const seam = checkRow(tipped(solid, face, '-z', { planes: [{ axis: 2, at: 0 }] }), 0.2);
    expect(seam.supports.seam).toBe(seam.supports.area);
    expect(checkWords(seam, { upright: 2 }, { tip: true })).toEqual(['needs supports: about 80 cm², under a glue face, standing on the bed', 'rests on an edge: add a brim, 5 mm wide', 'its 2 pin holes need no supports']);
    expect(tipNoteWords('Piece 1', { angle: 3, area: 8011, check: seam })).toContain('That is a glue face: on supports it prints rough and may want light sanding before you glue it.');
    // supports that would stand on the piece itself want supports everywhere
    const onPiece = { ...row, supports: { ...row.supports, piece: row.supports.area, bed: 0 } };
    expect(tipNoteWords('Piece 1', { angle: 3, area: 8011, check: onPiece })).toContain('turn supports on (everywhere, not only on the build plate)');
  });
});
