"use client";

import { useCallback, useMemo, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import { decodeFieldVector } from "@/kernel/api/codecs";
import type { PlanarFieldSource } from "@/kernel/api/apiTypes";
import {
  planarFieldQueryFromMeta,
  usePlanarFieldMetaResource,
  usePlanarMaskResource,
  usePlanarMeshOverlayResource,
  usePlanarProbeResource,
  usePlanarScalarResource,
  usePlanarVectorResource,
} from "@/kernel/resources/planarFieldResources";
import { useDomainMetaResource } from "@/kernel/resources/geometryLifecycleResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { projectPlanarPresentationState } from "@/kernel/visualization/planarPresentationProjection";


import {
  buildFieldMapDataPlan,
  buildFieldMapProbeQuery,
} from "./model/fieldMapDataPlan";
import {
  buildFieldMapRenderModel,
  normalizePlanarColorRange,
  projectPlanarVectors,
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
  const { layout, visualizationSync } = useKernel();
  const [pinned, setPinned] = useState<readonly [number, number] | null>(null);
  const [renderEvidence, setRenderEvidence] =
    useState<PlanarRenderEvidence | null>(null);
  const active = layout.get().activeViewportMainModuleId === "field-map";
  const visualization = useVisualizationStateResource({ enabled: active });
  const canonicalPlanar = visualization.data?.planar;
  const presentationPlanar = useMemo(
    () => projectPlanarPresentationState(
      visualization.data,
      visualization.optimisticData,
    ),
    [visualization.data, visualization.optimisticData],
  );
  const activePinned = canonicalPlanar?.layers.probes ? pinned : null;
  const activeRenderEvidence = presentationPlanar?.layers.raster ? renderEvidence : null;
  const canonicalSourceKind = canonicalPlanar?.source.kind;
  const canonicalSourceMonitorId = canonicalSourceKind === "monitor"
    ? canonicalPlanar?.source.monitor_id
    : undefined;
  const source = useMemo<PlanarFieldSource>(() => {
    if (canonicalSourceKind === "monitor" && canonicalSourceMonitorId) {
      return {
        kind: "monitor",
        monitorId: canonicalSourceMonitorId,
      };
    }
    return { kind: "default" };
  }, [canonicalSourceKind, canonicalSourceMonitorId]);
  const domain = useDomainMetaResource({ enabled: active });
  const runtime = useSessionStatusSelector(
    (status) => status.data?.domain.discretization ?? null,
    { enabled: active },
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

  const plan = useMemo(
    () => buildFieldMapDataPlan({
      active: active && canonicalPlanar !== undefined,
      component: canonicalPlanar?.component ?? "",
      discretization:
        domain.data?.discretization ?? runtime ?? null,
      includeMesh: (canonicalPlanar?.layers.mesh ?? false) || (canonicalPlanar?.layers.boundaries ?? false),
      source,
      quality: canonicalPlanar?.quality ?? "interactive",
      quantityId: canonicalPlanar?.quantity_id ?? "",
      resolution: [
        canonicalPlanar?.resolution.width ?? 0,
        canonicalPlanar?.resolution.height ?? 0,
      ],
      showVectors: canonicalPlanar?.layers.vectors ?? false,
      snapshotId: selectedFieldSnapshot.snapshotId,
      stageId: selectedFieldSnapshot.stageId,
      viewScope: canonicalPlanar?.view_scope,
      vectorBudget: canonicalPlanar?.resolution.vector_budget ?? 0,
    }),
    [
      active,
      domain.data?.discretization,
      canonicalPlanar,
      runtime,
      source,
      selectedFieldSnapshot.snapshotId,
      selectedFieldSnapshot.stageId,
    ],
  );
  const planQuantityId = plan.quantityId;
  const meta = usePlanarFieldMetaResource(
    plan.quantityId,
    plan.source,
    plan.query,
    { enabled: plan.enabled },
  );
  const canonicalSample = useMemo(
    () =>
      meta.status === "ready" && meta.data
        ? planarFieldQueryFromMeta(
            planQuantityId,
            plan.source,
            meta.data,
          )
        : null,
    [meta.data, meta.status, plan.source, planQuantityId],
  );
  const canonicalQuery =
    canonicalSample?.ok ? canonicalSample.query : null;
  const canonicalSampleError =
    canonicalSample && !canonicalSample.ok ? canonicalSample.error : null;
  const dataQuery = canonicalQuery ?? plan.query;
  const canonicalSampleReady = canonicalQuery !== null;
  const scalar = usePlanarScalarResource(
    plan.quantityId,
    plan.source,
    dataQuery,
    { enabled: plan.requestScalar && canonicalSampleReady },
  );
  const mask = usePlanarMaskResource(
    plan.quantityId,
    plan.source,
    dataQuery,
    { enabled: plan.requestMask && canonicalSampleReady },
  );
  const vectors = usePlanarVectorResource(
    plan.quantityId,
    plan.source,
    dataQuery,
    { enabled: plan.requestVectors && canonicalSampleReady },
  );
  const meshOverlay = usePlanarMeshOverlayResource(
    plan.quantityId,
    plan.source,
    dataQuery,
    { enabled: plan.requestMesh && canonicalSampleReady },
  );
  const probe = usePlanarProbeResource(
    plan.quantityId,
    plan.source,
    buildFieldMapProbeQuery(dataQuery, activePinned?.[0] ?? 0, activePinned?.[1] ?? 0),
    { enabled: plan.enabled && canonicalSampleReady && activePinned !== null },
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
  const component = canonicalPlanar?.component ?? "";
  const quantityId = canonicalPlanar?.quantity_id ?? "";
  const onRenderEvidence = useCallback(
    (next: PlanarRenderEvidence) => setRenderEvidence(next),
    [],
  );
  const onInteraction = useCallback((interaction: { panU: number; panV: number; zoom: number }) => {
    visualizationSync.queuePatch({
      planar: {
        interaction: {
          pan_u_m: interaction.panU,
          pan_v_m: interaction.panV,
          zoom: interaction.zoom,
        },
      },
    });
  }, [visualizationSync]);
  const renderModel = useMemo(() => {
    if (!meta.data || !scalar.data || !frame || !presentationPlanar) return null;
    const scalarValues = decodeFieldVector(scalar.data.data).values;
    const vectorValues = vectors.data
      ? projectPlanarVectors(decodeFieldVector(vectors.data).values, frame)
      : null;
    return buildFieldMapRenderModel({
      bounds: meta.data.frame.bounds_uv_m as [number, number, number, number],
      canonicalUnit: meta.data.canonical_unit,
      colormap: presentationPlanar.colormap,
      component: presentationPlanar.component,
      displayUnit: presentationPlanar.display_unit,
      frame,
      interaction: {
        panU: presentationPlanar.interaction.pan_u_m,
        panV: presentationPlanar.interaction.pan_v_m,
        zoom: presentationPlanar.interaction.zoom,
      },
      layers: {
        boundaries: presentationPlanar.layers.boundaries,
        bounds: presentationPlanar.layers.bounds,
        contours: presentationPlanar.layers.contours,
        mesh: presentationPlanar.layers.mesh,
        points: presentationPlanar.layers.points,
        probes: presentationPlanar.layers.probes,
        raster: presentationPlanar.layers.raster,
        vectors: presentationPlanar.layers.vectors,
      },
      mask: mask.data ? new Uint8Array(mask.data) : null,
      meshOverlayDescriptor: {
        available: meta.data.mesh_overlay_descriptor.available,
        boundaryClassification: meta.data.mesh_overlay_descriptor.boundary_classification,
        codec: meta.data.mesh_overlay_descriptor.codec,
        geometrySource: meta.data.mesh_overlay_descriptor.geometry_source,
      },
      meshOverlay: meshOverlay.data,
      range: normalizePlanarColorRange(presentationPlanar.range),
      rasterOpacity: presentationPlanar.raster_opacity ?? 1,
      resolution: meta.data.resolution as [number, number],
      sampleIdentity: scalar.data.etag ?? "",
      scalar: scalarValues,
      vectorBudget: canonicalPlanar?.resolution.vector_budget ?? 0,
      vectorScale: presentationPlanar.vector_style.scale,
      vectorStyle: {
        colorMode: presentationPlanar.vector_style.color_mode,
        lengthMode: presentationPlanar.vector_style.length_mode,
      },
      vectors: vectorValues,
    });
  }, [canonicalPlanar?.resolution.vector_budget, frame, mask.data, meshOverlay.data, meta.data, presentationPlanar, scalar.data, vectors.data]);

  const evidenceStatus: PlanarEvidenceStatus = resolvePlanarEvidenceStatus({
    metaIdentity: meta.data?.etag,
    metaStatus: meta.status,
    renderEvidence: activeRenderEvidence,
    scalarIdentity: scalar.data?.etag,
    scalarStatus: scalar.status,
  });
  const evidenceSource = meta.data?.source;
  const sourceKind = evidenceSource?.kind ?? source.kind;
  const sourceId = evidenceSource?.kind === "monitor"
    ? evidenceSource.monitor_id
    : "default";
  const sourceHash = evidenceSource?.kind === "monitor"
    ? evidenceSource.monitor_hash
    : evidenceSource?.default_slice_hash ?? null;
  const sourceRevision = evidenceSource?.kind === "monitor"
    ? evidenceSource.monitor_revision
    : evidenceSource?.default_slice_revision ?? null;
  const defaultPlane = canonicalPlanar?.source.kind === "default"
    ? canonicalPlanar.default_slice.plane
    : null;
  const positionFraction = canonicalPlanar?.source.kind === "default"
    ? canonicalPlanar.default_slice.position_fraction
    : null;
  const normalIndex = defaultPlane === "xy" ? 2 : defaultPlane === "xz" ? 1 : 0;
  const resolvedCoordinateM = defaultPlane && meta.data
    ? meta.data.frame.origin_m[normalIndex] ?? null
    : null;
  const operatorThicknessM = meta.data?.operator.kind === "slab_average"
    ? meta.data.operator.thickness_m
    : null;
  const evidence = createPlanarEvidence({
    canonicalUnit: meta.data?.canonical_unit ?? null,
    carrierRevision: meta.data?.carrier_revision ?? null,
    component,
    defaultPlane,
    domainGenerationId: evidenceSource?.kind === "default"
      ? evidenceSource.domain_generation_id
      : null,
    fieldBackend: meta.data?.field_backend ?? null,
    fieldDevice: meta.data?.field_device ?? null,
    fieldRevision: meta.data?.field_revision ?? null,
    fieldSource: meta.data?.field_source ?? null,
    fieldPrecision: meta.data?.field_precision ?? null,
    glyphCount: activeRenderEvidence?.glyphCount ?? 0,
    metaIdentity: meta.data?.etag ?? null,
    meshRevision: meta.data?.mesh_revision ?? null,
    operatorThicknessM,
    positionFraction,
    resolvedCoordinateM,
    sampleToken: meta.data?.sample_token ?? null,
    samplingExecution: meta.data?.sampling_execution ?? null,
    sourceKind,
    sourceId,
    sourceHash,
    sourceRevision,
    operatorKind: meta.data?.operator.kind ?? null,
    operatorRevision: sourceRevision,
    overlayCounts: activeRenderEvidence?.overlayCounts ?? {
      boundsSegments: 0,
      contours: 0,
      meshSegments: 0,
      pointMarkers: 0,
    },
    quantityId,
    raster: activeRenderEvidence?.raster ?? null,
    scalarIdentity: activeRenderEvidence?.sampleIdentity ?? null,
    status: evidenceStatus,
  });

  if (visualization.status === "error") {
    return (
      <FieldMapStatus
        kind="error"
        message={visualization.error?.message ?? "Planar visualization state is unavailable."}
        planarStatus="error"
      />
    );
  }
  if (!canonicalPlanar || !presentationPlanar) {
    return <FieldMapStatus message="Loading planar visualization state…" planarStatus="loading" />;
  }
  if (plan.availability === "not-applicable") {
    return (
      <FieldMapStatus
        message={`Field Map not applicable: ${plan.unavailableReason ?? "the selected scope is unsupported."}`}
      />
    );
  }
  if (
    meta.status === "error" ||
    scalar.status === "error" ||
    canonicalSampleError !== null
  ) {
    return (
      <FieldMapStatus
        kind="error"
        message={
          meta.error?.message ??
          scalar.error?.message ??
          canonicalSampleError?.message ??
          "Planar field unavailable."
        }
        planarStatus="error"
      />
    );
  }
  if (meta.status === "ready" && (!meta.data || !scalar.data)) {
    return <FieldMapStatus message="No planar field is published for this revision." />;
  }
  if (!meta.data || !scalar.data || !frame || !renderModel) {
    return <FieldMapStatus message="Loading planar field…" planarStatus="loading" />;
  }

  return (
    <section className="fm-field-map">
      <output
        aria-label="Planar field evidence"
        data-planar-component={evidence.component}
        data-planar-evidence={JSON.stringify(evidence)}
        data-planar-field-revision={String(evidence.fieldRevision ?? "")}
        data-planar-glyph-count={String(evidence.glyphCount)}
        data-planar-source-kind={evidence.sourceKind}
        data-planar-source-id={evidence.sourceId}
        data-planar-operator-kind={evidence.operatorKind ?? ""}
        data-planar-raster-checksum={evidence.raster?.checksum ?? ""}
        data-planar-raster-max={String(evidence.raster?.max ?? "")}
        data-planar-raster-min={String(evidence.raster?.min ?? "")}
        data-planar-raster-sample-count={String(evidence.raster?.sampleCount ?? "")}
        data-planar-meta-identity={evidence.metaIdentity ?? ""}
        data-planar-source-hash={evidence.sourceHash ?? ""}
        data-planar-source-revision={String(evidence.sourceRevision ?? "")}
        data-planar-default-plane={evidence.defaultPlane ?? ""}
        data-planar-position-fraction={String(evidence.positionFraction ?? "")}
        data-planar-resolved-coordinate-m={String(evidence.resolvedCoordinateM ?? "")}
        data-planar-operator-thickness-m={String(evidence.operatorThicknessM ?? "")}
        data-planar-domain-generation-id={evidence.domainGenerationId ?? ""}
        data-planar-field-backend={evidence.fieldBackend ?? ""}
        data-planar-field-device={evidence.fieldDevice ?? ""}
        data-planar-field-precision={evidence.fieldPrecision ?? ""}
        data-planar-canonical-unit={evidence.canonicalUnit ?? ""}
        data-planar-carrier-revision={String(evidence.carrierRevision ?? "")}
        data-planar-mesh-revision={String(evidence.meshRevision ?? "")}
        data-planar-sample-token={evidence.sampleToken ?? ""}
        data-planar-field-source={evidence.fieldSource ?? ""}
        data-planar-sampling-execution={evidence.samplingExecution ?? ""}
        data-planar-operator-revision={String(evidence.operatorRevision ?? "")}
        data-planar-scalar-identity={evidence.scalarIdentity ?? ""}
        data-planar-status={evidence.status}
        data-planar-contour-count={String(evidence.overlayCounts.contours)}
        data-planar-bounds-segment-count={String(evidence.overlayCounts.boundsSegments ?? 0)}
        data-planar-mesh-segment-count={String(evidence.overlayCounts.meshSegments)}
        data-planar-point-marker-count={String(evidence.overlayCounts.pointMarkers ?? 0)}
        data-planar-quantity-id={evidence.quantityId}
        hidden
      />
      <header className="fm-field-map__toolbar">
        <strong>{plan.quantityId}</strong>
        <span>{presentationPlanar.component}</span>
        <span>{renderModel.display.legendUnit}</span>
        {surfaceProjectionStatus(meta.data) === "ambiguous" ? (
          <span className="fm-field-map__diagnostic" role="status">
            Ambiguous surface: {meta.data.overlap_count} overlaps,{" "}
            {meta.data.fold_count} folds
          </span>
        ) : null}
      </header>
      <div className="fm-field-map__stage">
        <PlanarSurface
          model={renderModel}
          onInteraction={onInteraction}
          onPin={(u, v) => setPinned([u, v])}
          onRenderEvidence={onRenderEvidence}
        />
        <div className="fm-field-map__axis fm-field-map__axis--u">u ({renderModel.display.axisUnit})</div>
        <div className="fm-field-map__axis fm-field-map__axis--v">v ({renderModel.display.axisUnit})</div>
        <div className="fm-field-map__colorbar" aria-label="Scalar color range">
          <span>{renderModel.range ? renderModel.range.max * renderModel.display.probeScale : "auto"}</span>
          <span>{renderModel.range ? renderModel.range.min * renderModel.display.probeScale : "auto"}</span>
        </div>
      </div>
      {renderModel.diagnostics.length ? (
        <div className="fm-field-map__diagnostics" role="status" aria-label="Planar presentation diagnostics">
          {renderModel.diagnostics.map((message) => <p key={message}>{message}</p>)}
        </div>
      ) : null}
      <FieldMapAuxiliaryDiagnostics
        layers={[
          { label: "Occupancy mask", requested: plan.requestMask, resource: mask },
          { label: "Vector overlay", requested: plan.requestVectors, resource: vectors },
          { label: "Mesh overlay", requested: plan.requestMesh, resource: meshOverlay },
        ]}
      />
      {presentationPlanar.layers.probes && probe.data ? (
        <table className="fm-field-map__pinned-probe">
          <caption>Pinned planar probe</caption>
          <tbody>
            <tr><th scope="row">u</th><td>{probe.data.u_m} m</td></tr>
            <tr><th scope="row">v</th><td>{probe.data.v_m} m</td></tr>
            <tr><th scope="row">Value</th><td>{probe.data.scalar == null ? "undefined" : probe.data.scalar * renderModel.display.probeScale} {renderModel.display.legendUnit}</td></tr>
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
