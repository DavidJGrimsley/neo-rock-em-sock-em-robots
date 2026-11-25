const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const {
  QUEST_FIRST_PERSON_BODY_CLIPS,
  QUEST_BODY_CLIP_SWITCH_DWELL_S,
  QUEST_BODY_DIRECTION_HYSTERESIS_DEG,
  QUEST_BODY_MOVE_START_SPEED,
  QUEST_BODY_MOVE_STOP_SPEED,
  QUEST_BODY_STOP_DWELL_S,
  createQuestFirstPersonBodyTrackerState,
  stepQuestFirstPersonBodyClip,
} = require('../src/features/quest-vr/quest-first-person-body.ts');
const { createQuestArenaSession } = require('../src/features/quest-vr/quest-arena-session.ts');
const {
  placeQuestFirstPersonArms,
  QUEST_FIRST_PERSON_ARM_SCALE,
} = require('../src/features/quest-vr/quest-first-person-arms.ts');
const {
  DEFAULT_CALIBRATION,
  QUEST_WORLD_SCALE,
  ROBOT_EYE_MODEL,
} = require('../src/features/quest-vr/quest-head-rig.ts');
const { ARENA_LAYOUT } = require('../src/features/arena-fighter/arena-controller.ts');
const {
  QUEST_MENU_SIZE,
  QUEST_TITLE_SIZE,
  QUEST_TITLE_TEXTURE,
  buildQuestMenu,
  buildQuestMenuTitle,
  questMenuButtonFrame,
  questMenuButtons,
  questMenuCardMetrics,
  QUEST_MENU_ALERT_SHIFT_M,
  QUEST_MENU_CARD_RADIUS_PX,
  QUEST_MENU_POSE,
  QUEST_TITLE_POSE,
} = require('../src/features/quest-vr/quest-menu-layout.ts');
const {
  QUEST_DIAG_POSE,
  QUEST_DIAG_SIZE,
} = require('../src/features/quest-vr/quest-diagnostics-layout.ts');
const { questMenuLayer } = require('../src/features/quest-vr/quest-menu-layer.ts');
const compositorModule = require('../src/features/quest-vr/quest-menu-compositor.ts');
const {
  questPointerHover,
  questTriggerPress,
} = require('../src/features/quest-vr/quest-menu-input.ts');
const {
  questIntroRig,
  questComposedRigTransform,
  stanceMarkerRingLocal,
} = require('../src/features/quest-vr/quest-head-rig.ts');

const repoRoot = path.resolve(__dirname, '..');

