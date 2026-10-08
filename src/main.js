import { Matrix4, Vector3 } from 'three';
import { Document, ITEM_DEFAULTS, createPart, createSpot, fontIds, frameOf, hasText, isPart, isSpot, itemLabel, maxSize, placeKey, shapeKey, spotsOf, stableKey } from './document.js';
import { createEngineClient } from './engineClient.js';
import { ENHANCE_DEFAULTS, isEnhanceActive } from './enhance.js';
import { Viewer } from './viewer.js';
import { SIDES, placementMatrix, snapPartTo } from './placement.js';
import { BUNDLED_FONTS, canQueryLocalFonts, fetchBundledFont, listLocalFonts, localFontBytes } from './fontCatalog.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'stltext.settings.v2';

/* ------------------------------------------------------------------ state */

const doc = new Document();
const viewer = new Viewer($('stage'));
const fonts = new Map(); // fontId -> { label, group }
const partAssets = new Map(); // partId -> { name, info }
let partCount = 0;
const printing = { nozzle: 0.4, layerHeight: 0.2 };
const defaults = { fontId: 'inter', size: 10, mode: 'emboss', depth: 1.5, quality: 'normal', roundCorners: false };

const previewKeys = new Map(); // itemId -> key of the last preview requested
const previewInfo = new Map(); // itemId -> { size, notes, stats, bounds, matrix }
const detached = new Map(); // itemId -> true when the latest preview says the item is not touching the model
let modelInfo = null; // info of the model as the engine sees it
let compareOriginal = false; // "Show original": view the model without its enhancement
let modelReport = null;
let sentVersion = null; // doc.baseVersion the engine currently has
let basePending = null; // promise of the base request in flight, if any
let lastContentKey = '';
let lastClick = null; // { position, normal } of the last click on the model
let booted = false;
let userFontCount = 0;
let currentLine = 0; // which line of the selected text the line tools act on
let linesSignature = ''; // what the lines editor was last built for
let fatalCount = 0; // consecutive engine crashes; stops the automatic restarts
let halted = false;
const MAX_FATALS = 3;

const client = createEngineClient({
  createWorker: () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }),
  onProgress: ({ stage }) => showProgress(stage),
  onState: (state) => {
    document.body.dataset.engine = !booted ? 'starting' : state === 'busy' ? 'busy' : 'idle';
    if (state !== 'busy') showProgress(null);
  },
  onFatal: (err) => {
    console.error('Geometry engine failed:', err);
    previewKeys.clear();
    sentVersion = null;
    if (err.code !== 'RESTARTED') {
      fatalCount += 1;
      if (fatalCount >= MAX_FATALS) {
        halted = true;
        showProgress(null);
        setStatus('The geometry engine keeps crashing on this model. Simplify it or load a smaller one, then retry.', 'error');
        toast('The geometry engine crashed repeatedly and was stopped.', {
          label: 'Retry',
          run: () => {
            fatalCount = 0;
            halted = false;
            render();
          },
        });
        return;
      }
      toast('The geometry engine ran out of memory and was restarted. Try Simplify or a smaller model if it happens again.');
    }
    render();
  },
});

/* ---------------------------------------------------------------- helpers */

function setStatus(message, kind = '') {
  const el = $('status');
  el.textContent = message ?? '';
  el.className = `status ${kind}`.trim();
}

function showProgress(stage) {
  const el = $('progress');
  if (!stage) {
    el.hidden = true;
    return;
  }
  $('progressText').textContent = stage;
  el.hidden = false;
}

let toastTimer = 0;
function toast(text, action = null) {
  const el = $('toast');
  $('toastText').textContent = text;
  const btn = $('toastAction');
  btn.hidden = !action;
  btn.textContent = action?.label ?? 'Undo';
  btn.onclick = () => {
    action?.run();
    el.hidden = true;
  };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}

const friendly = (err) => {
  switch (err?.code) {
    case 'STL_INVALID':
      return `${err.message} Export the model again as a binary STL from your slicer.`;
    case 'FONT_INVALID':
      return err.message;
    case 'EMPTY_RESULT':
      return err.message;
    case 'WASM_ABORT':
    case 'WORKER_ERROR':
      return 'The geometry engine crashed. Try again, or use Simplify on very large models.';
    default:
      return err?.message ?? String(err);
  }
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    Object.assign(printing, saved.printing ?? {});
    Object.assign(defaults, saved.defaults ?? {});
    if (!BUNDLED_FONTS.some((f) => f.id === defaults.fontId)) defaults.fontId = 'inter';
  } catch {
    /* fresh start */
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ printing, defaults }));
  } catch {
    /* private mode etc. */
  }
}

const version = () => doc.state.baseVersion;
const fmt = (n, d = 1) => Number(n).toFixed(d);

/* ------------------------------------------------------------------ model */

function describeModel() {
  const info = modelInfo;
  const notes = [];
  if (!info || !info.hasModel) {
    return { text: 'No model: the text will be exported on its own, flat on the build plate.', notes };
  }
  const text = `${info.name}: ${info.size.map((v) => fmt(v)).join(' × ')} mm · ${info.triangles.toLocaleString()} triangles`;
  if (info.watertight && !info.repaired) {
    notes.push({ level: 'ok', text: 'Watertight – raised or cut-in text both work.' });
  } else if (info.watertight) {
    notes.push({ level: 'ok', text: `${modelReport?.summary ?? 'Repaired.'} Raised and cut-in text both work.` });
  } else {
    notes.push({
      level: 'warn',
      text: `${modelReport?.summary ? `${modelReport.summary} ` : ''}This model has gaps that couldn't be closed: text can be raised on it but not cut in.`,
    });
  }
  if (info.passthroughTriangles && info.watertight) {
    notes.push({ level: 'warn', text: 'The amber part of the model could not be repaired; text can only be raised there.' });
  }
  if (info.simplifiedView) {
    notes.push({
      level: 'info',
      text: `Showing a lighter preview (${info.displayTriangles.toLocaleString()} of ${info.triangles.toLocaleString()} triangles) so the view stays smooth. Downloads keep the full detail.`,
    });
  }
  if (info.enhanced?.failed) {
    notes.push({ level: 'warn', text: 'Enhancement skipped: at these settings the result would not be a valid solid. Try smaller amounts.' });
  } else if (info.enhanced) {
    notes.push({
      level: 'ok',
      text: `Enhanced: ${info.enhanced.verticesMoved.toLocaleString()} points moved, at most ${fmt(info.enhanced.maxDisplacement)} mm. Downloads include the enhancement.`,
    });
  } else if (isEnhanceActive(doc.base?.enhance) && compareOriginal) {
    notes.push({ level: 'info', text: 'Showing the original model; untick "Show original" to see it enhanced.' });
  }
  if (info.spots?.length) {
    const applied = info.spots.filter((s) => !s.empty && !s.failed);
    const moved = applied.reduce((n, s) => n + s.verticesMoved, 0);
    notes.push({
      level: applied.length ? 'ok' : 'warn',
      text: applied.length
        ? `${applied.length} clean-up ${applied.length === 1 ? 'spot' : 'spots'} applied: ${moved.toLocaleString()} points moved. Downloads include them.`
        : 'The clean-up spots are not on the model surface yet.',
    });
  }
  return { text, notes };
}

function renderNotes(el, notes, actions = {}) {
  el.replaceChildren(
    ...notes.map((n) => {
      const li = document.createElement('li');
      li.className = n.level ?? 'info';
      const span = document.createElement('span');
      span.className = 'text';
      span.textContent = n.text;
      li.append(span);
      const action = actions[n.code]?.(n);
      if (action) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn small';
        btn.textContent = action.label;
        btn.onclick = action.run;
        li.append(btn);
      }
      return li;
    }),
  );
}

