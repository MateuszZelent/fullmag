import type { FieldCatalogResource, FieldMetaResource, QuantityCatalogResource, StageExecutionResource } from "../api/apiTypes";
import { quantityCatalogEntrySupportsSpatialVisualization } from "../api/quantityIds";
import type { SessionResourceIdentity } from "../resources/sessionResourceIdentity";

/** Client-owned immutable inspection selection; never a physics activation. */
export interface ArtifactFieldSelection {
  identity: SessionResourceIdentity;
  runId: string;
  runtimeStageId: string;
  authoredStageId: string;
  sourceObjectId: string;
  /** Carrier pins belong to this quantity; source/run selection is shared. */
  quantityId?: string;
  carrierId?: string;
  carrierRevision?: string;
  carrierScopeKind?: "object" | "full";
  carrierScopeId?: string | null;
}
export function artifactSelectionMatchesSession(selection: ArtifactFieldSelection | null, identity: SessionResourceIdentity | null): boolean {
  return Boolean(selection && identity && selection.identity.sessionId === identity.sessionId && selection.identity.sessionEpoch === identity.sessionEpoch && selection.identity.requestScopeEpoch === identity.requestScopeEpoch);
}

/** Historical artifact routing never follows a quantity name alone. */
export function artifactInspectionQuantity(catalog: QuantityCatalogResource | null, quantityId: string): boolean {
  if (quantityId !== "H_ant" && quantityId !== "J_charge" && quantityId !== "V_electric") return false;
  const entries = Array.isArray(catalog?.quantities) ? catalog.quantities.filter(entry => entry?.id === quantityId) : [];
  if (entries.length !== 1) return false;
  const entry = entries[0], capability = entry.resolved_capability, components = quantityId === "V_electric" ? 1 : 3;
  return Boolean(entry.n_comp === components && entry.unit === (quantityId === "V_electric" ? "V" : quantityId === "J_charge" ? "A/m^2" : "A/m") &&
    quantityCatalogEntrySupportsSpatialVisualization(entry) && capability?.quantity_id === quantityId &&
    capability.lane === "artifact_inspection_read_only" && capability.materialization === "materialized" &&
    Array.isArray(capability.carriers) && capability.carriers.some(carrier => carrier.payload_state === "historical" && carrier.components === components &&
      (quantityId === "V_electric" ? carrier.indexing === "source_nodes" : quantityId === "J_charge" ? carrier.indexing === "tet4_cell_local_nodes" : ["sample_nodes", "point_samples"].includes(carrier.indexing))));
}

export function artifactSelectionForQuantity(selection: ArtifactFieldSelection | null, quantityId: string): ArtifactFieldSelection | null {
  if (!selection || selection.quantityId === quantityId) return selection;
  return { identity: selection.identity, runId: selection.runId, runtimeStageId: selection.runtimeStageId,
    authoredStageId: selection.authoredStageId, sourceObjectId: selection.sourceObjectId, quantityId };
}

export interface ArtifactInspectorFieldQuery {
  stage_id: string;
  carrier_id: string;
  expected_carrier_revision: string;
  view: "full";
  scope_kind: "object" | "full";
  scope_id: string | null;
}
export interface ArtifactInspectorFieldBinding {
  historical: boolean;
  query: ArtifactInspectorFieldQuery | null;
  identityKey: string | null;
  expectedOwner: {
    session_id: string; session_epoch: string; request_scope_epoch: string;
    run_id: string; authored_stage_id: string; runtime_stage_id: string; object_id: string;
    quantityId: string;
  } | null;
}

