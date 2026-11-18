// Pure so phone screens and tests can ask without loading @reactvision/react-viro.
type AndroidBuildInfo = { Manufacturer?: unknown; Brand?: unknown; Model?: unknown };
export type PlatformLike = { OS?: string; constants?: unknown } | null | undefined;

const lower = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : '');

// Mirrors Viro 3.0.3's isQuest: Android build branding, not the presence of the OpenXR module.
export function isQuestDevice(platform: PlatformLike): boolean {
  if (platform?.OS !== 'android') return false;
  const constants = (platform.constants ?? {}) as AndroidBuildInfo;
  const manufacturer = lower(constants.Manufacturer);
  const brand = lower(constants.Brand);
  return (
    ['oculus', 'meta'].includes(manufacturer) ||
    ['oculus', 'meta'].includes(brand) ||
    /\bquest\b/.test(lower(constants.Model))
  );
}

export const questExperience = {
  route: 'quest-vr',
  href: '/quest-vr',
  title: 'Quest VR Runtime',
} as const;
