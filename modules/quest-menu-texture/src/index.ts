import { requireOptionalNativeModule } from 'expo';

import {
  QUEST_MENU_TEXTURE,
  type QuestMenuDrawOp,
} from '../../../src/features/quest-vr/quest-menu-layout.ts';

export interface QuestMenuTextureResult {
  uri: string;
  width: number;
  height: number;
  /** #AARRGGBB at the centre, the first button row, and the top-left corner. */
  probe: string[];
}

export interface QuestMenuMaterialResult {
  name: string;
  width: number;
  height: number;
  ms: number;
}

interface QuestMenuTextureNative {
  render(specJson: string): Promise<string>;
  prepareMaterial(name: string, uri: string): Promise<string>;
  releaseMaterials(names: string[], uris: string[]): Promise<number>;
}

const native = requireOptionalNativeModule<QuestMenuTextureNative>('QuestMenuTexture');

export function questMenuTextureAvailable() {
  return native !== null;
}

function requireNative() {
  if (!native) throw new Error('Menu texture module is unavailable.');
  return native;
}

/** Draws the panel PNG. Panel files not listed in keep are deleted. */
export async function renderQuestMenuTexture(
  ops: QuestMenuDrawOp[],
  keep: string[] = []
): Promise<QuestMenuTextureResult> {
  const parsed = JSON.parse(
    await requireNative().render(
      JSON.stringify({
        width: QUEST_MENU_TEXTURE.widthPx,
        height: QUEST_MENU_TEXTURE.heightPx,
        ops,
        keep,
      })
    )
  ) as Partial<QuestMenuTextureResult>;
  if (typeof parsed.uri !== 'string' || !parsed.uri.startsWith('file:'))
    throw new Error('Menu texture did not return a file URI.');
  return {
    uri: parsed.uri,
    width: typeof parsed.width === 'number' ? parsed.width : QUEST_MENU_TEXTURE.widthPx,
    height: typeof parsed.height === 'number' ? parsed.height : QUEST_MENU_TEXTURE.heightPx,
    probe: Array.isArray(parsed.probe) ? parsed.probe.map(String) : [],
  };
}

/**
 * Registers a Viro material for the PNG and resolves only after Viro holds a
 * texture of the PNG's size. Rejects instead of leaving a white default.
 */
export async function prepareQuestMenuMaterial(
  name: string,
  uri: string
): Promise<QuestMenuMaterialResult> {
  const parsed = JSON.parse(
    await requireNative().prepareMaterial(name, uri)
  ) as Partial<QuestMenuMaterialResult>;
  if (parsed.name !== name || typeof parsed.width !== 'number' || typeof parsed.height !== 'number')
    throw new Error(`Viro material ${name} did not report a texture.`);
  return {
    name,
    width: parsed.width,
    height: parsed.height,
    ms: typeof parsed.ms === 'number' ? parsed.ms : -1,
  };
}

/** Deletes Viro materials and their panel files. Mounted quads keep their copy. */
export async function releaseQuestMenuMaterials(names: string[], uris: string[]) {
  if (names.length === 0 && uris.length === 0) return 0;
  return requireNative().releaseMaterials(names, uris);
}
