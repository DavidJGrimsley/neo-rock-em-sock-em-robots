const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { forward } = require('../src/features/arena-fighter/arena-combat-motion.ts');
const {
  DEFAULT_CALIBRATION,
  gameplayHeadPose,
} = require('../src/features/quest-vr/quest-head-rig.ts');
const {
  QUEST_INPUT_FLOATS_PER_HAND,
  QUEST_INPUT_FLOATS_PER_SAMPLE,
  QUEST_INPUT_INTS_PER_HAND,
  QUEST_INPUT_INTS_PER_SAMPLE,
  QUEST_INPUT_VERSION,
  decodeBatch,
} = require('../src/features/quest-vr/quest-input.ts');
const {
  QUEST_ARENA_RULES,
  createQuestArenaSession,
} = require('../src/features/quest-vr/quest-arena-session.ts');
const { createQuestHeadTracker } = require('../src/features/quest-vr/quest-head-tracker.ts');
const { ARENA_RULES } = require('../src/features/arena-fighter/arena-controller.ts');
const {
  placeQuestFirstPersonArms,
} = require('../src/features/quest-vr/quest-first-person-arms.ts');
const {
  QUEST_INPUT_STALE_NS,
  createQuestInputSource,
} = require('../src/features/quest-vr/quest-input-source.ts');
const {
  DEFAULT_QUEST_GESTURE_FRAME,
  PROVISIONAL_QUEST_GESTURE_THRESHOLDS,
  QUEST_GESTURE_THRESHOLD_BASIS,
  createQuestGestureClassifier,
  questGestureBodyPoint,
} = require('../src/features/quest-vr/quest-gesture.ts');

const root = path.join(__dirname, '..');
const fixturePath = path.join(
  root,
  'tests',
  'fixtures',
  'quest-gesture',
  'synthetic-gestures.json'
);
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const corpus = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

function lerp(a, b, t) {
  return a.map((value, index) => value + (b[index] - value) * t);
}

function segmentAt(keys, n) {
  let index = 0;
  while (index < keys.length - 1 && keys[index + 1].n < n) index += 1;
  const start = keys[index];
  const end = keys[Math.min(index + 1, keys.length - 1)];
  const span = end.n - start.n;
  const t = span <= 0 ? 0 : Math.min(1, Math.max(0, (n - start.n) / span));
  return { start, end, t };
}

function handSample(hand, position, tracking, trigger, angular, linear) {
  const lost = tracking === 'lost';
  const tracked = tracking === 'tracked';
  return {
    hand,
    locateOk: !lost,
    poseActive: !lost,
    positionValid: !lost && !!position,
    positionTracked: tracked && !!position,
    orientationValid: !lost,
    orientationTracked: tracked,
    position: lost ? null : position,
    orientation: lost ? null : [0, 0, 0, 1],
    linearVelocity: lost ? null : linear,
    angularVelocity: lost ? null : angular,
    tracking,
    thumbstick: { x: 0, y: 0, active: true },
    trigger: { value: trigger, active: true },
    squeeze: { value: 0, active: true },
    buttons: { primary: trigger > 0, secondary: false, menu: null },
  };
}

function expand(def) {
  const dt = def.dtNs ?? 20_000_000;
  const end = def.keys[def.keys.length - 1].n;
  const observations = [];
  let previousNs = null;
  for (let n = 0; n <= end; n += 1) {
    const { start, end: stop, t } = segmentAt(def.keys, n);
    const event = def.events?.[String(n)] ?? {};
    const left = lerp(start.left ?? def.left, stop.left ?? start.left ?? def.left, t);
    const right = lerp(start.right, stop.right, t);
    let capturedNs = Object.hasOwn(event, 'capturedNs')
      ? event.capturedNs
      : Object.hasOwn(start, 'capturedNs') && n === start.n
        ? start.capturedNs
        : Object.hasOwn(stop, 'capturedNs') && n === stop.n
          ? stop.capturedNs
          : (n + 1) * dt;
    if (capturedNs === 'repeat') capturedNs = previousNs;
    const rightTracking = event.rightTracking ?? def.rightTracking ?? 'tracked';
    const leftTracking = event.leftTracking ?? def.leftTracking ?? 'tracked';
    const trigger = n >= (def.triggerFrom ?? Infinity) ? 1 : 0;
    const angular = event.angular ?? def.angular ?? [0, 0, 0];
    const linear = event.linear ?? def.linear ?? [0, 0, 0];
    const headPosition =
      event.head ?? (n === start.n ? start.head : null) ?? (n === stop.n ? stop.head : null);
    const head =
      headPosition ??
      (start.head && stop.head ? lerp(start.head, stop.head, t) : (def.head ?? null));
    let status = def.status ?? 'live';
    if (def.liveFrom != null) status = n < def.liveFrom ? (def.status ?? 'stale') : 'live';
    if (event.status) status = event.status;
    const sample = {
      seq: n + 1,
      generation: n >= (def.generationFrom ?? Infinity) ? 2 : (def.generation ?? 1),
      refEpoch: n >= (def.refEpochFrom ?? Infinity) ? 5 : (def.refEpoch ?? 0),
      displayTimeNs: 50_000_000_000 - capturedNs,
      capturedNs,
      syncResult: 0,
      sessionState: (event.focused ?? def.focused ?? true) ? 5 : 4,
      focused: event.focused ?? def.focused ?? true,
      actionsReady: event.actionsReady ?? def.actionsReady ?? true,
      left: handSample('left', left, leftTracking, 0, [0, 0, 0], [0, 0, 0]),
      right: handSample('right', right, rightTracking, trigger, angular, linear),
    };
    observations.push({
      status,
      calibration: def.calibration ?? null,
      head: head ? { t: n, position: head, forward: [0, 0, -1], up: [0, 1, 0] } : null,
      sample,
    });
    previousNs = capturedNs;
  }
  return observations;
}

function roundM(value) {
  return Math.round(value * 1e6) / 1e6;
}

function project(intent) {
  if (intent.type === 'punch' || intent.type === 'uppercut') {
    return { type: intent.type, hand: intent.hand };
  }
  if (intent.type === 'guard') return { type: 'guard', held: intent.held };
  return {
    type: 'head',
    duck: intent.duck,
    weave: intent.weave,
    verticalM: roundM(intent.verticalM),
    lateralM: roundM(intent.lateralM),
    clamped: intent.clamped,
    outOfBounds: intent.outOfBounds,
  };
}

function along(frame, from, to) {
  const axis = forward(frame.yaw);
  return (to[0] - from[0]) * axis.x + (to[2] - from[2]) * axis.z;
}

function alongExtents(frame, observations, hand) {
  const positions = observations
    .map((observation) => observation.sample[hand].position)
    .filter(Boolean);
  const origin = positions[0];
  let highest = -Infinity;
  let lowest = Infinity;
  for (const position of positions) {
    const value = along(frame, origin, position);
    highest = Math.max(highest, value);
    lowest = Math.min(lowest, value);
  }
  return { highest, lowest };
}

function runCase(def, overrides = {}) {
  const observations = expand(def);
  const classifier = createQuestGestureClassifier({
    frame: overrides.frame ?? def.frame,
    hands: overrides.hands ?? def.hands,
    thresholds: overrides.thresholds ?? def.thresholds,
  });
  const intents = [];
  for (const observation of observations) intents.push(...classifier.push(observation));
  return { observations, classifier, intents };
}

