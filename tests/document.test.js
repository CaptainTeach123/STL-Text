import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { APART_HOLDS, normaliseSplit } from '../src/split.js';
import { CUT_HOLDS, Document, LAY_DOWNS, SPLIT_DEFAULTS, cellsKey, coversKey, coversOf, createItem, createPart, createSpot, fontIds, frameOf, hasText, isSpot, itemLabel, itemText, linesOf, maxSize, modelPlacementKey, placeKey, shapeKey, spotsKey, stableKey, transformItems } from '../src/document.js';

describe('keys', () => {
  it('stableKey ignores key order and slider jitter', () => {
    expect(stableKey({ b: 1, a: [1, 2] })).toBe(stableKey({ a: [1, 2], b: 1 }));
    expect(stableKey({ x: 0.123456 })).toBe(stableKey({ x: 0.12349 }));
    expect(stableKey({ x: 0.1 })).not.toBe(stableKey({ x: 0.2 }));
  });

  it('shapeKey changes with typography, placeKey with placement', () => {
    const a = createItem({ text: 'Hi' });
    const moved = { ...a, position: [1, 2, 3] };
    const bigger = { ...a, lines: [{ ...a.lines[0], size: 12 }] };
    expect(shapeKey(a)).toBe(shapeKey(moved));
    expect(placeKey(a)).not.toBe(placeKey(moved));
    expect(shapeKey(a)).not.toBe(shapeKey(bigger));
    expect(placeKey(a)).toBe(placeKey(bigger));
    expect(shapeKey(a, 'inter:100')).not.toBe(shapeKey(a, 'inter:200')); // re-uploaded font
  });
});

describe('lines', () => {
  it('createItem accepts the one-font shorthand and splits lines', () => {
    const item = createItem({ text: 'Big\nsmall', fontId: 'slab', size: 12 });
    expect(item.lines).toEqual([
      { text: 'Big', fontId: 'slab', size: 12 },
      { text: 'small', fontId: 'slab', size: 12 },
    ]);
    expect(item.text).toBeUndefined();
    expect(itemText(item)).toBe('Big\nsmall');
    expect(itemLabel(item)).toBe('Big');
    expect(maxSize(item)).toBe(12);
  });

  it('each line can have its own font and size', () => {
    const item = createItem({ lines: [{ text: 'Title', fontId: 'slab', size: 14 }, { text: 'name', fontId: 'pacifico', size: 7 }] });
    expect(fontIds(item)).toEqual(['slab', 'pacifico']);
    expect(maxSize(item)).toBe(14);
    expect(hasText(item)).toBe(true);
    expect(hasText(createItem({ lines: [{ text: ' ' }, { text: '' }] }))).toBe(false);
    expect(itemLabel(createItem({ lines: [{ text: '' }, { text: 'second' }] }))).toBe('second');
    expect(linesOf({ lines: [{ text: 'x' }], fontId: 'bebas' })[0]).toEqual({ text: 'x', fontId: 'bebas', size: 10 });
  });

  it('shapeKey changes when any line changes', () => {
    const a = createItem({ lines: [{ text: 'A', fontId: 'inter', size: 10 }, { text: 'b', fontId: 'inter', size: 6 }] });
    const b = { ...a, lines: [a.lines[0], { ...a.lines[1], size: 7 }] };
    const c = { ...a, lines: [a.lines[0], { ...a.lines[1], fontId: 'pacifico' }] };
    expect(shapeKey(a)).not.toBe(shapeKey(b));
    expect(shapeKey(a)).not.toBe(shapeKey(c));
    expect(placeKey(a)).toBe(placeKey(b));
  });

  it('Document can add, edit and remove lines with undo', () => {
    const doc = new Document();
    const item = doc.addItem({ text: 'Hello', fontId: 'inter', size: 10 });
    const at = doc.addLine(item.id, 0, { fontId: 'pacifico', size: 6 });
    expect(at).toBe(1);
    expect(doc.items[0].lines).toHaveLength(2);
    expect(doc.items[0].lines[1]).toEqual({ text: '', fontId: 'pacifico', size: 6 });
    doc.updateLine(item.id, 1, { text: 'world' });
    expect(itemText(doc.items[0])).toBe('Hello\nworld');
    doc.removeLine(item.id, 0);
    expect(doc.items[0].lines).toEqual([{ text: 'world', fontId: 'pacifico', size: 6 }]);
    doc.removeLine(item.id, 0); // never below one line
    expect(doc.items[0].lines).toHaveLength(1);
    doc.undo();
    expect(doc.items[0].lines).toHaveLength(2);
    // history snapshots are deep copies of the lines
    doc.updateLine(item.id, 0, { text: 'Changed' });
    doc.undo();
    expect(doc.items[0].lines[0].text).toBe('Hello');
  });
});

describe('transformItems', () => {
  it('moves positions and rotates normals (no scaling of normals)', () => {
    const item = createItem({ position: [10, 0, 5], normal: [0, 0, 1] });
    const rotX = new Matrix4().makeRotationX(Math.PI / 2);
    const [r] = transformItems([item], rotX);
    expect(r.position.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([10, -5, 0]);
    expect(r.normal.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, -1, 0]);
    const [s] = transformItems([item], new Matrix4().makeScale(25.4, 25.4, 25.4));
    expect(s.position[0]).toBeCloseTo(254, 6);
    expect(s.normal.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 1]);
  });
});

describe('Document', () => {
  it('adds, selects, updates and deletes items with undo/redo', () => {
    const doc = new Document();
    doc.setBase('sample', 'plaque');
    expect(doc.canUndo).toBe(false); // loading a model is not undoable
    const a = doc.addItem({ text: 'A' });
    const b = doc.addItem({ text: 'B' });
    expect(doc.selected.id).toBe(b.id);
    doc.updateLine(a.id, 0, { size: 12 });
    expect(doc.items[0].lines[0].size).toBe(12);
    doc.deleteItem(b.id);
    expect(doc.items).toHaveLength(1);
    expect(doc.selected.id).toBe(a.id);
    expect(doc.undo()).toBe(true); // delete
    expect(doc.items).toHaveLength(2);
    expect(doc.undo()).toBe(true); // size
    expect(doc.items[0].lines[0].size).toBe(10);
    expect(doc.redo()).toBe(true);
    expect(doc.items[0].lines[0].size).toBe(12);
    expect(doc.canRedo).toBe(true);
  });

  it('coalesces slider drags into one undo step', () => {
    const doc = new Document();
    const a = doc.addItem({ text: 'A' });
    doc.updateLine(a.id, 0, { size: 11 }, { coalesce: 'size' });
    doc.updateLine(a.id, 0, { size: 12 }, { coalesce: 'size' });
    doc.updateLine(a.id, 0, { size: 13 }, { coalesce: 'size' });
    doc.endCoalescing();
    doc.updateLine(a.id, 0, { size: 14 }, { coalesce: 'size' });
    expect(doc.undo()).toBe(true);
    expect(doc.items[0].lines[0].size).toBe(13);
    expect(doc.undo()).toBe(true);
    expect(doc.items[0].lines[0].size).toBe(10);
  });

  it('transforming the base carries the items and bumps the version', () => {
    const doc = new Document();
    doc.setBase('stl', 'box');
    const v0 = doc.state.baseVersion;
    const a = doc.addItem({ text: 'A', position: [0, 0, 5], normal: [0, 0, 1] });
    doc.transformBase(new Matrix4().makeScale(2, 2, 2));
    expect(doc.state.baseVersion).toBe(v0 + 1);
    expect(doc.items[0].position).toEqual([0, 0, 10]);
    expect(doc.base.transforms).toHaveLength(1);
    doc.resetBase();
    expect(doc.items[0].position.map(Math.round)).toEqual([0, 0, 5]);
    expect(doc.base.transforms).toHaveLength(0);
    doc.undo();
    expect(doc.items[0].position).toEqual([0, 0, 10]);
    void a;
  });

  it("Inches → mm's share of the transforms is kept as the base's units: undone with it, and gone with a reset", () => {
    const doc = new Document();
    doc.setBase('stl', 'inch');
    const mm = new Matrix4().makeScale(25.4, 25.4, 25.4);
    doc.transformBase(mm, { units: 25.4 });
    expect(doc.base.units).toBe(25.4);
    // a size made after it is the model's own, not a unit's
    doc.transformBase(new Matrix4().makeScale(2, 2, 2));
    expect(doc.base.units).toBe(25.4);
    expect(doc.base.transforms).toHaveLength(2);
    doc.undo();
    doc.undo();
    expect(doc.base.units).toBeUndefined();
    doc.redo();
    expect(doc.base.units).toBe(25.4);
    doc.resetBase();
    expect(doc.base.units).toBeUndefined();
    doc.undo();
    expect(doc.base.units).toBe(25.4);
    // a Scale of the same factor is no unit: the base has none
    doc.setBase('stl', 'other');
    doc.transformBase(mm);
    expect(doc.base.units).toBeUndefined();
  });

  it('resetBase undoes non-commuting transforms exactly', () => {
    const doc = new Document();
    doc.setBase('stl', 'box');
    const item = doc.addItem({ text: 'A', position: [10, 5, 15], normal: [0, 0, 1] });
    const about = (axis, c) =>
      new Matrix4().makeTranslation(...c).multiply(new Matrix4()[`makeRotation${axis}`](Math.PI / 2)).multiply(new Matrix4().makeTranslation(-c[0], -c[1], -c[2]));
    doc.transformBase(about('X', [0, 0, 7.5]));
    doc.transformBase(about('Y', [0, 0, 12.5]));
    doc.resetBase();
    const r = (v) => Math.round(v * 1e6) / 1e6;
    expect(doc.items[0].position.map(r)).toEqual([10, 5, 15]);
    expect(doc.items[0].normal.map(r)).toEqual([0, 0, 1]);
    void item;
  });

  it('transformItems uses the normal matrix for uneven scales', () => {
    const item = createItem({ position: [0, 0, 0], normal: [Math.SQRT1_2, 0, Math.SQRT1_2] });
    const [s] = transformItems([item], new Matrix4().makeScale(1, 1, 4));
    // the plane x + z = c stretched 4x in z becomes x + z/4 = c
    expect(s.normal[0]).toBeCloseTo(0.9701, 3);
    expect(s.normal[2]).toBeCloseTo(0.2425, 3);
  });

  it('duplicate offsets one line down in the text frame and selects the copy', () => {
    const doc = new Document();
    const a = doc.addItem({ text: 'A', size: 10, position: [0, 0, 5], normal: [0, 0, 1] });
    const copy = doc.duplicateItem(a.id);
    expect(copy.id).not.toBe(a.id);
    expect(copy.position[1]).toBeCloseTo(-12, 6);
    expect(doc.selected.id).toBe(copy.id);
    const wall = doc.addItem({ text: 'W', size: 10, position: [0, -15, 0], normal: [0, -1, 0] });
    const wallCopy = doc.duplicateItem(wall.id);
    expect(wallCopy.position[2]).toBeCloseTo(-12, 6); // "down" on a wall is -Z
  });

  it('frameOf matches the placement convention', () => {
    const f = frameOf(createItem({ normal: [0, -1, 0] }));
    expect(f.x.toArray().map((v) => Math.round(v))).toEqual([1, 0, 0]);
    expect(f.y.toArray().map((v) => Math.round(v))).toEqual([0, 0, 1]);
  });

  it('notifies subscribers and selecting is not an undo step', () => {
    const doc = new Document();
    let calls = 0;
    doc.subscribe(() => calls++);
    const a = doc.addItem({ text: 'A' });
    doc.addItem({ text: 'B' });
    doc.select(a.id);
    expect(calls).toBe(3);
    expect(doc.history).toHaveLength(2);
  });
});

