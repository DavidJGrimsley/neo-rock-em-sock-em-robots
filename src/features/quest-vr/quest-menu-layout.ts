import { DEFAULT_QUEST_SETTINGS, type QuestUserSettings } from './quest-tuning.ts';

// Pixel rectangles and metre frames are the same buttons. The headset menu
// card layer (quest-menu-compositor.ts) draws a compact padded button card
// with Android Canvas, while a separate transparent title overlay floats
// above the opponent robot head in the ring (and above the card on the initial
// menu). Invisible controller hit targets use the metre frames. Y is up in
// metres and down in pixels.

export const QUEST_MENU_TEXTURE = { widthPx: 1216, heightPx: 432 } as const;
export const QUEST_MENU_SIZE = { widthM: 0.95, heightM: 0.3375 } as const;
export const QUEST_MENU_ALERT_TEXTURE = { widthPx: 1216, heightPx: 720 } as const;
export const QUEST_MENU_ALERT_SIZE = { widthM: 0.95, heightM: 0.5625 } as const;
export const QUEST_MENU_ALERT_EXTRA_PX =
  QUEST_MENU_ALERT_TEXTURE.heightPx - QUEST_MENU_TEXTURE.heightPx;
export const QUEST_MENU_ALERT_SHIFT_M =
  (QUEST_MENU_ALERT_SIZE.heightM - QUEST_MENU_SIZE.heightM) / 2;
export const QUEST_MENU_CARD_RADIUS_PX = 44;

export const QUEST_TITLE_TEXTURE = { widthPx: 1024, heightPx: 400 } as const;
export const QUEST_TITLE_SIZE = {
  menu: { widthM: 0.96, heightM: 0.375 },
  ring: { widthM: 1.2, heightM: 0.46875 },
  pause: { widthM: 0.96, heightM: 0.375 },
  settings: { widthM: 0.96, heightM: 0.375 },
} as const;

// Child of menuFrame(cal). Default calibration is the identity, so these metres
// match OpenXR LOCAL at eye height y = 0. Art and hit targets share this node.
// - menu: compact button card 1.50 m ahead, 6.8 deg below eye level.
// - ring: compact button card 1.35 m ahead, 30 deg down; opponent robot stays clear above.
// - pause: centered comfortably ahead of the current pause frame.
export const QUEST_MENU_POSE = {
  menu: {
    position: [0, -0.18, -1.5] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  },
  ring: {
    position: [0, -0.78, -1.35] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  },
  pause: {
    position: [0, -0.18, -1.5] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  },
  settings: {
    position: [0, -0.18, -1.5] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  },
};

// Floating transparent branded title poses in menuFrame(cal):
// - menu: above the compact button card (and above any expanded alert card), well below sky diagnostics.
// - ring: floating above the opponent robot head (+13.5..+22.8 deg vs robot top +11.4 deg and sky diag +29.3 deg).
// - pause: matches menu position above the Pause button card.
export const QUEST_TITLE_POSE = {
  menu: {
    position: [0, 0.43, -1.5] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  },
  ring: {
    position: [0, 0.86, -2.6] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  },
  pause: {
    position: [0, 0.43, -1.5] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  },
  settings: {
    position: [0, 0.43, -1.5] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  },
};

export const QUEST_MENU_ACTIONS = [
  'solo',
  'ready',
  'back',
  'exit',
  'posture',
  'resume',
  'settings',
  'music-volume',
  'sfx-volume',
  'damage-tint',
  'turn-mode',
  'pause-done',
] as const;
export type QuestMenuAction = (typeof QUEST_MENU_ACTIONS)[number];
export type QuestMenuPage = 'menu' | 'ring' | 'pause' | 'settings';
export type QuestMenuPosture = 'standing' | 'seated';

export const QUEST_MENU_TEXT_LINES_MAX = 4;

const INK = '#09090b';
const PAPER = '#f8fafc';
const MUTED_PAPER = '#e2e8f0';
const PRIMARY = '#60a5fa';
const SECONDARY = '#a78bfa';
const SELECTED = '#075985';
const DANGER = '#d99a9a';
const CARD = '#0f172a';
const DIVIDER = '#334155';

// Aspect ratios of the transparent PNGs in assets/arena/ui/quest-lettering/,
// rasterized from the iOS ArenaDisplayText SVGs (lettering.json).
const TITLE_ASPECT = {
  neo: 360 / 132,
  rock: 1594 / 212,
  robots: 620 / 216,
} as const;

