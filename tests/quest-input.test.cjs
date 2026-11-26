const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  QUEST_INPUT_FLOATS_PER_SAMPLE,
  QUEST_INPUT_INTS_PER_SAMPLE,
  QUEST_INPUT_VERSION,
  decodeBatch,
  quantile,
  viroEulerDegrees,
} = require('../src/features/quest-vr/quest-input.ts');
const {
  QUEST_INPUT_STALE_NS,
  createQuestInputSource,
  formatQuestInputHud,
} = require('../src/features/quest-vr/quest-input-source.ts');
const {
  QUEST_DIAG_LIVE_RECTS,
  QUEST_DIAG_POSE,
  QUEST_DIAG_SIZE,
  QUEST_DIAG_TEXTURE,
  buildQuestDiagnosticsLivePatch,
  buildQuestDiagnosticsPanel,
  handLiveSignature,
  questDiagPanelPose,
  questDiagPanelSpec,
} = require('../src/features/quest-vr/quest-diagnostics-layout.ts');
const { menuFrame } = require('../src/features/quest-vr/quest-head-rig.ts');
const {
  QUEST_MENU_POSE,
  QUEST_MENU_SIZE,
} = require('../src/features/quest-vr/quest-menu-layout.ts');

const repo = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(repo, file), 'utf8');

// OpenXR flag values and session states.
const TRACKED = 0x1 | 0x2 | 0x4 | 0x8;
const VALID_ONLY = 0x1 | 0x2;
const VELOCITY = 0x1 | 0x2;
const FOCUSED = 5;
const VISIBLE = 4;
const XR_SESSION_NOT_FOCUSED = 8;
// QuestInputSampler.h active bits: pose, trigger, squeeze, stick, primary, secondary, menu.
const ALL_ACTIVE = 1 | 2 | 4 | 8 | 16 | 32 | 64;
const FRAME_NS = 13_888_889; // 72 Hz

function hand(overrides = {}) {
  return {
    locateResult: 0,
    locationFlags: TRACKED,
    velocityFlags: VELOCITY,
    active: ALL_ACTIVE,
    down: 0,
    position: [0.2, -0.3, -0.4],
    orientation: [0, 0, 0, 1],
    linear: [0, 0, 0],
    angular: [0, 0, 0],
    trigger: 0,
    squeeze: 0,
    stick: [0, 0],
    ...overrides,
  };
}

function sample(seq, overrides = {}) {
  return {
    seq,
    displayTimeNs: seq * FRAME_NS,
    capturedNs: seq * FRAME_NS + 1000,
    syncResult: 0,
    sessionState: FOCUSED,
    actionsReady: 1,
    generation: 1,
    refEpoch: 0,
    left: hand({ position: [-0.2, -0.3, -0.4] }),
    right: hand(),
    ...overrides,
  };
}

// Packs samples exactly like QuestInputSampler.h packHand / QuestInputModule.read.
function batch(samples, overrides = {}) {
  const ints = [];
  const floats = [];
  for (const s of samples) {
    ints.push(s.syncResult, s.sessionState, s.actionsReady, s.generation, s.refEpoch);
    for (const h of [s.left, s.right]) {
      ints.push(h.locateResult, h.locationFlags, h.velocityFlags, h.active, h.down);
    }
    for (const h of [s.left, s.right]) {
      floats.push(
        ...h.position,
        ...h.orientation,
        ...h.linear,
        ...h.angular,
        h.trigger,
        h.squeeze,
        ...h.stick
      );
    }
  }
  const last = samples.at(-1);
  return {
    available: true,
    version: 1,
    generation: samples[0]?.generation ?? 1,
    live: true,
    actionsReady: true,
    latestSeq: last?.seq ?? 0,
    oldestSeq: samples[0]?.seq ?? 0,
    published: samples.length,
    framesWithoutInput: 0,
    rejected: 0,
    nowNs: last ? last.capturedNs + 2_000_000 : null,
    originDisplayTimeNs: '123456789012345678',
    originMonotonicNs: '987654321098765432',
    capacity: 64,
    count: samples.length,
    seq: samples.map((s) => s.seq),
    displayTimeNs: samples.map((s) => s.displayTimeNs),
    capturedNs: samples.map((s) => s.capturedNs),
    ints,
    floats,
    ...overrides,
  };
}

function makeClock(startMs = 1000) {
  let currentMs = startMs;
  const pending = new Map();
  let nextId = 1;
  return {
    pending,
    now: () => currentMs,
    schedule(cb, ms) {
      const id = nextId++;
      pending.set(id, { cb, fireAt: currentMs + ms });
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
    advance(ms) {
      currentMs += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.fireAt <= currentMs) {
          pending.delete(id);
          entry.cb();
        }
      }
    },
  };
}

// A fake ring reader: hands out queued batches, then an empty batch with the same header.
function fakeReader() {
  const queue = [];
  const cursors = [];
  let last = batch([]);
  return {
    cursors,
    push(b) {
      queue.push(b);
    },
    read(afterSeq) {
      cursors.push(afterSeq);
      const next = queue.shift();
      if (next) {
        last = next;
        return next;
      }
      return {
        ...last,
        count: 0,
        seq: [],
        displayTimeNs: [],
        capturedNs: [],
        ints: [],
        floats: [],
      };
    },
    profiles: () => [
      '/interaction_profiles/oculus/touch_controller',
      '/interaction_profiles/oculus/touch_controller',
    ],
  };
}

function startSource(reader) {
  const clock = makeClock();
  const logs = [];
  const source = createQuestInputSource({
    reader,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    log: (message) => logs.push(message),
  });
  return { clock, logs, source };
}

test('decodes both hands from their own bound actions, raw and unfiltered', () => {
  const s = sample(1, {
    left: hand({ position: [-0.25, -0.3, -0.4], stick: [0.05, -0.04], trigger: 0.02, down: 1 | 4 }),
    right: hand({ position: [0.25, -0.3, -0.4], stick: [0.71, 0.7], squeeze: 0.66, down: 2 }),
  });
  const decoded = decodeBatch(batch([s]));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.samples.length, 1);
  const { left, right } = decoded.samples[0];
  assert.equal(left.hand, 'left');
  assert.equal(right.hand, 'right');
  assert.deepEqual(left.position, [-0.25, -0.3, -0.4]);
  assert.deepEqual(right.position, [0.25, -0.3, -0.4]);
  // Below Viro's 0.15 dead zone and 0.5 click threshold: still reported.
  assert.ok(Math.abs(left.thumbstick.x - 0.05) < 1e-6);
  assert.ok(Math.abs(left.thumbstick.y + 0.04) < 1e-6);
  assert.ok(Math.abs(left.trigger.value - 0.02) < 1e-6);
  assert.ok(right.thumbstick.x > 0.7 && right.thumbstick.y > 0.69, 'diagonal kept');
  assert.ok(Math.abs(right.squeeze.value - 0.66) < 1e-6);
  assert.deepEqual(left.buttons, { primary: true, secondary: false, menu: true });
  // Menu is a left-hand action; the right hand never reports it.
  assert.deepEqual(right.buttons, { primary: false, secondary: true, menu: null });
  assert.equal(left.tracking, 'tracked');
  assert.deepEqual(left.linearVelocity, [0, 0, 0]);
  assert.equal(decoded.samples[0].focused, true);
});

