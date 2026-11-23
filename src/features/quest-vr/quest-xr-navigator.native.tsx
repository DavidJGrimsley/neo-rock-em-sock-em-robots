import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AppRegistry,
  AppState,
  BackHandler,
  DeviceEventEmitter,
  StyleSheet,
  findNodeHandle,
} from 'react-native';
import {
  VRQuestNavigatorBridge,
  ViroAmbientLight,
  ViroBox,
  ViroMaterials,
  ViroScene,
  ViroSkyBox,
  ViroText,
  ViroVRSceneNavigator,
  ViroXRSceneNavigator,
} from '@reactvision/react-viro';

import { questPanelNative } from '../../../modules/quest-panel/src/index';
import QuestArenaScene from './quest-arena-scene.native';
import { questOnExitViro, questRuntime, type QuestVRActivityState } from './quest-runtime-store';

const vrInitialScene = { scene: QuestArenaScene };

const defaultRendererConfig = {
  hdrEnabled: true,
  bloomEnabled: false,
  passthroughEnabled: false,
  handTrackingEnabled: false,
  onExitViro: questOnExitViro,
};

const VR_ACTIVITY_STATES = new Set<QuestVRActivityState>([
  'unknown',
  'resumed',
  'paused',
  'stopped',
  'finishing',
  'destroyed',
]);

ViroMaterials?.createMaterials?.({
  questFailureExitButton: { diffuseColor: '#d99a9a', lightingModel: 'Constant' },
});

/** Closes all Android tasks for the Quest app without relaunching a 2D panel through Home. */
export function questExitApp(): boolean {
  if (typeof questPanelNative?.exitApp === 'function') {
    return Boolean(questPanelNative.exitApp());
  }
  BackHandler?.exitApp?.();
  return false;
}

/**
 * Truthful in-headset failure scene shown if an unrecoverable JS/React error prevents
 * QuestArenaScene from rendering, rather than hanging on an infinite black screen or looping.
 */
export function QuestFailureScene({
  errorMessage = 'The VR scene could not start.',
}: {
  errorMessage?: string;
}) {
  return (
    <ViroScene>
      <ViroSkyBox color="#000000" />
      <ViroAmbientLight color="#ffffff" intensity={800} />
      <ViroText
        text={`Unable to start VR\n${errorMessage}\nSelect Exit or press Back to close.`}
        position={[0, 0.25, -1.6]}
        scale={[0.05, 0.05, 0.05]}
        width={28}
        height={12}
        style={{
          fontFamily: 'sans-serif',
          fontSize: 22,
          color: '#f8fafc',
          textAlign: 'center',
          textAlignVertical: 'center',
        }}
      />
      <ViroBox
        position={[0, -0.25, -1.5]}
        width={0.45}
        height={0.14}
        length={0.04}
        materials={['questFailureExitButton']}
        onClickState={(clickState: number) => {
          if (clickState === 1) {
            questRuntime.exitRequested('failure-exit');
            questExitApp();
          }
        }}
      />
      <ViroText
        text="Exit"
        position={[0, -0.25, -1.46]}
        scale={[0.05, 0.05, 0.05]}
        width={8}
        height={2.4}
        style={{
          fontFamily: 'sans-serif-medium',
          fontSize: 26,
          color: '#09090b',
          textAlign: 'center',
          textAlignVertical: 'center',
        }}
      />
    </ViroScene>
  );
}

class QuestVRSceneErrorBoundary extends Component<
  { children: ReactNode },
  { errorMessage: string | null }
