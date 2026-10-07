import { beforeAll, describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { Editor, samplePlaque } from '../src/editor.js';
import { describe as describeMesh, geometryToManifold, manifoldToGeometry, NotWatertightError, toDisplayGeometry } from '../src/mesh.js';
import { parseSTL, writeBinarySTL } from '../src/stl.js';
import { placementMatrix } from '../src/placement.js';
import { buildTextSolid } from '../src/textGeometry.js';
import { boxSolid, bounds, inter, isClosed, setup, soupOf } from './helpers.js';

let font;
beforeAll(async () => {
  await setup();
  font = inter();
});

const volumeOf = (geometry) => {
  const m = geometryToManifold(geometry);
  const v = m.volume();
  m.delete();
  return v;
};

describe('geometryToManifold', () => {
  it('welds an unindexed STL-style soup into a solid', () => {
    const box = boxSolid(10, 10, 10);
    const m = geometryToManifold(soupOf(box));
    expect(m.volume()).toBeCloseTo(1000, 3);
    expect(m.numVert()).toBe(8);
    m.delete();
    box.delete();
  });

  it('fixes inside-out (inverted normal) meshes', () => {
    const box = boxSolid(10, 10, 10);
    const m = geometryToManifold(soupOf(box, { flip: true }));
    expect(m.volume()).toBeCloseTo(1000, 3);
    m.delete();
    box.delete();
  });

  it('reports meshes with holes', () => {
    const box = boxSolid(10, 10, 10);
    expect(() => geometryToManifold(soupOf(box, { dropTriangles: 1 }))).toThrow(NotWatertightError);
    box.delete();
  });
});

describe('Editor', () => {
  const topMatrix = (z) => placementMatrix({ position: [0, 0, z], normal: [0, 0, 1], spin: 0 });

  it('embosses text onto a model and stays watertight', () => {
    const editor = new Editor();
    const box = boxSolid(60, 30, 6); // z from -3 to 3
    editor.load(soupOf(box), 'box');
    const before = volumeOf(editor.model.geometry);
    const text = buildTextSolid(font, 'Hello', { size: 10, depth: 1.5, overlap: 0.4, mode: 'emboss' });

    const { fallback } = editor.applyText(text, topMatrix(3), 'emboss');
    expect(fallback).toBe(false);
    expect(isClosed(editor.model.geometry)).toBe(true);
    expect(volumeOf(editor.model.geometry)).toBeGreaterThan(before);
    editor.model.geometry.computeBoundingBox();
    expect(editor.model.geometry.boundingBox.max.z).toBeCloseTo(4.5, 3); // 3 + 1.5
    expect(editor.model.geometry.boundingBox.min.z).toBeCloseTo(-3, 3);
    text.delete();
    box.delete();
  });

  it('engraves text into a model without changing its outer size', () => {
    const editor = new Editor();
    const box = boxSolid(60, 30, 6);
    editor.load(soupOf(box), 'box');
    const before = volumeOf(editor.model.geometry);
    const text = buildTextSolid(font, 'Hello', { size: 10, depth: 2, overlap: 0.4, mode: 'engrave' });

    editor.applyText(text, topMatrix(3), 'engrave');
    expect(isClosed(editor.model.geometry)).toBe(true);
    expect(volumeOf(editor.model.geometry)).toBeLessThan(before);
    editor.model.geometry.computeBoundingBox();
    expect(editor.model.geometry.boundingBox.max.z).toBeCloseTo(3, 3);
    text.delete();
    box.delete();
  });

  it('places text on a side wall using the surface normal', () => {
    const editor = new Editor();
    const box = boxSolid(60, 30, 20); // y from -15 to 15
    editor.load(soupOf(box), 'box');
    const text = buildTextSolid(font, 'Hi', { size: 8, depth: 1, overlap: 0.4, mode: 'emboss' });
    editor.applyText(text, placementMatrix({ position: [0, -15, 0], normal: [0, -1, 0] }), 'emboss');
    editor.model.geometry.computeBoundingBox();
    expect(editor.model.geometry.boundingBox.min.y).toBeCloseTo(-16, 3);
    expect(editor.model.geometry.boundingBox.max.y).toBeCloseTo(15, 3);
    text.delete();
    box.delete();
  });

  it('undo restores the previous solid', () => {
    const editor = new Editor();
    const box = boxSolid();
    editor.load(soupOf(box), 'box');
    const before = volumeOf(editor.model.geometry);
    const text = buildTextSolid(font, 'A', { size: 5, depth: 1, overlap: 0.4, mode: 'emboss' });
    editor.applyText(text, topMatrix(3), 'emboss');
    expect(editor.canUndo).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(volumeOf(editor.model.geometry)).toBeCloseTo(before, 6);
    expect(editor.canUndo).toBe(false);
    expect(editor.undo()).toBe(false);
    text.delete();
    box.delete();
  });

  it('can stack several texts', () => {
    const editor = new Editor();
    const box = boxSolid(80, 40, 6);
    editor.load(soupOf(box), 'box');
    const a = buildTextSolid(font, 'One', { size: 8, depth: 1, overlap: 0.4 });
    const b = buildTextSolid(font, 'Two', { size: 8, depth: 1, overlap: 0.4 });
    editor.applyText(a, placementMatrix({ position: [-20, 0, 3], normal: [0, 0, 1] }), 'emboss');
    editor.applyText(b, placementMatrix({ position: [20, 0, 3], normal: [0, 0, 1] }), 'emboss');
    expect(isClosed(editor.model.geometry)).toBe(true);
    expect(editor.history).toHaveLength(2);
    [a, b, box].forEach((s) => s.delete());
  });

  it('embosses onto a non-watertight model as a separate shell, but refuses to engrave', () => {
    const editor = new Editor();
    const box = boxSolid();
    const { watertight } = editor.load(soupOf(box, { dropTriangles: 1 }), 'broken');
    expect(watertight).toBe(false);
    const text = buildTextSolid(font, 'A', { size: 5, depth: 1, overlap: 0.4 });
    expect(() => editor.applyText(text, topMatrix(3), 'engrave')).toThrow(NotWatertightError);
    const { fallback } = editor.applyText(text, topMatrix(3), 'emboss');
    expect(fallback).toBe(true);
    expect(editor.model.geometry.attributes.position.count).toBeGreaterThan(11 * 3);
    text.delete();
    box.delete();
  });

  it('exports an STL that loads back as the same solid', () => {
    const editor = new Editor();
    editor.loadSolid(samplePlaque(), 'plaque');
    const text = buildTextSolid(font, 'STL', { size: 10, depth: 1, overlap: 0.4 });
    editor.applyText(text, topMatrix(4), 'emboss');
    const buffer = writeBinarySTL(editor.model.geometry);
    const back = parseSTL(buffer);
    expect(volumeOf(back)).toBeCloseTo(volumeOf(editor.model.geometry), 2);
    text.delete();
  });

  it('refuses to apply when no model is loaded', () => {
    const editor = new Editor();
    expect(() => editor.applyText({}, new Matrix4(), 'emboss')).toThrow(/Load a model/);
  });
});

describe('samplePlaque', () => {
  it('is a 70 x 30 x 4 rounded slab', () => {
    const p = samplePlaque();
    const b = bounds(p);
    expect(b.size[0]).toBeCloseTo(70, 3);
    expect(b.size[1]).toBeCloseTo(30, 3);
    expect(b.size[2]).toBeCloseTo(4, 3);
    expect(p.volume()).toBeLessThan(70 * 30 * 4);
    expect(isClosed(manifoldToGeometry(p))).toBe(true);
    p.delete();
  });
});

describe('display helpers', () => {
  it('describe() reports size and triangle count for indexed and soup geometry', () => {
    const box = boxSolid(10, 20, 30);
    const indexed = describeMesh(manifoldToGeometry(box));
    expect(indexed.size).toEqual([10, 20, 30]);
    expect(indexed.triangles).toBe(12);
    expect(describeMesh(soupOf(box)).triangles).toBe(12);
    box.delete();
  });

  it('toDisplayGeometry() adds normals without touching the source geometry', () => {
    const box = boxSolid(10, 10, 10);
    const soup = soupOf(box);
    const display = toDisplayGeometry(soup);
    expect(display.attributes.normal).toBeDefined();
    expect(soup.attributes.normal).toBeUndefined();
    expect(display).not.toBe(soup);
    const indexed = manifoldToGeometry(box);
    expect(toDisplayGeometry(indexed).attributes.normal).toBeDefined();
    expect(indexed.attributes.normal).toBeUndefined();
    box.delete();
  });
});
