import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../src/engine.js';
import { createEngineClient, createLocalWorker } from '../src/engineClient.js';
import { manifold } from '../src/manifold.js';
import { SPLIT_DEFAULTS } from '../src/split.js';
import { writeBinarySTL } from '../src/stl.js';
import { setup, soupOf } from './helpers.js';

// the print check itself is made to fail here: it only informs, so nothing else may fail with it
vi.mock('../src/printCheck.js', async (original) => ({
  ...(await original()),
  printCheck: () => {
    throw new RangeError('Array buffer allocation failed');
  },
}));

let client;
let wasm;
beforeAll(async () => {
  await setup();
  wasm = manifold();
  client = createEngineClient({ createWorker: () => createLocalWorker(Promise.resolve(createEngine({ wasm }))) });
});

describe('a print check that cannot be made', () => {
  const BED = [210, 210, 249];
  const printing = { nozzle: 0.4, layerHeight: 0.2 };
  const split = { ...SPLIT_DEFAULTS, labels: false, cuts: [{ id: 'c1', position: [0, 0, 0], normal: [1, 0, 0] }] };
  /** A table 120 × 60, which the check would have a note for: a top on a leg down its middle. */
  const load = async () => {
    const leg = wasm.Manifold.cube([20, 60, 30], true).translate([0, 0, 15]);
    const top = wasm.Manifold.cube([120, 60, 10], true).translate([0, 0, 35]);
    const table = wasm.Manifold.union([leg, top]);
    await client.loadBase({ kind: 'stl', bytes: writeBinarySTL(soupOf(table)), name: 'table', version: 1 });
    for (const m of [leg, top, table]) m.delete();
  };

  it('leaves the pieces without one: the split, its sheet and its files are made all the same', async () => {
    await load();
    const r = await client.result([], 1, { printing, split, bed: BED });
    expect(r.pieces).toHaveLength(2);
    for (const p of r.pieces) expect(p).not.toHaveProperty('check');
    const ex = await client.export([], 1, 'table', { printing, split, bed: BED, archive: 'files' });
    expect(ex.files.filter((f) => f.kind === 'piece')).toHaveLength(2);
    expect(ex.notes.map((n) => n.code)).not.toContain('PRINT_CHECK');
    const sheet = ex.files.find((f) => f.kind === 'text').text;
    expect(sheet).toMatch(/piece 1 of 2 .* fits\n/);
    expect(sheet).toContain('Print each piece lying the way its file lies');
  });

  it('and a model downloaded whole downloads, with no note of the check', async () => {
    await load();
    const whole = await client.export([], 1, 'table', { printing, bed: BED });
    expect(whole.stl.byteLength).toBeGreaterThan(84);
    expect(whole.notes.map((n) => n.code)).not.toContain('PRINT_CHECK');
  });
});
