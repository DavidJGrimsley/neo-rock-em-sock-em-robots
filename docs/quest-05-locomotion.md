# Quest Stage 05 — View-Relative VR Locomotion & Playtest Fixes

Status: Implementation and host test updates in `feat/quest-05-locomotion`; **physical Meta Quest headset verification is PENDING**.

## Scope & Architecture

### 1. View-Relative Horizontal Left Thumbstick (`quest-locomotion.ts`, `quest-head-tracker.ts`, `arena-movement.ts`, `arena-controller.ts`, `quest-arena-session.ts`)

- `QUEST_STICK_DEADZONE = 0.15` radial deadzone rejects resting stick jitter while rescaling active magnitude linearly across `(0, 1]`.
- `mapLeftThumbstick(x, y, deadzone)` normalizes direction radially when `Math.hypot(x, y) > deadzone` so diagonals carry unit strength (no `sqrt(2)` boost) in the viewer's horizontal frame:
  - `+y` (push up/forward) -> `+viewAdvance` (along live horizontal head look heading)
  - `-y` (pull down/back) -> `-viewAdvance` (opposite live horizontal head look heading)
  - `-x` (push left) -> `+viewStrafe` (perpendicular left on horizontal floor plane)
  - `+x` (push right) -> `-viewStrafe` (perpendicular right on horizontal floor plane)
  - **Unverified hardware note**: Physical controller signs remain unverified on headset until wearable playtest pass completes.
- **View-relative projection from live unthrottled native head samples (`quest-head-tracker.ts`, `quest-locomotion.ts`)**:
  - `questHeadTracker.getLiveHeadState()` and `subscribeLive()` expose live native `onCameraTransform` samples and `calibration` immediately at frame cadence without the 200 ms React UI snapshot throttle.
  - `resolveQuestHeadHeading()` projects `sample.forward` onto the horizontal XZ floor plane via `yawFromForward()` (invariant to pitch and roll; no vertical flight, speed change, or direction flip) and computes `yawRelative = wrap180(liveYaw - calYaw)`.
  - `mapViewRelativeThumbstick(x, y, yawRelative)` rotates `(viewAdvance, viewStrafe)` by `yawRelative` into the fixed ring anchor frame so `blue` translates linearly along the wearer's current look heading in OpenXR `LOCAL` while `QuestRing`'s world rotation remains locked (no forced camera rotation, clamping, or auto-turning toward the opponent).
  - **Fallbacks & safety neutralization**: Degenerate near-vertical gaze (`|horizNorm| < 0.2`) holds `lastValidYaw` (or `calibration.yaw` when unavailable). Missing, invalid, or stale (`> QUEST_HEAD_SAMPLE_STALE_MS = 250 ms`) head samples fall back stably to `calibration.yaw`. `questLocomotionFromInput` + `QuestArenaSession` neutralize immediately with zero drift on pause (`appActive === false`), menu focus (`menuFocused === true`), session/focus loss (`!sample.focused`, `status !== 'live'`), controller tracking loss (`left.tracking === 'lost'` or inactive stick/actions), `refEpoch` mismatch, unconfirmed sample-jump recenter (`pendingJump`), system recenter transition (`acceptSystemRecenter`), and `back()` / `exit()` / `dispose()`.
- **Linear movement & phone AR isolation (`arena-movement.ts`, `arena-controller.ts`)**:
  - `ARENA_RULES` preserves phone AR/iOS defaults unchanged (`boundary: 0.175`, `separation: 0.055`, `reach: 0.095`, `stableFacing: false`, `cpuEnabled: true`).
  - `QUEST_ARENA_RULES` sets `stableFacing: true` so `ArenaController.move(dt)` keeps `blue.yaw` constant (no forced world rotation around `QuestRing`) and translates linearly via `arenaLinearMovement`, sliding around a stationary opponent without circular orbit curving inward. Opponent (`red`) continues facing `blue`.

### 2. Quest-Only Ring Boundary & Minimum Separation (`quest-arena-session.ts`)

