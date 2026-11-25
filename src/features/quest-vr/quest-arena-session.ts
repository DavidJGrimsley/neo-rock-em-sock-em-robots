import { ArenaMatch } from '../arena-fighter/arena-match.ts';
import { forward } from '../arena-fighter/arena-combat-motion.ts';
import type {
  AnalogMovement,
  ArenaAsset,
  FighterId,
  FighterTransform,
} from '../arena-fighter/arena-controller.ts';
import {
  createQuestFirstPersonBodyTrackerState,
  stepQuestFirstPersonBodyClip,
  type QuestFirstPersonBodyClip,
} from './quest-first-person-body.ts';
import { DEFAULT_CALIBRATION, type Calibration } from './quest-head-rig.ts';
import {
  questHeadTracker,
  type QuestHeadLiveEvent,
  type QuestLiveHeadState,
} from './quest-head-tracker.ts';
import type { QuestInputSample } from './quest-input.ts';
import type { QuestInputStatus } from './quest-input-source.ts';
import {
  evaluateQuestDashInput,
  questLocomotionFromInput,
  type QuestDashTriggerState,
  type QuestHeadLocomotionState,
  type QuestLocomotionCommand,
} from './quest-locomotion.ts';
import type { QuestMenuPage } from './quest-menu-layout.ts';

export const QUEST_ASSET_TIMEOUT_MS = 30_000;
export const QUEST_READY_SAVED =
  'Ready saved. Both robots stay idle. Combat controls are not in this stage.';
export const QUEST_LEAVING = 'Leaving the headset…';
/**
 * Quest-only locomotion, ring boundary, and separation rules:
 * - `boundary: 0.205`: leaves >= 0.01826 sim units (0.292 m) inside the smallest
 *   `Fight_Arena.glb` inner rope/post edge (`0.22326`), keeping a 180-degree turned
 *   eye anchor (`0.205 + 0.01522 = 0.22022`) inside the ropes while freeing ~0.48 m
 *   of ring space compared to phone AR (`0.175`).
 * - `separation: 0.065`: 1.04 m origin-to-origin at 16x VR scale, putting the
 *   opponent's head front at 0.349 m and head center at 0.595 m ahead of the
 *   wearer's eyes (0.675 m from shoulders) so a natural standing jab reaches
 *   the opponent's face and Stage 06 head/chest targets without leaning, while
 *   still preserving >= 0.149 m eye-to-idle-head clearance at full +0.20 m
 *   forward lean, >= 0.028 m chest-to-guard-glove clearance, >= 0.23 m walking
 *   toe-to-toe clearance, and `Combo_Punch` (`<= 0.114`) / AI reach (`0.095`).
 * - `stableFacing: true`: keeps player ring/body yaw fixed without opponent-orbit
 *   auto-turning while `QuestArenaSession` translates left-stick inputs into
 *   view-relative horizontal movement from live headset yaw.
 */
export const QUEST_ARENA_RULES = {
  boundary: 0.205,
  separation: 0.065,
  reach: 0.095,
  cpuPreferredRange: 0.075,
  cpuMinimumRange: 0.068,
  stableFacing: true,
  dashEnabled: true,
  dashTravel: 0.06,
  dashMinimum: 0.01,
  dashDuration: 0.24,
  dashRecovery: 0.25,
  dashStaminaCost: 0,
} as const;
/**
 * Temporary Stage 05 locomotion-test override: keeps the Quest solo opponent
 * stationary and non-attacking (`cpuEnabled: false`) without changing
 * `ArenaMatch` or `ArenaController` defaults for phone AR or other modes.
 * Remove when Quest Stage 06 combat/AI is integrated.
 */
export const QUEST_STAGE_05_IDLE_OPPONENT_RULES = { cpuEnabled: false } as const;
const sessionLease = 1;
const MAX_STEP_DT_S = 0.05;
const MAX_FRAME_DT_S = 0.1;

export type QuestReadyReason =
  'no-match' | 'loading' | 'started' | 'resumed' | 'rematched' | 'active';

export interface QuestReadyResult {
  called: boolean;
  started: boolean;
  reason: QuestReadyReason;
}

export interface QuestFighterPresentation {
  clip: string;
  animationId: number;
}