describe('Document enhancement settings', () => {
  it('enhanceBase merges settings, coalesces drags, and resetBase clears them', () => {
    const doc = new Document();
    doc.setBase('stl', 'm');
    const v0 = doc.state.baseVersion;
    doc.enhanceBase({ sharpen: 0.4 }, { coalesce: 'enhance:sharpen' });
    doc.enhanceBase({ sharpen: 0.6 }, { coalesce: 'enhance:sharpen' });
    doc.endCoalescing();
    expect(doc.base.enhance).toMatchObject({ sharpen: 0.6, detail: 0, smooth: 0, edgeAngle: 30 });
    expect(doc.state.baseVersion).toBe(v0 + 2);
    doc.enhanceBase({ detail: 0.5 });
    expect(doc.base.enhance).toMatchObject({ sharpen: 0.6, detail: 0.5 });
    expect(doc.undo()).toBe(true);
    expect(doc.base.enhance).toMatchObject({ sharpen: 0.6, detail: 0 });
    expect(doc.undo()).toBe(true); // the whole drag is one step
    expect(doc.base.enhance).toBeNull();
    expect(doc.redo()).toBe(true);
    expect(doc.base.enhance.sharpen).toBe(0.6);
    doc.resetBase();
    expect(doc.base.enhance).toBeNull();
    doc.enhanceBase({ smooth: 1 });
    doc.enhanceBase(null);
    expect(doc.base.enhance).toBeNull();
    // history snapshots are independent copies
    doc.enhanceBase({ smooth: 1 });
    const snapshot = doc.base.enhance;
    doc.enhanceBase({ smooth: 0.2 });
    expect(snapshot.smooth).toBe(1);
  });
});

describe('clean-up spots', () => {
  it('are items that count as content, and changing them is a new model version', () => {
    const doc = new Document();
    doc.setBase('stl', 'm');
    const spot = doc.addItem({ ...createSpot(), id: undefined, position: [1, 2, 3], radius: 5 });
    expect(isSpot(spot)).toBe(true);
    expect(hasText(spot)).toBe(true);
    expect(itemLabel(spot)).toBe('clean-up spot');
    expect(spot.conform).toBe(true);
    const v0 = doc.state.baseVersion;
    doc.updateItem(spot.id, { radius: 7 });
    expect(doc.state.baseVersion).toBe(v0 + 1);
    const k = spotsKey(doc.items);
    doc.updateItem(spot.id, { spin: 45 }); // spin does not change what a spot does
    expect(spotsKey(doc.items)).toBe(k);
    expect(doc.state.baseVersion).toBe(v0 + 1);
    const text = doc.addItem({ text: 'Hi' });
    doc.updateItem(text.id, { depth: 3 });
    expect(doc.state.baseVersion).toBe(v0 + 1); // texts never re-derive the model
    doc.deleteItem(spot.id);
    expect(doc.state.baseVersion).toBe(v0 + 2);
    expect(doc.undo()).toBe(true);
    expect(doc.items.some(isSpot)).toBe(true);
  });
});

describe('covering items', () => {
  it('a part that consumes what it covers is part of the model derivation: toggling or moving it is a new model version', () => {
    const doc = new Document();
    doc.setBase('sample', 'plaque');
    const part = createPart('p', 'part', { position: [0, 0, 4], normal: [0, 0, 1] });
    doc.addItem(part);
    const v0 = doc.state.baseVersion;
    expect(coversOf(doc.items)).toHaveLength(0);
    doc.updateItem(part.id, { cover: true });
    expect(coversOf(doc.items)).toHaveLength(1);
    expect(doc.state.baseVersion).toBe(v0 + 1);
    doc.updateItem(part.id, { position: [5, 0, 4] });
    expect(doc.state.baseVersion).toBe(v0 + 2); // moving a covering part re-derives the model
    const key = coversKey(doc.items);
    doc.updateItem(part.id, { name: 'renamed' });
    expect(coversKey(doc.items)).toBe(key); // but a name is not part of what it cuts
    expect(doc.state.baseVersion).toBe(v0 + 2);
    // a cutter part never covers
    doc.updateItem(part.id, { mode: 'engrave' });
    expect(coversOf(doc.items)).toHaveLength(0);
  });

  it('a removing spot is keyed by where it is and how large, not by clean-up amounts it does not use', () => {
    const doc = new Document();
    doc.setBase('sample', 'plaque');
    const spot = doc.addItem(createSpot({ remove: true, position: [0, 0, 4], normal: [0, 0, 1], radius: 4 }));
    const v0 = doc.state.baseVersion;
    const key = coversKey(doc.items);
    doc.updateItem(spot.id, { sharpen: 0.5, deepen: 0.1, featureSize: 2 });
    expect(coversKey(doc.items)).toBe(key);
    expect(doc.state.baseVersion).toBe(v0); // nothing to re-derive
    doc.updateItem(spot.id, { radius: 6 });
    expect(coversKey(doc.items)).not.toBe(key);
    expect(doc.state.baseVersion).toBe(v0 + 1);
    doc.updateItem(spot.id, { position: [1, 0, 4] });
    expect(doc.state.baseVersion).toBe(v0 + 2);
  });

  it('adds several items as one undo step, and the model placement key follows loads and transforms only', () => {
    const doc = new Document();
    doc.setBase('sample', 'plaque');
    const k0 = modelPlacementKey(doc.base);
    const added = doc.addItems([createSpot({ remove: true, position: [0, 0, 4], normal: [0, 0, 1] }), createSpot({ remove: true, position: [5, 0, 4], normal: [0, 0, 1] }), { text: 'A' }]);
    expect(added).toHaveLength(3);
    expect(doc.items).toHaveLength(3);
    expect(doc.selected.id).toBe(added[2].id);
    expect(modelPlacementKey(doc.base)).toBe(k0); // items do not move the model
    expect(doc.undo()).toBe(true);
    expect(doc.items).toHaveLength(0);
    expect(doc.canUndo).toBe(false);
    expect(doc.addItems([])).toEqual([]);
    expect(doc.canUndo).toBe(false);
    doc.enhanceBase({ sharpen: 0.5 });
    expect(modelPlacementKey(doc.base)).toBe(k0); // nor does an enhancement
    doc.transformBase(new Matrix4().makeRotationZ(Math.PI / 2));
    const k1 = modelPlacementKey(doc.base);
    expect(k1).not.toBe(k0); // a transform moves everything on the model
    doc.setBase('sample', 'plaque');
    expect(modelPlacementKey(doc.base)).not.toBe(k0); // a model loaded again is another model
    expect(modelPlacementKey(doc.base)).not.toBe(k1);
  });
});

