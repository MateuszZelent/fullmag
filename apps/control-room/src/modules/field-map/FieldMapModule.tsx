"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { useKernel } from "@/kernel/KernelContext";
import { decodeFieldVector } from "@/kernel/api/codecs";
import { normalizeTensorProjection } from "@/kernel/api/tensorFieldProjection";
import { quantityCatalogEntrySpatialProjections, quantityCatalogEntrySupportsSpatialVisualization } from "@/kernel/api/quantityIds";
import { useQuantityCatalogResource } from "@/kernel/resources/studyRuntimeResources";
import type {
  PlanarFieldSource,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import {
  planarFieldQueryFromMeta,
  usePlanarFieldMetaResource,
  usePlanarMaskResource,
  usePlanarMeshOverlayResource,
  usePlanarProbeResource,
  usePlanarProfileResource,
  usePlanarScalarResource,
  usePlanarVectorResource,
} from "@/kernel/resources/planarFieldResources";
import { useDomainMetaResource } from "@/kernel/resources/geometryLifecycleResources";
import { useFieldCatalogResource } from "@/kernel/resources/studyRuntimeResources";
import { useGeometryRealizationResource } from "@/kernel/resources/useGeometryRealizationResource";
import { resolveSessionDiscretization } from "@/kernel/resources/sessionDiscretization";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { useSessionScopedResourceKey } from "@/kernel/resources/useSessionScopedResourceKey";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import { resolveVisualizationTargetFromSelection } from "@/kernel/visualization/ObjectVisualizationController";
import {
  planarTargetPresentationReason,
  resolvePlanarTargetWireframeStyle,
} from "@/kernel/visualization/planarTargetPresentation";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { projectPlanarPresentationState } from "@/kernel/visualization/planarPresentationProjection";
import {
  PLANAR_VECTOR_CARRIER_COMPONENT,
  derivePlanarComponentScalar,
  isClientDerivablePlanarComponent,
  resolvePlanarComponentDerivation,
} from "./model/planarComponentDerivation";
import {
  objectSectionLayers,
  planarSectionAxes,
  resolvePlanarSectionGeometry,
  withSectionStops,
} from "@/kernel/visualization/planarSectionModel";
import { isDirectionColormap } from "@/shared/visualization/directionColor";
import { FieldMapToolbar, type FieldMapToolbarQuantity } from "./components/FieldMapToolbar";
import { FieldMapAuxiliaryDiagnostics } from "./components/FieldMapAuxiliaryDiagnostics";
import { PlanarColorLegend } from "./components/PlanarColorLegend";
import { PlanarMultisliceGrid } from "./components/PlanarMultisliceGrid";
import { PlanarSnapshotNavigator } from "./components/PlanarSnapshotNavigator";
import { PlanarPinnedProbe } from "./components/PlanarPinnedProbe";
import { PlanarProfileChart } from "./components/PlanarProfileChart";
import { quantityDisplayName } from "@/kernel/api/quantityIds";
import { PlanarSectionStrip } from "./components/PlanarSectionStrip";

import {
  buildFieldMapDataPlan,
  buildFieldMapProbeQuery,
  buildFieldMapProfileQuery,
} from "./model/fieldMapDataPlan";
import {
  buildFieldMapRenderModel,
  normalizePlanarColorRange,
  projectPlanarVectors,
  surfaceProjectionStatus,
} from "./model/fieldMapRenderModel";
import {
  resolvePlanarAxes,
  resolvePlanarProbeCoordinates,
} from "./model/planarAxisModel";
import {
  createPlanarEvidence,
  planarRenderIdentity,
  planarRenderScalarIdentity,
  resolvePlanarEvidenceStatus,
  type PlanarEvidenceStatus,
  type PlanarRenderEvidence,
} from "./model/fieldMapEvidence";
import { PlanarSurface, type PlanarProfileSegment } from "./renderer/PlanarSurface";
import { createCoalescedFramePublisher } from "./renderer/planarFrameScheduler";
import { useRetainedPlanarFrame } from "./hooks/useRetainedPlanarFrame";
import { fieldMapSurfaceStore as fieldMapStore } from "@/kernel/visualization/fieldMapSurfaceStore";

type SectionDefaultSlice = NonNullable<VisualizationStateResource["planar"]>["default_slice"];
type PlanarPatch = NonNullable<Parameters<ReturnType<typeof useKernel>["visualizationSync"]["queuePatch"]>[0]["planar"]>;

/** Uniform samples per line profile; FEM adds the element-face crossings. */
const PROFILE_SAMPLES = 512;

function useFieldMapModuleController() {
  const { layout, visualizationSync } = useKernel();
  const { resourceKey: sessionFrameKey, sessionIdentity } = useSessionScopedResourceKey("planar-render-frame");
  const [pinned, setPinned] = useState<readonly [number, number] | null>(null);
  const [renderEvidence, setRenderEvidence] =
    useState<PlanarRenderEvidence | null>(null);
  const active = layout.get().activeViewportMainModuleId === "field-map";
  const visualization = useVisualizationStateResource({ enabled: active });
  const canonicalPlanar = visualization.data?.planar;
  const presentationBase = useMemo(
    () => projectPlanarPresentationState(
      visualization.data,
      visualization.optimisticData,
    ),
    [visualization.data, visualization.optimisticData],
  );
  const activePinned = canonicalPlanar?.visible !== false && canonicalPlanar?.layers.probes ? pinned : null;
  const activeRenderEvidence = presentationBase?.visible !== false && presentationBase?.layers.raster ? renderEvidence : null;
  const canonicalSourceKind = canonicalPlanar?.source.kind;
  const canonicalSourceMonitorId = canonicalSourceKind === "monitor"
    ? canonicalPlanar?.source.monitor_id
    : undefined;
  const canonicalSliceKey = canonicalPlanar
    ? JSON.stringify(canonicalPlanar.default_slice)
    : undefined;
  const source = useMemo<PlanarFieldSource>(() => {
    if (canonicalSourceKind === "monitor" && canonicalSourceMonitorId) {
      return {
        kind: "monitor",
        monitorId: canonicalSourceMonitorId,
      };
    }
    return { kind: "default", sliceKey: canonicalSliceKey };
  }, [canonicalSliceKey, canonicalSourceKind, canonicalSourceMonitorId]);
  const domain = useDomainMetaResource({ enabled: active });
  const fieldCatalog = useFieldCatalogResource({ enabled: active });
  const runtime = useSessionStatusSelector(
    (status) => resolveSessionDiscretization(status.data),
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
    if (!presentationBase) return undefined;
    const target = selectedFieldContext.target;
    if (
      !target ||
      planarTargetPresentationReason(
        target,
        visualization.data?.targets,
      ) !== undefined
    ) {
      return presentationBase.wireframe_style;
    }
    return resolvePlanarTargetWireframeStyle(
      presentationBase.wireframe_style,
      presentationBase.target_overrides,
      target,
    );
  }, [
    presentationBase,
    selectedFieldContext.target,
    visualization.data?.targets,
  ]);

  const quantityCatalog = useQuantityCatalogResource({
    enabled: active,
    stageId: selectedFieldContext.stageId,
  });
  const toolbarQuantities = useMemo<FieldMapToolbarQuantity[]>(
    () => (fieldCatalog.data?.quantities ?? [])
      .filter((quantity) => quantity.available)
      .map((quantity) => {
        const entry = quantityCatalog.data?.quantities.find((candidate) => candidate.id === quantity.quantity_id);
        return {
          components: quantity.components ?? 3,
          label: quantity.label,
          quantityId: quantity.quantity_id,
          unit: quantity.unit,
          tensor: entry?.tensor != null || entry?.shape === "tensor_field" || quantity.components === 9,
          projections: quantityCatalogEntrySpatialProjections(entry),
        };
      }),
    [fieldCatalog.data, quantityCatalog.data],
  );
  const selectedQuantity = quantityCatalog.data?.quantities.find(
    (entry) => entry.id === canonicalPlanar?.quantity_id,
  );
  // D2D-12: x/y/z/|v| of a vector plane sample are derived from its vectors,
  // so a component switch is presentation (no new sample, 0 requests).
  const componentDerivation = resolvePlanarComponentDerivation({
    component: canonicalPlanar?.component,
    operatorKind: canonicalSourceKind === "default" ? canonicalPlanar?.default_slice.operator.kind : null,
    quantity: selectedQuantity,
  });
  const clientComponents = componentDerivation === "client";
  const presentationPlanar = useMemo(
    () => projectPlanarPresentationState(
      visualization.data,
      visualization.optimisticData,
      {
        clientComponent: (authoritative, optimistic) => clientComponents &&
          isClientDerivablePlanarComponent(authoritative) &&
          isClientDerivablePlanarComponent(optimistic),
      },
    ),
    [clientComponents, visualization.data, visualization.optimisticData],
  );
  const displayComponent = presentationPlanar?.component ?? "";
  // One carrier sample feeds every client-side component raster, so the
  // rendered frame identity must name the component it shows.
  const componentPresentationKey = clientComponents ? `component=${displayComponent}` : null;
  const requiresTensorProjection = selectedQuantity?.tensor != null ||
    selectedQuantity?.shape === "tensor_field" ||
    normalizeTensorProjection(canonicalPlanar?.component) !== null;
  const projectionAllowed = !requiresTensorProjection || Boolean(
    selectedQuantity && quantityCatalogEntrySupportsSpatialVisualization(selectedQuantity, canonicalPlanar?.component),
  );
  const plan = useMemo(
    () => buildFieldMapDataPlan({
      active: active && canonicalPlanar !== undefined && canonicalPlanar.visible !== false,
      component: clientComponents ? PLANAR_VECTOR_CARRIER_COMPONENT : canonicalPlanar?.component ?? "",
      discretization:
        domain.data?.discretization ?? runtime ?? null,
      includeMesh: (canonicalPlanar?.layers.mesh ?? false) || (canonicalPlanar?.layers.boundaries ?? false),
      source,
      quality: canonicalPlanar?.quality ?? "interactive",
      quantityId: canonicalPlanar?.quantity_id ?? "",
      projectionAllowed,
      resolution: [
        canonicalPlanar?.resolution.width ?? 0,
        canonicalPlanar?.resolution.height ?? 0,
      ],
      // Streamlines trace the same frame-vector raster as the quiver.
      showVectors: (canonicalPlanar?.layers.vectors ?? false) || (canonicalPlanar?.layers.streamlines ?? false),
      colorByDirection: isDirectionColormap(canonicalPlanar?.colormap) || clientComponents,
      snapshotId: selectedFieldContext.snapshotId,
      stageId: selectedFieldContext.stageId,
      viewScope: canonicalPlanar?.view_scope,
      vectorBudget: canonicalPlanar?.resolution.vector_budget ?? 0,
    }),
    [
      active,
      clientComponents,
      domain.data?.discretization,
      canonicalPlanar,
      projectionAllowed,
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
  const component = clientComponents ? displayComponent : canonicalPlanar?.component ?? "";
  const quantityId = canonicalPlanar?.quantity_id ?? "";
  const onRenderEvidence = useCallback(
    (next: PlanarRenderEvidence) => setRenderEvidence(next),
    [],
  );
  // P2-01: pointer gestures fire far more often than frames. Keep only the
  // latest interaction and publish it at most once per animation frame.
  const interactionPublisher = useMemo(
    () => typeof window === "undefined"
      ? null
      : createCoalescedFramePublisher<{ panU: number; panV: number; zoom: number }>(
          window,
          (interaction) => visualizationSync.queuePatch({
            planar: {
              interaction: {
                pan_u_m: interaction.panU,
                pan_v_m: interaction.panV,
                zoom: interaction.zoom,
              },
            },
          }),
        ),
    [visualizationSync],
  );
  useEffect(() => () => interactionPublisher?.dispose(), [interactionPublisher]);
  const onInteraction = useCallback((interaction: { panU: number; panV: number; zoom: number }) => {
    interactionPublisher?.push(interaction);
  }, [interactionPublisher]);
  const onPlanarPatch = useCallback((patch: PlanarPatch) => {
    visualizationSync.queuePatch({ planar: patch });
    // Quantity, component and section are sample identity: send them now
    // instead of after the debounce window (D2D-12).
    if (patch.quantity_id !== undefined || patch.component !== undefined || patch.default_slice !== undefined) {
      void visualizationSync.flushNow?.();
    }
  }, [visualizationSync]);
  const onSectionChange = useCallback((defaultSlice: SectionDefaultSlice) => {
    visualizationSync.queuePatch({ planar: { default_slice: defaultSlice } });
    void visualizationSync.flushNow?.();
  }, [visualizationSync]);
  const sectionDefaultSlice =
    canonicalPlanar?.source.kind === "default"
      ? visualization.optimisticData?.planar?.default_slice ?? canonicalPlanar.default_slice
      : null;
  // Named layers: realized objects along the section normal (note 0970).
  const realization = useGeometryRealizationResource(active && sectionDefaultSlice !== null);
  const sectionPlane = sectionDefaultSlice?.plane ?? null;
  const objectLayers = useMemo(
    () => sectionPlane
      ? objectSectionLayers(realization.data?.bodies, planarSectionAxes(sectionPlane).normal)
      : [],
    [realization.data?.bodies, sectionPlane],
  );
  // Decode binary payloads once per resource revision. Presentation-only
  // updates (pan, zoom, styles) must reuse the same typed arrays so the worker
  // does not recolour the raster on every pointer event.
  const worldVectorValues = useMemo(
    () => (vectors.data ? decodeFieldVector(vectors.data).values : null),
    [vectors.data],
  );
  const scalarValues = useMemo(
    () => clientComponents && worldVectorValues && isClientDerivablePlanarComponent(displayComponent)
      ? derivePlanarComponentScalar(worldVectorValues, displayComponent)
      : scalar.data ? decodeFieldVector(scalar.data.data).values : null,
    [clientComponents, displayComponent, scalar.data, worldVectorValues],
  );
  const frameVectorValues = useMemo(
    () => (worldVectorValues && frame ? projectPlanarVectors(worldVectorValues, frame) : null),
    [frame, worldVectorValues],
  );
  const maskValues = useMemo(
    () => (mask.data ? new Uint8Array(mask.data) : null),
    [mask.data],
  );
  const freshRenderModel = useMemo(() => {
    if (!meta.data || !scalar.data || !scalarValues || !frame || !presentationPlanar) return null;
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
        streamlines: presentationPlanar.layers.streamlines ?? false,
        vectors: presentationPlanar.layers.vectors,
      },
      mask: maskValues,
      meshOverlayDescriptor: {
        available: meta.data.mesh_overlay_descriptor.available,
        boundaryClassification: meta.data.mesh_overlay_descriptor.boundary_classification,
        codec: meta.data.mesh_overlay_descriptor.codec,
        geometrySource: meta.data.mesh_overlay_descriptor.geometry_source,
      },
      meshOverlay: meshOverlay.data,
      range: normalizePlanarColorRange(presentationPlanar.range),
      rasterOpacity: presentationPlanar.raster_opacity ?? 1,
      visible: presentationPlanar.visible,
      wireframeStyle: effectiveWireframeStyle,
      pointStyle: presentationPlanar.point_style,
      resolution: meta.data.resolution as [number, number],
      sampleIdentity: planarRenderIdentity(scalar.data.etag, componentPresentationKey),
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
      vectors: frameVectorValues,
      worldVectors: worldVectorValues,
    });
  }, [canonicalPlanar?.resolution.vector_budget, componentPresentationKey, effectiveWireframeStyle, frame, frameVectorValues, maskValues, meshOverlay.data, meta.data, presentationPlanar, scalar.data, scalarValues, worldVectorValues]);
  // LR-10: rewizja próbki jest częścią klucza zasobu, więc każda nowa rewizja
  // tworzy świeży wpis store bez danych. Bez retencji rodzic renderował wtedy
  // FieldMapStatus zamiast PlanarSurface, a cleanup zwalniał renderer i worker
  // oraz czyścił canvas — obraz mapy 2D znikał przy każdym odświeżeniu.
  // Trzymamy ostatnią zgodną klatkę, ale wyłącznie dla tej samej semantycznej
  // tożsamości widoku: zmiana monitora, wielkości, komponentu, rozdzielczości,
  // snapshotu czy etapu odrzuca retencję, zamiast pokazywać cudzy raster.
  // Pozycja warstwy wzdłuż normalnej nie należy do tej tożsamości: krok suwaka
  // zachowuje poprzednią klatkę (jak w mumax3), a odczyt warstwy mówi wprost,
  // która warstwa jest pokazana, a która się ładuje.
  const planarViewIdentityKey = useMemo(
    () =>
      JSON.stringify({
        sessionFrameKey,
        domainGenerationId: domain.data?.generation_id ?? null,
        defaultSliceShape: canonicalPlanar?.source.kind === "default"
          ? {
              operator: canonicalPlanar.default_slice.operator,
              plane: canonicalPlanar.default_slice.plane,
            }
          : null,
        vectorBudget: canonicalPlanar?.resolution.vector_budget ?? 0,
        component: canonicalPlanar?.component ?? null,
        quality: canonicalPlanar?.quality ?? null,
        quantityId: canonicalPlanar?.quantity_id ?? null,
        resolution: [
          canonicalPlanar?.resolution.width ?? 0,
          canonicalPlanar?.resolution.height ?? 0,
        ],
        snapshotId: selectedFieldContext.snapshotId ?? null,
        sourceId: canonicalSourceMonitorId ?? null,
        sourceKind: canonicalSourceKind ?? null,
        stageId: selectedFieldContext.stageId ?? null,
        viewScope: canonicalPlanar?.view_scope ?? null,
      }),
    [
      sessionFrameKey,
      domain.data?.generation_id,
      canonicalPlanar,
      canonicalSourceKind,
      canonicalSourceMonitorId,
      selectedFieldContext.snapshotId,
      selectedFieldContext.stageId,
    ],
  );
  const renderModel = useRetainedPlanarFrame(
    sessionIdentity === null ? null : planarViewIdentityKey,
    freshRenderModel,
    // A monitor edit changes the sampled definition; the default slice position
    // is deliberately excluded above so a layer step keeps the last frame.
    canonicalSourceKind === "monitor" && meta.data?.source
      ? JSON.stringify(meta.data.source)
      : null,
  );
  const pinnedAxisState = useMemo(() => {
    if (!renderModel || !probe.data) return null;
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
  // F6 B1: a line profile is a derived resource of the current sample. The
  // segment belongs to one view identity, so a new source, plane or quantity
  // drops it, while a layer step re-evaluates it on the new sample.
  const [profileSegment, setProfileSegment] = useState<{
    key: string | null;
    segment: PlanarProfileSegment;
  } | null>(null);
  const activeProfileSegment = profileSegment?.key === planarViewIdentityKey
    ? profileSegment.segment
    : null;
  const onProfileSegment = useCallback(
    (segment: PlanarProfileSegment | null) =>
      setProfileSegment(segment ? { key: planarViewIdentityKey, segment } : null),
    [planarViewIdentityKey],
  );
  const profile = usePlanarProfileResource(
    plan.quantityId,
    plan.source,
    activeProfileSegment && canonicalSampleReady
      ? buildFieldMapProfileQuery(dataQuery, activeProfileSegment, PROFILE_SAMPLES)
      : null,
    { enabled: plan.enabled },
  );
  // Multislice panels (F6 B2) replace the single surface for the Default source.
  const multislice = plan.source.kind === "default" && presentationPlanar?.multislice?.enabled
    ? presentationPlanar.multislice
    : null;
  const profileLengthUnit = useMemo(() => activeProfileSegment && renderModel?.frame
    ? resolvePlanarAxes(
        {
          normal: renderModel.frame.normal,
          origin: renderModel.frame.origin,
          uAxis: renderModel.frame.uAxis,
          vAxis: renderModel.frame.vAxis,
        },
        renderModel.bounds,
        renderModel.viewport,
        1,
        1,
      ).displayLengthUnit
    : null, [activeProfileSegment, renderModel]);


  const evidenceStatus: PlanarEvidenceStatus = resolvePlanarEvidenceStatus({
    metaIdentity: meta.data?.etag,
    metaStatus: meta.status,
    presentationKey: componentPresentationKey,
    renderEvidence: activeRenderEvidence,
    scalarIdentity: scalar.data?.etag,
    scalarStatus: scalar.status,
  });
  const metaSection = meta.data?.section ?? null;
  const sectionGeometry = useMemo(
    () => canonicalPlanar?.source.kind === "default"
      ? withSectionStops(
          resolvePlanarSectionGeometry(domain.data, canonicalPlanar.default_slice.plane),
          metaSection,
        )
      : null,
    [canonicalPlanar, domain.data, metaSection],
  );
  // Publish derived facts for keyboard commands and the Inspector (one owner).
  useEffect(() => {
    if (!active) return;
    fieldMapStore.set({ evidenceStatus, planar: presentationPlanar ?? null, sectionGeometry });
  }, [active, evidenceStatus, presentationPlanar, sectionGeometry]);
  useEffect(() => () => fieldMapStore.reset(), []);
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
  // Coordinate of the frame on screen; a retained frame can lag a new request.
  const shownCoordinateM = defaultPlane
    ? renderModel?.frame?.origin[normalIndex] ?? null
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
    scalarIdentity: planarRenderScalarIdentity(activeRenderEvidence?.sampleIdentity),
    status: evidenceStatus,
  });

  return {
    canonicalPlanar,
    canonicalSampleError,
    domainMeta: domain.data,
    evidence,
    evidenceStatus,
    mask,
    meshOverlay,
    meta,
    onInteraction,
    onPlanarPatch,
    onRenderEvidence,
    onSectionChange,
    activeProfileSegment,
    onProfileSegment,
    pinnedAxisState,
    plan,
    presentationPlanar,
    probe,
    profile,
    profileLengthUnit,
    renderModel,
    scalar,
    metaSection,
    objectLayers,
    sectionDefaultSlice,
    setPinned,
    shownCoordinateM,
    toolbarQuantities,
    vectors,
    visualization,
    multislice,
    multisliceClientComponent: clientComponents ? displayComponent : null,
  };
}

