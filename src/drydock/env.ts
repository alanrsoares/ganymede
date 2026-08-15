// Browser globals the drydock store depends on, behind a seam. `bun test` has
// no `localStorage` and no `matchMedia`, and the store touches both at module
// load — so importing it in a test used to throw before a single assertion ran.

export interface Kv {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const memoryKv = (): Kv => {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
};

/** Real localStorage in the browser; an in-memory stand-in everywhere else. */
export const kv: Kv =
  typeof localStorage === "undefined" ? memoryKv() : localStorage;

export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;
