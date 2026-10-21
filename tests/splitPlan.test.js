import { describe, expect, it } from 'vitest';
import {
  AUTO_DIAMETERS, AXES, BED_DEFAULTS, BED_PRESETS, CUT_COLOR, CUT_TOLERANCE, FILAMENT, HOLE_SEGMENTS, JOINTS, ORIENT_MODES, PIN_DIAMETERS,
  POLYGON_K, SPLIT_KEEP_TRIANGLES, TOO_BIG_COLOR, translationMat4, transposeMat4, DIRECTIONS, LAY_DOWN, PIECE_COLORS, PIN_COLOR, PLAN_WEIGHTS, SPLIT_DEFAULTS, SPLIT_LIMITS,
  SPLIT_NOTE_CODES, SplitError, TO_PLANE, TO_WORLD, YAW90, applyMat4, applyToSoup, assemblySteps, axisCuts, bedSize, cellOf,
  cellFits, cellOfPoint, cellSizes, chooseCentres, chooseOffsets, chooseOrientation, clipSoupByPlane, clippedArea, cutPlane, dirAxis, dirOf,
  dovetailSize, evenCell, explodeOffset, fitsBed, footprintYaw, formatSize, glueFileName, gridCandidates, gridCounts, gridPoints,
  howToGlueText, invertRigid, isSymmetric, letterFor, localFrame, maxCellLength, mulMat4, nextCut, noSeatWords, normaliseSplit, offsetAlongRay,
  oppositeDir, orientationStats, partFileName, pieceColorIndex, pieceFileName, pinsFileName, planAllowance, planCost, planGrid,
  planSamples, plateAxis, polygonsArea, polygonsCentroid, printTransform, safeFileName, cellSupport, fitPieces, flatProbes, liesFlat, statsWithSoup,
  sizesFor, sizesForRoom, soupCells, splitActive, splitNote, teardropApex, usableBed, yawMat4, zipFileName, triangleInBox, baseAxis,
  outlineColumns, pieceHolding, textNotes, AUTO_PEGS, SMALLEST_PEG, layPegged, pegAllowance, pegMales, pegSides, pegSizeOf, pegSizesFor,
  pegSizesForRoom, statsWithPegs, uprightPegNotes, APART_COLOR, APART_HOLDS, CLIP, LIP, LIP_ALLOWANCE, apartMales, catchSizes,
  clipHold, clipPush, clipShape, layGrown, lipReach, lipSides, lipSizesFor, statsWithLip, SPOT, comesOffOf, endBeds, endShape, endsAsWell, keepsTo, lipMale,
  locateBend, locateSeam, pickSpots, profileSeams, seamKind, seamWords, snapTarget, spotScore, spotSide, spotStart, spotWhy, socketsAsWell,
  printedFace, printedRow, wayAt, waySteps, wayStep,
} from '../src/split.js';

const U = [210, 210, 249]; // the default printer's usable bed
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const det3 = (m) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
const closeVec = (v, w, digits = 9) => v.forEach((x, i) => expect(x).toBeCloseTo(w[i], digits));
const bounds300 = { min: [-150, -20, 0], max: [150, 20, 20] };

describe('bed', () => {
  it('keeps the margin clear on every side and 1 mm under the top', () => {
    expect(usableBed()).toEqual([210, 210, 249]);
    expect(usableBed(BED_DEFAULTS)).toEqual([210, 210, 249]);
    expect(usableBed({ preset: 'mk4s', margin: 5 })).toEqual([240, 200, 219]);
    expect(usableBed({ preset: 'custom', size: [300, 200, 100], margin: 0 })).toEqual([300, 200, 99]);
    expect(usableBed({ preset: 'generic', margin: 'lots' })).toEqual([210, 210, 249]);
    expect(usableBed({ preset: 'generic', margin: 50 })).toEqual([180, 180, 249]); // the margin is capped at 20
  });

  it('takes a preset’s size over a stale typed one, and the typed size for custom', () => {
    expect(bedSize({ preset: 'a1mini', size: [999, 999, 999] })).toEqual([180, 180, 180]);
    expect(bedSize({ preset: 'custom', size: [123, 45, 67] })).toEqual([123, 45, 67]);
    expect(bedSize({ preset: 'custom', size: [123, 'x', null] })).toEqual([123, 220, 250]);
    expect(bedSize({ preset: 'custom', size: [0, -5, ''] })).toEqual([220, 220, 250]);
    expect(bedSize({ preset: 'nope' })).toEqual([220, 220, 250]);
    expect(Object.keys(BED_PRESETS)).toEqual(['generic', 'a1mini', 'bambu256', 'mk4s', 'coreone', 'coreonel', 'custom']);
    expect(BED_PRESETS.generic.size).toEqual([220, 220, 250]);
  });
});

describe('normaliseSplit', () => {
  it('clamps every setting to its range and fills in defaults', () => {
    const { spec } = normaliseSplit({ joint: 'glue', diameter: 7.2, depth: 50, clearance: 0.9, count: 9, pins: 'x', orient: 'x', labels: 'yes' });
    expect(spec).toEqual({ joint: 'auto', diameter: 8, depth: 30, clearance: 0.5, count: 6, pins: 'print', orient: 'auto', labels: true });
    const low = normaliseSplit({ diameter: -3, depth: 1, clearance: -1, count: 2.4, labels: false }).spec;
    expect(low).toMatchObject({ diameter: 0, depth: 3, clearance: 0, count: 2, labels: false });
    const { cuts, ...defaults } = SPLIT_DEFAULTS;
    expect(cuts).toEqual([]);
    expect(normaliseSplit(null).spec).toEqual(defaults);
    expect(normaliseSplit({ diameter: 5.4 }).spec.diameter).toBe(5);
    expect(normaliseSplit({ diameter: 2 }).spec.diameter).toBe(1.75);
  });

  it('1.75 mm filament forces own pins', () => {
    expect(normaliseSplit({ diameter: 1.75, pins: 'print' }).spec.pins).toBe('own');
    expect(normaliseSplit({ diameter: 6, pins: 'own' }).spec.pins).toBe('own');
    expect(normaliseSplit({ diameter: 6, pins: 'print' }).spec.pins).toBe('print');
  });

  it('snaps a normal with float noise to its axis', () => {
    const { cuts, notes } = normaliseSplit({ cuts: [{ id: 'c1', position: [1, 2, 3], normal: [6e-17, 0, 1] }] }, bounds300);
    expect(cuts).toEqual([{ id: 'c1', letter: 'A', axis: 2, at: 3 }]);
    expect(notes).toEqual([]);
    // the sign of the normal does not matter for a full plane
    expect(normaliseSplit({ cuts: [{ id: 'c1', position: [7, 0, 0], normal: [-1, 0, 0] }] }, bounds300).cuts[0]).toMatchObject({ axis: 0, at: 7 });
  });

  it('leaves out a tilted cut with CUT_NOT_STRAIGHT', () => {
    const { cuts, notes } = normaliseSplit({ cuts: [{ id: 'c1', position: [0, 0, 0], normal: [0.7, 0.7, 0] }] }, bounds300);
    expect(cuts).toEqual([]);
    expect(notes).toEqual([expect.objectContaining({ level: 'warn', code: 'CUT_NOT_STRAIGHT', cutId: 'c1', letter: 'A', text: 'Cut A isn\'t straight along X, Y or Z and was left out.' })]);
  });

  it('drops cuts within 0.01 mm of the bounds with CUT_MISSES and the letter', () => {
    const cut = (id, x) => ({ id, position: [x, 0, 0], normal: [1, 0, 0] });
    const { cuts, notes } = normaliseSplit({ cuts: [cut('c1', 149.995), cut('c2', 149.98), cut('c3', -150.5), cut('c4', -149.995)] }, bounds300);
    expect(cuts.map((c) => c.id)).toEqual(['c2']);
    expect(notes.map((n) => [n.code, n.cutId, n.letter])).toEqual([['CUT_MISSES', 'c1', 'A'], ['CUT_MISSES', 'c3', 'C'], ['CUT_MISSES', 'c4', 'D']]);
    expect(notes[0].text).toBe('Cut A doesn\'t cross the model – it cuts nothing.');
  });

  it('merges cuts in the same place with CUTS_MERGED, keeping the first in the list', () => {
    const { cuts, notes } = normaliseSplit({
      cuts: [
        { id: 'c1', position: [0, 0.005, 0], normal: [0, 1, 0] },
        { id: 'c2', position: [0, 0, 0], normal: [0, -1, 0] },
        { id: 'c3', position: [20, 0, 0], normal: [1, 0, 0] },
      ],
    }, bounds300);
    expect(cuts).toEqual([{ id: 'c3', letter: 'C', axis: 0, at: 20 }, { id: 'c1', letter: 'A', axis: 1, at: 0.005 }]);
    expect(notes).toEqual([expect.objectContaining({ level: 'info', code: 'CUTS_MERGED', letters: ['A', 'B'], cutIds: ['c1', 'c2'], text: 'Cuts A and B were in the same place; one was used.' })]);
  });

  it('puts the cuts in canonical order (x, y, z, then position) and they keep their letters', () => {
    const { cuts, grid } = normaliseSplit({
      cuts: [
        { id: 'c1', position: [0, 0, 5], normal: [0, 0, 1] },
        { id: 'c2', position: [10, 0, 0], normal: [1, 0, 0] },
        { id: 'c3', position: [-10, 0, 0], normal: [1, 0, 0] },
        { id: 'c4', position: [0, 0, 0], normal: [0, 1, 0] },
      ],
    }, bounds300);
    expect(cuts.map((c) => `${c.letter}:${c.axis}:${c.at}`)).toEqual(['C:0:-10', 'B:0:10', 'D:1:0', 'A:2:5']);
    expect(grid).toEqual([2, 1, 1]);
  });

  it('throws SPLIT_INVALID for 13 cuts or more than 64 pieces', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ id: `c${i + 1}`, position: [-120 + i * 20, 0, 0], normal: [1, 0, 0] }));
    expect(() => normaliseSplit({ cuts: many }, bounds300)).toThrow(SplitError);
    try {
      normaliseSplit({ cuts: many }, bounds300);
    } catch (e) {
      expect(e.code).toBe('SPLIT_INVALID');
    }
    expect(normaliseSplit({ cuts: many.slice(0, 12) }, bounds300).cuts).toHaveLength(12);
    // 4 cuts on each axis: 12 cuts but 125 pieces
    const box = { min: [-50, -50, -50], max: [50, 50, 50] };
    const grid = [0, 1, 2].flatMap((a) => [-30, -10, 10, 30].map((t, i) => ({ id: `${a}${i}`, position: [0, 0, 0].map((_, k) => (k === a ? t : 0)), normal: [0, 0, 0].map((_, k) => (k === a ? 1 : 0)) })));
    expect(() => normaliseSplit({ cuts: grid }, box)).toThrow(expect.objectContaining({ code: 'SPLIT_INVALID' }));
  });

  it('with no cuts left it keeps the notes and returns no cuts', () => {
    const r = normaliseSplit({ cuts: [{ id: 'c1', position: [500, 0, 0], normal: [1, 0, 0] }] }, bounds300);
    expect(r.cuts).toEqual([]);
    expect(r.grid).toEqual([0, 0, 0]);
    expect(r.notes.map((n) => n.code)).toEqual(['CUT_MISSES']);
    expect(splitActive({ cuts: [] })).toBe(false);
    expect(splitActive(null)).toBe(false);
    expect(splitActive({ cuts: [{}] })).toBe(true);
  });

  it('reads stored and normalised cuts alike', () => {
    expect(cutPlane({ position: [1, 2, 3], normal: [0, 1, 0] })).toEqual({ axis: 1, at: 2 });
    expect(cutPlane({ axis: 2, at: 4 })).toEqual({ axis: 2, at: 4 });
    expect(cutPlane({ position: [1, 2, 3], normal: [1, 1, 0] })).toBeNull();
    expect(axisCuts([{ axis: 0, at: 5 }, { position: [-3, 0, 0], normal: [1, 0, 0] }, { position: [0, 0, 0], normal: [1, 1, 1] }])).toEqual([[-3, 5], [], []]);
    // with bounds, misses and near-duplicates are dropped
    expect(axisCuts([{ axis: 0, at: 5 }, { axis: 0, at: 5.001 }, { axis: 0, at: 400 }], bounds300)).toEqual([[5], [], []]);
  });
});

describe('normaliseSplit with parts that come off', () => {
  const Z = [0, 0, 1];
  // the bat lantern at 400 %, standing on z 0
  const lantern = { min: [-48.6, -49, 0], max: [48.6, 49, 200] };
  const lid = (id, z, extra = {}) => ({ id, position: [-0.0196, 0.0444, z], normal: Z, joint: 'apart', hold: 'lock', part: { r: 31.58, side: 1, auto: true }, ...extra });
  const cut = (id, z, extra = {}) => ({ id, position: [0, 0, z], normal: Z, ...extra });

  it('parts come out apart from the cuts: no plane of the grid, in the order listed, each with its letter', () => {
    const split = {
      cuts: [
        cut('c1', 150, { joint: 'apart', hold: 'snap' }),
        lid('c2', 115.6),
        cut('c3', 60),
        { id: 'c4', position: [0, 0, 0], normal: Z, joint: 'apart', hold: 'lift', part: { r: 28.7, side: 1, auto: false } },
      ],
    };
    const r = normaliseSplit(split, lantern);
    expect(r.cuts).toEqual([{ id: 'c3', letter: 'C', axis: 2, at: 60 }, { id: 'c1', letter: 'A', axis: 2, at: 150, apart: { hold: 'snap' } }]);
    expect(r.parts).toEqual([
      { id: 'c2', letter: 'B', axis: 2, at: 115.6, centre: [-0.0196, 0.0444], r: 31.58, side: 1, hold: 'lock', auto: true },
      { id: 'c4', letter: 'D', axis: 2, at: 0, centre: [0, 0], r: 28.7, side: 1, hold: 'lift', auto: false },
    ]);
    expect(r.notes).toEqual([]);
    expect(r.grid).toEqual([0, 0, 2]);
    // a base asked for a tea-light seat says so; a seat switched off, or never asked for, is no seat
    const seated = (seat) => normaliseSplit({ cuts: [{ ...split.cuts[3], part: { ...split.cuts[3].part, seat } }] }, lantern).parts[0];
    expect(seated(true)).toEqual({ id: 'c4', letter: 'A', axis: 2, at: 0, centre: [0, 0], r: 28.7, side: 1, hold: 'lift', auto: false, seat: true });
    expect(seated(false)).not.toHaveProperty('seat');
    expect(seated('yes')).not.toHaveProperty('seat');
    // the cuts, the grid and the settings are what they are with no parts at all (listed last, so no letter changes)
    const listed = [split.cuts[0], split.cuts[2], split.cuts[1], split.cuts[3]];
    const without = normaliseSplit({ cuts: listed.slice(0, 2) }, lantern);
    expect(without.parts).toEqual([]);
    expect({ ...normaliseSplit({ cuts: listed }, lantern), parts: [] }).toEqual(without);
  });

  it('a part at a full cut\'s height, or at another part\'s, is never merged with it', () => {
    const r = normaliseSplit({ cuts: [cut('c1', 115.6, { joint: 'apart', hold: 'lock' }), lid('c2', 115.6), lid('c3', 115.604), cut('c4', 115.605)] }, lantern);
    expect(r.cuts.map((c) => c.id)).toEqual(['c1']);
    expect(r.parts.map((p) => [p.id, p.at])).toEqual([['c2', 115.6], ['c3', 115.604]]);
    expect(r.notes).toEqual([expect.objectContaining({ code: 'CUTS_MERGED', cutIds: ['c1', 'c4'] })]);
  });

  it('parts count against the 12 cuts but make no cells', () => {
    const box = { min: [-50, -50, -50], max: [50, 50, 50] };
    // 3 cuts on each axis: 9 cuts and 64 cells, the most there may be
    const grid = [0, 1, 2].flatMap((a) => [-20, 0, 20].map((t, i) => ({ id: `g${a}${i}`, position: [0, 0, 0].map((_, k) => (k === a ? t : 0)), normal: [0, 0, 0].map((_, k) => (k === a ? 1 : 0)) })));
    const parts = [10, 30, 40, 45].map((z, i) => ({ ...lid(`p${i}`, z), part: { r: 5, side: 1, auto: true } }));
    const ok = normaliseSplit({ cuts: [...grid, ...parts.slice(0, 3)] }, box);
    expect([ok.cuts.length, ok.parts.length, ok.grid]).toEqual([9, 3, [3, 3, 3]]);
    expect(() => normaliseSplit({ cuts: [...grid, ...parts] }, box)).toThrow(expect.objectContaining({ code: 'SPLIT_INVALID', details: { cuts: 13, cells: 64 } }));
    expect(() => normaliseSplit({ cuts: Array.from({ length: 13 }, (_, i) => lid(`c${i + 1}`, 10 + i)) }, lantern)).toThrow(SplitError);
    expect(normaliseSplit({ cuts: Array.from({ length: 12 }, (_, i) => lid(`c${i + 1}`, 10 + i)) }, lantern).parts).toHaveLength(12);
  });

  it('with no parts, the output is what it was before parts: the same cuts, notes, grid and settings, and no parts', () => {
    const X = [1, 0, 0];
    const bounds = { min: [-55, -55, 0], max: [55, 55, 291] };
    const split = {
      joint: 'pegs',
      clearance: 0.2,
      cuts: [
        { id: 'c1', position: [0, 0, 190], normal: Z, joint: 'apart', hold: 'lock' },
        { id: 'c2', position: [0, 0, 100], normal: [0, 0, -1] },
        { id: 'c3', position: [0, 0, 100.004], normal: Z, joint: 'apart', hold: 'lift' },
        { id: 'c4', position: [10, 0, 0], normal: X, joint: 'apart', hold: 'firm' },
        { id: 'c5', position: [0, 0, 0], normal: [0.7, 0.7, 0] },
        { id: 'c6', position: [0, 0, 300], normal: Z },
        { id: 'c7', axis: 1, at: -20 },
      ],
    };
    // normaliseSplit's whole output for this split at c97a1b5, before parts
    const before = {
      spec: { joint: 'pegs', diameter: 0, depth: 0, clearance: 0.2, count: 0, pins: 'print', orient: 'auto', labels: true },
      cuts: [
        { id: 'c4', letter: 'D', axis: 0, at: 10, apart: { hold: 'snap' } },
        { id: 'c7', letter: 'G', axis: 1, at: -20 },
        { id: 'c2', letter: 'B', axis: 2, at: 100, apart: { hold: 'lift' } },
        { id: 'c1', letter: 'A', axis: 2, at: 190, apart: { hold: 'lock' } },
      ],
      notes: [
        { level: 'warn', code: 'CUT_NOT_STRAIGHT', text: 'Cut E isn\'t straight along X, Y or Z and was left out.', cutId: 'c5', letter: 'E' },
        { level: 'warn', code: 'CUT_MISSES', text: 'Cut F doesn\'t cross the model – it cuts nothing.', cutId: 'c6', letter: 'F' },
        { level: 'info', code: 'CUTS_MERGED', text: 'Cuts B and C were in the same place; one was used.', cutIds: ['c2', 'c3'], letters: ['B', 'C'] },
      ],
      grid: [1, 1, 2],
    };
    expect(normaliseSplit(split, bounds)).toEqual({ ...before, parts: [] });
  });

  it('a part\'s side and centre are read in its plane\'s frame, whichever way its normal points; a tilted one is left out', () => {
    // mirrored or turned over, the dome lies below its plane
    const down = normaliseSplit({ cuts: [{ ...lid('c1', -115.6), normal: [0, 0, -1] }] }, { min: [-48.6, -49, -200], max: [48.6, 49, 0] });
    expect(down.parts[0]).toMatchObject({ axis: 2, at: -115.6, side: -1 });
    expect(normaliseSplit({ cuts: [{ ...lid('c1', 115.6), part: { r: 31.58, side: -1 } }] }, lantern).parts[0]).toMatchObject({ side: -1, auto: false });
    // turned a quarter about X, the part lies along −Y: the plane is across Y, and its (u, v) are (z, x), as TO_PLANE reads them
    const turned = normaliseSplit({ cuts: [{ ...lid('c1', 0), position: [-0.0196, -115.6, 0.0444], normal: [0, -1, 0] }] }, { min: [-48.6, -200, -49], max: [48.6, 0, 49] });
    expect(turned.parts).toEqual([{ id: 'c1', letter: 'A', axis: 1, at: -115.6, centre: [0.0444, -0.0196], r: 31.58, side: -1, hold: 'lock', auto: true }]);
    expect(applyMat4(TO_PLANE[1], [-0.0196, -115.6, 0.0444]).slice(0, 2)).toEqual(turned.parts[0].centre);
    const across = normaliseSplit({ cuts: [{ ...lid('c1', 0), position: [30, 1, 2], normal: [1, 0, 0] }] }, lantern).parts[0];
    expect(across).toMatchObject({ axis: 0, at: 30, centre: [1, 2], side: 1 });
    expect(applyMat4(TO_PLANE[0], [30, 1, 2]).slice(0, 2)).toEqual(across.centre);
    const tilted = normaliseSplit({ cuts: [{ ...lid('c1', 100), normal: [0, 0.6, 0.8] }] }, lantern);
    expect([tilted.parts, tilted.cuts, tilted.notes.map((n) => [n.code, n.letter])]).toEqual([[], [], [['CUT_NOT_STRAIGHT', 'A']]]);
  });

  it('a part may stand on the model\'s own end, as a base taken out from below; one that takes nothing out is left out with CUT_MISSES', () => {
    const base = (z, side = 1, xy = [0, 0], r = 28.7) => ({ id: 'c1', position: [...xy, z], normal: Z, joint: 'apart', part: { r, side, auto: true } });
    const kept = (c) => normaliseSplit({ cuts: [c] }, lantern).parts.length === 1;
    const missed = (c) => {
      const r = normaliseSplit({ cuts: [c] }, lantern);
      return r.parts.length === 0 && r.cuts.length === 0 && r.notes.map((n) => n.code).join() === 'CUT_MISSES';
    };
    expect(kept(base(0))).toBe(true);
    expect(kept(base(-0.005))).toBe(true);
    expect(missed(base(-0.02))).toBe(true); // in the air under the model
    expect(missed(base(0, -1))).toBe(true); // nothing under the bottom
    expect(missed(base(0.005, -1))).toBe(true);
    expect(kept(base(0.02, -1))).toBe(true);
    // the same at the top: a part may be taken out downwards from the model's top, never upwards
    expect(kept(base(200, -1))).toBe(true);
    expect(kept(base(200.005, -1))).toBe(true);
    expect(missed(base(200.02, -1))).toBe(true);
    expect(missed(base(200))).toBe(true);
    expect(missed(base(199.995))).toBe(true);
    expect(kept(base(199.98))).toBe(true);
    // a circle beside the model misses it; one that reaches into its box is kept
    expect(missed(base(100, 1, [48.6 + 30, 0], 30))).toBe(true);
    expect(kept(base(100, 1, [48.6 + 29.9, 0], 30))).toBe(true);
    expect(missed(base(100, 1, [48.6 + 21.21, 49 + 21.22], 30))).toBe(true); // off the corner, diagonally
    expect(kept(base(100, 1, [48.6 + 21.2, 49 + 21.2], 30))).toBe(true);
    expect(missed({ ...base(100), position: [0, Number.NaN, 100] })).toBe(true);
    // across X the circle lies in (y, z): high up the lantern's side it is on the model, past its top it is not
    const side = (z) => ({ ...base(0), position: [30, 0, z], normal: [1, 0, 0], part: { r: 10, side: 1 } });
    expect(kept(side(150))).toBe(true);
    expect(missed(side(215))).toBe(true);
    // with no bounds nothing is checked against the model
    expect(normaliseSplit({ cuts: [base(500)] }).parts).toHaveLength(1);
  });

  it('a part is read as the document keeps it: only on a cut that comes apart, with a radius, twist-locked unless it lifts off; a normalised part reads as itself', () => {
    const r = normaliseSplit({
      cuts: [
        cut('c1', 100, { part: { r: 5, side: 1 } }), // glued: a cut across the whole model
        cut('c2', 110, { joint: 'apart', hold: 'snap', part: { r: 0 } }),
        cut('c3', 120, { joint: 'apart', hold: 'snap', part: { r: 5, side: -7, auto: 'yes' } }),
        cut('c4', 130, { joint: 'apart', part: { r: '6' } }),
      ],
    }, lantern);
    expect(r.cuts).toEqual([{ id: 'c1', letter: 'A', axis: 2, at: 100 }, { id: 'c2', letter: 'B', axis: 2, at: 110, apart: { hold: 'snap' } }]);
    expect(r.parts).toEqual([
      { id: 'c3', letter: 'C', axis: 2, at: 120, centre: [0, 0], r: 5, side: -1, hold: 'lock', auto: false },
      { id: 'c4', letter: 'D', axis: 2, at: 130, centre: [0, 0], r: 6, side: 1, hold: 'lock', auto: false },
    ]);
    const once = normaliseSplit({ cuts: [lid('c1', 115.6), { ...lid('c2', -115.6), normal: [0, 0, -1], hold: 'lift' }] }, null).parts;
    expect(normaliseSplit({ cuts: once }, null).parts).toEqual(once);
    expect(once.map((p) => [p.side, p.hold])).toEqual([[1, 'lock'], [-1, 'lift']]);
  });
});

describe('letterFor', () => {
  it('gives A–Z, then AA…', () => {
    expect(letterFor(0)).toBe('A');
    expect(letterFor(25)).toBe('Z');
    expect(letterFor(26)).toBe('AA');
    expect(letterFor(27)).toBe('AB');
    expect(letterFor(51)).toBe('AZ');
    expect(letterFor(52)).toBe('BA');
  });
});

describe('frames', () => {
  it('TO_PLANE · TO_WORLD is the identity, exactly', () => {
    for (let a = 0; a < 3; a++) {
      expect(mulMat4(TO_PLANE[a], TO_WORLD[a])).toEqual(IDENTITY);
      expect(mulMat4(TO_WORLD[a], TO_PLANE[a])).toEqual(IDENTITY);
      expect(det3(TO_PLANE[a])).toBe(1);
      // w (plane z) runs along the cut's axis
      const e = [0, 0, 0];
      e[a] = 1;
      expect(applyMat4(TO_PLANE[a], e)).toEqual([0, 0, 1]);
    }
    expect(applyMat4(TO_PLANE[0], [1, 2, 3])).toEqual([2, 3, 1]); // x → (y, z, x)
    expect(applyMat4(TO_PLANE[1], [1, 2, 3])).toEqual([3, 1, 2]); // y → (z, x, y)
  });

  it('each LAY_DOWN is an exact turn (det +1) that puts its side on the bed', () => {
    for (const [dir, m] of Object.entries(LAY_DOWN)) {
      expect(det3(m)).toBe(1);
      for (const v of m) expect([-1, 0, 1]).toContain(v);
      expect(applyMat4(m, DIRECTIONS[dir])).toEqual([0, 0, -1]);
    }
    expect(Object.keys(LAY_DOWN).sort()).toEqual(Object.keys(DIRECTIONS).sort());
    expect(applyMat4(YAW90, [1, 0, 0])).toEqual([0, 1, 0]);
    expect(det3(YAW90)).toBe(1);
    expect(yawMat4(90)).toEqual([...YAW90]);
    expect(yawMat4(0)).toEqual(IDENTITY);
  });

  it('localFrame gives det +1 signed permutations with its z and y where asked', () => {
    let count = 0;
    for (const z of Object.keys(DIRECTIONS)) {
      for (const y of Object.keys(DIRECTIONS)) {
        if (dirAxis(y) === dirAxis(z)) continue;
        const m = localFrame(z, y);
        expect(det3(m)).toBe(1);
        for (const v of m.slice(0, 12)) expect([-1, 0, 1]).toContain(v);
        expect(applyMat4(m, [0, 0, 1])).toEqual([...DIRECTIONS[z]]);
        expect(applyMat4(m, [0, 1, 0])).toEqual([...DIRECTIONS[y]]);
        count++;
      }
    }
    expect(count).toBe(24);
    // vectors are snapped to their axes; a y along z is replaced (+y for a z along Z, else +z); origin moves it
    const m = localFrame([1e-9, 0, -1], [0, 0, 1], [5, 6, 7]);
    expect(applyMat4(m, [0, 0, 1])).toEqual([5, 6, 6]);
    expect(applyMat4(m, [0, 1, 0])).toEqual([5, 7, 7]);
    expect(applyMat4(localFrame('+x'), [0, 1, 0])).toEqual([0, 0, 1]);
  });

  it('inverts a rigid transform and names directions', () => {
    const m = mulMat4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, -4, 5, 1], yawMat4(40));
    const p = [7, -2, 11];
    closeVec(applyMat4(invertRigid(m), applyMat4(m, p)), p, 12);
    expect(dirOf([0, -0.9, 0.1])).toBe('-y');
    expect(oppositeDir('-z')).toBe('+z');
    expect(dirAxis('+y')).toBe(1);
  });
});

describe('sizesFor', () => {
  it('Ø6 with 0.15 clearance and a 0.4 nozzle', () => {
    const s = sizesFor(6, 0.15, 0.4, 0);
    expect(s).toMatchObject({ d: 6, r: 3, depth: 9.5, h: 10, wall: 2.4, ch: 0.5, sMin: 18, pinLength: 19, pinChamfer: 0.4 });
    expect(s.R).toBeCloseTo(3.15, 9);
    expect(s.reach).toBeCloseTo(15.56, 9);
    expect(s.a).toBeCloseTo(3.668, 3);
    expect(s.rho).toBeCloseTo(6.07, 2);
    expect(s.rhoTear).toBeCloseTo(7.59, 2);
    expect(s.minDepth).toBeCloseTo(3.6, 9);
  });

  it('matches the table for Ø5 and filament, and honours a set depth', () => {
    const five = sizesFor(5);
    expect(five).toMatchObject({ depth: 8, h: 8.5, wall: 2, sMin: 15, minDepth: 3, pinLength: 16 });
    expect(five.reach).toBeCloseTo(13.16, 9);
    expect(five.a).toBeCloseTo(3.165, 3);
    expect(five.rho).toBeCloseTo(5.165, 3);
    expect(five.rhoTear).toBeCloseTo(6.48, 2);
    const fil = sizesFor(1.75);
    expect(fil).toMatchObject({ depth: 4, h: 4.5, ch: 0.3, wall: 1.2, sMin: 5.25 });
    expect(fil.reach).toBeCloseTo(6.74, 2);
    expect(fil.rho).toBeCloseTo(2.53, 2);
    expect(fil.rhoTear).toBeCloseTo(3.08, 2);
    expect(sizesFor(5, 0.15, 0.4, 12)).toMatchObject({ depth: 12, h: 12.5, pinLength: 24 });
    expect(sizesFor(5, 0.15, 0.8, 0).wall).toBeCloseTo(2.4, 9); // three nozzle widths
  });

  it('caps the depth to the room behind a face, or gives up under the minimum', () => {
    expect(sizesForRoom(5, 0.15, 0.4, 0, 20).depth).toBe(8);
    const capped = sizesForRoom(5, 0.15, 0.4, 0, 10);
    expect(capped.depth).toBeCloseTo(4.8, 9);
    expect(capped.h + capped.R + capped.wall).toBeLessThanOrEqual(10);
    expect(sizesForRoom(5, 0.15, 0.4, 0, 7)).toBeNull();
  });

  it('gives a teardrop point when the piece prints the hole lying down', () => {
    expect(teardropApex('+z', 0)).toEqual([0, 0, 1]);
    expect(teardropApex('-y', 2)).toEqual([0, -1, 0]);
    expect(teardropApex('+x', 0)).toBeNull();
  });
});

describe('fitsBed', () => {
  it('a 240 × 40 × 20 bar fits a 210 × 210 bed turned 40°', () => {
    const r = fitsBed([240, 40, 20], U);
    expect(r).toMatchObject({ fits: true, yaw: 40, height: 20, down: '-z' });
    const c = Math.cos((40 * Math.PI) / 180);
    const s = Math.sin((40 * Math.PI) / 180);
    expect(240 * c + 40 * s).toBeCloseTo(209.6, 1);
    expect(240 * s + 40 * c).toBeCloseTo(184.9, 1);
    expect(footprintYaw(240, 40, U)).toBe(40);
  });

  it('a 260 mm bar fits only on its 20 mm side, turned 41°; nothing 40 mm square that long fits', () => {
    expect(fitsBed([260, 40, 20], U)).toMatchObject({ fits: true, down: '-y', height: 40, yaw: 41 });
    expect(fitsBed([260, 40, 40], U).fits).toBe(false);
    expect(footprintYaw(260, 40, U)).toBeNull();
  });

  it('a 40 × 220 piece fits a 240 × 200 bed turned 90°', () => {
    expect(fitsBed([40, 220, 20], usableBed({ preset: 'mk4s', margin: 5 }))).toMatchObject({ fits: true, yaw: 90, height: 20 });
    expect(fitsBed([40, 220, 20], U)).toMatchObject({ fits: true, yaw: 31 }); // the square bed needs the diagonal
  });

  it('a tower taller than the bed does not fit', () => {
    expect(fitsBed([40, 40, 260], U)).toEqual({ fits: false, down: null, height: null, yaw: null, footprint: null });
  });

  it('a piece held flat may not stand on its edge to fit', () => {
    // a 260 × 40 × 5 strip fits only standing on its 40 mm edge, turned 45°
    expect(fitsBed([260, 40, 5], U)).toMatchObject({ fits: true, down: '-y' });
    expect(fitsBed([260, 40, 5], U, { flat: 2 }).fits).toBe(false);
    expect(fitsBed([200, 5, 120], U, { flat: 1 })).toMatchObject({ fits: true, down: '-y', height: 5 });
    expect(maxCellLength([150, 100, 5], 0, U, { flat: 2 })).toBeCloseTo(210, 6);
    expect(maxCellLength([150, 100, 5], 0, U)).toBeGreaterThan(280); // on its edge, across the diagonal
  });
});

