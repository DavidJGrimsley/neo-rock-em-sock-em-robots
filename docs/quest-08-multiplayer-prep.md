# Quest 08 multiplayer preparation

Preparation only, on `feat/quest-08-quest-multiplayer` at `778e346020f36b58f71ca577b942f4717684909a`. This is not a Quest-to-Quest implementation and it has not been worn on a headset.

Stage 07 must merge and pass its physical solo device gate before multiplayer integration. In `project/todo.md`, the Stage 05, 05B, 06, and 07 checkboxes are open (`project/todo.md:26-31`). Stage 05 locomotion code is on this base through PR #5. That merge is not a recorded device gate. Stages 05B and 06 are upstream of 07.

## Current behavior

Remote room status follows the connection, not a table hit. `ArenaRemoteRoom.sync` sets `joining` while the match is disconnected, `error` when the network has failed or the stage is `abandoned`, and `placing` only when connected and `preview` is null (`src/features/arena-fighter/arena-remote-room.ts:84-101`). The connected, no-preview copy is "Tap a blue surface on your own table to place the arena."

`ArenaController.isReady` is attached, landscape, no error, three assets, and either `virtualReady` or stable tracking plus placement (`src/features/arena-fighter/arena-controller.ts:1098-1106`). `setVirtualReady` can satisfy that without placement. `ArenaMatch.canTransform` still requires `round.placed` (`src/features/arena-fighter/arena-match.ts:372-381`), so a virtual-ready remote client cannot transform. While the peer is not capable, lobby copy is still "Waiting for your opponent to place their arena." (`src/features/arena-fighter/arena-match.ts:1130-1134`).

Host and guest seats, invitation codes, and authority already exist. The remote room id is `arena-remote-v1:` plus a 12-character code (`src/features/arena-fighter/arena-invite.ts:8-31`). `ARENA_PROTOCOL` is 12 (`src/features/arena-fighter/arena-protocol-version.ts:2`). A remote guest joins only from a live lobby after the host serial advances past the first packet it saw (`src/features/arena-fighter/arena-network.ts:127-153`). A remote packet that contains `placement` or `arenaTransform` is invalid (`src/features/arena-fighter/arena-protocol.ts:222`). A protocol mismatch tells the player to update both phones (`src/features/arena-fighter/arena-network.ts:136` and `:201-208`).

`PeerInput` carries boolean `advance`, `strafeLeft`, and `strafeRight` (`src/features/arena-fighter/arena-protocol.ts:57-60`). During a host tick, analog movement is applied to blue and those booleans are applied to red. The red read checks `peer.epoch` and does not check the peer round id (`src/features/arena-fighter/arena-match.ts:709-720`). `inputStateKey` omits analog (`src/features/arena-fighter/arena-match.ts:173-174`). `dash` returns false unless the mode is solo (`src/features/arena-fighter/arena-match.ts:543-554`). Combat commands are dropped when epoch, match id, or round id disagree (`src/features/arena-fighter/arena-match.ts:695-703`).

`stableFacing` skips auto-yaw only for blue inside `move` (`src/features/arena-fighter/arena-controller.ts:1400-1402`). `startAttack` always sets yaw to `facing` (`src/features/arena-fighter/arena-controller.ts:1225`). `jumpBack` sets yaw from the hop direction when the hop starts (`src/features/arena-fighter/arena-controller.ts:645`). Guest prediction replays boolean `arenaMovement` for red and then sets red yaw to `facing` (`src/features/arena-fighter/arena-prediction.ts:66-108`).

Silent peer loss pauses and abandons only from the active stages `countdown`, `fighting`, `presenting`, and `intermission` (`src/features/arena-fighter/arena-match.ts:623-665`). In `lobby` it clears `localReady` and does not pause. The guest `ArenaNetwork.pump` fails after more than 30 seconds claimed, synced, and still in lobby, with "The host isn’t connected. Ask them to tap Retry connection, then retry joining." (`src/features/arena-fighter/arena-network.ts:224-232`). The host seat has no matching lobby timer. `ArenaRemoteRoom` owns the 50 ms pump (`src/features/arena-fighter/arena-remote-room.ts:78-81`).

