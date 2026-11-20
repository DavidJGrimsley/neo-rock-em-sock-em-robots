// Launcher choice between the headset menu layer and Viro-drawn buttons, like
// the Medical Viewer "Headset layer / Original controls" switch. Module state:
// the launcher panel and VRActivity share one JS runtime. A scene reads it when
// it mounts, so a change applies on the next Enter VR.

export type QuestMenuLayerChoice = 'compositor' | 'viro';

let choice: QuestMenuLayerChoice = 'compositor';
const listeners = new Set<() => void>();

export const questMenuLayer = {
  get: () => choice,
  set(next: QuestMenuLayerChoice) {
    if (next === choice) return;
    choice = next;
    for (const listener of listeners) listener();
  },
  toggle() {
    questMenuLayer.set(choice === 'compositor' ? 'viro' : 'compositor');
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
