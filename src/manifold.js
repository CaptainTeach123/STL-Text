import Module from 'manifold-3d/manifold.js';

let wasm = null;
let loading = null;

/**
 * Load the Manifold WASM module (once). In the browser pass the URL of the
 * .wasm file; in Node it is found automatically next to manifold.js.
 */
export function initManifold(wasmUrl) {
  loading ??= Module(wasmUrl ? { locateFile: () => wasmUrl } : undefined).then((m) => {
    m.setup();
    plugLeaks(m);
    wasm = m;
    return m;
  });
  return loading;
}

/** The loaded Manifold module. Call `initManifold()` first. */
export function manifold() {
  if (!wasm) throw new Error('Manifold has not been initialised yet.');
  return wasm;
}

// ---------- the binding's leaks ----------

// manifold-3d 3.5.4's JavaScript glue (what setup() puts over the C++ classes) makes C++ objects it never
// deletes, so WASM memory only grows, and the app makes these calls on every preview:
//  - toPolygons() deletes the outer vector it reads but not the copy of each ring that get() hands back;
//  - extrude() and revolve() never delete the outlines (_ToPolygons()) they pass on, and extrude(…, center)
//    never deletes the solid it then translates;
//  - building a cross-section from points (new CrossSection, ofPolygons, triangulate) never deletes the
//    rings it copies into the outer vector (it deletes fresh copies of them instead), and _Triangulate's
//    result is never deleted either;
//  - Manifold.extrude/revolve(points), add/subtract/intersect(points) and CrossSection.union and friends
//    given points never delete the cross-section they make from them.
// Each replacement below makes the same C++ calls with the same arguments, so every result is the same,
// and deletes what it made. Each is only put in when the private entry points it calls are there, so a
// binding that has changed them keeps its own.

/** Replace the leaking parts of the loaded module's glue, once, before anything uses it. */
function plugLeaks(m) {
  const glue = m.CrossSection; // a wrapper function; the C++ class is under its prototype
  const CS = glue.prototype && Object.getPrototypeOf(glue.prototype).constructor;
  const proto = CS?.prototype;
  if (typeof proto?._ToPolygons !== 'function') return;

  const has = (...names) => names.every((n) => typeof m[n] === 'function');
  const fillRuleToInt = (rule) => (rule == 'EvenOdd' ? 0 : rule == 'NonZero' ? 1 : rule == 'Negative' ? 3 : 2);
  // The glue's vararg2vec2([v]), quirks included: a lone number n is { x: n, y: 0 }.
  const vec2 = (v) => (v instanceof Array ? { x: v[0], y: v[1] } : typeof v == 'number' ? { x: v || 0, y: 0 } : v);

  if (has('Vector2_vec2', 'Vector_vec2')) {
    /** The glue's polygons2vec(), deleting each ring once the outer vector holds its copy. Delete the result. */
    const ringsOf = (polygons) => {
      if (polygons[0].length < 3) polygons = [polygons];
      const rings = new m.Vector2_vec2();
      try {
        for (const poly of polygons) {
          const ring = new m.Vector_vec2();
          try {
            if (poly) for (const p of poly) ring.push_back(p instanceof Array ? { x: p[0], y: p[1] } : p);
            rings.push_back(ring);
          } finally {
            ring.delete();
          }
        }
      } catch (e) {
        rings.delete();
        throw e;
      }
      return rings;
    };

    const CrossSection = function (polygons, fillRule = 'Positive') {
      const rings = ringsOf(polygons);
      try {
        return new CS(rings, fillRuleToInt(fillRule));
      } finally {
        rings.delete();
      }
    };
    // Keep the glue's statics (ofPolygons calls m.CrossSection, so it now comes here), prototype and instanceof.
    for (const key of Reflect.ownKeys(glue)) {
      if (!['length', 'name', 'arguments', 'caller'].includes(key)) {
        Object.defineProperty(CrossSection, key, Object.getOwnPropertyDescriptor(glue, key));
      }
    }
    m.CrossSection = CrossSection;
    /** The glue's cross(): a cross-section as is, or one made from points that the caller must delete. */
    const crossOf = (x) => (x instanceof CS ? { cs: x, made: false } : { cs: CrossSection(x), made: true });

    for (const [name, entry] of [['add', '_add'], ['subtract', '_subtract'], ['intersect', '_intersect']]) {
      if (typeof proto[entry] !== 'function') continue;
      proto[name] = function (other) {
        const { cs, made } = crossOf(other);
        try {
          return this[entry](cs);
        } finally {
          if (made) cs.delete();
        }
      };
    }

    const batches = [['compose', '_crossSectionCompose'], ['union', '_crossSectionUnionN'],
      ['difference', '_crossSectionDifferenceN'], ['intersection', '_crossSectionIntersectionN']];
    for (const [name, entry] of batches) {
      if (!has(entry, 'Vector_crossSection')) continue;
      CrossSection[name] = function (...args) {
        if (args.length == 1) args = args[0];
        const list = new m.Vector_crossSection();
        const made = [];
        try {
          for (const x of args) {
            const c = crossOf(x);
            if (c.made) made.push(c.cs);
            list.push_back(c.cs);
          }
          return m[entry](list);
        } finally {
          list.delete();
          for (const c of made) c.delete();
        }
      };
    }

    if (has('_Triangulate')) {
      m.triangulate = function (polygons, epsilon = -1, allowConvex = true) {
        const rings = ringsOf(polygons);
        try {
          const tris = m._Triangulate(rings, epsilon, allowConvex);
          try {
            const out = [];
            for (let i = 0, n = tris.size(); i < n; i++) {
              const t = tris.get(i);
              out.push([t[0], t[1], t[2]]);
            }
            return out;
          } finally {
            tris.delete();
          }
        } finally {
          rings.delete();
        }
      };
    }
  }

  proto.toPolygons = function () {
    const rings = this._ToPolygons();
    try {
      const out = [];
      for (let i = 0, n = rings.size(); i < n; i++) {
        const ring = rings.get(i); // a copy, ours to delete
        try {
          const poly = [];
          for (let j = 0, k = ring.size(); j < k; j++) {
            const v = ring.get(j);
            poly.push([v.x, v.y]);
          }
          out.push(poly);
        } finally {
          ring.delete();
        }
      }
      return out;
    } finally {
      rings.delete();
    }
  };

  if (has('_Extrude')) {
    proto.extrude = function (height, nDivisions = 0, twistDegrees = 0, scaleTop = [1, 1], center = false) {
      const top = vec2(scaleTop);
      const rings = this._ToPolygons();
      let solid;
      try {
        solid = m._Extrude(rings, height, nDivisions, twistDegrees, top);
      } finally {
        rings.delete();
      }
      if (!center) return solid;
      try {
        return solid.translate([0, 0, -height / 2]);
      } finally {
        solid.delete();
      }
    };
  }

  if (has('_Revolve')) {
    proto.revolve = function (circularSegments = 0, revolveDegrees = 360) {
      const rings = this._ToPolygons();
      try {
        return m._Revolve(rings, circularSegments, revolveDegrees);
      } finally {
        rings.delete();
      }
    };
  }

  // Manifold.extrude/revolve(points) go through a cross-section made here and deleted after.
  const { Manifold } = m;
  for (const name of ['extrude', 'revolve']) {
    if (typeof Manifold[name] !== 'function') continue;
    Manifold[name] = function (polygons, ...rest) {
      if (polygons instanceof CS) return polygons[name](...rest);
      const cs = m.CrossSection(polygons, 'Positive');
      try {
        return cs[name](...rest);
      } finally {
        cs.delete();
      }
    };
  }
}
