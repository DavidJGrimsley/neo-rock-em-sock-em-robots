# Quest 01 runtime: Windows build, install and logs

Stage 01 proves a fully immersive Meta Quest runtime: a 2D panel, an explicit **Enter VR**, a black `ViroScene` with a fixed reference cube 2 m ahead, a `Quest VR test` label and an **Exit VR** target. It is not gameplay.

`QUEST_BUILD=1` is the only switch. Without it, `app.config.ts` produces the unchanged phone AR configuration. With it, Viro uses `xRMode: ["QUEST"]` (VRActivity, OpenXR) for Quest 3/3S, with colocation, eye tracking and the passthrough camera disabled, and `android.blockedPermissions` removes the phone-only and mixed-reality permissions. The package name stays `com.djleg.neorobots`, so the phone and Quest builds replace each other on one device. Set `META_QUEST_APP_ID` (numeric) only for a store build. Viro then also forces the panel activity to landscape.

Never commit `android/`. Always use `--clean` when switching variants. Otherwise `VRActivity.kt`, `gradle.properties` and `MainApplication.kt` from the other variant remain.

## Prerequisites

- JDK 17, Android SDK with NDK 27.1.12297006 and CMake 3.22.1, `npm ci` completed.
- Quest in developer mode, connected by USB, with the debugging prompt accepted in the headset.

```powershell
$sdk = "$env:LOCALAPPDATA\Android\sdk"
$adb = "$sdk\platform-tools\adb.exe"
$aapt2 = "$sdk\build-tools\36.0.0\aapt2.exe"
```

## Build

A native build needs a short checkout path and several GB free on the checkout's drive. Under this worktree's 100-character path, CMake object paths exceed the 260-character limit of the NDK's bundled Ninja (`ninja: error: manifest 'build.ninja' still dirty after 100 tries`). Gradle also writes library outputs into `node_modules\*\android\build`, 4 GB or more for arm64 debug and release builds. Two workarounds do not help:

- `subst` fails both ways. Mapping the project as a drive root breaks Expo autolinking (`Couldn't find "package.json" up from path "Q:\"`). Mapping its parent mixes `Q:` and `F:` paths in React Native codegen (`this and base files have different roots`), because Node resolves the real path.
- Moving Gradle build directories to another drive fails for the same codegen reason.

What works is a staging copy at a short path, plus `tools/quest/short-cmake.gradle`, which moves only CMake staging to `%TEMP%\nrq-cxx` (`QUEST_CXX_ROOT` overrides this). Copy exactly the files Git would commit, so the APK matches the checkout:

```powershell
$wt = (Resolve-Path .).Path                       # the worktree
$stage = "$env:TEMP\nrq-w"                         # short path, on a drive with space
git -C $wt ls-files -co --exclude-standard | ForEach-Object {
  $to = Join-Path $stage $_; New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
  Copy-Item -LiteralPath (Join-Path $wt $_) -Destination $to
}
Set-Location $stage
npm ci

$env:QUEST_BUILD = '1'
npx expo prebuild -p android --clean --no-install
Remove-Item Env:QUEST_BUILD
Select-String -Path android\app\src\main\java\com\djleg\neorobots\MainApplication.kt -Pattern 'ReactViroPackage\('
# Expect exactly one line: ReactViroPackage.ViroPlatform.QUEST (the phone build has .AR)

Set-Location android
.\gradlew.bat :app:processDebugManifest :app:processReleaseManifest :app:assembleDebug :app:assembleRelease `
  -PreactNativeArchitectures=arm64-v8a -I ..\tools\quest\short-cmake.gradle --console=plain
Set-Location ..
$out = "$stage\android\app\build"
```

In a checkout that already has a short path, run the prebuild and Gradle steps there directly. Afterwards, run `git checkout -- package.json`, because prebuild rewrites the `android` and `ios` scripts.

Merged manifests are in `$out\intermediates\merged_manifests\<variant>\process<Variant>Manifest\AndroidManifest.xml`. Merger reports are in `$out\outputs\logs\`.

Use the **release** APK (`$out\outputs\apk\release\app-release.apk`) for the gate. It bundles the JavaScript, runs without Metro or USB, and lacks the debug-only manifest entries. The Expo template signs it with the debug keystore. It is suitable for sideloading, not the store. The debug APK (`$out\outputs\apk\debug\app-debug.apk`) is a development client: run `npx expo start --dev-client` and `& $adb reverse tcp:8081 tcp:8081` before launching it.

Check the packaged permissions:

```powershell
& $aapt2 dump permissions "$out\outputs\apk\release\app-release.apk"
& $aapt2 dump xmltree --file AndroidManifest.xml "$out\outputs\apk\release\app-release.apk" |
  Select-String 'uses-permission|uses-feature|activity|meta-data|Raw: "'
