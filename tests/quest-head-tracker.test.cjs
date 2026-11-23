const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CALIBRATION,
  gameplayHeadPose,
  headSampleFromViro,
  wrap180,
} = require('../src/features/quest-vr/quest-head-rig.ts');
const {
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

  // Pre-Solo pose samples update status/pose without locking Solo calibration yet.
  for (let i = 0; i < 10; i += 1) {
    tracker.onCameraTransform(viroPose([0.5, 1.6, 0.2], 60));
    clock.advance(50);
  }
  assert.equal(tracker.getSnapshot().calibration.source, 'default');
  assert.equal(tracker.getSnapshot().anchor, null);

  // First Solo in entry 1 calibrates to the latest stable sample and binds anchor.
  const firstSoloCal = tracker.calibrateForSolo(blueAnchor);
  assert.equal(firstSoloCal.source, 'solo');
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

test('Horizon system recenter (refSpaceEpoch) re-anchors Solo to the new LOCAL pose without snapping back', () => {
  let epoch = 1;
  const logs = [];
  const clock = makeClock(1000);
  const tracker = createQuestHeadTracker({
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    entries: () => 1,
    refSpaceEpoch: () => epoch,
    log: (line) => logs.push(line),
  });

  // Pre-Solo default frame follows OpenXR LOCAL directly: system recenter does not lock a custom origin.
  feed(tracker, clock, [0.2, 1.5, -0.3], 120, 10);
  epoch = 2;
  feed(tracker, clock, [0, 1.48, 0], 180, 10);
  assert.deepEqual(tracker.getSnapshot().calibration, DEFAULT_CALIBRATION);
  assert.ok(logs.some((line) => /action=none default-frame-follows-local/.test(line)));

  // Calibrate Solo in the current LOCAL space.
  feed(tracker, clock, [0.4, 1.52, -0.2], 145, 20);
  const soloCal = tracker.calibrateForSolo(blueAnchor);
  assert.equal(soloCal.source, 'solo');

  // Even a small (10 deg, 0.05 m) Horizon system recenter bumps refSpaceEpoch and re-anchors cleanly.
  epoch = 3;
  feed(tracker, clock, [0.05, 1.51, 0.02], 155, 10);
  const afterSmall = tracker.getSnapshot();
  assert.equal(afterSmall.status, 'ready');
  assert.equal(afterSmall.calibration.source, 'system');
  assert.equal(afterSmall.calibration.entry, soloCal.entry);
  assert.deepEqual(afterSmall.calibration.origin, [0.05, 1.51, 0.02]);
  assert.ok(Math.abs(afterSmall.calibration.yaw - 155) < 1e-9);
  assert.equal(afterSmall.referenceResets, 1);
  assert.equal(afterSmall.pose.clamped, false);
  assert.ok(Math.abs(afterSmall.pose.lateral) < 1e-9);
  assert.ok(Math.abs(afterSmall.pose.forward) < 1e-9);
  assert.ok(logs.some((line) => /system recenter applied reason=openxr-event/.test(line)));

  // A subsequent large Horizon recenter also re-anchors with zero snap-back.
  epoch = 4;
  feed(tracker, clock, [-0.15, 1.49, 0.1], -40, 10);
  const afterLarge = tracker.getSnapshot();
  assert.equal(afterLarge.calibration.source, 'system');
  assert.deepEqual(afterLarge.calibration.origin, [-0.15, 1.49, 0.1]);
  assert.ok(Math.abs(afterLarge.calibration.yaw - -40) < 1e-9);
  assert.equal(afterLarge.referenceResets, 2);
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

  tracker.onCameraTransform(viroPose([0.3, 1.4, -0.2], 120));

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

test('setRefSpaceEpochSource allows wiring late native readers and resets on dispose', () => {
  let epoch = 10;
  const clock = makeClock(1000);
  const tracker = createQuestHeadTracker({
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    entries: () => 1,
  });
  tracker.setRefSpaceEpochSource(() => epoch);
  feed(tracker, clock, [0, 1.5, 0], 180, 10);
  tracker.calibrateForSolo(blueAnchor);
  epoch = 11;
  feed(tracker, clock, [0.1, 1.45, -0.1], 90, 5);
  assert.equal(tracker.getSnapshot().referenceResets, 1);
  assert.equal(tracker.getSnapshot().calibration.source, 'system');

  tracker.dispose();
  assert.equal(tracker.getSnapshot().status, 'uncalibrated');
  assert.equal(tracker.getSnapshot().referenceResets, 0);
  assert.deepEqual(tracker.getSnapshot().calibration, DEFAULT_CALIBRATION);
});

test('a realistic abrupt origin/yaw jump without refSpaceEpoch is confirmed and re-anchors without snap-back', () => {
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

  // Settle with a small lean, then Horizon resets LOCAL (109.4 deg turn and shift).
  const lean = [0.27, 1.12, -0.18];
  feed(tracker, clock, lean, 172, 20);
  const before = tracker.getSnapshot().pose;
  assert.equal(before.clamped, false);

  const jump = frameJump(109.4, [-0.6, 0.3, 0.45]);
  const jumped = jump.pos(lean);
  feed(tracker, clock, jumped, jump.yaw(172), 1);
  // Not confirmed yet on sample-jump fallback: calibration waits for continuous confirmation.
  assert.deepEqual(tracker.getSnapshot().calibration, cal);
  const staleSample = headSampleFromViro(0, viroPose(jumped, jump.yaw(172)));
  assert.equal(gameplayHeadPose(cal, staleSample).clamped, true);
  feed(tracker, clock, jumped, jump.yaw(172), 20);

  const after = tracker.getSnapshot();
  assert.equal(after.referenceResets, 1);
  assert.equal(after.calibration.posture, 'seated');
  assert.equal(after.calibration.source, 'system');
  assert.equal(after.calibration.entry, cal.entry);
  // Re-anchored to the wearer's current pose in the new Horizon LOCAL frame so the system recenter sticks.
  assert.deepEqual(after.calibration.origin, jumped);
  assert.ok(Math.abs(wrap180(after.calibration.yaw - jump.yaw(172))) < 1e-9);
  assert.equal(after.pose.clamped, false);
  for (const key of ['lateral', 'vertical', 'forward', 'yawRelative']) {
    assert.ok(Math.abs(after.pose[key]) < 1e-6, key);
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
      /system recenter applied reason=sample-jump origin=\[.*\]->\[.*\] yaw=160\.0->.* resets=1/.test(
        line
      )
    )
  );

  // Movement after the system recenter stays 1:1 relative to the new anchored yaw.
  const stepForward = headSampleFromViro(0, viroPose([0, 1, 0], jump.yaw(172))).forward;
  const movedTarget = [
    jumped[0] + 0.1 * stepForward[0],
    jumped[1],
    jumped[2] + 0.1 * stepForward[2],
  ];
  for (let i = 1; i <= 10; i += 1) {
    feed(
      tracker,
      clock,
      [
        jumped[0] + 0.01 * i * stepForward[0],
        jumped[1],
        jumped[2] + 0.01 * i * stepForward[2],
      ],
      jump.yaw(172)
    );
  }
  feed(tracker, clock, movedTarget, jump.yaw(172), 20);
  const moved = tracker.getSnapshot().pose;
  assert.ok(Math.abs(moved.forward - 0.1) < 1e-6);
  assert.equal(tracker.getSnapshot().referenceResets, 1);
  tracker.dispose();
  assert.equal(tracker.getSnapshot().referenceResets, 0);
});

test('a jump before any calibration, or calibrated after the jump, is not double-applied', () => {
  // Default frame: pre-Solo menu content follows LOCAL, so a system recenter is left alone.
  {
    const { clock, logs, tracker } = trackerWithLog();
    feed(tracker, clock, [0.5, 1.3, 0.4], 100, 20);
    feed(tracker, clock, [0, 1.3, 0], 180, 10);
    assert.deepEqual(tracker.getSnapshot().calibration, DEFAULT_CALIBRATION);
    assert.ok(logs.some((line) => /action=none reason=default-frame-follows-local/.test(line)));
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

test('getLiveHeadState and subscribeLive deliver unthrottled samples, lastValidYaw, recentering, and dispose reset', () => {
  let epoch = 5;
  const clock = makeClock(1000);
  const tracker = createQuestHeadTracker({
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    entries: () => 1,
    refSpaceEpoch: () => epoch,
  });

  const events = [];
  const unsub = tracker.subscribeLive((event) => events.push(event));

  // Initial state before samples.
  assert.equal(tracker.getLiveHeadState().sample, null);
  assert.equal(tracker.getLiveHeadState().lastValidYaw, null);
  assert.equal(tracker.getLiveHeadState().recentering, false);

  // Feed stable samples at 180 deg and calibrate Solo.
  feed(tracker, clock, [0, 1.5, 0], 180, 10);
  tracker.calibrateForSolo(blueAnchor);
  assert.ok(events.includes('calibrate'));

  // Advance just 14ms after a 90 deg head turn: UI snapshot is still throttled (200ms),
  // but getLiveHeadState() updates immediately with zero snapshot lag.
  clock.advance(250); // Flush any pending 5 Hz publish first.
  const snapBeforeTurn = tracker.getSnapshot();
  assert.ok(Math.abs(snapBeforeTurn.raw.yaw - -180) < 1e-6);

  tracker.onCameraTransform(viroPose([0, 1.5, 0], 90));
  assert.equal(tracker.getSnapshot(), snapBeforeTurn, 'UI snapshot remains throttled');
  const liveAfterTurn = tracker.getLiveHeadState();
  assert.ok(liveAfterTurn.sample !== null);
  assert.ok(Math.abs(liveAfterTurn.lastValidYaw - 90) < 1e-6);
  assert.equal(liveAfterTurn.refEpoch, 5);
  assert.equal(events.at(-1), 'sample');

  // Degenerate vertical gaze preserves lastValidYaw without corrupting it.
  clock.advance(14);
  tracker.onCameraTransform({ position: [0, 1.5, 0], forward: [0, -1, 0], up: [0, 0, 1] });
  assert.ok(Math.abs(tracker.getLiveHeadState().lastValidYaw - 90) < 1e-6);

  // Restore a valid horizontal sample before testing a sample-jump discontinuity.
  clock.advance(14);
  tracker.onCameraTransform(viroPose([0, 1.5, 0], 90));

  // Sample jump triggers recentering=true during pendingJump, then 'recenter' on confirmation.
  clock.advance(14);
  tracker.onCameraTransform(viroPose([1.2, 1.5, -0.8], -45));
  assert.equal(tracker.getLiveHeadState().recentering, true);
  assert.equal(events.at(-1), 'jump-pending');
  for (let i = 0; i < 6; i += 1) {
    clock.advance(14);
    tracker.onCameraTransform(viroPose([1.2, 1.5, -0.8], -45));
  }
  assert.equal(tracker.getLiveHeadState().recentering, false);
  assert.equal(tracker.getLiveHeadState().referenceResets, 1);
  assert.equal(events.at(-1), 'recenter');

  // OpenXR refSpaceEpoch recenter emits 'recenter' immediately.
  clock.advance(14);
  epoch = 6;
  tracker.onCameraTransform(viroPose([0.1, 1.5, 0.1], 0));
  assert.equal(tracker.getLiveHeadState().refEpoch, 6);
  assert.equal(tracker.getLiveHeadState().referenceResets, 2);
  assert.equal(events.at(-1), 'recenter');

  tracker.dispose();
  assert.equal(events.at(-1), 'dispose');
  assert.equal(tracker.getLiveHeadState().sample, null);
  assert.equal(tracker.getLiveHeadState().lastValidYaw, null);
  assert.equal(tracker.getLiveHeadState().recentering, false);
  unsub();
});
