const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const layout = require('../src/features/quest-vr/quest-menu-layout.ts');
const {
  QUEST_MENU_ACTIONS,
  QUEST_MENU_ALERT_SHIFT_M,
  QUEST_MENU_ALERT_SIZE,
  QUEST_MENU_ALERT_TEXTURE,
  QUEST_MENU_POSE,
  QUEST_MENU_SIZE,
  QUEST_MENU_TEXTURE,
  QUEST_MENU_TEXT_LINES_MAX,
  QUEST_TITLE_POSE,
  QUEST_TITLE_SIZE,
  QUEST_TITLE_TEXTURE,
  buildQuestMenu,
  buildQuestMenuTitle,
  questMenuButtonFrame,
  questMenuButtons,
  questMenuHit,
  wrapMenuLine,
} = layout;
const {
  questPointerHover,
  questTriggerPress,
} = require('../src/features/quest-vr/quest-menu-input.ts');
const { ARENA_LAYOUT, ARENA_RULES } = require('../src/features/arena-fighter/arena-controller.ts');
const {
  QUEST_ASSET_TIMEOUT_MS,
  QUEST_LEAVING,
  createQuestArenaSession,
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

function rectanglesOverlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test('menu pixels and controller frames describe the same buttons', () => {
  assert.equal(Object.hasOwn(layout, 'QUEST_RING_POSE'), false);
  assert.deepEqual(QUEST_MENU_POSE.menu, {
    position: [0, -0.18, -1.5],
    rotation: [0, 0, 0],
  });
  assert.deepEqual(QUEST_MENU_POSE.ring, {
    position: [0, -0.78, -1.35],
    rotation: [0, 0, 0],
  });
  assert.deepEqual(QUEST_MENU_POSE.pause, {
    position: [0, -0.18, -1.5],
    rotation: [0, 0, 0],
  });
  assert.deepEqual(QUEST_MENU_SIZE, { widthM: 0.95, heightM: 0.3375 });
  assert.deepEqual(QUEST_MENU_ALERT_SIZE, { widthM: 0.95, heightM: 0.5625 });
  assert.deepEqual(QUEST_TITLE_POSE.menu, {
    position: [0, 0.43, -1.5],
    rotation: [0, 0, 0],
  });
  assert.deepEqual(QUEST_TITLE_POSE.ring, {
    position: [0, 0.86, -2.6],
    rotation: [0, 0, 0],
  });
  assert.deepEqual(QUEST_TITLE_POSE.pause, {
    position: [0, 0.43, -1.5],
    rotation: [0, 0, 0],
  });

  const pages = {
    menu: ['solo', 'posture', 'exit'],
    ring: ['ready', 'back', 'posture', 'exit'],
    pause: ['resume', 'back', 'settings', 'exit'],
    settings: [
      'music-volume',
      'sfx-volume',
      'damage-tint',
      'turn-mode',
      'movement-mode',
      'pause-done',
    ],
    result: ['ready', 'back', 'exit'],
  };
  const seen = new Set();
  for (const page of Object.keys(pages)) {
    for (const posture of ['standing', 'seated']) {
      const buttons = questMenuButtons(page, { acknowledged: false, posture });
      assert.deepEqual(
        buttons.map((button) => button.action),
        pages[page]
      );
      assert.equal(new Set(buttons.map((button) => button.y)).size, 2);
      const postureButton = buttons.find((button) => button.action === 'posture');
      if (postureButton) {
        assert.equal(postureButton.label, posture === 'seated' ? 'Seated' : 'Standing');
        const standing = questMenuButtons(page, 'standing').find(
          (button) => button.action === 'posture'
        );
        assert.deepEqual(
          [postureButton.x, postureButton.y, postureButton.width, postureButton.height],
          [standing.x, standing.y, standing.width, standing.height]
        );
      }
      for (const button of buttons) {
        seen.add(button.action);
        assert.ok(button.x >= 0 && button.y >= 0);
        assert.ok(button.x + button.width <= QUEST_MENU_TEXTURE.widthPx);
        assert.ok(button.y + button.height <= QUEST_MENU_TEXTURE.heightPx);
        const frame = questMenuButtonFrame(button);
        const alertFrame = questMenuButtonFrame(
          questMenuButtons(page, { posture, hasMessages: true }).find(
            (b) => b.action === button.action
          ),
          true
        );
        // Alert expansion keeps button world Y invariant when shifted by QUEST_MENU_ALERT_SHIFT_M.
        assert.ok(
          Math.abs(alertFrame.position[1] + QUEST_MENU_ALERT_SHIFT_M - frame.position[1]) < 1e-9
        );
        assert.ok(
          Math.abs(frame.position[0]) + frame.width / 2 <= QUEST_MENU_SIZE.widthM / 2 + 1e-9
        );
        assert.ok(
          Math.abs(frame.position[1]) + frame.height / 2 <= QUEST_MENU_SIZE.heightM / 2 + 1e-9
        );
        assert.equal(questMenuHit(page, frame.position[0], frame.position[1]), button.action);
        assert.equal(
          questMenuHit(page, frame.position[0], frame.position[1] + frame.height / 2 + 0.001),
          null
        );
      }
      for (let index = 0; index < buttons.length; index++) {
        for (let other = index + 1; other < buttons.length; other++) {
          assert.equal(rectanglesOverlap(buttons[index], buttons[other]), false);
        }
      }
    }
  }
  assert.deepEqual([...seen].sort(), [...QUEST_MENU_ACTIONS].sort());
  assert.equal(questMenuHit('menu', 0, 0), null);
  assert.equal(
    questMenuButtons('ring').some((button) => button.action === 'solo'),
    false
  );
  const ringButtons = questMenuButtons('ring');
  const gapM =
    ((ringButtons[1].x - (ringButtons[0].x + ringButtons[0].width)) / QUEST_MENU_TEXTURE.widthPx) *
    QUEST_MENU_SIZE.widthM;
  assert.ok(gapM > 0.06, `button gap ${gapM} m`);
  assert.ok(questMenuButtonFrame(ringButtons[0]).height >= 0.11);

  // Compact card without lines hugs buttons closely with no title or empty card body.
  for (const page of ['menu', 'ring']) {
    const compact = buildQuestMenu(page, [], { posture: 'standing' });
    assert.equal(compact.hasMessages, false);
    assert.equal(compact.widthPx, QUEST_MENU_TEXTURE.widthPx);
    assert.equal(compact.heightPx, QUEST_MENU_TEXTURE.heightPx);
    assert.equal(
      compact.ops.some((op) => op.op === 'image'),
      false,
      'compact card does not embed the floating title'
    );
  }

  const sampleTitles = {
    neo: 'assets_arena_ui_questlettering_neo',
    rock: 'assets_arena_ui_questlettering_rock',
    robots: 'assets_arena_ui_questlettering_robots',
  };
  const packed = Array.from({ length: 40 }, () => 'status '.repeat(30).trim());
  for (const page of ['menu', 'ring']) {
    for (const posture of ['standing', 'seated']) {
      const menu = buildQuestMenu(page, packed, { posture });
      assert.equal(menu.hasMessages, true);
      assert.equal(menu.heightPx, QUEST_MENU_ALERT_TEXTURE.heightPx);
      assert.ok(menu.ops.length >= 1 && menu.ops.length <= 64);
      const block = menu.ops.filter(
        (op) => op.op === 'text' && op.align === 'center' && op.size === 36
      );
      assert.equal(block.length, QUEST_MENU_TEXT_LINES_MAX);
      const divider = menu.ops.find((op) => op.op === 'roundRect' && op.color === '#334155');
      assert.ok(divider);
      for (const text of block) {
        assert.ok(text.y + text.size < divider.y);
      }
      for (const button of menu.buttons) {
        assert.ok(button.y > divider.y + divider.height);
        for (const text of block) {
          assert.equal(
            rectanglesOverlap(button, {
              x: text.x - text.maxWidth / 2,
              y: text.y,
              width: text.maxWidth,
              height: text.size,
            }),
            false
          );
        }
      }
    }
  }

  // Floating branded title has transparent surroundings (zero background roundRect) and fallback text.
  const imageTitle = buildQuestMenuTitle({ titles: sampleTitles });
  assert.equal(imageTitle.widthPx, QUEST_TITLE_TEXTURE.widthPx);
  assert.equal(imageTitle.heightPx, QUEST_TITLE_TEXTURE.heightPx);
  assert.equal(
    imageTitle.ops.some((op) => op.op === 'roundRect'),
    false,
    'floating title has no background card'
  );
  assert.deepEqual(
    imageTitle.ops.filter((op) => op.op === 'image').map((op) => op.uri),
    [sampleTitles.neo, sampleTitles.rock, sampleTitles.robots]
  );
  const textTitle = buildQuestMenuTitle();
  assert.equal(
    textTitle.ops.some((op) => op.op === 'image' || op.op === 'roundRect'),
    false
  );
  assert.deepEqual(
    textTitle.ops.map((op) => op.text),
    ['Neo', "Rock 'Em Sock 'Em", 'Robots']
  );

  const menu = buildQuestMenu('menu', ['Solo places both robots in the ring.']);
  assert.match(menu.specKey, /Solo/);
  assert.match(menu.specKey, /Exit/);
  assert.doesNotMatch(menu.specKey, /Recenter|Quest VR Menu|Solo Ring/);
  assert.match(menu.specKey, /Standing/);
  assert.match(menu.specKey, /#60a5fa/);
  assert.match(menu.specKey, /#d99a9a/);
  assert.match(menu.specKey, /#0f172a/);
  assert.deepEqual(menu.ops[0], {
    op: 'roundRect',
    x: 0,
    y: 0,
    width: QUEST_MENU_ALERT_TEXTURE.widthPx,
    height: QUEST_MENU_ALERT_TEXTURE.heightPx,
    radius: layout.QUEST_MENU_CARD_RADIUS_PX,
    color: '#0f172a',
  });
  assert.equal(
    menu.ops.some((op) => op.op === 'roundRect' && op.color === '#09090b'),
    false
  );
  assert.doesNotMatch(menu.specKey, /#0f766e|#991b1b|#101826/);

  const ring = buildQuestMenu('ring', ['Both robots are in the ring.']);
  assert.equal(ring.buttons.find((button) => button.action === 'ready').label, 'Ready');
  const set = buildQuestMenu('ring', ['Both robots are in the ring.'], {
    acknowledged: true,
    posture: 'seated',
  });
  assert.equal(set.buttons.find((button) => button.action === 'ready').label, 'Set');
  assert.equal(set.buttons.find((button) => button.action === 'posture').label, 'Seated');
  assert.equal(
    questMenuHit(
      'ring',
      questMenuButtonFrame(set.buttons[0], true).position[0],
      questMenuButtonFrame(set.buttons[0], true).position[1],
      { acknowledged: true, hasMessages: true }
    ),
    'ready'
  );
  const hovered = buildQuestMenu('menu', ['Solo places both robots in the ring.'], {
    hover: 'solo',
  });
  assert.notEqual(hovered.specKey, menu.specKey);
  const solo = menu.buttons.find((button) => button.action === 'solo');
  assert.match(hovered.specKey, new RegExp(`"x":${solo.x}`));
  assert.deepEqual(wrapMenuLine('one two three', 7), ['one two', 'three']);
});

const degrees = (radians) => (radians * 180) / Math.PI;

function panelView(pose, size = QUEST_MENU_SIZE) {
  const [x, y, z] = pose.position;
  const ahead = -z;
  return {
    distance: Math.hypot(x, y, z),
    elevation: degrees(Math.atan2(y, Math.hypot(x, z))),
    width: degrees(2 * Math.atan(size.widthM / 2 / ahead)),
    top: degrees(Math.atan2(y + size.heightM / 2, ahead)),
    bottom: degrees(Math.atan2(y - size.heightM / 2, ahead)),
  };
}

test('both menu pages sit at a readable distance and angle', () => {
  for (const page of ['menu', 'ring']) {
    const pose = QUEST_MENU_POSE[page];
    assert.deepEqual(pose.rotation, [0, 0, 0]);
    assert.ok(pose.position[2] < 0, `${page} must be in front`);
    const view = panelView(pose);
    assert.ok(view.distance >= 1.45 && view.distance <= 1.7, `${page} distance ${view.distance}`);
    assert.ok(view.width >= 30 && view.width <= 45, `${page} width ${view.width}`);
    // Button label text (54 px on 1216 px = ~0.042 m) stays > 1.4 degrees tall.
    const labelM = (54 / QUEST_MENU_TEXTURE.widthPx) * QUEST_MENU_SIZE.widthM;
    assert.ok(degrees(labelM / view.distance) >= 1.4, `${page} button text too small`);

    const titleView = panelView(QUEST_TITLE_POSE[page], QUEST_TITLE_SIZE[page]);
    assert.ok(
      titleView.bottom > view.top + (page === 'menu' ? 0.2 : 0),
      `${page} title clears card`
    );
    assert.ok(titleView.top < 25, `${page} title clears 29.3-deg sky diagnostics`);
  }
  const menu = panelView(QUEST_MENU_POSE.menu);
  assert.ok(menu.elevation <= -4 && menu.elevation >= -10, `menu elevation ${menu.elevation}`);
  assert.ok(Math.abs(menu.distance - 1.51) < 0.02);
  const ring = panelView(QUEST_MENU_POSE.ring);
  assert.ok(ring.elevation <= -28 && ring.elevation >= -33, `ring elevation ${ring.elevation}`);
  assert.ok(ring.distance > 1.5, 'ring page must be farther than the old 0.93 m');
  assert.ok(ring.top < -20, `ring top edge ${ring.top}`);
});

test('the upright ring panel keeps the opponent head and torso in view', () => {
  const pose = QUEST_MENU_POSE.ring;
  assert.deepEqual(pose.rotation, [0, 0, 0]);

  const glb = fs.readFileSync(
    path.join(__dirname, '../assets/arena/Mike_Player2_RedOrange_Combat_AR.glb')
  );
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  for (const node of json.nodes) {
    if (node.mesh === undefined) continue;
    assert.equal(node.translation, undefined);
    assert.equal(node.rotation, undefined);
    assert.equal(node.scale, undefined);
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of json.meshes) {
    for (const primitive of mesh.primitives) {
      const accessor = json.accessors[primitive.attributes.POSITION];
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], accessor.min[axis]);
        max[axis] = Math.max(max[axis], accessor.max[axis]);
      }
    }
  }

  const scale = ARENA_LAYOUT.fighterScale;
  const fighterY = ARENA_LAYOUT.floorHeight + ARENA_LAYOUT.footOffset;
  const eyeModel = [0, 1.1271, 0.2028];
  const rotateY = (yaw, point) => {
    const radians = (yaw * Math.PI) / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    return [point[0] * cosine + point[2] * sine, point[1], -point[0] * sine + point[2] * cosine];
  };
  const ringLocal = (anchor, point) => {
    const placed = rotateY(
      anchor.yaw,
      point.map((value) => value * scale)
    );
    return [anchor.x + placed[0], fighterY + placed[1], anchor.z + placed[2]];
  };
  const blue = { x: -ARENA_RULES.spawn, z: 0, yaw: 90 };
  const red = { x: ARENA_RULES.spawn, z: 0, yaw: -90 };
  const eye = ringLocal(blue, eyeModel);
  const world = (point) =>
    rotateY(
      90,
      point.map((value, index) => (value - eye[index]) * 16)
    );
  assert.ok(world(eye).every((value) => Math.abs(value) < 1e-9));

  const halfWidth = QUEST_MENU_SIZE.widthM / 2;
  const halfHeight = QUEST_MENU_SIZE.heightM / 2;
  const hidden = (point) => {
    assert.ok(point[2] < pose.position[2]);
    const t = pose.position[2] / point[2];
    assert.ok(t > 0 && t < 1);
    const hitX = t * point[0] - pose.position[0];
    const hitY = t * point[1] - pose.position[1];
    return Math.abs(hitX) <= halfWidth && Math.abs(hitY) <= halfHeight;
  };
  // Top corners (head and raised arms) and the bounding-box center stay clear.
  for (const x of [min[0], max[0]]) {
    for (const z of [min[2], max[2]]) {
      assert.equal(hidden(world(ringLocal(red, [x, max[1], z]))), false);
    }
  }
  const midY = (min[1] + max[1]) / 2;
  assert.equal(hidden(world(ringLocal(red, [0, midY, 0]))), false);
  // Walk up the opponent's centerline at its near, middle and far depth. Only
  // the lower legs (under ~0.65 m of the 1.92 m robot in VR) may be hidden.
  for (const z of [min[2], 0, max[2]]) {
    const floorVR = world(ringLocal(red, [0, 0, z]))[1];
    let lowestVisible = null;
    for (let y = max[1]; y >= min[1]; y -= 0.002) {
      const point = world(ringLocal(red, [0, y, z]));
      if (hidden(point)) break;
      lowestVisible = point[1] - floorVR;
    }
    assert.ok(lowestVisible !== null && lowestVisible < 0.7, `z ${z}: lowest ${lowestVisible}`);
  }
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

test('Ready starts the virtual Quest match once assets load without asserting AR tracking', () => {
  const clock = fakeClock();
  const session = createQuestArenaSession(clock);
  assert.equal(session.ready().reason, 'no-match');
  const sessionSource = source('src/features/quest-vr/quest-arena-session.ts');
  assert.doesNotMatch(sessionSource, /setTracking|setPlacement/);

  assert.equal(session.solo(), true);
  // Queue Ready before assets finish loading; loading completes into countdown automatically.
  const queued = session.ready();
  assert.equal(queued.called, false);
  assert.equal(queued.started, false);
  assert.equal(queued.reason, 'loading');
  assert.equal(session.getSnapshot().acknowledged, true);

  const open = session.getSnapshot();
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'arena');
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'blue');
  session.assetLoaded(open.lease, open.token, open.placementVersion, 'red');

  const started = session.getSnapshot();
  assert.equal(started.assetsLoaded, 3);
  assert.equal(started.virtualReady, true);
  assert.equal(started.tracking, false);
  assert.equal(started.placed, false);
  assert.equal(started.stage, 'countdown');
  assert.equal(started.lastReady?.reason, 'started');
  session.dispose();
});

test('solo keeps ArenaMatch virtually ready without AR tracking and cleans up leases', () => {
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
  assert.equal(opened.virtualReady, true);
  assert.equal(opened.tracking, false);
  assert.equal(opened.placed, false);
  assert.equal(opened.landscape, true);
  assert.equal(opened.canReady, false);
  assert.equal(opened.localReady, false);
  assert.equal(opened.acknowledged, false);
  assert.match(opened.lines.join('\n'), /Both robots are in the ring/);

  const staleLease = opened.lease;
  session.assetLoaded(staleLease, opened.token, opened.placementVersion, 'arena');
  session.assetLoaded(staleLease, opened.token, opened.placementVersion, 'blue');
  session.assetLoaded(staleLease, opened.token, opened.placementVersion, 'red');
  assert.equal(session.getSnapshot().assetsLoaded, 3);
  assert.equal(session.getSnapshot().canReady, true);
  assert.equal(session.getSnapshot().tracking, false);
  assert.equal(session.getSnapshot().placed, false);
  assert.equal(session.getSnapshot().stage, 'lobby');
  assert.equal(clock.pending.size, 0);

  const result = session.ready();
  const afterReady = session.getSnapshot();
  assert.equal(result.called, true);
  assert.equal(result.started, true);
  assert.equal(result.reason, 'started');
  assert.equal(afterReady.stage, 'countdown');
  assert.equal(afterReady.virtualReady, true);
  assert.equal(afterReady.acknowledged, true);
  assert.equal(afterReady.tracking, false);
  assert.equal(afterReady.placed, false);

  assert.equal(session.back(), 'menu');
  assert.equal(session.getSnapshot().mode, null);
  assert.equal(session.getSnapshot().page, 'menu');
  assert.equal(session.getSnapshot().acknowledged, false);
  session.assetLoaded(staleLease, opened.token, opened.placementVersion, 'arena');
  assert.equal(session.solo(), true);
  const reopened = session.getSnapshot();
  assert.notEqual(reopened.lease, staleLease);
  assert.equal(reopened.assetsLoaded, 0);
  session.assetLoaded(staleLease, opened.token, opened.placementVersion, 'arena');
  assert.equal(session.getSnapshot().assetsLoaded, 0);
  session.exit();
  assert.equal(session.getSnapshot().mode, null);
  assert.equal(session.getSnapshot().leaving, true);
  assert.deepEqual(session.getSnapshot().lines, [QUEST_LEAVING]);
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
    'modules/quest-panel/native/src/main/java/expo/modules/questpanel/QuestPanelModule.kt'
  );
  assert.match(scene, /Fight_Arena\.glb/);
  assert.match(scene, /Mike_Player1_Blue_Combat_AR\.glb/);
  assert.match(scene, /Mike_Player2_RedOrange_Combat_AR\.glb/);
  assert.match(scene, /ARENA_LAYOUT/);
  assert.match(scene, /questMenuHit/);
  assert.match(scene, /questMenuButtonFrame\(/);
  assert.match(scene, /questPanelNative/);
  assert.match(scene, /questTriggerPress/);
  assert.match(scene, /questPointerHover/);
  assert.match(scene, /onClickState/);
  assert.match(scene, /createQuestMenuCompositor/);
  assert.match(scene, /questMenuLayerMask/);
  assert.doesNotMatch(scene, /menu-background\.png/);
  assert.match(scene, /quest-lettering\/neo\.png/);
  assert.match(scene, /quest-lettering\/rock\.png/);
  assert.match(scene, /quest-lettering\/robots\.png/);
  assert.match(scene, /ArenaNotoSans\.ttf/);
  assert.match(scene, /ArenaNotoSansSemibold\.ttf/);
  assert.match(scene, /resolveQuestMenuAssetFile/);
  assert.doesNotMatch(source('src/features/quest-vr/quest-menu-layout.ts'), /menu-background/);
  assert.match(scene, /session\.exit\(\)/);
  assert.match(scene, /questPanelNative\?\.exitApp\?\.\(\)/);
  assert.doesNotMatch(scene, /exitVRScene\(\)/);
  assert.doesNotMatch(scene, /onClick=\{/);
  assert.doesNotMatch(scene, /exitRequest !== null/);
  assert.doesNotMatch(scene, /ViroARScene|ViroXRSceneNavigator|setTracking|setPlacement/);
  assert.match(scene, /ViroGameLoop/);
  assert.match(scene, /ViroGameLoopUtils/);
  assert.match(navigator, /passthroughEnabled=\{false\}/);
  assert.doesNotMatch(navigator, /hdrEnabled=\{false\}/);
  assert.match(navigator, /\bhdrEnabled\b/);
  assert.match(navigator, /bloomEnabled=\{false\}/);
  assert.match(navigator, /quest-arena-scene\.native/);
  assert.equal(
    fs.existsSync(path.join(__dirname, '../src/features/quest-vr/quest-smoke-scene.native.tsx')),
    false
  );
  assert.match(moduleSource, /"image"/);
  assert.match(moduleSource, /BitmapFactory\.decodeFile/);
  assert.match(moduleSource, /FILTER_BITMAP_FLAG/);
  assert.match(moduleSource, /Typeface\.createFromFile/);
  assert.match(moduleSource, /drawExecutor/);
  assert.match(moduleSource, /android_res/);
  // The module draws pixels only. The patched renderer owns the XR layer, and
  // nothing registers Viro materials any more.
  assert.match(moduleSource, /System\.loadLibrary\("viro_renderer"\)/);
  assert.match(moduleSource, /external fun nativeDraw/);
  assert.match(moduleSource, /external fun nativeRefSpaceEpoch/);
  assert.doesNotMatch(moduleSource, /XrSession|xrCreate|VRTMaterialManager|setJSMaterials/);
  assert.equal(fs.existsSync(path.join(__dirname, '../modules/quest-menu-texture')), false);
  // The renderer plugin already wires the patched AAR; no extra compositor plugin.
  assert.doesNotMatch(source('app.config.ts'), /QUEST_COMPOSITOR|quest-compositor/);
});
