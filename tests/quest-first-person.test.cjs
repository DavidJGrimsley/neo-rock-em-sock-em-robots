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
  stanceMarkerRingLocal,
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
const compositorModule = require('../src/features/quest-vr/quest-menu-compositor.ts');
const { questMenuLayer } = require('../src/features/quest-vr/quest-menu-layer.ts');
const { questMenuPanelPose } = compositorModule;

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

test('ring-page menu rectangle placed through menuFrame(DEFAULT) clears the opponent head and torso rays', () => {
  const match = new ArenaMatch('solo');
  const blue = match.getTransform('blue');
  const red = match.getTransform('red');
  match.dispose();

  const rig = questRigTransform(DEFAULT_CALIBRATION, blue, QUEST_WORLD_SCALE);
  const bounds = readGLBMinMax('Mike_Player2_RedOrange_Combat_AR.glb');
  const fighterY = ARENA_LAYOUT.floorHeight + ARENA_LAYOUT.footOffset;

  // Top corners and the bounding-box center. The lower legs may sit behind the
  // panel at its comfortable 32-degree pose (see quest-arena.test.cjs).
  const opponentCornersS3 = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.max[1]]) {
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

const flush = () => new Promise((resolve) => setImmediate(resolve));

function manualClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    pending,
    now: () => now,
    schedule(callback, delay) {
      seq += 1;
      pending.set(seq, { callback, at: now + delay });
      return seq;
    },
    cancel(handle) {
      pending.delete(handle);
    },
    advance(ms) {
      now += ms;
      for (const [handle, timer] of [...pending]) {
        if (timer.at > now) continue;
        pending.delete(handle);
        timer.callback();
      }
    },
  };
}

// Stands in for modules/quest-panel: records owners, specs and hides.
function fakePanel() {
  const panel = {
    available: true,
    status: 1,
    owner: 0,
    opened: 0,
    draws: [],
    hidden: [],
  };
  panel.native = {
    isAvailable: () => panel.available,
    open: () => {
      panel.opened += 1;
      panel.owner += 1;
      return panel.owner;
    },
    draw: (owner, json) => panel.draws.push({ owner, spec: JSON.parse(json) }),
    status: (owner) => (owner === panel.owner ? panel.status : -1),
    hide: (owner) => panel.hidden.push(owner),
  };
  panel.latest = () => panel.draws.at(-1)?.spec ?? null;
  panel.texts = (spec = panel.latest()) =>
    (spec?.ops ?? []).filter((op) => op.op === 'text').map((op) => op.text);
  return panel;
}

