import { menuFrame, type Calibration, type Vec3 } from './quest-head-rig.ts';
import type { QuestPanelPose } from './quest-menu-compositor.ts';
import type { QuestMenuDrawOp, QuestMenuFonts } from './quest-menu-layout.ts';

export const QUEST_COMBAT_HUD_TEXTURE = { widthPx: 1280, heightPx: 360 } as const;
export const QUEST_COMBAT_HUD_SIZE = { widthM: 1.28, heightM: 0.36 } as const;
export const QUEST_COMBAT_HUD_DISTANCE_M = 2.2;
export const QUEST_COMBAT_HUD_HEIGHT_M = 0.72;

export type QuestCombatHudEventKind =
  | 'hit'
  | 'uppercut-hit'
  | 'cpu-blocked'
  | 'guard-break'
  | 'took-hit'
  | 'blocked-cpu'
  | 'player-guard-break'
  | 'dodged'
  | 'out-of-range'
  | 'uppercut-not-ready'
  | 'drop-guard'
  | 'recovering';

export interface QuestCombatHudEvent {
  id: number;
  kind: QuestCombatHudEventKind;
  label: string;
  tone: 'positive' | 'warning' | 'danger' | 'info';
}

export type QuestEvadeHudStatus =
  'armed' | 'active' | 'cooldown' | 'recenter-to-rearm' | 'oob' | 'unavailable';

export interface QuestCombatHudState {
  stage: string;
  outcome: 'blue' | 'red' | 'draw' | null;
  playerHealth: number;
  playerMaxHealth: number;
  playerMode: string;
  playerGuardStamina: number;
  playerGuardMaxStamina: number;
  playerGuardState: string;
  playerGuardHeld: boolean;
  playerPunchProgress: number;
  playerUppercutReady: boolean;
  playerUppercutWindowRemaining: number;
  opponentHealth: number;
  opponentMaxHealth: number;
  opponentGuardState: string;
  opponentMode: string;
  inPunchRange: boolean;
  inUppercutRange: boolean;
  evadeStatus: QuestEvadeHudStatus;
  evadeKind: 'duck' | 'weave' | null;
  evadeRemaining: number;
  evadeCooldownRemaining: number;
  incomingAttack: { kind: 'punch' | 'uppercut'; hand: 'L' | 'R' } | null;
  event: QuestCombatHudEvent | null;
  redBearingOffsetDeg: number;
}

const COLORS = {
  panelBg: '#d9090d16',
  cardBg: '#e6111827',
  track: '#ff1e293b',
  blueFill: '#ff38bdf8',
  redFill: '#fff97316',
  goldFill: '#fffacc15',
  amberFill: '#fff59e0b',
  greenFill: '#ff22c55e',
  dangerFill: '#ffef4444',
  mutedText: '#cbd5e1',
  paper: '#f8fafc',
  eventPositive: '#e614532d',
  eventWarning: '#e678350f',
  eventDanger: '#e67f1d1d',
  eventInfo: '#e60c4a6e',
  eventNeutral: '#cc0f172a',
  pillBorderBlue: '#ff0284c7',
  pillBorderAmber: '#ffd97706',
  pillBorderRed: '#ffdc2626',
  pillBorderMuted: '#ff334155',
} as const;

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function quantizeStep(deg: number, step = 5) {
  if (!Number.isFinite(deg)) return 0;
  return Math.round(deg / step) * step;
}

/**
 * Computes the frame-local combat HUD position and clamped yaw around menuFrame(cal).
 */
export function questCombatHudLocalPose(redBearingOffsetDeg = 0): {
  position: Vec3;
  rotation: [number, number, number];
  clampedOffset: number;
} {
  const clampedOffset = Math.max(-75, Math.min(75, quantizeStep(redBearingOffsetDeg, 5)));
  const alphaRad = (clampedOffset * Math.PI) / 180;
  const dist = QUEST_COMBAT_HUD_DISTANCE_M;
  const lx = -dist * Math.sin(alphaRad);
  const lz = -dist * Math.cos(alphaRad);
  const ly = QUEST_COMBAT_HUD_HEIGHT_M;
  return {
    position: [lx, ly, lz],
    rotation: [0, clampedOffset, 0],
    clampedOffset,
  };
}

/**
 * Computes the comfort-preserving, opponent-aligned HUD pose in OpenXR space.
 * Moves with opponent bearing quantized in 5-degree steps (never head-locked)
 * so the HUD remains clear above Red without inducing locomotion or yaw lag sickness.
 */
