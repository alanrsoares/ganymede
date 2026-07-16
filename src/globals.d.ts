// Ambient global augmentation. The sim and the renderer share a single mutable
// ARENA (grid bounds in cells) via `globalThis`, so every module reads the same
// live dimensions even across bundle boundaries. Declaring it here gives those
// access sites a real type instead of an `as any` cast (see world/types.ts).

// CSS imported for side effects (Bun bundles it into the page); the package's
// declared theme.css.d.ts is missing from the published tarball.
declare module "*.css";

declare global {
  // `var` (not const/let) is required for a global augmentation to attach to
  // `globalThis`.
  var ARENA: { w: number; h: number } | undefined;
  // Build label inlined by the production bundler (`scripts/build.ts`) via
  // `define`; undefined under the dev server, where we fall back to "dev".
  var __BUILD__: string | undefined;
}

export {};
