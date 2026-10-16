import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Dev-server only: drop the `upgrade-insecure-requests` CSP from index.html.
 * Browsers exempt localhost from that upgrade, but when the dev server is
 * reached over a LAN/Tailscale address every http://host:5173/... module
 * request is upgraded to https and fails, leaving a blank page. The
 * production build keeps the tag (see the comment in index.html).
 */
const stripUpgradeInsecureRequestsInDev = (): Plugin => ({
  name: 'strip-upgrade-insecure-requests-in-dev',
  apply: 'serve',
  transformIndexHtml(html) {
    return html.replace(
      /^\s*<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests" \/>\n/m,
      '',
    );
  },
});

/**
 * pdf.js (My maps) builds into its own folder, assets/pdfjs/: the lazy
 * src/userMaps/pdfRender.ts chunk (pdf.js itself), its worker, wasm and ICC
 * profile. scripts/build-sw.mjs keeps that folder out of the precache.
 * pdf.js fetches the wasm, the wasm-less fallback scripts and the ICC profile
 * by FIXED name from the folder it is given, so those keep their names (in a
 * per-version folder, so an upgrade can never pair a new worker with a
 * browser-cached old wasm); everything else stays content-hashed.
 */
const PDFJS_VERSION: string = JSON.parse(
  readFileSync(new URL('./node_modules/pdfjs-dist/package.json', import.meta.url), 'utf8'),
).version;
const PDFJS_FIXED_NAMES = new Set([
  'openjpeg.wasm',
  'jbig2.wasm',
  'qcms_bg.wasm',
  'openjpeg_nowasm_fallback.js',
  'jbig2_nowasm_fallback.js',
  'CGATS001Compat-v2-micro.icc',
]);
const isPdfjsFile = (id: string) => id.includes('node_modules/pdfjs-dist/');
const isPdfjsChunk = (moduleIds: readonly string[]) =>
  moduleIds.some((id) => isPdfjsFile(id) || /\/src\/userMaps\/pdfRender\.ts$/.test(id));

export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE ?? (mode === 'production' ? '/responder_debrief/' : '/'),
  plugins: [react(), stripUpgradeInsecureRequestsInDev()],
  // The offline Walk router runs in a module Web Worker that imports geotiff,
  // whose codecs are dynamic imports: the default 'iife' worker format can't
  // code-split and fails the build.
  worker: { format: 'es' as const },
  build: {
    rollupOptions: {
      output: {
        // Vite's defaults are 'assets/[name]-[hash][extname]' and 'assets/[name]-[hash].js'.
        assetFileNames: (asset) => {
          if (!asset.originalFileNames.some(isPdfjsFile)) return 'assets/[name]-[hash][extname]';
          return asset.names.some((n) => PDFJS_FIXED_NAMES.has(n))
            ? `assets/pdfjs/${PDFJS_VERSION}/[name][extname]`
            : 'assets/pdfjs/[name]-[hash][extname]';
        },
        chunkFileNames: (chunk) =>
          isPdfjsChunk(chunk.moduleIds) ? 'assets/pdfjs/[name]-[hash].js' : 'assets/[name]-[hash].js',
        // pdfRender's only app import is renderBudget. Left in the entry
        // chunk, the pdfRender chunk would import the entry, so its name (a
        // hash over what it imports) would change on EVERY deploy: a tab
        // open across a deploy would ask for a file that's gone, and the
        // service worker's pdf.js cache would be stale each time.
        manualChunks: (id) => (id.endsWith('/src/userMaps/renderBudget.ts') ? 'renderBudget' : undefined),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}));
