const fs = require('node:fs');
const path = require('node:path');
const { AndroidConfig, withFinalizedMod } = require('@expo/config-plugins');

const PATCH_MARKER = 'supersededByOtherActivity';
const EXIT_TASK_PATCH_MARKER = 'questAppTaskCleanup';
const MAIN_ACTIVITY_PATCH_MARKER = 'questLauncherReopen';
const QUEST_SPLASH_SOURCE_REL = path.join(
  'assets',
  'arena',
  'ui',
  'quest-lettering',
  'quest-splash-title.png'
);

const IMPORT_ANCHOR = 'import android.app.Activity';
const MAIN_IMPORT_ANCHOR = 'import android.os.Bundle';
const MAIN_CLASS_ANCHOR = 'class MainActivity : ReactActivity() {';
const FIELD_ANCHOR = '    private var expectingForeignPause = false';
const DELEGATE_ANCHOR =
  '        object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {';
const ON_RESUME_ANCHOR = '    override fun onResume() {';
const ON_CREATE_ANCHOR = '    override fun onCreate(savedInstanceState: Bundle?) {';
const ON_CREATE_SUPER_ANCHOR = '        super.onCreate(savedInstanceState)';
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

function upsertMetaData(list, name, value) {
  const filtered = (Array.isArray(list) ? list : []).filter(
    (item) => item?.$?.['android:name'] !== name
  );
  filtered.push({
    $: {
      'android:name': name,
      'android:value': value,
    },
  });
  return filtered;
}

function isMainLauncherFilter(filter) {
  const actions = Array.isArray(filter?.action) ? filter.action : [];
  const categories = Array.isArray(filter?.category) ? filter.category : [];
  const hasMain = actions.some((a) => a?.$?.['android:name'] === 'android.intent.action.MAIN');
  const hasLauncher = categories.some(
    (c) => c?.$?.['android:name'] === 'android.intent.category.LAUNCHER'
  );
  return hasMain || hasLauncher;
}

/**
 * Configures AndroidManifest.xml for direct immersive Quest launch:
 * - `.VRActivity` is the sole `MAIN` + `LAUNCHER` + `com.oculus.intent.category.VR` activity.
 * - `.MainActivity` is stripped of `MAIN` / `LAUNCHER` so Horizon OS never opens a 2D panel window.
 * - Horizon OS system splash (`vr_splash.png`, `alpha`, `passthrough-contextual`) is enabled.
 */
function patchQuestAndroidManifest(manifest) {
  const app = manifest?.manifest?.application?.[0];
  if (!app) {
    throw new Error('Expected <application> in AndroidManifest.xml');
  }
  if (!Array.isArray(app.activity)) {
    app.activity = [];
  }

  app['meta-data'] = upsertMetaData(app['meta-data'], 'com.oculus.ossplash', 'true');
  app['meta-data'] = upsertMetaData(app['meta-data'], 'com.oculus.ossplash.type', 'alpha');
  app['meta-data'] = upsertMetaData(
    app['meta-data'],
    'com.oculus.ossplash.background',
    'passthrough-contextual'
  );

  const mainActivity = app.activity.find(
    (a) => a?.$?.['android:name'] === '.MainActivity' || a?.$?.['android:name']?.endsWith('.MainActivity')
  );
  if (mainActivity) {
    mainActivity.$['android:excludeFromRecents'] = 'true';
    const remainingFilters = (
      Array.isArray(mainActivity['intent-filter']) ? mainActivity['intent-filter'] : []
    ).filter((filter) => !isMainLauncherFilter(filter));
    if (remainingFilters.length > 0) {
      mainActivity['intent-filter'] = remainingFilters;
    } else {
      delete mainActivity['intent-filter'];
      mainActivity.$['android:exported'] = 'false';
    }
  }

  const vrActivity = app.activity.find(
    (a) => a?.$?.['android:name'] === '.VRActivity' || a?.$?.['android:name']?.endsWith('.VRActivity')
  );
  if (!vrActivity) {
    throw new Error('Expected .VRActivity in AndroidManifest.xml before Quest launcher patch');
  }
  vrActivity.$ = {
    ...vrActivity.$,
    'android:exported': 'true',
    'android:launchMode': 'singleTask',
    'android:excludeFromRecents': 'true',
    'android:resizeableActivity': 'false',
    'android:screenOrientation': 'landscape',
    'android:theme': '@style/AppTheme',
    'android:configChanges':
      'keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize|assetsPaths',
  };
  vrActivity['intent-filter'] = [
    {
      action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
      category: [
        { $: { 'android:name': 'android.intent.category.LAUNCHER' } },
        { $: { 'android:name': 'com.oculus.intent.category.VR' } },
      ],
    },
  ];
  vrActivity['meta-data'] = upsertMetaData(
    vrActivity['meta-data'],
    'com.oculus.vr.focusaware',
    'true'
  );

  return manifest;
}

/**
 * Patches Viro's generated VRActivity.kt so:
 * - Returning to or launching VRActivity keeps ReactContext.currentActivity and ReactHost synchronized.
 * - VRActivity tracks active instances, handles singleTask onNewIntent, avoids restoring stale Fragments,
 *   reports native lifecycle state to JS, and removes stray app tasks on terminal finish/System Quit.
 */
