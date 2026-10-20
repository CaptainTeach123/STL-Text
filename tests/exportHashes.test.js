import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPORT_CASES, openExports } from './exportCases.js';

// The downloads of splits with no removable part, digested when the removable parts began (tests/exportHashes.json,
// taken by scripts/hash-exports.mjs). They must not change unless a change means them to: then take the digests of the
// cases it changes again (node scripts/hash-exports.mjs <key>) and say in the change which they are and why.
const saved = JSON.parse(fs.readFileSync(path.resolve('tests/exportHashes.json'), 'utf8'));

let exports;
beforeAll(async () => {
  exports = await openExports();
});
afterAll(() => exports?.close());

describe('downloads of splits without a removable part stay as they were', () => {
  it('the digests on file are for exactly these cases', () => {
    expect(Object.keys(saved.cases)).toEqual(EXPORT_CASES.map((c) => c.key));
  });

  for (const c of EXPORT_CASES) {
    it(c.key, async () => {
      expect(await exports.digest(c)).toEqual(saved.cases[c.key]);
    });
  }
});
