// Authoritative Quest VR combat SFX controller.
// Maps typed combat feedback events onto preloaded audio pools derived from the
// bundled combat sound assets (punch_01..03.wav), with distinct pitch/rate/gain
// staging, overlap pooling, cooldown anti-spam, pause/unfocus silencing, and
// resilient error handling.

import type {
  QuestCombatFeedbackEvent,
  QuestCombatFeedbackEventKind,
} from './quest-combat-feedback.ts';
import { QUEST_TUNING } from './quest-tuning.ts';

export type QuestSfxAssetKey = 'punch_01' | 'punch_02' | 'punch_03';

export interface QuestSfxPlayerPort {
  volume: number;
  playing: boolean;
  isLoaded?: boolean;
  duration?: number;
  addListener?(
    event: 'playbackStatusUpdate',
    listener: (status: { playing: boolean; error: string | null }) => void
  ): { remove(): void };
  setPlaybackRate?: (rate: number) => void;
  playbackRate?: number;
  play(): void;
  pause(): void;
  seekTo(seconds: number): Promise<void>;
  release(): void;
}

export interface QuestSfxPlanItem {
  clip: QuestSfxAssetKey;
  volume: number;
  rate: number;
}

export function planQuestCombatSfx(event: QuestCombatFeedbackEvent): QuestSfxPlanItem[] {
  switch (event.kind) {
    case 'PLAYER_LANDED_HIT':
      if (event.heavy || event.attackKind === 'uppercut') {
        return [{ clip: 'punch_03', volume: 0.94, rate: 0.92 }];
      }
      return [
        {
          clip: event.hand === 'L' ? 'punch_01' : 'punch_02',
          volume: event.counter ? 0.98 : 0.88,
          rate: event.counter ? 1.14 : 1.04,
        },
      ];
    case 'PLAYER_HIT_BLOCKED':
      return [{ clip: 'punch_02', volume: 0.56, rate: 1.38 }];
    case 'PLAYER_RECEIVED_HIT':
      return [
        {
          clip: 'punch_03',
          volume: event.heavy ? 1.0 : 0.9,
          rate: event.heavy ? 0.78 : 0.86,
        },
      ];
    case 'PLAYER_SUCCESSFUL_BLOCK':
      return [{ clip: 'punch_01', volume: 0.78, rate: 1.28 }];
    case 'SUCCESSFUL_DODGE':
      return [{ clip: 'punch_01', volume: 0.44, rate: 1.58 }];
    case 'GUARD_BREAK':
      return [{ clip: 'punch_02', volume: 0.9, rate: 0.66 }];
    case 'HEAVY_STAGGER':
      return [{ clip: 'punch_03', volume: 0.94, rate: event.defender === 'blue' ? 0.68 : 0.76 }];
  }
}

export class QuestCombatSfxController {
  private pools = new Map<QuestSfxAssetKey, QuestSfxPlayerPort[]>();
  private cursors = new Map<QuestSfxAssetKey, number>();
  private lastPlayedAt = new Map<QuestCombatFeedbackEventKind, number>();
  private lastClipPlayedAt = new Map<QuestSfxAssetKey, number>();
  private failedClips = new Set<QuestSfxAssetKey>();
  private startedClips = new Set<QuestSfxAssetKey>();
  private pending = new Set<QuestSfxPlayerPort>();
  private subscriptions: { remove(): void }[] = [];
  private generation = 0;
  private disposed = false;
  private enabled = true;
  private sfxVolume = 0.95;
  private lastError: string | null = null;
  private readonly now: () => number;
  private readonly onDiagnostic?: (message: string) => void;

  constructor(
    createPlayer: (clip: QuestSfxAssetKey) => QuestSfxPlayerPort,
    options: {
      poolSize?: number;
      now?: () => number;
      onDiagnostic?: (message: string) => void;
    } = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.onDiagnostic = options.onDiagnostic;
    const poolSize = Math.max(1, Math.min(4, options.poolSize ?? 3));
    const clips: QuestSfxAssetKey[] = ['punch_01', 'punch_02', 'punch_03'];

    for (const clip of clips) {
      const instances: QuestSfxPlayerPort[] = [];
      for (let i = 0; i < poolSize; i++) {
        try {
          const player = createPlayer(clip);
          instances.push(player);
          const subscription = player.addListener?.('playbackStatusUpdate', (status) => {
            if (this.disposed) return;
            if (status.error && this.lastError !== status.error) {
              this.lastError = status.error;
              this.onDiagnostic?.(`sfx native playback failed clip=${clip}: ${status.error}`);
            }
            if (status.playing && !this.startedClips.has(clip)) {
              this.startedClips.add(clip);
              this.onDiagnostic?.(`sfx native playback started clip=${clip}`);
            }
          });
          if (subscription) this.subscriptions.push(subscription);
        } catch (error) {
          this.failedClips.add(clip);
          this.lastError = error instanceof Error ? error.message : String(error);
          this.onDiagnostic?.(`sfx init failed clip=${clip}: ${this.lastError}`);
          break;
        }
      }
      this.pools.set(clip, instances);
      this.cursors.set(clip, 0);
    }
  }