describe('thin plates', () => {
  it('a plate is at most 10 mm thick and four times as wide both ways', () => {
    expect(plateAxis([400, 100, 4])).toBe(2);
    expect(plateAxis([300, 5, 260])).toBe(1);
    expect(plateAxis([588, 61.6, 1.5])).toBe(2);
    expect(plateAxis([300, 40, 20])).toBeNull(); // too thick
    expect(plateAxis([300, 30, 8])).toBeNull(); // too narrow: a bar
  });

  it('dovetail tabs grow with the plate up to a 12 mm neck, and reach as far past the cut', () => {
    expect(dovetailSize(100)).toMatchObject({ N: 12, H: expect.closeTo(16.8, 9), E: 12, count: 2 });
    expect(dovetailSize(80)).toMatchObject({ N: expect.closeTo(9.6, 9), E: expect.closeTo(9.6, 9), count: 2 });
    expect(dovetailSize(30)).toMatchObject({ N: 6, count: 1 });
    expect(dovetailSize(12)).toBeNull(); // shorter than a head and its margins
  });

  it('counts the pieces of a thin plate lying flat, with a tab’s length past every cut', () => {
    const sign = [400, 100, 4];
    expect(planAllowance(sign)).toEqual({ flat: 2, grow: [12, 12, 0] });
    expect(planAllowance(sign, { joint: 'dowels' })).toEqual({ flat: 2, grow: [0, 0, 0] });
    expect(planAllowance(sign, {}, { passthrough: true })).toEqual({ flat: 2, grow: [0, 0, 0] });
    expect(planAllowance([300, 40, 20])).toEqual({ flat: null, grow: [0, 0, 0] });
    // two halves of 200 mm would be 212 mm with their tabs: three pieces it is
    expect(gridCounts(sign, U).pieces).toBe(2);
    expect(gridCounts(sign, U, planAllowance(sign))).toEqual({ pieces: 3, candidates: [[2, 0, 0]] });
    expect(evenCell(sign, [2, 0, 0], [12, 12, 0])).toEqual([(400 + 48) / 3, 100, 4]);
    // a 480 mm square plate: 2 × 2 fits only stood on edge, flat with tabs it takes 3 × 3
    expect(gridCounts([480, 480, 5], U).pieces).toBe(4);
    expect(gridCounts([480, 480, 5], U, planAllowance([480, 480, 5]))).toEqual({ pieces: 9, candidates: [[2, 2, 0]] });
    expect(gridCandidates([300, 40, 20], U).map((c) => c.pieces).slice(0, 3)).toEqual([2, 3, 4]);
  });

  it('never cuts a plate through its thickness: a 400 mm square sign is 3 × 3 flat pieces, not 8 glued layers', () => {
    // two ways across would make 212 mm halves with their tabs; a cut through the 4 mm would let them drop the tabs
    expect(gridCandidates([400, 400, 4], U, { flat: 2 }).every((c) => c.k[2] === 0)).toBe(true);
    expect(gridCounts([400, 400, 4], U, planAllowance([400, 400, 4]))).toEqual({ pieces: 9, candidates: [[2, 2, 0]] });
    expect(fitPieces([400, 400, 4], U)).toEqual({ fits: false, pieces: 9, down: null, yaw: null });
  });

  it('counts what Fit will plan, from the box alone: plates flat with their tabs, and how a model that fits must lie', () => {
    expect(fitPieces([400, 100, 5], U)).toMatchObject({ fits: false, pieces: 3 });
    expect(fitPieces([400, 100, 5], U, { joint: 'dowels' })).toMatchObject({ fits: false, pieces: 2 });
    expect(fitPieces([400, 100, 5], U, {}, { passthrough: true })).toMatchObject({ fits: false, pieces: 2 });
    expect(fitPieces([260, 100, 4], U)).toMatchObject({ fits: false, pieces: 2 }); // fits only stood on its edge
    expect(fitPieces([150, 100, 4], U)).toEqual({ fits: true, pieces: 1, down: '-z', yaw: 0 });
    // too long to lie as modelled, but it stands on its end: the note says so
    expect(fitPieces([240, 100, 200], U)).toEqual({ fits: true, pieces: 1, down: '-x', yaw: 0 });
    expect(splitNote('SPLIT_NOT_NEEDED', { down: '-x', yaw: 0 }).text)
      .toBe('This model already fits your printer lying on its −X side – no need to split, but turn it that way in your slicer.');
    expect(splitNote('SPLIT_NOT_NEEDED', { down: '-z', yaw: 40 }).text).toBe('This model already fits your printer (turned 40° on the bed) – no need to split.');
  });
});

describe('gridCounts', () => {
  it('the fewest pieces whose equal cells fit', () => {
    expect(gridCounts([300, 40, 20], U)).toEqual({ pieces: 2, candidates: [[1, 0, 0]] });
    expect(gridCounts([600, 40, 20], U)).toEqual({ pieces: 3, candidates: [[2, 0, 0]] });
    expect(gridCounts([400, 300, 20], U)).toEqual({ pieces: 4, candidates: [[1, 1, 0]] });
    expect(gridCounts([60, 60, 400], U)).toEqual({ pieces: 2, candidates: [[0, 0, 1]] });
  });

  it('a 500 mm bar halves: each 250 mm half fits turned 44°', () => {
    expect(gridCounts([500, 40, 20], U)).toEqual({ pieces: 2, candidates: [[1, 0, 0]] });
    expect(fitsBed([250, 40, 20], U)).toMatchObject({ fits: true, down: '-z', height: 20, yaw: 44 });
  });

  it('a long model may take up to 12 cuts on one axis', () => {
    // 2.4 m of rail is 9 pieces of 267 mm, each fitting across the diagonal
    expect(gridCounts([2400, 40, 20], U)).toEqual({ pieces: 9, candidates: [[8, 0, 0]] });
    expect(fitPieces([2000, 200, 6], U).pieces).toBe(11);
    expect(fitPieces([2400, 100, 5], U).pieces).toBe(13);
    expect(gridCandidates([2400, 100, 5], U, planAllowance([2400, 100, 5]))[0]).toEqual({ k: [12, 0, 0], pieces: 13 });
  });

  it('no split needed, or none possible', () => {
    expect(gridCounts([100, 100, 100], U)).toEqual({ pieces: 1, candidates: [[0, 0, 0]] });
    expect(gridCounts([5000, 5000, 5000], U)).toEqual({ pieces: 0, candidates: [] });
  });

  it('the longest piece that still fits (slack)', () => {
    // on its 20 mm side, turned 45°: (S + 20)/√2 = 210
    expect(maxCellLength([150, 40, 20], 0, U)).toBeCloseTo(210 * Math.SQRT2 - 20, 6);
    expect(maxCellLength([600, 40, 20], 0, U)).toBe(0);
  });
});

describe('planCost', () => {
  const flat = (lo, hi, k, extra = () => ({})) => planSamples(lo, hi, k).map((t) => ({ t, area: 800, perimeter: 120, islands: 1, noRoom: 0, letters: false, ...extra(t) }));

  it('samples on a grid that holds the even positions exactly', () => {
    const t = planSamples(-150, 150, 1);
    expect(t).toHaveLength(199);
    expect(t).toContain(0);
    const t5 = planSamples(-250, 250, 2);
    expect(t5.length).toBeLessThanOrEqual(201);
    expect(t5.some((v) => Math.abs(v + 250 / 3) < 1e-9)).toBe(true);
  });

  it('weighs letters, item boxes, necks, islands and faces with no room', () => {
    const profile = [
      { t: 0, area: 800, perimeter: 120, islands: 1, noRoom: 0, letters: false },
      { t: 1, area: 800, perimeter: 120, islands: 1, noRoom: 0, letters: true },
      { t: 2, area: 800, perimeter: 120, islands: 1, noRoom: 0, letters: false },
      { t: 5, area: 200, perimeter: 120, islands: 3, noRoom: 0.5, letters: false },
      { t: 8, area: 0, perimeter: 0, islands: 0, noRoom: 0, letters: false },
      { t: 11, area: 800, perimeter: 120, islands: 1, noRoom: 0, letters: false },
    ];
    const c = planCost(profile, { items: [[7.5, 8.5]] });
    const W = PLAN_WEIGHTS;
    expect(c[1]).toBeGreaterThanOrEqual(W.letters);
    expect(c[0]).toBeGreaterThanOrEqual(W.nearLetters);
    expect(c[0]).toBeLessThan(W.letters);
    expect(c[4]).toBe(W.itemBox); // no material: only the item-box term
    expect(c[3]).toBeGreaterThan(W.neck * 0.4 + W.islands * 2 + W.noRoom * 0.5); // median 800, 200/400 → neck 0.5
    expect(c[5]).toBeLessThan(c[3]);
    // samples 3 mm apart cannot see a letter 1 mm away: one looked for on its own still counts
    const apart = [0, 3, 6].map((t) => ({ t, area: 800, perimeter: 120, islands: 1, noRoom: 0, letters: t === 6 }));
    const seen = planCost(apart.map((p, i) => (i === 1 ? { ...p, nearLetters: true } : p)));
    expect(seen[1] - planCost(apart)[1]).toBeCloseTo(W.nearLetters, 9);
  });

  it('charges an extra island only when it takes pins of its own: a helmet\'s chin bar under a visor is glued either way', () => {
    // two islands where the cut crosses a visor's opening, one beside it; no island has room for pins either way
    const at = (t, islands, roomy) => ({ t, area: 1000, perimeter: 300, islands, roomy, noRoom: roomy ? 0 : 1, letters: false });
    const [both, one] = planCost([at(0, 2, 0), at(10, 1, 0), at(20, 1, 0)]);
    expect(both).toBeCloseTo(one, 9);
    // two islands that both take pins need two sets
    const [two, single] = planCost([at(0, 2, 2), at(10, 1, 1), at(20, 1, 1)]);
    expect(two - single).toBeCloseTo(PLAN_WEIGHTS.islands, 9);
  });

  describe('chooseOffsets', () => {
    const plan = (E, k, extra, items = []) => {
      const lo = -E / 2;
      const hi = E / 2;
      const profile = flat(lo, hi, k, extra);
      const costs = planCost(profile, { items });
      const S = maxCellLength([E / (k + 1), 40, 20], 0, U) || Infinity;
      const reach = sizesFor(5).reach;
      return { r: chooseOffsets(profile.map((p) => p.t), costs, { lo, hi, k, S, minEnd: reach + 1, minMid: 2 * reach + 1 }), S, reach };
    };

    it('a flat 300 mm profile is cut at exactly 0', () => {
      const { r } = plan(300, 1);
      expect(r.offsets).toEqual([0]);
      expect(r.offsets[0]).toBe(0);
      expect(r.relaxed).toBe(false);
    });

    it('a flat 500 mm profile cut twice gives ±83.333; 600 gives ±100', () => {
      const r5 = plan(500, 2).r;
      expect(r5.offsets[0]).toBeCloseTo(-83.333, 3);
      expect(r5.offsets[1]).toBeCloseTo(83.333, 3);
      const r6 = plan(600, 2).r;
      expect(r6.offsets[0]).toBeCloseTo(-100, 9);
      expect(r6.offsets[1]).toBeCloseTo(100, 9);
    });

    it('keeps out of letters on [−30, 30]', () => {
      const { r } = plan(300, 1, (t) => ({ letters: t >= -30 && t <= 30 }), [[-30, 30]]);
      expect(Math.abs(r.offsets[0])).toBeGreaterThan(31);
    });

    it('every piece stays within its limits, and the same input gives the same answer', () => {
      let seed = 11;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const lo = -300;
      const hi = 300;
      const k = 3;
      const samples = planSamples(lo, hi, k);
      const costs = samples.map(() => rnd() * 20);
      const limits = { lo, hi, k, S: 190, minEnd: 30, minMid: 60 };
      const r = chooseOffsets(samples, costs, limits);
      expect(r.relaxed).toBe(false);
      const edges = [lo, ...r.offsets, hi];
      for (let i = 0; i + 1 < edges.length; i++) {
        const len = edges[i + 1] - edges[i];
        const min = i === 0 || i === edges.length - 2 ? limits.minEnd : limits.minMid;
        expect(len).toBeGreaterThanOrEqual(min - 1e-6);
        expect(len).toBeLessThanOrEqual(limits.S + 1e-6);
      }
      expect(chooseOffsets(samples, costs, limits)).toEqual(r);
      expect(chooseOffsets([...samples], [...costs], { ...limits })).toEqual(r);
    });

    it('counts each dovetail cut’s tabs in the pieces either side of it', () => {
      const lo = -200;
      const hi = 200;
      const tabs = { below: 12, above: 12 };
      const plan = (k) => {
        const samples = planSamples(lo, hi, k);
        return chooseOffsets(samples, samples.map(() => 0), { lo, hi, k, S: 300, Sflat: 210, grow: samples.map(() => tabs) });
      };
      // whatever the cut, one half is 212 mm or more with its tab
      expect(plan(1)).toBeNull();
      const r = plan(2);
      const edges = [lo, ...r.offsets, hi];
      const sizes = edges.slice(1).map((t, i) => t - edges[i] + (i > 0 ? 12 : 0) + (i < 2 ? 12 : 0));
      sizes.forEach((v) => expect(v).toBeLessThanOrEqual(210 + 1e-6));
      // a cut with one tab per island only lengthens the piece below it
      const samples = planSamples(-110, 110, 1);
      const limits = { lo: -110, hi: 110, k: 1, S: 300, Sflat: 116 };
      const one = chooseOffsets(samples, samples.map(() => 0), { ...limits, grow: samples.map(() => ({ below: 10, above: 0 })) });
      expect(one.offsets[0]).toBeLessThanOrEqual(-4 + 1e-6);
      expect(one.offsets[0]).toBeGreaterThanOrEqual(-6 - 1e-6);
      expect(chooseOffsets(samples, samples.map(() => 0), { ...limits, grow: samples.map(() => ({ below: 10, above: 10 })) })).toBeNull();
      // cuts without tabs are held to S alone
      expect(chooseOffsets(samples, samples.map(() => 0), { ...limits, grow: samples.map(() => null) }).offsets).toEqual([0]);
    });

    it('keeps a round shell’s cut in the middle: the ring shrinking towards the ends is no reason to move it there', () => {
      // a hollow ball 230 mm across with a 3 mm wall: every slice has the same area, the ring's length falls towards
      // the ends, and no ring takes two pins
      const R = 115;
      const samples = planSamples(-R, R, 1);
      const profile = samples.map((t) => ({ t, area: 2 * Math.PI * R * 3, perimeter: 4 * Math.PI * Math.sqrt(R * R - t * t), islands: 1, noRoom: 1, letters: false }));
      const reach = sizesFor(5).reach;
      const S = maxCellLength([115, 115, 115], 0, U);
      const r = chooseOffsets(samples, planCost(profile), { lo: -R, hi: R, k: 1, S, minEnd: reach + 1, minMid: 2 * reach + 1 });
      expect(r.offsets).toEqual([0]);
    });

    it('with the boxes the other axes make, leaves the fewest pieces: a table is cut through its legs, not just inside its apron', () => {
      // along z, three columns: the legs' (model all the way up) and the middle one (only the apron and top, from 220).
      // A slice through the apron ring costs a little less than one through the four legs, so alone the cut goes 3.5 mm
      // inside it, and the middle box below takes a 3.5 mm sliver of apron: a piece of its own
      const samples = planSamples(0, 300, 1);
      const costs = samples.map((t) => (t > 220 && t < 280 ? 5.8 : 7));
      const limits = { lo: 0, hi: 300, k: 1, S: 249, minEnd: 15, minMid: 30 };
      const alone = chooseOffsets(samples, costs, limits);
      expect(alone.offsets[0]).toBeGreaterThan(220);
      expect(alone.offsets[0]).toBeLessThan(225);
      const occupied = samples.map((t) => Uint8Array.from([1, t >= 220 ? 1 : 0, 1]));
      const r = chooseOffsets(samples, costs, { ...limits, occupied });
      expect(r.offsets).toEqual([150]);
      expect(r.parts).toBe(5);
      expect(r.cost).toBeCloseTo(7, 9);
    });

    it('never pushes a cut to the model\'s end to empty a box: the strip it would leave there is a sliver', () => {
      // two columns along x: one holds model all the way, the other only from 20 mm in (a gear plate's corner box).
      // A cut at 15–20 mm would leave that box empty, one piece fewer, but a 15 mm strip in the other column
      const samples = planSamples(0, 300, 1);
      const occupied = samples.map((t) => Uint8Array.from([1, t >= 20 ? 1 : 0]));
      const r = chooseOffsets(samples, samples.map(() => 0), { lo: 0, hi: 300, k: 1, S: 300, minEnd: 15, minMid: 30, occupied });
      expect(r).toMatchObject({ offsets: [150], parts: 4, slivers: 0 });
    });

    it('relaxes the minimums when they cannot be met, and gives up when pieces cannot fit', () => {
      const samples = planSamples(-20, 20, 1);
      const costs = samples.map(() => 0);
      const r = chooseOffsets(samples, costs, { lo: -20, hi: 20, k: 1, S: 100, minEnd: 30, minMid: 60 });
      expect(r).toMatchObject({ relaxed: true, offsets: [0] });
      expect(chooseOffsets(samples, costs, { lo: -20, hi: 20, k: 1, S: 10 })).toBeNull();
    });
  });
});

describe('clippedArea', () => {
  it('measures outlines within a box, so a column inside a frame\'s opening holds nothing', () => {
    // a 100 mm square frame 10 mm wide: outer ring counter-clockwise, its opening clockwise
    const frame = [[[0, 0], [100, 0], [100, 100], [0, 100]], [[10, 10], [10, 90], [90, 90], [90, 10]]];
    expect(clippedArea(frame, [-10, -10, 110, 110])).toBeCloseTo(100 * 100 - 80 * 80, 9);
    expect(clippedArea(frame, [30, 30, 70, 70])).toBeCloseTo(0, 9);
    expect(clippedArea(frame, [0, 0, 50, 50])).toBeCloseTo(50 * 50 - 40 * 40, 9);
    expect(clippedArea(frame, [200, 0, 300, 100])).toBe(0);
  });
});

/** A box as a triangle soup (9 numbers per triangle, outward winding). */
function boxSoup(lo, hi) {
  const c = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [0, 1, 2].map((a) => (i & (1 << a) ? hi[a] : lo[a])));
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return quads.flatMap(([p, q, r, t]) => [...c[p], ...c[q], ...c[r], ...c[p], ...c[r], ...c[t]]);
}

/** A ball of radius r round the origin as a triangle soup, in rings of latitude. */
function sphereSoup(r, rings, segments) {
  const at = (i, j) => {
    const th = (Math.PI * i) / rings;
    const ph = (2 * Math.PI * j) / segments;
    return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), -r * Math.cos(th)];
  };
  const out = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const [a, b, c, d] = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      if (i > 0) out.push(...a, ...c, ...d);
      if (i < rings - 1) out.push(...a, ...b, ...c);
    }
  }
  return out;
}

/** Soups as one mesh, the way `Manifold.getMesh()` gives it. */
function meshOf(soups) {
  const all = soups.flat();
  return { vertProperties: Float32Array.from(all), numProp: 3, triVerts: Uint32Array.from({ length: all.length / 3 }, (_, i) => i) };
}

describe('cells', () => {
  it('a shell pushed 9.6 mm over the line by a tab stays in its own cell', () => {
    expect(cellOf({ min: [-9.6, -20, 0], max: [150, 20, 20] }, [[0], [], []])).toEqual([1, 0, 0]);
    expect(cellOf({ min: [-150, -20, 0], max: [9.6, 20, 20] }, [[0], [], []])).toEqual([0, 0, 0]);
    expect(cellOf({ min: [10, 5, 0], max: [20, 6, 25] }, [[-50, 0, 50], [0], [10]])).toEqual([2, 1, 1]);
    expect(cellOfPoint([10, -5, 30], [[-50, 0, 50], [0], [10]])).toEqual([2, 0, 1]);
  });

  it('lists cell boxes bottom layer first, then front to back, then left to right', () => {
    const { grid, cells } = cellSizes({ min: [-200, -150, 0], max: [200, 150, 20] }, [{ position: [0, 0, 0], normal: [1, 0, 0] }, { axis: 1, at: 10 }, { axis: 0, at: 900 }]);
    expect(grid).toEqual([1, 1, 0]);
    expect(cells.map((c) => c.cell)).toEqual([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]]);
    expect(cells.map((c) => c.size)).toEqual([[200, 160, 20], [200, 160, 20], [200, 140, 20], [200, 140, 20]]);
  });

  it('counts the dovetail tabs a cut lends the cells either side, and lays those cells flat', () => {
    // a plate with something standing on it (too thick overall to be a thin plate): only the cells beside the tabs lie flat
    const bounds = { min: [-200, -50, 0], max: [200, 50, 30] };
    const cuts = [{ axis: 0, at: -60, reach: [12, 12], w: 2 }, { axis: 0, at: 60 }];
    const { cells } = cellSizes(bounds, cuts);
    expect(cells.map((c) => [c.size[0], c.flat])).toEqual([[140 + 12, 2], [120 + 12, 2], [140, null]]);
    expect(cellFits({ size: [212, 100, 4], flat: 2 }, U)).toBe(false);
    expect(cellFits({ size: [212, 100, 4], flat: null }, U)).toBe(true); // stood on its edge
    // stored cuts without tabs are boxed as before
    expect(cellSizes(bounds, [{ position: [0, 0, 0], normal: [1, 0, 0] }]).cells.map((c) => c.size)).toEqual([[200, 100, 30], [200, 100, 30]]);
  });

  it('plans a thin sign lying flat with its tabs counted, and only grids whose pieces all fit', () => {
    const bounds = { min: [-200, -50, -2], max: [200, 50, 2] };
    const E = [400, 100, 4];
    const profileOf = (a, k) => {
      const samples = planSamples(bounds.min[a], bounds.max[a], k);
      return { samples, costs: samples.map(() => 0), tabs: samples.map(() => ({ below: 12, above: 12, w: 2 })) };
    };
    const options = { E, U, bounds, flat: plateAxis(E), profileOf };
    expect(planGrid([1, 0, 0], options)).toBeNull();
    const plan = planGrid([2, 0, 0], options);
    expect(plan.k).toEqual([2, 0, 0]);
    expect(plan.pieces).toHaveLength(3);
    for (const p of plan.pieces) {
      expect(p.fits).toBe(true);
      expect(p.size[0]).toBeLessThanOrEqual(210 + 1e-6);
    }
    // the middle piece has a tab's length past each of its cuts
    const [t1, t2] = plan.offsets[0];
    expect(plan.pieces[1].size[0]).toBeCloseTo(t2 - t1 + 24, 9);
    // with no tabs and no plate the even halves stand
    const bar = { E: [300, 40, 20], U, bounds: { min: [-150, -20, 0], max: [150, 20, 20] }, flat: null, profileOf: (a, k) => {
      const samples = planSamples(-150, 150, k);
      return { samples, costs: samples.map(() => 0), tabs: samples.map(() => null) };
    } };
    expect(planGrid([1, 0, 0], bar)).toMatchObject({ offsets: [[0], [], []], pieces: [{ size: [150, 40, 20], fits: true }, { size: [150, 40, 20], fits: true }] });
  });

  it('every box of a thin plate lies flat, joints or not: a sign cut by hand is too big rather than stood on its edge', () => {
    // 'HELLO WORLD' at 60 mm with no model, cut in the middle: no tabs (letters 1.5 mm thick are glued)
    const sign = { min: [-294.15, -30.8, 0], max: [294.15, 30.8, 1.5] };
    const { cells } = cellSizes(sign, [{ position: [0, 0, 0], normal: [1, 0, 0] }]);
    expect(cells.map((c) => c.flat)).toEqual([2, 2]);
    expect(cells.map((c) => cellFits(c, U))).toEqual([false, false]);
    // a plate 4 mm thick held by pins: the same
    expect(cellSizes({ min: [-200, -50, 0], max: [200, 50, 4] }, [{ axis: 0, at: -60 }]).cells.map((c) => [c.flat, cellFits(c, U)])).toEqual([[2, true], [2, false]]);
    // a block is free to stand any way
    expect(cellSizes(bounds300, [{ axis: 0, at: 0 }]).cells.map((c) => c.flat)).toEqual([null, null]);
  });

  it('keeps the tabs of a plate that a cut along its thickness does not run through: both arms of an L', () => {
    // an L of two 6 mm plates 300 mm long: its base (thin along z, z 0…6) cut across x, its upright (thin along x) across z
    const E = [300, 40, 300];
    const bounds = { min: [0, 0, 0], max: E };
    const tabsAt = { 0: { below: 6, above: 6, w: 2, span: [0, 6] }, 2: { below: 6, above: 6, w: 0, span: [0, 6] } };
    const profileOf = (a, k) => {
      const samples = planSamples(0, 300, k);
      return { samples, costs: samples.map(() => 0), tabs: samples.map(() => tabsAt[a] ?? null) };
    };
    const plan = planGrid([1, 0, 1], { E, U, bounds, profileOf });
    expect(plan.offsets).toEqual([[150], [], [150]]);
    // each arm's tabs make the pieces either side 6 mm longer
    expect(plan.pieces.map((p) => p.size)).toEqual([[156, 40, 156], [156, 40, 156], [156, 40, 156], [156, 40, 156]]);
    // a cut along z inside the base's thickness would part its tabs into layers: those go (on a printer big enough
    // for the 297 mm upright)
    const low = { ...tabsAt, 2: null };
    const through = planGrid([1, 0, 1], {
      E, U: [400, 400, 400], bounds,
      profileOf: (a, k) => {
        const samples = a === 2 ? [3] : planSamples(0, 300, k);
        return { samples, costs: samples.map(() => 0), tabs: samples.map(() => low[a] ?? null) };
      },
    });
    expect(through.pieces.map((p) => p.size[0])).toEqual([150, 150, 150, 150]);
  });

  it('counts only the boxes that hold some of the model, and each piece must lie on something flat', () => {
    // the same L as two boxes: the box over the corner holds nothing
    const L = meshOf([boxSoup([0, 0, 0], [300, 40, 6]), boxSoup([0, 0, 6], [6, 40, 300])]);
    const held = cellSupport(L, [[150], [], [150]]);
    expect([...held.values()].map((c) => [c.cell.join(''), c.filled])).toEqual([['000', true], ['100', true], ['001', true], ['101', false]]);
    // the base's half rests on its flat underside, the upright's top on its flat end
    expect(held.get('1,0,0').rests).toEqual([true, true, true]);
    expect(held.get('0,0,1').rests[2]).toBe(true);
    // a box wholly inside the model touches none of its surface, and is a piece all the same
    const cube = meshOf([boxSoup([0, 0, 0], [30, 30, 30])]);
    expect(cellSupport(cube, [[10, 20], [10, 20], [10, 20]]).get('1,1,1')).toEqual({ cell: [1, 1, 1], filled: true, rests: [false, false, false] });
    // a ball's quarter has nothing flat but its cut faces: it may not stand on its pole
    const ball = meshOf([sphereSoup(60, 24, 48)]);
    const quarter = cellSupport(ball, [[0], [0], []]).get('0,0,0');
    expect(quarter).toMatchObject({ filled: true, rests: [false, false, false] });
    const bed = [105, 105, 124];
    const profileOf = (a, k) => {
      const samples = planSamples(-60, 60, k);
      return { samples, costs: samples.map(() => 0), tabs: samples.map(() => null) };
    };
    const options = { E: [120, 120, 120], U: bed, bounds: { min: [-60, -60, -60], max: [60, 60, 60] }, profileOf, support: (by) => cellSupport(ball, by) };
    // quarters 120 tall fit only standing on the pole; eighths lie on a cut face
    expect(planGrid([1, 1, 0], options)).toBeNull();
    expect(planGrid([1, 1, 0], { ...options, stable: false }).pieces).toHaveLength(4);
    expect(planGrid([1, 1, 1], options).pieces).toHaveLength(8);
    // the L: three pieces, not four
    const lPlan = planGrid([1, 0, 1], { E: [300, 40, 300], U, bounds: { min: [0, 0, 0], max: [300, 40, 300] }, support: (by) => cellSupport(L, by),
      profileOf: (a, k) => {
        const samples = planSamples(0, 300, k);
        return { samples, costs: samples.map(() => 0), tabs: samples.map(() => null) };
      } });
    expect(lPlan.pieces.map((p) => p.cell)).toEqual([[0, 0, 0], [1, 0, 0], [0, 0, 1]]);
  });

  it('a box holds model only where a triangle enters it: a long facet\'s own box spans boxes it misses', () => {
    // a sliver along the diagonal of a 2 × 2 grid: its box covers all four, it runs through two and touches the other
    // two at a point
    const sliver = [-10, -10, 0, 10, 10, 0, 10, 10, 1];
    const box = (i, j) => [[i ? 0 : -Infinity, j ? 0 : -Infinity, -Infinity], [i ? Infinity : 0, j ? Infinity : 0, Infinity]];
    expect([[0, 0], [1, 1], [0, 1], [1, 0]].map(([i, j]) => triangleInBox(sliver, [-10, -10, 0], [10, 10, 1], ...box(i, j)))).toEqual([true, true, false, false]);
    // a face lying on a cut puts nothing in the box beyond it
    expect(triangleInBox([0, 0, 5, 10, 0, 5, 0, 10, 5], [0, 0, 5], [10, 10, 5], [-Infinity, -Infinity, 5], [Infinity, Infinity, Infinity])).toBe(false);
    // a cone's long sides span every box of a grid cut 60 mm off its axis and half way up; round the tip, past the
    // cuts, the boxes hold nothing, and the Model card's offer is the pieces the rest make
    const seg = 48;
    const cone = [];
    for (let i = 0; i < seg; i++) {
      const [a, b] = [i, i + 1].map((k) => [120 * Math.cos((2 * Math.PI * k) / seg), 120 * Math.sin((2 * Math.PI * k) / seg)]);
      cone.push([...a, 0, ...b, 0, 0, 0, 320], [0, 0, 0, ...b, 0, ...a, 0]);
    }
    const held = cellSupport(meshOf(cone), [[-60], [-60], [160]]);
    expect([...held.values()].filter((c) => c.filled).map((c) => c.cell.join(''))).toEqual(['000', '100', '010', '110', '111']);
  });

  it('keeps a grid whose even pieces fit, when each axis on its own would take its room the same way', () => {
    // a 230 mm cube on the 210 × 210 × 249 bed: eighths of 115 fit. Cutting 100 mm out is cheap on every axis, and
    // each axis, planned against the others' even pieces, could stand its 215 mm piece upright: together they make a
    // corner piece that fits no way
    const E = [230, 230, 230];
    const bounds = { min: [-115, -115, -115], max: [115, 115, 115] };
    const profileOf = (a, k) => {
      const samples = planSamples(-115, 115, k);
      return { samples, costs: samples.map((t) => (Math.abs(t) < 100 ? 5 : 0)), tabs: samples.map(() => null) };
    };
    const reach = sizesFor(5).reach;
    const plan = planGrid([1, 1, 1], { E, U, bounds, minEnd: reach + 1, minMid: 2 * reach + 1, profileOf });
    // held to pieces that fit together, no cut can reach the cheap ends, and the even ones win
    expect(plan.offsets).toEqual([[0], [0], [0]]);
    expect(plan.pieces).toHaveLength(8);
    expect(plan.pieces.every((p) => p.fits)).toBe(true);
  });

  it('keeps a grid whose cuts miss the plates: a box with its lid laid beside it is four pieces', () => {
    // a 300 × 200 × 150 box and its 3 mm lid laid 20 mm beside it: a cut across the lid would take 12 mm tabs, but the
    // even cut runs through the gap and takes none, and the box's halves need not lie flat for the lid's sake
    const E = [300, 420, 150];
    const bounds = { min: [0, 0, 0], max: E };
    const lid = { below: 12, above: 12, w: 2, span: [0, 11], t: 3 };
    const profileOf = (a, k) => {
      const samples = planSamples(bounds.min[a], bounds.max[a], k);
      return { samples, costs: samples.map(() => 0), tabs: samples.map((t) => (a === 1 && t > 220 ? lid : null)) };
    };
    const plan = planGrid([1, 1, 0], { E, U, bounds, profileOf });
    expect(plan.offsets).toEqual([[150], [210], []]);
    expect(plan.pieces.map((p) => p.size)).toEqual(Array(4).fill([150, 210, 150]));
  });

  it('a cut through the legs of a U keeps no tabs: laid flat on one leg, the other would be a roof over the bed', () => {
    // a base 150 × 50 × 8 and two legs 8 × 50 × 300; the cut at z = 150 runs through both legs, 8 mm plates along x
    const Umesh = meshOf([boxSoup([0, 0, 0], [150, 50, 8]), boxSoup([0, 0, 0], [8, 50, 300]), boxSoup([142, 0, 0], [150, 50, 300])]);
    const held = cellSupport(Umesh, [[], [], [150]]);
    expect([0, 1].map((k) => liesFlat(held.get(`0,0,${k}`), 0, 8))).toEqual([false, false]);
    // the other leg's inner face, all the way down (these boxes overlap)
    expect([0, 1].map((k) => held.get(`0,0,${k}`).lying['-x'].support)).toEqual([50 * 150, 50 * 150]);
    // an L's corner lies flat on either arm: what stands on the plate needs nothing under it
    const L = meshOf([boxSoup([0, 0, 0], [300, 40, 6]), boxSoup([0, 0, 0], [6, 40, 300])]);
    const corner = cellSupport(L, [[150], [], [150]]).get('0,0,0');
    expect([liesFlat(corner, 2, 6), liesFlat(corner, 0, 6)]).toEqual([true, true]);
    const E = [150, 50, 300];
    const bounds = { min: [0, 0, 0], max: E };
    const profileOf = (a, k) => {
      const samples = planSamples(0, E[a], k);
      return { samples, costs: samples.map(() => 0), tabs: samples.map(() => (a === 2 ? { below: 6, above: 6, w: 0, span: [0, 150], t: 8 } : null)) };
    };
    const plan = planGrid([0, 0, 1], { E, U, bounds, profileOf, support: (by) => cellSupport(Umesh, by) });
    expect(plan.pieces.map((p) => p.size)).toEqual([[150, 50, 150], [150, 50, 150]]);
  });

  it('of two grids, the one whose pieces stand up costs less than one whose pieces lie with a leg held over the bed', () => {
    // the U on a 246 × 246 × 255 bed: halved along y, each 300 mm tall half must lie on a leg, the other one over it
    const Umesh = meshOf([boxSoup([0, 0, 0], [150, 50, 8]), boxSoup([0, 0, 0], [8, 50, 300]), boxSoup([142, 0, 0], [150, 50, 300])]);
    const E = [150, 50, 300];
    const options = {
      E, U: [246, 246, 255], bounds: { min: [0, 0, 0], max: E }, support: (by) => cellSupport(Umesh, by),
      profileOf: (a, k) => {
        const samples = planSamples(0, E[a], k);
        return { samples, costs: samples.map(() => 0), tabs: samples.map(() => null) };
      },
    };
    const along = planGrid([0, 1, 0], options);
    const across = planGrid([0, 0, 1], options);
    expect(along.support).toBe(2 * 25 * 300);
    expect(across.support).toBe(0);
    expect(across.cost).toBeLessThan(along.cost);
  });

  it('looks for a plate staying flat half way along each neighbour and most of the way to its end', () => {
    expect(flatProbes(0, -100, 60)).toEqual([-50, -90, 30, 54]);
    expect(flatProbes(0, -5, 60)).toEqual([30, 54]); // a side under 10 mm is not looked at
  });

  it('+ Cut halves the longest piece across its longest side', () => {
    expect(nextCut(bounds300, [])).toEqual({ position: [0, 0, 10], normal: [1, 0, 0] });
    expect(nextCut(bounds300, [{ position: [0, 0, 10], normal: [1, 0, 0] }])).toEqual({ position: [-75, 0, 10], normal: [1, 0, 0] });
    const twelve = Array.from({ length: 12 }, (_, i) => ({ axis: 0, at: -110 + i * 20 }));
    expect(nextCut(bounds300, twelve)).toBeNull();
    // 8 × 3 × 2 cells of 10 × 10 × 200: another z cut would make 72 pieces, so the next-longest side is cut instead
    const tall = { min: [0, 0, 0], max: [80, 30, 400] };
    const xs = Array.from({ length: 7 }, (_, i) => ({ axis: 0, at: 10 * (i + 1) }));
    const next = nextCut(tall, [...xs, { axis: 1, at: 10 }, { axis: 1, at: 20 }, { axis: 2, at: 200 }]);
    expect(next).toEqual({ position: [5, 15, 200], normal: [1, 0, 0] });
  });
});

