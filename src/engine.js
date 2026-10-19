import { BufferGeometry, Float32BufferAttribute, Matrix4, Uint32BufferAttribute, Vector3 } from 'three';
import { describeRepair, repairToManifold } from './repair.js';
import { conformNotes, conformSolid, createInsideTest, createSurfaceSampler, createUndersideSampler, fitDepth, heightFieldSlab } from './conform.js';
import { buildCrossSectionInfo, curveText, printLimits, textZRange, thinStrokeReport } from './textGeometry.js';
import { labelFor, parseFont } from './fontParse.js';
import { parseSTL, triangleSoup, writeBinarySTL } from './stl.js';
import { concatSoups, displayBuffers, manifoldToSoup } from './mesh.js';
import { ViewCache, passthroughRangesOf } from './view.js';
import { ATTACH_ROTATIONS, placementMatrix, toMat4 } from './placement.js';
import { baseMode, fontIds, hasText, isPart, isSpot, itemLabel, placeKey, shapeKey, stableKey } from './document.js';
import { enhanceMesh, extractRegion, isEnhanceActive, regionWeights } from './enhance.js';
import { baseSurface, crumpleOf, findDetails, refitSpheres } from './details.js';
import { DECOR_KINDS, buildDecor, decorPartId, normaliseDecorSpec } from './decor.js';
import { strToU8, zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import {
  CUT_TOLERANCE, FILAMENT, SPLIT_KEEP_TRIANGLES, SplitError, TO_PLANE, applyToSoup, assemblySteps, axisCuts, cellOfPoint,
  cutPlane, fitsBed, glueFileName, gridCandidates, howToGlueText, layPieces, letterFor, normaliseSplit, partFileName, pieceFileName, pinsFileName,
  planCost, planGrid, planSamples, plateAxis, safeFileName, slabAxis, sizesFor, smallPieceNotes, soupCells, splitActive, splitNote, usableBed,
  zipFileName, cellSupport, flatProbes, outlineColumns, textNotes, baseAxis, modelPlates, layGrown, pegAllowance, pegMales, pegSizeOf, pegSizesFor,
  pegSides, cellFits, uprightPegNotes, apartMales, cellSizes, clipHold, clipShape, lipSides, APART_HOLDS, LIP_ALLOWANCE,
  AXES, CLIP, LIP, SPOT, catchSizes, comesOffOf, endShape, endsAsWell, keepsTo, locateBend, locateSeam, pickSpots, profileSeams, seamKind, spotScore, spotSide,
  spotStart, spotWhy,
} from './split.js';
import {
  buildSplitDisplay, clearSplitCaches, cutPieces, drillPiece, fitTestCoupon, layoutSplit, partedSolids, pinAt, pinSheet, pinSpares, pinsPerSheet,
  planDovetails, probeLip, tabsAcross,
} from './splitGeometry.js';

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
 *   result      { items, baseVersion, printing, split?, bed? }
 *                                                       -> { display, notes, info }
 *                                                          (+ pieces, grid, seams, diameter, pegSize with a split)
 *   export      { items, baseVersion, name, printing, split?, bed?, printer?, archive?: 'zip'|'files' }
 *                                                       -> { stl, triangles, notes, extra }
 *                                                          (stl null, + files, zip, pieces, seams, assembly, diameter,
 *                                                          pegSize with a split)
 *   split.plan  { items, baseVersion, printing, split, bed, mode: 'fit'|'measure'|'probe'|'spots'|'targets' }
 *                                                       -> fit: { cuts, counts, pieces, notes } (the cuts that come
 *                                                          apart first, as stored, then the new ones without ids)
 *                                                          measure: { bounds, cuts, notes } (a dovetail cut also has
 *                                                          tabs, reach [below, above] and w, for `cellSizes`, a cut
 *                                                          with built-in pegs reach [L, L], and one that comes apart
 *                                                          apart: { hold } and, with a lip, reach [6, 0] or [0, 6]
 *                                                          on the side the pieces say it goes; estimate: true when
 *                                                          the faces are the model's without the text)
 *               mode: 'probe' { axis: 'x'|'y'|'z', at, hold = 'lock' }
 *                                                       -> { axis, at, area, islands, lip: { H, clips, why } | null,
 *                                                          noLip, suggestedAt, suggestedLip: { H, clips } | null,
 *                                                          comesOff: { side, length, fraction }, crosses, seams,
 *                                                          notes, estimate? }: a cut that comes apart tried there
 *                                                          on its own (`aimAt`)
 *               mode: 'spots' { axis = 'z', hold = 'lock', budget? }
 *                                                       -> { axis, spots: [{ axis, at, why, lip: { H, clips },
 *                                                          comesOff, score, seam, islands, crosses? }], seams, notes,
 *                                                          estimate? }: the best places for one, best first
 *                                                          (`spotSteps`); `crosses` the text items one runs through.
 *                                                          With a `budget` (ms), short of done in that time
 *                                                          { axis, partial: true, done, total, notes }: the same
 *                                                          request again carries on (`spotsFor`)
 *               mode: 'targets' { axis }                -> { axis, lo, hi, seams: [{ at, kind, shift }], notes,
 *                                                          estimate? }: where the shape changes along the axis,
 *                                                          for snapping a cut being placed (`aimProfile`)
 *   split.fitTest { items?, baseVersion?, split, printing, bed?, name, dovetail? }
 *                                                       -> { stl, name, triangles, diameter, pins, dovetail, pegs, pegSize,
 *                                                          apart }
 *   ping        {}                                      -> { ready: true, caches }
 *
 * `display` = { positions, normals, index, passthroughStart, bvhRoots } —
 * typed arrays ready for a THREE.BufferGeometry plus a serialised MeshBVH.
 * With a split it also has `ranges` ([triStart, triCount, vertStart,
 * vertCount] per piece, pin and part) and `parts` (what each range is).
 *
 * `split` is the document's split (`{ cuts: [{ id, position, normal }], joint, … }`,
 * a cut that comes apart with `joint: 'apart'` and its `hold`, see split.js);
 * no cuts means no split, and the replies are exactly those of
 * a model that was never split. `bed` is the room a piece may use on the
 * printer, [x, y, z] mm (`usableBed`); `printer` ({ size, margin }) only
 * names the printer on the glue sheet.
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
// Placing a cut that comes apart reads slices of the model: this many are kept per result, each simplified this
// much (mm), and this many answers.
const AIM_SLICES = 640;
const AIM_TOLERANCE = 0.01;
const AIM_PROBES = 64;
const AIM_EXTRA = 64; // samples the profile takes between faces square to its axis, at most
// A bend is found to within the slices' noise over its slope (a few hundredths of a millimetre): the model's corner is
// looked for this far (mm) either side of it.
const BEND_CORNER = 0.1;
// and how steep it is read a little way off it (mm), as `locateBend` reads it
const BEND_GAP = 0.05;
// What hangs below a take-apart cut's clips is weighed as PLA (g/mm³) under gravity (m/s²).
const PLA_DENSITY = 1.24e-3;
const GRAVITY = 9.81;

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
export { passthroughRangesOf };

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

export { ATTACH_ROTATIONS };

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

/** Solve A·x = b (dense, small) by Gaussian elimination with partial pivoting; null when singular. */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * A cross-section's outlines as point lists, as `toPolygons()` gives them.
 * manifold-3d 3.5.4's own `toPolygons()` never frees the vectors it reads,
 * which adds up over the hundreds of slices one plan of the cuts reads; this
 * frees them (and falls back to the plain call if the binding changes).
 */
function polygonsOf(cs) {
  if (typeof cs._ToPolygons !== 'function') return cs.toPolygons();
  const vec = cs._ToPolygons();
  const out = [];
  try {
    for (let i = 0, n = vec.size(); i < n; i++) {
      const ring = vec.get(i);
      const poly = [];
      for (let j = 0, m = ring.size(); j < m; j++) {
        const pt = ring.get(j);
        poly.push([pt.x, pt.y]);
      }
      ring.delete();
      out.push(poly);
    }
  } finally {
    vec.delete();
  }
  return out;
}

/** The total length of polygons' edges. */
function perimeterOf(polygons) {
  let sum = 0;
  for (const poly of polygons) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % poly.length];
      sum += Math.hypot(x1 - x0, y1 - y0);
    }
  }
  return sum;
}

/**
 * Polygons with each corner closer than `step` to the last one kept left out: plenty to tell which boxes of a grid
 * an outline reaches, and light enough to keep for every sample the planner slices.
 */
function coarseOf(polygons, step) {
  return polygons.map((ring) => {
    const out = [ring[0]];
    for (const p of ring) {
      const q = out[out.length - 1];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= step) out.push(p);
    }
    return out.length >= 3 ? out : ring;
  });
}

/** The longest distance between two corners of polygons (on at most 64 of them: enough to tell whether two pins fit). */
function spreadOf(polygons) {
  const all = polygons.flat();
  const step = Math.max(1, Math.ceil(all.length / 64));
  const pts = all.filter((_, i) => i % step === 0);
  let best = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) best = Math.max(best, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
  }
  return best;
}

/** A Manifold's bounding box as plain arrays. */
function boxOf(m) {
  const { min, max } = m.boundingBox();
  return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
}

/** A cut id's number ('c3' → 3; 0 for any other id). */
const cutNumber = (id) => Number(/^c(\d+)$/.exec(String(id))?.[1] ?? 0);

/** Cuts numbered as the document numbers them (`mergeSplit`): an id given is kept, a cut without one gets one past the highest. */
function numberedCuts(cuts) {
  let top = Math.max(0, ...cuts.map((c) => cutNumber(c.id)));
  const seen = new Set();
  return cuts.map((c) => {
    const id = c.id != null && !seen.has(c.id) ? c.id : `c${++top}`;
    seen.add(id);
    return { ...c, id };
  });
}

/** A bed size from a request: the usable [x, y, z] mm, or the default printer's when it is missing or nonsense. */
const bedOf = (bed) => (Array.isArray(bed) && bed.length === 3 && bed.every((v) => Number(v) > 0) ? bed.map(Number) : usableBed());

