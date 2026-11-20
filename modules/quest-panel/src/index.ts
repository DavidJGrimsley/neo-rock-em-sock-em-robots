import { requireOptionalNativeModule } from 'expo';

// JS side of modules/quest-panel (Android only). The spec is JSON so one
// synchronous call hands it to the draw worker; see quest-menu-compositor.ts.
export interface QuestPanelNative {
  isAvailable(): boolean;
  /** Hides any earlier panel and returns a new owner token. */
  open(): number;
  /** 1 submitted, 0 not yet drawn or hidden, -1 failed or a stale owner. */
  status(owner: number): number;
  draw(owner: number, specJson: string): void;
  hide(owner: number): void;
}

const native = requireOptionalNativeModule<QuestPanelNative>('QuestPanel');

/** Null when the module is not linked, for example outside Android. */
export const questPanelNative: QuestPanelNative | null = native;

/** True only with the patched renderer that carries the menu layer (0002). */
export function questPanelAvailable(): boolean {
  try {
    return native?.isAvailable() ?? false;
  } catch {
    return false;
  }
}
