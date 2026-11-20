const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CALIBRATION,
  gameplayHeadPose,
  headSampleFromViro,
  wrap180,
} = require('../src/features/quest-vr/quest-head-rig.ts');
const {
  QUEST_RECENTER_FAILURE_MESSAGE,
  createQuestHeadTracker,
} = require('../src/features/quest-vr/quest-head-tracker.ts');

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
      const target = currentMs + ms;
      while (true) {
        let earliestId = null;
        let earliestTime = Infinity;
        for (const [id, entry] of pending) {
          if (entry.fireAt <= target && entry.fireAt < earliestTime) {
            earliestTime = entry.fireAt;
            earliestId = id;
          }
        }
        if (earliestId === null) break;
        const entry = pending.get(earliestId);
        pending.delete(earliestId);
        currentMs = entry.fireAt;
        entry.cb();
      }
      currentMs = target;
    },
  };
}

function viroPose(position, yawDeg, pitchDeg = 0) {
  const yr = (yawDeg * Math.PI) / 180;
  const pr = (pitchDeg * Math.PI) / 180;
  return {
    position,
    forward: [Math.sin(yr) * Math.cos(pr), Math.sin(pr), Math.cos(yr) * Math.cos(pr)],
    up: [-Math.sin(yr) * Math.sin(pr), Math.cos(pr), -Math.cos(yr) * Math.sin(pr)],
  };
}

const blueAnchor = { x: -0.095, z: 0, yaw: 90 };
const FRAME_MS = 14;

function feed(tracker, clock, position, yaw, count = 1, pitch = 0) {
  for (let i = 0; i < count; i += 1) {
    tracker.onCameraTransform(viroPose(position, yaw, pitch));
    clock.advance(FRAME_MS);
  }
}

function trackerWithLog(entries = () => 1) {
  const clock = makeClock(1000);
  const logs = [];
  const tracker = createQuestHeadTracker({
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    entries,
    log: (message) => logs.push(message),
  });
  return { clock, logs, tracker };
}

// The same yaw-plus-translation a frame change applies to every LOCAL pose.
function frameJump(turnDeg, shift) {
  const r = (turnDeg * Math.PI) / 180;
  return {
    pos: (p) => [
      shift[0] + p[0] * Math.cos(r) + p[2] * Math.sin(r),
      shift[1] + p[1],
      shift[2] - p[0] * Math.sin(r) + p[2] * Math.cos(r),
    ],
    yaw: (yaw) => wrap180(yaw + turnDeg),
  };
}

test('hot path stores samples without synchronous publish, enforces <= 5 Hz, and keeps snapshot stable', () => {
  const clock = makeClock(1000);
  const tracker = createQuestHeadTracker({
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    entries: () => 1,
  });

  let publishes = 0;
  const unsub = tracker.subscribe(() => {
    publishes += 1;
  });

  const s0 = tracker.getSnapshot();
  assert.equal(tracker.getSnapshot(), s0);
  assert.equal(s0.status, 'uncalibrated');
  assert.deepEqual(s0.calibration, DEFAULT_CALIBRATION);

  // Invalid samples are ignored.
  tracker.onCameraTransform({ position: [0, 0, 0], forward: [0, 0, 0], up: [0, 1, 0] });
  assert.equal(tracker.getSnapshot(), s0);
  assert.equal(publishes, 0);

  // Feed 90 Hz (~11 ms) samples for 990 ms, then advance past t=2000 for the 5th publish.
  for (let i = 0; i < 90; i += 1) {
    const snapBefore = tracker.getSnapshot();
    tracker.onCameraTransform(viroPose([0.05, 1.5, -0.1], 180));
    assert.equal(tracker.getSnapshot(), snapBefore);
    clock.advance(11);
  }
  clock.advance(10);

  // At most 5 publishes in 1000 ms (5 Hz).
  assert.ok(publishes >= 1 && publishes <= 5, `publishes=${publishes}`);
  const after = tracker.getSnapshot();
  assert.equal(after.samplesSeen, 90);
  assert.ok(after.sampleHz !== null && after.sampleHz > 80 && after.sampleHz < 100);
  assert.equal(tracker.getSnapshot(), after);

  unsub();
  tracker.dispose();
});