```

The release APK should request only `INTERNET`, `ACCESS_NETWORK_STATE`, `MODIFY_AUDIO_SETTINGS`, `VIBRATE`, `WAKE_LOCK` and the app-private `com.djleg.neorobots.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. The debug APK also has `SYSTEM_ALERT_WINDOW` and `CHANGE_WIFI_MULTICAST_STATE` from React Native's and the dev launcher's debug manifests. The template's `src/debug` manifest redeclares `SYSTEM_ALERT_WINDOW`, so blocking it in the main manifest has no effect. Release builds never contain it. `CAMERA`, `RECORD_AUDIO`, `NFC`, storage, `EYE_TRACKING`, scene, anchor, boundary, headset-camera, colocation and hand-tracking permissions must be absent.

To return to the phone build, run `Remove-Item Env:QUEST_BUILD` and then `npx expo prebuild -p android --clean --no-install`.

## Install, launch and logs

```powershell
& $adb devices -l                       # must list the Quest, not "unauthorized"
& $adb shell getprop ro.product.model
& $adb shell getprop ro.build.version.incremental
& $adb install -r "$out\outputs\apk\release\app-release.apk"
& $adb shell dumpsys package com.djleg.neorobots | Select-String 'versionName|granted=true'

& $adb logcat -c
& $adb shell monkey -p com.djleg.neorobots -c android.intent.category.LAUNCHER 1
$appPid = (& $adb shell pidof com.djleg.neorobots).Trim()
& $adb logcat --pid=$appPid -v time | Tee-Object -FilePath quest-app.log   # all logs from the app process
```

In a second terminal, set the variables from Prerequisites again, then capture compositor and lifecycle evidence. The process ID changes if the app restarts, so read `$appPid` again after any crash.

```powershell
& $adb logcat -v time -s VrApi:I | Tee-Object -FilePath quest-vrapi.log   # FPS, stale frames, prediction
& $adb shell dumpsys activity activities | Select-String 'neorobots|ResumedActivity|VRActivity'
& $adb shell dumpsys SurfaceFlinger --list | Select-String neorobots
& $adb logcat -d -v time *:E | Select-String 'neorobots|FATAL|VRQuestScene' > quest-errors.log
```

Logs and screenshots may show device identifiers. Review them before sharing.

## Gate procedure

On the headset: **Home → Quest VR Runtime → Enter VR**. The panel shows **Opening VR**. Back is ignored while the scene opens. The scene should appear in stereo: a black surround, a cube fixed in space while you move your head, the label and the red **Exit VR** target. Then:

1. Select **Exit VR** with a controller trigger. The panel shows **Back on the panel. Entered 1×**.
2. Select **Enter VR**, then exit with the controller **Back** button.
3. Enter, press the Meta/Home button, then reopen the app from the library. If the scene is paused or you returned to the panel, the panel offers **Re-enter VR**.
4. Repeat Enter and Exit at least five times. After each step, check that `dumpsys activity activities` shows `VRActivity` only while the scene is open and that the app process has not restarted (`pidof`).

Record the headset model, OS build, APK variant and git SHA, the panel counts, `quest-vrapi.log` (steady FPS, no repeated stale frames) and any `AndroidRuntime` or `ReactNativeJS` errors. If an error appears, the panel shows **VR needs another try** and the error text. A launch that does not mount within 10 s also reports there.

## Known limitations

- Viro 3.0.3 registers `VRQuestScene` when `@reactvision/react-viro` is first imported. Here, that happens in the panel when Enter is pressed. If Android kills the process and restores `VRActivity` directly, `ViroQuestEntryPoint` renders nothing because the intent is gone, or the scene may not be registered. Close and reopen the app.
- Horizon OS treats `USE_ANCHOR_API`, `USE_SCENE` and `HEADSET_CAMERA` as runtime permissions. `ViroXRSceneNavigator` requests them before launching even in a fully virtual scene. They are blocked in this build, so the request should be denied without a prompt. Viro catches any failure and launches anyway. This has not yet been observed on a headset.
- Hand tracking is off and its permission is blocked. Use controllers for the Exit target. The Back button, Home and the system menu also exit.