function sha256File(relPath) {
  const bytes = fs.readFileSync(path.join(repoRoot, relPath));
  return {
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

function makeHarnessClock() {
  let nextId = 1;
  const timers = new Map();
  let now = 1000;
  return {
    now: () => now,
    advanceBy(ms) {
      now += ms;
    },
    clock: {
      schedule(fn) {
        const id = nextId++;
        timers.set(id, fn);
        return id;
      },
      cancel(id) {
        timers.delete(id);
      },
      now: () => now,
      scheduleFrame(fn) {
        const id = nextId++;
        timers.set(id, fn);
        return id;
      },
      cancelFrame(id) {
        timers.delete(id);
      },
    },
    pendingCount() {
      return timers.size;
    },
    clearAll() {
      timers.clear();
    },
  };
}

function forwardForYaw(yawDeg) {
  const rad = (yawDeg * Math.PI) / 180;
  return [Math.sin(rad), 0, Math.cos(rad)];
}

function makeSample(overrides = {}) {
  const stick = overrides.stick ?? [0, 0];
  return {
    seq: overrides.seq ?? 1,
    t: overrides.t ?? 100,
    capturedNs: overrides.capturedNs ?? 1_000_000,
    focused: overrides.focused ?? true,
    actionsReady: overrides.actionsReady ?? true,
    refEpoch: overrides.refEpoch ?? 1,
    left: {
      hand: 'left',
      tracking: overrides.leftTracking ?? 'tracked',
      position: [-0.2, 1.05, -0.35],
      orientation: [0, 0, 0, 1],
      grip: {
        tracking: overrides.leftTracking ?? 'tracked',
        position: [-0.2, 1.05, -0.35],
        orientation: [0, 0, 0, 1],
      },
      thumbstick: { x: stick[0], y: stick[1], active: Math.hypot(stick[0], stick[1]) > 0.1 },
      buttons: { x: false, y: false, menu: false, trigger: 0, grip: 0 },
    },
    right: {
      hand: 'right',
      tracking: overrides.rightTracking ?? 'tracked',
      position: [0.2, 1.05, -0.35],
      orientation: [0, 0, 0, 1],
      grip: {
        tracking: overrides.rightTracking ?? 'tracked',
        position: [0.2, 1.05, -0.35],
        orientation: [0, 0, 0, 1],
      },
      thumbstick: { x: 0, y: 0, active: false },
      buttons: { a: false, b: false, trigger: 0, grip: 0 },
    },
  };
}

function makeQuestHeadSource(initialYawDeg = 0) {
  let headState = {
    status: 'tracking',
    sample: {
      t: 100,
      position: [0, 1.35, 0],
      forward: forwardForYaw(initialYawDeg),
    },
    lastValidYaw: initialYawDeg,
    recentering: false,
    calibration: { ...DEFAULT_CALIBRATION, yaw: 0 },
    refEpoch: 1,
    referenceResets: 0,
  };
  let headListener = null;

  return {
    headSource: {
      getSnapshot: () => ({ calibration: headState.calibration }),
      getLiveHeadState: () => headState,
      subscribeLive(cb) {
        headListener = cb;
        return () => {
          if (headListener === cb) headListener = null;
        };
      },
      calibrateForSolo(blue) {
        headState = {
          ...headState,
          calibration: {
            ...DEFAULT_CALIBRATION,
            x: blue.x,
            z: blue.z,
            yaw: blue.yaw,
          },
        };
      },
    },
    setHeadYaw(yawDeg) {
      headState = {
        ...headState,
        lastValidYaw: yawDeg,
        sample: {
          ...headState.sample,
          t: headState.sample.t + 16,
          forward: forwardForYaw(yawDeg),
        },
      };
      headListener?.('sample');
    },
    triggerRecenter() {
      headState = {
        ...headState,
        recentering: true,
        referenceResets: headState.referenceResets + 1,
      };
      headListener?.('recenter');
    },
    finishRecenter() {
      headState = {
        ...headState,
        recentering: false,
        sample: { ...headState.sample, t: headState.sample.t + 32 },
      };
      headListener?.('sample');
    },
  };
}

function enterEyesStage(session, { stepFrameMs = 20 } = {}) {
  session.solo();
  const v = session.getSnapshot();
  for (const asset of ['arena', 'blue', 'red']) {
    session.assetLoaded(v.lease, v.token, v.placementVersion, asset);
  }
  const readyRes = session.ready();
  assert.equal(readyRes.started, true);
  // Pre-intro side view keeps bodyClip IdleAggro.
  assert.equal(session.getSnapshot().bodyClip, 'IdleAggro');
  // Advance past intro and countdown into active eyes fighting presentation.
  for (let i = 0; i < 250; i++) {
    session.stepExternalFrame(stepFrameMs / 1000);
    const snap = session.getSnapshot();
    if (snap.presentation === 'eyes' && snap.stage === 'fighting') break;
  }
  assert.equal(session.getSnapshot().presentation, 'eyes');
  assert.equal(session.getSnapshot().stage, 'fighting');
}

// Lightweight GLB reader + TRS forward kinematics for quest-blue-body.glb verification.
function parseGlb(filePath) {
  const bytes = fs.readFileSync(filePath);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binOffset = 20 + jsonLength + 8;
  const bin = bytes.subarray(binOffset);
  return { json, bin, bytes };
}

function readAccessorArray(json, bin, accessorIndex) {
  const acc = json.accessors[accessorIndex];
  const bv = json.bufferViews[acc.bufferView];
  const compCount =
    acc.type === 'SCALAR'
      ? 1
      : acc.type === 'VEC2'
        ? 2
        : acc.type === 'VEC3'
          ? 3
          : acc.type === 'MAT4'
            ? 16
            : 4;
  const elemSize = acc.componentType === 5121 ? 1 : acc.componentType === 5123 ? 2 : 4;
  const stride = bv.byteStride || compCount * elemSize;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    const off = base + i * stride;
    if (compCount === 1) {
      out.push(
        acc.componentType === 5126
          ? bin.readFloatLE(off)
          : acc.componentType === 5123
            ? bin.readUInt16LE(off)
            : bin.readUInt8(off)
      );
    } else {
      const vec = [];
      for (let c = 0; c < compCount; c++) {
        const co = off + c * elemSize;
        vec.push(
          acc.componentType === 5126
            ? bin.readFloatLE(co)
            : acc.componentType === 5123
              ? bin.readUInt16LE(co)
              : bin.readUInt8(co)
        );
      }
      out.push(vec);
    }
  }
  return out;
}

function mat4FromTrs(t, q, s) {
  const [qx, qy, qz, qw] = q;
  const [sx, sy, sz] = s;
  const xx = qx * qx;
  const yy = qy * qy;
  const zz = qz * qz;
  const xy = qx * qy;
  const xz = qx * qz;
  const yz = qy * qz;
  const wx = qw * qx;
  const wy = qw * qy;
  const wz = qw * qz;
  return [
    (1 - 2 * (yy + zz)) * sx,
    2 * (xy + wz) * sx,
    2 * (xz - wy) * sx,
    0,
    2 * (xy - wz) * sy,
    (1 - 2 * (xx + zz)) * sy,
    2 * (yz + wx) * sy,
    0,
    2 * (xz + wy) * sz,
    2 * (yz - wx) * sz,
    (1 - 2 * (xx + yy)) * sz,
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}

function mulMat4(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function slerp(q0, q1, alpha) {
  let dot = q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3];
  let b = q1;
  if (dot < 0) {
    dot = -dot;
    b = [-q1[0], -q1[1], -q1[2], -q1[3]];
  }
  if (dot > 0.9995) {
    const r = q0.map((v, i) => v + (b[i] - v) * alpha);
    const len = Math.hypot(r[0], r[1], r[2], r[3]);
    return r.map((v) => v / len);
  }
  const theta0 = Math.acos(Math.min(1, Math.max(-1, dot)));
  const theta = theta0 * alpha;
  const sinT0 = Math.sin(theta0);
  const s0 = Math.cos(theta) - (dot * Math.sin(theta)) / sinT0;
  const s1 = Math.sin(theta) / sinT0;
  return q0.map((v, i) => s0 * v + s1 * b[i]);
}

function sampleTrack(times, values, t, isQuat) {
  if (t <= times[0]) return values[0];
  const last = times.length - 1;
  if (t >= times[last]) return values[last];
  let lo = 0;
  while (lo + 1 < times.length && times[lo + 1] < t) lo++;
  const dt = times[lo + 1] - times[lo];
  const alpha = dt > 1e-8 ? (t - times[lo]) / dt : 0;
  if (isQuat) return slerp(values[lo], values[lo + 1], alpha);
  return values[lo].map((v, i) => v + (values[lo + 1][i] - v) * alpha);
}

test('stepQuestFirstPersonBodyClip maps all 8 directions with angular hysteresis and immediate diagonal activation', () => {
  let state = createQuestFirstPersonBodyTrackerState();
  assert.equal(state.clip, 'IdleAggro');

  // Below start threshold remains idle.
  state = stepQuestFirstPersonBodyClip(state, {
    active: true,
    running: true,
    forwardSpeed: QUEST_BODY_MOVE_START_SPEED * 0.5,
    leftSpeed: 0,
    dtSeconds: 0.02,
  });
  assert.equal(state.clip, 'IdleAggro');

  // All 4 diagonal directions activate immediately from IdleAggro without stepping through cardinals.
  for (const [forwardSpeed, leftSpeed, expected] of [
    [0.055, 0.055, 'WalkForwardLeft'],
    [0.055, -0.055, 'WalkForwardRight'],
    [-0.055, 0.055, 'WalkBackwardLeft'],
    [-0.055, -0.055, 'WalkBackwardRight'],
  ]) {
    const diag = stepQuestFirstPersonBodyClip(createQuestFirstPersonBodyTrackerState(), {
      active: true,
      running: true,
      forwardSpeed,
      leftSpeed,
      dtSeconds: 0.016,
    });
    assert.equal(diag.clip, expected, `diagonal (${forwardSpeed}, ${leftSpeed})`);
  }

  // Forward activates immediately at typical ring speed (<= 0.08 sim/s).
  state = stepQuestFirstPersonBodyClip(createQuestFirstPersonBodyTrackerState(), {
    active: true,
    running: true,
    forwardSpeed: 0.06,
    leftSpeed: 0,
    dtSeconds: 0.016,
  });
  assert.equal(state.clip, 'WalkForward');

  // Small angle drift inside boundary hysteresis (25 deg < 22.5 + QUEST_BODY_DIRECTION_HYSTERESIS_DEG) holds WalkForward.
  const driftRad = (25 * Math.PI) / 180;
  for (let i = 0; i < 10; i++) {
    state = stepQuestFirstPersonBodyClip(state, {
      active: true,
      running: true,
      forwardSpeed: 0.07 * Math.cos(driftRad),
      leftSpeed: 0.07 * Math.sin(driftRad),
      dtSeconds: 0.02,
    });
    assert.equal(state.clip, 'WalkForward');
  }

  // Clear 45-degree diagonal switches smoothly to WalkForwardLeft after dwell.
  state = stepQuestFirstPersonBodyClip(state, {
    active: true,
    running: true,
    forwardSpeed: 0.055,
    leftSpeed: 0.055,
    dtSeconds: QUEST_BODY_CLIP_SWITCH_DWELL_S / 2,
  });
  assert.equal(state.clip, 'WalkForward');
  state = stepQuestFirstPersonBodyClip(state, {
    active: true,
    running: true,
    forwardSpeed: 0.055,
    leftSpeed: 0.055,
    dtSeconds: QUEST_BODY_CLIP_SWITCH_DWELL_S,
  });
  assert.equal(state.clip, 'WalkForwardLeft');

  // Boundary hysteresis holds WalkForwardLeft across minor 20-deg and 70-deg wobble without chattering.
  assert.ok(QUEST_BODY_DIRECTION_HYSTERESIS_DEG >= 5);
  for (const wobbleDeg of [20, 70, 45]) {
    const wRad = (wobbleDeg * Math.PI) / 180;
    state = stepQuestFirstPersonBodyClip(state, {
      active: true,
      running: true,
      forwardSpeed: 0.07 * Math.cos(wRad),
      leftSpeed: 0.07 * Math.sin(wRad),
      dtSeconds: 0.02,
    });
    assert.equal(state.clip, 'WalkForwardLeft');
  }

  // Clear lateral dominance switches from WalkForwardLeft to StrafeLeft after brief dwell.
  state = stepQuestFirstPersonBodyClip(state, {
    active: true,
    running: true,
    forwardSpeed: 0.01,
    leftSpeed: 0.07,
    dtSeconds: QUEST_BODY_CLIP_SWITCH_DWELL_S / 2,
  });
  assert.equal(state.clip, 'WalkForwardLeft');
  state = stepQuestFirstPersonBodyClip(state, {
    active: true,
    running: true,
    forwardSpeed: 0.01,
    leftSpeed: 0.07,
    dtSeconds: QUEST_BODY_CLIP_SWITCH_DWELL_S,
  });
  assert.equal(state.clip, 'StrafeLeft');

  // Brief zero-crossing sample below stop threshold during stick reversal holds walk rather than flashing IdleAggro.
  state = stepQuestFirstPersonBodyClip(state, {
    active: true,
    running: true,
    forwardSpeed: 0,
    leftSpeed: QUEST_BODY_MOVE_STOP_SPEED * 0.5,
    dtSeconds: 0.016,
  });
  assert.equal(state.clip, 'StrafeLeft');

  // Reversing to WalkBackwardRight right after brief zero-crossing transitions cleanly after switch dwell.
  state = stepQuestFirstPersonBodyClip(state, {
    active: true,
    running: true,
    forwardSpeed: -0.055,
    leftSpeed: -0.055,
    dtSeconds: QUEST_BODY_CLIP_SWITCH_DWELL_S,
  });
  assert.equal(state.clip, 'WalkBackwardRight');

  // Sustained release below stop threshold settles to IdleAggro once stop dwell elapses.
  state = stepQuestFirstPersonBodyClip(state, {
    active: true,
    running: true,
    forwardSpeed: 0,
    leftSpeed: QUEST_BODY_MOVE_STOP_SPEED * 0.5,
    dtSeconds: QUEST_BODY_STOP_DWELL_S,
  });
  assert.equal(state.clip, 'IdleAggro');

  // Remaining cardinal clips.
  const back = stepQuestFirstPersonBodyClip(createQuestFirstPersonBodyTrackerState(), {
    active: true,
    running: true,
    forwardSpeed: -0.06,
    leftSpeed: 0.002,
    dtSeconds: 0.016,
  });
  assert.equal(back.clip, 'WalkBackward');

  const right = stepQuestFirstPersonBodyClip(createQuestFirstPersonBodyTrackerState(), {
    active: true,
    running: true,
    forwardSpeed: 0.002,
    leftSpeed: -0.06,
    dtSeconds: 0.016,
  });
  assert.equal(right.clip, 'StrafeRight');

  // Focus/running loss stops immediately.
  const stoppedByFocus = stepQuestFirstPersonBodyClip(right, {
    active: false,
    running: true,
    forwardSpeed: 0,
    leftSpeed: -0.22,
    dtSeconds: 0.016,
  });
  assert.equal(stoppedByFocus.clip, 'IdleAggro');

  const stoppedByPause = stepQuestFirstPersonBodyClip(right, {
    active: true,
    running: false,
    forwardSpeed: 0,
    leftSpeed: -0.22,
    dtSeconds: 0.016,
  });
  assert.equal(stoppedByPause.clip, 'IdleAggro');
});

test('QuestArenaSession drives diagonal translation and all 8 bodyClip directions under head yaw while stopping on block/release/focus loss', (t) => {
  const { clock, advanceBy, pendingCount, clearAll } = makeHarnessClock();
  const mocks = makeQuestHeadSource(0);
  const session = createQuestArenaSession(clock, mocks.headSource, { cpuEnabled: false });
  t.after(() => {
    session.dispose();
    clearAll();
  });

  let seq = 1;
  const pushStick = (x, y, overrides = {}) => {
    seq += 1;
    session.setInputState(
      makeSample({
        seq,
        t: 100 + seq * 16,
        stick: [x, y],
        ...overrides,
      }),
      'live'
    );
  };

  assert.equal(session.getSnapshot().bodyClip, 'IdleAggro');
  enterEyesStage(session);
  assert.equal(session.getSnapshot().bodyClip, 'IdleAggro');

  const startBlueYaw = session.getLiveTransforms().blue.yaw;

  // Walking backward first gives open ring room behind and to the sides for diagonal tests.
  pushStick(0, -1);
  advanceBy(16);
  session.stepExternalFrame(0.016);
  assert.equal(session.getSnapshot().bodyClip, 'WalkBackward');
  assert.equal(session.getLiveTransforms().blue.yaw, startBlueYaw);

  // Move further back so forward-diagonal strides never clip separation before testing all 4 diagonals.
  for (let i = 0; i < 12; i++) {
    advanceBy(50);
    session.stepExternalFrame(0.05);
  }
  pushStick(0, 0);
  for (let i = 0; i < 4; i++) {
    advanceBy(16);
    session.stepExternalFrame(0.016);
  }
  assert.equal(session.getSnapshot().bodyClip, 'IdleAggro');

  // Verify all 4 diagonal thumbstick inputs move diagonally at normalized speed (<= 0.08 sim/s) and pick the matching diagonal clip.
  const blueYawRad = (startBlueYaw * Math.PI) / 180;
  const fwdVec = [Math.sin(blueYawRad), Math.cos(blueYawRad)];
  const leftVec = [fwdVec[1], -fwdVec[0]];
  const diagCases = [
    { stick: [-0.707, 0.707], clip: 'WalkForwardLeft', signF: 1, signL: 1 },
    { stick: [0.707, 0.707], clip: 'WalkForwardRight', signF: 1, signL: -1 },
    { stick: [-0.707, -0.707], clip: 'WalkBackwardLeft', signF: -1, signL: 1 },
    { stick: [0.707, -0.707], clip: 'WalkBackwardRight', signF: -1, signL: -1 },
  ];
  for (const dc of diagCases) {
    mocks.setHeadYaw(0);
    const before = session.getLiveTransforms().blue;
    pushStick(dc.stick[0], dc.stick[1]);
    for (let i = 0; i < 5; i++) {
      advanceBy(16);
      session.stepExternalFrame(0.016);
    }
    const after = session.getLiveTransforms().blue;
    const dx = after.x - before.x;
    const dz = after.z - before.z;
    const dist = Math.hypot(dx, dz);
    const elapsed = 5 * 0.016;
    assert.ok(dist > 0.005 && dist / elapsed <= 0.08 + 1e-6, `${dc.clip} speed=${dist / elapsed}`);
    const df = dx * fwdVec[0] + dz * fwdVec[1];
    const dl = dx * leftVec[0] + dz * leftVec[1];
    assert.ok(df * dc.signF > 0.003 && dl * dc.signL > 0.003, `${dc.clip} df=${df} dl=${dl}`);
    assert.ok(
      Math.abs(Math.abs(df) - Math.abs(dl)) < 1e-3,
      `${dc.clip} unequal diagonal axes df=${df} dl=${dl}`
    );
    assert.equal(session.getSnapshot().bodyClip, dc.clip);
    assert.equal(after.yaw, startBlueYaw);

    pushStick(0, 0);
    for (let i = 0; i < 4; i++) {
      advanceBy(16);
      session.stepExternalFrame(0.016);
    }
    assert.equal(session.getSnapshot().bodyClip, 'IdleAggro');
  }

  // Head-yaw steering while pushing stick forward (+Y) steers through cardinal and diagonal clips without rotating body yaw.
  pushStick(0, 1);
  mocks.setHeadYaw(45);
  for (let i = 0; i < 6; i++) {
    advanceBy(16);
    session.stepExternalFrame(0.016);
  }
  assert.equal(session.getSnapshot().bodyClip, 'WalkForwardLeft');
  assert.equal(session.getLiveTransforms().blue.yaw, startBlueYaw);

  mocks.setHeadYaw(90);
  for (let i = 0; i < 6; i++) {
    advanceBy(16);
    session.stepExternalFrame(0.016);
  }
  assert.equal(session.getSnapshot().bodyClip, 'StrafeLeft');

  mocks.setHeadYaw(-45);
  for (let i = 0; i < 6; i++) {
    advanceBy(16);
    session.stepExternalFrame(0.016);
  }
  assert.equal(session.getSnapshot().bodyClip, 'WalkForwardRight');

  mocks.setHeadYaw(-90);
  for (let i = 0; i < 6; i++) {
    advanceBy(16);
    session.stepExternalFrame(0.016);
  }
  assert.equal(session.getSnapshot().bodyClip, 'StrafeRight');

  // Brief zero-crossing during rapid stick reversal (StrafeRight -> neutral 1 frame -> WalkForward) does not flash IdleAggro.
  mocks.setHeadYaw(0);
  pushStick(0, 0);
  advanceBy(16);
  session.stepExternalFrame(0.016);
  assert.equal(session.getSnapshot().bodyClip, 'StrafeRight');
  pushStick(0, 1);
  for (let i = 0; i < 6; i++) {
    advanceBy(16);
    session.stepExternalFrame(0.016);
  }
  assert.equal(session.getSnapshot().bodyClip, 'WalkForward');

  // Pushing forward until blocked at minimum separation stops walking in place and settles to IdleAggro,
  // and pushing forward-left while pressed against the opponent slides tangentially left as StrafeLeft.
  for (let i = 0; i < 60; i++) {
    advanceBy(50);
    session.stepExternalFrame(0.05);
  }
  assert.equal(session.getSnapshot().bodyClip, 'IdleAggro');

  pushStick(-0.707, 0.707);
  for (let i = 0; i < 6; i++) {
    advanceBy(16);
    session.stepExternalFrame(0.016);
  }
  assert.equal(session.getSnapshot().bodyClip, 'StrafeLeft');

  // Steer backward into open space, then verify focus loss, menu focus, recenter, and app pause stop immediately.
  pushStick(0, -1);
  for (let i = 0; i < 6; i++) {
    advanceBy(16);
    session.stepExternalFrame(0.016);
  }
  assert.equal(session.getSnapshot().bodyClip, 'WalkBackward');

  pushStick(0, -1, { focused: false });
  assert.equal(session.getSnapshot().bodyClip, 'IdleAggro');

  pushStick(0, -1, { focused: true });
  advanceBy(16);
  session.stepExternalFrame(0.016);
  assert.equal(session.getSnapshot().bodyClip, 'WalkBackward');

  session.setMenuFocus(true);
  assert.equal(session.getSnapshot().bodyClip, 'IdleAggro');
  session.setMenuFocus(false);

  advanceBy(16);
  session.stepExternalFrame(0.016);
  assert.equal(session.getSnapshot().bodyClip, 'WalkBackward');
  mocks.triggerRecenter();
  assert.equal(session.getSnapshot().bodyClip, 'IdleAggro');
  mocks.finishRecenter();

  pushStick(0, -1);
  advanceBy(16);
  session.stepExternalFrame(0.016);
  assert.equal(session.getSnapshot().bodyClip, 'WalkBackward');
  session.setAppActive(false);
  assert.equal(session.getSnapshot().bodyClip, 'IdleAggro');

  assert.equal(pendingCount(), 0);
});

test('extracted quest-blue-body.glb has valid 20-joint skin, 9 locomotion clips (including 4 diagonals), locked shoulders, safe head height, and untouched original assets', () => {
  const { json, bin } = parseGlb(path.join(repoRoot, 'assets/arena/quest/quest-blue-body.glb'));
  assert.equal(json.skins.length, 1);
  const skin = json.skins[0];
  assert.equal(skin.joints.length, 20);
  assert.deepEqual(
    json.animations.map((a) => a.name),
    [...QUEST_FIRST_PERSON_BODY_CLIPS]
  );

  // Validate JOINTS_0 & WEIGHTS_0 across all primitives.
  const maxJointIndex = skin.joints.length - 1;
  for (const prim of json.meshes[0].primitives) {
    const joints = readAccessorArray(json, bin, prim.attributes.JOINTS_0);
    const weights = readAccessorArray(json, bin, prim.attributes.WEIGHTS_0);
    assert.equal(joints.length, weights.length);
    for (let i = 0; i < joints.length; i++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        assert.ok(joints[i][k] >= 0 && joints[i][k] <= maxJointIndex);
        assert.ok(Number.isFinite(weights[i][k]) && weights[i][k] >= 0);
        sum += weights[i][k];
      }
      assert.ok(Math.abs(sum - 1) < 1e-4, `weight sum ${sum}`);
    }
  }

  // Extract metadata shoulders & verify every animated frame keeps upperarm_l/r locked to those anchors.
  const extractMeta = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, 'assets/arena/quest/quest-first-person-extract.json'),
      'utf8'
    )
  );
  const parentOf = new Array(json.nodes.length).fill(-1);
  json.nodes.forEach((node, idx) => {
    for (const child of node.children || []) parentOf[child] = idx;
  });
  const baseT = json.nodes.map((n) => n.translation || [0, 0, 0]);
  const baseR = json.nodes.map((n) => n.rotation || [0, 0, 0, 1]);
  const baseS = json.nodes.map((n) => n.scale || [1, 1, 1]);

  const upperLNode = json.nodes.findIndex((n) => n.name === 'upperarm_l');
  const upperRNode = json.nodes.findIndex((n) => n.name === 'upperarm_r');
  assert.ok(upperLNode >= 0 && upperRNode >= 0);
  assert.ok(
    json.nodes.some((n) => n.name === 'thigh_l') && json.nodes.some((n) => n.name === 'calf_l'),
    'legs must remain in body skeleton'
  );

  // Verify glTF 2.0 extensionsUsed covers every extension declared on any material.
  const declaredExts = new Set();
  for (const material of json.materials || []) {
    for (const extKey of Object.keys(material.extensions || {})) declaredExts.add(extKey);
  }
  for (const extKey of declaredExts) {
    assert.ok(
      (json.extensionsUsed || []).includes(extKey),
      `extensionsUsed missing material extension ${extKey}`
    );
  }

  // Verify placeQuestFirstPersonArms places hands & elbows cleanly inside calibration reach (including DEFAULT_CALIBRATION.yaw).
  const gripSample = makeSample({ seq: 1, t: 100, capturedNs: 1_000_000 });
  const calYawRad = (DEFAULT_CALIBRATION.yaw * Math.PI) / 180;
  const rotateCalYaw = ([x, y, z]) => [
    x * Math.cos(calYawRad) + z * Math.sin(calYawRad),
    y,
    -x * Math.sin(calYawRad) + z * Math.cos(calYawRad),
  ];
  const shoulderTarget = (modelShoulder) => {
    const rel = [
      (modelShoulder[0] - ROBOT_EYE_MODEL[0]) * QUEST_FIRST_PERSON_ARM_SCALE,
      (modelShoulder[1] - ROBOT_EYE_MODEL[1]) * QUEST_FIRST_PERSON_ARM_SCALE,
      (modelShoulder[2] - ROBOT_EYE_MODEL[2]) * QUEST_FIRST_PERSON_ARM_SCALE,
    ];
    const rot = rotateCalYaw(rel);
    return [
      DEFAULT_CALIBRATION.origin[0] + rot[0],
      DEFAULT_CALIBRATION.origin[1] + rot[1],
      DEFAULT_CALIBRATION.origin[2] + rot[2],
    ];
  };
  const leftShoulder = shoulderTarget(extractMeta.arms.left.shoulder);
  const rightShoulder = shoulderTarget(extractMeta.arms.right.shoulder);
  assert.ok(
    leftShoulder[0] < 0 && rightShoulder[0] > 0,
    'yaw=180 places left at -X and right at +X'
  );
  gripSample.left.grip.position = [
    leftShoulder[0] - 0.05,
    leftShoulder[1] - 0.1,
    leftShoulder[2] - 0.25,
  ];
  gripSample.right.grip.position = [
    rightShoulder[0] + 0.05,
    rightShoulder[1] - 0.1,
    rightShoulder[2] - 0.25,
  ];
  const placedArms = placeQuestFirstPersonArms({
    sample: gripSample,
    headRefEpoch: 1,
    body: { calibration: DEFAULT_CALIBRATION, lift: 0 },
    poseSource: 'grip',
    nowNs: 1_000_000,
  });
  assert.equal(placedArms.left.visible, true);
  assert.equal(placedArms.right.visible, true);
  assert.ok(placedArms.left.upper && placedArms.left.forearm);
  assert.ok(placedArms.right.upper && placedArms.right.forearm);
  assert.ok(
    Math.hypot(
      placedArms.left.upper.position[0] - leftShoulder[0],
      placedArms.left.upper.position[1] - leftShoulder[1],
      placedArms.left.upper.position[2] - leftShoulder[2]
    ) < 1e-5
  );
  assert.ok(
    Math.hypot(
      placedArms.right.upper.position[0] - rightShoulder[0],
      placedArms.right.upper.position[1] - rightShoulder[1],
      placedArms.right.upper.position[2] - rightShoulder[2]
    ) < 1e-5
  );
  assert.ok(QUEST_WORLD_SCALE > 0);

  const computeWorlds = (anim, t) => {
    const tr = baseT.map((v) => [...v]);
    const ro = baseR.map((v) => [...v]);
    const sc = baseS.map((v) => [...v]);
    for (const ch of anim.channels) {
      const sampler = anim.samplers[ch.sampler];
      const times = readAccessorArray(json, bin, sampler.input);
      const values = readAccessorArray(json, bin, sampler.output);
      const val = sampleTrack(times, values, t, ch.target.path === 'rotation');
      if (ch.target.path === 'translation') tr[ch.target.node] = val;
      else if (ch.target.path === 'rotation') ro[ch.target.node] = val;
      else if (ch.target.path === 'scale') sc[ch.target.node] = val;
    }
    const local = json.nodes.map((_, i) => mat4FromTrs(tr[i], ro[i], sc[i]));
    const world = new Array(json.nodes.length);
    const getWorld = (i) => {
      if (world[i]) return world[i];
      world[i] = parentOf[i] < 0 ? local[i] : mulMat4(getWorld(parentOf[i]), local[i]);
      return world[i];
    };
    return json.nodes.map((_, i) => getWorld(i));
  };

  const inverseBindMatrices = readAccessorArray(json, bin, skin.inverseBindMatrices);
  const skinnedMeshes = json.meshes[0].primitives.map((prim) => ({
    positions: readAccessorArray(json, bin, prim.attributes.POSITION),
    joints: readAccessorArray(json, bin, prim.attributes.JOINTS_0),
    weights: readAccessorArray(json, bin, prim.attributes.WEIGHTS_0),
  }));

  let recomputedMinY = Infinity;
  let recomputedMaxY = -Infinity;
  let maxLegOverlapVol = 0;
  const footLNode = json.nodes.findIndex((n) => n.name === 'foot_l');
  const footRNode = json.nodes.findIndex((n) => n.name === 'foot_r');
  const leftLegJ = new Set(
    ['thigh_l', 'calf_l', 'foot_l', 'ball_l'].map((name) =>
      skin.joints.findIndex((ni) => json.nodes[ni].name === name)
    )
  );
  const rightLegJ = new Set(
    ['thigh_r', 'calf_r', 'foot_r', 'ball_r'].map((name) =>
      skin.joints.findIndex((ni) => json.nodes[ni].name === name)
    )
  );

  const clipStrideExtents = new Map();
  for (const anim of json.animations) {
    let maxT = 0;
    const sampleTimes = new Set();
    for (const s of anim.samplers) {
      const ts = readAccessorArray(json, bin, s.input);
      for (const t of ts) sampleTimes.add(t);
      maxT = Math.max(maxT, ts[ts.length - 1]);
    }
    for (const alpha of [0, 0.25, 0.5, 0.75, 1]) sampleTimes.add(maxT * alpha);

    let lFront = null;
    let lBack = null;
    let rFront = null;
    let rBack = null;
    for (const t of sampleTimes) {
      const worlds = computeWorlds(anim, t);
      const fl = worlds[footLNode];
      const fr = worlds[footRNode];
      if (!lFront || fl[14] > lFront[2]) lFront = [fl[12], fl[13], fl[14]];
      if (!lBack || fl[14] < lBack[2]) lBack = [fl[12], fl[13], fl[14]];
      if (!rFront || fr[14] > rFront[2]) rFront = [fr[12], fr[13], fr[14]];
      if (!rBack || fr[14] < rBack[2]) rBack = [fr[12], fr[13], fr[14]];
      const l = worlds[upperLNode];
      const r = worlds[upperRNode];
      assert.ok(
        Math.hypot(
          l[12] - extractMeta.arms.left.shoulder[0],
          l[13] - extractMeta.arms.left.shoulder[1],
          l[14] - extractMeta.arms.left.shoulder[2]
        ) < 1e-4,
        `${anim.name} left shoulder drifted`
      );
      assert.ok(
        Math.hypot(
          r[12] - extractMeta.arms.right.shoulder[0],
          r[13] - extractMeta.arms.right.shoulder[1],
          r[14] - extractMeta.arms.right.shoulder[2]
        ) < 1e-4,
        `${anim.name} right shoulder drifted`
      );
      assert.ok(
        worlds[footLNode][12] > 0.04 && worlds[footRNode][12] < -0.04,
        `${anim.name} t=${t} feet crossed midline: L=${worlds[footLNode][12]}, R=${worlds[footRNode][12]}`
      );

      const jointMats = skin.joints.map((nodeIdx, jIdx) =>
        mulMat4(worlds[nodeIdx], inverseBindMatrices[jIdx])
      );
      const lBox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      const rBox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const prim of skinnedMeshes) {
        for (let vi = 0; vi < prim.positions.length; vi++) {
          const p = prim.positions[vi];
          const j = prim.joints[vi];
          const wt = prim.weights[vi];
          let lw = 0;
          let rw = 0;
          let x = 0;
          let y = 0;
          let z = 0;
          for (let k = 0; k < 4; k++) {
            if (wt[k] === 0) continue;
            if (leftLegJ.has(j[k])) lw += wt[k];
            if (rightLegJ.has(j[k])) rw += wt[k];
            const m = jointMats[j[k]];
            x += (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) * wt[k];
            y += (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) * wt[k];
            z += (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) * wt[k];
          }
          if (y < recomputedMinY) recomputedMinY = y;
          if (y > recomputedMaxY) recomputedMaxY = y;
          if (lw >= 0.9 || rw >= 0.9) {
            const box = lw >= 0.9 ? lBox : rBox;
            if (x < box[0]) box[0] = x;
            if (y < box[1]) box[1] = y;
            if (z < box[2]) box[2] = z;
            if (x > box[3]) box[3] = x;
            if (y > box[4]) box[4] = y;
            if (z > box[5]) box[5] = z;
          }
        }
      }
      const ox = Math.max(0, Math.min(lBox[3], rBox[3]) - Math.max(lBox[0], rBox[0]));
      const oy = Math.max(0, Math.min(lBox[4], rBox[4]) - Math.max(lBox[1], rBox[1]));
      const oz = Math.max(0, Math.min(lBox[5], rBox[5]) - Math.max(lBox[2], rBox[2]));
      maxLegOverlapVol = Math.max(maxLegOverlapVol, ox * oy * oz);
    }
    clipStrideExtents.set(anim.name, {
      lDeltaX: lFront[0] - lBack[0],
      lDeltaZ: lFront[2] - lBack[2],
      rDeltaX: rFront[0] - rBack[0],
      rDeltaZ: rFront[2] - rBack[2],
    });
  }

  // Verify each diagonal clip produces a genuine diagonal foot-stride vector distinct from cardinal walks.
  const wf = clipStrideExtents.get('WalkForward');
  assert.ok(Math.abs(wf.lDeltaX) < 0.02 && wf.lDeltaZ > 0.35);
  const wfl = clipStrideExtents.get('WalkForwardLeft');
  assert.ok(wfl.lDeltaX > 0.08 && wfl.rDeltaX > 0.08 && wfl.lDeltaZ > 0.35);
  const wfr = clipStrideExtents.get('WalkForwardRight');
  assert.ok(wfr.lDeltaX < -0.08 && wfr.rDeltaX < -0.08 && wfr.lDeltaZ > 0.35);
  const wbl = clipStrideExtents.get('WalkBackwardLeft');
  assert.ok(-wbl.lDeltaX > 0.07 && -wbl.rDeltaX > 0.07 && wbl.lDeltaZ > 0.35);
  const wbr = clipStrideExtents.get('WalkBackwardRight');
  assert.ok(-wbr.lDeltaX < -0.07 && -wbr.rDeltaX < -0.06 && wbr.lDeltaZ > 0.35);

  assert.ok(recomputedMaxY < 1.02, `recomputed maxY=${recomputedMaxY}`);
  assert.ok(
    recomputedMinY >= -0.005 && recomputedMinY <= 0.02,
    `recomputed minY=${recomputedMinY} violates floor contact bounds`
  );
  assert.equal(maxLegOverlapVol, 0, `legs overlapped across midline: vol=${maxLegOverlapVol}`);
  assert.ok(extractMeta.body.maxAnimatedY < 1.02);
  assert.ok(extractMeta.body.minAnimatedY >= -0.005 && extractMeta.body.minAnimatedY <= 0.02);
  assert.equal(extractMeta.body.maxLegOverlapVol, 0);
  assert.ok(extractMeta.body.maxShoulderDriftModel <= 1e-5);

  // Original Combat GLBs and all 6 extracted arm/fist GLBs remain byte-for-byte unchanged.
  assert.deepEqual(sha256File('assets/arena/Mike_Player1_Blue_Combat_AR.glb'), {
    bytes: 19978136,
    sha256: 'ac3afd1fa615a2ea5b34de72f22a5780a158369e7b425d619dfcc5cd3b69833f',
  });
  assert.deepEqual(sha256File('assets/arena/Mike_Player2_RedOrange_Combat_AR.glb'), {
    bytes: 19087388,
    sha256: 'a8436e15934cfc82c0f1bbc8c10b63d07289b9787656d5ffcfcf49a362bd7ba5',
  });
  assert.deepEqual(sha256File('assets/arena/quest/quest-blue-upper-left.glb'), {
    bytes: 110260,
    sha256: '8de7c87d173ed5690f58d4ea4970efd3260b1fdec642fa0d03edb7ff597a074f',
  });
  assert.deepEqual(sha256File('assets/arena/quest/quest-blue-forearm-left.glb'), {
    bytes: 168444,
    sha256: '2c731dc9a6f755a26b9409dbe730f36f76ef3f718e533977ec08477707aaac46',
  });
  assert.deepEqual(sha256File('assets/arena/quest/quest-blue-hand-left.glb'), {
    bytes: 514656,
    sha256: 'ee05db61829f3b5843b3209bdc2f4de6a599f179248a92366870cd70e6bb43c0',
  });
  assert.deepEqual(sha256File('assets/arena/quest/quest-blue-upper-right.glb'), {
    bytes: 110256,
    sha256: '1940859b77c238c018f90f60cc2b82f56c1748915204abf894f597c83784c343',
  });
  assert.deepEqual(sha256File('assets/arena/quest/quest-blue-forearm-right.glb'), {
    bytes: 168448,
    sha256: '843ff7bfd4823ebe869c27a47dceea08dd45bc7146a0c19dc3acd3b6743223e5',
  });
  assert.deepEqual(sha256File('assets/arena/quest/quest-blue-hand-right.glb'), {
    bytes: 514696,
    sha256: '021b0a77e8f46434dd916c44089bad87467d3892615880d1590b9f14644883f1',
  });

  // Phone arena scene stays completely isolated from Quest extracted body/arms.
  const phoneScene = fs.readFileSync(
    path.join(repoRoot, 'src/features/arena-fighter/arena-scene.native.tsx'),
    'utf8'
  );
  assert.equal(phoneScene.includes('quest-blue-body'), false);
  assert.equal(phoneScene.includes('quest-first-person'), false);

  // Quest scene executes body animation effect safely across cancelled-rAF pause and A -> B -> A races.
  const questScene = fs.readFileSync(
    path.join(repoRoot, 'src/features/quest-vr/quest-arena-scene.native.tsx'),
    'utf8'
  );
  assert.match(
    questScene,
    /bodyIdleAnimation\s*=\s*\{\s*name:\s*'IdleAggro',\s*loop:\s*true,\s*run:\s*false/
  );
  assert.match(questScene, /const nodeVisible = id === 'blue' \? true : visible/);
  assert.match(questScene, /cancelScheduledAnimationFrame\(handle\)/);
  assert.match(questScene, /view\.bodyClip/);
});

