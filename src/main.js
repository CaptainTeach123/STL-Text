import { Vector3 } from 'three';
import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url';
import { initManifold } from './manifold.js';
import { Editor, samplePlaque } from './editor.js';
import { NotWatertightError, describe, manifoldToGeometry, toDisplayGeometry } from './mesh.js';
import { SIDES, placementMatrix, toMat4 } from './placement.js';
import { parseSTL, writeBinarySTL } from './stl.js';
import { buildTextSolid } from './textGeometry.js';
import { Viewer } from './viewer.js';
import {
  BUNDLED_FONTS,
  canQueryLocalFonts,
  labelFor,
  listLocalFonts,
  loadBundled,
  loadLocalFont,
  parseFont,
} from './fonts.js';

const $ = (id) => document.getElementById(id);
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/* ------------------------------------------------------------------ state */

const state = {
  text: 'STL Text',
  size: 10,
  letterSpacing: 0,
  lineSpacing: 1.7,
  align: 'center',
  weight: 0,
  mirror: false,
  quality: 'normal',
  mode: 'emboss',
  depth: 1.5,
  overlap: 0.4,
  position: [0, 0, 0],
  normal: [0, 0, 1],
  spin: 0,
  pending: true, // text is shown as a preview and has not been merged yet
};

const editor = new Editor();
const viewer = new Viewer($('stage'));

const fonts = new Map(); // id -> { label, font?, load? }
let fontId = null;
let font = null;
let fontRequest = 0;

let solid = null; // Manifold of the current text, in text-local space
let solidKey = '';
let shownKey = null; // which solid the viewer is currently showing
let rebuildTimer = 0;

/* ---------------------------------------------------------------- helpers */

function setStatus(message, kind = '') {
  const el = $('status');
  el.textContent = message;
  el.className = `status ${kind}`.trim();
}

function busy(on) {
  $('busy').hidden = !on;
}

const hasText = () => state.text.trim().length > 0;

/** Text settings as the geometry builder wants them. */
function settings() {
  const withModel = editor.hasModel;
  return {
    size: state.size,
    letterSpacing: state.letterSpacing,
    lineSpacing: state.lineSpacing,
    align: state.align,
    weight: state.weight,
    mirror: state.mirror,
    quality: state.quality,
    mode: withModel ? state.mode : 'emboss',
    depth: state.depth,
    overlap: withModel ? state.overlap : 0,
  };
}

function currentMatrix() {
  return editor.hasModel
    ? placementMatrix({ position: state.position, normal: state.normal, spin: state.spin })
    : placementMatrix({ position: [0, 0, 0], normal: [0, 0, 1], spin: state.spin });
}

function friendly(err) {
  if (err instanceof NotWatertightError) {
    return (
      'This model has holes or broken edges, so cutting into it is not reliable.\n' +
      'Repair it first (most slicers, Windows 3D Builder and Meshmixer can do this), or use Emboss instead.'
    );
  }
  return err?.message ?? String(err);
}

/* ------------------------------------------------------- text solid + view */

/** The text solid for the current settings (cached while nothing changes). */
function ensureSolid() {
  const opts = settings();
  const key = JSON.stringify([fontId, state.text, opts]);
  if (key === solidKey) return solid;
  solid?.delete();
  solid = null;
  solidKey = key;
  shownKey = null;
  if (!font || !hasText()) return null;
  try {
    solid = buildTextSolid(font, state.text, opts);
  } catch (err) {
    solidKey = '';
    setStatus(`Could not build the text: ${err.message}`, 'error');
  }
  return solid;
}

/** Make the viewer show (or hide) the pending text. */
function refreshOverlay() {
  if (!state.pending || !hasText() || !font) {
    if (shownKey !== null) viewer.setText(null);
    shownKey = null;
    return;
  }
  const s = ensureSolid();
  if (!s) {
    viewer.setText(null);
    shownKey = null;
    if (hasText() && solidKey) setStatus('The font has no outlines for those characters.', 'error');
    return;
  }
  if (shownKey === solidKey) {
    viewer.setTextMatrix(currentMatrix());
    return;
  }
  const geometry = manifoldToGeometry(s);
  viewer.setText(geometry, currentMatrix(), settings().mode);
  geometry.dispose();
  shownKey = solidKey;
  const box = s.boundingBox();
  setStatus(`Text is ${(box.max[0] - box.min[0]).toFixed(1)} × ${(box.max[1] - box.min[1]).toFixed(1)} mm.`);
}

/** Something changed: re-show the preview (debounced when the shape changes). */
function touch({ shape = true } = {}) {
  state.pending = true;
  updateUi();
  clearTimeout(rebuildTimer);
  if (shape) rebuildTimer = setTimeout(refreshOverlay, 120);
  else refreshOverlay();
}

/* ------------------------------------------------------------- model state */

