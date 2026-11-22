// Sky diagnostics panel layout, pose math, compositor mask, Canvas draw ops, and
// partial dirty-region patches for responsive stick/trigger/grip/button updates.
// Placed above the wearer at 45 deg elevation and tilted 45 deg downward toward
// the viewer so it is comfortable to look up at in both menu and ring views
// without obstructing the menus, the opponent robot, or pointer rays.

import { menuFrame, type Calibration, type Vec3 } from './quest-head-rig.ts';
import type { QuestHeadTrackerSnapshot } from './quest-head-tracker.ts';
import type { QuestHand, QuestHandSample, QuestInputSample } from './quest-input.ts';
import type { QuestHandStats, QuestInputSnapshot } from './quest-input-source.ts';
import {
  questMenuLayerNotice,
  type QuestMenuLayerMode,
  type QuestMenuLayerSnapshot,
  type QuestPanelPose,
} from './quest-menu-compositor.ts';
import type { QuestMenuDrawOp, QuestMenuFonts } from './quest-menu-layout.ts';

export const QUEST_DIAG_TEXTURE = { widthPx: 2048, heightPx: 1152 } as const;
export const QUEST_DIAG_SIZE = { widthM: 1.8, heightM: 1.0125 } as const;
export const QUEST_DIAG_CARD_RADIUS_PX = 56;

// In menuFrame(cal): 1.27 m up, 1.27 m forward (~1.80 m distance, 45 deg elevation),
// pitched +45 deg around local +X so the quad normal [0, -0.7071, +0.7071] aims directly
// at the calibrated eye origin [0, 0, 0]. Bottom edge sits near +29.3 deg elevation, well
// above menu (+22.4 deg), floating title (+22.8 deg), ring (-30 deg), and opponent robot (+11.4 deg).
export const QUEST_DIAG_POSE = {
  position: [0, 1.27, -1.27] as [number, number, number],
  rotation: [45, 0, 0] as [number, number, number],
} as const;

const ROUND_MASK_RADIUS_M =
  Math.round(
    (QUEST_DIAG_CARD_RADIUS_PX / QUEST_DIAG_TEXTURE.widthPx) * QUEST_DIAG_SIZE.widthM * 1e5
  ) / 1e5;
const ROUND_MASK_HALF_W = QUEST_DIAG_SIZE.widthM / 2;
const ROUND_MASK_HALF_H = QUEST_DIAG_SIZE.heightM / 2;

export const QUEST_DIAG_LAYER_MASK_FRAGMENT = [
  `vec2 p = abs(v_texcoord - 0.5) * vec2(${QUEST_DIAG_SIZE.widthM}, ${QUEST_DIAG_SIZE.heightM});`,
  `vec2 q = p - (vec2(${ROUND_MASK_HALF_W}, ${ROUND_MASK_HALF_H}) - vec2(${ROUND_MASK_RADIUS_M}));`,
  `float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - ${ROUND_MASK_RADIUS_M};`,
  'if (dist > -0.0015) discard;',
  '_output_color = vec4(0.0);',
].join(' ');

export function questDiagLayerMaterials() {
  return {
    questDiagLayerMask: {
      lightingModel: 'Constant' as const,
      blendMode: 'None' as const,
      diffuseColor: '#00000000',
      writesToDepthBuffer: true,
      readsFromDepthBuffer: true,
      cullMode: 'None' as const,
      shaderModifiers: { fragment: QUEST_DIAG_LAYER_MASK_FRAGMENT },
    },
    questDiagBacking: {
      lightingModel: 'Constant' as const,
      diffuseColor: '#0f172a',
    },
  };
}

/**
 * World-space centre and orientation [x, y, z, qx, qy, qz, qw] of the sky diagnostics
 * panel under menuFrame(cal), combining frame yaw (+Y) with panel pitch (+X).
 */