test('calibrateForSolo uses stable window, falls back to latest sample, and falls back to DEFAULT on no samples', () => {
  // 1. No samples -> DEFAULT_CALIBRATION + status 'no-samples'.
  {
    const clock = makeClock(1000);
    const tracker = createQuestHeadTracker({
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      entries: () => 1,
    });
    const cal = tracker.calibrateForSolo(blueAnchor);
    assert.deepEqual(cal, DEFAULT_CALIBRATION);
    assert.equal(tracker.getSnapshot().status, 'no-samples');
    tracker.dispose();
  }

  // 2. Moving samples -> falls back to latest valid sample.
  {
    const clock = makeClock(1000);
    const tracker = createQuestHeadTracker({
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      entries: () => 1,
    });
    for (let i = 0; i < 8; i += 1) {
      tracker.onCameraTransform(viroPose([i * 0.05, 1.4, 0], 90 + i * 3));
      clock.advance(50);
    }
    const cal = tracker.calibrateForSolo(blueAnchor);
    assert.equal(cal.source, 'solo');
    assert.equal(cal.entry, 1);
    assert.ok(Math.abs(cal.origin[0] - 0.35) < 1e-12);
    assert.equal(cal.origin[1], 1.4);
    assert.equal(cal.origin[2], 0);
    assert.ok(Math.abs(cal.yaw - 111) < 1e-9);
    assert.equal(tracker.getSnapshot().status, 'ready');
    tracker.dispose();
  }

  // 2b. Only vertical gaze samples (yawFromForward === null) -> DEFAULT + 'no-samples'.
  {
    const clock = makeClock(1000);
    const tracker = createQuestHeadTracker({
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      entries: () => 1,
    });
    for (let i = 0; i < 8; i += 1) {
      tracker.onCameraTransform({ position: [0.1, 1.5, 0], forward: [0, 1, 0], up: [0, 0, -1] });
      clock.advance(50);
    }
    const cal = tracker.calibrateForSolo(blueAnchor);
    assert.deepEqual(cal, DEFAULT_CALIBRATION);
    assert.equal(tracker.getSnapshot().status, 'no-samples');
    tracker.dispose();
  }

  // 3. Stable window -> uses median/circular-mean over trailing 500 ms.
  {
    const clock = makeClock(1000);
    const tracker = createQuestHeadTracker({
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      entries: () => 1,
    });
    for (let i = 0; i < 10; i += 1) {
      tracker.onCameraTransform(viroPose([0.2, 1.55, -0.3], -45));
      clock.advance(40);
    }
    const cal = tracker.calibrateForSolo(blueAnchor);
    assert.equal(cal.source, 'solo');
    assert.deepEqual(cal.origin, [0.2, 1.55, -0.3]);
    assert.ok(Math.abs(cal.yaw - -45) < 1e-9);
    assert.equal(tracker.getSnapshot().status, 'ready');
    tracker.dispose();
  }
});