function renderSuggestions() {
  const el = $('modelSuggestions');
  const list = modelInfo?.suggestions ?? [];
  el.replaceChildren(
    ...list.map((s) => {
      const div = document.createElement('div');
      div.className = 'suggestion';
      const span = document.createElement('span');
      span.textContent = s.text;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn small';
      btn.textContent = s.action;
      btn.onclick = () => applyFix(s.code === 'INCHES' ? 'inches' : s.code === 'Y_UP' ? 'standUp' : 'simplify');
      div.append(span, btn);
      return div;
    }),
  );
  if (list.length) $('fixModel').open = true;
}

function onBase(result, { frame = false } = {}) {
  fatalCount = 0;
  engineVersion = result.info.version;
  modelInfo = result.info;
  modelReport = result.report;
  viewer.setBase(result.display);
  viewer.setHoverEnabled(!!modelInfo.hasModel);
  if (frame) viewer.frame();
  const { text, notes } = describeModel();
  $('modelInfo').textContent = text;
  renderNotes($('modelNotes'), notes);
  renderSuggestions();
  $('legendPass').hidden = !modelInfo.passthroughTriangles;
  previewKeys.clear(); // text follows the surface, so every preview depends on the model
  render();
}

async function loadModel(kind, { bytes = null, name = 'model' } = {}) {
  showProgress('Reading the file…');
  // setBase() bumps the version and re-renders synchronously; claim that
  // version first so syncBase() does not post a pointless update of the
  // previous model ahead of this load
  sentVersion = doc.state.baseVersion + 1;
  doc.setBase(kind, name);
  if (kind === 'none') {
    // nothing to cut into or sit on: texts become raised and drop onto the build plate
    for (const item of doc.items) {
      doc.updateItem(item.id, { mode: 'emboss', position: [0, 0, 0], normal: [0, 0, 1] }, { coalesce: 'no-model' });
    }
    doc.endCoalescing();
    lastClick = null;
  }
  sentVersion = version();
  const pending = client.loadBase({ kind, bytes, name, version: sentVersion, spots: spotsOf(doc.items) });
  basePending = pending;
  try {
    const result = await pending;
    if (!result) return; // superseded by a newer load, which renders itself
    onBase(result, { frame: true });
    if (kind === 'stl') {
      setStatus(
        result.info.watertight
          ? `Loaded ${name}. Click the model to place your text.`
          : `Loaded ${name}. It has gaps, so text can be raised on it but not cut in.`,
        result.info.watertight ? 'ok' : '',
      );
      snapToSide('top');
    } else if (kind === 'sample') {
      snapToSide('top');
    }
  } catch (err) {
    sentVersion = null;
    setStatus(`Could not open ${name}: ${friendly(err)}`, 'error');
    doc.setBase('none');
    await syncBase();
  } finally {
    if (basePending === pending) {
      basePending = null;
      setDeriving(false); // a load that overtook a slow derivation also ends its "applying…" state
    }
  }
}

/** Make sure the engine has the document's current model state. */
let engineVersion = null; // the document version the engine has derived (set by onBase)
let derivingTimer = 0;

/** Mark the model as being re-derived: the view dims and the enhance / spot cards say so (only when it takes a moment, so quick updates do not flicker). */
function setDeriving(on) {
  clearTimeout(derivingTimer);
  if (on) {
    derivingTimer = setTimeout(() => {
      document.body.classList.add('deriving');
      viewer.setBaseDimmed(true);
    }, 300);
    return;
  }
  document.body.classList.remove('deriving');
  viewer.setBaseDimmed(false);
}

/**
 * Send the base (model + transforms + enhancement + spots) to the engine when
 * it changed. Resolves to whether the engine now has the current version –
 * previews and results for it are only worth asking for when it does.
 */
async function syncBase() {
  if (sentVersion !== version()) {
    const v = version();
    sentVersion = v;
    const pending = doc.base
      ? client.updateBase({ version: v, transforms: doc.base.transforms, simplify: doc.base.simplify, enhance: compareOriginal ? null : doc.base.enhance, spots: spotsOf(doc.items) })
      : client.loadBase({ kind: 'none', version: v });
    basePending = pending;
    setDeriving(true);
    try {
      const result = await pending;
      if (result) onBase(result);
      else if (sentVersion === v) sentVersion = null; // superseded: let the next render re-sync
    } catch (err) {
      sentVersion = null;
      setStatus(friendly(err), 'error');
    } finally {
      if (basePending === pending) {
        basePending = null;
        setDeriving(false);
      }
    }
  } else if (basePending) {
    await basePending; // previews must wait for the model they are for
  }
  return engineVersion === version();
}

/** Bounding box of `bounds` after `matrix` (for chaining rotations with re-centring). */
function transformedBounds(bounds, matrix) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const corner = new Vector3(k & 1 ? bounds.max[0] : bounds.min[0], k & 2 ? bounds.max[1] : bounds.min[1], k & 4 ? bounds.max[2] : bounds.min[2]);
    corner.applyMatrix4(matrix);
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], corner.getComponent(a));
      max[a] = Math.max(max[a], corner.getComponent(a));
    }
  }
  return { min, max };
}

const centering = (bounds) =>
  new Matrix4().makeTranslation(-(bounds.min[0] + bounds.max[0]) / 2, -(bounds.min[1] + bounds.max[1]) / 2, -bounds.min[2]);

function rotationAboutCenter(axis, degrees, bounds) {
  const c = new Vector3(...bounds.min).add(new Vector3(...bounds.max)).multiplyScalar(0.5);
  const rot = new Matrix4()[`makeRotation${axis}`]((degrees * Math.PI) / 180);
  return new Matrix4().makeTranslation(c.x, c.y, c.z).multiply(rot).multiply(new Matrix4().makeTranslation(-c.x, -c.y, -c.z));
}

function applyFix(kind) {
  if (!doc.base || !modelInfo?.bounds) return;
  const bounds = modelInfo.bounds;
  let matrix = null;
  switch (kind) {
    case 'inches':
      matrix = new Matrix4().makeScale(25.4, 25.4, 25.4);
      break;
    case 'scale': {
      const f = Number.parseFloat($('scalePercent').value) / 100;
      if (!(f > 0)) return;
      matrix = new Matrix4().makeScale(f, f, f);
      $('scalePercent').value = 100;
      break;
    }
    case 'rotX':
    case 'rotY':
    case 'rotZ':
      matrix = rotationAboutCenter(kind.slice(-1), 90, bounds);
      break;
    case 'standUp': {
      const rot = rotationAboutCenter('X', 90, bounds); // Y-up -> Z-up
      matrix = centering(transformedBounds(bounds, rot)).multiply(rot);
      break;
    }
    case 'center':
      matrix = centering(bounds);
      break;
    case 'reset':
      doc.resetBase();
      break;
    case 'simplify': {
      const tol = Number.parseFloat($('simplifyTol').value);
      if (!(tol > 0)) return;
      doc.simplifyBase(tol);
      break;
    }
    default:
      return;
  }
  if (matrix) doc.transformBase(matrix);
  setStatus('');
}

/* ----------------------------------------------------------------- enhance */

const ENHANCE_PERCENT = new Set(['sharpen', 'detail', 'smooth']);

