# Quest 04 controller input feasibility

Stage 04 adds a raw controller input bridge inside Viro's existing OpenXR session and in-headset diagnostics for it, on top of merged PR #3 (`8b7ef3b`). The API audit that chose this design is `docs/quest-controller-api-audit.md`. Nothing here has been worn on a headset. The **Stage 03** and **Stage 04** headset gates are both **pending**. Stage 04 investigation started before the Stage 03 gate, at the user's direction. Stages 05–09 must not start until the Stage 04 gate passes.

## What was built

- **`tools/quest/viro-renderer/0003-openxr-quest-input-sampler.patch`** (applies after 0001 and 0002; listed in `lock.json`).
  - **Capture & Sync:** `VROInputControllerOpenXR::syncQuestInput` runs once per frame **before** `VRORenderer::prepareFrame`, keeps the `xrSyncActions` result, and captures raw OpenXR actions before Viro's dead zone, click thresholds, 5-frame sticky pose and hand fallback.
  - **Render-thread markers:** `quest_input::updateMarkers` writes direct `VROQuaternion` poses onto render-thread blue/orange marker spheres and 15 cm aim rays inside `presenterRoot` before `prepareFrame()` (hiding lost poses, keeping yellow inferred indicators, and preserving session focus/validity checks). After `onProcess()`, `presenterRoot->computeTransforms(...)` updates `laser.origin` and `laser.hit` in the same frame.
  - **Sky diagnostics underlay (`quest_input::DiagLayer`):** second world-locked `XrCompositionLayerQuad` (2048×1152 at 1.8 m × 1.0125 m, 45° sky pose, GL sRGB, swapchain release on wait failure) submitted below `questPanel` and projection.
  - **Publish & Profiles:** `QuestInputSampler.h` publishes each synced frame into a 64-frame ring with sequence, generation, epoch, session state, `XrTime`, and `CLOCK_MONOTONIC` timestamps; interaction profiles refresh on `XR_TYPE_EVENT_DATA_INTERACTION_PROFILE_CHANGED`.
  - **Not added:** no second OpenXR session, action set, action, binding, space or extension.
- **`modules/quest-input`** (`QuestInputModule`, Android only, optional):
  - `isAvailable()`, `setMarkersEnabled(enabled)`, `read(afterSeq)`, `profiles()`, and off-thread Canvas rasterizer methods (`openDiagnostics`, `drawDiagnostics`, `statusDiagnostics`, `hideDiagnostics`).
- **`src/features/quest-vr/quest-diagnostics-layout.ts`:** 2048×1152 rounded-card sky diagnostics panel layout (`QUEST_DIAG_POSE = [0, 1.27, -1.27]`, pitch `[45, 0, 0]`, `questDiagPanelPose` `q_yaw * q_pitch`), explicit left/right thumbsticks, triggers, grips, buttons (`X`/`Y`/`Menu`/`A`/`B`/`Stick`/`TrigClick`), tracking badges (`TRACKED`/`INFERRED`/`LOST`), timing/epoch telemetry, developer prose, and `questDiagLayerMask` hole shader.
- **`src/features/quest-vr/quest-input-visualizer.native.tsx`:** activates zero-lag render-thread markers on patched Quest renderers (`setMarkersEnabled(true)`), falls back to `setNativeProps` only on phones/unpatched renderers, and mounts `QuestDiagnosticsPanel` across both `menu` and `ring` views. Every geometry sets `ignoreEventHandling`.
- **Tests:** `tests/quest-input.test.cjs`, run by `npm run test:quest`, covers decoding, handedness, flags, malformed input, timing, overruns, stale, unfocused, ended and unavailable states, generation versus recenter, loss and recovery, stick sweeps, throttling, the HUD, Euler round-trips, the cross-file layout and JNI contract, patch-scope guards, and scene wiring. `tests/quest-first-person.test.cjs` checks that the source starts on mount and stops on unmount.

Phone and iOS are unchanged. The module is Android-only, adds no permissions, and reports unavailable on the stock renderer. Phone prebuilds still use the stock `:viro_renderer`.

## Data contract (version 1)

Per sample there are three int64 values (seq, `XrTime`, `CLOCK_MONOTONIC`), then 15 ints, then 34 floats.

- **Ints:** sync result, session state, actions ready, generation, reference epoch; then per hand: locate result, location flags, velocity flags, active bits, button bits.
- **Floats per hand:** position (3), orientation `xyzw` (4), linear velocity (3), angular velocity (3), trigger, squeeze, stick x, stick y.
- **Hands:** the left hand is `/user/hand/left` and the right is `/user/hand/right`. They are separate Viro actions, so handedness comes from the binding.

