// Pixel rectangles and metre frames are the same buttons. The texture draws the
// pixels; invisible controller targets use the metre frames. Y is up in metres
// and down in pixels. Colors are the phone dark theme. Android Canvas reads
// #AARRGGBB, so translucent fills are converted from the CSS #RRGGBBAA values.

export const QUEST_MENU_TEXTURE = { widthPx: 2048, heightPx: 1152 } as const;
export const QUEST_MENU_SIZE = { widthM: 1.6, heightM: 0.9 } as const;

// Child of menuFrame(cal). Default calibration is the identity, so these metres
// match OpenXR LOCAL at eye height y = 0. The ring panel is upright and below
// the opponent: center (0, -0.78, -0.5), about 0.93 m from the eye.
export const QUEST_MENU_POSE = {
  menu: {
    position: [0, 0.08, -1.15] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  },
  ring: {
    position: [0, -0.78, -0.5] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  },
};

export const QUEST_MENU_ACTIONS = ['solo', 'ready', 'back', 'exit', 'recenter', 'posture'] as const;
export type QuestMenuAction = (typeof QUEST_MENU_ACTIONS)[number];
export type QuestMenuPage = 'menu' | 'ring';
export type QuestMenuPosture = 'standing' | 'seated';

export const QUEST_MENU_TAGLINE = 'Bring the fight to your table.';
// Body lines use size 36, step 44. Six lines finish at y <= 736, keeping the
// top button row (y = 764) clear on both menu and ring pages.
export const QUEST_MENU_TEXT_LINES_MAX = 6;

// Phone lettering.svg viewBoxes, used only to place the pre-rasterized PNGs.
const TITLE_ASPECT = {
  neo: 180.2 / 66,
  rock: 797 / 106,
  robots: 310 / 108,
} as const;

const INK = '#09090b';
const PAPER = '#f8fafc';
const PRIMARY = '#60a5fa';
const SECONDARY = '#a78bfa';
const DANGER = '#d99a9a';
const CARD = '#E818181B';
const TAG_BG = '#A809090B';
const PANEL = '#09090b';

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
  text?: string;
  size?: number;
  align?: 'left' | 'center';
  bold?: boolean;
  maxWidth?: number;
  font?: string;
  uri?: string;
}

export interface QuestMenuAssets {
  backgroundUri?: string;
  fonts?: { body?: string; button?: string; serif?: string };
  titles?: { neo?: string; rock?: string; robots?: string };
}

export interface QuestMenuModel {
  page: QuestMenuPage;
  buttons: QuestMenuButton[];
  ops: QuestMenuDrawOp[];
  specKey: string;
}

export interface QuestMenuBuildOptions {
  hover?: QuestMenuAction | null;
  acknowledged?: boolean;
  posture?: QuestMenuPosture;
  assets?: QuestMenuAssets;
}

const buttonWidth = 520;
const buttonHeight = 156;
const buttonGap = 80;
const rowGap = 24;
const bottomRowY = 944;
const topRowY = bottomRowY - buttonHeight - rowGap;

function placeRow(
  items: { action: QuestMenuAction; label: string }[],
  y: number
): QuestMenuButton[] {
  const total = items.length * buttonWidth + (items.length - 1) * buttonGap;
  let x = Math.round((QUEST_MENU_TEXTURE.widthPx - total) / 2);
  return items.map((item) => {
    const button = { ...item, x, y, width: buttonWidth, height: buttonHeight };
    x += buttonWidth + buttonGap;
    return button;
  });
}

function resolveButtonArgs(
  arg: boolean | QuestMenuPosture | { acknowledged?: boolean; posture?: QuestMenuPosture } = false,
  postureArg?: QuestMenuPosture
): { acknowledged: boolean; posture: QuestMenuPosture } {
  if (typeof arg === 'boolean') {
    return { acknowledged: arg, posture: postureArg ?? 'standing' };
  }
  if (arg === 'standing' || arg === 'seated') {
    return { acknowledged: false, posture: arg };
  }
  return {
    acknowledged: arg.acknowledged === true,
    posture: arg.posture ?? postureArg ?? 'standing',
  };
}

