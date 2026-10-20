// Models for finding the parts that come off, besides the lanterns of lanternFixture.js: a jar with a lid and a
// knob, a box with a bail standing on its lid, a mug open at the top with a handle on its side, a solid block, a
// hexagonal lantern whose chimney cap carries a bail, a hurricane lantern whose bail pivots on its sides, a pavilion
// whose dome stands on a band over posts and a lantern standing on a plate. Call setup() first.
import { manifold } from '../src/manifold.js';
import { box } from './lanternFixture.js';

/** Builds a model from its parts, deleting every temporary however it ends. */
function made(build) {
  const temps = [];
  const t = (m) => {
    temps.push(m);
    return m;
  };
  try {
    return build(t, manifold());
  } finally {
    for (const m of temps) m.delete();
  }
}

/** A round frustum from radius r0 at z0 to r1 at z1, `n` sides. */
const cone = (t, Manifold, r0, r1, z0, z1, n = 96) => t(t(Manifold.cylinder(z1 - z0, r0, r1, n)).translate([0, 0, z0]));

/** A jar: a tube r 30 (3 mm wall and floor) up to z 60, a lid r 31 from 60 to 70 (2 mm top) and a knob on it. */
export function jarSolid() {
  return made((t, { Manifold }) => {
    const body = t(cone(t, Manifold, 30, 30, 0, 60).subtract(cone(t, Manifold, 27, 27, 3, 61)));
    const lid = t(cone(t, Manifold, 31, 31, 60, 70).subtract(cone(t, Manifold, 27, 27, 59, 68)));
    return Manifold.union([body, lid, cone(t, Manifold, 6, 4, 70, 78, 48)]);
  });
}

/** A box 80 × 80 × 53 (3 mm walls, a flat 3 mm lid) with a bail – a ring standing on edge – on its lid. */
export function bailBoxSolid() {
  return made((t, { Manifold }) => {
    const shell = t(t(box([-40, -40, 0], [40, 40, 53])).subtract(t(box([-37, -37, 3], [37, 37, 50]))));
    const ring = t(t(t(t(Manifold.cylinder(6, 15, 15, 64, true)).subtract(t(Manifold.cylinder(7, 11, 11, 64, true)))).rotate([90, 0, 0])).translate([0, 0, 53 + 13]));
    return Manifold.union([shell, ring]);
  });
}

/** A mug: a tube r 40 (4 mm wall, 5 mm floor) up to z 100, open at the top, with a C handle on its side. */
export function mugSolid() {
  return made((t, { Manifold, CrossSection }) => {
    const body = t(cone(t, Manifold, 40, 40, 0, 100).subtract(cone(t, Manifold, 36, 36, 5, 101)));
    const tube = t(t(CrossSection.circle(5, 32)).translate([28, 0]));
    const handle = t(t(t(t(Manifold.revolve(tube, 64, 180)).rotate([90, 0, 0])).rotate([0, 90, 0])).translate([38, 0, 50]));
    return Manifold.union([body, handle]);
  });
}

/** A solid block 60 × 60 × 40 with a rounded top: nothing inside to open. */
export function blockSolid() {
  return made((t, { Manifold }) => {
    const dome = t(t(t(Manifold.sphere(30, 64)).translate([0, 0, 40])).intersect(t(box([-31, -31, 40], [31, 31, 80]))));
    return Manifold.union([t(box([-30, -30, 0], [30, 30, 40])), dome]);
  });
}

/**
 * A hexagonal lantern: a hexagonal tower (circumradius 40, 3.5 mm walls, a 4 mm floor) with a window in each side, a
 * hexagonal pyramid roof 4 mm thick open below, a round chimney cap on its apex, closed on top, and a bail on the cap.
 */
export function hexLanternSolid() {
  return made((t, { Manifold }) => {
    const hex = (R, z0, z1) => t(t(Manifold.cylinder(z1 - z0, R, R, 6)).translate([0, 0, z0]));
    let tower = t(hex(40, 0, 120).subtract(hex(36.5, 4, 121)));
    const windows = [];
    for (let k = 0; k < 6; k++) windows.push(t(t(box([20, -10, 30], [60, 10, 100])).rotate([0, 0, k * 60 + 30])));
    tower = t(tower.subtract(t(Manifold.union(windows))));
    const roof = t(t(t(Manifold.cylinder(40, 44, 6, 6)).translate([0, 0, 120])).subtract(t(t(Manifold.cylinder(36, 39, 5, 6)).translate([0, 0, 119.99]))));
    const cap = t(cone(t, Manifold, 10, 10, 150, 160, 48).subtract(cone(t, Manifold, 7, 7, 140, 157, 48)));
    const bail = t(t(t(t(Manifold.cylinder(4, 9, 9, 48, true)).subtract(t(Manifold.cylinder(5, 6, 6, 48, true)))).rotate([90, 0, 0])).translate([0, 0, 160 + 7]));
    return Manifold.union([tower, t(roof.subtract(cone(t, Manifold, 7, 7, 140, 170, 48))), cap, bail]);
  });
}

/**
 * A lid off the model's axis: a hollow box 80 × 80 × 40 (3 mm walls, a window in one) with a round hole r 12 through
 * its top at (20, 0), a collar r 12–14 round it up to z 46 and a cap r 15 over the collar from z 45.5 to 49 with a
 * knob; a post r 3 at (−25, 0) stands to z 70. The cap comes off inside a circle about the hole, not about the box's
 * middle.
 */
