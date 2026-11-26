import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { Asset } from 'expo-asset';
import {
  Viro3DObject,
  ViroAmbientLight,
  ViroDirectionalLight,
  ViroGameLoop,
  ViroGameLoopUtils,
  ViroMaterials,
  ViroNode,
  ViroQuad,
  ViroScene,
  ViroSkyBox,
  ViroText,
} from '@reactvision/react-viro';

import {
  ARENA_LAYOUT,
  type FighterId,
  type FighterTransform,
} from '../arena-fighter/arena-controller.ts';

import { questInputNative, questRigSyncAvailable } from '../../../modules/quest-input/src/index.ts';
import { questPanelAvailable, questPanelNative } from '../../../modules/quest-panel/src/index.ts';
import { createQuestArenaSession, type QuestArenaSession } from './quest-arena-session.ts';
import {
  placeQuestFirstPersonArms,
  QUEST_FIRST_PERSON_ARM_SCALE,
  type QuestArmBody,
} from './quest-first-person-arms.ts';
import type { QuestFirstPersonBodyClip } from './quest-first-person-body.ts';
import {
  QUEST_INTRO_COVER_DISTANCE_M,
  menuFrame,
  questHeadCoverPose,
  questIntroRig,
  stanceMarkerRingLocal,
  wrap180,
  type Calibration,
  type RigAnchor,
} from './quest-head-rig.ts';
import { questHeadTracker } from './quest-head-tracker.ts';
import type { QuestInputSample } from './quest-input.ts';
import {
  createSceneQuestInputSource,
  QuestDiagnosticsPanel,
  QuestInputMarkers,
} from './quest-input-visualizer.native.tsx';
import { questDiagLayerMaterials } from './quest-diagnostics-layout.ts';
import {
  buildQuestCombatHud,
  questCombatHudViewPose,
  type QuestCombatHudState,
} from './quest-combat-hud.ts';
import { useQuestArenaAudio } from './quest-arena-audio.native.ts';
import { QUEST_TUNING, type QuestUserSettings } from './quest-tuning.ts';
import {
  createQuestMenuCompositor,
  questMenuLayerMaterials,
  questMenuLayerNotice,
  questMenuLayerVisible,
  questMenuPanelPose,
  questMenuTitlePose,
  type QuestMenuLayerSnapshot,
} from './quest-menu-compositor.ts';
import { questMenuFileUri, resolveQuestMenuAssetFile } from './quest-menu-asset-uri.ts';
import { questPointerHover, questTriggerPress, type QuestPressState } from './quest-menu-input.ts';
import { questMenuLayer } from './quest-menu-layer.ts';
import {
  QUEST_MENU_ALERT_SHIFT_M,
  QUEST_MENU_POSE,
  QUEST_TITLE_POSE,
  QUEST_TITLE_SIZE,
  QUEST_TITLE_TEXTURE,
  buildQuestMenu,
  buildQuestMenuTitle,
  questMenuButtonFrame,
  questMenuButtons,
  questMenuCardMetrics,
  type QuestMenuAction,
  type QuestMenuButton,
  type QuestMenuFonts,
  type QuestMenuPage,
  type QuestMenuPosture,
  type QuestMenuTitles,
} from './quest-menu-layout.ts';
import { questRuntime } from './quest-runtime-store.ts';

const sources = {
  // Metro packages binary assets through static require calls.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  arena: require('../../../assets/arena/Fight_Arena.glb'),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  blue: require('../../../assets/arena/Mike_Player1_Blue_Combat_AR.glb'),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  red: require('../../../assets/arena/Mike_Player2_RedOrange_Combat_AR.glb'),
};

const previewSources = {
  // Quest-only extracts. The phone scene keeps the original Combat GLBs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  body: require('../../../assets/arena/quest/quest-blue-body.glb'),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  upperLeft: require('../../../assets/arena/quest/quest-blue-upper-left.glb'),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  upperRight: require('../../../assets/arena/quest/quest-blue-upper-right.glb'),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  forearmLeft: require('../../../assets/arena/quest/quest-blue-forearm-left.glb'),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  forearmRight: require('../../../assets/arena/quest/quest-blue-forearm-right.glb'),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  handLeft: require('../../../assets/arena/quest/quest-blue-hand-left.glb'),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  handRight: require('../../../assets/arena/quest/quest-blue-hand-right.glb'),
};

const menuFontModules = {
  body: require('../../../assets/arena/ui/ArenaNotoSans.ttf') as number,
  button: require('../../../assets/arena/ui/ArenaNotoSansSemibold.ttf') as number,
};

const menuTitleModules = {
  neo: require('../../../assets/arena/ui/quest-lettering/neo.png') as number,
  rock: require('../../../assets/arena/ui/quest-lettering/rock.png') as number,
  robots: require('../../../assets/arena/ui/quest-lettering/robots.png') as number,
};

function initialAssetRef(moduleId: number): string | null {
  try {
    const asset = Asset.fromModule(moduleId);
    const direct = questMenuFileUri(asset.localUri) ?? questMenuFileUri(asset.uri);
    if (direct) return direct;
    // Release Android builds embed TTFs/PNGs as resources with a bare resource name.
    if (asset.uri && !asset.uri.includes(':') && !asset.uri.includes('/')) return asset.uri;
  } catch {
    // Fallback to text/system typeface in QuestPanelModule if asset lookup fails.
  }
  return null;
}

const fighterScale: [number, number, number] = Array(3).fill(ARENA_LAYOUT.fighterScale) as [
  number,
  number,
  number,
];
const previewHandScale: [number, number, number] = [
  QUEST_FIRST_PERSON_ARM_SCALE,
  QUEST_FIRST_PERSON_ARM_SCALE,
  QUEST_FIRST_PERSON_ARM_SCALE,
];
const unitScale: [number, number, number] = [1, 1, 1];
const handInitialPosition: Vec3Tuple = [0, 0, 0];
const introCoverPosition: Vec3Tuple = [0, 0, -QUEST_INTRO_COVER_DISTANCE_M];
const introCoverMaterials = ['questIntroCover'];
const introCoverSize = 3;
const arenaScale: [number, number, number] = [
  ARENA_LAYOUT.arenaScale * ARENA_LAYOUT.arenaHorizontalScale,
  ARENA_LAYOUT.arenaScale,
  ARENA_LAYOUT.arenaScale * ARENA_LAYOUT.arenaHorizontalScale,
];
const fighterY = ARENA_LAYOUT.floorHeight + ARENA_LAYOUT.footOffset;
const stanceRingSize = 0.06;
const stanceRingThickness = 0.004;
const stanceRingHalf = (stanceRingSize - stanceRingThickness) / 2;
const stanceRingLift = 0.0005;
const idleAnimation = { name: 'IdleAggro', loop: true, run: true, interruptible: true };
const bodyIdleAnimation = { name: 'IdleAggro', loop: true, run: false, interruptible: true };
const LOOPING_CLIPS = new Set([
  'Idle',
  'IdleAggro',
  'WalkForward',
  'WalkBackward',
  'StrafeLeft',
  'StrafeRight',
  'Run',
  'RunFast',
  'DefeatedLoop',
  'BlockHold',
  'BlockAdvance',
  'BlockStrafeLeft',
  'BlockStrafeRight',
]);
const systemRecenterHint = 'Hold Meta button to recenter view.';
// Panel-local depths: the layer mask at 0, hover outline, then hit targets (0.012).
const focusZ = 0.008;
const focusThickness = 0.008;
const focusPad = 0.006;

// Colour-only materials have no texture to decode, so they register at import
// long before the scene mounts.
ViroMaterials.createMaterials({
  questMenuBacking: { diffuseColor: '#0f172a', lightingModel: 'Constant' },
  questRingFloor: { diffuseColor: '#1f2937', lightingModel: 'Constant' },
  questStanceRing: { diffuseColor: '#38bdf8', lightingModel: 'Constant' },
  questStanceRingOutOfBounds: { diffuseColor: '#f59e0b', lightingModel: 'Constant' },
  // Stock Viro 3.0.3 reads colorWriteMask. The OpenXR per-eye clear can reset GL
  // colour writes, so the fragment also writes zero alpha, and Alpha blending
  // turns that into no change. With passthrough off, blendMode None would paint
  // the zero as opaque black. Hits are geometric, not pixels.
  questMenuHit: {
    lightingModel: 'Constant',
    blendMode: 'Alpha',
    diffuseColor: '#00000000',
    writesToDepthBuffer: false,
    cullMode: 'None',
    colorWriteMask: ['None'],
    shaderModifiers: { fragment: '_output_color = vec4(0.0);' },
  } as never,
  ...questMenuLayerMaterials(),
  ...questDiagLayerMaterials(),
  questMenuFallbackPrimary: { diffuseColor: '#60a5fa', lightingModel: 'Constant' },
  questMenuFallbackDanger: { diffuseColor: '#d99a9a', lightingModel: 'Constant' },
  questMenuFallbackBack: { diffuseColor: '#1e293b', lightingModel: 'Constant' },
  questMenuFallbackPosture: { diffuseColor: '#334155', lightingModel: 'Constant' },
  // Black blink in front of the tracked head. It does not write or test depth, or turn the headset.
  questIntroCover: {
    diffuseColor: '#000000',
    lightingModel: 'Constant',
    blendMode: 'Alpha',
    cullMode: 'None',
    readsFromDepthBuffer: false,
    writesToDepthBuffer: false,
  },
  // VR-safe peripheral damage edge vignette (never occludes center FOV).
  questDamageTint: {
    diffuseColor: '#dc2626',
    lightingModel: 'Constant',
    blendMode: 'Alpha',
    cullMode: 'None',
    readsFromDepthBuffer: false,
    writesToDepthBuffer: false,
  },
});

// The medical viewer's headset text: scale 0.05 with the box in scaled units.
// A 28 pt string on an unscaled metre box clipped to "Menu" on a Quest 3S.
const TEXT_SCALE = 0.05;
const textScale: [number, number, number] = [TEXT_SCALE, TEXT_SCALE, TEXT_SCALE];
const messageStyle = {
  fontFamily: 'ArenaNotoSans',
  fontSize: 18,
  color: '#f8fafc',
  textAlign: 'center',
  textAlignVertical: 'center',
} as const;
const labelStyle = { ...messageStyle, fontFamily: 'ArenaNotoSansSemibold', fontSize: 28 } as const;
const fallbackTitleNeoStyle = {
  ...labelStyle,
  fontSize: 34,
  color: '#a78bfa',
} as const;
const fallbackTitleMainStyle = {
  ...labelStyle,
  fontSize: 44,
  color: '#60a5fa',
} as const;