function refreshModel() {
  const withModel = editor.hasModel;
  viewer.setModel(withModel ? toDisplayGeometry(editor.model.geometry) : null);
  viewer.setHoverEnabled(withModel);
  const info = $('modelInfo');
  if (withModel) {
    const d = describe(editor.model.geometry);
    const warn = editor.model.manifold ? '' : '\n⚠ Not watertight: text can be added (Emboss) but not cut.';
    info.textContent =
      `${editor.name}: ${d.size.map((n) => n.toFixed(1)).join(' × ')} mm · ${d.triangles.toLocaleString()} triangles${warn}`;
  } else {
    info.textContent = 'No model: the text will be exported on its own, flat on the build plate.';
  }
  if (!withModel && state.mode === 'engrave') {
    state.mode = 'emboss';
    document.querySelector('input[name="mode"][value="emboss"]').checked = true;
  }
  shownKey = null;
  updateUi();
}

function updateUi() {
  const withModel = editor.hasModel;
  const text = hasText();
  $('undoBtn').disabled = !editor.canUndo;
  $('applyBtn').disabled = !withModel || !text || !state.pending;
  $('downloadBtn').disabled = !withModel && !text;
  $('downloadBtn').textContent = state.pending && text ? 'Download STL (with text)' : 'Download STL';
  $('clearBtn').disabled = !withModel;
  document.querySelector('input[name="mode"][value="engrave"]').disabled = !withModel;
  for (const id of ['posX', 'posY', 'posZ']) $(id).disabled = !withModel;
  document.querySelectorAll('[data-side]').forEach((b) => (b.disabled = !withModel));
  $('depthLabel').innerHTML = `${state.mode === 'engrave' ? 'Depth' : 'Height'} <small>mm</small>`;
  $('placeHint').innerHTML = withModel
    ? '<b>Click the model</b> to put the text there. Drag to orbit, right-drag to pan, scroll to zoom.'
    : 'No model loaded, so there is nothing to place on. Open an STL or use the sample plaque.';
}

function setPlacement(point, normal) {
  state.position = point.map((v) => Math.round(v * 100) / 100);
  state.normal = normal;
  ['posX', 'posY', 'posZ'].forEach((id, i) => ($(id).value = state.position[i]));
}

/** Snap the text to the middle of one side of the model's bounding box. */
function snapToSide(side, { look = false } = {}) {
  if (!editor.hasModel) return;
  const n = SIDES[side];
  const box = viewer.bounds;
  const center = box.getCenter(new Vector3());
  const axis = n.findIndex((v) => v !== 0);
  const outward = n[axis] > 0;
  const origin = center.toArray();
  origin[axis] = (outward ? box.max : box.min).getComponent(axis) + (outward ? 1 : -1);
  const hit = viewer.raycastFrom(origin, n.map((v) => -v));
  const faceCenter = center.toArray();
  faceCenter[axis] = (outward ? box.max : box.min).getComponent(axis);
  const point = hit ? hit.point : faceCenter;
  setPlacement(point, n);
  if (look) viewer.lookAt(point, n);
  touch({ shape: false });
}

viewer.onPick = ({ point, normal }) => {
  setPlacement(point, normal);
  touch({ shape: false });
};

/* ----------------------------------------------------------------- actions */

async function apply() {
  if (!editor.hasModel) return false;
  const s = ensureSolid();
  if (!s) {
    setStatus('Type some text first.', 'error');
    return false;
  }
  busy(true);
  await nextFrame();
  try {
    const mode = settings().mode;
    const { fallback } = editor.applyText(s, currentMatrix(), mode);
    state.pending = false;
    viewer.setText(null);
    shownKey = null;
    refreshModel();
    setStatus(
      fallback
        ? 'Text added as a separate overlapping shell (the model is not watertight). Most slicers merge it fine.'
        : 'Text merged into the model. Download it, or click the model to add more text.',
      'ok',
    );
    return true;
  } catch (err) {
    setStatus(friendly(err), 'error');
    return false;
  } finally {
    busy(false);
  }
}

function undo() {
  if (!editor.undo()) return;
  state.pending = false;
  viewer.setText(null);
  refreshModel();
  setStatus('Undid the last merge.');
}

