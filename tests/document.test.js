import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { APART_HOLDS } from '../src/split.js';
import { CUT_HOLDS, Document, SPLIT_DEFAULTS, coversKey, coversOf, createItem, createPart, createSpot, fontIds, frameOf, hasText, isSpot, itemLabel, itemText, linesOf, maxSize, modelPlacementKey, placeKey, shapeKey, spotsKey, stableKey, transformItems } from '../src/document.js';

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
    // a planned split arrives without ids; given ids are kept, repeats renumbered
    doc.setSplit({ cuts: [{ position: [-83.333, 0, 0], normal: X }, { position: [83.333, 0, 0], normal: X }] });
    expect(doc.split.cuts.map((c) => c.id)).toEqual(['c1', 'c2']);
    doc.setSplit({ cuts: [{ position: [0, 0, 0], normal: X }, { id: 'c4', position: [0, 0, 0], normal: Y }, { id: 'c4', position: [0, 0, 5], normal: [0, 0, 1] }] });
    expect(doc.split.cuts.map((c) => c.id)).toEqual(['c5', 'c4', 'c6']);
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

  it('ticking a cut is one undo step that flags it and holds it on by clicks; doing it again changes nothing', () => {
    const { doc, id } = lantern();
    const steps = doc.history.length;
    doc.setCutJoint(id, {});
    expect(doc.split.cuts[0]).toEqual({ id, position: [0, 0, 190], normal: Z, joint: 'apart', hold: 'snap' });
    expect(doc.history.length).toBe(steps + 1);
    doc.setCutJoint(id, {}); // ticked already: the hold it has stays
    doc.setCutJoint(id, { hold: 'snap' });
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
    // a new cut can come apart from the start
    const id = doc.addCut({ position: [0, 0, 40], normal: Z, joint: 'apart' });
    expect(doc.split.cuts.at(-1)).toEqual({ id, position: [0, 0, 40], normal: Z, joint: 'apart', hold: 'snap' });
    expect(doc.addCut({ position: [0, 0, 45], normal: Z, hold: 'lift' })).toBe('c6');
    expect(doc.split.cuts.at(-1)).toEqual({ id: 'c6', position: [0, 0, 45], normal: Z });
  });

  it('the holds are the engine\'s', () => {
    expect(CUT_HOLDS).toEqual(['snap', 'light', 'lift']);
    expect(CUT_HOLDS).toEqual(APART_HOLDS);
    expect(Object.isFrozen(CUT_HOLDS)).toBe(true);
  });
});
