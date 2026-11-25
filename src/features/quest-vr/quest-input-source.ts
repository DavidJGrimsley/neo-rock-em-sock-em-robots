import {
  decodeBatch,
  quantile,
  type QuestHand,
  type QuestHandSample,
  type QuestInputBatch,
  type QuestInputSample,
  type QuestTrackingState,
} from './quest-input.ts';

// Polls the raw controller ring (modules/quest-input) outside React. Every sample is
// decoded once; React sees a 5 Hz snapshot, logs are 1 Hz plus state changes, and
// marker listeners get the newest true sample once per poll. A fake `read` drives
// the tests; it cannot satisfy the device gate.

const POLL_INTERVAL_MS = 11;
const IDLE_POLL_INTERVAL_MS = 250;
const PUBLISH_INTERVAL_MS = 200;
const LOG_INTERVAL_MS = 1000;
const PROFILE_INTERVAL_MS = 1000;
const SAMPLE_BUFFER_CAPACITY = 64;
const STATS_WINDOW = 120;
/** No new sample for this long on the capture clock: the source is stale. */
export const QUEST_INPUT_STALE_NS = 100_000_000;
const STICK_QUANTUM = 0.01;

export type QuestInputStatus =
  | 'unavailable' // module missing, or renderer without patch 0003
  | 'waiting' // session live, no sample yet
  | 'live'
  | 'unfocused' // session VISIBLE or input not synced (system UI over the app)
  | 'stale' // samples stopped (paused, idle, views invalid)
  | 'ended'; // session torn down

export interface QuestInputReader {
  read(afterSeq: number): QuestInputBatch;
  profiles?(): string[];
}

