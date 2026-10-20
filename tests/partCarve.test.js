// Parts that come off, carved: a lid inside a handle, a base from underneath, taken out of the model on its own
// (the dome and cap of the lantern modelled on the user's, lifting off: the twist-lock comes with the lock solids).
// The pure rules on rows of slices, the face put on the layers, what a part is and where it ends, its way out, and the
// carve itself. The engine's side of it is in engine.test.js.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { manifold } from '../src/manifold.js';
import { FINE_SPECK, findParts, fineSlices, sliceStack } from '../src/partFinder.js';
import { carveParts, checkPart, partFrame, partGap, partInFrame, partKind, partRows, placePart, shellCounts } from '../src/splitGeometry.js';
import { TO_PLANE, applyMat4 } from '../src/split.js';
import { gminOf } from '../src/locks.js';
import { setup } from './helpers.js';
import { batLanternSolid, box } from './lanternFixture.js';

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

const GMIN = gminOf(0.15);
const LAYERS = { from: 0, step: 0.2 };
/** The model's slices as the engine reads them for a part: the stack and the fine slices. */
const slicesOf = (m) => {
  const stack = sliceStack(m);
  return { stack, fine: fineSlices(m, stack.speck * FINE_SPECK) };
};
const cyl = (h, r, z = 0, seg = 64) => own(own(wasm.Manifold.cylinder(h, r, r, seg)).translate([0, 0, z]));

describe("a part's frame", () => {
  it('turns every part into a lid on top: the plane square to z, the part towards +z, nothing mirrored', () => {
    expect(partFrame({ axis: 2, side: 1 })).toBeNull();
    // under a plane across Z the frame is a half turn about x: z and y change sign
    const down = partFrame({ axis: 2, side: -1 });
    expect(applyMat4(down, [1, 2, 3])).toEqual([1, -2, -3]);
    expect(partInFrame({ at: 10, centre: [1, 2], r: 4, side: -1 })).toEqual({ c: [1, -2], z0: -10, R: 4 });
    // across X it is the plane frame (x → w), turned over for the −side
    expect(partFrame({ axis: 0, side: 1 })).toEqual([...TO_PLANE[0]]);
    const across = partFrame({ axis: 0, side: -1 });
    expect(applyMat4(across, [5, 1, 2])).toEqual([1, -2, -5]);
    // a point on the part's side of its plane is over the plane in the frame, every way
    for (const [axis, side] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
      const frame = partFrame({ axis, side });
      const p = [0, 0, 0];
      p[axis] = 10 + side;
      const { z0 } = partInFrame({ at: 10, centre: [0, 0], r: 1, side });
      expect((frame ? applyMat4(frame, p) : p)[2]).toBeGreaterThan(z0);
      // a signed permutation of determinant +1
      const m = frame ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
      expect(det).toBe(1);
    }
  });
});

