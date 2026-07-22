import { expect, test } from "bun:test";
import {
  augMul,
  augmentTier,
  bakeCaps,
  MIN_COOLDOWN_MUL,
  pilotMods,
} from "~/world/augments";

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

test("pilotMods of an empty stack is the identity block", () => {
  const mods = pilotMods({});
  expect(mods.hpMul).toBe(1);
  expect(mods.shieldMul).toBe(1);
  expect(mods.cooldownMul).toBe(1);
  expect(mods.damageMul).toBe(1);
  expect(mods.regenMul).toBe(1);
  expect(mods.speedMul).toBe(1);
  expect(mods.fanBarrels).toBe(0);
  expect(mods.novaRank).toBe(0);
  expect(mods.wingSize).toBe(0);
});

test("pilotMods compounds per stack, same as augMul", () => {
  const mods = pilotMods({ hull: 2, caliber: 3, nanofoam: 1, thrusters: 2 });
  expect(mods.hpMul).toBeCloseTo(1.18 ** 2, 5);
  expect(mods.damageMul).toBeCloseTo(1.15 ** 3, 5);
  expect(mods.regenMul).toBeCloseTo(1.5, 5);
  expect(mods.speedMul).toBeCloseTo(1.08 ** 2, 5);
  expect(mods.shieldMul).toBe(1); // untouched stat stays identity
});

test("the cooldown floor holds through the block", () => {
  expect(pilotMods({ overclock: 20 }).cooldownMul).toBe(MIN_COOLDOWN_MUL);
});

test("unlock/summon stacks surface as counts", () => {
  const mods = pilotMods({ spread: 2, nova: 1, wing: 3 });
  expect(mods.fanBarrels).toBe(2);
  expect(mods.novaRank).toBe(1);
  expect(mods.wingSize).toBe(3);
});

test("bakeCaps multiplies base caps by the block and rounds", () => {
  const mods = pilotMods({ hull: 1, plating: 2 });
  const baked = bakeCaps(mods, { maxHp: 10, maxShield: 7 });
  expect(baked.maxHp).toBe(Math.round(10 * 1.18));
  expect(baked.maxShield).toBe(Math.round(7 * 1.15 ** 2));
  // Identity block = identity caps.
  expect(bakeCaps(pilotMods({}), { maxHp: 10, maxShield: 7 })).toEqual({
    maxHp: 10,
    maxShield: 7,
  });
});