export function questMenuButtons(
  page: QuestMenuPage,
  acknowledgedOrOptions:
    boolean | QuestMenuPosture | { acknowledged?: boolean; posture?: QuestMenuPosture } = false,
  postureArg?: QuestMenuPosture
): QuestMenuButton[] {
  const { acknowledged, posture } = resolveButtonArgs(acknowledgedOrOptions, postureArg);
  const postureButton = {
    action: 'posture' as const,
    label: posture === 'seated' ? 'Seated' : 'Standing',
  };
  const items =
    page === 'menu'
      ? [
          { action: 'solo' as const, label: 'Solo' },
          { action: 'recenter' as const, label: 'Recenter' },
          postureButton,
          { action: 'exit' as const, label: 'Exit' },
        ]
      : [
          { action: 'ready' as const, label: acknowledged ? 'Set' : 'Ready' },
          { action: 'back' as const, label: 'Back' },
          { action: 'exit' as const, label: 'Exit' },
          { action: 'recenter' as const, label: 'Recenter' },
          postureButton,
        ];
  const topCount = page === 'menu' ? 2 : 3;
  return [
    ...placeRow(items.slice(0, topCount), topRowY),
    ...placeRow(items.slice(topCount), bottomRowY),
  ];
}

export function questMenuButtonFrame(button: QuestMenuButton) {
  const { widthPx, heightPx } = QUEST_MENU_TEXTURE;
  const { widthM, heightM } = QUEST_MENU_SIZE;
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
    boolean | QuestMenuPosture | { acknowledged?: boolean; posture?: QuestMenuPosture } = false,
  postureArg?: QuestMenuPosture
): QuestMenuAction | null {
  const { widthPx, heightPx } = QUEST_MENU_TEXTURE;
  const { widthM, heightM } = QUEST_MENU_SIZE;
  const px = (localX / widthM + 0.5) * widthPx;
  const py = (0.5 - localY / heightM) * heightPx;
  for (const button of questMenuButtons(page, acknowledgedOrOptions, postureArg)) {
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

export function wrapMenuLine(text: string, maxChars = 64): string[] {
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

export function questMenuMaterialName(uri: string) {
  // FNV-1a gives a short valid Viro material name that changes whenever the PNG URI does.
  let hash = 0x811c9dc5;
  for (let index = 0; index < uri.length; index += 1) {
    hash ^= uri.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `questMenu-${(hash >>> 0).toString(16)}`;
}

function buttonColors(action: QuestMenuAction, hovered: boolean) {
  if (action === 'exit') return { fill: hovered ? '#e6b2b2' : DANGER, text: INK };
  if (action === 'back') return { fill: hovered ? '#27272a' : INK, text: PAPER };
  if (action === 'recenter') return { fill: hovered ? '#2563eb' : '#1e3a8a', text: PAPER };
  if (action === 'posture') return { fill: hovered ? '#a16207' : '#854d0e', text: PAPER };
  return { fill: hovered ? '#93c5fd' : PRIMARY, text: INK };
}

function pushButton(
  ops: QuestMenuDrawOp[],
  button: QuestMenuButton,
  hovered: boolean,
  font: string | undefined
) {
  const colors = buttonColors(button.action, hovered);
  const inset = button.action === 'back' ? 8 : 0;
  if (inset > 0) {
    ops.push({
      op: 'roundRect',
      x: button.x,
      y: button.y,
      width: button.width,
      height: button.height,
      radius: 40,
      color: PAPER,
    });
    ops.push({
      op: 'roundRect',
      x: button.x + inset,
      y: button.y + inset,
      width: button.width - inset * 2,
      height: button.height - inset * 2,
      radius: 32,
      color: colors.fill,
    });
  } else {
    ops.push({
      op: 'roundRect',
      x: button.x,
      y: button.y,
      width: button.width,
      height: button.height,
      radius: 40,
      color: colors.fill,
    });
  }
  const size = 56;
  ops.push({
    op: 'text',
    text: button.label,
    x: button.x + button.width / 2,
    y: button.y + (button.height - size) / 2,
    size,
    color: colors.text,
    align: 'center',
    bold: true,
    maxWidth: button.width - 64,
    ...(font ? { font } : {}),
  });
}

function pushTitles(ops: QuestMenuDrawOp[], assets: QuestMenuAssets | undefined) {
  const titles = assets?.titles;
  const rockWidth = 860;
  const rockHeight = rockWidth / TITLE_ASPECT.rock;
  const neoHeight = rockHeight * 0.7;
  const neoWidth = neoHeight * TITLE_ASPECT.neo;
  const robotsHeight = rockHeight;
  const robotsWidth = robotsHeight * TITLE_ASPECT.robots;
  const center = QUEST_MENU_TEXTURE.widthPx / 2;
  let y = 56;
  const useImages = Boolean(titles?.neo && titles.rock && titles.robots);
  const place = (
    uri: string | undefined,
    text: string,
    width: number,
    height: number,
    color: string
  ) => {
    const top = Math.round(y);
    const drawnHeight = Math.round(height);
    if (useImages && uri) {
      ops.push({
        op: 'image',
        uri,
        x: Math.round(center - width / 2),
        y: top,
        width: Math.round(width),
        height: drawnHeight,
      });
    } else {
      ops.push({
        op: 'text',
        text,
        x: center,
        y: top + Math.max(0, (drawnHeight - 54) / 2),
        size: 54,
        color,
        align: 'center',
        bold: true,
        maxWidth: 1800,
        ...(assets?.fonts?.button ? { font: assets.fonts.button } : {}),
      });
    }
    y += drawnHeight + 8;
  };
  place(titles?.neo, 'Neo', neoWidth, neoHeight, SECONDARY);
  place(titles?.rock, "Rock 'Em Sock 'Em", rockWidth, rockHeight, PRIMARY);
  place(titles?.robots, 'Robots', robotsWidth, robotsHeight, PRIMARY);
  return Math.round(y);
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
  const buttons = questMenuButtons(page, { acknowledged, posture });
  const assets = options.assets;
  const ops: QuestMenuDrawOp[] = [];
  if (assets?.backgroundUri) {
    ops.push({
      op: 'image',
      uri: assets.backgroundUri,
      x: 0,
      y: 0,
      width: QUEST_MENU_TEXTURE.widthPx,
      height: QUEST_MENU_TEXTURE.heightPx,
    });
  } else {
    ops.push({
      op: 'roundRect',
      x: 0,
      y: 0,
      width: QUEST_MENU_TEXTURE.widthPx,
      height: QUEST_MENU_TEXTURE.heightPx,
      radius: 0,
      color: PANEL,
    });
  }
  ops.push({
    op: 'roundRect',
    x: 48,
    y: 36,
    width: QUEST_MENU_TEXTURE.widthPx - 96,
    height: QUEST_MENU_TEXTURE.heightPx - 72,
    radius: 48,
    color: CARD,
  });
  let textY = pushTitles(ops, assets) + 10;
  if (page === 'menu') {
    const size = 40;
    const pillWidth = 880;
    const pillHeight = 60;
    const pillX = Math.round((QUEST_MENU_TEXTURE.widthPx - pillWidth) / 2);
    ops.push({
      op: 'roundRect',
      x: pillX,
      y: textY,
      width: pillWidth,
      height: pillHeight,
      radius: 20,
      color: TAG_BG,
    });
    ops.push({
      op: 'text',
      text: QUEST_MENU_TAGLINE,
      x: QUEST_MENU_TEXTURE.widthPx / 2,
      y: textY + (pillHeight - size) / 2,
      size,
      color: PAPER,
      align: 'center',
      bold: false,
      maxWidth: pillWidth - 48,
      ...(assets?.fonts?.serif ? { font: assets.fonts.serif } : {}),
    });
    textY += pillHeight + 14;
  }
  for (const line of lines
    .flatMap((line) => wrapMenuLine(line))
    .slice(0, QUEST_MENU_TEXT_LINES_MAX)) {
    if (textY + 36 > topRowY - 16) break;
    ops.push({
      op: 'text',
      text: line,
      x: QUEST_MENU_TEXTURE.widthPx / 2,
      y: textY,
      size: 36,
      color: PAPER,
      align: 'center',
      bold: false,
      maxWidth: 1760,
      ...(assets?.fonts?.body ? { font: assets.fonts.body } : {}),
    });
    textY += 44;
  }
  for (const button of buttons) {
    pushButton(ops, button, options.hover === button.action, assets?.fonts?.button);
  }
  return {
    page,
    buttons,
    ops,
    specKey: JSON.stringify({
      width: QUEST_MENU_TEXTURE.widthPx,
      height: QUEST_MENU_TEXTURE.heightPx,
      ops,
    }),
  };
}
