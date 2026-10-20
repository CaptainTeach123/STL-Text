import { beforeAll, describe, expect, it } from 'vitest';
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import {
  HANDLE_PLANE, MIXED_PART, SNAP_MAX, aimLine, aimTargets, bandOf, handlePlaneWords, lipLine, lipVerdict, lipWords, noFitTestWords, noLockOf, noLockTitle, offWords,
  partCard, partFace, partMeta, partOffered, partReadout, partWidth, partsNote, percentOf, pickPart, placedAt, snapTolerance, snappedWords, spotLabel, stuckWords, takesHandle,
  throughWords, wayCaption, widthWords,
} from '../src/aim.js';
import { snapTarget, wayStep } from '../src/split.js';
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

// the user's bat lantern as the engine's parts table reads it (split.plan mode 'parts', n 0.4, c 0.15): at 400 % the
// dome and cap twist-lock inside the handle (r0 22.39, Ø 41.58, 19°, 6 clicks) and the base from underneath (R 28.7, 17°);
// at 100 % neither fits a lock – the roof is 0.6 mm thick – from 280 % and 205 %
const lid400 = {
  kind: 'lid', name: 'Dome and cap', centre: [0, 0], face: 115.6, r: 31.583, side: 1, takesHandle: false, handle: { legs: 2, span: [-1, 0] },
  lock: { mech: 'twist', r0: 22.39, opening: 41.58, theta: 19, tabs: 6, teaLight: true, slope: 1.72 }, why: null, least: { lock: null, tea: null },
  wall: { t: 2.4, slope: 30 },
};
const base400 = { kind: 'plug', name: 'Base', centre: [0, 0], face: 0, r: 28.7, side: 1, lock: { mech: 'plug', R: 28.7, opening: 57.4, theta: 17, tabs: 3, coin: 51.1, teaLight: true }, why: null, least: { lock: null, tea: null } };
const lid100 = { ...lid400, face: 29.2, r: 8.026, lock: null, why: 'room', least: { lock: 2.8, tea: 3.8, opening: 23.06 }, wall: { t: 0.6, slope: 30 } };
const base100 = { ...base400, r: 8.6, lock: null, why: 'room', least: { lock: 2.04, tea: 2.75, opening: 29.4 } };
const bat400 = { scale: 4, most: 6, zmin: 0, zmax: 200, parts: [lid400, base400], handles: [{ foot: 114.6, top: 197.1, span: [-1, 0] }] };
const bat100 = { scale: 1, most: 6, zmin: 0, zmax: 50, parts: [lid100, base100], handles: [{ foot: 28.65, top: 49.27, span: [-1, 0] }] };