export interface QuestArenaView {
  page: QuestMenuPage;
  mode: 'solo' | null;
  stage: string | null;
  phase: string | null;
  placed: boolean;
  tracking: boolean;
  virtualReady: boolean;
  landscape: boolean;
  assetsLoaded: number;
  canReady: boolean;
  localReady: boolean;
  acknowledged: boolean;
  leaving: boolean;
  message: string | null;
  token: number | null;
  placementVersion: number | null;
  lease: number;
  /** Spawn/round-start transforms for initial mount; live frame movement uses getLiveTransforms(). */
  transforms: { blue: FighterTransform; red: FighterTransform } | null;
  fighters: { blue: QuestFighterPresentation; red: QuestFighterPresentation } | null;
  bodyClip: QuestFirstPersonBodyClip;
  animationsRunning: boolean;
  outcome: FighterId | 'draw' | null;
  lastReady: QuestReadyResult | null;
  lines: string[];
  /** menu before Solo, side until Ready, eyes after the intro. */
  presentation: 'menu' | 'side' | 'eyes';
  introActive: boolean;
}

export interface QuestClock {
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
  now?: () => number;
  scheduleFrame?: (callback: () => void) => unknown;
  cancelFrame?: (handle: unknown) => void;
}

const defaultClock: QuestClock = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => globalThis.performance?.now?.() ?? Date.now(),
  scheduleFrame: (callback) =>
    typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame(() => callback())
      : setTimeout(callback, 16),
  cancelFrame: (handle) => {
    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(handle as number);
    } else {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  },
};

function isActiveMatchStage(stage: string | null | undefined) {
  return (
    stage === 'countdown' ||
    stage === 'fighting' ||
    stage === 'presenting' ||
    stage === 'intermission'
  );
}

function menuLines(
  page: QuestMenuPage,
  stage: string | null,
  acknowledged: boolean,
  leaving: boolean
) {
  if (leaving) return [QUEST_LEAVING];
  if (page === 'menu') {
    return [
      'Solo places both robots in the ring.',
      'Select Ready in the ring to start; left thumbstick moves.',
    ];
  }
  if (stage === 'paused') return ['Match paused. Select Ready to resume.'];
  if (stage === 'finished') return ['Match finished. Select Ready for a rematch.'];
  if (stage === 'fighting')
    return [
      'Fight active. Left thumbstick moves relative to where you look; press A while moving to dash.',
    ];
  if (stage === 'countdown' || acknowledged) return ['Match starting. Left thumbstick moves.'];
  return ['Both robots are in the ring.', 'Select Ready when loaded to start.'];
}

export interface QuestArenaHeadSource {
  getLiveHeadState?: () => QuestLiveHeadState;
  getSnapshot?: () => { calibration: Calibration };
  subscribeLive?: (listener: (event: QuestHeadLiveEvent) => void) => () => void;
}

