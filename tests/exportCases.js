// What the downloads of today's splits are, as digests: the lantern fixtures with their cuts that come apart (Locks,
// Clicks on, Lifts off; with clips, without and flat), glued cuts, pins, pegs and dovetails, Fit to my printer's plan,
// the notes and the fit test. A change that is meant to leave splits without a removable part alone must leave every
// digest as it was; `scripts/hash-exports.mjs` takes them and `exportHashes.test.js` checks them. Call it from Node or
// from a test.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/engine.js';
import { createEngineClient, createLocalWorker } from '../src/engineClient.js';
import { initManifold, manifold } from '../src/manifold.js';
import { SPLIT_DEFAULTS } from '../src/split.js';
import { writeBinarySTL } from '../src/stl.js';
import { soupOf } from './helpers.js';
import { box, gothicSolid, lanternSolid, lidBoxSolid, loggiaSolid, roundLanternSolid, slenderTowerSolid } from './lanternFixture.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MODELS = {
  lantern: () => lanternSolid(),
  gothic: () => gothicSolid(),
  gothicHollow: () => gothicSolid({ roof: 'hollow' }),
  lidBox: () => lidBoxSolid(),
  loggia: () => loggiaSolid(),
  slender: () => slenderTowerSolid(),
  round: () => roundLanternSolid(),
  // none of the lanterns is a plate, which is what a dovetail is for: a sign 300 × 120 × 5
  plate: () => box([-150, -60, 0], [150, 60, 5]),
};

const BED = [210, 210, 249]; // the default printer's room: 220 × 220 × 250 less a 5 mm margin
const MINI = [170, 170, 179]; // an A1 mini's room
const PRINTING = Object.freeze({ nozzle: 0.4, layerHeight: 0.2 });

const along = (axis, at, id) => ({ id, position: [0, 1, 2].map((a) => (a === axis ? at : 0)), normal: [0, 1, 2].map((a) => (a === axis ? 1 : 0)) });
const apart = (at, hold, id = 'c1') => ({ ...along(2, at, id), joint: 'apart', hold });
const glued = (at, id = 'c1') => along(2, at, id);

/**
 * Every case: a model, its split (the settings over the defaults) and the bed. `plan` asks Fit to my printer for its
 * cuts first, the cut given kept, and downloads the split it plans.
 */
export const EXPORT_CASES = Object.freeze([
  { key: 'lantern/lock-190', model: 'lantern', split: { cuts: [apart(190, 'lock')] } },
  { key: 'lantern/snap-190', model: 'lantern', split: { cuts: [apart(190, 'snap')] } },
  { key: 'lantern/light-190', model: 'lantern', split: { cuts: [apart(190, 'light')] } },
  { key: 'lantern/lift-190', model: 'lantern', split: { cuts: [apart(190, 'lift')] } },
  { key: 'lantern/lock-192', model: 'lantern', split: { cuts: [apart(192, 'lock')] } },
  { key: 'lantern/glued-100', model: 'lantern', split: { cuts: [glued(100)] } },
  { key: 'lantern/lock-190-glued-30', model: 'lantern', split: { cuts: [apart(190, 'lock'), glued(30, 'c2')] } },
  { key: 'lantern/dovetail-x0', model: 'lantern', split: { cuts: [along(0, 0, 'c1')], joint: 'dovetail' } },
  { key: 'lantern/fit-mini', model: 'lantern', split: { cuts: [apart(190, 'snap', 'c5')], labels: false }, bed: MINI, plan: true },
  { key: 'gothic/lock-174.5', model: 'gothic', split: { cuts: [apart(174.5, 'lock')] } },
  { key: 'gothic/pins-190', model: 'gothic', split: { cuts: [glued(190)], joint: 'dowels', diameter: 5 } },
  { key: 'gothic/own-pins-190', model: 'gothic', split: { cuts: [glued(190)], joint: 'dowels', pins: 'own' } },
  { key: 'gothic/pegs-190', model: 'gothic', split: { cuts: [glued(190)], joint: 'pegs' } },
  { key: 'gothicHollow/lock-174.5', model: 'gothicHollow', split: { cuts: [apart(174.5, 'lock')] } },
  { key: 'gothicHollow/lift-174.5', model: 'gothicHollow', split: { cuts: [apart(174.5, 'lift')] } },
  { key: 'lidBox/lock-49.5', model: 'lidBox', split: { cuts: [apart(49.5, 'lock')] } },
  { key: 'lidBox/glued-30', model: 'lidBox', split: { cuts: [glued(30)] } },
  { key: 'loggia/lock-220.5', model: 'loggia', split: { cuts: [apart(220.5, 'lock')] } },
  { key: 'loggia/glued-150', model: 'loggia', split: { cuts: [glued(150)] } },
  { key: 'slender/lock-35', model: 'slender', split: { cuts: [apart(35, 'lock')] } },
  { key: 'slender/lock-39.5', model: 'slender', split: { cuts: [apart(39.5, 'lock')] } },
  { key: 'round/lock-150', model: 'round', split: { cuts: [apart(150, 'lock')] } },
  { key: 'round/snap-150', model: 'round', split: { cuts: [apart(150, 'snap')] } },
  { key: 'round/lift-150', model: 'round', split: { cuts: [apart(150, 'lift')] } },
  { key: 'round/lock-146.5', model: 'round', split: { cuts: [apart(146.5, 'lock')] } },
  { key: 'round/lock-142.5', model: 'round', split: { cuts: [apart(142.5, 'lock')] } },
  { key: 'plate/dovetail-x0', model: 'plate', split: { cuts: [along(0, 0, 'c1')], joint: 'dovetail' } },
]);

