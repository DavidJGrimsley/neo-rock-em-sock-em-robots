// Regenerates the Quest-only first-person body and hand GLBs from the blue Combat file.
// Reads both Combat GLBs, writes only under --out, and does not modify the originals.
// Grip is not a pose in the source file and this script does not invent one.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const repoRoot = path.resolve(__dirname, '..');
const BLUE = 'Mike_Player1_Blue_Combat_AR.glb';
const RED = 'Mike_Player2_RedOrange_Combat_AR.glb';
const SOURCE_DIR = path.join(repoRoot, 'assets', 'arena');
// Proximal fraction of the shoulder-to-elbow segment kept as a shoulder cap on the body.
const SHOULDER_CAP_T = 0.22;
// Upper sleeve starts inside that cap and continues slightly past the elbow.
const UPPER_START_T = 0.08;
const UPPER_END_T = 1.08;
// Forearm keeps lowerarm plus straddling/proximal wrist cuff triangles up to this t past the wrist,
// while the fist starts cleanly at the wrist joint so bending the wrist never swings a rigid sleeve sideways.
const FOREARM_WRIST_OVERLAP_T = 1.12;
// Blend weight from IdleAggro (0) to BlockHold (1) for natural relaxed-closed boxing fists without knuckle crush.
const FIST_POSE_BLEND = 0.75;
// Shift the headless first-person body forward (+Z in model space) so the chest, torso, and feet sit under the wearer's eyes (ROBOT_EYE_MODEL z = 0.2028) instead of behind them at spawn.
const BODY_FORWARD_SHIFT_MODEL = 0.16;
// Quest copies only. The Combat PNG bytes stay 1024 in the original GLBs.
const TEXTURE_EDGE = 256;
const ARM_TEXTURE_EDGE = 128;

const BODY_CLIPS = ['IdleAggro', 'WalkForward', 'WalkBackward', 'StrafeLeft', 'StrafeRight'];
const BODY_JOINT_NAMES = [
  'SK_ZMike',
  'root',
  'pelvis',
  'spine_01',
  'spine_02',
  'spine_03',
  'neck_01',
  'clavicle_l',
  'upperarm_l',
  'clavicle_r',
  'upperarm_r',
  'PropBack',
  'thigh_l',
  'calf_l',
  'foot_l',
  'ball_l',
  'thigh_r',
  'calf_r',
  'foot_r',
  'ball_r',
];

function parseArgs(argv) {
  let outDir = path.join(SOURCE_DIR, 'quest');
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      outDir = path.resolve(argv[i + 1]);
      i += 1;
    } else {
      throw new Error(`Unknown argument ${argv[i]}`);
    }
  }
  return { outDir };
}

function readGlb(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) {
    throw new Error(`Not a GLB v2: ${filePath}`);
  }
  if (bytes.readUInt32LE(8) !== bytes.length) throw new Error(`Bad GLB length: ${filePath}`);
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`Missing JSON chunk: ${filePath}`);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binHeader = 20 + jsonLength;
  if (bytes.readUInt32LE(binHeader + 4) !== 0x004e4942)
    throw new Error(`Missing BIN chunk: ${filePath}`);
  const binLength = bytes.readUInt32LE(binHeader);
  const binary = bytes.subarray(binHeader + 8, binHeader + 8 + binLength);
  return { bytes, json, binary };
}

function accessorView(gltf, accessorIndex) {
  const accessor = gltf.json.accessors[accessorIndex];
  const view = gltf.json.bufferViews[accessor.bufferView];
  if ((view.buffer ?? 0) !== 0) throw new Error(`External buffer on accessor ${accessorIndex}`);
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[accessor.type];
  if (!components) throw new Error(`Unsupported accessor type ${accessor.type}`);
  const sizes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const size = sizes[accessor.componentType];
  if (!size) throw new Error(`Unsupported component ${accessor.componentType}`);
  const stride = view.byteStride || components * size;
  const start = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  return { accessor, components, size, stride, start, count: accessor.count };
}

function readElements(gltf, accessorIndex) {
  const spec = accessorView(gltf, accessorIndex);
  const { binary } = gltf;
  const out = new Array(spec.count);
  for (let i = 0; i < spec.count; i += 1) {
    const element = new Array(spec.components);
    const base = spec.start + i * spec.stride;
    for (let c = 0; c < spec.components; c += 1) {
      const offset = base + c * spec.size;
      if (spec.accessor.componentType === 5126) element[c] = binary.readFloatLE(offset);
      else if (spec.accessor.componentType === 5123) element[c] = binary.readUInt16LE(offset);
      else if (spec.accessor.componentType === 5121) element[c] = binary.readUInt8(offset);
      else if (spec.accessor.componentType === 5125) element[c] = binary.readUInt32LE(offset);
      else if (spec.accessor.componentType === 5122) element[c] = binary.readInt16LE(offset);
      else element[c] = binary.readInt8(offset);
    }
    out[i] = spec.components === 1 ? element[0] : element;
  }
  return out;
}

function readIndices(gltf, accessorIndex) {
  const values = readElements(gltf, accessorIndex);
  return values.map((value) => (Array.isArray(value) ? value[0] : value));
}

