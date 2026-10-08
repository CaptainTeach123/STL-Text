/**
 * Main-thread side of the worker protocol.
 *
 * - One logical "channel" per kind of work (preview, result, export, base,
 *   font). A channel has at most one request in flight and one waiting; a
 *   newer request replaces the waiting one, so typing fast never queues up
 *   stale previews (superseded requests resolve to `undefined`).
 * - The worker keeps only derived state. If it answers FONT_MISSING or
 *   BASE_MISSING (e.g. after a restart) the client re-sends the font bytes or
 *   the model and retries the request once.
 * - A fatal worker error (WASM abort / OOM) rejects everything in flight,
 *   reports it, and a fresh worker is spawned lazily on the next request.
 */

export const CHANNELS = ['font', 'base', 'preview', 'result', 'export', 'misc'];

export class EngineError extends Error {
  constructor({ code = 'INTERNAL', message = 'Unknown error', details } = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.details = details;
  }
}

export function createEngineClient({ createWorker, onProgress = () => {}, onState = () => {}, onFatal = () => {} }) {
  let worker = null;
  let nextId = 1;
  const live = new Map(); // id -> entry
  const channels = new Map(CHANNELS.map((c) => [c, { inFlight: null, waiting: null }]));
  const channelFor = (name) => {
    if (!channels.has(name)) channels.set(name, { inFlight: null, waiting: null }); // e.g. preview:item-7
    return channels.get(name);
  };
  const fonts = new Map(); // fontId -> ArrayBuffer (kept for rehydration)
  const parts = new Map(); // partId -> { bytes, name } (kept for rehydration)
  let base = null; // { kind, bytes, name, version, transforms, simplify, enhance, spots }
  let fatalError = null;

  const state = () => (live.size ? 'busy' : worker ? 'idle' : 'stopped');
  const notify = () => onState(state());

  function spawn() {
    if (worker) return worker;
    worker = createWorker();
    worker.onmessage = onMessage;
    worker.onerror = (e) => fatal({ code: 'WORKER_ERROR', message: e?.message ?? 'Worker error' });
    worker.onmessageerror = () => fatal({ code: 'WORKER_ERROR', message: 'Could not read a worker message' });
    fatalError = null;
    return worker;
  }

  function fatal(error) {
    fatalError = new EngineError(error);
    try {
      worker?.terminate?.();
    } catch {
      /* ignore */
    }
    worker = null;
    for (const entry of live.values()) entry.reject(fatalError);
    live.clear();
    for (const ch of channels.values()) {
      ch.inFlight = null;
      ch.waiting?.resolve(undefined);
      ch.waiting = null;
    }
    onFatal(fatalError);
    notify();
  }

  function post(entry) {
    const w = spawn();
    const channel = channelFor(entry.channel);
    channel.inFlight = entry;
    live.set(entry.request.id, entry);
    // never transfer buffers we still need (fonts / model bytes are kept here)
    w.postMessage(entry.request, entry.transfer ?? []);
    notify();
  }

  function enqueue(entry) {
    const channel = channelFor(entry.channel);
    if (channel.inFlight) {
      channel.waiting?.resolve(undefined); // superseded
      channel.waiting = entry;
    } else {
      post(entry);
    }
  }

  function finish(entry) {
    live.delete(entry.request.id);
    const channel = channelFor(entry.channel);
    if (channel.inFlight === entry) {
      channel.inFlight = null;
      if (channel.waiting) {
        const next = channel.waiting;
        channel.waiting = null;
        post(next);
      }
    }
    notify();
  }

  async function onMessage(event) {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'progress') {
      onProgress({ id: msg.id, stage: msg.stage, done: msg.done, total: msg.total });
      return;
    }
    if (msg.type === 'fatal') {
      fatal({ code: msg.code ?? 'WASM_ABORT', message: msg.message ?? 'The geometry engine crashed' });
      return;
    }
    const entry = live.get(msg.id);
    if (!entry) return; // stale or unknown
    if (msg.ok) {
      finish(entry);
      entry.resolve(msg.result);
      return;
    }
    const code = msg.error?.code;
    // the engine has a model, just not the version this request was for: the request is stale (a newer base
    // update is on its way or already landed) – not a lost model, so never reload the model for it
    if (code === 'BASE_MISSING' && msg.error.details?.have != null) {
      finish(entry);
      entry.resolve(undefined);
      return;
    }
    // a fresh worker may lack the model AND a font: rehydrate as often as needed (bounded)
    if ((entry.retries ?? 0) < 3 && (code === 'FONT_MISSING' || code === 'BASE_MISSING' || code === 'PART_MISSING')) {
      finish(entry);
      entry.retries = (entry.retries ?? 0) + 1;
      try {
        if (code === 'FONT_MISSING') {
          const ids = msg.error.details?.fontIds ?? [msg.error.details?.fontId];
          await Promise.all(ids.map((id) => rehydrateFont(id)));
        } else if (code === 'PART_MISSING') {
          const ids = msg.error.details?.partIds ?? [msg.error.details?.partId];
          await Promise.all(ids.map((id) => rehydratePart(id)));
        } else await rehydrateBase();
        enqueue(entry);
      } catch {
        entry.reject(new EngineError(msg.error)); // could not rehydrate: the engine's own error says what is missing
      }
      return;
    }
    finish(entry);
    entry.reject(new EngineError(msg.error));
  }

  function request(channel, type, payload = {}, transfer = []) {
    if (fatalError && !worker) spawn();
    return new Promise((resolve, reject) => {
      const id = nextId++;
      enqueue({ channel, request: { id, channel, type, ...payload }, transfer, resolve, reject, retries: 0 });
    });
  }

  /* ----------------------------------------------------- rehydration */

  const copy = (buffer) => buffer.slice(0);

  async function rehydrateFont(fontId) {
    const bytes = fonts.get(fontId);
    if (!bytes) throw new EngineError({ code: 'FONT_MISSING', message: `Font ${fontId} is not loaded`, details: { fontId } });
    const bytes_ = copy(bytes);
    await request(`font:${fontId}`, 'font.add', { fontId, bytes: bytes_ }, [bytes_]);
  }

  async function rehydratePart(partId) {
    const part = parts.get(partId);
    if (!part) throw new EngineError({ code: 'PART_MISSING', message: `Part ${partId} is not loaded`, details: { partId } });
    if (part.spec) {
      await request(`part:${partId}`, 'part.generate', { partId, name: part.name, ...part.spec });
      return;
    }
    const bytes = copy(part.bytes);
    await request(`part:${partId}`, 'part.add', { partId, name: part.name, bytes }, [bytes]);
  }

  async function rehydrateBase() {
    if (!base) throw new EngineError({ code: 'BASE_MISSING', message: 'No model is loaded' });
    const bytes = base.bytes ? copy(base.bytes) : null;
    await request(
      'base',
      'base.load',
      { kind: base.kind, name: base.name, bytes, version: base.version, transforms: base.transforms, simplify: base.simplify, enhance: base.enhance ?? null, spots: base.spots ?? [], covers: base.covers ?? [] },
      bytes ? [bytes] : [],
    );
  }

  /* ------------------------------------------------------------- API */

  return {
    get state() {
      return state();
    },
    get fatalError() {
      return fatalError;
    },

    /** Register a font (bytes are kept on this side for restarts). */
    addFont(fontId, bytes) {
      fonts.set(fontId, bytes);
      // one channel per font: adding several fonts at once must not drop any
      const sent = copy(bytes);
      return request(`font:${fontId}`, 'font.add', { fontId, bytes: sent }, [sent]);
    },

    /** Register an STL part to attach (bytes are kept on this side for restarts). */
    addPart(partId, bytes, name) {
      parts.set(partId, { bytes, name });
      const sent = copy(bytes);
      return request(`part:${partId}`, 'part.add', { partId, name, bytes: sent }, [sent]);
    },

    /** Register a generated part (e.g. { kind: 'sphere', radius }); the spec is kept for restarts. */
    addGeneratedPart(partId, spec, name) {
      parts.set(partId, { spec, name });
      return request(`part:${partId}`, 'part.generate', { partId, name, ...spec });
    },

    /** Find the details standing on the current model (berries, leaves, …); see details.js. */
    findDetails(baseVersion, options = {}) {
      return request('details', 'details.find', { baseVersion, ...options });
    },

    /**
     * Load a model: kind 'stl' (with bytes), 'sample' or 'none'.
     * Returns the display payload + repair report.
     */
    loadBase({ kind, bytes = null, name = 'model', version, spots = [], covers = [] }) {
      base = { kind, bytes, name, version, transforms: [], simplify: null, enhance: null, spots, covers };
      const sent = bytes ? copy(bytes) : null;
      return request('base', 'base.load', { kind, name, bytes: sent, version, transforms: [], simplify: null, enhance: null, spots, covers }, sent ? [sent] : []);
    },

    /** Re-derive the model with a new transform list / simplify tolerance / enhancement / clean-up spots. */
    updateBase({ version, transforms, simplify, enhance = null, spots = [], covers = [] }) {
      if (!base) return Promise.reject(new EngineError({ code: 'BASE_MISSING', message: 'No model is loaded' }));
      base = { ...base, version, transforms, simplify, enhance, spots, covers };
      return request('base', 'base.update', { version, transforms, simplify, enhance, spots, covers });
    },

    /**
     * Conformed preview geometry + notes for one item. Each item has its own
     * channel, so a newer request for the same item supersedes the older one
     * (resolving it to undefined) while other items are unaffected.
     */
    preview(item, baseVersion, options = {}) {
      return request(`preview:${item.id}`, 'preview', { item, baseVersion, ...options });
    },

    /** Display geometry of the final result. */
    result(items, baseVersion, options = {}) {
      return request('result', 'result', { items, baseVersion, ...options });
    },

    /** Binary STL of the final result. */
    export(items, baseVersion, name, options = {}) {
      return request('export', 'export', { items, baseVersion, name, ...options });
    },

    /** Any other request (tests, diagnostics). */
    call(type, payload) {
      return request('misc', type, payload);
    },

    /** Throw the worker away; state is rebuilt lazily from the kept bytes. */
    restart() {
      fatal({ code: 'RESTARTED', message: 'Engine restarted' });
      fatalError = null;
    },

    dispose() {
      worker?.terminate?.();
      worker = null;
      live.clear();
    },
  };
}

/**
 * A "worker" that runs an engine in the same thread (for tests and as a
 * fallback). Messages are structured-cloned like real postMessage.
 */
export function createLocalWorker(enginePromise) {
  const target = { onmessage: null, onerror: null, onmessageerror: null };
  let closed = false;
  target.postMessage = (request) => {
    const copy = structuredClone(request);
    queueMicrotask(async () => {
      if (closed) return;
      try {
        const engine = await enginePromise;
        const { message, transfer } = await engine.handle(copy, (stage, detail) =>
          target.onmessage?.({ data: { type: 'progress', id: copy.id, stage, ...detail } }),
        );
        for (const t of transfer ?? []) if (!(t instanceof ArrayBuffer)) throw new Error('transfer list must hold ArrayBuffers');
        target.onmessage?.({ data: structuredClone(message) });
      } catch (err) {
        target.onmessage?.({ data: { id: copy.id, ok: false, error: { code: 'INTERNAL', message: err?.message ?? String(err) } } });
      }
    });
  };
  target.terminate = () => {
    closed = true;
  };
  return target;
}
