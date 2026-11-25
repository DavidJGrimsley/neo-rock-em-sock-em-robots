import {
  gameplayHeadPose,
  type Calibration,
  type HeadSample,
  type Vec3 as HeadVec3,
} from './quest-head-rig.ts';
import type { QuestHand, QuestHandSample, QuestInputSample, Vec3 } from './quest-input.ts';
import { QUEST_INPUT_STALE_NS, type QuestInputStatus } from './quest-input-source.ts';

/**
 * Offline gesture preparation for Quest 06.
 *
 * Supports both OpenXR aim poses (`poseSource: 'aim'`, used by the authored
 * synthetic corpus) and OpenXR grip poses (`poseSource: 'grip'`, added in Stage
 * 05B via `sample.left.grip` / `sample.right.grip`). In `'grip'` mode, missing
 * or untracked grip poses never fall back to aim poses. Body forward matches
 * `forward(yaw)` and `gameplayHeadPose`: yaw 0 faces +Z, yaw 180 (the default
 * calibration) faces -Z. Motion time uses `capturedNs` only. `displayTimeNs` is
 * XrTime and is ignored.
 *
 * An upward gesture is always an `uppercut` attempt. This module does not read
 * `uppercutReady` and does not turn that attempt into a punch. `ArenaMatch`
 * remains the eligibility and recovery authority. Stage 06 `QuestArenaSession`
 * wires `poseSource: 'grip'` into Quest solo fights; none of the distances or
 * durations were measured on a Quest.
 */
export const QUEST_GESTURE_THRESHOLD_BASIS = 'provisional-unmeasured' as const;

export type QuestGesturePoseSource = 'aim' | 'grip';

export interface QuestGestureThresholds {
  punchForwardM: number;
  punchMaxUpRatio: number;
  punchMaxLateralM: number;
  uppercutUpM: number;
  uppercutMinUpRatio: number;
  uppercutMaxLateralM: number;
  startSpeedMps: number;
  settleSpeedMps: number;
  discontinuityM: number;
  maxCaptureGapNs: number;
  maxSampleAgeNs: number;
  rearmRetreatRatio: number;
  guardHoldNs: number;
  guardMaxSpeedMps: number;
  guardForwardMinM: number;
  guardForwardMaxM: number;
  guardUpMinM: number;
  guardUpMaxM: number;
  guardLateralMaxM: number;
  duckEnterM: number;
  weaveEnterM: number;
}

/** Authored so the synthetic fixtures are deterministic. Not a headset calibration. */
export const PROVISIONAL_QUEST_GESTURE_THRESHOLDS: QuestGestureThresholds = {
  punchForwardM: 0.18,
  punchMaxUpRatio: 0.6,
  punchMaxLateralM: 0.1,
  uppercutUpM: 0.12,
  uppercutMinUpRatio: 1.2,
  uppercutMaxLateralM: 0.1,
  startSpeedMps: 0.5,
  settleSpeedMps: 0.25,
  discontinuityM: 0.45,
  maxCaptureGapNs: 250_000_000,
  maxSampleAgeNs: QUEST_INPUT_STALE_NS,
  rearmRetreatRatio: 0.5,
  guardHoldNs: 120_000_000,
  guardMaxSpeedMps: 0.3,
  guardForwardMinM: 0.15,
  guardForwardMaxM: 0.45,
  guardUpMinM: -0.1,
  guardUpMaxM: 0.25,
  guardLateralMaxM: 0.4,
  duckEnterM: 0.15,
  weaveEnterM: 0.12,
};

export type QuestGestureHandFilter = 'both' | 'left' | 'right';

export interface QuestBodyFrame {
  /** Degrees. 0: body forward is world +Z. 180: body forward is world -Z. */
  yaw: number;
  origin: Vec3;
}

/** Default matches `DEFAULT_CALIBRATION.yaw`, so world +Z is not a punch. */
export const DEFAULT_QUEST_GESTURE_FRAME: QuestBodyFrame = {
  yaw: 180,
  origin: [0, 0, 0],
};

export interface QuestGestureObservation {
  sample: QuestInputSample | null;
  status: QuestInputStatus;
  head?: HeadSample | null;
  calibration?: Calibration | null;
  headRefEpoch?: number | null;
  recentering?: boolean;
  /** Same monotonic origin as capturedNs. Optional for synthetic callers without a clock. */
  nowNs?: number | null;
}

export interface BodyPoint {
  forward: number;
  lateral: number;
  up: number;
}