const sha = (bytes) => crypto.createHash('sha256').update(typeof bytes === 'string' ? bytes : new Uint8Array(bytes)).digest('hex').slice(0, 16);

/**
 * An engine to take the digests with, and `digest(c)`: the case's download – a digest of every file (each piece's
 * STL, the pins files, the glue sheet), of its notes' words, of its fit test and, with `plan`, of the plan – loading
 * its model when it is not the one loaded already.
 */
export async function openExports() {
  await initManifold();
  const engine = createEngine({ wasm: manifold() });
  const client = createEngineClient({ createWorker: () => createLocalWorker(Promise.resolve(engine)) });
  // the labels on glued faces are engraved in this font
  const font = fs.readFileSync(path.resolve(root, 'node_modules/@fontsource/inter/files/inter-latin-700-normal.woff'));
  await client.addFont('inter', font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength));
  let version = 0;
  let loaded = null;
  const load = async (name) => {
    if (loaded === name) return;
    const solid = MODELS[name]();
    try {
      await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(soupOf(solid)), name, version: ++version });
    } finally {
      solid.delete();
    }
    loaded = name;
  };
  const digest = async ({ model, split: patch, bed = BED, plan = false }) => {
    await load(model);
    let split = { ...SPLIT_DEFAULTS, ...patch };
    const out = {};
    if (plan) {
      const p = await client.planSplit([], version, { printing: PRINTING, split, bed, mode: 'fit' });
      out.plan = sha(JSON.stringify(p));
      const highest = Math.max(...split.cuts.map((c) => Number(c.id.slice(1))));
      const added = p.cuts.filter((c) => !c.id).map((c, i) => ({ id: `c${highest + 1 + i}`, ...c }));
      split = { ...split, cuts: [...p.cuts.filter((c) => c.id), ...added] };
    }
    const ex = await client.export([], version, model, { printing: PRINTING, split, bed, archive: 'files' });
    out.files = Object.fromEntries(ex.files.map((f) => [f.file, sha(f.stl ?? f.text)]));
    out.notes = sha(ex.notes.map((n) => `${n.level}:${n.code}: ${n.text}`).join('\n'));
    const fit = await client.fitTest([], version, { printing: PRINTING, split, bed, name: model });
    const { stl, ...about } = fit;
    out.fit = `${stl ? sha(stl) : '-'} ${sha(JSON.stringify(about))}`;
    return out;
  };
  return { digest, close: () => client.dispose() };
}
