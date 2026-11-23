const fs = require('node:fs');
const path = require('node:path');
const { withFinalizedMod } = require('@expo/config-plugins');

const PATCH_MARKER = 'supersededByOtherActivity';
const MAIN_ACTIVITY_PATCH_MARKER = 'questLauncherReopen';

const IMPORT_ANCHOR = 'import android.app.Activity';
const MAIN_IMPORT_ANCHOR = 'import android.os.Bundle';
const MAIN_CLASS_ANCHOR = 'class MainActivity : ReactActivity() {';
const FIELD_ANCHOR = '    private var expectingForeignPause = false';
const DELEGATE_ANCHOR =
  '        object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {';
const ON_RESUME_ANCHOR = '    override fun onResume() {';
const ON_CREATE_ANCHOR = '    override fun onCreate(savedInstanceState: Bundle?) {';
const DESTROY_CLEANUP_ANCHOR = [
  '        lifecycleCallbacks?.let { application.unregisterActivityLifecycleCallbacks(it) }',
  '        lifecycleCallbacks = null',
  '        mainHandler.removeCallbacksAndMessages(null)',
  '        super.onDestroy()',
].join('\n');
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
 * Patches Viro's generated VRActivity.kt so returning to MainActivity keeps
 * ReactContext.currentActivity and ReactHost synchronized, avoids force-finishing
 * VRActivity when Horizon OS brings MainActivity forward, and reports native
 * VRActivity lifecycle transitions to JS.
 */
function patchVRActivitySource(source) {
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n';
  const normalized = source.replace(/\r\n/g, '\n');

  if (normalized.includes(PATCH_MARKER)) {
    return source;
  }

  let patched = replaceOnce(
    normalized,
    IMPORT_ANCHOR,
    [
      IMPORT_ANCHOR,
      'import com.facebook.react.bridge.Arguments',
      'import com.facebook.react.modules.core.DeviceEventManagerModule',
    ].join('\n'),
    'Activity import'
  );

  patched = replaceOnce(
    patched,
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
      '                // runs. Skipping super.onPause() avoids calling reactHost.onHostPause(VRActivity)',
      '                // while skipActivityIdentityAssertionOnHostPause is active, which would pause',
      '                // Fabric mount dispatch and timers on MainActivity.',
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
    [
      ON_RESUME_ANCHOR,
      `        ${PATCH_MARKER} = false`,
      '        emitVRActivityState("resumed")',
    ].join('\n'),
    'onResume override'
  );

  patched = replaceOnce(
    patched,
    ON_CREATE_ANCHOR,
    [
      '    private fun emitVRActivityState(state: String) {',
      '        val reactContext = reactHost?.currentReactContext ?: return',
      '        if (!reactContext.hasActiveReactInstance()) return',
      '        try {',
      '            val payload = Arguments.createMap().apply {',
      '                putString("state", state)',
      '                putBoolean("finishing", isFinishing || isDestroyed)',
      '            }',
      '            reactContext',
      '                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)',
      '                .emit("questVRActivityState", payload)',
      '        } catch (_: Throwable) {',
      '        }',
      '    }',
      '',
      '    override fun onPause() {',
      '        expectingForeignPause = false',
      '        emitVRActivityState(if (isFinishing || isDestroyed) "finishing" else "paused")',
      '        super.onPause()',
      '    }',
      '',
      '    override fun onStop() {',
      '        emitVRActivityState(if (isFinishing || isDestroyed) "finishing" else "stopped")',
      '        super.onStop()',
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
      '                    // ReactLifecycleStateManager.moveToOnHostResume skips updating',
      '                    // ReactContext.mCurrentActivity when state is already RESUMED.',
      '                    // Sync it to the resumed Activity so Compose HostViews never bind',
      '                    // to a paused or destroyed VRActivity lifecycle.',
      '                    val reactContext = reactHost?.currentReactContext',
      '                    if (reactContext != null && reactContext.currentActivity !== other) {',
      '                        reactContext.onHostResume(other)',
      '                    }',
      '                }',
      '            }',
    ].join('\n'),
    'onActivityResumed callback'
  );

  patched = replaceOnce(
    patched,
    DESTROY_CLEANUP_ANCHOR,
    [
      '        lifecycleCallbacks?.let { application.unregisterActivityLifecycleCallbacks(it) }',
      '        lifecycleCallbacks = null',
      '        mainHandler.removeCallbacksAndMessages(null)',
      '        emitVRActivityState("destroyed")',
      '        super.onDestroy()',
    ].join('\n'),
    'onDestroy cleanup'
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

function patchMainActivitySource(source) {
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n';
  const normalized = source.replace(/\r\n/g, '\n');

  if (normalized.includes(MAIN_ACTIVITY_PATCH_MARKER)) {
    return source;
  }

  let patched = replaceOnce(
    normalized,
    MAIN_IMPORT_ANCHOR,
    [
      'import android.content.Intent',
      MAIN_IMPORT_ANCHOR,
      'import com.facebook.react.modules.core.DeviceEventManagerModule',
    ].join('\n'),
    'MainActivity Bundle import'
  );

  patched = replaceOnce(
    patched,
    MAIN_CLASS_ANCHOR,
    [
      MAIN_CLASS_ANCHOR,
      '  override fun onNewIntent(intent: Intent) {',
      '    super.onNewIntent(intent)',
      '    setIntent(intent)',
      '    if (',
      '      intent.action == Intent.ACTION_MAIN &&',
      '      intent.hasCategory(Intent.CATEGORY_LAUNCHER)',
      '    ) {',
      '      val reactContext = reactHost?.currentReactContext',
      '      if (reactContext != null && reactContext.hasActiveReactInstance()) {',
      '        try {',
      '          reactContext',
      '            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)',
      `            .emit("${MAIN_ACTIVITY_PATCH_MARKER}", null)`,
      '        } catch (_: Throwable) {',
      '        }',
      '      }',
      '    }',
      '  }',
      '',
    ].join('\n'),
    'MainActivity class header'
  );

  return lineEnding === '\r\n' ? patched.replace(/\n/g, '\r\n') : patched;
}

function applyQuestMainActivityPatch(platformProjectRoot, packageName) {
  if (!packageName) {
    throw new Error('android.package is required to locate MainActivity.kt');
  }
  const activityPath = path.join(
    platformProjectRoot,
    'app',
    'src',
    'main',
    'java',
    ...packageName.split('.'),
    'MainActivity.kt'
  );
  if (!fs.existsSync(activityPath)) {
    throw new Error(
      `Expected Quest MainActivity.kt at ${activityPath} before finalizing Android prebuild`
    );
  }
  const source = fs.readFileSync(activityPath, 'utf8');
  const patched = patchMainActivitySource(source);
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
      applyQuestMainActivityPatch(
        modConfig.modRequest.platformProjectRoot,
        modConfig.android?.package
      );
      return modConfig;
    },
  ]);
}

withQuestVRActivity.PATCH_MARKER = PATCH_MARKER;
withQuestVRActivity.MAIN_ACTIVITY_PATCH_MARKER = MAIN_ACTIVITY_PATCH_MARKER;
withQuestVRActivity.patchVRActivitySource = patchVRActivitySource;
withQuestVRActivity.applyQuestVRActivityPatch = applyQuestVRActivityPatch;
withQuestVRActivity.patchMainActivitySource = patchMainActivitySource;
withQuestVRActivity.applyQuestMainActivityPatch = applyQuestMainActivityPatch;

module.exports = withQuestVRActivity;
