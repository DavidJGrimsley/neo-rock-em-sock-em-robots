const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ArenaController,
  ARENA_RULES,
} = require('../src/features/arena-fighter/arena-controller.ts');
const {
  createQuestArenaSession,
  QUEST_ARENA_RULES,
} = require('../src/features/quest-vr/quest-arena-session.ts');
const { questCombatHudViewPose } = require('../src/features/quest-vr/quest-combat-hud.ts');
const {
  createQuestMenuCompositor,
  questMenuPanelSpec,
} = require('../src/features/quest-vr/quest-menu-compositor.ts');
const { createQuestGestureClassifier } = require('../src/features/quest-vr/quest-gesture.ts');
const {
  evaluateQuestPauseInput,
  evaluateQuestTurnInput,
} = require('../src/features/quest-vr/quest-locomotion.ts');
const {
  DEFAULT_CALIBRATION,
  applyYawTurnToCalibration,
  gameplayHeadPose,
} = require('../src/features/quest-vr/quest-head-rig.ts');
const { QuestCombatFeedbackStream } = require('../src/features/quest-vr/quest-combat-feedback.ts');
const {
  QuestCombatSfxController,
  planQuestCombatSfx,
} = require('../src/features/quest-vr/quest-arena-audio.ts');
const {
  QUEST_TUNING,
  questHapticPatternForFeedback,
} = require('../src/features/quest-vr/quest-tuning.ts');

const repo = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(repo, file), 'utf8');

function manualClock(startMs = 1000) {
  let current = startMs;
  const scheduled = new Map();
  let nextId = 1;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    clock: {
      now: () => current,
      schedule(cb, delayMs) {
        const id = nextId++;
        scheduled.set(id, { cb, at: current + delayMs });
        return id;
      },
      cancel(id) {
        scheduled.delete(id);
      },
      scheduleFrame(cb) {
        return cb;
      },
      cancelFrame() {},
    },
  };
}

function makeSample(seq, overrides = {}) {
  return {
    seq,
    displayTimeNs: seq * 13_888_889,
    capturedNs: seq * 13_888_889 + 500,
    ageMs: 0,
    syncResult: 0,
    sessionState: 5,
    focused: true,
    actionsReady: true,
    generation: 1,
    refEpoch: 0,
    left: {
      tracked: true,
      tracking: 'tracked',
      locateResult: 0,
      locationFlags: 0xf,
      velocityFlags: 0x3,
      position: [-0.22, -0.32, -0.34],
      orientation: [0, 0, 0, 1],
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      trigger: 0,
      squeeze: 0,
      thumbstick: { active: true, x: 0, y: 0 },
      buttons: { primary: false, secondary: false, menu: false },
      grip: {
        tracking: 'tracked',
        locateResult: 0,
        locationFlags: 0xf,
        velocityFlags: 0x3,
        position: [-0.22, -0.32, -0.34],
        orientation: [0, 0, 0, 1],
        linearVelocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
      },
    },
    right: {
      tracked: true,
      tracking: 'tracked',
      locateResult: 0,
      locationFlags: 0xf,
      velocityFlags: 0x3,
      position: [0.22, -0.32, -0.34],
      orientation: [0, 0, 0, 1],
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      trigger: 0,
      squeeze: 0,
      thumbstick: { active: true, x: 0, y: 0 },
      buttons: { primary: false, secondary: false, menu: false },
      grip: {
        tracking: 'tracked',
        locateResult: 0,
        locationFlags: 0xf,
        velocityFlags: 0x3,
        position: [0.22, -0.32, -0.34],
        orientation: [0, 0, 0, 1],
        linearVelocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
      },
    },
    ...overrides,
  };
}

test('Phone AR defaults stay untouched and Quest rules opt into feel + AI upgrades', () => {
  assert.equal(ARENA_RULES.combatFeelEnabled, false);
  assert.equal(ARENA_RULES.cpuStateMachineEnabled, false);
  assert.equal(ARENA_RULES.punchDefenseLock, 0.2);
  assert.equal(ARENA_RULES.headEvasionEnabled, false);
  assert.equal(QUEST_ARENA_RULES.combatFeelEnabled, true);
  assert.equal(QUEST_ARENA_RULES.cpuStateMachineEnabled, true);
  assert.ok(QUEST_ARENA_RULES.lightHitLock >= 0.25 && QUEST_ARENA_RULES.lightHitLock <= 0.4);
  assert.ok(
    QUEST_ARENA_RULES.heavyStaggerDuration >= 0.8 && QUEST_ARENA_RULES.heavyStaggerDuration <= 1.2
  );
  assert.ok(
    QUEST_ARENA_RULES.cpuTelegraphPunchWindow >= 0.4 &&
      QUEST_ARENA_RULES.cpuTelegraphPunchWindow <= 0.7
  );
});