describe('split for printing', () => {
  const X = [1, 0, 0];
  const Y = [0, 1, 0];
  // rounded, with -0 turned into 0 so toEqual can compare it
  const r = (v) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0);

  it('setSplit and the cut edits never change the model version or where the model lies', () => {
    const doc = new Document();
    doc.setBase('stl', 'bar');
    const v0 = doc.state.baseVersion;
    const k0 = modelPlacementKey(doc.base);
    const a = doc.addCut({ position: [0, 0, 0], normal: X });
    expect(a).toBe('c1');
    expect(doc.split).toEqual({ ...SPLIT_DEFAULTS, cuts: [{ id: 'c1', position: [0, 0, 0], normal: X }] });
    doc.setSplit({ joint: 'dowels', diameter: 6 });
    doc.updateCut(a, { position: [12, 0, 0] });
    const b = doc.addCut({ position: [0, 5, 0], normal: Y });
    doc.removeCut(a);
    expect(doc.split.cuts).toEqual([{ id: b, position: [0, 5, 0], normal: Y }]);
    expect(doc.split).toMatchObject({ joint: 'dowels', diameter: 6, clearance: 0.15, labels: true }); // the rest stays at the defaults
    expect(doc.history).toHaveLength(5);
    doc.setSplit(null);
    expect(doc.split).toBeNull();
    expect(doc.state.baseVersion).toBe(v0);
    expect(modelPlacementKey(doc.base)).toBe(k0);
    // with spots and covering items on the model the split still leaves its version alone
    doc.addItem(createSpot({ remove: true, position: [0, 0, 4], normal: [0, 0, 1] }));
    const v1 = doc.state.baseVersion;
    doc.addCut({ position: [1, 0, 0], normal: X });
    doc.setSplit({ clearance: 0.2 });
    expect(doc.state.baseVersion).toBe(v1);
  });

  it('gives each cut an id one past the highest in use, and ids to planned cuts that have none', () => {
    const doc = new Document();
    doc.addCut({ position: [0, 0, 0], normal: X });
    doc.addCut({ position: [10, 0, 0], normal: X });
    doc.removeCut('c1');
    expect(doc.addCut({ position: [20, 0, 0], normal: X })).toBe('c3');
    // a planned split arrives without ids: its cuts get new ones, past those of the cuts they replace – they are
    // other cuts; given ids are kept, repeats renumbered
    doc.setSplit({ cuts: [{ position: [-83.333, 0, 0], normal: X }, { position: [83.333, 0, 0], normal: X }] });
    expect(doc.split.cuts.map((c) => c.id)).toEqual(['c4', 'c5']);
    // the same plan handed over again is the same cuts: their ids stay, and nothing is left to undo
    const steps = doc.history.length;
    doc.setSplit({ cuts: [{ position: [-83.333, 0, 0], normal: X }, { position: [83.333, 0, 0], normal: X }] });
    expect(doc.split.cuts.map((c) => c.id)).toEqual(['c4', 'c5']);
    expect(doc.history).toHaveLength(steps);
    // one cut of it where it was and one new: the one there keeps its id, the other follows on
    doc.setSplit({ cuts: [{ position: [-50, 0, 0], normal: X }, { position: [83.333, 0, 0], normal: X }] });
    expect(doc.split.cuts.map((c) => c.id)).toEqual(['c6', 'c5']);
    // a cut in the same place that comes apart is not the glued one, and two cuts in one place are two cuts
    doc.setSplit({ cuts: [{ position: [83.333, 0, 0], normal: X, joint: 'apart' }, { position: [-50, 0, 0], normal: X }, { position: [-50, 0, 0], normal: X }] });
    expect(doc.split.cuts.map((c) => c.id)).toEqual(['c7', 'c6', 'c8']);
    doc.setSplit({ cuts: [{ position: [-83.333, 0, 0], normal: X }, { position: [83.333, 0, 0], normal: X }] });
    expect(doc.split.cuts.map((c) => c.id)).toEqual(['c9', 'c10']);
    doc.setSplit({ cuts: [{ position: [0, 0, 0], normal: X }, { id: 'c9', position: [0, 0, 0], normal: Y }, { id: 'c9', position: [0, 0, 5], normal: [0, 0, 1] }] });
    expect(doc.split.cuts.map((c) => c.id)).toEqual(['c11', 'c9', 'c12']);
    // a cut keeps only what a cut is
    doc.setSplit({ cuts: [{ id: 'c1', letter: 'A', axis: 'x', at: 3, position: [3, 0, 0], normal: X }] });
    expect(doc.split.cuts).toEqual([{ id: 'c1', position: [3, 0, 0], normal: X }]);
  });

  it('undo and redo restore the cuts; a drag is one step; committing the same value adds none', () => {
    const doc = new Document();
    doc.setBase('stl', 'bar');
    const id = doc.addCut({ position: [0, 0, 0], normal: X });
    for (const x of [5, 10, 15]) doc.updateCut(id, { position: [x, 0, 0] }, { coalesce: 'split:drag' });
    doc.endCoalescing();
    expect(doc.history).toHaveLength(2); // the add and the whole drag
    doc.updateCut(id, { position: [15, 0, 0] }); // released where it was
    doc.updateCut(id, { position: [15, 0, 0], normal: X });
    doc.setSplit({ joint: 'auto' }); // already in force
    doc.setSplit({ cuts: [{ position: [15, 0, 0], id, normal: X }] }); // the same cut, keys in another order
    doc.updateCut('c9', { position: [1, 0, 0] }); // no such cut
    doc.removeCut('c9');
    expect(doc.history).toHaveLength(2);
    doc.setSplit({ clearance: 0.2 }, { coalesce: 'split:clearance' });
    doc.setSplit({ clearance: 0.25 }, { coalesce: 'split:clearance' });
    doc.endCoalescing();
    expect(doc.history).toHaveLength(3);
    expect(doc.undo()).toBe(true);
    expect(doc.split.clearance).toBe(0.15);
    expect(doc.undo()).toBe(true);
    expect(doc.split.cuts[0].position).toEqual([0, 0, 0]);
    expect(doc.undo()).toBe(true);
    expect(doc.split).toBeNull();
    expect(doc.canUndo).toBe(false);
    expect(doc.redo()).toBe(true);
    expect(doc.redo()).toBe(true);
    expect(doc.split.cuts).toEqual([{ id, position: [15, 0, 0], normal: X }]);
    doc.removeCut(id);
    expect(doc.split.cuts).toEqual([]); // the settings stay; with no cuts nothing is split
    expect(doc.undo()).toBe(true);
    expect(doc.split.cuts).toHaveLength(1);
  });

  it('history snapshots are independent copies of the cuts', () => {
    const doc = new Document();
    doc.setSplit({ cuts: [{ position: [1, 2, 3], normal: [0, 0, 1] }] });
    doc.commit((s) => {
      s.split.cuts[0].position[2] = 9;
      s.split.cuts[0].normal[0] = 1;
    });
    expect(doc.split.cuts[0].position).toEqual([1, 2, 9]);
    expect(doc.undo()).toBe(true);
    expect(doc.split.cuts[0]).toEqual({ id: 'c1', position: [1, 2, 3], normal: [0, 0, 1] });
    expect(doc.redo()).toBe(true);
    expect(doc.split.cuts[0].position).toEqual([1, 2, 9]);
    // adding a cut to the copy leaves the step before it as it was
    doc.addCut({ position: [0, 0, 0], normal: X });
    expect(doc.undo()).toBe(true);
    expect(doc.split.cuts).toHaveLength(1);
    // the arrays handed in are copied, not kept
    const given = { position: [4, 5, 6], normal: [...X] };
    doc.setSplit({ cuts: [given] });
    given.position[0] = 99;
    expect(doc.split.cuts[0].position).toEqual([4, 5, 6]);
    expect(given.id).toBeUndefined();
    const more = { position: [7, 0, 0], normal: [...X] };
    doc.addCut(more);
    more.normal[1] = 1;
    expect(doc.split.cuts[1].normal).toEqual(X);
    expect(SPLIT_DEFAULTS.cuts).toEqual([]);
  });

  it('a new split starts from the given defaults; an existing one keeps its settings', () => {
    const doc = new Document();
    const id = doc.addCut({ position: [0, 0, 0], normal: [0, 0, 1] }, { defaults: { joint: 'none', labels: false, cuts: [{ position: [9, 9, 9], normal: X }] } });
    expect(doc.split).toEqual({ ...SPLIT_DEFAULTS, joint: 'none', labels: false, cuts: [{ id, position: [0, 0, 0], normal: [0, 0, 1] }] });
    doc.addCut({ position: [0, 0, 5], normal: [0, 0, 1] }, { defaults: { joint: 'dowels' } });
    expect(doc.split.joint).toBe('none');
    expect(doc.split.cuts).toHaveLength(2);
    expect(Object.isFrozen(SPLIT_DEFAULTS) && Object.isFrozen(SPLIT_DEFAULTS.cuts)).toBe(true);
  });

  it('cuts move with the model: transforms carry them, reset brings them back', () => {
    const doc = new Document();
    doc.setBase('stl', 'bar');
    doc.addCut({ position: [10, 0, 0], normal: X });
    doc.addCut({ position: [2, 0, 0], normal: X });
    const v0 = doc.state.baseVersion;
    doc.transformBase(new Matrix4().makeRotationZ(Math.PI / 2));
    expect(doc.state.baseVersion).toBe(v0 + 1); // the transform's own step, nothing more
    expect(r(doc.split.cuts[0].position)).toEqual([0, 10, 0]);
    expect(r(doc.split.cuts[0].normal)).toEqual(Y);
    expect(doc.split.cuts[0].id).toBe('c1');
    doc.resetBase();
    expect(r(doc.split.cuts[0].position)).toEqual([10, 0, 0]);
    expect(r(doc.split.cuts[0].normal)).toEqual(X);
    // millimetres from inches
    doc.transformBase(new Matrix4().makeScale(25.4, 25.4, 25.4));
    expect(doc.split.cuts[1].position[0]).toBeCloseTo(50.8, 9);
    expect(r(doc.split.cuts[1].normal)).toEqual(X);
    expect(doc.undo()).toBe(true);
    expect(doc.split.cuts[1].position).toEqual([2, 0, 0]);
    // a model with no split transforms as before
    doc.setSplit(null);
    doc.transformBase(new Matrix4().makeRotationX(Math.PI / 2));
    expect(doc.split).toBeNull();
  });

  it('loading a model or clearing it removes the split', () => {
    const doc = new Document();
    doc.setBase('stl', 'bar');
    doc.addCut({ position: [0, 0, 0], normal: X });
    doc.setBase('stl', 'other');
    expect(doc.split).toBeNull();
    doc.addCut({ position: [0, 0, 0], normal: X });
    doc.setBase('none');
    expect(doc.split).toBeNull();
    expect(doc.canUndo).toBe(false);
  });

  it('a text-only sign (no model) can be split', () => {
    const doc = new Document();
    doc.setBase('none');
    doc.addItem({ text: 'HELLO WORLD', position: [0, 0, 0], normal: [0, 0, 1] });
    doc.setSplit({ cuts: [{ position: [0, 0, 0], normal: X }] });
    expect(doc.base).toBeNull();
    expect(doc.split.cuts).toEqual([{ id: 'c1', position: [0, 0, 0], normal: X }]);
    const v0 = doc.state.baseVersion;
    doc.updateCut('c1', { position: [4, 0, 0] }, { coalesce: 'split:at:c1' });
    doc.addCut({ position: [0, 0, 0], normal: Y });
    expect(doc.split.cuts).toHaveLength(2);
    doc.transformBase(new Matrix4().makeScale(2, 2, 2)); // nothing to transform
    expect(doc.split.cuts[0].position).toEqual([4, 0, 0]);
    expect(doc.state.baseVersion).toBe(v0);
    expect(modelPlacementKey(doc.base)).toBe(modelPlacementKey(null));
  });
});