describe('chooseCentres and symmetry', () => {
  const rect = (w, h, cx = 0, cy = 0) => [[[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]]];
  const inside = (polys, [u, v]) => {
    let odd = false;
    for (const poly of polys) {
      for (let i = 0; i < poly.length; i++) {
        const [x0, y0] = poly[i];
        const [x1, y1] = poly[(i + 1) % poly.length];
        if ((y0 <= v && y1 > v) || (y1 <= v && y0 > v)) if (x0 + ((v - y0) / (y1 - y0)) * (x1 - x0) > u) odd = !odd;
      }
    }
    return odd;
  };
  // a 60 × 40 face with a 20 × 10 hole (the hole clockwise, as toPolygons gives it)
  const ring = [...rect(60, 40), rect(20, 10)[0].slice().reverse()];

  it('is deterministic, spaced and inside the safe region', () => {
    const c = polygonsCentroid(ring);
    const a = chooseCentres(ring, 4, 15, c, { d: 5 });
    expect(chooseCentres(ring, 4, 15, c, { d: 5 })).toEqual(a);
    expect(a.length).toBe(4);
    for (const p of a) expect(inside(ring, p)).toBe(true);
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) expect(Math.hypot(a[i][0] - a[j][0], a[i][1] - a[j][1])).toBeGreaterThanOrEqual(15 - 1e-9);
    expect(isSymmetric(a, c, 2.5)).toBe(false);
  });

  it('a 24.8 × 4.8 face with s_min 18 gets 2 pins that only fit one way', () => {
    const safe = rect(24.8, 4.8);
    const c = [0, 0];
    const pts = chooseCentres(safe, 2, 18, c, { d: 6 });
    expect(pts).toHaveLength(2);
    expect(Math.hypot(pts[0][0] + pts[1][0] - 2 * c[0], pts[0][1] + pts[1][1] - 2 * c[1])).toBeGreaterThanOrEqual(3);
    expect(Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1])).toBeGreaterThanOrEqual(18);
    for (const p of pts) expect(inside(safe, p)).toBe(true);
  });

  it('a 10.7 × 0.7 strip takes 1 pin at s_min 15', () => {
    expect(chooseCentres(rect(10.7, 0.7), 2, 15, [0, 0], { d: 5 })).toHaveLength(1);
  });

  it('gives nothing for an empty region', () => {
    expect(chooseCentres([], 2, 15, [0, 0])).toEqual([]);
    expect(chooseCentres(rect(0, 5), 2, 15, [0, 0])).toEqual([]);
  });

  it('finds 180° symmetry within the tolerance', () => {
    expect(isSymmetric([[-5, 0], [5, 0]], [0, 0], 1)).toBe(true);
    expect(isSymmetric([[-5, 0], [5, 0.8]], [0, 0], 1)).toBe(true);
    expect(isSymmetric([[-5, 0], [5, 2]], [0, 0], 1)).toBe(false);
    expect(isSymmetric([[-5, 0], [5, 0], [0, 4]], [0, 0], 1)).toBe(false);
  });

  it('areas, centroids and grid points of polygons with holes', () => {
    expect(polygonsArea(ring)).toBeCloseTo(2400 - 200, 9);
    closeVec(polygonsCentroid([...rect(10, 10, 5, 5)]), [5, 5]);
    const pts = gridPoints(ring, 2);
    expect(pts.length).toBeGreaterThan(400);
    expect(pts.every((p) => inside(ring, p))).toBe(true);
    expect(pts.some((p) => Math.abs(p[0]) < 10 && Math.abs(p[1]) < 5)).toBe(false);
  });
});

/** Synthetic orientation stats for a box piece with the given cut faces (outward directions). */
function boxStats([dx, dy, dz], cutFaces = [], extra = {}) {
  const dims = [dx, dy, dz];
  const dirs = {};
  for (const d of Object.keys(DIRECTIONS)) {
    const a = dirAxis(d);
    const [p, q] = [0, 1, 2].filter((k) => k !== a);
    dirs[d] = { extent: dims[a], bed: dims[p] * dims[q], support: 0, cutArea: cutFaces.includes(d) ? dims[p] * dims[q] : 0, ...(extra[d] ?? {}) };
  }
  return { bbox: { min: [0, 0, 0], max: dims }, dims, allowed: Object.keys(DIRECTIONS), dirs };
}

describe('chooseOrientation', () => {
  it('a bar half lies flat (score 400) rather than on its cut face (≈ 15,400)', () => {
    const stats = boxStats([150, 40, 20], ['+x']);
    const auto = chooseOrientation(stats, U, 'auto', { pieceIndex: 1 });
    expect(auto).toMatchObject({ down: '-z', up: '+z', yaw: 0, fits: true, lies: 'flat as modelled', notes: [] });
    expect(auto.score).toBeCloseTo(400, 9);
    expect(auto.size).toEqual([150, 40, 20]);
    const onCut = chooseOrientation(stats, U, 'cut', { pieceIndex: 1 });
    expect(onCut).toMatchObject({ down: '+x', lies: 'on a cut face', fits: true, notes: [] });
    expect(onCut.score).toBeGreaterThan(15000);
    expect(onCut.score).toBeLessThan(15500);
  });

  it('a box half stands on its cut face (0 against 600 flat)', () => {
    const r = chooseOrientation(boxStats([60, 40, 30], ['+x']), U);
    expect(r).toMatchObject({ down: '+x', up: '-x', lies: 'on a cut face', score: 0 });
    expect(r.size).toEqual([30, 40, 60]);
    expect(chooseOrientation(boxStats([60, 40, 30], ['+x']), U, 'model')).toMatchObject({ down: '-z', score: 600, notes: [] });
  });

  it('a mating face goes down only where that costs next to no support: a hubbed gear\'s quarter lies flat', () => {
    // as measured on one: on its cut edge (-x) 1758 mm² of cut face would be down, for 770 mm² of support against 80
    const quarter = boxStats([138, 138, 40], ['-x', '+y'], {
      '-z': { bed: 11374, support: 80 }, '+z': { bed: 200, support: 11263 }, '-x': { bed: 1758, footprint: 138 * 40, support: 770, cutArea: 1758 },
      '+x': { bed: 0, support: 2175 }, '-y': { bed: 0, support: 2175 }, '+y': { bed: 1742, footprint: 138 * 40, support: 809, cutArea: 1742 },
    });
    expect(chooseOrientation(quarter, U)).toMatchObject({ down: '-z', lies: 'flat as modelled', fits: true });
    // with the support the same either way, the cut face still goes down
    const even = { ...quarter, dirs: { ...quarter.dirs, '-x': { ...quarter.dirs['-x'], support: 90 } } };
    expect(chooseOrientation(even, U)).toMatchObject({ down: '-x', lies: 'on a cut face' });
  });

  it('a plate piece next to a dovetail seam lies on ±z only', () => {
    const heavy = { '-z': { support: 5000 }, '+z': { support: 5000 } };
    const free = chooseOrientation(boxStats([150, 80, 5], ['+x'], heavy), U);
    expect(['-z', '+z']).not.toContain(free.down);
    const plate = { ...boxStats([150, 80, 5], ['+x'], heavy), allowed: ['-z', '+z'] };
    const r = chooseOrientation(plate, U);
    expect(r.down).toBe('-z');
    expect(chooseOrientation({ ...plate, allowed: ['+z'] }, U)).toMatchObject({ down: '+z', lies: 'upside down' });
  });

  it('puts fitting first: a plate too wide to lie flat stands on its edge', () => {
    const r = chooseOrientation(boxStats([230, 230, 10], ['+x']), U);
    expect(r.fits).toBe(true);
    expect(['-x', '+x', '-y', '+y']).toContain(r.down);
    expect(r.yaw).toBe(27);
    expect(r.notes).toEqual([]);
  });

  it('a cut face that does not fit falls back with ORIENT_FALLBACK', () => {
    const r = chooseOrientation(boxStats([260, 40, 20], ['+x']), U, 'cut', { pieceIndex: 2 });
    expect(r).toMatchObject({ fits: true, lies: 'on its side', yaw: 41 });
    expect(r.notes).toEqual([expect.objectContaining({ level: 'info', code: 'ORIENT_FALLBACK', pieceIndex: 2 })]);
    expect(r.notes[0].text).toBe('Piece 2 can\'t lie on its cut face on your printer – it lies on its side.');
  });

  it('a piece that fits no way is still laid out, with PIECE_TOO_BIG', () => {
    const r = chooseOrientation(boxStats([300, 40, 20], ['+x']), U, 'auto', { pieceIndex: 2 });
    expect(r).toMatchObject({ fits: false, down: '-z', yaw: 0 });
    expect(r.notes).toEqual([expect.objectContaining({ level: 'warn', code: 'PIECE_TOO_BIG', pieceIndex: 2, size: [300, 40, 20] })]);
    expect(r.notes[0].text).toBe('Piece 2 (300 × 40 × 20 mm) doesn\'t fit your printer in any position – it has room for 210 × 210 × 249 mm.');
  });

  it('a thin tile with something standing on it lies flat: on its cut edge the tile would be a wall however the stub spreads its bed', () => {
    // a 150 mm quarter of a 4 mm tile with the quarter of a tower 90 tall in its cut corner. Stood on its cut edge it
    // rests on the cut through the tower too, so its bed spans 150 × 94 mm and it looked as steady as a block: on the
    // cut face it went, a 4 mm wall 150 mm tall
    const mesh = meshOf([boxSoup([0, 0, 0], [150, 150, 4]), boxSoup([125, 125, 4], [150, 150, 94])]);
    const cuts = [{ axis: 0, at: 150 }, { axis: 1, at: 150 }];
    const stats = orientationStats(mesh.vertProperties, mesh.numProp, mesh.triVerts, cuts);
    expect(stats.plates[2]).toMatchObject({ t: 4, lo: 0, hi: 4, area: 150 * 150 });
    expect(chooseOrientation(stats, U)).toMatchObject({ down: '-z', lies: 'flat as modelled', fits: true });
    // a quarter of a terrain tile whose rocks and walls hold its plate along most of its run: lying flat needs about as
    // much support as standing on the cut edge, and a piece that is mostly a plate lies on it
    const rocky = {
      ...boxStats([150, 210, 55], ['+x', '-y'], {
        '-z': { support: 2205 }, '+z': { support: 30000 }, '+x': { support: 2193, bed: 1464, footprint: 5040 }, '-x': { support: 9000 }, '+y': { support: 9000 }, '-y': { support: 9000 },
      }),
      plates: [null, null, { t: 4, lo: 0, hi: 4, box: [0, 0, 150, 210], area: 30034 }],
    };
    expect(chooseOrientation(rocky, U)).toMatchObject({ down: '-z', lies: 'flat as modelled' });
    expect(chooseOrientation({ ...rocky, plates: null }, U)).toMatchObject({ down: '+x', lies: 'on a cut face' });
    // a tower as thick as the tile is wide stands on the cut face as before: nothing there is a thin plate
    const block = meshOf([boxSoup([0, 0, 0], [150, 150, 30]), boxSoup([125, 125, 30], [150, 150, 94])]);
    expect(chooseOrientation(orientationStats(block.vertProperties, block.numProp, block.triVerts, cuts), U).lies).toBe('on a cut face');
    // the floor of a channel is held by its walls: where lying on the floor costs support, half of it stands on its
    // cut face, its walls upright
    const channel = meshOf([boxSoup([0, 0, 0], [100, 200, 3]), boxSoup([0, 0, 3], [100, 3, 60]), boxSoup([0, 197, 3], [100, 200, 60])]);
    const half = orientationStats(channel.vertProperties, channel.numProp, channel.triVerts, [{ axis: 0, at: 100 }]);
    expect(half.plates[2]).toMatchObject({ t: 3 });
    expect(chooseOrientation({ ...half, dirs: { ...half.dirs, '-z': { ...half.dirs['-z'], support: 5000 } } }, U).lies).toBe('on a cut face');
  });

  it('says when a piece fits only resting on a point of a curve', () => {
    // a ball's quarter: nothing flat but its two cut faces, which are too long to lie on
    const none = Object.fromEntries(Object.keys(DIRECTIONS).map((d) => [d, { bed: 0, support: 7000 }]));
    const quarter = boxStats([120, 120, 240], ['+x', '+y'], { ...none, '+x': { bed: 14000, support: 0 }, '+y': { bed: 14000, support: 0 } });
    const r = chooseOrientation(quarter, U, 'auto', { pieceIndex: 3 });
    expect(r).toMatchObject({ fits: true, down: '-z', lies: 'on a curve' });
    expect(r.notes).toEqual([expect.objectContaining({ level: 'warn', code: 'PIECE_UNSTABLE', pieceIndex: 3 })]);
    expect(r.notes[0].text).toBe('Piece 3 has nothing flat to stand on where it fits your printer – it rests on a curve or an edge and needs supports. Another cut through it gives it a flat face to lie on.');
  });

  it('judges a piece with the loose triangles that go in its file', () => {
    // a 200 mm bar half with a flap of unrepaired triangles 25 mm past its end: 225 mm will not lie straight
    const half = boxStats([200, 40, 20], ['-x']);
    const flap = [200, 0, 10, 225, 0, 10, 225, 40, 10];
    const withFlap = statsWithSoup(half, flap);
    expect(withFlap.dims).toEqual([225, 40, 20]);
    expect(withFlap.dirs['-z'].extent).toBe(20);
    expect(withFlap.dirs['+x'].extent).toBe(225);
    expect(chooseOrientation(half, U)).toMatchObject({ yaw: 0, size: [200, 40, 20] });
    expect(chooseOrientation(withFlap, U)).toMatchObject({ fits: true, yaw: 34, size: [225, 40, 20] });
    expect(statsWithSoup(half, null)).toBe(half);
  });

  it('prints from the model’s own extremes, whatever the piece’s position', () => {
    const stats = boxStats([150, 40, 20], ['+x']);
    stats.bbox = { min: [-150, -20, 37], max: [0, 20, 57] };
    const r = chooseOrientation(stats, U, 'cut');
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => [0, 1, 2].map((a) => (c & (1 << a) ? stats.bbox.max[a] : stats.bbox.min[a])));
    const printed = corners.map((p) => applyMat4(r.printMatrix, p));
    expect(Math.min(...printed.map((p) => p[2]))).toBe(0);
    expect(Math.max(...printed.map((p) => p[2]))).toBe(150);
    expect(Math.min(...printed.map((p) => p[0])) + Math.max(...printed.map((p) => p[0]))).toBe(0);
    // the cut face (x = 0 in the world) is on the bed
    expect(applyMat4(r.printMatrix, [0, 0, 40])[2]).toBe(0);
    for (const p of corners) closeVec(applyMat4(r.matrix, applyMat4(r.printMatrix, p)), p, 12);
  });
});

describe('orientationStats', () => {
  // three triangles: a 50 mm² floor at z = 0 facing down, an overhang above it, and a 50 mm² cut face at x = 10
  const soup = [
    0, 0, 0, 0, 10, 0, 10, 0, 0,
    0, 0, 5, 0, 10, 5, 10, 0, 6,
    10, 0, 0, 10, 10, 0, 10, 0, 10,
  ];
  const verts = Float32Array.from(soup);
  const tris = Uint32Array.from({ length: 9 }, (_, i) => i);

  it('measures bed, support and cut area per direction', () => {
    const s = orientationStats(verts, 3, tris, [{ axis: 0, at: 10 }]);
    expect(s.bbox).toEqual({ min: [0, 0, 0], max: [10, 10, 10] });
    expect(s.dims).toEqual([10, 10, 10]);
    expect(s.dirs['-z'].bed).toBeCloseTo(50, 6);
    expect(s.dirs['-z'].support).toBeCloseTo(Math.hypot(10, 100) / 2, 6); // the overhang: within 45° of down, not on the bed
    expect(s.dirs['+x'].cutArea).toBeCloseTo(50, 6);
    expect(s.dirs['+x'].bed).toBeCloseTo(50, 6);
    expect(s.dirs['-z'].cutArea).toBe(0);
    expect(s.dirs['+z']).toMatchObject({ bed: 0, support: 0, cutArea: 0, extent: 10 });
    expect(s.allowed).toEqual(Object.keys(DIRECTIONS));
  });

  it('a cut face only counts on its own plane, and the allowed ways are kept', () => {
    const s = orientationStats(verts, 3, tris, [{ position: [9, 0, 0], normal: [1, 0, 0] }], { allowed: ['+z', '-z'] });
    expect(s.dirs['+x'].cutArea).toBe(0);
    expect(s.allowed).toEqual(['-z', '+z']);
    // a wider vertex stride is read correctly
    const wide = new Float32Array(9 * 4);
    for (let v = 0; v < 9; v++) for (let k = 0; k < 3; k++) wide[v * 4 + k] = soup[v * 3 + k];
    expect(orientationStats(wide, 4, tris, [{ axis: 0, at: 10 }]).dirs['+x'].cutArea).toBeCloseTo(50, 6);
  });

  it('finds a model\'s base plate: one at its end with only towers on it, not one with another plate over it', () => {
    const stats = (soups) => {
      const m = meshOf(soups);
      return orientationStats(m.vertProperties, m.numProp, m.triVerts);
    };
    // a terrain tile: a 4 mm plate with a tower and a wall on it
    expect(baseAxis(stats([boxSoup([0, 0, 0], [300, 300, 4]), boxSoup([200, 50, 4], [250, 100, 94]), boxSoup([30, 30, 4], [110, 50, 70])]))).toBe(2);
    // a sign's base strip standing on its side is a base all the same
    expect(baseAxis(stats([boxSoup([0, 0, 0], [6, 300, 120]), boxSoup([6, 100, 40], [60, 140, 80])]))).toBe(0);
    // a bookcase lying on its back: each board has another over it, and so has each side
    const bookcase = [boxSoup([0, 0, 0], [600, 200, 15]), boxSoup([0, 0, 110], [600, 200, 125]), boxSoup([0, 0, 225], [600, 200, 240]), boxSoup([0, 0, 15], [15, 200, 225]), boxSoup([585, 0, 15], [600, 200, 225])];
    expect(baseAxis(stats(bookcase))).toBeNull();
    // a 30 mm slab is too thick for a plate
    expect(baseAxis(stats([boxSoup([0, 0, 0], [300, 300, 30]), boxSoup([100, 100, 30], [150, 150, 94])]))).toBeNull();
  });
});

describe('print transforms', () => {
  it('lays a piece down, centred, with its bottom on z = 0, and reports its printed size', () => {
    const bbox = { min: [-150, -20, 0], max: [0, 20, 20] };
    expect(printTransform(bbox, '+x', 0).size).toEqual([20, 40, 150]);
    expect(printTransform(bbox, '+x', 90).size).toEqual([40, 20, 150]);
    const { printMatrix, matrix, size } = printTransform(bbox, '-z', 40);
    expect(size).toEqual([150, 40, 20]);
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => [0, 1, 2].map((a) => (c & (1 << a) ? bbox.max[a] : bbox.min[a])));
    const printed = corners.map((p) => applyMat4(printMatrix, p));
    expect(Math.min(...printed.map((p) => p[2]))).toBeCloseTo(0, 12);
    const xs = printed.map((p) => p[0]);
    const a = (40 * Math.PI) / 180;
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(150 * Math.cos(a) + 40 * Math.sin(a), 9); // the turned box's own footprint
    expect(Math.max(...xs) + Math.min(...xs)).toBeCloseTo(0, 9);
    for (const p of corners) closeVec(applyMat4(matrix, applyMat4(printMatrix, p)), p, 12);
  });

  it('moves a soup into a new array of the same type', () => {
    const soup = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const out = applyToSoup(soup, printTransform({ min: [0, 0, 0], max: [1, 1, 0] }, '+z', 0).printMatrix);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out).not.toBe(soup);
    expect(Array.from(soup)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(out)).toEqual([-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0]);
  });
});

describe('clipSoupByPlane', () => {
  const area = (s) => {
    let a = 0;
    for (let i = 0; i < s.length; i += 9) {
      const u = [s[i + 3] - s[i], s[i + 4] - s[i + 1], s[i + 5] - s[i + 2]];
      const v = [s[i + 6] - s[i], s[i + 7] - s[i + 1], s[i + 8] - s[i + 2]];
      a += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    }
    return a;
  };
  const tri1 = [0, 0, 0, 10, 0, 0, 0, 10, 0];
  const tri2 = [10, 0, 0, 10, 10, 0, 0, 10, 0]; // shares the edge (10, 0, 0)–(0, 10, 0) the other way round
  const len = Math.hypot(1, 0.3, 0.2);
  const n = [1 / len, 0.3 / len, 0.2 / len];
  const d = 3.7;
  const side = (s, i) => s[i] * n[0] + s[i + 1] * n[1] + s[i + 2] * n[2] - d;

  it('keeps the area and puts every fragment on one side', () => {
    const soup = Float64Array.from([...tri1, ...tri2]);
    const { plus, minus } = clipSoupByPlane(soup, n, d);
    expect(plus).toBeInstanceOf(Float64Array);
    expect(Math.abs(area(plus) + area(minus) - area(soup))).toBeLessThan(1e-9);
    for (let i = 0; i < plus.length; i += 3) expect(side(plus, i)).toBeGreaterThanOrEqual(-1e-9);
    for (let i = 0; i < minus.length; i += 3) expect(side(minus, i)).toBeLessThanOrEqual(1e-9);
    expect(plus.length / 9 + minus.length / 9).toBe(6); // the plane crosses both triangles: 1 + 2 fragments each
  });

  it('gives triangles that share an edge the identical crossing point', () => {
    const a = clipSoupByPlane(Float64Array.from(tri1), n, d);
    const b = clipSoupByPlane(Float64Array.from(tri2), n, d);
    const onEdge = (s) => {
      const out = [];
      for (let i = 0; i < s.length; i += 3) if (Math.abs(s[i] + s[i + 1] - 10) < 1e-9 && Math.abs(side(s, i)) < 1e-9) out.push(`${s[i]},${s[i + 1]},${s[i + 2]}`);
      return new Set(out);
    };
    const pa = onEdge(new Float64Array([...a.plus, ...a.minus]));
    const pb = onEdge(new Float64Array([...b.plus, ...b.minus]));
    expect(pa.size).toBe(1);
    expect([...pa]).toEqual([...pb]); // bit for bit, so the pieces stay joined
  });

  it('keeps the winding and the input’s array type', () => {
    const { plus, minus } = clipSoupByPlane(Float32Array.from(tri1), [1, 0, 0], 2.5);
    expect(plus).toBeInstanceOf(Float32Array);
    expect(area(plus) + area(minus)).toBeCloseTo(50, 9);
    for (const s of [plus, minus]) {
      for (let i = 0; i < s.length; i += 9) {
        const nz = (s[i + 3] - s[i]) * (s[i + 7] - s[i + 1]) - (s[i + 4] - s[i + 1]) * (s[i + 6] - s[i]);
        expect(nz).toBeGreaterThan(0);
      }
    }
    expect(clipSoupByPlane([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 1], 0).plus).toHaveLength(9); // in the plane: plus
  });

  it('groups a cut soup by cell', () => {
    const soup = Float32Array.from([...tri1, ...tri2].map((v, i) => (i % 3 === 0 ? v - 5 : v)));
    const cells = soupCells(soup, [{ axis: 0, at: 0 }, { axis: 1, at: 5 }]);
    expect(cells.map((c) => c.cell)).toEqual([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]]);
    expect(cells.reduce((s, c) => s + area(c.soup), 0)).toBeCloseTo(100, 4);
    for (const c of cells) expect(c.soup).toBeInstanceOf(Float32Array);
  });
});

describe('assembly', () => {
  const pieces2x2 = [
    { index: 1, cell: [0, 0, 0] }, { index: 2, cell: [1, 0, 0] },
    { index: 3, cell: [0, 1, 0] }, { index: 4, cell: [1, 1, 0] },
  ];
  const seams2x2 = [
    { letter: 'B', axis: 1, at: 0, pieces: [1, 3], joint: 'dowels', dowels: 2, labels: ['1B', '3B'] },
    { letter: 'A', axis: 0, at: 0, pieces: [4, 3], joint: 'dowels', dowels: 2, labels: ['4A', '3A'] },
    { letter: 'B', axis: 1, at: 0, pieces: [2, 4], joint: 'dowels', dowels: [{}, {}], labels: ['2B', '4B'] },
    { letter: 'A', axis: 0, at: 0, pieces: [1, 2], joint: 'dowels', dowels: 2, labels: ['1A', '2A'] },
  ];

  it('a 2 × 2 grid: the X letters along each row first, then the Y letter joining the rows', () => {
    const steps = assemblySteps({ pieces: pieces2x2, seams: seams2x2 });
    expect(steps.map((s) => s.letter)).toEqual(['A', 'A', 'B']);
    expect(steps.map((s) => [s.pieces, s.joins])).toEqual([[[1], [2]], [[3], [4]], [[1, 2], [3, 4]]]);
    expect(steps[0].text).toBe('Cut A: glue 2 pins into face 1A, a thin film on the face, push piece 2 on (2A). Hold 1 minute.');
    expect(steps[1].text).toMatch(/face 3A.*push piece 4 on \(4A\)/);
    expect(steps[2].text).toBe('Cut B: glue 4 pins into faces 1B and 2B, a thin film on the faces, push pieces 3 and 4 on together (3B, 4B). Hold 1 minute.');
  });

  it('dovetails are lowered on; glue-only faces are pressed; Z joins layers last', () => {
    const pieces = [{ index: 1, cell: [0, 0, 0] }, { index: 2, cell: [1, 0, 0] }, { index: 3, cell: [0, 0, 1] }, { index: 4, cell: [1, 0, 1] }];
    const steps = assemblySteps({
      pieces,
      seams: [
        { letter: 'B', axis: 2, at: 30, pieces: [1, 3], joint: 'none', dowels: 0, labels: null },
        { letter: 'B', axis: 2, at: 30, pieces: [2, 4], joint: 'none', dowels: 0, labels: null },
        { letter: 'A', axis: 0, at: 0, pieces: [3, 4], joint: 'dovetail', dowels: 0, labels: null },
        { letter: 'A', axis: 0, at: 0, pieces: [1, 2], joint: 'dovetail', dowels: 0, labels: null },
      ],
    });
    expect(steps.map((s) => s.letter)).toEqual(['A', 'A', 'B']);
    expect(steps[0].text).toBe('Cut A: a thin film of glue on the tabs, lay piece 1 flat and lower piece 2 onto it. Hold 1 minute.');
    expect(steps[2].text).toBe('Cut B: a thin film of glue on the faces, press pieces 3 and 4 onto pieces 1 and 2 and line the edges up. Hold until it sets.');
  });
});

