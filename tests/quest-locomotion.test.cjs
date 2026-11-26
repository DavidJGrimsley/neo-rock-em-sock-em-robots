const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const {
  QUEST_HEAD_SAMPLE_STALE_MS,
  QUEST_STICK_DEADZONE,
  evaluateQuestDashInput,
  mapLeftThumbstick,
  mapViewRelativeThumbstick,
  questLocomotionFromInput,
  resolveQuestHeadHeading,
} = require('../src/features/quest-vr/quest-locomotion.ts');
const { createQuestInputSource } = require('../src/features/quest-vr/quest-input-source.ts');
const {
  QUEST_ARENA_RULES,
  createQuestArenaSession,
} = require('../src/features/quest-vr/quest-arena-session.ts');
const {
  QUEST_FIRST_PERSON_ARM_SCALE,
  QUEST_HAND_PALM_CENTER_MODEL,
  placeQuestFirstPersonArms,
} = require('../src/features/quest-vr/quest-first-person-arms.ts');
const {
  DEFAULT_CALIBRATION,
  QUEST_HEAD_BOUNDS,
  QUEST_WORLD_SCALE,
  ROBOT_EYE_MODEL,
  applyRig,
  questComposedRigTransform,
  questRigTransform,
  wrap180,
} = require('../src/features/quest-vr/quest-head-rig.ts');
const { questRuntime } = require('../src/features/quest-vr/quest-runtime-store.ts');
const { createQuestHeadTracker } = require('../src/features/quest-vr/quest-head-tracker.ts');
const { distance } = require('../src/features/arena-fighter/arena-combat-motion.ts');
const {
  ARENA_LAYOUT,
  ARENA_RULES,
  ArenaController,
} = require('../src/features/arena-fighter/arena-controller.ts');
const { ArenaMatch } = require('../src/features/arena-fighter/arena-match.ts');

