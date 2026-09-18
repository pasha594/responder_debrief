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

export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE ?? (mode === 'production' ? '/responder_debrief/' : '/'),
  plugins: [react(), stripUpgradeInsecureRequestsInDev()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}));