export function createEngine({ wasm, lodTriangles = LOD_TRIANGLES, lodTolerance = LOD_TOLERANCE, splitKeepTriangles = SPLIT_KEEP_TRIANGLES }) {
  const { Manifold } = wasm;
  const fonts = new Map(); // fontId -> { font, label, key }
  const parts = new Map(); // partId -> { manifold, info, key }
  const flat = new LRU(FLAT_CACHE, (v) => {
    v.solid.delete();
    v.cutter?.delete();
    v.body?.delete();
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
    disposeResult(result);
    result = null;
    releaseSketch();
  }

  /**
   * Deletes everything a final result holds: its solid, the separately
   * printed parts and every solid of its split. The one place that knows,
   * so replacing a result and clearing it can never drift apart.
   */
  function disposeResult(r) {
    if (!r) return;
    r.solid?.delete();
    r.separate?.forEach((p) => {
      p.world.delete();
      p.local.delete();
    });
    const s = r.split;
    if (s) {
      s.frame?.solid.delete();
      disposeSplitStage(s.cut);
      disposeSplitStage(s.drill);
      releaseAim(r);
      r.split = null;
    }
  }

  /** Deletes the solids a cut or drill stage of a split holds (kept, or made for one call and not yet used). */
  function disposeSplitStage(stage) {
    stage?.solids?.forEach((m) => m.delete());
    stage?.transient?.forEach((m) => m.delete());
    if (stage) stage.solids = stage.transient = null;
  }

  function disposeCurrent() {
    base.current = null; // the stages and their views live in the caches below
  }

  /** Drop the oldest stages of a derivation cache beyond `max`. */
  function trimCache(map, max) {
    while (map.size > max) {
      const key = map.keys().next().value;
      const e = map.get(key);
      (e.dispose ? e : e.stage)?.dispose();
      map.delete(key);
    }
  }

  /** How many stages a cache keeps: fewer for very dense models, whose solids weigh hundreds of MB each. */
  const cacheLimit = (stage, max) => (stage.mesh.index.length / 3 > 500_000 ? Math.max(1, Math.floor(max / 2)) : max);

  /** A cached stage is reused with the live stage it derives from (its old input may have been evicted since). */
  const rebase = (stage, input) => {
    if (stage.input !== input) stage.input = input;
    return stage;
  };

  /* ------------------------------------------------------------ stages */

  const EMPTY_MESH = { positions: new Float32Array(0), index: new Uint32Array(0) };
  const views = new ViewCache();

  /** xyz positions of a MeshGL as a plain Float32Array (a copy when it carries more properties). */
  function xyzOf(mesh) {
    const stride = mesh.numProp;
    if (stride === 3) return mesh.vertProperties;
    const count = mesh.vertProperties.length / stride;
    const xyz = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      xyz[i * 3] = mesh.vertProperties[i * stride];
      xyz[i * 3 + 1] = mesh.vertProperties[i * stride + 1];
      xyz[i * 3 + 2] = mesh.vertProperties[i * stride + 2];
    }
    return xyz;
  }

  /** { positions, index } of a solid (empty for null). */
  function meshOf(solid) {
    if (!solid) return EMPTY_MESH;
    const m = solid.getMesh();
    return { positions: xyzOf(m), index: m.triVerts };
  }

  /**
   * The same mesh with its vertices moved by a matrix. The index is shared, so
   * the view keeps its BVH – except under a mirroring transform, which turns
   * the triangles inside out: then each gets two corners swapped (a new index,
   * as Manifold's own transform does), so normals and the enhancer see an
   * outward-facing mesh.
   */
  function movedMesh(mesh, matrix) {
    const positions = new Float32Array(mesh.positions.length);
    const v = new Vector3();
    for (let i = 0; i < positions.length; i += 3) {
      v.set(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]).applyMatrix4(matrix);
      positions[i] = v.x;
      positions[i + 1] = v.y;
      positions[i + 2] = v.z;
    }
    let index = mesh.index;
    if (matrix.determinant() < 0) {
      index = new Uint32Array(mesh.index.length);
      for (let t = 0; t < index.length; t += 3) {
        index[t] = mesh.index[t];
        index[t + 1] = mesh.index[t + 2];
        index[t + 2] = mesh.index[t + 1];
      }
    }
    return { positions, index };
  }

  /**
   * A stage of the model's derivation: the original, the original moved by
   * the transforms, or a cached result of simplifying, enhancing or cleaning
   * it up. `mesh` is its full-resolution geometry; `view` a lighter copy for
   * display when the mesh is very dense (null when the mesh itself is shown).
   * `manifold` is the solid for booleans and export. For an enhanced or
   * cleaned-up stage it is built only when first needed (`undefined` until
   * then): the display works from the mesh alone, so sliders never wait for
   * a solid to be rebuilt. The solid is then made by moving the vertices of
   * the input stage's solid when that is still around (half the cost of
   * building one from scratch), else from the mesh.
   */
  function makeStage({ manifold, input = null, mesh = null, view, stats = null, failed = false, keepNormals = true }) {
    const stage = {
      manifold, // Manifold | null | undefined (not built yet)
      input,
      stats,
      failed,
      keepNormals, // whether to remember the display normals (not for clean-up spots, whose states change constantly)
      normals: null, // per-corner normals of the shown mesh (view or mesh), cached for re-showing
      disposed: false,
      _mesh: mesh,
      _view: view, // undefined: decide lazily (a LOD when dense); null: show the mesh itself; or a mesh
      get mesh() {
        if (!this._mesh) this._mesh = meshOf(this.materialise());
        return this._mesh;
      },
      /** The display-level mesh when the stage is too dense to show in full, else null. */
      get view() {
        if (this._view === undefined) {
          this._view = null;
          if (this.mesh.index.length / 3 > lodTriangles) {
            const solid = this.materialise();
            const lod = solid ? lodFor(solid) : null;
            if (lod) {
              this._view = meshOf(lod); // only the mesh is kept: the solid copy would hold tens of MB for nothing
              lod.delete();
            }
          }
        }
        return this._view;
      },
      /** The solid of this stage, built on first use; null when it could not be built (then `failed` is set). */
      materialise() {
        if (this.manifold !== undefined) return this.manifold;
        const { positions, index } = this._mesh;
        let m = null;
        try {
          const src = this.input && !this.input.disposed && this.input.manifold ? this.input.manifold : null;
          if (src && this.input._mesh?.index === index) {
            // same topology as the input solid: move its vertices (they come in the mesh's order; checked on a sample)
            const ref = this.input._mesh.positions;
            let ok = true;
            m = src.warpBatch((v, n) => {
              if (n * 3 !== positions.length) ok = false;
              for (let k = 0; k < 8 && ok; k++) {
                const i = Math.floor(((k + 0.5) * n) / 8) * 3;
                if (Math.abs(v[i] - ref[i]) + Math.abs(v[i + 1] - ref[i + 1]) + Math.abs(v[i + 2] - ref[i + 2]) > 1e-4) ok = false;
              }
              if (ok) v.set(positions.subarray(0, n * 3));
            });
            if (!ok) {
              m.delete();
              m = null;
            }
          }
          if (!m) m = Manifold.ofMesh(new wasm.Mesh({ numProp: 3, vertProperties: positions, triVerts: index }));
          if (m.status() !== 'NoError' || m.isEmpty() || m.volume() <= 0) {
            m.delete();
            m = null;
          }
        } catch {
          m = null;
        }
        this.manifold = m;
        this.failed = !m;
        if (!m) {
          // the preview already showed this stage; its stats now say that it could not be built into a solid
          if (Array.isArray(this.stats)) this.stats.forEach((st) => (st.failed = true));
          else if (this.stats) this.stats.failed = true;
        }
        return m;
      },
      dispose() {
        this.manifold?.delete();
        this.manifold = null;
        this.disposed = true;
      },
    };
    return stage;
  }

  /** The solid to build on: this stage's, or – when it could not be built – the nearest input that could. */
  function stageManifold(stage) {
    for (let s = stage; s; s = s.input) {
      const m = s.materialise();
      if (m) return m;
    }
    return null;
  }
  const currentManifold = () => (base?.current ? stageManifold(base.current.stage) : null);

  /** The original moved by the transforms, cached (the input of everything else). */
  const movedCache = new Map();
  function movedFor(original, matrix, key) {
    let stage = movedCache.get(key);
    if (!stage) {
      const mat = toMat4(matrix);
      const view = original.view;
      stage = makeStage({
        manifold: original.manifold ? original.manifold.transform(mat) : null,
        input: original,
        mesh: movedMesh(original.mesh, matrix),
        view: view ? movedMesh(view, matrix) : null,
      });
      movedCache.set(key, stage);
      trimCache(movedCache, cacheLimit(original, 2));
    }
    return stage;
  }

  /** The model simplified by a tolerance, cached: the user's simplification is redone only when the model or the tolerance changes. */
  const simplifyCache = new Map();
  function simplifiedFor(input, tolerance, key) {
    let stage = simplifyCache.get(key);
    if (!stage) {
      stage = makeStage({ manifold: input.materialise().simplify(tolerance), input });
      simplifyCache.set(key, stage);
      trimCache(simplifyCache, cacheLimit(input, 2));
    }
    return rebase(stage, input);
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
    base.original?.stage?.dispose();
    base = null;
    for (const cache of [movedCache, simplifyCache, enhanceCache, spotCache, coverCache]) trimCache(cache, 0);
  }

  /**
   * Clean-up spots applied to a mesh: each spot enhances only the part of the
   * mesh within its radius (cut out, enhanced with a soft-edged weight and a
   * larger movement allowance, written back). Returns the moved positions and,
   * when `collect` is given, pushes one stats record per spot into it.
   */
  function applySpots(mesh, spots, edgeAngle, collect, progress) {
    const positions = mesh.positions.slice();
    const { index } = mesh;
    spots.forEach((spot, n) => {
      progress?.('Cleaning up spots…', { done: n + 1, total: spots.length });
      const radius = Math.max(0.1, spot.radius ?? 8);
      const region = extractRegion(positions, index, spot.position, radius * 1.5);
      // a spot that floats away from the surface (further than the ring's reach) does nothing, like a floating text
      let nearest = Infinity;
      for (let i = 0; i < region.positions.length; i += 3) {
        const d = Math.hypot(region.positions[i] - spot.position[0], region.positions[i + 1] - spot.position[1], region.positions[i + 2] - spot.position[2]);
        if (d < nearest) nearest = d;
      }
      const detached = nearest > Math.min(5, radius);
      if (!isEnhanceActive(spot) || region.index.length < 12 || detached) {
        collect?.push({ id: spot.id, verticesMoved: 0, maxDisplacement: 0, empty: region.index.length < 12 || detached, detached });
        return;
      }
      const weights = regionWeights(region.positions, spot.position, radius, spot.feather ?? 0.5);
      // details inside a spot are sized to the spot: by default their size is taken as a third of its radius
      const out = enhanceMesh(region, {
        sharpen: spot.sharpen, smooth: spot.smooth, detail: spot.detail, deepen: spot.deepen, evenOut: spot.evenOut,
        featureSize: spot.featureSize > 0 ? spot.featureSize : radius / 3, maxMove: spot.maxMove, edgeAngle, capFactor: 1, weights,
      });
      for (let i = 0; i < region.vertexMap.length; i++) {
        const v = region.vertexMap[i];
        positions[v * 3] = out.positions[i * 3];
        positions[v * 3 + 1] = out.positions[i * 3 + 1];
        positions[v * 3 + 2] = out.positions[i * 3 + 2];
      }
      collect?.push({ id: spot.id, verticesMoved: out.stats.verticesMoved, maxDisplacement: out.stats.maxDisplacement, empty: false });
    });
    return positions;
  }

  /**
   * The stage with the clean-up spots applied to `input`, cached by settings.
   * The full-resolution mesh (what is exported) and, for a dense model, its
   * lighter display copy are both cleaned up, so the view follows every
   * tweak without simplifying the whole model again.
   */
  const spotCache = new Map();
  function spottedFor(input, spots, edgeAngle, key, progress) {
    let stage = spotCache.get(key);
    if (!stage) {
      const stats = [];
      let failed = false;
      let mesh = input.mesh;
      let view = input.view;
      try {
        mesh = { positions: applySpots(input.mesh, spots, edgeAngle, stats, progress), index: input.mesh.index };
        if (view) view = { positions: applySpots(view, spots, edgeAngle, null), index: view.index };
      } catch {
        failed = true;
      }
      stage = makeStage({ manifold: failed ? null : undefined, input, mesh, view, stats: stats.map((s) => ({ ...s, failed })), failed, keepNormals: false });
      spotCache.set(key, stage);
      trimCache(spotCache, cacheLimit(input, 4));
    }
    return rebase(stage, input);
  }

  /**
   * The stage with soft edges sharpened, bumps smoothed and relief boosted
   * (see enhance.js), cached by settings so comparing against the original
   * and nudging one slider back and forth do not redo the work.
   */
  const enhanceCache = new Map();
  function enhancedFor(input, enhance, key, progress) {
    let stage = enhanceCache.get(key);
    if (!stage) {
      const mesh = input.mesh;
      let out = null;
      try {
        out = enhanceMesh({ positions: mesh.positions, index: mesh.index }, enhance, (stage_, fraction) =>
          progress?.(`${stage_}…`, { done: Math.round(fraction * 100), total: 100 }),
        );
      } catch {
        out = null;
      }
      // only plain numbers travel to the main thread (the module also returns diagnostic fields)
      const st = out?.stats ?? {};
      const stats = {
        verticesMoved: st.verticesMoved ?? 0, maxDisplacement: st.maxDisplacement ?? 0, meanDisplacement: st.meanDisplacement ?? 0,
        flipsPrevented: st.flipsPrevented ?? 0, crossingsPrevented: st.crossingsPrevented ?? 0, featureEdges: st.featureEdges ?? 0, iterations: st.iterations ?? 0,
      };
      stage = out
        ? makeStage({ manifold: undefined, input, mesh: { positions: out.positions, index: mesh.index }, stats })
        : makeStage({ manifold: null, input, mesh, view: null, stats, failed: true });
      enhanceCache.set(key, stage);
      trimCache(enhanceCache, cacheLimit(input, 4));
    }
    return rebase(stage, input);
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

  /**
   * The cover solids (world frame) of the items that consume what they cover,
   * placed on the current (uncovered) model, with a note per item. Shared by
   * the displayed model and the final result so both cut the same thing.
   */
  function coverSolidsFor(items, temps) {
    const covers = [];
    const notes = [];
    const removed = []; // ids of the removing spots that really cut something
    for (const item of items) {
      if (isSpot(item)) {
        if (!item.remove) continue;
        const remover = removerSolidFor(item);
        if (!remover) continue;
        removed.push(item.id);
        covers.push(temps.add(temps.add(remover).transform(toMat4(placementMatrix(item)))));
        notes.push({ level: 'info', code: 'REMOVED', itemId: item.id, text: `${quote(item)} removes the detail under it, down to the surface it stands on.` });
        continue;
      }
      if (!item.cover || !hasText(item) || baseMode(item) === 'engrave' || !(isPart(item) || item.plate !== 'none')) continue;
      const placed = solidFor(item);
      if (placed.stats && placed.stats.touches === false) continue; // not on the model: nothing to consume
      const pegged = isPart(item) && placed.flat.pegged;
      const covering = placed.flat.body ? temps.add(placed.flat.body.translate(0, 0, placed.settle)) : placed.solid;
      const cbb = covering.boundingBox();
      const range = Math.max(50, cbb.max[2] - cbb.min[2] + COVER_PROTRUDE + 10);
      const surface = sampler(placed.placement, { searchAbove: range, searchBelow: range });
      const cover = surface ? coverSolidFor(covering, surface, { pegged }) : null;
      if (!cover) continue;
      covers.push(temps.add(temps.add(cover).transform(toMat4(placed.placement))));
      notes.push({ level: 'info', code: 'COVERED', itemId: item.id, text: `${quote(item)} covers what is under it: the model's details there were cut away so nothing pokes through.` });
    }
    return { covers, notes, removed };
  }

  /**
   * A quadric height field z(x, y) through the given vertices of `local` (xyz triples), fitted by least squares with
   * the outliers dropped once, or a plane when there are too few points for the curvature; null when there are too
   * few points for even that. `scale` keeps the fit well conditioned.
   */
  function fitHeightQuadric(local, points, scale) {
    const fit = (verts, terms) => {
      const n = terms === 6 ? 6 : 3;
      const A = Array.from({ length: n }, () => new Float64Array(n));
      const b = new Float64Array(n);
      const row = new Float64Array(n);
      for (const v of verts) {
        const x = local[v * 3] / scale, y = local[v * 3 + 1] / scale, z = local[v * 3 + 2];
        row[0] = 1;
        row[1] = x;
        row[2] = y;
        if (n === 6) {
          row[3] = x * x;
          row[4] = x * y;
          row[5] = y * y;
        }
        for (let i = 0; i < n; i++) {
          b[i] += row[i] * z;
          for (let j = 0; j < n; j++) A[i][j] += row[i] * row[j];
        }
      }
      const c = solveLinear(A, b);
      if (!c) return null;
      return (x, y) => {
        const u = x / scale, w = y / scale;
        return c[0] + c[1] * u + c[2] * w + (n === 6 ? c[3] * u * u + c[4] * u * w + c[5] * w * w : 0);
      };
    };
    const terms = points.length >= 24 ? 6 : points.length >= 8 ? 3 : 0;
    if (!terms) return null;
    const first = fit(points, terms);
    if (!first) return null;
    // the outliers (a neighbouring detail's foot, a stray vertex) dropped: more than three deviations from the fit
    const dev = points.map((v) => Math.abs(local[v * 3 + 2] - first(local[v * 3], local[v * 3 + 1])));
    const sorted = Float64Array.from(dev).sort();
    const cut = Math.max(0.02, 3 * 1.4826 * sorted[sorted.length >> 1]);
    const kept = points.filter((v, i) => dev[i] <= cut);
    return (kept.length >= (terms === 6 ? 24 : 8) && kept.length < points.length ? fit(kept, terms) : null) ?? first;
  }

  /**
   * What a removing spot cuts: within its radius, everything from the base
   * surface (the model smoothed at a scale larger than the detail, so the
   * detail is gone while the shape it stands on remains) up to where the
   * model is left again, within reach. Returns a solid in the spot's local
   * frame, or null.
   */
  function removerSolidFor(spot) {
    const stage = base.current?.stage;
    if (!stage || !base.current.geometry) return null;
    const radius = Math.max(0.5, spot.radius ?? 8);
    const mesh = stage.view ?? stage.mesh;
    const region = extractRegion(mesh.positions, mesh.index, spot.position, radius * 3);
    if (region.index.length < 12) return null;
    // the detail's vertices: those standing clearly above the region's smoothed base, within the spot. The surface the cut
    // goes down to is found in two steps: the detail is first spanned over with a membrane (its vertices relaxed with
    // everything else held in place), then that filled surface is smoothed again. Smoothing the original surface alone
    // would not do: it spreads the detail's bulk over its surroundings and so lies above the true surface under it.
    const { height, normals, topo } = baseSurface(region, { featureSize: 3 * radius, pinBorder: true });
    const { adjStart, adj } = topo;
    const V = region.positions.length / 3;
    let maxH = 0;
    for (let v = 0; v < V; v++) if (height[v] > maxH) maxH = height[v];
    // the clearly raised vertices seed the detail; it grows over everything a little raised, and on down the detail's
    // skirt while the height keeps falling, to where the surrounding surface begins, so no stub of its foot is left
    const d2Of = (v) => (region.positions[v * 3] - spot.position[0]) ** 2 + (region.positions[v * 3 + 1] - spot.position[1]) ** 2 + (region.positions[v * 3 + 2] - spot.position[2]) ** 2;
    const seedAbove = Math.max(0.05, 0.2 * maxH);
    const footAbove = Math.max(0.02, 0.04 * maxH);
    const descent = 0.005 * maxH;
    const reach2 = (1.2 * radius) ** 2;
    const foot2 = (1.5 * radius) ** 2;
    const free = new Uint8Array(V);
    const freeList = [];
    for (let v = 0; v < V; v++) {
      if (height[v] > seedAbove && d2Of(v) <= reach2) {
        free[v] = 1;
        freeList.push(v);
      }
    }
    for (let i = 0; i < freeList.length; i++) {
      const v = freeList[i];
      for (let k = adjStart[v]; k < adjStart[v + 1]; k++) {
        const o = adj[k];
        if (free[o] || d2Of(o) > foot2) continue;
        if (height[o] <= footAbove && height[o] >= height[v] - descent) continue;
        free[o] = 1;
        freeList.push(o);
      }
    }
    if (!freeList.length) return null;
    // the surface the cut goes down to, as a height field in the spot's frame (z along its normal): a quadric fitted
    // through the unraised surface around the detail carries the curvature of what it stands on (a membrane simply
    // spanned across the detail's foot would sag below a curved surface), and a membrane over the residuals – the
    // freed vertices relaxed to the mean of their neighbours (successive over-relaxation, in place) until they
    // settle, the surroundings holding them – follows the irregularities of the real surface
    const placement = placementMatrix(spot);
    const inverse = placement.clone().invert();
    const local = new Float64Array(V * 3);
    const lv = new Vector3();
    for (let v = 0; v < V; v++) {
      lv.set(region.positions[v * 3], region.positions[v * 3 + 1], region.positions[v * 3 + 2]).applyMatrix4(inverse);
      local[v * 3] = lv.x;
      local[v * 3 + 1] = lv.y;
      local[v * 3 + 2] = lv.z;
    }
    // the surroundings: the surface connected to the detail, out to a third again of the detail's reach (a quadric
    // follows a curved surface closely only over a modest span), not raised, facing the spot's way
    let freeReach2 = 0;
    for (const v of freeList) freeReach2 = Math.max(freeReach2, local[v * 3] ** 2 + local[v * 3 + 1] ** 2);
    const band2 = Math.max((1.2 * radius) ** 2, 1.35 ** 2 * freeReach2);
    const inBand = (v) => local[v * 3] ** 2 + local[v * 3 + 1] ** 2 <= band2;
    const seen = new Uint8Array(V);
    const around = [];
    const grow = (v) => {
      for (let k = adjStart[v]; k < adjStart[v + 1]; k++) {
        const o = adj[k];
        if (free[o] || seen[o] || !inBand(o)) continue;
        seen[o] = 1;
        around.push(o);
      }
    };
    for (const v of freeList) grow(v);
    for (let i = 0; i < around.length; i++) grow(around[i]);
    const facing = (v) => normals[v * 3] * spot.normal[0] + normals[v * 3 + 1] * spot.normal[1] + normals[v * 3 + 2] * spot.normal[2] > 0.2;
    let points = around.filter((v) => height[v] <= footAbove && facing(v));
    const quadric = fitHeightQuadric(local, points, radius) ?? fitHeightQuadric(local, around.filter(facing), radius);
    if (!quadric) return null;
    const rho = new Float64Array(V);
    for (let v = 0; v < V; v++) if (!free[v]) rho[v] = local[v * 3 + 2] - quadric(local[v * 3], local[v * 3 + 1]);
    const tolerance = 1e-4 * radius;
    const omega = 1.7;
    for (let pass = 0; pass < 20_000; pass++) {
      let moved = 0;
      for (const v of freeList) {
        const s = adjStart[v], e = adjStart[v + 1];
        if (e === s) continue;
        let m = 0;
        for (let k = s; k < e; k++) m += rho[adj[k]];
        const d = omega * (m / (e - s) - rho[v]);
        rho[v] += d;
        if (Math.abs(d) > moved) moved = Math.abs(d);
      }
      if (moved < tolerance) break;
    }
    const basePositions = Float64Array.from(region.positions);
    for (const v of freeList) {
      lv.set(local[v * 3], local[v * 3 + 1], quadric(local[v * 3], local[v * 3 + 1]) + rho[v]).applyMatrix4(placement);
      basePositions[v * 3] = lv.x;
      basePositions[v * 3 + 1] = lv.y;
      basePositions[v * 3 + 2] = lv.z;
    }
    const baseGeometry = new BufferGeometry();
    baseGeometry.setAttribute('position', new Float32BufferAttribute(Float32Array.from(basePositions), 3));
    baseGeometry.setIndex(new Uint32BufferAttribute(region.index, 1));
    const range = Math.max(50, 4 * radius + 10);
    const baseSampler = createSurfaceSampler(baseGeometry, placement, { searchAbove: range, searchBelow: range });
    const surface = sampler(placement, { searchAbove: range, searchBelow: range });
    if (!surface) return null;
    const cell = Math.min(1, Math.max(0.25, radius / 30));
    const nx = Math.ceil((2 * radius) / cell) + 2;
    const ny = nx;
    const x0 = -radius - cell;
    const y0 = -radius - cell;
    const W = nx + 1;
    const bottom = new Float64Array(W * (ny + 1)).fill(NaN);
    const top = new Float64Array(W * (ny + 1)).fill(NaN);
    const exit = new Float64Array(W * (ny + 1)).fill(NaN);
    const budget = 2 * radius + COVER_PROTRUDE;
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const x = x0 + i * cell;
        const y = y0 + j * cell;
        if (x * x + y * y > radius * radius) continue;
        const b0 = baseSampler.heightAt(x, y);
        if (!Number.isFinite(b0)) continue;
        const z0 = b0 + 0.05; // a hair above the spanned surface, so the cut floor is that surface
        const k = j * W + i;
        bottom[k] = z0;
        for (const c of surface.crossingsAt(x, y)) {
          if (c.z <= z0) continue;
          if (c.z - z0 > budget) break;
          if (c.exit) exit[k] = c.z;
        }
      }
    }
    baseSampler.dispose();
    // as for a cover: the cut's top takes the highest exit around each node, so the detail's steep flank between
    // grid nodes is removed too instead of being left as floating slivers
    let consumed = false;
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const k = j * W + i;
        if (!Number.isFinite(bottom[k])) continue;
        top[k] = bottom[k] + 0.01;
        let high = NaN;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii > nx || jj > ny) continue;
            const e = exit[jj * W + ii];
            if (Number.isFinite(e) && !(high >= e)) high = e;
          }
        }
        if (Number.isFinite(high) && high > bottom[k]) {
          top[k] = high + COVER_EPSILON;
          consumed = true;
        }
      }
    }
    if (!consumed) return null;
    const slab = heightFieldSlab({ x0, y0, cell, nx, ny, bottom, top });
    if (!slab) return null;
    try {
      const m = Manifold.ofMesh(new wasm.Mesh({ numProp: 3, vertProperties: slab.vertProperties, triVerts: slab.triVerts }));
      if (m.status() !== 'NoError' || m.isEmpty()) {
        m.delete();
        return null;
      }
      return m;
    } catch {
      return null;
    }
  }

  /** The model with the covering items' cuts applied, cached by what covers it: a stage for display. */
  const coverCache = new Map();
  function coveredFor(stage, covers, stageKey) {
    const key = `${stageKey}|covers:${covers.map((i) => `${shapeKey(i, fontKeyOf(i))}|${placeKey(i)}|${i.sink}|${i.fit === false ? 0 : 1}`).sort().join(';')}`;
    let entry = coverCache.get(key);
    if (!entry) {
      const temps = scope();
      try {
        const { covers: solids, removed } = coverSolidsFor(covers, temps);
        const model = stageManifold(stage);
        if (!solids.length || !model) {
          entry = { stage: null, count: 0, removed };
        } else {
          const carved = Manifold.difference(model, temps.add(Manifold.union(solids)));
          entry = { stage: makeStage({ manifold: carved, input: stage }), count: solids.length, removed };
        }
      } finally {
        temps.dispose();
      }
      coverCache.set(key, entry);
      trimCache(coverCache, 2);
    }
    return entry;
  }

  /**
   * (Re)build the displayed model from the original + transforms + simplify
   * + enhancement + clean-up spots. Every stage is cached by its settings
   * (see makeStage), so a change to one setting redoes only that stage, and
   * the view is refit rather than rebuilt when only vertices moved.
   */
  function deriveCurrent(progress) {
    disposeCurrent();
    clearDerived();
    const { original, transforms, simplify, enhance, spots, covers } = base;
    const matrix = composeTransforms(transforms);
    const transformsKey = JSON.stringify(transforms);
    const watertight = !!original.manifold;
    let stage = transforms.length ? movedFor(original.stage, matrix, transformsKey) : original.stage;
    if (watertight && simplify > 0) {
      progress?.('Simplifying…');
      stage = simplifiedFor(stage, simplify, `${transformsKey}|${simplify}`);
    }
    let enhanced = null; // { ...stats, failed }
    if (watertight && isEnhanceActive(enhance)) {
      progress?.('Enhancing…');
      const out = enhancedFor(stage, enhance, `${transformsKey}|${simplify}|${JSON.stringify(enhance)}`, progress);
      enhanced = { ...out.stats, failed: out.failed };
      if (!out.failed) stage = out;
    }
    let spotStats = null;
    if (watertight && spots?.length) {
      progress?.('Cleaning up spots…');
      const out = spottedFor(stage, spots, enhance?.edgeAngle ?? 30, `${transformsKey}|${simplify}|${JSON.stringify(enhance)}|${JSON.stringify(spots)}`, progress);
      spotStats = out.stats;
      if (!out.failed) stage = out;
    }
    const passthrough = transformSoup(original.passthrough, matrix);
    progress?.('Preparing the view…');
    const view = stage.view;
    let built = views.build(view ?? stage.mesh, { normals: stage.normals, passthrough });
    if (stage.keepNormals) stage.normals = built.normals;
    base.current = {
      stage, // what results and downloads build on; covering items cut it there as well
      watertight,
      passthrough,
      geometry: built.geometry, // the surface items are placed on: the model before any covering cut
      bounds: built.bounds,
      shellVolumes: null, // filled lazily: volumes of the model's own shells
      spotStats,
    };
    // items that consume what they cover are shown doing so: the view is the model with their cuts applied
    let covered = 0;
    if (watertight && covers?.length) {
      progress?.('Clearing under the parts…');
      const shown = coveredFor(stage, covers, `${transformsKey}|${simplify}|${JSON.stringify(enhance)}|${JSON.stringify(spots)}`);
      base.current.removed = shown?.removed ?? [];
      if (shown?.stage) {
        covered = shown.count;
        built = views.build(shown.stage.view ?? shown.stage.mesh, { normals: shown.stage.normals, passthrough });
        shown.stage.normals = built.normals;
        base.current.bounds = built.bounds;
        base.current.cutGeometry = built.geometry; // the surface after the cuts: what everything else is placed on
      }
    }
    const triangles = built.display.index.length / 3;
    const size = built.bounds ? [0, 1, 2].map((k) => built.bounds.max[k] - built.bounds.min[k]) : [0, 0, 0];
    const info = {
      name: base.name,
      kind: base.kind,
      version: base.version,
      size,
      bounds: built.bounds,
      triangles: stage.mesh.index.length / 3 + passthrough.length / 9,
      displayTriangles: triangles,
      simplifiedView: !!view,
      originalTriangles: original.inputTriangles,
      watertight,
      repaired: !!original.report?.repaired,
      passthroughTriangles: passthrough.length / 9,
      hasModel: base.kind !== 'none',
      enhanced,
      spots: spotStats,
      covered,
      suggestions: base.kind === 'stl' && transforms.length === 0 && !simplify && !enhanced ? modelSuggestions({ size, triangles: stage.mesh.index.length / 3 + passthrough.length / 9 }) : [],
    };
    return {
      message: { info, report: base.original.report, display: built.display },
      transfer: built.transfer,
    };
  }

  function loadBase({ kind, bytes, name = 'model', version, transforms = [], simplify = null, enhance = null, spots = [], covers = [] }, progress) {
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
      // a parsed STL is already a plain triangle soup: use its positions as they are rather than copying them
      const pos = geometry.attributes.position.array;
      const soup = !geometry.index && pos instanceof Float32Array ? pos : triangleSoup(geometry);
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
    original.stage = makeStage({ manifold: original.manifold });
    base = { version, kind, name, original, transforms, simplify, enhance, spots, covers };
    return deriveCurrent(progress);
  }

  function updateBase({ version, transforms = [], simplify = null, enhance = null, spots = [], covers = [] }, progress) {
    if (!base?.original) fail('BASE_MISSING', 'The model is not loaded in the engine', { version });
    base.version = version;
    base.transforms = transforms;
    base.simplify = simplify;
    base.enhance = enhance;
    base.spots = spots;
    base.covers = covers;
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
    const cuttable = !noModel && !!base?.current?.watertight;
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
    entry = isSpot(item) ? spotSolidFor(item) : isPart(item) ? partSolidFor(item) : textSolidFor(item);
    flat.set(key, entry);
    return entry;
  }

  /** A clean-up spot's marker: a thin ring of its radius, shown hugging the surface. */
  function spotSolidFor(item) {
    const r = Math.max(0.5, item.radius ?? 8);
    const temps = scope();
    try {
      const outer = temps.add(wasm.CrossSection.circle(r, 96));
      const inner = temps.add(wasm.CrossSection.circle(r * 0.9, 96));
      const ring = temps.add(outer.subtract(inner));
      const raw = temps.add(Manifold.extrude(ring, 0.3));
      return { solid: raw.translate(0, 0, -0.1), cutter: null, size: [2 * r, 2 * r], rounding: null, spot: true };
    } finally {
      temps.dispose();
    }
  }

  /**
   * The outline of a text item and of its plate (null without one), curved as asked, and the size of the shape
   * before it was curved. Everything returned is owned by `temps`.
   */
  function textOutlineFor(item, temps) {
    const info = buildCrossSectionInfo(linesWithFonts(item), { ...item, perLine: !!item.curve });
    for (const l of info.lines ?? []) temps.add(l.cs);
    if (!info.cs) return { cs: null, outline: null, curve: null, rounding: info.rounding };
    let cs = temps.add(info.cs);
    const { min, max } = cs.bounds();
    const pad = Math.max(0, item.platePadding ?? 3);
    let outline = item.plate && item.plate !== 'none' ? temps.add(plateShape(wasm, item.plate, max[0] - min[0] + 2 * pad, max[1] - min[1] + 2 * pad)) : null;
    const ub = (outline ?? cs).bounds();
    const unbent = [ub.max[0] - ub.min[0], ub.max[1] - ub.min[1]];
    // a curved line of text: every line bent round its own arc, the plate with them, then centred again
    let curve = null;
    const bent = item.curve ? curveText(info, item.curve, { plate: outline }) : null;
    if (bent) {
      cs = temps.add(bent.cs);
      if (bent.plate) outline = temps.add(bent.plate);
      curve = { requested: bent.bend.requested, applied: bent.bend.degrees, limited: bent.bend.limited, plated: !!outline };
    }
    return { cs, outline, curve, unbent, rounding: info.rounding };
  }

  function textSolidFor(item) {
    const temps = scope();
    try {
      const { cs, outline, curve, unbent, rounding } = textOutlineFor(item, temps);
      if (!cs) fail('FONT_NO_OUTLINES', 'The font has no outlines for those characters.');
      const tb = cs.bounds();
      let size = [tb.max[0] - tb.min[0], tb.max[1] - tb.min[1]];
      let solid;
      const plated = !!outline;
      if (plated) {
        // text on a plaque or banner: the plate is what meets the model
        const thickness = Math.max(0.2, item.plateThickness ?? 2);
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
      // a curved shape is conformed at the scale of its letters (or plate), not of the arc's box
      return { solid, size, rounding, curve, scale: curve ? Math.min(...unbent) : undefined, cutter: null };
    } finally {
      temps.dispose();
    }
  }

  /**
   * An attached part in its local frame: the chosen side faces the model
   * (contact plane z = 0), scaled, turned (tilt about X, roll about Y; spin
   * about Z happens in the placement) and re-seated so its lowest point is
   * on the plane under the clicked point, sunk into the surface, with its join:
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
      const turned = !!(item.tilt || item.roll);
      if (turned) m = seat(temps.add(m.rotate([item.tilt || 0, item.roll || 0, 0]))); // whatever is lowest now rests on the surface
      const sink = Math.max(0, item.sink ?? 0);
      const bb = m.boundingBox();
      const top = bb.max[2]; // height above the contact plane
      const eps = Math.min(0.05, top / 10);
      const footprint = temps.add(m.slice(eps)); // section at the contact plane
      const fb = footprint.isEmpty() ? bb : footprint.bounds();
      const size = [fb.max[0] - fb.min[0], fb.max[1] - fb.min[1]];
      const cutter_ = item.mode === 'engrave';
      const join = cutter_ ? 'fuse' : item.join; // a cutter has no connection to make
      const extent = (bb.max[0] - bb.min[0]) * (bb.max[1] - bb.min[1]);
      const contact = footprint.isEmpty() ? 0 : footprint.area();
      if (turned && contact < 0.2 * extent) {
        warnings.push({
          level: 'warn',
          code: 'EDGE_CONTACT',
          text: 'After turning, only an edge of the part meets the surface. Sink it deeper or use "Fused + fillet" so it fuses firmly.',
        });
      }
      let solid;
      let cutter = null;
      let body = null;
      let cut = { mode: cutter_ ? 'engrave' : 'emboss', depth: sink };
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
          const disc = temps.add(temps.add(wasm.CrossSection.circle(radius, 32)).translate(x, y));
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
          body = m.translate(0, 0, 0); // the part without its pegs: what it covers (the pegs go into holes, not through details)
          cutter = Manifold.union(holes);
          cut = { mode: 'engrave', depth: length + clearance };
        } else {
          solid = m.translate(0, 0, -sink);
        }
      } else {
        solid = m.translate(0, 0, -sink);
      }
      return { solid, cutter, body, size, rounding: null, cut, warnings, part: { name: part.info.name, triangles: part.info.triangles }, pegged: !!cutter };
    } finally {
      temps.dispose();
    }
  }

  /**
   * The volume an item "covers": for every column of the item's footprint,
   * from just inside its underside up to where the model is first left
   * again – so a detail that would poke through the item is cut away, but
   * only a detail: a column where the model goes on for more than
   * COVER_PROTRUDE beyond the item's top (a cane rising through a plate, the
   * far wall of a tube) is left alone, as is a column where the item hovers
   * over air. A thin skin of the model (COVER_SKIN, never more than half the
   * item's thickness there) is left inside the item so the two still overlap
   * and fuse; a separately printed (pegged) part gets a hair of clearance
   * instead. Returns a solid in the item's local frame, or null.
   * @param {import('manifold-3d').Manifold} solid  the item as placed (local frame)
   * @param {{ crossingsAt(x: number, y: number): number[] }} surface  the model sampler in the same frame
   */
  const COVER_SKIN = 0.2;
  const COVER_PROTRUDE = 5; // mm a detail may stand proud of the item and still be consumed
  const COVER_EPSILON = 0.3; // how far above a detail's top the cut reaches (air there): covers the sag of the grid between nodes
  function coverSolidFor(solid, surface, { pegged = false } = {}) {
    const bb = solid.boundingBox();
    const thickness = bb.max[2] - bb.min[2];
    const width = bb.max[0] - bb.min[0];
    const depth = bb.max[1] - bb.min[1];
    if (!(thickness > 0 && width > 0 && depth > 0)) return null;
    let cell = Math.min(1, Math.max(0.25, Math.min(width, depth) / 60));
    cell = Math.max(cell, width / 200, depth / 200);
    const x0 = bb.min[0] - cell;
    const y0 = bb.min[1] - cell;
    const nx = Math.ceil((width + 2 * cell) / cell);
    const ny = Math.ceil((depth + 2 * cell) / cell);
    const under = createUndersideSampler(solid);
    const W = nx + 1;
    const bottom = new Float64Array(W * (ny + 1)).fill(NaN);
    const top = new Float64Array(W * (ny + 1)).fill(NaN);
    const exit = new Float64Array(W * (ny + 1)).fill(NaN); // where the model is left again above the column's start
    const blocked = new Uint8Array(W * (ny + 1)); // the column starts inside something that goes on beyond reach
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const x = x0 + i * cell;
        const y = y0 + j * cell;
        const u = under.heightAt(x, y);
        if (!Number.isFinite(u)) continue;
        const t = under.topAt(x, y);
        const local = Number.isFinite(t) ? Math.max(0, t - u) : thickness;
        const skin = pegged ? -0.05 : Math.min(COVER_SKIN, local / 2);
        const z0 = u + skin;
        const k = j * W + i;
        bottom[k] = z0;
        // cut up to the highest point within reach where the model is left again: a detail sitting on the surface
        // under the item (even one that overhangs a little, like a berry) is removed whole, while a structure that
        // goes on beyond reach (a cane through a plate, the far wall of a tube) is not touched
        const budget = local + COVER_PROTRUDE;
        let inside = false;
        let first = true;
        for (const c of surface.crossingsAt(x, y)) {
          if (c.z <= z0) continue;
          if (first) {
            inside = c.exit; // the next surface above us is where the solid ends: we are inside it
            first = false;
          }
          if (c.z - z0 > budget) break;
          if (c.exit) exit[k] = c.z;
        }
        if (inside && !Number.isFinite(exit[k])) blocked[k] = 1;
      }
    }
    // the cut's top takes the highest exit around each node, so a detail's steep flanks between grid nodes are
    // covered too; a column inside a structure that goes on beyond reach keeps a hair-thin cut inside the item
    let consumed = false;
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const k = j * W + i;
        if (!Number.isFinite(bottom[k])) continue;
        top[k] = bottom[k] + 0.01;
        if (blocked[k]) continue;
        let high = NaN;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii > nx || jj > ny) continue;
            const e = exit[jj * W + ii];
            if (Number.isFinite(e) && !(high >= e)) high = e;
          }
        }
        if (Number.isFinite(high) && high > bottom[k]) {
          top[k] = high + COVER_EPSILON;
          consumed = true;
        }
      }
    }
    if (!consumed) return null;
    const mesh = heightFieldSlab({ x0, y0, cell, nx, ny, bottom, top });
    if (!mesh) return null;
    let cover = null;
    try {
      cover = Manifold.ofMesh(new wasm.Mesh({ numProp: 3, vertProperties: mesh.vertProperties, triVerts: mesh.triVerts }));
      if (cover.status() !== 'NoError' || cover.isEmpty()) {
        cover.delete();
        cover = null;
      }
    } catch {
      cover = null;
    }
    return cover;
  }

  /** Printability report for an item's outline, per nozzle setting (small cache). */
  const strokeCache = new Map();
  function strokeFor(item, printing) {
    const limits = printLimits({ nozzle: printing?.nozzle ?? 0.4, mode: item.mode });
    const key = `${shapeKey(item, fontKeyOf(item))}|${limits.minStroke}|${limits.minGap}`;
    if (strokeCache.has(key)) return strokeCache.get(key);
    // judged on the outline as built: a curve squeezes the inside of the bend
    let stroke = null;
    const temps = scope();
    try {
      const { cs } = textOutlineFor(item, temps);
      if (cs) stroke = thinStrokeReport(cs, limits);
    } finally {
      temps.dispose();
    }
    const report = { stroke, limits };
    strokeCache.set(key, report);
    if (strokeCache.size > 64) strokeCache.delete(strokeCache.keys().next().value);
    return report;
  }

  /**
   * A sampler of the model's surface in an item's frame. Items are placed on the model after the cuts of covering
   * items and removing spots (`cut`), so a decoration goes where a detail was cut away; a covering item itself is
   * placed on the uncut surface, so its own cut does not move it.
   */
  function sampler(placement, options, { cut = false } = {}) {
    const current = base.current;
    const geometry = (cut && current?.cutGeometry) || current?.geometry;
    if (!geometry || !geometry.index?.count) return null;
    return createSurfaceSampler(geometry, placement, options);
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
    let settle = 0; // how far a rigid part was lowered to meet the surface (local z, ≤ 0)
    const wantsStats = base.kind !== 'none';
    // a part may be pulled down by as much as its own height, so the surface search reaches at least that far; under
    // a wide text or plate the surface may bend away by as much as the item is wide
    const fbb = flatEntry.solid.boundingBox();
    const partReach = isPart(item) ? Math.max(50, fbb.max[2] - fbb.min[2] + 1) : Math.max(50, fbb.max[0] - fbb.min[0], fbb.max[1] - fbb.min[1]);
    const covering = isPart(item) ? !!item.cover : item.cover && item.mode !== 'engrave' && item.plate !== 'none';
    const s = wantsStats && (item.conform || isPart(item)) ? sampler(placement, { searchAbove: partReach, searchBelow: partReach }, { cut: !covering }) : null;
    // text follows curved surfaces when asked; so does a generated decoration (a leaf or sprig draped over a horn),
    // never a rigid imported part
    if (s && item.conform && (!isPart(item) || parts.get(item.partId)?.info?.generated)) {
      const out = conformSolid(flatEntry.solid, s, { scale: flatEntry.scale });
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
          const out = conformSolid(slab, s, { wrap: false }); // a rigid part rests on the surface straight below it
          stats = { ...out.stats, conformed: false };
          out.solid.delete();
          slab.delete();
        }
        foot.delete();
        // a rigid part rests on the surface: when the highest point of the surface under its foot lies below the
        // contact plane (a curved or sloping surface, a click that landed a little high) the part comes down to it,
        // so that it really overlaps the model by its sink instead of hovering with an air gap
        let drop = 0;
        if (isPart(item) && stats?.touches && Number.isFinite(stats.maxHeight) && stats.maxHeight < -1e-6) drop = -stats.maxHeight;
        // ... and with "fit to surface" it comes down further, until its body meets the model: a scroll attached by
        // its hollow side, or a plate across a curved surface, would otherwise touch at a point and hover elsewhere
        // (a tilted or rolled part leans on purpose: it keeps resting on its lowest edge)
        if (isPart(item) && item.fit !== false && !(item.tilt || item.roll)) {
          flatEntry.underside ??= createUndersideSampler(flatEntry.solid);
          const fit = fitDepth(flatEntry.underside, s);
          const tall = flatEntry.solid.boundingBox().max[2] - flatEntry.solid.boundingBox().min[2];
          // the part meets the surface when it comes down to it, or already touches it no deeper than its own height
          // (a part buried deeper than that is not "touching": it would just vanish inside the model)
          if (fit.reachable && fit.cells > 0 && (fit.lower > 0 || fit.firstContact >= -tall)) {
            drop = Math.max(drop, fit.lower + fit.push);
            if (!stats) stats = { conformed: false };
            stats.touches = true; // its body reaches the surface even where its foot found none
            stats.lowered = fit.lower;
            stats.pushed = Math.max(0, drop - fit.lower);
          }
        }
        if (drop > 1e-6) {
          settle = -drop;
          solid.delete();
          solid = flatEntry.solid.translate(0, 0, settle);
          stats.settled = drop;
          stats.lowered ??= drop;
          stats.pushed ??= 0;
        }
      }
    }
    entry = { solid, stats, settle };
    conformed.set(key, entry);
    return { ...entry, flat: flatEntry, placement };
  }

  /** Placement notes reworded for a rigid part (the conform notes speak of text). */
  function partWording(notes) {
    const out = [];
    for (const n of notes) {
      if (n.code === 'TOO_CURVED' || n.code === 'CROSSES_EDGE') continue; // about warping text: a part is not warped
      if (n.code === 'NOT_TOUCHING') out.push({ ...n, text: "This part isn't touching the model. Click the model to place it, or use Snap to model." });
      else if (n.code === 'OVERHANG') out.push({ ...n, text: 'Part of the part reaches past the edge of the surface it sits on.' });
      else out.push(n);
    }
    return out;
  }

  /** Human notes about one item (printability, placement). */
  function notesFor(item, { flat: flatEntry, stats }, printing = {}) {
    const notes = [];
    const nozzle = printing.nozzle ?? 0.4;
    const layer = printing.layerHeight ?? 0.2;
    if (isSpot(item)) {
      if (stats && stats.touches === false && base?.kind !== 'none') {
        notes.push({ level: 'warn', code: 'NOT_TOUCHING', text: "The spot isn't on the model. Click the model to place it." });
        return notes;
      }
      if (base?.kind === 'none') {
        notes.push({ level: 'info', code: 'SPOT', text: 'Load a model for the spot to work on.' });
        return notes;
      }
      if (item.remove) {
        if (!base?.current?.watertight) {
          notes.push({ level: 'warn', code: 'SPOT_UNAVAILABLE', text: "This model couldn't be made watertight, so nothing can be cut from it." });
        } else if (base.current.removed && !base.current.removed.includes(item.id)) {
          notes.push({ level: 'warn', code: 'REMOVE_EMPTY', text: 'Nothing stands above the surface inside this spot – move it onto the detail or make it larger.' });
        } else {
          notes.push({ level: 'ok', code: 'SPOT', text: 'Removes the detail under it, down to the surface it stands on. The model is shown and downloaded without it.' });
        }
        return notes;
      }
      if (!isEnhanceActive(item)) {
        notes.push({ level: 'info', code: 'SPOT', text: 'All amounts are 0, so this spot changes nothing yet.' });
        return notes;
      }
      if (!base?.current?.watertight) {
        notes.push({ level: 'warn', code: 'SPOT_UNAVAILABLE', text: "This model couldn't be made watertight, so clean-up spots can't change it." });
        return notes;
      }
      const st = base?.current?.spotStats?.find((s) => s.id === item.id);
      if (st?.detached) {
        notes.push({ level: 'warn', code: 'NOT_TOUCHING', text: "The spot isn't on the model. Click the model to place it." });
        return notes;
      }
      if (!st || st.empty) {
        notes.push({ level: 'warn', code: 'SPOT_EMPTY', text: 'No model surface inside this spot – move it onto the model or make it larger.' });
      } else if (st.failed) {
        notes.push({ level: 'warn', code: 'SPOT_FAILED', text: 'This clean-up would break the model; try smaller amounts or a smaller max move.' });
      } else {
        notes.push({ level: 'ok', code: 'SPOT', text: `Moved ${st.verticesMoved.toLocaleString()} points inside the spot, up to ${st.maxDisplacement.toFixed(2)} mm.` });
      }
      return notes;
    }
    const meets = baseMode(item);
    if (meets === 'engrave' && base?.kind !== 'none' && !base?.current?.watertight) {
      notes.push({
        level: 'warn',
        code: 'ENGRAVE_UNAVAILABLE',
        text: "This model couldn't be made watertight, so text can only be raised on it, not cut in.",
      });
    }
    if (stats) {
      const cut = isPart(item) ? flatEntry.cut : { mode: meets, depth: item.plate !== 'none' ? item.plateThickness : item.depth };
      const raw_ = conformNotes(stats, { mode: cut.mode, depth: cut.depth, overlap: item.overlap, nozzle });
      // a rigid part is never warped, so notes about stretching letters do not apply, and the others speak of a part
      notes.push(...(isPart(item) ? partWording(raw_) : raw_));
    }
    if (isPart(item)) {
      notes.push(...(flatEntry.warnings ?? []));
      if (stats?.settled > 0.05) {
        const lowered = stats.lowered ?? stats.settled;
        const pushed = stats.pushed ?? 0;
        notes.push({
          level: 'info',
          code: 'SETTLED',
          text:
            pushed > 0.05 && lowered > 0.05
              ? `Lowered the part ${lowered.toFixed(1)} mm onto the surface and pushed it ${pushed.toFixed(1)} mm in so its body meets the model.`
              : pushed > 0.05
                ? `Pushed the part ${pushed.toFixed(1)} mm into the surface so its body meets the model, not just its nearest point.`
                : `Lowered the part ${lowered.toFixed(1)} mm so it rests on the surface here.`,
        });
      }
      if (base?.kind !== 'none' && !base?.current?.watertight && item.mode !== 'engrave') {
        notes.push({
          level: 'warn',
          code: 'FUSE_UNAVAILABLE',
          text: 'This model has gaps that could not be closed, so the part is placed over it but cannot be merged into one solid. Most slicers still print overlapping pieces as one.',
        });
      }
      if (item.mode !== 'engrave' && item.join === 'pegs') {
        if (base?.kind !== 'none' && !base?.current?.watertight) {
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
    if (flatEntry.curve?.limited) {
      const { requested, applied, limited, plated } = flatEntry.curve;
      const built = Math.abs(Math.round(applied));
      notes.push({
        level: 'info',
        code: 'CURVE_LIMITED',
        text:
          limited === 'ends'
            ? `${Math.abs(requested)}° of curve would bring the ends of the ${plated ? 'plate' : 'text'} round to meet, so it is curved ${built}°.`
            : `This text is too short for ${Math.abs(requested)}° of curve – the inside of the bend would fold – so it is curved ${built}°. More letters, wider letter spacing${plated ? ', less plate padding' : ''} or fewer lines let it curve further.`,
        applied: Math.round(applied),
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

  /** Inside tests per model geometry (the surface after the cuts, or the model). */
  const insideTests = new WeakMap();

  /**
   * The pieces of an item's solid (its letters) that reach into the model: { solid, off } with `off` the number that
   * do not, or null when the item is one piece or none of it reaches the model (the item as a whole is then judged).
   * A letter reaches the model when any of its vertices – its base sinks in by the overlap – lies inside it.
   */
  function lettersOnModel(world, temps) {
    const pieces = world.decompose();
    if (pieces.length < 2) {
      pieces.forEach((p) => p.delete());
      return null;
    }
    const geometry = base.current.cutGeometry ?? base.current.geometry;
    let inside = insideTests.get(geometry);
    if (!inside) {
      inside = createInsideTest(geometry);
      insideTests.set(geometry, inside);
    }
    if (!inside) {
      pieces.forEach((p) => p.delete());
      return null;
    }
    const on = [];
    let off = 0;
    for (const piece of pieces) {
      const v = piece.getMesh().vertProperties;
      const count = v.length / 3;
      const stride = Math.max(1, Math.floor(count / 64));
      let reaches = false;
      for (let i = 0; i < count && !reaches; i += stride) reaches = inside([v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]);
      if (reaches) on.push(piece);
      else {
        off++;
        piece.delete();
      }
    }
    if (!off || !on.length) {
      on.forEach((p) => p.delete());
      return null;
    }
    const solid = temps.add(Manifold.compose(on));
    on.forEach((p) => p.delete());
    return { solid, off };
  }

  /** The items that make the final result (spots change the model itself, not what is added to it), and its cache key. */
  function finalKey(items, baseVersion) {
    const active = items.filter((i) => hasText(i) && !isSpot(i));
    requireFonts(active.filter((i) => !isPart(i)));
    requireParts(active);
    return { active, key: `${baseVersion}|${active.map((i) => `${shapeKey(i, fontKeyOf(i))}|${placeKey(i)}|${i.cover ? 'cover' : ''}`).sort().join(';')}` };
  }

  /** union(base, raised) − union(cut); cached for the same inputs. */
  function finalFor(items, baseVersion, printing, progress) {
    const b = baseFor(baseVersion);
    const { active, key } = finalKey(items, baseVersion);
    if (result?.key === key) return result;

    progress?.('Preparing the model…');
    const model = currentManifold(); // built now if the shown stage never needed its solid before
    const notes = [];
    for (let s = b.current.stage; s; s = s.input) {
      if (s.failed && s.stats) {
        notes.push({ level: 'warn', code: 'STAGE_FAILED', text: 'Part of the enhancement shown could not be applied to the exported solid, which is exported without it.' });
        break;
      }
    }
    const skipped = [];
    const emboss = [];
    const engrave = [];
    const separate = []; // parts joined with pegs: printed on their own
    const raised = []; // raised items and their world solids, to check that each really merged
    const itemBounds = []; // where each item ended up (plain), for splitting: which cuts run through text
    const temps = scope();
    try {
      // what covering items consume, and what removing spots cut, is taken from the model before anything is added
      const cutting = items.filter((i) => (isSpot(i) ? !!i.remove : active.includes(i)));
      const { covers, notes: coverNotes } = model ? coverSolidsFor(cutting, temps) : { covers: [], notes: [] };
      notes.push(...coverNotes);
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
        if (needsCut && !model) {
          skipped.push(item.id);
          notes.push({
            level: 'warn',
            code: 'ENGRAVE_UNAVAILABLE',
            itemId: item.id,
            text: `${quote(item)} needs to cut into the model, which needs a watertight model, so it was left out.`,
          });
          return;
        }
        let world = temps.add(placed.solid.transform(toMat4(placed.placement)));
        // text whose letters run past the edge of the model: the letters that do not reach into it would print as loose
        // pieces (raised) or cut nothing (cut in); they are left out, and the note says how many
        if (!isPart(item) && model && b.current.geometry) {
          const kept = lettersOnModel(world, temps);
          if (kept && kept.off > 0 && kept.solid) {
            world = kept.solid;
            const n = kept.off;
            notes.push({
              level: 'warn',
              code: 'LETTERS_OFF_MODEL',
              itemId: item.id,
              count: n,
              text:
                meets === 'engrave'
                  ? `${n} ${n === 1 ? 'letter' : 'letters'} of ${quote(item)} ${n === 1 ? 'lies' : 'lie'} past the edge of the model and ${n === 1 ? 'cuts' : 'cut'} nothing. Move the text or make it shorter.`
                  : `${n} ${n === 1 ? 'letter' : 'letters'} of ${quote(item)} ${n === 1 ? 'hangs' : 'hang'} past the edge of the model and ${n === 1 ? 'was' : 'were'} left out, as ${n === 1 ? 'it' : 'they'} would print loose. Move the text or make it shorter.`,
            });
          }
        }
        const wb = world.boundingBox();
        itemBounds.push({ id: item.id, part: isPart(item), separate: pegged, engrave: needsCut, min: [...wb.min], max: [...wb.max] });
        if (pegged) {
          const holes = placed.settle ? temps.add(placed.flat.cutter.translate(0, 0, placed.settle)) : placed.flat.cutter;
          engrave.push(temps.add(holes.transform(toMat4(placed.placement))));
          // shown in place; exported in its own frame, turned over so the pegs point up
          const flipped = temps.add(placed.solid.rotate([180, 0, 0]));
          const fbb = flipped.boundingBox();
          separate.push({ id: item.id, name: itemLabel(item, 'part'), world, local: temps.add(flipped.translate(0, 0, -fbb.min[2])) });
          return;
        }
        (meets === 'engrave' ? engrave : emboss).push(world);
        if (meets !== 'engrave') raised.push({ item, world });
      });

      let solid = null;
      let ground = model; // the model with what the covering items consumed cut away
      if (model) {
        if (covers.length) {
          progress?.('Clearing under the parts…');
          ground = temps.add(Manifold.difference(model, temps.add(Manifold.union(covers))));
        }
        progress?.('Merging text into the model…');
        solid = emboss.length ? temps.add(Manifold.union([ground, ...emboss])) : null;
        if (engrave.length) {
          const cutter = temps.add(Manifold.union(engrave));
          solid = temps.add(Manifold.difference(solid ?? ground, cutter));
        }
        if (!solid) solid = temps.add(ground.translate(0, 0, 0));
      } else if (emboss.length) {
        progress?.('Merging text…');
        solid = temps.add(Manifold.union(emboss));
      }

      if (solid) {
        if (solid.status() !== 'NoError') fail('INTERNAL', `Geometry operation failed (${solid.status()})`);
        if (solid.isEmpty()) fail('EMPTY_RESULT', 'The result would be empty – the cut-in text removes the whole model.');
        // drop floating slivers that the booleans can leave behind on curved
        // text – but never a small part the model had to begin with
        if (emboss.length + engrave.length + covers.length > 0) {
          if (!b.current.shellVolumes) {
            const own = model ? model.decompose() : [];
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
          // more pieces than the model had: something raised did not actually overlap the model and stayed loose
          // (judged against the model as it is after the covers, and against the other raised items it may rest on)
          if (model && keep.length > b.current.shellVolumes.length) {
            for (const { item, world } of raised) {
              const overlap = temps.add(ground.intersect(world));
              if (!overlap.isEmpty()) continue;
              if (raised.some((other) => other !== world && other.world !== world && !temps.add(other.world.intersect(world)).isEmpty())) continue;
              notes.push({
                level: 'warn',
                code: 'NOT_MERGED',
                itemId: item.id,
                text: `${quote(item)} isn't merged with the model (they don't overlap), so it would print as a loose piece. Snap it to the model or sink it deeper.`,
              });
            }
          }
        }
      }

      const kept = solid ? solid.translate(0, 0, 0) : null; // our own handle, outside the scope
      const owned = separate.map((p) => ({ id: p.id, name: p.name, world: p.world.translate(0, 0, 0), local: p.local.translate(0, 0, 0) }));
      disposeResult(result);
      result = { key, solid: kept, notes, skipped, separate: owned, passthrough: b.current.passthrough, itemBounds, split: null };
      return result;
    } finally {
      temps.dispose();
    }
  }

  function resultDisplay({ items, baseVersion, printing, split = null, bed = null }, progress) {
    unsplit(split);
    const final = finalFor(items, baseVersion, printing, progress);
    const parted = splitFor(final, items, { split, bed, printing }, progress);
    if (parted?.cut) return splitResult(final, parted, progress);
    releaseSplit(final);
    if (!final.display) {
      // the view of a final result is built once per result: showing it again (after a preview, a selection change,
      // or toggling back to it) reuses the buffers instead of simplifying and shading the whole model again
      progress?.('Preparing the view…');
      const temps = scope();
      let shown = final.solid;
      if (final.separate.length) {
        shown = temps.add(Manifold.compose([...(final.solid ? [final.solid] : []), ...final.separate.map((p) => p.world)]));
      }
      const lod = shown ? temps.add(lodFor(shown)) : null;
      const buffers = displayBuffers(lod ?? shown, final.passthrough);
      temps.dispose();
      final.display = {
        positions: buffers.positions,
        normals: buffers.normals,
        index: buffers.index,
        passthroughStart: buffers.passthroughStart,
        passthroughRanges: passthroughRangesOf(buffers.index, buffers.solidVertexCount),
      };
    }
    const d = final.display;
    const display = {
      positions: d.positions.slice(), // copies: the originals stay with the cached result
      normals: d.normals.slice(),
      index: d.index.slice(),
      passthroughStart: d.passthroughStart,
      passthroughRanges: d.passthroughRanges,
      bvhRoots: [],
    };
    return {
      message: { display, notes: parted ? [...final.notes, ...parted.notes] : final.notes, skipped: final.skipped, info: { triangles: d.index.length / 3 } },
      transfer: [display.positions.buffer, display.normals.buffer, display.index.buffer],
    };
  }

  function exportStl({ items, baseVersion, printing, name = 'model', split = null, bed = null, printer = null, archive = 'zip' }, progress) {
    unsplit(split);
    const final = finalFor(items, baseVersion, printing, progress);
    const parted = splitFor(final, items, { split, bed, printing }, progress);
    if (parted?.cut) return splitExport(final, parted, { name, printer, archive }, progress);
    releaseSplit(final);
    const soup = concatSoups([final.solid ? manifoldToSoup(final.solid) : null, final.passthrough]);
    if (!soup || !soup.length) fail('EMPTY_RESULT', 'There is nothing to export yet. Type some text or load a model.');
    progress?.('Writing STL…');
    const stl = writeBinarySTL(soup, `STL-Text ${name}`);
    const extra = final.separate.map((p) => {
      const partSoup = manifoldToSoup(p.local); // lying on its top face, pegs up, ready to print
      return { name: p.name, stl: writeBinarySTL(partSoup, `STL-Text ${p.name}`), triangles: partSoup.length / 9 };
    });
    return {
      message: { stl, triangles: soup.length / 9, notes: parted ? [...final.notes, ...parted.notes] : final.notes, skipped: final.skipped, extra },
      transfer: [stl, ...extra.map((e) => e.stl)],
    };
  }

  /* ---------------------------------------------------- split for printing */

  /**
   * The final solid turned into a cut axis's plane frame (split.js
   * `TO_PLANE`), for slicing along that axis. One copy is kept on the result
   * and made again for another axis: a dense model's copy weighs as much as
   * the model, so the cheap measure's copy and the result's are never kept
   * together. Callers slice it at once and never hold on to it.
   */
  function frameOf(final, axis) {
    if (axis === 2) return final.solid;
    const state = splitState(final);
    if (state.frame?.axis !== axis) {
      if (sketch && final !== sketch) releaseFrame(sketch);
      if (result && final !== result) releaseFrame(result);
      state.frame?.solid.delete();
      state.frame = null; // never left pointing at a deleted copy, even if the next line throws
      state.frame = { axis, solid: final.solid.transform(TO_PLANE[axis]) };
    }
    return state.frame.solid;
  }

  const releaseFrame = (final) => {
    final.split?.frame?.solid.delete();
    if (final.split) final.split.frame = null;
  };

  /** Lets go of a result's frame copy and the cheap measure's, before the model is cut. */
  const releaseFrames = (final) => {
    releaseFrame(final);
    if (sketch) releaseFrame(sketch);
  };

  /**
   * Lets go of a split's solids once the model is asked for whole again (its cuts removed, or all of them missing),
   * and of the measure's copy of the model, made while the cuts were edited.
   */
  function releaseSplit(final) {
    if (sketch) releaseFrame(sketch);
    const state = final.split;
    if (!state) return;
    releaseFrame(final);
    disposeSplitStage(state.cut);
    disposeSplitStage(state.drill);
    state.cut = null;
    state.drill = null;
  }

  /**
   * With no cuts asked for, what a split kept goes before the final result is built: a copy of a dense model weighs as
   * much as the model, and the booleans of the model with the text need the room.
   */
  function unsplit(split) {
    if (splitActive(split)) return;
    if (sketch) releaseFrame(sketch);
    if (result) releaseSplit(result);
  }

  /** What a split keeps on its final result: the frame copy, the plate test, the last fit plan, and the cut and drill stages. */
  const splitState = (final) => (final.split ??= { frame: null, bounds: null, plate: null, fit: null, cut: null, drill: null });

  /**
   * The box the cuts are judged and planned against: the solid's. Unrepaired
   * triangles go with the piece they fall in (or the nearest) but make no
   * piece of their own, so a cut that crosses only them cuts nothing.
   */
  function splitBounds(final) {
    const state = splitState(final);
    if (!state.bounds) {
      const b = boxOf(final.solid);
      state.bounds = { min: b.min, max: b.max };
    }
    return state.bounds;
  }

  /** The thickness axis when the whole model is a thin plate (every piece lies flat on it), else null. */
  function plateOf(final) {
    const b = splitBounds(final);
    return plateAxis([0, 1, 2].map((a) => b.max[a] - b.min[a]));
  }

  /** The thickness axis when the whole model is a slab such as a plaque (its pieces lie flat where they can), else null. */
  function slabOf(final) {
    const b = splitBounds(final);
    return slabAxis([0, 1, 2].map((a) => b.max[a] - b.min[a]));
  }

  /** The plate test of every cut (slices only), kept while the cuts and the joint settings stay the same. */
  function platesFor(final, cuts, spec) {
    const state = splitState(final);
    const key = stableKey({ cuts, joint: spec.joint, clearance: spec.clearance });
    if (state.plate?.key !== key) {
      const plan = planDovetails(final.solid, cuts, spec, { passthrough: final.passthrough.length > 0, frame: (axis) => frameOf(final, axis) });
      state.plate = { key, plan };
    }
    return state.plate.plan;
  }

  /** An item's solid where it sits in the model, in a cut axis's plane frame (the caller deletes it). */
  function itemInPlane(item, axis, temps) {
    const placed = solidFor(item);
    const world = temps.add(placed.solid.transform(toMat4(placed.placement)));
    return axis === 2 ? world : temps.add(world.transform(TO_PLANE[axis]));
  }

  /** Whether a solid in a cut's plane frame has any material on the cut's plane. */
  function cutsThrough(inPlane, at) {
    const face = inPlane.slice(at);
    const hit = !face.isEmpty() && face.area() > 1e-9;
    face.delete();
    return hit;
  }

  /** The text items (not parts) whose box straddles a cut and whose letters it really cuts, by id. */
  function textCrossing(final, items, cut, temps) {
    const ids = [];
    for (const b of final.itemBounds) {
      if (b.part || !(b.min[cut.axis] < cut.at && b.max[cut.axis] > cut.at)) continue;
      const item = items.find((i) => i.id === b.id);
      if (item && cutsThrough(itemInPlane(item, cut.axis, temps), cut.at)) ids.push(item.id);
    }
    return ids;
  }

  /**
   * Where the cuts run through text: for each cut and each text item whose
   * letters it really cuts, the letters' face on the cut, island by island,
   * in each column of the boxes the other cuts make (`outlineColumns`), so
   * that the note can name every pair of pieces the letters are split
   * between once the pieces are laid out (`textNotes`). Exact: each item's
   * own solid is sliced.
   */
  function textCrossings(final, items, cuts) {
    const out = [];
    const by = axisCuts(cuts);
    const temps = scope();
    try {
      for (const cut of cuts) {
        const index = by[cut.axis].indexOf(cut.at);
        for (const b of final.itemBounds) {
          if (b.part || !(b.min[cut.axis] < cut.at && b.max[cut.axis] > cut.at)) continue;
          const item = items.find((i) => i.id === b.id);
          if (!item) continue;
          const face = temps.add(itemInPlane(item, cut.axis, temps).slice(cut.at));
          if (face.isEmpty() || !(face.area() > 1e-9)) continue;
          const columns = face.decompose().map((island) => temps.add(island)).flatMap((island) => outlineColumns(polygonsOf(island), cut, index, by));
          out.push({ itemId: item.id, cutId: cut.id, letter: cut.letter, name: quote(item), columns });
        }
      }
    } finally {
      temps.dispose();
    }
    return out;
  }

  /**
   * Notes on the separately printed parts the cuts run through: they span a
   * cut and so are glued on after the pieces. Exact: each part is sliced.
   */
  function crossingNotes(final, items, cuts) {
    const notes = [];
    const temps = scope();
    try {
      for (const p of final.separate) {
        const pb = boxOf(p.world);
        const cut = cuts.find((c) => pb.min[c.axis] < c.at && pb.max[c.axis] > c.at && cutsThrough(c.axis === 2 ? p.world : temps.add(p.world.transform(TO_PLANE[c.axis])), c.at));
        if (!cut) continue;
        const item = items.find((i) => i.id === p.id);
        notes.push(splitNote('PART_SPANS_CUT', { itemId: p.id, name: item ? quote(item) : p.name, letter: cut.letter, cutId: cut.id }));
      }
    } finally {
      temps.dispose();
    }
    return notes;
  }

  /**
   * The unrepaired triangles cut with the pieces: each fragment goes to the
   * piece of the cell its centre lies in, or – when that cell has no piece –
   * to the piece whose box is nearest. World coordinates, by piece number.
   */
  function fragmentsFor(final, cuts, pieces) {
    const out = new Map();
    if (!final.passthrough.length) return out;
    const byCell = new Map(pieces.map((p) => [p.cell.join(','), p]));
    for (const { cell, soup } of soupCells(final.passthrough, cuts)) {
      let piece = byCell.get(cell.join(','));
      if (!piece) {
        const c = [0, 1, 2].map((a) => {
          let s = 0;
          for (let i = a; i < soup.length; i += 3) s += soup[i];
          return s / (soup.length / 3);
        });
        const away = (p) => Math.hypot(...c.map((v, a) => Math.max(0, p.bbox.min[a] - v, v - p.bbox.max[a])));
        piece = pieces.reduce((best, p) => (away(p) < away(best) ? p : best));
      }
      out.set(piece.index, concatSoups([out.get(piece.index), soup]));
    }
    return out;
  }

  /**
   * A split as a request asks for it, through three stages cached on the
   * final result: the cut (pieces and their orientation statistics; booleans),
   * how each piece lies (pure, never cached), and the pins, labels and
   * drilling (booleans, keyed by the cut, the connector settings and each
   * piece's way up – so a new bed that turns no piece over costs nothing).
   * A piece that carries built-in pegs is laid again once they are placed:
   * they stand out of it, and never point down; so is one a take-apart
   * cut's lip stands out of, the one way that keeps the lip standing up
   * (the layout chose it, before the other cuts' pins). Returns null
   * without cuts; `{ notes }` when the model is exported whole after all (it
   * cannot be split, or every cut missed); else the split.
   */
  function splitFor(final, items, { split, bed, printing }, progress) {
    if (!splitActive(split)) return null;
    if (base.kind !== 'none' && !base.current?.watertight) return { notes: [splitNote('SPLIT_UNAVAILABLE')] };
    if (!final.solid) return { notes: [] }; // nothing solid to cut: the unrepaired triangles are exported as they are
    const { spec, cuts, notes: given } = normaliseSplit(split, splitBounds(final));
    if (!cuts.length) return { notes: given };
    // the labels' font is asked for before any work, so a restarted engine gets it back in one round
    if (spec.labels) requireFonts([{ lines: [{ fontId: 'inter' }] }]);
    const U = bedOf(bed);
    const nozzle = printing?.nozzle ?? 0.4;
    const plan = platesFor(final, cuts, spec);
    const cut = cutStage(final, items, cuts, plan, progress);
    progress?.('Choosing how each piece lies…');
    // how each piece lies, and which of a box's shells print apart because lying that way they would not rest on the bed
    const flat = slabOf(final);
    const laid = layPieces(cut.pieces, U, spec.orient, { flat, soups: cut.fragments });
    const drill = drillStage(final, cut, laid, { cuts, spec, joints: plan.joints, nozzle, U, flat }, progress);
    const lying = layGrown(laid, drill.layout, U, spec.orient, { flat });
    return summarise({ final, spec, cuts, U, given, plan, cut, laid, lying, drill });
  }

  /** Stage A: the model cut into one piece per cell, each with its orientation statistics. */
  function cutStage(final, items, cuts, { dove, tabs }, progress) {
    const state = splitState(final);
    // the tabs follow from the model, the cuts and `dove`, so the key needs no more: whether a cut comes apart, and
    // how it holds, change only the drilling (a plate's cut that comes apart on tabs changes `dove`)
    const key = `${final.key}|cut:${stableKey({ cuts: cuts.map(({ id, letter, axis, at }) => ({ id, letter, axis, at })), dove })}`;
    if (state.cut?.key === key) return state.cut;
    disposeSplitStage(state.drill);
    disposeSplitStage(state.cut);
    state.drill = null;
    state.cut = null;
    // a dense model's frame copy would be a third copy of it while it is cut
    if (final.solid.numTri() > splitKeepTriangles) releaseFrames(final);
    const made = cutPieces(final.solid, cuts, { dove, tabs, bounds: boxOf(final.solid), flat: plateOf(final), frame: (axis) => frameOf(final, axis), progress });
    const solids = made.pieces.map((p) => p.solid);
    try {
      const pieces = made.pieces.map(({ solid, ...plain }) => plain);
      const keep = solids.reduce((n, m) => n + m.numTri(), 0) <= splitKeepTriangles;
      // text through a cut is told of once the pieces are laid out: a box whose shells print apart is more than one piece
      const crossings = textCrossings(final, items, cuts);
      const notes = [...made.notes, ...crossingNotes(final, items, cuts)];
      if (final.passthrough.length) notes.push(splitNote('SPLIT_UNREPAIRED', { count: final.passthrough.length / 9 }));
      // a piece's file holds its loose triangles too: it is turned and judged with them (`layPieces`)
      const fragments = fragmentsFor(final, cuts, pieces);
      state.cut = {
        key,
        cuts,
        dove,
        tabs,
        pieces,
        grid: made.grid,
        dovetails: made.dovetails,
        fragments,
        notes,
        crossings,
        solids: keep ? solids : null,
        transient: keep ? null : solids, // made for this call only: the drill stage takes them
      };
    } catch (err) {
      solids.forEach((m) => m.delete());
      throw err;
    }
    return state.cut;
  }

  /** The cut stage's piece solids for this call: the kept ones (borrowed), or made again (`owned`: the caller deletes them). */
  function pieceSolids(final, cut, progress) {
    if (cut.solids) return { solids: cut.solids, owned: false };
    if (cut.transient) {
      const solids = cut.transient;
      cut.transient = null;
      return { solids, owned: true };
    }
    // a frame copy left by the cuts' measure would be a third copy of a dense model while it is cut again
    releaseFrames(final);
    const made = cutPieces(final.solid, cut.cuts, { dove: cut.dove, tabs: cut.tabs, bounds: boxOf(final.solid), flat: plateOf(final), frame: (axis) => frameOf(final, axis), progress });
    const solids = made.pieces.map((p) => p.solid);
    if (solids.length !== cut.pieces.length) {
      solids.forEach((m) => m.delete());
      fail('INTERNAL', 'The pieces came out differently when they were cut again.');
    }
    return { solids, owned: true };
  }

  /**
   * Stage C and D: lips, pins, pegs and labels laid out (plain data), and every piece drilled. The pieces are those
   * `layPieces` made of the cut's: the way each prints up and which shells print apart are in the key. Which piece of a
   * pair carries built-in pegs follows from how they lie on the bed (`pegMales`), and so does which carries a lip and
   * so lies with it standing up (`apartMales`), so with pegs or a cut that comes apart the bed is in it too, and with
   * the latter each such cut's hold.
   */
  function drillStage(final, cut, laid, { cuts, spec, joints, nozzle, U, flat }, progress) {
    const state = splitState(final);
    const { joint, diameter, depth, clearance, count, labels, orient } = spec;
    const font = labels ? fontFor('inter') : null;
    const ups = laid.map((p) => p.lying.up);
    const groups = laid.map((p) => [p.from, p.parts]);
    const apart = cuts.filter((c) => c.apart);
    // spread only when there is something: `stableKey` would keep an undefined field
    const onBed = {
      ...(joint === 'pegs' ? { U, orient } : {}),
      ...(apart.length ? { apart: apart.map((c) => [c.id, c.apart.hold]), U, orient } : {}),
    };
    const key = `${cut.key}|drill:${stableKey({ joint, diameter, depth, clearance, count, labels, nozzle, ups, groups, font: font?.key ?? null, ...onBed })}`;
    if (state.drill?.key === key) return state.drill;
    disposeSplitStage(state.drill);
    state.drill = null;
    const length = pegAllowance(spec);
    const layout = layoutSplit(final.solid, cuts, laid.map((p) => ({ index: p.index, cell: p.cell, up: p.lying.up, boxes: p.boxes })), spec, {
      nozzle, joints, tabs: cut.tabs, font: font?.font ?? null, bounds: boxOf(final.solid), progress,
      apartMales: apart.length ? apartMales(laid, U, orient, { flat }) : null,
      // the pieces a lip stands out of lie its way, known only once the lips are laid out
      pegMales: joint === 'pegs' ? (pairs, longest, forced) => pegMales(laid, U, orient, { flat, length, forced })(pairs, longest) : null,
    });
    const drilled = drillAll(final, cut, laid, layout, font?.font ?? null, progress);
    const keep = drilled.reduce((n, m) => n + m.numTri(), 0) <= splitKeepTriangles;
    state.drill = { key, layout, display: null, solids: keep ? drilled : null, transient: keep ? null : drilled };
    return state.drill;
  }

  /** Every piece with its own holes and labels taken out (new solids, the caller's), one per piece of `laid`. */
  function drillAll(final, cut, laid, layout, font, progress) {
    const { solids, owned } = pieceSolids(final, cut, progress);
    const drilled = [];
    let parted = [];
    try {
      cut.pieces.forEach((c, i) => {
        const mine = laid.filter((p) => p.from === c.index);
        // a box whose shells print apart: each group of them is a piece of its own
        parted = mine.length > 1 ? partedSolids(solids[i], c.parts, mine.map((p) => p.parts)) : [];
        mine.forEach((p, k) => {
          progress?.('Drilling pin holes…', { done: p.index, total: laid.length });
          drilled.push(drillPiece(parted[k] ?? solids[i], layout, p.index, { font }));
        });
        parted.forEach((m) => m.delete());
        parted = [];
      });
      return drilled;
    } catch (err) {
      drilled.forEach((m) => m.delete());
      throw err;
    } finally {
      parted.forEach((m) => m.delete());
      if (owned) solids.forEach((m) => m.delete());
    }
  }

  /** The drilled pieces for this call: kept (borrowed), or drilled again from the kept layout (`owned`). */
  function drilledSolids(final, split, progress) {
    const { cut, drill } = split;
    if (drill.solids) return { solids: drill.solids, owned: false };
    if (drill.transient) {
      const solids = drill.transient;
      drill.transient = null;
      return { solids, owned: true };
    }
    const font = drill.layout.labels.length ? fontFor('inter').font : null;
    return { solids: drillAll(final, cut, split.laid, drill.layout, font, progress), owned: true };
  }

  /**
   * An `APART_HEAVY` note for each Z cut whose clips may not hold up what
   * hangs below it when the model is carried by its top: their hold
   * (`clipHold`, a weak print's) under twice the weight of every piece below
   * the cut, in PLA. Worked out, not measured, as the hold is. `firmer` the
   * gentlest firmer hold whose clips would hold it, where one would.
   */
  function heavyNotes(cuts, lips, laid) {
    const notes = [];
    const along = axisCuts(cuts)[2];
    for (const c of cuts) {
      if (!c.apart || c.axis !== 2) continue;
      const clipped = lips.filter((l) => l.cutId === c.id && l.clips > 0 && l.i > 0);
      if (!clipped.length) continue;
      // each lip's own clips, as `clipShape` makes them on its tongue: a lock's are stiffer bridges with a steeper catch,
      // and a wide nozzle's are thinned to a 0.4 mm nozzle's
      const holdOf = (hold) => clipped.reduce((sum, l) => sum + clipHold(l.clips, clipShape(hold, l.c, l.t) ?? {}), 0);
      const hold = clipped.reduce((sum, l) => sum + clipHold(l.clips, { ...clipShape(l.hold, l.c, l.t), i: l.i }), 0);
      const below = along.indexOf(c.at);
      const grams = laid.filter((p) => p.cell[2] <= below).reduce((sum, p) => sum + (p.volume ?? 0), 0) * PLA_DENSITY;
      const needs = 2 * (grams / 1000) * GRAVITY;
      if (hold < needs) {
        // the holds firmer than this one, gentlest first: Clicks on for a light click where that is enough, else Locks
        const firmer = APART_HOLDS.slice(0, Math.max(0, APART_HOLDS.indexOf(c.apart.hold))).reverse().find((h) => holdOf(h) >= needs);
        notes.push(splitNote('APART_HEAVY', {
          letter: c.letter, cutId: c.id, weight: Math.round(grams), hold: Math.round(hold * 10) / 10, ...(firmer ? { firmer } : {}),
        }));
      }
    }
    return notes;
  }

  /**
   * The plain description of a split, shared by the pieces view and the
   * download: the pieces as they print, the seams, the pin groups and every
   * note, the summary first. A piece a take-apart cut's lip stands out of
   * lists it (`lips`, by cut letter with its clips), and the one that comes
   * off it – the top of a Z cut, the piece with the groove across X or Y – the
   * letters of the cuts it comes off at (`lids`).
   */
  function summarise(split) {
    const { final, spec, cuts, U, given, plan, cut, laid, lying, drill } = split;
    const { layout } = drill;
    const n = laid.length;
    const lips = layout.lips ?? [];
    const pieces = laid.map((p, i) => {
      const o = lying[i];
      // a cut's lip may stand out of a piece on more than one face: one entry a cut, its clips added up. What comes off
      // is the top of a Z cut, whichever piece has the lip (a box's lid may), and across X or Y the piece that goes on
      // the other's lip
      const carried = new Map();
      const lids = new Set();
      for (const l of lips) {
        l.sides.forEach((s, j) => {
          if (s.piece !== p.index) return;
          if (s.male) carried.set(l.letter, (carried.get(l.letter) ?? 0) + l.clips);
          if (j === (l.axis === 2 ? 1 : 1 - l.male)) lids.add(l.letter);
        });
      }
      return {
        index: p.index,
        name: `piece ${p.index} of ${n}`,
        cell: p.cell,
        shells: p.shells,
        size: o.size,
        fits: o.fits,
        lies: o.lies,
        yaw: o.yaw,
        down: o.down,
        up: o.up,
        dowels: layout.dowels.filter((d) => d.sides.some((s) => s.piece === p.index)).length,
        // the built-in pegs it carries, and the sockets it has for another piece's
        pegs: layout.pegs.filter((g) => g.sides.some((s) => s.peg && s.piece === p.index)).length,
        sockets: layout.pegs.filter((g) => g.sides.some((s) => !s.peg && s.piece === p.index)).length,
        lips: [...carried].sort((x, y) => x[0].localeCompare(y[0])).map(([letter, clips]) => ({ letter, clips })),
        lids: [...lids].sort(),
        unrepaired: (p.soup?.length ?? 0) / 9,
      };
    });
    const tabs = new Map(cut.dovetails.map((x) => [x.cutId, x.tabs]));
    const seams = layout.seams.map((s) => ({
      cutId: s.cutId,
      letter: s.letter,
      axis: s.axis,
      at: s.at,
      pieces: s.pieces,
      joint: s.joint,
      labels: s.labels,
      ...(s.joint === 'dovetail' ? { tabs: tabs.get(s.cutId) ?? 0 } : {}),
      dowels: s.dowels.map((d) => ({
        centre: d.centre, axis: d.axis, d: d.d, depth: d.depth, R: d.R, h: d.h, ch: d.ch, cell: d.cell, patch: d.patch, tear: d.sides.map((x) => x.tear), sides: d.sides,
      })),
      pegs: s.pegs.map((g) => ({
        centre: g.centre, axis: g.axis, at: g.at, s: g.s, length: g.length, c: g.c, half: g.half, ch: g.ch, e: g.e, h: g.h, tip: g.tip, a: g.a,
        cell: g.cell, patch: g.patch, male: g.male, dir: g.dir, sides: g.sides,
      })),
      male: s.male,
      ...(s.apart ? { apart: { ...s.apart } } : {}),
    }));
    // the cuts that come apart, by letter: never glued, and said so in the summary
    const apartLetters = [...new Set(seams.filter((s) => s.apart).map((s) => s.letter))].sort();
    const apartIds = new Set(cuts.filter((c) => c.apart).map((c) => c.id));
    // one group per pin size: the pins file holds each group, with spares
    const groups = new Map();
    for (const d of layout.dowels) {
      const k = `${d.d}|${d.depth}`;
      if (!groups.has(k)) groups.set(k, { d: d.d, depth: d.depth, length: 2 * d.depth, count: 0 });
      groups.get(k).count++;
    }
    // the size the layout chose first: the filament some narrow faces fell back to never stands in for it
    const pins = [...groups.values()]
      .sort((p, q) => (p.d === layout.diameter ? 0 : 1) - (q.d === layout.diameter ? 0 : 1) || q.count - p.count || q.d - p.d || q.depth - p.depth)
      .map((g) => {
        const own = spec.pins === 'own' || g.d === FILAMENT;
        return { ...g, own, spares: own ? 0 : pinSpares(g.count) };
      });
    const notes = [];
    const main = pins[0];
    // the summary counts every pin, and says how many of each size, or of each length of one size, when they differ
    const sized = main ? pins.filter((g) => g.d === main.d) : [];
    const pairs = seams.filter((s) => s.labels?.length === 2).map((s) => `${s.labels[0]} ↔ ${s.labels[1]}`);
    // built-in pegs by size, the size the layout chose first
    const pegSizes = [...layout.pegs.reduce((m, g) => m.set(g.s, (m.get(g.s) ?? 0) + 1), new Map())]
      .sort((p, q) => (p[0] === layout.pegSize ? 0 : 1) - (q[0] === layout.pegSize ? 0 : 1) || q[0] - p[0])
      .map(([size, count]) => ({ size, count }));
    notes.push(splitNote('SPLIT', {
      pieces: n, dowels: pins.reduce((k, g) => k + g.count, 0), diameter: main?.d ?? null, length: main?.length ?? null,
      ...(sized.length > 1 ? { lengths: sized.map((g) => ({ length: g.length, count: g.count })) } : {}),
      ...(sized.length < pins.length ? { sizes: pins.map((g) => ({ diameter: g.d, length: g.length, count: g.count })) } : {}),
      ...(pegSizes.length ? { pegs: layout.pegs.length, pegSize: pegSizes[0].size } : {}),
      ...(pegSizes.length > 1 ? { pegSizes } : {}),
      dovetails: cut.dovetails.length, pairs,
      ...(apartLetters.length ? { apart: apartLetters } : {}),
    }));
    for (const g of pins) {
      // pins that fell back to filament on some faces are told of by that cut's own note
      if (g.d === FILAMENT && layout.diameter !== FILAMENT) continue;
      notes.push(splitNote('PINS', { count: g.count, spares: g.spares, diameter: g.d, length: g.length, own: g.own }));
    }
    for (const x of cut.dovetails) {
      const seam = seams.find((s) => s.cutId === x.cutId && s.joint === 'dovetail');
      const how = apartIds.has(x.cutId) ? { apart: true } : spec.joint === 'pegs' ? { pegs: true } : {};
      notes.push(splitNote('DOVETAIL', { letter: x.letter, cutId: x.cutId, tabs: x.tabs, pieces: seam?.pieces ?? [], ...how }));
    }
    // the cut numbers the boxes' pieces: a box whose shells print apart is more than one piece, so the thin pieces are
    // looked for again, and text through a cut names the pieces as they print, beside the cut's other notes
    const cutNotes = cut.notes.filter((x) => x.code !== 'SMALL_PIECE');
    const after = cutNotes.findIndex((x) => x.code === 'PART_SPANS_CUT' || x.code === 'SPLIT_UNREPAIRED');
    cutNotes.splice(after < 0 ? cutNotes.length : after, 0, ...textNotes(cut.crossings, laid));
    notes.push(...given, ...plan.notes, ...smallPieceNotes(laid, cuts), ...cutNotes);
    // what prints on its own must fit the bed as it is saved too: a part lying pegs up, a pin on its flat
    for (const p of final.separate) {
      const b = boxOf(p.local);
      const size = b.max.map((v, a) => v - b.min[a]);
      if (!fitsBed(size, U, { flat: 2 }).fits) notes.push(splitNote('PART_TOO_BIG', { itemId: p.id, name: p.name, size, bed: U }));
    }
    for (const g of pins) {
      const one = g.own ? null : pinsPerSheet(g, U).size;
      if (one && !fitsBed(one, U, { flat: 2 }).fits) notes.push(splitNote('PART_TOO_BIG', { pins: true, size: one, bed: U }));
    }
    lying.forEach((o, i) => {
      // a piece on a dovetail seam lies flat by design, and one carrying pegs never lies on them: that it cannot lie on
      // its cut face (or as modelled) is no news
      const held = laid[i].stats.allowed.length < 6 || o.pegged;
      notes.push(...o.notes.filter((x) => !(held && x.code === 'ORIENT_FALLBACK')));
    });
    // pegs that all print pointing up (on a plate under a thick top) are weaker across their layers: said once a cut,
    // naming pins only where they would fit
    notes.push(...layout.notes, ...heavyNotes(cuts, lips, laid), ...uprightPegNotes(layout.pegs, laid, lying, layout.pinnable));
    // the peg size is the one the pieces have, as the summary says: a size asked for that no face took is none of theirs
    return { ...split, pieces, seams, pins, notes, grid: cut.grid, diameter: layout.diameter, pegSize: pegSizes[0]?.size ?? layout.pegSize };
  }

  /** The `result` reply with a split: the pieces exploded apart in the viewer, one range per piece, pin and part. */
  function splitResult(final, split, progress) {
    const { cut, drill } = split;
    if (!drill.display) {
      progress?.('Preparing the view…');
      const { solids, owned } = drilledSolids(final, split, progress);
      const temps = scope();
      try {
        // a dense split is shown through lighter copies, like a dense model; downloads use the full pieces
        const dense = solids.reduce((n, m) => n + m.numTri(), 0) > lodTriangles;
        const shown = solids.map((m) => {
          if (!dense) return m;
          const simpler = temps.add(m.simplify(lodTolerance));
          return simpler.numTri() < m.numTri() ? simpler : m;
        });
        const by = axisCuts(split.cuts);
        const entries = split.laid.map((p, i) => ({ solid: shown[i], soup: p.soup, part: { kind: 'piece', index: p.index } }));
        for (const d of drill.layout.dowels) entries.push({ solid: temps.add(pinAt(d)), part: { kind: 'pin', cell: d.cell } });
        for (const p of final.separate) {
          const b = boxOf(p.world);
          entries.push({ solid: p.world, part: { kind: 'part', id: p.id, cell: cellOfPoint(b.min.map((v, a) => (v + b.max[a]) / 2), by) } });
        }
        drill.display = buildSplitDisplay(entries);
      } finally {
        temps.dispose();
        if (owned) solids.forEach((m) => m.delete());
      }
    }
    const d = drill.display;
    const display = {
      positions: d.positions.slice(), // copies: the originals stay with the cached split
      normals: d.normals.slice(),
      index: d.index.slice(),
      passthroughStart: d.passthroughStart,
      passthroughRanges: d.passthroughRanges,
      ranges: d.ranges,
      parts: d.parts,
      bvhRoots: [],
    };
    return {
      message: {
        display,
        pieces: split.pieces,
        grid: split.grid,
        seams: split.seams,
        diameter: split.diameter,
        pegSize: split.pegSize,
        notes: [...final.notes, ...split.notes],
        skipped: final.skipped,
        info: { triangles: d.index.length / 3, pieces: split.pieces.length },
      },
      transfer: [display.positions.buffer, display.normals.buffer, display.index.buffer],
    };
  }

  /**
   * The `export` reply with a split: every piece turned the way it prints,
   * a pins file per pin size, the separately printed parts and the glue
   * sheet, packed in one zip (`archive: 'zip'`) or sent as separate files.
   */
  function splitExport(final, split, { name, printer, archive }, progress) {
    const { laid, drill, lying, U, spec } = split;
    const n = laid.length;
    const files = [];
    const add = (file, soup, extra) => {
      const stl = writeBinarySTL(soup, `STL-Text ${file}`);
      files.push({ name: file, file: `${file}.stl`, triangles: soup.length / 9, matrix: null, ...extra, stl });
    };
    const { solids, owned } = drilledSolids(final, split, progress);
    try {
      laid.forEach((p, i) => {
        progress?.('Writing piece files…', { done: i + 1, total: n });
        const { printMatrix, matrix, size, fits, lies, yaw } = lying[i];
        const frags = p.soup;
        const soup = concatSoups([applyToSoup(manifoldToSoup(solids[i]), printMatrix), frags ? applyToSoup(frags, printMatrix) : null]);
        add(pieceFileName(name, p.index, n), soup, { kind: 'piece', index: p.index, size, fits, lies, yaw, matrix });
      });
    } finally {
      if (owned) solids.forEach((m) => m.delete());
    }
    for (const g of split.pins) {
      if (g.own) continue;
      // as many pins files as the bed needs, each lying as it is laid out
      const all = g.count + g.spares;
      const { perSheet } = pinsPerSheet(g, U);
      const sheets = Math.ceil(all / perSheet);
      for (let i = 0; i < sheets; i++) {
        const count = Math.floor(all / sheets) + (i < all % sheets ? 1 : 0); // shared out evenly
        const sheet = pinSheet({ d: g.d, length: g.length, count }, U);
        try {
          const b = boxOf(sheet);
          const size = b.max.map((v, a) => v - b.min[a]);
          const file = `${safeFileName(name)}-${pinsFileName(count, g.d, g.length)}${sheets > 1 ? `-${i + 1}-of-${sheets}` : ''}`;
          add(file, manifoldToSoup(sheet), {
            kind: 'pins', d: g.d, length: g.length, count, spares: i === sheets - 1 ? g.spares : 0, size, fits: fitsBed(size, U, { flat: 2 }).fits,
          });
        } finally {
          sheet.delete();
        }
      }
    }
    final.separate.forEach((p, k) => {
      const b = boxOf(p.local);
      const size = b.max.map((v, a) => v - b.min[a]);
      add(partFileName(name, k + 1, p.name), manifoldToSoup(p.local), { kind: 'part', id: p.id, size, fits: fitsBed(size, U, { flat: 2 }).fits });
    });
    const assembly = assemblySteps({ pieces: split.pieces, seams: drill.layout.seams });
    // the clips' bridges as built: a wide nozzle's lock has longer ones
    const bridges = [...new Set((drill.layout.lips ?? []).filter((l) => l.clips > 0 && l.i > 0).map((l) => clipShape(l.hold, l.c, l.t).span))];
    const text = howToGlueText({
      name, pieces: split.pieces, seams: drill.layout.seams, pins: split.pins, parts: final.separate.map((p) => ({ name: p.name })),
      clearance: spec.clearance, bed: U, printer, steps: assembly, ...(bridges.length ? { bridges } : {}),
    });
    const glue = glueFileName(name);
    files.push({ name: glue.replace(/\.txt$/, ''), file: glue, kind: 'text', text });
    const triangles = files.reduce((t, f) => t + (f.triangles ?? 0), 0);
    const message = {
      stl: null, triangles, notes: [...final.notes, ...split.notes], skipped: final.skipped, extra: [],
      pieces: split.pieces, seams: split.seams, assembly: assembly.map((s) => s.text), diameter: split.diameter, pegSize: split.pegSize,
    };
    if (archive === 'files') {
      message.files = files;
      return { message, transfer: files.filter((f) => f.stl).map((f) => f.stl) };
    }
    progress?.('Packing the zip…');
    const entries = {};
    let bytes = 0;
    for (const f of files) {
      entries[f.file] = f.stl ? new Uint8Array(f.stl) : strToU8(f.text);
      bytes += entries[f.file].byteLength;
    }
    // deflate is worth its time on modest downloads; a huge one is stored as it is
    const zip = zipSync(entries, { level: bytes > 40 * 1024 * 1024 ? 0 : 1 });
    message.zip = zip.byteOffset === 0 && zip.byteLength === zip.buffer.byteLength ? zip.buffer : zip.slice().buffer;
    message.zipName = zipFileName(name, n);
    message.files = files.map(({ stl, ...rest }) => rest);
    return { message, transfer: [message.zip] };
  }

  /**
   * The cuts that come apart, which Fit to my printer keeps where they are:
   * checked and merged against the solid as the split will (`normaliseSplit`),
   * in the order they are listed, each with the cut as the document will
   * hold it once the plan is taken (`stored`: its id, place and hold).
   */
  function keptCutsOf(final, split) {
    const listed = (Array.isArray(split?.cuts) ? split.cuts : [])
      .map((c, i) => (c ? { ...c, id: c.id ?? `c${i + 1}` } : c))
      .filter((c) => c?.joint === 'apart');
    if (!listed.length) return [];
    const { cuts } = normaliseSplit({ cuts: listed }, splitBounds(final));
    return listed.flatMap((s) => {
      const c = cuts.find((x) => x.id === s.id && x.apart);
      return c ? [{ ...c, stored: { id: s.id, position: [...s.position], normal: [...s.normal], joint: 'apart', hold: c.apart.hold } }] : [];
    });
  }

  /**
   * Fit to my printer (`mode: 'fit'`): the fewest pieces that fit the bed,
   * and where their cuts go – away from letters, ledges and narrow necks, on
   * faces with room for pins – from the cost of cutting at each sample of a
   * profile of slices. `mode: 'measure'`: each cut's face (area, islands),
   * its joint (and a dovetail cut's tabs) and the text it runs through, for
   * the card while cuts are edited. Slices, but for one small boolean round
   * each dovetail cut, which keeps its tabs clear of what stands proud of the
   * plate, and – on a model that is not dense – the cut itself, for how many
   * pieces the download will hold (kept for the pieces view and the
   * download). While the final result for the text is not built (the text is
   * being edited) a model's cuts are measured on the model and the items' own
   * solids instead, with no boolean of the two (`estimate: true`). A fit plan
   * is kept with the final result, for the bed, nozzle and joint settings it
   * was made for: asked again (the Model card's count, then its button), it
   * comes back at once. Its pieces are those the split will make: the model
   * is cut where it says (`planPieces`), so the count offered is the number
   * of files the download holds. Modes 'probe', 'spots' and 'targets', for
   * placing a cut that comes apart, are `aimRequest`'s.
   */
  function planSplitRequest(request, progress) {
    const { items, baseVersion, printing, split = null, bed = null, mode = 'fit' } = request;
    if (mode === 'probe' || mode === 'spots' || mode === 'targets') return aimRequest(request, progress);
    if (mode === 'measure' && sketchWill(items, baseVersion)) {
      // the final result for this text is not built: a measure while the text is edited must not build it
      const message = measureCuts(sketchFor(items, baseVersion), items, split, null, progress);
      return { message: { ...message, estimate: true }, transfer: [] };
    }
    const final = finalFor(items, baseVersion, printing, progress);
    let message;
    if (base.kind !== 'none' && !base.current?.watertight) message = { bounds: null, cuts: [], notes: [splitNote('SPLIT_UNAVAILABLE')] };
    else if (!final.solid) message = { bounds: null, cuts: [], notes: [] };
    else if (mode === 'measure') message = measureCuts(final, items, split, bedOf(bed), progress);
    else {
      // the plan is kept with the result it was made for, so the count the Model card offers and the cuts the offer's
      // button asks for again come from one plan, worked out once
      const U = bedOf(bed);
      const nozzle = printing?.nozzle ?? 0.4;
      const { spec } = normaliseSplit({ ...(split ?? {}), cuts: [] });
      // the cuts that come apart stay where they are: the plan is made round them, and they come back as they are
      const kept = keptCutsOf(final, split);
      const fixed = kept.length ? { fixed: kept.map((c) => [c.id, c.axis, c.at, c.apart.hold]) } : {};
      const key = stableKey({ U, nozzle, joint: spec.joint, diameter: spec.diameter, depth: spec.depth, clearance: spec.clearance, ...fixed });
      const state = splitState(final);
      if (state.fit?.key !== key) state.fit = { key, plan: fitCuts(final, items, split, U, nozzle, kept, progress), made: new Map() };
      // how the pieces lie decides which loose parts print apart: worked out again only for another way of laying them
      if (!state.fit.made.has(spec.orient)) {
        state.fit.made.set(spec.orient, planPieces(final, items, state.fit.plan, spec, U, progress));
        releaseFrame(final); // the tabs' look at the plates is done: the copy would only hold memory
      }
      const { cuts, counts, notes } = state.fit.plan;
      message = { cuts, counts, pieces: state.fit.made.get(spec.orient), notes };
    }
    return { message, transfer: [] };
  }

  /**
   * The pieces Fit to my printer's cuts make, as the split will make them:
   * the model cut there (the cut stage, kept for the pieces view and the
   * download that follow at once) and the pieces laid out, so a box whose
   * loose boards would be held over the bed counts as each piece it prints
   * as. Each is given the size of its box as planned, tabs counted, and
   * whether it fits as it will lie. Should the cut fail, the boxes stand:
   * the split itself will say what is wrong.
   */
  function planPieces(final, items, plan, spec, U, progress) {
    const boxes = plan.pieces.map(({ cell, size, fits }) => ({ cell, size, fits }));
    if (!plan.cuts.length) return boxes.map(({ size, fits }) => ({ size, fits }));
    try {
      // the cuts as the document will hold them once taken, numbered as it numbers them – the ones kept keep their
      // ids, the new ones follow on – so the split that follows finds this cut
      const { cuts } = normaliseSplit({ ...spec, cuts: numberedCuts(plan.cuts) }, splitBounds(final));
      const laid = layCuts(final, items, cuts, spec, U, progress);
      const box = new Map(boxes.map((b) => [b.cell.join(','), b]));
      return laid.map((p) => ({ size: box.get(p.cell.join(','))?.size ?? p.lying.size, fits: p.lying.fits }));
    } catch {
      return boxes.map(({ size, fits }) => ({ size, fits }));
    }
  }

  /**
   * The model cut by `cuts` (normalised) as the split cuts it, and the pieces laid out as they will print: one per
   * file. The cut is kept for the pieces view or the download that follows (pieces too dense to keep, for its next
   * call only, as ever).
   */
  function layCuts(final, items, cuts, spec, U, progress) {
    const cut = cutStage(final, items, cuts, platesFor(final, cuts, spec), progress);
    return layPieces(cut.pieces, U, spec.orient, { flat: slabOf(final), soups: cut.fragments });
  }

  let sketch = null; // { base, solid, passthrough, itemBounds, split }: the model and the text's boxes, for a cheap measure

  /**
   * Whether a measure would be taken from the model and the items' own
   * solids rather than the final result: there is a solid model, and the
   * final result for these items is not built (it is the booleans of the
   * whole model with the text, seconds on a dense model, and the text is
   * likely still being typed).
   */
  function sketchWill(items, baseVersion) {
    const b = baseFor(baseVersion);
    if (b.kind === 'none' || !b.current?.watertight) return false;
    return result?.key !== finalKey(items, baseVersion).key;
  }

  /**
   * What a measure needs without the final result: the model's own solid
   * (borrowed) with its plane-frame copy and plate test kept between
   * measures like a final result's, the box of every item where it sits
   * (from its own solid, which the previews have built), and the box the
   * cuts are judged against: the model's together with the raised text's.
   * Cut-in text, parts printed separately and text that does not touch the
   * model add nothing to it. The faces it measures are the model's alone.
   */
  function sketchFor(items, baseVersion) {
    const b = baseFor(baseVersion);
    const { active } = finalKey(items, baseVersion);
    const model = currentManifold();
    if (sketch?.base !== b.current || sketch?.solid !== model) {
      releaseSketch();
      sketch = { base: b.current, solid: model, passthrough: b.current.passthrough, itemBounds: [], split: null };
    }
    const itemBounds = [];
    const temps = scope();
    try {
      for (const item of active) {
        const placed = solidFor(item);
        if (placed.stats && placed.stats.touches === false) continue;
        const meets = baseMode(item);
        const wb = temps.add(placed.solid.transform(toMat4(placed.placement))).boundingBox();
        itemBounds.push({ id: item.id, part: isPart(item), separate: isPart(item) && meets === 'emboss' && placed.flat.pegged, engrave: meets === 'engrave', min: [...wb.min], max: [...wb.max] });
      }
    } finally {
      temps.dispose();
    }
    sketch.itemBounds = itemBounds;
    const box = boxOf(model);
    for (const ib of itemBounds) {
      if (ib.engrave || ib.separate) continue;
      for (let a = 0; a < 3; a++) {
        box.min[a] = Math.min(box.min[a], ib.min[a]);
        box.max[a] = Math.max(box.max[a], ib.max[a]);
      }
    }
    splitState(sketch).bounds = box;
    return sketch;
  }

  /** Lets go of the cheap measure's plane-frame copy (the model itself is the base's). */
  function releaseSketch() {
    if (sketch) releaseFrame(sketch);
    releaseAim(sketch);
    sketch = null;
  }

  /**
   * Each stored cut measured on the model, in list order (a cut that misses has joint 'miss'; one that comes apart
   * has its `apart` and the joint it gets, 'lip', 'dovetail' or 'none'). On the final result of a model that is not
   * dense, with the bed (`U`), also the pieces the download will hold (`pieces`, the box each comes from): the model is
   * cut as the split cuts it, as a box whose loose parts print apart is more than one piece.
   */
  function measureCuts(final, items, split, U, progress) {
    progress?.('Measuring the cuts…');
    const bounds = splitBounds(final);
    const { spec, cuts, notes } = normaliseSplit(split, bounds);
    const plan = platesFor(final, cuts, spec);
    // a dense model takes seconds to cut: its count waits for the pieces themselves
    let pieces = null;
    let laid = null;
    if (U && cuts.length && final.solid.numTri() <= Math.min(lodTriangles, splitKeepTriangles)) {
      try {
        laid = layCuts(final, items, cuts, spec, U, progress);
        pieces = laid.map((p) => ({ cell: p.cell }));
      } catch {
        pieces = null; // the pieces view or the download says what is wrong
        laid = null;
      }
    }
    // the side each lip will go on, as the pieces (or without them the boxes between the cuts) tell
    const lipped = cuts.some((c) => c.apart) ? lipSides(laid, cuts, U, spec.orient, { flat: laid ? slabOf(final) : null, clearance: spec.clearance, bounds }) : new Map();
    const temps = scope();
    try {
      const measured = (Array.isArray(split?.cuts) ? split.cuts : []).map((stored, i) => {
        const id = stored?.id ?? `c${i + 1}`;
        const letter = letterFor(i);
        const plane = cutPlane(stored);
        // a cut merged with another in the same place is measured as that one
        const kept = plane && cuts.find((c) => c.id === id || (c.axis === plane.axis && Math.abs(c.at - plane.at) < CUT_TOLERANCE));
        if (!kept) return { id, letter, axis: plane?.axis ?? null, at: plane?.at ?? null, area: 0, islands: 0, joint: 'miss', crosses: [] };
        const face = temps.add(frameOf(final, kept.axis).slice(kept.at));
        const islands = face.decompose().map((c) => temps.add(c)).filter((c) => c.area() >= 1).length;
        // a dovetail cut's tabs make the pieces either side longer, and lay them flat: `cellSizes` reads these
        const seam = plan.tabs?.seams.find((x) => x.cutId === kept.id);
        const tabs = seam?.tabs ?? [];
        const reach = (dir) => Math.max(0, ...tabs.filter((tb) => tb.dir === dir).map((tb) => tb.E));
        const joint = plan.joints[kept.id] ?? 'dowels';
        // a cut's built-in pegs make one of the pieces either side longer, as far as the longest peg its faces take
        // stands out (`pegSides` says which), and lay neither flat; so does the lip of a cut that comes apart
        const pegged = joint === 'pegs' && islands > 0;
        const lip = joint === 'lip' && islands > 0;
        // a lip on the side the pieces say it goes, else on the side the boxes fit best (`pegSides`)
        const side = lip ? lipped.get(kept.id) : undefined;
        return {
          id, letter, axis: kept.axis, at: plane.at, area: face.area(), islands, joint,
          crosses: textCrossing(final, items, kept, temps), ...(kept.id !== id ? { merged: kept.id } : {}),
          ...(kept.apart ? { apart: { ...kept.apart } } : {}),
          ...(tabs.length ? { tabs: tabs.length, reach: [reach(1), reach(-1)], w: seam.w ?? plan.tabs.w } : {}),
          ...(pegged ? { peg: pegAllowance(spec, [1, 2].map((k) => bounds.max[(kept.axis + k) % 3] - bounds.min[(kept.axis + k) % 3])) } : {}),
          ...(lip && side === undefined ? { peg: LIP_ALLOWANCE } : {}),
          ...(lip && side != null ? { reach: side === 0 ? [LIP_ALLOWANCE, 0] : [0, LIP_ALLOWANCE] } : {}),
        };
      });
      // the pegs go on the side the boxes fit best, as the pieces will have them: only boxes that make a piece count
      const filled = pieces ? new Set(pieces.map((p) => p.cell.join(','))) : null;
      const fits = U ? (c) => (filled && !filled.has(c.cell.join(','))) || cellFits(c, U) : null;
      const sided = pegSides(bounds, measured, fits).map(({ peg, ...c }) => c);
      return { bounds: { min: [...bounds.min], max: [...bounds.max] }, cuts: sided, notes, ...(pieces ? { pieces } : {}) };
    } finally {
      temps.dispose();
    }
  }

  /* --------------------------------------------- where a cut that comes apart goes */

  /**
   * What trying cuts keeps on a final result (or the measure's model): the
   * slices read while cuts are tried, by axis and height (simplified a
   * little, and trimmed to the last few hundred after each request), each
   * axis's profile and seams, the flat area the model ends in on each side,
   * and the last answers.
   */
  const aimState = (final) => (splitState(final).aim ??= { slices: new Map(), profiles: new Map(), ends: null, probes: new Map() });

  /** Lets go of what trying cuts kept on a result. */
  function releaseAim(final) {
    const aim = final?.split?.aim;
    if (!aim) return;
    aim.spotJob?.steps.return(); // a search for spots under way lets go of what it holds
    for (const cs of aim.slices.values()) cs.delete();
    final.split.aim = null;
  }

  /** The model's slice at t along an axis (plane frame), as trying cuts reads it: kept, and borrowed until `trimAim`. */
  function aimSlice(final, axis, t) {
    const { slices } = aimState(final);
    const key = `${axis}|${t.toFixed(6)}`;
    let cs = slices.get(key);
    if (cs) slices.delete(key);
    else {
      const raw = frameOf(final, axis).slice(t);
      cs = raw.simplify(AIM_TOLERANCE);
      raw.delete();
    }
    slices.set(key, cs); // the newest last, so the oldest go first
    return cs;
  }

  /** Keeps the last few hundred slices trying cuts read: only between requests, as a request borrows them. */
  function trimAim(final) {
    const slices = final.split?.aim?.slices;
    while (slices && slices.size > AIM_SLICES) {
      const [oldest] = slices.keys();
      slices.get(oldest).delete();
      slices.delete(oldest);
    }
  }

  /**
   * The flat area the model ends in at each end of each axis, and the box
   * it spans (`endShape`), for which piece would print as well with a lip;
   * read once, from `mesh` when the caller has it.
   */
  function aimEnds(final, mesh = null) {
    const aim = aimState(final);
    aim.ends ??= endShape(mesh ?? final.solid.getMesh());
    return aim.ends;
  }

  /**
   * Seams found between two heights each (`[lo, hi]`, along an axis) put on
   * the model's own corners: the height of a corner within each, the one
   * nearest its middle – a ledge's face lies on its corners, and a cut there
   * is in the face itself, not a hair beside it – else the middle. One pass
   * over the mesh's corners for all of them.
   */
  function onCorners(mesh, axis, brackets) {
    const best = brackets.map(() => null);
    const { vertProperties: P, numProp: n } = mesh;
    for (let i = axis; i < P.length; i += n) {
      const h = P[i];
      brackets.forEach(([lo, hi], k) => {
        const mid = (lo + hi) / 2;
        if (h >= lo && h <= hi && (best[k] === null || Math.abs(h - mid) < Math.abs(best[k] - mid))) best[k] = h;
      });
    }
    return brackets.map(([lo, hi], k) => best[k] ?? Math.round(((lo + hi) / 2) * 1000) / 1000);
  }

  /** A ring's area, twice over and signed: positive for an outline, negative for a hole. */
  function twiceArea(ring) {
    let twice = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % ring.length];
      twice += x0 * y1 - x1 * y0;
    }
    return twice;
  }

  /** A slice's area, perimeter, islands and holes (1 mm² or more) and the outline length of its widest island. */
  function sectionFacts(cs, polygons = polygonsOf(cs)) {
    let islands = 0;
    let holes = 0;
    let widest = 0;
    for (const ring of polygons) {
      const twice = twiceArea(ring);
      if (twice >= 2) {
        islands++;
        widest = Math.max(widest, perimeterOf([ring]));
      } else if (twice <= -2) holes++;
    }
    return { area: cs.area(), perimeter: perimeterOf(polygons), islands, holes, widest };
  }

  /** How far the outline moves from one slice to another: the area they do not share over their mean perimeter (mm). */
  function shiftOf(a, fa, b, fb) {
    const both = a.intersect(b);
    const apart = Math.max(0, fa.area + fb.area - 2 * both.area());
    both.delete();
    const perimeter = (fa.perimeter + fb.perimeter) / 2;
    return perimeter > 1e-9 ? apart / perimeter : 0;
  }

  /** A slice as it is seen from outside: each island with its holes filled (the caller deletes it). */
  function outsideOf(cs, polygons = polygonsOf(cs)) {
    const outer = polygons.filter((ring) => twiceArea(ring) > 0);
    return new wasm.CrossSection(outer, 'Positive');
  }

  /**
   * A slice as the outside shows it, for how well a seam hides a cut: its
   * openings narrower than twice `SPOT.bridge` closed over, then each
   * island's holes filled – twelve posts between narrow windows and the ring
   * over their tips are one outline, as the lantern's silhouette is (the
   * caller deletes it).
   */
  function seenOf(cs) {
    const grown = cs.offset(SPOT.bridge, 'Round', 2, 32);
    const closed = grown.offset(-SPOT.bridge, 'Round', 2, 32);
    grown.delete();
    const seen = outsideOf(closed);
    closed.delete();
    return seen;
  }

  /**
   * The islands of slice `p` that the slice `q` beside it also holds
   * something of: one that ends there with nothing past it is a shell of its
   * own coming to its end (a second box beside the first, its lid printed
   * alongside), no seam of the others. Null when every island goes on (the
   * caller deletes what it gets).
   */
  function goingOn(p, q) {
    const parts = p.decompose();
    try {
      const kept = parts.filter((x) => {
        const both = x.intersect(q);
        const shared = both.area();
        both.delete();
        return shared > Math.max(1e-3, 1e-3 * x.area());
      });
      return kept.length === parts.length ? null : wasm.CrossSection.compose(kept);
    } finally {
      parts.forEach((x) => x.delete());
    }
  }

  /** Whether some hole of slice `p` has solid over at least half of it in slice `q`: walls starting from a floor, or closing over. */
  function holeCovered(p, q) {
    return polygonsOf(p).some((ring) => {
      if (!(twiceArea(ring) <= -2)) return false;
      const hole = new wasm.CrossSection([ring], 'NonZero');
      const both = hole.intersect(q);
      const covered = both.area() >= 0.5 * hole.area();
      both.delete();
      hole.delete();
      return covered;
    });
  }

  /**
   * The heights where the model has a face square to the axis, in order, and
   * which ways the faces there look: up (towards +axis) and down. A groove
   * round a lid is a face looking up with one looking down just over it, a
   * rib the other way round.
   * @returns {{ at: number, up: boolean, down: boolean }[]}
   */
  function flatSides(mesh, axis) {
    const { vertProperties: P, numProp, triVerts: T } = mesh;
    const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
    const seen = new Map();
    for (let t = 0; t + 2 < T.length; t += 3) {
      const a = T[t] * numProp;
      const b = T[t + 1] * numProp;
      const c = T[t + 2] * numProp;
      const du = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
      const dv = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const len = Math.hypot(du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]);
      const n = du[u] * dv[v] - du[v] * dv[u];
      if (!(len > 0) || !(Math.abs(n) / len > 0.999)) continue;
      const at = Math.round(P[a + axis] * 1000) / 1000;
      const side = seen.get(at) ?? { at, up: false, down: false };
      side[n > 0 ? 'up' : 'down'] = true;
      seen.set(at, side);
    }
    return [...seen.values()].sort((p, q) => p.at - q.at);
  }

  /**
   * The span along an axis of each shell of a mesh – each set of triangles
   * joined by their corners – as [min, max]: one of two boxes printed side by
   * side ends where it ends, which says nothing of the other.
   */
  function shellSpans(mesh, axis) {
    const { vertProperties: P, numProp, triVerts: T, mergeFromVert, mergeToVert } = mesh;
    const n = P.length / numProp;
    const parent = new Int32Array(n).map((_, i) => i);
    const root = (i) => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    const join = (i, j) => {
      const [a, b] = [root(i), root(j)];
      if (a !== b) parent[a] = b;
    };
    for (let t = 0; t + 2 < T.length; t += 3) {
      join(T[t], T[t + 1]);
      join(T[t], T[t + 2]);
    }
    for (let k = 0; k < (mergeFromVert?.length ?? 0); k++) join(mergeFromVert[k], mergeToVert[k]);
    const spans = new Map();
    for (let t = 0; t < T.length; t++) {
      const r = root(T[t]);
      const h = P[T[t] * numProp + axis];
      const span = spans.get(r);
      if (span) {
        span[0] = Math.min(span[0], h);
        span[1] = Math.max(span[1], h);
      } else spans.set(r, [h, h]);
    }
    return [...spans.values()];
  }

  /**
   * What a seam between two slices `below` and `above` (a hair apart) is,
   * and how far the outline the outside shows moves there (`outer`, mm,
   * `seenOf`). Where a shell of the model ends or starts there (`ends`), it
   * is judged on the islands that go on past it (`goingOn`), and is null
   * where those are the same on both sides: a box beside them only ended.
   * @returns {{ kind: string, outer: number }|null}
   */
  function seamOf(below, above, { ends = false } = {}) {
    const t = scope();
    try {
      const lower = ends ? goingOn(below, above) : null;
      const upper = ends ? goingOn(above, below) : null;
      const [p, q] = [lower ? t.add(lower) : below, upper ? t.add(upper) : above];
      const [fp, fq] = [sectionFacts(p), sectionFacts(q)];
      if ((lower || upper) && fp.islands === fq.islands && fp.holes === fq.holes && !(shiftOf(p, fp, q, fq) >= SPOT.least)) return null;
      const gone = (x, y) => t.add(x.subtract(y)).area();
      const facts = (x) => ({ area: x.area(), perimeter: perimeterOf(polygonsOf(x)) });
      const change = (x, y) => ({ shift: shiftOf(x, facts(x), y, facts(y)), gained: gone(y, x), lost: gone(x, y) });
      // what changes, from the outline seen from outside; how well it hides, from the one the outside shows
      const outer = change(t.add(outsideOf(p)), t.add(outsideOf(q)));
      const seen = change(t.add(seenOf(p)), t.add(seenOf(q)));
      const holes = fp.holes !== fq.holes ? { floored: holeCovered(q, p), capped: holeCovered(p, q) } : {};
      return { kind: seamKind({ below: fp, above: fq, gained: gone(q, p), lost: gone(p, q), outer, ...holes }), outer: Math.round(seen.shift * 1000) / 1000 };
    } finally {
      t.dispose();
    }
  }

  /**
   * The model's profile along an axis, for placing a cut that comes apart:
   * slices as far apart as the planner samples (`planSamples`), on the
   * half-millimetre steps cuts are tried on, and one between two faces
   * square to the axis that look at each other or away from each other where
   * none of those lies between them – a groove 1 mm tall round a tall box's
   * lid, or a rib, would otherwise fall between two samples (`flatSides`) –
   * each with its area, perimeter, islands, holes
   * and widest island and how far the outline moves on to the next – the
   * slice's own outline, or as seen from outside where that moves further (a
   * groove round a thin wall moves only the outside of the slice's two
   * rings); and its seams, where the outline moves at once or its islands or
   * holes change (`profileSeams`), each narrowed down to 0.002 mm
   * (`locateSeam`), or where straight sides bend into a slope or out of one
   * (`locateBend`), and put on a corner of the model when one lies there – a
   * ledge's face is the seam itself, not a hair beside it – with the kind of
   * change it is (`seamKind`, or 'slopes' and 'straightens' for a bend), how
   * far the outline moves there, and how far the outline the outside shows
   * moves (`outer`, `seenOf`, which says how well a cut there hides). Where
   * one shell of a model of several ends or starts, its islands are no seam
   * of the shells beside it, which are judged without them (`seamOf`). Kept
   * with the result, per axis.
   * @returns {{ lo: number, hi: number, samples: object[], seams: { at: number, kind: string, shift: number,
   *   outer: number }[], flats: number[] }} `flats` the heights of the model's faces square to the axis
   */
  function aimProfile(final, axis, progress) {
    const aim = aimState(final);
    if (aim.profiles.has(axis)) return aim.profiles.get(axis);
    const box = boxOf(final.solid);
    const lo = box.min[axis];
    const hi = box.max[axis];
    const frame = frameOf(final, axis);
    // slices a little simplified: a dense model's outline has thousands of corners along each straight edge. The
    // samples' are the ones trying cuts reads (`aimSlice`), kept for the cuts tried next; the outline seen from
    // outside only once it is asked for: narrowing a seam down where islands change needs none
    const readAt = (t, kept = false) => {
      let cs;
      if (kept) cs = aimSlice(final, axis, t);
      else {
        const raw = frame.slice(t);
        cs = raw.simplify(AIM_TOLERANCE);
        raw.delete();
      }
      const rings = polygonsOf(cs);
      return { cs, kept, rings, facts: sectionFacts(cs, rings), out: null, outside: null };
    };
    const seen = (r) => {
      if (!r.out) {
        r.out = outsideOf(r.cs, r.rings);
        r.outside = { area: r.out.area(), perimeter: perimeterOf(polygonsOf(r.out)) };
      }
      return r;
    };
    const release = (r) => {
      if (!r.kept) r.cs.delete();
      r.out?.delete();
    };
    const moved = (p, q) => Math.max(shiftOf(p.cs, p.facts, q.cs, q.facts), shiftOf(seen(p).out, p.outside, seen(q).out, q.outside));
    // the outline seen from outside, from one slice to the next: how far it moves, and the area it gains and loses
    const outsideChange = (p, q) => {
      const gone = (x, y) => {
        const d = x.subtract(y);
        const area = d.area();
        d.delete();
        return area;
      };
      [p, q].forEach(seen);
      return { shift: shiftOf(p.out, p.outside, q.out, q.outside), gained: gone(q.out, p.out), lost: gone(p.out, q.out) };
    };
    // the mesh once: the faces square to the axis, the seams onto its corners, and how flat its ends are
    const mesh = final.solid.getMesh();
    aimEnds(final, mesh);
    // samples as far apart as the planner's (a millimetre, or a two-hundredth of the model), on the half-millimetre
    // steps cuts are tried on, so the cuts tried next find them read; and one between each face looking up and the
    // next one, looking down, over it (a groove) – or the other way round (a rib) – where none lies between them
    const spacing = SPOT.step * Math.ceil(Math.max(1, (hi - lo) / 200) / SPOT.step - 1e-9);
    const planned = [];
    for (let k = Math.floor(lo / spacing) + 1; k * spacing < hi - 1e-9; k++) if (k * spacing > lo + 1e-9) planned.push(k * spacing);
    const flats = flatSides(mesh, axis);
    const extra = [];
    for (let k = 0; k + 1 < flats.length && extra.length < AIM_EXTRA; k++) {
      const [p, q] = [flats[k], flats[k + 1]];
      if (!((p.up && q.down) || (p.down && q.up))) continue;
      if (planned.some((t) => t > p.at && t < q.at)) continue;
      extra.push(Math.round(((p.at + q.at) / 2) * 1e6) / 1e6);
    }
    const heights = [...planned, ...extra].sort((p, q) => p - q);
    const samples = [];
    let prev = null;
    try {
      heights.forEach((t, i) => {
        progress?.('Reading the shape…', { done: i + 1, total: heights.length });
        const r = readAt(t, true);
        if (prev) samples[samples.length - 1].shift = moved(prev, r);
        if (prev) release(prev);
        prev = r;
        samples.push({ t, ...r.facts, shift: 0 });
      });
    } finally {
      if (prev) release(prev);
    }
    const found = [];
    let spans = null; // each shell's span along the axis, once a seam needs it
    for (const near of profileSeams(samples)) {
      const read = new Map(); // the slices this seam is narrowed down with, by height
      const at = (t) => {
        if (!read.has(t)) read.set(t, readAt(t));
        return read.get(t);
      };
      const shift = (x, y) => moved(at(x), at(y));
      try {
        if (near.by === 'bend') {
          const bend = locateBend(near.lo, near.hi, { shift, straight: near.straight });
          if (!bend) continue;
          // how much it bends as seen from outside: the walls' inside alone sloping (a chamfer within) hides nothing
          const [b0, b1, a0, a1] = [bend.at - BEND_GAP - SPOT.step, bend.at - BEND_GAP, bend.at + BEND_GAP, bend.at + BEND_GAP + SPOT.step].map(at);
          const rates = [outsideChange(b0, b1).shift, outsideChange(a0, a1).shift].map((v) => v / SPOT.step);
          found.push({
            lo: bend.at - BEND_CORNER, hi: bend.at + BEND_CORNER, kind: near.straight < 0 ? 'slopes' : 'straightens', shift: bend.shift,
            outer: Math.round(3 * Math.abs(rates[1] - rates[0]) * 1000) / 1000,
          });
          continue;
        }
        const seam = locateSeam(near.lo, near.hi, { by: near.by, shift, count: (x) => `${at(x).facts.islands}|${at(x).facts.holes}` });
        if (!seam) continue;
        // a shell of its own ending or starting here: as the profile's samples do not know which island is which
        spans ??= shellSpans(mesh, axis);
        const ends = spans.length > 1 && spans.some(([s0, s1]) => [s0, s1].some((e) => e >= seam.lo - 0.01 && e <= seam.hi + 0.01));
        const judged = seamOf(at(seam.lo).cs, at(seam.hi).cs, { ends });
        if (!judged) continue;
        found.push({ lo: seam.lo - SPOT.tolerance, hi: seam.hi + SPOT.tolerance, ...judged, shift: Math.round(seam.shift * 1000) / 1000 });
      } finally {
        for (const r of read.values()) release(r);
      }
    }
    onCorners(mesh, axis, found.map((f) => [f.lo, f.hi])).forEach((t, k) => {
      const { kind, shift, outer } = found[k];
      found[k] = { at: t, kind, shift, outer };
    });
    // one seam where two samples' intervals found the same one, the sharper kept
    const seams = [];
    for (const s of found.sort((p, q) => q.shift - p.shift)) if (!seams.some((x) => Math.abs(x.at - s.at) < SPOT.step)) seams.push(s);
    seams.sort((p, q) => p.at - q.at);
    const made = { lo, hi, samples, seams, flats: flats.map((f) => f.at) };
    aim.profiles.set(axis, made);
    return made;
  }

  /**
   * A cut that comes apart tried at `at` on an axis (`probeLip` on the
   * model's slices): the face there, the lip it would get or why none, where
   * a full lip fits when this is short of one, and what comes off. Which
   * piece would print as well carrying the lip is guessed from the model's
   * ends and how slender each piece would stand (`endsAsWell`). Kept by
   * place and settings, so going back to a place answers at once. Where
   * the caller has no use for a move (`moves` false, `within`: see
   * `probeLip`), the answer says none that it has not looked for.
   */
  function aimAt(final, a, at, { hold, c, nozzle }, progress = null, { moves = true, within = null } = {}) {
    const aim = aimState(final);
    const key = `${a}|${at.toFixed(4)}|${hold}|${c}|${nozzle}${moves ? '' : '|still'}${within ? `|${within.join('/')}` : ''}`;
    if (aim.probes.has(key)) {
      const kept = aim.probes.get(key);
      aim.probes.delete(key);
      aim.probes.set(key, kept);
      return kept;
    }
    const profile = aimProfile(final, a, progress);
    const face = frameOf(final, a).slice(at);
    let area;
    let islands;
    let span = 0;
    try {
      area = face.area();
      const parts = face.decompose();
      islands = parts.filter((p) => p.area() >= 1).length;
      parts.forEach((p) => p.delete());
      if (!face.isEmpty()) {
        const { min, max } = face.bounds();
        span = (max[0] - min[0]) * (max[1] - min[1]);
      }
    } finally {
      face.delete();
    }
    const ends = aimEnds(final);
    const asWell = endsAsWell(ends.beds[a], area, { lengths: [at - profile.lo, profile.hi - at], spans: ends.spans[a], faceSpan: span });
    const r = probeLip(final.solid, { axis: a, at }, { c, nozzle, hold, bounds: boxOf(final.solid), asWell, sliceAt: (t) => aimSlice(final, a, t), flats: profile.flats, moves, within });
    const answer = {
      axis: AXES[a], at, area, islands, lip: r.lip ? { H: r.lip.H, clips: r.lip.clips, why: r.lip.why, ...(r.lip.broken ? { broken: true } : {}) } : null, noLip: r.noLip,
      suggestedAt: r.suggestedAt, suggestedLip: r.suggestedLip,
      comesOff: at > profile.lo && at < profile.hi ? comesOffOf(profile.samples, { lo: profile.lo, hi: profile.hi, axis: a, at, area }) : null,
    };
    aim.probes.set(key, answer);
    while (aim.probes.size > AIM_PROBES) aim.probes.delete(aim.probes.keys().next().value);
    return answer;
  }

  /** Whether a probe's lip is a full one: 6 mm, with clips on a hold that has them (`bare`: with or without). */
  const fullLip = (lip, hold, c, bare = false) => Boolean(lip) && lip.H >= LIP.heights[0] && (bare || lip.clips > 0 || !catchSizes(hold, c));

  /**
   * The best places along an axis for a cut that comes apart (`mode:
   * 'spots'`): beside each seam, on the side that leaves its shape whole with
   * its own piece (`spotSide`), the first 0.5 mm step away from it is tried,
   * and the next step out where that one's lip is short even of a full one
   * without clips, or its tongue comes in stretches (just over the tips of a
   * row of windows an opening's edge in the tongue's foot cuts it between
   * them; half a step further it is whole), or where it has none and the
   * moves would go further than that (just under a groove the first step may
   * leave the piece past it no room, the next a full lip); short of a full
   * lip in one piece at either, the place the layout's moves give one, if
   * that keeps to the seam – on its side, within 20 mm of it and with no
   * other seam between (`keepsTo`) – and tried there. Of those the nearest
   * with a full lip in one piece is kept, else the nearest with one in
   * stretches, which scores less. A place that runs
   * through letters is tried again just clear of them, on either side, if
   * that keeps to the seam too. A groove round the model – where it narrows
   * and widens again within 6 mm, the two seams' sides facing – that holds no
   * spot of its own (a lip needs more wall than a groove leaves) is kept
   * whole with one piece: its spots are tried just under and just over it,
   * in the plain wall either side. A wider band (the wall between a band of
   * gargoyles and a roof's eaves) is no groove: a cut just past it would leave
   * a thin plate of what stands out. Each found is scored (`spotScore`: the
   * lip, the seam it hides in as seen from outside, what comes off, its
   * islands, the letters it cuts), and the best kept, 8 mm apart
   * (`pickSpots`); one that would take off three quarters of the model or
   * more is no spot for a top or a lid. On a hold with clips, a seam is tried
   * at first only where some island near it is wide enough for a clip; where
   * no place takes clips at all – a round wall has no straight stretch for
   * one, a small part none long enough – every seam is tried, and the places
   * with a full 6 mm lip without them are the spots.
   *
   * A generator: it yields before each place it has not tried yet, with how
   * far it has got (`{ done, total }`), so that the caller can hand the
   * engine to a cut being placed meanwhile and carry on after; it returns
   * the spots.
   */
  function* spotSteps(final, items, a, { hold, c, nozzle }, say) {
    say('Looking for good spots…');
    const profile = aimProfile(final, a, (_, d) => say('Looking for good spots…', d));
    const caught = catchSizes(hold, c);
    const room = caught ? 2 * (CLIP.span + 2 * CLIP.margin) : 0;
    const wide = (side, seam) => profile.samples.some((p) => (side < 0 ? p.t < seam.at && p.t >= seam.at - SPOT.look : p.t > seam.at && p.t <= seam.at + SPOT.look) && p.widest >= room);
    const places = profile.seams.map((s) => s.at);
    const letters = final.itemBounds.filter((b) => !b.part);
    const candidates = [];
    const temps = scope();
    const tried = new Map(); // the places tried, by height: what the probe said there
    let done = 0;
    const total = () => profile.seams.length;
    // a place that would take off three quarters of the model or more is no spot, so it is not tried: as the profile
    // tells it, with a little to spare for the face's own area there
    const tooMuch = (x) => comesOffOf(profile.samples, { lo: profile.lo, hi: profile.hi, axis: a, at: x, area: aimSlice(final, a, x).area() }).fraction >= 0.76;

    /** A spot tried at a place (the probe's answer there) kept as a candidate, unless it takes off too much: the letters it runs through. */
    const add = (r, seam, side, why) => {
      if (r.comesOff.fraction >= 0.75) return null;
      const crosses = textCrossing(final, items, { axis: a, at: r.at }, temps);
      const cap = seam.kind === 'narrows' && side > 0 && r.comesOff.fraction <= 0.15;
      candidates.push({
        axis: AXES[a], at: r.at, why: cap ? spotWhy(seam.kind, side, a, { cap }) : why, lip: { H: r.lip.H, clips: r.lip.clips }, comesOff: r.comesOff,
        score: Math.round(spotScore({
          full: true, clips: r.lip.clips, broken: !!r.lip.broken, shift: seam.outer, distance: Math.abs(r.at - seam.at), fraction: r.comesOff.fraction, islands: r.islands,
          crosses: crosses.length,
        }) * 1000) / 1000,
        seam: seam.at, islands: r.islands, ...(crosses.length ? { crosses } : {}),
      });
      return crosses;
    };

    /** The spots beside a seam on one side, said to be `why`, clips or no clips (`bare`): whether there were any. */
    const around = function* (seam, side, why = spotWhy(seam.kind, side, a), bare = false) {
      const before = candidates.length;
      const on = (x) => x != null && (x - seam.at) * side > 0 && Math.abs(x - seam.at) <= SPOT.look + 1e-9 && x > profile.lo && x < profile.hi && keepsTo(places, seam.at, side, x);
      // a place tried for its lip alone, or (`moves`) for where the moves go too, as far as they keep to the seam's side
      const within = side > 0 ? [seam.at + 1e-6, Math.min(profile.hi, seam.at + SPOT.look)] : [Math.max(profile.lo, seam.at - SPOT.look), seam.at - 1e-6];
      const probe = function* (x, moves = false) {
        if (!on(x) || tooMuch(x)) return null;
        const key = `${x.toFixed(4)}|${moves ? within.join('/') : ''}`;
        if (!tried.has(key)) {
          yield { done, total: total() };
          tried.set(key, aimAt(final, a, x, { hold, c, nozzle }, null, moves ? { within } : { moves: false }));
        }
        return tried.get(key);
      };
      const full = (r) => fullLip(r?.lip, hold, c, bare);
      const whole = (r) => full(r) && !r.lip.broken;
      // the step beside the seam; the next one out where that one's lip is short of a full one even without clips, or
      // in stretches, or where it has none and the moves go further than that; and where the moves say: the nearest
      // with a full lip in one piece, else one in stretches
      const start = spotStart(seam.at, side);
      const first = yield* probe(start, true);
      if (!first) return false;
      const steps = [first];
      const further = first.lip ? !fullLip(first.lip, hold, c, true) || first.lip.broken : on(first.suggestedAt) && Math.abs(first.suggestedAt - start) > SPOT.step + 1e-9;
      if (further) {
        const next = yield* probe(start + side * SPOT.step);
        if (next) steps.push(next);
      }
      if (!steps.some(whole)) {
        const moved = yield* probe(first.suggestedAt);
        if (moved) steps.push(moved);
      }
      const found = steps.find(whole) ?? steps.find(full);
      if (!found) return false;
      const crosses = add(found, seam, side, why);
      if (crosses?.length) {
        // through letters: the steps just clear of them, below and above, with as good a lip there
        const over = letters.filter((b) => crosses.includes(b.id));
        for (const x of [spotStart(Math.min(...over.map((b) => b.min[a])), -1), spotStart(Math.max(...over.map((b) => b.max[a])), 1)]) {
          const r = yield* probe(x);
          if (r && fullLip(r.lip, hold, c, !(found.lip.clips > 0)) && !(r.lip.broken && !found.lip.broken)) add(r, seam, side, why);
        }
      }
      return candidates.length > before;
    };

    try {
      /** Every seam's spots, and a groove's with no spot inside just under and just over it: those with clips first. */
      const all = function* (bare) {
        const held = new Set(); // the seams with spots of their own
        for (const [n, seam] of profile.seams.entries()) {
          say('Looking for good spots…', { done: n + 1, total: total() });
          if (bare || wide(spotSide(seam.kind), seam)) if (yield* around(seam, spotSide(seam.kind), undefined, bare)) held.add(seam);
          done = n + 1;
        }
        for (const [k, seam] of profile.seams.entries()) {
          const next = profile.seams[k + 1];
          if (seam.kind !== 'narrows' || next?.kind !== 'widens' || next.at - seam.at > SPOT.groove || held.has(seam) || held.has(next)) continue;
          if (bare || wide(-1, seam)) yield* around(seam, -1, spotWhy('groove', -1, a), bare);
          if (bare || wide(1, next)) yield* around(next, 1, spotWhy('groove', 1, a), bare);
        }
      };
      yield* all(!caught);
      // on a hold with clips, places without them only where none takes clips: then at every seam, however narrow
      const clipped = candidates.filter((s) => s.lip.clips > 0);
      if (caught && clipped.length) return pickSpots(clipped);
      if (caught) {
        candidates.length = 0;
        yield* all(true);
      }
      return pickSpots(candidates);
    } finally {
      temps.dispose();
    }
  }

  /**
   * The spots along an axis (`spotSteps`): in one go, or with a `budget`
   * (ms) as far as that takes them, then `{ partial: { done, total } }`; the
   * next request for the same spots carries on where this one stopped (the
   * search is kept with the result, one at a time), and a probe or a measure
   * asked for meanwhile goes in between.
   */
  function spotsFor(final, items, a, settings, progress, budget = null) {
    const aim = aimState(final);
    const key = `${a}|${settings.hold}|${settings.c}|${settings.nozzle}|${stableKey(items)}`;
    if (aim.spotJob?.key !== key) {
      aim.spotJob?.steps.return();
      const job = { key, say: null, at: null };
      job.steps = spotSteps(final, items, a, settings, (stage, d) => {
        job.at = d ?? job.at;
        job.say?.(stage, d);
      });
      aim.spotJob = job;
    } else if (aim.spotJob.at) progress?.('Looking for good spots…', aim.spotJob.at);
    const job = aim.spotJob;
    job.say = progress;
    const until = Date.now() + (budget > 0 ? budget : Infinity);
    try {
      for (;;) {
        const step = job.steps.next();
        if (step.done) {
          aim.spotJob = null;
          return { spots: step.value };
        }
        if (Date.now() >= until) return { partial: step.value };
      }
    } catch (err) {
      aim.spotJob = null;
      throw err;
    } finally {
      job.say = null;
    }
  }

  /**
   * Placing a cut that comes apart (`split.plan` modes 'probe', 'spots' and
   * 'targets'): on the final result when it is built, else – while the text
   * is edited – on the model alone, as the measure is (`estimate: true`);
   * never building the final result, and never cutting. A cut tried is
   * tried on its own: the split's other cuts are not about. `hold` is the
   * hold it would have ('lock' when not given), and the split's clearance
   * and the printer's nozzle size its lip. See the protocol at the top; what
   * it reads is kept with the result (`aimState`), so a place tried again,
   * or near one tried before, answers at once.
   */
  function aimRequest({ items, baseVersion, printing, split = null, mode, axis = 'z', at = null, hold = 'lock', budget = null }, progress) {
    const a = typeof axis === 'number' ? axis : AXES.indexOf(String(axis).toLowerCase());
    if (!(a >= 0 && a <= 2)) fail('INTERNAL', `Unknown axis "${axis}"`);
    const estimate = sketchWill(items, baseVersion);
    const final = estimate ? sketchFor(items, baseVersion) : finalFor(items, baseVersion, printing, progress);
    const unavailable = base.kind !== 'none' && !base.current?.watertight;
    const notes = unavailable ? [splitNote('SPLIT_UNAVAILABLE')] : [];
    const extra = estimate ? { estimate: true } : {};
    if (unavailable || !final.solid) {
      if (mode === 'spots') return { message: { axis: AXES[a], spots: [], notes, ...extra }, transfer: [] };
      if (mode === 'targets') return { message: { axis: AXES[a], lo: null, hi: null, seams: [], notes, ...extra }, transfer: [] };
      return { message: { axis: AXES[a], at, area: 0, islands: 0, lip: null, noLip: 'miss', suggestedAt: null, comesOff: null, crosses: [], seams: [], notes, ...extra }, transfer: [] };
    }
    const { spec } = normaliseSplit({ ...(split ?? {}), cuts: [] });
    const settings = { hold: APART_HOLDS.includes(hold) ? hold : 'lock', c: spec.clearance, nozzle: printing?.nozzle ?? 0.4 };
    const seamsOf = (profile) => profile.seams.map(({ at: t, kind, shift }) => ({ at: t, kind, shift }));
    try {
      if (mode === 'targets') {
        const profile = aimProfile(final, a, progress);
        return { message: { axis: AXES[a], lo: profile.lo, hi: profile.hi, seams: seamsOf(profile), notes, ...extra }, transfer: [] };
      }
      if (mode === 'spots') {
        const { spots, partial } = spotsFor(final, items, a, settings, progress, budget);
        if (partial) return { message: { axis: AXES[a], partial: true, ...partial, notes, ...extra }, transfer: [] };
        return { message: { axis: AXES[a], spots, seams: seamsOf(aimProfile(final, a)), notes, ...extra }, transfer: [] };
      }
      if (!Number.isFinite(at)) fail('INTERNAL', 'A probe needs a place along the axis (at)');
      const answer = aimAt(final, a, at, settings, progress);
      const temps = scope();
      let crosses;
      try {
        crosses = textCrossing(final, items, { axis: a, at }, temps);
      } finally {
        temps.dispose();
      }
      return { message: { ...answer, crosses, seams: seamsOf(aimProfile(final, a)), notes, ...extra }, transfer: [] };
    } finally {
      trimAim(final);
    }
  }

  /**
   * Fit to my printer: see `planSplitRequest`. Every piece is judged the
   * way it will really print: a thin plate is planned lying flat and never
   * cut through its thickness (a thicker slab, such as a plaque, lying flat
   * when some grid allows it), a cut through a flat plate that takes
   * dovetail tabs makes the pieces either side lie flat and reach a tab's
   * length past it, a box that holds none of the model is no piece, and a
   * piece must lie on one of its cut faces or on something flat of the
   * model's (a ball's quarter cannot stand on its pole). The box planned in
   * takes in the unrepaired triangles, which go in the end pieces' files,
   * but cuts go only through the solid. Grids come fewest boxes first; the
   * first count for which some grid's pieces all fit is planned, the grid
   * with the fewest real pieces winning, then the cheapest – the support its
   * pieces need counted in, so a U is cut across its legs into pieces that
   * stand rather than along its depth into halves that lie on one leg. A
   * cut through a plate is planned with dovetail tabs only where the pieces
   * beside it can lie flat on the plate. When no grid's pieces can all lie
   * on something flat, they are planned as they fit. Its `pieces` are the
   * boxes that hold model, each with its `cell`: `planPieces` makes them the
   * pieces the cut gives. The cuts that come apart (`kept`, `keptCutsOf`)
   * are never moved or left out: the other cuts are planned round them, each
   * reaching a lip's height past it on one side, and they come back first,
   * as they are stored (`APART_KEPT`); when the pieces they make fit
   * already, they alone come back (`SPLIT_NOT_NEEDED` with `apart`).
   */
  function fitCuts(final, items, split, U, nozzle, kept, progress) {
    progress?.('Planning cuts…');
    const solidBox = splitBounds(final);
    const bounds = withSoup(solidBox, final.passthrough);
    const { spec } = normaliseSplit({ ...(split ?? {}), cuts: [] });
    const E = [0, 1, 2].map((a) => bounds.max[a] - bounds.min[a]);
    const flat = plateAxis(E);
    const whole = fitsBed(E, U, { flat });
    if (whole.fits && !kept.length) {
      return { cuts: [], counts: [0, 0, 0], pieces: [{ size: E, fits: true }], notes: [splitNote('SPLIT_NOT_NEEDED', { yaw: whole.yaw, down: whole.down })] };
    }
    let mesh = null;
    // the cuts that come apart are lettered first once the plan is taken, as they come first in it
    const keptLetters = kept.map((_, i) => letterFor(i));
    const fixedAt = [0, 1, 2].map((a) => kept.filter((c) => c.axis === a).map((c) => c.at));
    if (kept.length) {
      // with them alone the pieces may fit already, each lip counted on the piece it fits best on, as `apartMales` gives
      // the lip to a piece that still fits
      const by = axisCuts(kept);
      const held = cellSupport((mesh ??= final.solid.getMesh()), by);
      const isPiece = (c) => held.get(c.cell.join(','))?.filled !== false;
      const fits = (c) => !isPiece(c) || cellFits(c, U);
      const boxes = cellSizes(bounds, pegSides(bounds, kept.map((c) => ({ ...c, peg: LIP_ALLOWANCE })), fits)).cells.filter(isPiece);
      if (boxes.every((c) => cellFits(c, U))) {
        return {
          cuts: kept.map((c) => c.stored), counts: by.map((list) => list.length), pieces: boxes.map(({ cell, size }) => ({ cell, size, fits: true })),
          notes: [splitNote('SPLIT_NOT_NEEDED', { apart: keptLetters })],
        };
      }
    }
    // a slab too thick for a plate (a 15 mm plaque) is best printed lying flat too: stood on its edge it is a tall
    // wall with its face upright. Its pieces are planned lying flat first, and only stand when no grid of flat ones
    // works; so are those of a model on a base plate (a terrain tile with a tower on it), which would be walls of it
    const slab = slabAxis(E) ?? (flat === null ? baseAxis(modelPlates((mesh ??= final.solid.getMesh()).vertProperties, mesh.numProp, mesh.triVerts)) : null);
    const ways = slab === null ? [flat] : [slab, null];
    // tabs only make pieces longer, so the grids whose plain even cells fit are the only ones worth a profile; a grid
    // with fewer cuts on an axis than come apart there is none
    const minCounts = kept.length ? fixedAt.map((list) => list.length) : null;
    const candidatesOf = new Map(ways.map((lying) => [lying, gridCandidates(E, U, { flat: lying, minCounts }).filter((c) => c.pieces > 1)]));
    const tooMany = { cuts: [], counts: null, pieces: [], notes: [splitNote('PLAN_TOO_MANY')] };
    if (![...candidatesOf.values()].some((list) => list.length)) return tooMany;
    // the pieces at either end must take a hole (or a peg's socket) and its wall, and middle ones one from each side
    const pegged = spec.joint === 'pegs';
    const sizes = pegged ? (d, ...rest) => pegSizesFor(pegSizeOf(d) || 5, ...rest) : (d, ...rest) => sizesFor(d || 5, ...rest);
    const probe = sizes(spec.diameter, spec.clearance, nozzle, spec.depth);
    const pins = sizes(5, spec.clearance, nozzle);
    const minEnd = probe.reach + 1;
    const minMid = 2 * probe.reach + 1;
    const tabsOn = (spec.joint === 'auto' || spec.joint === 'dovetail' || pegged) && !final.passthrough.length;
    // built-in pegs make one of the pieces either side of every other cut longer, as far as the longest peg the cut's
    // faces take stands out
    const solidE = [0, 1, 2].map((a) => solidBox.max[a] - solidBox.min[a]);
    const peg = [0, 1, 2].map((a) => (pegged ? pegAllowance(spec, [solidE[(a + 1) % 3], solidE[(a + 2) % 3]]) : 0));
    const text = final.itemBounds.filter((b) => !b.part);
    const temps = scope();
    try {
      const profiles = new Map();
      const slices = new Map(); // shared by the profiles of one axis: their samples often coincide
      const progressOf = { done: 0, total: 0 };
      let letters = null;
      /** The cost of a cut at each sample of an axis for k cuts on it, and the tabs a cut there would have. */
      const profileOf = (a, k) => {
        const key = `${a}|${k}`;
        if (profiles.has(key)) return profiles.get(key);
        if (letters?.axis !== a) letters = { axis: a, solids: text.map((b) => ({ b, m: null })) };
        const grid = planSamples(solidBox.min[a], solidBox.max[a], k);
        // further apart than 2 mm, the samples cannot tell a cut that runs right beside a letter: it is looked for, and
        // the middle of each gap between letters is a sample too, the place furthest from both
        const apart = grid.length > 1 ? grid[1] - grid[0] : 0;
        const gapped = apart > 2 && text.length ? withGaps(grid, (t) => lettersAt(letters, items, a, t, temps)) : grid;
        // the cuts that come apart are samples too, exactly where they are
        const own = fixedAt[a];
        const samples = own.length ? [...gapped.filter((t) => !own.some((f) => Math.abs(f - t) <= 1e-6)), ...own].sort((p, q) => p - q) : gapped;
        progressOf.total += samples.length;
        // whether a face has room for pins is judged where the model runs a hole's reach either side too: the samples
        // nearest there are looked at, so each is sliced once, and kept only while a sample within reach may need it
        const kept = new Map();
        const faceAt = (x) => {
          if (!kept.has(x)) kept.set(x, frameOf(final, a).slice(x));
          return kept.get(x);
        };
        const nearest = (x) => {
          if (x < solidBox.min[a] || x > solidBox.max[a]) return null; // past the model's end: nothing there
          let lo = 0;
          let hi = samples.length - 1;
          while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (samples[mid] <= x) lo = mid;
            else hi = mid;
          }
          return Math.abs(samples[hi] - x) < Math.abs(samples[lo] - x) ? samples[hi] : samples[lo];
        };
        const profile = [];
        try {
          for (const t of samples) {
            progress?.('Planning cuts…', { done: ++progressOf.done, total: progressOf.total });
            const at = `${a}|${t.toFixed(6)}`;
            if (!slices.has(at)) {
              const face = faceAt(t);
              const beside = [-pins.reach, pins.reach].map((d) => nearest(t + d)).map((x) => (x === null ? null : faceAt(x)));
              const plate = tabsOn ? tabsAcross(face, { axis: a, at: t }) !== null : false;
              const cut = lettersAt(letters, items, a, t, temps);
              const near = !cut && apart > 2 ? [-2, -1, 1, 2].some((d) => lettersAt(letters, items, a, t + d, temps)) : undefined;
              slices.set(at, { t, ...sliceStats(face, pins, beside), letters: cut, nearLetters: near, plate });
            }
            profile.push(slices.get(at));
            for (const [x, face] of kept) {
              if (x >= t - pins.reach - Math.max(apart, 1)) continue;
              face.delete();
              kept.delete(x);
            }
          }
        } finally {
          for (const face of kept.values()) face.delete();
        }
        // a plate's tabs need it to stay flat out to about an even piece's length either side
        const reach = (bounds.max[a] - bounds.min[a]) / (k + 1);
        const snap = (x) => samples.reduce((best, t) => (Math.abs(t - x) < Math.abs(best - x) ? t : best), samples[0]);
        const probed = scope();
        let tabs;
        try {
          const faces = new Map();
          const faceAt = (x) => {
            if (!faces.has(x)) faces.set(x, probed.add(frameOf(final, a).slice(x)));
            return faces.get(x);
          };
          tabs = profile.map((p) => {
            const pegs = peg[a] > 0 && p.area > 0 ? { below: peg[a], above: peg[a], peg: true } : null;
            if (!p.plate) return pegs;
            const probes = flatProbes(p.t, Math.max(bounds.min[a], p.t - reach), Math.min(bounds.max[a], p.t + reach)).map(snap);
            return tabsAcross(faceAt(p.t), { axis: a, at: p.t }, { sliceAt: faceAt, probes }) ?? pegs;
          });
        } finally {
          probed.dispose();
        }
        const made = { samples, costs: planCost(profile, { items: text.map((b) => [b.min[a], b.max[a]]) }), tabs, rings: profile.map((p) => p.rings) };
        profiles.set(key, made);
        return made;
      };
      // what each box of a grid holds: whether it is a piece at all, and what it could lie on
      const held = new Map();
      const support = (by) => {
        const key = by.map((l) => l.join(',')).join('|');
        if (!held.has(key)) {
          mesh ??= final.solid.getMesh();
          held.set(key, cellSupport(mesh, by));
        }
        return held.get(key);
      };
      const centre = bounds.min.map((v, a) => (v + bounds.max[a]) / 2);
      for (const stable of [true, false]) {
        for (const lying of ways) {
          const candidates = candidatesOf.get(lying);
          for (const group of new Set(candidates.map((c) => c.pieces))) {
            let best = null;
            for (const { k } of candidates.filter((c) => c.pieces === group)) {
              const plan = planGrid(k, { E, U, bounds, flat: lying, minEnd, minMid, profileOf, support, stable, peg, ...(kept.length ? { fixed: fixedAt } : {}) });
              // an L leaves a box empty: fewer pieces win, then the cost; candidates come fewest axes first, then fewest
              // Z cuts, so an equal cost keeps the earlier one
              if (plan && (!best || plan.pieces.length < best.pieces.length || (plan.pieces.length === best.pieces.length && plan.cost < best.cost - 1e-9))) best = plan;
            }
            if (!best) continue;
            // the cuts that come apart first, as they are stored, then the new ones
            const added = best.offsets.flatMap((list, a) =>
              list
                .filter((t) => !fixedAt[a].some((f) => Math.abs(f - t) <= 1e-6))
                .map((t) => ({ position: centre.map((c, i) => (i === a ? t : c)), normal: [0, 1, 2].map((i) => (i === a ? 1 : 0)) })),
            );
            const notes = kept.length ? [splitNote('APART_KEPT', { letters: keptLetters })] : [];
            return { cuts: [...kept.map((c) => c.stored), ...added], counts: best.k, pieces: best.pieces, notes };
          }
        }
      }
      return tooMany;
    } finally {
      temps.dispose();
      releaseFrame(final); // planning is done: the copy would only hold memory
    }
  }

  /**
   * Samples with the middle of every gap between letters added: where the
   * samples go from letters to none and back, the edges are found to 0.05 mm
   * (`cuts(t)` says whether a cut at t runs through letters).
   */
  function withGaps(samples, cuts) {
    const edge = (inLetters, clear) => {
      let [p, q] = [inLetters, clear];
      for (let i = 0; i < 8 && Math.abs(q - p) > 0.05; i++) {
        const m = (p + q) / 2;
        if (cuts(m)) p = m;
        else q = m;
      }
      return q;
    };
    const flags = samples.map(cuts);
    const added = [];
    let from = null; // where the gap in hand began, after a sample in letters
    for (let i = 1; i < samples.length; i++) {
      if (flags[i - 1] && !flags[i]) from = edge(samples[i - 1], samples[i]);
      else if (!flags[i - 1] && flags[i] && from !== null) {
        added.push((from + edge(samples[i], samples[i - 1])) / 2);
        from = null;
      }
    }
    return [...samples, ...added].sort((p, q) => p - q).filter((t, i, all) => i === 0 || t - all[i - 1] > 1e-6);
  }

  /** A box made to take in a triangle soup's points too (9 numbers per triangle). */
  function withSoup(box, soup) {
    const min = [...box.min];
    const max = [...box.max];
    for (let i = 0; i + 2 < (soup?.length ?? 0); i += 3) {
      for (let a = 0; a < 3; a++) {
        if (soup[i + a] < min[a]) min[a] = soup[i + a];
        if (soup[i + a] > max[a]) max[a] = soup[i + a];
      }
    }
    return { min, max };
  }

  /**
   * A slice of the model for the planner: its area, perimeter and islands
   * (of 1 mm² or more), how many of them have room for two pins of the
   * probe's size, and the share of its area on islands with no such room
   * (smaller than 50 mm², or too narrow once inset by ρ where the model
   * also runs a hole's reach either side of the face: `beside` holds the
   * slices there, null past the model's end). Without that a slanted wall
   * looks roomy: near the end of a round shell the ring is wide, but a hole
   * square to it breaks out a few mm in. With them its outline (`rings`, a
   * corner every millimetre or more), for which boxes of a grid hold model
   * there (`planGrid`). Borrows the slices.
   */
  function sliceStats(face, pins, beside = null) {
    const temps = scope();
    try {
      if (face.isEmpty()) return { area: 0, perimeter: 0, islands: 0, roomy: 0, noRoom: 0, rings: [] };
      const area = face.area();
      const outline = polygonsOf(face);
      const perimeter = perimeterOf(outline);
      let islands = 0;
      let roomy = 0;
      let bare = 0;
      const ends = (beside ?? []).includes(null); // a hole's reach from the model's end: no room anywhere
      let deep = null; // the face where the model runs on either side: made once, when an island is big enough to ask
      const deepFace = () => {
        if (!deep) {
          deep = face;
          for (const s of beside ?? []) deep = temps.add(deep.intersect(s));
        }
        return deep;
      };
      const list = face.decompose();
      try {
        for (const island of list) {
          const a = island.area();
          if (a < 1) continue;
          islands++;
          let room = false;
          if (a >= 50 && !ends) {
            const core = temps.add(island.intersect(deepFace()));
            // a dense outline is thinned a little first: insetting thousands of corners takes 50 times longer for
            // the same answer, and this is only a cost for the planner
            const thin = temps.add(core.simplify(0.05));
            const inset = temps.add(thin.offset(-pins.rho, 'Round', 2, 16));
            room = !inset.isEmpty() && spreadOf(polygonsOf(inset)) >= pins.sMin;
          }
          if (room) roomy++;
          else bare += a;
        }
      } finally {
        list.forEach((c) => c.delete());
      }
      return { area, perimeter, islands, roomy, noRoom: area > 0 ? Math.min(1, bare / area) : 0, rings: coarseOf(outline, 1) };
    } finally {
      temps.dispose();
    }
  }

  /** Whether a cut at t runs through any text item's letters (their solids made once per axis, in the plane frame). */
  function lettersAt(letters, items, axis, t, temps) {
    return letters.solids.some((entry) => {
      if (!(entry.b.min[axis] < t && entry.b.max[axis] > t)) return false;
      if (!entry.m) {
        const item = items.find((i) => i.id === entry.b.id);
        if (!item) return false;
        entry.m = itemInPlane(item, axis, temps);
      }
      return cutsThrough(entry.m, t);
    });
  }

  /**
   * The fit test: a small print to try the joints before printing the
   * pieces. Given the model (`items`, `baseVersion`) and a split with cuts,
   * it is made from what that split really uses – the pin size Auto chose,
   * pin holes only when some seam has pins, a peg and its socket at the size
   * the pegs have when some seam has built-in pegs, a dovetail whenever some
   * seam has tabs – by working the split out as the pieces view does
   * (cached, so the download after it costs nothing). Without them the
   * settings say: the pin size set (5 mm for Auto), a peg of the size set
   * (5 mm for Auto) when Joints is Built-in pegs, a dovetail when Joints is
   * Dovetails. `dovetail` forces the plates in or out. Where a cut comes
   * apart on a lip (or, without the model, where one is set to come apart)
   * it adds a small box and its lid with the same lip, held as that cut's
   * lip holds (`apart`: the hold of the first seam whose lip has clips,
   * 'lift' when none has). No pins, pegs, tabs or lip (glue only) gives no
   * file (`stl: null`).
   */
  function fitTest({ items = null, baseVersion = null, split = null, printing = null, bed = null, name = 'model', dovetail = null }, progress) {
    const { spec } = normaliseSplit({ ...(split ?? {}), cuts: [] });
    const pegJoint = spec.joint === 'pegs';
    const asked = (Array.isArray(split?.cuts) ? split.cuts : []).find((c) => c?.joint === 'apart');
    const uses = {
      pins: spec.joint !== 'none' && !pegJoint, pegs: pegJoint, dovetail: spec.joint === 'dovetail',
      diameter: spec.diameter || 5, pegSize: pegSizeOf(spec.diameter) || 5,
      apart: asked ? (APART_HOLDS.includes(asked.hold) ? asked.hold : 'snap') : null,
    };
    if (Array.isArray(items) && splitActive(split)) {
      const final = finalFor(items, baseVersion, printing, progress);
      const parted = splitFor(final, items, { split, bed, printing }, progress);
      if (parted?.cut) {
        uses.pins = parted.seams.some((s) => s.dowels.length > 0);
        uses.pegs = parted.seams.some((s) => s.pegs.length > 0);
        uses.dovetail = parted.cut.dovetails.length > 0;
        uses.diameter = parted.diameter ?? uses.diameter;
        uses.pegSize = parted.pegSize ?? uses.pegSize;
        // the hold the lip got, not the one asked for: a lip with no clips (no straight stretch, or cut short by a
        // roof) lifts off, and so does its coupon – one that clicks would tune a catch the model hasn't got
        const lipped = parted.seams.filter((s) => s.apart?.lip);
        const clicking = lipped.find((s) => s.apart.clips > 0 && s.apart.hold !== 'lift');
        uses.apart = clicking ? clicking.apart.hold : lipped.length ? 'lift' : null;
      }
    }
    if (dovetail !== null) uses.dovetail = Boolean(dovetail);
    const file = `${safeFileName(name)}-fit-test`;
    if (!uses.pins && !uses.pegs && !uses.dovetail && !uses.apart) {
      return { message: { stl: null, name: file, triangles: 0, diameter: null, pins: false, dovetail: false, pegs: false, pegSize: null, apart: null }, transfer: [] };
    }
    progress?.('Making the fit test…');
    const coupon = fitTestCoupon({ ...spec, diameter: uses.pegs ? uses.pegSize : uses.diameter }, printing?.nozzle ?? 0.4, {
      dovetail: uses.dovetail, pins: uses.pins, pegs: uses.pegs, apart: uses.apart,
    });
    try {
      const soup = manifoldToSoup(coupon);
      const stl = writeBinarySTL(soup, `STL-Text ${file}`);
      return {
        message: {
          stl, name: file, triangles: soup.length / 9, diameter: uses.pins ? uses.diameter : null, pins: uses.pins, dovetail: uses.dovetail,
          pegs: uses.pegs, pegSize: uses.pegs ? uses.pegSize : null, apart: uses.apart,
        },
        transfer: [stl],
      };
    } finally {
      coupon.delete();
    }
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

  /** A generated part: a clean primitive to replace a smudgy detail with (a sphere for a berry). */
  function generatePart({ partId, kind = 'sphere', radius = 2, name = 'berry', ...spec }) {
    let m, key;
    if (kind === 'sphere') {
      const r = Math.max(0.2, Math.min(100, Number(radius) || 2));
      m = Manifold.sphere(r, Math.max(24, Math.min(128, Math.round(r * 24))));
      key = `${partId}:${kind}:${r}`;
    } else if (DECOR_KINDS[kind]) {
      // a clean decoration (see decor.js), standing on z = 0 with its skirt below
      const s = normaliseDecorSpec({ ...spec, kind, radius });
      m = buildDecor(wasm, s);
      key = decorPartId(s);
    } else fail('PART_INVALID', `Unknown generated part "${kind}"`);
    parts.get(partId)?.manifold.delete();
    const { min, max } = m.boundingBox();
    const info = { name, triangles: m.numTri(), size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], watertight: true, repaired: false, summary: '', dropped: 0, generated: kind };
    parts.set(partId, { manifold: m, info, key });
    flat.clear();
    clearDerived();
    return { message: { partId, info }, transfer: [] };
  }

  /**
   * The details standing on the current model (see details.js), found on a
   * lighter copy of it: the base is smoothed at the feature scale, so edges
   * a good deal shorter than that add nothing but time.
   */
  function findDetailsIn({ baseVersion, featureSize = 0, minHeight = 0, debug = false }, progress) {
    const b = baseFor(baseVersion);
    if (!b.current || b.kind === 'none') return { message: { details: [], featureSize: 0, threshold: 0 }, transfer: [] };
    progress?.('Looking for details…');
    const temps = scope();
    try {
      const stage = b.current.stage;
      let mesh = stage.view ?? stage.mesh;
      const bounds = b.current.bounds;
      const diag = bounds ? Math.hypot(...[0, 1, 2].map((k) => bounds.max[k] - bounds.min[k])) : 100;
      // the automatic scale: decorations are a few per cent of a model's extent, within a sensible range in mm
      const F = featureSize > 0 ? featureSize : Math.max(6, Math.min(40, 0.03 * diag));
      const solid = b.current.watertight ? stageManifold(stage) : null;
      if (solid) {
        // the smoothing works per edge, so the copy it runs on has evenly sized edges: the model is lightened, then
        // refined to an even edge length – a sixteenth of the feature scale, or longer on a huge model so the copy
        // stays within a budget of triangles (it is always refined: a simplified mesh alone is long thin triangles)
        const area = solid.surfaceArea();
        const edge = Math.max(F / 16, Math.sqrt(area / (0.43 * 350_000)));
        const lighter = temps.add(temps.add(solid.simplify(Math.min(F / 120, edge / 8))).refineToLength(edge));
        if (lighter.numTri() >= 100) mesh = meshOf(lighter);
      }
      const dropped = [];
      const found = findDetails(mesh, { featureSize: F, minHeight, trace: debug ? (t) => dropped.push(t) : null });
      // the copy's vertices lie a little off the surface, so round details take their sphere from the model itself
      const own = stage.view ?? stage.mesh;
      if (mesh !== own) refitSpheres(found.details, own.positions);
      // how crumpled each one is, judged on the model's own mesh (the copy has the fine crumples smoothed away)
      crumpleOf(found.details, stage.mesh ?? own);
      return { message: { details: found.details, featureSize: found.featureSize, threshold: found.threshold, triangles: mesh.index.length / 3, ...(debug && { dropped }) }, transfer: [] };
    } finally {
      temps.dispose();
    }
  }

  /* ---------------------------------------------------------- dispatch */

  const handlers = {
    ping: () => ({
      message: {
        ready: true,
        caches: {
          flat: flat.size, conformed: conformed.size, result: result ? 1 : 0, split: result?.split?.cut ? 1 : 0,
          frame: (result?.split?.frame ? 1 : 0) + (sketch?.split?.frame ? 1 : 0),
          aim: (result?.split?.aim?.slices.size ?? 0) + (sketch?.split?.aim?.slices.size ?? 0),
        },
        fonts: [...fonts.keys()],
        parts: [...parts.keys()],
        baseVersion: base?.version ?? null,
      },
      transfer: [],
    }),
    'font.add': addFont,
    'part.add': addPart,
    'part.generate': generatePart,
    'details.find': findDetailsIn,
    'base.load': loadBase,
    'base.update': updateBase,
    preview,
    result: resultDisplay,
    export: exportStl,
    'split.plan': planSplitRequest,
    'split.fitTest': fitTest,
  };

  return {
    async handle(request, progress = () => {}) {
      const handler = handlers[request?.type];
      try {
        if (!handler) fail('INTERNAL', `Unknown request type "${request?.type}"`);
        const { message, transfer } = handler(request, progress);
        return { message: { id: request.id, ok: true, result: message }, transfer: transfer ?? [] };
      } catch (err) {
        // a split that cannot be made says why with its own code (SPLIT_INVALID, or INTERNAL for a broken piece)
        const coded = err instanceof EngineError || err instanceof SplitError;
        const code = coded ? err.code : /Not manifold/i.test(err?.message) ? 'NOT_WATERTIGHT' : 'INTERNAL';
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
      clearSplitCaches();
    },
  };
}
