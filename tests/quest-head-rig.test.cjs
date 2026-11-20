const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ARENA_LAYOUT, ARENA_RULES } = require('../src/features/arena-fighter/arena-controller.ts');
const {
  DEFAULT_CALIBRATION,
  QUEST_HEAD_BOUNDS,
  QUEST_OUT_OF_BOUNDS_EXCESS,
  QUEST_WORLD_SCALE,
  ROBOT_EYE_MODEL,
  applyRig,
  calibrateFromSamples,
  REFERENCE_JUMP_MAX_DT_MS,
  eyeRingLocal,
  gameplayHeadPose,
  headSampleFromViro,
  headStep,
  isReferenceDiscontinuity,
  menuFrame,
  questRigTransform,
  stanceMarkerRingLocal,
  wrap180,
  yawFromForward,
} = require('../src/features/quest-vr/quest-head-rig.ts');

function readGLBJson(file) {
  const repoRoot = path.dirname(require.resolve('../package.json'));
  const bytes = fs.readFileSync(path.join(repoRoot, 'assets', 'arena', file));
  assert.equal(bytes.readUInt32LE(0), 0x46546c67);
  assert.equal(bytes.readUInt32LE(4), 2);
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
}

function mulMat4(a, b) {
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function trsMat4(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
  const p = node.translation || [0, 0, 0];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
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
}

function glbNodeRestPosition(json, nodeName) {
  const index = json.nodes.findIndex((n) => n.name === nodeName);
  assert.ok(index >= 0, `Missing node ${nodeName}`);
  const parents = new Map();
  json.nodes.forEach((n, i) => {
    for (const child of n.children || []) parents.set(child, i);
  });
  const world = (i) => {
    const local = trsMat4(json.nodes[i]);
    return parents.has(i) ? mulMat4(world(parents.get(i)), local) : local;
  };
  const m = world(index);
  return [m[12], m[13], m[14]];
}

function forwardVec(yawDeg, pitchDeg = 0) {
  const yr = (yawDeg * Math.PI) / 180;
  const pr = (pitchDeg * Math.PI) / 180;
  return [Math.sin(yr) * Math.cos(pr), Math.sin(pr), Math.cos(yr) * Math.cos(pr)];
}

function makeSample(t, position, yawDeg, pitchDeg = 0, rollDeg = 0) {
  const fwd = forwardVec(yawDeg, pitchDeg);
  // Up vector rotated by pitch and roll around forward (yaw-pitch-roll); orthogonal to fwd.
  const yr = (yawDeg * Math.PI) / 180;
  const pr = (pitchDeg * Math.PI) / 180;
  const rr = (rollDeg * Math.PI) / 180;
  const upNoRoll = [-Math.sin(yr) * Math.sin(pr), Math.cos(pr), -Math.cos(yr) * Math.sin(pr)];
  const rightNoRoll = [-Math.cos(yr), 0, Math.sin(yr)];
  const up = [
    upNoRoll[0] * Math.cos(rr) + rightNoRoll[0] * Math.sin(rr),
    upNoRoll[1] * Math.cos(rr) + rightNoRoll[1] * Math.sin(rr),
    upNoRoll[2] * Math.cos(rr) + rightNoRoll[2] * Math.sin(rr),
  ];
  return { t, position, forward: fwd, up };
}

function makePrng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('scale preserves ARENA_RULES/ARENA_LAYOUT snapshot and produces human-scale VR dimensions', () => {
  assert.equal(QUEST_WORLD_SCALE, 16);
  assert.equal(ARENA_RULES.spawn, 0.095);
  assert.equal(ARENA_RULES.boundary, 0.14 * 1.25);
  assert.equal(ARENA_RULES.separation, 0.055);
  assert.equal(ARENA_RULES.reach, 0.085);
  assert.ok(Math.abs(ARENA_LAYOUT.fighterScale - 0.12 / 1.59857170559) < 1e-12);

  const robotHeightVr = 1.59857170559 * ARENA_LAYOUT.fighterScale * QUEST_WORLD_SCALE;
  assert.ok(robotHeightVr >= 1.8 && robotHeightVr <= 2.1, `robotHeightVr=${robotHeightVr}`);

  const eyeHeightAboveFloorVr =
    (ROBOT_EYE_MODEL[1] * ARENA_LAYOUT.fighterScale + ARENA_LAYOUT.footOffset) * QUEST_WORLD_SCALE;
  assert.ok(
    Math.abs(eyeHeightAboveFloorVr - 1.355) < 0.01,
    `eyeHeightAboveFloorVr=${eyeHeightAboveFloorVr}`
  );

  const spawnGapVr = 2 * ARENA_RULES.spawn * QUEST_WORLD_SCALE;
  const twoReachVr = 2 * ARENA_RULES.reach * QUEST_WORLD_SCALE;
  assert.ok(spawnGapVr > twoReachVr, `${spawnGapVr} > ${twoReachVr}`);
});

test('both robot GLBs rest-pose eye_l/eye_r midpoint matches ROBOT_EYE_MODEL within 1e-3', () => {
  for (const file of ['Mike_Player1_Blue_Combat_AR.glb', 'Mike_Player2_RedOrange_Combat_AR.glb']) {
    const json = readGLBJson(file);
    const eyeL = glbNodeRestPosition(json, 'eye_l');
    const eyeR = glbNodeRestPosition(json, 'eye_r');
    const mid = [0, 1, 2].map((i) => (eyeL[i] + eyeR[i]) / 2);
    for (let i = 0; i < 3; i += 1) {
      assert.ok(
        Math.abs(mid[i] - ROBOT_EYE_MODEL[i]) < 1e-3,
        `${file} axis ${i}: ${mid[i]} vs ${ROBOT_EYE_MODEL[i]}`
      );
    }
  }
});

test('questRigTransform and applyRig align eye anchor, forward direction, default opponent, and ignore lift', () => {
  const rand = makePrng(0x51e303);
  for (let i = 0; i < 64; i += 1) {
    const anchor = {
      x: (rand() * 2 - 1) * ARENA_RULES.boundary,
      z: (rand() * 2 - 1) * ARENA_RULES.boundary,
      yaw: (rand() * 2 - 1) * 180,
    };
    const cal = {
      origin: [(rand() * 2 - 1) * 4, (rand() * 2 - 1) * 2, (rand() * 2 - 1) * 4],
      yaw: (rand() * 2 - 1) * 180,
      posture: i % 2 === 0 ? 'standing' : 'seated',
      source: 'system',
      entry: 1,
    };
    const rig = questRigTransform(cal, anchor);
    assert.equal(typeof rig.rotationY, 'number');
    assert.deepEqual(rig.position, cal.origin);
    assert.equal(rig.scale, QUEST_WORLD_SCALE);

    const eye = eyeRingLocal(anchor);
    const eyeWorld = applyRig(rig, eye);
    for (let k = 0; k < 3; k += 1) {
      assert.ok(Math.abs(eyeWorld[k] - cal.origin[k]) < 1e-9);
    }

    const fwdS1 = forwardVec(anchor.yaw);
    const aheadWorld = applyRig(rig, [eye[0] + fwdS1[0], eye[1], eye[2] + fwdS1[2]]);
    const dir = [0, 1, 2].map((k) => (aheadWorld[k] - eyeWorld[k]) / rig.scale);
    const expectedFwd = forwardVec(cal.yaw);
    for (let k = 0; k < 3; k += 1) {
      assert.ok(Math.abs(dir[k] - expectedFwd[k]) < 1e-9);
    }
  }

  const blue = { x: -ARENA_RULES.spawn, z: 0, yaw: 90 };
  const defaultRig = questRigTransform(DEFAULT_CALIBRATION, blue);
  const blueEye = eyeRingLocal(blue);
  const redEyeLevel = applyRig(defaultRig, [ARENA_RULES.spawn, blueEye[1], 0]);
  const expectedDist =
    2 * ARENA_RULES.spawn * QUEST_WORLD_SCALE -
    ROBOT_EYE_MODEL[2] * ARENA_LAYOUT.fighterScale * QUEST_WORLD_SCALE;
  assert.ok(Math.abs(redEyeLevel[0]) < 1e-6);
  assert.ok(Math.abs(redEyeLevel[1]) < 1e-6);
  assert.ok(Math.abs(redEyeLevel[2] + expectedDist) < 1e-6);
  assert.ok(Math.abs(expectedDist - 2.79642) < 1e-4);

  const liftedA = { ...blue, lift: 0 };
  const liftedB = { ...blue, lift: 0.18 };
  assert.deepEqual(eyeRingLocal(liftedA), eyeRingLocal(liftedB));
  assert.deepEqual(
    questRigTransform(DEFAULT_CALIBRATION, liftedA),
    questRigTransform(DEFAULT_CALIBRATION, liftedB)
  );

  assert.deepEqual(menuFrame(DEFAULT_CALIBRATION), { position: [0, 0, 0], rotationY: 0 });
  assert.deepEqual(menuFrame({ ...DEFAULT_CALIBRATION, origin: [1, 0.2, -0.5], yaw: 90 }), {
    position: [1, 0.2, -0.5],
    rotationY: -90,
  });
});

test('wrap180 and yawFromForward handle cardinal directions, pitch/roll invariance, vertical gaze, and +/-180', () => {
  assert.equal(Object.is(wrap180(-0), 0), true);
  assert.equal(wrap180(0), 0);
  assert.equal(wrap180(180), -180);
  assert.equal(wrap180(-180), -180);
  assert.equal(wrap180(360), 0);
  assert.equal(wrap180(-360), 0);
  assert.equal(wrap180(270), -90);
  assert.equal(wrap180(-270), 90);
  assert.equal(wrap180(540), -180);
  assert.equal(wrap180(181), -179);
  assert.equal(wrap180(-181), 179);
  assert.ok(wrap180(-180 - 1e-14) < 180 && wrap180(-180 - 1e-14) >= -180);
  assert.equal(Number.isNaN(wrap180(NaN)), true);

  assert.equal(yawFromForward([0, 0, 1]), 0);
  assert.equal(yawFromForward([1, 0, 0]), 90);
  assert.equal(yawFromForward([-1, 0, 0]), -90);
  assert.equal(wrap180(yawFromForward([0, 0, -1]) - 180), 0);

  // Pitch -40 deg and roll 15 deg regression (native quaternion Euler atan2 gave ~37.45 / ~29.29).
  for (const trueYaw of [45, 30, -135, 179.5, -179.5]) {
    const sample = makeSample(0, [0, 0, 0], trueYaw, -40, 15);
    const computed = yawFromForward(sample.forward);
    assert.ok(computed !== null);
    assert.ok(Math.abs(wrap180(computed - trueYaw)) < 1e-11);
  }

  assert.equal(yawFromForward([0, 1, 0]), null);
  assert.equal(yawFromForward([0, -1, 0]), null);
  assert.equal(yawFromForward([0.1, 0.99, 0.1]), null);
  assert.equal(yawFromForward([NaN, 0, 1]), null);
});

test('headSampleFromViro rejects invalid inputs and normalizes forward/up', () => {
  assert.equal(
    headSampleFromViro(NaN, { position: [0, 0, 0], forward: [0, 0, -1], up: [0, 1, 0] }),
    null
  );
  assert.equal(headSampleFromViro(10, {}), null);
  assert.equal(
    headSampleFromViro(10, { position: [0, 0], forward: [0, 0, -1], up: [0, 1, 0] }),
    null
  );
  assert.equal(
    headSampleFromViro(10, { position: [0, Infinity, 0], forward: [0, 0, -1], up: [0, 1, 0] }),
    null
  );
  assert.equal(
    headSampleFromViro(10, { position: [0, 0, 0], forward: [0, 0, 0], up: [0, 1, 0] }),
    null
  );
  assert.equal(
    headSampleFromViro(10, { position: [0, 0, 0], forward: [0, 0, -1], up: [0, 0, 0] }),
    null
  );

  const pos = [1, 2, 3];
  const sample = headSampleFromViro(100, { position: pos, forward: [0, 0, -5], up: [0, 4, 0] });
  assert.ok(sample);
  pos[0] = 99;
  assert.deepEqual(sample.position, [1, 2, 3]);
  assert.deepEqual(sample.forward, [0, 0, -1]);
  assert.deepEqual(sample.up, [0, 1, 0]);
});

test('calibrateFromSamples handles too-few, moving, invalid, outlier median, +/-180 wrap, and idempotence', () => {
  assert.deepEqual(calibrateFromSamples([]), { ok: false, reason: 'too-few' });
  const seven = Array.from({ length: 7 }, (_, i) => makeSample(i * 50, [0, 1.5, 0], 180));
  assert.deepEqual(calibrateFromSamples(seven), { ok: false, reason: 'too-few' });

  const movingPos = Array.from({ length: 8 }, (_, i) =>
    makeSample(i * 50, [i === 7 ? 0.04 : 0, 1.5, 0], 180)
  );
  assert.deepEqual(calibrateFromSamples(movingPos), { ok: false, reason: 'moving' });

  const movingYaw = Array.from({ length: 8 }, (_, i) =>
    makeSample(i * 50, [0, 1.5, 0], i === 7 ? 168 : 180)
  );
  assert.deepEqual(calibrateFromSamples(movingYaw), { ok: false, reason: 'moving' });

  const verticalGaze = Array.from({ length: 8 }, (_, i) =>
    makeSample(i * 50, [0, 1.5, 0], 0, i === 4 ? 89 : 0)
  );
  assert.deepEqual(calibrateFromSamples(verticalGaze), { ok: false, reason: 'invalid' });
  assert.deepEqual(calibrateFromSamples(verticalGaze, 0), { ok: false, reason: 'invalid' });
  assert.deepEqual(calibrateFromSamples(verticalGaze, NaN), { ok: false, reason: 'invalid' });

  const opposingYaws = Array.from({ length: 8 }, (_, i) =>
    makeSample(i * 50, [0, 1.5, 0], i % 2 === 0 ? 0 : 180)
  );
  assert.deepEqual(calibrateFromSamples(opposingYaws), { ok: false, reason: 'moving' });

  // Outlier within <= 0.03 m is ignored completely by median.
  const withOutlier = Array.from({ length: 9 }, (_, i) =>
    makeSample(i * 50, i === 3 ? [0.115, 1.515, -0.215] : [0.1, 1.5, -0.2], 90)
  );
  const outlierResult = calibrateFromSamples(withOutlier);
  assert.equal(outlierResult.ok, true);
  assert.deepEqual(outlierResult.origin, [0.1, 1.5, -0.2]);
  assert.ok(Math.abs(outlierResult.yaw - 90) < 1e-12);

  // Circular mean across +/-180 stays near -180, not 0.
  const wrapSamples = Array.from({ length: 8 }, (_, i) =>
    makeSample(i * 50, [0, 0, 0], i % 2 === 0 ? 178 : -178)
  );
  const wrapResult = calibrateFromSamples(wrapSamples);
  assert.equal(wrapResult.ok, true);
  assert.ok(Math.abs(wrap180(wrapResult.yaw - 180)) < 1e-12);

  // Earlier moving samples outside trailing 500ms window are ignored once stabilized.
  const mixed = [
    makeSample(0, [2, 1.5, 2], 0),
    makeSample(100, [1, 1.5, 1], 45),
    ...Array.from({ length: 8 }, (_, i) => makeSample(700 + i * 50, [0.25, 1.4, -0.3], -45)),
  ];
  const trailing = calibrateFromSamples(mixed, 500);
  assert.equal(trailing.ok, true);
  assert.deepEqual(trailing.origin, [0.25, 1.4, -0.3]);
  assert.ok(Math.abs(trailing.yaw - -45) < 1e-12);

  // Idempotence: calibrating again at the resulting pose yields identical origin and yaw.
  const secondSamples = Array.from({ length: 8 }, (_, i) =>
    makeSample(2000 + i * 50, trailing.origin, trailing.yaw)
  );
  const second = calibrateFromSamples(secondSamples);
  assert.equal(second.ok, true);
  assert.deepEqual(second.origin, trailing.origin);
  assert.ok(Math.abs(wrap180(second.yaw - trailing.yaw)) < 1e-12);
});

test('gameplayHeadPose computes signs, posture bounds, excess, outOfBounds, and sim scaling', () => {
  const origin = [1, 1.4, -0.5];
  const cal180 = { ...DEFAULT_CALIBRATION, origin, yaw: 180, posture: 'standing' };
  const atOrigin = gameplayHeadPose(cal180, makeSample(0, origin, 180));
  assert.equal(atOrigin.lateral, 0);
  assert.equal(atOrigin.vertical, 0);
  assert.equal(atOrigin.forward, 0);
  assert.equal(atOrigin.yawRelative, 0);
  assert.equal(atOrigin.clamped, false);
  assert.equal(atOrigin.excess, 0);
  assert.equal(atOrigin.outOfBounds, false);
  assert.deepEqual(atOrigin.sim, { lateral: 0, vertical: 0, forward: 0 });

  // Under yaw=180 (-Z forward), +X is user's right (+lateral), -Z is +forward.
  const leanRightForward180 = gameplayHeadPose(
    cal180,
    makeSample(10, [origin[0] + 0.12, origin[1] - 0.2, origin[2] - 0.1], 160)
  );
  assert.ok(Math.abs(leanRightForward180.lateral - 0.12) < 1e-12);
  assert.ok(Math.abs(leanRightForward180.vertical - -0.2) < 1e-12);
  assert.ok(Math.abs(leanRightForward180.forward - 0.1) < 1e-12);
  assert.ok(Math.abs(leanRightForward180.yawRelative - -20) < 1e-12);
  assert.equal(leanRightForward180.clamped, false);
  assert.ok(Math.abs(leanRightForward180.sim.lateral - 0.12 / QUEST_WORLD_SCALE) < 1e-12);
  assert.ok(Math.abs(leanRightForward180.sim.vertical - -0.2 / QUEST_WORLD_SCALE) < 1e-12);
  assert.ok(Math.abs(leanRightForward180.sim.forward - 0.1 / QUEST_WORLD_SCALE) < 1e-12);

  // Under yaw=90 (+X forward), +Z is user's right (+lateral), +X is +forward.
  const cal90 = { ...DEFAULT_CALIBRATION, origin, yaw: 90, posture: 'standing' };
  const leanRight90 = gameplayHeadPose(
    cal90,
    makeSample(20, [origin[0] + 0.15, origin[1], origin[2] + 0.2], 100)
  );
  assert.ok(Math.abs(leanRight90.lateral - 0.2) < 1e-12);
  assert.ok(Math.abs(leanRight90.forward - 0.15) < 1e-12);
  assert.ok(Math.abs(leanRight90.yawRelative - 10) < 1e-12);

  // Clamping in standing vs seated.
  const crouchStanding = gameplayHeadPose(
    cal180,
    makeSample(30, [origin[0] + 0.5, origin[1] - 0.4, origin[2] - 0.3], 180)
  );
  assert.equal(crouchStanding.lateral, QUEST_HEAD_BOUNDS.standing.lateral);
  assert.ok(Math.abs(crouchStanding.vertical - -0.4) < 1e-12);
  assert.equal(crouchStanding.forward, QUEST_HEAD_BOUNDS.standing.forward);
  assert.equal(crouchStanding.clamped, true);
  assert.ok(Math.abs(crouchStanding.excess - Math.hypot(0.2, 0, 0.1)) < 1e-12);
  assert.equal(crouchStanding.outOfBounds, false);

  const calSeated = { ...cal180, posture: 'seated' };
  const crouchSeated = gameplayHeadPose(
    calSeated,
    makeSample(40, [origin[0] - 0.4, origin[1] - 0.4, origin[2] + 0.3], 180)
  );
  assert.equal(crouchSeated.lateral, -QUEST_HEAD_BOUNDS.seated.lateral);
  assert.equal(crouchSeated.vertical, -QUEST_HEAD_BOUNDS.seated.crouch);
  assert.equal(crouchSeated.forward, -QUEST_HEAD_BOUNDS.seated.back);
  assert.equal(crouchSeated.clamped, true);
  assert.ok(Math.abs(crouchSeated.excess - Math.hypot(0.15, 0.15, 0.1)) < 1e-12);
  assert.equal(crouchSeated.outOfBounds, false);

  // Out of bounds when excess > QUEST_OUT_OF_BOUNDS_EXCESS (0.30).
  const walkPast = gameplayHeadPose(
    cal180,
    makeSample(
      50,
      [
        origin[0] + QUEST_HEAD_BOUNDS.standing.lateral + QUEST_OUT_OF_BOUNDS_EXCESS + 0.05,
        origin[1],
        origin[2],
      ],
      180
    )
  );
  assert.equal(walkPast.clamped, true);
  assert.ok(walkPast.excess > QUEST_OUT_OF_BOUNDS_EXCESS);
  assert.equal(walkPast.outOfBounds, true);
});

test('stance marker is centered under the calibrated eye, not the fighter feet', () => {
  const blue = { x: -ARENA_RULES.spawn, z: 0, yaw: 90 };
  const marker = stanceMarkerRingLocal(blue);
  const eye = eyeRingLocal(blue);
  assert.equal(marker[0], eye[0]);
  assert.equal(marker[2], eye[2]);
  assert.equal(marker[1], ARENA_LAYOUT.floorHeight);
  // The eye sits ROBOT_EYE_MODEL z in front of the feet: 0.244 m in VR here.
  const feetToEye = Math.hypot(marker[0] - blue.x, marker[2] - blue.z) * QUEST_WORLD_SCALE;
  assert.ok(Math.abs(feetToEye - ROBOT_EYE_MODEL[2] * ARENA_LAYOUT.fighterScale * 16) < 1e-9);
  assert.ok(Math.abs(feetToEye - 0.2436) < 0.001);

  // Through any calibration, the marker lands directly below the head origin.
  for (const cal of [
    DEFAULT_CALIBRATION,
    { ...DEFAULT_CALIBRATION, origin: [0.4, 1.3, -0.2], yaw: 73, source: 'solo', entry: 1 },
  ]) {
    const rig = questRigTransform(cal, blue);
    const placed = applyRig(rig, marker);
    assert.ok(Math.abs(placed[0] - cal.origin[0]) < 1e-9);
    assert.ok(Math.abs(placed[2] - cal.origin[2]) < 1e-9);
    assert.ok(placed[1] < cal.origin[1] - 1.3);
    const feet = applyRig(rig, [blue.x, ARENA_LAYOUT.floorHeight, blue.z]);
    assert.ok(Math.hypot(feet[0] - cal.origin[0], feet[2] - cal.origin[2]) > 0.24);
  }
});

test('headStep and isReferenceDiscontinuity separate real head motion from frame jumps', () => {
  const frame = 1000 / 72;
  const at = (t, position, yaw, pitch = 0) => makeSample(t, position, yaw, pitch);

  // A 0.2 m lean over 300 ms, frame by frame, never counts.
  for (let i = 1; i <= 22; i += 1) {
    const prev = at((i - 1) * frame, [0, 1.4, -(i - 1) * (0.2 / 22)], 180);
    const next = at(i * frame, [0, 1.4, -i * (0.2 / 22)], 180);
    assert.equal(isReferenceDiscontinuity(headStep(prev, next)), false);
  }
  // A fast 400 deg/s head turn and a 3 m/s duck in one frame do not count.
  assert.equal(
    isReferenceDiscontinuity(headStep(at(0, [0, 1.4, 0], 180), at(frame, [0, 1.4, 0], 174.4))),
    false
  );
  assert.equal(
    isReferenceDiscontinuity(headStep(at(0, [0, 1.4, 0], 180), at(frame, [0, 1.358, 0], 180))),
    false
  );
  // A whole 0.2 m lean dropped into a single frame is still below the floor.
  assert.equal(
    isReferenceDiscontinuity(headStep(at(0, [0, 1.4, 0], 180), at(frame, [0.2, 1.4, 0], 180))),
    false
  );
  // Recenter-like steps in one frame count: position alone, or yaw alone.
  assert.equal(
    isReferenceDiscontinuity(headStep(at(0, [0.5, 1.4, 0.3], 180), at(frame, [0, 1.4, 0], 180))),
    true
  );
  assert.equal(
    isReferenceDiscontinuity(headStep(at(0, [0, 1.4, 0], 70), at(frame, [0, 1.4, 0], 180))),
    true
  );
  // The bound grows with dt, and anything slower than the max dt is real motion.
  const slow = REFERENCE_JUMP_MAX_DT_MS;
  assert.equal(
    isReferenceDiscontinuity(headStep(at(0, [0, 1.4, 0], 180), at(slow, [0, 1.4, 0], 130))),
    false
  );
  assert.equal(
    isReferenceDiscontinuity(headStep(at(0, [0, 1.4, 0], 180), at(slow + 1, [3, 1.4, 0], 0))),
    false
  );
  assert.equal(
    isReferenceDiscontinuity(headStep(at(0, [0, 1.4, 0], 180), at(0, [3, 1.4, 0], 0))),
    false
  );
  // Looking straight down has no yaw: only position can count.
  const down = headStep(at(0, [0, 1.4, 0], 180, -89), at(frame, [0, 1.4, 0], 0, -89));
  assert.equal(down.yawDelta, null);
  assert.equal(isReferenceDiscontinuity(down), false);
});

test('system calibration keeps the calibrated origin/yaw contract identical to solo calibration', () => {
  const cal = {
    ...DEFAULT_CALIBRATION,
    origin: [0.3, 1.25, -0.4],
    yaw: 140,
    posture: 'seated',
    source: 'system',
    entry: 2,
  };
  const atOrigin = makeSample(1000, [0.3, 1.25, -0.4], 140, -10, 4);
  const pose = gameplayHeadPose(cal, atOrigin);
  assert.equal(pose.clamped, false);
  for (const key of ['lateral', 'vertical', 'forward', 'yawRelative']) {
    assert.ok(Math.abs(pose[key]) < 1e-9, key);
  }
});
