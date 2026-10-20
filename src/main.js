import { Matrix4, Vector3 } from 'three';
import { Document, ITEM_DEFAULTS, SPLIT_DEFAULTS, baseMode, coversOf, createPart, createSpot, fontIds, frameOf, hasText, isPart, isSpot, itemLabel, maxSize, placeKey, shapeKey, spotsOf, stableKey, modelPlacementKey } from './document.js';
import { planRebuild, removalSpotsFor, specForKind } from './rebuild.js';
import { DECOR_KINDS, decorPartId, normaliseDecorSpec } from './decor.js';
import { createEngineClient } from './engineClient.js';
import { ENHANCE_DEFAULTS, isEnhanceActive } from './enhance.js';
import { Viewer } from './viewer.js';
import {
  aimLine, aimTargets, bandOf, handlePlaneWords, lipLine, lipVerdict, noFitTestWords, partCard, partFace, partMeta, partOffered, partReadout, partWidth, partsNote,
  percentOf, pickPart, noLockOf, noLockTitle, snapTolerance, snappedWords, spotLabel, throughWords, wayCaption, widthWords,
} from './aim.js';
import { gminOf, offerPercent, roundZ } from './locks.js';
import { SIDES, placementMatrix, snapPartTo } from './placement.js';
import { BUNDLED_FONTS, canQueryLocalFonts, fetchBundledFont, listLocalFonts, localFontBytes } from './fontCatalog.js';
import {
  BED_DEFAULTS, BED_PRESETS, FILAMENT, PIECE_COLORS, SPLIT_LIMITS, SPLIT_NOTE_CODES, axisCuts, bedSize, cellFits, cellSizes, cutPlane, fitPieces, formatSize,
  letterFor, nextCut, pegSizeOf, pieceColorIndex, splitActive, splitNote, usableBed, wayStep,
} from './split.js';

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
// the printer the pieces of a split must fit (not in `printing`: that is part of every preview's key)
const bed = { preset: BED_DEFAULTS.preset, size: [...BED_DEFAULTS.size], margin: BED_DEFAULTS.margin };
// the split settings used last, which the next model's split starts from
const splitDefaults = Object.fromEntries(Object.entries(SPLIT_DEFAULTS).filter(([key]) => key !== 'cuts'));

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

// split for printing: view state, never in the document
let selectedCutId = null; // the cut the arrow keys move (selecting an item lets go of it)
let lastSplitKey = ''; // what the pieces depend on besides the content: the split, the printer and the nozzle
let lastPieces = null; // the pieces last computed: { key, content, pieces, seams, grid, diameter, pegSize, notes }
let measured = null; // the cuts last measured on the model: { key, cuts: Map(id -> { area, islands, joint, crosses }), notes, pieces }
let downloaded = null; // { key, content, count }: how many pieces the last download held, for the split and content it was made for
let joined = null; // { key, content, joints: Map(id -> 'dovetail' | 'dowels' | 'pegs' | 'none') } the joint each cut got when the split was last worked out
let splitBounds = null; // { version, key, bounds } of the model and its text from the last measure (text-only work has no other)
let planNotes = null; // { key, content, notes } of a Fit to my printer that cut nothing
let offerPlan = null; // { key, plan } of the last Fit to my printer planned, ahead or on a click: the count the Model card offers
let loads = 0; // models opened so far: a fit planned for one is never applied to the next

const client = createEngineClient({
  createWorker: () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }),
  onProgress: ({ stage }) => {
    if (offerBusy && !splitWork) return; // the Model card's offer being planned ahead: nobody is waiting for it
    if (spots?.busy && spots.quiet && stage === 'Looking for good spots…') return; // the spots listed, asked again quietly
    showProgress(stage);
  },
  onState: (state) => {
    document.body.dataset.engine = !booted ? 'starting' : state === 'busy' ? 'busy' : 'idle';
    if (state !== 'busy') {
      showProgress(null);
      // a moment later: what a request answered asks for next (a model updated: its previews) goes first
      if (idleWaiters.length) setTimeout(flushIdle, 0);
    }
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

const idleWaiters = []; // what waits for the engine to have nothing else to do (`whenIdle`)

/** Run each waiter once the engine is idle and nothing else is asked of it meanwhile. */
function flushIdle() {
  if (client.state === 'busy' || basePending || !idleWaiters.length) return;
  for (const run of idleWaiters.splice(0)) run();
}

/**
 * Run `run` once the engine has nothing else to do: work nobody waits for goes after what an edit asks for itself (a
 * model turned: its update and the previews of its text), never ahead of it on the one worker.
 */
function whenIdle(run) {
  idleWaiters.push(run);
  setTimeout(flushIdle, 0);
}

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
let toastStep = null; // the undo step an Undo toast takes back
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
  toastStep = action?.step ?? null;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}

/**
 * A toast whose Undo takes back the edit just made. It stays only while
 * that edit is the latest: after another one its Undo would take back that
 * one instead, so it goes (the toolbar's Undo steps back through both).
 */
function undoToast(text) {
  const step = doc.history.at(-1);
  toast(text, { label: 'Undo', step, run: () => doc.history.at(-1) === step && doc.undo() });
}

/** Called on every change of the document: an Undo toast goes once its edit is no longer the latest. */
function dropStaleToast() {
  if (toastStep && doc.history.at(-1) !== toastStep) {
    $('toast').hidden = true;
    toastStep = null;
  }
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
    case 'SPLIT_INVALID':
      return err.message || 'The split settings are invalid – remove the cuts and try again.';
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
    // older saves have no printer or split settings: what they lack keeps its default
    if (BED_PRESETS[saved.bed?.preset]) bed.preset = saved.bed.preset;
    if (Array.isArray(saved.bed?.size)) bed.size = bedSize({ preset: 'custom', size: saved.bed.size });
    if (Number.isFinite(saved.bed?.margin)) bed.margin = Math.min(20, Math.max(0, saved.bed.margin));
    for (const key of Object.keys(splitDefaults)) {
      if (typeof saved.splitDefaults?.[key] === typeof splitDefaults[key]) splitDefaults[key] = saved.splitDefaults[key];
    }
  } catch {
    /* fresh start */
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ printing, defaults, bed, splitDefaults }));
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
  if (info.covered) {
    notes.push({
      level: 'ok',
      text: `${info.covered} ${info.covered === 1 ? 'item cuts' : 'items cut'} the model, consuming or removing the details under ${info.covered === 1 ? 'it' : 'them'}: it is shown and downloaded that way.`,
    });
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
  const tooBig = bedTooSmall();
  if (tooBig) notes.push(tooBig);
  return { text, notes };
}

let tooBigFor = { key: null, note: null };
/**
 * The "bigger than your printer" note for a model with no cuts yet, with a
 * first guess from its box at the pieces it takes (`pieces`, 0 when even 64
 * would not do), or null when it fits. A thin plate is counted lying flat,
 * with the dovetail tabs its joints may get: stood on its edge it might fit,
 * but it is never printed that way. Built-in pegs make pieces longer by as
 * far as they stand out, which the peg size and depth decide. Worked out
 * here, not by the engine: it knows no printer. The number the note offers
 * is the plan's (`offerLabel`).
 */
function bedTooSmall() {
  if (!modelInfo?.hasModel || !modelInfo.size || splitActive(doc.split)) return null;
  const U = usableBed(bed);
  const spec = { ...SPLIT_DEFAULTS, ...splitDefaults, ...doc.split }; // the joints decide whether a plate's pieces grow tabs
  const passthrough = (modelInfo.passthroughTriangles ?? 0) > 0; // unrepaired triangles rule dovetails out
  const key = `${modelInfo.size}|${U}|${bedSize(bed)}|${spec.joint}|${spec.diameter}|${spec.depth}|${passthrough}`;
  if (tooBigFor.key !== key) {
    const fit = fitPieces(modelInfo.size, U, spec, { passthrough });
    tooBigFor = { key, note: fit.fits ? null : splitNote('BED_TOO_SMALL', { size: modelInfo.size, bed: bedSize(bed), pieces: fit.pieces }) };
  }
  return tooBigFor.note;
}

const SPLIT_TO_FIT = 'Split to fit'; // the offer while the plan's count is not known

/**
 * What the "bigger than your printer" note offers: "Split into N pieces"
 * once Fit to my printer's plan for the model, its text, the printer and
 * the joints as they are now is known, "Split to fit" until then, and
 * nothing when there is nothing to offer (64 pieces would not do, or the
 * model has gaps). Only the plan knows N: the box alone would give a cone
 * four pieces that stand on a point or an edge, where the plan makes more
 * that stand on their cut faces, and would count the empty corner of an L.
 */
function offerLabel() {
  const note = bedTooSmall();
  if (!(note?.pieces > 1) || !canSplit()) return null;
  if (offerPlan?.key !== planKey()) return SPLIT_TO_FIT;
  return offerPlan.plan.cuts.length ? `Split into ${offerPlan.plan.pieces.length} pieces` : null;
}

