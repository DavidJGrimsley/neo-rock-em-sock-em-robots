const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const { ARENA_LAYOUT } = require('../src/features/arena-fighter/arena-controller.ts');
const { ArenaMatch } = require('../src/features/arena-fighter/arena-match.ts');
const {
  DEFAULT_CALIBRATION,
  QUEST_WORLD_SCALE,
  applyRig,
  menuFrame,
  questRigTransform,
} = require('../src/features/quest-vr/quest-head-rig.ts');
const {
  QUEST_MENU_POSE,
  QUEST_MENU_SIZE,
  buildQuestMenu,
  questMenuButtonFrame,
  questMenuButtons,
} = require('../src/features/quest-vr/quest-menu-layout.ts');
const {
  questPointerHover,
  questTriggerPress,
} = require('../src/features/quest-vr/quest-menu-input.ts');
const {
  createQuestMenuTexturePipeline,
  questMenuDisplay,
  questMenuInputKey,
} = require('../src/features/quest-vr/quest-menu-texture-pipeline.ts');

const repoRoot = path.resolve(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

function readGLBMinMax(file) {
  const bytes = fs.readFileSync(path.join(repoRoot, 'assets', 'arena', file));
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const mesh of json.meshes) {
    for (const primitive of mesh.primitives) {
      const pos = json.accessors[primitive.attributes.POSITION];
      if (!pos?.min || !pos?.max) continue;
      minX = Math.min(minX, pos.min[0]);
      minY = Math.min(minY, pos.min[1]);
      minZ = Math.min(minZ, pos.min[2]);
      maxX = Math.max(maxX, pos.max[0]);
      maxY = Math.max(maxY, pos.max[1]);
      maxZ = Math.max(maxZ, pos.max[2]);
    }
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function rotateYDeg(v, deg) {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

function rotateXDeg(v, deg) {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}

function rotateZDeg(v, deg) {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

function rotateEulerDeg(v, [rx, ry, rz]) {
  return rotateYDeg(rotateXDeg(rotateZDeg(v, rz), rx), ry);
}

function addVec(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subVec(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function rayHitsRectangle(origin, target, rectCenter, rectU, rectV, rectN, halfW, halfH) {
  const dir = subVec(target, origin);
  const denom = dot(dir, rectN);
  if (Math.abs(denom) < 1e-8) return false;
  const t = dot(subVec(rectCenter, origin), rectN) / denom;
  if (t <= 0) return false;
  const hit = addVec(origin, [dir[0] * t, dir[1] * t, dir[2] * t]);
  const delta = subVec(hit, rectCenter);
  const u = dot(delta, rectU);
  const v = dot(delta, rectV);
  return Math.abs(u) <= halfW + 1e-4 && Math.abs(v) <= halfH + 1e-4;
}

test('ring-page menu rectangle placed through menuFrame(DEFAULT) clears every eye-to-opponent bounding-box ray', () => {
  const match = new ArenaMatch('solo');
  const blue = match.getTransform('blue');
  const red = match.getTransform('red');
  match.dispose();

  const rig = questRigTransform(DEFAULT_CALIBRATION, blue, QUEST_WORLD_SCALE);
  const bounds = readGLBMinMax('Mike_Player2_RedOrange_Combat_AR.glb');
  const fighterY = ARENA_LAYOUT.floorHeight + ARENA_LAYOUT.footOffset;

  const opponentCornersS3 = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const scaled = [
          x * ARENA_LAYOUT.fighterScale,
          y * ARENA_LAYOUT.fighterScale,
          z * ARENA_LAYOUT.fighterScale,
        ];
        const rotated = rotateYDeg(scaled, red.yaw);
        const s1 = [red.x + rotated[0], fighterY + red.lift + rotated[1], red.z + rotated[2]];
        opponentCornersS3.push(applyRig(rig, s1));
      }
    }
  }
  const centerS3 = applyRig(rig, [
    red.x,
    fighterY + red.lift + ((bounds.min[1] + bounds.max[1]) / 2) * ARENA_LAYOUT.fighterScale,
    red.z,
  ]);
  opponentCornersS3.push(centerS3);

  const frame = menuFrame(DEFAULT_CALIBRATION);
  const pose = QUEST_MENU_POSE.ring;
  const rectCenter = addVec(frame.position, rotateYDeg(pose.position, frame.rotationY));
  const rotatePanel = (vec) => rotateYDeg(rotateEulerDeg(vec, pose.rotation), frame.rotationY);
  const rectU = rotatePanel([1, 0, 0]);
  const rectV = rotatePanel([0, 1, 0]);
  const rectN = rotatePanel([0, 0, 1]);

  for (const corner of opponentCornersS3) {
    assert.equal(
      rayHitsRectangle(
        DEFAULT_CALIBRATION.origin,
        corner,
        rectCenter,
        rectU,
        rectV,
        rectN,
        QUEST_MENU_SIZE.widthM / 2,
        QUEST_MENU_SIZE.heightM / 2
      ),
      false,
      `Menu rectangle occluded opponent ray to ${JSON.stringify(corner)}`
    );
    const diagOffset = rotatePanel([0, -QUEST_MENU_SIZE.heightM / 2 - 0.08, 0.002]);
    const diagCenter = addVec(rectCenter, diagOffset);
    assert.equal(
      rayHitsRectangle(
        DEFAULT_CALIBRATION.origin,
        corner,
        diagCenter,
        rectU,
        rectV,
        rectN,
        QUEST_MENU_SIZE.widthM / 2,
        0.07
      ),
      false,
      `Diagnostics strip occluded opponent ray to ${JSON.stringify(corner)}`
    );
  }
});

test('Quest VR sources enforce tracking/rig safety guards and real blue asset lease with visible={false}', () => {
  const questDir = path.join(repoRoot, 'src', 'features', 'quest-vr');
  const questFiles = fs
    .readdirSync(questDir)
    .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
    .sort();
  assert.ok(questFiles.length > 0);

  const forbidden = [
    /\bViroCamera\b/,
    /\brecenterTracking\b/,
    /\bViroGameLoop(?:Utils)?\b/,
    /\bViroARScene\b/,
    /\bsetTracking\b/,
    /\bsetPlacement\b/,
  ];

  for (const file of questFiles) {
    const content = fs.readFileSync(path.join(questDir, file), 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(content, pattern, `${file} must not match ${pattern}`);
    }
  }

  const scene = source('src/features/quest-vr/quest-arena-scene.native.tsx');
  const navigator = source('src/features/quest-vr/quest-xr-navigator.native.tsx');
  assert.match(scene, /onCameraTransformUpdate=\{questHeadTracker\.onCameraTransform\}/);
  assert.match(scene, /visible=\{false\}/);
  assert.match(scene, /onLoadEnd=\{/);
  assert.match(scene, /questMenuButtonFrame/);
  assert.doesNotMatch(scene, /\bQUEST_RING_POSE\b/);
  assert.doesNotMatch(scene, /\bquestMenuHit\s*\(/);
  assert.match(navigator, /passthroughEnabled=\{false\}/);
});

function jsx(type, props, key) {
  return { type, props: props ?? {}, key };
}

function collectNodes(root) {
  const result = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    result.push(node);
    visit(node.props?.children);
  }
  visit(root);
  return result;
}

test('QuestArenaScene wires onCameraTransformUpdate, solo calibration, recenter, posture, and visible={false} blue model', () => {
  const states = [];
  const effects = [];
  let stateIndex = 0;
  let effectIndex = 0;
  let trackerSnapshot = {
    calibration: DEFAULT_CALIBRATION,
    anchor: null,
    status: 'uncalibrated',
    message: null,
    sampleHz: null,
    pose: null,
    outOfBounds: false,
    samplesSeen: 0,
  };
  let calibratedWith = null;
  let recenterCalls = 0;
  let postureCalls = 0;
  let disposeCalls = 0;
  const onCameraTransform = () => {};
  const builtMenus = [];
  const buttonLookups = [];

  const mockTracker = {
    subscribe: () => () => {},
    getSnapshot: () => trackerSnapshot,
    onCameraTransform,
    calibrateForSolo: (anchor) => {
      calibratedWith = anchor;
      trackerSnapshot = {
        ...trackerSnapshot,
        anchor,
        calibration: { ...trackerSnapshot.calibration, source: 'solo', entry: 1 },
        status: 'ready',
      };
      return trackerSnapshot.calibration;
    },
    recenter: () => {
      recenterCalls += 1;
    },
    cyclePosture: () => {
      postureCalls += 1;
      const nextPosture =
        trackerSnapshot.calibration.posture === 'standing' ? 'seated' : 'standing';
      trackerSnapshot = {
        ...trackerSnapshot,
        calibration: { ...trackerSnapshot.calibration, posture: nextPosture },
      };
      return nextPosture;
    },
    dispose: () => {
      disposeCalls += 1;
    },
  };

  let mountedCalls = 0;
  let unmountedCalls = 0;
  const mockRuntime = {
    getSnapshot: () => ({ exitRequest: null }),
    sceneMounted: () => {
      mountedCalls += 1;
    },
    sceneUnmounted: () => {
      unmountedCalls += 1;
    },
    exitRequested: () => {},
  };

  const mocks = {
    react: {
      useState: (initial) => {
        const index = stateIndex++;
        if (!(index in states)) {
          states[index] = typeof initial === 'function' ? initial() : initial;
        }
        return [
          states[index],
          (val) => {
            states[index] = typeof val === 'function' ? val(states[index]) : val;
          },
        ];
      },
      useEffect: (effect, deps) => {
        const index = effectIndex++;
        const prev = effects[index];
        const changed =
          !prev ||
          !deps ||
          !prev.deps ||
          deps.length !== prev.deps.length ||
          deps.some((dep, i) => !Object.is(dep, prev.deps[i]));
        if (changed) {
          prev?.cleanup?.();
          effects[index] = { deps, cleanup: effect() };
        }
      },
      useMemo: (fn) => fn(),
      useRef: (initial) => ({ current: initial }),
      useSyncExternalStore: (_, get) => get(),
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    expo: {
      requireNativeModule: () => ({ downloadAsync: () => Promise.resolve('file:///copied') }),
    },
    'expo-asset': {
      Asset: {
        fromModule: (id) => ({
          uri: `file:///${id}`,
          localUri: `file:///${id}`,
          hash: 'h',
          type: 'png',
        }),
      },
    },
    '@reactvision/react-viro': {
      Viro3DObject: 'Viro3DObject',
      ViroAmbientLight: 'ViroAmbientLight',
      ViroDirectionalLight: 'ViroDirectionalLight',
      ViroMaterials: { createMaterials: () => {} },
      ViroNode: 'ViroNode',
      ViroQuad: 'ViroQuad',
      ViroScene: 'ViroScene',
      ViroSkyBox: 'ViroSkyBox',
      ViroText: 'ViroText',
      exitVRScene: () => {},
    },
    '../arena-fighter/arena-controller.ts': { ARENA_LAYOUT },
    '../../../assets/arena/Fight_Arena.glb': 'arena.glb',
    '../../../assets/arena/Mike_Player1_Blue_Combat_AR.glb': 'blue.glb',
    '../../../assets/arena/Mike_Player2_RedOrange_Combat_AR.glb': 'red.glb',
    '../../../assets/arena/ui/menu-background.png': 'menu-background.png',
    '../../../assets/arena/ui/ArenaNotoSans.ttf': 'ArenaNotoSans.ttf',
    '../../../assets/arena/ui/ArenaNotoSansSemibold.ttf': 'ArenaNotoSansSemibold.ttf',
    '../../../assets/arena/ui/ArenaNotoSerif.ttf': 'ArenaNotoSerif.ttf',
    '../../../assets/arena/ui/quest-lettering/neo.png': 'neo.png',
    '../../../assets/arena/ui/quest-lettering/rock.png': 'rock.png',
    '../../../assets/arena/ui/quest-lettering/robots.png': 'robots.png',
    '../../../modules/quest-menu-texture/src/index.ts': {
      renderQuestMenuTexture: () =>
        Promise.resolve({ uri: 'file:///menu.png', width: 2048, height: 1152 }),
      prepareQuestMenuMaterial: () => Promise.resolve({ width: 2048, height: 1152, ms: 1 }),
      releaseQuestMenuMaterials: () => Promise.resolve(0),
    },
    './quest-arena-session.ts': require('../src/features/quest-vr/quest-arena-session.ts'),
    './quest-head-rig.ts': require('../src/features/quest-vr/quest-head-rig.ts'),
    './quest-head-tracker.ts': { questHeadTracker: mockTracker },
    './quest-menu-asset-uri.ts': {
      resolveQuestMenuAssetFile: async (asset) => asset.localUri ?? asset.uri,
    },
    './quest-menu-input.ts': { questPointerHover, questTriggerPress },
    './quest-menu-layout.ts': {
      QUEST_MENU_POSE,
      QUEST_MENU_SIZE,
      questMenuButtonFrame,
      questMenuButtons: (page, arg, posture) => {
        buttonLookups.push({ page, arg, posture });
        return questMenuButtons(page, arg, posture);
      },
      buildQuestMenu: (page, lines, options) => {
        builtMenus.push({ page, lines, options });
        return buildQuestMenu(page, lines, options);
      },
    },
    './quest-menu-texture-pipeline.ts': {
      createQuestMenuTexturePipeline,
      questMenuDisplay: (view) => ({
        kind: 'error',
        page: view.page,
        acknowledged: view.acknowledged,
        input: true,
        message: 'test',
      }),
      questMenuInputKey,
    },
    './quest-runtime-store.ts': { questRuntime: mockRuntime },
  };

  const output = ts.transpileModule(source('src/features/quest-vr/quest-arena-scene.native.tsx'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  const mod = { exports: {} };
  vm.runInNewContext(output, {
    module: mod,
    exports: mod.exports,
    console,
    Date,
    require: (name) => {
      if (!(name in mocks)) throw new Error('Missing mock: ' + name);
      return mocks[name];
    },
  });

  const Scene = mod.exports.default;
  const renderScene = () => {
    stateIndex = 0;
    effectIndex = 0;
    const tree = Scene();
    const all = collectNodes(tree);
    for (const node of all) {
      if (typeof node.type === 'function') {
        all.push(...collectNodes(node.type(node.props)));
      }
    }
    return { tree, all };
  };

  const initial = renderScene();
  const viroScene = initial.all.find((n) => n.type === 'ViroScene');
  assert.ok(viroScene);
  assert.equal(viroScene.props.onCameraTransformUpdate, onCameraTransform);
  assert.equal(mountedCalls, 1);

  const clickAction = (all, action) => {
    const quad = all.find(
      (n) =>
        n.type === 'ViroQuad' &&
        n.key === `hit-${action}` &&
        typeof n.props.onClickState === 'function'
    );
    assert.ok(quad, `Expected hit quad for action ${action}`);
    quad.props.onClickState(1, [0, 0, 0], 1);
    quad.props.onClickState(2, [0, 0, 0], 1);
  };

  clickAction(initial.all, 'recenter');
  assert.equal(recenterCalls, 1);

  clickAction(initial.all, 'posture');
  assert.equal(postureCalls, 1);

  clickAction(initial.all, 'solo');
  assert.ok(calibratedWith, 'Expected Solo to pass blue transform to calibrateForSolo');

  trackerSnapshot = { ...trackerSnapshot, outOfBounds: true };
  const inRing = renderScene();
  const models = inRing.all.filter((n) => n.type === 'Viro3DObject');
  const blueModel = models.find((n) => n.props.source === 'blue.glb');
  const redModel = models.find((n) => n.props.source === 'red.glb');
  assert.ok(blueModel && redModel);
  assert.equal(blueModel.props.visible, false);
  assert.notEqual(redModel.props.visible, false);
  assert.equal(typeof blueModel.props.onLoadEnd, 'function');

  const oobQuads = inRing.all.filter(
    (n) =>
      n.type === 'ViroQuad' &&
      Array.isArray(n.props.materials) &&
      n.props.materials.includes('questStanceRingOutOfBounds')
  );
  assert.equal(oobQuads.length, 4);

  assert.ok(builtMenus.some((entry) => entry.options?.posture === 'seated'));
  assert.ok(buttonLookups.some((entry) => entry.arg?.posture === 'seated'));

  for (const entry of effects) entry?.cleanup?.();
  assert.equal(disposeCalls, 1);
  assert.equal(unmountedCalls, 1);
});
