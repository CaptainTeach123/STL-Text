import { describe, expect, it } from 'vitest';
import {
  AUTO_DIAMETERS, AXES, BED_DEFAULTS, BED_PRESETS, CUT_COLOR, CUT_TOLERANCE, FILAMENT, HOLE_SEGMENTS, JOINTS, ORIENT_MODES, PIN_DIAMETERS,
  POLYGON_K, SPLIT_KEEP_TRIANGLES, TOO_BIG_COLOR, translationMat4, transposeMat4, DIRECTIONS, LAY_DOWN, PIECE_COLORS, PIN_COLOR, PLAN_WEIGHTS, SPLIT_DEFAULTS, SPLIT_LIMITS,
  SPLIT_NOTE_CODES, SplitError, TO_PLANE, TO_WORLD, YAW90, applyMat4, applyToSoup, assemblySteps, axisCuts, bedSize, cellOf,
  cellFits, cellOfPoint, cellSizes, chooseCentres, chooseOffsets, chooseOrientation, clipSoupByPlane, cutPlane, dirAxis, dirOf,
  dovetailSize, evenCell, explodeOffset, fitsBed, footprintYaw, formatSize, glueFileName, gridCandidates, gridCounts, gridPoints,
  howToGlueText, invertRigid, isSymmetric, letterFor, localFrame, maxCellLength, mulMat4, nextCut, normaliseSplit, offsetAlongRay,
  oppositeDir, orientationStats, partFileName, pieceColorIndex, pieceFileName, pinsFileName, planAllowance, planCost, planGrid,
  planSamples, plateAxis, polygonsArea, polygonsCentroid, printTransform, safeFileName,
  sizesFor, sizesForRoom, soupCells, splitActive, splitNote, teardropApex, usableBed, yawMat4, zipFileName,
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

    it('relaxes the minimums when they cannot be met, and gives up when pieces cannot fit', () => {
      const samples = planSamples(-20, 20, 1);
      const costs = samples.map(() => 0);
      const r = chooseOffsets(samples, costs, { lo: -20, hi: 20, k: 1, S: 100, minEnd: 30, minMid: 60 });
      expect(r).toMatchObject({ relaxed: true, offsets: [0] });
      expect(chooseOffsets(samples, costs, { lo: -20, hi: 20, k: 1, S: 10 })).toBeNull();
    });
  });
});

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
    const bounds = { min: [-200, -50, 0], max: [200, 50, 4] };
    const cuts = [{ axis: 0, at: -60, reach: [12, 12], w: 2 }, { axis: 0, at: 60 }];
    const { cells } = cellSizes(bounds, cuts);
    expect(cells.map((c) => [c.size[0], c.flat])).toEqual([[140 + 12, 2], [120 + 12, 2], [140, null]]);
    expect(cellFits({ size: [212, 100, 4], flat: 2 }, U)).toBe(false);
    expect(cellFits({ size: [212, 100, 4], flat: null }, U)).toBe(true); // stood on its edge
    // stored cuts without tabs are boxed as before
    expect(cellSizes(bounds, [{ position: [0, 0, 0], normal: [1, 0, 0] }]).cells.map((c) => c.size)).toEqual([[200, 100, 4], [200, 100, 4]]);
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
    expect(splitNote('PART_SPANS_CUT', { name: '“Logo”', letter: 'A' }).text).toBe('“Logo” prints separately and spans cut A – glue it on after the pieces.');
    expect(splitNote('SPLIT_UNREPAIRED', { count: 312 }).text).toBe('312 triangles that couldn\'t be repaired were cut with the pieces but have no pins or labels.');
    expect(splitNote('SPLIT_NOT_NEEDED', { yaw: 40 }).text).toBe('This model already fits your printer (turned 40° on the bed) – no need to split.');
    expect(splitNote('SPLIT_NOT_NEEDED', {}).text).toBe('This model already fits your printer – no need to split.');
    expect(splitNote('PLAN_TOO_MANY').text).toBe('This would need more than 64 pieces – scale the model down or choose a bigger printer.');
    expect(splitNote('BED_TOO_SMALL', { size: [300, 40, 20], bed: [220, 220, 250], pieces: 2 }).text).toBe('300 × 40 × 20 mm – bigger than your 220 × 220 × 250 mm printer.');
    expect(formatSize([262.04, 120, 79.96])).toBe('262 × 120 × 80 mm');
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

describe('limits and constants', () => {
  it('match the design', () => {
    expect(SPLIT_LIMITS).toEqual({ cuts: 12, cells: 64, dowels: 48 });
    expect(SPLIT_KEEP_TRIANGLES).toBe(1_000_000);
    expect(CUT_TOLERANCE).toBe(0.01);
    expect(Object.isFrozen(SPLIT_DEFAULTS.cuts)).toBe(true);
    expect(PIN_DIAMETERS).toEqual([1.75, 3, 4, 5, 6, 8, 10]);
    expect(AUTO_DIAMETERS).toEqual([8, 6, 5, 4, 3]);
    expect(FILAMENT).toBe(1.75);
    expect(JOINTS).toEqual(['auto', 'dowels', 'dovetail', 'none']);
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
