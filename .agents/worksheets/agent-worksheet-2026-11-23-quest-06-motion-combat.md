# Quest 06 offline gesture preparation

- Status: COMPLETE for offline preparation. Combat integration is BLOCKED until Stages 05 and 05B have merged and their physical Quest gates have passed.
- Task source: `project/agent/handoffs/2026-11-23-quest-06-motion-combat.md`
- Branch: `feat/quest-06-motion-combat`
- Worktree: `neo-rock-em-sock-em-robots-quest-06-motion-combat`
- Starting commit: `778e346020f36b58f71ca577b942f4717684909a` (PR #5 merge of `feat/quest-05-locomotion`). 05B has not merged. The Stage 05 physical gate is still pending.
- Owner: Grok 4.7, sole writer, session `c0efdef9-09ba-45eb-90b7-52b362200927`. No other agents. The control repository was not edited.

## Accepted requirements

Inventory the real tracked-hand sample and ArenaMatch attack, guard, uppercut, and recovery contracts. Add labeled synthetic offline fixtures and a pure disconnected classifier with provisional, unmeasured thresholds. Uppercut attempts stay uppercuts; eligibility stays in ArenaMatch. Do not wire live input, restore the Quest CPU opponent, or change contact, timing, the hand renderer, phone rules, or native builds.

## Contracts used

- Aim pose, not grip. `QuestInputSample` carries per-hand position, quaternion, velocities, `tracked|inferred|lost`, stick, trigger, squeeze, and buttons. `displayTimeNs` is XrTime. `capturedNs` is CLOCK_MONOTONIC. `decodeBatch` drops a non-increasing `seq` and a generation mismatch. Duplicate or decreasing timestamps are kept when `seq` increases. Source status goes stale after `QUEST_INPUT_STALE_NS` (100 ms). `unfocused` is separate from tracking loss. `generation` resets the session. `refEpoch` is a recenter in the same session.
- Commands are `punch|uppercut|block-down|block-up|jump-back` with no hand field. Punch side is random. Uppercut hands alternate. An uppercut is accepted only when the punch string is full and the clock is inside `uppercutWindow` (0.45 s). Guard blocks a punch only while holding and inside the guard cone. Uppercuts are not blocked. Contact is `sweptContact` on the simulation pose. Recovery timings (`punchRest` 0.6, `guardStartup` 0.1, and the clip windows) are not gesture thresholds.
- Body forward is `forward(yaw)`: yaw 0 is world +Z, yaw 180 (default calibration) is world -Z. Head duck and weave use the already clamped `gameplayHeadPose`. Quest solo still forces `QUEST_STAGE_05_IDLE_OPPONENT_RULES` (`cpuEnabled: false`) only inside `createQuestArenaSession().solo()`. Phone `cpuEnabled` stays true.
- No captured controller recordings exist in this worktree. Every fixture is synthetic and labeled `measured: false`.

## Decisions

- The classifier lives in `src/features/quest-vr/quest-gesture.ts` and is not imported by the session. Threshold basis is `provisional-unmeasured`. It does not read `uppercutReady`, `displayTimeNs`, or match state.
- Strikes use position and `capturedNs` only. A lost, inferred, stale, unfocused, or not-ready sample cancels the open excursion and does not classify across the gap. A generation or `refEpoch` change releases guard and ignores the position step. Rearm is spatial: the hand must retreat by half the strike travel. It is not `punchRest`.
- Guard needs both hands, low speed, and the authored volume for 120 ms. One hand does not start guard.
- Head intents fire only when duck or weave changes, and the reported metres are the clamped pose. They do not call `jumpBack` or dash.
- The backward-motion oracle reports both extents. A peak floored at 0 cannot prove a backward path. That case requires forward travel `<= 0` and retreat `<= -0.18` m along `forward(yaw)`.

## Files changed

- `src/features/quest-vr/quest-gesture.ts`
- `tests/fixtures/quest-gesture/synthetic-gestures.json` — 33 synthetic cases
- `tests/quest-gesture.test.cjs`
- `.agents/worksheets/agent-worksheet-2026-11-23-quest-06-motion-combat.md`

No combat, session, protocol, renderer, phone-rule, or native files were edited.

## Validation

Worktree had no `node_modules` at the start. `npm ci` exit 0 (934 packages). The first `npm run test:quest` before that install failed to load six files (`zustand`, `typescript`, `@expo/config-plugins` missing). Those failures were the missing install, and the gesture file's own tests already passed. After `npm ci`:

- `node --experimental-strip-types --test tests/quest-gesture.test.cjs` — exit 0, 9 passed, 0 failed. The first run failed one oracle: a backward path's forward peak is 0, so `maxAlong: -0.18` could not pass. The fixture now requires `maxAlong: 0` and `retreatAlong: -0.18`.
- `npm run test:quest` — exit 0, 122 passed, 0 failed.
- `npx eslint src/features/quest-vr/quest-gesture.ts` — exit 0. Repo lint does not include `*.cjs`.
- `npx prettier -c` on the classifier, the test, and the fixture — exit 0. Local Prettier matches `prettier.config.js` (print width 100).
- `npx tsc --noEmit` — exit 0.
- `npm run build:android` was not run. No headset result is claimed.

## Blocker

Do not wire gestures or remove the idle-CPU override until both of these are on `origin/main` and their physical gates have passed:

- Stage 05 locomotion: PR link, merge SHA, headset model, OS, and the device-gate evidence.
- Stage 05B first-person arms: PR link, merge SHA, headset model, OS, and the device-gate evidence.

Then rebase these prep commits onto that `origin/main` from a clean worktree. `project/todo.md` Stage 06 still names only the 05 gate; the handoff, Stage 05B insertion, and the 05B spec also require 05B. Follow the stricter rule.
