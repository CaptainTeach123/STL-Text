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

/**
 * Rotation (degrees about X, Y, Z) that turns the chosen side of a part so it
 * faces down (-Z), i.e. becomes the face that touches the model.
 */
export const ATTACH_ROTATIONS = {
  bottom: [0, 0, 0],
  top: [180, 0, 0],
  front: [90, 0, 0], // -Y side down
  back: [-90, 0, 0], // +Y side down
  left: [0, -90, 0], // -X side down
  right: [0, 90, 0], // +X side down
};

/** Outward direction of each side of a part as it was loaded. */
const PART_SIDES = {
  bottom: [0, 0, -1],
  top: [0, 0, 1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
};

const RAD = Math.PI / 180;

/** Rotation by degrees about X, then Y, then Z (Rz·Ry·Rx) – the order Manifold's rotate() uses. */
export function eulerMatrix([x, y, z]) {
  return new Matrix4()
    .makeRotationZ(z * RAD)
    .multiply(new Matrix4().makeRotationY(y * RAD))
    .multiply(new Matrix4().makeRotationX(x * RAD));
}

/**
 * Rotation from part space (the STL as loaded) to model space for a part
 * item's pose: the attach side turned down, then tilt and roll, then the
 * placement frame on the surface (normal and spin). Mirrors how the engine
 * builds the part.
 */
export function partRotation(item) {
  const attach = eulerMatrix(ATTACH_ROTATIONS[item.attach] ?? ATTACH_ROTATIONS.bottom);
  const turn = eulerMatrix([item.tilt || 0, item.roll || 0, 0]);
  const { x, y, z } = placementFrame(item.normal, item.spin ?? 0);
  return new Matrix4().makeBasis(x, y, z).multiply(turn).multiply(attach);
}

/** Which side of a part ('bottom', 'top', 'front', 'back', 'left', 'right') faces `direction` (model space) in its current pose. */
export function sideFacing(item, direction) {
  const local = new Vector3(...direction).applyMatrix4(partRotation(item).transpose());
  let best = 'bottom';
  let bestDot = -Infinity;
  for (const [side, dir] of Object.entries(PART_SIDES)) {
    const d = local.dot(new Vector3(...dir));
    if (d > bestDot) {
      best = side;
      bestDot = d;
    }
  }
  return best;
}

/**
 * Placement patch that lays a part on the model at `hit` (a surface point
 * with its outward normal): the side of the part that currently faces the
 * surface becomes the side it attaches by, flat on the surface, keeping the
 * spin. Tilt and roll are cleared so that side really lies on the model.
 */
export function snapPartTo(item, { point, normal }) {
  const n = new Vector3(...normal).normalize();
  return { position: [...point], normal: n.toArray(), attach: sideFacing(item, n.clone().negate().toArray()), tilt: 0, roll: 0 };
}

/** THREE.Matrix4 -> 16 element column-major array (what Manifold expects). */
export function toMat4(matrix) {
  return Array.from(matrix.elements);
}