let modelShown = ''; // what the Model card shows, so a render only rewrites it (and has it read out again) when it changed
function renderModel() {
  const { text, notes } = describeModel();
  const offer = offerLabel();
  const shown = JSON.stringify([text, notes.map((n) => n.text), offer]);
  if (shown === modelShown) return;
  modelShown = shown;
  $('modelInfo').textContent = text;
  renderNotes($('modelNotes'), notes, { BED_TOO_SMALL: () => offer && { label: offer, run: autoSplit } });
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
      // one thing to do about it, or several (sizes to make the model)
      for (const action of [actions[n.code]?.(n)].flat().filter(Boolean)) {
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
  // a model made bigger for its parts' locks is shown whole at its new size
  const grown = frameAfter != null && result.info.version >= frameAfter;
  if (grown) frameAfter = null;
  if (frame || grown) viewer.frame();
  modelShown = '';
  renderModel();
  renderSuggestions();
  $('legendPass').hidden = !modelInfo.passthroughTriangles;
  previewKeys.clear(); // text follows the surface, so every preview depends on the model
  render();
}

async function loadModel(kind, { bytes = null, name = 'model' } = {}) {
  endAim(); // a place picked on this model means nothing on the next
  showProgress('Reading the file…');
  // setBase() bumps the version and re-renders synchronously; claim that
  // version first so syncBase() does not post a pointless update of the
  // previous model ahead of this load
  sentVersion = doc.state.baseVersion + 1;
  loads += 1;
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
  const pending = client.loadBase({ kind, bytes, name, version: sentVersion, spots: spotsOf(doc.items), covers: coversOf(doc.items) });
  basePending = pending;
  try {
    const result = await pending;
    if (!result) return; // superseded by a newer load, which renders itself
    onBase(result, { frame: true });
    if (kind !== 'none') offerSplit();
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
      ? client.updateBase({ version: v, transforms: doc.base.transforms, simplify: doc.base.simplify, enhance: compareOriginal ? null : doc.base.enhance, spots: spotsOf(doc.items), covers: coversOf(doc.items) })
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
      refitParts(doc.resetBase());
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
  if (matrix) {
    const step = doc.transformBase(matrix);
    // a new size: the parts the finder placed are placed again for it, in the same undo step
    if (kind === 'scale' || kind === 'inches') refitParts(step);
  }
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

/* --------------------------------------------------------------- details */

let foundDetails = null; // the last "Find details" answer: { details, featureSize, placement } – placement: the model it was found on
let rebuildPlan = null; // what each found detail seems to be and what to put in its place: { items } (see rebuild.js)
const DETAIL_ACTIONS = ['rebuildBtn', 'removeAllBtn'];

/** The found details are for the model as it lay: a new model or a transformed one puts them out of place. */
function dropStaleDetails() {
  if (!foundDetails || foundDetails.placement === modelPlacementKey(doc.base)) return;
  foundDetails = null;
  rebuildPlan = null;
  $('detailsList').replaceChildren();
  if (!$('detailsCard').hidden) $('detailsSummary').textContent = 'The model changed – click Find again to look for details on it as it is now.';
  DETAIL_ACTIONS.forEach((id) => ($(id).disabled = true));
}

const KIND_CHOICES = [...Object.entries(DECOR_KINDS).map(([kind, k]) => [kind, k.label]), ['remove', 'Remove only']];

/** The rows of the rebuild plan: a tick, what the detail should become, and what was measured. */
function renderPlan() {
  const list = $('detailsList');
  list.replaceChildren();
  if (!rebuildPlan) return;
  for (const item of rebuildPlan.items) {
    const li = document.createElement('li');
    li.classList.toggle('skipped', !item.include);
    const tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.checked = item.include;
    tick.title = 'Rebuild this detail';
    tick.addEventListener('change', () => {
      item.include = tick.checked;
      li.classList.toggle('skipped', !item.include);
      syncRebuildButton();
    });
    const select = document.createElement('select');
    select.title = 'What this detail should become';
    for (const [kind, label] of KIND_CHOICES) {
      const option = document.createElement('option');
      option.value = kind;
      option.textContent = label;
      select.append(option);
    }
    select.value = item.kind;
    select.addEventListener('change', () => {
      item.kind = select.value;
      if (item.kind !== 'remove') item.spec = specForKind(item.kind, item);
    });
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${fmt(item.size, 0)} mm, ${fmt(item.height, 1)} mm high · looks ${item.looks === 'rough' ? 'messed up' : 'clean'} · ${Math.round(item.confidence * 100)} % sure · ${item.note}`;
    li.append(tick, select, meta);
    list.append(li);
  }
  syncRebuildButton();
}

function syncRebuildButton() {
  const ticked = rebuildPlan?.items.filter((i) => i.include).length ?? 0;
  $('rebuildBtn').disabled = !ticked;
  $('rebuildBtn').textContent = ticked ? `Rebuild ${ticked} ${ticked === 1 ? 'detail' : 'details'}` : 'Rebuild the ticked details';
}

/** Cut each ticked detail off and fuse a clean version of what it should be in its place, as one undo step. */
async function rebuildDetails() {
  const picked = rebuildPlan?.items.filter((i) => i.include) ?? [];
  if (!picked.length) return;
  const placement = foundDetails?.placement;
  const items = [];
  try {
    for (const item of picked) {
      // the smudgy original goes: removing spots over what was found cut it back to the surface
      for (const spot of removalSpotsFor(item)) items.push({ ...createSpot(), id: undefined, radius: spot.radius, remove: true, position: spot.position, normal: spot.normal });
      if (item.kind === 'remove') continue;
      const spec = normaliseDecorSpec(item.spec);
      const partId = decorPartId(spec);
      const label = DECOR_KINDS[spec.kind].label.toLowerCase();
      if (!partAssets.has(partId)) {
        const { info } = await client.addGeneratedPart(partId, spec, label);
        partAssets.set(partId, { name: label, info });
      }
      items.push({ ...createPart(partId, label, { attach: 'bottom', sink: item.sink, spin: item.spin, fit: false, cover: false, join: 'fuse', conform: item.conform !== false }), id: undefined, position: item.position, normal: item.normal });
    }
  } catch (err) {
    setStatus(friendly(err), 'error');
    return;
  }
  if (!foundDetails || foundDetails.placement !== placement) return; // the model changed meanwhile
  doc.addItems(items);
  const rebuilt = picked.filter((i) => i.kind !== 'remove').length;
  setStatus(`Rebuilt ${rebuilt} ${rebuilt === 1 ? 'detail' : 'details'}${picked.length > rebuilt ? ` and removed ${picked.length - rebuilt}` : ''}: each is a removing spot and a clean part you can adjust or delete.`, 'ok');
}

/** Look for the details standing on the model and show what was found with the actions for them. */
async function findDetails() {
  if (!modelInfo?.hasModel) return;
  const card = $('detailsCard');
  card.hidden = false;
  $('detailsSummary').textContent = 'Looking for details…';
  DETAIL_ACTIONS.forEach((id) => ($(id).disabled = true));
  foundDetails = null;
  try {
    const r = (await syncBase()) ? await client.findDetails(version(), { featureSize: Number.parseFloat($('detailScale').value) || 0 }) : null;
    if (!r) {
      // the model changed while looking: the answer would be for the old one
      $('detailsSummary').textContent = 'The model changed while looking – click Find again.';
      return;
    }
    foundDetails = { ...r, placement: modelPlacementKey(doc.base) };
    rebuildPlan = planRebuild(r.details, { featureSize: r.featureSize });
    // the rough-looking ones are ticked, when the reading is a fair bet; clean ones are left as they are
    for (const item of rebuildPlan.items) item.include = item.looks === 'rough' && item.confidence >= 0.4;
    const counts = new Map();
    for (const item of rebuildPlan.items) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
    const kinds = [...counts.entries()].map(([label, n]) => `${n} ${n === 1 ? label.toLowerCase() : `${label.toLowerCase()}s`}`).join(', ');
    const ticked = rebuildPlan.items.filter((i) => i.include).length;
    const ticks = ticked === 0 ? 'None look messed up with a sure enough reading, so nothing is ticked yet.' : ticked === 1 ? 'The one that looks messed up is ticked; the rest look clean or are unsure.' : `The ${ticked} that look messed up are ticked; the rest look clean or are unsure.`;
    $('detailsSummary').textContent = r.details.length
      ? `Found ${r.details.length} ${r.details.length === 1 ? 'detail' : 'details'} (looking at a detail size of about ${fmt(r.featureSize / 3)} mm), read as ${kinds}. ${ticks}`
      : `No details found at a detail size of about ${fmt(r.featureSize / 3)} mm. Try a different size.`;
    renderPlan();
    $('removeAllBtn').disabled = !r.details.length;
  } catch (err) {
    $('detailsSummary').textContent = `Could not look for details: ${friendly(err)}`;
  }
}

/** A removing spot on every detail found: the model is cut back to the surface they stand on. */
function removeFoundDetails() {
  const all = foundDetails?.details ?? [];
  if (!all.length) return;
  doc.addItems(
    all.map((d) => {
      const radius = Math.round(Math.max(1.5, (d.kind === 'round' ? d.radius * 2 : d.size) * 0.65) * 2) / 2;
      const position = d.kind === 'round' ? d.center.map((c, k) => c + d.normal[k] * d.radius * 0.5) : d.center;
      return { ...createSpot(), id: undefined, radius, remove: true, position, normal: d.normal };
    }),
  );
  setStatus(`Removing ${all.length} ${all.length === 1 ? 'detail' : 'details'}: each is a spot you can resize or delete.`, 'ok');
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
  if (selectedCutId) {
    selectCut(null); // a click on the model lets go of the cut; the next one places text
    return;
  }
  lastClick = { position: point, normal };
  const sel = doc.selected;
  if (sel) doc.updateItem(sel.id, { position: point, normal });
  else addItem();
};

viewer.onSelectItem = (id) => doc.select(id);

viewer.onSelectCut = (id) => selectCut(id);

// while a handle is dragged only the view moves (the plane, the colours, the section and the readout); the cut lands
// when dropped. It snaps as a cut placed on the model does, and a cut that comes apart says what lip it gets there
viewer.onCutDrag = ({ id, at, target, done, screen }) => {
  const cut = doc.split?.cuts.find((c) => c.id === id);
  const axis = cutPlane(cut)?.axis;
  if (!done) {
    const moved = aimAt?.drag && aimAt.cutId === id ? aimAt.at !== at : true;
    aimAt = { axis, at, target, screen, hold: cut?.joint === 'apart' ? cut.hold : null, cutId: id, drag: true };
    if (moved) probeAim();
    showReadout(id, at, screen, target);
    const box = document.querySelector(`[data-cut-at="${CSS.escape(id)}"]`);
    if (box && box !== document.activeElement) box.value = round(at);
    return;
  }
  aimAt = null;
  clearTimeout(probeTimer);
  viewer.setAimVerdict(null);
  $('cutReadout').hidden = true;
  dropLipTarget();
  // dropped onto another cut: one there would do nothing, so it stays where it was
  const here = axis != null ? cutHere(axis, at, id) : null;
  if (here) setStatus(`Cut ${cutLetter(here.id)} is already at ${round(at, 1)} mm – cut ${cutLetter(id)} stays where it was.`, 'error');
  else moveCut(id, at, { coalesce: 'split:drag' });
  doc.endCoalescing();
  // the box shows where the cut is, as a drag that went nowhere (given up, or onto another cut) changes nothing to say so
  const box = document.querySelector(`[data-cut-at="${CSS.escape(id)}"]`);
  const kept = cutPlane(doc.split?.cuts.find((c) => c.id === id));
  if (box && kept && box !== document.activeElement) box.value = round(kept.at);
  if (here) renderSplit();
};

viewer.onDrag = ({ itemId, point, normal, done }) => {
  const item = doc.items.find((i) => i.id === itemId);
  if (!item) return;
  if (!done && point) {
    // a spot changes the model itself (a costly recompute), so it only lands when dropped; its ring follows the pointer meanwhile
    if (isSpot(item) || item.cover) viewer.setOverlayMatrix(itemId, placementMatrix({ ...item, position: point, normal }));
    else doc.updateItem(itemId, { position: point, normal }, { coalesce: 'drag' });
  }
  if (done) {
    if (isSpot(item) || item.cover) {
      if (point) doc.updateItem(itemId, { position: point, normal });
      else viewer.setOverlayMatrix(itemId, placementMatrix(item)); // dropped off the model: the shape goes back where the item is
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
let piecesTimer = 0;
/**
 * Compute and show the final result – the pieces, when the model is split –
 * or go back to the model. `keep` leaves what is shown on screen (dimmed)
 * until the new pieces arrive: moving a cut never hides the pieces view.
 */
async function showResult(on, { keep = false } = {}) {
  clearTimeout(piecesTimer);
  if (!keep) viewer.showResult(false);
  syncSpread();
  if (!on) return;
  if (resultBusy) {
    resultPending = true; // run again for the new content once this one lands
    return;
  }
  resultBusy = true;
  const requestedFor = lastContentKey;
  const splitFor = lastSplitKey;
  const split = activeSplit();
  if (split) setSplitPending(true);
  try {
    if (!(await syncBase())) return; // the model is still being re-derived for a newer change, which re-renders
    const r = await client.result(doc.items, version(), { printing, split, bed: usableBed(bed) });
    if (!r || !$('resultToggle').checked || lastContentKey !== requestedFor || lastSplitKey !== splitFor) return; // stale
    const entering = viewer.viewMode !== 'pieces';
    if (r.pieces) viewer.setPieces(r.display, r.pieces, r.grid, waysOf(r.seams));
    else viewer.setResult(r.display);
    // without pieces a split still has its say: every cut missed, or the model cannot be split
    lastPieces = split
      ? { key: splitFor, content: requestedFor, pieces: r.pieces ?? [], seams: r.seams ?? [], grid: r.grid, diameter: r.diameter, pegSize: r.pegSize ?? null, notes: r.notes.filter(isSplitNote) }
      : null;
    if (split) rememberJoints(splitFor, requestedFor, jointsOfSeams(r.seams));
    viewer.showResult(true);
    // pulled apart, the pieces take more room than the model: fit them in view once, then leave the camera to the
    // user – clear of the lock's tools and the legend, which are shown for them first
    syncLockTools();
    if (r.pieces && entering) viewer.frame();
    renderSplit();
    // the split's own notes are in its card; the status line keeps the summary and anything to act on
    const notes = r.pieces ? r.notes.filter((n) => !isSplitNote(n) || n.code === 'SPLIT' || n.level === 'warn') : r.notes;
    if (notes.length) {
      setStatus(notes.map((n) => n.text).join('\n'), notes.some((n) => n.level === 'warn') ? 'error' : '');
      piecesStatus = split ? { text: $('status').textContent, key: splitFor, content: requestedFor } : null;
    } else {
      dropPiecesStatus();
    }
  } catch (err) {
    $('resultToggle').checked = false;
    viewer.showResult(false);
    syncSpread();
    setStatus(friendly(err), 'error');
  } finally {
    resultBusy = false;
    if (split) setSplitPending(false);
    if (resultPending) {
      resultPending = false;
      if ($('resultToggle').checked) showResult(true, { keep: true });
    }
  }
}

let piecesStatus = null; // { text, key, content } of the pieces' summary on the status line ("Cut into 2 pieces with…")
/** Take the pieces' summary off the status line, if it is still there: the split or the model it was about has changed. */
function dropPiecesStatus() {
  if (piecesStatus && $('status').textContent === piecesStatus.text) setStatus('');
  piecesStatus = null;
}

/** The pieces again for changed cuts or split settings, once the edits pause; the old ones stay on screen, dimmed. */
function requestPieces() {
  viewer.setPiecesStale(true);
  clearTimeout(piecesTimer);
  piecesTimer = setTimeout(() => showResult(true, { keep: true }), 300);
}

/** Save bytes as a download; returns the file name used and its size in KB. */
function save(bytes, fileName, type = 'model/stl', ext = '.stl') {
  const blob = new Blob([bytes], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${fileName.replace(/[^\w.-]+/g, '_')}${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return { name: a.download, kb: (blob.size / 1024).toFixed(0) };
}

/** The name the downloads start with: the model's, or the texts' when there is no model. */
function exportName() {
  const items = doc.items.filter((i) => hasText(i) && !isSpot(i));
  return modelInfo?.hasModel ? `${modelInfo.name}-text` : items.map((i) => itemLabel(i, '')).filter(Boolean).join('-').slice(0, 40) || 'text';
}

async function download() {
  const items = doc.items.filter((i) => hasText(i) && !isSpot(i)); // spots change the model, they are not exported geometry
  if (!items.length && !modelInfo?.hasModel) return setStatus('Type some text or open a model first.', 'error');
  const name = exportName();
  const split = activeSplit();
  const splitFor = lastSplitKey;
  const requestedFor = lastContentKey;
  if (split) setSplitPending(true);
  try {
    if (!(await syncBase())) return setStatus('The model is still being updated – try the download again in a moment.', '');
    const r = await client.export(doc.items, version(), name, {
      printing,
      split,
      bed: usableBed(bed),
      printer: { size: bedSize(bed), margin: bed.margin }, // names the printer on the glue sheet
      archive: 'zip',
    });
    if (!r) return setStatus('The model changed while the download was being prepared – try again.', '');
    const warnings = r.notes.filter((n) => n.level === 'warn');
    const warned = warnings.length ? `\n${warnings.map((n) => n.text).join('\n')}` : '';
    if (r.zip) {
      // the cut rows say what the download gave each cut: a face no pin fits makes it glue only, and the download
      // button how many pieces it held
      rememberJoints(splitFor, requestedFor, jointsOfSeams(r.seams));
      downloaded = { key: splitFor, content: requestedFor, count: (r.files ?? []).filter((f) => f.kind === 'piece').length };
      renderSplit();
      // the pieces, the pins, the separately printed parts and the glue sheet come as one file: a browser
      // drops or asks about many downloads from one click
      const zip = save(r.zip, r.zipName, 'application/zip', '');
      const pairs = (r.seams ?? []).filter((x) => x.labels?.length === 2).map((x) => `${x.labels[0]} ↔ ${x.labels[1]}`);
      setStatus(
        `Downloaded ${zip.name} (${zip.kb} KB): ${zipContents(r.files ?? [])}.${pairs.length ? ` Glue matching letters together: ${pairs.join(', ')}.` : ''}${warned}`,
        warnings.length ? 'error' : 'ok',
      );
      return;
    }
    const main = save(r.stl, name);
    const extras = (r.extra ?? []).map((e, i) => save(e.stl, `${name}-part-${i + 1}-${e.name}`));
    setStatus(
      `Downloaded ${main.name} (${main.kb} KB, ${r.triangles.toLocaleString()} triangles)` +
        (extras.length ? ` and ${extras.length} separate part file${extras.length > 1 ? 's' : ''} (${extras.map((e) => e.name).join(', ')}) to print and glue in.` : '.') +
        warned +
        (bedTooSmall() && canSplit() ? '\nBigger than your printer – use Split for printing (step 6).' : ''),
      warnings.length ? 'error' : 'ok',
    );
  } catch (err) {
    setStatus(friendly(err), 'error');
  } finally {
    if (split) setSplitPending(false);
  }
}

/** "2 pieces, 3 pins (Ø6 × 19 mm, 1 spare), 1 part and how-to-glue.txt" from a split download's files. */
function zipContents(files) {
  const n = (v) => String(Math.round(v * 100) / 100);
  const count = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const list = [count(files.filter((f) => f.kind === 'piece').length, 'piece')];
  // pins of one size come on several sheets when the bed can't take them all: counted together
  const sizes = new Map();
  for (const f of files.filter((x) => x.kind === 'pins')) {
    const key = `${f.d}|${f.length}`;
    const g = sizes.get(key) ?? { d: f.d, length: f.length, count: 0, spares: 0, sheets: 0 };
    g.count += f.count;
    g.spares += f.spares ?? 0;
    g.sheets += 1;
    sizes.set(key, g);
  }
  for (const g of sizes.values()) {
    list.push(`${count(g.count, 'pin')} (Ø${n(g.d)} × ${n(g.length)} mm${g.spares ? `, ${count(g.spares, 'spare')}` : ''}${g.sheets > 1 ? `, on ${g.sheets} sheets` : ''})`);
  }
  const parts = files.filter((f) => f.kind === 'part').length;
  if (parts) list.push(count(parts, 'part'));
  if (files.some((f) => f.kind === 'text')) list.push('how-to-glue.txt');
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0];
}

/* ---------------------------------------------------- split for printing */

const isSplitNote = (n) => SPLIT_NOTE_CODES.includes(n.code);

/** The document's split with its defaults filled in, or null when it has no cuts (the model is not split). */
const activeSplit = () => (splitActive(doc.split) ? { ...SPLIT_DEFAULTS, ...doc.split } : null);

/** Whether there is something to split: a solid model or, with no model, text or parts. */
function canSplit() {
  if (modelInfo?.hasModel) return !!modelInfo.watertight;
  return doc.items.some((i) => hasText(i) && !isSpot(i));
}

/** The box of the model and its text as the engine last measured it, while the model is the one it measured (after a text edit, until the next measure lands). */
const measuredBounds = () => (splitBounds && splitBounds.version === version() ? splitBounds.bounds : null);

/** The box cuts are placed in: the measured one, or the model's own until there is one. */
const cutBounds = () => measuredBounds() ?? (modelInfo?.hasModel ? modelInfo.bounds ?? null : null);

/** Whether the pieces on hand are for the split, the printer and the content as they are now. */
const piecesCurrent = () => !!lastPieces && lastPieces.key === lastSplitKey && lastPieces.content === lastContentKey;

/** Whether a box between the cuts (from `cellSizes`, dovetail tabs and built-in pegs counted) is too big for the printer. */
const cellTooBig = (cell) => !cellFits(cell, usableBed(bed));

/**
 * The cuts, each with what the last measure found its dovetail tabs add to
 * the pieces either side, or its built-in pegs to the one that carries them
 * (`reach`), and the side those pieces must lie on (`w`, tabs only), for
 * `cellSizes`; a cut moved since keeps them until it is measured again.
 */
function cutsWithTabs() {
  return planeCuts().map((c) => {
    const m = measured?.cuts.get(c.id);
    return m?.reach && m.axis === cutPlane(c)?.axis ? { ...c, reach: m.reach, w: m.w } : c;
  });
}

/**
 * The full-plane cuts, each with its letter from its place in the whole list: what the grid, the planes across the
 * model and the boxes between them are made of. A cut that takes out only a part (a circle on its plane) makes none
 * of them: it is a piece of its own, drawn as its circle.
 */
const planeCuts = () => (doc.split?.cuts ?? []).map((c, i) => ({ ...c, letter: letterFor(i) })).filter((c) => !c.part);

/** How many parts the split takes out, each a piece of its own. */
const takenOut = () => (doc.split?.cuts ?? []).filter((c) => c.part).length;

/** Whether one more cut, of any kind, stays within the split's 12. */
const roomForAnyCut = () => (doc.split?.cuts.length ?? 0) < SPLIT_LIMITS.cuts;
const nudgeStep = () => Number.parseFloat($('nudgeStep').value) || 1;
const round = (v, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;

/** A cut's letter, from its place in the list as on its plane and the glue sheet; null for a cut that is gone. */
function cutLetter(id) {
  const i = doc.split?.cuts.findIndex((c) => c.id === id) ?? -1;
  return i >= 0 ? letterFor(i) : null;
}

/** "A", "A and C", "A, B and C". */
const listOf = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : String(items[0] ?? ''));

/** The letters of the cuts that come apart: never glued, so the joint settings are not theirs. */
const apartLetters = () => (doc.split?.cuts ?? []).map((c, i) => (c.joint === 'apart' ? letterFor(i) : null)).filter(Boolean);

let splitWork = 0;
let splitPendingTimer = 0;
/** "working…" on the card while split requests run (only when one takes a moment, so quick ones do not flicker). */
function setSplitPending(on) {
  splitWork = Math.max(0, splitWork + (on ? 1 : -1));
  clearTimeout(splitPendingTimer);
  if (splitWork) splitPendingTimer = setTimeout(() => $('splitCard').classList.add('pending'), 300);
  else $('splitCard').classList.remove('pending');
}

/**
 * What a fit is planned for besides the text: the model, the printer and the split's settings, and the cuts that come
 * apart, which it keeps where they are (the others are replaced), so that ticking one plans the fit again.
 */
const fitSettings = () => ({
  base: version(),
  printing,
  bed: usableBed(bed),
  split: { ...SPLIT_DEFAULTS, ...splitDefaults, ...doc.split, cuts: (doc.split?.cuts ?? []).filter((c) => c.joint === 'apart') },
});

/** What a fit is planned for: the model and its text, the printer and the split's settings. */
const planKey = () => stableKey({ items: doc.items, ...fitSettings() });

/** Fit to my printer's plan for the model and its text as they are now (the engine keeps the last one: asked again, it answers at once). */
const planFit = () =>
  client.planSplit(doc.items, version(), { printing, split: { ...SPLIT_DEFAULTS, ...splitDefaults, ...doc.split }, bed: usableBed(bed), mode: 'fit' });

let offerTimer = 0;
let offerFor = null; // the plan key the offer's plan is timed for
let offerAsked = null; // the model, printer and settings (fitSettings) the offer's plan was last asked for
let offerBusy = false; // the offer's plan is with the engine: unasked, so its progress shows only once a split is asked for

/**
 * Plan a fit ahead for the Model card's offer, so that it can say how many
 * pieces Fit to my printer makes (`offerLabel`): for a model opened or
 * changed, another printer or other joints, once the edits pause and the
 * engine has nothing else to do. A plan builds the final result and slices
 * the model, so text being moved or typed is not followed by one – the next
 * keystroke's preview would wait for it – and neither is a dense model,
 * where one takes seconds: the offer says "Split to fit" until it is
 * clicked, or until the printer or the joints change.
 */
function scheduleOffer() {
  const settings = booted && !halted && !modelInfo?.simplifiedView && offerLabel() === SPLIT_TO_FIT ? stableKey(fitSettings()) : null;
  const key = settings && settings !== offerAsked ? planKey() : null;
  if (key === offerFor) return; // timed already, or nothing to plan
  offerFor = key;
  clearTimeout(offerTimer);
  if (!key) return;
  const ask = async () => {
    if (halted || planKey() !== key) {
      offerFor = null; // the next render times it again
      return;
    }
    // what was asked meanwhile goes first, and the plan is for the model as it is now
    if (client.state === 'busy' || basePending || engineVersion !== version()) {
      offerTimer = setTimeout(ask, 300);
      return;
    }
    offerAsked = settings;
    offerBusy = true;
    let r;
    try {
      r = await planFit();
    } catch {
      return; // not asked again for these settings: Fit to my printer says what is wrong when clicked
    } finally {
      offerBusy = false;
    }
    if (!r) {
      // the engine had moved on to a newer model: planned again on the next render
      offerAsked = null;
      offerFor = null;
      return;
    }
    offerPlan = { key, plan: r }; // kept even when the text has moved on meanwhile: an undo brings the count back
    renderModel();
  };
  offerTimer = setTimeout(ask, 1000);
}

/**
 * Fit to my printer: the engine works out the fewest pieces that fit and
 * where their cuts go; they replace any cuts as one undo step, and the
 * pieces are shown. A model that fits already loses its cuts the same way –
 * all but those that come apart, which the plan keeps where they are and
 * plans the others round (its notes, in the card, say so).
 */
async function autoSplit() {
  if (!canSplit()) return;
  endAim();
  let again = false;
  setSplitPending(true);
  try {
    if (!(await syncBase())) return;
    const asked = { loads, plan: planKey() };
    const r = await planFit();
    if (!r) return; // superseded by a newer plan
    offerPlan = { key: asked.plan, plan: r }; // the count the Model card offers should the cuts be taken away again
    if (planKey() !== asked.plan) {
      // planned for what was there when asked: another model opened since gets none of it, while
      // the same one, turned, retyped or meant for another printer, is planned again as it is now
      again = loads === asked.loads && canSplit();
      return;
    }
    if (!r.cuts.length) {
      // it fits already – any cuts go, as one undo step – or nothing would, and they stay: the card says which
      if (splitActive(doc.split) && r.notes.some((n) => n.code === 'SPLIT_NOT_NEEDED')) doc.setSplit({ cuts: [] });
      planNotes = { key: lastSplitKey, content: lastContentKey, notes: r.notes };
      renderSplit();
      const warn = r.notes.find((n) => n.level === 'warn');
      if (warn) setStatus(warn.text, 'error');
      return;
    }
    // a split already there keeps its settings; a new one starts from those used last
    doc.setSplit(doc.split ? { cuts: r.cuts } : { ...splitDefaults, cuts: r.cuts });
    selectedCutId = null;
    // the cuts that come apart were kept, or are all it needs: said in the card for the split as it now is (the render
    // above has made its key the current one)
    if (r.notes.length) planNotes = { key: lastSplitKey, content: lastContentKey, notes: r.notes };
    if ($('toastText').textContent === offered) $('toast').hidden = true; // done what it offered
    $('resultToggle').checked = true;
    showResult(true, { keep: true });
  } catch (err) {
    setStatus(friendly(err), 'error');
  } finally {
    setSplitPending(false);
    if (again) autoSplit();
  }
}

/** "+ Cut": across the middle of the longest piece, selected so the arrow keys and the handle move it. */
async function addCut() {
  if (!canSplit()) return;
  endAim();
  // with no model only the engine knows where the text is – and it must be the text as it is now
  const fresh = splitBounds?.key === boundsKey() ? splitBounds.bounds : null;
  const bounds = fresh ?? (modelInfo?.hasModel ? cutBounds() : await measureBounds());
  if (!bounds) return;
  const next = roomForAnyCut() ? nextCut(bounds, planeCuts()) : null;
  if (!next) return setStatus(`A split can have up to ${SPLIT_LIMITS.cuts} cuts and ${SPLIT_LIMITS.cells} pieces.`, 'error');
  selectCut(doc.addCut(next, { defaults: splitDefaults }));
}

/** The box of the model and its text, from the engine (for a first cut before anything was measured). */
async function measureBounds() {
  try {
    if (!(await syncBase())) return null;
    const v = version();
    const key = boundsKey();
    const r = await client.planSplit(doc.items, v, { printing, split: null, bed: usableBed(bed), mode: 'measure' });
    if (r?.bounds) splitBounds = { version: v, key, bounds: r.bounds };
    return r?.bounds ?? null;
  } catch (err) {
    setStatus(friendly(err), 'error');
    return null;
  }
}

/** Select a cut (its plane stands out, the arrow keys move it), or none; the selected item is let go. */
function selectCut(id) {
  selectedCutId = id;
  if (id && doc.state.selectedId) doc.select(null); // re-renders
  else renderSplit();
}

/** Move a cut to `at` mm along its own axis. */
function moveCut(id, at, options) {
  const cut = doc.split?.cuts.find((c) => c.id === id);
  const plane = cutPlane(cut);
  if (!plane || !Number.isFinite(at)) return;
  const position = [...cut.position];
  position[plane.axis] = at;
  doc.updateCut(id, { position }, options);
}

function nudgeCut(id, step) {
  const cut = doc.split?.cuts.find((c) => c.id === id);
  const plane = cutPlane(cut);
  if (!plane) return;
  if (!cut.part || plane.axis !== 2) return moveCut(id, round(plane.at + step, 4), { coalesce: 'split:nudge' });
  // a part's face goes by the printer's layers, and is tried there once the keys rest
  moveCut(id, partFace(plane.at + step, partLayers(cut)), { coalesce: `split:at:${id}` });
  clearTimeout(nudged);
  nudged = setTimeout(() => settlePartFace(id), 300);
}
let nudged = 0;

/** Turn a cut to run across another axis, through the middle of the model. */
function setCutAxis(id, axis) {
  const cut = doc.split?.cuts.find((c) => c.id === id);
  if (!cut) return;
  const b = cutBounds();
  const position = b ? b.min.map((v, a) => (v + b.max[a]) / 2) : [...cut.position];
  doc.updateCut(id, { normal: [0, 1, 2].map((a) => (a === axis ? 1 : 0)), position });
}

function removeCut(id) {
  const letter = cutLetter(id);
  if (!letter) return;
  doc.removeCut(id);
  undoToast(`Removed cut ${letter}.`);
}

/**
 * Make a cut one that comes apart (with the hold it had, Locks at first), or
 * a glued one again. Ticked, it is selected and the spots for it are
 * suggested: a click on one moves it there.
 */
function setCutApart(id, on) {
  doc.setCutJoint(id, on ? {} : null);
  if (!on) return;
  if (selectedCutId !== id) selectCut(id);
  suggestSpots();
}

/** How a cut that comes apart holds: 'lock' (Locks), 'snap' (Clicks on), 'light' (Light click) or 'lift' (Lifts off). */
function setCutHold(id, hold) {
  doc.setCutJoint(id, { hold });
}

/** The settings of the split in force are the ones used last (an undone change is not), and start the next model's split. */
function rememberSplitSettings(split) {
  let changed = false;
  for (const key of Object.keys(splitDefaults)) {
    if (split[key] === undefined || split[key] === splitDefaults[key]) continue;
    splitDefaults[key] = split[key];
    changed = true;
  }
  if (changed) saveSettings();
}

/** Change one split setting: on the split, and remembered for the next model's. */
function setSplitSetting(key, value, { coalesce = null } = {}) {
  splitDefaults[key] = value;
  saveSettings();
  if (doc.split) doc.setSplit({ [key]: value }, { coalesce });
  else render();
  // the gap a part's face needs to print apart grows with the clearance: the parts the finder placed are placed by it
  // again for the new one, in the same undo step while that is still the last edit
  if (key === 'clearance') refitParts(coalesce);
}

/** A split control's value as the document keeps it, within its range; null for nonsense typed in a box. */
function splitValue(el, key) {
  if (el.type === 'checkbox') return el.checked;
  if (key === 'joint' || key === 'pins' || key === 'orient') return el.value;
  const v = Number.parseFloat(el.value);
  if (Number.isNaN(v)) return null;
  if (key === 'depth') return v <= 0 ? 0 : Math.min(30, Math.max(3, v));
  if (key === 'clearance') return Math.min(0.5, Math.max(0, round(v, 3)));
  if (key === 'count') return Math.min(6, Math.max(0, Math.round(v)));
  return v; // the diameter, from its list
}

function openPrinting() {
  $('printing').open = true;
  $('bedPreset').focus();
}

let measureTimer = 0;
let measureFor = null; // { cuts, content } of the measure last asked for
/**
 * What the box the engine measures depends on: the model and what is raised
 * or cut on it – with no model the text is all there is, and moving the text
 * decides which cuts run through letters.
 */
const boundsKey = () => stableKey({ version: version(), items: doc.items.filter((i) => hasText(i) && !isSpot(i)).map((i) => [shapeKey(i), placeKey(i), !!i.cover]) });
/**
 * What a measure of the cuts depends on besides that: the cuts and the joint settings, and – for the pieces it counts,
 * as some loose parts of a box print apart only lying a certain way – the printer and how the pieces lie. With
 * built-in pegs the size and depth too: how far a peg stands out makes one of the pieces either side of its cut longer.
 */
const cutsKey = () => {
  const { joint, clearance, orient, diameter, depth } = doc.split ?? {};
  return stableKey({ cuts: doc.split?.cuts ?? [], joint, clearance, orient, bed: usableBed(bed), ...(joint === 'pegs' ? { diameter, depth } : {}) });
};
const measureKey = () => `${cutsKey()}|${boundsKey()}`;

/**
 * Measure the cuts on the model once the edits pause: the face each cut
 * makes for its row, and the box the planes span. It is cheap: after a text
 * edit the engine measures on the model and each item's own letters rather
 * than build the final result, so a pause in typing does not hold up the
 * next keystroke's preview.
 */
function scheduleMeasure() {
  if (!booted || halted || !splitActive(doc.split) || !canSplit()) return;
  const want = { cuts: cutsKey(), content: boundsKey() };
  if (want.cuts === measureFor?.cuts && want.content === measureFor?.content) return;
  // when only the text changed, wait for the typing to stop: the worker would otherwise measure between keystrokes,
  // and each preview waits for it
  const delay = want.cuts === measureFor?.cuts ? 1000 : 300;
  measureFor = want;
  const key = measureKey();
  clearTimeout(measureTimer);
  measureTimer = setTimeout(async () => {
    setSplitPending(true);
    try {
      if (!(await syncBase())) {
        if (measureFor === want) measureFor = null; // try again on the next render
        return;
      }
      if (measureKey() !== key) return; // a newer measure is on its way
      const v = version();
      const r = await client.planSplit(doc.items, v, { printing, split: { ...SPLIT_DEFAULTS, ...doc.split }, bed: usableBed(bed), mode: 'measure' });
      if (!r || measureKey() !== key) return;
      measured = { key, cuts: new Map(r.cuts.map((c) => [c.id, c])), notes: r.notes, pieces: r.pieces ?? null };
      if (r.bounds) splitBounds = { version: v, key: want.content, bounds: r.bounds };
      renderSplit();
    } catch (err) {
      measured = { key, cuts: new Map(), notes: [{ level: 'warn', code: err.code, text: friendly(err) }] };
      renderSplit();
    } finally {
      setSplitPending(false);
    }
  }, delay);
}

/** The boxes between the cuts that hold some of the model or its text (an L-shape leaves its corner box empty). */
function filledBoxes() {
  const b = cutBounds();
  if (!b || !splitActive(doc.split)) return [];
  const { cells } = cellSizes(b, cutsWithTabs());
  const filled = viewer.filledCells(planeCuts(), b); // null: the view can't tell, so every box counts
  return filled ? cells.filter((c) => filled.has(c.cell.join(','))) : cells;
}

/**
 * The pieces the engine's last measure found the cuts make, each with the box it comes from, while they are the cuts
 * measured (a box whose loose parts print apart makes more than one), or null: a dense model is not cut to count.
 */
const measuredPieces = () => (measured?.pieces && measured.key === measureKey() ? measured.pieces : null);

/**
 * How many pieces a download makes: those computed, or the measure's count, or the last download's for the same
 * split; until one is known, one for each box between the cuts with something in it.
 */
function piecesToDownload() {
  if (!splitActive(doc.split)) return 0;
  if (piecesCurrent()) return lastPieces.pieces.length;
  // the measure cuts the full-plane cuts alone: each part taken out is one piece more
  const counted = measuredPieces();
  if (counted) return counted.length + takenOut();
  if (downloaded?.key === lastSplitKey && downloaded.content === lastContentKey) return downloaded.count;
  return filledBoxes().length + takenOut();
}

/** Relabel an element, leaving it alone when the label is the same (this runs on every render). */
function relabel(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** The Spread slider goes with the pieces view (not as printed, where nothing is spread), and so do the lock's tools. */
function syncSpread() {
  syncLockTools();
}

/**
 * Each part's way out, for the pieces view to move it along (`setPieces`): from the seams of the pieces shown, the
 * part's piece and the one it comes out of, and its circle's centre (the document's, where the cut still is).
 */
function waysOf(seams) {
  return (seams ?? []).flatMap((s) => {
    if (s.joint !== 'part' || !s.part?.way?.out) return [];
    const cut = doc.split?.cuts.find((c) => c.id === s.cutId && c.part);
    const point = cut?.position ?? (s.axis === 2 ? [s.part.centre[0], s.part.centre[1], s.at] : null);
    return point ? [{ cutId: s.cutId, piece: s.pieces[1], home: s.pieces[0], point, way: s.part.way, kind: s.part.kind, r: s.part.r }] : [];
  });
}

let wayFocus = null; // the cut whose part was last played or looked at: the view's words follow it

/** The part the lock's tools work on: the one last played or looked at, else the selected part, else the first. */
function lockFocus() {
  const ways = viewer.partWays;
  return (ways.find((w) => w.cutId === wayFocus) ?? ways.find((w) => w.cutId === selectedCutId) ?? ways[0])?.cutId ?? null;
}

/**
 * The lock's tools under the pieces: ▶ Show how it comes apart where a part moves along its way out, Look at the lock
 * where it has a lock, As printed; the legend's chips for the lock (and, as printed, its overhang and bridges); and
 * what the part is doing while it moves.
 */
function syncLockTools() {
  const pieces = viewer.viewMode === 'pieces';
  const ways = pieces ? viewer.partWays : [];
  const locks = pieces ? viewer.lockCuts : [];
  // As printed is a look at a part's pieces: it goes when they do – the view left, or pieces with no part shown –
  // so the next pieces are spread apart again, never laid out with nothing on screen to turn it off
  if (viewer.asPrinted && !ways.length && !locks.length) viewer.setAsPrinted(false);
  $('spreadField').hidden = !pieces || viewer.asPrinted;
  syncLegend();
  $('lockPanel').hidden = !ways.length && !locks.length;
  $('playWayBtn').hidden = !ways.length;
  $('lookLockBtn').hidden = !ways.some((w) => locks.includes(w.cutId));
  $('asPrintedToggle').checked = viewer.asPrinted;
  $('legendLock').hidden = !locks.length;
  $('legendLugs').hidden = !locks.length || !viewer.lugsShown;
  $('legendOver').hidden = !(locks.length && viewer.asPrinted);
  $('legendBridge').hidden = !(locks.length && viewer.asPrinted);
  syncWayCaption();
}

let wayOn = false; // ▶ is playing how the parts go on (Shift+▶): the words say so

/**
 * What the part ▶ follows is doing, while it is neither seated nor out: "Dome and cap: 2 of 3 · Lift it 5 mm"; while
 * Shift+▶ plays it going on, the steps the other way round ("1 of 3 · Slide it in …").
 */
function syncWayCaption() {
  const id = viewer.viewMode === 'pieces' && !viewer.asPrinted ? lockFocus() : null;
  const seam = id ? lastPieces?.seams.find((s) => s.joint === 'part' && s.cutId === id) : null;
  const on = wayOn && viewer.wayPlaying;
  const text = seam ? wayCaption({ name: seam.part.name, kind: seam.part.kind, way: seam.part.way, span: seam.part.span }, wayStep(seam.part.way, viewer.spread), { on }) : null;
  $('wayCaption').hidden = !text;
  relabel($('wayCaption'), text ?? '');
}

/**
 * ▶ Show how it comes apart: each part turned free, lifted and slid out along its way out over a moment, the Spread
 * slider following; backwards (Shift) how it goes on. A part's own ▶ (`cutId`) shows the pieces first when they are
 * not, and lights its lock.
 */
async function playWays({ back = false, cutId = null } = {}) {
  if (cutId) {
    wayFocus = cutId;
    if (viewer.viewMode !== 'pieces' || !piecesCurrent()) {
      endAim();
      $('resultToggle').checked = true;
      await showResult(true);
    }
    if (!viewer.partWays.some((w) => w.cutId === cutId)) return;
    viewer.setLockHighlight(cutId);
  }
  // the pieces spread along their ways, not as printed: the box, its chips and the Spread slider say so from the start
  if (viewer.asPrinted) viewer.setAsPrinted(false);
  syncSpread();
  wayOn = back;
  await viewer.playWay({ back });
  wayOn = false;
  syncSpread();
}

/**
 * Look at the lock: the camera close on it, glowing, its part set down beside it – the part the lock's tools work on;
 * pressed again while looking, the next part's.
 */
function lookAtLock() {
  const ids = viewer.partWays.map((w) => w.cutId).filter((id) => viewer.lockCuts.includes(id));
  if (!ids.length) return;
  const looking = viewer.lookingAt;
  const id = looking && ids.length > 1 ? ids[(ids.indexOf(looking) + 1) % ids.length] : ids.includes(lockFocus()) ? lockFocus() : ids[0];
  if (!viewer.lookAtLock(id)) return;
  wayFocus = id;
  syncSpread();
}

/** The locks on a piece: those of the parts that come out of it, and its own part's. */
const locksOn = (index) => (lastPieces?.seams ?? []).filter((s) => s.joint === 'part' && s.apart?.mech && s.pieces.includes(index)).map((s) => s.cutId);

/**
 * How a part's circle is drawn on the model: red when it can't come out or cuts something (a note left it out), teal
 * when its lock fits, amber when it only lifts off – chosen, or too small for a lock; its lugs once its lock is known;
 * and where it ends, for its material's tint – the pieces', else the parts table's for its family.
 */
function partLook(cut, letter) {
  const info = partInfo(cut, letter);
  const refused = !!info.note && !(info.note.code === 'PART_GAP' && Number.isFinite(info.note.movedTo));
  const seam = piecesCurrent() ? lastPieces.seams.find((s) => s.joint === 'part' && s.cutId === cut.id) : null;
  const top = seam?.part.top ?? entryIn(currentTable(), cut)?.top ?? null;
  const lifts = cut.hold === 'lift' || (!info.lock && (info.small || info.known));
  const state = refused ? 'stuck' : lifts ? 'lift' : 'lock';
  return { state, lugs: state === 'lock' && !!info.lock, top: Number.isFinite(top) ? top : null };
}

/**
 * The parts the split takes out, each drawn on the model as its circle – the one whose ring handle is dragged at its
 * size under the pointer, the one whose Z or Ø is being typed where it would go.
 */
function drawParts() {
  viewer.setParts(
    (doc.split?.cuts ?? []).flatMap((c, i) => {
      const plane = c.part ? cutPlane(c) : null;
      if (!plane) return [];
      const typed = partTyped?.id === c.id ? partTyped : null;
      const r = partDrag?.id === c.id ? partDrag.r : typed?.r ?? c.part.r;
      const position = Number.isFinite(typed?.at) ? c.position.map((v, a) => (a === plane.axis ? typed.at : v)) : c.position;
      return [{ id: c.id, letter: letterFor(i), axis: plane.axis, position, r, selected: c.id === selectedCutId, ...partLook(c, letterFor(i)) }];
    }),
  );
}

/**
 * The legend's chips for what the view draws in its own colours: the model and the raised and cut text where they are
 * drawn so – in the model view, and only text there is. The pieces are drawn in their pieces' colours instead, with the
 * lock's orange beside them.
 */
function syncLegend() {
  const pieces = viewer.viewMode === 'pieces';
  const texts = doc.items.filter((i) => hasText(i) && !isSpot(i));
  $('legendModel').hidden = pieces || !modelInfo?.hasModel;
  $('legendRaised').hidden = pieces || !texts.some((i) => baseMode(i) !== 'engrave');
  $('legendEngraved').hidden = pieces || !texts.some((i) => baseMode(i) === 'engrave');
}

/** The split's share of the page and the view: its card, the cut planes and their live colours, the download button. */
function renderSplit() {
  fillSplit();
  const cuts = doc.split?.cuts.length ? doc.split.cuts : null;
  // the planes across the model are the full cuts'; a part is drawn as the circle it takes out
  const planes = cuts ? planeCuts() : [];
  viewer.setCuts(planes.length ? planes : null, { selectedId: selectedCutId, bounds: measuredBounds() });
  viewer.setCellPreview(planes.length ? cutsWithTabs() : null, { tooBig: cellTooBig });
  drawParts();
  viewer.setCutSnap(nudgeStep(), 5 * nudgeStep()); // Shift moves five times as far, as with the arrow keys
  // the seams a cut that comes apart snaps to: along the axis one is being placed on, else the selected one's, whose
  // handle may be dragged. A glued cut snaps to none of them, so a glued split never waits for them
  const selected = doc.split?.cuts.find((c) => c.id === selectedCutId);
  const snapAxis = aiming ? (holdOf(aiming.cutId) && !partAim() ? aiming.axis : null) : selected?.joint === 'apart' && !selected.part ? cutPlane(selected)?.axis ?? null : null;
  if (snapAxis !== null) loadTargets(snapAxis);
  refreshAim();
  // the planes of cuts that come apart are teal, the others violet
  syncLegend();
  $('legendPieces').hidden = !cuts;
  $('legendCut').hidden = !cuts?.some((c) => c.joint !== 'apart');
  $('legendApart').hidden = !cuts?.some((c) => c.joint === 'apart');
  const n = piecesToDownload();
  relabel($('downloadBtn'), n > 1 ? `Download ${n} pieces (.zip)` : 'Download STL');
  $('downloadBtn').parentElement.classList.toggle('pieces', n > 1); // the longer label takes room from Undo and Redo
  relabel($('resultLabel'), cuts ? 'Show pieces' : 'Show final result');
  syncSpread();
}

/** Settings that mean nothing for a glue-only split: nothing is drilled, socketed or engraved on its faces. */
const PIN_SETTINGS = new Set(['diameter', 'pins', 'count', 'depth', 'labels', 'clearance']);
/**
 * Settings that are only the glued cuts': a cut that comes apart has its lip whatever the joints, and no labels. The
 * clearance is its groove's too, and how firmly it clicks; how the pieces lie is every piece's.
 */
const GLUED_SETTINGS = new Set(['joint', 'diameter', 'pins', 'count', 'depth', 'labels']);

/** Fill the split card from the document (with no split yet, from the settings used last), never writing the box being typed in. */
function fillSplit() {
  const split = doc.split;
  const active = splitActive(split);
  const usable = canSplit();
  const settings = { ...SPLIT_DEFAULTS, ...splitDefaults, ...(split ?? {}) };
  const filament = Number(settings.diameter) === FILAMENT;
  const glueOnly = settings.joint === 'none';
  const apart = active ? apartLetters() : [];
  const allApart = apart.length > 0 && apart.length === split.cuts.length;
  // built-in pegs are printed on their piece: there are no pins to print or buy, and the size is the side of a square
  // peg, which filament can't be (the engine reads it as the smallest peg)
  const pegs = settings.joint === 'pegs';
  filling = true;
  try {
    document.querySelectorAll('[data-split]').forEach((el) => {
      const key = el.dataset.split;
      let value = settings[key];
      if (key === 'pins' && filament) value = 'own'; // filament comes off the spool: there is nothing to print
      if (key === 'pins' && pegs) value = null; // neither: nothing to print or buy
      if (key === 'diameter' && pegs) value = pegSizeOf(value);
      if (el.type === 'radio') el.checked = el.value === String(value);
      else if (el.type === 'checkbox') el.checked = !!value;
      else if (el.type === 'number') {
        if (el !== document.activeElement && Number.parseFloat(el.value) !== value) el.value = value;
      } else if (el.value !== String(value)) el.value = String(value);
      el.disabled =
        !usable ||
        (allApart && GLUED_SETTINGS.has(key)) ||
        (glueOnly && PIN_SETTINGS.has(key) && !(key === 'clearance' && apart.length)) ||
        ((filament || pegs) && key === 'pins');
      // where every cut comes apart nothing is glued: the glued cuts' settings go, rather than stand there greyed out
      if (GLUED_SETTINGS.has(key)) (el.closest('fieldset') ?? el.closest('label')).hidden = allApart;
    });
  } finally {
    filling = false;
  }
  $('splitJointsLabel').hidden = allApart;
  const jointsHint = !apart.length || allApart
    ? ''
    : `Joints are for the glued cuts; ${apart.length > 1 ? `cuts ${listOf(apart)} come apart` : `cut ${apart[0]} comes apart`}.`;
  relabel($('splitJointsHint'), jointsHint);
  $('splitJointsHint').hidden = !jointsHint;
  const filamentOption = document.querySelector(`[data-split="diameter"] option[value="${FILAMENT}"]`);
  filamentOption.hidden = filamentOption.disabled = pegs;
  // the pin settings size the pegs: their names say which
  document.querySelectorAll('#splitSettings [data-peg-label]').forEach((el) => relabel(el, pegs ? el.dataset.pegLabel : el.dataset.pinLabel));
  const chosen = piecesCurrent() && (pegs ? lastPieces.pegSize : lastPieces.diameter);
  document.querySelector('[data-split="diameter"] option[value="0"]').textContent = chosen ? `Auto (${chosen} mm)` : 'Auto';
  $('splitCard').classList.toggle('active', active);
  const hint = !usable
    ? modelInfo?.hasModel
      ? "Splitting needs a solid model – this one couldn't be repaired."
      : 'Open a model or add raised text to split it.'
    : active
      ? ''
      : "Too big for your printer, or want the top to come off – a lantern's, a box's lid? Cut it into pieces that print one by one.";
  $('splitHint').textContent = hint;
  $('splitHint').hidden = !hint;
  $('splitBedText').textContent = `Your printer: ${formatSize(bedSize(bed))}`;
  const bounds = cutBounds();
  $('splitFitBtn').disabled = !usable;
  $('splitFitTestBtn').disabled = !usable || (glueOnly && !apart.length); // nothing to try the fit of, but a lip's
  $('addCutBtn').disabled = !usable || !roomForAnyCut() || (!!bounds && !nextCut(bounds, planeCuts()));
  // a removable part is picked on the model: the button stays pressed while it is
  const picking = !!aiming && !aiming.cutId;
  $('addApartBtn').disabled = !usable || !modelInfo?.hasModel || (!picking && !roomForCut(2));
  $('addApartBtn').setAttribute('aria-pressed', String(picking));
  $('splitClearBtn').hidden = !active;
  $('splitSettings').hidden = !active;
  renderCuts();
  renderPartsCard();
  renderSpots();
  renderPieces();
  renderSplitNotes();
}

let cutsSignature = '';
/** The cut rows: rebuilt only when cuts come or go, otherwise patched in place so typing in one is never interrupted. */
function renderCuts() {
  const list = $('cutList');
  const cuts = doc.split?.cuts ?? [];
  // a part's row is not a plane's: a cut that turns into the other kind gets its row built again
  const signature = cuts.map((c) => (c.part ? `${c.id}:part` : c.id)).join(',');
  if (signature !== cutsSignature) {
    cutsSignature = signature;
    // a rebuild must not swallow the box being typed in
    const focused = ['cutAt', 'partZ', 'partD'].map((k) => [k, document.activeElement?.dataset?.[k]]).find(([, id]) => id);
    list.replaceChildren(...cuts.map((c) => (c.part ? partRow(c.id) : cutRow(c.id))));
    if (focused) list.querySelector(`[data-${focused[0].replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}="${CSS.escape(focused[1])}"]`)?.focus();
  }
  const bounds = cutBounds();
  const usable = canSplit();
  list.querySelectorAll(':scope > li').forEach((li, i) => {
    const cut = cuts[i];
    if (cut.part) return fillPartRow(li, cut, i);
    const plane = cutPlane(cut);
    const letter = letterFor(i);
    li.classList.toggle('selected', cut.id === selectedCutId);
    li.querySelector('.badge').textContent = letter;
    // a cut that comes apart: its row and badge teal, as its plane, and how it holds beside the box
    const apart = cut.joint === 'apart';
    li.classList.toggle('apart', apart);
    const box = li.querySelector('[data-cut-apart]');
    box.checked = apart;
    box.disabled = !usable;
    box.setAttribute('aria-label', `Cut ${letter} comes apart`);
    li.querySelector('.cut-hold').hidden = !apart;
    // asked to lock where nothing locks – no clip fits and no twist-lock takes their place – Locks is struck through,
    // and says why and what would
    const missing = lockMissing(cut, plane);
    li.querySelectorAll('[data-cut-hold]').forEach((r) => {
      r.checked = apart && r.value === cut.hold;
      r.disabled = !usable;
      const struck = r.value === 'lock' && !!missing;
      r.parentElement.classList.toggle('struck', struck);
      r.parentElement.title = struck ? noLockTitle(missing) : CUT_HOLD_CHOICES.find(([v]) => v === r.value)?.[2] ?? '';
    });
    li.querySelectorAll('[data-cut-axis]').forEach((r) => {
      r.checked = Number(r.value) === plane?.axis;
      r.disabled = !usable;
    });
    const place = li.querySelector('[data-cut-place]');
    place.disabled = !usable || !modelInfo?.hasModel || !plane;
    place.setAttribute('aria-pressed', String(aiming?.cutId === cut.id));
    place.setAttribute('aria-label', `Place cut ${letter} on the model`);
    const at = li.querySelector('[data-cut-at]');
    at.disabled = !usable;
    at.setAttribute('aria-label', `Where cut ${letter} is, in mm`);
    if (plane) {
      if (bounds) {
        at.min = String(Math.floor(bounds.min[plane.axis] * 10) / 10);
        at.max = String(Math.ceil(bounds.max[plane.axis] * 10) / 10);
      }
      if (at !== document.activeElement && Number.parseFloat(at.value) !== round(plane.at)) at.value = round(plane.at);
    }
    li.querySelector('.meta').textContent = [cutMeta(cut, plane), missing ? 'no lock fits here' : ''].filter(Boolean).join(' · ');
  });
}

/**
 * Why a cut that comes apart and is asked to lock (Locks) gets no lock where it is – 'round' a round wall, 'other' –
 * as the split worked out says it, else as the engine said of the place while it was placed; null where it locks, or
 * nobody knows yet.
 */
function lockMissing(cut, plane) {
  if (cut.joint !== 'apart' || cut.hold !== 'lock' || !plane) return null;
  const got = joined?.key === lastSplitKey && joined.content === lastContentKey ? joined.joints.get(cut.id) : undefined;
  if (got !== undefined) {
    if (got !== 'lifts off' && got !== 'none') return null;
    const note = piecesCurrent() ? lastPieces.notes.find((n) => n.cutId === cut.id && n.code === 'APART_NO_CLIPS') : null;
    return note?.why === 'short' ? 'round' : 'other';
  }
  const probe = probes.get(probeKey(plane.axis, plane.at, 'lock'));
  return probe ? noLockOf(probe.lip) : null;
}

/** How a part holds, as its row offers it: the value, its name and what it means. */
const PART_HOLD_CHOICES = [
  ['lock', 'Twist-lock', 'Turns on and clicks shut: lugs on the lantern, slots and click tabs in the part'],
  ['lift', 'Lifts off', 'Nothing holds it: it sits on its cut face'],
];

/** The notes that say a part was moved up the layers, or left out: its row says so. */
const PART_REFUSALS = new Set(['PART_GAP', 'PART_STUCK', 'PART_MIXED', 'PART_SPLIT', 'PART_CROSSED', 'CUT_MISSES']);

/**
 * One part's row: its letter, what it is called and ×; on a line below where its face is (Z) and how wide its circle
 * is (Ø), and how it holds – Twist-lock or Lifts off; what it gets under that.
 */
function partRow(id) {
  const li = document.createElement('li');
  li.dataset.id = id;
  li.className = 'part apart';
  li.title = 'Select this part: the arrow keys move its face up and down, and the dot on its circle makes it wider or narrower';
  const badge = document.createElement('span');
  badge.className = 'badge';
  const name = document.createElement('span');
  name.className = 'part-name';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn small ghost cut-remove';
  remove.textContent = '×';
  remove.title = 'Remove this part: it stays on the model';
  remove.setAttribute('aria-label', 'Remove this part');
  remove.addEventListener('click', () => removeCut(id));
  // the crosshair: click the part on the model itself – the dome, the base – and the circle goes where the finder puts it
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'btn small ghost cut-place';
  pick.dataset.partPick = id;
  pick.title = 'Pick on the model: click the part this cut takes out';
  pick.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 .5v4.2M8 11.3v4.2M.5 8h4.2M11.3 8h4.2" stroke="currentColor" stroke-width="1.6"/></svg>';
  pick.addEventListener('click', () => startAim(id));
  const place = document.createElement('div');
  place.className = 'part-place';
  // where its face is, and how wide: typed in, the circle drawn there as it is typed (`preview`), and the cut changed
  // once the box is left or Enter pressed – a number half typed is no place to cut the model at – then put on the
  // printer's layers and kept to where the part prints apart (`settle`), each one undo step a box
  const box = (label, key, step, preview, set, settle) => {
    const where = document.createElement('label');
    where.className = 'at';
    const tag = document.createElement('span');
    tag.className = 'unit';
    tag.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = step;
    input.dataset[key] = id;
    input.addEventListener('focus', () => selectedCutId !== id && selectCut(id));
    input.addEventListener('input', () => {
      const v = Number.parseFloat(input.value);
      partTyped = Number.isFinite(v) ? { id, ...preview(v) } : null;
      drawParts();
    });
    input.addEventListener('change', () => {
      const v = Number.parseFloat(input.value);
      partTyped = null;
      if (Number.isFinite(v) && set(v) !== false) settle();
      else drawParts();
    });
    input.addEventListener('blur', () => {
      // a box left empty, or with nonsense in it, shows the part as it is again
      partTyped = null;
      drawParts();
      renderCuts();
    });
    const unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = 'mm';
    where.append(tag, input, unit);
    return where;
  };
  const z = box('Z', 'partZ', '0.1', (v) => ({ at: v }), (v) => moveCut(id, v, { coalesce: `split:at:${id}` }), () => settlePartFace(id));
  const d = box(
    'Ø', 'partD', '0.5', (v) => (v > 0 ? { r: v / 2 } : {}),
    (v) => (v > 0 ? doc.updateCut(id, { part: { r: v / 2 } }, { coalesce: `split:d:${id}` }) : false),
    () => settlePartWidth(id, { tol: 0.25 }),
  );
  const holds = document.createElement('fieldset');
  holds.className = 'seg cut-hold';
  holds.setAttribute('aria-label', 'How the part holds');
  for (const [value, label, title] of PART_HOLD_CHOICES) {
    const option = document.createElement('label');
    option.title = title;
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `cutHold-${id}`;
    radio.value = value;
    radio.dataset.cutHold = id;
    radio.addEventListener('change', () => radio.checked && setCutHold(id, value));
    keepKeysForCut(radio);
    const span = document.createElement('span');
    span.textContent = label;
    option.append(radio, span);
    holds.append(option);
  }
  place.append(z, d, holds);
  const meta = document.createElement('span');
  meta.className = 'meta';
  // ▶ the part coming out along its way, in the pieces view; Shift: going on
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'btn small ghost part-play';
  play.textContent = '▶';
  play.title = 'Show how it comes apart (Shift: how it goes on)';
  play.dataset.partPlay = id;
  play.addEventListener('click', (e) => playWays({ back: e.shiftKey, cutId: id }));
  const under = document.createElement('div');
  under.className = 'part-meta';
  under.append(meta, play);
  li.append(badge, name, pick, remove, place, under);
  li.addEventListener('pointerdown', (e) => selectedCutId !== id && !e.target.closest('.cut-remove, .part-play, .cut-place') && selectCut(id));
  // pointing at the part lights its lock in the pieces view
  li.addEventListener('mouseenter', () => viewer.setLockHighlight(id));
  li.addEventListener('mouseleave', () => viewer.setLockHighlight(null));
  return li;
}

/**
 * A part's row as the part is now: its name and kind, where its face is and how wide it is, and – from the pieces
 * once they are worked out, else the parts table – the lock it gets, or why none fits and from what size one does.
 * Where no lock fits at this size, Twist-lock is drawn disabled and saying from what size one does, and the part
 * shows as lifting off; its hold stays Twist-lock, so a bigger print locks it with no other click.
 */
function fillPartRow(li, cut, i) {
  const letter = letterFor(i);
  const usable = canSplit();
  const plane = cutPlane(cut);
  const info = partInfo(cut, letter);
  li.classList.toggle('selected', cut.id === selectedCutId);
  li.querySelector('.badge').textContent = letter;
  relabel(li.querySelector('.part-name'), info.name);
  const z = li.querySelector('[data-part-z]');
  // a base's face is the model's own bottom: there is nowhere else for it to go
  z.closest('label').hidden = info.kind === 'plug';
  z.disabled = !usable || !plane;
  z.setAttribute('aria-label', `Where cut ${letter}'s part comes off, Z in mm`);
  if (plane && z !== document.activeElement && Number.parseFloat(z.value) !== roundZ(plane.at)) z.value = roundZ(plane.at);
  const d = li.querySelector('[data-part-d]');
  d.disabled = !usable;
  d.setAttribute('aria-label', `How wide cut ${letter}'s part is, Ø in mm`);
  const across = round(2 * cut.part.r, 1);
  if (d !== document.activeElement && Number.parseFloat(d.value) !== across) d.value = across;
  const shown = info.small && cut.hold === 'lock' ? 'lift' : cut.hold;
  li.querySelectorAll('[data-cut-hold]').forEach((r) => {
    r.checked = r.value === shown;
    const none = r.value === 'lock' && info.small;
    r.disabled = !usable || none;
    r.parentElement.title = none ? `No twist-lock fits at this size${info.least != null ? ` – from ${info.least} %` : ''}` : PART_HOLD_CHOICES.find(([v]) => v === r.value)[2];
    r.parentElement.classList.toggle('struck', none);
  });
  li.querySelector('.meta').textContent = partMeta({ hold: cut.hold, kind: info.kind, lock: info.lock, least: info.least, handle: info.handle, note: info.note, known: info.known, why: info.why });
  const pick = li.querySelector('[data-part-pick]');
  pick.disabled = !usable || !modelInfo?.hasModel || plane?.axis !== 2;
  pick.setAttribute('aria-pressed', String(aiming?.cutId === cut.id));
  pick.setAttribute('aria-label', `Pick cut ${letter}'s part on the model`);
  const play = li.querySelector('[data-part-play]');
  play.hidden = !usable || !modelInfo?.hasModel || partLook(cut, letter).state === 'stuck';
  play.setAttribute('aria-label', `Show how cut ${letter}'s ${info.name.toLowerCase()} comes apart`);
}

/** How a cut that comes apart holds, as its row offers it, firmest first: the value, its name and what it means. */
const CUT_HOLD_CHOICES = [
  ['lock', 'Locks', 'Holds firmly – comes off only with a firm pull'],
  ['snap', 'Clicks on', 'Holds when carried – pulls off by hand'],
  ['light', 'Light click', 'A gentle click'],
  ['lift', 'Lifts off', 'No clips – just sits on'],
];

/** A row's control that only switches what the cut is: a press keeps the arrow keys for the cut, not the control. */
const keepKeysForCut = (input) => input.addEventListener('focus', () => !input.matches(':focus-visible') && input.blur());

/**
 * One cut's row: letter, the axis it runs across, where it is, ×; on a line
 * below whether it comes apart, and how it holds; what it cuts under that.
 */
function cutRow(id) {
  const li = document.createElement('li');
  li.dataset.id = id;
  li.title = 'Select this cut: drag its handle in the view, or move it with the arrow keys';
  const badge = document.createElement('span');
  badge.className = 'badge';
  const axes = document.createElement('fieldset');
  axes.className = 'seg';
  axes.setAttribute('aria-label', 'Cut across');
  ['X', 'Y', 'Z'].forEach((name, axis) => {
    const label = document.createElement('label');
    label.title = `Cut across ${name}`;
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `cutAxis-${id}`;
    radio.value = String(axis);
    radio.dataset.cutAxis = id;
    radio.addEventListener('change', () => radio.checked && setCutAxis(id, axis));
    // pressing the row selects the cut for the arrow keys: a segment clicked must not keep them, turning the cut instead
    keepKeysForCut(radio);
    const span = document.createElement('span');
    span.textContent = name;
    label.append(radio, span);
    axes.append(label);
  });
  const where = document.createElement('label');
  where.className = 'at';
  const at = document.createElement('input');
  at.type = 'number';
  at.step = '0.5';
  at.dataset.cutAt = id;
  at.addEventListener('focus', () => selectedCutId !== id && selectCut(id));
  at.addEventListener('input', () => moveCut(id, Number.parseFloat(at.value), { coalesce: `split:at:${id}` }));
  at.addEventListener('change', () => doc.endCoalescing());
  at.addEventListener('blur', () => renderCuts()); // a box left empty shows where the cut is again
  const unit = document.createElement('span');
  unit.className = 'unit';
  unit.textContent = 'mm';
  where.append(at, unit);
  // the crosshair: pick the cut's place on the model itself, where it snaps to ledges and good spots
  const place = document.createElement('button');
  place.type = 'button';
  place.className = 'btn small ghost cut-place';
  place.dataset.cutPlace = id;
  place.title = 'Place on model: click the model where this cut should go';
  place.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 .5v4.2M8 11.3v4.2M.5 8h4.2M11.3 8h4.2" stroke="currentColor" stroke-width="1.6"/></svg>';
  place.addEventListener('click', () => startAim(id));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn small ghost cut-remove';
  remove.textContent = '×';
  remove.title = 'Remove this cut';
  remove.setAttribute('aria-label', 'Remove this cut');
  remove.addEventListener('click', () => removeCut(id));
  // a joint that is never glued: the box, and next to it how the top holds once it is ticked
  const joint = document.createElement('div');
  joint.className = 'cut-joint';
  const apart = document.createElement('label');
  apart.className = 'check cut-apart';
  apart.title = "A joint that comes apart and goes back on – a lantern's top, a box's lid. One piece gets a lip, the other clicks onto it; never glued.";
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.dataset.cutApart = id;
  box.addEventListener('change', () => setCutApart(id, box.checked));
  keepKeysForCut(box);
  apart.append(box, ' Comes apart');
  const holds = document.createElement('fieldset');
  holds.className = 'seg cut-hold';
  holds.setAttribute('aria-label', 'How the top holds');
  holds.hidden = true;
  for (const [value, name, title] of CUT_HOLD_CHOICES) {
    const label = document.createElement('label');
    label.title = title;
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `cutHold-${id}`;
    radio.value = value;
    radio.dataset.cutHold = id;
    radio.addEventListener('change', () => radio.checked && setCutHold(id, value));
    keepKeysForCut(radio);
    const span = document.createElement('span');
    span.textContent = name;
    label.append(radio, span);
    holds.append(label);
  }
  joint.append(apart, holds);
  const meta = document.createElement('span');
  meta.className = 'meta';
  li.append(badge, axes, where, place, remove, joint, meta);
  // selected on press, not on click: re-rendering in the middle of a click on an axis would undo the axis just clicked
  li.addEventListener('pointerdown', (e) => selectedCutId !== id && !e.target.closest('.cut-remove') && selectCut(id));
  return li;
}

/**
 * The joint each cut got in a worked-out split, from its seams: pins or
 * built-in pegs when some face of it takes one (its note tells of those left
 * flat), tabs on a dovetail cut that had room for them, otherwise none. A cut
 * that comes apart says how it holds, every face of it counted: "locks (4
 * clips)", "clicks on (4 clips)", "light click (4 clips)", "twist-lock (turn
 * 10°)" (a round wall's, in place of clips), "lifts off" (a lip with no
 * clips), or tabs or none.
 */
function jointsOfSeams(seams = []) {
  const joints = new Map();
  const lips = new Map(); // cutId -> { hold, lip, clips, tabs, turn } over the cut's seams that come apart
  for (const s of seams) {
    if (s.apart) {
      const l = lips.get(s.cutId) ?? { hold: s.apart.hold, lip: false, clips: 0, tabs: false, turn: null };
      l.lip ||= !!s.apart.lip;
      l.clips += s.apart.lip ? s.apart.clips ?? 0 : 0;
      l.tabs ||= s.joint === 'dovetail' && !!s.tabs;
      if (s.apart.mech === 'twist' && !s.part) l.turn = s.apart.theta;
      lips.set(s.cutId, l);
      continue;
    }
    const got = s.joint === 'dovetail' && s.tabs ? 'dovetail' : s.pegs?.length ? 'pegs' : s.dowels?.length ? 'dowels' : 'none';
    if ((joints.get(s.cutId) ?? 'none') === 'none') joints.set(s.cutId, got);
  }
  for (const [cutId, l] of lips) {
    const clips = `${l.clips} ${l.clips === 1 ? 'clip' : 'clips'}`;
    const how = { lock: 'locks', light: 'light click' }[l.hold] ?? 'clicks on';
    const held = l.clips > 0 && l.hold !== 'lift' ? `${how} (${clips})` : 'lifts off';
    joints.set(cutId, l.turn != null ? `twist-lock (turn ${Math.round(l.turn)}°)` : l.lip ? held : l.tabs ? 'dovetail' : 'none');
  }
  return joints;
}

/** Keep what a split worked out for `key` and `content` gave the cuts, with what was known of that split already. */
function rememberJoints(key, content, joints) {
  const known = joined?.key === key && joined.content === content ? joined.joints : [];
  joined = { key, content, joints: new Map([...known, ...joints]) };
}

/**
 * What a cut's row says it cuts, from the last measure – its joint from the
 * split once worked out: "800 mm² · pins", "misses the model", "through “HELLO”";
 * a cut that comes apart says so, and once worked out how it holds:
 * "1,728 mm² · comes apart: locks (4 clips)".
 */
function cutMeta(cut, plane) {
  if (!plane) return "isn't straight along X, Y or Z";
  const m = measured?.cuts.get(cut.id);
  if (!m) return '';
  if (m.joint === 'miss') return "doesn't cross the model – it cuts nothing";
  if (m.merged) return `in the same place as cut ${cutLetter(m.merged) ?? ''}`.trim();
  if (!m.islands) return 'crosses no material – nothing to join'; // between letters of a sign: the pieces never touch here
  const parts = [`${Math.round(m.area).toLocaleString()} mm²${m.islands > 1 ? ` in ${m.islands} parts` : ''}`];
  // the measure plans pins (or pegs) wherever there are no tabs; once the split is worked out, a cut none fits is glue only
  const got = joined?.key === lastSplitKey && joined.content === lastContentKey ? joined.joints.get(cut.id) : null;
  // the box decides at once, whatever the measure before it said: the joint the cut gets is the split's to tell. A cut
  // that another one in the same place was merged into comes apart when that one does
  const apart = cut.joint === 'apart' || (doc.split?.cuts ?? []).some((c) => c.joint === 'apart' && measured.cuts.get(c.id)?.merged === cut.id);
  if (apart) parts.push(got ? `comes apart: ${{ dovetail: 'dovetails', none: 'no lip' }[got] ?? got}` : 'comes apart');
  else parts.push({ dovetail: 'dovetails', pegs: 'pegs', none: 'glue only' }[got ?? m.joint] ?? 'pins');
  const through = (m.crosses ?? []).map((itemId) => doc.items.find((i) => i.id === itemId)).filter(Boolean);
  if (through.length) parts.push(`through ${through.map((i) => `“${itemLabel(i)}”`).join(', ')}`);
  return parts.join(' · ');
}

let piecesSignature = '';
/**
 * The pieces: as computed (hovering one picks it out in the view), or until
 * then the boxes between the cuts with whether each would fit.
 */
function renderPieces() {
  const list = $('pieceList');
  const active = splitActive(doc.split);
  // pieces for older cuts stay (dimmed) while newer ones are worked out for the view
  const computed = active && lastPieces?.pieces.length && (piecesCurrent() || $('resultToggle').checked) ? lastPieces : null;
  let rows = [];
  if (computed) {
    // what each piece of a part's twist-lock carries: the lantern its neck (a base's slots), the part its socket and
    // click tabs (a base its lugs and coin slot)
    const locks = new Map();
    const lockOn = (index, words) => locks.set(index, [...(locks.get(index) ?? []), words]);
    for (const s of computed.seams ?? []) {
      if (s.joint !== 'part' || !s.apart?.mech) continue;
      const [home, piece] = s.pieces;
      if (s.apart.mech === 'plug') {
        lockOn(home, 'twist-lock slots');
        lockOn(piece, 'twist-lock, 3 lugs, coin slot');
      } else {
        lockOn(home, 'twist-lock neck, 3 lugs');
        lockOn(piece, `twist-lock socket, ${s.apart.tabs} ${s.apart.tabs === 1 ? 'click' : 'clicks'}`);
      }
    }
    rows = computed.pieces.map((p) => ({
      index: p.index,
      // a piece with a name of its own: a part taken out, or the lantern it came out of
      name: p.name && !/^piece \d+ of \d+$/.test(p.name) ? p.name : null,
      cell: p.cell,
      size: p.size,
      fits: p.fits,
      lies: `lies ${p.lies}${p.yaw ? `, turned ${p.yaw}°` : ''}`,
      extra: [
        p.shells > 1 ? `${p.shells} parts` : '',
        p.dowels ? `${p.dowels} ${p.dowels === 1 ? 'pin' : 'pins'}` : '',
        // which piece carries a face's built-in pegs, and which has their sockets
        p.pegs ? `${p.pegs} ${p.pegs === 1 ? 'peg' : 'pegs'}` : '',
        p.sockets ? `${p.sockets} ${p.sockets === 1 ? 'socket' : 'sockets'}` : '',
        // which piece a take-apart cut's lip (or the neck of its twist-lock) stands out of, and which comes off it
        ...(p.lips ?? []).map((l) => (l.twist ? `twist-lock neck at ${l.letter}` : `lip at ${l.letter}${l.clips ? `, ${l.clips} ${l.clips === 1 ? 'clip' : 'clips'}` : ''}`)),
        p.lids?.length ? `comes off at ${listOf(p.lids)}` : '',
        ...(locks.get(p.index) ?? []),
      ].filter(Boolean),
    }));
  } else if (active) {
    // a box whose loose parts print apart (a bookcase's shelves between two cuts) says how many pieces it makes
    const counted = measuredPieces();
    const makes = (cell) => counted?.filter((p) => p.cell.join(',') === cell.join(',')).length ?? 1;
    rows = filledBoxes().map((c, i) => ({
      index: i + 1, cell: c.cell, size: c.size, fits: !cellTooBig(c), predicted: true, extra: makes(c.cell) > 1 ? [`prints as ${makes(c.cell)} pieces`] : [],
    }));
    // each part taken out is a piece of its own, past the boxes: its size is known once it is cut, its circle now
    (doc.split?.cuts ?? []).forEach((c, i) => {
      if (!c.part) return;
      const letter = letterFor(i);
      rows.push({ index: rows.length + 1, cell: [0, 0, rows.length], name: partInfo(c, letter).name, across: round(2 * c.part.r, 1), predicted: true, extra: [`comes off at ${letter}`] });
    });
  }
  list.classList.toggle('stale', !!computed && !piecesCurrent());
  $('piecesHint').hidden = !rows.length || !rows[0].predicted || $('resultToggle').checked;
  const signature = JSON.stringify(rows);
  if (signature === piecesSignature) return;
  piecesSignature = signature;
  viewer.setPieceHighlight(null);
  list.replaceChildren(
    ...rows.map((row) => {
      const li = document.createElement('li');
      li.classList.toggle('predicted', !!row.predicted);
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = `#${PIECE_COLORS[pieceColorIndex(row.cell)].toString(16).padStart(6, '0')}`;
      const text = document.createElement('span');
      const fit = document.createElement('span');
      fit.className = row.fits ? '' : 'err';
      fit.textContent = row.fits ? 'fits' : 'too big';
      if (!row.size) {
        // a part not cut yet: its name and its circle
        text.append(`${row.index} · ${row.name} · Ø ${row.across} mm · ${row.extra.join(' · ')}`);
        li.append(swatch, text);
        return li;
      }
      text.append(`${row.index}${row.name ? ` · ${row.name}` : ''} · ${formatSize(row.size)} · ${row.lies ? `${row.lies} · ` : ''}`, fit, row.extra?.length ? ` · ${row.extra.join(' · ')}` : '');
      li.append(swatch, text);
      if (!row.predicted) {
        // a piece pointed at stands out, and the locks it has glow on it and on the piece each one holds
        li.addEventListener('mouseenter', () => {
          viewer.setPieceHighlight(row.index);
          viewer.setLockHighlight(locksOn(row.index));
        });
        li.addEventListener('mouseleave', () => {
          viewer.setPieceHighlight(null);
          viewer.setLockHighlight(null);
        });
      }
      return li;
    }),
  );
}

/** What each split note offers to do about it (see the notes in split.js). */
const splitNoteActions = (() => {
  const select = (n) => cutLetter(n.cutId) && { label: `Select cut ${cutLetter(n.cutId)}`, run: () => selectCut(n.cutId) };
  const remove = (n) => cutLetter(n.cutId) && { label: `Remove cut ${cutLetter(n.cutId)}`, run: () => removeCut(n.cutId) };
  const smaller = (n) => n.suggestedDiameter && { label: `Use Ø${n.suggestedDiameter} mm`, run: () => setSplitSetting('diameter', n.suggestedDiameter) };
  // a lip short of room: where the cut has it, when there is such a place
  const moveTo = (n) =>
    Number.isFinite(n.suggestedAt) && cutLetter(n.cutId)
      ? { label: `Move cut ${cutLetter(n.cutId)} to ${round(n.suggestedAt)} mm`, run: () => moveCut(n.cutId, n.suggestedAt) }
      : select(n);
  // clips too light for what hangs below them: the gentlest firmer hold that holds it up, as the engine worked it out
  const firmer = (n) => {
    const name = CUT_HOLD_CHOICES.find(([hold]) => hold === n.firmer)?.[1];
    return name && cutLetter(n.cutId) && { label: `Use ${name}`, run: () => setCutHold(n.cutId, n.firmer) };
  };
  // a part too small for a lock at this size: the sizes that fit one, and a tea light through it, as the card offers
  // them
  const bigger = (n) => {
    if (n.lock == null) return null;
    const sizes = [...new Set([n.lock, n.tea].filter((q) => q != null).map((q) => offerPercent(q / 100)))];
    return sizes.map((percent) => ({ label: `Make it ${percent} %`, run: () => makeIt(percent, currentTable()?.scale ?? n.now / 100) }));
  };
  return {
    PART_SMALL: bigger,
    PART_FIT: () => ({ label: 'Download fit test', run: downloadFitTest }),
    PART_GAP: select,
    PART_STUCK: select,
    PART_SPLIT: select,
    PART_MIXED: select,
    APART_NO_CLIPS: moveTo,
    APART_FLAT: moveTo,
    APART_HEAVY: firmer,
    PIECE_TOO_BIG: () => canSplit() && { label: 'Fit to my printer', run: autoSplit },
    SMALL_PIECE: select,
    CUT_THROUGH_TEXT: select,
    CUT_MISSES: remove,
    CUT_NOT_STRAIGHT: remove,
    CONNECTORS_DROPPED: smaller,
    CONNECTORS_FILAMENT: smaller,
    PEGS_SMALLER: select,
    PLAN_TOO_MANY: () => ({ label: 'Choose a printer', run: openPrinting }),
  };
})();

let splitNotesShown = '';
/** The split's notes: those of the pieces, or until they are worked out those of the last measure; and what a fit found. */
function renderSplitNotes() {
  const active = splitActive(doc.split);
  let notes = [];
  if (active && lastPieces && (piecesCurrent() || $('resultToggle').checked)) notes = lastPieces.notes;
  else if (active && measured) notes = measured.notes;
  if (planNotes?.key === lastSplitKey && planNotes.content === lastContentKey) notes = [...planNotes.notes, ...notes];
  const shown = JSON.stringify(notes.map((n) => [n.code, n.text]));
  if (shown === splitNotesShown) return;
  splitNotesShown = shown;
  renderNotes($('splitNotes'), notes, splitNoteActions);
}

/**
 * How long the pieces either side of a cut across `axis` at `at` are – the
 * cut `id` moved there, or a new one (`id` null) – dovetail tabs and built-in
 * pegs counted, as in the piece list: "162 | 138 mm", a side in red when a
 * piece there won't fit; null when the place is not in the model.
 */
function piecesBeside(id, axis, at) {
  const b = cutBounds();
  if (!b || !(at > b.min[axis] && at < b.max[axis])) return null;
  const across = { id: 'aim', position: b.min.map((v, a) => (a === axis ? at : (v + b.max[a]) / 2)), normal: [0, 1, 2].map((a) => (a === axis ? 1 : 0)) };
  const live = id ? cutsWithTabs().map((c) => (c.id === id ? { ...c, position: c.position.map((v, a) => (a === axis ? at : v)) } : c)) : [...cutsWithTabs(), across];
  const others = axisCuts(live.filter((c) => c.id !== (id ?? 'aim')), b)[axis];
  const lo = Math.max(b.min[axis], ...others.filter((t) => t < at - 1e-6));
  const hi = Math.min(b.max[axis], ...others.filter((t) => t > at + 1e-6));
  const { cells } = cellSizes(b, live);
  // the pieces either side of this cut: below it, those whose box ends at it; above it, those whose box starts there.
  // Their length is their box's, which counts the tabs or pegs of a cut at either end as the red and the piece list do
  const side = (end, bare) => {
    const span = document.createElement('span');
    const those = cells.filter((c) => Math.abs(c[end][axis] - at) < 1e-6);
    span.textContent = String(round(those.length ? those[0].size[axis] : bare, 1));
    span.className = those.some(cellTooBig) ? 'err' : '';
    return span;
  };
  return [side('max', at - lo), ' | ', side('min', hi - at), ' mm'];
}

/**
 * The readout by a dragged cut's handle: "A · X = 12 mm · 162 | 138 mm",
 * how long the pieces either side are; for a cut that comes apart, under it
 * the lip it would get there once the engine has said ("locks with 4 clips ·
 * top 101 mm comes off"); another cut already there, where a drop leaves it
 * as it was; and what it snapped to.
 */
function showReadout(id, at, screen, target = null) {
  const el = $('cutReadout');
  const cuts = doc.split?.cuts ?? [];
  const i = cuts.findIndex((c) => c.id === id);
  const plane = cutPlane(cuts[i]);
  if (!plane || !screen) {
    el.hidden = true;
    return;
  }
  const axis = plane.axis;
  const first = document.createElement('div');
  const beside = piecesBeside(id, axis, at);
  first.append(`${letterFor(i)} · ${'XYZ'[axis]} = ${round(at, 1)} mm · `, ...(beside ?? ["misses the model"]));
  const hold = cuts[i].joint === 'apart' ? cuts[i].hold : null;
  const probe = hold ? probes.get(probeKey(axis, at, hold)) : null;
  // off the model the first line has said so: the lip's line would only say it again
  const lip = probe && beside ? [lipLine(axis, probe, hold), throughWords(namesOf(probe.crosses))].filter(Boolean).join(' · ') : '';
  const here = cutHere(axis, at, id);
  fillReadout([first, lip, here ? `cut ${cutLetter(here.id)} is already here` : '', snappedWords(target, axis)], hold ? lipVerdict(probe, hold) : null, probe !== undefined);
  // by the handle, on whichever side has room
  const right = screen[0] > $('stage').clientWidth - 240;
  el.style.left = `${screen[0]}px`;
  el.style.top = `${screen[1]}px`;
  el.style.transform = right ? 'translate(calc(-100% - 30px), -50%)' : '';
}

/**
 * Fill the readout with its lines (empty ones left out), its border coloured
 * as the section is: by the lip's `verdict` once it is `known`. Lines that
 * say what they said already are left as they are, so a pointer moving over
 * one place only moves the readout (see `showAimReadout`).
 */
function fillReadout(lines, verdict, known) {
  const el = $('cutReadout');
  const kept = lines.filter(Boolean);
  const said = JSON.stringify([kept.map((line) => (typeof line === 'string' ? line : `${line.className}:${line.textContent}`)), verdict && known ? verdict : '']);
  el.hidden = false;
  if (el.dataset.said === said) return;
  el.dataset.said = said;
  el.replaceChildren(
    ...kept.map((line, k) => {
      if (typeof line !== 'string') return line;
      const div = document.createElement('div');
      div.textContent = line;
      if (k > 0) div.className = line.startsWith('snapped') ? 'snap' : 'lip';
      return div;
    }),
  );
  el.dataset.verdict = verdict && known ? verdict : '';
}

/* ----------------------------------------------- placing a cut on the model */

const AXES = ['x', 'y', 'z'];
let aiming = null; // { cutId, axis } while a place is picked on the model for a cut: cutId null for a new one that comes apart
let aimAt = null; // { axis, at, target, screen, pinned, hold, cutId, drag } the place under the pointer, or a dragged handle's
let probeTimer = 0;
const probes = new Map(); // probe key -> the engine's answer for a place (64 kept): going back to a place answers at once
let targetsFor = null; // { key, axis, seams, estimate } the model's seams along an axis, which a cut placed or dragged snaps to
let lipTarget = null; // { axis, at }: where the place tried last gets a full lip, when it had none – a target while it is placed or dragged
let spots = null; // { base, key, axis, hold, busy, list, failed, estimate, quiet } the spots suggested, while they are shown
let aimHintShown = ''; // what the status line said to do while placing: it goes when placing stops

/** The split's settings as the engine reads them for a cut tried on its own (the clearance sizes the lip). */
const aimSplit = () => ({ ...SPLIT_DEFAULTS, ...splitDefaults, ...doc.split });

/** What trying a place depends on besides the place: the model and its text, the clearance and the nozzle. */
const aimKey = () => `${boundsKey()}|${aimSplit().clearance}|${printing.nozzle}`;
const probeKey = (axis, at, hold) => `${aimKey()}|${axis}|${at}|${hold}`;

/** The hold a cut being placed would have: its own when it comes apart, Locks for a new one (as a cut newly ticked), null for a glued one. */
function holdOf(cutId) {
  if (!cutId) return 'lock';
  const cut = doc.split?.cuts.find((c) => c.id === cutId);
  return cut?.joint === 'apart' ? cut.hold : null;
}

/** The names of the text items with these ids, as the readout and the suggestions call the letters a cut runs through. */
const namesOf = (ids = []) => ids.map((id) => doc.items.find((i) => i.id === id)).filter(Boolean).map((i) => itemLabel(i));

/** The cut across `axis` already at `at` (to within 0.05 mm), other than `except`: another one there would do nothing. */
function cutHere(axis, at, except = null) {
  return planeCuts().find((c) => c.id !== except && cutPlane(c)?.axis === axis && Math.abs(cutPlane(c).at - at) < 0.05) ?? null;
}

/** The selected cut when it comes apart (and is straight): the one a suggestion moves. */
function selectedApartCut() {
  const cut = doc.split?.cuts.find((c) => c.id === selectedCutId);
  return cut?.joint === 'apart' && !cut.part && cutPlane(cut) ? cut : null;
}

/** Whether one more cut across `axis` stays within the limits (12 cuts, 64 pieces). */
function roomForCut(axis) {
  if (!roomForAnyCut()) return false;
  const b = cutBounds();
  if (!b) return true;
  const { grid } = cellSizes(b, planeCuts());
  return grid.reduce((n, g, a) => n * (g + 1 + (a === axis ? 1 : 0)), 1) <= SPLIT_LIMITS.cells;
}

/** A plane across `axis` at `at`, through the middle of the model otherwise: where a cut placed from the view goes. */
function cutAcross(axis, at) {
  const b = cutBounds();
  const position = b ? b.min.map((v, a) => (v + b.max[a]) / 2) : [0, 0, 0];
  position[axis] = at;
  return { position, normal: [0, 1, 2].map((a) => (a === axis ? 1 : 0)) };
}

/** The model's seams along an axis, for snapping a cut placed or dragged across it and the ticks beside it: asked once for each model. */
async function loadTargets(axis) {
  if (!booted || halted || !modelInfo?.hasModel) return;
  const key = `${aimKey()}|${axis}`;
  if (targetsFor?.key === key) return;
  targetsFor = { key, axis, seams: [] };
  lipTarget = null;
  pushTargets();
  let r;
  try {
    if (await syncBase()) r = await client.cutTargets(doc.items, version(), { axis: AXES[axis], printing, split: aimSplit() });
  } catch {
    // snapping goes without the seams meanwhile
  }
  if (targetsFor?.key !== key) return; // asked since for another axis or model
  if (!r) {
    targetsFor = null; // not answered (the model was being updated): asked again on the next render
    return;
  }
  targetsFor.seams = r.seams;
  targetsFor.estimate = !!r.estimate;
  pushTargets();
  onBasis(r);
}

/**
 * An answer worked out on the final result, after some on the model alone
 * (the engine answers from the model alone until the final result is built,
 * a moment after a model is opened): the places tried, the seams and the
 * spots found on the model alone are asked again, so the lengths they give
 * – which count the raised text – agree with each other. The spots quietly:
 * nobody asked for them again, and a cut being placed meanwhile still gets
 * its readout as soon as it would anyway.
 */
function onBasis(r) {
  if (!r || r.estimate) return;
  for (const [key, p] of probes) if (p.estimate) probes.delete(key);
  if (targetsFor?.estimate) {
    const { axis } = targetsFor;
    targetsFor = null;
    loadTargets(axis);
  }
  // quietly: the list stays as it is meanwhile, and the engine answers a place being tried between the spots' slices
  if (spots?.estimate && !spots.busy) suggestSpots({ axis: spots.axis, hold: spots.hold, again: true });
}

/** Hand the view what a cut across the targets' axis snaps to: the seams, the spots suggested and where a full lip fits. */
function pushTargets() {
  const axis = targetsFor?.axis ?? null;
  if (axis === null) return viewer.setAimTargets(null, []);
  viewer.setAimTargets(
    axis,
    aimTargets({
      seams: targetsFor.seams,
      spots: spots?.list && spots.axis === axis ? spots.list : [],
      lip: lipTarget?.axis === axis ? lipTarget : null,
    }),
  );
}

/**
 * Ask the engine about the lip a cut that comes apart would get at the place
 * under the pointer, once the pointer has rested there for 150 ms – at once
 * for a place asked before. Its answer colours the section and fills the
 * readout; a newer probe replaces one still waiting.
 */
function probeAim() {
  clearTimeout(probeTimer);
  const a = aimAt;
  if (!a?.hold) {
    viewer.setAimVerdict(null); // a glued cut's section stays neutral
    return;
  }
  const key = probeKey(a.axis, a.at, a.hold);
  if (probes.has(key)) return showProbe(key);
  viewer.setAimVerdict(null);
  probeTimer = setTimeout(async () => {
    try {
      if (!(await syncBase())) return;
      const r = await client.probeCut(doc.items, version(), { axis: AXES[a.axis], at: a.at, hold: a.hold, printing, split: aimSplit() });
      if (!r) return; // a newer probe took its place
      probes.set(key, r);
      while (probes.size > 64) probes.delete(probes.keys().next().value);
      showProbe(key);
      onBasis(r);
    } catch {
      // the place is shown without a verdict
    }
  }, 150);
}

/**
 * Over a plane a new cut across Z would take a lantern's handle off with the top through, where the lid inside the
 * handle comes off on its own: the readout's warning (`handlePlaneWords`), else null.
 */
const handleWarning = (a) => (a.axis === 2 && !a.cutId && !a.pick ? handlePlaneWords(currentTable(), a.at) : null);

/** How the section and the readout are coloured for a place: by its lip, never as a good place where it takes the handle. */
function aimVerdict(a, probe) {
  const verdict = lipVerdict(probe, a.hold);
  return verdict === 'full' && handleWarning(a) ? 'short' : verdict;
}

/** An answer about a place, if it is still the place being placed or dragged: the section's colour, the readout, where a full lip fits. */
function showProbe(key) {
  const a = aimAt;
  if (!a?.hold || probeKey(a.axis, a.at, a.hold) !== key) return;
  const r = probes.get(key);
  viewer.setAimVerdict(a.drag ? lipVerdict(r, a.hold) : aimVerdict(a, r));
  // where the move gives a full lip, a target too – the view snaps to it at once – and kept while the place shown is
  // that target itself, which has no move of its own to suggest. It says when the lip there is short of a full one
  if (a.target?.kind !== 'lip') {
    const there = r.suggestedLip;
    const lip = Number.isFinite(r.suggestedAt)
      ? { axis: a.axis, at: r.suggestedAt, full: !there || lipVerdict({ lip: there }, a.hold) === 'full', H: there?.H, ...(there?.twist ? { twist: true } : {}), ...(there?.whole ? { whole: true } : {}) }
      : null;
    if (lip?.at !== lipTarget?.at || lip?.axis !== lipTarget?.axis || lip?.full !== lipTarget?.full || lip?.whole !== lipTarget?.whole) {
      lipTarget = lip;
      pushTargets();
    }
  }
  if (a.drag) showReadout(a.cutId, a.at, a.screen, a.target);
  else showAimReadout();
}

/** Whether this screen has nothing that hovers – a phone or a tablet – so a cut is placed with a touch, a slide and a button. */
const touchOnly = () => window.matchMedia?.('(hover: none)').matches ?? false;

/**
 * The readout by the pointer while a cut is placed: where it goes, and once
 * the engine has said, the lip it gets there and what comes off ("Z 190.5 mm
 * · locks with 4 clips · top 101 mm comes off"), or for a glued cut how long
 * the pieces either side are; what it snapped to. Where the plane was put by
 * a touch, buttons to place the cut there or stop.
 */
function showAimReadout() {
  const el = $('cutReadout');
  const a = aimAt;
  if (!aiming || !a) {
    el.hidden = true;
    return;
  }
  if (a.pick || partAim()) return showPartReadout(a);
  const probe = a.hold ? probes.get(probeKey(a.axis, a.at, a.hold)) : null;
  const first = document.createElement('div');
  first.textContent = aimLine(a.axis, a.at, probe ?? null, a.hold, { through: namesOf(probe?.crosses) });
  if (!a.hold) first.append(' · ', ...(piecesBeside(a.cutId, a.axis, a.at) ?? ['misses the model']));
  const here = cutHere(a.axis, a.at, a.cutId);
  // a new cut across Z under a lantern's handle would take the handle with the top, where its lid alone comes off: said
  // first, ahead of the lock the plane would get, which is no good place then; over a base too small for a lock at this
  // size, what it would take from what size
  const handle = handleWarning(a);
  const lines = [handle ?? '', first, here ? `cut ${cutLetter(here.id)} is already here` : '', snappedWords(a.target, a.axis), a.base ?? ''];
  if (a.pinned) {
    const row = document.createElement('div');
    row.className = 'readout-actions';
    const place = document.createElement('button');
    place.type = 'button';
    place.className = 'btn small accent';
    place.textContent = a.cutId ? `Move cut ${cutLetter(a.cutId)} here` : 'Place cut here';
    place.addEventListener('click', () => placeAimed(a.at));
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'btn small';
    stop.textContent = 'Cancel';
    stop.addEventListener('click', () => endAim());
    row.append(place, stop);
    lines.push(row);
  }
  fillReadout(lines, a.hold ? aimVerdict(a, probe) : null, !!probe);
  placeReadout(el, a);
}

/**
 * The readout over a part a click would take out (`aimAt.pick`): the part and the lock it gets, or the handle the lid
 * under it leaves on; that a cut takes it out already. Picking a part's own cut again, anywhere else: that a part
 * is what moves it. Where a finger put it, the buttons to take the part out (or move the cut there) or stop.
 */
function showPartReadout(a) {
  const el = $('cutReadout');
  const pick = a.pick;
  const taken = pick ? partCutFor(pick.part, pick.table) : null;
  const letter = aiming.cutId ? cutLetter(aiming.cutId) : null;
  const lines = pick
    ? [partReadout(pick, pick.table), taken && taken.id !== aiming.cutId ? `cut ${cutLetter(taken.id)} takes it out already` : '']
    : [`No part comes off here – point at one to move cut ${letter} there`];
  if (a.pinned && pick) {
    const row = document.createElement('div');
    row.className = 'readout-actions';
    const place = document.createElement('button');
    place.type = 'button';
    place.className = 'btn small accent';
    place.textContent = letter ? `Move cut ${letter} here` : 'Take it out';
    place.addEventListener('click', () => takePart(pick));
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'btn small';
    stop.textContent = 'Cancel';
    stop.addEventListener('click', () => endAim());
    row.append(place, stop);
    lines.push(row);
  }
  fillReadout(lines, pick ? (pick.part.lock ? 'full' : 'short') : 'none', true);
  placeReadout(el, a);
}

/**
 * The readout beside the pointer where it fits, and always within the view; moved, not laid out again, so following
 * the pointer over a dense model costs the page nothing but the move. Put there by a finger, along the top of the view
 * under its own controls (the bottom when the finger is near the top), clear of the middle where two fingers zoom it.
 */
function placeReadout(el, a) {
  el.classList.toggle('pinned', !!a.pinned);
  const [w, h] = [el.offsetWidth, el.offsetHeight];
  const [x, y] = a.screen;
  const [sw, sh] = viewer.viewSize;
  const fit = (v, size, room) => Math.min(Math.max(8, v), Math.max(8, room - size - 8));
  const left = a.pinned ? x - w / 2 : x + 18 + w + 8 > sw ? x - 18 - w : x + 18;
  const top = a.pinned ? (y > 0.4 * sh ? controlsBottom() + 8 : sh - h - 8) : y - h / 2;
  el.style.left = '0px';
  el.style.top = '0px';
  el.style.transform = `translate(${Math.round(fit(left, w, sw))}px, ${Math.round(fit(top, h, sh))}px)`;
}

/** How far down the view its own controls reach (the legend, Show result, Reset view): a pinned readout goes under them. */
function controlsBottom() {
  const stage = $('stage').getBoundingClientRect();
  return Math.max(0, ...[...document.querySelectorAll('#stage .legend, #stage .stage-tools')].map((el) => el.getBoundingClientRect().bottom - stage.top));
}

/**
 * What the page says while a cut is placed on the model: a glued one snaps to nothing; a part's own cut goes to a
 * part that comes off; a new one, where the model has such parts, takes one out with a click on it.
 */
function aimHint() {
  const part = partAim();
  if (part) {
    const letter = cutLetter(part.id);
    return touchOnly() ? `Touch a part that comes off, then tap Move cut ${letter} here.` : `Click a part that comes off to move cut ${letter} to it. Esc stops.`;
  }
  const what = aiming.cutId ? `cut ${cutLetter(aiming.cutId)} should go` : 'it should come apart';
  const snaps = !!holdOf(aiming.cutId);
  if (!aiming.cutId && currentTable()?.parts.some(takesOut)) {
    return touchOnly()
      ? 'Touch a part that lights up to take it out, or the model where it should come apart and slide to move the plane, then tap the button. It snaps to ledges and good spots.'
      : 'Click a part that lights up to take it out, or the model where it should come apart – it snaps to ledges and good spots; hold Alt to place it freely. Shift+click to place more. Esc stops.';
  }
  return touchOnly()
    ? `Touch the model where ${what} and slide to move the plane, then tap ${aiming.cutId ? `Move cut ${cutLetter(aiming.cutId)} here` : 'Place cut here'}.${snaps ? ' It snaps to ledges and good spots.' : ''}`
    : `Click the model where ${what}${snaps ? ' – it snaps to ledges and good spots; hold Alt to place it freely.' : '.'}${aiming.cutId ? '' : ' Shift+click to place more.'} Esc stops.`;
}

/** Say what to do while placing (`aimHint`), and remember it was said: placing stops, and it goes. */
function showAimHint() {
  aimHintShown = aimHint();
  setStatus(aimHintShown);
}

/** The cut a part is being picked again for, with its row's crosshair: a click on a part moves it there. */
const partAim = () => (aiming?.cutId ? doc.split?.cuts.find((c) => c.id === aiming.cutId && c.part) ?? null : null);

/**
 * Whether a click on this part of the table takes it out: a lid always (too small for a lock, it lifts off until the
 * model is made bigger), a base only where its lock fits – one too small would just drop out, so a click there places
 * a cut across instead, and the readout says from what size the base twists off.
 */
const takesOut = (entry) => entry.kind !== 'plug' || !!entry.lock;

/**
 * The part a point on the model picks while placing (`pickPart` on the parts table: no engine round trip, so at once
 * on a dense model), with the table; null where it picks none, the table is not in yet, or Alt places a cut freely.
 * Only a new cut that comes apart, or a part's own cut picked again, takes a part.
 */
function partPicked(point, free = false) {
  if (!aiming || (aiming.cutId && !partAim()) || free || !point) return null;
  const table = currentTable();
  if (!table?.parts.length) return null;
  const pick = pickPart(table, point);
  return pick.part ? { ...pick, table } : null;
}

/** The part a click would take out, drawn on the model: tinted gold, its circle and walls, the handle it leaves on outlined. */
function showPartHover(pick) {
  const e = pick?.part;
  viewer.setPartHover(
    e
      ? { centre: e.centre, r: e.r, face: e.face, top: e.top ?? e.cap, handle: e.handle && !e.takesHandle ? { step: pick.table.h, levels: e.handle.levels } : null }
      : null,
  );
}

/**
 * Pick a place on the model for a cut: for "+ Removable part" (`cutId`
 * null) a new cut across Z that comes apart – or, a click on a part that
 * comes off on its own (a lid inside a handle, a base), that part – otherwise
 * the cut `cutId` along its own axis, or a part's cut moved to another part.
 * A plane follows the pointer, snapping to the model's seams, the spots
 * suggested and where a full lip fits; over a part, the part lights up
 * instead. A click puts the cut there. The same button again, Escape, or
 * anything else taken up stops it.
 */
function startAim(cutId = null) {
  if (aiming && aiming.cutId === cutId) return endAim(); // the button pressed again
  const cut = cutId ? doc.split?.cuts.find((c) => c.id === cutId) : null;
  const axis = cutId ? cutPlane(cut)?.axis : 2;
  if (axis == null || !modelInfo?.hasModel || !canSplit()) return;
  if (!cutId && !roomForCut(axis)) return setStatus(`A split can have up to ${SPLIT_LIMITS.cuts} cuts and ${SPLIT_LIMITS.cells} pieces.`, 'error');
  endAim();
  // the model as it is, where the pointer lands on it, and no item to move instead
  if ($('resultToggle').checked) {
    $('resultToggle').checked = false;
    showResult(false);
  }
  if (doc.selected) doc.select(null);
  if (!cutId && selectedCutId) selectCut(null); // a new part: a spot clicked meanwhile adds one too, rather than move this
  aiming = { cutId, axis };
  // a cut that comes apart snaps to the seams, the spots and where a full lip fits; a glued one to none of them; a
  // part's own cut goes only to a part, with no plane to follow the pointer
  const part = !!cut?.part;
  const snaps = !part && !!holdOf(cutId);
  viewer.setAim({ axis, snap: snaps, plane: !part });
  // the parts that come off on their own (a lid inside a handle, a base) first – the card, and what a click picks –
  // then the seams a plane snaps to, and for a new cut the places to cut across: the engine answers them in turn
  if (!cutId || part) findPartsCard();
  if (snaps) loadTargets(axis);
  if (!cutId) suggestSpots({ axis, hold: 'lock' });
  showAimHint();
  renderSplit();
}

/** Stop placing a cut on the model. */
function endAim() {
  if (!aiming) return;
  aiming = null;
  aimAt = null;
  clearTimeout(probeTimer);
  viewer.setPartHover(null);
  viewer.setAim(null);
  $('cutReadout').hidden = true;
  if ($('status').textContent === aimHintShown) setStatus('');
  aimHintShown = '';
  dropLipTarget();
  renderSplit();
}

/** Where the place tried last gets a full lip is a target only while that cut is placed or dragged: it goes with it. */
function dropLipTarget() {
  if (!lipTarget) return;
  lipTarget = null;
  pushTargets();
}

/**
 * Put the cut being placed at `at`: the cut moved there, or a new one that
 * comes apart added there, as one undo step; it is selected and measured.
 * Placing stops unless `keep` (Shift+click places more). Where another cut
 * across the axis already is – a click near one snaps onto it – nothing is
 * placed, and the page says so.
 */
function placeAimed(at, { keep = false, point = null, free = false } = {}) {
  const a = aiming;
  if (!a || !Number.isFinite(at)) return;
  // on a part that comes off: that part (a finger's pinned plane has no point of its own: the one it showed)
  const pick = point ? partPicked(point, free) : aimAt?.pick ?? null;
  if (pick && takesOut(pick.part)) return takePart(pick, { keep });
  const part = partAim();
  if (part) return setStatus(`No part comes off there – click one to move cut ${cutLetter(part.id)} to it.`, 'error');
  const here = cutHere(a.axis, at, a.cutId);
  if (here) return setStatus(`Cut ${cutLetter(here.id)} is already at ${round(at, 1)} mm – a cut there would do nothing.`, 'error');
  if (!keep) endAim();
  if (a.cutId) {
    moveCut(a.cutId, at);
    selectCut(a.cutId);
    return;
  }
  if (!roomForCut(a.axis)) {
    endAim();
    return setStatus(`A split can have up to ${SPLIT_LIMITS.cuts} cuts and ${SPLIT_LIMITS.cells} pieces.`, 'error');
  }
  selectCut(doc.addCut({ ...cutAcross(a.axis, at), joint: 'apart' }, { defaults: splitDefaults }));
}

viewer.onAim = (h) => {
  if (!aiming) return;
  if (h.at == null) {
    aimAt = null;
    clearTimeout(probeTimer);
    showPartHover(null);
    $('cutReadout').hidden = true;
    return;
  }
  // over a part that comes off, the part lights up and the readout says what it gets; elsewhere the plane is tried
  const found = partPicked(h.point, h.free);
  const pick = found && takesOut(found.part) ? found : null;
  showPartHover(pick);
  const plane = !pick && !partAim();
  const moved = aimAt?.at !== h.at || !!aimAt?.pick !== !!pick;
  const hold = plane ? holdOf(aiming.cutId) : null;
  aimAt = {
    axis: aiming.axis, at: h.at, target: h.target, screen: h.screen, pinned: !!h.pinned, hold, cutId: aiming.cutId, key: hold ? probeKey(aiming.axis, h.at, hold) : null,
    pick, point: h.point, free: !!h.free, base: found && !pick ? partReadout(found, found.table) : null,
  };
  if (!plane) clearTimeout(probeTimer);
  else if (moved || h.pinned) probeAim();
  showAimReadout();
};

/**
 * The place a cut is being placed at, asked about again where what its lip
 * depends on changed under it – the cut's hold, the clearance, the nozzle,
 * the model or its text – with the pointer still or the plane pinned by a
 * finger, which nothing moves until the model is touched again: the readout
 * and the section say what the cut would get now.
 */
function refreshAim() {
  const a = aimAt;
  if (!aiming || !a || a.drag || a.pick || partAim()) return;
  const hold = holdOf(aiming.cutId);
  const key = hold ? probeKey(a.axis, a.at, hold) : null;
  if (hold === a.hold && key === a.key) return;
  aimAt = { ...a, hold, key };
  probeAim();
  showAimReadout();
}

viewer.onAimPick = ({ at, shift, point, free }) => placeAimed(at, { keep: shift, point, free });

/** A part as the finder places it: its circle round the centre, on its face, the finder's own pick. */
const partPlaced = (entry) => ({ position: [entry.centre[0], entry.centre[1], entry.face], part: { r: entry.r, side: entry.side, auto: true } });

/**
 * A part clicked while placing: taken out as the finder places it, as one undo step, and selected – a new cut, or the
 * part's own cut moved to it. A part another cut takes out already selects that cut. Placing stops unless `keep`
 * (Shift+click picks more).
 */
function takePart(pick, { keep = false } = {}) {
  const a = aiming;
  if (!a) return;
  const entry = pick.part;
  const taken = partCutFor(entry, pick.table);
  if (taken && taken.id !== a.cutId) {
    if (!keep) endAim();
    selectCut(taken.id);
    setStatus(`Cut ${cutLetter(taken.id)} takes the ${entry.name.toLowerCase()} out already.`);
    return;
  }
  if (!keep) endAim();
  if (a.cutId) {
    doc.updateCut(a.cutId, partPlaced(entry));
    selectCut(a.cutId);
    return;
  }
  if (!roomForAnyCut()) {
    endAim();
    return setStatus(`A split can have up to ${SPLIT_LIMITS.cuts} cuts and ${SPLIT_LIMITS.cells} pieces.`, 'error');
  }
  selectCut(doc.addCut({ ...partPlaced(entry), normal: [0, 0, 1], joint: 'apart', hold: 'lock' }, { defaults: splitDefaults }));
}

/**
 * "Suggest spots": the engine's best places along an axis for a cut that
 * comes apart – the selected one's axis and hold, else Z and Locks – listed
 * in the card. Asked for on demand (here, ticking a cut's Comes apart and
 * "+ Removable part"), never on an edit: on a dense model they take seconds.
 */
async function suggestSpots({ axis = null, hold = null, again = false } = {}) {
  if (!booted || halted || !modelInfo?.hasModel || !canSplit()) return;
  const sel = selectedApartCut();
  axis ??= sel ? cutPlane(sel).axis : 2;
  hold ??= sel?.hold ?? 'lock';
  const base = aimKey();
  const key = `${base}|${axis}|${hold}`;
  if (spots?.key === key && !spots.failed && !again) return renderSpots();
  // asked again (see onBasis), the spots found stay listed meanwhile, and nothing says they are looked for
  const kept = again && spots?.key === key ? spots.list : null;
  spots = { base, key, axis, hold, busy: true, list: kept, failed: null, quiet: !!kept };
  renderSpots();
  try {
    if (!(await syncBase())) {
      if (spots?.key === key) spots = null;
      return;
    }
    const r = await client.cutSpots(doc.items, version(), { axis: AXES[axis], hold, printing, split: aimSplit() });
    if (!r || spots?.key !== key) return; // asked again since, for another axis, hold or model
    spots.list = r.spots;
    spots.estimate = !!r.estimate;
  } catch (err) {
    if (spots?.key === key) spots.failed = friendly(err);
  } finally {
    if (spots?.key === key) spots.busy = false;
    renderSpots();
    pushTargets();
  }
  if (spots?.key === key && spots.list) onBasis({ estimate: spots.estimate });
}

/**
 * Put the selected cut that comes apart at a spot suggested, or a new one
 * there, as one undo step – along its own axis only, as the list is asked
 * for again when the cut turns. A spot another cut already takes selects
 * that cut instead, and a glued one there comes apart.
 */
function applySpot(spot, hold) {
  const axis = AXES.indexOf(spot.axis);
  const sel = selectedApartCut();
  viewer.previewAim(null);
  endAim();
  const here = cutHere(axis, spot.at, sel?.id);
  if (here) {
    selectCut(here.id);
    if (here.joint === 'apart') return setStatus(`Cut ${cutLetter(here.id)} is already there.`);
    // a glued cut there: it comes apart now, as the list offers, holding as the spots were found for
    doc.setCutJoint(here.id, { hold });
    return setStatus(`Cut ${cutLetter(here.id)} is there: it comes apart now.`);
  }
  if (sel) {
    if (cutPlane(sel).axis === axis) doc.updateCut(sel.id, cutAcross(axis, spot.at));
    return;
  }
  if (!roomForCut(axis)) return setStatus(`A split can have up to ${SPLIT_LIMITS.cuts} cuts and ${SPLIT_LIMITS.cells} pieces.`, 'error');
  selectCut(doc.addCut({ ...cutAcross(axis, spot.at), joint: 'apart', hold }, { defaults: splitDefaults }));
}

let spotsSignature = '';
/**
 * The spots suggested, in the card: a button for each ("Z 190.5 mm – top
 * 100.5 mm comes off · locks with 4 clips · under a ledge where the shape
 * widens", and the letters it runs through or the cut already there) that
 * shows its plane in the view while hovered, or what is happening instead.
 * Dropped once the model, its text or the settings they were found for
 * change; asked for again when the selected cut that comes apart is on
 * another axis or holds another way than they were found for. A spot button
 * that had the keyboard's focus keeps it, or hands it to the next.
 */
function renderSpots() {
  const usable = !!modelInfo?.hasModel && canSplit();
  $('spotsRow').hidden = !usable;
  if (spots && (!usable || spots.base !== aimKey())) {
    spots = null;
    pushTargets();
  }
  const sel = selectedApartCut();
  if (spots && sel && (cutPlane(sel).axis !== spots.axis || (sel.hold ?? 'lock') !== spots.hold)) {
    // listed for another axis or hold: a click on one would give the cut a joint the list never found
    spots = null;
    pushTargets();
    suggestSpots();
    if (spots) return; // the new list, being looked for, is in the card already
  }
  // never disabled while it looks: a button pressed from the keyboard would lose the focus (and a press again waits)
  const ask = $('suggestSpotsBtn');
  ask.disabled = !usable;
  ask.setAttribute('aria-disabled', String(!!spots?.busy));
  const note = $('spotsNote');
  const list = $('spotList');
  const found = spots?.list?.length ? spots.list : null;
  // the parts listed above it are what comes off where no cut across the whole model does well – those the card
  // offers something for: a base no lock fits at any size is listed with nothing to press
  const table = currentTable();
  const parts = !!table?.parts.some((e) => partOffered(e, table));
  const text = !spots
    ? ''
    : spots.busy && !spots.quiet
      ? 'Looking for good spots…'
      : spots.failed
        ? spots.failed
        : !found
          ? parts
            ? `No good place for a cut across the whole model – use a part above, or ${aiming ? 'click the model where it should come apart.' : 'pick a place on the model yourself:'}`
            : aiming
              ? 'No good spot found – click the model where it should come apart.'
              : 'No good spot found – pick one on the model yourself:'
          : sel
            ? `Best first – click one to move cut ${cutLetter(sel.id)} there.`
            : 'Best first – click one to add a cut that comes apart there.';
  const hold = spots?.hold;
  // where a lid inside a lantern's handle comes off on its own, a spot whose top would take the handle with it says so
  const handles = table?.parts.some((e) => e.kind === 'lid' && e.handle && !e.takesHandle) ? table.handles : [];
  const labels = (found ?? []).map((spot) => {
    const taken = cutHere(AXES.indexOf(spot.axis), spot.at);
    return spotLabel(spot, hold, { through: namesOf(spot.crosses), taken: taken ? cutLetter(taken.id) : null, handles });
  });
  const signature = JSON.stringify([text, !aiming && spots && !spots.busy && !found, found, hold, labels]);
  if (signature === spotsSignature) return;
  spotsSignature = signature;
  note.replaceChildren(text);
  note.hidden = !text;
  note.classList.toggle('busy', !!spots?.busy && !spots.quiet);
  if (spots && !spots.busy && !spots.failed && !found && !aiming) {
    // nothing to suggest: the model is where to say, so offer to pick there (a click on it would otherwise place text)
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'btn small';
    pick.textContent = 'Place on model';
    pick.title = 'Click the model where it should come apart';
    pick.addEventListener('click', () => startAim(selectedApartCut()?.id ?? null));
    note.append(' ', pick);
  }
  viewer.previewAim(null);
  const focused = [...list.querySelectorAll('.spot')].indexOf(document.activeElement);
  list.replaceChildren(
    ...(found ?? []).map((spot, k) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'spot';
      // where it is first, in bold, so the list reads down the places
      const label = labels[k];
      const cut = label.indexOf(' – ');
      const where = document.createElement('b');
      where.textContent = label.slice(0, cut);
      button.append(where, label.slice(cut));
      const show = () => viewer.previewAim({ axis: AXES.indexOf(spot.axis), at: spot.at, verdict: lipVerdict({ lip: spot.lip }, hold) });
      const hide = () => viewer.previewAim(null);
      button.addEventListener('pointerenter', (e) => e.pointerType !== 'touch' && show());
      button.addEventListener('pointerleave', hide);
      button.addEventListener('focus', () => button.matches(':focus-visible') && show());
      button.addEventListener('blur', hide);
      button.addEventListener('click', () => applySpot(spot, hold));
      li.append(button);
      return li;
    }),
  );
  if (focused >= 0) {
    const buttons = list.querySelectorAll('.spot');
    (buttons[Math.min(focused, buttons.length - 1)] ?? ask).focus();
  }
}

/* ------------------------------------------------- parts that come off */

let partsCard = null; // { key, loads, version, busy, table, failed } the parts that come off, listed once asked for
let partsAsk = null; // { key, promise } the parts table being asked for: the card and the refit after a Scale share it
let partsSignature = '';
let frameAfter = null; // the model's version [Make it N %] made: the view is framed on it once it is in

/** The model's size against the one loaded (the cube root of its transforms' scale), as the parts table's `scale`. */
const modelScale = () => +Math.cbrt(Math.abs((doc.base?.transforms ?? []).reduce((acc, t) => new Matrix4().fromArray(t).multiply(acc), new Matrix4()).determinant())).toFixed(6);

/** What the parts table depends on: the model as it is (the text on it hardly moves a part), the clearance and the printer. */
const partsKey = () => stableKey({ version: version(), clearance: aimSplit().clearance, nozzle: printing.nozzle, layers: printing.layerHeight });

/** The parts table for the model as it is now, asked for once by whoever wants it first; null when it can't be had now. */
function askPartsTable() {
  const key = partsKey();
  if (partsAsk?.key === key) return partsAsk.promise;
  const ask = { key, promise: null };
  ask.promise = (async () => {
    if (!(await syncBase()) || partsKey() !== key) return null;
    return (await client.parts(doc.items, version(), { printing, split: aimSplit() })) ?? null;
  })();
  partsAsk = ask;
  // an answer that never came is asked for again next time
  const forget = () => partsAsk === ask && (partsAsk = null);
  ask.promise.then((table) => !table && forget(), forget);
  return ask.promise;
}

/**
 * The table's entry for a part taken out (a cut with a circle across Z, lying up): the same kind round the same
 * centre, its face within the family's – the finder's lid wherever its face was moved to, or the base.
 */
function entryIn(table, cut) {
  const plane = cutPlane(cut);
  if (!table || !cut?.part || plane?.axis !== 2 || !(cut.normal[2] > 0) || cut.part.side !== 1) return null;
  const [x, y] = cut.position;
  const near = (e) => Math.hypot(e.centre[0] - x, e.centre[1] - y) <= 0.05 * table.width;
  return table.parts.find((e) => near(e) && (e.kind === 'plug' ? Math.abs(plane.at - e.face) <= table.h : plane.at >= e.from - 2 * table.h && plane.at <= e.cap)) ?? null;
}

/** The card's table while it is for the model and the settings as they are now, else null. */
const currentTable = () => (partsCard?.table && partsCard.key === partsKey() && partsCard.loads === loads ? partsCard.table : null);

/**
 * What a part's row says of it: from the pieces once they are worked out for the split as it is, else from the card's
 * table – its name and kind, the lock it gets (the table's while the part's face is the finder's), whether
 * none fits at this size and from what size one does, whether a handle stays on, and the note that moved or refused it.
 */
function partInfo(cut, letter) {
  const current = piecesCurrent();
  const seam = current ? lastPieces.seams.find((s) => s.joint === 'part' && s.cutId === cut.id) : null;
  // what the split said of it, once the pieces are worked out; until then, what trying its face where it was put said
  const tried = partChecks.get(cut.id);
  const note = current
    ? lastPieces.notes.find((n) => PART_REFUSALS.has(n.code) && (n.code === 'PART_CROSSED' ? n.partId : n.cutId) === cut.id) ?? null
    : tried && tried.step === doc.history.at(-1) && tried.at === cutPlane(cut)?.at ? tried.note : null;
  const table = currentTable();
  const entry = entryIn(table, cut);
  // a lid's lock is sized on its outside over its face and carried by the wall under it, whatever the circle's width
  // in its band: at the finder's face it is the table's; a base's lock is its circle's own
  const exact = !!entry && Math.abs(cutPlane(cut).at - entry.face) < 1e-6 && (entry.kind !== 'plug' || Math.abs(cut.part.r - entry.r) < 1e-6);
  const lock = seam ? (seam.apart.mech ? seam.apart : null) : exact ? entry.lock : null;
  // asked to lock and none is built: the pieces say so, or the table does for the part's family wherever its face is.
  // At this size none fits – unless the lock was left off because it would have left the part in pieces
  const lockless = seam ? !seam.apart.mech && seam.apart.hold === 'lock' : !!entry && !entry.lock;
  const pieces = lockless && seam?.apart.why === 'pieces';
  return {
    name: seam?.part.name ?? entry?.name ?? `Part ${letter}`,
    kind: seam?.part.kind ?? entry?.kind ?? 'lid',
    lock,
    small: lockless && !pieces,
    least: seam ? seam.apart.small?.lock ?? null : entry && !entry.lock ? percentOf(entry.least?.lock, table.scale) : null,
    handle: seam ? !!seam.part.handle : !!entry?.handle && !entry.takesHandle,
    note,
    known: lockless,
    why: seam?.apart.why ?? null,
  };
}

/**
 * "Parts that come off": the engine's parts table – a lid inside a handle, a base from underneath, each with the
 * twist-lock it gets at this size or the least size one needs – listed in the card, asked for by "+ Removable part"
 * and "Suggest spots", and again while it is listed once the model is scaled or the printer changed. Seconds on a
 * dense model the first time; at once after that.
 */
async function findPartsCard() {
  if (!booted || halted || !modelInfo?.hasModel || !canSplit()) return;
  const key = partsKey();
  if (partsCard?.key === key && partsCard.loads === loads && (partsCard.busy || partsCard.table)) return renderPartsCard();
  const card = { key, loads, version: version(), busy: true, table: null, failed: null };
  partsCard = card;
  renderPartsCard();
  try {
    card.table = await askPartsTable();
  } catch (err) {
    card.failed = friendly(err);
  } finally {
    card.busy = false;
    // not had for the model as it was asked for: asked again for the model as it is now, or on the next press
    if (partsCard === card && !card.table && !card.failed) partsCard = partsKey() === key ? null : card;
    if (partsCard === card || !partsCard) {
      renderPartsCard();
      renderCuts();
      renderSpots();
      // placing meanwhile: the parts now light up under the pointer, and the page says a click takes one out
      if (aiming && $('status').textContent === aimHintShown) showAimHint();
    }
  }
}

let relisting = false;
/** The card listed again for the model and the printer as they are now, once the engine is idle. */
function relistParts() {
  if (relisting) return;
  relisting = true;
  whenIdle(() => {
    relisting = false;
    if (partsCard && !partsCard.busy && partsCard.key !== partsKey()) findPartsCard();
  });
}

/** The part cut already taking out this entry's part, if any. */
const partCutFor = (entry, table) => (doc.split?.cuts ?? []).find((c) => c.part && entryIn(table, c) === entry) ?? null;

/**
 * [Use]: the part taken out as the finder found it, as one undo step, and selected: a cut across Z with its circle,
 * the finder's pick (`auto`), so a Scale places it again for the new size. It holds by its twist-lock – also where none
 * fits at this size ("Use – it just lifts off"): it lifts off until the model is big enough, then locks with no other
 * click.
 */
function usePart(entry) {
  endAim();
  if (!roomForAnyCut()) return setStatus(`A split can have up to ${SPLIT_LIMITS.cuts} cuts and ${SPLIT_LIMITS.cells} pieces.`, 'error');
  selectCut(doc.addCut({ ...partPlaced(entry), normal: [0, 0, 1], joint: 'apart', hold: 'lock' }, { defaults: splitDefaults }));
}

/**
 * [Make it N %]: the model scaled to N % of its size as loaded, and the parts still where the finder put them placed
 * again for the new size, as one undo step; the card lists the parts at that size. What was on screen stays: the
 * pieces are shown again at the new size once their parts are placed for it, and a part being picked on the model goes
 * on being picked, among the parts at that size.
 */
async function makeIt(percent, scale = currentTable()?.scale) {
  if (!doc.base || !(scale > 0)) return;
  const f = percent / 100 / scale;
  if (Math.abs(f - 1) < 1e-9) return;
  const pieces = $('resultToggle').checked && splitActive(doc.split);
  if (aiming) {
    // what the pointer was over is a part of the model at its old size
    aimAt = null;
    viewer.setPartHover(null);
    $('cutReadout').hidden = true;
  }
  const step = doc.transformBase(new Matrix4().makeScale(f, f, f));
  const made = version();
  frameAfter = made;
  undoToast(`Scaled the model to ${percent} %.`);
  await refitParts(step);
  if (pieces && version() === made && !$('resultToggle').checked && splitActive(doc.split)) {
    $('resultToggle').checked = true;
    showResult(true);
  }
}

/**
 * After a Scale (or [Make it N %]), the parts still where the finder put them are placed by it again for the new
 * size: scaled with the model, a face lands off the printer's layers and away from the best face there. It joins the
 * Scale's undo step while that is still the last edit (`Document.refitParts`), and does nothing once the model has
 * moved on.
 */
async function refitParts(step) {
  if (!(doc.split?.cuts ?? []).some((c) => c.part?.auto)) return;
  const base = modelPlacementKey(doc.base);
  let table;
  try {
    table = await askPartsTable();
  } catch {
    return; // the parts stay as they were scaled; the split says what they get
  }
  if (!table || modelPlacementKey(doc.base) !== base) return;
  const fits = [];
  for (const c of doc.split?.cuts ?? []) {
    const e = c.part?.auto ? entryIn(table, c) : null;
    if (e) fits.push({ id: c.id, position: [e.centre[0], e.centre[1], e.face], part: { r: e.r, side: e.side } });
  }
  if (fits.length) doc.refitParts(fits, { base, step });
}

/* ------------------------------------------------- a part's face and width */

const partChecks = new Map(); // cutId -> { at, note, step } what trying a part's face where it was put said: its row says so until the next edit
const partTries = new Map(); // a part's face tried (`partTryKey`) -> the engine's answer: where it goes, the free bands round it
let partDrag = null; // { id, r, band } while a part's ring handle is dragged: the circle is drawn at `r`, the cut changed when dropped
let partTyped = null; // { id, at?, r? } while a part's Z or Ø is typed: the circle is drawn there, the cut changed once the box is left

/** A cut that takes out a part, by its id. */
const partCut = (id) => doc.split?.cuts.find((c) => c.id === id && c.part) ?? null;

/** The layers a part across Z prints on: those of the piece it comes out of, from the model's bottom or the cut under it. */
function partLayers(cut) {
  const at = cutPlane(cut)?.at ?? 0;
  const zmin = currentTable()?.zmin ?? cutBounds()?.min[2] ?? 0;
  const under = planeCuts().map((c) => cutPlane(c)).filter((p) => p?.axis === 2 && p.at < at - 1e-6).map((p) => p.at);
  return { from: Math.max(zmin, ...under), hl: printing.layerHeight ?? 0.2 };
}

const partTryKey = (cut, at) => `${partsKey()}|${aimSplit().clearance}|${cut.position[0]},${cut.position[1]}|${at}|${cut.part.r}`;

/** The engine's answer for a part's face tried at `at` (mode 'part'): kept, so a face tried again answers at once. */
async function tryPartAt(cut, at) {
  const key = partTryKey(cut, at);
  if (partTries.has(key)) return partTries.get(key);
  if (!(await syncBase())) return null;
  const r = await client.partAt(doc.items, version(), { centre: cut.position.slice(0, 2), at, r: cut.part.r, printing, split: aimSplit() });
  if (!r) return null;
  partTries.set(key, r);
  while (partTries.size > 32) partTries.delete(partTries.keys().next().value);
  return r;
}

/**
 * A part's face typed in or nudged, settled: on the printer's layers (`partFace`), then tried where the split will put
 * it – moved a layer or two up where it would not print apart from what stands beside it, or to the nearest face that
 * does – in the same undo step as the edit. The page and the part's row say why it moved (PART_GAP's words), or that
 * it can't go there.
 */
async function settlePartFace(id) {
  const key = `split:at:${id}`;
  const cut = partCut(id);
  const plane = cutPlane(cut);
  if (!plane || plane.axis !== 2 || cut.part.side !== 1) return doc.endCoalescing();
  const at = partFace(plane.at, partLayers(cut));
  if (at !== plane.at) moveCut(id, at, { coalesce: key });
  let check = null;
  try {
    check = await tryPartAt(partCut(id), at);
  } catch {
    // the split says what the face gets
  }
  const now = partCut(id);
  // moved again meanwhile: that move is settled in its turn
  if (!check || !now || cutPlane(now)?.at !== at) return doc.endCoalescing();
  const letter = cutLetter(id);
  const entry = entryIn(currentTable(), now);
  const name = entry?.name ?? partInfo(now, letter).name;
  let note = null;
  let to = null;
  if (check.why === 'mixed') note = splitNote('PART_MIXED', { letter, cutId: id });
  else if (check.why === 'empty') note = splitNote('CUT_MISSES', { letter, cutId: id });
  else if (!check.ok || check.z0 !== check.asked) {
    to = check.ok ? check.z0 : Number.isFinite(check.nearest) ? check.nearest : null;
    note = splitNote('PART_GAP', {
      letter, cutId: id, name, axis: 2, z: check.asked, gap: check.tried?.gap ?? 0, need: check.gmin, islands: check.tried?.islands ?? 0,
      by: entry?.handle ? "the handle's feet" : 'the model beside it', ...(to != null ? { movedTo: to } : {}),
    });
  }
  if (to != null) moveCut(id, to, { coalesce: key });
  doc.endCoalescing();
  if (note) {
    // said until anything else is done: undone, the face it moved from is the one that is there
    partChecks.set(id, { at: to ?? at, note, step: doc.history.at(-1) });
    setStatus(note.text, to != null ? '' : 'error');
  } else partChecks.delete(id);
  renderSplit();
  // the box typed in still has the focus, which keeps what was typed: it shows where the face went
  const box = document.querySelector(`[data-part-z="${CSS.escape(id)}"]`);
  if (box) box.value = roundZ(cutPlane(partCut(id))?.at ?? at);
}

/**
 * The free band a part's circle is kept in at its face (`{ lo, hi, gmin }`, radii): the parts table's where the part's
 * face is the finder's, else the engine's for the face as it is. None for a base, whose width its lock decides.
 */
async function partBand(cut) {
  const plane = cutPlane(cut);
  if (plane?.axis !== 2) return null;
  const entry = entryIn(currentTable(), cut);
  if (entry?.kind === 'plug') return null;
  const gmin = gminOf(aimSplit().clearance);
  if (entry && Math.abs(plane.at - entry.face) < 1e-6) return { lo: entry.window[0], hi: entry.window[1], gmin, mid: entry.r };
  let check = null;
  try {
    check = await tryPartAt(cut, plane.at);
  } catch {
    return null;
  }
  const band = bandOf(check?.windows, cut.part.r);
  return band ? { ...band, gmin: check.gmin } : null;
}

/**
 * A part's width typed in, settled: kept in the free band round it at its face, onto the band's middle from within
 * `tol` (mm of radius) – the finder's own width – and the page says so where an edge of the band held it back.
 */
async function settlePartWidth(id, { tol = 0 } = {}) {
  const cut = partCut(id);
  if (!cut) return doc.endCoalescing();
  const band = await partBand(cut);
  const now = partCut(id);
  // changed again meanwhile: that change is settled in its turn
  if (!band || !now || now.part.r !== cut.part.r || cutPlane(now)?.at !== cutPlane(cut)?.at) return doc.endCoalescing();
  const { r, edge } = partWidth(now.part.r, { ...band, tol });
  if (r !== now.part.r) doc.updateCut(id, { part: { r: +r.toFixed(4), ...finderPick(now, r) } }, { coalesce: `split:d:${id}` });
  doc.endCoalescing();
  if (edge) setStatus(`${widthWords(2 * r, edge)}.`);
  const box = document.querySelector(`[data-part-d="${CSS.escape(id)}"]`);
  if (box) box.value = round(2 * r, 1);
}

// a part's ring handle dragged: the circle follows the pointer on the model – kept in its free band and pulled onto
// the band's middle from a few pixels away – and the cut changes, as one undo step, when it is dropped
viewer.onPartDrag = ({ id, r, pxPerMm, done, cancelled }) => {
  const cut = partCut(id);
  if (!cut) return;
  if (!done) {
    if (partDrag?.id !== id) {
      const drag = { id, r: cut.part.r, band: null };
      partDrag = drag;
      partBand(cut).then((band) => (drag.band = band), () => {});
    }
    const fit = partDrag.band ? partWidth(r, { ...partDrag.band, tol: snapTolerance(pxPerMm) }) : { r, edge: null };
    partDrag.r = fit.r;
    partDrag.edge = fit.edge;
    const box = document.querySelector(`[data-part-d="${CSS.escape(id)}"]`);
    if (box && box !== document.activeElement) box.value = round(2 * fit.r, 1);
    drawParts();
    return;
  }
  const drag = partDrag;
  partDrag = null;
  if (!cancelled && drag) {
    // let go where its Ø reads as it did (a press, or held back at the edge it was at) it is no edit, and a part the
    // finder placed stays its pick
    if (round(2 * drag.r, 1) !== round(2 * cut.part.r, 1) || finderPick(cut, drag.r).auto) doc.updateCut(id, { part: { r: +drag.r.toFixed(4), ...finderPick(cut, drag.r) } });
    if (drag.edge) setStatus(`${widthWords(2 * drag.r, drag.edge)}.`);
  }
  renderSplit();
};

/**
 * A part's width put back on the finder's own (the middle of its band, at its face): the finder's pick again (`auto`),
 * so a Scale places it again for the new size.
 */
function finderPick(cut, r) {
  const entry = entryIn(currentTable(), cut);
  const at = cutPlane(cut)?.at;
  return entry && Math.abs(r - entry.r) < 1e-6 && Math.abs(at - entry.face) < 1e-6 ? { auto: true } : {};
}

/**
 * The card's list: for each part, what it is and the lock it gets, or why none fits and from what size one does,
 * with [Use], [Make it N %] and [Use – it just lifts off]; a part already taken out offers its cut in place of [Use].
 * Or what is happening (looking), or why there is none (solid all through, open already).
 */
function renderPartsCard() {
  const usable = !!modelInfo?.hasModel && canSplit();
  if (partsCard && (!usable || partsCard.loads !== loads)) partsCard = null;
  // listed, and the model or the printer changed since: listed again where the card is still wanted – the model
  // scaled (the card offers sizes), the clearance or the printer changed, a part taken out or being picked reads it –
  // once the engine has done what the edit itself asked for (its previews first); else put away until asked for
  // again: turning or moving the model changes no part, and the table takes seconds on a dense model
  if (partsCard && !partsCard.busy && partsCard.key !== partsKey()) {
    const resized = !!partsCard.table && Math.abs(partsCard.table.scale - modelScale()) > 1e-6;
    const wanted = partsCard.version === version() || resized || !!aiming || takenOut() > 0;
    if (!wanted) partsCard = null;
    else {
      // while a part is picked on the model it is the parts that light up under the pointer: asked for at once, ahead
      // of the seams the plane snaps to
      if (aiming) findPartsCard();
      else relistParts();
      return;
    }
  }
  const box = $('partsCard');
  box.hidden = !partsCard;
  const card = partsCard;
  const table = card?.table ?? null;
  const note = !card ? '' : card.busy ? 'Finding the parts that come off…' : card.failed ?? (table ? partsNote(table, { aiming: !!aiming }) ?? '' : '');
  const entries = table?.parts ?? [];
  // a number keeps its unit on its line: "275 %", "Ø 44 mm"
  const keep = (text) => text.replace(/(\d|Ø) (?=%|mm\b|\d)/g, '$1\u00a0');
  const words = entries.map((e) => {
    const w = partCard(e, table);
    return { ...w, title: keep(w.title), detail: keep(w.detail) };
  });
  const taken = entries.map((e) => cutLetter(partCutFor(e, table)?.id));
  const signature = JSON.stringify([!!card, note, words, taken, table?.zmax, table?.zmin]);
  if (signature === partsSignature) return;
  partsSignature = signature;
  const p = $('partsNote');
  p.textContent = note;
  p.hidden = !note;
  p.classList.toggle('busy', !!card?.busy);
  $('partList').replaceChildren(
    ...entries.map((entry, k) => {
      const w = words[k];
      const li = document.createElement('li');
      li.className = `part-offer ${w.lock ? 'locks' : 'small'}`;
      const title = document.createElement('div');
      title.className = 'part-title';
      const name = document.createElement('b');
      name.textContent = w.name;
      title.append(name, w.title.slice(w.name.length));
      li.append(title);
      if (w.detail) {
        const detail = document.createElement('div');
        detail.className = 'part-detail';
        detail.textContent = w.detail;
        li.append(detail);
      }
      const actions = document.createElement('div');
      actions.className = 'part-actions';
      if (w.badge) {
        const badge = document.createElement('span');
        badge.className = 'part-badge';
        badge.textContent = w.badge;
        actions.append(badge);
      }
      const button = (label, run, { accent = false, title: hint = '' } = {}) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn small${accent ? ' accent' : ''}`;
        b.textContent = label;
        if (hint) b.title = hint;
        b.addEventListener('click', run);
        actions.append(b);
      };
      const letter = taken[k];
      // the sizes its lock (and a tea light through it) fits from, whether or not a cut takes it out already: made
      // bigger, the part taken out is placed again for that size and locks
      const tall = (n) => Math.round(((table.zmax - table.zmin) * n) / 100 / table.scale);
      for (const n of w.offers) button(`Make it ${n} %`, () => makeIt(n), { title: `Scale the model to ${n} % of its size as loaded: ${tall(n)} mm tall` });
      if (letter) button(`Cut ${letter} takes it out`, () => selectCut(partCutFor(entry, currentTable())?.id ?? null));
      else {
        if (w.use === 'lock') button('Use', () => usePart(entry), { accent: true, title: `Take the ${w.name.toLowerCase()} out with its twist-lock` });
        if (w.use === 'lift') button('Use – it just lifts off', () => usePart(entry), { title: 'Take it out with nothing holding it: it locks once the model is big enough' });
      }
      if (actions.childNodes.length) li.append(actions);
      return li;
    }),
  );
}

let offered = null; // the text of the toast that offers to split the model just loaded
/** Once for each model loaded: one bigger than the printer gets a toast that splits it. */
function offerSplit() {
  const note = bedTooSmall();
  if (!note) {
    if ($('toastText').textContent === offered) $('toast').hidden = true; // about the model before, which didn't fit
    return;
  }
  const [x, y] = bedSize(bed);
  offered = `This model won't fit your ${x} × ${y} mm bed.`;
  toast(offered, note.pieces > 1 && canSplit() ? { label: 'Split it', run: autoSplit } : null);
}

/**
 * A small print to try the joints before printing the pieces: the engine
 * works out the split as it stands, so the coupon has the pin or peg size
 * Auto picks and a dovetail when a cut gets one (whatever the Joints setting),
 * and where a cut comes apart on a lip, a small box and its lid with the same
 * lip, held as that cut is.
 */
async function downloadFitTest() {
  const active = activeSplit();
  const split = active ?? { ...SPLIT_DEFAULTS, ...splitDefaults, cuts: [] };
  const splitFor = lastSplitKey;
  const requestedFor = lastContentKey;
  setSplitPending(true);
  try {
    if (!(await syncBase())) return setStatus('The model is still being updated – try again in a moment.', '');
    const r = await client.fitTest(doc.items, version(), { printing, split, bed: usableBed(bed), name: exportName() });
    if (!r) return;
    // it worked the split out and found no pins (or no pegs, or no lip) in it: the cuts planned to have them have none
    // (nor tabs, with no file)
    const planned = (c) => measured?.cuts.get(c.id)?.joint;
    const none = active
      ? split.cuts.filter((c) => !r.stl || (planned(c) === 'dowels' && !r.pins) || (planned(c) === 'pegs' && !r.pegs) || (planned(c) === 'lip' && !r.apart && !r.twist))
      : [];
    if (none.length) {
      rememberJoints(splitFor, requestedFor, none.map((c) => [c.id, 'none']));
      renderCuts();
    }
    if (!r.stl) {
      // only parts taken out, none of them locking: each lifts off, and says from what size a twist-lock fits
      const planes = split.cuts.filter((c) => !c.part);
      if (!planes.length && split.cuts.length) {
        const parts = split.cuts.map((c) => {
          const info = partInfo(c, cutLetter(c.id));
          return { name: info.name, kind: info.kind, hold: c.hold, least: info.least, locks: c.hold === 'lock' && !!info.lock };
        });
        return setStatus(noFitTestWords(parts), '');
      }
      // cuts between the letters of a sign cross no material: nothing is joined, not even with glue (a part taken out
      // is never measured across: it is no cut between letters)
      const apart = planes.every((c) => measured?.cuts.get(c.id)?.islands === 0);
      const joints = split.joint === 'pegs' ? 'pegs' : 'pins';
      // a cut that comes apart is never glued: with no lip its pieces just rest on each other
      const lips = planes.filter((c) => c.joint === 'apart').length;
      const why = apart
        ? 'these cuts cross no material, so nothing is joined'
        : lips === planes.length
          ? 'these cuts get no lip or tabs, so the pieces just rest on each other'
          : lips
            ? `these cuts get no ${joints}, tabs or lip`
            : `these cuts get no ${joints} or tabs, only glue`;
      return setStatus(`Nothing to try: ${why}.`, '');
    }
    const file = save(r.stl, r.name);
    const own = split.pins === 'own';
    const checks = [];
    if (r.pins) {
      const d = `Ø${r.diameter} mm`;
      checks.push(`${r.diameter === FILAMENT ? 'a piece of filament slides' : own ? `your ${d} dowels slide` : `the ${d} pin slides`} into both holes`);
    }
    if (r.pegs) checks.push(`the ${r.pegSize} mm peg pushes into its socket`);
    if (r.dovetail) checks.push('the tab drops into its socket');
    // the box and lid of a cut that comes apart: clips that click (lightly), or none; a lock takes a firm pull, so it
    // is tried on its own
    const clicks = r.apart === 'snap' || r.apart === 'light';
    if (clicks) checks.push(`the lid clicks${r.apart === 'light' ? ' lightly' : ''} onto the box and pulls off again`);
    else if (r.apart && r.apart !== 'lock') checks.push('the lid drops onto the box and lifts off freely');
    // a twist-lock's two rings: they twist together and click, and hold when pulled
    const rings = r.twist
      ? ` Two rings Ø ${Math.round(r.twist.d)} mm with the twist-lock at this size (about ${r.twist.grams} g): they should twist together with a click and hold when pulled. Too tight to turn: raise the Clearance by 0.05 mm. Loose, or no click: lower it.`
      : '';
    const tried = checks.length
      ? ` Print it and check that ${checks.join(' and that ')} by hand – too tight: raise Clearance by 0.05 mm${clicks ? '; no click or too loose: lower it by 0.05 mm' : ''}.`
      : r.apart === 'lock' || !rings ? ' Print it:' : '';
    const lock = r.apart === 'lock'
      ? `${checks.length ? ' The lid' : ' the lid'} should lock onto the box and come off only with a firm pull – too stiff to open, raise the clearance by 0.05 mm; too loose, lower it.`
      : '';
    setStatus(`Downloaded ${file.name} (${file.kb} KB).${tried}${lock}${rings}`, 'ok');
  } catch (err) {
    setStatus(friendly(err), 'error');
  } finally {
    setSplitPending(false);
  }
}

/** The split card's controls and the printer's bed (wired like the enhancement: heavy, so applied on release). */
function bindSplit() {
  document.querySelectorAll('[data-split]').forEach((el) => {
    const key = el.dataset.split;
    el.addEventListener('change', () => {
      if (filling) return;
      if (el.type === 'radio' && !el.checked) return;
      const value = splitValue(el, key);
      if (value === null) return fillSplit(); // nonsense typed: show the value in force again
      setSplitSetting(key, value, el.type === 'number' ? { coalesce: `split:${key}` } : {});
    });
    if (el.type === 'number') {
      // the spinner's clicks on one box are one undo step; leaving the box ends it and shows the value kept
      el.addEventListener('blur', () => {
        doc.endCoalescing();
        fillSplit();
      });
    }
  });
  $('splitFitBtn').addEventListener('click', autoSplit);
  $('addCutBtn').addEventListener('click', addCut);
  $('addApartBtn').addEventListener('click', () => startAim(null));
  $('suggestSpotsBtn').addEventListener('click', () => {
    findPartsCard();
    suggestSpots();
  });
  $('splitClearBtn').addEventListener('click', () => {
    endAim();
    doc.setSplit(null);
    undoToast('Removed the split.');
  });
  $('splitFitTestBtn').addEventListener('click', downloadFitTest);
  $('showPiecesBtn').addEventListener('click', () => {
    endAim(); // as the Show pieces box does: the pieces are drawn pulled apart, away from where a click lands
    $('resultToggle').checked = true;
    showResult(true);
  });
  $('splitBedLink').addEventListener('click', (e) => {
    e.preventDefault();
    openPrinting();
  });
  $('spreadRange').addEventListener('input', () => {
    wayOn = false;
    viewer.stopWay();
    viewer.setSpread(Number.parseFloat($('spreadRange').value));
    syncWayCaption();
  });
  // the view moves the pieces itself while ▶ plays or the lock is looked at: the slider and the words follow
  viewer.onSpread = (f) => {
    $('spreadRange').value = String(f);
    syncWayCaption();
  };
  $('playWayBtn').addEventListener('click', (e) => playWays({ back: e.shiftKey }));
  // the pieces framed, looked at or played clear of what the page puts over the view: the legend and its tools along
  // the top, the lock's tools along the foot
  viewer.insets = () => {
    const panel = $('lockPanel');
    const bottom = panel.hidden ? 0 : $('stage').getBoundingClientRect().bottom - panel.getBoundingClientRect().top;
    return { top: controlsBottom(), bottom: Math.max(0, bottom) };
  };
  // the progress and the toast go up over the lock's tools, as tall as they are now (a caption comes and goes)
  new ResizeObserver(() => {
    const panel = $('lockPanel');
    $('stage').style.setProperty('--lock-room', panel.hidden ? '0px' : `${panel.offsetHeight + 8}px`);
  }).observe($('lockPanel'));
  $('lookLockBtn').addEventListener('click', lookAtLock);
  $('asPrintedToggle').addEventListener('change', () => {
    viewer.setAsPrinted($('asPrintedToggle').checked);
    syncSpread();
    viewer.frame();
  });

  const preset = $('bedPreset');
  preset.replaceChildren(...Object.entries(BED_PRESETS).map(([id, p]) => new Option(p.label, id)));
  const fillBed = () => {
    preset.value = bed.preset;
    bedSize(bed).forEach((v, a) => ($(['bedX', 'bedY', 'bedZ'][a]).value = v));
    $('bedMargin').value = bed.margin;
  };
  const bedChanged = () => {
    fillBed();
    saveSettings();
    render(); // the model's "too big" note, the card, the preview's red cells and the pieces follow the printer
  };
  fillBed();
  preset.addEventListener('change', () => {
    if (!BED_PRESETS[preset.value]) return;
    if (preset.value === 'custom') bed.size = bedSize(bed); // start from the printer chosen before
    bed.preset = preset.value;
    bedChanged();
  });
  ['bedX', 'bedY', 'bedZ'].forEach((id, a) =>
    $(id).addEventListener('change', () => {
      const v = Number.parseFloat($(id).value);
      if (!(v > 0)) return fillBed();
      if (v === bedSize(bed)[a]) return;
      // a printer of its own: the other sides stay as they were
      bed.size = bedSize(bed);
      bed.size[a] = Math.min(10000, v);
      bed.preset = 'custom';
      bedChanged();
    }),
  );
  $('bedMargin').addEventListener('change', () => {
    const v = Number.parseFloat($('bedMargin').value);
    if (!(v >= 0)) return fillBed();
    bed.margin = Math.min(20, v);
    bedChanged();
  });
}

/* ----------------------------------------------------------------- render */

/** The Part card's summary line: what the part is, and whether it is touching the model. */
/** Fit to surface has nothing to do for a part that leans on purpose: the control says so. */
function syncFitControl(item) {
  const box = document.querySelector('input[data-key="fit"]');
  if (!box) return;
  const turned = !!(item && isPart(item) && (item.tilt || item.roll));
  box.disabled = turned;
  box.closest('label')?.classList.toggle('muted', turned);
}

function renderPartHint(item) {
  syncFitControl(item);
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
    const removing = !!(spot && item?.remove);
    $('spotCard').classList.toggle('removing', removing);
    document.querySelectorAll('#spotCard .cleanup input').forEach((el) => (el.disabled = removing));
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
        meta.textContent = `${fmt(item.radius)} mm${item.remove ? ' · removes' : ''}`;
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
  // the pieces also depend on the split, the printer and the nozzle – none of which is content the previews depend on
  const splitKey = stableKey({ split: activeSplit(), bed: usableBed(bed), nozzle: printing.nozzle });
  const splitChanged = splitKey !== lastSplitKey;
  lastSplitKey = splitKey;
  // selecting an item lets go of the cut, and an undo can take the cut away
  if (sel || !doc.split?.cuts.some((c) => c.id === selectedCutId)) selectedCutId = null;
  // placing a cut stops when an item is taken up instead, the model goes, or the cut being placed is gone or turned
  if (aiming) {
    const placing = aiming.cutId ? doc.split?.cuts.find((c) => c.id === aiming.cutId) : null;
    if (sel || !modelInfo?.hasModel || (aiming.cutId && cutPlane(placing)?.axis !== aiming.axis)) endAim();
  }
  if (doc.split) rememberSplitSettings(doc.split);
  dropStaleToast();
  // undone, removed, moved or retyped: the summary of the pieces describes a split no longer in force (new pieces bring theirs)
  if (piecesStatus && (piecesStatus.key !== splitKey || piecesStatus.content !== contentKey)) dropPiecesStatus();

  renderItems();
  fillPanel(sel);
  fillEnhance();
  renderSelectedInfo();

  dropStaleDetails();
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
  $('findDetailsBtn').disabled = !modelInfo?.watertight;
  if (!modelInfo?.hasModel) $('detailsCard').hidden = true;
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
  if (modelInfo) renderModel(); // the "too big for your printer" note comes and goes with the cuts
  // new content takes the result down before the split card is drawn, so the card shows the boxes between the cuts again, not the old pieces
  if (contentChanged && $('resultToggle').checked && booted) {
    $('resultToggle').checked = false;
    clearTimeout(piecesTimer);
    viewer.showResult(false);
  }
  renderSplit();
  if (splitChanged && $('resultToggle').checked && booted) {
    requestPieces(); // moving a cut keeps the pieces view: the old pieces dim until the new ones arrive
  }
  if (booted && !halted) {
    syncBase().then((ok) => {
      if (ok) refreshPreviews(); // a superseded sync leaves the previews to the sync that follows it
    });
  }
  scheduleMeasure();
  scheduleOffer();
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
      // a clean-up spot's amounts, and anything about an item that consumes what it covers, re-derive the whole model:
      // apply them on release, not on every tick
      if (event.type === 'input' && continuous && ((isSpot(sel) && HEAVY_SPOT_KEYS.has(key)) || sel.cover)) return;
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
      // the parts the finder placed go on the new layers, and where they print apart with the new nozzle
      refitParts(null);
    });
  }

  document.querySelectorAll('[data-side]').forEach((btn) => btn.addEventListener('click', () => snapToSide(btn.dataset.side, { look: true })));
  $('snapBtn').addEventListener('click', snapToModel);
  $('findDetailsBtn').addEventListener('click', findDetails);
  $('findAgainBtn').addEventListener('click', findDetails);
  $('rebuildBtn').addEventListener('click', () => rebuildDetails().catch((err) => setStatus(friendly(err), 'error')));
  $('removeAllBtn').addEventListener('click', removeFoundDetails);
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
  bindSplit();
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
  $('resultToggle').addEventListener('change', (e) => {
    if (e.target.checked) endAim(); // the pieces are drawn pulled apart, away from where a click lands
    showResult(e.target.checked);
  });

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
    // a handle being dragged goes back where it was, as a cancelled drag does
    if (e.key === 'Escape' && viewer.cancelCutDrag()) return;
    if (e.key === 'Escape' && aiming) {
      endAim();
      return;
    }
    if (typing || mod) return;
    const step = (e.shiftKey ? 5 : 1) * Number.parseFloat($('nudgeStep').value);
    // a selected cut has the arrow keys, Delete and Escape; with an item selected they are the item's
    if (selectedCutId && !doc.selected) {
      const dir = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
      if (dir) {
        e.preventDefault();
        nudgeCut(selectedCutId, dir * step);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeCut(selectedCutId);
        return;
      }
      if (e.key === 'Escape') {
        selectCut(null);
        return;
      }
    }
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
    if (/^Arrow|^[[\]]$/.test(e.key)) doc.endCoalescing(); // nudge / rotate runs (items and cuts)
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
  undoToast(`Deleted “${label}”.`);
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
