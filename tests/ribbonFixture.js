// A column with a ribbon wrapped round it, for keeping a detail whole when a model is split: the ribbon is fused to
// the column over two short stretches only, so a cut through it can leave an end of it loose, or held on a short root.
// Call setup() first.
import { manifold } from '../src/manifold.js';

/** A box from min to max (mm). */
const box = (min, max) => manifold().Manifold.cube(max.map((v, a) => v - min[a]), false).translate(min);

/**
 * The fixture: a base 160 × 110 × 15 and a column r 40 up to z 260, with a ribbon r 41–47 at z 120–150 wrapped round
 * it over −95°…+85° (0° the front, −y; +90° is +x). The 1 mm gap between them is filled, fusing the ribbon to the
 * column, over −30°…+8° (z 120–140) and over −60°…−40° (z 120–138). Its tails stand out to x ±72, drooping to z 112.
 * One shell; a bed 120 × 120 × 300 needs one X cut. Right of x 10 the ribbon touches the column nowhere: a cut there
 * leaves its right end loose, hooked round the column's right flank.
 * @returns {Manifold} the caller's
 */
export function ribbonColumn({ seg = 96 } = {}) {
  const { Manifold, CrossSection } = manifold();
  const temps = [];
  const t = (m) => {
    temps.push(m);
    return m;
  };
  try {
    // a wedge of the plane from the column's axis, between two angles (degrees, 0 the front)
    const sector = (a0, a1, r = 80) => {
      const pts = [[0, 0]];
      for (let a = a0; a <= a1 + 1e-9; a += 2.5) pts.push([r * Math.sin((a * Math.PI) / 180), -r * Math.cos((a * Math.PI) / 180)]);
      return t(new CrossSection([pts], 'Positive'));
    };
    const ring = (r0, r1, z0, z1) => t(t(t(Manifold.cylinder(z1 - z0, r1, r1, seg)).subtract(t(Manifold.cylinder(z1 - z0, r0, r0, seg)))).translate([0, 0, z0]));
    const arc = (m, a0, a1, z0, z1) => t(m.intersect(t(t(sector(a0, a1).extrude(z1 - z0)).translate([0, 0, z0]))));
    const parts = [
      t(box([-80, -55, 0], [80, 55, 15])),
      t(t(Manifold.cylinder(245, 40, 40, seg)).translate([0, 0, 15])),
      arc(ring(41, 47, 120, 150), -95, 85, 120, 150),
      arc(ring(39.5, 41.5, 120, 140), -30, 8, 120, 140),
      arc(ring(39.5, 41.5, 120, 138), -60, -40, 120, 138),
      t(box([44, -5, 112], [72, 1, 145])),
      t(box([-72, 1, 112], [-44, 7, 145])),
    ];
    return Manifold.union(parts);
  } finally {
    temps.forEach((m) => m.delete());
  }
}
