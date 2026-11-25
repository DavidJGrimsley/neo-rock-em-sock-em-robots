import exportedManifest from '../../../assets/arena/fighter-animation-manifest.json' with { type: 'json' };
import combatManifest from '../../../assets/arena/combat-animation-manifest.json' with { type: 'json' };
import {
  canFighterAttack,
  canFighterBeHit,
  launchLift,
  hopLift,
  settlingLift,
  distance,
  facing,
  forward,
  inCone,
  pathTravel,
  type ArenaPoint,
} from './arena-combat-motion.ts';
import { sweptContact, type ContactPose } from './arena-contact.ts';
import { arenaLinearMovement, arenaMovement } from './arena-movement.ts';

// The manifest is the exported motion contract, not executable Unreal montage logic.
interface AnimationManifest {
  clips: { name: string; durationSeconds: number; loopRecommended: boolean }[];
  combo: { clip: string; durationSeconds: number; hitCheckSeconds: number }[];
}
const manifest: AnimationManifest = {
  ...exportedManifest,
  clips: [...exportedManifest.clips, ...combatManifest.clips],
};

export type FighterId = 'blue' | 'red';
export type AttackKind = 'punch' | 'uppercut';
export type Movement = 'advance' | 'strafeLeft' | 'strafeRight';
export interface AnalogMovement {
  advance: number;
  strafe: number;
}
export interface HeadEvasionInput {
  duck: boolean;
  weave: boolean;
  outOfBounds?: boolean;
}
/**
 * Hook for future general dash stamina (Stage 06+).
 * Stage 05 keeps `dashStaminaCost = 0`; `guardStamina` belongs exclusively to blocking and is never charged here.
 */
export interface DashStaminaHook {
  canAfford?: (fighter: FighterId, cost: number) => boolean;
  spend?: (fighter: FighterId, cost: number) => void;
}
export type CombatCommand = AttackKind | 'block-down' | 'block-up' | 'jump-back';
export type GuardState = 'off' | 'raising' | 'holding' | 'lowering' | 'exhausted';
export type ArenaPhase = 'setup' | 'fighting' | 'paused' | 'ending' | 'ended';
export type FighterMode =
  | 'idle'
  | 'walk'
  | 'attack'
  | 'hit'
  | 'launch'
  | 'landing'
  | 'defeat'
  | 'defeated'
  | 'victory'
  | 'guard'
  | 'guard-exit'
  | 'guard-break'
  | 'hop'
  | 'settling';
export type ArenaAsset = 'arena' | 'blue' | 'red';

const arenaHorizontalScale = 1.25;

export const ARENA_RULES = {
  health: 100,
  punchDamage: 8,
  uppercutDamage: 15,
  punchStringLength: 3,
  uppercutWindow: 0.45,
  punchDefenseLock: 0.2,
  counterpunchRecovery: 0.35,
  counterpunchBuffer: 0.15,
  punchRest: 0.6,
  punchActiveEnd: 0.367,
  uppercutActiveEnd: 0.547,
  contactTolerance: 0.001,
  uppercutReach: 0.06,
  uppercutLunge: 0.03,
  uppercutStepStart: 0.1,
  uppercutStepEnd: 0.4,
  punchHitstop: 0.035,
  uppercutHitstop: 0.07,
  blockHitstop: 0.02,
  punchCone: 20,
  uppercutCone: 30,
  guardStartup: 0.1,
  guardExit: 0.1,
  guardSpeed: 0.4,
  guardCapacity: 100,
  guardDrain: 15,
  guardPunchCost: 30,
  guardRegen: 35,
  guardRegenDelay: 0.6,
  guardMinimum: 25,
  guardRecovery: 0.65,
  guardCone: 90,
  hopTravel: 0.06,
  hopMinimum: 0.01,
  hopHeight: 0.025,
  hopPreparation: 2 / 30,
  hopFlight: 8 / 30,
  hopDuration: 0.4,
  hopRecovery: 0.25,
  dashEnabled: false,
  dashTravel: 0.06,
  dashMinimum: 0.01,
  dashDuration: 0.24,
  dashRecovery: 0.25,
  dashStaminaCost: 0,
  headEvasionEnabled: false,
  evadeDuration: 0.75,
  evadeCooldown: 0.35,
  settleDuration: 0.1,
  cpuGuardReaction: 0.15,
  spawn: 0.095,
  boundary: 0.14 * arenaHorizontalScale,
  separation: 0.055,
  reach: 0.085,
  speed: 0.08,
  stableTracking: 0.5,
  cpuFirstDelay: 0.5,
  cpuRecovery: 0.4,
  cpuReaction: 0.27,
  cpuRangeMargin: 0.004,
  cpuPreferredRange: 0.07,
  cpuMinimumRange: 0.06,
  cpuRewardReaction: 0.2,
  launchDuration: 0.8,
  launchHeight: 0.18,
  victoryRepeats: 2,
  cpuEnabled: true,
  stableFacing: false,
};

// GLB already rotates its source mesh into Y-up. Its base is at Y=-0.14273847.
// Largest horizontal span=1.139190018m; the fighting floor is at about Y=-0.027.
// Enlarge only X/Z from 60cm to 75cm, preserving the base and fighting floor height.
export const ARENA_LAYOUT = {
  arenaScale: 0.6 / 1.1391900181770325,
  arenaHorizontalScale,
  arenaBaseOffset: 0.14273847315734003 * (0.6 / 1.1391900181770325),
  floorHeight: (0.14273847315734003 - 0.027) * (0.6 / 1.1391900181770325),
  fighterScale: 0.12 / 1.59857170559,
  footOffset: 0.00106792559 * (0.12 / 1.59857170559),
};

export const ARENA_CLIPS = manifest.clips.map((clip) => clip.name);
const clipDuration = (name: string) => {
  const clip = manifest.clips.find((candidate) => candidate.name === name);
  if (!clip) throw new Error(`Missing fighter clip: ${name}`);
  return clip.durationSeconds;
};
const ids: FighterId[] = ['blue', 'red'];
const epsilon = 1e-7;
const attackTimings = new Map(manifest.combo.map((entry) => [entry.clip, entry]));
function attackTiming(clip: string) {
  const timing = attackTimings.get(clip);
  if (!timing) throw new Error(`Missing fighter attack timing: ${clip}`);
  return timing;
}

interface Attack {
  kind: AttackKind;
  elapsed: number;
  duration: number;
  hitAt: number;
  hitChecked: boolean;
  hand: 'L' | 'R';
  step: number;
  direction: ArenaPoint;
}
export interface ArenaImpact {
  id: number;
  kind: AttackKind;
  hand: 'L' | 'R';
  x: number;
  z: number;
  y: number;
  outcome: 'hit' | 'blocked' | 'guard-break';
}
interface Fighter {
  health: number;
  x: number;
  z: number;
  yaw: number;
  lift: number;
  mode: FighterMode;
  clip: string;
  animationId: number;
  elapsed: number;
  punchProgress: number;
  uppercutIndex: number;
  attack: Attack | null;
  buffered: AttackKind | 'jump-back' | null;
  staggerUntil: number;
  punchReadyAt: number;
  punchRestUntil: number;
  counterpunchBuffered: boolean;
  counterpunchUntil: number;
  uppercutWindowUntil: number;
  rewardAt: number;
  impact: ArenaImpact | null;
  guardStamina: number;
  guardState: GuardState;
  guardHeld: boolean;
  guardNeedsRelease: boolean;
  guardElapsed: number;
  guardRecoveryRemaining: number;
  guardRegenAt: number;
  hopReadyAt: number;
  hop: { start: ArenaPoint; direction: ArenaPoint; travel: number } | null;
  dashReadyAt: number;
  dash: {
    direction: ArenaPoint;
    travel: number;
    moved: number;
    elapsed: number;
    clip: string;
  } | null;
  evadingPose: boolean;
  evadeOutOfBounds: boolean;
  evadeArmed: boolean;
  evadeUntil: number;
  evadeCooldownUntil: number;
  bufferedHand: 'L' | 'R' | null;
  evadeHits: { id: number; attacker: FighterId; kind: AttackKind; hand: 'L' | 'R' }[];
  motionInitialLift: number;
}

export interface QuestCombatTelemetry {
  distance: number;
  reach: number;
  uppercutReach: number;
  maxHealth: number;
  guardCapacity: number;
  headEvasionEnabled: boolean;
  blueCombatYaw: number;
  bearingToRed: number;
  evadeActive: boolean;
  evadeRemaining: number;
  evadeCooldownRemaining: number;
  evadeOutOfBounds: boolean;
  evadingPose: boolean;
  evadeArmed: boolean;
  redAttacking: {
    kind: AttackKind;
    hand: 'L' | 'R';
    elapsed: number;
    hitAt: number;
    hitChecked: boolean;
  } | null;
}