export type QuestGestureIntent =
  | { type: 'punch'; hand: QuestHand; capturedNs: number }
  | { type: 'uppercut'; hand: QuestHand; capturedNs: number }
  | { type: 'guard'; held: boolean; capturedNs: number }
  | {
      type: 'head';
      duck: boolean;
      weave: boolean;
      verticalM: number;
      lateralM: number;
      forwardM: number;
      clamped: boolean;
      outOfBounds: boolean;
      t: number;
    };

export interface QuestGestureSnapshot {
  guard: boolean;
  generation: number | null;
  refEpoch: number | null;
  poseSource: QuestGesturePoseSource;
  head: {
    duck: boolean;
    weave: boolean;
    verticalM: number;
    lateralM: number;
    forwardM: number;
    clamped: boolean;
    outOfBounds: boolean;
  } | null;
}

interface HandMemory {
  prev: { capturedNs: number; position: Vec3; body: BodyPoint } | null;
  excursion: { start: BodyPoint; maxForward: BodyPoint; maxUp: BodyPoint } | null;
  usable: boolean;
  speed: number;
  armed: boolean;
  strikeStart: BodyPoint | null;
  rearmDistance: number;
}

const NS_PER_S = 1_000_000_000;

function finiteVec(value: readonly number[] | null | undefined, length: number): boolean {
  return !!value && value.length >= length && value.slice(0, length).every(Number.isFinite);
}

/** Body axes shared with `gameplayHeadPose`. +lateral is the body's right. */
export function questGestureBodyPoint(world: Vec3, frame: QuestBodyFrame): BodyPoint {
  const dx = world[0] - frame.origin[0];
  const dy = world[1] - frame.origin[1];
  const dz = world[2] - frame.origin[2];
  const radians = (frame.yaw * Math.PI) / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  return {
    forward: dx * sin + dz * cos,
    lateral: -dx * cos + dz * sin,
    up: dy,
  };
}

function blankHand(): HandMemory {
  return {
    prev: null,
    excursion: null,
    usable: false,
    speed: Number.POSITIVE_INFINITY,
    armed: true,
    strikeStart: null,
    rearmDistance: 0,
  };
}

function blankPeak(): BodyPoint {
  return { forward: Number.NEGATIVE_INFINITY, lateral: 0, up: Number.NEGATIVE_INFINITY };
}

function sub(a: BodyPoint, b: BodyPoint): BodyPoint {
  return { forward: a.forward - b.forward, lateral: a.lateral - b.lateral, up: a.up - b.up };
}

function bodyDistance(a: BodyPoint, b: BodyPoint): number {
  return Math.hypot(a.forward - b.forward, a.lateral - b.lateral, a.up - b.up);
}

function worldDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function resolveThresholds(partial?: Partial<QuestGestureThresholds>): QuestGestureThresholds {
  return { ...PROVISIONAL_QUEST_GESTURE_THRESHOLDS, ...partial };
}

function resolveFrame(frame?: QuestBodyFrame): QuestBodyFrame {
  if (!frame || !Number.isFinite(frame.yaw) || !finiteVec(frame.origin, 3)) {
    return DEFAULT_QUEST_GESTURE_FRAME;
  }
  return { yaw: frame.yaw, origin: [frame.origin[0], frame.origin[1], frame.origin[2]] };
}

function extractHandPosition(
  hand: QuestHand,
  sample: QuestHandSample | null | undefined,
  poseSource: QuestGesturePoseSource
): Vec3 | null {
  if (!sample || sample.hand !== hand) return null;
  const pose = poseSource === 'grip' ? sample.grip : sample;
  if (!pose || pose.tracking !== 'tracked' || !finiteVec(pose.position, 3)) {
    return null;
  }
  return pose.position as Vec3;
}

