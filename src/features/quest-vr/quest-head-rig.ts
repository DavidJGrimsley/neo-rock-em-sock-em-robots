import { ARENA_LAYOUT, type FighterTransform } from '../arena-fighter/arena-controller.ts';
import { viroEulerDegrees, type Quat } from './quest-input.ts';

export type Vec3 = readonly [number, number, number];
export type Posture = 'standing' | 'seated';
export type RigAnchor = Pick<FighterTransform, 'x' | 'z' | 'yaw'>;

export const QUEST_WORLD_SCALE = 16;
export const ROBOT_EYE_MODEL: Vec3 = [0, 1.1271, 0.2028];
export const QUEST_HEAD_BOUNDS: Record<
  Posture,
  { lateral: number; crouch: number; rise: number; forward: number; back: number }
> = {
  standing: { lateral: 0.3, crouch: 0.45, rise: 0.05, forward: 0.2, back: 0.2 },
  seated: { lateral: 0.25, crouch: 0.25, rise: 0.05, forward: 0.2, back: 0.2 },
};
export const QUEST_OUT_OF_BOUNDS_EXCESS = 0.3;

const MIN_VECTOR_NORM = 1e-9;
const MIN_HORIZONTAL_FORWARD_NORM = 0.2;
const CALIBRATION_MIN_SAMPLES = 8;
const CALIBRATION_DEFAULT_WINDOW_MS = 500;
const CALIBRATION_MAX_POS_SPREAD_M = 0.03;
const CALIBRATION_MAX_YAW_SPREAD_DEG = 5;

export interface HeadSample {
  t: number;
  position: Vec3;
  forward: Vec3;
  up: Vec3;
}

export interface Calibration {
  origin: Vec3;
  yaw: number;
  posture: Posture;
  source: 'default' | 'solo' | 'system';
  entry: number;
}

export const DEFAULT_CALIBRATION: Calibration = {
  origin: [0, 0, 0],
  yaw: 180,
  posture: 'standing',
  source: 'default',
  entry: 0,
};

function cleanZero(n: number): number {
  return n === 0 ? 0 : n;
}

function readVec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const x = value[0];
  const y = value[1];
  const z = value[2];
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof z !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z)
  ) {
    return null;
  }
  return [x, y, z];
}

function normalizeVec3(v: Vec3): Vec3 | null {
  const norm = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(norm) || norm <= MIN_VECTOR_NORM) return null;
  return [v[0] / norm, v[1] / norm, v[2] / norm];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function wrap180(deg: number): number {
  if (!Number.isFinite(deg)) return NaN;
  let wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  if (wrapped >= 180) wrapped -= 360;
  return cleanZero(wrapped);
}

export function headSampleFromViro(
  t: number,
  e: { position?: unknown; forward?: unknown; up?: unknown }
): HeadSample | null {
  if (!Number.isFinite(t) || !e || typeof e !== 'object') return null;
  const position = readVec3(e.position);
  const rawForward = readVec3(e.forward);
  const rawUp = readVec3(e.up);
  if (!position || !rawForward || !rawUp) return null;
  const forward = normalizeVec3(rawForward);
  const up = normalizeVec3(rawUp);
  if (!forward || !up) return null;
  return { t, position, forward, up };
}

export function yawFromForward(forward: Vec3): number | null {
  if (
    !Number.isFinite(forward[0]) ||
    !Number.isFinite(forward[1]) ||
    !Number.isFinite(forward[2])
  ) {
    return null;
  }
  const horizNorm = Math.hypot(forward[0], forward[2]);
  if (!Number.isFinite(horizNorm) || horizNorm < MIN_HORIZONTAL_FORWARD_NORM) return null;
  return wrap180((Math.atan2(forward[0], forward[2]) * 180) / Math.PI);
}