describe('the side a piece lies on, chosen by hand', () => {
  const X = [1, 0, 0];
  const Z = [0, 0, 1];

  it('a side is chosen in one undo step, handed back to the app in another, and with none the split is the split it always was', () => {
    const doc = new Document();
    doc.setBase('stl', 'bar');
    doc.addCut({ position: [0, 0, 0], normal: X });
    const before = JSON.stringify(doc.split);
    const v0 = doc.state.baseVersion;
    doc.setPieceLay('0,0,0', '-z');
    expect(doc.split.lay).toEqual({ '0,0,0': '-z' });
    expect(doc.history).toHaveLength(2);
    doc.setPieceLay('0,0,0', '-z'); // the side it has: no step
    doc.setPieceLay('1,0,0', null); // the app's already: no step
    doc.setPieceLay('nonsense', '-z'); // no box
    expect(doc.history).toHaveLength(2);
    doc.setPieceLay('1,0,0', '+y');
    doc.setPieceLay('0,0,0', 'sideways'); // no side: the app's choice again
    expect(doc.split.lay).toEqual({ '1,0,0': '+y' });
    doc.setPieceLay('1,0,0', null);
    // the last one gone, the list goes too: the JSON and every key are what they were
    expect('lay' in doc.split).toBe(false);
    expect(JSON.stringify(doc.split)).toBe(before);
    expect(stableKey(doc.split)).toBe(stableKey(JSON.parse(before)));
    expect('lay' in normaliseSplit(doc.split)).toBe(false);
    expect(doc.undo()).toBe(true);
    expect(doc.split.lay).toEqual({ '1,0,0': '+y' });
    // none of it is a new model version, and the six sides are the six directions
    expect(doc.state.baseVersion).toBe(v0);
    expect([...LAY_DOWNS].sort()).toEqual(['+x', '+y', '+z', '-x', '-y', '-z']);
    // with no split there is nothing to choose for
    const bare = new Document();
    bare.setPieceLay('0,0,0', '-z');
    expect(bare.split).toBeNull();
  });

  it('the choices stay while the cuts make the same boxes – dragged, set to come apart, the settings changed – and go when they do not', () => {
    const doc = new Document();
    doc.setBase('stl', 'bar');
    const a = doc.addCut({ position: [0, 0, 0], normal: X });
    const b = doc.addCut({ position: [50, 0, 0], normal: X });
    const lay = { '0,0,0': '-z', '2,0,0': '+x' };
    const choose = () => {
      doc.setPieceLay('0,0,0', '-z');
      doc.setPieceLay('2,0,0', '+x');
    };
    choose();
    // a cut dragged, one set to come apart, a setting changed, a detail kept whole: the boxes are the same ones
    doc.updateCut(a, { position: [10, 0, 0] });
    doc.setCutJoint(b, { hold: 'snap' });
    doc.setSplit({ joint: 'dowels', diameter: 5 });
    doc.addKeep({ point: [0, 0, 0], box: null });
    expect(doc.split.lay).toEqual(lay);
    // the history holds its own copy
    doc.split.lay['0,0,0'] = '+z';
    doc.undo();
    expect(doc.split.lay).toEqual(lay);
    // a cut dragged past the other one: the boxes change hands
    doc.updateCut(a, { position: [60, 0, 0] });
    expect('lay' in doc.split).toBe(false);
    // and an undo brings the choices back with the cuts
    doc.undo();
    expect(doc.split.lay).toEqual(lay);
    // a cut turned to another axis
    doc.updateCut(a, { normal: Z });
    expect('lay' in doc.split).toBe(false);
    doc.undo();
    // a cut removed, a cut added, the cuts replaced (Fit to my printer)
    doc.removeCut(b);
    expect('lay' in doc.split).toBe(false);
    doc.undo();
    doc.addCut({ position: [0, 0, 5], normal: Z });
    expect('lay' in doc.split).toBe(false);
    doc.undo();
    doc.setSplit({ cuts: [{ position: [0, 0, 0], normal: X }] });
    expect('lay' in doc.split).toBe(false);
    doc.undo();
    expect(doc.split.lay).toEqual(lay);
    // a part taken out makes no box: the choices stay
    doc.addCut({ position: [0, 0, 20], normal: Z, joint: 'apart', part: { r: 5, side: 1 } });
    expect(doc.split.lay).toEqual(lay);
    // the model turned or resized: a piece is no longer the one the side was chosen for
    doc.transformBase(new Matrix4().makeRotationZ(Math.PI / 2));
    expect('lay' in doc.split).toBe(false);
    doc.undo();
    expect(doc.split.lay).toEqual(lay);
    doc.resetBase();
    expect('lay' in doc.split).toBe(false);
  });

  it('a new plan of as many cuts drops the choices, and a cut dragged past another and back in one drag keeps them', () => {
    const doc = new Document();
    doc.setBase('stl', 'block');
    // Fit to my printer hands over cuts without ids
    doc.setSplit({ cuts: [{ position: [10, 0, 0], normal: X }, { position: [0, 0, 20], normal: Z }] });
    const first = cellsKey(doc.split);
    doc.setPieceLay('1,0,1', '-y');
    // a new plan, with one cut across each axis again: other cuts, other pieces
    doc.setSplit({ cuts: [{ position: [-40, 0, 0], normal: X }, { position: [0, 0, 70], normal: Z }] });
    expect('lay' in doc.split).toBe(false);
    expect(cellsKey(doc.split)).not.toBe(first);
    doc.undo();
    expect(doc.split.lay).toEqual({ '1,0,1': '-y' });
    // the same plan asked for again – in any order – is the same cuts and the same pieces: the choices stay
    const ids = doc.split.cuts.map((c) => c.id);
    const steps = doc.history.length;
    doc.setSplit({ cuts: [{ position: [10, 0, 0], normal: X }, { position: [0, 0, 20], normal: Z }] });
    expect(doc.history).toHaveLength(steps);
    doc.setSplit({ cuts: [{ position: [0, 0, 20], normal: Z }, { position: [10, 0, 0], normal: X }] });
    expect(doc.split.cuts.map((c) => c.id)).toEqual([...ids].reverse());
    expect(cellsKey(doc.split)).toBe(first);
    expect(doc.split.lay).toEqual({ '1,0,1': '-y' });
    doc.undo();
    // one cut of the plan somewhere else: other pieces
    doc.setSplit({ cuts: [{ position: [10, 0, 0], normal: X }, { position: [0, 0, 25], normal: Z }] });
    expect('lay' in doc.split).toBe(false);
    doc.undo();
    // the very cuts handed back with their ids are the same cuts
    doc.setSplit({ cuts: doc.split.cuts.map((c) => ({ ...c, position: c.position.map((v) => v + 1) })) });
    expect(doc.split.lay).toEqual({ '1,0,1': '-y' });

    // one drag: past the other cut the choices are set aside, back again they return
    const bar = new Document();
    bar.setBase('stl', 'bar');
    const a = bar.addCut({ position: [0, 0, 0], normal: X });
    bar.addCut({ position: [50, 0, 0], normal: X });
    bar.setPieceLay('2,0,0', '+x');
    const drag = { coalesce: `split:at:${a}` };
    bar.updateCut(a, { position: [30, 0, 0] }, drag);
    expect(bar.split.lay).toEqual({ '2,0,0': '+x' });
    bar.updateCut(a, { position: [60, 0, 0] }, drag);
    expect('lay' in bar.split).toBe(false);
    bar.updateCut(a, { position: [70, 0, 0] }, drag);
    expect('lay' in bar.split).toBe(false);
    bar.updateCut(a, { position: [20, 0, 0] }, drag);
    expect(bar.split.lay).toEqual({ '2,0,0': '+x' });
    // the whole drag is one step
    bar.undo();
    expect(bar.split.cuts[0].position).toEqual([0, 0, 0]);
    expect(bar.split.lay).toEqual({ '2,0,0': '+x' });
    // left on the far side when the drag ends, they are gone – a later drag back does not bring them
    bar.updateCut(a, { position: [60, 0, 0] }, drag);
    bar.endCoalescing();
    bar.updateCut(a, { position: [20, 0, 0] }, drag);
    expect('lay' in bar.split).toBe(false);
    // a side chosen while the cut is on the far side is not overwritten by one set aside
    bar.undo();
    bar.undo();
    expect(bar.split.lay).toEqual({ '2,0,0': '+x' });
    bar.updateCut(a, { position: [60, 0, 0] }, drag);
    bar.setPieceLay('0,0,0', '-y');
    bar.updateCut(a, { position: [20, 0, 0] }, drag);
    expect('lay' in bar.split).toBe(false);
  });

  it('cellsKey tells the boxes by the cuts across each axis in their order along it', () => {
    const cut = (id, axis, at, extra = {}) => ({ id, position: [0, 1, 2].map((k) => (k === axis ? at : 7)), normal: [0, 1, 2].map((k) => (k === axis ? -1 : 0)), ...extra });
    expect(cellsKey(null)).toBe('||');
    expect(cellsKey({ cuts: [cut('c2', 0, 30), cut('c1', 0, -5), cut('c3', 2, 4)] })).toBe('c1,c2||c3');
    // wherever they are dragged, while their order stays
    expect(cellsKey({ cuts: [cut('c2', 0, 99), cut('c1', 0, 98), cut('c3', 2, -40)] })).toBe('c1,c2||c3');
    expect(cellsKey({ cuts: [cut('c2', 0, 30), cut('c1', 0, 31), cut('c3', 2, 4)] })).toBe('c2,c1||c3');
    // a part taken out is no plane of the grid
    expect(cellsKey({ cuts: [cut('c1', 0, 0), cut('c2', 2, 9, { part: { r: 5, side: 1 } })] })).toBe('c1||');
  });

  it('a split given sides that cannot be keeps only those that can', () => {
    const doc = new Document();
    doc.setBase('stl', 'bar');
    doc.setSplit({ cuts: [{ position: [0, 0, 0], normal: X }], lay: { '0,0,0': '-z', '1,0,0': 'down', 'a,b': '+x', '1,0': '-y' } });
    // (sides that come with the cuts they go by stay, though the boxes are new)
    expect(doc.split.lay).toEqual({ '0,0,0': '-z' });
    doc.setSplit({ lay: { x: 1 } });
    expect('lay' in doc.split).toBe(false);
  });
});

