// Takes the digests of today's split downloads (tests/exportCases.js) and writes them to tests/exportHashes.json, which
// tests/exportHashes.test.js checks every later build against. Run it on the commit the digests should come from,
// with nothing changed that touches a download:
//   node scripts/hash-exports.mjs            all the cases
//   node scripts/hash-exports.mjs round/     only the cases whose key starts so (the others are kept as they were)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPORT_CASES, openExports } from '../tests/exportCases.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'tests', 'exportHashes.json');
const only = process.argv[2] ?? '';

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const commit = git('rev-parse', '--short', 'HEAD');
// a digest of uncommitted source is no baseline: say so in the file
const dirty = git('status', '--porcelain', '--', 'src').length > 0;

const before = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { cases: {} };
const cases = only ? { ...before.cases } : {};
const exports = await openExports();
try {
  for (const c of EXPORT_CASES) {
    if (!c.key.startsWith(only)) continue;
    const t0 = performance.now();
    cases[c.key] = await exports.digest(c);
    console.log(`${c.key}: ${Object.keys(cases[c.key].files).length} files in ${Math.round(performance.now() - t0)} ms`);
  }
} finally {
  exports.close();
}
const keys = EXPORT_CASES.map((c) => c.key).filter((k) => k in cases);
fs.writeFileSync(file, `${JSON.stringify({ commit: dirty ? `${commit} with changes to src` : commit, cases: Object.fromEntries(keys.map((k) => [k, cases[k]])) }, null, 1)}\n`);
console.log(`wrote ${keys.length} cases to ${path.relative(root, file)} (${dirty ? `${commit}, src changed` : commit})`);
