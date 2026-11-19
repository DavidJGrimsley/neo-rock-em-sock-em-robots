const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  QUEST_MENU_ACTIONS,
  QUEST_MENU_POSE,
  QUEST_MENU_SIZE,
  QUEST_MENU_TEXTURE,
  QUEST_RING_POSE,
  buildQuestMenu,
  questMenuButtonFrame,
  questMenuButtons,
  questMenuHit,
  wrapMenuLine,
} = require('../src/features/quest-vr/quest-menu-layout.ts');
const {
  QUEST_ASSET_TIMEOUT_MS,
  applyQuestReady,
  createQuestArenaSession,
  questReadyDecision,
} = require('../src/features/quest-vr/quest-arena-session.ts');

const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

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

test('menu pixels and controller frames describe the same buttons', () => {
  assert.deepEqual(QUEST_MENU_ACTIONS, ['solo', 'ready', 'back', 'exit']);
  const seen = new Set();
  for (const page of ['menu', 'ring']) {
    const buttons = questMenuButtons(page);
    for (const button of buttons) {
      seen.add(button.action);
      assert.ok(button.x >= 0 && button.y >= 0);
      assert.ok(button.x + button.width <= QUEST_MENU_TEXTURE.widthPx);
      assert.ok(button.y + button.height <= QUEST_MENU_TEXTURE.heightPx);
      const frame = questMenuButtonFrame(button);
      assert.ok(Math.abs(frame.position[0]) + frame.width / 2 <= QUEST_MENU_SIZE.widthM / 2);
      assert.ok(Math.abs(frame.position[1]) + frame.height / 2 <= QUEST_MENU_SIZE.heightM / 2);
      assert.equal(questMenuHit(page, frame.position[0], frame.position[1]), button.action);
      assert.equal(
        questMenuHit(page, frame.position[0], frame.position[1] + frame.height / 2 + 0.001),
        null
      );
    }
    for (let index = 0; index < buttons.length; index++) {
      for (let other = index + 1; other < buttons.length; other++) {
        const a = buttons[index];
        const b = buttons[other];
        const separated =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        assert.equal(separated, true);
      }
    }
  }
  assert.deepEqual([...seen].sort(), [...QUEST_MENU_ACTIONS].sort());
  assert.equal(questMenuHit('menu', 0, 0), null);
  assert.equal(
    questMenuButtons('ring').some((button) => button.action === 'solo'),
    false
  );
  assert.ok(QUEST_RING_POSE.position[2] < QUEST_MENU_POSE.ring.position[2]);
  assert.ok(QUEST_MENU_POSE.ring.position[1] > QUEST_MENU_POSE.menu.position[1]);
  const menu = buildQuestMenu('ring', ['Ready did not start. Headset tracking was not asserted.']);
  assert.match(menu.specKey, /Ready/);
  assert.match(menu.specKey, /Back/);
  assert.deepEqual(wrapMenuLine('one two three', 7), ['one two', 'three']);
});

