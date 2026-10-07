import { Matrix4, Vector3 } from 'three';
import { describeRepair, repairToManifold } from './repair.js';
import { conformNotes, conformSolid, createSurfaceSampler } from './conform.js';
import { buildCrossSectionInfo, printLimits, textZRange, thinStrokeReport } from './textGeometry.js';
import { labelFor, parseFont } from './fontParse.js';
import { parseSTL, triangleSoup, writeBinarySTL } from './stl.js';
import { buildBVH, concatSoups, displayBuffers, geometryFromBuffers, manifoldToSoup } from './mesh.js';
import { placementMatrix, toMat4 } from './placement.js';
import { fontIds, hasText, itemLabel, placeKey, shapeKey } from './document.js';

/**
 * The geometry engine: a pure request handler that owns Manifold objects,
 * parsed fonts and the loaded model. It runs inside the Web Worker
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

export function createEngine({ wasm }) {
  const { Manifold } = wasm;
  const fonts = new Map(); // fontId -> { font, label, key }
  const flat = new LRU(FLAT_CACHE, (v) => v.solid.delete());
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

  /** Cache key fragment covering every font an item uses (re-uploads change it). */
  const fontKeyOf = (item) => fontIds(item).map((id) => fontFor(id).key).join(',');

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
    if (result) result.solid?.delete();
    result = null;
  }

  function disposeCurrent() {
    if (!base?.current) return;
    base.current.manifold?.delete();
    base.current.geometry?.dispose?.();
    base.current.sampler?.dispose?.();
    base.current = null;
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
    const buffers = displayBuffers(manifold, passthrough);
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
      triangles,
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

  /** Without a model there is nothing to sink into: text sits on the plate. */
  const effective = (item) => (base?.kind === 'none' && item.mode !== 'engrave' ? { ...item, overlap: 0 } : item);

  /** Flat (un-conformed) text solid in the item's local frame, cached by shape. */
  function flatFor(item) {
    const key = shapeKey(item, fontKeyOf(item));
    let entry = flat.get(key);
    if (entry) return entry;
    const info = buildCrossSectionInfo(linesWithFonts(item), item);
    if (!info.cs) fail('FONT_NO_OUTLINES', 'The font has no outlines for those characters.');
    try {
      const [z0, z1] = textZRange(item);
      if (!(z1 - z0 > 0)) fail('EMPTY_RESULT', 'Height or depth must be greater than zero.');
      const { min, max } = info.cs.bounds();
      const extruded = Manifold.extrude(info.cs, z1 - z0);
      const solid = extruded.translate(0, 0, z0);
      extruded.delete();
      entry = { solid, size: [max[0] - min[0], max[1] - min[1]], rounding: info.rounding };
      flat.set(key, entry);
      return entry;
    } finally {
      info.cs.delete();
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
    const s = item.conform && base.kind !== 'none' ? sampler(placement) : null;
    if (s) {
      const out = conformSolid(flatEntry.solid, s);
      solid = out.solid;
      stats = { ...out.stats, conformed: out.conformed };
    } else {
      solid = flatEntry.solid.translate(0, 0, 0);
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
    if (item.mode === 'engrave' && base?.kind !== 'none' && !base?.current?.manifold) {
      notes.push({
        level: 'warn',
        code: 'ENGRAVE_UNAVAILABLE',
        text: "This model couldn't be made watertight, so text can only be raised on it, not cut in.",
      });
    }
    if (stats) notes.push(...conformNotes(stats, { mode: item.mode, depth: item.depth, overlap: item.overlap, nozzle }));
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
    if (item.depth < 2 * layer) {
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
      },
      transfer: [positions.buffer, index.buffer],
    };
  }

  /* ------------------------------------------------------------ result */

  /** union(base, raised) − union(cut); cached for the same inputs. */
  function finalFor(items, baseVersion, printing, progress) {
    const b = baseFor(baseVersion);
    const active = items.filter(hasText);
    const key = `${baseVersion}|${active.map((i) => `${shapeKey(i, fontKeyOf(i))}|${placeKey(i)}`).sort().join(';')}`;
    if (result?.key === key) return result;

    const notes = [];
    const skipped = [];
    const emboss = [];
    const engrave = [];
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
        if (item.mode === 'engrave' && !b.current.manifold) {
          skipped.push(item.id);
          notes.push({
            level: 'warn',
            code: 'ENGRAVE_UNAVAILABLE',
            itemId: item.id,
            text: `${quote(item)} is cut-in text, which needs a watertight model, so it was left out.`,
          });
          return;
        }
        const world = temps.add(placed.solid.transform(toMat4(placed.placement)));
        (item.mode === 'engrave' ? engrave : emboss).push(world);
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
      if (result) result.solid?.delete();
      result = { key, solid: kept, notes, skipped, passthrough: b.current.passthrough };
      return result;
    } finally {
      temps.dispose();
    }
  }

  function resultDisplay({ items, baseVersion, printing }, progress) {
    const final = finalFor(items, baseVersion, printing, progress);
    progress?.('Preparing the view…');
    const buffers = displayBuffers(final.solid, final.passthrough);
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
    return { message: { stl, triangles: soup.length / 9, notes: final.notes, skipped: final.skipped }, transfer: [stl] };
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

  /* ---------------------------------------------------------- dispatch */

  const handlers = {
    ping: () => ({ message: { ready: true, caches: { flat: flat.size, conformed: conformed.size, result: result ? 1 : 0 }, fonts: [...fonts.keys()], baseVersion: base?.version ?? null }, transfer: [] }),
    'font.add': addFont,
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
    },
  };
}