export function questDiagPanelPose(cal: Calibration): {
  position: Vec3;
  pose: QuestPanelPose;
} {
  const frame = menuFrame(cal);
  const ry = (frame.rotationY * Math.PI) / 180;
  const cosY = Math.cos(ry);
  const sinY = Math.sin(ry);
  const [lx, ly, lz] = QUEST_DIAG_POSE.position;
  const position: Vec3 = [
    frame.position[0] + lx * cosY + lz * sinY,
    frame.position[1] + ly,
    frame.position[2] - lx * sinY + lz * cosY,
  ];
  const halfY = (frame.rotationY * Math.PI) / 360;
  const halfX = (QUEST_DIAG_POSE.rotation[0] * Math.PI) / 360;
  const sy = Math.sin(halfY);
  const cy = Math.cos(halfY);
  const sx = Math.sin(halfX);
  const cx = Math.cos(halfX);
  // q_yaw(Y) * q_pitch(X)
  const pose: QuestPanelPose = [
    position[0],
    position[1],
    position[2],
    cy * sx,
    sy * cx,
    -sy * sx,
    cy * cx,
  ];
  return { position, pose };
}

const CARD = '#0f172a';
const SUBCARD = '#131f38';
const HEADER_BG = '#1e293b';
const TRACK_BG = '#1e293b';
const PAD_BG = '#090f1d';
const PAPER = '#f8fafc';
const MUTED = '#cbd5e1';
const DIM = '#94a3b8';
const LEFT_ACCENT = '#38bdf8';
const RIGHT_ACCENT = '#f97316';
const OK_COLOR = '#4ade80';
const WARN_COLOR = '#facc15';
const ERR_COLOR = '#f87171';
const PILL_OFF_BG = '#1e293b';

const COL_TOP_Y = 148;
const COL_W = 952;
const COL_H = 626;
const LEFT_COL_X = 48;
const RIGHT_COL_X = 1048;

export const QUEST_DIAG_LIVE_RECTS: Record<
  QuestHand,
  {
    controls: { x: number; y: number; width: number; height: number };
    badge: { x: number; y: number; width: number; height: number };
  }
> = {
  left: {
    controls: { x: LEFT_COL_X + 20, y: 280, width: COL_W - 40, height: 404 },
    badge: { x: LEFT_COL_X + COL_W - 234, y: COL_TOP_Y + 20, width: 210, height: 58 },
  },
  right: {
    controls: { x: RIGHT_COL_X + 20, y: 280, width: COL_W - 40, height: 404 },
    badge: { x: RIGHT_COL_X + COL_W - 234, y: COL_TOP_Y + 20, width: 210, height: 58 },
  },
};

const fmt = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? '--' : n.toFixed(digits);
const fmtSigned = (n: number | null | undefined, digits = 2) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '--';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;
};
const fmtVec = (v: readonly number[] | null | undefined) =>
  v ? `[${v.map((n) => `${n >= 0 ? '+' : ''}${n.toFixed(3)}`).join(', ')}]` : '--';

function trackingBadgeColor(tracking: QuestHandSample['tracking'] | null | undefined) {
  if (tracking === 'tracked') return { bg: '#14532d', fg: OK_COLOR, label: 'TRACKED' };
  if (tracking === 'inferred') return { bg: '#713f12', fg: WARN_COLOR, label: 'INFERRED' };
  if (tracking === 'lost') return { bg: '#7f1d1d', fg: ERR_COLOR, label: 'LOST' };
  return { bg: PILL_OFF_BG, fg: DIM, label: 'NO DATA' };
}

function statusColor(status: QuestInputSnapshot['status']) {
  if (status === 'live') return OK_COLOR;
  if (status === 'waiting' || status === 'unfocused') return WARN_COLOR;
  return ERR_COLOR;
}

function pushBar(
  ops: QuestMenuDrawOp[],
  x: number,
  y: number,
  width: number,
  height: number,
  value: number,
  fillColor: string
) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  ops.push({ op: 'roundRect', x, y, width, height, radius: height / 2, color: TRACK_BG });
  const fillW = Math.round(width * clamped);
  if (fillW >= 8) {
    ops.push({
      op: 'roundRect',
      x,
      y,
      width: fillW,
      height,
      radius: height / 2,
      color: fillColor,
    });
  }
}

function pushButtonPill(
  ops: QuestMenuDrawOp[],
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  state: boolean | null | undefined,
  accent: string,
  font?: string
) {
  const pressed = state === true;
  const inactive = state === null || state === undefined;
  ops.push({
    op: 'roundRect',
    x,
    y,
    width,
    height,
    radius: 18,
    color: pressed ? accent : PILL_OFF_BG,
  });
  ops.push({
    op: 'text',
    text: inactive ? `${label}:?` : `${label}:${pressed ? 'ON' : 'off'}`,
    x: x + width / 2,
    y: y + 12,
    size: 30,
    color: pressed ? '#09090b' : inactive ? DIM : PAPER,
    align: 'center',
    bold: true,
    ...(font ? { font } : {}),
    maxWidth: width - 16,
  });
}

