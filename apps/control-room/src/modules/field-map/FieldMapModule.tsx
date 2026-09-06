"use client";

import { useCallback, useMemo, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
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
import { resolveVisualizationTargetFromSelection } from "@/kernel/visualization/ObjectVisualizationController";
import {
  planarTargetPresentationReason,
  resolvePlanarTargetWireframeStyle,
} from "@/kernel/visualization/planarTargetPresentation";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { projectPlanarPresentationState } from "@/kernel/visualization/planarPresentationProjection";
import { PlanarColorLegend } from "./components/PlanarColorLegend";
import { PlanarPinnedProbe } from "./components/PlanarPinnedProbe";

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
  validateCoherentPlanarBundle,
  type CoherentPlanarBundle,
} from "./model/coherentPlanarBundle";
import {
  resolvePlanarAxes,
  resolvePlanarProbeCoordinates,
} from "./model/planarAxisModel";
import {
  createPlanarEvidence,
  resolvePlanarEvidenceStatus,
  type PlanarEvidenceStatus,
  type PlanarRenderEvidence,
} from "./model/fieldMapEvidence";
import { PlanarSurface } from "./renderer/PlanarSurface";

interface DisplayedPlanarDataset {
  bundle: CoherentPlanarBundle;
  frame: {
    normal: [number, number, number];
    origin: [number, number, number];
    uAxis: [number, number, number];
    vAxis: [number, number, number];
  };
  component: string;
  quantityId: string;
  meshOverlay: ArrayBuffer | null;
  meshOverlayDescriptor?: {
    available: boolean;
    boundaryClassification: string;
    codec?: string | null;
    geometrySource?: string | null;
  };
  etag: string | null;
}

