/**
 * Clean decorations, generated: the well-formed versions of what an
 * AI-generated model's smudgy berries, stars, leaves, rosettes and sprigs
 * were meant to be. Each generator returns a Manifold that stands on the
 * z = 0 plane (its base) and rises to about `height`, centred on the z axis
 * by its bounding box so that a part placed by its bottom lands where the
 * detail was; `length` runs along +x. A `skirt` extends the shape below
 * z = 0 by that much, so that a part set on a curved surface reaches into
 * it all round instead of floating at its edges (the skirt is sunk).
 */

export const DECOR_KINDS = {
  berry: { label: 'Berry', params: ['radius'] },
  star: { label: 'Star', params: ['radius', 'height', 'points'] },
  leaf: { label: 'Leaf', params: ['length', 'width', 'height'] },
  holly: { label: 'Holly leaf', params: ['length', 'width', 'height'] },
  rosette: { label: 'Rosette', params: ['radius', 'height', 'petals'] },
  dome: { label: 'Dome', params: ['length', 'width', 'height'] },
  sprig: { label: 'Sprig', params: ['length', 'width', 'height'] },
};

const clamp = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** The spec's numbers, clamped to sane ranges, with defaults. */
export function normaliseDecorSpec(spec = {}) {
  const kind = DECOR_KINDS[spec.kind] ? spec.kind : 'berry';
  const round = (v) => Math.round(v * 100) / 100;
  const s = { kind };
  if (kind === 'berry') s.radius = round(clamp(spec.radius, 0.2, 100, 2));
  if (kind === 'star' || kind === 'rosette') {
    s.radius = round(clamp(spec.radius, 0.5, 100, 4));
    s.height = round(clamp(spec.height, 0.1, 100, s.radius * 0.35));
    if (kind === 'star') s.points = Math.round(clamp(spec.points, 4, 12, 5));
    else s.petals = Math.round(clamp(spec.petals, 5, 16, 8));
  }
  if (kind === 'leaf' || kind === 'holly' || kind === 'dome' || kind === 'sprig') {
    s.length = round(clamp(spec.length, 0.5, 300, 8));
    s.width = round(clamp(spec.width, 0.3, 300, s.length * (kind === 'sprig' ? 0.45 : 0.5)));
    s.height = round(clamp(spec.height, 0.1, 100, kind === 'dome' ? s.width * 0.45 : s.width * 0.3));
  }
  s.skirt = round(clamp(spec.skirt, 0, 50, 0));
  return s;
}

/** A stable id for a generated part with this spec. */
export function decorPartId(spec) {
  const s = normaliseDecorSpec(spec);
  return `decor-${Object.entries(s).map(([k, v]) => `${k}=${v}`).join('-')}`;
}

/** Counter-clockwise copy of a polygon (Manifold fills counter-clockwise contours). */
function ccw(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    area += x0 * y1 - x1 * y0;
  }
  return area < 0 ? points.slice().reverse() : points;
}

function leafOutline(length, width, { spikes = 0, n = 36 } = {}) {
  const half = (t) => {
    let v = Math.sin(Math.PI * t) ** 0.85;
    if (spikes) v *= 0.78 + 0.22 * Math.cos(2 * Math.PI * spikes * t + Math.PI); // dips between the spikes
    return (v * width) / 2;
  };
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push([(i / n - 0.5) * length, half(i / n)]);
  for (let i = n - 1; i > 0; i--) pts.push([(i / n - 0.5) * length, -half(i / n)]);
  return ccw(pts);
}

/**
 * Build the decoration. `wasm` is the Manifold module ({ Manifold, CrossSection }).
 * @returns {Manifold} a watertight solid, base at z = -skirt, bounding box centred on the z axis
 */
