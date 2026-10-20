import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { manifold } from './manifold.js';
import { cornerNormals, normalsTopology } from './normals.js';
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

/** Triangle soup (9 floats per triangle) of a Manifold's surface. */
export function manifoldToSoup(m) {
  const mesh = m.getMesh();
  const stride = mesh.numProp;
  const tri = mesh.triVerts;
  const out = new Float32Array(tri.length * 3);
  for (let i = 0; i < tri.length; i++) {
    const v = tri[i] * stride;
    out[i * 3] = mesh.vertProperties[v];
    out[i * 3 + 1] = mesh.vertProperties[v + 1];
    out[i * 3 + 2] = mesh.vertProperties[v + 2];
  }
  return out;
}

/**
 * A triangle soup without the triangles two of whose corners are the same
 * point as written (float32): a boolean's hair-thin sliver can round to one,
 * which a slicer reports as a degenerate facet and an open edge and removes.
 * Removing it is collapsing the sliver's short edge, so the rest still meets
 * edge to edge. The soup itself when it has none.
 */
export function withoutCollapsed(soup) {
  const same = (i, j) => soup[i] === soup[j] && soup[i + 1] === soup[j + 1] && soup[i + 2] === soup[j + 2];
  const keep = [];
  const n = soup.length / 9;
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    if (!same(i, i + 3) && !same(i + 3, i + 6) && !same(i, i + 6)) keep.push(t);
  }
  if (keep.length === n) return soup;
  const out = new Float32Array(keep.length * 9);
  keep.forEach((t, k) => out.set(soup.subarray(t * 9, t * 9 + 9), k * 9));
  return out;
}

/** Concatenate triangle soups. */
export function concatSoups(soups) {
  const parts = soups.filter((s) => s && s.length);
  if (parts.length === 1) return parts[0];
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * A solid's shaded vertices: one per vertex and smooth group, creased at
 * `creaseDeg` – what Manifold's `calculateNormals(0, creaseDeg)` gives, worked
 * out in plain JavaScript (`cornerNormals`, checked against it corner by
 * corner). Manifold's own takes time with every sharp edge, a minute on a
 * scanned or generated model of a million triangles, where this takes a
 * fraction of a second. A mesh with properties of its own (its vertices split
 * along their seams) is shaded by Manifold, which sees through the seams.
 */
function shadedMesh(solid, creaseDeg) {
  const mesh = solid.getMesh();
  const index = mesh.triVerts;
  if (mesh.numProp !== 3) {
    const shaded = solid.calculateNormals(0, creaseDeg);
    const m = shaded.getMesh(0);
    shaded.delete();
    const count = m.vertProperties.length / m.numProp;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      for (let a = 0; a < 3; a++) {
        positions[i * 3 + a] = m.vertProperties[i * m.numProp + a];
        normals[i * 3 + a] = m.vertProperties[i * m.numProp + 3 + a];
      }
    }
    return { positions, normals, index: m.triVerts.slice() };
  }
  const xyz = mesh.vertProperties;
  const topology = normalsTopology(index, xyz.length / 3);
  const corner = cornerNormals(xyz, index, creaseDeg, topology);
  // each corner takes the shaded vertex of the first corner at its vertex with the same normal
  const { offsets, corners } = topology;
  const out = new Uint32Array(index.length);
  const first = [];
  const same = (c, d) => corner[3 * c] === corner[3 * d] && corner[3 * c + 1] === corner[3 * d + 1] && corner[3 * c + 2] === corner[3 * d + 2];
  for (let v = 0; v + 1 < offsets.length; v++) {
    const from = first.length;
    for (let i = offsets[v]; i < offsets[v + 1]; i++) {
      const c = corners[i];
      let k = from;
      while (k < first.length && !same(first[k], c)) k++;
      if (k === first.length) first.push(c);
      out[c] = k;
    }
  }
  const positions = new Float32Array(first.length * 3);
  const normals = new Float32Array(first.length * 3);
  first.forEach((c, k) => {
    const v = index[c] * 3;
    for (let a = 0; a < 3; a++) {
      positions[k * 3 + a] = xyz[v + a];
      normals[k * 3 + a] = corner[3 * c + a];
    }
  });
  return { positions, normals, index: out };
}

/**
 * Renderable buffers for a solid plus (optionally) a soup of triangles that
 * are not part of it (unrepairable pieces). Normals are creased at 36° for
 * the solid, as Manifold shades it (`shadedMesh`), and flat per face for the
 * soup.
 *
 * Returns { positions, normals, index, passthroughStart } where
 * passthroughStart is the first *triangle* index belonging to the soup
 * (== total triangles when there is none). All arrays are transferable.
 */
export function displayBuffers(solid, passthrough = null) {
  let sPos = new Float32Array(0);
  let sNor = new Float32Array(0);
  let sIdx = new Uint32Array(0);
  if (solid && !solid.isEmpty()) ({ positions: sPos, normals: sNor, index: sIdx } = shadedMesh(solid, 36));
  const pTris = passthrough ? Math.floor(passthrough.length / 9) : 0;
  const total = sPos.length / 3 + pTris * 3;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const index = new Uint32Array(sIdx.length + pTris * 3);
  positions.set(sPos);
  normals.set(sNor);
  index.set(sIdx);
  let vo = sPos.length / 3;
  let io = sIdx.length;
  for (let t = 0; t < pTris; t++) {
    const i = t * 9;
    const ax = passthrough[i], ay = passthrough[i + 1], az = passthrough[i + 2];
    const ux = passthrough[i + 3] - ax, uy = passthrough[i + 4] - ay, uz = passthrough[i + 5] - az;
    const vx = passthrough[i + 6] - ax, vy = passthrough[i + 7] - ay, vz = passthrough[i + 8] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (let k = 0; k < 3; k++) {
      positions.set(passthrough.subarray(i + k * 3, i + k * 3 + 3), (vo + k) * 3);
      normals[(vo + k) * 3] = nx;
      normals[(vo + k) * 3 + 1] = ny;
      normals[(vo + k) * 3 + 2] = nz;
      index[io + k] = vo + k;
    }
    vo += 3;
    io += 3;
  }
  return { positions, normals, index, passthroughStart: sIdx.length / 3, solidVertexCount: sPos.length / 3 };
}

/** BufferGeometry from display buffers (shares the arrays). */
export function geometryFromBuffers({ positions, normals, index }) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  if (normals) geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  if (index) geometry.setIndex(new Uint32BufferAttribute(index, 1));
  return geometry;
}

/**
 * Build a BVH for picking / sampling on `geometry` and return it with its
 * serialised form (roots + the reordered index), ready to be transferred to
 * the main thread and deserialised there with MeshBVH.deserialize().
 */
export function buildBVH(geometry) {
  const bvh = new MeshBVH(geometry, { indirect: false });
  const serialized = MeshBVH.serialize(bvh, { cloneBuffers: true });
  return { bvh, roots: serialized.roots, index: serialized.index, version: serialized.version };
}
