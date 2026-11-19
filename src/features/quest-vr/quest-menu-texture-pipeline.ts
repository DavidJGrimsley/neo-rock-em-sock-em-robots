// Turns menu specs into Viro materials one at a time and decides what the
// panel may show. A spec is drawn to a PNG, registered as a Viro material, and
// shown only after Viro reports a texture for it. Art, pose, and hit targets
// all follow the shown screen (page plus Ready acknowledgement). While the
// requested screen has no art yet, the old art stays up and input is off.
//
// Lifetimes: at most the shown material, the one before it, and one in flight
// are registered. Their PNG files are kept because Viro re-reads every
// registered material's file when a scene navigator detaches. Anything else
// is released, including results that arrive after a timeout or dispose.

import {
  questMenuMaterialName,
  type QuestMenuDrawOp,
  type QuestMenuPage,
} from './quest-menu-layout.ts';

export const QUEST_MENU_TEXTURE_TIMEOUT_MS = 15_000;

export interface QuestMenuScreen {
  page: QuestMenuPage;
  acknowledged: boolean;
}

export interface QuestMenuTextureSpec extends QuestMenuScreen {
  key: string;
  ops: QuestMenuDrawOp[];
}

export interface QuestMenuArt extends QuestMenuScreen {
  key: string;
  uri: string;
  material: string;
}

export interface QuestMenuTextureError extends QuestMenuScreen {
  key: string;
  message: string;
}

export interface QuestMenuTextureSnapshot {
  shown: QuestMenuArt | null;
  error: QuestMenuTextureError | null;
  busy: boolean;
}

export interface QuestMenuTextureBackend {
  render(
    ops: QuestMenuDrawOp[],
    keep: string[]
  ): Promise<{ uri: string; width: number; height: number; probe: string[] }>;
  prepare(name: string, uri: string): Promise<{ width: number; height: number; ms: number }>;
  release(names: string[], uris: string[]): Promise<unknown>;
  log(level: 'info' | 'error', message: string): void;
}

interface Clock {
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
}