function pushHandTrackingBadge(
  ops: QuestMenuDrawOp[],
  colX: number,
  colW: number,
  sample: QuestHandSample | null,
  stats: QuestHandStats,
  boldFont?: string
) {
  const badge = trackingBadgeColor(sample?.tracking ?? stats.tracking);
  ops.push({
    op: 'roundRect',
    x: colX + colW - 230,
    y: COL_TOP_Y + 24,
    width: 202,
    height: 50,
    radius: 25,
    color: badge.bg,
  });
  ops.push({
    op: 'text',
    text: badge.label,
    x: colX + colW - 129,
    y: COL_TOP_Y + 32,
    size: 30,
    color: badge.fg,
    align: 'center',
    bold: true,
    ...(boldFont ? { font: boldFont } : {}),
    maxWidth: 186,
  });
}

function pushHandLiveControls(
  ops: QuestMenuDrawOp[],
  hand: QuestHand,
  colX: number,
  colW: number,
  accent: string,
  sample: QuestHandSample | null,
  stats: QuestHandStats,
  bodyFont?: string,
  boldFont?: string
) {
  // Analog thumbstick pad + large X/Y readout
  const padX = colX + 28;
  const padY = COL_TOP_Y + 136;
  const padSize = 148;
  ops.push({
    op: 'roundRect',
    x: padX,
    y: padY,
    width: padSize,
    height: padSize,
    radius: 24,
    color: PAD_BG,
  });
  // Crosshairs
  ops.push({
    op: 'roundRect',
    x: padX + padSize / 2 - 1,
    y: padY + 10,
    width: 2,
    height: padSize - 20,
    radius: 1,
    color: '#334155',
  });
  ops.push({
    op: 'roundRect',
    x: padX + 10,
    y: padY + padSize / 2 - 1,
    width: padSize - 20,
    height: 2,
    radius: 1,
    color: '#334155',
  });
  const sx = sample?.thumbstick.x ?? 0;
  const sy = sample?.thumbstick.y ?? 0;
  const dotR = 12;
  const travel = padSize / 2 - 18;
  const dotCx = padX + padSize / 2 + Math.max(-1, Math.min(1, sx)) * travel;
  const dotCy = padY + padSize / 2 - Math.max(-1, Math.min(1, sy)) * travel;
  ops.push({
    op: 'roundRect',
    x: Math.round(dotCx - dotR),
    y: Math.round(dotCy - dotR),
    width: dotR * 2,
    height: dotR * 2,
    radius: dotR,
    color: sample?.thumbstick.active ? accent : DIM,
  });

  const stickTextX = padX + padSize + 26;
  const stickTextW = colX + colW - 28 - stickTextX;
  ops.push({
    op: 'text',
    text: `Stick  X ${fmtSigned(sample ? sx : null)}   Y ${fmtSigned(sample ? sy : null)}`,
    x: stickTextX,
    y: padY + 14,
    size: 40,
    color: PAPER,
    align: 'left',
    bold: true,
    ...(boldFont ? { font: boldFont } : {}),
    maxWidth: stickTextW,
  });
  ops.push({
    op: 'text',
    text: `${sample?.thumbstick.active ? 'active' : 'inactive'}   pts ${stats.stickDistinct}   diag pk ${fmt(stats.stickDiagonalPeak)}`,
    x: stickTextX,
    y: padY + 74,
    size: 28,
    color: MUTED,
    align: 'left',
    ...(bodyFont ? { font: bodyFont } : {}),
    maxWidth: stickTextW,
  });

  // Trigger & Grip bars
  const trigY = padY + padSize + 24;
  const trigVal = sample?.trigger.value ?? 0;
  ops.push({
    op: 'text',
    text: `Trigger  ${sample ? fmt(trigVal) : '--'}   (pk ${fmt(stats.triggerPeak)}${sample && !sample.trigger.active ? ', off' : ''})`,
    x: colX + 28,
    y: trigY,
    size: 32,
    color: PAPER,
    align: 'left',
    bold: true,
    ...(boldFont ? { font: boldFont } : {}),
    maxWidth: colW - 56,
  });
  pushBar(ops, colX + 28, trigY + 44, colW - 56, 20, sample ? trigVal : 0, accent);

  const gripY = trigY + 80;
  const gripVal = sample?.squeeze.value ?? 0;
  ops.push({
    op: 'text',
    text: `Grip     ${sample ? fmt(gripVal) : '--'}   (pk ${fmt(stats.squeezePeak)}${sample && !sample.squeeze.active ? ', off' : ''})`,
    x: colX + 28,
    y: gripY,
    size: 32,
    color: PAPER,
    align: 'left',
    bold: true,
    ...(boldFont ? { font: boldFont } : {}),
    maxWidth: colW - 56,
  });
  pushBar(ops, colX + 28, gripY + 44, colW - 56, 20, sample ? gripVal : 0, accent);

  // Explicit buttons row
  const btnY = gripY + 82;
  const btnW = hand === 'left' ? 270 : 415;
  const gap = 22;
  if (hand === 'left') {
    pushButtonPill(ops, colX + 28, btnY, btnW, 60, 'X', sample?.buttons.primary, accent, boldFont);
    pushButtonPill(
      ops,
      colX + 28 + btnW + gap,
      btnY,
      btnW,
      60,
      'Y',
      sample?.buttons.secondary,
      accent,
      boldFont
    );
    pushButtonPill(
      ops,
      colX + 28 + (btnW + gap) * 2,
      btnY,
      btnW,
      60,
      'MENU',
      sample?.buttons.menu,
      accent,
      boldFont
    );
  } else {
    pushButtonPill(ops, colX + 28, btnY, btnW, 60, 'A', sample?.buttons.primary, accent, boldFont);
    pushButtonPill(
      ops,
      colX + 28 + btnW + gap,
      btnY,
      btnW,
      60,
      'B',
      sample?.buttons.secondary,
      accent,
      boldFont
    );
  }
}

