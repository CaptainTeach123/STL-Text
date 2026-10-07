/**
 * Mesh enhancement for soft, low-definition models (stub — to be implemented).
 *
 * enhanceMesh({ positions, index }, options, onProgress) -> { positions, stats }
 * See the design brief in the workflow for the contract.
 */
export const ENHANCE_DEFAULTS = Object.freeze({ sharpen: 0, detail: 0, smooth: 0, edgeAngle: 30, featureSize: 0, maxMove: 0 });

export function isEnhanceActive(options) {
  return !!options && ((options.sharpen ?? 0) > 0 || (options.detail ?? 0) > 0 || (options.smooth ?? 0) > 0);
}

export function enhanceMesh(mesh, options = {}, onProgress) {
  void options;
  onProgress?.('Enhancing…', 1);
  return {
    positions: mesh.positions instanceof Float32Array ? mesh.positions.slice() : Float32Array.from(mesh.positions),
    stats: { verticesMoved: 0, maxDisplacement: 0, meanDisplacement: 0, flipsPrevented: 0, featureEdges: 0, iterations: 0 },
  };
}
