import { Component, lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { router } from 'expo-router';
import {
  AppState,
  BackHandler,
  DeviceEventEmitter,
  NativeModules,
  Platform,
  ScrollView,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '@/theme/provider';
import { GameStatusPanel } from '@/ui/game-status-panel';

import { isQuestDevice } from './quest-platform';
import {
  questRuntime,
  type QuestRuntimeSnapshot,
  type QuestVRActivityState,
} from './quest-runtime-store';

// Never loaded on phones: this is the only path to @reactvision/react-viro's Quest navigator.
const QuestXRNavigator = lazy(() => import('./quest-xr-navigator.native'));

class QuestErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    questRuntime.fail(error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const VR_ACTIVITY_STATES = new Set<QuestVRActivityState>([
  'unknown',
  'resumed',
  'paused',
  'stopped',
  'finishing',
  'destroyed',
]);

export function questPanelModel(
  snapshot: QuestRuntimeSnapshot,
  { quest, launcher }: { quest: boolean; launcher: boolean }
) {
  if (!quest)
    return {
      title: 'Quest only',
      message: 'The VR runtime opens on Meta Quest. Phones use the AR arena from Home.',
      canEnter: false,
    };
  if (!launcher)
    return {
      title: 'VR runtime unavailable',
      message:
        'VRLauncher is missing from this build. Rebuild with QUEST_BUILD=1 and a clean Android prebuild.',
      canEnter: false,
    };
  const entered = snapshot.entries > 0 ? ` Entered ${snapshot.entries}×.` : '';
  const reentryLabel =
    snapshot.entries > 0 || snapshot.reentryCount > 0 ? 'Re-enter VR' : 'Enter VR';
  switch (snapshot.status) {
    case 'launching':
      return {
        title: 'Opening VR',
        message: 'Put the headset view in front of you.',
        canEnter: false,
      };
    // The panel is in front while VRActivity survives (e.g. paused/stopped when Horizon OS
    // brings the panel forward). Relaunching brings the singleTask VRActivity back without a new OpenXR session.
    case 'immersive':
      if (snapshot.vrActivityState === 'paused' || snapshot.vrActivityState === 'stopped') {
        return {
          title: 'VR is paused',
          message: `The VR scene is paused while this panel is open. Select Re-enter VR to resume.${entered}`,
          canEnter: true,
          label: 'Re-enter VR',
        };
      }
      return {
        title: 'VR session active',
        message: `The VR scene is still open. Select Re-enter VR to return to it.${entered}`,
        canEnter: true,
        label: 'Re-enter VR',
      };
    case 'returned':
      return {
        title: 'Back on the panel',
        message: `Select Re-enter VR to return to the scene.${entered}`,
        canEnter: true,
        label: 'Re-enter VR',
      };
    case 'error':
      return {
        title: 'VR needs another try',
        message: `${snapshot.lastError ?? 'The VR scene stopped.'}${entered}`,
        canEnter: true,
        label: reentryLabel,
      };
    default:
      return {
        title: 'Quest VR runtime',
        message: 'A black immersive test scene with a fixed reference. Exit with Back or Exit VR.',
        canEnter: true,
        label: 'Enter VR',
      };
  }
}

export default function QuestVRScreen() {
  const { activeColors: colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSyncExternalStore(questRuntime.subscribe, questRuntime.getSnapshot);
  // 0 until the first explicit Enter; bumped to remount after a load or render failure.
  const [attempt, setAttempt] = useState(0);
  // Remounts native Compose HostViews when returning to MainActivity so buttons never retain a destroyed VRActivity lifecycle.
  const [panelMountKey, setPanelMountKey] = useState(0);
  const quest = isQuestDevice(Platform);
  const launcher = typeof NativeModules.VRLauncher?.launchVRScene === 'function';
  const model = questPanelModel(snapshot, { quest, launcher });

  useEffect(() => {
    const subscription = DeviceEventEmitter?.addListener?.(
      'questVRActivityState',
      (event: { state?: unknown; finishing?: unknown } | null | undefined) => {
        const nextState =
          typeof event?.state === 'string' &&
          VR_ACTIVITY_STATES.has(event.state as QuestVRActivityState)
            ? (event.state as QuestVRActivityState)
            : 'unknown';
        const finishing = Boolean(event?.finishing);
        questRuntime.vrActivityStateChanged(nextState, finishing);
        if (nextState !== 'resumed') {
          setPanelMountKey((value) => value + 1);
        }
      }
    );
    let previousAppState = AppState?.currentState;
    const appStateSubscription = AppState?.addEventListener?.('change', (nextState) => {
      const returnedToActive = previousAppState !== 'active' && nextState === 'active';
      previousAppState = nextState;
      if (returnedToActive) {
        setPanelMountKey((value) => value + 1);
      }
    });
    return () => {
      subscription?.remove?.();
      appStateSubscription?.remove?.();
    };
  }, []);

  // Leaving mid-launch would orphan the VRActivity that is about to open.
  useEffect(() => {
    if (snapshot.status !== 'launching') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [snapshot.status]);

  const enter = (launch?: () => void) => {
    if (!model.canEnter) return;
    // Without a mounted navigator (this screen remounted), relaunch the live VRActivity directly.
    if (
      snapshot.status === 'immersive' &&
      snapshot.vrActivityState !== 'finishing' &&
      snapshot.vrActivityState !== 'destroyed'
    ) {
      return (launch ?? NativeModules.VRLauncher?.launchVRScene)?.();
    }
    const shouldRemountNavigator = !launch || snapshot.status === 'error';
    if (!questRuntime.requestEnter()) return;
    if (shouldRemountNavigator) setAttempt((value) => value + 1);
    else launch();
  };

  const panel = (launch?: () => void) => (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: 'center',
        padding: 20,
        paddingLeft: Math.max(20, insets.left),
        paddingRight: Math.max(20, insets.right),
        paddingBottom: Math.max(20, insets.bottom),
      }}>
      <View key={panelMountKey} style={{ alignSelf: 'center', width: '100%', maxWidth: 720 }}>
        <GameStatusPanel
          title={model.title}
          message={model.message}
          loading={snapshot.status === 'launching'}
          actions={[
            ...(model.canEnter
              ? [{ label: model.label ?? 'Enter VR', onPress: () => enter(launch) }]
              : []),
            ...(snapshot.status === 'launching'
              ? []
              : [{ label: 'Home', onPress: () => router.dismissTo('/') }]),
          ]}
          selectableMessage
          compact
          outlinedActions={['Home']}
        />
      </View>
    </ScrollView>
  );

  if (attempt === 0) return panel();
  return (
    <QuestErrorBoundary key={attempt} fallback={panel()}>
      <Suspense fallback={panel()}>
        <QuestXRNavigator renderQuestPanel={panel} />
      </Suspense>
    </QuestErrorBoundary>
  );
}
