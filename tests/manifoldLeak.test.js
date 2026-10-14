import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Module from 'manifold-3d/manifold.js';
import { initManifold } from '../src/manifold.js';

// The binding keeps its WASM memory to itself, so it is caught as the app's module is instantiated.
let memory = null;
let app; // the app's module, as initManifold() gives it
let plain; // the same binding without the app's changes, to compare results with
const ballast = [];

const MB = 1 << 20;
const POINTS = 1024; // per ring: 16 kB of points

beforeAll(async () => {
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async function (...args) {
    const result = await instantiate.apply(this, args);
    memory ??= Object.values((result.instance ?? result).exports).find((v) => v instanceof WebAssembly.Memory);
    return result;
  };
  try {
    app = await initManifold();
  } finally {
    WebAssembly.instantiate = instantiate;
  }
  plain = await Module();
  plain.setup();
  // The heap starts at 16 MB, nearly all of it free, and a leak only shows once it outgrows the free room. Fill
  // it until it grows once: from then on the free room is at most a fifth of the heap, so a short run shows a leak.
  const start = memory.buffer.byteLength;
  while (memory.buffer.byteLength === start) {
    const v = new app.Vector_vec2();
    v.resize(MB / 16, { x: 0, y: 0 });
    ballast.push(v);
  }
});

afterAll(() => {
  for (const v of ballast) v.delete();
});

const ringOf = (r, n = POINTS, cx = 0, cy = 0) =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);

describe('the binding does not leak WASM memory', () => {
  // Every call below used to leave at least one ring of POINTS points behind, so each is repeated until that
  // would be more than the heap's free room (a fifth of it, and what the calls before freed) and grow the heap.
  const cases = {
    'CrossSection.toPolygons()': (m, s) => void s.circle.toPolygons(),
    'CrossSection.extrude()': (m, s) => s.circle.extrude(1).delete(),
    'CrossSection.extrude(…, center)': (m, s) => s.circle.extrude(1, 0, 0, [1, 1], true).delete(),
    'CrossSection.revolve()': (m, s) => s.profile.revolve(3).delete(),
    'Manifold.extrude(cross-section)': (m, s) => m.Manifold.extrude(s.circle, 1).delete(),
    'Manifold.extrude(points)': (m, s) => m.Manifold.extrude([s.ring], 1).delete(),
    'Manifold.revolve(points)': (m, s) => m.Manifold.revolve(s.profilePoints, 3).delete(),
    'new CrossSection(points)': (m, s) => new m.CrossSection([s.ring]).delete(),
    'CrossSection.ofPolygons(points)': (m, s) => m.CrossSection.ofPolygons([s.ring], 'NonZero').delete(),
    'CrossSection.add(points)': (m, s) => s.circle.add([s.ring]).delete(),
    'CrossSection.union(points, …)': (m, s) => m.CrossSection.union([[s.ring], s.circle]).delete(),
    'triangulate(points)': (m, s) => void m.triangulate([s.ring]),
    // a control that never leaked
    'Manifold.cube()': (m) => m.Manifold.cube(1).delete(),
  };

  for (const [name, call] of Object.entries(cases)) {
    it(name, () => {
      const { CrossSection } = app;
      const ring = ringOf(10);
      const circle = new CrossSection([ring]);
      const profile = circle.translate(20, 0); // off the axis, to revolve
      const shapes = { ring, circle, profile, profilePoints: profile.toPolygons() };
      try {
        expect(memory).toBeInstanceOf(WebAssembly.Memory);
        for (let i = 0; i < 10; i++) call(app, shapes); // let the heap settle
        const before = memory.buffer.byteLength;
        const calls = Math.ceil((before / 5 + MB) / (16 * POINTS));
        for (let i = 0; i < calls && memory.buffer.byteLength === before; i++) call(app, shapes);
        expect((memory.buffer.byteLength - before) / MB).toBe(0);
      } finally {
        circle.delete();
        profile.delete();
      }
    });
  }
});

