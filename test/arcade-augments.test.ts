import { expect, test } from "bun:test";
import { augMul, augmentTier, MIN_COOLDOWN_MUL } from "~/world/augments";

test("augMul is 1 for an empty stack", () => {
  expect(augMul({}, "hp")).toBe(1);
  expect(augMul({}, "cooldown")).toBe(1);
});

test("augMul compounds stacks of the same augment", () => {
  expect(augMul({ hull: 1 }, "hp")).toBeCloseTo(1.18, 5);
  expect(augMul({ hull: 2 }, "hp")).toBeCloseTo(1.18 ** 2, 5);
  expect(augMul({ caliber: 3 }, "damage")).toBeCloseTo(1.15 ** 3, 5);
});

test("augMul only scales the augment's own stat", () => {
  const stacks = { hull: 2, caliber: 1 };
  expect(augMul(stacks, "hp")).toBeCloseTo(1.18 ** 2, 5);
  expect(augMul(stacks, "damage")).toBeCloseTo(1.15, 5);
  expect(augMul(stacks, "shield")).toBe(1); // untouched
});

test("overclock lowers the cooldown multiplier but is floored", () => {
  expect(augMul({ overclock: 1 }, "cooldown")).toBeCloseTo(0.92, 5);
  // Many stacks would drive it to ~0; the floor holds the cadence.
  expect(augMul({ overclock: 20 }, "cooldown")).toBe(MIN_COOLDOWN_MUL);
});

test("augmentTier sums all owned stacks", () => {
  expect(augmentTier({})).toBe(0);
  expect(augmentTier({ hull: 2, caliber: 1, thrusters: 3 })).toBe(6);
});