const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function near(actual, expected, tolerance = 1e-6, label = '') {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label ? `${label}: ` : ''}${actual} != ${expected}`
  );
}

let sampleClockNs = 1_000_000_000;
function makeSample(overrides = {}) {
  const stick = overrides.stick ?? [0, 0];
  return {
    seq: overrides.seq ?? 1,
    refEpoch: overrides.refEpoch,
    timestampNs: overrides.timestampNs ?? 1_000_000_000,
    capturedNs: overrides.timestampNs ?? (sampleClockNs += 16_000_000),
    focused: overrides.focused ?? true,
    actionsReady: overrides.actionsReady ?? true,
    left: {
      hand: 'left',
      position: [0, 1.3, -0.3],
      orientation: [0, 0, 0, 1],
      positionValid: true,
      positionTracked: true,
      orientationTracked: true,
      tracking: overrides.leftTracking ?? 'tracked',
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      thumbstick: {
        active: overrides.stickActive ?? true,
        x: stick[0],
        y: stick[1],
      },
      trigger: { active: true, value: overrides.leftTrigger ?? 0 },
      squeeze: { active: true, value: overrides.leftSqueeze ?? 0 },
      buttons: {
        primary: overrides.leftPrimary ?? false,
        secondary: overrides.leftSecondary ?? false,
        menu: overrides.leftMenu ?? false,
      },
    },
    right: {
      hand: 'right',
      position: [0.2, 1.3, -0.3],
      orientation: [0, 0, 0, 1],
      positionValid: true,
      positionTracked: true,
      orientationTracked: true,
      tracking: overrides.rightTracking ?? 'tracked',
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      thumbstick: { active: true, x: 0, y: 0 },
      trigger: { active: true, value: overrides.rightTrigger ?? 0 },
      squeeze: { active: true, value: overrides.rightSqueeze ?? 0 },
      buttons: {
        primary: overrides.rightPrimary === undefined ? false : overrides.rightPrimary,
        secondary: overrides.rightSecondary ?? false,
        menu: null,
      },
    },
  };
}

function makeFrameClock() {
  let timeMs = 1000;
  const timers = new Map();
  const frames = new Map();
  let nextTimerId = 1;
  let nextFrameId = 1;
  return {
    now: () => timeMs,
    get pendingFrames() {
      return frames.size;
    },
    get pendingTimers() {
      return timers.size;
    },
    clock: {
      now: () => timeMs,
      schedule: (cb, delay) => {
        const id = nextTimerId++;
        timers.set(id, { cb, delay });
        return id;
      },
      cancel: (id) => {
        timers.delete(id);
      },
      scheduleFrame: (cb) => {
        const id = nextFrameId++;
        frames.set(id, cb);
        return id;
      },
      cancelFrame: (id) => {
        frames.delete(id);
      },
    },
    stepFrame(dtMs = 16.6667) {
      timeMs += dtMs;
      const queued = [...frames.entries()];
      frames.clear();
      for (const [, cb] of queued) cb();
    },
  };
}

test('mapLeftThumbstick enforces deadzone, cardinal signs, normalized diagonals, and analog scaling', () => {
  assert.equal(QUEST_STICK_DEADZONE, 0.15);

  // Deadzone interior (orthogonal and diagonal inside radius 0.15).
  for (const [x, y] of [
    [0, 0],
    [0.149, 0],
    [0, -0.149],
    [0.1, 0.1], // hypot ~= 0.1414 < 0.15
    [-0.105, -0.105], // hypot ~= 0.1485 < 0.15
    [Number.NaN, 0],
  ]) {
    const out = mapLeftThumbstick(x, y);
    assert.deepEqual(out, { advance: 0, strafe: 0, active: false, magnitude: 0 });
  }

  // Cardinal directions: +Y advance, -Y retreat, -X strafeLeft (+), +X strafeRight (-).
  const fwd = mapLeftThumbstick(0, 1);
  near(fwd.advance, 1);
  near(fwd.strafe, 0);
  assert.equal(fwd.active, true);
  near(fwd.magnitude, 1);

  const back = mapLeftThumbstick(0, -1);
  near(back.advance, -1);
  near(back.strafe, 0);

  const left = mapLeftThumbstick(-1, 0);
  near(left.advance, 0);
  near(left.strafe, 1);

  const right = mapLeftThumbstick(1, 0);
  near(right.advance, 0);
  near(right.strafe, -1);

  // Mid-magnitude analog scaling.
  const midX = (0.15 + 1) / 2; // 0.575 -> exact 0.5 rescaled
  const mid = mapLeftThumbstick(0, midX);
  near(mid.magnitude, 0.5, 1e-6);
  near(mid.advance, 0.5, 1e-6);
  near(mid.strafe, 0, 1e-6);

  // All four corner diagonals are radially normalized (no sqrt(2) speed boost).
  for (const [x, y, signAdv, signStrafe] of [
    [1, 1, 1, -1],
    [-1, 1, 1, 1],
    [-1, -1, -1, 1],
    [1, -1, -1, -1],
    [0.707, 0.707, 1, -1],
    [-0.707, 0.707, 1, 1],
    [-0.707, -0.707, -1, 1],
    [0.707, -0.707, -1, -1],
  ]) {
    const d = mapLeftThumbstick(x, y);
    assert.equal(d.active, true);
    assert.ok(d.magnitude <= 1 + 1e-6);
    near(Math.hypot(d.advance, d.strafe), d.magnitude, 1e-6);
    near(d.advance, signAdv * Math.SQRT1_2 * d.magnitude, 1e-3);
    near(d.strafe, signStrafe * Math.SQRT1_2 * d.magnitude, 1e-3);
  }
});

function makeHeadViroPose(yawDeg, pitchDeg = 0, rollDeg = 0, position = [0, 1.5, 0]) {
  const yr = (yawDeg * Math.PI) / 180;
  const pr = (pitchDeg * Math.PI) / 180;
  const rr = (rollDeg * Math.PI) / 180;
  const forward = [Math.sin(yr) * Math.cos(pr), Math.sin(pr), Math.cos(yr) * Math.cos(pr)];
  const upNoRoll = [-Math.sin(yr) * Math.sin(pr), Math.cos(pr), -Math.cos(yr) * Math.sin(pr)];
  const rightNoRoll = [-Math.cos(yr), 0, Math.sin(yr)];
  const up = [
    upNoRoll[0] * Math.cos(rr) + rightNoRoll[0] * Math.sin(rr),
    upNoRoll[1] * Math.cos(rr) + rightNoRoll[1] * Math.sin(rr),
    upNoRoll[2] * Math.cos(rr) + rightNoRoll[2] * Math.sin(rr),
  ];
  return { position, forward, up };
}

function makeHeadSample(t, yawDeg, pitchDeg = 0, rollDeg = 0, position = [0, 1.5, 0]) {
  return { t, ...makeHeadViroPose(yawDeg, pitchDeg, rollDeg, position) };
}

function worldForwardXZ(yawDeg) {
  const rad = (yawDeg * Math.PI) / 180;
  return [Math.sin(rad), Math.cos(rad)];
}

function worldLeftXZ(yawDeg) {
  const [fx, fz] = worldForwardXZ(yawDeg);
  return [fz, -fx];
}

function ringDisplacementFromStick(anchorYawDeg, calYawDeg, cmd) {
  const anchorRad = (anchorYawDeg * Math.PI) / 180;
  const fwd = [Math.sin(anchorRad), Math.cos(anchorRad)];
  const left = [fwd[1], -fwd[0]];
  const dpRing = [
    fwd[0] * cmd.advance + left[0] * cmd.strafe,
    0,
    fwd[1] * cmd.advance + left[1] * cmd.strafe,
  ];
  // Under questRigTransform, world(ringP) = cal.origin + R_y(cal.yaw - anchor.yaw) * scale * (ringP - eye(anchor)).
  // Moving anchor by +dpRing shifts static world objects by -R_y(cal.yaw - anchor.yaw) * scale * dpRing,
  // which corresponds to player eye displacement +R_y(cal.yaw - anchor.yaw) * dpRing in OpenXR LOCAL.
  const rigRotRad = ((calYawDeg - anchorYawDeg) * Math.PI) / 180;
  const cos = Math.cos(rigRotRad);
  const sin = Math.sin(rigRotRad);
  return [dpRing[0] * cos + dpRing[2] * sin, -dpRing[0] * sin + dpRing[2] * cos];
}

test('questLocomotionFromInput enforces safety gates and maps view-relative horizontal directions across head yaw, pitch/roll, degenerate gaze, and stale samples', () => {
  // Pure view-relative cardinal directions across 0, 90, 180, 270 deg head yaw and differing calibration yaws.
  for (const calYaw of [180, 90, 0, -90, 135, -45]) {
    for (const headYaw of [0, 90, 180, 270, -90]) {
      const head = {
        sample: makeHeadSample(1000, headYaw),
        calibration: { yaw: calYaw },
        nowMs: 1014,
      };
      const cases = [
        { stick: [0, 1], expected: worldForwardXZ(headYaw), label: 'up->forward' },
        {
          stick: [0, -1],
          expected: worldForwardXZ(headYaw).map((v) => -v),
          label: 'down->back',
        },
        { stick: [-1, 0], expected: worldLeftXZ(headYaw), label: 'left->left' },
        {
          stick: [1, 0],
          expected: worldLeftXZ(headYaw).map((v) => -v),
          label: 'right->right',
        },
      ];
      for (const { stick, expected, label } of cases) {
        const cmd = questLocomotionFromInput({
          sample: makeSample({ stick }),
          status: 'live',
          menuFocused: false,
          appActive: true,
          head,
        });
        assert.equal(cmd.active, true);
        near(cmd.magnitude, 1, 1e-6);
        near(Math.hypot(cmd.advance, cmd.strafe), 1, 1e-6);
        const worldDir = ringDisplacementFromStick(90, calYaw, cmd);
        near(worldDir[0], expected[0], 1e-6, `cal=${calYaw} head=${headYaw} ${label} worldX`);
        near(worldDir[1], expected[1], 1e-6, `cal=${calYaw} head=${headYaw} ${label} worldZ`);
      }

      // All 4 diagonal directions stay normalized to <= 1 (no sqrt(2) boost) and steer view-relatively at any head yaw.
      const fwdXZ = worldForwardXZ(headYaw);
      const leftXZ = worldLeftXZ(headYaw);
      const diagNorm = Math.SQRT1_2;
      for (const [sx, sy, df, dl, dlabel] of [
        [-1, 1, 1, 1, 'up-left'],
        [1, 1, 1, -1, 'up-right'],
        [-1, -1, -1, 1, 'down-left'],
        [1, -1, -1, -1, 'down-right'],
      ]) {
        const diag = questLocomotionFromInput({
          sample: makeSample({ stick: [sx, sy] }),
          status: 'live',
          head,
        });
        near(diag.magnitude, 1, 1e-6);
        near(Math.hypot(diag.advance, diag.strafe), 1, 1e-6);
        const diagWorld = ringDisplacementFromStick(90, calYaw, diag);
        near(
          diagWorld[0],
          (fwdXZ[0] * df + leftXZ[0] * dl) * diagNorm,
          1e-6,
          `cal=${calYaw} head=${headYaw} ${dlabel} worldX`
        );
        near(
          diagWorld[1],
          (fwdXZ[1] * df + leftXZ[1] * dl) * diagNorm,
          1e-6,
          `cal=${calYaw} head=${headYaw} ${dlabel} worldZ`
        );
      }
    }
  }

  // Pitch (-60..+60) and roll (-35..+35) invariance: same horizontal heading, same speed, zero flip.
  const flatCmd = questLocomotionFromInput({
    sample: makeSample({ stick: [-0.4, 0.8] }),
    status: 'live',
    head: { sample: makeHeadSample(1000, 60, 0, 0), calibration: { yaw: 180 }, nowMs: 1010 },
  });
  for (const [pitch, roll] of [
    [-55, 25],
    [55, -30],
    [-30, -20],
    [40, 35],
  ]) {
    const tiltedCmd = questLocomotionFromInput({
      sample: makeSample({ stick: [-0.4, 0.8] }),
      status: 'live',
      head: {
        sample: makeHeadSample(1000, 60, pitch, roll),
        calibration: { yaw: 180 },
        nowMs: 1010,
      },
    });
    near(tiltedCmd.advance, flatCmd.advance, 1e-9, `pitch=${pitch} roll=${roll} advance`);
    near(tiltedCmd.strafe, flatCmd.strafe, 1e-9, `pitch=${pitch} roll=${roll} strafe`);
    near(tiltedCmd.magnitude, flatCmd.magnitude, 1e-9);
  }

  // Degenerate vertical gaze uses stable lastValidYaw fallback (or calibration.yaw when none).
  const degenerateSample = {
    t: 1000,
    position: [0, 1.5, 0],
    forward: [0.05, -0.997, 0.05],
    up: [0, 0, 1],
  };
  const degWithLast = resolveQuestHeadHeading({
    sample: degenerateSample,
    calibration: { yaw: 180 },
    lastValidYaw: 90,
    nowMs: 1010,
  });
  assert.equal(degWithLast.ok, true);
  assert.equal(degWithLast.source, 'fallback-degenerate');
  near(degWithLast.headYaw, 90, 1e-6);
  near(degWithLast.yawRelative, -90, 1e-6);

  const degNoLast = resolveQuestHeadHeading({
    sample: degenerateSample,
    calibration: { yaw: 135 },
    lastValidYaw: null,
    nowMs: 1010,
  });
  assert.equal(degNoLast.source, 'fallback-degenerate');
  near(degNoLast.headYaw, 135, 1e-6);
  near(degNoLast.yawRelative, 0, 1e-6);

  // Stale or invalid head sample falls back stably to calibration yaw instead of stale lastValidYaw.
  const staleHeading = resolveQuestHeadHeading({
    sample: makeHeadSample(1000, 45),
    calibration: { yaw: 180 },
    lastValidYaw: 45,
    nowMs: 1000 + QUEST_HEAD_SAMPLE_STALE_MS + 1,
  });
  assert.equal(staleHeading.ok, true);
  assert.equal(staleHeading.source, 'fallback-stale');
  near(staleHeading.yawRelative, 0, 1e-6);

  const invalidHeading = resolveQuestHeadHeading({
    sample: { t: 1000, position: [0, 1.5, 0], forward: [NaN, 0, -1], up: [0, 1, 0] },
    calibration: { yaw: -90 },
    lastValidYaw: 45,
    nowMs: 1005,
  });
  assert.equal(invalidHeading.source, 'fallback-calibration');
  near(invalidHeading.headYaw, -90, 1e-6);
  near(invalidHeading.yawRelative, 0, 1e-6);

  // mapViewRelativeThumbstick rejects non-finite yawRelative safely.
  assert.deepEqual(mapViewRelativeThumbstick(0, 1, NaN), {
    advance: 0,
    strafe: 0,
    active: false,
    magnitude: 0,
  });

  // Safety gates (including recentering and refEpoch mismatch) immediately neutralize to 0.
  for (const gated of [
    { sample: null, status: 'live', menuFocused: false, appActive: true },
    {
      sample: makeSample({ stick: [0.6, 0.8] }),
      status: 'waiting',
      menuFocused: false,
      appActive: true,
    },
    {
      sample: makeSample({ stick: [0.6, 0.8] }),
      status: 'stale',
      menuFocused: false,
      appActive: true,
    },
    {
      sample: makeSample({ stick: [0.6, 0.8] }),
      status: 'ended',
      menuFocused: false,
      appActive: true,
    },
    {
      sample: makeSample({ stick: [0.6, 0.8] }),
      status: 'unfocused',
      menuFocused: false,
      appActive: true,
    },
    {
      sample: makeSample({ stick: [0.6, 0.8] }),
      status: 'live',
      menuFocused: true,
      appActive: true,
    },
    {
      sample: makeSample({ stick: [0.6, 0.8] }),
      status: 'live',
      menuFocused: false,
      appActive: false,
    },
    {
      sample: makeSample({ stick: [0.6, 0.8], focused: false }),
      status: 'live',
      menuFocused: false,
      appActive: true,
    },
    {
      sample: makeSample({ stick: [0.6, 0.8], actionsReady: false }),
      status: 'live',
      menuFocused: false,
      appActive: true,
    },
    {
      sample: makeSample({ stick: [0.6, 0.8], leftTracking: 'lost' }),
      status: 'live',
      menuFocused: false,
      appActive: true,
    },
    {
      sample: makeSample({ stick: [0.6, 0.8], stickActive: false }),
      status: 'live',
      menuFocused: false,
      appActive: true,
    },
    {
      sample: makeSample({ stick: [0.6, 0.8] }),
      status: 'live',
      head: {
        sample: makeHeadSample(1000, 90),
        calibration: { yaw: 180 },
        recentering: true,
        nowMs: 1005,
      },
    },
    {
      sample: { ...makeSample({ stick: [0.6, 0.8] }), refEpoch: 2 },
      status: 'live',
      head: {
        sample: makeHeadSample(1000, 90),
        calibration: { yaw: 180 },
        refEpoch: 1,
        nowMs: 1005,
      },
    },
  ]) {
    assert.deepEqual(questLocomotionFromInput(gated), {
      advance: 0,
      strafe: 0,
      active: false,
      magnitude: 0,
    });
  }
});

test('QuestArenaSession drives real-time substepped locomotion, neutralizes cleanly, and prevents drift', () => {
  const fc = makeFrameClock();
  const session = createQuestArenaSession(fc.clock);
  let frameEvents = 0;
  const unsubFrames = session.onFrame(() => {
    frameEvents += 1;
  });

  assert.equal(session.solo(), true);
  const open = session.getSnapshot();
  assert.equal(open.virtualReady, true);
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'arena');
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'blue');
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'red');
  assert.equal(session.ready().reason, 'started');
  assert.ok(fc.pendingFrames > 0, 'loop schedules frame callbacks once started');

  // Step through countdown into fighting; clamp oversized dt (> 0.1s) cleanly.
  for (let i = 0; i < 40; i++) {
    fc.stepFrame(120); // Tests 0.1s frame cap + <=0.05s substepping
    if (session.getSnapshot().stage === 'fighting') break;
  }
  assert.equal(session.getSnapshot().stage, 'fighting');
  const viewAtStart = session.getSnapshot();
  const spawnBlue = { ...viewAtStart.transforms.blue };

  // Push left stick forward-left diagonal: live transforms update while view.transforms stays at spawn.
  session.setInputState(makeSample({ stick: [-0.707, 0.707] }), 'live');
  for (let i = 0; i < 15; i++) fc.stepFrame(16.6667);
  const moved = session.getLiveTransforms();
  assert.ok(frameEvents >= 15);
  assert.ok(distance(spawnBlue, moved.blue) > 0.01, 'live transform moves');
  assert.deepEqual(session.getSnapshot().transforms.blue, spawnBlue, 'spawn snapshot frozen');

  // Releasing stick stops motion with zero drift across subsequent frames.
  session.setInputState(makeSample({ stick: [0, 0] }), 'live');
  fc.stepFrame(16.6667);
  const settled = { ...session.getLiveTransforms().blue };
  for (let i = 0; i < 15; i++) fc.stepFrame(16.6667);
  const afterIdle = session.getLiveTransforms().blue;
  near(afterIdle.x, settled.x, 1e-6, 'no X drift after stick release');
  near(afterIdle.z, settled.z, 1e-6, 'no Z drift after stick release');

  // Menu focus neutralizes active thumbstick immediately.
  session.setInputState(makeSample({ stick: [0, 1] }), 'live');
  session.setMenuFocus(true);
  assert.deepEqual(session.getLocomotion(), { advance: 0, strafe: 0, active: false, magnitude: 0 });
  const beforeMenuWait = { ...session.getLiveTransforms().blue };
  for (let i = 0; i < 10; i++) fc.stepFrame(16.6667);
  near(session.getLiveTransforms().blue.z, beforeMenuWait.z, 1e-6, 'no movement while menuFocused');
  session.setMenuFocus(false);

  // Tracking loss & source loss neutralize immediately.
  session.setInputState(makeSample({ stick: [0, 1], leftTracking: 'lost' }), 'live');
  assert.equal(session.getLocomotion().active, false);
  session.setInputState(makeSample({ stick: [0, 1] }), 'stale');
  assert.equal(session.getLocomotion().active, false);

  // App backgrounding pauses match, neutralizes analog, and cancels frame callbacks until Ready resumes.
  session.setInputState(makeSample({ stick: [0, 1] }), 'live');
  assert.equal(session.getLocomotion().active, true);
  session.setAppActive(false);
  assert.equal(session.getSnapshot().stage, 'paused');
  assert.equal(session.getLocomotion().active, false);
  assert.equal(fc.pendingFrames, 0, 'frame loop stops on background');
  session.setAppActive(true);
  assert.equal(session.ready().reason, 'resumed');
  assert.equal(session.getSnapshot().stage, 'fighting');
  assert.ok(fc.pendingFrames > 0, 'frame loop restarts on resume');

  // Bounds invariant stays intact under extreme corner input using Quest-only rules.
  session.setInputState(makeSample({ stick: [0, 0] }), 'live');
  session.setInputState(makeSample({ stick: [1, -1] }), 'live');
  for (let i = 0; i < 40; i++) fc.stepFrame(33.33);
  const late = session.getLiveTransforms();
  assert.ok(distance(late.blue, late.red) >= QUEST_ARENA_RULES.separation - 1e-6);
  assert.ok(Math.hypot(late.blue.x, late.blue.z) <= QUEST_ARENA_RULES.boundary + 1e-6);

  // Back cancels loop cleanly.
  session.back();
  assert.equal(fc.pendingFrames, 0);
  unsubFrames();
  session.dispose();
});

test('Quest Stage 06 restores active CPU combat in solo while preserving ring constraints and default phone ArenaMatch solo CPU', () => {
  assert.equal(QUEST_ARENA_RULES.headEvasionEnabled, true);

  const fc = makeFrameClock();
  const session = createQuestArenaSession(fc.clock);
  assert.equal(session.solo(), true);
  const open = session.getSnapshot();
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'arena');
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'blue');
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'red');
  assert.equal(session.ready().reason, 'started');

  for (let i = 0; i < 40; i++) {
    fc.stepFrame(120);
    if (session.getSnapshot().stage === 'fighting') break;
  }
  assert.equal(session.getSnapshot().stage, 'fighting');

  const redSpawn = { ...session.getLiveTransforms().red };
  let cpuMoved = false;
  let cpuAttacked = false;
  let playerDamaged = false;

  for (let i = 0; i < 180; i++) {
    fc.stepFrame(33.3333);
    const snap = session.getSnapshot();
    const matchSnap = session.getMatchSnapshot();
    const live = session.getLiveTransforms();
    if (distance(live.red, redSpawn) > 0.01) cpuMoved = true;
    if (snap.fighters?.red.clip.startsWith('Combo_')) cpuAttacked = true;
    if (matchSnap && matchSnap.blue.health < ARENA_RULES.health) playerDamaged = true;
    assert.ok(
      distance(live.blue, live.red) >= QUEST_ARENA_RULES.separation - 1e-6,
      `step ${i}: Quest separation constraint enforced`
    );
    assert.ok(
      Math.hypot(live.blue.x, live.blue.z) <= QUEST_ARENA_RULES.boundary + 1e-6,
      `step ${i}: Quest ring boundary constraint enforced`
    );
    assert.ok(
      Math.hypot(live.red.x, live.red.z) <= QUEST_ARENA_RULES.boundary + 1e-6,
      `step ${i}: CPU ring boundary constraint enforced`
    );
  }
  assert.equal(cpuMoved, true, 'Quest CPU closes distance in Stage 06');
  assert.equal(cpuAttacked, true, 'Quest CPU throws attacks in Stage 06');
  assert.equal(playerDamaged, true, 'Quest CPU lands hits on undefended player');
  session.dispose();

  // Default ArenaMatch('solo') (used by phone AR solo) keeps active CPU movement and combat enabled.
  const defaultSolo = new ArenaMatch('solo');
  const token = defaultSolo.attachSession(1);
  defaultSolo.setLandscape(true);
  defaultSolo.setVirtualReady(token, true);
  for (const a of ['arena', 'blue', 'red']) {
    defaultSolo.assetLoaded(token, defaultSolo.getSnapshot().placementVersion, a);
  }
  assert.equal(defaultSolo.ready(), true);
  for (let i = 0; i < 60; i++) {
    defaultSolo.tick(token, 0.05);
    if (defaultSolo.getSnapshot().stage === 'fighting') break;
  }
  assert.equal(defaultSolo.getSnapshot().stage, 'fighting');
  const defaultRedStart = { ...defaultSolo.getTransform('red') };
  let defaultCpuActive = false;
  for (let i = 0; i < 90; i++) {
    defaultSolo.tick(token, 0.05);
    const snap = defaultSolo.getSnapshot();
    if (
      distance(defaultRedStart, defaultSolo.getTransform('red')) > 0.01 ||
      snap.red.clip !== 'IdleAggro' ||
      snap.blue.health < ARENA_RULES.health
    ) {
      defaultCpuActive = true;
      break;
    }
  }
  assert.equal(defaultCpuActive, true, 'default ArenaMatch solo CPU remains active');
  defaultSolo.dispose();
});

test('QuestRuntime tracks AppState transitions cleanly across Android/iOS/Quest safety store', () => {
  assert.equal(questRuntime.getSnapshot().appActive, true);
  questRuntime.appStateChanged(false);
  assert.equal(questRuntime.getSnapshot().appActive, false);
  questRuntime.appStateChanged(true);
  assert.equal(questRuntime.getSnapshot().appActive, true);
});

test('QuestArenaScene drives native transforms via ViroGameLoop and ViroGameLoopUtils, filters menu focus from gaze, and keeps JSX transforms frozen', async () => {
  const fc = makeFrameClock();
  const calls = {
    inputSampleHandlers: new Set(),
    nativePropsLog: [],
    transformCommands: [],
    menuFocusHistory: [],
  };
  let states = [];
  let stateIndex = 0;
  let effects = [];
  let effectIndex = 0;
  let refs = [];
  let refIndex = 0;
  let memos = [];
  let memoIndex = 0;
  let sessionInstance = null;

  let trackerSnapshot = {
    status: 'tracking',
    message: null,
    pose: {
      lateral: 0,
      vertical: 0,
      forward: 0,
      yawRelative: 0,
      clamped: false,
      outOfBounds: false,
      excess: 0,
    },
    raw: null,
    outOfBounds: false,
    anchor: null,
    sampleHz: 72,
    referenceResets: 0,
    calibration: { origin: [0, 0, 0], yaw: 0, posture: 'standing', source: 'default', entry: 1 },
  };
  const trackerListeners = new Set();

  const jsx = (type, props, key) => ({
    type,
    props: props ?? {},
    key: key ?? props?.key ?? null,
  });
  const collectNodes = (node, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      for (const item of node) collectNodes(item, out);
      return out;
    }
    out.push(node);
    if (node.props?.children) collectNodes(node.props.children, out);
    return out;
  };

  const runtimeListeners = new Set();
  let runtimeSnap = {
    exitRequest: null,
    appActive: true,
    status: 'immersive',
    vrActivityState: 'resumed',
  };
  const replayCounts = { menu: 0, title: 0 };
  const titlePresents = [];
  let compositorCreates = 0;

  const mocks = {
    react: {
      memo: (component) => component,
      useState: (initial) => {
        const idx = stateIndex++;
        if (!(idx in states)) states[idx] = typeof initial === 'function' ? initial() : initial;
        return [
          states[idx],
          (val) => {
            states[idx] = typeof val === 'function' ? val(states[idx]) : val;
          },
        ];
      },
      useEffect: (effect, deps) => {
        const idx = effectIndex++;
        const prev = effects[idx];
        const changed =
          !prev ||
          !deps ||
          !prev.deps ||
          deps.length !== prev.deps.length ||
          deps.some((d, i) => !Object.is(d, prev.deps[i]));
        if (changed) {
          prev?.cleanup?.();
          effects[idx] = { deps, cleanup: effect() };
        }
      },
      useMemo: (fn, deps) => {
        const idx = memoIndex++;
        const prev = memos[idx];
        const changed =
          !prev ||
          !deps ||
          !prev.deps ||
          deps.length !== prev.deps.length ||
          deps.some((d, i) => !Object.is(d, prev.deps[i]));
        if (changed) memos[idx] = { deps, value: fn() };
        return memos[idx].value;
      },
      useRef: (initial) => {
        const idx = refIndex++;
        if (!(idx in refs)) refs[idx] = { current: initial };
        return refs[idx];
      },
      useSyncExternalStore: (_, get) => get(),
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'expo-asset': {
      Asset: {
        fromModule: (id) => ({
          uri: `file:///${id}`,
          localUri: `file:///${id}`,
          downloadAsync: async () => {},
        }),
      },
    },
    '@reactvision/react-viro': new Proxy(
      {
        ViroMaterials: { createMaterials: () => {} },
        ViroGameLoopUtils: {
          setPosition: (ref, position) =>
            calls.transformCommands.push({
              tag: ref.current?.tag ?? null,
              cmd: 'setPosition',
              value: [...position],
            }),
          setRotation: (ref, rotation) =>
            calls.transformCommands.push({
              tag: ref.current?.tag ?? null,
              cmd: 'setRotationEuler',
              value: [...rotation],
            }),
        },
      },
      { get: (t, p) => (p in t ? t[p] : String(p)) }
    ),
    '../arena-fighter/arena-controller.ts': require('../src/features/arena-fighter/arena-controller.ts'),
    '../../../assets/arena/Fight_Arena.glb': 'arena.glb',
    '../../../assets/arena/Mike_Player1_Blue_Combat_AR.glb': 'blue.glb',
    '../../../assets/arena/Mike_Player2_RedOrange_Combat_AR.glb': 'red.glb',
    '../../../assets/arena/quest/quest-blue-body.glb': 'quest-body.glb',
    '../../../assets/arena/quest/quest-blue-upper-left.glb': 'quest-upper-left.glb',
    '../../../assets/arena/quest/quest-blue-upper-right.glb': 'quest-upper-right.glb',
    '../../../assets/arena/quest/quest-blue-forearm-left.glb': 'quest-forearm-left.glb',
    '../../../assets/arena/quest/quest-blue-forearm-right.glb': 'quest-forearm-right.glb',
    '../../../assets/arena/quest/quest-blue-hand-left.glb': 'quest-hand-left.glb',
    '../../../assets/arena/quest/quest-blue-hand-right.glb': 'quest-hand-right.glb',
    './quest-first-person-arms.ts': require('../src/features/quest-vr/quest-first-person-arms.ts'),
    '../../../assets/arena/ui/ArenaNotoSans.ttf': 'sans.ttf',
    '../../../assets/arena/ui/ArenaNotoSansSemibold.ttf': 'sans-semibold.ttf',
    '../../../assets/arena/ui/quest-lettering/neo.png': 'neo.png',
    '../../../assets/arena/ui/quest-lettering/rock.png': 'rock.png',
    '../../../assets/arena/ui/quest-lettering/robots.png': 'robots.png',
    '../../../modules/quest-panel/src/index.ts': {
      questPanelAvailable: () => false,
      questPanelNative: null,
    },
    '../../../modules/quest-input/src/index.ts': {
      questRigSyncAvailable: () => false,
      questInputNative: null,
    },
    './quest-arena-session.ts': {
      createQuestArenaSession: () => {
        const raw = createQuestArenaSession(fc.clock, undefined, { cpuEnabled: false });
        sessionInstance = {
          ...raw,
          setMenuFocus(focused) {
            calls.menuFocusHistory.push(focused);
            return raw.setMenuFocus(focused);
          },
        };
        return sessionInstance;
      },
    },
    './quest-head-tracker.ts': {
      questHeadTracker: {
        subscribe: (l) => {
          trackerListeners.add(l);
          return () => trackerListeners.delete(l);
        },
        getSnapshot: () => trackerSnapshot,
        calibrateForSolo: () => {},
        cyclePosture: () => {},
        onCameraTransform: () => {},
        setRefSpaceEpochSource: () => {},
        dispose: () => {},
      },
    },
    './quest-combat-hud.ts': require('../src/features/quest-vr/quest-combat-hud.ts'),
    './quest-head-rig.ts': require('../src/features/quest-vr/quest-head-rig.ts'),
    './quest-menu-asset-uri.ts': require('../src/features/quest-vr/quest-menu-asset-uri.ts'),
    './quest-menu-compositor.ts': {
      ...require('../src/features/quest-vr/quest-menu-compositor.ts'),
      createQuestMenuCompositor: () => {
        const slot = compositorCreates++ === 0 ? 'menu' : 'title';
        return {
          subscribe: () => () => {},
          getSnapshot: () => ({ mode: 'shown', reason: null }),
          present: (spec) => {
            if (slot === 'title') titlePresents.push(spec?.label ?? null);
          },
          hide: () => {
            if (slot === 'title') titlePresents.push('hide');
          },
          replay: () => {
            replayCounts[slot] += 1;
          },
          dispose: () => {},
        };
      },
    },
    './quest-menu-input.ts': require('../src/features/quest-vr/quest-menu-input.ts'),
    './quest-menu-layer.ts': require('../src/features/quest-vr/quest-menu-layer.ts'),
    './quest-menu-layout.ts': require('../src/features/quest-vr/quest-menu-layout.ts'),
    './quest-arena-audio.native.ts': { useQuestArenaAudio: () => {} },
    './quest-tuning.ts': require('../src/features/quest-vr/quest-tuning.ts'),
    './quest-diagnostics-layout.ts': {
      questDiagLayerMaterials: () => ({}),
    },
    './quest-runtime-store.ts': {
      questRuntime: {
        subscribe: (l) => {
          runtimeListeners.add(l);
          return () => runtimeListeners.delete(l);
        },
        getSnapshot: () => runtimeSnap,
        sceneMounted: () => {},
        sceneUnmounted: () => {},
        exitRequested: () => {},
      },
    },
    './quest-diagnostics-layout.ts': {
      questDiagLayerMaterials: () => ({}),
    },
    './quest-input-visualizer.native.tsx': {
      createSceneQuestInputSource: () => ({
        start: () => {},
        stop: () => {},
        subscribe: () => () => {},
        getSnapshot: () => null,
        onSample: (cb) => {
          calls.inputSampleHandlers.add(cb);
          return () => calls.inputSampleHandlers.delete(cb);
        },
      }),
      QuestDiagnosticsPanel: 'QuestDiagnosticsPanel',
      QuestInputMarkers: 'QuestInputMarkers',
    },
  };

  const output = ts.transpileModule(source('src/features/quest-vr/quest-arena-scene.native.tsx'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  const mod = { exports: {} };
  vm.runInNewContext(output, {
    module: mod,
    exports: mod.exports,
    console,
    Date,
    setTimeout,
    clearTimeout,
    require: (name) => mocks[name],
  });

  const Scene = mod.exports.default;
  const render = () => {
    stateIndex = 0;
    effectIndex = 0;
    refIndex = 0;
    memoIndex = 0;
    const tree = Scene();
    const all = collectNodes(tree);
    for (const n of all) {
      if (typeof n.type === 'function') all.push(...collectNodes(n.type(n.props)));
    }
    return all;
  };

  let all = render();
  assert.equal(titlePresents.includes('title menu'), true, 'menu stage presents branded title');
  const findHit = (action) => all.find((n) => n.type === 'ViroQuad' && n.key === `hit-${action}`);

  // Solo -> attach ref mocks to blue/red models and transform ViroNodes -> load assets -> Ready.
  findHit('solo').props.onClickState(1, [0, 0, 0], 1);
  findHit('solo').props.onClickState(2, [0, 0, 0], 1);
  all = render();

  const tagNode = (node, tag) => {
    if (node?.props?.ref) {
      node.props.ref.current = {
        tag,
        setNativeProps: (p) => calls.nativePropsLog.push({ node: tag, props: p }),
      };
    }
  };
  const models = all.filter((n) => n.type === 'Viro3DObject');
  for (const m of models) {
    tagNode(m, m.props.source);
    if (typeof m.props.onLoadEnd === 'function') m.props.onLoadEnd();
  }
  const rigOuterNode = all.find(
    (n) =>
      n.type === 'ViroNode' &&
      collectNodes(n.props.children).some(
        (c) => c.type === 'Viro3DObject' && c.props.source === 'arena.glb'
      )
  );
  const fighterNodes = new Map();
  for (const id of ['blue', 'red']) {
    const fn = all.find(
      (n) =>
        n.type === 'ViroNode' &&
        collectNodes(n.props.children).some(
          (c) => c.type === 'Viro3DObject' && c.props.source === `${id}.glb`
        ) &&
        n !== rigOuterNode
    );
    assert.ok(fn, `${id} fighter transform ViroNode must wrap Viro3DObject`);
    tagNode(fn, `${id}Node`);
    fighterNodes.set(id, fn);
  }
  const stanceNode = all.find(
    (n) =>
      n.type === 'ViroNode' &&
      collectNodes(n.props.children).some(
        (c) => Array.isArray(c.props?.materials) && c.props.materials.includes('questStanceRing')
      ) &&
      !collectNodes(n.props.children).some((c) => c.type === 'Viro3DObject')
  );
  tagNode(rigOuterNode, 'rigOuter');
  tagNode(stanceNode, 'stanceRing');

  const blueInitialPos = [...fighterNodes.get('blue').props.position];
  all = render();

  // Gaze (source 12) hovering on Back must NOT assert menu focus.
  findHit('back').props.onHover(true, [0, 0, 0], 12);
  assert.equal(calls.menuFocusHistory.at(-1) ?? false, false);

  // Controller ray hover (source 1) DOES set menu focus while menu is shown, and hover leave clears it promptly.
  findHit('back').props.onHover(true, [0, 0, 0], 1);
  assert.equal(calls.menuFocusHistory.at(-1), true);
  findHit('back').props.onHover(false, [0, 0, 0], 1);
  assert.equal(calls.menuFocusHistory.at(-1), false);

  // Ready starts countdown -> fighting and removes ring menu hit quads during active play.
  findHit('ready').props.onClickState(1, [0, 0, 0], 1);
  findHit('ready').props.onClickState(2, [0, 0, 0], 1);
  all = render();
  for (let i = 0; i < 40; i++) {
    fc.stepFrame(120);
    if (sessionInstance.getSnapshot().stage === 'fighting') break;
  }
  all = render();
  assert.equal(findHit('back'), undefined, 'menu hit quads are removed during active combat');
  assert.equal(findHit('ready'), undefined, 'ready/set button is removed during active combat');
  assert.equal(
    titlePresents.at(-1),
    'combat hud',
    'eyes presentation switches titleCompositor slot to live combat HUD'
  );

  // 200ms tracker snapshot ticks (outOfBounds unchanged) must keep QuestRing memoized (no GLB re-render).
  const fightingRingRef = all.find((n) => n.type?.name === 'QuestRing');
  trackerSnapshot = { ...trackerSnapshot, sampleHz: 71.9 };
  for (const l of trackerListeners) l();
  all = render();
  assert.equal(
    all.find((n) => n.type?.name === 'QuestRing'),
    fightingRingRef,
    'QuestRing element stays memoized across tracker telemetry publishes'
  );

  // ViroGameLoop drives 72Hz OpenXR frames via ViroGameLoopUtils (zero Fabric setNativeProps transform commits)
  // across continuous left/right strafing while idle red keeps facing blue smoothly without XZ translation.
  const gameLoop = all.find((n) => n.type === 'ViroGameLoop');
  assert.ok(gameLoop && typeof gameLoop.props.onUpdate === 'function');
  const stepOpenXrFrame = (dtSec = 1 / 72) => {
    calls.transformCommands.length = 0;
    calls.nativePropsLog.length = 0;
    gameLoop.props.onUpdate({ dt: dtSec, elapsed: 1 });
  };

  for (const [stickX, label] of [
    [-1, 'left'],
    [1, 'right'],
  ]) {
    for (const cb of calls.inputSampleHandlers) {
      cb(makeSample({ stick: [stickX, 0] }), 'live');
    }
    let prevRedYaw = sessionInstance.getLiveTransforms().red.yaw;
    let monotonicYawUpdates = 0;
    let totalDeltaYaw = 0;
    for (let f = 0; f < 10; f++) {
      stepOpenXrFrame(1 / 72);
      const rigPosCmds = calls.transformCommands.filter(
        (c) => c.tag === 'rigOuter' && c.cmd === 'setPosition'
      );
      const redRotCmds = calls.transformCommands.filter(
        (c) => c.tag === 'redNode' && c.cmd === 'setRotationEuler'
      );
      const redPosCmds = calls.transformCommands.filter(
        (c) => c.tag === 'redNode' && c.cmd === 'setPosition'
      );
      assert.equal(
        rigPosCmds.length,
        1,
        `${label} frame ${f}: rigOuter updates 1:1 with OpenXR frame`
      );
      assert.equal(
        redRotCmds.length,
        1,
        `${label} frame ${f}: redNode yaw updates 1:1 with OpenXR frame`
      );
      assert.equal(
        redPosCmds.length,
        0,
        `${label} frame ${f}: idle red opponent does not translate`
      );
      assert.equal(
        calls.nativePropsLog.some(
          (entry) =>
            (entry.node === 'red.glb' || entry.node === 'rigOuter' || entry.node === 'redNode') &&
            (Array.isArray(entry.props.position) || Array.isArray(entry.props.rotation))
        ),
        false,
        `${label} frame ${f}: no Fabric setNativeProps transform churn`
      );
      const curYaw = sessionInstance.getLiveTransforms().red.yaw;
      const dYaw = wrap180(curYaw - prevRedYaw);
      assert.ok(
        Math.abs(dYaw) > 0 && Math.abs(dYaw) < 2,
        `${label} frame ${f}: smooth yaw step dYaw=${dYaw}`
      );
      totalDeltaYaw += dYaw;
      prevRedYaw = curYaw;
      monotonicYawUpdates += 1;
    }
    assert.equal(monotonicYawUpdates, 10);
    assert.ok(
      stickX < 0 ? totalDeltaYaw < -2 : totalDeltaYaw > 2,
      `${label} strafe turns red yaw monotonically (${totalDeltaYaw})`
    );
  }

  // While external ViroGameLoop driver is latched, stale rAF ticks do not double-step the session.
  const redBeforeRaf = { ...sessionInstance.getLiveTransforms().red };
  calls.transformCommands.length = 0;
  fc.stepFrame(16.6667);
  assert.equal(
    calls.transformCommands.length,
    0,
    'latched ViroGameLoop prevents rAF double-stepping'
  );
  assert.equal(sessionInstance.getLiveTransforms().red.yaw, redBeforeRaf.yaw);

  all = render();
  const fighterBlueAfter = all.find(
    (n) =>
      n.type === 'ViroNode' &&
      collectNodes(n.props.children).some(
        (c) => c.type === 'Viro3DObject' && c.props.source === 'blue.glb'
      ) &&
      n !== rigOuterNode
  );
  const redModelAfter = all.find((n) => n.type === 'Viro3DObject' && n.props.source === 'red.glb');
  assert.deepEqual(
    [...fighterBlueAfter.props.position],
    blueInitialPos,
    'JSX position stays frozen to prevent React/native transform fighting'
  );
  assert.notEqual(redModelAfter.props.visible, false, 'red opponent stays visible');
  assert.equal(sessionInstance.getSnapshot().fighters.red.clip, 'IdleAggro');
  assert.equal(sessionInstance.getSnapshot().animationsRunning, true);

  // VRActivity resume builds the current Pause card and leaves both old owners hidden.
  assert.equal(replayCounts.menu, 0);
  assert.equal(replayCounts.title, 0);
  runtimeSnap = { ...runtimeSnap, appActive: false, vrActivityState: 'paused' };
  for (const l of runtimeListeners) l();
  assert.equal(replayCounts.menu, 0);
  assert.equal(sessionInstance.getSnapshot().animationsRunning, false);
  // While paused, OpenXR onUpdate ticks must not advance transforms.
  calls.transformCommands.length = 0;
  gameLoop.props.onUpdate({ dt: 1 / 72, elapsed: 2 });
  assert.equal(calls.transformCommands.length, 0);

  runtimeSnap = { ...runtimeSnap, appActive: true, vrActivityState: 'paused' };
  for (const l of runtimeListeners) l();
  assert.equal(replayCounts.menu, 0, 'still paused until VRActivity resumes');
  runtimeSnap = { ...runtimeSnap, appActive: true, vrActivityState: 'resumed' };
  for (const l of runtimeListeners) l();
  assert.equal(replayCounts.menu, 0);
  assert.equal(replayCounts.title, 0);
  all = render();
  findHit('resume').props.onClickState(1, [0, 0, 0], 1);
  findHit('resume').props.onClickState(2, [0, 0, 0], 1);
  all = render();
  for (let i = 0; i < 40; i++) {
    fc.stepFrame(120);
    if (sessionInstance.getSnapshot().stage === 'fighting') break;
  }
  assert.equal(sessionInstance.getSnapshot().animationsRunning, true);
  assert.equal(sessionInstance.getSnapshot().fighters.red.clip, 'IdleAggro');
  calls.nativePropsLog.length = 0;
  for (const cb of calls.inputSampleHandlers) {
    cb(makeSample({ stick: [0, 0] }), 'live');
    cb(makeSample({ stick: [-1, 0] }), 'live');
  }
  // Post-resume frame advances smoothly even after large pause dt spike (clamped safely).
  calls.transformCommands.length = 0;
  all.find((n) => n.type === 'ViroGameLoop').props.onUpdate({ dt: 0.4, elapsed: 2.5 });
  assert.ok(
    calls.transformCommands.some((c) => c.tag === 'redNode' && c.cmd === 'setRotationEuler'),
    'resumed OpenXR frame smoothly updates red facing'
  );

  for (const entry of effects) entry?.cleanup?.();
});

