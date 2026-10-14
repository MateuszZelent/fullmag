"use client";

import { useEffect, useMemo } from "react";
import { antennaInspectionDisplayMatchesOwner, useAntennaFieldSolutionPayloadResource, useAntennaFieldSolutionResource, useAntennaStageOutputCatalogResource, useAntennaExternalLeadInspectionResource, useAntennaInspectionDisplayResource, useAntennaInspectionDisplayPayloadResource } from "@/kernel/resources/antennaResources";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { useObjectVisualizationSelector, useObjectVisualizationController } from "@/kernel/visualization/useObjectVisualization";
import { antennaDisplayShape, antennaDisplayTopologyShape, buildAntennaFieldOverlayModel } from "../model/antennaFieldOverlayModel";
import { resolveAntennaBasisOverlayPlan } from "../model/antennaFieldOverlayPlan";
import { antennaCurrentTraceShape, buildAntennaCurrentOverlayModel, projectAntennaCurrentOverlayModel } from "../model/antennaCurrentOverlayModel";
import { antennaInspectionIntentMatchesOwner, type AntennaFieldIntent } from "@/kernel/visualization/antennaFieldIntent";

/** One data owner outside the manual R3F root. Binary arrays stay in resource cache / render model. */
export function useAntennaFieldOverlay() {
  const controller = useObjectVisualizationController();
  const requested = useObjectVisualizationSelector((snapshot) => snapshot.antennaFieldIntent ?? null);
  const owner = useSessionResourceIdentity();
  const selectedObjectId = useSelectionSelector((selection) => selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId);
  const intent = requested && owner && requested.sessionId === owner.sessionId &&
    requested.sessionEpoch === owner.sessionEpoch && requested.requestScopeEpoch === owner.requestScopeEpoch &&
    requested.sourceObjectId === selectedObjectId && (requested.points || requested.vectors || requested.surface || requested.wireframe) ? requested : null;
  const solution = useAntennaFieldSolutionResource(intent?.kind === "basis" ? intent.solutionId : null);
  const catalog = useAntennaStageOutputCatalogResource(intent?.kind === "basis" ? intent.stageId : null);
  const inspection = useAntennaExternalLeadInspectionResource(intent?.kind === "inspection" ? intent.runtimeStageId ?? null : null);
  const raw = inspection.data;
  const inspectionOwnerMatches = Boolean(intent?.kind === "inspection" && inspection.status === "ready" && !inspection.refreshError && raw &&
    antennaInspectionIntentMatchesOwner(intent, raw));
  const display = useAntennaInspectionDisplayResource(inspectionOwnerMatches ? raw : null);
  const inspectionPlan = useMemo(() => {
    const data = inspection.data;
    const metadata = display.data;
    if (!intent || intent.kind !== "inspection" || !inspectionOwnerMatches || !data || display.status !== "ready" || display.refreshError || !metadata ||
        !antennaInspectionDisplayMatchesOwner(data, metadata)) return null;
    const scalar = intent.quantity === "device_potential";
    const current = intent.quantity === "current_density" ? metadata.device_current : null;
    if (!scalar && intent.quantity !== "magnetic_field" && !current) return null;
    const positionKind = current ? "current_center_positions" as const : scalar ? "device_positions" as const : "sample_positions" as const;
    const valueKind = current ? "current_center_density" as const : scalar ? "device_potential" as const : "magnetic_field" as const;
    const positions = current ? current.center_positions : scalar ? metadata.device_positions : metadata.sample_positions;
    const values = current ? current.center_current_density : scalar ? metadata.device_potential : metadata.magnetic_field;
    try {
      const count = antennaDisplayShape(positions, values, intent);
      if (current) antennaCurrentTraceShape(positions, values, current.trace_positions, current.trace_current_density, metadata.device_positions, metadata.device_topology, intent);
      if (scalar) antennaDisplayTopologyShape(metadata.device_topology, count, metadata.device_cell_count, positions, values);
      if (count !== (current ? metadata.device_cell_count : scalar ? metadata.device_node_count : metadata.sampling_carrier.sample_count)) return null;
      return { data, metadata, count, positionKind, valueKind, positions, values, ownedCurrent: current, topology: scalar || current ? metadata.device_topology : null };
    }
    catch { return null; }
  }, [intent, inspection.data, inspectionOwnerMatches, display.data, display.status, display.refreshError]);
  const plan = useMemo(() => resolveAntennaBasisOverlayPlan(intent,
    { data: solution.data, status: solution.status }, { data: catalog.data, status: catalog.status }),
  [intent, solution.data, solution.status, catalog.data, catalog.status]);
  const positions = useAntennaFieldSolutionPayloadResource(plan ? intent?.solutionId : null, plan?.positionKind, null, {
    enabled: Boolean(plan), expectedEtag: plan?.positionEtag,
    maxResponseBytes: plan ? plan.positions.value_count * 8 : undefined,
    range: plan ? `bytes=0-${plan.positions.value_count * 8 - 1}` : undefined,
  });
  const field = useAntennaFieldSolutionPayloadResource(plan ? intent?.solutionId : null, plan?.quantity, intent?.portModeId, {
    enabled: Boolean(plan), expectedEtag: plan?.fieldEtag,
    maxResponseBytes: plan ? plan.values.value_count * 8 : undefined,
    range: plan ? `bytes=0-${plan.values.value_count * 8 - 1}` : undefined,
  });
  const inspectionPositions = useAntennaInspectionDisplayPayloadResource(inspectionPlan?.data, inspectionPlan?.metadata, inspectionPlan?.positionKind, {
    enabled: Boolean(inspectionPlan), maxResponseBytes: inspectionPlan?.positions.byte_count, range: inspectionPlan ? `bytes=0-${inspectionPlan.positions.byte_count - 1}` : undefined,
  });
  const inspectionField = useAntennaInspectionDisplayPayloadResource(inspectionPlan?.data, inspectionPlan?.metadata, inspectionPlan?.valueKind, {
    enabled: Boolean(inspectionPlan), maxResponseBytes: inspectionPlan?.values.byte_count, range: inspectionPlan ? `bytes=0-${inspectionPlan.values.byte_count - 1}` : undefined,
  });
  const inspectionTopology = useAntennaInspectionDisplayPayloadResource(inspectionPlan?.data, inspectionPlan?.metadata, inspectionPlan?.topology ? "device_topology" : null, {
    enabled: Boolean(inspectionPlan?.topology), maxResponseBytes: inspectionPlan?.topology?.byte_count, range: inspectionPlan?.topology ? `bytes=0-${inspectionPlan.topology.byte_count - 1}` : undefined,
  });
  const currentDevicePositions = useAntennaInspectionDisplayPayloadResource(inspectionPlan?.data, inspectionPlan?.metadata, inspectionPlan?.ownedCurrent ? "device_positions" : null, {
    enabled: Boolean(inspectionPlan?.ownedCurrent), maxResponseBytes: inspectionPlan?.metadata.device_positions.byte_count,
    range: inspectionPlan?.ownedCurrent ? `bytes=0-${inspectionPlan.metadata.device_positions.byte_count - 1}` : undefined,
  });
  const currentTracePositions = useAntennaInspectionDisplayPayloadResource(inspectionPlan?.data, inspectionPlan?.metadata, inspectionPlan?.ownedCurrent ? "current_trace_positions" : null, {
    enabled: Boolean(inspectionPlan?.ownedCurrent), maxResponseBytes: inspectionPlan?.ownedCurrent?.trace_positions.byte_count,
    range: inspectionPlan?.ownedCurrent ? `bytes=0-${inspectionPlan.ownedCurrent.trace_positions.byte_count - 1}` : undefined,
  });
  const currentTraceValues = useAntennaInspectionDisplayPayloadResource(inspectionPlan?.data, inspectionPlan?.metadata, inspectionPlan?.ownedCurrent ? "current_trace_density" : null, {
    enabled: Boolean(inspectionPlan?.ownedCurrent), maxResponseBytes: inspectionPlan?.ownedCurrent?.trace_current_density.byte_count,
    range: inspectionPlan?.ownedCurrent ? `bytes=0-${inspectionPlan.ownedCurrent.trace_current_density.byte_count - 1}` : undefined,
  });
  // Presentation controls do not change this immutable payload/carrier identity.
  const currentCarrierKey = intent?.kind === "inspection" && intent.quantity === "current_density" ? JSON.stringify({ ...intent, component: "magnitude", palette: "viridis", points: true, vectors: true, surface: true, wireframe: true }) : null;
  const currentCount = inspectionPlan?.ownedCurrent ? inspectionPlan.count : 0;
  const currentCarrier = useMemo(() => {
    if (!currentCarrierKey || !currentCount || inspectionPositions.data?.status !== "ready" || inspectionField.data?.status !== "ready" ||
        currentDevicePositions.data?.status !== "ready" || currentTracePositions.data?.status !== "ready" || currentTraceValues.data?.status !== "ready" || inspectionTopology.data?.status !== "ready") return null;
    try { return { model: buildAntennaCurrentOverlayModel(inspectionPositions.data.data, inspectionField.data.data, currentTracePositions.data.data, currentTraceValues.data.data,
      currentDevicePositions.data.data, inspectionTopology.data.data, currentCount, JSON.parse(currentCarrierKey) as AntennaFieldIntent), error: null }; }
    catch (error) { return { model: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [currentCarrierKey, currentCount, inspectionPositions.data, inspectionField.data, currentDevicePositions.data, currentTracePositions.data, currentTraceValues.data, inspectionTopology.data]);
  const result = useMemo(() => {
    if (intent?.kind === "inspection" && inspectionPlan && inspectionPositions.status === "ready" && inspectionField.status === "ready" &&
        inspectionPositions.data?.status === "ready" && inspectionField.data?.status === "ready" &&
        (!inspectionPlan.topology || inspectionTopology.status === "ready" && inspectionTopology.data?.status === "ready")) {
      if (inspectionPlan.ownedCurrent && (currentDevicePositions.status !== "ready" || currentDevicePositions.data?.status !== "ready" ||
          currentTracePositions.status !== "ready" || currentTracePositions.data?.status !== "ready" || currentTraceValues.status !== "ready" || currentTraceValues.data?.status !== "ready")) return null;
      try {
        const model = inspectionPlan.ownedCurrent && currentDevicePositions.data?.status === "ready" && currentTracePositions.data?.status === "ready" &&
          currentTraceValues.data?.status === "ready" && inspectionTopology.data?.status === "ready"
          ? currentCarrier?.model ? projectAntennaCurrentOverlayModel(currentCarrier.model, inspectionField.data.data, currentTraceValues.data.data, intent) : null
          : buildAntennaFieldOverlayModel(inspectionPositions.data.data, inspectionField.data.data, inspectionPlan.count, intent, inspectionTopology.data?.status === "ready" ? inspectionTopology.data.data : undefined);
        return { model, error: currentCarrier?.error ?? null };
      }
      catch (error) { return { model: null, error: error instanceof Error ? error.message : String(error) }; }
    }
    if (!intent || !plan || positions.status !== "ready" || field.status !== "ready" ||
        positions.data?.status !== "ready" || field.data?.status !== "ready" ||
        positions.data.etag !== plan.positionEtag || field.data.etag !== plan.fieldEtag) return null;
    try { return { model: buildAntennaFieldOverlayModel(positions.data.data, field.data.data, plan.count, intent), error: null }; }
    catch (error) { return { model: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [intent, plan, positions.data, positions.status, field.data, field.status, inspectionPlan, inspectionPositions.data, inspectionPositions.status, inspectionField.data, inspectionField.status, inspectionTopology.data, inspectionTopology.status,
    currentDevicePositions.data, currentDevicePositions.status, currentTracePositions.data, currentTracePositions.status, currentTraceValues.data, currentTraceValues.status, currentCarrier]);
  const model = result?.model ?? null;
  const error = result?.error ?? solution.error?.message ?? catalog.error?.message ?? inspection.error?.message ?? display.error?.message ?? positions.error?.message ?? field.error?.message ?? inspectionPositions.error?.message ?? inspectionField.error?.message ?? inspectionTopology.error?.message ?? currentDevicePositions.error?.message ?? currentTracePositions.error?.message ?? currentTraceValues.error?.message;
  const metadataReady = intent?.kind === "inspection" ? inspection.status === "ready" && display.status === "ready" : solution.status === "ready" && catalog.status === "ready";
  const status = useMemo(() => !intent ? null : model ? {
    intentKey: JSON.stringify(intent), status: "ready" as const, reason: model.surfaceVectorValues ? "Owned SI RT0 J: cell centers and cell-local exterior traces; vector interpolated before magnitude; no nodal average" : model.surfaceTriangles ? "Complete pinned SI device Tet4 carrier and nodal V; exterior surface derived from actual cell connectivity" : "Complete pinned SI sample carrier; no surface interpolation", sampleCount: model.count, minimum: model.minimum, maximum: model.maximum,
  } : {
    intentKey: JSON.stringify(intent), status: error || (metadataReady && !plan && !inspectionPlan) ? "unavailable" as const : "loading" as const,
    reason: error ?? (metadataReady && !plan && !inspectionPlan ? "Incompatible identity, port, layout, units, cardinality or display memory limit. No field was rendered." : "Loading complete, revision-checked sample payloads"),
  }, [intent, model, error, metadataReady, plan, inspectionPlan]);
  useEffect(() => { controller.setAntennaFieldDisplayStatus(status); }, [controller, status]);
  useEffect(() => () => controller.setAntennaFieldDisplayStatus(null), [controller]);
  return model;
}
