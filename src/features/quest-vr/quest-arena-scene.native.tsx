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

import { renderQuestMenuTexture } from '../../../modules/quest-menu-texture/src/index.ts';
import {
  createQuestArenaSession,
  type QuestArenaSession,
  type QuestArenaView,
} from './quest-arena-session.ts';
import {
  beginMenuTexture,
  buildQuestMenu,
  menuTextureIsCurrent,
  QUEST_MENU_POSE,
  QUEST_MENU_SIZE,
  QUEST_RING_POSE,
  questMenuButtonFrame,
  questMenuButtons,
  questMenuMaterialName,
  type MenuTextureStep,
  type QuestMenuAction,
  type QuestMenuAssets,
} from './quest-menu-layout.ts';
import { resolveQuestMenuAssetFile } from './quest-menu-asset-uri.ts';
import { questPointerHover, questTriggerPress, type QuestPressState } from './quest-menu-input.ts';
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
const idleAnimation = { name: 'IdleAggro', loop: true, run: true, interruptible: true };

ViroMaterials.createMaterials({
  questMenuBacking: { diffuseColor: '#09090b', lightingModel: 'Constant' },
  questRingFloor: { diffuseColor: '#1f2937', lightingModel: 'Constant' },
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

const fallbackStyle = {
  fontFamily: 'sans-serif',
  // Point size on a metre-sized quad. 28pt clipped the failure string to "Menu"
  // on a Quest 3S. This text is only the failure path.
  fontSize: 4,
  color: '#f8fafc',
  textAlign: 'left',
  textAlignVertical: 'top',
} as const;

function leave(session: QuestArenaSession) {
  session.exit();
  questRuntime.exitRequested('scene-exit');
  exitVRScene();
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
  textureUri,
  materialName,
  textureError,
  onPress,
  onHover,
}: {
  view: QuestArenaView;
  textureUri: string | null;
  materialName: string | null;
  textureError: string | null;
  onPress: (action: QuestMenuAction, clickState: number, source: unknown) => void;
  onHover: (action: QuestMenuAction, hovering: boolean, source: unknown) => void;
}) {
  const pose = QUEST_MENU_POSE[view.page];
  return (
    <ViroNode position={pose.position} rotation={pose.rotation}>
      <ViroQuad
        width={QUEST_MENU_SIZE.widthM}
        height={QUEST_MENU_SIZE.heightM}
        materials={['questMenuBacking']}
      />
      {textureUri && materialName ? (
        <ViroQuad
          key={textureUri}
          position={[0, 0, 0.001]}
          width={QUEST_MENU_SIZE.widthM}
          height={QUEST_MENU_SIZE.heightM}
          materials={[materialName]}
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
      {questMenuButtons(view.page, view.acknowledged).map((button) => {
        const frame = questMenuButtonFrame(button);
        return (
          <ViroQuad
            key={button.action}
            position={frame.position}
            width={frame.width}
            height={frame.height}
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
  );
}

export default function QuestArenaScene() {
  const [session] = useState(createQuestArenaSession);
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [hover, setHover] = useState<QuestMenuAction | null>(null);
  const [assets, setAssets] = useState<QuestMenuAssets | null>(null);
  const [textureUri, setTextureUri] = useState<string | null>(null);
  const [materialName, setMaterialName] = useState<string | null>(null);
  const [textureError, setTextureError] = useState<string | null>(null);
  const textureStep = useRef<MenuTextureStep>({ generation: 0, page: null });
  const shownUri = useRef<string | null>(null);
  const press = useRef<QuestPressState>({ down: new Set() });
  const hoverSources = useRef(new Map<QuestMenuAction, Set<number>>());
  const inputPage = useRef(view.page);
  const visibleHover = questMenuButtons(view.page, view.acknowledged).some(
    (button) => button.action === hover
  )
    ? hover
    : null;
  const resetInputForPage = () => {
    if (inputPage.current === view.page) return;
    inputPage.current = view.page;
    press.current.down.clear();
    hoverSources.current.clear();
    setHover(null);
  };
  const menu = useMemo(
    () =>
      buildQuestMenu(view.page, view.lines, {
        hover: visibleHover,
        acknowledged: view.acknowledged,
        assets: assets ?? undefined,
      }),
    [assets, view.acknowledged, view.lines, view.page, visibleHover]
  );

  useEffect(() => {
    questRuntime.sceneMounted();
    return () => {
      session.dispose();
      questRuntime.sceneUnmounted();
    };
  }, [session]);

  useEffect(() => {
    let cancel = false;
    const keys = Object.keys(menuAssetModules) as (keyof typeof menuAssetModules)[];
    Promise.all(
      keys.map(async (key) => {
        try {
          return [key, await localAssetUri(menuAssetModules[key])] as const;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Quest menu asset ${key} failed: ${message}`);
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
    const step = beginMenuTexture(textureStep.current, view.page);
    textureStep.current = { generation: step.generation, page: step.page };
    if (step.blank) {
      shownUri.current = null;
      setTextureUri(null);
      setMaterialName(null);
    }
    const keep = step.blank || !shownUri.current ? [] : [shownUri.current];
    let cancel = false;
    renderQuestMenuTexture(menu.ops, keep).then(
      (result) => {
        if (cancel || !menuTextureIsCurrent(step.generation, textureStep.current.generation))
          return;
        if (!result) {
          console.error('Quest menu texture failed: Menu texture module is unavailable.');
          setTextureError('Menu texture module is unavailable.');
        } else {
          const name = questMenuMaterialName(result.uri);
          ViroMaterials.createMaterials({
            [name]: {
              diffuseTexture: { uri: result.uri },
              lightingModel: 'Constant',
              blendMode: 'Alpha',
              cullMode: 'None',
            },
          });
          shownUri.current = result.uri;
          setTextureUri(result.uri);
          setMaterialName(name);
          setTextureError(null);
          console.warn(`Quest menu texture ${result.width}x${result.height} ${result.uri}`);
        }
      },
      (error: unknown) => {
        if (!cancel && menuTextureIsCurrent(step.generation, textureStep.current.generation)) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Quest menu texture failed: ${message}`);
          setTextureError(message);
        }
      }
    );
    return () => {
      cancel = true;
    };
  }, [assets, menu.ops, menu.specKey, view.page]);

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
        textureUri={textureUri}
        materialName={materialName}
        textureError={textureError}
        onPress={(action, clickState, source) => {
          resetInputForPage();
          if (questTriggerPress(press.current, clickState, source) === 'activate') onAction(action);
        }}
        onHover={(action, hovering, source) => {
          resetInputForPage();
          let sourcesForButton = hoverSources.current.get(action);
          if (!sourcesForButton) {
            sourcesForButton = new Set();
            hoverSources.current.set(action, sourcesForButton);
          }
          const active = questPointerHover(sourcesForButton, hovering, source);
          setHover((current) => {
            if (active) return action;
            return current === action ? null : current;
          });
        }}
      />
    </ViroScene>
  );
}
