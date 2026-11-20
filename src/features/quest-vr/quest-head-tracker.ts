import {
  DEFAULT_CALIBRATION,
  calibrateFromSamples,
  gameplayHeadPose,
  headSampleFromViro,
  yawFromForward,
  type Calibration,
  type GameplayHeadPose,
  type HeadSample,
  type Posture,
  type RigAnchor,
} from './quest-head-rig.ts';
import { questRuntime } from './quest-runtime-store.ts';

const SAMPLE_BUFFER_CAPACITY = 64;
const PUBLISH_INTERVAL_MS = 200;
const RECENTER_WINDOW_MS = 500;
const RECENTER_TIMEOUT_MS = 2000;
const RECENTER_MAX_SAMPLES = 128;

export const QUEST_RECENTER_FAILURE_MESSAGE = 'Hold still and select Recenter again';
const NO_SAMPLES_MESSAGE = 'Head pose unavailable.';

export interface QuestHeadTrackerSnapshot {
  calibration: Calibration;
  anchor: RigAnchor | null;
  status: 'uncalibrated' | 'sampling' | 'ready' | 'failed' | 'no-samples';
  message: string | null;
  sampleHz: number | null;
  pose: GameplayHeadPose | null;
  outOfBounds: boolean;
  samplesSeen: number;
}

