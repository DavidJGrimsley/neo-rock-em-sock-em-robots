import type { ConfigContext, ExpoConfig } from 'expo/config';

// Permissions the fully virtual Quest runtime does not use. Phone builds keep them.
export const QUEST_BLOCKED_PERMISSIONS = [
  'android.permission.CAMERA',
  'android.permission.RECORD_AUDIO',
  'android.permission.NFC',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'horizonos.permission.USE_ANCHOR_API',
  'com.oculus.permission.USE_SCENE',
  'com.oculus.permission.BOUNDARY_VISIBILITY',
  'horizonos.permission.HAND_TRACKING',
  'horizonos.permission.HEADSET_CAMERA',
  'horizonos.permission.IMPORT_EXPORT_IOT_MAP_DATA',
];

// A single explicit toggle so phone builds never become Quest builds by accident.
export function isQuestBuild(env: Record<string, string | undefined> = process.env) {
  return env.QUEST_BUILD === '1';
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const apiKey = process.env.RV_API_KEY?.trim();
  const projectId = process.env.RV_PROJECT_ID?.trim();
  const configured = !!apiKey && !!projectId;
  const quest = isQuestBuild(process.env);
  const questAppId = process.env.META_QUEST_APP_ID?.trim();
  if (quest && questAppId && !/^\d+$/.test(questAppId))
    throw new Error('META_QUEST_APP_ID must be the numeric Meta Quest application ID.');
  // Native AR/audio SDKs reference microphone APIs, so Apple requires this purpose string.
  const microphonePermission = config.ios?.infoPlist?.NSMicrophoneUsageDescription;
  const replicationEndpoint = process.env.RV_REPLICATION_ENDPOINT?.trim();
  if (replicationEndpoint) {
    const url = new URL(replicationEndpoint);
    if (
      !['https:', 'wss:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error(
        'RV_REPLICATION_ENDPOINT must be a secure relay base URL without credentials, a path or query parameters.'
      );
  }
  return {
    ...config,
    name: config.name ?? "Neo Rock 'Em Sock 'Em Robots",
    slug: config.slug ?? 'neo-rock-em-sock-em-robots',
    plugins: [
      'expo-asset',
      [
        'expo-audio',
        { microphonePermission, recordAudioAndroid: false, enableBackgroundPlayback: false },
      ],
      ...(config.plugins ?? []).map((plugin) =>
        Array.isArray(plugin) && plugin[0] === '@reactvision/react-viro'
          ? ([
              plugin[0],
              {
                ...plugin[1],
                ...(quest
                  ? {
                      android: {
                        xRMode: ['QUEST'],
                        questSupportedDevices: 'quest3|quest3s',
                        questFeatures: {
                          colocation: false,
                          eyeTracking: false,
                          passthroughCamera: false,
                        },
                        ...(questAppId ? { questAppId } : {}),
                      },
                    }
                  : {}),
                provider: configured ? 'reactvision' : 'none',
                ...(configured ? { rvApiKey: apiKey, rvProjectId: projectId } : {}),
              },
            ] as [string, Record<string, unknown>])
          : plugin
      ),
      // Kept on Quest too: omitting it lets prebuild auto-apply expo-camera with audio recording.
      [
        'expo-camera',
        {
          cameraPermission: 'Scan an Arena Fighter room code to join your opponent.',
          microphonePermission,
          recordAudioAndroid: false,
        },
      ],
    ],
    ...(quest
      ? {
          android: {
            ...config.android,
            blockedPermissions: [
              ...(config.android?.blockedPermissions ?? []),
              ...QUEST_BLOCKED_PERMISSIONS,
            ],
          },
        }
      : {}),
    // ReactVision SDK credentials are client-visible, like the native Info.plist values.
    extra: {
      ...config.extra,
      arenaMultiplayer: configured ? { apiKey, projectId, replicationEndpoint } : undefined,
    },
  };
};
