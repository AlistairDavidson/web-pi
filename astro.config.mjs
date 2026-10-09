import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import lit from '@awesome.me/astro-lit';
// Typed env-var contract for every WEB_PI_* variable the server reads —
// the single source of truth, shared with src/lib/env.ts (the compiled
// server's typed reads; see that file for why the server cannot import
// 'astro:env/server' directly). Plain data in envField() output shape.
import { envSchema } from './src/lib/env-schema';

// SSR build: Astro renders pages on demand (middleware-mode handler), the
// compiled Node server (dist-server/) calls into it for page routes and
// keeps serving the REST API + WS→node-pty bridge itself. One process.
//
// WEB_PI_BASE is baked into the pages at build time — for subpath deploys
// (e.g. /console on a dedicated vhost; the app wants its own hostname,
// see README "Security model") set it before `npm run build`
// AND at server runtime; the pages and the server must agree.
const base = process.env.WEB_PI_BASE ?? '/';

// Dev (`astro dev`) only: the REST API + terminal WS live in the Node
// server (server/main.ts), not in Astro — without a proxy every /api, /ws
// and login/logout POST 404s against the dev server and the console shows
// no sessions. `npm run dev:server` runs that half on :3001; Vite forwards
// to it. GET/HEAD /login and /logout stay on the dev server (they are the
// real Astro pages) — `bypass` returning the URL hands those back to the
// dev server instead of proxying (vite: string → serve locally).
// NOTE: `server.proxy` is inert outside `astro dev` (build never runs a
// dev server; prod is dist-server/server/main.js), and Astro has no
// command-conditional config form — so it is simply always declared.
const devApiTarget = process.env.WEB_PI_DEV_API ?? 'http://127.0.0.1:3001';
const pageMethodsOnly = (req) =>
  req.method === 'GET' || req.method === 'HEAD' ? req.url : undefined;
const devProxy = {
  [`${base}api`]: { target: devApiTarget },
  [`${base}ws`]: { target: devApiTarget, ws: true },
  [`${base}login`]: { target: devApiTarget, bypass: pageMethodsOnly },
  [`${base}logout`]: { target: devApiTarget, bypass: pageMethodsOnly },
};

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'middleware' }),
  integrations: [lit()], // Web Awesome SSR (declarative shadow DOM)
  base,
  srcDir: './src',
  outDir: './dist', // dist/client (assets) + dist/server/entry.mjs (SSR handler)
  env: {
    // All server-context secrets: Astro reads these from process.env at
    // runtime. (public would inline build-time values into the SSR bundle —
    // wrong for vars the operator sets when starting the built server.)
    schema: envSchema,
  },
  // trailingSlash 'ignore' — the Node server decides what / and /login map to.
  vite: { server: { proxy: devProxy } },
});
