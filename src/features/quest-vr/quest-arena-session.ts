import { ArenaMatch } from '../arena-fighter/arena-match.ts';
import type { ArenaAsset, FighterTransform } from '../arena-fighter/arena-controller.ts';

import type { QuestMenuPage } from './quest-menu-layout.ts';

export const QUEST_ASSET_TIMEOUT_MS = 30_000;
const sessionLease = 1;

export type QuestReadyReason = 'no-match' | 'not-ready' | 'combat-controls-absent';

export interface QuestReadyResult {
  called: boolean;
  started: boolean;
  reason: QuestReadyReason;
}

interface ReadyMatch {
  getSnapshot: () => { canReady: boolean };
  ready: () => boolean;
  invalidatePlacementReady: () => void;
}

export function questReadyDecision(canReady: boolean) {
  // canReady is true only after the phone prerequisites, including tracking.
  // Calling ready() then would open the solo countdown and a CPU fight.
  return canReady
    ? { callReady: false as const, reason: 'combat-controls-absent' as const }
    : { callReady: true as const, reason: 'not-ready' as const };
}

export function applyQuestReady(match: ReadyMatch): QuestReadyResult {
  const decision = questReadyDecision(match.getSnapshot().canReady);
  if (!decision.callReady)
    return { called: false, started: false, reason: 'combat-controls-absent' };
  const started = match.ready();
  if (started) {
    match.invalidatePlacementReady();
    return { called: true, started: false, reason: 'combat-controls-absent' };
  }
  return { called: true, started: false, reason: 'not-ready' };
}

export interface QuestArenaView {
  page: QuestMenuPage;
  mode: 'solo' | null;
  stage: string | null;
  phase: string | null;
  placed: boolean;
  tracking: boolean;
  landscape: boolean;
  assetsLoaded: number;
  canReady: boolean;
  localReady: boolean;
  message: string | null;
  token: number | null;
  placementVersion: number | null;
  lease: number;
  transforms: { blue: FighterTransform; red: FighterTransform } | null;
  lastReady: QuestReadyResult | null;
  lines: string[];
}

interface QuestClock {
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
}

const defaultClock: QuestClock = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function readyLine(result: QuestReadyResult) {
  if (result.reason === 'combat-controls-absent')
    return 'Ready was refused. A fight would start, and combat controls are not in this stage.';
  if (result.reason === 'no-match') return 'Select Solo before Ready.';
  return 'Ready did not start. Headset tracking was not asserted.';
}

function menuLines(
  page: QuestMenuPage,
  match: ArenaMatch | null,
  lastReady: QuestReadyResult | null
) {
  if (page === 'menu' || !match)
    return [
      'Headset menu. This is not the phone launcher.',
      'Solo shows both robots in a fixed virtual ring.',
      'Ready is next. It does not start a fight.',
      'Exit leaves the headset scene.',
    ];
  const snapshot = match.getSnapshot();
  const lines = [
    'Solo practice. Fixed ring, not an AR plane.',
    'Headset tracking was not marked ready.',
    `Match ${snapshot.stage}. Assets ${snapshot.assetsLoaded}/3. Placed ${snapshot.placed ? 'yes' : 'no'}.`,
    `Controller: ${snapshot.message}`,
  ];
  if (lastReady) lines.push(readyLine(lastReady));
  return lines;
}

export function createQuestArenaSession(clock: QuestClock = defaultClock) {
  let match: ArenaMatch | null = null;
  let unsubscribe: (() => void) | null = null;
  let page: QuestMenuPage = 'menu';
  let lastReady: QuestReadyResult | null = null;
  let lease = 0;
  let disposed = false;
  let timer: unknown = null;
  let view: QuestArenaView = emptyView();
  const listeners = new Set<() => void>();

  function emptyView(): QuestArenaView {
    return {
      page,
      mode: null,
      stage: null,
      phase: null,
      placed: false,
      tracking: false,
      landscape: false,
      assetsLoaded: 0,
      canReady: false,
      localReady: false,
      message: null,
      token: null,
      placementVersion: null,
      lease: 0,
      transforms: null,
      lastReady,
      lines: menuLines(page, null, lastReady),
    };
  }

  function publish() {
    const next = match
      ? {
          page,
          mode: 'solo' as const,
          stage: match.getSnapshot().stage,
          phase: match.getSnapshot().phase,
          placed: match.getSnapshot().placed,
          tracking: match.round.hasNormalTracking(),
          landscape: match.isLandscape(),
          assetsLoaded: match.getSnapshot().assetsLoaded,
          canReady: match.getSnapshot().canReady,
          localReady: match.getSnapshot().localReady,
          message: match.getSnapshot().message,
          token: match.getSnapshot().sessionToken,
          placementVersion: match.getSnapshot().placementVersion,
          lease,
          transforms: {
            blue: match.getTransform('blue'),
            red: match.getTransform('red'),
          },
          lastReady,
          lines: menuLines(page, match, lastReady),
        }
      : emptyView();
    if (JSON.stringify(next) === JSON.stringify(view)) return;
    view = next;
    listeners.forEach((listener) => listener());
  }

  function clearTimer() {
    if (timer !== null) clock.cancel(timer);
    timer = null;
  }

  function releaseMatch() {
    clearTimer();
    unsubscribe?.();
    unsubscribe = null;
    match?.dispose();
    match = null;
    page = 'menu';
    lastReady = null;
  }

  function armAssetTimeout() {
    clearTimer();
    timer = clock.schedule(() => {
      timer = null;
      if (disposed || !match) return;
      const missing = match.firstMissingAsset();
      const snapshot = match.getSnapshot();
      if (!missing || snapshot.sessionToken === null) return;
      match.assetFailed(snapshot.sessionToken, snapshot.placementVersion, missing);
      publish();
    }, QUEST_ASSET_TIMEOUT_MS);
  }

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => view,
    solo() {
      if (disposed || page === 'ring') return false;
      const created = new ArenaMatch('solo');
      unsubscribe = created.subscribe(() => publish());
      created.attachSession(sessionLease);
      // The immersive activity is already the playable orientation. This is not tracking.
      created.setLandscape(true);
      if (created.round.hasNormalTracking() || created.getSnapshot().placed)
        throw new Error('Solo setup asserted tracking or an AR placement.');
      lease += 1;
      match = created;
      page = 'ring';
      lastReady = null;
      armAssetTimeout();
      publish();
      return true;
    },
    ready() {
      if (disposed || !match) {
        lastReady = { called: false, started: false, reason: 'no-match' };
        publish();
        return lastReady;
      }
      lastReady = applyQuestReady(match);
      publish();
      return lastReady;
    },
    back() {
      if (disposed || page !== 'ring') return 'menu' as const;
      releaseMatch();
      publish();
      return 'menu' as const;
    },
    exit() {
      if (!disposed) releaseMatch();
      publish();
    },
    assetLoaded(callbackLease: number, token: number, version: number, asset: ArenaAsset) {
      if (disposed || !match || callbackLease !== lease) return;
      match.assetLoaded(token, version, asset);
      if (!match.firstMissingAsset()) clearTimer();
      publish();
    },
    assetFailed(callbackLease: number, token: number, version: number, asset: ArenaAsset) {
      if (disposed || !match || callbackLease !== lease) return;
      match.assetFailed(token, version, asset);
      clearTimer();
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseMatch();
      publish();
    },
  };
}

export type QuestArenaSession = ReturnType<typeof createQuestArenaSession>;
