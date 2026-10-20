// Times the removable parts of a big lantern against their targets, in Node on the engine the app runs, and checks
// what it makes: the parts table, a hover over the model, a part's face tried, the dome and cap taken out with its
// twist-lock, and the base. Not part of the tests – the model it is run on stays wherever it is:
//   npm run bench:lantern -- <model.stl> [--scale 400] [--runs 1]
// It prints each step's time beside its target and exits 1 when one is missed or a piece is wrong.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Matrix4 } from 'three';
import { initManifold, manifold } from '../src/manifold.js';
import { createEngine } from '../src/engine.js';
import { createEngineClient, createLocalWorker } from '../src/engineClient.js';
import { pickPart } from '../src/aim.js';
import { parseSTL } from '../src/stl.js';
import { geometryToManifold } from '../src/mesh.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!file) {
  console.error('usage: npm run bench:lantern -- <model.stl> [--scale 400] [--runs 1]');
  process.exit(2);
}
const percent = option('scale', 400);
const runs = Math.max(1, option('runs', 1));

// the targets of each step (ms): the parts table once, a hover, a face tried on release, the dome and cap taken out
// with its lock (the way out checked on the solids once with it), the base
const TARGETS = { table: 3000, hover: 1, face: 200, lid: 8500, base: 5000 };

await initManifold();
const wasm = manifold();
const client = createEngineClient({ createWorker: () => createLocalWorker(Promise.resolve(createEngine({ wasm }))) });
const font = fs.readFileSync(path.join(root, 'node_modules/@fontsource/inter/files/inter-latin-700-normal.woff'));
await client.addFont('inter', font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength));
const printing = { nozzle: 0.4, layerHeight: 0.2 };
const split = { clearance: 0.15 };