/** Fill the Enhance controls from the document (unless the user is typing in one). */
function fillEnhance() {
  const settings = doc.base?.enhance ?? ENHANCE_DEFAULTS;
  const usable = !!doc.base && !!modelInfo?.watertight;
  filling = true;
  try {
    document.querySelectorAll('[data-enhance]').forEach((el) => {
      const key = el.dataset.enhance;
      const shown = ENHANCE_PERCENT.has(key) ? Math.round((settings[key] ?? 0) * 100) : settings[key] ?? ENHANCE_DEFAULTS[key];
      if (el !== document.activeElement && Number.parseFloat(el.value) !== shown) el.value = shown;
      el.disabled = !usable;
    });
  } finally {
    filling = false;
  }
  const active = isEnhanceActive(doc.base?.enhance);
  if (!active) compareOriginal = false; // nothing to compare against
  $('enhanceCompare').disabled = !usable || !active;
  $('enhanceCompare').checked = compareOriginal && active;
  $('enhanceReset').disabled = !usable || !active;
  $('enhanceModel').classList.toggle('active', active);
  $('enhanceHint').textContent = !doc.base
    ? 'Load a model first.'
    : !modelInfo?.watertight
      ? 'Needs a watertight model (this one has gaps that could not be repaired).'
      : 'For soft, low-definition models: crisper edges, flatter surfaces and bolder relief print better and look sharper.';
}

/**
 * Re-deriving the model is the slow part on a big model, so the controls
 * that change it (enhancement and clean-up spot amounts) apply when a slider
 * is released or a number is committed, not on every tick of a drag; the
 * paired number / slider follow each other live meanwhile.
 */
const HEAVY_SPOT_KEYS = new Set(['radius', 'feather', 'sharpen', 'smooth', 'detail', 'deepen', 'evenOut', 'featureSize', 'maxMove']);

function bindEnhance() {
  document.querySelectorAll('[data-enhance]').forEach((el) => {
    const key = el.dataset.enhance;
    const mirror = () => {
      document.querySelectorAll(`[data-enhance="${key}"]`).forEach((other) => {
        if (other !== el) other.value = el.value;
      });
    };
    el.addEventListener('input', () => {
      if (filling || !doc.base) return;
      mirror();
    });
    el.addEventListener('change', () => {
      if (filling || !doc.base) return;
      let value = Number.parseFloat(el.value);
      if (Number.isNaN(value)) return;
      if (ENHANCE_PERCENT.has(key)) value = Math.min(1, Math.max(0, value / 100));
      mirror();
      compareOriginal = false;
      doc.enhanceBase({ [key]: value });
    });
  });
  $('enhanceReset').addEventListener('click', () => {
    compareOriginal = false;
    doc.enhanceBase(null);
  });
  $('enhanceCompare').addEventListener('change', () => {
    compareOriginal = $('enhanceCompare').checked;
    sentVersion = null; // same document version, different model: make syncBase re-derive it
    render();
  });
}

/* ------------------------------------------------------------------- items */

const engraveAvailable = () => !!(modelInfo?.hasModel && modelInfo?.watertight);

const lineDefaults = () => ({ text: '', fontId: fonts.has(defaults.fontId) ? defaults.fontId : 'inter', size: defaults.size });

const itemDefaults = () => ({
  lines: [lineDefaults()],
  mode: engraveAvailable() ? defaults.mode : 'emboss',
  depth: defaults.depth,
  quality: defaults.quality,
  cornerRadius: defaults.roundCorners ? Math.round((printing.nozzle / 2) * 100) / 100 : 0,
});

function addItem(text = '', overrides = {}, { focus = true } = {}) {
  const selected = doc.selected;
  const from = selected && !isPart(selected) && !isSpot(selected) ? selected : null; // a selected part or spot lends only its place
  const place = lastClick ?? (selected && { position: selected.position, normal: selected.normal }) ?? topCenter();
  const firstLine = from ? { ...from.lines[0], text } : { ...lineDefaults(), text };
  const item = doc.addItem({
    ...itemDefaults(),
    ...(from ? { mode: from.mode, depth: from.depth, quality: from.quality, cornerRadius: from.cornerRadius } : {}),
    lines: [firstLine],
    ...place,
    ...overrides,
  });
  currentLine = 0;
  if (focus) focusLine(0);
  return item;
}

/** Attach another STL: load it as a part asset and add a part item at the last click. */
async function addPartFile(file) {
  const name = file.name.replace(/\.stl$/i, '');
  const partId = `part-${++partCount}`;
  showProgress(`Reading ${file.name}…`);
  try {
    const { info } = await client.addPart(partId, await file.arrayBuffer(), name);
    partAssets.set(partId, { name, info });
    const from = doc.selected;
    const place = lastClick ?? (from && { position: from.position, normal: from.normal }) ?? topCenter();
    doc.addItem({ ...createPart(partId, name), id: undefined, ...place });
    setStatus(
      `Added ${name} (${info.size.map((v) => fmt(v)).join(' × ')} mm${info.repaired ? ', repaired' : ''}). Click the model to place it; choose how it connects in the Part card.`,
      'ok',
    );
  } catch (err) {
    setStatus(`Could not add ${file.name}: ${friendly(err)}`, 'error');
  } finally {
    showProgress(null);
  }
}

/** Add a clean-up spot at the last click (or where the selected item is, or on top). */
function addSpot() {
  if (!modelInfo?.hasModel) return;
  const selected = doc.selected;
  const place = lastClick ?? (selected && { position: selected.position, normal: selected.normal }) ?? topCenter();
  const longest = Math.max(...(modelInfo.size ?? [40]));
  const radius = Math.round(Math.min(30, Math.max(3, longest * 0.08)) * 2) / 2;
  doc.addItem({ ...createSpot(), id: undefined, radius, ...place });
  setStatus('Added a clean-up spot. Drag it onto a clumped area and adjust its radius and strengths in the Clean-up spot card.', 'ok');
}

/**
 * Put the caret in a line's text box (after the next render).
 * `caret`: 'all' selects the text (new lines), 'end' puts the caret at the
 * end, a number keeps that column (arrow-key navigation).
 */
function focusLine(index, caret = 'all') {
  requestAnimationFrame(() => {
    const input = $('lineList').querySelectorAll('.line-text')[index];
    if (!input) return;
    input.focus();
    const len = input.value.length;
    if (caret === 'all') input.select();
    else if (caret === 'end') input.setSelectionRange(len, len);
    else {
      const col = Math.min(Number(caret) || 0, len);
      input.setSelectionRange(col, col);
    }
  });
}

function topCenter() {
  if (!modelInfo?.hasModel || !modelInfo.bounds) return { position: [0, 0, 0], normal: [0, 0, 1] };
  const hit = snapHit('top');
  return hit ?? { position: [0, 0, modelInfo.bounds.max[2]], normal: [0, 0, 1] };
}

/** Surface point in the middle of one side of the model's bounding box. */
function snapHit(side) {
  if (!modelInfo?.bounds) return null;
  const n = SIDES[side];
  const { min, max } = modelInfo.bounds;
  const center = [0, 1, 2].map((a) => (min[a] + max[a]) / 2);
  const axis = n.findIndex((v) => v !== 0);
  const outward = n[axis] > 0;
  const origin = [...center];
  origin[axis] = (outward ? max : min)[axis] + (outward ? 1 : -1);
  const hit = viewer.raycastFrom(origin, n.map((v) => -v));
  const face = [...center];
  face[axis] = (outward ? max : min)[axis];
  return { position: hit ? hit.point : face, normal: n };
}

