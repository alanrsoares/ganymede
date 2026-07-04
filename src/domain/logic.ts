// Functional completeness of the glider inhibit primitive.
//
// The GoL substrate physically realizes exactly one 2-input gate: the inhibit
// gate `A AND NOT B`, from a single glider-stream annihilation crossing (see
// ~/domain/substrate.ts). Every other logic gate is derived here using ONLY
// `inhibit` and the constant sources — so if inhibit is physical (proven) and
// a constant-1 stream is physical (a lone gun, proven), every gate below is
// realizable in the substrate. The derivations are verified exhaustively
// against the concrete gate components in test/logic.test.ts.

export type Bit = 0 | 1;

/** The physical primitive: out = A AND NOT B. */
export const inhibit = (a: Bit, b: Bit): Bit => (a === 1 && b === 0 ? 1 : 0);

/** A constant-on stream is a lone gun; constant-off is no gun. */
export const one: Bit = 1;

/** NOT A = 1 AND NOT A. */
export const not = (a: Bit): Bit => inhibit(one, a);

/** A AND B = A AND NOT (NOT B). */
export const and = (a: Bit, b: Bit): Bit => inhibit(a, not(b));

/** A OR B = NOT (NOT A AND NOT B), with the inner AND expanded to inhibit. */
export const or = (a: Bit, b: Bit): Bit => not(and(not(a), not(b)));

/** NAND A B = NOT (A AND B). */
export const nand = (a: Bit, b: Bit): Bit => not(and(a, b));

/** NOR A B = NOT (A OR B). */
export const nor = (a: Bit, b: Bit): Bit => not(or(a, b));

/** XOR A B = (A AND NOT B) OR (NOT A AND B) = inhibit(a,b) OR inhibit(b,a). */
export const xor = (a: Bit, b: Bit): Bit => or(inhibit(a, b), inhibit(b, a));

// --- Adders composed from the derived gates (hence from inhibit alone) ---

export interface HalfAdderBits {
  readonly sum: Bit;
  readonly carry: Bit;
}

export const halfAdder = (a: Bit, b: Bit): HalfAdderBits => ({
  sum: xor(a, b),
  carry: and(a, b),
});

export interface FullAdderBits {
  readonly sum: Bit;
  readonly carry: Bit;
}

export const fullAdder = (a: Bit, b: Bit, cin: Bit): FullAdderBits => {
  const first = halfAdder(a, b);
  const second = halfAdder(first.sum, cin);
  return {
    sum: second.sum,
    carry: or(first.carry, second.carry),
  };
};