function createSceneHarness({ panelAvailable = true } = {}) {
  const states = [];
  const effects = [];
  const refs = [];
  let stateIndex = 0;
  let effectIndex = 0;
  let refIndex = 0;
  const calls = {
    calibratedWith: null,
    recenter: 0,
    posture: 0,
    dispose: 0,
    mounted: 0,
    unmounted: 0,
    exitVRScene: 0,
    exitRequested: [],
  };
  const logs = [];
  const panel = fakePanel();
  panel.available = panelAvailable;
  const clock = manualClock();
  const materials = {};
  const harness = {
    trackerSnapshot: {
      calibration: DEFAULT_CALIBRATION,
      anchor: null,
      status: 'uncalibrated',
      message: null,
      sampleHz: null,
      pose: null,
      outOfBounds: false,
      samplesSeen: 0,
      raw: null,
      referenceResets: 0,
    },
    calls,
    logs,
    effects,
    panel,
    clock,
    materials,
    builtMenus: [],
    buttonLookups: [],
  };
  const onCameraTransform = () => {};
  harness.onCameraTransform = onCameraTransform;

  const mockTracker = {
    subscribe: () => () => {},
    getSnapshot: () => harness.trackerSnapshot,
    onCameraTransform,
    calibrateForSolo: (anchor) => {
      calls.calibratedWith = anchor;
      harness.trackerSnapshot = {
        ...harness.trackerSnapshot,
        anchor,
        calibration: { ...harness.trackerSnapshot.calibration, source: 'solo', entry: 1 },
        status: 'ready',
      };
      return harness.trackerSnapshot.calibration;
    },
    recenter: () => {
      calls.recenter += 1;
    },
    cyclePosture: () => {
      calls.posture += 1;
      const nextPosture =
        harness.trackerSnapshot.calibration.posture === 'standing' ? 'seated' : 'standing';
      harness.trackerSnapshot = {
        ...harness.trackerSnapshot,
        calibration: { ...harness.trackerSnapshot.calibration, posture: nextPosture },
      };
      return nextPosture;
    },
    dispose: () => {
      calls.dispose += 1;
    },
  };

  const mockRuntime = {
    getSnapshot: () => ({ exitRequest: null }),
    sceneMounted: () => {
      calls.mounted += 1;
    },
    sceneUnmounted: () => {
      calls.unmounted += 1;
    },
    exitRequested: (reason) => {
      calls.exitRequested.push(reason);
    },
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
      // Refs persist across renders, so a stale target closure can be modelled.
      useRef: (initial) => {
        const index = refIndex++;
        if (!(index in refs)) refs[index] = { current: initial };
        return refs[index];
      },
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
      ViroMaterials: { createMaterials: (defs) => Object.assign(materials, defs) },
      ViroNode: 'ViroNode',
      ViroQuad: 'ViroQuad',
      ViroScene: 'ViroScene',
      ViroSkyBox: 'ViroSkyBox',
      ViroText: 'ViroText',
      exitVRScene: () => {
        calls.exitVRScene += 1;
      },
    },
    '../arena-fighter/arena-controller.ts': { ARENA_LAYOUT },
    '../../../assets/arena/Fight_Arena.glb': 'arena.glb',
    '../../../assets/arena/Mike_Player1_Blue_Combat_AR.glb': 'blue.glb',
    '../../../assets/arena/Mike_Player2_RedOrange_Combat_AR.glb': 'red.glb',
    '../../../modules/quest-panel/src/index.ts': {
      questPanelAvailable: () => panel.native.isAvailable(),
      questPanelNative: panel.native,
    },
    './quest-arena-session.ts': require('../src/features/quest-vr/quest-arena-session.ts'),
    './quest-head-rig.ts': require('../src/features/quest-vr/quest-head-rig.ts'),
    './quest-head-tracker.ts': { questHeadTracker: mockTracker },
    './quest-menu-compositor.ts': {
      ...compositorModule,
      // Polls run on a manual clock, so no test leaves a real timer behind.
      createQuestMenuCompositor: (backend, options) =>
        compositorModule.createQuestMenuCompositor(backend, { ...options, clock }),
    },
    './quest-menu-input.ts': { questPointerHover, questTriggerPress },
    './quest-menu-layer.ts': { questMenuLayer },
    './quest-menu-layout.ts': {
      QUEST_MENU_POSE,
      QUEST_MENU_SIZE,
      questMenuButtonFrame,
      questMenuButtons: (page, arg, posture) => {
        harness.buttonLookups.push({ page, arg, posture });
        return questMenuButtons(page, arg, posture);
      },
      buildQuestMenu: (page, lines, options) => {
        harness.builtMenus.push({ page, lines, options });
        return buildQuestMenu(page, lines, options);
      },
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

  const capture = (...args) => logs.push(args.map(String).join(' '));
  const mod = { exports: {} };
  vm.runInNewContext(output, {
    module: mod,
    exports: mod.exports,
    console: { ...console, warn: capture, error: capture, log: capture },
    Date,
    setTimeout,
    clearTimeout,
    require: (name) => {
      if (!(name in mocks)) throw new Error('Missing mock: ' + name);
      return mocks[name];
    },
  });

  const Scene = mod.exports.default;
  harness.render = () => {
    stateIndex = 0;
    effectIndex = 0;
    refIndex = 0;
    const tree = Scene();
    const all = collectNodes(tree);
    for (const node of all) {
      if (typeof node.type === 'function') {
        all.push(...collectNodes(node.type(node.props)));
      }
    }
    return { tree, all };
  };
  // Lets asset resolution settle, re-rendering between.
  harness.settle = async () => {
    for (let i = 0; i < 6; i += 1) {
      await flush();
      harness.render();
    }
    return harness.render();
  };
  // One native status poll (100 ms while pending).
  harness.poll = () => {
    clock.advance(100);
    return harness.render();
  };
  harness.unmount = () => {
    for (const entry of effects) entry?.cleanup?.();
  };
  return harness;
}

function hitQuad(all, action) {
  return all.find(
    (n) =>
      n.type === 'ViroQuad' &&
      n.key === `hit-${action}` &&
      typeof n.props.onClickState === 'function'
  );
}

function clickAction(all, action, source = 1) {
  const quad = hitQuad(all, action);
  assert.ok(quad, `Expected hit quad for action ${action}`);
  quad.props.onClickState(1, [0, 0, 0], source);
  quad.props.onClickState(2, [0, 0, 0], source);
}

function hoverAction(all, action, hovering, source = 1) {
  const quad = hitQuad(all, action);
  assert.ok(quad, `Expected hit quad for action ${action}`);
  quad.props.onHover(hovering, [0, 0, 0], source);
}

const hasText = (all, text) => all.some((n) => n.type === 'ViroText' && n.props.text === text);
const withMaterial = (all, name) =>
  all.filter(
    (n) =>
      n.type === 'ViroQuad' && Array.isArray(n.props.materials) && n.props.materials[0] === name
  );
const fallbackQuads = (all) =>
  all.filter(
    (n) =>
      n.type === 'ViroQuad' &&
      Array.isArray(n.props.materials) &&
      String(n.props.materials[0]).startsWith('questMenuFallback')
  );

// The panel node: the child of menuFrame posed by QUEST_MENU_POSE[page].
function panelNode(all) {
  return all.find(
    (n) =>
      n.type === 'ViroNode' &&
      Object.values(QUEST_MENU_POSE).some((pose) => pose.position === n.props.position)
  );
}

const MENU_LABELS = ['Solo', 'Recenter', 'Standing', 'Exit'];
const RING_LABELS = ['Ready', 'Back', 'Exit', 'Recenter'];

test('QuestArenaScene wires onCameraTransformUpdate, solo calibration, recenter, posture, and visible={false} blue model', () => {
  questMenuLayer.set('compositor');
  const harness = createSceneHarness();
  const { calls, panel } = harness;

  const initial = harness.render();
  // The first frame already hands the layer a complete, usable menu; nothing waits on art.
  assert.equal(panel.opened, 1);
  assert.equal(panel.draws.length, 1);
  for (const label of MENU_LABELS) assert.ok(panel.texts().includes(label), `layer label ${label}`);
  assert.deepEqual(
    panel.latest().pose,
    questMenuPanelPose(DEFAULT_CALIBRATION, 'menu').pose.map((v) => Math.round(v * 1e5) / 1e5 || 0)
  );
  assert.equal(withMaterial(initial.all, 'questMenuLayerMask').length, 1);
  assert.equal(fallbackQuads(initial.all).length, 0, 'no Viro loading block over the layer');
  for (const action of ['solo', 'recenter', 'posture', 'exit']) {
    assert.ok(hitQuad(initial.all, action), `missing hit target ${action}`);
  }
  assert.equal(
    initial.all.some(
      (node) => node.type === 'ViroText' && /Loading|loading/.test(String(node.props.text))
    ),
    false
  );
  const viroScene = initial.all.find((n) => n.type === 'ViroScene');
  assert.ok(viroScene);
  assert.equal(viroScene.props.onCameraTransformUpdate, harness.onCameraTransform);
  assert.equal(calls.mounted, 1);

  clickAction(initial.all, 'recenter');
  assert.equal(calls.recenter, 1);

  clickAction(initial.all, 'posture');
  assert.equal(calls.posture, 1);

  clickAction(initial.all, 'solo');
  assert.ok(calls.calibratedWith, 'Expected Solo to pass blue transform to calibrateForSolo');

  harness.trackerSnapshot = { ...harness.trackerSnapshot, outOfBounds: true };
  const inRing = harness.render();
  const models = inRing.all.filter((n) => n.type === 'Viro3DObject');
  const blueModel = models.find((n) => n.props.source === 'blue.glb');
  const redModel = models.find((n) => n.props.source === 'red.glb');
  assert.ok(blueModel && redModel);
  assert.equal(blueModel.props.visible, false);
  assert.notEqual(redModel.props.visible, false);
  assert.equal(typeof blueModel.props.onLoadEnd, 'function');

  const oobQuads = withMaterial(inRing.all, 'questStanceRingOutOfBounds');
  assert.equal(oobQuads.length, 4);

  // The stance marker is centered under the eyes; the fighters keep their feet.
  const markerNode = inRing.all.find(
    (n) =>
      n.type === 'ViroNode' &&
      collectNodes(n.props.children).some(
        (child) =>
          Array.isArray(child.props?.materials) &&
          child.props.materials.includes('questStanceRingOutOfBounds')
      ) &&
      !collectNodes(n.props.children).some((child) => child.type === 'Viro3DObject')
  );
  assert.ok(markerNode);
  const marker = stanceMarkerRingLocal(calls.calibratedWith);
  assert.ok(Math.abs(markerNode.props.position[0] - marker[0]) < 1e-12);
  assert.ok(Math.abs(markerNode.props.position[2] - marker[2]) < 1e-12);
  assert.ok(Math.abs(markerNode.props.position[1] - (marker[1] + 0.0005)) < 1e-12);
  assert.notEqual(markerNode.props.position[0], calls.calibratedWith.x);
  assert.equal(blueModel.props.position[0], calls.calibratedWith.x);
  assert.equal(blueModel.props.position[2], calls.calibratedWith.z);

  assert.ok(harness.builtMenus.some((entry) => entry.options?.posture === 'seated'));
  assert.ok(harness.buttonLookups.some((entry) => entry.arg?.posture === 'seated'));

  harness.unmount();
  assert.equal(calls.dispose, 1);
  assert.equal(calls.unmounted, 1);
  assert.deepEqual(panel.hidden, [1], 'unmount hides the layer once');
  assert.equal(harness.clock.pending.size, 0, 'no status poll outlives the scene');
});

test('controller trigger hits flip the Posture label and Exit leaves; gaze never activates', () => {
  questMenuLayer.set('compositor');
  const harness = createSceneHarness();
  const { calls, panel } = harness;
  let frame = harness.render();
  assert.ok(panel.texts().includes('Standing'));

  // Gaze (source 12) and grips are ignored.
  clickAction(frame.all, 'posture', 12);
  clickAction(frame.all, 'exit', 12);
  assert.equal(calls.posture, 0);
  assert.equal(calls.exitVRScene, 0);

  // Left trigger (1) flips the label in the very next panel image.
  const before = panel.draws.length;
  clickAction(frame.all, 'posture', 1);
  assert.equal(calls.posture, 1);
  frame = harness.render();
  assert.equal(panel.draws.length, before + 1);
  assert.ok(panel.texts().includes('Seated'));
  assert.ok(!panel.texts().includes('Standing'));

  // Right trigger (4) on Exit leaves VR.
  clickAction(frame.all, 'exit', 4);
  assert.equal(calls.exitVRScene, 1);
  assert.deepEqual(calls.exitRequested, ['scene-exit']);
  assert.ok(harness.logs.some((line) => /QuestMenu action exit on menu/.test(line)));
  assert.ok(
    harness.logs.some((line) => /QuestMenu click exit state 1 source 4 activate/.test(line))
  );
  harness.unmount();
});

test('page changes move the layer, panel and targets together with no loading block, and stale targets log the guard', async () => {
  questMenuLayer.set('compositor');
  const harness = createSceneHarness();
  const { panel } = harness;
  let frame = await harness.settle();
  // Clean compositor UI draws immediately with roundRect/text ops and zero image assets.
  assert.ok(panel.latest().ops.every((op) => op.op === 'roundRect' || op.op === 'text'));
  assert.match(panel.latest().label, /^menu ack=false standing$/);
  frame = harness.poll();
  assert.ok(harness.logs.some((line) => /QuestMenu layer shown after/.test(line)));
  assert.equal(panelNode(frame.all).props.position, QUEST_MENU_POSE.menu.position);
  const staleMenu = frame.all;

  // Solo: the ring panel, its pose, and its targets arrive in the same render.
  clickAction(frame.all, 'solo', 1);
  frame = harness.render();
  assert.equal(panelNode(frame.all).props.position, QUEST_MENU_POSE.ring.position);
  for (const label of RING_LABELS) assert.ok(panel.texts().includes(label), `ring layer ${label}`);
  assert.ok(!panel.texts().includes('Solo'));
  const ringPose = questMenuPanelPose(harness.trackerSnapshot.calibration, 'ring').pose;
  assert.deepEqual(
    panel.latest().pose,
    ringPose.map((v) => Math.round(v * 1e5) / 1e5 || 0)
  );
  assert.equal(fallbackQuads(frame.all).length, 0, 'no fallback block during navigation');
  assert.equal(withMaterial(frame.all, 'questMenuLayerMask').length, 1);
  for (const action of ['ready', 'back', 'exit', 'recenter', 'posture']) {
    assert.ok(hitQuad(frame.all, action), `ring hit ${action}`);
  }
  assert.ok(!hitQuad(frame.all, 'solo'));

  // A press on a target from the previous screen is dropped and logged once.
  clickAction(staleMenu, 'exit', 1);
  assert.equal(harness.calls.exitVRScene, 0);
  const blocked = harness.logs.filter((line) => /QuestMenu click exit blocked/.test(line));
  assert.equal(blocked.length, 1);
  assert.match(blocked[0], /source 1$/);

  // Ready -> Set redraws in place; the target stays live and a second press is harmless.
  clickAction(frame.all, 'ready', 1);
  frame = harness.render();
  assert.ok(panel.texts().includes('Set'));
  clickAction(frame.all, 'ready', 1);
  frame = harness.render();
  assert.ok(panel.texts().includes('Set'));

  // Back works at once and the menu panel returns at its pose.
  clickAction(frame.all, 'back', 1);
  frame = harness.render();
  assert.equal(panelNode(frame.all).props.position, QUEST_MENU_POSE.menu.position);
  assert.ok(panel.texts().includes('Solo'));
  assert.ok(hitQuad(frame.all, 'solo'));
  // Solo/Back repeatedly never leaves a dead or Viro-drawn interval.
  for (let round = 0; round < 10; round += 1) {
    clickAction(frame.all, 'solo', round % 2 ? 4 : 1);
    frame = harness.render();
    assert.ok(hitQuad(frame.all, 'back'), `round ${round} ring`);
    assert.equal(fallbackQuads(frame.all).length, 0);
    clickAction(frame.all, 'back', round % 2 ? 1 : 4);
    frame = harness.render();
    assert.ok(hitQuad(frame.all, 'solo'), `round ${round} menu`);
    assert.equal(fallbackQuads(frame.all).length, 0);
  }
  assert.equal(panel.opened, 1, 'one owner for the whole scene');
  clickAction(frame.all, 'exit', 1);
  assert.equal(harness.calls.exitVRScene, 1);
  harness.unmount();
});

test('pointer hover draws a Viro outline and never redraws the panel; gaze does not hover', async () => {
  questMenuLayer.set('compositor');
  const harness = createSceneHarness();
  const { panel } = harness;
  let frame = await harness.settle();
  const drawn = panel.draws.length;

  hoverAction(frame.all, 'solo', true, 12);
  frame = harness.render();
  assert.equal(withMaterial(frame.all, 'questMenuFocus').length, 0, 'gaze moves no highlight');

  hoverAction(frame.all, 'solo', true, 1);
  frame = harness.render();
  const focus = withMaterial(frame.all, 'questMenuFocus');
  assert.equal(focus.length, 4);
  assert.ok(focus.every((quad) => quad.props.ignoreEventHandling === true));
  const solo = questMenuButtons('menu', { acknowledged: false, posture: 'standing' }).find(
    (button) => button.action === 'solo'
  );
  // The outline's own node is the one whose direct children are the four edges.
  const focusNode = frame.all.find(
    (n) => n.type === 'ViroNode' && [n.props.children].flat(2).some((c) => focus.includes(c))
  );
  const soloFrame = questMenuButtonFrame(solo);
  assert.equal(focusNode.props.position[0], soloFrame.position[0]);
  assert.equal(focusNode.props.position[1], soloFrame.position[1]);
  // In front of the mask, behind the hit target, so it never takes the ray.
  assert.ok(focusNode.props.position[2] > 0 && focusNode.props.position[2] < soloFrame.position[2]);

  hoverAction(frame.all, 'recenter', true, 4);
  hoverAction(frame.all, 'solo', false, 1);
  frame = harness.render();
  assert.equal(withMaterial(frame.all, 'questMenuFocus').length, 4);
  hoverAction(frame.all, 'recenter', false, 4);
  frame = harness.render();
  assert.equal(withMaterial(frame.all, 'questMenuFocus').length, 0);
  assert.equal(panel.draws.length, drawn, 'hover never sends a new panel image');
  assert.ok(harness.builtMenus.every((entry) => entry.options?.hover === undefined));
  harness.unmount();
});

test('a failed or missing layer falls back to Viro buttons that still work', async () => {
  questMenuLayer.set('compositor');
  const failed = createSceneHarness();
  let frame = failed.render();
  failed.panel.status = -1;
  frame = failed.poll();
  assert.equal(withMaterial(frame.all, 'questMenuLayerMask').length, 0);
  assert.equal(withMaterial(frame.all, 'questMenuBacking').length, 1);
  assert.equal(fallbackQuads(frame.all).length, 4);
  for (const label of MENU_LABELS) assert.ok(hasText(frame.all, label), `fallback ${label}`);
  assert.ok(frame.all.some((n) => n.type === 'ViroText' && /menu layer failed/.test(n.props.text)));
  assert.deepEqual(failed.panel.hidden, [1], 'a failed layer is hidden');
  assert.ok(failed.logs.some((line) => /QuestMenu layer failed: renderer status -1/.test(line)));
  const sent = failed.panel.draws.length;
  clickAction(frame.all, 'solo', 1);
  frame = failed.render();
  assert.ok(hasText(frame.all, 'Ready'));
  assert.equal(failed.panel.draws.length, sent, 'no draws after failure');
  failed.unmount();
  assert.deepEqual(failed.panel.hidden, [1]);

  // A renderer without the menu layer never opens one.
  const missing = createSceneHarness({ panelAvailable: false });
  frame = missing.render();
  assert.equal(missing.panel.opened, 0);
  assert.equal(fallbackQuads(frame.all).length, 4);
  assert.ok(
    frame.all.some((n) => n.type === 'ViroText' && /no headset menu layer/.test(n.props.text))
  );
  clickAction(frame.all, 'exit', 4);
  assert.equal(missing.calls.exitVRScene, 1);
  missing.unmount();

  // The launcher choice applies to the next scene.
  questMenuLayer.set('viro');
  const off = createSceneHarness();
  frame = off.render();
  assert.equal(off.panel.opened, 0);
  assert.equal(fallbackQuads(frame.all).length, 4);
  off.unmount();
  questMenuLayer.set('compositor');

  // A slow first frame shows Viro buttons until the layer appears.
  const slow = createSceneHarness();
  slow.panel.status = 0;
  frame = slow.render();
  for (let i = 0; i < 20; i += 1) frame = slow.poll();
  assert.equal(fallbackQuads(frame.all).length, 4);
  slow.panel.status = 1;
  frame = slow.poll();
  assert.equal(fallbackQuads(frame.all).length, 0);
  assert.equal(withMaterial(frame.all, 'questMenuLayerMask').length, 1);
  slow.unmount();
});

test('only menu hit targets take rays: scenery, mask, labels and outline ignore events', () => {
  questMenuLayer.set('compositor');
  const harness = createSceneHarness();
  let frame = harness.render();
  clickAction(frame.all, 'solo', 1);
  frame = harness.render();
  // Viro nodes only; the QuestMenu element itself carries the callbacks as props.
  const interactive = frame.all.filter(
    (n) =>
      typeof n.type === 'string' &&
      (typeof n.props.onClickState === 'function' || typeof n.props.onHover === 'function')
  );
  assert.deepEqual(interactive.map((n) => n.key).sort(), [
    'hit-back',
    'hit-exit',
    'hit-posture',
    'hit-ready',
    'hit-recenter',
  ]);
  for (const node of frame.all) {
    if (node.type === 'Viro3DObject')
      assert.equal(node.props.ignoreEventHandling, true, node.props.source);
    if (node.type === 'ViroQuad' && !String(node.key).startsWith('hit-'))
      assert.equal(node.props.ignoreEventHandling, true, JSON.stringify(node.props.materials));
  }
  // Hit targets match the drawn buttons and sit in front of the mask.
  const buttons = questMenuButtons('ring', { acknowledged: false, posture: 'standing' });
  for (const button of buttons) {
    const quad = hitQuad(frame.all, button.action);
    const expected = questMenuButtonFrame(button);
    assert.deepEqual(quad.props.position, expected.position);
    assert.equal(quad.props.width, expected.width);
    assert.equal(quad.props.height, expected.height);
    assert.ok(expected.position[2] > 0);
    // The scene runs in a vm realm, so compare copies.
    assert.deepEqual([...quad.props.materials], ['questMenuHit']);
  }
  const mask = withMaterial(frame.all, 'questMenuLayerMask')[0];
  assert.equal(mask.props.renderingOrder, -100);
  assert.equal(mask.props.width, QUEST_MENU_SIZE.widthM);
  assert.equal(mask.props.height, QUEST_MENU_SIZE.heightM);
  // The registered materials: a depth-writing zero-alpha hole, invisible hits.
  const { questMenuLayerMask, questMenuHit } = harness.materials;
  assert.equal(questMenuLayerMask.writesToDepthBuffer, true);
  assert.equal(questMenuLayerMask.blendMode, 'None');
  assert.equal(questMenuLayerMask.colorWriteMask, undefined);
  assert.equal(questMenuHit.writesToDepthBuffer, false);
  assert.deepEqual([...questMenuHit.colorWriteMask], ['None']);
  harness.unmount();
});