function packBatch(samples) {
  const ints = [];
  const floats = [];
  for (const sample of samples) {
    ints.push(
      sample.syncResult,
      sample.sessionState,
      sample.actionsReady ? 1 : 0,
      sample.generation,
      sample.refEpoch
    );
    for (const hand of [sample.left, sample.right]) {
      const location =
        (hand.orientationValid ? 0x1 : 0) |
        (hand.positionValid ? 0x2 : 0) |
        (hand.orientationTracked ? 0x4 : 0) |
        (hand.positionTracked ? 0x8 : 0);
      ints.push(hand.locateOk ? 0 : -1, location, 0, hand.poseActive ? 1 : 0, 0);
    }
    for (const hand of [sample.left, sample.right]) {
      const position = hand.position ?? [0, 0, 0];
      const orientation = hand.orientation ?? [0, 0, 0, 1];
      floats.push(...position, ...orientation, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
  }
  return {
    available: true,
    version: QUEST_INPUT_VERSION,
    generation: samples[0].generation,
    live: true,
    actionsReady: true,
    latestSeq: samples.at(-1).seq,
    oldestSeq: samples[0].seq,
    published: samples.length,
    framesWithoutInput: 0,
    rejected: 0,
    nowNs: samples.at(-1).capturedNs + 2_000_000,
    capacity: 64,
    count: samples.length,
    seq: samples.map((sample) => sample.seq),
    displayTimeNs: samples.map((sample) => sample.displayTimeNs),
    capturedNs: samples.map((sample) => sample.capturedNs),
    ints,
    floats,
  };
}

test('synthetic corpus is labeled and every scenario survives the capture clock', () => {
  assert.equal(corpus.source, 'synthetic');
  assert.equal(corpus.measured, false);
  assert.equal(QUEST_GESTURE_THRESHOLD_BASIS, 'provisional-unmeasured');
  assert.equal(PROVISIONAL_QUEST_GESTURE_THRESHOLDS.punchForwardM > 0, true);
  const files = fs.readdirSync(path.dirname(fixturePath)).filter((file) => file.endsWith('.json'));
  assert.deepEqual(files, ['synthetic-gestures.json']);
  for (const def of corpus.cases) {
    const { observations, intents } = runCase(def);
    for (const observation of observations) {
      assert.equal(
        observation.sample.displayTimeNs + observation.sample.capturedNs,
        50_000_000_000,
        def.name
      );
    }
    if (def.oracle) {
      const { highest, lowest } = alongExtents(def.frame, observations, def.oracle.hand);
      if (def.oracle.minAlong != null) {
        assert.ok(highest >= def.oracle.minAlong, `${def.name} along ${highest}`);
      }
      if (def.oracle.maxAlong != null) {
        assert.ok(highest <= def.oracle.maxAlong, `${def.name} along ${highest}`);
      }
      if (def.oracle.retreatAlong != null) {
        assert.ok(lowest <= def.oracle.retreatAlong, `${def.name} retreat ${lowest}`);
      }
    }
    assert.deepEqual(intents.map(project), def.expect, def.name);
    for (const intent of intents) {
      assert.equal(Object.hasOwn(intent, 'displayTimeNs'), false, def.name);
      if (intent.type === 'punch' || intent.type === 'uppercut' || intent.type === 'guard') {
        assert.equal(Number.isSafeInteger(intent.capturedNs), true, def.name);
      }
      if (intent.type === 'head') assert.equal(Number.isFinite(intent.t), true, def.name);
      if (intent.type === 'uppercut') {
        assert.equal(
          intents.some((item) => item.type === 'punch' && item.hand === intent.hand),
          false
        );
      }
    }
    if (def.poseAfter) {
      const pose = runCase(def).classifier.snapshot().head;
      assert.ok(pose, def.name);
      assert.equal(pose.duck, def.poseAfter.duck, def.name);
      assert.equal(pose.weave, def.poseAfter.weave, def.name);
      assert.equal(roundM(pose.verticalM), def.poseAfter.verticalM, def.name);
      assert.equal(roundM(pose.lateralM), def.poseAfter.lateralM, def.name);
      assert.equal(pose.clamped, def.poseAfter.clamped, def.name);
      assert.equal(pose.outOfBounds, def.poseAfter.outOfBounds, def.name);
    }
  }
});

test('shrinking the authored punch below the provisional travel removes the intent', () => {
  const def = structuredClone(corpus.cases.find((item) => item.name.startsWith('yaw 180 punch')));
  def.keys[1].right = [0.2, 0.95, -0.35];
  def.keys[2].right = [0.2, 0.95, -0.35];
  const { intents } = runCase(def);
  assert.deepEqual(intents.map(project), []);
});

test('a stricter provisional punch travel rejects the same world trajectory', () => {
  const def = corpus.cases.find((item) => item.name.startsWith('yaw 180 punch'));
  const { intents } = runCase(def, { thresholds: { punchForwardM: 1 } });
  assert.deepEqual(intents.map(project), []);
});

test('a left-hand filter does not relabel or keep the right-hand punch', () => {
  const def = corpus.cases.find((item) => item.name.startsWith('yaw 180 punch'));
  const { intents } = runCase(def, { hands: 'left' });
  assert.deepEqual(intents.map(project), []);
});

test('the default frame is calibration yaw 180, so world +Z is not a punch', () => {
  assert.equal(DEFAULT_QUEST_GESTURE_FRAME.yaw, DEFAULT_CALIBRATION.yaw);
  const classifier = createQuestGestureClassifier();
  const rest = [0.2, 1, 0.3];
  const forwardZ = [0.2, 1, 0.52];
  const intents = [];
  for (let n = 0; n <= 7; n += 1) {
    const position = lerp(rest, forwardZ, n < 5 ? n / 5 : 1);
    intents.push(
      ...classifier.push({
        status: 'live',
        sample: {
          seq: n + 1,
          generation: 1,
          refEpoch: 0,
          displayTimeNs: n,
          capturedNs: (n + 1) * 20_000_000,
          syncResult: 0,
          sessionState: 5,
          focused: true,
          actionsReady: true,
          left: handSample('left', [-0.2, 1, 0.3], 'tracked', 0, [0, 0, 0], [0, 0, 0]),
          right: handSample('right', position, 'tracked', 0, [0, 0, 0], [0, 0, 0]),
        },
      })
    );
  }
  assert.deepEqual(intents, []);
  assert.ok(along(DEFAULT_QUEST_GESTURE_FRAME, rest, forwardZ) < -0.18);
});

test('body axes agree with gameplayHeadPose and arena forward()', () => {
  const frame = { yaw: 180, origin: [1, 2, -4] };
  const world = [1.05, 1.95, -4.08];
  const body = questGestureBodyPoint(world, frame);
  const pose = gameplayHeadPose(
    { ...DEFAULT_CALIBRATION, origin: frame.origin, yaw: frame.yaw, posture: 'standing' },
    { t: 0, position: world, forward: [0, 0, -1], up: [0, 1, 0] }
  );
  assert.ok(Math.abs(body.forward - pose.forward) < 1e-12);
  assert.ok(Math.abs(body.lateral - pose.lateral) < 1e-12);
  assert.ok(Math.abs(body.up - pose.vertical) < 1e-12);
  const axis = forward(frame.yaw);
  const moved = [world[0] + axis.x * 0.05, world[1], world[2] + axis.z * 0.05];
  const next = questGestureBodyPoint(moved, frame);
  assert.ok(Math.abs(next.forward - body.forward - 0.05) < 1e-12);
  assert.ok(Math.abs(next.lateral - body.lateral) < 1e-12);
});

test('decodeBatch drops a duplicate seq before classification and does not add a punch', () => {
  const def = corpus.cases.find((item) => item.name.startsWith('yaw 180 punch'));
  const observations = expand(def);
  const samples = observations.map((observation) => observation.sample);
  const duplicate = { ...samples[3], seq: samples[2].seq };
  const batch = packBatch([samples[0], samples[1], samples[2], duplicate, ...samples.slice(3)]);
  assert.equal(batch.ints.length, batch.count * QUEST_INPUT_INTS_PER_SAMPLE);
  assert.equal(batch.floats.length, batch.count * QUEST_INPUT_FLOATS_PER_SAMPLE);
  assert.equal(QUEST_INPUT_INTS_PER_HAND, 5);
  assert.equal(QUEST_INPUT_FLOATS_PER_HAND, 17);
  const decoded = decodeBatch(batch);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.invalid, 1);
  assert.equal(decoded.samples.length, samples.length);
  const classifier = createQuestGestureClassifier({ frame: def.frame });
  const intents = [];
  for (const sample of decoded.samples) {
    intents.push(...classifier.push({ status: 'live', sample }));
  }
  assert.deepEqual(intents.map(project), [{ type: 'punch', hand: 'right' }]);
});

test('an extra uppercutReady field cannot downgrade the attempt', () => {
  const def = corpus.cases.find((item) => item.name.startsWith('upward swing'));
  const { observations } = runCase(def);
  const classifier = createQuestGestureClassifier({ frame: def.frame });
  const intents = [];
  for (const observation of observations) {
    intents.push(...classifier.push({ ...observation, uppercutReady: false }));
  }
  assert.deepEqual(intents.map(project), [{ type: 'uppercut', hand: 'right' }]);
  assert.equal(
    intents.some((intent) => intent.type === 'punch'),
    false
  );
});

test('the classifier stays pure while Stage 06 QuestArenaSession wires grip combat and preserves phone AR rules', () => {
  const code = read('src/features/quest-vr/quest-gesture.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.equal(code.includes('uppercutReady'), false);
  assert.equal(code.includes('displayTimeNs'), false);
  assert.equal(code.includes('arena-match'), false);
  assert.equal(code.includes('arena-controller'), false);
  assert.equal(code.includes('quest-arena-session'), false);
  assert.equal(code.includes('quest-first-person-arms'), false);
  assert.equal(code.includes('cpuEnabled'), false);
  assert.equal(code.includes('sweptContact'), false);
  const session = read('src/features/quest-vr/quest-arena-session.ts');
  assert.equal(session.includes('quest-gesture.ts'), true);
  assert.equal(session.includes("poseSource: 'grip'"), true);
  assert.equal(session.includes('QUEST_STAGE_05_IDLE_OPPONENT_RULES'), false);
  assert.equal(QUEST_ARENA_RULES.separation, 0.065);
  assert.equal(QUEST_ARENA_RULES.reach, 0.095);
  assert.equal(QUEST_ARENA_RULES.boundary, 0.205);
  assert.equal(QUEST_ARENA_RULES.uppercutActiveEnd, 0.68);
  assert.equal(QUEST_ARENA_RULES.headEvasionEnabled, true);
  assert.equal(PROVISIONAL_QUEST_GESTURE_THRESHOLDS.maxSampleAgeNs, QUEST_INPUT_STALE_NS);
  const scene = read('src/features/quest-vr/quest-arena-scene.native.tsx');
  assert.match(
    scene,
    /session\.setInputState\(sample,\s*status,\s*batch,\s*input\.getLiveState\?\.\(\)\.nowNs\)/
  );
  assert.equal(ARENA_RULES.cpuEnabled, true);
  assert.equal(ARENA_RULES.headEvasionEnabled, false);
  assert.equal(ARENA_RULES.uppercutActiveEnd, 0.547);
  assert.equal(ARENA_RULES.uppercutWindow, 0.45);
  assert.equal(ARENA_RULES.guardStartup, 0.1);
  assert.equal(ARENA_RULES.punchRest, 0.6);
});

function gripPose(position, tracking = 'tracked') {
  const lost = tracking === 'lost';
  const tracked = tracking === 'tracked';
  return {
    locateOk: !lost,
    poseActive: !lost,
    positionValid: !lost && !!position,
    positionTracked: tracked && !!position,
    orientationValid: !lost,
    orientationTracked: tracked,
    position: lost ? null : position,
    orientation: lost ? null : [0, 0, 0, 1],
    linearVelocity: lost ? null : [0, 0, 0],
    angularVelocity: lost ? null : [0, 0, 0],
    tracking,
  };
}

function packGripBatch(samples) {
  const base = packBatch(samples);
  const gripInts = [];
  const gripFloats = [];
  for (const sample of samples) {
    for (const hand of [sample.left, sample.right]) {
      const g = hand.grip;
      const location =
        g && !g.locateOk
          ? 0
          : g
            ? (g.orientationValid ? 0x1 : 0) |
              (g.positionValid ? 0x2 : 0) |
              (g.orientationTracked ? 0x4 : 0) |
              (g.positionTracked ? 0x8 : 0)
            : 0;
      gripInts.push(g && g.locateOk ? 0 : -1, location, 0, g && g.poseActive ? 1 : 0);
      const pos = g?.position ?? [0, 0, 0];
      const ori = g?.orientation ?? [0, 0, 0, 1];
      gripFloats.push(...pos, ...ori, 0, 0, 0, 0, 0, 0);
    }
  }
  return { ...base, gripVersion: 1, gripInts, gripFloats };
}

test('poseSource grip classifies decoded 05B grip batches and never falls back to aim', () => {
  const def = corpus.cases.find((item) => item.name.startsWith('yaw 180 punch'));
  const observations = expand(def);
  const samples = observations.map((observation) => ({
    ...observation.sample,
    left: {
      ...observation.sample.left,
      position: [0, 0, 0],
      grip: gripPose(observation.sample.left.position, 'tracked'),
    },
    right: {
      ...observation.sample.right,
      position: [0, 0, 0],
      grip: gripPose(observation.sample.right.position, 'tracked'),
    },
  }));
  const decoded = decodeBatch(packGripBatch(samples));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.samples.length, samples.length);

  const gripClassifier = createQuestGestureClassifier({ frame: def.frame, poseSource: 'grip' });
  assert.equal(gripClassifier.poseSource, 'grip');
  assert.equal(gripClassifier.snapshot().poseSource, 'grip');

  const intents = [];
  for (const sample of decoded.samples) {
    intents.push(
      ...gripClassifier.push({
        status: 'live',
        sample,
        headRefEpoch: sample.refEpoch,
        nowNs: sample.capturedNs + 10_000_000,
      })
    );
  }
  assert.deepEqual(intents.map(project), [{ type: 'punch', hand: 'right' }]);

  const armsFrame = placeQuestFirstPersonArms({
    sample: decoded.samples[0],
    headRefEpoch: decoded.samples[0].refEpoch,
    poseSource: 'grip',
    nowNs: decoded.samples[0].capturedNs + 10_000_000,
  });
  assert.equal(armsFrame.combatCommand, null);
  assert.equal(armsFrame.right.visible, true);

  // Missing or untracked grip must not fall back to aim poses.
  const noFallback = createQuestGestureClassifier({ frame: def.frame, poseSource: 'grip' });
  const aimOnlyIntents = [];
  for (const observation of observations) {
    aimOnlyIntents.push(
      ...noFallback.push({
        status: 'live',
        sample: {
          ...observation.sample,
          right: { ...observation.sample.right, grip: null },
        },
        nowNs: observation.sample.capturedNs + 5_000_000,
      })
    );
  }
  assert.deepEqual(aimOnlyIntents, []);

  const inferredGrip = createQuestGestureClassifier({ frame: def.frame, poseSource: 'grip' });
  const inferredIntents = [];
  for (const observation of observations) {
    inferredIntents.push(
      ...inferredGrip.push({
        status: 'live',
        sample: {
          ...observation.sample,
          right: {
            ...observation.sample.right,
            grip: gripPose(observation.sample.right.position, 'inferred'),
          },
        },
        nowNs: observation.sample.capturedNs + 5_000_000,
      })
    );
  }
  assert.deepEqual(inferredIntents, []);
});

test('recentering, headRefEpoch mismatch, stale nowNs, and bad capturedNs drop continuity safely', () => {
  const guardDef = corpus.cases.find((item) =>
    item.name.startsWith('two still hands become guard')
  );
  const punchDef = corpus.cases.find((item) => item.name.startsWith('yaw 180 punch'));
  const guardObs = expand(guardDef).slice(0, 8);
  const punchObs = expand(punchDef);

  // 1. headRefEpoch mismatch drops guard and cancels open swing.
  const epochClassifier = createQuestGestureClassifier({ frame: guardDef.frame });
  const epochIntents = [];
  for (const obs of guardObs) {
    epochIntents.push(...epochClassifier.push({ ...obs, headRefEpoch: obs.sample.refEpoch }));
  }
  assert.deepEqual(epochIntents.map(project), [{ type: 'guard', held: true }]);
  const mismatchOut = epochClassifier.push({
    ...guardObs[7],
    sample: { ...guardObs[7].sample, capturedNs: 200_000_000 },
    headRefEpoch: 99,
  });
  assert.deepEqual(mismatchOut.map(project), [{ type: 'guard', held: false }]);

  const epochSwingClassifier = createQuestGestureClassifier({ frame: punchDef.frame });
  const epochSwingIntents = [];
  punchObs.forEach((obs, idx) => {
    epochSwingIntents.push(
      ...epochSwingClassifier.push({
        ...obs,
        headRefEpoch: idx === 3 ? 99 : obs.sample.refEpoch,
      })
    );
  });
  assert.deepEqual(epochSwingIntents, []);

  // 2. recentering=true drops guard, cancels open swing, suppresses head duck/weave, and re-arms hands.
  const recenterGuardClassifier = createQuestGestureClassifier({ frame: guardDef.frame });
  const recenterGuardIntents = [];
  for (const obs of guardObs) {
    recenterGuardIntents.push(...recenterGuardClassifier.push(obs));
  }
  assert.deepEqual(recenterGuardIntents.map(project), [{ type: 'guard', held: true }]);
  const recenterDropOut = recenterGuardClassifier.push({
    ...guardObs[7],
    sample: { ...guardObs[7].sample, capturedNs: 200_000_000 },
    recentering: true,
  });
  assert.deepEqual(recenterDropOut.map(project), [{ type: 'guard', held: false }]);

  const recenterClassifier = createQuestGestureClassifier({ frame: punchDef.frame });
  const recenterIntents = [];
  punchObs.forEach((obs, idx) => {
    recenterIntents.push(
      ...recenterClassifier.push({
        ...obs,
        recentering: idx === 3,
        calibration: {
          origin: [0, 1.6, 0],
          yaw: 180,
          posture: 'standing',
          source: 'default',
          entry: 0,
        },
        head:
          idx === 3
            ? { t: idx, position: [0, 0.8, 0], forward: [0, 0, -1], up: [0, 1, 0] }
            : { t: idx, position: [0, 1.6, 0], forward: [0, 0, -1], up: [0, 1, 0] },
      })
    );
  });
  assert.deepEqual(recenterIntents, []);

  // Post-strike unarmed hand is re-armed by recentering=true so a strike at a new shifted location still fires.
  const rearmAfterRecenter = createQuestGestureClassifier({ frame: punchDef.frame });
  const firstStrikeIntents = [];
  for (const obs of punchObs) {
    firstStrikeIntents.push(...rearmAfterRecenter.push(obs));
  }
  assert.deepEqual(firstStrikeIntents.map(project), [{ type: 'punch', hand: 'right' }]);
  const baseNs = punchObs.at(-1).sample.capturedNs;
  rearmAfterRecenter.push({
    ...punchObs[0],
    recentering: true,
    sample: { ...punchObs[0].sample, seq: 100, capturedNs: baseNs + 20_000_000 },
  });
  const shiftedIntents = [];
  punchObs.forEach((obs, idx) => {
    const shiftedPos = [
      obs.sample.right.position[0] + 0.6,
      obs.sample.right.position[1],
      obs.sample.right.position[2] - 0.8,
    ];
    shiftedIntents.push(
      ...rearmAfterRecenter.push({
        ...obs,
        sample: {
          ...obs.sample,
          seq: 101 + idx,
          capturedNs: baseNs + (idx + 2) * 20_000_000,
          right: { ...obs.sample.right, position: shiftedPos },
        },
      })
    );
  });
  assert.deepEqual(shiftedIntents.map(project), [{ type: 'punch', hand: 'right' }]);

  // 3. Stale nowNs, backward nowNs, NaN nowNs, or null nowNs in grip mode drops continuity and releases guard.
  const staleClassifier = createQuestGestureClassifier({
    frame: guardDef.frame,
    poseSource: 'grip',
  });
  const gripGuardObs = guardObs.map((obs) => ({
    ...obs,
    sample: {
      ...obs.sample,
      left: { ...obs.sample.left, grip: gripPose(obs.sample.left.position, 'tracked') },
      right: { ...obs.sample.right, grip: gripPose(obs.sample.right.position, 'tracked') },
    },
  }));
  const staleIntents = [];
  for (const obs of gripGuardObs) {
    staleIntents.push(
      ...staleClassifier.push({ ...obs, nowNs: obs.sample.capturedNs + 10_000_000 })
    );
  }
  assert.deepEqual(staleIntents.map(project), [{ type: 'guard', held: true }]);
  const nullNowOut = staleClassifier.push({ ...gripGuardObs[7], nowNs: null });
  assert.deepEqual(nullNowOut.map(project), [{ type: 'guard', held: false }]);

  for (const badNow of [
    (s) => s.capturedNs + QUEST_INPUT_STALE_NS + 1,
    (s) => s.capturedNs - 1,
    () => Number.NaN,
  ]) {
    const ageOut = createQuestGestureClassifier({ frame: punchDef.frame });
    const ageIntents = [];
    punchObs.forEach((obs, idx) => {
      ageIntents.push(
        ...ageOut.push({
          ...obs,
          nowNs: idx === 4 ? badNow(obs.sample) : obs.sample.capturedNs,
        })
      );
    });
    assert.deepEqual(ageIntents, []);
  }

  // 4. Non-finite or non-increasing capturedNs releases guard without NaN/regressed timestamps and does not poison dt.
  const badTsGuardClassifier = createQuestGestureClassifier({ frame: guardDef.frame });
  for (const obs of guardObs) badTsGuardClassifier.push(obs);
  const expectedGuardTs = guardObs.at(-1).sample.capturedNs;
  const nanGuardDrop = badTsGuardClassifier.push({
    ...guardObs[7],
    sample: { ...guardObs[7].sample, capturedNs: Number.NaN },
  });
  assert.deepEqual(nanGuardDrop, [{ type: 'guard', held: false, capturedNs: expectedGuardTs }]);

  const backTsGuardClassifier = createQuestGestureClassifier({ frame: guardDef.frame });
  for (const obs of guardObs) backTsGuardClassifier.push(obs);
  const backGuardDrop = backTsGuardClassifier.push({
    ...guardObs[7],
    sample: { ...guardObs[7].sample, capturedNs: 1000 },
  });
  assert.deepEqual(backGuardDrop, [{ type: 'guard', held: false, capturedNs: expectedGuardTs }]);

  // A backward timestamp mid-stream must not poison the next valid sample's dtNs into a subsequent swing.
  const cleanAfterBack = createQuestGestureClassifier({ frame: punchDef.frame });
  cleanAfterBack.push(punchObs[0]);
  cleanAfterBack.push({ ...punchObs[1], sample: { ...punchObs[1].sample, capturedNs: 1000 } });
  const postBackIntents = [];
  punchObs.forEach((obs, idx) => {
    postBackIntents.push(
      ...cleanAfterBack.push({
        ...obs,
        sample: {
          ...obs.sample,
          seq: 20 + idx,
          capturedNs: 1_000_000_000 + idx * 20_000_000,
        },
      })
    );
  });
  assert.deepEqual(postBackIntents.map(project), [{ type: 'punch', hand: 'right' }]);

  const mismatchHandClassifier = createQuestGestureClassifier({ frame: punchDef.frame });
  const mismatchHandIntents = [];
  for (const obs of punchObs) {
    mismatchHandIntents.push(
      ...mismatchHandClassifier.push({
        ...obs,
        sample: {
          ...obs.sample,
          right: { ...obs.sample.right, hand: 'left' },
        },
      })
    );
  }
  assert.deepEqual(mismatchHandIntents, []);

  // 5. setThresholds updates classifier.thresholds getter.
  const thresholdClassifier = createQuestGestureClassifier();
  thresholdClassifier.setThresholds({ punchForwardM: 0.42 });
  assert.equal(thresholdClassifier.thresholds.punchForwardM, 0.42);
});

function makeStage06Clock() {
  let timeMs = 1000;
  const frames = new Map();
  let nextId = 1;
  return {
    now: () => timeMs,
    clock: {
      now: () => timeMs,
      schedule: (cb) => {
        const id = nextId++;
        frames.set(id, cb);
        return id;
      },
      cancel: (id) => frames.delete(id),
      scheduleFrame: (cb) => {
        const id = nextId++;
        frames.set(id, cb);
        return id;
      },
      cancelFrame: (id) => frames.delete(id),
    },
    stepFrame(dtMs = 20) {
      timeMs += dtMs;
      const queued = [...frames.entries()];
      frames.clear();
      for (const [, cb] of queued) cb();
    },
  };
}

function makeGripCombatSample({
  seq,
  capturedNs,
  leftGripPos = [-0.2, 1.35, -0.1],
  rightGripPos = [0.2, 1.35, -0.1],
  leftGripTracking = 'tracked',
  rightGripTracking = 'tracked',
  refEpoch = 1,
  focused = true,
  actionsReady = true,
}) {
  return {
    seq,
    generation: 1,
    refEpoch,
    displayTimeNs: 50_000_000_000 - capturedNs,
    capturedNs,
    syncResult: 0,
    sessionState: focused ? 5 : 4,
    focused,
    actionsReady,
    left: {
      ...handSample('left', [0, 0, 0], 'tracked', 0, [0, 0, 0], [0, 0, 0]),
      grip: gripPose(leftGripPos, leftGripTracking),
    },
    right: {
      ...handSample('right', [0, 0, 0], 'tracked', 0, [0, 0, 0], [0, 0, 0]),
      grip: gripPose(rightGripPos, rightGripTracking),
    },
  };
}

function setupStage06EyesFight(rulesOverride) {
  const fc = makeStage06Clock();
  let refEpoch = 1;
  const tracker = createQuestHeadTracker({
    now: fc.now,
    schedule: fc.clock.schedule,
    cancel: fc.clock.cancel,
    entries: () => 1,
    refSpaceEpoch: () => refEpoch,
  });
  const feedHead = (position = [0, 1.5, 0], yawDeg = 180) => {
    const rad = (yawDeg * Math.PI) / 180;
    tracker.onCameraTransform({
      position,
      forward: [Math.sin(rad), 0, Math.cos(rad)],
      up: [0, 1, 0],
    });
  };
  for (let i = 0; i < 10; i++) {
    feedHead([0, 1.5, 0], 180);
    fc.stepFrame(20);
  }
  const session = createQuestArenaSession(fc.clock, tracker, rulesOverride);
  assert.equal(session.solo(), true);
  const open = session.getSnapshot();
  tracker.calibrateForSolo(open.transforms.blue);
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'arena');
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'blue');
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'red');
  assert.equal(session.ready().reason, 'started');
  for (let i = 0; i < 180; i++) {
    feedHead([0, 1.5, 0], 180);
    fc.stepFrame(25);
    if (
      session.getSnapshot().stage === 'fighting' &&
      session.getSnapshot().presentation === 'eyes'
    ) {
      break;
    }
  }
  assert.equal(session.getSnapshot().stage, 'fighting');
  assert.equal(session.getSnapshot().presentation, 'eyes');

  let seq = 1;
  let capturedNs = 1_000_000_000;
  const pushGrip = (opts = {}, status = 'live', ageNs = 5_000_000) => {
    seq += 1;
    capturedNs += 20_000_000;
    const sample = makeGripCombatSample({ seq, capturedNs, refEpoch, ...opts });
    const nowNs = ageNs === null ? null : capturedNs + ageNs;
    session.setInputState(sample, status, undefined, nowNs);
    return { sample, capturedNs, nowNs };
  };

  return {
    fc,
    tracker,
    session,
    feedHead,
    pushGrip,
    bumpEpoch() {
      refEpoch += 1;
      return refEpoch;
    },
  };
}

