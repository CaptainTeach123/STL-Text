import { manifold } from './manifold.js';
import { geometryToManifold, manifoldToGeometry, mergeGeometries, NotWatertightError } from './mesh.js';
import { toMat4 } from './placement.js';

const HISTORY_LIMIT = 12;

/**
 * Document state: the current solid plus an undo stack. No DOM or WebGL here,
 * so it can be driven from tests.
 *
 * A model is { geometry, manifold }:
 *   geometry – what gets exported / displayed
 *   manifold – WASM solid used for booleans, or null when the source mesh is
 *              not watertight (we can still *add* text to those as a
 *              separate overlapping shell, but not engrave them).
 */
export class Editor {
  constructor() {
    this.model = null;
    this.name = 'model';
    this.history = [];
  }

  get hasModel() {
    return this.model !== null;
  }

  get canUndo() {
    return this.history.length > 0;
  }

  /** Replace the document with a new mesh. Returns { watertight }. */
  load(geometry, name = 'model') {
    this.#clear();
    this.name = name;
    let solid = null;
    try {
      solid = geometryToManifold(geometry);
    } catch (err) {
      if (!(err instanceof NotWatertightError)) throw err;
    }
    // Prefer the welded mesh Manifold produced; it is what booleans will use.
    this.model = { geometry: solid ? manifoldToGeometry(solid) : geometry, manifold: solid };
    return { watertight: solid !== null };
  }

  /** Start from a ready-made Manifold solid (e.g. the sample plaque). */
  loadSolid(solid, name = 'model') {
    this.#clear();
    this.name = name;
    this.model = { geometry: manifoldToGeometry(solid), manifold: solid };
  }

  clear() {
    this.#clear();
    this.name = 'model';
  }

  /**
   * Add (emboss) or cut (engrave) `text` – a Manifold in text-local space –
   * placed with the 4x4 `matrix` (THREE.Matrix4). Pushes an undo step.
   * Returns { fallback } where fallback=true means the base was not
   * watertight so the text was added as a separate shell.
   */
  applyText(text, matrix, mode) {
    if (!this.model) throw new Error('Load a model first.');
    const placed = text.transform(toMat4(matrix));
    try {
      const previous = this.model;
      let next;
      let fallback = false;
      if (previous.manifold) {
        const result =
          mode === 'engrave' ? previous.manifold.subtract(placed) : previous.manifold.add(placed);
        if (result.isEmpty()) {
          result.delete();
          throw new Error('The result would be empty – the text removes the whole model.');
        }
        next = { geometry: manifoldToGeometry(result), manifold: result };
      } else {
        if (mode === 'engrave') {
          throw new NotWatertightError();
        }
        fallback = true;
        next = {
          geometry: mergeGeometries([previous.geometry, manifoldToGeometry(placed)]),
          manifold: null,
        };
      }
      this.history.push(previous);
      if (this.history.length > HISTORY_LIMIT) this.history.shift()?.manifold?.delete();
      this.model = next;
      return { fallback };
    } finally {
      placed.delete();
    }
  }

  undo() {
    const previous = this.history.pop();
    if (!previous) return false;
    this.model?.manifold?.delete();
    this.model = previous;
    return true;
  }

  /** Dispose of everything WASM-side. */
  #clear() {
    this.model?.manifold?.delete();
    for (const m of this.history) m.manifold?.delete();
    this.history = [];
    this.model = null;
  }
}

/** A small rounded plaque, handy as a starting model. */
export function samplePlaque({ width = 70, depth = 30, height = 4, radius = 4 } = {}) {
  const { CrossSection, Manifold } = manifold();
  const rect = CrossSection.square([width - 2 * radius, depth - 2 * radius], true);
  const rounded = rect.offset(radius, 'Round', 2, 48);
  const plaque = Manifold.extrude(rounded, height);
  rect.delete();
  rounded.delete();
  return plaque;
}
