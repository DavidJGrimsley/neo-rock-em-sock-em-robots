import { boundPoint, distance, type ArenaPoint } from './arena-combat-motion.ts';

type Side = 'blue' | 'red';
export interface MovementVelocity {
  advance: number;
  strafe: number;
}
/** The host and visual predictor share exactly the same orbit and separation geometry. */
export function arenaMovement(
  before: Record<Side, ArenaPoint>,
  velocity: Record<Side, MovementVelocity>,
  dt: number,
  rules: { boundary: number; separation: number }
): Record<Side, ArenaPoint> {
  const epsilon = 1e-7;
  const d = Math.max(epsilon, distance(before.blue, before.red));
  const u = { x: (before.blue.x - before.red.x) / d, z: (before.blue.z - before.red.z) / d };
  const tangent = { x: -u.z, z: u.x };
  const available = Math.max(0, d - rules.separation);
  // Closing (> 0) shares available separation plus space opened by retreat (< 0),
  // so a retreating fighter is never pinned by a faster approaching opponent.
  const closing = Math.max(0, velocity.blue.advance) + Math.max(0, velocity.red.advance);
  const retreat = Math.max(0, -velocity.blue.advance) + Math.max(0, -velocity.red.advance);
  const initialClosingFraction =
    closing > epsilon ? Math.min(1, (available + retreat * dt) / (closing * dt)) : 1;
  const angular = velocity.blue.strafe + velocity.red.strafe;

  const candidatesForClosing = (closingFraction: number): Record<Side, ArenaPoint> => {
    const radialAdvance = {
      blue:
        velocity.blue.advance > 0 ? velocity.blue.advance * closingFraction : velocity.blue.advance,
      red: velocity.red.advance > 0 ? velocity.red.advance * closingFraction : velocity.red.advance,
    };
    const nextDistance = d - (radialAdvance.blue + radialAdvance.red) * dt;
    const angle = (angular * dt) / Math.max(rules.separation, (d + nextDistance) / 2);
    const chord = {
      x: nextDistance * (u.x * Math.cos(angle) - u.z * Math.sin(angle) - u.x),
      z: nextDistance * (u.x * Math.sin(angle) + u.z * Math.cos(angle) - u.z),
    };
    const out = {} as Record<Side, ArenaPoint>;
    for (const id of ['blue', 'red'] as const) {
      const v = velocity[id],
        sign = id === 'blue' ? 1 : -1;
      const share = Math.abs(angular) > epsilon ? v.strafe / angular : 0;
      const orbit =
        Math.abs(angular) > epsilon
          ? { x: chord.x * share, z: chord.z * share }
          : { x: tangent.x * v.strafe * dt, z: tangent.z * v.strafe * dt };
      out[id] = boundPoint(
        {
          x: before[id].x - sign * u.x * radialAdvance[id] * dt + sign * orbit.x,
          z: before[id].z - sign * u.z * radialAdvance[id] * dt + sign * orbit.z,
        },
        rules.boundary
      );
    }
    return out;
  };

  let candidates = candidatesForClosing(initialClosingFraction);
  // If ring-wall clamping absorbed a retreat so closing overtook separation,
  // clamp closing first to preserve tangential orbit along the boundary.
  if (
    distance(candidates.blue, candidates.red) < rules.separation - epsilon &&
    closing > epsilon &&
    initialClosingFraction > 0
  ) {
    const zero = candidatesForClosing(0);
    if (distance(zero.blue, zero.red) >= rules.separation) {
      let lo = 0,
        hi = initialClosingFraction;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        const next = candidatesForClosing(mid);
        if (distance(next.blue, next.red) >= rules.separation) lo = mid;
        else hi = mid;
      }
      candidates = candidatesForClosing(lo);
    } else {
      candidates = zero;
    }
  }

  const at = (id: Side, t: number) => ({
    x: before[id].x + (candidates[id].x - before[id].x) * t,
    z: before[id].z + (candidates[id].z - before[id].z) * t,
  });
  let alpha = 1;
  if (distance(candidates.blue, candidates.red) < rules.separation - epsilon) {
    let lo = 0,
      hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (distance(at('blue', mid), at('red', mid)) >= rules.separation) lo = mid;
      else hi = mid;
    }
    alpha = lo;
  }
  return { blue: at('blue', alpha), red: at('red', alpha) };
}

export interface WorldVelocity {
  vx: number;
  vz: number;
}

/**
 * Linear world/ring-space movement for stable-facing VR locomotion.
 * Translates each fighter linearly along its requested XZ velocity without
 * circular orbit projection around the opponent, while enforcing ring boundary
 * and minimum separation (sliding cleanly around a stationary opponent).
 */
export function arenaLinearMovement(
  before: Record<Side, ArenaPoint>,
  velocity: Record<Side, WorldVelocity>,
  dt: number,
  rules: { boundary: number; separation: number }
): Record<Side, ArenaPoint> {
  const epsilon = 1e-7;
  const cand: Record<Side, ArenaPoint> = {
    blue: boundPoint(
      { x: before.blue.x + velocity.blue.vx * dt, z: before.blue.z + velocity.blue.vz * dt },
      rules.boundary
    ),
    red: boundPoint(
      { x: before.red.x + velocity.red.vx * dt, z: before.red.z + velocity.red.vz * dt },
      rules.boundary
    ),
  };

  const candDist = distance(cand.blue, cand.red);
  if (candDist >= rules.separation - epsilon) return cand;

  let nx = cand.blue.x - cand.red.x;
  let nz = cand.blue.z - cand.red.z;
  let norm = Math.hypot(nx, nz);
  if (norm <= epsilon) {
    nx = before.blue.x - before.red.x;
    nz = before.blue.z - before.red.z;
    norm = Math.max(epsilon, Math.hypot(nx, nz));
  }
  nx /= norm;
  nz /= norm;

  const bSpeed = Math.hypot(velocity.blue.vx, velocity.blue.vz);
  const rSpeed = Math.hypot(velocity.red.vx, velocity.red.vz);
  const blueShare = rSpeed <= epsilon ? 1 : bSpeed <= epsilon ? 0 : 0.5;
  const redShare = 1 - blueShare;
  const deficit = rules.separation - candDist;

  const pushed: Record<Side, ArenaPoint> = {
    blue: boundPoint(
      { x: cand.blue.x + nx * deficit * blueShare, z: cand.blue.z + nz * deficit * blueShare },
      rules.boundary
    ),
    red: boundPoint(
      { x: cand.red.x - nx * deficit * redShare, z: cand.red.z - nz * deficit * redShare },
      rules.boundary
    ),
  };

  if (distance(pushed.blue, pushed.red) >= rules.separation - epsilon) return pushed;

  // Wall pinch fallback: interpolate from valid `before` toward `pushed` so both
  // separation and ring boundary invariants always hold.
  const at = (id: Side, t: number): ArenaPoint => ({
    x: before[id].x + (pushed[id].x - before[id].x) * t,
    z: before[id].z + (pushed[id].z - before[id].z) * t,
  });
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (distance(at('blue', mid), at('red', mid)) >= rules.separation) lo = mid;
    else hi = mid;
  }
  return { blue: at('blue', lo), red: at('red', lo) };
}
