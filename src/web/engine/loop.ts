// The imperative shell that drives the pure core: a requestAnimationFrame loop
// with clamped dt, plus a fixed-timestep accumulator. Together they give the
// classic "fixed sim step, variable render" split — the CA + entities advance
// on integer ticks while presentation eases every frame.

/**
 * Converts variable frame dt (seconds) into an integer number of fixed ticks at
 * `getRate()` ticks/sec, carrying the fractional remainder between calls.
 */
export const createAccumulator = (
  getRate: () => number,
): ((dt: number) => number) => {
  let acc = 0;
  return (dt: number): number => {
    acc += dt * getRate();
    const steps = Math.floor(acc);
    acc -= steps;
    return steps;
  };
};

export interface Loop {
  start(): void;
  stop(): void;
}

/**
 * rAF driver. Calls `frame(dt, now)` each animation frame with dt clamped to
 * `maxDt` (seconds) so a backgrounded tab doesn't produce a huge catch-up step.
 */
export const createLoop = (
  frame: (dt: number, now: number) => void,
  maxDt = 0.1,
): Loop => {
  let last = 0;
  let running = false;

  const tick = (now: number) => {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, maxDt);
    last = now;
    frame(dt, now);
    requestAnimationFrame(tick);
  };

  return {
    start() {
      if (running) return;
      running = true;
      last = performance.now();
      requestAnimationFrame(tick);
    },
    stop() {
      running = false;
    },
  };
};
