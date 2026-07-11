// The pure entity world (Elm architecture): `update(msg, world)` returns the
// next immutable Model plus a list of Cmds (CA cells to inject). No GPU, audio,
// or clock access happens here — those are ports driven by the runtime shell
// (main.ts). Randomness is threaded as a PRNG seed in the Model, so the whole
// sim is pure, deterministic and replayable.
//
// Data shapes live in ./world/types; pure builders + tuning in ./world/factory.
// The tick is split into composable phases under ./world/tick.

export { initWorld } from "./world/init";
export * from "./world/types";
export { update } from "./world/update";