test('entry lifetime preserves Back->Solo and pre-Solo menu Recenter, and re-calibrates on new entry', () => {
  const clock = makeClock(1000);
  let entries = 1;
  const tracker = createQuestHeadTracker({
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    entries: () => entries,
  });

  // Menu recenter in entry 1 BEFORE first Solo.
  tracker.recenter();
  for (let i = 0; i < 10; i += 1) {
    tracker.onCameraTransform(viroPose([0.5, 1.6, 0.2], 60));
    clock.advance(50);
  }
  assert.equal(tracker.getSnapshot().status, 'ready');
  assert.equal(tracker.getSnapshot().calibration.source, 'recenter');
  assert.equal(tracker.getSnapshot().anchor, null);

  // First Solo in entry 1 preserves menu recenter and binds anchor.
  const firstSoloCal = tracker.calibrateForSolo(blueAnchor);
  assert.equal(firstSoloCal.source, 'recenter');
  assert.deepEqual(firstSoloCal.origin, [0.5, 1.6, 0.2]);
  assert.ok(Math.abs(firstSoloCal.yaw - 60) < 1e-9);
  assert.deepEqual(tracker.getSnapshot().anchor, blueAnchor);

  // Move user and press Back -> Solo in same entry: calibration must NOT change.
  // The walk takes real time; an instant 1.8 m step would read as a frame jump.
  clock.advance(1000);
  for (let i = 0; i < 10; i += 1) {
    tracker.onCameraTransform(viroPose([1.8, 1.2, -1.0], -120));
    clock.advance(50);
  }
  const secondSoloCal = tracker.calibrateForSolo({ x: 0, z: 0.1, yaw: 0 });
  assert.deepEqual(secondSoloCal, firstSoloCal);
  assert.deepEqual(tracker.getSnapshot().anchor, blueAnchor);

  // Change posture to seated, then Exit -> dispose -> Re-enter (entries = 2) -> Solo.
  tracker.cyclePosture();
  assert.equal(tracker.getSnapshot().calibration.posture, 'seated');
  tracker.dispose();

  entries = 2;
  for (let i = 0; i < 10; i += 1) {
    tracker.onCameraTransform(viroPose([-0.4, 1.1, 0.7], -90));
    clock.advance(50);
  }
  const newAnchor = { x: -0.095, z: 0.02, yaw: 85 };
  const entry2Cal = tracker.calibrateForSolo(newAnchor);
  assert.equal(entry2Cal.entry, 2);
  assert.equal(entry2Cal.source, 'solo');
  assert.equal(entry2Cal.posture, 'seated');
  assert.deepEqual(entry2Cal.origin, [-0.4, 1.1, 0.7]);
  assert.ok(Math.abs(entry2Cal.yaw - -90) < 1e-9);
  assert.deepEqual(tracker.getSnapshot().anchor, newAnchor);
  tracker.dispose();
});

test('recenter ignores pre-press samples, times out cleanly, succeeds on stable window, and is idempotent', () => {
  const clock = makeClock(1000);
  const tracker = createQuestHeadTracker({
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    entries: () => 1,
  });

  // Pre-press samples at [0, 1.5, 0], yaw 180.
  for (let i = 0; i < 10; i += 1) {
    tracker.onCameraTransform(viroPose([0, 1.5, 0], 180));
    clock.advance(40);
  }
  const initialCal = tracker.calibrateForSolo(blueAnchor);

  // Start recenter, feed moving samples past 2000 ms timeout -> fails without changing calibration.
  tracker.recenter();
  assert.equal(tracker.getSnapshot().status, 'sampling');
  for (let i = 0; i < 20; i += 1) {
    tracker.onCameraTransform(viroPose([i * 0.06, 1.5, 0], 180));
    clock.advance(110);
  }
  assert.equal(tracker.getSnapshot().status, 'failed');
  assert.equal(tracker.getSnapshot().message, QUEST_RECENTER_FAILURE_MESSAGE);
  assert.deepEqual(tracker.getSnapshot().calibration, initialCal);

  // Start recenter again: pre-press samples at [0, 1.5, 0] must be ignored; stabilize at [0.8, 1.45, 0.3], yaw 90.
  tracker.recenter();
  for (let i = 0; i < 8; i += 1) {
    tracker.onCameraTransform(viroPose([0.8, 1.45, 0.3], 90));
    clock.advance(50);
  }
  const recentered = tracker.getSnapshot().calibration;
  assert.equal(tracker.getSnapshot().status, 'ready');
  assert.equal(recentered.source, 'recenter');
  assert.deepEqual(recentered.origin, [0.8, 1.45, 0.3]);
  assert.ok(Math.abs(recentered.yaw - 90) < 1e-9);

  // Second recenter in place is idempotent.
  tracker.recenter();
  for (let i = 0; i < 8; i += 1) {
    tracker.onCameraTransform(viroPose([0.8, 1.45, 0.3], 90));
    clock.advance(50);
  }
  const recentered2 = tracker.getSnapshot().calibration;
  assert.deepEqual(recentered2.origin, recentered.origin);
  assert.ok(Math.abs(wrap180(recentered2.yaw - recentered.yaw)) < 1e-9);

  // Superseding recenter mid-window cancels prior timer and ignores prior samples.
  tracker.recenter();
  for (let i = 0; i < 4; i += 1) {
    tracker.onCameraTransform(viroPose([2.0, 1.5, 2.0], 0));
    clock.advance(50);
  }
  tracker.recenter();
  for (let i = 0; i < 8; i += 1) {
    tracker.onCameraTransform(viroPose([-0.2, 1.3, 0.4], -30));
    clock.advance(50);
  }
  const recentered3 = tracker.getSnapshot().calibration;
  assert.equal(tracker.getSnapshot().status, 'ready');
  assert.deepEqual(recentered3.origin, [-0.2, 1.3, 0.4]);
  assert.ok(Math.abs(recentered3.yaw - -30) < 1e-9);

  tracker.dispose();
});