const defaultClock: Clock = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function sameMenuScreen(a: QuestMenuScreen, b: QuestMenuScreen) {
  return a.page === b.page && a.acknowledged === b.acknowledged;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createQuestMenuTexturePipeline(
  backend: QuestMenuTextureBackend,
  options: { clock?: Clock; timeoutMs?: number } = {}
) {
  const clock = options.clock ?? defaultClock;
  const timeoutMs = options.timeoutMs ?? QUEST_MENU_TEXTURE_TIMEOUT_MS;
  let shown: QuestMenuArt | null = null;
  let previous: QuestMenuArt | null = null;
  let error: QuestMenuTextureError | null = null;
  let latest: QuestMenuTextureSpec | null = null;
  let running: string | null = null;
  let disposed = false;
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  let snapshot: QuestMenuTextureSnapshot = { shown, error, busy: false };

  const emit = () => {
    snapshot = { shown, error, busy: running !== null };
    for (const listener of listeners) listener();
  };

  const release = (names: string[], uris: string[]) => {
    if (names.length === 0 && uris.length === 0) return;
    backend.release(names, uris).then(
      () => backend.log('info', `released ${names.join(',') || 'no materials'}`),
      (failure: unknown) => backend.log('error', `release failed: ${describe(failure)}`)
    );
  };

  const releaseArt = (art: QuestMenuArt | null) => {
    if (art) release([art.material], [art.uri]);
  };

  const keep = () =>
    [shown?.uri, previous?.uri, ...inFlight].filter((uri): uri is string => Boolean(uri));

  // Rejects after the timeout. A late result is handed to onLate so it is
  // released instead of leaking a registered material or a kept file.
  const bounded = <T>(work: Promise<T>, label: string, onLate: (value: T) => void) =>
    new Promise<T>((resolve, reject) => {
      let settled = false;
      const handle = clock.schedule(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${label} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      work.then(
        (value) => {
          if (settled) return onLate(value);
          settled = true;
          clock.cancel(handle);
          resolve(value);
        },
        (failure: unknown) => {
          if (settled) return;
          settled = true;
          clock.cancel(handle);
          reject(failure);
        }
      );
    });

  const run = async (spec: QuestMenuTextureSpec) => {
    running = spec.key;
    emit();
    let uri: string | null = null;
    let art: QuestMenuArt | null = null;
    let failure: string | null = null;
    try {
      const drawn = await bounded(backend.render(spec.ops, keep()), 'Menu drawing', (late) =>
        release([], [late.uri])
      );
      uri = drawn.uri;
      inFlight.add(uri);
      backend.log(
        'info',
        `drawn ${spec.page} ${drawn.width}x${drawn.height} probe ${drawn.probe.join(',')} ${uri}`
      );
      const material = questMenuMaterialName(uri);
      const lateUri = uri;
      const prepared = await bounded(backend.prepare(material, uri), 'Viro material', () =>
        release([material], [lateUri])
      );
      backend.log(
        'info',
        `material ${material} ${prepared.width}x${prepared.height} in ${prepared.ms} ms`
      );
      art = { key: spec.key, page: spec.page, acknowledged: spec.acknowledged, uri, material };
    } catch (caught) {
      failure = describe(caught);
      // A rejected prepare deletes its own material. The file is ours to delete.
      if (uri) release([], [uri]);
    }
    if (uri) inFlight.delete(uri);
    running = null;

    if (disposed) {
      releaseArt(art);
      return;
    }
    if (art) {
      if (latest && !sameMenuScreen(latest, art)) {
        // The player moved to another screen while this one was drawn.
        releaseArt(art);
      } else {
        releaseArt(previous);
        previous = shown;
        shown = art;
        if (error && sameMenuScreen(error, art)) error = null;
        backend.log('info', `shown ${art.page} ${art.material}`);
      }
    } else if (failure !== null) {
      backend.log('error', `${spec.page} failed: ${failure}`);
      if (latest && sameMenuScreen(latest, spec)) {
        error = {
          key: spec.key,
          page: spec.page,
          acknowledged: spec.acknowledged,
          message: failure,
        };
      }
    }
    // Draw the newest request next. A failed key is not retried until it changes.
    if (latest && latest.key !== spec.key && latest.key !== shown?.key) {
      void run(latest);
      return;
    }
    emit();
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    request(spec: QuestMenuTextureSpec) {
      if (disposed) return;
      latest = spec;
      if (running !== null || shown?.key === spec.key) return;
      void run(spec);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseArt(shown);
      releaseArt(previous);
      shown = null;
      previous = null;
      listeners.clear();
    },
  };
}

export type QuestMenuTexturePipeline = ReturnType<typeof createQuestMenuTexturePipeline>;

export type QuestMenuDisplay =
  | (QuestMenuScreen & { kind: 'art'; material: string; input: boolean })
  | (QuestMenuScreen & { kind: 'error'; message: string; input: true })
  | (QuestMenuScreen & { kind: 'loading'; input: false });

/**
 * What the panel shows for the requested screen. Art for another screen stays
 * up during a transition with input off, so pose, art, and hit targets never
 * disagree. A failure for the requested screen is shown as an error panel with
 * working buttons rather than Viro's white default.
 */
export function questMenuDisplay(
  view: QuestMenuScreen,
  state: QuestMenuTextureSnapshot
): QuestMenuDisplay {
  const { shown, error } = state;
  if (shown && sameMenuScreen(shown, view))
    return {
      kind: 'art',
      page: shown.page,
      acknowledged: shown.acknowledged,
      material: shown.material,
      input: true,
    };
  if (error && sameMenuScreen(error, view))
    return {
      kind: 'error',
      page: view.page,
      acknowledged: view.acknowledged,
      message: error.message,
      input: true,
    };
  if (shown)
    return {
      kind: 'art',
      page: shown.page,
      acknowledged: shown.acknowledged,
      material: shown.material,
      input: false,
    };
  return { kind: 'loading', page: view.page, acknowledged: view.acknowledged, input: false };
}

/** Press and hover state is reset whenever this changes. */
export function questMenuInputKey(display: QuestMenuDisplay) {
  return `${display.kind}:${display.page}:${display.acknowledged}:${display.input}`;
}