function fallbackMaterial(action: QuestMenuAction) {
  if (action === 'exit') return 'questMenuFallbackDanger';
  if (action === 'back') return 'questMenuFallbackBack';
  if (action === 'posture') return 'questMenuFallbackPosture';
  return 'questMenuFallbackPrimary';
}

function logMenu(level: 'info' | 'error', message: string) {
  // console.warn and console.error reach logcat as ReactNativeJS in release.
  if (level === 'error') console.error(`QuestMenu ${message}`);
  else console.warn(`QuestMenu ${message}`);
}

function leave(session: QuestArenaSession) {
  session.exit();
  questRuntime.exitRequested('scene-exit');
  questPanelNative?.exitApp?.();
}

const fmtVec = (v: readonly number[]) => `[${v.map((n) => n.toFixed(3)).join(',')}]`;

type Vec3Tuple = [number, number, number];

interface InitialRingPose {
  key: string;
  rigPosition: Vec3Tuple;
  rigRotation: Vec3Tuple;
  rigScale: Vec3Tuple;
  stancePosition: Vec3Tuple;
  stanceRotation: Vec3Tuple;
  bluePosition: Vec3Tuple;
  blueRotation: Vec3Tuple;
  redPosition: Vec3Tuple;
  redRotation: Vec3Tuple;
}

interface SyncedTransformCache {
  presentation?: 'menu' | 'side' | 'eyes';
  calYaw?: number;
  rigOuterNode?: ViroNode | null;
  rigPosition?: Vec3Tuple;
  rigRotationY?: number;
  lastRigJumpWarnAt?: number;
  stanceRingNode?: ViroNode | null;
  stancePosition?: Vec3Tuple;
  stanceYaw?: number;
  blueNode?: ViroNode | null;
  blue?: FighterTransform;
  redNode?: ViroNode | null;
  red?: FighterTransform;
}