export interface FighterView {
  health: number;
  mode: FighterMode;
  clip: string;
  animationId: number;
  punchProgress: number;
  uppercutReady: boolean;
  uppercutWindowRemaining: number;
  motionElapsed: number;
  impact: ArenaImpact | null;
  guardStamina: number;
  guardState: GuardState;
  guardHeld: boolean;
  pendingBlock: boolean;
  counterpunchBuffered: boolean;
  defenseLockRemaining: number;
  punchRecoveryRemaining: number;
  punchRestRemaining: number;
  canPunch: boolean;
  canUppercut: boolean;
  guardRecoveryRemaining: number;
  canBlock: boolean;
  canJumpBack: boolean;
  motionInitialLift: number;
}
export interface ArenaSnapshot {
  sessionToken: number | null;
  roundId: number;
  phase: ArenaPhase;
  blue: FighterView;
  red: FighterView;
  assetsLoaded: number;
  placementVersion: number;
  placed: boolean;
  canReady: boolean;
  canResume: boolean;
  canRematch: boolean;
  canAttack: boolean;
  animationsRunning: boolean;
  impactPauseRemaining: number;
  message: string;
  error: string | null;
  outcome: FighterId | 'draw' | null;
  arenaYaw: number;
  blueStartsLeft: boolean;
  preview: { fighter: FighterId; clip: string } | null;
  fps: number | null;
  frameSamples: number;
}
export interface FighterTransform {
  x: number;
  z: number;
  lift: number;
  yaw: number;
}

export function sanitizeAnalogMovement(input: AnalogMovement): AnalogMovement {
  const advance = Number.isFinite(input.advance) ? input.advance : 0;
  const strafe = Number.isFinite(input.strafe) ? input.strafe : 0;
  const mag = Math.hypot(advance, strafe);
  if (mag <= 1) return { advance: advance === 0 ? 0 : advance, strafe: strafe === 0 ? 0 : strafe };
  return { advance: advance / mag, strafe: strafe / mag };
}

/** Owns every gameplay event. Native callbacks only supply readiness, never damage. */
export class ArenaController {
  private rules: typeof ARENA_RULES;
  private random: () => number;
  private fighters: Record<FighterId, Fighter>;
  private listeners = new Set<() => void>();
  private snapshot!: ArenaSnapshot;
  private snapshotKey = '';
  private token = 0;
  private roundId = 0;
  private animationSequence = 0;
  private impactSequence = 0;
  private impactPauseRemaining = 0;
  private victoryPlays = 0;
  private fullVictory = true;
  private attached = false;
  private landscape = false;
  private tracking = false;
  private stableTime = 0;
  private placed = false;
  private virtualReady = false;
  private placementVersion = 0;
  private assets = new Set<ArenaAsset>();
  private phase: ArenaPhase = 'setup';
  private resumePhase: 'fighting' | 'ending' = 'fighting';
  private clock = 0;
  private outcome: FighterId | 'draw' | null = null;
  private error: string | null = null;
  private held = {
    blue: { advance: false, strafeLeft: false, strafeRight: false },
    red: { advance: false, strafeLeft: false, strafeRight: false },
  };
  private analog: Record<FighterId, AnalogMovement | null> = { blue: null, red: null };
  private dashStaminaHook?: DashStaminaHook;
  private blueStartsLeft = true;
  private arenaYaw = 0;
  private cpuAttackAt: number | null = null;
  private cpuRecoveryUntil = 0;
  private cpuAttacks = 0;
  private cpuObservedAttack: number | null = null;
  private cpuReactAt = 0;
  private cpuThreats = 0;
  private cpuGuardUntil = 0;
  private cpuDefenseDone = false;
  private preview: { fighter: FighterId; clip: string; elapsed: number } | null = null;
  private frameTotal = 0;
  private frameSamples = 0;
  private fps: number | null = null;

  constructor(rules: Partial<typeof ARENA_RULES> = {}, random: () => number = Math.random) {
    this.rules = { ...ARENA_RULES, ...rules };
    this.random = random;
    this.fighters = {
      blue: this.newFighter(-this.rules.spawn),
      red: this.newFighter(this.rules.spawn),
    };
    this.publish();
  }

  getSnapshot = () => this.snapshot;
  isReady = () => this.prerequisites();
  hasNormalTracking = () => this.tracking;
  isVirtualReady = () => this.virtualReady;
  isDashing = (id: FighterId = 'blue') => this.fighters[id].dash !== null;
  isEvading = (id: FighterId = 'blue') => {
    const f = this.fighters[id];
    return (
      this.rules.headEvasionEnabled &&
      this.phase === 'fighting' &&
      f.evadingPose &&
      !f.evadeOutOfBounds &&
      f.evadeUntil > 0 &&
      this.clock < f.evadeUntil + epsilon &&
      !['hit', 'launch', 'landing', 'hop', 'settling', 'guard', 'guard-break'].includes(f.mode) &&
      !f.guardHeld &&
      f.guardState === 'off'
    );
  };
  setDashStaminaHook = (hook?: DashStaminaHook) => {
    this.dashStaminaHook = hook;
  };
  setVictoryCelebration = (matchVictory: boolean) => {
    if (this.phase === 'ending' && this.victoryPlays === 0) this.fullVictory = matchVictory;
  };
  pauseRound = () => {
    this.pause();
    this.publish();
  };
  // Prepare the next round without letting combat run during its countdown.
  prepareRound = () => {
    if (!this.rematch()) return false;
    this.pauseRound();
    return true;
  };
  getSessionToken = () => this.snapshot.sessionToken;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  attachSession = (_sessionId: number) => {
    if (this.attached) this.detachSession(this.token);
    this.token++;
    this.attached = true;
    this.tracking = false;
    this.stableTime = 0;
    this.placed = false;
    this.virtualReady = false;
    this.placementVersion++;
    this.assets.clear();
    this.error = null;
    this.frameTotal = 0;
    this.frameSamples = 0;
    this.fps = null;
    this.publish();
    return this.token;
  };

  detachSession = (token: number) => {
    if (!this.isCurrent(token)) return;
    this.pause();
    this.attached = false;
    this.token++;
    this.placed = false;
    this.virtualReady = false;
    this.tracking = false;
    this.stableTime = 0;
    this.assets.clear();
    this.publish();
  };

  dispose = () => {
    if (this.attached) this.detachSession(this.token);
    this.token++;
    this.clearInput();
  };

  setLandscape = (landscape: boolean) => {
    if (this.landscape === landscape) return;
    this.landscape = landscape;
    if (!landscape) {
      this.stableTime = 0;
      this.clearHeldMovement();
    }
    this.publish();
  };

  setTracking = (token: number, normal: boolean) => {
    if (!this.isCurrent(token) || this.tracking === normal) return;
    this.tracking = normal;
    this.stableTime = 0;
    if (!normal && this.landscape) this.pause();
    this.publish();
  };
  resetTrackingStability = () => {
    this.stableTime = 0;
    this.publish();
  };

  setPlacement = (token: number, placed: boolean) => {
    if (!this.isCurrent(token) || this.placed === placed) return;
    this.placed = placed;
    if (!placed) {
      this.pause();
      this.placementVersion++;
      this.assets.clear();
    }
    this.publish();
  };

  setVirtualReady = (token: number, ready: boolean) => {
    if (!this.isCurrent(token) || this.virtualReady === ready) return;
    this.virtualReady = ready;
    if (!ready && this.landscape) this.pause();
    this.publish();
  };

  assetLoaded = (token: number, version: number, asset: ArenaAsset) => {
    if (!this.isCurrent(token) || version !== this.placementVersion || this.error) return;
    this.assets.add(asset);
    this.publish();
  };

  assetFailed = (token: number, version: number, asset: ArenaAsset) => {
    if (!this.isCurrent(token) || version !== this.placementVersion) return false;
    this.error = `${asset === 'red' ? 'Red fighter' : asset === 'blue' ? 'Blue fighter' : 'Arena'} could not load. Retry the AR scene.`;
    this.pause();
    this.publish();
    return true;
  };

  firstMissingAsset = (): ArenaAsset | undefined =>
    (['arena', 'blue', 'red'] as const).find((asset) => !this.assets.has(asset));

  ready = () => {
    if (this.phase !== 'setup' || !this.prerequisites() || this.preview) return false;
    this.phase = 'fighting';
    this.roundId++;
    this.cpuAttackAt = null;
    this.combatYaw = { blue: null, red: null };
    this.publish();
    return true;
  };

  resume = () => {
    if (this.phase !== 'paused' || !this.prerequisites()) return false;
    this.phase = this.resumePhase;
    this.cpuAttackAt = null;
    this.combatYaw = { blue: null, red: null };
    this.publish();
    return true;
  };

  rematch = () => {
    if (this.phase !== 'ended' || !this.prerequisites()) return false;
    this.clock = 0;
    this.impactPauseRemaining = 0;
    this.victoryPlays = 0;
    this.outcome = null;
    this.cpuAttacks = 0;
    this.cpuThreats = 0;
    this.cpuObservedAttack = null;
    this.cpuReactAt = 0;
    this.cpuRecoveryUntil = 0;
    const side = this.blueStartsLeft ? -1 : 1;
    this.fighters = {
      blue: this.newFighter(side * this.rules.spawn),
      red: this.newFighter(-side * this.rules.spawn),
    };
    this.clearInput();
    this.phase = 'fighting';
    this.roundId++;
    this.cpuAttackAt = null;
    this.combatYaw = { blue: null, red: null };
    this.publish();
    return true;
  };

  swapSides = () => {
    if (this.phase !== 'setup' || this.preview) return;
    this.blueStartsLeft = !this.blueStartsLeft;
    this.fighters.blue.x *= -1;
    this.fighters.red.x *= -1;
    for (const id of ids)
      this.fighters[id].yaw = facing(
        this.fighters[id],
        this.fighters[id === 'blue' ? 'red' : 'blue']
      );
    this.publish();
  };

  rotateArena = () => {
    if (this.phase !== 'setup' || this.preview) return;
    this.arenaYaw = (this.arenaYaw + 90) % 360;
    this.publish();
  };

