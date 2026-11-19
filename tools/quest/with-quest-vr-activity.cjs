const fs = require('node:fs');
const path = require('node:path');
const { withFinalizedMod } = require('@expo/config-plugins');

const PATCH_MARKER = 'supersededByOtherActivity';

const FIELD_ANCHOR = '    private var expectingForeignPause = false';
const DELEGATE_ANCHOR =
  '        object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {';
const ON_RESUME_ANCHOR = '    override fun onResume() {';
const ON_CREATE_ANCHOR = '    override fun onCreate(savedInstanceState: Bundle?) {';
const RESUMED_CALLBACK_ANCHOR = [
  '            override fun onActivityResumed(other: Activity) {',
  '                if (other !== this@VRActivity && !isFinishing && !isDestroyed) {',
  '                    finish()',
  '                }',
  '            }',
].join('\n');

function replaceOnce(source, anchor, replacement, label) {
  const index = source.indexOf(anchor);
  if (index === -1) {
    throw new Error(`Unexpected VRActivity.kt template; missing ${label}`);
  }
  if (source.indexOf(anchor, index + anchor.length) !== -1) {
    throw new Error(`Unexpected VRActivity.kt template; multiple matches for ${label}`);
  }
  return source.slice(0, index) + replacement + source.slice(index + anchor.length);
}

/**
 * Patches Viro's generated VRActivity.kt so returning to MainActivity after pressing Meta/Home
 * never pauses the shared ReactHost once MainActivity has already resumed.
 */
function patchVRActivitySource(source) {
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n';
  const normalized = source.replace(/\r\n/g, '\n');

  if (normalized.includes(PATCH_MARKER)) {
    return source;
  }

  let patched = replaceOnce(
    normalized,
    FIELD_ANCHOR,
    `${FIELD_ANCHOR}\n    private var ${PATCH_MARKER} = false`,
    'expectingForeignPause field'
  );

  patched = replaceOnce(
    patched,
    DELEGATE_ANCHOR,
    [
      DELEGATE_ANCHOR,
      '            override fun onPause() {',
      '                // Another in-app Activity (MainActivity) can resume before VRActivity.onPause()',
      '                // runs from finish(). Skipping super.onPause() avoids calling',
      '                // reactHost.onHostPause(VRActivity) while skipActivityIdentityAssertionOnHostPause',
      '                // is active, which would pause Fabric mount dispatch and timers on MainActivity.',
      '                val currentActivity = reactHost?.currentReactContext?.currentActivity',
      '                if (',
      `                    ${PATCH_MARKER} ||`,
      '                    (currentActivity != null && currentActivity !== this@VRActivity)',
      '                ) {',
      '                    return',
      '                }',
      '                super.onPause()',
      '            }',
      '',
    ].join('\n'),
    'DefaultReactActivityDelegate block'
  );

  patched = replaceOnce(
    patched,
    ON_RESUME_ANCHOR,
    `${ON_RESUME_ANCHOR}\n        ${PATCH_MARKER} = false`,
    'onResume override'
  );

  patched = replaceOnce(
    patched,
    ON_CREATE_ANCHOR,
    [
      '    override fun onPause() {',
      '        expectingForeignPause = false',
      '        super.onPause()',
      '    }',
      '',
      ON_CREATE_ANCHOR,
    ].join('\n'),
    'onCreate override'
  );

  patched = replaceOnce(
    patched,
    RESUMED_CALLBACK_ANCHOR,
    [
      '            override fun onActivityResumed(other: Activity) {',
      '                if (other !== this@VRActivity) {',
      `                    ${PATCH_MARKER} = true`,
      '                    expectingForeignPause = false',
      '                    mainHandler.removeCallbacksAndMessages(null)',
      '                    if (!isFinishing && !isDestroyed) {',
      '                        finish()',
      '                    }',
      '                }',
      '            }',
    ].join('\n'),
    'onActivityResumed callback'
  );

  return lineEnding === '\r\n' ? patched.replace(/\n/g, '\r\n') : patched;
}

function applyQuestVRActivityPatch(platformProjectRoot, packageName) {
  if (!packageName) {
    throw new Error('android.package is required to locate VRActivity.kt');
  }
  const activityPath = path.join(
    platformProjectRoot,
    'app',
    'src',
    'main',
    'java',
    ...packageName.split('.'),
    'VRActivity.kt'
  );
  if (!fs.existsSync(activityPath)) {
    throw new Error(
      `Expected Viro Quest VRActivity.kt at ${activityPath} before finalizing Android prebuild`
    );
  }
  const source = fs.readFileSync(activityPath, 'utf8');
  const patched = patchVRActivitySource(source);
  if (patched !== source) {
    fs.writeFileSync(activityPath, patched, 'utf8');
  }
  return { activityPath, changed: patched !== source };
}

function withQuestVRActivity(config) {
  return withFinalizedMod(config, [
    'android',
    async (modConfig) => {
      applyQuestVRActivityPatch(
        modConfig.modRequest.platformProjectRoot,
        modConfig.android?.package
      );
      return modConfig;
    },
  ]);
}

withQuestVRActivity.PATCH_MARKER = PATCH_MARKER;
withQuestVRActivity.patchVRActivitySource = patchVRActivitySource;
withQuestVRActivity.applyQuestVRActivityPatch = applyQuestVRActivityPatch;

module.exports = withQuestVRActivity;
