const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  QUEST_MENU_LAYER_FIRST_SHOW_MS,
  QUEST_MENU_LAYER_MASK_FRAGMENT,
  createQuestMenuCompositor,
  questMenuLayerMaterials,
  questMenuLayerNotice,
  questMenuLayerVisible,
  questMenuPanelPose,
  questMenuPanelSpec,
  questMenuTitlePose,
} = require('../src/features/quest-vr/quest-menu-compositor.ts');
const { questMenuLayer } = require('../src/features/quest-vr/quest-menu-layer.ts');
const { DEFAULT_CALIBRATION, menuFrame } = require('../src/features/quest-vr/quest-head-rig.ts');
const {
  QUEST_MENU_POSE,
  QUEST_MENU_SIZE,
  QUEST_MENU_TEXTURE,
  QUEST_TITLE_POSE,
  buildQuestMenu,
  buildQuestMenuTitle,
} = require('../src/features/quest-vr/quest-menu-layout.ts');

const repo = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(repo, file), 'utf8');

// Viro's +Y rotation, as the scene's nested nodes apply it.
function rotateY([x, y, z], deg) {
  const r = (deg * Math.PI) / 180;
  return [x * Math.cos(r) + z * Math.sin(r), y, -x * Math.sin(r) + z * Math.cos(r)];
}

// Rotates v by the unit quaternion q = [x, y, z, w].
function rotateByQuaternion(v, [qx, qy, qz, qw]) {
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

const close = (a, b, eps = 1e-9) => a.every((value, index) => Math.abs(value - b[index]) < eps);

test('the layer pose is the panel node the scene builds, for any calibration', () => {
  // Upright, yaw-only poses are what the layer orientation assumes.
  for (const pose of Object.values(QUEST_MENU_POSE)) {
    assert.equal(pose.rotation[0], 0);
    assert.equal(pose.rotation[2], 0);
  }
  const calibrations = [
    DEFAULT_CALIBRATION,
    { ...DEFAULT_CALIBRATION, origin: [0.4, 1.62, -0.3], yaw: 90, source: 'solo', entry: 1 },
    { ...DEFAULT_CALIBRATION, origin: [-1.2, 1.1, 2.5], yaw: -37.5, source: 'system', entry: 2 },
    { ...DEFAULT_CALIBRATION, origin: [0, 1.4, 0], yaw: 179.9, posture: 'seated' },
  ];
  for (const cal of calibrations) {
    for (const page of ['menu', 'ring']) {
      const frame = menuFrame(cal);
      const local = QUEST_MENU_POSE[page];
      const viroCenter = frame.position.map(
        (value, index) => value + rotateY(local.position, frame.rotationY)[index]
      );
      const { pose, position, yaw } = questMenuPanelPose(cal, page);
      assert.ok(close(position, viroCenter), `${page} centre ${JSON.stringify(cal)}`);
      assert.deepEqual(pose.slice(0, 3), position);
      const q = pose.slice(3);
      assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-12);
      assert.equal(q[0], 0);
      assert.equal(q[2], 0);
      // The quad layer faces +Z in its own frame, like a ViroQuad: the same axes.
      for (const axis of [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]) {
        assert.ok(
          close(rotateByQuaternion(axis, q), rotateY(axis, frame.rotationY + local.rotation[1])),
          `${page} axis ${axis}`
        );
      }
      assert.equal(yaw, frame.rotationY + local.rotation[1]);
    }
  }
  // Default calibration: the compact menu card is straight ahead, 1.5 m away, facing the wearer.
  const menu = questMenuPanelPose(DEFAULT_CALIBRATION, 'menu');
  assert.ok(close(menu.position, [0, -0.18, -1.5]));
  assert.ok(close(menu.pose.slice(3), [0, 0, 0, 1]));

  // Floating title poses align with QUEST_TITLE_POSE[page] under menuFrame(cal).
  const ringTitle = questMenuTitlePose(DEFAULT_CALIBRATION, 'ring');
  assert.ok(close(ringTitle.position, QUEST_TITLE_POSE.ring.position));
  assert.ok(close(ringTitle.pose.slice(3), [0, 0, 0, 1]));
});