describe('pieces asked to be tipped so that a leaning face prints level', () => {
  const X = [1, 0, 0];
  const Z = [0, 0, 1];

  it('a piece is asked to be tipped in one undo step, and with none the split is the split it always was', () => {
    const doc = new Document();
    doc.setBase('stl', 'bar');
    doc.addCut({ position: [0, 0, 0], normal: X });
    const before = JSON.stringify(doc.split);
    const v0 = doc.state.baseVersion;
    expect('tip' in doc.split).toBe(false);
    doc.setPieceTip('0,0,0', true);
    expect(doc.split.tip).toEqual({ '0,0,0': true });
    expect(doc.history).toHaveLength(2);
    doc.setPieceTip('0,0,0', true); // asked already: no step
    doc.setPieceTip('1,0,0', false); // not asked: no step
    doc.setPieceTip('nonsense', true); // no box
    expect(doc.history).toHaveLength(2);
    doc.setPieceTip('1,0,0', true);
    doc.setPieceTip('0,0,0', false);
    expect(doc.split.tip).toEqual({ '1,0,0': true });
    doc.setPieceTip('1,0,0', false);
    // the last one gone, the list goes too: the JSON and every key are what they were
    expect('tip' in doc.split).toBe(false);
    expect(JSON.stringify(doc.split)).toBe(before);
    expect(stableKey(doc.split)).toBe(stableKey(JSON.parse(before)));
    expect('tip' in normaliseSplit(doc.split)).toBe(false);
    expect(doc.undo()).toBe(true);
    expect(doc.split.tip).toEqual({ '1,0,0': true });
    // the history holds its own copy, and none of it is a new model version
    doc.setPieceTip('0,0,0', true);
    delete doc.split.tip['1,0,0'];
    doc.undo();
    expect(doc.split.tip).toEqual({ '1,0,0': true });
    expect(doc.state.baseVersion).toBe(v0);
    const bare = new Document();
    bare.setPieceTip('0,0,0', true);
    expect(bare.split).toBeNull();
    // a split given tips that cannot be keeps only those that can
    doc.setSplit({ tip: { '0,0,0': true, '1,0,0': 'yes', 'a,b': true, '1,0': true, '2,0,0': false } });
    expect(doc.split.tip).toEqual({ '0,0,0': true });
    doc.setSplit({ tip: { x: 1 } });
    expect('tip' in doc.split).toBe(false);
  });

  it('it lasts while the cuts make the same boxes and the piece lies on the same side, and goes when they do not', () => {
    const doc = new Document();
    doc.setBase('stl', 'bar');
    const a = doc.addCut({ position: [0, 0, 0], normal: X });
    const b = doc.addCut({ position: [50, 0, 0], normal: X });
    doc.setPieceTip('0,0,0', true);
    doc.setPieceTip('2,0,0', true);
    const tip = { '0,0,0': true, '2,0,0': true };
    // a cut dragged, one set to come apart, a setting changed: the boxes are the same ones
    doc.updateCut(a, { position: [10, 0, 0] });
    doc.setCutJoint(b, { hold: 'snap' });
    doc.setSplit({ joint: 'dowels', diameter: 5 });
    expect(doc.split.tip).toEqual(tip);
    // a cut dragged past the other, turned, removed, added, the cuts replaced: other boxes – and Undo brings it back
    for (const change of [
      () => doc.updateCut(a, { position: [60, 0, 0] }),
      () => doc.updateCut(a, { normal: Z }),
      () => doc.removeCut(b),
      () => doc.addCut({ position: [0, 0, 5], normal: Z }),
      () => doc.setSplit({ cuts: [{ position: [0, 0, 0], normal: X }] }),
      () => doc.transformBase(new Matrix4().makeRotationZ(Math.PI / 2)),
    ]) {
      change();
      expect('tip' in doc.split).toBe(false);
      doc.undo();
      expect(doc.split.tip).toEqual(tip);
    }
    // the same cuts asked for again (Fit to my printer, nothing changed) keep it, with no step
    const steps = doc.history.length;
    doc.setSplit({ cuts: doc.split.cuts.map(({ id, ...c }) => c) });
    expect(doc.history).toHaveLength(steps);
    expect(doc.split.tip).toEqual(tip);
    // a side chosen by hand for a tipped piece: it was tipped for a face of the side it lay on, so it is asked again
    doc.setPieceLay('0,0,0', '-y');
    expect(doc.split).toMatchObject({ lay: { '0,0,0': '-y' }, tip: { '2,0,0': true } });
    doc.setPieceLay('2,0,0', '+x');
    expect('tip' in doc.split).toBe(false);
    doc.undo();
    expect(doc.split.tip).toEqual({ '2,0,0': true });
    // tipped on the side chosen, both go by the boxes and both go with them
    doc.setPieceTip('0,0,0', true);
    doc.removeCut(b);
    expect('tip' in doc.split || 'lay' in doc.split).toBe(false);
    doc.undo();
    expect(doc.split).toMatchObject({ lay: { '0,0,0': '-y' }, tip: { '0,0,0': true, '2,0,0': true } });
  });

  it('a cut dragged past another and back in one drag keeps the tip, with a side chosen or without', () => {
    const bar = new Document();
    bar.setBase('stl', 'bar');
    const a = bar.addCut({ position: [0, 0, 0], normal: X });
    bar.addCut({ position: [50, 0, 0], normal: X });
    bar.setPieceTip('2,0,0', true);
    const drag = { coalesce: `split:at:${a}` };
    bar.updateCut(a, { position: [60, 0, 0] }, drag);
    expect('tip' in bar.split).toBe(false);
    bar.updateCut(a, { position: [20, 0, 0] }, drag);
    expect(bar.split.tip).toEqual({ '2,0,0': true });
    expect('lay' in bar.split).toBe(false);
    bar.endCoalescing();
    bar.setPieceLay('0,0,0', '-z');
    bar.updateCut(a, { position: [60, 0, 0] }, drag);
    expect('tip' in bar.split || 'lay' in bar.split).toBe(false);
    bar.updateCut(a, { position: [20, 0, 0] }, drag);
    expect(bar.split).toMatchObject({ lay: { '0,0,0': '-z' }, tip: { '2,0,0': true } });
    // one ticked while the cut is on the far side is not overwritten by what was set aside
    bar.endCoalescing();
    bar.updateCut(a, { position: [60, 0, 0] }, drag);
    bar.setPieceTip('1,0,0', true);
    bar.updateCut(a, { position: [20, 0, 0] }, drag);
    expect('tip' in bar.split || 'lay' in bar.split).toBe(false);
  });
});

describe('details kept whole', () => {
  const box = { min: [-72, -47, 112], max: [72, 7, 150] };
  const mark = { point: [0, -47, 135], normal: [0, -1, 0], box };
  // rounded, with -0 turned into 0 so toEqual can compare it
  const r = (v) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0);

  it('a detail is kept whole in one undo step, named, renamed (typing is one step) and let go; the last one gone, the list goes too', () => {
    const doc = new Document();
    doc.setBase('stl', 'ribbon');
    const v0 = doc.state.baseVersion;
    // with no split yet one starts, from the settings used last, with no cuts: the model is not split
    const k1 = doc.addKeep(mark, { defaults: { joint: 'dowels' } });
    expect(k1).toBe('k1');
    expect(doc.split).toEqual({ ...SPLIT_DEFAULTS, joint: 'dowels', cuts: [], keep: [{ id: 'k1', name: 'Detail 1', ...mark }] });
    expect(doc.history).toHaveLength(1);
    doc.renameKeep(k1, 'R', { coalesce: 'name' });
    doc.renameKeep(k1, 'Ri', { coalesce: 'name' });
    doc.renameKeep(k1, 'Ribbon', { coalesce: 'name' });
    doc.endCoalescing();
    doc.renameKeep(k1, 'Ribbon'); // the name it has: no step
    expect(doc.history).toHaveLength(2);
    expect(doc.split.keep[0].name).toBe('Ribbon');
    const k2 = doc.addKeep({ point: [60, -2, 125], box }, { limit: 2 });
    expect(k2).toBe('k2');
    expect(doc.split.keep[1]).toMatchObject({ name: 'Detail 2', normal: [0, 0, 1] });
    expect(doc.addKeep(mark, { limit: 2 })).toBeNull(); // as many as the split may keep whole
    doc.removeKeep(k1);
    expect(doc.split.keep.map((k) => k.id)).toEqual(['k2']);
    // a new one never takes the id of one still listed
    expect(doc.addKeep(mark)).toBe('k3');
    doc.removeKeep('k2');
    doc.removeKeep('k3');
    expect('keep' in doc.split).toBe(false);
    expect(doc.undo()).toBe(true);
    expect(doc.split.keep.map((k) => k.id)).toEqual(['k3']);
    // none of it is a new model version
    expect(doc.state.baseVersion).toBe(v0);
    // a new model's split goes, and its details with it
    doc.setBase('stl', 'other');
    expect(doc.split).toBeNull();
  });

  it('an empty list is no part of the split: its JSON and every key stay what they were, and the cut edits keep the details', () => {
    const doc = new Document();
    doc.setBase('stl', 'bar');
    doc.addCut({ position: [0, 0, 0], normal: [1, 0, 0] });
    const before = JSON.stringify(doc.split);
    doc.setSplit({ keep: [] });
    expect(JSON.stringify(doc.split)).toBe(before);
    expect(doc.history).toHaveLength(1); // the same split: no step
    doc.addKeep(mark);
    doc.removeKeep('k1');
    expect(JSON.stringify(doc.split)).toBe(before);
    expect(stableKey(doc.split)).toBe(stableKey(JSON.parse(before)));
    expect('keeps' in normaliseSplit(doc.split)).toBe(false);
    // Fit's cuts replace the cuts and nothing else; removing a cut leaves them too
    doc.addKeep(mark);
    doc.setSplit({ cuts: [{ position: [0, 0, 100], normal: [0, 0, 1] }] });
    doc.removeCut(doc.split.cuts[0].id);
    expect(doc.split.keep).toEqual([{ id: 'k1', name: 'Detail 1', ...mark }]);
    // the history holds its own copies
    doc.split.keep[0].box.min[0] = 999;
    doc.undo();
    expect(doc.split.keep[0].box.min[0]).toBe(-72);
  });

  it('a detail moves with the model: its click, its normal and its box, and reset brings them back', () => {
    const doc = new Document();
    doc.setBase('stl', 'ribbon');
    doc.addKeep(mark);
    doc.transformBase(new Matrix4().makeRotationZ(Math.PI / 2));
    const [k] = doc.split.keep;
    expect(r(k.point)).toEqual([47, 0, 135]);
    expect(r(k.normal)).toEqual([1, 0, 0]);
    expect({ min: r(k.box.min), max: r(k.box.max) }).toEqual({ min: [-7, -72, 112], max: [47, 72, 150] });
    doc.transformBase(new Matrix4().makeScale(2, 2, 2));
    expect(r(doc.split.keep[0].box.max)).toEqual([94, 144, 300]);
    doc.resetBase();
    expect({ min: r(doc.split.keep[0].box.min), max: r(doc.split.keep[0].box.max) }).toEqual(box);
    expect(r(doc.split.keep[0].point)).toEqual(mark.point);
  });
});

