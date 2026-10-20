import { beforeAll, describe, expect, it } from 'vitest';
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import {
  SNAP_MAX, aimLine, aimTargets, lipLine, lipVerdict, lipWords, offWords, placedAt, snapTolerance, snappedWords, spotLabel, throughWords,
} from '../src/aim.js';
import { snapTarget } from '../src/split.js';
import { sectionSegments } from '../src/viewer.js';
import { setup } from './helpers.js';
import { lanternSolid } from './lanternFixture.js';

beforeAll(setup);

// the engine's answers on the lantern fixture (split.plan modes 'probe' and 'spots', tests/split.test.js)
const at190 = { axis: 'z', at: 190, area: 1728, islands: 1, lip: { H: 6, clips: 4, why: null }, noLip: null, suggestedAt: null, comesOff: { side: 1, length: 101, fraction: 0.285 } };
const at192 = { axis: 'z', at: 192, area: 1728, islands: 1, lip: { H: 4.5, clips: 0, why: 'height' }, noLip: null, suggestedAt: 190.5, suggestedLip: { H: 6, clips: 4 }, comesOff: { side: 1, length: 99, fraction: 0.273 } };
const at196 = { axis: 'z', at: 196, area: 1728, islands: 1, lip: null, noLip: 'room', suggestedAt: 190.5, comesOff: { side: 1, length: 95, fraction: 0.25 } };
const at100 = { axis: 'z', at: 100, area: 576, islands: 8, lip: null, noLip: 'small', suggestedAt: null, comesOff: { side: 1, length: 191, fraction: 0.579 } };
const at300 = { axis: 'z', at: 300, area: 0, islands: 0, lip: null, noLip: 'miss', suggestedAt: null, comesOff: null };
const spot = { axis: 'z', at: 190.5, why: 'under a ledge where the shape widens', lip: { H: 6, clips: 4 }, comesOff: { side: 1, length: 100.5, fraction: 0.282 }, score: 5.263 };

/** The total length of a section's segments. */
function lengthOf({ positions, count }) {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 6;
    sum += Math.hypot(positions[o] - positions[o + 3], positions[o + 1] - positions[o + 4], positions[o + 2] - positions[o + 5]);
  }
  return sum;
}

/** An indexed geometry of a solid with its BVH, as the view holds the model. */
function viewOf(solid) {
  const mesh = solid.getMesh();
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(Float32Array.from(mesh.vertProperties.filter((_, i) => i % mesh.numProp < 3)), 3));
  g.setIndex(new Uint32BufferAttribute(Uint32Array.from(mesh.triVerts), 1));
  g.boundsTree = new MeshBVH(g);
  return g;
}

