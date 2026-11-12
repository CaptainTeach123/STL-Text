import { describe, expect, it } from 'vitest';
import {
  MATERIALS, PLAN_DEFAULTS, PRINT_PLAN, SOLID_WORDS, adviseJob, estimateJob, estimatePiece, estimateSolid, estimateWords, gramsWords, hoursWords, jobWords, metresWords,
  planOptions, planSheetLines, settingsWords, spoolWords, wholeWords,
} from '../src/printPlan.js';

const o = planOptions();
/** A cube `s` mm a side, as the plan takes a solid. */
const cube = (s) => ({ volume: s ** 3, area: 6 * s * s, height: s });
/** A piece row with a print check that has nothing to say. */
const quiet = { supports: { area: 0, skin: 0, seam: 0, bed: 0, piece: 0 }, foot: { flat: true, brim: 0 } };
const piece = (index, s, more = {}) => ({ index, size: [s, s, s], volume: s ** 3, area: 6 * s * s, check: quiet, ...more });

describe('what a plan is worked out for', () => {
  it('starts as PLA at 15 % infill, with 2 walls, a 0.4 mm nozzle and 0.2 mm layers on an ordinary printer', () => {
    expect(PLAN_DEFAULTS).toEqual({ material: 'pla', infill: 15 });
    expect(o).toEqual({ material: 'pla', name: 'PLA', density: 1.24, pace: 1, infill: 15, walls: 2, nozzle: 0.4, layer: 0.2, fast: false });
    expect(settingsWords(o)).toBe('PLA, 15 % infill, 2 walls, 0.2 mm layers, 0.4 mm nozzle');
  });

  it('offers PLA, PETG, ABS / ASA and TPU', () => {
    expect(Object.entries(MATERIALS).map(([id, m]) => [id, m.name, m.density])).toEqual([['pla', 'PLA', 1.24], ['petg', 'PETG', 1.27], ['abs', 'ABS / ASA', 1.05], ['tpu', 'TPU', 1.21]]);
  });

  it('takes an unknown material as PLA and keeps the infill within 0–100 %', () => {
    expect(planOptions({ material: 'wood', infill: 250 })).toMatchObject({ material: 'pla', infill: 100 });
    expect(planOptions({ material: 'constructor' }).material).toBe('pla');
    expect(planOptions({ material: 'petg', infill: -3, nozzle: 0.6, layerHeight: 0.3, fast: true })).toMatchObject({ material: 'petg', name: 'PETG', infill: 0, nozzle: 0.6, layer: 0.3, fast: true });
    expect(planOptions({ infill: Number.NaN, nozzle: 0, layerHeight: -1 })).toMatchObject({ infill: 15, nozzle: 0.4, layer: 0.2 });
    expect(planOptions(null)).toEqual(o);
  });
});

