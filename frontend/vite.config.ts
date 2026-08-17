import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Dev-only proxy to the pyrecast geoservers. Strips the Origin header so the
// upstream CORS allowlist (which 403s every non-pyrecast.org Origin) never
// sees one — mirroring what the deployed Cloudflare Worker proxy does.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripOrigin(proxy: any) {
  proxy.on('proxyReq', (proxyReq: any) => {
    proxyReq.removeHeader('origin');
    proxyReq.removeHeader('cookie');
    proxyReq.removeHeader('referer');
  });
  // Mirror the production Worker: upstream marks GetMap `private` (uncacheable
  // heuristics + Set-Cookie); frames are run-stamped snapshots, safe to pin.
  proxy.on('proxyRes', (proxyRes: any) => {
    delete proxyRes.headers['set-cookie'];
    if ((proxyRes.headers['content-type'] ?? '').startsWith('image/')) {
      proxyRes.headers['cache-control'] = 'public, max-age=604800, immutable';
    }
  });
}

export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE ?? (mode === 'production' ? '/responder_debrief/' : '/'),
  plugins: [react()],
  server: {
    proxy: {
      '/wms01': {
        target: 'https://geoserver-usw1.pyrecast.org',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/wms01/, '/geoserver01/ows'),
        configure: stripOrigin,
      },
      '/wms02': {
        target: 'https://geoserver-usw1.pyrecast.org',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/wms02/, '/geoserver02/ows'),
        configure: stripOrigin,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}));