/** A historical lane never falls back to an unpinned current-field request. */
export function artifactInspectorFieldBinding({ catalog, catalogReady = true, inspectionOnly = false, quantityId, selection, sessionIdentity, targetScope }: {
  catalog: QuantityCatalogResource | null;
  catalogReady?: boolean;
  inspectionOnly?: boolean;
  quantityId: string;
  selection: ArtifactFieldSelection | null;
  sessionIdentity: SessionResourceIdentity | null;
  targetScope: { scopeKind: string; scopeId: string | null } | null;
}): ArtifactInspectorFieldBinding {
  const historical = inspectionOnly || Boolean(catalog?.quantities.some(entry => entry.id === quantityId && entry.resolved_capability?.lane === "artifact_inspection_read_only"));
  const blocked = { historical, query: null, identityKey: null, expectedOwner: null };
  if (!historical || !catalogReady || !artifactInspectionQuantity(catalog, quantityId) || !selection || !sessionIdentity || !artifactSelectionMatchesSession(selection, sessionIdentity) || selection.quantityId !== quantityId) return blocked;
  const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (![sessionIdentity.sessionId, sessionIdentity.sessionEpoch, sessionIdentity.requestScopeEpoch, selection.runId, selection.authoredStageId, selection.runtimeStageId, selection.sourceObjectId, selection.carrierId, selection.carrierRevision].every(nonempty)) return blocked;
  const scopeKind = selection.carrierScopeKind, scopeId = selection.carrierScopeId;
  if (scopeKind === "object") {
    if (!nonempty(scopeId) || targetScope?.scopeKind !== "object" || targetScope.scopeId !== scopeId) return blocked;
  } else if (scopeKind !== "full" || scopeId !== null) return blocked;
  const query: ArtifactInspectorFieldQuery = {
    stage_id: selection.runtimeStageId, carrier_id: selection.carrierId!, expected_carrier_revision: selection.carrierRevision!,
    view: "full", scope_kind: scopeKind, scope_id: scopeId,
  };
  const expectedOwner = {
    session_id: sessionIdentity.sessionId, session_epoch: sessionIdentity.sessionEpoch, request_scope_epoch: sessionIdentity.requestScopeEpoch,
    run_id: selection.runId, authored_stage_id: selection.authoredStageId, runtime_stage_id: selection.runtimeStageId, object_id: selection.sourceObjectId, quantityId,
  };
  const identityKey = JSON.stringify([expectedOwner.session_id, expectedOwner.session_epoch, expectedOwner.request_scope_epoch, quantityId,
    selection.runId, selection.authoredStageId, selection.runtimeStageId, selection.sourceObjectId, query.carrier_id, query.expected_carrier_revision,
    scopeKind, scopeId, targetScope?.scopeKind ?? null, targetScope?.scopeId ?? null]);
  return { historical, query, identityKey, expectedOwner };
}

/** A successful response still has to belong to the exact pinned inspection. */
export function artifactInspectorMetadataMatchesBinding(metadata: FieldMetaResource | null, binding: ArtifactInspectorFieldBinding): boolean {
  const { query, expectedOwner: expected } = binding;
  if (!binding.historical || !query || !expected || !metadata?.artifact_field_locator) return false;
  const locator = metadata.artifact_field_locator;
  if (typeof locator !== "object" || Array.isArray(locator) || !locator.owner || typeof locator.owner !== "object" || Array.isArray(locator.owner)) return false;
  const owner = locator.owner, capability = metadata.resolved_capability;
  const quantityId = expected.quantityId, components = quantityId === "V_electric" ? 1 : 3;
  const unit = quantityId === "V_electric" ? "V" : quantityId === "J_charge" ? "A/m^2" : "A/m";
  return metadata.quantity_id === quantityId && metadata.unit === unit && metadata.components === components &&
    metadata.state === "stale_complete" && metadata.materialization_reason_code === "historical_inspection_read_only" &&
    capability?.quantity_id === quantityId && capability.lane === "artifact_inspection_read_only" && capability.provider === "available" &&
    capability.request === "field_vector" && capability.render === "renderable" && capability.publication === "interactive" && capability.materialization === "materialized" &&
    owner.historical_inspection === true && owner.session_id === expected.session_id && owner.session_epoch === expected.session_epoch &&
    owner.request_scope_epoch === expected.request_scope_epoch && owner.run_id === expected.run_id && owner.authored_stage_id === expected.authored_stage_id &&
    owner.runtime_stage_id === expected.runtime_stage_id && owner.object_id === expected.object_id &&
    locator.carrier_id === query.carrier_id && locator.carrier_revision === query.expected_carrier_revision &&
    locator.carrier_scope_kind === query.scope_kind && (locator.carrier_scope_id ?? null) === query.scope_id &&
    (quantityId === "V_electric" ? locator.indexing === "source_nodes" : quantityId === "J_charge" ? locator.indexing === "tet4_cell_local_nodes" : ["sample_nodes", "point_samples"].includes(locator.indexing));
}

/** Presentation identity is pinned to the same immutable owner as Inspector metadata. */
export function artifactCarrierPresentationKey(
  owner: ArtifactInspectorFieldBinding["expectedOwner"],
  carrier: Pick<ArtifactInspectorFieldQuery, "carrier_id" | "expected_carrier_revision" | "scope_kind" | "scope_id"> | null,
): string | null {
  if (!owner || !carrier) return null;
  return JSON.stringify(["artifact-surface", owner.session_id, owner.session_epoch, owner.request_scope_epoch,
    owner.run_id, owner.authored_stage_id, owner.runtime_stage_id, owner.object_id, owner.quantityId,
    carrier.carrier_id, carrier.expected_carrier_revision, carrier.scope_kind, carrier.scope_id]);
}

