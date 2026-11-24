"use client";

import { useCallback } from "react";

import { ControlRoomApiError, type ControlRoomApi } from "../api/ControlRoomApi";
import { isCanonicalU64Decimal } from "../api/fieldQueryIdentity";
import type { MaterializedDatasetResource, SavedFieldGeometryResource, SolutionSetArtifactResource } from "../api/apiTypes";
import type { DecodedTopology } from "../api/codecs/types";
import { isSavedOwnedSampleGeometry } from "../api/savedGeometryIdentity";
import { useKernel } from "../KernelContext";
import { savedGeometryResourceKey } from "./savedGeometryResources";
import type { ResourceResult } from "./resourceTypes";
import { validateMaterializedDatasetEnvelope, validateSolutionSetDiscoveryEnvelope, validateSolutionSetEnvelope } from "./solutionSetResources";
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
  "solutionSets" | "solutionSetMembers" | "solutionSetArtifacts" | "materializedDataset" | "savedFieldGeometry" | "savedFieldTopology">;

export function isInspectionField(dataset: MaterializedDatasetResource, quantity: "H_ant" | "V_electric") {
  const field = dataset.field;
  return dataset.integrity === "verified"
    && ((field.producer_id === "fullmag.closed-loop-inspection" && field.producer_version === "2")
      || (quantity === "H_ant" && field.producer_id === "fullmag.retained-current-field" && field.producer_version === "1"))
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
  if (!isInspectionField(field, "H_ant") || field.field.producer_id !== "fullmag.closed-loop-inspection") {
    return { status: "unavailable", reason: "Saved field has no same-result closed-loop conductor." };
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

/** Discover only the exact historical parent authenticated by the H-only package. */
async function loadRetainedParentDataset(
  client: SourceContextClient, field: MaterializedDatasetResource, signal: AbortSignal,
): Promise<SourceDatasetSelection> {
  signal.throwIfAborted();
  let fieldGeometry: SavedFieldGeometryResource;
  try {
    fieldGeometry = await client.savedFieldGeometry(field, { signal }, { include_antenna_source_context: true });
  } catch (error) {
    if (error instanceof ControlRoomApiError && error.status === 409) {
      return { status: "unavailable", reason: "Saved antenna source provenance could not be verified." };
    }
    throw error;
  }
  const context = fieldGeometry.antenna_source_context;
  const sourcePackage = context?.source_package;
  const parent = context?.parent;
  if (context?.purpose !== "historical_geometry_only" || !sourcePackage || !parent
    || sourcePackage.artifact_id !== field.field.item_id || field.item_id !== field.field.item_id
    || sourcePackage.kind !== "other" || sourcePackage.accepted_state != null
    || (sourcePackage.schema_id !== "fullmag.antenna.retained_current_field_bundle@v1"
      && sourcePackage.schema_id !== "fullmag.antenna.retained_current_field_bundle@v2")
    || !/^[a-f0-9]{64}$/.test(sourcePackage.object_ref)
    || !isCanonicalU64Decimal(sourcePackage.byte_length) || sourcePackage.byte_length === "0"
    || parent.project_id !== field.project_id || parent.run_id === field.run_id
    || !/^[a-f0-9]{64}$/.test(parent.package_object_ref)
    || !isCanonicalU64Decimal(parent.package_byte_length) || parent.package_byte_length === "0"
    || !isCanonicalU64Decimal(parent.ownership_epoch) || parent.ownership_epoch === "0") {
    return { status: "unavailable", reason: "No verified historical antenna source context is available." };
  }
  const candidates: MaterializedDatasetResource[] = [];
  let requests = 0;
  const consumeRequest = () => {
    signal.throwIfAborted();
    if (++requests > 64) throw new Error("Saved antenna source discovery exceeds its bounded metadata budget.");
  };
  const solutions = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
    consumeRequest();
    const discovery = validateSolutionSetDiscoveryEnvelope(await client.solutionSets(
      parent.project_id, parent.run_id, { limit: 50, cursor }, { signal },
    ), parent.project_id, parent.run_id, { limit: 50, cursor });
    for (const solution of discovery.items) {
      if (solutions.has(solution.solution_set_id)) throw new Error("Saved parent discovery repeated a solution.");
      solutions.add(solution.solution_set_id);
      const identity = { projectId: parent.project_id, runId: parent.run_id,
        solutionSetId: solution.solution_set_id, revision: solution.revision };
      let afterMember: string | undefined;
      const membersSeen = new Set<string>();
      for (let memberPage = 0; memberPage < 10; memberPage += 1) {
        consumeRequest();
        const members = validateSolutionSetEnvelope(await client.solutionSetMembers(
          identity.projectId, identity.runId, identity.solutionSetId, identity.revision,
          { limit: 100, after_member_id: afterMember }, { signal },
        ), identity);
        if (members.items.length > 100 || members.manifest_digest !== solution.manifest_digest) {
          throw new Error("Saved parent members changed their pinned manifest.");
        }
        for (const member of members.items) {
          if (membersSeen.has(member.member_id)) throw new Error("Saved parent discovery repeated a member.");
          membersSeen.add(member.member_id);
          if (member.task_id !== parent.task_id || member.attempt_id !== parent.attempt_id
            || member.ownership_epoch !== parent.ownership_epoch || member.stage_id !== parent.study_step_id
            || member.case_id !== "default" || member.execution_status !== "succeeded") continue;
          const artifacts: SolutionSetArtifactResource[] = [];
          const artifactsSeen = new Set<string>();
          let afterArtifact: string | undefined;
          for (let artifactPage = 0; artifactPage < 10; artifactPage += 1) {
            consumeRequest();
            const page = validateSolutionSetEnvelope(await client.solutionSetArtifacts(
              identity.projectId, identity.runId, identity.solutionSetId, identity.revision, member.member_id,
              { limit: 100, after_artifact_id: afterArtifact }, { signal },
            ), identity);
            if (page.items.length > 100 || page.member_id !== member.member_id
              || page.manifest_digest !== solution.manifest_digest) throw new Error("Saved parent artifacts changed their pinned owner.");
            for (const artifact of page.items) {
              if (artifactsSeen.has(artifact.artifact_id)) throw new Error("Saved parent discovery repeated an artifact.");
              artifactsSeen.add(artifact.artifact_id); artifacts.push(artifact);
            }
            const next = page.next_after_artifact_id;
            if (next == null) break;
            if (artifactPage === 9 || next === afterArtifact || !artifactsSeen.has(next)) {
              throw new Error("Saved parent artifact discovery exceeds its bounded metadata budget.");
            }
            afterArtifact = next;
          }
          const packages = artifacts.filter((artifact) => artifact.artifact_id === parent.artifact_id);
          const packageArtifact = packages[0];
          if (packages.length !== 1 || !packageArtifact || packageArtifact.object_ref !== parent.package_object_ref
            || packageArtifact.byte_length !== parent.package_byte_length || packageArtifact.kind !== "other"
            || packageArtifact.accepted_state != null || packageArtifact.schema_id !== "fullmag.antenna.closed_loop_bundle@v1") continue;
          for (const artifact of artifacts) {
            if (artifact.schema_id !== "fullmag.materialized_dataset.v1") continue;
            consumeRequest();
            const dataset = validateMaterializedDatasetEnvelope(await client.materializedDataset(
              identity.projectId, identity.runId, identity.solutionSetId, identity.revision, member.member_id,
              artifact.artifact_id, { signal },
            ), { ...identity, memberId: member.member_id, artifactId: artifact.artifact_id });
            if (dataset.manifest_object_ref !== artifact.object_ref || dataset.manifest_byte_length !== artifact.byte_length) {
              throw new Error("Saved parent dataset differs from its pinned artifact.");
            }
            if (isInspectionField(dataset, "V_electric") && dataset.item_id === parent.artifact_id
              && dataset.field.item_id === parent.artifact_id && dataset.source.run_id === parent.run_id
              && dataset.source.solution_set_id === identity.solutionSetId && dataset.source.member_id === member.member_id
              && dataset.source.solution_revision === dataset.owner_solution_revision) candidates.push(dataset);
          }
        }
        const next = members.next_after_member_id;
        if (next == null) break;
        if (memberPage === 9 || next === afterMember || !membersSeen.has(next)) {
          throw new Error("Saved parent member discovery exceeds its bounded metadata budget.");
        }
        afterMember = next;
      }
    }
    const next = discovery.next_cursor;
    if (next == null) {
      return candidates.length === 1 ? { status: "ready", dataset: candidates[0]! }
        : { status: "unavailable", reason: "No unique saved conductor matches the historical parent pins." };
    }
    if (cursors.has(next)) throw new Error("Saved parent discovery cursor did not advance.");
    cursors.add(next); cursor = next;
  }
  return { status: "unavailable", reason: "Saved parent discovery exceeds its bounded metadata budget." };
}

async function loadSourceGeometry(
  client: SourceContextClient, field: MaterializedDatasetResource,
  dataset: MaterializedDatasetResource, signal: AbortSignal,
): Promise<SavedAntennaSourceContext> {
  signal.throwIfAborted();
  const geometry = await client.savedFieldGeometry(dataset, { signal });
  if (!isSavedOwnedSampleGeometry(geometry)) {
    return { status: "unavailable", reason: "Saved conductor geometry has an unsupported source representation." };
  }
  const topology = await client.savedFieldTopology(dataset, geometry, { signal });
  if (topology === null) return { status: "unavailable", reason: "Saved conductor topology exceeds its bounded transport." };
  return { status: "ready", fieldDatasetKey: savedGeometryResourceKey(field), dataset, geometry, topology };
}

/** Fetch only archived metadata and source topology, never scalar values or live geometry. */
export async function loadSavedAntennaSourceContext(
  client: SourceContextClient,
  field: MaterializedDatasetResource,
  signal: AbortSignal,
): Promise<SavedAntennaSourceContext> {
  if (!isInspectionField(field, "H_ant")) {
    return { status: "unavailable", reason: "Saved field is not a supported raw antenna H result." };
  }
  const identity = {
    projectId: field.project_id, runId: field.run_id, solutionSetId: field.solution_set_id,
    revision: field.containing_solution_revision, memberId: field.member_id,
  };
  validateMaterializedDatasetEnvelope(field, { ...identity, artifactId: field.artifact_id });
  if (field.field.producer_id === "fullmag.retained-current-field") {
    const selection = await loadRetainedParentDataset(client, field, signal);
    return selection.status === "ready" ? loadSourceGeometry(client, field, selection.dataset, signal) : selection;
  }
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
      // Keep one in-flight metadata read per inspection and verify it against the pinned manifest.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
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
      return loadSourceGeometry(client, field, selection.dataset, signal);
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
    return { status: "unavailable", reason: "Saved field is not a supported raw antenna H result." };
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
): SavedAntennaSourceContext & { refetch: (() => void) | null } {
  const { api } = useKernel();
  const load = useCallback(({ signal }: { signal: AbortSignal }) => {
    if (!dataset) throw new Error("A pinned saved antenna field is required.");
    return loadSavedAntennaSourceContext(api.persistence.projects, dataset, signal);
  }, [api, dataset]);
  const sourceContextEnabled = enabled && dataset !== null && isInspectionField(dataset, "H_ant");
  const resource = useResource<SavedAntennaSourceContext>({
    abortStaleInflight: true, enabled: sourceContextEnabled,
    load, retryPolicy: null,
    resourceKey: dataset ? "saved-antenna-source-context:" + savedGeometryResourceKey(dataset) : "saved-antenna-source-context:idle",
    resolveRevision: (data) => data.status === "ready" ? data.geometry.geometry_manifest.object_ref : null,
  });
  return {
    ...resolveSavedAntennaSourceContextResource(dataset, resource, enabled),
    refetch: sourceContextEnabled ? resource.refetch : null,
  };
}