describe('the leak-free calls give what the binding gives', () => {
  /** A comparable summary of what a call returned, after which it is deleted. */
  const summary = (x) => {
    if (Array.isArray(x)) return x.map(summary);
    if (x && typeof x.getMesh === 'function') {
      const mesh = x.getMesh();
      x.delete();
      return { numProp: mesh.numProp, triVerts: Array.from(mesh.triVerts), vertProperties: Array.from(mesh.vertProperties) };
    }
    if (x && typeof x.toPolygons === 'function') {
      const polygons = x.toPolygons();
      x.delete();
      return { polygons };
    }
    return x;
  };
  /** `fn` on the app's module and on the plain binding, their results compared. */
  const same = (fn) => {
    const ours = summary(fn(app));
    expect(ours).toEqual(summary(fn(plain)));
    return ours;
  };
  // two rings, the second a hole, wound as the binding's own outlines are
  const outline = [ringOf(10, 48), ringOf(4, 24, 2, 1).reverse()];
  /** `fn` given a cross-section of the two rings (moved by dx), deleted after. */
  const onRings = (fn, dx = 0) => (m) => {
    const made = new m.CrossSection(outline, 'Positive');
    const cs = dx ? made.translate(dx, 0) : made;
    try {
      return fn(cs, m);
    } finally {
      if (cs !== made) cs.delete();
      made.delete();
    }
  };

  it('reading and building outlines', () => {
    const read = same(onRings((cs) => cs.toPolygons()));
    expect(read.length).toBe(2);
    same((m) => new m.CrossSection(outline[0])); // one ring, given bare
    same((m) => new m.CrossSection([[...outline[0]].reverse()])); // clockwise, so empty by the default fill rule
    same((m) => new m.CrossSection([outline[0].map(([x, y]) => ({ x, y }))]));
    for (const rule of ['Positive', 'Negative', 'NonZero', 'EvenOdd']) {
      same((m) => m.CrossSection.ofPolygons(outline, rule));
      same((m) => m.CrossSection.ofPolygons([[...outline[0]].reverse()], rule));
    }
    expect(() => new app.CrossSection([])).toThrow(TypeError);
    expect(() => new plain.CrossSection([])).toThrow(TypeError);
    same((m) => m.triangulate(outline));
  });

  it('extruding and revolving', () => {
    same(onRings((cs) => cs.extrude(3)));
    same(onRings((cs) => cs.extrude(3, 4, 30, [0.5, 0.8])));
    same(onRings((cs) => cs.extrude(3, 2, 0, 0.5))); // a lone number scales x only, as the binding has it
    same(onRings((cs) => cs.extrude(3, 0, 0, [1, 1], true)));
    same(onRings((cs, m) => m.Manifold.extrude(cs, 2, 0, 15, [1, 1], true)));
    same((m) => m.Manifold.extrude(outline, 2));
    same((m) => m.Manifold.extrude(outline[0], 2, 1, 0, [2, 2]));
    same(onRings((cs) => cs.revolve(16), 20));
    same(onRings((cs) => cs.revolve(16, 90), 20));
    same(onRings((cs, m) => m.Manifold.revolve(cs, 12), 20));
    same((m) => m.Manifold.revolve(outline.map((r) => r.map(([x, y]) => [x + 20, y])), 12, 180));
  });

  it('booleans with points or cross-sections', () => {
    const other = ringOf(6, 32, 8, 0);
    for (const op of ['add', 'subtract', 'intersect']) {
      same(onRings((cs) => cs[op]([other])));
      same(onRings((cs) => cs[op]([[...other].reverse()])));
      same(onRings((cs, m) => {
        const b = new m.CrossSection([other]);
        try {
          return cs[op](b);
        } finally {
          b.delete();
        }
      }));
    }
    for (const op of ['compose', 'union', 'difference', 'intersection']) {
      same(onRings((cs, m) => m.CrossSection[op]([cs, [other]])));
      same((m) => m.CrossSection[op]([outline[0]], [other]));
    }
  });

  it('keeps the binding’s classes and statics', () => {
    const { CrossSection, Manifold } = app;
    const cs = CrossSection.square([2, 3]);
    expect(cs instanceof CrossSection).toBe(true);
    const cube = Manifold.cube(1);
    expect(cube instanceof CrossSection).toBe(false);
    cube.delete();
    for (const name of ['ofPolygons', 'square', 'circle', 'hull', 'compose', 'union', 'difference', 'intersection']) {
      expect(typeof CrossSection[name]).toBe('function');
    }
    expect(Object.getPrototypeOf(CrossSection.prototype)).toBe(Object.getPrototypeOf(cs));
    cs.delete();
  });
});
