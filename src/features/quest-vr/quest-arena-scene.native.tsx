import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Viro3DObject,
  ViroAmbientLight,
  ViroDirectionalLight,
  ViroMaterials,
  ViroNode,
  ViroQuad,
  ViroScene,
  ViroSkyBox,
  ViroText,
  exitVRScene,
} from '@reactvision/react-viro';

import { ARENA_LAYOUT, type FighterId } from '../arena-fighter/arena-controller.ts';

import { questPanelAvailable, questPanelNative } from '../../../modules/quest-panel/src/index.ts';
import {
  createQuestArenaSession,
  type QuestArenaSession,
  type QuestArenaView,
} from './quest-arena-session.ts';
import {
  menuFrame,
  questRigTransform,
  stanceMarkerRingLocal,
  type RigAnchor,
} from './quest-head-rig.ts';
import { questHeadTracker, type QuestHeadTrackerSnapshot } from './quest-head-tracker.ts';
import {
  createQuestMenuCompositor,
  questMenuLayerMaterials,
  questMenuLayerNotice,
  questMenuLayerVisible,
  questMenuPanelPose,
  type QuestMenuLayerSnapshot,
} from './quest-menu-compositor.ts';
import { questPointerHover, questTriggerPress, type QuestPressState } from './quest-menu-input.ts';
import { questMenuLayer } from './quest-menu-layer.ts';
import {
  buildQuestMenu,
  QUEST_MENU_POSE,
  QUEST_MENU_SIZE,
  questMenuButtonFrame,
  questMenuButtons,
  type QuestMenuAction,
  type QuestMenuButton,
  type QuestMenuPage,
  type QuestMenuPosture,
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

const fighterScale: [number, number, number] = Array(3).fill(ARENA_LAYOUT.fighterScale) as [
  number,
  number,
  number,
];
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
const systemRecenterHint = 'If the system recenter moved the view, select Recenter.';
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
  questMenuFallbackPrimary: { diffuseColor: '#60a5fa', lightingModel: 'Constant' },
  questMenuFallbackDanger: { diffuseColor: '#d99a9a', lightingModel: 'Constant' },
  questMenuFallbackBack: { diffuseColor: '#1e293b', lightingModel: 'Constant' },
  questMenuFallbackRecenter: { diffuseColor: '#1e3a8a', lightingModel: 'Constant' },
  questMenuFallbackPosture: { diffuseColor: '#334155', lightingModel: 'Constant' },
});

// The medical viewer's headset text: scale 0.05 with the box in scaled units.
// A 28 pt string on an unscaled metre box clipped to "Menu" on a Quest 3S.
const TEXT_SCALE = 0.05;
const textScale: [number, number, number] = [TEXT_SCALE, TEXT_SCALE, TEXT_SCALE];
const messageStyle = {
  fontFamily: 'sans-serif',
  fontSize: 18,
  color: '#f8fafc',
  textAlign: 'center',
  textAlignVertical: 'center',
} as const;
const labelStyle = { ...messageStyle, fontSize: 28 } as const;
const diagnosticsStyle = {
  fontFamily: 'sans-serif',
  fontSize: 16,
  color: '#cbd5e1',
  textAlign: 'center',
  textAlignVertical: 'center',
} as const;

function fallbackMaterial(action: QuestMenuAction) {
  if (action === 'exit') return 'questMenuFallbackDanger';
  if (action === 'back') return 'questMenuFallbackBack';
  if (action === 'recenter') return 'questMenuFallbackRecenter';
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
  exitVRScene();
}

const fmtVec = (v: readonly number[]) => `[${v.map((n) => n.toFixed(3)).join(',')}]`;

function formatDiagnostics(tracker: QuestHeadTrackerSnapshot): string {
  const { calibration, sampleHz, pose, status } = tracker;
  const hz = sampleHz === null ? '--' : sampleHz.toFixed(0);
  const resets = tracker.referenceResets ? `, reset x${tracker.referenceResets}` : '';
  const header = `Rig ${status} (${calibration.source}, ${calibration.posture}, e${calibration.entry}, ${hz}Hz${resets})`;
  if (!pose) return `${header}\nPose: awaiting head samples`;
  const flags = `${pose.clamped ? ' CLAMP' : ''}${pose.outOfBounds ? ' OOB' : ''}`;
  return `${header}\nL ${pose.lateral.toFixed(2)}m V ${pose.vertical.toFixed(2)}m F ${pose.forward.toFixed(2)}m yaw ${pose.yawRelative.toFixed(0)}deg${flags}`;
}

function QuestFighter({
  id,
  view,
  session,
  visible = true,
}: {
  id: FighterId;
  view: QuestArenaView;
  session: QuestArenaSession;
  visible?: boolean;
}) {
  const transform = view.transforms?.[id];
  if (!transform || view.token === null || view.placementVersion === null) return null;
  const token = view.token;
  const version = view.placementVersion;
  const callbackLease = view.lease;
  return (
    <Viro3DObject
      source={sources[id]}
      type="GLB"
      position={[transform.x, fighterY + transform.lift, transform.z]}
      rotation={[0, transform.yaw, 0]}
      scale={fighterScale}
      animation={idleAnimation}
      visible={visible}
      // Viro picks the nearest bounding box, so scenery never takes a menu ray.
      ignoreEventHandling
      onLoadEnd={() => session.assetLoaded(callbackLease, token, version, id)}
      onError={() => session.assetFailed(callbackLease, token, version, id)}
    />
  );
}