describe('cuts that come apart', () => {
  const Z = [0, 0, 1];
  const X = [1, 0, 0];
  const r = (v) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0);
  const lantern = () => {
    const doc = new Document();
    doc.setBase('stl', 'lantern');
    const id = doc.addCut({ position: [0, 0, 190], normal: Z });
    return { doc, id };
  };

  it('ticking a cut is one undo step that flags it and locks it on; doing it again changes nothing', () => {
    const { doc, id } = lantern();
    const steps = doc.history.length;
    doc.setCutJoint(id, {});
    expect(doc.split.cuts[0]).toEqual({ id, position: [0, 0, 190], normal: Z, joint: 'apart', hold: 'lock' });
    expect(doc.history.length).toBe(steps + 1);
    doc.setCutJoint(id, {}); // ticked already: the hold it has stays
    doc.setCutJoint(id, { hold: 'lock' });
    doc.setCutJoint('c9', {}); // no such cut
    expect(doc.history.length).toBe(steps + 1);
    doc.setCutJoint(id, { hold: 'light' });
    expect(doc.split.cuts[0].hold).toBe('light');
    doc.setCutJoint(id, {}); // a box ticked again keeps the hold chosen
    expect(doc.split.cuts[0].hold).toBe('light');
    expect(doc.history.length).toBe(steps + 2);
    // never coalesced with a drag before it
    doc.updateCut(id, { position: [0, 0, 191] }, { coalesce: 'split:drag' });
    doc.setCutJoint(id, { hold: 'lift' });
    doc.undo();
    expect(doc.split.cuts[0]).toMatchObject({ position: [0, 0, 191], hold: 'light' });
    doc.redo();
    expect(doc.split.cuts[0].hold).toBe('lift');
    // an unknown hold reads as Clicks on
    doc.setCutJoint(id, { hold: 'tight' });
    expect(doc.split.cuts[0].hold).toBe('snap');
  });

  it('unticking drops the hold too: the cut is an ordinary one again, and undo brings the flag back', () => {
    const { doc, id } = lantern();
    doc.setCutJoint(id, { hold: 'lift' });
    const steps = doc.history.length;
    doc.setCutJoint(id, null);
    expect(doc.split.cuts[0]).toEqual({ id, position: [0, 0, 190], normal: Z });
    expect(doc.history.length).toBe(steps + 1);
    doc.setCutJoint(id, null);
    expect(doc.history.length).toBe(steps + 1);
    doc.undo();
    expect(doc.split.cuts[0]).toMatchObject({ joint: 'apart', hold: 'lift' });
    doc.redo();
    expect(doc.split.cuts[0]).not.toHaveProperty('joint');
    expect(doc.split.cuts[0]).not.toHaveProperty('hold');
  });

  it('the flag survives moving and turning the cut, the model\'s transforms and its reset, undo and redo', () => {
    const { doc, id } = lantern();
    doc.setCutJoint(id, { hold: 'light' });
    for (const z of [180, 185, 192.5]) doc.updateCut(id, { position: [0, 0, z] }, { coalesce: 'split:drag' });
    doc.endCoalescing();
    expect(doc.split.cuts[0]).toEqual({ id, position: [0, 0, 192.5], normal: Z, joint: 'apart', hold: 'light' });
    doc.updateCut(id, { normal: X });
    expect(doc.split.cuts[0]).toMatchObject({ normal: X, joint: 'apart', hold: 'light' });
    doc.undo();
    expect(doc.split.cuts[0]).toMatchObject({ normal: Z, joint: 'apart', hold: 'light' });
    doc.transformBase(new Matrix4().makeRotationX(Math.PI / 2));
    expect(doc.split.cuts[0]).toMatchObject({ joint: 'apart', hold: 'light' });
    expect(r(doc.split.cuts[0].normal)).toEqual([0, -1, 0]);
    doc.resetBase();
    expect(r(doc.split.cuts[0].position)).toEqual([0, 0, 192.5]);
    expect(doc.split.cuts[0]).toMatchObject({ joint: 'apart', hold: 'light' });
    doc.undo();
    doc.undo();
    expect(doc.split.cuts[0]).toMatchObject({ normal: Z, joint: 'apart', hold: 'light' });
    doc.redo();
    expect(doc.split.cuts[0]).toMatchObject({ joint: 'apart', hold: 'light' });
  });

  it('cuts given whole keep the flag, normalised; any other joint, and a hold on a glued cut, are dropped', () => {
    const doc = new Document();
    doc.setBase('stl', 'box');
    doc.setSplit({
      cuts: [
        { id: 'c1', position: [0, 0, 52], normal: Z, joint: 'apart', hold: 'lift' },
        { id: 'c2', position: [0, 0, 20], normal: Z, joint: 'apart', hold: 'firm' },
        { id: 'c3', position: [10, 0, 0], normal: X, joint: 'pins', hold: 'snap' },
        { position: [20, 0, 0], normal: X, hold: 'light' },
      ],
    });
    expect(doc.split.cuts).toEqual([
      { id: 'c1', position: [0, 0, 52], normal: Z, joint: 'apart', hold: 'lift' },
      { id: 'c2', position: [0, 0, 20], normal: Z, joint: 'apart', hold: 'snap' },
      { id: 'c3', position: [10, 0, 0], normal: X },
      { id: 'c4', position: [20, 0, 0], normal: X },
    ]);
    // the same split again, keys in another order, is no change
    const steps = doc.history.length;
    doc.setSplit({ cuts: doc.split.cuts.map(({ hold, joint, ...c }) => ({ hold, ...c, joint })) });
    expect(doc.history.length).toBe(steps);
    // a new cut can come apart from the start, and then locks
    const id = doc.addCut({ position: [0, 0, 40], normal: Z, joint: 'apart' });
    expect(doc.split.cuts.at(-1)).toEqual({ id, position: [0, 0, 40], normal: Z, joint: 'apart', hold: 'lock' });
    expect(doc.addCut({ position: [0, 0, 45], normal: Z, hold: 'lift' })).toBe('c6');
    expect(doc.split.cuts.at(-1)).toEqual({ id: 'c6', position: [0, 0, 45], normal: Z });
  });

  it('a cut that already clicks on keeps clicking on: only a cut newly ticked locks, and undo and redo go between them', () => {
    const doc = new Document();
    doc.setBase('stl', 'lantern');
    doc.setSplit({ cuts: [{ id: 'c1', position: [0, 0, 190], normal: Z, joint: 'apart', hold: 'snap' }, { id: 'c2', position: [0, 0, 100], normal: Z }] });
    expect(doc.split.cuts[0].hold).toBe('snap');
    const steps = doc.history.length;
    doc.setCutJoint('c1', {}); // ticked again: it keeps its hold
    expect(doc.split.cuts[0].hold).toBe('snap');
    expect(doc.history.length).toBe(steps);
    doc.setCutJoint('c2', {});
    expect(doc.split.cuts[1]).toEqual({ id: 'c2', position: [0, 0, 100], normal: Z, joint: 'apart', hold: 'lock' });
    doc.setCutJoint('c1', { hold: 'lock' });
    expect(doc.split.cuts.map((c) => c.hold)).toEqual(['lock', 'lock']);
    doc.undo();
    expect(doc.split.cuts.map((c) => c.hold)).toEqual(['snap', 'lock']);
    doc.undo();
    expect(doc.split.cuts[1]).toEqual({ id: 'c2', position: [0, 0, 100], normal: Z });
    doc.redo();
    doc.redo();
    expect(doc.split.cuts.map((c) => c.hold)).toEqual(['lock', 'lock']);
    // unticked and ticked again, a cut that clicked on locks: unticking dropped its hold
    doc.undo();
    doc.setCutJoint('c1', null);
    doc.setCutJoint('c1', {});
    expect(doc.split.cuts[0].hold).toBe('lock');
    // a hold the document doesn't know still clicks on, as it always did
    doc.setCutJoint('c1', { hold: 'firm' });
    expect(doc.split.cuts[0].hold).toBe('snap');
  });

  it('the holds are the engine\'s', () => {
    expect(CUT_HOLDS).toEqual(['lock', 'snap', 'light', 'lift']);
    expect(CUT_HOLDS).toEqual(APART_HOLDS);
    expect(Object.isFrozen(CUT_HOLDS)).toBe(true);
  });
});