test('valid and tracked flags stay separate: inferred, lost, inactive and failed locate', () => {
  const cases = [
    [hand({ locationFlags: VALID_ONLY }), 'inferred', true],
    [hand({ locationFlags: 0x1 }), 'lost', false],
    [hand({ locationFlags: 0 }), 'lost', false],
    [hand({ active: ALL_ACTIVE & ~1 }), 'lost', true], // pose action inactive
    [hand({ locateResult: -12 }), 'lost', false], // XR_ERROR_HANDLE_INVALID
  ];
  for (const [right, expected, hasPosition] of cases) {
    const decoded = decodeBatch(batch([sample(1, { right })]));
    assert.equal(decoded.samples.length, 1);
    const r = decoded.samples[0].right;
    assert.equal(r.tracking, expected, JSON.stringify(right));
    assert.equal(r.position !== null, hasPosition);
    assert.equal(decoded.samples[0].left.tracking, 'tracked');
  }
  const inferred = decodeBatch(batch([sample(1, { right: hand({ locationFlags: VALID_ONLY }) })]))
    .samples[0].right;
  assert.equal(inferred.positionValid, true);
  assert.equal(inferred.positionTracked, false);
  assert.equal(inferred.orientationTracked, false);
  // Velocity reported only with its own flags.
  const noVelocity = decodeBatch(batch([sample(1, { right: hand({ velocityFlags: 0x2 }) })]))
    .samples[0].right;
  assert.equal(noVelocity.linearVelocity, null);
  assert.deepEqual(noVelocity.angularVelocity, [0, 0, 0]);
});

test('inactive actions report null buttons and zero axes rather than stale values', () => {
  const right = hand({ active: 1, trigger: 0.9, squeeze: 0.9, stick: [0.5, 0.5], down: 3 });
  const r = decodeBatch(batch([sample(1, { right })])).samples[0].right;
  assert.deepEqual(r.buttons, { primary: null, secondary: null, menu: null });
  assert.equal(r.trigger.active, false);
  assert.equal(r.trigger.value, 0);
  assert.equal(r.thumbstick.active, false);
  assert.equal(r.thumbstick.x, 0);
});

test('malformed samples and batches are rejected, never guessed', () => {
  const nan = decodeBatch(
    batch([sample(1, { right: hand({ position: [NaN, 0, 0] }) }), sample(2)])
  );
  assert.equal(nan.samples.length, 1);
  assert.equal(nan.invalid, 1);
  const quat = decodeBatch(batch([sample(1, { right: hand({ orientation: [0, 0, 0, 2] }) })]));
  assert.equal(quat.invalid, 1);
  const stick = decodeBatch(batch([sample(1, { left: hand({ stick: [1.2, 0] }) })]));
  assert.equal(stick.invalid, 1);
  const trigger = decodeBatch(batch([sample(1, { left: hand({ trigger: -0.5 }) })]));
  assert.equal(trigger.invalid, 1);
  // An invalid pose is not inspected: lost flags with garbage floats are fine.
  const ignored = decodeBatch(
    batch([sample(1, { right: hand({ locationFlags: 0, position: [NaN, NaN, NaN] }) })])
  );
  assert.equal(ignored.invalid, 0);
  assert.equal(ignored.samples[0].right.position, null);

  const good = batch([sample(1), sample(2)]);
  assert.equal(decodeBatch({ ...good, version: 2 }).error, 'version 2');
  assert.equal(decodeBatch({ ...good, ints: good.ints.slice(1) }).error, 'layout');
  assert.equal(decodeBatch({ ...good, floats: good.floats.slice(1) }).error, 'layout');
  assert.equal(decodeBatch({ ...good, count: 3 }).error, 'layout');
  assert.equal(decodeBatch({ available: false }).error, 'unavailable');
  assert.equal(decodeBatch({ available: true, error: 'read' }).error, 'native read');
  assert.equal(decodeBatch(null).ok, false);
  // Kotlin sends NaN for an int64 it cannot represent exactly; such times are dropped.
  assert.equal(decodeBatch({ ...good, displayTimeNs: [NaN, good.displayTimeNs[1]] }).invalid, 1);
  assert.equal(decodeBatch({ ...good, capturedNs: [1.5, good.capturedNs[1]] }).invalid, 1);
  // Sequence must increase, and every sample must belong to the batch's session.
  assert.equal(decodeBatch({ ...good, seq: [2, 2] }).invalid, 1);
  const otherSession = batch([sample(1), sample(2, { generation: 2 })]);
  assert.equal(decodeBatch(otherSession).invalid, 1);
});

test('sample timing, rate, age and read cost are measured in their own clock domains', () => {
  const reader = fakeReader();
  const { clock, source } = startSource(reader);
  const samples = [];
  for (let seq = 1; seq <= 20; seq += 1) samples.push(sample(seq));
  // Display time steps of exactly one frame; capture jitter of 0.5 ms on odd frames.
  for (const s of samples) if (s.seq % 2) s.capturedNs += 500_000;
  reader.push(batch(samples));
  source.start();
  clock.advance(250);
  const snap = source.getSnapshot();
  assert.equal(snap.status, 'live');
  assert.equal(snap.samplesSeen, 20);
  assert.ok(Math.abs(snap.displayDtMs.p50 - FRAME_NS / 1e6) < 1e-9);
  assert.ok(Math.abs(snap.displayDtMs.max - FRAME_NS / 1e6) < 1e-9);
  assert.ok(snap.captureDtMs.max > snap.captureDtMs.p50 - 1e-9);
  assert.ok(snap.sampleHz > 60 && snap.sampleHz < 90, `hz ${snap.sampleHz}`);
  // nowNs is 2 ms after the newest capture, both CLOCK_MONOTONIC.
  assert.ok(Math.abs(snap.ageMs - 2) < 1e-9);
  assert.equal(snap.readMs.max, 0);
  assert.equal(snap.missed, 0);
  assert.equal(source.recent().length, 20);
  // The cursor advances to the newest sequence read.
  assert.equal(reader.cursors[0], 0);
  assert.equal(reader.cursors.at(-1), 20);
});

