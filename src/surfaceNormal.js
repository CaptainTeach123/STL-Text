import { Vector3 } from 'three';

/** Triangles facing further than this from the running mean are another surface (a chamfer, an edge), not noise. */
const AGREE = Math.cos((37 * Math.PI) / 180);
/** A result is backed by the triangles facing within this of it: a blend of two faces is backed by neither. */
const BACKED = Math.cos((15 * Math.PI) / 180);

/**
 * The direction a surface faces around a clicked point: the area-weighted mean normal of the triangles near the
 * point that face roughly the same way, rather than the normal of the one triangle under the cursor. On a sculpted
 * or AI-generated model a single triangle can lean 20–40° from the surface it belongs to, and text placed along it
 * leans with it; the mean over a small disc follows the surface. The mean is refined three times (each pass keeps
 * the triangles within 37° of the previous mean), so a crease of 37° or more – the edge of a flat top, a chamfer –
 * does not tilt a click next to it, and a thin sheet's other side never counts.
 *
 * @param {import('three-mesh-bvh').MeshBVH} bvh  over the model (in model space)
 * @param {number[]} point  the clicked point
 * @param {number[]} normal  the normal of the triangle hit
 * @param {number} radius  how far around the point to look (mm)
 * @returns {number[]} a unit normal (the input normal when nothing better is found)
 */
export function surfaceNormalAt(bvh, point, normal, radius) {
  const raw = new Vector3(...normal).normalize();
  if (!bvh || !(radius > 0) || !(raw.lengthSq() > 0)) return raw.toArray();
  const p = new Vector3(...point);
  const r2 = radius * radius;
  const closest = new Vector3();
  const n = new Vector3();
  const disc = (Math.PI * r2) / 2;
  const near = []; // [nx, ny, nz, weight] of the triangles reaching into the radius
  bvh.shapecast({
    intersectsBounds: (box) => box.distanceToPoint(p) <= radius,
    intersectsTriangle: (tri) => {
      tri.closestPointToPoint(p, closest);
      if (closest.distanceToSquared(p) > r2) return false;
      const area = tri.getArea();
      if (!(area > 0)) return false;
      tri.getNormal(n);
      // by area, but a large triangle of a coarse model counts as at most half the disc
      near.push(n.x, n.y, n.z, Math.min(area, disc));
      return false;
    },
  });
  // the area-weighted mean of the triangles within `cos` of `ref`, and the area that agrees with it
  const meanNear = (ref, cos) => {
    const acc = new Vector3();
    for (let i = 0; i < near.length; i += 4) {
      const d = near[i] * ref.x + near[i + 1] * ref.y + near[i + 2] * ref.z;
      if (d >= cos) {
        acc.x += near[i + 3] * near[i];
        acc.y += near[i + 3] * near[i + 1];
        acc.z += near[i + 3] * near[i + 2];
      }
    }
    return acc.lengthSq() > 0 ? acc.normalize() : null;
  };
  const support = (ref) => {
    let area = 0;
    for (let i = 0; i < near.length; i += 4) if (near[i] * ref.x + near[i + 1] * ref.y + near[i + 2] * ref.z >= BACKED) area += near[i + 3];
    return area;
  };
  // refined from two starts: the plain mean of the side that was clicked (right where the triangle hit is itself a
  // leaning one), and the triangle hit, which wins only when clearly more of the disc really faces its result (within
  // 15°): on a clean model next to a chamfer the plain mean is a blend of two faces that neither faces
  const refine = (start) => {
    let mean = start;
    for (let pass = 0; pass < 3; pass++) mean = meanNear(mean, AGREE) ?? mean;
    return mean;
  };
  const plain = meanNear(raw, 0);
  const fromPlain = plain ? refine(plain) : null;
  const fromHit = refine(raw);
  const best = fromPlain && support(fromPlain) * 1.5 >= support(fromHit) ? fromPlain : fromHit;
  // never turn the text away from the side that was clicked
  return best.dot(raw) > 0.5 ? best.toArray() : raw.toArray();
}

/**
 * The radius to average a click's normal over: about half a typical letter height (4 mm), more on a coarse mesh
 * (three triangles across), at most 8 mm. Over a disc that size the lean of single triangles averages out, while the
 * curve of a cane or a mug still reads as the normal at the clicked point (a disc centred on it is symmetric).
 */
export function clickRadius(triangleEdge) {
  return Math.min(8, Math.max(4, 3 * (triangleEdge || 0)));
}