function pushHandColumn(
  ops: QuestMenuDrawOp[],
  hand: QuestHand,
  colX: number,
  colW: number,
  title: string,
  accent: string,
  sample: QuestHandSample | null,
  stats: QuestHandStats,
  bodyFont?: string,
  boldFont?: string
) {
  ops.push({
    op: 'roundRect',
    x: colX,
    y: COL_TOP_Y,
    width: colW,
    height: COL_H,
    radius: 28,
    color: SUBCARD,
  });
  ops.push({
    op: 'roundRect',
    x: colX,
    y: COL_TOP_Y,
    width: colW,
    height: 10,
    radius: 5,
    color: accent,
  });

  ops.push({
    op: 'text',
    text: title,
    x: colX + 28,
    y: COL_TOP_Y + 26,
    size: 38,
    color: accent,
    align: 'left',
    bold: true,
    ...(boldFont ? { font: boldFont } : {}),
    maxWidth: 480,
  });
  pushHandTrackingBadge(ops, colX, colW, sample, stats, boldFont);

  const flags = sample
    ? `pos ${sample.positionValid ? 'V' : '-'}${sample.positionTracked ? 'T' : '-'}  ori ${sample.orientationValid ? 'V' : '-'}${sample.orientationTracked ? 'T' : '-'}  pose ${sample.poseActive ? 'ON' : 'off'}  loss ${stats.losses}/${stats.recoveries}${stats.lastLossMs !== null ? ` (${stats.lastLossMs.toFixed(0)}ms)` : ''}`
    : `awaiting samples  loss ${stats.losses}/${stats.recoveries}`;
  ops.push({
    op: 'text',
    text: flags,
    x: colX + 28,
    y: COL_TOP_Y + 86,
    size: 27,
    color: MUTED,
    align: 'left',
    ...(bodyFont ? { font: bodyFont } : {}),
    maxWidth: colW - 56,
  });

  pushHandLiveControls(ops, hand, colX, colW, accent, sample, stats, bodyFont, boldFont);

  // Aim pose and velocity
  const speed = sample?.linearVelocity ? Math.hypot(...sample.linearVelocity) : null;
  ops.push({
    op: 'text',
    text: `Aim ${fmtVec(sample?.position)} m   v ${fmt(speed)} m/s`,
    x: colX + 28,
    y: 694,
    size: 27,
    color: DIM,
    align: 'left',
    ...(bodyFont ? { font: bodyFont } : {}),
    maxWidth: colW - 56,
  });
}

export interface QuestDiagnosticsLiveRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  clearColor: string;
  ops: QuestMenuDrawOp[];
}

export interface QuestDiagnosticsLiveKey {
  tracking: QuestHandSample['tracking'] | null;
  stickActive: boolean;
  stickX: string;
  stickY: string;
  stickDistinct: number;
  stickDiagPk: string;
  trigActive: boolean;
  trigVal: string;
  trigPk: string;
  gripActive: boolean;
  gripVal: string;
  gripPk: string;
  primary: boolean | null;
  secondary: boolean | null;
  menu: boolean | null;
}

export function handLiveSignature(
  sample: QuestHandSample | null,
  stats: QuestHandStats
): { key: string; trackingKey: string; controlsKey: string } {
  const tracking = sample?.tracking ?? stats.tracking ?? null;
  const trackingKey = String(tracking);
  const controlsKey = [
    sample ? 1 : 0,
    sample?.thumbstick.active ? 1 : 0,
    fmtSigned(sample ? sample.thumbstick.x : null),
    fmtSigned(sample ? sample.thumbstick.y : null),
    stats.stickDistinct,
    fmt(stats.stickDiagonalPeak),
    sample?.trigger.active ? 1 : 0,
    sample ? fmt(sample.trigger.value) : '--',
    fmt(stats.triggerPeak),
    sample?.squeeze.active ? 1 : 0,
    sample ? fmt(sample.squeeze.value) : '--',
    fmt(stats.squeezePeak),
    sample?.buttons.primary,
    sample?.buttons.secondary,
    sample?.buttons.menu,
  ].join('|');
  return { key: `${trackingKey}|${controlsKey}`, trackingKey, controlsKey };
}

/**
 * Builds partial Canvas dirty-region patches for the live stick, trigger, grip,
 * buttons, and tracking badge so high-frequency controller updates never redraw
 * or re-upload the full 2048x1152 diagnostics bitmap.
 */
export function buildQuestDiagnosticsLivePatch(params: {
  sample: QuestInputSample | null;
  hands: { left: QuestHandStats; right: QuestHandStats };
  fonts?: QuestMenuFonts;
  includeHands?: {
    leftControls?: boolean;
    leftBadge?: boolean;
    rightControls?: boolean;
    rightBadge?: boolean;
  };
}): { regions: QuestDiagnosticsLiveRegion[] } {
  const bodyFont = params.fonts?.body ?? undefined;
  const boldFont = params.fonts?.button ?? bodyFont;
  const include = params.includeHands ?? {
    leftControls: true,
    leftBadge: true,
    rightControls: true,
    rightBadge: true,
  };
  const regions: QuestDiagnosticsLiveRegion[] = [];

  const specs: {
    hand: QuestHand;
    colX: number;
    accent: string;
    sample: QuestHandSample | null;
    stats: QuestHandStats;
    controls?: boolean;
    badge?: boolean;
  }[] = [
    {
      hand: 'left',
      colX: LEFT_COL_X,
      accent: LEFT_ACCENT,
      sample: params.sample?.left ?? null,
      stats: params.hands.left,
      controls: include.leftControls,
      badge: include.leftBadge,
    },
    {
      hand: 'right',
      colX: RIGHT_COL_X,
      accent: RIGHT_ACCENT,
      sample: params.sample?.right ?? null,
      stats: params.hands.right,
      controls: include.rightControls,
      badge: include.rightBadge,
    },
  ];

  for (const s of specs) {
    if (s.badge) {
      const ops: QuestMenuDrawOp[] = [];
      pushHandTrackingBadge(ops, s.colX, COL_W, s.sample, s.stats, boldFont);
      regions.push({
        ...QUEST_DIAG_LIVE_RECTS[s.hand].badge,
        clearColor: SUBCARD,
        ops,
      });
    }
    if (s.controls) {
      const ops: QuestMenuDrawOp[] = [];
      pushHandLiveControls(
        ops,
        s.hand,
        s.colX,
        COL_W,
        s.accent,
        s.sample,
        s.stats,
        bodyFont,
        boldFont
      );
      regions.push({
        ...QUEST_DIAG_LIVE_RECTS[s.hand].controls,
        clearColor: SUBCARD,
        ops,
      });
    }
  }

  return { regions };
}