test('ring overruns and skipped frames are counted, not hidden', () => {
  const reader = fakeReader();
  const { clock, source } = startSource(reader);
  reader.push(batch([sample(1), sample(2)]));
  source.start();
  // The reader fell behind: native evicted 3..70, the next read starts at 71.
  reader.push(batch([sample(71), sample(72)], { framesWithoutInput: 4 }));
  clock.advance(220);
  const snap = source.getSnapshot();
  assert.equal(snap.missed, 68);
  assert.equal(snap.samplesSeen, 4);
  assert.equal(source.summaryLine().includes('noinput=4'), true);
});

test('stale, unfocused, ended and unavailable are distinct states', () => {
  const reader = fakeReader();
  const { clock, logs, source } = startSource(reader);
  const markers = [];
  source.onSample((s, status) => markers.push([s?.seq ?? null, status]));
  reader.push(batch([sample(1)]));
  source.start();
  assert.equal(source.getSnapshot().status, 'live');
  assert.deepEqual(markers.at(-1), [1, 'live']);

  // Samples stop (paused, IDLE, views invalid): the reader's clock moves on.
  reader.push({
    ...batch([]),
    generation: 1,
    nowNs: sample(1).capturedNs + QUEST_INPUT_STALE_NS + 1,
  });
  clock.advance(20);
  assert.equal(source.getSnapshot().status, 'stale');
  assert.deepEqual(markers.at(-1), [null, 'stale']);

  // System UI over the app: VISIBLE state, xrSyncActions returns XR_SESSION_NOT_FOCUSED.
  reader.push(batch([sample(2, { sessionState: VISIBLE, syncResult: XR_SESSION_NOT_FOCUSED })]));
  clock.advance(20);
  assert.equal(source.getSnapshot().status, 'unfocused');
  assert.equal(source.getSnapshot().latest.focused, false);
  assert.ok(logs.some((line) => line.startsWith('focus true -> false')));

  reader.push(batch([sample(3)]));
  clock.advance(20);
  assert.equal(source.getSnapshot().status, 'live');

  reader.push({ ...batch([]), generation: 1, live: false });
  clock.advance(20);
  assert.equal(source.getSnapshot().status, 'ended');
  assert.deepEqual(markers.at(-1), [null, 'ended']);

  const missing = startSource(null);
  missing.source.start();
  assert.equal(missing.source.getSnapshot().status, 'unavailable');
  const stockRenderer = startSource({ read: () => ({ available: false }) });
  stockRenderer.source.start();
  assert.equal(stockRenderer.source.getSnapshot().status, 'unavailable');
  assert.equal(stockRenderer.clock.pending.size, 0, 'no polling without the sampler');
});

test('before any session the sampler is waiting, not ended', () => {
  const reader = fakeReader();
  const { clock, source } = startSource(reader);
  // QuestInputSampler.h static state: generation 0, not live, empty ring.
  reader.push({ ...batch([]), generation: 0, live: false, published: 0 });
  source.start();
  assert.equal(source.getSnapshot().status, 'waiting');
  assert.equal(source.getSnapshot().message, 'No OpenXR session yet.');
  reader.push(batch([sample(1)]));
  clock.advance(260);
  assert.equal(source.getSnapshot().status, 'live');
  assert.equal(source.getSnapshot().generation, 1);
});

test('samples skipped before the first read are counted per session, without false gaps', () => {
  // Late mount: this session published 60 samples (42..101); the ring only holds the newest.
  let reader = fakeReader();
  let started = startSource(reader);
  reader.push(batch([sample(100), sample(101)], { published: 60 }));
  started.source.start();
  let snap = started.source.getSnapshot();
  assert.equal(snap.skippedBeforeFirstRead, 58);
  assert.equal(snap.missed, 0);
  assert.ok(
    started.logs.some((line) => line === 'first read skipped 58 earlier samples of this session')
  );
  // A fresh source after earlier VR entries: seq is high, but this session has no gap.
  reader = fakeReader();
  started = startSource(reader);
  reader.push(
    batch([sample(500, { generation: 3 }), sample(501, { generation: 3 })], { published: 2 })
  );
  started.source.start();
  snap = started.source.getSnapshot();
  assert.equal(snap.skippedBeforeFirstRead, 0);
  assert.equal(snap.missed, 0);
});

test('a system menu that deactivates poses is not counted as tracking loss', () => {
  const reader = fakeReader();
  const { clock, logs, source } = startSource(reader);
  const inactive = hand({ active: 0 });
  reader.push(batch([sample(1)]));
  source.start();
  reader.push(
    batch([
      sample(2, {
        sessionState: VISIBLE,
        syncResult: XR_SESSION_NOT_FOCUSED,
        left: inactive,
        right: inactive,
      }),
    ])
  );
  clock.advance(20);
  reader.push(batch([sample(3)]));
  clock.advance(220);
  const snap = source.getSnapshot();
  assert.equal(snap.hands.left.tracking, 'tracked');
  assert.equal(snap.hands.left.losses, 0);
  assert.equal(snap.hands.left.recoveries, 0);
  assert.equal(snap.hands.right.losses, 0);
  assert.ok(logs.some((line) => line === 'left tracked -> lost seq=2 gen=1 (unfocused)'));
});

test('a new session generation resets state; a system recenter does not', () => {
  const reader = fakeReader();
  const { clock, logs, source } = startSource(reader);
  reader.push(batch([sample(1), sample(2)]));
  source.start();
  reader.push(batch([sample(3, { refEpoch: 1 }), sample(4, { refEpoch: 1 })]));
  clock.advance(220);
  let snap = source.getSnapshot();
  assert.equal(snap.generation, 1);
  assert.equal(snap.refEpoch, 1);
  assert.equal(snap.samplesSeen, 4);
  assert.ok(
    logs.some((line) => line.includes('reference epoch 0 -> 1 (system recenter, same session)'))
  );

  // Exit and re-entry: new renderer, new generation, a time origin of its own.
  const second = [sample(5, { generation: 2 }), sample(6, { generation: 2 })];
  second[0].displayTimeNs = 0;
  second[0].capturedNs = 0;
  second[1].displayTimeNs = FRAME_NS;
  second[1].capturedNs = FRAME_NS;
  reader.push(batch(second, { generation: 2 }));
  clock.advance(220);
  snap = source.getSnapshot();
  assert.equal(snap.generation, 2);
  assert.equal(snap.missed, 0, 'no false gap across sessions');
  assert.equal(snap.hands.left.losses, 0, 'a session change is not a tracking loss');
  assert.equal(source.recent().length, 2);
  assert.ok(Math.abs(snap.captureDtMs.max - FRAME_NS / 1e6) < 1e-9, 'no cross-session dt');
  assert.ok(logs.some((line) => line === 'session generation 1 -> 2'));
});