describe('the estimate of one solid', () => {
  it('a 100 mm cube in PLA at 2 walls and 15 % comes to about 240 g, as slicers say, given as a range round it', () => {
    const e = estimatePiece(cube(100), o);
    // the skin is the surface times two lines of 0.42 mm; the rest is filled to 15 %
    const plastic = 60000 * 0.84 + 0.15 * (1e6 - 60000 * 0.84);
    expect(e.plastic).toBeCloseTo(plastic, 6);
    expect((plastic * 1.24) / 1000).toBeCloseTo(239.1, 1);
    expect(e.grams[0]).toBeCloseTo(0.9 * 239.12, 1);
    expect(e.grams[1]).toBeCloseTo(1.15 * 239.12, 1);
    expect(gramsWords(e.grams)).toBe('about 220–270 g');
  });

  it('the filament is the plastic drawn out to 1.75 mm', () => {
    const e = estimatePiece(cube(100), o);
    const strand = Math.PI * 0.875 ** 2;
    expect(e.metres[0] * 1000 * strand).toBeCloseTo(PRINT_PLAN.low * e.plastic, 6);
    expect(e.metres[1] * 1000 * strand).toBeCloseTo(PRINT_PLAN.high * e.plastic, 6);
  });

  it('at 100 % infill the plastic is the solid itself', () => {
    const e = estimatePiece(cube(40), planOptions({ infill: 100 }));
    expect(e.plastic).toBeCloseTo(64000, 9);
    expect(e.grams[1]).toBeCloseTo((1.15 * 64000 * 1.24) / 1000, 9);
  });

  it('a thin plate is never more plastic than it holds', () => {
    const plate = { volume: 100 * 100 * 1, area: 2 * 100 * 100 + 4 * 100, height: 1 };
    expect(estimatePiece(plate, planOptions({ infill: 0 })).plastic).toBe(10000);
    expect(estimatePiece(plate, o).thick).toBeCloseTo(0.98, 2);
  });

  it('more infill, a wider nozzle or a denser material never weighs less', () => {
    const at = (given) => estimatePiece(cube(60), planOptions(given)).grams[0];
    expect(at({ infill: 30 })).toBeGreaterThan(at({ infill: 15 }));
    expect(at({ infill: 15 })).toBeGreaterThan(at({ infill: 0 }));
    expect(at({ nozzle: 0.6 })).toBeGreaterThan(at({ nozzle: 0.4 }));
    expect(at({ material: 'petg' })).toBeGreaterThan(at({ material: 'pla' }));
    expect(at({ material: 'abs' })).toBeLessThan(at({ material: 'pla' }));
  });

  it('the time is a wide band: its low end under its high end, a fast printer quicker, TPU slower', () => {
    const hours = (given) => estimatePiece(cube(100), planOptions(given)).hours;
    const [lo, hi] = hours({});
    expect(hi / lo).toBeGreaterThan(2.5);
    // an ordinary printer lays down 2.5–5.5 mm³ a second, and every one of its 500 layers costs 1–4 s besides
    expect(lo).toBeCloseTo((0.9 * 192840) / 5.5 / 3600 + (500 * 1) / 3600, 6);
    expect(hi).toBeCloseTo((1.15 * 192840) / 2.5 / 3600 + (500 * 4) / 3600, 6);
    expect(hoursWords([lo, hi])).toBe('very roughly 8–26 hours');
    const fast = hours({ fast: true });
    expect(fast[0]).toBeLessThan(lo);
    expect(fast[1]).toBeLessThan(hi);
    expect(hoursWords(fast)).toBe('very roughly 3–11 hours');
    expect(hours({ material: 'tpu' })[1]).toBeGreaterThan(2 * hi);
    // finer layers are more layers
    expect(hours({ layerHeight: 0.1 })[1]).toBeGreaterThan(hi);
  });

  it('a solid without a surface is counted as printed solid, the most it can weigh', () => {
    const e = estimatePiece({ volume: 1000, area: null, height: 10 }, o);
    expect(e.atMost).toBe(true);
    expect(e.plastic).toBe(1000);
    expect(estimateWords(e)).toEqual(['at most 1.4 g, printed solid']);
  });

  it('nothing with no volume', () => {
    expect(estimatePiece({ volume: 0, area: 10 }, o)).toBeNull();
    expect(estimatePiece({}, o)).toBeNull();
    expect(estimatePiece(null, o)).toBeNull();
    expect(estimateSolid(0, 5, o)).toBeNull();
    expect(estimateWords(null)).toEqual([]);
  });

  it('pins are counted solid', () => {
    expect(estimateSolid(300, 5, o).plastic).toBe(300);
  });
});