describe('files and the glue sheet', () => {
  it('names files', () => {
    expect(pieceFileName('bar-text', 1, 2)).toBe('bar-text-piece-1-of-2');
    expect(pinsFileName(3, 6, 19)).toBe('pins-3x-6x19mm');
    expect(pinsFileName(5, 5, 16)).toBe('pins-5x-5x16mm');
    expect(pinsFileName(2, 6, 7.2)).toBe('pins-2x-6x7.2mm');
    expect(partFileName('bar', 1, 'Big logo!')).toBe('bar-part-1-Big_logo_');
    expect(zipFileName('long-bar-text', 2)).toBe('long-bar-text-2-pieces.zip');
    expect(glueFileName('box')).toBe('box-how-to-glue.txt');
    expect(safeFileName('my model (2).stl')).toBe('my_model_2_.stl');
  });

  it('the glue sheet lists the prints, a dry fit and the steps, matching letter to letter', () => {
    const text = howToGlueText({
      name: 'long-bar-text',
      pieces: [
        { index: 1, cell: [0, 0, 0], size: [150, 40, 20], lies: 'flat as modelled', yaw: 0, fits: true, shells: 1 },
        { index: 2, cell: [1, 0, 0], size: [150, 40, 20], lies: 'flat as modelled', yaw: 0, fits: true, shells: 1 },
      ],
      seams: [{ letter: 'A', axis: 0, at: 0, pieces: [1, 2], joint: 'dowels', dowels: 2, labels: ['1A', '2A'] }],
      pins: [{ d: 6, length: 19, count: 2, spares: 1 }],
      clearance: 0.15,
      printer: { size: [220, 220, 250], margin: 5 },
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('long-bar-text – 2 pieces for a 220 × 220 × 250 mm printer (5 mm margin) – STL Text');
    expect(lines).toContain('  piece 1 of 2   150.0 × 40.0 × 20.0 mm   lies flat as modelled   fits');
    expect(lines).toContain('  pins           3 × Ø6 × 19 mm (one spare), lying on a flat side, solid (4+ walls)');
    expect(lines).toContain('                 or Ø6 mm wooden dowels cut to 19 mm');
    expect(text).toContain('DRY-FIT FIRST');
    expect(text).toContain('GLUE – put each letter on the same letter (medium/thick CA or 5-minute epoxy; holes have 0.15 mm of room per side)');
    expect(text).toContain('1A ↔ 2A');
    expect(lines).toContain('  1. Cut A: glue 2 pins into face 1A, a thin film on the face, push piece 2 on (2A). Hold 1 minute.');
  });

  it('says what a turned, too-big or several-part piece is, and own pins and parts', () => {
    const text = howToGlueText({
      name: 'x',
      pieces: [
        { index: 1, cell: [0, 0, 0], size: [250, 40, 20], lies: 'flat as modelled', yaw: 45, fits: true, shells: 2 },
        { index: 2, cell: [1, 0, 0], size: [262, 120, 80], lies: 'on its side', yaw: 0, fits: false, shells: 1 },
      ],
      seams: [{ letter: 'A', axis: 0, at: 0, pieces: [1, 2], joint: 'dowels', dowels: 2, labels: null }],
      pins: [{ d: 5, length: 16, count: 2, own: true }, { d: 1.75, length: 8, count: 4 }],
      parts: [{ name: 'Logo' }],
      bed: [210, 210, 249],
    });
    expect(text).toContain('x – 2 pieces for a printer with room for 210 × 210 × 249 mm – STL Text');
    expect(text).toMatch(/piece 1 of 2 .* fits, turned 45° to fit, 2 parts/);
    expect(text).toMatch(/piece 2 of 2 .* TOO BIG for this printer/);
    expect(text).toContain('not printed – cut 2 Ø5 mm dowels to 16 mm');
    expect(text).toContain('cut 4 pieces of 1.75 mm filament 8 mm long');
    expect(text).toContain('“Logo” – prints separately; glue it on after the pieces');
    expect(text).toContain('GLUE – in this order');
    expect(text).toContain('1. Cut A: glue 2 pins into piece 1, a thin film on the face, push piece 2 on. Hold 1 minute.');
  });
});

describe('the glue sheet with nothing to glue', () => {
  it('cuts that run only between letters join nothing: no dry fit, no glue steps', () => {
    const text = howToGlueText({
      name: 'sign',
      pieces: [1, 2, 3].map((index) => ({ index, cell: [index - 1, 0, 0], size: [190, 61.6, 1.5], lies: 'flat as modelled', yaw: 0, fits: true, shells: 4 })),
      seams: [],
      bed: [210, 210, 249],
    });
    expect(text).not.toContain('DRY-FIT');
    expect(text).not.toContain('GLUE –');
    expect(text).not.toContain('fit test');
    expect(text).toContain('NOTHING TO GLUE');
    expect(text.trimEnd().split('\n').at(-1)).toBe('  The cuts run through gaps, so no two pieces touch. Lay them out as in the model – on a backing board to keep them together.');
  });
});

describe('notes', () => {
  it('a part that comes off says what happened to it', () => {
    const text = (code, fields) => splitNote(code, { letter: 'B', cutId: 'c2', ...fields }).text;
    expect(text('PART_LIFTS', { name: 'Dome and cap' })).toBe('Cut B: the dome and cap lift off – nothing holds them.');
    expect(text('PART_LIFTS', { name: 'Base' })).toBe('Cut B: the base lifts off – nothing holds it.');
    expect(text('PART_LIFTS', { name: 'Part B' })).toBe('Cut B: the part lifts off – nothing holds it.');
    // its face moved up the layers, or refused, with the nearest face that would do
    const gap = { name: 'Dome and cap', z: 115.4, gap: 0.83, need: 0.9, by: "the handle's feet" };
    expect(text('PART_GAP', { ...gap, movedTo: 115.6 })).toBe("Cut B: at Z 115.4 the dome and cap's edge is 0.83 mm from the handle's feet – it needs 0.9 mm to print apart. Moved to Z 115.6.");
    expect(text('PART_GAP', { ...gap, nearest: 115.6 })).toBe("Cut B: at Z 115.4 the dome and cap's edge is 0.83 mm from the handle's feet – it needs 0.9 mm to print apart. No face near here leaves it – the nearest that does is Z 115.6.");
    expect(text('PART_GAP', { ...gap, gap: 0 })).toBe("Cut B: at Z 115.4 the dome and cap's edge runs into the handle's feet – it needs 0.9 mm to print apart. No face near here leaves it.");
    expect(text('PART_GAP', { name: 'Top', axis: 0, z: 12, islands: 12, nearest: 13 })).toBe("Cut B: at X 12 the top's face is in 12 separate pieces – it needs one face to sit on. No face near here is one piece – the nearest that is is X 13.");
    expect(splitNote('PART_GAP', {}).level).toBe('warn');
    // it can't come out: what is in the way, and what might
    expect(text('PART_STUCK', { name: 'Dome and cap', over: "the handle's crown", beside: 'a leg', d: 40.2 })).toBe("Cut B's dome and cap can't come out: the handle's crown is over it and a leg is beside it. Try a circle under Ø 40.2 mm, or a face higher up.");
    expect(text('PART_STUCK', { name: 'Part B' })).toBe("Cut B's part can't come out: the rest of the model closes it in. Try a smaller circle, or a face higher up.");
    expect(text('PART_SPLIT', { name: 'Dome and cap', pieces: 3, d: 30 })).toBe("Cut B's circle cuts the dome and cap into 3 pieces – make it smaller than Ø 30 mm or use Find again.");
    expect(text('PART_SPLIT', { name: 'Base', pieces: 2, body: true })).toBe("Cut B's circle leaves the rest of the model in 2 pieces – make it smaller or use Find again.");
    expect(text('PART_SPLIT', { name: 'Top', pieces: 0, body: true })).toBe("Cut B's circle takes the whole model – make it smaller or use Find again.");
    expect(text('PART_MIXED', {})).toBe("Cut B's circle crosses the model above and around its plane – use a full cut there, or move it to where the circle crosses only air.");
    expect(splitNote('PART_CROSSED', { letter: 'A', cutId: 'c1', part: 'B', partId: 'c2' })).toMatchObject({
      level: 'warn', partId: 'c2', text: 'Cut A runs through the part of cut B – move one of them.',
    });
    expect(['PART_LIFTS', 'PART_GAP', 'PART_STUCK', 'PART_SPLIT', 'PART_MIXED', 'PART_CROSSED', 'PART_SMALL', 'PART_PRINT', 'PART_FIT'].map((code) => splitNote(code, {}).level)).toEqual([
      'info', 'warn', 'warn', 'warn', 'warn', 'warn', 'warn', 'info', 'info',
    ]);
  });

  it('says how a part twist-locks and how to open it, as the design words it for the lantern at 400 %', () => {
    const lock = { letter: 'B', cutId: 'c2', name: 'Dome and cap', piece: 2, home: 1, handle: true, turn: 19, lift: 4.6, dir: [0, 1, 0], span: [-1, 0, 0] };
    expect(splitNote('PART_LOCK', lock)).toMatchObject({
      level: 'info',
      text: 'Cut B: the dome and cap (piece 2) twist-lock onto piece 1 and the handle stays on piece 1. To fit it: set it on turned 19° to the left so the wide lug finds its wide slot, push down and turn it right until it clicks. To open it: turn it left until it clicks again, lift it 5 mm and slide it out under the handle, square to it.',
    });
    // a top with nothing over it lifts straight off; one slid out along a handle goes sideways
    expect(splitNote('PART_LOCK', { ...lock, name: 'Top', handle: false, dir: null, span: null }).text).toBe(
      'Cut B: the top (piece 2) twist-locks onto piece 1. To fit it: set it on turned 19° to the left so the wide lug finds its wide slot, push down and turn it right until it clicks. To open it: turn it left until it clicks again, lift it off.',
    );
    expect(splitNote('PART_LOCK', { ...lock, dir: [1, 0, 0] }).text).toContain('lift it 5 mm and slide it out sideways.');
    const plug = { letter: 'C', cutId: 'c3', name: 'Base', piece: 3, home: 1, turn: 17, opening: 57.4, teaLight: true, model: 'the lantern' };
    // a tea light goes in through it: with the light standing on it, the base goes in from underneath, the lantern held
    // up – turned over, the light would fall out
    expect(splitNote('PART_PLUG', plug)).toMatchObject({
      level: 'info',
      text: "Cut C: the base (piece 3) twists off underneath, and its Ø 57 mm opening takes a 38 mm tea light. To fit it: stand the light on the middle of the base, hold the lantern up and, looking at the base's bottom, set the base in turned 17° to the left, push it in and turn it right until it clicks – a coin in its slot helps. To open it: turn it left until it clicks and lower it out. Use an LED tea light: a flame's heat softens the plastic over it.",
    });
    // not a lantern, and an opening a tea light does not go through
    expect(splitNote('PART_PLUG', { ...plug, model: null, teaLight: false, opening: 35.2 }).text).toBe(
      'Cut C: the base (piece 3) twists off underneath. Turn piece 1 over, set the base in turned 17° to the left, push it in and turn it right until it clicks – a coin in its slot helps. To open it: turn it left until it clicks and lift it out.',
    );
    // with a tea-light seat on its top, it goes in from underneath with the light standing in the seat: turned over, the
    // light would fall out. And an LED light, not a flame
    expect(splitNote('PART_PLUG', { ...plug, seat: { d: 39.5, depth: 3.0014 } }).text).toBe(
      "Cut C: the base (piece 3) twists off underneath, and a 38 mm tea light sits in the seat on top of it (Ø 39.5 mm, 3 mm deep). To fit it: stand the light in the seat, hold the lantern up and, looking at the base's bottom, set the base in turned 17° to the left, push it in and turn it right until it clicks – a coin in its slot helps. To open it: turn it left until it clicks and lower it out. Use an LED tea light: a flame's heat softens the plastic over it.",
    );
    // the user's base at 400 %: the seat takes the place of its own cup, and the note says so, and how to keep the cup
    expect(splitNote('PART_PLUG', { ...plug, seat: { d: 39.5, depth: 3.0014, clears: { h: 7.635, across: 36.66 } } }).text).toBe(
      "Cut C: the base (piece 3) twists off underneath, and a 38 mm tea light sits in the seat on top of it (Ø 39.5 mm, 3 mm deep), in place of the model's own detail there (7.6 mm proud, Ø 37 mm across). To fit it: stand the light in the seat, hold the lantern up and, looking at the base's bottom, set the base in turned 17° to the left, push it in and turn it right until it clicks – a coin in its slot helps. To open it: turn it left until it clicks and lower it out. Use an LED tea light: a flame's heat softens the plastic over it. To keep that detail instead, untick Tea-light seat.",
    );
  });

  it("says a base has a tea-light seat on its top, or why it has none where one was asked for", () => {
    expect(splitNote('PART_SEAT', { letter: 'B', cutId: 'c2', name: 'Base', piece: 3, seat: { d: 39.8, depth: 3.15 } })).toMatchObject({
      level: 'info',
      text: "Cut B: a 38 mm tea light sits in the seat on top of the base (Ø 39.8 mm, 3.2 mm deep). Use an LED tea light: a flame's heat softens the plastic over it.",
    });
    expect(splitNote('PART_SEAT', { letter: 'B', cutId: 'c2', name: 'Base', piece: 3, seat: { d: 39.5, depth: 3, clears: { h: 5.87, across: 27.5 } } }).text).toBe(
      "Cut B: a 38 mm tea light sits in the seat on top of the base (Ø 39.5 mm, 3 mm deep), in place of the model's own detail there (5.9 mm proud, Ø 28 mm across). Use an LED tea light: a flame's heat softens the plastic over it. To keep that detail instead, untick Tea-light seat.",
    );
    const none = (fit) => splitNote('PART_NO_SEAT', { letter: 'B', cutId: 'c2', name: 'Base', piece: 2, ...fit });
    // the seat is asked for wherever one fits: a base with none is told why, nothing to act on – never a warning
    expect(none({ why: 'room', opening: 39, need: 42.6 })).toMatchObject({
      level: 'info', why: 'room',
      text: 'Cut B: no tea-light seat on the base (piece 2) – it is too narrow to keep a wall round one – that takes a Ø 42.6 mm opening.',
    });
    // the model's own detail in the middle of its top that the seat can't take the place of: wider than it, or running on
    // up into the model
    expect(none({ why: 'detail', h: 7.635, across: 45.21, rough: 3, d: 39.5 }).text).toBe(
      "Cut B: no tea-light seat on the base (piece 2) – the model's own detail in the middle of its top, 7.6 mm proud, is Ø 45.3 mm across – wider than the seat, which would leave the rest of it standing.",
    );
    expect(none({ why: 'detail', h: 60, across: 20, rough: 3, d: 39.5, open: true }).text).toBe(
      "Cut B: no tea-light seat on the base (piece 2) – the model's own detail in the middle of its top runs on up into the model, where the light would sit.",
    );
    expect(none({ why: 'level', h: 4.45, rough: 3 }).text).toBe('Cut B: no tea-light seat on the base (piece 2) – its top rises 4.5 mm round where the seat would go – a seat needs it level to within 3 mm.');
    expect(none({ why: 'room', opening: 42.4, need: 42.6 }).text).toBe('Cut B: no tea-light seat on the base (piece 2) – it is too narrow to keep a wall round one – that takes a Ø 42.6 mm opening.');
    expect(none({ why: 'thin', t: 3.74, need: 4.137868, lock: true }).text).toBe('Cut B: no tea-light seat on the base (piece 2) – its top is only 3.7 mm over its lock – a seat needs 4.2 mm.');
    expect(none({ why: 'thin', t: 4.5, need: 5, lock: false }).text).toBe('Cut B: no tea-light seat on the base (piece 2) – it is only 4.5 mm thick – a seat needs 5 mm.');
    expect(none({ why: 'hollow' }).text).toBe("Cut B: no tea-light seat on the base (piece 2) – it isn't solid under where the seat would go.");
    expect(none({ why: 'low', room: 40, tall: 45 }).text).toBe('Cut B: no tea-light seat on the base (piece 2) – there are only 40 mm over it inside the model – a seat needs 45 mm, room for the tallest tea light.');
    expect(noSeatWords({ why: 'narrow', opening: 30, need: 38.3 })).toBe("a 38 mm tea light doesn't go through its Ø 30 mm opening – that takes Ø 38.3 mm");
    // an opening just short of what a tea light takes is said short of it, never as wide: 37.6 and 38.29 are not "38"
    expect(noSeatWords({ why: 'narrow', opening: 37.6, need: 38.3 })).toBe("a 38 mm tea light doesn't go through its Ø 37.6 mm opening – that takes Ø 38.3 mm");
    expect(noSeatWords({ why: 'narrow', opening: 38.29, need: 38.3 })).toBe("a 38 mm tea light doesn't go through its Ø 38.2 mm opening – that takes Ø 38.3 mm");
    expect(noSeatWords({ why: 'narrow', opening: 38.45, need: 38.5 })).toBe("a 38 mm tea light doesn't go through its Ø 38.4 mm opening – that takes Ø 38.5 mm");
  });

  it("says a part is too small for a twist-lock at this size, why, and from what size one fits, as the design words it at 100 %", () => {
    const small = { letter: 'B', cutId: 'c2', name: 'Dome and cap', why: 'room', now: 100, wall: { t: 0.6, slope: 30 }, lock: 280, opening: 23.06, tea: 380, base: 205 };
    expect(splitNote('PART_SMALL', small)).toMatchObject({
      level: 'warn',
      text: 'Cut B: the dome is 0.6 mm thick here and slopes 30° – too thin for a twist-lock at 100 %. A twist-lock fits from 280 % (a 23 mm opening); a 38 mm tea light needs 380 %. The base can twist off from 205 %. At this size the dome and cap just lift off.',
    });
    const text = (fields) => splitNote('PART_SMALL', { ...small, ...fields }).text;
    // the base taken out too, or locking at this size; one size for the lock and the tea light; none as far as looked
    expect(text({ base: null })).toBe('Cut B: the dome is 0.6 mm thick here and slopes 30° – too thin for a twist-lock at 100 %. A twist-lock fits from 280 % (a 23 mm opening); a 38 mm tea light needs 380 %. At this size the dome and cap just lift off.');
    expect(text({ base: 'now' })).toContain('needs 380 %. The base can twist off with a lock at this size. At this size');
    expect(text({ tea: 280 })).toContain('A twist-lock fits from 280 % (a 23 mm opening), and takes a 38 mm tea light.');
    expect(text({ lock: null, tea: null, opening: null, most: 600, base: null })).toBe('Cut B: the dome is 0.6 mm thick here and slopes 30° – too thin for a twist-lock at 100 %. No twist-lock fits it up to 600 %. At this size the dome and cap just lift off.');
    // the other reasons none fits, and a base that lifts out
    expect(text({ why: 'tabs', now: 200 })).toMatch(/^Cut B: the dome has no room for a twist-lock's click tabs at 200 %\. /);
    expect(text({ why: 'collar' })).toMatch(/^Cut B: nothing under the dome is deep enough to carry a twist-lock at 100 %\. /);
    expect(text({ name: 'Base', why: 'floor', wall: null, lock: 205, opening: 29.4, tea: 275, base: null })).toBe(
      'Cut B: the base has no room for a twist-lock at 100 %. A twist-lock fits from 205 % (a 29 mm opening); a 38 mm tea light needs 275 %. At this size the base just lifts out.',
    );
    expect(text({ name: 'Top', wall: null })).toMatch(/^Cut B: the top has no room for a twist-lock at 100 %\..* At this size the top just lifts off\.$/);
  });

  it('says how a locked part prints, with the longest bridge its lock really has, and the fit test that tries it first', () => {
    const print = { letter: 'B', cutId: 'c2', name: 'Dome and cap', piece: 2, home: 1, mech: 'twist', bridge: 10.4569, slope: 1.72 };
    expect(splitNote('PART_PRINT', print)).toMatchObject({
      level: 'info',
      text: 'Print piece 2 on its cut face, as saved. The lock needs no support: its slots and click tabs are bridged (10.5 mm or less) – if your slicer puts support inside them, turn on "don\'t support bridges". The collar under the joint inside piece 1 slopes like the dome (60°), so it needs whatever support the dome needs.',
    });
    // a wide nozzle's longer tab bridges further; a collar no steeper than 45° needs nothing
    expect(splitNote('PART_PRINT', { ...print, bridge: 13.21 }).text).toContain('bridged (13.3 mm or less)');
    expect(splitNote('PART_PRINT', { ...print, slope: 1 }).text).toMatch(/The collar under the joint inside piece 1 slopes at 45°, so it needs no support either\.$/);
    expect(splitNote('PART_PRINT', { ...print, name: 'Top' }).text).toContain('slopes like the model round it (60°), so it needs whatever support the model round it needs.');
    expect(splitNote('PART_PRINT', { letter: 'C', cutId: 'c3', name: 'Base', piece: 3, home: 1, mech: 'plug' }).text).toBe(
      'Print piece 3 on its bottom, as saved. Its lock needs no support: every face it adds slopes at 45° or less, with no bridge.',
    );
    expect(splitNote('PART_FIT', { d: 53.08, grams: 7 })).toMatchObject({
      level: 'info',
      text: "Print the fit test first (Download fit test): two rings Ø 53 mm, about 7 g. If they won't twist together, raise the Clearance by 0.05 mm and print them again; if they rattle or don't click, lower it. Most printers need 0.15–0.25 mm, and PETG 0.25–0.3.",
    });
  });

  it('the glue sheet says how to put a twist-locked part on and take it off, never to glue it', () => {
    const pieces = [
      { index: 1, cell: [0, 0, 0], size: [97, 98, 200], lies: 'flat as modelled', fits: true, name: 'Lantern, with the handle', lids: [] },
      { index: 2, cell: [0, 0, 1], size: [61, 61, 39], lies: 'on a cut face', fits: true, name: 'Dome and cap', part: 'c1', lids: ['A'] },
      { index: 3, cell: [0, 0, 2], size: [57, 57, 34], lies: 'flat as modelled', fits: true, name: 'Base', part: 'c2', lids: ['B'] },
    ];
    const seam = (letter, at, piece, apart, part) => ({ letter, axis: 2, at, pieces: [1, piece], joint: 'part', dowels: [], pegs: [], labels: null, male: null, apart, part });
    const seams = [
      seam('A', 115.6, 2, { hold: 'lock', lip: false, clips: 0, mech: 'twist', theta: 19 }, { name: 'Dome and cap', span: [-1, 0, 0], way: { turn: 19, lift: 4.6, dir: [0, 1, 0] } }),
      seam('B', 0, 3, { hold: 'lock', lip: false, clips: 0, mech: 'plug', theta: 17 }, { name: 'Base', span: null, way: { turn: 17, lift: 0, dir: null } }),
    ];
    expect(assemblySteps({ pieces, seams }).map((x) => x.text)).toEqual([
      'Do not glue cut B: it comes apart. Base: turn piece 1 over, set the base in turned 17° to the left, push in and turn it right until it clicks (a coin in the slot helps). To open: turn it left and lift it out.',
      'Do not glue cut A: it comes apart. Dome and cap: set it on turned 19° to the left so the wide lug finds its wide slot, push down and turn it right until it clicks. To open: turn it left until it clicks again, lift it 5 mm and slide it out under the handle, square to it.',
    ]);
    const sheet = howToGlueText({ name: 'bat', pieces, seams });
    expect(sheet).toContain('turn it right until it clicks');
    expect(sheet).toContain('PUT TOGETHER – nothing is glued');
    // what each piece carries, that the locks need no supports, and how each should twist on – the fit test first
    expect(sheet).toContain('PRINT (each file is already turned the way to print it; twist-locks need no supports)');
    expect(sheet).toMatch(/piece 1 of 3 .*fits, twist-lock neck for cut A, twist-lock slots for cut B\n/);
    expect(sheet).toContain('  Not sure about the fit? Print the fit test first (Split card → Download fit test).');
    expect(sheet).toContain("DRY-FIT FIRST\n  The dome and cap (cut A) should twist on with a click and twist off again by hand. Try the fit test first: if it's too stiff to turn, raise Clearance by 0.05 mm; if it rattles or doesn't click, lower it.\n");
    expect(sheet).toContain('  The base (cut B) should twist in with a click and twist out again by hand. Too stiff to turn: raise Clearance by 0.05 mm; loose, or no click: lower it by 0.05 mm, and download again.\n');
    expect(sheet).not.toContain('Hold the pieces together');
    // a collar steeper than 45° under the joint takes the dome's support
    expect(sheet).not.toContain('The collar');
    const steep = seams.map((x) => (x.letter === 'A' ? { ...x, apart: { ...x.apart, slope: 1.72 } } : x));
    expect(howToGlueText({ name: 'bat', pieces, seams: steep })).toContain("  The collar under cut A's neck slopes like the dome (60°): it takes whatever support the dome takes.\n");
    // parts that lift off: nothing about locks
    const loose = seams.map((x) => ({ ...x, apart: { ...x.apart, mech: null } }));
    const plain = howToGlueText({ name: 'bat', pieces, seams: loose });
    expect(plain).not.toContain('twist');
    expect(plain).toContain('Hold the pieces together');
    // a base with a tea-light seat goes in from underneath, the light standing in the seat; whatever holds it, the sheet
    // says where the light goes, on the base's line and in the dry fit
    const seat = { d: 39.5, depth: 3 };
    const lit = seams.map((x) => (x.letter === 'B' ? { ...x, apart: { ...x.apart, seat } } : x));
    expect(assemblySteps({ pieces, seams: lit })[0].text).toBe(
      "Do not glue cut B: it comes apart. Base: a 38 mm tea light sits in the seat on top of the base (Ø 39.5 mm, 3 mm deep) – stand the light in it, hold piece 1 up and, looking at the base's bottom, set the base in turned 17° to the left, push in and turn it right until it clicks (a coin in the slot helps). To open: turn it left and lower it out.",
    );
    const litSheet = howToGlueText({ name: 'bat', pieces, seams: lit });
    expect(litSheet).toMatch(/piece 3 of 3 .*fits, comes off at cut B \(the base\), tea-light seat Ø 39\.5 mm on top\n/);
    expect(litSheet).toContain('  A 38 mm tea light should drop into the seat on top of the base (cut B) and lift out with two fingers.\n');
    expect(sheet).not.toContain('tea-light seat');
    // a base a tea light goes through goes in from underneath with the light standing on it, seat or none
    const through = seams.map((x) => (x.letter === 'B' ? { ...x, apart: { ...x.apart, opening: 57.4, teaLight: true } } : x));
    expect(assemblySteps({ pieces, seams: through })[0].text).toBe(
      "Do not glue cut B: it comes apart. Base: its Ø 57 mm opening takes a 38 mm tea light – stand the light on the middle of the base, hold piece 1 up and, looking at the base's bottom, set the base in turned 17° to the left, push in and turn it right until it clicks (a coin in the slot helps). To open: turn it left and lower it out.",
    );
    const cleared = seams.map((x) => (x.letter === 'B' ? { ...x, apart: { ...x.apart, opening: 57.4, teaLight: true, seat: { ...seat, clears: { h: 7.6, across: 36.7 } } } } : x));
    expect(assemblySteps({ pieces, seams: cleared })[0].text).toContain(
      "Base: a 38 mm tea light sits in the seat on top of the base (Ø 39.5 mm, 3 mm deep), in place of the model's own detail there (7.6 mm proud, Ø 37 mm across) – stand the light in it",
    );
    const lifting = loose.map((x) => (x.letter === 'B' ? { ...x, apart: { ...x.apart, seat } } : x));
    expect(assemblySteps({ pieces, seams: lifting })[0].text).toBe(
      'Do not glue cut B: it comes apart. Set the base in place on piece 1 – nothing holds it. A 38 mm tea light sits in the seat on top of the base (Ø 39.5 mm, 3 mm deep).',
    );
  });

  it("the glue sheet puts a part back in its place, and says it isn't glued", () => {
    const pieces = [
      { index: 1, cell: [0, 0, 0], size: [97, 98, 200], lies: 'flat as modelled', fits: true, name: 'Lantern, with the handle', lids: [] },
      { index: 2, cell: [0, 0, 1], size: [61, 61, 39], lies: 'on a cut face', fits: true, name: 'Dome and cap', part: 'c1', lids: ['A'] },
      { index: 3, cell: [0, 0, 2], size: [57, 57, 34], lies: 'flat as modelled', fits: true, name: 'Base', part: 'c2', lids: ['B'] },
    ];
    const part = (letter, at, piece, name) => ({ letter, axis: 2, at, pieces: [1, piece], joint: 'part', dowels: [], pegs: [], labels: null, male: null, apart: { hold: 'lock', lip: false, clips: 0 }, part: { name } });
    const seams = [part('A', 115.6, 2, 'Dome and cap'), part('B', 0, 3, 'Base')];
    expect(assemblySteps({ pieces, seams })).toEqual([
      { letter: 'B', axis: 2, pieces: [1], joins: [3], pins: 0, pegs: 0, apart: true, text: 'Do not glue cut B: it comes apart. Set the base in place on piece 1 – nothing holds it.' },
      { letter: 'A', axis: 2, pieces: [1], joins: [2], pins: 0, pegs: 0, apart: true, text: 'Do not glue cut A: it comes apart. Set the dome and cap in place on piece 1 – nothing holds them.' },
    ]);
    const sheet = howToGlueText({ name: 'bat', pieces, seams });
    expect(sheet).toContain('fits, comes off at cut A (the dome and cap)\n');
    expect(sheet).toContain('fits, comes off at cut B (the base)\n');
    expect(sheet).toContain('PUT TOGETHER – nothing is glued');
  });

  it('every code has a level and a text, and keeps its fields', () => {
    const fields = { letter: 'B', letters: ['B', 'C'], count: 2, total: 3, pieces: 3, dowels: 4, diameter: 6, length: 19, spares: 1, depth: 3.5, tabs: 2, placed: 48, dropped: 6, pieceIndex: 2, size: [262, 120, 80], bed: [220, 220, 250], thickness: 2.1, ratio: -0.0003, name: 'HELLO', mode: 'cut', lies: 'on its side', yaw: 40 };
    for (const code of SPLIT_NOTE_CODES) {
      const note = splitNote(code, fields);
      expect(['ok', 'info', 'warn']).toContain(note.level);
      expect(note.code).toBe(code);
      expect(note.text.length).toBeGreaterThan(10);
      expect(note.text).not.toMatch(/undefined|NaN|null/);
      expect(note.pieceIndex).toBe(2);
    }
    expect(() => splitNote('NOPE')).toThrow();
  });

  it('reads as in the design', () => {
    expect(splitNote('SPLIT', { pieces: 3, dowels: 4, diameter: 6, length: 19, pairs: ['1A ↔ 2A', '2B ↔ 3B'] }).text)
      .toBe('Cut into 3 pieces with 4 pins Ø6 × 19 mm. Glue matching letters together: 1A ↔ 2A, 2B ↔ 3B.');
    // one size in two lengths: never every pin the longer one
    expect(splitNote('SPLIT', { pieces: 3, dowels: 4, diameter: 6, length: 19, lengths: [{ length: 19, count: 2 }, { length: 17.8, count: 2 }] }).text)
      .toBe('Cut into 3 pieces with 4 pins Ø6 mm (2 × 19 mm, 2 × 17.8 mm).');
    // pins of two sizes, filament where a face is too narrow: every pin counted, each size said
    const sizes = [{ diameter: 5, length: 16, count: 2 }, { diameter: 1.75, length: 8, count: 6 }];
    expect(splitNote('SPLIT', { pieces: 5, dowels: 8, diameter: 5, length: 16, sizes }).text).toBe('Cut into 5 pieces with 8 pins (2 × Ø5 × 16 mm, 6 × Ø1.75 × 8 mm).');
    expect(splitNote('DOVETAIL_NOT_PLATE', { letter: 'A', lying: true }).text).toBe('Cut A goes through a plate that its pieces can\'t lie flat on, so it uses pins.');
    expect(splitNote('PINS', { count: 4, spares: 1, diameter: 6, length: 19 }).text).toBe('Print the pins file (5 pins, one spare) lying flat – or use Ø6 mm wooden dowels cut to 19 mm.');
    expect(splitNote('PINS', { count: 4, diameter: 5, length: 16, own: true }).text).toMatch(/cut 4 Ø5 mm dowels to 16 mm/);
    expect(splitNote('CONNECTORS_SHORTER', { letter: 'B', depth: 3.5 }).text).toBe('Cut B uses 3.5 mm-deep holes – deeper ones would break through the side.');
    expect(splitNote('CONNECTORS_FILAMENT', { letter: 'C', count: 4, diameter: 6, length: 8 }).text).toBe('Cut C is too narrow for Ø6 pins: its holes take 1.75 mm filament – cut 4 pieces 8 mm long.');
    expect(splitNote('CONNECTORS_DROPPED', { letter: 'B', count: 1, total: 3, wall: 6, suggestedDiameter: 4 })).toMatchObject({
      level: 'warn', suggestedDiameter: 4,
      text: 'No pin fits on 1 of 3 faces at cut B (walls under 6 mm) – it is a flat glue joint. A strip glued inside makes it stronger. Ø4 mm pins would fit.',
    });
    expect(splitNote('DOWELS_CAPPED', { placed: 48, dropped: 6 }).text).toBe('48 pins placed; 6 small faces are glued flat.');
    expect(splitNote('SMALL_PIECE', { pieceIndex: 3, thickness: 2.1, letters: ['B', 'C'] }).text).toBe('Piece 3 is only 2.1 mm thick between cuts B and C – move one of them.');
    expect(splitNote('SLIVER_REMOVED', { count: 1 }).text).toBe('Removed 1 paper-thin sliver where a cut lies exactly on a flat face of the model.');
    expect(splitNote('SPLIT_CHECK', { ratio: -0.0003 }).text).toBe('The pieces add up to 0.03 % less than the model – check them in your slicer.');
    expect(splitNote('CUT_THROUGH_TEXT', { letter: 'A', name: 'HELLO', pieces: [1, 2], itemId: 'i1' })).toMatchObject({
      level: 'info', itemId: 'i1', text: 'Cut A runs through “HELLO” – its letters are split between pieces 1 and 2.',
    });
    expect(splitNote('CUT_THROUGH_TEXT', { letter: 'I', name: 'Workshop', pieces: [1, 2, 10, 11], pairs: [[1, 10], [2, 11]] }).text)
      .toBe('Cut I runs through “Workshop” – its letters are split where piece 1 meets piece 10 and piece 2 meets piece 11.');
    expect(splitNote('PART_SPANS_CUT', { name: '“Logo”', letter: 'A' }).text).toBe('“Logo” prints separately and spans cut A – glue it on after the pieces.');
    expect(splitNote('SPLIT_UNREPAIRED', { count: 312 }).text).toBe('312 triangles that couldn\'t be repaired were cut with the pieces but have no pins or labels.');
    expect(splitNote('SPLIT_NOT_NEEDED', { yaw: 40 }).text).toBe('This model already fits your printer (turned 40° on the bed) – no need to split.');
    expect(splitNote('SPLIT_NOT_NEEDED', {}).text).toBe('This model already fits your printer – no need to split.');
    expect(splitNote('PLAN_TOO_MANY').text).toBe('This would need more than 64 pieces – scale the model down or choose a bigger printer.');
    expect(splitNote('BED_TOO_SMALL', { size: [300, 40, 20], bed: [220, 220, 250], pieces: 2 }).text).toBe('300 × 40 × 20 mm – bigger than your 220 × 220 × 250 mm printer.');
    expect(formatSize([262.04, 120, 79.96])).toBe('262 × 120 × 80 mm');
  });
});

describe('text through a cut', () => {
  it('finds the letters\' face in every column the other cuts make, with the boxes either side', () => {
    // a bar of letters 100 × 20 on a cut across x at 0, with cuts at y = 0 and z = 5: in the plane frame of an x cut,
    // u is y and v is z
    const bar = [[[-50, -10], [50, -10], [50, 10], [-50, 10]]];
    const columns = outlineColumns(bar, { axis: 0, at: 0 }, 0, [[0], [0], [5]]);
    expect(columns.map((c) => c.cells)).toEqual([
      [[0, 0, 0], [1, 0, 0]], [[0, 0, 1], [1, 0, 1]], [[0, 1, 0], [1, 1, 0]], [[0, 1, 1], [1, 1, 1]],
    ]);
    expect(columns[1]).toMatchObject({ min: [0, -50, 5], max: [0, 0, 10] });
    // a column the letters miss is left out
    expect(outlineColumns(bar, { axis: 0, at: 0 }, 0, [[0], [60], []]).map((c) => c.cells[0])).toEqual([[0, 0, 0]]);
  });

  it('names the pieces either side that hold the letters, in every column, as the pieces print', () => {
    // a bookcase lying on its back, its middle box printed as two pieces: the bottom board (2), and the two boards
    // over it (3), the top one lettered across cut A at x = 200
    const laid = [
      { index: 1, cell: [0, 0, 0], boxes: [{ min: [0, 0, 0], max: [200, 200, 243] }] },
      { index: 2, cell: [1, 0, 0], boxes: [{ min: [200, 0, 0], max: [400, 200, 15] }] },
      { index: 3, cell: [1, 0, 0], boxes: [{ min: [200, 0, 110], max: [400, 200, 125] }, { min: [200, 0, 225], max: [400, 200, 243] }] },
      { index: 4, cell: [2, 0, 0], boxes: [{ min: [400, 0, 0], max: [600, 200, 240] }] },
    ];
    const letters = { cells: [[0, 0, 0], [1, 0, 0]], min: [200, 80, 240], max: [200, 120, 243] };
    expect(pieceHolding(laid, [1, 0, 0], letters.min, letters.max)).toBe(3);
    const [note] = textNotes([{ itemId: 'i1', cutId: 'c1', letter: 'A', name: '“BOOKS”', columns: [letters] }], laid);
    expect(note).toMatchObject({ code: 'CUT_THROUGH_TEXT', letter: 'A', pieces: [1, 3], text: 'Cut A runs through “BOOKS” – its letters are split between pieces 1 and 3.' });
    // a sign cut in a grid: the cut splits letters in both rows, and the note names both pairs
    const grid = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j], k) => ({ index: k + 1, cell: [i, j, 0], boxes: [{ min: [i ? 0 : -150, j ? 0 : -50, 0], max: [i ? 150 : 0, j ? 50 : 0, 7] }] }));
    const rows = [0, 1].map((j) => ({ cells: [[0, j, 0], [1, j, 0]], min: [0, j ? 0 : -20, 4], max: [0, j ? 20 : 0, 7] }));
    const [both] = textNotes([{ itemId: 'i1', cutId: 'c1', letter: 'A', name: '“III”', columns: rows }], grid);
    expect(both).toMatchObject({ pieces: [1, 2, 3, 4], pairs: [[1, 2], [3, 4]] });
  });
});

describe('viewer maths', () => {
  it('follows the pointer along a cut’s normal', () => {
    expect(offsetAlongRay([37, -100, 10], [0, 1, 0], [0, 0, 0], [1, 0, 0])).toBe(37);
    expect(offsetAlongRay([37, -100, 10], [0, 2, 0], [5, 0, 0], [1, 0, 0])).toBe(32); // measured from the handle
    expect(offsetAlongRay([-100, 0, 0], [1, 0, 0], [0, 0, 0], [1, 0, 0])).toBeNull(); // looking straight down the normal
    expect(offsetAlongRay([-100, 0, 0], [1, 1e-9, 0], [0, 0, 0], [1, 0, 0])).toBeNull();
  });

  it('explodes cells evenly about the middle; pins sit in the gap', () => {
    expect([0, 1, 2].map((i) => explodeOffset([i, 0, 0], [2, 0, 0], 10)[0])).toEqual([-10, 0, 10]);
    expect(explodeOffset([0.5, 0, 0], [2, 0, 0], 10)).toEqual([-5, 0, 0]);
    expect(explodeOffset([1, 1, 0], [1, 1, 0], 8)).toEqual([4, 4, 0]);
  });

  it("moves a part's piece along its way out on the Spread slider: turned, lifted, slid, a third of the way each", () => {
    // the dome and cap at 300 %: turned 27° free, lifted 4.1 mm, slid 78 mm out along +y under the handle
    const way = { turn: 27, up: false, lift: 4.1, dir: [0, 1, 0], out: [0, 0, 1], reach: 78 };
    expect(waySteps(way)).toEqual(['turn', 'lift', 'slide']);
    const at = (f) => {
      const { turn, offset } = wayAt(way, f);
      return [+turn.toFixed(6), ...offset.map((v) => +v.toFixed(6))];
    };
    expect(at(0)).toEqual([0, 0, 0, 0]);
    expect(at(1 / 6)).toEqual([13.5, 0, 0, 0]); // turning, not yet lifted
    expect(at(1 / 3)).toEqual([27, 0, 0, 0]);
    expect(at(0.5)).toEqual([27, 0, 0, 2.05]); // lifting, turned free
    expect(at(2 / 3)).toEqual([27, 0, 0, 4.1]);
    expect(at(5 / 6)).toEqual([27, 0, 39, 4.1]); // sliding out, lifted
    expect(at(1)).toEqual([27, 0, 78, 4.1]);
    expect(at(2)).toEqual([27, 0, 156, 4.1]); // on the same way, as far again
    expect(at(-1)).toEqual([0, 0, 0, 0]);
    // which step it is on, for the view's words: none seated or out
    expect([0, 0.1, 0.4, 0.7, 0.99, 1, 1.5].map((f) => wayStep(way, f)?.step ?? null)).toEqual([null, 'turn', 'lift', 'slide', 'slide', null, null]);
    expect(wayStep(way, 0.5)).toEqual({ step: 'lift', n: 2, of: 3 });
  });

  it('leaves out the steps a way has not: a part that lifts off is not turned, a base drops out its own length', () => {
    // lifting off: lifted then slid, a half each
    const lifts = { turn: 0, up: false, lift: 0.7, dir: [0.6, 0.8, 0], out: [0, 0, 1], reach: 30 };
    expect(waySteps(lifts)).toEqual(['lift', 'slide']);
    expect(wayAt(lifts, 0.5)).toEqual({ turn: 0, offset: [0, 0, 0.7] });
    expect(wayAt(lifts, 0.75).offset.map((v) => +v.toFixed(6))).toEqual([9, 12, 0.7]);
    expect(wayStep(lifts, 0.75)).toEqual({ step: 'slide', n: 2, of: 2 });
    // the base: turned free about its way out (down), then dropped the length the view gives it, never less than its lift
    const base = { turn: 23, up: true, lift: 0, dir: null, out: [0, 0, -1], reach: 0 };
    expect(waySteps(base)).toEqual(['turn', 'lift']);
    expect(wayAt(base, 0.25, 40)).toEqual({ turn: 11.5, offset: [0, 0, 0] });
    expect(wayAt(base, 0.75, 40)).toEqual({ turn: 23, offset: [0, 0, -20] });
    expect(wayAt(base, 1, 40)).toEqual({ turn: 23, offset: [0, 0, -40] });
    expect(wayAt(base, 1.5, 40)).toEqual({ turn: 23, offset: [0, 0, -60] });
    expect(wayAt({ ...base, lift: 50 }, 1, 40).offset).toEqual([0, 0, -50]);
    // a lid straight off: lifted, not slid
    expect(wayAt({ turn: 0, up: true, lift: 0, dir: null, out: [0, 0, 1], reach: 80 }, 1, 25)).toEqual({ turn: 0, offset: [0, 0, 25] });
  });

  it("says, of a lock's face as its piece prints, whether it is bridged or overhangs past 45°", () => {
    const tilt = (deg) => -Math.sin((deg * Math.PI) / 180); // a face's normal's z, the face tilted deg from vertical, facing down
    expect(printedFace(-1)).toBe('bridge'); // a flat ceiling: the socket's, a slit's
    expect(printedFace(tilt(85))).toBe('bridge');
    expect(printedFace(tilt(59.8))).toBe('over'); // the collar's underside at the dome's slope
    expect(printedFace(tilt(45))).toBeNull(); // the base's 45° faces
    expect(printedFace(tilt(46))).toBeNull(); // within rounding of 45°
    expect(printedFace(tilt(20))).toBeNull();
    expect(printedFace(0)).toBeNull();
    expect(printedFace(1)).toBeNull();
    expect(printedFace(-1, true)).toBeNull(); // on the bed
  });

  it('lays the pieces as printed in a row, centred, a gap between', () => {
    expect(printedRow([10, 20], 5)).toEqual([-12.5, 7.5]);
    expect(printedRow([30], 5)).toEqual([0]);
    expect(printedRow([10, 10, 10], 2)).toEqual([-12, 0, 12]);
    expect(printedRow([], 5)).toEqual([]);
  });

  it('neighbouring pieces always differ in colour family', () => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        for (let k = 0; k < 8; k++) {
          const c = pieceColorIndex([i, j, k]);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThan(PIECE_COLORS.length);
          for (const [di, dj, dk] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) expect(pieceColorIndex([i + di, j + dj, k + dk]) % 2).not.toBe(c % 2);
        }
      }
    }
    expect(new Set(PIECE_COLORS).size).toBe(6);
    expect(PIECE_COLORS).not.toContain(CUT_COLOR);
    expect(PIECE_COLORS).not.toContain(PIN_COLOR);
    expect(CUT_COLOR).toBe(0x8b5cf6);
  });
});