test('tracking loss and recovery are detected per hand with capture-clock duration', () => {
  const reader = fakeReader();
  const { clock, logs, source } = startSource(reader);
  const lost = hand({ locationFlags: 0 });
  reader.push(batch([sample(1), sample(2, { right: lost }), sample(3, { right: lost })]));
  source.start();
  let snap = source.getSnapshot();
  assert.equal(snap.hands.right.tracking, 'lost');
  assert.equal(snap.hands.right.losses, 1);
  assert.equal(snap.hands.left.losses, 0);
  reader.push(batch([sample(10, { right: hand({ locationFlags: VALID_ONLY }) }), sample(11)]));
  clock.advance(220);
  snap = source.getSnapshot();
  assert.equal(snap.hands.right.recoveries, 1);
  assert.equal(snap.hands.right.tracking, 'tracked');
  assert.ok(Math.abs(snap.hands.right.lastLossMs - (8 * FRAME_NS) / 1e6) < 1e-9);
  assert.ok(logs.some((line) => line.startsWith('right tracked -> lost seq=2')));
  assert.ok(logs.some((line) => line.startsWith('right lost -> inferred seq=10')));
});

test('continuous stick evidence: distinct positions and diagonal peak', () => {
  const reader = fakeReader();
  const { source } = startSource(reader);
  const sweep = [];
  for (let i = 0; i < 30; i += 1) {
    const a = (i / 30) * Math.PI * 2;
    sweep.push(sample(i + 1, { left: hand({ stick: [Math.cos(a) * 0.95, Math.sin(a) * 0.95] }) }));
  }
  reader.push(batch(sweep));
  source.start();
  const stats = source.getSnapshot().hands.left;
  assert.ok(stats.stickDistinct >= 25, `${stats.stickDistinct}`);
  assert.ok(stats.stickDiagonalPeak > 0.6, `${stats.stickDiagonalPeak}`);
  assert.equal(source.getSnapshot().hands.right.stickDistinct, 1);
});

test('React snapshots are throttled to 5 Hz and summary logs to 1 Hz', () => {
  const reader = fakeReader();
  const { clock, logs, source } = startSource(reader);
  let notifications = 0;
  source.subscribe(() => {
    notifications += 1;
  });
  let seq = 1;
  reader.push(batch([sample(seq)]));
  source.start();
  for (let i = 0; i < 180; i += 1) {
    seq += 1;
    reader.push(batch([sample(seq)]));
    clock.advance(11);
  }
  // About 2 s of 11 ms polls: one notification per 200 ms, one summary per second.
  assert.ok(notifications >= 9 && notifications <= 12, `${notifications}`);
  const summaries = logs.filter((line) => line.startsWith('status=')).length;
  assert.ok(summaries >= 2 && summaries <= 3, `${summaries}`);
  assert.ok(source.getSnapshot().samplesSeen > 150);
});

test('a throwing reader degrades to stale and keeps polling', () => {
  let calls = 0;
  const { clock, source } = startSource({
    read() {
      calls += 1;
      if (calls === 2) throw new Error('boom');
      return batch([sample(calls)]);
    },
  });
  source.start();
  clock.advance(12);
  assert.equal(source.getSnapshot().status, 'stale');
  assert.match(source.getSnapshot().message, /native boom/);
  clock.advance(12);
  assert.equal(source.getSnapshot().status, 'live');
  source.stop();
  assert.equal(clock.pending.size, 0);
});

