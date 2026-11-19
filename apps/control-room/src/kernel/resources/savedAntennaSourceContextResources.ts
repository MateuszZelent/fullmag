"use client";

import { useCallback } from "react";

import type { ControlRoomApi } from "../api/ControlRoomApi";
import type { MaterializedDatasetResource, SavedFieldGeometryResource } from "../api/apiTypes";
import type { DecodedTopology } from "../api/codecs/types";
import { isSavedOwnedSampleGeometry } from "../api/savedGeometryIdentity";
import { useKernel } from "../KernelContext";
import { savedGeometryResourceKey } from "./savedGeometryResources";
import type { ResourceResult } from "./resourceTypes";
import { validateMaterializedDatasetEnvelope, validateSolutionSetEnvelope } from "./solutionSetResources";
import { useResource } from "./useResource";

export type SavedAntennaSourceContext =
  | {
    status: "ready";
    fieldDatasetKey: string;
    dataset: MaterializedDatasetResource;
    geometry: SavedFieldGeometryResource;
    topology: DecodedTopology;
  }
  | { status: "loading" | "unavailable" | "error"; reason: string };

type SourceDatasetSelection =
  | { status: "ready"; dataset: MaterializedDatasetResource }
  | { status: "unavailable"; reason: string };

type SourceContextClient = Pick<ControlRoomApi["persistence"]["projects"],
  "solutionSetArtifacts" | "materializedDataset" | "savedFieldGeometry" | "savedFieldTopology">;

function isInspectionField(dataset: MaterializedDatasetResource, quantity: "H_ant" | "V_electric") {
  const field = dataset.field;
  return dataset.integrity === "verified"
    && field.producer_id === "fullmag.closed-loop-inspection" && field.producer_version === "2"
    && field.descriptor.quantity_id === quantity
    && field.descriptor.unit === (quantity === "H_ant" ? "A/m" : "V")
    && field.coverage.component_count === (quantity === "H_ant" ? "3" : "1")
    && field.descriptor.value_representation === "physical_field"
    && field.descriptor.normalization === "none" && field.descriptor.complex_encoding === "real"
    && field.descriptor.sample_location === "node" && field.accepted_state == null;
}

/** Associate immutable siblings; names and the currently edited scene are not evidence. */
export function resolveSavedAntennaSourceDataset(
  field: MaterializedDatasetResource,
  candidates: readonly MaterializedDatasetResource[],
): SourceDatasetSelection {
  if (!isInspectionField(field, "H_ant")) {
    return { status: "unavailable", reason: "Saved field is not a closed-loop antenna H result." };
  }
  const matches = candidates.filter((source) =>
    isInspectionField(source, "V_electric")
    && source.project_id === field.project_id && source.run_id === field.run_id
    && source.solution_set_id === field.solution_set_id
    && source.containing_solution_revision === field.containing_solution_revision
    && source.owner_solution_revision === field.owner_solution_revision
    && source.member_id === field.member_id && source.item_id === field.item_id
    && source.field.item_id === field.field.item_id
    && source.source.run_id === field.source.run_id
    && source.source.solution_set_id === field.source.solution_set_id
    && source.source.solution_revision === field.source.solution_revision
    && source.source.member_id === field.source.member_id
    && source.source.run_spec_digest === field.source.run_spec_digest);
  if (matches.length !== 1) {
    return {
      status: "unavailable",
      reason: matches.length === 0
        ? "No uniquely associated saved conductor geometry is available."
        : "Multiple saved conductor datasets match this field; source context is ambiguous.",
    };
  }
  return { status: "ready", dataset: matches[0]! };
}

