import {
  DEFAULT_CALIBRATION,
  applyYawTurnToCalibration,
  calibrateFromSamples,
  gameplayHeadPose,
  headSampleFromViro,
  headStep,
  isReferenceDiscontinuity,
  REFERENCE_JUMP_MAX_DT_MS,
  yawFromForward,
  type Calibration,
  type GameplayHeadPose,
  type HeadSample,
  type Posture,
  type RigAnchor,
  type Vec3,
} from './quest-head-rig.ts';
import { questRuntime } from './quest-runtime-store.ts';

const SAMPLE_BUFFER_CAPACITY = 64;
const PUBLISH_INTERVAL_MS = 200;
const CALIBRATION_WINDOW_MS = 500;
// A candidate jump is kept only after this many continuous samples follow it
// (about 80 ms at 72 Hz). Another discontinuity inside that window is a glitch
// and cancels it, and no new candidate starts until the stream settles again.
const REFERENCE_JUMP_CONFIRM_SAMPLES = 6;

const NO_SAMPLES_MESSAGE = 'Head pose unavailable.';

export interface QuestHeadTrackerSnapshot {
  calibration: Calibration;
  anchor: RigAnchor | null;
  status: 'uncalibrated' | 'ready' | 'no-samples';
  message: string | null;
  sampleHz: number | null;
  pose: GameplayHeadPose | null;
  outOfBounds: boolean;
  samplesSeen: number;
  /** Latest raw LOCAL head sample, for sparse logs only. */
  raw: { position: Vec3; yaw: number | null } | null;
  /** Calibrations re-anchored after a Horizon system reference-space change this session. */
  referenceResets: number;
}

export type QuestHeadLiveEvent =
  'sample' | 'jump-pending' | 'recenter' | 'calibrate' | 'turn' | 'dispose';

export interface QuestLiveHeadState {
  sample: HeadSample | null;
  calibration: Calibration;
  status: QuestHeadTrackerSnapshot['status'];
  recentering: boolean;
  referenceResets: number;
  lastValidYaw: number | null;
  refEpoch: number | null;
  nowMs: number;
}

const fmt = (v: Vec3) => `[${v.map((n) => n.toFixed(3)).join(',')}]`;
const fmtYaw = (yaw: number | null) => (yaw === null ? '--' : yaw.toFixed(1));

