# Quest 02 arena menu

- Status: ACTIVE. Pull request https://github.com/DavidJGrimsley/neo-rock-em-sock-em-robots/pull/2 is open against `main`. The 2026-11-19 menu and OpenXR pointer fix is implemented and compiled. Headset gates remain pending. Roadmap checkbox 02 is not done.
- Task source: `project/agent/handoffs/2026-11-18-quest-02-arena-menu.md`
- Control bootstrap: `79aff298941ea4b94acc788d2e3d3f1e344911fe` (packet and control `todo.md` were not edited)
- Branch: `feat/quest-02-arena-menu`
- Worktree: `neo-rock-em-sock-em-robots-quest-02-arena-menu`
- Starting commit: `ee0a2a046d3486201144b0a4886e1b6174dbd44d`
- Final base at handoff: `origin/main` `f85eb9352803ee4b331ee3ce7a40d0138cf1bf4e`
- Current `origin/main`: `4c95f577708147fac9b958126ff51883de9f528e` (merge of PR #1)
- Quest 02 commit: `c68a65a97ddeb4abb06bc00ebb91b7c5ca9f8d48`, parent `4c95f577708147fac9b958126ff51883de9f528e`. Rewritten from `712f641b7a54a89821a1a4d5fcbe82c308052d7a` (parent `ee0a2a046d3486201144b0a4886e1b6174dbd44d`).
- Owner: Grok 4.7 implementation session `26c5025e-b244-4faf-80f2-2d3383bd4c75`, continued in session `fd495e22-b8cd-460c-8e14-bc407f7f2697` after the previous provider stopped. No delegation.
- Git: `git rebase --onto origin/main ee0a2a046d3486201144b0a4886e1b6174dbd44d` replayed only the Quest 02 commit. No conflicts. After that rebase, `git log origin/main..HEAD` was only `c68a65a97ddeb4abb06bc00ebb91b7c5ca9f8d48`. Quest 01 commits `c388cbf` and `9e93b84` stay in `origin/main` and were not replayed. Fetched `origin` again on 2026-11-18; `origin/main` was still `4c95f577708147fac9b958126ff51883de9f528e` and `ee0a2a0` was still its ancestor, so the rebase was not run a second time. A second `--onto` from the already rebased tip would have selected the Quest 01 commits as well. `271ffd489a6c73dda013f6ba28d712746e995638` records the post-rebase checks. Normal push `git push -u origin HEAD` created `origin/feat/quest-02-arena-menu`. Pull request: https://github.com/DavidJGrimsley/neo-rock-em-sock-em-robots/pull/2. No force push.

## Accepted requirements

Headset menu and fixed virtual ring in the existing Quest OpenXR session. Solo, Ready (the Start/Ready control), Back, and Exit use a real solo `ArenaMatch`. Do not assert synthetic AR readiness as observed headset tracking. Do not start a fight the player cannot control. Do not copy the medical-viewer compositor AAR or treat it as proven. Preserve phone and iOS behavior. No second OpenXR session, fighting gestures, locomotion, passthrough, or multiplayer.

Roadmap checkbox 02 stays open. Quest 01 and Quest 02 headset gates are both pending.

## Decisions

- The medical underlay stays unused. Passthrough stays off, so an underlay would be covered. `QUEST_COMPOSITOR_UI` is not set and the medical AAR was not copied.
- Quest builds use a pinned OpenXR-only patch of public ViroCore `v3.0.3` (`23710240d2cab5d4e866f3dba44ef568d8e563b4`). The patch adds a depth-tested beam, a 7 mm origin sphere, and a 6 mm hit sphere pulled 8 mm off the surface. The reticle follows controller sources 1 and 4. Head gaze moves it only when no controller ray is tracked. Phone and iOS keep the published renderer in `node_modules`. The published `.so` hash differs because that binary links proprietary ReactVisionCCA and ARCore image-tracker objects that are not in the public tag. A pristine rebuild of the same tag has the same gap. The patched hash `182db849a9a7a59db6d2abb4535fa8c93956c4820edd8bd447beb1c90a27872e` reproduced on a second link. No upstream pull request was opened.
- The menu is a 2048×1152 PNG on a 1.6×0.9 m world-fixed quad, using the phone lettering PNGs, Noto fonts, and dark-theme colors. Hover is baked into that PNG. Hit quads use the same rectangles. Trigger activation is `clickState === 1` from source 1 or 4 only.
- The Android project directory is `native/`, not `android/`. This repo's `.gitignore` ignores every directory named `android`, including a module path. `native/quest-viro-renderer/` is also gitignored. A staged Quest build must copy it separately.
- Solo calls `setLandscape(true)` only. It does not call `setTracking` or `setPlacement`. Ready does not call `ArenaMatch.ready()`. It stores the acknowledgement "Ready saved. Both robots stay idle. Combat controls are not in this stage." The stage stays `lobby` and `localReady` stays false. The button then reads Set. Back clears the acknowledgement. Exit always calls `session.exit()` and `exitVRScene()`, and the panel says "Leaving the headset…". There is no combat tick.
- Robots stay at `ARENA_LAYOUT` scale. Human scale belongs to stage 03. Ring pose is `(0, -0.55, -2.1)`. Menu poses are `(0, 0.08, -1.15)` and `(0, 0.52, -1.15)`.
- Asset callbacks carry a session lease because a new `ArenaMatch` reuses token 1. A 30 s timeout reports the first missing GLB and does not close OpenXR.

The 2026-11-18 decision to keep the stock renderer, and the Ready path that called `ArenaMatch.ready()` when `canReady` was false, are superseded by the decisions above. The `c68a65a` validation below still describes that earlier commit.

## Files changed

- `docs/quest-01-dev-build.md` — pointer that this branch replaces the cube
- `docs/quest-02-arena-menu.md` — compositor decision, behavior, build, checklist
- `modules/quest-menu-texture/**` — Android PNG module, sources under `native/`
- `src/features/quest-vr/quest-arena-scene.native.tsx` — menu and ring scene
- `src/features/quest-vr/quest-arena-session.ts` — solo match session
- `src/features/quest-vr/quest-menu-layout.ts` — shared texture and hit geometry
- `src/features/quest-vr/quest-vr-screen.native.tsx` — launcher copy
- `src/features/quest-vr/quest-xr-navigator.native.tsx` — loads the arena scene
- `src/features/quest-vr/quest-smoke-scene.native.tsx` — deleted
- `tests/quest-arena.test.cjs` — session, layout, input, texture, and exit invariants
- `tests/quest-runtime.test.cjs` — scene file assertion and Quest plugin list
- `tests/quest-renderer.test.cjs` — pointer patch pin and settings rewrite
- `src/features/quest-vr/quest-menu-input.ts` — trigger source filter
- `assets/arena/ui/quest-lettering/` — phone title PNGs
- `tools/quest/build-viro-renderer.mjs` — pinned Quest renderer build
- `tools/quest/with-quest-viro-renderer.cjs` — Quest-only Gradle project pointer
- `tools/quest/viro-renderer/` — patch and lock. The built AAR is gitignored
- `app.config.ts` — Quest plugin list only
- `.gitattributes`, `.gitignore` — patch line endings and renderer output
- `.agents/worksheets/agent-worksheet-2026-11-18-quest-02-arena-menu.md`

Phone arena, iOS, and `package.json` dependencies were not changed. No `android/` directory was generated in the worktree. `node_modules` was not modified.

## Validation

Commands below ran on `c68a65a97ddeb4abb06bc00ebb91b7c5ca9f8d48` after the rebase, in the worktree unless noted. Exit codes are the script exit codes.

- `npm run typecheck` — exit 0.
- `npm run test:quest` — exit 0, 23 passed, 0 failed. This includes the menu and session tests plus the Quest 01 Re-enter VR and VRActivity plugin tests.
- `npm run test:ar` — exit 0, 14 passed, 0 failed.
- `npm run test:ui` — exit 0, 16 passed, 0 failed.
- `npm run test:app` — exit 0, 363 passed, 0 failed.
- `npm run build:android` — exit 0. Expo export wrote `dist/` (2413 modules, about 10.5 s bundle). This is not a Quest native build and not a headset test.
- `git diff --check ee0a2a046d3486201144b0a4886e1b6174dbd44d` — exit 0.
- `git diff --check origin/main` — exit 0.
- `git diff --check origin/main...HEAD` — exit 0.
- `git diff --check f85eb9352803ee4b331ee3ce7a40d0138cf1bf4e...ee0a2a046d3486201144b0a4886e1b6174dbd44d` — exit 2. Inherited trailing whitespace only, and those files are not in the Quest 02 commit: `package.json` lines 16 and 24, `src/app/arena-fighter.tsx` lines 1–10, `src/features/home/home-screen.tsx` lines 3, 6, 17, 18, and 57.
- `npx eslint` on the new TypeScript was exit 0 before the commit. It was not run again after the rebase. The rebase did not change those source files relative to `712f641`.

Quest native build of this commit, staged at `C:\Users\DJLeg\AppData\Local\Temp\nrq-w` because the worktree path exceeds the NDK Ninja path limit. Sources were the git file list of `c68a65a`. The staged `node_modules` was kept because `package-lock.json` matched the worktree. `android/` was regenerated.

- JDK 17.0.16 Temurin, Android SDK at `%LOCALAPPDATA%\Android\sdk`, NDK `27.1.12297006`. CMake staging used `tools/quest/short-cmake.gradle` (`%TEMP%\nrq-cxx`).
- `QUEST_BUILD=1 npx expo prebuild -p android --clean --no-install` — exit 0. `QUEST_COMPOSITOR_UI` was not set.
- `MainApplication.kt` contains `ReactViroPackage(ReactViroPackage.ViroPlatform.QUEST)` and does not reference `ViroPlatform.AR`.
- Generated `VRActivity.kt` contains `supersededByOtherActivity` and `questVRActivityState`, so the Quest 01 Meta/Home resume patch is in this tree.
- `gradlew :app:processDebugManifest :app:processReleaseManifest :app:assembleDebug :app:assembleRelease -PreactNativeArchitectures=arm64-v8a -I ..\tools\quest\short-cmake.gradle --console=plain`
- `BUILD SUCCESSFUL in 3m 31s`.
- Gradle listed `quest-menu-texture` (1.0.0). `ExpoModulesPackageList.kt` is generated during Gradle, not by prebuild. An earlier check looked for that file before Gradle and stopped; it was not a compile failure. After this build the file contains `expo.modules.questmenutexture.QuestMenuTextureModule`.
- `libviro_renderer.so` SHA-256 `2b3280493c4a788cc14319e263f1c2769bf3e54b22c9e4cc7673319967ccacd4` is identical in `viro_renderer-release.aar` (`jni/arm64-v8a/libviro_renderer.so`), `app-release.apk`, and `app-debug.apk`. Viro package version is 3.0.3. The stock renderer was not replaced.
- Release permission dump: `INTERNET`, `MODIFY_AUDIO_SETTINGS`, `VIBRATE`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, and `com.djleg.neorobots.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. Camera, microphone, eye-tracking, hand-tracking, scene, and anchor permissions are absent. Camera, autofocus, hand-tracking, passthrough, `android.software.vr.mode`, and `android.hardware.vr.high_performance` are `required=false`. `android.hardware.vr.headtracking` is `required=true`. `com.google.ar.core` meta-data is `optional`. OpenGL ES 3.0 is `required=true`. Manifest activities include `MainActivity` and `VRActivity`.
- Release APK: `C:\Users\DJLeg\AppData\Local\Temp\nrq-w\android\app\build\outputs\apk\release\app-release.apk` (137,380,321 bytes, 2026-11-18 21:16). Debug APK is beside it (119,101,044 bytes). TEMP can be deleted by Windows. Rebuild with `docs/quest-01-dev-build.md` plus `docs/quest-02-arena-menu.md`.
- The APK was not installed. No headset session was started. The worktree stayed clean; prebuild did not rewrite the worktree `package.json`.

An earlier staged APK (137,378,713 bytes, `BUILD SUCCESSFUL in 6m 6s`) was built before this rebase and does not validate `c68a65a`. It did not contain the merged Quest 01 VRActivity patch. Do not install that older file.

## 2026-11-19 menu and pointer validation

Commands ran in the worktree unless noted. Exit codes are the script exit codes. The APK was built from the uncommitted working tree, then the docs were updated. The commit that contains this section is the one to install.

- `npm test` — exit 0. Lint and typecheck passed. `test:ar` 14, `test:app` 363, `test:quest` 27, `test:ui` 16, `test:dependencies` 3. Zero failures.
- `node tools/quest/build-viro-renderer.mjs --pristine` — exit 0. Public tag `23710240d2cab5d4e866f3dba44ef568d8e563b4`, NDK `27.1.12297006`. Pristine `.so` SHA-256 `7d35cb1521d2c2358d6e8a3595234d8226e91adbab864fc5992feefb5b7931ab`. Machine AArch64 and SONAME match stock. `NEEDED` lacks only `libreactvisioncca.so`. The same 12 CameraTexture, RendererARCore, and ImageTracker JNI symbols are absent. Report: `%TEMP%\nrq-viro\pristine\report.json`.
- `node tools/quest/build-viro-renderer.mjs` — exit 0. Patched `.so` SHA-256 `182db849a9a7a59db6d2abb4535fa8c93956c4820edd8bd447beb1c90a27872e` (7115456 bytes, build id `0f0b5ef5add6046cde73125294c0c80446ec82c5`). A second link reproduced that hash. Against pristine, `NEEDED` matches and the only export delta is the 4-argument `updateAimRay` versus `createMarker`, the 5-argument `updateAimRay`, and `configurePointerMaterial`. Quest AAR SHA-256 `b7dba41e065ec3087fb53838e8225e79f61de8b5ab9be2ea844f207e6afec0f5`, arm64 only. `node_modules` stock `.so` stayed `2b3280493c4a788cc14319e263f1c2769bf3e54b22c9e4cc7673319967ccacd4` in both the worktree and the stage.
- Quest stage `%TEMP%\nrq-w`. `QUEST_BUILD=1 npx expo prebuild -p android --clean --no-install` — exit 0. `settings.gradle` points `:viro_renderer` at `../native/quest-viro-renderer`. `MainApplication` uses `ViroPlatform.QUEST`. `VRActivity.kt` contains `supersededByOtherActivity` and `questVRActivityState`.
- `gradlew :app:processDebugManifest :app:processReleaseManifest :app:assembleDebug :app:assembleRelease -PreactNativeArchitectures=arm64-v8a -I ..\tools\quest\short-cmake.gradle` — `BUILD SUCCESSFUL in 3m 23s`.
- Both APKs contain the patched `.so` hash above. Release `%TEMP%\nrq-apks\app-release.apk` is 137,269,925 bytes (2026-11-19 16:08 UTC). Debug is 118,904,436 bytes. Release permissions and feature flags match `docs/quest-02-arena-menu.md`. Neither APK was installed.
- Phone prebuild with `QUEST_BUILD` unset — exit 0. `settings.gradle` points `:viro_renderer` at the stock `node_modules` project. `MainApplication` uses `ViroPlatform.AR`. That phone tree was not assembled.
- Worktree `package.json` was not rewritten. The control `todo.md` was not edited. No upstream pull request was opened.

## Blockers

- Quest 01 headset gate: pending. PR #1 is merged, and this branch no longer contains the reference cube. The cube gate was not run on a headset.
- Quest 02 headset gate: pending. Checklist is in `docs/quest-02-arena-menu.md`. The compile above does not close it. Do not claim pointer alignment, menu readability, Ready, Back, or Exit until the release APK from this commit is worn.
- Roadmap checkbox 02 stays open. The control `todo.md` was not edited.
- Pull request: https://github.com/DavidJGrimsley/neo-rock-em-sock-em-robots/pull/2. Updates use a normal push. No force push.

## Next action

Install the release APK built from the commit that contains this menu and pointer fix, not the older `c68a65a` APK. Run the branch 02 checklist. Record the headset model, OS build, git SHA, and whether the ray starts at the controller, Ready stays in the lobby, and Back and Exit leave the right state. Leave roadmap checkbox 02 unchecked until that gate and the branch 01 gate both pass.