export function createQuestGestureClassifier(options?: {
  thresholds?: Partial<QuestGestureThresholds>;
  frame?: QuestBodyFrame;
  hands?: QuestGestureHandFilter;
  poseSource?: QuestGesturePoseSource;
}) {
  let thresholds = resolveThresholds(options?.thresholds);
  let frame = resolveFrame(options?.frame);
  const hands = options?.hands ?? 'both';
  const poseSource: QuestGesturePoseSource = options?.poseSource ?? 'aim';
  let generation: number | null = null;
  let refEpoch: number | null = null;
  let lastCapturedNs = 0;
  let guard = false;
  let holdStart: number | null = null;
  let duck = false;
  let weave = false;
  let head: QuestGestureSnapshot['head'] = null;
  const memory: Record<QuestHand, HandMemory> = { left: blankHand(), right: blankHand() };

  function allows(hand: QuestHand): boolean {
    return hands === 'both' || hands === hand;
  }

  function resetHands() {
    memory.left = blankHand();
    memory.right = blankHand();
    holdStart = null;
  }

  function releaseGuard(out: QuestGestureIntent[], capturedNs: number) {
    holdStart = null;
    if (!guard) return;
    guard = false;
    out.push({ type: 'guard', held: false, capturedNs });
  }

  function dropContinuity() {
    for (const hand of ['left', 'right'] as const) {
      memory[hand].prev = null;
      memory[hand].excursion = null;
      memory[hand].usable = false;
      memory[hand].speed = Number.POSITIVE_INFINITY;
    }
  }

  function classify(
    hand: QuestHand,
    excursion: NonNullable<HandMemory['excursion']>,
    capturedNs: number
  ) {
    const up = excursion.maxUp;
    const fwd = excursion.maxForward;
    if (
      up.up >= thresholds.uppercutUpM &&
      up.up >= thresholds.uppercutMinUpRatio * Math.max(up.forward, 0) &&
      Math.abs(up.lateral) <= thresholds.uppercutMaxLateralM
    ) {
      return { type: 'uppercut' as const, hand, capturedNs };
    }
    if (
      fwd.forward >= thresholds.punchForwardM &&
      fwd.up <= thresholds.punchMaxUpRatio * fwd.forward &&
      Math.abs(fwd.lateral) <= thresholds.punchMaxLateralM
    ) {
      return { type: 'punch' as const, hand, capturedNs };
    }
    return null;
  }

  function consumeHand(
    hand: QuestHand,
    sample: QuestHandSample | null | undefined,
    capturedNs: number,
    strikes: QuestGestureIntent[]
  ) {
    const state = memory[hand];
    state.usable = false;
    state.speed = Number.POSITIVE_INFINITY;
    const position = extractHandPosition(hand, sample, poseSource);
    if (!position) {
      state.excursion = null;
      state.prev = null;
      return;
    }
    const body = questGestureBodyPoint(position, frame);
    const prev = state.prev;
    state.prev = { capturedNs, position, body };
    if (!prev) {
      state.usable = true;
      state.speed = 0;
      return;
    }
    const dtNs = capturedNs - prev.capturedNs;
    if (dtNs <= 0) {
      state.prev = null;
      state.excursion = null;
      return;
    }
    const distance = worldDistance(position, prev.position);
    if (dtNs > thresholds.maxCaptureGapNs || distance > thresholds.discontinuityM) {
      state.excursion = null;
      return;
    }
    const speed = distance / (dtNs / NS_PER_S);
    state.usable = true;
    state.speed = speed;
    if (!state.armed) {
      if (state.strikeStart && bodyDistance(body, state.strikeStart) <= state.rearmDistance) {
        state.armed = true;
        state.excursion = null;
      }
      return;
    }
    if (!state.excursion) {
      if (speed < thresholds.startSpeedMps) return;
      state.excursion = { start: prev.body, maxForward: blankPeak(), maxUp: blankPeak() };
    }
    const excursion = state.excursion;
    const delta = sub(body, excursion.start);
    if (delta.forward > excursion.maxForward.forward) excursion.maxForward = delta;
    if (delta.up > excursion.maxUp.up) excursion.maxUp = delta;
    if (speed >= thresholds.settleSpeedMps) return;
    const intent = classify(hand, excursion, capturedNs);
    state.excursion = null;
    if (!intent) return;
    state.armed = false;
    state.strikeStart = excursion.start;
    const travel =
      intent.type === 'uppercut'
        ? bodyDistance(excursion.maxUp, { forward: 0, lateral: 0, up: 0 })
        : bodyDistance(excursion.maxForward, { forward: 0, lateral: 0, up: 0 });
    state.rearmDistance = travel * (1 - thresholds.rearmRetreatRatio);
    if (allows(hand)) strikes.push(intent);
  }

  function inGuardVolume(hand: QuestHand): boolean {
    const state = memory[hand];
    if (!state.usable || !state.prev) return false;
    const { forward, lateral, up } = state.prev.body;
    return (
      state.speed <= thresholds.guardMaxSpeedMps &&
      forward >= thresholds.guardForwardMinM &&
      forward <= thresholds.guardForwardMaxM &&
      up >= thresholds.guardUpMinM &&
      up <= thresholds.guardUpMaxM &&
      Math.abs(lateral) <= thresholds.guardLateralMaxM
    );
  }

  function consumeGuard(capturedNs: number, out: QuestGestureIntent[]) {
    if (inGuardVolume('left') && inGuardVolume('right')) {
      if (holdStart === null) holdStart = capturedNs;
      if (!guard && capturedNs - holdStart >= thresholds.guardHoldNs) {
        guard = true;
        out.push({ type: 'guard', held: true, capturedNs });
      }
      return;
    }
    releaseGuard(out, capturedNs);
  }

  function observeHead(obs: QuestGestureObservation, out: QuestGestureIntent[]) {
    if (obs.recentering === true) return;
    const sample = obs.head;
    const calibration = obs.calibration;
    if (
      !sample ||
      !calibration ||
      !Number.isFinite(sample.t) ||
      !finiteVec(sample.position, 3) ||
      !finiteVec(calibration.origin, 3) ||
      !Number.isFinite(calibration.yaw)
    ) {
      return;
    }
    const pose = gameplayHeadPose(calibration, {
      t: sample.t,
      position: sample.position as HeadVec3,
      forward: sample.forward,
      up: sample.up,
    });
    const nextDuck = pose.vertical <= -thresholds.duckEnterM;
    const nextWeave = Math.abs(pose.lateral) >= thresholds.weaveEnterM;
    head = {
      duck: nextDuck,
      weave: nextWeave,
      verticalM: pose.vertical,
      lateralM: pose.lateral,
      forwardM: pose.forward,
      clamped: pose.clamped,
      outOfBounds: pose.outOfBounds,
    };
    if (nextDuck === duck && nextWeave === weave) return;
    duck = nextDuck;
    weave = nextWeave;
    out.push({ type: 'head', ...head, t: sample.t });
  }

  function isSampleStale(sample: QuestInputSample, nowNs: number | null | undefined): boolean {
    if (poseSource === 'grip' && nowNs === null) return true;
    if (typeof nowNs !== 'number') return false;
    if (!Number.isFinite(nowNs) || nowNs < sample.capturedNs) return true;
    return nowNs - sample.capturedNs > thresholds.maxSampleAgeNs;
  }

  return {
    get thresholds() {
      return { ...thresholds };
    },
    thresholdBasis: QUEST_GESTURE_THRESHOLD_BASIS,
    poseSource,
    push(observation: QuestGestureObservation): QuestGestureIntent[] {
      const out: QuestGestureIntent[] = [];
      observeHead(observation, out);
      const sample = observation.sample;
      const validCapturedNs = sample ? Number.isFinite(sample.capturedNs) : false;
      const monotonicNs =
        sample &&
        validCapturedNs &&
        (generation === null ||
          sample.generation !== generation ||
          sample.capturedNs > lastCapturedNs);
      const safeNs = monotonicNs ? sample.capturedNs : lastCapturedNs;
      if (observation.recentering === true) {
        releaseGuard(out, safeNs);
        resetHands();
        return out;
      }
      if (
        !sample ||
        !validCapturedNs ||
        observation.status !== 'live' ||
        !sample.focused ||
        !sample.actionsReady
      ) {
        releaseGuard(out, safeNs);
        dropContinuity();
        return out;
      }
      if (isSampleStale(sample, observation.nowNs)) {
        releaseGuard(out, lastCapturedNs);
        dropContinuity();
        return out;
      }
      if (
        typeof sample.refEpoch === 'number' &&
        typeof observation.headRefEpoch === 'number' &&
        sample.refEpoch !== observation.headRefEpoch
      ) {
        releaseGuard(out, safeNs);
        resetHands();
        return out;
      }
      const sessionReset =
        generation !== null && (sample.generation !== generation || sample.refEpoch !== refEpoch);
      if (!sessionReset && generation !== null && sample.capturedNs <= lastCapturedNs) {
        releaseGuard(out, lastCapturedNs);
        dropContinuity();
        return out;
      }
      if (sessionReset) {
        releaseGuard(out, sample.generation === generation ? safeNs : lastCapturedNs);
        resetHands();
      }
      generation = sample.generation;
      refEpoch = sample.refEpoch;
      lastCapturedNs = sample.capturedNs;
      const strikes: QuestGestureIntent[] = [];
      consumeHand('left', sample.left, sample.capturedNs, strikes);
      consumeHand('right', sample.right, sample.capturedNs, strikes);
      consumeGuard(sample.capturedNs, out);
      return out.concat(strikes);
    },
    setFrame(next: QuestBodyFrame): QuestGestureIntent[] {
      const out: QuestGestureIntent[] = [];
      releaseGuard(out, lastCapturedNs);
      frame = resolveFrame(next);
      resetHands();
      return out;
    },
    setThresholds(next: Partial<QuestGestureThresholds>) {
      thresholds = { ...thresholds, ...next };
    },
    snapshot(): QuestGestureSnapshot {
      return { guard, generation, refEpoch, poseSource, head };
    },
  };
}

export type QuestGestureClassifier = ReturnType<typeof createQuestGestureClassifier>;