// Centered under the robot eyes, which the rig places on the calibrated head.
// The fighter and arena are not moved.
function StanceFloorRing({ anchor, outOfBounds }: { anchor: RigAnchor; outOfBounds: boolean }) {
  const materials = [outOfBounds ? 'questStanceRingOutOfBounds' : 'questStanceRing'];
  const center = stanceMarkerRingLocal(anchor);
  return (
    <ViroNode
      position={[center[0], center[1] + stanceRingLift, center[2]]}
      rotation={[0, anchor.yaw, 0]}>
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
  view,
  session,
  tracker,
}: {
  view: QuestArenaView;
  session: QuestArenaSession;
  tracker: QuestHeadTrackerSnapshot;
}) {
  if (view.token === null || view.placementVersion === null || !view.transforms) return null;
  const token = view.token;
  const version = view.placementVersion;
  const callbackLease = view.lease;
  const anchor: RigAnchor = tracker.anchor ?? view.transforms.blue;
  const rig = questRigTransform(tracker.calibration, anchor);
  return (
    <ViroNode
      key={`${callbackLease}:${token}:${version}`}
      position={[...rig.position]}
      rotation={[0, rig.rotationY, 0]}>
      <ViroNode scale={[rig.scale, rig.scale, rig.scale]}>
        <ViroNode position={[...rig.contentOffset]}>
          <ViroQuad
            rotation={[-90, 0, 0]}
            width={1.4}
            height={1.4}
            position={[0, 0.001, 0]}
            materials={['questRingFloor']}
            ignoreEventHandling
          />
          <StanceFloorRing anchor={anchor} outOfBounds={tracker.outOfBounds} />
          <Viro3DObject
            source={sources.arena}
            type="GLB"
            scale={arenaScale}
            position={[0, ARENA_LAYOUT.arenaBaseOffset, 0]}
            ignoreEventHandling
            onLoadEnd={() => session.assetLoaded(callbackLease, token, version, 'arena')}
            onError={() => session.assetFailed(callbackLease, token, version, 'arena')}
          />
          <QuestFighter id="blue" view={view} session={session} visible={false} />
          <QuestFighter id="red" view={view} session={session} />
        </ViroNode>
      </ViroNode>
    </ViroNode>
  );
}