describe('built-in pegs', () => {
  it('sizes follow from the side: a square exactly s, the clearance on its socket, glue room past its tip and a 45° point', () => {
    const p = pegSizesFor(6, 0.15, 0.4);
    expect(p).toMatchObject({ s: 6, d: 6, c: 0.15, ch: 0.5, e: 0.48, wall: 2.4, length: 9, depth: 9, h: 9.5 });
    expect(p.minDepth).toBeCloseTo(3.6, 12);
    expect(p.half).toBeCloseTo(3.15, 12);
    expect(p.tip).toBeCloseTo(3.15, 12); // 45° faces: as high as the socket's side is from its axis
    expect(p.h - p.length).toBeCloseTo(0.5, 12); // the glue's room past the peg's tip
    expect(p.a).toBeCloseTo(3.65 * Math.SQRT2, 12); // the mouth's half-diagonal, chamfer counted
    expect(p.rho).toBeCloseTo(3.65 * Math.SQRT2 + 2.4, 12);
    expect(p.rhoTear).toBe(p.rho); // a diamond needs no teardrop
    expect(p.sMin).toBe(18);
    expect(p.reach).toBeCloseTo(9.5 + 3.15 + 2.4 + 0.01, 12);
    // the length is 1.5 s to the half millimetre, or the depth set; the lead-in 0.4–0.5 mm
    expect([4, 5, 8, 10].map((s) => pegSizesFor(s).length)).toEqual([6, 7.5, 12, 15]);
    expect([4, 5, 8].map((s) => pegSizesFor(s).e)).toEqual([0.4, 0.4, 0.5]);
    expect(pegSizesFor(5, 0.15, 0.4, 11).length).toBe(11);
    // a socket kept within the room behind a face: shorter, or none under the minimum
    expect(pegSizesForRoom(6, 0.15, 0.4, 0, 20)).toEqual(p);
    expect(pegSizesForRoom(6, 0.15, 0.4, 0, 15).length).toBe(8.9);
    expect(pegSizesForRoom(6, 0.15, 0.4, 0, 9)).toBeNull();
    expect(AUTO_PEGS).toEqual([8, 6, 5, 4]);
    expect([0, 1.75, 3, 6, 10].map(pegSizeOf)).toEqual([0, SMALLEST_PEG, 3, 6, 10]);
    // what the planner counts before anyone knows which piece carries them: the largest automatic peg, or the size set
    expect(pegAllowance({})).toBe(12);
    expect(pegAllowance({ diameter: 5 })).toBe(7.5);
    expect(pegAllowance({ diameter: 5, depth: 10 })).toBe(10);
  });

  it('the planner counts how far pegs stand out, on the one piece of a cut that carries them, without laying it flat', () => {
    // a 420 mm board takes two pieces with pins, three with pegs: its 210 mm halves fit, but not with 9 mm pegs on one
    expect(fitPieces([420, 150, 20], U, { joint: 'dowels' }).pieces).toBe(2);
    expect(fitPieces([420, 150, 20], U, { joint: 'pegs' }).pieces).toBe(3);
    // where the pegs push no piece over the bed, as many pieces either way: a 410 mm board's cut moves towards the half
    // that carries them, and a 534 mm bar that fits across the bed in two on its side is not counted with the 12 mm
    // pegs that a 20 mm bar never gets
    expect(fitPieces([410, 150, 20], U, { joint: 'pegs' }).pieces).toBe(2);
    expect(fitPieces([534, 40, 20], U, { joint: 'dowels' }).pieces).toBe(2);
    expect(fitPieces([534, 40, 20], U, { joint: 'pegs' }).pieces).toBe(2);
    expect(fitPieces([300, 40, 20], U, { joint: 'pegs' }).pieces).toBe(2);
    // half a peg either side of each cut, as `evenCell` shares a reach out: faces 20 mm across take 6 mm pegs (9 mm
    // long), faces 40 mm across 8 mm ones (12 mm)
    expect(planAllowance([300, 40, 20], { joint: 'pegs' })).toEqual({ flat: null, grow: [4.5, 4.5, 6] });
    expect(planAllowance([300, 40, 20], { joint: 'pegs', diameter: 4 })).toEqual({ flat: null, grow: [3, 3, 3] });
    // the longest peg a face takes: Auto none wider than a third of it (the smallest when none is), a size set none
    // whose socket and wall are wider than it, and a length set whatever the size
    expect([[40, 20], [40, 30], [300, 24], [100, 11]].map((face) => pegAllowance({}, face))).toEqual([9, 12, 12, 6]);
    expect([[40, 30], [40, 18], [40, 12]].map((face) => pegAllowance({ diameter: 10 }, face))).toEqual([15, 9, 6]);
    expect(pegAllowance({ diameter: 10, depth: 20 }, [40, 12])).toBe(20);
    // a thin plate has no room for pegs: its cuts take dovetail tabs, as with Auto
    expect(planAllowance([400, 100, 4], { joint: 'pegs' })).toEqual(planAllowance([400, 100, 4], { joint: 'auto' }));
    expect(planAllowance([400, 100, 4], { joint: 'pegs' }, { passthrough: true })).toEqual({ flat: 2, grow: [0, 0, 0] });
    // per sample, a cut with pegs makes the piece below it or the one above it longer, below where either fits, and
    // holds them to what fits any way (S), never flat (Sflat): pegs too long for even halves move the cut towards the
    // piece that carries them
    const samples = planSamples(-200, 200, 1);
    const limits = { lo: -200, hi: 200, k: 1, S: 215, Sflat: 150 };
    const zero = samples.map(() => 0);
    const pegsOf = (L) => samples.map(() => ({ below: L, above: L, peg: true }));
    expect(chooseOffsets(samples, zero, { ...limits, grow: pegsOf(12) })).toMatchObject({ offsets: [0], reach: [[12, 0]] });
    expect(chooseOffsets(samples, zero, { ...limits, grow: pegsOf(16) })).toMatchObject({ offsets: [-2], reach: [[16, 0]] });
    expect(chooseOffsets(samples, zero, { ...limits, grow: pegsOf(32) })).toBeNull();
    expect(chooseOffsets(samples, zero, { ...limits, grow: samples.map(() => ({ below: 12, above: 12 })) })).toBeNull();
    // a grid: each piece as it will print, a peg's length past the cuts whose pegs it carries, lying any way
    const E = [410, 150, 20];
    const bounds = { min: [-205, -75, 0], max: [205, 75, 20] };
    const profileOf = (a, k) => {
      const list = planSamples(bounds.min[a], bounds.max[a], k);
      return { samples: list, costs: list.map(() => 0), tabs: list.map(() => ({ below: 12, above: 12, peg: true })) };
    };
    expect(planGrid([1, 0, 0], { E, U, bounds, flat: 2, profileOf, peg: 12 })).toBeNull();
    const three = planGrid([2, 0, 0], { E, U, bounds, flat: 2, profileOf, peg: 12 });
    const ends = [-205, ...three.offsets[0], 205];
    expect(three.pieces.map((x) => x.size[0])).toEqual(ends.slice(1).map((t, i) => t - ends[i] + (i < 2 ? 12 : 0)));
    expect(three.pieces.every((x) => x.fits)).toBe(true);
    const plain = (a, k) => ({ ...profileOf(a, k), tabs: planSamples(bounds.min[a], bounds.max[a], k).map(() => null) });
    expect(planGrid([1, 0, 0], { E, U, bounds, flat: 2, profileOf: plain })).not.toBeNull();
    // pegs on two axes of a block lay nothing flat: its pieces stand however suits them
    const block = { min: [-150, -150, 0], max: [150, 150, 120] };
    const blockOf = (a, k) => {
      const list = planSamples(block.min[a], block.max[a], k);
      return { samples: list, costs: list.map(() => 0), tabs: list.map(() => ({ below: 12, above: 12, peg: true })) };
    };
    const quarters = planGrid([1, 1, 0], { E: [300, 300, 120], U, bounds: block, profileOf: blockOf, peg: 12 });
    expect(quarters.pieces.map((x) => x.size)).toEqual([[162, 162, 120], [150, 162, 120], [162, 150, 120], [150, 150, 120]]);
    // a 30 mm slab's quarters lie flat: 200 mm and a peg is more than the bed, so each cut moves 2 mm towards the
    // piece below it, which carries its pegs
    const slab = { min: [-200, -200, 0], max: [200, 200, 30] };
    const slabPegs = (a, k) => {
      const list = planSamples(slab.min[a], slab.max[a], k);
      return { samples: list, costs: list.map(() => 0), tabs: list.map(() => (a < 2 ? { below: 12, above: 12, peg: true } : null)) };
    };
    const flatQuarters = planGrid([1, 1, 0], { E: [400, 400, 30], U, bounds: slab, flat: 2, profileOf: slabPegs, peg: 12 });
    expect(flatQuarters.offsets).toEqual([[-2], [-2], []]);
    expect(flatQuarters.pieces.map((x) => x.size)).toEqual([[210, 210, 30], [202, 210, 30], [210, 202, 30], [202, 202, 30]]);
    // a plate's cut that cannot keep its tabs (a cut along the plate's thickness runs through it) has pegs instead
    const slabBox = { min: [-150, -50, 0], max: [150, 50, 30] };
    const slabOf = (a, k) => {
      const list = planSamples(slabBox.min[a], slabBox.max[a], k);
      const tabs = a === 0 ? { below: 8, above: 8, w: 2, span: [0, 30], t: 4 } : null;
      return { samples: list, costs: list.map(() => 0), tabs: list.map(() => tabs) };
    };
    const layered = (peg) => planGrid([1, 0, 1], { E: [300, 100, 30], U, bounds: slabBox, profileOf: slabOf, peg }).pieces.map((x) => x.size[0]);
    expect(layered(12)).toEqual([162, 150, 162, 150]);
    expect(layered([12, 0, 0])).toEqual([162, 150, 162, 150]);
    expect(layered(0)).toEqual([150, 150, 150, 150]);
  });

  it('the boxes between the cuts count each cut\'s pegs on the one side that carries them, as the pieces fit best', () => {
    // an 80 × 80 × 660 mm post on a 170 × 170 × 179 mm bed, cut in four: each piece but the top one carries the pegs of
    // the cut over it, 177 mm tall, not of both its cuts (189 mm, too tall)
    const small = [170, 170, 179];
    const post = { min: [0, 0, 0], max: [80, 80, 660] };
    const postCuts = [165, 330, 495].map((at, i) => ({ id: `c${i + 1}`, axis: 2, at, peg: 12 }));
    const sided = pegSides(post, postCuts, (c) => cellFits(c, small));
    expect(sided.map((c) => c.reach)).toEqual([[12, 0], [12, 0], [12, 0]]);
    expect(cellSizes(post, sided).cells.map((c) => c.size[2])).toEqual([177, 177, 177, 165]);
    // a column cut 25 mm right of its middle: the 155 mm piece carries them, and both fit
    const column = { min: [-180, -50, 0], max: [180, 50, 240] };
    const [off] = pegSides(column, [{ id: 'c1', axis: 0, at: 25, peg: 12 }], (c) => cellFits(c, U));
    expect(off.reach).toEqual([0, 12]);
    expect(cellSizes(column, [off]).cells.map((c) => c.size[0])).toEqual([205, 167]);
    // a run of cuts that must all hand their pegs up: the first piece has no room for them, so the second carries
    // that cut's, the third the next one's, and the last the third cut's
    const bar = { min: [0, -50, -50], max: [805, 50, 50] };
    const run = pegSides(bar, [245, 475, 705].map((at, i) => ({ id: `c${i + 1}`, axis: 0, at, peg: 12 })), (c) => cellFits(c, U));
    expect(run.map((c) => c.reach)).toEqual([[0, 12], [0, 12], [0, 12]]);
    expect(cellSizes(bar, run).cells.map((c) => c.size[0])).toEqual([245, 242, 242, 112]);
    // with no bed to fit, every cut's pegs go below it; cuts without pegs are left alone
    expect(pegSides(post, [...postCuts, { id: 'c4', axis: 0, at: 40 }]).map((c) => c.reach ?? null)).toEqual([[12, 0], [12, 0], [12, 0], null]);
  });

  // a ball's eighth: three cut faces to lie on, the inside of the shell over each, and nothing flat outside
  const corner = (cell) => {
    const cuts = cell.map((c, a) => `${c ? '-' : '+'}${AXES[a]}`);
    const extra = Object.fromEntries(Object.keys(DIRECTIONS).map((d) => [d, cuts.includes(d) ? { support: 2000 } : { bed: 0, support: 7000 }]));
    return boxStats([140, 140, 140], cuts, extra);
  };
  const laidOf = (list) => list.map(({ index, cell = [0, 0, 0], stats }) => ({ index, cell, stats, lying: chooseOrientation(stats, U, 'auto', { pieceIndex: index }) }));

  it('one piece of each pair carries the pegs, and never the one left lying on that face', () => {
    // box halves both stand on their cut faces: the first, as both lose as much, lies another way
    const halves = laidOf([{ index: 1, stats: boxStats([60, 40, 30], ['+x']) }, { index: 2, stats: boxStats([60, 40, 30], ['-x']) }]);
    expect(halves.map((p) => p.lying.down)).toEqual(['+x', '-x']);
    expect(pegMales(halves, U)([{ axis: 0, lo: 1, hi: 2 }])).toEqual([0]);
    // only one lies on the face: the other carries them
    const one = laidOf([{ index: 1, stats: boxStats([150, 40, 20], ['+x']) }, { index: 2, stats: boxStats([60, 40, 30], ['-x']) }]);
    expect(one.map((p) => p.lying.down)).toEqual(['-z', '-x']);
    expect(pegMales(one, U)([{ axis: 0, lo: 1, hi: 2 }])).toEqual([0]);
    const other = laidOf([{ index: 1, stats: boxStats([60, 40, 30], ['+x']) }, { index: 2, stats: boxStats([150, 40, 20], ['-x']) }]);
    expect(pegMales(other, U)([{ axis: 0, lo: 1, hi: 2 }])).toEqual([1]);
    // neither does: the one printing its pegs lying down (along the layers) over one printing them pointing up
    const flat = laidOf([{ index: 1, stats: boxStats([150, 40, 20], ['+x']) }, { index: 2, stats: boxStats([150, 40, 20], ['-x']) }]);
    expect(flat.map((p) => p.lying.down)).toEqual(['-z', '-z']);
    expect(pegMales(flat, U)([{ axis: 0, lo: 1, hi: 2 }])).toEqual([0]); // both lie down: the lower-numbered
    // a block under a Z cut stands on its foot, its pegs would point up; the wall over it lies on its side, its pegs along
    // the bed
    const heavy = { support: 9000 };
    const wall = boxStats([40, 150, 100], ['-z'], { '-z': heavy, '+z': heavy, '-y': heavy, '+y': heavy });
    const upright = laidOf([{ index: 1, stats: boxStats([60, 60, 100], ['+z']) }, { index: 2, stats: wall }]);
    expect(upright.map((p) => p.lying.down)).toEqual(['-z', '-x']);
    expect(pegMales(upright, U)([{ axis: 2, lo: 1, hi: 2 }])).toEqual([1]);
    // of two standing on it, the one that still fits once it lies another way with its pegs: on a small printer a 170 mm
    // piece with 12 mm pegs on its end is 182 mm tall, so the 100 mm one carries them
    const small = [170, 170, 179];
    const tall = [{ index: 1, stats: boxStats([170, 150, 150], ['+x']) }, { index: 2, stats: boxStats([100, 150, 150], ['-x']) }]
      .map(({ index, stats }) => ({ index, stats, lying: chooseOrientation(stats, small) }));
    expect(tall.map((p) => p.lying.down)).toEqual(['+x', '-x']);
    expect(pegMales(tall, small, 'auto', { length: 12 })([{ axis: 0, lo: 1, hi: 2 }])).toEqual([1]);
    expect(pegMales(tall, small)([{ axis: 0, lo: 1, hi: 2 }])).toEqual([0]);
    // a piece with no way down left without the face never carries them
    const held = laidOf([{ index: 1, stats: { ...boxStats([150, 40, 5], ['+x']), allowed: ['+x'] } }, { index: 2, stats: boxStats([150, 40, 5], ['-x']) }]);
    expect(pegMales(held, U)([{ axis: 0, lo: 1, hi: 2 }])).toEqual([1]);
    const both = laidOf([{ index: 1, stats: { ...boxStats([150, 40, 5], ['+x']), allowed: ['+x'] } }, { index: 2, stats: { ...boxStats([150, 40, 5], ['-x']), allowed: ['-x'] } }]);
    expect(pegMales(both, U)([{ axis: 0, lo: 1, hi: 2 }])).toEqual([null]);
  });

  it('the pegs go on the piece across from the one with room for their sockets, whichever way the two would lie', () => {
    const pair = { axis: 0, lo: 1, hi: 2 };
    // only the second lies on the face, so the first would carry them; told only the first has room for the sockets,
    // the second carries them and lies another way
    const one = laidOf([{ index: 1, stats: boxStats([150, 40, 20], ['+x']) }, { index: 2, stats: boxStats([60, 40, 30], ['-x']) }]);
    expect(pegMales(one, U)([pair])).toEqual([0]);
    expect(pegMales(one, U)([{ ...pair, sockets: [true, false] }])).toEqual([1]);
    expect(pegMales(one, U)([{ ...pair, sockets: [true, true] }])).toEqual([0]);
    // only the first lies on it: the second would carry them, but only it has room for the sockets
    const other = laidOf([{ index: 1, stats: boxStats([60, 40, 30], ['+x']) }, { index: 2, stats: boxStats([150, 40, 20], ['-x']) }]);
    expect(pegMales(other, U)([pair])).toEqual([1]);
    expect(pegMales(other, U)([{ ...pair, sockets: [false, true] }])).toEqual([0]);
    // room on neither side, or only across from a piece with no way down without the face: glued
    expect(pegMales(one, U)([{ ...pair, sockets: [false, false] }])).toEqual([null]);
    const held = laidOf([{ index: 1, stats: { ...boxStats([150, 40, 5], ['+x']), allowed: ['+x'] } }, { index: 2, stats: boxStats([150, 40, 5], ['-x']) }]);
    expect(pegMales(held, U)([pair])).toEqual([1]);
    expect(pegMales(held, U)([{ ...pair, sockets: [false, true] }])).toEqual([null]);
    // a piece made too big by the pegs hands them to the other only where that one may carry them; one that must carry
    // them and that they push off the bed is glued
    const column = laidOf([{ index: 1, stats: boxStats([205, 100, 240], ['+x']) }, { index: 2, stats: boxStats([155, 100, 240], ['-x']) }]);
    expect(pegMales(column, U, 'auto', { length: 12 })([{ ...pair, sockets: [true, false] }])).toEqual([1]);
    expect(pegMales(column, U, 'auto', { length: 12 })([{ ...pair, sockets: [false, true] }])).toEqual([null]);
    expect(pegMales(column, U, 'auto', { length: 12 })([{ ...pair, sockets: [false, true] }], 4)).toEqual([0]);
    // a plaque's 5 mm base lies best on its cut face (its underside has engraved letters to hold up), the top on its own:
    // only the top has room for sockets, so the base carries the pegs and lies on its underside – it neither hands
    // them back nor drops them for the sake of its cut face
    const base = boxStats([174, 120, 5], ['+z'], { '-z': { support: 400 } });
    const plaque = laidOf([{ index: 1, stats: base }, { index: 2, stats: boxStats([174, 120, 8], ['-z']) }]);
    expect(plaque.map((p) => p.lying.down)).toEqual(['+z', '-z']);
    expect(pegMales(plaque, U, 'auto', { length: 6 })([{ axis: 2, lo: 1, hi: 2, sockets: [false, true] }])).toEqual([0]);
    // a 5 mm plate between two blocks, with no room for sockets, carries the pegs of its first face and lies on the
    // second, which is glued: with the pegs of both it could only stand on its edge. With room in it, the block under it
    // takes the lower face's
    const sandwich = laidOf([
      { index: 1, stats: boxStats([150, 150, 60], ['+z']) }, { index: 2, stats: boxStats([150, 150, 5], ['-z', '+z']) }, { index: 3, stats: boxStats([150, 150, 60], ['-z']) },
    ]);
    const faces = [{ axis: 2, lo: 1, hi: 2, sockets: [true, false] }, { axis: 2, lo: 2, hi: 3, sockets: [false, true] }];
    expect(pegMales(sandwich, U, 'auto', { length: 6 })(faces)).toEqual([1, null]);
    expect(pegMales(sandwich, U, 'auto', { length: 6 })(faces.map(({ sockets, ...rest }) => rest))).toEqual([0, 0]);
  });

  it('a piece that must carry the pegs, its neighbour having no room for sockets, does so only lying about as well as glued', () => {
    const pair = { axis: 2, lo: 1, hi: 2, sockets: [true, false] };
    const body = { index: 1, stats: boxStats([120, 120, 100], ['+z']) };
    const males = (lid) => pegMales(laidOf([body, { index: 2, stats: lid }]), U, 'auto', { length: 6 })([pair]);
    // a 5 mm lid with a knob lies flat on its cut face; carrying the pegs it would rest on the knob (452 mm² on the bed,
    // the rest over supports) or stand on its edge, a 5 mm wall: it is glued, and lies flat
    expect(males(boxStats([120, 120, 25], ['-z'], { '+z': { bed: 452, support: 13948 } }))).toEqual([null]);
    // a plain lid lies as well on its top, and carries them; so does one with letters engraved in its top, bridged
    // over a tenth of its footing or less
    expect(males(boxStats([120, 120, 5], ['-z']))).toEqual([1]);
    expect(males(boxStats([120, 120, 5], ['-z'], { '+z': { bed: 13000, support: 1400 } }))).toEqual([1]);
    // but not one that would need more support than that, nor one left on under half the bed it had
    expect(males(boxStats([120, 120, 5], ['-z'], { '+z': { bed: 13000, support: 1500 } }))).toEqual([null]);
    expect(males(boxStats([120, 120, 5], ['-z'], { '+z': { bed: 7000 } }))).toEqual([null]);
  });

  it('where both pieces have room for the sockets, the one across from more of it carries the pegs when it prints as well', () => {
    const pair = { axis: 2, lo: 1, hi: 2 };
    // the body stands on its foot and the lid lies on its cut face, so the body would carry them; the lid lies as well
    // on its top, and carries them when the body has more room for the sockets
    const lidded = laidOf([{ index: 1, stats: boxStats([120, 120, 100], ['+z']) }, { index: 2, stats: boxStats([120, 120, 8], ['-z']) }]);
    expect(pegMales(lidded, U)([pair])).toEqual([0]);
    expect(pegMales(lidded, U)([{ ...pair, sockets: [true, true], prefer: 1 }])).toEqual([1]);
    expect(pegMales(lidded, U)([{ ...pair, sockets: [true, true], prefer: 0 }])).toEqual([0]);
    // a pyramid roof that could lie only on its point or its eaves carrying them leaves them to the body, room or not
    const eaves = { bed: 480, support: 3000 };
    const roof = boxStats([120, 120, 40], ['-z'], { '+z': { bed: 4, support: 14000 }, '+x': eaves, '-x': eaves, '+y': eaves, '-y': eaves });
    const roofed = laidOf([{ index: 1, stats: boxStats([120, 120, 100], ['+z']) }, { index: 2, stats: roof }]);
    expect(pegMales(roofed, U)([{ ...pair, sockets: [true, true], prefer: 1 }])).toEqual([0]);
    // halves of a bar both lying on their cut faces: the one across from more room, not the lower-numbered
    const bar = laidOf([{ index: 1, stats: boxStats([60, 40, 30], ['+x']) }, { index: 2, stats: boxStats([60, 40, 30], ['-x']) }]);
    expect(pegMales(bar, U)([{ axis: 0, lo: 1, hi: 2 }])).toEqual([0]);
    expect(pegMales(bar, U)([{ axis: 0, lo: 1, hi: 2, sockets: [true, true], prefer: 1 }])).toEqual([1]);
    // only where both have room
    expect(pegMales(bar, U)([{ axis: 0, lo: 1, hi: 2, sockets: [false, true], prefer: 1 }])).toEqual([0]);
  });

  it('a cut whose pegs all print standing up says so, once, naming the pieces that carry them', () => {
    // cut A's pegs point up out of piece 1's top and down out of piece 3's bottom, which lies upside down; cut B's lie
    // along the bed on piece 2, and cut C's stand up on piece 4 but lie down on piece 2
    const peg = (cutId, letter, piece, dir, axis = 2) => ({ cutId, letter, axis, dir, sides: [{ piece, peg: true }, { piece: 99, peg: false }] });
    const laid = [1, 2, 3, 4].map((index) => ({ index }));
    const lying = [{ up: '+z' }, { up: '+x' }, { up: '-z' }, { up: '+y' }];
    const pegs = [peg('c1', 'A', 1, 1), peg('c1', 'A', 3, -1), peg('c1', 'A', 1, 1), peg('c2', 'B', 2, 1), peg('c3', 'C', 4, 1, 1), peg('c3', 'C', 2, 1, 1)];
    const notes = uprightPegNotes(pegs, laid, lying, ['c1', 'c2']);
    expect(notes).toEqual([splitNote('PEGS_UPRIGHT', { letter: 'A', cutId: 'c1', pieces: [1, 3], pins: true })]);
    expect(notes[0]).toMatchObject({
      level: 'info', text: 'Cut A\'s pegs print standing up on pieces 1 and 3 – they are a little weaker across the layers than pegs lying flat; pins (Joints: Pins) would be stronger.',
    });
    // pins are named only where their holes would fit: a plate too thin for sockets is mostly too thin for them
    expect(uprightPegNotes([peg('c3', 'C', 4, 1, 1)], laid, lying, ['c1']).map((n) => n.text)).toEqual([
      'Cut C\'s pegs print standing up on piece 4 – they are a little weaker across the layers than pegs lying flat.',
    ]);
    expect(uprightPegNotes([peg('c3', 'C', 4, 1, 1)], laid, lying)[0].pins).toBeUndefined();
    expect(uprightPegNotes([], laid, lying)).toEqual([]);
  });

  it('no piece is left with every good way to lie pegged: each corner of a ball cut in eight keeps a cut face', () => {
    const cells = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
    const laid = laidOf(cells.map((cell, i) => ({ index: i + 1, cell, stats: corner(cell) })));
    const pairs = [];
    for (let a = 0; a < 3; a++) {
      for (const p of laid) {
        if (p.cell[a] !== 0) continue;
        const q = laid.find((x) => x.cell.every((c, b) => c === (b === a ? 1 : p.cell[b])));
        pairs.push({ axis: a, lo: p.index, hi: q.index });
      }
    }
    const males = pegMales(laid, U)(pairs);
    expect(males.every((m) => m === 0 || m === 1)).toBe(true);
    for (const p of laid) {
      const pegged = pairs.filter((x, i) => [x.lo, x.hi][males[i]] === p.index).map((x, i) => x);
      const faces = pegged.map((x) => `${x.lo === p.index ? '+' : '-'}${AXES[x.axis]}`);
      expect(faces.length, `piece ${p.index}`).toBeLessThan(3);
      // laid again with its pegs, it lies on a cut face it keeps
      const pegs = pegged.map((x) => ({ axis: x.axis, at: 140, centre: [70, 70, 70], s: 4, length: 6, dir: x.lo === p.index ? 1 : -1, sides: [{ piece: p.index, peg: true }] }));
      const [o] = layPegged([p], pegs, U);
      expect(o.lies).toBe('on a cut face');
      expect(Boolean(o.pegged)).toBe(pegs.length > 0);
      expect(faces).not.toContain(o.down);
    }
  });

  it('the pegs go on the piece that still fits carrying them, whichever way the two lie', () => {
    // a column cut 25 mm right of its middle: both halves stand as modelled, so the first would carry them, but 205 mm
    // wide with 12 mm pegs it fits no way, and the 155 mm half carries them
    const column = laidOf([{ index: 1, stats: boxStats([205, 100, 240], ['+x']) }, { index: 2, stats: boxStats([155, 100, 240], ['-x']) }]);
    expect(column.map((p) => p.lying.down)).toEqual(['-z', '-z']);
    expect(pegMales(column, U, 'auto', { length: 12 })([{ axis: 0, lo: 1, hi: 2 }])).toEqual([1]);
    // at the pegs' own length, once their size is known, 4 mm leaves it room
    expect(pegMales(column, U, 'auto', { length: 12 })([{ axis: 0, lo: 1, hi: 2 }], 4)).toEqual([0]);
    // a bar lying flat, cut near the bed's diagonal: the longer half would carry them, and the shorter one does
    const bar = laidOf([{ index: 1, stats: boxStats([272, 40, 20], ['+x']) }, { index: 2, stats: boxStats([262, 40, 20], ['-x']) }]);
    expect(pegMales(bar, U, 'auto', { length: 9 })([{ axis: 0, lo: 1, hi: 2 }])).toEqual([1]);
    // a tower cut high: its top stands on the cut face, so its foot would carry them, 252 mm tall either way; the top
    // carries them, lying on its own top
    const tower = laidOf([{ index: 1, stats: boxStats([100, 100, 240], ['+z']) }, { index: 2, stats: boxStats([100, 100, 160], ['-z']) }]);
    expect(tower.map((p) => p.lying.down)).toEqual(['-z', '-z']);
    expect(pegMales(tower, U, 'auto', { length: 12 })([{ axis: 2, lo: 1, hi: 2 }])).toEqual([1]);
    // a middle piece given the pegs of both its cuts hands one cut's back to the piece below when that one has room:
    // the first stands on its cut face, so the second carries cut A's; neither of the next two lies on cut B, so the
    // second would carry those too, 284 mm long, which fits no way, and nor would the third with them – but the first
    // has room for cut A's
    const heavy = { bed: 0, support: 9000 };
    const chain = laidOf([
      { index: 1, stats: boxStats([60, 40, 20], ['+x'], { '-z': heavy, '+z': heavy, '-y': heavy, '+y': heavy, '-x': heavy }) },
      { index: 2, stats: boxStats([260, 40, 20], ['-x', '+x']) },
      { index: 3, stats: boxStats([270, 40, 20], ['-x']) },
    ]);
    expect(chain.map((p) => p.lying.down)).toEqual(['+x', '-y', '-y']);
    expect(pegMales(chain, U, 'auto', { length: 12 })([{ axis: 0, lo: 1, hi: 2 }, { axis: 0, lo: 2, hi: 3 }])).toEqual([0, 0]);
  });

  it('a piece of several shells carries pegs only where they all still rest on the bed', () => {
    // the ends of a fork's two prongs, cut off at x = 0, share only their cut face to rest on: lying any other way one
    // prong is held over the bed. Its head across the cut stands on the cut face too, and would cost more to turn over,
    // so before the prongs' ends would have carried the pegs and been laid flat with a prong in the air
    const heavy = { bed: 0, support: 9000 };
    const head = boxStats([100, 100, 60], ['+x'], { '-z': heavy, '+z': heavy, '-y': heavy, '+y': heavy, '-x': heavy });
    const loose = { bed: 0, support: 2000 };
    const prongs = boxStats([15, 80, 50], ['-x'], { '-z': loose, '+z': loose, '-y': loose, '+y': loose, '+x': { bed: 0, support: 100000 } });
    const shells = [{ min: [0, 0, 0], max: [10, 30, 30] }, { min: [0, 50, 20], max: [15, 80, 50] }];
    const laid = laidOf([{ index: 1, stats: head }, { index: 2, stats: prongs }]);
    expect(laid.map((p) => p.lying.down)).toEqual(['+x', '-x']);
    expect(pegMales(laid, U, 'auto', { length: 9 })([{ axis: 0, lo: 1, hi: 2 }])).toEqual([1]);
    laid[1].boxes = shells;
    expect(pegMales(laid, U, 'auto', { length: 9 })([{ axis: 0, lo: 1, hi: 2 }])).toEqual([0]);
    // and a piece of several shells that does carry pegs is laid again with every shell on the bed: the prongs' ends
    // both reaching x = 15, they stand on them, pegs up, though lying flat would cost less with one prong in the air
    const even = [{ min: [0, 0, 0], max: [15, 30, 30] }, { min: [0, 50, 20], max: [15, 80, 50] }];
    const pegs = [{ axis: 0, at: 0, centre: [0, 15, 15], s: 6, length: 9, dir: -1, sides: [{ piece: 1, peg: false }, { piece: 2, peg: true }] }];
    const [, before] = layPegged([laid[0], { ...laid[1], boxes: null }], pegs, U);
    expect(before.down).not.toBe('+x');
    const [, after] = layPegged([laid[0], { ...laid[1], boxes: even }], pegs, U);
    expect(after).toMatchObject({ pegged: true, down: '+x' });
  });

  it('a dome cut in two: the half carrying the pegs is told that they, not its shape, leave it nothing flat to lie on', () => {
    const curved = { bed: 0, support: 6000 };
    const dome = boxStats([70, 70, 55], ['+z'], { '-z': curved, '-x': curved, '+x': curved, '-y': curved, '+y': curved });
    const laid = laidOf([{ index: 1, stats: dome }]);
    expect(laid[0].lying).toMatchObject({ down: '+z', notes: [] });
    const pegs = [{ axis: 2, at: 55, centre: [35, 35, 55], s: 6, length: 9, dir: 1, sides: [{ piece: 1, peg: true }, { piece: 2, peg: false }] }];
    const [o] = layPegged(laid, pegs, U);
    expect(o.notes).toEqual([expect.objectContaining({ code: 'PIECE_UNSTABLE', level: 'warn', pieceIndex: 1, pegs: true })]);
    expect(o.notes[0].text).toBe('Piece 1 has nothing flat to stand on but the face its built-in pegs stand out of – it rests on a curve or an edge and needs supports. With pins (Joints: Pins) it lies on that face.');
    // a piece with nothing flat even before its pegs keeps the note about its shape
    const ball = laidOf([{ index: 1, stats: boxStats([70, 70, 55], [], { '-z': curved, '+z': curved, '-x': curved, '+x': curved, '-y': curved, '+y': curved }) }]);
    expect(layPegged(ball, pegs, U)[0].notes).toEqual([expect.objectContaining({ code: 'PIECE_UNSTABLE', text: expect.stringMatching(/Another cut through it/) })]);
  });

  it('a piece carrying pegs is laid again with them: its printed size counts them, and it never lies on them', () => {
    const half = boxStats([60, 40, 30], ['+x']);
    const pegs = [12, -12].map((y) => ({ axis: 0, at: 60, centre: [60, 20 + y, 15], s: 6, length: 9, dir: 1, sides: [{ piece: 1, peg: true }, { piece: 2, peg: false }] }));
    const grown = statsWithPegs(half, pegs);
    expect(grown.bbox.max[0]).toBe(69);
    expect(grown.dims).toEqual([69, 40, 30]);
    expect(grown.dirs['+x'].extent).toBe(69);
    expect(grown.allowed).not.toContain('+x');
    expect(grown.dirs['+x'].cutArea).toBe(0); // upright, the face prints its pegs along the layers: no reason to avoid it
    expect(statsWithPegs(half, [])).toBe(half);
    const laid = [{ index: 1, stats: half, lying: chooseOrientation(half, U) }, { index: 2, stats: half, lying: chooseOrientation(half, U) }];
    const [male, female] = layPegged(laid, pegs, U);
    expect(female).toBe(laid[1].lying);
    expect(male).toMatchObject({ pegged: true, fits: true });
    expect(male.down).not.toBe('+x');
    expect([...male.size].sort((p, q) => p - q)).toEqual([30, 40, 69]);
    // a male that no longer fits says so with its pegs counted
    const big = boxStats([205, 205, 240], ['+x']);
    expect(chooseOrientation(big, U).fits).toBe(true);
    const tight = [{ axis: 0, at: 205, centre: [205, 100, 120], s: 8, length: 12, dir: 1, sides: [{ piece: 1, peg: true }] }];
    const [o] = layPegged([{ index: 1, stats: big, lying: chooseOrientation(big, U) }], tight, U);
    expect(o).toMatchObject({ fits: false });
    expect(o.notes.map((n) => n.code)).toEqual(['PIECE_TOO_BIG']);
    expect([...o.size].sort((p, q) => p - q)).toEqual([205, 217, 240]);
  });

  it('the notes, the steps and the glue sheet speak of built-in pegs', () => {
    expect(splitNote('SPLIT', { pieces: 3, pegs: 4, pegSize: 6 }).text).toBe('Cut into 3 pieces joined by 4 built-in pegs (6 mm square).');
    expect(splitNote('SPLIT', { pieces: 3, pegs: 5, pegSize: 6, pegSizes: [{ size: 6, count: 3 }, { size: 4, count: 2 }], dovetails: 2 }).text)
      .toBe('Cut into 3 pieces joined by 5 built-in pegs (3 × 6 mm, 2 × 4 mm square) and dovetail tabs.');
    expect(splitNote('PEGS_SMALLER', { letter: 'A', asked: 6, pegSizes: [{ size: 5, count: 2 }] }).text).toBe('Cut A is too narrow for 6 mm pegs – it takes 2 × 5 mm pegs instead.');
    expect(splitNote('CONNECTORS_SHORTER', { letter: 'B', depth: 8.9, pegs: true }).text).toBe('Cut B uses 8.9 mm-long pegs – longer ones would break through the side.');
    expect(splitNote('CONNECTORS_DROPPED', { letter: 'A', count: 1, total: 1, wall: 10.7, pegs: true }).text)
      .toBe('No peg fits on 1 of 1 face at cut A (walls under 10.7 mm) – it is a flat glue joint. A strip glued inside makes it stronger.');
    expect(splitNote('ONE_CONNECTOR', { letter: 'C', pegs: true }).text).toBe('Only one peg fits on part of cut C – line the pieces up while the glue sets.');
    expect(splitNote('DOWELS_CAPPED', { placed: 48, dropped: 2, pegs: true }).text).toBe('48 pegs placed; 2 small faces are glued flat.');
    expect(splitNote('DOVETAIL_NOT_PLATE', { letter: 'A', lying: true, pegs: true }).text).toBe('Cut A goes through a plate that its pieces can\'t lie flat on, so it uses built-in pegs.');
    // the glue goes in the sockets; the piece carrying the pegs is pushed in, whichever side of the cut it is
    const pieces = [{ index: 1, cell: [0, 0, 0], size: [69, 40, 30], lies: 'flat as modelled' }, { index: 2, cell: [1, 0, 0], size: [30, 40, 60], lies: 'on a cut face' }];
    const seam = { letter: 'A', axis: 0, at: 0, pieces: [1, 2], joint: 'pegs', dowels: [], pegs: [{}, {}], male: 1, labels: ['1A', '2A'] };
    const [step] = assemblySteps({ pieces, seams: [seam] });
    expect(step).toMatchObject({ pins: 0, pegs: 2 });
    expect(step.text).toBe('Cut A: a little glue in the sockets of face 2A and on the face, push piece 1\'s pegs (1A) in. Hold 1 minute.');
    expect(assemblySteps({ pieces, seams: [{ ...seam, male: 2 }] })[0].text).toBe('Cut A: a little glue in the sockets of face 1A and on the face, push piece 2\'s pegs (2A) in. Hold 1 minute.');
    expect(assemblySteps({ pieces, seams: [{ ...seam, labels: null }] })[0].text).toBe('Cut A: a little glue in the sockets of piece 2 and on the face, push piece 1\'s pegs in. Hold 1 minute.');
    // a face of the same cut too narrow for a peg is glued flat in the same step, and its pieces are told of too
    const grid = [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]].map((cell, i) => ({ index: i + 1, cell, size: [10, 10, 10], lies: 'flat as modelled' }));
    const mixed = assemblySteps({
      pieces: grid,
      seams: [
        { letter: 'A', axis: 0, at: 130, pieces: [1, 2], joint: 'none', dowels: [], pegs: [], male: null, labels: null },
        { letter: 'B', axis: 2, at: 150, pieces: [1, 3], joint: 'pegs', dowels: [], pegs: [{}, {}, {}], male: 3, labels: ['1B', '3B'] },
        { letter: 'B', axis: 2, at: 150, pieces: [2, 4], joint: 'none', dowels: [], pegs: [], male: null, labels: null },
      ],
    });
    expect(mixed[1]).toMatchObject({ pieces: [1, 2], joins: [3, 4], pegs: 3 });
    expect(mixed[1].text).toBe('Cut B: a little glue in the sockets of face 1B and on the faces, push piece 3\'s pegs (3B) in and press piece 4 onto piece 2. Hold 1 minute.');
    const text = howToGlueText({ name: 'box', pieces, seams: [seam] });
    expect(text).toContain('PRINT (each file is already turned the way to print it; pegs and sockets need no supports)');
    expect(text).toContain('Pegs should push into their sockets by hand. Too tight: raise Clearance by 0.05 mm and download again.');
    expect(text).toContain('(medium/thick CA or 5-minute epoxy; sockets have 0.15 mm of room per side)');
    expect(text).toContain('Not sure about the fit? Print the fit test first');
    expect(text).not.toMatch(/pins|filament|dowels/);
  });
});

