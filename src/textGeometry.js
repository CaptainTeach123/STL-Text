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
  size: 10, // one-font shorthand only; lines carry their own sizes
  letterSpacing: 0, // extra space between letters, in model units
  lineSpacing: 1.7, // line pitch as a multiple of the cap height
  align: 'center', // 'left' | 'center' | 'right'
  weight: 0, // outline offset in model units (+ bolder, - thinner)
  cornerRadius: 0, // round convex (outer) corners by this radius (model units)
  concaveRadius: 0, // round concave (inner) corners too, by this radius (0 = leave them sharp)
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
/**
 * Lay out stacked lines – each `{ font, text, size }` with its own font and
 * cap height (model units) – and return closed polygons (arrays of [x, y],
 * Y up). The first baseline is at y = 0 and the first line starts at x = 0
 * (or is centred / right-aligned around x = 0); the caller centres the block.
 * The distance between two baselines is lineSpacing × the mean of the two
 * lines' sizes, so a small line under a big one sits where you'd expect.
 */
/** The baseline of each stacked line (mm, the first line's at 0, the others below it). */
export function lineBaselines(lines, options = {}) {
  const spacing = options.lineSpacing ?? DEFAULT_TEXT_OPTIONS.lineSpacing;
  const baselines = [];
  let baseline = 0;
  lines.forEach((line, i) => {
    baselines.push(baseline);
    if (i < lines.length - 1) baseline -= spacing * ((line.size || 0) + (lines[i + 1].size || 0)) / 2;
  });
  return baselines;
}

export function layoutLines(lines, options = {}) {
  return layoutLineGroups(lines, options).flat();
}

