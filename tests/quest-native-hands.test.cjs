const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  controllerFistPose,
  rotateControllerVector,
  QUEST_HAND_MESH_TO_GRIP,
  QUEST_HAND_PALM_CENTER_MODEL,
  QUEST_FIRST_PERSON_ARM_SCALE,
  placeQuestFirstPersonArms,
} = require('../src/features/quest-vr/quest-first-person-arms.ts');
const { decodeBatch } = require('../src/features/quest-vr/quest-input.ts');
const { createQuestInputSource } = require('../src/features/quest-vr/quest-input-source.ts');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const vectorNear = (a, b) => a.forEach((v, i) => near(v, b[i]));

test('left and right grip calibration follow the physical thumb and palm under pitch, roll, yaw', () => {
  const s = Math.SQRT1_2;
  for (const hand of ['left', 'right']) {
    const thumb = hand === 'left' ? [1, 0, 0] : [-1, 0, 0];
    vectorNear(rotateControllerVector(QUEST_HAND_MESH_TO_GRIP[hand], thumb), [0, 0, -1]);
    vectorNear(rotateControllerVector(QUEST_HAND_MESH_TO_GRIP[hand], [0, 0, -1]), [0, -1, 0]);
    for (const q of [
      [0, 0, 0, 1],
      [s, 0, 0, s],
      [0, s, 0, s],
      [0, 0, s, s],
      [0.5, 0.5, 0.5, 0.5],
    ]) {
      const grip = [-0.2, 1.2, -0.4];
      const pose = controllerFistPose(hand, grip, q);
      assert.ok(pose);
      vectorNear(
        rotateControllerVector(pose.orientation, thumb),
        rotateControllerVector(q, [0, 0, -1])
      );
      const palm = rotateControllerVector(
        pose.orientation,
        QUEST_HAND_PALM_CENTER_MODEL[hand].map((n) => n * QUEST_FIRST_PERSON_ARM_SCALE)
      );
      vectorNear(
        pose.position.map((n, i) => n + palm[i]),
        grip
      );
      const x = rotateControllerVector(pose.orientation, [1, 0, 0]);
      const y = rotateControllerVector(pose.orientation, [0, 1, 0]);
      const z = rotateControllerVector(pose.orientation, [0, 0, 1]);
      near(
        x[0] * (y[1] * z[2] - y[2] * z[1]) -
          x[1] * (y[0] * z[2] - y[2] * z[0]) +
          x[2] * (y[0] * z[1] - y[1] * z[0]),
        1
      );
    }
    const punchingHold = controllerFistPose(hand, [0, 0, 0], [s, 0, 0, s]);
    vectorNear(rotateControllerVector(punchingHold.orientation, thumb), [0, 1, 0]);
    vectorNear(rotateControllerVector(punchingHold.orientation, [0, 0, -1]), [0, 0, -1]);
  }
});

test('grip extension joins the same timestamped samples without changing v1 aim or squeeze', () => {
  const ints = [0, 5, 1, 2, 7, 0, 15, 3, 127, 0, 0, 15, 3, 127, 0];
  const aim = [1, 2, 3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0.4, 0.6, 0.1, 0.2];
  const batch = {
    available: true,
    version: 1,
    generation: 2,
    live: true,
    count: 1,
    seq: [41],
    capturedNs: [123],
    displayTimeNs: [456],
    nowNs: 999,
    ints,
    floats: [...aim, ...aim],
    gripVersion: 1,
    gripInts: [0, 15, 3, 1, -12, 0, 0, 0],
    gripFloats: [-0.2, 1.1, -0.3, 0, 0, 0, 1, 1, 2, 3, 4, 5, 6, ...new Array(13).fill(0)],
  };
  const frame = decodeBatch(batch).samples[0];
  assert.equal(frame.seq, 41);
  assert.equal(frame.capturedNs, 123);
  assert.equal(frame.displayTimeNs, 456);
  assert.deepEqual(frame.left.position, [1, 2, 3]);
  assert.equal(frame.left.squeeze.value, 0.6);
  assert.deepEqual(frame.left.grip.position, [-0.2, 1.1, -0.3]);
  assert.deepEqual(frame.left.grip.linearVelocity, [1, 2, 3]);
  assert.equal(frame.right.grip.tracking, 'lost');
  const legacy = decodeBatch({ ...batch, gripVersion: undefined }).samples[0];
  assert.equal(legacy.left.grip, undefined);
  assert.deepEqual(legacy.left.position, frame.left.position);
  const malformed = decodeBatch({ ...batch, gripFloats: [NaN] }).samples[0];
  assert.equal(malformed.left.grip, undefined, 'bad extension cannot corrupt reusable aim samples');
});

