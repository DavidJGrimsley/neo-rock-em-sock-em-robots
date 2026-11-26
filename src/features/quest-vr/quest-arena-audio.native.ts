import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { Asset } from 'expo-asset';
import { createAudioPlayer } from 'expo-audio';
import type { ArenaMatch } from '../arena-fighter/arena-match.ts';
import { useArenaAudio } from '../arena-fighter/use-arena-audio.native.ts';
import type { QuestArenaSession } from './quest-arena-session.ts';
import { QuestCombatSfxController, type QuestSfxAssetKey } from './quest-arena-audio.ts';
import type { QuestUserSettings } from './quest-tuning.ts';

const SFX_SOURCES: Record<QuestSfxAssetKey, number> = {
  punch_01: require('../../../assets/arena/sounds/punch_01.wav'),
  punch_02: require('../../../assets/arena/sounds/punch_02.wav'),
  punch_03: require('../../../assets/arena/sounds/punch_03.wav'),
};

/**
 * Mounts match music/announcer audio (`useArenaAudio`) AND a pooled combat SFX
 * controller for Quest VR, keeping audio safe across pause, focus loss, and teardown.
 */
export function useQuestArenaAudio(
  session: QuestArenaSession,
  match: ArenaMatch | null,
  active: boolean,
  titleVisible: boolean,
  settings?: QuestUserSettings
) {
  const audioEnabled = settings?.audioEnabled ?? true;
  const musicVolume = settings?.musicVolume ?? 0.32;
  const sfxVolume = settings?.sfxVolume ?? 0.95;
  useArenaAudio(
    audioEnabled ? match : null,
    audioEnabled && active,
    audioEnabled && titleVisible,
    musicVolume
  );

  const sfxRef = useRef<QuestCombatSfxController | null>(null);
  const disposalRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stateRef = useRef({
    enabled: audioEnabled && active,
    sfxVolume,
  });

  useEffect(() => {
    let mounted = true;
    clearTimeout(disposalRef.current);

    if (!sfxRef.current) {
      const keys = Object.keys(SFX_SOURCES) as QuestSfxAssetKey[];
      void Asset.loadAsync(keys.map((key) => SFX_SOURCES[key]))
        .then((assets) => {
          if (!mounted) return;
          const uris = new Map<QuestSfxAssetKey, string>();
          keys.forEach((key, index) => {
            const uri = assets[index]?.localUri ?? assets[index]?.uri;
            if (uri) uris.set(key, uri);
          });
          const controller = new QuestCombatSfxController(
            (clip) => {
              const uri = uris.get(clip);
              if (!uri) throw new Error(`Missing URI for ${clip}`);
              return createAudioPlayer(uri, { updateInterval: 50, keepAudioSessionActive: true });
            },
            {
              poolSize: 3,
              onDiagnostic: (msg) => console.warn(`[QuestAudio] ${msg}`),
            }
          );
          controller.setState({
            enabled: stateRef.current.enabled && AppState.currentState === 'active',
            sfxVolume: stateRef.current.sfxVolume,
          });
          sfxRef.current = controller;
          const diag = controller.getDiagnostics();
          console.warn(
            `[QuestAudio] initialized pools=${JSON.stringify(diag.poolCounts)} failed=${diag.failedClips.join(',') || 'none'}`
          );
        })
        .catch((error: unknown) => {
          console.warn(
            `[QuestAudio] init failed (continuing silent): ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
    }

    const stopFeedback =
      session.onCombatFeedback?.((event) => {
        sfxRef.current?.trigger(event);
      }) ?? (() => {});
    const appSub = AppState.addEventListener('change', (nextState) => {
      sfxRef.current?.setState({
        enabled: stateRef.current.enabled && nextState === 'active',
        sfxVolume: stateRef.current.sfxVolume,
      });
    });

    return () => {
      mounted = false;
      sfxRef.current?.setState({ enabled: false, sfxVolume: stateRef.current.sfxVolume });
      stopFeedback();
      appSub.remove();
      disposalRef.current = setTimeout(() => {
        sfxRef.current?.dispose();
        sfxRef.current = null;
      }, 0);
    };
  }, [session]);

  useEffect(() => {
    const baseEnabled = audioEnabled && active;
    stateRef.current = { enabled: baseEnabled, sfxVolume };
    sfxRef.current?.setState({
      enabled: baseEnabled && AppState.currentState === 'active',
      sfxVolume,
    });
  }, [active, audioEnabled, sfxVolume]);
}
