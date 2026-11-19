// Pixel rectangles and metre frames are the same buttons. The texture draws the
// pixels; invisible controller targets use the metre frames. Y is up in metres
// and down in pixels.

export const QUEST_MENU_TEXTURE = { widthPx: 2048, heightPx: 1152 } as const;
export const QUEST_MENU_SIZE = { widthM: 1.28, heightM: 0.72 } as const;

export const QUEST_RING_POSE = {
  position: [0, -0.55, -2.1] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
};

// World-fixed, upright, and not parented to the headset. Eye height is y = 0.
export const QUEST_MENU_POSE = {
  menu: {
    position: [0, 0.12, -1.4] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  },
  ring: {
    position: [0, 0.58, -1.4] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
  },
};

export const QUEST_MENU_ACTIONS = ['solo', 'ready', 'back', 'exit'] as const;
export type QuestMenuAction = (typeof QUEST_MENU_ACTIONS)[number];
export type QuestMenuPage = 'menu' | 'ring';

export interface QuestMenuButton {
  action: QuestMenuAction;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QuestMenuDrawOp {
  op: 'roundRect' | 'text';
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number;
  color: string;
  text?: string;
  size?: number;
  align?: 'left' | 'center';
  bold?: boolean;
  maxWidth?: number;
}

export interface QuestMenuModel {
  page: QuestMenuPage;
  buttons: QuestMenuButton[];
  ops: QuestMenuDrawOp[];
  specKey: string;
}

const buttonWidth = 520;
const buttonHeight = 168;
const buttonY = 900;
const buttonGap = 48;

function row(items: { action: QuestMenuAction; label: string }[]): QuestMenuButton[] {
  const total = items.length * buttonWidth + (items.length - 1) * buttonGap;
  let x = Math.round((QUEST_MENU_TEXTURE.widthPx - total) / 2);
  return items.map((item) => {
    const button = { ...item, x, y: buttonY, width: buttonWidth, height: buttonHeight };
    x += buttonWidth + buttonGap;
    return button;
  });
}

export function questMenuButtons(page: QuestMenuPage): QuestMenuButton[] {
  if (page === 'menu')
    return row([
      { action: 'solo', label: 'Solo' },
      { action: 'exit', label: 'Exit' },
    ]);
  return row([
    { action: 'ready', label: 'Ready' },
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
  localY: number
): QuestMenuAction | null {
  const { widthPx, heightPx } = QUEST_MENU_TEXTURE;
  const { widthM, heightM } = QUEST_MENU_SIZE;
  const px = (localX / widthM + 0.5) * widthPx;
  const py = (0.5 - localY / heightM) * heightPx;
  for (const button of questMenuButtons(page)) {
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

const buttonFill: Record<QuestMenuAction, string> = {
  solo: '#0f766e',
  ready: '#0f766e',
  back: '#334155',
  exit: '#991b1b',
};

export function buildQuestMenu(page: QuestMenuPage, lines: string[]): QuestMenuModel {
  const buttons = questMenuButtons(page);
  const ops: QuestMenuDrawOp[] = [
    {
      op: 'roundRect',
      x: 28,
      y: 28,
      width: QUEST_MENU_TEXTURE.widthPx - 56,
      height: QUEST_MENU_TEXTURE.heightPx - 56,
      radius: 40,
      color: '#101826',
    },
    {
      op: 'text',
      text: page === 'menu' ? 'Arena' : 'Solo ring',
      x: 88,
      y: 78,
      size: 68,
      color: '#f8fafc',
      align: 'left',
      bold: true,
      maxWidth: 1800,
    },
  ];
  let textY = 188;
  for (const line of lines.flatMap((line) => wrapMenuLine(line)).slice(0, 12)) {
    ops.push({
      op: 'text',
      text: line,
      x: 88,
      y: textY,
      size: 34,
      color: '#d5deea',
      align: 'left',
      bold: false,
      maxWidth: 1860,
    });
    textY += 46;
  }
  for (const button of buttons) {
    ops.push({
      op: 'roundRect',
      x: button.x,
      y: button.y,
      width: button.width,
      height: button.height,
      radius: 28,
      color: buttonFill[button.action],
    });
    ops.push({
      op: 'text',
      text: button.label,
      x: button.x + button.width / 2,
      y: button.y + (button.height - 60) / 2,
      size: 60,
      color: '#f8fafc',
      align: 'center',
      bold: true,
      maxWidth: button.width - 48,
    });
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
