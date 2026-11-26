// Unified authoritative combat feedback stream for Quest VR.
// Consumes ArenaMatch impact / block / dodge transitions once per authoritative
// event so audio, OpenXR haptics, HUD banners, and peripheral damage tint never
// double-fire or contradict (for example, HIT + BLOCKED from one collision).

export type QuestCombatFeedbackEventKind =
  | 'PLAYER_LANDED_HIT'
  | 'PLAYER_HIT_BLOCKED'
  | 'PLAYER_RECEIVED_HIT'
  | 'PLAYER_SUCCESSFUL_BLOCK'
  | 'SUCCESSFUL_DODGE'
  | 'GUARD_BREAK'
  | 'HEAVY_STAGGER';

export interface QuestCombatFeedbackEvent {
  id: number;
  kind: QuestCombatFeedbackEventKind;
  timeSeconds: number;
  attacker: 'blue' | 'red';
  defender: 'blue' | 'red';
  hand: 'L' | 'R' | null;
  attackKind: 'punch' | 'uppercut' | 'dodge';
  heavy: boolean;
  counter: boolean;
  damage: number;
  staggerDuration: number;
  clip: string | null;
}

export interface QuestCombatImpactRecord {
  id: number;
  defender: 'blue' | 'red';
  kind: 'punch' | 'uppercut';
  hand: 'L' | 'R';
  outcome: 'hit' | 'blocked' | 'guard-break';
  heavy?: boolean;
  counter?: boolean;
  damage?: number;
  staggerDuration?: number;
  clip?: string | null;
  x: number;
  y: number;
  z: number;
}

export interface QuestCombatEvadeRecord {
  id: number;
  defender: 'blue' | 'red';
  attacker: 'blue' | 'red';
  kind: 'punch' | 'uppercut';
  hand: 'L' | 'R';
}

export class QuestCombatFeedbackStream {
  private sequence = 0;
  private seenImpactIds = new Set<number>();
  private seenEvadeIds = new Set<number>();

  reset() {
    this.seenImpactIds.clear();
    this.seenEvadeIds.clear();
  }

  /**
   * Maps newly observed authoritative impacts and evades into typed combat
   * feedback events. Each impact id or evade id can emit at most once, ensuring
   * a single blocked strike cannot emit both HIT and BLOCKED.
   */
  ingest(
    timeSeconds: number,
    impacts: readonly QuestCombatImpactRecord[],
    evades: readonly QuestCombatEvadeRecord[]
  ): QuestCombatFeedbackEvent[] {
    const out: QuestCombatFeedbackEvent[] = [];

    for (const impact of impacts) {
      if (this.seenImpactIds.has(impact.id)) continue;
      this.seenImpactIds.add(impact.id);
      if (this.seenImpactIds.size > 256) {
        const oldest = this.seenImpactIds.values().next().value;
        if (oldest !== undefined) this.seenImpactIds.delete(oldest);
      }

      const defender = impact.defender;
      const attacker = defender === 'blue' ? 'red' : 'blue';
      const heavy = Boolean(impact.heavy || impact.kind === 'uppercut');
      const staggerDuration = impact.staggerDuration ?? 0;

      if (impact.outcome === 'guard-break') {
        out.push({
          id: ++this.sequence,
          kind: 'GUARD_BREAK',
          timeSeconds,
          attacker,
          defender,
          hand: impact.hand,
          attackKind: impact.kind,
          heavy: true,
          counter: Boolean(impact.counter),
          damage: impact.damage ?? 0,
          staggerDuration,
          clip: impact.clip ?? null,
        });
        continue;
      }

      if (impact.outcome === 'blocked') {
        out.push({
          id: ++this.sequence,
          kind: defender === 'red' ? 'PLAYER_HIT_BLOCKED' : 'PLAYER_SUCCESSFUL_BLOCK',
          timeSeconds,
          attacker,
          defender,
          hand: impact.hand,
          attackKind: impact.kind,
          heavy: false,
          counter: false,
          damage: 0,
          staggerDuration,
          clip: impact.clip ?? null,
        });
        continue;
      }

      // Clean hit landed or received.
      const primaryKind: QuestCombatFeedbackEventKind =
        impact.heavy && impact.staggerDuration
          ? 'HEAVY_STAGGER'
          : defender === 'red'
            ? 'PLAYER_LANDED_HIT'
            : 'PLAYER_RECEIVED_HIT';
      out.push({
        id: ++this.sequence,
        kind: primaryKind,
        timeSeconds,
        attacker,
        defender,
        hand: impact.hand,
        attackKind: impact.kind,
        heavy,
        counter: Boolean(impact.counter),
        damage: impact.damage ?? 0,
        staggerDuration,
        clip: impact.clip ?? null,
      });
    }

    for (const evade of evades) {
      if (evade.defender !== 'blue') continue;
      if (this.seenEvadeIds.has(evade.id)) continue;
      this.seenEvadeIds.add(evade.id);
      if (this.seenEvadeIds.size > 128) {
        const oldest = this.seenEvadeIds.values().next().value;
        if (oldest !== undefined) this.seenEvadeIds.delete(oldest);
      }
      out.push({
        id: ++this.sequence,
        kind: 'SUCCESSFUL_DODGE',
        timeSeconds,
        attacker: evade.attacker,
        defender: evade.defender,
        hand: evade.hand,
        attackKind: 'dodge',
        heavy: false,
        counter: false,
        damage: 0,
        staggerDuration: 0,
        clip: null,
      });
    }

    return out;
  }
}
