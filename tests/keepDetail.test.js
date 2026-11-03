import { beforeAll, describe, expect, it } from 'vitest';
import { KEEP_FINDER, detailAt, edt, finderScales, finderSizes, markThin, voxelise } from '../src/keepDetail.js';
import { keepCrossed } from '../src/split.js';
import { manifold } from '../src/manifold.js';
import { setup } from './helpers.js';
import { ribbonColumn } from './ribbonFixture.js';

beforeAll(setup);

/** The grid of a solid at the finder's cube, opened: as the engine makes it. */
const gridOf = (solid) => {
  const mesh = solid.getMesh();
  return markThin(voxelise(mesh.vertProperties, mesh.triVerts, { numProp: mesh.numProp }));
};
const within = (box, want, tol) => [0, 1, 2].every((a) => Math.abs(box.min[a] - want.min[a]) <= tol && Math.abs(box.max[a] - want.max[a]) <= tol);

describe('keeping a detail whole: the finder', () => {
  it('the distances are exact: every cube to its nearest feature, squared, as a search of them all says', () => {
    const dims = [9, 7, 6];
    const n = dims[0] * dims[1] * dims[2];
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const flags = Uint8Array.from({ length: n }, () => (rand() < 0.08 ? 1 : 0));
    const got = edt(flags, dims, (x) => x === 1);
    const at = (i) => [i % dims[0], Math.floor(i / dims[0]) % dims[1], Math.floor(i / (dims[0] * dims[1]))];
    const features = [...flags.keys()].filter((i) => flags[i]);
    expect(features.length).toBeGreaterThan(5);
    for (let i = 0; i < n; i++) {
      const p = at(i);
      const best = Math.min(...features.map((f) => at(f).reduce((s, v, a) => s + (v - p[a]) ** 2, 0)));
      expect(got[i]).toBe(best);
    }
  });

  it('fills the cubes whose middles are inside, by the winding along Z: a box, a ring with its hole empty', () => {
    const { Manifold } = manifold();
    const cube = Manifold.cube([20, 12, 8], false);
    const block = cube.translate([0.3, 0.7, 0.1]);
    const g = voxelise(block.getMesh().vertProperties, block.getMesh().triVerts);
    cube.delete();
    block.delete();
    expect(g.cell).toBe(KEEP_FINDER.cell);
    expect(g.flags.reduce((s, f) => s + (f & 1), 0)).toBe(10 * 6 * 4);
    const [outer, inner] = [Manifold.cylinder(10, 20, 20, 64), Manifold.cylinder(10, 10, 10, 64)];
    const ring = outer.subtract(inner);
    const m = ring.getMesh();
    const r = voxelise(m.vertProperties, m.triVerts, { numProp: m.numProp });
    [outer, inner, ring].forEach((x) => x.delete());
    const solid = r.flags.reduce((s, f) => s + (f & 1), 0) * 8;
    expect(solid / (Math.PI * (400 - 100) * 10)).toBeCloseTo(1, 1);
    // the middle of the hole is empty
    const at = [0, 1, 2].map((a) => Math.floor((0 - r.origin[a]) / r.cell));
    at[2] = Math.floor((5 - r.origin[2]) / r.cell);
    expect(r.flags[(at[2] * r.dims[1] + at[1]) * r.dims[0] + at[0]] & 1).toBe(0);
  });

  it('on the ribbon fixture a click on the band, or on a tail, picks the band and its tails; a click on the column or the base is the body', () => {
    const solid = ribbonColumn();
    const t0 = performance.now();
    const grid = gridOf(solid);
    solid.delete();
    const band = { min: [-72, -47, 112], max: [72, 7, 150] };
    for (const click of [[0, -47, 135], [30, -38, 148], [60, -2, 125], [-58, 7, 130]]) {
      const got = detailAt(grid, click);
      expect(got, `click at ${click}`).not.toBeNull();
      expect(within(got.box, band, 2), JSON.stringify(got.box)).toBe(true);
      // about the band's own material: the ribbon, its fused stretches and its tails
      expect(got.volume / 1000).toBeGreaterThan(20);
      expect(got.volume / 1000).toBeLessThan(45);
      // the tint's cubes: one more each side of the detail's (the box goes half a cube and 1 mm past them)
      const past = grid.cell / 2 + KEEP_FINDER.margin;
      expect(got.mask.dims).toEqual([0, 1, 2].map((a) => Math.round((got.box.max[a] - got.box.min[a] - 2 * past) / grid.cell) + 2));
      expect(got.mask.data.some((v) => v === 255)).toBe(true);
    }
    for (const click of [[0, -40, 200], [40, 0, 60], [-30, -55, 8], [0, 0, 260]]) expect(detailAt(grid, click), `click at ${click}`).toBeNull();
    // a click off the model, or no click at all, picks nothing
    expect(detailAt(grid, [300, 0, 0])).toBeNull();
    expect(detailAt(grid, [Number.NaN, 0, 0])).toBeNull();
    // a click leaves the grid as it found it: the same click picks the same again
    expect(detailAt(grid, [0, -47, 135])).toEqual(detailAt(grid, [0, -47, 135]));
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it('a detail is grown back over the skin of the body it stands on: a fin on a block reaches down to the block', () => {
    const { Manifold } = manifold();
    const parts = [Manifold.cube([60, 60, 30], false), Manifold.cube([4, 40, 40], false).translate([28, 10, 30])];
    const model = Manifold.union(parts);
    const grid = gridOf(model);
    [...parts, model].forEach((m) => m.delete());
    const got = detailAt(grid, [32, 30, 60]);
    // its box from the block's top, to a cube (the skin left out ends 3 mm above it), to the fin's top
    expect(got.box.min[2]).toBeLessThanOrEqual(32);
    expect(got.box.max[2]).toBeGreaterThanOrEqual(70);
    expect(within({ min: [got.box.min[0], got.box.min[1], 0], max: [got.box.max[0], got.box.max[1], 0] }, { min: [28, 10, 0], max: [32, 50, 0] }, 2)).toBe(true);
    // a click on the block is the body
    expect(detailAt(grid, [10, 0, 15])).toBeNull();
  });

  it('the box holds all of a detail one cube thick: a cut along a 2 mm fin runs through it, wherever in the fin', () => {
    // a fin 2 mm thick on a bar: its cubes are one column, their middles on one side of it – the box goes half a cube
    // past them, where the fin may reach, and 1 mm past that
    const { Manifold } = manifold();
    const parts = [Manifold.cube([120, 30, 20], true).translate([0, 0, 10]), Manifold.cube([100, 2, 30], true).translate([0, 0, 35])];
    const model = Manifold.union(parts);
    const grid = gridOf(model);
    [...parts, model].forEach((m) => m.delete());
    const got = detailAt(grid, [0, 1, 45]);
    expect(got).not.toBeNull();
    for (const y of [-0.9, -0.5, 0, 0.5, 0.9]) expect(keepCrossed(got.box, 1, y), `Y ${y}`).toBe(true);
    expect(keepCrossed(got.box, 1, 6)).toBe(false);
  });

  it('a model scaled up or down finds the same detail: the finder\'s sizes go with its length', () => {
    const { Manifold } = manifold();
    expect(finderScales(KEEP_FINDER.length)[0]).toBe(1);
    expect(finderScales(KEEP_FINDER.length * 2)[0]).toBe(2);
    expect(finderScales(10)[0]).toBe(0.25);
    expect(finderSizes(2)).toMatchObject({ cell: 4, ball: 12, skin: 6, reach: 12 });
    // a grid never larger than the most cubes it may have
    expect(finderSizes(0.25, { min: [0, 0, 0], max: [1000, 1000, 1000] }).cell).toBeGreaterThan(3);
    const band = { min: [-72, -47, 112], max: [72, 7, 150] };
    const solid = ribbonColumn();
    for (const k of [0.5, 1.5, 2]) {
      const m = solid.scale([k, k, k]);
      const mesh = m.getMesh();
      const b = m.boundingBox();
      m.delete();
      const sizes = finderSizes(finderScales(b.max[2] - b.min[2])[0], { min: Array.from(b.min), max: Array.from(b.max) });
      const grid = markThin(voxelise(mesh.vertProperties, mesh.triVerts, { numProp: mesh.numProp, cell: sizes.cell }), sizes);
      for (const click of [[0, -47, 135], [60, -2, 125]]) {
        const got = detailAt(grid, click.map((v) => v * k), sizes);
        const want = { min: band.min.map((v) => v * k), max: band.max.map((v) => v * k) };
        expect(got, `${k}: click at ${click}`).not.toBeNull();
        expect(within(got.box, want, 3 * k), `${k}: ${JSON.stringify(got.box)}`).toBe(true);
      }
      // the column is the body at any size
      expect(detailAt(grid, [0, -40 * k, 200 * k], sizes)).toBeNull();
    }
    solid.delete();
  });

  it('a model that is thin all over is all detail: a click on a 4 mm plate picks the plate', () => {
    const { Manifold } = manifold();
    const plate = Manifold.cube([60, 40, 4], true);
    const grid = gridOf(plate);
    plate.delete();
    const got = detailAt(grid, [10, 5, 2]);
    expect(within(got.box, { min: [-30, -20, -2], max: [30, 20, 2] }, 2)).toBe(true);
  });
});