  setMovement = (
    movement: Movement,
    held: boolean,
    roundId = this.roundId,
    id: FighterId = 'blue'
  ) => {
    if (roundId !== this.roundId) return;
    this.held[id][movement] =
      held &&
      this.phase === 'fighting' &&
      this.prerequisites() &&
      !['hop', 'settling', 'launch', 'landing', 'guard-break'].includes(this.fighters[id].mode) &&
      canFighterBeHit(this.fighters[id].mode);
  };

  setAnalogMovement = (
    input: AnalogMovement | null,
    roundId = this.roundId,
    id: FighterId = 'blue'
  ) => {
    if (roundId !== this.roundId) return;
    if (input === null) {
      this.analog[id] = null;
      return;
    }
    const eligible =
      this.phase === 'fighting' &&
      this.prerequisites() &&
      !['hop', 'settling', 'launch', 'landing', 'guard-break'].includes(this.fighters[id].mode) &&
      canFighterBeHit(this.fighters[id].mode);
    this.analog[id] = eligible ? sanitizeAnalogMovement(input) : { advance: 0, strafe: 0 };
  };

  private evadeSequence = 0;
  private combatYaw: Record<FighterId, number | null> = { blue: null, red: null };

  private effectiveCombatYaw(id: FighterId) {
    if (this.rules.stableFacing && this.combatYaw[id] !== null) return this.combatYaw[id]!;
    return this.fighters[id].yaw;
  }

  setCombatYaw = (yaw: number | null, roundId = this.roundId, id: FighterId = 'blue') => {
    if (roundId !== this.roundId) return;
    this.combatYaw[id] = yaw !== null && Number.isFinite(yaw) ? yaw : null;
  };

  attack = (
    kind: AttackKind,
    id: FighterId = 'blue',
    roundId = this.roundId,
    preferredHand?: 'L' | 'R'
  ) => roundId === this.roundId && this.requestAttack(id, kind, preferredHand);

  command = (
    kind: CombatCommand,
    id: FighterId = 'blue',
    roundId = this.roundId,
    preferredHand?: 'L' | 'R'
  ) => {
    if (roundId !== this.roundId) return false;
    if (kind === 'block-down' || kind === 'block-up') return this.block(kind === 'block-down', id);
    if (kind === 'jump-back') return this.jumpBack(id);
    return this.requestAttack(id, kind, preferredHand);
  };

  takeEvadedHits = (id: FighterId = 'blue') => this.fighters[id].evadeHits.splice(0);

  getQuestCombatTelemetry = (): QuestCombatTelemetry => {
    const blue = this.fighters.blue;
    const red = this.fighters.red;
    return {
      distance: distance(blue, red),
      reach: this.rules.reach,
      uppercutReach: this.rules.uppercutReach,
      maxHealth: this.rules.health,
      guardCapacity: this.rules.guardCapacity,
      headEvasionEnabled: this.rules.headEvasionEnabled,
      blueCombatYaw: this.effectiveCombatYaw('blue'),
      bearingToRed: facing(blue, red),
      evadeActive: this.isEvading('blue'),
      evadeRemaining: Math.max(0, blue.evadeUntil - this.clock),
      evadeCooldownRemaining: Math.max(0, blue.evadeCooldownUntil - this.clock),
      evadeOutOfBounds: blue.evadeOutOfBounds,
      evadingPose: blue.evadingPose,
      evadeArmed: blue.evadeArmed,
      redAttacking: red.attack
        ? {
            kind: red.attack.kind,
            hand: red.attack.hand,
            elapsed: red.attack.elapsed,
            hitAt: red.attack.hitAt,
            hitChecked: red.attack.hitChecked,
          }
        : null,
    };
  };

  private canRaiseGuard(f: Fighter) {
    return (
      ['idle', 'walk'].includes(f.mode) &&
      f.guardRecoveryRemaining <= epsilon &&
      !f.guardNeedsRelease &&
      f.guardStamina + epsilon >= this.rules.guardMinimum
    );
  }
  private canAcceptBlock(f: Fighter) {
    return (
      (['idle', 'walk'].includes(f.mode) || (f.mode === 'hit' && f.clip === 'HitFrontFast')) &&
      f.guardRecoveryRemaining <= epsilon &&
      !f.guardNeedsRelease &&
      f.guardStamina + epsilon >= this.rules.guardMinimum
    );
  }
  private raiseGuard(f: Fighter) {
    f.buffered = null;
    f.bufferedHand = null;
    f.counterpunchBuffered = false;
    f.guardState = 'raising';
    f.guardElapsed = 0;
    this.setAnimation(f, 'guard', 'BlockEnter', true);
  }
  private block(held: boolean, id: FighterId) {
    if (this.phase !== 'fighting' || !this.prerequisites()) return false;
    const f = this.fighters[id];
    if (held) {
      if (!this.canAcceptBlock(f) || f.guardHeld) return false;
      f.guardHeld = true;
      f.buffered = null;
      f.bufferedHand = null;
      f.counterpunchBuffered = false;
      if (this.canRaiseGuard(f)) this.raiseGuard(f);
    } else {
      f.guardNeedsRelease = false;
      if (!f.guardHeld) {
        this.publish();
        return true;
      }
      f.guardHeld = false;
      if (f.mode === 'guard') {
        f.guardState = 'lowering';
        f.guardElapsed = 0;
        this.setAnimation(f, 'guard-exit', 'BlockExit', true);
      }
    }
    f.guardRegenAt = this.clock + this.rules.guardRegenDelay;
    this.publish();
    return true;
  }
  private canHop(f: Fighter) {
    return (
      ['idle', 'walk', 'guard-exit'].includes(f.mode) &&
      !f.guardHeld &&
      this.clock + epsilon >= f.hopReadyAt
    );
  }
  private jumpBack(id: FighterId) {
    if (this.phase !== 'fighting' || !this.prerequisites()) return false;
    const f = this.fighters[id];
    if (!this.canHop(f) || f.buffered) return false;
    const d = forward(facing(f, this.fighters[id === 'blue' ? 'red' : 'blue']));
    const direction = f.hop?.direction ?? { x: -d.x, z: -d.z };
    const travel = pathTravel(
      f,
      direction,
      f.hop?.travel ?? this.rules.hopTravel,
      this.rules.boundary,
      this.fighters[id === 'blue' ? 'red' : 'blue'],
      this.rules.separation
    );
    if (travel + epsilon < this.rules.hopMinimum) return false;
    if (f.mode === 'guard-exit') {
      f.buffered = 'jump-back';
      f.hop = { start: { x: f.x, z: f.z }, direction, travel };
    } else {
      f.hop = { start: { x: f.x, z: f.z }, direction, travel };
      f.yaw = (Math.atan2(-direction.x, -direction.z) * 180) / Math.PI;
      f.hopReadyAt = this.clock + this.rules.hopDuration + this.rules.hopRecovery;
      this.held[id] = { advance: false, strafeLeft: false, strafeRight: false };
      this.analog[id] = null;
      this.setAnimation(f, 'hop', 'JumpBack', true);
    }
    this.publish();
    return true;
  }

  private maxLinearSubstep() {
    return Math.max(1e-4, Math.min(this.rules.separation * 0.25, 0.005));
  }

  private stepLinearMovement(
    before: Record<FighterId, ArenaPoint>,
    velocity: Record<FighterId, { vx: number; vz: number }>,
    dt: number
  ): Record<FighterId, ArenaPoint> {
    if (dt <= 0) return before;
    const maxStep = Math.max(
      Math.hypot(velocity.blue.vx, velocity.blue.vz) * dt,
      Math.hypot(velocity.red.vx, velocity.red.vz) * dt
    );
    const substeps = Math.max(1, Math.ceil(maxStep / this.maxLinearSubstep()));
    const subDt = dt / substeps;
    let current = before;
    for (let i = 0; i < substeps; i++) {
      current = arenaLinearMovement(current, velocity, subDt, this.rules);
    }
    return current;
  }

  /**
   * Quest-only local directional dash along current movement intent.
   * Uses `dashStaminaCost` / `dashStaminaHook` for future general stamina (Stage 06+);
   * never reads or modifies `guardStamina`.
   */
  dash = (direction: AnalogMovement, roundId = this.roundId, id: FighterId = 'blue') => {
    if (
      !this.rules.dashEnabled ||
      roundId !== this.roundId ||
      this.phase !== 'fighting' ||
      !this.prerequisites()
    ) {
      return false;
    }
    const f = this.fighters[id];
    if (
      !['idle', 'walk'].includes(f.mode) ||
      f.guardHeld ||
      f.dash ||
      f.attack ||
      f.buffered ||
      this.clock + epsilon < f.dashReadyAt
    ) {
      return false;
    }
    if (
      this.rules.dashStaminaCost > 0 &&
      this.dashStaminaHook?.canAfford &&
      !this.dashStaminaHook.canAfford(id, this.rules.dashStaminaCost)
    ) {
      return false;
    }
    const advance = Number.isFinite(direction.advance) ? direction.advance : 0;
    const strafe = Number.isFinite(direction.strafe) ? direction.strafe : 0;
    const mag = Math.hypot(advance, strafe);
    if (mag <= epsilon) return false;
    const na = advance / mag;
    const ns = strafe / mag;
    const fwd = forward(f.yaw);
    const left = { x: fwd.z, z: -fwd.x };
    const ringDir = {
      x: fwd.x * na + left.x * ns,
      z: fwd.z * na + left.z * ns,
    };
    const simulated = this.stepLinearMovement(
      {
        blue: { x: this.fighters.blue.x, z: this.fighters.blue.z },
        red: { x: this.fighters.red.x, z: this.fighters.red.z },
      },
      id === 'blue'
        ? {
            blue: { vx: ringDir.x * this.rules.dashTravel, vz: ringDir.z * this.rules.dashTravel },
            red: { vx: 0, vz: 0 },
          }
        : {
            blue: { vx: 0, vz: 0 },
            red: { vx: ringDir.x * this.rules.dashTravel, vz: ringDir.z * this.rules.dashTravel },
          },
      1
    );
    if (distance(f, simulated[id]) + epsilon < this.rules.dashMinimum) return false;
    if (this.rules.dashStaminaCost > 0) {
      this.dashStaminaHook?.spend?.(id, this.rules.dashStaminaCost);
    }
    const clip =
      Math.abs(ns) > Math.abs(na)
        ? ns > 0
          ? 'StrafeLeft'
          : 'StrafeRight'
        : na > 0
          ? 'WalkForward'
          : 'WalkBackward';
    f.dash = {
      direction: ringDir,
      travel: this.rules.dashTravel,
      moved: 0,
      elapsed: 0,
      clip,
    };
    f.dashReadyAt = this.clock + this.rules.dashDuration + this.rules.dashRecovery;
    this.setAnimation(f, 'walk', clip, true);
    this.publish();
    return true;
  };

