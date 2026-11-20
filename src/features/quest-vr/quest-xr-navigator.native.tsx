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
      // Keep HDR/bloom off so Viro renders straight to the OpenXR eye swapchain
      // instead of alpha-blending the tone-map blit over the opaque clear (which
      // would overwrite the zero-alpha compositor mask hole back to alpha 1).
      hdrEnabled={false}
      bloomEnabled={false}
      onExitViro={questOnExitViro}
      renderQuestPanel={renderQuestPanel}
    />
  );
}