test('every screen fits the native panel limits and hover is never part of the image', () => {
  const longLine = 'Head rig (seated, recentering): Hold still while the view settles. '.repeat(4);
  const sampleTitles = {
    neo: 'assets_arena_ui_questlettering_neo',
    rock: 'assets_arena_ui_questlettering_rock',
    robots: 'assets_arena_ui_questlettering_robots',
  };
  for (const page of ['menu', 'ring']) {
    for (const acknowledged of [false, true]) {
      for (const posture of ['standing', 'seated']) {
        for (const lines of [[], Array.from({ length: 9 }, () => longLine)]) {
          const menu = buildQuestMenu(page, lines, {
            acknowledged,
            posture,
          });
          const spec = JSON.parse(
            questMenuPanelSpec({
              label: `${page}`,
              pose: questMenuPanelPose(DEFAULT_CALIBRATION, page, menu.hasMessages).pose,
              ops: menu.ops,
              widthPx: menu.widthPx,
              heightPx: menu.heightPx,
              widthM: menu.widthM,
              heightM: menu.heightM,
            })
          );
          // QuestPanelModule: 1..160 ops, 1..4096 px, 0..2 m; QuestPanelLayer.h: the same.
          assert.ok(spec.ops.length >= 1 && spec.ops.length <= 160, `${spec.ops.length} ops`);
          assert.equal(spec.widthPx, menu.widthPx);
          assert.equal(spec.heightPx, menu.heightPx);
          assert.ok(spec.widthPx <= 4096 && spec.heightPx <= 4096);
          assert.equal(spec.widthM, menu.widthM);
          assert.equal(spec.heightM, menu.heightM);
          assert.ok(spec.widthM <= 2 && spec.heightM <= 2);
          assert.equal(spec.pose.length, 7);
          assert.ok(spec.pose.every(Number.isFinite));
          for (const op of spec.ops) assert.ok(['roundRect', 'text'].includes(op.op));
        }
      }
    }
  }
  const titleModel = buildQuestMenuTitle({ titles: sampleTitles });
  assert.equal(titleModel.ops.filter((op) => op.op === 'image').length, 3);
  assert.equal(titleModel.ops.some((op) => op.op === 'roundRect'), false);
  // The same screen with and without a hover option draws the same pixels.
  const plain = buildQuestMenu('menu', ['a'], { posture: 'standing' });
  const hovered = buildQuestMenu('menu', ['a'], { posture: 'standing', hover: 'solo' });
  assert.notDeepEqual(plain.ops, hovered.ops, 'buildQuestMenu still supports hover art');
  const scene = read('src/features/quest-vr/quest-arena-scene.native.tsx');
  assert.doesNotMatch(scene, /hover:\s*visibleHover/);
  const navigator = read('src/features/quest-vr/quest-xr-navigator.native.tsx');
  assert.doesNotMatch(navigator, /hdrEnabled=\{false\}/);
  assert.match(navigator, /\bhdrEnabled\b/);
  assert.match(navigator, /bloomEnabled=\{false\}/);
});

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
    cancel: (handle) => pending.delete(handle),
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

function fakeBackend() {
  const calls = { open: 0, draws: [], invalidates: [], hides: [], logs: [] };
  const backend = {
    owner: 0,
    statusValue: 0,
    available: () => true,
    open: () => {
      calls.open += 1;
      backend.owner += 1;
      return backend.owner;
    },
    draw: (owner, spec) => calls.draws.push({ owner, spec: JSON.parse(spec) }),
    invalidate: (owner) => calls.invalidates.push(owner),
    status(owner) {
      return owner === backend.owner ? backend.statusValue : -1;
    },
    hide: (owner) => calls.hides.push(owner),
    log: (level, message) => calls.logs.push(`${level} ${message}`),
  };
  return { backend, calls };
}

const frame = (page = 'menu', posture = 'standing', cal = DEFAULT_CALIBRATION) => ({
  label: `${page} ${posture}`,
  pose: questMenuPanelPose(cal, page).pose,
  ops: buildQuestMenu(page, ['line'], { posture }).ops,
});

