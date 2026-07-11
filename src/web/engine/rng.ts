// Pure PRNG (mulberry32). Randomness in Elm is an effect; rather than round-trip
// through Cmd/Msg we thread a Seed through the Model. Every draw returns the
// value plus the next seed, so `update` stays pure and the whole sim is
// deterministic and replayable from its initial seed.

export type Seed = number;

/** Next float in [0, 1) and the advanced seed. */
export const nextFloat = (seed: Seed): [number, Seed] => {
  const s = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), s | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, s];
};

/** Integer in [0, n) and the advanced seed. */
export const nextInt = (seed: Seed, n: number): [number, Seed] => {
  const [f, next] = nextFloat(seed);
  return [Math.floor(f * n), next];
};

/** Float in [lo, hi) and the advanced seed. */
export const nextRange = (
  seed: Seed,
  lo: number,
  hi: number,
): [number, Seed] => {
  const [f, next] = nextFloat(seed);
  return [lo + f * (hi - lo), next];
};

/** A uniformly chosen element of `arr` and the advanced seed. */
export const pick = <T>(seed: Seed, arr: readonly T[]): [T, Seed] => {
  const [i, next] = nextInt(seed, arr.length);
  return [arr[i], next];
};