/** The polygons of layoutLines, one array per line (empty for a blank line). */
function layoutLineGroups(lines, options = {}) {
  const o = { ...DEFAULT_TEXT_OPTIONS, ...options };
  const tol = QUALITY[o.quality] ?? QUALITY.normal;

  const laid = lines.map(({ font, text, size }) => {
    const upem = font.unitsPerEm || 1000;
    const cap = capHeightUnits(font);
    const scale = (size || 0) / cap; // font units -> model units
    const spacingUnits = scale > 0 ? o.letterSpacing / scale : 0;
    const glyphs = glyphsFor(font, String(text ?? '').replace(/\r?\n/g, ' '));
    const xs = [];
    let pen = 0;
    glyphs.forEach((g, i) => {
      xs.push(pen);
      pen += g.advanceWidth ?? 0;
      if (i < glyphs.length - 1) pen += kerning(font, g, glyphs[i + 1]) + spacingUnits;
    });
    return { font, upem, scale, glyphs, xs, widthUnits: pen };
  });

  const baselines = lineBaselines(lines, o);

  return laid.map((line, li) => {
    const polygons = [];
    if (!(line.scale > 0)) return polygons;
    const shiftUnits = o.align === 'left' ? 0 : o.align === 'right' ? -line.widthUnits : -line.widthUnits / 2;
    const y0 = baselines[li];
    const toModel = (x, y) => [(o.mirror ? -x : x) * line.scale, y0 - y * line.scale];
    line.glyphs.forEach((glyph, gi) => {
      const path = glyph.getPath(line.xs[gi] + shiftUnits, 0, line.upem, undefined, line.font);
      let contour = null;
      let last = null;
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
    return polygons;
  });
}

/** One font, one size: `text` split on newlines into equal lines (see layoutLines). */
export function layoutPolygons(font, text, options = {}) {
  const o = { ...DEFAULT_TEXT_OPTIONS, ...options };
  const size = options.size ?? 10;
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').map((t) => ({ font, text: t, size }));
  return layoutLines(lines, o);
}

/**
 * Build the 2D shape of the text as a Manifold CrossSection centred on the
 * origin, and report what happened on the way:
 *   cs        the shape (the caller owns it and must `.delete()` it), or null
 *             when the text has no visible outline
 *   rounding  { requested, applied, limited } when `cornerRadius > 0`, else
 *             null; `limited` means thin strokes forced a smaller radius (or
 *             left a part unrounded), `applied` is the smallest radius used
 *   polygons  number of glyph contours laid out
 */
export function buildCrossSectionInfo(linesOrFont, textOrOptions, maybeOptions) {
  const { CrossSection } = manifold();
  // accept lines [{ font, text, size }] or the one-font shorthand (font, text, options)
  const legacy = !Array.isArray(linesOrFont);
  const options = legacy ? maybeOptions ?? {} : textOrOptions ?? {};
  const lines = legacy
    ? String(textOrOptions).replace(/\r\n?/g, '\n').split('\n').map((t) => ({ font: linesOrFont, text: t, size: options.size ?? 10 }))
    : linesOrFont;
  const sizes = lines.map((l) => l.size || 0).filter((v) => v > 0);
  const o = { ...DEFAULT_TEXT_OPTIONS, ...options, size: Math.max(0, ...sizes) };
  // simplification must respect the smallest letters, not the biggest line
  const smallest = sizes.length ? Math.min(...sizes) : o.size;
  const groups = layoutLineGroups(lines, o);
  const polygons = groups.flat();
  const info = { cs: null, rounding: null, polygons: polygons.length };
  if (!polygons.length) return info;

  // the outline of some polygons: emboldened, rounded and simplified as asked
  const outlineOf = (contours) => {
    let cs = CrossSection.ofPolygons(contours, 'NonZero');
    const step = (next) => {
      cs.delete();
      cs = next;
    };
    let rounding = null;
    if (o.weight) step(cs.offset(o.weight, 'Miter', 3, 16));
    if (o.cornerRadius > 0) {
      const rounded = roundCorners(cs, o.cornerRadius, {
        concaveRadius: o.concaveRadius ?? 0,
        quality: QUALITY[o.quality] ?? QUALITY.normal,
      });
      step(rounded.cs);
      rounding = { requested: o.cornerRadius, applied: rounded.appliedRadius, limited: rounded.limited };
    }
    step(cs.simplify(Math.max(0.001, smallest * 0.0005)));
    return { cs, rounding };
  };

  let cs;
  let parts = null; // with perLine: each line's own outline, so a curve can bend every line round its own arc
  if (o.perLine) {
    parts = [];
    groups.forEach((group, i) => {
      if (!group.length) return;
      const out = outlineOf(group);
      if (out.cs.isEmpty()) return void out.cs.delete();
      parts.push({ cs: out.cs, line: i });
      if (out.rounding) {
        const r = info.rounding;
        info.rounding = r ? { ...r, applied: Math.min(r.applied, out.rounding.applied), limited: r.limited || out.rounding.limited } : out.rounding;
      }
    });
    if (!parts.length) return info;
    cs = parts.length === 1 ? parts[0].cs.translate(0, 0) : CrossSection.union(parts.map((p) => p.cs));
  } else {
    const out = outlineOf(polygons);
    cs = out.cs;
    info.rounding = out.rounding;
  }
  if (cs.isEmpty()) {
    cs.delete();
    return info;
  }
  const { min, max } = cs.bounds();
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  info.cs = cs.translate(-cx, -cy);
  cs.delete();
  if (parts) {
    // in the centred frame: each line's outline and the middle of its capitals; `anchor` is where every line was
    // aligned (the start of a left-aligned line, the end of a right-aligned one, the middle of a centred one)
    const baselines = lineBaselines(lines, o);
    info.lines = parts.map(({ cs: part, line }) => {
      const moved = part.translate(-cx, -cy);
      part.delete();
      return { cs: moved, middle: baselines[line] + (lines[line].size || 0) / 2 - cy };
    });
    info.anchor = -cx;
  }
  return info;
}

/** The most a line of text can be curved: short of a full circle, so its two ends never meet. */
export const MAX_CURVE = 330;

/** The inside of a bend stays at least this fraction of the bend's radius from its centre, so it never folds. */
const FOLD = 0.2;

/**
 * Bending text into an arc. `degrees` is how far round a circle the widest line reaches: positive arches it (∩, the
 * ends lower than the middle), negative curves it the other way (∪, the ends higher). Every line bends round the same
 * centre, each keeping its own size along its own arc (the middle of its capitals keeps its length), so stacked lines
 * sit on concentric arcs as on a badge; letters stand square on their arc, tops outward on an arch and inward on a ∪.
 * Lines keep their alignment: centred lines are centred on the same radius, left-aligned ones start on the same
 * radius and right-aligned ones end on it.
 *
 * The shape is described in its own (centred) frame: `lines` [{ middle, left, right }] gives each line's middle and
 * how far it reaches across, `anchor` where the lines were aligned (the same x for every line), `bottom` and `top` how
 * far the whole shape reaches (a plate included), `plate` { left, right } the plate the text sits on, if any.
 *
 * The curve is limited so the inside of the bend never folds (`limited` 'fold') and the shape's two ends never meet
 * (`limited` 'ends': it reaches at most MAX_CURVE round). `degrees` is the widest line's sweep as built. map(x, y, i)
 * bends a point of line i; mapPlate(x, y) a point of the plate, bent as one piece that holds every line. Returns null
 * for no curve.
 * @returns {{ degrees: number, requested: number, limited: false | 'fold' | 'ends', radius: number, plateRadius: number,
 *   lineRadius(i: number): number, map(x: number, y: number, i?: number): number[], mapPlate(x: number, y: number): number[] } | null}
 */
export function arcBend(degrees, { lines, anchor = 0, bottom, top, plate = null }) {
  const requested = Number(degrees) || 0;
  if (!requested || !lines?.length) return null;
  const s = requested > 0 ? 1 : -1; // the radius of a point at y is R + s·y
  let w = 0;
  lines.forEach((l, i) => {
    if (l.right - l.left > lines[w].right - lines[w].left) w = i;
  });
  const width = lines[w].right - lines[w].left;
  if (!(width > 0)) return null;
  const left = Math.min(...lines.map((l) => l.left));
  const right = Math.max(...lines.map((l) => l.right));
  // the angle of x on line i, for a radius R at y = 0: every line's anchor at the widest line's angle for it
  const angle = (R, x, i) => anchor / (R + s * lines[w].middle) + (x - anchor) / (R + s * lines[i].middle);
  // how far round the text reaches, and the plate (stretched evenly so it holds every line)
  const reach = (R) => {
    let lo = Infinity;
    let hi = -Infinity;
    lines.forEach((l, i) => {
      lo = Math.min(lo, angle(R, l.left, i));
      hi = Math.max(hi, angle(R, l.right, i));
    });
    const k = (hi - lo) / Math.max(1e-9, right - left);
    if (plate) return { lo, hi, k, from: lo + (plate.left - left) * k, to: lo + (plate.right - left) * k };
    return { lo, hi, k, from: lo, to: hi };
  };
  const most = (MAX_CURVE * Math.PI) / 180;
  const asked = width / ((Math.abs(requested) * Math.PI) / 180) - s * lines[w].middle;
  // the inside edge of the shape (its bottom on an arch, its top on a ∪) stays clear of the centre
  const inside = Math.max(0, s > 0 ? -bottom : top, ...lines.map((l) => -s * l.middle));
  const fold = inside / (1 - FOLD);
  // the smallest radius at which the ends do not meet (the reach shrinks as the radius grows)
  const meets = (R) => {
    const r = reach(R);
    return r.to - r.from > most;
  };
  let ends = Math.max(asked, fold, 1e-6);
  if (meets(ends)) {
    let lo = ends;
    let hi = ends * 2;
    while (meets(hi)) (lo = hi), (hi *= 2);
    for (let it = 0; it < 60; it++) {
      const mid = (lo + hi) / 2;
      if (meets(mid)) lo = mid;
      else hi = mid;
    }
    ends = hi;
  }
  const radius = Math.max(asked, fold, ends);
  const limited = radius > asked * (1 + 1e-9) + 1e-12 ? (ends > Math.max(asked, fold) * (1 + 1e-9) ? 'ends' : 'fold') : false;
  const lineRadius = (i) => radius + s * lines[i].middle;
  const r = reach(radius);
  const point = (t, y) => {
    const rr = radius + s * y;
    return [rr * Math.sin(t), s * (rr * Math.cos(t) - radius) + 0]; // + 0: no -0 at the centre
  };
  return {
    degrees: (Math.sign(requested) * (width / lineRadius(w)) * 180) / Math.PI,
    requested,
    limited,
    radius,
    plateRadius: 1 / Math.max(1e-12, r.k),
    lineRadius,
    map: (x, y, i = w) => point(angle(radius, x, i), y),
    mapPlate: (x, y) => point(r.lo + (x - left) * r.k, y),
  };
}

/**
 * A cross-section bent by `map` (a point's bent position): its outlines are split into edges no longer than `maxEdge`
 * so straight strokes follow the curve, then mapped. The caller owns the result.
 */
export function bendCrossSection(cs, map, maxEdge = 0.5) {
  const { CrossSection } = manifold();
  const polygons = cs.toPolygons().map((poly) => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % poly.length];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / maxEdge));
      for (let k = 0; k < n; k++) out.push(map(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n));
    }
    return out;
  });
  return CrossSection.ofPolygons(polygons, 'Positive');
}