> {
  state = { errorMessage: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { errorMessage: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown) {
    questRuntime.fail(error);
  }

  render() {
    if (this.state.errorMessage !== null) {
      const errorMessage = this.state.errorMessage;
      return (
        <ViroVRSceneNavigator
          initialScene={{
            scene: () => <QuestFailureScene errorMessage={errorMessage} />,
          }}
          hdrEnabled
          bloomEnabled={false}
          passthroughEnabled={false}
          handTrackingEnabled={false}
          onExitViro={questOnExitViro}
          style={StyleSheet.absoluteFill}
        />
      );
    }
    return this.props.children;
  }
}

let lifecycleSubscriptionCount = 0;
let removeLifecycleListeners: (() => void) | null = null;

/**
 * Keeps questRuntime synchronized with native VRActivity and Android AppState transitions
 * whether VRActivity launched directly or via MainActivity.
 */
export function attachQuestRuntimeLifecycle(): () => void {
  lifecycleSubscriptionCount += 1;
  if (!removeLifecycleListeners) {
    const vrStateSub = DeviceEventEmitter?.addListener?.(
      'questVRActivityState',
      (event: { state?: unknown; finishing?: unknown } | null | undefined) => {
        const nextState =
          typeof event?.state === 'string' &&
          VR_ACTIVITY_STATES.has(event.state as QuestVRActivityState)
            ? (event.state as QuestVRActivityState)
            : 'unknown';
        questRuntime.vrActivityStateChanged(nextState, Boolean(event?.finishing));
      }
    );
    questRuntime.appStateChanged?.(
      AppState?.currentState !== 'background' && AppState?.currentState !== 'inactive'
    );
    const appStateSub = AppState?.addEventListener?.('change', (nextState) => {
      questRuntime.appStateChanged?.(nextState === 'active');
    });
    removeLifecycleListeners = () => {
      vrStateSub?.remove?.();
      appStateSub?.remove?.();
      removeLifecycleListeners = null;
    };
  }
  return () => {
    lifecycleSubscriptionCount = Math.max(0, lifecycleSubscriptionCount - 1);
    if (lifecycleSubscriptionCount === 0) {
      removeLifecycleListeners?.();
    }
  };
}

let mountedVRRoots = 0;

/**
 * Custom VRQuestScene root component for VRActivity.
 * Replaces ViroQuestEntryPoint's BackHandler (which called Viro's launchPanelThroughHome)
 * with clean app termination, attaches runtime lifecycle listeners, and wraps the scene
 * in a truthful 3D failure boundary.
 */
export function QuestVRSceneRoot() {
  registerQuestVRScene();
  const [intent, setIntent] = useState(() => VRQuestNavigatorBridge.getIntent());
  const navRef = useRef<ViroVRSceneNavigator>(null);

  useEffect(() => VRQuestNavigatorBridge.onIntent(setIntent), []);

  useEffect(() => attachQuestRuntimeLifecycle(), []);

  useEffect(() => {
    mountedVRRoots += 1;
    VRQuestNavigatorBridge.setVRActive(true);
    return () => {
      mountedVRRoots -= 1;
      if (mountedVRRoots === 0) VRQuestNavigatorBridge.setVRActive(false);
    };
  }, []);

  useEffect(() => {
    const sub = BackHandler?.addEventListener?.('hardwareBackPress', () => {
      questRuntime.exitRequested('hardware-back');
      questExitApp();
      return true;
    });
    return () => sub?.remove?.();
  }, []);

  const intentKey = intent?.intentKey ?? null;

  useEffect(() => {
    if (!intentKey) return;
    return VRQuestNavigatorBridge.subscribeOps((op) => {
      const nav = navRef.current;
      if (!nav) return;
      if (op.type === 'push') nav.push(op.scene);
      else if (op.type === 'pop') nav.pop();
      else if (op.type === 'popN') nav.popN(op.n);
      else if (op.type === 'replace') nav.replace(op.scene);
      else if (op.type === 'jump') nav.jump(op.scene);
    });
  }, [intentKey]);

  useEffect(() => {
    if (!intentKey) return;
    const t = setTimeout(() => {
      const tag = findNodeHandle(navRef.current);
      if (tag != null) VRQuestNavigatorBridge.setViewTag(tag);
    }, 100);
    return () => {
      clearTimeout(t);
      VRQuestNavigatorBridge.setViewTag(null);
    };
  }, [intentKey]);

  if (!intent) return null;

  const { initialScene, rendererConfig } = intent;

  return (
    <QuestVRSceneErrorBoundary>
      <ViroVRSceneNavigator
        ref={navRef}
        key={intent.intentKey}
        initialScene={initialScene}
        {...rendererConfig}
        style={StyleSheet.absoluteFill}
      />
    </QuestVRSceneErrorBoundary>
  );
}

let errorSubscription: (() => void) | null = null;
let sceneRootRegistered = false;

/**
 * Ensures VRQuestScene is registered with our custom root (replacing Viro's
 * launchPanelThroughHome BackHandler), attaches the Quest error relay, and seeds
 * a default scene intent so direct VRActivity launches mount immediately.
 */
export function registerQuestVRScene(): void {
  if (!sceneRootRegistered) {
    sceneRootRegistered = true;
    AppRegistry?.registerComponent?.('VRQuestScene', () => QuestVRSceneRoot);
  }
  if (!errorSubscription) {
    errorSubscription = VRQuestNavigatorBridge.onQuestError((error) => questRuntime.fail(error));
  }
  if (!VRQuestNavigatorBridge.getIntent()) {
    VRQuestNavigatorBridge.setIntent(vrInitialScene, defaultRendererConfig);
  }
}

export default function QuestXRNavigator({
  renderQuestPanel,
}: {
  renderQuestPanel: (enter: () => void) => ReactNode;
}) {
  useEffect(() => {
    registerQuestVRScene();
  }, []);

  return (
    <ViroXRSceneNavigator
      style={{ flex: 1 }}
      vrInitialScene={vrInitialScene}
      passthroughEnabled={false}
      handTrackingEnabled={false}
      // Keep HDR on so GLB PBR materials and Hable tone mapping render with
      // their intended colors; 0002 clears the OpenXR display alpha to 0 while
      // the panel layer is submitted so tone mapping preserves the mask hole.
      hdrEnabled
      bloomEnabled={false}
      onExitViro={questOnExitViro}
      renderQuestPanel={renderQuestPanel}
    />
  );
}