- **Usable ring boundary (`QUEST_ARENA_RULES.boundary = 0.205`)**: Verified against `Fight_Arena.glb` vertices under scene transforms (`ARENA_LAYOUT.arenaScale = 0.002016`, `arenaHorizontalScale = 1.25`, `arenaBaseOffset = [-0.0005, 0, -0.0041]`): the smallest inner rope/post vertex radius is `0.22326` sim units (`3.572 m` at `QUEST_WORLD_SCALE = 16`). Setting Quest `boundary = 0.205` (`3.28 m`) expands usable movement radius by `+0.48 m` over the `0.175` phone AR boundary while preserving `0.01826` sim (`0.292 m`) margin inside the closest rope vertex.
- **Minimum separation (`QUEST_ARENA_RULES.separation = 0.085`)**: At `0.055`, neutral `ROBOT_EYE_MODEL` Z forward offset (`0.01522` sim = `0.2436 m`) + posed `IdleAggro` `head_01` maxZ (`0.0299` sim = `0.478 m`) left only `0.158 m` neutral eye-to-head gap (`-0.042 m` at `0.20 m` `QUEST_HEAD_BOUNDS.standing.forward` lean). Increasing Quest `separation` to `0.085` (`1.36 m` VR) leaves `0.638 m` neutral (`0.438 m` at max `0.20 m` lean) and remains inside punch reach (`Combo_PunchL/R` swept contact `<= 0.114` sim). Note for Stage 06 combat: `Combo_UppercutL/R` at `hitCheckSeconds = 0.48..0.547` currently connects up to `0.058` sim and will need Stage 06 step/timing tuning.

### 3. Single-Node Composed `QuestRing` Transform & Jitter Fix (`quest-head-rig.ts`, `quest-arena-scene.native.tsx`)

- Root cause of turning+moving scene jitter: dispatching separate `setNativeProps` updates to `rigOuter` (`{ position, rotation }`) and `rigContent` (`{ position: contentOffset }`) enqueued separate async `VRONode::setPositionAtomic` / `setRotationAtomic` lambdas to `VROPlatformDispatchAsyncRenderer`, creating frame-to-frame transform tearing when `rotationY` and `contentOffset` changed simultaneously (compounded by `initialRingPose` re-depending on `calibration`).
- Added `questComposedRigTransform(cal, anchor, scale)` to combine `rigOuter`, `scale`, and `contentOffset` into a single rigid `{ position, rotationY, scale }` applied atomically to one `rigOuterRef` node in `QuestRing`. `initialRingPose` dependencies exclude live `calibration`. Added sparse `[QuestRing] rigStep` jump instrumentation.

### 4. Analog Slot & Explicit Virtual Readiness (`arena-controller.ts`, `arena-match.ts`)

- Added `AnalogMovement` and `setAnalogMovement(input, roundId, id)` to `ArenaController` and `ArenaMatch`, keeping `arena-protocol.ts` and existing digital `held` / combat button inputs unchanged.
- Added explicit `virtualReady` (`setVirtualReady(token, ready)`, `isVirtualReady()`). `QuestArenaSession.solo()` enables virtual readiness and `setLandscape(true)` without asserting `setTracking` or `setPlacement`, keeping phone AR tracking/orientation gates untouched.

### 5. Real-Time Loop & Resume Compositor Replay (`quest-arena-session.ts`, `quest-arena-scene.native.tsx`, `QuestPanelModule.kt`, `quest-menu-compositor.ts`)

- React Native `requestAnimationFrame` + `performance.now()` advances `ArenaMatch.tick(token, dt)` with `<= 0.1s` frame clamp and `<= 0.05s` substepping while active.
- `questRuntime.appStateChanged(active)` and `vrActivityState` pause/neutralize locomotion immediately on background/pause/Home/menu focus.
- **Resume black-card fix**: On pause -> `Match paused. Select Ready to resume.` (`1216x720`) -> resume, JS `lastSpec` and Kotlin `drawnPixelsKey` matched pre-pause dimensions/contents and skipped `nativeDraw`, while `QuadLayer::prepare` only uploads swapchain pixels when `_revision` changes. Added `QuestPanelModule.invalidate` / `invalidateTitle` (clears `drawnPixelsKey` under `drawLock` without hiding or bumping owner) and `MenuCompositor.replay()`, triggered on the rising edge `appActive && vrActivityState === 'resumed'` in `syncRuntimeActive`, with clean fallback to Viro buttons if `invalidate` fails.
- Separate intermittent full-black-view resume report did not leave device logs and remains unverified until headset log capture.