test('runtime grip visuals reject stale/invalid poses, preserve valid fist beyond reach, and emit no combat', () => {
  const grip = { position: [-2, 1, -2], orientation: [0, 0, 0, 1], tracking: 'tracked' };
  const sample = {
    seq: 1,
    capturedNs: 1_000_000,
    refEpoch: 3,
    focused: true,
    actionsReady: true,
    left: {
      hand: 'left',
      tracking: 'tracked',
      position: [99, 99, 99],
      orientation: [0, 0, 0, 1],
      grip,
    },
    right: null,
  };
  const args = {
    sample,
    headRefEpoch: 3,
    poseSource: 'grip',
    nowNs: 20_000_000,
    body: { calibration: { origin: [0, 1.4, 0], yaw: 180 }, lift: 0 },
  };
  const result = placeQuestFirstPersonArms(args);
  assert.equal(result.left.visible, true);
  assert.equal(result.left.upper, null);
  assert.equal(result.left.forearm, null);
  assert.equal(result.combatCommand, null);
  assert.ok(Math.abs(result.left.position[0] - grip.position[0]) < 0.02);
  assert.equal(placeQuestFirstPersonArms({ ...args, nowNs: 51_000_001 }).left.reason, 'stale-pose');
  assert.equal(placeQuestFirstPersonArms({ ...args, nowNs: 999_999 }).left.reason, 'stale-pose');
  assert.equal(placeQuestFirstPersonArms({ ...args, headRefEpoch: 4 }).left.visible, false);
  assert.equal(
    placeQuestFirstPersonArms({
      ...args,
      sample: { ...sample, left: { ...sample.left, grip: null } },
    }).left.visible,
    false
  );
  assert.equal(
    placeQuestFirstPersonArms({
      ...args,
      sample: { ...sample, left: { ...sample.left, grip: { ...grip, tracking: 'lost' } } },
    }).left.visible,
    false
  );
  assert.equal(controllerFistPose('left', [0, 0, 0], [0, 0, 0, 0]), null);
  assert.equal(controllerFistPose('right', [NaN, 0, 0], [0, 0, 0, 1]), null);
});

