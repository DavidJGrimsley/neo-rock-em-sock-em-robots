// The headset menu as an OpenXR quad layer, adapted from the Medical Viewer
// compositor controls. modules/quest-panel draws the compact menu card ops and
// the floating transparent title overlay ops with Android Canvas, and the patched
// renderer (tools/quest/viro-renderer/0002) submits the card under the projection
// layer (revealed through a depth-writing zero-alpha mask) and the transparent
// title over the scene.
//
// One owner token per slot per scene. Only a changed spec is sent; the native
// worker keeps only the newest and moves shown pixels when only the pose changed.

import { menuFrame, type Calibration, type Vec3 } from './quest-head-rig.ts';
import {
  QUEST_MENU_ALERT_SHIFT_M,
  QUEST_MENU_ALERT_SIZE,
  QUEST_MENU_CARD_RADIUS_PX,
  QUEST_MENU_POSE,
  QUEST_MENU_SIZE,
  QUEST_MENU_TEXTURE,
  QUEST_TITLE_POSE,
  type QuestMenuDrawOp,
  type QuestMenuPage,
} from './quest-menu-layout.ts';

export const QUEST_MENU_LAYER_FIRST_SHOW_MS = 2000;
const PENDING_POLL_MS = 100;
const IDLE_POLL_MS = 1000;

/** [x, y, z, qx, qy, qz, qw] in the Viro world, which is the OpenXR space both layers use. */
export type QuestPanelPose = [number, number, number, number, number, number, number];

