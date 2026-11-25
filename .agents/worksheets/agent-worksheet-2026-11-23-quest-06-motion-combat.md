# Quest 06 motion combat

- Status: IMPLEMENTATION COMPLETE & INSTALLED ON QUEST 3S (`3487C10J3706TQ`); Stage 06 physical wearer combat validation remains PENDING (do not assert a wearer test).
- Task source: `project/agent/handoffs/2026-11-23-quest-06-motion-combat.md`
- Branch: `feat/quest-06-motion-combat` (base `origin/main` `964d85fe4c14d8a8e1261611ae71fb85bf7743ab`, PR #6)
- Worktree: `neo-rock-em-sock-em-robots-quest-06-motion-combat`
- Prior sessions: Grok 4.7 (`c0efdef9-09ba-45eb-90b7-52b362200927`, pre-rebase `5665e34`), Gemini 4 Hydrogen (`8f20f48c-c228-4d32-bdfe-34c1eee9e01b`, post-05B rebase & offline contract prep committed at `d333192` with Neon review `76165b07-37ee-4e10-849e-b9841e37fbc1`).
- Current sole implementation owner: Gemini 4 Hydrogen High (`82b07343-8095-41ac-8200-123db5802bdc`), continuing on user confirmation (2026-11-25) that physical Quest gates for Stage 05 (`PR #5`) and Stage 05B (`PR #6`) are verified.
- Contrarian reviewer (Stage 06 integration): Gemini 4 Neon High (`36800298-4d37-4bb9-9335-95206ef06c9c`, `antigravity` edit transport with strict read-only / no-edits / no-agents instructions; pre/post SHA-256 verified zero reviewer writes).
- Control repository (`../project`): marked Stage 05 `[x]` with PR #5 completion link and dated `(2026-11-25)` user-confirmed physical gate note, and added matching dated user-confirmed physical gate note to Stage 05B (preserving its PR #6 link) in `../project/todo.md`. Because `../project/todo.md` contains preexisting foreign edits (plus untracked `agent/` files and 8 unpushed local commits ahead of `origin/main`), `../project/todo.md` was left unstaged and untouched in git as instructed.

## Stage 06 implementation changes

- `src/features/quest-vr/quest-gesture.ts`: updated module doc comment reflecting Stage 06 live wiring (`poseSource: 'grip'`), while keeping `QUEST_GESTURE_THRESHOLD_BASIS = 'provisional-unmeasured'` (no synthetic thresholds are claimed as measured on Quest).
- `src/features/arena-fighter/arena-controller.ts` & `src/features/arena-fighter/arena-match.ts`:
  - Preserved `ARENA_RULES.headEvasionEnabled = false`, `uppercutActiveEnd = 0.547`, `uppercutReach = 0.06`, `cpuEnabled = true`, and `stableFacing = false` for Phone AR.
  - Added bounded head evasion (`HeadEvasionInput`, `isEvading`, `setHeadEvasion`) gated by `headEvasionEnabled`, `evadeDuration = 0.75`, `evadeCooldown = 0.35`, upright cooldown re-arming, immediate cancel on `outOfBounds`/pause/round reset, mutual exclusion with guard/hitstun/launch/hop, and punch-only evasion (uppercuts never evaded).
  - Updated `ArenaController.startAttack` to honor `!(this.rules.stableFacing && id === 'blue')`, matching `move()`, so throwing punches after strafing does not snap-rotate the Quest VR rig.
  - Note on EOL: `arena-controller.ts` and `arena-match.ts` had CRLF on `origin/main` and were intentionally normalized to LF so `git diff --check` passes (`exit 0`) under `core.autocrlf=false`.
- `src/features/quest-vr/quest-arena-session.ts` & `src/features/quest-vr/quest-arena-scene.native.tsx`:
  - Removed `QUEST_STAGE_05_IDLE_OPPONENT_RULES` from `solo()` (restoring Quest CPU combat `cpuEnabled: true`) while adding optional `rulesOverride?: Partial<typeof ARENA_RULES>` on `createQuestArenaSession` for isolated unit harnesses.
  - Configured `QUEST_ARENA_RULES` with `uppercutReach: 0.073`, `uppercutActiveEnd: 0.68` (reaching Quest `separation: 0.065` without changing `ARENA_RULES`), `headEvasionEnabled: true`, `evadeDuration: 0.75`, and `evadeCooldown: 0.35`.
  - Wired `createQuestGestureClassifier({ poseSource: 'grip' })`, `setInputState(sample, status, batch, nowNs)` (`quest-arena-scene.native.tsx` passes `input.getLiveState?.().nowNs`), uppercut eligibility preservation (`ArenaMatch` remains authority), `guardNeedsPhysicalRelease` after `guardState === 'exhausted'`, `syncHeadEvasion` via `gameplayHeadPose`, `syncGestureFrame`, and full neutralization on `unfocused`, `stale`, `staleNowNs`/`nullNowNs`, `actionsNotReady`, `bothHandsLost`, `refEpoch` mismatch, `recenter`, `menuFocus`, and `pause`.
  - Added `lastProcessedLiveKey` deduplication so 11 ms idle polls from `QuestInputSource` (`batch === undefined`) do not re-push an already-processed live sample with fresh `nowNs`, and `dispatchSessionGuard` / `releaseSessionGuard` deduplication so repeated non-open samples cannot queue `>= 32` `'block-up'` commands and pause `ArenaMatch`.
  - Updated `QUEST_READY_SAVED` and exposed `isEvading()` & `getMatchSnapshot()`.
- `tests/arena-combat.test.cjs`, `tests/quest-gesture.test.cjs`, `tests/quest-locomotion.test.cjs`, `tests/quest-first-person-body.test.cjs`:
  - Preserved phone AR checks, added `headEvasionEnabled` / `stableFacing` attack-yaw tests, updated locomotion/body isolated harnesses to pass `{ cpuEnabled: false }` and replaced Stage 05 idle-CPU expectation with Stage 06 active-CPU verification, updated classifier purity check, and added Stage 06 end-to-end tests including 72 Hz `createQuestInputSource` (11 ms idle polls), split non-vacuous 10-mode interruption + positive-control open-swing tests, guard-exhausted physical release, and 25-sample mismatched-epoch batch tests.

## Contrarian review (Gemini 4 Neon High — session `36800298-4d37-4bb9-9335-95206ef06c9c`)

- Round 1 verdict: **FAIL** (5 supported findings):
  1. `[P1]` Idle `QuestInputSource` polls (11 ms `batch === undefined` at 72 Hz) re-fed the previous live sample into `gestureClassifier.push`, breaking sustained guard and aborting swings -> fixed via `lastProcessedLiveKey` idle-poll deduplication + 72 Hz `createQuestInputSource` integration test.
  2. `[P1]` `staleNowNs`/`nullNowNs` (and `bothHandsLost`) did not neutralize head evasion, and interruption tests in `tests/quest-gesture.test.cjs` held guard / jumped `0.25 m` / used 3-sample swings vacuously -> fixed `isCombatInputGateOpen` (`isInputFreshForCombat` + `hasTrackedCombatGrip`) + split non-vacuous interruption tests with `isEvading() === true` precondition and 4-sample positive control.
  3. `[P1]` `releaseSessionGuard` emitted 2 `'block-up'` commands per sample in non-open batches, overflowing `ArenaMatch.localCommands` (`>= 32`) -> fixed via `dispatchSessionGuard` / `releaseSessionGuard` per-round deduplication + 25-sample batch test.
  4. `[P2]` `ArenaController.startAttack` overwrote `fighter.yaw` despite `stableFacing: true` -> fixed with `if (!(this.rules.stableFacing && id === 'blue'))` + regression test.
  5. `[P2]` Added guard-exhausted physical-release test, removed redundant `head`/`calibration` pass in `evaluateCombatForSample`, updated stale comments/constant, and documented intentional LF normalization on `arena-controller.ts` & `arena-match.ts`.
- Round 2 recheck (session `36800298-4d37-4bb9-9335-95206ef06c9c`): **PASS** — all 5 fixes verified resolved (`git diff --check origin/main` exit 0, `typecheck` exit 0, `lint` exit 0, `test:app` exit 0, `test:quest` 156/156 exit 0); added Neon's non-blocking 2-sample post-recovery strictness suggestion in `tests/quest-gesture.test.cjs`. Zero reviewer writes confirmed by pre/post SHA-256 hashes.

## Validation, native Quest build, and device installation

- `git diff --check`: exit 0
- `npm test`: exit 0 (`lint`, `typecheck`, `test:ar` 14/14, `test:app` 372/372, `test:quest` 156/156, `test:ui` 16/16, `test:dependencies` 3/3)
- `npm run build:android` (`expo export --platform android --max-workers 2`): exit 0 (`dist` bundle + 71 assets)
- Pinned Viro renderer (`native/quest-viro-renderer/viro_renderer-release.aar`): built cleanly via `node tools/quest/build-viro-renderer.mjs --pristine` and `node tools/quest/build-viro-renderer.mjs` (`rendererSha256` `4913d7f60a827c04c182b84c51d5aef06cf13d60fb8c70df25e8cfd49a532c4c`, `aarSha256` `c744d79564cfc929da1269eccfac1544a1f88918712c1836d1c7aa44bdfc662d`, `abis: ["arm64-v8a"]`).
- Native arm64 Quest release APK (`D:\nrq06\w\android\app\build\outputs\apk\release\app-release.apk`):
  - Built from clean staged workspace (`QUEST_BUILD=1 npx expo prebuild -p android --clean --no-install` -> `MainApplication.kt` `ViroPlatform.QUEST` -> `gradlew.bat :app:processReleaseManifest :app:assembleRelease -PreactNativeArchitectures=arm64-v8a -I ..\tools\quest\short-cmake.gradle`), `BUILD SUCCESSFUL`.
  - Size: `140226759` bytes; APK SHA-256: `3fe829c074697813073d233708d26f9b809071462d8a8de194b62e0bb3735f51`.
  - `aapt2 dump permissions`: `INTERNET`, `MODIFY_AUDIO_SETTINGS`, `VIBRATE`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, `com.djleg.neorobots.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` (no `CAMERA`).
  - `QUEST_RELEASE_APK=... npm run test:quest`: 156/156 pass.
- Device installation:
  - Target: Quest 3S (`panther`, serial `3487C10J3706TQ`, Android 14, build `4183210015200610`).
  - Installed via `adb -s 3487C10J3706TQ install -r` (never uninstalled or cleared data): `Performing Streamed Install` -> `Success`.
  - Verified on-device `base.apk` sha256sum `3fe829c074697813073d233708d26f9b809071462d8a8de194b62e0bb3735f51` (exact match), `versionCode=1`, `versionName=1.0.0`, `firstInstallTime=2026-11-18 19:01:45` preserved, `lastUpdateTime=2026-11-25 08:18:25`.
  - **Pending physical gate**: Stage 06 on-headset wearer fight verification has not been run yet; synthetic gesture thresholds remain marked `provisional-unmeasured`.

---

## Archive — Prior session (Post-05B rebase & offline prep, `d333192`)

- **Session:** `8f20f48c-c228-4d32-bdfe-34c1eee9e01b` (Neon review `76165b07-37ee-4e10-849e-b9841e37fbc1` PASS)
- **Previous owner:** Grok 4.7 (`c0efdef9-09ba-45eb-90b7-52b362200927`, pre-rebase `5665e34`).
- **Scope:** Rebased cleanly onto `origin/main` (`964d85fe4c14d8a8e1261611ae71fb85bf7743ab`, PR #6), reconciled `quest-gesture.ts` with 05B `poseSource: 'aim' | 'grip'`, `headRefEpoch`, `recentering`, and `nowNs` freshness while keeping combat integration/CPU restoration blocked prior to user confirmation of 05/05B physical gates.
