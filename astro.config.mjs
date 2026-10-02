import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import lit from '@awesome.me/astro-lit';

// SSR build: Astro renders pages on demand (middleware-mode handler), the
// compiled Node server (dist-server/) calls into it for page routes and
// keeps serving the REST API + WS→node-pty bridge itself. One process.
//
// WEB_PI_BASE is baked into the pages at build time — for subpath deploys
// (e.g. riding an existing site at /console) set it before `npm run build`
// AND at server runtime; the pages and the server must agree.
const base = process.env.WEB_PI_BASE ?? '/';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'middleware' }),
  integrations: [lit()], // Web Awesome SSR (declarative shadow DOM)
  base,
  srcDir: './src',
  outDir: './dist', // dist/client (assets) + dist/server/entry.mjs (SSR handler)
  // trailingSlash 'ignore' — the Node server decides what / and /login map to.
});
