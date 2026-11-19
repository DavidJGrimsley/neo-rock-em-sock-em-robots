# Quest 02 arena menu

Stage 02 replaces the stage 01 reference cube with an in-headset menu and a fixed virtual ring. It is not a fight, and it has not been worn on a headset. Branch 01's device gate is also still pending. Neither stage is merged.

The 2D route at `/quest-vr` is only the launcher. Solo, Ready, Back, and Exit are inside the existing `ViroXRSceneNavigator` scene. There is one OpenXR session, the one stage 01 already opens. Passthrough stays off. Solo still places both robots in the ring.

## Medical-viewer compositor: evaluated, not adopted in this stage

Reference, not a dependency: `medical-viewer-main/native/quest-compositor/` and `tools/quest/build-compositor.mjs`. That prototype is unmerged. Its README says texture orientation, occlusion, pointer alignment, and readability still need a headset.

What the reference actually does:

- Android Canvas rasterizes a panel in the app-owned `QuestPanelModule`.
- The pixels are uploaded from `MedicalQuestPanel.h` into an `XrCompositionLayerQuad`.
- `build-compositor.mjs` inserts that quad **before** the comment `Projection layer (3D scene)` in `VROSceneRendererOpenXR.cpp`.
- The quad uses `XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT`.
- A Viro depth-only rectangle is supposed to leave a transparent hole in the projection layer so the underlay shows through. The medical scene turns passthrough on (`passthroughEnabled={true}`).
- The build clones ViroCore `v3.0.3` at `23710240d2cab5d4e866f3dba44ef568d8e563b4`, compiles arm64, and replaces `libviro_renderer.so` inside the installed renderer AAR. The header is app-owned. The renderer binary is not.

Passthrough is not what makes that work, and it does not rule the approach out for this fully immersive scene. In ViroCore v3.0.3, `VROSceneRendererOpenXR.cpp` gives the projection layer `XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT` only `if (_passthroughEnabled)`. `setPassthroughEnabled` also switches the display clear alpha from 1 to 0. The same flag and the same clear can be set by a Quest patch with passthrough off. Two adaptations are possible, and neither has been built or worn:

- **Underlay.** Submit the panel quad before the projection layer, give the projection layer source-alpha blending, clear alpha to 0, and leave a depth-only hole the size of the panel.
  - The skybox and scene keep alpha 1 elsewhere. The ray and hit dot stay in the projection layer, in front of the hole, and depth-tested.
  - Risk: anything that writes alpha below 1 inside the hole (bloom, HDR tone mapping, alpha-blended materials) lets the panel bleed through.
- **Overlay.** Submit the panel quad after the projection layer. No hole is needed.
  - Risk: the compositor draws it over the ray and hit dot, so the pointer would need its own layer or `XR_FB_composition_layer_depth_test` with depth submission.

What either path would gain: the compositor samples the Canvas pixels once at display resolution, so text is sharper than a mipmapped texture in Viro's HDR projection pass. This build's logcat shows `HDR enabled: 1` and "No gamma correction enabled in tone-mapper", and Constant white came out about 227/255 in the user's capture. What it costs: a second renderer patch on top of the pointer patch, swapchain lifetime and orientation code, and its own headset gate. The medical viewer's own README still lists texture orientation, occlusion, pointer alignment, and readability as unverified.

Stage 02 keeps the panel in the projection layer, with the readiness fix below, so the branded menu can be judged on the headset first. The same Canvas ops, the 2048×1152 pixel rectangles, and the hit frames would carry over to either layer path unchanged. This branch does not set `QUEST_COMPOSITOR_UI` and does not copy the medical AAR.

The menu still follows the medical viewer's JavaScript input idea: a trigger press is `clickState === 1`, and hover is baked into the same texture as the button. Error-panel text uses the medical viewer's headset text scale: `ViroText` at scale 0.05, with the box given in scaled units.

## Quest-only OpenXR pointer patch

The stock OpenXR laser ignores the depth buffer, so it draws through the menu, and it has no origin at the controller. Head gaze is source 12 and is processed after both hands, so it was leaving the reticle on the head pose. Documenting that laser was not accepted.