export function artifactInspectionOwnerPlan(definitions: ReadonlyArray<{ id?: string; source_object_id?: string }>, execution: StageExecutionResource | null, identity: { sessionId: string; sessionEpoch: string; requestScopeEpoch: string } | null, selection: ArtifactFieldSelection | null) {
  const candidates: Array<ArtifactFieldSelection & { status: string }> = [];
  if (!identity || !execution) return { candidates, selected: null, error: null };
  if (execution.session_id !== identity.sessionId || execution.session_epoch !== identity.sessionEpoch || execution.request_scope_epoch !== identity.requestScopeEpoch || !execution.run_id) return { candidates, selected: null, error: "Inspection execution belongs to another session." };
  for (const stage of execution.stages) {
    if (!stage.antenna_solve_stage_id) continue;
    const matches = definitions.filter(d => d.id === stage.antenna_solve_stage_id);
    if (matches.length !== 1 || !matches[0].source_object_id || !stage.stage_id || candidates.some(c => c.runtimeStageId === stage.stage_id)) return { candidates: [], selected: null, error: "Inspection definition/source is missing or ambiguous; no nearest result is adopted." };
    candidates.push({ identity, runId: execution.run_id, runtimeStageId: stage.stage_id, authoredStageId: stage.antenna_solve_stage_id, sourceObjectId: matches[0].source_object_id, status: stage.status });
  }
  if (selection) {
    const found = artifactSelectionMatchesSession(selection, identity) && selection.runId === execution.run_id && candidates.find(c => c.runtimeStageId === selection.runtimeStageId && c.authoredStageId === selection.authoredStageId && c.sourceObjectId === selection.sourceObjectId);
    if (!found) return { candidates, selected: null, error: "Selected inspection owner is no longer available; select an execution explicitly." };
    return { candidates, selected: selection, error: null };
  }
  if (candidates.length === 1) return { candidates, selected: candidates[0], error: null };
  return { candidates, selected: null, error: candidates.length > 1 ? "Multiple inspection owners exist. Select a source and execution." : null };
}

export function artifactSurfaceRangeKey(
  owner: ArtifactInspectorFieldBinding["expectedOwner"],
  carrier: Pick<ArtifactInspectorFieldQuery, "carrier_id" | "expected_carrier_revision" | "scope_kind" | "scope_id"> | null,
  projectionMode: string | undefined,
): string | null {
  const key = artifactCarrierPresentationKey(owner, carrier);
  return key ? JSON.stringify([key, projectionMode ?? "raw_nodal"]) : null;
}

/** A scoped catalog must describe this exact immutable execution, never another cache entry. */
export function artifactFieldCatalogMatchesOwner(catalog: FieldCatalogResource | null, selection: ArtifactFieldSelection | null): boolean {
  if (!catalog || !selection || !Array.isArray(catalog.quantities) || catalog.quantities.length === 0) return false;
  const ids = new Set<string>();
  return catalog.quantities.every(entry => {
    if (!entry) return false;
    const locator = entry.artifact_field_locator, owner = locator?.owner;
    if (!locator || !owner || ids.has(entry.quantity_id) || !["H_ant", "J_charge", "V_electric"].includes(entry.quantity_id)) return false;
    ids.add(entry.quantity_id);
    return entry.state === "stale_complete" && owner.historical_inspection === true &&
      owner.session_id === selection.identity.sessionId && owner.session_epoch === selection.identity.sessionEpoch &&
      owner.request_scope_epoch === selection.identity.requestScopeEpoch && owner.run_id === selection.runId &&
      owner.runtime_stage_id === selection.runtimeStageId && owner.authored_stage_id === selection.authoredStageId && owner.object_id === selection.sourceObjectId &&
      entry.resolved_capability?.lane === "artifact_inspection_read_only" && Array.isArray(entry.resolved_capability.carriers) &&
      entry.resolved_capability.carriers.some(carrier => carrier.payload_state === "historical" && carrier.components === entry.components && carrier.indexing === locator.indexing &&
        carrier.carrier_id === locator.carrier_id && carrier.carrier_fingerprint === locator.carrier_digest);
  });
}

/** Only a positive live-runtime contract can release a pending historical route. */
export function artifactCatalogHasExplicitLiveQuantity(catalog: QuantityCatalogResource | null, quantityId: string): boolean {
  const entries = Array.isArray(catalog?.quantities) ? catalog.quantities.filter(entry => entry?.id === quantityId) : [];
  if (entries.length !== 1 || !["H_ant", "J_charge", "V_electric"].includes(quantityId)) return false;
  const entry = entries[0], capability = entry.resolved_capability, components = quantityId === "V_electric" ? 1 : 3;
  return Boolean(entry.n_comp === components && entry.unit === (quantityId === "V_electric" ? "V" : quantityId === "J_charge" ? "A/m^2" : "A/m") &&
    quantityCatalogEntrySupportsSpatialVisualization(entry) && capability?.quantity_id === quantityId &&
    ["fdm_cpu", "fdm_gpu", "fem_cpu", "fem_gpu"].includes(capability.lane) && capability.provider === "available" &&
    capability.request === "field_vector" && capability.render === "renderable" && Array.isArray(capability.carriers) &&
    capability.carriers.some(carrier => carrier.payload_state === "current" && carrier.components === components));
}
