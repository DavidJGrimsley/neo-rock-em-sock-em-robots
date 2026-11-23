import { createStore } from 'zustand/vanilla';

export type QuestRuntimeStatus = 'idle' | 'launching' | 'immersive' | 'returned' | 'error';

export type QuestVRActivityState =
  'unknown' | 'resumed' | 'paused' | 'stopped' | 'finishing' | 'destroyed';

export type QuestAutoReentryAction = 'enter' | 'launch-live' | null;

export interface QuestRuntimeSnapshot {
  status: QuestRuntimeStatus;
  // Latest native VRActivity lifecycle state emitted by VRActivity.kt.
  vrActivityState: QuestVRActivityState;
  // False while the app is backgrounded/inactive.
  appActive: boolean;
  // Successful scene entries, including re-entries.
  entries: number;
  // Explicit Enter presses after the first launch.
  reentryCount: number;
  // Live scene mounts; StrictMode and an overlapping re-entry can briefly mount two.
  sceneMounts: number;
  // Last exit request source, cleared when the scene mounts again.
  exitRequest: string | null;
  lastError: string | null;
}

interface QuestClock {
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
}

const defaultClock: QuestClock = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const QUEST_LAUNCH_TIMEOUT_MS = 10_000;

const initial: QuestRuntimeSnapshot = {
  status: 'idle',
  vrActivityState: 'unknown',
  appActive: true,
  entries: 0,
  reentryCount: 0,
  sceneMounts: 0,
  exitRequest: null,
  lastError: null,
};

