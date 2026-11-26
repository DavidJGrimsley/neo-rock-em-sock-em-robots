import { ArenaMatch } from '../arena-fighter/arena-match.ts';
import { forward } from '../arena-fighter/arena-combat-motion.ts';
import {
  ARENA_RULES,
  type AnalogMovement,
  type ArenaAsset,
  type FighterId,
  type FighterTransform,
} from '../arena-fighter/arena-controller.ts';
import {
  type QuestCombatHudEvent,
  type QuestCombatHudEventKind,
  type QuestCombatHudState,
  type QuestEvadeHudStatus,
} from './quest-combat-hud.ts';
import {
  createQuestFirstPersonBodyTrackerState,
  stepQuestFirstPersonBodyClip,
  type QuestFirstPersonBodyClip,
} from './quest-first-person-body.ts';
import {
  createQuestGestureClassifier,
  QUEST_COMBAT_GESTURE_THRESHOLDS,
  type QuestBodyFrame,
} from './quest-gesture.ts';
import {
  DEFAULT_CALIBRATION,
  gameplayHeadPose,
  yawFromForward,
  type Calibration,
} from './quest-head-rig.ts';
import {
  questHeadTracker,
  type QuestHeadLiveEvent,
  type QuestLiveHeadState,
} from './quest-head-tracker.ts';
import type { QuestInputSample } from './quest-input.ts';
import { QUEST_INPUT_STALE_NS, type QuestInputStatus } from './quest-input-source.ts';
import {
  QUEST_HEAD_SAMPLE_STALE_MS,
  QUEST_STICK_DEADZONE,
  evaluateQuestDashInput,
  evaluateQuestPauseInput,
  evaluateQuestTurnInput,
  questLocomotionFromInput,
  resolveQuestHeadHeading,
  type QuestDashTriggerState,
  type QuestHeadLocomotionState,
  type QuestLocomotionCommand,
  type QuestPauseTriggerState,
  type QuestTurnTriggerState,
} from './quest-locomotion.ts';
import type { QuestMenuPage } from './quest-menu-layout.ts';
import {
  QuestCombatFeedbackStream,
  type QuestCombatFeedbackEvent,
} from './quest-combat-feedback.ts';
import {
  DEFAULT_QUEST_SETTINGS,
  QUEST_TUNING,
  questHapticPatternForFeedback,
  type QuestUserSettings,
} from './quest-tuning.ts';

export const QUEST_ASSET_TIMEOUT_MS = 30_000;
export const QUEST_READY_SAVED = 'Ready saved. Enter the ring to fight.';
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
  uppercutReach: 0.073,
  uppercutActiveEnd: 0.68,
  uppercutWindow: QUEST_TUNING.cpu.uppercutWindow,
  cpuPreferredRange: QUEST_TUNING.cpu.preferredRange,
  cpuMinimumRange: QUEST_TUNING.cpu.minimumRange,
  stableFacing: true,
  dashEnabled: true,
  dashTravel: 0.06,
  dashMinimum: 0.01,
  dashDuration: 0.24,
  dashRecovery: 0.25,
  dashStaminaCost: 0,
  headEvasionEnabled: true,
  evadeDuration: 0.75,
  evadeCooldown: 0.35,
  guardStartup: 0.05,
  punchDefenseLock: QUEST_TUNING.hitReactions.lightDuration,
  counterpunchRecovery: QUEST_TUNING.hitReactions.counterpunchRecovery,
  combatFeelEnabled: true,
  lightHitLock: QUEST_TUNING.hitReactions.lightDuration,
  mediumHitLock: QUEST_TUNING.hitReactions.mediumDuration,
  heavyStaggerDuration: QUEST_TUNING.hitReactions.heavyStaggerDuration,
  guardBreakStaggerDuration: QUEST_TUNING.hitReactions.guardBreakStaggerDuration,
  poiseMax: QUEST_TUNING.hitReactions.poiseMax,
  poisePunchDamage: QUEST_TUNING.hitReactions.poisePunchDamage,
  poiseUppercutDamage: QUEST_TUNING.hitReactions.poiseUppercutDamage,
  poiseRecoveryPerSec: QUEST_TUNING.hitReactions.poiseRecoveryPerSec,
  poiseRecoveryDelay: QUEST_TUNING.hitReactions.poiseRecoveryDelay,
  antiStunlockWindow: QUEST_TUNING.hitReactions.antiStunlockWindow,
  antiStunlockMaxChain: QUEST_TUNING.hitReactions.antiStunlockMaxChain,
  antiStunlockHyperArmor: QUEST_TUNING.hitReactions.antiStunlockHyperArmor,
  dodgeCounterWindow: QUEST_TUNING.dodge.counterWindow,
  dodgeCounterDamageMultiplier: QUEST_TUNING.dodge.counterDamageMultiplier,
  cpuStateMachineEnabled: true,
  cpuMaxSpeedRatio: QUEST_TUNING.cpu.maxSpeedRatio,
  cpuHoldRangeTolerance: QUEST_TUNING.cpu.holdRangeTolerance,
  cpuHoldWindowMin: QUEST_TUNING.cpu.holdWindowMin,
  cpuHoldWindowMax: QUEST_TUNING.cpu.holdWindowMax,
  cpuTelegraphPunchWindow: QUEST_TUNING.cpu.telegraphPunchWindow,
  cpuTelegraphUppercutWindow: QUEST_TUNING.cpu.telegraphUppercutWindow,
  cpuRecoveryWindow: QUEST_TUNING.cpu.recoveryWindow,
  cpuResetWindow: QUEST_TUNING.cpu.resetWindow,
  cpuRetreatChance: QUEST_TUNING.cpu.retreatChance,
  cpuGuardChance: QUEST_TUNING.cpu.guardChance,
  cpuPauseChance: QUEST_TUNING.cpu.pauseChance,
  cpuFeintChance: QUEST_TUNING.cpu.feintChance,
  cpuRequireFov: QUEST_TUNING.cpu.requireFov,
  cpuFovHalfDeg: QUEST_TUNING.cpu.fovHalfDeg,
  cpuTurnDegPerSec: QUEST_TUNING.cpu.turnDegPerSec,
  reactionRecoilTravel: QUEST_TUNING.hitReactions.recoilTravel,
  cpuFirstDelay: QUEST_TUNING.cpu.firstDelay,
  cpuRecovery: QUEST_TUNING.cpu.recoveryWindow,
  cpuReaction: QUEST_TUNING.cpu.reaction,
  cpuGuardReaction: QUEST_TUNING.cpu.guardReaction,
  cpuRewardReaction: QUEST_TUNING.cpu.rewardReaction,
} as const;
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
  paused: boolean;
  appActive: boolean;
  pauseCalibration: Calibration | null;
  menuVisible: boolean;
  menuButtonAvailable: boolean | null;
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
  combatHud: QuestCombatHudState | null;
  settings: QuestUserSettings;
}

