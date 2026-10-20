import type { AuthoringTransactionRequest, SceneResource } from "@/kernel/api/apiTypes";

export type AntennaSolveStage = NonNullable<SceneResource["antenna_field_solve_stages"]>[number];
export type AntennaSolveTarget = AntennaSolveStage["target_refs"][number];
export interface AntennaSolveTargetOption {
  key: string;
  label: string;
  target: AntennaSolveTarget;
}
export interface AntennaSolveTargetsDraft {
  key: string;
  baseRevision: number;
  dirty: boolean;
  targets: AntennaSolveTarget[];
  samplingDomain?: AntennaSolveTarget;
  oerstedRealization?: string;
}

export function antennaSolveTargetKey(target: AntennaSolveTarget): string {
  return JSON.stringify(target.kind === "global" ? ["global"] : target.kind === "object"
    ? ["object", target.object_id] : ["region", target.object_id, target.region_id]);
}

export function antennaSolveTargetLabel(target: AntennaSolveTarget): string {
  return target.kind === "global" ? "Global" : target.kind === "object"
    ? `Object · ${target.object_id}` : `Region · ${target.object_id} / ${target.region_id}`;
}

export function antennaSolveTargetOptions(scene: SceneResource | null): AntennaSolveTargetOption[] {
  const targets: AntennaSolveTargetOption[] = [{ key: antennaSolveTargetKey({ kind: "global" }), label: "Global", target: { kind: "global" } }];
  for (const object of scene?.objects ?? []) {
    if (!object.id) continue;
    const target: AntennaSolveTarget = { kind: "object", object_id: object.id };
    targets.push({ key: antennaSolveTargetKey(target), label: `${object.name ?? object.id} · ${object.id}`, target });
    for (const region of object.regions ?? []) {
      if (!region.region_id || region.enabled === false || (region.owner_object && region.owner_object !== object.id)) continue;
      const regionTarget: AntennaSolveTarget = { kind: "region", object_id: object.id, region_id: region.region_id };
      targets.push({ key: antennaSolveTargetKey(regionTarget), label: `${object.name ?? object.id} / ${region.name} · ${region.region_id}`, target: regionTarget });
    }
  }
  return targets;
}

/** The planner accepts domain/object Tet4 carriers; region point clouds are not implemented. */
export function antennaSamplingDomainOptions(scene: SceneResource | null): AntennaSolveTargetOption[] {
  return antennaSolveTargetOptions(scene).filter((option) => option.target.kind !== "region");
}

/** Current-driven and unresolved source lanes cannot request a vector-potential fallback. */
export function antennaVectorPotentialSelectable(scene: SceneResource | null, stage: AntennaSolveStage | undefined): boolean {
  const matches = (scene?.current_transports ?? []).filter(transport => transport.name === stage?.current_transport_id);
  if (!stage || matches.length !== 1) return false;
  const transport = matches[0];
  return transport.kind === "current_transport" && transport.model === "ohmic_poisson" &&
    transport.conservative_current_source == null && transport.external_lead_preparation == null &&
    transport.structured_current_closure == null;
}

export function buildAntennaSolveTargetsTransaction(
  scene: SceneResource, objectId: string, stageId: string, baseRevision: number, targets: readonly AntennaSolveTarget[], samplingDomain?: AntennaSolveTarget, oerstedRealization?: string,
): AuthoringTransactionRequest {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || scene.revision !== baseRevision) {
    throw new Error("Scene changed. Refresh and explicitly rebase field-solve targets.");
  }
  const object = scene.objects?.find((item) => item.id === objectId);
  if (!object || object.locked) throw new Error("Current unlocked source object is required.");
  const stages = scene.antenna_field_solve_stages ?? [];
  const matches = stages.filter((stage) => stage.id === stageId);
  if (matches.length !== 1 || matches[0].source_object_id !== objectId) throw new Error("Field-solve stage does not belong to this source object.");
  if (targets.length === 0) throw new Error("Select at least one field-solve target explicitly.");
  const valid = new Set(antennaSolveTargetOptions(scene).map((option) => option.key));
  const seen = new Set<string>();
  for (const target of targets) {
    const key = antennaSolveTargetKey(target);
    if (!valid.has(key)) throw new Error(`Unavailable field-solve target: ${antennaSolveTargetLabel(target)}.`);
    if (seen.has(key)) throw new Error("Duplicate field-solve targets are not allowed.");
    seen.add(key);
  }
  if (samplingDomain) {
    if (samplingDomain.kind === "region") throw new Error("Region sampling requires an explicit point-cloud carrier; this runtime supports Global or Object Tet4 sampling only.");
    if (!antennaSamplingDomainOptions(scene).some((option) => option.key === antennaSolveTargetKey(samplingDomain))) {
      throw new Error("Select an existing Global or Object field-sampling domain.");
    }
  }
  if (oerstedRealization !== undefined && !["direct_tetra_quadrature", "vector_potential_solver"].includes(oerstedRealization)) {
    throw new Error("Select a supported explicit Oersted realization: direct tetrahedral quadrature or FEM vector potential.");
  }
  if (oerstedRealization === "vector_potential_solver" && !antennaVectorPotentialSelectable(scene, matches[0])) {
    throw new Error("Vector potential is unavailable for current-driven or unresolved source definitions. Select direct tetrahedral quadrature explicitly; no automatic fallback is applied.");
  }
  return {
    kind: "merge_patch", base_revision: baseRevision,
    merge_patch: { antenna_field_solve_stages: stages.map((stage) => stage.id === stageId ? { ...stage, target_refs: targets.map((target) => ({ ...target })), ...(samplingDomain ? { field_sampling_domain: { ...samplingDomain } } : {}), ...(oerstedRealization !== undefined ? { oersted_realization: oerstedRealization } : {}) } : stage) },
  };
}

/** An ACK may advance the base, but must never erase edits made while awaiting it. */
export function acknowledgeAntennaSolveTargetsDraft(
  current: AntennaSolveTargetsDraft | null, submitted: AntennaSolveTargetsDraft, revision: number,
): AntennaSolveTargetsDraft | null {
  if (!Number.isSafeInteger(revision) || revision <= submitted.baseRevision) throw new Error("Invalid field-solve targets ACK revision.");
  if (current?.key !== submitted.key || current.baseRevision !== submitted.baseRevision) return current;
  return { ...current, baseRevision: revision, dirty: current !== submitted };
}