test('Quest view-relative locomotion moves on horizontal plane along live head look across 0/90/180/270 yaw, differing calibrations, head turns while stick held, pitch/roll/degenerate gaze, and recenter', () => {
  const fc = makeFrameClock();
  let refEpoch = 1;
  const tracker = createQuestHeadTracker({
    now: fc.now,
    schedule: fc.clock.schedule,
    cancel: fc.clock.cancel,
    entries: () => 1,
    refSpaceEpoch: () => refEpoch,
  });
  const session = createQuestArenaSession(fc.clock, tracker, { cpuEnabled: false });

  // Feed initial stable head pose at differing calibration yaw (135 deg) before Solo.
  for (let i = 0; i < 10; i++) {
    tracker.onCameraTransform(makeHeadViroPose(135, 0, 0, [0.3, 1.5, -0.2]));
    fc.clock.now();
    fc.stepFrame(16.6667);
  }
  assert.equal(session.solo(), true);
  const open = session.getSnapshot();
  tracker.calibrateForSolo(open.transforms.blue);
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'arena');
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'blue');
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'red');
  assert.equal(session.ready().reason, 'started');
  for (let i = 0; i < 40; i++) {
    fc.stepFrame(120);
    tracker.onCameraTransform(makeHeadViroPose(135, 0, 0, [0.3, 1.5, -0.2]));
    if (session.getSnapshot().stage === 'fighting') break;
  }
  assert.equal(session.getSnapshot().stage, 'fighting');

  const initialCal = tracker.getLiveHeadState().calibration;
  near(initialCal.yaw, 135, 1e-6);

  const turnHeadSmoothly = (
    targetYawDeg,
    pitchDeg = 0,
    rollDeg = 0,
    origin = initialCal.origin
  ) => {
    const curSample = tracker.getLiveHeadState().sample;
    const startYaw = curSample
      ? (tracker.getLiveHeadState().lastValidYaw ?? initialCal.yaw)
      : initialCal.yaw;
    const delta = wrap180(targetYawDeg - startYaw);
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / 10)); // <= 600 deg/s (< 900 deg/s jump guard)
    for (let s = 1; s <= steps; s++) {
      const y = wrap180(startYaw + (delta * s) / steps);
      tracker.onCameraTransform(makeHeadViroPose(y, pitchDeg, rollDeg, origin));
      fc.stepFrame(16.6667);
    }
  };

  // Helper: compute player's effective displacement in OpenXR world S3 from rig position shift.
  // Because QuestRing positions the ring so the wearer sits at cal.origin, a ring shift dRigPos
  // means the player walked -dRigPos relative to the ring in OpenXR world space.
  const measureWorldMove = (cal, stick, headYawDeg, pitchDeg = 0, rollDeg = 0) => {
    session.setInputState({ ...makeSample({ stick: [0, 0] }), refEpoch }, 'live');
    turnHeadSmoothly(headYawDeg, pitchDeg, rollDeg, cal.origin);
    const beforeBlue = session.getLiveTransforms().blue;
    const rigBefore = questComposedRigTransform(cal, beforeBlue);
    session.setInputState({ ...makeSample({ stick }), refEpoch }, 'live');
    fc.stepFrame(50);
    const afterBlue = session.getLiveTransforms().blue;
    const rigAfter = questComposedRigTransform(cal, afterBlue);
    near(afterBlue.lift, 0, 1e-9, 'player stays on floor (no vertical flight)');
    near(
      afterBlue.yaw,
      beforeBlue.yaw,
      1e-9,
      'QuestRing anchor yaw stays stable (no forced world turn)'
    );
    near(rigAfter.rotationY, rigBefore.rotationY, 1e-9, 'rig rotationY stays constant');
    return {
      dx: (rigBefore.position[0] - rigAfter.position[0]) / QUEST_WORLD_SCALE,
      dy: (rigBefore.position[1] - rigAfter.position[1]) / QUEST_WORLD_SCALE,
      dz: (rigBefore.position[2] - rigAfter.position[2]) / QUEST_WORLD_SCALE,
      beforeBlue,
      afterBlue,
    };
  };

  // Unthrottled live head yaw avoids 200ms UI snapshot lag:
  // Snapshot raw.yaw is still 135 while live head turns smoothly over 100ms to 105 deg; locomotion uses 105 deg before 200ms publish!
  const snapBefore = tracker.getSnapshot();
  near(snapBefore.raw.yaw, 135, 1e-6);
  const immediateStep = measureWorldMove(initialCal, [0, 1], 105);
  assert.equal(tracker.getSnapshot(), snapBefore, 'UI snapshot stayed throttled (< 200ms)');
  const expectedFwd105 = worldForwardXZ(105);
  const stepDist = Math.hypot(immediateStep.dx, immediateStep.dz);
  near(stepDist, ARENA_RULES.speed * 0.05, 1e-4, 'full horizontal speed');
  near(immediateStep.dx / stepDist, expectedFwd105[0], 1e-5, 'unthrottled live head X');
  near(immediateStep.dz / stepDist, expectedFwd105[1], 1e-5, 'unthrottled live head Z');
  near(immediateStep.dy, 0, 1e-9);

  // Hold stick UP [0, 1] continuously while head turns smoothly across 0, 90, 180, 270 (-90) deg!
  session.setInputState({ ...makeSample({ stick: [0, 1] }), refEpoch }, 'live');
  for (const headYaw of [0, 90, 180, -90]) {
    turnHeadSmoothly(headYaw, -35, 20, initialCal.origin);
    const before = session.getLiveTransforms().blue;
    const rigBefore = questComposedRigTransform(initialCal, before);
    tracker.onCameraTransform(makeHeadViroPose(headYaw, -35, 20, initialCal.origin));
    fc.stepFrame(16.6667);
    const after = session.getLiveTransforms().blue;
    const rigAfter = questComposedRigTransform(initialCal, after);
    const wx = (rigBefore.position[0] - rigAfter.position[0]) / QUEST_WORLD_SCALE;
    const wz = (rigBefore.position[2] - rigAfter.position[2]) / QUEST_WORLD_SCALE;
    const len = Math.hypot(wx, wz);
    near(len, ARENA_RULES.speed * (16.6667 / 1000), 1e-4, `held stick yaw=${headYaw} speed`);
    const exp = worldForwardXZ(headYaw);
    near(wx / len, exp[0], 1e-5, `held stick yaw=${headYaw} worldX`);
    near(wz / len, exp[1], 1e-5, `held stick yaw=${headYaw} worldZ`);
  }

  // Test back/left/right at each cardinal head yaw (0, 90, 180, 270).
  for (const headYaw of [0, 90, 180, 270]) {
    for (const [stick, expFn, name] of [
      [[0, -1], (y) => worldForwardXZ(y).map((v) => -v), 'back'],
      [[-1, 0], worldLeftXZ, 'left'],
      [[1, 0], (y) => worldLeftXZ(y).map((v) => -v), 'right'],
    ]) {
      const step = measureWorldMove(initialCal, stick, headYaw, 25, -15);
      const len = Math.hypot(step.dx, step.dz);
      near(len, ARENA_RULES.speed * 0.05, 1e-4, `${name}@${headYaw} speed`);
      const exp = expFn(headYaw);
      near(step.dx / len, exp[0], 1e-5, `${name}@${headYaw} worldX`);
      near(step.dz / len, exp[1], 1e-5, `${name}@${headYaw} worldZ`);
    }
  }

  // Degenerate vertical gaze while moving keeps last valid yaw smoothly without jumping or flying.
  turnHeadSmoothly(90, 0, 0, initialCal.origin);
  session.setInputState({ ...makeSample({ stick: [0, 1] }), refEpoch }, 'live');
  fc.stepFrame(16.6667);
  const beforeDeg = session.getLiveTransforms().blue;
  const rigBeforeDeg = questComposedRigTransform(initialCal, beforeDeg);
  tracker.onCameraTransform({ position: initialCal.origin, forward: [0, 1, 0], up: [0, 0, -1] });
  fc.stepFrame(33.3333);
  const afterDeg = session.getLiveTransforms().blue;
  const rigAfterDeg = questComposedRigTransform(initialCal, afterDeg);
  const degWx = (rigBeforeDeg.position[0] - rigAfterDeg.position[0]) / QUEST_WORLD_SCALE;
  const degWz = (rigBeforeDeg.position[2] - rigAfterDeg.position[2]) / QUEST_WORLD_SCALE;
  const degLen = Math.hypot(degWx, degWz);
  near(degWx / degLen, 1, 1e-5, 'degenerate gaze holds last valid 90 deg yaw (+X)');
  near(degWz / degLen, 0, 1e-5);
  near(afterDeg.lift, 0, 1e-9);
  // Restore horizontal sample before recenter check.
  tracker.onCameraTransform(makeHeadViroPose(90, 0, 0, initialCal.origin));
  fc.stepFrame(16.6667);

  // Horizon system recenter neutralizes on transition with zero drift, then moves along new recentered look.
  refEpoch = 2;
  tracker.onCameraTransform(makeHeadViroPose(180, 0, 0, [0, 1.5, 0]));
  assert.equal(
    session.getLocomotion().active,
    false,
    'recenter immediately neutralizes locomotion'
  );
  const atRecenter = { ...session.getLiveTransforms().blue };
  fc.stepFrame(16.6667);
  near(session.getLiveTransforms().blue.x, atRecenter.x, 1e-9, 'zero X drift on recenter tick');
  near(session.getLiveTransforms().blue.z, atRecenter.z, 1e-9, 'zero Z drift on recenter tick');

  // After a settled post-recenter sample and matching input refEpoch, moving stick up moves along new head look (90 deg).
  const recenteredCal = tracker.getLiveHeadState().calibration;
  near(wrap180(recenteredCal.yaw - 180), 0, 1e-6);
  const postRecenter = measureWorldMove(recenteredCal, [0, 1], 90);
  const postLen = Math.hypot(postRecenter.dx, postRecenter.dz);
  near(postRecenter.dx / postLen, 1, 1e-5, 'post-recenter stick up follows live 90 deg look');
  near(postRecenter.dz / postLen, 0, 1e-5);

  // Sample-jump recenter (without refEpoch change) neutralizes during all unconfirmed pendingJump frames.
  session.setInputState({ ...makeSample({ stick: [0, 1] }), refEpoch }, 'live');
  tracker.onCameraTransform(makeHeadViroPose(0, 0, 0, [2.0, 1.5, 2.0]));
  assert.equal(tracker.getLiveHeadState().recentering, true);
  assert.equal(session.getLocomotion().active, false, 'pending jump neutralizes locomotion');
  const beforeJumpWait = { ...session.getLiveTransforms().blue };
  for (let i = 0; i < 4; i++) {
    fc.stepFrame(14);
    tracker.onCameraTransform(makeHeadViroPose(0, 0, 0, [2.0, 1.5, 2.0]));
  }
  near(
    session.getLiveTransforms().blue.x,
    beforeJumpWait.x,
    1e-9,
    'zero X drift while jump pending'
  );
  near(
    session.getLiveTransforms().blue.z,
    beforeJumpWait.z,
    1e-9,
    'zero Z drift while jump pending'
  );

  session.dispose();
  tracker.dispose();
});