test('Stage 06 QuestArenaSession executes grip punches, preserves uppercut eligibility, blocks with grip guard, and ducks/weaves CPU attacks', () => {
  const ctx = setupStage06EyesFight({
    cpuEnabled: true,
    spawn: QUEST_ARENA_RULES.separation / 2,
    cpuFirstDelay: 100,
    cpuGuardReaction: 100,
    cpuReaction: 100,
    punchHitstop: 0,
    uppercutHitstop: 0,
    blockHitstop: 0,
  });
  const { fc, session, feedHead, pushGrip } = ctx;

  // Early upward swing before 3 connected punches stays an uppercut attempt and is rejected by ArenaMatch.
  const uppercutKeyPositions = [
    [0.2, 1.35, -0.25],
    [0.2, 1.42, -0.25],
    [0.2, 1.5, -0.25],
    [0.2, 1.56, -0.25],
    [0.2, 1.56, -0.25],
    [0.2, 1.35, -0.25],
  ];
  for (const pos of uppercutKeyPositions) {
    pushGrip({ rightGripPos: pos });
    fc.stepFrame(20);
  }
  assert.equal(session.getMatchSnapshot().red.health, 100);
  assert.equal(session.getMatchSnapshot().blue.punchProgress, 0);

  // Throw 3 deliberate grip punches (aim-only poses zeroed out to prove grip source is used).
  const punchKeyPositions = [
    [0.2, 1.35, -0.2],
    [0.2, 1.35, -0.2],
    [0.2, 1.35, -0.32],
    [0.2, 1.35, -0.44],
    [0.2, 1.35, -0.44],
    [0.2, 1.35, -0.2],
  ];
  for (let p = 0; p < 3; p++) {
    for (const pos of punchKeyPositions) {
      pushGrip({ rightGripPos: pos });
      fc.stepFrame(20);
    }
    for (let w = 0; w < 30; w++) {
      pushGrip({ rightGripPos: [0.2, 1.35, -0.2] });
      fc.stepFrame(20);
    }
  }
  assert.equal(session.getMatchSnapshot().red.health, 76);
  assert.equal(session.getMatchSnapshot().blue.punchProgress, 3);
  assert.equal(session.getMatchSnapshot().blue.uppercutReady, true);

  // Now an upward grip swing executes the earned Uppercut and launches Red at Quest separation!
  for (const pos of uppercutKeyPositions) {
    pushGrip({ rightGripPos: pos });
    fc.stepFrame(20);
  }
  for (let w = 0; w < 36; w++) {
    pushGrip({ rightGripPos: [0.2, 1.35, -0.25] });
    fc.stepFrame(20);
    if (session.getMatchSnapshot().red.mode === 'launch') break;
  }
  assert.equal(session.getMatchSnapshot().red.mode, 'launch');
  assert.equal(session.getMatchSnapshot().red.health, 61);

  // Wait for Red to land and recover.
  for (let w = 0; w < 80; w++) {
    pushGrip({ leftGripPos: [-0.2, 1.35, -0.1], rightGripPos: [0.2, 1.35, -0.1] });
    fc.stepFrame(20);
    if (session.getMatchSnapshot().red.mode === 'idle') break;
  }
  assert.equal(session.getMatchSnapshot().red.mode, 'idle');

  // Hold both grip hands still in the guard volume >= 120 ms + guardStartup (100 ms) -> holding, then drop hands to release.
  for (let g = 0; g < 20; g++) {
    pushGrip({ leftGripPos: [-0.15, 1.48, -0.3], rightGripPos: [0.15, 1.48, -0.3] });
    fc.stepFrame(20);
  }
  assert.equal(session.getMatchSnapshot().blue.guardHeld, true);
  assert.equal(session.getMatchSnapshot().blue.guardState, 'holding');

  pushGrip({ leftGripPos: [-0.2, 1.15, -0.1], rightGripPos: [0.2, 1.15, -0.1] });
  for (let r = 0; r < 10; r++) {
    pushGrip({ leftGripPos: [-0.2, 1.15, -0.1], rightGripPos: [0.2, 1.15, -0.1] });
    fc.stepFrame(20);
  }
  assert.equal(session.getMatchSnapshot().blue.guardHeld, false);
  assert.equal(session.getMatchSnapshot().blue.guardState, 'off');
  session.dispose();
  ctx.tracker.dispose();

  // Verify bounded duck & weave against live CPU punches in QuestArenaSession.
  // Move head smoothly (<=0.05m/20ms) so quest-head-tracker treats it as human motion, not a reference-space jump.
  const duckCtx = setupStage06EyesFight({
    cpuEnabled: true,
    spawn: QUEST_ARENA_RULES.separation / 2,
    cpuFirstDelay: 0.25,
    cpuRecovery: 0.2,
    punchHitstop: 0,
    uppercutHitstop: 0,
    blockHitstop: 0,
  });
  const moveHeadSmooth = (from, to, steps = 6) => {
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      duckCtx.feedHead(
        [
          from[0] + (to[0] - from[0]) * t,
          from[1] + (to[1] - from[1]) * t,
          from[2] + (to[2] - from[2]) * t,
        ],
        180
      );
      duckCtx.pushGrip({});
      duckCtx.fc.stepFrame(20);
    }
  };
  // Crouch smoothly to verticalM = -0.25 m as CPU throws its first punch -> evaded!
  moveHeadSmooth([0, 1.5, 0], [0, 1.25, 0], 6);
  assert.equal(duckCtx.session.isEvading(), true);
  let sawCpuPunch = false;
  for (let i = 0; i < 30; i++) {
    duckCtx.feedHead([0, 1.25, 0], 180);
    duckCtx.pushGrip({});
    duckCtx.fc.stepFrame(20);
    if (duckCtx.session.getMatchSnapshot().red.clip.startsWith('Combo_Punch')) {
      sawCpuPunch = true;
    }
  }
  assert.equal(sawCpuPunch, true);
  assert.equal(
    duckCtx.session.getMatchSnapshot().blue.health,
    100,
    'bounded duck evades early CPU punch'
  );

  // Holding duck past evadeDuration (0.75s) expires evasion so CPU eventually lands punches.
  for (let i = 0; i < 100; i++) {
    duckCtx.feedHead([0, 1.25, 0], 180);
    duckCtx.pushGrip({});
    duckCtx.fc.stepFrame(20);
    if (duckCtx.session.getMatchSnapshot().blue.health < 100) break;
  }
  assert.ok(
    duckCtx.session.getMatchSnapshot().blue.health < 100,
    'expired duck stops evading CPU punches'
  );
  assert.equal(duckCtx.session.isEvading(), false);

  // Returning upright > evadeCooldown re-arms lateral weave, and outOfBounds cancels it.
  moveHeadSmooth([0, 1.25, 0], [0, 1.5, 0], 6);
  for (let i = 0; i < 20; i++) {
    duckCtx.feedHead([0, 1.5, 0], 180);
    duckCtx.pushGrip({});
    duckCtx.fc.stepFrame(20);
  }
  moveHeadSmooth([0, 1.5, 0], [0.18, 1.5, 0], 4);
  assert.equal(duckCtx.session.isEvading(), true, 'in-bounds lateral weave activates');
  moveHeadSmooth([0.18, 1.5, 0], [0.8, 1.5, 0], 13);
  assert.equal(duckCtx.session.isEvading(), false, 'out-of-bounds head offset cancels evasion');

  // Upright guard blocks a live CPU punch with 0 health loss and chip to guardStamina.
  moveHeadSmooth([0.8, 1.5, 0], [0, 1.5, 0], 16);
  // Wait for any in-flight hitstun/recovery to settle before raising guard.
  for (let w = 0; w < 30; w++) {
    duckCtx.pushGrip({ leftGripPos: [-0.2, 1.35, -0.1], rightGripPos: [0.2, 1.35, -0.1] });
    duckCtx.fc.stepFrame(20);
    if (duckCtx.session.getMatchSnapshot().blue.canBlock) break;
  }
  const preGuardHealth = duckCtx.session.getMatchSnapshot().blue.health;
  const preGuardStamina = duckCtx.session.getMatchSnapshot().blue.guardStamina;
  let blockedCpuPunch = false;
  for (let g = 0; g < 120; g++) {
    duckCtx.feedHead([0, 1.5, 0], 180);
    duckCtx.pushGrip({ leftGripPos: [-0.15, 1.48, -0.3], rightGripPos: [0.15, 1.48, -0.3] });
    duckCtx.fc.stepFrame(20);
    if (duckCtx.session.getMatchSnapshot().blue.guardStamina < preGuardStamina) {
      blockedCpuPunch = true;
      break;
    }
  }
  assert.equal(blockedCpuPunch, true, 'live CPU punch hits guard and reduces guardStamina');
  assert.equal(duckCtx.session.getMatchSnapshot().blue.health, preGuardHealth);

  duckCtx.session.dispose();
  duckCtx.tracker.dispose();
});

