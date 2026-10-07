import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildCrossSection,
  buildTextSolid,
  capHeightUnits,
  fontLabel,
  layoutPolygons,
  buildCrossSectionInfo,
  printLimits,
  roundCorners,
  thinStrokeReport,
} from '../src/textGeometry.js';
import { bounds, inter, loadFont, setup } from './helpers.js';

let font;
beforeAll(async () => {
  await setup();
  font = inter();
});

const size = (cs) => {
  const { min, max } = cs.bounds();
  return [max[0] - min[0], max[1] - min[1]];
};

describe('fonts', () => {
  it('reads a readable family name', () => {
    expect(fontLabel(font)).toMatch(/Inter/);
    expect(fontLabel({}, 'fallback')).toBe('fallback');
  });

  it('measures cap height from the H glyph', () => {
    expect(capHeightUnits(font)).toBeGreaterThan(font.unitsPerEm * 0.6);
  });
});

describe('text -> solid', () => {
  it('makes a valid solid whose capitals are `size` tall, centred on the origin', () => {
    const solid = buildTextSolid(font, 'HHH', { size: 12, depth: 2, overlap: 0, mode: 'emboss' });
    expect(solid.status()).toBe('NoError');
    expect(solid.volume()).toBeGreaterThan(0);
    const b = bounds(solid);
    expect(b.size[1]).toBeCloseTo(12, 1); // cap height
    expect(b.min[2]).toBeCloseTo(0, 6);
    expect(b.max[2]).toBeCloseTo(2, 6);
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(0, 3);
    expect((b.min[1] + b.max[1]) / 2).toBeCloseTo(0, 3);
    solid.delete();
  });

  it('scales linearly with size', () => {
    const a = buildCrossSection(font, 'Hello', { size: 10 });
    const b = buildCrossSection(font, 'Hello', { size: 20 });
    expect(size(b)[0] / size(a)[0]).toBeCloseTo(2, 2);
    expect(size(b)[1] / size(a)[1]).toBeCloseTo(2, 2);
    a.delete();
    b.delete();
  });

  it('applies letter spacing and line spacing', () => {
    const base = buildCrossSection(font, 'AAA', { size: 10 });
    const wide = buildCrossSection(font, 'AAA', { size: 10, letterSpacing: 3 });
    expect(size(wide)[0] - size(base)[0]).toBeCloseTo(6, 1); // two gaps
    const two = buildCrossSection(font, 'AAA\nAAA', { size: 10, lineSpacing: 2 });
    expect(size(two)[1] - size(base)[1]).toBeCloseTo(20, 0);
    [base, wide, two].forEach((c) => c.delete());
  });

  it('aligns lines left / center / right', () => {
    // line 1 is long, line 2 is short; polygons with y < 0 belong to line 2
    const edges = (align) => {
      const polys = layoutPolygons(font, 'WWWW\ni', { size: 10, align });
      const second = polys.filter((p) => p.every(([, y]) => y < 0));
      const first = polys.filter((p) => p.some(([, y]) => y >= 0));
      const xs = (ps) => ps.flat().map(([x]) => x);
      return {
        firstMin: Math.min(...xs(first)), firstMax: Math.max(...xs(first)),
        secondMin: Math.min(...xs(second)), secondMax: Math.max(...xs(second)),
      };
    };
    const left = edges('left');
    expect(left.secondMin - left.firstMin).toBeLessThan(2); // flush with the long line's left edge
    const right = edges('right');
    expect(right.firstMax - right.secondMax).toBeLessThan(2); // flush with its right edge
    const center = edges('center');
    const mid = (center.firstMin + center.firstMax) / 2;
    expect((center.secondMin + center.secondMax) / 2).toBeCloseTo(mid, 0);
  });

  it('weight offset thickens and thins', () => {
    const area = (weight) => {
      const cs = buildCrossSection(font, 'Hi', { size: 10, weight });
      const a = cs.area();
      cs.delete();
      return a;
    };
    expect(area(0.3)).toBeGreaterThan(area(0));
    expect(area(-0.3)).toBeLessThan(area(0));
  });

  it('rounds corners: more arc vertices, nearly the same area, counters kept', () => {
    const sharp = buildCrossSection(font, 'HE', { size: 10 });
    const rounded = buildCrossSection(font, 'HE', { size: 10, cornerRadius: 0.4 });
    expect(Math.abs(rounded.area() - sharp.area()) / sharp.area()).toBeLessThan(0.03);
    expect(rounded.numVert()).toBeGreaterThan(sharp.numVert());
    const o = buildCrossSection(font, 'O', { size: 10 });
    const plain = roundCorners(o, 0.4);
    expect(plain.cs.numContour()).toBe(2);
    const both = roundCorners(o, 0.4, { concaveRadius: 0.4 });
    expect(both.cs.numContour()).toBe(2);
    [sharp, rounded, o, plain.cs, both.cs].forEach((c) => c.delete());
  });

  it('never erases thin letters when rounding (radius is clamped per part)', () => {
    const parts = (cs) => {
      const p = cs.decompose();
      const n = p.length;
      p.forEach((c) => c.delete());
      return n;
    };
    const tiny = buildCrossSection(font, 'Hello', { size: 3 });
    const tinyRounded = roundCorners(tiny, 0.3);
    expect(parts(tinyRounded.cs)).toBe(parts(tiny)); // H e l l o
    expect(tinyRounded.limited).toBe(true);
    expect(tinyRounded.cs.isEmpty()).toBe(false);

    const big = buildCrossSection(font, 'Hello', { size: 10 });
    const bigRounded = roundCorners(big, 1);
    expect(parts(bigRounded.cs)).toBe(parts(big));
    expect(Math.abs(bigRounded.cs.area() - big.area()) / big.area()).toBeLessThan(0.1);

    const pacifico = loadFont('pacifico', 'pacifico-latin-400-normal.woff');
    const script = buildCrossSection(pacifico, 'Hello', { size: 12 });
    const scriptRounded = roundCorners(script, 1);
    expect(scriptRounded.cs.area()).toBeGreaterThan(0.8 * script.area());
    const small = buildCrossSection(pacifico, 'Hello', { size: 6 });
    const smallRounded = roundCorners(small, 0.4);
    expect(smallRounded.cs.isEmpty()).toBe(false);
    expect(smallRounded.limited).toBe(true);

    const info = buildCrossSectionInfo(font, 'Hello', { size: 3, cornerRadius: 0.3 });
    expect(info.rounding.limited).toBe(true);
    expect(info.rounding.requested).toBe(0.3);
    expect(buildCrossSectionInfo(font, 'Hi', { size: 10 }).rounding).toBeNull();
    [tiny, tinyRounded.cs, big, bigRounded.cs, script, scriptRounded.cs, small, smallRounded.cs, info.cs].forEach((c) => c.delete());
  });

  it('flags strokes that are too thin to print, per part', () => {
    const big = buildCrossSection(font, 'Hello', { size: 10 });
    const ok = thinStrokeReport(big, { minStroke: 0.8, minGap: 0.4 });
    expect(ok.thin).toBe(false);
    expect(ok.lostParts).toBe(0);
    expect(ok.minStroke).toBeGreaterThan(1.2);
    expect(ok.narrowGaps).toBe(false);
    expect(ok.parts).toHaveLength(5);
    ok.parts.forEach((p) => expect(p.bounds.max[0]).toBeGreaterThan(p.bounds.min[0]));

    // Inter Bold X at 4 mm has ~0.67 mm strokes: nothing vanishes, but almost no area survives
    const x = buildCrossSection(font, 'X', { size: 4 });
    expect(thinStrokeReport(x, { minStroke: 0.8 }).thin).toBe(true);

    const tiny = buildCrossSection(font, 'Hello', { size: 3 });
    const bad = thinStrokeReport(tiny, { minStroke: 0.8 });
    expect(bad.thin).toBe(true);
    expect(bad.lostParts).toBeGreaterThanOrEqual(1);

    const thinned = buildCrossSection(font, 'Hello', { size: 10, weight: -0.5 });
    expect(thinStrokeReport(thinned, { minStroke: 0.8 }).thin).toBe(true);

    const tight = buildCrossSection(font, 'Hello', { size: 10, letterSpacing: -1.2 });
    expect(thinStrokeReport(tight, { minStroke: 0.8, minGap: 1.5 }).narrowGaps).toBe(true);
    [big, x, tiny, thinned, tight].forEach((c) => c.delete());
  });

  it('printLimits scale with the nozzle and mode', () => {
    expect(printLimits({ nozzle: 0.4, mode: 'emboss' })).toEqual({ minStroke: 0.8, minGap: 0.4 });
    expect(printLimits({ nozzle: 0.4, mode: 'engrave' })).toEqual({ minStroke: 0.48, minGap: 0.8 });
    expect(printLimits({ nozzle: 0.6 }).minStroke).toBeCloseTo(1.2, 6);
  });

  it('mirrors horizontally without changing the footprint', () => {
    const a = layoutPolygons(font, 'F', { size: 10 });
    const b = layoutPolygons(font, 'F', { size: 10, mirror: true });
    expect(a.length).toBe(b.length);
    expect(b[0][0][0]).toBeCloseTo(-a[0][0][0], 6);
    expect(b[0][0][1]).toBeCloseTo(a[0][0][1], 6);
  });

  it('keeps counters (holes) in letters like O and B', () => {
    const o = buildCrossSection(font, 'O', { size: 10 });
    expect(o.decompose().length).toBe(1);
    const solid = buildTextSolid(font, 'O', { size: 10, depth: 1, overlap: 0 });
    expect(solid.genus()).toBe(1); // a ring
    o.delete();
    solid.delete();
  });

  it('returns null for blank text', () => {
    expect(buildTextSolid(font, '   \n  ', { size: 10 })).toBeNull();
    expect(buildTextSolid(font, '', { size: 10 })).toBeNull();
  });

  it('engrave mode spans from -depth to +overlap', () => {
    const solid = buildTextSolid(font, 'x', { size: 8, depth: 1.5, overlap: 0.5, mode: 'engrave' });
    const b = bounds(solid);
    expect(b.min[2]).toBeCloseTo(-1.5, 6);
    expect(b.max[2]).toBeCloseTo(0.5, 6);
    solid.delete();
  });

  it('works with other bundled fonts', () => {
    for (const [pkg, file] of [
      ['bebas-neue', 'bebas-neue-latin-400-normal.woff'],
      ['pacifico', 'pacifico-latin-400-normal.woff'],
      ['roboto-slab', 'roboto-slab-latin-700-normal.woff'],
      ['orbitron', 'orbitron-latin-700-normal.woff'],
      ['permanent-marker', 'permanent-marker-latin-400-normal.woff'],
    ]) {
      const solid = buildTextSolid(loadFont(pkg, file), 'Hello, World 123', { size: 10, depth: 2 });
      expect(solid, pkg).not.toBeNull();
      expect(solid.status(), pkg).toBe('NoError');
      expect(solid.volume(), pkg).toBeGreaterThan(0);
      solid.delete();
    }
  });
});