describe('limits and constants', () => {
  it('match the design', () => {
    expect(SPLIT_LIMITS).toEqual({ cuts: 12, cells: 64, dowels: 48 });
    expect(SPLIT_KEEP_TRIANGLES).toBe(1_000_000);
    expect(CUT_TOLERANCE).toBe(0.01);
    expect(Object.isFrozen(SPLIT_DEFAULTS.cuts)).toBe(true);
    expect(PIN_DIAMETERS).toEqual([1.75, 3, 4, 5, 6, 8, 10]);
    expect(AUTO_DIAMETERS).toEqual([8, 6, 5, 4, 3]);
    expect(FILAMENT).toBe(1.75);
    expect(JOINTS).toEqual(['auto', 'dowels', 'pegs', 'dovetail', 'none']);
    expect(ORIENT_MODES).toEqual(['auto', 'cut', 'model']);
    expect(AXES).toEqual(['x', 'y', 'z']);
    expect(HOLE_SEGMENTS).toBe(32);
    expect(POLYGON_K).toBeCloseTo(1.004838, 5); // the design rounds it to 1.004838
    expect(TOO_BIG_COLOR).toBe(0x551111);
    expect(PIN_COLOR).toBe(0xb8bcc8);
  });

  it('matrix helpers are column-major', () => {
    expect(applyMat4(translationMat4([1, 2, 3]), [10, 20, 30])).toEqual([11, 22, 33]);
    expect(transposeMat4(YAW90)).toEqual(mulMat4(YAW90, mulMat4(YAW90, YAW90)));
    expect(transposeMat4(transposeMat4(LAY_DOWN['-x']))).toEqual([...LAY_DOWN['-x']]);
  });
});

