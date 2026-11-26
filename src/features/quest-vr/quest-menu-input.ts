// Quest controller sources from ViroOculus. Head gaze is 12 and is processed
// after both hands, so it must not move the menu highlight or fire an action.
// Grip, face buttons, and the controller Back button are not menu triggers.
// The sampled left Menu edge pauses the match outside this filter.

export const QUEST_TRIGGER_SOURCES = [1, 4] as const;
const CLICK_DOWN = 1;
const CLICK_UP = 2;

export interface QuestPressState {
  down: Set<number>;
}

export function questTriggerSource(source: unknown): 1 | 4 | null {
  const value = typeof source === 'number' ? source : Number.NaN;
  if (value === 1 || value === 4) return value;
  return null;
}

/** One activation per trigger press. Repeated down, click-up, and CLICKED do not activate. */
export function questTriggerPress(
  state: QuestPressState,
  clickState: number,
  source: unknown
): 'activate' | 'release' | 'ignore' {
  const trigger = questTriggerSource(source);
  if (trigger === null) return 'ignore';
  if (clickState === CLICK_DOWN) {
    if (state.down.has(trigger)) return 'ignore';
    state.down.add(trigger);
    return 'activate';
  }
  if (clickState === CLICK_UP) {
    state.down.delete(trigger);
    return 'release';
  }
  return 'ignore';
}

/** Hover follows trigger rays only. A gaze enter or leave does not change the set. */
export function questPointerHover(sources: Set<number>, hovering: boolean, source: unknown) {
  const trigger = questTriggerSource(source);
  if (trigger !== null) {
    if (hovering) sources.add(trigger);
    else sources.delete(trigger);
  }
  return sources.size > 0;
}
