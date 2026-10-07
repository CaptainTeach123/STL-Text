import { Matrix4, Vector3 } from 'three';
import { Document, ITEM_DEFAULTS, frameOf, hasText, placeKey, shapeKey, stableKey } from './document.js';
import { createEngineClient } from './engineClient.js';
import { Viewer } from './viewer.js';
import { SIDES, placementMatrix } from './placement.js';
import { BUNDLED_FONTS, canQueryLocalFonts, fetchBundledFont, listLocalFonts, localFontBytes } from './fontCatalog.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'stltext.settings.v2';

/* ------------------------------------------------------------------ state */

const doc = new Document();
const viewer = new Viewer($('stage'));
const fonts = new Map(); // fontId -> { label, group }
const printing = { nozzle: 0.4, layerHeight: 0.2 };
const defaults = { fontId: 'inter', size: 10, mode: 'emboss', depth: 1.5, quality: 'normal', roundCorners: false };

const previewKeys = new Map(); // itemId -> key of the last preview requested
const previewInfo = new Map(); // itemId -> { size, notes, stats }
let modelInfo = null; // info of the model as the engine sees it
let modelReport = null;
let sentVersion = null; // doc.baseVersion the engine currently has
let basePending = null; // promise of the base request in flight, if any
let lastContentKey = '';
let lastClick = null; // { position, normal } of the last click on the model
let booted = false;
let userFontCount = 0;
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
  const pending = client.loadBase({ kind, bytes, name, version: sentVersion });
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
    if (basePending === pending) basePending = null;
  }
}

/** Make sure the engine has the document's current model state. */
async function syncBase() {
  if (sentVersion === version()) {
    if (basePending) await basePending; // previews must wait for the model they are for
    return;
  }
  const v = version();
  sentVersion = v;
  const pending = doc.base
    ? client.updateBase({ version: v, transforms: doc.base.transforms, simplify: doc.base.simplify })
    : client.loadBase({ kind: 'none', version: v });
  basePending = pending;
  try {
    const result = await pending;
    if (result) onBase(result);
    else if (sentVersion === v) sentVersion = null; // superseded: let the next render re-sync
  } catch (err) {
    sentVersion = null;
    setStatus(friendly(err), 'error');
  } finally {
    if (basePending === pending) basePending = null;
  }
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

/* ------------------------------------------------------------------- items */

const engraveAvailable = () => !!(modelInfo?.hasModel && modelInfo?.watertight);

const itemDefaults = () => ({
  fontId: fonts.has(defaults.fontId) ? defaults.fontId : 'inter',
  size: defaults.size,
  mode: engraveAvailable() ? defaults.mode : 'emboss',
  depth: defaults.depth,
  quality: defaults.quality,
  cornerRadius: defaults.roundCorners ? Math.round((printing.nozzle / 2) * 100) / 100 : 0,
});

function addItem(text = '', overrides = {}, { focus = true } = {}) {
  const from = doc.selected;
  const place = lastClick ?? (from && { position: from.position, normal: from.normal }) ?? topCenter();
  const item = doc.addItem({
    ...itemDefaults(),
    ...(from ? { fontId: from.fontId, size: from.size, mode: from.mode, depth: from.depth, quality: from.quality, cornerRadius: from.cornerRadius } : {}),
    text,
    ...place,
    ...overrides,
  });
  if (focus) $('text').focus();
  return item;
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
  if (!done && point) doc.updateItem(itemId, { position: point, normal }, { coalesce: 'drag' });
  if (done) {
    doc.endCoalescing();
    if (point) lastClick = { position: point, normal };
  }
};

/* --------------------------------------------------------------- previews */

const previewKey = (item) => `${shapeKey(item)}|${placeKey(item)}|${version()}|${stableKey(printing)}`;

function refreshPreviews() {
  const ids = new Set();
  for (const item of doc.items) {
    if (!hasText(item) || !fonts.has(item.fontId)) {
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
          viewer.setOverlay(item.id, { geometry: r.geometry, matrix: r.matrix, mode: item.mode, selected: item.id === doc.state.selectedId });
          previewInfo.set(item.id, { size: r.size, notes: r.notes, stats: r.stats });
        }
        if (item.id === doc.state.selectedId) renderSelectedInfo();
      })
      .catch((err) => {
        if (previewKeys.get(item.id) !== key) return;
        viewer.setOverlayStale(item.id, false);
        previewInfo.set(item.id, { size: null, notes: [{ level: 'warn', code: err.code, text: friendly(err) }], stats: null });
        if (item.id === doc.state.selectedId) renderSelectedInfo();
      });
  }
  for (const id of [...previewKeys.keys()]) {
    if (!ids.has(id)) {
      previewKeys.delete(id); // a late response for a removed item is then ignored
      previewInfo.delete(id);
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
  const items = doc.items.filter(hasText);
  if (!items.length && !modelInfo?.hasModel) return setStatus('Type some text or open a model first.', 'error');
  const name = modelInfo?.hasModel ? `${modelInfo.name}-text` : items.map((i) => i.text.trim().split('\n')[0]).join('-').slice(0, 40) || 'text';
  try {
    const r = await client.export(doc.items, version(), name, { printing });
    if (!r) return;
    const blob = new Blob([r.stl], { type: 'model/stl' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\w.-]+/g, '_')}.stl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    const warnings = r.notes.filter((n) => n.level === 'warn');
    setStatus(
      `Downloaded ${a.download} (${(blob.size / 1024).toFixed(0)} KB, ${r.triangles.toLocaleString()} triangles).` +
        (warnings.length ? `\n${warnings.map((n) => n.text).join('\n')}` : ''),
      warnings.length ? 'error' : 'ok',
    );
  } catch (err) {
    setStatus(friendly(err), 'error');
  }
}