export function questCombatHudPose(
  cal: Calibration,
  redBearingOffsetDeg = 0
): { position: Vec3; yaw: number; pose: QuestPanelPose } {
  const frame = menuFrame(cal);
  const local = questCombatHudLocalPose(redBearingOffsetDeg);
  const [lx, ly, lz] = local.position;

  const frameRad = (frame.rotationY * Math.PI) / 180;
  const cos = Math.cos(frameRad);
  const sin = Math.sin(frameRad);
  const position: Vec3 = [
    frame.position[0] + lx * cos + lz * sin,
    frame.position[1] + ly,
    frame.position[2] - lx * sin + lz * cos,
  ];
  const yaw = frame.rotationY + local.clampedOffset;
  const half = (yaw * Math.PI) / 360;
  const pose: QuestPanelPose = [...position, 0, Math.sin(half), 0, Math.cos(half)];
  return { position, yaw, pose };
}

function guardLabel(hud: QuestCombatHudState) {
  if (hud.playerGuardState === 'holding') return 'GUARD ACTIVE';
  if (hud.playerGuardState === 'raising') return 'RAISING GUARD';
  if (hud.playerGuardState === 'exhausted') return 'DROP HANDS TO RESET';
  if (hud.playerGuardState === 'lowering') return 'DROPPING GUARD';
  return 'GUARD READY';
}

function evadeBanner(hud: QuestCombatHudState): { text: string; bg: string } {
  switch (hud.evadeStatus) {
    case 'active': {
      const kind = hud.evadeKind === 'weave' ? 'WEAVE' : 'DUCK';
      return {
        text: `EVADING (${kind}) ${hud.evadeRemaining.toFixed(1)}s`,
        bg: COLORS.pillBorderBlue,
      };
    }
    case 'cooldown':
      return {
        text: `DODGE COOLDOWN ${hud.evadeCooldownRemaining.toFixed(1)}s`,
        bg: COLORS.pillBorderAmber,
      };
    case 'recenter-to-rearm':
      return {
        text: 'DODGE EXPIRED — STAND & RE-DIP',
        bg: COLORS.pillBorderAmber,
      };
    case 'oob':
      return {
        text: 'STEP BACK TO RING CENTER',
        bg: COLORS.pillBorderRed,
      };
    case 'unavailable':
      return { text: 'DODGE UNAVAILABLE', bg: COLORS.pillBorderMuted };
    case 'armed':
    default:
      return { text: 'DODGE READY (DUCK OR LEAN)', bg: COLORS.pillBorderMuted };
  }
}

function bannerSpec(hud: QuestCombatHudState): { text: string; bg: string } {
  if (hud.stage === 'finished') {
    if (hud.outcome === 'blue') {
      return { text: 'VICTORY! KNOCKOUT WIN — SELECT READY FOR REMATCH', bg: COLORS.eventPositive };
    }
    if (hud.outcome === 'red') {
      return { text: 'DEFEAT — SELECT READY FOR REMATCH', bg: COLORS.eventDanger };
    }
    return { text: 'DRAW — SELECT READY FOR REMATCH', bg: COLORS.eventInfo };
  }
  if (hud.stage === 'presenting') {
    if (hud.opponentHealth <= 0 && hud.playerHealth > 0) {
      return { text: 'KNOCKOUT! FINISHER LANDED!', bg: COLORS.eventPositive };
    }
    if (hud.playerHealth <= 0 && hud.opponentHealth > 0) {
      return { text: 'KNOCKED OUT!', bg: COLORS.eventDanger };
    }
    return { text: 'DOUBLE KNOCKDOWN!', bg: COLORS.eventInfo };
  }
  if (hud.stage === 'intermission') {
    if (hud.outcome === 'blue') {
      return { text: 'ROUND WON! PREPARE FOR NEXT ROUND', bg: COLORS.eventPositive };
    }
    if (hud.outcome === 'red') {
      return { text: 'ROUND LOST — PREPARE FOR NEXT ROUND', bg: COLORS.eventWarning };
    }
    return { text: 'ROUND OVER — PREPARE FOR NEXT ROUND', bg: COLORS.eventInfo };
  }
  if (hud.stage === 'countdown') {
    return {
      text: 'GET READY — RAISE HANDS TO BLOCK WHEN ROUND STARTS',
      bg: COLORS.eventInfo,
    };
  }
  if (hud.stage === 'paused') {
    return { text: 'MATCH PAUSED — SELECT READY TO RESUME', bg: COLORS.eventWarning };
  }
  if (hud.event) {
    const bg =
      hud.event.tone === 'positive'
        ? COLORS.eventPositive
        : hud.event.tone === 'warning'
          ? COLORS.eventWarning
          : hud.event.tone === 'danger'
            ? COLORS.eventDanger
            : COLORS.eventInfo;
    return { text: hud.event.label, bg };
  }
  if (hud.incomingAttack) {
    const atk = hud.incomingAttack.kind === 'uppercut' ? 'UPPERCUT' : 'PUNCH';
    const advice =
      hud.incomingAttack.kind === 'uppercut'
        ? 'RAISE BOTH HANDS TO GUARD OR STEP BACK!'
        : 'RAISE BOTH HANDS TO BLOCK OR DUCK/WEAVE!';
    return {
      text: `INCOMING ${atk} (${hud.incomingAttack.hand}) — ${advice}`,
      bg: COLORS.eventDanger,
    };
  }
  if (hud.playerUppercutReady) {
    return {
      text: `UPPERCUT READY (${hud.playerUppercutWindowRemaining.toFixed(1)}s) — SWING STRAIGHT UP!`,
      bg: COLORS.eventPositive,
    };
  }
  if (!hud.inPunchRange) {
    return {
      text: 'OUT OF RANGE — USE LEFT STICK TO STEP CLOSER',
      bg: COLORS.eventNeutral,
    };
  }
  return {
    text: 'IN RANGE — THROW PUNCHES • RAISE BOTH HANDS TO BLOCK • DUCK/WEAVE',
    bg: COLORS.eventNeutral,
  };
}

