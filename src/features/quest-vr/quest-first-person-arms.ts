// Cosmetic placement for the Quest first-person fists and a two-bone arm.
// The elbow is solved from the shoulder and the tracked wrist. It is not a
// tracked joint. This module does not mount a mesh, read the grip float, or
// emit a punch, block, or damage command.
//
// Runtime fists attach the measured mesh palm to the real controller grip in
// OpenXR LOCAL metres. Scale once by fighterScale * QUEST_WORLD_SCALE (16). The rig
// applies that 16 again, so this scale is only valid at the scene root.
import { ARENA_LAYOUT } from '../arena-fighter/arena-controller.ts';
import { QUEST_WORLD_SCALE, ROBOT_EYE_MODEL, type Calibration } from './quest-head-rig.ts';
import {
  viroEulerDegrees,
  type QuestHand,
  type QuestHandSample,
  type QuestInputSample,
  type Quat,
  type Vec3,
} from './quest-input.ts';

/** One uniform scene-root scale: tabletop fighterScale, then VR metres. */
export const QUEST_FIRST_PERSON_ARM_SCALE = ARENA_LAYOUT.fighterScale * QUEST_WORLD_SCALE;

// Proper mesh -> OpenXR grip rotations, not aim-ray rolls or reflected meshes.
// Grip -Z is little-finger -> thumb; mesh +X is left thumb, -X right thumb.
export const QUEST_HAND_MESH_TO_GRIP: Record<QuestHand, Quat> = {
  left: [-0.5, 0.5, 0.5, 0.5],
  right: [-0.5, -0.5, -0.5, 0.5],
};
export const QUEST_HAND_PALM_CENTER_MODEL: Record<QuestHand, Vec3> = {
  left: [0.000395137, -0.005049033, -0.068952912],
  right: [-0.000395141, -0.005049129, -0.068952916],
};

export function multiplyControllerQuat(a: Quat, b: Quat): Quat {
  const [x, y, z, w] = a;
  const [bx, by, bz, bw] = b;
  return [
    w * bx + x * bw + y * bz - z * by,
    w * by - x * bz + y * bw + z * bx,
    w * bz + x * by - y * bx + z * bw,
    w * bw - x * bx - y * by - z * bz,
  ];
}

export function rotateControllerVector(q: Quat, point: Vec3): Vec3 {
  const v: Vec3 = [q[0], q[1], q[2]];
  const t = scale(cross(v, point), 2);
  return add(point, add(scale(t, q[3]), cross(v, t)));
}

export function controllerFistPose(hand: QuestHand, position: Vec3, orientation: Quat) {
  const norm = Math.hypot(...orientation);
  if (
    !finiteVec3(position) ||
    !Number.isFinite(norm) ||
    Math.abs(norm - 1) > AIM_QUAT_NORM_TOLERANCE
  )
    return null;
  const q = orientation.map((v) => v / norm) as unknown as Quat;
  const rotation = multiplyControllerQuat(q, QUEST_HAND_MESH_TO_GRIP[hand]);
  const wrist = sub(
    position,
    rotateControllerVector(
      rotation,
      scale(QUEST_HAND_PALM_CENTER_MODEL[hand], QUEST_FIRST_PERSON_ARM_SCALE)
    )
  );
  return { position: wrist, orientation: rotation };
}

/** Matches the unit-quaternion tolerance in decodeHand. */
const AIM_QUAT_NORM_TOLERANCE = 0.05;

// Rest-pose joint positions in the Combat GLB, measured by the extract script,
// with the body's +0.16 model-unit forward shift applied to the shoulders.
const ARM_JOINTS = {
  left: {
    shoulder: [0.127665097, 0.83775128, 0.135874959] as Vec3,
    upper: 0.218699927,
    forearm: 0.188133323,
  },
  right: {
    shoulder: [-0.127665068, 0.837751263, 0.135874958] as Vec3,
    upper: 0.218700012,
    forearm: 0.188133346,
  },
} as const;

// Hypothesis, wearer-check: stretch both bones on local Z up to this multiple,
// then keep only the tracked fist visible. 2.05 * (L1 + L2) is about 1.00 m.
export const QUEST_ARM_STRETCH_CAP = 2.05;
// Hypothesis: stay straight until the wrist is inside this fraction of full reach.
export const QUEST_ARM_BEND_FRACTION = 0.94;
// Hypothesis: pole weights. Signs are measured: left outward is model +X, back is -Z.
const POLE_OUT = 0.45;
const POLE_DOWN = -1;
const POLE_BACK = -0.25;

