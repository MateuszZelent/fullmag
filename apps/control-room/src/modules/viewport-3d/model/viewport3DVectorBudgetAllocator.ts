/**
 * Deterministic global glyph allocation shared by FDM/FEM target adapters.
 * The allocator never changes field transport; it only clamps visible arrows.
 */
export interface Viewport3DVectorBudgetTarget {
  available: number;
  priority?: number;
  requested: number;
  targetId: string;
}

export interface Viewport3DVectorBudgetAllocation {
  available: number;
  effective: number;
  reason: "global-cap" | "target-cap" | "none";
  requested: number;
  targetId: string;
}

export function resolveViewport3DGlobalVectorAllocation(
  targets: readonly Viewport3DVectorBudgetTarget[],
  cap: number,
): ReadonlyMap<string, Viewport3DVectorBudgetAllocation> {
  const normalized = targets
    .map((target) => ({
      available: Math.max(0, Math.floor(Number.isFinite(target.available) ? target.available : 0)),
      priority: Number.isFinite(target.priority) ? target.priority ?? 0 : 0,
      rawRequested: Math.max(0, Math.floor(Number.isFinite(target.requested) ? target.requested : 0)),
      requested: Math.max(0, Math.floor(Number.isFinite(target.requested) ? target.requested : 0)),
      targetId: target.targetId,
    }))
    .map((target) => ({
      ...target,
      requested: Math.min(target.requested, target.available),
    }))
    .toSorted((left, right) => right.priority - left.priority || left.targetId.localeCompare(right.targetId));
  let remaining = Math.max(0, Math.floor(Number.isFinite(cap) ? cap : 0));
  const effective = new Map<string, number>(normalized.map((target) => [target.targetId, 0]));

  // Give each target a fair deterministic share before filling the remainder.
  while (remaining > 0) {
    const candidates = normalized.filter(
      (target) => (effective.get(target.targetId) ?? 0) < target.requested,
    );
    if (candidates.length === 0) break;
    const share = Math.max(1, Math.floor(remaining / candidates.length));
    let progressed = false;
    for (const target of candidates) {
      if (remaining <= 0) break;
      const current = effective.get(target.targetId) ?? 0;
      const increment = Math.min(share, target.requested - current, remaining);
      if (increment <= 0) continue;
      effective.set(target.targetId, current + increment);
      remaining -= increment;
      progressed = true;
    }
    if (!progressed) break;
  }

  return new Map(
    normalized.map((target) => {
      const allocated = effective.get(target.targetId) ?? 0;
      const requested = target.requested;
      const reason = allocated < requested
        ? "global-cap"
        : requested < target.rawRequested
          ? "target-cap"
          : "none";
      return [target.targetId, {
        available: target.available,
        effective: allocated,
        reason,
        requested,
        targetId: target.targetId,
      } satisfies Viewport3DVectorBudgetAllocation];
    }),
  );
}
