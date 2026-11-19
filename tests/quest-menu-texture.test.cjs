const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createQuestMenuTexturePipeline,
  questMenuDisplay,
  questMenuInputKey,
} = require('../src/features/quest-vr/quest-menu-texture-pipeline.ts');
const { questMenuMaterialName } = require('../src/features/quest-vr/quest-menu-layout.ts');

const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// A backend whose draw and Viro registration finish only when the test says so.
function fakeBackend() {
  const renders = [];
  const prepares = [];
  const released = { names: [], uris: [] };
  const logs = [];
  let next = 0;
  return {
    renders,
    prepares,
    released,
    logs,
    backend: {
      render(ops, keep) {
        const call = { ops, keep, ...deferred() };
        renders.push(call);
        return call.promise;
      },
      prepare(name, uri) {
        const call = { name, uri, ...deferred() };
        prepares.push(call);
        return call.promise;
      },
      release(names, uris) {
        released.names.push(...names);
        released.uris.push(...uris);
        return Promise.resolve(0);
      },
      log(level, message) {
        logs.push(`${level} ${message}`);
      },
    },
    async draw(index = renders.length - 1) {
      next += 1;
      const uri = `file:///cache/quest-menu/panel-${next}.png`;
      renders[index].resolve({ uri, width: 2048, height: 1152, probe: ['FF18181B'] });
      await flush();
      return uri;
    },
    async register(index = prepares.length - 1) {
      prepares[index].resolve({ width: 2048, height: 1152, ms: 12 });
      await flush();
    },
  };
}

