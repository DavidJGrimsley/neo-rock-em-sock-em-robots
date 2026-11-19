# Quest 02 arena menu

Stage 02 replaces the stage 01 reference cube with an in-headset menu and a fixed virtual ring. It is not a fight, and it has not been worn on a headset. Branch 01's device gate is also still pending. Neither stage is merged.

The 2D route at `/quest-vr` is only the launcher. Solo, Ready, Back, and Exit are inside the existing `ViroXRSceneNavigator` scene. There is one OpenXR session, the one stage 01 already opens. Passthrough stays off.

## Why the medical-viewer compositor is not used

Reference, not a dependency: `medical-viewer-main/native/quest-compositor/` and `tools/quest/build-compositor.mjs`. That prototype is unmerged. Its README says texture orientation, occlusion, pointer alignment, and readability still need a headset.

What the reference actually does:

- Android Canvas rasterizes a panel in the app-owned `QuestPanelModule`.
- The pixels are uploaded from `MedicalQuestPanel.h` into an `XrCompositionLayerQuad`.
- `build-compositor.mjs` inserts that quad **before** the comment `Projection layer (3D scene)` in `VROSceneRendererOpenXR.cpp`.
- The quad uses `XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT`.
- A Viro depth-only rectangle is supposed to leave a transparent hole in the projection layer so the underlay shows through. The medical scene turns passthrough on (`passthroughEnabled={true}`).
- The build clones ViroCore `v3.0.3` at `23710240d2cab5d4e866f3dba44ef568d8e563b4`, compiles arm64, and replaces `libviro_renderer.so` inside the installed renderer AAR. The header is app-owned. The renderer binary is not.

Reproducibility of that renderer is the script plus JDK 17, Android SDK, NDK 27.1.12297006, a ViroCore checkout, and on Windows a short Gradle home (`QUEST_GRADLE_HOME`, default `<drive>:\mvq-ui-gradle`). This branch did not run that script, did not copy `viro_renderer-release.aar`, and does not set `QUEST_COMPOSITOR_UI`.

With passthrough off, the projection layer is cleared opaque and submitted after the quad. An opaque projection layer covers an underlay. The hole technique depends on projection-layer alpha and on an environment blend that reveals layers behind it. This app's Quest config keeps `passthroughCamera: false` and `passthroughEnabled={false}`. Adopting the patched AAR would also replace the renderer this app does not own, inside `node_modules`, for every Quest build. That is the wrong ownership boundary for an unvalidated prototype. The underlay is not treated as proven.

## What this branch renders instead

Stock `@reactvision/react-viro` 3.0.3, unchanged. The menu is a 2048×1152 PNG on a quad in the projection layer, so it is visible in fully immersive VR. `modules/quest-menu-texture` is an Android-only Expo module. It draws the shared layout with Android Canvas and writes a cache PNG. It does not load `libviro_renderer`, create an `XrSession`, or submit a composition layer.

`quest-menu-layout.ts` is the geometry source for both the PNG operations and the controller targets. Targets are Viro quads with `colorWriteMask: ['None']` (the stock 3.0.3 Android material bridge reads that array) and a fragment modifier that writes transparent black if the mask is ignored. They sit 12 mm in front of the texture. A hover highlight is a separate translucent quad. Button rectangles do not overlap.

The ring uses the existing `Fight_Arena.glb`, `Mike_Player1_Blue_Combat_AR.glb`, and `Mike_Player2_RedOrange_Combat_AR.glb` at `ARENA_LAYOUT` scale. Its origin is fixed at `(0, -0.55, -2.1)`. The menu is world-fixed, upright, and not parented to the headset: `(0, 0.12, -1.4)` on the menu page and `(0, 0.58, -1.4)` above the ring. Robots stay at tabletop simulation size. Human scale and a first-person head rig belong to stage 03. From the origin you see both robots from the side, not from inside one of them.

IdleAggro playback is presentation only. The scene does not call `tick`, so the CPU opponent does not advance.

## Solo, Ready, Back, Exit

Solo constructs `new ArenaMatch('solo')`, attaches one local lease, and calls `setLandscape(true)` because the immersive activity is already the playable orientation. It does not call `setTracking` or `setPlacement`. A fixed ring is not an observed AR plane, and OpenXR view tracking is not the phone scene's `TRACKING_NORMAL` signal. The controller's own message therefore remains "Move slowly in a well-lit space until tracking is stable." The menu says that tracking was not marked ready and that the ring is not an AR plane.

