import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, Vector3 } from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { manifold } from './manifold.js';
import { triangleSoup } from './stl.js';

export class NotWatertightError extends Error {
  constructor() {
    super('This model is not watertight (it has holes or broken edges).');
    this.name = 'NotWatertightError';
  }
}

function manifoldFromSoup(soup, flip) {
  const { Mesh, Manifold } = manifold();
  const triangles = soup.length / 9;
  const triVerts = new Uint32Array(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    triVerts[t * 3] = t * 3;
    triVerts[t * 3 + 1] = t * 3 + (flip ? 2 : 1);
    triVerts[t * 3 + 2] = t * 3 + (flip ? 1 : 2);
  }
  const mesh = new Mesh({ numProp: 3, vertProperties: soup, triVerts });
  mesh.merge(); // weld duplicate vertices (STL stores every corner separately)
  try {
    return Manifold.ofMesh(mesh);
  } catch {
    throw new NotWatertightError();
  }
}

/**
 * Convert a geometry to a Manifold, welding vertices and fixing inside-out
 * winding. Throws NotWatertightError when the surface has holes.
 * The caller owns (and must `.delete()`) the result.
 */
export function geometryToManifold(geometry) {
  const soup = triangleSoup(geometry);
  let m = manifoldFromSoup(soup, false);
  if (m.volume() < 0) {
    m.delete();
    m = manifoldFromSoup(soup, true); // inverted normals
  }
  if (m.isEmpty()) {
    m.delete();
    throw new NotWatertightError();
  }
  return m;
}

/** Manifold -> indexed BufferGeometry (positions only). */
export function manifoldToGeometry(m) {
  const mesh = m.getMesh();
  const stride = mesh.numProp;
  const positions = new Float32Array(mesh.vertProperties.length / stride * 3);
  for (let i = 0, n = positions.length / 3; i < n; i++) {
    positions[i * 3] = mesh.vertProperties[i * stride];
    positions[i * 3 + 1] = mesh.vertProperties[i * stride + 1];
    positions[i * 3 + 2] = mesh.vertProperties[i * stride + 2];
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(new Uint32BufferAttribute(mesh.triVerts.slice(), 1));
  return geometry;
}

/** Concatenate geometries into one non-indexed triangle soup. */
export function mergeGeometries(geometries) {
  const parts = geometries.map(triangleSoup);
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(out, 3));
  return geometry;
}

/** Geometry with smooth-but-creased normals, ready for rendering. */
export function toDisplayGeometry(geometry) {
  // toCreasedNormals() returns non-indexed input as-is; clone so the viewer
  // (which builds a BVH on it) never touches the geometry we export from.
  return toCreasedNormals(geometry.index ? geometry : geometry.clone(), Math.PI / 5);
}

/** Bounding box size + triangle count, for the info readout. */
export function describe(geometry) {
  geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new Vector3());
  const index = geometry.index;
  return {
    size: [size.x, size.y, size.z],
    triangles: (index ? index.count : geometry.attributes.position.count) / 3,
  };
}
