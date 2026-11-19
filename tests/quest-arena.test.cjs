const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  QUEST_MENU_ACTIONS,
  QUEST_MENU_POSE,
  QUEST_MENU_SIZE,
  QUEST_MENU_TAGLINE,
  QUEST_MENU_TEXTURE,
  QUEST_RING_POSE,
  buildQuestMenu,
  questMenuButtonFrame,
  questMenuButtons,
  questMenuHit,
  questMenuMaterialName,
  wrapMenuLine,
} = require('../src/features/quest-vr/quest-menu-layout.ts');
const { questPointerHover, questTriggerPress } = require('../src/features/quest-vr/quest-menu-input.ts');
const {
  QUEST_ASSET_TIMEOUT_MS,
  QUEST_LEAVING,
  QUEST_READY_SAVED,
  createQuestArenaSession,
  questReadyAcknowledgement,
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
  assert.equal(QUEST_MENU_POSE.menu.position[2], -1.15);
  assert.equal(QUEST_MENU_POSE.ring.position[2], -1.15);
  assert.deepEqual(QUEST_MENU_SIZE, { widthM: 1.6, heightM: 0.9 });
  const ringButtons = questMenuButtons('ring');
  const gapM =
    ((ringButtons[1].x - (ringButtons[0].x + ringButtons[0].width)) / QUEST_MENU_TEXTURE.widthPx) *
    QUEST_MENU_SIZE.widthM;
  assert.ok(gapM > 0.06, `button gap ${gapM} m`);
  assert.ok(questMenuButtonFrame(ringButtons[0]).height >= 0.18);
  const menu = buildQuestMenu('menu', ['Solo places both robots in the ring.']);
  assert.match(menu.specKey, /Solo/);
  assert.match(menu.specKey, /Exit/);
  assert.match(menu.specKey, new RegExp(QUEST_MENU_TAGLINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(menu.specKey, /#60a5fa/);
  assert.match(menu.specKey, /#d99a9a/);
  assert.match(menu.specKey, /#E818181B/);
  assert.match(menu.specKey, /#09090b/);
  assert.doesNotMatch(menu.specKey, /#0f766e|#991b1b|#101826/);
  const ring = buildQuestMenu('ring', ['Both robots are in the ring.']);
  assert.equal(ring.buttons.find((button) => button.action === 'ready').label, 'Ready');
  const set = buildQuestMenu('ring', ['Both robots are in the ring.'], { acknowledged: true });
  assert.equal(set.buttons.find((button) => button.action === 'ready').label, 'Set');
  assert.equal(questMenuHit('ring', questMenuButtonFrame(set.buttons[0]).position[0], questMenuButtonFrame(set.buttons[0]).position[1], true), 'ready');
  const hovered = buildQuestMenu('menu', ['Solo places both robots in the ring.'], { hover: 'solo' });
  assert.notEqual(hovered.specKey, menu.specKey);
  const solo = menu.buttons.find((button) => button.action === 'solo');
  assert.match(hovered.specKey, new RegExp(`"x":${solo.x}`));
  assert.deepEqual(wrapMenuLine('one two three', 7), ['one two', 'three']);
  const titled = buildQuestMenu('menu', ['Solo places both robots in the ring.'], {
    assets: {
      backgroundUri: 'file:///menu-background.png',
      titles: {
        neo: 'file:///neo.png',
        rock: 'file:///rock.png',
        robots: 'file:///robots.png',
      },
    },
  });
  assert.match(titled.specKey, /menu-background\.png/);
  assert.match(titled.specKey, /rock\.png/);
});

test('trigger presses and hover ignore gaze, grips, and repeat clicks', () => {
  const state = { down: new Set() };
  assert.equal(questTriggerPress(state, 1, 1), 'activate');
  assert.equal(questTriggerPress(state, 1, 1), 'ignore');
  assert.equal(questTriggerPress(state, 3, 1), 'ignore');
  assert.equal(questTriggerPress(state, 2, 1), 'release');
  assert.equal(questTriggerPress(state, 1, 1), 'activate');
  assert.equal(questTriggerPress(state, 1, 4), 'activate');
  for (const source of [3, 5, 6, 7, 8, 9, 12])
    assert.equal(questTriggerPress({ down: new Set() }, 1, source), 'ignore', `source ${source}`);
  const hover = new Set();
  assert.equal(questPointerHover(hover, true, 12), false);
  assert.equal(questPointerHover(hover, true, 1), true);
  assert.equal(questPointerHover(hover, false, 12), true);
  assert.equal(questPointerHover(hover, true, 8), true);
  assert.equal(questPointerHover(hover, false, 1), false);
});

test('menu material names are stable per PNG and distinct across PNGs', () => {
  const left = questMenuMaterialName('file:///panel-a.png');
  const right = questMenuMaterialName('file:///panel-b.png');
  assert.notEqual(left, right);
  assert.equal(left, questMenuMaterialName('file:///panel-a.png'));
  assert.match(left, /^questMenu-[0-9a-f]+$/);
});

test('Ready acknowledges the lobby and does not call ArenaMatch.ready', () => {
  assert.deepEqual(questReadyAcknowledgement(false), {
    called: false,
    started: false,
    reason: 'no-match',
  });
  assert.deepEqual(questReadyAcknowledgement(true), {
    called: false,
    started: false,
    reason: 'acknowledged',
  });
  const sessionSource = source('src/features/quest-vr/quest-arena-session.ts');
  assert.doesNotMatch(sessionSource, /match\.ready\(|invalidatePlacementReady|questReadyDecision/);
  assert.doesNotMatch(sessionSource, /setTracking|setPlacement|tick\(/);
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
  assert.doesNotMatch(opened.lines.join('\n'), /tracking/i);
  assert.match(opened.lines.join('\n'), /stay idle/);
  const result = session.ready();
  const afterReady = session.getSnapshot();
  assert.equal(result.called, false);
  assert.equal(result.started, false);
  assert.equal(result.reason, 'acknowledged');
  assert.equal(afterReady.acknowledged, true);
  assert.equal(afterReady.stage, 'lobby');
  assert.equal(afterReady.localReady, false);
  assert.equal(afterReady.tracking, false);
  assert.equal(afterReady.placed, false);
  assert.match(afterReady.lines.join('\n'), new RegExp(QUEST_READY_SAVED));
  const again = session.ready();
  assert.equal(again.reason, 'acknowledged');
  assert.equal(session.getSnapshot().stage, 'lobby');
  assert.equal(session.getSnapshot().localReady, false);

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
  assert.equal(session.getSnapshot().acknowledged, false);
  assert.doesNotMatch(session.getSnapshot().lines.join('\n'), /Ready saved/);
  session.assetLoaded(staleLease, afterReady.token, afterReady.placementVersion, 'arena');
  assert.equal(session.solo(), true);
  const reopened = session.getSnapshot();
  assert.notEqual(reopened.lease, staleLease);
  assert.equal(reopened.assetsLoaded, 0);
  session.assetLoaded(staleLease, afterReady.token, afterReady.placementVersion, 'arena');
  assert.equal(session.getSnapshot().assetsLoaded, 0);
  session.exit();
  assert.equal(session.getSnapshot().mode, null);
  assert.equal(session.getSnapshot().page, 'menu');
  assert.match(session.getSnapshot().lines.join('\n'), new RegExp(QUEST_LEAVING));
  assert.equal(session.solo(), false);
  session.exit();
  assert.match(session.getSnapshot().lines.join('\n'), new RegExp(QUEST_LEAVING));
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
  assert.match(scene, /questTriggerPress/);
  assert.match(scene, /questPointerHover/);
  assert.match(scene, /onClickState/);
  assert.match(scene, /createQuestMenuTexturePipeline/);
  assert.match(scene, /menu-background\.png/);
  assert.match(scene, /quest-lettering\/rock\.png/);
  assert.match(scene, /session\.exit\(\)/);
  assert.match(scene, /exitVRScene\(\)/);
  assert.doesNotMatch(scene, /onClick=\{/);
  assert.doesNotMatch(scene, /exitRequest !== null/);
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
  assert.match(scene, /resolveQuestMenuAssetFile/);
  assert.doesNotMatch(scene, /localUri \?\? asset\.uri/);
  assert.match(moduleSource, /"image"/);
  assert.match(moduleSource, /Typeface\.createFromFile/);
  assert.match(moduleSource, /getIdentifier/);
  assert.match(moduleSource, /android_res/);
  assert.match(moduleSource, /quest-menu-src/);
  assert.match(moduleSource, /keep/);
  assert.doesNotMatch(moduleSource, /dropLast/);
  assert.doesNotMatch(moduleSource, /viro_renderer|OpenXR|XrSession|nativeDraw/);
  assert.doesNotMatch(source('app.config.ts'), /QUEST_COMPOSITOR|quest-compositor/);
});