test('the actual portable C++ math preserves wrist endpoints, handedness, freshness, and reach fallback', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-native-hands-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const header = path
    .join(root, 'tools/quest/viro-renderer/quest-hands-math.h')
    .replaceAll('\\', '/');
  const visibility = read('tools/quest/viro-renderer/quest-hands-renderer.h')
    .split('inline void setSubtreeHidden')[1]
    .split('inline void set(')[0];
  const code = `#include "${header}"
#include <cassert>
#include <initializer_list>
#include <memory>
#include <vector>
struct VRONode {
  bool hidden=false; float opacity=1; int geometryTriangles=0;
  std::vector<std::shared_ptr<VRONode>> children;
  bool isHidden()const{return hidden;} void setHidden(bool h){hidden=h;}
  const auto& getChildNodes()const{return children;}
  // Same multiplicative visibility rule as pinned VRONode::updateSortKeys.
  int renderedTriangles(float inherited=1)const{
    float computed=inherited*opacity*(hidden?0:1);
    int n=computed>.02f?geometryTriangles:0;
    for(auto c:children)n+=c->renderedTriangles(computed);
    return n;
  }
};
void setSubtreeHidden${visibility}
using namespace quest_hands_math;
void close(V a,V b){ assert(length(sub(a,b))<.00002f); }
int main(){
  // Real bridge structure: tagged ViroNode -> Viro3DObject -> GLB scene -> geometry.
  // VRTComponent.parentDidDisappear also sets the child wrapper hidden.
  auto root=std::make_shared<VRONode>(), object=std::make_shared<VRONode>();
  auto scene=std::make_shared<VRONode>(), mesh=std::make_shared<VRONode>();
  root->children={object}; object->children={scene}; scene->children={mesh}; mesh->geometryTriangles=3620;
  root->hidden=object->hidden=true;
  root->setHidden(false);assert(root->renderedTriangles()==0); // original regression
  setSubtreeHidden(root,false);assert(root->renderedTriangles()==3620);
  for(int lifecycle=0;lifecycle<4;++lifecycle){ // loss, Back, new entry, recovery
    setSubtreeHidden(root,true);assert(root->renderedTriangles()==0);
    object->hidden=true; // asynchronous Java appearance write/model attachment
    setSubtreeHidden(root,false);assert(root->renderedTriangles()==3620);
  }
  auto late=std::make_shared<VRONode>();late->hidden=true;late->geometryTriangles=360;
  scene->children.push_back(late);setSubtreeHidden(root,false);assert(root->renderedTriangles()==3980);
  root->opacity=0;assert(root->renderedTriangles()==0);root->opacity=1;assert(root->renderedTriangles()==3980);
  const float s=std::sqrt(.5f);
  for(int side=0;side<2;++side){
    const V thumb=side==0?V{1,0,0}:V{-1,0,0};
    close(rotate(meshToGrip(side),thumb),{0,0,-1});
    const Q rotations[]={{0,0,0,1},{s,0,0,s},{0,s,0,s},{0,0,s,s},{.5f,.5f,.5f,.5f}};
    for(auto q:rotations){
      const V g{-.2f,1.1f,-.3f};auto f=fist(side,g,q);assert(f.visible);
      close(add(f.wrist,rotate(f.rotation,scale(palmCenter(side),kScale))),g);
      close(rotate(f.rotation,thumb),rotate(q,{0,0,-1}));
    }
    // Actual graph: rig scale 16, blue parent scale 1, child meshes fighterScale.
    for(Q yaw: {Q{0,0,0,1},Q{0,s,0,s},Q{0,1,0,0}}){
      const V origin{.2f,1.4f,-.1f}, eye{0,1.1271f,.2028f};
      const V body=scale(eye,-kFighterScale);
      const V joint{side==0?.127665097f:-.127665068f,.83775128f,.135874959f};
      const V expected=add(origin,rotate(yaw,scale(sub(joint,eye),kScale)));
      const V actual=shoulder(origin,yaw,{16,16,16},body,{0,0,0,1},{1,1,1},side);
      close(actual,expected);
      const V wrist=add(actual,rotate(yaw,{0,.1f,-.35f}));
      assert(arm(actual,wrist,{0,0,0,1},yaw,side).visible);
    }
    auto f=fist(side,{-.2f,1.12f,-.35f},{s,0,0,s});
    close(rotate(f.rotation,thumb),{0,1,0});
    for(V wrist: {V{-.2f,1.12f,-.35f},V{-.3f,.8f,-.7f},V{-.2f,1.7f,-.1f}}){
      V shoulder{-.15f,1.05f,.08f};auto a=arm(shoulder,wrist,f.rotation,{0,0,0,1},side);
      assert(a.visible);close(add(shoulder,rotate(a.upper,{0,0,-.218699927f*kScale*a.stretch})),a.elbow);
      close(add(wrist,rotate(a.forearm,{0,0,.188133323f*kScale*a.stretch})),a.elbow);
    }
    assert(!arm({0,1,0},{0,1,-3},f.rotation,{0,0,0,1},side).visible);
    assert(!arm({0,1,0},{0,1,0.01f},f.rotation,{0,0,0,1},side).visible);
    assert(!arm({0,1,0},{0,1,0.036f},f.rotation,{0,0,0,1},side).visible);
    assert(arm({0,1,0},{0,1,0.05f},f.rotation,{0,0,0,1},side).visible);
    assert(fist(side,{0,1,-3},{0,0,0,1}).visible);
  }
  assert(fresh(true,true,true,10,10,100,50000100));
  assert(!fresh(true,true,true,10,11,100,101));
  assert(!fresh(true,true,true,10,10,100,50000101));
  assert(!fresh(true,true,true,10,10,100,99));
  assert(!fresh(false,true,true,10,10,100,101));
  assert(!fresh(true,false,true,10,10,100,101));
  assert(!fresh(true,true,false,10,10,100,101));
  assert(!fist(0,{0,0,0},{0,0,0,0}).visible);
  return 0;
}`;
  const cpp = path.join(temp, 'test.cpp');
  const exe = path.join(temp, process.platform === 'win32' ? 'test.exe' : 'test');
  fs.writeFileSync(cpp, code);
  let built;
  if (process.platform === 'win32') {
    const vswhere = 'C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe';
    const found = spawnSync(
      vswhere,
      [
        '-latest',
        '-products',
        '*',
        '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath',
      ],
      { encoding: 'utf8', timeout: 10000 }
    );
    assert.equal(found.status, 0, found.stderr);
    const vars = path.join(found.stdout.trim(), 'VC/Auxiliary/Build/vcvars64.bat');
    const script = path.join(temp, 'compile.cmd');
    fs.writeFileSync(
      script,
      `@echo off\r\ncall "${vars}" >nul\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /EHsc /std:c++17 "${cpp}" /Fe:"${exe}" /Fo:"${path.join(temp, 'test.obj')}"\r\nexit /b %ERRORLEVEL%\r\n`
    );
    built = spawnSync('cmd.exe', ['/d', '/c', script], { encoding: 'utf8', timeout: 30000 });
  } else
    built = spawnSync(process.env.CXX || 'c++', ['-std=c++17', cpp, '-o', exe], {
      encoding: 'utf8',
      timeout: 30000,
    });
  assert.equal(built.status, 0, (built.error?.message || '') + built.stdout + built.stderr);
  const ran = spawnSync(exe, [], { encoding: 'utf8', timeout: 10000 });
  assert.equal(ran.status, 0, (ran.error?.message || '') + ran.stdout + ran.stderr);
});