async function download() {
  let geometry;
  let name;
  if (editor.hasModel) {
    if (state.pending && hasText() && !(await apply())) return;
    geometry = editor.model.geometry;
    name = `${editor.name}-text`;
  } else {
    const s = ensureSolid();
    if (!s) return setStatus('Type some text first.', 'error');
    const placed = s.transform(toMat4(currentMatrix()));
    geometry = manifoldToGeometry(placed);
    placed.delete();
    name = 'text';
  }
  const blob = new Blob([writeBinarySTL(geometry, 'STL-Text')], { type: 'model/stl' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^\w.-]+/g, '_')}.stl`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  setStatus(`Downloaded ${a.download} (${(blob.size / 1024).toFixed(0)} KB).`, 'ok');
}

async function loadStl(file) {
  busy(true);
  await nextFrame();
  try {
    const geometry = parseSTL(await file.arrayBuffer());
    const { watertight } = editor.load(geometry, file.name.replace(/\.stl$/i, ''));
    state.pending = true;
    refreshModel();
    viewer.frame();
    snapToSide('top');
    setStatus(
      watertight
        ? `Loaded ${file.name}. Click the model to place your text.`
        : `Loaded ${file.name}, but it is not watertight – you can emboss text onto it but not engrave.`,
      watertight ? 'ok' : '',
    );
  } catch (err) {
    setStatus(`Could not open ${file.name}: ${err.message}`, 'error');
  } finally {
    busy(false);
  }
}

function useSample() {
  const plaque = samplePlaque();
  editor.loadSolid(plaque, 'plaque');
  state.pending = true;
  refreshModel();
  viewer.frame();
  snapToSide('top');
}

function useNoModel() {
  editor.clear();
  state.pending = true;
  refreshModel();
  viewer.frame();
  touch({ shape: false });
}

/* -------------------------------------------------------------------- fonts */

function registerFont(id, entry, group) {
  fonts.set(id, entry);
  const option = new Option(entry.label, id);
  (group === 'user' ? $('userFonts') : $('bundledFonts')).append(option);
  if (group === 'user') $('userFonts').hidden = false;
}

async function useFont(id) {
  const entry = fonts.get(id);
  if (!entry) return;
  const request = ++fontRequest;
  $('font').value = id;
  try {
    const loaded = entry.font ?? (entry.font = await entry.load());
    if (request !== fontRequest) return; // a newer choice won
    font = loaded;
    fontId = id;
    touch();
  } catch (err) {
    if (request !== fontRequest) return;
    setStatus(err.message, 'error');
    $('font').value = fontId ?? '';
  }
}

let userFontCount = 0;
function addUserFont(parsed, fileName) {
  const id = `user-${++userFontCount}`;
  registerFont(id, { label: labelFor(parsed, fileName), font: parsed }, 'user');
  return useFont(id);
}

async function loadFontFile(file) {
  try {
    await addUserFont(parseFont(await file.arrayBuffer(), file.name), file.name);
    setStatus(`Using ${file.name}.`, 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
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
      try {
        const data = list[Number(select.value)];
        await addUserFont(await loadLocalFont(data), data.fullName);
      } catch (err) {
        setStatus(`${err.message}\nSome system fonts (.ttc collections, WOFF2) cannot be read – try another.`, 'error');
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
    const evt = el.type === 'radio' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      const key = el.dataset.key;
      if (el.type === 'radio' && !el.checked) return;
      if (key === 'font') return useFont(el.value);
      const value = readValue(el);
      if (typeof value === 'number' && Number.isNaN(value)) return;
      state[key] = value;
      // keep paired slider/number inputs in sync
      document.querySelectorAll(`[data-key="${key}"]`).forEach((other) => {
        if (other !== el && (other.type === 'range' || other.type === 'number')) other.value = value;
      });
      touch({ shape: key !== 'spin' });
    });
  });

  ['posX', 'posY', 'posZ'].forEach((id, i) => {
    $(id).addEventListener('input', () => {
      const v = Number.parseFloat($(id).value);
      if (Number.isNaN(v)) return;
      state.position[i] = v;
      touch({ shape: false });
    });
  });

  document.querySelectorAll('[data-side]').forEach((btn) =>
    btn.addEventListener('click', () => snapToSide(btn.dataset.side, { look: true })),
  );

  $('applyBtn').addEventListener('click', apply);
  $('undoBtn').addEventListener('click', undo);
  $('downloadBtn').addEventListener('click', download);
  $('sampleBtn').addEventListener('click', useSample);
  $('clearBtn').addEventListener('click', useNoModel);
  $('frameBtn').addEventListener('click', () => viewer.frame());

  $('openStlBtn').addEventListener('click', () => $('stlFile').click());
  $('openFontBtn').addEventListener('click', () => $('fontFile').click());
  $('stlFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) loadStl(file);
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
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing && editor.canUndo) {
      e.preventDefault();
      undo();
    }
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
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    hint.hidden = true;
    for (const file of e.dataTransfer?.files ?? []) {
      if (/\.stl$/i.test(file.name)) loadStl(file);
      else if (/\.(ttf|otf|woff2?|ttc)$/i.test(file.name)) loadFontFile(file);
      else setStatus(`Don't know what to do with ${file.name}. Drop an .stl or a font file.`, 'error');
    }
  });
}

/* --------------------------------------------------------------------- boot */

async function boot() {
  busy(true);
  bindControls();
  const group = (id, label) => {
    const g = document.createElement('optgroup');
    g.id = id;
    g.label = label;
    return g;
  };
  $('font').append(group('bundledFonts', 'Built in'), group('userFonts', 'Your fonts'));
  $('userFonts').hidden = true;
  for (const f of BUNDLED_FONTS) registerFont(f.id, { label: f.label, load: () => loadBundled(f) }, 'bundled');

  try {
    await initManifold(manifoldWasmUrl);
    useSample();
    await useFont(BUNDLED_FONTS[0].id);
    refreshOverlay();
    setStatus('Click the plaque to move the text, or open your own STL.');
  } catch (err) {
    console.error(err);
    setStatus(`Failed to start: ${err.message}`, 'error');
  } finally {
    busy(false);
  }
}

boot();