test('Stage 06 QuestArenaSession neutralizes open swings, guard, and evasion on focus loss, tracking loss, stale nowNs, recenter, menuFocus, and pause', () => {
  const interruptions = [
    'unfocused',
    'staleStatus',
    'staleNowNs',
    'nullNowNs',
    'actionsNotReady',
    'bothHandsLost',
    'epochMismatch',
    'recenter',
    'menuFocus',
    'pause',
  ];

  const moveHeadSmooth = (ctx, from, to, steps = 6) => {
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      ctx.feedHead(
        [
          from[0] + (to[0] - from[0]) * t,
          from[1] + (to[1] - from[1]) * t,
          from[2] + (to[2] - from[2]) * t,
        ],
        180
      );
      ctx.pushGrip({});
      ctx.fc.stepFrame(20);
    }
  };

  // Positive control: uninterrupted [-0.2] -> [-0.35] -> [-0.45] -> [-0.45] fires a punch.
  {
    const ctrl = setupStage06EyesFight({
      cpuEnabled: false,
      spawn: QUEST_ARENA_RULES.separation / 2,
    });
    ctrl.pushGrip({ leftGripPos: [-0.2, 1.35, -0.1], rightGripPos: [0.2, 1.48, -0.2] });
    ctrl.fc.stepFrame(20);
    ctrl.pushGrip({ leftGripPos: [-0.2, 1.35, -0.1], rightGripPos: [0.2, 1.48, -0.35] });
    ctrl.fc.stepFrame(20);
    ctrl.pushGrip({ leftGripPos: [-0.2, 1.35, -0.1], rightGripPos: [0.2, 1.48, -0.45] });
    ctrl.fc.stepFrame(20);
    ctrl.pushGrip({ leftGripPos: [-0.2, 1.35, -0.1], rightGripPos: [0.2, 1.48, -0.45] });
    ctrl.fc.stepFrame(20);
    assert.equal(ctrl.session.getMatchSnapshot().blue.mode, 'attack');
    ctrl.session.dispose();
    ctrl.tracker.dispose();
  }

  for (const mode of interruptions) {
    const ctx = setupStage06EyesFight({
      cpuEnabled: false,
      spawn: QUEST_ARENA_RULES.separation / 2,
      punchHitstop: 0,
      uppercutHitstop: 0,
      blockHitstop: 0,
    });
    const { fc, session, feedHead, pushGrip } = ctx;

    const triggerInterruption = (overrideRightPos, headPos = [0, 1.5, 0]) => {
      if (mode === 'unfocused') {
        pushGrip(
          { focused: false, ...(overrideRightPos ? { rightGripPos: overrideRightPos } : {}) },
          'unfocused'
        );
      } else if (mode === 'staleStatus') {
        pushGrip(overrideRightPos ? { rightGripPos: overrideRightPos } : {}, 'stale');
      } else if (mode === 'staleNowNs') {
        pushGrip(
          overrideRightPos ? { rightGripPos: overrideRightPos } : {},
          'live',
          QUEST_INPUT_STALE_NS + 5_000_000
        );
      } else if (mode === 'nullNowNs') {
        pushGrip(overrideRightPos ? { rightGripPos: overrideRightPos } : {}, 'live', null);
      } else if (mode === 'actionsNotReady') {
        pushGrip({
          actionsReady: false,
          ...(overrideRightPos ? { rightGripPos: overrideRightPos } : {}),
        });
      } else if (mode === 'bothHandsLost') {
        pushGrip({ leftGripTracking: 'lost', rightGripTracking: 'lost' });
      } else if (mode === 'epochMismatch') {
        const nextEpoch = ctx.bumpEpoch();
        feedHead(headPos, 180);
        pushGrip({
          refEpoch: nextEpoch - 1,
          ...(overrideRightPos ? { rightGripPos: overrideRightPos } : {}),
        });
      } else if (mode === 'recenter') {
        ctx.bumpEpoch();
        feedHead(headPos, 180);
      } else if (mode === 'menuFocus') {
        session.setMenuFocus(true);
      } else if (mode === 'pause') {
        session.setAppActive(false);
      }
    };

    const recoverInterruption = (headPos = [0, 1.5, 0]) => {
      if (mode === 'menuFocus') session.setMenuFocus(false);
      if (mode === 'pause') {
        session.setAppActive(true);
        assert.equal(session.ready().reason, 'resumed');
        for (let i = 0; i < 180; i++) {
          feedHead(headPos, 180);
          fc.stepFrame(25);
          if (
            session.getSnapshot().stage === 'fighting' &&
            session.getSnapshot().presentation === 'eyes'
          ) {
            break;
          }
        }
      }
      feedHead(headPos, 180);
      pushGrip({});
      fc.stepFrame(20);
    };

    // 1. Guard interruption: hold guard until 'holding', interrupt, verify guard releases immediately.
    for (let g = 0; g < 20; g++) {
      pushGrip({ leftGripPos: [-0.15, 1.48, -0.3], rightGripPos: [0.15, 1.48, -0.3] });
      fc.stepFrame(20);
    }
    assert.equal(session.getMatchSnapshot().blue.guardHeld, true, `${mode}: guard raised`);
    triggerInterruption();
    if (mode !== 'pause') fc.stepFrame(20);
    assert.equal(
      session.getMatchSnapshot().blue.guardHeld,
      false,
      `${mode}: guard released immediately`
    );
    recoverInterruption();

    // 2. Evasion interruption: without guard held, smoothly duck, assert isEvading()===true, interrupt, assert false.
    pushGrip({ leftGripPos: [-0.2, 1.35, -0.1], rightGripPos: [0.2, 1.35, -0.1] });
    fc.stepFrame(20);
    moveHeadSmooth(ctx, [0, 1.5, 0], [0, 1.25, 0], 6);
    assert.equal(session.isEvading(), true, `${mode}: duck active before interruption`);
    triggerInterruption(undefined, [0, 1.25, 0]);
    if (mode !== 'pause') fc.stepFrame(20);
    assert.equal(session.isEvading(), false, `${mode}: evasion neutralized immediately`);
    moveHeadSmooth(ctx, [0, 1.25, 0], [0, 1.5, 0], 6);
    recoverInterruption([0, 1.5, 0]);

    // 3. Open-swing interruption: match the positive control trajectory [-0.2 -> -0.35 -> interrupt at -0.45],
    //    then settle at -0.45 after recovery -> must NOT fire a punch.
    pushGrip({ leftGripPos: [-0.2, 1.35, -0.1], rightGripPos: [0.2, 1.48, -0.2] });
    fc.stepFrame(20);
    pushGrip({ leftGripPos: [-0.2, 1.35, -0.1], rightGripPos: [0.2, 1.48, -0.35] });
    fc.stepFrame(20);
    triggerInterruption([0.2, 1.48, -0.45], [0, 1.5, 0]);
    if (mode === 'menuFocus') session.setMenuFocus(false);
    if (mode === 'pause') {
      session.setAppActive(true);
      session.ready();
      for (let i = 0; i < 180; i++) {
        feedHead([0, 1.5, 0], 180);
        fc.stepFrame(25);
        if (
          session.getSnapshot().stage === 'fighting' &&
          session.getSnapshot().presentation === 'eyes'
        ) {
          break;
        }
      }
    }
    pushGrip({ leftGripPos: [-0.2, 1.35, -0.1], rightGripPos: [0.2, 1.48, -0.45] });
    fc.stepFrame(20);
    pushGrip({ leftGripPos: [-0.2, 1.35, -0.1], rightGripPos: [0.2, 1.48, -0.45] });
    fc.stepFrame(20);
    assert.notEqual(
      session.getMatchSnapshot().blue.mode,
      'attack',
      `${mode}: interrupted swing cannot fire on recovery`
    );
    assert.equal(session.getMatchSnapshot().red.health, 100);

    session.dispose();
    ctx.tracker.dispose();
  }
});

