import { Platform } from 'react-native';

import { isQuestDevice } from './quest-platform';
import { questRuntime } from './quest-runtime-store';

let bootstrapped = false;

/**
 * Registers VRQuestScene and seeds its default Arena intent at startup on Quest so
 * Android process restoration into VRActivity renders the main menu instead of an empty root.
 */
export function ensureQuestVRRegistered(): void {
  if (bootstrapped || !isQuestDevice(Platform)) return;
  bootstrapped = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const navigator = require('./quest-xr-navigator.native') as {
      registerQuestVRScene?: () => void;
    };
    navigator.registerQuestVRScene?.();
  } catch (error) {
    questRuntime.fail(error);
  }
}
