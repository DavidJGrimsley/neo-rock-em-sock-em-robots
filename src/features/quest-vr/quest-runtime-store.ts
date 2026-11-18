import { createStore } from 'zustand/vanilla';

export type QuestRuntimeStatus = 'idle' | 'launching' | 'immersive' | 'returned' | 'error';

export interface QuestRuntimeSnapshot {
  status: QuestRuntimeStatus;
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
  const set = (patch: Partial<QuestRuntimeSnapshot>) =>
    store.setState({ ...store.getState(), ...patch });
  const clearTimer = () => {
    if (launchTimer !== null) clock.cancel(launchTimer);
    launchTimer = null;
  };

  return {
    subscribe: (listener: () => void) => store.subscribe(listener),
    getSnapshot: () => store.getState(),
    /** Returns true when the caller should launch VRActivity. */
    requestEnter() {
      const state = store.getState();
      if (state.status === 'launching' || state.status === 'immersive') return false;
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
        reentryCount: state.reentryCount + (state.status === 'idle' ? 0 : 1),
        lastError: null,
      });
      return true;
    },
    sceneMounted() {
      const state = store.getState();
      const sceneMounts = state.sceneMounts + 1;
      if (state.status === 'immersive') return set({ sceneMounts });
      clearTimer();
      // A late mount after the launch timeout still counts as that entry. A remount
      // without a launch (StrictMode's probe, a restored VRActivity) does not.
      const launched = state.status === 'launching' || state.status === 'error';
      set({
        status: 'immersive',
        sceneMounts,
        entries: state.entries + (launched ? 1 : 0),
        exitRequest: null,
        lastError: null,
      });
    },
    sceneUnmounted() {
      const state = store.getState();
      const sceneMounts = Math.max(0, state.sceneMounts - 1);
      set(
        sceneMounts === 0 && state.status === 'immersive'
          ? { sceneMounts, status: 'returned' }
          : { sceneMounts }
      );
    },
    exitRequested(source: string) {
      if (store.getState().exitRequest === null) set({ exitRequest: source });
    },
    fail(error: unknown) {
      clearTimer();
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