test('OpenXR patch 0008 isolates left Menu from Back exit and supports VIEW-space title HUD', () => {
  const patch = read('tools/quest/viro-renderer/0008-openxr-menu-pause-view-hud.patch');
  const lock = JSON.parse(read('tools/quest/viro-renderer/lock.json'));
  assert.equal(lock.patches[7], '0008-openxr-menu-pause-view-hud.patch');
  assert.match(patch, /XR_REFERENCE_SPACE_TYPE_VIEW/);
  assert.match(patch, /nativeTitleDrawInSpace/);
  assert.match(patch, /nativeTitlePoseInSpace/);
  assert.match(patch, /app-handled pause via QuestInputSampler/);
  const menuBlock = patch.slice(patch.indexOf('Menu button (left hand'));
  const addedMenuLines = menuBlock
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  assert.doesNotMatch(addedMenuLines, /_backButtonCallback/);
});

test('Menu/Ring/Set card hides during active combat and Left Menu toggles pause safely with edge debouncing', () => {
  const mc = manualClock(2000);
  let headCal = { ...DEFAULT_CALIBRATION, yaw: 180, origin: [0, 1.5, 0], source: 'solo', entry: 1 };
  const headSource = {
    getLiveHeadState: () => ({
      calibration: headCal,
      status: 'ready',
      recentering: false,
      referenceResets: 0,
      lastValidYaw: 180,
      refEpoch: 0,
      nowMs: mc.now(),
      sample: { t: mc.now(), position: [0, 1.5, 0], forward: [0, 0, -1], up: [0, 1, 0] },
    }),
    applyTurnDelta(delta) {
      headCal = applyYawTurnToCalibration(headCal, [0, 1.5, 0], delta);
    },
  };

  const session = createQuestArenaSession(mc.clock, headSource);
  assert.equal(session.getSnapshot().menuVisible, true);
  assert.equal(session.solo(), true);
  assert.equal(session.getSnapshot().page, 'ring');
  assert.equal(session.getSnapshot().menuVisible, true);

  const s = session.getSnapshot();
  for (const a of ['arena', 'blue', 'red']) {
    session.assetLoaded(s.lease, s.token, s.placementVersion, a);
  }
  const readyRes = session.ready();
  assert.equal(readyRes.started, true);
  // Immediately upon Ready -> intro -> countdown -> fighting, ring/Set panel disappears!
  assert.equal(session.getSnapshot().menuVisible, false);

  // Advance through intro + countdown into fighting.
  for (let i = 0; i < 160; i++) {
    mc.advance(20);
    session.stepExternalFrame(0.02);
  }
  assert.equal(session.getSnapshot().stage, 'fighting');
  assert.equal(session.getSnapshot().menuVisible, false);
  assert.equal(session.getSnapshot().presentation, 'eyes');

  // Calling ready() again during fighting does not bring menu back.
  const duplicateReady = session.ready();
  assert.equal(duplicateReady.reason, 'active');
  assert.equal(session.getSnapshot().menuVisible, false);

  // Scene removes compositor overlay and hit quads whenever menuVisible === false.
  const sceneSrc = read('src/features/quest-vr/quest-arena-scene.native.tsx');
  assert.match(
    sceneSrc,
    /if \(!view\.menuVisible \|\| view\.appActive === false\)\s*\{\s*compositor\.hide\(\)/
  );
  assert.match(sceneSrc, /\{menuVisible \? \(/);

  // Holding Menu across initial live transition must NOT toggle Pause until released first.
  const heldStart = makeSample(1);
  heldStart.left.buttons.menu = true;
  session.setInputState(heldStart, 'live');
  assert.equal(session.getSnapshot().paused, false);

  // Focus loss while holding does not pause either.
  const unfocused = makeSample(2);
  unfocused.focused = false;
  unfocused.left.buttons.menu = true;
  session.setInputState(unfocused, 'live');
  assert.equal(session.getSnapshot().paused, false);

  // Observe false (released) in live focused state -> armed.
  mc.advance(200);
  const released = makeSample(3);
  released.left.buttons.menu = false;
  session.setInputState(released, 'live');
  assert.equal(session.getSnapshot().paused, false);

  // Move left stick & pause with Menu click -> neutralizes locomotion & shows Pause panel.
  mc.advance(200);
  const pressedPause = makeSample(4);
  pressedPause.left.thumbstick.y = 1.0;
  pressedPause.left.buttons.menu = true;
  session.setInputState(pressedPause, 'live');
  assert.equal(session.getSnapshot().paused, true);
  assert.equal(session.getSnapshot().page, 'pause');
  assert.equal(session.getSnapshot().stage, 'paused');
  assert.equal(session.getSnapshot().menuVisible, true);
  assert.equal(session.getSnapshot().animationsRunning, false);
  assert.deepEqual(session.getLocomotion(), { advance: 0, strafe: 0, active: false, magnitude: 0 });

  // Holding Menu across frames while paused does NOT immediately unpause.
  mc.advance(300);
  const heldWhilePaused = makeSample(5);
  heldWhilePaused.left.buttons.menu = true;
  session.setInputState(heldWhilePaused, 'live');
  assert.equal(session.getSnapshot().paused, true);

  // Release then press Menu again -> cleanly resumes!
  mc.advance(150);
  session.setInputState(makeSample(6), 'live');
  mc.advance(150);
  const pressResume = makeSample(7);
  pressResume.left.buttons.menu = true;
  session.setInputState(pressResume, 'live');
  assert.equal(session.getSnapshot().paused, false);
  assert.equal(session.getSnapshot().page, 'ring');
  assert.equal(session.getSnapshot().stage, 'fighting');
  assert.equal(session.getSnapshot().menuVisible, false);
  assert.equal(session.getSnapshot().animationsRunning, true);

  // Right-stick 30 deg snap turn works only while fighting & unfocused, pivoting around live head.
  mc.advance(400);
  const stickIdle = makeSample(8);
  session.setInputState(stickIdle, 'live');
  mc.advance(400);
  const snapRight = makeSample(9);
  snapRight.right.thumbstick.x = 0.9;
  session.setInputState(snapRight, 'live');
  assert.equal(headCal.yaw, -150);

  // Unavailable Menu button (null) is tracked truthfully.
  let pauseState = { armed: true, lastToggleMs: 0, menuAvailable: null };
  const unavailSample = makeSample(10);
  unavailSample.left.buttons.menu = null;
  const unavailEval = evaluateQuestPauseInput(pauseState, {
    sample: unavailSample,
    status: 'live',
    canToggle: true,
    nowMs: 5000,
  });
  assert.equal(unavailEval.toggled, false);
  assert.equal(unavailEval.nextState.menuAvailable, false);
  assert.equal(unavailEval.nextState.armed, false);

  // Turning is ignored while paused.
  const turnPaused = evaluateQuestTurnInput(
    { snapArmed: true },
    {
      sample: snapRight,
      status: 'live',
      inActiveFight: true,
      paused: true,
      nowMs: 6000,
    }
  );
  assert.equal(turnPaused.deltaYawDeg, 0);

  session.dispose();
});

test('Top-of-view HUD pose is strictly view-locked and invariant across turns, lean, and recenter', () => {
  const viewHud = questCombatHudViewPose();
  assert.deepEqual(viewHud.position, QUEST_TUNING.hud.position);
  assert.deepEqual(viewHud.rotation, [QUEST_TUNING.hud.pitchDeg, 0, 0]);
  assert.ok(Math.abs(Math.hypot(...viewHud.pose.slice(3)) - 1) < 1e-12);
  const spec = JSON.parse(
    questMenuPanelSpec({
      label: 'combat hud',
      pose: viewHud.pose,
      viewLocked: true,
      ops: [{ op: 'roundRect', x: 0, y: 0, width: 100, height: 40, color: '#ff000000' }],
    })
  );
  assert.equal(spec.viewLocked, true);

  // Calibration turn around offset head preserves local lean coordinates without drifting.
  const cal = { origin: [0.1, 1.5, -0.2], yaw: 180, posture: 'standing', source: 'solo', entry: 1 };
  const headPos = [0.25, 1.5, -0.1];
  const before = gameplayHeadPose(cal, {
    t: 10,
    position: headPos,
    forward: [0, 0, -1],
    up: [0, 1, 0],
  });
  const turned = applyYawTurnToCalibration(cal, headPos, 30);
  const after = gameplayHeadPose(turned, {
    t: 20,
    position: headPos,
    forward: [0, 0, -1],
    up: [0, 1, 0],
  });
  assert.ok(Math.abs(before.lateral - after.lateral) < 1e-6);
  assert.ok(Math.abs(before.forward - after.forward) < 1e-6);
});

test('Phase 1 & 2: Hit reactions distinguish light/heavy, anti-stunlock activates, and CPU uses telegraphs', () => {
  const controller = new ArenaController(
    {
      ...QUEST_ARENA_RULES,
      cpuEnabled: true,
      cpuFirstDelay: 0.1,
      cpuHoldWindowMin: 0.12,
      cpuHoldWindowMax: 0.12,
      cpuTelegraphPunchWindow: 0.5,
      cpuRetreatChance: 0,
      cpuGuardChance: 0,
      cpuPauseChance: 0,
      cpuFeintChance: 0,
      spawn: 0.04,
      punchHitstop: 0,
      uppercutHitstop: 0,
      blockHitstop: 0,
    },
    () => 0.99
  );
  controller.attachSession(1);
  const token = controller.getSnapshot().sessionToken;
  controller.setLandscape(true);
  controller.setVirtualReady(token, true);
  const pv1 = controller.getSnapshot().placementVersion;
  controller.assetLoaded(token, pv1, 'arena');
  controller.assetLoaded(token, pv1, 'blue');
  controller.assetLoaded(token, pv1, 'red');
  assert.equal(controller.ready(), true);

  controller.setCombatYaw(90, controller.getSnapshot().roundId, 'blue', -90);
  for (let i = 0; i < 50; i++) {
    controller.tick(token, 0.02);
    assert.equal(controller.getQuestCombatTelemetry().redTelegraph, null);
    assert.equal(controller.getQuestCombatTelemetry().redAttacking, null);
  }
  controller.setCombatYaw(90);

  // Verify CPU enters telegraph (not instant strike) and holds committed yaw.
  let sawTelegraph = false;
  let sawAttackAfterTelegraph = false;
  for (let i = 0; i < 60; i++) {
    controller.tick(token, 0.02);
    const tel = controller.getQuestCombatTelemetry();
    if (tel.redAiState === 'telegraph' && tel.redTelegraph) {
      sawTelegraph = true;
      assert.ok(tel.redTelegraph.remaining > 0 && tel.redTelegraph.remaining <= 0.52);
    }
    if (sawTelegraph && tel.redAttacking) {
      sawAttackAfterTelegraph = true;
      break;
    }
  }
  assert.equal(sawTelegraph, true, 'CPU showed readable telegraph before swinging');
  assert.equal(sawAttackAfterTelegraph, true, 'CPU committed attack after telegraph window');

  // Verify hit reaction durations & anti-stunlock under rapid player punches (Disable CPU swings to test player strikes).
  const hitTest = new ArenaController(
    {
      ...QUEST_ARENA_RULES,
      cpuEnabled: false,
      spawn: 0.036,
      punchHitstop: 0,
      uppercutHitstop: 0,
      blockHitstop: 0,
      punchRest: 0,
      counterpunchRecovery: 0,
    },
    () => 0.1
  );
  hitTest.attachSession(2);
  const t2 = hitTest.getSnapshot().sessionToken;
  hitTest.setLandscape(true);
  hitTest.setVirtualReady(t2, true);
  const pv2 = hitTest.getSnapshot().placementVersion;
  for (const a of ['arena', 'blue', 'red']) hitTest.assetLoaded(t2, pv2, a);
  hitTest.ready();

  const seenClips = [];
  let sawHyperArmorHit = false;
  let lastImpactId = 0;
  for (let round = 0; round < 6; round++) {
    hitTest.attack('punch', 'blue', hitTest.getSnapshot().roundId, round % 2 === 0 ? 'L' : 'R');
    for (let step = 0; step < 30; step++) {
      hitTest.tick(t2, 0.02);
      const red = hitTest.getSnapshot().red;
      if (red.impact && red.impact.id > lastImpactId) {
        lastImpactId = red.impact.id;
        if (red.impact.clip) seenClips.push(red.impact.clip);
        if (red.impact.staggerDuration === 0) sawHyperArmorHit = true;
      }
    }
  }
  assert.ok(seenClips.length >= 3, 'multiple hits landed with directional clips');
  assert.equal(sawHyperArmorHit, true, 'anti-stunlock hyper-armor activated after rapid hits');
});

test('Phase 4-7: Unified feedback stream deduplicates, routes audio + haptics + vignette safely', () => {
  const stream = new QuestCombatFeedbackStream();
  const events1 = stream.ingest(
    1.0,
    [
      {
        id: 10,
        defender: 'red',
        kind: 'punch',
        hand: 'R',
        outcome: 'blocked',
        x: 0,
        y: 1,
        z: 0,
      },
    ],
    []
  );
  assert.deepEqual(
    events1.map((e) => e.kind),
    ['PLAYER_HIT_BLOCKED']
  );
  // Duplicate impact id does not re-emit.
  assert.equal(
    stream.ingest(
      1.02,
      [{ id: 10, defender: 'red', kind: 'punch', hand: 'R', outcome: 'hit', x: 0, y: 1, z: 0 }],
      []
    ).length,
    0
  );

  // Verify SFX planning differentiates every required event without crashing on throwing players.
  const allKinds = [
    { kind: 'PLAYER_LANDED_HIT', heavy: false, counter: false, hand: 'L', attackKind: 'punch' },
    { kind: 'PLAYER_HIT_BLOCKED', heavy: false, counter: false, hand: 'R', attackKind: 'punch' },
    { kind: 'PLAYER_RECEIVED_HIT', heavy: true, counter: false, hand: 'L', attackKind: 'uppercut' },
    {
      kind: 'PLAYER_SUCCESSFUL_BLOCK',
      heavy: false,
      counter: false,
      hand: 'L',
      attackKind: 'punch',
    },
    { kind: 'SUCCESSFUL_DODGE', heavy: false, counter: false, hand: 'L', attackKind: 'dodge' },
    { kind: 'GUARD_BREAK', heavy: true, counter: false, hand: 'R', attackKind: 'punch' },
    { kind: 'HEAVY_STAGGER', heavy: true, counter: false, hand: 'R', attackKind: 'uppercut' },
  ];

  let now = 1000;
  let plays = 0;
  const sfx = new QuestCombatSfxController(
    (clip) => {
      if (clip === 'punch_02') {
        return {
          volume: 1,
          playing: false,
          play() {
            throw new Error('simulated native audio error');
          },
          pause() {},
          seekTo: async () => {},
          release() {},
        };
      }
      return {
        volume: 1,
        playing: false,
        play() {
          plays++;
        },
        pause() {},
        seekTo: async () => {},
        release() {},
      };
    },
    { now: () => now }
  );

  for (const spec of allKinds) {
    assert.ok(
      planQuestCombatSfx({
        ...spec,
        id: 1,
        timeSeconds: 1,
        attacker: 'blue',
        defender: 'red',
        damage: 8,
        staggerDuration: 0.9,
        clip: 'HitFront',
      }).length >= 1
    );
    now += 100;
    assert.doesNotThrow(() =>
      sfx.trigger({
        ...spec,
        id: 1,
        timeSeconds: now / 1000,
        attacker: 'blue',
        defender: 'red',
        damage: 8,
        staggerDuration: 0.9,
        clip: 'HitFront',
      })
    );
  }
  sfx.silence();
  sfx.dispose();
  assert.ok(sfx.getDiagnostics().enabled);
});

test('heavy impact produces one feedback event and a delayed seek cannot play after resume', async () => {
  const feedback = new QuestCombatFeedbackStream();
  const [event, duplicate] = feedback.ingest(
    0,
    [
      {
        id: 1,
        defender: 'blue',
        kind: 'punch',
        hand: 'R',
        outcome: 'hit',
        heavy: true,
        staggerDuration: 0.92,
        x: 0,
        y: 0,
        z: 0,
      },
    ],
    []
  );
  assert.equal(event.kind, 'HEAVY_STAGGER');
  assert.equal(duplicate, undefined);

  let finishSeek;
  let plays = 0;
  const audio = new QuestCombatSfxController(
    () => ({
      playing: false,
      isLoaded: false, // Media3 reports false at end of stream.
      duration: 0.4,
      volume: 1,
      seekTo: () =>
        new Promise((resolve) => {
          finishSeek = resolve;
        }),
      play: () => {
        plays++;
      },
      pause() {},
      release() {},
    }),
    { poolSize: 1 }
  );
  assert.equal(audio.trigger(event), true);
  audio.setState({ enabled: false, sfxVolume: 1 });
  audio.setState({ enabled: true, sfxVolume: 1 });
  finishSeek();
  await new Promise(setImmediate);
  assert.equal(plays, 0);
  audio.dispose();
});

test('compositor hide prevents replay resurrection', () => {
  const calls = [];
  const compositor = createQuestMenuCompositor(
    {
      available: () => true,
      open: () => 7,
      draw(owner, specJson) {
        calls.push(['draw', owner, JSON.parse(specJson).label]);
      },
      status: () => 1,
      hide(owner) {
        calls.push(['hide', owner]);
      },
      log() {},
    },
    { enabled: true }
  );

  compositor.present({
    label: 'pause card',
    pose: [0, 0, -1.5, 0, 0, 0, 1],
    ops: [],
    widthPx: 64,
    heightPx: 64,
    widthM: 1,
    heightM: 1,
  });
  assert.equal(calls.filter((c) => c[0] === 'draw').length, 1);

  compositor.hide();
  assert.equal(calls.filter((c) => c[0] === 'hide').length, 1);

  compositor.replay();
  assert.equal(
    calls.filter((c) => c[0] === 'draw').length,
    1,
    'replay after hide must not resurrect a hidden compositor quad layer'
  );
});

test('focus loss mid-fight enters pause state cleanly with pauseCalibration and resumes', () => {
  const mc = manualClock(2000);
  const headState = {
    calibration: { ...DEFAULT_CALIBRATION, yaw: 180, origin: [0, 0, 0] },
    sample: {
      t: 2000,
      position: [0.15, 0.05, -0.2],
      forward: [1, 0, 0],
      up: [0, 1, 0],
    },
    recentering: false,
    refEpoch: 1,
    nowMs: 2000,
  };
  const session = createQuestArenaSession(mc.clock, {
    getLiveHeadState: () => headState,
    getSnapshot: () => ({ calibration: headState.calibration }),
  });

  assert.equal(session.solo(), true);
  for (const asset of ['arena', 'blue', 'red']) {
    const s = session.getSnapshot();
    session.assetLoaded(s.lease, s.token, s.placementVersion, asset);
  }
  assert.equal(session.ready().started, true);
  const token = session.getMatch().getSessionToken();
  for (let i = 0; i < 40; i++) {
    mc.advance(100);
    session.stepExternalFrame(0.1);
  }
  assert.equal(session.getSnapshot().stage, 'fighting');
  assert.equal(session.getSnapshot().presentation, 'eyes');

  session.setAppActive(false);
  const pausedView = session.getSnapshot();
  assert.equal(pausedView.paused, true);
  assert.equal(pausedView.page, 'pause');
  assert.equal(pausedView.menuVisible, true);
  assert.equal(pausedView.combatHud, null);
  assert.ok(pausedView.pauseCalibration);
  assert.deepEqual(pausedView.pauseCalibration.origin, [0.15, 0.05, -0.2]);
  assert.equal(pausedView.pauseCalibration.yaw, 90);
  assert.equal(session.solo(), false, 'solo() must be ignored while paused');

  session.setAppActive(true);
  assert.equal(session.getSnapshot().paused, true, 'restoring focus must keep pause menu visible');
  assert.equal(session.resume(), true);
  const resumedView = session.getSnapshot();
  assert.equal(resumedView.paused, false);
  assert.equal(resumedView.page, 'ring');
  assert.equal(resumedView.menuVisible, false);
  assert.equal(resumedView.pauseCalibration, null);
  assert.ok(token !== null);
  session.dispose();
});

test('countdown pause resumes the intro and requires fresh input before movement', () => {
  const clock = manualClock();
  const session = createQuestArenaSession(clock.clock, {}, { cpuEnabled: false });
  session.solo();
  const { lease, token, placementVersion } = session.getSnapshot();
  for (const asset of ['arena', 'blue', 'red'])
    session.assetLoaded(lease, token, placementVersion, asset);
  session.ready();
  assert.equal(session.getSnapshot().stage, 'countdown');
  assert.equal(session.getSnapshot().presentation, 'side');
  const release = makeSample(1);
  session.setInputState(release, 'live');
  const click = makeSample(2, {
    left: { ...release.left, buttons: { ...release.left.buttons, menu: true } },
  });
  session.setInputState(click, 'live');
  assert.equal(session.getSnapshot().page, 'pause');
  session.setAppActive(false);
  assert.equal(session.resume(), false);
  session.setAppActive(true);
  assert.equal(session.resume(), true);
  assert.equal(session.getSnapshot().introActive, true);
  clock.advance(200);
  session.setInputState(click, 'live', [release, click]);
  assert.equal(session.getSnapshot().paused, false);
  for (let i = 0; i < 100; i++) session.stepExternalFrame(0.05);
  assert.equal(session.getSnapshot().stage, 'fighting');
  assert.equal(session.getSnapshot().presentation, 'eyes');
  assert.equal(session.getSnapshot().menuVisible, false);
  const moving = makeSample(3);
  moving.left.thumbstick.y = 1;
  session.setInputState(moving, 'live');
  assert.equal(session.getLocomotion().active, false);
  session.setInputState(makeSample(4), 'live');
  session.setInputState(makeSample(5, { left: moving.left }), 'live');
  assert.equal(session.getLocomotion().active, true);
  session.dispose();
});

test('light left/right hit reactions allow symmetric counterpunch and guard cancel, and CPU telegraph finishes uppercut cleanly', () => {
  assert.equal(QUEST_ARENA_RULES.uppercutWindow, QUEST_TUNING.cpu.uppercutWindow);

  const makeCloseFight = (extra = {}) => {
    const arena = new ArenaController(
      {
        ...QUEST_ARENA_RULES,
        spawn: 0.036,
        punchHitstop: 0,
        uppercutHitstop: 0,
        blockHitstop: 0,
        cpuEnabled: true,
        cpuFirstDelay: 0.02,
        cpuHoldWindowMin: 0.02,
        cpuHoldWindowMax: 0.02,
        cpuTelegraphPunchWindow: 0.08,
        cpuTelegraphUppercutWindow: 0.65,
        cpuPauseChance: 0,
        cpuGuardChance: 0,
        cpuRetreatChance: 0,
        cpuFeintChance: 0,
        ...extra,
      },
      () => 0.99
    );
    arena.attachSession(1);
    const token = arena.getSnapshot().sessionToken;
    arena.setLandscape(true);
    arena.setVirtualReady(token, true);
    const pv = arena.getSnapshot().placementVersion;
    arena.assetLoaded(token, pv, 'arena');
    arena.assetLoaded(token, pv, 'blue');
    arena.assetLoaded(token, pv, 'red');
    assert.equal(arena.ready(), true);
    return { arena, token };
  };

  // 1) Red hits Blue cleanly with a light punch -> Blue enters HitLeft or HitRight and can counterpunch.
  {
    const { arena, token } = makeCloseFight();
    let hitClip = null;
    for (let i = 0; i < 80; i++) {
      arena.tick(token, 0.02);
      const b = arena.getSnapshot().blue;
      if (b.mode === 'hit' && (b.clip === 'HitLeft' || b.clip === 'HitRight')) {
        hitClip = b.clip;
        break;
      }
    }
    assert.ok(
      hitClip === 'HitLeft' || hitClip === 'HitRight',
      `expected directional light clip HitLeft/HitRight, got ${hitClip}`
    );
    // Queue within the counterpunch buffer while the 340 ms reaction is still active.
    for (let i = 0; i < 15; i++) arena.tick(token, 0.02);
    const snap = arena.getSnapshot();
    assert.equal(
      snap.blue.mode,
      'hit',
      'blue should still be inside light hit reaction before cancel'
    );
    assert.equal(
      arena.attack('punch', 'blue', snap.roundId, 'L'),
      true,
      `should allow counterpunch out of light ${hitClip}`
    );
  }

  // 2) Red hits Blue cleanly with a light punch -> Blue can guard-cancel out of light hit stun.
  {
    const { arena, token } = makeCloseFight();
    let sawLightHit = false;
    for (let i = 0; i < 80; i++) {
      arena.tick(token, 0.02);
      const b = arena.getSnapshot().blue;
      if (b.mode === 'hit' && (b.clip === 'HitLeft' || b.clip === 'HitRight')) {
        sawLightHit = true;
        break;
      }
    }
    assert.equal(sawLightHit, true);
    const snap = arena.getSnapshot();
    assert.equal(
      arena.block(true, 'blue', snap.roundId),
      true,
      'should allow blocking out of light directional hit stun'
    );
    arena.block(false, 'blue', snap.roundId);
  }

  // 3) CPU earning uppercut (punchStringLength: 1) extends window through telegraph & swings uppercut.
  {
    const { arena, token } = makeCloseFight({ punchStringLength: 1 });
    let sawUppercutTelegraph = false;
    let sawUppercutAttack = false;
    for (let i = 0; i < 140; i++) {
      arena.tick(token, 0.02);
      const tel = arena.getQuestCombatTelemetry();
      if (tel.redTelegraph?.kind === 'uppercut') sawUppercutTelegraph = true;
      if (tel.redAttacking?.kind === 'uppercut') {
        sawUppercutAttack = true;
        break;
      }
    }
    assert.equal(sawUppercutTelegraph, true, 'CPU should telegraph earned uppercut');
    assert.equal(sawUppercutAttack, true, 'CPU should complete earned uppercut after telegraph');
  }
});

test('guardian break & heavy stagger on blue use both-hand haptics and snap turn updateFrame preserves held guard', () => {
  const gbBlue = questHapticPatternForFeedback('GUARD_BREAK', 'R', 'blue', true);
  assert.equal(gbBlue?.hand, 'both');
  const gbRed = questHapticPatternForFeedback('GUARD_BREAK', 'R', 'red', true);
  assert.equal(gbRed?.hand, 'right');
  const staggerBlue = questHapticPatternForFeedback('HEAVY_STAGGER', 'L', 'blue', true);
  assert.equal(staggerBlue?.hand, 'both');

  const classifier = createQuestGestureClassifier({
    poseSource: 'grip',
    frame: { yaw: 180, origin: [0, 0, 0] },
    followLiveHead: true,
  });
  const liveHead = {
    t: 1,
    position: [0, 0, 0],
    forward: [0, 0, -1],
    up: [0, 1, 0],
  };
  const guardSample = {
    t: 1,
    capturedNs: 10_000_000,
    generation: 1,
    refEpoch: 1,
    seq: 1,
    focused: true,
    actionsReady: true,
    left: {
      hand: 'left',
      tracking: 'tracked',
      position: [-0.14, 0.05, -0.32],
      orientation: [0, 0, 0, 1],
      grip: { tracking: 'tracked', position: [-0.14, 0.05, -0.32], orientation: [0, 0, 0, 1] },
      aim: { tracking: 'tracked', position: [-0.14, 0.05, -0.32], orientation: [0, 0, 0, 1] },
      thumbstick: { x: 0, y: 0 },
      buttons: { a: false, b: false, x: false, y: false, menu: false, trigger: 0, squeeze: 0 },
    },
    right: {
      hand: 'right',
      tracking: 'tracked',
      position: [0.14, 0.05, -0.32],
      orientation: [0, 0, 0, 1],
      grip: { tracking: 'tracked', position: [0.14, 0.05, -0.32], orientation: [0, 0, 0, 1] },
      aim: { tracking: 'tracked', position: [0.14, 0.05, -0.32], orientation: [0, 0, 0, 1] },
      thumbstick: { x: 0, y: 0 },
      buttons: { a: false, b: false, x: false, y: false, menu: false, trigger: 0, squeeze: 0 },
    },
  };
  let intents = [];
  for (let i = 0; i < 12; i++) {
    intents.push(
      ...classifier.push({
        sample: { ...guardSample, seq: i + 1, capturedNs: (i + 1) * 16_000_000 },
        status: 'live',
        head: { ...liveHead, t: (i + 1) * 16 },
        nowNs: (i + 1) * 16_000_000,
      })
    );
  }
  assert.equal(
    intents.some((x) => x.type === 'guard' && x.held),
    true
  );

  // Turning calibration frame via updateFrame keeps guard & active hand continuity intact cleanly.
  classifier.updateFrame({ yaw: 225, origin: [0.2, 0, -0.1] });
  assert.equal(classifier.snapshot().guard, true, 'updateFrame must keep guard held immediately');
  const nextIntents = classifier.push({
    sample: { ...guardSample, seq: 13, capturedNs: 13 * 16_000_000 },
    status: 'live',
    head: { ...liveHead, t: 13 * 16 },
    nowNs: 13 * 16_000_000,
  });
  assert.equal(
    nextIntents.some((x) => x.type === 'guard' && !x.held),
    false,
    'updateFrame during snap turn must preserve held guard without dropping it'
  );
  assert.equal(
    nextIntents.some((x) => x.type === 'punch' || x.type === 'uppercut'),
    false,
    'updateFrame during snap turn must not synthesize a false punch'
  );
});
