import { beforeAll, describe, expect, it } from 'vitest';
import { parseSTL, triangleSoup, writeBinarySTL } from '../src/stl.js';
import { boxSolid, setup, soupOf } from './helpers.js';

beforeAll(setup);

describe('STL I/O', () => {
  it('round-trips a binary STL', () => {
    const box = boxSolid();
    const geometry = soupOf(box);
    const buffer = writeBinarySTL(geometry);
    expect(buffer.byteLength).toBe(84 + 12 * 50);
    expect(new DataView(buffer).getUint32(80, true)).toBe(12);
    const back = parseSTL(buffer);
    expect(Array.from(triangleSoup(back))).toEqual(Array.from(triangleSoup(geometry)));
    box.delete();
  });

  it('writes outward-facing normals', () => {
    const box = boxSolid(2, 2, 2);
    const buffer = writeBinarySTL(soupOf(box));
    const view = new DataView(buffer);
    for (let t = 0; t < 12; t++) {
      const o = 84 + t * 50;
      const n = [0, 4, 8].map((k) => view.getFloat32(o + k, true));
      const centroid = [0, 1, 2].map(
        (a) => ([0, 1, 2].reduce((s, v) => s + view.getFloat32(o + 12 + v * 12 + a * 4, true), 0)) / 3,
      );
      expect(n[0] * centroid[0] + n[1] * centroid[1] + n[2] * centroid[2]).toBeGreaterThan(0);
    }
    box.delete();
  });

  it('parses ASCII STL', () => {
    const ascii = `solid t
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 1 0
 endloop
endfacet
endsolid t`;
    const g = parseSTL(new TextEncoder().encode(ascii).buffer);
    expect(g.attributes.position.count).toBe(3);
  });

  it('rejects files without triangles', () => {
    expect(() => parseSTL(new ArrayBuffer(84))).toThrow();
  });
});
