const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const app = require('../app.json').expo;
const { isQuestDevice, questExperience } = require('../src/features/quest-vr/quest-platform.ts');
const {
  createQuestRuntime,
  questOnExitViro,
  questRuntime,
} = require('../src/features/quest-vr/quest-runtime-store.ts');

const source = (file) => fs.readFileSync(require.resolve('../' + file), 'utf8');

const {
  QUEST_SPLASH_IMAGE,
  QUEST_SPLASH_IMAGE_WIDTH,
} = (() => {
  const mod = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(source('app.config.ts'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    { module: mod, exports: mod.exports, process: { env: {} }, URL }
  );
  return mod.exports;
})();

function configure(env) {
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(source('app.config.ts'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    { module, exports: module.exports, process: { env }, URL }
  );
  // Plain data, so configs from separate VM realms compare structurally.
  return JSON.parse(JSON.stringify(module.exports.default({ config: structuredClone(app) })));
}
const viroOptions = (config) =>
  config.plugins.find((plugin) => plugin[0] === '@reactvision/react-viro')[1];

function component(file, mocks) {
  const output = ts.transpileModule(source(file), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (name) => {
      if (!(name in mocks)) throw new Error('Missing mock: ' + name);
      return mocks[name];
    },
  });
  return module.exports;
}
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'Fragment' };
function nodes(root) {
  const result = [];
  (function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    result.push(node);
    visit(node.props?.children);
  })(root);
  return result;
}

const quest3 = {
  OS: 'android',
  constants: { Manufacturer: 'Meta', Brand: 'meta', Model: 'Quest 3' },
};
const pixel = {
  OS: 'android',
  constants: { Manufacturer: 'Google', Brand: 'google', Model: 'Pixel 9' },
};

function fakeClock() {
  const pending = new Map();
  return {
    pending,
    schedule(callback, delay) {
      const handle = Symbol('timer');
      pending.set(handle, { callback, delay });
      return handle;
    },
    cancel: (handle) => pending.delete(handle),
    fire() {
      for (const [handle, { callback }] of [...pending]) {
        pending.delete(handle);
        callback();
      }
    },
  };
}

test('phone config is unchanged unless QUEST_BUILD is exactly 1', () => {
  const phone = configure({});
  for (const value of ['0', 'true', 'yes', ' 1', 'QUEST'])
    assert.deepEqual(configure({ QUEST_BUILD: value }), phone);
  assert.deepEqual(viroOptions(phone).android, { xRMode: ['AR'] });
  assert.equal(phone.android.blockedPermissions, undefined);
  assert.equal(phone.android.package, 'com.djleg.neorobots');
  assert.deepEqual(
    configure({ RV_API_KEY: 'k', RV_PROJECT_ID: 'p', QUEST_BUILD: '0' }),
    configure({ RV_API_KEY: 'k', RV_PROJECT_ID: 'p' })
  );
});

test('Quest config selects fully virtual OpenXR, keeps expo-camera silent and blocks unused permissions', () => {
  const phone = configure({});
  const quest = configure({ QUEST_BUILD: '1' });
  const viro = viroOptions(quest);
  assert.deepEqual(viro.android, {
    xRMode: ['QUEST'],
    questSupportedDevices: 'quest3|quest3s',
    questFeatures: { colocation: false, eyeTracking: false, passthroughCamera: false },
  });
  assert.equal(viro.provider, 'none');
  assert.deepEqual(viro.ios, viroOptions(phone).ios);
  assert.equal(quest.android.package, phone.android.package);
  const pluginNames = (config) =>
    config.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
  assert.ok(!pluginNames(phone).includes('./tools/quest/with-quest-vr-activity.cjs'));
  assert.deepEqual(pluginNames(quest), [
    ...pluginNames(phone),
    './tools/quest/with-quest-vr-activity.cjs',
    './tools/quest/with-quest-viro-renderer.cjs',
  ]);
  assert.ok(!pluginNames(phone).includes('./tools/quest/with-quest-viro-renderer.cjs'));
  const camera = quest.plugins.find((plugin) => plugin[0] === 'expo-camera')[1];
  assert.equal(camera.recordAudioAndroid, false);
  for (const permission of [
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.NFC',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'horizonos.permission.USE_ANCHOR_API',
    'com.oculus.permission.USE_SCENE',
    'com.oculus.permission.BOUNDARY_VISIBILITY',
    'horizonos.permission.HAND_TRACKING',
  ])
    assert.ok(quest.android.blockedPermissions.includes(permission), permission);
  for (const kept of ['android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE'])
    assert.ok(!quest.android.blockedPermissions.includes(kept), kept);
  // Everything except the Viro options, Quest splash plugin, and Android background/permissions matches the phone build.
  const { plugins: _questPlugins, android: _questAndroid, ...questRest } = quest;
  const { plugins: _phonePlugins, android: _phoneAndroid, ...phoneRest } = phone;
  assert.deepEqual(questRest, phoneRest);

  // Quest replaces "Powered by Expo" with the transparent main-menu title graphic on opaque #000000;
  // phone AR and iOS splash branding remain untouched.
  const splashOf = (config) =>
    config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen')[1];
  const phoneSplash = splashOf(phone);
  const questSplash = splashOf(quest);
  assert.equal(phoneSplash.dark.image, './assets/images/splash-icon-dark.png');
  assert.equal(phoneSplash.image, './assets/splash.png');
  assert.equal(phone.android.backgroundColor, '#f1f0f8');
  assert.equal(questSplash.image, QUEST_SPLASH_IMAGE);
  assert.equal(questSplash.dark.image, QUEST_SPLASH_IMAGE);
  assert.equal(questSplash.backgroundColor, '#000000');
  assert.equal(questSplash.dark.backgroundColor, '#000000');
  assert.equal(questSplash.imageWidth, QUEST_SPLASH_IMAGE_WIDTH);
  assert.equal(quest.android.backgroundColor, '#000000');
});

