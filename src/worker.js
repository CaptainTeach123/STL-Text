import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { initManifold } from './manifold.js';
import { createEngine } from './engine.js';

/**
 * Web Worker shim: owns the Manifold WASM instance and answers requests
 * from engineClient.js. All logic lives in engine.js (testable in Node).
 */
const ready = initManifold(wasmUrl).then((wasm) => {
  wasm.onAbort = (what) => {
    self.postMessage({ type: 'fatal', code: 'WASM_ABORT', message: String(what) });
    self.close();
  };
  return createEngine({ wasm });
});

self.onmessage = async (event) => {
  const request = event.data;
  try {
    const engine = await ready;
    const { message, transfer } = await engine.handle(request, (stage, detail) =>
      self.postMessage({ type: 'progress', id: request.id, stage, ...detail }),
    );
    self.postMessage(message, transfer ?? []);
  } catch (err) {
    self.postMessage({
      id: request?.id,
      ok: false,
      error: { code: 'INTERNAL', message: err?.message ?? String(err) },
    });
  }
};
