const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ARENA_LAYOUT } = require('../src/features/arena-fighter/arena-controller.ts');
const {
  QUEST_WORLD_SCALE,
  ROBOT_EYE_MODEL,
  DEFAULT_CALIBRATION,
} = require('../src/features/quest-vr/quest-head-rig.ts');
const { viroEulerDegrees } = require('../src/features/quest-vr/quest-input.ts');
const {
  QUEST_FIRST_PERSON_ARM_SCALE,
  placeQuestFirstPersonArms,
} = require('../src/features/quest-vr/quest-first-person-arms.ts');

const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function near(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function hand(handName, position, overrides = {}) {
  return {
    hand: handName,
    tracking: 'tracked',
    position,
    orientation: [0, 0, 0, 1],
    ...overrides,
  };
}

function sample(overrides = {}) {
  return {
    refEpoch: 4,
    focused: true,
    actionsReady: true,
    left: hand('left', [-0.31, 1.05, -0.42]),
    right: hand('right', [0.28, 1.02, -0.4], {
      orientation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    }),
    ...overrides,
  };
}

test('scene-root hands use fighterScale times 16 once and do not scale the aim position', () => {
  assert.equal(QUEST_WORLD_SCALE, 16);
  assert.equal(QUEST_FIRST_PERSON_ARM_SCALE, ARENA_LAYOUT.fighterScale * 16);
  assert.equal(QUEST_FIRST_PERSON_ARM_SCALE, ARENA_LAYOUT.fighterScale * QUEST_WORLD_SCALE);
  assert.notEqual(QUEST_FIRST_PERSON_ARM_SCALE, ARENA_LAYOUT.fighterScale * 16 * 16);

  const frame = placeQuestFirstPersonArms({ sample: sample(), headRefEpoch: 4 });
  assert.equal(frame.left.scale, QUEST_FIRST_PERSON_ARM_SCALE);
  assert.equal(frame.right.scale, QUEST_FIRST_PERSON_ARM_SCALE);
  assert.deepEqual(frame.left.position, [-0.31, 1.05, -0.42]);
  assert.deepEqual(frame.right.position, [0.28, 1.02, -0.4]);
  assert.notDeepEqual(
    frame.left.position,
    [-0.31, 1.05, -0.42].map((value) => value * QUEST_FIRST_PERSON_ARM_SCALE)
  );
});

test('each controller keeps its own hand and its own aim rotation', () => {
  const frame = placeQuestFirstPersonArms({ sample: sample(), headRefEpoch: 4 });
  assert.equal(frame.left.visible, true);
  assert.equal(frame.right.visible, true);
  assert.equal(frame.left.hand, 'left');
  assert.equal(frame.right.hand, 'right');
  assert.ok(frame.left.position[0] < 0);
  assert.ok(frame.right.position[0] > 0);
  assert.deepEqual(frame.left.rotation, [0, 0, 0]);
  const expectedYaw = viroEulerDegrees([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  assert.deepEqual(frame.right.rotation, expectedYaw);
  near(frame.right.rotation[1], 90);

  const swappedSigns = sample({
    left: hand('left', [0.44, 0.9, -0.2]),
    right: hand('right', [-0.18, 0.9, -0.2]),
  });
  const kept = placeQuestFirstPersonArms({ sample: swappedSigns, headRefEpoch: 4 });
  assert.deepEqual(kept.left.position, [0.44, 0.9, -0.2]);
  assert.deepEqual(kept.right.position, [-0.18, 0.9, -0.2]);

  const mislabeled = sample({
    left: hand('right', [-0.31, 1.05, -0.42]),
  });
  const rejected = placeQuestFirstPersonArms({ sample: mislabeled, headRefEpoch: 4 });
  assert.equal(rejected.left.visible, false);
  assert.equal(rejected.left.reason, 'hand-mismatch');
  assert.equal(rejected.left.position, null);
  assert.equal(rejected.right.visible, true);
  assert.equal(rejected.right.hand, 'right');
});

test('non-finite and non-unit aim poses hide that hand only', () => {
  const nanPosition = placeQuestFirstPersonArms({
    sample: sample({ left: hand('left', [Number.NaN, 1, -0.2]) }),
    headRefEpoch: 4,
  });
  assert.equal(nanPosition.left.visible, false);
  assert.equal(nanPosition.left.reason, 'invalid-aim-pose');
  assert.equal(nanPosition.left.position, null);
  assert.equal(nanPosition.left.scale, QUEST_FIRST_PERSON_ARM_SCALE);
  assert.equal(nanPosition.right.visible, true);

  const infiniteOrientation = placeQuestFirstPersonArms({
    sample: sample({
      right: hand('right', [0.2, 1, -0.2], { orientation: [0, 0, Number.POSITIVE_INFINITY, 1] }),
    }),
    headRefEpoch: 4,
  });
  assert.equal(infiniteOrientation.right.visible, false);
  assert.equal(infiniteOrientation.right.reason, 'invalid-aim-pose');
  assert.equal(infiniteOrientation.left.visible, true);

  const zeroQuaternion = placeQuestFirstPersonArms({
    sample: sample({
      left: hand('left', [-0.2, 1, -0.2], { orientation: [0, 0, 0, 0] }),
    }),
    headRefEpoch: 4,
  });
  assert.equal(zeroQuaternion.left.reason, 'invalid-aim-pose');
  assert.equal(zeroQuaternion.right.visible, true);

  const missingPose = placeQuestFirstPersonArms({
    sample: sample({ left: hand('left', [-0.2, 1, -0.2], { position: null, orientation: null }) }),
    headRefEpoch: 4,
  });
  assert.equal(missingPose.left.reason, 'invalid-aim-pose');
});

test('a refEpoch mismatch hides both hands and drops their aim positions', () => {
  const matched = placeQuestFirstPersonArms({ sample: sample({ refEpoch: 7 }), headRefEpoch: 7 });
  assert.equal(matched.left.visible, true);
  assert.equal(matched.right.visible, true);

  const mismatched = placeQuestFirstPersonArms({
    sample: sample({ refEpoch: 8 }),
    headRefEpoch: 7,
  });
  assert.equal(mismatched.left.visible, false);
  assert.equal(mismatched.right.visible, false);
  assert.equal(mismatched.left.reason, 'ref-epoch-mismatch');
  assert.equal(mismatched.right.reason, 'ref-epoch-mismatch');
  assert.equal(mismatched.left.position, null);
  assert.equal(mismatched.right.position, null);
  assert.equal(mismatched.combatCommand, null);

  const noHeadEpoch = placeQuestFirstPersonArms({ sample: sample({ refEpoch: 8 }) });
  assert.equal(noHeadEpoch.left.visible, true);
  const nullHeadEpoch = placeQuestFirstPersonArms({
    sample: sample({ refEpoch: 8 }),
    headRefEpoch: null,
  });
  assert.equal(nullHeadEpoch.right.visible, true);
});

test('tracking loss hides the lost hand and leaves an inferred pose visible', () => {
  const lost = placeQuestFirstPersonArms({
    sample: sample({
      left: hand('left', [-0.31, 1.05, -0.42], { tracking: 'lost' }),
    }),
    headRefEpoch: 4,
  });
  assert.equal(lost.left.visible, false);
  assert.equal(lost.left.reason, 'tracking-lost');
  assert.equal(lost.left.position, null);
  assert.equal(lost.right.visible, true);
  assert.deepEqual(lost.right.position, [0.28, 1.02, -0.4]);

  const inferred = placeQuestFirstPersonArms({
    sample: sample({
      right: hand('right', [0.28, 1.02, -0.4], { tracking: 'inferred' }),
    }),
    headRefEpoch: 4,
  });
  assert.equal(inferred.right.visible, true);
  assert.equal(inferred.right.reason, null);
  assert.deepEqual(inferred.right.position, [0.28, 1.02, -0.4]);
  assert.equal(inferred.left.visible, true);
});

test('placement emits no combat command and the phone scene does not load derivatives', () => {
  const frame = placeQuestFirstPersonArms({ sample: sample(), headRefEpoch: 4 });
  assert.equal(frame.combatCommand, null);
  assert.deepEqual(Object.keys(frame).sort(), ['combatCommand', 'left', 'right']);
  for (const side of [frame.left, frame.right]) {
    assert.equal(side.visible, true);
    assert.equal('command' in side, false);
    assert.equal('punch' in side, false);
    assert.equal('block' in side, false);
    assert.equal('damage' in side, false);
  }

  const missing = placeQuestFirstPersonArms({ sample: null, headRefEpoch: 4 });
  assert.equal(missing.combatCommand, null);
  assert.equal(missing.left.reason, 'missing-sample');
  assert.equal(missing.right.reason, 'missing-sample');

  const arms = source('src/features/quest-vr/quest-first-person-arms.ts');
  const scene = source('src/features/quest-vr/quest-arena-scene.native.tsx');
  const phone = source('src/features/arena-fighter/arena-scene.native.tsx');
  assert.match(arms, /combatCommand: null/);
  assert.doesNotMatch(
    arms,
    /quest-arena-scene|arena-combat-motion|arena-match|setNativeProps|viroTag/
  );
  assert.doesNotMatch(arms, /punch\(|block\(|damage\(/);
  assert.match(scene, /placeQuestFirstPersonArms/);
  assert.match(scene, /QUEST_FIRST_PERSON_ARM_SCALE/);
  assert.match(phone, /Mike_Player1_Blue_Combat_AR\.glb/);
  assert.doesNotMatch(phone, /quest-blue-body|quest-blue-hand|assets\/arena\/quest/);
  const hands = scene.slice(
    scene.indexOf('function QuestPreviewHands'),
    scene.indexOf('function StanceFloorRing')
  );
  assert.doesNotMatch(hands, /squeeze/);
  assert.match(hands, /setHandsEnabled/);
  assert.match(hands, /quest-left-fist/);
  assert.match(hands, /quest-right-fist/);
  assert.equal(hands.includes('combatCommand'), false);
});

test('original Combat GLB bytes are unchanged', () => {
  const manifest = require('../assets/arena/combat-animation-manifest.json');
  for (const file of ['Mike_Player1_Blue_Combat_AR.glb', 'Mike_Player2_RedOrange_Combat_AR.glb']) {
    const meta = manifest.files.find((entry) => entry.file === file);
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'assets', 'arena', file));
    assert.equal(bytes.length, meta.bytes, file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), meta.sha256, file);
  }
});

test('the extract script regenerates the Quest body and hands', () => {
  const reportPath = path.join(
    __dirname,
    '..',
    'assets',
    'arena',
    'quest',
    'quest-first-person-extract.json'
  );
  const kept = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(kept.originalsUnchanged, true);
  assert.ok(kept.body.bounds.max[1] < 1.02);
  assert.ok(
    kept.body.bounds.min[2] < ROBOT_EYE_MODEL[2] && kept.body.bounds.max[2] > ROBOT_EYE_MODEL[2],
    'body straddles ROBOT_EYE_MODEL z so looking down sees chest and feet'
  );
  assert.ok(kept.arms.left.aimOffsetToFist[2] < -0.01);
  assert.ok(kept.arms.right.aimOffsetToFist[2] < -0.01);
  assert.deepEqual(kept.arms.aimAxis, [0, 0, -1]);
  assert.ok(kept.caps.body > 0);
  assert.ok(kept.caps.leftUpper > 0 && kept.caps.rightUpper > 0);
  assert.ok(kept.caps.leftForearm > 0 && kept.caps.rightForearm > 0);
  assert.ok(kept.caps.leftFist > 0 && kept.caps.rightFist > 0);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'quest05b-extract-'));
  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/quest-first-person-extract.cjs', '--out', out],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000 }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const file of [
      'quest-blue-body.glb',
      'quest-blue-upper-left.glb',
      'quest-blue-upper-right.glb',
      'quest-blue-forearm-left.glb',
      'quest-blue-forearm-right.glb',
      'quest-blue-hand-left.glb',
      'quest-blue-hand-right.glb',
    ]) {
      const existing = fs.readFileSync(
        path.join(__dirname, '..', 'assets', 'arena', 'quest', file)
      );
      const fresh = fs.readFileSync(path.join(out, file));
      assert.equal(
        createHash('sha256').update(existing).digest('hex'),
        createHash('sha256').update(fresh).digest('hex'),
        file
      );
      // Verify outward triangle winding via positive signed mesh volume.
      const jLen = existing.readUInt32LE(12);
      const gltf = JSON.parse(existing.subarray(20, 20 + jLen).toString('utf8'));
      const bin = existing.subarray(28 + jLen);
      let volume6 = 0;
      for (const prim of gltf.meshes[0].primitives) {
        const posAcc = gltf.accessors[prim.attributes.POSITION];
        const idxAcc = gltf.accessors[prim.indices];
        const bv = gltf.bufferViews[posAcc.bufferView];
        const ibv = gltf.bufferViews[idxAcc.bufferView];
        const pts = [];
        for (let i = 0; i < posAcc.count; i += 1) {
          const o = (bv.byteOffset || 0) + (posAcc.byteOffset || 0) + i * 12;
          pts.push([bin.readFloatLE(o), bin.readFloatLE(o + 4), bin.readFloatLE(o + 8)]);
        }
        for (let i = 0; i < idxAcc.count; i += 3) {
          const io = (ibv.byteOffset || 0) + (idxAcc.byteOffset || 0) + i * 2;
          const a = pts[bin.readUInt16LE(io)];
          const b = pts[bin.readUInt16LE(io + 2)];
          const c = pts[bin.readUInt16LE(io + 4)];
          volume6 +=
            a[0] * (b[1] * c[2] - b[2] * c[1]) -
            a[1] * (b[0] * c[2] - b[2] * c[0]) +
            a[2] * (b[0] * c[1] - b[1] * c[0]);
        }
      }
      assert.ok(volume6 > 0, `${file} signed volume6=${volume6}`);
      assert.equal(gltf.materials[0].alphaMode, 'OPAQUE', `${file} opaque material`);
    }
    const freshReport = JSON.parse(
      fs.readFileSync(path.join(out, 'quest-first-person-extract.json'), 'utf8')
    );
    assert.deepEqual(freshReport, kept);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('connected cosmetic arms solve elbow bends upright and hide beyond stretch cap', () => {
  const body = { calibration: { ...DEFAULT_CALIBRATION, origin: [0, 1.4, 0] }, lift: 0 };
  const frame = placeQuestFirstPersonArms({
    sample: sample({
      left: hand('left', [-0.22, 1.12, -0.35]),
      right: hand('right', [0.22, 1.12, -0.35], {
        orientation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      }),
    }),
    headRefEpoch: 4,
    body,
  });
  for (const side of ['left', 'right']) {
    const arm = frame[side];
    assert.equal(arm.visible, true);
    assert.ok(arm.upper && arm.forearm, `${side} should have upper and forearm`);
    // Dorsal +Y of upper and forearm stays upright (positive world Y when wrist is upright).
    const rotY = ([rx, ry, rz]) => {
      const toRad = Math.PI / 180;
      const cx = Math.cos(rx * toRad);
      const sx = Math.sin(rx * toRad);
      const cy = Math.cos(ry * toRad);
      const sy = Math.sin(ry * toRad);
      const cz = Math.cos(rz * toRad);
      const sz = Math.sin(rz * toRad);
      // Apply R_y * R_x * R_z to [0, 1, 0]:
      const x1 = -sz;
      const y1 = cz;
      const z1 = 0;
      const y2 = y1 * cx - z1 * sx;
      const z2 = y1 * sx + z1 * cx;
      return [x1 * cy + z2 * sy, y2, -x1 * sy + z2 * cy];
    };
    assert.ok(rotY(arm.upper.rotation)[1] > 0.2, `${side} upper dorsal +Y points up`);
    assert.ok(rotY(arm.forearm.rotation)[1] > 0.2, `${side} forearm dorsal +Y points up`);
  }
  const far = placeQuestFirstPersonArms({
    sample: sample({ left: hand('left', [-2, 1, -2]) }),
    headRefEpoch: 4,
    body,
  });
  // Neon #4 fix: exceeding arm stretch cap keeps the tracked fist visible and hides only arm segments.
  assert.equal(far.left.visible, true);
  assert.equal(far.left.reason, null);
  assert.deepEqual(far.left.position, [-2, 1, -2]);
  assert.equal(far.left.upper, null);
  assert.equal(far.left.forearm, null);
});

test('the Quest scene mounts the headless body without hiding the original load', () => {
  const scene = source('src/features/quest-vr/quest-arena-scene.native.tsx');
  assert.match(scene, /source=\{sources\[id\]\}/);
  assert.match(scene, /animation=\{idleAnimation\}/);
  assert.match(
    scene,
    /onLoadEnd=\{\(\) => session\.assetLoaded\(lease, token, placementVersion, id\)\}/
  );
  assert.match(scene, /visible=\{visible\}/);
  assert.match(scene, /const nodeVisible = id === 'blue' \? true : visible/);
  assert.match(
    scene,
    /viroTag=\{viroTag\}[\s\S]*visible=\{visible\}[\s\S]*previewSources\.body[\s\S]*visible=\{bodyVisible\}/
  );
  assert.match(scene, /showOriginal=\{view\.presentation !== 'eyes'\}/);
  assert.match(scene, /showBody=\{view\.presentation === 'eyes'\}/);
  assert.match(scene, /scale=\{fighterScale\}/);
  assert.match(scene, /scale=\{previewHandScale\}/);
  const ring = scene.slice(
    scene.indexOf('function QuestRing'),
    scene.indexOf('function QuestMenuFallbackButtons')
  );
  assert.equal(ring.includes('QuestPreviewHands'), false);
  assert.equal(ring.includes('previewSources.hand'), false);
  const handsFn = scene.slice(
    scene.indexOf('function QuestPreviewHands'),
    scene.indexOf('function QuestIntroCover')
  );
  assert.match(handsFn, /pushNodeTransform/);
  assert.match(handsFn, /requestAnimationFrame/);
  const mount = scene.slice(scene.indexOf('const handsActive'));
  assert.match(
    mount,
    /<QuestPreviewHands\s+source=\{input\}\s+session=\{session\}\s+active=\{handsActive\}\s*\/>/
  );
});