export interface QuestMenuButton {
  action: QuestMenuAction;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QuestMenuDrawOp {
  op: 'roundRect' | 'text' | 'image';
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number;
  color?: string;
  uri?: string;
  text?: string;
  size?: number;
  align?: 'left' | 'center';
  bold?: boolean;
  font?: string;
  maxWidth?: number;
}

export interface QuestMenuModel {
  page: QuestMenuPage;
  hasMessages: boolean;
  widthPx: number;
  heightPx: number;
  widthM: number;
  heightM: number;
  buttons: QuestMenuButton[];
  ops: QuestMenuDrawOp[];
  specKey: string;
}

export interface QuestMenuTitleModel {
  widthPx: number;
  heightPx: number;
  ops: QuestMenuDrawOp[];
  specKey: string;
}

export interface QuestMenuFonts {
  body?: string | null;
  button?: string | null;
}

export interface QuestMenuTitles {
  neo?: string | null;
  rock?: string | null;
  robots?: string | null;
}

export interface QuestMenuBuildOptions {
  hover?: QuestMenuAction | null;
  acknowledged?: boolean;
  posture?: QuestMenuPosture;
  fonts?: QuestMenuFonts;
  titles?: QuestMenuTitles;
  settings?: QuestUserSettings;
}

const cardPaddingX = 48;
const cardPaddingY = 48;
const buttonWidth = 520;
const buttonHeight = 156;
const buttonGap = 80;
const rowGap = 24;

function buttonRowsY(hasMessages: boolean) {
  const offset = hasMessages ? QUEST_MENU_ALERT_EXTRA_PX : 0;
  const topRowY = cardPaddingY + offset;
  const bottomRowY = topRowY + buttonHeight + rowGap;
  return { topRowY, bottomRowY };
}

function placeRow(
  items: { action: QuestMenuAction; label: string }[],
  y: number
): QuestMenuButton[] {
  const gap = items.length >= 3 ? 28 : buttonGap;
  const width =
    items.length >= 3
      ? Math.floor(
          (QUEST_MENU_TEXTURE.widthPx - cardPaddingX * 2 - (items.length - 1) * gap) / items.length
        )
      : buttonWidth;
  const total = items.length * width + (items.length - 1) * gap;
  let x = Math.round((QUEST_MENU_TEXTURE.widthPx - total) / 2);
  return items.map((item) => {
    const button = { ...item, x, y, width, height: buttonHeight };
    x += width + gap;
    return button;
  });
}

function resolveButtonArgs(
  arg:
    | boolean
    | QuestMenuPosture
    | {
        acknowledged?: boolean;
        posture?: QuestMenuPosture;
        hasMessages?: boolean;
        settings?: QuestUserSettings;
      } = false,
  postureArg?: QuestMenuPosture
): {
  acknowledged: boolean;
  posture: QuestMenuPosture;
  hasMessages: boolean;
  settings?: QuestUserSettings;
} {
  if (typeof arg === 'boolean') {
    return {
      acknowledged: arg,
      posture: postureArg ?? 'standing',
      hasMessages: false,
    };
  }
  if (arg === 'standing' || arg === 'seated') {
    return { acknowledged: false, posture: arg, hasMessages: false };
  }
  return {
    acknowledged: arg.acknowledged === true,
    posture: arg.posture ?? postureArg ?? 'standing',
    hasMessages: arg.hasMessages === true,
    settings: arg.settings,
  };
}

export function questMenuCardMetrics(hasMessages: boolean) {
  const texture = hasMessages ? QUEST_MENU_ALERT_TEXTURE : QUEST_MENU_TEXTURE;
  const size = hasMessages ? QUEST_MENU_ALERT_SIZE : QUEST_MENU_SIZE;
  return { ...texture, ...size };
}

export function questMenuButtons(
  page: QuestMenuPage,
  acknowledgedOrOptions:
    | boolean
    | QuestMenuPosture
    | {
        acknowledged?: boolean;
        posture?: QuestMenuPosture;
        hasMessages?: boolean;
        settings?: QuestUserSettings;
      } = false,
  postureArg?: QuestMenuPosture
): QuestMenuButton[] {
  const {
    acknowledged,
    posture,
    hasMessages,
    settings = DEFAULT_QUEST_SETTINGS,
  } = resolveButtonArgs(acknowledgedOrOptions, postureArg);
  const postureButton = {
    action: 'posture' as const,
    label: posture === 'seated' ? 'Seated' : 'Standing',
  };
  const items: { action: QuestMenuAction; label: string }[] =
    page === 'settings'
      ? [
          { action: 'music-volume', label: `Music ${Math.round(settings.musicVolume * 100)}%` },
          { action: 'sfx-volume', label: `Effects ${Math.round(settings.sfxVolume * 100)}%` },
          { action: 'damage-tint', label: settings.damageTintEnabled ? 'Tint on' : 'Tint off' },
          {
            action: 'turn-mode',
            label: settings.turnMode === 'snap' ? 'Snap turn' : 'Smooth turn',
          },
          { action: 'pause-done', label: 'Done' },
        ]
      : page === 'menu'
        ? [
            { action: 'solo' as const, label: 'Solo' },
            postureButton,
            { action: 'exit' as const, label: 'Exit' },
          ]
        : page === 'pause'
          ? [
              { action: 'resume' as const, label: 'Resume' },
              { action: 'back' as const, label: 'Menu' },
              { action: 'settings' as const, label: 'Options' },
              { action: 'exit' as const, label: 'Exit' },
            ]
          : [
              { action: 'ready' as const, label: acknowledged ? 'Set' : 'Ready' },
              { action: 'back' as const, label: 'Back' },
              postureButton,
              { action: 'exit' as const, label: 'Exit' },
            ];
  const topCount = page === 'settings' ? 3 : 2;
  const { topRowY, bottomRowY } = buttonRowsY(hasMessages);
  return [
    ...placeRow(items.slice(0, topCount), topRowY),
    ...placeRow(items.slice(topCount), bottomRowY),
  ];
}

export function questMenuButtonFrame(button: QuestMenuButton, hasMessages = false) {
  const { widthPx, heightPx, widthM, heightM } = questMenuCardMetrics(hasMessages);
  return {
    position: [
      ((button.x + button.width / 2) / widthPx - 0.5) * widthM,
      (0.5 - (button.y + button.height / 2) / heightPx) * heightM,
      0.012,
    ] as [number, number, number],
    width: (button.width / widthPx) * widthM,
    height: (button.height / heightPx) * heightM,
  };
}

export function questMenuHit(
  page: QuestMenuPage,
  localX: number,
  localY: number,
  acknowledgedOrOptions:
    | boolean
    | QuestMenuPosture
    | {
        acknowledged?: boolean;
        posture?: QuestMenuPosture;
        hasMessages?: boolean;
      } = false,
  postureArg?: QuestMenuPosture
): QuestMenuAction | null {
  const resolved = resolveButtonArgs(acknowledgedOrOptions, postureArg);
  const { widthPx, heightPx, widthM, heightM } = questMenuCardMetrics(resolved.hasMessages);
  const px = (localX / widthM + 0.5) * widthPx;
  const py = (0.5 - localY / heightM) * heightPx;
  for (const button of questMenuButtons(page, resolved)) {
    if (
      px >= button.x &&
      px < button.x + button.width &&
      py >= button.y &&
      py < button.y + button.height
    )
      return button.action;
  }
  return null;
}

export function wrapMenuLine(text: string, maxChars = 48): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function buttonColors(action: QuestMenuAction, hovered: boolean, acknowledged: boolean) {
  if (action === 'exit') return { fill: hovered ? '#e6b2b2' : DANGER, text: INK };
  if (action === 'back') return { fill: hovered ? '#334155' : '#1e293b', text: PAPER };
  if (action === 'posture') {
    return { fill: hovered ? '#475569' : '#334155', text: PAPER };
  }
  if (action === 'ready' && acknowledged) {
    return { fill: hovered ? '#0369a1' : SELECTED, text: PAPER };
  }
  return { fill: hovered ? '#93c5fd' : PRIMARY, text: INK };
}

function pushButton(
  ops: QuestMenuDrawOp[],
  button: QuestMenuButton,
  hovered: boolean,
  acknowledged: boolean,
  font?: string | null
) {
  const colors = buttonColors(button.action, hovered, acknowledged);
  const inset = button.action === 'back' ? 6 : 0;
  if (inset > 0) {
    ops.push({
      op: 'roundRect',
      x: button.x,
      y: button.y,
      width: button.width,
      height: button.height,
      radius: 36,
      color: '#94a3b8',
    });
    ops.push({
      op: 'roundRect',
      x: button.x + inset,
      y: button.y + inset,
      width: button.width - inset * 2,
      height: button.height - inset * 2,
      radius: 30,
      color: colors.fill,
    });
  } else {
    ops.push({
      op: 'roundRect',
      x: button.x,
      y: button.y,
      width: button.width,
      height: button.height,
      radius: 36,
      color: colors.fill,
    });
  }
  const size = 54;
  ops.push({
    op: 'text',
    text: button.label,
    x: button.x + button.width / 2,
    y: button.y + (button.height - size) / 2,
    size,
    color: colors.text,
    align: 'center',
    bold: true,
    ...(font ? { font } : {}),
    maxWidth: button.width - 64,
  });
}

/**
 * Transparent branded title overlay (`Neo` / `Rock 'Em Sock 'Em` / `Robots`),
 * rendered onto an ARGB_8888 quad without any card background.
 */
export function buildQuestMenuTitle(
  options: { titles?: QuestMenuTitles; fonts?: QuestMenuFonts } = {}
): QuestMenuTitleModel {
  const rockWidth = 960;
  const rockHeight = Math.round(rockWidth / TITLE_ASPECT.rock);
  const neoHeight = Math.round(rockHeight * 0.7);
  const neoWidth = Math.round(neoHeight * TITLE_ASPECT.neo);
  const robotsHeight = rockHeight;
  const robotsWidth = Math.round(robotsHeight * TITLE_ASPECT.robots);
  const gap = 8;
  const totalHeight = neoHeight + gap + rockHeight + gap + robotsHeight;
  const center = QUEST_TITLE_TEXTURE.widthPx / 2;
  const titleFont = options.fonts?.button ?? options.fonts?.body ?? undefined;
  const useImages = Boolean(options.titles?.neo && options.titles?.rock && options.titles?.robots);
  const ops: QuestMenuDrawOp[] = [];
  let y = Math.round((QUEST_TITLE_TEXTURE.heightPx - totalHeight) / 2);

  const place = (
    uri: string | null | undefined,
    text: string,
    width: number,
    height: number,
    color: string,
    textSize: number
  ) => {
    if (useImages && uri) {
      ops.push({
        op: 'image',
        uri,
        x: Math.round(center - width / 2),
        y,
        width,
        height,
        text,
        size: textSize,
        color,
        ...(titleFont ? { font: titleFont } : {}),
        maxWidth: QUEST_TITLE_TEXTURE.widthPx - 48,
      });
    } else {
      ops.push({
        op: 'text',
        text,
        x: center,
        y: y + Math.max(0, Math.round((height - textSize) / 2)),
        size: textSize,
        color,
        align: 'center',
        bold: true,
        ...(titleFont ? { font: titleFont } : {}),
        maxWidth: QUEST_TITLE_TEXTURE.widthPx - 48,
      });
    }
    y += height + gap;
  };

  place(options.titles?.neo, 'Neo', neoWidth, neoHeight, SECONDARY, 56);
  place(options.titles?.rock, "Rock 'Em Sock 'Em", rockWidth, rockHeight, PRIMARY, 76);
  place(options.titles?.robots, 'Robots', robotsWidth, robotsHeight, PRIMARY, 76);

  return {
    widthPx: QUEST_TITLE_TEXTURE.widthPx,
    heightPx: QUEST_TITLE_TEXTURE.heightPx,
    ops,
    specKey: JSON.stringify({
      width: QUEST_TITLE_TEXTURE.widthPx,
      height: QUEST_TITLE_TEXTURE.heightPx,
      ops,
    }),
  };
}

export function buildQuestMenu(
  page: QuestMenuPage,
  lines: string[],
  optionsOrPosture: QuestMenuPosture | QuestMenuBuildOptions = {}
): QuestMenuModel {
  const options: QuestMenuBuildOptions =
    typeof optionsOrPosture === 'string' ? { posture: optionsOrPosture } : optionsOrPosture;
  const acknowledged = options.acknowledged === true;
  const posture = options.posture ?? 'standing';
  const bodyFont = options.fonts?.body ?? undefined;
  const buttonFont = options.fonts?.button ?? bodyFont;
  const wrappedLines = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => wrapMenuLine(line))
    .slice(0, QUEST_MENU_TEXT_LINES_MAX);
  const hasMessages = wrappedLines.length > 0;
  const { widthPx, heightPx, widthM, heightM } = questMenuCardMetrics(hasMessages);
  const buttons = questMenuButtons(page, {
    acknowledged,
    posture,
    hasMessages,
    settings: options.settings,
  });
  const { topRowY } = buttonRowsY(hasMessages);