describe('the words of an estimate', () => {
  it('a weight is a range to two figures, in kilograms from 1 kg', () => {
    expect(gramsWords([38.2, 48.4])).toBe('about 38–48 g');
    expect(gramsWords([4.96, 5.04])).toBe('about 5 g');
    expect(gramsWords([0.2, 0.4])).toBe('under 1 g');
    expect(gramsWords([950, 1210])).toBe('about 0.95–1.2 kg');
    expect(gramsWords([1130, 1440])).toBe('about 1.1–1.4 kg');
  });

  it('a length of filament likewise', () => {
    expect(metresWords([13.2, 16.4])).toBe('about 13–16 m');
    expect(metresWords([0.1, 0.3])).toBe('under 1 m');
  });

  it('a time is said only very roughly, in whole hours', () => {
    expect(hoursWords([1.2, 2.9])).toBe('very roughly 1–3 hours');
    expect(hoursWords([0.4, 1.7])).toBe('very roughly up to 2 hours');
    expect(hoursWords([0.1, 0.6])).toBe('under an hour');
    expect(hoursWords([14, 30])).toBe('very roughly 14–30 hours');
    for (const words of [hoursWords([3.3, 9.1]), hoursWords([0.2, 5])]) expect(words).not.toMatch(/min|\d\.\d/);
  });

  it('how much of a spool', () => {
    expect(spoolWords([410, 520])).toBe('about 45 % of a 1 kg spool');
    expect(spoolWords([2, 3])).toBe('about 5 % of a 1 kg spool');
    expect(spoolWords([1200, 1500])).toBe('about 1.4 spools of 1 kg');
  });

  it("one solid's clauses: weight, filament, time", () => {
    expect(estimateWords(estimatePiece(cube(100), o))).toEqual(['about 220–270 g', 'about 72–92 m of filament', 'very roughly 8–26 hours']);
  });

  it('says that the files are solid and the slicer makes them mostly hollow', () => {
    expect(SOLID_WORDS).toMatch(/solid models/);
    expect(SOLID_WORDS).toMatch(/slicer prints them mostly hollow/);
  });
});

describe('the whole job', () => {
  const pins = [{ d: 5, length: 16, count: 4, spares: 1, own: false, volume: 280 }, { d: 1.75, length: 10, count: 6, spares: 0, own: true, volume: 0 }];
  const pieces = [piece(1, 100), { ...piece(2, 50), size: [50, 80, 120] }, piece(3, 20)];
  const parts = [{ name: 'star', volume: 2000, area: 1200, height: 4 }];
  const job = estimateJob({ pieces, pins, parts }, o, [210, 210, 249]);

  it('is the sum of its pieces, its printed pins and its parts', () => {
    const all = [...job.pieces.map((r) => r.estimate), job.pins.estimate, ...job.parts.map((r) => r.estimate)];
    for (const key of ['grams', 'metres', 'hours']) {
      for (const end of [0, 1]) expect(job.total[key][end]).toBeCloseTo(all.reduce((sum, e) => sum + e[key][end], 0), 9);
    }
    expect(job.counted).toBe(5);
    expect(job.left).toBe(0);
  });

  it('counts the printed pins with their spares, solid, and leaves out pins the user cuts', () => {
    expect(job.pins.count).toBe(5);
    expect(job.pins.estimate.plastic).toBe(5 * 280);
    expect(estimateJob({ pieces, pins: [pins[1]] }, o).pins).toBeNull();
  });

  it('names the tallest piece, the largest on the bed and the room the pieces take', () => {
    expect(job.tallest).toEqual({ index: 2, height: 120 });
    expect(job.widest).toEqual({ index: 1, size: [100, 100] });
    expect(job.beds).toBeCloseTo((100 * 100 + 50 * 80 + 20 * 20) / (210 * 210), 9);
    expect(estimateJob({ pieces }, o).beds).toBeNull();
  });

  it('says it in a few sentences, with what it assumes and leaves out', () => {
    const words = jobWords(job, o);
    expect(words[0]).toMatch(/^Whole job \(3 pieces, 5 pins and 1 separate part\): about \d+–\d+ g of PLA, about \d+–\d+ m of filament \(about \d+ % of a 1 kg spool\), very roughly \d+–\d+ hours of printing in all\.$/);
    expect(words[1]).toBe('Tallest piece: 120 mm (piece 2). Largest on the bed: 100 × 100 mm (piece 1). Side by side the pieces would cover about 35 % of your bed.');
    expect(words[2]).toBe('Worked out for PLA, 15 % infill, 2 walls, 0.2 mm layers, 0.4 mm nozzle. The time is for an ordinary printer, and is the least sure of these figures.');
    expect(words[3]).toBe("Not counted: supports, a brim, and waste from colour changes. Your slicer's figures are the real ones.");
    expect(words).toHaveLength(4);
  });

  it('more pieces than the bed takes at once are said so', () => {
    const many = estimateJob({ pieces: [1, 2, 3, 4, 5, 6].map((i) => piece(i, 150)) }, o, [210, 210, 249]);
    expect(jobWords(many, o)[1]).toContain('Side by side the pieces would cover about 3.1 times your bed.');
  });

  it('a fast printer and a slow material are named in what the time assumes', () => {
    const tpu = planOptions({ material: 'tpu', fast: true });
    expect(jobWords(estimateJob({ pieces }, tpu), tpu).join(' ')).toContain('The time is for a fast printer, slowed for TPU, and is the least sure of these figures.');
  });

  it('a piece that could not be measured is left out, and said to be; so are unrepaired parts', () => {
    const some = estimateJob({ pieces: [piece(1, 50), { index: 2, size: [10, 10, 10] }, { ...piece(3, 30), unrepaired: 4 }] }, o);
    expect(some.pieces.map((r) => r.estimate !== null)).toEqual([true, false, true]);
    expect(some.left).toBe(1);
    const words = jobWords(some, o);
    expect(words).toContain('1 file could not be measured and is left out.');
    expect(words).toContain('The parts of the model that could not be repaired are left out.');
  });

  it('nothing measured, nothing said', () => {
    const none = estimateJob({ pieces: [{ index: 1, size: [10, 10, 10] }] }, o);
    expect(none.counted).toBe(0);
    expect(jobWords(none, o)).toEqual([]);
    expect(planSheetLines({ pieces: [{ index: 1, size: [10, 10, 10] }] }, {})).toEqual([]);
    expect(planSheetLines({}, {})).toEqual([]);
  });
});

