# Quest 02 arena menu

- Status: ACTIVE. Rebased onto current `origin/main`. Headset gates remain pending. Pull request is not open yet.
- Task source: `project/agent/handoffs/2026-11-18-quest-02-arena-menu.md`
- Control bootstrap: `79aff298941ea4b94acc788d2e3d3f1e344911fe` (packet and control `todo.md` were not edited)
- Branch: `feat/quest-02-arena-menu`
- Worktree: `neo-rock-em-sock-em-robots-quest-02-arena-menu`
- Starting commit: `ee0a2a046d3486201144b0a4886e1b6174dbd44d`
- Final base at handoff: `origin/main` `f85eb9352803ee4b331ee3ce7a40d0138cf1bf4e`
- Current `origin/main`: `4c95f577708147fac9b958126ff51883de9f528e` (merge of PR #1)
- Quest 02 commit: `c68a65a97ddeb4abb06bc00ebb91b7c5ca9f8d48`, parent `4c95f577708147fac9b958126ff51883de9f528e`. Rewritten from `712f641b7a54a89821a1a4d5fcbe82c308052d7a` (parent `ee0a2a046d3486201144b0a4886e1b6174dbd44d`).
- Owner: Grok 4.7 implementation session `26c5025e-b244-4faf-80f2-2d3383bd4c75`. No further delegation.
- Git: `git rebase --onto origin/main ee0a2a046d3486201144b0a4886e1b6174dbd44d` replayed only the Quest 02 commit. No conflicts. `git log origin/main..HEAD` is that one commit. Quest 01 commits `c388cbf` and `9e93b84` stay in `origin/main` and were not replayed. Fetched `origin` again on 2026-11-18; `origin/main` was still `4c95f577708147fac9b958126ff51883de9f528e` and `ee0a2a0` was still its ancestor, so the rebase was not run a second time. A second `--onto` from the already rebased tip would have selected the Quest 01 commits as well. No upstream yet. PR URL is not opened at this record.

## Accepted requirements

Headset menu and fixed virtual ring in the existing Quest OpenXR session. Solo, Ready (the Start/Ready control), Back, and Exit use a real solo `ArenaMatch`. Do not assert synthetic AR readiness as observed headset tracking. Do not start a fight the player cannot control. Do not copy the medical-viewer compositor AAR or treat it as proven. Preserve phone and iOS behavior. No second OpenXR session, fighting gestures, locomotion, passthrough, or multiplayer.

Roadmap checkbox 02 stays open. Quest 01 and Quest 02 headset gates are both pending.

## Decisions

- Stock `@reactvision/react-viro` 3.0.3 stays the renderer. The medical underlay is inserted before the projection layer and is covered when passthrough is off. This app forces passthrough off. The reference AAR was not copied and its build script was not run.
- The menu is a 2048×1152 PNG on a world-fixed quad in the projection layer. `modules/quest-menu-texture` only rasterizes that PNG. Controller targets are invisible quads from the same pixel layout (`colorWriteMask: ['None']` plus a fragment modifier). Pointer alignment is unverified on a headset.
- The Android project directory is `native/`, not `android/`. This repo's `.gitignore` ignores every directory named `android`, including a module path. A directory named `android` is omitted from `git ls-files` and from the staged native build.
- Solo calls `setLandscape(true)` because the immersive activity is already the playable orientation. It does not call `setTracking` or `setPlacement`. Ready calls `ArenaMatch.ready()` only when `canReady` is false. When `canReady` is true, Ready does not call it, so a CPU fight cannot start. There is no combat tick.
- Robots stay at `ARENA_LAYOUT` scale. Human scale belongs to stage 03. Ring pose is `(0, -0.55, -2.1)`. Menu poses are `(0, 0.12, -1.4)` and `(0, 0.58, -1.4)`.
- Asset callbacks carry a session lease because a new `ArenaMatch` reuses token 1. A 30 s timeout reports the first missing GLB and does not close OpenXR.

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
- `tests/quest-arena.test.cjs` — session, layout, and source invariants
- `tests/quest-runtime.test.cjs` — scene file assertion
- `.agents/worksheets/agent-worksheet-2026-11-18-quest-02-arena-menu.md`

Phone arena, iOS, `app.config.ts` plugins, and `package.json` dependencies were not changed. No `android/` directory was generated in the worktree.

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

## Blockers

- Quest 01 headset gate: pending. PR #1 is merged, and this branch no longer contains the reference cube. The cube gate was not run on a headset.
- Quest 02 headset gate: pending. Checklist is in `docs/quest-02-arena-menu.md`. Ready is the Start/Ready control. Do not treat a passing compile or `npm run build:android` as the gate.
- Hit-quad invisibility and PNG orientation are unverified until a controller aim test. If the aim point misses the printed buttons, fix the shared layout. Do not move only the hit quads.
- Roadmap checkbox 02 stays open. The control `todo.md` was not edited.
- Push and the pull request are the next git steps after this record. No force push.

## Next action

Push `feat/quest-02-arena-menu` normally and open a pull request to `main`. After that, install the release APK built from the rebased commit, run the branch 02 checklist, and record the headset model, OS build, git SHA, and whether Ready stays in the lobby. Leave roadmap checkbox 02 unchecked until that gate and the branch 01 gate both pass.
