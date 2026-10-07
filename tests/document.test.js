import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { Document, createItem, frameOf, placeKey, shapeKey, stableKey, transformItems } from '../src/document.js';

describe('keys', () => {
  it('stableKey ignores key order and slider jitter', () => {
    expect(stableKey({ b: 1, a: [1, 2] })).toBe(stableKey({ a: [1, 2], b: 1 }));
    expect(stableKey({ x: 0.123456 })).toBe(stableKey({ x: 0.12349 }));
    expect(stableKey({ x: 0.1 })).not.toBe(stableKey({ x: 0.2 }));
  });

  it('shapeKey changes with typography, placeKey with placement', () => {
    const a = createItem({ text: 'Hi' });
    const moved = { ...a, position: [1, 2, 3] };
    const bigger = { ...a, size: 12 };
    expect(shapeKey(a)).toBe(shapeKey(moved));
    expect(placeKey(a)).not.toBe(placeKey(moved));
    expect(shapeKey(a)).not.toBe(shapeKey(bigger));
    expect(placeKey(a)).toBe(placeKey(bigger));
    expect(shapeKey(a, 'inter:100')).not.toBe(shapeKey(a, 'inter:200')); // re-uploaded font
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
    const a = doc.addItem({ text: 'A' });
    const b = doc.addItem({ text: 'B' });
    expect(doc.selected.id).toBe(b.id);
    doc.updateItem(a.id, { size: 12 });
    expect(doc.items[0].size).toBe(12);
    doc.deleteItem(b.id);
    expect(doc.items).toHaveLength(1);
    expect(doc.selected.id).toBe(a.id);
    expect(doc.undo()).toBe(true); // delete
    expect(doc.items).toHaveLength(2);
    expect(doc.undo()).toBe(true); // size
    expect(doc.items[0].size).toBe(10);
    expect(doc.redo()).toBe(true);
    expect(doc.items[0].size).toBe(12);
    expect(doc.canRedo).toBe(true);
  });

  it('coalesces slider drags into one undo step', () => {
    const doc = new Document();
    const a = doc.addItem({ text: 'A' });
    doc.updateItem(a.id, { size: 11 }, { coalesce: 'size' });
    doc.updateItem(a.id, { size: 12 }, { coalesce: 'size' });
    doc.updateItem(a.id, { size: 13 }, { coalesce: 'size' });
    doc.endCoalescing();
    doc.updateItem(a.id, { size: 14 }, { coalesce: 'size' });
    expect(doc.undo()).toBe(true);
    expect(doc.items[0].size).toBe(13);
    expect(doc.undo()).toBe(true);
    expect(doc.items[0].size).toBe(10);
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
