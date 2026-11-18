import { Component, lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { router } from 'expo-router';
import { BackHandler, NativeModules, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '@/theme/provider';
import { GameStatusPanel } from '@/ui/game-status-panel';

import { isQuestDevice } from './quest-platform';
import { questRuntime, type QuestRuntimeSnapshot } from './quest-runtime-store';

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
  switch (snapshot.status) {
    case 'launching':
      return {
        title: 'Opening VR',
        message: 'Put the headset view in front of you.',
        canEnter: false,
      };
    // The panel is in front while VRActivity is still alive, e.g. after Home without a
    // finish. Relaunching brings the singleTask VRActivity back without a new intent.
    case 'immersive':
      return {
        title: 'VR is paused',
        message: 'The immersive scene is still open behind this panel.',
        canEnter: true,
        label: 'Return to VR',
      };
    case 'returned':
      return {
        title: 'Back on the panel',
        message: `Select Enter VR to return to the scene.${entered}`,
        canEnter: true,
      };
    case 'error':
      return {
        title: 'VR needs another try',
        message: `${snapshot.lastError ?? 'The VR scene stopped.'}${entered}`,
        canEnter: true,
      };
    default:
      return {
        title: 'Quest VR runtime',
        message: 'A black immersive test scene with a fixed reference. Exit with Back or Exit VR.',
        canEnter: true,
      };
  }
}

export default function QuestVRScreen() {
  const { activeColors: colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSyncExternalStore(questRuntime.subscribe, questRuntime.getSnapshot);
  // 0 until the first explicit Enter; bumped to remount after a load or render failure.
  const [attempt, setAttempt] = useState(0);
  const quest = isQuestDevice(Platform);
  const launcher = typeof NativeModules.VRLauncher?.launchVRScene === 'function';
  const model = questPanelModel(snapshot, { quest, launcher });

  // Leaving mid-launch would orphan the VRActivity that is about to open.
  useEffect(() => {
    if (snapshot.status !== 'launching') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [snapshot.status]);

  const enter = (launch?: () => void) => {
    if (!model.canEnter) return;
    // Without a mounted navigator (this screen remounted), relaunch the live VRActivity directly.
    if (snapshot.status === 'immersive')
      return (launch ?? NativeModules.VRLauncher?.launchVRScene)?.();
    if (!questRuntime.requestEnter()) return;
    if (launch) launch();
    else setAttempt((value) => value + 1);
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
      <View style={{ alignSelf: 'center', width: '100%', maxWidth: 720 }}>
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