function meshTopology(file) {
  const bytes = fs.readFileSync(path.join(root, 'assets/arena/quest', file));
  const len = bytes.readUInt32LE(12),
    g = JSON.parse(bytes.subarray(20, 20 + len));
  const bin = bytes.subarray(28 + len);
  const weld = new Map(),
    edges = new Map(),
    faces = new Map();
  let duplicateMaterialFaces = 0;
  g.meshes[0].primitives.forEach((p) => {
    const a = g.accessors[p.attributes.POSITION],
      v = g.bufferViews[a.bufferView],
      ids = [];
    for (let i = 0; i < a.count; i++) {
      const at = (v.byteOffset || 0) + (a.byteOffset || 0) + i * 12;
      const key = [0, 4, 8].map((n) => Math.round(bin.readFloatLE(at + n) * 1e5)).join(':');
      if (!weld.has(key)) weld.set(key, weld.size);
      ids.push(weld.get(key));
    }
    const idx = g.accessors[p.indices],
      bv = g.bufferViews[idx.bufferView];
    const get = (i) => ids[bin.readUInt16LE((bv.byteOffset || 0) + (idx.byteOffset || 0) + i * 2)];
    for (let i = 0; i < idx.count; i += 3) {
      const t = [get(i), get(i + 1), get(i + 2)];
      if (new Set(t).size < 3) continue;
      const faceKey = [...t].sort((a, b) => a - b).join(':');
      if (faces.has(faceKey) && faces.get(faceKey) !== p.material) duplicateMaterialFaces++;
      faces.set(faceKey, p.material);
      for (let k = 0; k < 3; k++) {
        const a = t[k],
          b = t[(k + 1) % 3],
          key = a < b ? a + ':' + b : b + ':' + a;
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    }
  });
  return { open: [...edges.values()].filter((n) => n === 1).length, duplicateMaterialFaces };
}

test('both fist shells, closed wrist balls, and forearms have zero welded open boundary edges', () => {
  const manifest = JSON.parse(read('assets/arena/quest/quest-first-person-extract.json'));
  assert.equal(manifest.arms.wristJoint.sealed, true);
  assert.equal(manifest.arms.wristJoint.radiusModel, 0.055);
  for (const hand of ['left', 'right']) {
    vectorNear(QUEST_HAND_PALM_CENTER_MODEL[hand], manifest.arms[hand].palmCenter);
    for (const part of ['hand', 'forearm'])
      assert.deepEqual(meshTopology(`quest-blue-${part}-${hand}.glb`), {
        open: 0,
        duplicateMaterialFaces: 0,
      });
  }
});

test('the wrist ball overlaps each shell at a common pivot through bends and twists', () => {
  function points(file) {
    const b = fs.readFileSync(path.join(root, 'assets/arena/quest', file));
    const len = b.readUInt32LE(12),
      g = JSON.parse(b.subarray(20, 20 + len)),
      bin = b.subarray(28 + len);
    return g.meshes[0].primitives.map((p) => {
      const a = g.accessors[p.attributes.POSITION],
        v = g.bufferViews[a.bufferView];
      return Array.from({ length: a.count }, (_, i) =>
        [0, 4, 8].map((k) =>
          bin.readFloatLE((v.byteOffset || 0) + (a.byteOffset || 0) + i * 12 + k)
        )
      );
    });
  }
  const s = Math.SQRT1_2;
  for (const hand of ['left', 'right']) {
    const fist = points(`quest-blue-hand-${hand}.glb`),
      forearm = points(`quest-blue-forearm-${hand}.glb`);
    const ball = fist.at(-1),
      radius = 0.055;
    for (const p of ball) near(Math.hypot(...p), radius, 1e-7);
    for (const shell of [fist[0], forearm[0]]) {
      const radii = shell.map((p) => Math.hypot(...p));
      assert.ok(Math.min(...radii) < radius - 0.005, 'shell penetrates the closed joint');
      assert.ok(Math.max(...radii) > radius + 0.005, 'shell extends beyond the joint');
      for (const q of [
        [0, 0, 0, 1],
        [s, 0, 0, s],
        [0, s, 0, s],
        [0, 0, s, s],
      ]) {
        // Rotation about the common wrist pivot preserves the overlap depth.
        near(
          Math.min(...shell.map((p) => Math.hypot(...rotateControllerVector(q, p)))),
          Math.min(...radii)
        );
      }
    }
  }
});

test('both real fist GLBs rasterize near their own grips through rotation, loss and recovery', () => {
  // CPU geometry/frustum regression, not a GPU/headset visibility approval.
  function mesh(file) {
    const b = fs.readFileSync(path.join(root, 'assets/arena/quest', file));
    const len = b.readUInt32LE(12),
      g = JSON.parse(b.subarray(20, 20 + len)),
      bin = b.subarray(28 + len);
    return g.meshes[0].primitives.map((p) => {
      const a = g.accessors[p.attributes.POSITION],
        v = g.bufferViews[a.bufferView];
      const vertices = Array.from({ length: a.count }, (_, i) =>
        [0, 4, 8].map((k) =>
          bin.readFloatLE((v.byteOffset || 0) + (a.byteOffset || 0) + 12 * i + k)
        )
      );
      const ix = g.accessors[p.indices],
        iv = g.bufferViews[ix.bufferView];
      const indices = Array.from({ length: ix.count }, (_, i) =>
        bin.readUInt16LE((iv.byteOffset || 0) + (ix.byteOffset || 0) + 2 * i)
      );
      return { vertices, indices };
    });
  }
  function pixels(parts, pose) {
    if (!pose.visible) return 0;
    const touched = new Set();
    for (const part of parts) {
      const projected = part.vertices.map((p) => {
        const v = rotateControllerVector(
          pose.orientation,
          p.map((n) => n * QUEST_FIRST_PERSON_ARM_SCALE)
        );
        const w = v.map((n, i) => n + pose.position[i]);
        return w[2] < -0.05 ? [64 + (64 * w[0]) / -w[2], 64 - (64 * (w[1] - 1.4)) / -w[2]] : null;
      });
      for (let i = 0; i < part.indices.length; i += 3) {
        const [a, b, c] = part.indices.slice(i, i + 3).map((j) => projected[j]);
        if (!a || !b || !c) continue;
        const edge = (u, v, x, y) => (x - u[0]) * (v[1] - u[1]) - (y - u[1]) * (v[0] - u[0]);
        const area = edge(a, b, ...c);
        if (Math.abs(area) < 1e-8) continue;
        const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))),
          maxX = Math.min(127, Math.ceil(Math.max(a[0], b[0], c[0])));
        const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))),
          maxY = Math.min(127, Math.ceil(Math.max(a[1], b[1], c[1])));
        for (let y = minY; y <= maxY; y++)
          for (let x = minX; x <= maxX; x++) {
            const u = edge(a, b, x + 0.5, y + 0.5) / area,
              v = edge(b, c, x + 0.5, y + 0.5) / area,
              w = edge(c, a, x + 0.5, y + 0.5) / area;
            if (u >= 0 && v >= 0 && w >= 0) touched.add(y * 128 + x);
          }
      }
    }
    return touched.size;
  }
  const s = Math.SQRT1_2;
  for (const hand of ['left', 'right']) {
    const parts = mesh(`quest-blue-hand-${hand}.glb`),
      grip = [hand === 'left' ? -0.2 : 0.2, 1.2, -0.55];
    for (const q of [
      [s, 0, 0, s],
      [0.5, 0.5, 0.5, 0.5],
      [0, s, 0, s],
    ]) {
      const f = controllerFistPose(hand, grip, q),
        pose = { ...f, visible: true };
      assert.ok(pixels(parts, pose) > 50, `${hand} real triangles must occupy the camera frustum`);
      assert.equal(
        pixels(parts, { ...pose, visible: false }),
        0,
        'tracking loss/entry hide produces no frozen mesh'
      );
      assert.ok(
        pixels(parts, pose) > 50,
        'same GLB recovers after loss/recenter without reloading'
      );
      const palm = rotateControllerVector(
        f.orientation,
        QUEST_HAND_PALM_CENTER_MODEL[hand].map((n) => n * QUEST_FIRST_PERSON_ARM_SCALE)
      );
      vectorNear(
        f.position.map((n, i) => n + palm[i]),
        grip
      );
    }
  }
});

