import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { requireNativeModule } from 'expo';
import { Asset } from 'expo-asset';
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

import {
  prepareQuestMenuMaterial,
  releaseQuestMenuMaterials,
  renderQuestMenuTexture,
} from '../../../modules/quest-menu-texture/src/index.ts';
import {
  createQuestArenaSession,
  type QuestArenaSession,
  type QuestArenaView,
} from './quest-arena-session.ts';
import { menuFrame, questRigTransform, type RigAnchor } from './quest-head-rig.ts';
import { questHeadTracker, type QuestHeadTrackerSnapshot } from './quest-head-tracker.ts';
import { resolveQuestMenuAssetFile } from './quest-menu-asset-uri.ts';
import { questPointerHover, questTriggerPress, type QuestPressState } from './quest-menu-input.ts';
import {
  buildQuestMenu,
  QUEST_MENU_POSE,
  QUEST_MENU_SIZE,
  questMenuButtonFrame,
  questMenuButtons,
  type QuestMenuAction,
  type QuestMenuAssets,
  type QuestMenuPosture,
} from './quest-menu-layout.ts';
import {
  createQuestMenuTexturePipeline,
  questMenuDisplay,
  questMenuInputKey,
  type QuestMenuDisplay,
} from './quest-menu-texture-pipeline.ts';
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

