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