export type QuestHapticTrigger = (
  handMask: number,
  amplitude: number,
  durationMs: number
) => boolean;

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
  leaving: boolean,
  outcome: FighterId | 'draw' | null = null,
  menuButtonAvailable: boolean | null = null
) {
  if (leaving) return [QUEST_LEAVING];
  if (page === 'menu') {
    return [
      'Solo places both robots in the ring.',
      'Select Ready in the ring to start; left thumbstick moves.',
    ];
  }
  if (page === 'pause' || stage === 'paused') {
    return [
      'Match paused. Select Resume to continue fighting.',
      ...(menuButtonAvailable === false
        ? ['Left controller Menu button unavailable on this profile.']
        : []),
    ];
  }
  if (stage === 'finished') {
    if (outcome === 'blue') return ['You won! Select Ready for a rematch.'];
    if (outcome === 'red') return ['Red Mike won. Select Ready for a rematch.'];
    if (outcome === 'draw') return ['Draw! Select Ready for a rematch.'];
    return ['Match finished. Select Ready for a rematch.'];
  }
  if (stage === 'fighting')
    return [
      'Fight active. Punch, uppercut when ready, raise both hands to guard, duck or weave, and use the left thumbstick + A to move or dash.',
    ];
  if (stage === 'countdown' || acknowledged) return ['Match starting. Left thumbstick moves.'];
  return ['Both robots are in the ring.', 'Select Ready when loaded to start.'];
}

export interface QuestArenaHeadSource {
  getLiveHeadState?: () => QuestLiveHeadState;
  getSnapshot?: () => { calibration: Calibration };
  subscribeLive?: (listener: (event: QuestHeadLiveEvent) => void) => () => void;
  applyTurnDelta?: (deltaYawDeg: number) => void;
}

function noopHapticTrigger() {
  return false;
}

