import { requireOptionalNativeModule } from 'expo';

import {
  QUEST_MENU_TEXTURE,
  type QuestMenuDrawOp,
} from '../../../src/features/quest-vr/quest-menu-layout.ts';

export interface QuestMenuTextureResult {
  uri: string;
  width: number;
  height: number;
}

interface QuestMenuTextureNative {
  render(specJson: string): Promise<string>;
}

const native = requireOptionalNativeModule<QuestMenuTextureNative>('QuestMenuTexture');

export function questMenuTextureAvailable() {
  return native !== null;
}

export async function renderQuestMenuTexture(
  ops: QuestMenuDrawOp[],
  keep: string[] = []
): Promise<QuestMenuTextureResult | null> {
  if (!native) return null;
  const parsed = JSON.parse(
    await native.render(
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
  };
}