/**
 * The longest straight edge that, laid on a bend that turns `turn` radians per mm of it at up to `outer` mm from the
 * centre, strays less than about 0.01 mm from the arc (between 0.1 and 2 mm).
 */
const bendEdge = (turn, outer) => Math.min(2, Math.max(0.1, Math.sqrt(0.08 / Math.max(1e-9, outer * turn * turn))));

/**
 * Text built with `perLine` (buildCrossSectionInfo) curved `degrees` round an arc (see arcBend), every line round its
 * own arc so a letter's counters, dots and accents stay with it, and the plate outline (centred like the text) bent
 * with it; both are centred again on the bent shape (moved by `shift`). Returns null for no curve, else
 * { cs, plate, bend, shift }: the caller owns cs and plate.
 */
export function curveText(info, degrees, { plate = null } = {}) {
  const { CrossSection } = manifold();
  const parts = info.lines ?? [];
  if (!degrees || !parts.length) return null;
  const tb = info.cs.bounds();
  const pb = plate ? plate.bounds() : null;
  const lines = parts.map((l) => {
    const b = l.cs.bounds();
    return { middle: l.middle, left: b.min[0], right: b.max[0], bottom: b.min[1], top: b.max[1] };
  });
  const bend = arcBend(degrees, {
    lines,
    anchor: info.anchor ?? 0,
    bottom: Math.min(tb.min[1], pb ? pb.min[1] : Infinity),
    top: Math.max(tb.max[1], pb ? pb.max[1] : -Infinity),
    plate: pb ? { left: pb.min[0], right: pb.max[0] } : null,
  });
  if (!bend) return null;
  const s = degrees > 0 ? 1 : -1;
  const outerOf = (b, t) => bend.radius + Math.max(s * b, s * t);
  const bent = parts.map((l, i) => {
    const { bottom, top } = lines[i];
    // edges short enough to follow the arc, and to keep the letters' detail (a twentieth of the line's height)
    const edge = Math.min(bendEdge(1 / bend.lineRadius(i), outerOf(bottom, top)), Math.max(0.05, (top - bottom) / 20));
    return bendCrossSection(l.cs, (x, y) => bend.map(x, y, i), edge);
  });
  let cs = bent.length === 1 ? bent[0] : CrossSection.union(bent);
  if (bent.length > 1) for (const b of bent) b.delete();
  // the plate's straight edges only have to follow its own arc
  let bentPlate = plate ? bendCrossSection(plate, bend.mapPlate, bendEdge(1 / bend.plateRadius, outerOf(pb.min[1], pb.max[1]))) : null;
  const b = (bentPlate ?? cs).bounds();
  const dx = -(b.min[0] + b.max[0]) / 2;
  const dy = -(b.min[1] + b.max[1]) / 2;
  const moved = cs.translate(dx, dy);
  cs.delete();
  cs = moved;
  if (bentPlate) {
    const movedPlate = bentPlate.translate(dx, dy);
    bentPlate.delete();
    bentPlate = movedPlate;
  }
  return { cs, plate: bentPlate, bend, shift: [dx, dy] };
}

