// Pure decoding and validation of the raw controller samples that the patched Viro
// renderer records inside its existing OpenXR session (QuestInputSampler.h, patch
// 0003) and modules/quest-input hands to JavaScript. No React, no native imports.
//
// Time domains are never mixed: displayTimeNs is OpenXR XrTime (predicted display
// time), capturedNs and nowNs are CLOCK_MONOTONIC. Both are exact nanosecond offsets
// from their session's first sample. Viro does not enable XR_KHR_convert_timespec_time,
// so an XrTime is never subtracted from a monotonic time.
import type { QuestInputBatch } from '../../../modules/quest-input/src/index.ts';

export type { QuestInputBatch };

// Layout of one sample; must match QuestInputSampler.h and QuestInputModule.kt.
export const QUEST_INPUT_VERSION = 1;
export const QUEST_INPUT_INTS_PER_HAND = 5;
export const QUEST_INPUT_INTS_PER_SAMPLE = 5 + 2 * QUEST_INPUT_INTS_PER_HAND;
export const QUEST_INPUT_FLOATS_PER_HAND = 17;
export const QUEST_INPUT_FLOATS_PER_SAMPLE = 2 * QUEST_INPUT_FLOATS_PER_HAND;

// OpenXR 1.0 constants.
export const XR_SPACE_LOCATION_ORIENTATION_VALID_BIT = 0x1;
export const XR_SPACE_LOCATION_POSITION_VALID_BIT = 0x2;
export const XR_SPACE_LOCATION_ORIENTATION_TRACKED_BIT = 0x4;
export const XR_SPACE_LOCATION_POSITION_TRACKED_BIT = 0x8;
export const XR_SPACE_VELOCITY_LINEAR_VALID_BIT = 0x1;
export const XR_SPACE_VELOCITY_ANGULAR_VALID_BIT = 0x2;
export const XR_SESSION_STATE_FOCUSED = 5;
export const XR_SUCCESS = 0;

// QuestInputSampler.h ActiveBit / ButtonBit.
const ACTIVE_POSE = 1;
const ACTIVE_TRIGGER = 2;
const ACTIVE_SQUEEZE = 4;
const ACTIVE_THUMBSTICK = 8;
const ACTIVE_PRIMARY = 16;
const ACTIVE_SECONDARY = 32;
const ACTIVE_MENU = 64;
const DOWN_PRIMARY = 1;
const DOWN_SECONDARY = 2;
const DOWN_MENU = 4;

/** Axis values may exceed their range by float noise only. */
const AXIS_TOLERANCE = 1e-3;
/** A valid orientation must be a unit quaternion within this tolerance. */
const QUAT_NORM_TOLERANCE = 0.05;

export type QuestHand = 'left' | 'right';
export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

/** tracked: valid and tracked; inferred: valid, not tracked; lost: not valid or inactive. */
export type QuestTrackingState = 'tracked' | 'inferred' | 'lost';

export interface QuestAnalog {
  value: number;
  active: boolean;
}

export interface QuestHandSample {
  hand: QuestHand;
  locateOk: boolean;
  poseActive: boolean;
  positionValid: boolean;
  positionTracked: boolean;
  orientationValid: boolean;
  orientationTracked: boolean;
  /** OpenXR aim pose in Viro's world space (OpenXR LOCAL, metres). Not the grip pose. */
  position: Vec3 | null;
  /** x, y, z, w. */
  orientation: Quat | null;
  linearVelocity: Vec3 | null;
  angularVelocity: Vec3 | null;
  tracking: QuestTrackingState;
  thumbstick: { x: number; y: number; active: boolean };
  trigger: QuestAnalog;
  squeeze: QuestAnalog;
  /** null while the action is inactive. Primary is A or X, secondary B or Y; menu is left only. */
  buttons: { primary: boolean | null; secondary: boolean | null; menu: boolean | null };
}

export interface QuestInputSample {
  seq: number;
  generation: number;
  refEpoch: number;
  /** XrTime domain, ns from the session origin. */
  displayTimeNs: number;
  /** CLOCK_MONOTONIC domain, ns from the session origin. */
  capturedNs: number;
  syncResult: number;
  sessionState: number;
  /** FOCUSED and xrSyncActions returned XR_SUCCESS. */
  focused: boolean;
  actionsReady: boolean;
  left: QuestHandSample;
  right: QuestHandSample;
}