/** Fetch only archived metadata and source topology, never scalar values or live geometry. */
export async function loadSavedAntennaSourceContext(
  client: SourceContextClient,
  field: MaterializedDatasetResource,
  signal: AbortSignal,
): Promise<SavedAntennaSourceContext> {
  if (!isInspectionField(field, "H_ant")) {
    return { status: "unavailable", reason: "Saved field is not a closed-loop antenna H result." };
  }
  const identity = {
    projectId: field.project_id, runId: field.run_id, solutionSetId: field.solution_set_id,
    revision: field.containing_solution_revision, memberId: field.member_id,
  };
  validateMaterializedDatasetEnvelope(field, { ...identity, artifactId: field.artifact_id });
  const candidates: MaterializedDatasetResource[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  let manifest: string | undefined;
  // Metadata discovery is bounded independently of the topology transport budget.
  for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
    signal.throwIfAborted();
    const page = validateSolutionSetEnvelope(await client.solutionSetArtifacts(
      identity.projectId, identity.runId, identity.solutionSetId, identity.revision,
      identity.memberId, { limit: 100, after_artifact_id: after }, { signal },
    ), identity);
    if (page.items.length > 100 || (manifest !== undefined && page.manifest_digest !== manifest)) {
      throw new Error("Saved source artifact discovery changed its pinned manifest.");
    }
    manifest = page.manifest_digest;
    for (const artifact of page.items) {
      if (seen.has(artifact.artifact_id)) throw new Error("Saved source artifact discovery repeated an artifact.");
      seen.add(artifact.artifact_id);
      if (artifact.schema_id !== "fullmag.materialized_dataset.v1") continue;
      const dataset = validateMaterializedDatasetEnvelope(await client.materializedDataset(
        identity.projectId, identity.runId, identity.solutionSetId, identity.revision,
        identity.memberId, artifact.artifact_id, { signal },
      ), { ...identity, artifactId: artifact.artifact_id });
      if (dataset.manifest_object_ref !== artifact.object_ref || dataset.manifest_byte_length !== artifact.byte_length) {
        throw new Error("Saved source dataset differs from its pinned artifact.");
      }
      if (resolveSavedAntennaSourceDataset(field, [dataset]).status === "ready") candidates.push(dataset);
    }
    const next = page.next_after_artifact_id;
    if (next == null) {
      const selection = resolveSavedAntennaSourceDataset(field, candidates);
      if (selection.status !== "ready") return selection;
      const dataset = selection.dataset;
      const geometry = await client.savedFieldGeometry(dataset, { signal });
      if (!isSavedOwnedSampleGeometry(geometry)) {
        return { status: "unavailable", reason: "Saved conductor geometry has an unsupported source representation." };
      }
      const topology = await client.savedFieldTopology(dataset, geometry, { signal });
      if (topology === null) {
        return { status: "unavailable", reason: "Saved conductor topology exceeds its bounded transport." };
      }
      return { status: "ready", fieldDatasetKey: savedGeometryResourceKey(field), dataset, geometry, topology };
    }
    if (next === after || !seen.has(next)) throw new Error("Saved source artifact cursor did not advance.");
    after = next;
  }
  return { status: "unavailable", reason: "Saved conductor discovery exceeds its bounded metadata budget." };
}

export function resolveSavedAntennaSourceContextResource(
  field: MaterializedDatasetResource | null,
  resource: ResourceResult<SavedAntennaSourceContext>,
  enabled = true,
): SavedAntennaSourceContext {
  if (!enabled || field === null) return { status: "unavailable", reason: "No saved antenna field is selected." };
  if (!isInspectionField(field, "H_ant")) {
    return { status: "unavailable", reason: "Saved field is not a closed-loop antenna H result." };
  }
  if (resource.error || resource.refreshError) {
    return { status: "error", reason: (resource.error ?? resource.refreshError)!.message };
  }
  const data = resource.data;
  if (data?.status === "ready") {
    return data.fieldDatasetKey === savedGeometryResourceKey(field)
      ? data : { status: "loading", reason: "Loading source context for the selected saved field." };
  }
  return data ?? { status: "loading", reason: "Loading saved conductor geometry." };
}

export function useSavedAntennaSourceContextResources(
  dataset: MaterializedDatasetResource | null,
  enabled = true,
): SavedAntennaSourceContext {
  const { api } = useKernel();
  const load = useCallback(({ signal }: { signal: AbortSignal }) => {
    if (!dataset) throw new Error("A pinned saved antenna field is required.");
    return loadSavedAntennaSourceContext(api.persistence.projects, dataset, signal);
  }, [api, dataset]);
  const resource = useResource<SavedAntennaSourceContext>({
    abortStaleInflight: true, enabled: enabled && dataset !== null && isInspectionField(dataset, "H_ant"),
    load, retryPolicy: null,
    resourceKey: dataset ? "saved-antenna-source-context:" + savedGeometryResourceKey(dataset) : "saved-antenna-source-context:idle",
    resolveRevision: (data) => data.status === "ready" ? data.geometry.geometry_manifest.object_ref : null,
  });
  return resolveSavedAntennaSourceContextResource(dataset, resource, enabled);
}
