import type { AnalogMovement } from '../arena-fighter/arena-controller.ts';
import {
  DEFAULT_CALIBRATION,
  wrap180,
  yawFromForward,
  type Calibration,
  type HeadSample,
} from './quest-head-rig.ts';
import type { QuestInputSample } from './quest-input.ts';
import type { QuestInputStatus } from './quest-input-source.ts';

/** Radial deadzone rejecting Oculus Touch rest jitter while keeping smooth analog response. */
export const QUEST_STICK_DEADZONE = 0.15;
/** Maximum age (ms) for a native head sample before falling back to stable calibration yaw. */
export const QUEST_HEAD_SAMPLE_STALE_MS = 250;

const MIN_FORWARD_NORM = 1e-9;
const TRIG_SNAP_EPSILON = 1e-12;

export interface QuestLocomotionCommand extends AnalogMovement {
  active: boolean;
  magnitude: number;
}

export interface QuestHeadLocomotionState {
  sample?: HeadSample | null;
  calibration?: Pick<Calibration, 'yaw'> | null;
  lastValidYaw?: number | null;
  nowMs?: number;
  recentering?: boolean;
  refEpoch?: number | null;
  staleMs?: number;
}

export interface QuestResolvedHeadHeading {
  ok: boolean;
  headYaw: number | null;
  calibrationYaw: number;
  yawRelative: number;
  source:
    'live-head' | 'fallback-degenerate' | 'fallback-stale' | 'fallback-calibration' | 'recentering';
}

const NEUTRAL: QuestLocomotionCommand = { advance: 0, strafe: 0, active: false, magnitude: 0 };

function cleanZero(n: number): number {
  return n === 0 ? 0 : n;
}

function snapZero(n: number): number {
  return Math.abs(n) < TRIG_SNAP_EPSILON ? 0 : n;
}

function isHeadSampleForwardValid(sample: HeadSample | null | undefined): sample is HeadSample {
  if (!sample || typeof sample !== 'object' || !Number.isFinite(sample.t)) return false;
  const f = sample.forward;
  if (!Array.isArray(f) || f.length !== 3) return false;
  if (!Number.isFinite(f[0]) || !Number.isFinite(f[1]) || !Number.isFinite(f[2])) return false;
  return Math.hypot(f[0], f[1], f[2]) > MIN_FORWARD_NORM;
}

/**
 * Resolves the active horizontal head heading in OpenXR LOCAL space relative to calibration.yaw.
 * Projects onto the horizontal floor plane (pitch/roll invariant) and falls back cleanly when
 * horizontal projection degenerates (near-vertical gaze) or the head sample is missing/stale/invalid.
 */
export function resolveQuestHeadHeading(
  head?: QuestHeadLocomotionState | null
): QuestResolvedHeadHeading {
  const rawCalYaw = head?.calibration?.yaw;
  const calYaw =
    typeof rawCalYaw === 'number' && Number.isFinite(rawCalYaw)
      ? wrap180(rawCalYaw)
      : wrap180(DEFAULT_CALIBRATION.yaw);

  if (head?.recentering) {
    return {
      ok: false,
      headYaw: null,
      calibrationYaw: calYaw,
      yawRelative: 0,
      source: 'recentering',
    };
  }

  const sample = head?.sample;
  if (!isHeadSampleForwardValid(sample)) {
    return {
      ok: true,
      headYaw: calYaw,
      calibrationYaw: calYaw,
      yawRelative: 0,
      source: 'fallback-calibration',
    };
  }

  if (head?.nowMs !== undefined) {
    const staleMs =
      typeof head.staleMs === 'number' && Number.isFinite(head.staleMs) && head.staleMs > 0
        ? head.staleMs
        : QUEST_HEAD_SAMPLE_STALE_MS;
    if (!Number.isFinite(head.nowMs) || head.nowMs - sample.t > staleMs) {
      return {
        ok: true,
        headYaw: calYaw,
        calibrationYaw: calYaw,
        yawRelative: 0,
        source: 'fallback-stale',
      };
    }
  }

  const liveYaw = yawFromForward(sample.forward);
  if (liveYaw !== null) {
    return {
      ok: true,
      headYaw: liveYaw,
      calibrationYaw: calYaw,
      yawRelative: wrap180(liveYaw - calYaw),
      source: 'live-head',
    };
  }

  const fallbackYaw =
    typeof head?.lastValidYaw === 'number' && Number.isFinite(head.lastValidYaw)
      ? wrap180(head.lastValidYaw)
      : calYaw;
  return {
    ok: true,
    headYaw: fallbackYaw,
    calibrationYaw: calYaw,
    yawRelative: wrap180(fallbackYaw - calYaw),
    source: 'fallback-degenerate',
  };
}

/**
 * Pure two-axis left thumbstick mapping in the viewer's horizontal frame.
 *
 * OpenXR `/user/hand/left/input/thumbstick` uses +Y forward/up, -Y back/down,
 * -X left, +X right. Simulation `strafe` is positive left, negative right,
 * and `advance` is positive forward, negative retreat.
 */
export function mapLeftThumbstick(
  x: number,
  y: number,
  deadzone = QUEST_STICK_DEADZONE
): QuestLocomotionCommand {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(deadzone) ||
    deadzone < 0 ||
    deadzone >= 1
  ) {
    return NEUTRAL;
  }
  const rawMagnitude = Math.hypot(x, y);
  if (rawMagnitude <= deadzone) return NEUTRAL;
  const clamped = Math.min(1, rawMagnitude);
  const magnitude = (clamped - deadzone) / (1 - deadzone);
  if (magnitude <= 0) return NEUTRAL;
  const nx = x / rawMagnitude;
  const ny = y / rawMagnitude;
  return {
    advance: cleanZero(ny * magnitude),
    strafe: cleanZero(-nx * magnitude),
    active: true,
    magnitude,
  };
}