test('Ready calls the real solo action only when it cannot start a fight', () => {
  assert.deepEqual(questReadyDecision(false), { callReady: true, reason: 'not-ready' });
  assert.deepEqual(questReadyDecision(true), {
    callReady: false,
    reason: 'combat-controls-absent',
  });
  let calls = 0;
  const blocked = applyQuestReady({
    getSnapshot: () => ({ canReady: true }),
    ready: () => {
      calls += 1;
      return true;
    },
    invalidatePlacementReady() {
      throw new Error('ready() should not have been called');
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(blocked, { called: false, started: false, reason: 'combat-controls-absent' });

  let invalidated = 0;
  const unexpected = applyQuestReady({
    getSnapshot: () => ({ canReady: false }),
    ready: () => true,
    invalidatePlacementReady: () => {
      invalidated += 1;
    },
  });
  assert.equal(invalidated, 1);
  assert.equal(unexpected.started, false);
  assert.equal(unexpected.called, true);
});

test('solo keeps ArenaMatch untracked and Ready does not leave the lobby', () => {
  const clock = fakeClock();
  const session = createQuestArenaSession(clock);
  assert.equal(session.getSnapshot().page, 'menu');
  assert.equal(session.ready().reason, 'no-match');
  assert.equal(session.solo(), true);
  assert.equal(session.solo(), false);
  const opened = session.getSnapshot();
  assert.equal(opened.page, 'ring');
  assert.equal(opened.mode, 'solo');
  assert.equal(opened.stage, 'lobby');
  assert.equal(opened.tracking, false);
  assert.equal(opened.placed, false);
  assert.equal(opened.landscape, true);
  assert.equal(opened.canReady, false);
  assert.equal(opened.localReady, false);
  assert.match(opened.message, /tracking is stable/);
  assert.match(opened.lines.join('\n'), /not an AR plane/);
  const result = session.ready();
  const afterReady = session.getSnapshot();
  assert.equal(result.called, true);
  assert.equal(result.started, false);
  assert.equal(result.reason, 'not-ready');
  assert.equal(afterReady.stage, 'lobby');
  assert.equal(afterReady.localReady, false);
  assert.equal(afterReady.tracking, false);
  assert.equal(afterReady.placed, false);
  assert.match(afterReady.lines.join('\n'), /Headset tracking was not asserted/);

  const staleLease = afterReady.lease;
  session.assetLoaded(staleLease, afterReady.token, afterReady.placementVersion, 'arena');
  session.assetLoaded(staleLease, afterReady.token, afterReady.placementVersion, 'blue');
  session.assetLoaded(staleLease, afterReady.token, afterReady.placementVersion, 'red');
  assert.equal(session.getSnapshot().assetsLoaded, 3);
  assert.equal(session.getSnapshot().tracking, false);
  assert.equal(session.getSnapshot().placed, false);
  assert.equal(session.getSnapshot().stage, 'lobby');
  assert.equal(clock.pending.size, 0);

  assert.equal(session.back(), 'menu');
  assert.equal(session.getSnapshot().mode, null);
  assert.equal(session.getSnapshot().page, 'menu');
  session.assetLoaded(staleLease, afterReady.token, afterReady.placementVersion, 'arena');
  assert.equal(session.solo(), true);
  const reopened = session.getSnapshot();
  assert.notEqual(reopened.lease, staleLease);
  assert.equal(reopened.assetsLoaded, 0);
  session.assetLoaded(staleLease, afterReady.token, afterReady.placementVersion, 'arena');
  assert.equal(session.getSnapshot().assetsLoaded, 0);
  session.exit();
  assert.equal(session.getSnapshot().mode, null);
  session.dispose();
  session.dispose();
  assert.equal(session.solo(), false);
});

test('a missed arena asset is reported without asserting tracking', () => {
  const clock = fakeClock();
  const session = createQuestArenaSession(clock);
  session.solo();
  assert.equal([...clock.pending.values()][0].delay, QUEST_ASSET_TIMEOUT_MS);
  clock.fire();
  const failed = session.getSnapshot();
  assert.match(failed.message, /Arena could not load/);
  assert.equal(failed.tracking, false);
  assert.equal(failed.placed, false);
  assert.equal(failed.stage, 'lobby');
  session.back();
  assert.equal(clock.pending.size, 0);
});

test('the Quest scene stays on the existing virtual navigator and stock assets', () => {
  const scene = source('src/features/quest-vr/quest-arena-scene.native.tsx');
  const navigator = source('src/features/quest-vr/quest-xr-navigator.native.tsx');
  const moduleSource = source(
    'modules/quest-menu-texture/native/src/main/java/expo/modules/questmenutexture/QuestMenuTextureModule.kt'
  );
  assert.match(scene, /Fight_Arena\.glb/);
  assert.match(scene, /Mike_Player1_Blue_Combat_AR\.glb/);
  assert.match(scene, /Mike_Player2_RedOrange_Combat_AR\.glb/);
  assert.match(scene, /ARENA_LAYOUT/);
  assert.match(scene, /questMenuHit/);
  assert.match(scene, /renderQuestMenuTexture/);
  assert.doesNotMatch(
    scene,
    /ViroARScene|ViroXRSceneNavigator|setTracking|setPlacement|ViroGameLoop/
  );
  assert.match(navigator, /passthroughEnabled=\{false\}/);
  assert.match(navigator, /quest-arena-scene\.native/);
  assert.equal(
    fs.existsSync(path.join(__dirname, '../src/features/quest-vr/quest-smoke-scene.native.tsx')),
    false
  );
  assert.doesNotMatch(moduleSource, /viro_renderer|OpenXR|XrSession|nativeDraw/);
  assert.doesNotMatch(source('app.config.ts'), /QUEST_COMPOSITOR|quest-compositor/);
});