test('QuestArenaScene body animation effect handles cancelled-rAF pause and sub-frame A->B->A clip flicker', (t) => {
  const states = [];
  const effects = [];
  const refs = [];
  let stateIndex = 0;
  let effectIndex = 0;
  let refIndex = 0;
  let rafSeq = 1;
  const pendingRafs = new Map();
  let view = {
    page: 'ring',
    mode: 'solo',
    stage: 'fighting',
    phase: 'fighting',
    placed: true,
    tracking: true,
    virtualReady: true,
    landscape: true,
    assetsLoaded: true,
    canReady: true,
    localReady: true,
    acknowledged: true,
    leaving: false,
    message: null,
    token: 1,
    placementVersion: 1,
    lease: 1,
    transforms: {
      blue: { x: 0, z: 0.095, yaw: 180, lift: 0 },
      red: { x: 0, z: -0.095, yaw: 0, lift: 0 },
    },
    fighters: {
      blue: { clip: 'IdleAggro', animationId: 1 },
      red: { clip: 'IdleAggro', animationId: 1 },
    },
    bodyClip: 'IdleAggro',
    animationsRunning: false,
    outcome: null,
    lastReady: null,
    lines: [],
    presentation: 'side',
    introActive: false,
  };
  const viewListeners = new Set();
  const mockSession = {
    subscribe: (fn) => {
      viewListeners.add(fn);
      return () => viewListeners.delete(fn);
    },
    getSnapshot: () => view,
    onFrame: () => () => {},
    setInputState: () => {},
    setAppActive: () => {},
    setMenuFocus: () => {},
    getRigBlend: () => (view.presentation === 'eyes' ? 1 : 0),
    getIntroOpacity: () => 0,
    getLiveTransforms: () => view.transforms,
    animationApplied: () => {},
    dispose: () => {},
  };
  const mockTracker = {
    subscribe: () => () => {},
    getSnapshot: () => ({
      calibration: DEFAULT_CALIBRATION,
      anchor: view.transforms.blue,
      status: 'ready',
      message: null,
      sampleHz: 72,
      pose: null,
      outOfBounds: false,
      samplesSeen: 10,
      raw: null,
      referenceResets: 0,
    }),
    onCameraTransform: () => {},
    getLiveHeadState: () => ({ calibration: DEFAULT_CALIBRATION, refEpoch: 1, sample: null }),
    setRefSpaceEpochSource: () => {},
    dispose: () => {},
  };
  const noopPanel = {
    isAvailable: () => false,
    open: () => 0,
    draw: () => {},
    status: () => -1,
    hide: () => {},
    exitApp: () => true,
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const mocks = {
    react: {
      memo: (component) => component,
      useState: (initial) => {
        const idx = stateIndex++;
        if (!(idx in states)) states[idx] = typeof initial === 'function' ? initial() : initial;
        return [
          states[idx],
          (v) => {
            states[idx] = typeof v === 'function' ? v(states[idx]) : v;
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
      useMemo: (fn) => fn(),
      useRef: (initial) => {
        const idx = refIndex++;
        if (!(idx in refs)) refs[idx] = { current: initial };
        return refs[idx];
      },
      useSyncExternalStore: (_, get) => get(),
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    expo: {
      requireNativeModule: () => ({ downloadAsync: () => Promise.resolve('file:///copied') }),
    },
    'expo-asset': {
      Asset: {
        fromModule: (id) => ({
          uri: `file:///${id}`,
          localUri: `file:///${id}`,
          hash: 'h',
          type: 'png',
        }),
      },
    },
    '@reactvision/react-viro': {
      Viro3DObject: 'Viro3DObject',
      ViroAmbientLight: 'ViroAmbientLight',
      ViroDirectionalLight: 'ViroDirectionalLight',
      ViroMaterials: { createMaterials: () => {} },
      ViroNode: 'ViroNode',
      ViroQuad: 'ViroQuad',
      ViroScene: 'ViroScene',
      ViroSkyBox: 'ViroSkyBox',
      ViroText: 'ViroText',
      exitVRScene: () => {},
    },
    '../arena-fighter/arena-controller.ts': { ARENA_LAYOUT },
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
      questPanelNative: noopPanel,
    },
    './quest-arena-session.ts': { createQuestArenaSession: () => mockSession },
    './quest-head-rig.ts': require('../src/features/quest-vr/quest-head-rig.ts'),
    './quest-head-tracker.ts': { questHeadTracker: mockTracker },
    './quest-menu-asset-uri.ts': require('../src/features/quest-vr/quest-menu-asset-uri.ts'),
    './quest-menu-compositor.ts': compositorModule,
    './quest-menu-input.ts': { questPointerHover, questTriggerPress },
    './quest-menu-layer.ts': { questMenuLayer },
    './quest-menu-layout.ts': {
      QUEST_MENU_ALERT_SHIFT_M,
      QUEST_MENU_CARD_RADIUS_PX,
      QUEST_MENU_POSE,
      QUEST_MENU_SIZE,
      QUEST_TITLE_POSE,
      QUEST_TITLE_SIZE,
      QUEST_TITLE_TEXTURE,
      questMenuButtonFrame,
      questMenuCardMetrics,
      questMenuButtons,
      buildQuestMenu,
      buildQuestMenuTitle,
    },
    './quest-runtime-store.ts': {
      questRuntime: {
        getSnapshot: () => ({ status: 'immersive', appActive: true }),
        sceneMounted: () => {},
        sceneUnmounted: () => {},
        exitRequested: () => {},
      },
    },
    '../../../modules/quest-input/src/index.ts': {
      questRigSyncAvailable: () => false,
      questInputNative: null,
    },
    './quest-diagnostics-layout.ts': { questDiagLayerMaterials: () => ({}) },
    './quest-input-visualizer.native.tsx': {
      createSceneQuestInputSource: () => ({
        start: () => {},
        stop: () => {},
        subscribe: () => () => {},
        getSnapshot: () => null,
        onSample: () => () => {},
      }),
      QuestDiagnosticsPanel: 'QuestDiagnosticsPanel',
      QuestInputMarkers: 'QuestInputMarkers',
    },
  };
  const compiled = ts.transpileModule(
    fs.readFileSync(
      path.join(repoRoot, 'src/features/quest-vr/quest-arena-scene.native.tsx'),
      'utf8'
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
    }
  ).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    module: mod,
    exports: mod.exports,
    console: { ...console, warn: () => {}, error: () => {}, log: () => {} },
    Date,
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: (cb) => {
      const id = rafSeq++;
      pendingRafs.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id) => pendingRafs.delete(id),
    require: (name) => {
      if (!(name in mocks)) throw new Error('Missing mock: ' + name);
      return mocks[name];
    },
  });
  const Scene = mod.exports.default;
  const collect = (node, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      for (const n of node) collect(n, out);
      return out;
    }
    out.push(node);
    if (typeof node.type === 'function') collect(node.type(node.props), out);
    collect(node.props?.children, out);
    return out;
  };
  const renderScene = () => {
    stateIndex = 0;
    effectIndex = 0;
    refIndex = 0;
    return collect(Scene());
  };
  const flushRafs = () => {
    for (const [id, cb] of [...pendingRafs]) {
      pendingRafs.delete(id);
      cb();
    }
  };
  t.after(() => {
    for (const e of effects) e?.cleanup?.();
    pendingRafs.clear();
  });

  // 1. Mount in side view and attach native mock on blueBodyModelRef.
  const initialNodes = renderScene();
  const bodyObj = initialNodes.find(
    (n) => n.type === 'Viro3DObject' && n.props.source === 'quest-body.glb'
  );
  assert.ok(bodyObj && bodyObj.props.ref);
  const bodyWrites = [];
  const snapshotWrites = (items) => items.map((item) => ({ ...item }));
  bodyObj.props.ref.current = {
    setNativeProps: (props) => {
      if (props.animation) bodyWrites.push(props.animation);
    },
  };

  // 2. Defect #1a: fast false -> true -> false before rAF fires must still write run: false.
  view = { ...view, presentation: 'eyes', animationsRunning: true, bodyClip: 'IdleAggro' };
  renderScene();
  assert.deepEqual(snapshotWrites(bodyWrites), [
    { name: 'IdleAggro', loop: true, run: true, interruptible: false },
  ]);
  assert.equal(pendingRafs.size, 1);

  view = { ...view, animationsRunning: false };
  renderScene();
  assert.equal(pendingRafs.size, 0, 'cancelled rAF on fast pause');
  assert.deepEqual(snapshotWrites(bodyWrites).at(-1), {
    name: 'IdleAggro',
    loop: true,
    run: false,
    interruptible: false,
  });
  flushRafs();
  assert.equal(bodyWrites.length, 2, 'cancelled rAF never fires late');

  // 3. Sub-frame A -> B -> A while resuming (!interruptible) cancels B's rAF and restores A cleanly.
  bodyWrites.length = 0;
  view = { ...view, animationsRunning: true, bodyClip: 'IdleAggro' };
  renderScene();
  assert.equal(pendingRafs.size, 1);
  view = { ...view, bodyClip: 'WalkForward' };
  renderScene();
  assert.equal(pendingRafs.size, 1);
  view = { ...view, bodyClip: 'IdleAggro' };
  renderScene();
  assert.equal(pendingRafs.size, 1, 'stale WalkForward rAF replaced by IdleAggro rAF');
  assert.deepEqual(snapshotWrites(bodyWrites), [
    { name: 'IdleAggro', loop: true, run: true, interruptible: false },
    { name: 'WalkForward', loop: true, run: true, interruptible: false },
    { name: 'IdleAggro', loop: true, run: true, interruptible: false },
  ]);
  flushRafs();
  assert.deepEqual(snapshotWrites(bodyWrites).at(-1), {
    name: 'IdleAggro',
    loop: true,
    run: true,
    interruptible: true,
  });

  // 4. Settled clip switches while already running & interruptible switch immediately with interruptible: true (including diagonals).
  bodyWrites.length = 0;
  view = { ...view, bodyClip: 'WalkForward' };
  renderScene();
  assert.equal(pendingRafs.size, 0);
  assert.deepEqual(snapshotWrites(bodyWrites), [
    { name: 'WalkForward', loop: true, run: true, interruptible: true },
  ]);
  view = { ...view, bodyClip: 'WalkForwardLeft' };
  renderScene();
  view = { ...view, bodyClip: 'StrafeLeft' };
  renderScene();
  view = { ...view, bodyClip: 'WalkBackwardRight' };
  renderScene();
  assert.deepEqual(snapshotWrites(bodyWrites), [
    { name: 'WalkForward', loop: true, run: true, interruptible: true },
    { name: 'WalkForwardLeft', loop: true, run: true, interruptible: true },
    { name: 'StrafeLeft', loop: true, run: true, interruptible: true },
    { name: 'WalkBackwardRight', loop: true, run: true, interruptible: true },
  ]);

  // 5. Remounted body model (new lease) starts fresh and runs Step 1 + Step 2.
  bodyWrites.length = 0;
  const remountedWrites = [];
  bodyObj.props.ref.current = {
    setNativeProps: (props) => {
      if (props.animation) remountedWrites.push(props.animation);
    },
  };
  view = { ...view, lease: 2, bodyClip: 'IdleAggro' };
  renderScene();
  flushRafs();
  assert.deepEqual(snapshotWrites(remountedWrites), [
    { name: 'IdleAggro', loop: true, run: true, interruptible: false },
    { name: 'IdleAggro', loop: true, run: true, interruptible: true },
  ]);
});