test('the layer opens once, sends only changed panels, and reports when the renderer shows it', () => {
  const clock = manualClock();
  const { backend, calls } = fakeBackend();
  const compositor = createQuestMenuCompositor(backend, { clock });
  const modes = [];
  compositor.subscribe(() => modes.push(compositor.getSnapshot().mode));
  assert.equal(compositor.getSnapshot().mode, 'pending');
  assert.equal(calls.open, 0, 'nothing opens before there is a panel');

  compositor.present(frame());
  compositor.present(frame());
  assert.equal(calls.open, 1);
  assert.equal(calls.draws.length, 1, 'an identical panel is not resent');
  assert.equal(calls.draws[0].owner, 1);

  clock.advance(100);
  assert.equal(compositor.getSnapshot().mode, 'pending');
  backend.statusValue = 1;
  clock.advance(100);
  assert.equal(compositor.getSnapshot().mode, 'shown');
  assert.ok(calls.logs.some((line) => /info layer shown after 200 ms/.test(line)));

  // Page, posture and pose changes each send one spec; the native side redraws
  // only when the pixels change and otherwise just moves them.
  compositor.present(frame('ring'));
  compositor.present(frame('ring', 'seated'));
  const moved = { ...DEFAULT_CALIBRATION, origin: [0.5, 1.5, 0.2], yaw: 120 };
  compositor.present(frame('ring', 'seated', moved));
  assert.equal(calls.draws.length, 4);
  assert.deepEqual(calls.draws[2].spec.ops, calls.draws[3].spec.ops);
  assert.notDeepEqual(calls.draws[2].spec.pose, calls.draws[3].spec.pose);
  assert.equal(calls.open, 1, 'one owner per scene');
  assert.deepEqual(modes, ['shown'], 'navigation never leaves the shown state');

  // Shown polls slow to 1 Hz and stop with the scene.
  assert.equal([...clock.pending.values()][0].at - clock.now(), 1000);
  compositor.dispose();
  compositor.dispose();
  assert.deepEqual(calls.hides, [1]);
  assert.equal(clock.pending.size, 0);
  compositor.present(frame());
  assert.equal(calls.draws.length, 4);
});

test('a failing layer is hidden once and Viro buttons take over for the rest of the scene', () => {
  const clock = manualClock();
  const { backend, calls } = fakeBackend();
  const compositor = createQuestMenuCompositor(backend, { clock });
  compositor.present(frame());
  backend.statusValue = 1;
  clock.advance(100);
  assert.equal(compositor.getSnapshot().mode, 'shown');
  backend.statusValue = -1;
  clock.advance(1000);
  assert.deepEqual(compositor.getSnapshot(), { mode: 'failed', reason: 'renderer status -1' });
  assert.equal(questMenuLayerVisible('failed'), false);
  assert.match(questMenuLayerNotice(compositor.getSnapshot()), /failed: renderer status -1/);
  assert.deepEqual(calls.hides, [1]);
  compositor.present(frame('ring'));
  assert.equal(calls.draws.length, 1);
  assert.equal(clock.pending.size, 0);
  compositor.dispose();
  assert.deepEqual(calls.hides, [1]);

  // open and draw fail on present; status fails on the first poll.
  const thrower = (message) => () => {
    throw new Error(message);
  };
  for (const [broken, reason] of [
    [{ open: thrower('no renderer') }, /^open no renderer$/],
    [{ draw: thrower('bad spec') }, /^draw bad spec$/],
    [{ status: thrower('gone') }, /^status gone$/],
  ]) {
    const poller = manualClock();
    const fake = fakeBackend();
    const failing = createQuestMenuCompositor({ ...fake.backend, ...broken }, { clock: poller });
    failing.present(frame());
    poller.advance(100);
    assert.equal(failing.getSnapshot().mode, 'failed');
    assert.match(failing.getSnapshot().reason, reason);
    assert.equal(poller.pending.size, 0);
    failing.dispose();
  }
});

test('a layer that has not appeared shows Viro buttons until it does', () => {
  const clock = manualClock();
  const { backend } = fakeBackend();
  const compositor = createQuestMenuCompositor(backend, { clock });
  compositor.present(frame());
  clock.advance(QUEST_MENU_LAYER_FIRST_SHOW_MS - 100);
  assert.equal(compositor.getSnapshot().mode, 'pending');
  clock.advance(100);
  assert.equal(compositor.getSnapshot().mode, 'slow');
  assert.equal(questMenuLayerVisible('slow'), false);
  compositor.present(frame('ring'));
  backend.statusValue = 1;
  clock.advance(100);
  assert.equal(compositor.getSnapshot().mode, 'shown');
  compositor.dispose();
});

