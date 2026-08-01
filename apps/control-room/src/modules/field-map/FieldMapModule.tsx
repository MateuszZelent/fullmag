"use client";

import { useEffect, useMemo, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  usePlanarFieldMetaResource,
  usePlanarMaskResource,
  usePlanarMeshOverlayResource,
  usePlanarProbeResource,
  usePlanarScalarResource,
  usePlanarVectorResource,
} from "@/kernel/resources/planarFieldResources";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";

import { fieldMapStore, useFieldMapState } from "./fieldMapStore";
import { buildFieldMapDataPlan } from "./model/fieldMapDataPlan";
import { surfaceProjectionStatus } from "./model/fieldMapRenderModel";
import { PlanarSurface } from "./renderer/PlanarSurface";

export default function FieldMapModule() {
  const { layout } = useKernel();
  const state = useFieldMapState();
  const [pinned, setPinned] = useState<readonly [number, number] | null>(null);
  const active = layout.get().activeViewportMainModuleId === "field-map";
  const visualization = useVisualizationStateResource({ enabled: active });
  const planar = visualization.data?.planar;
  const activeMonitorId = planar?.active_monitor_id ?? state.activeMonitorId;
  const monitors = usePlanarMonitorsResource({ enabled: active });

  useEffect(() => {
    if (activeMonitorId || !monitors.data?.monitors.length) return;
    const first = monitors.data.monitors[0] as { id?: unknown };
    if (typeof first?.id === "string") {
      fieldMapStore.set({ activeMonitorId: first.id });
    }
  }, [activeMonitorId, monitors.data]);

  const plan = buildFieldMapDataPlan({
    active,
    component: planar?.component ?? state.component,
    includeMesh: planar?.layers.mesh ?? true,
    monitorId: activeMonitorId,
    quantityId: planar?.quantity_id ?? state.quantityId,
    resolution: [
      planar?.resolution.width ?? 512,
      planar?.resolution.height ?? 512,
    ],
    showVectors: planar?.layers.vectors ?? false,
  });
  const meta = usePlanarFieldMetaResource(
    plan.quantityId,
    plan.monitorId,
    plan.query,
    { enabled: plan.enabled },
  );
  const scalar = usePlanarScalarResource(
    plan.quantityId,
    plan.monitorId,
    plan.query,
    { enabled: plan.requestScalar },
  );
  const mask = usePlanarMaskResource(
    plan.quantityId,
    plan.monitorId,
    plan.query,
    { enabled: plan.requestMask },
  );
  const vectors = usePlanarVectorResource(
    plan.quantityId,
    plan.monitorId,
    plan.query,
    { enabled: plan.requestVectors },
  );
  const meshOverlay = usePlanarMeshOverlayResource(
    plan.quantityId,
    plan.monitorId,
    plan.query,
    { enabled: plan.requestMesh },
  );
  const probe = usePlanarProbeResource(
    plan.quantityId,
    plan.monitorId,
    {
      component: planar?.component ?? state.component,
      resolution_x: plan.query.resolution_x,
      resolution_y: plan.query.resolution_y,
      u_m: pinned?.[0] ?? 0,
      v_m: pinned?.[1] ?? 0,
    },
    { enabled: plan.enabled && pinned !== null },
  );
  const frame = useMemo(
    () =>
      meta.data
        ? {
            normal: meta.data.frame.normal as [number, number, number],
            uAxis: meta.data.frame.u_axis as [number, number, number],
            vAxis: meta.data.frame.v_axis as [number, number, number],
          }
        : null,
    [meta.data],
  );

  if (!activeMonitorId) {
    return <FieldMapStatus message="Select a planar monitor to open the 2D view." />;
  }
  if (meta.status === "error" || scalar.status === "error") {
    return (
      <FieldMapStatus
        kind="error"
        message={meta.error?.message ?? scalar.error?.message ?? "Planar field unavailable."}
      />
    );
  }
  if (meta.status === "ready" && (!meta.data || !scalar.data)) {
    return <FieldMapStatus message="No planar field is published for this revision." />;
  }
  if (!meta.data || !scalar.data || !frame) {
    return <FieldMapStatus message="Loading planar field…" />;
  }

  const [width, height] = meta.data.resolution;
  return (
    <section className="fm-field-map">
      <header className="fm-field-map__toolbar">
        <strong>{plan.quantityId}</strong>
        <span>{planar?.component ?? state.component}</span>
        <span>{meta.data.canonical_unit}</span>
        {surfaceProjectionStatus(meta.data) === "ambiguous" ? (
          <span className="fm-field-map__diagnostic" role="status">
            Ambiguous surface: {meta.data.overlap_count} overlaps,{" "}
            {meta.data.fold_count} folds
          </span>
        ) : null}
      </header>
      <div className="fm-field-map__stage">
        <PlanarSurface
          bounds={meta.data.frame.bounds_uv_m as [number, number, number, number]}
          frame={frame}
          height={height ?? 1}
          mask={mask.data}
          meshOverlay={meshOverlay.data}
          onPin={(u, v) => setPinned([u, v])}
          scalar={scalar.data}
          vectors={vectors.data}
          width={width ?? 1}
        />
        <div className="fm-field-map__axis fm-field-map__axis--u">u (m)</div>
        <div className="fm-field-map__axis fm-field-map__axis--v">v (m)</div>
        <div className="fm-field-map__colorbar" aria-label="Scalar color range">
          <span>{meta.data.scalar_max ?? "auto"}</span>
          <span>{meta.data.scalar_min ?? "auto"}</span>
        </div>
      </div>
      {probe.data ? (
        <table className="fm-field-map__pinned-probe">
          <caption>Pinned planar probe</caption>
          <tbody>
            <tr><th scope="row">u</th><td>{probe.data.u_m} m</td></tr>
            <tr><th scope="row">v</th><td>{probe.data.v_m} m</td></tr>
            <tr><th scope="row">Value</th><td>{probe.data.scalar ?? "undefined"} {meta.data.canonical_unit}</td></tr>
            <tr><th scope="row">Occupancy</th><td>{probe.data.occupancy}</td></tr>
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function FieldMapStatus({
  kind = "status",
  message,
}: {
  kind?: "error" | "status";
  message: string;
}) {
  return (
    <div className={`fm-field-map fm-field-map--${kind}`} role={kind === "error" ? "alert" : "status"}>
      {message}
    </div>
  );
}