function identity() {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function multiply(a, b) {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] =
        a[row] * b[col * 4] +
        a[4 + row] * b[col * 4 + 1] +
        a[8 + row] * b[col * 4 + 2] +
        a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function translation(x, y, z) {
  const out = identity();
  out[12] = x;
  out[13] = y;
  out[14] = z;
  return out;
}

function rotation(x, y, z, w) {
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return new Float64Array([
    1 - (yy + zz),
    xy + wz,
    xz - wy,
    0,
    xy - wz,
    1 - (xx + zz),
    yz + wx,
    0,
    xz + wy,
    yz - wx,
    1 - (xx + yy),
    0,
    0,
    0,
    0,
    1,
  ]);
}

function scaleMatrix(x, y, z) {
  const out = identity();
  out[0] = x;
  out[5] = y;
  out[10] = z;
  return out;
}

function localMatrix(node) {
  if (node.matrix) return new Float64Array(node.matrix);
  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  return multiply(
    translation(t[0], t[1], t[2]),
    multiply(rotation(r[0], r[1], r[2], r[3]), scaleMatrix(s[0], s[1], s[2]))
  );
}

function nodeWorlds(nodes) {
  const parent = new Array(nodes.length).fill(-1);
  nodes.forEach((node, index) => {
    for (const child of node.children || []) parent[child] = index;
  });
  const worlds = new Array(nodes.length);
  const visit = (index) => {
    if (worlds[index]) return worlds[index];
    const local = localMatrix(nodes[index]);
    worlds[index] = parent[index] < 0 ? local : multiply(visit(parent[index]), local);
    return worlds[index];
  };
  nodes.forEach((_, index) => visit(index));
  return worlds;
}

function transformPoint(matrix, point) {
  const x = point[0];
  const y = point[1];
  const z = point[2];
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  return [
    (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w,
    (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w,
    (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w,
  ];
}

function inverseTranspose3(matrix) {
  const a = matrix[0];
  const b = matrix[4];
  const c = matrix[8];
  const d = matrix[1];
  const e = matrix[5];
  const f = matrix[9];
  const g = matrix[2];
  const h = matrix[6];
  const i = matrix[10];
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const D = c * h - b * i;
  const E = a * i - c * g;
  const F = b * g - a * h;
  const G = b * f - c * e;
  const H = c * d - a * f;
  const I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const s = 1 / det;
  return [A * s, D * s, G * s, B * s, E * s, H * s, C * s, F * s, I * s];
}

function transformNormal(matrix3, normal) {
  return [
    matrix3[0] * normal[0] + matrix3[3] * normal[1] + matrix3[6] * normal[2],
    matrix3[1] * normal[0] + matrix3[4] * normal[1] + matrix3[7] * normal[2],
    matrix3[2] * normal[0] + matrix3[5] * normal[1] + matrix3[8] * normal[2],
  ];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(v, s) {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v) {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n < 1e-8) throw new Error('Zero-length vector');
  return [v[0] / n, v[1] / n, v[2] / n];
}

function mat3Columns(c0, c1, c2) {
  return [c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], c2[0], c2[1], c2[2]];
}

function mul3(a, b) {
  const out = new Array(9);
  for (let col = 0; col < 3; col += 1) {
    for (let row = 0; row < 3; row += 1) {
      out[col * 3 + row] =
        a[row] * b[col * 3] + a[3 + row] * b[col * 3 + 1] + a[6 + row] * b[col * 3 + 2];
    }
  }
  return out;
}

function apply3(matrix, v) {
  return [
    matrix[0] * v[0] + matrix[3] * v[1] + matrix[6] * v[2],
    matrix[1] * v[0] + matrix[4] * v[1] + matrix[7] * v[2],
    matrix[2] * v[0] + matrix[5] * v[1] + matrix[8] * v[2],
  ];
}

function det3(m) {
  return dot([m[0], m[1], m[2]], cross([m[3], m[4], m[5]], [m[6], m[7], m[8]]));
}

// Maps `direction` onto local -Z and world +Y onto local +Y.
// Target columns are -X, +Y, -Z so the rotation is proper (det +1).
// The same builder is used for both hands; it does not mirror X and it does not roll 180.
function aimRotation(direction) {
  const forward = normalize(direction);
  let up = [0, 1, 0];
  up = sub(up, scale(forward, dot(up, forward)));
  if (Math.hypot(up[0], up[1], up[2]) < 1e-6) up = [1, 0, 0];
  up = normalize(up);
  const right = normalize(cross(up, forward));
  up = normalize(cross(forward, right));
  const source = mat3Columns(right, up, forward);
  const target = mat3Columns([-1, 0, 0], [0, 1, 0], [0, 0, -1]);
  const rotation3 = mul3(target, [
    source[0],
    source[3],
    source[6],
    source[1],
    source[4],
    source[7],
    source[2],
    source[5],
    source[8],
  ]);
  const mapped = apply3(rotation3, forward);
  if (Math.hypot(mapped[0], mapped[1], mapped[2] + 1) > 1e-5) {
    throw new Error(`Direction did not map to local -Z: ${mapped}`);
  }
  const determinant = det3(rotation3);
  if (determinant < 0.999) {
    throw new Error(`Aim rotation is not a proper rotation: det ${determinant}`);
  }
  return rotation3;
}

function quatMul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function quatConj(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

function quatNorm(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

function rotateQuatVec(q, v) {
  const ux = [q[0], q[1], q[2]];
  const t = scale(cross(ux, v), 2);
  return add(add(v, scale(t, q[3])), cross(ux, t));
}

function lerpVec(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function quatX(deg) {
  const half = (deg * Math.PI) / 360;
  return [Math.sin(half), 0, 0, Math.cos(half)];
}

function quatAxisAngle(axis, deg) {
  const half = (deg * Math.PI) / 360;
  const s = Math.sin(half);
  const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  return [(axis[0] / n) * s, (axis[1] / n) * s, (axis[2] / n) * s, Math.cos(half)];
}

function slerpQuat(a, b, t) {
  let [ax, ay, az, aw] = a;
  let [bx, by, bz, bw] = b;
  let d = ax * bx + ay * by + az * bz + aw * bw;
  if (d < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    d = -d;
  }
  if (d > 0.9995) {
    const out = [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, aw + (bw - aw) * t];
    const n = Math.hypot(...out) || 1;
    return out.map((v) => v / n);
  }
  const theta0 = Math.acos(Math.min(1, Math.max(-1, d)));
  const sin0 = Math.sin(theta0);
  const s0 = Math.sin((1 - t) * theta0) / sin0;
  const s1 = Math.sin(t * theta0) / sin0;
  return [ax * s0 + bx * s1, ay * s0 + by * s1, az * s0 + bz * s1, aw * s0 + bw * s1];
}

function clipNodeRotation(gltf, clipName, nodeIndex) {
  const anim = (gltf.json.animations || []).find((entry) => entry.name === clipName);
  if (!anim) throw new Error(`Missing animation clip ${clipName}`);
  const channel = anim.channels.find(
    (entry) => entry.target?.node === nodeIndex && entry.target?.path === 'rotation'
  );
  if (!channel) return null;
  const sampler = anim.samplers[channel.sampler];
  const values = readElements(gltf, sampler.output);
  return values[0] || null;
}

// Blend finger rotations from IdleAggro toward BlockHold (rotations only; scale stays [1, 1, 1])
// so fists look naturally clenched like a boxing glove without crushing proximal/thumb joints.
function withCurledFingers(gltf) {
  const nodes = gltf.json.nodes;
  return nodes.map((node, nodeIndex) => {
    const match = /^(index|pinky|thumb)_0([123])_[lr]$/.exec(node.name || '');
    if (!match) return node;
    const rest = node.rotation || [0, 0, 0, 1];
    const idleRot = clipNodeRotation(gltf, 'IdleAggro', nodeIndex) || rest;
    const blockRot = clipNodeRotation(gltf, 'BlockHold', nodeIndex) || idleRot;
    return { ...node, rotation: slerpQuat(idleRot, blockRot, FIST_POSE_BLEND), scale: [1, 1, 1] };
  });
}

function fingerTip(nodes, chain) {
  const byName = new Map(nodes.map((node, index) => [node.name, index]));
  let point = [0, 0, 0];
  for (let i = chain.length - 1; i >= 1; i -= 1) {
    const node = nodes[byName.get(chain[i])];
    const rotation = node.rotation || [0, 0, 0, 1];
    const translation = node.translation || [0, 0, 0];
    const rotated = [0, 0, 0];
    const q = rotation;
    const x = q[0];
    const y = q[1];
    const z = q[2];
    const w = q[3];
    const ux = [x, y, z];
    const t = scale(cross(ux, point), 2);
    const spun = add(add(point, scale(t, w)), cross(ux, t));
    rotated[0] = spun[0];
    rotated[1] = spun[1];
    rotated[2] = spun[2];
    point = add(rotated, translation);
  }
  return { distance: Math.hypot(point[0], point[1], point[2]), position: point };
}

function bakePart(part, origin, rotation3) {
  return {
    ...part,
    positions: part.positions.map((point) => apply3(rotation3, sub(point, origin))),
    normals: part.normals.map((normal) => normalize(apply3(rotation3, normal))),
  };
}

function capOpenBoundaries(part) {
  // Weld vertices by quantized 3D position so duplicate UV-seam vertices do not split open loops.
  const weldMap = new Map();
  const weldOf = new Array(part.positions.length);
  const repOfWeld = [];
  for (let i = 0; i < part.positions.length; i += 1) {
    const p = part.positions[i];
    const key = `${Math.round(p[0] * 1e5)}:${Math.round(p[1] * 1e5)}:${Math.round(p[2] * 1e5)}`;
    if (!weldMap.has(key)) {
      weldMap.set(key, repOfWeld.length);
      repOfWeld.push(i);
    }
    weldOf[i] = weldMap.get(key);
  }

  const undirectedCount = new Map();
  const directedSet = new Set();
  const directedEdges = [];
  const edgeKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  for (let i = 0; i < part.indices.length; i += 3) {
    const tri = [weldOf[part.indices[i]], weldOf[part.indices[i + 1]], weldOf[part.indices[i + 2]]];
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[2] === tri[0]) continue;
    for (let edge = 0; edge < 3; edge += 1) {
      const u = tri[edge];
      const v = tri[(edge + 1) % 3];
      const ukey = edgeKey(u, v);
      undirectedCount.set(ukey, (undirectedCount.get(ukey) || 0) + 1);
      const dkey = `${u}:${v}`;
      if (!directedSet.has(dkey)) {
        directedSet.add(dkey);
        directedEdges.push([u, v]);
      }
    }
  }

  // A boundary edge u -> v has undirected count 1 and no opposite edge v -> u.
  // The cap triangle filling the hole traverses v -> u -> center to preserve manifold winding.
  const nextBoundary = new Map();
  for (const [u, v] of directedEdges) {
    if (undirectedCount.get(edgeKey(u, v)) !== 1) continue;
    if (directedSet.has(`${v}:${u}`)) continue;
    if (!nextBoundary.has(u)) nextBoundary.set(u, []);
    nextBoundary.get(u).push(v);
  }

  let capsAdded = 0;
  const visitedEdges = new Set();
  for (const [startU, targets] of nextBoundary) {
    for (const firstV of targets) {
      const startKey = `${startU}:${firstV}`;
      if (visitedEdges.has(startKey)) continue;
      const loop = [startU];
      let prev = startU;
      let curr = firstV;
      visitedEdges.add(startKey);
      let closed = false;
      let steps = 0;
      while (steps < 2000) {
        steps += 1;
        if (curr === startU) {
          closed = true;
          break;
        }
        loop.push(curr);
        const candidates = nextBoundary.get(curr) || [];
        const next = candidates.find((cand) => !visitedEdges.has(`${curr}:${cand}`));
        if (next === undefined) break;
        visitedEdges.add(`${curr}:${next}`);
        prev = curr;
        curr = next;
      }
      void prev;
      if (!closed || loop.length < 3) continue;

      const repLoop = loop.map((w) => repOfWeld[w]);
      const center = [0, 0, 0];
      const uv = [0, 0];
      const polygon = [0, 0, 0];
      for (let i = 0; i < repLoop.length; i += 1) {
        const current = part.positions[repLoop[i]];
        const next = part.positions[repLoop[(i + 1) % repLoop.length]];
        const cuv = part.uvs[repLoop[i]];
        center[0] += current[0];
        center[1] += current[1];
        center[2] += current[2];
        uv[0] += cuv[0];
        uv[1] += cuv[1];
        polygon[0] += (current[1] - next[1]) * (current[2] + next[2]);
        polygon[1] += (current[2] - next[2]) * (current[0] + next[0]);
        polygon[2] += (current[0] - next[0]) * (current[1] + next[1]);
      }
      const inv = 1 / repLoop.length;
      const centerPoint = scale(center, inv);
      const polygonLength = Math.hypot(polygon[0], polygon[1], polygon[2]);
      if (polygonLength < 1e-8) continue;
      // Boundary edge u -> v means cap fan goes [center, v, u] = [center, next, current].
      // For triangle (center, next, current), face normal is cross(next - center, current - center),
      // which matches -polygon (reverse of u -> v Newell normal).
      const capNormal = scale(polygon, -1 / polygonLength);
      const centerUv = scale(uv, inv);
      // Ear clipping handles concave cut loops that a center fan rejects.
      // Project along the dominant Newell normal; preserve all seam positions.
      const drop = polygon.map(Math.abs).indexOf(Math.max(...polygon.map(Math.abs)));
      const project = (p) => p.filter((_, axis) => axis !== drop);
      const points = repLoop.map((i) => project(part.positions[i]));
      const cross2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const area = points.reduce((sum, p, i) => {
        const q = points[(i + 1) % points.length];
        return sum + p[0] * q[1] - q[0] * p[1];
      }, 0);
      if (Math.abs(area) < 1e-12) continue;
      const sign = Math.sign(area),
        remaining = points.map((_, i) => i),
        triangles = [];
      let guard = remaining.length * remaining.length;
      while (remaining.length > 3 && guard-- > 0) {
        let found = false;
        for (let i = 0; i < remaining.length; i++) {
          const a = remaining[(i + remaining.length - 1) % remaining.length],
            b = remaining[i],
            c = remaining[(i + 1) % remaining.length];
          if (sign * cross2(points[a], points[b], points[c]) <= 1e-12) continue;
          const inside = remaining.some(
            (k) =>
              k !== a &&
              k !== b &&
              k !== c &&
              sign * cross2(points[a], points[b], points[k]) > 1e-12 &&
              sign * cross2(points[b], points[c], points[k]) > 1e-12 &&
              sign * cross2(points[c], points[a], points[k]) > 1e-12
          );
          if (inside) continue;
          triangles.push([a, c, b]);
          remaining.splice(i, 1);
          found = true;
          break;
        }
        if (!found) {
          // Collinear boundary samples can be removed for triangulation only.
          const i = remaining.findIndex(
            (b, i) =>
              Math.abs(
                cross2(
                  points[remaining[(i + remaining.length - 1) % remaining.length]],
                  points[b],
                  points[remaining[(i + 1) % remaining.length]]
                )
              ) < 1e-12
          );
          if (i < 0) break;
          remaining.splice(i, 1);
        }
      }
      if (remaining.length !== 3) continue;
      triangles.push([remaining[0], remaining[2], remaining[1]]);
      const rimStart = part.positions.length;
      for (const index of repLoop) {
        part.positions.push([...part.positions[index]]);
        part.normals.push([...capNormal]);
        part.uvs.push([...part.uvs[index]]);
        if (part.joints) part.joints.push([...part.joints[index]]);
        if (part.weights) part.weights.push([...part.weights[index]]);
      }
      const capIndices = triangles.flatMap((tri) => tri.map((i) => rimStart + i));
      part.indices.push(...capIndices);
      (part.capGroups ||= []).push({ source: repLoop, indices: capIndices });
      capsAdded += triangles.length;
    }
  }
  part.capsAdded = (part.capsAdded || 0) + capsAdded;
  return part;
}

// Find openings across ALL materials together: LED/metal boundaries are seams,
// not holes. Per-material caps make duplicate coplanar faces and hide source LEDs.
function capPartsTogether(parts) {
  const hasSkin = parts.every((part) => Array.isArray(part.joints) && Array.isArray(part.weights));
  const combined = {
    positions: [],
    normals: [],
    uvs: [],
    ...(hasSkin ? { joints: [], weights: [] } : {}),
    indices: [],
    capGroups: [],
  };
  const owners = [];
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    repairWinding(part);
    const base = combined.positions.length;
    combined.positions.push(...part.positions);
    combined.normals.push(...part.normals);
    combined.uvs.push(...part.uvs);
    if (hasSkin) {
      combined.joints.push(...part.joints);
      combined.weights.push(...part.weights);
    }
    combined.indices.push(...part.indices.map((i) => base + i));
    owners.push(...part.positions.map(() => pi));
  }
  capOpenBoundaries(combined);
  for (const group of combined.capGroups) {
    const votes = new Map();
    for (const i of group.source) votes.set(owners[i], (votes.get(owners[i]) || 0) + 1);
    const owner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const dst = parts[owner],
      remap = new Map();
    for (const i of group.indices) {
      if (!remap.has(i)) {
        remap.set(i, dst.positions.length);
        dst.positions.push([...combined.positions[i]]);
        dst.normals.push([...combined.normals[i]]);
        dst.uvs.push([...combined.uvs[i]]);
        if (hasSkin) {
          dst.joints.push([...combined.joints[i]]);
          dst.weights.push([...combined.weights[i]]);
        }
      }
      dst.indices.push(remap.get(i));
    }
    dst.capsAdded = (dst.capsAdded || 0) + group.indices.length / 3;
  }
  return parts;
}

function wristJointPart(parts) {
  const main = parts.find((part) => part.material === 0) || parts[0];
  let nearest = 0;
  for (let i = 1; i < main.positions.length; i++) {
    if (Math.hypot(...main.positions[i]) < Math.hypot(...main.positions[nearest])) nearest = i;
  }
  const uv = main.uvs[nearest],
    radius = 0.055,
    rings = 10,
    segments = 20;
  const part = {
    material: main.material,
    positions: [],
    normals: [],
    uvs: [],
    indices: [],
    capsAdded: 0,
  };
  for (let row = 0; row <= rings; row++) {
    const theta = (Math.PI * row) / rings;
    for (let col = 0; col < segments; col++) {
      const phi = (2 * Math.PI * col) / segments;
      const n = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
      part.positions.push(scale(n, radius));
      part.normals.push(n);
      part.uvs.push([...uv]);
    }
  }
  for (let row = 0; row < rings; row++)
    for (let col = 0; col < segments; col++) {
      const a = row * segments + col,
        b = row * segments + ((col + 1) % segments),
        c = a + segments,
        d = b + segments;
      if (row > 0) part.indices.push(a, b, c);
      if (row < rings - 1) part.indices.push(b, d, c);
    }
  repairWinding(part);
  return part;
}

function collectParts(meshes, keepTriangleOrVertex) {
  const parts = [];
  for (const mesh of meshes) {
    if (mesh.name === 'SKM_MegaMikeZ_part_1') continue;
    for (const primitive of mesh.primitives) {
      const selected = selectTriangles(primitive, keepTriangleOrVertex(primitive));
      if (selected.indices.length === 0) continue;
      parts.push(selected);
    }
  }
  return capPartsTogether(parts);
}

function invertedTriangles(parts) {
  let inverted = 0;
  let outward = 0;
  for (const part of parts) {
    for (let i = 0; i < part.indices.length; i += 3) {
      const a = part.positions[part.indices[i]];
      const b = part.positions[part.indices[i + 1]];
      const c = part.positions[part.indices[i + 2]];
      const face = cross(sub(b, a), sub(c, a));
      if (Math.hypot(face[0], face[1], face[2]) < 1e-12) continue;
      const average = normalize(
        add(
          add(part.normals[part.indices[i]], part.normals[part.indices[i + 1]]),
          part.normals[part.indices[i + 2]]
        )
      );
      if (dot(face, average) >= 0) outward += 1;
      else inverted += 1;
    }
  }
  return { inverted, outward };
}

function repairWinding(part) {
  let flipped = 0;
  for (let i = 0; i < part.indices.length; i += 3) {
    const ia = part.indices[i];
    const ib = part.indices[i + 1];
    const ic = part.indices[i + 2];
    const face = cross(
      sub(part.positions[ib], part.positions[ia]),
      sub(part.positions[ic], part.positions[ia])
    );
    if (Math.hypot(face[0], face[1], face[2]) < 1e-12) continue;
    const average = add(add(part.normals[ia], part.normals[ib]), part.normals[ic]);
    if (dot(face, average) < 0) {
      part.indices[i + 1] = ic;
      part.indices[i + 2] = ib;
      flipped += 1;
    }
  }
  return flipped;
}

function assertOutward(parts, label) {
  const winding = invertedTriangles(parts);
  if (winding.inverted !== 0) {
    throw new Error(`${label} has ${winding.inverted} inverted triangles`);
  }
  if (winding.outward === 0) throw new Error(`${label} has no triangles`);
  return winding.outward;
}

function isHeadJoint(name) {
  return (
    name === 'neck_01' ||
    name === 'head_01' ||
    name.startsWith('Jaw') ||
    name.startsWith('antenna_') ||
    name.startsWith('eye_') ||
    name.startsWith('Brow_') ||
    name.startsWith('eyelid_')
  );
}

function sideOf(name) {
  if (name.endsWith('_l') || name.endsWith('_L')) return 'l';
  if (name.endsWith('_r') || name.endsWith('_R')) return 'r';
  return null;
}

function projectionT(point, origin, target) {
  const axis = sub(target, origin);
  const len2 = dot(axis, axis);
  if (len2 < 1e-10) return 0;
  return dot(sub(point, origin), axis) / len2;
}

function skinGeometry(gltf, worlds) {
  const skin = gltf.json.skins[0];
  const inverseBind = readElements(gltf, skin.inverseBindMatrices);
  const jointMatrices = skin.joints.map((nodeIndex, jointIndex) =>
    multiply(worlds[nodeIndex], new Float64Array(inverseBind[jointIndex]))
  );
  const normalMatrices = jointMatrices.map(inverseTranspose3);
  const jointNames = skin.joints.map(
    (nodeIndex) => gltf.json.nodes[nodeIndex].name || `node_${nodeIndex}`
  );
  const meshes = gltf.json.meshes.map((mesh) => {
    const primitives = mesh.primitives.map((primitive) => {
      const positions = readElements(gltf, primitive.attributes.POSITION);
      const normals = primitive.attributes.NORMAL
        ? readElements(gltf, primitive.attributes.NORMAL)
        : positions.map(() => [0, 1, 0]);
      const uvs = readElements(gltf, primitive.attributes.TEXCOORD_0);
      const joints = readElements(gltf, primitive.attributes.JOINTS_0);
      const weights = readElements(gltf, primitive.attributes.WEIGHTS_0);
      const indices = readIndices(gltf, primitive.indices);
      const skinnedPositions = new Array(positions.length);
      const skinnedNormals = new Array(positions.length);
      const dominant = new Array(positions.length);
      for (let i = 0; i < positions.length; i += 1) {
        const weight = weights[i];
        const joint = joints[i];
        let sum = weight[0] + weight[1] + weight[2] + weight[3];
        if (sum <= 0) sum = 1;
        const position = [0, 0, 0];
        const normal = [0, 0, 0];
        let best = 0;
        for (let k = 0; k < 4; k += 1) {
          const w = weight[k] / sum;
          if (w > weight[best] / sum) best = k;
          if (w === 0) continue;
          const p = transformPoint(jointMatrices[joint[k]], positions[i]);
          const n = transformNormal(normalMatrices[joint[k]], normals[i]);
          position[0] += p[0] * w;
          position[1] += p[1] * w;
          position[2] += p[2] * w;
          normal[0] += n[0] * w;
          normal[1] += n[1] * w;
          normal[2] += n[2] * w;
        }
        skinnedPositions[i] = position;
        const nn = Math.hypot(normal[0], normal[1], normal[2]) || 1;
        skinnedNormals[i] = [normal[0] / nn, normal[1] / nn, normal[2] / nn];
        dominant[i] = joint[best];
      }
      return {
        material: primitive.material,
        mode: primitive.mode ?? 4,
        positions: skinnedPositions,
        normals: skinnedNormals,
        uvs,
        joints,
        weights,
        indices,
        dominant,
      };
    });
    return { name: mesh.name, primitives };
  });
  return { jointNames, meshes };
}

function boundsOf(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k], point[k]);
      max[k] = Math.max(max[k], point[k]);
    }
  }
  return { min, max };
}