/**
 * Build the 2D shape of the text as a Manifold CrossSection centred on the
 * origin. Returns null when the text has no visible outline.
 * The caller owns (and must `.delete()`) the result.
 */
export function buildCrossSection(font, text, options = {}) {
  return buildCrossSectionInfo(font, text, options).cs;
}

/** Cross-section of stacked lines [{ font, text, size }] (see layoutLines). The caller owns the result. */
export function buildLinesCrossSection(lines, options = {}) {
  return buildCrossSectionInfo(lines, options).cs;
}

/** Total length of all contours of a CrossSection. */
function perimeterOf(cs) {
  let perimeter = 0;
  for (const poly of cs.toPolygons()) {
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      perimeter += Math.hypot(bx - ax, by - ay);
    }
  }
  return perimeter;
}

/**
 * 2·area / perimeter: exact for a long uniform stroke, a slight under-estimate
 * of the typical stroke width for anything with corners or counters.
 */
function strokeEstimate(cs, area = cs.area()) {
  const perimeter = perimeterOf(cs);
  return perimeter > 0 ? (2 * area) / perimeter : 0;
}

/** Connected components and holes (counters) of a shape. */
function topology(cs) {
  if (cs.isEmpty()) return { components: 0, holes: 0 };
  const parts = cs.decompose();
  const components = parts.length;
  parts.forEach((p) => p.delete());
  return { components, holes: cs.numContour() - components };
}