`tools/quest/viro-renderer/0001-openxr-pointer-depth-origin-reticle.patch` is a small patch against public ViroCore `v3.0.3` (`23710240d2cab5d4e866f3dba44ef568d8e563b4`). It changes only the OpenXR presenter:

- The beam, a white origin sphere (radius 7 mm), and a cyan hit sphere (radius 6 mm) read depth and do not write it. Rendering order is 100000. The beam is 4 mm thick and is not hittable.
- The hit dot is pulled 8 mm back toward the origin so it does not z-fight the surface. A background miss keeps the 4 m beam and draws no dot.
- The reticle follows the controller whose trigger went down last (right controller until then). Sources are `ViroOculus::Controller` (1) and `ViroOculus::LeftController` (4). Head gaze moves the reticle only while no controller ray is tracked.
- The left controller's hit dot updates immediately. Its reticle does not move until that controller's trigger goes down.
- Click grace (150 ms), hover hysteresis (75 ms), trigger thresholds, and `rayForSource` are unchanged.
- There is no JNI, Java, or JavaScript API change, and no controller model.

The patch is kept in-tree so it can be contributed upstream later. No upstream pull request was opened. `node_modules` and the phone/iOS renderer stay the published 3.0.3 binary.

`node tools/quest/build-viro-renderer.mjs --pristine` rebuilds the public tag with no patch. `node tools/quest/build-viro-renderer.mjs` then applies the patch and packages `native/quest-viro-renderer/`, which is gitignored. Quest prebuild (`QUEST_BUILD=1`) points `project(':viro_renderer')` at that directory. Phone prebuild leaves the stock `node_modules` project.

The published `libviro_renderer.so` is not reproducible from the public tag. It links proprietary `libreactvisioncca.so` and exports ARCore image-tracker symbols whose headers and implementations are not in the tag. An unpatched rebuild has the same gap. The patched library matches that unpatched rebuild except for the pointer symbols. A different hash from the published binary is not, by itself, an ABI break. The packaging script refuses a machine or SONAME mismatch, a JNI or `NEEDED` regression against the pristine rebuild, or a missing stock export that the pristine rebuild still has. The `updateAimRay` signature change (one extra bool) is the intended exception.

Measured on 2026-11-19 with NDK `27.1.12297006` and JDK 17.0.16. The second patched link reproduced the first patched hash.

| Binary | SHA-256 | Bytes | Build id |
| --- | --- | --- | --- |
| Published stock `libviro_renderer.so` | `2b3280493c4a788cc14319e263f1c2769bf3e54b22c9e4cc7673319967ccacd4` | 7312144 | `2a9996b6ce649de8dbf55b1d029efc7af8735506` |
| Pristine public-tag rebuild | `7d35cb1521d2c2358d6e8a3595234d8226e91adbab864fc5992feefb5b7931ab` | 7112240 | `714aab913706bef29d8778d3cdc0dedc439e8c20` |
| Patched Quest renderer | `182db849a9a7a59db6d2abb4535fa8c93956c4820edd8bd447beb1c90a27872e` | 7115456 | `0f0b5ef5add6046cde73125294c0c80446ec82c5` |

All three are AArch64 and their SONAME is `libviro_renderer.so`. Stock `NEEDED` includes `libreactvisioncca.so`. Pristine and patched do not, and they match each other. Both public-tag builds omit the same 12 JNI symbols: five `CameraTexture` methods, `RendererARCore.nativeCreateARCoreSession`, and six `ImageTracker` / `ImageTrackerOutput` methods. Quest OpenXR does not call those classes. The phone APK is not rebuilt with this library.

The only export difference between pristine and patched is the old 4-argument `updateAimRay` versus `createMarker`, the 5-argument `updateAimRay`, and `configurePointerMaterial`. The Quest AAR (`b7dba41e065ec3087fb53838e8225e79f61de8b5ab9be2ea844f207e6afec0f5`) contains arm64 only. Patch SHA-256 is `68135af44bf38ab883e9ed30732d761f58637595ecebcbe9b4f78c41e5642415`.

## What the headset scene renders