describe('parts that come off', () => {
  it("lists the lantern's parts in the card as the design words them: the lock each gets, its opening and print badge, and [Use]", () => {
    expect(partCard(lid400, bat400)).toEqual({
      kind: 'lid', name: 'Dome and cap', lock: true, title: 'Dome and cap – twist-lock · Ø 42 mm opening, takes a 38 mm tea light · the handle stays',
      detail: '', badge: "the lantern's collar needs the dome's support", offers: [], use: 'lock',
    });
    expect(partCard(base400, bat400)).toEqual({
      kind: 'plug', name: 'Base', lock: true, title: 'Base – twists off underneath · twist-lock · Ø 57 mm opening, takes a 38 mm tea light', detail: '',
      badge: 'no extra support', offers: [], use: 'lock',
    });
    // at 300 % the lid's 26 mm opening takes no tea light, where the base's does: the card says where it goes
    const lid300 = { ...lid400, lock: { ...lid400.lock, opening: 26.04, theta: 29, tabs: 3, teaLight: false } };
    expect(partCard(lid300, { ...bat400, scale: 3, parts: [lid300, base400] }).title).toBe(
      'Dome and cap – twist-lock · Ø 26 mm opening · the handle stays · a 38 mm tea light fits through the base, not the lid',
    );
    // the badge is the collar's the download builds (PART_PRINT's slope), the lantern's: no steeper than 45° it asks for
    // no support, however steep the band just under the face; under a top that is no dome, the model's support
    expect(partCard({ ...lid400, lock: { ...lid400.lock, slope: 1 } }, bat400).badge).toBe('no extra support');
    expect(partCard({ ...lid400, lock: { ...lid400.lock, slope: 1 }, underSlope: 7.5 }, bat400).badge).toBe('no extra support');
    expect(partCard({ ...lid400, name: 'Top', handle: null }, bat400).badge).toBe("the collar under it needs the model's support");
    // a top with no handle over it, or one that takes the handle
    expect(partCard({ ...lid400, name: 'Top', handle: null }, bat400).title).toBe('Top – twist-lock · Ø 42 mm opening, takes a 38 mm tea light');
    expect(partCard({ ...lid400, takesHandle: true }, bat400).title).toBe('Dome and cap – twist-lock · Ø 42 mm opening, takes a 38 mm tea light · takes the handle with it');
  });

  it('says why no lock fits at this size, from what size one does, and offers those sizes and to use it lifting off', () => {
    expect(partCard(lid100, bat100)).toEqual({
      kind: 'lid', name: 'Dome and cap', lock: false, title: 'Dome and cap – comes off inside the handle; the handle stays on the lantern.',
      detail: 'Too small for a lock at this size: its roof is 0.6 mm thick. A twist-lock fits from 280 % (a 23 mm opening); a 38 mm tea light fits through it from 380 %.',
      badge: '', offers: [300, 400], use: 'lift',
    });
    // a base too small for a lock is offered the size only: lifting out, it would drop out of the lantern
    expect(partCard(base100, bat100)).toEqual({
      kind: 'plug', name: 'Base', lock: false, title: 'Base – could twist off underneath from 205 % (a 29 mm opening); a 38 mm tea light fits through it from 275 %.',
      detail: '', badge: '', offers: [300], use: null,
    });
    // least scales are factors on the size now: at 200 % the same lid needs 1.4 times it, still 280 % of the model as loaded
    const lid200 = { ...lid100, why: 'tabs', least: { lock: 1.4, tea: 1.9, opening: 23.06 } };
    expect(partCard(lid200, { ...bat100, scale: 2 }).detail).toBe(
      'Too small for a lock at this size: there is no room round it for the click tabs. A twist-lock fits from 280 % (a 23 mm opening); a 38 mm tea light fits through it from 380 %.',
    );
    expect(partCard(lid200, { ...bat100, scale: 2 }).offers).toEqual([300, 400]);
    // one size for both, and none at all as far as the finder looks
    expect(partCard({ ...lid100, least: { lock: 3.8, tea: 3.8, opening: 41 } }, bat100)).toMatchObject({
      detail: 'Too small for a lock at this size: its roof is 0.6 mm thick. A twist-lock fits from 380 % (a 41 mm opening), and takes a 38 mm tea light.', offers: [400],
    });
    expect(partCard({ ...lid100, why: 'collar', least: { lock: null, tea: null } }, bat100)).toMatchObject({
      detail: 'Too small for a lock at this size: nothing under it is deep enough to carry one. No twist-lock fits it up to 600 %.', offers: [], use: 'lift',
    });
    expect(partCard({ ...base100, least: { lock: null, tea: null } }, bat100).title).toBe('Base – no twist-lock fits it underneath up to 600 %.');
    expect(percentOf(2.04, 1)).toBe(205);
    expect(percentOf(null, 1)).toBeNull();
  });

  it('says why the card lists nothing: solid all through, already open, or no part – to click the model only while placing', () => {
    expect(partsNote({ solid: true, parts: [] })).toBe("This model is solid all through – there's no inside to open.");
    expect(partsNote({ solid: false, open: { d: 72.4 }, parts: [] })).toBe('The top is already open (Ø 72 mm).');
    expect(partsNote({ solid: false, open: null, parts: [] })).toBe('No part comes off cleanly here – click the model where it should open.');
    expect(partsNote({ solid: false, open: null, parts: [] }, { aiming: false })).toBe('No part comes off cleanly here.');
    expect(partsNote(bat400)).toBeNull();
  });

  it('says which parts the card offers something for: a lid always, a base only where a lock fits at some size', () => {
    expect(partOffered(lid100, bat100)).toBe(true);
    expect(partOffered(base100, bat100)).toBe(true);
    expect(partOffered(base400, bat400)).toBe(true);
    // a closed ball's base, which no lock fits up to 600 %: listed, with nothing to press
    expect(partOffered({ ...base100, least: { lock: null, tea: null } }, bat100)).toBe(false);
  });

  it('says why the fit test has nothing to try when the parts come off with nothing holding them', () => {
    expect(noFitTestWords([{ name: 'Dome and cap', hold: 'lock', least: 275 }])).toBe('Nothing to try: the dome and cap lift off at this size – a twist-lock fits from 275 %.');
    expect(noFitTestWords([{ name: 'Dome and cap', hold: 'lift' }])).toBe('Nothing to try: the dome and cap lift off with nothing holding them.');
    expect(noFitTestWords([{ name: 'Top', hold: 'lock', least: null }, { name: 'Base', kind: 'plug', hold: 'lock', least: 215 }])).toBe(
      'Nothing to try: the top lifts off at this size – no twist-lock fits; the base lifts out at this size – a twist-lock fits from 215 %.',
    );
    expect(noFitTestWords([{ name: 'Base', kind: 'plug', hold: 'lock', locks: true }])).toBe("Nothing to try: the base's twist-lock has no fit test of its own.");
  });

  it('reads out the part under the pointer: the lid and its lock, the handle it leaves on, the base', () => {
    expect(partReadout({ part: lid400, on: 'lid' }, bat400)).toBe('Dome and cap come off · twist-lock, 3 lugs, turn 19° · Ø 42 mm opening – takes a 38 mm tea light · the handle stays');
    expect(partReadout({ part: lid100, on: 'lid' }, bat100)).toBe('Dome and cap come off · too small for a lock at this size (roof 0.6 mm) – a twist-lock fits from 280 %');
    expect(partReadout({ part: lid400, on: 'handle' }, bat400)).toBe('The handle stays on the lantern – click to take off the dome and cap under it');
    expect(partReadout({ part: base400, on: 'base' }, bat400)).toBe('Base twists off underneath · Ø 57 mm opening · twist-lock, 3 lugs, turn 17°');
    expect(partReadout({ part: base100, on: 'base' }, bat100)).toBe('Base · too small for a lock at this size – twists off from 205 %');
    expect(partReadout({ part: { ...lid400, name: 'Top', handle: null }, on: 'lid' }, bat400)).toBe('Top comes off · twist-lock, 3 lugs, turn 19° · Ø 42 mm opening – takes a 38 mm tea light');
    expect(partReadout({ part: null, on: null }, bat400)).toBeNull();
    expect(HANDLE_PLANE).toBe('A cut here would take the handle with the top – click the dome to take off just the lid');
    expect(MIXED_PART).toBe('The circle crosses the model above and around its plane here – use a full cut, or move it to where the circle crosses only air');
    expect(stuckWords('Dome and cap', "the handle's crown", 'a leg')).toBe("Dome and cap can't come out: the handle's crown is over it and a leg is beside it");
  });

  it("says under a part's row what it gets: its twist-lock, why none fits, that it lifts off, or what moved or refused it", () => {
    expect(partMeta({ hold: 'lock', lock: lid400.lock, handle: true })).toBe('twist-lock, 3 lugs, 6 clicks – turn 19° · the handle stays');
    expect(partMeta({ hold: 'lock', kind: 'plug', lock: { mech: 'plug', theta: 23 } })).toBe('twist-lock, 3 lugs – turn 23° · coin slot');
    expect(partMeta({ hold: 'lock', known: true, least: 280 })).toBe('lifts off – too small for a lock here (twist-lock from 280 %)');
    expect(partMeta({ hold: 'lock', known: true })).toBe('lifts off – too small for a lock here');
    expect(partMeta({ hold: 'lock', known: true, why: 'pieces' })).toBe('lifts off – a twist-lock would leave it in pieces');
    expect(partMeta({ hold: 'lift', lock: null })).toBe('lifts off – sits on its cut face');
    expect(partMeta({ hold: 'lift', kind: 'plug' })).toBe('lifts out – nothing holds it');
    expect(partMeta({ hold: 'lock' })).toBe('comes off – Show pieces works out its lock');
    expect(partMeta({ hold: 'lock', lock: lid400.lock, note: { code: 'PART_STUCK' } })).toBe("can't come out – see the note");
    const gap = { code: 'PART_GAP', by: "the handle's feet", z: 115.4, need: 0.9 };
    expect(partMeta({ hold: 'lock', note: { ...gap, movedTo: 115.6 } })).toBe("the circle runs too close to the handle's feet at Z 115.4 – moved to Z 115.6");
    expect(partMeta({ hold: 'lock', note: gap })).toBe("the circle runs too close to the handle's feet at Z 115.4 – no face here leaves 0.9 mm");
    expect(partMeta({ hold: 'lock', note: { code: 'PART_MIXED' } })).toBe('left out – see the note');
  });

  it('says what a part is doing as it comes out along its way: each step, its number, and how far', () => {
    const dome = { name: 'Dome and cap', kind: 'lid', way: { turn: 19, up: false, lift: 4.6, dir: [0, 1, 0], out: [0, 0, 1], reach: 81 }, span: [-1, 0, 0] };
    const at = (part, f) => wayCaption(part, wayStep(part.way, f));
    expect(at(dome, 0)).toBeNull();
    expect(at(dome, 0.1)).toBe('Dome and cap: 1 of 3 · Turn it 19° to the left – it clicks free');
    expect(at(dome, 0.5)).toBe('Dome and cap: 2 of 3 · Lift it 5 mm');
    expect(at(dome, 0.9)).toBe('Dome and cap: 3 of 3 · Slide it out under the handle, square to it');
    expect(at(dome, 1)).toBeNull();
    // along the handle, or with none, sideways; a lid that lifts off is not turned
    expect(at({ ...dome, span: null, way: { ...dome.way, turn: 0 } }, 0.25)).toBe('Dome and cap: 1 of 2 · Lift it 5 mm');
    expect(at({ ...dome, span: null, way: { ...dome.way, turn: 0 } }, 0.75)).toBe('Dome and cap: 2 of 2 · Slide it out sideways');
    // straight off
    expect(at({ name: 'Top', way: { turn: 27, up: true, lift: 0, dir: null, out: [0, 0, 1], reach: 50 } }, 0.75)).toBe('Top: 2 of 2 · Lift it off');
    // the base, as it is fitted: seen from underneath
    const base = { name: 'Base', kind: 'plug', way: { turn: 17, up: true, lift: 0, dir: null, out: [0, 0, -1], reach: 0 } };
    expect(at(base, 0.25)).toBe('Base: 1 of 2 · Turn it 17° to the left, seen from underneath – it clicks free');
    expect(at(base, 0.75)).toBe('Base: 2 of 2 · Lift it out');
  });

  it('says what a part is doing as it goes on again (Shift+▶): the steps the other way round, counted as they are done', () => {
    const dome = { name: 'Dome and cap', kind: 'lid', way: { turn: 27, up: false, lift: 4.5, dir: [0, 1, 0], out: [0, 0, 1], reach: 60 }, span: [-1, 0, 0] };
    const on = (part, f) => wayCaption(part, wayStep(part.way, f), { on: true });
    expect(on(dome, 0.9)).toBe('Dome and cap: 1 of 3 · Slide it in under the handle, square to it');
    expect(on(dome, 0.5)).toBe('Dome and cap: 2 of 3 · Lower it 4.5 mm into place');
    expect(on(dome, 0.1)).toBe('Dome and cap: 3 of 3 · Turn it 27° to the right – it clicks shut');
    expect(on(dome, 0)).toBeNull();
    // straight on, turned to the left first; the base seen from underneath
    expect(on({ name: 'Top', way: { turn: 27, up: true, lift: 0, dir: null, out: [0, 0, 1], reach: 50 } }, 0.75)).toBe('Top: 1 of 2 · Set it on, turned 27° to the left');
    const base = { name: 'Base', kind: 'plug', way: { turn: 17, up: true, lift: 0, dir: null, out: [0, 0, -1], reach: 0 } };
    expect(on(base, 0.75)).toBe('Base: 1 of 2 · Push it in');
    expect(on(base, 0.25)).toBe('Base: 2 of 2 · Turn it 17° to the right, seen from underneath – it clicks shut');
  });

  it('says a cut across Z whose top holds some of a traced handle takes it with the top', () => {
    const under = { axis: 'z', at: 112, why: 'under a ledge where the shape widens', lip: { H: 6, clips: 0 }, comesOff: { side: 1, length: 88, fraction: 0.44 } };
    expect(takesHandle(under, bat400.handles)).toBe(true);
    expect(spotLabel(under, 'lock', { handles: bat400.handles })).toBe('Z 112 mm – top 88 mm comes off · 6 mm lip without clips – lifts off · under a ledge where the shape widens – takes the handle with the top');
    // over the handle's top, below the cut, or across X: not
    expect(takesHandle({ ...under, at: 198 }, bat400.handles)).toBe(false);
    expect(takesHandle({ ...under, comesOff: { side: -1, length: 112 } }, bat400.handles)).toBe(false);
    expect(takesHandle({ ...under, axis: 'x' }, bat400.handles)).toBe(false);
    expect(spotLabel(under, 'lock')).not.toContain('handle');
  });
});