  const ops: QuestMenuDrawOp[] = [
    {
      op: 'roundRect',
      x: 0,
      y: 0,
      width: widthPx,
      height: heightPx,
      radius: QUEST_MENU_CARD_RADIUS_PX,
      color: CARD,
    },
  ];

  if (hasMessages) {
    let textY = cardPaddingY;
    for (const line of wrappedLines) {
      if (textY + 40 > topRowY - 40) break;
      ops.push({
        op: 'text',
        text: line,
        x: widthPx / 2,
        y: textY,
        size: 36,
        color: MUTED_PAPER,
        align: 'center',
        bold: false,
        ...(bodyFont ? { font: bodyFont } : {}),
        maxWidth: widthPx - cardPaddingX * 2,
      });
      textY += 48;
    }
    ops.push({
      op: 'roundRect',
      x: cardPaddingX,
      y: topRowY - 28,
      width: widthPx - cardPaddingX * 2,
      height: 4,
      radius: 2,
      color: DIVIDER,
    });
  }

  for (const button of buttons) {
    pushButton(ops, button, options.hover === button.action, acknowledged, buttonFont);
  }
  return {
    page,
    hasMessages,
    widthPx,
    heightPx,
    widthM,
    heightM,
    buttons,
    ops,
    specKey: JSON.stringify({
      width: widthPx,
      height: heightPx,
      ops,
    }),
  };
}
