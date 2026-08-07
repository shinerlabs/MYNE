import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const bufferPolyfill = fileURLToPath(new URL('./node_modules/buffer/index.js', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Development may use the local Supabase CLI. Hosted project identity is never baked into the
  // toolchain: connecting to a remote project requires an explicit VITE_SUPABASE_URL.
  const supabaseTarget = env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';

  return {
    build: {
      // The protocol shell intentionally ships as one route bundle today. At ~163 kB gzip it is
      // still modest; route splitting belongs with the Anchor migration, when legacy adapters go.
      chunkSizeWarningLimit: 650,
      rollupOptions: {
        input: {
          app: fileURLToPath(new URL('./index.html', import.meta.url)),
        },
        output: {
          manualChunks(id) {
            if (!id.includes('/node_modules/')) return undefined;
            if (/@supabase\//.test(id)) return 'supabase';
            if (/@solana\/|@anchor-lang\/|\/bs58\/|\/buffer\//.test(id)) return 'solana';
            return 'vendor';
          },
        },
      },
    },
    resolve: {
      alias: { buffer: bufferPolyfill },
    },
    // The Anchor IDL is sizeable. `stringify` emits JSON.parse('…') instead of expanding it into a
    // large JS object literal, which is smaller and faster for the browser to evaluate.
    json: { stringify: true },
    server: {
      // Vite refuses to serve files outside the project root unless allow-listed.
      fs: { allow: ['..'] },
      // Pin the port so the URL is always :5173 (strictPort errors instead of silently
      // hopping to :5174 when the port is busy). host:true also binds every network
      // interface, so http://127.0.0.1:5173 works even when `localhost` resolves to IPv6.
      host: true,
      port: 5173,
      strictPort: true,
      proxy: {
        // ── Hosted Supabase (REST, Edge Functions + Realtime WS) ─────────────
        // Keeps the browser talking only to Vite. The anon key stays public by
        // design; service_role never enters this app.
        '/supabase': {
          target: supabaseTarget,
          changeOrigin: true,
          secure: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/supabase/, ''),
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.warn('[vite] /supabase proxy error', err?.message || err);
            });
          },
        },
      },
    },
  };
});