test('Quest boundary fits inside Fight_Arena.glb ropes and Quest separation preserves eye clearance and punch reach', () => {
  // Verify Fight_Arena.glb minimum inner rope/post vertex radius under exact scene transforms.
  const b = fs.readFileSync(path.join(__dirname, '..', 'assets', 'arena', 'Fight_Arena.glb'));
  const jsonLen = b.readUInt32LE(12);
  const bin = b.subarray(20 + jsonLen + 8);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8'));
  const mul = (a, c) => {
    const out = new Array(16).fill(0);
    for (let r = 0; r < 4; r++)
      for (let col = 0; col < 4; col++)
        for (let k = 0; k < 4; k++) out[col * 4 + r] += a[k * 4 + r] * c[col * 4 + k];
    return out;
  };
  const trs = (n) => {
    const p = n.translation || [0, 0, 0];
    const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
    const s = n.scale || [1, 1, 1];
    return [
      (1 - 2 * (y * y + z * z)) * s[0],
      2 * (x * y + z * w) * s[0],
      2 * (x * z - y * w) * s[0],
      0,
      2 * (x * y - z * w) * s[1],
      (1 - 2 * (x * x + z * z)) * s[1],
      2 * (y * z + x * w) * s[1],
      0,
      2 * (x * z + y * w) * s[2],
      2 * (y * z - x * w) * s[2],
      (1 - 2 * (x * x + y * y)) * s[2],
      0,
      p[0],
      p[1],
      p[2],
      1,
    ];
  };
  const mWorld = mul(trs(json.nodes[1]), trs(json.nodes[0]));
  const pr = json.meshes[0].primitives[0];
  const acc = json.accessors[pr.attributes.POSITION];
  const bv = json.bufferViews[acc.bufferView];
  const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || 12;
  let ropeMinR = Infinity;
  for (let i = 0; i < acc.count; i++) {
    const vx = bin.readFloatLE(off + i * stride);
    const vy = bin.readFloatLE(off + i * stride + 4);
    const vz = bin.readFloatLE(off + i * stride + 8);
    const lx = mWorld[0] * vx + mWorld[4] * vy + mWorld[8] * vz + mWorld[12];
    const ly = mWorld[1] * vx + mWorld[5] * vy + mWorld[9] * vz + mWorld[13];
    const lz = mWorld[2] * vx + mWorld[6] * vy + mWorld[10] * vz + mWorld[14];
    const x = lx * ARENA_LAYOUT.arenaScale * ARENA_LAYOUT.arenaHorizontalScale;
    const y = ly * ARENA_LAYOUT.arenaScale + ARENA_LAYOUT.arenaBaseOffset;
    const z = lz * ARENA_LAYOUT.arenaScale * ARENA_LAYOUT.arenaHorizontalScale;
    const r = Math.hypot(x, z);
    if (y > ARENA_LAYOUT.floorHeight + 0.015 && r > 0.12) ropeMinR = Math.min(ropeMinR, r);
  }
  const eyeForward = ROBOT_EYE_MODEL[2] * ARENA_LAYOUT.fighterScale;
  assert.ok(ropeMinR > 0.22 && ropeMinR < 0.225, `ropeMinR=${ropeMinR}`);
  assert.ok(
    QUEST_ARENA_RULES.boundary + eyeForward < ropeMinR,
    'even turned 180 deg at Quest boundary, eye anchor stays inside visual ropes'
  );
  assert.ok(
    QUEST_ARENA_RULES.boundary > ARENA_RULES.boundary,
    'Quest boundary recovers edge space'
  );

  // Verify Quest separation keeps positive eye/body/foot clearance under max forward lean while allowing realistic standing fist reach.
  const collision = JSON.parse(source('assets/arena/combat-collision-data.json'));
  const extractMeta = JSON.parse(source('assets/arena/quest/quest-first-person-extract.json'));
  const boxFrontZ = (box) => {
    const [, , cz, hx, hy, hz, x, y, z, w] = box;
    const axZ = 2 * (x * z - y * w);
    const ayZ = 2 * (y * z + x * w);
    const azZ = 1 - 2 * (x * x + y * y);
    return cz + Math.abs(axZ) * hx + Math.abs(ayZ) * hy + Math.abs(azZ) * hz;
  };
  const idleFrames = collision.clips.IdleAggro.frames[0];
  const idleHead = idleFrames[collision.groups.indexOf('head_01')];
  const idleHeadFrontSim = boxFrontZ(idleHead);
  const idleHeadCenterSim = idleHead[2];
  const idleChestFrontSim = boxFrontZ(idleFrames[collision.groups.indexOf('spine_03')]);
  const idleFootFrontSim = boxFrontZ(idleFrames[collision.groups.indexOf('foot_l')]);
  const idleGloveFrontSim = boxFrontZ(idleFrames[collision.groups.indexOf('glove_l')]);
  const maxForwardLeanSim = QUEST_HEAD_BOUNDS.standing.forward / QUEST_WORLD_SCALE;
  const neutralEyeToHeadFrontM =
    (QUEST_ARENA_RULES.separation - eyeForward - idleHeadFrontSim) * QUEST_WORLD_SCALE;
  const minLeanClearanceM =
    (QUEST_ARENA_RULES.separation - eyeForward - idleHeadFrontSim - maxForwardLeanSim) *
    QUEST_WORLD_SCALE;
  assert.ok(neutralEyeToHeadFrontM >= 0.3, `neutralEyeToHeadFrontM=${neutralEyeToHeadFrontM}`);
  assert.ok(minLeanClearanceM >= 0.12, `minLeanClearanceM=${minLeanClearanceM}`);

  // Verify no body, glove, or foot overlap between shifted Quest blue body and opponent at minimum separation.
  const blueIdleBodyMaxZSim = extractMeta.body.bounds.max[2] * ARENA_LAYOUT.fighterScale;
  const chestClearanceM =
    (QUEST_ARENA_RULES.separation - blueIdleBodyMaxZSim - idleChestFrontSim) * QUEST_WORLD_SCALE;
  const gloveClearanceM =
    (QUEST_ARENA_RULES.separation - blueIdleBodyMaxZSim - idleGloveFrontSim) * QUEST_WORLD_SCALE;
  const toeClearanceM =
    (QUEST_ARENA_RULES.separation - blueIdleBodyMaxZSim - idleFootFrontSim) * QUEST_WORLD_SCALE;
  assert.ok(chestClearanceM > 0.3, `chestClearanceM=${chestClearanceM}`);
  assert.ok(gloveClearanceM > 0, `gloveClearanceM=${gloveClearanceM}`);
  assert.ok(toeClearanceM > 0.35, `toeClearanceM=${toeClearanceM}`);

  // Verify realistic standing left jab (controller grip 0.50 m ahead of calibrated eyes) reaches Red's face & Stage 06 targets.
  const gripReachSample = makeSample({ seq: 99, timestampNs: 1_000_000 });
  gripReachSample.t = 100;
  gripReachSample.capturedNs = 1_000_000;
  gripReachSample.left.grip = {
    tracking: 'tracked',
    position: [0.15, -0.25, -0.5],
    orientation: [0, 0, 0, 1],
  };
  gripReachSample.right.grip = {
    tracking: 'tracked',
    position: [-0.15, -0.25, -0.25],
    orientation: [0, 0, 0, 1],
  };
  const armsFrame = placeQuestFirstPersonArms({
    sample: gripReachSample,
    headRefEpoch: null,
    body: { calibration: DEFAULT_CALIBRATION, lift: 0 },
    poseSource: 'grip',
    nowNs: 1_000_000,
  });
  assert.equal(armsFrame.left.visible, true);
  assert.ok(
    armsFrame.left.upper && armsFrame.left.forearm,
    'extended jab keeps arm segments attached'
  );
  const palmToFistTipM =
    (-extractMeta.arms.left.fistBounds.min[2] - -QUEST_HAND_PALM_CENTER_MODEL.left[2]) *
    QUEST_FIRST_PERSON_ARM_SCALE;
  const extendedFistFrontM = 0.5 + palmToFistTipM;
  const eyeToRedHeadCenterM =
    (QUEST_ARENA_RULES.separation - eyeForward - idleHeadCenterSim) * QUEST_WORLD_SCALE;
  const eyeToRedChestFrontM =
    (QUEST_ARENA_RULES.separation - eyeForward - idleChestFrontSim) * QUEST_WORLD_SCALE;
  assert.ok(
    extendedFistFrontM > neutralEyeToHeadFrontM && extendedFistFrontM >= eyeToRedHeadCenterM,
    `extendedFistFrontM=${extendedFistFrontM} must reach face [${neutralEyeToHeadFrontM}, ${eyeToRedHeadCenterM}]`
  );
  assert.ok(
    extendedFistFrontM > eyeToRedChestFrontM,
    `extendedFistFrontM=${extendedFistFrontM} must reach Stage 06 chest target ${eyeToRedChestFrontM}`
  );

  // Verify Phone AR & shared combat defaults stay untouched and Quest AI/punch rules stay valid.
  assert.equal(ARENA_RULES.separation, 0.055);
  near(ARENA_RULES.boundary, 0.175, 1e-12, 'ARENA_RULES.boundary');
  assert.equal(ARENA_RULES.reach, 0.085);
  assert.equal(ARENA_RULES.cpuPreferredRange, 0.07);
  assert.equal(ARENA_RULES.cpuMinimumRange, 0.06);
  assert.equal(ARENA_RULES.stableFacing, false);
  assert.equal(ARENA_RULES.cpuEnabled, true);
  assert.equal(ARENA_RULES.dashEnabled, false);
  assert.ok(QUEST_ARENA_RULES.cpuMinimumRange > QUEST_ARENA_RULES.separation);
  assert.ok(QUEST_ARENA_RULES.cpuPreferredRange >= QUEST_ARENA_RULES.cpuMinimumRange);
  assert.ok(QUEST_ARENA_RULES.reach >= QUEST_ARENA_RULES.separation);
  const c = new ArenaController(
    {
      ...QUEST_ARENA_RULES,
      cpuEnabled: false,
      spawn: QUEST_ARENA_RULES.separation / 2,
      punchHitstop: 0,
      uppercutHitstop: 0,
      blockHitstop: 0,
    },
    () => 0
  );
  const tok = c.attachSession(1);
  c.setLandscape(true);
  c.setVirtualReady(tok, true);
  for (const a of ['arena', 'blue', 'red']) {
    c.assetLoaded(tok, c.getSnapshot().placementVersion, a);
  }
  assert.equal(c.ready(), true);
  for (let p = 0; p < 3; p++) {
    assert.equal(c.attack('punch'), true);
    for (let i = 0; i < 40; i++) c.tick(tok, 0.02);
  }
  assert.equal(c.getSnapshot().red.health, 100 - 3 * ARENA_RULES.punchDamage);
  assert.equal(c.getSnapshot().blue.uppercutReady, true);
  c.dispose();
});

