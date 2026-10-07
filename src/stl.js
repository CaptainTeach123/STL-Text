import { BufferGeometry, Float32BufferAttribute } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

/** Parse a binary or ASCII STL into a (non-indexed) BufferGeometry. */
export function parseSTL(arrayBuffer) {
  const geometry = new STLLoader().parse(arrayBuffer);
  if (!geometry.attributes.position || geometry.attributes.position.count < 3) {
    throw new Error('That file does not contain any triangles.');
  }
  // Drop anything but positions; normals are recomputed for display.
  const clean = new BufferGeometry();
  clean.setAttribute('position', new Float32BufferAttribute(geometry.attributes.position.array, 3));
  geometry.dispose();
  return clean;
}

/** Triangle corner positions as a flat Float32Array (9 floats per triangle). */
export function triangleSoup(geometry) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const count = index ? index.count : pos.count;
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const v = index ? index.getX(i) : i;
    out[i * 3] = pos.getX(v);
    out[i * 3 + 1] = pos.getY(v);
    out[i * 3 + 2] = pos.getZ(v);
  }
  return out;
}

/** Serialise a geometry (indexed or not) or a Float32Array triangle soup to a binary STL ArrayBuffer. */
export function writeBinarySTL(geometry, header = 'STL-Text') {
  const soup = geometry instanceof Float32Array ? geometry : triangleSoup(geometry);
  const triangles = Math.floor(soup.length / 9);
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  const bytes = new TextEncoder().encode(header.slice(0, 79));
  new Uint8Array(buffer, 0, bytes.length).set(bytes);
  view.setUint32(80, triangles, true);

  let offset = 84;
  for (let t = 0; t < triangles; t++) {
    const i = t * 9;
    const ax = soup[i], ay = soup[i + 1], az = soup[i + 2];
    const ux = soup[i + 3] - ax, uy = soup[i + 4] - ay, uz = soup[i + 5] - az;
    const vx = soup[i + 6] - ax, vy = soup[i + 7] - ay, vz = soup[i + 8] - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);
    for (let k = 0; k < 9; k++) view.setFloat32(offset + 12 + k * 4, soup[i + k], true);
    view.setUint16(offset + 48, 0, true);
    offset += 50;
  }
  return buffer;
}
