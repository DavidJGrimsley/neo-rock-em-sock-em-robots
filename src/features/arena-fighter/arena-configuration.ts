import Constants from 'expo-constants';

export interface ArenaConfiguration {
  apiKey: string;
  projectId: string;
  replicationEndpoint?: string;
}
export function arenaConfiguration(): ArenaConfiguration | null {
  const config = Constants.expoConfig?.extra?.arenaMultiplayer;
  return config &&
    typeof config.apiKey === 'string' &&
    config.apiKey &&
    typeof config.projectId === 'string' &&
    config.projectId.trim() &&
    config.apiKey.trim()
    ? {
        apiKey: config.apiKey.trim(),
        projectId: config.projectId.trim(),
        replicationEndpoint: config.replicationEndpoint,
      }
    : null;
}