`QuestArenaSession` constructs only `ArenaMatch('solo')` and its frame loop runs in countdown, fighting, presenting, and intermission (`src/features/quest-vr/quest-arena-session.ts:133-140` and `:592`). `publishQuestRigState` anchors on `live.blue` (`src/features/quest-vr/quest-arena-scene.native.tsx:304`). The blue fighter is `visible={false}` and the red fighter is shown (`src/features/quest-vr/quest-arena-scene.native.tsx:722-734`). Quest panel drawing operations must have length 1 through 160 (`modules/quest-panel/native/src/main/java/expo/modules/questpanel/QuestPanelModule.kt:194`). `android.permission.CAMERA` is in `QUEST_BLOCKED_PERMISSIONS` (`app.config.ts:5`). `arenaConfiguration()` is null unless both `RV_API_KEY` and `RV_PROJECT_ID` are present (`src/features/arena-fighter/arena-configuration.ts:8-21`).

Phone tests already cover packet and invite version rejection, duplicate and stale commands, room full, and the active-stage one-second pause and 30-second abandon (`tests/arena-remote.test.cjs`, `tests/arena-match.test.cjs`). Those tests ready remote pairs with `setTracking` and `setPlacement`. `setVirtualReady` previously appeared in solo tests only.

## Compatibility

Phone remote pairs remain on tracking plus placement. Virtual ready is an existing second readiness path. It still leaves `canTransform` false, and the lobby place-arena sentence stays until the peer is capable. The 30-second lobby failure is guest-only and does not abandon the match. Protocol stays at the current version. The stick transport format, boolean `PeerInput` versus analog versus world velocity, is undecided until the merged Stage 07 movement interfaces are re-read. Quest cannot use the camera to scan a code. A relay client is unavailable when either ReactVision variable is missing. The solo rig is anchored to blue, and the blue mesh is hidden, so a guest seat would need a later local-fighter anchor. Head yaw, calibration, and the Stage 07 movement-mode choice stay off the wire until that re-read. Phone remote matches keep `stableFacing: false`.

## Prioritized matrix

| Priority | Case | Where it lives now | Device |
| --- | --- | --- | --- |
| P0 | Remote host and guest ready from `setVirtualReady` with placement and tracking false; lobby disconnect clears ready and does not pause | `tests/quest-08-remote-prep.test.cjs` | Not a headset test |
| P0 | Guest lobby timeout after 30 seconds; host seat has no matching timer | same file | Not a headset test |
| P0 | Claimed host rejects guest input protocol 11 and stays in lobby | same file | Not a headset test |
| P0 | Remote room status moves joining, then placing without `place()`, then error on abandon | same file | Not a headset test |
| P1 | This audit | this document | None |
| P2 | Re-read Stage 06 yaw sites, Stage 07 movement and solo loop, blue rig anchor, and hidden blue mesh after those gates | post-gate sequence below | Physical Quest still required for the stage gate |
| Covered | Protocol mismatch on a host packet, inactive invite, same-table packet, room full, duplicate and stale commands, active-stage 1-second pause and 30-second abandon | `tests/arena-remote.test.cjs`, `tests/arena-match.test.cjs` | Do not duplicate |

No device gate and no production networking or scene edits belong in this preparation.

## Post-gate sequence

After Stage 07 is merged and its physical solo gate has passed, record the PR and merge SHA. Fetch `origin` in the source checkout and confirm that commit is on `origin/main`. With a clean worktree, rebase this branch onto that `origin/main`. If Git stops on a conflict, record the paths and stop until ownership is clear.

Then re-read the merged scene, input sample, `setAnalogMovement`, room interfaces, and these three yaw sites against Stage 06: `startAttack`, `jumpBack`, and `move`. Re-read whether duck or weave changes combat state or stays local. Only then choose the stick wire format and add Quest host/join UI inside the 1-through-160 operation limit. Recheck the blue rig anchor and hidden blue mesh before a second seat. Keep host authority. Use gameplay intents so the local view mode does not have to cross the network.

The Stage 08 gate remains two physical Quests that join, fight, agree on outcomes, and rematch. `npm test` and `npm run build:android` do not pass that gate. An Android JavaScript export is not a native Quest build. Do not run a relay check that would print credentials.

## Non-goals

This preparation does not add adapter files, a keypad module, or an `ARENA_PROTOCOL` bump. It does not choose world velocity or analog as the wire format. It does not edit production networking, the Quest scene, or the Quest session. It does not change `stableFacing`, attack yaw, hop yaw, or prediction yaw. It does not design a code-entry UI. It does not claim headset verification.
