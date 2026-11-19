import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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

import { renderQuestMenuTexture } from '../../../modules/quest-menu-texture/src/index.ts';
import {
  createQuestArenaSession,
  type QuestArenaSession,
  type QuestArenaView,
} from './quest-arena-session.ts';
import {
  buildQuestMenu,
  QUEST_MENU_POSE,
  QUEST_MENU_SIZE,
  QUEST_RING_POSE,
  questMenuButtonFrame,
  questMenuButtons,
  type QuestMenuAction,
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
const idleAnimation = { name: 'IdleAggro', loop: true, run: true, interruptible: true };

ViroMaterials.createMaterials({
  questMenuBacking: { diffuseColor: '#101826', lightingModel: 'Constant' },
  questRingFloor: { diffuseColor: '#1f2937', lightingModel: 'Constant' },
  questMenuHover: {
    diffuseColor: '#ffffff33',
    lightingModel: 'Constant',
    blendMode: 'Alpha',
    writesToDepthBuffer: false,
  },
  // Stock Viro 3.0.3 reads colorWriteMask. The fragment keeps a missed mask from
  // painting an opaque quad over the texture. Hits are geometric, not pixels.
  questMenuHit: {
    lightingModel: 'Constant',
    blendMode: 'None',
    diffuseColor: '#000000',
    writesToDepthBuffer: false,
    cullMode: 'None',
    colorWriteMask: ['None'],
    shaderModifiers: { fragment: '_output_color = vec4(0.0);' },
  } as never,
});

let appliedMenuTexture: string | null = null;
function ensureMenuTexture(uri: string) {
  if (appliedMenuTexture === uri) return;
  appliedMenuTexture = uri;
  ViroMaterials.createMaterials({
    questMenuTexture: {
      diffuseTexture: { uri },
      lightingModel: 'Constant',
      blendMode: 'Alpha',
      cullMode: 'None',
    },
  });
}

const fallbackStyle = {
  fontFamily: 'sans-serif',
  fontSize: 28,
  color: '#f8fafc',
  textAlign: 'left',
  textAlignVertical: 'top',
} as const;

function leave(session: QuestArenaSession) {
  if (questRuntime.getSnapshot().exitRequest !== null) return;
  session.exit();
  questRuntime.exitRequested('scene-exit');
  exitVRScene();
}

function QuestFighter({
  id,
  view,
  session,
}: {
  id: FighterId;
  view: QuestArenaView;
  session: QuestArenaSession;
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
      onLoadEnd={() => session.assetLoaded(callbackLease, token, version, id)}
      onError={() => session.assetFailed(callbackLease, token, version, id)}
    />
  );
}

function QuestRing({ view, session }: { view: QuestArenaView; session: QuestArenaSession }) {
  if (view.token === null || view.placementVersion === null) return null;
  const token = view.token;
  const version = view.placementVersion;
  const callbackLease = view.lease;
  return (
    <ViroNode
      key={`${callbackLease}:${token}:${version}`}
      position={QUEST_RING_POSE.position}
      rotation={QUEST_RING_POSE.rotation}>
      <ViroQuad
        rotation={[-90, 0, 0]}
        width={1.4}
        height={1.4}
        position={[0, 0.001, 0]}
        materials={['questRingFloor']}
      />
      <Viro3DObject
        source={sources.arena}
        type="GLB"
        scale={arenaScale}
        position={[0, ARENA_LAYOUT.arenaBaseOffset, 0]}
        onLoadEnd={() => session.assetLoaded(callbackLease, token, version, 'arena')}
        onError={() => session.assetFailed(callbackLease, token, version, 'arena')}
      />
      <QuestFighter id="blue" view={view} session={session} />
      <QuestFighter id="red" view={view} session={session} />
    </ViroNode>
  );
}

function QuestMenu({
  view,
  hover,
  textureUri,
  textureError,
  onAction,
  onHover,
}: {
  view: QuestArenaView;
  hover: QuestMenuAction | null;
  textureUri: string | null;
  textureError: string | null;
  onAction: (action: QuestMenuAction) => void;
  onHover: (action: QuestMenuAction, hovering: boolean) => void;
}) {
  const pose = QUEST_MENU_POSE[view.page];
  const hovered = hover
    ? questMenuButtons(view.page).find((button) => button.action === hover)
    : null;
  const hoveredFrame = hovered ? questMenuButtonFrame(hovered) : null;
  if (textureUri) ensureMenuTexture(textureUri);
  return (
    <ViroNode position={pose.position} rotation={pose.rotation}>
      <ViroQuad
        width={QUEST_MENU_SIZE.widthM}
        height={QUEST_MENU_SIZE.heightM}
        materials={['questMenuBacking']}
      />
      {textureUri ? (
        <ViroQuad
          key={textureUri}
          position={[0, 0, 0.001]}
          width={QUEST_MENU_SIZE.widthM}
          height={QUEST_MENU_SIZE.heightM}
          materials={['questMenuTexture']}
        />
      ) : null}
      {textureError ? (
        <ViroText
          text={`Menu texture failed.\n${textureError}\n${view.lines.join('\n')}`}
          position={[0, 0, 0.004]}
          width={QUEST_MENU_SIZE.widthM * 0.9}
          height={QUEST_MENU_SIZE.heightM * 0.62}
          style={fallbackStyle}
        />
      ) : null}
      {hoveredFrame ? (
        <ViroQuad
          position={[hoveredFrame.position[0], hoveredFrame.position[1], 0.008]}
          width={hoveredFrame.width}
          height={hoveredFrame.height}
          materials={['questMenuHover']}
        />
      ) : null}
      {questMenuButtons(view.page).map((button) => {
        const frame = questMenuButtonFrame(button);
        return (
          <ViroQuad
            key={button.action}
            position={frame.position}
            width={frame.width}
            height={frame.height}
            materials={['questMenuHit']}
            onClick={() => onAction(button.action)}
            onHover={(isHovering: boolean) => onHover(button.action, isHovering)}
          />
        );
      })}
    </ViroNode>
  );
}

export default function QuestArenaScene() {
  const [session] = useState(createQuestArenaSession);
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [hover, setHover] = useState<QuestMenuAction | null>(null);
  const [textureUri, setTextureUri] = useState<string | null>(null);
  const [textureError, setTextureError] = useState<string | null>(null);
  const menu = useMemo(() => buildQuestMenu(view.page, view.lines), [view.page, view.lines]);
  const shownHover = questMenuButtons(view.page).some((button) => button.action === hover)
    ? hover
    : null;

  useEffect(() => {
    questRuntime.sceneMounted();
    return () => {
      session.dispose();
      questRuntime.sceneUnmounted();
    };
  }, [session]);

  useEffect(() => {
    let cancel = false;
    renderQuestMenuTexture(menu.ops).then(
      (result) => {
        if (cancel) return;
        if (!result) setTextureError('Menu texture module is unavailable.');
        else {
          setTextureUri(result.uri);
          setTextureError(null);
        }
      },
      (error: unknown) => {
        if (!cancel) setTextureError(error instanceof Error ? error.message : String(error));
      }
    );
    return () => {
      cancel = true;
    };
  }, [menu.specKey, menu.ops]);

  const onAction = (action: QuestMenuAction) => {
    if (action === 'solo') session.solo();
    else if (action === 'ready') session.ready();
    else if (action === 'back') session.back();
    else leave(session);
  };

  return (
    <ViroScene>
      <ViroSkyBox color="#000000" />
      <ViroAmbientLight color="#ffffff" intensity={700} />
      <ViroDirectionalLight color="#ffffff" intensity={900} direction={[-0.4, -1, -0.3]} />
      {view.page === 'ring' ? <QuestRing view={view} session={session} /> : null}
      <QuestMenu
        view={view}
        hover={shownHover}
        textureUri={textureUri}
        textureError={textureError}
        onAction={onAction}
        onHover={(action, hovering) => setHover(hovering ? action : null)}
      />
    </ViroScene>
  );
}