function patchVRActivitySource(source) {
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n';
  const normalized = source.replace(/\r\n/g, '\n');

  if (normalized.includes(PATCH_MARKER) && normalized.includes(EXIT_TASK_PATCH_MARKER)) {
    return source;
  }

  let patched = replaceOnce(
    normalized,
    IMPORT_ANCHOR,
    [
      IMPORT_ANCHOR,
      'import android.app.ActivityManager',
      'import android.content.Context',
      'import android.content.Intent',
      'import java.util.Collections',
      'import java.util.WeakHashMap',
      'import com.facebook.react.bridge.Arguments',
      'import com.facebook.react.modules.core.DeviceEventManagerModule',
    ].join('\n'),
    'Activity import'
  );

  patched = replaceOnce(
    patched,
    FIELD_ANCHOR,
    [
      '    companion object {',
      `        private val ${EXIT_TASK_PATCH_MARKER} = Collections.newSetFromMap(WeakHashMap<VRActivity, Boolean>())`,
      '    }',
      '',
      FIELD_ANCHOR,
      `    private var ${PATCH_MARKER} = false`,
    ].join('\n'),
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
      '    override fun onNewIntent(intent: Intent) {',
      '        super.onNewIntent(intent)',
      '        setIntent(intent)',
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
    ON_CREATE_SUPER_ANCHOR,
    [
      `        ${EXIT_TASK_PATCH_MARKER}.add(this)`,
      '        super.onCreate(null)',
    ].join('\n'),
    'onCreate super call'
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
      `        ${EXIT_TASK_PATCH_MARKER}.remove(this)`,
      '        lifecycleCallbacks?.let { application.unregisterActivityLifecycleCallbacks(it) }',
      '        lifecycleCallbacks = null',
      '        mainHandler.removeCallbacksAndMessages(null)',
      '        emitVRActivityState("destroyed")',
      '        if (isFinishing && !isChangingConfigurations && ' + `${EXIT_TASK_PATCH_MARKER}.isEmpty()) {`,
      '            try {',
      '                val am = getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager',
      '                am?.appTasks?.forEach { task ->',
      '                    try { task.finishAndRemoveTask() } catch (_: Throwable) {}',
      '                }',
      '            } catch (_: Throwable) {}',
      '        }',
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

function applyQuestSystemSplashAsset(projectRoot, platformProjectRoot) {
  const sourcePath = path.join(projectRoot, QUEST_SPLASH_SOURCE_REL);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Expected Quest system splash PNG at ${sourcePath}`);
  }
  const destPath = path.join(platformProjectRoot, 'app', 'src', 'main', 'assets', 'vr_splash.png');
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const sourceBytes = fs.readFileSync(sourcePath);
  const existingBytes = fs.existsSync(destPath) ? fs.readFileSync(destPath) : null;
  if (!existingBytes || !sourceBytes.equals(existingBytes)) {
    fs.writeFileSync(destPath, sourceBytes);
  }
  return { sourcePath, destPath };
}

async function applyQuestManifestPatch(platformProjectRoot) {
  const manifestPath = path.join(platformProjectRoot, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Expected AndroidManifest.xml at ${manifestPath} before finalizing Quest prebuild`);
  }
  const manifest = await AndroidConfig.Manifest.readAndroidManifestAsync(manifestPath);
  const patched = patchQuestAndroidManifest(manifest);
  await AndroidConfig.Manifest.writeAndroidManifestAsync(manifestPath, patched);
  return { manifestPath };
}

function withQuestVRActivity(config) {
  return withFinalizedMod(config, [
    'android',
    async (modConfig) => {
      await applyQuestManifestPatch(modConfig.modRequest.platformProjectRoot);
      applyQuestVRActivityPatch(
        modConfig.modRequest.platformProjectRoot,
        modConfig.android?.package
      );
      applyQuestMainActivityPatch(
        modConfig.modRequest.platformProjectRoot,
        modConfig.android?.package
      );
      applyQuestSystemSplashAsset(
        modConfig.modRequest.projectRoot,
        modConfig.modRequest.platformProjectRoot
      );
      return modConfig;
    },
  ]);
}

withQuestVRActivity.PATCH_MARKER = PATCH_MARKER;
withQuestVRActivity.EXIT_TASK_PATCH_MARKER = EXIT_TASK_PATCH_MARKER;
withQuestVRActivity.MAIN_ACTIVITY_PATCH_MARKER = MAIN_ACTIVITY_PATCH_MARKER;
withQuestVRActivity.patchQuestAndroidManifest = patchQuestAndroidManifest;
withQuestVRActivity.applyQuestManifestPatch = applyQuestManifestPatch;
withQuestVRActivity.patchVRActivitySource = patchVRActivitySource;
withQuestVRActivity.applyQuestVRActivityPatch = applyQuestVRActivityPatch;
withQuestVRActivity.patchMainActivitySource = patchMainActivitySource;
withQuestVRActivity.applyQuestMainActivityPatch = applyQuestMainActivityPatch;
withQuestVRActivity.applyQuestSystemSplashAsset = applyQuestSystemSplashAsset;

module.exports = withQuestVRActivity;