export function createQuestHeadTracker(deps: {
  now: () => number;
  schedule: (cb: () => void, ms: number) => unknown;
  cancel: (h: unknown) => void;
  entries: () => number;
}) {
  const listeners = new Set<() => void>();
  const ring: (HeadSample | null)[] = new Array(SAMPLE_BUFFER_CAPACITY).fill(null);
  let ringHead = 0;
  let ringCount = 0;
  let samplesSeen = 0;
  let latestSample: HeadSample | null = null;
  let sampleHz: number | null = null;

  let calibration: Calibration = {
    ...DEFAULT_CALIBRATION,
    origin: [...DEFAULT_CALIBRATION.origin],
  };
  let anchor: RigAnchor | null = null;
  let calibratedEntry: number | null = null;
  let status: QuestHeadTrackerSnapshot['status'] = 'uncalibrated';
  let message: string | null = null;

  let publishTimer: unknown = null;
  let lastPublishAt: number | null = null;

  let recenterActive = false;
  let recenterTimer: unknown = null;
  let recenterSamples: HeadSample[] = [];
  let preRecenterStatus: QuestHeadTrackerSnapshot['status'] = status;
  let preRecenterMessage: string | null = message;

  let snapshot: QuestHeadTrackerSnapshot = buildSnapshot();

  function buildSnapshot(): QuestHeadTrackerSnapshot {
    const pose = latestSample ? gameplayHeadPose(calibration, latestSample) : null;
    return {
      calibration,
      anchor,
      status,
      message,
      sampleHz,
      pose,
      outOfBounds: pose ? pose.outOfBounds : false,
      samplesSeen,
    };
  }

  function clearPublishTimer() {
    if (publishTimer !== null) {
      deps.cancel(publishTimer);
      publishTimer = null;
    }
  }

  function clearRecenterTimer() {
    if (recenterTimer !== null) {
      deps.cancel(recenterTimer);
      recenterTimer = null;
    }
  }

  function publishNow() {
    clearPublishTimer();
    lastPublishAt = deps.now();
    snapshot = buildSnapshot();
    listeners.forEach((listener) => listener());
  }

  function schedulePublish(nowMs: number) {
    if (publishTimer !== null) return;
    const delay =
      lastPublishAt === null
        ? PUBLISH_INTERVAL_MS
        : Math.max(1, PUBLISH_INTERVAL_MS - (nowMs - lastPublishAt));
    publishTimer = deps.schedule(() => {
      publishTimer = null;
      publishNow();
    }, delay);
  }

  function orderedSamples(): HeadSample[] {
    if (ringCount === 0) return [];
    const start = (ringHead - ringCount + SAMPLE_BUFFER_CAPACITY) % SAMPLE_BUFFER_CAPACITY;
    const result: HeadSample[] = [];
    for (let i = 0; i < ringCount; i += 1) {
      const item = ring[(start + i) % SAMPLE_BUFFER_CAPACITY];
      if (item) result.push(item);
    }
    return result;
  }

  function applyRecenterSuccess(origin: Calibration['origin'], yaw: number) {
    clearRecenterTimer();
    recenterActive = false;
    recenterSamples = [];
    const entry = deps.entries();
    if (calibratedEntry !== entry) anchor = null;
    calibratedEntry = entry;
    calibration = {
      origin,
      yaw,
      posture: calibration.posture,
      source: 'recenter',
      entry,
    };
    status = 'ready';
    message = null;
    publishNow();
  }

  const onCameraTransform = (e: { position?: unknown; forward?: unknown; up?: unknown }) => {
    const t = deps.now();
    const sample = headSampleFromViro(t, e);
    if (!sample) return;

    ring[ringHead] = sample;
    ringHead = (ringHead + 1) % SAMPLE_BUFFER_CAPACITY;
    if (ringCount < SAMPLE_BUFFER_CAPACITY) ringCount += 1;
    samplesSeen += 1;
    latestSample = sample;

    if (ringCount >= 2) {
      const oldest = ring[(ringHead - ringCount + SAMPLE_BUFFER_CAPACITY) % SAMPLE_BUFFER_CAPACITY];
      if (oldest && sample.t > oldest.t) {
        sampleHz = ((ringCount - 1) * 1000) / (sample.t - oldest.t);
      } else {
        sampleHz = null;
      }
    } else {
      sampleHz = null;
    }

    if (recenterActive) {
      recenterSamples.push(sample);
      if (recenterSamples.length > RECENTER_MAX_SAMPLES) recenterSamples.shift();
      const result = calibrateFromSamples(recenterSamples, RECENTER_WINDOW_MS);
      if (result.ok) {
        applyRecenterSuccess(result.origin, result.yaw);
        return;
      }
    }

    schedulePublish(t);
  };

  function calibrateForSolo(nextAnchor: RigAnchor): Calibration {
    const entry = deps.entries();
    const cleanAnchor: RigAnchor = { x: nextAnchor.x, z: nextAnchor.z, yaw: nextAnchor.yaw };

    if (calibratedEntry === entry) {
      if (anchor === null) {
        anchor = cleanAnchor;
        publishNow();
      }
      return calibration;
    }

    clearRecenterTimer();
    recenterActive = false;
    recenterSamples = [];

    calibratedEntry = entry;
    anchor = cleanAnchor;

    const samples = orderedSamples();
    const result = calibrateFromSamples(samples, RECENTER_WINDOW_MS);
    if (result.ok) {
      calibration = {
        origin: result.origin,
        yaw: result.yaw,
        posture: calibration.posture,
        source: 'solo',
        entry,
      };
      status = 'ready';
      message = null;
    } else {
      let fallbackSample: HeadSample | null = null;
      let fallbackYaw: number | null = null;
      for (let i = samples.length - 1; i >= 0; i -= 1) {
        const yaw = yawFromForward(samples[i].forward);
        if (yaw !== null) {
          fallbackSample = samples[i];
          fallbackYaw = yaw;
          break;
        }
      }
      if (fallbackSample && fallbackYaw !== null) {
        calibration = {
          origin: fallbackSample.position,
          yaw: fallbackYaw,
          posture: calibration.posture,
          source: 'solo',
          entry,
        };
        status = 'ready';
        message = null;
      } else {
        calibration = {
          ...DEFAULT_CALIBRATION,
          origin: [...DEFAULT_CALIBRATION.origin],
          posture: calibration.posture,
        };
        status = 'no-samples';
        message = NO_SAMPLES_MESSAGE;
      }
    }

    publishNow();
    return calibration;
  }

  function recenter() {
    clearRecenterTimer();
    if (!recenterActive) {
      preRecenterStatus = status;
      preRecenterMessage = message;
    }
    recenterActive = true;
    recenterSamples = [];
    status = 'sampling';
    message = 'Hold still to recenter...';
    recenterTimer = deps.schedule(() => {
      recenterTimer = null;
      if (!recenterActive) return;
      recenterActive = false;
      recenterSamples = [];
      status = 'failed';
      message = QUEST_RECENTER_FAILURE_MESSAGE;
      publishNow();
    }, RECENTER_TIMEOUT_MS);
    publishNow();
  }

  function cyclePosture(): Posture {
    const nextPosture: Posture = calibration.posture === 'standing' ? 'seated' : 'standing';
    calibration = { ...calibration, posture: nextPosture };
    publishNow();
    return nextPosture;
  }

  function dispose() {
    clearPublishTimer();
    clearRecenterTimer();
    if (recenterActive) {
      recenterActive = false;
      recenterSamples = [];
      status = preRecenterStatus;
      message = preRecenterMessage;
      snapshot = buildSnapshot();
    }
  }

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    onCameraTransform,
    calibrateForSolo,
    recenter,
    cyclePosture,
    dispose,
  };
}

export const questHeadTracker = createQuestHeadTracker({
  now: () => Date.now(),
  schedule: (cb, ms) => setTimeout(cb, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  entries: () => questRuntime.getSnapshot().entries,
});
