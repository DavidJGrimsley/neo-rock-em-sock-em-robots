# Quest 02 arena menu

Stage 02 replaces the stage 01 reference cube with an in-headset menu and a fixed virtual ring. It is not a fight, and it has not been worn on a headset. Branch 01's device gate is also still pending. Neither stage is merged.

The 2D route at `/quest-vr` is only the launcher. Solo, Ready, Back, and Exit are inside the existing `ViroXRSceneNavigator` scene. There is one OpenXR session, the one stage 01 already opens. Passthrough stays off. Solo still places both robots in the ring.

## Why the medical-viewer compositor is not used

Reference, not a dependency: `medical-viewer-main/native/quest-compositor/` and `tools/quest/build-compositor.mjs`. That prototype is unmerged. Its README says texture orientation, occlusion, pointer alignment, and readability still need a headset.

What the reference actually does:

- Android Canvas rasterizes a panel in the app-owned `QuestPanelModule`.
- The pixels are uploaded from `MedicalQuestPanel.h` into an `XrCompositionLayerQuad`.
- `build-compositor.mjs` inserts that quad **before** the comment `Projection layer (3D scene)` in `VROSceneRendererOpenXR.cpp`.
- The quad uses `XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT`.
- A Viro depth-only rectangle is supposed to leave a transparent hole in the projection layer so the underlay shows through. The medical scene turns passthrough on (`passthroughEnabled={true}`).
- The build clones ViroCore `v3.0.3` at `23710240d2cab5d4e866f3dba44ef568d8e563b4`, compiles arm64, and replaces `libviro_renderer.so` inside the installed renderer AAR. The header is app-owned. The renderer binary is not.

With passthrough off, the projection layer is cleared opaque and submitted after the quad. An opaque projection layer covers an underlay. This app's Quest config keeps `passthroughCamera: false` and `passthroughEnabled={false}`. This branch does not set `QUEST_COMPOSITOR_UI`, does not copy the medical AAR, and does not patch the projection-layer hole or the GL color mask.

The menu still follows the medical viewer's JavaScript input idea: a trigger press is `clickState === 1`, and hover is baked into the same texture as the button.

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

The panel is 1.6×0.9 m at z = -1.15. The menu page is `(0, 0.08, -1.15)`. The ring page is `(0, 0.52, -1.15)`. The ring stays at `(0, -0.55, -2.1)`. Buttons are 540×256 px with a 128 px gap, which is 0.20 m tall and 0.10 m apart. That is larger than a 3° trigger tilt at this distance. Hit quads use the same rectangles, sit 12 mm in front, write no color, and do not write depth.

Page changes drop the old texture in the same update. A raster is applied only if its generation is still current. Each file URI gets its own material name. Hover is baked into the PNG at the button rectangle, and the previous PNG is kept until the new one is ready so hover does not blank the panel.

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
- Release APK: `%TEMP%\nrq-apks\app-release.apk` (137,269,925 bytes, 2026-11-19 16:08 UTC). Debug APK is beside it (118,904,436 bytes). TEMP can delete both. Neither APK was installed.

The earlier stock-renderer APK from `c68a65a` does not validate this menu or this pointer patch.

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

## Known limits

- No headset observation for branch 01 or branch 02. The APKs above were not installed.
- Head gaze still moves the reticle when no controller ray is tracked. The left controller does not move the reticle until its own trigger goes down.
- There is no controller model. The origin marker is a sphere, not a licensed controller mesh.
- Public-tag rebuilds omit ReactVisionCCA and the ARCore image-tracker JNI that the published binary has. Phone builds keep the published binary.
- Tabletop scale, side view, idle animation only.
- Combat, locomotion, passthrough, and multiplayer are out of scope.
