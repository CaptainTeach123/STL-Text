import { Matrix3, Matrix4, Vector3 } from 'three';
import { ENHANCE_DEFAULTS } from './enhance.js';

/**
 * The document: which model is loaded and how it was transformed, the text
 * items on it, the selection, and an undo history. Plain data, no geometry —
 * the worker derives everything heavy from it on request.
 */

/** One line of a text item: its own wording, font and letter height (cap height, mm). */
export const LINE_DEFAULTS = Object.freeze({ text: '', fontId: 'inter', size: 10 });

export const ITEM_DEFAULTS = Object.freeze({
  kind: 'text', // 'text' | 'part' (an attached STL)
  lines: [LINE_DEFAULTS], // stacked lines; each may use a different font and size
  // backing plate behind the text: 'none' | 'plaque' (rounded rectangle) | 'banner' (swallow-tailed ribbon)
  plate: 'none',
  plateThickness: 2,
  platePadding: 3,
  // attached part (kind 'part')
  partId: null,
  name: '',
  scale: 1,
  attach: 'bottom', // which side of the part touches the model
  tilt: 0, // degrees, leans the part about its reading axis
  roll: 0, // lean sideways (degrees about the part's front–back axis); spin about the surface normal lives in the placement
  sink: 0.4, // how deep the part sits into the surface
  join: 'fuse', // 'fuse' | 'fillet' | 'pegs'
  filletRadius: 1.5,
  pegCount: 2,
  pegDiameter: 3,
  pegLength: 6,
  pegClearance: 0.15,
  letterSpacing: 0,
  lineSpacing: 1.7,
  align: 'center',
  weight: 0,
  cornerRadius: 0,
  mirror: false,
  quality: 'normal',
  mode: 'emboss', // 'emboss' | 'engrave'
  depth: 1.5,
  overlap: 0.4,
  conform: true, // follow curved surfaces
  position: [0, 0, 0],
  normal: [0, 0, 1],
  spin: 0,
});

const SHAPE_KEYS = [
  'kind', 'lines', 'letterSpacing', 'lineSpacing', 'align', 'weight',
  'cornerRadius', 'mirror', 'quality', 'mode', 'depth', 'overlap',
  'plate', 'plateThickness', 'platePadding',
  'partId', 'scale', 'attach', 'tilt', 'roll', 'sink', 'join', 'filletRadius', 'pegCount', 'pegDiameter', 'pegLength', 'pegClearance',
];
const PLACE_KEYS = ['position', 'normal', 'spin', 'conform'];

const HISTORY_LIMIT = 30;

/** Deterministic JSON: sorted keys, numbers rounded to 1e-4. */
export function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
  }
  if (typeof value === 'number') return String(Math.round(value * 1e4) / 1e4);
  return JSON.stringify(value);
}

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

/** Everything that changes the text's own shape (wording, fonts, typography, mode, depth). */
export function shapeKey(item, fontKey = fontIds(item).join(',')) {
  return stableKey({ ...pick(item, SHAPE_KEYS), fontKey });
}

/** Everything that changes where / how the shape sits on the model. */
export function placeKey(item) {
  return stableKey(pick(item, PLACE_KEYS));
}

/** Build the lines of an item from overrides; `text`/`fontId`/`size` are accepted as a one-font shorthand. */
export function linesOf({ lines, text, fontId, size } = {}) {
  const base = { ...LINE_DEFAULTS, ...(fontId !== undefined && { fontId }), ...(size !== undefined && { size }) };
  if (Array.isArray(lines) && lines.length) return lines.map((l) => ({ ...base, ...l }));
  const rows = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  return rows.map((t) => ({ ...base, text: t }));
}

let nextId = 1;
export function createItem(overrides = {}) {
  const { text, fontId, size, ...rest } = overrides;
  const item = { ...ITEM_DEFAULTS, ...rest, id: overrides.id ?? `t${nextId++}` };
  item.lines = item.kind === 'part' ? [] : linesOf({ lines: rest.lines, text, fontId, size });
  if (item.kind === 'part') item.conform = false; // a rigid part is never warped
  item.position = [...item.position];
  item.normal = [...item.normal];
  return item;
}

/** An attached-part item for a loaded part asset. */
export function createPart(partId, name, overrides = {}) {
  return createItem({ kind: 'part', partId, name, ...overrides });
}

export const isPart = (item) => item?.kind === 'part';

/** True when the item would produce geometry (text with letters, or a part). */
export const hasText = (item) =>
  isPart(item) ? !!item.partId : (item.lines ?? []).some((l) => String(l.text ?? '').trim().length > 0);