function worldPoseFromLocal(
  cal: Calibration,
  local: {
    position: readonly [number, number, number];
    rotation: readonly [number, number, number];
  },
  extraY = 0
) {
  const frame = menuFrame(cal);
  const r = (frame.rotationY * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const [lx, ly, lz] = local.position;
  const position: Vec3 = [
    frame.position[0] + lx * cos + lz * sin,
    frame.position[1] + ly + extraY,
    frame.position[2] - lx * sin + lz * cos,
  ];
  const yaw = frame.rotationY + local.rotation[1];
  const half = (yaw * Math.PI) / 360;
  const pose: QuestPanelPose = [...position, 0, Math.sin(half), 0, Math.cos(half)];
  return { position, yaw, pose };
}

/**
 * The compact button card centre and orientation built from menuFrame(cal) and
 * QUEST_MENU_POSE[page]. When alert/error lines expand the card upward, its
 * centre shifts up by QUEST_MENU_ALERT_SHIFT_M so button positions stay fixed.
 */
export function questMenuPanelPose(cal: Calibration, page: QuestMenuPage, hasMessages = false) {
  return worldPoseFromLocal(cal, QUEST_MENU_POSE[page], hasMessages ? QUEST_MENU_ALERT_SHIFT_M : 0);
}

/**
 * The floating transparent branded title centre and orientation built from
 * menuFrame(cal) and QUEST_TITLE_POSE[page].
 */
export function questMenuTitlePose(cal: Calibration, page: QuestMenuPage) {
  return worldPoseFromLocal(cal, QUEST_TITLE_POSE[page]);
}

export interface QuestMenuPanelFrame {
  /** Short description for logs, for example "ring ack=false standing". */
  label: string;
  pose: readonly number[];
  ops: QuestMenuDrawOp[];
  widthPx?: number;
  heightPx?: number;
  widthM?: number;
  heightM?: number;
  viewLocked?: boolean;
}

const round = (value: number) => Math.round(value * 1e5) / 1e5 || 0;

/** The JSON QuestPanelModule draws: pixel size, metre size, pose and ops. */
export function questMenuPanelSpec(frame: QuestMenuPanelFrame) {
  return JSON.stringify({
    label: frame.label,
    widthPx: frame.widthPx ?? QUEST_MENU_TEXTURE.widthPx,
    heightPx: frame.heightPx ?? QUEST_MENU_TEXTURE.heightPx,
    widthM: frame.widthM ?? QUEST_MENU_SIZE.widthM,
    heightM: frame.heightM ?? QUEST_MENU_SIZE.heightM,
    pose: frame.pose.map(round),
    ...(frame.viewLocked ? { viewLocked: true } : {}),
    ops: frame.ops,
  });
}

function roundedMaskFragment(widthM: number, heightM: number, widthPx: number) {
  const radiusM = Math.round((QUEST_MENU_CARD_RADIUS_PX / widthPx) * widthM * 1e5) / 1e5;
  const halfW = widthM / 2;
  const halfH = heightM / 2;
  return [
    `vec2 p = abs(v_texcoord - 0.5) * vec2(${widthM}, ${heightM});`,
    `vec2 q = p - (vec2(${halfW}, ${halfH}) - vec2(${radiusM}));`,
    `float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - ${radiusM};`,
    'if (dist > -0.0015) discard;',
    '_output_color = vec4(0.0);',
  ].join(' ');
}

// Rounded-rect SDF in panel metres so the four corners and anti-aliased edge
// discard instead of punching black holes into the 3D scene behind the card.
export const QUEST_MENU_LAYER_MASK_FRAGMENT = roundedMaskFragment(
  QUEST_MENU_SIZE.widthM,
  QUEST_MENU_SIZE.heightM,
  QUEST_MENU_TEXTURE.widthPx
);

export const QUEST_MENU_ALERT_LAYER_MASK_FRAGMENT = roundedMaskFragment(
  QUEST_MENU_ALERT_SIZE.widthM,
  QUEST_MENU_ALERT_SIZE.heightM,
  QUEST_MENU_TEXTURE.widthPx
);

function maskMaterial(fragment: string) {
  return {
    lightingModel: 'Constant' as const,
    blendMode: 'None' as const,
    diffuseColor: '#00000000',
    writesToDepthBuffer: true,
    readsFromDepthBuffer: true,
    cullMode: 'None' as const,
    shaderModifiers: { fragment },
  };
}

/**
 * Viro materials for the layer. Unlike the Medical Viewer passthrough mask,
 * colour writes stay on: the fully virtual eye buffer clears to opaque black,
 * so the mask must write alpha 0 for the layer underneath to show, while
 * discarding outside the rounded card corners so the arena/skybox stays intact.
 */
export function questMenuLayerMaterials() {
  return {
    questMenuLayerMask: maskMaterial(QUEST_MENU_LAYER_MASK_FRAGMENT),
    questMenuLayerMaskAlert: maskMaterial(QUEST_MENU_ALERT_LAYER_MASK_FRAGMENT),
    // Hover outline drawn by Viro, so pointing never redraws the panel.
    questMenuFocus: {
      lightingModel: 'Constant' as const,
      diffuseColor: '#f8fafc',
      writesToDepthBuffer: false,
      readsFromDepthBuffer: true,
      cullMode: 'None' as const,
    },
  };
}

export type QuestMenuLayerMode =
  | 'pending' // drawn, waiting for the renderer to submit it
  | 'shown'
  | 'slow' // not submitted yet after the first-show timeout; Viro buttons meanwhile
  | 'failed'
  | 'unavailable' // renderer without the menu layer
  | 'off'; // Viro buttons chosen on the launcher panel

export interface QuestMenuLayerSnapshot {
  mode: QuestMenuLayerMode;
  reason: string | null;
}

/** The layer draws the panel; otherwise the scene draws Viro buttons and text. */
export function questMenuLayerVisible(mode: QuestMenuLayerMode) {
  return mode === 'pending' || mode === 'shown';
}

export function questMenuLayerNotice(snapshot: QuestMenuLayerSnapshot) {
  switch (snapshot.mode) {
    case 'off':
      return 'Viro menu buttons (chosen on the launcher panel).';
    case 'unavailable':
      return 'Viro menu buttons: this build has no headset menu layer.';
    case 'slow':
      return 'The headset menu layer has not appeared yet.';
    case 'failed':
      return `The headset menu layer failed: ${snapshot.reason ?? 'unknown'}.`;
    default:
      return '';
  }
}

export interface QuestPanelBackend {
  available(): boolean;
  open(): number;
  draw(owner: number, specJson: string): void;
  invalidate?(owner: number): void;
  status(owner: number): number;
  hide(owner: number): void;
  log(level: 'info' | 'error', message: string): void;
}

interface Clock {
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
  now: () => number;
}

const defaultClock: Clock = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createQuestMenuCompositor(
  backend: QuestPanelBackend,
  options: { enabled?: boolean; clock?: Clock; firstShowTimeoutMs?: number } = {}
) {
  const clock = options.clock ?? defaultClock;
  const firstShowTimeoutMs = options.firstShowTimeoutMs ?? QUEST_MENU_LAYER_FIRST_SHOW_MS;
  const listeners = new Set<() => void>();
  let owner: number | null = null;
  let lastSpec: string | null = null;
  let lastFrame: QuestMenuPanelFrame | null = null;
  let firstDrawAt: number | null = null;
  let timer: unknown = null;
  let disposed = false;

  let available = false;
  if (options.enabled !== false) {
    try {
      available = backend.available();
    } catch {
      available = false;
    }
  }
  let snapshot: QuestMenuLayerSnapshot = {
    mode: options.enabled === false ? 'off' : available ? 'pending' : 'unavailable',
    reason: null,
  };

  const set = (mode: QuestMenuLayerMode, reason: string | null = null) => {
    if (snapshot.mode === mode && snapshot.reason === reason) return;
    snapshot = { mode, reason };
    for (const listener of listeners) listener();
  };

  const cancelPoll = () => {
    if (timer !== null) clock.cancel(timer);
    timer = null;
  };

  const release = () => {
    cancelPoll();
    if (owner === null) return;
    const id = owner;
    owner = null;
    try {
      backend.hide(id);
    } catch (error) {
      backend.log('error', `layer hide failed: ${describe(error)}`);
    }
  };

  // Sticky for this scene: a failed layer is hidden and Viro buttons take over.
  const fail = (reason: string) => {
    if (disposed || snapshot.mode === 'failed') return;
    release();
    backend.log('error', `layer failed: ${reason}`);
    set('failed', reason);
  };

  const poll = () => {
    timer = null;
    if (disposed || owner === null) return;
    let status: number;
    try {
      status = backend.status(owner);
    } catch (error) {
      fail(`status ${describe(error)}`);
      return;
    }
    const waited = firstDrawAt === null ? 0 : clock.now() - firstDrawAt;
    if (status < 0) {
      fail(`renderer status ${status}`);
      return;
    }
    if (status === 1 && snapshot.mode !== 'shown') {
      backend.log('info', `layer shown after ${waited} ms`);
      set('shown');
    } else if (status !== 1 && snapshot.mode === 'pending' && waited >= firstShowTimeoutMs) {
      backend.log('error', `layer not shown after ${waited} ms; Viro buttons until it appears`);
      set('slow');
    }
    schedule();
  };

  const schedule = () => {
    if (disposed || owner === null || timer !== null) return;
    timer = clock.schedule(poll, snapshot.mode === 'shown' ? IDLE_POLL_MS : PENDING_POLL_MS);
  };

  const present = (frame: QuestMenuPanelFrame) => {
    if (disposed) return;
    if (snapshot.mode !== 'pending' && snapshot.mode !== 'shown' && snapshot.mode !== 'slow') {
      return;
    }
    const spec = questMenuPanelSpec(frame);
    if (spec === lastSpec) return;
    if (owner === null) {
      try {
        owner = backend.open();
      } catch (error) {
        fail(`open ${describe(error)}`);
        return;
      }
    }
    lastSpec = spec;
    try {
      backend.draw(owner, spec);
    } catch (error) {
      fail(`draw ${describe(error)}`);
      return;
    }
    lastFrame = frame;
    if (firstDrawAt === null) firstDrawAt = clock.now();
    backend.log('info', `layer draw ${frame.label}`);
    schedule();
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getOwner: () => owner,
    /** Sends the panel when it differs from the last one sent. */
    present,
    /** Forces a re-upload of the last drawn panel on the current owner (e.g. after XR resume). */
    replay() {
      if (disposed || owner === null || !lastFrame) return;
      if (snapshot.mode !== 'pending' && snapshot.mode !== 'shown' && snapshot.mode !== 'slow') {
        return;
      }
      try {
        backend.invalidate?.(owner);
      } catch (error) {
        fail(`invalidate ${describe(error)}`);
        return;
      }
      lastSpec = null;
      present(lastFrame);
    },
    /** Clears cached active frame and hides the compositor layer cleanly. */
    hide() {
      lastFrame = null;
      lastSpec = null;
      if (disposed || owner === null) return;
      release();
      firstDrawAt = null;
      if (snapshot.mode === 'shown' || snapshot.mode === 'slow') set('pending');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lastFrame = null;
      lastSpec = null;
      release();
      listeners.clear();
    },
  };
}

export type QuestMenuCompositor = ReturnType<typeof createQuestMenuCompositor>;