export function createQuestArenaSession(
  clock: QuestClock = defaultClock,
  headSource: QuestArenaHeadSource = questHeadTracker,
  rulesOverride?: Partial<typeof ARENA_RULES>,
  initialHapticTrigger: QuestHapticTrigger = noopHapticTrigger
) {
  let activeHapticTrigger: QuestHapticTrigger = initialHapticTrigger;
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
  let pauseTriggerState: QuestPauseTriggerState = {
    armed: false,
    lastToggleMs: -QUEST_TUNING.pause.debounceMs,
    menuAvailable: null,
  };
  let turnTriggerState: QuestTurnTriggerState = { snapArmed: false };
  let lastActionSample: QuestInputSample | null = null;
  let locomotionNeedsNeutral = false;
  let paused = false;
  let pauseCalibration: Calibration | null = null;
  let settings: QuestUserSettings = { ...DEFAULT_QUEST_SETTINGS };
  let damageTintOpacity = 0;
  let damageTintFadePerSecond = 0;
  const feedbackStream = new QuestCombatFeedbackStream();
  const feedbackListeners = new Set<(event: QuestCombatFeedbackEvent) => void>();
  let view: QuestArenaView = emptyView();
  const listeners = new Set<() => void>();
  const frameListeners = new Set<(dtSeconds: number) => void>();

  type QuestHeadStateSnapshot = QuestHeadLocomotionState & {
    referenceResets?: number;
    calibration?: Partial<Calibration> | null;
  };

  function readHeadState(): QuestHeadStateSnapshot {
    if (typeof headSource.getLiveHeadState === 'function') {
      return headSource.getLiveHeadState();
    }
    return {
      calibration: headSource.getSnapshot?.()?.calibration ?? DEFAULT_CALIBRATION,
    };
  }

  function frameFromHeadState(head: QuestHeadStateSnapshot): QuestBodyFrame {
    const cal = head.calibration;
    const yaw =
      typeof cal?.yaw === 'number' && Number.isFinite(cal.yaw) ? cal.yaw : DEFAULT_CALIBRATION.yaw;
    const origin =
      Array.isArray(cal?.origin) &&
      cal.origin.length >= 3 &&
      cal.origin.slice(0, 3).every(Number.isFinite)
        ? ([cal.origin[0], cal.origin[1], cal.origin[2]] as const)
        : DEFAULT_CALIBRATION.origin;
    return { yaw, origin };
  }

  function fullCalibrationFromHeadState(head: QuestHeadStateSnapshot): Calibration | null {
    const cal = head.calibration;
    if (!cal || typeof cal.yaw !== 'number' || !Number.isFinite(cal.yaw)) return null;
    if (
      !Array.isArray(cal.origin) ||
      cal.origin.length < 3 ||
      !cal.origin.slice(0, 3).every(Number.isFinite)
    ) {
      return null;
    }
    return {
      origin: [cal.origin[0], cal.origin[1], cal.origin[2]],
      yaw: cal.yaw,
      posture: cal.posture === 'seated' ? 'seated' : 'standing',
      source: cal.source === 'solo' || cal.source === 'system' ? cal.source : 'default',
      entry: typeof cal.entry === 'number' && Number.isFinite(cal.entry) ? cal.entry : 0,
    };
  }

  let lastReferenceResets = readHeadState().referenceResets ?? 0;
  let recenterNeutral = false;
  let recenterSampleT: number | null = null;
  let recenterInputSeq: number | null = null;
  let bodyTracker = createQuestFirstPersonBodyTrackerState();
  let activeGestureFrame: QuestBodyFrame = frameFromHeadState(readHeadState());
  const gestureClassifier = createQuestGestureClassifier({
    poseSource: 'grip',
    frame: activeGestureFrame,
    thresholds: QUEST_COMBAT_GESTURE_THRESHOLDS,
    followLiveHead: true,
  });
  let desiredGuardHeld = false;
  let guardNeedsPhysicalRelease = false;
  let latestInputNowNs: number | null | undefined = undefined;
  let lastProcessedLiveKey: {
    generation: number;
    refEpoch: number;
    seq: number;
    capturedNs: number;
  } | null = null;
  let dispatchedGuardHeld = false;
  let dispatchedGuardRoundId: number | null = null;
  let hudClockS = 0;
  let hudEventSeq = 0;
  let activeHudEvent: QuestCombatHudEvent | null = null;
  let hudEventExpiresAt = 0;
  let lastEvadeKind: 'duck' | 'weave' | null = null;

  function emitHudEvent(
    kind: QuestCombatHudEventKind,
    label: string,
    tone: QuestCombatHudEvent['tone'],
    ttlSeconds = 1.05
  ) {
    activeHudEvent = { id: ++hudEventSeq, kind, label, tone };
    hudEventExpiresAt = hudClockS + ttlSeconds;
  }

  function triggerHapticSafe(handMask: number, amplitude: number, durationMs: number) {
    if (!appActive || paused || menuFocused || presentation !== 'eyes' || (handMask & 3) === 0)
      return;
    try {
      activeHapticTrigger(handMask, amplitude, durationMs);
    } catch {
      // Haptic failures must never interrupt combat simulation.
    }
  }

  function buildCombatHud(
    snapshot: ReturnType<ArenaMatch['getSnapshot']>
  ): QuestCombatHudState | null {
    if (!match || presentation !== 'eyes') return null;
    const telemetry = match.getQuestCombatTelemetry();
    const blue = snapshot.blue;
    const red = snapshot.red;
    const evadeStatus: QuestEvadeHudStatus = !telemetry.headEvasionEnabled
      ? 'unavailable'
      : telemetry.evadeOutOfBounds
        ? 'oob'
        : telemetry.evadeActive
          ? 'active'
          : telemetry.evadeCooldownRemaining > 0
            ? 'cooldown'
            : telemetry.evadingPose && !telemetry.evadeArmed
              ? 'recenter-to-rearm'
              : 'armed';

    const incomingAttack =
      telemetry.redAttacking && !telemetry.redAttacking.hitChecked
        ? { kind: telemetry.redAttacking.kind, hand: telemetry.redAttacking.hand }
        : null;
    const quantizedStamina =
      blue.guardStamina <= 0
        ? 0
        : blue.guardStamina < 5
          ? Math.ceil(blue.guardStamina)
          : Math.min(telemetry.guardCapacity, Math.round(blue.guardStamina / 5) * 5);

    return {
      stage: snapshot.stage,
      outcome: snapshot.outcome,
      playerHealth: blue.health,
      playerMaxHealth: telemetry.maxHealth,
      playerMode: blue.mode,
      playerGuardStamina: quantizedStamina,
      playerGuardMaxStamina: telemetry.guardCapacity,
      playerGuardState: blue.guardState,
      playerGuardHeld: blue.guardHeld,
      playerPunchProgress: blue.punchProgress,
      playerUppercutReady: blue.uppercutReady,
      playerUppercutWindowRemaining: Math.ceil(Math.max(0, blue.uppercutWindowRemaining) * 4) / 4,
      opponentHealth: red.health,
      opponentMaxHealth: telemetry.maxHealth,
      opponentGuardState: red.guardState,
      opponentMode: red.mode,
      opponentAiState: telemetry.redAiState,
      inPunchRange: telemetry.distance <= telemetry.reach + 0.002,
      inUppercutRange: telemetry.distance <= telemetry.uppercutReach + 0.002,
      evadeStatus,
      evadeKind: lastEvadeKind,
      evadeRemaining: Math.ceil(telemetry.evadeRemaining * 4) / 4,
      evadeCooldownRemaining: Math.ceil(telemetry.evadeCooldownRemaining * 4) / 4,
      dodgeCounterRemaining: Math.ceil(telemetry.dodgeCounterRemaining * 4) / 4,
      incomingAttack,
      telegraphAttack: telemetry.redTelegraph
        ? {
            kind: telemetry.redTelegraph.kind,
            hand: telemetry.redTelegraph.hand,
            remaining: Math.ceil(telemetry.redTelegraph.remaining * 4) / 4,
          }
        : null,
      event: activeHudEvent,
    };
  }

  function computeMenuVisible(stage: string | null) {
    if (leaving || page === 'menu' || page === 'pause' || paused) return true;
    if (intro !== null) return false;
    if (presentation === 'eyes') {
      return stage === 'finished' || stage === 'paused';
    }
    return !isActiveMatchStage(stage);
  }

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
      paused,
      appActive,
      pauseCalibration: null,
      menuVisible: computeMenuVisible(null),
      menuButtonAvailable: pauseTriggerState.menuAvailable,
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
      lines: menuLines(page, null, acknowledged, leaving, null, pauseTriggerState.menuAvailable),
      presentation,
      introActive: intro !== null,
      combatHud: null,
      settings,
    };
  }

  function currentAnalog(): AnalogMovement {
    const isCombatPaused = paused || page === 'pause';
    if (!appActive || menuFocused || isCombatPaused || locomotionNeedsNeutral)
      return { advance: 0, strafe: 0 };
    return { advance: locomotion.advance, strafe: locomotion.strafe };
  }

  function isBodyLocomotionActive(
    snapshot: ReturnType<ArenaMatch['getSnapshot']> | undefined,
    head: QuestHeadStateSnapshot
  ) {
    if (presentation !== 'eyes' || !snapshot || paused || page === 'pause') return false;
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

  function isInputFreshForCombat(
    sample: QuestInputSample | null,
    nowNs: number | null | undefined
  ) {
    if (!sample || !Number.isFinite(sample.capturedNs)) return false;
    if (nowNs === null) return false;
    if (typeof nowNs !== 'number') return true;
    if (!Number.isFinite(nowNs) || nowNs < sample.capturedNs) return false;
    return nowNs - sample.capturedNs <= QUEST_INPUT_STALE_NS;
  }

  function hasTrackedCombatGrip(sample: QuestInputSample) {
    return sample.left.grip?.tracking === 'tracked' || sample.right.grip?.tracking === 'tracked';
  }

  function isCombatInputGateOpen(
    snapshot: ReturnType<ArenaMatch['getSnapshot']> | undefined,
    head: QuestHeadStateSnapshot,
    sample: QuestInputSample | null,
    status: QuestInputStatus,
    nowNs: number | null | undefined = latestInputNowNs
  ) {
    if (!match || !snapshot || presentation !== 'eyes' || paused || page === 'pause') return false;
    if (snapshot.stage !== 'fighting' || !snapshot.animationsRunning) return false;
    if (!appActive || menuFocused || recenterNeutral || head.recentering) return false;
    if (status !== 'live' || !sample || !sample.focused || !sample.actionsReady) return false;
    if (!isInputFreshForCombat(sample, nowNs)) return false;
    if (!hasTrackedCombatGrip(sample)) return false;
    if (
      typeof sample.refEpoch === 'number' &&
      typeof head.refEpoch === 'number' &&
      sample.refEpoch !== head.refEpoch
    ) {
      return false;
    }
    return true;
  }

  function dispatchSessionGuard(held: boolean, roundId: number) {
    if (!held) {
      if (dispatchedGuardRoundId === roundId && !dispatchedGuardHeld) return;
      dispatchedGuardHeld = false;
      dispatchedGuardRoundId = roundId;
      match?.block(false, roundId);
      return;
    }
    dispatchedGuardHeld = true;
    dispatchedGuardRoundId = roundId;
    match?.block(true, roundId);
  }

  function releaseSessionGuard(roundId?: number) {
    const snap = match?.getSnapshot();
    const targetRound = roundId ?? snap?.roundId;
    const roundGuardHeld = snap !== undefined && (snap.blue.guardHeld || snap.blue.pendingBlock);
    const trackedHeldInRound =
      targetRound !== undefined && dispatchedGuardHeld && dispatchedGuardRoundId === targetRound;
    if (desiredGuardHeld || guardNeedsPhysicalRelease || roundGuardHeld || trackedHeldInRound) {
      desiredGuardHeld = false;
      guardNeedsPhysicalRelease = false;
      if (
        targetRound !== undefined &&
        (trackedHeldInRound || roundGuardHeld) &&
        !(dispatchedGuardRoundId === targetRound && !dispatchedGuardHeld)
      ) {
        dispatchedGuardHeld = false;
        dispatchedGuardRoundId = targetRound;
        match?.block(false, targetRound);
      }
    }
  }

  function syncGestureFrame(head: QuestHeadStateSnapshot) {
    const nextFrame = frameFromHeadState(head);
    if (
      nextFrame.yaw !== activeGestureFrame.yaw ||
      nextFrame.origin[0] !== activeGestureFrame.origin[0] ||
      nextFrame.origin[1] !== activeGestureFrame.origin[1] ||
      nextFrame.origin[2] !== activeGestureFrame.origin[2]
    ) {
      activeGestureFrame = nextFrame;
      const intents = gestureClassifier.setFrame(nextFrame);
      if (intents.some((intent) => intent.type === 'guard' && !intent.held)) {
        releaseSessionGuard();
      }
    }
  }

  function updateGestureFrameForTurn(head: QuestHeadStateSnapshot) {
    const nextFrame = frameFromHeadState(head);
    activeGestureFrame = nextFrame;
    gestureClassifier.updateFrame(nextFrame);
  }

  function capturePauseCalibration(head: QuestHeadStateSnapshot): Calibration {
    const baseCal = fullCalibrationFromHeadState(head) ?? DEFAULT_CALIBRATION;
    const lookYaw = head.sample ? yawFromForward(head.sample.forward) : null;
    return head.sample
      ? {
          ...baseCal,
          origin: [...head.sample.position],
          yaw: lookYaw ?? baseCal.yaw,
        }
      : {
          ...baseCal,
          origin: [...baseCal.origin],
        };
  }

  function neutralizeCombatGestures(head = readHeadState()) {
    lastProcessedLiveKey = null;
    releaseSessionGuard();
    match?.setHeadEvasion(null);
    gestureClassifier.push({
      sample: latestInput.sample,
      status: 'unfocused',
      recentering: recenterNeutral || head.recentering === true,
      headRefEpoch: head.refEpoch ?? null,
    });
  }

  function neutralizePausedInput() {
    locomotionNeedsNeutral = true;
    locomotion = { advance: 0, strafe: 0, active: false, magnitude: 0 };
    turnTriggerState = { snapArmed: false };
    pauseTriggerState = { ...pauseTriggerState, armed: false };
    damageTintOpacity = 0;
    activeHudEvent = null;
    lastEvadeKind = null;
    neutralizeDash();
    neutralizeCombatGestures();
  }

  function isHeadSampleFresh(head: QuestHeadStateSnapshot) {
    const sample = head.sample;
    if (!sample || !Number.isFinite(sample.t)) return false;
    if (head.nowMs === undefined) return true;
    const staleMs =
      typeof head.staleMs === 'number' && Number.isFinite(head.staleMs) && head.staleMs > 0
        ? head.staleMs
        : QUEST_HEAD_SAMPLE_STALE_MS;
    return Number.isFinite(head.nowMs) && head.nowMs - sample.t <= staleMs;
  }

  function syncHeadEvasion(head: QuestHeadStateSnapshot) {
    if (!match) return;
    const snap = match.getSnapshot();
    if (
      !isCombatInputGateOpen(snap, head, latestInput.sample, latestInput.status, latestInputNowNs)
    ) {
      match.setHeadEvasion(null, snap.roundId);
      return;
    }
    const cal = fullCalibrationFromHeadState(head);
    if (!cal || !head.sample || !isHeadSampleFresh(head)) {
      lastEvadeKind = null;
      match.setHeadEvasion(null, snap.roundId);
      return;
    }
    const pose = gameplayHeadPose(cal, head.sample);
    const duck = pose.vertical <= -QUEST_COMBAT_GESTURE_THRESHOLDS.duckEnterM;
    const weave = Math.abs(pose.lateral) >= QUEST_COMBAT_GESTURE_THRESHOLDS.weaveEnterM;
    lastEvadeKind = duck ? 'duck' : weave ? 'weave' : null;
    match.setHeadEvasion(
      {
        duck,
        weave,
        outOfBounds: pose.outOfBounds,
      },
      snap.roundId
    );
  }

  function evaluateCombatForSample(
    sample: QuestInputSample | null,
    status: QuestInputStatus,
    head: QuestHeadStateSnapshot,
    nowNs?: number | null,
    isDuplicateLiveSample = false
  ) {
    syncGestureFrame(head);
    const snap = match?.getSnapshot();
    const combatOpen = isCombatInputGateOpen(snap, head, sample, status, nowNs);
    if (isDuplicateLiveSample && combatOpen && match && snap) {
      if (snap.blue.guardState === 'exhausted') {
        guardNeedsPhysicalRelease = true;
      }
      if (
        desiredGuardHeld &&
        !guardNeedsPhysicalRelease &&
        !snap.blue.guardHeld &&
        snap.blue.canBlock &&
        !snap.blue.pendingBlock
      ) {
        dispatchSessionGuard(true, snap.roundId);
      }
      syncHeadEvasion(head);
      return;
    }
    if (!combatOpen || !sample) {
      lastProcessedLiveKey = null;
    } else {
      lastProcessedLiveKey = {
        generation: sample.generation,
        refEpoch: sample.refEpoch,
        seq: sample.seq,
        capturedNs: sample.capturedNs,
      };
    }
    const freshHead = head.sample && isHeadSampleFresh(head) ? head.sample : null;
    const intents = gestureClassifier.push({
      sample,
      status: combatOpen ? status : 'unfocused',
      head: freshHead,
      calibration: null,
      headRefEpoch: head.refEpoch ?? null,
      recentering: recenterNeutral || head.recentering === true,
      nowNs,
    });
    if (!match || !snap || !combatOpen) {
      releaseSessionGuard(snap?.roundId);
      match?.setHeadEvasion(null, snap?.roundId);
      return;
    }
    if (snap.blue.guardState === 'exhausted') {
      guardNeedsPhysicalRelease = true;
    }
    for (const intent of intents) {
      if (intent.type === 'guard') {
        desiredGuardHeld = intent.held;
        if (!intent.held) {
          guardNeedsPhysicalRelease = false;
          dispatchSessionGuard(false, snap.roundId);
        } else if (!guardNeedsPhysicalRelease) {
          dispatchSessionGuard(true, snap.roundId);
        }
      } else if (intent.type === 'punch' || intent.type === 'uppercut') {
        const hand: 'L' | 'R' = intent.hand === 'left' ? 'L' : 'R';
        const latest = match.getSnapshot();
        const telemetry = match.getQuestCombatTelemetry();
        const accepted = match.attack(intent.type, latest.roundId, hand);
        if (accepted) {
          const reqReach = intent.type === 'uppercut' ? telemetry.uppercutReach : telemetry.reach;
          if (telemetry.distance > reqReach + 0.004) {
            emitHudEvent('out-of-range', 'OUT OF RANGE — STEP CLOSER', 'warning', 0.9);
          }
        } else if (intent.type === 'uppercut' && !latest.blue.uppercutReady) {
          emitHudEvent(
            'uppercut-not-ready',
            `UPPERCUT LOCKED (${latest.blue.punchProgress}/3 HITS)`,
            'warning',
            0.9
          );
        } else if (
          desiredGuardHeld ||
          ((latest.blue.guardHeld ||
            latest.blue.guardState === 'holding' ||
            latest.blue.guardState === 'raising') &&
            dispatchedGuardHeld)
        ) {
          emitHudEvent('drop-guard', 'LOWER HANDS TO PUNCH', 'warning', 0.85);
        } else if (
          latest.blue.defenseLockRemaining > 0 ||
          latest.blue.guardRecoveryRemaining > 0 ||
          latest.blue.punchRecoveryRemaining > 0 ||
          latest.blue.punchRestRemaining > 0
        ) {
          emitHudEvent('recovering', 'STAGGERED / RECOVERING', 'warning', 0.75);
        }
        publish();
      }
    }
    if (desiredGuardHeld && !guardNeedsPhysicalRelease) {
      const latestSnap = match.getSnapshot();
      if (latestSnap.blue.guardState === 'exhausted') {
        guardNeedsPhysicalRelease = true;
      } else if (
        !latestSnap.blue.guardHeld &&
        latestSnap.blue.canBlock &&
        !latestSnap.blue.pendingBlock
      ) {
        dispatchSessionGuard(true, latestSnap.roundId);
      }
    }
    syncHeadEvasion(head);
  }

  function applyLocomotionToMatch(head?: QuestHeadStateSnapshot) {
    if (!match) return;
    const snapshot = match.getSnapshot();
    const analog =
      snapshot.stage === 'fighting' && appActive ? currentAnalog() : { advance: 0, strafe: 0 };
    match.setAnalogMovement(analog, snapshot.roundId);
    if (head && snapshot.stage === 'fighting') {
      const heading = resolveQuestHeadHeading(head);
      if (heading.ok) {
        const baseYaw = spawnTransforms?.blue.yaw ?? 90;
        const lookYaw = ((((baseYaw + heading.yawRelative + 180) % 360) + 360) % 360) - 180;
        const bearing = match.getQuestCombatTelemetry().bearingToRed;
        const bearingDelta = ((((bearing - lookYaw + 180) % 360) + 360) % 360) - 180;
        match.setCombatYaw(
          Math.abs(bearingDelta) <= 45 ? bearing : lookYaw,
          snapshot.roundId,
          lookYaw
        );
      }
    }
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
    const inActiveFight =
      !paused && !locomotionNeedsNeutral && match?.getSnapshot().stage === 'fighting';
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

    if (recenterNeutral || paused || locomotionNeedsNeutral) {
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
    applyLocomotionToMatch(head);
    syncGestureFrame(head);
    const snapshot = match?.getSnapshot();
    if (!isCombatInputGateOpen(snapshot, head, latestInput.sample, latestInput.status)) {
      releaseSessionGuard(snapshot?.roundId);
      match?.setHeadEvasion(null, snapshot?.roundId);
    } else {
      syncHeadEvasion(head);
    }
    if (!isBodyLocomotionActive(snapshot, head) && bodyTracker.clip !== 'IdleAggro') {
      bodyTracker = createQuestFirstPersonBodyTrackerState();
      publish();
    }
    return head;
  }

  const stopHeadLive = headSource.subscribeLive?.((event) => {
    if (disposed) return;
    const head = readHeadState();
    if (event === 'recenter' || event === 'jump-pending') {
      turnTriggerState = { snapArmed: false };
      pauseTriggerState = { ...pauseTriggerState, armed: false };
      lastReferenceResets = head.referenceResets ?? lastReferenceResets;
      if (event === 'recenter') {
        recenterNeutral = true;
        recenterSampleT = head.sample?.t ?? null;
        recenterInputSeq = latestInput.sample?.seq ?? null;
        if (paused) pauseCalibration = capturePauseCalibration(head);
      }
      neutralizeCombatGestures(head);
      if (paused) publish();
    } else if (event === 'turn') {
      updateGestureFrameForTurn(head);
    } else if (event === 'calibrate') {
      syncGestureFrame(head);
    } else if (event === 'sample' && recenterNeutral && !head.recentering) {
      if (head.sample?.t !== recenterSampleT) {
        recenterNeutral = false;
      }
    }
    recomputeLocomotion();
  });

  function publish() {
    const snapshot = match?.getSnapshot();
    if (snapshot?.stage === 'paused' && !paused) {
      paused = true;
      page = 'pause';
      intro = null;
      pauseCalibration = capturePauseCalibration(readHeadState());
      stopLoop();
      neutralizePausedInput();
      notifyFrame(0);
    }
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
            paused,
            appActive,
            pauseCalibration,
            menuVisible: computeMenuVisible(snapshot.stage),
            menuButtonAvailable: pauseTriggerState.menuAvailable,
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
            lines: menuLines(
              page,
              snapshot.stage,
              acknowledged,
              leaving,
              snapshot.outcome,
              pauseTriggerState.menuAvailable
            ),
            presentation,
            introActive: intro !== null,
            combatHud: paused || page === 'pause' ? null : buildCombatHud(snapshot),
            settings,
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
    if (presentation !== 'side' || intro || !appActive) return;
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

  function dispatchCombatFeedback(events: readonly QuestCombatFeedbackEvent[]) {
    for (const evt of events) {
      const haptic = questHapticPatternForFeedback(evt.kind, evt.hand, evt.defender, evt.heavy);
      if (haptic) {
        const mask = haptic.hand === 'left' ? 1 : haptic.hand === 'right' ? 2 : 3;
        triggerHapticSafe(mask, haptic.intensity, haptic.durationMs);
      }

      const uppercut = evt.attackKind === 'uppercut';
      if (
        evt.kind === 'PLAYER_LANDED_HIT' ||
        (evt.kind === 'HEAVY_STAGGER' && evt.defender === 'red')
      ) {
        const label = evt.counter
          ? `COUNTER HIT (${evt.hand ?? 'R'})!`
          : uppercut
            ? `UPPERCUT HIT (${evt.hand ?? 'R'})!`
            : evt.kind === 'HEAVY_STAGGER'
              ? 'CPU STAGGERED!'
              : `CLEAN HIT (${evt.hand ?? 'L'})!`;
        emitHudEvent(uppercut ? 'uppercut-hit' : 'hit', label, 'positive', 1.05);
      } else if (evt.kind === 'PLAYER_HIT_BLOCKED') {
        emitHudEvent('cpu-blocked', 'CPU BLOCKED — NO DAMAGE', 'warning', 0.95);
      } else if (evt.kind === 'GUARD_BREAK') {
        if (evt.defender === 'red') {
          emitHudEvent('guard-break', 'CPU GUARD BROKEN!', 'positive', 1.1);
        } else {
          emitHudEvent('player-guard-break', 'GUARD BROKEN!', 'danger', 1.15);
          flashDamage(QUEST_TUNING.damageVignette.guardBreakOpacity);
        }
      } else if (evt.kind === 'PLAYER_RECEIVED_HIT' || evt.kind === 'HEAVY_STAGGER') {
        emitHudEvent('took-hit', uppercut ? 'HIT BY UPPERCUT!' : 'TOOK HIT!', 'danger', 1.0);
        flashDamage(
          evt.heavy
            ? QUEST_TUNING.damageVignette.heavyOpacity
            : QUEST_TUNING.damageVignette.ordinaryOpacity
        );
      } else if (evt.kind === 'PLAYER_SUCCESSFUL_BLOCK') {
        emitHudEvent('blocked-cpu', 'BLOCKED!', 'info', 0.85);
      } else if (evt.kind === 'SUCCESSFUL_DODGE') {
        emitHudEvent('dodged', 'DODGED! COUNTER READY!', 'info', 0.95);
      }

      for (const listener of feedbackListeners) {
        try {
          listener(evt);
        } catch {
          // Listener failure must never interrupt combat simulation.
        }
      }
    }
  }

  function flashDamage(opacity: number) {
    if (!settings.damageTintEnabled || opacity < damageTintOpacity) return;
    damageTintOpacity = opacity;
    damageTintFadePerSecond = opacity / (QUEST_TUNING.damageVignette.fadeDurationMs / 1000);
  }

  function advanceSessionDt(token: number, rawDtSeconds: number) {
    if (!Number.isFinite(rawDtSeconds) || rawDtSeconds <= 0) return;
    const clampedDt = Math.min(MAX_FRAME_DT_S, rawDtSeconds);
    let remaining = clampedDt;
    let bodyClipChanged = false;
    while (remaining > 1e-6) {
      const stepDt = Math.min(MAX_STEP_DT_S, remaining);
      remaining -= stepDt;
      hudClockS += stepDt;
      if (damageTintOpacity > 0) {
        damageTintOpacity = Math.max(0, damageTintOpacity - damageTintFadePerSecond * stepDt);
      }
      if (activeHudEvent && hudClockS >= hudEventExpiresAt) {
        activeHudEvent = null;
      }
      const head = recomputeLocomotion();
      if (
        settings.turnMode === 'smooth' &&
        presentation === 'eyes' &&
        !paused &&
        !menuFocused &&
        appActive &&
        match?.getSnapshot().stage === 'fighting'
      ) {
        const turnEval = evaluateQuestTurnInput(turnTriggerState, {
          sample: latestInput.sample,
          status: latestInput.status,
          inActiveFight: true,
          menuFocused,
          appActive,
          recenterNeutral,
          paused,
          head,
          turnMode: 'smooth',
          smoothDegPerSec: settings.smoothTurnDegPerSec,
          dtSeconds: stepDt,
        });
        turnTriggerState = turnEval.nextState;
        if (turnEval.deltaYawDeg !== 0) {
          headSource.applyTurnDelta?.(turnEval.deltaYawDeg);
          updateGestureFrameForTurn(readHeadState());
        }
      }
      const before = match?.getTransform('blue') ?? null;
      match?.tick(token, stepDt);
      if (match) {
        const impacts = match.takeImpacts().map(({ fighter, impact }) => ({
          ...impact,
          defender: fighter,
        }));
        const evaded = match.takeEvadedHits().map((evade) => ({
          ...evade,
          defender: 'blue' as const,
        }));
        const events = feedbackStream.ingest(hudClockS, impacts, evaded);
        if (events.length > 0) {
          dispatchCombatFeedback(events);
        }
      }
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
    if (bodyClipChanged || presentation === 'eyes') publish();
    notifyFrame(clampedDt);
  }

  function finishLoopStep() {
    if (!match) return;
    const snap = match.getSnapshot();
    if (!isActiveMatchStage(snap.stage) || !appActive) {
      stopLoop();
      if (intro) {
        intro = null;
        notifyFrame(0);
      }
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
    paused = false;
    pauseCalibration = null;
    readyQueued = false;
    spawnRoundKey = '';
    spawnTransforms = null;
    menuFocused = false;
    recenterNeutral = false;
    recenterSampleT = null;
    recenterInputSeq = null;
    locomotion = { advance: 0, strafe: 0, active: false, magnitude: 0 };
    dashTriggerState = { armed: false };
    pauseTriggerState = {
      armed: false,
      lastToggleMs: nowFn(),
      menuAvailable: pauseTriggerState.menuAvailable,
    };
    turnTriggerState = { snapArmed: false };
    locomotionNeedsNeutral = false;
    damageTintOpacity = 0;
    feedbackStream.reset();
    desiredGuardHeld = false;
    guardNeedsPhysicalRelease = false;
    dispatchedGuardHeld = false;
    dispatchedGuardRoundId = null;
    lastProcessedLiveKey = null;
    latestInputNowNs = undefined;
    hudClockS = 0;
    hudEventSeq = 0;
    activeHudEvent = null;
    hudEventExpiresAt = 0;
    lastEvadeKind = null;
    gestureClassifier.setFrame(frameFromHeadState(readHeadState()));
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
    if (snap.stage === 'paused' && resumePausedMatch()) {
      return { called: true, started: true, reason: 'resumed' };
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

  function pauseActiveMatch() {
    if (disposed || !match || leaving || paused || !appActive) return false;
    const snap = match.getSnapshot();
    if (!isActiveMatchStage(snap.stage)) return false;
    match.interrupt();
    return paused;
  }

  function resumePausedMatch() {
    if (disposed || !match || leaving || !appActive) return false;
    const snap = match.getSnapshot();
    if (snap.stage !== 'paused' || !snap.canResume) return false;
    if (!match.resume()) return false;
    neutralizePausedInput();
    const token = match.getSessionToken();
    if (token !== null) match.tick(token, 1 / 60);
    paused = false;
    pauseCalibration = null;
    page = 'ring';
    menuFocused = false;
    acknowledged = true;
    readyQueued = false;
    beginViewpointIntro();
    startLoop();
    notifyFrame(0);
    publish();
    return true;
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
    onCombatFeedback: (listener: (event: QuestCombatFeedbackEvent) => void) => {
      feedbackListeners.add(listener);
      return () => {
        feedbackListeners.delete(listener);
      };
    },
    getMatch: () => match,
    getSettings: () => ({ ...settings }),
    getDamageTintOpacity: () => damageTintOpacity,
    updateSettings(partial: Partial<QuestUserSettings>) {
      settings = { ...settings, ...partial };
      if (!settings.damageTintEnabled) damageTintOpacity = 0;
      if (partial.turnMode) turnTriggerState = { snapArmed: false };
      publish();
      return { ...settings };
    },
    pause: pauseActiveMatch,
    resume: resumePausedMatch,
    showPauseSettings(open: boolean) {
      if (!paused || !appActive || leaving) return;
      page = open ? 'settings' : 'pause';
      publish();
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
    isEvading: (): boolean => match?.round.isEvading('blue') ?? false,
    getMatchSnapshot: () => match?.getSnapshot() ?? null,
    solo() {
      if (disposed || leaving || page !== 'menu') return false;
      const created = new ArenaMatch('solo', 3, undefined, {
        ...QUEST_ARENA_RULES,
        ...rulesOverride,
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
      batch?: readonly QuestInputSample[],
      nowNs?: number | null
    ) {
      const isBatchLive = Boolean(batch && batch.length > 0 && status === 'live');
      const samples = isBatchLive ? batch! : [sample];
      latestInputNowNs = nowNs;
      for (const nextSample of samples) {
        if (recenterNeutral) {
          const head = readHeadState();
          if (!head.recentering && (nextSample === null || nextSample.seq !== recenterInputSeq)) {
            recenterNeutral = false;
          }
        }
        const isDuplicateLiveSample =
          !isBatchLive &&
          status === 'live' &&
          nextSample !== null &&
          lastProcessedLiveKey !== null &&
          nextSample.generation === lastProcessedLiveKey.generation &&
          nextSample.refEpoch === lastProcessedLiveKey.refEpoch &&
          nextSample.seq === lastProcessedLiveKey.seq &&
          nextSample.capturedNs === lastProcessedLiveKey.capturedNs;
        const fresh = status === 'live' && isInputFreshForCombat(nextSample, nowNs);
        const duplicateActionSample =
          fresh &&
          nextSample !== null &&
          lastActionSample !== null &&
          nextSample.generation === lastActionSample.generation &&
          nextSample.refEpoch === lastActionSample.refEpoch &&
          nextSample.capturedNs <= lastActionSample.capturedNs;
        if (duplicateActionSample && !isDuplicateLiveSample) continue;
        if (fresh && nextSample) lastActionSample = nextSample;
        const inputStatus = status === 'live' && !fresh ? 'stale' : status;
        latestInput = { sample: nextSample, status: inputStatus };
        if (
          locomotionNeedsNeutral &&
          !duplicateActionSample &&
          !paused &&
          appActive &&
          inputStatus === 'live' &&
          nextSample?.focused &&
          nextSample.actionsReady &&
          nextSample.left.thumbstick.active &&
          Math.hypot(nextSample.left.thumbstick.x, nextSample.left.thumbstick.y) <=
            QUEST_STICK_DEADZONE
        )
          locomotionNeedsNeutral = false;
        const head = recomputeLocomotion();
        const prevMenuAvailable = pauseTriggerState.menuAvailable;
        const currentStage = match?.getSnapshot().stage ?? null;
        const canTogglePause =
          match !== null && !leaving && (paused || isActiveMatchStage(currentStage));
        const pauseEval = evaluateQuestPauseInput(pauseTriggerState, {
          sample: nextSample,
          status: inputStatus,
          canToggle: canTogglePause,
          appActive,
          recenterNeutral,
          head,
          nowMs: nowFn(),
        });
        if (!duplicateActionSample) pauseTriggerState = pauseEval.nextState;
        if (prevMenuAvailable !== pauseTriggerState.menuAvailable) {
          publish();
        }
        if (!duplicateActionSample && pauseEval.toggled) {
          if (paused) resumePausedMatch();
          else pauseActiveMatch();
          continue;
        }
        if (!duplicateActionSample) {
          const turnEval = evaluateQuestTurnInput(turnTriggerState, {
            sample: nextSample,
            status: inputStatus,
            inActiveFight: presentation === 'eyes' && currentStage === 'fighting',
            menuFocused,
            appActive,
            recenterNeutral,
            paused,
            head,
            turnMode: settings.turnMode,
            snapAngleDeg: settings.snapTurnAngleDeg,
          });
          turnTriggerState = turnEval.nextState;
          if (turnEval.deltaYawDeg !== 0) {
            headSource.applyTurnDelta?.(turnEval.deltaYawDeg);
            updateGestureFrameForTurn(readHeadState());
          }
        }
        if (!duplicateActionSample) evaluateDashForSample(nextSample, inputStatus, head);
        evaluateCombatForSample(
          nextSample,
          inputStatus,
          readHeadState(),
          nowNs,
          isDuplicateLiveSample
        );
      }
    },
    setMenuFocus(focused: boolean) {
      if (menuFocused === focused) return;
      menuFocused = focused;
      if (focused) {
        neutralizeDash();
        neutralizeCombatGestures();
      }
      recomputeLocomotion();
      if (focused) notifyFrame(0);
    },
    setAppActive(active: boolean) {
      if (appActive === active) return;
      appActive = active;
      const hadIntro = intro !== null;
      if (!active) {
        intro = null;
        neutralizePausedInput();
      }
      recomputeLocomotion();
      if (!match) {
        if (!active && hadIntro) notifyFrame(0);
        publish();
        return;
      }
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
    setHapticTrigger(trigger: QuestHapticTrigger | null) {
      activeHapticTrigger = trigger ?? noopHapticTrigger;
    },
    back() {
      if (disposed || leaving || (page !== 'ring' && page !== 'pause')) return 'menu' as const;
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