function sameVec3(a: readonly number[] | undefined, b: readonly number[]) {
  return !!a && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function setNativeNodeProps(node: unknown, props: Record<string, unknown>) {
  (
    node as { setNativeProps?: (nextProps: Record<string, unknown>) => void } | null
  )?.setNativeProps?.(props);
}

/** Dispatches transform commands without triggering Fabric shadow-tree commits or VRT3DObject reloads. */
function pushNodeTransform(
  nodeRef: RefObject<ViroNode | null>,
  position: Vec3Tuple | null,
  rotation: Vec3Tuple | null
) {
  const node = nodeRef.current;
  if (!node) return;
  if (
    typeof ViroGameLoopUtils?.setPosition === 'function' &&
    typeof ViroGameLoopUtils?.setRotation === 'function'
  ) {
    if (position) ViroGameLoopUtils.setPosition(nodeRef, position);
    if (rotation) ViroGameLoopUtils.setRotation(nodeRef, rotation);
    return;
  }
  setNativeNodeProps(node, {
    ...(position ? { position } : {}),
    ...(rotation ? { rotation } : {}),
  });
}

function pushNodeScale(nodeRef: RefObject<ViroNode | null>, scale: Vec3Tuple) {
  const node = nodeRef.current;
  if (!node) return;
  if (typeof ViroGameLoopUtils?.setScale === 'function') {
    ViroGameLoopUtils.setScale(nodeRef, scale);
    return;
  }
  setNativeNodeProps(node, { scale });
}

function writeFighterAnimation(
  model: Viro3DObject | null,
  animation: { name: string; loop: boolean; run: boolean; interruptible: boolean }
) {
  setNativeNodeProps(model, { animation });
}

function QuestViewHudFallback({ children }: { children: React.ReactNode }) {
  const node = useRef<ViroNode | null>(null);
  useEffect(() => {
    let visible = false;
    const sync = () => {
      const head = questHeadTracker.getLiveHeadState?.();
      const pose =
        head?.sample && !head.recentering
          ? questHeadCoverPose(head.sample, -QUEST_TUNING.hud.position[2])
          : null;
      if (pose) pushNodeTransform(node, [...pose.position], [...pose.rotation]);
      if (visible !== Boolean(pose)) {
        visible = Boolean(pose);
        setNativeNodeProps(node.current, { visible });
      }
    };
    sync();
    return questHeadTracker.subscribeLive?.(sync);
  }, []);
  return (
    <ViroNode ref={node} visible={false} ignoreEventHandling>
      <ViroNode
        position={[0, QUEST_TUNING.hud.position[1], 0]}
        rotation={[QUEST_TUNING.hud.pitchDeg, 0, 0]}
        ignoreEventHandling>
        {children}
      </ViroNode>
    </ViroNode>
  );
}

function scheduleAnimationFrame(callback: () => void): unknown {
  return typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame(callback)
    : setTimeout(callback, 16);
}

function cancelScheduledAnimationFrame(handle: unknown) {
  if (typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(handle as number);
    return;
  }
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

interface RingNodeRefs {
  rigOuter: RefObject<ViroNode | null>;
  stanceRing: RefObject<ViroNode | null>;
  blueNode: RefObject<ViroNode | null>;
  redNode: RefObject<ViroNode | null>;
}

const QUEST_RIG_MAX_STEP_EXTRAP_M = 0.25;
const QUEST_RIG_MAX_YAW_STEP_EXTRAP_DEG = 30;

function stanceCenterForPresentation(
  anchor: RigAnchor,
  presentation: 'menu' | 'side' | 'eyes'
): readonly [number, number, number] {
  return presentation === 'side'
    ? [anchor.x, ARENA_LAYOUT.floorHeight, anchor.z]
    : stanceMarkerRingLocal(anchor);
}

function publishQuestRigState(
  session: QuestArenaSession,
  cache: SyncedTransformCache,
  dtSeconds: number,
  allowExtrapolation: boolean
) {
  const live = session.getLiveTransforms();
  if (!live) return;
  const cal =
    questHeadTracker.getLiveHeadState?.().calibration ?? questHeadTracker.getSnapshot().calibration;
  const snap = session.getSnapshot();
  const anchor: RigAnchor = { x: live.blue.x, z: live.blue.z, yaw: live.blue.yaw };
  const rig = questIntroRig(cal, anchor, session.getRigBlend());
  const stanceCenter = stanceCenterForPresentation(anchor, snap.presentation);
  const stancePosition: Vec3Tuple = [
    stanceCenter[0],
    stanceCenter[1] + stanceRingLift,
    stanceCenter[2],
  ];

  const calTurnJump = cache.calYaw !== undefined && Math.abs(wrap180(cal.yaw - cache.calYaw)) >= 5;
  const canDifferentiate =
    allowExtrapolation &&
    !calTurnJump &&
    (snap.stage === 'fighting' || snap.introActive) &&
    cache.presentation === snap.presentation &&
    dtSeconds > 1e-4 &&
    dtSeconds <= 0.1 &&
    cache.rigPosition !== undefined &&
    cache.rigRotationY !== undefined &&
    cache.stancePosition !== undefined &&
    cache.stanceYaw !== undefined &&
    cache.red !== undefined &&
    cache.blue !== undefined;

  let rigVx = 0;
  let rigVy = 0;
  let rigVz = 0;
  let rigYawRate = 0;
  let stanceVx = 0;
  let stanceVy = 0;
  let stanceVz = 0;
  let stanceYawRate = 0;
  let redVx = 0;
  let redVy = 0;
  let redVz = 0;
  let redYawRate = 0;
  let blueVx = 0;
  let blueVy = 0;
  let blueVz = 0;
  let blueYawRate = 0;

  if (canDifferentiate) {
    const prevRig = cache.rigPosition!;
    const prevStance = cache.stancePosition!;
    const prevRed = cache.red!;
    const prevBlue = cache.blue!;

    const rigDx = rig.position[0] - prevRig[0];
    const rigDy = rig.position[1] - prevRig[1];
    const rigDz = rig.position[2] - prevRig[2];
    const rigDyaw = wrap180(rig.rotationY - cache.rigRotationY!);

    const stanceDx = stancePosition[0] - prevStance[0];
    const stanceDy = stancePosition[1] - prevStance[1];
    const stanceDz = stancePosition[2] - prevStance[2];
    const stanceDyaw = wrap180(anchor.yaw - cache.stanceYaw!);

    const redDx = live.red.x - prevRed.x;
    const redDy = live.red.lift - prevRed.lift;
    const redDz = live.red.z - prevRed.z;
    const redDyaw = wrap180(live.red.yaw - prevRed.yaw);

    const blueDx = live.blue.x - prevBlue.x;
    const blueDy = live.blue.lift - prevBlue.lift;
    const blueDz = live.blue.z - prevBlue.z;
    const blueDyaw = wrap180(live.blue.yaw - prevBlue.yaw);

    const continuous =
      Math.hypot(rigDx, rigDy, rigDz) <= QUEST_RIG_MAX_STEP_EXTRAP_M &&
      Math.hypot(stanceDx, stanceDy, stanceDz) <= QUEST_RIG_MAX_STEP_EXTRAP_M &&
      Math.hypot(redDx, redDy, redDz) <= QUEST_RIG_MAX_STEP_EXTRAP_M &&
      Math.hypot(blueDx, blueDy, blueDz) <= QUEST_RIG_MAX_STEP_EXTRAP_M &&
      Math.abs(rigDyaw) <= QUEST_RIG_MAX_YAW_STEP_EXTRAP_DEG &&
      Math.abs(stanceDyaw) <= QUEST_RIG_MAX_YAW_STEP_EXTRAP_DEG &&
      Math.abs(redDyaw) <= QUEST_RIG_MAX_YAW_STEP_EXTRAP_DEG &&
      Math.abs(blueDyaw) <= QUEST_RIG_MAX_YAW_STEP_EXTRAP_DEG;

    if (continuous) {
      const invDt = 1 / dtSeconds;
      rigVx = rigDx * invDt;
      rigVy = rigDy * invDt;
      rigVz = rigDz * invDt;
      rigYawRate = rigDyaw * invDt;
      stanceVx = stanceDx * invDt;
      stanceVy = stanceDy * invDt;
      stanceVz = stanceDz * invDt;
      stanceYawRate = stanceDyaw * invDt;
      redVx = redDx * invDt;
      redVy = redDy * invDt;
      redVz = redDz * invDt;
      redYawRate = redDyaw * invDt;
      blueVx = blueDx * invDt;
      blueVy = blueDy * invDt;
      blueVz = blueDz * invDt;
      blueYawRate = blueDyaw * invDt;
    }
  }

  questInputNative?.publishRigState?.(true, [
    rig.position[0],
    rig.position[1],
    rig.position[2],
    rigVx,
    rigVy,
    rigVz,
    rig.rotationY,
    rigYawRate,
    stancePosition[0],
    stancePosition[1],
    stancePosition[2],
    stanceVx,
    stanceVy,
    stanceVz,
    anchor.yaw,
    stanceYawRate,
    live.red.x,
    fighterY + live.red.lift,
    live.red.z,
    redVx,
    redVy,
    redVz,
    live.red.yaw,
    redYawRate,
    live.blue.x,
    fighterY + live.blue.lift,
    live.blue.z,
    blueVx,
    blueVy,
    blueVz,
    live.blue.yaw,
    blueYawRate,
  ]);

  cache.presentation = snap.presentation;
  cache.calYaw = cal.yaw;
  cache.rigPosition = [...rig.position];
  cache.rigRotationY = rig.rotationY;
  cache.stancePosition = stancePosition;
  cache.stanceYaw = anchor.yaw;
  cache.red = { ...live.red };
  cache.blue = { ...live.blue };
}

function syncQuestRingTransforms(
  session: QuestArenaSession,
  nodes: RingNodeRefs,
  cache: SyncedTransformCache,
  rigSyncActive = false,
  dtSeconds = 0,
  allowExtrapolation = false
) {
  if (rigSyncActive) {
    publishQuestRigState(session, cache, dtSeconds, allowExtrapolation);
    return;
  }
  const live = session.getLiveTransforms();
  if (!live) return;
  const cal =
    questHeadTracker.getLiveHeadState?.().calibration ?? questHeadTracker.getSnapshot().calibration;
  const anchor: RigAnchor = { x: live.blue.x, z: live.blue.z, yaw: live.blue.yaw };
  const rig = questIntroRig(cal, anchor, session.getRigBlend());
  const stanceCenter = stanceCenterForPresentation(anchor, session.getSnapshot().presentation);
  const stancePosition: Vec3Tuple = [
    stanceCenter[0],
    stanceCenter[1] + stanceRingLift,
    stanceCenter[2],
  ];

  const rigOuterNode = nodes.rigOuter.current;
  if (rigOuterNode) {
    const sameNode = cache.rigOuterNode === rigOuterNode;
    const rigPosChanged = !sameNode || !sameVec3(cache.rigPosition, rig.position);
    const rigRotChanged = !sameNode || cache.rigRotationY !== rig.rotationY;
    if (rigPosChanged || rigRotChanged) {
      if (sameNode && cache.rigPosition) {
        const stepDist = Math.hypot(
          rig.position[0] - cache.rigPosition[0],
          rig.position[1] - cache.rigPosition[1],
          rig.position[2] - cache.rigPosition[2]
        );
        const yawStep =
          cache.rigRotationY === undefined
            ? 0
            : Math.abs(wrap180(rig.rotationY - cache.rigRotationY));
        if (stepDist > 0.25 || yawStep > 5) {
          const nowMs = Date.now();
          if (!cache.lastRigJumpWarnAt || nowMs - cache.lastRigJumpWarnAt >= 1000) {
            cache.lastRigJumpWarnAt = nowMs;
            console.warn(
              `[QuestRing] rigStep dist=${stepDist.toFixed(3)}m yaw=${yawStep.toFixed(1)}deg rot=${rig.rotationY.toFixed(1)} anchor=${anchor.x.toFixed(4)},${anchor.z.toFixed(4)}`
            );
          }
        }
      }
      pushNodeTransform(
        nodes.rigOuter,
        rigPosChanged ? [...rig.position] : null,
        rigRotChanged ? [0, rig.rotationY, 0] : null
      );
      cache.rigOuterNode = rigOuterNode;
      cache.rigPosition = [...rig.position];
      cache.rigRotationY = rig.rotationY;
    }
  }

  const stanceRingNode = nodes.stanceRing.current;
  if (stanceRingNode) {
    const posChanged =
      cache.stanceRingNode !== stanceRingNode || !sameVec3(cache.stancePosition, stancePosition);
    const yawChanged = cache.stanceRingNode !== stanceRingNode || cache.stanceYaw !== anchor.yaw;
    if (posChanged || yawChanged) {
      pushNodeTransform(
        nodes.stanceRing,
        posChanged ? stancePosition : null,
        yawChanged ? [0, anchor.yaw, 0] : null
      );
      cache.stanceRingNode = stanceRingNode;
      cache.stancePosition = stancePosition;
      cache.stanceYaw = anchor.yaw;
    }
  }

  const syncFighter = (
    id: FighterId,
    nodeRef: RefObject<ViroNode | null>,
    nodeKey: 'blueNode' | 'redNode'
  ) => {
    const node = nodeRef.current;
    if (!node) return;
    const cur = live[id];
    const prev = cache[id];
    const sameNode = cache[nodeKey] === node;
    const posChanged =
      !sameNode || !prev || prev.x !== cur.x || prev.z !== cur.z || prev.lift !== cur.lift;
    const yawChanged = !sameNode || !prev || prev.yaw !== cur.yaw;
    if (posChanged || yawChanged) {
      pushNodeTransform(
        nodeRef,
        posChanged ? [cur.x, fighterY + cur.lift, cur.z] : null,
        yawChanged ? [0, cur.yaw, 0] : null
      );
      cache[nodeKey] = node;
      cache[id] = { ...cur };
    }
  };
  syncFighter('blue', nodes.blueNode, 'blueNode');
  syncFighter('red', nodes.redNode, 'redNode');
}

function QuestFighter({
  id,
  lease,
  token,
  placementVersion,
  session,
  nodeRef,
  modelRef,
  bodyModelRef,
  viroTag,
  initialPosition,
  initialRotation,
  visible = true,
  bodyVisible = false,
}: {
  id: FighterId;
  lease: number;
  token: number | null;
  placementVersion: number | null;
  session: QuestArenaSession;
  nodeRef: RefObject<ViroNode | null>;
  modelRef: RefObject<Viro3DObject | null>;
  bodyModelRef?: RefObject<Viro3DObject | null>;
  viroTag: string;
  initialPosition: Vec3Tuple;
  initialRotation: Vec3Tuple;
  visible?: boolean;
  bodyVisible?: boolean;
}) {
  if (token === null || placementVersion === null) return null;
  // The blue node stays explicitly visible so the headless body can render.
  // Patch 0004 already moves this tag. The original skinned model stays loaded
  // and visible false; the derivative does not take its load lease.
  const nodeVisible = id === 'blue' ? true : visible;
  return (
    <ViroNode
      ref={nodeRef}
      viroTag={viroTag}
      position={initialPosition}
      rotation={initialRotation}
      visible={nodeVisible}>
      <Viro3DObject
        ref={modelRef}
        source={sources[id]}
        type="GLB"
        scale={fighterScale}
        animation={idleAnimation}
        visible={visible}
        // Viro picks the nearest bounding box, so scenery never takes a menu ray.
        ignoreEventHandling
        onLoadEnd={() => session.assetLoaded(lease, token, placementVersion, id)}
        onError={() => session.assetFailed(lease, token, placementVersion, id)}
      />
      {id === 'blue' ? (
        <Viro3DObject
          ref={bodyModelRef}
          source={previewSources.body}
          type="GLB"
          scale={fighterScale}
          animation={bodyIdleAnimation}
          visible={bodyVisible}
          ignoreEventHandling
        />
      ) : null}
    </ViroNode>
  );
}

function eyeArmBody(session: QuestArenaSession): QuestArmBody | null {
  const live = session.getLiveTransforms();
  const calibration = questHeadTracker.getLiveHeadState?.()?.calibration;
  if (!live || !calibration || !Number.isFinite(live.blue.lift)) return null;
  return { calibration, lift: live.blue.lift };
}

const QuestPreviewHands = memo(function QuestPreviewHands({
  source,
  session,
  active,
}: {
  source: {
    onSample: (listener: (sample: QuestInputSample | null) => void) => () => void;
    getLiveState?: () => { nowNs?: number | null };
  };
  session: QuestArenaSession;
  active: boolean;
}) {
  const [nativeFallback, setNativeFallback] = useState(false);
  // Reset derived recovery state during an inactive render, before effects run.
  if (!active && nativeFallback) setNativeFallback(false);
  const leftUpperRef = useRef<ViroNode | null>(null);
  const rightUpperRef = useRef<ViroNode | null>(null);
  const leftForearmRef = useRef<ViroNode | null>(null);
  const rightForearmRef = useRef<ViroNode | null>(null);
  const leftFistRef = useRef<ViroNode | null>(null);
  const rightFistRef = useRef<ViroNode | null>(null);
  useEffect(() => {
    // Patch 0005 owns all six transforms directly on VROOpenXRRender. Only
    // lifecycle crosses JNI; no polling, React, Fabric or renderer queue per pose.
    let nativeHands = false;
    try {
      nativeHands = !nativeFallback && questInputNative?.setHandsEnabled?.(active) === true;
    } catch {
      /* old renderer */
    }
    if (nativeHands) {
      // One bounded readiness check per activation, not per-pose bridge traffic.
      // Missing tags/GLB geometry must not silently lock out the visible ref path.
      const healthTimer =
        active && questInputNative?.handsVisualNodesReady
          ? setTimeout(() => {
              try {
                if (!questInputNative?.handsVisualNodesReady?.()) {
                  console.warn(
                    '[QuestHands] native mesh nodes unavailable; using fresh grip fallback'
                  );
                  setNativeFallback(true);
                }
              } catch {
                setNativeFallback(true);
              }
            }, 1500)
          : null;
      return () => {
        if (healthTimer !== null) clearTimeout(healthTimer);
        questInputNative?.setHandsEnabled?.(false);
        for (const ref of [
          leftUpperRef,
          rightUpperRef,
          leftForearmRef,
          rightForearmRef,
          leftFistRef,
          rightFistRef,
        ]) {
          setNativeNodeProps(ref.current, { opacity: 0, visible: true });
        }
      };
    }
    const nodes = {
      left: { upper: leftUpperRef, forearm: leftForearmRef, fist: leftFistRef },
      right: { upper: rightUpperRef, forearm: rightForearmRef, fist: rightFistRef },
    };
    const transforms = new Map<string, { position: Vec3Tuple; rotation: Vec3Tuple }>();
    const placePart = (
      side: 'left' | 'right',
      part: 'upper' | 'forearm' | 'fist',
      position: readonly number[],
      rotation: readonly number[]
    ) => {
      const key = `${side}:${part}`;
      const previous = transforms.get(key);
      const pos: Vec3Tuple = [position[0], position[1], position[2]];
      const rot: Vec3Tuple = [rotation[0], rotation[1], rotation[2]];
      const positionChanged = !sameVec3(previous?.position, pos);
      const rotationChanged = !sameVec3(previous?.rotation, rot);
      if (!positionChanged && !rotationChanged) return;
      pushNodeTransform(
        nodes[side][part],
        positionChanged ? pos : null,
        rotationChanged ? rot : null
      );
      transforms.set(key, { position: pos, rotation: rot });
    };
    const vis = {
      left: { upper: false, forearm: false, fist: false },
      right: { upper: false, forearm: false, fist: false },
    };
    const scaleZ = {
      left: { upper: Number.NaN, forearm: Number.NaN },
      right: { upper: Number.NaN, forearm: Number.NaN },
    };
    const setPartVisible = (
      side: 'left' | 'right',
      part: 'upper' | 'forearm' | 'fist',
      next: boolean
    ) => {
      if (vis[side][part] === next) return;
      vis[side][part] = next;
      setNativeNodeProps(nodes[side][part].current, { opacity: next ? 1 : 0, visible: true });
    };
    const hideAll = () => {
      for (const side of ['left', 'right'] as const) {
        setPartVisible(side, 'upper', false);
        setPartVisible(side, 'forearm', false);
        setPartVisible(side, 'fist', false);
      }
    };
    if (!active) {
      hideAll();
      return;
    }

    const scheduleFrame =
      typeof globalThis.requestAnimationFrame === 'function'
        ? (cb: () => void) => globalThis.requestAnimationFrame(cb)
        : (cb: () => void) => setTimeout(cb, 16);
    const cancelFrame =
      typeof globalThis.cancelAnimationFrame === 'function'
        ? (handle: unknown) => globalThis.cancelAnimationFrame(handle as number)
        : (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>);

    let pendingSample: QuestInputSample | null = null;
    let hasPending = false;
    let frameHandle: unknown = null;

    const flush = () => {
      frameHandle = null;
      if (!hasPending) return;
      hasPending = false;
      const sample = pendingSample;
      // Recheck age and reference epoch even when no new sequence arrives.
      const head = questHeadTracker.getLiveHeadState?.();
      const frame = placeQuestFirstPersonArms({
        sample,
        headRefEpoch: head?.refEpoch ?? null,
        body: eyeArmBody(session),
        poseSource: 'grip',
        nowNs: source.getLiveState?.().nowNs,
      });
      (['left', 'right'] as const).forEach((side) => {
        const placement = frame[side];
        const refs = nodes[side];
        const showFist = Boolean(placement.visible && placement.position && placement.rotation);
        if (showFist && placement.position && placement.rotation) {
          placePart(side, 'fist', placement.position, placement.rotation);
          setPartVisible(side, 'fist', true);
        } else {
          setPartVisible(side, 'fist', false);
        }
        for (const part of ['upper', 'forearm'] as const) {
          const segment = placement[part];
          if (showFist && segment) {
            placePart(side, part, segment.position, segment.rotation);
            // A previous active effect may have left the mounted node stretched.
            // Always resend the first scale after reactivation, then gate repeats.
            if (
              !Number.isFinite(scaleZ[side][part]) ||
              Math.abs(scaleZ[side][part] - segment.scale[2]) > 1e-4
            ) {
              scaleZ[side][part] = segment.scale[2];
              pushNodeScale(refs[part], [segment.scale[0], segment.scale[1], segment.scale[2]]);
            }
            setPartVisible(side, part, true);
          } else {
            setPartVisible(side, part, false);
          }
        }
      });
    };

    const stopSamples = source.onSample((sample) => {
      pendingSample = sample;
      hasPending = true;
      if (frameHandle === null) {
        frameHandle = scheduleFrame(flush);
      }
    });
    return () => {
      stopSamples();
      hideAll();
      if (frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
    };
  }, [active, session, source, nativeFallback]);
  // Java appearance must stay live; native/imperative opacity gates the roots.
  // visible=false here also hides the GLB child's cached appearance.
  const segment = (sourceId: number, nodeRef: RefObject<ViroNode | null>, tag: string) => (
    <ViroNode
      viroTag={tag}
      ref={nodeRef}
      position={handInitialPosition}
      visible={true}
      opacity={0}
      scale={previewHandScale}>
      <Viro3DObject
        source={sourceId}
        type="GLB"
        scale={unitScale}
        visible={true}
        ignoreEventHandling
      />
    </ViroNode>
  );
  return (
    <>
      {segment(previewSources.upperLeft, leftUpperRef, 'quest-left-upper')}
      {segment(previewSources.upperRight, rightUpperRef, 'quest-right-upper')}
      {segment(previewSources.forearmLeft, leftForearmRef, 'quest-left-forearm')}
      {segment(previewSources.forearmRight, rightForearmRef, 'quest-right-forearm')}
      {segment(previewSources.handLeft, leftFistRef, 'quest-left-fist')}
      {segment(previewSources.handRight, rightFistRef, 'quest-right-fist')}
    </>
  );
});

const QuestIntroCover = memo(function QuestIntroCover({
  session,
  introActive,
}: {
  session: QuestArenaSession;
  introActive: boolean;
}) {
  const nodeRef = useRef<ViroNode | null>(null);
  const quadRef = useRef<ViroQuad | null>(null);
  const visibleRef = useRef(false);

  useEffect(() => {
    if (!introActive && visibleRef.current) {
      visibleRef.current = false;
      setNativeNodeProps(quadRef.current, { opacity: 0 });
      setNativeNodeProps(nodeRef.current, { visible: false });
    }
  }, [introActive]);

  useEffect(() => {
    const hideCover = () => {
      if (!visibleRef.current) return;
      visibleRef.current = false;
      setNativeNodeProps(quadRef.current, { opacity: 0 });
      setNativeNodeProps(nodeRef.current, { visible: false });
    };
    const stop = session.onFrame(() => {
      const opacity = session.getIntroOpacity();
      if (opacity <= 0) {
        hideCover();
        return;
      }
      const sample = questHeadTracker.getLiveHeadState?.()?.sample;
      const pose = sample ? questHeadCoverPose(sample) : null;
      if (pose) {
        pushNodeTransform(
          nodeRef,
          [pose.position[0], pose.position[1], pose.position[2]],
          [pose.rotation[0], pose.rotation[1], pose.rotation[2]]
        );
      }
      setNativeNodeProps(quadRef.current, { opacity });
      if (!visibleRef.current) {
        visibleRef.current = true;
        setNativeNodeProps(nodeRef.current, { visible: true });
      }
    });
    return () => {
      stop();
    };
  }, [session]);
  return (
    <ViroNode ref={nodeRef} position={introCoverPosition} visible={false}>
      <ViroQuad
        ref={quadRef}
        width={introCoverSize}
        height={introCoverSize}
        materials={introCoverMaterials}
        renderingOrder={1000}
        opacity={0}
        ignoreEventHandling
      />
    </ViroNode>
  );
});

const damageEdgeMaterials = ['questDamageTint'];
const damageEdgeBars: readonly { position: Vec3Tuple; width: number; height: number }[] = [
  { position: [0, 0.25, 0], width: 0.72, height: 0.14 },
  { position: [0, -0.25, 0], width: 0.72, height: 0.14 },
  { position: [-0.31, 0, 0], width: 0.14, height: 0.56 },
  { position: [0.31, 0, 0], width: 0.14, height: 0.56 },
];

const QuestDamageVignette = memo(function QuestDamageVignette({
  session,
}: {
  session: QuestArenaSession;
}) {
  const nodeRef = useRef<ViroNode | null>(null);
  const quadRefs = useRef<(ViroQuad | null)[]>([null, null, null, null]);
  const visibleRef = useRef(false);
  const lastOpacityRef = useRef(-1);

  useEffect(() => {
    const sync = () => {
      const node = nodeRef.current;
      if (!node) return;
      const opacity = session.getDamageTintOpacity?.() ?? 0;
      const visible = opacity > 0.005;
      const sample = visible ? questHeadTracker.getLiveHeadState().sample : null;
      const pose = visible && sample ? questHeadCoverPose(sample, 0.35) : null;
      if (!visible || !pose) {
        if (visibleRef.current) {
          visibleRef.current = false;
          lastOpacityRef.current = 0;
          setNativeNodeProps(node, { visible: false });
        }
        return;
      }
      pushNodeTransform(nodeRef, [...pose.position], [...pose.rotation]);
      if (!visibleRef.current) {
        visibleRef.current = true;
        setNativeNodeProps(node, { visible: true });
      }
      if (Math.abs(opacity - lastOpacityRef.current) >= 0.005) {
        lastOpacityRef.current = opacity;
        for (const quad of quadRefs.current) {
          setNativeNodeProps(quad, { opacity });
        }
      }
    };
    sync();
    return session.onFrame(sync);
  }, [session]);

  return (
    <ViroNode ref={nodeRef} position={introCoverPosition} visible={false}>
      {damageEdgeBars.map((bar, index) => (
        <ViroQuad
          key={index}
          ref={(el) => {
            quadRefs.current[index] = el;
          }}
          position={bar.position}
          width={bar.width}
          height={bar.height}
          materials={damageEdgeMaterials}
          renderingOrder={950}
          opacity={0}
          ignoreEventHandling
        />
      ))}
    </ViroNode>
  );
});

// Centered under the robot eyes, which the rig places on the calibrated head.
// The fighter and arena are not moved.
function StanceFloorRing({
  stanceRef,
  initialPosition,
  initialRotation,
  outOfBounds,
}: {
  stanceRef: RefObject<ViroNode | null>;
  initialPosition: Vec3Tuple;
  initialRotation: Vec3Tuple;
  outOfBounds: boolean;
}) {
  const materials = [outOfBounds ? 'questStanceRingOutOfBounds' : 'questStanceRing'];
  return (
    <ViroNode
      ref={stanceRef}
      viroTag="quest-stance-ring"
      position={initialPosition}
      rotation={initialRotation}>
      <ViroQuad
        position={[0, 0, stanceRingHalf]}
        rotation={[-90, 0, 0]}
        width={stanceRingSize}
        height={stanceRingThickness}
        materials={materials}
        ignoreEventHandling
      />
      <ViroQuad
        position={[0, 0, -stanceRingHalf]}
        rotation={[-90, 0, 0]}
        width={stanceRingSize}
        height={stanceRingThickness}
        materials={materials}
        ignoreEventHandling
      />
      <ViroQuad
        position={[-stanceRingHalf, 0, 0]}
        rotation={[-90, 0, 0]}
        width={stanceRingThickness}
        height={stanceRingSize}
        materials={materials}
        ignoreEventHandling
      />
      <ViroQuad
        position={[stanceRingHalf, 0, 0]}
        rotation={[-90, 0, 0]}
        width={stanceRingThickness}
        height={stanceRingSize}
        materials={materials}
        ignoreEventHandling
      />
    </ViroNode>
  );
}

function QuestRing({
  lease,
  token,
  placementVersion,
  session,
  outOfBounds,
  initialPose,
  rigOuterRef,
  stanceRingRef,
  blueNodeRef,
  redNodeRef,
  blueModelRef,
  blueBodyModelRef,
  redModelRef,
  showOriginal,
  showBody,
}: {
  lease: number;
  token: number | null;
  placementVersion: number | null;
  session: QuestArenaSession;
  outOfBounds: boolean;
  initialPose: InitialRingPose;
  rigOuterRef: RefObject<ViroNode | null>;
  stanceRingRef: RefObject<ViroNode | null>;
  blueNodeRef: RefObject<ViroNode | null>;
  redNodeRef: RefObject<ViroNode | null>;
  blueModelRef: RefObject<Viro3DObject | null>;
  blueBodyModelRef: RefObject<Viro3DObject | null>;
  redModelRef: RefObject<Viro3DObject | null>;
  showOriginal: boolean;
  showBody: boolean;
}) {
  if (token === null || placementVersion === null) return null;
  return (
    <ViroNode
      key={initialPose.key}
      ref={rigOuterRef}
      viroTag="quest-rig-outer"
      position={initialPose.rigPosition}
      rotation={initialPose.rigRotation}
      scale={initialPose.rigScale}>
      <ViroQuad
        rotation={[-90, 0, 0]}
        width={1.4}
        height={1.4}
        position={[0, 0.001, 0]}
        materials={['questRingFloor']}
        ignoreEventHandling
      />
      <StanceFloorRing
        stanceRef={stanceRingRef}
        initialPosition={initialPose.stancePosition}
        initialRotation={initialPose.stanceRotation}
        outOfBounds={outOfBounds}
      />
      <Viro3DObject
        source={sources.arena}
        type="GLB"
        scale={arenaScale}
        position={[0, ARENA_LAYOUT.arenaBaseOffset, 0]}
        ignoreEventHandling
        onLoadEnd={() => session.assetLoaded(lease, token, placementVersion, 'arena')}
        onError={() => session.assetFailed(lease, token, placementVersion, 'arena')}
      />
      <QuestFighter
        id="blue"
        lease={lease}
        token={token}
        placementVersion={placementVersion}
        session={session}
        nodeRef={blueNodeRef}
        modelRef={blueModelRef}
        bodyModelRef={blueBodyModelRef}
        viroTag="quest-blue-node"
        initialPosition={initialPose.bluePosition}
        initialRotation={initialPose.blueRotation}
        visible={showOriginal}
        bodyVisible={showBody}
      />
      <QuestFighter
        id="red"
        lease={lease}
        token={token}
        placementVersion={placementVersion}
        session={session}
        nodeRef={redNodeRef}
        modelRef={redModelRef}
        viroTag="quest-red-node"
        initialPosition={initialPose.redPosition}
        initialRotation={initialPose.redRotation}
      />
    </ViroNode>
  );
}

function QuestMenuFallbackButtons({
  buttons,
  hasMessages,
}: {
  buttons: QuestMenuButton[];
  hasMessages: boolean;
}) {
  return (
    <>
      {buttons.map((button) => {
        const buttonFrame = questMenuButtonFrame(button, hasMessages);
        const dark = button.action === 'back' || button.action === 'posture';
        return (
          <ViroNode
            key={button.action}
            position={[buttonFrame.position[0], buttonFrame.position[1], 0.004]}>
            <ViroQuad
              width={buttonFrame.width}
              height={buttonFrame.height}
              materials={[fallbackMaterial(button.action)]}
              ignoreEventHandling
            />
            <ViroText
              text={button.label}
              position={[0, 0, 0.004]}
              scale={textScale}
              width={buttonFrame.width / TEXT_SCALE}
              height={buttonFrame.height / TEXT_SCALE}
              style={{ ...labelStyle, color: dark ? '#f8fafc' : '#09090b' }}
            />
          </ViroNode>
        );
      })}
    </>
  );
}

function QuestMenuText({
  text,
  width,
  height,
  y,
}: {
  text: string;
  width: number;
  height: number;
  y: number;
}) {
  return (
    <ViroText
      text={text}
      position={[0, y, 0.004]}
      scale={textScale}
      width={width / TEXT_SCALE}
      height={height / TEXT_SCALE}
      style={messageStyle}
    />
  );
}

// Hover feedback drawn by Viro in front of the layer, so pointing never redraws it.
function QuestMenuFocus({
  button,
  hasMessages,
}: {
  button: QuestMenuButton;
  hasMessages: boolean;
}) {
  const frame = questMenuButtonFrame(button, hasMessages);
  const width = frame.width + focusPad * 2;
  const height = frame.height + focusPad * 2;
  const edges: [number, number, number, number][] = [
    [0, (height - focusThickness) / 2, width, focusThickness],
    [0, -(height - focusThickness) / 2, width, focusThickness],
    [-(width - focusThickness) / 2, 0, focusThickness, height],
    [(width - focusThickness) / 2, 0, focusThickness, height],
  ];
  return (
    <ViroNode position={[frame.position[0], frame.position[1], focusZ]}>
      {edges.map(([x, y, w, h], index) => (
        <ViroQuad
          key={index}
          position={[x, y, 0]}
          width={w}
          height={h}
          materials={['questMenuFocus']}
          ignoreEventHandling
        />
      ))}
    </ViroNode>
  );
}

function QuestMenu({
  page,
  menuVisible,
  acknowledged,
  posture,
  calibration,
  lines,
  layer,
  titleLayer,
  combatHud,
  settings,
  hover,
  onPress,
  onHover,
}: {
  page: QuestMenuPage;
  menuVisible: boolean;
  acknowledged: boolean;
  posture: QuestMenuPosture;
  calibration: Calibration;
  lines: string[];
  layer: QuestMenuLayerSnapshot;
  titleLayer: QuestMenuLayerSnapshot;
  combatHud: QuestCombatHudState | null;
  settings?: QuestUserSettings;
  hover: QuestMenuAction | null;
  onPress: (action: QuestMenuAction, clickState: number, source: unknown) => void;
  onHover: (action: QuestMenuAction, hovering: boolean, source: unknown) => void;
}) {
  // The layer poses (questMenuPanelPose / questMenuTitlePose) are built from these same transforms.
  const frame = menuFrame(calibration);
  const basePose = QUEST_MENU_POSE[page];
  const layerOn = questMenuLayerVisible(layer.mode);
  const titleOn = questMenuLayerVisible(titleLayer.mode);
  const fallbackNotice = layerOn ? '' : questMenuLayerNotice(layer);
  const fallbackText = [fallbackNotice, ...lines].filter(Boolean).join('\n');
  const hasMessages = layerOn ? lines.length > 0 : fallbackText.length > 0;
  const cardPose = hasMessages
    ? {
        position: [
          basePose.position[0],
          basePose.position[1] + QUEST_MENU_ALERT_SHIFT_M,
          basePose.position[2],
        ] as [number, number, number],
        rotation: basePose.rotation,
      }
    : basePose;
  const card = questMenuCardMetrics(hasMessages);
  const buttons = questMenuButtons(page, { acknowledged, posture, hasMessages, settings });
  const hovered = buttons.find((button) => button.action === hover) ?? null;
  const textWidth = card.widthM * 0.9;
  const textHeight = 0.2;
  const titlePose = QUEST_TITLE_POSE[page];
  const titleSize = QUEST_TITLE_SIZE[page];
  const showFallbackCombatHud = !menuVisible && !titleOn && Boolean(combatHud);
  const fallbackHudTexts = combatHud ? (
    <>
      <ViroText
        text={`YOU ${Math.ceil(combatHud.playerHealth)}/${combatHud.playerMaxHealth} | GUARD ${Math.round(
          (combatHud.playerGuardStamina / Math.max(1, combatHud.playerGuardMaxStamina)) * 100
        )}% | RED ${Math.ceil(combatHud.opponentHealth)}/${combatHud.opponentMaxHealth}`}
        position={[0, 0.12, 0]}
        scale={textScale}
        width={1.28 / TEXT_SCALE}
        height={0.14 / TEXT_SCALE}
        style={fallbackTitleNeoStyle}
        ignoreEventHandling
      />
      <ViroText
        text={
          combatHud.event?.label ??
          (combatHud.incomingAttack
            ? `INCOMING ${combatHud.incomingAttack.kind.toUpperCase()} (${combatHud.incomingAttack.hand})`
            : combatHud.telegraphAttack
              ? `RED WINDUP: ${combatHud.telegraphAttack.kind.toUpperCase()}`
              : `UPP ${combatHud.playerPunchProgress}/3 | ${combatHud.evadeStatus.toUpperCase()}`)
        }
        position={[0, -0.04, 0]}
        scale={textScale}
        width={1.28 / TEXT_SCALE}
        height={0.14 / TEXT_SCALE}
        style={fallbackTitleMainStyle}
        ignoreEventHandling
      />
    </>
  ) : null;

  if (!menuVisible && !showFallbackCombatHud) {
    return null;
  }

  if (showFallbackCombatHud) {
    return <QuestViewHudFallback>{fallbackHudTexts}</QuestViewHudFallback>;
  }

  return (
    <ViroNode position={[...frame.position]} rotation={[0, frame.rotationY, 0]}>
      {!titleOn && menuVisible && (page === 'menu' || page === 'ring') ? (
        <ViroNode position={titlePose.position} rotation={titlePose.rotation}>
          <ViroText
            text="Neo"
            position={[0, titleSize.heightM * 0.34, 0]}
            scale={textScale}
            width={titleSize.widthM / TEXT_SCALE}
            height={(titleSize.heightM * 0.28) / TEXT_SCALE}
            style={fallbackTitleNeoStyle}
          />
          <ViroText
            text={"Rock 'Em Sock 'Em\nRobots"}
            position={[0, -titleSize.heightM * 0.14, 0]}
            scale={textScale}
            width={titleSize.widthM / TEXT_SCALE}
            height={(titleSize.heightM * 0.7) / TEXT_SCALE}
            style={fallbackTitleMainStyle}
          />
        </ViroNode>
      ) : null}
      {menuVisible ? (
        <ViroNode position={cardPose.position} rotation={cardPose.rotation}>
          {layerOn ? (
            // Depth-writing, zero-alpha hole for the compact quad layer underneath.
            <ViroQuad
              width={card.widthM}
              height={card.heightM}
              materials={[hasMessages ? 'questMenuLayerMaskAlert' : 'questMenuLayerMask']}
              renderingOrder={-100}
              ignoreEventHandling
            />
          ) : (
            <>
              <ViroQuad
                width={card.widthM}
                height={card.heightM}
                materials={['questMenuBacking']}
                ignoreEventHandling
              />
              {fallbackText ? (
                <QuestMenuText
                  text={fallbackText}
                  width={textWidth}
                  height={textHeight}
                  y={card.heightM / 2 - 0.12}
                />
              ) : null}
              <QuestMenuFallbackButtons buttons={buttons} hasMessages={hasMessages} />
            </>
          )}
          {hovered ? <QuestMenuFocus button={hovered} hasMessages={hasMessages} /> : null}
          {buttons.map((button) => {
            const buttonFrame = questMenuButtonFrame(button, hasMessages);
            return (
              <ViroQuad
                key={`hit-${button.action}`}
                position={buttonFrame.position}
                width={buttonFrame.width}
                height={buttonFrame.height}
                materials={['questMenuHit']}
                onClickState={(clickState: number, _position: unknown, source: unknown) =>
                  onPress(button.action, clickState, source)
                }
                onHover={(isHovering: boolean, _position: unknown, source: unknown) =>
                  onHover(button.action, isHovering, source)
                }
              />
            );
          })}
        </ViroNode>
      ) : null}
    </ViroNode>
  );
}

export default function QuestArenaScene() {
  const [session] = useState(() =>
    createQuestArenaSession(undefined, questHeadTracker, undefined, undefined, {
      read: () => questInputNative?.readMovementMode?.(),
      write: (mode) => {
        if (!questInputNative?.writeMovementMode?.(mode)) {
          console.warn('[Quest] Movement preference could not be saved; native rebuild may be required.');
        }
      },
    })
  );
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const tracker = useSyncExternalStore(questHeadTracker.subscribe, questHeadTracker.getSnapshot);
  const [compositor] = useState(() =>
    createQuestMenuCompositor(
      {
        available: questPanelAvailable,
        open: () => {
          if (!questPanelNative) throw new Error('QuestPanel module is not linked.');
          return questPanelNative.open();
        },
        draw: (owner, spec) => questPanelNative?.draw(owner, spec),
        invalidate: (owner) => questPanelNative?.invalidate?.(owner),
        status: (owner) => questPanelNative?.status(owner) ?? -1,
        hide: (owner) => questPanelNative?.hide(owner),
        log: logMenu,
      },
      { enabled: questMenuLayer.get() === 'compositor' }
    )
  );
  const [titleCompositor] = useState(() =>
    createQuestMenuCompositor(
      {
        available: () =>
          questPanelAvailable() &&
          typeof questPanelNative?.openTitle === 'function' &&
          typeof questPanelNative?.drawTitle === 'function' &&
          typeof questPanelNative?.statusTitle === 'function' &&
          typeof questPanelNative?.hideTitle === 'function',
        open: () => {
          if (!questPanelNative?.openTitle) {
            throw new Error('QuestPanel title overlay is not linked.');
          }
          return questPanelNative.openTitle();
        },
        draw: (owner, spec) => questPanelNative?.drawTitle?.(owner, spec),
        invalidate: (owner) => questPanelNative?.invalidateTitle?.(owner),
        status: (owner) => questPanelNative?.statusTitle?.(owner) ?? -1,
        hide: (owner) => questPanelNative?.hideTitle?.(owner),
        log: (level, message) => logMenu(level, `title ${message}`),
      },
      { enabled: questMenuLayer.get() === 'compositor' }
    )
  );
  const layer = useSyncExternalStore(compositor.subscribe, compositor.getSnapshot);
  const titleLayer = useSyncExternalStore(titleCompositor.subscribe, titleCompositor.getSnapshot);
  const [input] = useState(createSceneQuestInputSource);
  const [markerPipeline, setMarkerPipeline] = useState<'render-thread' | 'js-fallback'>(
    'render-thread'
  );
  const [fonts, setFonts] = useState<QuestMenuFonts>(() => ({
    body: initialAssetRef(menuFontModules.body),
    button: initialAssetRef(menuFontModules.button),
  }));
  const [titles, setTitles] = useState<QuestMenuTitles>(() => ({
    neo: initialAssetRef(menuTitleModules.neo),
    rock: initialAssetRef(menuTitleModules.rock),
    robots: initialAssetRef(menuTitleModules.robots),
  }));
  const [hover, setHover] = useState<QuestMenuAction | null>(null);
  const press = useRef<QuestPressState>({ down: new Set() });
  const hoverSources = useRef(new Map<QuestMenuAction, Set<number>>());
  const rigOuterRef = useRef<ViroNode | null>(null);
  const stanceRingRef = useRef<ViroNode | null>(null);
  const blueNodeRef = useRef<ViroNode | null>(null);
  const redNodeRef = useRef<ViroNode | null>(null);
  const blueModelRef = useRef<Viro3DObject | null>(null);
  const blueBodyModelRef = useRef<Viro3DObject | null>(null);
  const redModelRef = useRef<Viro3DObject | null>(null);
  const syncedTransformsRef = useRef<SyncedTransformCache>({});
  const rigSyncActive = useMemo(() => questRigSyncAvailable(), []);
  const appActiveRef = useRef(true);
  const appliedAnimationsRef = useRef<
    Record<FighterId, { id: number; name: string; loop: boolean }>
  >({
    blue: { id: Number.NaN, name: 'IdleAggro', loop: true },
    red: { id: Number.NaN, name: 'IdleAggro', loop: true },
  });
  const appliedBodyAnimationRef = useRef<{
    model: Viro3DObject | null;
    name: QuestFirstPersonBodyClip;
    run: boolean;
    interruptible: boolean;
  }>({
    model: null,
    name: 'IdleAggro',
    run: false,
    interruptible: true,
  });
  const lastLogAt = useRef(0);
  const posture = tracker.calibration.posture;
  const calibration = tracker.calibration;
  const menuCalibration =
    (view.page === 'pause' || view.page === 'result' || view.paused) && view.pauseCalibration
      ? view.pauseCalibration
      : calibration;

  const initialRingPose = useMemo<InitialRingPose | null>(() => {
    if (
      view.mode !== 'solo' ||
      view.token === null ||
      view.placementVersion === null ||
      !view.transforms
    ) {
      return null;
    }
    const anchor: RigAnchor = tracker.anchor ?? view.transforms.blue;
    const rig = questIntroRig(calibration, anchor, session.getRigBlend());
    const stanceCenter = stanceCenterForPresentation(anchor, view.presentation);
    return {
      key: `${view.lease}:${view.token}:${view.placementVersion}`,
      rigPosition: [...rig.position],
      rigRotation: [0, rig.rotationY, 0],
      rigScale: [rig.scale, rig.scale, rig.scale],
      stancePosition: [stanceCenter[0], stanceCenter[1] + stanceRingLift, stanceCenter[2]],
      stanceRotation: [0, anchor.yaw, 0],
      bluePosition: [
        view.transforms.blue.x,
        fighterY + view.transforms.blue.lift,
        view.transforms.blue.z,
      ],
      blueRotation: [0, view.transforms.blue.yaw, 0],
      redPosition: [
        view.transforms.red.x,
        fighterY + view.transforms.red.lift,
        view.transforms.red.z,
      ],
      redRotation: [0, view.transforms.red.yaw, 0],
    };
    // Initial JSX mount props stay frozen per round/placement so React re-renders
    // (200ms tracker updates, calibration changes, or presentation flip) never overwrite setNativeProps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, view.lease, view.mode, view.placementVersion, view.token, view.transforms]);

  const menuVisible = view.menuVisible ?? view.presentation !== 'eyes';
  useQuestArenaAudio(
    session,
    session.getMatch?.() ?? null,
    view.appActive !== false && !view.leaving && !view.paused,
    menuVisible && view.page === 'menu',
    view.settings
  );

  const updateMenuFocus = () => {
    let hovered = false;
    for (const sourcesForButton of hoverSources.current.values()) {
      if (sourcesForButton.size > 0) {
        hovered = true;
        break;
      }
    }
    session.setMenuFocus(
      session.getSnapshot().menuVisible && (hovered || press.current.down.size > 0)
    );
  };

  const failureMessage =
    view.message && /failed|could not|error|unavailable|timeout/i.test(view.message)
      ? view.message
      : null;

  const menuLines = useMemo(() => {
    if (view.leaving) return [...view.lines];
    const lines: string[] = [];
    if (tracker.status === 'no-samples' && tracker.message) lines.push(tracker.message);
    if (failureMessage) lines.push(failureMessage);
    if (tracker.outOfBounds) lines.push('Outside bounds: return toward the stance ring center.');
    if (view.page === 'settings') {
      lines.push('Movement: View-relative follows your gaze. Opponent-relative approaches or circles your rival.');
    } else if (view.page === 'pause' || view.stage === 'paused' || view.stage === 'finished') {
      lines.push(...view.lines);
    }
    return lines;
  }, [
    failureMessage,
    tracker.message,
    tracker.outOfBounds,
    tracker.status,
    view.leaving,
    view.lines,
    view.page,
    view.stage,
  ]);

  const developerLines = useMemo(() => {
    const lines = view.leaving ? [] : [...view.lines];
    if (view.message && view.message !== failureMessage) lines.push(view.message);
    lines.push(systemRecenterHint);
    return lines;
  }, [failureMessage, view.leaving, view.lines, view.message]);

  // Pose, panel and hit targets all follow the requested screen at once.
  const inputKey = `${view.page}:${view.acknowledged}:${view.menuVisible}:${view.appActive}`;
  const inputKeyRef = useRef(inputKey);
  const visibleHover =
    view.menuVisible &&
    questMenuButtons(view.page, {
      acknowledged: view.acknowledged,
      posture,
      hasMessages: menuLines.length > 0,
    }).some((button) => button.action === hover)
      ? hover
      : null;
  // Hover is not part of the panel image; only page, text, posture and fonts are.
  const menu = useMemo(
    () =>
      buildQuestMenu(view.page, menuLines, {
        acknowledged: view.acknowledged,
        posture,
        fonts,
        settings: view.settings,
      }),
    [fonts, menuLines, posture, view.acknowledged, view.page, view.settings]
  );
  const titleModel = useMemo(() => buildQuestMenuTitle({ titles, fonts }), [fonts, titles]);
  const combatHudModel = useMemo(
    () =>
      view.presentation === 'eyes' && view.combatHud
        ? buildQuestCombatHud(view.combatHud, fonts)
        : null,
    [fonts, view.combatHud, view.presentation]
  );
  const panelLabel = `${view.page} ack=${view.acknowledged} ${posture}`;

  useEffect(() => {
    session.setHapticTrigger?.((handMask, amplitude, durationMs) => {
      try {
        return questInputNative?.triggerHaptic?.(handMask, amplitude, durationMs) === true;
      } catch {
        return false;
      }
    });
    return () => {
      session.setHapticTrigger?.(null);
    };
  }, [session]);

  useEffect(() => {
    const hasMenuHover = () => {
      for (const s of hoverSources.current.values()) {
        if (s.size > 0) return true;
      }
      return false;
    };
    const stopInput = input.onSample((sample, status, batch) => {
      if (status === 'live' && sample?.focused) {
        const hadPress = press.current.down.size > 0;
        for (const [source, hand] of [
          [1, sample.right],
          [4, sample.left],
        ] as const) {
          if (hand.trigger?.active && hand.trigger.value < 0.5) press.current.down.delete(source);
        }
        if (hadPress && press.current.down.size === 0 && !hasMenuHover())
          session.setMenuFocus(false);
      }
      session.setInputState(sample, status, batch, input.getLiveState?.().nowNs);
    });
    const stopFrames = session.onFrame((dtSeconds) =>
      syncQuestRingTransforms(
        session,
        {
          rigOuter: rigOuterRef,
          stanceRing: stanceRingRef,
          blueNode: blueNodeRef,
          redNode: redNodeRef,
        },
        syncedTransformsRef.current,
        rigSyncActive,
        dtSeconds,
        appActiveRef.current && !hasMenuHover()
      )
    );
    const isSceneActive = (rt: {
      status?: string;
      appActive?: boolean;
      vrActivityState?: string;
    }) =>
      (rt.status === undefined || rt.status === 'immersive') &&
      rt.appActive !== false &&
      rt.vrActivityState !== 'paused' &&
      rt.vrActivityState !== 'stopped' &&
      rt.vrActivityState !== 'finishing' &&
      rt.vrActivityState !== 'destroyed';
    const syncRuntimeActive = () => {
      const rt = questRuntime.getSnapshot() as {
        status?: string;
        appActive?: boolean;
        vrActivityState?: string;
      };
      const active = isSceneActive(rt);
      appActiveRef.current = active;
      if (!active) {
        compositor.hide();
        titleCompositor.hide();
      }
      session.setAppActive(active);
    };
    syncRuntimeActive();
    const stopRuntime = (
      questRuntime as { subscribe?: (listener: () => void) => () => void }
    ).subscribe?.(syncRuntimeActive);
    return () => {
      stopRuntime?.();
      stopFrames();
      stopInput();
    };
  }, [compositor, input, rigSyncActive, session, titleCompositor]);

  useEffect(() => {
    questHeadTracker.setRefSpaceEpochSource(() => questPanelNative?.refSpaceEpoch?.() ?? 0);
    questRuntime.sceneMounted();
    input.start();
    return () => {
      input.stop();
      if (rigSyncActive) questInputNative?.clearRigState?.();
      questHeadTracker.dispose();
      session.dispose();
      compositor.dispose();
      titleCompositor.dispose();
      questRuntime.sceneUnmounted();
    };
  }, [compositor, input, rigSyncActive, session, titleCompositor]);

  useEffect(() => {
    if (view.mode !== 'solo') {
      if (rigSyncActive) questInputNative?.clearRigState?.();
      syncedTransformsRef.current = {};
      appliedAnimationsRef.current = {
        blue: { id: Number.NaN, name: 'IdleAggro', loop: true },
        red: { id: Number.NaN, name: 'IdleAggro', loop: true },
      };
      appliedBodyAnimationRef.current = {
        model: null,
        name: 'IdleAggro',
        run: false,
        interruptible: true,
      };
      return;
    }
    syncQuestRingTransforms(
      session,
      {
        rigOuter: rigOuterRef,
        stanceRing: stanceRingRef,
        blueNode: blueNodeRef,
        redNode: redNodeRef,
      },
      syncedTransformsRef.current,
      rigSyncActive,
      0,
      false
    );
  }, [
    calibration,
    rigSyncActive,
    session,
    view.lease,
    view.mode,
    view.placementVersion,
    view.presentation,
    view.token,
  ]);

  useEffect(() => {
    if (view.mode !== 'solo' || !view.fighters) return;
    const fighters = view.fighters;
    const run = view.animationsRunning;
    const pendingFrames: unknown[] = [];

    for (const [id, modelRef] of [
      ['blue', blueModelRef],
      ['red', redModelRef],
    ] as const) {
      const model = modelRef.current;
      if (!model) continue;
      const applied = appliedAnimationsRef.current[id];
      const { clip, animationId } = fighters[id];
      const loop = LOOPING_CLIPS.has(clip);
      if (!run) {
        writeFighterAnimation(model, {
          name: applied.name,
          loop: applied.loop,
          run: false,
          interruptible: false,
        });
        continue;
      }
      // Viro 3.0.3 resumes the old executable when paused; resume first, then apply clip change.
      writeFighterAnimation(model, { name: clip, loop, run: true, interruptible: false });
      if (applied.id === animationId) continue;
      const handle = scheduleAnimationFrame(() => {
        writeFighterAnimation(model, { name: clip, loop, run: true, interruptible: true });
        appliedAnimationsRef.current[id] = { id: animationId, name: clip, loop };
        session.animationApplied(id, animationId);
      });
      pendingFrames.push(handle);
    }
    return () => {
      for (const handle of pendingFrames) cancelScheduledAnimationFrame(handle);
    };
  }, [session, view.animationsRunning, view.fighters, view.lease, view.mode]);

  useEffect(() => {
    if (view.mode !== 'solo') return;
    const bodyModel = blueBodyModelRef.current;
    if (!bodyModel) return;
    if (appliedBodyAnimationRef.current.model !== bodyModel) {
      appliedBodyAnimationRef.current = {
        model: bodyModel,
        name: 'IdleAggro',
        run: false,
        interruptible: true,
      };
    }
    const activeBody = view.presentation === 'eyes' && view.animationsRunning;
    if (!activeBody) {
      if (appliedBodyAnimationRef.current.run) {
        const name = appliedBodyAnimationRef.current.name;
        writeFighterAnimation(bodyModel, {
          name,
          loop: true,
          run: false,
          interruptible: false,
        });
        appliedBodyAnimationRef.current = {
          model: bodyModel,
          name,
          run: false,
          interruptible: false,
        };
      }
      return;
    }

    const desiredClip: QuestFirstPersonBodyClip = view.bodyClip ?? 'IdleAggro';
    const applied = appliedBodyAnimationRef.current;
    if (applied.run && applied.name === desiredClip && applied.interruptible) return;

    if (applied.run && applied.interruptible) {
      // Already running and interruptible: switch clip directly without a wasted interruptible:false frame.
      writeFighterAnimation(bodyModel, {
        name: desiredClip,
        loop: true,
        run: true,
        interruptible: true,
      });
      appliedBodyAnimationRef.current = {
        model: bodyModel,
        name: desiredClip,
        run: true,
        interruptible: true,
      };
      return;
    }

    // Match Viro 3.0.3 pause/resume semantics: enable run first, then apply clip switch on next frame.
    writeFighterAnimation(bodyModel, {
      name: desiredClip,
      loop: true,
      run: true,
      interruptible: false,
    });
    appliedBodyAnimationRef.current = {
      model: bodyModel,
      name: desiredClip,
      run: true,
      interruptible: false,
    };
    const handle = scheduleAnimationFrame(() => {
      if (blueBodyModelRef.current !== bodyModel) return;
      writeFighterAnimation(bodyModel, {
        name: desiredClip,
        loop: true,
        run: true,
        interruptible: true,
      });
      appliedBodyAnimationRef.current = {
        model: bodyModel,
        name: desiredClip,
        run: true,
        interruptible: true,
      };
    });
    return () => {
      cancelScheduledAnimationFrame(handle);
    };
  }, [view.animationsRunning, view.bodyClip, view.lease, view.mode, view.presentation]);

  // Dev builds serve TTFs/PNGs over Metro HTTP until downloaded to a local file;
  // release builds resolve packaged resource names synchronously above.
  useEffect(() => {
    if (fonts.body && fonts.button && titles.neo && titles.rock && titles.robots) return;
    let cancelled = false;
    const resolveAsset = async (moduleId: number) => {
      const asset = Asset.fromModule(moduleId);
      return resolveQuestMenuAssetFile(asset, async () => {
        await asset.downloadAsync();
        return asset.localUri ?? asset.uri;
      });
    };
    const resolveOrNull = (current: string | null | undefined, moduleId: number) =>
      current ? Promise.resolve(current) : resolveAsset(moduleId).catch(() => null);
    Promise.all([
      resolveOrNull(fonts.body, menuFontModules.body),
      resolveOrNull(fonts.button, menuFontModules.button),
      resolveOrNull(titles.neo, menuTitleModules.neo),
      resolveOrNull(titles.rock, menuTitleModules.rock),
      resolveOrNull(titles.robots, menuTitleModules.robots),
    ]).then(([body, button, neo, rock, robots]) => {
      if (cancelled) return;
      if ((body && body !== fonts.body) || (button && button !== fonts.button)) {
        setFonts({ body: body ?? fonts.body, button: button ?? fonts.button });
      }
      if (
        (neo && neo !== titles.neo) ||
        (rock && rock !== titles.rock) ||
        (robots && robots !== titles.robots)
      ) {
        setTitles({
          neo: neo ?? titles.neo,
          rock: rock ?? titles.rock,
          robots: robots ?? titles.robots,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fonts.body, fonts.button, titles.neo, titles.rock, titles.robots]);

  useEffect(() => {
    const now = Date.now();
    if (now - lastLogAt.current < 1000) return;
    lastLogAt.current = now;
    const pose = tracker.pose;
    const poseSummary = pose
      ? `lat=${pose.lateral.toFixed(2)} vert=${pose.vertical.toFixed(2)} fwd=${pose.forward.toFixed(2)} yaw=${pose.yawRelative.toFixed(1)} clamp=${pose.clamped} oob=${pose.outOfBounds} excess=${pose.excess.toFixed(2)}`
      : 'pose=none';
    const raw = tracker.raw
      ? `raw=${fmtVec(tracker.raw.position)} rawYaw=${tracker.raw.yaw === null ? '--' : tracker.raw.yaw.toFixed(1)}`
      : 'raw=none';
    console.warn(
      `[QuestHeadRig] status=${tracker.status} src=${tracker.calibration.source} posture=${tracker.calibration.posture} entry=${tracker.calibration.entry} hz=${tracker.sampleHz ?? 0} ${poseSummary} ${raw} origin=${fmtVec(tracker.calibration.origin)} calYaw=${tracker.calibration.yaw.toFixed(1)} resets=${tracker.referenceResets ?? 0}`
    );
  }, [tracker]);

  // Clear hover across screens. A held trigger must release before the next press.
  useEffect(() => {
    if (inputKeyRef.current === inputKey) return;
    inputKeyRef.current = inputKey;
    hoverSources.current.clear();
    setHover(null);
    session.setMenuFocus(false);
  }, [inputKey, session]);

  useEffect(() => {
    if (!view.menuVisible || view.appActive === false) {
      compositor.hide();
      return;
    }
    compositor.present({
      label: panelLabel,
      pose: questMenuPanelPose(menuCalibration, view.page, menu.hasMessages).pose,
      ops: menu.ops,
      widthPx: menu.widthPx,
      heightPx: menu.heightPx,
      widthM: menu.widthM,
      heightM: menu.heightM,
    });
  }, [compositor, menu, menuCalibration, panelLabel, view.appActive, view.menuVisible, view.page]);

  useEffect(() => {
    if (view.introActive || view.paused || view.appActive === false) {
      titleCompositor.hide();
      return;
    }
    if (!view.menuVisible && view.presentation === 'eyes' && view.combatHud && combatHudModel) {
      const viewHudPose = questCombatHudViewPose();
      titleCompositor.present({
        label: 'combat hud',
        pose: viewHudPose.pose,
        viewLocked: true,
        ops: combatHudModel.ops,
        widthPx: combatHudModel.widthPx,
        heightPx: combatHudModel.heightPx,
        widthM: viewHudPose.widthM,
        heightM: viewHudPose.heightM,
      });
      return;
    }
    if (!view.menuVisible) {
      titleCompositor.hide();
      return;
    }
    const titleSize = QUEST_TITLE_SIZE[view.page];
    titleCompositor.present({
      label: `title ${view.page}`,
      pose: questMenuTitlePose(menuCalibration, view.page).pose,
      viewLocked: false,
      ops: titleModel.ops,
      widthPx: QUEST_TITLE_TEXTURE.widthPx,
      heightPx: QUEST_TITLE_TEXTURE.heightPx,
      widthM: titleSize.widthM,
      heightM: titleSize.heightM,
    });
  }, [
    combatHudModel,
    menuCalibration,
    titleCompositor,
    titleModel,
    view.appActive,
    view.combatHud,
    view.introActive,
    view.menuVisible,
    view.page,
    view.paused,
    view.presentation,
  ]);

  const lastCombatLogKeyRef = useRef<string>('');
  useEffect(() => {
    if (view.presentation !== 'eyes' || !view.combatHud) return;
    const h = view.combatHud;
    const logKey = `${h.stage}:${h.event?.id ?? 0}:${Math.ceil(h.playerHealth)}:${Math.ceil(
      h.opponentHealth
    )}:${h.playerGuardState}:${h.evadeStatus}`;
    if (logKey === lastCombatLogKeyRef.current) return;
    lastCombatLogKeyRef.current = logKey;
    const hs = questInputNative?.hapticsStatus?.();
    const hapticsText = hs
      ? `v=${hs.version} live=${hs.live} act=${hs.actionsReady} app=${hs.applied} fail=${hs.failed} drop=${hs.dropped} xr=${hs.lastResult}`
      : `v=${questInputNative?.hapticsVersion?.() ?? 0}`;
    console.warn(
      `[QuestCombat] stage=${h.stage} blue=${h.playerHealth} red=${h.opponentHealth} guard=${h.playerGuardState}:${h.playerGuardStamina} evade=${h.evadeStatus} range=${h.inPunchRange} evt=${h.event?.kind ?? 'none'} haptics=(${hapticsText})`
    );
  }, [view.combatHud, view.presentation]);

  const onAction = (action: QuestMenuAction) => {
    const current = session.getSnapshot();
    if (current.appActive === false || !current.menuVisible || current.page !== view.page) return;
    logMenu('info', `action ${action} on ${view.page}`);
    if (action === 'solo') {
      if (session.solo()) {
        const next = session.getSnapshot();
        if (next.transforms) questHeadTracker.calibrateForSolo(next.transforms.blue);
      }
    } else if (action === 'ready') session.ready();
    else if (action === 'resume') session.resume();
    else if (action === 'settings') session.showPauseSettings(true);
    else if (action === 'pause-done') session.showPauseSettings(false);
    else if (action === 'damage-tint')
      session.updateSettings({ damageTintEnabled: !current.settings.damageTintEnabled });
    else if (action === 'turn-mode')
      session.updateSettings({
        turnMode: current.settings.turnMode === 'snap' ? 'smooth' : 'snap',
      });
    else if (action === 'movement-mode')
      session.updateSettings({
        movementMode:
          current.settings.movementMode === 'view-relative' ? 'opponent-relative' : 'view-relative',
      });
    else if (action === 'music-volume' || action === 'sfx-volume') {
      const key = action === 'music-volume' ? 'musicVolume' : 'sfxVolume';
      const volume =
        QUEST_TUNING.audio.volumeLevels.find((level) => level > current.settings[key]) ?? 0;
      session.updateSettings({ [key]: volume });
    } else if (action === 'back') session.back();
    else if (action === 'posture') questHeadTracker.cyclePosture();
    else leave(session);
  };

  const ringOutOfBounds = tracker.outOfBounds;
  const ringElement = useMemo(() => {
    if (
      view.mode !== 'solo' ||
      view.token === null ||
      view.placementVersion === null ||
      !initialRingPose
    ) {
      return null;
    }
    return (
      <QuestRing
        lease={view.lease}
        token={view.token}
        placementVersion={view.placementVersion}
        session={session}
        outOfBounds={ringOutOfBounds}
        initialPose={initialRingPose}
        rigOuterRef={rigOuterRef}
        stanceRingRef={stanceRingRef}
        blueNodeRef={blueNodeRef}
        redNodeRef={redNodeRef}
        blueModelRef={blueModelRef}
        blueBodyModelRef={blueBodyModelRef}
        redModelRef={redModelRef}
        showOriginal={view.presentation !== 'eyes'}
        showBody={view.presentation === 'eyes'}
      />
    );
  }, [
    initialRingPose,
    ringOutOfBounds,
    session,
    view.lease,
    view.mode,
    view.placementVersion,
    view.presentation,
    view.token,
  ]);

  const handsActive = ringElement !== null && view.presentation === 'eyes' && !view.paused;
  const handsElement = useMemo(
    () => <QuestPreviewHands source={input} session={session} active={handsActive} />,
    [handsActive, input, session]
  );
  const introCoverElement = useMemo(
    () => <QuestIntroCover session={session} introActive={view.introActive} />,
    [session, view.introActive]
  );
  const damageVignetteElement = useMemo(() => <QuestDamageVignette session={session} />, [session]);

  return (
    <ViroScene onCameraTransformUpdate={questHeadTracker.onCameraTransform}>
      {!rigSyncActive ? (
        <ViroGameLoop onUpdate={({ dt }) => session.stepExternalFrame(dt)} />
      ) : null}
      <ViroSkyBox color="#000000" />
      <ViroAmbientLight color="#ffffff" intensity={700} />
      <ViroDirectionalLight color="#ffffff" intensity={900} direction={[-0.4, -1, -0.3]} />
      {ringElement}
      {handsElement}
      {introCoverElement}
      {damageVignetteElement}
      <QuestInputMarkers source={input} onPipelineChange={setMarkerPipeline} />
      <QuestDiagnosticsPanel
        source={input}
        tracker={tracker}
        developerLines={developerLines}
        fonts={fonts}
        menuLayer={layer}
        markerPipeline={markerPipeline}
      />
      <QuestMenu
        page={view.page}
        menuVisible={view.menuVisible && view.appActive !== false}
        acknowledged={view.acknowledged}
        posture={posture}
        calibration={menuCalibration}
        lines={menuLines}
        layer={layer}
        titleLayer={titleLayer}
        combatHud={view.presentation === 'eyes' && view.appActive !== false ? view.combatHud : null}
        settings={view.settings}
        hover={visibleHover}
        onPress={(action, clickState, source) => {
          if (clickState === 2) {
            questTriggerPress(press.current, clickState, source);
            updateMenuFocus();
            return;
          }
          if (inputKeyRef.current !== inputKey) {
            // Only presses are logged; releases and repeats add nothing.
            if (clickState === 1) {
              logMenu(
                'info',
                `click ${action} blocked key=${inputKey} current=${inputKeyRef.current} source ${String(source)}`
              );
            }
            return;
          }
          const result = questTriggerPress(press.current, clickState, source);
          updateMenuFocus();
          logMenu('info', `click ${action} state ${clickState} source ${String(source)} ${result}`);
          if (result === 'activate') onAction(action);
        }}
        onHover={(action, hovering, source) => {
          if (inputKeyRef.current !== inputKey) return;
          let sourcesForButton = hoverSources.current.get(action);
          if (!sourcesForButton) {
            sourcesForButton = new Set();
            hoverSources.current.set(action, sourcesForButton);
          }
          const active = questPointerHover(sourcesForButton, hovering, source);
          updateMenuFocus();
          logMenu('info', `hover ${action} ${hovering} source ${String(source)}`);
          setHover((current) => {
            if (active) return action;
            return current === action ? null : current;
          });
        }}
      />
    </ViroScene>
  );
}
