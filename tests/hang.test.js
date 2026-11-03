import { beforeAll, describe, expect, it } from 'vitest';
import {
  HANG, boxComponents, boxExtent, boxHang, columnGraph, columnsOf, hangAt, heldParts, looseTable, moveCut, planeGrid, rasterMesh, rasterRings, sampleWidths,
  worldBox,
} from '../src/hang.js';
import { TO_PLANE, planSamples } from '../src/split.js';
import { manifold } from '../src/manifold.js';
import { setup } from './helpers.js';
import { ribbonColumn } from './ribbonFixture.js';

const rect = (u0, v0, u1, v1) => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];

/**
 * Slices across X (u = y, v = z) at x = 1 … L − 1 of a bar A (y 0–60, z 0–10) the whole length, a block B (y 0–30,
 * z 20–30) from x = L/2 on, and a bridge between them (y 0–30, z 10–20) at the first two of B's slices only: B hangs
 * on A by the bridge.
 */
function bridged(L = 40) {
  const samples = Array.from({ length: L - 1 }, (_, i) => i + 1);
  const from = L / 2;
  const ringsAt = (x) => [rect(0, 0, 60, 10), ...(x >= from ? [rect(0, 20, 30, 30)] : []), ...(x === from || x === from + 1 ? [rect(0, 10, 30, 20)] : [])];
  const grid = planeGrid({ min: [0, 0, 0], max: [L, 60, 30] }, 0, { res: 1 });
  const slices = samples.map((x) => rasterRings(ringsAt(x), grid));
  const [column] = columnsOf(grid, [[], [], []]);
  const graph = columnGraph(slices, grid, column.rect);
  const widths = sampleWidths(samples, 0, L);
  return { samples, grid, slices, graph, widths, table: looseTable(graph, widths), lo: 0, hi: L };
}

const looseSum = (comps) => comps.slice(1).filter((c) => c.volume >= HANG.loose).reduce((s, c) => s + c.volume, 0);
/** The same, of the bits only: no more than `HANG.share` of the largest. */
const bitsSum = (comps) => comps.slice(1).filter((c) => c.volume >= HANG.loose && c.volume <= HANG.share * comps[0].volume).reduce((s, c) => s + c.volume, 0);
const unit = (v) => Math.min(1, Math.max(0, v) / HANG.whole);

