import { Matrix4, Vector3 } from 'three';
import { describeRepair, repairToManifold } from './repair.js';
import { conformNotes, conformSolid, createSurfaceSampler } from './conform.js';
import { buildCrossSectionInfo, printLimits, textZRange, thinStrokeReport } from './textGeometry.js';
import { labelFor, parseFont } from './fontParse.js';
import { parseSTL, triangleSoup, writeBinarySTL } from './stl.js';
import { buildBVH, concatSoups, displayBuffers, geometryFromBuffers, manifoldToSoup } from './mesh.js';
import { placementMatrix, toMat4 } from './placement.js';
import { baseMode, fontIds, hasText, isPart, itemLabel, placeKey, shapeKey } from './document.js';

/**
 * The geometry engine: a pure request handler that owns Manifold objects,
 * parsed fonts, attached parts and the loaded model. It runs inside the Web Worker
 * (worker.js) and, for tests, directly in Node.
 *
 * Protocol — every request is `{ id, channel, type, ...payload }`, every
 * answer `{ id, ok: true, result }` or `{ id, ok: false, error: { code,
 * message, details } }`. Request types:
 *
 *   font.add    { fontId, bytes }                       -> { fontId, label }
 *   base.load   { kind:'stl'|'sample'|'none', bytes, name, version, transforms, simplify }
 *                                                       -> { info, report, display }
 *   base.update { version, transforms, simplify }       -> { info, report, display }
 *   preview     { item, baseVersion, printing }         -> { empty } | { geometry, bounds, stats, notes }
 *   result      { items, baseVersion, printing }        -> { display, notes, info }
 *   export      { items, baseVersion, name, printing }  -> { stl, triangles, notes }
 *   ping        {}                                      -> { ready: true, caches }
 *
 * `display` = { positions, normals, index, passthroughStart, bvhRoots } —
 * typed arrays ready for a THREE.BufferGeometry plus a serialised MeshBVH.
 *
 * Final geometry has fixed semantics regardless of item order:
 *   union(model, all raised text) minus union(all cut-in text).
 */

const FLAT_CACHE = 16;
const CONFORM_CACHE = 16;
const TINY_SHELL_FRACTION = 1e-3;
// Models above this many triangles are shown (and sampled) through a simplified
// copy so the view stays fluid; downloads always use the full-detail solid.
const LOD_TRIANGLES = 400_000;
const LOD_TOLERANCE = 0.02;