test('cyclePosture updates only bounds; walking out, clamping, glitches and gaps never move calibration', () => {
  const { clock, logs, tracker } = trackerWithLog();

  for (let i = 0; i < 8; i += 1) {
    tracker.onCameraTransform(viroPose([1.0, 1.5, -0.5], 180));
    clock.advance(40);
  }
  const cal = tracker.calibrateForSolo(blueAnchor);
  logs.length = 0;

  // Walk 2.5 m out of bounds and turn 135 degrees at a brisk real pace.
  for (let i = 1; i <= 180; i += 1) {
    const k = i / 180;
    feed(tracker, clock, [1.0 + 1.5 * k, 1.5 + 0.3 * k, -0.5 - 2.0 * k], 180 - 135 * k);
  }
  clock.advance(250);
  const out = tracker.getSnapshot();
  assert.equal(out.pose.clamped, true);
  assert.equal(out.outOfBounds, true);
  // Clamped and out of bounds for a long time: the world still does not move.
  feed(tracker, clock, [2.5, 1.8, -2.5], 45, 300);
  assert.deepEqual(tracker.getSnapshot().calibration, cal);

  // A tracking-loss NaN is dropped.
  tracker.onCameraTransform({ position: [NaN, 0, 0], forward: [0, 0, -1], up: [0, 1, 0] });
  // A one-frame spike that comes straight back is a glitch.
  feed(tracker, clock, [0, 0, 0], 180, 1);
  feed(tracker, clock, [2.5, 1.8, -2.5], 45, 20);
  // A big change across a long sample gap may be real movement.
  clock.advance(800);
  feed(tracker, clock, [0, 0, 0], 180, 20);
  assert.deepEqual(tracker.getSnapshot().calibration, cal);
  assert.equal(tracker.getSnapshot().referenceResets, 0);
  assert.ok(logs.some((line) => /reference jump rejected reason=second-discontinuity/.test(line)));
  assert.ok(!logs.some((line) => /reference reset rebase/.test(line)));
  // Sparse: 500+ samples produced only a couple of event lines.
  assert.ok(logs.length <= 4, logs.join('\n'));

  // Crouch -0.35 m: unclamped in standing, clamped to -0.25 after cyclePosture -> seated.
  clock.advance(250);
  tracker.onCameraTransform(viroPose([1.0, 1.15, -0.5], 180));
  clock.advance(250);
  assert.equal(tracker.getSnapshot().pose.clamped, false);
  assert.ok(Math.abs(tracker.getSnapshot().pose.vertical - -0.35) < 1e-9);

  const nextPosture = tracker.cyclePosture();
  assert.equal(nextPosture, 'seated');
  assert.deepEqual(tracker.getSnapshot().calibration.origin, cal.origin);
  assert.equal(tracker.getSnapshot().calibration.yaw, cal.yaw);
  assert.equal(tracker.getSnapshot().pose.clamped, true);
  assert.equal(tracker.getSnapshot().pose.vertical, -0.25);

  tracker.dispose();
});

