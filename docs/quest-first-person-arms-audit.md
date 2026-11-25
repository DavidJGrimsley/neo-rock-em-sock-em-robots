# Quest 05B first-person arms â€” source audit

Status: the measured audit stands, and the Quest scene now mounts a headless body plus scene-root hands. The original Combat bytes are unchanged. This document does not record a physical appearance pass or user approval. The user's report that locomotion works and that both controllers track and recover is the pre-integration confirmation. Individual Stage 04 C0â€“C7 rows and Stage 05 checklist rows are not marked tested here.

## What was measured

Both Combat GLBs were parsed from their glTF JSON chunk and BIN chunk. Triangle counts come from index accessor counts divided by 3. Bounds are POSITION accessor `min` and `max`. Texture sizes come from PNG IHDR bytes in the BIN chunk. Joint positions are the rest-pose node world translations. Animation durations are each clip's input accessor maximum. No planning-note triangle, texture, or bound figure was copied in.

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `assets/arena/Mike_Player1_Blue_Combat_AR.glb` | 19978136 | `ac3afd1fa615a2ea5b34de72f22a5780a158369e7b425d619dfcc5cd3b69833f` |
| `assets/arena/Mike_Player2_RedOrange_Combat_AR.glb` | 19087388 | `a8436e15934cfc82c0f1bbc8c10b63d07289b9787656d5ffcfcf49a362bd7ba5` |

Both containers are GLB version 2, glTF asset version `2.0`, generator `Unreal Engine 5.8.3`. Declared length equals the file size. Extensions used: `KHR_materials_emissive_strength`, `KHR_texture_transform`, `KHR_materials_unlit`. None are required. Each file has one scene, 90 nodes, 3 meshes, 3 primitives, 1 skin, 3 materials, 10 textures, 10 images, 33 animations, 8398 accessors, 8408 buffer views, 1 buffer, 1 sampler, and no cameras.

## Meshes, skin, and materials

The mesh list, skin, joint names, animation names, and POSITION bounds match between the two files. The scene roots are an unnamed node 0 plus the three mesh nodes. Node 0 has no mesh and one child, `SK_ZMike`, at the origin. All three mesh nodes use skin 0 and an identity translation, rotation, and scale.

| Mesh | Node | Material | Triangles | Positions | Indices |
| --- | --- | --- | --- | --- | --- |
| `SKM_MegaMikeZ_part_0` | 87 | `MI_ZMike_default` | 27109 | 20908, accessor 261 | 81327, unsigned short |
| `SKM_MegaMikeZ_part_1` | 88 | `MI_ZMike_Lens_Blue_SKM_MegaMikeZ` | 104 | 86, accessor 268 | 312, unsigned byte |
| `Mike_Body_LED_Native_Fallback` | 89 | `Mike_Body_LED_Native_Fallback` | 1717 | 20908, accessor 261 | 5151, unsigned short |

Total triangles: 28930. Every primitive is mode 4, has `JOINTS_0` and `WEIGHTS_0`, and has no morph targets. `part_0` and the LED mesh share POSITION accessor 261, so their bind bounds match. The LED mesh is a shorter index list over those positions.

Skin `SKM_MegaMikeZ` has 86 joints and 86 inverse bind matrices. Its skeleton is the unnamed node 0. Joint names, in skin order:

`SK_ZMike`, `root`, `pelvis`, `spine_01`, `spine_02`, `spine_03`, `neck_01`, `head_01`, `Jaw1`, `antenna_01`, `antenna_02`, `antenna_03`, `antenna_04`, `eye_Parent`, `eye_corner01_r`, `eye_corner02_r`, `eye_corner01_l`, `eye_corner02_l`, `eye_under_r`, `eye_bot02_r`, `eye_bot01_r`, `eye_bot03_r`, `eye_under_l`, `eye_bot02_l`, `eye_bot01_l`, `eye_bot03_l`, `eye_r`, `eye_l`, `eyelid_top_r`, `eyelid_top_l`, `eyelid_bot_r`, `eyelid_bot_l`, `Brow_r`, `eye_top02_r`, `eye_top01_r`, `eye_top03_r`, `Brow_l`, `eye_top02_l`, `eye_top01_l`, `eye_top03_l`, `clavicle_l`, `upperarm_l`, `lowerarm_l`, `hand_l`, `index_01_l`, `index_02_l`, `index_03_l`, `pinky_01_l`, `pinky_02_l`, `pinky_03_l`, `thumb_01_l`, `thumb_02_l`, `thumb_03_l`, `Prop_L`, `Buster_L`, `clavicle_r`, `upperarm_r`, `lowerarm_r`, `hand_r`, `index_01_r`, `index_02_r`, `index_03_r`, `pinky_01_r`, `pinky_02_r`, `pinky_03_r`, `thumb_01_r`, `thumb_02_r`, `thumb_03_r`, `Prop_R`, `Buster_R`, `PropBack`, `thigh_l`, `calf_l`, `foot_l`, `ball_l`, `thigh_r`, `calf_r`, `foot_r`, `ball_r`, `eye_lookatroot`, `eye_lookat_r`, `eye_lookat_l`, `knee_ik_l`, `knee_ik_r`, `foot_Ik_L`, `foot_Ik_R`.