export function createQuestArenaSession(
  clock: QuestClock = defaultClock,
  headSource: QuestArenaHeadSource = questHeadTracker
) {
  const nowFn = clock.now ?? (() => Date.now());
  const scheduleFrame = clock.scheduleFrame ?? ((cb) => clock.schedule(cb, 16));
  const cancelFrame = clock.cancelFrame ?? ((handle) => clock.cancel(handle));

  let match: ArenaMatch | null = null;
  let unsubscribe: (() => void) | null = null;
  let page: QuestMenuPage = 'menu';
  let presentation: 'menu' | 'side' | 'eyes' = 'menu';
  let intro: {
    elapsed: number;
    duration: number;
    blend: number;
    opacity: number;
  } | null = null;
  let lastReady: QuestReadyResult | null = null;
  let acknowledged = false;
  let readyQueued = false;
  let leaving = false;
  let lease = 0;
  let disposed = false;
  let appActive = true;
  let menuFocused = false;
  let timer: unknown = null;
  let frameHandle: unknown = null;
  let loopRunning = false;
  let externalFrameDriver = false;
  let lastFrameMs: number | null = null;
  let spawnRoundKey = '';
  let spawnTransforms: { blue: FighterTransform; red: FighterTransform } | null = null;
  let latestInput: { sample: QuestInputSample | null; status: QuestInputStatus } = {
    sample: null,
    status: 'waiting',
  };
  let locomotion: QuestLocomotionCommand = { advance: 0, strafe: 0, active: false, magnitude: 0 };
  let dashTriggerState: QuestDashTriggerState = { armed: false };
  let view: QuestArenaView = emptyView();
  const listeners = new Set<() => void>();
  const frameListeners = new Set<(dtSeconds: number) => void>();

  function readHeadState(): QuestHeadLocomotionState & { referenceResets?: number } {
    if (typeof headSource.getLiveHeadState === 'function') {
      return headSource.getLiveHeadState();
    }
    return {
      calibration: headSource.getSnapshot?.()?.calibration ?? DEFAULT_CALIBRATION,
    };
  }

  let lastReferenceResets = readHeadState().referenceResets ?? 0;
  let recenterNeutral = false;
  let recenterSampleT: number | null = null;
  let recenterInputSeq: number | null = null;
  let bodyTracker = createQuestFirstPersonBodyTrackerState();

  function emptyView(): QuestArenaView {
    return {
      page,
      mode: null,
      stage: null,
      phase: null,
      placed: false,
      tracking: false,
      virtualReady: false,
      landscape: false,
      assetsLoaded: 0,
      canReady: false,
      localReady: false,
      acknowledged,
      leaving,
      message: null,
      token: null,
      placementVersion: null,
      lease: 0,
      transforms: null,
      fighters: null,
      bodyClip: 'IdleAggro',
      animationsRunning: false,
      outcome: null,
      lastReady,
      lines: menuLines(page, null, acknowledged, leaving),
      presentation,
      introActive: intro !== null,
    };
  }

  function currentAnalog(): AnalogMovement {
    if (!appActive || menuFocused) return { advance: 0, strafe: 0 };
    return { advance: locomotion.advance, strafe: locomotion.strafe };
  }

  function isBodyLocomotionActive(
    snapshot: ReturnType<ArenaMatch['getSnapshot']> | undefined,
    head: QuestHeadLocomotionState & { referenceResets?: number }
  ) {
    if (presentation !== 'eyes' || !snapshot) return false;
    if (
      snapshot.stage !== 'fighting' ||
      !snapshot.animationsRunning ||
      snapshot.impactPauseRemaining !== 0
    ) {
      return false;
    }
    if (!appActive || menuFocused || recenterNeutral || head.recentering) return false;
    if (latestInput.status !== 'live' || !latestInput.sample) return false;
    if (!latestInput.sample.focused || !latestInput.sample.actionsReady) return false;
    if (
      typeof latestInput.sample.refEpoch === 'number' &&
      typeof head.refEpoch === 'number' &&
      latestInput.sample.refEpoch !== head.refEpoch
    ) {
      return false;
    }
    return true;
  }

  function applyLocomotionToMatch() {
    if (!match) return;
    const snapshot = match.getSnapshot();
    const analog =
      snapshot.stage === 'fighting' && appActive ? currentAnalog() : { advance: 0, strafe: 0 };
    match.setAnalogMovement(analog, snapshot.roundId);
  }

  function neutralizeDash() {
    dashTriggerState = { armed: false };
    if (match?.cancelDash()) {
      notifyFrame(0);
    }
  }

  function evaluateDashForSample(
    sample: QuestInputSample | null,
    status: QuestInputStatus,
    head: QuestHeadLocomotionState & { referenceResets?: number }
  ) {
    const inActiveFight = match?.getSnapshot().stage === 'fighting';
    const evalResult = evaluateQuestDashInput(dashTriggerState, {
      sample,
      status,
      inActiveFight,
      menuFocused,
      appActive,
      recenterNeutral,
      head,
    });
    dashTriggerState = evalResult.nextState;
    if (evalResult.neutralized) {
      if (match?.cancelDash()) notifyFrame(0);
    } else if (evalResult.triggered && evalResult.direction && match) {
      match.dash(evalResult.direction, match.getSnapshot().roundId);
    }
  }

  function recomputeLocomotion() {
    const head = readHeadState();
    const resets =
      typeof head.referenceResets === 'number' ? head.referenceResets : lastReferenceResets;
    if (resets !== lastReferenceResets) {
      lastReferenceResets = resets;
      recenterNeutral = true;
      recenterSampleT = head.sample?.t ?? null;
      recenterInputSeq = latestInput.sample?.seq ?? null;
    } else if (
      recenterNeutral &&
      !head.recentering &&
      recenterSampleT !== null &&
      head.sample?.t !== undefined &&
      head.sample.t !== recenterSampleT
    ) {
      recenterNeutral = false;
    }

    if (recenterNeutral) {
      locomotion = { advance: 0, strafe: 0, active: false, magnitude: 0 };
      neutralizeDash();
    } else {
      if (
        head.recentering ||
        !appActive ||
        menuFocused ||
        (typeof latestInput.sample?.refEpoch === 'number' &&
          typeof head.refEpoch === 'number' &&
          latestInput.sample.refEpoch !== head.refEpoch)
      ) {
        neutralizeDash();
      }

      locomotion = questLocomotionFromInput({
        sample: latestInput.sample,
        status: latestInput.status,
        menuFocused,
        appActive,
        head,
      });
    }
    applyLocomotionToMatch();
    if (!isBodyLocomotionActive(match?.getSnapshot(), head) && bodyTracker.clip !== 'IdleAggro') {
      bodyTracker = createQuestFirstPersonBodyTrackerState();
      publish();
    }
    return head;
  }

  const stopHeadLive = headSource.subscribeLive?.((event) => {
    if (disposed) return;
    const head = readHeadState();
    if (event === 'recenter') {
      lastReferenceResets = head.referenceResets ?? lastReferenceResets;
      recenterNeutral = true;
      recenterSampleT = head.sample?.t ?? null;
      recenterInputSeq = latestInput.sample?.seq ?? null;
    } else if (event === 'sample' && recenterNeutral && !head.recentering) {
      if (head.sample?.t !== recenterSampleT) {
        recenterNeutral = false;
      }
    }
    recomputeLocomotion();
  });

  function publish() {
    const snapshot = match?.getSnapshot();
    if (
      !match ||
      !snapshot ||
      presentation !== 'eyes' ||
      snapshot.stage !== 'fighting' ||
      !snapshot.animationsRunning ||
      snapshot.impactPauseRemaining !== 0
    ) {
      if (bodyTracker.clip !== 'IdleAggro' || bodyTracker.candidateClip !== null) {
        bodyTracker = createQuestFirstPersonBodyTrackerState();
      }
    }
    if (match && snapshot) {
      const roundKey = `${lease}:${snapshot.roundId}`;
      if (!spawnTransforms || spawnRoundKey !== roundKey) {
        spawnRoundKey = roundKey;
        spawnTransforms = {
          blue: match.getTransform('blue'),
          red: match.getTransform('red'),
        };
      }
      if (snapshot.stage === 'paused' || snapshot.stage === 'finished') {
        acknowledged = false;
      }
    } else {
      spawnRoundKey = '';
      spawnTransforms = null;
    }

    const next: QuestArenaView =
      match && snapshot
        ? {
            page,
            mode: 'solo',
            stage: snapshot.stage,
            phase: snapshot.phase,
            placed: snapshot.placed,
            tracking: match.round.hasNormalTracking(),
            virtualReady: match.round.isVirtualReady(),
            landscape: match.isLandscape(),
            assetsLoaded: snapshot.assetsLoaded,
            canReady: snapshot.canReady,
            localReady: snapshot.localReady,
            acknowledged,
            leaving,
            message: snapshot.message,
            token: snapshot.sessionToken,
            placementVersion: snapshot.placementVersion,
            lease,
            transforms: spawnTransforms,
            fighters: {
              blue: { clip: snapshot.blue.clip, animationId: snapshot.blue.animationId },
              red: { clip: snapshot.red.clip, animationId: snapshot.red.animationId },
            },
            bodyClip: bodyTracker.clip,
            animationsRunning: snapshot.animationsRunning && snapshot.impactPauseRemaining === 0,
            outcome: snapshot.outcome,
            lastReady,
            lines: menuLines(page, snapshot.stage, acknowledged, leaving),
            presentation,
            introActive: intro !== null,
          }
        : emptyView();

    if (JSON.stringify(next) === JSON.stringify(view)) return;
    view = next;
    listeners.forEach((listener) => listener());
  }

  function clearTimer() {
    if (timer !== null) clock.cancel(timer);
    timer = null;
  }

  function cancelRafFrame() {
    if (frameHandle !== null) {
      cancelFrame(frameHandle);
      frameHandle = null;
    }
  }

  function stopLoop() {
    loopRunning = false;
    externalFrameDriver = false;
    lastFrameMs = null;
    cancelRafFrame();
  }

  function beginViewpointIntro() {
    if (presentation !== 'side' || intro) return;
    intro = { elapsed: 0, duration: 1.55, blend: 0, opacity: 0 };
  }

  function advanceIntro(dtSeconds: number) {
    if (!intro || dtSeconds <= 0) return;
    intro.elapsed += dtSeconds;
    // Pan from side view toward POV, reach opaque cover at blend <= 0.70 well before
    // entering Blue's head volume, swap to headless POV while opaque, then fade cover out.
    const panClearEnd = 0.85;
    const coverInEnd = 1.05;
    const coverHoldEnd = 1.25;
    if (intro.elapsed < panClearEnd) {
      intro.blend = 0.64 * (intro.elapsed / panClearEnd);
      intro.opacity = 0;
    } else if (intro.elapsed < coverInEnd) {
      const u = (intro.elapsed - panClearEnd) / (coverInEnd - panClearEnd);
      intro.blend = 0.64 + 0.06 * u;
      intro.opacity = u;
    } else if (intro.elapsed < coverHoldEnd) {
      const u = (intro.elapsed - coverInEnd) / (coverHoldEnd - coverInEnd);
      intro.blend = 0.7 + 0.3 * u;
      intro.opacity = 1;
      if (presentation !== 'eyes') {
        presentation = 'eyes';
        publish();
      }
    } else {
      intro.blend = 1;
      intro.opacity = Math.max(
        0,
        1 - (intro.elapsed - coverHoldEnd) / (intro.duration - coverHoldEnd)
      );
      if (presentation !== 'eyes') {
        presentation = 'eyes';
        publish();
      }
    }
    if (intro && intro.elapsed >= intro.duration) {
      intro = null;
      presentation = 'eyes';
      publish();
    }
  }

  function notifyFrame(dtSeconds = 0) {
    advanceIntro(dtSeconds);
    frameListeners.forEach((listener) => listener(dtSeconds));
  }

  function advanceSessionDt(token: number, rawDtSeconds: number) {
    if (!Number.isFinite(rawDtSeconds) || rawDtSeconds <= 0) return;
    const clampedDt = Math.min(MAX_FRAME_DT_S, rawDtSeconds);
    let remaining = clampedDt;
    let bodyClipChanged = false;
    while (remaining > 1e-6) {
      const stepDt = Math.min(MAX_STEP_DT_S, remaining);
      remaining -= stepDt;
      const head = recomputeLocomotion();
      const before = match?.getTransform('blue') ?? null;
      match?.tick(token, stepDt);
      const after = match?.getTransform('blue') ?? null;
      const snapshot = match?.getSnapshot();
      const bodyActive = isBodyLocomotionActive(snapshot, head);
      let forwardSpeed = 0;
      let leftSpeed = 0;
      if (bodyActive && before && after && stepDt > 1e-6) {
        const dx = after.x - before.x;
        const dz = after.z - before.z;
        const fwd = forward(after.yaw);
        const left = { x: fwd.z, z: -fwd.x };
        forwardSpeed = (dx * fwd.x + dz * fwd.z) / stepDt;
        leftSpeed = (dx * left.x + dz * left.z) / stepDt;
      }
      const nextBodyTracker = stepQuestFirstPersonBodyClip(bodyTracker, {
        active: bodyActive,
        running: Boolean(
          snapshot && snapshot.animationsRunning && snapshot.impactPauseRemaining === 0
        ),
        forwardSpeed,
        leftSpeed,
        dtSeconds: stepDt,
      });
      if (nextBodyTracker.clip !== bodyTracker.clip) {
        bodyClipChanged = true;
      }
      bodyTracker = nextBodyTracker;
    }
    if (bodyClipChanged) publish();
    notifyFrame(clampedDt);
  }

  function finishLoopStep() {
    if (!match) return;
    const snap = match.getSnapshot();
    if (!isActiveMatchStage(snap.stage) || !appActive) {
      stopLoop();
      publish();
    }
  }

  function onFrameTick() {
    frameHandle = null;
    if (disposed || !match || !loopRunning || externalFrameDriver) return;
    const token = match.getSessionToken();
    if (token === null || !appActive) {
      stopLoop();
      return;
    }

    const nowMs = nowFn();
    const rawDt = lastFrameMs === null ? 1 / 60 : (nowMs - lastFrameMs) / 1000;
    lastFrameMs = nowMs;

    advanceSessionDt(token, rawDt);
    finishLoopStep();
    if (loopRunning && !externalFrameDriver) {
      frameHandle = scheduleFrame(onFrameTick);
    }
  }

  function startLoop() {
    if (disposed || !match || !appActive || loopRunning) return;
    if (!isActiveMatchStage(match.getSnapshot().stage)) return;
    loopRunning = true;
    lastFrameMs = nowFn();
    if (!externalFrameDriver) {
      frameHandle = scheduleFrame(onFrameTick);
    }
  }

  function releaseMatch() {
    stopLoop();
    clearTimer();
    unsubscribe?.();
    unsubscribe = null;
    match?.dispose();
    match = null;
    page = 'menu';
    presentation = 'menu';
    intro = null;
    lastReady = null;
    acknowledged = false;
    readyQueued = false;
    spawnRoundKey = '';
    spawnTransforms = null;
    menuFocused = false;
    recenterNeutral = false;
    recenterSampleT = null;
    recenterInputSeq = null;
    locomotion = { advance: 0, strafe: 0, active: false, magnitude: 0 };
    dashTriggerState = { armed: false };
    bodyTracker = createQuestFirstPersonBodyTrackerState();
    notifyFrame(0);
  }

  function armAssetTimeout() {
    clearTimer();
    timer = clock.schedule(() => {
      timer = null;
      if (disposed || !match) return;
      const missing = match.firstMissingAsset();
      const snapshot = match.getSnapshot();
      if (!missing || snapshot.sessionToken === null) return;
      match.assetFailed(snapshot.sessionToken, snapshot.placementVersion, missing);
      publish();
    }, QUEST_ASSET_TIMEOUT_MS);
  }

  function tryStartReadyMatch(): QuestReadyResult {
    if (disposed || !match || leaving) {
      return { called: false, started: false, reason: 'no-match' };
    }
    const snap = match.getSnapshot();
    if (snap.stage === 'lobby') {
      if (snap.canReady) {
        const started = match.ready();
        if (started) {
          const token = match.getSessionToken();
          if (token !== null) match.tick(token, 1 / 60);
          acknowledged = true;
          readyQueued = false;
          beginViewpointIntro();
          startLoop();
          notifyFrame();
          return { called: true, started: true, reason: 'started' };
        }
      }
      readyQueued = true;
      acknowledged = true;
      return { called: false, started: false, reason: 'loading' };
    }
    if (snap.stage === 'paused' && snap.canResume) {
      const started = match.resume();
      if (started) {
        const token = match.getSessionToken();
        if (token !== null) match.tick(token, 1 / 60);
        acknowledged = true;
        readyQueued = false;
        beginViewpointIntro();
        startLoop();
        notifyFrame();
        return { called: true, started: true, reason: 'resumed' };
      }
    }
    if (snap.stage === 'finished' && snap.canRematch) {
      const started = match.rematch();
      if (started) {
        const token = match.getSessionToken();
        if (token !== null) match.tick(token, 1 / 60);
        acknowledged = true;
        readyQueued = false;
        spawnRoundKey = '';
        beginViewpointIntro();
        startLoop();
        notifyFrame();
        return { called: true, started: true, reason: 'rematched' };
      }
    }
    return { called: false, started: false, reason: 'active' };
  }

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onFrame: (listener: (dtSeconds: number) => void) => {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    getSnapshot: () => view,
    getLiveTransforms: (): { blue: FighterTransform; red: FighterTransform } | null =>
      match
        ? {
            blue: match.getTransform('blue'),
            red: match.getTransform('red'),
          }
        : null,
    getLocomotion: (): QuestLocomotionCommand => ({ ...locomotion }),
    isDashing: (): boolean => match?.round.isDashing('blue') ?? false,
    solo() {
      if (disposed || leaving || page === 'ring') return false;
      const created = new ArenaMatch('solo', 3, undefined, {
        ...QUEST_ARENA_RULES,
        ...QUEST_STAGE_05_IDLE_OPPONENT_RULES,
      });
      unsubscribe = created.subscribe(() => publish());
      const token = created.attachSession(sessionLease);
      // Immersive VRActivity is already playable orientation and virtual ring; never assert AR tracking/placement.
      created.setLandscape(true);
      created.setVirtualReady(token, true);
      created.setAppActive(appActive);
      if (created.round.hasNormalTracking() || created.getSnapshot().placed) {
        throw new Error('Solo setup asserted tracking or an AR placement.');
      }
      lease += 1;
      match = created;
      page = 'ring';
      presentation = 'side';
      intro = null;
      lastReady = null;
      acknowledged = false;
      readyQueued = false;
      spawnRoundKey = '';
      spawnTransforms = null;
      armAssetTimeout();
      publish();
      return true;
    },
    ready() {
      const result = tryStartReadyMatch();
      lastReady = result;
      publish();
      return result;
    },
    getRigBlend() {
      if (!intro) return presentation === 'side' ? 0 : 1;
      return intro.blend;
    },
    getIntroOpacity() {
      return intro?.opacity ?? 0;
    },
    setInputState(
      sample: QuestInputSample | null,
      status: QuestInputStatus,
      batch?: readonly QuestInputSample[]
    ) {
      const samples = batch && batch.length > 0 && status === 'live' ? batch : [sample];
      for (const nextSample of samples) {
        if (recenterNeutral) {
          const head = readHeadState();
          if (!head.recentering && (nextSample === null || nextSample.seq !== recenterInputSeq)) {
            recenterNeutral = false;
          }
        }
        latestInput = { sample: nextSample, status };
        const head = recomputeLocomotion();
        evaluateDashForSample(nextSample, status, head);
      }
    },
    setMenuFocus(focused: boolean) {
      if (menuFocused === focused) return;
      menuFocused = focused;
      if (focused) neutralizeDash();
      recomputeLocomotion();
      if (focused) notifyFrame(0);
    },
    setAppActive(active: boolean) {
      if (appActive === active) return;
      appActive = active;
      if (!active) neutralizeDash();
      recomputeLocomotion();
      if (!match) return;
      match.setAppActive(active);
      if (!active) {
        stopLoop();
        match.setAnalogMovement({ advance: 0, strafe: 0 });
        notifyFrame(0);
      } else if (readyQueued && match.getSnapshot().canReady) {
        lastReady = tryStartReadyMatch();
      } else if (isActiveMatchStage(match.getSnapshot().stage)) {
        startLoop();
      }
      publish();
    },
    stepExternalFrame(dtSeconds: number) {
      if (disposed || !match || !loopRunning || !appActive) return;
      const token = match.getSessionToken();
      if (token === null) {
        stopLoop();
        return;
      }
      if (!externalFrameDriver) {
        externalFrameDriver = true;
        cancelRafFrame();
      }
      lastFrameMs = null;
      advanceSessionDt(token, dtSeconds);
      finishLoopStep();
    },
    getBodyClip() {
      return bodyTracker.clip;
    },
    animationApplied(id: FighterId, animationId: number) {
      match?.animationApplied(id, animationId);
    },
    back() {
      if (disposed || leaving || page !== 'ring') return 'menu' as const;
      releaseMatch();
      publish();
      return 'menu' as const;
    },
    exit() {
      if (!disposed) {
        leaving = true;
        releaseMatch();
      }
      publish();
    },
    assetLoaded(callbackLease: number, token: number, version: number, asset: ArenaAsset) {
      if (disposed || !match || callbackLease !== lease) return;
      match.assetLoaded(token, version, asset);
      if (!match.firstMissingAsset()) {
        clearTimer();
        if (readyQueued && match.getSnapshot().canReady) {
          lastReady = tryStartReadyMatch();
        }
      }
      publish();
    },
    assetFailed(callbackLease: number, token: number, version: number, asset: ArenaAsset) {
      if (disposed || !match || callbackLease !== lease) return;
      readyQueued = false;
      match.assetFailed(token, version, asset);
      clearTimer();
      stopLoop();
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopHeadLive?.();
      releaseMatch();
      frameListeners.clear();
      publish();
    },
  };
}

export type QuestArenaSession = ReturnType<typeof createQuestArenaSession>;
