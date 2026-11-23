const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  arenaLinearMovement,
  arenaMovement,
} = require('../src/features/arena-fighter/arena-movement.ts');
const {
  ArenaController,
  ARENA_RULES,
} = require('../src/features/arena-fighter/arena-controller.ts');
const { ArenaMatch } = require('../src/features/arena-fighter/arena-match.ts');
const { distance } = require('../src/features/arena-fighter/arena-combat-motion.ts');

function near(actual, expected, tolerance = 1e-6, label = '') {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label ? `${label}: ` : ''}${actual} != ${expected} (tol=${tolerance})`
  );
}

function soloHarness(rules = {}) {
  const c = new ArenaController(
    {
      cpuEnabled: false,
      spawn: 0.04,
      punchHitstop: 0,
      uppercutHitstop: 0,
      blockHitstop: 0,
      ...rules,
    },
    () => 0
  );
  const token = c.attachSession(1);
  c.setLandscape(true);
  c.setVirtualReady(token, true);
  for (const a of ['arena', 'blue', 'red']) {
    c.assetLoaded(token, c.getSnapshot().placementVersion, a);
  }
  const step = (seconds) => {
    let rem = seconds;
    while (rem > 1e-8) {
      const dt = Math.min(rem, 1 / 60);
      c.tick(token, dt);
      rem -= dt;
    }
  };
  step(0.5);
  assert.equal(c.ready(), true);
  return { c, token, step, s: () => c.getSnapshot() };
}

test('arenaMovement does not pin partial retreat against a faster approach at minimum separation', () => {
  const rules = { boundary: 0.54, separation: 0.14 };
  const dt = 0.05;
  const before = {
    blue: { x: 0, z: 0.07 },
    red: { x: 0, z: -0.07 },
  };
  // Red retreats partially (-0.04 m/s), Blue approaches faster (+0.08 m/s).
  // Both start at exact minimum separation (0.14).
  const after = arenaMovement(
    before,
    { blue: { advance: 0.08, strafe: 0 }, red: { advance: -0.04, strafe: 0 } },
    dt,
    rules
  );

  // Red must retreat its full requested distance (-0.04 * 0.05 = -0.002 m away from Blue -> z = -0.072).
  near(after.red.z, -0.072, 1e-6, 'red partial retreat unpinned');
  // Blue can advance into the space opened by Red's retreat, keeping exact separation (0.14).
  near(after.blue.z, 0.068, 1e-6, 'blue closes only the opened gap');
  near(distance(after.blue, after.red), rules.separation, 1e-6, 'minimum separation preserved');

  // Symmetric check when Blue retreats partially and Red approaches faster.
  const flipped = arenaMovement(
    before,
    { blue: { advance: -0.04, strafe: 0 }, red: { advance: 0.08, strafe: 0 } },
    dt,
    rules
  );
  near(flipped.blue.z, 0.072, 1e-6, 'blue partial retreat unpinned');
  near(flipped.red.z, -0.068, 1e-6, 'red closes only the opened gap');
  near(distance(flipped.blue, flipped.red), rules.separation, 1e-6, 'symmetric separation');
});

test('arenaMovement preserves separation and ring bounds across reverse, mixed radial/tangential, and wall-clamp cases', () => {
  const rules = { boundary: 0.54, separation: 0.14 };
  const dt = 0.05;

  // Mixed radial + tangential while near the ring boundary: retreating fighter clamped to boundary
  // must clamp opponent's closing first so tangential orbit still progresses cleanly.
  const wallEdge = {
    blue: { x: 0, z: -0.39 },
    red: { x: 0, z: -0.535 },
  };
  const edgeAfter = arenaMovement(
    wallEdge,
    { blue: { advance: 0.3, strafe: 0.4 }, red: { advance: -0.2, strafe: 0 } },
    dt,
    rules
  );
  assert.ok(distance(edgeAfter.blue, edgeAfter.red) >= rules.separation - 1e-6);
  assert.ok(Math.hypot(edgeAfter.blue.x, edgeAfter.blue.z) <= rules.boundary + 1e-6);
  assert.ok(Math.hypot(edgeAfter.red.x, edgeAfter.red.z) <= rules.boundary + 1e-6);
  assert.ok(Math.abs(edgeAfter.blue.x) > 0.005, 'tangential orbit preserved on boundary clamp');

  // Stress grid of mixed approaching, retreating, orbiting, and clamped cases.
  const poses = [
    { blue: { x: 0, z: 0.07 }, red: { x: 0, z: -0.07 } },
    { blue: { x: 0.12, z: 0.18 }, red: { x: 0.12, z: 0.04 } },
    { blue: { x: 0.3, z: 0.25 }, red: { x: 0.45, z: 0.24 } },
    { blue: { x: -0.2, z: -0.3 }, red: { x: 0.15, z: 0.2 } },
  ];
  const vels = [
    { advance: 0.5, strafe: 0 },
    { advance: -0.5, strafe: 0 },
    { advance: 0.4, strafe: 0.4 },
    { advance: -0.25, strafe: -0.45 },
    { advance: 0, strafe: 0.6 },
    { advance: 0.15, strafe: -0.5 },
  ];
  for (const p of poses) {
    for (const vb of vels) {
      for (const vr of vels) {
        const res = arenaMovement(p, { blue: vb, red: vr }, dt, rules);
        for (const id of ['blue', 'red']) {
          assert.ok(Number.isFinite(res[id].x) && Number.isFinite(res[id].z));
          assert.ok(Math.hypot(res[id].x, res[id].z) <= rules.boundary + 1e-6);
        }
        assert.ok(distance(res.blue, res.red) >= rules.separation - 1e-6);
      }
    }
  }
});

test('ArenaController analog slot drives continuous locomotion, guard slowdown, engaged zero override, and virtual readiness', () => {
  const h = soloHarness();
  assert.equal(h.c.hasNormalTracking(), false);
  assert.equal(h.c.isVirtualReady(), true);
  assert.equal(h.s().placed, false);
  assert.equal(h.s().phase, 'fighting');

  const d0 = distance(h.c.getTransform('blue'), h.c.getTransform('red'));
  // Half-strength forward analog moves at half speed and plays WalkForward.
  h.c.setAnalogMovement({ advance: 0.5, strafe: 0 });
  h.step(0.2);
  const dHalf = distance(h.c.getTransform('blue'), h.c.getTransform('red'));
  assert.ok(dHalf < d0 - 0.005);
  assert.equal(h.s().blue.clip, 'WalkForward');
  near(d0 - dHalf, ARENA_RULES.speed * 0.5 * 0.2, 1e-3, 'half analog speed');

  // Retreat selects WalkBackward and opens separation cleanly.
  h.c.setAnalogMovement({ advance: -0.8, strafe: 0 });
  h.step(0.2);
  const dRetreat = distance(h.c.getTransform('blue'), h.c.getTransform('red'));
  assert.ok(dRetreat > dHalf + 0.008);
  assert.equal(h.s().blue.clip, 'WalkBackward');

  // Left and right orbit select StrafeLeft / StrafeRight while preserving separation/bounds.
  h.c.setAnalogMovement({ advance: 0, strafe: 0.9 });
  h.step(0.15);
  assert.equal(h.s().blue.clip, 'StrafeLeft');

  h.c.setAnalogMovement({ advance: 0, strafe: -0.9 });
  h.step(0.15);
  assert.equal(h.s().blue.clip, 'StrafeRight');

  // Guard slowdown reduces analog velocity to ARENA_RULES.guardSpeed.
  assert.equal(h.c.command('block-down', 'blue'), true);
  h.step(ARENA_RULES.guardStartup + 0.05);
  assert.equal(h.s().blue.guardState, 'holding');
  const guardStart = h.c.getTransform('blue');
  h.c.setAnalogMovement({ advance: 1, strafe: 0 });
  h.step(0.1);
  assert.equal(h.s().blue.clip, 'BlockAdvance');
  near(
    distance(guardStart, h.c.getTransform('blue')),
    ARENA_RULES.speed * ARENA_RULES.guardSpeed * 0.1,
    1e-3,
    'guard slows analog movement'
  );
  assert.equal(h.c.command('block-up', 'blue'), true);
  h.step(ARENA_RULES.guardExit + 0.05);

  // Engaged analog zero overrides stale held digital buttons.
  h.c.setMovement('advance', true, undefined, 'blue');
  h.c.setMovement('strafeLeft', true, undefined, 'blue');
  h.c.setAnalogMovement({ advance: 0, strafe: 0 });
  const pinnedPos = h.c.getTransform('blue');
  h.step(0.2);
  near(h.c.getTransform('blue').x, pinnedPos.x, 1e-6, 'engaged zero blocks stale held advance X');
  near(h.c.getTransform('blue').z, pinnedPos.z, 1e-6, 'engaged zero blocks stale held advance Z');
  assert.equal(h.s().blue.clip, 'IdleAggro');

  // Releasing analog slot (null) restores digital/button fallback cleanly.
  h.c.setAnalogMovement(null);
  h.step(0.25);
  assert.ok(
    distance(pinnedPos, h.c.getTransform('blue')) > 0.01,
    'digital fallback restored when analog is null'
  );
});

test('ArenaMatch preserves active CPU combat alongside Quest virtual readiness and analog input', () => {
  const match = new ArenaMatch('solo');
  const token = match.attachSession(1);
  match.setLandscape(true);
  match.setVirtualReady(token, true);
  for (const a of ['arena', 'blue', 'red']) {
    match.assetLoaded(token, match.getSnapshot().placementVersion, a);
  }
  assert.equal(match.ready(), true);
  for (let i = 0; i < 60; i++) {
    match.tick(token, 0.05);
    if (match.getSnapshot().stage === 'fighting') break;
  }
  assert.equal(match.getSnapshot().stage, 'fighting');

  let cpuMovedOrAttacked = false;
  const redStart = { ...match.getTransform('red') };
  match.setAnalogMovement({ advance: 0.7, strafe: 0.3 });
  for (let i = 0; i < 60; i++) {
    match.tick(token, 0.05);
    const s = match.getSnapshot();
    const blueNow = match.getTransform('blue');
    const redNow = match.getTransform('red');
    if (
      distance(redStart, redNow) > 0.01 ||
      s.red.clip !== 'IdleAggro' ||
      s.blue.health < ARENA_RULES.health
    ) {
      cpuMovedOrAttacked = true;
    }
    assert.ok(distance(blueNow, redNow) >= ARENA_RULES.separation - 1e-6);
    assert.ok(Math.hypot(blueNow.x, blueNow.z) <= ARENA_RULES.boundary + 1e-6);
    assert.ok(Math.hypot(redNow.x, redNow.z) <= ARENA_RULES.boundary + 1e-6);
  }
  assert.equal(cpuMovedOrAttacked, true, 'CPU stays active and obeys bounds during analog solo');

  // Pause via appActive=false clears analog and stops simulation until resumed.
  match.setAppActive(false);
  assert.equal(match.getSnapshot().stage, 'paused');
  const pausedBlue = { ...match.getTransform('blue') };
  match.tick(token, 0.05);
  near(match.getTransform('blue').x, pausedBlue.x, 1e-6, 'no drift while paused');
  near(match.getTransform('blue').z, pausedBlue.z, 1e-6, 'no drift while paused');
  match.dispose();
});

test('arenaLinearMovement and stableFacing keep phone AR defaults intact while preventing orbit-induced approach', () => {
  assert.equal(ARENA_RULES.boundary, 0.14 * 1.25);
  assert.equal(ARENA_RULES.separation, 0.055);
  assert.equal(ARENA_RULES.stableFacing, false);
  assert.equal(ARENA_RULES.cpuEnabled, true);

  const rules = { boundary: 0.205, separation: 0.085 };
  // Sideways movement from spawn (-0.095, 0) moves strictly parallel to Z without curving toward red (+0.095, 0).
  let state = { blue: { x: -0.095, z: 0 }, red: { x: 0.095, z: 0 } };
  for (let i = 0; i < 20; i++) {
    state = arenaLinearMovement(
      state,
      { blue: { vx: 0, vz: -0.08 }, red: { vx: 0, vz: 0 } },
      0.05,
      rules
    );
  }
  near(state.blue.x, -0.095, 1e-6, 'pure sideways strafe preserves X coordinate');
  assert.ok(state.blue.z < -0.075, 'pure sideways strafe moves linearly along -Z');
  assert.ok(distance(state.blue, state.red) > distance({ x: -0.095, z: 0 }, state.red));

  // Stress grid: linear movement preserves separation and boundary invariants across pinch/slide cases.
  const poses = [
    { blue: { x: -0.085, z: 0 }, red: { x: 0, z: 0 } },
    { blue: { x: 0.12, z: 0.14 }, red: { x: 0.12, z: 0.05 } },
    { blue: { x: -0.19, z: 0 }, red: { x: -0.1, z: 0 } },
  ];
  const vels = [
    { vx: 0.12, vz: 0 },
    { vx: -0.12, vz: 0 },
    { vx: 0, vz: 0.12 },
    { vx: 0.08, vz: -0.08 },
    { vx: -0.08, vz: 0.08 },
  ];
  for (const p of poses) {
    for (const vb of vels) {
      for (const vr of [{ vx: 0, vz: 0 }, ...vels.slice(0, 2)]) {
        const res = arenaLinearMovement(p, { blue: vb, red: vr }, 0.05, rules);
        assert.ok(distance(res.blue, res.red) >= rules.separation - 1e-6);
        assert.ok(Math.hypot(res.blue.x, res.blue.z) <= rules.boundary + 1e-6);
        assert.ok(Math.hypot(res.red.x, res.red.z) <= rules.boundary + 1e-6);
      }
    }
  }
});

test('ArenaController Quest directional dash prevents tunneling at extreme speeds, respects diagonal wall/opponent boundaries, leaves guardStamina untouched, and isolates phone AR', () => {
  // Phone AR rules keep dash disabled and preserve JumpBack + CPU defaults.
  assert.equal(ARENA_RULES.dashEnabled, false);
  const phone = soloHarness();
  assert.equal(phone.c.dash({ advance: 1, strafe: 0 }), false);
  assert.equal(phone.c.command('jump-back', 'blue'), true);
  assert.equal(phone.s().blue.mode, 'hop');
  assert.equal(phone.s().blue.clip, 'JumpBack');
  const phoneMatch = new ArenaMatch('solo');
  const phoneTok = phoneMatch.attachSession(1);
  phoneMatch.setLandscape(true);
  phoneMatch.setVirtualReady(phoneTok, true);
  for (const a of ['arena', 'blue', 'red']) {
    phoneMatch.assetLoaded(phoneTok, phoneMatch.getSnapshot().placementVersion, a);
  }
  assert.equal(phoneMatch.ready(), true);
  for (let i = 0; i < 60 && phoneMatch.getSnapshot().stage !== 'fighting'; i++) {
    phoneMatch.tick(phoneTok, 0.05);
  }
  assert.equal(phoneMatch.dash({ advance: 1, strafe: 0 }), false);
  phoneMatch.dispose();
  phone.c.dispose();

  // Quest dash: extreme speed anti-tunneling directly toward opponent & wall across large ticks.
  const q = soloHarness({
    boundary: 0.205,
    separation: 0.085,
    stableFacing: true,
    dashEnabled: true,
    dashTravel: 0.8, // extreme travel > ring diameter to stress anti-tunneling
    dashDuration: 0.2,
    dashRecovery: 0.25,
    spawn: 0.095,
  });
  const redAtStart = { ...q.c.getTransform('red') };
  const initialStamina = q.s().blue.guardStamina;
  assert.equal(initialStamina, ARENA_RULES.guardCapacity);

  // Dash straight into stationary opponent at extreme speed -> never tunnels to opposite side of red.
  assert.equal(q.c.dash({ advance: 1, strafe: 0 }), true);
  for (let i = 0; i < 5; i++) {
    q.c.tick(q.token, 0.05);
    const blue = q.c.getTransform('blue');
    const red = q.c.getTransform('red');
    assert.ok(blue.x < red.x, `never tunneled past opponent (blue.x=${blue.x}, red.x=${red.x})`);
    assert.ok(distance(blue, red) >= 0.085 - 1e-6, 'separation maintained throughout step');
    assert.ok(Math.hypot(blue.x, blue.z) <= 0.205 + 1e-6, 'boundary maintained throughout step');
    near(blue.lift, 0, 1e-9, 'no vertical lift during Quest dash');
  }
  near(q.s().blue.guardStamina, initialStamina, 1e-9, 'guardStamina never charged by dash');

  // Even when guardStamina is below guardMinimum, dash still works (uses separate future stamina hook).
  q.c.fighters.blue.guardStamina = 5;
  q.step(0.3);
  assert.equal(q.c.dash({ advance: -1, strafe: 0 }), true);
  q.step(0.25);
  near(
    q.s().blue.guardStamina,
    5 + ARENA_RULES.guardRegen * 0.55,
    1,
    'guardStamina only follows guard regen'
  );

  // Diagonal dash starting flush against opponent slides around separation without violating bounds.
  q.c.fighters.blue.x = redAtStart.x - 0.085;
  q.c.fighters.blue.z = 0;
  q.step(0.3);
  assert.equal(q.c.dash({ advance: 0, strafe: 0 }), false);
  // Straight head-on when flush against opponent rejects gracefully (< dashMinimum).
  assert.equal(q.c.dash({ advance: 1, strafe: 0 }), false);
  // Diagonal forward-left slides cleanly along opponent perimeter.
  assert.equal(q.c.dash({ advance: 1, strafe: 1 }), true);
  for (let i = 0; i < 6; i++) {
    q.c.tick(q.token, 0.04);
    const blue = q.c.getTransform('blue');
    assert.ok(distance(blue, redAtStart) >= 0.085 - 1e-6);
    assert.ok(Math.hypot(blue.x, blue.z) <= 0.205 + 1e-6);
  }

  // Wall boundary check: flush at -X wall rejects straight outward dash, allows diagonal wall slide.
  q.c.fighters.blue.x = -0.205;
  q.c.fighters.blue.z = 0;
  q.step(0.3);
  assert.equal(q.c.dash({ advance: -1, strafe: 0 }), false);
  assert.equal(q.c.dash({ advance: -1, strafe: 1 }), true);
  for (let i = 0; i < 6; i++) {
    q.c.tick(q.token, 0.04);
    const blue = q.c.getTransform('blue');
    assert.ok(Math.hypot(blue.x, blue.z) <= 0.205 + 1e-6);
  }

  // Blocking rejects dash cleanly without consuming guardStamina or buffering.
  q.step(0.3);
  assert.equal(q.c.command('block-down', 'blue'), true);
  q.step(0.15);
  assert.equal(q.c.dash({ advance: -1, strafe: 0 }), false);
  assert.equal(q.c.command('block-up', 'blue'), true);
  q.step(0.15);
  assert.equal(q.c.isDashing('blue'), false);

  // Future DashStaminaHook integrates cleanly without touching guardStamina.
  let spent = 0;
  const hooked = soloHarness({
    boundary: 0.205,
    separation: 0.085,
    stableFacing: true,
    dashEnabled: true,
    dashStaminaCost: 25,
  });
  let pool = 20;
  hooked.c.setDashStaminaHook({
    canAfford: (_id, cost) => pool >= cost,
    spend: (_id, cost) => {
      pool -= cost;
      spent += cost;
    },
  });
  assert.equal(hooked.c.dash({ advance: -1, strafe: 0 }), false);
  pool = 40;
  assert.equal(hooked.c.dash({ advance: -1, strafe: 0 }), true);
  assert.equal(spent, 25);
  assert.equal(pool, 15);
  assert.equal(hooked.s().blue.guardStamina, ARENA_RULES.guardCapacity);
  hooked.c.dispose();
  q.c.dispose();
});
