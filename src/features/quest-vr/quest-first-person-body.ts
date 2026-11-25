/** Pure Quest first-person body clip mapping and transition stability. */

export const QUEST_FIRST_PERSON_BODY_CLIPS = [
  'IdleAggro',
  'WalkForward',
  'WalkBackward',
  'StrafeLeft',
  'StrafeRight',
] as const;

export type QuestFirstPersonBodyClip = (typeof QUEST_FIRST_PERSON_BODY_CLIPS)[number];

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
/** Axis-ratio hysteresis so 45-degree diagonals or small yaw changes do not chatter. */
export const QUEST_BODY_AXIS_SWITCH_RATIO = 1.2;
/** Brief dwell before swapping between active walk/strafe clips; start/focus-loss are immediate. */
export const QUEST_BODY_CLIP_SWITCH_DWELL_S = 0.06;
/** Brief dwell before dropping walk->idle on zero-crossing stick reversals; release settles in 45ms. */
export const QUEST_BODY_STOP_DWELL_S = 0.045;

const DWELL_EPSILON_S = 1e-6;

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
): QuestFirstPersonBodyClip {
  const absForward = Math.abs(forwardSpeed);
  const absLeft = Math.abs(leftSpeed);

  if (current === 'WalkForward' || current === 'WalkBackward') {
    if (absLeft > absForward * QUEST_BODY_AXIS_SWITCH_RATIO) {
      return leftSpeed >= 0 ? 'StrafeLeft' : 'StrafeRight';
    }
    return forwardSpeed >= 0 ? 'WalkForward' : 'WalkBackward';
  }

  if (current === 'StrafeLeft' || current === 'StrafeRight') {
    if (absForward > absLeft * QUEST_BODY_AXIS_SWITCH_RATIO) {
      return forwardSpeed >= 0 ? 'WalkForward' : 'WalkBackward';
    }
    return leftSpeed >= 0 ? 'StrafeLeft' : 'StrafeRight';
  }

  if (absLeft > absForward) {
    return leftSpeed >= 0 ? 'StrafeLeft' : 'StrafeRight';
  }
  return forwardSpeed >= 0 ? 'WalkForward' : 'WalkBackward';
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