function selectTriangles(primitive, keepVertexOrTri, includeSkin = false) {
  const used = new Map();
  const indices = [];
  const positions = [];
  const normals = [];
  const uvs = [];
  const joints = includeSkin ? [] : null;
  const weights = includeSkin ? [] : null;
  const sourceIndex = [];
  const byTri = keepVertexOrTri.length === 3;
  for (let t = 0; t < primitive.indices.length; t += 3) {
    const tri = [primitive.indices[t], primitive.indices[t + 1], primitive.indices[t + 2]];
    const keep = byTri ? keepVertexOrTri(tri[0], tri[1], tri[2]) : tri.every(keepVertexOrTri);
    if (!keep) continue;
    for (const index of tri) {
      if (!used.has(index)) {
        used.set(index, positions.length);
        positions.push(primitive.positions[index]);
        normals.push(primitive.normals[index]);
        uvs.push(primitive.uvs[index]);
        if (includeSkin) {
          joints.push([...primitive.joints[index]]);
          weights.push([...primitive.weights[index]]);
        }
        sourceIndex.push(index);
      }
      indices.push(used.get(index));
    }
  }
  return {
    positions,
    normals,
    uvs,
    ...(includeSkin ? { joints, weights } : {}),
    indices,
    sourceIndex,
    material: primitive.material,
  };
}

function downsamplePng(bytes, edge = TEXTURE_EDGE) {
  const src = PNG.sync.read(bytes);
  if (src.width <= edge && src.height <= edge) return bytes;
  const width = Math.max(1, Math.round((src.width * edge) / Math.max(src.width, src.height)));
  const height = Math.max(1, Math.round((src.height * edge) / Math.max(src.width, src.height)));
  const dst = new PNG({ width, height, colorType: 6 });
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor((y * src.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / height));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor((x * src.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const index = (yy * src.width + xx) * 4;
          r += src.data[index];
          g += src.data[index + 1];
          b += src.data[index + 2];
          a += src.data[index + 3];
          n += 1;
        }
      }
      const out = (y * width + x) * 4;
      dst.data[out] = Math.round(r / n);
      dst.data[out + 1] = Math.round(g / n);
      dst.data[out + 2] = Math.round(b / n);
      dst.data[out + 3] = Math.round(a / n);
    }
  }
  return PNG.sync.write(dst);
}

