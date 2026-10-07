import fs from 'node:fs';
import path from 'node:path';
import * as opentype from 'opentype.js';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { initManifold, manifold } from '../src/manifold.js';

export async function setup() {
  await initManifold();
}

export function loadFont(pkg, file) {
  const p = path.resolve('node_modules/@fontsource', pkg, 'files', file);
  const buf = fs.readFileSync(p);
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export const inter = () => loadFont('inter', 'inter-latin-700-normal.woff');

/** Geometry (indexed) of a Manifold box. */
export function boxSolid(w = 40, d = 20, h = 6) {
  return manifold().Manifold.cube([w, d, h], true);
}

/** Un-indexed triangle soup of a manifold – what an STL file looks like. */
export function soupOf(solid, { flip = false, dropTriangles = 0 } = {}) {
  const mesh = solid.getMesh();
  const tri = mesh.triVerts;
  const vp = mesh.vertProperties;
  const stride = mesh.numProp;
  const count = tri.length / 3 - dropTriangles;
  const out = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    const order = flip ? [0, 2, 1] : [0, 1, 2];
    order.forEach((corner, k) => {
      const v = tri[t * 3 + corner];
      for (let a = 0; a < 3; a++) out[t * 9 + k * 3 + a] = vp[v * stride + a];
    });
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(out, 3));
  return g;
}

/** True if every edge of an indexed geometry is shared by exactly two triangles. */
export function isClosed(geometry) {
  const index = geometry.index.array;
  const edges = new Map();
  for (let t = 0; t < index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = index[t + k];
      const b = index[t + ((k + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return [...edges.values()].every((n) => n === 2);
}

export function bounds(solid) {
  const { min, max } = solid.boundingBox();
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}