test('dispose cancels all pending timers and resets session calibration while preserving posture', () => {
  const clock = makeClock(1000);
  const tracker = createQuestHeadTracker({
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    entries: () => 1,
  });

  for (let i = 0; i < 8; i += 1) {
    tracker.onCameraTransform(viroPose([0.3, 1.4, -0.2], 120));
    clock.advance(40);
  }
  tracker.calibrateForSolo(blueAnchor);
  tracker.cyclePosture();

  tracker.recenter();
  tracker.onCameraTransform(viroPose([0.3, 1.4, -0.2], 120));
  assert.ok(clock.pending.size > 0);

  tracker.dispose();
  assert.equal(clock.pending.size, 0);
  const afterDispose = tracker.getSnapshot();
  assert.deepEqual(afterDispose.calibration, { ...DEFAULT_CALIBRATION, posture: 'seated' });
  assert.equal(afterDispose.anchor, null);
  assert.equal(afterDispose.status, 'uncalibrated');
  assert.equal(afterDispose.message, null);
  assert.equal(afterDispose.samplesSeen, 0);
  assert.equal(afterDispose.pose, null);
});

test('dispose while recenter is sampling resets cleanly to uncalibrated without stale ready state', () => {
  const clock = makeClock(1000);
  const tracker = createQuestHeadTracker({
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    entries: () => 1,
  });

  // First Solo with no samples -> status 'no-samples' with message.
  tracker.calibrateForSolo(blueAnchor);
  const beforeRecenter = tracker.getSnapshot();
  assert.equal(beforeRecenter.status, 'no-samples');
  assert.equal(beforeRecenter.message, 'Head pose unavailable.');

  // Start recenter (and supersede once) then dispose mid-window.
  tracker.recenter();
  tracker.recenter();
  assert.equal(tracker.getSnapshot().status, 'sampling');
  tracker.dispose();

  const afterDispose = tracker.getSnapshot();
  assert.equal(afterDispose.status, 'uncalibrated');
  assert.equal(afterDispose.message, null);
  assert.deepEqual(afterDispose.calibration, DEFAULT_CALIBRATION);
  assert.equal(clock.pending.size, 0);
});

test('a realistic abrupt origin/yaw jump is confirmed, then rebases to the same bounded pose', () => {
  const { clock, logs, tracker } = trackerWithLog();
  tracker.cyclePosture();
  feed(tracker, clock, [0.2, 1.2, -0.1], 160, 40);
  const cal = tracker.calibrateForSolo(blueAnchor);
  assert.equal(cal.posture, 'seated');

  // A normal 0.2 m lean and back over ~0.6 s never triggers anything.
  for (let i = 0; i <= 20; i += 1) feed(tracker, clock, [0.2, 1.2, -0.1 - 0.01 * i], 160 + i * 0.5);
  for (let i = 20; i >= 0; i -= 1) feed(tracker, clock, [0.2, 1.2, -0.1 - 0.01 * i], 160 + i * 0.5);
  assert.deepEqual(tracker.getSnapshot().calibration, cal);
  assert.ok(!logs.some((line) => /reference jump/.test(line)));

  // Settle with a small lean, then the frame turns 109.4 degrees and shifts.
  const lean = [0.27, 1.12, -0.18];
  // Hold the lean for ~280 ms of continuous frames so the snapshot publishes.
  feed(tracker, clock, lean, 172, 20);
  const before = tracker.getSnapshot().pose;
  assert.equal(before.clamped, false);

  const jump = frameJump(109.4, [-0.6, 0.3, 0.45]);
  const jumped = jump.pos(lean);
  feed(tracker, clock, jumped, jump.yaw(172), 1);
  // Not confirmed yet: calibration is untouched, and the stale pose clamps.
  assert.deepEqual(tracker.getSnapshot().calibration, cal);
  const staleSample = headSampleFromViro(0, viroPose(jumped, jump.yaw(172)));
  assert.equal(gameplayHeadPose(cal, staleSample).clamped, true);
  feed(tracker, clock, jumped, jump.yaw(172), 20);

  const after = tracker.getSnapshot();
  assert.equal(after.referenceResets, 1);
  assert.equal(after.calibration.posture, 'seated');
  assert.equal(after.calibration.source, cal.source);
  assert.equal(after.calibration.entry, cal.entry);
  assert.ok(Math.abs(wrap180(after.calibration.yaw - jump.yaw(cal.yaw))) < 1e-9);
  assert.equal(after.pose.clamped, false);
  for (const key of ['lateral', 'vertical', 'forward', 'yawRelative']) {
    assert.ok(Math.abs(after.pose[key] - before[key]) < 1e-6, key);
  }
  assert.equal(after.status, 'ready');
  const candidate = logs.find((line) => line.startsWith('reference jump candidate'));
  assert.match(
    candidate,
    /dt=14ms delta=\[.*\] dpos=\d+\.\d{3}m dyaw=109\.4 from=\[.*\]@172\.0 to=/
  );
  assert.match(candidate, /origin=\[0\.200,1\.200,-0\.100\] calYaw=160\.0 src=solo/);
  assert.ok(
    logs.some((line) =>
      /reference reset rebase origin=\[.*\]->\[.*\] yaw=160\.0->-90\.6 resets=1/.test(line)
    )
  );

  // Movement after the rebase stays 1:1: 0.1 m further along old -Z.
  for (let i = 1; i <= 10; i += 1) {
    feed(tracker, clock, jump.pos([0.27, 1.12, -0.18 - 0.01 * i]), jump.yaw(172));
  }
  feed(tracker, clock, jump.pos([0.27, 1.12, -0.28]), jump.yaw(172), 20);
  const moved = tracker.getSnapshot().pose;
  const expectedForward = before.forward - 0.1 * Math.cos((160 * Math.PI) / 180);
  assert.ok(Math.abs(moved.forward - expectedForward) < 1e-6);
  assert.equal(tracker.getSnapshot().referenceResets, 1);
  tracker.dispose();
  assert.equal(tracker.getSnapshot().referenceResets, 0);
});