export interface QuestTimingSummary {
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface QuestHandStats {
  tracking: QuestTrackingState | null;
  losses: number;
  recoveries: number;
  /** Capture-clock duration of the last completed loss. */
  lastLossMs: number | null;
  /** Distinct thumbstick positions seen, at 0.01 resolution: continuous axes give many. */
  stickDistinct: number;
  /** Largest min(|x|, |y|) seen: a true diagonal. */
  stickDiagonalPeak: number;
  triggerPeak: number;
  squeezePeak: number;
}

export interface QuestInputSnapshot {
  status: QuestInputStatus;
  message: string | null;
  generation: number;
  refEpoch: number | null;
  profiles: readonly [string, string];
  latest: QuestInputSample | null;
  samplesSeen: number;
  /** Seq gaps: samples overwritten before they were read. */
  missed: number;
  /** Samples this session published before the first read returned one (late mount or overrun). */
  skippedBeforeFirstRead: number;
  invalid: number;
  framesWithoutInput: number;
  rejected: number;
  sampleHz: number | null;
  /** Between consecutive samples, XrTime domain. */
  displayDtMs: QuestTimingSummary;
  /** Between consecutive samples, CLOCK_MONOTONIC domain. */
  captureDtMs: QuestTimingSummary;
  /** Read time minus capture time of the newest sample, CLOCK_MONOTONIC. */
  ageMs: number | null;
  /** JS cost of one native read. */
  readMs: QuestTimingSummary;
  hands: { left: QuestHandStats; right: QuestHandStats };
}

const NS_PER_MS = 1_000_000;

function emptyHandStats(): QuestHandStats {
  return {
    tracking: null,
    losses: 0,
    recoveries: 0,
    lastLossMs: null,
    stickDistinct: 0,
    stickDiagonalPeak: 0,
    triggerPeak: 0,
    squeezePeak: 0,
  };
}

function summary(values: readonly number[]): QuestTimingSummary {
  return {
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  };
}

class Window {
  private readonly values: number[] = [];
  private readonly size: number;
  constructor(size: number) {
    this.size = size;
  }
  push(value: number) {
    this.values.push(value);
    if (this.values.length > this.size) this.values.shift();
  }
  clear() {
    this.values.length = 0;
  }
  get list(): readonly number[] {
    return this.values;
  }
}

const fmt = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? '--' : n.toFixed(digits);
const fmtVec = (v: readonly number[] | null) =>
  v ? `[${v.map((n) => n.toFixed(3)).join(',')}]` : '--';

function handLog(h: QuestHandSample): string {
  const b = h.buttons;
  const bits = `${b.primary ? 'P' : '-'}${b.secondary ? 'S' : '-'}${b.menu ? 'M' : '-'}`;
  return `${h.hand[0].toUpperCase()}:${h.tracking} pos=${fmtVec(h.position)} stick=${fmt(h.thumbstick.x)},${fmt(h.thumbstick.y)} trig=${fmt(h.trigger.value)} sq=${fmt(h.squeeze.value)} btn=${bits}`;
}

export function createQuestInputSource(deps: {
  reader: QuestInputReader | null;
  /** Monotonic milliseconds, for scheduling and read cost only; never compared with sample times. */
  now: () => number;
  schedule: (cb: () => void, ms: number) => unknown;
  cancel: (h: unknown) => void;
  log?: (message: string) => void;
}) {
  const log = deps.log ?? (() => {});
  const listeners = new Set<() => void>();
  const sampleListeners = new Set<
    (
      sample: QuestInputSample | null,
      status: QuestInputStatus,
      acceptedSamples?: readonly QuestInputSample[]
    ) => void
  >();
  const ring: (QuestInputSample | null)[] = new Array(SAMPLE_BUFFER_CAPACITY).fill(null);
  let ringHead = 0;

  let cursor = 0;
  let nativeNowNs: number | null = null;
  let nativeReadAt = 0;
  let running = false;
  let pollTimer: unknown = null;
  let lastPublishAt: number | null = null;
  let lastLogAt: number | null = null;
  let lastProfileAt: number | null = null;
  /** Set by a status change; the next emit publishes at once instead of waiting for 5 Hz. */
  let statusChanged = false;

  let status: QuestInputStatus = deps.reader ? 'waiting' : 'unavailable';
  let message: string | null = deps.reader ? null : 'Quest input bridge unavailable.';
  let generation = 0;
  let latest: QuestInputSample | null = null;
  let samplesSeen = 0;
  let missed = 0;
  let skippedBeforeFirstRead = 0;
  let invalid = 0;
  let framesWithoutInput = 0;
  let rejected = 0;
  let ageNs: number | null = null;
  let profiles: readonly [string, string] = ['', ''];
  const displayDt = new Window(STATS_WINDOW);
  const captureDt = new Window(STATS_WINDOW);
  const readCost = new Window(STATS_WINDOW);
  const hands: Record<QuestHand, QuestHandStats> = {
    left: emptyHandStats(),
    right: emptyHandStats(),
  };
  const lossStartedNs: Record<QuestHand, number | null> = { left: null, right: null };
  const stickSeen: Record<QuestHand, Set<number>> = { left: new Set(), right: new Set() };

  let snapshot: QuestInputSnapshot = buildSnapshot();

  function buildSnapshot(): QuestInputSnapshot {
    const captureSummary = summary(captureDt.list.map((ns) => ns / NS_PER_MS));
    const hz = captureSummary.p50 && captureSummary.p50 > 0 ? 1000 / captureSummary.p50 : null;
    return {
      status,
      message,
      generation,
      refEpoch: latest?.refEpoch ?? null,
      profiles,
      latest,
      samplesSeen,
      missed,
      skippedBeforeFirstRead,
      invalid,
      framesWithoutInput,
      rejected,
      sampleHz: hz,
      displayDtMs: summary(displayDt.list.map((ns) => ns / NS_PER_MS)),
      captureDtMs: captureSummary,
      ageMs: ageNs === null ? null : ageNs / NS_PER_MS,
      readMs: summary(readCost.list),
      hands: { left: { ...hands.left }, right: { ...hands.right } },
    };
  }

  function resetSession(next: number) {
    generation = next;
    latest = null;
    ageNs = null;
    skippedBeforeFirstRead = 0;
    ring.fill(null);
    ringHead = 0;
    displayDt.clear();
    captureDt.clear();
    profiles = ['', ''];
    for (const hand of ['left', 'right'] as const) {
      hands[hand] = emptyHandStats();
      lossStartedNs[hand] = null;
      stickSeen[hand].clear();
    }
  }

  function setStatus(next: QuestInputStatus, why: string | null) {
    if (next === status) {
      message = why;
      return;
    }
    log(`status ${status} -> ${next}${why ? ` (${why})` : ''}`);
    statusChanged = true;
    status = next;
    message = why;
  }

  function trackHand(sample: QuestInputSample, h: QuestHandSample) {
    const stats = hands[h.hand];
    const previous = stats.tracking;
    if (previous !== h.tracking) {
      // An unfocused session deactivates every action, so its "lost" poses are not
      // tracking losses: they are logged but not counted, and do not start a loss.
      let recovered: number | null = null;
      if (h.tracking === 'lost' && previous !== null && sample.focused) {
        stats.losses += 1;
        lossStartedNs[h.hand] = sample.capturedNs;
      } else if (previous === 'lost' && h.tracking !== 'lost') {
        const started = lossStartedNs[h.hand];
        if (started !== null) {
          stats.recoveries += 1;
          recovered = (sample.capturedNs - started) / NS_PER_MS;
          stats.lastLossMs = recovered;
        }
        lossStartedNs[h.hand] = null;
      }
      log(
        `${h.hand} ${previous ?? 'none'} -> ${h.tracking} seq=${sample.seq} gen=${sample.generation}` +
          (sample.focused ? '' : ' (unfocused)') +
          (recovered !== null ? ` lost=${recovered.toFixed(0)}ms` : '')
      );
      stats.tracking = h.tracking;
    }
    if (h.thumbstick.active) {
      const { x, y } = h.thumbstick;
      const key = Math.round(x / STICK_QUANTUM) * 1000 + Math.round(y / STICK_QUANTUM);
      if (stickSeen[h.hand].size < 40401) stickSeen[h.hand].add(key);
      stats.stickDistinct = stickSeen[h.hand].size;
      stats.stickDiagonalPeak = Math.max(
        stats.stickDiagonalPeak,
        Math.min(Math.abs(x), Math.abs(y))
      );
    }
    if (h.trigger.active) stats.triggerPeak = Math.max(stats.triggerPeak, h.trigger.value);
    if (h.squeeze.active) stats.squeezePeak = Math.max(stats.squeezePeak, h.squeeze.value);
  }

  function accept(sample: QuestInputSample) {
    if (latest) {
      if (sample.seq !== latest.seq + 1) missed += sample.seq - latest.seq - 1;
      displayDt.push(sample.displayTimeNs - latest.displayTimeNs);
      captureDt.push(sample.capturedNs - latest.capturedNs);
      if (sample.refEpoch !== latest.refEpoch)
        log(
          `reference epoch ${latest.refEpoch} -> ${sample.refEpoch} (system recenter, same session)`
        );
      if (sample.focused !== latest.focused)
        log(
          `focus ${latest.focused} -> ${sample.focused} state=${sample.sessionState} sync=${sample.syncResult}`
        );
    }
    ring[ringHead] = sample;
    ringHead = (ringHead + 1) % SAMPLE_BUFFER_CAPACITY;
    samplesSeen += 1;
    trackHand(sample, sample.left);
    trackHand(sample, sample.right);
    latest = sample;
  }

  function poll() {
    pollTimer = null;
    if (!running || !deps.reader) return;
    const startedAt = deps.now();
    let raw: QuestInputBatch | null = null;
    try {
      raw = deps.reader.read(cursor);
    } catch (error) {
      raw = { available: true, error: error instanceof Error ? error.message : String(error) };
    }
    readCost.push(deps.now() - startedAt);
    const batch = decodeBatch(raw);
    nativeNowNs = batch.nowNs;
    // Conservative age: include JNI/decode time instead of anchoring the native
    // read timestamp after a potentially delayed JS conversion.
    nativeReadAt = startedAt;
    let acceptedSamples: readonly QuestInputSample[] | undefined;
    if (!batch.ok) {
      if (raw && raw.available === false) {
        setStatus('unavailable', 'Renderer has no input sampler (patch 0003).');
        running = false;
        emit(true);
        return;
      }
      setStatus('stale', `bad batch: ${batch.error}`);
    } else {
      if (batch.generation !== generation) {
        log(`session generation ${generation} -> ${batch.generation}`);
        resetSession(batch.generation);
      }
      framesWithoutInput = batch.framesWithoutInput;
      rejected = batch.rejected;
      invalid += batch.invalid;
      // The cursor never moves backwards: seq is never reset natively.
      if (batch.latestSeq > cursor) cursor = batch.latestSeq;
      // The first sample a session yields: anything it published earlier was never read.
      // Seq never resets natively, so the session's own first seq comes from its count.
      const first = batch.samples[0];
      if (!latest && first && batch.published > 0) {
        const sessionFirstSeq = batch.latestSeq - batch.published + 1;
        if (first.seq > sessionFirstSeq) {
          skippedBeforeFirstRead += first.seq - sessionFirstSeq;
          log(`first read skipped ${first.seq - sessionFirstSeq} earlier samples of this session`);
        }
      }
      // Later seq gaps, including ring overruns between reads, are counted in accept().
      const newlyAccepted: QuestInputSample[] = [];
      for (const sample of batch.samples) {
        if (!latest || sample.seq > latest.seq) {
          accept(sample);
          newlyAccepted.push(sample);
        }
      }
      ageNs = latest && batch.nowNs !== null ? Math.max(0, batch.nowNs - latest.capturedNs) : null;
      // Generation 0 is the sampler before any renderer session exists, not a teardown.
      if (!batch.live && batch.generation === 0) setStatus('waiting', 'No OpenXR session yet.');
      else if (!batch.live) setStatus('ended', 'OpenXR session ended.');
      else if (!latest)
        setStatus('waiting', batch.actionsReady ? null : 'Controller actions not attached.');
      else if (ageNs !== null && ageNs > QUEST_INPUT_STALE_NS)
        setStatus('stale', `no input for ${(ageNs / NS_PER_MS).toFixed(0)} ms`);
      else if (!latest.focused) setStatus('unfocused', 'Session not focused; input inactive.');
      else setStatus('live', null);
      if (status === 'live' && newlyAccepted.length > 0) acceptedSamples = newlyAccepted;
    }
    const now = deps.now();
    if (
      deps.reader.profiles &&
      (lastProfileAt === null || now - lastProfileAt >= PROFILE_INTERVAL_MS)
    ) {
      lastProfileAt = now;
      try {
        const next = deps.reader.profiles();
        const pair: readonly [string, string] = [String(next?.[0] ?? ''), String(next?.[1] ?? '')];
        if (pair[0] !== profiles[0] || pair[1] !== profiles[1]) {
          log(`profiles left=${pair[0] || '--'} right=${pair[1] || '--'}`);
          profiles = pair;
        }
      } catch {
        // Profiles are diagnostics only.
      }
    }
    const visible = status === 'live' || status === 'unfocused' ? latest : null;
    for (const listener of sampleListeners) listener(visible, status, acceptedSamples);
    emit(false);
    if (lastLogAt === null || now - lastLogAt >= LOG_INTERVAL_MS) {
      lastLogAt = now;
      log(summaryLine());
    }
    pollTimer = deps.schedule(
      poll,
      status === 'ended' || status === 'waiting' ? IDLE_POLL_INTERVAL_MS : POLL_INTERVAL_MS
    );
  }

  function emit(force: boolean) {
    const now = deps.now();
    if (
      !force &&
      !statusChanged &&
      lastPublishAt !== null &&
      now - lastPublishAt < PUBLISH_INTERVAL_MS
    )
      return;
    lastPublishAt = now;
    statusChanged = false;
    snapshot = buildSnapshot();
    for (const listener of listeners) listener();
  }

  function summaryLine(): string {
    const s = buildSnapshot();
    const hands = latest ? `${handLog(latest.left)} ${handLog(latest.right)}` : 'no sample';
    return (
      `status=${s.status} gen=${s.generation} epoch=${s.refEpoch ?? '--'} seq=${latest?.seq ?? '--'} hz=${fmt(s.sampleHz, 0)} ` +
      `dt=${fmt(s.captureDtMs.p50)}/${fmt(s.captureDtMs.p95)}/${fmt(s.captureDtMs.max)}ms xrdt=${fmt(s.displayDtMs.p50)}/${fmt(s.displayDtMs.p95)}ms ` +
      `age=${fmt(s.ageMs, 1)}ms read=${fmt(s.readMs.p95, 3)}ms missed=${s.missed} skipped=${s.skippedBeforeFirstRead} noinput=${s.framesWithoutInput} invalid=${s.invalid} ` +
      `loss L${s.hands.left.losses}/${s.hands.left.recoveries} R${s.hands.right.losses}/${s.hands.right.recoveries} ` +
      `stick L${s.hands.left.stickDistinct}/${fmt(s.hands.left.stickDiagonalPeak)} R${s.hands.right.stickDistinct}/${fmt(s.hands.right.stickDiagonalPeak)} ${hands}`
    );
  }

  return {
    start() {
      if (running || !deps.reader || status === 'unavailable') {
        emit(true);
        return;
      }
      running = true;
      log('input source started');
      poll();
    },
    stop() {
      running = false;
      if (pollTimer !== null) deps.cancel(pollTimer);
      pollTimer = null;
      for (const listener of sampleListeners) listener(null, status);
    },
    /** Newest decoded samples, oldest first. */
    recent(): QuestInputSample[] {
      const out: QuestInputSample[] = [];
      for (let i = 0; i < SAMPLE_BUFFER_CAPACITY; i += 1) {
        const sample = ring[(ringHead + i) % SAMPLE_BUFFER_CAPACITY];
        if (sample) out.push(sample);
      }
      return out;
    },
    /** Every poll, outside React: the newest sample while live or unfocused, else null. */
    onSample(
      listener: (
        sample: QuestInputSample | null,
        status: QuestInputStatus,
        acceptedSamples?: readonly QuestInputSample[]
      ) => void
    ) {
      sampleListeners.add(listener);
      return () => {
        sampleListeners.delete(listener);
      };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getLiveState: () => ({
      latest,
      nowNs:
        nativeNowNs === null
          ? null
          : nativeNowNs + Math.max(0, deps.now() - nativeReadAt) * 1_000_000,
      hands: { left: { ...hands.left }, right: { ...hands.right } },
    }),
    summaryLine,
  };
}

export type QuestInputSource = ReturnType<typeof createQuestInputSource>;

function hudHand(h: QuestHandSample | null, stats: QuestHandStats, label: string): string {
  const loss = `loss ${stats.losses}/${stats.recoveries}${stats.lastLossMs === null ? '' : ` (${stats.lastLossMs.toFixed(0)} ms)`}`;
  const range = `stick ${stats.stickDistinct} pts diag ${fmt(stats.stickDiagonalPeak)}`;
  if (!h) return `${label} --  ${loss}  ${range}`;
  const b = h.buttons;
  const button = (name: string, value: boolean | null) =>
    `${name}${value === null ? '?' : value ? '*' : '-'}`;
  const names = h.hand === 'left' ? ['X', 'Y'] : ['A', 'B'];
  const buttons = `${button(names[0], b.primary)} ${button(names[1], b.secondary)}${h.hand === 'left' ? ` ${button('M', b.menu)}` : ''}`;
  const flags = `${h.positionValid ? 'pV' : 'p-'}${h.positionTracked ? 'T' : '-'} ${h.orientationValid ? 'oV' : 'o-'}${h.orientationTracked ? 'T' : '-'}`;
  const speed = h.linearVelocity ? Math.hypot(...h.linearVelocity).toFixed(2) : '--';
  return (
    `${label} ${h.tracking} ${flags} ${fmtVec(h.position)} v ${speed} m/s\n` +
    `   stick ${h.thumbstick.x >= 0 ? '+' : ''}${fmt(h.thumbstick.x)} ${h.thumbstick.y >= 0 ? '+' : ''}${fmt(h.thumbstick.y)}  trig ${fmt(h.trigger.value)}  grip ${fmt(h.squeeze.value)}  ${buttons}\n` +
    `   ${loss}  ${range}`
  );
}

/** Multi-line in-headset readout of a snapshot. */
export function formatQuestInputHud(s: QuestInputSnapshot): string {
  const header =
    `Controllers ${s.status}${s.message ? `: ${s.message}` : ''}  gen ${s.generation} epoch ${s.refEpoch ?? '--'}\n` +
    `${fmt(s.sampleHz, 0)} Hz  dt ${fmt(s.captureDtMs.p50, 1)}/${fmt(s.captureDtMs.p95, 1)}/${fmt(s.captureDtMs.max, 1)} ms  ` +
    `age ${fmt(s.ageMs, 1)} ms  read ${fmt(s.readMs.p95, 2)} ms  missed ${s.missed}  skipped ${s.skippedBeforeFirstRead}  no-input ${s.framesWithoutInput}`;
  const latest = s.latest;
  const profiles = `profile L ${s.profiles[0] || '--'}  R ${s.profiles[1] || '--'}`;
  return [
    header,
    hudHand(latest?.left ?? null, s.hands.left, 'L'),
    hudHand(latest?.right ?? null, s.hands.right, 'R'),
    profiles,
  ].join('\n');
}
