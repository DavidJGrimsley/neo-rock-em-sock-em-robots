const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.join(__dirname, '..');
const { pointViroRendererAt, verifiedRendererDir } = require('../tools/quest/with-quest-viro-renderer.cjs');

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
  const patch = read(`tools/quest/viro-renderer/${lock.patch}`);
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
  assert.match(build, /A different \.so hash is recorded in report\.json\. It is not, by itself, an ABI mismatch\./);
  assert.match(build, /SONAME differs from stock/);
  assert.match(build, /JNI methods are not exported/);
  assert.match(build, /no pristine v3\.0\.3 rebuild/);
  assert.doesNotMatch(build, /problems\.push\(`hash/);
  assert.match(read('.gitattributes'), /tools\/quest\/viro-renderer\/\*\.patch -text/);
  assert.match(read('.gitignore'), /native\/quest-viro-renderer\//);
});

test('Quest prebuild retargets viro_renderer without touching a phone settings file', () => {
  const crlf = "include ':viro_renderer'\r\nproject(':viro_renderer').projectDir = new File('../node_modules/@reactvision/react-viro/android/viro_renderer')\r\n";
  const once = pointViroRendererAt(crlf, '../native/quest-viro-renderer');
  assert.match(once, /project\(':viro_renderer'\)\.projectDir = new File\('\.\.\/native\/quest-viro-renderer'\) \/\/ Quest pointer patch/);
  assert.equal(pointViroRendererAt(once, '../native/quest-viro-renderer'), once);
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