export type QuestArmRejectReason =
  | 'missing-sample'
  | 'hand-mismatch'
  | 'ref-epoch-mismatch'
  | 'tracking-lost'
  | 'invalid-aim-pose'
  | 'missing-grip-pose'
  | 'stale-pose'
  | 'reach-exceeded';

export interface QuestArmSegment {
  position: Vec3;
  rotation: Vec3;
  /** Local scale. X and Y stay at the arm scale; Z carries the bone stretch. */
  scale: Vec3;
}

export interface QuestArmPlacement {
  hand: QuestHand;
  visible: boolean;
  reason: QuestArmRejectReason | null;
  /** Aim position in OpenXR LOCAL metres. Not multiplied by scale. */
  position: Vec3 | null;
  /** Viro degrees from the aim quaternion, the same conversion as the controller marker. */
  rotation: Vec3 | null;
  /** Uniform fist scale applied once, on a scene-root node. */
  scale: number;
  /** Null when the shoulder is unknown or this arm is hidden. */
  upper: QuestArmSegment | null;
  /** Null when the shoulder is unknown or this arm is hidden. */
  forearm: QuestArmSegment | null;
}

export interface QuestFirstPersonArmsFrame {
  left: QuestArmPlacement;
  right: QuestArmPlacement;
  /** Always null. Cosmetic placement never carries a combat command. */
  combatCommand: null;
}

export interface QuestArmBody {
  calibration: Calibration;
  lift: number;
}

function hidden(hand: QuestHand, reason: QuestArmRejectReason): QuestArmPlacement {
  return {
    hand,
    visible: false,
    reason,
    position: null,
    rotation: null,
    scale: QUEST_FIRST_PERSON_ARM_SCALE,
    upper: null,
    forearm: null,
  };
}

function finiteVec3(value: readonly number[] | null | undefined): value is Vec3 {
  return (
    !!value &&
    value.length === 3 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Number.isFinite(value[2])
  );
}