### 6. Temporary Stage 05 Idle Opponent (`quest-arena-session.ts`)

- `QUEST_STAGE_05_IDLE_OPPONENT_RULES = { cpuEnabled: false }` is merged with `QUEST_ARENA_RULES` solely in `createQuestArenaSession().solo()`. Default `ArenaMatch` / `ARENA_RULES` retain `cpuEnabled: true` for phone AR solo and other modes.
- Opponent remains visible in `IdleAggro` at spawn (`x = ±ARENA_RULES.spawn, z = 0`), updates facing `yaw` toward the player as the player moves, never moves or attacks, and enforces `QUEST_ARENA_RULES.separation` and `QUEST_ARENA_RULES.boundary`.
- Temporary for Stage 05 locomotion verification; remove `QUEST_STAGE_05_IDLE_OPPONENT_RULES` when Stage 06 Quest combat/AI begins.

### 7. Quest A-Button Directional Dash (`quest-locomotion.ts`, `quest-input-source.ts`, `quest-arena-session.ts`, `arena-controller.ts`, `arena-match.ts`)

- **Verified OpenXR binding & button identity**: In `VROInputControllerOpenXR.cpp` + `0003-openxr-quest-input-sampler.patch`, `_aButtonAction` is bound to `/user/hand/right/input/a/click` and captured via `xrGetActionStateBoolean` (only while `state.isActive`), published as `right.primaryActive` + `right.primary` (`ACTIVE_PRIMARY` / `DOWN_PRIMARY`), and decoded in `quest-input.ts` as `sample.right.buttons.primary` (`true` pressed, `false` released, `null` inactive). Left-hand primary (`X`, `/user/hand/left/input/x/click`), triggers, grips, menu rays, and Viro clicks never trigger dash. No new OpenXR session, action, or binding was added.
- **Rising-edge capture & safety gates (`evaluateQuestDashInput` in `quest-locomotion.ts`, `quest-input-source.ts`, `quest-arena-session.ts`)**:
  - `QuestInputSource.onSample` passes newly accepted live batch samples (`acceptedSamples`) so multi-frame polls never drop a rising edge, while preserving full backward compatibility with 2-argument listeners.
  - Arming requires observing `right.buttons.primary === false` while all safety gates are true (`status === 'live'`, `sample.focused`, `sample.actionsReady`, `appActive`, `!menuFocused`, `!recenterNeutral`, matching `refEpoch`, valid `resolveQuestHeadHeading`, `left.tracking !== 'lost'`, `right.tracking !== 'lost'`, and `stage === 'fighting'`).
  - Pressing `A` while held on startup, reconnect, focus recovery, menu unfocus, unpause, or recenter recovery does not fire. Pressing `A` while the left stick is neutral or inside `QUEST_STICK_DEADZONE` (`0.15`) does nothing and consumes arming so holding `A` into later stick movement never buffers a dash. Holding `A` across frames fires at most one dash.
