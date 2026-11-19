# Quest 02 arena menu

- Status: ACTIVE
- Task source: `project/agent/handoffs/2026-11-18-quest-02-arena-menu.md`
- Control bootstrap: `79aff298941ea4b94acc788d2e3d3f1e344911fe` (packet and control `todo.md` were not edited)
- Branch: `feat/quest-02-arena-menu`
- Worktree: `neo-rock-em-sock-em-robots-quest-02-arena-menu`
- Starting commit: `ee0a2a046d3486201144b0a4886e1b6174dbd44d`
- Final base at handoff: `origin/main` `f85eb9352803ee4b331ee3ce7a40d0138cf1bf4e`
- Owner: Grok 4.7 implementation session `26c5025e-b244-4faf-80f2-2d3383bd4c75`. No further delegation.
- Git: committing the reviewed Quest 02 work on `ee0a2a046d3486201144b0a4886e1b6174dbd44d`, then rebasing only that commit onto `origin/main` `4c95f577708147fac9b958126ff51883de9f528e`. No push yet.

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

All commands ran in the worktree unless noted. Exit codes are the script exit codes.

- `npm run typecheck` — exit 0, after the scene hook fix.
- `npx eslint` on the new TypeScript — exit 0 after replacing render-time refs and synchronous effect setState.
- `npm run test:quest` — exit 0, 20 passed. An earlier run failed because a Kotlin comment contained the forbidden source tokens; the comment was reworded. Re-run after the `native/` move also passed.
- `npm run test:ar` — exit 0, 14 passed.
- `npm run test:ui` — exit 0, 16 passed.
- `npm run test:app` — exit 0, 363 passed.
- `npm run build:android` — exit 0. Expo export wrote `dist/` (2413 modules). This is not a Quest native build and not a headset test.
- `git diff --check ee0a2a046d3486201144b0a4886e1b6174dbd44d` — exit 0. This covers tracked edits only.
- `git diff --check f85eb9352803ee4b331ee3ce7a40d0138cf1bf4e` — exit 2. Only the inherited baseline below.
- `git diff --check origin/main...ee0a2a046d3486201144b0a4886e1b6174dbd44d` — exit 2, same inherited files: `package.json`, `src/app/arena-fighter.tsx`, `src/features/home/home-screen.tsx`.
- A scan of new untracked sources found no trailing whitespace and no conflict markers.

Quest native build, staged at `C:\Users\DJLeg\AppData\Local\Temp\nrq-w` because the worktree path exceeds the NDK Ninja path limit:

- JDK 17.0.16, Android SDK at `%LOCALAPPDATA%\Android\sdk`, NDK `27.1.12297006`, CMake 3.22.1.
- `QUEST_BUILD=1 npx expo prebuild -p android --clean --no-install`. `MainApplication.kt` contains `ReactViroPackage(ReactViroPackage.ViroPlatform.QUEST)`. `QUEST_COMPOSITOR_UI` was not set.
- `gradlew :app:processDebugManifest :app:processReleaseManifest :app:assembleDebug :app:assembleRelease -PreactNativeArchitectures=arm64-v8a -I ..\tools\quest\short-cmake.gradle --console=plain`
- `BUILD SUCCESSFUL in 6m 6s` (1332 tasks: 384 executed, 948 up-to-date). Gradle 9.3.1.
- `quest-menu-texture` (1.0.0) is in the Expo module list. `ExpoModulesPackageList.kt` contains `QuestMenuTextureModule`.
- `libviro_renderer.so` SHA-256 `2b3280493c4a788cc14319e263f1c2769bf3e54b22c9e4cc7673319967ccacd4` is identical in `viro_renderer-release.aar`, `app-release.apk`, and `app-debug.apk`. Installed Viro package version is 3.0.3.
- Release permission dump: `INTERNET`, `MODIFY_AUDIO_SETTINGS`, `VIBRATE`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, and `com.djleg.neorobots.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. Camera, microphone, eye-tracking, hand-tracking, scene, and anchor permissions are absent. Camera and passthrough features are `required=false`. `android.hardware.vr.headtracking` is `required=true`.
- Release APK: `C:\Users\DJLeg\AppData\Local\Temp\nrq-w\android\app\build\outputs\apk\release\app-release.apk` (137,378,713 bytes). Debug APK is beside it. TEMP can be deleted by Windows. Rebuild with `docs/quest-01-dev-build.md` plus `docs/quest-02-arena-menu.md`.
- The APK was not installed. `adb devices` showed one authorized Quest 3S. Wearing the gate was not run.

Earlier native attempts, all before the successful build: the copy stopped on the deleted smoke-scene path; Windows PowerShell 5.1 stopped on an `npx` stderr warning after a successful prebuild; the first Gradle invocation was killed after it configured without `quest-menu-texture` because `android/` was gitignored.

## Blockers

- Quest 01 headset gate: pending. This branch no longer contains the reference cube, so that gate still belongs to `ee0a2a046d3486201144b0a4886e1b6174dbd44d`.
- Quest 02 headset gate: pending. Checklist is in `docs/quest-02-arena-menu.md`. Ready is the Start/Ready control. Do not treat a passing compile as the gate.
- Hit-quad invisibility and PNG orientation are unverified until a controller aim test. If the aim point misses the printed buttons, fix the shared layout. Do not move only the hit quads.
- Work is uncommitted. Do not push or merge from this record.

## Next action

Install the release APK on the Quest, run the branch 02 checklist, and record the headset model, OS build, git SHA, and whether Ready stays in the lobby. Leave roadmap checkbox 02 unchecked until that gate and the branch 01 gate both pass.