test('Stage 06 QuestArenaSession integrates with 72 Hz createQuestInputSource (11 ms idle polls) for sustained guard, punch, and uppercut', () => {
  const fc = makeStage06Clock();
  const tracker = createQuestHeadTracker({
    now: fc.now,
    schedule: fc.clock.schedule,
    cancel: fc.clock.cancel,
    entries: () => 1,
    refSpaceEpoch: () => 1,
  });
  const feedHead = (pos = [0, 1.5, 0]) =>
    tracker.onCameraTransform({ position: pos, forward: [0, 0, -1], up: [0, 1, 0] });
  for (let i = 0; i < 10; i++) {
    feedHead([0, 1.5, 0]);
    fc.stepFrame(20);
  }

  let ring = [];
  let publishedCount = 0;
  let seq = 0;
  const captureNsBase = 5_000_000_000;
  const startMs = fc.now();
  const currentNowNs = () => captureNsBase + (fc.now() - startMs) * 1_000_000;
  const pushNativeSample = (leftGripPos, rightGripPos) => {
    seq += 1;
    publishedCount += 1;
    const sample = makeGripCombatSample({
      seq,
      capturedNs: currentNowNs(),
      refEpoch: 1,
      leftGripPos,
      rightGripPos,
    });
    ring.push(sample);
    if (ring.length > 64) ring.shift();
  };

  const reader = {
    read(afterSeq) {
      const fresh = ring.filter((s) => s.seq > afterSeq);
      const packed = packGripBatch(fresh.length ? fresh : ring.slice(-1));
      return {
        ...packed,
        published: publishedCount,
        latestSeq: seq,
        oldestSeq: ring[0]?.seq ?? 0,
        nowNs: currentNowNs(),
        count: fresh.length,
        seq: fresh.map((s) => s.seq),
        displayTimeNs: fresh.map((s) => s.displayTimeNs),
        capturedNs: fresh.map((s) => s.capturedNs),
        ints: fresh.length ? packed.ints : [],
        floats: fresh.length ? packed.floats : [],
        gripInts: fresh.length ? packed.gripInts : [],
        gripFloats: fresh.length ? packed.gripFloats : [],
      };
    },
  };

  const input = createQuestInputSource({
    reader,
    now: fc.now,
    schedule: fc.clock.schedule,
    cancel: fc.clock.cancel,
  });
  const session = createQuestArenaSession(fc.clock, tracker, {
    cpuEnabled: true,
    spawn: QUEST_ARENA_RULES.separation / 2,
    cpuFirstDelay: 100,
    cpuGuardReaction: 100,
    cpuReaction: 100,
    punchHitstop: 0,
    uppercutHitstop: 0,
    blockHitstop: 0,
  });
  pushNativeSample([-0.2, 1.35, -0.1], [0.2, 1.35, -0.1]);
  const stopInput = input.onSample((sample, status, batch) =>
    session.setInputState(sample, status, batch, input.getLiveState().nowNs)
  );
  input.start();
  assert.equal(session.solo(), true);
  const open = session.getSnapshot();
  tracker.calibrateForSolo(open.transforms.blue);
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'arena');
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'blue');
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'red');
  assert.equal(session.ready().reason, 'started');

  const step72HzLoop = (durationMs, poseAtStep) => {
    const endAt = fc.now() + durationMs;
    let next72HzAt = fc.now();
    let frameIndex = 0;
    while (fc.now() < endAt) {
      if (fc.now() >= next72HzAt) {
        const [leftPos, rightPos] = poseAtStep(frameIndex++);
        pushNativeSample(leftPos, rightPos);
        next72HzAt += 1000 / 72;
      }
      feedHead([0, 1.5, 0]);
      fc.stepFrame(11);
    }
  };

  for (let i = 0; i < 300; i++) {
    pushNativeSample([-0.2, 1.35, -0.1], [0.2, 1.35, -0.1]);
    feedHead([0, 1.5, 0]);
    fc.stepFrame(14);
    if (
      session.getSnapshot().stage === 'fighting' &&
      session.getSnapshot().presentation === 'eyes'
    ) {
      break;
    }
  }
  assert.equal(session.getSnapshot().stage, 'fighting');
  assert.equal(session.getSnapshot().presentation, 'eyes');

  // 1. Sustained guard > 550 ms at 72 Hz despite 11 ms idle polls.
  let guardDroppedAfterHold = false;
  let reachedHolding = false;
  const holdStartMs = fc.now();
  step72HzLoop(650, () => {
    const blue = session.getMatchSnapshot().blue;
    if (blue.guardState === 'holding') reachedHolding = true;
    if (fc.now() - holdStartMs >= 260 && (!blue.guardHeld || blue.guardState !== 'holding')) {
      guardDroppedAfterHold = true;
    }
    return [
      [-0.15, 1.48, -0.3],
      [0.15, 1.48, -0.3],
    ];
  });
  assert.equal(reachedHolding, true);
  assert.equal(guardDroppedAfterHold, false);

  // Release guard and pause briefly at rest.
  step72HzLoop(160, () => [
    [-0.2, 1.35, -0.2],
    [0.2, 1.35, -0.2],
  ]);
  assert.equal(session.getMatchSnapshot().blue.guardHeld, false);

  // 2. Throw 3 grip punches across interleaved 11 ms idle polls.
  const punchPath = [
    [0.2, 1.35, -0.2],
    [0.2, 1.35, -0.3],
    [0.2, 1.35, -0.44],
    [0.2, 1.35, -0.44],
    [0.2, 1.35, -0.44],
    [0.2, 1.35, -0.2],
  ];
  for (let p = 0; p < 3; p++) {
    step72HzLoop(110, (idx) => [
      [-0.2, 1.35, -0.2],
      punchPath[Math.min(idx, punchPath.length - 1)],
    ]);
    step72HzLoop(620, () => [
      [-0.2, 1.35, -0.2],
      [0.2, 1.35, -0.2],
    ]);
  }
  assert.equal(session.getMatchSnapshot().red.health, 76);
  assert.equal(session.getMatchSnapshot().blue.uppercutReady, true);

  // 3. Upward grip uppercut across interleaved 11 ms idle polls launches Red.
  const uppercutPath = [
    [0.2, 1.35, -0.25],
    [0.2, 1.44, -0.25],
    [0.2, 1.56, -0.25],
    [0.2, 1.56, -0.25],
    [0.2, 1.56, -0.25],
    [0.2, 1.35, -0.25],
  ];
  step72HzLoop(110, (idx) => [
    [-0.2, 1.35, -0.2],
    uppercutPath[Math.min(idx, uppercutPath.length - 1)],
  ]);
  step72HzLoop(700, () => [
    [-0.2, 1.35, -0.2],
    [0.2, 1.35, -0.2],
  ]);
  assert.equal(session.getMatchSnapshot().red.mode, 'launch');

  stopInput();
  input.stop();
  session.dispose();
  tracker.dispose();
});

