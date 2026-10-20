import type { SceneResource } from "@/kernel/api/apiTypes";

export type AntennaOwnedResourceKind = "port" | "solution" | "projection" | "drive" | "spectrum";

function unique<T extends { id: string }>(items: readonly T[], id: string): T | null {
  const matches = items.filter(item => item.id === id);
  return matches.length === 1 ? matches[0] : null;
}

/** Scene navigation ownership; this does not validate or invalidate a saved asset. */
export function antennaResourceOwner(scene: SceneResource, kind: AntennaOwnedResourceKind, id: string): string | null {
  const stage = (stageId: string) => unique(scene.antenna_field_solve_stages ?? [], stageId);
  const projection = (projectionId: string) => unique(scene.antenna_target_projections ?? [], projectionId);
  if (kind === "port") return unique(scene.antenna_port_modes ?? [], id)?.source_object_id ?? null;
  if (kind === "solution") return stage(id)?.source_object_id ?? null;
  if (kind === "projection") {
    const item = projection(id);
    return item ? stage(item.solution.stage_id)?.source_object_id ?? null : null;
  }
  if (kind === "spectrum") {
    const item = unique(scene.antenna_spectrum_requests ?? [], id);
    return item ? stage(item.solution_ref.stage_id)?.source_object_id ?? null : null;
  }
  const drive = unique(scene.solved_antenna_drives ?? [], id);
  const bound = drive ? projection(drive.projection_ref) : null;
  return bound ? stage(bound.solution.stage_id)?.source_object_id ?? null : null;
}
