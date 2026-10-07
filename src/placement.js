import { Matrix4, Vector3 } from 'three';

/** Outward surface normals for the "snap to side" buttons. */
export const SIDES = {
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
};

/**
 * Orthonormal frame for text lying on a surface.
 *   Z = surface normal, Y = "up" on the surface, X = reading direction.
 * "Up" follows world +Z so text stands upright on walls; on floors/ceilings
 * it follows +Y. `spin` (degrees) then rotates the text about the normal.
 */
export function placementFrame(normal, spinDeg = 0) {
  const z = new Vector3(...normal).normalize();
  const ref = Math.abs(z.z) > 0.99 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
  const y = ref.sub(z.clone().multiplyScalar(ref.dot(z))).normalize();
  const x = new Vector3().crossVectors(y, z).normalize();
  const a = (spinDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const xs = x.clone().multiplyScalar(c).addScaledVector(y, s);
  const ys = y.clone().multiplyScalar(c).addScaledVector(x, -s);
  return { x: xs, y: ys, z };
}

/** Local text space -> model space. */
export function placementMatrix({ position, normal, spin = 0 }) {
  const { x, y, z } = placementFrame(normal, spin);
  return new Matrix4().makeBasis(x, y, z).setPosition(new Vector3(...position));
}

/** THREE.Matrix4 -> 16 element column-major array (what Manifold expects). */
export function toMat4(matrix) {
  return Array.from(matrix.elements);
}