test('QuestArenaSession external render-loop stepping stays smooth across left/right passes and pause/resume without rAF double-tick', () => {
  const fc = makeFrameClock();
  const tracker = createQuestHeadTracker({
    now: fc.now,
    schedule: fc.clock.schedule,
    cancel: fc.clock.cancel,
    entries: () => 1,
    refSpaceEpoch: () => 1,
  });
  const session = createQuestArenaSession(fc.clock, tracker, { cpuEnabled: false });
  for (let i = 0; i < 10; i++) {
    tracker.onCameraTransform(makeHeadViroPose(180, 0, 0, [0, 1.5, 0]));
    fc.clock.now();
    fc.stepFrame(16.6667);
  }
  assert.equal(session.solo(), true);
  const open = session.getSnapshot();
  tracker.calibrateForSolo(open.transforms.blue);
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'arena');
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'blue');
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'red');
  assert.equal(session.ready().reason, 'started');
  // Drive countdown to fighting via external 72Hz render loop ticks.
  for (let i = 0; i < 300; i++) {
    session.stepExternalFrame(1 / 72);
    if (session.getSnapshot().stage === 'fighting') break;
  }
  assert.equal(session.getSnapshot().stage, 'fighting');

  let frameNotifications = 0;
  const stopFrames = session.onFrame(() => {
    frameNotifications += 1;
  });

  // Left and right movement driven 1:1 at 72Hz.
  for (const stickX of [-1, 1]) {
    session.setInputState({ ...makeSample({ stick: [stickX, 0] }), refEpoch: 1 }, 'live');
    frameNotifications = 0;
    const redStart = { ...session.getLiveTransforms().red };
    for (let i = 0; i < 18; i++) {
      session.stepExternalFrame(1 / 72);
    }
    assert.equal(frameNotifications, 18);
    const redEnd = session.getLiveTransforms().red;
    near(redEnd.x, redStart.x, 1e-9, 'idle opponent does not translate horizontally');
    near(redEnd.z, redStart.z, 1e-9, 'idle opponent does not translate in depth');
    assert.ok(
      Math.abs(wrap180(redEnd.yaw - redStart.yaw)) > 1,
      'opponent smoothly tracks player yaw'
    );
  }

  // Pause clears rAF & stops ticks; resume restores fighting + IdleAggro and works via external loop or rAF fallback.
  session.setAppActive(false);
  frameNotifications = 0;
  session.stepExternalFrame(1 / 72);
  assert.equal(frameNotifications, 0);
  session.setAppActive(true);
  assert.equal(session.ready().reason, 'resumed');
  for (let i = 0; i < 40; i++) {
    fc.stepFrame(120);
    if (session.getSnapshot().stage === 'fighting') break;
  }
  assert.equal(session.getSnapshot().animationsRunning, true);
  assert.equal(session.getSnapshot().fighters.red.clip, 'IdleAggro');
  frameNotifications = 0;
  fc.stepFrame(16.6667);
  assert.equal(frameNotifications, 1, 'rAF fallback resumes cleanly until external frame arrives');
  session.stepExternalFrame(1 / 72);
  assert.equal(frameNotifications, 2, 'external OpenXR frame re-latches seamlessly after resume');

  stopFrames();
  session.dispose();
  tracker.dispose();
});

