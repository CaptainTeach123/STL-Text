import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { Document, coversKey, coversOf, createItem, createPart, createSpot, fontIds, frameOf, hasText, isSpot, itemLabel, itemText, linesOf, maxSize, placeKey, shapeKey, spotsKey, stableKey, transformItems } from '../src/document.js';

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
});