export interface QuestDiagnosticsPanelParams {
  input: QuestInputSnapshot;
  tracker: QuestHeadTrackerSnapshot;
  developerLines: readonly string[];
  fonts?: QuestMenuFonts;
  menuLayer?: QuestMenuLayerSnapshot;
  diagLayerMode?: QuestMenuLayerMode;
  markerPipeline?: 'render-thread' | 'js-fallback';
  /** Optional newest live sample/stats so 5 Hz full redraws never overwrite fresher live values. */
  liveSample?: QuestInputSample | null;
  liveHands?: { left: QuestHandStats; right: QuestHandStats };
}

export function formatRigDeveloperSummary(tracker: QuestHeadTrackerSnapshot): string {
  const { calibration, sampleHz, pose, status } = tracker;
  const hz = sampleHz === null ? '--' : sampleHz.toFixed(0);
  const resets = tracker.referenceResets ? `, reset x${tracker.referenceResets}` : '';
  const head = `Rig ${status} (${calibration.source}, ${calibration.posture}, e${calibration.entry}, ${hz}Hz${resets})`;
  if (!pose) return `${head} | Pose: awaiting head samples`;
  const flags = `${pose.clamped ? ' CLAMP' : ''}${pose.outOfBounds ? ' OOB' : ''}`;
  return `${head} | L ${fmtSigned(pose.lateral)}m V ${fmtSigned(pose.vertical)}m F ${fmtSigned(pose.forward)}m yaw ${pose.yawRelative.toFixed(0)}deg${flags}`;
}

export function buildQuestDiagnosticsPanel(params: QuestDiagnosticsPanelParams): {
  ops: QuestMenuDrawOp[];
  specKey: string;
} {
  const { input, tracker, developerLines, fonts, menuLayer, diagLayerMode, markerPipeline } =
    params;
  const bodyFont = fonts?.body ?? undefined;
  const boldFont = fonts?.button ?? bodyFont;
  const latest: QuestInputSample | null =
    params.liveSample !== undefined ? params.liveSample : input.latest;
  const hands = params.liveHands ?? input.hands;
  const ops: QuestMenuDrawOp[] = [
    {
      op: 'roundRect',
      x: 0,
      y: 0,
      width: QUEST_DIAG_TEXTURE.widthPx,
      height: QUEST_DIAG_TEXTURE.heightPx,
      radius: QUEST_DIAG_CARD_RADIUS_PX,
      color: CARD,
    },
    {
      op: 'roundRect',
      x: 48,
      y: 36,
      width: QUEST_DIAG_TEXTURE.widthPx - 96,
      height: 88,
      radius: 24,
      color: HEADER_BG,
    },
    {
      op: 'text',
      text: 'QUEST DEVELOPER DIAGNOSTICS',
      x: 78,
      y: 56,
      size: 42,
      color: PAPER,
      align: 'left',
      bold: true,
      ...(boldFont ? { font: boldFont } : {}),
      maxWidth: 760,
    },
    {
      op: 'text',
      text: `CTRL: ${input.status.toUpperCase()} ${fmt(input.sampleHz, 0)} Hz${input.message ? ` (${input.message})` : ''}`,
      x: 860,
      y: 60,
      size: 34,
      color: statusColor(input.status),
      align: 'left',
      bold: true,
      ...(boldFont ? { font: boldFont } : {}),
      maxWidth: 1110,
    },
  ];

  pushHandColumn(
    ops,
    'left',
    LEFT_COL_X,
    COL_W,
    'LEFT CONTROLLER',
    LEFT_ACCENT,
    latest?.left ?? null,
    hands.left,
    bodyFont,
    boldFont
  );
  pushHandColumn(
    ops,
    'right',
    RIGHT_COL_X,
    COL_W,
    'RIGHT CONTROLLER',
    RIGHT_ACCENT,
    latest?.right ?? null,
    hands.right,
    bodyFont,
    boldFont
  );

  // Bottom Developer Status card (all developer prose moved out of the normal menu)
  const devY = 794;
  ops.push({
    op: 'roundRect',
    x: 48,
    y: devY,
    width: QUEST_DIAG_TEXTURE.widthPx - 96,
    height: 318,
    radius: 28,
    color: SUBCARD,
  });

  const rigSummary = formatRigDeveloperSummary(tracker);
  const layerNotice = menuLayer ? questMenuLayerNotice(menuLayer) : '';
  const proseParts = [
    ...developerLines,
    tracker.message ? `Rig msg: ${tracker.message}` : '',
    layerNotice ? `Menu layer: ${layerNotice}` : '',
    diagLayerMode ? `Diag layer: ${diagLayerMode}` : '',
  ].filter(Boolean);
  const proseText = proseParts.join('  |  ') || 'Stage 04 diagnostics active.';

  const timingLine =
    `gen ${input.generation}  epoch ${input.refEpoch ?? '--'}  ` +
    `dt ${fmt(input.captureDtMs.p50, 1)}/${fmt(input.captureDtMs.p95, 1)}/${fmt(input.captureDtMs.max, 1)}ms  ` +
    `xrdt ${fmt(input.displayDtMs.p50, 1)}/${fmt(input.displayDtMs.p95, 1)}ms  ` +
    `age ${fmt(input.ageMs, 1)}ms  read ${fmt(input.readMs.p95, 2)}ms  ` +
    `miss ${input.missed}  skip ${input.skippedBeforeFirstRead}  noIn ${input.framesWithoutInput}  inv ${input.invalid}  rej ${input.rejected}`;
  const profilesLine =
    `markers ${markerPipeline ?? 'render-thread'}   ` +
    `profile L ${input.profiles[0] || '--'}   R ${input.profiles[1] || '--'}`;

  const devRows: { text: string; size: number; color: string; bold?: boolean }[] = [
    { text: rigSummary, size: 31, color: PAPER, bold: true },
    { text: proseText, size: 28, color: MUTED },
    { text: timingLine, size: 26, color: DIM },
    { text: profilesLine, size: 26, color: DIM },
  ];
  let rowY = devY + 26;
  for (const row of devRows) {
    ops.push({
      op: 'text',
      text: row.text,
      x: 78,
      y: rowY,
      size: row.size,
      color: row.color,
      align: 'left',
      bold: Boolean(row.bold),
      ...(row.bold && boldFont ? { font: boldFont } : bodyFont ? { font: bodyFont } : {}),
      maxWidth: QUEST_DIAG_TEXTURE.widthPx - 156,
    });
    rowY += 68;
  }

  return {
    ops,
    specKey: JSON.stringify({
      width: QUEST_DIAG_TEXTURE.widthPx,
      height: QUEST_DIAG_TEXTURE.heightPx,
      ops,
    }),
  };
}