  cancelDash = (id: FighterId = 'blue') => {
    const f = this.fighters[id];
    if (!f.dash) return false;
    f.dash = null;
    if (f.mode === 'walk') this.setAnimation(f, 'idle', 'IdleAggro');
    this.publish();
    return true;
  };

  setHeadEvasion = (
    input: HeadEvasionInput | null,
    roundId = this.roundId,
    id: FighterId = 'blue'
  ) => {
    if (roundId !== this.roundId) return;
    const f = this.fighters[id];
    if (
      !this.rules.headEvasionEnabled ||
      input === null ||
      this.phase !== 'fighting' ||
      !this.prerequisites()
    ) {
      const wasActive = f.evadeUntil > 0;
      f.evadingPose = false;
      f.evadeOutOfBounds = false;
      f.evadeUntil = 0;
      f.evadeArmed = false;
      if (wasActive) {
        f.evadeCooldownUntil = Math.max(
          f.evadeCooldownUntil,
          this.clock + this.rules.evadeCooldown
        );
      }
      return;
    }
    const outOfBounds = input.outOfBounds === true;
    const wantPose = !outOfBounds && (Boolean(input.duck) || Boolean(input.weave));
    f.evadingPose = wantPose;
    f.evadeOutOfBounds = outOfBounds;
    if (outOfBounds) {
      if (f.evadeUntil > 0) {
        f.evadeUntil = 0;
        f.evadeCooldownUntil = Math.max(
          f.evadeCooldownUntil,
          this.clock + this.rules.evadeCooldown
        );
      }
      f.evadeArmed = false;
      return;
    }
    if (!wantPose) {
      if (f.evadeUntil > 0) {
        f.evadeUntil = 0;
        f.evadeCooldownUntil = Math.max(
          f.evadeCooldownUntil,
          this.clock + this.rules.evadeCooldown
        );
      }
      if (this.clock + epsilon >= f.evadeCooldownUntil) {
        f.evadeArmed = true;
      }
      return;
    }
    const canEvadeMode =
      !['hit', 'launch', 'landing', 'hop', 'settling', 'guard', 'guard-break'].includes(f.mode) &&
      !f.guardHeld &&
      f.guardState === 'off';
    if (f.evadeArmed && canEvadeMode && this.clock + epsilon >= f.evadeCooldownUntil) {
      f.evadeArmed = false;
      f.evadeUntil = this.clock + this.rules.evadeDuration;
    }
  };

  previewClip = (fighter: FighterId, clip: string) => {
    if (this.phase !== 'setup' || !this.prerequisites() || !ARENA_CLIPS.includes(clip))
      return false;
    this.stopPreview();
    this.preview = { fighter, clip, elapsed: 0 };
    this.setAnimation(this.fighters[fighter], 'idle', clip, true);
    this.publish();
    return true;
  };

  stopPreview = () => {
    if (!this.preview) return;
    this.setAnimation(this.fighters[this.preview.fighter], 'idle', 'IdleAggro', true);
    this.preview = null;
    this.publish();
  };

  getTransform = (id: FighterId): FighterTransform => {
    const fighter = this.fighters[id];
    return { x: fighter.x, z: fighter.z, lift: fighter.lift, yaw: fighter.yaw };
  };

  recordFrame = (
    token: number,
    dt: number,
    active = this.phase === 'fighting' || this.phase === 'ending' || !!this.preview
  ) => {
    if (!this.isCurrent(token) || !this.prerequisites() || !Number.isFinite(dt) || dt <= 0) return;
    if (!active) return;
    this.frameTotal += dt;
    this.frameSamples++;
    if (this.frameSamples % 60 === 0) {
      this.fps = Math.round(this.frameSamples / this.frameTotal);
      this.publish();
    }
  };

