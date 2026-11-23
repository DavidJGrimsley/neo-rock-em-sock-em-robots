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
  invalidate?(owner: number): void;
  hide(owner: number): void;
  /** Floating transparent branded title overlay slot. */
  openTitle?(): number;
  statusTitle?(owner: number): number;
  drawTitle?(owner: number, specJson: string): void;
  invalidateTitle?(owner: number): void;
  hideTitle?(owner: number): void;
  /** Monotonic count of Horizon LOCAL reference-space resets observed by OpenXR. */
  refSpaceEpoch?(): number;
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