export function eyeRingLocal(anchor: RigAnchor): Vec3 {
  const r = (anchor.yaw * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const s = ARENA_LAYOUT.fighterScale;
  const mx = ROBOT_EYE_MODEL[0] * s;
  const my = ROBOT_EYE_MODEL[1] * s;
  const mz = ROBOT_EYE_MODEL[2] * s;
  return [
    anchor.x + mx * cos + mz * sin,
    ARENA_LAYOUT.floorHeight + ARENA_LAYOUT.footOffset + my,
    anchor.z - mx * sin + mz * cos,
  ];
}

/**
 * Ring-local floor point under the robot eyes. The rig puts those eyes on the
 * calibrated head, so a marker here sits under the wearer rather than under
 * the fighter's feet, which are ROBOT_EYE_MODEL z behind the eyes.
 */
export function stanceMarkerRingLocal(anchor: RigAnchor): Vec3 {
  const eye = eyeRingLocal(anchor);
  return [eye[0], ARENA_LAYOUT.floorHeight, eye[2]];
}

export interface RigTransform {
  position: Vec3;
  rotationY: number;
  scale: number;
  contentOffset: Vec3;
}

export interface ComposedRigTransform {
  position: Vec3;
  rotationY: number;
  scale: number;
}

export function questRigTransform(
  cal: Calibration,
  anchor: RigAnchor,
  scale = QUEST_WORLD_SCALE
): RigTransform {
  const eye = eyeRingLocal(anchor);
  return {
    position: [cal.origin[0], cal.origin[1], cal.origin[2]],
    rotationY: wrap180(cal.yaw - anchor.yaw),
    scale,
    contentOffset: [-eye[0], -eye[1], -eye[2]],
  };
}

/**
 * Single composed rigid transform mapping ring-local coordinates directly to OpenXR world:
 * world(p) = position + R_y(rotationY) * (scale * p).
 * Keeping translation and rotation on one ViroNode prevents split-node native bridge tearing.
 */
/** Hypothesis, wearer-check: side camera sits this far from the pair, in OpenXR metres. */
export const QUEST_SIDE_VIEW_DISTANCE_M = 3.25;

/**
 * Ring anchor whose eyes sit beside both fighters. Calibration yaw looks at the
 * pair along ring -Z. The headset orientation is not changed.
 */
export function questSideViewAnchor(): RigAnchor {
  const distanceRing = QUEST_SIDE_VIEW_DISTANCE_M / QUEST_WORLD_SCALE;
  const yaw = 180;
  const mz = ROBOT_EYE_MODEL[2] * ARENA_LAYOUT.fighterScale;
  // yaw 180 puts the eye at anchor.z - mz. The pair midpoint is ring z = 0.
  return { x: 0, z: distanceRing + mz, yaw };
}

export function lerpAngle(from: number, to: number, t: number): number {
  return wrap180(from + wrap180(to - from) * t);
}

/** blend 0 is the side view. blend 1 is the eye rig. Scale stays 16. One smoothstep. */
export function questIntroRig(
  cal: Calibration,
  eyeAnchor: RigAnchor,
  blend: number
): ComposedRigTransform {
  const eye = questComposedRigTransform(cal, eyeAnchor);
  const side = questComposedRigTransform(cal, questSideViewAnchor());
  const t = Math.min(1, Math.max(0, blend));
  if (t <= 0) return side;
  if (t >= 1) return eye;
  const smooth = t * t * (3 - 2 * t);
  return {
    position: [
      side.position[0] + (eye.position[0] - side.position[0]) * smooth,
      side.position[1] + (eye.position[1] - side.position[1]) * smooth,
      side.position[2] + (eye.position[2] - side.position[2]) * smooth,
    ],
    rotationY: lerpAngle(side.rotationY, eye.rotationY, smooth),
    scale: eye.scale,
  };
}

/** Hypothesis: the fade quad sits this far along the live head forward, in metres. */
export const QUEST_INTRO_COVER_DISTANCE_M = 0.35;

function coverNormalize(v: Vec3): Vec3 | null {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(n) || n < 1e-8) return null;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function coverCross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function coverDot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Pose for a scene quad that fills the current view. The headset orientation
 * is not changed. A ViroQuad faces local +Z, so +Z points back at the head.
 */
export function questHeadCoverPose(
  sample: HeadSample,
  distanceM = QUEST_INTRO_COVER_DISTANCE_M
): { position: Vec3; rotation: Vec3 } | null {
  const forward = coverNormalize(sample.forward);
  const up = coverNormalize(sample.up);
  if (!forward || !up || !Number.isFinite(distanceM) || distanceM <= 0) return null;
  const zAxis: Vec3 = [-forward[0], -forward[1], -forward[2]];
  let y = [
    up[0] - zAxis[0] * coverDot(up, zAxis),
    up[1] - zAxis[1] * coverDot(up, zAxis),
    up[2] - zAxis[2] * coverDot(up, zAxis),
  ] as Vec3;
  if (Math.hypot(y[0], y[1], y[2]) < 1e-6) {
    const fallback: Vec3 = Math.abs(zAxis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    y = [
      fallback[0] - zAxis[0] * coverDot(fallback, zAxis),
      fallback[1] - zAxis[1] * coverDot(fallback, zAxis),
      fallback[2] - zAxis[2] * coverDot(fallback, zAxis),
    ];
  }
  const yAxis = coverNormalize(y);
  if (!yAxis) return null;
  const xAxis = coverNormalize(coverCross(yAxis, zAxis));
  if (!xAxis) return null;
  const rebuiltY = coverNormalize(coverCross(zAxis, xAxis));
  if (!rebuiltY) return null;
  const m = [
    xAxis[0],
    xAxis[1],
    xAxis[2],
    rebuiltY[0],
    rebuiltY[1],
    rebuiltY[2],
    zAxis[0],
    zAxis[1],
    zAxis[2],
  ];
  const trace = m[0] + m[4] + m[8];
  let x: number;
  let yy: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m[5] - m[7]) / s;
    yy = (m[6] - m[2]) / s;
    z = (m[1] - m[3]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[5] - m[7]) / s;
    x = 0.25 * s;
    yy = (m[3] + m[1]) / s;
    z = (m[6] + m[2]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[6] - m[2]) / s;
    x = (m[3] + m[1]) / s;
    yy = 0.25 * s;
    z = (m[7] + m[5]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[1] - m[3]) / s;
    x = (m[6] + m[2]) / s;
    yy = (m[7] + m[5]) / s;
    z = 0.25 * s;
  }
  const n = Math.hypot(x, yy, z, w);
  if (!Number.isFinite(n) || n < 1e-8) return null;
  const rotation = viroEulerDegrees([x / n, yy / n, z / n, w / n] as Quat);
  return {
    position: [
      sample.position[0] + forward[0] * distanceM,
      sample.position[1] + forward[1] * distanceM,
      sample.position[2] + forward[2] * distanceM,
    ],
    rotation,
  };
}

