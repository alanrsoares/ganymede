// Hand-authored scroll stages (#30). Data, not a generator: the whole file is
// one literal per stage, so editing the stage is editing the thing the pilot
// actually flies rather than the rules that produce it.
//
// Distances are cells from the stage start (SCROLL_RATE cells per generation),
// and x runs 0..SCROLL_FIELD_W across the corridor. The pacing below is the
// standard shmup shape — read the formation, dodge it, then read two at once —
// and every number in it is a guess until it has been flown.

import type { StageScript } from "./types";

/**
 * The first stage: roughly two minutes of corridor, escalating from single
 * lines to overlapping formations with spread emitters holding lanes. It ends
 * open — the flip beat (#31) is what closes a stage, and it does not exist yet.
 */
export const STAGE_ONE: StageScript = {
  name: "Approach",
  entries: [
    // Opening: one formation at a time, wide apart, all aimed. Room to learn
    // that formations come from up-stage and that shooting back works.
    { at: 240, x: 240, shape: "line", count: 3, hull: "scout", level: 1 },
    { at: 520, x: 140, shape: "vee", count: 3, hull: "scout", level: 1 },
    { at: 800, x: 340, shape: "vee", count: 3, hull: "scout", level: 1 },
    { at: 1060, x: 240, shape: "line", count: 5, hull: "fighter", level: 2 },

    // First spread emitter, alone and dead centre, so the pattern is legible
    // before it ever arrives alongside anything else.
    {
      at: 1340,
      x: 240,
      shape: "column",
      count: 2,
      hull: "fighter",
      level: 2,
      emitter: "spread",
    },
    { at: 1420, x: 90, shape: "echelon", count: 3, hull: "scout", level: 2 },
    { at: 1420, x: 390, shape: "echelon", count: 3, hull: "scout", level: 2 },

    // Squeeze: two lanes held open by spread fire, with the gap between them
    // the only clean line through.
    {
      at: 1760,
      x: 110,
      shape: "column",
      count: 3,
      hull: "fighter",
      level: 2,
      emitter: "spread",
    },
    {
      at: 1760,
      x: 370,
      shape: "column",
      count: 3,
      hull: "fighter",
      level: 2,
      emitter: "spread",
    },
    { at: 1940, x: 240, shape: "vee", count: 5, hull: "interceptor", level: 3 },

    // Heavies: slow, tanky, and worth going around rather than through.
    { at: 2280, x: 160, shape: "line", count: 2, hull: "heavy", level: 3 },
    { at: 2280, x: 320, shape: "line", count: 2, hull: "heavy", level: 3 },
    {
      at: 2480,
      x: 240,
      shape: "line",
      count: 4,
      hull: "fighter",
      level: 3,
      emitter: "spread",
      team: "emerald",
    },

    // Last third: formations overlap, so there is no beat with nothing in it.
    { at: 2760, x: 100, shape: "vee", count: 3, hull: "interceptor", level: 3 },
    { at: 2820, x: 380, shape: "vee", count: 3, hull: "interceptor", level: 3 },
    {
      at: 3040,
      x: 240,
      shape: "echelon",
      count: 5,
      hull: "fighter",
      level: 4,
      emitter: "spread",
    },
    { at: 3240, x: 150, shape: "column", count: 3, hull: "scout", level: 3 },
    { at: 3240, x: 330, shape: "column", count: 3, hull: "scout", level: 3 },
    {
      at: 3520,
      x: 240,
      shape: "vee",
      count: 5,
      hull: "heavy",
      level: 4,
      emitter: "spread",
      team: "emerald",
    },
    {
      at: 3800,
      x: 240,
      shape: "line",
      count: 6,
      hull: "interceptor",
      level: 4,
    },
  ],
};