/**
 * Segments per full circle so that an arc of `radius` stays within `tolerance`
 * of the true circle (r·(1 − cos(π/n)) ≤ tolerance), clamped to [6, 64].
 */
function arcSegments(radius, tolerance) {
  if (!(radius > 0)) return 6;
  if (!(tolerance > 0)) return 64;
  const c = Math.max(-1, Math.min(1, 1 - tolerance / radius));
  const n = Math.ceil(Math.PI / Math.acos(c)); // acos(1) = 0 -> Infinity -> 64
  return Math.min(64, Math.max(6, Number.isFinite(n) ? n : 64));
}

/**
 * Diameter of the widest disc that fits inside `cs`, found by bisection on
 * `cs.offset(-w/2).isEmpty()`. `hi` must be a width at which the shape has
 * already vanished.
 */
function inscribedDiameter(cs, hi, iterations = 8) {
  let lo = 0;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const shrunk = cs.offset(-mid / 2, 'Miter', 2, 4);
    const empty = shrunk.isEmpty();
    shrunk.delete();
    if (empty) hi = mid;
    else lo = mid;
  }
  return lo;
}

/** Morphological opening (shrink, then grow back): rounds convex corners, erases anything thinner than 2r. */
function opening(cs, r, segments) {
  const inner = cs.offset(-r, 'Round', 2, segments);
  const out = inner.offset(r, 'Round', 2, segments);
  inner.delete();
  return out;
}

/** Morphological closing (grow, then shrink back): rounds concave corners, fills anything narrower than 2r. */
function closing(cs, r, segments) {
  const outer = cs.offset(r, 'Round', 2, segments);
  const out = outer.offset(-r, 'Round', 2, segments);
  outer.delete();
  return out;
}

// A corner radius above ~half the stroke width erases the stroke; stay clear of it.
const RADIUS_PER_STROKE = 0.45;
// A rounded part that kept less than this share of its area has lost features, not corners.
const MIN_AREA_KEPT = 0.5;

/**
 * Round one connected part with `radius` (convex) and `concaveRadius`
 * (concave). The result must keep the part's topology (one piece, same holes)
 * and at least half its area; otherwise the radius is halved, twice. Returns
 * `{ cs, radius }` or null when every attempt damaged the part.
 */
function roundPart(part, radius, concaveRadius, quality) {
  const area = part.area();
  const before = topology(part);
  let r = radius;
  for (let attempt = 0; attempt < 3 && r > 1e-6; attempt++) {
    let out = opening(part, r, arcSegments(r, quality));
    if (out.isEmpty()) {
      // 2A/P over-estimated the stroke: measure the real inscribed width instead
      out.delete();
      r = RADIUS_PER_STROKE * inscribedDiameter(part, 2 * r);
      if (!(r > 1e-6)) break;
      out = opening(part, r, arcSegments(r, quality));
    }
    const r2 = Math.min(concaveRadius, r);
    if (r2 > 0 && !out.isEmpty()) {
      const closed = closing(out, r2, arcSegments(r2, quality));
      out.delete();
      out = closed;
    }
    const after = topology(out);
    const intact =
      !out.isEmpty() &&
      out.area() >= MIN_AREA_KEPT * area &&
      after.components === before.components &&
      after.holes === before.holes;
    if (intact) return { cs: out, radius: r };
    out.delete();
    r /= 2;
  }
  return null;
}

/**
 * Round the sharp corners of a shape. Convex corners are rounded by `radius`
 * (a morphological opening); concave corners only when `concaveRadius > 0`
 * (a closing by min(concaveRadius, radius), applied after the opening).
 *
 * Each connected part is rounded on its own with a radius clamped to 0.45× its
 * estimated stroke width, so thin letters are never erased; a part that would
 * still vanish, fragment, lose a counter or more than half its area is kept
 * unrounded. `quality` is the chord tolerance that sets the arc segment count.
 *
 * Returns { cs, appliedRadius, limited, restoredParts }:
 *   cs             the rounded shape (new; the input is left for the caller)
 *   appliedRadius  smallest radius actually applied to a part (0 if none was)
 *   limited        true when any part got less than the requested radius
 *   restoredParts  parts that were kept unrounded
 */
