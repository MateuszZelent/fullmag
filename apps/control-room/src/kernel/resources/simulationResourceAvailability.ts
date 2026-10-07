import type { LiveStatusResource } from "../api/apiTypes";

export function hasCurrentSimulationRun(status: LiveStatusResource | null): boolean {
  return Boolean(status?.session && status.run?.run_id);
}

export function hasSimulationPreparation(
  status: LiveStatusResource | null,
  requiredRevision: number | null = null,
): boolean {
  return Boolean(
    status?.session &&
      ((status.resources.simulation_preparation_revision ?? 0) > 0 ||
        (requiredRevision ?? 0) > 0),
  );
}