- **Direction & VR-safe kinematics (`QUEST_ARENA_RULES`, `ArenaController.dash`)**:
  - At the rising edge, `evaluateQuestDashInput` normalizes the current view-relative left-stick intent (`mapViewRelativeThumbstick`) to a unit vector in the ring's horizontal XZ plane (supporting all 4 cardinals and normalized diagonals) and latches it for the entire dash. Subsequent head turns, pitch/roll changes, stick changes, stick release, `A` release, or opponent facing changes do not bend the dash.
  - **Deliberate VR comfort & simulation parameters** (physical headset comfort remains **UNVERIFIED** until on-headset test):
    - `dashTravel = 0.06` sim (`0.96 m` at `QUEST_WORLD_SCALE = 16`, matching `ARENA_RULES.hopTravel`).
    - `dashMinimum = 0.01` sim (`0.16 m` minimum reachable displacement, matching `ARENA_RULES.hopMinimum`).
    - `dashDuration = 0.24 s` immediate quadratic ease-out `1 - (1 - t)^2` (average speed `0.25 sim/s = 4.0 m/s`, peak initial speed `8.0 m/s`, no `2/30 s` ground-prep delay).
    - `dashRecovery = 0.25 s` post-dash cooldown (matching `ARENA_RULES.hopRecovery`).
    - Zero vertical camera/rig lift (`lift = 0`), zero forced camera/fighter `yaw` rotation (`stableFacing: true`), and directional walk animation clips (`WalkForward` / `WalkBackward` / `StrafeLeft` / `StrafeRight`) instead of forcing backward-only `JumpBack`.
  - **Deterministic anti-tunneling collision**: `ArenaController.stepLinearMovement` substeps `arenaLinearMovement` in `<= min(separation * 0.25, 0.005)` sim increments (~`8 cm` max substep in VR), guaranteeing `distance(blue, red) >= separation` (`0.085`) and `hypot(x, z) <= boundary` (`0.205`) throughout every step at all speeds, allowing smooth diagonal slides along the ropes or stationary opponent while gracefully rejecting dashes straight into a flush wall or opponent (`< dashMinimum`).
  - **Safety neutralization**: Pause (`appActive === false`), menu focus, OpenXR focus loss, tracking loss (`left` or `right` `'lost'`), stale/ended input, `refEpoch` mismatch, or recenter immediately cancel any active dash via `cancelDash()`, disarm `A`, zero `QuestRigSync` extrapolation velocities (`notifyFrame(0)`), and leave zero residual drift.
  - **Phone AR / iOS / Multiplayer isolation**: `ARENA_RULES.dashEnabled = false`; phone AR `jumpBack` / `hop` (`ARENA_RULES.boundary = 0.175`, `separation = 0.055`, `stableFacing = false`, `cpuEnabled = true`) and `arena-protocol.ts` are untouched.
- **Future General Stamina Hook (Deferred in Stage 05)**:
  - No stamina cost is charged in Stage 05 (`dashStaminaCost = 0`), and `guardStamina` (blocking stamina) is strictly untouched and never read or charged by dash.
  - `ArenaController` exposes `DashStaminaHook` (`setDashStaminaHook({ canAfford, spend })`) and `ARENA_RULES.dashStaminaCost` so Stage 06+ can plug a general stamina pool into `dash()` without altering blocking's `guardStamina`.

## Native Quest Build Verification (Short-Path Stage)

- Staged clean worktree files + Stage 04 `native/quest-viro-renderer` into `D:\nrq05\w` with `QUEST_CXX_ROOT=D:\nrq05\cxx`, `TEMP=D:\nrq05\tmp`, `TMP=D:\nrq05\tmp`, `GRADLE_USER_HOME=D:\nrq04\gradle`.
- Built `:app:processDebugManifest :app:processReleaseManifest :app:assembleDebug :app:assembleRelease -PreactNativeArchitectures=arm64-v8a -I ..\tools\quest\short-cmake.gradle --console=plain`. See `project/agent/reports/2026-11-22-quest-05-playtest-fixes.md` for current APK SHA-256 hashes, permission dump, and device install status.

## Physical Quest Headset Gate (PENDING)

| Check | Status | Notes |
| --- | --- | --- |
| Solo -> Ready transitions lobby -> countdown -> fighting | **PENDING** | Verified in unit/VM tests only; needs on-headset confirmation |
| View-relative thumbstick cardinal/diagonal signs & live head steering | **PENDING** | Verify up/down/left/right follow current headset look heading on horizontal floor plane across head turns, pitch/roll, and recenter |
| Head-yaw 1:1 tracking & comfort during rotation + movement | **PENDING** | Verify composed single-node `QuestRing` update removes 30-50px scene jitter |
| Separation & expanded ring boundary (`0.085` / `0.205`) vs visible ropes/idle robot | **PENDING** | Confirm comfortable eye distance and inability to step through visible ropes |
| Meta Home / sleep / resume black card & full-view recovery | **PENDING** | Pause into menu, Meta Home / sleep, resume; confirm visible menu card text + no black eye buffer |
| Menu focus / safety neutralization | **PENDING** | Point controller ray at Back, tap Meta Home; confirm immediate locomotion stop |
