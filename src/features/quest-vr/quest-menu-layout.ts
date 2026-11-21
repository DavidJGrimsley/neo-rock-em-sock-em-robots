// Pixel rectangles and metre frames are the same buttons. The headset menu
// layer (quest-menu-compositor.ts) draws the pixels with Android Canvas;
// invisible controller targets use the metre frames. Y is up in metres and
// down in pixels.

export const QUEST_MENU_TEXTURE = { widthPx: 2048, heightPx: 1152 } as const;
export const QUEST_MENU_SIZE = { widthM: 1.6, heightM: 0.9 } as const;
export const QUEST_MENU_CARD_RADIUS_PX = 56;

// Child of menuFrame(cal). Default calibration is the identity, so these metres
// match OpenXR LOCAL at eye height y = 0. Art and hit targets share this node.
// - menu: center 1.50 m away, 3 degrees below eye level, about 56 degrees wide.
// - ring: upright, center 1.60 m away and 32 degrees down, about 61 degrees
//   wide. The opponent's head and torso stay above it. Its lower legs (the
//   bottom 0.49-0.64 m of the 1.92 m robot) are behind the panel.
export const QUEST_MENU_POSE = {
  menu: {
    position: [0, -0.08, -1.5] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  },
  ring: {
    position: [0, -0.85, -1.35] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  },
};

export const QUEST_MENU_ACTIONS = ['solo', 'ready', 'back', 'exit', 'posture'] as const;
export type QuestMenuAction = (typeof QUEST_MENU_ACTIONS)[number];
export type QuestMenuPage = 'menu' | 'ring';
export type QuestMenuPosture = 'standing' | 'seated';

// Body lines use size 38, step 48. Six lines finish at y <= 728, keeping the
// top button row (y = 764) clear below the 3-line iOS title on both pages.
export const QUEST_MENU_TEXT_LINES_MAX = 6;

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
  buttons: QuestMenuButton[];
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
          postureButton,
          { action: 'exit' as const, label: 'Exit' },
        ]
      : [
          { action: 'ready' as const, label: acknowledged ? 'Set' : 'Ready' },
          { action: 'back' as const, label: 'Back' },
          postureButton,
          { action: 'exit' as const, label: 'Exit' },
        ];
  const topCount = 2;
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

export function wrapMenuLine(text: string, maxChars = 62): string[] {
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
  if (action === 'posture') return { fill: hovered ? '#475569' : '#334155', text: PAPER };
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

function pushTitles(
  ops: QuestMenuDrawOp[],
  titles: QuestMenuTitles | undefined,
  buttonFont?: string | null
) {
  // Match the iOS ArenaDisplayText stack (0.7 : 1.0 : 1.0 heights).
  const rockWidth = 1000;
  const rockHeight = Math.round(rockWidth / TITLE_ASPECT.rock);
  const neoHeight = Math.round(rockHeight * 0.7);
  const neoWidth = Math.round(neoHeight * TITLE_ASPECT.neo);
  const robotsHeight = rockHeight;
  const robotsWidth = Math.round(robotsHeight * TITLE_ASPECT.robots);
  const center = QUEST_MENU_TEXTURE.widthPx / 2;
  const useImages = Boolean(titles?.neo && titles?.rock && titles?.robots);
  let y = 36;
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
        ...(buttonFont ? { font: buttonFont } : {}),
        maxWidth: 1760,
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
        ...(buttonFont ? { font: buttonFont } : {}),
        maxWidth: 1760,
      });
    }
    y += height + 6;
  };
  place(titles?.neo, 'Neo', neoWidth, neoHeight, SECONDARY, 56);
  place(titles?.rock, "Rock 'Em Sock 'Em", rockWidth, rockHeight, PRIMARY, 76);
  place(titles?.robots, 'Robots', robotsWidth, robotsHeight, PRIMARY, 76);
  return y - 6;
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
  const buttons = questMenuButtons(page, { acknowledged, posture });
  const ops: QuestMenuDrawOp[] = [
    {
      op: 'roundRect',
      x: 0,
      y: 0,
      width: QUEST_MENU_TEXTURE.widthPx,
      height: QUEST_MENU_TEXTURE.heightPx,
      radius: QUEST_MENU_CARD_RADIUS_PX,
      color: CARD,
    },
  ];
  const titleBottom = pushTitles(ops, options.titles, buttonFont);
  const dividerY = titleBottom + 17;
  ops.push({
    op: 'roundRect',
    x: 112,
    y: dividerY,
    width: QUEST_MENU_TEXTURE.widthPx - 224,
    height: 4,
    radius: 2,
    color: DIVIDER,
  });

  let textY = dividerY + 26;
  for (const line of lines
    .flatMap((line) => wrapMenuLine(line))
    .slice(0, QUEST_MENU_TEXT_LINES_MAX)) {
    if (textY + 40 > topRowY - 24) break;
    ops.push({
      op: 'text',
      text: line,
      x: QUEST_MENU_TEXTURE.widthPx / 2,
      y: textY,
      size: 38,
      color: MUTED_PAPER,
      align: 'center',
      bold: false,
      ...(bodyFont ? { font: bodyFont } : {}),
      maxWidth: 1760,
    });
    textY += 48;
  }
  for (const button of buttons) {
    pushButton(ops, button, options.hover === button.action, acknowledged, buttonFont);
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