The menu is a 2048×1152 PNG on a world-fixed quad in the projection layer. `modules/quest-menu-texture` draws it with Android Canvas. It loads the phone Noto fonts and the pre-rasterized title PNGs in `assets/arena/ui/quest-lettering/` (`neo.png`, `rock.png`, `robots.png`), taken from the phone lettering SVGs at the phone blue `#60a5fa` and violet `#a78bfa`. It also draws `menu-background.png`. It does not load `libviro_renderer`, create an `XrSession`, or submit a composition layer.

The panel is 1.6×0.9 m at z = -1.15. The menu page is `(0, 0.08, -1.15)`. The ring page is `(0, 0.52, -1.15)`. The ring stays at `(0, -0.55, -2.1)`. Buttons are 540×256 px with a 128 px gap, which is 0.20 m tall and 0.10 m apart. That is larger than a 3° trigger tilt at this distance. Hit quads use the same rectangles, sit 12 mm in front, and do not write depth. Their material sets `colorWriteMask` None, writes zero alpha in the fragment, and uses Alpha blending. If the OpenXR per-eye clear resets the colour mask, the quads still draw nothing; with blendMode None and passthrough off, they would paint black. Viro hit tests geometry and only checks `_selectable`, so a fully transparent quad still receives the ray (`VRONode::hitTest`, virocore v3.0.3).

`src/features/quest-vr/quest-menu-texture-pipeline.ts` turns each menu spec into a Viro material, one at a time:

1. Canvas draws the PNG.
2. `prepareMaterial` in the native module registers it with Viro's `MaterialManager` on the native-modules thread, which is the thread `ViroMaterials.createMaterials` uses.
3. That call resolves only after Viro returns a diffuse texture the size of the file. If Viro gives back no texture or the wrong size, the material is deleted and the call rejects with the reason.

Only then may a quad name the material. The scene never calls `ViroMaterials.createMaterials` for panel art.

The panel shows a *screen*: the page plus the Ready acknowledgement. Art, pose, and hit targets all come from the displayed screen. When the player changes screen (Solo, Ready to Set, Back), the old art stays at the old pose and the hit targets are removed until the new art is registered. Pressed triggers and hover are cleared whenever the displayed screen or input state changes.

A failed draw or registration for the requested screen shows a dark error panel, not Viro's white default. That panel carries the reason and the session lines, uses colour-only button quads, and keeps live hit targets so Exit still works. A draw or registration that takes longer than 15 s becomes that error. A late result is released.

Hover is baked into the PNG. Requests coalesce to the newest spec. At most three menu materials are registered at once: the shown one, the one before it, and one in flight. Their PNG files are kept, because Viro re-reads every registered material's file when a scene navigator detaches. Every other material is deleted with `MaterialManager.deleteMaterials`, together with its file. Leaving the scene releases everything. A mounted quad keeps its own reference after its material is deleted.

Colors follow the phone dark theme: background `#09090b`, card `#E818181B`, tagline pill `#A809090B`, primary `#60a5fa`, danger `#d99a9a` with near-black text, and Back in black with white text plus a light ring. The tagline is "Bring the fight to your table." Action words stay Solo, Ready, Back, and Exit. After Ready is acknowledged, the Ready button reads Set.

The ring uses the existing `Fight_Arena.glb`, `Mike_Player1_Blue_Combat_AR.glb`, and `Mike_Player2_RedOrange_Combat_AR.glb` at `ARENA_LAYOUT` scale. IdleAggro playback is presentation only. The scene does not call `tick`.

## Solo, Ready, Back, Exit

Controller trigger input is `clickState === 1` from source 1 or 4 only. Grip, face buttons, the controller Back button (source 3), head gaze (source 12), repeated down, and `CLICKED` (3) do not activate a menu button. One press activates once, until click-up. The menu does not draw its own beam. The native patch above is the ray.

Solo constructs `new ArenaMatch('solo')`, attaches one local lease, and calls `setLandscape(true)` because the immersive activity is already the playable orientation. It does not call `setTracking` or `setPlacement`. The menu does not print the AR tracking sentence.

Ready does not call `ArenaMatch.ready()`. It records a lobby acknowledgement: "Ready saved. Both robots stay idle. Combat controls are not in this stage." The stage stays `lobby` and `localReady` stays false. A second press keeps that state and changes the button label to Set. Back clears it. Ready does not play `ready.wav` and does not claim a fight or headset tracking.