export function createQuestHeadTracker(deps: {
  now: () => number;
  schedule: (cb: () => void, ms: number) => unknown;
  cancel: (h: unknown) => void;
  entries: () => number;
  /** Optional native OpenXR LOCAL reference-space reset counter. */
  refSpaceEpoch?: () => number;
  /** Sparse event log: calibration changes and reference jumps, never per frame. */
  log?: (message: string) => void;
}) {
  const log = deps.log ?? (() => {});
  const listeners = new Set<() => void>();
  const liveListeners = new Set<(event: QuestHeadLiveEvent) => void>();
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

  let refSpaceEpochSource: (() => number) | null = null;
  let lastRefSpaceEpoch: number | null = null;

  // Bumped whenever origin/yaw is set, so a jump confirmed after a fresh
  // calibration (already in the new frame) is not applied twice.
  let calibrationVersion = 0;
  let pendingJump: {
    from: HeadSample;
    to: HeadSample;
    version: number;
    confirmations: number;
  } | null = null;
  let jumpCooldown = 0;
  let referenceResets = 0;
  let lastValidYaw: number | null = null;

  let snapshot: QuestHeadTrackerSnapshot = buildSnapshot();

  function emitLive(event: QuestHeadLiveEvent) {
    liveListeners.forEach((listener) => listener(event));
  }

  function getLiveHeadState(): QuestLiveHeadState {
    const hasRefSource = Boolean(refSpaceEpochSource ?? deps.refSpaceEpoch);
    return {
      sample: latestSample,
      calibration,
      status,
      recentering: pendingJump !== null,
      referenceResets,
      lastValidYaw,
      refEpoch: hasRefSource ? lastRefSpaceEpoch : null,
      nowMs: deps.now(),
    };
  }

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
      raw: latestSample
        ? { position: latestSample.position, yaw: yawFromForward(latestSample.forward) }
        : null,
      referenceResets,
    };
  }

  function clearPublishTimer() {
    if (publishTimer !== null) {
      deps.cancel(publishTimer);
      publishTimer = null;
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

  function logCalibration(reason: string) {
    log(
      `calibrated src=${calibration.source} reason=${reason} origin=${fmt(calibration.origin)} yaw=${calibration.yaw.toFixed(1)} posture=${calibration.posture} entry=${calibration.entry}`
    );
  }

  // Align the app rig with a Horizon OS system recenter (LOCAL reference-space
  // change) instead of snapping back to the old room pose. Pre-Solo menu
  // content already follows LOCAL at DEFAULT_CALIBRATION; calibrated Solo rigs
  // re-anchor at the wearer's current eye pose in the new LOCAL frame.
  function acceptSystemRecenter(sample: HeadSample, reason: 'openxr-event' | 'sample-jump') {
    if (calibration.source === 'default' || calibratedEntry === null) {
      log(`system recenter noted reason=${reason} action=none default-frame-follows-local`);
      return;
    }
    const yaw = yawFromForward(sample.forward);
    if (yaw === null) {
      log(`system recenter deferred reason=${reason} yaw-unknown`);
      return;
    }
    const before = calibration;
    calibration = {
      origin: [...sample.position],
      yaw,
      posture: calibration.posture,
      source: 'system',
      entry: calibratedEntry,
    };
    calibrationVersion += 1;
    referenceResets += 1;
    lastValidYaw = yaw;
    status = 'ready';
    message = null;
    log(
      `system recenter applied reason=${reason} origin=${fmt(before.origin)}->${fmt(calibration.origin)} yaw=${before.yaw.toFixed(1)}->${calibration.yaw.toFixed(1)} resets=${referenceResets}`
    );
    publishNow();
  }

  function commitJump(jump: NonNullable<typeof pendingJump>) {
    if (calibration.source === 'default') {
      log('reference jump confirmed action=none reason=default-frame-follows-local');
      return;
    }
    if (jump.version !== calibrationVersion) {
      log('reference jump confirmed action=none reason=calibrated-after-jump');
      return;
    }
    acceptSystemRecenter(jump.to, 'sample-jump');
  }

  // Raw sample-to-sample check. The clamped gameplay pose is never consulted:
  // being out of bounds alone never moves the world.
  function trackReferenceFrame(previous: HeadSample | null, sample: HeadSample) {
    if (!previous) return;
    const step = headStep(previous, sample);
    const jump = isReferenceDiscontinuity(step);
    if (pendingJump) {
      if (jump || step.dt > REFERENCE_JUMP_MAX_DT_MS) {
        log(
          `reference jump rejected reason=${jump ? 'second-discontinuity' : 'sample-gap'} dt=${step.dt}ms`
        );
        pendingJump = null;
        jumpCooldown = REFERENCE_JUMP_CONFIRM_SAMPLES;
        return;
      }
      pendingJump.confirmations += 1;
      if (pendingJump.confirmations >= REFERENCE_JUMP_CONFIRM_SAMPLES) {
        const confirmed = pendingJump;
        pendingJump = null;
        commitJump(confirmed);
      }
      return;
    }
    if (!jump) {
      if (jumpCooldown > 0) jumpCooldown -= 1;
      return;
    }
    if (jumpCooldown > 0 || step.yawDelta === null) {
      // Logged once per settled stream, so a glitching tracker cannot spam.
      if (jumpCooldown === 0) {
        log(
          `reference jump ignored reason=yaw-unknown dt=${step.dt}ms dpos=${step.distance.toFixed(3)}m`
        );
      }
      jumpCooldown = REFERENCE_JUMP_CONFIRM_SAMPLES;
      return;
    }
    pendingJump = { from: previous, to: sample, version: calibrationVersion, confirmations: 0 };
    log(
      `reference jump candidate dt=${step.dt}ms delta=${fmt(step.delta)} dpos=${step.distance.toFixed(3)}m dyaw=${fmtYaw(step.yawDelta)} from=${fmt(previous.position)}@${fmtYaw(yawFromForward(previous.forward))} to=${fmt(sample.position)}@${fmtYaw(yawFromForward(sample.forward))} origin=${fmt(calibration.origin)} calYaw=${calibration.yaw.toFixed(1)} src=${calibration.source}`
    );
  }

  const onCameraTransform = (e: { position?: unknown; forward?: unknown; up?: unknown }) => {
    const t = deps.now();
    const sample = headSampleFromViro(t, e);
    if (!sample) return;

    const previous = latestSample;
    ring[ringHead] = sample;
    ringHead = (ringHead + 1) % SAMPLE_BUFFER_CAPACITY;
    if (ringCount < SAMPLE_BUFFER_CAPACITY) ringCount += 1;
    samplesSeen += 1;
    latestSample = sample;
    const liveYaw = yawFromForward(sample.forward);
    if (liveYaw !== null) lastValidYaw = liveYaw;

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

    const prevResets = referenceResets;
    const epoch = (refSpaceEpochSource ?? deps.refSpaceEpoch)?.() ?? 0;
    if (lastRefSpaceEpoch === null) {
      lastRefSpaceEpoch = epoch;
      trackReferenceFrame(previous, sample);
    } else if (epoch !== lastRefSpaceEpoch) {
      lastRefSpaceEpoch = epoch;
      pendingJump = null;
      jumpCooldown = 0;
      acceptSystemRecenter(sample, 'openxr-event');
    } else {
      trackReferenceFrame(previous, sample);
    }

    emitLive(
      referenceResets !== prevResets ? 'recenter' : pendingJump !== null ? 'jump-pending' : 'sample'
    );
    schedulePublish(t);
  };

  function calibrateForSolo(nextAnchor: RigAnchor): Calibration {
    const entry = deps.entries();
    const cleanAnchor: RigAnchor = { x: nextAnchor.x, z: nextAnchor.z, yaw: nextAnchor.yaw };

    if (calibratedEntry === entry) {
      if (anchor === null) {
        anchor = cleanAnchor;
        publishNow();
        emitLive('calibrate');
      }
      return calibration;
    }

    calibratedEntry = entry;
    anchor = cleanAnchor;

    const samples = orderedSamples();
    const result = calibrateFromSamples(samples, CALIBRATION_WINDOW_MS);
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

    lastValidYaw =
      status === 'ready'
        ? ((latestSample ? yawFromForward(latestSample.forward) : null) ?? calibration.yaw)
        : null;
    calibrationVersion += 1;
    logCalibration(result.ok ? 'solo-window' : status === 'ready' ? 'solo-latest' : 'solo-default');
    publishNow();
    emitLive('calibrate');
    return calibration;
  }

  function cyclePosture(): Posture {
    const nextPosture: Posture = calibration.posture === 'standing' ? 'seated' : 'standing';
    calibration = { ...calibration, posture: nextPosture };
    publishNow();
    return nextPosture;
  }

  function applyTurnDelta(deltaYawDeg: number): Calibration {
    if (!Number.isFinite(deltaYawDeg) || deltaYawDeg === 0) return calibration;
    calibration = applyYawTurnToCalibration(calibration, latestSample?.position, deltaYawDeg);
    calibrationVersion += 1;
    pendingJump = null;
    schedulePublish(deps.now());
    emitLive('turn');
    return calibration;
  }

  function setRefSpaceEpochSource(source: (() => number) | null) {
    refSpaceEpochSource = source;
    lastRefSpaceEpoch = source ? source() : null;
  }

  function dispose() {
    clearPublishTimer();
    refSpaceEpochSource = null;
    lastRefSpaceEpoch = null;
    pendingJump = null;
    jumpCooldown = 0;
    referenceResets = 0;
    lastValidYaw = null;
    calibrationVersion += 1;
    // Clear previous-session origin/yaw and samples so a new VRActivity entry
    // opens its pre-Solo menu in front of the wearer instead of anchored to
    // the destroyed OpenXR session, while keeping the user's posture choice.
    ring.fill(null);
    ringHead = 0;
    ringCount = 0;
    samplesSeen = 0;
    latestSample = null;
    sampleHz = null;
    lastPublishAt = null;
    calibratedEntry = null;
    anchor = null;
    status = 'uncalibrated';
    message = null;
    calibration = {
      ...DEFAULT_CALIBRATION,
      origin: [...DEFAULT_CALIBRATION.origin],
      posture: calibration.posture,
    };
    snapshot = buildSnapshot();
    emitLive('dispose');
  }

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeLive: (listener: (event: QuestHeadLiveEvent) => void) => {
      liveListeners.add(listener);
      return () => {
        liveListeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getLiveHeadState,
    onCameraTransform,
    calibrateForSolo,
    cyclePosture,
    applyTurnDelta,
    setRefSpaceEpochSource,
    dispose,
  };
}

export const questHeadTracker = createQuestHeadTracker({
  now: () => Date.now(),
  schedule: (cb, ms) => setTimeout(cb, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  entries: () => questRuntime.getSnapshot().entries,
  // console.warn reaches logcat as ReactNativeJS in release builds.
  log: (message) => console.warn(`[QuestHeadRig] ${message}`),
});