export function questComposedRigTransform(
  cal: Calibration,
  anchor: RigAnchor,
  scale = QUEST_WORLD_SCALE
): ComposedRigTransform {
  const rig = questRigTransform(cal, anchor, scale);
  const r = (rig.rotationY * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const sx = scale * rig.contentOffset[0];
  const sy = scale * rig.contentOffset[1];
  const sz = scale * rig.contentOffset[2];
  return {
    position: [
      cleanZero(rig.position[0] + sx * cos + sz * sin),
      cleanZero(rig.position[1] + sy),
      cleanZero(rig.position[2] - sx * sin + sz * cos),
    ],
    rotationY: rig.rotationY,
    scale,
  };
}

export function applyRig(rig: RigTransform, ringLocal: Vec3): Vec3 {
  const sx = rig.scale * (ringLocal[0] + rig.contentOffset[0]);
  const sy = rig.scale * (ringLocal[1] + rig.contentOffset[1]);
  const sz = rig.scale * (ringLocal[2] + rig.contentOffset[2]);
  const r = (rig.rotationY * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [
    rig.position[0] + sx * cos + sz * sin,
    rig.position[1] + sy,
    rig.position[2] - sx * sin + sz * cos,
  ];
}

export function menuFrame(cal: Calibration): { position: Vec3; rotationY: number } {
  return {
    position: [cal.origin[0], cal.origin[1], cal.origin[2]],
    rotationY: wrap180(cal.yaw - 180),
  };
}

/**
 * Rotates calibration around the wearer's current horizontal head XZ without
 * disturbing physical headset tracking or shifting apparent stance center.
 */
export function applyYawTurnToCalibration(
  cal: Calibration,
  headPosition: Vec3 | null | undefined,
  deltaYawDeg: number
): Calibration {
  if (!Number.isFinite(deltaYawDeg) || deltaYawDeg === 0) return cal;
  const hx = headPosition && Number.isFinite(headPosition[0]) ? headPosition[0] : cal.origin[0];
  const hz = headPosition && Number.isFinite(headPosition[2]) ? headPosition[2] : cal.origin[2];
  const rad = (deltaYawDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const vx = cal.origin[0] - hx;
  const vz = cal.origin[2] - hz;
  return {
    ...cal,
    origin: [
      cleanZero(hx + vx * cos + vz * sin),
      cal.origin[1],
      cleanZero(hz - vx * sin + vz * cos),
    ],
    yaw: wrap180(cal.yaw + deltaYawDeg),
  };
}

export type CalibrationResult =
  { ok: true; origin: Vec3; yaw: number } | { ok: false; reason: 'too-few' | 'moving' | 'invalid' };

function isSampleStructurallyValid(sample: HeadSample): boolean {
  if (!sample || typeof sample !== 'object' || !Number.isFinite(sample.t)) return false;
  const pos = readVec3(sample.position);
  const fwd = readVec3(sample.forward);
  const up = readVec3(sample.up);
  if (!pos || !fwd || !up) return false;
  return (
    Math.hypot(fwd[0], fwd[1], fwd[2]) > MIN_VECTOR_NORM &&
    Math.hypot(up[0], up[1], up[2]) > MIN_VECTOR_NORM
  );
}

export function calibrateFromSamples(
  samples: readonly HeadSample[],
  windowMs = CALIBRATION_DEFAULT_WINDOW_MS
): CalibrationResult {
  if (!Array.isArray(samples) || !Number.isFinite(windowMs) || windowMs <= 0) {
    return { ok: false, reason: 'invalid' };
  }
  if (samples.length === 0) return { ok: false, reason: 'too-few' };
  let latestT = -Infinity;
  for (const sample of samples) {
    if (!isSampleStructurallyValid(sample)) return { ok: false, reason: 'invalid' };
    if (sample.t > latestT) latestT = sample.t;
  }
  const cutoff = latestT - windowMs;
  const windowSamples = samples.filter((sample) => sample.t >= cutoff);
  if (windowSamples.length < CALIBRATION_MIN_SAMPLES) {
    return { ok: false, reason: 'too-few' };
  }

  const yaws: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  let sumSin = 0;
  let sumCos = 0;

  for (const sample of windowSamples) {
    const yaw = yawFromForward(sample.forward);
    if (yaw === null) return { ok: false, reason: 'invalid' };
    yaws.push(yaw);
    xs.push(sample.position[0]);
    ys.push(sample.position[1]);
    zs.push(sample.position[2]);
    const r = (yaw * Math.PI) / 180;
    sumSin += Math.sin(r);
    sumCos += Math.cos(r);
  }

  if (Math.hypot(sumSin, sumCos) <= MIN_VECTOR_NORM) {
    return { ok: false, reason: 'moving' };
  }

  const origin: Vec3 = [median(xs), median(ys), median(zs)];
  const meanYaw = wrap180((Math.atan2(sumSin, sumCos) * 180) / Math.PI);

  for (let i = 0; i < windowSamples.length; i += 1) {
    const p = windowSamples[i].position;
    const dist = Math.hypot(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
    if (dist > CALIBRATION_MAX_POS_SPREAD_M) {
      return { ok: false, reason: 'moving' };
    }
    const yawDev = Math.abs(wrap180(yaws[i] - meanYaw));
    if (yawDev > CALIBRATION_MAX_YAW_SPREAD_DEG) {
      return { ok: false, reason: 'moving' };
    }
  }

  return { ok: true, origin, yaw: meanYaw };
}

// A reference-frame change (Horizon system recenter or a tracking-origin reset)
// moves every LOCAL pose by one yaw-plus-translation between two frames. Viro
// 3.0.3 sees XR_TYPE_EVENT_DATA_REFERENCE_SPACE_CHANGE_PENDING natively but
// does not forward it to JS, so the only evidence is the raw head samples. A
// head cannot cover 0.25 m or turn 45 degrees in one 72 Hz frame, so only a step
// above both the floor and a generous head-speed bound counts. Longer gaps are
// never treated as a jump: the wearer may really have moved.
export const REFERENCE_JUMP_MAX_DT_MS = 100;
export const REFERENCE_JUMP_MIN_POSITION_M = 0.25;
export const REFERENCE_JUMP_MIN_YAW_DEG = 45;
const HEAD_MAX_SPEED_M_PER_S = 4;
const HEAD_MAX_YAW_RATE_DEG_PER_S = 900;

export interface HeadStep {
  dt: number;
  delta: Vec3;
  distance: number;
  yawDelta: number | null;
}

export function headStep(previous: HeadSample, next: HeadSample): HeadStep {
  const delta: Vec3 = [
    next.position[0] - previous.position[0],
    next.position[1] - previous.position[1],
    next.position[2] - previous.position[2],
  ];
  const fromYaw = yawFromForward(previous.forward);
  const toYaw = yawFromForward(next.forward);
  return {
    dt: next.t - previous.t,
    delta,
    distance: Math.hypot(delta[0], delta[1], delta[2]),
    yawDelta: fromYaw === null || toYaw === null ? null : wrap180(toYaw - fromYaw),
  };
}

/** True only for a near-instant step no real head motion could produce. */
export function isReferenceDiscontinuity(step: HeadStep): boolean {
  if (!(step.dt > 0) || step.dt > REFERENCE_JUMP_MAX_DT_MS) return false;
  const seconds = step.dt / 1000;
  const positionLimit = Math.max(REFERENCE_JUMP_MIN_POSITION_M, HEAD_MAX_SPEED_M_PER_S * seconds);
  const yawLimit = Math.max(REFERENCE_JUMP_MIN_YAW_DEG, HEAD_MAX_YAW_RATE_DEG_PER_S * seconds);
  return (
    step.distance >= positionLimit ||
    (step.yawDelta !== null && Math.abs(step.yawDelta) >= yawLimit)
  );
}

export interface GameplayHeadPose {
  lateral: number;
  vertical: number;
  forward: number;
  sim: { lateral: number; vertical: number; forward: number };
  yawRelative: number;
  clamped: boolean;
  excess: number;
  outOfBounds: boolean;
}

export function gameplayHeadPose(
  cal: Calibration,
  sample: HeadSample,
  scale = QUEST_WORLD_SCALE
): GameplayHeadPose {
  const effectiveScale = Number.isFinite(scale) && scale > 0 ? scale : QUEST_WORLD_SCALE;
  const r = (cal.yaw * Math.PI) / 180;
  const sin = Math.sin(r);
  const cos = Math.cos(r);

  const dx = sample.position[0] - cal.origin[0];
  const dy = sample.position[1] - cal.origin[1];
  const dz = sample.position[2] - cal.origin[2];

  // Facing basis: forward(psi) = (sin psi, 0, cos psi), right(psi) = (-cos psi, 0, sin psi).
  const rawLateral = -dx * cos + dz * sin;
  const rawVertical = dy;
  const rawForward = dx * sin + dz * cos;

  const bounds = QUEST_HEAD_BOUNDS[cal.posture];
  const lateral = cleanZero(clamp(rawLateral, -bounds.lateral, bounds.lateral));
  const vertical = cleanZero(clamp(rawVertical, -bounds.crouch, bounds.rise));
  const forward = cleanZero(clamp(rawForward, -bounds.back, bounds.forward));

  const excess = Math.hypot(rawLateral - lateral, rawVertical - vertical, rawForward - forward);
  const clamped = excess > 0;
  const outOfBounds = excess > QUEST_OUT_OF_BOUNDS_EXCESS;
  const sampleYaw = yawFromForward(sample.forward);
  const yawRelative = sampleYaw === null ? 0 : wrap180(sampleYaw - cal.yaw);

  return {
    lateral,
    vertical,
    forward,
    sim: {
      lateral: cleanZero(lateral / effectiveScale),
      vertical: cleanZero(vertical / effectiveScale),
      forward: cleanZero(forward / effectiveScale),
    },
    yawRelative,
    clamped,
    excess,
    outOfBounds,
  };
}