test('patch 0005 uses real grip spaces within one action set and same predicted render frame', () => {
  const lock = JSON.parse(read('tools/quest/viro-renderer/lock.json'));
  assert.equal(lock.patches[4], '0005-openxr-controller-attached-hands.patch');
  const patch = read('tools/quest/viro-renderer/' + lock.patches[4]);
  const added = patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');
  assert.doesNotMatch(added, /xrAttachSessionActionSets\(|xrCreateSession\(|xrSyncActions\(/);
  for (const side of ['left', 'right'])
    assert.ok(added.includes(`/user/hand/${side}/input/grip/pose`));
  assert.match(added, /_leftGripPoseAction = createAction\(_actionSet, XR_ACTION_TYPE_POSE_INPUT/);
  assert.match(added, /_rightGripPoseAction = createAction\(_actionSet, XR_ACTION_TYPE_POSE_INPUT/);
  assert.match(added, /quest_hands::afterEyes\(/);
  assert.match(added, /xrLocateSpace\(gripSpaces\[i\], baseSpace, time/);
  assert.match(added, /slot\.longs\[0\]==seq/);
  assert.match(added, /quest_hands::apply\(rigSceneRoot/);
  assert.match(added, /quest_hands::beforeEyes\(frameState\.predictedDisplayTime\)/);
  assert.match(added, /nativeReadGrip/);
  const reset = read('tools/quest/viro-renderer/quest-hands-renderer.h')
    .split('inline void reset()')[1]
    .split('inline void apply')[0];
  assert.doesNotMatch(reset, /enabled.store/);
  assert.match(added, /static thread_local Cache cache/);
  assert.match(added, /m::shoulder\(vec\(rig->getPosition/);
  assert.doesNotMatch(added, /combatCommand|damage\(|punch\(|block\(/);
  for (const [file, name] of [
    ['quest-hands-math.h', 'QuestHandsMath.h'],
    ['quest-hands-renderer.h', 'QuestHandsRenderer.h'],
  ]) {
    const section = patch
      .split(`+++ b/android/sharedCode/src/main/cpp/${name}\n`)[1]
      .split('diff --git ')[0];
    const contents =
      section
        .split('\n')
        .filter((l) => l.startsWith('+'))
        .map((l) => l.slice(1))
        .join('\n') + '\n';
    assert.equal(
      contents,
      read('tools/quest/viro-renderer/' + file),
      'checked-in native math and locked patch agree'
    );
  }
});

test('JS fallback pose age includes native read, decode, and queued frame delay', (t) => {
  let now = 1000;
  const a = [0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const source = createQuestInputSource({
    reader: {
      read: () => {
        now += 30;
        return {
          available: true,
          version: 1,
          generation: 1,
          live: true,
          actionsReady: true,
          count: 1,
          seq: [1],
          capturedNs: [0],
          displayTimeNs: [0],
          nowNs: 1_000_000,
          ints: [0, 5, 1, 1, 0, 0, 15, 0, 1, 0, 0, 15, 0, 1, 0],
          floats: [...a, ...a],
        };
      },
    },
    now: () => now,
    schedule: () => 1,
    cancel: () => {},
  });
  t.after(() => source.stop());
  source.start();
  assert.ok(
    source.getLiveState().nowNs >= 31_000_000,
    'read/decode delay cannot make old data appear fresh'
  );
  now += 30;
  assert.ok(
    source.getLiveState().nowNs >= 61_000_000,
    'queued JS frame time counts toward stale threshold'
  );
});