function writeGlb(meshName, parts, materials, images, sampler, skinData = null) {
  const buffer = [];
  const push = (chunk) => {
    const offset = buffer.reduce((sum, part) => sum + part.length, 0);
    buffer.push(chunk);
    return offset;
  };
  const pad4 = (bytes) => {
    const extra = (4 - (bytes.length % 4)) % 4;
    return extra ? Buffer.concat([bytes, Buffer.alloc(extra)]) : bytes;
  };
  const f32 = (values) => {
    const out = Buffer.alloc(values.length * 4);
    for (let i = 0; i < values.length; i += 1) out.writeFloatLE(values[i], i * 4);
    return out;
  };
  const u8 = (values) => {
    const out = Buffer.alloc(values.length);
    for (let i = 0; i < values.length; i += 1) out.writeUInt8(values[i], i);
    return out;
  };
  const accessors = [];
  const bufferViews = [];
  const jsonImages = [];
  const imageBySource = new Map();
  const rememberImage = (sourceIndex) => {
    if (imageBySource.has(sourceIndex)) return imageBySource.get(sourceIndex);
    const image = images[sourceIndex];
    const bytes = pad4(image.packed);
    const view = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: push(bytes), byteLength: image.packed.length });
    const imageIndex = jsonImages.length;
    jsonImages.push({ name: image.name, mimeType: image.mimeType, bufferView: view });
    imageBySource.set(sourceIndex, imageIndex);
    return imageIndex;
  };
  const uniqueTextures = [];
  const textureKey = new Map();
  const packedMaterials = parts.map((part) => {
    const source = materials[part.material];
    const copy = JSON.parse(JSON.stringify(source.material));
    const rewrite = (textureInfo) => {
      if (!textureInfo || textureInfo.index === undefined) return;
      const sourceTexture = source.textures[textureInfo.index];
      const imageIndex = rememberImage(sourceTexture.source);
      const key = `${imageIndex}:${sourceTexture.sampler ?? 0}`;
      if (!textureKey.has(key)) {
        textureKey.set(key, uniqueTextures.length);
        uniqueTextures.push({ sampler: 0, source: imageIndex, name: sourceTexture.name });
      }
      textureInfo.index = textureKey.get(key);
    };
    if (copy.pbrMetallicRoughness) {
      rewrite(copy.pbrMetallicRoughness.baseColorTexture);
      rewrite(copy.pbrMetallicRoughness.metallicRoughnessTexture);
    }
    rewrite(copy.normalTexture);
    rewrite(copy.emissiveTexture);
    rewrite(copy.occlusionTexture);
    if (copy.name === 'MI_ZMike_default') {
      copy.alphaMode = 'OPAQUE';
      delete copy.alphaCutoff;
    }
    return copy;
  });
  const primitives = [];
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = parts[partIndex];
    const flat = (list, width) => {
      const out = new Array(list.length * width);
      list.forEach((value, index) => {
        for (let k = 0; k < width; k += 1) out[index * width + k] = value[k];
      });
      return out;
    };
    const addView = (numbers, target) => {
      const bytes = pad4(f32(numbers));
      const view = bufferViews.length;
      bufferViews.push({
        buffer: 0,
        byteOffset: push(bytes),
        byteLength: numbers.length * 4,
        ...(target ? { target } : {}),
      });
      return view;
    };
    const position = flat(part.positions, 3);
    const normal = flat(part.normals, 3);
    const uv = flat(part.uvs, 2);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    part.positions.forEach((point) => {
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k], point[k]);
        max[k] = Math.max(max[k], point[k]);
      }
    });
    const positionView = addView(position, 34962);
    const normalView = addView(normal, 34962);
    const uvView = addView(uv, 34962);
    const indexBytes = Buffer.alloc(part.indices.length * 2);
    part.indices.forEach((index, i) => indexBytes.writeUInt16LE(index, i * 2));
    const paddedIndices = pad4(indexBytes);
    const indexView = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: push(paddedIndices),
      byteLength: indexBytes.length,
      target: 34963,
    });
    const positionAccessor = accessors.length;
    accessors.push({
      bufferView: positionView,
      componentType: 5126,
      count: part.positions.length,
      type: 'VEC3',
      min,
      max,
    });
    const normalAccessor = accessors.length;
    accessors.push({
      bufferView: normalView,
      componentType: 5126,
      count: part.normals.length,
      type: 'VEC3',
    });
    const uvAccessor = accessors.length;
    accessors.push({
      bufferView: uvView,
      componentType: 5126,
      count: part.uvs.length,
      type: 'VEC2',
    });
    const attributes = {
      POSITION: positionAccessor,
      NORMAL: normalAccessor,
      TEXCOORD_0: uvAccessor,
    };
    if (skinData && part.joints && part.weights) {
      const jointFlat = flat(part.joints, 4);
      const jointRaw = u8(jointFlat);
      const jointView = bufferViews.length;
      bufferViews.push({
        buffer: 0,
        byteOffset: push(pad4(jointRaw)),
        byteLength: jointRaw.length,
        target: 34962,
      });
      const jointAccessor = accessors.length;
      accessors.push({
        bufferView: jointView,
        componentType: 5121,
        count: part.joints.length,
        type: 'VEC4',
      });
      const weightView = addView(flat(part.weights, 4), 34962);
      const weightAccessor = accessors.length;
      accessors.push({
        bufferView: weightView,
        componentType: 5126,
        count: part.weights.length,
        type: 'VEC4',
      });
      attributes.JOINTS_0 = jointAccessor;
      attributes.WEIGHTS_0 = weightAccessor;
    }
    const indexAccessor = accessors.length;
    accessors.push({
      bufferView: indexView,
      componentType: 5123,
      count: part.indices.length,
      type: 'SCALAR',
    });
    primitives.push({
      attributes,
      indices: indexAccessor,
      material: partIndex,
      mode: 4,
    });
  }
  const addRawFloatAccessor = (numbers, type, count, includeBounds = false) => {
    const raw = f32(numbers);
    const view = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: push(pad4(raw)), byteLength: raw.length });
    const acc = { bufferView: view, componentType: 5126, count, type };
    if (includeBounds && type === 'SCALAR') {
      acc.min = [Math.min(...numbers)];
      acc.max = [Math.max(...numbers)];
    }
    const idx = accessors.length;
    accessors.push(acc);
    return idx;
  };
  let nodes = [{ name: meshName, mesh: 0 }];
  let sceneNodes = [0];
  let skins;
  let animations;
  if (skinData) {
    const meshNodeIndex = skinData.jointNodes.length;
    nodes = [...skinData.jointNodes, { name: meshName, mesh: 0, skin: 0 }];
    sceneNodes = [0, meshNodeIndex];
    const ibmAccessor = addRawFloatAccessor(
      skinData.inverseBindMatrices.flatMap((m) => Array.from(m)),
      'MAT4',
      skinData.jointNodes.length
    );
    skins = [
      {
        name: 'SKM_MegaMikeZ_Body',
        skeleton: 0,
        joints: skinData.jointNodes.map((_, i) => i),
        inverseBindMatrices: ibmAccessor,
      },
    ];
    animations = skinData.animations.map((clip) => {
      const timeAccessor = addRawFloatAccessor(clip.times, 'SCALAR', clip.times.length, true);
      const samplers = [];
      const channels = [];
      for (const track of clip.tracks) {
        for (const [pathName, type, values] of [
          ['translation', 'VEC3', track.translations],
          ['rotation', 'VEC4', track.rotations],
          ['scale', 'VEC3', track.scales],
        ]) {
          const outAccessor = addRawFloatAccessor(values.flat(), type, values.length);
          const samplerIdx = samplers.length;
          samplers.push({ input: timeAccessor, interpolation: 'LINEAR', output: outAccessor });
          channels.push({ sampler: samplerIdx, target: { node: track.node, path: pathName } });
        }
      }
      return { name: clip.name, samplers, channels };
    });
  }
  const bin = Buffer.concat(buffer);
  const json = {
    asset: { version: '2.0', generator: 'scripts/quest-first-person-extract.cjs' },
    scene: 0,
    scenes: [{ nodes: sceneNodes }],
    nodes,
    meshes: [{ name: meshName, primitives }],
    ...(skins ? { skins } : {}),
    ...(animations ? { animations } : {}),
    materials: packedMaterials,
    textures: uniqueTextures,
    images: jsonImages,
    samplers: [sampler],
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  if (skinData) {
    const usedExtensions = new Set();
    for (const material of packedMaterials) {
      if (!material.extensions) continue;
      for (const key of Object.keys(material.extensions)) usedExtensions.add(key);
    }
    if (usedExtensions.size > 0) json.extensionsUsed = [...usedExtensions];
  } else if (packedMaterials.some((material) => material.extensions)) {
    json.extensionsUsed = ['KHR_materials_emissive_strength'];
  }
  let jsonChunk = Buffer.from(JSON.stringify(json));
  const jsonPad = (4 - (jsonChunk.length % 4)) % 4;
  if (jsonPad) jsonChunk = Buffer.concat([jsonChunk, Buffer.alloc(jsonPad, 0x20)]);
  const total = 12 + 8 + jsonChunk.length + 8 + bin.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, bin]);
}

function imageLibrary(gltf, edge = TEXTURE_EDGE) {
  return gltf.json.images.map((image, index) => {
    const view = gltf.json.bufferViews[image.bufferView];
    const start = view.byteOffset || 0;
    const bytes = Buffer.from(gltf.binary.subarray(start, start + view.byteLength));
    return {
      index,
      name: image.name,
      mimeType: image.mimeType,
      bytes,
      packed: downsamplePng(bytes, edge),
    };
  });
}

function assertDerivativeAlpha(library) {
  for (const entry of library.materials) {
    if (entry.material.name !== 'MI_ZMike_default') continue;
    const texture = entry.material.pbrMetallicRoughness?.baseColorTexture;
    if (!texture) throw new Error('MI_ZMike_default has no base color texture');
    const sourceIndex = entry.textures[texture.index].source;
    const png = PNG.sync.read(library.images[sourceIndex].packed);
    let min = 255;
    for (let i = 3; i < png.data.length; i += 4) min = Math.min(min, png.data[i]);
    if (min < 250) throw new Error(`MI_ZMike_default alpha ${min} is below 250`);
    return min;
  }
  throw new Error('MI_ZMike_default is missing');
}

function materialLibrary(gltf, edge = TEXTURE_EDGE) {
  const images = imageLibrary(gltf, edge);
  return {
    images,
    materials: gltf.json.materials.map((material) => ({
      material,
      textures: gltf.json.textures,
    })),
    sampler: gltf.json.samplers[0],
  };
}

function mean(points) {
  const acc = [0, 0, 0];
  for (const point of points) {
    acc[0] += point[0];
    acc[1] += point[1];
    acc[2] += point[2];
  }
  return scale(acc, 1 / points.length);
}

function round(value) {
  return Math.round(value * 1e9) / 1e9;
}

function round3(point) {
  return point.map(round);
}

