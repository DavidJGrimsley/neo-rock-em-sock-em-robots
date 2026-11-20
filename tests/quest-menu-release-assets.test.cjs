const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  questMenuFileUri,
  resolveQuestMenuAssetFile,
} = require('../src/features/quest-vr/quest-menu-asset-uri.ts');

// Same transform as @react-native/assets-registry/path-support.js
// getAndroidResourceIdentifier. Expo's embedded httpServerLocation for this
// repo is /assets plus the project-relative path, so the leading assets_
// prefix is removed once and the packaged name still starts with assets_.
function androidResourceName(httpServerLocation, name) {
  const base = httpServerLocation.startsWith('/')
    ? httpServerLocation.slice(1)
    : httpServerLocation;
  return (base + '/' + name)
    .toLowerCase()
    .replace(/\//g, '_')
    .replace(/([^a-z0-9_])/g, '')
    .replace(/^(?:assets|assetsunstable_path)_/, '');
}

const LOCATION = '/assets/assets/arena/ui';
const DRAWABLES = {
  'menu-background': 'assets_arena_ui_menubackground',
  neo: 'assets_arena_ui_questlettering_neo',
  rock: 'assets_arena_ui_questlettering_rock',
  robots: 'assets_arena_ui_questlettering_robots',
};
const FONTS = {
  ArenaNotoSans: 'assets_arena_ui_arenanotosans',
  ArenaNotoSansSemibold: 'assets_arena_ui_arenanotosanssemibold',
  ArenaNotoSerif: 'assets_arena_ui_arenanotoserif',
};

function releaseApk() {
  const apk = process.env.QUEST_RELEASE_APK;
  return apk && fs.existsSync(apk) ? apk : null;
}

function aapt2() {
  const roots = [
    process.env.ANDROID_HOME,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'sdk'),
  ].filter(Boolean);
  for (const root of roots) {
    const tools = path.join(root, 'build-tools');
    if (!fs.existsSync(tools)) continue;
    const versions = fs.readdirSync(tools).sort().reverse();
    for (const version of versions) {
      const candidate = path.join(
        tools,
        version,
        process.platform === 'win32' ? 'aapt2.exe' : 'aapt2'
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function pngSize(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('a release drawable name is not a Canvas file and must be copied', async () => {
  assert.equal(androidResourceName(LOCATION, 'menu-background'), DRAWABLES['menu-background']);
  assert.equal(androidResourceName(`${LOCATION}/quest-lettering`, 'neo'), DRAWABLES.neo);
  assert.equal(androidResourceName(`${LOCATION}/quest-lettering`, 'rock'), DRAWABLES.rock);
  assert.equal(androidResourceName(`${LOCATION}/quest-lettering`, 'robots'), DRAWABLES.robots);
  assert.equal(androidResourceName(LOCATION, 'ArenaNotoSans'), FONTS.ArenaNotoSans);
  assert.equal(androidResourceName(LOCATION, 'ArenaNotoSansSemibold'), FONTS.ArenaNotoSansSemibold);
  assert.equal(androidResourceName(LOCATION, 'ArenaNotoSerif'), FONTS.ArenaNotoSerif);

  for (const resourceName of [...Object.values(DRAWABLES), ...Object.values(FONTS)]) {
    assert.equal(questMenuFileUri(resourceName), null, resourceName);
    let copiedFrom = null;
    const file = await resolveQuestMenuAssetFile(
      {
        uri: resourceName,
        localUri: resourceName,
        hash: 'abc123',
        type: resourceName.includes('noto') ? 'ttf' : 'png',
      },
      async (uri, hash, type) => {
        copiedFrom = { uri, hash, type };
        return `file:///data/user/0/com.djleg.neorobots/cache/ExponentAsset-${hash}.${type}`;
      }
    );
    assert.equal(copiedFrom.uri, resourceName);
    assert.equal(file.startsWith('file:///data/'), true);
    assert.equal(questMenuFileUri(file), file);
  }

  assert.equal(
    questMenuFileUri('file:///android_res/drawable/assets_arena_ui_menubackground'),
    null
  );
  await assert.rejects(
    () =>
      resolveQuestMenuAssetFile(
        { uri: 'file:///android_res/drawable/assets_arena_ui_menubackground', type: 'png' },
        async () => 'file:///android_res/drawable/assets_arena_ui_menubackground'
      ),
    /Menu asset did not copy to a file/
  );
  const cached = 'file:///data/user/0/com.djleg.neorobots/cache/ExponentAsset-ready.png';
  let calls = 0;
  const ready = await resolveQuestMenuAssetFile(
    {
      uri: 'http://127.0.0.1:8081/assets/menu-background.png',
      localUri: cached,
      hash: 'ready',
      type: 'png',
    },
    async () => {
      calls += 1;
      return 'file:///should-not-be-used.png';
    }
  );
  assert.equal(ready, cached);
  assert.equal(calls, 0);
});

test('the release APK packages the compositor panel module, patched renderer, and clean bundle without Quest branding', () => {
  const apk = releaseApk();
  if (!apk) {
    assert.ok(true, 'QUEST_RELEASE_APK is not set on this run');
    return;
  }
  const crypto = require('node:crypto');
  const entries = readZipListing(apk);
  for (const name of [
    'quest-lettering/neo.png',
    'quest-lettering/rock.png',
    'quest-lettering/robots.png',
  ]) {
    assert.equal(
      entries.some((entry) => entry.includes(name) || entry.includes('questlettering')),
      false,
      `${name} must not be packaged in the clean compositor APK`
    );
  }
  assert.equal(entries.includes('lib/arm64-v8a/libviro_renderer.so'), true);
  const provenanceFile = path.join(__dirname, '../native/quest-viro-renderer/provenance.json');
  if (fs.existsSync(provenanceFile)) {
    const provenance = JSON.parse(fs.readFileSync(provenanceFile, 'utf8'));
    const soBytes = readZipEntry(apk, 'lib/arm64-v8a/libviro_renderer.so');
    const soSha = crypto.createHash('sha256').update(soBytes).digest('hex');
    assert.equal(soSha, provenance.rendererSha256);
  }
  const dexEntries = entries.filter((entry) => /^classes\d*\.dex$/.test(entry));
  assert.ok(dexEntries.length > 0, 'release APK has dex files');
  const hasQuestPanelModule = dexEntries.some((entry) =>
    readZipEntry(apk, entry).includes('QuestPanelModule')
  );
  assert.equal(hasQuestPanelModule, true, 'QuestPanelModule must be compiled into APK dex');

  const bundle = readZipEntry(apk, 'assets/index.android.bundle');
  assert.ok(bundle.includes('QuestHeadRig'));
  assert.ok(bundle.includes('questMenuLayerMask'));
  assert.ok(bundle.includes('QuestPanel'));
  assert.equal(bundle.includes('Menu texture failed'), false);
  assert.equal(bundle.includes('quest-lettering'), false);
});

function readZipListing(apk) {
  return execFileSync(process.execPath, ['-e', zipScript('list'), apk], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
    .split(/\r?\n/)
    .filter(Boolean);
}

function readZipEntry(apk, entry) {
  const encoded = execFileSync(process.execPath, ['-e', zipScript('read'), apk, entry], {
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  });
  return encoded;
}

function zipScript(mode) {
  if (mode === 'list') {
    return `
      const fs = require('fs');
      const zlib = require('zlib');
      const { unzipSync } = require('node:zlib');
      // Avoid a dependency: parse the central directory only for names.
      const fd = fs.openSync(process.argv[1], 'r');
      const stat = fs.fstatSync(fd);
      const tailSize = Math.min(stat.size, 22 + 65535);
      const tail = Buffer.alloc(tailSize);
      fs.readSync(fd, tail, 0, tailSize, stat.size - tailSize);
      const marker = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
      let eocd = tail.lastIndexOf(marker);
      if (eocd < 0) throw new Error('APK has no end of central directory');
      const count = tail.readUInt16LE(eocd + 10);
      const size = tail.readUInt32LE(eocd + 12);
      const offset = tail.readUInt32LE(eocd + 16);
      const central = Buffer.alloc(size);
      fs.readSync(fd, central, 0, size, offset);
      fs.closeSync(fd);
      let cursor = 0;
      for (let index = 0; index < count; index += 1) {
        if (central.readUInt32LE(cursor) !== 0x02014b50) throw new Error('bad central directory');
        const nameLength = central.readUInt16LE(cursor + 28);
        const extraLength = central.readUInt16LE(cursor + 30);
        const commentLength = central.readUInt16LE(cursor + 32);
        const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
        console.log(name);
        cursor += 46 + nameLength + extraLength + commentLength;
      }
    `;
  }
  return `
    const fs = require('fs');
    const zlib = require('zlib');
    const apk = process.argv[1];
    const wanted = process.argv[2];
    const fd = fs.openSync(apk, 'r');
    const stat = fs.fstatSync(fd);
    const tailSize = Math.min(stat.size, 22 + 65535);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, stat.size - tailSize);
    const marker = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const eocd = tail.lastIndexOf(marker);
    if (eocd < 0) throw new Error('APK has no end of central directory');
    const count = tail.readUInt16LE(eocd + 10);
    const size = tail.readUInt32LE(eocd + 12);
    const offset = tail.readUInt32LE(eocd + 16);
    const central = Buffer.alloc(size);
    fs.readSync(fd, central, 0, size, offset);
    let cursor = 0;
    for (let index = 0; index < count; index += 1) {
      if (central.readUInt32LE(cursor) !== 0x02014b50) throw new Error('bad central directory');
      const method = central.readUInt16LE(cursor + 10);
      const compressed = central.readUInt32LE(cursor + 20);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const localOffset = central.readUInt32LE(cursor + 42);
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      if (name === wanted) {
        const local = Buffer.alloc(30);
        fs.readSync(fd, local, 0, 30, localOffset);
        const localName = local.readUInt16LE(26);
        const localExtra = local.readUInt16LE(28);
        const data = Buffer.alloc(compressed);
        fs.readSync(fd, data, 0, compressed, localOffset + 30 + localName + localExtra);
        fs.closeSync(fd);
        const output = method === 0 ? data : zlib.inflateRawSync(data);
        process.stdout.write(output);
        process.exit(0);
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    fs.closeSync(fd);
    throw new Error('missing zip entry ' + wanted);
  `;
}
