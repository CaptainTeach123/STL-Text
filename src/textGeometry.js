import { manifold } from './manifold.js';

/**
 * Turns a string + an opentype.js font into a solid (Manifold) that lies in
 * the XY plane, centred on the origin, extruded along Z.
 *
 *  - "size" is the height of a capital letter in model units (mm for most STLs)
 *  - glyph outlines are flattened to polygons, unioned with the non-zero fill
 *    rule (so overlapping contours in script / variable fonts behave), then
 *    optionally offset ("weight") and extruded.
 */

export const QUALITY = {
  draft: 0.05,
  normal: 0.02,
  fine: 0.005,
};

export const DEFAULT_TEXT_OPTIONS = {
  size: 10,
  letterSpacing: 0, // extra space between letters, in model units
  lineSpacing: 1.7, // line pitch as a multiple of the cap height
  align: 'center', // 'left' | 'center' | 'right'
  weight: 0, // outline offset in model units (+ bolder, - thinner)
  mirror: false,
  quality: 'normal',
};

/** Human readable name of a parsed font. */
export function fontLabel(font, fallback = 'Custom font') {
  const names = font?.names;
  if (!names) return fallback;
  const pick = (table, key) => {
    const entry = table?.[key];
    if (!entry) return undefined;
    return entry.en ?? Object.values(entry)[0];
  };
  const find = (key) =>
    pick(names, key) ?? pick(names.windows, key) ?? pick(names.macintosh, key) ?? pick(names.unicode, key);
  const family = find('fontFamily');
  const sub = find('fontSubfamily');
  if (!family) return fallback;
  return sub && !/^regular$/i.test(sub) ? `${family} ${sub}` : family;
}

/** Height of a capital letter in font units. */
export function capHeightUnits(font) {
  try {
    const box = font.charToGlyph('H').getBoundingBox();
    if (box && box.y2 > 0) return box.y2;
  } catch {
    /* fall through */
  }
  const os2 = font.tables?.os2?.sCapHeight;
  if (os2 > 0) return os2;
  return font.unitsPerEm * 0.7;
}

function glyphsFor(font, line) {
  try {
    return font.stringToGlyphs(line);
  } catch {
    // opentype.js' shaper rejects some GSUB lookups; plain mapping always works.
    return Array.from(line).map((ch) => font.charToGlyph(ch));
  }
}

function kerning(font, left, right) {
  try {
    const k = font.getKerningValue(left, right);
    return Number.isFinite(k) ? k : 0;
  } catch {
    return 0;
  }
}

/** Flatten a quadratic / cubic Bézier into `out`, within `tol` of the true curve. */
function flatten(out, pts, tol) {
  const [p0, ...rest] = pts;
  let n;
  if (rest.length === 2) {
    const [p1, p2] = rest;
    const dx = p0[0] - 2 * p1[0] + p2[0];
    const dy = p0[1] - 2 * p1[1] + p2[1];
    n = Math.ceil(Math.sqrt(Math.hypot(dx, dy) / (4 * tol)));
  } else {
    const [p1, p2, p3] = rest;
    const d1 = Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]);
    const d2 = Math.hypot(p1[0] - 2 * p2[0] + p3[0], p1[1] - 2 * p2[1] + p3[1]);
    n = Math.ceil(Math.sqrt((0.75 * Math.max(d1, d2)) / tol));
  }
  n = Math.min(64, Math.max(2, n || 2));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    if (rest.length === 2) {
      const [p1, p2] = rest;
      out.push([
        u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
        u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
      ]);
    } else {
      const [p1, p2, p3] = rest;
      out.push([
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
      ]);
    }
  }
}

/**
 * Lay out `text` and return closed polygons (arrays of [x, y], Y up) in model
 * units. Origin is the left end of the first baseline; the caller centres it.
 */