export function roundCorners(cs, radius, { concaveRadius = 0, quality = 0.02 } = {}) {
  const { CrossSection } = manifold();
  if (!(radius > 0) || cs.isEmpty()) {
    return { cs: cs.translate(0, 0), appliedRadius: 0, limited: false, restoredParts: 0 };
  }
  const parts = cs.decompose();
  const pieces = [];
  const created = [];
  let applied = Infinity;
  let limited = false;
  let restoredParts = 0;
  for (const part of parts) {
    const stroke = strokeEstimate(part);
    const r = stroke > 0 ? Math.min(radius, RADIUS_PER_STROKE * stroke) : radius;
    const rounded = roundPart(part, r, concaveRadius, quality);
    if (rounded) {
      pieces.push(rounded.cs);
      created.push(rounded.cs);
      applied = Math.min(applied, rounded.radius);
      if (rounded.radius < radius) limited = true;
    } else {
      pieces.push(part);
      restoredParts++;
      limited = true;
    }
  }
  const out = CrossSection.union(pieces);
  parts.forEach((p) => p.delete());
  created.forEach((p) => p.delete());
  return { cs: out, appliedRadius: Number.isFinite(applied) ? applied : 0, limited, restoredParts };
}

// A part keeping less than this share of its area after shrinking is a thin stroke, even if some of it survives.
const WEAK_RETENTION = 0.25;

/**
 * Printability check of a text outline (run it on the final cross-section,
 * after weight and rounding).
 *
 * Every connected part is shrunk by `minStroke / 2`, which erases every stroke
 * at or below `minStroke`: a part that vanishes is "lost", one keeping less
 * than 25 % of its area is "weak", and either makes `thin` true. Growing the
 * whole shape by `minGap / 2` merges letters closer than `minGap` and closes
 * counters narrower than it; either sets `narrowGaps`.
 *
 * Returns { thin, lostParts, weakParts, meanStroke, minStroke, narrowGaps, parts }
 * where meanStroke / minStroke are 2·area / perimeter estimates of the whole
 * shape and of its thinnest part, and `parts` lists every part as
 * { bounds: { min: [x, y], max: [x, y] }, retained, stroke } for highlighting.
 */
export function thinStrokeReport(cs, { minStroke = 0.8, minGap = 0.4 } = {}) {
  const report = {
    thin: false,
    lostParts: 0,
    weakParts: 0,
    meanStroke: 0,
    minStroke: 0,
    narrowGaps: false,
    parts: [],
  };
  const area = cs.area();
  if (!(area > 0)) return report;
  report.meanStroke = strokeEstimate(cs, area);

  const parts = cs.decompose();
  let thinnest = Infinity;
  for (const part of parts) {
    const partArea = part.area();
    const stroke = strokeEstimate(part, partArea);
    thinnest = Math.min(thinnest, stroke);
    const shrunk = part.offset(-minStroke / 2, 'Miter', 3, 8);
    const lost = shrunk.isEmpty();
    const retained = lost || !(partArea > 0) ? 0 : shrunk.area() / partArea;
    shrunk.delete();
    if (lost) report.lostParts++;
    else if (retained < WEAK_RETENTION) report.weakParts++;
    const { min, max } = part.bounds();
    report.parts.push({ bounds: { min: [min[0], min[1]], max: [max[0], max[1]] }, retained, stroke });
  }
  report.minStroke = Number.isFinite(thinnest) ? thinnest : 0;
  report.thin = report.lostParts + report.weakParts > 0;

  if (minGap > 0) {
    const holes = cs.numContour() - parts.length;
    const grown = cs.offset(minGap / 2, 'Miter', 3, 8);
    const after = topology(grown);
    grown.delete();
    report.narrowGaps = after.components < parts.length || after.holes < holes;
  }
  parts.forEach((p) => p.delete());
  return report;
}

/**
 * Printable limits for a nozzle diameter (model units): the thinnest stroke
 * and the narrowest gap between strokes. Raised text needs two extrusion
 * widths per stroke and one between letters; engraved pockets can be a little
 * narrower than that, but the wall left between two pockets must be printable.
 */
export function printLimits({ nozzle = 0.4, mode = 'emboss' } = {}) {
  return mode === 'engrave'
    ? { minStroke: 1.2 * nozzle, minGap: 2 * nozzle }
    : { minStroke: 2 * nozzle, minGap: nozzle };
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