Ready calls `ArenaMatch.ready()` when `canReady` is false. That returns false and leaves the stage at `lobby`. When `canReady` is true, Ready does not call it: that call would set local ready, and the next tick would start the solo countdown and a CPU fight. This stage has no punch, block, or movement controls. If `ready()` ever returned true while `canReady` was false, the session calls `invalidatePlacementReady()` so local ready does not stick.

Back disposes the match and returns to the headset menu. Exit disposes the match and calls `exitVRScene()`. Scene unmount disposes again. Asset callbacks carry a lease so a load from the previous match cannot mark the next one. A 30 s timer reports the first missing GLB through the existing `assetFailed` path and does not close the OpenXR session.

Phone and iOS arena screens are unchanged. The module is Android-only, so iOS autolinking does not gain a pod. A phone Android prebuild will see the module and will not open it unless the Quest scene loads. Quest Enter stays disabled off-device. `app.config.ts` plugins are unchanged.

## Build

Use `docs/quest-01-dev-build.md` for the short-path Windows build, release APK, permissions, and logs. Extra rules for this stage:

- Do not set `QUEST_COMPOSITOR_UI`.
- Do not replace `libviro_renderer.so`.
- `QUEST_BUILD=1` remains the only Quest switch.
- The menu module is autolinked from `modules/quest-menu-texture` during prebuild. Its Android project is `native/`, not `android/`, because this repo ignores every directory named `android`. No separate native build step.
- JavaScript `npm run build:android` (`expo export`) does not compile this module and is not a headset test.

Renderer in the APK: the stock Viro 3.0.3 library from `node_modules/@reactvision/react-viro`. Confirm the packaged library is that dependency and not a patched AAR before installing.

A staged arm64 debug and release build of rebased commit `c68a65a97ddeb4abb06bc00ebb91b7c5ca9f8d48` on 2026-11-18 did that check. `libviro_renderer.so` in both APKs matched `viro_renderer-release.aar` (SHA-256 `2b3280493c4a788cc14319e263f1c2769bf3e54b22c9e4cc7673319967ccacd4`). `QuestMenuTextureModule` was in the generated Expo package list. `MainApplication` uses `ViroPlatform.QUEST`, and the generated `VRActivity` includes the Quest 01 resume patch. The release APK was not installed. That compile is not a headset result. An earlier APK from before the rebase does not validate this commit.

## Headset checklist

Both gates below are **pending**. A passing JS test or a successful native compile does not close them.

Record the git SHA, headset model, OS build, and whether the APK was release or debug.

Branch 01, still pending:

1. Home → Quest VR Runtime → Enter VR. The launcher is not the game menu.
2. Exit with the in-scene Exit control, then with the controller Back button.
3. Enter, press Meta/Home, reopen, and use Re-enter VR if the scene is paused or the panel is showing.
4. Repeat enter and exit. `VRActivity` should exist only while the scene is open, and the process should not restart.

Branch 02, pending, after those:

1. Enter VR. Read Solo and Exit on the textured panel without leaning into a blurry Viro text menu. Note PNG orientation and whether the panel is readable at `(0, 0.12, -1.4)`.
2. Aim at Solo and pull the trigger. The ring and both robots appear. The menu moves up. Look down slightly for the ring. Both robots should be visible from the side at tabletop scale. There should be no passthrough, floor-scan prompt, or room anchor.
3. Aim at Ready. The match stays in the lobby. The panel says tracking was not asserted and the fight did not start. Robots must not begin punching.
4. Aim at Back. The ring disappears and the menu returns. Enter Solo again. Assets from the first visit must not be required for the second.
5. Aim at Exit. The launcher returns. The process stays up. Enter again and confirm Solo still starts from a clean lobby.
6. If a GLB fails, the panel shows the arena or fighter load error and VR stays open.
7. From logcat, confirm there is no second OpenXR session and no `MedicalQuestPanel` line.

Pointer alignment of the invisible targets is unverified until step 2 succeeds on a headset. If the aim point misses the printed buttons, the shared layout is wrong or the PNG is flipped. Do not paper over that by moving only the hit quads.

## Known limits

- No headset observation for branch 01 or branch 02.
- Tabletop scale, side view, idle animation only.
- The AR controller sentence about tracking is intentional and unmet.
- `colorWriteMask` hits and PNG-versus-GL orientation are unverified on device.
- Hover redraws a quad, not a new PNG. The PNG updates when the page or status lines change.
- Combat, locomotion, passthrough, and multiplayer are out of scope.