  setState(options: { enabled: boolean; sfxVolume: number }) {
    this.enabled = options.enabled;
    this.sfxVolume = Number.isFinite(options.sfxVolume)
      ? Math.max(0, Math.min(1, options.sfxVolume))
      : 0.95;
    if (!this.enabled || this.sfxVolume <= 0) {
      this.silence();
    }
  }

  silence() {
    if (this.disposed) return;
    this.generation++;
    for (const pool of this.pools.values()) {
      for (const player of pool) {
        try {
          player.pause();
        } catch {
          // Ignore stop failures during lifecycle transitions.
        }
      }
    }
  }

  trigger(event: QuestCombatFeedbackEvent): boolean {
    if (this.disposed || !this.enabled || this.sfxVolume <= 0) return false;
    const t = this.now();
    const prev = this.lastPlayedAt.get(event.kind);
    if (prev !== undefined && t - prev < QUEST_TUNING.audio.minEventCooldownMs) {
      return false;
    }
    let triggeredAny = false;
    for (const step of planQuestCombatSfx(event)) {
      const prevClip = this.lastClipPlayedAt.get(step.clip);
      if (prevClip !== undefined && t - prevClip < QUEST_TUNING.audio.minEventCooldownMs) {
        continue;
      }
      const pool = this.pools.get(step.clip);
      if (!pool || pool.length === 0) continue;
      const cursor = this.cursors.get(step.clip) ?? 0;
      try {
        const player = [...pool.slice(cursor), ...pool.slice(0, cursor)].find(
          (candidate) =>
            !this.pending.has(candidate) &&
            !candidate.playing &&
            // Media3 reports isLoaded=false at end of stream, while duration remains known.
            (candidate.isLoaded !== false || (candidate.duration ?? 0) > 0)
        );
        if (!player) continue;
        this.cursors.set(step.clip, (pool.indexOf(player) + 1) % pool.length);
        player.volume = Math.max(0, Math.min(1, step.volume * this.sfxVolume));
        if (typeof player.setPlaybackRate === 'function') {
          player.setPlaybackRate(step.rate);
        } else if ('playbackRate' in player) {
          player.playbackRate = step.rate;
        }
        const generation = this.generation;
        const seek = player.seekTo(0);
        this.pending.add(player);
        void Promise.resolve(seek)
          .then(() => {
            if (this.disposed || !this.enabled || this.generation !== generation) return;
            player.volume = Math.max(0, Math.min(1, step.volume * this.sfxVolume));
            player.play();
          })
          .catch((error: unknown) => {
            this.lastError = error instanceof Error ? error.message : String(error);
            this.onDiagnostic?.(`sfx seek/play failed clip=${step.clip}: ${this.lastError}`);
          })
          .finally(() => this.pending.delete(player));
        this.lastClipPlayedAt.set(step.clip, t);
        triggeredAny = true;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.onDiagnostic?.(`sfx trigger failed clip=${step.clip}: ${this.lastError}`);
      }
    }
    if (triggeredAny) this.lastPlayedAt.set(event.kind, t);
    return triggeredAny;
  }

  getDiagnostics() {
    return {
      poolCounts: Object.fromEntries(
        [...this.pools.entries()].map(([k, v]) => [k, v.length])
      ) as Record<QuestSfxAssetKey, number>,
      failedClips: [...this.failedClips],
      lastError: this.lastError,
      enabled: this.enabled,
      sfxVolume: this.sfxVolume,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.silence();
    this.disposed = true;
    this.subscriptions.forEach((subscription) => subscription.remove());
    for (const pool of this.pools.values()) {
      for (const player of pool) {
        try {
          player.release();
        } catch {
          // Ignore teardown errors.
        }
      }
    }
    this.pools.clear();
  }
}