Materials, same names on both files, including the lens name `MI_ZMike_Lens_Blue_SKM_MegaMikeZ` on the red file:

- `MI_ZMike_default` (mesh 0): alpha mode `MASK`, not double sided. Base-color texture 0, metallic-roughness texture 1, normal texture 3, emissive texture 2, emissive factor `[1, 1, 1]`, `KHR_materials_emissive_strength` `16.5625`.
- `MI_ZMike_Lens_Blue_SKM_MegaMikeZ` (mesh 1): opaque, unlit, metallic factor 0, roughness factor 1. Its base-color texture is index 9, `Mike_Eyes_LED_Visible`, with `KHR_texture_transform` scale `[1.01191938, 1.00001991]`. That is the only texture transform in the file.
- `Mike_Body_LED_Native_Fallback` (mesh 2): opaque, unlit, metallic factor 0, roughness factor 1, base-color texture 8, `Mike_Body_LED_Visible`.

Textures 4â€“7 (`MI_ZMike_Lens_Blue_SKM_MegaMikeZ_BaseColor`, `_MetallicRoughness`, `_Emissive`, `_Normal`) are present. None of the three materials reference texture indices 4, 5, 6, or 7.

Every image is an embedded PNG, 1024Ã—1024, with no URI. Six images are byte-identical across the two files. Four differ:

| Image | Blue bytes | Blue SHA-256 | Red bytes | Red SHA-256 |
| --- | --- | --- | --- | --- |
| `MI_ZMike_default_BaseColor` | 1441569 | `1369703ec62031019584da087be3060e67e558d121e5e9040bf306e5b1589baa` | 1248818 | `9762f8ad6c1af5bf15589501195b1f5d8ef8616dc8c951a4c0373c5a2cc128f5` |
| `MI_ZMike_default_Emissive` | 134373 | `3774fe799713490bdd1ad80b082cf87894d2dec1499a363da66cd83c016b2ec5` | 86017 | `2166db50784de804b4340788bdaae7dc5592e7f8dfaad4002ac58ac0d5eb71ef` |
| `Mike_Body_LED_Visible` | 1284069 | `89a1f0cff375b7e75f8d6810c01efe6a6b6f3ca06cb86425a99b40b171412cef` | 1223868 | `cff53853c91271906dfa292e20d03fe24759fee742f19b729bdfc8e3139cffb6` |
| `Mike_Eyes_LED_Visible` | 1841631 | `63965a2f91f1ea8d32dff6ac26ccdd5316341c08061fe6c7bb7719d2c1a68a50` | 1252194 | `0ce31ab5abc61fa98cbdfa7d54923879c6725e14106a06b3a5e1c04232270141` |

Identical image SHA-256 values: metallic-roughness `3fc170738b069e9a5d321f51ec726c5d078060649326e32ee76a12ed28cc1adc`, normal `4b77fe6e58345c9523886576bbd317a26b58e535fb28cd597751b28b479e8cc2`, lens base color `ab0a3e505abd2326fde79922857dc0f8b6bce98fcda84741eb9c2d45bd425bba`, lens metallic-roughness `c060479dc848fa593ab6912081e86cdb18db00996be4d4dc55d7cae823c2290a`, lens emissive `5569d47f2c07527e77c71980b0d02451e359b52e420f0e3a6e321c4a7b28908f`, lens normal `0ab5bf38dab562a34092aae69608ef95270f3ebe1761a86eb95e4ef7dc2d4e31`.

## Rest pose, facing, and hands

POSITION accessor 261 on both files:

- min `[-0.793041468, -0.00106792559, -0.111432686]`
- max `[0.793041468, 1.59750378, 0.322120786]`
- height `1.59750378 - (-0.00106792559) = 1.59857170559`
- X span `1.586082936`
- Z span `0.433553472`