test('Stage 06 QuestArenaSession requires physical hand exit after guard-exhausted break and deduplicates block-up across large invalid batches', () => {
  const ctx = setupStage06EyesFight({
    cpuEnabled: true,
    spawn: QUEST_ARENA_RULES.separation / 2,
    cpuFirstDelay: 0.05,
    cpuRecovery: 1.5,
    guardPunchCost: 95,
    punchHitstop: 0,
    uppercutHitstop: 0,
    blockHitstop: 0,
  });
  const { fc, session, pushGrip } = ctx;

  // Hold hands inside guard volume until CPU breaks guard ('exhausted').
  let sawExhausted = false;
  for (let i = 0; i < 200; i++) {
    ctx.feedHead([0, 1.5, 0], 180);
    pushGrip({ leftGripPos: [-0.15, 1.48, -0.3], rightGripPos: [0.15, 1.48, -0.3] });
    fc.stepFrame(20);
    if (session.getMatchSnapshot().blue.guardState === 'exhausted') {
      sawExhausted = true;
      break;
    }
  }
  assert.equal(sawExhausted, true, 'CPU punches break guard into exhausted state');

  // Keep hands stationary inside guard volume past guardRecovery (0.65s) + regen > guardMinimum -> must NOT auto-re-raise!
  let sawRecoveredStamina = false;
  for (let i = 0; i < 120; i++) {
    ctx.feedHead([0, 1.5, 0], 180);
    pushGrip({ leftGripPos: [-0.15, 1.48, -0.3], rightGripPos: [0.15, 1.48, -0.3] });
    fc.stepFrame(20);
    const blue = session.getMatchSnapshot().blue;
    assert.equal(blue.guardHeld, false);
    if (
      blue.guardState === 'off' &&
      blue.guardStamina >= ARENA_RULES.guardMinimum &&
      blue.guardRecoveryRemaining === 0
    ) {
      sawRecoveredStamina = true;
      break;
    }
  }
  assert.equal(sawRecoveredStamina, true, 'guard stamina recovered while hands remained up');
  assert.equal(session.getMatchSnapshot().blue.guardHeld, false);

  // Drop hands physically out of guard volume, wait for idle if hit, then re-enter -> guard re-raises cleanly.
  for (let i = 0; i < 20; i++) {
    ctx.feedHead([0, 1.5, 0], 180);
    pushGrip({ leftGripPos: [-0.2, 1.15, -0.1], rightGripPos: [0.2, 1.15, -0.1] });
    fc.stepFrame(20);
  }
  for (let i = 0; i < 30; i++) {
    ctx.feedHead([0, 1.5, 0], 180);
    pushGrip({ leftGripPos: [-0.15, 1.48, -0.3], rightGripPos: [0.15, 1.48, -0.3] });
    fc.stepFrame(20);
    if (session.getMatchSnapshot().blue.guardHeld) break;
  }
  assert.equal(session.getMatchSnapshot().blue.guardHeld, true);

  // Large mismatched-epoch batch (25 samples) while guarding must release guard once without overflowing localCommands or pausing.
  const nextEpoch = ctx.bumpEpoch();
  ctx.feedHead([0, 1.5, 0], 180);
  const staleEpochBatch = [];
  for (let b = 0; b < 25; b++) {
    staleEpochBatch.push(
      makeGripCombatSample({
        seq: 5000 + b,
        capturedNs: 50_000_000_000 + b * 10_000_000,
        refEpoch: nextEpoch - 1,
        leftGripPos: [-0.15, 1.48, -0.3],
        rightGripPos: [0.15, 1.48, -0.3],
      })
    );
  }
  session.setInputState(
    staleEpochBatch.at(-1),
    'live',
    staleEpochBatch,
    staleEpochBatch.at(-1).capturedNs + 2_000_000
  );
  fc.stepFrame(20);
  assert.equal(session.getSnapshot().stage, 'fighting');
  assert.equal(session.getMatchSnapshot().blue.guardHeld, false);

  session.dispose();
  ctx.tracker.dispose();
});

