import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

// The deployment export (addresses + ABIs) is COPIED into the frontend at `src/deployments`
// so the app is self-contained and runs from this folder alone (no hardhat dependency).
// Refresh it after a redeploy with `npm run sync:abi`.
const deployments = fileURLToPath(new URL('./src/deployments', import.meta.url));
const bufferPolyfill = fileURLToPath(new URL('./node_modules/buffer/index.js', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const supabaseTarget = env.VITE_SUPABASE_URL || '';
  const socialTarget = env.VITE_SOCIAL_API || 'http://127.0.0.1:4030';

  // Endpoints the Express social backend answers instead of Supabase, because
  // migration 0003 is not applied to the live project yet and their Edge
  // Functions are therefore not deployed. The frontend calls the SAME
  // /supabase/functions/v1/* URL either way — going native later is a matter of
  // deleting these entries, with no frontend change. See backend/README.md.
  const socialShim = (rewrite) => ({
    target: socialTarget,
    changeOrigin: true,
    rewrite,
  });

  return {
    build: {
      // The protocol shell intentionally ships as one route bundle today. At ~163 kB gzip it is
      // still modest; route splitting belongs with the Anchor migration, when legacy adapters go.
      chunkSizeWarningLimit: 650,
      rollupOptions: {
        input: {
          app: fileURLToPath(new URL('./index.html', import.meta.url)),
          local: fileURLToPath(new URL('./local.html', import.meta.url)),
        },
      },
    },
    resolve: {
      alias: {
        '@deployments': deployments,
        buffer: bufferPolyfill,
      },
    },
    // The 15 contract ABIs are 288KB on disk but Vite's default JSON transform expands each one
    // into a JS object literal — 1.4MB of the dev page load, and slow for the browser to parse.
    // `stringify` emits JSON.parse('…') instead, which is both smaller and faster to evaluate.
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
        // ── Not-yet-native social endpoints → Express ────────────────────────
        '/supabase/functions/v1/chat-reactions': socialShim(() => '/api/chat-reactions'),
        '/supabase/functions/v1/chat-react': socialShim(() => '/api/chat-react'),
        '/supabase/functions/v1/profile-update': socialShim(() => '/api/profile-update'),
        '/supabase/functions/v1/follow-toggle': socialShim(() => '/api/follow-toggle'),
        '/supabase/functions/v1/chat-delete': socialShim(() => '/api/chat-delete'),

        // ── Express-only routes (no Supabase equivalent) ─────────────────────
        '/rounds/api': socialShim((p) => p.replace(/^\/rounds/, '')),

        // ── Everything else → hosted Supabase (REST + Realtime WS) ───────────
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