describe('cuts that come apart', () => {
  const MINI = [170, 170, 179]; // the A1 mini's usable bed
  const Z = [0, 0, 1];
  const laidOf = (list, bed = U, orient = 'auto') => list.map(({ index, cell = [0, 0, 0], stats, boxes }) => ({
    index, cell, stats, boxes, lying: chooseOrientation(stats, bed, orient, { pieceIndex: index }),
  }));
  // a 100 mm square tube's walls (4 mm) from z0 to z1, as triangle soups
  const walls = (z0, z1, h = 50, w = 4) => [
    boxSoup([-h, -h, z0], [h, -h + w, z1]), boxSoup([-h, h - w, z0], [h, h, z1]),
    boxSoup([-h, -h + w, z0], [-h + w, h - w, z1]), boxSoup([h - w, -h + w, z0], [h, h - w, z1]),
  ];
  // a pyramid roof from its eaves (half side e, at z0) up to a point, with the eaves' flat underside outside the tube
  const roof = (e, z0, apex, h = 50) => {
    const c = [[-e, -e], [e, -e], [e, e], [-e, e]];
    const out = [];
    for (let i = 0; i < 4; i++) out.push(c[i][0], c[i][1], z0, c[(i + 1) % 4][0], c[(i + 1) % 4][1], z0, 0, 0, apex);
    for (const [lo, hi] of [[[-e, -e], [e, -h]], [[-e, h], [e, e]], [[-e, -h], [-h, h]], [[h, -h], [e, h]]]) {
      out.push(lo[0], lo[1], z0, lo[0], hi[1], z0, hi[0], hi[1], z0, lo[0], lo[1], z0, hi[0], hi[1], z0, hi[0], lo[1], z0);
    }
    return out;
  };
  const statsOf = (soups, at) => {
    const m = meshOf(soups);
    return orientationStats(m.vertProperties, m.numProp, m.triVerts, [{ axis: 2, at }]);
  };
  // a lantern cut at z 190: the body (a 4 mm floor and walls) and its top (the walls' last 10 mm and a pointed roof)
  const body = statsOf([boxSoup([-46, -46, 0], [46, 46, 4]), ...walls(0, 190)], 190);
  const top = statsOf([...walls(190, 200), roof(55, 200, 260)], 190);
  // a box 80 × 80 × 60 (4 mm walls, 2 mm floor and top) cut 8 mm under its top
  const box = statsOf([boxSoup([-36, -36, 0], [36, 36, 2]), ...walls(0, 52, 40)], 52);
  const lid = statsOf([boxSoup([-36, -36, 58], [36, 36, 60]), ...walls(52, 60, 40)], 52);

  it('the document\'s flag reads as apart: { hold } on the normalised cut, and cuts merged in one place come apart if any did', () => {
    const cut = (id, z, extra = {}) => ({ id, position: [0, 0, z], normal: Z, ...extra });
    const bounds = { min: [-55, -55, 0], max: [55, 55, 291] };
    const { spec, cuts, notes } = normaliseSplit({
      joint: 'pegs',
      cuts: [cut('c1', 190, { joint: 'apart', hold: 'light' }), cut('c2', 100), cut('c3', 50, { joint: 'apart', hold: 'firm' }), cut('c4', 20, { hold: 'lift' })],
    }, bounds);
    expect(cuts).toEqual([
      { id: 'c4', letter: 'D', axis: 2, at: 20 },
      { id: 'c3', letter: 'C', axis: 2, at: 50, apart: { hold: 'snap' } }, // a hold there is not is Clicks on
      { id: 'c2', letter: 'B', axis: 2, at: 100 },
      { id: 'c1', letter: 'A', axis: 2, at: 190, apart: { hold: 'light' } },
    ]);
    expect(notes).toEqual([]);
    // the settings are the glued cuts' and do not change
    expect(spec).toEqual(normaliseSplit({ joint: 'pegs' }).spec);
    // in one place: the first in the list stays, and it comes apart, held as the first that came apart
    const merged = normaliseSplit({ cuts: [cut('c1', 100), cut('c2', 100.004, { joint: 'apart', hold: 'lift' }), cut('c3', 100.002, { joint: 'apart', hold: 'snap' })] }, bounds);
    expect(merged.cuts).toEqual([{ id: 'c1', letter: 'A', axis: 2, at: 100, apart: { hold: 'lift' } }]);
    expect(merged.notes.map((n) => n.code)).toEqual(['CUTS_MERGED']);
    // a normalised cut is read alike
    expect(normaliseSplit({ cuts: [{ id: 'c1', axis: 2, at: 190, apart: { hold: 'lift' } }, { id: 'c2', axis: 0, at: 0 }] }, bounds).cuts)
      .toEqual([{ id: 'c2', letter: 'B', axis: 0, at: 0 }, { id: 'c1', letter: 'A', axis: 2, at: 190, apart: { hold: 'lift' } }]);
    // a cut that locks keeps its hold, stored or normalised
    expect(normaliseSplit({ cuts: [cut('c1', 190, { joint: 'apart', hold: 'lock' })] }, bounds).cuts).toEqual([{ id: 'c1', letter: 'A', axis: 2, at: 190, apart: { hold: 'lock' } }]);
    expect(normaliseSplit({ cuts: [{ id: 'c1', axis: 2, at: 190, apart: { hold: 'lock' } }] }, bounds).cuts[0].apart).toEqual({ hold: 'lock' });
  });

  it('the lip\'s sizes: the catch stands a fixed way out, so Clearance tunes how hard it clicks', () => {
    expect(APART_HOLDS).toEqual(['lock', 'snap', 'light', 'lift']);
    expect(LIP).toMatchObject({ t: 1.6, tMin: 1.2, skirt: 1.6, wall: 1.2, g0: 0.1, into: 0.5, step: 0.2, lead: 0.6, mouth: 0.4, heights: [6, 4.5, 3], opening: 0.25, minPiece: 25, root: 0.5, faceTolerance: 0.02, eps: 0.001 });
    expect(CLIP).toMatchObject({ span: 40, margin: 3, turn: 20, corner: 15, cornerReach: 1.5, length: 6, flat: 0.4, sink: 0.2, every: 95, most: 8, key: 6, slot: 3, snap: { P: 0.4, floor: 0.1 }, light: { P: 0.25, floor: 0.05 } });
    expect(CLIP.lock).toEqual({ P: 0.4, floor: 0.1, bridge: 30, length: 8, retention: 60, lead: 30, overhang: 0.5 });
    expect(Object.isFrozen(LIP.heights) && Object.isFrozen(CLIP.snap) && Object.isFrozen(CLIP.lock)).toBe(true);
    expect(LIP_ALLOWANCE).toBe(6);
    expect(APART_COLOR).toBe(0x0d9488);
    // the interference is what the catch stands out past the clearance, never under a floor
    expect([0.05, 0.15, 0.3, 0.45].map((c) => catchSizes('snap', c))).toEqual([{ p: 0.4, i: 0.35 }, { p: 0.4, i: 0.25 }, { p: 0.4, i: 0.1 }, { p: 0.55, i: 0.1 }]);
    expect(catchSizes('light', 0.15)).toEqual({ p: 0.25, i: 0.1 });
    expect(catchSizes('lift', 0.15)).toBeNull();
    expect(lipSizesFor(0.15)).toEqual({ c: 0.15, hold: 'snap', t: 1.6, tMin: 1.2, wall: 1.2, skin: 0.8, g0: 0.1, d0: 1.85, p: 0.4, i: 0.25, gIn: 0.4 });
    expect(lipSizesFor(0.15, 0.4, 'lift')).toMatchObject({ p: 0, i: 0, gIn: 0.15 });
    // a wider nozzle: four and three of its lines, two of skin
    expect(lipSizesFor(0.15, 0.6, 'light')).toMatchObject({ t: 2.4, tMin: 1.8, wall: 1.8, skin: 1.2, d0: 2.65, i: 0.1, gIn: 0.25 });
    // how far the groove and a wall over it reach into the other piece
    expect([6, 4.5, 3].map((H) => lipReach(H).reach)).toEqual([9.35, 7.85, 6.35]);
    expect(lipReach(6)).toEqual({ zTop: 8.15, reach: 9.35 });
    expect(lipReach(6, 'opening', 0.15, 0.25, true).reach).toBe(9.55); // the tongue moved out by something over the opening
    expect(lipReach(6, 'opening', 0.15, 0, true).reach).toBe(9.35);
    expect(lipReach(6, 'channel').reach).toBe(7.35);
    expect(lipReach(6, 'opening', 0.5, catchSizes('snap', 0.5).i, true).reach).toBe(10.3); // the most any band reaches
  });

  it('a lock\'s catch stands out as far as Clicks on\'s, so its lip takes the same room; its clip is a shorter bridge with a longer catch, steep where it holds', () => {
    // the catch at the three clearances: Clicks on's, so the groove, the room to bow in and every reach are the same
    expect([0.05, 0.15, 0.3].map((c) => catchSizes('lock', c))).toEqual([{ p: 0.4, i: 0.35 }, { p: 0.4, i: 0.25 }, { p: 0.4, i: 0.1 }]);
    expect([0.05, 0.15, 0.3, 0.45].map((c) => catchSizes('lock', c))).toEqual([0.05, 0.15, 0.3, 0.45].map((c) => catchSizes('snap', c)));
    expect(lipSizesFor(0.15, 0.4, 'lock')).toEqual({ ...lipSizesFor(0.15, 0.4, 'snap'), hold: 'lock' });
    expect(lipReach(6, 'opening', 0.15, catchSizes('lock', 0.15).i, true)).toEqual(lipReach(6, 'opening', 0.15, catchSizes('snap', 0.15).i, true));
    // the clip whole: 1.6 mm thick, a 30 mm bridge, an 8 mm catch, 60° where it holds and 30° where the top goes on
    // over it
    expect([0.05, 0.15, 0.3].map((c) => clipShape('lock', c))).toEqual([
      { p: 0.4, i: 0.35, t: 1.6, span: 30, length: 8, retention: 60, lead: 30 },
      { p: 0.4, i: 0.25, t: 1.6, span: 30, length: 8, retention: 60, lead: 30 },
      { p: 0.4, i: 0.1, t: 1.6, span: 30, length: 8, retention: 60, lead: 30 },
    ]);
    // standing out more than half a millimetre (a clearance over 0.4) the steep flank would overhang further than a
    // printer draws out over the air, and the shallow one reach up into the tongue's lead-in: a plain catch there
    expect([0.4, 0.45, 0.5].map((c) => [clipShape('lock', c).p, clipShape('lock', c).retention, clipShape('lock', c).lead]))
      .toEqual([[0.5, 60, 30], [0.55, 45, 45], [0.6, 45, 45]]);
    expect(clipShape('snap', 0.15)).toEqual({ p: 0.4, i: 0.25, t: 1.6, span: 40, length: 6, retention: 45, lead: 45 });
    expect(clipShape('light', 0.15)).toEqual({ p: 0.25, i: 0.1, t: 1.6, span: 40, length: 6, retention: 45, lead: 45 });
    expect(clipShape('lift', 0.15)).toBeNull();
  });

  it('a lock holds about 5 kg on four clips, and presses on with under a third of that; Clicks on and Light click hold as they did', () => {
    const lock = clipShape('lock', 0.15);
    // pulled off: 40–70 N for a weak print, at most 130 N for a stiff one
    const pull = clipHold(4, lock);
    expect(pull).toBeGreaterThanOrEqual(40);
    expect(pull).toBeLessThanOrEqual(70);
    expect(pull).toBeCloseTo(49.2, 1);
    const stiff = clipHold(4, { ...lock, conservative: false });
    expect(stiff).toBeLessThanOrEqual(130);
    expect(stiff).toBeCloseTo(98.6, 1);
    // pressed on over the shallow flank: at most half the pull either way
    expect(clipPush(4, lock)).toBeCloseTo(14.6, 1);
    expect(clipPush(4, lock)).toBeLessThanOrEqual(pull / 2);
    expect(clipPush(4, { ...lock, conservative: false })).toBeLessThanOrEqual(stiff / 2);
    // past a 0.4 mm clearance the catch is a plain ramp both ways: it holds, and goes on, as hard as its 45° flanks and
    // stiffer bridge make it
    expect(clipHold(4, clipShape('lock', 0.45))).toBeCloseTo(10.0, 1);
    expect(clipPush(4, clipShape('lock', 0.45))).toBe(clipHold(4, clipShape('lock', 0.45)));
    // the plain catches: the same numbers from their shape as from the interference alone, and as hard on as off
    for (const [hold, want, wantStiff] of [['snap', 10.5, 18.3], ['light', 4.2, 7.3]]) {
      const shape = clipShape(hold, 0.15);
      expect(clipHold(4, shape)).toBe(clipHold(4, { i: shape.i }));
      expect(clipHold(4, { ...shape, conservative: false })).toBe(clipHold(4, { i: shape.i, conservative: false }));
      expect(clipHold(4, shape)).toBeCloseTo(want, 1);
      expect(clipHold(4, { ...shape, conservative: false })).toBeCloseTo(wantStiff, 1);
      expect(clipPush(4, shape)).toBe(clipHold(4, shape));
    }
    expect(clipPush(4, { i: 0 })).toBe(0);
  });

  it('a wider nozzle\'s thicker tongue has clips as thin as a 0.4 mm nozzle\'s, so they hold as hard: 49 N for four that lock, not 166 at 0.6 or 394 at 0.8', () => {
    // the tongue is four lines thick; its clips are 1.6 mm – a 0.8 mm nozzle's two lines – and two lines past that, a
    // lock's bridge then as much longer, up to 40 mm
    const at = (hold, nozzle, c = 0.15) => clipShape(hold, c, lipSizesFor(c, nozzle, hold).t);
    expect([0.4, 0.5, 0.6, 0.8, 1, 1.2].map((n) => lipSizesFor(0.15, n, 'lock').t)).toEqual([1.6, 2, 2.4, 3.2, 4, 4.8]);
    expect([0.4, 0.5, 0.6, 0.8, 1, 1.2].map((n) => [at('lock', n).t, at('lock', n).span])).toEqual([[1.6, 30], [1.6, 30], [1.6, 30], [1.6, 30], [2, 37.5], [2.4, 40]]);
    expect([0.4, 0.6, 0.8, 1].map((n) => [at('snap', n).t, at('snap', n).span])).toEqual([[1.6, 40], [1.6, 40], [1.6, 40], [2, 40]]);
    // so the hold, and the push to put it on, are the 0.4 mm nozzle's up to 1 mm for a lock and 0.8 mm for the others
    for (const n of [0.5, 0.6, 0.8, 1]) {
      expect(clipHold(4, at('lock', n))).toBeCloseTo(49.2, 1);
      expect(clipHold(4, { ...at('lock', n), conservative: false })).toBeCloseTo(98.6, 1);
      expect(clipPush(4, at('lock', n))).toBeCloseTo(14.6, 1);
    }
    for (const n of [0.6, 0.8]) expect(clipHold(4, at('snap', n))).toBeCloseTo(10.5, 1);
    // as the tongue alone would make them: three and a half and eight times as hard
    expect(clipHold(4, { ...at('lock', 0.6), t: 2.4 })).toBeCloseTo(166.2, 1);
    expect(clipHold(4, { ...at('lock', 0.8), t: 3.2 })).toBeCloseTo(393.9, 1);
    // and bent no further to let go, at any clearance: 24·i·y/L², y the clip's farthest fibre (0.83 on a 1.6 mm clip)
    for (const n of [0.6, 0.8, 1]) {
      for (let k = 0; k <= 10; k++) {
        const s = at('lock', n, k * 0.05);
        expect((24 * s.i * 0.83 * (s.t / 1.6)) / s.span ** 2).toBeLessThanOrEqual(0.009);
      }
    }
  });

  it('no clip bends more than 1.5 % to let go, at any clearance: a lock\'s shorter bridge bends more, still under 0.9 %', () => {
    // a bridge held at both ends, its middle pushed in by i: 24·i·y/L² at its ends and middle, y the clip's farthest
    // fibre from where it bends, 0.83 mm on a 1.6 mm tongue with its lead-in (measured from the built clip)
    const strain = (hold, c) => {
      const s = clipShape(hold, c);
      return s ? (24 * s.i * 0.83) / s.span ** 2 : 0;
    };
    // every hold at c = 0.05, 0.15 and 0.30 (%)
    expect(APART_HOLDS.map((h) => [0.05, 0.15, 0.3].map((c) => +(strain(h, c) * 100).toFixed(2)))).toEqual([[0.77, 0.55, 0.22], [0.44, 0.31, 0.12], [0.25, 0.12, 0.06], [0, 0, 0]]);
    // and every clearance Clearance allows, 0 to 0.5
    for (let k = 0; k <= 10; k++) for (const h of APART_HOLDS) expect(strain(h, k * 0.05)).toBeLessThanOrEqual(0.009);
  });

  it('how hard the clips hold, worked out from the clip\'s section: about 10.5 N for four that click on', () => {
    expect(clipHold(4, { i: 0.25 })).toBeCloseTo(10.5, 1);
    expect(clipHold(4, { i: 0.25, conservative: false })).toBeCloseTo(18.3, 1);
    expect(clipHold(1, { i: 0.25, conservative: false })).toBeCloseTo(4.57, 2);
    expect(clipHold(4, { i: 0.1 })).toBeCloseTo(4.2, 1); // Light click
    expect(clipHold(4, { i: 0.1, conservative: false })).toBeCloseTo(7.3, 1);
    expect(clipHold([{}, {}, {}, {}], { i: 0.25 })).toBe(clipHold(4, { i: 0.25 }));
    expect(clipHold(4, { i: 0 })).toBe(0);
    expect(clipHold(0, { i: 0.25 })).toBe(0);
    // a thicker tongue is stiffer as its cube
    expect(clipHold(4, { i: 0.25, t: 3.2 })).toBeCloseTo(8 * clipHold(4, { i: 0.25 }), 9);
  });

  it('the planner keeps the cuts that come apart where they are and plans the others round them', () => {
    // samples as the planner makes them, with the kept positions among them; no cost but the pull towards even pieces
    const plan = (lo, hi, k, S, at) => {
      const samples = planSamples(lo, hi, k);
      for (const f of at) if (!samples.some((t) => Math.abs(t - f) < 1e-9)) samples.push(f);
      samples.sort((p, q) => p - q);
      const fixed = at.map((f) => samples.findIndex((t) => Math.abs(t - f) < 1e-9));
      return chooseOffsets(samples, samples.map(() => 0), { lo, hi, k, S, minEnd: 10, minMid: 20, fixed });
    };
    const offsets = (r) => r?.offsets.map((t) => Math.round(t * 10) / 10) ?? null;
    // a 291 mm lantern whose top comes off at 190: on the A1 mini the other cut goes at 97, under it
    expect(offsets(plan(0, 291, 1, 249, [190]))).toEqual([190]);
    expect(plan(0, 291, 2, 179, [190])).toMatchObject({ reach: [null, [6, 0]], relaxed: false });
    expect(offsets(plan(0, 291, 2, 179, [190]))).toEqual([97, 190]);
    expect(offsets(plan(0, 291, 2, 179, [60]))).toEqual([60, 194]);
    // a 400 mm bar on a 210 mm bed
    expect(offsets(plan(0, 400, 2, 210, [300]))).toEqual([133.3, 300]);
    expect(offsets(plan(0, 400, 2, 210, [50]))).toEqual([50, 258.7]);
    expect(plan(0, 400, 3, 150, [50, 350])).toMatchObject({ reach: [[6, 0], null, [0, 6]] });
    expect(offsets(plan(0, 400, 3, 150, [50, 350]))).toEqual([50, 200, 350]);
    // one cut that must be at 100 leaves 300 mm: no plan, and the next grid is tried
    expect(plan(0, 400, 1, 210, [100])).toBeNull();
    // without the rule the even cuts win, and a cut that must stay where tabs would be counted reaches as a lip
    const samples = planSamples(0, 400, 2);
    const zero = samples.map(() => 0);
    expect(chooseOffsets(samples, zero, { lo: 0, hi: 400, k: 2, S: 210 }).offsets.map(Math.round)).toEqual([133, 267]);
    const at = samples.findIndex((t) => t >= 100);
    const tabs = samples.map(() => ({ below: 8, above: 8, w: 2 }));
    const kept = chooseOffsets(samples, zero, { lo: 0, hi: 400, k: 2, S: 210, grow: tabs, fixed: [at] });
    expect(kept.offsets[0]).toBe(samples[at]);
    expect(kept.reach).toEqual([[6, 0], [8, 8]]);
  });

  it('Fit to my printer\'s grids never have fewer cuts on an axis than stay there, and its plans keep them', () => {
    const E = [110, 110, 291];
    // even the default printer needs one cut in the 291 mm lantern; with two kept on Z it needs no fewer than two
    expect(gridCandidates(E, U)[0]).toEqual({ k: [0, 0, 1], pieces: 2 });
    expect(gridCandidates(E, U, { minCounts: [0, 0, 1] })[0]).toEqual({ k: [0, 0, 1], pieces: 2 });
    expect(gridCandidates(E, U, { minCounts: [0, 0, 2] }).map((c) => c.k[2])).toEqual(expect.not.arrayContaining([0, 1]));
    expect(gridCandidates(E, U, { minCounts: [0, 0, 2] })[0]).toEqual({ k: [0, 0, 2], pieces: 3 });
    expect(gridCandidates([300, 40, 20], U, { minCounts: [0, 1, 0] }).every((c) => c.k[1] >= 1)).toBe(true);
    expect(gridCandidates([400, 100, 4], U, { flat: 2, minCounts: [0, 0, 1] })).toEqual([]); // never cut through a plate's thickness
    // the lantern on the A1 mini, its top coming off at 190: one cut is no plan, two put the other at 97
    const bounds = { min: [-55, -55, 0], max: [55, 55, 291] };
    const profileOf = (kept) => (a, k) => {
      const list = planSamples(bounds.min[a], bounds.max[a], k);
      for (const f of a === 2 ? kept : []) if (!list.some((t) => Math.abs(t - f) < 1e-9)) list.push(f);
      list.sort((p, q) => p - q);
      return { samples: list, costs: list.map(() => 0), tabs: list.map(() => null) };
    };
    const fixed = [[], [], [190]];
    expect(planGrid([0, 0, 1], { E, U: MINI, bounds, profileOf: profileOf([190]), fixed })).toBeNull();
    const two = planGrid([0, 0, 2], { E, U: MINI, bounds, profileOf: profileOf([190]), fixed });
    expect(two.offsets).toEqual([[], [], [97, 190]]);
    // the piece beside the kept cut that carries its tongue is 6 mm longer, and every piece fits
    expect(two.pieces.map((x) => x.size[2])).toEqual([97, 99, 101]);
    expect(two.pieces.every((x) => x.fits)).toBe(true);
    expect(planGrid([0, 0, 2], { E, U: MINI, bounds, profileOf: profileOf([]) }).offsets).toEqual([[], [], [97, 194]]);
    // on the default printer the kept cut is the plan
    const one = planGrid([0, 0, 1], { E, U, bounds, profileOf: profileOf([190]), fixed });
    expect(one.offsets).toEqual([[], [], [190]]);
    expect(one.pieces.map((x) => x.size)).toEqual([[110, 110, 196], [110, 110, 101]]);
    // a grid with no cut on the kept cut's axis, or samples that miss it, is no plan
    expect(planGrid([1, 0, 0], { E, U, bounds, profileOf: profileOf([190]), fixed })).toBeNull();
    expect(planGrid([0, 0, 1], { E, U, bounds, profileOf: profileOf([]), fixed })).toBeNull();
  });

  it('the lip goes on the piece that prints as well standing on its far end: the lantern\'s body, the box\'s lid', () => {
    const pair = { axis: 2, lo: 1, hi: 2 };
    // the body stands on its foot, the lip up, as it would anyway; its top would stand on the point of its roof
    const lantern = laidOf([{ index: 1, stats: body }, { index: 2, cell: [0, 0, 1], stats: top }]);
    expect(lantern.map((p) => [p.lying.down, p.lying.lies])).toEqual([['-z', 'flat as modelled'], ['-z', 'on a cut face']]);
    expect(chooseOrientation(statsWithLip(top, '-z'), U)).toMatchObject({ down: '+z', lies: 'on a curve' });
    expect(apartMales(lantern, U)([pair])).toEqual([{ male: 0, piece: 1, down: '-z' }]);
    // on the A1 mini the body fits no way, with the lip or without: it still prints as well, and carries it
    const mini = laidOf([{ index: 1, stats: body }, { index: 2, cell: [0, 0, 1], stats: top }], MINI);
    expect(mini.map((p) => p.lying.fits)).toEqual([false, true]);
    expect(apartMales(mini, MINI)([pair])).toEqual([{ male: 0, piece: 1, down: '-z' }]);
    // a box with an 8 mm lid: both print as well with the lip, the lid lying on its top, so the better lip decides – a
    // 6 mm one with clips in the lid, against 4.5 mm with none on the box, the lid having no room for its groove
    const boxed = laidOf([{ index: 1, stats: box }, { index: 2, cell: [0, 0, 1], stats: lid }]);
    expect(boxed.map((p) => p.lying.down)).toEqual(['-z', '+z']);
    const quality = [{ H: 4.5, clips: 0, area: 1100 }, { H: 6, clips: 4, area: 1150 }];
    expect(apartMales(boxed, U)([{ ...pair, quality }])).toEqual([{ male: 1, piece: 2, down: '+z' }]);
    // as good a lip both ways: the lower piece; one with clips over one without, whatever the heights
    expect(apartMales(boxed, U)([pair])).toEqual([{ male: 0, piece: 1, down: '-z' }]);
    expect(apartMales(boxed, U)([{ ...pair, quality: [{ H: 6, clips: 4, area: 1100 }, { H: 6, clips: 4, area: 1150 }] }])[0].male).toBe(1);
    expect(apartMales(boxed, U)([{ ...pair, quality: [{ H: 6, clips: 0, area: 1100 }, { H: 4.5, clips: 2, area: 900 }] }])[0].male).toBe(1);
    // printing as well comes first: the lantern's top keeps standing on its cut face though its lip would be better
    expect(apartMales(lantern, U)([{ ...pair, quality: [{ H: 3, clips: 0, area: 400 }, { H: 6, clips: 4, area: 590 }] }])[0].male).toBe(0);
    // a piece with no lip on offer is no male: the other, or none. When the other prints worse with it (the lantern's
    // top on its handle) and the one that prints as well has no room for the groove past the cut, that one is named too,
    // so that the layout can move the cut to where it has (a cut just under the roof's eaves)
    expect(apartMales(lantern, U)([{ ...pair, quality: [null, { H: 6, clips: 4, area: 590 }] }]))
      .toEqual([{ male: 1, piece: 2, down: '+z', alt: { k: 0, piece: 1, down: '-z', why: 'room' } }]);
    expect(apartMales(lantern, U)([{ ...pair, quality: [null, null] }])).toEqual([null]);
    // the box's lid prints as well with the lip: nothing to move for
    expect(apartMales(boxed, U)([{ ...pair, quality: [null, { H: 6, clips: 4, area: 1150 }] }])).toEqual([{ male: 1, piece: 2, down: '+z' }]);
  });

  it('the measure counts a lip on the piece that will carry it, as the pieces or the boxes between the cuts tell', () => {
    const cut = (at, hold = 'snap') => ({ id: 'c1', letter: 'A', axis: 2, at, apart: { hold } });
    // the lantern's body has the length past the cut for a full groove in its top, and prints as well with the lip
    const lantern = laidOf([{ index: 1, stats: body }, { index: 2, cell: [0, 0, 1], stats: top }]);
    expect(lipSides(lantern, [cut(190)], U)).toEqual(new Map([['c1', 0]]));
    // a box's 8 mm lid leaves the box's lip 7.85 mm of groove, a 4.5 mm lip with no clips: the lid carries a full one
    const boxed = laidOf([{ index: 1, stats: box }, { index: 2, cell: [0, 0, 1], stats: lid }]);
    expect(lipSides(boxed, [cut(52)], U)).toEqual(new Map([['c1', 1]]));
    // without the pieces, the boxes between the cuts stand in for them
    const bounds = { min: [-40, -40, 0], max: [40, 40, 60] };
    expect(lipSides(null, [cut(52)], null, 'auto', { bounds })).toEqual(new Map([['c1', 1]]));
    expect(lipSides(null, [cut(30)], null, 'auto', { bounds })).toEqual(new Map([['c1', 0]]));
    // 5 mm from the end either way: no lip at all
    expect(lipSides(null, [cut(55)], null, 'auto', { bounds: { min: [-40, -40, 50], max: [40, 40, 60] } })).toEqual(new Map([['c1', null]]));
  });

  it('a piece that cannot lie with the lip standing up, or no longer fits so, is no male; one given a way down keeps it', () => {
    const pair = { axis: 2, lo: 1, hi: 2 };
    // the top would stand on its roof's point but fits; the body, held to lying on its side (a dovetail seam), cannot
    const held = laidOf([{ index: 1, stats: { ...body, allowed: ['-x', '+x'] } }, { index: 2, cell: [0, 0, 1], stats: top }]);
    expect(statsWithLip(held[0].stats, '+z')).toBeNull();
    expect(apartMales(held, U)([pair])).toEqual([{ male: 1, piece: 2, down: '+z' }]);
    // a body 6 mm short of the bed's height no longer fits with the lip
    const tall = boxStats([100, 100, 245], ['+z']);
    const lidded = laidOf([{ index: 1, stats: tall }, { index: 2, cell: [0, 0, 1], stats: boxStats([100, 100, 20], ['-z'], { '+z': { bed: 0, support: 9000 } }) }]);
    expect(lidded[0].lying.fits).toBe(true);
    expect(chooseOrientation(statsWithLip(tall, '+z'), U).fits).toBe(false);
    expect(apartMales(lidded, U)([pair])[0]).toMatchObject({ male: 1, down: '+z' });
    // the lid then lies on its top with nothing under it: the body, 2 mm too tall with the lip, is named, and how much
    expect(apartMales(lidded, U)([pair])[0].alt).toEqual({ k: 0, piece: 1, down: '-z', why: 'tall', over: 2 });
    // neither: no lip
    const both = laidOf([{ index: 1, stats: { ...body, allowed: ['-x'] } }, { index: 2, cell: [0, 0, 1], stats: { ...top, allowed: ['-z'] } }]);
    expect(apartMales(both, U)([pair])).toEqual([null]);
    // three pieces with two cuts that come apart: the middle one, given the first cut's lip lying on its top, cannot take
    // the second's too, which would stand it on its foot – that goes on the top piece
    const ring = boxStats([100, 100, 90], ['-z', '+z']);
    const stack = laidOf([
      { index: 1, stats: boxStats([100, 100, 100], ['+z']) }, { index: 2, cell: [0, 0, 1], stats: ring }, { index: 3, cell: [0, 0, 2], stats: boxStats([100, 100, 20], ['-z']) },
    ]);
    const pairs = [{ axis: 2, lo: 1, hi: 2, quality: [null, { H: 6, clips: 4, area: 500 }] }, { axis: 2, lo: 2, hi: 3 }];
    expect(apartMales(stack, U)(pairs)).toEqual([{ male: 1, piece: 2, down: '+z' }, { male: 1, piece: 3, down: '+z' }]);
    expect(apartMales(stack, U)([pairs[1]])).toEqual([{ male: 0, piece: 2, down: '-z' }]);
    // so does a piece given its way down by an earlier cut's lips, the layout asking cut by cut
    expect(apartMales(stack, U)([pairs[1]], new Map([[2, '+z']]))).toEqual([{ male: 1, piece: 3, down: '+z' }]);
    // and with no lip on the top piece either, the second cut has none
    expect(apartMales(stack, U)([pairs[0], { ...pairs[1], quality: [{ H: 6, clips: 4, area: 500 }, null] }])).toEqual([{ male: 1, piece: 2, down: '+z' }, null]);
    // a piece of several shells only where every one of them rests on the bed lying so
    const shells = [{ min: [0, 0, 0], max: [100, 100, 90] }, { min: [0, 0, 50], max: [10, 10, 90] }];
    const parted = laidOf([{ index: 1, stats: ring, boxes: shells }, { index: 2, cell: [0, 0, 1], stats: boxStats([100, 100, 20], ['-z']) }]);
    expect(statsWithLip(ring, '+z', 6, shells)).toBeNull();
    expect(statsWithLip(ring, '-z', 6, shells).allowed).toEqual(['+z']);
    expect(apartMales(parted, U)([{ axis: 2, lo: 1, hi: 2 }])).toEqual([{ male: 1, piece: 2, down: '+z' }]);
  });

  it('where a lip would get no clips the twist-lock takes their place: it ranks as clips do, its socket\'s piece lies on its cut face, and the pieces are laid so', () => {
    const pair = { axis: 2, lo: 1, hi: 2 };
    const lantern = laidOf([{ index: 1, stats: body }, { index: 2, cell: [0, 0, 1], stats: top }]);
    const clipless = { H: 6, clips: 0, area: 590 };
    const twisted = { ...clipless, twist: true };
    // the body carries the neck, standing on its foot; the top, which lies on its cut face anyway, takes the socket
    expect(apartMales(lantern, U)([{ ...pair, quality: [twisted, clipless] }])).toEqual([{ male: 0, piece: 1, down: '-z', twist: true }]);
    // it counts as clips do: over a taller lip without them – of two halves that print alike the taller lip goes on,
    // but a shorter one with the twist-lock beats it – and with no lip at all (a cut through an eave)
    const halves = laidOf([{ index: 1, stats: boxStats([100, 100, 100], ['+z']) }, { index: 2, cell: [0, 0, 1], stats: boxStats([100, 100, 100], ['-z']) }]);
    expect(apartMales(halves, U)([{ ...pair, quality: [clipless, { ...clipless, H: 4.5 }] }])).toEqual([{ male: 0, piece: 1, down: '-z' }]);
    expect(apartMales(halves, U)([{ ...pair, quality: [clipless, { ...twisted, H: 4.5 }] }])).toEqual([{ male: 1, piece: 2, down: '+z', twist: true }]);
    expect(apartMales(lantern, U)([{ ...pair, quality: [{ H: 0, clips: 0, area: 0, twist: true }, null] }])).toEqual([{ male: 0, piece: 1, down: '-z', twist: true }]);
    // the piece its socket goes into lies on its cut face: a box's lid, or the box under it, would hang its top or its
    // floor over its inside so, and the lock is not counted – the lip without clips is ranked as it was, and a
    // twist-lock with no lip is none
    const boxed = laidOf([{ index: 1, stats: box }, { index: 2, cell: [0, 0, 1], stats: lid }]);
    expect(apartMales(boxed, U)([{ ...pair, quality: [{ ...clipless, H: 4.5 }, twisted] }])).toEqual([{ male: 1, piece: 2, down: '+z' }]);
    expect(apartMales(boxed, U)([{ ...pair, quality: [twisted, null] }])).toEqual([{ male: 0, piece: 1, down: '-z' }]);
    expect(apartMales(boxed, U)([{ ...pair, quality: [{ H: 0, clips: 0, area: 0, twist: true }, null] }])).toEqual([null]);
    // and it keeps that way down: a ring with the socket of the cut under it lies on its foot, so the cut over it may
    // not put another socket in its top, which would turn it over – that one keeps its lip
    const ring = boxStats([100, 100, 90], ['-z', '+z']);
    const stack = laidOf([
      { index: 1, stats: boxStats([100, 100, 100], ['+z']) }, { index: 2, cell: [0, 0, 1], stats: ring }, { index: 3, cell: [0, 0, 2], stats: boxStats([100, 100, 20], ['-z']) },
    ]);
    const pairs = [{ axis: 2, lo: 1, hi: 2, quality: [twisted, null] }, { axis: 2, lo: 2, hi: 3, quality: [null, twisted] }];
    expect(apartMales(stack, U)([pairs[1]])).toEqual([{ male: 1, piece: 3, down: '+z', twist: true }]);
    expect(apartMales(stack, U)(pairs)).toEqual([{ male: 0, piece: 1, down: '-z', twist: true }, { male: 1, piece: 3, down: '+z' }]);
    // the probe's choice before the model is cut ranks it alike, and guesses the socket's piece from the model's ends
    expect(lipMale([{ H: 0, clips: 0, area: 0, twist: true }, clipless], [true, true])).toEqual({ male: 0, alt: null });
    expect(lipMale([clipless, twisted], [true, true])).toEqual({ male: 1, alt: null });
    expect(socketsAsWell([10000, 0], 1728)).toEqual([false, true]);
    // an end no larger than the face lies as well either way – an open tube's rim, a solid cylinder's end – and one
    // larger would hang past the face upside down: a closed tube's
    expect(socketsAsWell([800, 1600], 1728)).toEqual([true, true]);
    expect(socketsAsWell([1728, 1728], 1728)).toEqual([true, true]);
    expect(socketsAsWell([1900, 20], 1728)).toEqual([false, true]);
    // and a spot with it scores as one with clips
    expect(spotScore({ clips: 0, twist: true, shift: 3.92, distance: 9.5, fraction: 0.28 })).toBe(spotScore({ clips: 4, shift: 3.92, distance: 9.5, fraction: 0.28 }));
    // laid: the neck stands 2.4 mm out of the body's face, the cut's lip given way to it; the top lies on its cut face
    const lock = { kind: 'full', cutId: 'c1', down: '-z', S: { H: 2.4 }, sides: [{ piece: 1, role: 'body' }, { piece: 2, role: 'part' }] };
    const lip = { cutId: 'c1', letter: 'A', axis: 2, at: 190, dir: 1, male: 0, down: '-z', H: 6, twist: true, sides: [{ piece: 1, male: true }, { piece: 2, male: false }] };
    const [neck, socket] = layGrown(lantern, { lips: [lip], locks: [lock] }, U);
    expect(neck).toMatchObject({ lip: true, down: '-z', size: [100, 100, 192.4] });
    expect(socket).toMatchObject({ down: '-z', lies: 'on a cut face' });
    // a part's lock is no full-plane cut's: the lip stands
    expect(layGrown(lantern, { lips: [lip], locks: [{ ...lock, kind: 'lid' }] }, U)[0].size).toEqual([100, 100, 196]);
    // a top that would rather lie on its roof lies on its cut face for the socket all the same
    const capped = laidOf([{ index: 1, stats: box }, { index: 2, cell: [0, 0, 1], stats: lid }]);
    expect(capped[1].lying.down).toBe('+z');
    expect(layGrown(capped, { lips: [], locks: [lock] }, U)[1]).toMatchObject({ down: '-z' });
    // across X, set to lie as modelled: the socket's piece lies on its cut face all the same, and no note says the
    // printer would not let it lie as modelled – the lock is why
    const across = laidOf([{ index: 1, stats: boxStats([100, 100, 100], ['+x']) }, { index: 2, cell: [1, 0, 0], stats: boxStats([60, 100, 100], ['-x']) }]);
    const onSide = layGrown(across, { lips: [], locks: [{ ...lock, down: '-x' }] }, U, 'model')[1];
    expect(onSide).toMatchObject({ down: '-x', lies: 'on a cut face' });
    expect(onSide.notes).toEqual([]);
  });

  it('says how a twist-lock in place of clips goes on and comes off: the note, the glue step and the sheet', () => {
    const note = (fields) => splitNote('APART_TWIST', { letter: 'A', cutId: 'c1', turn: 10, tabs: 6, ...fields });
    const how = 'To fit it: set it on turned 10° to the left so the wide lug finds its wide slot, push down and turn it right until it clicks. To open it: turn it left until it clicks again and lift it off.';
    expect(note({ axis: 2, male: 1, female: 2 })).toMatchObject({ level: 'info', code: 'APART_TWIST', text: `Cut A comes apart: the top (piece 2) twist-locks onto piece 1 – 3 lugs and 6 clicks, as no clip fits its wall. ${how}` });
    // stood on its head the neck is on the top, and the piece under it goes on; across X the piece with the socket
    expect(note({ axis: 2, above: true, male: 2, female: 1 }).text).toBe(`Cut A comes apart: piece 1 twist-locks onto the top (piece 2) – 3 lugs and 6 clicks, as no clip fits its wall. ${how}`);
    expect(note({ axis: 0, male: 1, female: 2, tabs: 3, turn: 27 }).text).toMatch(/^Cut A comes apart: piece 2 twist-locks onto piece 1 – 3 lugs and 3 clicks, as no clip fits its wall\. To fit it: set it on turned 27°/);
    const pieces = [{ index: 1, cell: [0, 0, 0], size: [100, 100, 152.4], lies: 'flat as modelled', fits: true }, { index: 2, cell: [0, 0, 1], size: [100, 100, 88], lies: 'on a cut face', fits: true }];
    const apart = { hold: 'lock', lip: false, clips: 0, height: 0, mech: 'twist', theta: 10, tabs: 6 };
    const seam = { letter: 'A', axis: 2, at: 150, pieces: [1, 2], joint: 'lip', dowels: 0, male: 1, labels: null, apart };
    const step = 'Do not glue cut A: it comes apart. The top: set it on turned 10° to the left so the wide lug finds its wide slot, push down and turn it right until it clicks. To open: turn it left until it clicks again and lift it off.';
    expect(assemblySteps({ pieces, seams: [seam] })).toEqual([{ letter: 'A', axis: 2, pieces: [1], joins: [2], pins: 0, pegs: 0, text: step, apart: true }]);
    expect(assemblySteps({ pieces, seams: [{ ...seam, male: 2 }] })[0].text).toMatch(/^Do not glue cut A: it comes apart\. Piece 1: set it on turned 10°/);
    expect(assemblySteps({ pieces, seams: [{ ...seam, axis: 0 }] })[0].text).toMatch(/^Do not glue cut A: it comes apart\. Piece 2: set it on/);
    const sheet = howToGlueText({ name: 'round', pieces, seams: [seam] });
    expect(sheet).toContain('PRINT (each file is already turned the way to print it; twist-locks need no supports)');
    expect(sheet).toMatch(/piece 1 of 2 .* fits, twist-lock neck for cut A/);
    expect(sheet).toMatch(/piece 2 of 2 .* fits, comes off at cut A/);
    expect(sheet).toContain('  The top of cut A should twist on with a click and twist off again by hand. Too stiff to turn: raise Clearance by 0.05 mm; loose, or no click: lower it by 0.05 mm, and download again.');
    expect(sheet).toContain(`  1. ${step}`);
    expect(sheet).not.toContain('lip');
  });

  it('a piece carrying a lip is laid again with it standing up: its size counts it, and the lip is why it lies so', () => {
    const lantern = laidOf([{ index: 1, stats: body }, { index: 2, cell: [0, 0, 1], stats: top }]);
    const lip = { cutId: 'c1', letter: 'A', axis: 2, at: 190, dir: 1, male: 1, down: '-z', H: 6, sides: [{ piece: 1, male: true }, { piece: 2, male: false }] };
    const grown = statsWithLip(body, '+z');
    expect(grown.bbox.max[2]).toBe(196);
    expect(grown.dims).toEqual([100, 100, 196]);
    expect(grown.dirs['-z'].extent).toBe(196);
    expect(grown.allowed).toEqual(['-z']);
    const [male, female] = layGrown(lantern, { lips: [lip] }, U);
    expect(male).toMatchObject({ lip: true, down: '-z', fits: true, size: [100, 100, 196], notes: [] });
    expect(male).not.toHaveProperty('pegged');
    expect(female).toBe(lantern[1].lying);
    // a shorter lip counts as itself, a male above the cut lies on its far end, and one with no lip is as it was
    expect(layGrown(lantern, { lips: [{ ...lip, H: 4.5 }] }, U)[0].size).toEqual([100, 100, 194.5]);
    const above = { ...lip, dir: -1, male: 2, down: undefined, sides: [{ piece: 1, male: false }, { piece: 2, male: true }] };
    expect(layGrown(lantern, { lips: [above] }, U)[1]).toMatchObject({ lip: true, down: '+z', size: [110, 110, 76] });
    expect(layGrown(lantern, { lips: [{ ...lip, H: 0 }] }, U)[0]).toBe(lantern[0].lying);
    // a cut through four posts gives the piece below a lip on each of its four faces, all standing out of one plane:
    // its box takes in one lip, the tallest, not four
    const posts = [0, 1, 2, 3].map((patch) => ({ ...lip, patch, H: patch === 2 ? 4.5 : 6 }));
    expect(layGrown(lantern, { lips: posts }, U)[0].size).toEqual([100, 100, 196]);
    expect(layGrown(lantern, { lips: posts.map((l) => ({ ...l, H: 4.5 })) }, U)[0].size).toEqual([100, 100, 194.5]);
    // asked to lie on its cut faces, the body cannot with the lip up – which goes without saying
    const cutFirst = laidOf([{ index: 1, stats: body }], U, 'cut');
    expect(cutFirst[0].lying.down).toBe('+z');
    expect(chooseOrientation(grown, U, 'cut').notes.map((n) => n.code)).toEqual(['ORIENT_FALLBACK']);
    expect(layGrown(cutFirst, { lips: [lip] }, U, 'cut')[0]).toMatchObject({ down: '-z', notes: [] });
    // a dome's half that carries the lip stands on its curve: the lip, not its shape, is why
    const curved = { bed: 0, support: 6000 };
    const dome = boxStats([70, 70, 55], ['-z'], { '+z': curved, '-x': curved, '+x': curved, '-y': curved, '+y': curved });
    const laid = laidOf([{ index: 1, stats: dome }]);
    expect(laid[0].lying).toMatchObject({ down: '-z', notes: [] });
    const [o] = layGrown(laid, { lips: [{ ...lip, dir: -1, down: '+z', sides: [{ piece: 1, male: true }] }] }, U);
    expect(o.notes).toEqual([expect.objectContaining({ code: 'PIECE_UNSTABLE', level: 'warn', pieceIndex: 1, lip: true })]);
    expect(o.notes[0].text).toBe('Piece 1 has nothing flat to stand on but the face its lip stands out of – it rests on a curve or an edge and needs supports.');
    // pegs and a lip on one piece: both in its box, never on the pegs' face
    const pegs = [{ axis: 0, at: 50, centre: [50, 0, 100], s: 6, length: 9, dir: 1, sides: [{ piece: 1, peg: true }] }];
    expect(layGrown(lantern, { pegs, lips: [lip] }, U)[0]).toMatchObject({ lip: true, pegged: true, down: '-z', size: [109, 100, 196] });
    // the pegs alone, as before
    expect(layGrown(lantern, { pegs }, U)[0]).toEqual(layPegged(lantern, pegs, U)[0]);
    expect(layPegged(lantern, pegs, U)[1]).toBe(lantern[1].lying);
  });

  it('pegs keep off the face a piece must lie on for its lip', () => {
    // pegs across a cut under a ring whose top has a lip: the ring would carry them, as the piece under it lies on that
    // face, but lying on its foot for the lip it cannot – so the piece under it does
    const curved = { bed: 0, support: 6000 };
    const under = boxStats([100, 100, 60], ['+z'], { '-z': curved, '-x': curved, '+x': curved, '-y': curved, '+y': curved });
    const ring = boxStats([100, 100, 90], ['-z', '+z']);
    const laid = laidOf([{ index: 1, stats: under }, { index: 2, cell: [0, 0, 1], stats: ring }]);
    expect(laid.map((p) => p.lying.down)).toEqual(['+z', '-z']);
    const pair = { axis: 2, lo: 1, hi: 2 };
    expect(pegMales(laid, U)([pair])).toEqual([1]);
    expect(pegMales(laid, U, 'auto', { forced: new Map([[2, '-z']]) })([pair])).toEqual([0]);
    expect(pegMales(laid, U, 'auto', { forced: new Map() })([pair])).toEqual([1]);
  });

  it('the notes say which piece comes off, what holds it and what to do when nothing can', () => {
    const note = (code, fields) => splitNote(code, { letter: 'A', cutId: 'c1', ...fields });
    expect(note('APART', { axis: 2, male: 1, female: 2, hold: 'snap', clips: 4, height: 6, faces: 1, flat: 0 })).toMatchObject({
      level: 'info', code: 'APART', male: 1, clips: 4,
      text: 'Cut A comes apart: the top (piece 2) clicks onto a 6 mm lip on piece 1 – 4 clips hold it, and it pulls off again by hand.',
    });
    expect(note('APART', { axis: 2, male: 1, female: 2, hold: 'light', clips: 4, height: 6 }).text)
      .toBe('Cut A comes apart: the top (piece 2) clicks lightly onto a 6 mm lip on piece 1 – 4 clips hold it, and it pulls off again by hand.');
    expect(note('APART', { axis: 2, male: 1, female: 2, hold: 'lift', clips: 0, height: 6 }).text)
      .toBe('Cut A comes apart: the top (piece 2) sits on a 6 mm lip on piece 1 and lifts straight off.');
    expect(note('APART', { axis: 2, male: 1, female: 2, hold: 'snap', clips: 0, height: 4.5 }).text)
      .toBe('Cut A comes apart: the top (piece 2) sits on a 4.5 mm lip on piece 1 and lifts straight off.');
    expect(note('APART', { axis: 2, male: 1, female: 2, hold: 'snap', clips: 1, height: 6 }).text)
      .toBe('Cut A comes apart: the top (piece 2) clicks onto a 6 mm lip on piece 1 – 1 clip holds it, on one side only, and it pulls off again by hand.');
    expect(note('APART', { axis: 0, male: 1, female: 2, hold: 'snap', clips: 2, height: 6, flat: 3 }).text)
      .toBe('Cut A comes apart: piece 2 clicks onto a 6 mm lip on piece 1 – 2 clips hold it, and it pulls off again by hand. 3 small faces beside it just rest on each other.');
    expect(note('APART', { axis: 2, above: true, male: 2, female: 1, hold: 'snap', clips: 4, height: 6, flat: 1 }).text)
      .toBe('Cut A comes apart: the top (piece 2) clicks into piece 1 on a 6 mm lip – 4 clips hold it, and it pulls off again by hand. 1 small face beside it just rests on the other piece.');
    expect(note('APART', { axis: 2, above: true, male: 2, female: 1, hold: 'lift', height: 6 }).text).toBe('Cut A comes apart: the top (piece 2) sits in piece 1 on a 6 mm lip and lifts straight off.');
    expect(note('APART', { letter: 'B', axis: 2, male: [1, 2], female: [3, 4], hold: 'snap', clips: 6, height: 6, faces: 2 }).text)
      .toBe('Cut B comes apart: the top (pieces 3 and 4) clicks onto a 6 mm lip on pieces 1 and 2 – 6 clips hold it, and it pulls off again by hand.');
    // across X or Y several pieces come off together, and the note says they click
    expect(note('APART', { letter: 'B', axis: 0, male: [1, 3], female: [2, 4], hold: 'snap', clips: 3, height: 6, faces: 2 }).text)
      .toBe('Cut B comes apart: pieces 2 and 4 click onto a 6 mm lip on pieces 1 and 3 – 3 clips hold them, and they pull off again by hand.');
    expect(note('APART', { axis: 1, male: [1, 3], female: [2, 4], hold: 'light', clips: 1, height: 6 }).text)
      .toBe('Cut A comes apart: pieces 2 and 4 click lightly onto a 6 mm lip on pieces 1 and 3 – 1 clip holds them, on one side only, and they pull off again by hand.');
    expect(note('APART', { axis: 0, male: [1, 3], female: [2, 4], hold: 'lift', height: 6 }).text).toBe('Cut A comes apart: pieces 2 and 4 sit on a 6 mm lip on pieces 1 and 3 and lift straight off.');
    expect(note('APART_NO_CLIPS', { axis: 0, female: [2, 4], why: 'short' }).text).toBe('Cut A\'s lip has no straight stretch 46 mm long for a clip, so pieces 2 and 4 just lift off.');
    expect(note('APART_FLAT', { axis: 0, pieces: [[1, 3], [2, 4]], why: 'thin', wall: 2.7 }).text)
      .toBe('Cut A has no room for a lip – its walls are under 2.7 mm thick – so pieces 2 and 4 just rest on pieces 1 and 3, with nothing to line it up or hold it.');
    // a face of the cut whose pieces already lie another way for another cut's lip is told apart from a small one
    expect(note('APART', { axis: 2, male: 2, female: 4, hold: 'snap', clips: 3, height: 6, faces: 1, lying: 1 }).text)
      .toBe('Cut A comes apart: the top (piece 4) clicks onto a 6 mm lip on piece 2 – 3 clips hold it, and it pulls off again by hand. On 1 other face neither piece can lie with a lip standing up, so the pieces there just rest on each other.');

    expect(note('APART_NO_CLIPS', { axis: 2, female: 2, why: 'height', height: 4.5, need: 9.35, suggestedAt: 190.5 })).toMatchObject({
      level: 'warn', suggestedAt: 190.5,
      text: 'Cut A\'s lip is only 4.5 mm tall, so it has no clips and the top just lifts off: a lip that clicks on needs 9.4 mm of plain wall in piece 2 past the cut. Move the cut to 190.5 mm.',
    });
    expect(note('APART_NO_CLIPS', { axis: 2, why: 'short' }).text).toBe('Cut A\'s lip has no straight stretch 46 mm long for a clip, so the top just lifts off.');
    expect(note('APART_NO_CLIPS', { axis: 2, why: 'flex', suggestedAt: 160.5 }).text)
      .toBe('Cut A\'s lip has no room for clips – something over the opening just above the cut leaves them no room to bow in – so the top just lifts off. Move the cut to 160.5 mm.');
    expect(note('APART_NO_CLIPS', { axis: 2, why: 'skin' }).text).toBe('Cut A\'s walls are too thin for the clips\' catches, so the top just lifts off.');
    expect(note('APART_NO_CLIPS', { axis: 1, female: 3, why: 'skin' }).text).toBe('Cut A\'s walls are too thin for the clips\' catches, so piece 3 just lifts off.');

    expect(note('APART_FLAT', { axis: 2, pieces: [1, 2], why: 'thin', wall: 2.7 })).toMatchObject({
      level: 'warn', text: 'Cut A has no room for a lip – its walls are under 2.7 mm thick – so the top just rests on piece 1, with nothing to line it up or hold it.',
    });
    expect(note('APART_FLAT', { axis: 0, pieces: [1, 2], why: 'thin', wall: 2 }).text)
      .toBe('Cut A has no room for a lip – its walls are under 2 mm thick – so piece 2 just rests on piece 1, with nothing to line it up or hold it.');
    expect(note('APART_FLAT', { axis: 2, pieces: [1, 2], why: 'room', need: 6.35, suggestedAt: 190.5 }).text)
      .toBe('Cut A has no room for a lip – piece 2 has under 6.4 mm of plain wall past the cut before a roof, a ledge or an opening. Move the cut to 190.5 mm.');
    expect(note('APART_FLAT', { why: 'lying' }).text).toBe('Cut A has no lip: neither piece fits your printer lying with the lip standing up out of it, so the pieces just rest on each other.');
    expect(note('APART_FLAT', { why: 'small' }).text).toBe('Cut A runs through openings, so its faces are too small for a lip – cut through a solid band of the model.');
    // the pieces already lying another way for another cut's lip; the piece that prints as well too tall with one
    expect(note('APART_FLAT', { letter: 'B', why: 'lying', by: ['A'], fixed: 2 }).text)
      .toBe('Cut B has no lip: piece 2 already lies another way for cut A\'s lip, and the other piece can\'t carry one, so the pieces just rest on each other.');
    expect(note('APART_FLAT', { letter: 'C', why: 'lying', by: ['A', 'B'], fixed: [1, 3] }).text)
      .toBe('Cut C has no lip: pieces 1 and 3 already lie another way for cuts A and B\' lips, and the other piece can\'t carry one, so the pieces just rest on each other.');
    expect(note('APART_FLAT', { why: 'tall', piece: 1, other: 2, suggestedAt: 189 })).toMatchObject({
      level: 'warn', suggestedAt: 189,
      text: 'Cut A has no lip: piece 1 would be too tall for your printer standing up with one, and piece 2 would need supports carrying it. Move the cut to 189 mm.',
    });
    expect(note('APART_FLAT', { axis: 0, pieces: [[1, 3], [2, 4]], why: 'room', need: 6.35 }).text)
      .toBe('Cut A has no room for a lip – pieces 2 and 4 have under 6.4 mm of plain wall past the cut before a roof, a ledge or an opening.');
    expect(note('APART_NO_CLIPS', { axis: 2, why: 'edge', suggestedAt: 160.5 }).text)
      .toBe('Cut A runs along the edge of an opening or a ledge, which breaks its lip into short stretches, so it has no clips and the top just lifts off. Move the cut to 160.5 mm.');

    expect(note('APART_HEAVY', { weight: 274, hold: 4.2 })).toMatchObject({
      level: 'info', hold: 4.2, text: 'Cut A\'s clips may not hold up what hangs below it (about 270 g) – carry the model by its base, not its top.',
    });
    expect(note('APART_HEAVY', { weight: 1340 }).text).toMatch(/\(about 1\.3 kg\)/);
    expect(splitNote('APART_KEPT', { letters: ['A'] })).toMatchObject({
      level: 'info', text: 'Cut A comes apart, so Fit to my printer kept it where it is and planned the other cuts around it.',
    });
    expect(splitNote('APART_KEPT', { letters: ['A', 'C'] }).text).toBe('Cuts A and C come apart, so Fit to my printer kept them where they are and planned the other cuts around them.');

    // the notes that were there say so too
    expect(splitNote('SPLIT', { pieces: 2, apart: ['A'] }).text).toBe('Cut into 2 pieces. Cut A comes apart – don\'t glue it.');
    expect(splitNote('SPLIT', { pieces: 4, dowels: 4, diameter: 6, length: 19, pairs: ['1B ↔ 2B'], apart: ['A', 'C'] }).text)
      .toBe('Cut into 4 pieces with 4 pins Ø6 × 19 mm. Glue matching letters together: 1B ↔ 2B. Cuts A and C come apart – don\'t glue them.');
    expect(splitNote('SPLIT', { pieces: 2 }).text).toBe('Cut into 2 pieces.');
    expect(splitNote('SPLIT_NOT_NEEDED', { apart: ['A'] }).text).toBe('This model fits your printer with cut A as it is – no more cuts needed.');
    expect(splitNote('SPLIT_NOT_NEEDED', { apart: ['A', 'B'] }).text).toBe('This model fits your printer with cuts A and B as they are – no more cuts needed.');
    expect(splitNote('DOVETAIL', { letter: 'A', tabs: 2, pieces: [1, 2], apart: true }).text)
      .toBe('Cut A goes through a thin plate, so it comes apart on 2 dovetail tabs – lay both pieces flat and lower piece 2 onto piece 1; lift it off again to take it apart. Don\'t glue it.');
    expect(splitNote('DOVETAIL', { letter: 'A', tabs: 2, pieces: [1, 2] }).text).toBe('Cut A goes through a thin plate, so it has 2 dovetail tabs instead of pins – lay both pieces flat and lower piece 2 onto piece 1.');
  });

  it('a cut that locks: its note says the top locks on firmly and comes off with a hard pull – the seated top hides its key\'s gap, so there is no lever', () => {
    const note = (fields) => splitNote('APART', { letter: 'A', cutId: 'c1', hold: 'lock', height: 6, ...fields });
    expect(note({ axis: 2, male: 1, female: 2, clips: 4, faces: 1, flat: 0 })).toMatchObject({
      level: 'info', code: 'APART', hold: 'lock',
      text: 'Cut A comes apart: the top (piece 2) locks onto a 6 mm lip – 4 clips hold it firmly. Press it on until it clicks; to take it off, pull hard.',
    });
    // the lip on the top locks into the piece below
    expect(note({ axis: 2, above: true, male: 2, female: 1, clips: 4 }).text)
      .toBe('Cut A comes apart: the top (piece 2) locks into piece 1 on a 6 mm lip – 4 clips hold it firmly. Press it on until it clicks; to take it off, pull hard.');
    // across X several pieces lock on together; across Y one clip, on one side
    expect(note({ letter: 'B', axis: 0, male: [1, 3], female: [2, 4], clips: 3, faces: 2 }).text)
      .toBe('Cut B comes apart: pieces 2 and 4 lock onto a 6 mm lip – 3 clips hold them firmly. Press them on until they click; to take them off, pull hard.');
    expect(note({ axis: 1, male: 1, female: 2, clips: 1 }).text)
      .toBe('Cut A comes apart: piece 2 locks onto a 6 mm lip – 1 clip holds it firmly, on one side only. Press it on until it clicks; to take it off, pull hard.');
    // small faces rest as for any hold
    expect(note({ axis: 2, male: 1, female: 2, clips: 4, flat: 2 }).text)
      .toBe('Cut A comes apart: the top (piece 2) locks onto a 6 mm lip – 4 clips hold it firmly. Press it on until it clicks; to take it off, pull hard. 2 small faces beside it just rest on each other.');
    expect(note({ axis: 2, male: 1, female: 2, clips: 4 }).text).not.toMatch(/lever|gap/);
    // a lip with no clips just lifts off, as any hold's
    expect(note({ axis: 2, male: 1, female: 2, clips: 0, height: 4.5 }).text).toBe('Cut A comes apart: the top (piece 2) sits on a 4.5 mm lip on piece 1 and lifts straight off.');
  });

  describe('steps and the glue sheet', () => {
    const apart = (fields = {}) => ({ hold: 'snap', lip: true, clips: 4, height: 6, key: true, faces: 1, flat: 0, ...fields });
    const lipSeam = (fields = {}) => ({ letter: 'A', axis: 2, at: 190, pieces: [1, 2], joint: 'lip', dowels: [], pegs: [], male: 1, labels: null, apart: apart(), ...fields });
    const two = [{ index: 1, cell: [0, 0, 0], size: [108, 108, 196], lies: 'flat as modelled' }, { index: 2, cell: [0, 0, 1], size: [110, 110, 101], lies: 'on a cut face' }];
    const text = (seams, pieces = two) => assemblySteps({ pieces, seams })[0].text;

    it('a cut that comes apart is never glued, and says so first: how it goes on, by its hold and its lip', () => {
      const [step] = assemblySteps({ pieces: two, seams: [lipSeam()] });
      expect(step).toMatchObject({ letter: 'A', axis: 2, pieces: [1], joins: [2], pins: 0, pegs: 0, apart: true });
      expect(step.text).toBe('Do not glue cut A: it comes apart. Press the top on until it clicks. It goes on one way round only – turn it until it drops onto the lip.');
      expect(text([lipSeam({ apart: apart({ hold: 'light' }) })])).toBe(step.text);
      expect(text([lipSeam({ male: 2 })])).toBe(step.text); // the lip on the top: it clicks on all the same
      expect(text([lipSeam({ axis: 0, at: 0 })], [{ index: 1, cell: [0, 0, 0] }, { index: 2, cell: [1, 0, 0] }]))
        .toBe('Do not glue cut A: it comes apart. Press piece 2 onto piece 1 until it clicks. It goes on one way round only – turn it until it drops onto the lip.');
      const lifts = 'Do not glue cut A: it comes apart. Set the top on its lip – it goes on one way round only – and lift it off to open it.';
      expect(text([lipSeam({ apart: apart({ hold: 'lift', clips: 0 }) })])).toBe(lifts);
      expect(text([lipSeam({ apart: apart({ clips: 0, height: 4.5 }) })])).toBe(lifts);
      expect(text([lipSeam({ joint: 'none', male: null, apart: apart({ lip: false, clips: 0, key: false }) })]))
        .toBe('Do not glue cut A: it comes apart. Set the top on piece 1 and line the edges up – nothing holds it.');
      expect(text([lipSeam({ axis: 0, at: 0, joint: 'dovetail', male: null, apart: apart({ lip: false, clips: 0, tabs: 2 }) })], [{ index: 1, cell: [0, 0, 0] }, { index: 2, cell: [1, 0, 0] }]))
        .toBe('Do not glue cut A: it comes apart. Lay pieces 1 and 2 flat and lower piece 2\'s tabs into piece 1; lift it out to take it apart.');
      // the steps of glued cuts carry no flag
      expect(assemblySteps({ pieces: two, seams: [{ letter: 'A', axis: 2, at: 190, pieces: [1, 2], joint: 'none', dowels: 0, labels: null }] })[0]).not.toHaveProperty('apart');
    });

    it('a cut that locks is pressed on until it clicks and opened with a hard pull – nothing to lever at – and goes on one way round only', () => {
      const locks = (fields = {}) => apart({ hold: 'lock', ...fields });
      const [step] = assemblySteps({ pieces: two, seams: [lipSeam({ apart: locks() })] });
      expect(step).toMatchObject({ letter: 'A', pieces: [1], joins: [2], apart: true });
      expect(step.text).toBe('Do not glue cut A: it comes apart. Press the top on until it clicks – it locks; pull hard to open it. It goes on one way round only – turn it until it drops onto the lip.');
      expect(text([lipSeam({ male: 2, apart: locks() })])).toBe(step.text); // the lip on the top: it locks on all the same
      // across X; and two pieces beyond it, which lock on together
      expect(text([lipSeam({ axis: 0, at: 0, apart: locks() })], [{ index: 1, cell: [0, 0, 0] }, { index: 2, cell: [1, 0, 0] }]))
        .toBe('Do not glue cut A: it comes apart. Press piece 2 onto piece 1 until it clicks – it locks; pull hard to open it. It goes on one way round only – turn it until it drops onto the lip.');
      const shells = [{ index: 1, cell: [0, 0, 0] }, { index: 2, cell: [1, 0, 0] }, { index: 3, cell: [1, 0, 0] }];
      expect(assemblySteps({ pieces: shells, seams: [lipSeam({ axis: 0, at: 0, pieces: [1, 2], apart: locks() }), lipSeam({ axis: 0, at: 0, pieces: [1, 3], apart: locks() })] })[0].text)
        .toBe('Do not glue cut A: it comes apart. Press pieces 2 and 3 onto piece 1 until they click – they lock; pull hard to open it. They go on one way round only – turn them until they drop onto the lip.');
      // the top of two pieces
      const four = [{ index: 1, cell: [0, 0, 0] }, { index: 2, cell: [1, 0, 0] }, { index: 3, cell: [0, 0, 1] }, { index: 4, cell: [1, 0, 1] }];
      expect(assemblySteps({ pieces: four, seams: [lipSeam({ pieces: [1, 3], apart: locks() }), lipSeam({ pieces: [2, 4], male: 2, apart: locks() })] })[0].text)
        .toBe('Do not glue cut A: it comes apart. Press the top (pieces 3 and 4) on until it clicks – it locks; pull hard to open it. It goes on one way round only – turn it until it drops onto the lip.');
      expect(step.text).not.toMatch(/lever|gap/);
      // a lip too short for clips sits on, whatever the hold
      expect(text([lipSeam({ apart: locks({ clips: 0, height: 4.5 }) })])).toBe('Do not glue cut A: it comes apart. Set the top on its lip – it goes on one way round only – and lift it off to open it.');
    });

    it('it goes on last, after every glued cut, whichever axis it is on', () => {
      // a base that comes off under a glued top: the top is glued first
      const three = [{ index: 1, cell: [0, 0, 0] }, { index: 2, cell: [0, 0, 1] }, { index: 3, cell: [0, 0, 2] }];
      const steps = assemblySteps({
        pieces: three,
        seams: [lipSeam({ at: 100 }), { letter: 'B', axis: 2, at: 190, pieces: [2, 3], joint: 'dowels', dowels: 2, labels: ['2B', '3B'] }],
      });
      expect(steps.map((s) => [s.letter, Boolean(s.apart)])).toEqual([['B', false], ['A', true]]);
      // a top of two pieces glued across X first
      const four = [{ index: 1, cell: [0, 0, 0] }, { index: 2, cell: [1, 0, 0] }, { index: 3, cell: [0, 0, 1] }, { index: 4, cell: [1, 0, 1] }];
      const crossed = assemblySteps({
        pieces: four,
        seams: [
          lipSeam({ letter: 'B', pieces: [1, 3], apart: apart({ clips: 3, faces: 2 }) }), lipSeam({ letter: 'B', pieces: [2, 4], male: 2, apart: apart({ clips: 3, faces: 2 }) }),
          { letter: 'A', axis: 0, at: 0, pieces: [1, 2], joint: 'dowels', dowels: 2, labels: ['1A', '2A'] },
          { letter: 'A', axis: 0, at: 0, pieces: [3, 4], joint: 'dowels', dowels: 2, labels: ['3A', '4A'] },
        ],
      });
      expect(crossed.map((s) => s.letter)).toEqual(['A', 'A', 'B']);
      expect(crossed[2]).toMatchObject({ pieces: [1, 2], joins: [3, 4], apart: true });
      expect(crossed[2].text).toBe('Do not glue cut B: it comes apart. Press the top (pieces 3 and 4) on until it clicks. It goes on one way round only – turn it until it drops onto the lip.');
      // a take-apart X cut goes on after a glued Z one
      const sideways = assemblySteps({
        pieces: four,
        seams: [
          lipSeam({ axis: 0, at: 0, pieces: [1, 2] }), lipSeam({ axis: 0, at: 0, pieces: [3, 4], male: 3 }),
          { letter: 'B', axis: 2, at: 50, pieces: [1, 3], joint: 'none', dowels: 0, labels: null },
          { letter: 'B', axis: 2, at: 50, pieces: [2, 4], joint: 'none', dowels: 0, labels: null },
        ],
      });
      expect(sideways.map((s) => s.letter)).toEqual(['B', 'A', 'A']);
      // two pieces beyond an X cut in one row (a box whose two shells print apart) go on together: they click
      const shells = [{ index: 1, cell: [0, 0, 0] }, { index: 2, cell: [1, 0, 0] }, { index: 3, cell: [1, 0, 0] }];
      const both = (fields) => assemblySteps({ pieces: shells, seams: [lipSeam({ axis: 0, at: 0, pieces: [1, 2], ...fields }), lipSeam({ axis: 0, at: 0, pieces: [1, 3], ...fields })] });
      expect(both({})[0].text).toBe('Do not glue cut A: it comes apart. Press pieces 2 and 3 onto piece 1 until they click. They go on one way round only – turn them until they drop onto the lip.');
      expect(both({ apart: apart({ hold: 'lift', clips: 0 }) })[0].text)
        .toBe('Do not glue cut A: it comes apart. Set pieces 2 and 3 against piece 1 on the lip – they go on one way round only – and lift them off to open it.');
    });

    it('the glue sheet: lips and clips need no supports, the pieces say which has the lip, and nothing is glued', () => {
      const sheet = howToGlueText({ name: 'lantern', pieces: two, seams: [lipSeam()], clearance: 0.15, printer: { size: [220, 220, 250], margin: 5 } });
      const lines = sheet.split('\n');
      expect(lines).toContain('PRINT (each file is already turned the way to print it; lips and clips need no supports)');
      expect(lines).toContain('  piece 1 of 2   108.0 × 108.0 × 196.0 mm   lies flat as modelled   fits, lip for cut A');
      expect(lines).toContain('  piece 2 of 2   110.0 × 110.0 × 101.0 mm   lies on a cut face   fits, comes off at cut A');
      expect(lines).toContain('  Clips are 40 mm bridges over a slot: print with bridging on (the default) and no supports.');
      expect(lines).toContain('  Not sure about the fit? Print the fit test first (Split card → Download fit test).');
      expect(lines).toContain('  The top of cut A should click onto its lip and pull off again by hand. Too stiff: raise Clearance by 0.05 mm (or set the cut to Light click); no click or too loose: lower it by 0.05 mm, and download again.');
      expect(sheet).not.toContain('Hold the pieces together');
      expect(sheet).not.toContain('GLUE –');
      expect(sheet).not.toContain('LAST');
      expect(sheet.trimEnd().split('\n').slice(-2)).toEqual([
        'PUT TOGETHER – nothing is glued',
        '  1. Do not glue cut A: it comes apart. Press the top on until it clicks. It goes on one way round only – turn it until it drops onto the lip.',
      ]);
      // Light click asks for no lighter one; Lifts off just drops on, with no clips to bridge
      expect(howToGlueText({ name: 'l', pieces: two, seams: [lipSeam({ apart: apart({ hold: 'light' }) })] }))
        .toContain('  The top of cut A should click onto its lip and pull off again by hand. Too stiff: raise Clearance by 0.05 mm; no click or too loose: lower it by 0.05 mm, and download again.');
      const lifts = howToGlueText({ name: 'l', pieces: two, seams: [lipSeam({ apart: apart({ hold: 'lift', clips: 0 }) })] });
      expect(lifts).toContain('PRINT (each file is already turned the way to print it; lips need no supports)');
      expect(lifts).toContain('  The top of cut A should drop onto its lip and lift off freely.');
      expect(lifts).not.toContain('Clips are');
      // the lip on the top, across X: the piece that comes off is named
      const side = [{ index: 1, cell: [0, 0, 0], size: [100, 40, 20], lies: 'flat as modelled' }, { index: 2, cell: [1, 0, 0], size: [106, 40, 20], lies: 'flat as modelled' }];
      const across = howToGlueText({ name: 'bar', pieces: side, seams: [lipSeam({ axis: 0, at: 100, male: 2 })] });
      expect(across).toContain('  Piece 1 of cut A should click onto its lip');
      expect(across).toMatch(/piece 1 of 2 .* fits, comes off at cut A/);
      expect(across).toMatch(/piece 2 of 2 .* fits, lip for cut A/);
      // a box's lid with the lip: the lid is still what comes off, and the box stays where it is
      const lidded = howToGlueText({ name: 'box', pieces: two, seams: [lipSeam({ male: 2 })] });
      expect(lidded).toMatch(/piece 1 of 2 .* fits\n/);
      expect(lidded).toMatch(/piece 2 of 2 .* fits, lip for cut A, comes off at cut A\n/);
    });

    it('the glue sheet of a cut that locks: its clips are 30 mm bridges, the dry fit takes a firm pull, and the step says to pull hard', () => {
      const sheet = howToGlueText({ name: 'lantern', pieces: two, seams: [lipSeam({ apart: apart({ hold: 'lock' }) })], clearance: 0.15 });
      const lines = sheet.split('\n');
      expect(lines).toContain('PRINT (each file is already turned the way to print it; lips and clips need no supports)');
      expect(lines).toContain('  Clips are 30 mm bridges over a slot: print with bridging on (the default) and no supports.');
      expect(lines).toContain('  The top of cut A should lock onto its lip and come off only with a firm pull. Too stiff to open: raise Clearance by 0.05 mm (or set the cut to Clicks on); too loose: lower it by 0.05 mm, and download again.');
      expect(sheet).not.toContain('pull off again by hand');
      expect(sheet.trimEnd().split('\n').slice(-2)).toEqual([
        'PUT TOGETHER – nothing is glued',
        '  1. Do not glue cut A: it comes apart. Press the top on until it clicks – it locks; pull hard to open it. It goes on one way round only – turn it until it drops onto the lip.',
      ]);
      // a wide nozzle's longer bridges, as built
      expect(howToGlueText({ name: 'lantern', pieces: two, seams: [lipSeam({ apart: apart({ hold: 'lock' }) })], bridges: [37.5] }))
        .toContain('  Clips are 37.5 mm bridges over a slot: print with bridging on (the default) and no supports.');
      // a cut that locks beside one that clicks on: both lengths of bridge, and each cut's own dry fit
      const three = [
        { index: 1, cell: [0, 0, 0], size: [100, 100, 100], lies: 'flat as modelled' }, { index: 2, cell: [0, 0, 1], size: [100, 100, 96], lies: 'flat as modelled' },
        { index: 3, cell: [0, 0, 2], size: [110, 110, 101], lies: 'on a cut face' },
      ];
      const mixed = howToGlueText({ name: 'l', pieces: three, seams: [lipSeam({ letter: 'A', at: 100, pieces: [1, 2], apart: apart({ hold: 'lock' }) }), lipSeam({ letter: 'B', at: 196, pieces: [2, 3], male: 2 })] });
      expect(mixed).toContain('  Clips are 30 and 40 mm bridges over a slot: print with bridging on (the default) and no supports.');
      expect(mixed).toContain('  The top of cut A should lock onto its lip and come off only with a firm pull.');
      expect(mixed).toContain('  The top of cut B should click onto its lip and pull off again by hand.');
    });

    it('with glued cuts too, they come first and the cut that comes apart last, numbered on', () => {
      const three = [
        { index: 1, cell: [0, 0, 0], size: [100, 100, 100], lies: 'flat as modelled' }, { index: 2, cell: [0, 0, 1], size: [100, 100, 96], lies: 'on a cut face' },
        { index: 3, cell: [0, 0, 2], size: [110, 110, 101], lies: 'on a cut face' },
      ];
      const seams = [{ letter: 'B', axis: 2, at: 100, pieces: [1, 2], joint: 'dowels', dowels: 4, labels: ['1B', '2B'] }, lipSeam({ pieces: [2, 3], male: 2 })];
      const lines = howToGlueText({ name: 'lantern', pieces: three, seams, pins: [{ d: 6, length: 19, count: 4 }], clearance: 0.15 }).split('\n');
      const at = lines.indexOf('LAST – DO NOT GLUE');
      expect(lines.slice(at - 4, at + 2)).toEqual([
        'GLUE – put each letter on the same letter (medium/thick CA or 5-minute epoxy; holes have 0.15 mm of room per side)',
        '  Matching faces: 1B ↔ 2B',
        '  1. Cut B: glue 4 pins into face 1B, a thin film on the face, push piece 2 on (2B). Hold 1 minute.',
        '',
        'LAST – DO NOT GLUE',
        '  2. Do not glue cut A: it comes apart. Press the top on until it clicks. It goes on one way round only – turn it until it drops onto the lip.',
      ]);
      expect(lines).toContain('PRINT (each file is already turned the way to print it; holes and lips and clips need no supports)');
      expect(lines).toContain('  Pins should slide in by hand. Too tight: raise Clearance by 0.05 mm and download again.');
      expect(lines.filter((l) => /lip for cut A/.test(l))).toEqual([expect.stringMatching(/^ {2}piece 2 of 3/)]);
      expect(lines.filter((l) => /comes off at cut A/.test(l))).toEqual([expect.stringMatching(/^ {2}piece 3 of 3/)]);
      expect(lines).not.toContain('PUT TOGETHER – nothing is glued');
    });
  });
});