test('QuestRigSync path bypasses ViroGameLoop and ViroGameLoopUtils, tags rig/fighters, and publishes bounded velocities', () => {
  const ts = require('typescript');
  const jsx = (type, props, key) => ({
    type,
    props: props ?? {},
    key: key ?? props?.key ?? null,
  });
  const collectNodes = (root) => {
    const result = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(visit);
      result.push(node);
      visit(node.props?.children);
    };
    visit(root);
    return result;
  };
  const fc = makeFrameClock();
  const published = [];
  let cleared = 0;
  let runtimeSnap = { status: 'immersive', appActive: true, vrActivityState: 'resumed' };
  const runtimeListeners = new Set();
  const inputHandlers = new Set();
  const transformCommands = [];
  const nativePropsLog = [];

  const states = [];
  const effects = [];
  const refs = [];
  const memos = [];
  let si = 0;
  let ei = 0;
  let ri = 0;
  let mi = 0;
  let sessionInstance = null;

  const mocks = {
    react: {
      memo: (component) => component,
      useState: (init) => {
        const i = si++;
        if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
        return [states[i], (v) => (states[i] = typeof v === 'function' ? v(states[i]) : v)];
      },
      useEffect: (fn, deps) => {
        const i = ei++;
        const prev = effects[i];
        const changed =
          !prev || !deps || !prev.deps || deps.some((d, idx) => !Object.is(d, prev.deps[idx]));
        if (changed) {
          prev?.cleanup?.();
          effects[i] = { deps, cleanup: fn() };
        }
      },
      useMemo: (fn, deps) => {
        const i = mi++;
        const prev = memos[i];
        if (!prev || !deps || !prev.deps || deps.some((d, idx) => !Object.is(d, prev.deps[idx]))) {
          memos[i] = { deps, value: fn() };
        }
        return memos[i].value;
      },
      useRef: (init) => {
        const i = ri++;
        if (!(i in refs)) refs[i] = { current: init };
        return refs[i];
      },
      useSyncExternalStore: (_, get) => get(),
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'expo-asset': {
      Asset: {
        fromModule: (id) => ({
          uri: `file:///${id}`,
          localUri: `file:///${id}`,
          downloadAsync: async () => {},
        }),
      },
    },
    '@reactvision/react-viro': new Proxy(
      {
        ViroMaterials: { createMaterials: () => {} },
        ViroGameLoopUtils: {
          setPosition: (ref, position) => transformCommands.push({ cmd: 'setPosition', position }),
          setRotation: (ref, rotation) => transformCommands.push({ cmd: 'setRotation', rotation }),
        },
      },
      { get: (t, p) => (p in t ? t[p] : String(p)) }
    ),
    '../arena-fighter/arena-controller.ts': require('../src/features/arena-fighter/arena-controller.ts'),
    '../../../assets/arena/Fight_Arena.glb': 'arena.glb',
    '../../../assets/arena/Mike_Player1_Blue_Combat_AR.glb': 'blue.glb',
    '../../../assets/arena/Mike_Player2_RedOrange_Combat_AR.glb': 'red.glb',
    '../../../assets/arena/quest/quest-blue-body.glb': 'quest-body.glb',
    '../../../assets/arena/quest/quest-blue-upper-left.glb': 'quest-upper-left.glb',
    '../../../assets/arena/quest/quest-blue-upper-right.glb': 'quest-upper-right.glb',
    '../../../assets/arena/quest/quest-blue-forearm-left.glb': 'quest-forearm-left.glb',
    '../../../assets/arena/quest/quest-blue-forearm-right.glb': 'quest-forearm-right.glb',
    '../../../assets/arena/quest/quest-blue-hand-left.glb': 'quest-hand-left.glb',
    '../../../assets/arena/quest/quest-blue-hand-right.glb': 'quest-hand-right.glb',
    './quest-first-person-arms.ts': require('../src/features/quest-vr/quest-first-person-arms.ts'),
    '../../../assets/arena/ui/ArenaNotoSans.ttf': 'sans.ttf',
    '../../../assets/arena/ui/ArenaNotoSansSemibold.ttf': 'sans-semibold.ttf',
    '../../../assets/arena/ui/quest-lettering/neo.png': 'neo.png',
    '../../../assets/arena/ui/quest-lettering/rock.png': 'rock.png',
    '../../../assets/arena/ui/quest-lettering/robots.png': 'robots.png',
    '../../../modules/quest-panel/src/index.ts': {
      questPanelAvailable: () => false,
      questPanelNative: null,
    },
    '../../../modules/quest-input/src/index.ts': {
      questRigSyncAvailable: () => true,
      questInputNative: {
        rigSyncVersion: () => 1,
        publishRigState: (active, values) => {
          published.push({ active, values: [...values] });
          return true;
        },
        clearRigState: () => {
          cleared += 1;
          return true;
        },
      },
    },
    './quest-arena-session.ts': {
      createQuestArenaSession: () => {
        sessionInstance = createQuestArenaSession(fc.clock);
        return sessionInstance;
      },
    },
    './quest-head-tracker.ts': {
      questHeadTracker: {
        subscribe: () => () => {},
        getSnapshot: () => ({
          calibration: {
            origin: [0, 0, 0],
            yaw: 0,
            posture: 'standing',
            source: 'default',
            entry: 1,
          },
          live: false,
          source: 'camera',
          poseSource: 'none',
          sampleHz: 72,
          jitterM: 0,
          worldPosition: [0, 1.55, 0],
          outOfBounds: false,
        }),
        calibrateForSolo: () => {},
        cyclePosture: () => {},
        onCameraTransform: () => {},
        setRefSpaceEpochSource: () => {},
        dispose: () => {},
      },
    },
    './quest-combat-hud.ts': require('../src/features/quest-vr/quest-combat-hud.ts'),
    './quest-head-rig.ts': require('../src/features/quest-vr/quest-head-rig.ts'),
    './quest-menu-asset-uri.ts': require('../src/features/quest-vr/quest-menu-asset-uri.ts'),
    './quest-menu-compositor.ts': {
      ...require('../src/features/quest-vr/quest-menu-compositor.ts'),
      createQuestMenuCompositor: () => ({
        subscribe: () => () => {},
        getSnapshot: () => ({ mode: 'shown', reason: null }),
        present: () => {},
        hide: () => {},
        replay: () => {},
        dispose: () => {},
      }),
    },
    './quest-menu-input.ts': require('../src/features/quest-vr/quest-menu-input.ts'),
    './quest-menu-layer.ts': require('../src/features/quest-vr/quest-menu-layer.ts'),
    './quest-menu-layout.ts': require('../src/features/quest-vr/quest-menu-layout.ts'),
    './quest-arena-audio.native.ts': { useQuestArenaAudio: () => {} },
    './quest-tuning.ts': require('../src/features/quest-vr/quest-tuning.ts'),
    './quest-diagnostics-layout.ts': { questDiagLayerMaterials: () => ({}) },
    './quest-runtime-store.ts': {
      questRuntime: {
        subscribe: (l) => {
          runtimeListeners.add(l);
          return () => runtimeListeners.delete(l);
        },
        getSnapshot: () => runtimeSnap,
        sceneMounted: () => {},
        sceneUnmounted: () => {},
        exitRequested: () => {},
      },
    },
    './quest-input-visualizer.native.tsx': {
      createSceneQuestInputSource: () => ({
        start: () => {},
        stop: () => {},
        subscribe: () => () => {},
        getSnapshot: () => null,
        onSample: (cb) => {
          inputHandlers.add(cb);
          return () => inputHandlers.delete(cb);
        },
      }),
      QuestDiagnosticsPanel: 'QuestDiagnosticsPanel',
      QuestInputMarkers: 'QuestInputMarkers',
    },
  };

  const output = ts.transpileModule(source('src/features/quest-vr/quest-arena-scene.native.tsx'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  const mod = { exports: {} };
  vm.runInNewContext(output, {
    module: mod,
    exports: mod.exports,
    console,
    Date,
    setTimeout,
    clearTimeout,
    require: (name) => mocks[name],
  });

  const Scene = mod.exports.default;
  const render = () => {
    si = 0;
    ei = 0;
    ri = 0;
    mi = 0;
    const tree = Scene();
    const all = collectNodes(tree);
    for (const n of all) {
      if (typeof n.type === 'function') all.push(...collectNodes(n.type(n.props)));
    }
    return all;
  };

  let all = render();
  assert.equal(
    all.some((n) => n.type === 'ViroGameLoop'),
    false,
    'rigSync bypasses ViroGameLoop'
  );
  assert.ok(cleared >= 1, 'menu page clears native rig state');
  const findHit = (action) => all.find((n) => n.type === 'ViroQuad' && n.key === `hit-${action}`);

  findHit('solo').props.onClickState(1, [0, 0, 0], 1);
  findHit('solo').props.onClickState(2, [0, 0, 0], 1);
  all = render();
  for (const tag of ['quest-rig-outer', 'quest-stance-ring', 'quest-red-node', 'quest-blue-node']) {
    assert.ok(
      all.some((n) => n.type === 'ViroNode' && n.props?.viroTag === tag),
      `ViroNode mounts viroTag=${tag}`
    );
  }
  for (const m of all.filter((n) => n.type === 'Viro3DObject')) {
    if (m.props?.ref) m.props.ref.current = { setNativeProps: (p) => nativePropsLog.push(p) };
    if (typeof m.props.onLoadEnd === 'function') m.props.onLoadEnd();
  }
  findHit('ready').props.onClickState(1, [0, 0, 0], 1);
  findHit('ready').props.onClickState(2, [0, 0, 0], 1);
  all = render();
  for (let i = 0; i < 40; i++) {
    fc.stepFrame(120);
    if (sessionInstance.getSnapshot().stage === 'fighting') break;
  }

  for (const cb of inputHandlers) cb(makeSample({ stick: [1, 0] }), 'live');
  published.length = 0;
  transformCommands.length = 0;
  for (let f = 0; f < 5; f++) {
    fc.stepFrame(1000 / 72);
  }
  assert.equal(transformCommands.length, 0, 'rigSync does not enqueue ViroGameLoopUtils commands');
  assert.equal(published.length, 5);
  const last = published.at(-1);
  assert.equal(last.active, true);
  assert.equal(last.values.length, 32);
  // rigOuter (indices 3..5) and red yawRate (index 23) reflect non-zero continuous strafe velocity.
  assert.ok(Math.hypot(last.values[3], last.values[5]) > 0.05, 'rig velocity published');
  assert.ok(Math.abs(last.values[23]) > 1, 'red opponent yawRate published');

  // Pausing runtime zeroes velocities immediately on native rig sync.
  published.length = 0;
  runtimeSnap = { ...runtimeSnap, appActive: false, vrActivityState: 'paused' };
  for (const l of runtimeListeners) l();
  assert.ok(published.length >= 1);
  const paused = published.at(-1);
  assert.equal(paused.values[3], 0);
  assert.equal(paused.values[5], 0);
  assert.equal(paused.values[23], 0);

  for (const entry of effects) entry?.cleanup?.();
  assert.ok(cleared >= 2, 'scene unmount clears native rig state');
});

test('evaluateQuestDashInput enforces rising-edge A capture, right/left button identity, deadzone, non-buffering, and focus/recenter gates', () => {
  const head = {
    sample: makeHeadSample(1000, 90),
    calibration: { yaw: 180 },
    nowMs: 1010,
    refEpoch: 1,
  };
  const base = {
    status: 'live',
    inActiveFight: true,
    menuFocused: false,
    appActive: true,
    recenterNeutral: false,
    head,
  };

  // Startup with A held must NOT trigger.
  let state = { armed: false };
  let ev = evaluateQuestDashInput(state, {
    ...base,
    sample: makeSample({ seq: 1, stick: [0, 1], rightPrimary: true, refEpoch: 1 }),
  });
  assert.equal(ev.triggered, false);
  assert.equal(ev.nextState.armed, false);
  state = ev.nextState;

  // Holding A across more frames still never triggers.
  ev = evaluateQuestDashInput(state, {
    ...base,
    sample: makeSample({ seq: 2, stick: [0, 1], rightPrimary: true, refEpoch: 1 }),
  });
  assert.equal(ev.triggered, false);
  state = ev.nextState;

  // Release A -> arms detector.
  ev = evaluateQuestDashInput(state, {
    ...base,
    sample: makeSample({ seq: 3, stick: [0, 0], rightPrimary: false, refEpoch: 1 }),
  });
  assert.equal(ev.triggered, false);
  assert.equal(ev.nextState.armed, true);
  state = ev.nextState;

  // Press A on neutral / deadzone stick -> does nothing AND consumes arming (no buffering).
  for (const deadStick of [
    [0, 0],
    [0.14, 0],
    [0.1, 0.1],
  ]) {
    ev = evaluateQuestDashInput(
      { armed: true },
      { ...base, sample: makeSample({ seq: 4, stick: deadStick, rightPrimary: true, refEpoch: 1 }) }
    );
    assert.equal(ev.triggered, false);
    assert.equal(ev.nextState.armed, false);
  }

  // Keeping A held while later pushing stick outside deadzone must NOT trigger buffered dash.
  ev = evaluateQuestDashInput(
    { armed: false },
    { ...base, sample: makeSample({ seq: 5, stick: [0, 1], rightPrimary: true, refEpoch: 1 }) }
  );
  assert.equal(ev.triggered, false);

  // Left-hand X (`leftPrimary`), B (`rightSecondary`), trigger, squeeze, menu never trigger dash.
  ev = evaluateQuestDashInput(
    { armed: true },
    {
      ...base,
      sample: makeSample({
        seq: 6,
        stick: [0, 1],
        rightPrimary: false,
        leftPrimary: true,
        rightSecondary: true,
        rightTrigger: 1,
        rightSqueeze: 1,
        leftMenu: true,
        refEpoch: 1,
      }),
    }
  );
  assert.equal(ev.triggered, false);
  assert.equal(ev.nextState.armed, true);

  // Inactive right primary action (`null`) neutralizes and disarms; re-arming with held A fails.
  ev = evaluateQuestDashInput(
    { armed: true },
    { ...base, sample: makeSample({ seq: 7, stick: [0, 1], rightPrimary: null, refEpoch: 1 }) }
  );
  assert.equal(ev.triggered, false);
  assert.equal(ev.neutralized, true);
  assert.equal(ev.nextState.armed, false);

  // Reconnect / focus recovery / menu unfocus / unpause / recenter recovery with A held never fires.
  for (const blocked of [
    { ...base, status: 'waiting', sample: null },
    { ...base, status: 'stale', sample: makeSample({ stick: [0, 1], rightPrimary: false }) },
    { ...base, status: 'unfocused', sample: makeSample({ stick: [0, 1], focused: false }) },
    { ...base, sample: makeSample({ stick: [0, 1], actionsReady: false, rightPrimary: false }) },
    { ...base, sample: makeSample({ stick: [0, 1], leftTracking: 'lost', rightPrimary: false }) },
    { ...base, sample: makeSample({ stick: [0, 1], rightTracking: 'lost', rightPrimary: false }) },
    { ...base, menuFocused: true, sample: makeSample({ stick: [0, 1], rightPrimary: false }) },
    { ...base, appActive: false, sample: makeSample({ stick: [0, 1], rightPrimary: false }) },
    { ...base, recenterNeutral: true, sample: makeSample({ stick: [0, 1], rightPrimary: false }) },
    { ...base, inActiveFight: false, sample: makeSample({ stick: [0, 1], rightPrimary: false }) },
    {
      ...base,
      sample: makeSample({ stick: [0, 1], rightPrimary: false, refEpoch: 2 }),
    },
  ]) {
    const blockedEv = evaluateQuestDashInput({ armed: true }, blocked);
    assert.equal(blockedEv.triggered, false);
    assert.equal(blockedEv.neutralized, true);
    assert.equal(blockedEv.nextState.armed, false);

    // Next live frame with A already held down must NOT fire.
    const recoverEv = evaluateQuestDashInput(blockedEv.nextState, {
      ...base,
      sample: makeSample({ stick: [0, 1], rightPrimary: true, refEpoch: 1 }),
    });
    assert.equal(recoverEv.triggered, false);
    assert.equal(recoverEv.nextState.armed, false);
  }

  // Right inferred tracking (controller occluded behind back) still allows fresh A press when armed.
  ev = evaluateQuestDashInput(
    { armed: true },
    {
      ...base,
      sample: makeSample({
        seq: 8,
        stick: [0, 0.4], // half tilt outside 0.15 deadzone
        rightTracking: 'inferred',
        rightPrimary: true,
        refEpoch: 1,
      }),
    }
  );
  assert.equal(ev.triggered, true);
  assert.equal(ev.nextState.armed, false);
  near(Math.hypot(ev.direction.advance, ev.direction.strafe), 1, 1e-6);

  // Verify OpenXR binding in patch 0003 & quest-input decoder (`a/click` -> `right.buttons.primary`).
  const patch0003 = source('tools/quest/viro-renderer/0003-openxr-quest-input-sampler.patch');
  assert.match(patch0003, /readBool\(_aButtonAction,\s*right\.primaryActive,\s*right\.primary\)/);
});

test('QuestArenaSession executes Quest A-button directional dash across cardinals/diagonals, latches live head yaw, preserves bounds/separation, neutralizes safely, and leaves phone/CPU/guardStamina unaffected', () => {
  const fc = makeFrameClock();
  let refEpoch = 1;
  const tracker = createQuestHeadTracker({
    now: fc.now,
    schedule: fc.clock.schedule,
    cancel: fc.clock.cancel,
    entries: () => 1,
    refSpaceEpoch: () => refEpoch,
  });
  const session = createQuestArenaSession(fc.clock, tracker, { cpuEnabled: false });

  // Calibrate looking along 180 deg (+Z? wait: yawFromForward([0,0,-1])=180; worldForwardXZ(180)=[0,-1]).
  for (let i = 0; i < 10; i++) {
    tracker.onCameraTransform(makeHeadViroPose(180, 0, 0, [0, 1.5, 0]));
    fc.stepFrame(16.6667);
  }
  assert.equal(session.solo(), true);
  const open = session.getSnapshot();
  tracker.calibrateForSolo(open.transforms.blue);
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'arena');
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'blue');
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'red');
  assert.equal(session.ready().reason, 'started');

  // Holding A during countdown must NOT trigger when fighting starts.
  session.setInputState(
    makeSample({ seq: 1, stick: [0, 1], rightPrimary: true, refEpoch }),
    'live'
  );
  for (let i = 0; i < 40; i++) {
    fc.stepFrame(120);
    tracker.onCameraTransform(makeHeadViroPose(180, 0, 0, [0, 1.5, 0]));
    if (session.getSnapshot().stage === 'fighting') break;
  }
  assert.equal(session.getSnapshot().stage, 'fighting');
  session.setInputState(
    makeSample({ seq: 2, stick: [0, 1], rightPrimary: true, refEpoch }),
    'live'
  );
  assert.equal(session.isDashing(), false);

  const runDash = (stick, headYaw, turnDuringDashToYaw = null) => {
    // Move smoothly to target headYaw and release A.
    const curYaw = tracker.getLiveHeadState().lastValidYaw ?? 180;
    const delta = wrap180(headYaw - curYaw);
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / 10));
    for (let s = 1; s <= steps; s++) {
      tracker.onCameraTransform(
        makeHeadViroPose(wrap180(curYaw + (delta * s) / steps), 0, 0, [0, 1.5, 0])
      );
      fc.stepFrame(16.6667);
    }
    session.setInputState(
      makeSample({ seq: 100, stick: [0, 0], rightPrimary: false, refEpoch }),
      'live'
    );
    const start = { ...session.getLiveTransforms().blue };
    const startCal = tracker.getLiveHeadState().calibration;
    const startRig = questComposedRigTransform(startCal, start);

    // Rising edge of A with desired stick intent.
    session.setInputState(makeSample({ seq: 101, stick, rightPrimary: true, refEpoch }), 'live');
    assert.equal(session.isDashing(), true);

    // Holding A and releasing/changing stick or turning head mid-dash must NOT alter direction or trigger twice.
    for (let f = 0; f < 16; f++) {
      if (turnDuringDashToYaw !== null && f < 6) {
        const midYaw = wrap180(headYaw + (wrap180(turnDuringDashToYaw - headYaw) * (f + 1)) / 6);
        tracker.onCameraTransform(makeHeadViroPose(midYaw, 25, -15, [0, 1.5, 0]));
      }
      session.setInputState(
        makeSample({
          seq: 102 + f,
          stick: f > 2 ? [0, 0] : [-stick[0], -stick[1]],
          rightPrimary: true,
          refEpoch,
        }),
        'live'
      );
      fc.stepFrame(16.6667);
    }
    const end = { ...session.getLiveTransforms().blue };
    const endRig = questComposedRigTransform(startCal, end);
    assert.equal(session.isDashing(), false);
    assert.equal(session.getSnapshot().fighters.blue.clip, 'IdleAggro');

    // No motion after release of A / dash completion.
    session.setInputState(
      makeSample({ seq: 200, stick: [0, 0], rightPrimary: false, refEpoch }),
      'live'
    );
    for (let f = 0; f < 10; f++) fc.stepFrame(16.6667);
    const settled = session.getLiveTransforms().blue;
    near(settled.x, end.x, 1e-6, 'zero drift after dash completion and A release');
    near(settled.z, end.z, 1e-6, 'zero drift after dash completion and A release');

    //Wait out dashRecovery before next dash.
    for (let f = 0; f < 20; f++) fc.stepFrame(16.6667);

    return {
      start,
      end,
      wx: (startRig.position[0] - endRig.position[0]) / QUEST_WORLD_SCALE,
      wz: (startRig.position[2] - endRig.position[2]) / QUEST_WORLD_SCALE,
    };
  };

  // All 4 cardinal directions + 4 diagonals follow live head yaw (90 deg) and normalize distance.
  // Use backward/left/right/diagonals near center so neither opponent nor wall blocks full 0.06 dash.
  const cardinalChecks = [
    { stick: [0, -1], exp: worldForwardXZ(90).map((v) => -v), label: 'back@90' },
    { stick: [0, 1], exp: worldForwardXZ(90), label: 'fwd@90' },
    { stick: [-1, 0], exp: worldLeftXZ(90), label: 'left@90' },
    { stick: [1, 0], exp: worldLeftXZ(90).map((v) => -v), label: 'right@90' },
  ];
  for (const c of cardinalChecks) {
    const res = runDash(c.stick, 90, 180); // Turn head 90 deg mid-dash: direction must stay latched at 90!
    const dist = Math.hypot(res.wx, res.wz);
    near(dist, QUEST_ARENA_RULES.dashTravel, 1e-3, `${c.label} distance`);
    near(res.wx / dist, c.exp[0], 1e-4, `${c.label} latched X`);
    near(res.wz / dist, c.exp[1], 1e-4, `${c.label} latched Z`);
    near(res.end.lift, 0, 1e-9, `${c.label} zero vertical lift`);
    near(res.end.yaw, res.start.yaw, 1e-9, `${c.label} zero forced yaw rotation`);
    assert.notEqual(session.getSnapshot().fighters.blue.clip, 'JumpBack');
  }

  // All 4 diagonals at 180 deg head yaw: same normalized total travel (no sqrt(2) boost).
  for (const diagStick of [
    [-1, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
  ]) {
    const diag = runDash(diagStick, 180);
    near(Math.hypot(diag.wx, diag.wz), QUEST_ARENA_RULES.dashTravel, 1e-3, `diag ${diagStick}`);
  }

  // Safety interruptions mid-dash cancel dash immediately with zero stuck dash or post-resume motion.
  const interruptCases = [
    'menuFocus',
    'pause',
    'leftTrackingLost',
    'rightTrackingLost',
    'unfocused',
    'recenter',
  ];
  for (let idx = 0; idx < interruptCases.length; idx++) {
    const interruptCase = interruptCases[idx];
    const dashStick = idx % 2 === 0 ? [0, -1] : [0, 1];
    session.setInputState(
      makeSample({ seq: 300, stick: [0, 0], rightPrimary: false, refEpoch }),
      'live'
    );
    session.setInputState(
      makeSample({ seq: 301, stick: dashStick, rightPrimary: true, refEpoch }),
      'live'
    );
    assert.equal(session.isDashing(), true, `${interruptCase}: dash started`);
    fc.stepFrame(16.6667);

    if (interruptCase === 'menuFocus') {
      session.setMenuFocus(true);
    } else if (interruptCase === 'pause') {
      session.setAppActive(false);
    } else if (interruptCase === 'leftTrackingLost') {
      session.setInputState(
        makeSample({
          seq: 302,
          stick: dashStick,
          rightPrimary: true,
          leftTracking: 'lost',
          refEpoch,
        }),
        'live'
      );
    } else if (interruptCase === 'rightTrackingLost') {
      session.setInputState(
        makeSample({
          seq: 302,
          stick: [0, 0],
          rightPrimary: true,
          rightTracking: 'lost',
          refEpoch,
        }),
        'live'
      );
    } else if (interruptCase === 'unfocused') {
      session.setInputState(
        makeSample({ seq: 302, stick: dashStick, rightPrimary: null, focused: false, refEpoch }),
        'unfocused'
      );
    } else if (interruptCase === 'recenter') {
      refEpoch += 1;
      tracker.onCameraTransform(makeHeadViroPose(180, 0, 0, [0, 1.5, 0]));
    }

    assert.equal(session.isDashing(), false, `${interruptCase}: dash neutralized immediately`);
    const frozen = { ...session.getLiveTransforms().blue };
    for (let f = 0; f < 10; f++) fc.stepFrame(16.6667);
    near(session.getLiveTransforms().blue.x, frozen.x, 1e-6, `${interruptCase}: no stuck dash X`);
    near(session.getLiveTransforms().blue.z, frozen.z, 1e-6, `${interruptCase}: no stuck dash Z`);

    // Recover cleanly with A still held: must NOT fire a stuck or buffered dash.
    if (interruptCase === 'menuFocus') session.setMenuFocus(false);
    if (interruptCase === 'pause') {
      session.setAppActive(true);
      assert.equal(session.ready().reason, 'resumed');
    }
    session.setInputState(
      makeSample({ seq: 305, stick: dashStick, rightPrimary: true, refEpoch }),
      'live'
    );
    assert.equal(session.isDashing(), false, `${interruptCase}: no dash on recovery with A held`);
    for (let f = 0; f < 30; f++) fc.stepFrame(16.6667);
  }

  // Stationary Stage 05 opponent remained idle throughout all dashes.
  const redEnd = session.getLiveTransforms().red;
  near(redEnd.x, open.transforms.red.x, 1e-6, 'red opponent stayed stationary');
  near(redEnd.z, open.transforms.red.z, 1e-6, 'red opponent stayed stationary');
  assert.equal(session.getSnapshot().fighters.red.clip, 'IdleAggro');

  session.dispose();
  tracker.dispose();
});