`part_1` bounds sit in the eye band: min `[-0.17361125349998474, 1.0643582344055176, 0.19729334115982056]`, max `[0.17361125349998474, 1.19973886013031, 0.29177185893058777]`.

No node stores a scale other than the default 1. Sixty-seven nodes store a rotation and eighty-five store a translation.

Rest-pose world positions on the blue file, reproduced by the red file's matching node translations:

| Joint | World translation |
| --- | --- |
| `eye_l` | `[0.10885942616221156, 1.1271493570536868, 0.20278203696096847]` |
| `eye_r` | `[-0.10885932383785603, 1.1271493569618452, 0.20278207386911437]` |
| eye midpoint | `[0.000000051162177765, 1.127149357007766, 0.2027820554150414]` |
| `head_01` | `[0, 0.9735881988293971, -0.004333995610287725]` |
| `lowerarm_l` | `[0.34636491368336936, 0.8379443896073401, -0.024230744901090093]` |
| `hand_l` | `[0.5344481988700284, 0.8336143365870976, -0.02450617645636889]` |
| `lowerarm_r` | `[-0.3463649693805617, 0.8379442791634726, -0.02423077384761533]` |
| `hand_r` | `[-0.5344482803159629, 0.8336143634224586, -0.024506226876925906]` |
| `foot_l` | `[0.06406994935494514, 0.10422699473058811, -0.005894730843949411]` |
| `ball_l` | `[0.06326746276271422, 0.03512663293178385, 0.09434467497018621]` |

`hand_l - lowerarm_l` is `[0.188083285186659, -0.004330053020242475, -0.00027543155527879823]`. The left forearm length in the rest pose runs along world +X. `ball_l - foot_l` is about `[-0.000802, -0.069100, 0.100239]`, so the toe points +Z. The eyes are in front of `head_01` toward +Z, and `eye_lookat_l` / `eye_lookat_r` sit further along +Z at about `0.449`. Those two cues agree: the rest pose faces +Z, the character's left joints are +X, and the right joints are âˆ’X.

`ROBOT_EYE_MODEL` in `quest-head-rig.ts` is `[0, 1.1271, 0.2028]`. That is this measured eye midpoint rounded to four decimal places. This pass does not change the constant.

## Scale

`ARENA_LAYOUT.fighterScale` is `0.12 / 1.59857170559`. The denominator is the measured POSITION height above. One times `fighterScale` makes that height `0.12` simulation units. `QUEST_WORLD_SCALE` is `16`, so the same height is `1.92` m in OpenXR.

The blue and red fighters are `Viro3DObject` children of `quest-rig-outer`. The rig scale is 16 and each object scale is `fighterScale`, so a body in that hierarchy is scaled once by the product. The original blue object stays loaded, keeps `onLoadEnd`, and stays `visible={false}`. `quest-blue-node` itself is explicitly `visible={true}` so the headless derivative on that same node can render. Patch `0004` already moves that tag.

A scene-root hand is not under the rig. Its aim position is already OpenXR LOCAL metres, so the position is copied and the mesh scale is the product once: `QUEST_FIRST_PERSON_ARM_SCALE = fighterScale * 16`. Multiplying the aim position by that scale, or parenting the hand under the rig and applying the product again, would scale it twice.

Animation channels are a separate scale. Each of the 33 clips has 258 channels: translation, rotation, and scale on all 86 joints. Rest nodes are scale 1, but some scale keys are not. On `IdleAggro`, the only joints with a component more than `1e-4` from 1 are `eye_corner02_l`, `eye_corner02_r`, `eye_top03_l`, `eye_top03_r` (about `0.875` to `1`) and `eyelid_bot_l` / `eyelid_bot_r` (about `0.520451`). On `Combo_PunchL`, `lowerarm_l` reaches about `1.138225` and `hand_l` reaches about `1.343834`. `Combo_PunchR` does the same on `lowerarm_r` and `hand_r`. `Buster_R` stays about `0.134738` on those clips. The unmounted module does not sample those curves and does not play a punch clip.

`scripts/arena-contact-preview.py` and `scripts/arena-defense-preview.py` only import a GLB (`bpy.ops.import_scene.gltf`) and write PNG and JSON renders. They do not export a GLB. This pass did not run Blender. `scripts/quest-first-person-extract.cjs` reads both Combat files and writes the Quest-only derivatives below. It does not modify the originals.

## Animations

Both files have the same 33 clips. Duration is the input accessor maximum, in seconds:

| Clip | Seconds | Clip | Seconds |
| --- | --- | --- | --- |
| `Idle` | 1.5 | `Combo_PunchR` | 0.6499999761581421 |
| `IdleAggro` | 1.5 | `Combo_UppercutL` | 0.8999999761581421 |
| `WalkForward` | 1.4666666984558105 | `Combo_PunchL` | 0.6499999761581421 |
| `WalkBackward` | 1.2999999523162842 | `Combo_UppercutR` | 0.8999999761581421 |
| `StrafeLeft` | 1.4666666984558105 | `BlockEnter` | 0.100000001 |
| `StrafeRight` | 1.4666666984558105 | `BlockHold` | 1 |
| `Run` | 0.8999999761581421 | `BlockExit` | 0.100000001 |
| `RunFast` | 0.7666666507720947 | `BlockHit` | 0.13333334 |
| `PunchR` | 1.5 | `BlockAdvance` | 1.4666667 |
| `PunchL` | 1.5 | `BlockStrafeLeft` | 1.4666667 |
| `UppercutL` | 1.5 | `BlockStrafeRight` | 1.4666667 |
| `UppercutR` | 1.5 | `JumpBack` | 0.400000006 |
| `HitFront` | 0.5666666030883789 | `VictoryUppercut` | 2 |
| `HitBack` | 0.5666666030883789 | `HitFrontFast` | 0.20000000298023224 |
| `HitLeft` | 0.5666666030883789 | | |
| `HitRight` | 0.5666666030883789 | | |
| `Defeat` | 0.8999999761581421 | | |
| `DefeatedLoop` | 0.8999999761581421 | | |
| `Victory` | 2.299999952316284 | | |

The live scene still plays `IdleAggro` on the existing fighter objects. This pass does not change that.

## Unmounted placement

`placeQuestFirstPersonArms` returns a left placement, a right placement, and `combatCommand: null`.

- Handedness: `sample.left` can drive only the left placement, and `sample.right` only the right. A sample whose `hand` label disagrees with that slot is hidden. Aim X is copied. The rest pose's left-at-+X is not a reason to mirror a controller.
- One scale: both placements carry `QUEST_FIRST_PERSON_ARM_SCALE`. The aim position stays in metres.
- Finite aim poses: a missing, non-finite, or non-unit orientation (tolerance `0.05`, the same band `decodeHand` uses) hides that hand with `invalid-aim-pose`. The rotation that remains uses `viroEulerDegrees`, the marker conversion. The aim pose is not the grip pose.
- `refEpoch`: when the sample epoch and the head epoch are both numbers and differ, both hands hide and their positions are dropped. A missing head epoch does not hide, matching `questLocomotionFromInput`.
- Tracking loss: `tracking === 'lost'` hides that hand only. `inferred` with a finite aim pose stays visible.
- No combat command: the frame has no punch, block, or damage field. The module does not import the scene.

## Current controller-attached preview (2026-11-24)

The wearer reported a wrist gap, sideways left thumb, and hands lagging behind controller motion in the 11:25 video. Patch `0005-openxr-controller-attached-hands.patch`, applied after unchanged patches 0001–0004, replaces per-pose JS/Fabric updates on the pinned Quest renderer.

The stock pinned integration had aim-pose actions and squeeze-float actions, but no grip-pose actions. The new left/right grip-pose actions bind `/user/hand/{left,right}/input/grip/pose` inside the existing action set, before its single attachment. Aim rays, squeeze values, buttons, menus, session and native head tracking retain their existing paths. Optional visual-binding failure retries original menu bindings. Grip action spaces are destroyed with the existing session.

Each render frame locates both real grip poses in the same OpenXR LOCAL space at `XrFrameState.predictedDisplayTime`. After native rig sync, before `prepareFrame`, native code sets the six tagged arm/fist nodes directly; both eyes read those transforms. Lifecycle enable/disable crosses JNI, but the primary path has no per-pose JS subscription, rAF, UIManager dispatch, or renderer task queue. Invalid, unfocused, wrong-frame or >50 ms stale poses at application hide that hand; body and native aim markers remain available. Native cache storage is local to each render thread; session recreation preserves the mounted lifecycle enable intent. Shoulder composition includes child mesh fighterScale once because the tagged blue parent has scale 1. Reach limits only hide cosmetic arm segments, never a valid tracked fist. Elbows remain cosmetic estimates, not tracked joints.