describe('what a circle takes out (rows of [dmin, dmax])', () => {
  it('a lid: material inside the circle on the plane, nothing crossing it up to the cap', () => {
    // a ring r 2–3 under a wall r 8–9; the lid's material over the ring; then only the wall
    const rows = [[[2, 3], [8, 9]], [[0, 2.5], [8, 9]], [[7, 9]]];
    expect(partKind(rows, 5)).toEqual({ kind: 'lid', cap: 2, cross: null });
    // nothing stands round the circle at all: it takes everything past the plane
    expect(partKind([[[0, 3]], [[0, 2]]], 5)).toEqual({ kind: 'full', cap: 2, cross: null });
    // the disc empty on the plane: nothing to take
    expect(partKind([[[6, 8]], [[0, 2]]], 5)).toEqual({ kind: 'empty', cap: 0, cross: null });
  });

  it('mixed: the wall crosses material on the way up, at the row it first does', () => {
    expect(partKind([[[0, 3], [8, 9]], [[0, 4], [8, 9]], [[0, 6]], []], 5)).toEqual({ kind: 'mixed', cap: 3, cross: 2 });
    // a lid at the model's end whose wall crosses nothing is a lid all the same
    expect(partKind([[[0, 3], [8, 9]], []], 5, { end: true }).kind).toBe('lid');
  });

  it('a base: from the model\'s end through a solid floor, ragged top and all, and nothing cut standing on it', () => {
    const zs = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    // the floor to 0.2, a cup on it inside the circle, then air
    const floor = [[[0, 10]], [[0, 10]], [[0, 10]], [[3, 4], [8, 9]], [[3, 4], [8, 9]], [[8, 9]], [[8, 9]]];
    expect(partKind(floor, 6, { end: true, zs, rag: 0.15 })).toEqual({ kind: 'plug', cap: 5, cross: null });
    // a post standing on the floor that the wall cuts
    const post = [[[0, 10]], [[0, 10]], [[5, 7], [8, 9]], [[5, 7], [8, 9]], [[5, 7]], [], []];
    expect(partKind(post, 6, { end: true, zs, rag: 0.15 }).kind).toBe('mixed');
    // a ragged floor top: crossed again just over the floor, within the rag
    const ragged = [[[0, 10]], [[0, 10]], [[3, 4]], [[5.5, 6.5], [3, 4]], [[3, 4]], [[8, 9]], []];
    expect(partKind(ragged, 6, { end: true, zs, rag: 0.25 }).kind).toBe('plug');
    expect(partKind(ragged, 6, { end: true, zs, rag: 0.15 }).kind).toBe('mixed');
    // a rounded bottom edge: the wall meets the floor only just over the end, within the rag
    const rounded = [[[0, 5]], [[0, 10]], [[0, 10]], [[3, 4]], [[8, 9]], [], []];
    expect(partKind(rounded, 6, { end: true, zs, rag: 0.15 }).kind).toBe('plug');
    expect(partKind(rounded, 6, { end: true, zs, rag: 0.05 }).kind).toBe('mixed');
    // a recessed middle: a ring on the bed, then the floor over the circle's centre
    const recessed = [[[3, 10]], [[0, 10]], [[0, 10]], [[3, 4]], [[8, 9]], [], []];
    expect(partKind(recessed, 6, { end: true, zs, rag: 0.15 }).kind).toBe('plug');
    expect(partKind(recessed, 6, { end: true, zs, rag: 0.05 }).kind).toBe('mixed');
    // a floor with the wall up the model's side over it, and a model solid all the way up: no inside to open
    expect(partKind([[[0, 10]], [[0, 10]], [[5, 7]], [[5, 7]], [[5, 7]], [[5, 7]], [[5, 7]]], 6, { end: true, zs, rag: 0.15 }).kind).toBe('mixed');
    expect(partKind(zs.map(() => [[0, 10]]), 6, { end: true, zs, rag: 0.15 }).kind).toBe('mixed');
    // a ring under it, not a floor: the wall cuts the ring
    expect(partKind([[[4, 10]], [[4, 10]], [[8, 9]], [[8, 9]]], 6, { end: true, zs, rag: 0.15 }).kind).toBe('mixed');
    // a floor with nothing over it inside the circle: its top is the cap
    expect(partKind([[[0, 10]], [[0, 10]], [[8, 9]], [[8, 9]]], 6, { end: true, zs, rag: 0.15 })).toEqual({ kind: 'plug', cap: 2, cross: null });
    // a foot's rim round a bottom recessed a layer, outside the circle on the model's end: the floor starts within the
    // rag, and the base is there all the same; recessed further than the rag, the circle holds nothing on the end
    const footed = [[[7, 10]], [[7, 10]], [[0, 10]], [[0, 10]], [[3, 4], [8, 9]], [[8, 9]], []];
    expect(partKind(footed, 6, { end: true, zs, rag: 0.25 })).toEqual({ kind: 'plug', cap: 5, cross: null });
    expect(partKind(footed, 6, { end: true, zs, rag: 0.15 })).toEqual({ kind: 'empty', cap: 0, cross: null });
    // a plane above the end is a lid's: nothing under it is looked past
    expect(partKind(footed, 6, { zs, rag: 0.25 }).kind).toBe('empty');
  });
});

