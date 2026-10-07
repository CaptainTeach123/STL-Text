import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { ATTACH_ROTATIONS, SIDES, eulerMatrix, placementFrame, placementMatrix, sideFacing, snapPartTo, toMat4 } from '../src/placement.js';

const close = (v, [x, y, z]) => {
  expect(v.x).toBeCloseTo(x, 6);
  expect(v.y).toBeCloseTo(y, 6);
  expect(v.z).toBeCloseTo(z, 6);
};

describe('placementFrame', () => {
  it('top face: reads along +X with up = +Y', () => {
    const f = placementFrame(SIDES.top);
    close(f.x, [1, 0, 0]);
    close(f.y, [0, 1, 0]);
    close(f.z, [0, 0, 1]);
  });

  it('front face (-Y): reads left to right along +X, standing upright', () => {
    const f = placementFrame(SIDES.front);
    close(f.x, [1, 0, 0]);
    close(f.y, [0, 0, 1]);
  });

  it('back face (+Y): reads along -X as seen from behind', () => {
    const f = placementFrame(SIDES.back);
    close(f.x, [-1, 0, 0]);
    close(f.y, [0, 0, 1]);
  });

  it('right face (+X) reads along +Y', () => {
    const f = placementFrame(SIDES.right);
    close(f.x, [0, 1, 0]);
    close(f.y, [0, 0, 1]);
  });

  it('is always right-handed and orthonormal', () => {
    for (const n of [[0.3, -0.5, 0.8], [0, 0, -1], [1, 1, 0], [0.01, 0, 0.9999]]) {
      for (const spin of [0, 33, 90, -120]) {
        const { x, y, z } = placementFrame(n, spin);
        expect(x.length()).toBeCloseTo(1, 6);
        expect(y.length()).toBeCloseTo(1, 6);
        expect(x.dot(y)).toBeCloseTo(0, 6);
        expect(x.dot(z)).toBeCloseTo(0, 6);
        expect(y.dot(z)).toBeCloseTo(0, 6);
        expect(new Vector3().crossVectors(x, y).dot(z)).toBeCloseTo(1, 6);
      }
    }
  });

  it('spin rotates counter-clockwise about the normal', () => {
    const f = placementFrame(SIDES.top, 90);
    close(f.x, [0, 1, 0]);
    close(f.y, [-1, 0, 0]);
  });
});

describe('placementMatrix', () => {
  it('maps local origin to the position and local Z to the normal', () => {
    const m = placementMatrix({ position: [5, 6, 7], normal: [0, -1, 0], spin: 0 });
    close(new Vector3(0, 0, 0).applyMatrix4(m), [5, 6, 7]);
    close(new Vector3(0, 0, 1).applyMatrix4(m), [5, 5, 7]);
    expect(toMat4(m)).toHaveLength(16);
  });
});

describe('part poses', () => {
  const pose = (extra = {}) => ({ attach: 'bottom', tilt: 0, roll: 0, spin: 0, normal: [0, 0, 1], ...extra });
  const facing = (item) => sideFacing(item, [0, 0, -1]); // which side points into a floor under the part

  it('eulerMatrix rotates about X, then Y, then Z like Manifold.rotate()', () => {
    // from a probe against Manifold: the marker (10.5, 0.5, 0.5) rotated by [30, 40, 50] lands at (5.31, 6.62, -6.23)
    const v = new Vector3(10.5, 0.5, 0.5).applyMatrix4(eulerMatrix([30, 40, 50]));
    expect([v.x, v.y, v.z].map((c) => Math.round(c * 100) / 100)).toEqual([5.31, 6.62, -6.23]);
    const w = new Vector3(10.5, 0.5, 0.5).applyMatrix4(eulerMatrix([0, 90, 0]));
    expect([w.x, w.y, w.z].map((c) => Math.round(c * 100) / 100)).toEqual([0.5, 0.5, -10.5]);
  });

  it('the attach side faces down when the part is not turned', () => {
    for (const side of Object.keys(ATTACH_ROTATIONS)) expect(facing(pose({ attach: side }))).toBe(side);
    // ... on any surface
    expect(sideFacing(pose({ attach: 'left', normal: [0, -1, 0] }), [0, 1, 0])).toBe('left');
    expect(sideFacing(pose({ attach: 'top', normal: [1, 0, 0], spin: 45 }), [-1, 0, 0])).toBe('top');
  });

  it('tilt and roll turn another side down', () => {
    expect(facing(pose({ tilt: 90 }))).toBe('front'); // -Y comes down
    expect(facing(pose({ tilt: -90 }))).toBe('back');
    expect(facing(pose({ roll: 90 }))).toBe('right'); // +X comes down (as ATTACH_ROTATIONS.right says)
    expect(facing(pose({ roll: -90 }))).toBe('left');
    expect(facing(pose({ tilt: 180 }))).toBe('top');
    expect(facing(pose({ attach: 'front', tilt: 90 }))).toBe('top'); // front down, then turned once more
    expect(facing(pose({ tilt: 30 }))).toBe('bottom'); // a lean keeps the same side down
  });

  it('a standing plate beside a wall faces the wall with its big face', () => {
    // the plate stands on the floor (tilt 90) south of a wall whose outward normal is -Y: its original bottom now points +Y, at the wall
    const standing = pose({ tilt: 90, normal: [0, 0, 1] });
    expect(sideFacing(standing, [0, 1, 0])).toBe('bottom');
    const patch = snapPartTo(standing, { point: [0, -15, 2], normal: [0, -1, 0] });
    expect(patch).toEqual({ position: [0, -15, 2], normal: [0, -1, 0], attach: 'bottom', tilt: 0, roll: 0 });
  });

  it('snapping a part that already lies flat keeps its attach side', () => {
    for (const side of ['bottom', 'top', 'left']) {
      const patch = snapPartTo(pose({ attach: side, spin: 30 }), { point: [1, 2, 3], normal: [0, 0, 1] });
      expect(patch.attach).toBe(side);
      expect(patch.position).toEqual([1, 2, 3]);
    }
    // a part lying with its back on a wall and then snapped to the floor attaches by whichever side faced the floor: its bottom
    const onWall = pose({ attach: 'back', normal: [0, -1, 0] });
    expect(snapPartTo(onWall, { point: [0, 0, 0], normal: [0, 0, 1] }).attach).toBe(sideFacing(onWall, [0, 0, -1]));
  });
});