export interface QuestDecodedBatch {
  ok: boolean;
  error: string | null;
  generation: number;
  live: boolean;
  actionsReady: boolean;
  nowNs: number | null;
  oldestSeq: number;
  latestSeq: number;
  /** Samples published in this session, so the session's first seq is latestSeq - published + 1. */
  published: number;
  framesWithoutInput: number;
  rejected: number;
  samples: QuestInputSample[];
  /** Samples dropped by decode validation. */
  invalid: number;
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const finiteAll = (values: readonly number[]) => values.every(Number.isFinite);

function axis(value: number, min: number): number | null {
  if (!Number.isFinite(value) || value < min - AXIS_TOLERANCE || value > 1 + AXIS_TOLERANCE)
    return null;
  return Math.min(1, Math.max(min, value));
}

/** Classifies a pose from its flags. Inactive or unlocated poses are lost. */
export function trackingState(hand: {
  locateOk: boolean;
  poseActive: boolean;
  positionValid: boolean;
  positionTracked: boolean;
  orientationValid: boolean;
  orientationTracked: boolean;
}): QuestTrackingState {
  if (!hand.locateOk || !hand.poseActive || !hand.positionValid || !hand.orientationValid)
    return 'lost';
  return hand.positionTracked && hand.orientationTracked ? 'tracked' : 'inferred';
}

/** Decodes one hand, or returns null when a value the flags declare valid is malformed. */
export function decodeHand(
  hand: QuestHand,
  ints: readonly number[],
  intAt: number,
  floats: readonly number[],
  floatAt: number
): QuestHandSample | null {
  const locateResult = ints[intAt];
  const locationFlags = ints[intAt + 1];
  const velocityFlags = ints[intAt + 2];
  const active = ints[intAt + 3];
  const down = ints[intAt + 4];
  if (![locateResult, locationFlags, velocityFlags, active, down].every(isInt)) return null;
  const f = floats.slice(floatAt, floatAt + QUEST_INPUT_FLOATS_PER_HAND);
  if (f.length !== QUEST_INPUT_FLOATS_PER_HAND) return null;

  const locateOk = locateResult >= 0;
  const positionValid = locateOk && (locationFlags & XR_SPACE_LOCATION_POSITION_VALID_BIT) !== 0;
  const orientationValid =
    locateOk && (locationFlags & XR_SPACE_LOCATION_ORIENTATION_VALID_BIT) !== 0;
  const positionTracked =
    positionValid && (locationFlags & XR_SPACE_LOCATION_POSITION_TRACKED_BIT) !== 0;
  const orientationTracked =
    orientationValid && (locationFlags & XR_SPACE_LOCATION_ORIENTATION_TRACKED_BIT) !== 0;

  let position: Vec3 | null = null;
  if (positionValid) {
    const p = f.slice(0, 3);
    if (!finiteAll(p)) return null;
    position = [p[0], p[1], p[2]];
  }
  let orientation: Quat | null = null;
  if (orientationValid) {
    const q = f.slice(3, 7);
    if (!finiteAll(q)) return null;
    const norm = Math.hypot(q[0], q[1], q[2], q[3]);
    if (Math.abs(norm - 1) > QUAT_NORM_TOLERANCE) return null;
    orientation = [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm];
  }
  let linearVelocity: Vec3 | null = null;
  if (locateOk && (velocityFlags & XR_SPACE_VELOCITY_LINEAR_VALID_BIT) !== 0) {
    const v = f.slice(7, 10);
    if (!finiteAll(v)) return null;
    linearVelocity = [v[0], v[1], v[2]];
  }
  let angularVelocity: Vec3 | null = null;
  if (locateOk && (velocityFlags & XR_SPACE_VELOCITY_ANGULAR_VALID_BIT) !== 0) {
    const w = f.slice(10, 13);
    if (!finiteAll(w)) return null;
    angularVelocity = [w[0], w[1], w[2]];
  }

  const triggerActive = (active & ACTIVE_TRIGGER) !== 0;
  const squeezeActive = (active & ACTIVE_SQUEEZE) !== 0;
  const stickActive = (active & ACTIVE_THUMBSTICK) !== 0;
  const trigger = triggerActive ? axis(f[13], 0) : 0;
  const squeeze = squeezeActive ? axis(f[14], 0) : 0;
  const stickX = stickActive ? axis(f[15], -1) : 0;
  const stickY = stickActive ? axis(f[16], -1) : 0;
  if (trigger === null || squeeze === null || stickX === null || stickY === null) return null;

  const poseActive = (active & ACTIVE_POSE) !== 0;
  const flags = {
    locateOk,
    poseActive,
    positionValid,
    positionTracked,
    orientationValid,
    orientationTracked,
  };
  return {
    hand,
    ...flags,
    position,
    orientation,
    linearVelocity,
    angularVelocity,
    tracking: trackingState(flags),
    thumbstick: { x: stickX, y: stickY, active: stickActive },
    trigger: { value: trigger, active: triggerActive },
    squeeze: { value: squeeze, active: squeezeActive },
    buttons: {
      primary: (active & ACTIVE_PRIMARY) !== 0 ? (down & DOWN_PRIMARY) !== 0 : null,
      secondary: (active & ACTIVE_SECONDARY) !== 0 ? (down & DOWN_SECONDARY) !== 0 : null,
      menu: hand === 'left' && (active & ACTIVE_MENU) !== 0 ? (down & DOWN_MENU) !== 0 : null,
    },
  };
}

function failed(error: string): QuestDecodedBatch {
  return {
    ok: false,
    error,
    generation: 0,
    live: false,
    actionsReady: false,
    nowNs: null,
    oldestSeq: 0,
    latestSeq: 0,
    published: 0,
    framesWithoutInput: 0,
    rejected: 0,
    samples: [],
    invalid: 0,
  };
}

/** Validates a native batch's shape and decodes each sample. Malformed samples are dropped and counted. */
export function decodeBatch(batch: QuestInputBatch | null | undefined): QuestDecodedBatch {
  if (!batch || typeof batch !== 'object') return failed('no batch');
  if (!batch.available) return failed('unavailable');
  if (batch.error) return failed(`native ${batch.error}`);
  if (batch.version !== QUEST_INPUT_VERSION) return failed(`version ${String(batch.version)}`);
  const count = batch.count;
  const { seq, displayTimeNs, capturedNs, ints, floats } = batch;
  if (!isInt(count) || count < 0 || (batch.capacity !== undefined && count > batch.capacity))
    return failed('count');
  if (
    !Array.isArray(seq) ||
    !Array.isArray(displayTimeNs) ||
    !Array.isArray(capturedNs) ||
    !Array.isArray(ints) ||
    !Array.isArray(floats) ||
    seq.length !== count ||
    displayTimeNs.length !== count ||
    capturedNs.length !== count ||
    ints.length !== count * QUEST_INPUT_INTS_PER_SAMPLE ||
    floats.length !== count * QUEST_INPUT_FLOATS_PER_SAMPLE
  )
    return failed('layout');
  if (!isInt(batch.generation) || batch.generation < 0) return failed('generation');
  const nowNs = batch.nowNs ?? null;
  if (nowNs !== null && !isInt(nowNs)) return failed('now');

  const samples: QuestInputSample[] = [];
  let invalid = 0;
  let previousSeq = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const at = i * QUEST_INPUT_INTS_PER_SAMPLE;
    const syncResult = ints[at];
    const sessionState = ints[at + 1];
    const actionsReady = ints[at + 2] === 1;
    const generation = ints[at + 3];
    const refEpoch = ints[at + 4];
    // Integer nanoseconds: exact offsets, never rounded floats or NaN from Kotlin.
    if (
      !isInt(seq[i]) ||
      seq[i] <= previousSeq ||
      !isInt(displayTimeNs[i]) ||
      !isInt(capturedNs[i]) ||
      ![syncResult, sessionState, generation, refEpoch].every(isInt) ||
      generation !== batch.generation
    ) {
      invalid += 1;
      continue;
    }
    previousSeq = seq[i];
    const floatAt = i * QUEST_INPUT_FLOATS_PER_SAMPLE;
    const left = decodeHand('left', ints, at + 5, floats, floatAt);
    const right = decodeHand(
      'right',
      ints,
      at + 5 + QUEST_INPUT_INTS_PER_HAND,
      floats,
      floatAt + QUEST_INPUT_FLOATS_PER_HAND
    );
    if (!left || !right) {
      invalid += 1;
      continue;
    }
    samples.push({
      seq: seq[i],
      generation,
      refEpoch,
      displayTimeNs: displayTimeNs[i],
      capturedNs: capturedNs[i],
      syncResult,
      sessionState,
      focused: sessionState === XR_SESSION_STATE_FOCUSED && syncResult === XR_SUCCESS,
      actionsReady,
      left,
      right,
    });
  }
  return {
    ok: true,
    error: null,
    generation: batch.generation,
    live: batch.live === true,
    actionsReady: batch.actionsReady === true,
    nowNs,
    oldestSeq: isInt(batch.oldestSeq) ? batch.oldestSeq : 0,
    latestSeq: isInt(batch.latestSeq) ? batch.latestSeq : 0,
    published: isInt(batch.published) ? batch.published : 0,
    framesWithoutInput: isFiniteNumber(batch.framesWithoutInput) ? batch.framesWithoutInput : 0,
    rejected: isFiniteNumber(batch.rejected) ? batch.rejected : 0,
    samples,
    invalid,
  };
}

/**
 * Viro node `rotation` (degrees) for an OpenXR orientation. A port of
 * VROQuaternion::toEuler, the inverse of the Euler set() Viro applies to that prop;
 * Viro feeds OpenXR quaternions to VROQuaternion unchanged.
 */
export function viroEulerDegrees(q: Quat): Vec3 {
  const [x, y, z, w] = q;
  const test = 2 * (y * w - x * z);
  const deg = 180 / Math.PI;
  if (Math.abs(test - 1) < 1e-6) return [0, 90, -2 * Math.atan2(x, w) * deg];
  if (Math.abs(test + 1) < 1e-6) return [0, -90, 2 * Math.atan2(x, w) * deg];
  const sqx = x * x;
  const sqy = y * y;
  const sqz = z * z;
  const sqw = w * w;
  return [
    Math.atan2(2 * (y * z + x * w), -sqx - sqy + sqz + sqw) * deg,
    Math.asin(Math.min(1, Math.max(-1, test))) * deg,
    Math.atan2(2 * (x * y + z * w), sqx - sqy - sqz + sqw) * deg,
  ];
}

/** Value at quantile q (0..1) of an unsorted list, or null when empty. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}