describe('the bat lantern fixture at 100 % (n 0.4, layers 0.2, clearance 0.15)', () => {
  let fx;
  let slices;
  let lid;
  beforeAll(() => {
    fx = batLanternSolid();
    slices = slicesOf(fx);
    lid = findParts(fx, { stack: slices.stack }).parts.find((e) => e.kind === 'lid');
  });
  const at = (z0, R = lid.r, c = lid.centre) => ({ c, z0, R });
  const place = (z0, R) => placePart(slices.stack, slices.fine, at(z0, R), { hl: 0.2, gmin: GMIN, grid: LAYERS });

  it("takes the finder's lid where it found it: face, window, cap and the way out", () => {
    const got = place(lid.face);
    expect(got).toMatchObject({ ok: true, why: null, kind: 'lid', asked: 29, z0: 29, islands: 1, end: false });
    expect(got.lo).toBeCloseTo(lid.window[0], 4);
    expect(got.hi).toBeCloseTo(lid.window[1], 4);
    expect(got.gap).toBeCloseTo(lid.gap, 4);
    const part = checkPart(fx, slices.stack, slices.fine, at(lid.face), { hl: 0.2, gmin: GMIN, grid: LAYERS, letter: 'A', minLift: 0.2 });
    expect(part.cap).toBeCloseTo(lid.cap, 3);
    expect(part.next).toBeCloseTo(lid.next, 3);
    expect(part.top).toBeCloseTo(lid.top, 3);
    // the handle stands over it, covering a fifth: the dome and cap, the handle's two legs at its face
    expect(part).toMatchObject({ name: 'Dome and cap', handle: true, legs: 2 });
    expect(part.covered).toBeCloseTo(0.2, 1);
    // lifted 0.95 mm it slides out between the legs, along ±Y
    expect(part.way).toMatchObject({ up: false, lift: 0.95, dir: [0, 1], dirs: [67.5, 90, 112.5, 247.5, 270, 292.5] });
  });

  it('puts the face on the layers: an off-grid face snaps to the nearest boundary', () => {
    expect(place(28.93)).toMatchObject({ ok: true, asked: 29, z0: 29 });
    expect(place(29.09)).toMatchObject({ ok: true, asked: 29, z0: 29 });
    // a 0.25 mm layer: another grid
    expect(placePart(slices.stack, slices.fine, at(29.2), { hl: 0.25, gmin: GMIN, grid: { from: 0, step: 0.25 } })).toMatchObject({ ok: true, asked: 29.25 });
  });

  it('moves a face whose rim is too near the legs up a layer or two, and refuses one further down', () => {
    // a layer under the face the window is 0.79 wide, under the 0.9 the rim needs to print apart
    const low = place(28.8);
    expect(low).toMatchObject({ ok: true, asked: 28.8, z0: 29 });
    expect(low.tried.gap).toBeCloseTo(0.787, 3);
    expect(low.tried.islands).toBe(1);
    // where the legs fuse into the dome the circle runs into them: no face within two layers prints apart
    const fused = place(28.4);
    expect(fused).toMatchObject({ ok: false, why: 'gap', asked: 28.4, nearest: 29 });
    expect(fused.tried.gap).toBe(0);
    // a wider clearance needs a wider gap: 1.2 at 0.3, which the face at 29.0 has
    expect(placePart(slices.stack, slices.fine, at(29), { hl: 0.2, gmin: gminOf(0.3), grid: LAYERS })).toMatchObject({ ok: true, z0: 29 });
    expect(placePart(slices.stack, slices.fine, at(29), { hl: 0.2, gmin: 1.6, grid: LAYERS })).toMatchObject({ ok: true, z0: 29.2 });
  });

  it("refuses a face of several islands – the cupola's 12 columns – and names the nearest whole one", () => {
    const columns = place(31.6, 4.5);
    expect(columns).toMatchObject({ ok: false, why: 'gap', nearest: 32.6 });
    expect(columns.tried.islands).toBe(12);
    // the window round them is wide: only the face's pieces are wrong
    expect(columns.tried.gap).toBeGreaterThan(GMIN);
    // and the rows' own reading: one window, twelve islands inside it
    const { rows, face, zs, near } = partRows(slices.stack, slices.fine, lid.centre, 31.6, 0.2);
    expect(partGap(rows, face, lid.centre, 4.5, GMIN)).toMatchObject({ ok: false, islands: 12 });
    // a slice every half layer for a millimetre, then the levels over it: always going up
    expect(near).toBe(11);
    expect(zs.every((z, j) => !j || z > zs[j - 1])).toBe(true);
  });

  it('a circle that crosses the model past its face is mixed; one in air on its plane takes nothing', () => {
    // a post on a disc under a flange: round the post the circle runs into the flange 10 mm up
    const tower = own(wasm.Manifold.union([cyl(5, 10), cyl(15, 5, 5), cyl(2, 15, 20)]));
    const t = slicesOf(tower);
    expect(placePart(t.stack, t.fine, { c: [0, 0], z0: 10, R: 8 }, { hl: 0.2, gmin: GMIN, grid: LAYERS })).toMatchObject({ ok: false, why: 'mixed', kind: 'mixed' });
    // on the lantern, the circle running into the handle's leg right at its face is no print gap: refused as such
    expect(place(29, 10)).toMatchObject({ ok: false, why: 'gap', kind: 'mixed' });
    // in the air inside the lantern, under the dome, the disc holds nothing on the plane
    expect(place(20, 5)).toMatchObject({ ok: false, why: 'empty', kind: 'empty' });
  });

  it("can't take the floor cup out: the dome is over it and the posts round it", () => {
    // the cup on the floor inside the posts: a lid that prints apart, covered all over by the dome
    const cup = checkPart(fx, slices.stack, slices.fine, at(7.6, 6), { hl: 0.2, gmin: GMIN, grid: LAYERS, letter: 'B', minLift: 0.2 });
    expect(cup).toMatchObject({ ok: true, kind: 'lid', handle: false, name: 'Part B' });
    expect(cup.covered).toBeGreaterThan(0.9);
    expect(cup.way).toMatchObject({ up: false, lift: null });
  });

  it("can't take the dome and cap out from under a crown lowered onto it", () => {
    // a bar across the legs 0.3 mm over the cap: no room to lift it clear of the spires and slide it out
    const lowered = own(wasm.Manifold.union([fx, own(box([-10.5, -1.15, 39], [10.5, 1.15, 40]))]));
    const s = slicesOf(lowered);
    const part = checkPart(lowered, s.stack, s.fine, at(29), { hl: 0.2, gmin: GMIN, grid: LAYERS, letter: 'A', minLift: 0.2 });
    expect(part).toMatchObject({ ok: true, name: 'Dome and cap', way: { up: false, lift: null } });
    expect(part.top).toBeCloseTo((part.cap + 39) / 2, 2);
  });

  it('carves the dome and cap out in one piece and leaves the lantern with its handle in one', () => {
    const parts = [{ frame: null, c: lid.centre, z0: 29, R: lid.r, top: lid.top }];
    const { body, lids } = carveParts(fx, parts);
    own(body);
    own(lids[0].solid);
    expect(lids[0]).toMatchObject({ shells: 1, loose: 0 });
    expect(shellCounts(body)).toEqual({ solids: 1, hollows: 0 });
    // nothing lost or doubled
    expect(body.volume() + lids[0].solid.volume()).toBeCloseTo(fx.volume(), 3);
    // the handle's crown stays on the body; the lid sits on its face, inside the circle
    expect(body.boundingBox().max[2]).toBeCloseTo(50, 3);
    const lb = lids[0].solid.boundingBox();
    expect(lb.min[2]).toBeCloseTo(29, 6);
    expect(lb.max[2]).toBeCloseTo(38.7, 2);
    expect(Math.hypot(lb.max[0], 0)).toBeLessThan(lid.window[0] + 0.01);
    // what the body keeps at the face is the dome's ring outside the circle and the legs
    const face = own(lids[0].solid.slice(29.05));
    expect(face.area()).toBeGreaterThan(30);
  });
});