test('Quest splash title PNG is a faithful transparent RGBA composite from quest-lettering assets', () => {
  const path = require('node:path');
  const zlib = require('node:zlib');
  const pngPath = path.join(__dirname, '..', QUEST_SPLASH_IMAGE);
  const buf = fs.readFileSync(pngPath);
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  assert.equal(width, 1594);
  assert.equal(height, 598);
  assert.equal(bitDepth, 8);
  assert.equal(colorType, 6, 'RGBA color type required for transparent background');
  // Fits comfortably inside Android 12+ 192dp circular splash mask at QUEST_SPLASH_IMAGE_WIDTH.
  const renderedHeightDp = (QUEST_SPLASH_IMAGE_WIDTH * height) / width;
  const cornerRadiusDp = Math.hypot(QUEST_SPLASH_IMAGE_WIDTH / 2, renderedHeightDp / 2);
  assert.ok(cornerRadiusDp < 96, `splash corner radius ${cornerRadiusDp.toFixed(1)}dp exceeds 96dp`);
  // Decode IDAT scanlines to verify top-left corner pixel has alpha === 0 (no backdrop/box).
  const idatChunks = [];
  let offset = 8;
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') idatChunks.push(buf.subarray(offset + 8, offset + 8 + len));
    if (type === 'IEND') break;
    offset += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  assert.equal(raw[0], 0, 'first scanline filter byte');
  assert.deepEqual([...raw.subarray(1, 5)], [0, 0, 0, 0], 'top-left pixel must be transparent');
});

test('Quest app id is optional and must be numeric', () => {
  assert.equal(viroOptions(configure({ QUEST_BUILD: '1' })).android.questAppId, undefined);
  assert.equal(
    viroOptions(configure({ QUEST_BUILD: '1', META_QUEST_APP_ID: ' 1234567890 ' })).android
      .questAppId,
    '1234567890'
  );
  assert.throws(() => configure({ QUEST_BUILD: '1', META_QUEST_APP_ID: 'abc' }), /numeric/);
  // The phone build ignores it.
  assert.deepEqual(configure({ META_QUEST_APP_ID: 'abc' }), configure({}));
});

test('Quest detection reads Android build branding and tolerates missing Platform data', () => {
  assert.equal(isQuestDevice(quest3), true);
  assert.equal(
    isQuestDevice({
      OS: 'android',
      constants: { Manufacturer: 'Oculus', Brand: 'oculus', Model: 'Quest 2' },
    }),
    true
  );
  assert.equal(isQuestDevice({ OS: 'android', constants: { Model: 'Meta Quest Pro' } }), true);
  assert.equal(isQuestDevice({ OS: 'android', constants: { Model: 'quest 4' } }), true);
  assert.equal(isQuestDevice(pixel), false);
  assert.equal(isQuestDevice({ OS: 'android', constants: { Model: 'Questar' } }), false);
  assert.equal(isQuestDevice({ OS: 'ios', constants: { Manufacturer: 'Meta' } }), false);
  assert.equal(isQuestDevice({ OS: 'web' }), false);
  assert.equal(isQuestDevice({ OS: 'android' }), false);
  assert.equal(isQuestDevice({ OS: 'android', constants: { Manufacturer: 7 } }), false);
  assert.equal(isQuestDevice(undefined), false);
  assert.equal(isQuestDevice(null), false);
});

test('explicit enter, exit, and repeated re-entry follow the scene lifecycle', () => {
  const clock = fakeClock();
  const runtime = createQuestRuntime(clock, 10_000);
  assert.equal(runtime.getSnapshot().status, 'idle');
  for (let round = 1; round <= 4; round++) {
    assert.equal(runtime.requestEnter(), true);
    assert.equal(runtime.getSnapshot().status, 'launching');
    // Duplicate Enter presses while launching are ignored.
    assert.equal(runtime.requestEnter(), false);
    assert.equal(clock.pending.size, 1);
    runtime.sceneMounted();
    assert.equal(runtime.getSnapshot().status, 'immersive');
    assert.equal(clock.pending.size, 0);
    assert.equal(runtime.requestEnter(), false);
    // Back, onExitViro and the Exit target can all fire; only unmount ends the scene.
    runtime.exitRequested('scene-exit');
    runtime.exitRequested('onExitViro');
    assert.equal(runtime.getSnapshot().exitRequest, 'scene-exit');
    assert.equal(runtime.getSnapshot().status, 'immersive');
    runtime.sceneUnmounted();
    runtime.sceneUnmounted();
    const snapshot = runtime.getSnapshot();
    assert.equal(snapshot.status, 'returned');
    assert.equal(snapshot.entries, round);
    assert.equal(snapshot.reentryCount, round - 1);
    assert.equal(snapshot.sceneMounts, 0);
  }
});

test('Home or a system close without exitVRScene still returns to the panel', () => {
  const runtime = createQuestRuntime(fakeClock());
  runtime.requestEnter();
  runtime.sceneMounted();
  runtime.sceneUnmounted();
  assert.equal(runtime.getSnapshot().status, 'returned');
  assert.equal(runtime.getSnapshot().exitRequest, null);
  assert.equal(runtime.requestEnter(), true);
  runtime.sceneMounted();
  assert.equal(runtime.getSnapshot().entries, 2);
});