export function chimneyBoxSolid() {
  return made((t, { Manifold }) => {
    const shell = t(t(box([-40, -40, 0], [40, 40, 40])).subtract(t(box([-37, -37, 3], [37, 37, 37]))));
    const at = (m, x) => t(m.translate([x, 0, 0]));
    const hole = at(cone(t, Manifold, 12, 12, 30, 47, 64), 20);
    const collar = at(cone(t, Manifold, 14, 14, 39, 46, 64), 20);
    const cap = at(cone(t, Manifold, 15, 15, 45.5, 49, 64), 20);
    const knob = at(cone(t, Manifold, 4, 2, 49, 54, 32), 20);
    const post = at(cone(t, Manifold, 3, 3, 39, 70, 32), -25);
    const window = t(box([-10, -45, 10], [10, -35, 30]));
    const body = t(t(t(Manifold.union([shell, collar])).subtract(hole)).subtract(window));
    return Manifold.union([body, cap, knob, post]);
  });
}

/**
 * A hurricane lantern: a tube r 30 (3 mm wall and 4 mm floor) up to z 80 with six windows, a hollow dome r 30 (2.5 mm)
 * on it with a finial to z 120, and a wire bail on bosses at the tube's sides, its arms at x ±36 arching over to z 140:
 * the arch comes down near the cap only over the rim of the dome, 40 mm under it.
 */
export function hurricaneSolid() {
  return made((t, { Manifold, CrossSection }) => {
    let tube = t(cone(t, Manifold, 30, 30, 0, 80).subtract(cone(t, Manifold, 27, 27, 4, 81)));
    const windows = [];
    for (let k = 0; k < 6; k++) windows.push(t(t(box([20, -6, 15], [40, 6, 65])).rotate([0, 0, k * 60 + 30])));
    tube = t(tube.subtract(t(Manifold.union(windows))));
    const shell = t(t(Manifold.sphere(30, 96)).subtract(t(Manifold.sphere(27.5, 96))));
    const dome = t(t(shell.intersect(t(box([-40, -40, 0], [40, 40, 40])))).translate([0, 0, 80]));
    const parts = [tube, dome, cone(t, Manifold, 4, 1.5, 109, 120, 48)];
    for (const sx of [-1, 1]) {
      parts.push(t(t(t(Manifold.cylinder(8, 3, 3, 24)).rotate([0, 90, 0])).translate([sx > 0 ? 29 : -37, 0, 50])));
      parts.push(t(cone(t, Manifold, 2, 2, 50, 104, 24).translate([sx * 36, 0, 0])));
    }
    const wire = t(t(CrossSection.circle(2, 24)).translate([36, 0]));
    parts.push(t(t(t(Manifold.revolve(wire, 96, 180)).rotate([90, 0, 0])).translate([0, 0, 104])));
    return Manifold.union(parts);
  });
}

/**
 * A pavilion: a floor r 40, six posts at r 34 up to z 100, a ring band r 27.5–38 `band` mm tall at z 60, a hollow dome
 * r 30 (2.5 mm) on the band with a finial, and a crown ring over it on the posts.
 */
export function pavilionSolid(band) {
  return made((t, { Manifold }) => {
    const parts = [cone(t, Manifold, 40, 40, 0, 4)];
    for (let k = 0; k < 6; k++) parts.push(t(cone(t, Manifold, 2.5, 2.5, 0, 100, 24).translate([34 * Math.cos((k * Math.PI) / 3), 34 * Math.sin((k * Math.PI) / 3), 0])));
    parts.push(t(cone(t, Manifold, 38, 38, 60, 60 + band).subtract(cone(t, Manifold, 27.5, 27.5, 59, 62 + band))));
    const shell = t(t(Manifold.sphere(30, 96)).subtract(t(Manifold.sphere(27.5, 96))));
    parts.push(t(t(shell.intersect(t(box([-40, -40, 0], [40, 40, 40])))).translate([0, 0, 60 + band])));
    parts.push(cone(t, Manifold, 4, 1.5, 89 + band, 96, 48), t(cone(t, Manifold, 38, 38, 97, 100).subtract(cone(t, Manifold, 30, 30, 96, 101))));
    return Manifold.union(parts);
  });
}

/**
 * A lantern on a plate a little wider than itself: a plate r `plate` (`thick` mm) under a tube r 30 (3 mm wall) to
 * z 90 with six windows, a hollow dome r 30 (2.5 mm) and a finial to z 128.
 */
export function plinthLanternSolid(plate = 34, thick = 5) {
  return made((t, { Manifold }) => {
    let tube = t(cone(t, Manifold, 30, 30, thick, 90).subtract(cone(t, Manifold, 27, 27, thick - 1, 91)));
    const windows = [];
    for (let k = 0; k < 6; k++) windows.push(t(t(box([20, -6, 20], [40, 6, 75])).rotate([0, 0, k * 60 + 30])));
    tube = t(tube.subtract(t(Manifold.union(windows))));
    const shell = t(t(Manifold.sphere(30, 96)).subtract(t(Manifold.sphere(27.5, 96))));
    const dome = t(t(shell.intersect(t(box([-40, -40, 0], [40, 40, 40])))).translate([0, 0, 90]));
    return Manifold.union([cone(t, Manifold, plate, plate, 0, thick), tube, dome, cone(t, Manifold, 4, 1.5, 119, 128, 48)]);
  });
}