  tick = (token: number, dt: number, simulate = true): number => {
    if (!this.isCurrent(token) || !Number.isFinite(dt) || dt <= 0 || dt > 0.1) return 0;
    if (this.tracking && this.landscape)
      this.stableTime = Math.min(this.rules.stableTracking, this.stableTime + dt);
    if (!this.prerequisites() || !simulate) {
      this.publish();
      return 0;
    }
    if (this.preview) {
      this.preview.elapsed += dt;
      const clip = manifest.clips.find((entry) => entry.name === this.preview?.clip)!;
      if (!clip.loopRecommended && this.preview.elapsed + epsilon >= clip.durationSeconds)
        this.stopPreview();
    }
    // Tracking/readiness and networking keep running; only fighter time stops.
    const pause = Math.min(dt, this.impactPauseRemaining);
    this.impactPauseRemaining = Math.max(0, this.impactPauseRemaining - pause);
    dt -= pause;
    if (dt < epsilon) {
      this.publish();
      return 0;
    }
    if (this.phase === 'ending') {
      this.tickEnding(dt);
      this.publish();
      return dt;
    }
    if (this.phase !== 'fighting') {
      this.publish();
      return dt;
    }
    this.clock += dt;
    const posesBefore = Object.fromEntries(ids.map((id) => [id, this.contactPose(id)])) as Record<
      FighterId,
      ContactPose
    >;
    for (const id of ids) {
      const fighter = this.fighters[id];
      fighter.elapsed += dt;
      if (fighter.evadeUntil > 0 && this.clock + epsilon >= fighter.evadeUntil) {
        fighter.evadeUntil = 0;
        fighter.evadeCooldownUntil = Math.max(
          fighter.evadeCooldownUntil,
          this.clock + this.rules.evadeCooldown
        );
      }
      if (
        !fighter.evadingPose &&
        !fighter.evadeOutOfBounds &&
        !fighter.evadeArmed &&
        fighter.evadeUntil === 0 &&
        this.clock + epsilon >= fighter.evadeCooldownUntil
      ) {
        fighter.evadeArmed = true;
      }
      if (fighter.uppercutWindowUntil > 0 && this.clock + epsilon >= fighter.uppercutWindowUntil)
        this.clearReward(fighter);
      if (fighter.mode === 'hit' && this.clock + epsilon >= fighter.staggerUntil) {
        this.setAnimation(fighter, 'idle', 'IdleAggro');
        if (id === 'red') this.recoverCPU();
      }
      if (fighter.guardHeld && this.canRaiseGuard(fighter)) this.raiseGuard(fighter);
      if (fighter.counterpunchBuffered) {
        if (fighter.guardHeld || this.clock > fighter.counterpunchUntil + epsilon) {
          fighter.buffered = null;
          fighter.bufferedHand = null;
          fighter.counterpunchBuffered = false;
        } else if (
          this.clock + epsilon >= fighter.punchReadyAt &&
          ['idle', 'walk'].includes(fighter.mode)
        ) {
          const nextHand = fighter.bufferedHand ?? undefined;
          fighter.buffered = null;
          fighter.bufferedHand = null;
          fighter.counterpunchBuffered = false;
          this.startAttack(id, 'punch', nextHand);
        }
      }
    }
    this.observeCPUOpponent();
    this.defendCPU();
    for (const id of ids) this.advanceDefense(id, dt);
    this.move(dt);
    this.decideCPU();

    // Capture all eligible hits before applying any stagger/KO: simultaneous attacks are fair.
    const hits: {
      attacker: FighterId;
      defender: FighterId;
      kind: AttackKind;
      hand: 'L' | 'R';
      recovery: number;
      blocked: boolean;
      point: { x: number; y: number; z: number };
    }[] = [];
    for (const id of ids) {
      const fighter = this.fighters[id];
      const attack = fighter.attack;
      if (!attack) continue;
      // An action begun at this step's end receives time on the next step.
      if (posesBefore[id].clip === fighter.clip) attack.elapsed += dt;
    }
    this.stepUppercuts();
    // Finish both fighters' steps before testing contact, independent of update order.
    for (const id of ids) {
      const attack = this.fighters[id].attack;
      if (!attack) continue;
      const activeEnd =
        attack.kind === 'punch' ? this.rules.punchActiveEnd : this.rules.uppercutActiveEnd;
      if (!attack.hitChecked && attack.elapsed + epsilon >= attack.hitAt) {
        const defender = id === 'blue' ? 'red' : 'blue';
        const after = this.contactPose(id);
        const before =
          posesBefore[id].clip === after.clip
            ? posesBefore[id]
            : { ...after, elapsed: Math.max(0, attack.elapsed - dt) };
        const point = canFighterBeHit(this.fighters[defender].mode)
          ? sweptContact(
              before,
              after,
              posesBefore[defender],
              this.contactPose(defender),
              Math.max(attack.hitAt, attack.elapsed - dt),
              Math.min(activeEnd, attack.elapsed),
              attack.hand,
              this.rules.contactTolerance
            )
          : null;
        if (point) {
          attack.hitChecked = true;
          if (attack.kind === 'punch' && this.isEvading(defender)) {
            this.fighters[defender].evadeHits.push({
              id: ++this.evadeSequence,
              attacker: id,
              kind: attack.kind,
              hand: attack.hand,
            });
          } else {
            hits.push({
              attacker: id,
              defender,
              kind: attack.kind,
              hand: attack.hand,
              point,
              recovery: Math.max(0, attack.duration - attack.elapsed),
              blocked:
                attack.kind === 'punch' &&
                this.fighters[defender].guardState === 'holding' &&
                inCone(
                  this.fighters[defender],
                  this.fighters[id],
                  this.effectiveCombatYaw(defender),
                  this.rules.guardCone
                ),
            });
          }
        }
        if (attack.elapsed + epsilon >= activeEnd) attack.hitChecked = true;
      }
    }
    for (const hit of hits) {
      const fighter = this.fighters[hit.defender];
      if (hit.blocked) {
        fighter.guardStamina = Math.max(0, fighter.guardStamina - this.rules.guardPunchCost);
        fighter.guardRegenAt = this.clock + this.rules.guardRegenDelay;
        const broken = fighter.guardStamina <= epsilon;
        if (broken) this.exhaustGuard(fighter);
        else this.setAnimation(fighter, 'guard', 'BlockHit', true);
        fighter.impact = {
          id: ++this.impactSequence,
          kind: hit.kind,
          hand: hit.hand,
          ...hit.point,
          outcome: broken ? 'guard-break' : 'blocked',
        };
        this.impactPauseRemaining = Math.max(this.impactPauseRemaining, this.rules.blockHitstop);
        continue;
      }
      fighter.health = Math.max(
        0,
        fighter.health - (hit.kind === 'punch' ? this.rules.punchDamage : this.rules.uppercutDamage)
      );
      fighter.attack = null;
      fighter.buffered = null;
      fighter.bufferedHand = null;
      fighter.counterpunchBuffered = false;
      this.clearReward(fighter);
      fighter.impact = {
        id: ++this.impactSequence,
        kind: hit.kind,
        hand: hit.hand,
        ...hit.point,
        outcome: 'hit',
      };
      if (hit.kind === 'uppercut') fighter.guardHeld = false;
      fighter.guardState = 'off';
      fighter.guardElapsed = 0;
      fighter.guardRegenAt = this.clock + this.rules.guardRegenDelay;
      this.impactPauseRemaining = Math.max(
        this.impactPauseRemaining,
        hit.kind === 'uppercut' ? this.rules.uppercutHitstop : this.rules.punchHitstop
      );
      fighter.staggerUntil = this.clock + this.rules.punchDefenseLock;
      fighter.punchReadyAt = this.clock + this.rules.counterpunchRecovery;
      fighter.motionInitialLift = fighter.lift;
      const settling =
        hit.kind === 'punch' &&
        (fighter.mode === 'hop' || fighter.mode === 'settling') &&
        fighter.lift > epsilon;
      fighter.hop = null;
      fighter.dash = null;
      if (settling) {
        fighter.mode = 'settling';
        fighter.elapsed = 0;
        fighter.staggerUntil += this.rules.settleDuration;
        fighter.punchReadyAt += this.rules.settleDuration;
      } else
        this.setAnimation(
          fighter,
          hit.kind === 'uppercut' ? 'launch' : 'hit',
          hit.kind === 'uppercut' ? 'HitFront' : 'HitFrontFast',
          true
        );
      this.held[hit.defender] = { advance: false, strafeLeft: false, strafeRight: false };
      this.analog[hit.defender] = null;
      if (hit.defender === 'red') this.cpuAttackAt = null;
    }
    // Grant openings after all hits resolve, so a simultaneous counter cannot create a stale cue.
    for (const hit of hits) {
      const attacker = this.fighters[hit.attacker];
      const defender = this.fighters[hit.defender];
      if (
        hit.kind !== 'punch' ||
        hit.blocked ||
        !canFighterAttack(attacker.mode) ||
        attacker.health === 0 ||
        defender.health === 0
      )
        continue;
      if (attacker.punchProgress >= this.rules.punchStringLength) continue;
      attacker.punchProgress++;
      if (attacker.punchProgress === this.rules.punchStringLength) {
        attacker.rewardAt = this.clock;
        attacker.uppercutWindowUntil = this.clock + hit.recovery + this.rules.uppercutWindow;
        attacker.punchRestUntil = this.clock + hit.recovery + this.rules.punchRest;
        if (attacker.buffered === 'punch') {
          attacker.buffered = null;
          attacker.bufferedHand = null;
        }
      }
    }
    if (ids.some((id) => this.fighters[id].health === 0)) {
      this.endRound(hits);
    } else {
      for (const id of ids) {
        const fighter = this.fighters[id];
        if (fighter.attack && fighter.attack.elapsed + epsilon >= fighter.attack.duration) {
          const next = fighter.buffered;
          const nextHand = fighter.bufferedHand ?? undefined;
          fighter.attack = null;
          fighter.buffered = null;
          fighter.bufferedHand = null;
          this.setAnimation(fighter, 'idle', 'IdleAggro');
          if (id === 'red') this.recoverCPU();
          // A buffered Uppercut already consumed its earned opportunity.
          if (next === 'jump-back') this.jumpBack(id);
          else if (next) this.startAttack(id, next, nextHand);
        } else if (fighter.mode === 'launch') {
          this.advanceLaunch(fighter, false);
        } else if (
          fighter.mode === 'landing' &&
          fighter.elapsed + epsilon >= clipDuration('HitFront')
        ) {
          this.setAnimation(fighter, 'idle', 'IdleAggro');
          if (id === 'red') this.recoverCPU();
        }
      }
    }
    this.publish();
    return dt;
  };

  private newFighter(x: number): Fighter {
    return {
      health: this.rules.health,
      x,
      z: 0,
      yaw: x < 0 ? 90 : -90,
      lift: 0,
      mode: 'idle',
      clip: 'IdleAggro',
      animationId: ++this.animationSequence,
      elapsed: 0,
      punchProgress: 0,
      uppercutIndex: 0,
      attack: null,
      buffered: null,
      staggerUntil: 0,
      punchReadyAt: 0,
      punchRestUntil: 0,
      counterpunchBuffered: false,
      counterpunchUntil: 0,
      uppercutWindowUntil: 0,
      rewardAt: 0,
      impact: null,
      guardStamina: this.rules.guardCapacity,
      guardState: 'off',
      guardHeld: false,
      guardNeedsRelease: false,
      guardElapsed: 0,
      guardRecoveryRemaining: 0,
      guardRegenAt: 0,
      hopReadyAt: 0,
      hop: null,
      dashReadyAt: 0,
      dash: null,
      evadingPose: false,
      evadeOutOfBounds: false,
      evadeArmed: true,
      evadeUntil: 0,
      evadeCooldownUntil: 0,
      bufferedHand: null,
      evadeHits: [],
      motionInitialLift: 0,
    };
  }

