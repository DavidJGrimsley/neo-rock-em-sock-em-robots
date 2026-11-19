import { ArenaMatch } from '../arena-fighter/arena-match.ts';
import type { ArenaAsset, FighterTransform } from '../arena-fighter/arena-controller.ts';

import type { QuestMenuPage } from './quest-menu-layout.ts';

export const QUEST_ASSET_TIMEOUT_MS = 30_000;
export const QUEST_READY_SAVED =
  'Ready saved. Both robots stay idle. Combat controls are not in this stage.';
export const QUEST_LEAVING = 'Leaving the headset…';
const sessionLease = 1;

export type QuestReadyReason = 'no-match' | 'acknowledged';

export interface QuestReadyResult {
  called: false;
  started: false;
  reason: QuestReadyReason;
}

/** Ready never calls ArenaMatch.ready(). Acknowledging the lobby is the stage change. */
export function questReadyAcknowledgement(hasMatch: boolean): QuestReadyResult {
  return hasMatch
    ? { called: false, started: false, reason: 'acknowledged' }
    : { called: false, started: false, reason: 'no-match' };
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
  acknowledged: boolean;
  leaving: boolean;
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

function menuLines(page: QuestMenuPage, acknowledged: boolean, leaving: boolean) {
  if (leaving) return [QUEST_LEAVING];
  if (page === 'menu')
    return ['Solo places both robots in the ring.', 'They stay idle. This stage has no fight.'];
  const lines = ['Both robots are in the ring.', 'They stay idle until a later stage.'];
  if (acknowledged) lines.push(QUEST_READY_SAVED);
  return lines;
}

export function createQuestArenaSession(clock: QuestClock = defaultClock) {
  let match: ArenaMatch | null = null;
  let unsubscribe: (() => void) | null = null;
  let page: QuestMenuPage = 'menu';
  let lastReady: QuestReadyResult | null = null;
  let acknowledged = false;
  let leaving = false;
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
      acknowledged,
      leaving,
      message: null,
      token: null,
      placementVersion: null,
      lease: 0,
      transforms: null,
      lastReady,
      lines: menuLines(page, acknowledged, leaving),
    };
  }

  function publish() {
    const snapshot = match?.getSnapshot();
    const next = match
      ? {
          page,
          mode: 'solo' as const,
          stage: snapshot?.stage ?? null,
          phase: snapshot?.phase ?? null,
          placed: snapshot?.placed ?? false,
          tracking: match.round.hasNormalTracking(),
          landscape: match.isLandscape(),
          assetsLoaded: snapshot?.assetsLoaded ?? 0,
          canReady: snapshot?.canReady ?? false,
          localReady: snapshot?.localReady ?? false,
          acknowledged,
          leaving,
          message: snapshot?.message ?? null,
          token: snapshot?.sessionToken ?? null,
          placementVersion: snapshot?.placementVersion ?? null,
          lease,
          transforms: {
            blue: match.getTransform('blue'),
            red: match.getTransform('red'),
          },
          lastReady,
          lines: menuLines(page, acknowledged, leaving),
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
    acknowledged = false;
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
      if (disposed || leaving || page === 'ring') return false;
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
      acknowledged = false;
      armAssetTimeout();
      publish();
      return true;
    },
    ready() {
      const result = questReadyAcknowledgement(!disposed && match !== null && !leaving);
      lastReady = result;
      if (result.reason === 'acknowledged') acknowledged = true;
      publish();
      return result;
    },
    back() {
      if (disposed || leaving || page !== 'ring') return 'menu' as const;
      releaseMatch();
      publish();
      return 'menu' as const;
    },
    exit() {
      if (!disposed) {
        leaving = true;
        releaseMatch();
      }
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