test('createQuestInputSource delivers multi-sample live batches to onSample without dropping fast A taps', () => {
  let timeMs = 1000;
  const timers = new Map();
  let nextId = 1;
  const reader = {
    read: () => ({
      available: true,
      version: 1,
      generation: 1,
      live: true,
      actionsReady: true,
      nowNs: 100_000_000,
      oldestSeq: 1,
      latestSeq: 3,
      published: 3,
      framesWithoutInput: 0,
      rejected: 0,
      count: 3,
      seq: [1, 2, 3],
      displayTimeNs: [10_000_000, 24_000_000, 38_000_000],
      capturedNs: [10_000_000, 24_000_000, 38_000_000],
      ints: [
        // sample 1: A released
        0, 5, 1, 1, 1, 0, 15, 3, 127, 0, 0, 15, 3, 127, 0,
        // sample 2: A pressed (1-frame tap)
        0, 5, 1, 1, 1, 0, 15, 3, 127, 0, 0, 15, 3, 127, 1,
        // sample 3: A released again
        0, 5, 1, 1, 1, 0, 15, 3, 127, 0, 0, 15, 3, 127, 0,
      ],
      floats: [
        ...new Array(13).fill(0),
        0,
        0,
        0,
        1,
        ...new Array(13).fill(0),
        0,
        0,
        0,
        0,
        ...new Array(13).fill(0),
        0,
        0,
        0,
        1,
        ...new Array(13).fill(0),
        0,
        0,
        0,
        0,
        ...new Array(13).fill(0),
        0,
        0,
        0,
        1,
        ...new Array(13).fill(0),
        0,
        0,
        0,
        0,
      ],
    }),
  };
  for (let i = 0; i < 3; i++) {
    // Valid identity quaternions in floats (index 3..6 = 0,0,0,1 per hand).
    const base = i * 34;
    reader.read = () => ({
      available: true,
      version: 1,
      generation: 1,
      live: true,
      actionsReady: true,
      nowNs: 40_000_000,
      oldestSeq: 1,
      latestSeq: 3,
      published: 3,
      framesWithoutInput: 0,
      rejected: 0,
      count: 3,
      seq: [1, 2, 3],
      displayTimeNs: [10_000_000, 24_000_000, 38_000_000],
      capturedNs: [10_000_000, 24_000_000, 38_000_000],
      ints: [
        0, 5, 1, 1, 1, 0, 15, 3, 127, 0, 0, 15, 3, 127, 0, 0, 5, 1, 1, 1, 0, 15, 3, 127, 0, 0, 15,
        3, 127, 1, 0, 5, 1, 1, 1, 0, 15, 3, 127, 0, 0, 15, 3, 127, 0,
      ],
      floats: Array.from({ length: 3 }, () => {
        const l = new Array(17).fill(0);
        l[6] = 1;
        l[16] = 1; // left stick +Y
        const r = new Array(17).fill(0);
        r[6] = 1;
        return [...l, ...r];
      }).flat(),
    });
  }
  const source = createQuestInputSource({
    reader,
    now: () => timeMs,
    schedule: (cb, ms) => {
      const id = nextId++;
      timers.set(id, { cb, ms });
      return id;
    },
    cancel: (id) => timers.delete(id),
  });
  let sawBatch = null;
  source.onSample((latest, status, acceptedSamples) => {
    if (acceptedSamples) sawBatch = { latest, status, acceptedSamples };
  });
  source.start();
  source.stop();

  assert.ok(sawBatch);
  assert.equal(sawBatch.status, 'live');
  assert.equal(sawBatch.latest.seq, 3);
  assert.deepEqual(
    sawBatch.acceptedSamples.map((s) => s.right.buttons.primary),
    [false, true, false]
  );
});
