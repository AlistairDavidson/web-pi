// icons.ts — vendored Web Awesome icon glyphs (client).
// wa-icon's default library fetches each glyph from the Font Awesome CDN
// (ka-f.fontawesome.com) — a third-party request the strict CSP blocks
// and a usage leak besides. This re-points the library at the app's own
// public/icons/wa/ copies, extracted from the installed package:
//   solid/            the default library's classic/solid glyphs — the
//                     names used by this app's markup and toasts
//   system/{solid,regular}/   the embedded system library wa-* components
//                             use internally (spinner, dialog xmark, input
//                             password toggle, …) — its stock resolver
//                             fetch()es data: URLs, which the CSP also
//                             blocks, so it needs local files like any
//                             other library.
// registerIconLibrary() re-resolves every icon already on the page, so —
// unlike setIconPath() — it is safe even when this module evaluates
// after a wa-icon has upgraded. Client-side only, like src/base.ts (the
// server tsconfig excludes the src root).
import { registerIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';
import { BASE } from './base';

registerIconLibrary('default', {
  // The app only ever uses the classic/solid family+variant.
  resolver: (name: string) => `${BASE}/icons/wa/solid/${name}.svg`,
  mutator: (svg: SVGElement) => {
    // Same as the stock default library: glyphs inherit text colour on
    // the dark theme (the component's CSS deliberately never sets fill).
    if (!svg.hasAttribute('fill')) svg.setAttribute('fill', 'currentColor');
  },
});

registerIconLibrary('system', {
  // Mirrors the stock system library's variant lookup (solid + regular).
  resolver: (name: string, _family: string, variant = 'solid') =>
    `${BASE}/icons/wa/system/${variant}/${name}.svg`,
  mutator: (svg: SVGElement) => {
    if (!svg.hasAttribute('fill')) svg.setAttribute('fill', 'currentColor');
  },
});