test('HUD readout names both hands, flags, sticks, buttons, timing and profiles', () => {
  const reader = fakeReader();
  const { clock, source } = startSource(reader);
  reader.push(batch([sample(1), sample(2, { left: hand({ stick: [-0.5, 0.25], down: 1 }) })]));
  source.start();
  clock.advance(1000);
  const text = formatQuestInputHud(source.getSnapshot());
  assert.match(text, /^Controllers live/);
  assert.match(text, /\nL tracked pVT oVT \[/);
  assert.match(text, /\nR tracked/);
  assert.match(text, /stick -0\.50 \+0\.25/);
  assert.match(text, /X\* Y- M-/);
  assert.match(text, /A- B-/);
  assert.match(text, /profile L \/interaction_profiles\/oculus\/touch_controller/);
});

// Port of VROQuaternion::set(x, y, z) (radians), which Viro applies to `rotation`.
function viroQuatFromEuler([ex, ey, ez]) {
  const [sr, cr] = [Math.sin(ex / 2), Math.cos(ex / 2)];
  const [sp, cp] = [Math.sin(ey / 2), Math.cos(ey / 2)];
  const [sy, cy] = [Math.sin(ez / 2), Math.cos(ez / 2)];
  const q = [
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
    cr * cp * cy + sr * sp * sy,
  ];
  const n = Math.hypot(...q);
  return q.map((v) => v / n);
}

test("marker rotation round-trips through Viro's own Euler convention", () => {
  const rad = Math.PI / 180;
  const cases = [
    [0, 0, 0, 1],
    [Math.sin(0.4), 0, 0, Math.cos(0.4)],
    [0, Math.sin(-1.1), 0, Math.cos(-1.1)],
    [0.1, 0.7, -0.3, 0.64],
    [0.5, -0.5, 0.5, 0.5],
  ];
  for (const raw of cases) {
    const n = Math.hypot(...raw);
    const q = raw.map((v) => v / n);
    const euler = viroEulerDegrees(q).map((d) => d * rad);
    const back = viroQuatFromEuler(euler);
    const dot = Math.abs(q.reduce((sum, v, i) => sum + v * back[i], 0));
    assert.ok(dot > 1 - 1e-9, `${JSON.stringify(q)} -> ${JSON.stringify(back)}`);
  }
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(quantile([], 0.5), null);
});

test('patch 0003, QuestInputModule and the JS decoder agree on one layout', () => {
  const patch = read('tools/quest/viro-renderer/0003-openxr-quest-input-sampler.patch');
  const kotlin = read(
    'modules/quest-input/native/src/main/java/expo/modules/questinput/QuestInputModule.kt'
  );
  const value = (text, re) => Number(re.exec(text)[1]);
  const nativeVersion = value(patch, /constexpr int kVersion = (\d+);/);
  assert.equal(nativeVersion, QUEST_INPUT_VERSION);
  assert.equal(value(kotlin, /NATIVE_VERSION = (\d+)/), nativeVersion);
  assert.equal(value(patch, /constexpr int kCapacity = (\d+);/), value(kotlin, /CAPACITY = (\d+)/));
  assert.equal(
    value(patch, /constexpr int kHeaderLongs = (\d+);/),
    value(kotlin, /HEADER_LONGS = (\d+)/)
  );
  assert.equal(
    value(patch, /constexpr int kLongsPerSample = (\d+);/),
    value(kotlin, /LONGS_PER_SAMPLE = (\d+)/)
  );
  const intsPerHand = value(patch, /constexpr int kIntsPerHand = (\d+);/);
  const intsPerSample =
    value(patch, /constexpr int kIntsPerSample = (\d+) \+ 2 \* kIntsPerHand;/) + 2 * intsPerHand;
  const floatsPerHand = value(patch, /constexpr int kFloatsPerHand = (\d+);/);
  assert.equal(intsPerSample, QUEST_INPUT_INTS_PER_SAMPLE);
  assert.equal(value(kotlin, /INTS_PER_SAMPLE = (\d+)/), QUEST_INPUT_INTS_PER_SAMPLE);
  assert.equal(2 * floatsPerHand, QUEST_INPUT_FLOATS_PER_SAMPLE);
  assert.equal(value(kotlin, /FLOATS_PER_SAMPLE = (\d+)/), QUEST_INPUT_FLOATS_PER_SAMPLE);

  const jni = {
    nativeVersion: ['jint', '(JNIEnv *, jobject)', /private external fun nativeVersion\(\): Int/],
    nativeSetMarkersEnabled: [
      'void',
      'jboolean enabled',
      /private external fun nativeSetMarkersEnabled\(enabled: Boolean\)/,
    ],
    nativeRead: [
      'jint',
      'jlong afterSeq, jlongArray header, jlongArray longs,\n+        jintArray ints, jfloatArray floats',
      /private external fun nativeRead\(\s*afterSeq: Long,\s*header: LongArray,\s*longs: LongArray,\s*ints: IntArray,\s*floats: FloatArray\s*\): Int/,
    ],
    nativeProfile: [
      'jstring',
      'jint hand',
      /private external fun nativeProfile\(hand: Int\): String/,
    ],
    nativeDiagStatus: [
      'jint',
      '(JNIEnv *, jobject)',
      /private external fun nativeDiagStatus\(\): Int/,
    ],
    nativeDiagHide: ['void', '(JNIEnv *, jobject)', /private external fun nativeDiagHide\(\)/],
    nativeDiagPose: [
      'jboolean',
      'jfloatArray pose',
      /private external fun nativeDiagPose\(pose: FloatArray\): Boolean/,
    ],
    nativeDiagDraw: [
      'jboolean',
      'jbyteArray rgba, jint width, jint height, jfloat widthM,\n+        jfloat heightM, jfloatArray pose',
      /private external fun nativeDiagDraw\(/,
    ],
    nativeDiagDrawRegion: [
      'jboolean',
      'jbyteArray rgba, jint dx, jint dy, jint dw, jint dh',
      /private external fun nativeDiagDrawRegion\(/,
    ],
  };
  for (const [name, [returns, args, kotlinDecl]] of Object.entries(jni)) {
    const symbol = `Java_expo_modules_questinput_QuestInputModule_${name}`;
    const at = patch.indexOf(symbol);
    assert.ok(at > 0, symbol);
    assert.match(patch.slice(at - 60, at), new RegExp(`JNIEXPORT ${returns} JNICALL`));
    assert.ok(patch.slice(at, at + 260).includes(args), `${name} arguments`);
    assert.match(kotlin, kotlinDecl);
  }

  const rigPatch = read('tools/quest/viro-renderer/0004-openxr-quest-rig-sync.patch');
  const rigJni = {
    nativeRigSyncVersion: [
      'jint',
      '(JNIEnv *, jobject)',
      /private external fun nativeRigSyncVersion\(\): Int/,
    ],
    nativePublishRigState: [
      'jboolean',
      'jboolean active, jfloatArray values',
      /private external fun nativePublishRigState\(active: Boolean, values: FloatArray\?\): Boolean/,
    ],
    nativeClearRigState: [
      'void',
      '(JNIEnv *, jobject)',
      /private external fun nativeClearRigState\(\)/,
    ],
  };
  for (const [name, [returns, args, kotlinDecl]] of Object.entries(rigJni)) {
    const symbol = `Java_expo_modules_questinput_QuestInputModule_${name}`;
    const at = rigPatch.indexOf(symbol);
    assert.ok(at > 0, symbol);
    assert.match(rigPatch.slice(at - 60, at), new RegExp(`JNIEXPORT ${returns} JNICALL`));
    assert.ok(rigPatch.slice(at, at + 260).includes(args), `${name} arguments`);
    assert.match(kotlin, kotlinDecl);
  }
  const build = read('tools/quest/build-viro-renderer.mjs');
  for (const name of [...Object.keys(jni), ...Object.keys(rigJni)]) {
    assert.match(build, new RegExp(`'${name}'`), `${name} checked by build-viro-renderer`);
  }
  assert.match(build, /Java_expo_modules_questinput_QuestInputModule_/);
  assert.match(build, /input sampler JNI methods are not exported/);
  // Absolute int64 values leave Kotlin as strings; per-sample times as exact offsets.
  assert.match(kotlin, /originDisplay\.toString\(\)/);
  assert.match(kotlin, /MAX_EXACT = 9007199254740991L/);
  assert.match(kotlin, /catch \(_: LinkageError\)/);
});

test('patch 0003 stays inside the existing session and keeps native locking simple', () => {
  const patch = read('tools/quest/viro-renderer/0003-openxr-quest-input-sampler.patch');
  const lock = JSON.parse(read('tools/quest/viro-renderer/lock.json'));
  assert.ok(lock.patches.includes('0003-openxr-quest-input-sampler.patch'));
  assert.doesNotMatch(patch, /anthropic|claude|openai|grok/i);
  const files = [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((match) => match[1]).sort();
  assert.deepEqual(files, [
    'android/sharedCode/src/main/cpp/QuestInputSampler.h',
    'android/sharedCode/src/main/cpp/VROInputControllerOpenXR.cpp',
    'android/sharedCode/src/main/cpp/VROInputControllerOpenXR.h',
    'android/sharedCode/src/main/cpp/VROSceneRendererOpenXR.cpp',
    'android/sharedCode/src/main/cpp/VROSceneRendererOpenXR.h',
  ]);
  const added = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  // No second session, action set, action, binding, space or extension.
  for (const forbidden of [
    /xrCreateSession/,
    /xrCreateInstance/,
    /xrCreateActionSet/,
    /xrCreateAction\b/,
    /xrCreateActionSpace/,
    /xrSuggestInteractionProfileBindings/,
    /xrAttachSessionActionSets/,
    /xrCreateReferenceSpace/,
    /EXTENSION_NAME/,
    /grip\/pose/,
    /recenterTracking\(/,
  ])
    assert.doesNotMatch(added, forbidden);
  // Raw capture right after Viro's own xrSyncActions, synced before prepareFrame() so
  // render-thread markers & native rays use current predictedDisplayTime without JS bridge lag.
  assert.match(
    patch,
    /\+    XrResult syncResult = xrSyncActions\(session, &syncInfo\);\n\+    captureQuestRaw\(session, baseSpace, time, syncResult\);/
  );
  assert.match(
    patch,
    /_inputController->syncQuestInput\(_session, _stageSpace,[\s\S]*quest_input::updateMarkers\([\s\S]*Prepare the Viro renderer/
  );
  assert.match(patch, /_inputController->onProcess\([\s\S]*presenterRoot->computeTransforms\(/);
  assert.match(
    added,
    /if \(XR_FAILED\(xrWaitSwapchainImage\(_swapchain, &wait\)\)\) \{[\s\S]*?XrSwapchainImageReleaseInfo release = \{XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO\};[\s\S]*?xrReleaseSwapchainImage\(_swapchain, &release\);/
  );
  assert.match(added, /XrSpaceVelocity velocity = \{ XR_TYPE_SPACE_VELOCITY \}/);
  assert.match(added, /xrGetActionStatePose/);
  // Included by exactly one translation unit, like QuestPanelLayer.h.
  assert.equal((patch.match(/#include "QuestInputSampler\.h"/g) ?? []).length, 1);
  assert.match(
    patch,
    /\+\+\+ b\/android\/sharedCode\/src\/main\/cpp\/VROSceneRendererOpenXR\.cpp[\s\S]*#include "QuestInputSampler\.h"/
  );
  // Session generation lifecycle and publish after sync.
  assert.match(added, /_questInputGeneration = quest_input::beginSession\(questActionsReady\);/);
  assert.match(added, /quest_input::endSession\(_questInputGeneration\);/);
  assert.match(
    added,
    /quest_input::publish\(_questInputGeneration, _inputController->getQuestRawInput\(\),/
  );
  assert.match(added, /quest_panel::refSpaceEpoch\.load\(std::memory_order_relaxed\)/);
  assert.match(added, /case XR_TYPE_EVENT_DATA_INTERACTION_PROFILE_CHANGED:/);
  // One plain mutex; JNI array writes happen after the lock scope closes.
  assert.doesNotMatch(added, /memory_order_acquire|memory_order_release|seqlock|try_lock|spin/);
  const read_ = added.slice(
    added.indexOf('QuestInputModule_nativeRead'),
    added.indexOf('QuestInputModule_nativeProfile')
  );
  const lockAt = read_.indexOf('std::lock_guard<std::mutex> lock(state.mutex);');
  const closeAt = read_.indexOf('    }\n+    head[9] = monotonicNow();');
  const jniAt = read_.indexOf('env->SetLongArrayRegion');
  assert.ok(lockAt > 0 && closeAt > lockAt && jniAt > closeAt, 'JNI writes after unlock');
  assert.match(
    added,
    /if \(!state\.live \|\| generation != state\.generation\) \{\n\+        \+\+state\.rejected;/
  );
});

test('patch 0004 synchronizes rig and fighter transforms on the OpenXR render thread before prepareFrame', () => {
  const patch = read('tools/quest/viro-renderer/0004-openxr-quest-rig-sync.patch');
  const lock = JSON.parse(read('tools/quest/viro-renderer/lock.json'));
  assert.equal(lock.patches[3], '0004-openxr-quest-rig-sync.patch');
  assert.doesNotMatch(patch, /anthropic|claude|openai|grok/i);
  const files = [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((match) => match[1]).sort();
  assert.deepEqual(files, [
    'android/sharedCode/src/main/cpp/QuestRigSync.h',
    'android/sharedCode/src/main/cpp/VROSceneRendererOpenXR.cpp',
  ]);
  const added = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  assert.equal((patch.match(/#include "QuestRigSync\.h"/g) ?? []).length, 1);
  assert.match(
    patch,
    /\+\+\+ b\/android\/sharedCode\/src\/main\/cpp\/VROSceneRendererOpenXR\.cpp[\s\S]*#include "QuestRigSync\.h"/
  );
  // Applied synchronously on VROOpenXRRender before prepareFrame() so computeTransforms() and both eyes share one pose.
  assert.match(
    patch,
    /quest_rig::applyToScene\(rigSceneRoot, \(int\)_sessionState\);[\s\S]*Prepare the Viro renderer \(once per frame, before any eye render\)/
  );
  assert.match(patch, /quest_rig::resetRenderCache\(\);/);
  // Plain mutex only; bounded extrapolation; freeze when not XR_SESSION_STATE_FOCUSED; no session creation.
  assert.doesNotMatch(added, /memory_order_acquire|memory_order_release|seqlock|try_lock|spin/);
  assert.doesNotMatch(added, /xrCreateSession|xrCreateInstance|std::clamp/);
  assert.match(added, /constexpr double kMaxExtrapolateSec = 0\.05;/);
  assert.match(added, /sessionState == XR_SESSION_STATE_FOCUSED/);
  for (const tag of ['quest-rig-outer', 'quest-stance-ring', 'quest-red-node', 'quest-blue-node']) {
    assert.ok(added.includes(`"${tag}"`), `node tag ${tag}`);
  }
  assert.match(added, /node->setPosition\(/);
  assert.match(added, /node->setRotation\(VROQuaternion\(/);
});

test('the Quest scene mounts world markers and the 45-degree sky diagnostics panel without touching menu hits', () => {
  const scene = read('src/features/quest-vr/quest-arena-scene.native.tsx');
  const visualizer = read('src/features/quest-vr/quest-input-visualizer.native.tsx');
  assert.match(scene, /const \[input\] = useState\(createSceneQuestInputSource\);/);
  assert.match(scene, /input\.start\(\);\n    return \(\) => \{\n      input\.stop\(\);/);
  // Markers at the ViroScene root share OpenXR LOCAL with the samples; sky diagnostics mounts alongside QuestMenu.
  assert.match(
    scene,
    /<ViroSkyBox[\s\S]*<QuestInputMarkers source=\{input\} onPipelineChange=\{setMarkerPipeline\} \/>[\s\S]*<QuestDiagnosticsPanel[\s\S]*<QuestMenu/
  );
  // Developer prose does not live inside the normal menuLines memo.
  assert.doesNotMatch(scene, /<QuestInputHud/);
  assert.doesNotMatch(scene, /formatDiagnostics\(/);
  // The menu still uses Viro's ray events.
  assert.match(
    scene,
    /onClickState=\{\(clickState: number, _position: unknown, source: unknown\) =>/
  );
  // Patched renderer activates zero-lag native markers; unpatched falls back to setNativeProps.
  assert.match(visualizer, /questInputNative\?\.setMarkersEnabled\?\.\(true\)/);
  assert.match(
    visualizer,
    /setNodeProps\(state\.node, \{\s+position: \[\.\.\.h\.position\],\s+rotation: \[\.\.\.viroEulerDegrees\(h\.orientation\)\]/
  );
  assert.doesNotMatch(visualizer, /ViroGameLoop/);
  const geometries = visualizer.match(/<Viro(Sphere|Box|Quad|Text)\b[\s\S]*?\/>/g) ?? [];
  assert.ok(geometries.length >= 6);
  for (const geometry of geometries) assert.match(geometry, /ignoreEventHandling/, geometry);
  const markersFn = visualizer.slice(
    visualizer.indexOf('export function QuestInputMarkers'),
    visualizer.indexOf('export interface QuestDiagnosticsPanelProps')
  );
  assert.doesNotMatch(markersFn, /useState|setState/);
});

test('sky diagnostics panel aligns at 45 degrees toward viewer, clears menus, and covers all inputs', () => {
  const rotateY = (v, deg) => {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
  };
  const rotateQ = (q, v) => {
    const [qx, qy, qz, qw] = q;
    const ix = qw * v[0] + qy * v[2] - qz * v[1];
    const iy = qw * v[1] + qz * v[0] - qx * v[2];
    const iz = qw * v[2] + qx * v[1] - qy * v[0];
    const iw = -qx * v[0] - qy * v[1] - qz * v[2];
    return [
      ix * qw + iw * -qx + iy * -qz - iz * -qy,
      iy * qw + iw * -qy + iz * -qx - ix * -qz,
      iz * qw + iw * -qz + ix * -qy - iy * -qx,
    ];
  };

  for (const cal of [
    { origin: [0, 0, 0], yaw: 0, posture: 'standing', source: 'default', entry: 1 },
    { origin: [0.4, 0.1, -0.3], yaw: 135, posture: 'standing', source: 'solo', entry: 2 },
    { origin: [-0.25, -0.35, 0.6], yaw: -70, posture: 'seated', source: 'sample', entry: 3 },
  ]) {
    const { position, pose } = questDiagPanelPose(cal);
    const frame = menuFrame(cal);
    const expectedPos = rotateY(QUEST_DIAG_POSE.position, frame.rotationY).map(
      (v, i) => frame.position[i] + v
    );
    for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(position[i] - expectedPos[i]) < 1e-6);

    const quat = pose.slice(3, 7);
    const normal = rotateQ(quat, [0, 0, 1]);
    const toEye = [
      frame.position[0] - position[0],
      frame.position[1] - position[1],
      frame.position[2] - position[2],
    ];
    const len = Math.hypot(...toEye);
    const dot = (normal[0] * toEye[0] + normal[1] * toEye[1] + normal[2] * toEye[2]) / len;
    assert.ok(dot > 0.9999, `sky panel normal aims at calibrated eye (dot=${dot})`);

    const halfH = QUEST_DIAG_SIZE.heightM / 2;
    const localUp = rotateQ(quat, [0, 1, 0]);
    const diagMinY = position[1] - Math.abs(localUp[1]) * halfH;
    const menuTopY =
      frame.position[1] + QUEST_MENU_POSE.menu.position[1] + QUEST_MENU_SIZE.heightM / 2;
    const ringTopY =
      frame.position[1] + QUEST_MENU_POSE.ring.position[1] + QUEST_MENU_SIZE.heightM / 2;
    assert.ok(diagMinY > menuTopY + 0.25, `diag bottom ${diagMinY} clears menu top ${menuTopY}`);
    assert.ok(diagMinY > ringTopY + 0.8, `diag bottom ${diagMinY} clears ring top ${ringTopY}`);
  }

  const testBatch = batch([
    sample(1, {
      left: hand({
        stick: [-0.75, 0.5],
        trigger: 0.42,
        squeeze: 0.88,
        down: 0x1 | 0x2 | 0x4 | 0x8 | 0x10,
      }),
      right: hand({
        locationFlags: VALID_ONLY,
        stick: [0.33, -0.66],
        trigger: 0.91,
        squeeze: 0.12,
        down: 0x1 | 0x2 | 0x8 | 0x10,
      }),
    }),
  ]);
  const clock = makeClock();
  const reader = fakeReader();
  reader.push(testBatch);
  const src = createQuestInputSource({ reader, ...clock });
  src.start();
  const snapshot = src.getSnapshot();
  src.stop();

  const panel = buildQuestDiagnosticsPanel({
    input: snapshot,
    tracker: {
      status: 'live',
      calibration: { origin: [0, 0, 0], yaw: 0, posture: 'standing', source: 'default', entry: 1 },
      raw: null,
      pose: {
        lateral: 0.01,
        vertical: -0.02,
        forward: 0.03,
        yawRelative: 5,
        clamped: false,
        outOfBounds: false,
        excess: 0,
      },
      sampleHz: 72,
      referenceResets: 0,
      message: 'Tracking normally.',
    },
    developerLines: ['Solo places both robots in the ring.', 'Hold Meta button to recenter view.'],
    markerPipeline: 'render-thread',
  });
  const texts = panel.ops.filter((op) => op.op === 'text').map((op) => op.text);
  const combined = texts.join('\n');
  assert.match(combined, /LEFT CONTROLLER/);
  assert.match(combined, /RIGHT CONTROLLER/);
  assert.match(combined, /TRACKED/);
  assert.match(combined, /INFERRED/);
  assert.match(combined, /-0\.75/);
  assert.match(combined, /\+0\.50/);
  assert.match(combined, /0\.42/);
  assert.match(combined, /0\.88/);
  assert.match(combined, /X:ON/);
  assert.match(combined, /A:ON/);
  assert.match(combined, /Solo places both robots in the ring\./);
  assert.match(combined, /render-thread/);

  const spec = JSON.parse(
    questDiagPanelSpec({
      pose: questDiagPanelPose({
        origin: [0, 0, 0],
        yaw: 0,
        posture: 'standing',
        source: 'default',
        entry: 1,
      }).pose,
      ops: panel.ops,
    })
  );
  assert.equal(spec.widthPx, QUEST_DIAG_TEXTURE.widthPx);
  assert.equal(spec.heightPx, QUEST_DIAG_TEXTURE.heightPx);
  assert.equal(spec.pose.length, 7);
});

test('the input module is Android-only, optional, and adds no permissions', () => {
  assert.deepEqual(JSON.parse(read('modules/quest-input/expo-module.config.json')), {
    platforms: ['android'],
    android: { path: 'native', modules: ['expo.modules.questinput.QuestInputModule'] },
  });
  assert.match(
    read('modules/quest-input/src/index.ts'),
    /requireOptionalNativeModule<QuestInputNative>\('QuestInput'\)/
  );
  assert.equal(
    read('modules/quest-input/native/src/main/AndroidManifest.xml').trim(),
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" />'
  );
  assert.match(
    read('modules/quest-input/native/consumer-rules.pro'),
    /-keep class expo\.modules\.questinput\.QuestInputModule \{ \*; \}/
  );
  // Phone builds keep the stock renderer and no Quest plugin.
  const config = read('app.config.ts');
  assert.match(
    config,
    /\.\.\.\(quest\s*\?\s*\['\.\/tools\/quest\/with-quest-vr-activity\.cjs', '\.\/tools\/quest\/with-quest-viro-renderer\.cjs'\]/
  );
});

test('diagnostics live patch targets bounded sub-regions and responds faster than 5 Hz without React thrash', () => {
  for (const side of ['left', 'right']) {
    for (const kind of ['controls', 'badge']) {
      const r = QUEST_DIAG_LIVE_RECTS[side][kind];
      assert.ok(r.x >= 0 && r.y >= 0);
      assert.ok(r.x + r.width <= QUEST_DIAG_TEXTURE.widthPx);
      assert.ok(r.y + r.height <= QUEST_DIAG_TEXTURE.heightPx);
      // Sub-regions stay clear of flags (y<=264) and Aim line (y>=694).
      if (kind === 'controls') {
        assert.ok(r.y >= 275 && r.y + r.height <= 690);
        assert.ok(
          r.width * r.height < QUEST_DIAG_TEXTURE.widthPx * QUEST_DIAG_TEXTURE.heightPx * 0.2
        );
      }
    }
  }

  const reader = fakeReader();
  const { clock, source } = startSource(reader);
  let reactNotifies = 0;
  source.subscribe(() => {
    reactNotifies += 1;
  });
  let sampleTicks = 0;
  source.onSample(() => {
    sampleTicks += 1;
  });

  reader.push(batch([sample(1, { right: hand({ stick: [0, 0], trigger: 0, down: 0 }) })]));
  source.start();

  // Simulate 14 frames at ~72 Hz (14 ms steps) sweeping right stick and tapping A.
  const patches = [];
  for (let i = 2; i <= 15; i += 1) {
    const aDown = i >= 4 && i <= 6 ? 1 : 0;
    reader.push(
      batch([
        sample(i, {
          right: hand({
            stick: [Math.min(1, i * 0.06), -0.3],
            trigger: Math.min(1, i * 0.05),
            down: aDown,
          }),
        }),
      ])
    );
    clock.advance(14);
    const live = source.getLiveState();
    const sigR = handLiveSignature(live.latest?.right ?? null, live.hands.right);
    if (patches.length === 0 || patches.at(-1).sig !== sigR.key) {
      const patch = buildQuestDiagnosticsLivePatch({
        sample: live.latest,
        hands: live.hands,
        includeHands: { rightControls: true },
      });
      patches.push({ seq: live.latest.seq, sig: sigR.key, patch });
    }
  }

  // React snapshots stayed throttled (~1-2 times in ~196 ms), while onSample captured every frame.
  assert.ok(reactNotifies <= 2, `React stayed at 5 Hz (${reactNotifies})`);
  assert.ok(sampleTicks >= 14, `onSample saw every poll (${sampleTicks})`);
  assert.ok(patches.length >= 10);
  const lastRegion = patches.at(-1).patch.regions[0];
  assert.equal(lastRegion.x, QUEST_DIAG_LIVE_RECTS.right.controls.x);
  assert.equal(lastRegion.y, QUEST_DIAG_LIVE_RECTS.right.controls.y);
  assert.ok(lastRegion.ops.some((op) => op.op === 'text' && /Stick  X/.test(op.text)));
  assert.ok(
    patches.some((p) =>
      p.patch.regions[0].ops.some((op) => op.op === 'text' && op.text === 'A:ON')
    ),
    'short 3-frame A-button tap is captured by live patch'
  );
  source.stop();

  const patch0003 = read('tools/quest/viro-renderer/0003-openxr-quest-input-sampler.patch');
  assert.match(patch0003, /GL_UNPACK_ROW_LENGTH, _width/);
  assert.match(patch0003, /GL_UNPACK_SKIP_ROWS, dirty\.y/);
  assert.match(patch0003, /GL_UNPACK_SKIP_PIXELS, dirty\.x/);
  assert.match(patch0003, /nativeDiagDrawRegion/);

  const visualizer = read('src/features/quest-vr/quest-input-visualizer.native.tsx');
  assert.match(visualizer, /QUEST_DIAG_PATCH_ANALOG_MS = 100/);
  assert.match(visualizer, /QUEST_DIAG_PATCH_EDGE_MS = 16/);
  assert.match(visualizer, /questInputNative\?\.patchDiagnostics\?\.\(owner/);
  assert.match(visualizer, /source\.onSample\(/);
});

test('QuestInputModule and patch 0007 agree on the OpenXR haptics JNI contract', () => {
  const kotlin = read(
    'modules/quest-input/native/src/main/java/expo/modules/questinput/QuestInputModule.kt'
  );
  const patch = read('tools/quest/viro-renderer/0007-openxr-quest-haptics.patch');
  const build = read('tools/quest/build-viro-renderer.mjs');
  const ts = read('modules/quest-input/src/index.ts');
  const hapticsJni = {
    nativeHapticsVersion: [
      'jint',
      '(JNIEnv *, jobject)',
      /private external fun nativeHapticsVersion\(\): Int/,
    ],
    nativeTriggerHaptic: [
      'jboolean',
      'jint handMask, jfloat amplitude, jint durationMs',
      /private external fun nativeTriggerHaptic\(handMask: Int, amplitude: Float, durationMs: Int\): Boolean/,
    ],
    nativeHapticsStatus: [
      'jboolean',
      'jlongArray outStats',
      /private external fun nativeHapticsStatus\(outStats: LongArray\): Boolean/,
    ],
  };
  for (const [name, [returns, args, kotlinDecl]] of Object.entries(hapticsJni)) {
    const symbol = `Java_expo_modules_questinput_QuestInputModule_${name}`;
    const at = patch.indexOf(symbol);
    assert.ok(at > 0, symbol);
    assert.match(patch.slice(at - 60, at), new RegExp(`JNIEXPORT ${returns} JNICALL`));
    assert.ok(patch.slice(at, at + 260).includes(args), `${name} arguments`);
    assert.match(kotlin, kotlinDecl);
    assert.match(build, new RegExp(`'${name}'`));
  }
  assert.match(kotlin, /Function\("hapticsVersion"\)/);
  assert.match(kotlin, /Function\("triggerHaptic"\)/);
  assert.match(kotlin, /Function\("hapticsStatus"\)/);
  assert.match(ts, /triggerHaptic\?\(/);
  assert.match(ts, /hapticsVersion\?\(/);
  assert.match(ts, /hapticsStatus\?\(/);
});
