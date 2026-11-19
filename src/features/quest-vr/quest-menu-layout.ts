// Pixel rectangles and metre frames are the same buttons. The texture draws the
// pixels; invisible controller targets use the metre frames. Y is up in metres
// and down in pixels. Colors are the phone dark theme. Android Canvas reads
// #AARRGGBB, so translucent fills are converted from the CSS #RRGGBBAA values.

export const QUEST_MENU_TEXTURE = { widthPx: 2048, heightPx: 1152 } as const;
export const QUEST_MENU_SIZE = { widthM: 1.6, heightM: 0.9 } as const;

export const QUEST_RING_POSE = {
  position: [0, -0.55, -2.1] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
};

// World-fixed, upright, and not parented to the headset. Eye height is y = 0.
// z = -1.15 keeps the larger panel in reach without covering the ring.
export const QUEST_MENU_POSE = {
  menu: {
    position: [0, 0.08, -1.15] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  },
  ring: {
    position: [0, 0.52, -1.15] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  },
};

export const QUEST_MENU_ACTIONS = ['solo', 'ready', 'back', 'exit'] as const;
export type QuestMenuAction = (typeof QUEST_MENU_ACTIONS)[number];
export type QuestMenuPage = 'menu' | 'ring';

export const QUEST_MENU_TAGLINE = 'Bring the fight to your table.';

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

export interface MenuTextureStep {
  generation: number;
  page: QuestMenuPage | null;
}

const buttonWidth = 540;
const buttonHeight = 256;
const buttonY = 832;
const buttonGap = 128;

function row(items: { action: QuestMenuAction; label: string }[]): QuestMenuButton[] {
  const total = items.length * buttonWidth + (items.length - 1) * buttonGap;
  let x = Math.round((QUEST_MENU_TEXTURE.widthPx - total) / 2);
  return items.map((item) => {
    const button = { ...item, x, y: buttonY, width: buttonWidth, height: buttonHeight };
    x += buttonWidth + buttonGap;
    return button;
  });
}

export function questMenuButtons(page: QuestMenuPage, acknowledged = false): QuestMenuButton[] {
  if (page === 'menu')
    return row([
      { action: 'solo', label: 'Solo' },
      { action: 'exit', label: 'Exit' },
    ]);
  return row([
    { action: 'ready', label: acknowledged ? 'Set' : 'Ready' },
    { action: 'back', label: 'Back' },
    { action: 'exit', label: 'Exit' },
  ]);
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
  acknowledged = false
): QuestMenuAction | null {
  const { widthPx, heightPx } = QUEST_MENU_TEXTURE;
  const { widthM, heightM } = QUEST_MENU_SIZE;
  const px = (localX / widthM + 0.5) * widthPx;
  const py = (0.5 - localY / heightM) * heightPx;
  for (const button of questMenuButtons(page, acknowledged)) {
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

export function wrapMenuLine(text: string, maxChars = 46): string[] {
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

export function beginMenuTexture(step: MenuTextureStep, page: QuestMenuPage) {
  return {
    generation: step.generation + 1,
    page,
    blank: step.page !== null && step.page !== page,
  };
}

export function menuTextureIsCurrent(generation: number, latest: number) {
  return generation === latest;
}

export function questMenuMaterialName(uri: string) {
  let hash = 2166136261;
  for (let index = 0; index < uri.length; index += 1) {
    hash ^= uri.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `questMenu-${(hash >>> 0).toString(16)}`;
}

function buttonColors(action: QuestMenuAction) {
  if (action === 'exit') return { fill: DANGER, text: INK };
  if (action === 'back') return { fill: '#000000', text: PAPER };
  return { fill: PRIMARY, text: INK };
}

function pushButton(
  ops: QuestMenuDrawOp[],
  button: QuestMenuButton,
  hovered: boolean,
  font?: string
) {
  const colors = buttonColors(button.action);
  const inset = hovered ? 14 : button.action === 'back' ? 8 : 0;
  if (inset > 0) {
    ops.push({
      op: 'roundRect',
      x: button.x,
      y: button.y,
      width: button.width,
      height: button.height,
      radius: 56,
      color: PAPER,
    });
    ops.push({
      op: 'roundRect',
      x: button.x + inset,
      y: button.y + inset,
      width: button.width - inset * 2,
      height: button.height - inset * 2,
      radius: 48,
      color: colors.fill,
    });
  } else {
    ops.push({
      op: 'roundRect',
      x: button.x,
      y: button.y,
      width: button.width,
      height: button.height,
      radius: 56,
      color: colors.fill,
    });
  }
  const size = 68;
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
  const rockWidth = 1100;
  const rockHeight = rockWidth / TITLE_ASPECT.rock;
  const neoHeight = rockHeight * 0.7;
  const neoWidth = neoHeight * TITLE_ASPECT.neo;
  const robotsHeight = rockHeight;
  const robotsWidth = robotsHeight * TITLE_ASPECT.robots;
  const center = QUEST_MENU_TEXTURE.widthPx / 2;
  let y = 72;
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
        y: top + Math.max(0, (drawnHeight - 64) / 2),
        size: 64,
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
  options: {
    hover?: QuestMenuAction | null;
    acknowledged?: boolean;
    assets?: QuestMenuAssets;
  } = {}
): QuestMenuModel {
  const acknowledged = options.acknowledged === true;
  const buttons = questMenuButtons(page, acknowledged);
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
  let textY = pushTitles(ops, assets) + 12;
  if (page === 'menu') {
    const size = 48;
    const pillWidth = 980;
    const pillHeight = 72;
    const pillX = Math.round((QUEST_MENU_TEXTURE.widthPx - pillWidth) / 2);
    ops.push({
      op: 'roundRect',
      x: pillX,
      y: textY,
      width: pillWidth,
      height: pillHeight,
      radius: 24,
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
    textY += pillHeight + 20;
  }
  for (const line of lines.flatMap((line) => wrapMenuLine(line)).slice(0, 6)) {
    if (textY + 52 > buttonY - 16) break;
    ops.push({
      op: 'text',
      text: line,
      x: QUEST_MENU_TEXTURE.widthPx / 2,
      y: textY,
      size: 52,
      color: PAPER,
      align: 'center',
      bold: false,
      maxWidth: 1760,
      ...(assets?.fonts?.body ? { font: assets.fonts.body } : {}),
    });
    textY += 64;
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
