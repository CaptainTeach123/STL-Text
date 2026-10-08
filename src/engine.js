import { BufferGeometry, Float32BufferAttribute, Matrix4, Uint32BufferAttribute, Vector3 } from 'three';
import { describeRepair, repairToManifold } from './repair.js';
import { conformNotes, conformSolid, createSurfaceSampler, createUndersideSampler, fitDepth, heightFieldSlab } from './conform.js';
import { buildCrossSectionInfo, printLimits, textZRange, thinStrokeReport } from './textGeometry.js';
import { labelFor, parseFont } from './fontParse.js';
import { parseSTL, triangleSoup, writeBinarySTL } from './stl.js';
import { concatSoups, displayBuffers, manifoldToSoup } from './mesh.js';
import { ViewCache, passthroughRangesOf } from './view.js';
import { ATTACH_ROTATIONS, placementMatrix, toMat4 } from './placement.js';
import { baseMode, fontIds, hasText, isPart, isSpot, itemLabel, placeKey, shapeKey } from './document.js';
import { enhanceMesh, extractRegion, isEnhanceActive, regionWeights } from './enhance.js';
import { baseSurface, findDetails, refitSpheres } from './details.js';

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

export function createEngine({ wasm, lodTriangles = LOD_TRIANGLES, lodTolerance = LOD_TOLERANCE }) {
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

  function sampler(placement, options) {
    const current = base.current;
    if (!current?.geometry || !current.geometry.index?.count) return null;
    return createSurfaceSampler(current.geometry, placement, options);
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
    // a part may be pulled down by as much as its own height, so the surface search reaches at least that far
    const partReach = isPart(item) ? Math.max(50, flatEntry.solid.boundingBox().max[2] - flatEntry.solid.boundingBox().min[2] + 1) : 50;
    const s = wantsStats && (item.conform || isPart(item)) ? sampler(placement, { searchAbove: partReach, searchBelow: partReach }) : null;
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
    const active = items.filter((i) => hasText(i) && !isSpot(i)); // spots change the model itself, not what is added to it
    requireFonts(active.filter((i) => !isPart(i)));
    requireParts(active);
    const key = `${baseVersion}|${active.map((i) => `${shapeKey(i, fontKeyOf(i))}|${placeKey(i)}|${i.cover ? 'cover' : ''}`).sort().join(';')}`;
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
        const world = temps.add(placed.solid.transform(toMat4(placed.placement)));
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
      message: { display, notes: final.notes, skipped: final.skipped, info: { triangles: d.index.length / 3 } },
      transfer: [display.positions.buffer, display.normals.buffer, display.index.buffer],
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

  /** A generated part: a clean primitive to replace a smudgy detail with (a sphere for a berry). */
  function generatePart({ partId, kind = 'sphere', radius = 2, name = 'berry' }) {
    const r = Math.max(0.2, Math.min(100, Number(radius) || 2));
    let m;
    if (kind === 'sphere') m = Manifold.sphere(r, Math.max(24, Math.min(128, Math.round(r * 24))));
    else fail('PART_INVALID', `Unknown generated part "${kind}"`);
    parts.get(partId)?.manifold.delete();
    const { min, max } = m.boundingBox();
    const info = { name, triangles: m.numTri(), size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], watertight: true, repaired: false, summary: '', dropped: 0, generated: kind };
    parts.set(partId, { manifold: m, info, key: `${partId}:${kind}:${r}` });
    flat.clear();
    clearDerived();
    return { message: { partId, info }, transfer: [] };
  }

  /**
   * The details standing on the current model (see details.js), found on a
   * lighter copy of it: the base is smoothed at the feature scale, so edges
   * a good deal shorter than that add nothing but time.
   */
  function findDetailsIn({ baseVersion, featureSize = 0, minHeight = 0 }, progress) {
    const b = baseFor(baseVersion);
    if (!b.current || b.kind === 'none') return { message: { details: [], featureSize: 0, threshold: 0 }, transfer: [] };
    progress?.('Looking for details…');
    const temps = scope();
    try {
      const stage = b.current.stage;
      let mesh = stage.view ?? stage.mesh;
      const bounds = b.current.bounds;
      const diag = bounds ? Math.hypot(...[0, 1, 2].map((k) => bounds.max[k] - bounds.min[k])) : 100;
      const F = featureSize > 0 ? featureSize : 0.15 * diag; // the same automatic scale as details.js
      const solid = b.current.watertight ? stageManifold(stage) : null;
      if (solid) {
        // the smoothing works per edge, so the copy it runs on has evenly sized edges: a dense model is first
        // lightened, a coarse one (long thin triangles) refined, both to about a twelfth of the feature scale
        const edge = F / 12;
        let lighter = mesh.index.length / 3 > 20_000 ? temps.add(solid.simplify(F / 40)) : solid;
        const area = lighter.surfaceArea();
        if (area / (0.43 * edge * edge) < 600_000) lighter = temps.add(lighter.refineToLength(edge));
        if (lighter.numTri() >= 100) mesh = meshOf(lighter);
      }
      const found = findDetails(mesh, { featureSize: F, minHeight });
      // the copy's vertices lie a little off the surface, so round details take their sphere from the model itself
      const own = stage.view ?? stage.mesh;
      if (mesh !== own) refitSpheres(found.details, own.positions);
      return { message: { details: found.details, featureSize: found.featureSize, threshold: found.threshold, triangles: mesh.index.length / 3 }, transfer: [] };
    } finally {
      temps.dispose();
    }
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
    'part.generate': generatePart,
    'details.find': findDetailsIn,
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