The pose is the OpenXR **aim** pose in `LOCAL`, which is Viro's world space. Stage 05B fists will need the grip pose (an added binding) or a calibrated offset. That is not decided here: adding a binding changes the single shared suggest/attach that all Viro input depends on.

## Build and install (2026-11-20)

1. `node tools/quest/build-viro-renderer.mjs --pristine`, then `node tools/quest/build-viro-renderer.mjs`.
   - Set `QUEST_RENDERER_WORK` to a short path you own.
   - The patched build now also requires the three `QuestInputModule` JNI exports.
   - `with-quest-viro-renderer.cjs` rejects any renderer built without 0003, because the patch list in its provenance has to match `lock.json`.
2. `QUEST_BUILD=1` prebuild and the arm64 release APK, exactly as in `docs/quest-01-dev-build.md`.

On `C:` (`0.14 GB` free) and `F:` (`1.93 GB` free), space was insufficient, so the renderer work directory (`QUEST_RENDERER_WORK=D:\nrq04\viro`), Gradle user home (`D:\nrq04\gradle`), CMake staging (`QUEST_CXX_ROOT=D:\nrq04\cxx`), temp directory (`D:\nrq04\tmp`), and short-path stage (`D:\nrq04\w`) were placed on `D:` (`795.66 GB` free before build). Note: `JAVA_TOOL_OPTIONS` must not be set globally during the ViroCore CMake/Prefab configure step because AGP's Prefab parser fails (`CXX1210`) on the `Picked up JAVA_TOOL_OPTIONS` stderr line; setting `TEMP`/`TMP` alone keeps Java temp files on `D:` without breaking Prefab.

- **Tests:** `npm test` exited 0 before the build (`lint`, `typecheck`, `test:ar` 14, `test:app`, `test:quest` 88, `test:ui` 16, `test:dependencies` 3). `npm run test:quest` re-ran after renderer packaging and passed 88/88 (including `native/quest-viro-renderer/provenance.json` checks).
- **Renderer (`native/quest-viro-renderer/`):**
  - Pristine `libviro_renderer.so`: `7,110,160` bytes, SHA-256 `10761cfb1f4037e8c84b8bda9bbdd383aae76c354c98ed6f4b9670f62bc35a94`, Build ID `972eb1359b3cd7fe5924c4232fe5ea927220d194`.
  - Patched (`0001`, `0002`, `0003`) `libviro_renderer.so`: `7,127,744` bytes, SHA-256 `9cb54c7ddb74607eef00d882d0e297f4038e0417cee88ba55a5799d270267c5c`, Build ID `a1c6aafb3dc98d638e62e8e7084d6cb60f34cbd2`.
  - Packaged AAR (`viro_renderer-release.aar`): `7,226,795` bytes, SHA-256 `8a73e2b8334c43b3d7aaf33ca8cbbb3670bafeb5aad29f413bdd9ad44b36c124` (`arm64-v8a` only); exports all 3 `QuestInputModule` and 6 `QuestPanelModule` JNI symbols. Stock AAR in `node_modules` remained `cd654a19066b50c2b408c64c3ae2a6d1529ebd1c5dd3238a026bf4720727bdc7`.
- **Release APK:** `D:\nrq04\w\android\app\build\outputs\apk\release\app-release.apk` (`BUILD SUCCESSFUL in 8m 36s`), `137,353,125` bytes, SHA-256 `e79c52a38b5a773769ea5f00a800fef9e500c9c4feebbcc531a06b637e100192`, signed by `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`. Verified `arm64-v8a` only, embedded `libviro_renderer.so` SHA-256 `9cb54c7d...`, `QuestInputModule` and `QuestPanelModule` in DEX, Stage 04 JS bundle strings, and expected Quest-only release permissions.
- **Install:** `adb -s 3487C10J3706TQ install -r` succeeded on Quest 3S (`panther`, build `UP1A.231005.007.A1`, incremental `4183210015200610`). Pulled `base.apk` matched SHA-256 `e79c52a38b5a773769ea5f00a800fef9e500c9c4feebbcc531a06b637e100192` (`lastUpdateTime=2026-11-20 22:34:19`). The headset reported `mWakefulness=Asleep`, so the app was not launched; physical controller-input verification remains **pending**.

## Independent review

A read-only xAI Grok 4.7 (high) review ran through JamSession on an isolated copy of the Stage 04 files (session `11a7ec64-591f-45e2-8daf-ffb2e66b021b`). This checkout's file and index hashes were identical before and after the run. It reported no high or medium defects and two low ones:

- A poll before the first session reported `ended`. Fixed: generation 0 is reported as `waiting`.
- Samples skipped before a session's first read were not counted. Fixed, but not with the suggested `seq - cursor` formula: that would count earlier VR entries, because native seq never resets. The gap is now measured from the session's own `published` count and reported separately as `skipped`.

It also noted that a system menu's inactive poses would inflate loss counters. These are now not counted while unfocused.

## Headset verification matrix (PENDING)

Record:
- headset model and Horizon OS build;
- APK SHA-256 and git SHA;
- renderer `provenance.json` (ViroCore revision, the three patch hashes, `libviro_renderer.so` SHA-256);
- `[QuestInput]` and `VrApi` logcat.

Use `adb logcat --pid=<app> -v time | Select-String 'QuestInput|QuestMenu|QuestHeadRig'`.

- **C0:**
  - The Stage 01–03 checklists still pass on this APK.
  - The HUD shows `Controllers live`.
  - Each profile line names a Touch profile.
  - Menu ray, hover and click are unchanged; markers never block a ray.
- **C1 handedness:**
  - Hold only the left controller up: the blue marker follows it and the right shows `--`/lost. Repeat for the right hand.
  - Each marker sits on patch 0001's white aim-origin sphere, and its ray lies along Viro's own aim ray.
- **C2 poses while swinging:**
  - Swing both hands for 30 s: both stay `tracked`.
  - Positions and velocities change continuously.
  - Record the `dt` p50/p95/max, `hz`, `age`, `missed` and `read` values.
- **C3 sticks:**
  - Slowly sweep each stick around its rim and through all four diagonals.
  - Expect hundreds of distinct points, a diagonal peak above 0.6, a return to `+0.00 +0.00` on release, and values below 0.15, which Viro's `onScroll` never reports.
- **C4 analog and buttons:**
  - Trigger and grip sweep 0→1→0 smoothly on each hand.
  - A/B and X/Y appear on the correct hands.
  - Test B and Menu last: they are Android back in VR, so check that the logged sample showed them pressed before the scene exits.
- **C5 tracking loss:**
  - Cover or hide one controller, and separately set it down until it sleeps.
  - Expect `tracked -> inferred/lost` within a sample or two, the loss counter incrementing, and `lost -> tracked` with a duration on recovery.
  - The other hand is unaffected.
- **C6 focus and lifecycle:**
  - Open and close the Horizon system menu: `unfocused` or `stale`, then `live`, with no counted loss.
  - Do a Horizon system recenter: the epoch increments, the generation does not change, and there is no false loss.
  - Exit and re-enter VR: a new generation, with no gap counted across sessions.
- **C7 performance:** compare `VrApi` FPS and stale frames in the menu and ring for 5 minutes against Stage 03, and record the JS `read` p95.

Still to verify on the physical headset (both **Stage 03** and **Stage 04** physical gates remain **pending** — unit tests, captures, and preliminary user feedback do not pass these gates):
- Whether the render-thread markers (`updateMarkers`) track crisply at 72 Hz locked with patch `0001` `AimOrigin` and `laser.geom` during fast controller sweeps without visible separation.
- Whether the 45° sky `QuestDiagnosticsPanel` is comfortably readable in both `menu` and `ring` views, never blocks menus/robot/rays, and responds clearly across C1–C7 physical sweeps (sticks, triggers, grips, X/Y/A/B/Menu, tracking loss/recovery, system menu/recenter).
- Whether Touch Plus reports every value through `oculus/touch_controller`, whether the runtime clears `TRACKED` bits on occlusion, and whether aim-space velocity is reported.

## 2026-11-21 Sky Diagnostics & Controller Marker Latency Outcome

