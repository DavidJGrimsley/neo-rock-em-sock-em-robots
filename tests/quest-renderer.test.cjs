const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.join(__dirname, '..');
const {
  pointViroRendererAt,
  verifiedRendererDir,
} = require('../tools/quest/with-quest-viro-renderer.cjs');

const read = (file) => fs.readFileSync(path.join(repo, file), 'utf8');

test('the OpenXR pointer patch is pinned, depth-tested, and isolated from click routing', () => {
  const lock = JSON.parse(read('tools/quest/viro-renderer/lock.json'));
  assert.equal(lock.tag, 'v3.0.3');
  assert.equal(lock.revision, '23710240d2cab5d4e866f3dba44ef568d8e563b4');
  assert.equal(lock.ndk, '27.1.12297006');
  assert.equal(
    lock.stockRendererSha256,
    '2b3280493c4a788cc14319e263f1c2769bf3e54b22c9e4cc7673319967ccacd4'
  );
  // The pointer patch applies first; 0002 (menu layer) is covered in quest-menu-compositor.
  assert.equal(lock.patches[0], '0001-openxr-pointer-depth-origin-reticle.patch');
  const patch = read(`tools/quest/viro-renderer/${lock.patches[0]}`);
  assert.doesNotMatch(patch, /anthropic/i);
  assert.match(patch, /kHitSurfaceBias\s+=\s+0\.008f/);
  assert.match(patch, /towardOrigin\.scale\(kHitSurfaceBias\)/);
  assert.match(patch, /setReadsFromDepthBuffer\(true\)/);
  assert.match(patch, /setWritesToDepthBuffer\(false\)/);
  assert.match(patch, /ViroOculus::EyeGaze/);
  assert.match(patch, /ViroOculus::Controller/);
  assert.match(patch, /ViroOculus::LeftController/);
  assert.match(patch, /setSelectable\(false\)/);
  assert.match(patch, /No JNI, Java or JavaScript API changes/);
  assert.doesNotMatch(patch, /kClickGrace|kHoverHysteresis|Java_|node_modules/);
  const build = read('tools/quest/build-viro-renderer.mjs');
  assert.match(
    build,
    /A different \.so hash is recorded in report\.json\. It is not, by itself, an ABI mismatch\./
  );
  assert.match(build, /SONAME differs from stock/);
  assert.match(build, /JNI methods are not exported/);
  assert.match(build, /no pristine v3\.0\.3 rebuild/);
  assert.doesNotMatch(build, /problems\.push\(`hash/);
  assert.match(read('.gitattributes'), /tools\/quest\/viro-renderer\/\*\.patch -text/);
  assert.match(read('.gitignore'), /native\/quest-viro-renderer\//);
});

test('Quest prebuild retargets viro_renderer without touching a phone settings file', () => {
  const crlf =
    "include ':viro_renderer'\r\nproject(':viro_renderer').projectDir = new File('../node_modules/@reactvision/react-viro/android/viro_renderer')\r\n";
  const once = pointViroRendererAt(crlf, '../native/quest-viro-renderer');
  assert.match(
    once,
    /project\(':viro_renderer'\)\.projectDir = new File\('\.\.\/native\/quest-viro-renderer'\) \/\/ Quest pointer and menu layer patches$/m
  );
  assert.equal(pointViroRendererAt(once, '../native/quest-viro-renderer'), once);
  // A line written by the earlier pointer-only build is rewritten, not duplicated.
  const older =
    "project(':viro_renderer').projectDir = new File('../native/quest-viro-renderer') // Quest pointer patch\n";
  assert.equal(
    pointViroRendererAt(older, '../native/quest-viro-renderer'),
    "project(':viro_renderer').projectDir = new File('../native/quest-viro-renderer') // Quest pointer and menu layer patches\n"
  );
  const lf = "project(':viro_renderer').projectDir = new File('stock')\n";
  assert.match(pointViroRendererAt(lf, 'patched'), /File\('patched'\)/);
  assert.throws(() => pointViroRendererAt('rootProject.name = "app"\n', 'patched'), /found 0/);
  assert.throws(
    () =>
      pointViroRendererAt(
        "project(':viro_renderer').projectDir = new File('a')\nproject(':viro_renderer').projectDir = new File('b')\n",
        'patched'
      ),
    /found 2/
  );
  const output = path.join(repo, 'native/quest-viro-renderer');
  if (!fs.existsSync(path.join(output, 'provenance.json'))) {
    assert.throws(() => verifiedRendererDir(repo), /patched Viro renderer/);
  } else {
    assert.equal(path.resolve(verifiedRendererDir(repo)), path.resolve(output));
  }
});

test('a renderer built without the menu layer patch is rejected at prebuild', () => {
  const crypto = require('node:crypto');
  const os = require('node:os');
  const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const lock = JSON.parse(read('tools/quest/viro-renderer/lock.json'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'nrq-renderer-test-'));
  try {
    const lockDir = path.join(project, 'tools/quest/viro-renderer');
    fs.mkdirSync(lockDir, { recursive: true });
    for (const file of ['lock.json', ...lock.patches])
      fs.copyFileSync(path.join(repo, 'tools/quest/viro-renderer', file), path.join(lockDir, file));
    const stockDir = path.join(
      project,
      'node_modules/@reactvision/react-viro/android/viro_renderer'
    );
    fs.mkdirSync(stockDir, { recursive: true });
    fs.writeFileSync(path.join(project, 'node_modules/@reactvision/react-viro/package.json'), '{}');
    // Stand-in bytes: the plugin compares hashes, so the lock is pointed at them.
    fs.writeFileSync(path.join(stockDir, 'viro_renderer-release.aar'), 'stock');
    const testLock = {
      ...lock,
      stockAarSha256: sha(path.join(stockDir, 'viro_renderer-release.aar')),
    };
    fs.writeFileSync(path.join(lockDir, 'lock.json'), JSON.stringify(testLock));
    const out = path.join(project, 'native/quest-viro-renderer');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'viro_renderer-release.aar'), 'patched');
    const provenance = (patches) => ({
      viroCore: { revision: lock.revision },
      patches,
      stockAarSha256: testLock.stockAarSha256,
      aarSha256: sha(path.join(out, 'viro_renderer-release.aar')),
    });
    const all = lock.patches.map((file) => ({ file, sha256: sha(path.join(lockDir, file)) }));
    fs.writeFileSync(path.join(out, 'provenance.json'), JSON.stringify(provenance(all)));
    assert.equal(path.resolve(verifiedRendererDir(project)), path.resolve(out));
    // The Stage 02 renderer: pointer patch only, in the old single-patch field.
    fs.writeFileSync(
      path.join(out, 'provenance.json'),
      JSON.stringify({ ...provenance(undefined), patch: all[0] })
    );
    assert.throws(() => verifiedRendererDir(project), /patches/);
    fs.writeFileSync(
      path.join(out, 'provenance.json'),
      JSON.stringify(provenance(all.slice(0, 1)))
    );
    assert.throws(() => verifiedRendererDir(project), /patches/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