describe('placing a cut on the model', () => {
  it('colours the section by the lip: full with clips, shorter or clipless, none', () => {
    expect(lipVerdict(at190, 'lock')).toBe('full');
    expect(lipVerdict(at192, 'lock')).toBe('short');
    expect(lipVerdict({ ...at190, lip: { H: 6, clips: 0, why: 'edge' } }, 'snap')).toBe('short'); // a full height but no clips
    expect(lipVerdict({ ...at190, lip: { H: 6, clips: 0, why: null } }, 'lift')).toBe('full'); // a hold with no clips wants none
    expect(lipVerdict(at196, 'lock')).toBe('none');
    expect(lipVerdict(null, 'lock')).toBe('none');
  });

  it('says what the lip there is and where it would fit, as the spec reads it', () => {
    expect(aimLine(2, 190, at190, 'lock')).toBe('Z 190 mm · locks with 4 clips · top 101 mm comes off');
    expect(aimLine(2, 196, at196, 'lock')).toBe('Z 196 mm · no room for a lip – move down to 190.5');
    expect(aimLine(2, 192, at192, 'lock')).toBe('Z 192 mm · 4.5 mm lip without clips – lifts off – move down to 190.5 for clips · top 99 mm comes off');
    expect(aimLine(2, 100, at100, 'lock')).toBe('Z 100 mm · cuts through 8 small parts – no room for a lip');
    expect(aimLine(2, 300, at300, 'lock')).toBe('Z 300 mm · misses the model');
    expect(aimLine(2, 190.5, null, 'lock')).toBe('Z 190.5 mm'); // until the engine answers, and for a glued cut
    expect(lipLine(2, at190, 'lock')).toBe('locks with 4 clips · top 101 mm comes off');
    // each hold in its own words
    expect(lipWords(at190, 'snap', 2)).toBe('clicks on with 4 clips');
    expect(lipWords(at190, 'light', 2)).toBe('clicks on lightly with 4 clips');
    expect(lipWords({ ...at190, lip: { H: 6, clips: 0 } }, 'lift', 2)).toBe('6 mm lip – lifts off');
    expect(lipWords({ ...at190, lip: { H: 6, clips: 1 } }, 'lock', 2)).toBe('locks with 1 clip');
    expect(lipWords({ ...at196, noLip: 'thin', suggestedAt: null }, 'lock', 2)).toBe('walls too thin for a lip');
    // a move up, and across X a place rather than a direction
    expect(lipWords({ ...at196, at: 158, suggestedAt: 160.5 }, 'lock', 2)).toBe('no room for a lip – move up to 160.5');
    expect(lipWords({ ...at196, suggestedAt: 12.5 }, 'lock', 0)).toBe('no room for a lip – move to 12.5');
  });

  it('says a face is too small for a lip as it is: one small solid part, or several, never openings it may not have', () => {
    // the top of the lantern's handle, one solid part of 154 mm²
    expect(aimLine(2, 286.6, { ...at300, at: 286.6, area: 154, islands: 1, noLip: 'small' }, 'lock')).toBe('Z 286.6 mm · face too small for a lip');
    expect(lipWords({ ...at100, islands: 3 }, 'lock', 2)).toBe('cuts through 3 small parts – no room for a lip');
  });

  it('says a move is for clips only where the lip there has them: on a round wall it is for the twist-lock, or a taller lip', () => {
    // a round wall takes no clip: where the twist-lock fits it takes their place, with a lip or none, whatever the hold
    // that asked for clips (the synthetic round lantern under its eaves, and the user's through its eave)
    const twist = { r0: 46.72, opening: 90.24, theta: 9, tabs: 6 };
    const round = { ...at192, at: 147, lip: { H: 4.5, clips: 0, why: null, twist }, suggestedAt: null, suggestedLip: null };
    for (const hold of ['lock', 'snap', 'light']) expect(lipWords(round, hold, 2)).toBe('twist-lock, 3 lugs, 6 clicks – turn 9°');
    const eave = { ...at196, at: 150, lip: { H: 0, clips: 0, why: null, twist: { r0: 44.02, opening: 84.84, theta: 10, tabs: 6 } }, noLip: null, suggestedAt: null };
    expect(aimLine(2, 150, eave, 'lock')).toBe('Z 150 mm · twist-lock, 3 lugs, 6 clicks – turn 10° · top 95 mm comes off');
    expect([lipVerdict(round, 'lock'), lipVerdict(eave, 'snap')]).toEqual(['full', 'full']);
    // Lifts off asks for no hold: the lip, as before
    expect(lipWords({ ...round, lip: { H: 4.5, clips: 0, why: null } }, 'lift', 2)).toBe('4.5 mm lip – lifts off');
    // where none fits here, a move is for the one there, or for a taller lip where that one has none either
    const low = { ...at192, at: 13.5, lip: { H: 3, clips: 0, why: 'height' }, suggestedAt: 10.5, suggestedLip: { H: 6, clips: 0, twist: true } };
    expect(lipWords(low, 'lock', 2)).toBe('3 mm lip without clips – lifts off – move down to 10.5 for a twist-lock');
    expect(lipWords({ ...low, suggestedLip: { H: 6, clips: 0 } }, 'lock', 2)).toBe('3 mm lip without clips – lifts off – move down to 10.5 for a 6 mm lip');
    expect(lipWords(at192, 'lock', 2)).toBe('4.5 mm lip without clips – lifts off – move down to 190.5 for clips');
    // and the place it snaps to there is where the twist-lock fits, or a 6 mm lip, not a full one
    const [lip] = aimTargets({ lip: { at: 10.5, full: true, H: 6, twist: true } });
    expect(lip).toEqual({ at: 10.5, kind: 'lip', twist: true });
    expect(snappedWords(lip, 2)).toBe('snapped to where a twist-lock fits, at 10.5 mm');
    const [short] = aimTargets({ lip: { at: 146.5, full: false, H: 6 } });
    expect(short).toEqual({ at: 146.5, kind: 'lip', full: false, H: 6 });
    expect(snappedWords(short, 2)).toBe('snapped to where a 6 mm lip fits, at 146.5 mm');
    expect(snappedWords(aimTargets({ lip: { at: 190.5, full: true, H: 6 } })[0], 2)).toBe('snapped to where a full lip fits, at 190.5 mm');
    // a suggestion with the twist-lock says so on its button
    const spotted = { ...spot, at: 147.5, lip: { H: 0, clips: 0, twist: { r0: 41.72, opening: 80.24, theta: 11, tabs: 6 } }, comesOff: { side: 1, length: 90.5, fraction: 0.29 } };
    expect(spotLabel(spotted, 'lock')).toBe('Z 147.5 mm – top 90.5 mm comes off · twist-lock, 3 lugs, 6 clicks – turn 11° · under a ledge where the shape widens');
  });

  it('names the letters a cut would run through, in the readout and on a suggestion', () => {
    expect(throughWords(['LIGHT'])).toBe('through “LIGHT”');
    expect(throughWords([])).toBe('');
    expect(aimLine(2, 190.5, at190, 'lock', { through: ['LIGHT'] })).toBe('Z 190.5 mm · locks with 4 clips · top 101 mm comes off · through “LIGHT”');
    expect(spotLabel(spot, 'lock', { through: ['LIGHT', 'NIGHT'] })).toBe(
      'Z 190.5 mm – top 100.5 mm comes off · locks with 4 clips · under a ledge where the shape widens · through “LIGHT”, “NIGHT”',
    );
    // and a spot a cut already uses says so
    expect(spotLabel(spot, 'lock', { taken: 'A' })).toBe('Z 190.5 mm – top 100.5 mm comes off · locks with 4 clips · under a ledge where the shape widens · cut A is here');
  });

  it('names the piece that comes off by its side of the cut', () => {
    expect(offWords(2, { side: 1, length: 100.5 })).toBe('top 100.5 mm comes off');
    expect(offWords(2, { side: -1, length: 30 })).toBe('bottom 30 mm comes off');
    expect(offWords(0, { side: 1, length: 55 })).toBe('55 mm on the +X side comes off');
    expect(offWords(1, { side: -1, length: 62 })).toBe('62 mm on the −Y side comes off');
    expect(offWords(2, null)).toBe('');
  });

  it('says what a cut snapped to, and labels a suggestion', () => {
    expect(snappedWords({ at: 200, kind: 'seam', what: 'widens' }, 2)).toBe('snapped to the ledge at 200 mm');
    expect(snappedWords({ at: 160, kind: 'seam', what: 'closes' }, 2)).toBe('snapped to the top of the openings at 160 mm');
    expect(snappedWords({ at: 4, kind: 'seam', what: 'walls' }, 2)).toBe('snapped to where the walls start at 4 mm');
    expect(snappedWords({ at: 190.5, kind: 'spot', why: spot.why }, 2)).toBe('snapped to a good spot at 190.5 mm – under a ledge where the shape widens');
    expect(snappedWords({ at: 190.5, kind: 'lip' }, 2)).toBe('snapped to where a full lip fits, at 190.5 mm');
    expect(snappedWords(null, 2)).toBe('');
    expect(spotLabel(spot, 'lock')).toBe('Z 190.5 mm – top 100.5 mm comes off · locks with 4 clips · under a ledge where the shape widens');
    expect(spotLabel({ ...spot, axis: 'x', at: -7, comesOff: { side: 1, length: 62 }, why: 'beside the openings', lip: { H: 6, clips: 7 } }, 'snap')).toBe(
      'X -7 mm – 62 mm on the +X side comes off · clicks on with 7 clips · beside the openings',
    );
  });

  it('snaps to the seams, the spots and where a full lip fits, from 12 pixels away at most 10 mm', () => {
    const seams = [{ at: 4, kind: 'walls', shift: 14.5 }, { at: 160, kind: 'closes', shift: 1.5 }, { at: 200, kind: 'widens', shift: 3.9 }];
    const targets = aimTargets({ seams, spots: [spot], lip: 190.5 });
    expect(targets).toEqual([
      { at: 4, kind: 'seam', what: 'walls' },
      { at: 160, kind: 'seam', what: 'closes' },
      { at: 200, kind: 'seam', what: 'widens' },
      { at: 190.5, kind: 'spot', why: spot.why },
      { at: 190.5, kind: 'lip' },
    ]);
    expect(aimTargets({ seams, lip: null })).toHaveLength(3);
    // the hovered roof edge snaps to its ledge; a little lower, to the spot rather than the lip in the same place
    expect(snapTarget(targets, 198.5, snapTolerance(4))).toMatchObject({ at: 200, kind: 'seam' });
    expect(snapTarget(targets, 192, snapTolerance(4))).toMatchObject({ at: 190.5, kind: 'spot' });
    // 12 pixels: 6 mm where a millimetre is 2 pixels, 3 mm at least, never more than 10 mm
    expect(snapTolerance(2)).toBe(6);
    expect(snapTolerance(0.5)).toBe(SNAP_MAX);
    expect(snapTolerance(0)).toBe(SNAP_MAX);
    expect(snapTarget(targets, 180, snapTolerance(2))).toBeNull();
    expect(snapTarget(targets, 184.5, snapTolerance(2))).toMatchObject({ at: 190.5 });
    expect(snapTarget(targets, 183, snapTolerance(0.1))).toMatchObject({ at: 190.5 }); // seen along the axis: within 10 mm
    // free (Alt), a place is kept to 0.1 mm; snapped, the target's own
    expect(placedAt(198.4371, null)).toBe(198.4);
    expect(placedAt(198.4371, { at: 200 })).toBe(200);
  });

  it("draws the model's section from its BVH: each crossing triangle once, a face in the plane outlined by the walls below", () => {
    const box = new BoxGeometry(10, 20, 30).translate(0, 0, 15);
    box.boundsTree = new MeshBVH(box);
    expect(lengthOf(sectionSegments(box, 2, 7.5))).toBeCloseTo(60, 6);
    expect(lengthOf(sectionSegments(box, 2, 30))).toBeCloseTo(60, 6); // the top face: once, from the sides
    expect(sectionSegments(box, 2, 0).count).toBe(0); // the bottom face: nothing below it to outline it
    expect(sectionSegments(box, 2, 31).count).toBe(0);
    expect(lengthOf(sectionSegments(box, 0, 2))).toBeCloseTo(100, 6); // across X: 20 × 30
    // every point lies in the plane
    const { positions, count } = sectionSegments(box, 1, -3);
    for (let i = 0; i < count * 2; i++) expect(positions[i * 3 + 1]).toBe(-3);
    // a small array is grown, and the one handed back holds the points
    const small = new Float32Array(6);
    const grown = sectionSegments(box, 2, 7.5, small);
    expect(grown.positions).not.toBe(small);
    expect(lengthOf(grown)).toBeCloseTo(60, 6);
    const kept = new Float32Array(6 * 64);
    expect(sectionSegments(box, 2, 7.5, kept).positions).toBe(kept);
    expect(sectionSegments(new BufferGeometry(), 2, 0).count).toBe(0); // no BVH: no section
  });

  it("outlines the lantern's walls and corner posts under its roof, and nothing above it", () => {
    const solid = lanternSolid();
    const view = viewOf(solid);
    solid.delete();
    // at 190 the outside runs round the walls and the four posts standing out of the corners (4 × 92 + 4 × 24 mm), the
    // inside round the 92 mm square opening
    expect(lengthOf(sectionSegments(view, 2, 190))).toBeCloseTo(4 * 92 + 4 * 24 + 4 * 92, 3);
    expect(sectionSegments(view, 2, 300).count).toBe(0);
  });
});
