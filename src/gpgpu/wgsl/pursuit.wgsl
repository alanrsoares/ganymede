// Pursuit kernel — the per-ship REDUCTION proof (vs P3's accumulation). Each
// thread scans every other ship and picks ONE foe (argmax/argmin), then derives
// the pursuit steering force. Mirrors pickFoe + steerPursuit (steering.ts):
//   pickFoe  — enemy within engageR; focus ranks pick max targetPriority
//              (level*bounty - hp, tiebreak nearest), others pick nearest.
//   pursuit  — press toward the foe (rammers/counters bore to contact, others
//              hold the rank's kite standoff), split to flanks by id parity,
//              scaled by combatAggression (health × fuel × matchup).
//
// NO spatial grid here: engageR (95..150) is near arena-scale (480x270), so the
// grid would need cellH >= 150 -> floor(270/150)=1 cell/axis < 3 (illegal), and
// nearly every enemy is a candidate anyway. So this is a brute O(n^2) scan —
// still a huge win from per-ship parallelism (like the P0 brute separation).
//
// SoA inputs: posHead [x,y,dx,dy]; combat [team, level, archetype, id]; health
// [hp, maxHp, fuel, maxFuel]. Per-level tables (engageGain/engageRadius/kiteDist)
// ride in P.levels[level-1]; the archetype counter web + rammer flag are baked
// as consts (matched by the CPU oracle — parity catches any drift).

struct PursuitParams {
  n: u32,
  arenaW: f32,
  arenaH: f32,
  coordMinLevel: f32,
  concaveGain: f32,
  concaveCommitDist: f32,
  vetBounty: f32,
  pad0: f32,
  aggroMin: f32,
  aggroMax: f32,
  aggroFavor: f32,
  aggroFear: f32,
  // per level (index level-1): [engageGain, engageRadius, kiteDist, _]
  levels: array<vec4<f32>, 5>,
};

@group(0) @binding(0) var<uniform> P: PursuitParams;
@group(0) @binding(1) var<storage, read> posHead: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> combat: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> health: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> force: array<vec2<f32>>;

// Archetype counter web (each beats the next): scout(0)->interceptor(3),
// fighter(1)->scout(0), heavy(2)->fighter(1), interceptor(3)->heavy(2).
fn counterOf(a: u32) -> u32 {
  if (a == 0u) { return 3u; }
  if (a == 1u) { return 0u; }
  if (a == 2u) { return 1u; }
  return 2u;
}

// Only the heavy (2) is a rammer.
fn isRammerA(a: u32) -> bool { return a == 2u; }

// How hard self presses this foe, in [aggroMin, aggroMax] (combatAggression).
fn aggression(hpFrac: f32, fuelFrac: f32, selfA: u32, foeA: u32) -> f32 {
  let fuelFactor = 0.5 + 0.5 * min(1.0, fuelFrac / 0.5);
  var matchup = 1.0;
  if (counterOf(selfA) == foeA) { matchup = P.aggroFavor; }
  else if (counterOf(foeA) == selfA) { matchup = P.aggroFear; }
  let raw = hpFrac * fuelFactor * matchup;
  return max(P.aggroMin, min(P.aggroMax, raw));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }

  let me = posHead[i];
  let ci = combat[i];
  let teamI = ci.x;
  let levelI = u32(ci.y);
  let selfA = u32(ci.z);
  let idI = u32(ci.w);

  let lv = P.levels[levelI - 1u];
  let engageGain = lv.x;
  let engageR = lv.y;
  let rangeSq = engageR * engageR;
  let focus = isRammerA(selfA) || f32(levelI) >= P.coordMinLevel;

  // --- Reduction: pick the foe ------------------------------------------------
  var bestP = -3.4e38;
  var bestD2 = rangeSq;
  var ex = 0.0;
  var ey = 0.0;
  var foeA = 0u;
  var found = false;
  for (var j: u32 = 0u; j < P.n; j = j + 1u) {
    if (j == i) { continue; }
    let cj = combat[j];
    if (cj.x == teamI) { continue; } // same team
    let oj = posHead[j];
    let dx = wrapDelta(me.x, oj.x, P.arenaW); // self -> enemy
    let dy = wrapDelta(me.y, oj.y, P.arenaH);
    let d2 = dx * dx + dy * dy;
    if (d2 >= rangeSq) { continue; }
    let pr = cj.y * P.vetBounty - health[j].x; // targetPriority
    var beats = d2 < bestD2;
    if (focus) { beats = pr > bestP || (pr == bestP && d2 < bestD2); }
    if (beats) {
      bestP = pr;
      bestD2 = d2;
      ex = dx;
      ey = dy;
      foeA = u32(cj.z);
      found = true;
    }
  }

  if (!found || engageGain <= 0.0) {
    force[i] = vec2<f32>(0.0, 0.0);
    return;
  }

  // --- Pursuit force ----------------------------------------------------------
  let press = isRammerA(selfA) || counterOf(selfA) == foeA;
  let kiteDist = select(lv.z, 0.0, press);
  let hi = health[i];
  let hpFrac = select(1.0, hi.x / hi.y, hi.y > 0.0);
  let fuelFrac = select(1.0, hi.z / hi.w, hi.w > 0.0);
  let aggro = aggression(hpFrac, fuelFrac, selfA, foeA);

  let d = select(1.0, sqrt(bestD2), bestD2 > 0.0);
  let ux = ex / d;
  let uy = ey / d;
  let dir = select(1.0, sign(d - kiteDist), kiteDist > 0.0);
  let side = select(-1.0, 1.0, (idI % 2u) == 0u);
  let arc = select(
    0.0,
    P.concaveGain * side * min(1.0, d / P.concaveCommitDist),
    press,
  );
  let tx = ux * dir - uy * arc; // perpendicular flank drift
  let ty = uy * dir + ux * arc;
  force[i] = vec2<f32>(tx * engageGain * aggro, ty * engageGain * aggro);
}