const menuAssetModules = {
  background: require('../../../assets/arena/ui/menu-background.png'),
  body: require('../../../assets/arena/ui/ArenaNotoSans.ttf'),
  button: require('../../../assets/arena/ui/ArenaNotoSansSemibold.ttf'),
  serif: require('../../../assets/arena/ui/ArenaNotoSerif.ttf'),
  neo: require('../../../assets/arena/ui/quest-lettering/neo.png'),
  rock: require('../../../assets/arena/ui/quest-lettering/rock.png'),
  robots: require('../../../assets/arena/ui/quest-lettering/robots.png'),
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
const stanceRingY = ARENA_LAYOUT.floorHeight + 0.0005;
const idleAnimation = { name: 'IdleAggro', loop: true, run: true, interruptible: true };
const systemRecenterHint = 'If the system recenter moved the view, select Recenter.';

// Colour-only materials have no texture to decode, so they register at import
// long before the scene mounts. Panel art materials are registered natively by
// prepareQuestMenuMaterial before a quad may name them.
ViroMaterials.createMaterials({
  questMenuBacking: { diffuseColor: '#09090b', lightingModel: 'Constant' },
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
  questMenuFallbackPrimary: { diffuseColor: '#60a5fa', lightingModel: 'Constant' },
  questMenuFallbackDanger: { diffuseColor: '#d99a9a', lightingModel: 'Constant' },
  questMenuFallbackBack: { diffuseColor: '#27272a', lightingModel: 'Constant' },
  questMenuFallbackRecenter: { diffuseColor: '#1e3a8a', lightingModel: 'Constant' },
  questMenuFallbackPosture: { diffuseColor: '#854d0e', lightingModel: 'Constant' },
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

function formatDiagnostics(tracker: QuestHeadTrackerSnapshot): string {
  const { calibration, sampleHz, pose, status } = tracker;
  const hz = sampleHz === null ? '--' : sampleHz.toFixed(0);
  const header = `Rig ${status} (${calibration.source}, ${calibration.posture}, e${calibration.entry}, ${hz}Hz)`;
  if (!pose) return `${header}\nPose: awaiting head samples`;
  const flags = `${pose.clamped ? ' CLAMP' : ''}${pose.outOfBounds ? ' OOB' : ''}`;
  return `${header}\nL ${pose.lateral.toFixed(2)}m V ${pose.vertical.toFixed(2)}m F ${pose.forward.toFixed(2)}m yaw ${pose.yawRelative.toFixed(0)}deg${flags}`;
}

async function copyPackagedMenuAsset(uri: string, hash: string | null, type: string) {
  const copied = await requireNativeModule<{
    downloadAsync(uri: string, hash: string | null, type: string): Promise<unknown>;
  }>('ExpoAsset').downloadAsync(uri, hash, type);
  if (typeof copied === 'string') return copied;
  if (copied && typeof copied === 'object' && 'uri' in copied) {
    const nested = copied.uri;
    if (typeof nested === 'string') return nested;
  }
  const text = copied == null ? '' : String(copied);
  if (!text || text === '[object Object]') {
    throw new Error('ExpoAsset.downloadAsync did not return a URI.');
  }
  return text;
}

async function localAssetUri(moduleId: number) {
  const asset = Asset.fromModule(moduleId);
  // Asset.downloadAsync() returns immediately for a release image whose localUri
  // is still the drawable resource name. Copy that name through ExpoAsset.
  return resolveQuestMenuAssetFile(
    {
      uri: asset.uri,
      localUri: asset.localUri,
      hash: asset.hash,
      type: asset.type,
    },
    copyPackagedMenuAsset
  );
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
      onLoadEnd={() => session.assetLoaded(callbackLease, token, version, id)}
      onError={() => session.assetFailed(callbackLease, token, version, id)}
    />
  );
}

function StanceFloorRing({ anchor, outOfBounds }: { anchor: RigAnchor; outOfBounds: boolean }) {
  const materials = [outOfBounds ? 'questStanceRingOutOfBounds' : 'questStanceRing'];
  return (
    <ViroNode position={[anchor.x, stanceRingY, anchor.z]} rotation={[0, anchor.yaw, 0]}>
      <ViroQuad
        position={[0, 0, stanceRingHalf]}
        rotation={[-90, 0, 0]}
        width={stanceRingSize}
        height={stanceRingThickness}
        materials={materials}
      />
      <ViroQuad
        position={[0, 0, -stanceRingHalf]}
        rotation={[-90, 0, 0]}
        width={stanceRingSize}
        height={stanceRingThickness}
        materials={materials}
      />
      <ViroQuad
        position={[-stanceRingHalf, 0, 0]}
        rotation={[-90, 0, 0]}
        width={stanceRingThickness}
        height={stanceRingSize}
        materials={materials}
      />
      <ViroQuad
        position={[stanceRingHalf, 0, 0]}
        rotation={[-90, 0, 0]}
        width={stanceRingThickness}
        height={stanceRingSize}
        materials={materials}
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
          />
          <StanceFloorRing anchor={anchor} outOfBounds={tracker.outOfBounds} />
          <Viro3DObject
            source={sources.arena}
            type="GLB"
            scale={arenaScale}
            position={[0, ARENA_LAYOUT.arenaBaseOffset, 0]}
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

function QuestMenu({
  display,
  tracker,
  posture,
  lines,
  onPress,
  onHover,
}: {
  display: QuestMenuDisplay;
  tracker: QuestHeadTrackerSnapshot;
  posture: QuestMenuPosture;
  lines: string[];
  onPress: (action: QuestMenuAction, clickState: number, source: unknown) => void;
  onHover: (action: QuestMenuAction, hovering: boolean, source: unknown) => void;
}) {
  // Pose, art, and hit targets all come from the displayed screen inside menuFrame.
  const frame = menuFrame(tracker.calibration);
  const pose = QUEST_MENU_POSE[display.page];
  const buttons = questMenuButtons(display.page, {
    acknowledged: display.acknowledged,
    posture,
  });
  const textWidth = QUEST_MENU_SIZE.widthM * 0.9;
  const textHeight = QUEST_MENU_SIZE.heightM * 0.45;
  return (
    <ViroNode position={[...frame.position]} rotation={[0, frame.rotationY, 0]}>
      <ViroNode position={pose.position} rotation={pose.rotation}>
        <ViroQuad
          width={QUEST_MENU_SIZE.widthM}
          height={QUEST_MENU_SIZE.heightM}
          materials={['questMenuBacking']}
        />
        {display.kind === 'art' ? (
          <ViroQuad
            key={display.material}
            position={[0, 0, 0.001]}
            width={QUEST_MENU_SIZE.widthM}
            height={QUEST_MENU_SIZE.heightM}
            materials={[display.material]}
          />
        ) : null}
        {display.kind === 'loading' ? (
          <QuestMenuText text="Loading the menu…" width={textWidth} height={textHeight} />
        ) : null}
        {display.kind === 'error' ? (
          <>
            <QuestMenuText
              text={`Menu art did not load: ${display.message}\n${lines.join('\n')}`}
              width={textWidth}
              height={textHeight}
            />
            {buttons.map((button) => {
              const buttonFrame = questMenuButtonFrame(button);
              const dark =
                button.action === 'back' ||
                button.action === 'recenter' ||
                button.action === 'posture';
              return (
                <ViroNode
                  key={button.action}
                  position={[buttonFrame.position[0], buttonFrame.position[1], 0.004]}>
                  <ViroQuad
                    width={buttonFrame.width}
                    height={buttonFrame.height}
                    materials={[fallbackMaterial(button.action)]}
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
        ) : null}
        <ViroText
          text={formatDiagnostics(tracker)}
          position={[0, -QUEST_MENU_SIZE.heightM / 2 - 0.08, 0.002]}
          scale={textScale}
          width={QUEST_MENU_SIZE.widthM / TEXT_SCALE}
          height={0.14 / TEXT_SCALE}
          style={diagnosticsStyle}
        />
        {display.input
          ? buttons.map((button) => {
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
            })
          : null}
      </ViroNode>
    </ViroNode>
  );
}

export default function QuestArenaScene() {
  const [session] = useState(createQuestArenaSession);
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const tracker = useSyncExternalStore(questHeadTracker.subscribe, questHeadTracker.getSnapshot);
  const [pipeline] = useState(() =>
    createQuestMenuTexturePipeline({
      render: renderQuestMenuTexture,
      prepare: prepareQuestMenuMaterial,
      release: releaseQuestMenuMaterials,
      log: logMenu,
    })
  );
  const texture = useSyncExternalStore(pipeline.subscribe, pipeline.getSnapshot);
  const [hover, setHover] = useState<QuestMenuAction | null>(null);
  const [assets, setAssets] = useState<QuestMenuAssets | null>(null);
  const press = useRef<QuestPressState>({ down: new Set() });
  const hoverSources = useRef(new Map<QuestMenuAction, Set<number>>());
  const lastLogAt = useRef(0);
  const posture = tracker.calibration.posture;

  const menuLines = useMemo(() => {
    const statusLine = tracker.message
      ? `Head rig (${posture}, ${tracker.status}): ${tracker.message}`
      : `Head rig (${posture}): ${tracker.status}.`;
    const lines = [...view.lines, statusLine];
    if (tracker.outOfBounds) lines.push('Outside bounds: return toward the stance ring center.');
    lines.push(systemRecenterHint);
    return lines;
  }, [view.lines, posture, tracker.status, tracker.message, tracker.outOfBounds]);

  const display = questMenuDisplay({ page: view.page, acknowledged: view.acknowledged }, texture);
  const inputKey = questMenuInputKey(display);
  const inputKeyRef = useRef(inputKey);
  // Hover belongs to the screen the player is pointing at. Until that screen is
  // displayed with input on, nothing is highlighted.
  const visibleHover =
    display.input &&
    display.page === view.page &&
    questMenuButtons(view.page, { acknowledged: view.acknowledged, posture }).some(
      (button) => button.action === hover
    )
      ? hover
      : null;
  const menu = useMemo(
    () =>
      buildQuestMenu(view.page, menuLines, {
        hover: visibleHover,
        acknowledged: view.acknowledged,
        posture,
        assets: assets ?? undefined,
      }),
    [assets, menuLines, posture, view.acknowledged, view.page, visibleHover]
  );

  useEffect(() => {
    questRuntime.sceneMounted();
    return () => {
      questHeadTracker.dispose();
      session.dispose();
      pipeline.dispose();
      questRuntime.sceneUnmounted();
    };
  }, [pipeline, session]);

  useEffect(() => {
    const now = Date.now();
    if (now - lastLogAt.current < 1000) return;
    lastLogAt.current = now;
    const pose = tracker.pose;
    const poseSummary = pose
      ? `lat=${pose.lateral.toFixed(2)} vert=${pose.vertical.toFixed(2)} fwd=${pose.forward.toFixed(2)} yaw=${pose.yawRelative.toFixed(1)} clamp=${pose.clamped} oob=${pose.outOfBounds}`
      : 'pose=none';
    console.warn(
      `[QuestHeadRig] status=${tracker.status} src=${tracker.calibration.source} posture=${tracker.calibration.posture} entry=${tracker.calibration.entry} hz=${tracker.sampleHz ?? 0} ${poseSummary}`
    );
  }, [tracker]);

  // A new screen, an input switch, or an error panel starts with no trigger
  // held and no hover, so a press on the old targets cannot act on the new ones.
  useEffect(() => {
    if (inputKeyRef.current === inputKey) return;
    inputKeyRef.current = inputKey;
    press.current.down.clear();
    hoverSources.current.clear();
    setHover(null);
  }, [inputKey]);

  useEffect(() => {
    let cancel = false;
    const keys = Object.keys(menuAssetModules) as (keyof typeof menuAssetModules)[];
    Promise.all(
      keys.map(async (key) => {
        try {
          return [key, await localAssetUri(menuAssetModules[key])] as const;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logMenu('error', `asset ${key} failed: ${message}`);
          return [key, null] as const;
        }
      })
    ).then((entries) => {
      if (cancel) return;
      const uri = Object.fromEntries(entries) as Record<
        keyof typeof menuAssetModules,
        string | null
      >;
      setAssets({
        ...(uri.background ? { backgroundUri: uri.background } : {}),
        fonts: {
          ...(uri.body ? { body: uri.body } : {}),
          ...(uri.button ? { button: uri.button } : {}),
          ...(uri.serif ? { serif: uri.serif } : {}),
        },
        titles: {
          ...(uri.neo ? { neo: uri.neo } : {}),
          ...(uri.rock ? { rock: uri.rock } : {}),
          ...(uri.robots ? { robots: uri.robots } : {}),
        },
      });
    });
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    if (!assets) return;
    pipeline.request({
      key: menu.specKey,
      page: view.page,
      acknowledged: view.acknowledged,
      ops: menu.ops,
    });
  }, [assets, menu, pipeline, view.acknowledged, view.page]);

  const onAction = (action: QuestMenuAction) => {
    logMenu('info', `action ${action} on ${display.page}`);
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
        display={display}
        tracker={tracker}
        posture={posture}
        lines={menuLines}
        onPress={(action, clickState, source) => {
          if (!display.input || inputKeyRef.current !== inputKey) return;
          const result = questTriggerPress(press.current, clickState, source);
          logMenu('info', `click ${action} state ${clickState} source ${String(source)} ${result}`);
          if (result === 'activate') onAction(action);
        }}
        onHover={(action, hovering, source) => {
          if (!display.input || inputKeyRef.current !== inputKey) return;
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