The original static mesh axes are +X left thumb / -X right thumb, +Y dorsal, -Z knuckles. Proper per-hand mesh-to-grip quaternions are left `[-.5,.5,.5,.5]`, right `[-.5,-.5,-.5,.5]`; these map each thumb to grip -Z and knuckles to grip -Y. For a thumb-up punching hold both thumbs point up, left slightly right and right slightly left. The mesh palm center is measured halfway from the source wrist to the midpoint of index_01/pinky_01. Each transformed palm lands on the controller grip position; wrist offset rotates with the controller. No reflection, world-fixed roll, smoothing, or aim-to-grip guess is applied.

Stage-06 samples retain version-1 aim fields, sequence, prediction time, monotonic capture time, and reference epoch. Optional `gripVersion=1`, `gripInts` and `gripFloats` add true grip pose flags, velocities and transforms from the same sample. A second sequence-keyed JNI copy never substitutes a newer grip pose for an older aim sample; overwritten entries become inactive/lost. JS fallback requires a valid real grip and rechecks freshness and reference epoch even for an unchanged sequence; it does not fake a grip from aim.

Wrist holes came from concave boundary loops rejected by center-fan caps. Ear clipping now seals genuine boundaries jointly across materials, retaining source material seams rather than adding duplicate coplanar caps. Both hand and forearm meshes have zero position-welded open boundary edges and zero duplicate faces across materials. A closed sphere of radius 0.055 model units at the wrist pivot overlaps both rotating wrist-rooted meshes and uses source forearm material/UV. The static fist blend remains 0.75 IdleAggro/BlockHold. Original Combat GLB hashes/materials and phone imports are unchanged. Body shift, stance, pan-only intro, cover/title lifecycle, POV, locomotion, opponent and combat are preserved.

| File | Bytes | Triangles | SHA-256 |
| --- | ---: | ---: | --- |
| quest-blue-body.glb | 805628 | 13714 | `5ecec8228932f1e1116aeddb9165c43bc7777d89bed41303d1144df58ecf1bd7` |
| quest-blue-forearm-left.glb | 168444 | 1874 | `2c731dc9a6f755a26b9409dbe730f36f76ef3f718e533977ec08477707aaac46` |
| quest-blue-forearm-right.glb | 168448 | 1874 | `843ff7bfd4823ebe869c27a47dceea08dd45bc7146a0c19dc3acd3b6743223e5` |
| quest-blue-hand-left.glb | 514656 | 3620 | `ee05db61829f3b5843b3209bdc2f4de6a599f179248a92366870cd70e6bb43c0` |
| quest-blue-hand-right.glb | 514696 | 3620 | `021b0a77e8f46434dd916c44089bad87467d3892615880d1590b9f14644883f1` |
| quest-blue-upper-left.glb | 110260 | 800 | `8de7c87d173ed5690f58d4ea4970efd3260b1fdec642fa0d03edb7ff597a074f` |
| quest-blue-upper-right.glb | 110256 | 800 | `1940859b77c238c018f90f60cc2b82f56c1748915204abf894f597c83784c343` |

## Timing and validation

`QuestHands` native telemetry records monotonic capture-to-apply, apply-to-first-eye, capture-to-first-eye, capture-to-CPU-eye-submission-end and render-interval distributions, plus per-hand grip active/valid flags and stale hides. CPU submission end is not GPU completion or motion-to-photon. XrTime is logged separately; it is never subtracted from CLOCK_MONOTONIC. The legacy pipeline includes 11 ms polling, JS rAF coalescing and view/renderer queues; no timing improvement is claimed without active wearer measurements.

Host tests compile and execute the actual shared C++ math, validate both hands under controller rotations, anatomical thumb axes, palm/wrist offsets, elbow endpoints, freshness, tracking/epoch loss, reach fallback, sealed geometry, additive timestamped grip decoding, single action-set integration and absence of combat commands. All process runs are bounded and fixtures register cleanup before assertions. Exact final tests, pin/build/install hashes, review results and missing wearer evidence belong in `../project/agent/reports/2026-11-24-quest-05b-native-grip-hands.md`. Previous reports remain historical evidence. Nothing is committed, pushed or merged.

## Pending wearer tests

- Pre-Ready stance centering while looking side to side; centered POV after Ready and a visible, comfortable pan without skull clipping or stuck black cover.
- Fist shape, wrist/forearm solidity during bend and twist, looking down at body/feet, full punches and legal lean, seated and standing.
- Actual controller-to-fist latency against the native marker, sustained frame pacing in the ring, tracking loss/recovery, OS recenter, pause/resume, stick movement, and dash with head still.
- Stage 04 C0-C7 and Stage 05 locomotion checklists remain physical wearer gates. No visual, comfort, performance, or merge approval is inferred from host tests or unattended capture.
