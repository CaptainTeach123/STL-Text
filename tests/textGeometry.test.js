import { beforeAll, describe, expect, it } from 'vitest';
import {
  arcBend,
  bendCrossSection,
  curveText,
  buildCrossSection,
  buildTextSolid,
  capHeightUnits,
  fontLabel,
  layoutPolygons,
  buildCrossSectionInfo,
  buildLinesCrossSection,
  layoutLines,
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

describe('stacked lines with different fonts and sizes', () => {
  const bounds = (cs) => {
    const { min, max } = cs.bounds();
    return { w: max[0] - min[0], h: max[1] - min[1], min, max };
  };

  it('lays out each line in its own font and size, centred as one block', () => {
    const pacifico = loadFont('pacifico', 'pacifico-latin-400-normal.woff');
    const cs = buildLinesCrossSection([
      { font, text: 'TITLE', size: 14 },
      { font: pacifico, text: 'name', size: 6 },
    ]);
    expect(cs).not.toBeNull();
    const big = buildCrossSection(font, 'TITLE', { size: 14 });
    const small = buildLinesCrossSection([{ font: pacifico, text: 'name', size: 6 }]);
    const b = bounds(cs);
    expect(b.w).toBeCloseTo(Math.max(bounds(big).w, bounds(small).w), 1); // block is as wide as its widest line
    // the two lines are stacked: block taller than either line, shorter than their sum + one full pitch
    expect(b.h).toBeGreaterThan(bounds(big).h);
    expect(b.h).toBeLessThan(bounds(big).h + bounds(small).h + 1.7 * 10);
    [cs, big, small].forEach((c) => c.delete());
  });

  it('baseline pitch uses the mean of the two sizes', () => {
    // two "H"s: cap heights 14 and 6; the second baseline is lineSpacing * (14 + 6) / 2 below the first
    const polys = layoutLines([{ font, text: 'H', size: 14 }, { font, text: 'H', size: 6 }], { lineSpacing: 2 });
    const tops = polys.map((p) => Math.max(...p.map(([, y]) => y)));
    const bottoms = polys.map((p) => Math.min(...p.map(([, y]) => y)));
    expect(Math.max(...tops)).toBeCloseTo(14, 1); // first H from y=0 to 14
    expect(Math.min(...bottoms)).toBeCloseTo(-20, 1); // second baseline at -2*(14+6)/2 = -20
  });

  it('an empty line keeps its space, and a zero size line is skipped', () => {
    const three = layoutLines([{ font, text: 'A', size: 10 }, { font, text: '', size: 10 }, { font, text: 'B', size: 10 }]);
    const two = layoutLines([{ font, text: 'A', size: 10 }, { font, text: 'B', size: 10 }]);
    const span = (polys) => Math.max(...polys.flat().map(([, y]) => y)) - Math.min(...polys.flat().map(([, y]) => y));
    expect(span(three)).toBeCloseTo(span(two) + 17, 0);
    expect(layoutLines([{ font, text: 'A', size: 0 }])).toEqual([]);
  });

  it('a small line next to a huge one keeps its detail', () => {
    const pacifico = loadFont('pacifico', 'pacifico-latin-400-normal.woff');
    const alone = buildLinesCrossSection([{ font: pacifico, text: 'name', size: 3 }], { quality: 'fine' });
    const beside = buildLinesCrossSection([{ font, text: 'TITLE', size: 200 }, { font: pacifico, text: 'name', size: 3 }], { quality: 'fine' });
    const title = buildCrossSection(font, 'TITLE', { size: 200, quality: 'fine' });
    const smallArea = beside.area() - title.area();
    expect(Math.abs(smallArea - alone.area()) / alone.area()).toBeLessThan(0.01);
    [alone, beside, title].forEach((c) => c.delete());
  });

  it('one-font shorthand still matches the old behaviour', () => {
    const viaText = buildCrossSection(font, 'Hello\nWorld', { size: 10 });
    const viaLines = buildLinesCrossSection([{ font, text: 'Hello', size: 10 }, { font, text: 'World', size: 10 }]);
    expect(viaLines.area()).toBeCloseTo(viaText.area(), 6);
    const a = bounds(viaText);
    const b = bounds(viaLines);
    expect(b.w).toBeCloseTo(a.w, 6);
    expect(b.h).toBeCloseTo(a.h, 6);
    viaText.delete();
    viaLines.delete();
  });

  it('left and right alignment line up all lines on one edge', () => {
    const edges = (align) => {
      const polys = layoutLines([{ font, text: 'WWWW', size: 10 }, { font, text: 'i', size: 5 }], { align });
      const line2 = polys.filter((p) => p.every(([, y]) => y < 0));
      const line1 = polys.filter((p) => p.some(([, y]) => y >= 0));
      const xs = (ps) => ps.flat().map(([x]) => x);
      return { min1: Math.min(...xs(line1)), max1: Math.max(...xs(line1)), min2: Math.min(...xs(line2)), max2: Math.max(...xs(line2)) };
    };
    const l = edges('left');
    expect(Math.abs(l.min2 - l.min1)).toBeLessThan(1.5);
    const r = edges('right');
    expect(Math.abs(r.max2 - r.max1)).toBeLessThan(1.5);
  });
});

describe('curved text', () => {
  const oneLine = (width, half) => ({ lines: [{ middle: 0, left: -width / 2, right: width / 2 }], bottom: -half, top: half });
  // the angle of a point round the bend's centre, for a bend centred again by `shift`
  const angleRound = (bend, shift, s, [x, y]) => Math.atan2(x - shift[0], s * (y - shift[1]) + bend.radius);

  it('arches with a positive curve and curves the other way with a negative one, the middle line keeping its length', () => {
    for (const degrees of [60, -60, 180, -180]) {
      const bend = arcBend(degrees, oneLine(100, 5));
      expect(bend.limited).toBe(false);
      expect(bend.degrees).toBeCloseTo(degrees, 6);
      expect(bend.map(0, 0)).toEqual([0, 0]);
      const [, yEnd] = bend.map(50, 0);
      if (degrees > 0) expect(yEnd).toBeLessThan(-1); // the ends lower: ∩
      else expect(yEnd).toBeGreaterThan(1); // the ends higher: ∪
      // the middle line, walked in small steps, is as long on the arc as it was straight
      let length = 0;
      let prev = bend.map(-50, 0);
      for (let x = -49; x <= 50; x++) {
        const next = bend.map(x, 0);
        length += Math.hypot(next[0] - prev[0], next[1] - prev[1]);
        prev = next;
      }
      expect(length).toBeCloseTo(100, 1);
      expect(bend.radius).toBeCloseTo(100 / ((Math.abs(degrees) * Math.PI) / 180), 6);
    }
    expect(arcBend(0, oneLine(100, 5))).toBeNull();
  });

  it('never folds the inside of the bend, and never lets the ends meet, and says which', () => {
    // 20 mm of text 10 mm tall cannot go 300° round: its inside would pass the centre
    const short = arcBend(300, oneLine(20, 5));
    expect(short.limited).toBe('fold');
    expect(short.radius).toBeGreaterThanOrEqual(1.25 * 5 - 1e-9);
    // long text may go most of the way round, but not all of it
    const long = arcBend(400, oneLine(300, 5));
    expect(long.limited).toBe('ends');
    expect(Math.abs(long.degrees)).toBeCloseTo(330, 6);
    // a plate wider than the text (its tails) limits the text so the plate's ends do not meet either
    const plated = arcBend(330, { ...oneLine(100, 5), plate: { left: -75, right: 75 } });
    expect(plated.limited).toBe('ends');
    expect(Math.abs(plated.degrees)).toBeCloseTo(220, 6);
    expect(plated.mapPlate(-75, 0)[0]).toBeCloseTo(-plated.mapPlate(75, 0)[0], 6);
  });

  it('bends stacked lines round one centre, each keeping its own size along its own arc, the widest by the angle asked', () => {
    const lines = [
      { font, text: 'HELLO', size: 10 },
      { font, text: 'WIDE WORLD', size: 10 },
    ];
    const info = buildCrossSectionInfo(lines, { lineSpacing: 1.7, perLine: true });
    expect(info.lines).toHaveLength(2);
    const [top, bottom] = info.lines.map((l) => l.middle);
    expect(top - bottom).toBeCloseTo(17, 6); // 1.7 × 10 mm apart
    for (const degrees of [120, -120]) {
      const { cs, bend, shift } = curveText(info, degrees);
      const s = Math.sign(degrees);
      // the widest line (the second) reaches round exactly the angle asked
      const b = info.lines[1].cs.bounds();
      const ends = [b.min[0], b.max[0]].map((x) => bend.map(x, bottom, 1));
      const sweep = Math.atan2(ends[1][0], s * ends[1][1] + bend.radius) - Math.atan2(ends[0][0], s * ends[0][1] + bend.radius);
      expect((sweep * 180) / Math.PI).toBeCloseTo(Math.abs(degrees), 4);
      expect(bend.degrees).toBeCloseTo(degrees, 6);
      // each line's middle, walked along its own arc, keeps the length it had straight
      [top, bottom].forEach((middle, i) => {
        let length = 0;
        let prev = bend.map(-20, middle, i);
        for (let x = -19.5; x <= 20; x += 0.5) {
          const next = bend.map(x, middle, i);
          length += Math.hypot(next[0] - prev[0], next[1] - prev[1]);
          prev = next;
        }
        expect(length).toBeCloseTo(40, 1);
        // on a circle round the shared centre
        const d = (x) => Math.hypot(bend.map(x, middle, i)[0], bend.map(x, middle, i)[1] + s * bend.radius);
        expect(d(-15)).toBeCloseTo(d(15), 6);
        expect(d(0)).toBeCloseTo(bend.lineRadius(i), 6);
      });
      expect(Math.abs(angleRound(bend, shift, s, [shift[0], shift[1]]))).toBeLessThan(1e-9);
      cs.delete();
    }
    info.cs.delete();
    for (const l of info.lines) l.cs.delete();
  });

  it('keeps left- and right-aligned lines aligned along the arc', () => {
    const lines = [
      { font, text: 'BEST', size: 10 },
      { font, text: 'GRANDPA EVER', size: 10 },
    ];
    for (const align of ['left', 'right']) {
      const info = buildCrossSectionInfo(lines, { align, perLine: true });
      for (const degrees of [120, -120]) {
        const { cs, bend } = curveText(info, degrees);
        const s = Math.sign(degrees);
        const at = (x, i) => {
          const [px, py] = bend.map(x, info.lines[i].middle, i);
          return (Math.atan2(px, s * py + bend.radius) * 180) / Math.PI;
        };
        const edge = (i) => {
          const b = info.lines[i].cs.bounds();
          return align === 'left' ? b.min[0] : b.max[0];
        };
        // the lines' starts (or ends) on one radius, as far as the letters' side bearings allow
        expect(Math.abs(at(edge(0), 0) - at(edge(1), 1))).toBeLessThan(2);
        cs.delete();
      }
      info.cs.delete();
      for (const l of info.lines) l.cs.delete();
    }
  });

  it('keeps every counter, dot and accent with its own letter when a small line sits over a big one', () => {
    const lines = [
      { font, text: 'hi', size: 5 },
      { font, text: 'Mini Jiji ÉÖ obo', size: 20 },
    ];
    const info = buildCrossSectionInfo(lines, { perLine: true });
    const holes = (cs) => cs.toPolygons().filter((p) => {
      let a = 0;
      for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
      return a < 0;
    }).length;
    const flatHoles = holes(info.cs);
    // each piece's area and centroid
    const pieces = (cs) =>
      cs.decompose().map((p) => {
        let a = 0, cx = 0, cy = 0;
        for (const poly of p.toPolygons()) {
          for (let i = 0; i < poly.length; i++) {
            const [x0, y0] = poly[i];
            const [x1, y1] = poly[(i + 1) % poly.length];
            const c = x0 * y1 - x1 * y0;
            a += c;
            cx += (x0 + x1) * c;
            cy += (y0 + y1) * c;
          }
        }
        p.delete();
        return { area: a / 2, c: [cx / (3 * a), cy / (3 * a)] };
      });
    // the marks (pieces under 20 mm²) in order along the line, each as an offset from the nearest letter body
    const offsets = (list) => {
      const big = list.filter((p) => p.area > 20);
      return list
        .filter((p) => p.area <= 20)
        .sort((a, b) => a.x - b.x)
        .map((m) => big.map((b) => m.x - b.x).reduce((best, d) => (Math.abs(d) < Math.abs(best) ? d : best), Infinity));
    };
    const flatOffsets = offsets(pieces(info.lines[1].cs).map((p) => ({ area: p.area, x: p.c[0] })));
    expect(flatOffsets.length).toBeGreaterThanOrEqual(6);
    for (const degrees of [90, -90, 180]) {
      const { cs, bend, shift } = curveText(info, degrees);
      const s = Math.sign(degrees);
      // no counter filled in or cut elsewhere
      expect(holes(cs)).toBe(flatHoles);
      // the big line's marks (dots, accents) keep their offset along the line from the nearest letter body: the same
      // distance round the arc as they had straight
      const bent = pieces(cs).map((p) => ({ ...p, at: angleRound(bend, shift, s, p.c) * bend.lineRadius(1), r: Math.hypot(p.c[0] - shift[0], p.c[1] - shift[1] + s * bend.radius) }));
      // (the small line's letters are left out: those in its span, past the big line's dots)
      const b0 = info.lines[0].cs.bounds();
      const span = [b0.min[0], b0.max[0]].map((x) => {
        const [px, py] = bend.map(x, info.lines[0].middle, 0);
        return Math.atan2(px, s * py + bend.radius) * bend.lineRadius(1);
      });
      const ofLine = bent.filter((p) => !(Math.abs(p.r - bend.lineRadius(1)) > 10 && p.at > Math.min(...span) - 1 && p.at < Math.max(...span) + 1));
      const bentOffsets = offsets(ofLine.map((p) => ({ area: p.area, x: p.at })));
      expect(bentOffsets).toHaveLength(flatOffsets.length);
      bentOffsets.forEach((o, i) => expect(Math.abs(o - flatOffsets[i])).toBeLessThan(0.3));
      cs.delete();
    }
    info.cs.delete();
    for (const l of info.lines) l.cs.delete();
  });

  it('bends the outlines of real text into a sound arc of the same area', () => {
    const info = buildCrossSectionInfo([{ font, text: 'Candy Cane Lane', size: 10 }], { perLine: true });
    const [w, h] = size(info.cs);
    const { cs: bent } = curveText(info, 90);
    expect(bent.isEmpty()).toBe(false);
    // the letters keep their size along the arc: the area changes only by the bend's stretch above and below the middle
    expect(Math.abs(bent.area() / info.cs.area() - 1)).toBeLessThan(0.03);
    const [bw, bh] = size(bent);
    expect(bw).toBeLessThan(w); // an arch spans less than the straight text ...
    expect(bh).toBeGreaterThan(h + 5); // ... and rises in the middle
    // and it is the same shape as a straight bend of the same outline
    const bend = arcBend(90, { lines: [{ middle: info.lines[0].middle, left: -w / 2, right: w / 2 }], bottom: -h / 2, top: h / 2 });
    const plain = bendCrossSection(info.cs, (x, y) => bend.map(x, y), 0.3);
    expect(Math.abs(plain.area() - bent.area()) / bent.area()).toBeLessThan(0.01);
    plain.delete();
    bent.delete();
    info.cs.delete();
    for (const l of info.lines) l.cs.delete();
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