/* ----------------------------------------------------------------- render */

let filling = false;
function fillPanel(item) {
  filling = true;
  try {
    const card = $('textCard');
    card.classList.toggle('disabled', !item);
    document.querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const value = item ? item[key] : ITEM_DEFAULTS[key];
      if (el.type === 'radio') el.checked = el.value === String(value);
      else if (el.type === 'checkbox') el.checked = !!value;
      else if (el.tagName === 'SELECT' && key === 'fontId') el.value = fonts.has(value) ? value : el.value;
      else if (el.type === 'number' || el.type === 'range') {
        // "0.0" being typed is numerically 0: leave it alone rather than mangle it
        if (Number.parseFloat(el.value) !== value) el.value = value ?? '';
      } else if (el.value !== String(value ?? '')) el.value = value ?? '';
    });
    ['posX', 'posY', 'posZ'].forEach((id, i) => ($(id).value = item ? Math.round(item.position[i] * 100) / 100 : 0));
    $('roundCorners').checked = !!item && item.cornerRadius > 0;
    $('depthLabel').innerHTML = `${item?.mode === 'engrave' ? 'Depth' : 'Height'} <small>mm</small>`;
  } finally {
    filling = false;
  }
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
      glyph.className = `glyph ${item.mode}`;
      glyph.textContent = item.mode === 'engrave' ? 'C' : 'R';
      glyph.title = item.mode === 'engrave' ? 'Cut in' : 'Raised';
      const name = document.createElement('span');
      const first = item.text.trim().split('\n')[0];
      name.className = `name${first ? '' : ' empty'}`;
      name.textContent = first || 'empty text';
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${item.size} mm`;
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
  if (sel && !fonts.has(sel.fontId)) notes.unshift({ level: 'warn', text: 'This font is not available – choose another one.' });
  renderNotes($('textNotes'), notes, {
    CUT_THROUGH: (n) => n.suggestedDepth && { label: `Use ${n.suggestedDepth} mm`, run: () => doc.updateItem(sel.id, { depth: n.suggestedDepth }) },
    THIN_STROKES: (n) => n.suggestedWeight != null && { label: 'Make bolder', run: () => doc.updateItem(sel.id, { weight: n.suggestedWeight }) },
    SHALLOW: (n) => n.suggestedDepth && { label: `Use ${n.suggestedDepth} mm`, run: () => doc.updateItem(sel.id, { depth: n.suggestedDepth }) },
    NOT_TOUCHING: () => modelInfo?.hasModel && { label: 'Put on top', run: () => snapToSide('top') },
  });
  const width = info?.size?.[0];
  if (document.activeElement !== $('widthInput')) $('widthInput').value = width ? fmt(width) : '';
  $('widthHint').textContent = width ? 'scales the letters' : '';
}

function render() {
  const sel = doc.selected;
  const contentKey = stableKey({ items: doc.items, base: doc.state.baseVersion, printing });
  const contentChanged = contentKey !== lastContentKey;
  lastContentKey = contentKey;

  renderItems();
  fillPanel(sel);
  renderSelectedInfo();

  const hasModel = !!modelInfo?.hasModel;
  if (booted && !engraveAvailable()) {
    // cut-in text needs a watertight model; whatever path got us here, make such items raised
    const cut = doc.items.filter((i) => i.mode === 'engrave');
    if (cut.length) {
      cut.forEach((i) => doc.updateItem(i.id, { mode: 'emboss' }, { coalesce: 'no-engrave' }));
      doc.endCoalescing();
      return; // the updates re-render
    }
  }
  $('undoBtn').disabled = !doc.canUndo;
  $('redoBtn').disabled = !doc.canRedo;
  $('deleteBtn').disabled = !sel;
  $('duplicateBtn').disabled = !sel;
  $('clearBtn').disabled = !doc.base;
  document.querySelectorAll('[data-fix], #scaleBtn, #simplifyBtn').forEach((b) => (b.disabled = !doc.base));
  document.querySelectorAll('[data-side], [data-nudge]').forEach((b) => (b.disabled = !sel || !hasModel));
  document.querySelector('input[name="mode"][value="engrave"]').disabled = !hasModel || !modelInfo?.watertight;
  $('placeHint').innerHTML = hasModel
    ? '<b>Click the model</b> to put the text there, or drag the text. Drag empty space to orbit, right-drag to pan, scroll to zoom.'
    : 'No model loaded, so there is nothing to place on – the text is exported on its own. Open an STL or use the sample plaque.';
  $('downloadBtn').disabled = !hasModel && !doc.items.some(hasText);

  if (contentChanged && $('resultToggle').checked && booted) {
    $('resultToggle').checked = false;
    viewer.showResult(false);
  }
  if (booted && !halted) {
    syncBase().then(refreshPreviews);
  }
}

doc.subscribe(render);

/* ------------------------------------------------------------------ fonts */

function registerFont(id, label, group) {
  fonts.set(id, { label, group });
  const option = new Option(label, id);
  const target = group === 'user' ? $('userFonts') : $('bundledFonts');
  target.append(option);
  target.hidden = false;
}

async function addUserFont(bytes, fileName) {
  const id = `user-${++userFontCount}`;
  const { label } = await client.addFont(id, bytes);
  registerFont(id, label, 'user');
  const sel = doc.selected;
  if (sel) doc.updateItem(sel.id, { fontId: id });
  else addItem('', { fontId: id }, { focus: false });
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
    el.addEventListener(continuous ? 'input' : 'change', () => {
      if (filling) return;
      if (el.type === 'radio' && !el.checked) return;
      const value = readValue(el);
      if (typeof value === 'number' && Number.isNaN(value)) return;
      let sel = doc.selected;
      if (!sel) sel = addItem(key === 'text' ? value : '', {}, { focus: false });
      // keep paired slider/number inputs in sync
      document.querySelectorAll(`[data-key="${key}"]`).forEach((other) => {
        if (other !== el && (other.type === 'range' || other.type === 'number')) other.value = value;
      });
      doc.updateItem(sel.id, { [key]: value }, continuous ? { coalesce: `${key}:${sel.id}` } : undefined);
      if (key in defaults && key !== 'fontId') {
        defaults[key] = value;
        saveSettings();
      } else if (key === 'fontId' && fonts.get(value)?.group === 'bundled') {
        defaults.fontId = value;
        saveSettings();
      }
    });
    if (continuous) el.addEventListener('change', () => doc.endCoalescing());
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
    const size = Math.min(500, Math.max(0.5, Math.round(((sel.size * target) / current) * 10) / 10));
    doc.updateItem(sel.id, { size });
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
  document.querySelectorAll('[data-nudge]').forEach((btn) =>
    btn.addEventListener('click', () => {
      nudge(btn.dataset.nudge, Number.parseFloat($('nudgeStep').value));
      doc.endCoalescing();
    }),
  );
  document.querySelectorAll('[data-fix]').forEach((btn) => btn.addEventListener('click', () => applyFix(btn.dataset.fix)));
  $('scaleBtn').addEventListener('click', () => applyFix('scale'));
  $('simplifyBtn').addEventListener('click', () => applyFix('simplify'));

  $('addTextBtn').addEventListener('click', () => addItem());
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
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
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
  const label = sel.text.trim().split('\n')[0] || 'empty text';
  doc.deleteItem(sel.id);
  toast(`Deleted “${label}”.`, { label: 'Undo', run: () => doc.undo() });
}

/* --------------------------------------------------------------------- boot */

async function boot() {
  loadSettings();
  bindControls();
  const group = (id, label) => {
    const g = document.createElement('optgroup');
    g.id = id;
    g.label = label;
    return g;
  };
  $('font').append(group('bundledFonts', 'Built in'), group('userFonts', 'Your fonts'));
  $('userFonts').hidden = true;
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
    doc.addItem({ ...itemDefaults(), text: 'Hello', ...topCenter() });
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
