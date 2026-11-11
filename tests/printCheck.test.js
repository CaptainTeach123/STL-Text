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
    expect(c.supports).toEqual({ area: 0, skin: 0, seam: 0, bed: 0, piece: 0, shallow: 0, places: 0, bridged: 0, joints: 0 });
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
    // a tunnel 14 mm wide is too long a span
    const wide = own(block([0, 0, 0], [30, 30, 20]).subtract(block([8, -1, 5], [22, 31, 12])));
    expect(check(wide).supports.area).toBeCloseTo(14 * 30, 3);
    expect(check(wide).supports.bridged).toBe(0);
    // a shelf 6 mm wide along a wall hangs free
    const shelf = check(join(block([0, 0, 0], [10, 30, 20]), block([10, 0, 14], [16, 30, 20])));
    expect(shelf.supports.area).toBeCloseTo(6 * 30, 3);
    expect(shelf.supports.bridged).toBe(0);
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
    expect(checkRow(check(post), 0.2).foot).toEqual({ contact: 100, across: [10, 10], flat: true, tip: true, small: true, brim: PRINT_CHECK.brimTall });
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
      supports: { area: 300, skin: 300, seam: 0, bed: 300, piece: 0, shallow: 300, places: 2, bridged: 0 },
      steps: [],
      foot: { contact: 100, across: [10, 10], flat: true, tip: false, small: true, brim: 5 },
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
    // under 1 cm² of overhang is not: a bar 4 mm proud of its post
    expect(checkNote(row(join(block([-10, -10, 0], [10, 10, 30]), block([-14, -5, 30], [14, 5, 40]))))).toBeNull();
    expect(checkNote(row(tee()))).toMatchObject({ supports: { skin: 300 }, foot: { small: true, brim: 5 }, layer: 0.2, height: 40 });
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
      "Piece 2 may need supports under about 15 cm² of the model's own faces, standing on the bed. Another way to lay it (Lay pieces) may need less. "
      + 'It stands on a 10 × 10 mm foot, small for its size, and may come loose: add a brim about 5 mm wide in your slicer, or lay it another way.',
    );
    expect(checkNoteWords('Piece 2', checkNote(row(table, '-z', { planes: [{ axis: 2, at: 30 }] })))).toMatch(
      /^Piece 2 may need supports under about 15 cm² of a glue face, standing on the bed\. Another way to lay it \(Lay pieces\) may need less\. A glue face on supports prints rough and may want light sanding before you glue it\. It stands on/,
    );
    // a model printed whole has no Lay pieces to try
    expect(checkNoteWords('The model', { ...checkNote(row(table)), whole: true })).toBe(
      'The model may need supports under about 15 cm² of its faces, standing on the bed. Turned another way it may need less. '
      + 'It stands on a 10 × 10 mm foot, small for its size, and may come loose: add a brim about 5 mm wide in your slicer.',
    );
    expect(checkNoteWords('The model', { ...checkNote(row(leaning(3))), whole: true })).toMatch(/Turning the model so that the face is level or upright, or finer layers, shows them less\.$/);
  });
});