// The panel and VRActivity share one JS runtime, so this module-level store is
// visible to both React roots. Scene unmount is the authoritative exit signal:
// Back, onExitViro and the scene's Exit target only record a request.
export function createQuestRuntime(
  clock: QuestClock = defaultClock,
  launchTimeoutMs = QUEST_LAUNCH_TIMEOUT_MS
) {
  const store = createStore<QuestRuntimeSnapshot>(() => initial);
  let launchTimer: unknown = null;
  // Tracks whether a fallback 2D panel was actually foreground-active while returned before
  // going to background, distinguishing an intentional reopen from transient pause/resume flicker.
  let panelActiveSinceReturn = false;
  let reenterOnAppActive = false;

  const set = (patch: Partial<QuestRuntimeSnapshot>) =>
    store.setState({ ...store.getState(), ...patch });
  const clearTimer = () => {
    if (launchTimer !== null) clock.cancel(launchTimer);
    launchTimer = null;
  };
  const resetReturnHandoff = () => {
    panelActiveSinceReturn = false;
    reenterOnAppActive = false;
  };

  return {
    subscribe: (listener: () => void) => store.subscribe(listener),
    getSnapshot: () => store.getState(),
    /** Returns true when the caller should launch VRActivity. */
    requestEnter() {
      const state = store.getState();
      if (state.status === 'launching') return false;
      if (
        state.status === 'immersive' &&
        state.vrActivityState !== 'finishing' &&
        state.vrActivityState !== 'destroyed'
      ) {
        return false;
      }
      resetReturnHandoff();
      clearTimer();
      launchTimer = clock.schedule(() => {
        launchTimer = null;
        if (store.getState().status === 'launching')
          set({
            status: 'error',
            lastError: `The VR scene did not start within ${launchTimeoutMs / 1000} s.`,
          });
      }, launchTimeoutMs);
      set({
        status: 'launching',
        vrActivityState: 'unknown',
        reentryCount: state.reentryCount + (state.status === 'idle' ? 0 : 1),
        exitRequest: null,
        lastError: null,
      });
      return true;
    },
    sceneMounted() {
      const state = store.getState();
      const sceneMounts = state.sceneMounts + 1;
      resetReturnHandoff();
      if (state.status === 'immersive') return set({ sceneMounts });
      clearTimer();
      // Count direct cold launches ('idle'), explicit launches ('launching'/'error'), and
      // warm re-launches after VRActivity destroyed ('destroyed'). StrictMode remounts within
      // a single living VRActivity keep the same entry count.
      const launched =
        state.status === 'idle' ||
        state.status === 'launching' ||
        state.status === 'error' ||
        state.vrActivityState === 'destroyed';
      set({
        status: 'immersive',
        vrActivityState:
          state.vrActivityState === 'finishing' || state.vrActivityState === 'destroyed'
            ? 'unknown'
            : state.vrActivityState,
        sceneMounts,
        entries: state.entries + (launched ? 1 : 0),
        exitRequest: null,
        lastError: null,
      });
    },
    sceneUnmounted() {
      const state = store.getState();
      const sceneMounts = Math.max(0, state.sceneMounts - 1);
      if (sceneMounts === 0 && state.status === 'immersive') {
        resetReturnHandoff();
        set({ sceneMounts, status: 'returned' });
      } else {
        set({ sceneMounts });
      }
    },
    vrActivityStateChanged(nextState: QuestVRActivityState, finishing = false) {
      const state = store.getState();
      const effectiveState: QuestVRActivityState =
        finishing && nextState !== 'destroyed' ? 'finishing' : nextState;
      if (effectiveState === 'destroyed') {
        if (state.status === 'immersive') resetReturnHandoff();
        set({
          vrActivityState: 'destroyed',
          sceneMounts: 0,
          ...(state.status === 'immersive' ? { status: 'returned' as const } : {}),
        });
        return;
      }
      if (effectiveState === 'finishing') {
        if (state.status === 'immersive') resetReturnHandoff();
        set(
          state.status === 'immersive'
            ? { vrActivityState: 'finishing', status: 'returned' }
            : { vrActivityState: 'finishing' }
        );
        return;
      }
      set({ vrActivityState: effectiveState });
    },
    appStateChanged(appActive: boolean) {
      const state = store.getState();
      if (appActive) {
        if (state.status === 'returned' && state.exitRequest === null) {
          panelActiveSinceReturn = true;
        }
      } else {
        if (state.status === 'returned' && panelActiveSinceReturn && state.exitRequest === null) {
          reenterOnAppActive = true;
        }
        panelActiveSinceReturn = false;
      }
      if (state.appActive !== appActive) set({ appActive });
    },
    /**
     * Never auto-relaunches during terminal exit transitions or while an explicit exit
     * request is pending; only resumes a non-finishing paused/stopped VRActivity when needed.
     */
    consumeAutoReenter(): QuestAutoReentryAction {
      const state = store.getState();
      if (
        state.exitRequest !== null ||
        state.vrActivityState === 'finishing' ||
        state.vrActivityState === 'destroyed'
      ) {
        reenterOnAppActive = false;
        return null;
      }
      if (state.status === 'idle') {
        return 'enter';
      }
      if (state.status === 'returned' && reenterOnAppActive) {
        reenterOnAppActive = false;
        return 'enter';
      }
      if (state.status === 'immersive' && state.vrActivityState === 'stopped') {
        return 'launch-live';
      }
      return null;
    },
    /** Resolves an explicit Android LAUNCHER reopen intent when MainActivity receives it. */
    resolveLauncherReopen(): QuestAutoReentryAction {
      const state = store.getState();
      reenterOnAppActive = false;
      if (state.exitRequest !== null || state.vrActivityState === 'finishing') return null;
      if (state.status === 'launching') return null;
      if (state.status === 'error') return null;
      if (state.status === 'immersive') {
        if (state.vrActivityState === 'resumed') return null;
        if (state.vrActivityState === 'destroyed') {
          return 'enter';
        }
        return 'launch-live';
      }
      return 'enter';
    },
    exitRequested(source: string) {
      resetReturnHandoff();
      if (store.getState().exitRequest === null) set({ exitRequest: source });
    },
    fail(error: unknown) {
      clearTimer();
      resetReturnHandoff();
      set({
        status: 'error',
        lastError: error instanceof Error ? error.message : String(error),
      });
    },
  };
}

export type QuestRuntime = ReturnType<typeof createQuestRuntime>;

export const questRuntime = createQuestRuntime();

// ViroXRSceneNavigator captures onExitViro once when it mounts, so it must stay stable.
export const questOnExitViro = () => questRuntime.exitRequested('onExitViro');
