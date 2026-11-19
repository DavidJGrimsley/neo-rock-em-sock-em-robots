// Release Android images are not files. expo-asset marks an embedded drawable as
// downloaded and sets localUri to the resource name (no scheme), because React
// Native Image accepts that name. BitmapFactory.decodeFile and
// Typeface.createFromFile do not. file:///android_res/ is the same kind of
// resource. Only a real file URI can be drawn into the menu PNG.

export interface QuestMenuAssetRef {
  uri: string;
  localUri?: string | null;
  hash?: string | null;
  type?: string | null;
}

export function questMenuFileUri(uri: string | null | undefined): string | null {
  if (!uri || !uri.startsWith('file:')) return null;
  if (uri.startsWith('file:///android_res/')) return null;
  return uri;
}

export async function resolveQuestMenuAssetFile(
  asset: QuestMenuAssetRef,
  copyPackagedAsset: (uri: string, hash: string | null, type: string) => Promise<string>
): Promise<string> {
  const ready = questMenuFileUri(asset.localUri) ?? questMenuFileUri(asset.uri);
  if (ready) return ready;
  const source = asset.uri;
  if (!source) throw new Error('Menu asset has no URI.');
  const copied = await copyPackagedAsset(source, asset.hash ?? null, asset.type ?? 'bin');
  const file = questMenuFileUri(copied);
  if (!file) throw new Error(`Menu asset did not copy to a file: ${copied}`);
  return file;
}
