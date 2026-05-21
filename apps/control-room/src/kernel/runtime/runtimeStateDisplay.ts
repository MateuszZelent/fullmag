export interface RuntimeStateSource {
  detailedRuntimeState?: unknown;
  sessionSolverState?: unknown;
}

export function resolveEffectiveRuntimeState({
  detailedRuntimeState,
  sessionSolverState,
}: RuntimeStateSource): string | null {
  return normalizeRuntimeState(detailedRuntimeState) ?? normalizeRuntimeState(sessionSolverState);
}

export function formatRuntimeStateLabel(
  value: unknown,
  fallback = "unknown",
): string {
  const token = normalizeRuntimeState(value);
  if (!token) return fallback;
  const label = token.replaceAll(/[-_]+/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function isRuntimeStateActive(value: unknown): boolean {
  return normalizeRuntimeState(value) === "running";
}

export function isRuntimeStateWaitingForCompute(value: unknown): boolean {
  return normalizeRuntimeState(value) === "waiting_for_compute";
}

export function readDetailedRuntimeState(resource: unknown): string | null {
  if (!resource || typeof resource !== "object") return null;
  return normalizeRuntimeState(
    (resource as { runtime_state?: unknown }).runtime_state,
  );
}

function normalizeRuntimeState(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;
}