const bytes = fs.readFileSync(file);
const results = [];
/** One timed step, its time against its target. */
const timed = async (name, target, run) => {
  const t0 = performance.now();
  const value = await run();
  const ms = performance.now() - t0;
  results.push({ name, ms, target, ok: target == null || ms <= target });
  console.log(`${name}: ${Math.round(ms)} ms${target != null ? ` (target ${target} ms)` : ''}`);
  return value;
};
const checks = [];
const check = (ok, what, detail = '') => {
  checks.push({ ok, what });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` – ${detail}` : ''}`);
};
const median = (list) => [...list].sort((a, b) => a - b)[list.length >> 1];

for (let run = 0; run < runs; run++) {
  // a version of its own each run, so nothing is kept from the run before
  const version = 2 * run + 1;
  await client.loadBase({ kind: 'stl', bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), name: 'lantern', version });
  const f = percent / 100;
  const transforms = f === 1 ? [] : [new Matrix4().makeScale(f, f, f).toArray()];
  const info = await client.updateBase({ version: version + 1, transforms, simplify: null });
  const v = version + 1;
  console.log(`\nrun ${run + 1}: ${path.basename(file)} at ${percent} %, ${info.info.triangles.toLocaleString()} triangles`);
  // the result the parts are found on
  await client.result([], v, { printing });

  const table = await timed('parts table', TARGETS.table, () => client.parts([], v, { printing, split }));
  await timed('parts table again (kept)', 50, () => client.parts([], v, { printing, split }));
  const lid = table.parts.find((e) => e.kind === 'lid');
  const base = table.parts.find((e) => e.kind === 'plug');
  check(!!lid, 'the finder offers a lid', lid ? `${lid.name}, face ${lid.face}, Ø ${(2 * lid.r).toFixed(1)}, ${lid.lock ? `twist-lock Ø ${lid.lock.opening} opening, ${lid.lock.theta}°, ${lid.lock.tabs} clicks` : `no lock (${lid.why}), from ${lid.least?.lock}×`}` : '');
  check(!!lid && !!lid.handle && !lid.takesHandle, 'the handle stays on the lantern');
  check(!!base, 'the finder offers the base', base ? `Ø ${(2 * base.r).toFixed(1)}, ${base.lock ? `twist-lock Ø ${base.lock.opening} opening` : 'no lock at this size'}` : '');

  // the pointer over the model: a lookup on the table each move, with no round trip to the engine
  const span = [table.zmin, table.zmax];
  const points = Array.from({ length: 2000 }, (_, i) => [
    table.centre[0] + ((i * 37) % 101 / 50 - 1) * table.width / 2,
    table.centre[1] + ((i * 61) % 97 / 48 - 1) * table.width / 2,
    span[0] + ((i * 13) % 199 / 198) * (span[1] - span[0]),
  ]);
  const lookups = points.map((p) => {
    const t0 = performance.now();
    pickPart(table, p);
    return performance.now() - t0;
  });
  const hover = median(lookups);
  results.push({ name: 'hover lookup (median of 2,000)', ms: hover, target: TARGETS.hover, ok: hover <= TARGETS.hover });
  console.log(`hover lookup: median ${hover.toFixed(3)} ms, slowest ${Math.max(...lookups).toFixed(3)} ms (target ${TARGETS.hover} ms)`);
  if (lid) check(pickPart(table, [lid.centre[0], lid.centre[1], (lid.face + lid.cap) / 2]).part === lid, 'a point in the middle of the dome picks it');

  if (lid) {
    // its face tried a layer under the finder's, as the Z box does on release
    const face = await timed("a part's face tried", TARGETS.face, () => client.partAt([], v, { centre: lid.centre, at: lid.face - 0.2, r: lid.r, printing, split }));
    check(face.z0 >= lid.face - 0.2 - 1e-6, "the face tried goes where the split puts it", JSON.stringify({ asked: face.asked, z0: face.z0, ok: face.ok, nearest: face.nearest }));

    // the dome and cap taken out with its twist-lock: the pieces, each one solid, the handle on the lantern
    const cut = { id: 'c1', position: [lid.centre[0], lid.centre[1], lid.face], normal: [0, 0, 1], joint: 'apart', hold: 'lock', part: { r: lid.r, side: 1, auto: true } };
    const ex = await timed('dome and cap taken out with its lock', TARGETS.lid, () => client.export([], v, 'lantern', { printing, split: { ...split, cuts: [cut] }, archive: 'files' }));
    const solids = ex.files.filter((x) => x.stl).map((x) => {
      const m = geometryToManifold(parseSTL(x.stl));
      const parts = m.decompose();
      const b = m.boundingBox();
      const out = { name: x.file, shells: parts.length, size: [0, 1, 2].map((k) => +(b.max[k] - b.min[k]).toFixed(1)) };
      parts.forEach((p) => p.delete());
      m.delete();
      return out;
    });
    const seam = ex.seams.find((s) => s.joint === 'part');
    check(solids.length === 2 && solids.every((s) => s.shells === 1), 'two pieces, each one solid', JSON.stringify(solids));
    check(!!seam?.apart?.mech, 'the dome and cap twist-lock on', seam ? JSON.stringify({ mech: seam.apart.mech, theta: seam.apart.theta, tabs: seam.apart.tabs }) : 'no seam');
    check(Math.abs(solids[0]?.size[2] - (table.zmax - table.zmin)) < 0.05, 'the lantern keeps its whole height: the handle stays on it');
  }
  if (base) {
    const cut = { id: 'c1', position: [base.centre[0], base.centre[1], base.face], normal: [0, 0, 1], joint: 'apart', hold: 'lock', part: { r: base.r, side: 1, auto: true } };
    const ex = await timed('base taken out', percent === 300 ? TARGETS.base : null, () => client.export([], v, 'lantern', { printing, split: { ...split, cuts: [cut] }, archive: 'files' }));
    check(ex.files.filter((x) => x.stl).length === 2, 'the base is a piece of its own');
  }
}

const missed = results.filter((r) => !r.ok);
const wrong = checks.filter((c) => !c.ok);
console.log(`\n${results.length - missed.length} of ${results.length} steps within their targets, ${checks.length - wrong.length} of ${checks.length} checks passed`);
for (const r of missed) console.log(`  over: ${r.name} ${Math.round(r.ms)} ms > ${r.target} ms`);
for (const c of wrong) console.log(`  failed: ${c.what}`);
process.exit(missed.length || wrong.length ? 1 : 0);