function useFieldMapModuleController() {
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
  const activePinned = canonicalPlanar?.visible !== false && canonicalPlanar?.layers.probes ? pinned : null;
  const activeRenderEvidence = presentationPlanar?.visible !== false && presentationPlanar?.layers.raster ? renderEvidence : null;
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
  const selectedFieldContext = useSelectionSelector((selection) => {
    const ref = selection.ref;
    const candidate = ref && typeof ref === "object"
      ? ref as { snapshotId?: unknown; stageId?: unknown }
      : null;
    return {
      snapshotId:
        candidate && typeof candidate.snapshotId === "string"
          ? candidate.snapshotId
          : null,
      stageId:
        candidate && typeof candidate.stageId === "string"
          ? candidate.stageId
          : null,
      target: resolveVisualizationTargetFromSelection(selection),
    };
  }, {
    isEqual: (left, right) =>
      left.snapshotId === right.snapshotId &&
      left.stageId === right.stageId &&
      left.target?.id === right.target?.id &&
      left.target?.kind === right.target?.kind,
  });
  const effectiveWireframeStyle = useMemo(() => {
    if (!presentationPlanar) return undefined;
    const target = selectedFieldContext.target;
    if (
      !target ||
      planarTargetPresentationReason(
        target,
        visualization.data?.targets,
      ) !== undefined
    ) {
      return presentationPlanar.wireframe_style;
    }
    return resolvePlanarTargetWireframeStyle(
      presentationPlanar.wireframe_style,
      presentationPlanar.target_overrides,
      target,
    );
  }, [
    presentationPlanar,
    selectedFieldContext.target,
    visualization.data?.targets,
  ]);

  const plan = useMemo(
    () => buildFieldMapDataPlan({
      active: active && canonicalPlanar !== undefined && canonicalPlanar.visible !== false,
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
      snapshotId: selectedFieldContext.snapshotId,
      stageId: selectedFieldContext.stageId,
      viewScope: canonicalPlanar?.view_scope,
      vectorBudget: canonicalPlanar?.resolution.vector_budget ?? 0,
    }),
    [
      active,
      domain.data?.discretization,
      canonicalPlanar,
      runtime,
      source,
      selectedFieldContext.snapshotId,
      selectedFieldContext.stageId,
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
            origin: meta.data.frame.origin_m as [number, number, number],
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

  const scalarBuffer = scalar.data?.data;

  const coherentBundle = useMemo(() => {
    if (!meta.data || !scalarBuffer || !mask.data) return null;
    if (scalar.status !== "ready" || mask.status !== "ready") return null;
    if (vectors.data && vectors.status !== "ready") return null;
    const result = validateCoherentPlanarBundle(
      meta.data,
      scalarBuffer,
      mask.data,
      vectors.data ?? null,
      {
        scalarToken: dataQuery.sample_token,
        maskToken: dataQuery.sample_token,
        vectorsToken: vectors.data ? dataQuery.sample_token : null,
      },
    );
    return result.ok && result.bundle.isScientificReady ? result.bundle : null;
  }, [
    dataQuery.sample_token,
    mask.data,
    mask.status,
    meta.data,
    scalarBuffer,
    scalar.status,
    vectors.data,
    vectors.status,
  ]);

  const freshDataset = useMemo<DisplayedPlanarDataset | null>(() => {
    if (!coherentBundle || !coherentBundle.isScientificReady || !frame) return null;
    return {
      bundle: coherentBundle,
      frame,
      component: coherentBundle.component,
      quantityId: coherentBundle.quantityId,
      meshOverlay: (meshOverlay.data as ArrayBuffer) ?? null,
      meshOverlayDescriptor: meta.data
        ? {
            available: meta.data.mesh_overlay_descriptor.available,
            boundaryClassification: meta.data.mesh_overlay_descriptor.boundary_classification,
            codec: meta.data.mesh_overlay_descriptor.codec,
            geometrySource: meta.data.mesh_overlay_descriptor.geometry_source,
          }
        : undefined,
      etag: scalar.data?.etag ?? null,
    };
  }, [coherentBundle, frame, meshOverlay.data, meta.data, scalar.data?.etag]);

  const currentDataset = freshDataset;

  const renderModel = useMemo(() => {
    if (!currentDataset || !presentationPlanar) return null;
    const bundle = currentDataset.bundle;
    const scalarValues = bundle.scalarData;
    const vectorValues = bundle.vectorsData
      ? projectPlanarVectors(bundle.vectorsData, currentDataset.frame)
      : null;
    return buildFieldMapRenderModel({
      bounds: bundle.bounds as [number, number, number, number],
      canonicalUnit: bundle.meta.canonical_unit,
      colormap: presentationPlanar.colormap,
      component: currentDataset.component,
      displayUnit: presentationPlanar.display_unit,
      frame: currentDataset.frame,
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
      mask: bundle.maskData,
      meshOverlayDescriptor: currentDataset.meshOverlayDescriptor,
      meshOverlay: currentDataset.meshOverlay,
      operator: bundle.meta.operator,
      range: normalizePlanarColorRange(presentationPlanar.range),
      rasterOpacity: presentationPlanar.raster_opacity ?? 1,
      visible: presentationPlanar.visible,
      wireframeStyle: effectiveWireframeStyle,
      pointStyle: presentationPlanar.point_style,
      quantityId: currentDataset.quantityId,
      resolution: bundle.resolution as [number, number],
      sampleIdentity: currentDataset.etag ?? bundle.sampleToken,
      scalar: scalarValues,
      vectorBudget: canonicalPlanar?.resolution.vector_budget ?? 0,
      vectorScale: presentationPlanar.vector_style.scale,
      vectorStyle: {
        color: presentationPlanar.vector_style.monochrome_color,
        colorMode: presentationPlanar.vector_style.color_mode,
        lengthMode: presentationPlanar.vector_style.length_mode,
        opacity: presentationPlanar.vector_style.opacity,
        thickness: presentationPlanar.vector_style.thickness,
      },
      vectors: vectorValues,
    });
  }, [
    canonicalPlanar?.resolution.vector_budget,
    currentDataset,
    effectiveWireframeStyle,
    presentationPlanar,
  ]);
  const pinnedAxisState = useMemo(() => {
    if (!renderModel?.frame || !probe.data) return null;
    const axisFrame = {
      normal: renderModel.frame.normal,
      origin: renderModel.frame.origin,
      uAxis: renderModel.frame.uAxis,
      vAxis: renderModel.frame.vAxis,
    };
    return {
      axes: resolvePlanarAxes(
        axisFrame,
        renderModel.bounds,
        renderModel.viewport,
        1,
        1,
      ),
      coordinates: resolvePlanarProbeCoordinates(
        axisFrame,
        probe.data.u_m,
        probe.data.v_m,
      ),
    };
  }, [probe.data, renderModel]);


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

  return {
    canonicalPlanar,
    canonicalSampleError,
    evidence,
    frame,
    mask,
    meshOverlay,
    meta,
    onInteraction,
    onRenderEvidence,
    pinnedAxisState,
    plan,
    presentationPlanar,
    probe,
    renderModel,
    scalar,
    setPinned,
    vectors,
    visualization,
  };
}

export default function FieldMapModule() {
  const {
    canonicalPlanar,
    canonicalSampleError,
    evidence,
    frame,
    mask,
    meshOverlay,
    meta,
    onInteraction,
    onRenderEvidence,
    pinnedAxisState,
    plan,
    presentationPlanar,
    probe,
    renderModel,
    scalar,
    setPinned,
    vectors,
    visualization,
  } = useFieldMapModuleController();
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
          probeOverlay={presentationPlanar.layers.probes && probe.data ? (
            <PlanarPinnedProbe
              axisState={pinnedAxisState}
              legendUnit={renderModel.display.legendUnit}
              probe={probe.data}
              probeScale={renderModel.display.probeScale}
            />
          ) : null}
        />
        {presentationPlanar.viewport_colorbar_visible !== false ? (
          <PlanarColorLegend
            colormap={presentationPlanar.colormap}
            component={presentationPlanar.component}
            legendUnit={renderModel.display.legendUnit}
            probeScale={renderModel.display.probeScale}
            quantityId={plan.quantityId}
            range={renderModel.range}
          />
        ) : null}
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