export const hasContent = hasText;

/** How the item meets the model: a plated text is always raised on it. */
export const baseMode = (item) => (!isPart(item) && item.plate !== 'none' ? 'emboss' : item.mode);

/** The item's wording as one string (lines joined by newlines). */
export const itemText = (item) => (item.lines ?? []).map((l) => l.text ?? '').join('\n');

/** First non-blank line (or the part's name), for lists and messages. */
export const itemLabel = (item, fallback = 'empty text') =>
  isPart(item) ? item.name || 'part' : (item.lines ?? []).map((l) => String(l.text ?? '').trim()).find(Boolean) ?? fallback;

/** Fonts used by an item, in line order, without repeats. */
export const fontIds = (item) => [...new Set((item.lines ?? []).map((l) => l.fontId))];

/** Largest letter height in the item (mm); 10 for parts (used for spacing duplicates). */
export const maxSize = (item) => (isPart(item) ? 10 : Math.max(0, ...(item.lines ?? []).map((l) => l.size || 0)));

/** Move items with the model: positions by the matrix, normals by its rotation. */
export function transformItems(items, matrix) {
  const m = matrix instanceof Matrix4 ? matrix : new Matrix4().fromArray(matrix);
  const rot = new Matrix3().getNormalMatrix(m); // inverse transpose: right for mirrors and uneven scales too
  return items.map((item) => ({
    ...item,
    position: new Vector3(...item.position).applyMatrix4(m).toArray(),
    normal: new Vector3(...item.normal).applyMatrix3(rot).normalize().toArray(),
  }));
}

const clone = (state) => ({
  ...state,
  base: state.base && { ...state.base, transforms: state.base.transforms.map((t) => [...t]), enhance: state.base.enhance ? { ...state.base.enhance } : null },
  items: state.items.map((i) => ({ ...i, lines: i.lines.map((l) => ({ ...l })), position: [...i.position], normal: [...i.normal] })),
});

export class Document {
  constructor() {
    this.state = { base: null, baseVersion: 0, items: [], selectedId: null };
    this.history = [];
    this.future = [];
    this.coalesceKey = null;
    this.listeners = new Set();
  }

  /* ----------------------------------------------------------- queries */

  get items() {
    return this.state.items;
  }

  get base() {
    return this.state.base;
  }

  get selected() {
    return this.state.items.find((i) => i.id === this.state.selectedId) ?? null;
  }

