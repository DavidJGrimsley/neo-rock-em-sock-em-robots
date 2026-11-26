# Quest 06 motion combat

- Status: ACTIVE. Combat feel implementation and release build verified. Final independent review, in-place install, and wearer acceptance are pending.
- Task source: `project/agent/handoffs/2026-11-23-quest-06-motion-combat.md` + User failed Stage 06 physical playtest report against `a9bd8b3`
- Branch: `feat/quest-06-motion-combat` (base `origin/main` `964d85fe4c14d8a8e1261611ae71fb85bf7743ab`, PR #6)
- Worktree: `neo-rock-em-sock-em-robots-quest-06-motion-combat`
- Prior sessions: Grok 4.7 (`c0efdef9-09ba-45eb-90b7-52b362200927`, pre-rebase `5665e34`), Gemini 4 Hydrogen (`8f20f48c-c228-4d32-bdfe-34c1eee9e01b`, post-05B rebase & offline contract prep `d333192`; Stage 06 integration `a9bd8b3` in `82b07343-8095-41ac-8200-123db5802bdc` with Neon review `36800298-4d37-4bb9-9335-95206ef06c9c`).
- Remediation sole writer: Antigravity (`cad431a2-5f98-48ac-b156-f0cc58b473c3`), sole writer with zero code-writing delegation.
- Remediation Contrarian Reviewer: Gemini 4 Neon High (`antigravity` edit transport with strict read-only / no-edits / no-agents rules; pre/post SHA-256 verified zero writes across 268 files on every round).
- Control repository (`../project`): left unstaged and untouched in git as instructed (`../project/todo.md` and untracked handoff files preserved).

## Combat feel iteration

The supplied “Quest 06 Combat Feel, Enemy AI, Stagger, and Multisensory Feedback” task expands the earlier remediation. Gemini Hydrogen hit Google's individual quota with uncommitted edits. Codex continued as sole writer and retained those edits. Gemini Neon High round 1 (`769819d3-aca8-45a8-8951-63a5d70182a9`) returned FAIL against an earlier draft. Grok 4.7 High is the authorized cross-provider substitute for the read-only review of the repaired candidate.

| Root cause | Implementation |
| --- | --- |
| The menu compositor could replay cached ring art after Activity resume. Match-stage interruption and the scene's pause page had separate state. | Hide releases the owner and clears replay state. Activity resume draws the current page. The match's paused stage opens a controller-clickable card ahead of the wearer's horizontal gaze, including during countdown. Resume rebuilds any unfinished intro and requires fresh stick, A, and Menu input. |
| The HUD used the opponent's bearing and stage coordinates. | Patch 0008 uses an OpenXR VIEW-space quad 1.75 m ahead and 0.35 m up. A missing VIEW layer falls back to a tracked scene-root HUD. The Kotlin/renderer ABI is now v4. |
| Right-stick turns could enter prediction as rapid yaw and reset the gesture frame through a calibration callback. | Each fresh deflection makes one 30° turn by default. Smooth turn starts from a centered stick. Turns pivot the world calibration around the physical head, preserve hand history, and suppress rig velocity extrapolation at snap boundaries. |
| Shared pursuit and 200 ms recoil made Red feel relentless. | Quest-only CPU movement is capped at 78% of player speed. Red turns at 180°/s, checks the wearer's 68° half-angle before committing, telegraphs for 0.42 s or 0.62 s, holds the committed yaw, and recovers for 0.55 s. Red's earned uppercut window accommodates recovery and windup. |
| A single light clip and simple defense lock obscured the impact relationship. | Directional GLB hit clips, 0.34/0.56/0.92 s reactions, 0.85 s guard break, bounded Red recoil, poise recovery and temporary anti-stunlock resistance. Quest hit evaluation continues to use swept glove/body contact. A tracked duck or weave at punch contact gives a visible committed miss and a 0.85 s counter opening. |
| The Quest scene had no combat SFX path and secondary stagger cues could duplicate an impact. | One typed event per collision selects an Expo Audio effect, native OpenXR haptic and optional HUD/tint. Reused three distinct 48 kHz stereo punch WAVs, loaded into bounded pools through SDK 57 Expo Audio. A pause invalidates outstanding seeks. On-device logcat can report native playback start and errors. |

Tuning lives in `src/features/quest-vr/quest-tuning.ts`. Pause → Options exposes music and effect level, damage tint and turn mode for the current scene visit. Existing GLB strike, guard, recoil and launch clips are reused. Damage tint fades in 210 ms and keeps the center clear. The Quest settings, CPU, and rules are opt-in. Phone AR and multiplayer continue through the shared defaults. Audio is headset-local stereo.

### Quest 3S wearer checklist

1. Launch the installed release, select Solo and Ready. During the first countdown and again during a fight, turn physically away and press the left controller Menu button once. Confirm the Pause card appears in front, a held Menu does not toggle twice, and either Resume or a new Menu press returns to play. Hold the left stick, right stick and A during Resume, then release them and confirm the match only responds to fresh input. Repeat after opening the system menu and after recentering.
2. Look upward, downward, and away from Red. Verify HP/guard indicators stay above eye center while the ring card stays hidden. Test left/right snap turns, smooth turn in Options, and turning with both hands raised. Watch for unexpected world movement or prediction overshoot.
3. Land left/right punches, earn a three-hit uppercut, break Red's guard and score a heavy stagger. Confirm distinct audio/haptics, the striking hand, Red's recoil, and a recovery opening. Compare a blocked hit, incoming unguarded hit, successful guard and dodge. Verify tint can be disabled and volumes can be changed.
4. Back up or circle, guard a telegraphed punch, duck or weave through another, and counter during recovery. Move out of reach of an uppercut. Check that Red does not attack unseen or track a committed swing around the player. Remove or occlude a controller and use the system menu to check neutralization.
5. Complete several rounds and log comfort, sustained frame pacing, hit/guard clarity, actual audio audibility, and controller vibration. Record the tested commit and APK SHA. A successful install and native playback status are separate from wearer acceptance.

### Candidate verification

- `npm test` passed lint, typecheck, and 578 tests (14 AR, 373 app, 172 Quest, 16 UI, 3 dependencies). `npm run build:android` passed (2,447 modules). `git diff --check` passed with Git's `cr-at-eol` setting for the existing CRLF sources.
- Pinned ViroCore `23710240d2cab5d4e866f3dba44ef568d8e563b4` arm64 renderer rebuilt and passed the patched AAR compatibility checks against the pinned pristine baseline. Renderer SHA-256 `ceb5019be86641e287b444efc4569ea10c09abe269f64d02f04d5ca18e9f7f29`.
- The first native compile exposed references to the retired panel JNI methods. The final Kotlin path uses the v4 JNI entry points for both title spaces. Quest prebuild and `:app:processReleaseManifest :app:assembleRelease -PreactNativeArchitectures=arm64-v8a` passed. The packaged renderer hash matches the rebuild, all three punch WAVs are Android resources, and the release-APK Quest suite passed 172/172.
- Release APK `D:/nrq06/q8/android/app/build/outputs/apk/release/app-release.apk`, 140,287,643 bytes. SHA-256 `55f2e27fa5d285c5a3ca33a484077773b0211e490e8acf6bef041b892ce92e12`. Package `com.djleg.neorobots`, arm64-v8a.
- Grok status and models reported authentication ready and `grok-4.7` available. The sole read-only launch, session `a4e62be2-f234-4037-9f05-a7c756273972`, was rejected with HTTP 402 `Grok Build usage balance exhausted`. It returned no verdict. Pre/post SHA-256 checks matched all 28 reviewed task files and the Git index. JamSession's worksheet logger also failed on Windows because Python lacked `fcntl`.
- Quest 3S `3487C10J3706TQ` was initially connected. The subsequent Meta device query and USB ADB check found no connected device. In-place install and device base-APK SHA verification remain pending until USB debugging is available.

## Prior remediation against a9bd8b3

## Failed Playtest Diagnosis (`a9bd8b3`) & Remediation Fixes

### Observed Playtest Failures (`a9bd8b3` — treated as failed Stage 06 gate)
1. **No visible Quest player/CPU health bars or guard stamina bars**: `ArenaHUD` was phone-AR-only; `QuestArenaScene` showed only the bottom menu panel (`QuestMenu`), sky developer diagnostics, and static title lettering during fights.
2. **Punches seemed not to land**: `quest-gesture.ts` only emitted strikes when hand speed dropped `< 0.25 m/s` (missing snap-punches on immediate retraction), could lock `!armed` after stance shifts, strictly rejected lateral hooks `> 0.1 m`, received `head: null` (`yawRelative` reached `33°–77.5°` in `pid 24100` logs while `frame` stayed frozen), and `ArenaController` left `blue.yaw = 90°` frozen under `stableFacing: true` with random `L/R` hand choice.
3. **Blocking appeared ineffective & CPU beat player**: `guardUpMinM = -0.1` / `guardForwardMinM = 0.15` missed tight chin/chest guard poses, `guardMaxSpeedMps = 0.3` dropped guard with zero hysteresis on 1 frame of hand jitter, `guardStartup = 0.1s` + `guardHoldNs = 120ms` added 220ms startup delay, `blue.yaw = 90°` guard cone missed strafed CPU attacks, and Quest inherited aggressive phone-AR CPU timing (`cpuFirstDelay = 0.5s`, `cpuGuardReaction = 0.15s`).
4. **Dodge/weave unreadable & CPU appeared to punch body instead of head**: `Combat` GLB punches peak around `y ≈ 0.05` sim (`~0.55–0.66m` below Quest eye height on torso/chest), and live evade state (`active` `0.75s`, `cooldown` `0.35s`, `recenter-to-rearm`, `oob`, confirmed `"DODGED!"`) had no headset visual cue.
5. **No real controller vibration**: `VROInputControllerOpenXR` bound `_leftVibrateAction` / `_rightVibrateAction` and exposed `triggerHaptic`, but no JNI/JS bridge existed to trigger OpenXR haptics on landed strikes or incoming hits.

### Fixes Implemented
- **Native OpenXR Haptics (`tools/quest/viro-renderer/0007-openxr-quest-haptics.patch`, `lock.json`, `build-viro-renderer.mjs`, `QuestInputModule.kt`, `modules/quest-input/src/index.ts`)**:
  - Reuses the existing `VROInputControllerOpenXR` action set (`/user/hand/left/output/haptic`, `/user/hand/right/output/haptic`) with no second `XrSession` or `XrActionSet`.
  - Queues bounded per-hand pulses (`amplitude [0.05..1.0]`, `durationMs [10..500]`, 250ms staleness cap, session-generation tag) and flushes outside the queue mutex on `VROOpenXRRender` only when `sessionRunning && sessionState == XR_SESSION_STATE_FOCUSED`; clears cleanly on `beginSession`/`endSession` and degrades safely on Phone AR / failures (`LinkageError`-guarded `hapticsVersion/triggerHaptic/hapticsStatus`).
- **Motion Gesture Classifier (`src/features/quest-vr/quest-gesture.ts`)**:
  - Added `QUEST_COMBAT_GESTURE_THRESHOLDS` (`punchForwardM: 0.16`, `punchMaxLateralM: 0.28`, `uppercutMinUpRatio: 1.0`, `peakReversalM: 0.035`, `guardHoldNs: 55ms`, `guardExitGraceNs: 75ms`, `guardMaxSpeedMps: 0.65`, `guardForwardMinM: 0.12`, `guardUpMinM: -0.26`, `guardLateralMaxM: 0.19`) while preserving `PROVISIONAL_QUEST_GESTURE_THRESHOLDS` synthetic tests.
  - Added `followLiveHead` tracking live head yaw/position without wiping hand state, peak-reversal snap-punch emission, world-space `strikeStartWorld`/`strikePeakWorld` retreat re-arming immune to torso lean, raise-to-guard phantom-strike suppression via `inGuardBox` + `!wasGuarding` (with immediate re-arm), and immediate guard release on fast strike out of held guard.
- **Combat Integration & Feedback (`src/features/arena-fighter/arena-controller.ts`, `arena-match.ts`, `src/features/quest-vr/quest-arena-session.ts`)**:
  - Added sanitized `preferredHand?: 'L' | 'R'` across `attack`/`command`/`requestAttack`/`startAttack` and buffered counterpunches; preserved Phone AR `random()` when omitted and stripped untrusted remote `preferredHand` in `ArenaMatch.acceptCommand`.
  - Added `setCombatYaw` so `stableFacing: true` keeps `fighters.blue.yaw` (`90°`) and `QuestRing` horizon locked while combat strike/guard aim tracks wearer gaze (`±45°` frontal assist toward `bearingToRed`).
  - Added `takeEvadedHits()`, `getQuestCombatTelemetry()`, `QUEST_ARENA_RULES` Quest tuning (`guardStartup: 0.05`, `cpuFirstDelay: 1.0`, `cpuReaction: 0.4`, `cpuGuardReaction: 0.25`, preserving `cpuRecovery: 0.4` and all geometry constants), targeted OpenXR haptic actuation (`L=1` / `R=2` outgoing hits/blocks/breaks vs bilateral `mask=3` incoming hits/blocks/breaks, exception-safe), and `[QuestCombat]` diagnostics logging (`hapticsStatus`).
- **In-Headset Quest Combat HUD (`src/features/quest-vr/quest-combat-hud.ts`, `src/features/quest-vr/quest-arena-scene.native.tsx`)**:
  - Renders live `1280x360` transparent ARGB_8888 Combat HUD in `titleCompositor` during `presentation === 'eyes'` (returning to static game title on `'menu'`/`'side'`) with `5`-unit guard stamina & `0.25s` timer quantization, opponent-bearing pose quantized in `5°` steps (`±75°` clamp) via shared `questCombatHudLocalPose`, stage banners (`countdown`, `intermission`, `paused`, `presenting`, `finished`), uppercut streak `x/3`, guard state, evade status (`active`/`cooldown`/`recenter-to-rearm`/`oob`), incoming attack advice, and distinct strike outcomes, plus Viro fallback nodes with matching local pose & `ignoreEventHandling`.
- **Tests (`tests/arena-combat.test.cjs`, `tests/quest-gesture.test.cjs`, `tests/quest-input.test.cjs`, `tests/quest-renderer.test.cjs`, `tests/quest-menu-compositor.test.cjs`, `tests/quest-locomotion.test.cjs`, `tests/quest-first-person*.test.cjs`)**:
  - Added regressions covering `0007` OpenXR contract & JNI exports, `preferredHand` counterpunch & malformed remote safety, `combatYaw` aim/guard while `stableFacing: true`, `takeEvadedHits` + dodge `"DODGED!"`, snap punches, chin/chest guard + async raise suppression + uppercut out of guard, lean-immune rearm, unilateral vs bilateral haptics + haptic error resilience, HUD quantization & stage specs, and scene `titleCompositor` switching.

## Remediation Contrarian Review (Gemini 4 Neon High)

- **Round 1 (`953b0718-6815-4cc0-837d-82533565352d`)**: **FAIL** — 0 Critical, 3 High (H1 disarmed hands + async settle in guard suppression; H2 60Hz 1.84MB GL HUD upload during stamina drain; H3 false `DRAW` banner on `presenting` KO), 4 Medium (M1 counterpunch `bufferedHand`; M2 `75ms` grace blocking snap-punch from guard; M3 head-lean rearm coordinate mix; M4 unchecked remote `preferredHand`), 2 Low, 3 Nits -> all fixed.
- **Round 2 (`9c8f27a6-a310-4e5b-bd03-15fe6dd10455`)**: **CONDITIONAL** — Medium #1 double `menuFrame` transform on fallback Viro HUD node; Medium #2 `settledIntoGuard` missing `!wasGuarding`; Low #1 fallback `'cooldown'` `0.0s` when cooldown 0 during `fighting`; Low #2 H2/L1 tests; 2 Nits -> all fixed.
- **Round 3 (`2c694e9b-6619-44a5-86b9-dcf609316453`)**: **PASS** — all items verified against file lines and `npm test` (566/566 passing, 0 failed). Zero reviewer writes confirmed across all 3 rounds via pre/post SHA-256 hash manifests.

## Final Verification, Build & Device Install

- `git diff --check`: exit 0
- `npm test`: exit 0 (`lint`, `typecheck`, `test:ar` 14/14, `test:app` 373/373, `test:quest` 160/160, `test:ui` 16/16, `test:dependencies` 3/3 — 566/566 pass)
- `npm run build:android` (`expo export --platform android --max-workers 2`): exit 0 (2443 modules, 71 assets)
- Pinned Viro renderer (`native/quest-viro-renderer/viro_renderer-release.aar`): rebuilt cleanly via `node tools/quest/build-viro-renderer.mjs` (`rendererSha256` `e6fc381b454b82f1b72d96cc6c6bec4b6406922f9990e519ab84c0035473bde6`, `aarSha256` `84854fd573bad7e534bcaaac1eda8a3c5a5700bc18fcb6b6d9b234e98096405e`, `0007` SHA-256 `5e9978764275b50ce1a69daaee750a00ba4a90c9b664554e18eb9ce5a0582ab5`, `abis: ["arm64-v8a"]`).
- Native arm64 Quest release APK (`D:\nrq06\w\android\app\build\outputs\apk\release\app-release.apk`):
  - Prebuild `QUEST_BUILD=1 npx expo prebuild -p android --clean --no-install` (`ViroPlatform.QUEST`), Gradle `:app:processReleaseManifest :app:assembleRelease -PreactNativeArchitectures=arm64-v8a -I ..\tools\quest\short-cmake.gradle` `BUILD SUCCESSFUL`.
  - Size: `140246639` bytes; APK SHA-256: `5180589579ed3c98e313ca00e0932ea0d39858002c1acdf4d1017439b8cb409f`.
  - `aapt2 dump permissions`: `INTERNET`, `MODIFY_AUDIO_SETTINGS`, `VIBRATE`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, `com.djleg.neorobots.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`.
  - `QUEST_RELEASE_APK=... npm run test:quest`: 160/160 pass.
- Device install (Quest 3S `panther`, serial `3487C10J3706TQ`):
  - `adb -s 3487C10J3706TQ install -r` (no uninstall/clear): `Performing Streamed Install` -> `Success`.
  - On-device `/data/app/.../base.apk` sha256sum `5180589579ed3c98e313ca00e0932ea0d39858002c1acdf4d1017439b8cb409f` (exact match), `firstInstallTime=2026-11-18 19:01:45` preserved, `lastUpdateTime=2026-11-25 10:50:50`.
- **Pending Human Playtest Checks**:
  1. Launch `com.djleg.neorobots` -> Solo -> Ready in headset; verify live Quest Combat HUD above Red shows Blue/Red HP, Guard Stamina %, Uppercut streak, incoming attack cue, Dodge status, and strike outcome banners.
  2. Throw left/right snap-punches and uppercut; confirm punches land cleanly (`CLEAN HIT (L/R)!`) and trigger left-hand vs right-hand controller haptic feedback (`[QuestCombat] haptics=(... app>0 fail=0 xr=0)` in logcat).
  3. Raise both hands in chin/chest guard to block CPU punch and verify guard blocks damage (`BLOCKED!`), drains guard stamina bar, and triggers bilateral haptic feedback (`mask=3`).
  4. Take an unblocked CPU punch (`TOOK HIT!` + stronger bilateral haptic) and duck/weave during incoming punch (`EVADING (DUCK/WEAVE)` -> `"DODGED!"`).

---

## Archive — Prior session (Post-05B rebase & offline prep, `d333192`)

- **Session:** `8f20f48c-c228-4d32-bdfe-34c1eee9e01b` (Neon review `76165b07-37ee-4e10-849e-b9841e37fbc1` PASS)
- **Previous owner:** Grok 4.7 (`c0efdef9-09ba-45eb-90b7-52b362200927`, pre-rebase `5665e34`).
- **Scope:** Rebased cleanly onto `origin/main` (`964d85fe4c14d8a8e1261611ae71fb85bf7743ab`, PR #6), reconciled `quest-gesture.ts` with 05B `poseSource: 'aim' | 'grip'`, `headRefEpoch`, `recentering`, and `nowNs` freshness while keeping combat integration/CPU restoration blocked prior to user confirmation of 05/05B physical gates.