/**
 * Maps left thumbstick `(x, y)` into the ring's body reference frame rotated by
 * `yawRelativeDeg = wrap180(headYaw - calibrationYaw)`, so stick +Y moves toward the
 * wearer's current horizontal look heading, -Y opposite, and -X/+X perpendicular left/right.
 */
export function mapViewRelativeThumbstick(
  x: number,
  y: number,
  yawRelativeDeg: number,
  deadzone = QUEST_STICK_DEADZONE
): QuestLocomotionCommand {
  if (!Number.isFinite(yawRelativeDeg)) return NEUTRAL;
  const stick = mapLeftThumbstick(x, y, deadzone);
  if (!stick.active) return NEUTRAL;
  const rad = (yawRelativeDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    advance: snapZero(stick.advance * cos - stick.strafe * sin),
    strafe: snapZero(stick.advance * sin + stick.strafe * cos),
    active: true,
    magnitude: stick.magnitude,
  };
}

/**
 * Derives view-relative horizontal locomotion from the left controller thumbstick,
 * live unthrottled headset heading, and safety/recenter gates.
 */
export function questLocomotionFromInput(
  input: {
    sample: QuestInputSample | null;
    status: QuestInputStatus;
    menuFocused?: boolean;
    appActive?: boolean;
    head?: QuestHeadLocomotionState | null;
  },
  deadzone = QUEST_STICK_DEADZONE
): QuestLocomotionCommand {
  if (input.appActive === false || input.menuFocused === true) return NEUTRAL;
  if (input.status !== 'live' || !input.sample) return NEUTRAL;
  const { sample } = input;
  if (!sample.focused || !sample.actionsReady) return NEUTRAL;
  if (sample.left.tracking === 'lost' || !sample.left.thumbstick.active) return NEUTRAL;
  if (
    typeof sample.refEpoch === 'number' &&
    typeof input.head?.refEpoch === 'number' &&
    sample.refEpoch !== input.head.refEpoch
  ) {
    return NEUTRAL;
  }
  const heading = resolveQuestHeadHeading(input.head);
  if (!heading.ok) return NEUTRAL;
  return mapViewRelativeThumbstick(
    sample.left.thumbstick.x,
    sample.left.thumbstick.y,
    heading.yawRelative,
    deadzone
  );
}

export interface QuestDashTriggerState {
  armed: boolean;
}

export interface QuestDashInputEvaluation {
  nextState: QuestDashTriggerState;
  triggered: boolean;
  neutralized: boolean;
  direction: AnalogMovement | null;
}

/**
 * Evaluates a rising-edge A-button (`/user/hand/right/input/a/click` -> `right.buttons.primary`)
 * dash trigger against continuous controller state, live head heading, active fight state, and
 * safety gates. Never reads left-hand primary (X), never fires on held startup/reconnect/focus
 * recovery, and never buffers a neutral-stick press into later movement.
 */
export function evaluateQuestDashInput(
  prevState: QuestDashTriggerState,
  input: {
    sample: QuestInputSample | null;
    status: QuestInputStatus;
    inActiveFight: boolean;
    menuFocused?: boolean;
    appActive?: boolean;
    recenterNeutral?: boolean;
    head?: QuestHeadLocomotionState | null;
  },
  deadzone = QUEST_STICK_DEADZONE
): QuestDashInputEvaluation {
  const neutralResult = (neutralized: boolean): QuestDashInputEvaluation => ({
    nextState: { armed: false },
    triggered: false,
    neutralized,
    direction: null,
  });

  if (input.appActive === false || input.menuFocused === true || input.recenterNeutral === true) {
    return neutralResult(true);
  }
  if (input.status !== 'live' || !input.sample) {
    return neutralResult(true);
  }
  const { sample } = input;
  if (!sample.focused || !sample.actionsReady) {
    return neutralResult(true);
  }
  if (
    typeof sample.refEpoch === 'number' &&
    typeof input.head?.refEpoch === 'number' &&
    sample.refEpoch !== input.head.refEpoch
  ) {
    return neutralResult(true);
  }
  const heading = resolveQuestHeadHeading(input.head);
  if (!heading.ok) {
    return neutralResult(true);
  }
  if (
    sample.left.tracking === 'lost' ||
    sample.right.tracking === 'lost' ||
    sample.right.buttons.primary === null
  ) {
    return neutralResult(true);
  }
  if (!input.inActiveFight) {
    return neutralResult(true);
  }

  const aDown = sample.right.buttons.primary;
  if (aDown === false) {
    return { nextState: { armed: true }, triggered: false, neutralized: false, direction: null };
  }

  // Rising edge requires an observed false in the same valid, active-fight state.
  // Neutral or rejected presses still consume arming so holding A never buffers.
  if (!prevState.armed) {
    return neutralResult(false);
  }
  if (!sample.left.thumbstick.active) {
    return neutralResult(false);
  }
  const move = mapViewRelativeThumbstick(
    sample.left.thumbstick.x,
    sample.left.thumbstick.y,
    heading.yawRelative,
    deadzone
  );
  if (!move.active || move.magnitude <= 0) {
    return neutralResult(false);
  }
  const len = Math.hypot(move.advance, move.strafe);
  if (len <= 0) {
    return neutralResult(false);
  }
  return {
    nextState: { armed: false },
    triggered: true,
    neutralized: false,
    direction: {
      advance: cleanZero(move.advance / len),
      strafe: cleanZero(move.strafe / len),
    },
  };
}
