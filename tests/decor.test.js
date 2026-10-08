import { beforeAll, describe, expect, it } from 'vitest';
import { DECOR_KINDS, buildDecor, decorPartId, normaliseDecorSpec } from '../src/decor.js';
import { manifold } from '../src/manifold.js';
import { setup } from './helpers.js';

let wasm;
beforeAll(async () => {
  await setup();
  wasm = manifold();
});

describe('generated decorations', () => {
  let okStatus;
  beforeAll(() => {
    const ball = wasm.Manifold.sphere(1);
    okStatus = ball.status();
    ball.delete();
  });
  const specs = [
    { kind: 'berry', radius: 2.5 },
    { kind: 'star', radius: 5, height: 1.5 },
    { kind: 'star', radius: 2, height: 0.6, points: 6, skirt: 1 },
    { kind: 'leaf', length: 8, width: 4, height: 1.2 },
    { kind: 'holly', length: 10, width: 5, height: 1.4, skirt: 0.8 },
    { kind: 'rosette', radius: 4, height: 1.4 },
    { kind: 'dome', length: 6, width: 4, height: 2 },
    { kind: 'sprig', length: 20, width: 9, height: 1.6 },
    { kind: 'sprig', length: 40, width: 14, height: 2.5, skirt: 1.5 },
  ];
  for (const spec of specs) {
    it(`${decorPartId(spec)} is one watertight solid of the asked size, standing on z = 0 with its skirt below`, () => {
      const s = normaliseDecorSpec(spec);
      const m = buildDecor(wasm, spec);
      expect(m.isEmpty()).toBe(false);
      expect(m.status()).toEqual(okStatus);
      expect(m.volume()).toBeGreaterThan(0);
      const pieces = m.decompose();
      expect(pieces).toHaveLength(1);
      pieces.forEach((p) => p.delete());
      const { min, max } = m.boundingBox();
      expect(min[2]).toBeCloseTo(-s.skirt, 1);
      // centred on the z axis
      expect(min[0] + max[0]).toBeCloseTo(0, 1);
      expect(min[1] + max[1]).toBeCloseTo(0, 1);
      const sizeX = max[0] - min[0], sizeY = max[1] - min[1], top = max[2];
      if (s.kind === 'berry') {
        expect(sizeX).toBeCloseTo(2 * s.radius, 1);
        expect(top).toBeCloseTo(s.radius * 1.65, 1);
      } else if (s.kind === 'star' || s.kind === 'rosette') {
        expect(Math.max(sizeX, sizeY)).toBeGreaterThan(1.85 * s.radius);
        expect(Math.max(sizeX, sizeY)).toBeLessThan(2.05 * s.radius);
        expect(top).toBeGreaterThanOrEqual(s.height - 0.01);
      } else {
        expect(sizeX).toBeCloseTo(s.length, 0);
        expect(sizeY).toBeGreaterThan(0.8 * s.width);
        expect(sizeY).toBeLessThan(1.25 * s.width);
        expect(top).toBeGreaterThan(0.5 * s.height);
      }
      m.delete();
    });
  }

  it('normalises specs and gives every kind a stable id', () => {
    expect(normaliseDecorSpec({ kind: 'nonsense' }).kind).toBe('berry');
    expect(normaliseDecorSpec({ kind: 'star', radius: 1e9, height: -3 })).toMatchObject({ radius: 100, height: 0.1, points: 5, skirt: 0 });
    expect(decorPartId({ kind: 'leaf', length: 8.004, width: 4 })).toBe(decorPartId({ kind: 'leaf', length: 8, width: 4 }));
    expect(Object.keys(DECOR_KINDS)).toEqual(['berry', 'star', 'leaf', 'holly', 'rosette', 'dome', 'sprig']);
  });
});