describe('placing a cut that comes apart', () => {
  // a profile of slices every millimetre: the outline steady, then a ledge, a roof's steady slope, and openings that end
  const profile = (shifts, islands = shifts.map(() => 1), holes = shifts.map(() => 1)) =>
    shifts.map((shift, i) => ({ t: i, area: 100, islands: islands[i], holes: holes[i], shift }));

  it('finds seams where the outline moves at once or its islands change, not along a slope', () => {
    const shifts = [0, 0, 0, 4.4, 1.3, 1.3, 1.3, 1.3, 0, 0, 0, 0];
    const islands = [1, 1, 1, 1, 1, 1, 1, 1, 1, 8, 8, 8];
    // the slope itself is none, though where it ends in straight sides is a bend
    expect(profileSeams(profile(shifts, islands))).toEqual([{ lo: 3, hi: 4, by: 'shift' }, { lo: 8, hi: 9, by: 'count' }, { lo: 7, hi: 9, by: 'bend', straight: 1 }]);
    // a step hardly bigger than the slope beside it, or under half a millimetre, is none; a step at a slope's foot is
    const steps = (p) => profileSeams(p).filter((s) => s.by !== 'bend');
    expect(steps(profile([0, 1.3, 1.3, 1.5, 1.3, 0]))).toEqual([]);
    expect(profileSeams(profile([0, 0, 0.4, 0, 0]))).toEqual([]);
    expect(profileSeams(profile([0, 0, 2.05, 1.5, 1.5, 1.5]))).toEqual([{ lo: 2, hi: 3, by: 'shift' }]);
    // holes that start (a floor giving way to walls) are a seam too
    expect(profileSeams(profile([0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 1, 1]))).toEqual([{ lo: 1, hi: 2, by: 'count' }]);
    expect(SPOT).toMatchObject({ sharp: 0.5, look: 20, apart: 8, most: 5, snap: 3 });
  });

  it('finds a groove holding one sample: in and out of it the outline moves alike', () => {
    // a 1 mm groove round a lid with the sample at 3 in it: neither move is bigger than the other
    expect(profileSeams(profile([0, 0, 0.52, 0.52, 0, 0]))).toEqual([{ lo: 2, hi: 3, by: 'shift' }, { lo: 3, hi: 4, by: 'shift' }]);
    // the samples round it may creep a little, not as much
    expect(profileSeams(profile([0.3, 0.3, 0.52, 0.52, 0.3, 0.3])).filter((s) => s.by === 'shift')).toHaveLength(2);
    expect(profileSeams(profile([0.45, 0.45, 0.52, 0.52, 0.45, 0.45])).filter((s) => s.by === 'shift')).toEqual([]);
    // three moves in a row are a slope's (a chamfer): no step, only the bends where it starts and ends
    expect(profileSeams(profile([0, 0, 0.6, 0.6, 0.6, 0, 0]))).toEqual([{ lo: 1, hi: 3, by: 'bend', straight: -1 }, { lo: 4, hi: 6, by: 'bend', straight: 1 }]);
  });

  it('finds where straight sides bend into a slope, a roof flush with its walls, and narrows the bend down; a dome is none', () => {
    // straight sides, the bend inside the sample interval from 3 to 4, then a slope moving 0.8 mm per mm
    expect(profileSeams(profile([0, 0, 0, 0.5, 0.8, 0.8, 0.8]))).toEqual([{ lo: 2, hi: 4, by: 'bend', straight: -1 }]);
    // and a slope that turns gently, a little more each millimetre, has no bend
    expect(profileSeams(profile([0, 0.03, 0.07, 0.12, 0.17, 0.22, 0.27, 0.33]))).toEqual([]);
    // narrowed down: the outline straight up to 200.37, then moving in 0.8 mm per mm
    const k = 200.37;
    const moved = (inset) => (a, b) => Math.abs(inset(b) - inset(a));
    const roof = (t) => (t > k ? 0.8 * (t - k) : 0);
    const found = locateBend(199, 201.6, { shift: moved(roof) });
    expect(found.at).toBeGreaterThan(k);
    expect(found.at).toBeLessThan(k + 0.03); // the outline has moved no more than the slices' noise there
    expect(found.shift).toBeCloseTo(2.4, 6);
    // a slope ending in straight sides, the other way up
    const shoulder = (t) => (t < k ? 0.8 * (k - t) : 0);
    expect(locateBend(199, 201.6, { shift: moved(shoulder), straight: 1 }).at).toBeCloseTo(k, 1);
    // a roof whose inside steps in a little at the bend still bends there: its slope is read a hair away from it
    expect(locateBend(199, 201.6, { shift: moved((t) => (t > k ? 0.6 + 0.8 * (t - k) : 0)) }).at).toBeCloseTo(k, 2);
    // a dome rising from straight sides turns gradually: no bend
    const dome = (t) => (t > 156 ? 54 - Math.sqrt(54 * 54 - (t - 156) ** 2) : 0);
    expect(locateBend(155, 158, { shift: moved(dome) })).toBeNull();
    expect(SPOT).toMatchObject({ steady: 0.1, bend: 0.25 });
  });

  it('narrows a seam down to a step that stays as big, and drops a slope or a touch', () => {
    const at = 200.1234;
    // a 3 mm step at 200.1234 on a slope moving 0.9 mm per mm
    const step = (a, b) => (a < at && b > at ? 3 : 0) + 0.9 * Math.abs(b - a);
    const found = locateSeam(199.62, 201.08, { shift: step });
    expect(found.hi - found.lo).toBeLessThanOrEqual(SPOT.tolerance);
    expect(found.lo).toBeLessThan(at);
    expect(found.hi).toBeGreaterThan(at);
    expect(found.shift).toBeCloseTo(3, 2);
    expect(locateSeam(199.62, 201.08, { shift: (a, b) => 0.9 * Math.abs(b - a) })).toBeNull();
    // windows that end at 160: eight islands below, one ring above, the outline moving 1.5 mm there
    const count = (t) => (t < 160 ? '8|0' : '1|1');
    const ends = locateSeam(159.2, 160.7, { by: 'count', count, shift: (a, b) => (a < 160 && b >= 160 ? 1.5 : 0) });
    expect(ends.lo).toBeLessThan(160);
    expect(ends.hi).toBeGreaterThanOrEqual(160);
    expect(ends.hi - ends.lo).toBeLessThanOrEqual(SPOT.tolerance);
    // two islands that only touch: the count changes, the outline hardly moves; joined at once by a strip, it is a seam
    const touching = { by: 'count', count: (t) => (t < 50 ? '2|0' : '1|0') };
    expect(locateSeam(49, 51, { ...touching, shift: (a, b) => 0.5 * Math.abs(b - a) })).toBeNull();
    expect(locateSeam(49, 51, { ...touching, shift: (a, b) => (a < 50 && b >= 50 ? 0.08 : 0) }).shift).toBeCloseTo(0.08, 9);
    expect(SPOT).toMatchObject({ least: 0.25, touch: 0.01 });
  });

  it('tells what a seam is from the slices either side, and says why a spot is good in plain words', () => {
    const side = (islands, holes) => ({ islands, holes });
    expect(seamKind({ below: side(1, 1), above: side(8, 0) })).toBe('opens');
    // windows ending: the islands are told before the hole the ring above has
    expect(seamKind({ below: side(8, 0), above: side(1, 1) })).toBe('closes');
    expect(seamKind({ below: side(1, 0), above: side(1, 1) })).toBe('walls');
    expect(seamKind({ below: side(1, 1), above: side(1, 0) })).toBe('top');
    expect(seamKind({ below: side(1, 1), above: side(1, 1), gained: 2100, lost: 1400 })).toBe('widens');
    expect(seamKind({ below: side(1, 1), above: side(1, 1), gained: 10, lost: 900 })).toBe('narrows');
    // the outline seen from outside says it: the walls thickening inside, the outside the same, is no ledge
    const still = { shift: 0, gained: 0, lost: 0 };
    expect(seamKind({ below: side(4, 4), above: side(4, 4), gained: 1472, lost: 0, outer: still })).toBe('thickens');
    expect(seamKind({ below: side(4, 4), above: side(4, 4), gained: 0, lost: 1472, outer: still })).toBe('thins');
    // a tube stepping out 1 mm while its walls thin from 4 to 1.5 mm: more is lost than gained, yet the outside widens
    expect(seamKind({ below: side(1, 1), above: side(1, 1), gained: 320, lost: 790, outer: { shift: 1, gained: 320, lost: 0 } })).toBe('widens');
    // two boxes side by side, one closing over: a hole under solid is walls closing over, though another hole goes on
    expect(seamKind({ below: side(2, 2), above: side(2, 1) })).toBe('closes');
    expect(seamKind({ below: side(2, 2), above: side(2, 1), capped: true })).toBe('top');
    expect(seamKind({ below: side(2, 1), above: side(2, 2), floored: true })).toBe('walls');
    expect(spotWhy('widens', -1, 2)).toBe('under a ledge where the shape widens');
    expect(spotWhy('narrows', 1, 2)).toBe('at a ledge where the shape narrows');
    expect(spotWhy('narrows', -1, 2, { cap: true })).toBe('under a cap');
    expect(spotWhy('closes', 1, 2)).toBe('above the openings');
    expect(spotWhy('opens', -1, 2)).toBe('below the openings');
    expect(spotWhy('walls', 1, 2)).toBe('where the walls start');
    expect(spotWhy('widens', -1, 0)).toBe('beside a ledge where the shape widens');
    expect(spotWhy('narrows', -1, 1, { cap: true })).toBe('at a ledge where the shape narrows');
    expect(spotWhy('narrows', 1, 2, { cap: true })).toBe('at the foot of a cap');
    expect(spotWhy('thickens', -1, 2)).toBe('below where the walls thicken');
    expect(spotWhy('slopes', -1, 2)).toBe('below where the sides start to slope');
    expect(spotWhy('straightens', 1, 2)).toBe('above where the sides straighten');
    expect([spotWhy('groove', -1, 2), spotWhy('groove', 1, 2), spotWhy('groove', 1, 0)]).toEqual(['under a groove', 'above a groove', 'beside a groove']);
    // from the shape alone: never what the part might be
    for (const kind of ['opens', 'closes', 'walls', 'top', 'widens', 'narrows', 'thickens', 'thins', 'slopes', 'straightens', 'groove']) {
      for (const [s, a] of [[-1, 2], [1, 2], [1, 0]]) expect(spotWhy(kind, s, a)).not.toMatch(/roof|lid|handle|body|base|tower|lantern/i);
    }
    expect([seamWords('widens'), seamWords('narrows'), seamWords('closes'), seamWords('opens'), seamWords('opens', 0), seamWords('walls')]).toEqual([
      'the ledge', 'the ledge', 'the top of the openings', 'the bottom of the openings', 'the edge of the openings', 'where the walls start',
    ]);
    expect([seamWords('thickens'), seamWords('thins'), seamWords('slopes'), seamWords('straightens')]).toEqual([
      'where the walls thicken', 'where the walls thin', 'where the sides start to slope', 'where the sides straighten',
    ]);
  });

  it('starts beside a seam on the 0.5 mm steps, never in its face, on the side that keeps its shape whole, and keeps to it', () => {
    expect([spotStart(200, -1), spotStart(200, 1), spotStart(123.457, -1), spotStart(123.457, 1), spotStart(160.2, -1), spotStart(160.2, 1)])
      .toEqual([199.5, 200.5, 123, 124, 159.5, 160.5]);
    // under a ledge the shape widens past and over one it narrows past (a band of gargoyles stays whole either way),
    // before openings and after them, past a floor and before a top closes over, on the straight side of a bend
    const sides = ['widens', 'narrows', 'opens', 'closes', 'walls', 'top', 'thickens', 'thins', 'slopes', 'straightens'].map(spotSide);
    expect(sides).toEqual([-1, 1, -1, 1, 1, -1, -1, 1, -1, 1]);
    // the Gothic lantern's gargoyles from 150 to 162 under its eaves at 170: a move from the eaves down to 160.5 would
    // cut through them, one to 165 keeps to the eaves
    const seams = [150, 162, 170];
    expect(keepsTo(seams, 170, -1, 160.5)).toBe(false);
    expect(keepsTo(seams, 170, -1, 165)).toBe(true);
    expect(keepsTo(seams, 162, 1, 162.5)).toBe(true);
    expect(keepsTo(seams, 150, -1, 140)).toBe(true);
    expect(keepsTo([10, 20], 10, 1, 19.9)).toBe(false); // in another seam's face
  });

  it('snaps to the nearest target within 3 mm, or the caller\'s tolerance when larger, a spot first', () => {
    const targets = [{ at: 190.5, kind: 'spot' }, { at: 200, kind: 'seam' }, { at: 160, kind: 'seam' }];
    expect(snapTarget(targets, 192)).toEqual({ at: 190.5, kind: 'spot' });
    expect(snapTarget(targets, 196)).toBeNull();
    expect(snapTarget(targets, 196, 4.5)).toEqual({ at: 200, kind: 'seam' });
    expect(snapTarget(targets, 196, 'x')).toBeNull();
    expect(snapTarget([{ at: 10, kind: 'seam' }, { at: 12, kind: 'spot' }, { at: 12, kind: 'lip' }], 11)).toEqual({ at: 12, kind: 'spot' });
    expect(snapTarget([{ at: 12, kind: 'lip' }, { at: 12, kind: 'seam' }], 11)).toEqual({ at: 12, kind: 'lip' });
    expect(snapTarget([], 5)).toBeNull();
  });

  it('says what comes off: the top along Z, else the smaller part, its length and its share', () => {
    // a prism 100 long with a 100 mm² face
    const prism = Array.from({ length: 99 }, (_, i) => ({ t: i + 1, area: 100 }));
    expect(comesOffOf(prism, { lo: 0, hi: 100, axis: 2, at: 70, area: 100 })).toEqual({ side: 1, length: 30, fraction: 0.3 });
    expect(comesOffOf(prism, { lo: 0, hi: 100, axis: 2, at: 20, area: 100 })).toEqual({ side: 1, length: 80, fraction: 0.8 });
    // across, a lid lying on its side comes off as it does standing: whichever piece carries the lip
    expect(comesOffOf(prism, { lo: 0, hi: 100, axis: 0, at: 70, area: 100 })).toEqual({ side: 1, length: 30, fraction: 0.3 });
    expect(comesOffOf(prism, { lo: 0, hi: 100, axis: 0, at: 30, area: 100 })).toEqual({ side: -1, length: 30, fraction: 0.3 });
    expect(comesOffOf(prism, { lo: 0, hi: 100, axis: 1, at: 20, area: 100 })).toEqual({ side: -1, length: 20, fraction: 0.2 });
    // the share is the volume's, not the length's: a top half as wide is a smaller share
    const stepped = Array.from({ length: 99 }, (_, i) => ({ t: i + 1, area: i + 1 < 50 ? 100 : 50 }));
    expect(comesOffOf(stepped, { lo: 0, hi: 100, axis: 2, at: 50, area: 50 }).fraction).toBeCloseTo(1 / 3, 2);
  });

  it('scores a full lip by its seam, what comes off, its islands and the letters it cuts, and keeps the best 8 mm apart', () => {
    // the lantern's spot under its roof, and one just over its windows
    const roof = spotScore({ clips: 4, shift: 3.92, distance: 9.5, fraction: 0.28, islands: 1 });
    const windows = spotScore({ clips: 4, shift: 1.54, distance: 0.5, fraction: 0.45, islands: 1 });
    expect(roof).toBeCloseTo(3 + 1 + 0.5 * (1 - 9.5 / 20) + 1, 9);
    expect(windows).toBeLessThan(roof);
    expect(spotScore({ clips: 0, shift: 3.92, distance: 9.5, fraction: 0.28 })).toBeCloseTo(roof - 1, 9);
    // through fretwork or posts, cutting letters, a sliver or most of the model: worse
    expect(spotScore({ clips: 4, shift: 3.92, distance: 9.5, fraction: 0.28, islands: 8 })).toBeCloseTo(roof - 3.5, 9);
    expect(spotScore({ clips: 4, shift: 3.92, distance: 9.5, fraction: 0.28, crosses: 1 })).toBeCloseTo(roof - 2, 9);
    // a tongue an opening's edge cuts into stretches: a lip, but a worse one
    expect(spotScore({ clips: 0, broken: true, shift: 3.92, distance: 9.5, fraction: 0.28 })).toBeCloseTo(roof - 2, 9);
    expect(spotScore({ clips: 4, shift: 3.92, distance: 9.5, fraction: 0.01 })).toBeCloseTo(roof - 1, 9);
    expect(spotScore({ clips: 4, shift: 3.92, distance: 9.5, fraction: 0.95 })).toBeLessThan(roof - 2.5);
    const spots = pickSpots([{ at: 160.5, score: 4.5 }, { at: 190.5, score: 5.3 }, { at: 185, score: 5.1 }, { at: 30.5, score: 3.1 }, { at: 4.5, score: 2.5 }, { at: 60, score: 2 }, { at: 100, score: 1 }, { at: 120, score: 0.5 }]);
    expect(spots.map((s) => s.at)).toEqual([190.5, 160.5, 30.5, 4.5, 60]);
    expect(pickSpots([{ at: 1, score: 1 }, { at: 9, score: 1 }, { at: 16.99, score: 1 }]).map((s) => s.at)).toEqual([1, 9]);
    // a seam only the inside shows (where the walls close over within a box) hides the cut nowhere: no credit for it
    expect(spotScore({ clips: 4, shift: 0, distance: 0.5, fraction: 0.25 })).toBe(4);
    expect(spotScore({ clips: 4, shift: 0.25, distance: 0, fraction: 0.25 })).toBeCloseTo(4 + 0.25 / 3 + 0.25, 9);
    // a spot whose flaws outweigh its lip is no suggestion, however short the list: a cut through sixteen posts
    expect(pickSpots([{ at: 174.5, score: 5.488 }, { at: 110.5, score: -4.456 }, { at: 60, score: 0 }]).map((s) => s.at)).toEqual([174.5]);
    expect(SPOT.floor).toBe(0);
  });

  it('gives the lip to the piece that prints as well with it, else names the one that would given room', () => {
    const full = { H: 6, clips: 4, area: 590 };
    // the lantern under its eaves: its top would carry it on its handle, its body has no room here
    expect(lipMale([null, full], [true, false])).toEqual({ male: 1, alt: 0 });
    expect(lipMale([full, full], [true, false])).toEqual({ male: 0, alt: null });
    // a box with an 8 mm lid: both stand on their ends, and only the box has room for a groove with clips
    expect(lipMale([{ H: 4.5, clips: 0, area: 590 }, full], [true, true])).toEqual({ male: 1, alt: null });
    expect(lipMale([full, full], [true, true])).toEqual({ male: 0, alt: null });
    expect(lipMale([null, null], [true, true])).toBeNull();
    expect(lipMale([full, null], [false, false])).toEqual({ male: 0, alt: null });
    // a piece prints as well with the lip when the model ends flat there, on at least half the face's area
    expect(endsAsWell([10000, 0], 1728)).toEqual([true, false]);
    expect(endsAsWell([800, 20], 1728)).toEqual([false, false]);
    expect(endsAsWell([20, 30], 10)).toEqual([false, true]);
    // how slender it would stand with the lip: a 70 mm tower's top 222.5 mm tall on its 40 × 40 flat roof prints far
    // worse than on its cut face; its foot 39.5 mm tall is fine
    const tower = { lengths: [39.5, 222.5], spans: [4900, 1600], faceSpan: 4900 };
    expect(endsAsWell([4900, 1600], 804, tower)).toEqual([true, false]);
    // a 60 mm tower 170.5 mm tall on its foot: a 6 mm lip on top tips it past what it costs without one; its 30 mm roof
    // stands on its flat top as well with one
    expect(endsAsWell([3600, 900], 684, { lengths: [170.5, 35], spans: [3600, 900], faceSpan: 3600 })).toEqual([false, true]);
    // the lantern's body, 190.5 mm on 100 × 100, is fine either way
    expect(endsAsWell([10000, 0], 1728, { lengths: [190.5, 100.5], spans: [10000, 0], faceSpan: 10000 })).toEqual([true, false]);
  });

  it('reads the flat area a model ends in on each side of each axis', () => {
    // a box 10 × 20 × 30 as a mesh of 12 triangles, and a pyramid on a 10 × 10 base
    const mesh = (verts, tris) => ({ vertProperties: Float32Array.from(verts.flat()), numProp: 3, triVerts: Uint32Array.from(tris.flat()) });
    const [w, d, h] = [10, 20, 30];
    const corners = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]];
    const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    const beds = endBeds(mesh(corners, faces));
    [[600, 600], [300, 300], [200, 200]].forEach((want, a) => want.forEach((v, k) => expect(beds[a][k]).toBeCloseTo(v, 6)));
    const pyramid = endBeds(mesh([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [5, 5, 12]], [[0, 2, 1], [0, 3, 2], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]]));
    expect(pyramid[2][0]).toBeCloseTo(100, 6);
    expect(pyramid[2][1]).toBe(0);
    expect(pyramid[0]).toEqual([0, 0]);
    // and the box each end's bed spans: the box's own sides; nothing where nothing lies flat
    const { spans } = endShape(mesh(corners, faces));
    [[600, 600], [300, 300], [200, 200]].forEach((want, a) => want.forEach((v, k) => expect(spans[a][k]).toBeCloseTo(v, 6)));
    expect(endShape(mesh([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [5, 5, 12]], [[0, 2, 1], [0, 3, 2], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]])).spans[2]).toEqual([100, 0]);
  });
});