/**
 * Builds an OpenXR QuestPanel draw spec for the immersive combat HUD.
 * Stays compact (< 40 ops vs 160 op cap) with high contrast and transparent framing.
 */
export function buildQuestCombatHud(hud: QuestCombatHudState, fonts: QuestMenuFonts = {}) {
  const { widthPx, heightPx } = QUEST_COMBAT_HUD_TEXTURE;
  const bodyFont = fonts.body ?? '';
  const boldFont = fonts.button ?? fonts.body ?? '';

  const ops: QuestMenuDrawOp[] = [];
  const pushRect = (
    x: number,
    y: number,
    width: number,
    height: number,
    color: string,
    radius = 12
  ) => ops.push({ op: 'roundRect', x, y, width, height, radius, color });
  const pushText = (
    text: string,
    x: number,
    y: number,
    size: number,
    color: string,
    opts: { align?: 'left' | 'center'; bold?: boolean; maxWidth?: number; font?: string } = {}
  ) =>
    ops.push({
      op: 'text',
      text,
      x,
      y,
      size,
      color,
      align: opts.align ?? 'left',
      bold: opts.bold ?? false,
      maxWidth: opts.maxWidth ?? widthPx,
      font: opts.font ?? (opts.bold ? boldFont : bodyFont),
    });

  // Outer transparent shell.
  pushRect(0, 0, widthPx, heightPx, COLORS.panelBg, 28);

  // Player (Blue) panel — left.
  pushRect(16, 16, 520, 142, COLORS.cardBg, 18);
  const playerPct = clamp01(hud.playerHealth / Math.max(1, hud.playerMaxHealth));
  const staminaPct = clamp01(hud.playerGuardStamina / Math.max(1, hud.playerGuardMaxStamina));
  pushText('YOU (BLUE)', 34, 26, 26, COLORS.blueFill, { bold: true, maxWidth: 260 });
  pushText(`${Math.ceil(hud.playerHealth)} / ${hud.playerMaxHealth}`, 420, 26, 26, COLORS.paper, {
    align: 'center',
    bold: true,
    maxWidth: 160,
  });
  pushRect(34, 62, 484, 24, COLORS.track, 10);
  if (playerPct > 0) {
    pushRect(
      34,
      62,
      Math.max(16, Math.round(484 * playerPct)),
      24,
      playerPct > 0.25 ? COLORS.blueFill : COLORS.dangerFill,
      10
    );
  }
  pushText(
    `GUARD ${Math.round(staminaPct * 100)}% • ${guardLabel(hud)}`,
    34,
    96,
    20,
    COLORS.mutedText,
    {
      bold: true,
      maxWidth: 484,
    }
  );
  pushRect(34, 126, 484, 18, COLORS.track, 8);
  if (staminaPct > 0) {
    const staminaColor =
      hud.playerGuardState === 'exhausted'
        ? COLORS.dangerFill
        : hud.playerGuardState === 'holding'
          ? COLORS.greenFill
          : COLORS.amberFill;
    pushRect(34, 126, Math.max(12, Math.round(484 * staminaPct)), 18, staminaColor, 8);
  }

  // Center Uppercut & Range card.
  pushRect(550, 16, 180, 142, COLORS.cardBg, 18);
  pushText(
    hud.inPunchRange ? 'IN RANGE' : 'STEP CLOSER',
    640,
    28,
    22,
    hud.inPunchRange ? COLORS.greenFill : COLORS.amberFill,
    { align: 'center', bold: true, maxWidth: 164 }
  );
  pushText(
    hud.playerUppercutReady ? 'UPPERCUT' : 'STREAK',
    640,
    64,
    20,
    hud.playerUppercutReady ? COLORS.goldFill : COLORS.mutedText,
    { align: 'center', bold: true, maxWidth: 164 }
  );
  const pipY = 98;
  for (let i = 0; i < 3; i++) {
    const filled = hud.playerUppercutReady || i < hud.playerPunchProgress;
    pushRect(
      582 + i * 42,
      pipY,
      32,
      18,
      filled ? (hud.playerUppercutReady ? COLORS.goldFill : COLORS.blueFill) : COLORS.track,
      6
    );
  }
  pushText(
    hud.playerUppercutReady ? 'READY!' : `${hud.playerPunchProgress} / 3 HITS`,
    640,
    124,
    22,
    hud.playerUppercutReady ? COLORS.goldFill : COLORS.paper,
    { align: 'center', bold: true, maxWidth: 164 }
  );

  // Opponent (Red Mike) panel — right.
  pushRect(744, 16, 520, 142, COLORS.cardBg, 18);
  const oppPct = clamp01(hud.opponentHealth / Math.max(1, hud.opponentMaxHealth));
  pushText('RED MIKE (CPU)', 762, 26, 26, COLORS.redFill, { bold: true, maxWidth: 300 });
  pushText(
    `${Math.ceil(hud.opponentHealth)} / ${hud.opponentMaxHealth}`,
    1168,
    26,
    26,
    COLORS.paper,
    {
      align: 'center',
      bold: true,
      maxWidth: 160,
    }
  );
  pushRect(762, 62, 484, 24, COLORS.track, 10);
  if (oppPct > 0) {
    pushRect(762, 62, Math.max(16, Math.round(484 * oppPct)), 24, COLORS.redFill, 10);
  }
  const oppStatus = hud.incomingAttack
    ? `SWINGING ${hud.incomingAttack.kind.toUpperCase()} (${hud.incomingAttack.hand})`
    : hud.opponentGuardState === 'holding'
      ? 'CPU GUARDING'
      : hud.opponentGuardState === 'exhausted' || hud.opponentMode === 'guard-break'
        ? 'CPU GUARD BROKEN!'
        : hud.opponentMode === 'hit' ||
            hud.opponentMode === 'launch' ||
            hud.opponentMode === 'settling'
          ? 'STAGGERED!'
          : 'CPU READY';
  pushText(oppStatus, 762, 104, 22, hud.incomingAttack ? COLORS.goldFill : COLORS.mutedText, {
    bold: true,
    maxWidth: 484,
  });

  // Action & Combat Event Banner.
  const banner = bannerSpec(hud);
  pushRect(16, 174, widthPx - 32, 86, banner.bg, 16);
  pushText(banner.text, widthPx / 2, 198, 30, COLORS.paper, {
    align: 'center',
    bold: true,
    maxWidth: widthPx - 72,
  });

  // Bottom Dodge & Controls Defense Strip.
  const evade = evadeBanner(hud);
  pushRect(16, 276, 610, 68, evade.bg, 14);
  pushText(evade.text, 321, 294, 24, COLORS.paper, {
    align: 'center',
    bold: true,
    maxWidth: 580,
  });

  const guardBg =
    hud.playerGuardState === 'holding' || hud.playerGuardState === 'raising'
      ? COLORS.greenFill
      : hud.playerGuardState === 'exhausted' || hud.playerMode === 'guard-break'
        ? COLORS.pillBorderRed
        : COLORS.pillBorderMuted;
  pushRect(642, 276, 622, 68, guardBg, 14);
  const blockText =
    hud.playerGuardState === 'holding'
      ? 'BLOCK ACTIVE (BOTH HANDS AT CHIN/CHEST)'
      : hud.playerGuardState === 'exhausted'
        ? 'GUARD BROKEN — LOWER HANDS TO RECOVER'
        : 'RAISE BOTH HANDS TO BLOCK • L-STICK MOVE • A DASH';
  pushText(blockText, 953, 294, 22, COLORS.paper, {
    align: 'center',
    bold: true,
    maxWidth: 590,
  });

  return {
    widthPx,
    heightPx,
    widthM: QUEST_COMBAT_HUD_SIZE.widthM,
    heightM: QUEST_COMBAT_HUD_SIZE.heightM,
    ops,
  };
}
