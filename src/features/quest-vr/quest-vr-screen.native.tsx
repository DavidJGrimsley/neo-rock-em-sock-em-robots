import { Component, lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { router } from 'expo-router';
import {
  AppState,
  BackHandler,
  DeviceEventEmitter,
  Image,
  NativeModules,
  Platform,
  ScrollView,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '@/theme/provider';
import { GameStatusPanel } from '@/ui/game-status-panel';

import { questPanelNative } from '../../../modules/quest-panel/src/index';
import { isQuestDevice } from './quest-platform';
import {
  questRuntime,
  type QuestRuntimeSnapshot,
  type QuestVRActivityState,
} from './quest-runtime-store';

// Never loaded on phones: this is the only path to @reactvision/react-viro's Quest navigator.
const QuestXRNavigator = lazy(() => import('./quest-xr-navigator.native'));

// Exact main-menu title composition (`Neo / Rock 'Em Sock 'Em / Robots`) with transparent background.
const questSplashTitleSource =
  require('../../../assets/arena/ui/quest-lettering/quest-splash-title.png') as number;

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
      canClose: false,
    };
  if (!launcher)
    return {
      title: 'VR runtime unavailable',
      message:
        'VRLauncher is missing from this build. Rebuild with QUEST_BUILD=1 and a clean Android prebuild.',
      canEnter: false,
      canClose: false,
    };
  if (snapshot.status === 'error') {
    return {
      title: 'VR failed to launch',
      message: snapshot.lastError ?? 'The VR scene could not start.',
      canEnter: false,
      canClose: true,
      label: 'Close',
    };
  }
  return {
    title: "Neo Rock 'Em Sock 'Em Robots",
    message: '',
    canEnter: false,
    canClose: false,
    titleOnly: true,
  };
}

function QuestFloatingTitleView({
  backgroundColor,
  insets,
}: {
  backgroundColor: string;
  insets: { left: number; right: number; top: number; bottom: number };
}) {
  return (
    <View
      testID="quest-floating-title-splash"
      accessible
      accessibilityRole="header"
      accessibilityLabel="Neo Rock 'Em Sock 'Em Robots"
      style={{
        flex: 1,
        backgroundColor,
        alignItems: 'center',
        justifyContent: 'center',
        paddingLeft: Math.max(24, insets.left),
        paddingRight: Math.max(24, insets.right),
        paddingTop: Math.max(24, insets.top),
        paddingBottom: Math.max(24, insets.bottom),
      }}>
      <Image
        source={questSplashTitleSource}
        resizeMode="contain"
        style={{
          width: '82%',
          maxWidth: 520,
          aspectRatio: 1594 / 598,
          backgroundColor: 'transparent',
        }}
      />
    </View>
  );
}

export default function QuestVRScreen() {
  const { activeColors: colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSyncExternalStore(questRuntime.subscribe, questRuntime.getSnapshot);
  const quest = isQuestDevice(Platform);
  const launcher = typeof NativeModules.VRLauncher?.launchVRScene === 'function';
  const initiallyActive = AppState?.currentState === 'active';
  // Only used if MainActivity is ever reached as a fallback route; VRActivity is the primary launcher.
  const [attempt, setAttempt] = useState(() =>
    quest && launcher && initiallyActive && questRuntime.getSnapshot().status === 'idle' ? 1 : 0
  );
  const [panelMountKey, setPanelMountKey] = useState(0);
  const model = questPanelModel(snapshot, { quest, launcher });

  const closeApp = () => {
    if (!questPanelNative?.exitApp?.()) {
      BackHandler?.exitApp?.();
    }
  };

  const invokeLaunch = (launch?: () => void) => {
    const fn = launch ?? NativeModules.VRLauncher?.launchVRScene;
    if (typeof fn !== 'function') {
      questRuntime.fail(new Error('VRLauncher is unavailable.'));
      return;
    }
    try {
      fn();
    } catch (error) {
      questRuntime.fail(error);
    }
  };

  useEffect(() => {
    if (
      quest &&
      launcher &&
      AppState?.currentState === 'active' &&
      questRuntime.getSnapshot().status === 'idle'
    ) {
      questRuntime.requestEnter();
    }

    const vrStateSub = DeviceEventEmitter?.addListener?.(
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

    const handleAutoAction = (action: 'enter' | 'launch-live' | null) => {
      if (!quest || !launcher || !action) return;
      if (action === 'launch-live') {
        invokeLaunch();
      } else {
        if (!questRuntime.requestEnter()) return;
        setAttempt((value) => value + 1);
      }
    };

    const reopenSub = DeviceEventEmitter?.addListener?.('questLauncherReopen', () => {
      handleAutoAction(questRuntime.resolveLauncherReopen?.() ?? null);
    });

    let previousAppState = AppState?.currentState;
    questRuntime.appStateChanged?.(
      previousAppState !== 'background' && previousAppState !== 'inactive'
    );
    const appStateSubscription = AppState?.addEventListener?.('change', (nextState) => {
      const returnedToActive = previousAppState !== 'active' && nextState === 'active';
      previousAppState = nextState;
      questRuntime.appStateChanged?.(nextState === 'active');
      if (returnedToActive) {
        setPanelMountKey((value) => value + 1);
        handleAutoAction(questRuntime.consumeAutoReenter?.() ?? null);
      }
    });

    return () => {
      vrStateSub?.remove?.();
      reopenSub?.remove?.();
      appStateSubscription?.remove?.();
    };
  }, [launcher, quest]);

  // Leaving mid-launch would orphan the VRActivity that is about to open.
  useEffect(() => {
    if (snapshot.status !== 'launching') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [snapshot.status]);

  const panel = () => {
    if (model.titleOnly) {
      return <QuestFloatingTitleView backgroundColor="#000000" insets={insets} />;
    }
    return (
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
            actions={[
              ...(model.canClose ? [{ label: model.label ?? 'Close', onPress: closeApp }] : []),
              ...(!quest || !launcher
                ? [{ label: 'Home', onPress: () => router.dismissTo('/') }]
                : []),
            ]}
            selectableMessage
            compact
            outlinedActions={['Home']}
          />
        </View>
      </ScrollView>
    );
  };

  if (attempt === 0) return panel();
  return (
    <QuestErrorBoundary key={attempt} fallback={panel()}>
      <Suspense fallback={panel()}>
        <QuestXRNavigator renderQuestPanel={panel} />
      </Suspense>
    </QuestErrorBoundary>
  );
}