function QuestMenuFallbackButtons({ buttons }: { buttons: QuestMenuButton[] }) {
  return (
    <>
      {buttons.map((button) => {
        const buttonFrame = questMenuButtonFrame(button);
        const dark =
          button.action === 'back' || button.action === 'recenter' || button.action === 'posture';
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

function QuestMenuText({ text, width, height }: { text: string; width: number; height: number }) {
  return (
    <ViroText
      text={text}
      position={[0, 0.06, 0.004]}
      scale={textScale}
      width={width / TEXT_SCALE}
      height={height / TEXT_SCALE}
      style={messageStyle}
    />
  );
}

// Hover feedback drawn by Viro in front of the layer, so pointing never redraws it.
function QuestMenuFocus({ button }: { button: QuestMenuButton }) {
  const frame = questMenuButtonFrame(button);
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
  acknowledged,
  posture,
  tracker,
  lines,
  layer,
  hover,
  onPress,
  onHover,
}: {
  page: QuestMenuPage;
  acknowledged: boolean;
  posture: QuestMenuPosture;
  tracker: QuestHeadTrackerSnapshot;
  lines: string[];
  layer: QuestMenuLayerSnapshot;
  hover: QuestMenuAction | null;
  onPress: (action: QuestMenuAction, clickState: number, source: unknown) => void;
  onHover: (action: QuestMenuAction, hovering: boolean, source: unknown) => void;
}) {
  // The layer pose (questMenuPanelPose) is built from these same two transforms.
  const frame = menuFrame(tracker.calibration);
  const pose = QUEST_MENU_POSE[page];
  const buttons = questMenuButtons(page, { acknowledged, posture });
  const hovered = buttons.find((button) => button.action === hover) ?? null;
  const textWidth = QUEST_MENU_SIZE.widthM * 0.9;
  const textHeight = QUEST_MENU_SIZE.heightM * 0.45;
  return (
    <ViroNode position={[...frame.position]} rotation={[0, frame.rotationY, 0]}>
      <ViroNode position={pose.position} rotation={pose.rotation}>
        {questMenuLayerVisible(layer.mode) ? (
          // Depth-writing, zero-alpha hole for the quad layer underneath. Drawn
          // first; whatever is in front of the panel still draws over it.
          <ViroQuad
            width={QUEST_MENU_SIZE.widthM}
            height={QUEST_MENU_SIZE.heightM}
            materials={['questMenuLayerMask']}
            renderingOrder={-100}
            ignoreEventHandling
          />
        ) : (
          <>
            <ViroQuad
              width={QUEST_MENU_SIZE.widthM}
              height={QUEST_MENU_SIZE.heightM}
              materials={['questMenuBacking']}
              ignoreEventHandling
            />
            <QuestMenuText
              text={[questMenuLayerNotice(layer), ...lines].filter(Boolean).join('\n')}
              width={textWidth}
              height={textHeight}
            />
            <QuestMenuFallbackButtons buttons={buttons} />
          </>
        )}
        {hovered ? <QuestMenuFocus button={hovered} /> : null}
        <ViroText
          text={formatDiagnostics(tracker)}
          position={[0, -QUEST_MENU_SIZE.heightM / 2 - 0.08, 0.002]}
          scale={textScale}
          width={QUEST_MENU_SIZE.widthM / TEXT_SCALE}
          height={0.14 / TEXT_SCALE}
          style={diagnosticsStyle}
        />
        {buttons.map((button) => {
          const buttonFrame = questMenuButtonFrame(button);
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
    </ViroNode>
  );
}

export default function QuestArenaScene() {
  const [session] = useState(createQuestArenaSession);
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
        status: (owner) => questPanelNative?.status(owner) ?? -1,
        hide: (owner) => questPanelNative?.hide(owner),
        log: logMenu,
      },
      { enabled: questMenuLayer.get() === 'compositor' }
    )
  );
  const layer = useSyncExternalStore(compositor.subscribe, compositor.getSnapshot);
  const [hover, setHover] = useState<QuestMenuAction | null>(null);
  const press = useRef<QuestPressState>({ down: new Set() });
  const hoverSources = useRef(new Map<QuestMenuAction, Set<number>>());
  const lastLogAt = useRef(0);
  const posture = tracker.calibration.posture;
  const calibration = tracker.calibration;

  const menuLines = useMemo(() => {
    const statusLine = tracker.message
      ? `Head rig (${posture}, ${tracker.status}): ${tracker.message}`
      : `Head rig (${posture}): ${tracker.status}.`;
    const lines = [...view.lines, statusLine];
    if (tracker.outOfBounds) lines.push('Outside bounds: return toward the stance ring center.');
    lines.push(systemRecenterHint);
    return lines;
  }, [view.lines, posture, tracker.status, tracker.message, tracker.outOfBounds]);

  // Pose, panel and hit targets all follow the requested screen at once.
  const inputKey = `${view.page}:${view.acknowledged}`;
  const inputKeyRef = useRef(inputKey);
  const visibleHover = questMenuButtons(view.page, {
    acknowledged: view.acknowledged,
    posture,
  }).some((button) => button.action === hover)
    ? hover
    : null;
  // Hover is not part of the panel image; only page, text and posture are.
  const menu = useMemo(
    () =>
      buildQuestMenu(view.page, menuLines, {
        acknowledged: view.acknowledged,
        posture,
      }),
    [menuLines, posture, view.acknowledged, view.page]
  );
  const panelLabel = `${view.page} ack=${view.acknowledged} ${posture}`;

  useEffect(() => {
    questRuntime.sceneMounted();
    return () => {
      questHeadTracker.dispose();
      session.dispose();
      compositor.dispose();
      questRuntime.sceneUnmounted();
    };
  }, [compositor, session]);

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

  // A new screen starts with no trigger held and no hover, so a press on the
  // old targets cannot act on the new ones.
  useEffect(() => {
    if (inputKeyRef.current === inputKey) return;
    inputKeyRef.current = inputKey;
    press.current.down.clear();
    hoverSources.current.clear();
    setHover(null);
  }, [inputKey]);

  useEffect(() => {
    compositor.present({
      label: panelLabel,
      pose: questMenuPanelPose(calibration, view.page).pose,
      ops: menu.ops,
    });
  }, [calibration, compositor, menu, panelLabel, view.page]);

  const onAction = (action: QuestMenuAction) => {
    logMenu('info', `action ${action} on ${view.page}`);
    if (action === 'solo') {
      if (session.solo()) {
        const next = session.getSnapshot();
        if (next.transforms) questHeadTracker.calibrateForSolo(next.transforms.blue);
      }
    } else if (action === 'ready') session.ready();
    else if (action === 'back') session.back();
    else if (action === 'recenter') questHeadTracker.recenter();
    else if (action === 'posture') questHeadTracker.cyclePosture();
    else leave(session);
  };

  return (
    <ViroScene onCameraTransformUpdate={questHeadTracker.onCameraTransform}>
      <ViroSkyBox color="#000000" />
      <ViroAmbientLight color="#ffffff" intensity={700} />
      <ViroDirectionalLight color="#ffffff" intensity={900} direction={[-0.4, -1, -0.3]} />
      {view.page === 'ring' ? <QuestRing view={view} session={session} tracker={tracker} /> : null}
      <QuestMenu
        page={view.page}
        acknowledged={view.acknowledged}
        posture={posture}
        tracker={tracker}
        lines={menuLines}
        layer={layer}
        hover={visibleHover}
        onPress={(action, clickState, source) => {
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