describe('a model printed whole', () => {
  it('has its estimate in a sentence, with how tall it is', () => {
    expect(wholeWords({ volume: 1e6, area: 60000, size: [100, 100, 100] }, o)).toBe(
      "Print estimate (PLA, 15 % infill, 2 walls, 0.2 mm layers, 0.4 mm nozzle): about 220–270 g, about 72–92 m of filament, very roughly 8–26 hours; 100 mm tall. Not counted: supports, a brim, and waste from colour changes. Your slicer's figures are the real ones.",
    );
  });

  it('counts its separate parts, and says what is left out of a model that could not be repaired whole', () => {
    const alone = wholeWords({ volume: 8000, area: 2400, size: [20, 20, 20] }, o);
    const withPart = wholeWords({ volume: 8000, area: 2400, size: [20, 20, 20], partial: true }, o, [{ name: 'star', volume: 8000, area: 2400, height: 20 }]);
    expect(alone).toContain('about 3.3–4.2 g');
    expect(withPart).toContain('about 6.5–8.3 g');
    expect(withPart).toContain('; 20 mm tall. Its 1 separate part is counted in.');
    expect(withPart).toContain('The parts that could not be repaired are left out.');
  });

  it('is nothing without a solid', () => {
    expect(wholeWords(null, o)).toBe('');
    expect(wholeWords({ volume: 0, area: 0, size: [0, 0, 0] }, o)).toBe('');
  });
});

