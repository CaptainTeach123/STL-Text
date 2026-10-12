import { beforeAll, describe, expect, it } from 'vitest';
import { DoubleSide, Ray, Triangle, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { manifold } from '../src/manifold.js';
import { manifoldToGeometry } from '../src/mesh.js';
import { clickRadius, surfaceNormalAt } from '../src/surfaceNormal.js';
import { setup } from './helpers.js';

beforeAll(async () => {
  await setup();
});

const angle = (a, b) => (Math.acos(Math.min(1, Math.abs(new Vector3(...a).normalize().dot(new Vector3(...b).normalize())))) * 180) / Math.PI;

/** A plate whose top is crumpled: every vertex of the top pushed up or down by up to `amp` (a sculpted, noisy surface). */
function crumpledPlate(amp, seed = 7) {
  const { Manifold } = manifold();
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const plate = Manifold.cube([40, 40, 4], true).refineToLength(0.8);
  const out = plate.warpBatch((v, n) => {
    for (let i = 0; i < n; i++) if (v[i * 3 + 2] > 1.99) v[i * 3 + 2] += (rnd() * 2 - 1) * amp;
  });
  plate.delete();
  return out;
}

/** The hit of a ray straight down at (x, y), with the normal of the triangle hit. */
function clickAt(bvh, geometry, x, y) {
  const hit = bvh.raycastFirst(new Ray(new Vector3(x, y, 50), new Vector3(0, 0, -1)), DoubleSide);
  const tri = new Triangle();
  const pos = geometry.attributes.position;
  const idx = geometry.index;
  tri.setFromAttributeAndIndices(pos, idx.getX(hit.faceIndex * 3), idx.getX(hit.faceIndex * 3 + 1), idx.getX(hit.faceIndex * 3 + 2));
  return { point: hit.point.toArray(), normal: tri.getNormal(new Vector3()).toArray() };
}

describe('surfaceNormalAt', () => {
  it('faces the way a crumpled surface does, where the triangle under the cursor leans', () => {
    const plate = crumpledPlate(0.25);
    const geometry = manifoldToGeometry(plate);
    const bvh = new MeshBVH(geometry);
    let worstRaw = 0;
    let worst = 0;
    for (const [x, y] of [[0, 0], [3.3, -2.1], [-7.7, 5.2], [10.1, 9.4], [-12.6, -8.8]]) {
      const { point, normal } = clickAt(bvh, geometry, x, y);
      worstRaw = Math.max(worstRaw, angle(normal, [0, 0, 1]));
      worst = Math.max(worst, angle(surfaceNormalAt(bvh, point, normal, clickRadius(0.8)), [0, 0, 1]));
    }
    expect(worstRaw).toBeGreaterThan(15); // the raw triangles lean a lot ...
    expect(worst).toBeLessThan(5); // ... the surface does not
    plate.delete();
  });

  it('keeps the face of a clean model: a click next to a chamfer or an edge is not tilted by it', () => {
    const { Manifold } = manifold();
    // a 20 x 20 x 10 block with a 45° chamfer along one top edge: the top runs to x = 10 - 5·√2 ≈ 2.93
    const block = Manifold.cube([20, 20, 10], true);
    const cutter = Manifold.cube([10, 30, 10], true).rotate([0, 45, 0]).translate(10, 0, 5);
    const chamfered = block.subtract(cutter);
    const geometry = manifoldToGeometry(chamfered);
    const bvh = new MeshBVH(geometry);
    const n = surfaceNormalAt(bvh, [1.5, 0, 5], [0, 0, 1], 6); // 1.4 mm from where the chamfer starts
    expect(angle(n, [0, 0, 1])).toBeLessThan(1e-6);
    const side = surfaceNormalAt(bvh, [0, -10, 4], [0, -1, 0], 6); // on the side, 1 mm under the top edge
    expect(angle(side, [0, -1, 0])).toBeLessThan(1e-6);
    [block, cutter, chamfered].forEach((m) => m.delete());
  });

  it('never counts the other side of a thin sheet, and follows a curve at the point', () => {
    const { Manifold } = manifold();
    const sheet = Manifold.cube([40, 40, 0.6], true);
    const g = manifoldToGeometry(sheet);
    expect(angle(surfaceNormalAt(new MeshBVH(g), [0, 0, 0.3], [0, 0, 1], 6), [0, 0, 1])).toBeLessThan(1e-6);
    const cyl = Manifold.cylinder(40, 10, 10, 96, true);
    const gc = manifoldToGeometry(cyl);
    const n = surfaceNormalAt(new MeshBVH(gc), [10, 0, 0], [1, 0, 0], 4);
    expect(angle(n, [1, 0, 0])).toBeLessThan(1);
    [sheet, cyl].forEach((m) => m.delete());
  });
});
