import { defineConfig } from 'vite';

/**
 * What this build is: the commit it is built from on the deploy (GITHUB_SHA), or the time it was built. The page
 * carries it (`__BUILD__`) and the build writes it beside the page (`version.json`), which a page left open asks for
 * again – the page itself may be served from a browser's cache for a while after a deploy – so it can say that a newer
 * version is out.
 */
const BUILD = (process.env.GITHUB_SHA ?? '').slice(0, 12) || `t${Date.now().toString(36)}`;

/** Writes `version.json` beside the page. */
const versionFile = () => ({
  name: 'stl-text-version',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ build: BUILD })}\n` });
  },
});

export default defineConfig({
  // Relative asset paths so the build works from any GitHub Pages sub-path.
  base: './',
  define: {
    __BUILD__: JSON.stringify(BUILD),
  },
  plugins: [versionFile()],
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
