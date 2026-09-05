import { expect, test } from "bun:test";
import { buildRunConfig } from "~/ui/arcade-lobby";
import {
  type HighScore,
  type Kv,
  loadScores,
  recordScore,
  runScore,
  TABLE_SIZE,
  topScores,
} from "~/ui/highscores";
import { initArcadeWorld, type World } from "~/world";
import { patchRun, patchWaves } from "./arcade-helpers";

const fakeKv = (seed?: string): Kv => {
  const map = new Map<string, string>();
  if (seed !== undefined) map.set("ganymede.arcade.scores.v1", seed);
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
};

const run = (score: number, over: Partial<HighScore> = {}): HighScore => ({
  score,
  wave: 3,
  kills: 12,
  archetype: "fighter",
  at: 1000,
  ...over,
});

test("an empty store reads as an empty table", () => {
  const kv = fakeKv();
  expect(loadScores(kv)).toEqual({});
  expect(topScores("normal", kv)).toEqual([]);
});

test("a first run ranks 1st and persists", () => {
  const kv = fakeKv();
  expect(recordScore("normal", run(500), kv)).toBe(0);
  expect(topScores("normal", kv)).toEqual([run(500)]);
});

test("runs sort by points, then by deeper wave", () => {
  const kv = fakeKv();
  recordScore("normal", run(500), kv);
  recordScore("normal", run(900), kv);
  recordScore("normal", run(500, { wave: 7, at: 2000 }), kv);
  expect(topScores("normal", kv).map((r) => [r.score, r.wave])).toEqual([
    [900, 3],
    [500, 7],
    [500, 3],
  ]);
});

test("a tie keeps the older run ahead", () => {
  const kv = fakeKv();
  recordScore("normal", run(500, { at: 1000 }), kv);
  expect(recordScore("normal", run(500, { at: 5000 }), kv)).toBe(1);
});

test("the table is capped and a run that misses the cut is not stored", () => {
  const kv = fakeKv();
  for (let i = 0; i < TABLE_SIZE; i++) {
    recordScore("normal", run(1000 + i * 100, { at: 1000 + i }), kv);
  }
  expect(recordScore("normal", run(50), kv)).toBeNull();
  const top = topScores("normal", kv);
  expect(top).toHaveLength(TABLE_SIZE);
  expect(top.some((r) => r.score === 50)).toBe(false);
});

test("difficulties keep separate tables", () => {
  const kv = fakeKv();
  recordScore("normal", run(500), kv);
  recordScore("hard", run(200), kv);
  expect(topScores("normal", kv).map((r) => r.score)).toEqual([500]);
  expect(topScores("hard", kv).map((r) => r.score)).toEqual([200]);
});

test("corrupt or foreign stored values degrade to an empty table", () => {
  expect(loadScores(fakeKv("not json"))).toEqual({});
  expect(loadScores(fakeKv("null"))).toEqual({});
  expect(loadScores(fakeKv('{"normal":"nope"}'))).toEqual({});
  // Entries missing fields (or with a bogus hull) are dropped, valid ones stay.
  const kv = fakeKv(
    '{"normal":[{"score":1},{"score":9,"wave":2,"kills":1,"at":3,"archetype":"zzz"},' +
      '{"score":7,"wave":2,"kills":1,"at":3,"archetype":"scout"}]}',
  );
  expect(topScores("normal", kv)).toEqual([
    { score: 7, wave: 2, kills: 1, at: 3, archetype: "scout" },
  ]);
});

const arcadeWorld = (): World =>
  initArcadeWorld(1, buildRunConfig("heavy", "hard"));

test("runScore is null while the run is still live", () => {
  expect(runScore(arcadeWorld())).toBeNull();
});

test("runScore reads the finished run off the world", () => {
  const w = arcadeWorld();
  const scored: World = { ...w, score: { ...w.score, cyan: 700 } };
  const over = patchWaves(patchRun(scored, { over: true, kills: 21 }), {
    wave: 9,
  });
  expect(runScore(over, 42)).toEqual({
    difficulty: "hard",
    entry: { score: 700, wave: 9, kills: 21, archetype: "heavy", at: 42 },
  });
});