  get canUndo() {
    return this.history.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /* ---------------------------------------------------------- history */

  /**
   * Apply `mutate(state)` as one undoable step. Steps sharing a `coalesce`
   * key (slider drags) are merged into the step that started them.
   */
  commit(mutate, { coalesce = null } = {}) {
    if (!(coalesce && coalesce === this.coalesceKey)) {
      this.history.push(clone(this.state));
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
      this.future = [];
    }
    this.coalesceKey = coalesce;
    const next = clone(this.state);
    mutate(next);
    this.state = next;
    this.#notify();
  }

  /** End a run of coalesced edits (e.g. the slider was released). */
  endCoalescing() {
    this.coalesceKey = null;
  }

  undo() {
    const prev = this.history.pop();
    if (!prev) return false;
    this.future.push(clone(this.state));
    this.state = prev;
    this.coalesceKey = null;
    this.#notify();
    return true;
  }

  redo() {
    const next = this.future.pop();
    if (!next) return false;
    this.history.push(clone(this.state));
    this.state = next;
    this.coalesceKey = null;
    this.#notify();
    return true;
  }

  /* ---------------------------------------------------------- the base */

  /**
   * A new model was loaded (`kind`: 'stl' | 'sample' | 'none'). Items are
   * kept — they are re-placed by clicking — but their transforms reset.
   */
  setBase(kind, name = 'model') {
    this.commit((s) => {
      s.base = kind === 'none' ? null : { kind, name, transforms: [], simplify: null, enhance: null };
      s.baseVersion += 1;
    });
    // a new model starts a new history: the previous model's bytes are gone
    this.history = [];
    this.future = [];
  }

  /** Apply a 4x4 transform (16 numbers, column-major) to the model and carry the items along. */
  transformBase(matrix) {
    if (!this.state.base) return;
    const array = matrix instanceof Matrix4 ? matrix.toArray() : [...matrix];
    this.commit((s) => {
      s.base.transforms.push(array);
      s.baseVersion += 1;
      s.items = transformItems(s.items, array);
    });
  }

  /** Simplify the model to `tolerance` (null = original). Items stay put. */
  simplifyBase(tolerance) {
    if (!this.state.base) return;
    this.commit((s) => {
      s.base.simplify = tolerance;
      s.baseVersion += 1;
    });
  }

  /**
   * Change the model enhancement (sharpen / smooth / detail amounts and
   * their options); `patch` null switches it off. Slider drags coalesce.
   */
  enhanceBase(patch, { coalesce = null } = {}) {
    if (!this.state.base) return;
    this.commit(
      (s) => {
        s.base.enhance = patch ? { ...ENHANCE_DEFAULTS, ...(s.base.enhance ?? {}), ...patch } : null;
        s.baseVersion += 1;
      },
      { coalesce },
    );
  }

  /** Back to the model as loaded (undo all transforms / simplify / enhancement). */
  resetBase() {
    if (!this.state.base) return;
    // the engine composes M = T_n · … · T_1, so undo it with M⁻¹ as a whole
    const forward = this.state.base.transforms.reduce((acc, t) => new Matrix4().fromArray(t).multiply(acc), new Matrix4());
    const inverse = forward.invert();
    this.commit((s) => {
      s.base.transforms = [];
      s.base.simplify = null;
      s.base.enhance = null;
      s.baseVersion += 1;
      s.items = transformItems(s.items, inverse);
    });
  }

  /* ------------------------------------------------------------- items */

  addItem(overrides = {}) {
    const item = createItem(overrides);
    this.commit((s) => {
      s.items.push(item);
      s.selectedId = item.id;
    });
    return item;
  }

  /** Copy the selected item, offset one line down in its own frame. */
  duplicateItem(id) {
    const src = this.state.items.find((i) => i.id === id);
    if (!src) return null;
    const copy = createItem({ ...src, id: undefined });
    const { x, y, z } = frameOf(src);
    const shift = y.multiplyScalar(-1.2 * maxSize(src));
    copy.position = new Vector3(...src.position).add(shift).toArray();
    void x;
    void z;
    this.commit((s) => {
      s.items.push(copy);
      s.selectedId = copy.id;
    });
    return copy;
  }

  updateItem(id, patch, options) {
    this.commit((s) => {
      const item = s.items.find((i) => i.id === id);
      if (item) Object.assign(item, patch);
    }, options);
  }

  /** Change one line of an item (text, fontId or size). */
  updateLine(id, index, patch, options) {
    this.commit((s) => {
      const item = s.items.find((i) => i.id === id);
      if (item?.lines[index]) Object.assign(item.lines[index], patch);
    }, options);
  }

  /** Insert a new line after `index` (defaults: copy the font and size of that line). Returns the new index. */
  addLine(id, index, overrides = {}) {
    const item = this.state.items.find((i) => i.id === id);
    if (!item) return -1;
    const at = Math.min(Math.max(index, -1), item.lines.length - 1);
    const from = item.lines[at] ?? item.lines[item.lines.length - 1] ?? LINE_DEFAULTS;
    this.commit((s) => {
      const target = s.items.find((i) => i.id === id);
      target.lines.splice(at + 1, 0, { ...from, text: '', ...overrides });
    });
    return at + 1;
  }

  /** Remove a line (an item always keeps at least one). */
  removeLine(id, index) {
    const item = this.state.items.find((i) => i.id === id);
    if (!item || item.lines.length <= 1 || !item.lines[index]) return;
    this.commit((s) => {
      s.items.find((i) => i.id === id).lines.splice(index, 1);
    });
  }

  deleteItem(id) {
    const index = this.state.items.findIndex((i) => i.id === id);
    if (index < 0) return;
    this.commit((s) => {
      s.items.splice(index, 1);
      if (s.selectedId === id) s.selectedId = s.items[Math.min(index, s.items.length - 1)]?.id ?? null;
    });
  }

  select(id) {
    if (id === this.state.selectedId) return;
    this.state = { ...this.state, selectedId: id };
    this.#notify();
  }

  #notify() {
    for (const fn of this.listeners) fn(this.state);
  }
}

/** Text-frame axes of an item (X reading direction, Y up, Z normal). */
export function frameOf(item) {
  const z = new Vector3(...item.normal).normalize();
  const ref = Math.abs(z.z) > 0.99 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
  const y = ref.sub(z.clone().multiplyScalar(ref.dot(z))).normalize();
  const x = new Vector3().crossVectors(y, z).normalize();
  const a = (item.spin * Math.PI) / 180;
  const xs = x.clone().multiplyScalar(Math.cos(a)).addScaledVector(y, Math.sin(a));
  const ys = y.clone().multiplyScalar(Math.cos(a)).addScaledVector(x, -Math.sin(a));
  return { x: xs, y: ys, z };
}