test('a jump before any calibration, or calibrated after the jump, is not applied', () => {
  // Default frame: pre-Solo menu content follows LOCAL, so a system recenter is left alone.
  {
    const { clock, logs, tracker } = trackerWithLog();
    feed(tracker, clock, [0.5, 1.3, 0.4], 100, 20);
    feed(tracker, clock, [0, 1.3, 0], 180, 10);
    assert.deepEqual(tracker.getSnapshot().calibration, DEFAULT_CALIBRATION);
    assert.ok(logs.some((line) => /action=none reason=default-frame-follows-local/.test(line)));
  }
  // An in-app Recenter running across the jump ends in the new frame, exactly once.
  {
    const { clock, logs, tracker } = trackerWithLog();
    feed(tracker, clock, [0.5, 1.3, 0.4], 100, 40);
    tracker.calibrateForSolo(blueAnchor);
    tracker.recenter();
    feed(tracker, clock, [0.5, 1.3, 0.4], 100, 3);
    feed(tracker, clock, [0, 1.25, 0], 180, 40);
    const snap = tracker.getSnapshot();
    assert.equal(snap.status, 'ready');
    assert.equal(snap.calibration.source, 'recenter');
    assert.deepEqual(snap.calibration.origin, [0, 1.25, 0]);
    assert.ok(Math.abs(wrap180(snap.calibration.yaw - 180)) < 1e-9);
    assert.ok(
      logs.some((line) =>
        /calibrated src=recenter reason=recenter origin=\[0\.000,1\.250,0\.000\]/.test(line)
      )
    );
  }
  // A Solo calibration inside the confirm window is already in the new frame.
  {
    let entries = 1;
    const { clock, logs, tracker } = trackerWithLog(() => entries);
    feed(tracker, clock, [0.5, 1.3, 0.4], 100, 40);
    tracker.calibrateForSolo(blueAnchor);
    feed(tracker, clock, [0, 1.25, 0], 180, 2);
    entries = 2;
    const fresh = tracker.calibrateForSolo(blueAnchor);
    feed(tracker, clock, [0, 1.25, 0], 180, 20);
    assert.deepEqual(tracker.getSnapshot().calibration, fresh);
    assert.deepEqual(fresh.origin, [0, 1.25, 0]);
    assert.equal(tracker.getSnapshot().referenceResets, 0);
    assert.ok(logs.some((line) => /action=none reason=calibrated-after-jump/.test(line)));
  }
});