describe('the slice graph', () => {
  it('draws a slice row by row, one island where its pieces touch, joined to the next slice where they overlap', () => {
    const { slices, graph, samples } = bridged();
    const at = (x) => samples.indexOf(x);
    expect(slices[at(10)].pixels).toBe(600);
    expect(slices[at(20)].pixels).toBe(1200);
    // the bar alone; the bar, the bridge and the block as one island; the bar and the block apart
    expect([...graph.areas[at(10)]]).toEqual([600]);
    expect([...graph.areas[at(20)]]).toEqual([1200]);
    expect([...graph.areas[at(25)]].sort((p, q) => q - p)).toEqual([600, 300]);
    // past the bridge, both of the next slice's islands lie over the one island before them
    expect(graph.links[at(22)].length / 2).toBe(2);
    expect(graph.links[at(25)].length / 2).toBe(2);
    // the model's volume, to the sample width: the bar 40 mm long, the block from half way to the slice before its
    // first (x 19.5), the bridge two slices
    const whole = boxComponents(graph, bridged().widths, -1, samples.length);
    expect(whole).toHaveLength(1);
    expect(whole[0].volume).toBeCloseTo(40 * 600 + 20.5 * 300 + 2 * 300, 6);
  });

  it('tells what a box leaves loose: past the bridge the block is loose, before it nothing is', () => {
    const { table, samples, graph, widths, grid } = bridged();
    const n = samples.length;
    const i = samples.indexOf(23);
    // right of x 23 the block is a part of its own: 300 mm² over 17 mm
    expect(table.at(i, n)).toBeCloseTo(300 * 17, 6);
    expect(table.at(-1, i)).toBe(0);
    expect(table.at(-1, n)).toBe(0);
    const [, block] = boxComponents(graph, widths, i, n);
    expect(block.volume).toBeCloseTo(5100, 6);
    expect(worldBox(block, samples, grid)).toEqual({ min: [23, 0, 20], max: [39, 30, 30] });
  });

  it('tells what a cut leaves held on only next to its face, and how far', () => {
    const { table, samples, graph, widths } = bridged();
    const n = samples.length;
    // cut at x 15, the block hangs on the bridge (x 20, 21): leaving out 7 mm next to the face frees all 5400 mm³ of it
    const i = samples.indexOf(15);
    const { loose, parts } = heldParts(graph, widths, samples, i, 1, n);
    expect(loose).toEqual([]);
    expect(parts).toEqual([expect.objectContaining({ w: 7, s0: samples.indexOf(22), s1: n - 1 })]);
    expect(parts[0].volume).toBeCloseTo(5400, 6);
    // nothing on the other side; nor within 6 mm
    expect(heldParts(graph, widths, samples, i, -1, -1).parts).toEqual([]);
    expect(heldParts(graph, widths, samples, i, 1, n, { reach: 6 }).parts).toEqual([]);
    // what that costs the planner: a whole part held 7 mm from the face, 50 × (1 − 7/30), and 25 more as the notes
    // would warn of it (within 15 mm); from x 10, 12 mm; from x 3, 19 mm, past the warning
    expect(hangAt([table], samples, i, -1, n)).toEqual({ cost: expect.closeTo(50 * (1 - 7 / 30) + 25, 6), loose: 0, parts: [expect.objectContaining({ side: 1, w: 7 })] });
    expect(hangAt([table], samples, samples.indexOf(10), -1, n).cost).toBeCloseTo(50 * (1 - 12 / 30) + 25, 6);
    expect(hangAt([table], samples, samples.indexOf(3), -1, n).cost).toBeCloseTo(50 * (1 - 19 / 30), 6);
    // past the bridge the block is loose instead: 4500 mm³ right of x 25, 90 of a whole part's 100
    expect(hangAt([table], samples, samples.indexOf(25), -1, n)).toEqual({ cost: expect.closeTo(90, 6), loose: expect.closeTo(4500, 6), parts: [] });
  });

  it('the table of every box is what its own components say, and the cost of every cut adds up from them', () => {
    const { table, samples, graph, widths } = bridged();
    const n = samples.length;
    for (let p = -1; p < n; p++) {
      for (let q = p + 1; q <= n; q++) {
        const comps = boxComponents(graph, widths, p, q);
        expect(table.at(p, q), `${p}..${q}`).toBeCloseTo(looseSum(comps), 6);
        expect(table.bits(p, q), `${p}..${q}`).toBeCloseTo(bitsSum(comps), 6);
      }
    }
    // the cut at each sample, by brute force: what each box either side leaves loose, and each part of 5 cm³ or more
    // that comes loose as the slab next to the face widens up to 30 mm, less the further it is, more within 15 mm
    const box = (p, q) => looseSum(boxComponents(graph, widths, p, q));
    const held = (v, w) => HANG.costHeld * unit(v) * (1 - w / HANG.reach) + (w <= HANG.warn ? HANG.costWarn * unit(v) : 0);
    for (let i = 0; i < n; i++) {
      let cost = HANG.costLoose * unit(box(-1, i) + box(i, n));
      for (const side of [-1, 1]) {
        let prev = side < 0 ? box(-1, i) : box(i, n);
        for (let k = i + side; k >= 0 && k < n && Math.abs(samples[k] - samples[i]) <= HANG.reach; k += side) {
          const v = side < 0 ? box(-1, k) : box(k, n);
          if (v - prev >= HANG.held) {
            cost += held(v - prev, Math.abs(samples[k] - samples[i]));
            prev = v;
          } else if (v < prev) prev = v;
        }
      }
      expect(hangAt([table], samples, i, -1, n).cost, `x ${samples[i]}`).toBeCloseTo(cost, 6);
    }
    // and every box between two cuts on its own (`boxHang`, what the planner adds up): the bits it leaves loose, and
    // what comes loose as the slab next to each of its cut faces widens – the model's ends are no faces
    const bits = (p, q) => bitsSum(boxComponents(graph, widths, p, q));
    for (let p = -1; p < n; p++) {
      for (let q = p + 1; q <= n; q++) {
        let cost = HANG.costLoose * unit(bits(p, q));
        for (const [face, side] of [[p, 1], [q, -1]]) {
          if (face < 0 || face >= n) continue;
          let prev = box(p, q);
          for (let k = face + side; k > p && k < q && Math.abs(samples[k] - samples[face]) <= HANG.reach; k += side) {
            const v = side > 0 ? box(k, q) : box(p, k);
            if (v - prev >= HANG.held) {
              cost += held(v - prev, Math.abs(samples[k] - samples[face]));
              prev = v;
            } else if (v < prev) prev = v;
          }
        }
        expect(boxHang([table], samples, p, q), `${p}..${q}`).toBeCloseTo(cost, 6);
      }
    }
    // past the bridge the block is half the bar's size there: a shell of its own, as the give-back leaves it, which the
    // planner counts as a part already, not a bit left loose; `hangAt` (where to move a cut a note is about) counts it
    const i = samples.indexOf(25);
    expect(table.at(i, n)).toBeCloseTo(4500, 6);
    expect(table.bits(i, n)).toBe(0);
    expect(boxHang([table], samples, -1, i) + boxHang([table], samples, i, n)).toBe(0);
    expect(hangAt([table], samples, i, -1, n).cost).toBeCloseTo(90, 6);
    // where nothing is loose, a cut alone on the axis costs what its two boxes do
    for (let k = 0; k < n; k++) {
      if (table.at(-1, k) + table.at(k, n) > 0) continue;
      expect(boxHang([table], samples, -1, k) + boxHang([table], samples, k, n)).toBeCloseTo(hangAt([table], samples, k, -1, n).cost, 6);
    }
  });

  it('finds where to move a cut so that what hangs on it holds: no cost at all, or failing that past the warning', () => {
    const b = bridged(80);
    const n = b.samples.length;
    const axis = { graphs: [b.graph], tables: [b.table], widths: b.widths, samples: b.samples, lo: b.lo, hi: b.hi, grid: b.grid };
    const i = b.samples.indexOf(35);
    // the block hangs on the bridge at x 40, 41: from x 35 it holds over 7 mm
    const [part] = heldParts(b.graph, b.widths, b.samples, i, 1, n).parts;
    expect(part.w).toBe(7);
    const which = { part, side: 1, column: 0 };
    // at x 12 it holds over 30 mm, which costs nothing, but leaves a 12 mm piece; at x 26 over 16 mm, past the warning
    expect(moveCut(axis, i, -1, n, which, { least: 10 })).toEqual({ at: 12, holds: 30 });
    expect(moveCut(axis, i, -1, n, which)).toEqual({ at: 26, holds: 16 });
    // with no piece longer than 50 mm along X fitting, there is nowhere
    expect(moveCut(axis, i, -1, n, which, { fits: (size) => size[0] <= 50 })).toBeNull();
    // nor into a detail kept whole: with x 20–30 kept, the next place out
    const out = moveCut(axis, i, -1, n, which, { allowed: (t) => t < 20 || t > 30 });
    expect(out.at < 20 || out.at > 30).toBe(true);
    expect(out).not.toEqual({ at: 26, holds: 16 });
    expect(moveCut(axis, i, -1, n, which, { allowed: () => false })).toBeNull();
    // what the boxes either side hold, as sizes
    expect(boxExtent(b.graph, b.widths, b.samples, -1, b.samples.indexOf(26), b.grid)).toEqual([26, 60, 10]);
    expect(boxExtent(b.graph, b.widths, b.samples, b.samples.indexOf(26), n, b.grid)).toEqual([54, 60, 30]);
  });
});

