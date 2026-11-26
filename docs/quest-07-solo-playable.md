# Quest 07 — solo completion

Stage 06 is merged in PR #7. The physical Quest gate for that stage and the retrospective project-memory gate are not independently verified.

This branch retains the existing ArenaMatch countdown, round, pause, KO and rematch logic, adds a result card anchored in the current view at match end, and exposes a saved Quest movement preference. View-relative remains the default. Opponent-relative maps movement and dash into the current opponent bearing in the existing stable-facing linear solver; it does not auto-turn the headset or modify Phone AR rules. Ring and separation limits remain in the existing solver. The stick and dash must be released/rearmed when changing movement modes. Native Android SharedPreferences stores the mode; a native rebuild is required. The final result countdown and announcer watchdog continue ticking until the existing match model unlocks Rematch; the render loop then stops.

## Verification
- Run MDS Doctor and resolve the control-plane onboarding markers.
- Run npm test, npm run build:android, and git diff --check against main.
- Build/install the pinned arm64 renderer APK per docs/quest-01-dev-build.md. No physical-device or local build results are claimed.
- Complete a best-of-three solo match, including loading/Ready, countdown, pause/resume, background/re-entry, KO, visible result, rematch, and return to menu.
- In both modes test forward/back/left/right and diagonals with the head at 0/90/180 degrees, ring wall and opponent separation, dash direction, tracking loss and holding the stick when changing modes. Reopen the app and verify persistence.
- Record device model/OS, APK/source SHA, logs, comfort observations and failures before approving Stage 07 or starting Stage 08 integration.
