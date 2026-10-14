import { defineConfig } from 'astro/config';

const apiTarget = process.env.API_PROXY_TARGET || 'http://127.0.0.1:8787';

export default defineConfig({
  vite: {
    server: {
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              const origin = req.headers.origin;
              if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
                proxyReq.setHeader('Origin', 'https://osaka2026.voriens.dev');
              }
            });
          },
        },
      },
    },
  },
});
