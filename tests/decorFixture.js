import { buildTopology, smoothField } from '../src/enhance.js';
import { buildDecor } from '../src/decor.js';
import { manifold } from '../src/manifold.js';

/**
 * A plate (or a cane) decorated with clean generated decorations at known
 * places, optionally smudged the way AI generation leaves them: the mesh is
 * refined, blurred by a few smoothing passes (edges and facets melt) and
 * given a little noise. Returns the solid, its mesh and the ground truth.
 *
 * @param {object} [options]
 * @param {Array<{ kind: string, at: number[], spin?: number, [param: string]: any }>} [options.decorations]
 * @param {number} [options.blur]   smoothing passes (0 = clean)
 * @param {number} [options.noise]  random jitter per vertex, mm
 * @param {'plate'|'cane'} [options.body]
 */
export function decoratedFixture({ decorations = DEFAULT_DECORATIONS, blur = 0, noise = 0, body = 'plate', seed = 11 } = {}) {
  const { Manifold, Mesh } = manifold();
  const temps = [];
  const keep = (m) => (temps.push(m), m);
  let model = body === 'cane' ? keep(keep(Manifold.cylinder(80, 12, 12, 96)).refineToLength(0.8)) : keep(keep(Manifold.cube([80, 80, 6], true)).refineToLength(0.8));
  const truth = [];
  for (const d of decorations) {
    const { at, spin = 0, ...spec } = d;
    const decor = keep(buildDecor(manifold(), { ...spec, skirt: 0.6 }));
    let placed;
    if (body === 'cane') {
      // `at` is [angle degrees, z]: the decoration stands on the cane's side, facing out
      const [deg, z] = at;
      placed = keep(keep(keep(decor.rotate([0, 0, spin])).rotate([0, 90, 0])).rotate([0, 0, deg]).translate(0, 0, z));
      const a = (deg * Math.PI) / 180;
      placed = keep(placed.translate(11.95 * Math.cos(a), 11.95 * Math.sin(a), 0));
      truth.push({ ...spec, spin, position: [12 * Math.cos(a), 12 * Math.sin(a), z], normal: [Math.cos(a), Math.sin(a), 0] });
    } else {
      placed = keep(keep(decor.rotate([0, 0, spin])).translate(at[0], at[1], 2.95)); // a hair sunk: no coplanar faces
      truth.push({ ...spec, spin, position: [at[0], at[1], 3], normal: [0, 0, 1] });
    }
    model = keep(model.add(placed));
  }
  // evenly meshed, like a generated model (the decorations come out of Manifold with long thin triangles)
  let out = keep(model.refineToLength(blur > 0 || noise > 0 ? 0.5 : 0.7));
  if (blur > 0 || noise > 0) {
    const m = out.getMesh();
    const stride = m.numProp;
    const V = m.vertProperties.length / stride;
    const pos = new Float64Array(V * 3);
    for (let v = 0; v < V; v++) for (let k = 0; k < 3; k++) pos[v * 3 + k] = m.vertProperties[v * stride + k];
    let p = pos;
    if (blur > 0) {
      const topo = buildTopology(pos, m.triVerts);
      const lam = new Float64Array(V).fill(0.5);
      p = smoothField(pos, topo, lam, blur, 3);
    }
    if (noise > 0) {
      let s = seed;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
      for (let i = 0; i < p.length; i++) p[i] += noise * rnd();
    }
    out = keep(Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: Float32Array.from(p), triVerts: m.triVerts })));
  }
  const mesh = out.getMesh();
  const result = { solid: Manifold.compose([out]), mesh: { positions: mesh.vertProperties, index: mesh.triVerts }, truth };
  temps.forEach((t) => t.delete());
  return result;
}

export const DEFAULT_DECORATIONS = [
  { kind: 'berry', radius: 2.5, at: [-28, 24] },
  { kind: 'star', radius: 6, height: 1.6, at: [0, 24], spin: 20 },
  { kind: 'leaf', length: 12, width: 6, height: 1.4, at: [28, 24], spin: -35 },
  { kind: 'rosette', radius: 5, height: 1.5, at: [-28, -4] },
  { kind: 'holly', length: 12, width: 6.5, height: 1.4, at: [2, -4], spin: 60 },
  { kind: 'sprig', length: 30, width: 11, height: 1.8, at: [0, -28], spin: 10 },
];