test('StrictMode and overlapping re-entry mounts keep the scene immersive until the last unmount', () => {
  // StrictMode mounts, unmounts and remounts the scene once.
  const runtime = createQuestRuntime(fakeClock());
  runtime.requestEnter();
  runtime.sceneMounted();
  runtime.sceneUnmounted();
  runtime.sceneMounted();
  assert.equal(runtime.getSnapshot().status, 'immersive');
  assert.equal(runtime.getSnapshot().entries, 1);
  // Overlapping surfaces during re-entry.
  const strict = createQuestRuntime(fakeClock());
  strict.requestEnter();
  strict.sceneMounted();
  strict.sceneMounted();
  strict.sceneUnmounted();
  assert.equal(strict.getSnapshot().status, 'immersive');
  assert.equal(strict.getSnapshot().entries, 1);
  strict.sceneUnmounted();
  assert.equal(strict.getSnapshot().status, 'returned');
});

test('launch timeout reports an error, a late mount recovers, and errors allow another try', () => {
  const clock = fakeClock();
  const runtime = createQuestRuntime(clock, 10_000);
  runtime.requestEnter();
  assert.equal([...clock.pending.values()][0].delay, 10_000);
  clock.fire();
  assert.equal(runtime.getSnapshot().status, 'error');
  assert.match(runtime.getSnapshot().lastError, /did not start within 10 s/);
  runtime.sceneMounted();
  assert.equal(runtime.getSnapshot().status, 'immersive');
  assert.equal(runtime.getSnapshot().lastError, null);
  runtime.fail(new Error('scene crashed'));
  assert.equal(runtime.getSnapshot().status, 'error');
  runtime.sceneUnmounted();
  assert.equal(runtime.getSnapshot().status, 'error');
  assert.equal(runtime.getSnapshot().lastError, 'scene crashed');
  assert.equal(runtime.requestEnter(), true);
  runtime.sceneMounted();
  assert.equal(runtime.getSnapshot().status, 'immersive');
  // A stale timer from an earlier launch cannot fail a later one.
  clock.fire();
  assert.equal(runtime.getSnapshot().status, 'immersive');
});

test('vrActivityStateChanged keeps paused sessions resumable and reconciles finishing/destroyed scenes', () => {
  const runtime = createQuestRuntime(fakeClock());
  runtime.requestEnter();
  runtime.sceneMounted();
  runtime.vrActivityStateChanged('paused');
  assert.equal(runtime.getSnapshot().status, 'immersive');
  assert.equal(runtime.getSnapshot().vrActivityState, 'paused');

  runtime.vrActivityStateChanged('stopped');
  assert.equal(runtime.getSnapshot().status, 'immersive');
  assert.equal(runtime.getSnapshot().vrActivityState, 'stopped');

  runtime.vrActivityStateChanged('paused', true);
  assert.equal(runtime.getSnapshot().vrActivityState, 'finishing');
  assert.equal(runtime.getSnapshot().status, 'returned');
  assert.equal(runtime.getSnapshot().sceneMounts, 1);

  runtime.vrActivityStateChanged('destroyed');
  assert.equal(runtime.getSnapshot().vrActivityState, 'destroyed');
  assert.equal(runtime.getSnapshot().status, 'returned');
  assert.equal(runtime.getSnapshot().sceneMounts, 0);

  assert.equal(runtime.requestEnter(), true);
  runtime.sceneMounted();
  assert.equal(runtime.getSnapshot().vrActivityState, 'unknown');
  assert.equal(runtime.getSnapshot().status, 'immersive');

  // Direct destroyed event without prior finishing also reconciles immersive -> returned.
  runtime.vrActivityStateChanged('destroyed');
  assert.equal(runtime.getSnapshot().status, 'returned');
  assert.equal(runtime.getSnapshot().sceneMounts, 0);
});

test('the shared onExitViro is stable and records the request on the shared store', () => {
  const { questOnExitViro: again } = require('../src/features/quest-vr/quest-runtime-store.ts');
  assert.equal(again, questOnExitViro);
  questOnExitViro();
  assert.equal(questRuntime.getSnapshot().exitRequest, 'onExitViro');
});