describe('the slice graph of a solid', () => {
  let wasm;
  beforeAll(async () => {
    await setup();
    wasm = manifold();
  });

  it('draws the triangles of a mesh as Manifold slices them', () => {
    const solid = ribbonColumn();
    try {
      const bb = solid.boundingBox();
      const bounds = { min: [...bb.min], max: [...bb.max] };
      const mesh = solid.getMesh();
      for (const [axis, at] of [[0, [0, 20, 41, -60]], [1, [-42, 3]], [2, [7, 113, 130, 145]]]) {
        const grid = planeGrid(bounds, axis);
        const drawn = rasterMesh(mesh, at, grid);
        const turned = solid.transform(TO_PLANE[axis]);
        try {
          at.forEach((t, k) => {
            const cs = turned.slice(t);
            try {
              const rings = rasterRings(cs.toPolygons(), grid);
              // the same pixels but where an edge runs through a pixel's centre
              expect(Math.abs(drawn[k].pixels - rings.pixels), `${'xyz'[axis]} ${t}`).toBeLessThanOrEqual(2);
              // and as much of it as Manifold says, to what pixels on its outline tell
              expect(Math.abs(drawn[k].pixels * grid.res ** 2 - cs.area()) / cs.area()).toBeLessThan(0.02);
            } finally {
              cs.delete();
            }
          });
        } finally {
          turned.delete();
        }
      }
    } finally {
      solid.delete();
    }
  });

  it('on the ribbon fixture cut at X 0, finds the ribbon\'s right half held on over the 6 mm next to the cut, as the solid says', () => {
    const solid = ribbonColumn();
    const temps = [];
    const t = (m) => {
      temps.push(m);
      return m;
    };
    try {
      const bb = solid.boundingBox();
      const bounds = { min: [...bb.min], max: [...bb.max] };
      const grid = planeGrid(bounds, 0);
      const samples = planSamples(bounds.min[0], bounds.max[0], 1);
      const slices = rasterMesh(solid.getMesh(), samples, grid);
      const [column] = columnsOf(grid, [[], [], []]);
      const graph = columnGraph(slices, grid, column.rect);
      const widths = sampleWidths(samples, bounds.min[0], bounds.max[0]);
      const i = samples.findIndex((s) => Math.abs(s) < 1e-9);
      const { parts } = heldParts(graph, widths, samples, i, 1, samples.length, { reach: HANG.warn });
      expect(parts).toHaveLength(1);
      // exactly: the right box less the w mm next to the face, its shells of 5 cm³ or more but the largest
      const cube = (lo, hi) => t(t(wasm.Manifold.cube(hi.map((v, a) => v - lo[a]), false)).translate(lo));
      const right = t(solid.intersect(cube([0, -100, -10], [100, 100, 300])));
      const freed = (w) => t(right.subtract(cube([-1, -100, -10], [w, 100, 300]))).decompose().map(t).map((m) => m.volume()).sort((p, q) => q - p).slice(1).filter((v) => v >= HANG.held);
      expect(freed(5)).toEqual([]);
      const [exact] = freed(6);
      // the graph's hold is the first sample (1 mm apart) past where the part comes loose, its volume to 2 %
      expect(parts[0].w).toBe(6);
      expect(Math.abs(parts[0].volume - exact) / exact).toBeLessThan(0.02);
      expect(worldBox(parts[0], samples, grid)).toEqual({ min: [6, expect.closeTo(-46.6, 0), expect.closeTo(112, 0)], max: [71, expect.closeTo(0.9, 0), expect.closeTo(150, 0)] });
      // the left tail hangs on its patch (−60°…−40°) further away: nothing within 30 mm
      expect(heldParts(graph, widths, samples, i, -1, -1).parts).toEqual([]);
    } finally {
      temps.forEach((m) => m.delete());
      solid.delete();
    }
  });
});