  private isCurrent(token: number) {
    return this.attached && token === this.token;
  }
  private prerequisites() {
    return (
      this.attached &&
      this.landscape &&
      (this.virtualReady ||
        (this.tracking && this.stableTime + epsilon >= this.rules.stableTracking && this.placed)) &&
      this.assets.size === 3 &&
      !this.error
    );
  }
  private setAnimation(fighter: Fighter, mode: FighterMode, clip: string, restart = false) {
    if (restart || fighter.mode !== mode || fighter.clip !== clip) {
      fighter.mode = mode;
      fighter.clip = clip;
      fighter.animationId = ++this.animationSequence;
      fighter.elapsed = 0;
    }
  }
  private contactPose(id: FighterId): ContactPose {
    const f = this.fighters[id];
    return {
      x: f.x,
      z: f.z,
      lift: f.lift,
      yaw: this.effectiveCombatYaw(id),
      clip: f.clip,
      elapsed: f.attack?.elapsed ?? f.elapsed,
    };
  }
  clearHeldMovement = () => {
    this.held = {
      blue: { advance: false, strafeLeft: false, strafeRight: false },
      red: { advance: false, strafeLeft: false, strafeRight: false },
    };
    this.analog = { blue: null, red: null };
    for (const f of Object.values(this.fighters)) f.guardHeld = false;
  };
  private clearInput() {
    this.clearHeldMovement();
    ids.forEach((id) => {
      this.fighters[id].buffered = null;
      this.fighters[id].bufferedHand = null;
      this.fighters[id].counterpunchBuffered = false;
      this.fighters[id].dash = null;
      this.fighters[id].evadingPose = false;
      this.fighters[id].evadeOutOfBounds = false;
      this.fighters[id].evadeUntil = 0;
      this.fighters[id].evadeArmed = false;
      if (this.fighters[id].mode !== 'hop') this.fighters[id].hop = null;
    });
  }
  private pause() {
    this.stopPreview();
    this.clearInput();
    if (this.phase === 'fighting' || this.phase === 'ending') {
      this.resumePhase = this.phase;
      this.phase = 'paused';
    }
    for (const id of ids) {
      const fighter = this.fighters[id];
      fighter.attack = null;
      fighter.staggerUntil = 0;
      fighter.punchReadyAt = 0;
      this.clearReward(fighter);
      fighter.impact = null;
      fighter.evadeHits = [];
      fighter.guardHeld = false;
      fighter.guardNeedsRelease = false;
      fighter.evadeCooldownUntil = 0;
      if (fighter.guardState !== 'exhausted') fighter.guardState = 'off';
      if (['attack', 'hit', 'walk', 'guard', 'guard-exit'].includes(fighter.mode))
        this.setAnimation(fighter, 'idle', 'IdleAggro');
    }
    this.cpuAttackAt = null;
    this.cpuObservedAttack = null;
    this.cpuReactAt = 0;
    this.cpuGuardUntil = 0;
    this.cpuDefenseDone = false;
    this.impactPauseRemaining = 0;
  }
  private clearReward(fighter: Fighter) {
    fighter.punchProgress = 0;
    fighter.uppercutWindowUntil = 0;
  }
  private uppercutReady(fighter: Fighter) {
    return (
      this.phase === 'fighting' &&
      fighter.punchProgress === this.rules.punchStringLength &&
      this.clock + epsilon < fighter.uppercutWindowUntil
    );
  }
  private requestAttack(id: FighterId, kind: AttackKind, preferredHand?: 'L' | 'R') {
    if (this.phase !== 'fighting' || !this.prerequisites()) return false;
    const safeHand = preferredHand === 'L' || preferredHand === 'R' ? preferredHand : undefined;
    const fighter = this.fighters[id];
    if (!this.canAcceptAttack(fighter, kind)) return false;
    if (kind === 'punch' && this.clock + epsilon < fighter.punchReadyAt) {
      fighter.buffered = 'punch';
      fighter.bufferedHand = safeHand ?? null;
      fighter.counterpunchBuffered = true;
      fighter.counterpunchUntil = fighter.punchReadyAt + this.rules.counterpunchBuffer;
      this.publish();
      return true;
    }
    if (fighter.attack || fighter.mode === 'guard-exit') {
      if (fighter.buffered && !(kind === 'uppercut' && fighter.buffered === 'punch')) return false;
      fighter.buffered = kind;
      fighter.bufferedHand = safeHand ?? null;
      if (kind === 'uppercut') this.clearReward(fighter);
      this.publish();
      return true;
    }
    if (kind === 'uppercut') this.clearReward(fighter);
    this.startAttack(id, kind, safeHand);
    this.publish();
    return true;
  }
  private canAcceptAttack(f: Fighter, kind: AttackKind) {
    const bufferingCounter =
      kind === 'punch' &&
      f.clip === 'HitFrontFast' &&
      f.mode === 'hit' &&
      this.clock + epsilon >= f.punchReadyAt - this.rules.counterpunchBuffer;
    if ((!canFighterAttack(f.mode) && !bufferingCounter) || f.guardHeld) return false;
    if (kind === 'uppercut') {
      if (!this.uppercutReady(f)) return false;
    } else if (
      this.clock + epsilon < f.punchRestUntil ||
      this.clock + epsilon < f.punchReadyAt - this.rules.counterpunchBuffer
    )
      return false;
    return !f.buffered || (kind === 'uppercut' && f.buffered === 'punch');
  }
  private startAttack(id: FighterId, kind: AttackKind, preferredHand?: 'L' | 'R') {
    const fighter = this.fighters[id];
    fighter.counterpunchBuffered = false;
    fighter.counterpunchUntil = 0;
    if (!(this.rules.stableFacing && id === 'blue')) {
      fighter.yaw = facing(fighter, this.fighters[id === 'blue' ? 'red' : 'blue']);
    }
    const safeHand = preferredHand === 'L' || preferredHand === 'R' ? preferredHand : undefined;
    const hand =
      safeHand ??
      (kind === 'punch'
        ? this.random() < 0.5
          ? 'L'
          : 'R'
        : fighter.uppercutIndex++ % 2 === 0
          ? 'L'
          : 'R');
    const clip = `Combo_${kind === 'punch' ? 'Punch' : 'Uppercut'}${hand}`;
    const timing = attackTiming(clip);
    fighter.attack = {
      kind,
      elapsed: 0,
      duration: timing.durationSeconds,
      hitAt: Number(timing.hitCheckSeconds.toFixed(6)),
      hitChecked: false,
      hand,
      step: 0,
      direction: forward(this.effectiveCombatYaw(id)),
    };
    this.setAnimation(fighter, 'attack', clip, true);
  }
  private stepUppercuts() {
    const before = {
      blue: { x: this.fighters.blue.x, z: this.fighters.blue.z },
      red: { x: this.fighters.red.x, z: this.fighters.red.z },
    };
    const candidates = { blue: { ...before.blue }, red: { ...before.red } };
    for (const id of ids) {
      const attack = this.fighters[id].attack;
      if (attack?.kind !== 'uppercut') continue;
      const fraction = Math.max(
        0,
        Math.min(
          1,
          (attack.elapsed - this.rules.uppercutStepStart) /
            (this.rules.uppercutStepEnd - this.rules.uppercutStepStart)
        )
      );
      const desired = this.rules.uppercutLunge * fraction;
      const fighter = before[id];
      const other = before[id === 'blue' ? 'red' : 'blue'];
      const travel = pathTravel(
        fighter,
        attack.direction,
        Math.max(0, desired - attack.step),
        this.rules.boundary,
        other,
        this.rules.separation
      );
      candidates[id].x += attack.direction.x * travel;
      candidates[id].z += attack.direction.z * travel;
      attack.step = desired;
    }
    const at = (id: FighterId, t: number) => ({
      x: before[id].x + (candidates[id].x - before[id].x) * t,
      z: before[id].z + (candidates[id].z - before[id].z) * t,
    });
    let alpha = 1;
    if (distance(candidates.blue, candidates.red) < this.rules.separation - epsilon) {
      let lo = 0,
        hi = 1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (distance(at('blue', mid), at('red', mid)) >= this.rules.separation) lo = mid;
        else hi = mid;
      }
      alpha = lo;
    }
    for (const id of ids) Object.assign(this.fighters[id], at(id, alpha));
  }
  private advanceLaunch(fighter: Fighter, ending: boolean) {
    fighter.lift = launchLift(
      fighter.elapsed,
      this.rules.launchDuration,
      this.rules.launchHeight,
      fighter.motionInitialLift
    );
    if (fighter.elapsed + epsilon < this.rules.launchDuration) return;
    fighter.lift = 0;
    const mode = ending ? (fighter.health > 0 ? 'idle' : 'defeat') : 'landing';
    this.setAnimation(
      fighter,
      mode,
      mode === 'idle' ? 'IdleAggro' : mode === 'defeat' ? 'Defeat' : 'HitFront',
      true
    );
  }
  private move(dt: number) {
    const blue = this.fighters.blue;
    const red = this.fighters.red;
    const before = { blue: { x: blue.x, z: blue.z }, red: { x: red.x, z: red.z } };
    const velocity = {} as Record<FighterId, { advance: number; strafe: number }>;
    const dashWorldVel: Partial<Record<FighterId, { vx: number; vz: number }>> = {};
    for (const id of ids) {
      const f = this.fighters[id];
      if (f.dash) {
        const nextElapsed = Math.min(this.rules.dashDuration, f.dash.elapsed + dt);
        const progress =
          this.rules.dashDuration > epsilon
            ? Math.max(0, Math.min(1, nextElapsed / this.rules.dashDuration))
            : 1;
        const ease = 1 - (1 - progress) * (1 - progress);
        const targetMoved = f.dash.travel * ease;
        const stepDist = Math.max(0, targetMoved - f.dash.moved);
        f.dash.elapsed = nextElapsed;
        f.dash.moved = targetMoved;
        dashWorldVel[id] = {
          vx: dt > epsilon ? f.dash.direction.x * (stepDist / dt) : 0,
          vz: dt > epsilon ? f.dash.direction.z * (stepDist / dt) : 0,
        };
        velocity[id] = { advance: 0, strafe: 0 };
        continue;
      }
      const free = ['idle', 'walk', 'guard', 'guard-exit'].includes(f.mode);
      const cpu = id === 'red' && this.rules.cpuEnabled;
      const analog = this.analog[id];
      const advance = free
        ? cpu
          ? this.cpuMovement()
          : analog !== null
            ? analog.advance
            : Number(this.held[id].advance)
        : 0;
      const strafe = free
        ? cpu
          ? this.clock < this.cpuRecoveryUntil
            ? this.cpuAttacks % 2 === 0
              ? 1
              : -1
            : 0
          : analog !== null
            ? analog.strafe
            : Number(this.held[id].strafeLeft) - Number(this.held[id].strafeRight)
        : 0;
      const scale =
        (this.rules.speed * (f.mode === 'guard' ? this.rules.guardSpeed : 1)) /
        Math.max(1, Math.hypot(advance, strafe));
      velocity[id] = { advance: advance * scale, strafe: strafe * scale };
    }
    const useLinear = this.rules.stableFacing || !!dashWorldVel.blue || !!dashWorldVel.red;
    const positions = useLinear
      ? this.stepLinearMovement(
          before,
          {
            blue:
              dashWorldVel.blue ??
              (() => {
                const fwd = forward(blue.yaw);
                const left = { x: fwd.z, z: -fwd.x };
                return {
                  vx: fwd.x * velocity.blue.advance + left.x * velocity.blue.strafe,
                  vz: fwd.z * velocity.blue.advance + left.z * velocity.blue.strafe,
                };
              })(),
            red:
              dashWorldVel.red ??
              (() => {
                const fwd = forward(facing(red, blue));
                const left = { x: fwd.z, z: -fwd.x };
                return {
                  vx: fwd.x * velocity.red.advance + left.x * velocity.red.strafe,
                  vz: fwd.z * velocity.red.advance + left.z * velocity.red.strafe,
                };
              })(),
          },
          dt
        )
      : arenaMovement(before, velocity, dt, this.rules);
    for (const id of ids) Object.assign(this.fighters[id], positions[id]);
    for (const id of ids) {
      const f = this.fighters[id],
        v = velocity[id];
      if (!['idle', 'walk', 'guard', 'guard-exit'].includes(f.mode)) continue;
      if (!(this.rules.stableFacing && id === 'blue')) {
        f.yaw = facing(f, this.fighters[id === 'blue' ? 'red' : 'blue']);
      }
      if (f.dash) {
        if (f.dash.elapsed + epsilon >= this.rules.dashDuration) {
          f.dash = null;
          const analog = this.analog[id];
          const hasWalkIntent =
            Math.hypot(
              analog !== null ? analog.advance : Number(this.held[id].advance),
              analog !== null
                ? analog.strafe
                : Number(this.held[id].strafeLeft) - Number(this.held[id].strafeRight)
            ) > epsilon;
          if (!hasWalkIntent) this.setAnimation(f, 'idle', 'IdleAggro');
        } else {
          this.setAnimation(f, 'walk', f.dash.clip);
        }
        continue;
      }
      if (f.mode === 'guard-exit') continue;
      const moving = distance(f, before[id]) > epsilon;
      if (f.mode === 'guard') {
        if (
          f.guardState === 'raising' ||
          (f.clip === 'BlockHit' && f.elapsed < clipDuration('BlockHit') - epsilon)
        )
          continue;
        this.setAnimation(
          f,
          'guard',
          !moving
            ? 'BlockHold'
            : v.strafe !== 0
              ? v.strafe > 0
                ? 'BlockStrafeLeft'
                : 'BlockStrafeRight'
              : 'BlockAdvance'
        );
      } else
        this.setAnimation(
          f,
          moving ? 'walk' : 'idle',
          !moving
            ? 'IdleAggro'
            : v.strafe !== 0
              ? v.strafe > 0
                ? 'StrafeLeft'
                : 'StrafeRight'
              : v.advance > 0
                ? 'WalkForward'
                : 'WalkBackward'
        );
    }
  }

  private exhaustGuard(f: Fighter) {
    f.guardState = 'exhausted';
    f.guardHeld = false;
    f.guardNeedsRelease = true;
    f.guardRecoveryRemaining = this.rules.guardRecovery;
    f.guardRegenAt = this.clock + this.rules.guardRegenDelay;
    this.setAnimation(f, 'guard-break', 'BlockExit', true);
  }
  private advanceDefense(id: FighterId, dt: number) {
    const f = this.fighters[id];
    f.guardRecoveryRemaining = Math.max(0, f.guardRecoveryRemaining - dt);
    if (f.mode === 'guard') {
      if (!f.guardHeld) {
        f.guardState = 'lowering';
        f.guardElapsed = 0;
        this.setAnimation(f, 'guard-exit', 'BlockExit', true);
        return;
      }
      f.guardElapsed = f.guardState === 'raising' ? f.elapsed : f.guardElapsed + dt;
      f.guardStamina = Math.max(
        0,
        f.guardStamina - this.rules.guardDrain * Math.min(dt, f.elapsed)
      );
      f.guardRegenAt = this.clock + this.rules.guardRegenDelay;
      if (f.guardStamina <= epsilon) this.exhaustGuard(f);
      else if (f.guardState === 'raising' && f.guardElapsed + epsilon >= this.rules.guardStartup) {
        f.guardState = 'holding';
        this.setAnimation(f, 'guard', 'BlockHold', true);
      }
    } else if (f.mode === 'guard-exit') {
      f.guardElapsed += dt;
      if (f.guardElapsed + epsilon >= this.rules.guardExit) {
        f.guardState = 'off';
        const next = f.buffered;
        const nextHand = f.bufferedHand ?? undefined;
        f.buffered = null;
        f.bufferedHand = null;
        this.setAnimation(f, 'idle', 'IdleAggro');
        if (next === 'jump-back') this.jumpBack(id);
        else if (next === 'punch' && this.clock + epsilon < f.punchReadyAt) {
          f.buffered = 'punch';
          f.bufferedHand = nextHand ?? null;
        } else if (next) this.startAttack(id, next, nextHand);
      }
    } else if (f.mode === 'guard-break' && f.guardRecoveryRemaining <= epsilon) {
      f.guardState = 'off';
      this.setAnimation(f, 'idle', 'IdleAggro');
    }
    if (
      ['idle', 'walk', 'attack', 'hit', 'landing', 'guard-exit', 'guard-break'].includes(f.mode) &&
      !f.guardHeld &&
      this.clock > f.guardRegenAt
    )
      f.guardStamina = Math.min(
        this.rules.guardCapacity,
        f.guardStamina + this.rules.guardRegen * Math.min(dt, this.clock - f.guardRegenAt)
      );
    if (f.mode === 'hop' && f.hop) {
      const h = f.hop;
      const t = Math.max(
        0,
        Math.min(1, (f.elapsed - this.rules.hopPreparation) / this.rules.hopFlight)
      );
      const target = h.travel * (1 - Math.pow(1 - t, 3));
      const moved = distance(f, h.start);
      const travel = pathTravel(
        f,
        h.direction,
        Math.max(0, target - moved),
        this.rules.boundary,
        this.fighters[id === 'blue' ? 'red' : 'blue'],
        this.rules.separation
      );
      f.x += h.direction.x * travel;
      f.z += h.direction.z * travel;
      f.lift = hopLift(
        f.elapsed,
        this.rules.hopPreparation,
        this.rules.hopFlight,
        this.rules.hopHeight
      );
      if (f.elapsed + epsilon >= this.rules.hopDuration) {
        f.lift = 0;
        f.hop = null;
        this.setAnimation(f, 'idle', 'IdleAggro');
      }
    } else if (f.mode === 'settling') this.advanceSettling(f, false);
  }
  private advanceSettling(f: Fighter, ending: boolean) {
    f.lift = settlingLift(f.elapsed, this.rules.settleDuration, f.motionInitialLift);
    if (f.elapsed + epsilon < this.rules.settleDuration) return;
    f.lift = 0;
    const mode = ending ? (f.health > 0 ? 'idle' : 'defeat') : 'hit';
    this.setAnimation(
      f,
      mode,
      mode === 'idle' ? 'IdleAggro' : mode === 'defeat' ? 'Defeat' : 'HitFrontFast',
      true
    );
    f.staggerUntil = this.clock + this.rules.punchDefenseLock;
    f.punchReadyAt = this.clock + this.rules.counterpunchRecovery;
  }
  private observeCPUOpponent() {
    if (!this.rules.cpuEnabled) return;
    const blue = this.fighters.blue;
    if (!blue.attack) {
      this.cpuObservedAttack = null;
      return;
    }
    if (this.cpuObservedAttack === blue.animationId) return;
    // React to a visible clip, never held controls or the player's buffered next move.
    this.cpuObservedAttack = blue.animationId;
    this.cpuReactAt =
      this.clock +
      (blue.attack.kind === 'punch' ? this.rules.cpuGuardReaction : this.rules.cpuReaction);
    this.cpuDefenseDone = false;
    this.cpuThreats++;
  }
  private cpuEvades() {
    const attack = this.fighters.blue.attack;
    return (
      attack &&
      !attack.hitChecked &&
      this.clock + epsilon >= this.cpuReactAt &&
      this.cpuThreats % 4 === 0
    );
  }
  private cpuCanRetreat() {
    const red = this.fighters.red,
      dir = forward(facing(red, this.fighters.blue));
    return (
      pathTravel(
        red,
        { x: -dir.x, z: -dir.z },
        this.rules.hopTravel,
        this.rules.boundary,
        this.fighters.blue,
        this.rules.separation
      ) >= this.rules.hopMinimum
    );
  }
  private cpuMovement() {
    const d = distance(this.fighters.red, this.fighters.blue);
    if (!canFighterBeHit(this.fighters.blue.mode)) return 0;
    if (d < this.rules.cpuMinimumRange) return -1;
    return d > this.rules.cpuPreferredRange ? 1 : 0;
  }
  private defendCPU() {
    if (!this.rules.cpuEnabled) return;
    const red = this.fighters.red,
      attack = this.fighters.blue.attack;
    if (red.guardHeld && this.clock >= this.cpuGuardUntil) this.block(false, 'red');
    if (red.guardNeedsRelease) this.block(false, 'red');
    if (
      !attack ||
      attack.hitChecked ||
      this.cpuDefenseDone ||
      this.clock + epsilon < this.cpuReactAt
    )
      return;
    if (this.uppercutReady(red)) return;
    if (attack.kind === 'punch' && this.cpuThreats % 3 === 0) {
      if (this.block(true, 'red')) {
        this.cpuGuardUntil = this.clock + 0.45;
        this.cpuDefenseDone = true;
      }
    } else if (attack.kind === 'uppercut' && this.cpuEvades() && this.cpuCanRetreat()) {
      if (this.jumpBack('red')) this.cpuDefenseDone = true;
    }
  }
  private recoverCPU() {
    // A short, varied beat leaves counterplay without the old long idle opening.
    const rhythm = [1, 1.4, 0.8][this.cpuAttacks % 3];
    this.cpuAttackAt = this.cpuRecoveryUntil = this.clock + this.rules.cpuRecovery * rhythm;
  }
  private decideCPU() {
    if (!this.rules.cpuEnabled) return;
    const red = this.fighters.red;
    if (!canFighterAttack(red.mode)) return;
    const blue = this.fighters.blue;
    if (!canFighterBeHit(blue.mode)) return;
    if (
      this.uppercutReady(red) &&
      this.clock + epsilon >= red.rewardAt + this.rules.cpuRewardReaction
    ) {
      if (this.requestAttack('red', 'uppercut')) {
        this.cpuAttacks++;
        this.cpuAttackAt = null;
      }
      return;
    }
    if (red.attack) return;
    if (distance(red, blue) > this.rules.reach + epsilon) return;
    if (
      red.punchReadyAt > this.clock &&
      this.cpuThreats % 4 === 2 &&
      this.clock >= this.cpuReactAt
    ) {
      // A visible pressure response uses the same short counterpunch buffer as a human.
      this.requestAttack('red', 'punch');
      return;
    }
    this.cpuAttackAt ??= Math.max(this.clock + this.rules.cpuFirstDelay, this.cpuRecoveryUntil);
    if (this.clock + epsilon < this.cpuAttackAt) return;
    if (this.cpuEvades() && this.cpuCanRetreat()) return;
    if (this.requestAttack('red', 'punch')) {
      this.cpuAttacks++;
      this.cpuAttackAt = null;
    }
  }
  private endRound(hits: { defender: FighterId; kind: AttackKind }[]) {
    this.outcome =
      this.fighters.blue.health === 0 ? (this.fighters.red.health === 0 ? 'draw' : 'red') : 'blue';
    this.phase = 'ending';
    this.victoryPlays = 0;
    this.fullVictory = true;
    this.clearInput();
    for (const id of ids) {
      const fighter = this.fighters[id];
      fighter.attack = null;
      this.clearReward(fighter);
      fighter.guardHeld = false;
      fighter.guardState = 'off';
      if (fighter.mode === 'launch' || fighter.mode === 'settling') continue;
      if (hits.some((hit) => hit.defender === id && hit.kind === 'uppercut'))
        this.setAnimation(fighter, 'launch', 'HitFront', true);
      else if (fighter.health > 0) this.setAnimation(fighter, 'idle', 'IdleAggro', true);
      else this.setAnimation(fighter, 'defeat', 'Defeat', true);
    }
  }
  private tickEnding(dt: number) {
    for (const id of ids) {
      const fighter = this.fighters[id];
      fighter.elapsed += dt;
      if (fighter.mode === 'launch') {
        this.advanceLaunch(fighter, true);
      } else if (fighter.mode === 'settling') {
        this.advanceSettling(fighter, true);
      } else if (fighter.mode === 'defeat' && fighter.elapsed + epsilon >= clipDuration('Defeat')) {
        this.setAnimation(fighter, 'defeated', 'DefeatedLoop', true);
      } else if (
        fighter.mode === 'victory' &&
        fighter.elapsed + epsilon >= clipDuration(fighter.clip)
      ) {
        if (
          fighter.clip === 'Victory' &&
          this.victoryPlays < (this.fullVictory ? this.rules.victoryRepeats : 1)
        ) {
          this.victoryPlays++;
          this.setAnimation(fighter, 'victory', 'Victory', true);
        } else if (fighter.clip === 'Victory' && this.fullVictory) {
          this.setAnimation(fighter, 'victory', 'VictoryUppercut', true);
        } else this.setAnimation(fighter, 'idle', 'IdleAggro');
      }
    }
    if (this.outcome && this.outcome !== 'draw' && this.victoryPlays === 0) {
      const winner = this.fighters[this.outcome];
      const loser = this.fighters[this.outcome === 'blue' ? 'red' : 'blue'];
      if (winner.mode === 'idle' && loser.mode === 'defeated') {
        this.victoryPlays = 1;
        this.setAnimation(winner, 'victory', 'Victory', true);
      }
    }
    if (ids.every((id) => ['idle', 'defeated'].includes(this.fighters[id].mode)))
      this.phase = 'ended';
  }
  private publish() {
    const capable = this.prerequisites();
    const message =
      this.error ??
      (!this.landscape
        ? 'Rotate to landscape to place the arena.'
        : !this.attached
          ? 'AR paused. Return to place the arena again.'
          : !this.virtualReady &&
              (!this.tracking || this.stableTime + epsilon < this.rules.stableTracking)
            ? 'Move slowly in a well-lit space until tracking is stable.'
            : !this.virtualReady && !this.placed
              ? 'Tap a highlighted table or floor to place the arena.'
              : this.assets.size < 3
                ? `Loading arena and fighters (${this.assets.size}/3).`
                : this.phase === 'paused'
                  ? 'Fight paused. Press Resume when ready.'
                  : this.phase === 'setup'
                    ? this.preview
                      ? `Testing ${this.preview.fighter === 'blue' ? 'Blue' : 'Red'}: ${this.preview.clip}`
                      : 'Choose your side and view, then press Ready.'
                    : this.outcome && this.phase === 'ended'
                      ? this.outcome === 'draw'
                        ? 'Draw — double knockout.'
                        : this.outcome === 'blue'
                          ? 'You won!'
                          : 'Red Mike won. Try a rematch.'
                      : 'Hold Block, Advance, Left or Right. Tap Jump Back, Punch or Uppercut.');
    const view = (fighter: Fighter): FighterView => ({
      health: fighter.health,
      mode: fighter.mode,
      clip: fighter.clip,
      animationId: fighter.animationId,
      punchProgress: fighter.punchProgress,
      uppercutReady: this.uppercutReady(fighter),
      uppercutWindowRemaining: this.uppercutReady(fighter)
        ? Math.ceil(Math.max(0, fighter.uppercutWindowUntil - this.clock - epsilon) * 100) / 100
        : 0,
      motionElapsed: ['launch', 'landing', 'hop', 'settling'].includes(fighter.mode)
        ? fighter.elapsed
        : 0,
      impact: fighter.impact,
      guardStamina: Math.round(fighter.guardStamina * 10) / 10,
      guardState: fighter.guardState,
      guardHeld: fighter.guardHeld,
      pendingBlock: fighter.guardHeld && fighter.mode !== 'guard',
      counterpunchBuffered: fighter.counterpunchBuffered,
      defenseLockRemaining:
        Math.ceil(Math.max(0, fighter.staggerUntil - this.clock - epsilon) * 100) / 100,
      punchRecoveryRemaining:
        Math.ceil(Math.max(0, fighter.punchReadyAt - this.clock - epsilon) * 100) / 100,
      punchRestRemaining:
        Math.ceil(Math.max(0, fighter.punchRestUntil - this.clock - epsilon) * 100) / 100,
      canPunch: capable && this.phase === 'fighting' && this.canAcceptAttack(fighter, 'punch'),
      canUppercut:
        capable && this.phase === 'fighting' && this.canAcceptAttack(fighter, 'uppercut'),
      guardRecoveryRemaining: Math.ceil(fighter.guardRecoveryRemaining * 100) / 100,
      canBlock:
        capable && this.phase === 'fighting' && (this.canAcceptBlock(fighter) || fighter.guardHeld),
      canJumpBack:
        capable &&
        this.phase === 'fighting' &&
        this.canHop(fighter) &&
        pathTravel(
          fighter,
          { x: -forward(fighter.yaw).x, z: -forward(fighter.yaw).z },
          this.rules.hopTravel,
          this.rules.boundary,
          this.fighters[fighter === this.fighters.blue ? 'red' : 'blue'],
          this.rules.separation
        ) +
          epsilon >=
          this.rules.hopMinimum,
      motionInitialLift: fighter.motionInitialLift,
    });
    const snapshot: ArenaSnapshot = {
      sessionToken: this.attached ? this.token : null,
      roundId: this.roundId,
      phase: this.phase,
      blue: view(this.fighters.blue),
      red: view(this.fighters.red),
      assetsLoaded: this.assets.size,
      placementVersion: this.placementVersion,
      placed: this.placed,
      canReady: capable && this.phase === 'setup' && !this.preview,
      canResume: capable && this.phase === 'paused',
      canRematch: capable && this.phase === 'ended',
      canAttack:
        capable &&
        this.phase === 'fighting' &&
        (this.canAcceptAttack(this.fighters.blue, 'punch') ||
          this.canAcceptAttack(this.fighters.blue, 'uppercut')),
      animationsRunning: capable && this.phase !== 'paused',
      impactPauseRemaining: this.impactPauseRemaining,
      message,
      error: this.error,
      outcome: this.outcome,
      arenaYaw: this.arenaYaw,
      blueStartsLeft: this.blueStartsLeft,
      preview: this.preview ? { fighter: this.preview.fighter, clip: this.preview.clip } : null,
      fps: this.fps,
      frameSamples: this.frameSamples - (this.frameSamples % 60),
    };
    const key = JSON.stringify(snapshot);
    if (key === this.snapshotKey) return;
    this.snapshotKey = key;
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}