function manualClock() {
  const timers = new Map();
  let id = 0;
  return {
    schedule(callback) {
      id += 1;
      timers.set(id, callback);
      return id;
    },
    cancel(handle) {
      timers.delete(handle);
    },
    fireAll() {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
  };
}

const spec = (key, page = 'menu', acknowledged = false) => ({ key, page, acknowledged, ops: [] });

test('the panel quad never names a material before Viro reports its texture', async () => {
  const fake = fakeBackend();
  const pipeline = createQuestMenuTexturePipeline(fake.backend);
  const view = { page: 'menu', acknowledged: false };
  pipeline.request(spec('menu-a'));
  assert.equal(questMenuDisplay(view, pipeline.getSnapshot()).kind, 'loading');
  assert.equal(questMenuDisplay(view, pipeline.getSnapshot()).input, false);

  const uri = await fake.draw();
  // Drawn but not registered: still no material and no input.
  assert.equal(fake.prepares.length, 1);
  assert.equal(fake.prepares[0].uri, uri);
  assert.equal(fake.prepares[0].name, questMenuMaterialName(uri));
  assert.equal(questMenuDisplay(view, pipeline.getSnapshot()).kind, 'loading');

  await fake.register();
  const shown = questMenuDisplay(view, pipeline.getSnapshot());
  assert.equal(shown.kind, 'art');
  assert.equal(shown.material, questMenuMaterialName(uri));
  assert.equal(shown.input, true);
  assert.ok(fake.logs.some((line) => line.includes('probe FF18181B')));
});

test('a Viro or image-load failure shows an error panel with buttons, not white', async () => {
  const fake = fakeBackend();
  const pipeline = createQuestMenuTexturePipeline(fake.backend);
  pipeline.request(spec('menu-a'));
  const uri = await fake.draw();
  fake.prepares[0].reject(new Error('Viro stored questMenu-1 without a texture'));
  await flush();
  const display = questMenuDisplay({ page: 'menu', acknowledged: false }, pipeline.getSnapshot());
  assert.equal(display.kind, 'error');
  assert.equal(display.input, true);
  assert.match(display.message, /without a texture/);
  assert.deepEqual(fake.released.uris, [uri]);
  assert.ok(fake.logs.some((line) => line.startsWith('error menu failed')));

  // A draw failure (module missing, bad asset) takes the same path.
  const second = fakeBackend();
  const other = createQuestMenuTexturePipeline(second.backend);
  other.request(spec('menu-a'));
  second.renders[0].reject(new Error('Menu texture module is unavailable.'));
  await flush();
  const failed = questMenuDisplay({ page: 'menu', acknowledged: false }, other.getSnapshot());
  assert.equal(failed.kind, 'error');
  assert.equal(second.prepares.length, 0);
});

test('a page change keeps the old art, pose and targets with input off until new art', async () => {
  const fake = fakeBackend();
  const pipeline = createQuestMenuTexturePipeline(fake.backend);
  pipeline.request(spec('menu-a'));
  await fake.draw();
  await fake.register();
  const before = questMenuDisplay({ page: 'menu', acknowledged: false }, pipeline.getSnapshot());

  pipeline.request(spec('ring-a', 'ring'));
  const during = questMenuDisplay({ page: 'ring', acknowledged: false }, pipeline.getSnapshot());
  assert.equal(during.kind, 'art');
  assert.equal(during.page, 'menu');
  assert.equal(during.material, before.material);
  assert.equal(during.input, false);
  assert.notEqual(questMenuInputKey(during), questMenuInputKey(before));

  const ringUri = await fake.draw();
  assert.equal(questMenuDisplay({ page: 'ring', acknowledged: false }, pipeline.getSnapshot()).input, false);
  await fake.register();
  const after = questMenuDisplay({ page: 'ring', acknowledged: false }, pipeline.getSnapshot());
  assert.equal(after.page, 'ring');
  assert.equal(after.material, questMenuMaterialName(ringUri));
  assert.equal(after.input, true);
});

test('Ready to Set is a screen change: the Ready art is not clickable as Set', async () => {
  const fake = fakeBackend();
  const pipeline = createQuestMenuTexturePipeline(fake.backend);
  pipeline.request(spec('ring-ready', 'ring', false));
  await fake.draw();
  await fake.register();
  pipeline.request(spec('ring-set', 'ring', true));
  const pending = questMenuDisplay({ page: 'ring', acknowledged: true }, pipeline.getSnapshot());
  assert.equal(pending.acknowledged, false);
  assert.equal(pending.input, false);
  await fake.draw();
  await fake.register();
  const done = questMenuDisplay({ page: 'ring', acknowledged: true }, pipeline.getSnapshot());
  assert.equal(done.acknowledged, true);
  assert.equal(done.input, true);
});

test('art for a screen the player already left is released, never shown', async () => {
  const fake = fakeBackend();
  const pipeline = createQuestMenuTexturePipeline(fake.backend);
  pipeline.request(spec('menu-a'));
  await fake.draw();
  await fake.register();
  pipeline.request(spec('ring-a', 'ring'));
  pipeline.request(spec('menu-b'));
  const ringUri = await fake.draw(1);
  await fake.register(1);
  assert.ok(fake.released.names.includes(questMenuMaterialName(ringUri)));
  assert.ok(fake.released.uris.includes(ringUri));
  assert.notEqual(pipeline.getSnapshot().shown.page, 'ring');
  // The newest request is drawn next.
  assert.equal(fake.renders.length, 3);
});

test('requests coalesce to the newest spec and registered materials stay bounded', async () => {
  const fake = fakeBackend();
  const pipeline = createQuestMenuTexturePipeline(fake.backend);
  const shownUris = [];
  pipeline.request(spec('hover-0'));
  for (let round = 1; round <= 5; round += 1) {
    // Three hover changes while one draw is running cost one more draw.
    pipeline.request(spec(`hover-${round}-a`));
    pipeline.request(spec(`hover-${round}-b`));
    pipeline.request(spec(`hover-${round}`));
    shownUris.push(await fake.draw());
    await fake.register();
  }
  shownUris.push(await fake.draw());
  await fake.register();
  assert.equal(fake.renders.length, 6);
  assert.equal(pipeline.getSnapshot().shown.key, 'hover-5');
  // Every draw except the shown one and the one before it has been released.
  const live = shownUris.slice(-2);
  for (const uri of shownUris.slice(0, -2)) {
    assert.ok(fake.released.names.includes(questMenuMaterialName(uri)), uri);
    assert.ok(fake.released.uris.includes(uri), uri);
  }
  for (const uri of live) assert.ok(!fake.released.uris.includes(uri), uri);
  // Files Viro may still read are kept by the next draw.
  pipeline.request(spec('hover-6'));
  assert.deepEqual([...fake.renders.at(-1).keep].sort(), [...live].sort());
});

test('the in-flight PNG is kept while Viro reads it', async () => {
  const fake = fakeBackend();
  const pipeline = createQuestMenuTexturePipeline(fake.backend);
  pipeline.request(spec('menu-a'));
  const first = await fake.draw();
  // The second request waits; it must not start a draw that sweeps the file.
  pipeline.request(spec('menu-b'));
  assert.equal(fake.renders.length, 1);
  await fake.register();
  assert.deepEqual(fake.renders[1].keep, [first]);
});

test('a hung Viro registration times out to an error and its late result is released', async () => {
  const fake = fakeBackend();
  const clock = manualClock();
  const pipeline = createQuestMenuTexturePipeline(fake.backend, { clock, timeoutMs: 10 });
  pipeline.request(spec('menu-a'));
  const uri = await fake.draw();
  clock.fireAll();
  await flush();
  const display = questMenuDisplay({ page: 'menu', acknowledged: false }, pipeline.getSnapshot());
  assert.equal(display.kind, 'error');
  assert.match(display.message, /timed out/);
  await fake.register();
  assert.ok(fake.released.names.includes(questMenuMaterialName(uri)));
  assert.equal(pipeline.getSnapshot().shown, null);
});

test('leaving the scene releases shown art and anything still in flight', async () => {
  const fake = fakeBackend();
  const pipeline = createQuestMenuTexturePipeline(fake.backend);
  pipeline.request(spec('menu-a'));
  const first = await fake.draw();
  await fake.register();
  pipeline.request(spec('menu-b'));
  const second = await fake.draw();
  pipeline.dispose();
  assert.ok(fake.released.uris.includes(first));
  await fake.register();
  assert.ok(fake.released.names.includes(questMenuMaterialName(second)));
  pipeline.request(spec('menu-c'));
  assert.equal(fake.renders.length, 2);
});

test('the scene mounts art only from the pipeline and gates targets on input', () => {
  const scene = source('src/features/quest-vr/quest-arena-scene.native.tsx');
  // Exactly one createMaterials call, at module scope, with colour-only materials.
  assert.equal(scene.match(/ViroMaterials\.createMaterials\(/g).length, 1);
  assert.doesNotMatch(scene, /diffuseTexture/);
  assert.match(scene, /prepareQuestMenuMaterial/);
  assert.match(scene, /releaseQuestMenuMaterials/);
  assert.match(scene, /pipeline\.dispose\(\)/);
  assert.match(scene, /questMenuDisplay\(/);
  assert.match(scene, /display\.input\s*\?\s*buttons\.map/);
  assert.match(scene, /QUEST_MENU_POSE\[display\.page\]/);
  assert.doesNotMatch(scene, /QUEST_MENU_POSE\[view\.page\]/);
  assert.match(scene, /if \(!display\.input \|\| inputKeyRef\.current !== inputKey\) return;/);
  // The invisible targets blend zero alpha instead of writing opaque black.
  assert.match(scene, /questMenuHit: \{[\s\S]*?blendMode: 'Alpha'[\s\S]*?diffuseColor: '#00000000'/);
});

test('the native readiness check uses Viro\'s queue and verifies the texture', () => {
  const kotlin = source(
    'modules/quest-menu-texture/native/src/main/java/expo/modules/questmenutexture/QuestMenuTextureModule.kt'
  );
  const rules = source('modules/quest-menu-texture/native/consumer-rules.pro');
  // Without this the module's com.facebook.react.bridge imports do not compile.
  assert.match(
    source('modules/quest-menu-texture/native/build.gradle'),
    /implementation 'com\.facebook\.react:react-android'/
  );
  assert.match(kotlin, /runOnNativeModulesQueueThread/);
  assert.match(kotlin, /getNativeModule\("VRTMaterialManager"\)/);
  assert.match(kotlin, /"setJSMaterials"/);
  assert.match(kotlin, /"getMaterial"/);
  assert.match(kotlin, /"getDiffuseTexture"/);
  assert.match(kotlin, /"deleteMaterials"/);
  assert.match(kotlin, /inJustDecodeBounds = true/);
  assert.match(kotlin, /AsyncFunction\("prepareMaterial"\)/);
  assert.match(kotlin, /AsyncFunction\("releaseMaterials"\)/);
  // Deletion is limited to this module's panel files.
  assert.match(kotlin, /name\.startsWith\("panel-"\)/);
  for (const member of ['setJSMaterials', 'deleteMaterials', 'getMaterial', 'getDiffuseTexture', 'getWidth']) {
    assert.match(rules, new RegExp(member));
  }
});
