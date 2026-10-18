import type { SceneResource } from "@/kernel/api/apiTypes";
import { antennaSolveTargetKey, antennaSolveTargetOptions } from "./AntennaSolveTargetsEditorModel";
import type { SolvedDrive } from "./SolvedAntennaDriveEditorModel";

export const antennaDriveBindingKey = (projectionRef: string, portModeId: string) => JSON.stringify([projectionRef, portModeId]);

/** Offer authored pairs only; this does not certify a computed field or source. */
export function antennaDriveBindingOptions(scene: SceneResource | null, current: SolvedDrive | undefined) {
  const projections = scene?.antenna_target_projections ?? [], stages = scene?.antenna_field_solve_stages ?? [];
  const currentProjection = projections.filter(item => item.id === current?.projection_ref);
  if (!scene || currentProjection.length !== 1) return [];
  const currentStages = stages.filter(item => item.id === currentProjection[0].solution.stage_id);
  if (currentStages.length !== 1) return [];
  const sourceId = currentStages[0].source_object_id;
  const sources = scene.objects?.filter(item => item.id === sourceId) ?? [];
  if (sources.length !== 1 || sources[0].locked) return [];
  const targets = antennaSolveTargetOptions(scene);
  return projections.flatMap((projection, index) => {
    if (projections.filter(item => item.id === projection.id).length !== 1) return [];
    const sourceStages = stages.filter(item => item.id === projection.solution.stage_id);
    if (sourceStages.length !== 1) return [];
    const stage = sourceStages[0];
    if (stage.source_object_id !== sourceId || stage.port_mode_ids.length !== 1) return [];
    if ((scene.current_transports ?? []).filter(item => item.name === stage.current_transport_id).length !== 1) return [];
    const outputs = stage.outputs.filter(item => item.id === projection.solution.output_id);
    if (outputs.length !== 1 || outputs[0].quantity !== "H_ant_basis") return [];
    const ports = scene.antenna_port_modes?.filter(item => item.id === stage.port_mode_ids[0]) ?? [];
    if (ports.length !== 1 || ports[0].source_object_id !== sourceId || ports[0].current_transport_id !== stage.current_transport_id) return [];
    const targetObjectId = projection.target.kind === "global" ? null : projection.target.object_id;
    if (targetObjectId !== null && (scene.objects?.filter(item => item.id === targetObjectId).length ?? 0) !== 1) return [];
    const target = targets.filter(item => item.key === antennaSolveTargetKey(projection.target));
    if (target.length !== 1) return [];
    const portModeId = ports[0].id, projectionRef = projection.id;
    return [{ key: antennaDriveBindingKey(projectionRef, portModeId), projectionRef, portModeId,
      label: `Projection ${index + 1} → ${target[0].label}`, description: `Projection ID: ${projectionRef}. Port ID: ${portModeId}.` }];
  });
}

export function validateAntennaDriveBinding(scene: SceneResource | null, previous: SolvedDrive, updated: SolvedDrive) {
  if (previous.projection_ref === updated.projection_ref && previous.port_mode_id === updated.port_mode_id) return;
  if (!antennaDriveBindingOptions(scene, previous).some(option => option.projectionRef === updated.projection_ref && option.portModeId === updated.port_mode_id)) {
    throw new Error("Select an unambiguous projection and matching port from the same unlocked antenna.");
  }
}
