import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { SIDES, placementFrame, placementMatrix, toMat4 } from '../src/placement.js';

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
