// Ambient global augmentation. The sim and the renderer share a single mutable
// ARENA (grid bounds in cells) via `globalThis`, so every module reads the same
// live dimensions even across bundle boundaries. Declaring it here gives those
// access sites a real type instead of an `as any` cast (see world/types.ts).

declare global {
  // `var` (not const/let) is required for a global augmentation to attach to
  // `globalThis`.
  var ARENA: { w: number; h: number } | undefined;
}

export {};
