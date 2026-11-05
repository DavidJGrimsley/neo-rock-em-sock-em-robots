import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const apiKey = process.env.RV_API_KEY?.trim();
  const projectId = process.env.RV_PROJECT_ID?.trim();
  const configured = !!apiKey && !!projectId;
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
                provider: configured ? 'reactvision' : 'none',
                ...(configured ? { rvApiKey: apiKey, rvProjectId: projectId } : {}),
              },
            ] as [string, Record<string, unknown>])
          : plugin
      ),
      [
        'expo-camera',
        {
          cameraPermission: 'Scan an Arena Fighter room code to join your opponent.',
          microphonePermission,
          recordAudioAndroid: false,
        },
      ],
    ],
    // ReactVision SDK credentials are client-visible, like the native Info.plist values.
    extra: {
      ...config.extra,
      arenaMultiplayer: configured ? { apiKey, projectId, replicationEndpoint } : undefined,
    },
  };
};