/** Move the selected item onto the nearest point of the model's surface. */
function snapToModel() {
  const sel = doc.selected;
  if (!sel || !modelInfo?.hasModel) return;
  // a part is measured from its centre, so the side of it that faces the model is what gets laid on the surface –
  // not just the anchor point, which may already be on the model while the part stands on an edge or hangs in the air
  const info = isPart(sel) ? previewInfo.get(sel.id) : null;
  const from =
    info?.bounds && info.matrix
      ? new Vector3(...info.bounds.min).add(new Vector3(...info.bounds.max)).multiplyScalar(0.5).applyMatrix4(new Matrix4().fromArray(info.matrix)).toArray()
      : sel.position;
  const hit = viewer.closestSurfacePoint(from);
  if (!hit) return;
  lastClick = { position: hit.point, normal: hit.normal };
  doc.updateItem(sel.id, isPart(sel) ? snapPartTo(sel, hit) : { position: hit.point, normal: hit.normal });
}

/** Turn the selected part by 90° about one of its axes (tilt: X, roll: Y, spin: Z). */
function turnPart(key) {
  const sel = doc.selected;
  if (!sel) return;
  const wrap = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
  doc.updateItem(sel.id, { [key]: wrap((sel[key] ?? 0) + 90) });
}

function snapToSide(side, { look = false } = {}) {
  const hit = snapHit(side);
  if (!hit) return;
  lastClick = hit;
  const sel = doc.selected;
  if (sel) doc.updateItem(sel.id, { position: hit.position, normal: hit.normal });
  if (look) viewer.lookAt(hit.position, hit.normal);
}

/** Move the selected item in its own frame and drop it back onto the surface. */
function nudge(direction, step) {
  const sel = doc.selected;
  if (!sel) return;
  const { x, y, z } = frameOf(sel);
  const d = { left: x.clone().negate(), right: x, up: y, down: y.clone().negate() }[direction].multiplyScalar(step);
  const moved = new Vector3(...sel.position).add(d);
  const hit = viewer.raycastFrom(moved.clone().addScaledVector(z, 5).toArray(), z.clone().negate().toArray());
  // only drop onto a surface that faces the same way and is close by – never through the model onto its far side
  const usable =
    hit && new Vector3(...hit.normal).dot(z) > 0.2 && new Vector3(...hit.point).distanceTo(moved) <= Math.max(3 * step, 3);
  doc.updateItem(sel.id, usable ? { position: hit.point, normal: hit.normal } : { position: moved.toArray() }, { coalesce: 'nudge' });
}

viewer.onPick = ({ point, normal }) => {
  lastClick = { position: point, normal };
  const sel = doc.selected;
  if (sel) doc.updateItem(sel.id, { position: point, normal });
  else addItem();
};

viewer.onSelectItem = (id) => doc.select(id);

viewer.onDrag = ({ itemId, point, normal, done }) => {
  const item = doc.items.find((i) => i.id === itemId);
  if (!item) return;
  if (!done && point) {
    // a spot changes the model itself (a costly recompute), so it only lands when dropped; its ring follows the pointer meanwhile
    if (isSpot(item)) viewer.setOverlayMatrix(itemId, placementMatrix({ ...item, position: point, normal }));
    else doc.updateItem(itemId, { position: point, normal }, { coalesce: 'drag' });
  }
  if (done) {
    if (isSpot(item)) {
      if (point) doc.updateItem(itemId, { position: point, normal });
      else viewer.setOverlayMatrix(itemId, placementMatrix(item)); // dropped off the model: the ring goes back where the spot is
    }
    doc.endCoalescing();
    if (point) lastClick = { position: point, normal };
  }
};

/* --------------------------------------------------------------- previews */

const previewKey = (item) => `${shapeKey(item)}|${placeKey(item)}|${version()}|${stableKey(printing)}`;

function refreshPreviews() {
  const ids = new Set();
  for (const item of doc.items) {
    if (!hasText(item) || !fontIds(item).every((id) => fonts.has(id))) {
      viewer.removeOverlay(item.id);
      previewKeys.delete(item.id);
      previewInfo.delete(item.id);
      continue;
    }
    ids.add(item.id);
    const key = previewKey(item);
    if (previewKeys.get(item.id) === key) continue;
    previewKeys.set(item.id, key);
    // move the old shape right away so dragging feels instant
    viewer.setOverlayMatrix(item.id, placementMatrix(item));
    viewer.setOverlayStale(item.id, true);
    client
      .preview(item, version(), { printing })
      .then((r) => {
        fatalCount = 0;
        if (!r || previewKeys.get(item.id) !== key) return; // superseded or removed
        if (r.empty) {
          viewer.removeOverlay(item.id);
          previewInfo.delete(item.id);
        } else {
          viewer.setOverlay(item.id, { geometry: r.geometry, matrix: r.matrix, mode: isSpot(item) ? 'spot' : item.mode, selected: item.id === doc.state.selectedId });
          previewInfo.set(item.id, { size: r.size, notes: r.notes, stats: r.stats, bounds: r.bounds, matrix: r.matrix });
          const loose = r.notes.some((n) => n.code === 'NOT_TOUCHING');
          viewer.setOverlayDetached(item.id, loose);
          if (!!detached.get(item.id) !== loose) {
            detached.set(item.id, loose);
            renderItems(); // the list shows "not touching" instead of the join
            if (item.id === doc.state.selectedId && isPart(item)) renderPartHint(item);
          }
        }
        if (item.id === doc.state.selectedId) renderSelectedInfo();
      })
      .catch((err) => {
        if (previewKeys.get(item.id) !== key) return;
        if (err.code === 'FONT_MISSING' || err.code === 'BASE_MISSING') previewKeys.delete(item.id); // transient: try again next render
        viewer.setOverlayStale(item.id, false);
        previewInfo.set(item.id, { size: null, notes: [{ level: 'warn', code: err.code, text: friendly(err) }], stats: null });
        if (item.id === doc.state.selectedId) renderSelectedInfo();
      });
  }
  for (const id of [...previewKeys.keys()]) {
    if (!ids.has(id)) {
      previewKeys.delete(id); // a late response for a removed item is then ignored
      previewInfo.delete(id);
      detached.delete(id);
    }
  }
  viewer.pruneOverlays(ids);
  viewer.setOverlaySelected(doc.state.selectedId);
}

/* ------------------------------------------------------------ final result */

let resultBusy = false;
let resultPending = false;
async function showResult(on) {
  viewer.showResult(false);
  if (!on) return;
  if (resultBusy) {
    resultPending = true; // run again for the new content once this one lands
    return;
  }
  resultBusy = true;
  const requestedFor = lastContentKey;
  try {
    if (!(await syncBase())) return; // the model is still being re-derived for a newer change, which re-renders
    const r = await client.result(doc.items, version(), { printing });
    if (!r || !$('resultToggle').checked || lastContentKey !== requestedFor) return; // stale
    viewer.setResult(r.display);
    viewer.showResult(true);
    if (r.notes.length) setStatus(r.notes.map((n) => n.text).join('\n'), r.notes.some((n) => n.level === 'warn') ? 'error' : '');
  } catch (err) {
    $('resultToggle').checked = false;
    setStatus(friendly(err), 'error');
  } finally {
    resultBusy = false;
    if (resultPending) {
      resultPending = false;
      if ($('resultToggle').checked) showResult(true);
    }
  }
}