export function questDiagPanelSpec(frame: { pose: readonly number[]; ops: QuestMenuDrawOp[] }) {
  const round = (value: number) => Math.round(value * 1e5) / 1e5 || 0;
  return JSON.stringify({
    widthPx: QUEST_DIAG_TEXTURE.widthPx,
    heightPx: QUEST_DIAG_TEXTURE.heightPx,
    widthM: QUEST_DIAG_SIZE.widthM,
    heightM: QUEST_DIAG_SIZE.heightM,
    pose: frame.pose.map(round),
    ops: frame.ops,
  });
}

export function formatQuestDiagnosticsFallback(params: QuestDiagnosticsPanelParams): string {
  const { input, tracker, developerLines } = params;
  const handLine = (label: string, h: QuestHandSample | null, stats: QuestHandStats) => {
    if (!h) return `${label}: -- loss ${stats.losses}/${stats.recoveries}`;
    const b = h.buttons;
    const btn =
      label === 'L'
        ? `X:${b.primary ? 'ON' : 'off'} Y:${b.secondary ? 'ON' : 'off'} M:${b.menu ? 'ON' : 'off'}`
        : `A:${b.primary ? 'ON' : 'off'} B:${b.secondary ? 'ON' : 'off'}`;
    return (
      `${label} ${h.tracking.toUpperCase()} stick ${fmtSigned(h.thumbstick.x)},${fmtSigned(h.thumbstick.y)} ` +
      `trig ${fmt(h.trigger.value)} grip ${fmt(h.squeeze.value)} ${btn}`
    );
  };
  return [
    `DIAGNOSTICS | CTRL ${input.status} (${fmt(input.sampleHz, 0)}Hz)`,
    handLine('L', input.latest?.left ?? null, input.hands.left),
    handLine('R', input.latest?.right ?? null, input.hands.right),
    formatRigDeveloperSummary(tracker),
    ...developerLines,
  ].join('\n');
}