### Perceived latency findings & fix
- **Evidence inspected:** Headset capture video (`com.djleg.neorobots-20261120-235210-0.mp4`, 30 fps) and 3 headset screenshots showed orange `QuestInputMarkers` trailing ~1.5–2.5 video frames (~50–85 ms) behind patch `0001`'s cyan `laser.geom` ray during fast lateral sweeps, and `AimOrigin` (`laser.origin`) trailing ~1 frame behind `laser.geom` tip. Live device telemetry while running (`3487C10J3706TQ`) showed `VrApi FPS=72/72`, `Prd=36ms`, `Stale=0`, `App=7.9-8.1ms` and `[QuestInput] hz=72`, `xrdt=13.89ms`, `age=7.1..8.5ms`, `read=0.32..0.39ms`, `missed=0`.
- **Root cause:** The previous marker pipeline polled asynchronously on JS (`~7.1-8.5 ms` sample age), converted `quat -> Euler -> radians -> quat`, called `setNativeProps` across RN UIManager + JNI (`VRONode::setPositionAtomic` / `setRotationAtomic`), and drained `VROPlatformDrainRendererQueue()` at the top of `renderFrame()` **before** `xrWaitFrame()` (`~13.9 ms` wait), putting JS marker poses multiple OpenXR frames behind `predictedDisplayTime(N)`. Separately, `VROSceneRendererOpenXR::renderFrame()` ran `_renderer->prepareFrame()` (`computeTransforms`) before `_inputController->onProcess()`, so `laser.geom->setPaths()` updated immediately while `laser.origin`/`laser.hit` transforms waited until frame `N+1`. The compositor quad layers (`QuestPanelLayer` / `DiagLayer`) do not add controller pose latency.
- **Limitation:** End-to-end motion-to-photon latency of the patched markers has not yet been instrument-measured on glass; visual improvement requires on-headset re-test.
- **Fix:** Moved `xrSyncActions` + raw capture into `syncQuestInput` before `prepareFrame()`, switched Quest markers to direct render-thread `VRONode` transforms with `VROQuaternion` (`quest_input::updateMarkers`) before `prepareFrame()`, and added `presenterRoot->computeTransforms(...)` after `onProcess()` so `AimOrigin`/`AimHit` match the current frame. JS `setNativeProps` remains only as an unpatched/phone fallback.

### Sky diagnostics layout & menu cleanup
- Placed `QuestDiagnosticsPanel` in `menuFrame(cal)` at `[0, 1.27, -1.27]` pitched `45 deg` downward toward the viewer (`1.8 m × 1.0125 m`, `2048×1152` `XrCompositionLayerQuad` underlay with rounded `questDiagLayerMask` depth hole), clearing `menu`, `ring`, opponent robot, and head bounds.
- Removed developer prose and stray `ViroText` HUD strips (`QuestInputHud`, bottom rig strip, `Solo places...`, `They stay idle...`, `Head rig...`, `Hold Meta button...`, `"Arena will load..."`) from the normal menu; kept player controls (`Solo`/`Ready|Set`/`Back`/`Standing|Seated`/`Exit`), `Leaving the headset…`, `no-samples` failure, out-of-bounds warning, and arena asset failure messages.

### Review, verification, APK build & Quest 3S install
- **Read-only review:** Independent **xAI Grok 4.7 high** review (`jamsession` session `0718b5e0-0855-472c-b368-0423fefaa6b3`, pre/post worktree digest identical: `77014bb31ea3d7f68078021353f639589f69e6c4803c57516813a3f4f3a99f28`) flagged 0 High, 1 Medium (`AimOrigin`/`AimHit` 1-frame transform lag after `prepareFrame`), and 1 Low (`DiagLayer::prepare` missing `xrReleaseSwapchainImage` on `xrWaitSwapchainImage` failure). Both findings were fixed and regression-tested in `0003` and `tests/quest-input.test.cjs`.
- **Renderer build:** Rebuilt via `node tools/quest/build-viro-renderer.mjs` (`libviro_renderer.so` SHA-256 `1cd5f21356cd4f8f9542ef16ab51024c825a8500b5ad5fd753b240b7a509e281`, all 8 `QuestInputModule` and 6 `QuestPanelModule` JNI exports verified).
- **APK & install:** Staged cleanly to `D:\nrq04\w`, prebuilt with `QUEST_BUILD=1` (`ViroPlatform.QUEST`), assembled `arm64-v8a` release APK `D:\nrq04\w\android\app\build\outputs\apk\release\app-release.apk` (`137,367,929` bytes, SHA-256 `c2e26e2608b4df209dfbc121fe6e9c1673e01ae46035bb95cf5188a6e38d900d`), verified `lib/arm64-v8a/libviro_renderer.so`, `QuestInputModule`/`QuestPanelModule` DEX classes, `QUEST DEVELOPER DIAGNOSTICS` bundle string, `aapt2` release permissions, and `QUEST_RELEASE_APK=... npm run test:quest` (89/89 pass). Installed onto Quest 3S `3487C10J3706TQ` (`adb install -r` Success; device `base.apk` SHA-256 verified matching).
- **Automated tests:** Full `npm test` passed (`lint`, `typecheck`, `test:ar` 14/14, `test:app` 363/363, `test:quest` 89/89, `test:ui` 16/16, `test:dependencies` 3/3 = 485/485).
- **Remaining physical device gates:** **Stage 03** (`docs/quest-03-head-rig.md`) and **Stage 04** (`C0`–`C7` above) physical headset verification remain **pending**.