describe('robustness against odd fonts', () => {
  const square = (x0, y0, x1, y1) => [
    { type: 'M', x: x0, y: y0 },
    { type: 'L', x: x1, y: y0 },
    { type: 'L', x: x1, y: y1 },
    { type: 'L', x: x0, y: y1 },
    { type: 'Z' },
  ];
  // two overlapping 500x500 squares drawn the same way, as variable/script fonts do
  const stubGlyph = {
    advanceWidth: 1000,
    getBoundingBox: () => ({ y2: 700 }),
    getPath: (x, y) => ({
      commands: [...square(x, y, x + 500, y + 500), ...square(x + 250, y + 250, x + 750, y + 750)],
    }),
  };
  const stubFont = (overrides = {}) => ({
    unitsPerEm: 1000,
    tables: {},
    charToGlyph: () => stubGlyph,
    stringToGlyphs: (s) => Array.from(s).map(() => stubGlyph),
    getKerningValue: () => 0,
    ...overrides,
  });

  it('unions overlapping contours instead of double-counting them', () => {
    // cap height 700 -> scale 10/700 ; each square 500u, overlap 250u
    const s = 10 / 700;
    const expected = (500 * 500 * 2 - 250 * 250) * s * s;
    const cs = buildCrossSection(stubFont(), 'A', { size: 10 });
    expect(cs.area()).toBeCloseTo(expected, 3);
    cs.delete();
  });

  it('falls back to plain glyph mapping when the shaper throws', () => {
    const font = stubFont({
      stringToGlyphs: () => {
        throw new Error('substFormat: 2 is not yet supported');
      },
    });
    const cs = buildCrossSection(font, 'AB', { size: 10 });
    expect(cs).not.toBeNull();
    cs.delete();
  });

  it('survives a throwing kerning table', () => {
    const font = stubFont({
      getKerningValue: () => {
        throw new Error('bad GPOS');
      },
    });
    const cs = buildCrossSection(font, 'AB', { size: 10 });
    expect(cs).not.toBeNull();
    cs.delete();
  });
});
