import { useEffect, type ReactNode } from 'react';
import { VRQuestNavigatorBridge, ViroXRSceneNavigator } from '@reactvision/react-viro';

import QuestArenaScene from './quest-arena-scene.native';
import { questOnExitViro, questRuntime } from './quest-runtime-store';

const vrInitialScene = { scene: QuestArenaScene };

const defaultRendererConfig = {
  hdrEnabled: true,
  bloomEnabled: false,
  passthroughEnabled: false,
  handTrackingEnabled: false,
  onExitViro: questOnExitViro,
};

let errorSubscription: (() => void) | null = null;

/**
 * Ensures the Quest error relay is attached and a default scene intent exists when
 * Android restores VRActivity directly without MainActivity mounting first.
 */
export function registerQuestVRScene(): void {
  if (!errorSubscription) {
    errorSubscription = VRQuestNavigatorBridge.onQuestError((error) => questRuntime.fail(error));
  }
  if (!VRQuestNavigatorBridge.getIntent()) {
    VRQuestNavigatorBridge.setIntent(vrInitialScene, defaultRendererConfig);
  }
}

// Mounting launches VRActivity once. Later entries go through `enter` from renderQuestPanel.
export default function QuestXRNavigator({
  renderQuestPanel,
}: {
  renderQuestPanel: (enter: () => void) => ReactNode;
}) {
  // VRActivity is a separate React root, so scene crashes arrive only through the bridge.
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