test('without the patched renderer, or with the launcher choice off, no layer is opened', () => {
  const missing = fakeBackend();
  const unavailable = createQuestMenuCompositor(
    { ...missing.backend, available: () => false },
    { clock: manualClock() }
  );
  unavailable.present(frame());
  assert.equal(unavailable.getSnapshot().mode, 'unavailable');
  assert.equal(missing.calls.open, 0);

  const throwing = createQuestMenuCompositor(
    {
      ...fakeBackend().backend,
      available: () => {
        throw new Error('UnsatisfiedLinkError');
      },
    },
    { clock: manualClock() }
  );
  assert.equal(throwing.getSnapshot().mode, 'unavailable');

  const off = fakeBackend();
  const chosen = createQuestMenuCompositor(off.backend, { enabled: false, clock: manualClock() });
  chosen.present(frame());
  assert.equal(chosen.getSnapshot().mode, 'off');
  assert.equal(off.calls.open, 0);
  assert.match(questMenuLayerNotice(chosen.getSnapshot()), /launcher/);

  const seen = [];
  const stop = questMenuLayer.subscribe(() => seen.push(questMenuLayer.get()));
  questMenuLayer.toggle();
  questMenuLayer.set('viro');
  questMenuLayer.toggle();
  stop();
  questMenuLayer.toggle();
  assert.deepEqual(seen, ['viro', 'compositor']);
  questMenuLayer.set('compositor');
});

test('the mask writes depth and zero alpha inside rounded corners with colour writes on; the outline never hides rays', () => {
  const { questMenuLayerMask, questMenuFocus } = questMenuLayerMaterials();
  assert.equal(questMenuLayerMask.writesToDepthBuffer, true);
  assert.equal(questMenuLayerMask.readsFromDepthBuffer, true);
  assert.equal(questMenuLayerMask.blendMode, 'None');
  // Fully virtual: the eye buffer clears opaque, so alpha 0 must actually be written inside the card,
  // while corners outside the rounded-rect SDF discard so the scene shows untouched.
  assert.equal(Object.hasOwn(questMenuLayerMask, 'colorWriteMask'), false);
  assert.equal(questMenuLayerMask.shaderModifiers.fragment, QUEST_MENU_LAYER_MASK_FRAGMENT);
  assert.match(QUEST_MENU_LAYER_MASK_FRAGMENT, /if \(dist > -0\.0015\) discard;/);
  assert.match(QUEST_MENU_LAYER_MASK_FRAGMENT, /_output_color = vec4\(0\.0\);/);
  assert.equal(questMenuFocus.writesToDepthBuffer, false);
  assert.equal(questMenuFocus.readsFromDepthBuffer, true);
});