test('QUEST_COMBAT_GESTURE_THRESHOLDS with followLiveHead detects snap-punches, chin/chest guard, and rotated stance', () => {
  const { QUEST_COMBAT_GESTURE_THRESHOLDS } = require('../src/features/quest-vr/quest-gesture.ts');
  const classifier = createQuestGestureClassifier({
    poseSource: 'grip',
    thresholds: QUEST_COMBAT_GESTURE_THRESHOLDS,
    followLiveHead: true,
    frame: { yaw: 180, origin: [0, 1.5, 0] },
  });

  // Wearer turned 60 deg left toward -X (matching observed physical Quest playtest yaw).
  const rad60 = (60 * Math.PI) / 180;
  const fwd = [-Math.sin(rad60), 0, -Math.cos(rad60)];
  const head = (t) => ({ t, position: [0, 1.5, 0], forward: fwd, up: [0, 1, 0] });
  const push = (n, leftPos, rightPos, dtMs = 14) => {
    const ns = (n + 1) * dtMs * 1_000_000;
    const sample = makeGripCombatSample({
      seq: 7000 + n,
      capturedNs: ns,
      leftGripPos: leftPos,
      rightGripPos: rightPos,
    });
    return classifier.push({ sample, status: 'live', head: head(n * dtMs), nowNs: ns + 1_000_000 });
  };

  // 1. Chin/chest guard at ~0.24m below eyes and 0.14m forward, even with slight jitter.
  const rightVec = [-fwd[2], 0, fwd[0]];
  const pt = (f, lat, u) => [
    fwd[0] * f + rightVec[0] * lat,
    1.5 + u,
    fwd[2] * f + rightVec[2] * lat,
  ];
  let guardHeld = false;
  for (let i = 0; i < 8; i++) {
    const jitter = i % 2 === 0 ? 0.004 : -0.004;
    const out = push(i, pt(0.14 + jitter, -0.14, -0.24), pt(0.14 - jitter, 0.14, -0.24));
    if (out.some((x) => x.type === 'guard' && x.held)) guardHeld = true;
  }
  assert.equal(guardHeld, true, 'chin/chest guard activates reliably while turned 60 degrees');

  // Drop guard to wide ready stance and wait for exit grace (>75ms).
  let guardDropped = false;
  for (let i = 8; i < 20; i++) {
    const out = push(i, pt(0.04, -0.22, -0.2), pt(0.04, 0.22, -0.2));
    if (out.some((x) => x.type === 'guard' && !x.held)) guardDropped = true;
  }
  assert.equal(guardDropped, true);

  // 2. Fast snap-punch forward along turned gaze and immediate retraction WITHOUT zero-speed stall!
  push(20, pt(0.05, -0.22, -0.2), pt(0.05, 0.2, -0.2));
  push(21, pt(0.05, -0.22, -0.2), pt(0.05, 0.2, -0.2));
  const snapOffsets = [0.12, 0.22, 0.28, 0.21, 0.12, 0.05];
  const snapIntents = [];
  for (let j = 0; j < snapOffsets.length; j++) {
    const out = push(22 + j, pt(0.05, -0.22, -0.2), pt(snapOffsets[j], 0.2, -0.2));
    snapIntents.push(...out);
  }
  assert.equal(
    snapIntents.some((x) => x.type === 'punch' && x.hand === 'right'),
    true,
    'fast snap-punch fires on peak reversal without hovering'
  );

  // 3. Second snap-punch shifted laterally re-arms cleanly via peak retreat.
  push(29, pt(0.05, -0.22, -0.2), pt(0.05, 0.28, -0.2));
  const snap2Intents = [];
  for (let j = 0; j < snapOffsets.length; j++) {
    const out = push(30 + j, pt(0.05, -0.22, -0.2), pt(snapOffsets[j], 0.28, -0.2));
    snap2Intents.push(...out);
  }
  assert.equal(
    snap2Intents.some((x) => x.type === 'punch' && x.hand === 'right'),
    true,
    'rearms on retreat even when stance shifts laterally'
  );

  // 4. H1 + M2: Raise both hands synchronously (or 1-frame staggered) into guard, hold, then punch straight out of guard.
  const raiseGuardClassifier = createQuestGestureClassifier({
    poseSource: 'grip',
    thresholds: QUEST_COMBAT_GESTURE_THRESHOLDS,
    followLiveHead: true,
    frame: { yaw: 180, origin: [0, 1.5, 0] },
  });
  const rgPush = (n, l, rg, hPos = [0, 1.5, 0]) => {
    const ns = (n + 1) * 14 * 1_000_000;
    return raiseGuardClassifier.push({
      sample: makeGripCombatSample({ seq: 8000 + n, capturedNs: ns, leftGripPos: l, rightGripPos: rg }),
      status: 'live',
      head: { t: n * 14, position: hPos, forward: [0, 0, -1], up: [0, 1, 0] },
      nowNs: ns + 1_000_000,
    });
  };
  rgPush(0, [-0.14, 1.15, -0.05], [0.14, 1.15, -0.05]);
  // 1-frame async settle: left arrives inside guard 1 frame before right.
  const async1 = rgPush(1, [-0.14, 1.38, -0.26], [0.14, 1.34, -0.22]);
  const async2 = rgPush(2, [-0.14, 1.38, -0.26], [0.14, 1.38, -0.26]);
  assert.equal(async1.some((x) => x.type === 'punch' || x.type === 'uppercut'), false);
  assert.equal(async2.some((x) => x.type === 'punch' || x.type === 'uppercut'), false);
  for (let k = 3; k <= 7; k++) rgPush(k, [-0.14, 1.38, -0.26], [0.14, 1.38, -0.26]);
  assert.equal(raiseGuardClassifier.snapshot().guard, true);
  // Fast snap-punch straight out of held guard (<75ms) immediately drops guard and fires punch (H1+M2).
  const outFromGuard = [];
  let rgStep = 8;
  for (const z of [-0.36, -0.46, -0.39, -0.26]) {
    outFromGuard.push(...rgPush(rgStep++, [-0.14, 1.38, -0.26], [0.14, 1.38, z]));
  }
  assert.equal(outFromGuard.some((x) => x.type === 'guard' && !x.held), true);
  assert.equal(outFromGuard.some((x) => x.type === 'punch' && x.hand === 'right'), true);

  // 5. M3: Leaning forward 12cm at full extension must NOT falsely rearm while hand stays extended in world space.
  rgPush(20, [-0.14, 1.38, -0.26], [0.14, 1.38, -0.26], [0, 1.5, 0]);
  rgPush(21, [-0.14, 1.38, -0.26], [0.14, 1.38, -0.4], [0, 1.5, 0]);
  rgPush(22, [-0.14, 1.38, -0.26], [0.14, 1.38, -0.48], [0, 1.5, 0]);
  const firstPunch = rgPush(23, [-0.14, 1.38, -0.26], [0.14, 1.38, -0.48], [0, 1.5, 0]);
  assert.equal(firstPunch.some((x) => x.type === 'punch'), true);
  // Lean forward 12cm without retracting right fist, then shift forward slightly: must stay disarmed until fist retracts.
  const leanNoRetract = rgPush(24, [-0.14, 1.38, -0.26], [0.14, 1.38, -0.48], [0, 1.5, -0.12]);
  const afterLean = rgPush(25, [-0.14, 1.38, -0.26], [0.14, 1.38, -0.58], [0, 1.5, -0.12]);
  const stopAfterLean = rgPush(26, [-0.14, 1.38, -0.26], [0.14, 1.38, -0.58], [0, 1.5, -0.12]);
  assert.equal([...leanNoRetract, ...afterLean, ...stopAfterLean].some((x) => x.type === 'punch'), false);

  // 6. Medium #2: Non-reversing uppercut settled within close guard bounds out of an active guard must NOT be suppressed.
  const guardUpp = createQuestGestureClassifier({
    poseSource: 'grip',
    thresholds: QUEST_COMBAT_GESTURE_THRESHOLDS,
    followLiveHead: true,
    frame: { yaw: 180, origin: [0, 1.5, 0] },
  });
  const guPush = (n, rPos) => {
    const ns = (n + 1) * 14 * 1_000_000;
    return guardUpp.push({
      sample: makeGripCombatSample({
        seq: 8500 + n,
        capturedNs: ns,
        leftGripPos: [-0.14, 1.32, -0.22],
        rightGripPos: rPos,
      }),
      status: 'live',
      head: { t: n * 14, position: [0, 1.5, 0], forward: [0, 0, -1], up: [0, 1, 0] },
      nowNs: ns + 1_000_000,
    });
  };
  for (let k = 0; k <= 6; k++) guPush(k, [0.14, 1.32, -0.22]);
  assert.equal(guardUpp.snapshot().guard, true);
  const uppOut = [];
  for (const [k, y] of [
    [7, 1.42],
    [8, 1.58],
    [9, 1.66],
    [10, 1.66],
  ]) {
    uppOut.push(...guPush(k, [0.14, y, -0.22]));
  }
  assert.equal(uppOut.some((x) => x.type === 'guard' && !x.held), true);
  assert.equal(uppOut.some((x) => x.type === 'uppercut' && x.hand === 'right'), true);
});