function armReport(outputs, side, arm, sha) {
  const upper = outputs[side === 'left' ? 'upperLeft' : 'upperRight'];
  const forearm = outputs[side === 'left' ? 'forearmLeft' : 'forearmRight'];
  const hand = outputs[side === 'left' ? 'handLeft' : 'handRight'];
  return {
    shoulder: round3([
      arm.shoulder[0],
      arm.shoulder[1],
      arm.shoulder[2] + BODY_FORWARD_SHIFT_MODEL,
    ]),
    elbow: round3(arm.elbow),
    wrist: round3(arm.wrist),
    upperLength: round(arm.upperLength),
    forearmLength: round(arm.forearmLength),
    aimOffsetToFist: round3(arm.aimOffsetToFist),
    palmCenter: round3(arm.palmCenter),
    fistBounds: { min: round3(arm.fistBounds.min), max: round3(arm.fistBounds.max) },
    upper: {
      file: upper.file,
      bytes: upper.bytes.length,
      sha256: sha(upper.bytes),
      triangles: arm.upperTriangles,
    },
    forearm: {
      file: forearm.file,
      bytes: forearm.bytes.length,
      sha256: sha(forearm.bytes),
      triangles: arm.forearmTriangles,
    },
    hand: {
      file: hand.file,
      bytes: hand.bytes.length,
      sha256: sha(hand.bytes),
      triangles: arm.fistTriangles,
    },
  };
}

function worldToLocalTrs(parentWorld, targetWorld) {
  const invParentRot = quatConj(parentWorld.r);
  return {
    t: rotateQuatVec(invParentRot, sub(targetWorld.t, parentWorld.t)),
    r: quatNorm(quatMul(invParentRot, targetWorld.r)),
    s: [1, 1, 1],
  };
}

function composeTrs(parentWorld, local) {
  return {
    t: add(parentWorld.t, rotateQuatVec(parentWorld.r, local.t)),
    r: quatNorm(quatMul(parentWorld.r, local.r)),
  };
}