test('QuestPanelModule and the renderer patch agree on the JNI contract', () => {
  const kotlin = read(
    'modules/quest-panel/native/src/main/java/expo/modules/questpanel/QuestPanelModule.kt'
  );
  const patch = read('tools/quest/viro-renderer/0002-openxr-quest-panel-layer.patch');
  const lock = JSON.parse(read('tools/quest/viro-renderer/lock.json'));
  assert.deepEqual(lock.patches, [
    '0001-openxr-pointer-depth-origin-reticle.patch',
    '0002-openxr-quest-panel-layer.patch',
    '0003-openxr-quest-input-sampler.patch',
    '0004-openxr-quest-rig-sync.patch',
  ]);
  assert.match(kotlin, /^package expo\.modules\.questpanel$/m);
  assert.match(kotlin, /class QuestPanelModule : Module\(\)/);
  const kotlinVersion = /NATIVE_VERSION = (\d+)/.exec(kotlin)[1];
  const nativeVersion = /constexpr int kVersion = (\d+);/.exec(patch)[1];
  assert.equal(kotlinVersion, nativeVersion);
  const jni = {
    nativeVersion: ['jint', '(JNIEnv *, jobject)'],
    nativeStatus: ['jint', '(JNIEnv *, jobject)'],
    nativeRefSpaceEpoch: ['jint', '(JNIEnv *, jobject)'],
    nativeHide: ['void', '(JNIEnv *, jobject)'],
    nativePose: ['jboolean', 'jfloatArray pose'],
    nativeDraw: ['jboolean', 'jfloatArray pose'],
    nativeTitleStatus: ['jint', '(JNIEnv *, jobject)'],
    nativeTitleHide: ['void', '(JNIEnv *, jobject)'],
    nativeTitlePose: ['jboolean', 'jfloatArray pose'],
    nativeTitleDraw: ['jboolean', 'jfloatArray pose'],
  };
  for (const [name, [returns, args]] of Object.entries(jni)) {
    const symbol = `Java_expo_modules_questpanel_QuestPanelModule_${name}`;
    const at = patch.indexOf(symbol);
    assert.ok(at > 0, symbol);
    assert.match(patch.slice(at - 60, at), new RegExp(`JNIEXPORT ${returns} JNICALL`));
    assert.ok(patch.slice(at, at + 220).includes(args), `${name} arguments`);
    assert.match(kotlin, new RegExp(`private external fun ${name}\\(`));
  }
  assert.match(kotlin, /Function\("refSpaceEpoch"\)/);
  assert.match(kotlin, /Function\("openTitle"\)/);
  assert.match(kotlin, /Function\("drawTitle"\)/);
  assert.match(kotlin, /Typeface\.createFromFile/);
  assert.match(kotlin, /drawExecutor/);
  assert.match(
    kotlin,
    /external fun nativeDraw\(\s*rgba: ByteArray,\s*width: Int,\s*height: Int,\s*widthM: Float,\s*heightM: Float,\s*pose: FloatArray\s*\): Boolean/
  );
  assert.match(kotlin, /external fun nativePose\(pose: FloatArray\): Boolean/);
  assert.match(kotlin, /external fun nativeTitleDraw\(/);
  assert.match(kotlin, /external fun nativeTitlePose\(pose: FloatArray\): Boolean/);
  assert.match(
    read('modules/quest-panel/native/consumer-rules.pro'),
    /-keep class expo\.modules\.questpanel\.QuestPanelModule \{ \*; \}/
  );
  assert.deepEqual(JSON.parse(read('modules/quest-panel/expo-module.config.json')), {
    platforms: ['android'],
    android: { path: 'native', modules: ['expo.modules.questpanel.QuestPanelModule'] },
  });
  assert.match(
    read('modules/quest-panel/src/index.ts'),
    /requireOptionalNativeModule<QuestPanelNative>\('QuestPanel'\)/
  );
});

test('the renderer submits the layer under the scene and blends the eye buffer only while it is up', () => {
  const patch = read('tools/quest/viro-renderer/0002-openxr-quest-panel-layer.patch');
  const added = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  assert.doesNotMatch(patch, /anthropic|claude/i);
  // New file plus three hooks; the pointer patch's files are not touched.
  assert.match(
    patch,
    /new file mode 100644\nindex 0000000\.\.[0-9a-f]+\n--- \/dev\/null\n\+\+\+ b\/android\/sharedCode\/src\/main\/cpp\/QuestPanelLayer\.h/
  );
  const files = [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((match) => match[1]).sort();
  assert.deepEqual(files, [
    'android/sharedCode/src/main/cpp/QuestPanelLayer.h',
    'android/sharedCode/src/main/cpp/VRODisplayOpenGLOpenXR.h',
    'android/sharedCode/src/main/cpp/VROSceneRendererOpenXR.cpp',
    'android/sharedCode/src/main/cpp/VROSceneRendererOpenXR.h',
  ]);
  const pointer = read('tools/quest/viro-renderer/0001-openxr-pointer-depth-origin-reticle.patch');
  for (const file of files) assert.ok(!pointer.includes(`a/${file}`), `${file} is not in 0001`);
  // Quad layer, pushed before the projection layer (OpenXR draws later layers on top);
  // floating transparent title overlay pushed after the projection layer.
  assert.match(added, /XR_TYPE_COMPOSITION_LAYER_QUAD/);
  const cpp = patch.slice(
    patch.indexOf('diff --git a/android/sharedCode/src/main/cpp/VROSceneRendererOpenXR.cpp')
  );
  assert.ok(
    cpp.indexOf('layers.push_back(questPanel)') < cpp.indexOf('// Projection layer (3D scene)')
  );
  assert.ok(
    cpp.indexOf('layers.push_back(questTitlePanel)') >
      cpp.indexOf('layers.push_back(reinterpret_cast<const XrCompositionLayerBaseHeader *>(&projLayer))')
  );
  // Premultiplied source alpha, only as the else of the passthrough branch and
  // only while a panel is submitted; the brace and push_back are upstream context.
  assert.match(
    patch,
    /XR_COMPOSITION_LAYER_UNPREMULTIPLIED_ALPHA_BIT;\n\+\s+\} else if \(questPanel\) \{\n(?:\+\s+\/\/.*\n)+\+\s+projLayer\.layerFlags = XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT;\n \s+\}\n \s+layers\.push_back/
  );
  assert.doesNotMatch(
    added.slice(added.indexOf('else if (questPanel)')),
    /UNPREMULTIPLIED/,
    'the VR eye buffer is blended as premultiplied colour'
  );
  // Pixels and pose land together; one upload per revision; swapchain dies with the session.
  assert.match(added, /s\.pose = next;\n\+\s+s\.pixels\.resize/);
  assert.match(added, /if \(_revision != s\.revision\)/);
  assert.match(added, /_questPanel\.reset\(\);/);
  assert.match(
    added,
    /XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT;\n\+\s+_layer\.eyeVisibility/
  );
  // The clear restores Viro's cached masks.
  assert.match(
    added,
    /glColorMask\(colorMask\[0\], colorMask\[1\], colorMask\[2\], colorMask\[3\]\);/
  );
  // Clear alpha to 0 before rendering eyes whenever questPanel is active so HDR tone-mapping
  // preserves the zero-alpha mask hole; restore 1.0 when hidden.
  assert.match(
    cpp,
    /display->setClearAlpha\(\(_passthroughEnabled \|\| questPanel\) \? 0\.0f : 1\.0f\);/
  );
  assert.match(added, /XR_TYPE_EVENT_DATA_REFERENCE_SPACE_CHANGE_PENDING/);
  assert.match(added, /quest_panel::bumpRefSpaceEpoch\(\)/);
  assert.doesNotMatch(
    added,
    /xrCreateSession|xrBeginSession|xrCreateReferenceSpace|recenterTracking/
  );
  const build = read('tools/quest/build-viro-renderer.mjs');
  assert.match(build, /for \(const patchFile of patchFiles\)/);
  assert.match(build, /menu layer JNI methods are not exported/);
});

test('replay invalidates and re-uploads the current frame on the same owner without hiding or reopening', () => {
  const clock = manualClock();
  const { backend, calls } = fakeBackend();
  const compositor = createQuestMenuCompositor(backend, { clock });

  // replay() before the first present does not draw.
  compositor.replay();
  assert.equal(calls.open, 0);
  assert.equal(calls.draws.length, 0);
  assert.equal(calls.invalidates.length, 0);

  const initialFrame = frame('ring', 'standing');
  compositor.present(initialFrame);
  backend.statusValue = 1;
  clock.advance(100);
  assert.equal(compositor.getSnapshot().mode, 'shown');
  assert.equal(calls.draws.length, 1);

  // After shown, present of the same frame does not draw again.
  compositor.present(initialFrame);
  assert.equal(calls.draws.length, 1);

  // replay() calls invalidate(owner) once, then draw once with the same spec and owner, without hide or open.
  compositor.replay();
  assert.deepEqual(calls.invalidates, [1]);
  assert.equal(calls.draws.length, 2);
  assert.equal(calls.draws[1].owner, 1);
  assert.deepEqual(calls.draws[1].spec, calls.draws[0].spec);
  assert.deepEqual(calls.hides, []);
  assert.equal(calls.open, 1);

  // A second identical present after replay does not draw again.
  compositor.present(initialFrame);
  assert.equal(calls.draws.length, 2);

  // replay() in failed mode does not draw.
  backend.statusValue = -1;
  clock.advance(1000);
  assert.equal(compositor.getSnapshot().mode, 'failed');
  compositor.replay();
  assert.equal(calls.draws.length, 2);
  compositor.dispose();

  // replay() in off and unavailable modes does not draw.
  const off = fakeBackend();
  const offCompositor = createQuestMenuCompositor(off.backend, { enabled: false, clock });
  offCompositor.present(initialFrame);
  offCompositor.replay();
  assert.equal(off.calls.draws.length, 0);
  assert.equal(off.calls.invalidates.length, 0);

  const unavail = fakeBackend();
  const unavailCompositor = createQuestMenuCompositor(
    { ...unavail.backend, available: () => false },
    { clock }
  );
  unavailCompositor.present(initialFrame);
  unavailCompositor.replay();
  assert.equal(unavail.calls.draws.length, 0);
  assert.equal(unavail.calls.invalidates.length, 0);

  // If invalidate throws, compositor falls back cleanly to Viro buttons ('failed') and hides the owner.
  const broken = fakeBackend();
  const brokenClock = manualClock();
  const throwing = createQuestMenuCompositor(
    {
      ...broken.backend,
      invalidate: () => {
        throw new Error('native invalidate failed');
      },
    },
    { clock: brokenClock }
  );
  throwing.present(initialFrame);
  broken.backend.statusValue = 1;
  brokenClock.advance(100);
  throwing.replay();
  assert.equal(throwing.getSnapshot().mode, 'failed');
  assert.match(throwing.getSnapshot().reason, /invalidate native invalidate failed/);
  assert.deepEqual(broken.calls.hides, [1]);
  throwing.dispose();
});
