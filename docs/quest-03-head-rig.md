# Quest 03 first-person head rig

Stage 03 replaces the Stage 02 tabletop ring with a first-person robot-eye view in fully virtual OpenXR on top of merged PR #2 (`docs/quest-02-arena-menu.md`). It is not yet worn on a headset; Stage 01, Stage 02, and Stage 03 headset gates remain **pending**.

## Coordinate spaces

- **S0 (Sim):** `ArenaController` simulation metres (`ARENA_RULES`, `ARENA_LAYOUT`), unchanged. Phone AR and combat math are untouched.
- **S1 (Ring-local tabletop):** `fighterY = ARENA_LAYOUT.floorHeight + ARENA_LAYOUT.footOffset`. The player eye anchor `eyeRingLocal(anchor)` places `ROBOT_EYE_MODEL = [0, 1.1271, 0.2028]` (from `eye_l`/`eye_r` rest midpoint in both fighter GLBs) in the frozen player fighter frame, **ignoring `lift`** so hops/hits never move the camera.
- **S2 (VR metres):** `S1 * QUEST_WORLD_SCALE` (`QUEST_WORLD_SCALE = 16`, a reversible tuning constant). At `S = 16`, robot height is `~1.92 m`, eye height above the fighting floor is `~1.355 m`, spawn gap is `3.04 m`, and default eye-to-opponent center distance is `~2.80 m`.
- **S3 (OpenXR `LOCAL`):** Untouched native 6DoF scene root (`VROSceneRendererOpenXR`). No `<ViroCamera>`, no `ViroGameLoop` per-frame rig updates, no head bob, no hit shake, and no native `recenterTracking`.
- **S4 (Calibration frame):** `{ origin, yaw, posture, source, entry }` in S3 (`DEFAULT_CALIBRATION = { origin: [0, 0, 0], yaw: 180, posture: 'standing', source: 'default', entry: 0 }`), using the repo `facing` yaw convention (`0 = +Z`, `+90 = +X`, `180 = -Z`).
- **S5 (Gameplay head pose):** Output-only bounded offsets (`lateral`, `vertical`, `forward`, and `/ QUEST_WORLD_SCALE` in `sim`), `yawRelative`, `clamped`, `excess`, and `outOfBounds = excess > 0.30`.

## Rig hierarchy, calibration, and comfort decisions

- **Static horizon-locked rig:** `QuestRing` wraps S1 content in a 3-node `<ViroNode>` rig (`position={rig.position}` + Y-only `rotation={[0, rig.rotationY, 0]}` -> `scale={[16, 16, 16]}` -> `position={rig.contentOffset}`). The rig updates only on explicit calibration events (`calibrateForSolo`, `recenter`, `cyclePosture`), never from per-frame head samples.
- **Own-body occlusion vs real asset lease:** `Mike_Player1_Blue_Combat_AR.glb` shares a single body mesh (`SKM_MegaMikeZ_part_0`) with eyes inside the visor, so the blue `Viro3DObject` stays mounted with `visible={false}` and retains its real `onLoadEnd`/`onError` callbacks. A stance floor ring at the player's feet marks the calibrated position and tints when `outOfBounds` is true.
- **Sample pipeline & lifecycle:** `ViroScene.onCameraTransformUpdate` writes validated samples (`headSampleFromViro`, rejecting non-finite/zero vectors and normalizing `forward`/`up`) into a 64-entry O(1) ring buffer; store subscribers and the scaled (`0.05`) diagnostics `ViroText` strip update at most 5 Hz, and `ReactNativeJS` logcat pose summaries log at most 1 Hz.
- **First-Solo-per-entry calibration:** Keyed to `questRuntime.getSnapshot().entries`. First `Solo` in an entry calibrates from the latest stable window (else latest valid sample, else `DEFAULT_CALIBRATION` with status `'no-samples'`). `Back -> Solo` within the same entry keeps calibration; if `Recenter` already succeeded on the menu page in that entry, `Solo` preserves it and binds `anchor`.
- **App-only Recenter & Posture:** `Recenter` requires a post-press `500 ms` window within `2000 ms` with `>= 8` valid samples, position spread `<= 0.03 m`, and horizontal-forward yaw spread `<= 5°` (median position, circular-mean yaw `atan2(fx, fz)`). Failure leaves calibration unchanged. `Posture` cycles `'standing' <-> 'seated'` and updates only `QUEST_HEAD_BOUNDS`:
  - `standing`: lateral `±0.30 m`, crouch `0.45 m`, rise `0.05 m`, forward/back `±0.20 m`
  - `seated`: lateral `±0.25 m`, crouch `0.25 m`, rise `0.05 m`, forward/back `±0.20 m`
- **No automatic system-recenter heuristic:** If a Horizon OS system recenter shifts `LOCAL`, the menu shows `'If the system recenter moved the view, select Recenter.'` rather than guessing from pose jumps.
- **Branded menu pipeline & off-sightline ring pose:** `QuestMenu` keeps Stage 02's native material preparation (`prepareQuestMenuMaterial`/`releaseQuestMenuMaterials`), trigger-only input (`questTriggerPress`/`questPointerHover`), and `1.6×0.9 m` two-row layout (`QUEST_MENU_TEXT_LINES_MAX = 6`, `<= 24` draw ops), wrapped in `menuFrame(tracker.calibration)` so `QUEST_MENU_POSE.ring` (`[0, -0.78, -0.5]`, rotation `[0, 0, 0]`) sits off every eye-to-opponent bounding-box ray.

## Build and checks

Use `docs/quest-01-dev-build.md` and `docs/quest-02-arena-menu.md` for short-path Windows staging, building the Quest-only OpenXR pointer renderer (`node tools/quest/build-viro-renderer.mjs`), `QUEST_BUILD=1`, `npx expo prebuild -p android --clean --no-install`, arm64 Gradle build with `-I ..\tools\quest\short-cmake.gradle`, `aapt2` permission inspection, and verifying the packaged `libviro_renderer.so` SHA-256 (`182db849a9a7a59db6d2abb4535fa8c93956c4820edd8bd447beb1c90a27872e`). `npm run build:android` exports JS only and is not a native Quest build.

## Headset verification matrix (PENDING)

Record headset model (Quest 3 / 3S), Horizon OS build, APK variant (`release`), git SHA, `libviro_renderer.so` SHA-256, `VrApi` FPS, and app/error logcat output:

- **D0:** Stage 01 + Stage 02 checklists on the Stage 03 release APK.
- **D1–D2:** First Solo standing (ring centered on user, opponent `~2.80 m` ahead facing user, level horizon, no own-body clipping, `'blue'` load reported, 360° look + head roll with zero world swim).
- **D3–D5:** Lean & crouch (standing and seated) with 1:1 local motion inside bounds; walk `> 0.30 m` past bounds -> passive stance-ring tint + status cue, zero camera clamping/snap.
- **D6–D9:** Seated Solo height, `Posture` toggle, app-only `Recenter` (90° turn + 0.5 m offset, double-press idempotence, 20× repeat), and Meta system recenter recovery via `Recenter`.
- **D10–D12:** `Back -> Solo` keeps calibration; `Exit -> Enter -> Solo` re-calibrates for the new entry; Meta/Home resume keeps calibration and `VRActivity` healthy.
- **D13–D17:** Controller pointer alignment on moved ring menu (unobstructed opponent), `VrApi` FPS under `onCameraTransformUpdate`, brief tracking loss (zero app-induced motion), 5-min comfort session, phone AR regression check.