describe('a lip in short stretches', () => {
  // just over the tips of a row of windows (the round lantern at 125): an opening's edge in its foot cuts the tongue
  const at125 = { axis: 'z', at: 125, area: 820, islands: 1, lip: { H: 6, clips: 0, why: 'edge', broken: true }, noLip: null, suggestedAt: 125.5, suggestedLip: { H: 6, clips: 0, whole: true }, comesOff: { side: 1, length: 113, fraction: 0.47 } };

  it('says so, and offers the half step where it is whole', () => {
    expect(lipWords(at125, 'lock', 2)).toBe('6 mm lip in short stretches, no clips – lifts off – move up to 125.5, where it is whole');
    expect(lipWords(at125, 'lift', 2)).toBe('6 mm lip in short stretches – lifts off – move up to 125.5, where it is whole');
    expect(lipWords({ ...at125, lip: { ...at125.lip, clips: 2 } }, 'snap', 2)).toBe('clicks on with 2 clips – its lip in short stretches – move up to 125.5, where it is whole');
    expect(lipWords({ ...at125, suggestedAt: null }, 'lock', 2)).toBe('6 mm lip in short stretches, no clips – lifts off');
    expect(lipVerdict(at125, 'lift')).toBe('short');
    // the move a target, which says what it snaps to
    const [target] = aimTargets({ lip: { axis: 2, at: 125.5, full: false, H: 6, whole: true } });
    expect(target).toEqual({ at: 125.5, kind: 'lip', whole: true });
    expect(snappedWords(target, 2)).toBe('snapped to where the lip is whole, at 125.5 mm');
  });
});