test('QuestArenaSession dispatches targeted OpenXR haptics, live combatHud, dodge feedback, and handles haptic errors safely', () => {
  const hapticsLog = [];
  let shouldThrowHaptic = false;
  const fakeInputNowNs = 10_000_000_000;

  const {
    buildQuestCombatHud,
    questCombatHudLocalPose,
    questCombatHudPose,
  } = require('../src/features/quest-vr/quest-combat-hud.ts');
  const fc = makeStage06Clock();
  const calYaw = 180;
  const calOrigin = [0, 1.5, 0];
  let headT = 0;
  const refEpoch = 1;
  const currentHead = {
    t: 0,
    position: [...calOrigin],
    forward: [0, 0, -1],
    up: [0, 1, 0],
  };
  let liveHeadState = {
    sample: currentHead,
    calibration: { origin: [...calOrigin], yaw: calYaw, posture: 'standing', source: 'solo', entry: 1 },
    recentering: false,
    refEpoch,
    referenceResets: 0,
    nowMs: 0,
    staleMs: 250,
  };
  const headSource = {
    getLiveHeadState: () => liveHeadState,
    getSnapshot: () => ({ calibration: liveHeadState.calibration }),
    subscribeLive: () => () => {},
  };

  const session = createQuestArenaSession(
    fc.clock,
    headSource,
    {
      cpuEnabled: true,
      spawn: QUEST_ARENA_RULES.separation / 2,
      cpuFirstDelay: 5.0,
      punchHitstop: 0,
      uppercutHitstop: 0,
      blockHitstop: 0,
    },
    (handMask, amplitude, durationMs) => {
      if (shouldThrowHaptic) throw new Error('haptic boom');
      hapticsLog.push({ handMask, amplitude, durationMs });
      return true;
    }
  );
  session.solo();
  const s = session.getSnapshot();
  for (const a of ['arena', 'blue', 'red']) session.assetLoaded(s.lease, s.token, s.placementVersion, a);
  session.ready();
  for (let i = 0; i < 120; i++) fc.stepFrame(20);
  assert.equal(session.getSnapshot().presentation, 'eyes');
  assert.ok(session.getSnapshot().combatHud, 'eyes presentation exposes live combatHud');

  let seq = 100;
  let nowNs = fakeInputNowNs;
  const pushGrips = (leftPos, rightPos, stepMs = 14) => {
    headT += stepMs;
    nowNs += stepMs * 1_000_000;
    liveHeadState = { ...liveHeadState, sample: { ...currentHead, t: headT }, nowMs: headT };
    const sample = makeGripCombatSample({
      seq: seq++,
      capturedNs: nowNs,
      refEpoch,
      leftGripPos: leftPos,
      rightGripPos: rightPos,
    });
    session.setInputState(sample, 'live', undefined, nowNs + 1_000_000);
    fc.stepFrame(stepMs);
  };

  // Throw left-hand snap punch -> Red takes hit & Left haptic fires (mask 1).
  const snapZ = [-0.15, -0.25, -0.4, -0.45, -0.35, -0.22, -0.15];
  for (const z of snapZ) pushGrips([-0.2, 1.28, z], [0.2, 1.28, -0.15]);
  for (let i = 0; i < 45; i++) pushGrips([-0.2, 1.28, -0.15], [0.2, 1.28, -0.15]);
  assert.ok(hapticsLog.some((h) => h.handMask === 1), 'left hand haptic actuated on left hit');
  assert.ok(session.getSnapshot().combatHud.opponentHealth < 100);

  // Throw right-hand snap punch -> Right haptic fires (mask 2).
  for (const z of snapZ) pushGrips([-0.2, 1.28, -0.15], [0.2, 1.28, z]);
  for (let i = 0; i < 45; i++) pushGrips([-0.2, 1.28, -0.15], [0.2, 1.28, -0.15]);
  assert.ok(hapticsLog.some((h) => h.handMask === 2), 'right hand haptic actuated on right hit');

  // Verify HUD builder output is within QuestPanel compositor bounds across combat/presenting/finished stages (H3, L1).
  const spec = buildQuestCombatHud(session.getSnapshot().combatHud);
  assert.ok(spec.ops.length >= 1 && spec.ops.length <= 160);
  assert.ok(spec.widthM <= 2 && spec.heightM <= 2);
  const pose = questCombatHudPose(liveHeadState.calibration, session.getSnapshot().combatHud.redBearingOffsetDeg);
  assert.equal(pose.pose.length, 7);
  // Medium #1: local pose agrees with calibrated world pose when rotated 180 deg, and clamps bearing to +-75 deg.
  const localClamped = questCombatHudLocalPose(120);
  assert.equal(localClamped.clampedOffset, 75);
  assert.deepEqual(localClamped.rotation, [0, 75, 0]);
  const worldRotated = questCombatHudPose(
    { ...liveHeadState.calibration, yaw: 0, origin: [0, 1.5, 0] },
    120
  );
  assert.ok(Math.abs(worldRotated.yaw - -105) < 1e-6);
  const presentingKo = buildQuestCombatHud({
    ...session.getSnapshot().combatHud,
    stage: 'presenting',
    outcome: null,
    playerHealth: 70,
    opponentHealth: 0,
  });
  assert.ok(presentingKo.ops.some((op) => op.op === 'text' && /KNOCKOUT/.test(op.text)));
  assert.equal(presentingKo.ops.some((op) => op.op === 'text' && /DRAW/.test(op.text)), false);
  const countdownHud = buildQuestCombatHud({
    ...session.getSnapshot().combatHud,
    stage: 'countdown',
    evadeStatus: 'armed',
    event: null,
  });
  assert.ok(countdownHud.ops.some((op) => op.op === 'text' && /GET READY/.test(op.text)));

  // Haptic callback throwing must never crash session frame advance.
  shouldThrowHaptic = true;
  for (const z of snapZ) pushGrips([-0.2, 1.28, z], [0.2, 1.28, -0.15]);
  for (let i = 0; i < 45; i++) pushGrips([-0.2, 1.28, -0.15], [0.2, 1.28, -0.15]);
  assert.equal(session.getSnapshot().stage, 'fighting');
  session.dispose();

  // Separate live CPU fight verifying bilateral took-hit (handMask === 3) and duck DODGED! feedback (L2).
  const cpuSession = createQuestArenaSession(
    fc.clock,
    headSource,
    {
      cpuEnabled: true,
      spawn: QUEST_ARENA_RULES.separation / 2,
      cpuFirstDelay: 0.2,
      cpuRecovery: 0.3,
      punchHitstop: 0,
      uppercutHitstop: 0,
      blockHitstop: 0,
    },
    (handMask, amplitude, durationMs) => {
      hapticsLog.push({ handMask, amplitude, durationMs });
      return true;
    }
  );
  hapticsLog.length = 0;
  cpuSession.solo();
  const cs = cpuSession.getSnapshot();
  for (const a of ['arena', 'blue', 'red']) cpuSession.assetLoaded(cs.lease, cs.token, cs.placementVersion, a);
  cpuSession.ready();
  for (let i = 0; i < 120; i++) fc.stepFrame(20);
  const stepCpuFight = (yHead = 1.5, dtMs = 20) => {
    headT += dtMs;
    nowNs += dtMs * 1_000_000;
    liveHeadState = {
      ...liveHeadState,
      sample: { ...currentHead, t: headT, position: [0, yHead, 0] },
      nowMs: headT,
    };
    cpuSession.setInputState(
      makeGripCombatSample({
        seq: seq++,
        capturedNs: nowNs,
        refEpoch,
        leftGripPos: [-0.2, 1.25, -0.1],
        rightGripPos: [0.2, 1.25, -0.1],
      }),
      'live',
      undefined,
      nowNs + 1_000_000
    );
    fc.stepFrame(dtMs);
  };
  let sawTookHit = false;
  for (let i = 0; i < 60; i++) {
    stepCpuFight(1.5, 20);
    if (cpuSession.getSnapshot().combatHud?.event?.kind === 'took-hit') {
      sawTookHit = true;
      break;
    }
  }
  assert.equal(sawTookHit, true, 'CPU punch landing fires took-hit HUD event');
  assert.ok(hapticsLog.some((h) => h.handMask === 3), 'incoming CPU hit fires bilateral mask=3 haptic');

  // Wait for hitstun/stagger to clear, then smoothly duck beneath incoming CPU punch and verify DODGED! event.
  for (let i = 0; i < 35; i++) stepCpuFight(1.5, 20);
  let sawDodged = false;
  for (let i = 0; i < 5; i++) stepCpuFight(1.5 - (i + 1) * 0.04, 20);
  for (let i = 0; i < 45; i++) {
    stepCpuFight(1.28, 20);
    if (cpuSession.getSnapshot().combatHud?.event?.kind === 'dodged') {
      sawDodged = true;
      break;
    }
  }
  assert.equal(sawDodged, true, 'ducking CPU punch emits DODGED! HUD feedback event');

  // H2 + Low #1: During guard drain and menuFocus, stamina quantizes to 5-unit buckets and evadeStatus never shows false cooldown 0.0s.
  let subPublishes = 0;
  const unsubH2 = cpuSession.subscribe(() => {
    subPublishes += 1;
  });
  for (let i = 0; i < 6; i++) stepCpuFight(1.5, 20);
  // Hold hands in guard for 40 ticks (800 ms) while guard stamina drains at 15/s -> ~12 stamina units.
  const observedStamina = new Set();
  for (let g = 0; g < 40; g++) {
    headT += 20;
    nowNs += 20_000_000;
    liveHeadState = {
      ...liveHeadState,
      sample: { ...currentHead, t: headT, position: [0, 1.5, 0] },
      nowMs: headT,
    };
    cpuSession.setInputState(
      makeGripCombatSample({
        seq: seq++,
        capturedNs: nowNs,
        refEpoch,
        leftGripPos: [-0.14, 1.38, -0.26],
        rightGripPos: [0.14, 1.38, -0.26],
      }),
      'live',
      undefined,
      nowNs + 1_000_000
    );
    fc.stepFrame(20);
    const st = cpuSession.getSnapshot().combatHud?.playerGuardStamina;
    if (typeof st === 'number') observedStamina.add(st);
  }
  unsubH2();
  assert.ok(subPublishes < 18, `HUD quantization keeps publishes sparse (${subPublishes} across 46 ticks)`);
  for (const val of observedStamina) {
    assert.ok(val % 5 === 0 || val < 5, `stamina ${val} must be quantized to 5-unit buckets`);
  }
  cpuSession.setMenuFocus(true);
  fc.stepFrame(20);
  assert.equal(cpuSession.getSnapshot().combatHud?.evadeStatus, 'armed');

  cpuSession.dispose();
});
