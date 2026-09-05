// Shared reach-into-the-run helpers for the arcade specs. The run and its wave
// director are both nullable on World (a scroll stage has a run but no waves),
// so every arcade test would otherwise carry its own non-null assertions.
// These throw instead: a spec that lost its run state should fail loudly.

import type { RunState, WaveState, World } from "~/world";

export const runOf = (w: World): RunState => {
  if (!w.run) throw new Error("expected a piloted run on this world");
  return w.run;
};

export const wavesOf = (w: World): WaveState => {
  const waves = runOf(w).waves;
  if (!waves) throw new Error("expected a wave director on this run");
  return waves;
};

/** Copy of `w` with the run patched. */
export const patchRun = (w: World, patch: Partial<RunState>): World => ({
  ...w,
  run: { ...runOf(w), ...patch },
});

/** Copy of `w` with the wave director patched, run otherwise untouched. */
export const patchWaves = (w: World, patch: Partial<WaveState>): World => ({
  ...w,
  run: { ...runOf(w), waves: { ...wavesOf(w), ...patch } },
});
