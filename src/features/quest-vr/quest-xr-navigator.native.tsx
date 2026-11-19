import { useEffect, type ReactNode } from 'react';
import { VRQuestNavigatorBridge, ViroXRSceneNavigator } from '@reactvision/react-viro';

import QuestArenaScene from './quest-arena-scene.native';
import { questOnExitViro, questRuntime } from './quest-runtime-store';

const vrInitialScene = { scene: QuestArenaScene };

// Mounting launches VRActivity once. Later entries go through `enter` from renderQuestPanel.
export default function QuestXRNavigator({
  renderQuestPanel,
}: {
  renderQuestPanel: (enter: () => void) => ReactNode;
}) {
  // VRActivity is a separate React root, so scene crashes arrive only through the bridge.
  useEffect(() => VRQuestNavigatorBridge.onQuestError((error) => questRuntime.fail(error)), []);

  return (
    <ViroXRSceneNavigator
      style={{ flex: 1 }}
      vrInitialScene={vrInitialScene}
      passthroughEnabled={false}
      handTrackingEnabled={false}
      onExitViro={questOnExitViro}
      renderQuestPanel={renderQuestPanel}
    />
  );
}
