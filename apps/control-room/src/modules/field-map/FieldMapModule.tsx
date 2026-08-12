"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  usePlanarFieldMetaResource,
  usePlanarMaskResource,
  usePlanarMeshOverlayResource,
  usePlanarProbeResource,
  usePlanarScalarResource,
  usePlanarVectorResource,
} from "@/kernel/resources/planarFieldResources";
import {
  usePlanarMonitorResource,
  usePlanarMonitorsResource,
} from "@/kernel/resources/planarMonitorResources";
import { useDomainMetaResource } from "@/kernel/resources/geometryLifecycleResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";

import { fieldMapStore, useFieldMapState } from "./fieldMapStore";
import {
  buildFieldMapDataPlan,
  buildFieldMapProbeQuery,
} from "./model/fieldMapDataPlan";
import {
  resolveFieldMapAuxiliaryDiagnostics,
  surfaceProjectionStatus,
} from "./model/fieldMapRenderModel";
import {
  createPlanarEvidence,
  resolvePlanarEvidenceStatus,
  type PlanarEvidenceStatus,
  type PlanarRenderEvidence,
} from "./model/fieldMapEvidence";
import { PlanarSurface } from "./renderer/PlanarSurface";

export default function FieldMapModule() {
  const { layout } = useKernel();
  const state = useFieldMapState();
  const [pinned, setPinned] = useState<readonly [number, number] | null>(null);
  const [renderEvidence, setRenderEvidence] =
    useState<PlanarRenderEvidence | null>(null);
  const active = layout.get().activeViewportMainModuleId === "field-map";
  const visualization = useVisualizationStateResource({ enabled: active });
  const planar = visualization.data?.planar;
  const activeMonitorId = planar?.active_monitor_id ?? state.activeMonitorId;
  const monitors = usePlanarMonitorsResource({ enabled: active });
  const monitor = usePlanarMonitorResource(activeMonitorId ?? "", {
    enabled: active && activeMonitorId !== null,
  });
  const domain = useDomainMetaResource({ enabled: active });
  const runtime = useSessionStatusSelector(
    (status) => ({
      expectedFieldRevision:
        typeof status.data?.resources.field_revision === "number"
          ? status.data.resources.field_revision
          : null,
      expectedMeshRevision:
        typeof status.data?.resources.mesh_revision === "number"
          ? status.data.resources.mesh_revision
          : null,
      discretization: status.data?.domain.discretization ?? null,
    }),
    {
      enabled: active,
      isEqual: (left, right) =>
        left.expectedFieldRevision === right.expectedFieldRevision &&
        left.expectedMeshRevision === right.expectedMeshRevision &&
        left.discretization === right.discretization,
    },
  );
  const selectedFieldSnapshot = useSelectionSelector((selection) => {
    const ref = selection.ref;
    if (!ref || typeof ref !== "object") {
      return { snapshotId: null, stageId: null };
    }
    const candidate = ref as { snapshotId?: unknown; stageId?: unknown };
    return {
      snapshotId: typeof candidate.snapshotId === "string" ? candidate.snapshotId : null,
      stageId: typeof candidate.stageId === "string" ? candidate.stageId : null,
    };
  }, {
    isEqual: (left, right) =>
      left.snapshotId === right.snapshotId && left.stageId === right.stageId,
  });

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
    discretization:
      domain.data?.discretization ?? runtime.discretization ?? null,
    expectedFieldRevision: runtime.expectedFieldRevision,
    expectedMeshRevision: runtime.expectedMeshRevision,
    expectedMonitorRevision:
      typeof monitor.data?.scene_revision === "number"
        ? monitor.data.scene_revision
        : null,
    includeMesh: planar?.layers.mesh ?? true,
    monitorId: activeMonitorId,
    quantityId: planar?.quantity_id ?? state.quantityId,
    resolution: [
      planar?.resolution.width ?? 512,
      planar?.resolution.height ?? 512,
    ],
    showVectors: planar?.layers.vectors ?? false,
    snapshotId: selectedFieldSnapshot.snapshotId,
    stageId: selectedFieldSnapshot.stageId,
    viewScope: planar?.view_scope ?? { kind: "monitor_target" },
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
    buildFieldMapProbeQuery(plan.query, pinned?.[0] ?? 0, pinned?.[1] ?? 0),
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
  const component = planar?.component ?? state.component;
  const quantityId = planar?.quantity_id ?? state.quantityId;
  const onRenderEvidence = useCallback(
    (next: PlanarRenderEvidence) => setRenderEvidence(next),
    [],
  );

  const evidenceStatus: PlanarEvidenceStatus = resolvePlanarEvidenceStatus({
    metaIdentity: meta.data?.etag,
    metaStatus: meta.status,
    renderEvidence,
    scalarIdentity: scalar.data?.etag,
    scalarStatus: scalar.status,
  });
  const evidence = createPlanarEvidence({
    component,
    fieldRevision: meta.data?.field_revision ?? null,
    glyphCount: renderEvidence?.glyphCount ?? 0,
    metaIdentity: meta.data?.etag ?? null,
    monitorHash: meta.data?.monitor_hash ?? null,
    monitorId: activeMonitorId ?? "",
    monitorRevision: meta.data?.monitor_revision ?? null,
    operatorKind: monitor.data?.monitor.operator.kind ?? null,
    operatorRevision: monitor.data?.scene_revision ?? null,
    overlayCounts: renderEvidence?.overlayCounts ?? {
      contours: 0,
      meshSegments: 0,
    },
    quantityId,
    raster: renderEvidence?.raster ?? null,
    scalarIdentity: renderEvidence?.sampleIdentity ?? null,
    status: evidenceStatus,
  });

  if (!activeMonitorId) {
    return <FieldMapStatus message="Select a planar monitor to open the 2D view." />;
  }
  if (plan.availability === "not-applicable") {
    return (
      <FieldMapStatus
        message={`Field Map not applicable: ${plan.unavailableReason ?? "the selected scope is unsupported."}`}
      />
    );
  }
  if (meta.status === "error" || scalar.status === "error") {
    return (
      <FieldMapStatus
        kind="error"
        message={meta.error?.message ?? scalar.error?.message ?? "Planar field unavailable."}
        planarStatus="error"
      />
    );
  }
  if (meta.status === "ready" && (!meta.data || !scalar.data)) {
    return <FieldMapStatus message="No planar field is published for this revision." />;
  }
  if (!meta.data || !scalar.data || !frame) {
    return <FieldMapStatus message="Loading planar field…" planarStatus="loading" />;
  }

  const [width, height] = meta.data.resolution;
  return (
    <section className="fm-field-map">
      <output
        aria-label="Planar field evidence"
        data-planar-component={evidence.component}
        data-planar-evidence={JSON.stringify(evidence)}
        data-planar-field-revision={String(evidence.fieldRevision ?? "")}
        data-planar-glyph-count={String(evidence.glyphCount)}
        data-planar-monitor-id={evidence.monitorId}
        data-planar-operator-kind={evidence.operatorKind ?? ""}
        data-planar-raster-checksum={evidence.raster?.checksum ?? ""}
        data-planar-raster-max={String(evidence.raster?.max ?? "")}
        data-planar-raster-min={String(evidence.raster?.min ?? "")}
        data-planar-meta-identity={evidence.metaIdentity ?? ""}
        data-planar-monitor-hash={evidence.monitorHash ?? ""}
        data-planar-monitor-revision={String(evidence.monitorRevision ?? "")}
        data-planar-operator-revision={String(evidence.operatorRevision ?? "")}
        data-planar-scalar-identity={evidence.scalarIdentity ?? ""}
        data-planar-status={evidence.status}
        data-planar-contour-count={String(evidence.overlayCounts.contours)}
        data-planar-mesh-segment-count={String(evidence.overlayCounts.meshSegments)}
        data-planar-quantity-id={evidence.quantityId}
        hidden
      />
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
          onRenderEvidence={onRenderEvidence}
          sampleIdentity={scalar.data.etag ?? ""}
          scalar={scalar.data.data}
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
      <FieldMapAuxiliaryDiagnostics
        layers={[
          { label: "Occupancy mask", requested: plan.requestMask, resource: mask },
          { label: "Vector overlay", requested: plan.requestVectors, resource: vectors },
          { label: "Mesh overlay", requested: plan.requestMesh, resource: meshOverlay },
        ]}
      />
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

function FieldMapAuxiliaryDiagnostics({
  layers,
}: {
  layers: readonly {
    label: string;
    requested: boolean;
    resource: { data: ArrayBuffer | null; error: Error | null; status: "error" | "idle" | "loading" | "ready" | "stale" };
  }[];
}) {
  const diagnostics = resolveFieldMapAuxiliaryDiagnostics(
    layers.map(({ label, requested, resource }) => ({
      errorMessage: resource.error?.message ?? null,
      hasData: resource.data !== null,
      label,
      requested,
      status: resource.status,
    })),
  );
  if (diagnostics.length === 0) return null;
  return (
    <div className="fm-field-map__diagnostics" role="status" aria-label="Planar layer diagnostics">
      {diagnostics.map((message) => <p key={message}>{message}</p>)}
    </div>
  );
}

function FieldMapStatus({
  kind = "status",
  message,
  planarStatus,
}: {
  kind?: "error" | "status";
  message: string;
  planarStatus?: PlanarEvidenceStatus;
}) {
  return (
    <div
      className={`fm-field-map fm-field-map--${kind}`}
      data-planar-status={planarStatus}
      role={kind === "error" ? "alert" : "status"}
    >
      {message}
    </div>
  );
}
