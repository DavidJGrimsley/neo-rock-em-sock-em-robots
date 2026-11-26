// Centralized tuning and runtime settings for Quest VR motion combat.
//
// Design tradeoffs vs default Phone AR (`ARENA_RULES` in arena-controller.ts):
// - Phone AR defaults remain untouched (`ARENA_RULES`) for 2D/AR & multiplayer parity.
// - Quest VR overrides hit reaction durations, poise/anti-stunlock, readable CPU
//   telegraph/recovery state machine, slower CPU pursuit speed, spatial dodge
//   counterplay windows, head-locked top-of-view HUD comfort geometry, turning,
//   audio gain staging, OpenXR haptics, and peripheral damage tint.

import type { QuestCombatFeedbackEventKind } from './quest-combat-feedback.ts';

export type QuestTurnMode = 'snap' | 'smooth';

export interface QuestUserSettings {
  turnMode: QuestTurnMode;
  snapTurnAngleDeg: number;
  smoothTurnDegPerSec: number;
  damageTintEnabled: boolean;
  audioEnabled: boolean;
  musicVolume: number;
  sfxVolume: number;
}

export const DEFAULT_QUEST_SETTINGS: QuestUserSettings = {
  turnMode: 'snap',
  snapTurnAngleDeg: 30,
  smoothTurnDegPerSec: 120,
  damageTintEnabled: true,
  audioEnabled: true,
  musicVolume: 0.32,
  sfxVolume: 0.95,
};

export const QUEST_TUNING = {
  // Pause & left controller Menu button edge debouncing.
  pause: {
    debounceMs: 120,
  },

  // Right thumbstick turning: pivots calibration around live head XZ without
  // mutating physical head tracking or introducing forced camera motion.
  turn: {
    deadzone: 0.25,
    snapEngageThreshold: 0.72,
    snapReleaseThreshold: 0.35,
    minSnapDeg: 15,
    maxSnapDeg: 45,
  },

  // Top-of-view HUD in XR_REFERENCE_SPACE_TYPE_VIEW (~11 deg above horizon at 1.75 m).
  hud: {
    position: [0, 0.35, -1.75] as const,
    pitchDeg: 10,
    widthM: 0.96,
    heightM: 0.27,
  },

  // Phase 1: Distinguishable hit reactions, poise bar, and anti-stunlock protection.
  hitReactions: {
    lightDuration: 0.34, // 0.25-0.40s readable light recoil
    mediumDuration: 0.56, // 0.45-0.70s medium hit / combo recoil
    heavyStaggerDuration: 0.92, // 0.80-1.20s heavy stagger on poise break / uppercut
    guardBreakStaggerDuration: 0.85, // 0.75-1.10s exposed stagger after guard break
    counterpunchRecovery: 0.42,
    poiseMax: 100,
    poisePunchDamage: 34,
    poiseUppercutDamage: 70,
    poiseRecoveryPerSec: 28,
    poiseRecoveryDelay: 0.85,
    antiStunlockWindow: 1.8,
    antiStunlockMaxChain: 4,
    antiStunlockHyperArmor: 1.1,
    recoilTravel: 0.018,
  },

  // Phase 2 & 3: CPU rhythm state machine, readable telegraphs, spacing & dodge rewards.
  cpu: {
    firstDelay: 0.85,
    maxSpeedRatio: 0.78, // slower than player + dash so wearer can disengage/reposition
    preferredRange: 0.075,
    minimumRange: 0.068,
    holdRangeTolerance: 0.012,
    holdWindowMin: 0.22,
    holdWindowMax: 0.42,
    telegraphPunchWindow: 0.42, // readable 0.42s punch windup before swing commits
    telegraphUppercutWindow: 0.62, // readable 0.62s uppercut windup
    recoveryWindow: 0.55, // post-swing opening window
    resetWindow: 0.35, // post-exchange reset before re-engaging
    retreatChance: 0.25,
    guardChance: 0.28,
    pauseChance: 0.2,
    feintChance: 0.12,
    requireFov: true,
    fovHalfDeg: 68,
    turnDegPerSec: 180,
    uppercutWindow: 1.4,
    reaction: 0.32,
    guardReaction: 0.18,
    rewardReaction: 0.28,
  },

  // Phase 3: Spatial evasion counterattack window.
  dodge: {
    counterWindow: 0.85,
    counterDamageMultiplier: 1.35,
  },

  // Phase 4: Quest audio SFX differentiation using bundled audio clips.
  audio: {
    minEventCooldownMs: 45,
    volumeLevels: [0, 0.25, 0.5, 0.75, 1],
  },

  // Phase 5: Differentiated OpenXR haptics (clamped by native bridge 10..500ms, 0.05..1.0).
  haptics: {
    PLAYER_LANDED_HIT: { hand: 'attacker' as const, intensity: 0.72, durationMs: 65 },
    PLAYER_UPPERCUT_HIT: { hand: 'attacker' as const, intensity: 1.0, durationMs: 120 },
    PLAYER_HIT_BLOCKED: { hand: 'attacker' as const, intensity: 0.36, durationMs: 38 },
    PLAYER_RECEIVED_HIT: { hand: 'both' as const, intensity: 0.62, durationMs: 75 },
    PLAYER_RECEIVED_HEAVY: { hand: 'both' as const, intensity: 0.96, durationMs: 145 },
    PLAYER_SUCCESSFUL_BLOCK: { hand: 'both' as const, intensity: 0.55, durationMs: 55 },
    SUCCESSFUL_DODGE: { hand: 'both' as const, intensity: 0.28, durationMs: 32 },
    GUARD_BREAK: { hand: 'contextual' as const, intensity: 0.95, durationMs: 135 },
    HEAVY_STAGGER: { hand: 'contextual' as const, intensity: 0.92, durationMs: 125 },
  },

  // Phase 6: VR-safe peripheral edge vignette (never obstructs center FOV or moves camera).
  damageVignette: {
    ordinaryOpacity: 0.38,
    heavyOpacity: 0.62,
    guardBreakOpacity: 0.54,
    fadeDurationMs: 210,
  },
} as const;