describe('suggestions for the slicer', () => {
  const general = 'For a model that sits on a shelf, 2 walls and 10–15 % infill is plenty: more infill adds weight and time, and little strength. For one that will be handled a lot, 3 walls does more than extra infill.';
  const needs = (area, onPiece = 0) => ({ ...quiet, supports: { area, skin: area, seam: 0, bed: area - onPiece, piece: onPiece } });

  it('plain blocks get the general line and are told supports can be left off', () => {
    expect(adviseJob([piece(1, 50), piece(2, 50)], o)).toEqual([general, 'No piece has a face flatter than 45° that hangs free, so supports can be left off.']);
    expect(adviseJob([piece(1, 50)], o)[1]).toBe('The piece has no face flatter than 45° that hangs free, so supports can be left off.');
  });

  it('every line is a suggestion, never an order to change the model', () => {
    const all = adviseJob([piece(1, 50, { check: needs(2500) }), piece(2, 2, { pegs: 2 })], planOptions({ material: 'abs' }), { pins: [{ count: 2, own: false }], pegSize: 4 }).join(' ');
    expect(all).not.toMatch(/must|always|never/i);
  });

  it('a thin piece prints nearly solid whatever the infill', () => {
    const plate = (index) => ({ index, size: [100, 100, 2], volume: 20000, area: 20800, check: quiet });
    expect(adviseJob([plate(1), piece(2, 50)], o)).toContain('Piece 1 is thin: it prints nearly solid whatever the infill.');
    expect(adviseJob([plate(3), piece(2, 50), plate(1)], o)).toContain('Pieces 1 and 3 are thin: they print nearly solid whatever the infill.');
    expect(adviseJob([piece(2, 50)], o).join(' ')).not.toContain('thin');
  });

  it('built-in pegs print solid with enough walls; thick ones are only told to take more', () => {
    const pegged = [piece(1, 50, { pegs: 2 }), piece(2, 50, { sockets: 2 })];
    // a 4 mm peg is 2 mm to its middle: five lines of 0.42 mm
    expect(adviseJob(pegged, o, { pegSize: 4 })).toContain('Piece 1 carries built-in pegs 4 mm across: with 5 walls the pegs print solid, which makes them stronger.');
    expect(adviseJob(pegged, planOptions({ nozzle: 0.6 }), { pegSize: 4 })).toContain('Piece 1 carries built-in pegs 4 mm across: with 4 walls the pegs print solid, which makes them stronger.');
    expect(adviseJob(pegged, o, { pegSize: 8 })).toContain('Piece 1 carries built-in pegs: 4 walls makes the pegs stronger.');
    // a peg two walls already make solid, and pieces without pegs, get no line
    expect(adviseJob(pegged, o, { pegSize: 1.6 }).join(' ')).not.toContain('pegs');
    expect(adviseJob([piece(1, 50)], o, { pegSize: 4 }).join(' ')).not.toContain('pegs');
  });

  it("a brim where a piece's print check asks for one, of the width it asks for", () => {
    const risky = (brim) => ({ ...quiet, foot: { flat: true, brim } });
    const lines = adviseJob([piece(1, 50, { check: risky(5) }), piece(2, 50), piece(3, 50, { check: risky(8) }), piece(4, 50, { check: risky(5) })], o);
    expect(lines).toContain('Pieces 1 and 4: add a brim about 5 mm wide – they stand on little and may come loose.');
    expect(lines).toContain('Piece 3: add a brim about 8 mm wide – it stands on little and may come loose.');
    // a piece with nothing flat to stand on is not told to add a brim
    expect(adviseJob([piece(1, 50, { check: { ...quiet, foot: { flat: false, brim: 5 } } })], o).join(' ')).not.toContain('brim');
  });

  it("supports by the print check's own figure, and which kind is enough by where they would stand", () => {
    const lines = adviseJob([piece(1, 50, { check: needs(2500) }), piece(2, 50, { check: needs(1200, 600) }), piece(3, 50), piece(4, 50, { check: needs(700, 20) })], o);
    expect(lines).toContain('Pieces 1 and 4 may need supports (about 32 cm² of faces in all): supports "on the build plate only" should be enough.');
    expect(lines).toContain('Piece 2 may need supports (about 12 cm² of faces in all), some standing on the piece itself: allow them everywhere on that piece.');
    expect(lines).toContain('The other piece should print without supports.');
    // under the check's own limit a piece needs none
    expect(adviseJob([piece(1, 50, { check: needs(19) })], o)).toContain('The piece has no face flatter than 45° that hangs free, so supports can be left off.');
  });

  it('says nothing of supports for pieces that have no print check', () => {
    const lines = adviseJob([piece(1, 50, { check: undefined }), piece(2, 50)], o);
    expect(lines.join(' ')).not.toMatch(/supports/);
  });

  it('printed pins are told to be printed solid', () => {
    expect(adviseJob([piece(1, 50)], o, { pins: [{ d: 5, count: 4, own: false }] })).toContain('Pins: print them solid – 4 or more walls, or 100 % infill – lying as their file lies.');
    expect(adviseJob([piece(1, 50)], o, { pins: [{ d: 5, count: 4, own: true }] }).join(' ')).not.toContain('Pins:');
  });

  it('a word on the material where it matters', () => {
    const jointed = [piece(1, 50, { dowels: 2 }), piece(2, 50, { dowels: 2 })];
    expect(adviseJob(jointed, planOptions({ material: 'petg' })).join(' ')).toContain('PETG wants a little more room in the joints than PLA: a Clearance of about 0.20 mm, where PLA takes 0.15.');
    expect(adviseJob([piece(1, 50)], planOptions({ material: 'petg' })).join(' ')).not.toContain('PETG');
    expect(adviseJob(jointed, planOptions({ material: 'abs' })).join(' ')).toContain('ABS and ASA shrink as they cool, so big flat pieces may lift at the corners: a closed printer and a brim help.');
    expect(adviseJob(jointed, planOptions({ material: 'tpu' })).join(' ')).toContain('TPU is soft: pins, pegs and clips made of it bend rather than hold');
    expect(adviseJob(jointed, o).join(' ')).not.toMatch(/PETG|ABS|TPU/);
  });
});