test('routes and phone entry points never load @reactvision/react-viro statically', () => {
  const viro = /from ['"]@reactvision\/react-viro['"]|require\(['"]@reactvision\/react-viro['"]\)/;
  for (const file of [
    'src/app/quest-vr.tsx',
    'src/app/arena-fighter.tsx',
    'src/app/index.tsx',
    'src/features/home/home-screen.tsx',
    'src/features/quest-vr/quest-platform.ts',
    'src/features/quest-vr/quest-runtime-store.ts',
    'src/features/quest-vr/quest-vr-bootstrap.ts',
    'src/features/quest-vr/quest-vr-bootstrap.native.ts',
    'src/features/quest-vr/quest-vr-screen.native.tsx',
    'src/features/quest-vr/quest-vr-screen.tsx',
    'src/navigation/root-layout.tsx',
  ])
    assert.doesNotMatch(source(file), viro, file);
  assert.match(
    source('src/features/quest-vr/quest-vr-screen.native.tsx'),
    /lazy\(\(\) => import\('\.\/quest-xr-navigator\.native'\)\)/
  );
  const navigator = source('src/features/quest-vr/quest-xr-navigator.native.tsx');
  assert.match(navigator, /onExitViro=\{questOnExitViro\}/);
  assert.match(navigator, /passthroughEnabled=\{false\}/);
  assert.match(navigator, /VRQuestNavigatorBridge\.onQuestError/);
  assert.match(navigator, /export function registerQuestVRScene/);
  const scene = source('src/features/quest-vr/quest-arena-scene.native.tsx');
  assert.match(scene, /<ViroScene[\s>]/);
  assert.doesNotMatch(scene, /ViroARScene|ViroXRSceneNavigator|setTracking|setPlacement/);
  assert.match(scene, /exitVRScene\(\)/);
  assert.match(navigator, /quest-arena-scene\.native/);
  assert.doesNotMatch(navigator, /quest-smoke-scene/);
  assert.match(
    source('src/features/quest-vr/quest-vr-screen.native.tsx'),
    /quest-splash-title\.png/
  );
  assert.doesNotMatch(
    source('src/features/quest-vr/quest-vr-screen.native.tsx'),
    /Enter VR for the headset menu|Quest VR runtime|Opening VR/
  );
});

function screenHarness({
  platform = quest3,
  launcher = true,
  clock = fakeClock(),
  initialAppState = 'active',
} = {}) {
  const states = [];
  const effects = [];
  const refs = [];
  let stateIndex = 0;
  let effectIndex = 0;
  let refIndex = 0;
  const backs = [];
  const vrStateListeners = new Set();
  const reopenListeners = new Set();
  const appStateListeners = new Set();
  const appState = { currentState: initialAppState };
  const runtime = createQuestRuntime(clock);
  let launched = 0;
  let nativeLaunches = 0;
  let navigatorMounts = 0;
  const load = () =>
    component('src/features/quest-vr/quest-vr-screen.native.tsx', {
      'react/jsx-runtime': jsxRuntime,
      react: {
        Component: class {},
        lazy: () => 'QuestXRNavigator',
        Suspense: 'Suspense',
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
        useRef: (initial) => {
          const index = refIndex++;
          if (!(index in refs)) refs[index] = { current: initial };
          return refs[index];
        },
        useState: (initial) => {
          const index = stateIndex++;
          if (!(index in states)) {
            states[index] = typeof initial === 'function' ? initial() : initial;
          }
          return [
            states[index],
            (value) => (states[index] = typeof value === 'function' ? value(states[index]) : value),
          ];
        },
        useSyncExternalStore: (_, get) => get(),
      },
      'expo-router': { router: { dismissTo: () => {} } },
      'react-native': {
        AppState: {
          get currentState() {
            return appState.currentState;
          },
          addEventListener: (event, handler) => {
            if (event !== 'change') return { remove: () => {} };
            appStateListeners.add(handler);
            return { remove: () => appStateListeners.delete(handler) };
          },
        },
        BackHandler: {
          addEventListener: (_, handler) => {
            backs.push(handler);
            return { remove: () => backs.splice(backs.indexOf(handler), 1) };
          },
        },
        DeviceEventEmitter: {
          addListener: (event, handler) => {
            if (event === 'questVRActivityState') {
              vrStateListeners.add(handler);
              return { remove: () => vrStateListeners.delete(handler) };
            }
            if (event === 'questLauncherReopen') {
              reopenListeners.add(handler);
              return { remove: () => reopenListeners.delete(handler) };
            }
            return { remove: () => {} };
          },
        },
        Image: 'Image',
        NativeModules: launcher
          ? {
              VRLauncher: {
                launchVRScene: () => {
                  if (launcher instanceof Error) throw launcher;
                  nativeLaunches++;
                },
              },
            }
          : {},
        Platform: platform,
        ScrollView: 'ScrollView',
        View: 'View',
      },
      'react-native-safe-area-context': {
        useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
      },
      '@/theme/provider': { useAppTheme: () => ({ activeColors: { background: '#000' } }) },
      '@/ui/game-status-panel': { GameStatusPanel: 'StatusPanel' },
      './quest-platform': { isQuestDevice },
      './quest-runtime-store': { questRuntime: runtime },
      '../../../assets/arena/ui/quest-lettering/quest-splash-title.png': 42,
    });
  const Screen = load().default;
  const render = () => {
    stateIndex = 0;
    effectIndex = 0;
    refIndex = 0;
    const root = Screen();
    if (nodes(root).some((node) => node.type === 'QuestXRNavigator')) navigatorMounts++;
    return root;
  };
  const renderStrict = () => {
    render();
    // Simulate React StrictMode cleaning up and re-running effects on initial mount.
    for (const entry of effects) {
      entry?.cleanup?.();
    }
    effects.length = 0;
    return render();
  };
  const panelOf = (root) => nodes(root).find((node) => node.type === 'StatusPanel');
  const titleSplashOf = (root) => {
    const rendered = typeof root?.type === 'function' ? root.type(root.props) : root;
    return nodes(rendered).find((node) => node.props?.testID === 'quest-floating-title-splash');
  };
  const panelWrapperOf = (root) =>
    nodes(root).find(
      (node) =>
        node.type === 'View' &&
        nodes(node.props?.children).some((child) => child.type === 'StatusPanel')
    );
  const action = (root, label) => panelOf(root)?.props.actions.find((item) => item.label === label);
  return {
    render,
    renderStrict,
    runtime,
    clock,
    panelOf,
    titleSplashOf,
    panelKey: (root) => panelWrapperOf(root)?.key,
    action,
    backs,
    emitVRActivityState: (state, finishing = false) => {
      for (const listener of vrStateListeners) listener({ state, finishing });
    },
    emitLauncherReopen: () => {
      for (const listener of reopenListeners) listener();
    },
    emitAppState: (nextState) => {
      appState.currentState = nextState;
      for (const listener of appStateListeners) listener(nextState);
    },
    launch: () => launched++,
    launched: () => launched,
    nativeLaunches: () => nativeLaunches,
    navigatorMounts: () => navigatorMounts,
  };
}

test('Quest auto-enters VR once on cold launch (StrictMode-safe), shows floating title without pre-entry cards, and handles exit vs Home reopen', () => {
  const h = screenHarness();
  let root = h.renderStrict();
  // Cold launch automatically transitions to launching once (even across StrictMode double-effects) without Enter VR prompt.
  assert.equal(h.runtime.getSnapshot().status, 'launching');
  assert.equal(h.runtime.getSnapshot().reentryCount, 0);
  assert.equal(h.clock.pending.size, 1, 'exactly one launch timeout scheduled under StrictMode');
  const navigator = nodes(root).find((node) => node.type === 'QuestXRNavigator');
  assert.ok(navigator, 'navigator mounts automatically on cold Quest launch');
  const attemptOf = (tree) => nodes(tree).find((node) => node.type === 'Suspense')?.key ?? nodes(tree).find((node) => node.props?.fallback)?.key;
  const initialAttempt = attemptOf(root);
  // Back is consumed while launching; the panel renders ONLY the transparent floating title, no StatusPanel card.
  assert.equal(h.backs.at(-1)(), true);
  const launchingView = navigator.props.renderQuestPanel(h.launch);
  assert.equal(h.panelOf(launchingView), undefined);
  const titleSplash = h.titleSplashOf(launchingView);
  assert.ok(titleSplash, 'floating title splash shown while launching');
  const titleImg = nodes(titleSplash).find((node) => node.type === 'Image');
  assert.equal(titleImg.props.source, 42);
  assert.equal(titleImg.props.style.backgroundColor, 'transparent');

  h.runtime.sceneMounted();
  assert.equal(h.runtime.getSnapshot().entries, 1);
  const initialPanelKey = h.panelKey(navigator.props.renderQuestPanel(h.launch)) ?? 0;

  // Explicit exit (scene-exit / onExitViro) + transient VRActivity.onPause -> MainActivity.onResume AppState flicker
  // must respect exit intent and NOT auto-relaunch.
  h.runtime.exitRequested('scene-exit');
  h.emitVRActivityState('paused', true);
  h.emitAppState('background');
  h.runtime.sceneUnmounted();
  h.emitAppState('active');
  h.emitVRActivityState('destroyed');
  assert.equal(h.runtime.getSnapshot().status, 'returned');
  assert.equal(h.launched(), 0);
  const returnedPanel = nodes(h.render())
    .find((node) => node.type === 'QuestXRNavigator')
    .props.renderQuestPanel(h.launch);
  assert.equal(h.panelOf(returnedPanel).props.title, 'Back on the panel');
  assert.equal(h.action(returnedPanel, 'Home'), undefined, 'no redundant Home button on Quest');
  assert.ok(h.action(returnedPanel, 'Re-enter VR'));

  // Explicit Re-enter VR works across repeated rounds.
  for (let round = 1; round <= 3; round++) {
    const panel = nodes(h.render())
      .find((node) => node.type === 'QuestXRNavigator')
      .props.renderQuestPanel(h.launch);
    h.action(panel, 'Re-enter VR').onPress();
    assert.equal(h.launched(), round);
    h.runtime.sceneMounted();
    h.runtime.exitRequested('onExitViro');
    h.runtime.sceneUnmounted();
  }
  assert.equal(h.runtime.getSnapshot().reentryCount, 3);

  // Leaving the returned panel to Quest Home (background) and re-opening (active) automatically re-enters VR.
  h.emitAppState('active'); // ensure panel marked active after return
  h.emitAppState('background');
  h.emitAppState('active');
  assert.equal(h.runtime.getSnapshot().status, 'launching');
  assert.ok(
    Number(attemptOf(h.render())) > Number(initialAttempt),
    'auto re-entry bumps attempt to remount navigator cleanly'
  );
  h.runtime.sceneMounted();

  // Pressing Meta Home in VR (paused -> stopped, no exitRequest) and re-opening from Quest Home resumes VRActivity natively.
  h.emitVRActivityState('paused');
  h.emitVRActivityState('stopped');
  h.emitAppState('background');
  h.emitLauncherReopen();
  assert.equal(h.nativeLaunches(), 1);
  assert.equal(h.runtime.getSnapshot().status, 'immersive');

  // Dismissing Horizon OS Universal Menu directly back to VRActivity (resumed before active) does NOT relaunch.
  h.emitVRActivityState('paused');
  h.emitAppState('inactive');
  h.emitVRActivityState('resumed');
  h.emitAppState('active');
  assert.equal(h.nativeLaunches(), 1);

  // Returning to panel while VRActivity survives shows paused copy and bumps panelMountKey.
  h.emitVRActivityState('paused');
  root = h.render();
  const paused = nodes(root)
    .find((node) => node.type === 'QuestXRNavigator')
    .props.renderQuestPanel(h.launch);
  assert.equal(h.panelOf(paused).props.title, 'VR is paused');
  assert.ok(h.panelKey(paused) > initialPanelKey, 'returning from VRActivity remounts panel wrapper');
  h.action(paused, 'Re-enter VR').onPress();
  assert.equal(h.launched(), 4);

  // When VRActivity destroys, the panel stops claiming the VR session is live and re-enters cleanly.
  h.emitVRActivityState('destroyed');
  const afterDestroy = nodes(h.render())
    .find((node) => node.type === 'QuestXRNavigator')
    .props.renderQuestPanel(h.launch);
  assert.equal(h.panelOf(afterDestroy).props.title, 'Back on the panel');
  h.action(afterDestroy, 'Re-enter VR').onPress();
  assert.equal(h.launched(), 5);
  assert.equal(h.runtime.getSnapshot().status, 'launching');
  h.runtime.sceneMounted();

  // Launch errors surface a usable recovery UI (not a blank screen) and remount navigator on retry.
  h.runtime.fail(new Error('scene crashed'));
  const errored = nodes(h.render())
    .find((node) => node.type === 'QuestXRNavigator')
    .props.renderQuestPanel(h.launch);
  assert.equal(h.panelOf(errored).props.title, 'VR needs another try');
  h.action(errored, 'Re-enter VR').onPress();
  assert.equal(h.launched(), 5, 'error recovery remounts navigator rather than calling stale launch');
  assert.equal(h.runtime.getSnapshot().status, 'launching');
  h.runtime.sceneMounted();

  // A remounted screen without a navigator (e.g. after process restoration) relaunches live VRActivity natively.
  const remounted = screenHarness();
  remounted.runtime.requestEnter();
  remounted.runtime.sceneMounted();
  assert.equal(remounted.panelOf(remounted.render()).props.title, 'VR session active');
  remounted.action(remounted.render(), 'Re-enter VR').onPress();
  assert.equal(remounted.nativeLaunches(), 1);
  assert.ok(!nodes(remounted.render()).some((node) => node.type === 'QuestXRNavigator'));
});

test('launch timeout and synchronous launch errors show recovery UI instead of blank screen or relaunch loop', () => {
  const clock = fakeClock();
  const h = screenHarness({ clock });
  h.render();
  assert.equal(h.runtime.getSnapshot().status, 'launching');
  clock.fire();
  assert.equal(h.runtime.getSnapshot().status, 'error');
  const timedOutPanel = nodes(h.render())
    .find((node) => node.type === 'QuestXRNavigator')
    .props.renderQuestPanel(h.launch);
  assert.equal(h.panelOf(timedOutPanel).props.title, 'VR needs another try');
  assert.match(h.panelOf(timedOutPanel).props.message, /did not start within 10 s/);
  // Leaving to background and back on error panel does NOT auto-loop launch errors.
  h.emitAppState('background');
  h.emitAppState('active');
  assert.equal(h.runtime.getSnapshot().status, 'error');

  // Synchronous throw inside launch() transitions to error with recovery button.
  const broken = screenHarness({ launcher: new Error('VRActivity missing') });
  broken.render();
  const nav = nodes(broken.render()).find((node) => node.type === 'QuestXRNavigator');
  nav.props.renderQuestPanel(() => {
    throw new Error('VRActivity missing');
  });
  broken.runtime.sceneMounted();
  broken.runtime.sceneUnmounted();
  const panel = nodes(broken.render())
    .find((node) => node.type === 'QuestXRNavigator')
    .props.renderQuestPanel(() => {
      throw new Error('VRActivity missing');
    });
  broken.action(panel, 'Re-enter VR').onPress();
  assert.equal(broken.runtime.getSnapshot().status, 'error');
  assert.match(broken.runtime.getSnapshot().lastError, /VRActivity missing/);
});

test('cold launch while headset is asleep defers launch until active foreground without premature timeout', () => {
  const clock = fakeClock();
  const h = screenHarness({ clock, initialAppState: 'background' });
  let root = h.renderStrict();
  assert.equal(h.runtime.getSnapshot().status, 'idle');
  assert.equal(clock.pending.size, 0, 'no launch timeout armed while sleeping');
  assert.ok(!nodes(root).some((node) => node.type === 'QuestXRNavigator'));
  assert.ok(h.titleSplashOf(root), 'shows transparent floating title while waiting to wake');

  h.emitAppState('active');
  assert.equal(h.runtime.getSnapshot().status, 'launching');
  assert.equal(clock.pending.size, 1);
  root = h.render();
  assert.ok(nodes(root).some((node) => node.type === 'QuestXRNavigator'));
});

test('phones and builds without VRLauncher cannot enter VR and never auto-launch', () => {
  for (const options of [{ platform: pixel }, { launcher: false }]) {
    const h = screenHarness(options);
    const root = h.render();
    assert.equal(h.runtime.getSnapshot().status, 'idle');
    assert.ok(!nodes(root).some((node) => node.type === 'QuestXRNavigator'));
    assert.equal(h.action(root, 'Enter VR'), undefined);
    assert.ok(h.action(root, 'Home'));
  }
});

test('index route skips 2D HomeScreen on Quest while preserving phone AR and iOS navigation', () => {
  const loadIndex = (platform) =>
    component('src/app/index.tsx', {
      'react/jsx-runtime': jsxRuntime,
      'react-native': { Platform: platform },
      '@/features/quest-vr/quest-vr-screen': { __esModule: true, default: 'QuestVRScreen' },
      '@/features/quest-vr/quest-platform': { isQuestDevice },
      '../features/home/home-screen': { __esModule: true, default: 'HomeScreen' },
    }).default;
  assert.equal(loadIndex(quest3)().type, 'QuestVRScreen');
  assert.equal(loadIndex(pixel)().type, 'HomeScreen');
  assert.equal(loadIndex({ OS: 'ios' })().type, 'HomeScreen');
});

test('Quest bootstrap registers VRQuestScene and seeds default intent on Quest only', () => {
  let registered = 0;
  const loadBootstrap = (platform) =>
    component('src/features/quest-vr/quest-vr-bootstrap.native.ts', {
      'react-native': { Platform: platform },
      './quest-platform': { isQuestDevice },
      './quest-runtime-store': { questRuntime: createQuestRuntime(fakeClock()) },
      './quest-xr-navigator.native': {
        registerQuestVRScene: () => {
          registered++;
        },
      },
    }).ensureQuestVRRegistered;

  loadBootstrap(pixel)();
  loadBootstrap({ OS: 'ios' })();
  assert.equal(registered, 0, 'phones/iOS never load Quest navigator at startup');

  const bootQuest = loadBootstrap(quest3);
  bootQuest();
  bootQuest();
  assert.equal(registered, 1, 'Quest registers VRQuestScene once');
});

test('registerQuestVRScene seeds default QuestArenaScene intent for process restoration', () => {
  let intent = null;
  let errorCb = null;
  const { registerQuestVRScene } = component('src/features/quest-vr/quest-xr-navigator.native.tsx', {
    'react/jsx-runtime': jsxRuntime,
    react: { useEffect: () => {} },
    '@reactvision/react-viro': {
      ViroXRSceneNavigator: 'ViroXRSceneNavigator',
      VRQuestNavigatorBridge: {
        getIntent: () => intent,
        setIntent: (initialScene, rendererConfig) => {
          intent = { initialScene, rendererConfig };
          return 'vr-default';
        },
        onQuestError: (cb) => {
          errorCb = cb;
          return () => {
            errorCb = null;
          };
        },
      },
    },
    './quest-arena-scene.native': { __esModule: true, default: 'QuestArenaScene' },
    './quest-runtime-store': { questOnExitViro, questRuntime: createQuestRuntime(fakeClock()) },
  });
  registerQuestVRScene();
  assert.equal(intent.initialScene.scene, 'QuestArenaScene');
  assert.equal(intent.rendererConfig.onExitViro, questOnExitViro);
  assert.equal(intent.rendererConfig.passthroughEnabled, false);
  assert.ok(typeof errorCb === 'function');
});

test('Home offers the Quest runtime on a Quest and the AR arena elsewhere', () => {
  const routes = [];
  const load = (platform) =>
    component('src/features/home/home-screen.tsx', {
      'react/jsx-runtime': jsxRuntime,
      react: { useState: () => [320, () => {}] },
      'expo-router': { router: { navigate: (route) => routes.push(route) } },
      'react-native': { Platform: platform, ScrollView: 'ScrollView', View: 'View' },
      'react-native-safe-area-context': {
        useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
      },
      '@/features/experiences/experience-catalog': require('../src/features/experiences/experience-catalog.ts'),
      '@/features/quest-vr/quest-platform': { isQuestDevice, questExperience },
      '@/theme/provider': { useAppTheme: () => ({ activeColors: {} }) },
      '@/ui/game-button': { GameButton: 'GameButton' },
      '@/ui/game-text': { GameText: 'GameText' },
      '@/ui/use-game-window-dimensions': { useGameWindowDimensions: () => ({ width: 320 }) },
    }).default;
  for (const [platform, href] of [
    [quest3, '/quest-vr'],
    [pixel, '/arena-fighter'],
    [{ OS: 'ios' }, '/arena-fighter'],
  ]) {
    const buttons = nodes(load(platform)()).filter((node) => node.type === 'GameButton');
    assert.equal(buttons.length, 1);
    buttons[0].props.onPress();
    assert.equal(routes.at(-1), href);
  }
  assert.equal(questExperience.href, '/quest-vr');
});

test('the arena route redirects a Quest to the VR runtime and keeps phone AR elsewhere', () => {
  const load = (platform) =>
    component('src/app/arena-fighter.tsx', {
      'react/jsx-runtime': jsxRuntime,
      'expo-router': { Redirect: 'Redirect' },
      'react-native': { Platform: platform },
      '@/features/arena-fighter/arena-fighter-screen': {
        __esModule: true,
        default: 'ArenaFighter',
      },
      '@/features/quest-vr/quest-platform': { isQuestDevice },
    }).default;
  const quest = load(quest3)();
  assert.equal(quest.type, 'Redirect');
  assert.equal(quest.props.href, '/quest-vr');
  assert.equal(load(pixel)().type, 'ArenaFighter');
  assert.equal(load({ OS: 'ios' })().type, 'ArenaFighter');
});

test('root layout registers the Quest route without the portrait default and bootstraps Quest VR registration', () => {
  const rootLayout = source('src/navigation/root-layout.tsx');
  assert.match(
    rootLayout,
    /name="quest-vr"\s+options=\{\{ title: 'Quest VR Runtime', orientation: 'default', headerShown: false \}\}/
  );
  assert.match(rootLayout, /ensureQuestVRRegistered\(\)/);
  assert.match(rootLayout, /headerShown: !isQuestDevice\(Platform\)/);
});

test('Quest VRActivity prebuild plugin patches Viro Meta/Home resume race and stays idempotent', async () => {
  const os = require('node:os');
  const path = require('node:path');
  const { compileModsAsync, withDangerousMod, withStaticPlugin } = require('@expo/config-plugins');
  const withQuestVRActivity = require('../tools/quest/with-quest-vr-activity.cjs');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-vr-activity-test-'));
  try {
    const androidRoot = path.join(tmpRoot, 'android');
    const appMain = path.join(androidRoot, 'app', 'src', 'main');
    const pkgDir = path.join(appMain, 'java', 'com', 'djleg', 'neorobots');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(appMain, 'AndroidManifest.xml'),
      [
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.djleg.neorobots">',
        '  <uses-permission android:name="android.permission.INTERNET"/>',
        '  <application android:name=".MainApplication">',
        '    <activity android:name=".MainActivity"/>',
        '  </application>',
        '</manifest>',
        '',
      ].join('\n')
    );
    fs.writeFileSync(path.join(androidRoot, 'build.gradle'), 'allprojects { repositories {} }\n');
    fs.writeFileSync(path.join(androidRoot, 'gradle.properties'), '\n');
    fs.writeFileSync(path.join(androidRoot, 'settings.gradle'), "rootProject.name = 'test'\n");
    fs.writeFileSync(
      path.join(androidRoot, 'app', 'build.gradle'),
      'android {\n    defaultConfig {\n        minSdkVersion 24\n    }\n}\n'
    );
    fs.writeFileSync(
      path.join(pkgDir, 'MainApplication.kt'),
      'package com.djleg.neorobots\nclass MainApplication {\n  val packages = PackageList(this).packages\n}\n'
    );
    fs.writeFileSync(
      path.join(pkgDir, 'MainActivity.kt'),
      [
        'package com.djleg.neorobots',
        'import android.os.Bundle',
        'import com.facebook.react.ReactActivity',
        'class MainActivity : ReactActivity() {',
        '  override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(null) }',
        '}',
        '',
      ].join('\n')
    );

    // Strip plugins unrelated to Android native file generation (e.g. expo-router) while keeping
    // the exact Quest Viro options and local plugin resolved via Expo's static plugin loader.
    const questConfig = configure({ QUEST_BUILD: '1' });
    const viroEntry = questConfig.plugins.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === '@reactvision/react-viro'
    );
    const questActivityPlugin = questConfig.plugins.find(
      (plugin) => plugin === './tools/quest/with-quest-vr-activity.cjs'
    );
    assert.ok(questActivityPlugin, 'expected Quest config to include with-quest-vr-activity.cjs');
    const repoRoot = path.resolve(__dirname, '..');
    let modConfig = withStaticPlugin(
      { ...questConfig, plugins: [viroEntry], _internal: { projectRoot: repoRoot } },
      { plugin: viroEntry, projectRoot: repoRoot }
    );
    modConfig = withStaticPlugin(modConfig, {
      plugin: questActivityPlugin,
      projectRoot: repoRoot,
    });

    await compileModsAsync(modConfig, { projectRoot: tmpRoot, platforms: ['android'] });

    const vrActivityPath = path.join(pkgDir, 'VRActivity.kt');
    assert.ok(fs.existsSync(vrActivityPath), 'expected Viro plugin to generate VRActivity.kt');
    const patched = fs.readFileSync(vrActivityPath, 'utf8');

    // Guard blocks shared ReactHost pause when MainActivity has already resumed (Meta/Home -> reopen).
    assert.match(patched, /private var supersededByOtherActivity = false/);
    assert.match(
      patched,
      /object : DefaultReactActivityDelegate\(this, mainComponentName, fabricEnabled\) \{\s*override fun onPause\(\) \{[\s\S]*?val currentActivity = reactHost\?\.currentReactContext\?\.currentActivity[\s\S]*?supersededByOtherActivity \|\|\s*\(currentActivity != null && currentActivity !== this@VRActivity\)\s*\)\s*\{\s*return\s*\}\s*super\.onPause\(\)\s*\}/
    );
    // VRActivity.onResume resets the flag and emits state; onPause clears expectingForeignPause and emits paused/finishing; onStop emits stopped/finishing; onDestroy emits destroyed.
    assert.match(patched, /import com\.facebook\.react\.bridge\.Arguments/);
    assert.match(patched, /import com\.facebook\.react\.modules\.core\.DeviceEventManagerModule/);
    assert.match(
      patched,
      /override fun onResume\(\) \{\s*supersededByOtherActivity = false\s*emitVRActivityState\("resumed"\)\s*super\.onResume\(\)/
    );
    assert.match(
      patched,
      /override fun onPause\(\) \{\s*expectingForeignPause = false\s*emitVRActivityState\(if \(isFinishing \|\| isDestroyed\) "finishing" else "paused"\)\s*super\.onPause\(\)\s*\}/
    );
    assert.match(
      patched,
      /override fun onStop\(\) \{\s*emitVRActivityState\(if \(isFinishing \|\| isDestroyed\) "finishing" else "stopped"\)\s*super\.onStop\(\)\s*\}/
    );
    assert.match(
      patched,
      /mainHandler\.removeCallbacksAndMessages\(null\)\s*emitVRActivityState\("destroyed"\)\s*super\.onDestroy\(\)/
    );
    // Resuming another Activity (MainActivity) supersedes VRActivity, syncs ReactContext.currentActivity, and avoids force-finishing VRActivity.
    assert.match(
      patched,
      /override fun onActivityResumed\(other: Activity\) \{\s*if \(other !== this@VRActivity\) \{\s*supersededByOtherActivity = true\s*expectingForeignPause = false\s*mainHandler\.removeCallbacksAndMessages\(null\)\s*[\s\S]*?val reactContext = reactHost\?\.currentReactContext\s*if \(reactContext != null && reactContext\.currentActivity !== other\) \{\s*reactContext\.onHostResume\(other\)\s*\}\s*\}\s*\}/
    );
    assert.doesNotMatch(
      patched,
      /override fun onActivityResumed\(other: Activity\)[\s\S]*?\bfinish\(\)/
    );

    // Re-running patchVRActivitySource, patchMainActivitySource, and the finalized mod is idempotent.
    assert.equal(withQuestVRActivity.patchVRActivitySource(patched), patched);
    const mainActivityPath = path.join(pkgDir, 'MainActivity.kt');
    const patchedMain = fs.readFileSync(mainActivityPath, 'utf8');
    assert.match(patchedMain, /override fun onNewIntent\(intent: Intent\)/);
    assert.match(patchedMain, /questLauncherReopen/);
    assert.equal(withQuestVRActivity.patchMainActivitySource(patchedMain), patchedMain);
    let secondConfig = withDangerousMod({ ...questConfig, plugins: [] }, ['android', (c) => c]);
    secondConfig = withQuestVRActivity(secondConfig);
    await compileModsAsync(secondConfig, { projectRoot: tmpRoot, platforms: ['android'] });
    assert.equal(fs.readFileSync(vrActivityPath, 'utf8'), patched);
    assert.equal(fs.readFileSync(mainActivityPath, 'utf8'), patchedMain);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Quest VRActivity prebuild plugin fails loudly on missing file or unknown template', () => {
  const os = require('node:os');
  const path = require('node:path');
  const withQuestVRActivity = require('../tools/quest/with-quest-vr-activity.cjs');

  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-vr-missing-'));
  try {
    assert.throws(
      () => withQuestVRActivity.applyQuestVRActivityPatch(missingRoot, 'com.djleg.neorobots'),
      /Expected Viro Quest VRActivity\.kt/
    );
    assert.throws(
      () => withQuestVRActivity.applyQuestMainActivityPatch(missingRoot, 'com.djleg.neorobots'),
      /Expected Quest MainActivity\.kt/
    );
  } finally {
    fs.rmSync(missingRoot, { recursive: true, force: true });
  }

  assert.throws(
    () => withQuestVRActivity.patchVRActivitySource('class VRActivity {}'),
    /Unexpected VRActivity\.kt template/
  );
  assert.throws(
    () => withQuestVRActivity.patchMainActivitySource('class MainActivity {}'),
    /Unexpected VRActivity\.kt template/
  );
});