export function buildDecor(wasm, spec) {
  const { Manifold, CrossSection } = wasm;
  const s = normaliseDecorSpec(spec);
  const temps = [];
  const keep = (m) => (temps.push(m), m);
  const extrude = (points, height, scaleTop) => {
    const cs = new CrossSection([ccw(points)]);
    const m = cs.extrude(height, 1, 0, scaleTop);
    cs.delete();
    return keep(m);
  };
  const segments = (r) => Math.max(24, Math.min(128, Math.round(r * 16)));
  let m;
  switch (s.kind) {
    case 'berry': {
      // a sphere resting a third of the way into the surface, so it reads as a berry set on it, not a ball
      m = keep(Manifold.sphere(s.radius, segments(s.radius)).translate(0, 0, s.radius * 0.65));
      break;
    }
    case 'star': {
      const pts = [];
      for (let i = 0; i < s.points * 2; i++) {
        const a = (i * Math.PI) / s.points;
        const r = i % 2 === 0 ? s.radius : s.radius * 0.42;
        pts.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      m = extrude(pts, s.height, [0.1, 0.1]); // pyramidal facets meeting at a small top
      break;
    }
    case 'leaf':
    case 'holly': {
      // a roof-shaped leaf: the top narrows to a ridge along the midrib
      m = extrude(leafOutline(s.length, s.width, { spikes: s.kind === 'holly' ? 3 : 0 }), s.height, [0.6, 0.12]);
      break;
    }
    case 'rosette': {
      const n = 96;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n;
        const r = s.radius * (0.78 + 0.22 * Math.cos(s.petals * a));
        pts.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      const petals = extrude(pts, s.height, [0.4, 0.4]);
      const bud = Math.max(0.2, s.radius * 0.3);
      const centre = keep(Manifold.sphere(bud, segments(bud)).translate(0, 0, s.height * 0.6 + bud * 0.35));
      m = keep(petals.add(centre));
      break;
    }
    case 'dome': {
      const ball = keep(Manifold.sphere(1, 48).scale([s.length / 2, s.width / 2, s.height]));
      m = keep(ball.trimByPlane([0, 0, 1], 0));
      break;
    }
    case 'sprig': {
      // a stem along x with leaves alternating either side and a cluster of berries at the middle
      const L = s.length, W = s.width, H = s.height;
      const stemR = Math.max(0.25, Math.min(W * 0.08, H * 0.45));
      const angle = 48;
      const rad = (angle * Math.PI) / 180;
      const leafLen = Math.min(L * 0.5, ((W / 2) / Math.sin(rad)) * 1.05);
      const leafW = leafLen * 0.48;
      // the leaves point forward along the stem, their bases spread from behind the stem's tail to where the last
      // tip ends at the sprig's length
      const reach = 0.95 * leafLen * Math.cos(rad);
      const first = -L / 2 + Math.max(stemR * 2, L * 0.1);
      const last = Math.max(first, L / 2 - reach);
      m = keep(keep(keep(Manifold.cylinder(last + stemR - -L / 2, stemR * 1.15, stemR * 0.85, 24)).rotate([0, 90, 0])).translate(-L / 2, 0, stemR * 0.8));
      const count = Math.max(2, Math.min(12, Math.round((last - first) / (leafLen * 0.5)) + 1));
      for (let i = 0; i < count; i++) {
        const x = count === 1 ? first : first + ((last - first) * i) / (count - 1);
        const side = i % 2 === 0 ? 1 : -1;
        const leaf = extrude(leafOutline(leafLen, leafW, { spikes: 3 }), H * 0.75, [0.6, 0.12]);
        const placed = keep(keep(keep(leaf.translate(leafLen * 0.45, 0, 0)).rotate([0, -6, side * angle])).translate(x, 0, 0));
        m = keep(m.add(placed));
      }
      const br = Math.max(0.4, Math.min(W * 0.12, H * 0.9));
      for (let i = 0; i < 3; i++) {
        const a = (2 * Math.PI * i) / 3 + Math.PI / 6;
        const berry = keep(Manifold.sphere(br, segments(br)).translate(br * 0.95 * Math.cos(a), br * 0.95 * Math.sin(a), br * 0.75));
        m = keep(m.add(berry));
      }
      break;
    }
    default:
      throw new Error(`Unknown decoration "${s.kind}"`);
  }
  // the base: everything below z = 0 is cut off, then the footprint at z = 0 is drawn down as the skirt
  let solid = keep(m.trimByPlane([0, 0, 1], 0));
  if (s.skirt > 0) {
    const foot = keep(solid.slice(Math.min(0.02, s.height * 0.05)));
    if (!foot.isEmpty()) {
      const skirt = keep(keep(foot.extrude(s.skirt)).translate(0, 0, -s.skirt));
      solid = keep(solid.add(skirt));
    }
  }
  // centred on the z axis by its bounding box, as a part is seated
  const { min, max } = solid.boundingBox();
  const out = solid.translate(-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, 0);
  temps.forEach((t) => t.delete());
  return out;
}