describe('the PRINT PLAN block of the sheet', () => {
  const pieces = [piece(2, 50, { dowels: 2 }), piece(1, 100, { dowels: 2 })];
  const pins = [{ d: 5, length: 16, count: 4, spares: 1, own: false, volume: 280 }];
  const lines = planSheetLines({ pieces, pins, parts: [{ name: 'star', volume: 2000, area: 1200, height: 4 }] }, {}, [210, 210, 249]);

  it('has a heading, that the files are solid, a line a piece in order, the pins, the parts and the whole job', () => {
    expect(lines[0]).toBe('PRINT PLAN (estimates only)');
    expect(lines[1]).toBe(`  ${SOLID_WORDS}`);
    expect(lines[2]).toBe('  piece 1 of 2   about 220–270 g   about 72–92 m of filament   very roughly 8–26 hours');
    expect(lines[3]).toBe('  piece 2 of 2   about 33–42 g     about 11–14 m of filament   very roughly 1–5 hours');
    expect(lines[4]).toBe('  pins           about 1.6–2 g for 5 pins, printed solid');
    expect(lines[5]).toBe('  part 1         about 1.3–1.6 g   under 1 m of filament       under an hour');
    expect(lines[6]).toMatch(/^ {2}WHOLE JOB \(2 pieces, 5 pins and 1 separate part\): about \d+–\d+ g of PLA, /);
  });

  it('then what it assumes and leaves out, and the suggestions', () => {
    expect(lines).toContain('  Worked out for PLA, 15 % infill, 2 walls, 0.2 mm layers, 0.4 mm nozzle. The time is for an ordinary printer, and is the least sure of these figures.');
    expect(lines).toContain("  Not counted: supports, a brim, and waste from colour changes. Your slicer's figures are the real ones.");
    const at = lines.indexOf('  Suggestions for your slicer:');
    expect(at).toBeGreaterThan(6);
    expect(lines.slice(at + 1).every((l) => l.startsWith('  - '))).toBe(true);
    expect(lines.slice(at + 1)).toContain('  - No piece has a face flatter than 45° that hangs free, so supports can be left off.');
    // the pins' own line of the sheet says how to print them: not said twice
    expect(lines.join('\n')).not.toContain('Pins: print them solid');
  });

  it('is for the material and infill given', () => {
    const petg = planSheetLines({ pieces }, { material: 'petg', infill: 40, fast: true }).join('\n');
    expect(petg).toContain('of PETG');
    expect(petg).toContain('Worked out for PETG, 40 % infill, 2 walls');
    expect(petg).toContain('The time is for a fast printer, slowed for PETG');
    expect(petg).toContain('PETG wants a little more room in the joints');
  });
});
