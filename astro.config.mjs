import { defineConfig } from 'astro/config';

// Static/islands build: Astro renders pages + bundles the web-component
// islands into dist/client at build time; the compiled Node server
// (dist-server/) serves them plus REST + WS from one process. No runtime SSR.
//
// WEB_PI_BASE is baked into the pages at build time — for subpath deploys
// (e.g. riding an existing site at /console) set it before `npm run build`
// AND at server runtime; the pages and the server must agree.
const base = process.env.WEB_PI_BASE ?? '/';

export default defineConfig({
  output: 'static',
  base,
  srcDir: './src',
  outDir: './dist/client',
  // trailingSlash 'ignore' — the Node server decides what / and /login map to.
});