describe('a base and what goes back to the body', () => {
  it('takes a base out from underneath, a millimetre past the model\'s end, and drops it straight out', () => {
    const fx = own(batLanternSolid().scale([3, 3, 3]));
    const s = slicesOf(fx);
    const base = findParts(fx, { stack: s.stack }).parts.find((e) => e.kind === 'plug');
    const part = checkPart(fx, s.stack, s.fine, { c: base.centre, z0: 0, R: base.r }, { hl: 0.2, gmin: GMIN, grid: LAYERS, letter: 'B', minLift: 0.6 });
    expect(part).toMatchObject({ ok: true, kind: 'plug', end: true, asked: 0, z0: 0, name: 'Base', way: { up: true, lift: 0 } });
    // its cap is the floor cup's top
    expect(part.cap).toBeCloseTo(25.5, 2);
    const { body, lids } = carveParts(fx, [{ frame: null, c: base.centre, z0: 0, R: base.r, top: part.top, plug: true }]);
    own(body);
    own(lids[0].solid);
    expect(lids[0].shells).toBe(1);
    expect(shellCounts(body)).toEqual({ solids: 1, hollows: 0 });
    const pb = lids[0].solid.boundingBox();
    expect(pb.min[2]).toBeCloseTo(0, 6);
    expect(pb.max[2]).toBeCloseTo(25.5, 2);
    // the whole disc of its bottom comes out: Ø 42.8
    expect(own(lids[0].solid.slice(0.1)).area()).toBeCloseTo(Math.PI * base.r ** 2, -1);
    expect(body.volume() + lids[0].solid.volume()).toBeCloseTo(fx.volume(), 2);
  });

  it("takes a base out past a recessed bottom, and won't take one whose wall cuts what stands on its floor", () => {
    // a cup 40 mm tall whose floor is recessed 0.15 mm in the middle: the bed holds a ring, the floor starts over it
    const cup = own(own(wasm.Manifold.union([cyl(3, 10), own(cyl(37, 10, 3).subtract(cyl(37.1, 9, 2.95)))])).subtract(cyl(0.3, 4, -0.15)));
    const s = slicesOf(cup);
    expect(placePart(s.stack, s.fine, { c: [0, 0], z0: 0, R: 7 }, { hl: 0.2, gmin: GMIN, grid: LAYERS })).toMatchObject({ ok: true, kind: 'plug', end: true });
    // the fixture's base at 300 % with a circle past its window: its wall runs through the posts
    const fx = own(batLanternSolid().scale([3, 3, 3]));
    const f = slicesOf(fx);
    expect(placePart(f.stack, f.fine, { c: [0, 0], z0: 0, R: 30 }, { hl: 0.2, gmin: GMIN, grid: LAYERS })).toMatchObject({ ok: false, why: 'mixed', kind: 'mixed' });
  });

  it('a shell inside the circle that does not reach the plane goes back to the body', () => {
    // a plate with a post on it, and a loose cube beside the post, inside the circle over the plane
    const model = own(wasm.Manifold.compose([own(wasm.Manifold.union([cyl(2, 20), cyl(8, 3, 2)])), own(box([4, -0.5, 6], [5, 0.5, 7]))]));
    const s = slicesOf(model);
    const placed = placePart(s.stack, s.fine, { c: [0, 0], z0: 5, R: 8 }, { hl: 0.2, gmin: GMIN, grid: LAYERS });
    // nothing stands round the circle past the plane: it takes all there is there
    expect(placed).toMatchObject({ ok: true, kind: 'full', islands: 1 });
    const { body, lids } = carveParts(model, [{ frame: null, c: [0, 0], z0: 5, R: 8, top: 11 }]);
    own(body);
    own(lids[0].solid);
    expect(lids[0]).toMatchObject({ shells: 1, loose: 1 });
    expect(lids[0].solid.volume()).toBeCloseTo(cyl(5, 3, 5).volume(), 3);
    expect(shellCounts(body)).toEqual({ solids: 2, hollows: 0 });
    expect(body.volume() + lids[0].solid.volume()).toBeCloseTo(model.volume(), 3);
  });

  it('a sealed hollow inside a part goes with it', () => {
    // a post with a sealed pocket in its top half
    const post = own(own(wasm.Manifold.union([cyl(2, 20), cyl(8, 3, 2)])).subtract(cyl(2, 1, 6.5)));
    const { body, lids } = carveParts(post, [{ frame: null, c: [0, 0], z0: 5, R: 8, top: 11 }]);
    own(body);
    own(lids[0].solid);
    expect(shellCounts(lids[0].solid)).toEqual({ solids: 1, hollows: 1 });
    expect(shellCounts(body)).toEqual({ solids: 1, hollows: 0 });
    expect(lids[0].solid.volume()).toBeCloseTo(cyl(5, 3, 5).volume() - cyl(2, 1, 6.5).volume(), 3);
  });

  it('carves parts in any frame: the same lid lying under its plane, or across X', () => {
    const fx = own(batLanternSolid());
    const upright = carveParts(fx, [{ frame: null, c: [0, 0], z0: 29, R: 7.8732, top: 42.2332 }]);
    own(upright.body);
    own(upright.lids[0].solid);
    // the lantern turned over: its dome hangs under the plane at z −29
    const over = own(fx.rotate([180, 0, 0]));
    const down = { axis: 2, at: -29, centre: [0, 0], r: 7.8732, side: -1 };
    const flipped = carveParts(over, [{ frame: partFrame(down), ...partInFrame(down), top: 42.2332 }]);
    own(flipped.body);
    own(flipped.lids[0].solid);
    expect(flipped.lids[0].solid.volume()).toBeCloseTo(upright.lids[0].solid.volume(), 4);
    expect(flipped.lids[0].solid.boundingBox().max[2]).toBeCloseTo(-29, 6);
    // laid on its side, the lantern's up along +X
    const side = own(fx.rotate([0, 90, 0]));
    const across = { axis: 0, at: 29, centre: [0, 0], r: 7.8732, side: 1 };
    const turned = carveParts(side, [{ frame: partFrame(across), ...partInFrame(across), top: 42.2332 }]);
    own(turned.body);
    own(turned.lids[0].solid);
    expect(turned.lids[0].solid.volume()).toBeCloseTo(upright.lids[0].solid.volume(), 4);
    expect(turned.lids[0].solid.boundingBox().min[0]).toBeCloseTo(29, 6);
    expect(shellCounts(turned.body)).toEqual({ solids: 1, hollows: 0 });
  });

  it('takes several parts out in one subtraction', () => {
    const fx = own(batLanternSolid());
    const lid = { frame: null, c: [0, 0], z0: 29, R: 7.8732, top: 42.2332 };
    const base = { frame: null, c: [0, 0], z0: 0, R: 7, top: 12, plug: true };
    const both = carveParts(fx, [lid, base]);
    own(both.body);
    both.lids.forEach((l) => own(l.solid));
    const one = carveParts(fx, [lid]);
    own(one.body);
    own(one.lids[0].solid);
    expect(both.lids.map((l) => l.shells)).toEqual([1, 1]);
    expect(both.lids[0].solid.volume()).toBeCloseTo(one.lids[0].solid.volume(), 6);
    expect(both.body.volume() + both.lids[0].solid.volume() + both.lids[1].solid.volume()).toBeCloseTo(fx.volume(), 3);
  });
});
