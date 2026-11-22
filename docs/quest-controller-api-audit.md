# Quest controller API audit (Stage 04)

Written before any Stage 04 bridge code. Scope: can the installed Viro stack give the Quest scene left/right tracked controller poses, continuous thumbsticks, trigger/grip/buttons, timestamps and tracking loss, inside Viro's existing OpenXR session? Not a headset test. Stage 03 and Stage 04 headset gates are **pending**.

## Versions checked

| Item | Value | Evidence |
| --- | --- | --- |
| `@reactvision/react-viro` | 3.0.3 | `package-lock.json` (`node_modules/@reactvision/react-viro`), installed `package.json` |
| ViroCore source | `v3.0.3`, `23710240d2cab5d4e866f3dba44ef568d8e563b4` | `tools/quest/viro-renderer/lock.json` |
| Stock renderer AAR | SHA-256 `cd654a19…dc7` | `lock.json` `stockAarSha256`, checked by `build-viro-renderer.mjs` |
| Quest renderer | stock 3.0.3 Java/JNI + arm64 `libviro_renderer.so` rebuilt with 0001 (pointer) and 0002 (menu layer) | `build-viro-renderer.mjs`, `with-quest-viro-renderer.cjs` |

The six OpenXR sources below were fetched at the pinned revision; 0001 and 0002 apply to them with full context. Line numbers are upstream (pre-patch) unless stated.

## JavaScript and Java bridge: insufficient

- `ViroController` (`dist/components/ViroController.d.ts`): `onClick`, `onClickState`, `onTouch`, `onScroll`, `onSwipe`, `onControllerStatus` (`status: any`), `onFuse`, `onPinch`, `onRotate`, `onDrag`, `getControllerForwardAsync()`. There is **no** `getControllerRayAsync` and no position, orientation, velocity, timestamp or tracking-state API. A forward vector is not a pose.
- `ViroScrollEvent` is `{ scrollPos, source }`: no time, and it is delivered to the node under the ray.
- No class in `react_viro-release.aar` or `viro_renderer-release.aar` references `onMove`, so the native per-frame `onMove(source, pos, rot, fwd)` never reaches Java or JavaScript.
- Menu ray events (`onClickState`, `onHover`) stay the Stage 02 menu path. They are not tracked poses and are not used as such.

## Native OpenXR input: present, but private and filtered

`VROInputControllerOpenXR` (ViroCore `android/sharedCode/src/main/cpp`):

- One action set `viro_gameplay`, separate actions per hand (`countSubactionPaths = 0`). Handedness is the bound path, not a heuristic.
- Bindings, all in one `xrSuggestInteractionProfileBindings` call for `/interaction_profiles/oculus/touch_controller` (`.cpp:146-183`): `aim/pose`, `trigger/value`, `squeeze/value`, `thumbstick` (vector2f) per hand; `a/click`, `b/click` (right); `x/click`, `y/click`, `menu/click` (left); haptics.
- **Not bound:** grip pose, thumbstick click, any touch/capacitive input.
- `xrAttachSessionActionSets` is called once (`.cpp:213`). A failed suggestion returns before the attach (`.cpp:179-183`), which would lose every Viro input including menu clicks.
- `onProcess(session, _stageSpace, frameState.predictedDisplayTime, camera)` runs on the `VROOpenXRRender` thread once per **rendered** frame, only when views are valid and `shouldRender` (`VROSceneRendererOpenXR.cpp:1285-1328`). `_stageSpace` is a `LOCAL` space (`.cpp:565`), the same space as the head camera.
- What reaches Viro's own handlers is filtered:
  - thumbsticks only above a 0.15 dead zone, as `onScroll`, with no zero/release event (`.cpp:24, 505-533`);
  - trigger and squeeze as clicks at 0.5;
  - poses held for up to 5 stale frames (`stickyPose`, `kMaxStaleFrames`);
  - a missing controller pose filled from hand-tracking aim;
  - `XR_SPACE_LOCATION_*_TRACKED_BIT`, pose-action `isActive` and the `xrSyncActions` result discarded.
- B and Menu ClickDown call `onNativeBackButton` (`VROSceneRendererOpenXR.cpp:209-228`): Android back. In VR this leaves the scene.

## Session, threads and lifecycle