export default function FieldMapModule() {
  const {
    canonicalPlanar,
    canonicalSampleError,
    domainMeta,
    evidence,
    mask,
    meshOverlay,
    meta,
    onInteraction,
    onPlanarPatch,
    onRenderEvidence,
    onSectionChange,
    activeProfileSegment,
    onProfileSegment,
    pinnedAxisState,
    plan,
    presentationPlanar,
    probe,
    profile,
    profileLengthUnit,
    renderModel,
    scalar,
    metaSection,
    objectLayers,
    sectionDefaultSlice,
    setPinned,
    shownCoordinateM,
    toolbarQuantities,
    vectors,
    visualization,
    multislice,
    multisliceClientComponent,
  } = useFieldMapModuleController();
  const sectionStrip = sectionDefaultSlice ? (
    <PlanarSectionStrip
      defaultSlice={sectionDefaultSlice}
      domain={domainMeta}
      objectLayers={objectLayers}
      section={metaSection}
      shownCoordinate={shownCoordinateM}
      onChange={onSectionChange}
    />
  ) : null;
  const toolbar = presentationPlanar ? (
    <FieldMapToolbar
      planar={presentationPlanar}
      quantities={toolbarQuantities}
      sectionStrip={sectionStrip}
      onPatch={onPlanarPatch}
    />
  ) : sectionStrip;
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
        toolbar={toolbar}
      />
    );
  }
  if (meta.status === "ready" && (!meta.data || !scalar.data) && !renderModel) {
    return (
      <FieldMapStatus
        message="No planar field is published for this revision."
        toolbar={toolbar}
      />
    );
  }
  if (!renderModel) {
    return (
      <FieldMapStatus
        message="Loading planar field…"
        planarStatus="loading"
        toolbar={toolbar}
      />
    );
  }
  const ambiguousSurfaceMeta = meta.data && surfaceProjectionStatus(meta.data) === "ambiguous"
    ? meta.data
    : null;

  return (
    <section className={activeProfileSegment ? "fm-field-map fm-field-map--with-profile" : "fm-field-map"}>
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
        {toolbar}
        <PlanarSnapshotNavigator status={evidence.status} />
        {ambiguousSurfaceMeta ? (
          <span className="fm-field-map__diagnostic" role="status">
            Ambiguous surface: {ambiguousSurfaceMeta.overlap_count} overlaps,{" "}
            {ambiguousSurfaceMeta.fold_count} folds
          </span>
        ) : null}
      </header>
      <div className="fm-field-map__stage">
        {multislice ? (
          <PlanarMultisliceGrid
            baseQuery={plan.query}
            clientComponent={multisliceClientComponent}
            colorByDirection={renderModel.directionVectors !== null}
            colormap={renderModel.colormap ?? presentationPlanar.colormap}
            positionFractions={multislice.position_fractions}
            quantityId={plan.quantityId}
            range={normalizePlanarColorRange(presentationPlanar.range)}
            rasterOpacity={presentationPlanar.raster_opacity ?? 1}
            renderLegend={(range) => presentationPlanar.viewport_colorbar_visible !== false ? (
              <PlanarColorLegend colormap={renderModel.colormap ?? presentationPlanar.colormap} component={presentationPlanar.component} legendUnit={renderModel.display.legendUnit} probeScale={renderModel.display.probeScale} quantityId={plan.quantityId} range={range} rangeState={range ? "current" : "pending"} />
            ) : null}
            requestVectors={plan.requestVectors}
            source={plan.source}
          />
        ) : (
        <PlanarSurface
          model={renderModel}
          onInteraction={onInteraction}
          onPin={(u, v) => setPinned([u, v])}
          onProfileSegment={onProfileSegment}
          onRenderEvidence={onRenderEvidence}
          profileSegment={activeProfileSegment}
          probeOverlay={presentationPlanar.layers.probes && probe.data ? (
            <PlanarPinnedProbe
              axisState={pinnedAxisState}
              legendUnit={renderModel.display.legendUnit}
              probe={probe.data}
              probeScale={renderModel.display.probeScale}
            />
          ) : null}
        />
        )}
        {presentationPlanar.viewport_colorbar_visible !== false && !multislice ? (
          <PlanarColorLegend
            colormap={renderModel.colormap ?? presentationPlanar.colormap}
            component={presentationPlanar.component}
            legendUnit={renderModel.display.legendUnit}
            probeScale={renderModel.display.probeScale}
            quantityId={plan.quantityId}
            range={renderModel.range}
            rangeState={
              renderModel.range
                ? evidence.status === "ready"
                  ? "current"
                  : "stale-compatible"
                : evidence.status === "loading"
                  ? "pending"
                  : "unavailable"
            }
          />
        ) : null}
      </div>
      {activeProfileSegment ? (
        <PlanarProfileChart
          display={{
            lengthScale: profileLengthUnit?.scale ?? 1,
            lengthUnit: profileLengthUnit?.symbol ?? "m",
            legendUnit: renderModel.display.legendUnit,
            probeScale: renderModel.display.probeScale,
          }}
          onClear={() => onProfileSegment(null)}
          profile={profile.data ?? null}
          quantityLabel={quantityDisplayName(plan.quantityId)}
          status={profile.status === "error" ? `unavailable: ${String((profile.error as Error | null)?.message ?? "error")}` : "loading"}
        />
      ) : null}
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

function FieldMapStatus({
  kind = "status",
  message,
  planarStatus,
  toolbar = null,
}: {
  kind?: "error" | "status";
  message: string;
  planarStatus?: PlanarEvidenceStatus;
  toolbar?: ReactNode;
}) {
  const status = (
    <div
      className={`fm-field-map fm-field-map--${kind}`}
      data-planar-status={planarStatus}
      role={kind === "error" ? "alert" : "status"}
    >
      {message}
    </div>
  );
  if (!toolbar) return status;
  return (
    <section className="fm-field-map">
      <header className="fm-field-map__toolbar">{toolbar}</header>
      {status}
    </section>
  );
}