async function download() {
  const items = doc.items.filter((i) => hasText(i) && !isSpot(i)); // spots change the model, they are not exported geometry
  if (!items.length && !modelInfo?.hasModel) return setStatus('Type some text or open a model first.', 'error');
  const name = modelInfo?.hasModel ? `${modelInfo.name}-text` : items.map((i) => itemLabel(i, '')).filter(Boolean).join('-').slice(0, 40) || 'text';
  try {
    if (!(await syncBase())) return setStatus('The model is still being updated – try the download again in a moment.', '');
    const r = await client.export(doc.items, version(), name, { printing });
    if (!r) return setStatus('The model changed while the download was being prepared – try again.', '');
    const save = (bytes, fileName) => {
      const blob = new Blob([bytes], { type: 'model/stl' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${fileName.replace(/[^\w.-]+/g, '_')}.stl`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      return { name: a.download, kb: (blob.size / 1024).toFixed(0) };
    };
    const main = save(r.stl, name);
    const extras = (r.extra ?? []).map((e, i) => save(e.stl, `${name}-part-${i + 1}-${e.name}`));
    const warnings = r.notes.filter((n) => n.level === 'warn');
    setStatus(
      `Downloaded ${main.name} (${main.kb} KB, ${r.triangles.toLocaleString()} triangles)` +
        (extras.length ? ` and ${extras.length} separate part file${extras.length > 1 ? 's' : ''} (${extras.map((e) => e.name).join(', ')}) to print and glue in.` : '.') +
        (warnings.length ? `\n${warnings.map((n) => n.text).join('\n')}` : ''),
      warnings.length ? 'error' : 'ok',
    );
  } catch (err) {
    setStatus(friendly(err), 'error');
  }
}

/* ----------------------------------------------------------------- render */

/** The Part card's summary line: what the part is, and whether it is touching the model. */
function renderPartHint(item) {
  const asset = partAssets.get(item.partId);
  const info = asset?.info;
  const about = info
    ? `${asset.name}: ${info.size.map((v) => fmt(v)).join(' × ')} mm · ${info.triangles.toLocaleString()} triangles${info.repaired ? ' · repaired on load' : ''}`
    : item.name;
  const loose = detached.get(item.id) && modelInfo?.hasModel;
  $('partInfo').textContent = loose ? `${about}. Not touching the model: click the model to place it, or use "Snap to model".` : about;
  $('partInfo').classList.toggle('warn', !!loose);
}

/** Item fields shown as percentages in the controls (stored as fractions, scale as a factor). */
const PERCENT_KEYS = new Set(['scale', 'sharpen', 'smooth', 'detail', 'deepen', 'evenOut', 'feather']);

let filling = false;
function fillPanel(item) {
  filling = true;
  try {
    const card = $('textCard');
    card.classList.toggle('disabled', !item);
    document.querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const value = item ? item[key] : ITEM_DEFAULTS[key];
      const shown = PERCENT_KEYS.has(key) ? Math.round((value ?? (key === 'scale' ? 1 : 0)) * 100) : value;
      if (el.type === 'radio') el.checked = el.value === String(value);
      else if (el.type === 'checkbox') el.checked = !!value;
      else if (el.type === 'number' || el.type === 'range') {
        // "0.0" being typed is numerically 0: leave it alone rather than mangle it; a control being dragged keeps its value
        if (el !== document.activeElement && Number.parseFloat(el.value) !== shown) el.value = shown ?? '';
      } else if (el.value !== String(shown ?? '')) el.value = shown ?? '';
    });
    const part = isPart(item);
    const spot = isSpot(item);
    $('textCard').hidden = part || spot;
    $('partCard').hidden = !part;
    $('spotCard').hidden = !spot;
    $('styleCard').hidden = spot;
    document.querySelectorAll('.text-only').forEach((el) => (el.hidden = part));
    document.querySelectorAll('.plate-only').forEach((el) => (el.hidden = part || !item || item.plate === 'none'));
    const cutter = part && item.mode === 'engrave';
    document.querySelectorAll('.join-only').forEach((el) => (el.hidden = !part || cutter));
    document.querySelectorAll('.fillet-only').forEach((el) => (el.hidden = !part || cutter || item.join !== 'fillet'));
    document.querySelectorAll('.pegs-only').forEach((el) => (el.hidden = !part || cutter || item.join !== 'pegs'));
    $('sinkLabel').innerHTML = cutter ? 'Cut depth <small>mm</small>' : 'Sink into surface <small>mm</small>';
    $('styleTitle').textContent = part ? 'Add or cut out' : 'Raised or cut';
    $('modeAddLabel').innerHTML = part ? 'Add <small>join</small>' : 'Raised <small>emboss</small>';
    $('modeCutLabel').innerHTML = part ? 'Cut out <small>use as a cutter</small>' : 'Cut in <small>engrave</small>';
    if (part) renderPartHint(item);
    ['posX', 'posY', 'posZ'].forEach((id, i) => ($(id).value = item ? Math.round(item.position[i] * 100) / 100 : 0));
    $('roundCorners').checked = !!item && item.cornerRadius > 0;
    $('depthLabel').innerHTML = `${item?.mode === 'engrave' ? 'Depth' : 'Height'} <small>mm</small>`;
    renderLines(item);
  } finally {
    filling = false;
  }
}

/** Font options for a line's dropdown (built-in first, then uploaded). */
function fontOptions(selectedId) {
  const groups = { bundled: document.createElement('optgroup'), user: document.createElement('optgroup') };
  groups.bundled.label = 'Built in';
  groups.user.label = 'Your fonts';
  for (const [id, f] of fonts) groups[f.group === 'user' ? 'user' : 'bundled'].append(new Option(f.label, id, false, id === selectedId));
  if (selectedId && !fonts.has(selectedId)) groups.user.append(new Option('(font not available)', selectedId, false, true));
  return [groups.bundled, ...(groups.user.children.length ? [groups.user] : [])];
}

/**
 * The lines editor. Rows are rebuilt only when the structure changes (item,
 * line count, fonts); otherwise values are patched in place so typing is
 * never interrupted.
 */
function renderLines(item) {
  const list = $('lineList');
  const lines = item?.lines ?? [];
  currentLine = Math.min(currentLine, Math.max(0, lines.length - 1));
  const signature = `${item?.id ?? '-'}:${lines.length}`;
  if (signature !== linesSignature) {
    linesSignature = signature;
    // a rebuild must never swallow the field the user is typing in
    const focused = document.activeElement?.closest?.('#lineList .line');
    const restore = focused && {
      index: Number(focused.dataset.index),
      field: document.activeElement.className,
      start: document.activeElement.selectionStart,
      end: document.activeElement.selectionEnd,
    };
    list.replaceChildren(
      ...lines.map((line, index) => {
        const li = document.createElement('li');
        li.className = 'line';
        li.dataset.index = index;

        const text = document.createElement('input');
        text.className = 'line-text';
        text.type = 'text';
        text.value = line.text; // rows are born with their values (the focused one is never overwritten later)
        text.placeholder = index === 0 ? 'Type your text…' : `Line ${index + 1}`;
        text.spellcheck = false;
        text.setAttribute('aria-label', `Line ${index + 1} text`);
        text.addEventListener('input', () => {
          if (filling || !doc.selected) return;
          doc.updateLine(doc.selected.id, index, { text: text.value }, { coalesce: `line-text:${doc.selected.id}:${index}` });
        });
        text.addEventListener('change', () => doc.endCoalescing());
        text.addEventListener('keydown', (e) => {
          const sel = doc.selected;
          if (!sel) return;
          // handled here; never let the page-level shortcuts (Backspace = delete text) see them
          if (['Enter', 'Backspace', 'ArrowDown', 'ArrowUp'].includes(e.key)) e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            doc.endCoalescing();
            const at = doc.addLine(sel.id, index);
            currentLine = at;
            focusLine(at);
          } else if (e.key === 'Backspace' && text.value === '' && sel.lines.length > 1) {
            e.preventDefault();
            doc.endCoalescing();
            currentLine = Math.max(0, index - 1);
            doc.removeLine(sel.id, index);
            focusLine(currentLine, 'end');
          } else if (e.key === 'ArrowDown' && index < sel.lines.length - 1) {
            e.preventDefault();
            focusLine(index + 1, text.selectionStart ?? 0);
          } else if (e.key === 'ArrowUp' && index > 0) {
            e.preventDefault();
            focusLine(index - 1, text.selectionStart ?? 0);
          }
        });
        text.addEventListener('paste', (e) => {
          const sel = doc.selected;
          const pasted = e.clipboardData?.getData('text/plain') ?? '';
          if (!sel || !/[\r\n]/.test(pasted)) return; // single-line pastes behave normally
          e.preventDefault();
          const parts = pasted.replace(/\r\n?/g, '\n').split('\n');
          const start = text.selectionStart ?? text.value.length;
          const end = text.selectionEnd ?? start;
          const head = text.value.slice(0, start) + parts[0];
          const tail = text.value.slice(end);
          doc.endCoalescing();
          doc.updateLine(sel.id, index, { text: head + (parts.length === 1 ? tail : '') });
          let at = index;
          parts.slice(1).forEach((part, n) => {
            at = doc.addLine(sel.id, at, { text: part + (n === parts.length - 2 ? tail : '') });
          });
          currentLine = at;
          focusLine(at, 'end');
        });

        const font = document.createElement('select');
        font.className = 'line-font';
        font.setAttribute('aria-label', `Line ${index + 1} font`);
        font.append(...fontOptions(line.fontId));
        font.addEventListener('change', () => {
          if (filling || !doc.selected) return;
          doc.updateLine(doc.selected.id, index, { fontId: font.value });
          if (fonts.get(font.value)?.group === 'bundled') {
            defaults.fontId = font.value;
            saveSettings();
          }
        });

        const tools = document.createElement('div');
        tools.className = 'line-tools';
        const size = document.createElement('input');
        size.className = 'line-size';
        size.type = 'number';
        size.min = '0.5';
        size.max = '500';
        size.step = '0.5';
        size.value = line.size;
        size.title = 'Letter height (mm)';
        size.setAttribute('aria-label', `Line ${index + 1} letter height in mm`);
        size.addEventListener('input', () => {
          if (filling || !doc.selected) return;
          const v = Number.parseFloat(size.value);
          if (!(v > 0)) return;
          doc.updateLine(doc.selected.id, index, { size: v }, { coalesce: `line-size:${doc.selected.id}:${index}` });
          defaults.size = v;
          saveSettings();
        });
        size.addEventListener('change', () => doc.endCoalescing());
        const unit = document.createElement('span');
        unit.className = 'unit';
        unit.textContent = 'mm';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn small ghost line-remove';
        remove.textContent = '×';
        remove.title = 'Remove this line';
        remove.setAttribute('aria-label', `Remove line ${index + 1}`);
        remove.addEventListener('click', () => {
          if (!doc.selected) return;
          currentLine = Math.max(0, index - 1);
          doc.removeLine(doc.selected.id, index);
          focusLine(currentLine, 'end'); // the clicked button is gone with its row
        });
        tools.append(size, unit, remove);

        for (const el of [text, font, size]) el.addEventListener('focus', () => setCurrentLine(index));
        li.append(text, font, tools);
        return li;
      }),
    );
    if (restore && lines[restore.index]) {
      const row = list.children[restore.index];
      const el = row?.querySelector(`.${restore.field.split(' ')[0]}`);
      if (el) {
        el.focus();
        if (el.setSelectionRange && restore.start != null) {
          try {
            el.setSelectionRange(restore.start, restore.end);
          } catch {
            /* number inputs refuse selection ranges */
          }
        }
      }
    }
  }
  const fontList = [...fonts.keys()].join(',');
  list.querySelectorAll('.line').forEach((li, index) => {
    const line = lines[index];
    li.classList.toggle('current', index === currentLine);
    const text = li.querySelector('.line-text');
    const font = li.querySelector('.line-font');
    const size = li.querySelector('.line-size');
    if (document.activeElement !== text && text.value !== line.text) text.value = line.text;
    if (font.dataset.fonts !== fontList || !font.querySelector(`option[value="${CSS.escape(line.fontId)}"]`)) {
      font.replaceChildren(...fontOptions(line.fontId)); // a font arrived or went: refresh the options in place
      font.dataset.fonts = fontList;
    }
    if (font.value !== line.fontId) font.value = line.fontId;
    if (document.activeElement !== size && Number.parseFloat(size.value) !== line.size) size.value = line.size;
    li.querySelector('.line-remove').disabled = lines.length <= 1;
  });
  $('addLineBtn').disabled = !item;
}

function setCurrentLine(index) {
  if (currentLine === index) return;
  currentLine = index;
  $('lineList').querySelectorAll('.line').forEach((li, i) => li.classList.toggle('current', i === index));
}

function renderItems() {
  const list = $('itemList');
  list.replaceChildren(
    ...doc.items.map((item) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(item.id === doc.state.selectedId));
      li.dataset.id = item.id;
      const glyph = document.createElement('span');
      const part = isPart(item);
      glyph.className = `glyph ${part ? 'part' : item.mode}`;
      glyph.textContent = part ? 'P' : item.mode === 'engrave' ? 'C' : 'R';
      glyph.title = part ? 'Attached part' : item.mode === 'engrave' ? 'Cut in' : 'Raised';
      const name = document.createElement('span');
      const first = itemLabel(item, '');
      name.className = `name${first ? '' : ' empty'}`;
      name.textContent = first || 'empty text';
      const meta = document.createElement('span');
      meta.className = 'meta';
      if (isSpot(item)) {
        glyph.className = 'glyph spot';
        glyph.textContent = 'S';
        glyph.title = 'Clean-up spot';
        meta.textContent = `${fmt(item.radius)} mm`;
      } else if (part) {
        const joinLabel = { fuse: 'fused', fillet: 'fillet', pegs: 'pegs' }[item.join] ?? item.join;
        const loose = detached.get(item.id) && modelInfo?.hasModel;
        meta.textContent = `${Math.round(item.scale * 100)}% · ${loose ? 'not touching' : item.mode === 'engrave' ? 'cut out' : joinLabel}`;
        meta.classList.toggle('warn', !!loose);
        glyph.title = loose ? 'Not touching the model – it will be left out' : item.mode === 'engrave' ? 'Part used as a cutter' : `Attached part (${joinLabel})`;
      } else {
        const sizes = [...new Set(item.lines.map((l) => l.size))];
        meta.textContent = `${item.lines.length > 1 ? `${item.lines.length} lines · ` : ''}${sizes.join(' / ')} mm`;
      }
      li.append(glyph, name, meta);
      li.tabIndex = -1;
      li.onclick = () => doc.select(item.id);
      return li;
    }),
  );
}

function renderSelectedInfo() {
  const sel = doc.selected;
  const info = sel ? previewInfo.get(sel.id) : null;
  const notes = [...(info?.notes ?? [])];
  if (sel && !fontIds(sel).every((id) => fonts.has(id))) notes.unshift({ level: 'warn', text: 'A font used by this text is not available – choose another one.' });
  const spot = isSpot(sel);
  renderNotes($('spotNotes'), spot ? notes : [], { NOT_TOUCHING: () => modelInfo?.hasModel && { label: 'Snap to model', run: snapToModel }, SPOT_EMPTY: () => modelInfo?.hasModel && { label: 'Snap to model', run: snapToModel } });
  renderNotes($('textNotes'), spot ? [] : notes, {
    CUT_THROUGH: (n) =>
      n.suggestedDepth && {
        label: `Use ${n.suggestedDepth} mm`,
        run: () => doc.updateItem(sel.id, isPart(sel) ? (sel.join === 'pegs' && sel.mode !== 'engrave' ? { pegLength: n.suggestedDepth } : { sink: n.suggestedDepth }) : { depth: n.suggestedDepth }),
      },
    THIN_STROKES: (n) => n.suggestedWeight != null && { label: 'Make bolder', run: () => doc.updateItem(sel.id, { weight: n.suggestedWeight }) },
    SHALLOW: (n) => n.suggestedDepth && { label: `Use ${n.suggestedDepth} mm`, run: () => doc.updateItem(sel.id, { depth: n.suggestedDepth }) },
    NOT_TOUCHING: () => modelInfo?.hasModel && { label: 'Snap to model', run: snapToModel },
  });
  const width = sel && !isPart(sel) ? info?.size?.[0] : null;
  if (document.activeElement !== $('widthInput')) $('widthInput').value = width ? fmt(width) : '';
  $('widthHint').textContent = width ? 'scales all lines' : '';
}

function render() {
  const sel = doc.selected;
  const contentKey = stableKey({ items: doc.items, base: doc.state.baseVersion, printing });
  const contentChanged = contentKey !== lastContentKey;
  lastContentKey = contentKey;

  renderItems();
  fillPanel(sel);
  fillEnhance();
  renderSelectedInfo();

  const hasModel = !!modelInfo?.hasModel;
  if (booted && !engraveAvailable()) {
    // cutting (and pegs, which need holes) needs a watertight model; whatever path got us here, fix such items
    const cut = doc.items.filter((i) => i.mode === 'engrave' && (isPart(i) || i.plate === 'none'));
    const pegged = doc.items.filter((i) => isPart(i) && i.join === 'pegs');
    if (cut.length || pegged.length) {
      cut.forEach((i) => doc.updateItem(i.id, { mode: 'emboss' }, { coalesce: 'no-engrave' }));
      pegged.forEach((i) => doc.updateItem(i.id, { join: 'fuse' }, { coalesce: 'no-engrave' }));
      doc.endCoalescing();
      return; // the updates re-render
    }
  }
  const pegsRadio = document.querySelector('input[name="join"][value="pegs"]');
  pegsRadio.disabled = !engraveAvailable();
  pegsRadio.parentElement.title = engraveAvailable()
    ? 'Print the part separately and glue it into matching holes'
    : 'Pegs need a watertight model to make holes in';
  $('addSpotBtn').disabled = !modelInfo?.watertight;
  $('addSpotBtn').title = modelInfo?.watertight ? 'Clean up a clumped area of the model' : 'Clean-up spots need a watertight model';
  $('undoBtn').disabled = !doc.canUndo;
  $('redoBtn').disabled = !doc.canRedo;
  $('deleteBtn').disabled = !sel;
  $('duplicateBtn').disabled = !sel;
  $('clearBtn').disabled = !doc.base;
  document.querySelectorAll('[data-fix], #scaleBtn, #simplifyBtn').forEach((b) => (b.disabled = !doc.base));
  document.querySelectorAll('[data-side], [data-nudge], #snapBtn').forEach((b) => (b.disabled = !sel || !hasModel));
  document.querySelectorAll('[data-turn]').forEach((b) => (b.disabled = !sel));
  document.querySelector('input[name="mode"][value="engrave"]').disabled = !hasModel || !modelInfo?.watertight;
  $('placeHint').innerHTML = hasModel
    ? '<b>Click the model</b> to put the text there, or drag the text. Drag empty space to orbit, right-drag to pan, scroll to zoom.'
    : 'No model loaded, so there is nothing to place on – the text is exported on its own. Open an STL or use the sample plaque.';
  $('downloadBtn').disabled = !hasModel && !doc.items.some((i) => hasText(i) && !isSpot(i));

  if (contentChanged && $('resultToggle').checked && booted) {
    $('resultToggle').checked = false;
    viewer.showResult(false);
  }
  if (booted && !halted) {
    syncBase().then((ok) => {
      if (ok) refreshPreviews(); // a superseded sync leaves the previews to the sync that follows it
    });
  }
}

doc.subscribe(render);

/* ------------------------------------------------------------------ fonts */

function registerFont(id, label, group) {
  fonts.set(id, { label, group });
  linesSignature = ''; // line dropdowns need the new option
}

async function addUserFont(bytes, fileName) {
  const id = `user-${++userFontCount}`;
  const { label } = await client.addFont(id, bytes);
  registerFont(id, label, 'user');
  const sel = doc.selected;
  if (sel) doc.updateLine(sel.id, currentLine, { fontId: id });
  else addItem('', { lines: [{ ...lineDefaults(), fontId: id }] }, { focus: false });
  render();
  return label;
}

async function loadFontFile(file) {
  try {
    const label = await addUserFont(await file.arrayBuffer(), file.name);
    setStatus(`Using ${label}.`, 'ok');
  } catch (err) {
    setStatus(friendly(err), 'error');
  }
}

async function showLocalFonts() {
  try {
    const list = await listLocalFonts();
    const select = $('localFonts');
    select.replaceChildren(new Option('Choose an installed font…', ''));
    list.forEach((f, i) => select.append(new Option(f.fullName, String(i))));
    select.onchange = async () => {
      if (!select.value) return;
      const data = list[Number(select.value)];
      try {
        await addUserFont(await localFontBytes(data), data.fullName);
      } catch (err) {
        setStatus(`${friendly(err)}\nSome system fonts (.ttc collections, WOFF2) cannot be read – try another.`, 'error');
      }
    };
    $('localFontsField').hidden = false;
  } catch (err) {
    setStatus(`Could not list installed fonts: ${err.message}`, 'error');
  }
}

/* ----------------------------------------------------------- control wiring */

function bindControls() {
  const readValue = (el) => {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number' || el.type === 'range') return Number.parseFloat(el.value);
    return el.value;
  };

  document.querySelectorAll('[data-key]').forEach((el) => {
    const key = el.dataset.key;
    const continuous = el.type === 'range' || el.type === 'number' || el.tagName === 'TEXTAREA';
    const mirror = (value) => {
      // keep paired slider/number inputs in sync
      document.querySelectorAll(`[data-key="${key}"]`).forEach((other) => {
        if (other !== el && (other.type === 'range' || other.type === 'number')) other.value = value;
      });
    };
    const apply = (event) => {
      if (filling) return;
      if (el.type === 'radio' && !el.checked) return;
      let value = readValue(el);
      if (typeof value === 'number' && Number.isNaN(value)) return;
      if (PERCENT_KEYS.has(key)) value = key === 'scale' ? Math.max(0.01, value / 100) : Math.min(1, Math.max(0, value / 100));
      let sel = doc.selected;
      if (!sel) sel = addItem('', {}, { focus: false });
      mirror(readValue(el));
      // a clean-up spot's amounts re-derive the whole model: apply them on release, not on every tick
      if (event.type === 'input' && continuous && isSpot(sel) && HEAVY_SPOT_KEYS.has(key)) return;
      // the value already in force (the browser's own change event when a typed field loses focus) is not a change:
      // re-committing it would re-render the panel under whatever the user is clicking on
      if (sel[key] === value) return;
      doc.updateItem(sel.id, { [key]: value }, continuous ? { coalesce: `${key}:${sel.id}` } : undefined);
      if (key in defaults && !isPart(sel)) {
        defaults[key] = value;
        saveSettings();
      }
    };
    el.addEventListener(continuous ? 'input' : 'change', apply);
    if (continuous) {
      el.addEventListener('change', (event) => {
        apply(event);
        doc.endCoalescing();
      });
    }
  });

  ['posX', 'posY', 'posZ'].forEach((id, i) => {
    $(id).addEventListener('change', () => {
      const sel = doc.selected;
      const v = Number.parseFloat($(id).value);
      if (!sel || Number.isNaN(v)) return;
      const position = [...sel.position];
      position[i] = v;
      doc.updateItem(sel.id, { position });
    });
  });

  $('widthInput').addEventListener('change', () => {
    const sel = doc.selected;
    const target = Number.parseFloat($('widthInput').value);
    const current = previewInfo.get(sel?.id)?.size?.[0];
    if (!sel || !(target > 0) || !(current > 0)) return;
    const factor = target / current;
    const lines = sel.lines.map((l) => ({ ...l, size: Math.min(500, Math.max(0.5, Math.round(l.size * factor * 10) / 10)) }));
    doc.updateItem(sel.id, { lines });
  });

  $('roundCorners').addEventListener('change', () => {
    const sel = doc.selected;
    const on = $('roundCorners').checked;
    defaults.roundCorners = on;
    saveSettings();
    if (sel) doc.updateItem(sel.id, { cornerRadius: on ? Math.round((printing.nozzle / 2) * 100) / 100 : 0 });
  });

  for (const [id, key] of [['nozzle', 'nozzle'], ['layerHeight', 'layerHeight']]) {
    $(id).value = printing[key];
    $(id).addEventListener('change', () => {
      const v = Number.parseFloat($(id).value);
      if (!(v > 0)) return;
      printing[key] = v;
      saveSettings();
      render();
    });
  }

  document.querySelectorAll('[data-side]').forEach((btn) => btn.addEventListener('click', () => snapToSide(btn.dataset.side, { look: true })));
  $('snapBtn').addEventListener('click', snapToModel);
  $('addSpotBtn').addEventListener('click', addSpot);
  document.querySelectorAll('[data-turn]').forEach((btn) => btn.addEventListener('click', () => turnPart(btn.dataset.turn)));
  document.querySelectorAll('[data-nudge]').forEach((btn) =>
    btn.addEventListener('click', () => {
      nudge(btn.dataset.nudge, Number.parseFloat($('nudgeStep').value));
      doc.endCoalescing();
    }),
  );
  document.querySelectorAll('[data-fix]').forEach((btn) => btn.addEventListener('click', () => applyFix(btn.dataset.fix)));
  bindEnhance();
  $('scaleBtn').addEventListener('click', () => applyFix('scale'));
  $('simplifyBtn').addEventListener('click', () => applyFix('simplify'));

  $('addTextBtn').addEventListener('click', () => addItem());
  $('addLineBtn').addEventListener('click', () => {
    const sel = doc.selected ?? addItem('', {}, { focus: false });
    const at = doc.addLine(sel.id, currentLine);
    currentLine = at;
    focusLine(at);
  });
  // keyboard access to the Texts list: arrows move the selection
  $('itemList').addEventListener('keydown', (e) => {
    const items = doc.items;
    if (!items.length) return;
    const index = items.findIndex((i) => i.id === doc.state.selectedId);
    const pick = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 }[e.key];
    if (pick === undefined) return;
    e.preventDefault();
    doc.select(items[Math.min(items.length - 1, Math.max(0, pick))].id);
  });
  $('duplicateBtn').addEventListener('click', () => doc.selected && doc.duplicateItem(doc.selected.id));
  $('deleteBtn').addEventListener('click', deleteSelected);
  $('undoBtn').addEventListener('click', () => doc.undo());
  $('redoBtn').addEventListener('click', () => doc.redo());
  $('downloadBtn').addEventListener('click', download);
  $('sampleBtn').addEventListener('click', () => loadModel('sample'));
  $('clearBtn').addEventListener('click', () => loadModel('none'));
  $('frameBtn').addEventListener('click', () => viewer.frame());
  $('resultToggle').addEventListener('change', (e) => showResult(e.target.checked));

  $('openStlBtn').addEventListener('click', () => $('stlFile').click());
  $('openFontBtn').addEventListener('click', () => $('fontFile').click());
  $('openPartBtn').addEventListener('click', () => $('partFile').click());
  $('partFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) addPartFile(file);
  });
  $('stlFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) loadModel('stl', { bytes: await file.arrayBuffer(), name: file.name.replace(/\.stl$/i, '') });
  });
  $('fontFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) loadFontFile(file);
  });

  if (canQueryLocalFonts()) {
    $('localFontsBtn').hidden = false;
    $('localFontsBtn').addEventListener('click', showLocalFonts);
  }

  window.addEventListener('keydown', (e) => {
    // judge by the event's target: a handler may have re-rendered the focused field away already
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? '') || e.target?.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) doc.redo();
      else doc.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y' && !typing) {
      e.preventDefault();
      doc.redo();
      return;
    }
    if (typing || mod) return;
    const step = (e.shiftKey ? 5 : 1) * Number.parseFloat($('nudgeStep').value);
    const arrows = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    if (arrows[e.key] && doc.selected) {
      e.preventDefault();
      nudge(arrows[e.key], step);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && doc.selected) {
      e.preventDefault();
      deleteSelected();
    } else if ((e.key === '[' || e.key === ']') && doc.selected) {
      doc.updateItem(doc.selected.id, { spin: doc.selected.spin + (e.key === ']' ? 5 : -5) }, { coalesce: 'spin-key' });
    }
  });
  window.addEventListener('keyup', (e) => {
    if (/^Arrow|^[[\]]$/.test(e.key)) doc.endCoalescing(); // nudge / rotate runs
  });

  // drag & drop an .stl or a font file anywhere on the page
  let depth = 0;
  const hint = $('dropHint');
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    hint.hidden = false;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    if (--depth <= 0) hint.hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    hint.hidden = true;
    for (const file of e.dataTransfer?.files ?? []) {
      if (/\.stl$/i.test(file.name)) loadModel('stl', { bytes: await file.arrayBuffer(), name: file.name.replace(/\.stl$/i, '') });
      else if (/\.(ttf|otf|woff2?|ttc)$/i.test(file.name)) loadFontFile(file);
      else setStatus(`Don't know what to do with ${file.name}. Drop an .stl or a font file.`, 'error');
    }
  });
}

function deleteSelected() {
  const sel = doc.selected;
  if (!sel) return;
  const label = itemLabel(sel);
  doc.deleteItem(sel.id);
  toast(`Deleted “${label}”.`, { label: 'Undo', run: () => doc.undo() });
}

/* --------------------------------------------------------------------- boot */

async function boot() {
  loadSettings();
  bindControls();
  showProgress('Starting the geometry engine…');

  try {
    const first = BUNDLED_FONTS.find((f) => f.id === defaults.fontId) ?? BUNDLED_FONTS[0];
    const rest = BUNDLED_FONTS.filter((f) => f !== first);
    const add = async (f) => {
      const { label } = await client.addFont(f.id, await fetchBundledFont(f));
      registerFont(f.id, label.includes('–') ? label : f.label, 'bundled');
    };
    await add(first);
    // the sample plaque and the rest of the fonts load together
    const others = Promise.all(rest.map((f) => add(f).catch((err) => console.error(err))));
    await loadModel('sample');
    booted = true;
    doc.addItem({ ...itemDefaults(), lines: [{ ...lineDefaults(), text: 'Hello' }], ...topCenter() });
    await others;
    render();
    setStatus('Click the plaque to move the text, or open your own STL.');
  } catch (err) {
    console.error(err);
    setStatus(`Failed to start: ${friendly(err)}`, 'error');
  } finally {
    booted = true;
    document.body.dataset.engine = client.state === 'busy' ? 'busy' : 'idle';
  }
}

boot();
