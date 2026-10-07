import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works from any GitHub Pages sub-path.
  base: './',
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    include: ['manifold-3d/manifold.js', 'opentype.js', 'three', 'three-mesh-bvh'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