Back disposes the match and returns to the headset menu. Exit always calls `session.exit()` and `exitVRScene()`, including when an exit request was already recorded. The panel says "Leaving the headset…" while the scene is still up. Scene unmount disposes again. Controller Back/Menu still exits through Viro's VR `BackHandler` and `onExitViro`, not through the menu filter. Re-entry still uses the Quest 01 lifecycle: a fresh scene mount clears the exit request when the status is not already immersive.

Asset callbacks carry a lease so a load from the previous match cannot mark the next one. A 30 s timer reports the first missing GLB through the existing `assetFailed` path and does not close the OpenXR session.

Phone and iOS arena screens are unchanged. The texture module is Android-only. Quest Enter stays disabled off-device.

## Build

Use `docs/quest-01-dev-build.md` for the short-path Windows build, release APK, permissions, and logs. Extra rules for this stage:

- Build the renderer first, from this repo, with JDK 17, Android SDK, and NDK `27.1.12297006`. Do not reuse another project's ViroCore checkout.
- `node tools/quest/build-viro-renderer.mjs --pristine`
- `node tools/quest/build-viro-renderer.mjs`
- Do not set `QUEST_COMPOSITOR_UI`.
- Do not write the patched library into `node_modules`.
- `QUEST_BUILD=1` remains the only Quest switch. The generated `android/settings.gradle` then points `:viro_renderer` at `native/quest-viro-renderer`.
- The menu module is autolinked from `modules/quest-menu-texture`. Its Android project is `native/`, not `android/`.
- JavaScript `npm run build:android` (`expo export`) does not compile this module and is not a headset test.
- Copy `native/quest-viro-renderer/` into a short-path stage. `git ls-files` skips it because it is gitignored.

`npm test` on 2026-11-19 exited 0: lint, typecheck, `test:ar` 14, `test:app` 363, `test:quest` 27, `test:ui` 16, and `test:dependencies` 3.

Quest native build the same day, staged at `%TEMP%\nrq-w` from the working tree, JDK 17.0.16, NDK `27.1.12297006`, CMake via `tools/quest/short-cmake.gradle`:

- `QUEST_BUILD=1 npx expo prebuild -p android --clean --no-install` pointed `:viro_renderer` at `../native/quest-viro-renderer` and set `ReactViroPackage.ViroPlatform.QUEST`.
- `gradlew :app:processDebugManifest :app:processReleaseManifest :app:assembleDebug :app:assembleRelease -PreactNativeArchitectures=arm64-v8a -I ..\tools\quest\short-cmake.gradle` — `BUILD SUCCESSFUL in 3m 23s`.
- Generated `VRActivity.kt` contains `supersededByOtherActivity` and `questVRActivityState`.
- `ExpoModulesPackageList.kt` contains `expo.modules.questmenutexture.QuestMenuTextureModule`.
- `libviro_renderer.so` in both `app-release.apk` and `app-debug.apk` is the patched hash above, 7115456 bytes. The stock AAR in the staged `node_modules` and in the worktree stayed `2b3280493c4a788cc14319e263f1c2769bf3e54b22c9e4cc7673319967ccacd4`.
- A second prebuild with `QUEST_BUILD` unset pointed `:viro_renderer` at `../node_modules/@reactvision/react-viro/android/viro_renderer` and set `ViroPlatform.AR`. That phone tree was not assembled.
- Release permissions: `INTERNET`, `MODIFY_AUDIO_SETTINGS`, `VIBRATE`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, and `com.djleg.neorobots.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. Camera, autofocus, accelerometer, and gyroscope are `required=false`. OpenGL ES 3.0 (`0x00030000`) and `android.hardware.vr.headtracking` are `required=true`. Hand tracking, passthrough, `android.software.vr.mode`, and `android.hardware.vr.high_performance` are `required=false`. `com.google.ar.core` is `optional`. `com.oculus.supportedDevices` is `quest3|quest3s`. Activities include `MainActivity` and `VRActivity`.
- Release APK: `%TEMP%\nrq-apks\app-release.apk` (137,269,925 bytes, SHA-256 `fda2d67bddce372ffabbf05813832ed907c877c2616fe9c83b786d92880816da`, 2026-11-19 16:08 UTC). Debug APK is beside it (118,904,436 bytes). That release was later installed on the Quest. It is the build that showed the clipped "Menu" panel.

The earlier stock-renderer APK from `c68a65a` does not validate this menu or this pointer patch.

## Release texture regression

The worn screenshot of that installed release is a dark panel and the clipped word "Menu". That is the scene's `ViroText` fallback. Its string starts with "Menu texture failed." and its font size was 28 points on a metre-sized quad, so the rest of the error was clipped. It is not the 2048×1152 branded PNG.

The installed APK was byte-identical to the release above. `libviro_renderer.so` inside it was the patched hash `182db849a9a7a59db6d2abb4535fa8c93956c4820edd8bd447beb1c90a27872e`. The public-tag JNI gap did not cause this panel. `QuestMenuTexture` is in the APK. A live `logcat` slice from the running VR process did not contain the texture exception, because the scene stored it in React state and did not log it. That slice did show one OpenXR layer at about 72 fps and controller "space not locatable" warnings. Those warnings do not produce the word "Menu".

`aapt2 dump resources` on that APK names the menu files as Android resources, and their bytes match the repo files:

| Resource | Packaged entry | Repo file |
| --- | --- | --- |
| `drawable/assets_arena_ui_menubackground` | `res/dw.png` | `assets/arena/ui/menu-background.png` |
| `drawable/assets_arena_ui_questlettering_neo` | `res/7X.png` | `assets/arena/ui/quest-lettering/neo.png` |
| `drawable/assets_arena_ui_questlettering_rock` | `res/yq.png` | `assets/arena/ui/quest-lettering/rock.png` |
| `drawable/assets_arena_ui_questlettering_robots` | `res/0W.png` | `assets/arena/ui/quest-lettering/robots.png` |
| `raw/assets_arena_ui_arenanotosans` | `res/EP.ttf` | `assets/arena/ui/ArenaNotoSans.ttf` |
| `raw/assets_arena_ui_arenanotosanssemibold` | `res/00.ttf` | `assets/arena/ui/ArenaNotoSansSemibold.ttf` |
| `raw/assets_arena_ui_arenanotoserif` | `res/F6.ttf` | `assets/arena/ui/ArenaNotoSerif.ttf` |

PNG width and height match. None of these paths is a loose file under `assets/`. In a release build, `expo-asset` marks an image with a size as already downloaded and sets `localUri` to the drawable name, such as `assets_arena_ui_menubackground`. `Asset.downloadAsync()` then returns without copying. `BitmapFactory.decodeFile` cannot open a resource name, so the canvas throws "Menu texture image could not be decoded." Fonts do not take that shortcut, but the background image fails first.

The scene now copies a non-file URI through `ExpoAsset.downloadAsync` before drawing. The canvas module also opens a raw or drawable resource, or `file:///android_res/`, and caches the bytes under `quest-menu-src`. A real `file:` URI is used as-is. Failures are logged as `Quest menu texture failed:`. The fallback text is 4 points so a later failure is not only the word "Menu".

`npm test` after this change exited 0. `test:quest` is 29, including the release resource names and a read of the release APK's packaged PNG and font bytes.

Quest rebuild at `%TEMP%\nrq-w`, same renderer AAR, JDK 17.0.16, NDK `27.1.12297006`: `QUEST_BUILD=1 npx expo prebuild -p android --clean --no-install`, then the documented Gradle release and debug assemble. `BUILD SUCCESSFUL in 6m 35s`. The new release is 137,289,097 bytes, SHA-256 `02b17343c8b2b49b2910f037bf94a0dd5fb4dd75b992f3823aee30157dd56b63` (2026-11-19 22:42 UTC). It still contains the patched `.so` hash above. Its JavaScript bundle contains `Menu asset did not copy to a file`. The debug signing certificate SHA-256 is `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`, the same certificate as the installed app.

