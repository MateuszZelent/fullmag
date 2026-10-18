"use client";
import { useEffect, useEffectEvent, useMemo } from "react";
import { artifactCatalogHasExplicitLiveQuantity, artifactFieldCatalogMatchesOwner, artifactInspectionQuantity, artifactSelectionForQuantity } from "@/kernel/visualization/artifactFieldSelection";
import { useFieldCatalogResource, useQuantityCatalogResource, useFieldMetaResource, useStageExecutionResource } from "@/kernel/resources/studyRuntimeResources";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { useObjectVisualizationController, useObjectVisualizationSelector } from "@/kernel/visualization/useObjectVisualization";
import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import { artifactCarrierQueries, admitArtifactFieldCarrier } from "../model/artifactFieldCarrierModel";
import { artifactInspectionOwnerPlan, artifactOverlayLocator, prepareArtifactFieldOverlay, presentArtifactFieldOverlay } from "../model/artifactFieldOverlayModel";
import { useViewport3DArtifactTopology, useViewport3DFieldVectorRequest } from "../viewport3dResources";
import { buildViewport3DFieldResourceRequestId } from "../model/viewport3DFieldDataPlan";

export function useArtifactFieldOverlay(quantityId: string, targetId: string | null, settings: VisualizationTargetSettings, rawOverlayActive: boolean, definitions: ReadonlyArray<{ id?: string; source_object_id?: string }> = []) {
  const session = useSessionResourceIdentity();
  const controller = useObjectVisualizationController();
  const selection = useObjectVisualizationSelector(snapshot => snapshot.artifactFieldSelection ?? null);
  const eligible = !rawOverlayActive && ["H_ant", "J_charge", "V_electric"].includes(quantityId) && Boolean(targetId) &&
    (definitions.some(definition => definition.source_object_id === targetId) || selection?.carrierScopeKind === "object" && selection.carrierScopeId === targetId);
  const execution = useStageExecutionResource({ enabled: eligible });
  const owner = useMemo(() => artifactInspectionOwnerPlan(definitions, eligible && execution.status === "ready" && !execution.refreshError ? execution.data : null, session, selection), [eligible, definitions, execution.status, execution.refreshError, execution.data, session, selection]);
  const chosen = useMemo(() => artifactSelectionForQuantity(owner.selected, quantityId), [owner.selected, quantityId]);
  const sourceMatches = chosen?.sourceObjectId === targetId || chosen?.carrierScopeKind === "object" && chosen.carrierScopeId === targetId;
  const catalogOptions = { stageId: chosen?.runtimeStageId ?? "", runId: chosen?.runId, enabled: eligible && Boolean(chosen && sourceMatches) };
  const fieldCatalog = useFieldCatalogResource(catalogOptions);
  const quantityCatalog = useQuantityCatalogResource(catalogOptions);
  const catalog = quantityCatalog.status === "ready" && !quantityCatalog.refreshError ? quantityCatalog.data : null;
  const historical = eligible && artifactInspectionQuantity(catalog, quantityId);
  // Reserve the historical route while its execution/catalog is loading; no live-field flash.
  const explicitLive = artifactCatalogHasExplicitLiveQuantity(catalog, quantityId);
  const historicalRoute = eligible && !explicitLive;
  const catalogOwnerReady = artifactFieldCatalogMatchesOwner(fieldCatalog.data, chosen);
  const catalogError = eligible ? fieldCatalog.error?.message ?? fieldCatalog.refreshError?.message ?? quantityCatalog.error?.message ?? quantityCatalog.refreshError?.message ??
    (historical && fieldCatalog.status === "ready" && !catalogOwnerReady ? "Field catalog differs from the selected immutable execution owner." :
      quantityCatalog.status === "ready" && !historical && !explicitLive ? "Selected execution has no compatible historical quantity." : null) : null;
  const enabled = historical && catalogOwnerReady && fieldCatalog.status === "ready" && !fieldCatalog.refreshError && Boolean(sourceMatches);
  const metadata = useFieldMetaResource({ quantityId, component: "full", scope_kind: "full", stage_id: chosen?.runtimeStageId, carrier_id: chosen?.carrierId, expected_carrier_revision: chosen?.carrierRevision, enabled: enabled && Boolean(chosen), strictErrors: true });
  const plan = useMemo(() => {
    const error = eligible ? owner.error ?? execution.error?.message ?? execution.refreshError?.message ?? catalogError ?? metadata.error?.message ?? metadata.refreshError?.message : null;
    if (!enabled) return { locator: null, error: error ?? null };
    if (error || metadata.status !== "ready" || !chosen) return { locator: null, error: error ?? null };
    try { const locator = artifactOverlayLocator(metadata.data, session, targetId, quantityId === "V_electric" ? "V_electric" : quantityId === "J_charge" ? "J_charge" : "H_ant", chosen.sourceObjectId);
      if (!locator) throw new Error("Selected inspection owner has no immutable field metadata.");
      if (locator && (locator.owner.runtime_stage_id !== chosen.runtimeStageId || locator.owner.run_id !== chosen.runId || locator.owner.authored_stage_id !== chosen.authoredStageId || locator.owner.object_id !== chosen.sourceObjectId || (chosen.carrierId && chosen.carrierId !== locator.carrier_id) || (chosen.carrierRevision && chosen.carrierRevision !== locator.carrier_revision))) throw new Error("Inspection metadata differs from the selected immutable owner.");
      return { locator, error: null }; }
    catch (e) { return { locator: null, error: e instanceof Error ? e.message : "Invalid vector inspection metadata." }; }
  }, [eligible, enabled, catalogError, quantityId, metadata.status, metadata.data, metadata.error, metadata.refreshError, session, targetId, owner.error, chosen, execution.error, execution.refreshError]);
  const publishPin = useEffectEvent(() => {
    if (!plan.locator || !chosen) return;
    const current = controller.getSnapshot().artifactFieldSelection;
    if (current && (JSON.stringify(current.identity) !== JSON.stringify(chosen.identity) || current.runId !== chosen.runId || current.runtimeStageId !== chosen.runtimeStageId || current.authoredStageId !== chosen.authoredStageId || current.sourceObjectId !== chosen.sourceObjectId)) return;
    controller.setArtifactFieldSelection({ identity: chosen.identity, runId: chosen.runId, runtimeStageId: chosen.runtimeStageId, authoredStageId: chosen.authoredStageId, sourceObjectId: chosen.sourceObjectId, quantityId, carrierId: plan.locator.carrier_id, carrierRevision: plan.locator.carrier_revision, carrierScopeKind: plan.locator.carrier_scope_kind, carrierScopeId: plan.locator.carrier_scope_id });
  });
  useEffect(() => publishPin(), [controller, plan.locator, chosen]);
  const queries = useMemo(() => plan.locator ? artifactCarrierQueries(plan.locator) : null, [plan.locator]);
  const request = useMemo(() => { const query = queries?.vector ?? { component: "full" }; return { consumers: ["analysis-complex-field" as const], quantityId, query, requestId: buildViewport3DFieldResourceRequestId(quantityId, query) }; }, [queries, quantityId]);
  const vector = useViewport3DFieldVectorRequest(request, Boolean(queries));
  const topology = useViewport3DArtifactTopology(queries?.geometry ?? null);
  const prepared = useMemo(() => {
    if (!enabled) return { data: null, historical: historicalRoute || Boolean(plan.error), error: plan.error };
    const resourceError = plan.error ?? vector.error?.message ?? vector.refreshError?.message ?? topology.error?.message ?? topology.refreshError?.message;
    if (resourceError) return { data: null, historical: true, error: resourceError };
    if (!queries || !plan.locator || vector.status !== "ready" || topology.status !== "ready" || !vector.data || !vector.responseMetadata || !topology.data) return { data: null, historical: true, error: plan.error };
    try { return { data: prepareArtifactFieldOverlay(admitArtifactFieldCarrier(plan.locator, vector.data, vector.responseMetadata, topology.data, topology.responseMetadata)), historical: true, error: null }; }
    catch (e) { return { data: null, historical: true, error: e instanceof Error ? e.message : "Invalid vector inspection payload." }; }
  }, [enabled, historicalRoute, queries, plan, vector.status, vector.data, vector.responseMetadata, topology.status, topology.data, topology.responseMetadata, topology.error, topology.refreshError, vector.error, vector.refreshError]);
  const result = useMemo(() => {
    if (!prepared.data) return { model: null, historical: prepared.historical, error: prepared.error };
    try { return { model: presentArtifactFieldOverlay(prepared.data, settings), historical: true, error: null }; }
    catch (e) { return { model: null, historical: true, error: e instanceof Error ? e.message : "Invalid vector inspection presentation." }; }
  }, [prepared, settings]);
  return { ...result, catalog: catalogOwnerReady ? catalog : null, candidates: eligible ? owner.candidates.filter(candidate => candidate.sourceObjectId === targetId || sourceMatches && candidate.sourceObjectId === chosen?.sourceObjectId) : [], selectedStageId: chosen?.runtimeStageId ?? "", select: (runtimeStageId: string) => { const c = owner.candidates.find(c => c.runtimeStageId === runtimeStageId); if (c) { const { status: _status, ...pin } = c; controller.setArtifactFieldSelection(pin); } } };
}
