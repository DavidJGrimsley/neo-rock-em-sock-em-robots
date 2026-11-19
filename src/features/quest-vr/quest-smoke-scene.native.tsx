import { useEffect } from 'react';
import {
  ViroAmbientLight,
  ViroBox,
  ViroMaterials,
  ViroNode,
  ViroQuad,
  ViroScene,
  ViroSkyBox,
  ViroText,
  exitVRScene,
} from '@reactvision/react-viro';

import { questRuntime } from './quest-runtime-store';

ViroMaterials.createMaterials({
  questReference: { diffuseColor: '#00c7ff', lightingModel: 'Constant' },
  questFloor: { diffuseColor: '#1f2937', lightingModel: 'Constant' },
  questExit: { diffuseColor: '#b91c1c', lightingModel: 'Constant' },
});

const label = {
  fontFamily: 'sans-serif',
  fontSize: 24,
  color: '#ffffff',
  textAlign: 'center',
} as const;

// The label and its backing quad are both hit targets; only the first click exits.
function exit() {
  if (questRuntime.getSnapshot().exitRequest !== null) return;
  questRuntime.exitRequested('scene-exit');
  exitVRScene();
}

// Fully virtual: a ViroScene root (no passthrough) on a black surround, with a
// stationary reference 2 m ahead so stereo and head tracking can be judged.
export default function QuestSmokeScene() {
  useEffect(() => {
    questRuntime.sceneMounted();
    return () => questRuntime.sceneUnmounted();
  }, []);

  return (
    <ViroScene>
      <ViroSkyBox color="#000000" />
      <ViroAmbientLight color="#ffffff" intensity={1000} />
      <ViroQuad
        position={[0, -1.4, -2]}
        rotation={[-90, 0, 0]}
        width={2}
        height={2}
        materials={['questFloor']}
      />
      <ViroBox position={[0, 0, -2]} scale={[0.3, 0.3, 0.3]} materials={['questReference']} />
      <ViroText
        text="Quest VR test"
        position={[0, 0.45, -2]}
        width={2}
        height={0.4}
        style={label}
      />
      <ViroNode position={[0, -0.55, -1.8]}>
        <ViroQuad width={0.7} height={0.24} materials={['questExit']} onClick={exit} />
        <ViroText
          text="Exit VR"
          position={[0, 0, 0.01]}
          width={0.7}
          height={0.24}
          style={label}
          onClick={exit}
        />
      </ViroNode>
    </ViroScene>
  );
}