Exactly one device was attached: serial `3487C10J3706TQ`, model Quest 3S, device `panther`, incremental `4183210015200610`. `adb install -r` of that release succeeded. The pulled `base.apk` matches the hash above. `firstInstallTime` stayed `2026-11-18 19:01:45`. `lastUpdateTime` became `2026-11-19 17:43:55`. There was no uninstall and no data clear. Starting `MainActivity` reached `ReactNativeJS: Running "main"` (pid 22490) with no fatal exception in the sampled log. That launch is the 2D launcher, not the VR menu. The release package is not debuggable, so the generated cache PNG was not pulled. No worn view of this build was captured.

## White panel on the ed03ede release

The user's worn capture of release `02b17343…` (commit `ed03ede`) showed a flat light-grey panel-sized quad: no lettering, no buttons, no fallback text. The cause was found in logcat during a fresh VR entry on that installed build at 2026-11-19 18:32:21 device time. The capture was streamed live from the host, filtered to the app's uid, without clearing logs or changing buffer sizes:

```
18:32:21.564 22530 W ReactNativeJS: Quest menu texture 2048x1152 file:///…/cache/quest-menu/panel-75569709966940.png
18:32:21.568 22490 E VRTNodeManager: Error applying materials: Material [questMenu-f1c760af] not found. Did you create it?
18:32:21.634 29307 D [ImageDownloader.onNewResultImpl]: class …DefaultCloseableStaticBitmap
```

`questMenu-f1c760af` is the FNV name of that URI. The JS thread called `ViroMaterials.createMaterials` and then set state. Four ms later, the UI thread mounted the quad and Viro could not find the material. Viro's own decode of the same PNG succeeded 66 ms after that. Viro then logs the error and does not retry, so the quad keeps Viro's default material: Constant, white, with no texture. The same sequence happened for all three textures drawn on that entry (`questMenu-28b4013c`, `questMenu-a5f271af`).

The same entry also logged `Viro-ImageDownloader: Could not download image at: …/panel-73432860725734.png` on the UI thread. That is a menu material from the previous VR entry. `VRT3DSceneNavigator.onDetachedFromWindow` sets `MaterialManager.shouldReload`, and the next lookup re-creates every registered material from its file, which had already been deleted. That stale material was not on screen, but each one costs a synchronous decode attempt on the UI thread.

What the logs rule out:
- **Fresco failure on the shown texture.** Its decode succeeded.
- **A bad Canvas PNG.** The draw resolved, and a uniform colour across the whole panel cannot come from that photo-backed art.
- **The pointer patch.** It is input-only.
- **The renderer.** It reported `HDR enabled: 1` and "No gamma correction enabled in tone-mapper", which is why Constant white was captured near 227 rather than 255.

Verified in the installed Viro bridge (`react_viro-release.aar`, javap):
- `setJSMaterials` is an async `@ReactMethod`, and `loadMaterials` only replaces the map entry. Re-defining one material name therefore does not update a quad that is already mounted.
- `ViroImage` would load its own texture, but until the placeholder or image arrives its quad shows the untextured material, which is white by default. Its default placeholder, `viro_blank.png`, is 128×128 white at alpha 0.

The fix registers and checks the material natively before the quad is mounted (see "What the headset scene renders"), and releases menu materials so they are not re-created from deleted files.

Build of commit `5fcd3e3`, staged at `%TEMP%\nrq-w` from the working tree:
- `npm test` exited 0: lint, typecheck, `test:ar` 14, `test:app` 363, `test:quest` 40, `test:ui` 16, `test:dependencies` 3.
- `QUEST_BUILD=1 npx expo prebuild -p android --clean --no-install`, then `gradlew :app:processReleaseManifest :app:assembleRelease -PreactNativeArchitectures=arm64-v8a -I ../tools/quest/short-cmake.gradle`, finished with `BUILD SUCCESSFUL`.
- The first assemble failed in `:quest-menu-texture:compileReleaseKotlin` because the module had no `com.facebook.react:react-android` dependency. That dependency is now declared, as `expo-asset` does, and a test checks for it.
- Release APK: 137,296,705 bytes, SHA-256 `90065614387039383122abd6e45471347092b887c995607fa6fb5c6854025019`. Contents:
  - V2 signer certificate `fac61745…9b8332667591033b9c`, the same as the installed app.
  - Patched `libviro_renderer.so` `182db849…`.
  - The embedded bundle contains `prepareMaterial`, `releaseMaterials`, and `Menu art did not load`.
  - The dex contains `VRTMaterialManager`, `getDiffuseTexture`, and `runOnNativeModulesQueueThread`.
  - The manifest is not debuggable.