## 2026-11-21 (22:24 EST) Floating Title, Live Diagnostics & Fresh Quest 3S Install

- **Included uncommitted worktree changes:**
  - Compact rounded menu card (`1216×432`, `0.95 m × 0.3375 m`, expanded to `1216×720` when alert lines are shown) with separate floating transparent branded title overlay (`1024×400` in `QuestPanelLayer._title`, submitted after `projLayer` with `XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT`; `QuestPanelModule` `NATIVE_VERSION = 3` and `PanelSlot` for `menu` and `title` slots; `0002-openxr-quest-panel-layer.patch` updated accordingly).
  - Live diagnostics sub-region Canvas patching (`patchDiagnostics` / `nativeDiagDrawRegion` in `QuestInputModule` and `0003-openxr-quest-input-sampler.patch`) driven outside React at ~30 Hz for analog updates and 10 ms on button/tracking edges.
- **Viro API/material verification:** Viro MCP tools were not available in this session's toolset; local `@reactvision/react-viro` v3.0.3 definitions (`ViroMaterials.ts`, `ViroXRSceneNavigator.tsx`) were checked directly to verify `ViroMaterial` (`lightingModel`, `blendMode`, `writesToDepthBuffer`, `readsFromDepthBuffer`, `cullMode`, `shaderModifiers`) and `ViroXRSceneNavigator` (`hdrEnabled`, `bloomEnabled`) props.
- **Patched renderer provenance (`native/quest-viro-renderer/`):** Already rebuilt at `2026-11-21 09:17:35` matching current `lock.json` and patch hashes (`0001` `68135af4...`, `0002` `30430e66...`, `0003` `518bf2ce...`): `libviro_renderer.so` SHA-256 `2a08b6e53ebe840261768b5adfb4f47b201eedcd2bf04133353e2fc6f55b6b4a`, Build ID `fe2785b96511a3f7532355c5f2bb4684f3a3fbd2`, AAR SHA-256 `f7d25e72b65ed3e5df1974a2dc4d45a546f8252a9888589e1b37a45e724434b9` (`arm64-v8a` only; all 9 `QuestInputModule` and 10 `QuestPanelModule` JNI exports in `report.json`).
- **Tests:** `npm run lint`, `npm run typecheck`, and `npm run test:quest` (90/90) passed prior to staging. After APK assembly, `QUEST_RELEASE_APK=D:\nrq04\w\android\app\build\outputs\apk\release\app-release.apk npm run test:quest` passed **90/90** (verifying `lib/arm64-v8a/libviro_renderer.so` hash match, `QuestPanelModule` DEX presence, packaged `ArenaNotoSans`/`ArenaNotoSansSemibold` TTFs, `quest-lettering` drawable resources, and bundle strings).
- **APK build (`D:\nrq04\w`):** Clean-staged 233 tracked/untracked worktree files plus `native/quest-viro-renderer/` into `D:\nrq04\w`, ran `npm ci`, `QUEST_BUILD=1 npx expo prebuild -p android --clean --no-install` (`ReactViroPackage.ViroPlatform.QUEST`, `:viro_renderer -> ../native/quest-viro-renderer`), and `./gradlew.bat :app:processReleaseManifest :app:assembleRelease -PreactNativeArchitectures=arm64-v8a -I ..\tools\quest\short-cmake.gradle --console=plain` (`BUILD SUCCESSFUL in 3m 26s`, 908 executed tasks). Resulting APK: `D:\nrq04\w\android\app\build\outputs\apk\release\app-release.apk`, timestamp `2026-11-21 22:24:16` local, `137,410,545` bytes, SHA-256 `4d34f3b11ae0aa4757c3b371f1b139fe6696e277d96d9f198408799115a2c939`, signer SHA-256 `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`. `aapt2 dump permissions` confirmed only `INTERNET`, `MODIFY_AUDIO_SETTINGS`, `VIBRATE`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, and `com.djleg.neorobots.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`.
- **Install & device verification:** `adb -s 3487C10J3706TQ install -r` succeeded (`lastUpdateTime=2026-11-21 22:24:32`). Both on-device `sha256sum` and pulled `base.apk` matched SHA-256 `4d34f3b11ae0aa4757c3b371f1b139fe6696e277d96d9f198408799115a2c939`. **Stage 03** and **Stage 04** physical headset verification gates remain **pending**.

## Future controls (context, not Stage 04 work)

Quest motion controllers only:
- physical motion for punching, blocking and ducking;
- left stick strafe;
- right stick forward/back;
- right trigger for a stamina-costing directional hop or dash.

Stage 04 maps none of these.
