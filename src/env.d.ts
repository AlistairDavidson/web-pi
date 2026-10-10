// Astro.locals for the web-pi server (src/lib/services.ts WebPiLocals):
// server/main.ts passes these to the Astro handler on the authenticated
// path only; src/middleware.ts fails closed without them. Inline import()
// types — a top-level import would turn this file into a module and stop
// it augmenting the global App namespace.
declare namespace App {
  interface Locals {
    webpi?: import('./lib/services').WebPiServices;
    session?: import('./types/branded').SessionToken;
  }
}