- Install: on 2026-11-19 18:36:56 device time, `adb install -r` on Quest 3S `3487C10J3706TQ` succeeded. The pulled `base.apk` has the hash above. `firstInstallTime` stayed `2026-11-18 19:01:45`. There was no uninstall and no data clear.

These checks prove what the APK contains. They do not prove what the headset shows.

## Headset checklist

Both gates below are **pending**. A passing JS test or a successful native compile does not close them. This document does not claim a worn test.

Record the git SHA, headset model, OS build, and whether the APK was release or debug.

Branch 01, still pending:

1. Home → Quest VR Runtime → Enter VR. The launcher is not the game menu.
2. Exit with the in-scene Exit control, then with the controller Back button.
3. Enter, press Meta/Home, reopen, and use Re-enter VR if the scene is paused or the panel is showing.
4. Repeat enter and exit. `VRActivity` should exist only while the scene is open, and the process should not restart.

Branch 02, pending, after those:

1. Enter VR. The panel shows the phone title lettering, the tagline, Solo, and Exit. It should be readable at `(0, 0.08, -1.15)` without a blurry Viro text menu.
2. The controller ray should start at the controller, stop at the panel instead of drawing through it, and show a hit dot on the button. Hover should sit on the same button as the art.
3. Pull the trigger on Solo. The ring and both robots appear. The menu moves up. There should be no passthrough, floor-scan prompt, or room anchor. Grip, face buttons, and head gaze should not press Solo.
4. Pull the trigger on Ready. The match stays in the lobby. The panel says ready was saved and combat controls are not in this stage. The button reads Set. Robots must not start punching. A second press stays in that state.
5. Aim at Back. The acknowledgement clears, the ring disappears, and the menu returns. Enter Solo again.
6. Aim at Exit. The panel says it is leaving, then the launcher returns. Enter again and confirm Solo still starts from a clean lobby. Repeat with the controller Back button.
7. If a GLB fails, the panel shows the arena or fighter load error and VR stays open.
8. From logcat, confirm there is no second OpenXR session and no `MedicalQuestPanel` line.
9. Stream logcat for the app uid from the host before entering VR. Expected lines per screen:
   - `ReactNativeJS: QuestMenu drawn …` with three probe pixels.
   - `QuestMenuTexture: prepared questMenu-… 2048x1152`.
   - `QuestMenu shown <page> questMenu-…`.

   Then `QuestMenu hover <action> true source 1|4` while aiming, and `QuestMenu click … activate` once per trigger press. There must be no `Error applying materials` line and no `Could not download image` for a current panel file. If the panel shows "Menu art did not load", copy its reason; the same reason appears as `QuestMenu … failed:` in logcat.

## Known limits

- No worn observation of the `5fcd3e3` menu. Earlier releases were worn:
  - `fda2d67b…` showed the clipped "Menu" fallback.
  - `02b17343…` (`ed03ede`) showed a white panel, explained above.

  The `5fcd3e3` release is installed. Its VR panel, ray, hover, and Solo/Ready/Back/Exit have not been seen. A "material prepared" or "shown" log line proves Viro holds the texture before the quad mounts, not that the panel is readable.
- Hover is baked into the PNG, so each hover change redraws and re-registers a 2048×1152 texture. Expect a visible delay before the highlight; it has not been measured on the headset.
- Viro's HDR tone mapper is on for this scene and compresses Constant colours (white was about 227/255). Brand colours may look slightly darker than on the phone.
- Head gaze still moves the reticle when no controller ray is tracked. The left controller does not move the reticle until its own trigger goes down.
- There is no controller model. The origin marker is a sphere, not a licensed controller mesh.
- Public-tag rebuilds omit ReactVisionCCA and the ARCore image-tracker JNI that the published binary has. Phone builds keep the published binary.
- Tabletop scale, side view, idle animation only.
- Combat, locomotion, passthrough, and multiplayer are out of scope.
