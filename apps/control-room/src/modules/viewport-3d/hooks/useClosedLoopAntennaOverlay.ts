"use client";
import { useMemo } from "react";
import type { AntennaExternalLeadInspectionResource } from "@/kernel/api/apiTypes";
import { useAntennaInspectionDisplayPayloadResource, antennaInspectionDisplayMatchesOwner } from "@/kernel/resources/antennaResources";
import { closedLoopManifest, isClosedLoopDisplay, type AntennaInspectionDisplay, type ClosedLoopPayloadKind } from "@/kernel/resources/antennaClosedLoopInspectionModel";
import type { AntennaFieldIntent } from "@/kernel/visualization/antennaFieldIntent";
import { buildAntennaFieldOverlayModel, MAX_ANTENNA_DISPLAY_PAYLOAD_BYTES, MAX_ANTENNA_DISPLAY_SAMPLES, MAX_ANTENNA_DISPLAY_CELLS } from "../model/antennaFieldOverlayModel";
import { projectAntennaCurrentOverlayModel } from "../model/antennaCurrentOverlayModel";
import { buildClosedLoopCurrentOverlayModel, buildClosedLoopPotentialOverlayModel, buildClosedLoopMagneticOverlayModel } from "../model/closedLoopCurrentOverlayModel";

export function useClosedLoopAntennaOverlay(intent: AntennaFieldIntent | null, inspection: AntennaExternalLeadInspectionResource | null | undefined, display: AntennaInspectionDisplay | null | undefined) {
  const active = Boolean(intent?.kind === "inspection" && display && isClosedLoopDisplay(display));
  const carrierKey = intent ? JSON.stringify({ ...intent, component: "magnitude", palette: "viridis", surface: true, wireframe: true, points: true, vectors: true }) : null;
  const carrierIntent = useMemo(() => carrierKey ? JSON.parse(carrierKey) as AntennaFieldIntent : null, [carrierKey]);
  const plan = useMemo(() => {
    const intent = carrierIntent;
    if (!active || !intent || !inspection || !display || !antennaInspectionDisplayMatchesOwner(inspection, display)) return null;
    try {
      const manifest = closedLoopManifest(inspection);
      if (!manifest || manifest.content_digest !== intent.contentDigest || manifest.source_object_id !== intent.sourceObjectId || manifest.port_mode_id !== intent.portModeId ||
          inspection.stage_revision !== intent.stageRevision || inspection.record_content_digest !== intent.recordContentDigest || inspection.stage_id !== intent.stageId || inspection.runtime_stage_id !== intent.runtimeStageId || inspection.run_id !== intent.runId) return null;
      const current = intent.quantity === "current_density" || intent.quantity === "current_density_per_ampere", scalar = intent.quantity === "device_potential" || intent.quantity === "electric_potential_per_ampere";
      const perAmpere = intent.quantity.endsWith("per_ampere");
      if (!current && !scalar && intent.quantity !== "magnetic_field" && intent.quantity !== "magnetic_field_per_ampere") return null;
      const kinds: ClosedLoopPayloadKind[] = current ? ["vertex_xyz", perAmpere ? "j_center_per_a" : "j_center_raw", "cells", "stable_vertex_ids", perAmpere ? "j_local_per_a" : "j_local_raw"] : scalar ? ["vertex_xyz", perAmpere ? "v_per_a" : "v_raw", "cells", "stable_vertex_ids"] : ["sample_xyz", perAmpere ? "h_per_a" : "h_raw", "sample_cells"];
      if ((!current && !scalar && (manifest.target_count > MAX_ANTENNA_DISPLAY_SAMPLES || manifest.sample_cell_count > MAX_ANTENNA_DISPLAY_CELLS)) || (current || scalar) && (manifest.vertex_count > MAX_ANTENNA_DISPLAY_SAMPLES || manifest.cell_count > MAX_ANTENNA_DISPLAY_CELLS) ||
          kinds.reduce((sum, kind) => sum + manifest.payloads[kind].byte_length, 0) > MAX_ANTENNA_DISPLAY_PAYLOAD_BYTES) return null;
      return { manifest, kinds, isCurrent: current, scalar, perAmpere };
    } catch { return null; }
  }, [active, carrierIntent, inspection, display]);
  const options = (index: number) => {
    const descriptor = plan?.kinds[index] ? plan.manifest.payloads[plan.kinds[index]] : null;
    return { enabled: Boolean(descriptor), maxResponseBytes: descriptor?.byte_length, range: descriptor ? `bytes=0-${descriptor.byte_length - 1}` : undefined };
  };
  // Fixed hook order; only this family owns these complete immutable payload subscriptions.
  const positions = useAntennaInspectionDisplayPayloadResource(inspection, display, plan?.kinds[0], options(0));
  const values = useAntennaInspectionDisplayPayloadResource(inspection, display, plan?.kinds[1], options(1));
  const cells = useAntennaInspectionDisplayPayloadResource(inspection, display, plan?.kinds[2], options(2));
  const ids = useAntennaInspectionDisplayPayloadResource(inspection, display, plan?.kinds[3], options(3));
  const local = useAntennaInspectionDisplayPayloadResource(inspection, display, plan?.kinds[4], options(4));
  const result = useMemo(() => {
    const intent = carrierIntent;
    if (!plan || !intent) return null;
    const resources = [
      { status: positions.status, data: positions.data },
      { status: values.status, data: values.data },
      { status: cells.status, data: cells.data },
      { status: ids.status, data: ids.data },
      { status: local.status, data: local.data },
    ].slice(0, plan.kinds.length);
    if (resources.some((resource) => resource.status !== "ready" || resource.data?.status !== "ready")) return null;
    const buffers = resources.map((resource) => resource.data!.status === "ready" ? resource.data!.data : null);
    if (buffers.some((buffer) => !buffer)) return null;
    const [position, value, cell, id, trace] = buffers as ArrayBuffer[];
    try {
      const m = plan.manifest;
      const model = plan.isCurrent ? buildClosedLoopCurrentOverlayModel(id, position, cell, value, trace, m.vertex_count, m.cell_count, intent, plan.perAmpere ? m.scale_per_a : 1)
        : plan.scalar ? buildClosedLoopPotentialOverlayModel(id, position, cell, value, m.vertex_count, m.cell_count, intent)
        : buildClosedLoopMagneticOverlayModel(position, value, cell, m.target_count, m.sample_cell_count, intent);
      return { model, error: null };
    } catch (error) { return { model: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [plan, carrierIntent, positions.status, positions.data, values.status, values.data, cells.status, cells.data, ids.status, ids.data, local.status, local.data]);
  const error = result?.error ?? [positions, values, cells, ids, local].map((resource) => resource.error?.message ?? resource.refreshError?.message).find(Boolean);
  const projected = useMemo(() => {
    const model = result?.model;
    if (!model || !intent) return null;
    try {
    if (model.surfaceVectorValues && plan?.isCurrent && values.data?.status === "ready" && local.data?.status === "ready") {
      const raw = projectAntennaCurrentOverlayModel(model, values.data.data, local.data.data, { ...intent, quantity: "current_density" });
      return { model: { ...raw, key: JSON.stringify(intent), intent }, error: null };
    }
    if (positions.data?.status === "ready" && values.data?.status === "ready" && !plan?.scalar) {
      const projection = buildAntennaFieldOverlayModel(positions.data.data, values.data.data, model.count, { ...intent, vectors: false });
      return { model: { ...model, ...projection, key: JSON.stringify(intent), intent, positions: model.positions, vectorSegments: model.vectorSegments, surfaceTriangles: model.surfaceTriangles, surfaceEdges: model.surfaceEdges, surfaceVectorValues: model.surfaceVectorValues, surfaceVectorScale: model.surfaceVectorScale, minimum: intent.component === "magnitude" ? 0 : projection.minimum }, error: null };
    }
    return { model: { ...model, key: JSON.stringify(intent), intent, vectorSegments: null }, error: null };
    } catch (error) { return { model: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [result, intent, plan?.isCurrent, plan?.scalar, positions.data, values.data, local.data]);
  return { active, plan, model: projected?.model ?? null, error: projected?.error ?? error };
}
