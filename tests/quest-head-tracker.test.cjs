const { test } = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_CALIBRATION, wrap180 } = require('../src/features/quest-vr/quest-head-rig.ts');
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

test('cyclePosture updates only bounds, and no sample sequence alone ever changes calibration', () => {
  const clock = makeClock(1000);
  const tracker = createQuestHeadTracker({
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    entries: () => 1,
  });

  for (let i = 0; i < 8; i += 1) {
    tracker.onCameraTransform(viroPose([1.0, 1.5, -0.5], 180));
    clock.advance(40);
  }
  const cal = tracker.calibrateForSolo(blueAnchor);

  // Adversarial sample patterns: jump to origin (system-recenter lookalike), tracking-loss NaNs, huge offsets.
  for (let i = 0; i < 50; i += 1) {
    tracker.onCameraTransform(viroPose([2.5, 1.8, -2.5], 45));
    clock.advance(20);
  }
  tracker.onCameraTransform({ position: [NaN, 0, 0], forward: [0, 0, -1], up: [0, 1, 0] });
  for (let i = 0; i < 50; i += 1) {
    tracker.onCameraTransform(viroPose([0, 0, 0], 180));
    clock.advance(20);
  }
  assert.deepEqual(tracker.getSnapshot().calibration, cal);

  // Crouch -0.35 m: unclamped in standing, clamped to -0.25 after cyclePosture -> seated.
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

test('dispose cancels all pending timers and preserves calibration', () => {
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
  const cal = tracker.calibrateForSolo(blueAnchor);

  tracker.recenter();
  tracker.onCameraTransform(viroPose([0.3, 1.4, -0.2], 120));
  assert.ok(clock.pending.size > 0);

  tracker.dispose();
  assert.equal(clock.pending.size, 0);
  assert.deepEqual(tracker.getSnapshot().calibration, cal);
});

test('dispose while recenter is sampling restores prior non-ready status and message', () => {
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
  assert.equal(afterDispose.status, 'no-samples');
  assert.equal(afterDispose.message, 'Head pose unavailable.');
  assert.deepEqual(afterDispose.calibration, beforeRecenter.calibration);
  assert.equal(clock.pending.size, 0);
});