function buildAnimatedBodySkin(blue, bodyParts) {
  const skin = blue.json.skins[0];
  const srcJointNames = skin.joints.map((ni) => blue.json.nodes[ni].name);
  const srcJointToSkinIdx = new Map(srcJointNames.map((name, idx) => [name, idx]));
  const srcJointToNodeIdx = new Map(srcJointNames.map((name, idx) => [name, skin.joints[idx]]));
  const bodyJointIndex = new Map(BODY_JOINT_NAMES.map((name, idx) => [name, idx]));

  // Remap vertex JOINTS_0/WEIGHTS_0 from 86-joint source skin to 20-joint body skin.
  for (const part of bodyParts) {
    for (let i = 0; i < part.joints.length; i += 1) {
      const j = part.joints[i];
      const w = part.weights[i];
      const remappedJ = [0, 0, 0, 0];
      const remappedW = [0, 0, 0, 0];
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        if (w[k] <= 0) continue;
        const name = srcJointNames[j[k]];
        const mapped = bodyJointIndex.get(name);
        if (mapped === undefined) {
          throw new Error(`Kept body vertex references dropped joint ${name} (weight=${w[k]})`);
        }
        remappedJ[k] = mapped;
        remappedW[k] = w[k];
        sum += w[k];
      }
      if (sum <= 0) {
        remappedW[0] = 1;
      } else {
        for (let k = 0; k < 4; k += 1) remappedW[k] /= sum;
      }
      part.joints[i] = remappedJ;
      part.weights[i] = remappedW;
    }
  }

  // Build shifted inverse bind matrices: IBM' = IBM * Translate(0, 0, -BODY_FORWARD_SHIFT_MODEL).
  const srcIbm = readElements(blue, skin.inverseBindMatrices);
  const invShift = translation(0, 0, -BODY_FORWARD_SHIFT_MODEL);
  const inverseBindMatrices = BODY_JOINT_NAMES.map((name) => {
    const srcIdx = srcJointToSkinIdx.get(name);
    if (srcIdx === undefined) throw new Error(`Missing source skin joint ${name}`);
    return multiply(new Float64Array(srcIbm[srcIdx]), invShift);
  });

  // Build 20-joint node hierarchy rooted at SK_ZMike with BODY_FORWARD_SHIFT_MODEL.
  const srcParent = new Map();
  blue.json.nodes.forEach((node, ni) => {
    for (const child of node.children || []) srcParent.set(child, ni);
  });
  const jointNodes = BODY_JOINT_NAMES.map((name, idx) => {
    const srcNodeIdx = srcJointToNodeIdx.get(name);
    const srcNode = blue.json.nodes[srcNodeIdx];
    const t =
      idx === 0
        ? [0, 0, BODY_FORWARD_SHIFT_MODEL]
        : srcNode.translation
          ? [...srcNode.translation]
          : [0, 0, 0];
    const r = srcNode.rotation ? quatNorm(srcNode.rotation) : [0, 0, 0, 1];
    const children = (srcNode.children || [])
      .map((ci) => bodyJointIndex.get(blue.json.nodes[ci]?.name))
      .filter((childIdx) => childIdx !== undefined);
    return {
      name,
      translation: t,
      rotation: r,
      scale: [1, 1, 1],
      ...(children.length > 0 ? { children } : {}),
    };
  });

  const parentOfBodyJoint = new Array(jointNodes.length).fill(-1);
  jointNodes.forEach((node, idx) => {
    for (const child of node.children || []) parentOfBodyJoint[child] = idx;
  });

  const restWorlds = new Array(jointNodes.length);
  for (let i = 0; i < jointNodes.length; i += 1) {
    const local = { t: jointNodes[i].translation, r: jointNodes[i].rotation };
    restWorlds[i] =
      parentOfBodyJoint[i] < 0 ? local : composeTrs(restWorlds[parentOfBodyJoint[i]], local);
  }

  const readClipChannelMap = (clipName) => {
    const anim = (blue.json.animations || []).find((entry) => entry.name === clipName);
    if (!anim) throw new Error(`Missing animation clip ${clipName}`);
    let times = null;
    const byNode = new Map();
    for (const ch of anim.channels) {
      const nodeName = blue.json.nodes[ch.target?.node]?.name;
      const bodyIdx = bodyJointIndex.get(nodeName);
      if (bodyIdx === undefined) continue;
      const sampler = anim.samplers[ch.sampler];
      const chTimes = readElements(blue, sampler.input);
      const chValues = readElements(blue, sampler.output);
      if (!times) times = chTimes;
      else if (times.length !== chTimes.length) {
        throw new Error(`Non-uniform keyframe count in ${clipName} for ${nodeName}`);
      }
      if (!byNode.has(bodyIdx)) byNode.set(bodyIdx, {});
      byNode.get(bodyIdx)[ch.target.path] = chValues;
    }
    return { times, byNode };
  };

  const pelvisIdx = bodyJointIndex.get('pelvis');
  const rootIdx = bodyJointIndex.get('root');
  const spine1Idx = bodyJointIndex.get('spine_01');
  const spine2Idx = bodyJointIndex.get('spine_02');
  const spine3Idx = bodyJointIndex.get('spine_03');
  const leftShoulderIdx = bodyJointIndex.get('upperarm_l');
  const rightShoulderIdx = bodyJointIndex.get('upperarm_r');
  const thighLIdx = bodyJointIndex.get('thigh_l');
  const calfLIdx = bodyJointIndex.get('calf_l');
  const footLIdx = bodyJointIndex.get('foot_l');
  const ballLIdx = bodyJointIndex.get('ball_l');
  const thighRIdx = bodyJointIndex.get('thigh_r');
  const calfRIdx = bodyJointIndex.get('calf_r');
  const footRIdx = bodyJointIndex.get('foot_r');
  const ballRIdx = bodyJointIndex.get('ball_r');
  const legChainJoints = [
    thighLIdx,
    calfLIdx,
    footLIdx,
    ballLIdx,
    thighRIdx,
    calfRIdx,
    footRIdx,
    ballRIdx,
  ];
  const leftLegJointSet = new Set([thighLIdx, calfLIdx, footLIdx, ballLIdx]);
  const rightLegJointSet = new Set([thighRIdx, calfRIdx, footRIdx, ballRIdx]);
  const fixedUpperJoints = new Set(
    ['neck_01', 'clavicle_l', 'upperarm_l', 'clavicle_r', 'upperarm_r', 'PropBack'].map((n) =>
      bodyJointIndex.get(n)
    )
  );
  const thighJoints = new Set([thighLIdx, thighRIdx]);
  const FLOOR_MODEL_Y = -0.00106792559;

  // Build IdleAggro frame-0 reference pose for non-crossing boxing side-shuffles.
  const idleClip = readClipChannelMap('IdleAggro');
  const idleRefLocal = jointNodes.map((_, idx) => {
    if (idx === 0) {
      return {
        t: [...jointNodes[0].translation],
        r: [...jointNodes[0].rotation],
        s: [1, 1, 1],
      };
    }
    const ch = idleClip.byNode.get(idx);
    return {
      t: ch?.translation?.[0] ? [...ch.translation[0]] : [...jointNodes[idx].translation],
      r: ch?.rotation?.[0] ? quatNorm(ch.rotation[0]) : [...jointNodes[idx].rotation],
      s: [1, 1, 1],
    };
  });
  const idleRefWorld = new Array(jointNodes.length);
  for (let i = 0; i < jointNodes.length; i += 1) {
    idleRefWorld[i] =
      parentOfBodyJoint[i] < 0
        ? { t: idleRefLocal[i].t, r: idleRefLocal[i].r }
        : composeTrs(idleRefWorld[parentOfBodyJoint[i]], idleRefLocal[i]);
  }

  let maxShoulderDriftModel = 0;
  let maxAnimatedY = -Infinity;
  let minAnimatedY = Infinity;
  let maxLegOverlapVol = 0;

  const computeSkinnedExtents = (frameWorld) => {
    const jointMats = frameWorld.map((w, jIdx) => {
      const wm = multiply(
        translation(w.t[0], w.t[1], w.t[2]),
        rotation(w.r[0], w.r[1], w.r[2], w.r[3])
      );
      return multiply(wm, inverseBindMatrices[jIdx]);
    });
    let frameMinY = Infinity;
    let frameMaxY = -Infinity;
    const lBox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const rBox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const part of bodyParts) {
      for (let vi = 0; vi < part.positions.length; vi += 1) {
        const p = part.positions[vi];
        const j = part.joints[vi];
        const wt = part.weights[vi];
        let lw = 0;
        let rw = 0;
        let x = 0;
        let y = 0;
        let z = 0;
        for (let k = 0; k < 4; k += 1) {
          if (wt[k] === 0) continue;
          if (leftLegJointSet.has(j[k])) lw += wt[k];
          if (rightLegJointSet.has(j[k])) rw += wt[k];
          const m = jointMats[j[k]];
          x += (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) * wt[k];
          y += (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) * wt[k];
          z += (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) * wt[k];
        }
        if (y < frameMinY) frameMinY = y;
        if (y > frameMaxY) frameMaxY = y;
        if (lw >= 0.9 || rw >= 0.9) {
          const box = lw >= 0.9 ? lBox : rBox;
          if (x < box[0]) box[0] = x;
          if (y < box[1]) box[1] = y;
          if (z < box[2]) box[2] = z;
          if (x > box[3]) box[3] = x;
          if (y > box[4]) box[4] = y;
          if (z > box[5]) box[5] = z;
        }
      }
    }
    const ox = Math.max(0, Math.min(lBox[3], rBox[3]) - Math.max(lBox[0], rBox[0]));
    const oy = Math.max(0, Math.min(lBox[4], rBox[4]) - Math.max(lBox[1], rBox[1]));
    const oz = Math.max(0, Math.min(lBox[5], rBox[5]) - Math.max(lBox[2], rBox[2]));
    return { frameMinY, frameMaxY, legOverlapVol: ox * oy * oz };
  };

  const buildProceduralStrafeClip = (dirSign) => {
    // dirSign = +1 for StrafeLeft (+X), -1 for StrafeRight (-X).
    // Non-crossing boxing shuffle starting & ending at IdleAggro stance so legs never intersect.
    const frames = 25;
    const duration = 0.8;
    const times = Array.from({ length: frames }, (_, f) => (f / (frames - 1)) * duration);
    const tracks = BODY_JOINT_NAMES.map((_, idx) => ({
      node: idx,
      translations: new Array(frames),
      rotations: new Array(frames),
      scales: new Array(frames),
    }));

    const windowBell = (u, a, b) => {
      if (u <= a || u >= b) return 0;
      return Math.sin(((u - a) / (b - a)) * Math.PI);
    };

    for (let f = 0; f < frames; f += 1) {
      const u = f / (frames - 1);
      const frameLocal = new Array(jointNodes.length);
      const frameWorld = new Array(jointNodes.length);

      frameLocal[0] = {
        t: [...jointNodes[0].translation],
        r: [...jointNodes[0].rotation],
        s: [1, 1, 1],
      };
      frameWorld[0] = { t: frameLocal[0].t, r: frameLocal[0].r };
      frameLocal[rootIdx] = {
        ...idleRefLocal[rootIdx],
        t: [...idleRefLocal[rootIdx].t],
        r: [...idleRefLocal[rootIdx].r],
      };
      frameWorld[rootIdx] = composeTrs(frameWorld[0], frameLocal[rootIdx]);

      // Smooth damped pelvis lateral weight shift without vertical bounce or Z drift.
      const restPelvisWorld = restWorlds[pelvisIdx];
      const basePelvisWorld = idleRefWorld[pelvisIdx];
      const swayX = dirSign * 0.024 * Math.sin(u * Math.PI);
      const pelvisWorld = {
        t: [basePelvisWorld.t[0] + swayX, basePelvisWorld.t[1], basePelvisWorld.t[2]],
        r: quatNorm(slerpQuat(restPelvisWorld.r, basePelvisWorld.r, 0.4)),
      };
      frameWorld[pelvisIdx] = pelvisWorld;
      frameLocal[pelvisIdx] = worldToLocalTrs(frameWorld[rootIdx], pelvisWorld);

      const bridgeSpine = () => {
        const spine3World = restWorlds[spine3Idx];
        const spine1World = {
          t: lerpVec(frameWorld[pelvisIdx].t, spine3World.t, 0.342),
          r: quatNorm(slerpQuat(frameWorld[pelvisIdx].r, spine3World.r, 0.35)),
        };
        const spine2World = {
          t: lerpVec(frameWorld[pelvisIdx].t, spine3World.t, 0.505),
          r: quatNorm(slerpQuat(frameWorld[pelvisIdx].r, spine3World.r, 0.7)),
        };
        frameWorld[spine1Idx] = spine1World;
        frameLocal[spine1Idx] = worldToLocalTrs(frameWorld[pelvisIdx], spine1World);
        frameWorld[spine2Idx] = spine2World;
        frameLocal[spine2Idx] = worldToLocalTrs(spine1World, spine2World);
        frameWorld[spine3Idx] = spine3World;
        frameLocal[spine3Idx] = worldToLocalTrs(spine2World, spine3World);
      };
      bridgeSpine();

      for (const idx of fixedUpperJoints) {
        frameLocal[idx] = {
          t: [...jointNodes[idx].translation],
          r: [...jointNodes[idx].rotation],
          s: [1, 1, 1],
        };
        frameWorld[idx] = composeTrs(frameWorld[parentOfBodyJoint[idx]], frameLocal[idx]);
      }

      // Lead foot steps outward first (0..0.55), trail foot closes partway without crossing midline (0.40..0.95).
      const leadLift = windowBell(u, 0.0, 0.55);
      const trailLift = windowBell(u, 0.4, 0.95);
      const leftLift = dirSign > 0 ? leadLift : trailLift;
      const rightLift = dirSign > 0 ? trailLift : leadLift;
      const leftOutDeg = dirSign * (dirSign > 0 ? 14 * leadLift : 10 * trailLift);
      const rightOutDeg = dirSign * (dirSign > 0 ? 10 * trailLift : 14 * leadLift);

      const applyLeg = (thighIdx, calfIdx, footIdx, ballIdx, lift, abductZDeg) => {
        const srcThighWorld = composeTrs(idleRefWorld[pelvisIdx], idleRefLocal[thighIdx]);
        const thighSwing = quatMul(
          quatAxisAngle([0, 0, 1], abductZDeg),
          quatAxisAngle([1, 0, 0], -14 * lift)
        );
        const thighWorldRot = quatNorm(quatMul(thighSwing, srcThighWorld.r));
        frameLocal[thighIdx] = {
          t: [...idleRefLocal[thighIdx].t],
          r: worldToLocalTrs(frameWorld[pelvisIdx], { t: [0, 0, 0], r: thighWorldRot }).r,
          s: [1, 1, 1],
        };
        frameWorld[thighIdx] = composeTrs(frameWorld[pelvisIdx], frameLocal[thighIdx]);

        const calfBase = idleRefLocal[calfIdx];
        frameLocal[calfIdx] = {
          t: [...calfBase.t],
          r: quatNorm(quatMul(calfBase.r, quatAxisAngle([1, 0, 0], 24 * lift))),
          s: [1, 1, 1],
        };
        frameWorld[calfIdx] = composeTrs(frameWorld[thighIdx], frameLocal[calfIdx]);

        const footBase = idleRefLocal[footIdx];
        frameLocal[footIdx] = {
          t: [...footBase.t],
          r: quatNorm(quatMul(footBase.r, quatAxisAngle([1, 0, 0], -10 * lift))),
          s: [1, 1, 1],
        };
        frameWorld[footIdx] = composeTrs(frameWorld[calfIdx], frameLocal[footIdx]);

        frameLocal[ballIdx] = {
          t: [...idleRefLocal[ballIdx].t],
          r: [...idleRefLocal[ballIdx].r],
          s: [1, 1, 1],
        };
        frameWorld[ballIdx] = composeTrs(frameWorld[footIdx], frameLocal[ballIdx]);
      };

      applyLeg(thighLIdx, calfLIdx, footLIdx, ballLIdx, leftLift, leftOutDeg);
      applyLeg(thighRIdx, calfRIdx, footRIdx, ballRIdx, rightLift, rightOutDeg);

      let ext = computeSkinnedExtents(frameWorld);
      if (ext.frameMinY < FLOOR_MODEL_Y) {
        const liftY = FLOOR_MODEL_Y - ext.frameMinY;
        frameWorld[pelvisIdx] = {
          t: [
            frameWorld[pelvisIdx].t[0],
            frameWorld[pelvisIdx].t[1] + liftY,
            frameWorld[pelvisIdx].t[2],
          ],
          r: frameWorld[pelvisIdx].r,
        };
        frameLocal[pelvisIdx] = worldToLocalTrs(frameWorld[rootIdx], frameWorld[pelvisIdx]);
        bridgeSpine();
        for (const legIdx of legChainJoints) {
          frameWorld[legIdx] = composeTrs(
            frameWorld[parentOfBodyJoint[legIdx]],
            frameLocal[legIdx]
          );
        }
        ext = computeSkinnedExtents(frameWorld);
      }

      if (ext.frameMaxY > maxAnimatedY) maxAnimatedY = ext.frameMaxY;
      if (ext.frameMinY < minAnimatedY) minAnimatedY = ext.frameMinY;
      if (ext.legOverlapVol > maxLegOverlapVol) maxLegOverlapVol = ext.legOverlapVol;

      for (const sIdx of [leftShoulderIdx, rightShoulderIdx]) {
        const diff = sub(frameWorld[sIdx].t, restWorlds[sIdx].t);
        const drift = Math.hypot(diff[0], diff[1], diff[2]);
        if (drift > maxShoulderDriftModel) maxShoulderDriftModel = drift;
      }

      for (let i = 0; i < jointNodes.length; i += 1) {
        tracks[i].translations[f] = frameLocal[i].t;
        tracks[i].rotations[f] = frameLocal[i].r;
        tracks[i].scales[f] = frameLocal[i].s;
      }
    }

    return {
      name: dirSign > 0 ? 'StrafeLeft' : 'StrafeRight',
      duration: round(duration),
      frames,
      times,
      tracks,
    };
  };

  const animations = BODY_CLIPS.map((clipName) => {
    if (clipName === 'StrafeLeft') return buildProceduralStrafeClip(1);
    if (clipName === 'StrafeRight') return buildProceduralStrafeClip(-1);
    const { times, byNode } = readClipChannelMap(clipName);
    const frameCount = times.length;
    const tracks = BODY_JOINT_NAMES.map((_, idx) => ({
      node: idx,
      translations: new Array(frameCount),
      rotations: new Array(frameCount),
      scales: new Array(frameCount),
    }));

    for (let f = 0; f < frameCount; f += 1) {
      const frameLocal = new Array(jointNodes.length);
      const frameWorld = new Array(jointNodes.length);

      const srcTrs = (idx) => {
        const ch = byNode.get(idx);
        return {
          t: ch?.translation?.[f] ? [...ch.translation[f]] : [...jointNodes[idx].translation],
          r: ch?.rotation?.[f] ? quatNorm(ch.rotation[f]) : [...jointNodes[idx].rotation],
          s: [1, 1, 1],
        };
      };

      // 0: SK_ZMike (fixed shifted root), 1: root (source)
      frameLocal[0] = {
        t: [...jointNodes[0].translation],
        r: [...jointNodes[0].rotation],
        s: [1, 1, 1],
      };
      frameWorld[0] = { t: frameLocal[0].t, r: frameLocal[0].r };
      frameLocal[rootIdx] = srcTrs(rootIdx);
      frameWorld[rootIdx] = composeTrs(frameWorld[0], frameLocal[rootIdx]);

      // 2: pelvis (animated Y/X with bounded Z lean and damped upright rotation)
      const srcPelvisLocal = srcTrs(pelvisIdx);
      const srcPelvisWorld = composeTrs(frameWorld[rootIdx], srcPelvisLocal);
      const restPelvisWorld = restWorlds[pelvisIdx];
      const clampedDz = Math.max(
        -0.025,
        Math.min(0.04, srcPelvisWorld.t[2] - restPelvisWorld.t[2])
      );
      const pelvisWorld = {
        t: [srcPelvisWorld.t[0], srcPelvisWorld.t[1], restPelvisWorld.t[2] + clampedDz],
        r: quatNorm(slerpQuat(restPelvisWorld.r, srcPelvisWorld.r, 0.4)),
      };
      frameWorld[pelvisIdx] = pelvisWorld;
      frameLocal[pelvisIdx] = worldToLocalTrs(frameWorld[rootIdx], pelvisWorld);

      // Spine bridges animated pelvis to shoulder-locked upright chest (spine_03).
      const bridgeSpine = () => {
        const spine3World = restWorlds[spine3Idx];
        const spine1World = {
          t: lerpVec(frameWorld[pelvisIdx].t, spine3World.t, 0.342),
          r: quatNorm(slerpQuat(frameWorld[pelvisIdx].r, spine3World.r, 0.35)),
        };
        const spine2World = {
          t: lerpVec(frameWorld[pelvisIdx].t, spine3World.t, 0.505),
          r: quatNorm(slerpQuat(frameWorld[pelvisIdx].r, spine3World.r, 0.7)),
        };
        frameWorld[spine1Idx] = spine1World;
        frameLocal[spine1Idx] = worldToLocalTrs(frameWorld[pelvisIdx], spine1World);
        frameWorld[spine2Idx] = spine2World;
        frameLocal[spine2Idx] = worldToLocalTrs(spine1World, spine2World);
        frameWorld[spine3Idx] = spine3World;
        frameLocal[spine3Idx] = worldToLocalTrs(spine2World, spine3World);
      };
      bridgeSpine();

      // Remaining joints: upper-body/shoulders stay at rest local; thighs compensate pelvis damping so legs keep source world orientation without hip detachment.
      for (let i = 0; i < jointNodes.length; i += 1) {
        if (frameLocal[i]) continue;
        if (fixedUpperJoints.has(i)) {
          frameLocal[i] = {
            t: [...jointNodes[i].translation],
            r: [...jointNodes[i].rotation],
            s: [1, 1, 1],
          };
        } else if (thighJoints.has(i)) {
          const srcThighLocal = srcTrs(i);
          const srcThighWorld = composeTrs(srcPelvisWorld, srcThighLocal);
          frameLocal[i] = {
            t: srcThighLocal.t,
            r: worldToLocalTrs(pelvisWorld, srcThighWorld).r,
            s: [1, 1, 1],
          };
        } else {
          frameLocal[i] = srcTrs(i);
        }
        frameWorld[i] = composeTrs(frameWorld[parentOfBodyJoint[i]], frameLocal[i]);
      }

      // Per-frame floor-contact compensation: keep lowest foot/ball vertex flush on ring floor without shifting locked shoulders.
      let ext = computeSkinnedExtents(frameWorld);
      if (ext.frameMinY < FLOOR_MODEL_Y) {
        const liftY = FLOOR_MODEL_Y - ext.frameMinY;
        frameWorld[pelvisIdx] = {
          t: [
            frameWorld[pelvisIdx].t[0],
            frameWorld[pelvisIdx].t[1] + liftY,
            frameWorld[pelvisIdx].t[2],
          ],
          r: frameWorld[pelvisIdx].r,
        };
        frameLocal[pelvisIdx] = worldToLocalTrs(frameWorld[rootIdx], frameWorld[pelvisIdx]);
        bridgeSpine();
        for (const legIdx of legChainJoints) {
          frameWorld[legIdx] = composeTrs(
            frameWorld[parentOfBodyJoint[legIdx]],
            frameLocal[legIdx]
          );
        }
        ext = computeSkinnedExtents(frameWorld);
      }

      // Verify exact shoulder lock and skin bounds on every frame of every clip.
      for (const sIdx of [leftShoulderIdx, rightShoulderIdx]) {
        const diff = sub(frameWorld[sIdx].t, restWorlds[sIdx].t);
        const drift = Math.hypot(diff[0], diff[1], diff[2]);
        if (drift > maxShoulderDriftModel) maxShoulderDriftModel = drift;
        if (drift > 1e-5) {
          throw new Error(
            `${clipName} frame ${f} joint ${BODY_JOINT_NAMES[sIdx]} drifted ${drift}`
          );
        }
      }
      if (ext.frameMaxY > maxAnimatedY) maxAnimatedY = ext.frameMaxY;
      if (ext.frameMinY < minAnimatedY) minAnimatedY = ext.frameMinY;
      if (ext.legOverlapVol > maxLegOverlapVol) maxLegOverlapVol = ext.legOverlapVol;

      for (let i = 0; i < jointNodes.length; i += 1) {
        tracks[i].translations[f] = frameLocal[i].t;
        tracks[i].rotations[f] = frameLocal[i].r;
        tracks[i].scales[f] = frameLocal[i].s;
      }
    }

    return {
      name: clipName,
      duration: round(times[times.length - 1]),
      frames: frameCount,
      times,
      tracks,
    };
  });

  if (maxAnimatedY >= 1.02) {
    throw new Error(`Animated body reaches head band at Y ${maxAnimatedY}`);
  }
  if (minAnimatedY < -0.005 || minAnimatedY > 0.02) {
    throw new Error(`Animated body leaves floor bounds: minY=${minAnimatedY}`);
  }
  if (maxLegOverlapVol > 1e-7) {
    throw new Error(`Animated body legs overlap across midline: vol=${maxLegOverlapVol}`);
  }

  return {
    jointNodes,
    inverseBindMatrices,
    animations,
    summary: {
      animated: true,
      joints: BODY_JOINT_NAMES.length,
      clips: animations.map((a) => ({
        name: a.name,
        durationSeconds: a.duration,
        frames: a.frames,
      })),
      maxShoulderDriftModel: round(maxShoulderDriftModel),
      maxAnimatedY: round(maxAnimatedY),
      minAnimatedY: round(minAnimatedY),
      maxLegOverlapVol: round(maxLegOverlapVol),
    },
  };
}