function aimRotation(orientation: readonly number[] | null | undefined): Vec3 | null {
  if (!orientation || orientation.length !== 4 || !orientation.every(Number.isFinite)) return null;
  const [x, y, z, w] = orientation;
  const norm = Math.hypot(x, y, z, w);
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > AIM_QUAT_NORM_TOLERANCE) return null;
  const rotation = viroEulerDegrees([x / norm, y / norm, z / norm, w / norm] as Quat);
  if (!finiteVec3(rotation)) return null;
  return [rotation[0], rotation[1], rotation[2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function lengthOf(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize(v: Vec3): Vec3 | null {
  const n = lengthOf(v);
  if (!Number.isFinite(n) || n < 1e-8) return null;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** Same yaw convention as questComposedRigTransform. */
function rotateY(v: Vec3, yawDeg: number): Vec3 {
  const r = (yawDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [v[0] * cos + v[2] * sin, v[1], -v[0] * sin + v[2] * cos];
}

function quatFromBasis(xAxis: Vec3, yAxis: Vec3, zAxis: Vec3): Quat {
  const m = [
    xAxis[0],
    xAxis[1],
    xAxis[2],
    yAxis[0],
    yAxis[1],
    yAxis[2],
    zAxis[0],
    zAxis[1],
    zAxis[2],
  ];
  const trace = m[0] + m[4] + m[8];
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m[5] - m[7]) / s;
    y = (m[6] - m[2]) / s;
    z = (m[1] - m[3]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[5] - m[7]) / s;
    x = 0.25 * s;
    y = (m[3] + m[1]) / s;
    z = (m[6] + m[2]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[6] - m[2]) / s;
    x = (m[3] + m[1]) / s;
    y = 0.25 * s;
    z = (m[7] + m[5]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[1] - m[3]) / s;
    x = (m[6] + m[2]) / s;
    y = (m[7] + m[5]) / s;
    z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w);
  return [x / n, y / n, z / n, w / n];
}

function basisEuler(zAxis: Vec3, upHint: Vec3): Vec3 | null {
  let y = sub(upHint, scale(zAxis, dot(upHint, zAxis)));
  if (lengthOf(y) < 1e-6) {
    const fallback = Math.abs(zAxis[1]) < 0.9 ? ([0, 1, 0] as Vec3) : ([1, 0, 0] as Vec3);
    y = sub(fallback, scale(zAxis, dot(fallback, zAxis)));
  }
  const yAxis = normalize(y);
  if (!yAxis) return null;
  const xAxis = normalize(cross(yAxis, zAxis));
  if (!xAxis) return null;
  const rebuiltY = normalize(cross(zAxis, xAxis));
  if (!rebuiltY) return null;
  return aimRotation(quatFromBasis(xAxis, rebuiltY, zAxis));
}

function shoulderWorld(hand: QuestHand, body: QuestArmBody): Vec3 {
  const joint = ARM_JOINTS[hand].shoulder;
  const relative: Vec3 = [
    (joint[0] - ROBOT_EYE_MODEL[0]) * QUEST_FIRST_PERSON_ARM_SCALE,
    (joint[1] - ROBOT_EYE_MODEL[1]) * QUEST_FIRST_PERSON_ARM_SCALE,
    (joint[2] - ROBOT_EYE_MODEL[2]) * QUEST_FIRST_PERSON_ARM_SCALE,
  ];
  const rotated = rotateY(relative, body.calibration.yaw);
  return [
    body.calibration.origin[0] + rotated[0],
    body.calibration.origin[1] + rotated[1] + body.lift * QUEST_WORLD_SCALE,
    body.calibration.origin[2] + rotated[2],
  ];
}

function fistUpWorld(orientation: readonly number[]): Vec3 | null {
  if (orientation.length !== 4 || !orientation.every(Number.isFinite)) return null;
  const [x, y, z, w] = orientation;
  const norm = Math.hypot(x, y, z, w);
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > AIM_QUAT_NORM_TOLERANCE) return null;
  const qx = x / norm;
  const qy = y / norm;
  const qz = z / norm;
  const qw = w / norm;
  return normalize([2 * (qx * qy - qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qw * qx)]);
}

function solveArm(
  hand: QuestHand,
  wrist: Vec3,
  fistRotation: Vec3,
  fistUp: Vec3 | null,
  body: QuestArmBody
): QuestArmPlacement | null {
  const metrics = ARM_JOINTS[hand];
  const boneScale = QUEST_FIRST_PERSON_ARM_SCALE;
  const upperLen = metrics.upper * boneScale;
  const forearmLen = metrics.forearm * boneScale;
  const reach = upperLen + forearmLen;
  const shoulder = shoulderWorld(hand, body);
  const delta = sub(wrist, shoulder);
  const distance = lengthOf(delta);
  if (!Number.isFinite(distance) || distance < 1e-4) return null;
  if (distance > QUEST_ARM_STRETCH_CAP * reach) return null;
  const bendAt = QUEST_ARM_BEND_FRACTION * reach;
  const zScale = distance > bendAt ? Math.min(QUEST_ARM_STRETCH_CAP, distance / bendAt) : 1;
  const upperEff = upperLen * zScale;
  const forearmEff = forearmLen * zScale;
  const direction = normalize(delta);
  if (!direction) return null;
  const side = hand === 'left' ? 1 : -1;
  const poleLocal = normalize([side * POLE_OUT, POLE_DOWN, POLE_BACK]);
  if (!poleLocal) return null;
  const pole = rotateY(poleLocal, body.calibration.yaw);
  let polePerp = sub(pole, scale(direction, dot(pole, direction)));
  if (lengthOf(polePerp) < 1e-5)
    polePerp = sub([0, -1, 0], scale(direction, dot([0, -1, 0], direction)));
  const bendDir = normalize(polePerp);
  if (!bendDir) return null;
  const along =
    (upperEff * upperEff - forearmEff * forearmEff + distance * distance) / (2 * distance);
  const height2 = Math.max(0, upperEff * upperEff - along * along);
  const elbow = add(add(shoulder, scale(direction, along)), scale(bendDir, Math.sqrt(height2)));
  const upperDir = normalize(sub(elbow, shoulder));
  const forearmDir = normalize(sub(elbow, wrist));
  if (!upperDir || !forearmDir) return null;
  const dorsalUp = scale(pole, -1);
  // Keep dorsal +Y pointing upward (opposite the downward elbow pole) on upper and forearm,
  // aligning the forearm dorsal face with the fist's back-of-hand +Y when non-collinear.
  const forearmUp =
    fistUp && lengthOf(sub(fistUp, scale(forearmDir, dot(fistUp, forearmDir)))) >= 1e-3
      ? fistUp
      : dorsalUp;
  // Upper mesh local -Z points at the elbow, so local +Z points back toward the shoulder.
  const upperRotation = basisEuler(scale(upperDir, -1), dorsalUp);
  // Forearm mesh local +Z points at the elbow.
  const forearmRotation = basisEuler(forearmDir, forearmUp);
  if (!upperRotation || !forearmRotation) return null;
  const upperScale: Vec3 = [boneScale, boneScale, boneScale * zScale];
  const forearmScale: Vec3 = [boneScale, boneScale, boneScale * zScale];
  return {
    hand,
    visible: true,
    reason: null,
    position: wrist,
    rotation: fistRotation,
    scale: boneScale,
    upper: { position: shoulder, rotation: upperRotation, scale: upperScale },
    forearm: { position: wrist, rotation: forearmRotation, scale: forearmScale },
  };
}

function placeHand(
  hand: QuestHand,
  sample: QuestHandSample | null | undefined,
  body: QuestArmBody | null,
  poseSource: 'aim' | 'grip'
): QuestArmPlacement {
  if (!sample) return hidden(hand, 'missing-sample');
  if (sample.hand !== hand) return hidden(hand, 'hand-mismatch');
  if (poseSource === 'grip') {
    const grip = sample.grip;
    if (!grip) return hidden(hand, 'missing-grip-pose');
    if (grip.tracking === 'lost' || !grip.position || !grip.orientation)
      return hidden(hand, 'tracking-lost');
    const pose = controllerFistPose(hand, grip.position, grip.orientation);
    if (!pose) return hidden(hand, 'invalid-aim-pose');
    sample = { ...sample, ...grip, position: pose.position, orientation: pose.orientation };
  }
  if (sample.tracking === 'lost') return hidden(hand, 'tracking-lost');
  if (!finiteVec3(sample.position)) return hidden(hand, 'invalid-aim-pose');
  const rotation = aimRotation(sample.orientation);
  if (!rotation) return hidden(hand, 'invalid-aim-pose');
  const wrist: Vec3 = [sample.position[0], sample.position[1], sample.position[2]];
  if (body && Number.isFinite(body.lift)) {
    const solved = solveArm(hand, wrist, rotation, fistUpWorld(sample.orientation!), body);
    if (solved) return solved;
  }
  return {
    hand,
    visible: true,
    reason: null,
    position: wrist,
    rotation,
    scale: QUEST_FIRST_PERSON_ARM_SCALE,
    upper: null,
    forearm: null,
  };
}

/**
 * Places the left and right cosmetics from real grip poses in runtime mode.
 * The default aim mode remains for legacy diagnostics only.
 * A numeric refEpoch that disagrees with the head sample hides both hands.
 * A missing head epoch does not hide, matching questLocomotionFromInput.
 * Pass `body` to solve the cosmetic elbow. Without it, only the fists are placed.
 */
export function placeQuestFirstPersonArms(input: {
  sample?: QuestInputSample | null;
  headRefEpoch?: number | null;
  body?: QuestArmBody | null;
  /** Runtime visuals use real grip poses. Legacy aim placement remains for old diagnostic callers. */
  poseSource?: 'aim' | 'grip';
  /** Same monotonic origin as capturedNs. Optional for synthetic/legacy callers. */
  nowNs?: number | null;
}): QuestFirstPersonArmsFrame {
  const sample = input.sample;
  const body = input.body ?? null;
  if (!sample) {
    return {
      left: hidden('left', 'missing-sample'),
      right: hidden('right', 'missing-sample'),
      combatCommand: null,
    };
  }
  if (
    input.poseSource === 'grip' &&
    (!sample.focused || !sample.actionsReady || input.nowNs === null)
  ) {
    return {
      left: hidden('left', 'tracking-lost'),
      right: hidden('right', 'tracking-lost'),
      combatCommand: null,
    };
  }
  if (
    typeof input.nowNs === 'number' &&
    (!Number.isFinite(input.nowNs) ||
      !Number.isFinite(sample.capturedNs) ||
      input.nowNs < sample.capturedNs ||
      input.nowNs - sample.capturedNs > 50_000_000)
  ) {
    return {
      left: hidden('left', 'stale-pose'),
      right: hidden('right', 'stale-pose'),
      combatCommand: null,
    };
  }
  if (
    typeof sample.refEpoch === 'number' &&
    typeof input.headRefEpoch === 'number' &&
    sample.refEpoch !== input.headRefEpoch
  ) {
    return {
      left: hidden('left', 'ref-epoch-mismatch'),
      right: hidden('right', 'ref-epoch-mismatch'),
      combatCommand: null,
    };
  }
  return {
    left: placeHand('left', sample.left, body, input.poseSource ?? 'aim'),
    right: placeHand('right', sample.right, body, input.poseSource ?? 'aim'),
    combatCommand: null,
  };
}
