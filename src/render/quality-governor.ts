// The adaptive half of graphics quality: watch frame times, say when the tier
// should move. Pure and clock-free — it counts frames, so a test can drive it
// with a literal array of deltas and the result is deterministic.
//
// Three rules keep it from oscillating, which is the only failure mode that
// matters (a tier that flaps is worse than one that is merely wrong):
//   1. Asymmetry — demoting needs ~0.75s of slow, promoting needs ~5s of fast.
//   2. A settle window after every move, so the re-allocation hitch that a
//      tier change itself causes can't immediately trigger the next one.
//   3. A promotion penalty that doubles each time a promotion is undone, so
//      a machine sitting on the boundary converges instead of yo-yoing.

export type QualityVerdict = "up" | "down" | "hold";

export interface GovernorOpts {
  /** Smoothed frame time above this is "too slow". Default 20ms (~50fps). */
  downMs?: number;
  /** Smoothed frame time below this is "we have headroom". Default 11.5ms. */
  upMs?: number;
  /** EMA weight of each new sample. Default 0.1 (~30-frame memory). */
  alpha?: number;
  /** Frames ignored after a tier change. Default 45. */
  settleFrames?: number;
  /** Consecutive slow frames before demoting. Default 45 (~0.75s). */
  downFrames?: number;
  /** Consecutive fast frames before promoting. Default 300 (~5s). */
  upFrames?: number;
  /** Samples above this (ms) are hitches — tab switch, GC — and are dropped. */
  hitchMs?: number;
  /** Ceiling on the doubling promotion penalty. Default 8. */
  maxPenalty?: number;
}

export interface Governor {
  /** Feed one frame's delta in ms. Only call it for frames actually rendered. */
  sample(dtMs: number): QualityVerdict;
  /** Restart the window. Call after any tier change, manual or automatic. */
  settle(): void;
  /** The smoothed frame time, for the settings readout. NaN before warm-up. */
  frameMs(): number;
}

export const createGovernor = (opts: GovernorOpts = {}): Governor => {
  const {
    downMs = 20,
    upMs = 11.5,
    alpha = 0.1,
    settleFrames = 45,
    downFrames = 45,
    upFrames = 300,
    hitchMs = 250,
    maxPenalty = 8,
  } = opts;

  let ema = Number.NaN;
  let settling = settleFrames;
  let slow = 0;
  let fast = 0;
  // Doubles whenever a promotion is followed by a demotion — the machine sits
  // on the boundary, so make the next promotion progressively harder to earn.
  let penalty = 1;
  let lastMoveWasUp = false;

  const settle = () => {
    settling = settleFrames;
    slow = 0;
    fast = 0;
  };

  const verdictFor = (): QualityVerdict => {
    if (slow >= downFrames) return "down";
    if (fast >= upFrames * penalty) return "up";
    return "hold";
  };

  // Record a move. A promotion that gets undone doubles the price of the next
  // one, so a machine sitting on the boundary converges instead of yo-yoing.
  const commit = (verdict: "up" | "down") => {
    if (verdict === "down" && lastMoveWasUp) {
      penalty = Math.min(maxPenalty, penalty * 2);
    }
    lastMoveWasUp = verdict === "up";
    settle();
  };

  /**
   * Fold one delta into the EMA. False means the sample can't be judged on:
   * a hitch or a bogus dt (dropped outright), or the settle window still
   * running (counted toward the average, but not toward a verdict).
   */
  const accept = (dtMs: number): boolean => {
    if (!(dtMs > 0) || dtMs > hitchMs) return false;
    ema = Number.isNaN(ema) ? dtMs : ema + (dtMs - ema) * alpha;
    if (settling > 0) {
      settling--;
      return false;
    }
    return true;
  };

  return {
    settle,
    frameMs: () => ema,
    sample: (dtMs) => {
      if (!accept(dtMs)) return "hold";
      slow = ema > downMs ? slow + 1 : 0;
      fast = ema < upMs ? fast + 1 : 0;

      const verdict = verdictFor();
      if (verdict !== "hold") commit(verdict);
      return verdict;
    },
  };
};
