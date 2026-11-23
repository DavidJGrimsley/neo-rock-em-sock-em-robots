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
      left: handSample(left, left, leftTracking, 0, [0, 0, 0], [0, 0, 0]),
      right: handSample('right', right, rightTracking, trigger, angular, linear),
    };
    sample.left = handSample('left', left, leftTracking, 0, [0, 0, 0], [0, 0, 0]);
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

test('the classifier stays disconnected from match, session, and the XrTime clock', () => {
  const code = read('src/features/quest-vr/quest-gesture.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.equal(code.includes('uppercutReady'), false);
  assert.equal(code.includes('displayTimeNs'), false);
  assert.equal(code.includes('arena-match'), false);
  assert.equal(code.includes('arena-controller'), false);
  assert.equal(code.includes('quest-arena-session'), false);
  assert.equal(code.includes('cpuEnabled'), false);
  assert.equal(code.includes('sweptContact'), false);
  const session = read('src/features/quest-vr/quest-arena-session.ts');
  assert.equal(session.includes('quest-gesture'), false);
  assert.match(session, /QUEST_STAGE_05_IDLE_OPPONENT_RULES/);
  const rules = read('src/features/arena-fighter/arena-controller.ts');
  assert.match(rules, /cpuEnabled: true/);
  assert.match(rules, /uppercutWindow: 0\.45/);
  assert.match(rules, /guardStartup: 0\.1/);
  assert.match(rules, /punchRest: 0\.6/);
});