describe('picking a part on the model', () => {
  // the lid's entry as pick mode reads it at 400 %: its face up to its cap inside its circle, the family's faces from
  // 114.6, its free band at the face, and the handle's islands level by level (a leg each side, then the crown)
  const lid = {
    ...lid400, cap: 154.96, top: 166.4, from: 114.6, window: [30.86, 32.31],
    handle: { legs: 2, span: [-1, 0], levels: [{ z: 115.4, boxes: [[-41, -3, -37, 3], [37, -3, 41, 3]] }, { z: 190, boxes: [[-41, -3, 41, 3]] }] },
  };
  const base = { ...base400, solidTop: 7.6, reach: 36.9 };
  const table = { ...bat400, h: 0.8333, parts: [lid, base] };

  it('picks the lid on it, the lid under the handle it leaves on, the lid just under its face, and the base on the bottom', () => {
    expect(pickPart(table, [0, 0, 150])).toMatchObject({ part: lid, on: 'lid' });
    expect(pickPart(table, [20, 10, 120])).toMatchObject({ part: lid, on: 'lid' });
    // a leg beside the lid, and the crown over it: the handle, which stays
    expect(pickPart(table, [39, 0, 115.5])).toMatchObject({ part: lid, on: 'handle' });
    expect(pickPart(table, [0, 0, 190.5])).toMatchObject({ part: lid, on: 'handle' });
    // just under the face, inside the band: the lid
    expect(pickPart(table, [31, 0, 114])).toMatchObject({ part: lid, on: 'under' });
    expect(pickPart(table, [10, 0, 3])).toMatchObject({ part: base, on: 'base' });
    // the band round the lantern's middle, a post and the air between the legs: none
    expect(pickPart(table, [45, 0, 60])).toEqual({ part: null, index: -1, on: null });
    expect(pickPart(table, [39, 0, 150])).toEqual({ part: null, index: -1, on: null });
    expect(partReadout(pickPart(table, [39, 0, 115.5]), table)).toBe('The handle stays on the lantern – click to take off the dome and cap under it');
  });

  it('says over a plane under the handle that it would take the handle with the top, where the lid alone comes off', () => {
    expect(handlePlaneWords(bat400, 112)).toBe(HANDLE_PLANE);
    expect(handlePlaneWords(bat400, 101)).toBe(HANDLE_PLANE);
    // in the lower half the top a cut takes is most of the lantern: that the handle goes with it is no news there
    expect(handlePlaneWords(bat400, 99)).toBeNull();
    expect(handlePlaneWords(bat400, 20)).toBeNull();
    expect(handlePlaneWords(bat400, 0.3)).toBeNull();
    // over the handle's top, no parts table yet, no handle, or a lid that takes the handle with it: nothing
    expect(handlePlaneWords(bat400, 198)).toBeNull();
    expect(handlePlaneWords(null, 112)).toBeNull();
    expect(handlePlaneWords({ ...bat400, handles: [] }, 112)).toBeNull();
    expect(handlePlaneWords({ ...bat400, parts: [{ ...lid400, takesHandle: true }] }, 112)).toBeNull();
  });

  it("puts a part's face on the printer's layers, from the model's bottom or the cut under it", () => {
    expect(partFace(85.93, { from: 0, hl: 0.2 })).toBe(86);
    expect(partFace(115.66, { from: 0, hl: 0.2 })).toBe(115.6);
    expect(partFace(115.66, { from: 0, hl: 0.12 })).toBe(115.68);
    // over a cut at 40.05: its layers
    expect(partFace(86, { from: 40.05, hl: 0.2 })).toBe(86.05);
    expect(partFace(86.3, { from: 0, hl: 0 })).toBe(86.3);
  });

  it("keeps a part's circle in the free band round it, onto the band's middle from near it, and says which edge held it back", () => {
    const band = { lo: 30.86, hi: 32.31, gmin: 0.9 };
    // the finder's own width, from within the tolerance; elsewhere in the band as asked
    expect(partWidth(31.5, { ...band, tol: 0.2 })).toEqual({ r: 31.585, edge: null });
    expect(partWidth(31.5, { ...band, tol: 0 })).toEqual({ r: 31.5, edge: null });
    // past either edge less half the gap a face needs to print apart: held there
    expect(partWidth(40, band)).toEqual({ r: 31.86, edge: 'wide' });
    expect(partWidth(20, band)).toEqual({ r: 31.31, edge: 'narrow' });
    // a band too narrow to print apart in at all: its middle; none known: as asked
    expect(partWidth(40, { lo: 30, hi: 30.5, gmin: 0.9 })).toEqual({ r: 30.25, edge: null });
    expect(partWidth(40, { lo: null, hi: null, gmin: 0.9 })).toEqual({ r: 40, edge: null });
    // the finder's own width as it gave it, not the middle of the band it gave rounded: snapped onto, it is its pick
    expect(partWidth(23.6, { lo: 23.1435, hi: 24.1138, gmin: 0.9, tol: 0.1, mid: 23.6286 })).toEqual({ r: 23.6286, edge: null });
    expect(partWidth(23.6, { lo: 23.1435, hi: 24.1138, gmin: 0.9, tol: 0.1 })).toEqual({ r: 23.6287, edge: null });
    expect(widthWords(63.72, 'wide')).toBe('Ø 63.7 is as wide as fits here');
    expect(widthWords(62.62, 'narrow')).toBe('Ø 62.6 is as narrow as fits here');
    expect(widthWords(62, null)).toBe('');
    // the band the circle lies in, else the nearest
    const windows = [[2, 5.5], [30.86, 32.31], [40, 44]];
    expect(bandOf(windows, 31)).toEqual({ lo: 30.86, hi: 32.31 });
    expect(bandOf(windows, 35)).toEqual({ lo: 30.86, hi: 32.31 });
    expect(bandOf(windows, 38)).toEqual({ lo: 40, hi: 44 });
    expect(bandOf([], 38)).toBeNull();
  });

  it("says in a part's row where its face was moved to print apart, or to be one piece", () => {
    const gap = { code: 'PART_GAP', z: 85.2, need: 0.9, by: "the handle's feet", islands: 1 };
    expect(partMeta({ hold: 'lock', note: { ...gap, movedTo: 86 } })).toBe("the circle runs too close to the handle's feet at Z 85.2 – moved to Z 86");
    expect(partMeta({ hold: 'lock', note: gap })).toBe("the circle runs too close to the handle's feet at Z 85.2 – no face here leaves 0.9 mm");
    // through the cupola's ring of columns its face is in pieces
    expect(partMeta({ hold: 'lock', note: { ...gap, z: 95, islands: 12, movedTo: 97.4 } })).toBe('its face at Z 95 is in 12 pieces – moved to Z 97.4');
    expect(partMeta({ hold: 'lock', note: { ...gap, z: 95, islands: 12 } })).toBe('its face at Z 95 is in 12 pieces – no face near here is one piece');
  });

  it('says why a cut asked to lock gets no lock: a round wall with no straight stretch for a clip, or otherwise', () => {
    expect(noLockOf({ H: 6, clips: 4, why: [] })).toBeNull();
    expect(noLockOf({ H: 6, clips: 0, why: ['short'], twist: { theta: 10, tabs: 6 } })).toBeNull();
    expect(noLockOf({ H: 6, clips: 0, why: ['short'] })).toBe('round');
    expect(noLockOf({ H: 4.5, clips: 0, why: ['height'] })).toBe('other');
    expect(noLockOf(null)).toBe('other');
    expect(noLockTitle('round')).toBe('A round wall takes no clips – try a removable part (+ Removable part)');
    expect(noLockTitle('other')).toBe('No clip or twist-lock fits this cut here – try a removable part (+ Removable part)');
  });
});
