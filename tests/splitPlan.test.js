import { describe, expect, it } from 'vitest';
import {
  AUTO_DIAMETERS, AXES, BED_DEFAULTS, BED_PRESETS, CUT_COLOR, CUT_TOLERANCE, FILAMENT, HOLE_SEGMENTS, JOINTS, ORIENT_MODES, PIN_DIAMETERS,
  POLYGON_K, SPLIT_KEEP_TRIANGLES, TOO_BIG_COLOR, translationMat4, transposeMat4, DIRECTIONS, LAY_DOWN, PIECE_COLORS, PIN_COLOR, PLAN_WEIGHTS, SPLIT_DEFAULTS, SPLIT_LIMITS,
  SPLIT_NOTE_CODES, SplitError, TO_PLANE, TO_WORLD, YAW90, applyMat4, applyToSoup, assemblySteps, axisCuts, bedSize, cellOf,
  cellFits, cellOfPoint, cellSizes, chooseCentres, chooseOffsets, chooseOrientation, clipSoupByPlane, clippedArea, cutPlane, dirAxis, dirOf,
  dovetailSize, evenCell, explodeOffset, fitsBed, footprintYaw, formatSize, glueFileName, gridCandidates, gridCounts, gridPoints,
  howToGlueText, invertRigid, isSymmetric, letterFor, localFrame, maxCellLength, mulMat4, nextCut, normaliseSplit, offsetAlongRay,
  oppositeDir, orientationStats, partFileName, pieceColorIndex, pieceFileName, pinsFileName, planAllowance, planCost, planGrid,
  planSamples, plateAxis, polygonsArea, polygonsCentroid, printTransform, safeFileName, cellSupport, fitPieces, flatProbes, liesFlat, statsWithSoup,
  sizesFor, sizesForRoom, soupCells, splitActive, splitNote, teardropApex, usableBed, yawMat4, zipFileName, triangleInBox, baseAxis,
  outlineColumns, pieceHolding, textNotes, AUTO_PEGS, SMALLEST_PEG, layPegged, pegAllowance, pegMales, pegSides, pegSizeOf, pegSizesFor,
  pegSizesForRoom, statsWithPegs,
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
