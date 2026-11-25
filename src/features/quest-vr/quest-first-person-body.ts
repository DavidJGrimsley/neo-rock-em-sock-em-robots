/** Pure Quest first-person body clip mapping and transition stability. */

export const QUEST_FIRST_PERSON_BODY_CLIPS = [
  'IdleAggro',
  'WalkForward',
  'WalkBackward',
  'StrafeLeft',
  'StrafeRight',
  'WalkForwardLeft',
  'WalkForwardRight',
  'WalkBackwardLeft',
  'WalkBackwardRight',
] as const;

export type QuestFirstPersonBodyClip = (typeof QUEST_FIRST_PERSON_BODY_CLIPS)[number];
export type QuestFirstPersonBodyWalkClip = Exclude<QuestFirstPersonBodyClip, 'IdleAggro'>;

export interface QuestFirstPersonBodyTrackerState {
  clip: QuestFirstPersonBodyClip;
  candidateClip: QuestFirstPersonBodyClip | null;
  candidateSeconds: number;
}

export interface QuestFirstPersonBodyStepInput {
  /** True only in active eyes presentation when input/app focus allows locomotion. */
  active: boolean;
  /** True when fighter animations are running (false when paused or recenter-gated). */
  running: boolean;
  /** Ring displacement velocity projected onto the blue fighter's forward axis (sim units/s). */
  forwardSpeed: number;
  /** Ring displacement velocity projected onto the blue fighter's left axis (sim units/s). */
  leftSpeed: number;
  dtSeconds: number;
}

/** Ring-space linear speeds (sim units/s; max walk is 0.08) where movement engages and releases cleanly. */
export const QUEST_BODY_MOVE_START_SPEED = 0.012;
export const QUEST_BODY_MOVE_STOP_SPEED = 0.006;
/** Half-width of each 8-way locomotion sector and angular hysteresis band (degrees) to prevent boundary chatter. */
export const QUEST_BODY_SECTOR_HALF_WIDTH_DEG = 22.5;
export const QUEST_BODY_DIRECTION_HYSTERESIS_DEG = 6;
/** Brief dwell before swapping between active walk/strafe/diagonal clips; start/focus-loss are immediate. */
export const QUEST_BODY_CLIP_SWITCH_DWELL_S = 0.06;
/** Brief dwell before dropping walk->idle on zero-crossing stick reversals; release settles in 45ms. */
export const QUEST_BODY_STOP_DWELL_S = 0.045;

const DWELL_EPSILON_S = 1e-6;

const WALK_SECTOR_CENTERS: readonly {
  clip: QuestFirstPersonBodyWalkClip;
  angleDeg: number;
}[] = [
  { clip: 'WalkForward', angleDeg: 0 },
  { clip: 'WalkForwardLeft', angleDeg: 45 },
  { clip: 'StrafeLeft', angleDeg: 90 },
  { clip: 'WalkBackwardLeft', angleDeg: 135 },
  { clip: 'WalkBackward', angleDeg: 180 },
  { clip: 'WalkBackwardRight', angleDeg: -135 },
  { clip: 'StrafeRight', angleDeg: -90 },
  { clip: 'WalkForwardRight', angleDeg: -45 },
];

const WALK_SECTOR_ANGLE_BY_CLIP: Record<QuestFirstPersonBodyWalkClip, number> = {
  WalkForward: 0,
  WalkForwardLeft: 45,
  StrafeLeft: 90,
  WalkBackwardLeft: 135,
  WalkBackward: 180,
  WalkBackwardRight: -135,
  StrafeRight: -90,
  WalkForwardRight: -45,
};

function absAngleDiffDeg(aDeg: number, bDeg: number): number {
  const diff = ((((aDeg - bDeg + 180) % 360) + 360) % 360) - 180;
  return Math.abs(diff);
}

export function createQuestFirstPersonBodyTrackerState(): QuestFirstPersonBodyTrackerState {
  return {
    clip: 'IdleAggro',
    candidateClip: null,
    candidateSeconds: 0,
  };
}

function pickDesiredWalkClip(
  current: QuestFirstPersonBodyClip,
  forwardSpeed: number,
  leftSpeed: number
): QuestFirstPersonBodyWalkClip {
  const angleDeg = (Math.atan2(leftSpeed, forwardSpeed) * 180) / Math.PI;
  if (current !== 'IdleAggro') {
    const currentCenterDeg = WALK_SECTOR_ANGLE_BY_CLIP[current];
    if (
      absAngleDiffDeg(angleDeg, currentCenterDeg) <=
      QUEST_BODY_SECTOR_HALF_WIDTH_DEG + QUEST_BODY_DIRECTION_HYSTERESIS_DEG
    ) {
      return current;
    }
  }

  let bestClip: QuestFirstPersonBodyWalkClip = 'WalkForward';
  let bestDiff = Infinity;
  for (const sector of WALK_SECTOR_CENTERS) {
    const diff = absAngleDiffDeg(angleDeg, sector.angleDeg);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestClip = sector.clip;
    }
  }
  return bestClip;
}

/** Advances the first-person body clip state machine by one simulation tick. */
export function stepQuestFirstPersonBodyClip(
  state: QuestFirstPersonBodyTrackerState,
  input: QuestFirstPersonBodyStepInput
): QuestFirstPersonBodyTrackerState {
  if (!input.active || !input.running) {
    return createQuestFirstPersonBodyTrackerState();
  }

  const forwardSpeed = Number.isFinite(input.forwardSpeed) ? input.forwardSpeed : 0;
  const leftSpeed = Number.isFinite(input.leftSpeed) ? input.leftSpeed : 0;
  const dtSeconds = Number.isFinite(input.dtSeconds) && input.dtSeconds > 0 ? input.dtSeconds : 0;
  const speed = Math.hypot(forwardSpeed, leftSpeed);

  const threshold =
    state.clip === 'IdleAggro' ? QUEST_BODY_MOVE_START_SPEED : QUEST_BODY_MOVE_STOP_SPEED;
  if (speed < threshold) {
    if (state.clip === 'IdleAggro') {
      return createQuestFirstPersonBodyTrackerState();
    }
    const stopElapsed =
      (state.candidateClip === 'IdleAggro' ? state.candidateSeconds : 0) + dtSeconds;
    if (stopElapsed + DWELL_EPSILON_S >= QUEST_BODY_STOP_DWELL_S) {
      return createQuestFirstPersonBodyTrackerState();
    }
    return {
      clip: state.clip,
      candidateClip: 'IdleAggro',
      candidateSeconds: stopElapsed,
    };
  }

  const desired = pickDesiredWalkClip(state.clip, forwardSpeed, leftSpeed);
  if (desired === state.clip) {
    return {
      clip: state.clip,
      candidateClip: null,
      candidateSeconds: 0,
    };
  }

  // Idle-to-walk transition starts immediately with zero dwell so movement responds crisply.
  if (state.clip === 'IdleAggro') {
    return {
      clip: desired,
      candidateClip: null,
      candidateSeconds: 0,
    };
  }

  const elapsed = (state.candidateClip === desired ? state.candidateSeconds : 0) + dtSeconds;
  if (elapsed + DWELL_EPSILON_S >= QUEST_BODY_CLIP_SWITCH_DWELL_S) {
    return {
      clip: desired,
      candidateClip: null,
      candidateSeconds: 0,
    };
  }

  return {
    clip: state.clip,
    candidateClip: desired,
    candidateSeconds: elapsed,
  };
}