function main() {
  const { outDir } = parseArgs(process.argv);
  const bluePath = path.join(SOURCE_DIR, BLUE);
  const redPath = path.join(SOURCE_DIR, RED);
  const blueBefore = fs.readFileSync(bluePath);
  const redBefore = fs.readFileSync(redPath);
  const blue = readGlb(bluePath);
  const red = readGlb(redPath);
  const blueNames = blue.json.skins[0].joints.map((index) => blue.json.nodes[index].name);
  const redNames = red.json.skins[0].joints.map((index) => red.json.nodes[index].name);
  if (blueNames.join('\n') !== redNames.join('\n')) {
    throw new Error('Blue and red Combat skins do not name the same joints');
  }
  const worlds = nodeWorlds(blue.json.nodes);
  const curledNodes = withCurledFingers(blue);
  const curledWorlds = nodeWorlds(curledNodes);
  const skinned = skinGeometry(blue, worlds);
  const curled = skinGeometry(blue, curledWorlds);
  const tips = {};
  for (const suffix of ['l', 'r']) {
    for (const digit of ['index', 'pinky', 'thumb']) {
      const chain = [
        `hand_${suffix}`,
        `${digit}_01_${suffix}`,
        `${digit}_02_${suffix}`,
        `${digit}_03_${suffix}`,
      ];
      const tip = fingerTip(curledNodes, chain);
      tips[`${digit}_${suffix}`] = {
        distance: round(tip.distance),
        position: round3(tip.position),
      };
      if (tip.distance > 0.185) {
        throw new Error(`${digit}_${suffix} curl stops at ${tip.distance}, above 0.185`);
      }
    }
  }
  const jointPosition = (name) => {
    const index = blue.json.nodes.findIndex((node) => node.name === name);
    if (index < 0) throw new Error(`Missing joint ${name}`);
    return transformPoint(worlds[index], [0, 0, 0]);
  };
  const library = materialLibrary(blue, TEXTURE_EDGE);
  const armLibrary = materialLibrary(blue, ARM_TEXTURE_EDGE);
  const alphaMin = assertDerivativeAlpha(library);
  const keepBodyVertex = (primitive) => (index) => {
    const name = skinned.jointNames[primitive.dominant[index]];
    const point = primitive.positions[index];
    if (isHeadJoint(name)) return false;
    if (/^(lowerarm_|hand_|index_|pinky_|thumb_)/.test(name)) return false;
    if (name === 'Prop_L' || name === 'Prop_R' || name === 'Buster_L' || name === 'Buster_R') {
      return false;
    }
    if (/^upperarm_/.test(name)) {
      const side = sideOf(name);
      return (
        projectionT(point, jointPosition(`upperarm_${side}`), jointPosition(`lowerarm_${side}`)) <
        SHOULDER_CAP_T
      );
    }
    return true;
  };
  const bodyParts = [];
  const removed = { head: new Set(), arms: new Set(), eyes: 0 };
  for (const mesh of skinned.meshes) {
    if (mesh.name === 'SKM_MegaMikeZ_part_1') {
      removed.eyes += mesh.primitives.reduce(
        (sum, primitive) => sum + primitive.indices.length / 3,
        0
      );
      continue;
    }
    for (const primitive of mesh.primitives) {
      const selected = selectTriangles(primitive, keepBodyVertex(primitive), true);
      if (selected.indices.length === 0) continue;
      bodyParts.push(selected);
    }
  }
  for (const name of skinned.jointNames) {
    if (isHeadJoint(name)) removed.head.add(name);
    else if (
      /^(upperarm_|lowerarm_|hand_|index_|pinky_|thumb_)/.test(name) ||
      name === 'Prop_L' ||
      name === 'Prop_R' ||
      name === 'Buster_L' ||
      name === 'Buster_R'
    ) {
      removed.arms.add(name);
    }
  }
  if (bodyParts.length === 0) throw new Error('Body extract is empty');
  capPartsTogether(bodyParts);
  for (const part of bodyParts) {
    part.positions = part.positions.map((point) => [
      point[0],
      point[1],
      point[2] + BODY_FORWARD_SHIFT_MODEL,
    ]);
  }
  const bodyPoints = bodyParts.flatMap((part) => part.positions);
  const bodyBounds = boundsOf(bodyPoints);
  if (bodyBounds.max[1] >= 1.02) {
    throw new Error(`Body still reaches the head band at Y ${bodyBounds.max[1]}`);
  }
  if (bodyBounds.min[1] > 0.02) throw new Error('Body is missing the feet');
  // The shifted body straddles ROBOT_EYE_MODEL z (0.2028) below the eye band (maxY < 0.92).
  if (bodyBounds.min[2] >= 0.2028 || bodyBounds.max[2] <= 0.2028) {
    throw new Error(
      `Body does not sit under the eye plane: z [${bodyBounds.min[2]}, ${bodyBounds.max[2]}]`
    );
  }
  for (const part of bodyParts) repairWinding(part);
  assertOutward(bodyParts, 'body');
  const bodySkin = buildAnimatedBodySkin(blue, bodyParts);

  const arms = {};
  for (const side of ['left', 'right']) {
    const suffix = side === 'left' ? 'l' : 'r';
    const shoulder = jointPosition(`upperarm_${suffix}`);
    const elbow = jointPosition(`lowerarm_${suffix}`);
    const wrist = jointPosition(`hand_${suffix}`);
    const toElbow = sub(elbow, shoulder);
    const toWrist = sub(wrist, elbow);
    const upperRotation = aimRotation(toElbow);
    const aim = aimRotation(toWrist);
    const prop = side === 'left' ? 'Prop_L' : 'Prop_R';
    const buster = side === 'left' ? 'Buster_L' : 'Buster_R';
    const upperParts = collectParts(skinned.meshes, (primitive) => (index) => {
      const name = skinned.jointNames[primitive.dominant[index]];
      if (name !== `upperarm_${suffix}`) return false;
      const t = projectionT(primitive.positions[index], shoulder, elbow);
      return t >= UPPER_START_T && t <= UPPER_END_T;
    }).map((part) => bakePart(part, shoulder, upperRotation));
    const forearmParts = collectParts(skinned.meshes, (primitive) => {
      const isForearmVert = (index) => {
        const name = skinned.jointNames[primitive.dominant[index]];
        if (name === `lowerarm_${suffix}`) return true;
        if (name === `hand_${suffix}`) {
          return projectionT(primitive.positions[index], elbow, wrist) <= FOREARM_WRIST_OVERLAP_T;
        }
        return false;
      };
      const hasLower = (index) =>
        skinned.jointNames[primitive.dominant[index]] === `lowerarm_${suffix}`;
      return (i0, i1, i2) =>
        isForearmVert(i0) &&
        isForearmVert(i1) &&
        isForearmVert(i2) &&
        (hasLower(i0) ||
          hasLower(i1) ||
          hasLower(i2) ||
          projectionT(primitive.positions[i0], elbow, wrist) <= FOREARM_WRIST_OVERLAP_T);
    }).map((part) => bakePart(part, wrist, aim));
    const fistParts = collectParts(curled.meshes, (primitive) => {
      const isFistVert = (index) => {
        const name = curled.jointNames[primitive.dominant[index]];
        if (name === `hand_${suffix}` || name === prop || name === buster) return true;
        if (/^(index_|pinky_|thumb_)/.test(name) && name.endsWith(`_${suffix}`)) return true;
        return false;
      };
      // Include hand-side straddling triangles with hand + lowerarm so no seam gap opens at the wrist pivot.
      const isFistOrWristVert = (index) =>
        isFistVert(index) || curled.jointNames[primitive.dominant[index]] === `lowerarm_${suffix}`;
      return (i0, i1, i2) =>
        isFistOrWristVert(i0) &&
        isFistOrWristVert(i1) &&
        isFistOrWristVert(i2) &&
        (isFistVert(i0) || isFistVert(i1) || isFistVert(i2));
    }).map((part) => bakePart(part, wrist, aim));
    fistParts.push(wristJointPart(forearmParts));
    const palmCenter = scale(
      apply3(
        aim,
        sub(
          scale(add(jointPosition(`index_01_${suffix}`), jointPosition(`pinky_01_${suffix}`)), 0.5),
          wrist
        )
      ),
      0.5
    );
    for (const [label, parts] of [
      ['upper', upperParts],
      ['forearm', forearmParts],
      ['fist', fistParts],
    ]) {
      if (parts.length === 0) throw new Error(`${side} ${label} extract is empty`);
      if (parts.some((part) => part.positions.length > 65535)) {
        throw new Error(`${side} ${label} exceeds uint16 vertices`);
      }
      for (const part of parts) repairWinding(part);
      assertOutward(parts, `${side} ${label}`);
    }
    const fistPositions = fistParts.flatMap((part) => part.positions);
    const fist = mean(fistPositions);
    if (!(fist[2] < -0.01))
      throw new Error(`${side} fist is not in front of the aim origin: ${fist}`);
    const elbowLocal = apply3(aim, sub(elbow, wrist));
    if (elbowLocal[2] < 0.1) {
      throw new Error(`${side} elbow is not on local +Z: ${elbowLocal}`);
    }
    arms[side] = {
      palmCenter,
      upperParts,
      forearmParts,
      fistParts,
      shoulder,
      elbow,
      wrist,
      upperLength: Math.hypot(toElbow[0], toElbow[1], toElbow[2]),
      forearmLength: Math.hypot(toWrist[0], toWrist[1], toWrist[2]),
      aimOffsetToFist: fist,
      upperTriangles: upperParts.reduce((sum, part) => sum + part.indices.length / 3, 0),
      forearmTriangles: forearmParts.reduce((sum, part) => sum + part.indices.length / 3, 0),
      fistTriangles: fistParts.reduce((sum, part) => sum + part.indices.length / 3, 0),
      fistBounds: boundsOf(fistPositions),
    };
  }

  fs.mkdirSync(outDir, { recursive: true });
  const segmentFile = (kind, side) => `quest-blue-${kind}-${side}.glb`;
  const writeSegment = (kind, side, parts, materials) => ({
    file: segmentFile(kind, side),
    bytes: writeGlb(
      segmentFile(kind, side).replace(/\.glb$/, ''),
      parts,
      materials.materials,
      materials.images,
      materials.sampler
    ),
  });
  const outputs = {
    body: {
      file: 'quest-blue-body.glb',
      bytes: writeGlb(
        'quest-blue-body',
        bodyParts,
        library.materials,
        library.images,
        library.sampler,
        bodySkin
      ),
    },
    upperLeft: writeSegment('upper', 'left', arms.left.upperParts, armLibrary),
    upperRight: writeSegment('upper', 'right', arms.right.upperParts, armLibrary),
    forearmLeft: writeSegment('forearm', 'left', arms.left.forearmParts, armLibrary),
    forearmRight: writeSegment('forearm', 'right', arms.right.forearmParts, armLibrary),
    handLeft: writeSegment('hand', 'left', arms.left.fistParts, library),
    handRight: writeSegment('hand', 'right', arms.right.fistParts, library),
  };
  for (const output of Object.values(outputs)) {
    fs.writeFileSync(path.join(outDir, output.file), output.bytes);
  }
  const blueAfter = fs.readFileSync(bluePath);
  const redAfter = fs.readFileSync(redPath);
  if (!blueBefore.equals(blueAfter) || !redBefore.equals(redAfter)) {
    throw new Error('Extraction modified an original Combat GLB');
  }
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const report = {
    generator: 'scripts/quest-first-person-extract.cjs',
    source: {
      blue: { file: BLUE, bytes: blueBefore.length, sha256: sha(blueBefore) },
      red: {
        file: RED,
        bytes: redBefore.length,
        sha256: sha(redBefore),
        jointNamesMatchBlue: true,
      },
    },
    originalsUnchanged: true,
    textures: `Body and fist PNGs are box-filtered to ${TEXTURE_EDGE}px. Upper and forearm PNGs are ${ARM_TEXTURE_EDGE}px. The Combat files keep their 1024px images.`,
    grip: 'Grip is a controller float. The Combat GLB has no grip pose. The static fist blends first-frame IdleAggro and BlockHold finger rotations; it is not driven by grip or a played clip.',
    fistCurl: {
      blend: FIST_POSE_BLEND,
      sourceClips: ['IdleAggro', 'BlockHold'],
      joints: 'index, pinky, and thumb 01/02/03',
      tips,
    },
    caps: {
      body: bodyParts.reduce((sum, part) => sum + (part.capsAdded || 0), 0),
      leftUpper: arms.left.upperParts.reduce((sum, part) => sum + (part.capsAdded || 0), 0),
      rightUpper: arms.right.upperParts.reduce((sum, part) => sum + (part.capsAdded || 0), 0),
      leftForearm: arms.left.forearmParts.reduce((sum, part) => sum + (part.capsAdded || 0), 0),
      rightForearm: arms.right.forearmParts.reduce((sum, part) => sum + (part.capsAdded || 0), 0),
      leftFist: arms.left.fistParts.reduce((sum, part) => sum + (part.capsAdded || 0), 0),
      rightFist: arms.right.fistParts.reduce((sum, part) => sum + (part.capsAdded || 0), 0),
    },
    material: {
      name: 'MI_ZMike_default',
      alphaMode: 'OPAQUE',
      doubleSided: false,
      baseColorAlphaMin: alphaMin,
    },
    aimRotation: 'Target columns -X +Y -Z, determinant +1. No X mirror and no 180 degree roll.',
    removedFromBody: {
      headJoints: [...removed.head],
      armJoints: [...removed.arms],
      eyeMesh: 'SKM_MegaMikeZ_part_1',
      eyeTriangles: removed.eyes,
      shoulderCap: `upperarm vertices with projection t < ${SHOULDER_CAP_T} stay on the body`,
    },
    body: {
      file: outputs.body.file,
      bytes: outputs.body.bytes.length,
      sha256: sha(outputs.body.bytes),
      triangles: bodyParts.reduce((sum, part) => sum + part.indices.length / 3, 0),
      bounds: { min: round3(bodyBounds.min), max: round3(bodyBounds.max) },
      ...bodySkin.summary,
      modelSpace:
        'Same origin as the Combat GLB. Scene scale is fighterScale under quest-rig-outer.',
    },
    arms: {
      upperStartT: UPPER_START_T,
      upperEndT: UPPER_END_T,
      forearmWristOverlapT: FOREARM_WRIST_OVERLAP_T,
      wristJoint: {
        radiusModel: 0.055,
        center: [0, 0, 0],
        sealed: true,
        material: 'source forearm material and wrist UV',
      },
      aimAxis: [0, 0, -1],
      forearmAxis: 'Wrist origin, local +Z toward the elbow, local -Z toward the wrist.',
      left: armReport(outputs, 'left', arms.left, sha),
      right: armReport(outputs, 'right', arms.right, sha),
      mount:
        'Upper origin is the shoulder and local -Z points at the elbow. Forearm and fist origins are the wrist. The forearm local +Z points at the elbow. The fist local -Z is the aim pointer. The scene scales once by QUEST_FIRST_PERSON_ARM_SCALE and stretches only local Z on the upper and forearm.',
    },
  };
  fs.writeFileSync(
    path.join(outDir, 'quest-first-person-extract.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );
  process.stdout.write(
    `${JSON.stringify({ outDir, body: report.body, arms: report.arms, fistCurl: report.fistCurl }, null, 2)}\n`
  );
}

main();