export class EngineError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Least-recently-used map that disposes evicted Manifold values. */
class LRU {
  constructor(limit, dispose) {
    this.limit = limit;
    this.dispose = dispose;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.dispose(this.map.get(key));
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const [oldest] = this.map.keys();
      this.dispose(this.map.get(oldest));
      this.map.delete(oldest);
    }
  }

  clear() {
    for (const v of this.map.values()) this.dispose(v);
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

/** Collects temporaries so they are all deleted, even when something throws. */
function scope() {
  const items = [];
  return {
    add(m) {
      items.push(m);
      return m;
    },
    dispose() {
      for (const m of items) m?.delete?.();
      items.length = 0;
    },
  };
}

/**
 * Runs of triangles ([startTriangle, count]) whose vertices lie beyond the
 * solid's vertex range, i.e. the unrepaired soup, in whatever order the index
 * is in (a BVH build reorders it).
 */
export function passthroughRangesOf(index, solidVertexCount) {
  const ranges = [];
  let start = -1;
  const triangles = index.length / 3;
  for (let t = 0; t < triangles; t++) {
    const pass = index[t * 3] >= solidVertexCount;
    if (pass && start < 0) start = t;
    if (!pass && start >= 0) {
      ranges.push([start, t - start]);
      start = -1;
    }
  }
  if (start >= 0) ranges.push([start, triangles - start]);
  return ranges;
}

/** A small rounded plaque, handy as a starting model. */
export function samplePlaque(wasm, { width = 70, depth = 30, height = 4, radius = 4 } = {}) {
  const { CrossSection, Manifold } = wasm;
  const rect = CrossSection.square([width - 2 * radius, depth - 2 * radius], true);
  const rounded = rect.offset(radius, 'Round', 2, 48);
  const plaque = Manifold.extrude(rounded, height);
  rect.delete();
  rounded.delete();
  return plaque;
}

const quote = (item) => `“${itemLabel(item).slice(0, 24)}”`;

/** Heuristic hints about a freshly loaded model (units, orientation, size). */
export function modelSuggestions({ size, triangles }) {
  const suggestions = [];
  const longest = Math.max(...size);
  if (longest > 0 && longest < 10) {
    suggestions.push({
      code: 'INCHES',
      text: `This model is only ${size.map((v) => v.toFixed(1)).join(' × ')} mm – it may have been saved in inches.`,
      action: 'Convert to mm',
    });
  }
  const sorted = [...size].sort((a, b) => a - b);
  if (sorted[0] > 0 && sorted[0] < 0.3 * sorted[1] && size.indexOf(sorted[0]) === 1) {
    suggestions.push({
      code: 'Y_UP',
      text: 'This flat model is standing on its edge – it was probably saved with Y as "up".',
      action: 'Lay it flat',
    });
  }
  if (triangles > 1_000_000) {
    suggestions.push({
      code: 'SIMPLIFY',
      text: `${triangles.toLocaleString()} triangles is a lot – simplifying the model makes editing much faster.`,
      action: 'Simplify',
    });
  }
  return suggestions;
}

/**
 * Rotation (degrees about X, Y, Z) that turns the chosen side of a part so it
 * faces down (-Z), i.e. becomes the face that touches the model.
 */
export const ATTACH_ROTATIONS = {
  bottom: [0, 0, 0],
  top: [180, 0, 0],
  front: [90, 0, 0], // -Y side down
  back: [-90, 0, 0], // +Y side down
  left: [0, -90, 0], // -X side down
  right: [0, 90, 0], // +X side down
};

/** Outline of a backing plate centred on the origin. */
export function plateShape(wasm, kind, width, height) {
  const { CrossSection } = wasm;
  if (kind === 'banner') {
    // a ribbon with swallow-tailed ends: tails extend beyond the text, each end notched
    const tail = Math.min(height * 0.8, Math.max(2, width * 0.12));
    const notch = tail * 0.6;
    const W = width / 2 + tail;
    const H = height / 2;
    return CrossSection.ofPolygons([[[-W, -H], [-W + notch, 0], [-W, H], [W, H], [W - notch, 0], [W, -H]]], 'NonZero');
  }
  const r = Math.min(height / 3, 4);
  const inner = CrossSection.square([Math.max(0.1, width - 2 * r), Math.max(0.1, height - 2 * r)], true);
  const plaque = inner.offset(r, 'Round', 2, 24);
  inner.delete();
  return plaque;
}

/** Centroid of a cross-section (area weighted over its polygons). */
function centroidOf(cs) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (const poly of cs.toPolygons()) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % poly.length];
      const cross = x0 * y1 - x1 * y0;
      a += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
  }
  if (Math.abs(a) < 1e-12) {
    const { min, max } = cs.bounds();
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function createEngine({ wasm, lodTriangles = LOD_TRIANGLES, lodTolerance = LOD_TOLERANCE }) {
  const { Manifold } = wasm;
  const fonts = new Map(); // fontId -> { font, label, key }
  const parts = new Map(); // partId -> { manifold, info, key }
  const flat = new LRU(FLAT_CACHE, (v) => {
    v.solid.delete();
    v.cutter?.delete();
  });
  const conformed = new LRU(CONFORM_CACHE, (v) => v.solid.delete());
  let result = null; // { key, solid, notes, skipped }
  let base = null;

  /* ------------------------------------------------------------ errors */

  const fail = (code, message, details) => {
    throw new EngineError(code, message, details);
  };

  const fontFor = (fontId) => {
    const entry = fonts.get(fontId);
    if (!entry) fail('FONT_MISSING', `Font "${fontId}" is not loaded`, { fontId });
    return entry;
  };

  /** Fail once with ALL the fonts the items need but the engine lacks, so one rehydration round suffices. */
  const requireFonts = (items) => {
    const missing = [...new Set(items.flatMap((i) => fontIds(i)).filter((id) => !fonts.has(id)))];
    if (missing.length) {
      fail('FONT_MISSING', `Font "${missing[0]}" is not loaded`, { fontId: missing[0], fontIds: missing });
    }
  };

  /** Fail once with ALL the parts the items need but the engine lacks. */
  const requireParts = (items) => {
    const missing = [...new Set(items.filter(isPart).map((i) => i.partId).filter((id) => id && !parts.has(id)))];
    if (missing.length) {
      fail('PART_MISSING', `Part "${missing[0]}" is not loaded`, { partId: missing[0], partIds: missing });
    }
  };

  /** Cache key fragment covering every font (or the part) an item uses (re-uploads change it). */
  const fontKeyOf = (item) => {
    if (isPart(item)) {
      requireParts([item]);
      return parts.get(item.partId).key;
    }
    requireFonts([item]);
    return fontIds(item).map((id) => fontFor(id).key).join(',');
  };

  /** The item's lines with their parsed fonts, ready for the layout. */
  const linesWithFonts = (item) => item.lines.map((l) => ({ font: fontFor(l.fontId).font, text: l.text, size: l.size }));

  const baseFor = (version) => {
    if (!base || base.version !== version) {
      fail('BASE_MISSING', 'The model is not loaded in the engine', { version, have: base?.version ?? null });
    }
    return base;
  };

  /* -------------------------------------------------------------- base */

  function clearDerived() {
    conformed.clear();
    if (result) {
      result.solid?.delete();
      result.separate?.forEach((p) => {
        p.world.delete();
        p.local.delete();
      });
    }
    result = null;
  }

  function disposeCurrent() {
    if (!base?.current) return;
    base.current.manifold?.delete();
    base.current.lod?.delete();
    base.current.geometry?.dispose?.();
    base.current.sampler?.dispose?.();
    base.current = null;
  }

  /** A lighter copy of a solid for display when it is very dense (null when not needed). */
  function lodFor(solid) {
    if (!solid || solid.numTri() <= lodTriangles) return null;
    const simpler = solid.simplify(lodTolerance);
    if (simpler.numTri() >= solid.numTri()) {
      simpler.delete();
      return null;
    }
    return simpler;
  }

  function disposeBase() {
    if (!base) return;
    disposeCurrent();
    base.original?.manifold?.delete();
    base = null;
  }

  const composeTransforms = (transforms) =>
    transforms.reduce((acc, t) => new Matrix4().fromArray(t).multiply(acc), new Matrix4());

  function transformSoup(soup, matrix) {
    if (!soup.length) return soup;
    const out = new Float32Array(soup.length);
    const v = new Vector3();
    for (let i = 0; i < soup.length; i += 3) {
      v.set(soup[i], soup[i + 1], soup[i + 2]).applyMatrix4(matrix);
      out[i] = v.x;
      out[i + 1] = v.y;
      out[i + 2] = v.z;
    }
    return out;
  }

  /** (Re)build the displayed model from the original + transforms + simplify. */
  function deriveCurrent(progress) {
    disposeCurrent();
    clearDerived();
    const { original, transforms, simplify } = base;
    const matrix = composeTransforms(transforms);
    let manifold = original.manifold ? original.manifold.transform(toMat4(matrix)) : null;
    if (manifold && simplify > 0) {
      progress?.('Simplifying…');
      const simpler = manifold.simplify(simplify);
      manifold.delete();
      manifold = simpler;
    }
    const passthrough = transformSoup(original.passthrough, matrix);
    progress?.('Preparing the view…');
    const lod = lodFor(manifold);
    const buffers = displayBuffers(lod ?? manifold, passthrough);
    const geometry = geometryFromBuffers({ positions: buffers.positions, index: buffers.index });
    let bvhRoots = [];
    let bvhVersion = null;
    if (buffers.index.length) {
      const built = buildBVH(geometry); // reorders geometry.index in place
      bvhRoots = built.roots;
      bvhVersion = built.version;
      buffers.index = built.index; // the reordered copy, for the main thread
      geometry.boundsTree = built.bvh;
    }
    // which triangles (in the reordered index) belong to the unrepaired soup
    const passthroughRanges = passthroughRangesOf(buffers.index, buffers.solidVertexCount);
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const size = buffers.index.length ? [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z] : [0, 0, 0];
    const triangles = buffers.index.length / 3;
    base.current = {
      manifold,
      lod,
      passthrough,
      geometry,
      bounds: buffers.index.length ? { min: bb.min.toArray(), max: bb.max.toArray() } : null,
      shellVolumes: null, // filled lazily: volumes of the model's own shells
    };
    const info = {
      name: base.name,
      kind: base.kind,
      version: base.version,
      size,
      bounds: base.current.bounds,
      triangles: (manifold ? manifold.numTri() : 0) + passthrough.length / 9,
      displayTriangles: triangles,
      simplifiedView: !!lod,
      originalTriangles: original.inputTriangles,
      watertight: !!manifold,
      repaired: !!original.report?.repaired,
      passthroughTriangles: passthrough.length / 9,
      hasModel: base.kind !== 'none',
      suggestions: base.kind === 'stl' && transforms.length === 0 && !simplify ? modelSuggestions({ size, triangles }) : [],
    };
    const display = {
      positions: buffers.positions.slice(), // the worker keeps its own copy for sampling
      normals: buffers.normals,
      index: buffers.index,
      passthroughStart: buffers.passthroughStart,
      passthroughRanges,
      bvhRoots,
      bvhVersion,
    };
    return {
      message: { info, report: base.original.report, display },
      transfer: [display.positions.buffer, display.normals.buffer, display.index.buffer, ...bvhRoots],
    };
  }

  function loadBase({ kind, bytes, name = 'model', version, transforms = [], simplify = null }, progress) {
    disposeBase();
    clearDerived();
    let original;
    if (kind === 'none') {
      original = { manifold: null, passthrough: new Float32Array(0), report: null, inputTriangles: 0 };
    } else if (kind === 'sample') {
      original = { manifold: samplePlaque(wasm), passthrough: new Float32Array(0), report: null, inputTriangles: 0 };
      name = 'plaque';
    } else if (kind === 'stl') {
      progress?.('Reading the file…');
      let geometry;
      try {
        geometry = parseSTL(bytes);
      } catch (err) {
        fail('STL_INVALID', err.message);
      }
      const soup = triangleSoup(geometry);
      geometry.dispose();
      progress?.('Checking the mesh…');
      const repaired = repairToManifold(soup, { onProgress: (stage) => progress?.(`${stage}…`) });
      const report = repaired.report;
      original = {
        manifold: repaired.manifold,
        passthrough: repaired.passthrough ?? new Float32Array(0),
        report: { ...report, summary: describeRepair(report) },
        inputTriangles: soup.length / 9,
      };
      if (!original.manifold && !original.passthrough.length) {
        fail('STL_INVALID', 'The file has no usable triangles.');
      }
    } else {
      fail('INTERNAL', `Unknown model kind "${kind}"`);
    }
    base = { version, kind, name, original, transforms, simplify };
    return deriveCurrent(progress);
  }

  function updateBase({ version, transforms = [], simplify = null }, progress) {
    if (!base?.original) fail('BASE_MISSING', 'The model is not loaded in the engine', { version });
    base.version = version;
    base.transforms = transforms;
    base.simplify = simplify;
    return deriveCurrent(progress);
  }

  /* -------------------------------------------------------------- text */

  /**
   * What is actually built: without a model there is nothing to sink into, so
   * everything sits on the build plate; pegs need holes, so without a
   * watertight model a pegged part is fused instead (notesFor says so).
   */
  const effective = (item) => {
    const noModel = base?.kind === 'none';
    const cuttable = !noModel && !!base?.current?.manifold;
    if (isPart(item)) {
      let out = item;
      if (noModel && out.sink) out = { ...out, sink: 0 };
      if (out.join === 'pegs' && out.mode !== 'engrave' && !cuttable) out = { ...out, join: 'fuse' };
      return out;
    }
    if (noModel && (item.mode !== 'engrave' || item.plate !== 'none')) return { ...item, overlap: 0 };
    return item;
  };

  /**
   * Flat (un-conformed) solid of an item in its local frame, cached by shape:
   * the extruded text, text on a backing plate, or an attached part with its
   * join geometry. `cutter` (parts joined with pegs) is what the model loses.
   */
  function flatFor(item) {
    const key = shapeKey(item, fontKeyOf(item));
    let entry = flat.get(key);
    if (entry) return entry;
    entry = isPart(item) ? partSolidFor(item) : textSolidFor(item);
    flat.set(key, entry);
    return entry;
  }

  function textSolidFor(item) {
    const info = buildCrossSectionInfo(linesWithFonts(item), item);
    if (!info.cs) fail('FONT_NO_OUTLINES', 'The font has no outlines for those characters.');
    const temps = scope();
    try {
      const cs = info.cs;
      const { min, max } = cs.bounds();
      let solid;
      let size = [max[0] - min[0], max[1] - min[1]];
      if (item.plate && item.plate !== 'none') {
        // text on a plaque or banner: the plate is what meets the model
        const pad = Math.max(0, item.platePadding ?? 3);
        const thickness = Math.max(0.2, item.plateThickness ?? 2);
        const outline = temps.add(plateShape(wasm, item.plate, size[0] + 2 * pad, size[1] + 2 * pad));
        const plateRaw = temps.add(Manifold.extrude(outline, thickness + item.overlap));
        const plate = temps.add(plateRaw.translate(0, 0, -item.overlap));
        if (item.mode === 'engrave') {
          const depth = Math.max(0.1, item.depth);
          const textRaw = temps.add(Manifold.extrude(cs, depth + 0.4));
          const text = temps.add(textRaw.translate(0, 0, thickness - depth));
          solid = plate.subtract(text);
        } else {
          const textRaw = temps.add(Manifold.extrude(cs, item.depth + 0.3));
          const text = temps.add(textRaw.translate(0, 0, thickness - 0.3));
          solid = plate.add(text);
        }
        const pb = outline.bounds();
        size = [pb.max[0] - pb.min[0], pb.max[1] - pb.min[1]];
      } else {
        const [z0, z1] = textZRange(item);
        if (!(z1 - z0 > 0)) fail('EMPTY_RESULT', 'Height or depth must be greater than zero.');
        const extruded = temps.add(Manifold.extrude(cs, z1 - z0));
        solid = extruded.translate(0, 0, z0);
      }
      return { solid, size, rounding: info.rounding, cutter: null };
    } finally {
      info.cs.delete();
      temps.dispose();
    }
  }

  /**
   * An attached part in its local frame: the chosen side faces the model
   * (contact plane z = 0), scaled, tilted (re-seated so its lowest point is
   * on the plane), sunk into the surface, with its join:
   *   fuse   – the part itself (the sink makes the union solid)
   *   fillet – plus a layered concave fillet skirt around its foot
   *   pegs   – plus pegs underneath; `cutter` holds the matching holes
   * A part used as a cutter ignores the join. `cut` describes what enters
   * the model (for the cut-through warning), `warnings` what to tell the user.
   */
  function partSolidFor(item) {
    const part = parts.get(item.partId);
    const temps = scope();
    const warnings = [];
    try {
      const rot = ATTACH_ROTATIONS[item.attach] ?? ATTACH_ROTATIONS.bottom;
      let m = temps.add(part.manifold.rotate(rot));
      const seat = (solid) => {
        const { min, max } = solid.boundingBox();
        return temps.add(solid.translate(-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]));
      };
      m = seat(m);
      const scale = item.scale > 0 ? item.scale : 1;
      if (scale !== 1) m = seat(temps.add(m.scale(scale)));
      // tilt pivots about the clicked point: one side goes into the surface, the other lifts off it
      if (item.tilt) m = temps.add(m.rotate([item.tilt, 0, 0]));
      const sink = Math.max(0, item.sink ?? 0);
      const bb = m.boundingBox();
      const buried = Math.max(0, -bb.min[2]);
      const top = bb.max[2]; // height above the contact plane
      const eps = Math.min(0.05, top / 10);
      const footprint = temps.add(m.slice(eps)); // section at the contact plane
      const fb = footprint.isEmpty() ? m.boundingBox() : footprint.bounds();
      const size = [fb.max[0] - fb.min[0], fb.max[1] - fb.min[1]];
      const cutter_ = item.mode === 'engrave';
      const join = cutter_ ? 'fuse' : item.join; // a cutter has no connection to make
      const liftGap = buried - sink;
      if (liftGap > 0.05) {
        warnings.push({
          level: 'warn',
          code: 'TILT_GAP',
          text: `Tilting lifts one edge ${liftGap.toFixed(1)} mm off the surface. Use "Fused + fillet", more sink, or less tilt.`,
        });
      }
      let solid;
      let cutter = null;
      let cut = { mode: cutter_ ? 'engrave' : 'emboss', depth: sink + buried };
      if (join === 'fillet' && item.filletRadius > 0) {
        const r = item.filletRadius;
        const sunk = temps.add(m.translate(0, 0, -sink));
        const crest = top - sink; // the part's top once sunk: the skirt never rises above it
        const layer = Math.max(0.1, Math.min(0.3, r / 6));
        const d = (z) => r - Math.sqrt(Math.max(0, r * r - (r - z) * (r - z)));
        const slabs = [];
        for (let z0 = 0; z0 < Math.min(r, crest) - 1e-9; z0 += layer) {
          const zTop = Math.min(z0 + layer, crest);
          const slice = temps.add(sunk.slice(Math.min(z0 + layer / 2, crest - eps)));
          if (slice.isEmpty()) continue;
          const grown = temps.add(slice.offset(d(z0), 'Round', 2, 16));
          const bottom = z0 === 0 ? -(sink + eps) : z0;
          const slab = temps.add(Manifold.extrude(grown, zTop - bottom));
          slabs.push(temps.add(slab.translate(0, 0, bottom)));
        }
        const skirt = slabs.length ? temps.add(Manifold.union(slabs)) : null;
        solid = skirt ? sunk.add(skirt) : sunk.translate(0, 0, 0);
      } else if (join === 'pegs' && item.pegCount > 0) {
        const radius = Math.max(0.3, item.pegDiameter / 2);
        const clearance = Math.max(0, item.pegClearance ?? 0.15);
        const length = Math.max(0.5, item.pegLength);
        const count = Math.max(1, Math.min(6, Math.round(item.pegCount)));
        // candidate centres: one per separate foot (where a peg of this size fits), extra ones along the largest foot
        const inner = temps.add(footprint.offset(-(radius + 0.4), 'Miter', 2, 4));
        const feet = inner.isEmpty() ? [] : inner.decompose().map((c) => temps.add(c));
        feet.sort((a, b) => b.area() - a.area());
        const candidates = [];
        for (const foot of feet.slice(0, count)) candidates.push(centroidOf(foot));
        if (feet.length && candidates.length < count) {
          const big = feet[0];
          const ib = big.bounds();
          const [cx, cy] = centroidOf(big);
          const longX = ib.max[0] - ib.min[0] >= ib.max[1] - ib.min[1];
          const span = (longX ? ib.max[0] - ib.min[0] : ib.max[1] - ib.min[1]) * 0.8;
          const extra = count - candidates.length + 1;
          candidates.length = Math.max(0, candidates.length - 1); // the big foot's centroid is replaced by a spread row
          for (let i = 0; i < extra; i++) {
            const f = extra === 1 ? 0 : i / (extra - 1) - 0.5;
            candidates.push(longX ? [cx + f * span, cy] : [cx, cy + f * span]);
          }
        }
        // keep only pegs whose whole disc sits under the part
        const discArea = Math.PI * radius * radius;
        const centres = candidates.filter(([x, y]) => {
          const disc = temps.add(wasm.CrossSection.circle(radius, 32).translate(x, y));
          const under = temps.add(disc.intersect(footprint));
          return under.area() >= 0.95 * discArea;
        });
        if (centres.length < count) {
          warnings.push({
            level: 'warn',
            code: 'PEGS_DROPPED',
            text: centres.length
              ? `Only ${centres.length} of ${count} pegs fit under this part; the rest were left out.`
              : 'No peg of this size fits under the part – use a smaller diameter or the fused connection.',
          });
        }
        if (centres.length) {
          const pegs = centres.map(([x, y]) => {
            const c = temps.add(Manifold.cylinder(length + eps, radius, radius, 32));
            return temps.add(c.translate(x, y, -length));
          });
          const holes = centres.map(([x, y]) => {
            const c = temps.add(Manifold.cylinder(length + clearance + 1, radius + clearance, radius + clearance, 32));
            return temps.add(c.translate(x, y, -(length + clearance)));
          });
          solid = m.add(temps.add(Manifold.union(pegs)));
          cutter = Manifold.union(holes);
          cut = { mode: 'engrave', depth: length + clearance + buried };
        } else {
          solid = m.translate(0, 0, -sink);
        }
      } else {
        solid = m.translate(0, 0, -sink);
      }
      return { solid, cutter, size, rounding: null, cut, warnings, part: { name: part.info.name, triangles: part.info.triangles }, pegged: !!cutter };
    } finally {
      temps.dispose();
    }
  }

  /** Printability report for an item's outline, per nozzle setting (small cache). */
  const strokeCache = new Map();
  function strokeFor(item, printing) {
    const limits = printLimits({ nozzle: printing?.nozzle ?? 0.4, mode: item.mode });
    const key = `${shapeKey(item, fontKeyOf(item))}|${limits.minStroke}|${limits.minGap}`;
    if (strokeCache.has(key)) return strokeCache.get(key);
    const info = buildCrossSectionInfo(linesWithFonts(item), item);
    let stroke = null;
    if (info.cs) {
      stroke = thinStrokeReport(info.cs, limits);
      info.cs.delete();
    }
    const report = { stroke, limits };
    strokeCache.set(key, report);
    if (strokeCache.size > 64) strokeCache.delete(strokeCache.keys().next().value);
    return report;
  }

  function sampler(placement) {
    const current = base.current;
    if (!current?.geometry || !current.geometry.index?.count) return null;
    return createSurfaceSampler(current.geometry, placement);
  }

  /** Conformed (or plain) solid for an item on the current base, cached. */
  function solidFor(raw) {
    const item = effective(raw);
    const flatEntry = flatFor(item);
    const placement = placementMatrix(item);
    const key = `${shapeKey(item, fontKeyOf(item))}|${placeKey(item)}|${base.version}`;
    let entry = conformed.get(key);
    if (entry) return { ...entry, flat: flatEntry, placement };
    let solid;
    let stats = null;
    const wantsStats = base.kind !== 'none';
    const s = wantsStats && (item.conform || isPart(item)) ? sampler(placement) : null;
    if (s && item.conform && !isPart(item)) {
      const out = conformSolid(flatEntry.solid, s);
      solid = out.solid;
      stats = { ...out.stats, conformed: out.conformed };
    } else {
      solid = flatEntry.solid.translate(0, 0, 0);
      if (s) {
        // a rigid part is not warped, but we still want to know how it meets the surface
        const bb = flatEntry.solid.boundingBox();
        const atPlane = flatEntry.solid.slice(Math.min(0.05, bb.max[2] / 10)); // the contact plane is z = 0
        const foot = atPlane.isEmpty() ? flatEntry.solid.slice(bb.min[2] + Math.min(0.05, (bb.max[2] - bb.min[2]) / 10)) : atPlane;
        if (foot !== atPlane) atPlane.delete();
        if (!foot.isEmpty()) {
          const slab = Manifold.extrude(foot, 0.2);
          const out = conformSolid(slab, s);
          stats = { ...out.stats, conformed: false };
          out.solid.delete();
          slab.delete();
        }
        foot.delete();
      }
    }
    entry = { solid, stats };
    conformed.set(key, entry);
    return { ...entry, flat: flatEntry, placement };
  }

  /** Human notes about one item (printability, placement). */
  function notesFor(item, { flat: flatEntry, stats }, printing = {}) {
    const notes = [];
    const nozzle = printing.nozzle ?? 0.4;
    const layer = printing.layerHeight ?? 0.2;
    const meets = baseMode(item);
    if (meets === 'engrave' && base?.kind !== 'none' && !base?.current?.manifold) {
      notes.push({
        level: 'warn',
        code: 'ENGRAVE_UNAVAILABLE',
        text: "This model couldn't be made watertight, so text can only be raised on it, not cut in.",
      });
    }
    if (stats) {
      const cut = isPart(item) ? flatEntry.cut : { mode: meets, depth: item.plate !== 'none' ? item.plateThickness : item.depth };
      notes.push(...conformNotes(stats, { mode: cut.mode, depth: cut.depth, overlap: item.overlap, nozzle }));
    }
    if (isPart(item)) {
      notes.push(...(flatEntry.warnings ?? []));
      if (item.mode !== 'engrave' && item.join === 'pegs') {
        if (base?.kind !== 'none' && !base?.current?.manifold) {
          notes.push({ level: 'warn', code: 'PEGS_UNAVAILABLE', text: 'Pegs need holes in a watertight model; this model has gaps, so the part is fused instead.' });
        } else if (base?.kind === 'none') {
          notes.push({ level: 'warn', code: 'PEGS_UNAVAILABLE', text: 'Pegs need a model to make holes in. Load a model, or use the fused connection.' });
        } else {
          notes.push({ level: 'info', code: 'PEGS', text: 'Pegs: the part is downloaded as its own file and glued into the matching holes.' });
        }
      }
      return notes;
    }
    const { rounding } = flatEntry;
    const { stroke, limits } = strokeFor(effective(item), printing);
    if (stroke?.thin) {
      notes.push({
        level: 'warn',
        code: 'THIN_STROKES',
        text:
          `Strokes thinner than ${limits.minStroke} mm may not print with a ${nozzle} mm nozzle` +
          (stroke.lostParts ? ' – thin parts like i and l would vanish.' : '.'),
        suggestedWeight: Math.round((item.weight + 0.2) * 100) / 100,
      });
    }
    if (stroke?.narrowGaps) {
      notes.push({
        level: 'warn',
        code: 'NARROW_GAPS',
        text: `Gaps between letters are narrower than ${limits.minGap} mm and may fill in when printed.`,
      });
    }
    if (rounding?.limited) {
      notes.push({
        level: 'info',
        code: 'ROUNDING_LIMITED',
        text: `Corner rounding was limited to ${rounding.applied.toFixed(2)} mm by the thinnest strokes.`,
      });
    }
    if (item.depth < 2 * layer && !(item.plate !== 'none' && item.mode === 'engrave')) {
      notes.push({
        level: 'info',
        code: 'SHALLOW',
        text: `${item.depth} mm is less than two ${layer} mm layers – the text will barely show.`,
        suggestedDepth: Math.round(layer * 2 * 10) / 10,
      });
    }
    return notes;
  }

  function preview({ item, baseVersion, printing }) {
    const b = baseFor(baseVersion);
    if (!hasText(item)) return { message: { empty: true }, transfer: [] };
    void b;
    const placed = solidFor(item);
    const mesh = placed.solid.getMesh();
    const positions = new Float32Array(mesh.vertProperties.length / mesh.numProp * 3);
    for (let i = 0, n = positions.length / 3; i < n; i++) {
      positions[i * 3] = mesh.vertProperties[i * mesh.numProp];
      positions[i * 3 + 1] = mesh.vertProperties[i * mesh.numProp + 1];
      positions[i * 3 + 2] = mesh.vertProperties[i * mesh.numProp + 2];
    }
    const index = mesh.triVerts.slice();
    const { min, max } = placed.solid.boundingBox();
    return {
      message: {
        geometry: { positions, index },
        bounds: { min, max },
        size: placed.flat.size,
        stats: placed.stats,
        notes: notesFor(item, placed, printing),
        matrix: placed.placement.toArray(),
        part: placed.flat.part ?? null,
      },
      transfer: [positions.buffer, index.buffer],
    };
  }

  /* ------------------------------------------------------------ result */

  /** union(base, raised) − union(cut); cached for the same inputs. */
  function finalFor(items, baseVersion, printing, progress) {
    const b = baseFor(baseVersion);
    const active = items.filter(hasText);
    requireFonts(active.filter((i) => !isPart(i)));
    requireParts(active);
    const key = `${baseVersion}|${active.map((i) => `${shapeKey(i, fontKeyOf(i))}|${placeKey(i)}`).sort().join(';')}`;
    if (result?.key === key) return result;

    const notes = [];
    const skipped = [];
    const emboss = [];
    const engrave = [];
    const separate = []; // parts joined with pegs: printed on their own
    const temps = scope();
    try {
      active.forEach((item, n) => {
        progress?.('Building text…', { done: n + 1, total: active.length });
        const placed = solidFor(item);
        if (placed.stats && placed.stats.touches === false && b.kind !== 'none') {
          skipped.push(item.id);
          notes.push({
            level: 'warn',
            code: 'NOT_TOUCHING',
            itemId: item.id,
            text: `${quote(item)} isn't touching the model and was left out. Click the model to place it on the surface.`,
          });
          return;
        }
        const meets = baseMode(item);
        const pegged = isPart(item) && meets === 'emboss' && placed.flat.pegged; // effective() already ruled pegs out when they can't be cut
        const needsCut = meets === 'engrave';
        if (needsCut && !b.current.manifold) {
          skipped.push(item.id);
          notes.push({
            level: 'warn',
            code: 'ENGRAVE_UNAVAILABLE',
            itemId: item.id,
            text: `${quote(item)} needs to cut into the model, which needs a watertight model, so it was left out.`,
          });
          return;
        }
        const world = temps.add(placed.solid.transform(toMat4(placed.placement)));
        if (pegged) {
          engrave.push(temps.add(placed.flat.cutter.transform(toMat4(placed.placement))));
          // shown in place; exported in its own frame, turned over so the pegs point up
          const flipped = temps.add(placed.solid.rotate([180, 0, 0]));
          const fbb = flipped.boundingBox();
          separate.push({ id: item.id, name: itemLabel(item, 'part'), world, local: temps.add(flipped.translate(0, 0, -fbb.min[2])) });
          return;
        }
        (meets === 'engrave' ? engrave : emboss).push(world);
      });

      let solid = null;
      if (b.current.manifold) {
        progress?.('Merging text into the model…');
        solid = emboss.length ? temps.add(Manifold.union([b.current.manifold, ...emboss])) : null;
        if (engrave.length) {
          const cutter = temps.add(Manifold.union(engrave));
          solid = temps.add(Manifold.difference(solid ?? b.current.manifold, cutter));
        }
        if (!solid) solid = temps.add(b.current.manifold.translate(0, 0, 0));
      } else if (emboss.length) {
        progress?.('Merging text…');
        solid = temps.add(Manifold.union(emboss));
      }

      if (solid) {
        if (solid.status() !== 'NoError') fail('INTERNAL', `Geometry operation failed (${solid.status()})`);
        if (solid.isEmpty()) fail('EMPTY_RESULT', 'The result would be empty – the cut-in text removes the whole model.');
        // drop floating slivers that the booleans can leave behind on curved
        // text – but never a small part the model had to begin with
        if (emboss.length + engrave.length > 0) {
          if (!b.current.shellVolumes) {
            const own = b.current.manifold ? b.current.manifold.decompose() : [];
            b.current.shellVolumes = own.map((s) => s.volume());
            own.forEach((s) => s.delete());
          }
          const isOwn = (v) => b.current.shellVolumes.some((o) => Math.abs(o - v) <= 1e-6 * Math.max(o, 1e-9));
          const shells = solid.decompose();
          const volumes = shells.map((s) => s.volume());
          const biggest = Math.max(...volumes);
          const keep = shells.filter((_, i) => volumes[i] >= TINY_SHELL_FRACTION * biggest || isOwn(volumes[i]));
          if (keep.length < shells.length) {
            notes.push({ level: 'info', code: 'FRAGMENTS_REMOVED', text: `Removed ${shells.length - keep.length} tiny loose fragments.` });
            const cleaned = Manifold.compose(keep);
            shells.forEach((s) => s.delete());
            solid = temps.add(cleaned);
          } else {
            shells.forEach((s) => s.delete());
          }
        }
      }

      const kept = solid ? solid.translate(0, 0, 0) : null; // our own handle, outside the scope
      const owned = separate.map((p) => ({ id: p.id, name: p.name, world: p.world.translate(0, 0, 0), local: p.local.translate(0, 0, 0) }));
      if (result) {
        result.solid?.delete();
        result.separate?.forEach((p) => {
          p.world.delete();
          p.local.delete();
        });
      }
      result = { key, solid: kept, notes, skipped, separate: owned, passthrough: b.current.passthrough };
      return result;
    } finally {
      temps.dispose();
    }
  }

  function resultDisplay({ items, baseVersion, printing }, progress) {
    const final = finalFor(items, baseVersion, printing, progress);
    progress?.('Preparing the view…');
    const temps = scope();
    let shown = final.solid;
    if (final.separate.length) {
      shown = temps.add(Manifold.compose([...(final.solid ? [final.solid] : []), ...final.separate.map((p) => p.world)]));
    }
    const lod = shown ? temps.add(lodFor(shown)) : null;
    const buffers = displayBuffers(lod ?? shown, final.passthrough);
    temps.dispose();
    return {
      message: {
        display: {
          positions: buffers.positions,
          normals: buffers.normals,
          index: buffers.index,
          passthroughStart: buffers.passthroughStart,
          passthroughRanges: passthroughRangesOf(buffers.index, buffers.solidVertexCount),
          bvhRoots: [],
        },
        notes: final.notes,
        skipped: final.skipped,
        info: { triangles: buffers.index.length / 3 },
      },
      transfer: [buffers.positions.buffer, buffers.normals.buffer, buffers.index.buffer],
    };
  }

  function exportStl({ items, baseVersion, printing, name = 'model' }, progress) {
    const final = finalFor(items, baseVersion, printing, progress);
    const soup = concatSoups([final.solid ? manifoldToSoup(final.solid) : null, final.passthrough]);
    if (!soup || !soup.length) fail('EMPTY_RESULT', 'There is nothing to export yet. Type some text or load a model.');
    progress?.('Writing STL…');
    const stl = writeBinarySTL(soup, `STL-Text ${name}`);
    const extra = final.separate.map((p) => {
      const partSoup = manifoldToSoup(p.local); // lying on its top face, pegs up, ready to print
      return { name: p.name, stl: writeBinarySTL(partSoup, `STL-Text ${p.name}`), triangles: partSoup.length / 9 };
    });
    return {
      message: { stl, triangles: soup.length / 9, notes: final.notes, skipped: final.skipped, extra },
      transfer: [stl, ...extra.map((e) => e.stl)],
    };
  }

  /* ------------------------------------------------------------- fonts */

  function addFont({ fontId, bytes, name }) {
    let font;
    try {
      font = parseFont(bytes, name ?? fontId);
    } catch (err) {
      fail('FONT_INVALID', err.message);
    }
    const label = labelFor(font, name ?? fontId);
    fonts.set(fontId, { font, label, key: `${fontId}:${bytes.byteLength}` });
    return { message: { fontId, label, glyphs: font.glyphs.length }, transfer: [] };
  }

  /* ------------------------------------------------------------- parts */

  function addPart({ partId, bytes, name = 'part' }, progress) {
    let geometry;
    try {
      geometry = parseSTL(bytes);
    } catch (err) {
      fail('STL_INVALID', err.message);
    }
    const soup = triangleSoup(geometry);
    geometry.dispose();
    progress?.('Checking the part…');
    const repaired = repairToManifold(soup, { onProgress: (stage) => progress?.(`${stage}…`) });
    if (!repaired.manifold) {
      fail('PART_INVALID', `"${name}" could not be made into a solid, so it cannot be attached. Repair it in your slicer first.`);
    }
    parts.get(partId)?.manifold.delete();
    const m = repaired.manifold;
    const { min, max } = m.boundingBox();
    const info = {
      name,
      triangles: m.numTri(),
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      watertight: true,
      repaired: !!repaired.report.repaired,
      summary: describeRepair(repaired.report),
      dropped: repaired.passthrough.length / 9,
    };
    parts.set(partId, { manifold: m, info, key: `${partId}:${bytes.byteLength}` });
    flat.clear();
    clearDerived();
    return { message: { partId, info }, transfer: [] };
  }

  /* ---------------------------------------------------------- dispatch */

  const handlers = {
    ping: () => ({
      message: {
        ready: true,
        caches: { flat: flat.size, conformed: conformed.size, result: result ? 1 : 0 },
        fonts: [...fonts.keys()],
        parts: [...parts.keys()],
        baseVersion: base?.version ?? null,
      },
      transfer: [],
    }),
    'font.add': addFont,
    'part.add': addPart,
    'base.load': loadBase,
    'base.update': updateBase,
    preview,
    result: resultDisplay,
    export: exportStl,
  };

  return {
    async handle(request, progress = () => {}) {
      const handler = handlers[request?.type];
      try {
        if (!handler) fail('INTERNAL', `Unknown request type "${request?.type}"`);
        const { message, transfer } = handler(request, progress);
        return { message: { id: request.id, ok: true, result: message }, transfer: transfer ?? [] };
      } catch (err) {
        const code = err instanceof EngineError ? err.code : /Not manifold/i.test(err?.message) ? 'NOT_WATERTIGHT' : 'INTERNAL';
        return {
          message: { id: request?.id, ok: false, error: { code, message: err?.message ?? String(err), details: err?.details } },
          transfer: [],
        };
      }
    },
    dispose() {
      flat.clear();
      clearDerived();
      disposeBase();
      fonts.clear();
      for (const p of parts.values()) p.manifold.delete();
      parts.clear();
    },
  };
}