export function layoutPolygons(font, text, options = {}) {
  const o = { ...DEFAULT_TEXT_OPTIONS, ...options };
  const tol = QUALITY[o.quality] ?? QUALITY.normal;
  const upem = font.unitsPerEm || 1000;
  const cap = capHeightUnits(font);
  const scale = o.size / cap; // font units -> model units
  const spacingUnits = o.letterSpacing / scale;
  const pitchUnits = o.lineSpacing * cap;

  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const laid = lines.map((line) => {
    const glyphs = glyphsFor(font, line);
    const xs = [];
    let pen = 0;
    glyphs.forEach((g, i) => {
      xs.push(pen);
      pen += g.advanceWidth ?? 0;
      if (i < glyphs.length - 1) pen += kerning(font, g, glyphs[i + 1]) + spacingUnits;
    });
    return { glyphs, xs, width: pen };
  });

  const polygons = [];
  laid.forEach((line, li) => {
    const shift =
      o.align === 'left' ? 0 : o.align === 'right' ? -line.width : -line.width / 2;
    const baseline = -li * pitchUnits;
    line.glyphs.forEach((glyph, gi) => {
      const path = glyph.getPath(line.xs[gi] + shift, 0, upem, undefined, font);
      let contour = null;
      let last = null;
      const toModel = (x, y) => [(o.mirror ? -x : x) * scale, (baseline - y) * scale];
      const close = () => {
        if (contour && contour.length >= 3) polygons.push(contour);
        contour = null;
      };
      for (const c of path.commands) {
        if (c.type === 'M') {
          close();
          last = toModel(c.x, c.y);
          contour = [last];
        } else if (c.type === 'L') {
          if (!contour) contour = [last];
          last = toModel(c.x, c.y);
          contour.push(last);
        } else if (c.type === 'Q') {
          if (!contour) contour = [last];
          const p1 = toModel(c.x1, c.y1);
          const p2 = toModel(c.x, c.y);
          flatten(contour, [last, p1, p2], tol);
          last = p2;
        } else if (c.type === 'C') {
          if (!contour) contour = [last];
          const p1 = toModel(c.x1, c.y1);
          const p2 = toModel(c.x2, c.y2);
          const p3 = toModel(c.x, c.y);
          flatten(contour, [last, p1, p2, p3], tol);
          last = p3;
        } else if (c.type === 'Z') {
          close();
        }
      }
      close();
    });
  });
  return polygons;
}

/**
 * Build the 2D shape of the text as a Manifold CrossSection centred on the
 * origin. Returns null when the text has no visible outline.
 * The caller owns (and must `.delete()`) the result.
 */
export function buildCrossSection(font, text, options = {}) {
  const { CrossSection } = manifold();
  const o = { ...DEFAULT_TEXT_OPTIONS, ...options };
  const polygons = layoutPolygons(font, text, o);
  if (!polygons.length) return null;

  let cs = CrossSection.ofPolygons(polygons, 'NonZero');
  const step = (next) => {
    cs.delete();
    cs = next;
  };
  if (o.weight) step(cs.offset(o.weight, 'Miter', 3, 16));
  step(cs.simplify(Math.max(0.001, o.size * 0.0005)));
  if (cs.isEmpty()) {
    cs.delete();
    return null;
  }
  const { min, max } = cs.bounds();
  step(cs.translate(-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2));
  return cs;
}

/** z-range of the text solid relative to the surface it sits on. */
export function textZRange({ mode = 'emboss', depth = 1, overlap = 0.4 }) {
  return mode === 'engrave' ? [-depth, overlap] : [-overlap, depth];
}

/**
 * Build the extruded text solid (a Manifold) for the given settings.
 * Local frame: text lies in XY, "up" out of the surface is +Z, origin at the
 * centre of the text on the surface. The caller must `.delete()` the result.
 */
export function buildTextSolid(font, text, options = {}) {
  const { Manifold } = manifold();
  const cs = buildCrossSection(font, text, options);
  if (!cs) return null;
  try {
    const [z0, z1] = textZRange(options);
    if (!(z1 - z0 > 0)) return null;
    const solid = Manifold.extrude(cs, z1 - z0);
    const moved = solid.translate(0, 0, z0);
    solid.delete();
    return moved;
  } finally {
    cs.delete();
  }
}