- One `XrSession` per `VROSceneRendererOpenXR`, created in its constructor (`createSession`, `.cpp:515`) and destroyed in `onDestroy → destroySession` after the render thread is joined (`.cpp:890-915, 973-990`). `onDestroy` can run twice (explicit destroy, then destructor). Each VR entry builds a new renderer, so process-wide state needs a session generation.
- `renderLoop` polls events and renders while `_sessionRunning`; it idles 100 ms per loop while paused, IDLE or UNKNOWN (`.cpp:1106-1131`). In VISIBLE (system menu), frames still render, but `xrSyncActions` returns `XR_SESSION_NOT_FOCUSED` and actions are inactive.
- Horizon system recenter: 0002 bumps `quest_panel::refSpaceEpoch` before `xrLocateViews` on the frame where `LOCAL` changes. That is not a session restart.
- Viro's `recenterTracking()` replaces `_stageSpace` from a JNI thread. The app never calls it, and Stage 04 keeps it that way.
- Viro does not enable `XR_KHR_convert_timespec_time`, so `XrTime` cannot be converted to `CLOCK_MONOTONIC` and the two are never subtracted.
- `QuestPanelLayer.h` defines `extern "C"` JNI functions and a `static` epoch in a header included once, by `VROSceneRendererOpenXR.cpp`. Including it in another source file would duplicate symbols and split the counter. `sharedCode/CMakeLists.txt:78` lists sources explicitly, so a new `.cpp` would also need a CMake edit.

## Decision

The JavaScript API cannot pass the gate. Add patch **0003** to the existing Viro OpenXR session. It adds no OpenXR session, action set, binding, extension or reference space.

1. `VROInputControllerOpenXR` keeps the `xrSyncActions` result. Right after it, it reads the actions Viro already bound: each aim space is located again with `XrSpaceVelocity` chained, and each existing action state is queried. This happens before the dead zone, sticky poses and hand fallback, and the values go into a plain raw struct. Viro's own event handling is unchanged.
2. `QuestInputSampler.h` is included only by `VROSceneRendererOpenXR.cpp`.
   - After `onProcess`, it publishes the struct into a 64-frame ring, protected by a `std::mutex` that guards copies only.
   - Each frame is tagged with a monotonic sequence number, session generation, reference epoch, session state, `XrTime` and `CLOCK_MONOTONIC`.
   - Rendered frames without input are counted.
   - The interaction profile is read on `XR_TYPE_EVENT_DATA_INTERACTION_PROFILE_CHANGED`.
3. `modules/quest-input` (`QuestInputModule`, Android, optional like `QuestPanelModule`) reads the ring synchronously from the JS thread. JNI arrays are filled after the lock is released.
   - Payloads are kept separate: `FloatArray` (pose and axes), `IntArray` (flags) and `LongArray` (sequence and times).
   - Times leave Kotlin as exact nanosecond deltas from a per-session origin; the absolute origins are passed as decimal strings.
4. `src/features/quest-vr/quest-input*.ts` decode, validate and classify the data as tracked / inferred / lost / stale / unfocused / unavailable. They keep a JS ring, publish to React at 5 Hz, and log at 1 Hz plus on changes. The in-headset markers are moved from these same samples.

The pose is the OpenXR **aim** pose: a 6DoF pose of the controller, enough for this gate and for future motion input. Stage 05B fists will need the grip pose, or a calibrated aim-to-grip offset. That is a later, separate decision, because adding a binding changes the single shared suggestion and attach that all Viro input depends on.

## Target sample shape

`QuestInputSample` (`src/features/quest-vr/quest-input.ts`):

- **Times and identity:** `seq`, `generation`, `refEpoch`; `displayTimeNs` (`XrTime` domain) and `capturedNs` (`CLOCK_MONOTONIC` domain), each relative to its session origin; `syncResult` and `sessionState`.
- **`left` / `right`:**
  - `aimPose` (position plus `xyzw` orientation, `LOCAL` metres) or `null`;
  - `positionValid`, `positionTracked`, `orientationValid`, `orientationTracked`;
  - linear and angular velocity, each with its own flags;
  - `poseActive`;
  - raw `thumbstick { x, y }`, `trigger` and `squeeze`, each with an `active` flag;
  - buttons: `primary` (A/X), `secondary` (B/Y) and, on the left only, `menu`.

## Future controls (context only, not Stage 04 work)

The user's intended scheme is Quest motion controllers only:

- physical motion for punching, blocking and ducking;
- left stick strafe;
- right stick forward/back;
- right trigger for a stamina-costing directional hop or dash.

Stage 04 therefore has to prove continuous X/Y on **both** sticks, an analog right trigger, and poses with velocity and honest tracking flags. It maps none of them to gameplay.