export function questHapticPatternForFeedback(
  kind: QuestCombatFeedbackEventKind,
  attackerHand: 'L' | 'R' | null | undefined,
  defender: 'blue' | 'red' = 'red',
  heavy = false
): { hand: 'left' | 'right' | 'both'; intensity: number; durationMs: number } | null {
  const contextualHand =
    defender === 'blue'
      ? 'both'
      : attackerHand === 'L'
        ? 'left'
        : attackerHand === 'R'
          ? 'right'
          : 'both';
  switch (kind) {
    case 'PLAYER_LANDED_HIT': {
      const cfg = heavy
        ? QUEST_TUNING.haptics.PLAYER_UPPERCUT_HIT
        : QUEST_TUNING.haptics.PLAYER_LANDED_HIT;
      return {
        hand: attackerHand === 'L' ? 'left' : attackerHand === 'R' ? 'right' : 'both',
        intensity: cfg.intensity,
        durationMs: cfg.durationMs,
      };
    }
    case 'PLAYER_HIT_BLOCKED': {
      const cfg = QUEST_TUNING.haptics.PLAYER_HIT_BLOCKED;
      return {
        hand: attackerHand === 'L' ? 'left' : attackerHand === 'R' ? 'right' : 'both',
        intensity: cfg.intensity,
        durationMs: cfg.durationMs,
      };
    }
    case 'PLAYER_RECEIVED_HIT': {
      const cfg = heavy
        ? QUEST_TUNING.haptics.PLAYER_RECEIVED_HEAVY
        : QUEST_TUNING.haptics.PLAYER_RECEIVED_HIT;
      return { hand: 'both', intensity: cfg.intensity, durationMs: cfg.durationMs };
    }
    case 'PLAYER_SUCCESSFUL_BLOCK': {
      const cfg = QUEST_TUNING.haptics.PLAYER_SUCCESSFUL_BLOCK;
      return { hand: 'both', intensity: cfg.intensity, durationMs: cfg.durationMs };
    }
    case 'SUCCESSFUL_DODGE': {
      const cfg = QUEST_TUNING.haptics.SUCCESSFUL_DODGE;
      return { hand: 'both', intensity: cfg.intensity, durationMs: cfg.durationMs };
    }
    case 'GUARD_BREAK': {
      const cfg = QUEST_TUNING.haptics.GUARD_BREAK;
      return {
        hand: contextualHand,
        intensity: cfg.intensity,
        durationMs: cfg.durationMs,
      };
    }
    case 'HEAVY_STAGGER': {
      const cfg = QUEST_TUNING.haptics.HEAVY_STAGGER;
      return {
        hand: contextualHand,
        intensity: cfg.intensity,
        durationMs: cfg.durationMs,
      };
    }
  }
}