describe('parts that come off', () => {
  const Z = [0, 0, 1];
  const r6 = (v) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0);
  // the dome and cap inside the bat lantern's handle at 100 %: a circle round the lantern's axis at the face
  const dome = () => ({ position: [-0.0049, 0.0111, 28.9], normal: [...Z], joint: 'apart', part: { r: 7.895, side: 1, auto: true } });
  const lantern = () => {
    const doc = new Document();
    doc.setBase('stl', 'batlantern');
    return doc;
  };

  it('a part is added in one step, a drag of its circle or its face is one step each, and undo and redo go between them', () => {
    const doc = lantern();
    const id = doc.addCut(dome());
    expect(doc.split.cuts).toEqual([{ id, position: [-0.0049, 0.0111, 28.9], normal: Z, joint: 'apart', hold: 'lock', part: { r: 7.895, side: 1, auto: true } }]);
    expect(doc.history).toHaveLength(1);
    for (const r of [8, 8.5, 9]) doc.updateCut(id, { part: { r } }, { coalesce: `split:r:${id}` });
    doc.endCoalescing();
    for (const z of [29.1, 29.3]) doc.updateCut(id, { position: [-0.0049, 0.0111, z] }, { coalesce: 'split:drag' });
    doc.endCoalescing();
    expect(doc.history).toHaveLength(3);
    expect(doc.split.cuts[0]).toEqual({ id, position: [-0.0049, 0.0111, 29.3], normal: Z, joint: 'apart', hold: 'lock', part: { r: 9, side: 1, auto: false } });
    // the side turns over in the same way
    doc.updateCut(id, { part: { side: -1 } });
    expect(doc.split.cuts[0].part).toEqual({ r: 9, side: -1, auto: false });
    doc.undo();
    expect(doc.split.cuts[0].part).toEqual({ r: 9, side: 1, auto: false });
    doc.undo();
    expect(doc.split.cuts[0]).toMatchObject({ position: [-0.0049, 0.0111, 28.9], part: { r: 9, side: 1, auto: false } });
    doc.undo();
    expect(doc.split.cuts[0].part).toEqual({ r: 7.895, side: 1, auto: true });
    doc.undo();
    expect(doc.split).toBeNull();
    doc.redo();
    doc.redo();
    doc.redo();
    expect(doc.split.cuts[0]).toMatchObject({ position: [-0.0049, 0.0111, 29.3], part: { r: 9, side: 1, auto: false } });
    // a part can be given to a cut that comes apart, never to a glued one
    const full = doc.addCut({ position: [0, 0, 40], normal: Z, joint: 'apart', hold: 'snap' });
    const glued = doc.addCut({ position: [0, 0, 10], normal: Z });
    const steps = doc.history.length;
    doc.updateCut(glued, { part: { r: 5 } });
    expect(doc.history).toHaveLength(steps);
    expect(doc.split.cuts.find((c) => c.id === glued)).toEqual({ id: glued, position: [0, 0, 10], normal: Z });
    doc.updateCut(full, { part: { r: Number.NaN } }); // no circle to give it
    expect(doc.history).toHaveLength(steps);
    doc.updateCut(full, { part: { r: 5, side: 1 } });
    expect(doc.split.cuts.find((c) => c.id === full)).toEqual({ id: full, position: [0, 0, 40], normal: Z, joint: 'apart', hold: 'lock', part: { r: 5, side: 1, auto: false } });
    // a radius typed as no size keeps the circle, so the cut never becomes one through the handle
    for (const r of [0, -3, Number.NaN, Infinity, '', null]) doc.updateCut(id, { part: { r, side: -1 } });
    expect(doc.split.cuts[0].part).toEqual({ r: 9, side: -1, auto: false });
    doc.updateCut(id, { part: { auto: true } });
    const picked = doc.history.length;
    doc.refitParts([{ id, part: { r: Number.NaN } }]);
    expect(doc.split.cuts[0].part).toEqual({ r: 9, side: -1, auto: true });
    expect(doc.history).toHaveLength(picked);
  });

  it('the document keeps a part only on a cut that comes apart, with a radius; its side is +1 or −1, and it twist-locks unless it lifts off', () => {
    const doc = lantern();
    const at = (z) => ({ position: [0, 0, z], normal: [...Z] });
    doc.setSplit({
      cuts: [
        { id: 'c1', ...dome(), hold: 'lift' },
        { id: 'c2', ...at(10), part: { r: 5, side: 1, auto: true } }, // glued: no part
        { id: 'c3', ...at(20), joint: 'apart', part: { r: '6', side: -3, auto: 'yes', depth: 9 } },
        { id: 'c4', ...at(30), joint: 'apart', hold: 'light', part: { r: 4, side: 0, auto: true } },
        { id: 'c5', ...at(40), joint: 'apart', hold: 'snap', part: { r: 0, side: 1 } }, // no circle: a cut across the whole model
        { id: 'c6', ...at(50), joint: 'apart', hold: 'firm', part: { r: Infinity } },
        { id: 'c7', ...at(60), joint: 'apart', part: { r: -2 } },
        { id: 'c8', ...at(70), joint: 'apart', hold: 'snap', part: null },
      ],
    });
    expect(doc.split.cuts).toEqual([
      { id: 'c1', position: [-0.0049, 0.0111, 28.9], normal: Z, joint: 'apart', hold: 'lift', part: { r: 7.895, side: 1, auto: true } },
      { id: 'c2', ...at(10) },
      { id: 'c3', ...at(20), joint: 'apart', hold: 'lock', part: { r: 6, side: -1, auto: false } },
      { id: 'c4', ...at(30), joint: 'apart', hold: 'lock', part: { r: 4, side: 1, auto: true } }, // Clicks on lightly is no part's hold
      { id: 'c5', ...at(40), joint: 'apart', hold: 'snap' },
      { id: 'c6', ...at(50), joint: 'apart', hold: 'snap' },
      { id: 'c7', ...at(60), joint: 'apart', hold: 'lock' },
      { id: 'c8', ...at(70), joint: 'apart', hold: 'snap' },
    ]);
    // a part's hold is chosen as any other's, and one it doesn't have locks
    doc.setCutJoint('c1', { hold: 'lock' });
    expect(doc.split.cuts[0].hold).toBe('lock');
    const steps = doc.history.length;
    doc.setCutJoint('c1', { hold: 'snap' }); // it locks already
    expect(doc.history).toHaveLength(steps);
    doc.setCutJoint('c1', { hold: 'lift' });
    expect(doc.split.cuts[0]).toMatchObject({ hold: 'lift', part: { r: 7.895, side: 1, auto: true } }); // the hold is no change to where it is
  });

  it("a base's tea-light seat is kept on its part: switched in one step, undone and redone, the finder's pick still its own", () => {
    const doc = lantern();
    const base = () => ({ position: [-0.0168, 0.0448, 0], normal: [...Z], joint: 'apart', part: { r: 28.7, side: 1, auto: true, seat: true } });
    const id = doc.addCut(base());
    expect(doc.split.cuts[0].part).toEqual({ r: 28.7, side: 1, auto: true, seat: true });
    const steps = doc.history.length;
    doc.setPartSeat(id, false);
    expect(doc.history).toHaveLength(steps + 1);
    // the seat is no change to where the part is: it stays the finder's pick, so a Scale places it again
    expect(doc.split.cuts[0].part).toEqual({ r: 28.7, side: 1, auto: true, seat: false });
    doc.setPartSeat(id, false); // off already
    doc.setPartSeat('c9', true); // no such cut
    expect(doc.history).toHaveLength(steps + 1);
    doc.undo();
    expect(doc.split.cuts[0].part.seat).toBe(true);
    doc.redo();
    expect(doc.split.cuts[0].part.seat).toBe(false);
    // it goes with the part through every edit: a wider circle, a Scale, the finder placing it again
    doc.updateCut(id, { part: { r: 29 } });
    doc.transformBase(new Matrix4().makeScale(2, 2, 2));
    doc.refitParts([{ id, position: [0, 0, 0], part: { r: 57.4, side: 1 } }]);
    expect(doc.split.cuts[0].part).toEqual({ r: 58, side: 1, auto: false, seat: false });
    // a cut with no part has no seat to switch
    const full = doc.addCut({ position: [0, 0, 40], normal: Z, joint: 'apart' });
    const now = doc.history.length;
    doc.setPartSeat(full, true);
    expect(doc.history).toHaveLength(now);
    expect(doc.split.cuts.find((c) => c.id === full)).not.toHaveProperty('part');
  });

  it('a part saved without a tea-light seat is kept without one: only a yes or a no is kept', () => {
    const doc = lantern();
    const at = (z) => ({ position: [0, 0, z], normal: [...Z], joint: 'apart' });
    doc.setSplit({
      cuts: [
        { id: 'c1', ...at(0), part: { r: 28.7, side: 1, auto: true } },
        { id: 'c2', ...at(0), part: { r: 28.7, side: 1, auto: true, seat: false } },
        { id: 'c3', ...at(0), part: { r: 28.7, side: 1, auto: true, seat: 'yes' } },
        { id: 'c4', ...at(0), part: { r: 28.7, side: 1, auto: true, seat: true } },
      ],
    });
    expect(doc.split.cuts.map((c) => c.part)).toEqual([
      { r: 28.7, side: 1, auto: true },
      { r: 28.7, side: 1, auto: true, seat: false },
      { r: 28.7, side: 1, auto: true },
      { r: 28.7, side: 1, auto: true, seat: true },
    ]);
  });

  it('unticking Comes apart drops the part in the same step, and undo brings it back', () => {
    const doc = lantern();
    const id = doc.addCut(dome());
    const steps = doc.history.length;
    doc.setCutJoint(id, null);
    expect(doc.split.cuts[0]).toEqual({ id, position: [-0.0049, 0.0111, 28.9], normal: Z });
    expect(doc.history).toHaveLength(steps + 1);
    // ticked again it is a cut across the whole model: the circle went with the flag
    doc.setCutJoint(id, {});
    expect(doc.split.cuts[0]).toEqual({ id, position: [-0.0049, 0.0111, 28.9], normal: Z, joint: 'apart', hold: 'lock' });
    doc.undo();
    doc.undo();
    expect(doc.split.cuts[0]).toEqual({ id, position: [-0.0049, 0.0111, 28.9], normal: Z, joint: 'apart', hold: 'lock', part: { r: 7.895, side: 1, auto: true } });
  });

  it('a part moves and grows with the model: Scale, the inches fix, quarter turns and a mirror, and reset takes it back', () => {
    const doc = lantern();
    doc.addCut(dome());
    doc.transformBase(new Matrix4().makeScale(4, 4, 4));
    const [scaled] = doc.split.cuts;
    expect(r6(scaled.position)).toEqual([-0.0196, 0.0444, 115.6]);
    expect(scaled.part.r).toBeCloseTo(31.58, 9);
    expect(scaled.part).toMatchObject({ side: 1, auto: true }); // still where the finder put it, for the refit
    // a quarter turn keeps the circle's size; the part still lies along its normal, which turned with it
    doc.transformBase(new Matrix4().makeRotationX(Math.PI / 2));
    const [turned] = doc.split.cuts;
    expect(turned.part.r).toBeCloseTo(31.58, 9);
    expect(r6(turned.normal)).toEqual([0, -1, 0]);
    expect(r6(turned.position)).toEqual([-0.0196, -115.6, 0.0444]);
    expect(turned.part.side).toBe(1);
    doc.resetBase();
    expect(doc.split.cuts[0].part.r).toBeCloseTo(7.895, 9);
    expect(r6(doc.split.cuts[0].position)).toEqual([-0.0049, 0.0111, 28.9]);
    expect(r6(doc.split.cuts[0].normal)).toEqual(Z);
    // millimetres from inches
    doc.transformBase(new Matrix4().makeScale(25.4, 25.4, 25.4));
    expect(doc.split.cuts[0].part.r).toBeCloseTo(200.533, 9);
    expect(doc.split.cuts[0].position[2]).toBeCloseTo(734.06, 9);
    doc.undo();
    expect(doc.split.cuts[0].part.r).toBeCloseTo(7.895, 9);
    // mirrored, the dome lies below its plane, along the normal that the mirror turned over
    doc.transformBase(new Matrix4().makeScale(1, 1, -1));
    const [mirrored] = doc.split.cuts;
    expect(mirrored.part).toEqual({ r: 7.895, side: 1, auto: true });
    expect(r6(mirrored.normal)).toEqual([0, 0, -1]);
    const { parts } = normaliseSplit(doc.split, { min: [-12.5, -12.5, -50], max: [12.5, 12.5, 0] });
    expect(parts).toEqual([{ id: 'c1', letter: 'A', axis: 2, at: -28.9, centre: [-0.0049, 0.0111], r: 7.895, side: -1, hold: 'lock', auto: true }]);
    // a text item has no circle to grow
    const [item] = transformItems([createItem({ position: [0, 0, 5], normal: Z })], new Matrix4().makeScale(4, 4, 4));
    expect(item).not.toHaveProperty('part');
  });

  it('a JSON round trip is no change, and the history keeps its own copy of each part', () => {
    const doc = lantern();
    doc.addCut(dome());
    doc.addCut({ position: [0, 0, 0], normal: Z, joint: 'apart', hold: 'lift', part: { r: 9.3, side: 1, auto: false } });
    const saved = JSON.parse(JSON.stringify(doc.split));
    const steps = doc.history.length;
    doc.setSplit(saved);
    expect(doc.history).toHaveLength(steps);
    expect(doc.split).toEqual(saved);
    // a part changed in place changes this step only
    doc.commit((s) => {
      s.split.cuts[0].part.r = 20;
    });
    expect(doc.split.cuts[0].part.r).toBe(20);
    expect(doc.undo()).toBe(true);
    expect(doc.split.cuts[0].part.r).toBe(7.895);
    expect(doc.redo()).toBe(true);
    expect(doc.split.cuts[0].part.r).toBe(20);
    // the part handed in is copied, not kept
    const given = dome();
    doc.addCut(given);
    given.part.r = 99;
    expect(doc.split.cuts.at(-1).part.r).toBe(7.895);
  });

  it('a change to a part is the user\'s and the finder no longer moves it; a click on the model is the finder\'s pick again', () => {
    const doc = lantern();
    const id = doc.addCut(dome());
    const steps = doc.history.length;
    // released where it was: no step, and still the finder's
    doc.updateCut(id, { position: [-0.0049, 0.0111, 28.9] });
    doc.updateCut(id, { part: { r: 7.895 } });
    expect(doc.history).toHaveLength(steps);
    expect(doc.split.cuts[0].part.auto).toBe(true);
    doc.updateCut(id, { position: [-0.0049, 0.0111, 29.1] });
    expect(doc.split.cuts[0].part).toEqual({ r: 7.895, side: 1, auto: false });
    // a typed value or a drag cannot make it the finder's again; picking it can
    doc.updateCut(id, { part: { auto: false, r: 7.9 } });
    expect(doc.split.cuts[0].part.auto).toBe(false);
    const before = doc.history.length;
    doc.updateCut(id, { position: [-0.0049, 0.0111, 29.0], part: { r: 7.872, side: 1, auto: true } });
    expect(doc.split.cuts[0].part).toEqual({ r: 7.872, side: 1, auto: true });
    // picked again where it already is, a part the user had changed is the finder's again, in a step of its own
    doc.updateCut(id, { part: { r: 7.5 } });
    doc.updateCut(id, { part: { r: 7.5, auto: true } });
    expect(doc.split.cuts[0].part).toEqual({ r: 7.5, side: 1, auto: true });
    expect(doc.history).toHaveLength(before + 3);
    doc.undo();
    expect(doc.split.cuts[0].part).toEqual({ r: 7.5, side: 1, auto: false });
  });

  it('the finder\'s refit after a Scale joins the Scale\'s step; one that comes too late does nothing, or is a step of its own', () => {
    const doc = lantern();
    const lid = doc.addCut(dome());
    const own = doc.addCut({ position: [0, 0, 1], normal: Z, joint: 'apart', part: { r: 9.32, side: 1, auto: false } });
    const top = doc.addCut({ position: [0, 0, 45], normal: Z, joint: 'apart', hold: 'lift' });
    const steps = doc.history.length;
    const step = doc.transformBase(new Matrix4().makeScale(4, 4, 4));
    expect(doc.history).toHaveLength(steps + 1);
    const seen = modelPlacementKey(doc.base);
    // the finder's pick at 400 %, which need not be the face at 100 % scaled
    const fits = [
      { id: lid, position: [-0.0196, 0.0444, 115.4], part: { r: 31.505, side: 1 } },
      { id: own, position: [0, 0, 0], part: { r: 37.28, side: 1 } }, // the user's own: left alone
      { id: top, position: [0, 0, 100], part: { r: 30, side: 1 } }, // no part: left alone
    ];
    doc.refitParts(fits, { base: seen, step });
    expect(doc.history).toHaveLength(steps + 1);
    expect(doc.split.cuts.find((c) => c.id === lid)).toEqual({ id: lid, position: [-0.0196, 0.0444, 115.4], normal: Z, joint: 'apart', hold: 'lock', part: { r: 31.505, side: 1, auto: true } });
    expect(doc.split.cuts.find((c) => c.id === own).part.r).toBeCloseTo(37.28, 9);
    expect(r6(doc.split.cuts.find((c) => c.id === own).position)).toEqual([0, 0, 4]);
    expect(doc.split.cuts.find((c) => c.id === top)).toEqual({ id: top, position: [0, 0, 180], normal: Z, joint: 'apart', hold: 'lift' });
    // one undo takes back the Scale and the refit together
    doc.undo();
    expect(doc.history).toHaveLength(steps);
    expect(doc.split.cuts[0]).toEqual({ id: lid, position: [-0.0049, 0.0111, 28.9], normal: Z, joint: 'apart', hold: 'lock', part: { r: 7.895, side: 1, auto: true } });
    // the refit for a Scale that was undone does nothing
    doc.refitParts(fits, { base: seen, step });
    expect(doc.split.cuts[0].position).toEqual([-0.0049, 0.0111, 28.9]);
    expect(doc.history).toHaveLength(steps);
    // redo brings back the Scale with its refit
    doc.redo();
    expect(doc.split.cuts[0].position).toEqual([-0.0196, 0.0444, 115.4]);
    doc.undo();
    // after another edit the refit is a step of its own, and a refit that changes nothing is none
    const again = doc.transformBase(new Matrix4().makeScale(4, 4, 4));
    expect(again).not.toBe(step);
    // two transforms in a row are two steps, and a refit for the model before the last does nothing
    doc.transformBase(new Matrix4().makeScale(0.5, 0.5, 0.5));
    expect(doc.history).toHaveLength(steps + 2);
    doc.refitParts(fits, { base: seen, step: again });
    expect(doc.split.cuts[0].part.r).toBeCloseTo(15.79, 9);
    doc.undo();
    doc.addItem({ text: 'BAT', position: [0, 0, 20], normal: [0, 1, 0] });
    doc.refitParts(fits, { base: modelPlacementKey(doc.base), step: again });
    expect(doc.history).toHaveLength(steps + 3);
    expect(doc.split.cuts[0].position).toEqual([-0.0196, 0.0444, 115.4]);
    doc.refitParts(fits, { base: modelPlacementKey(doc.base), step: again });
    expect(doc.history).toHaveLength(steps + 3);
    doc.undo();
    expect(r6(doc.split.cuts[0].position)).toEqual([-0.0196, 0.0444, 115.6]);
    expect(doc.items).toHaveLength(1);
    // a reset is a step a refit can join too, and a transform with no model makes none
    const back = doc.resetBase();
    doc.refitParts([{ id: lid, position: [-0.0049, 0.0111, 29], part: { r: 7.872 } }], { base: modelPlacementKey(doc.base), step: back });
    expect(doc.split.cuts[0].part).toEqual({ r: 7.872, side: 1, auto: true });
    doc.undo();
    expect(r6(doc.split.cuts[0].position)).toEqual([-0.0196, 0.0444, 115.6]);
    expect(new Document().transformBase(new Matrix4())).toBeNull();
    expect(new Document().resetBase()).toBeNull();
  });
});
