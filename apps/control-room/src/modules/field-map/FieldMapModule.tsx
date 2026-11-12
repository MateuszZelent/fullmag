"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useKernel } from "@/kernel/KernelContext";
import { decodeFieldVector } from "@/kernel/api/codecs";
import { normalizeTensorProjection } from "@/kernel/api/tensorFieldProjection";
import { quantityCatalogEntrySupportsSpatialVisualization } from "@/kernel/api/quantityIds";
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
  usePlanarProfileResource,
  usePlanarScalarResource,
  usePlanarVectorResource,
  planarWindowParams,
} from "@/kernel/resources/planarFieldResources";
import { useDomainMetaResource } from "@/kernel/resources/geometryLifecycleResources";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
import { useGeometryRealizationResource } from "@/kernel/resources/useGeometryRealizationResource";
import { resolveSessionDiscretization } from "@/kernel/resources/sessionDiscretization";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { useSessionScopedResourceKey } from "@/kernel/resources/useSessionScopedResourceKey";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
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
  resolvePlanarSectionGeometryFromMeta,
  stepSectionFraction,
} from "@/kernel/visualization/planarSectionModel";
import {
  planarToolStore,
  type PlanarCursorUv,
  type PlanarUvRect,
} from "@/kernel/visualization/planarToolStore";
import { formatValueWithUnit } from "@/shared/domain/physics/displayUnits";
import { isDirectionColormap } from "@/shared/visualization/directionColor";
import { FieldMapAuxiliaryDiagnostics } from "./components/FieldMapAuxiliaryDiagnostics";
import { PlanarColorLegend } from "./components/PlanarColorLegend";
import { PlanarCompositionSurface } from "./components/PlanarCompositionSurface";
import { registerFieldMapCapture } from "./fieldMapCaptureRegistry";
import { captureVisibleFieldMapPng } from "./fieldMapPngCapture";
import { PlanarMultisliceGrid } from "./components/PlanarMultisliceGrid";
import { multisliceLegendUnit } from "./model/planarMultislice";
import { PlanarSnapshotNavigator } from "./components/PlanarSnapshotNavigator";
import { PlanarNodeInspector } from "./components/PlanarNodeReadout";
import type { PlanarFieldLayerRuntime } from "./hooks/usePlanarNodeProbes";
import type { PlanarCompositionFrame } from "./model/planarCompositionFrame";
import { withStalePlanarCropCleared } from "./model/planarCropPatch";
import { layerVisible, multisliceLayer } from "@/modules/inspector/public";
import { PlanarProfileChart } from "./components/PlanarProfileChart";
import { quantityDisplayName } from "@/kernel/api/quantityIds";
import { PlanarStatusBar } from "./components/PlanarStatusBar";
import { PlanarToolbar } from "./components/PlanarToolbar";
import { describePlanarError, isSupersededPlanarError } from "./model/planarErrorCopy";

import {
  buildFieldMapDataPlan,
  buildFieldMapProfileQuery,
  planarMeshDrawn,
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
  samePlanarRenderEvidence,
  type PlanarEvidenceStatus,
  type PlanarRenderEvidence,
} from "./model/fieldMapEvidence";
import { PlanarSurface, type PlanarProfileSegment } from "./renderer/PlanarSurface";
import { createCoalescedFramePublisher } from "./renderer/planarFrameScheduler";
import { useRetainedPlanarFrame } from "./hooks/useRetainedPlanarFrame";
import { fieldMapSurfaceStore as fieldMapStore } from "@/kernel/visualization/fieldMapSurfaceStore";

type SectionDefaultSlice = NonNullable<VisualizationStateResource["planar"]>["default_slice"];


/** Uniform samples per line profile; FEM adds the element-face crossings. */
const PROFILE_SAMPLES = 512;

/** The toolbar reads the command registry itself; one element serves every render. */
const PLANAR_TOOLBAR = <PlanarToolbar />;


/** A requested overlay is settled once its request finished, with data or not. */
function planarLayerSettled(requested: boolean, status: ResourceStatus): boolean {
  return !requested || status === "ready" || status === "stale" || status === "error";
}

function useFieldMapModuleController() {
  const { layout, visualizationSync } = useKernel();
  const { resourceKey: sessionFrameKey, sessionIdentity } = useSessionScopedResourceKey("planar-render-frame");
  const [pinned, setPinned] = useState<PlanarCursorUv | null>(null);
  const [compositionFrame, setCompositionFrame] = useState<PlanarCompositionFrame | null>(null);
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
  // A pinned readout stays across tool changes until it is closed.
  const activePinned = canonicalPlanar?.visible !== false ? pinned : null;
  // ADR 0080: in the layer model the field layers draw every field and the
  // base sample only names the frame; legacy keeps the base field.
  const metaOnlyBase = canonicalPlanar?.layer_model === "layers";
  const crop = canonicalPlanar?.crop ?? null;
  const windowParams = useMemo(() => planarWindowParams(crop), [crop]);
  const activeRenderEvidence = presentationBase?.visible !== false && (metaOnlyBase || presentationBase?.layers.raster)
    ? renderEvidence
    : null;
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
      includeMesh: planarMeshDrawn(canonicalPlanar) || (canonicalPlanar?.layers.boundaries ?? false),
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
      layerModel: canonicalPlanar?.layer_model,
      cropWindow: windowParams,
    }),
    [
      active,
      windowParams,
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
  // The renderer republishes evidence whenever an overlay input changes; keep
  // the previous state when nothing observable changed so the publish cannot
  // re-render this module into another publish (maximum update depth).
  const onRenderEvidence = useCallback(
    (next: PlanarRenderEvidence) =>
      setRenderEvidence((previous) => samePlanarRenderEvidence(previous, next) ? previous : next),
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

  const onSectionChange = useCallback((defaultSlice: SectionDefaultSlice) => {
    visualizationSync.queuePatch({
      planar: withStalePlanarCropCleared(canonicalPlanar, { default_slice: defaultSlice }),
    });
    void visualizationSync.flushNow?.();
  }, [canonicalPlanar, visualizationSync]);
  const onCropCommit = useCallback((rect: PlanarUvRect) => {
    visualizationSync.queuePlanarCropPatch(rect);
  }, [visualizationSync]);
  const onClearCrop = useCallback(() => {
    visualizationSync.queuePlanarCropPatch(null);
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
  // A client-derived component waits for its vectors; falling back to the
  // carrier scalar would label a magnitude raster as x, y or z.
  const clientDerived = clientComponents && isClientDerivablePlanarComponent(displayComponent);
  const metaResolution = meta.data?.resolution;
  const scalarValues = useMemo(
    () => metaOnlyBase
      // The base draws no field; the renderer still needs a sized buffer.
      ? metaResolution ? new Float64Array((metaResolution[0] ?? 0) * (metaResolution[1] ?? 0)) : null
      : clientDerived
        ? worldVectorValues ? derivePlanarComponentScalar(worldVectorValues, displayComponent) : null
        : scalar.data ? decodeFieldVector(scalar.data.data).values : null,
    [clientDerived, displayComponent, metaOnlyBase, metaResolution, scalar.data, worldVectorValues],
  );
  const baseIdentity = metaOnlyBase
    ? meta.status === "ready" ? meta.data?.etag ?? null : null
    : scalar.data ? scalar.data.etag : null;
  const baseReady = metaOnlyBase ? baseIdentity !== null : scalar.data !== null && scalar.data !== undefined;
  // Publish a frame only once every requested layer of the same sample has
  // settled, so overlays do not vanish and return on each live refresh.
  const layersSettled =
    planarLayerSettled(plan.requestMask, mask.status) &&
    planarLayerSettled(plan.requestVectors, vectors.status) &&
    planarLayerSettled(plan.requestMesh, meshOverlay.status);
  const frameVectorValues = useMemo(
    () => (worldVectorValues && frame ? projectPlanarVectors(worldVectorValues, frame) : null),
    [frame, worldVectorValues],
  );
  const maskValues = useMemo(
    () => (mask.data ? new Uint8Array(mask.data) : null),
    [mask.data],
  );
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
  // Only the decoded sample is retained; presentation (pan, zoom, styles)
  // always comes from the current state, so a refresh never snaps it back.
  const freshSample = useMemo(() => {
    if (!meta.data || !baseReady || !scalarValues || !frame || !layersSettled) return null;
    return {
      frame,
      mask: maskValues,
      meshOverlay: meshOverlay.data,
      meta: meta.data,
      sampleIdentity: planarRenderIdentity(baseIdentity, componentPresentationKey),
      scalar: scalarValues,
      vectors: frameVectorValues,
      worldVectors: worldVectorValues,
    };
  }, [baseIdentity, baseReady, componentPresentationKey, frame, frameVectorValues, layersSettled, maskValues, meshOverlay.data, meta.data, scalarValues, worldVectorValues]);
  const sample = useRetainedPlanarFrame(
    sessionIdentity === null ? null : planarViewIdentityKey,
    freshSample,
    // A monitor edit changes the sampled definition; the default slice position
    // is deliberately excluded above so a layer step keeps the last frame.
    canonicalSourceKind === "monitor" && meta.data?.source
      ? JSON.stringify(meta.data.source)
      : null,
  );
  // The renderer decodes the mesh overlay when this descriptor changes, so keep
  // its identity across presentation-only updates (pan, zoom, styles).
  const sampleMeshDescriptor = sample?.meta.mesh_overlay_descriptor;
  const meshOverlayDescriptor = useMemo(() => sampleMeshDescriptor
    ? {
        available: sampleMeshDescriptor.available,
        boundaryClassification: sampleMeshDescriptor.boundary_classification,
        codec: sampleMeshDescriptor.codec,
        geometrySource: sampleMeshDescriptor.geometry_source,
      }
    : undefined, [sampleMeshDescriptor]);
  const renderModel = useMemo(() => {
    if (!sample || !presentationPlanar) return null;
    return buildFieldMapRenderModel({
      bounds: sample.meta.frame.bounds_uv_m as [number, number, number, number],
      canonicalUnit: sample.meta.canonical_unit,
      colormap: presentationPlanar.colormap,
      component: presentationPlanar.component,
      displayUnit: presentationPlanar.display_unit,
      frame: sample.frame,
      interaction: {
        panU: presentationPlanar.interaction.pan_u_m,
        panV: presentationPlanar.interaction.pan_v_m,
        zoom: presentationPlanar.interaction.zoom,
      },
      layers: {
        boundaries: presentationPlanar.layers.boundaries,
        bounds: presentationPlanar.layers.bounds,
        // A meta-only base draws frame overlays only; its field passes stay off.
        contours: !metaOnlyBase && presentationPlanar.layers.contours,
        mesh: planarMeshDrawn(presentationPlanar),
        points: !metaOnlyBase && presentationPlanar.layers.points,
        probes: presentationPlanar.layers.probes,
        raster: !metaOnlyBase && presentationPlanar.layers.raster,
        streamlines: !metaOnlyBase && (presentationPlanar.layers.streamlines ?? false),
        vectors: !metaOnlyBase && presentationPlanar.layers.vectors,
      },
      mask: sample.mask,
      meshOverlayDescriptor,
      meshOverlay: sample.meshOverlay,
      range: normalizePlanarColorRange(presentationPlanar.range),
      rasterOpacity: presentationPlanar.raster_opacity ?? 1,
      visible: presentationPlanar.visible,
      wireframeStyle: effectiveWireframeStyle,
      pointStyle: presentationPlanar.point_style,
      resolution: sample.meta.resolution as [number, number],
      sampleIdentity: sample.sampleIdentity,
      scalar: sample.scalar,
      vectorBudget: canonicalPlanar?.resolution.vector_budget ?? 0,
      vectorScale: presentationPlanar.vector_style.scale,
      vectorStyle: {
        color: presentationPlanar.vector_style.monochrome_color,
        colorMode: presentationPlanar.vector_style.color_mode,
        lengthMode: presentationPlanar.vector_style.length_mode,
        opacity: presentationPlanar.vector_style.opacity,
        thickness: presentationPlanar.vector_style.thickness,
      },
      vectors: sample.vectors,
      worldVectors: sample.worldVectors,
    });
  }, [canonicalPlanar?.resolution.vector_budget, effectiveWireframeStyle, meshOverlayDescriptor, metaOnlyBase, presentationPlanar, sample]);
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
  // Keep the last profile of the same segment while a live refresh resamples it.
  const retainedProfile = useRetainedPlanarFrame(
    activeProfileSegment ? `${planarViewIdentityKey}|${JSON.stringify(activeProfileSegment)}` : null,
    profile.data ?? null,
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


  const evidenceStatus: PlanarEvidenceStatus = metaOnlyBase
    // A meta-only base has no raster: its frame is ready once it rendered.
    ? meta.status === "error"
      ? "error"
      : meta.status === "ready" && baseIdentity &&
          activeRenderEvidence?.sampleIdentity === planarRenderIdentity(baseIdentity, componentPresentationKey)
        ? "ready"
        : "loading"
    : resolvePlanarEvidenceStatus({
        metaIdentity: meta.data?.etag,
        metaStatus: meta.status,
        presentationKey: componentPresentationKey,
        renderEvidence: activeRenderEvidence,
        scalarIdentity: scalar.data?.etag,
        scalarStatus: scalar.status,
      });
  const metaSection = meta.status === "ready" ? meta.data?.section ?? null : null;
  const sectionGeometry = useMemo(
    () => canonicalPlanar?.source.kind === "default"
      ? resolvePlanarSectionGeometryFromMeta(
          metaSection,
          canonicalPlanar.default_slice.plane,
        )
      : null,
    [canonicalPlanar, metaSection],
  );
  // Publish derived facts for keyboard commands and the Inspector (one owner).
  useEffect(() => {
    if (!active) return;
    fieldMapStore.set({ evidenceStatus, objectLayers, planar: presentationPlanar ?? null, sectionGeometry });
  }, [active, evidenceStatus, objectLayers, presentationPlanar, sectionGeometry]);
  // Closing or switching away from the 2D view returns the tool to navigate.
  useEffect(() => () => {
    fieldMapStore.reset();
    planarToolStore.reset();
  }, []);
  const onSectionStep = useCallback((direction: -1 | 1) => {
    if (!sectionDefaultSlice) return;
    const fraction = stepSectionFraction(sectionDefaultSlice.position_fraction, sectionGeometry, direction);
    if (fraction !== sectionDefaultSlice.position_fraction) {
      onSectionChange({ ...sectionDefaultSlice, position_fraction: fraction });
    }
  }, [onSectionChange, sectionDefaultSlice, sectionGeometry]);
  // Cursor, node and crop readouts in the plane's world axes and the frame's length unit.
  const readoutFormat = useMemo(() => {
    if (!renderModel?.frame) return undefined;
    const axisFrame = {
      normal: renderModel.frame.normal,
      origin: renderModel.frame.origin,
      uAxis: renderModel.frame.uAxis,
      vAxis: renderModel.frame.vAxis,
    };
    const lengthUnit = resolvePlanarAxes(axisFrame, renderModel.bounds, renderModel.viewport, 1, 1).displayLengthUnit;
    const length = (metres: number) => formatValueWithUnit(metres * lengthUnit.scale, lengthUnit.symbol);
    return {
      crop: (rect: PlanarUvRect) => {
        const low = resolvePlanarProbeCoordinates(axisFrame, rect.u_min_m, rect.v_min_m);
        const high = resolvePlanarProbeCoordinates(axisFrame, rect.u_max_m, rect.v_max_m);
        return (["horizontal", "vertical"] as const)
          .map((axis) => {
            const values = [low[axis].valueMetres, high[axis].valueMetres].sort((a, b) => a - b);
            return `${low[axis].label} ${length(values[0]!)}…${length(values[1]!)}`;
          })
          .join(" · ");
      },
      cursor: (cursor: PlanarCursorUv) => {
        const coordinates = resolvePlanarProbeCoordinates(axisFrame, cursor.u_m, cursor.v_m);
        return [coordinates.horizontal, coordinates.vertical]
          .map((axis) => `${axis.label} ${length(axis.valueMetres)}`)
          .join(" · ");
      },
      length,
    };
  }, [renderModel]);
  const targetLabels = useMemo(
    () => Object.fromEntries((visualization.data?.targets?.objects ?? []).map((target) => [`object:${target.scope_id}`, target.label])) as Record<string, string>,
    [visualization.data?.targets?.objects],
  );
  const compositionActive = !multislice && Boolean(presentationPlanar?.field_overlays?.length) && sample !== null;
  // The inspect tool probes the layers on screen, top of the list first; a
  // legacy base field is drawn under the field layers, so it comes last.
  const probeLayers = useMemo((): PlanarFieldLayerRuntime[] => {
    if (multislice || !renderModel) return [];
    const layers: PlanarFieldLayerRuntime[] = [];
    if (compositionActive && compositionFrame) {
      // The frame holds overlays bottom-first; the readout follows list order.
      const { overlays } = compositionFrame;
      for (let index = overlays.length - 1; index >= 0; index -= 1) {
        const { id, meta: layerMeta, model: layerModel } = overlays[index]!;
        const quantityId = layerMeta.quantity_id;
        const parsed = planarFieldQueryFromMeta(quantityId, plan.source, layerMeta);
        if (!parsed.ok) continue;
        const ownBounds = layerMeta.frame.bounds_uv_m;
        const placedBounds = layerModel.bounds;
        const scopeLabel = targetLabels[id] ?? (layerMeta.scope_kind === "airbox" ? "Airbox" : layerMeta.scope_id ?? id);
        layers.push({
          bounds: placedBounds,
          id,
          label: `${scopeLabel} · ${quantityDisplayName(quantityId)}`,
          mask: layerModel.mask,
          meta: layerMeta,
          quantityId,
          query: parsed.query,
          resolution: layerModel.resolution,
          scale: layerModel.display.probeScale,
          shift: [placedBounds[0] - (ownBounds[0] ?? 0), placedBounds[2] - (ownBounds[2] ?? 0)],
          source: plan.source,
          unit: layerModel.display.legendUnit,
        });
      }
    }
    if (!metaOnlyBase && sample) {
      const parsed = planarFieldQueryFromMeta(plan.quantityId, plan.source, sample.meta);
      if (parsed.ok) {
        layers.push({
          bounds: renderModel.bounds,
          id: "base",
          label: quantityDisplayName(plan.quantityId),
          mask: sample.mask,
          meta: sample.meta,
          quantityId: plan.quantityId,
          query: parsed.query,
          resolution: renderModel.resolution,
          scale: renderModel.display.probeScale,
          shift: [0, 0],
          source: plan.source,
          unit: renderModel.display.legendUnit,
        });
      }
    }
    return layers;
  }, [compositionActive, compositionFrame, metaOnlyBase, multislice, plan.quantityId, plan.source, renderModel, sample, targetLabels]);
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
  const sampleError =
    meta.error ??
    scalar.error ??
    (clientDerived ? vectors.error : null) ??
    canonicalSampleError ??
    null;
  const sampleErrorSuperseded =
    (meta.status === "error" || scalar.status === "error") && isSupersededPlanarError(sampleError);
  // A 409 for a replaced revision or sample token arrives before the realtime
  // batch: resample from fresh metadata instead of reporting an error.
  const refetchMeta = meta.refetch;
  useEffect(() => {
    if (sampleErrorSuperseded) refetchMeta();
  }, [refetchMeta, sampleErrorSuperseded]);
  const sampleSettled =
    scalar.status === "ready" || scalar.status === "error" || !plan.requestScalar;

  return {
    active,
    sessionScopeKey: sessionRequestScopeKey(sessionIdentity),
    sampleMeta: sample?.meta ?? null,
    canonicalPlanar,
    sampleError,
    sampleErrorSuperseded,
    sampleSettled,
    canonicalSampleError,
    evidence,
    evidenceStatus,
    mask,
    meshOverlay,
    meta,
    onInteraction,
    onRenderEvidence,
    onSectionChange,
    activeProfileSegment,
    onProfileSegment,
    plan,
    presentationPlanar,
    profile,
    profileLengthUnit,
    retainedProfile,
    renderModel,
    scalar,
    metaSection,
    objectLayers,
    onSectionStep,
    readoutFormat,
    sectionDefaultSlice,
    activePinned,
    setPinned,
    shownCoordinateM,
    vectors,
    visualization,
    multislice,
    multisliceClientComponent: clientComponents ? displayComponent : null,
    crop,
    onCropCommit,
    onClearCrop,
    metaOnlyBase,
    targetLabels,
    probeLayers,
    setCompositionFrame,
  };
}

export default function FieldMapModule() {
  const captureRootRef = useRef<HTMLElement | null>(null);
  const {
    active,
    sessionScopeKey,
    sampleMeta,
    canonicalPlanar,
    evidence,
    mask,
    meshOverlay,
    meta,
    onInteraction,
    onRenderEvidence,
    onSectionChange,
    activeProfileSegment,
    onProfileSegment,
    plan,
    presentationPlanar,
    profile,
    profileLengthUnit,
    retainedProfile,
    renderModel,
    sampleError,
    sampleErrorSuperseded,
    sampleSettled,
    scalar,
    metaSection,
    objectLayers,
    onSectionStep,
    readoutFormat,
    sectionDefaultSlice,
    activePinned,
    setPinned,
    shownCoordinateM,
    vectors,
    visualization,
    multislice,
    multisliceClientComponent,
    crop,
    onCropCommit,
    onClearCrop,
    metaOnlyBase,
    targetLabels,
    probeLayers,
    setCompositionFrame,
  } = useFieldMapModuleController();
  useEffect(() => {
    if (!active || !sessionScopeKey) return;
    return registerFieldMapCapture(sessionScopeKey, async () => {
      const root = captureRootRef.current;
      if (!root) throw new Error("Field Map PNG export failed: the active 2D view is not mounted.");
      return captureVisibleFieldMapPng(root);
    });
  }, [active, sessionScopeKey]);
  const toolbar = PLANAR_TOOLBAR;
  const statusBar = presentationPlanar ? (
    <PlanarStatusBar
      crop={crop}
      formatCrop={readoutFormat?.crop}
      formatCursor={readoutFormat?.cursor}
      objectLayers={objectLayers}
      operator={sectionDefaultSlice?.operator}
      planeLabel={sectionDefaultSlice
        ? sectionDefaultSlice.plane.toUpperCase() as "XY" | "XZ" | "YZ"
        : null}
      positionFraction={sectionDefaultSlice?.position_fraction ?? 0}
      section={metaSection}
      shownCoordinateM={shownCoordinateM}
      zoom={presentationPlanar.interaction?.zoom ?? 1}
      onClearCrop={onClearCrop}
      onPositionCommit={(fraction) => {
        if (sectionDefaultSlice) onSectionChange({ ...sectionDefaultSlice, position_fraction: fraction });
      }}
      onStep={onSectionStep}
    />
  ) : null;
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
  if (sampleError !== null && !sampleErrorSuperseded) {
    const copy = describePlanarError(sampleError);
    return (
      <FieldMapStatus
        kind={copy.kind === "failed" || copy.kind === "unsupported" ? "error" : "status"}
        message={copy.message}
        planarStatus="error"
        statusBar={statusBar}
        technical={copy.technical}
        toolbar={toolbar}
      />
    );
  }
  if (meta.status === "ready" && sampleSettled && (!meta.data || (!metaOnlyBase && !scalar.data)) && !renderModel) {
    return (
      <FieldMapStatus
        message="No planar field is published for this revision."
        statusBar={statusBar}
        toolbar={toolbar}
      />
    );
  }
  if (!renderModel) {
    return (
      <FieldMapStatus
        message="Loading planar field…"
        planarStatus="loading"
        statusBar={statusBar}
        toolbar={toolbar}
      />
    );
  }
  const ambiguousSurfaceMeta = meta.data && surfaceProjectionStatus(meta.data) === "ambiguous"
    ? meta.data
    : null;
  // Hidden layers create no data requests (ADR 0080).
  const visibleFieldLayers = (presentationPlanar.field_overlays ?? []).filter(layerVisible);
  const multisliceFieldLayer = multisliceLayer(presentationPlanar.field_overlays ?? []);
  const nodeInspector = readoutFormat ? (
    <PlanarNodeInspector
      formatLength={readoutFormat.length}
      formatPosition={readoutFormat.cursor}
      layers={probeLayers}
      pinned={activePinned}
      viewport={renderModel.viewport}
      onClosePinned={() => setPinned(null)}
    />
  ) : null;
  const toolProps = {
    cropFullBounds: (sampleMeta?.frame.full_bounds_uv_m ?? sampleMeta?.frame.bounds_uv_m ?? renderModel.bounds) as
      readonly [number, number, number, number],
    onClosePinned: () => setPinned(null),
    onCropCommit,
    onPin: (u: number, v: number) => setPinned({ u_m: u, v_m: v }),
    pinnedOpen: activePinned !== null,
  };

  return (
    <section ref={captureRootRef} className={activeProfileSegment ? "fm-field-map fm-field-map--with-profile" : "fm-field-map"}>
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
      <header className="fm-field-map__toolbar">{toolbar}</header>
      <div className="fm-field-map__subbar">
        <PlanarSnapshotNavigator status={evidence.status} />
        {ambiguousSurfaceMeta ? (
          <span className="fm-field-map__diagnostic" role="status">
            Ambiguous surface: {ambiguousSurfaceMeta.overlap_count} overlaps,{" "}
            {ambiguousSurfaceMeta.fold_count} folds
          </span>
        ) : null}
      </div>
      <div className="fm-field-map__stage">
        {multislice ? (
          <PlanarMultisliceGrid
            // ADR 0080 W7: in the layer model the panels draw the first visible layer.
            {...(metaOnlyBase ? { fieldLayer: multisliceFieldLayer } : {})}
            baseQuery={plan.query}
            clientComponent={multisliceClientComponent}
            colorByDirection={renderModel.directionVectors !== null}
            colormap={renderModel.colormap ?? presentationPlanar.colormap}
            positionFractions={multislice.position_fractions}
            quantityId={plan.quantityId}
            range={normalizePlanarColorRange(presentationPlanar.range)}
            rasterOpacity={presentationPlanar.raster_opacity ?? 1}
            renderLegend={(range, panelUnit) => {
              if (presentationPlanar.viewport_colorbar_visible === false) return null;
              // Layers model: the panels draw a layer, so its unit comes from the panel meta.
              const legendLayer = metaOnlyBase ? multisliceFieldLayer : null;
              const legend = multisliceLegendUnit(legendLayer !== null, panelUnit, renderModel.display);
              return (
                <PlanarColorLegend
                  colormap={legendLayer?.colormap ?? renderModel.colormap ?? presentationPlanar.colormap}
                  component={legendLayer?.component ?? presentationPlanar.component}
                  legendUnit={legend.legendUnit}
                  probeScale={legend.probeScale}
                  quantityId={legendLayer?.quantity_id ?? plan.quantityId}
                  range={range}
                  rangeState={range ? "current" : "pending"}
                />
              );
            }}
            requestVectors={plan.requestVectors}
            source={plan.source}
          />
        ) : (
        (presentationPlanar.field_overlays?.length && sampleMeta ? (
        <PlanarCompositionSurface
          {...toolProps}
          model={renderModel}
          active={active}
          baseMeta={sampleMeta}
          baseQuery={plan.query}
          source={plan.source}
          profiles={visibleFieldLayers}
          targetLabels={targetLabels}
          vectorBudget={canonicalPlanar?.resolution.vector_budget ?? 2000}
          onCompositionFrame={setCompositionFrame}
          legendsVisible={presentationPlanar.viewport_colorbar_visible !== false}
          viewMasks={presentationPlanar.layers}
          renderBaseLegend={(shownModel, shownMeta) => presentationPlanar.viewport_colorbar_visible !== false && !metaOnlyBase ? (
            <PlanarColorLegend targetLabel={shownMeta.scope_kind === "airbox" ? "Airbox" : undefined} colormap={shownModel.colormap} component={shownModel.component}
              legendUnit={shownModel.display.legendUnit} probeScale={shownModel.display.probeScale}
              quantityId={shownMeta.quantity_id} range={shownModel.range}
              rangeState={shownModel.range ? "current" : "unavailable"} />
          ) : null}
          onInteraction={onInteraction}
          onProfileSegment={onProfileSegment}
          onRenderEvidence={onRenderEvidence}
          profileSegment={activeProfileSegment}
          probeOverlay={nodeInspector}
        />
        ) : (
        <PlanarSurface
          {...toolProps}
          model={renderModel}
          onInteraction={onInteraction}
          onProfileSegment={onProfileSegment}
          onRenderEvidence={onRenderEvidence}
          profileSegment={activeProfileSegment}
          probeOverlay={nodeInspector}
        />
        ))
        )}
        {presentationPlanar.viewport_colorbar_visible !== false && !multislice && !metaOnlyBase && !presentationPlanar.field_overlays?.length ? (
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
      {statusBar}
      {activeProfileSegment ? (
        <PlanarProfileChart
          display={{
            lengthScale: profileLengthUnit?.scale ?? 1,
            lengthUnit: profileLengthUnit?.symbol ?? "m",
            legendUnit: renderModel.display.legendUnit,
            probeScale: renderModel.display.probeScale,
          }}
          onClear={() => onProfileSegment(null)}
          profile={retainedProfile}
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
  statusBar = null,
  technical = null,
  toolbar = null,
}: {
  kind?: "error" | "status";
  message: string;
  planarStatus?: PlanarEvidenceStatus;
  statusBar?: ReactNode;
  technical?: string | null;
  toolbar?: ReactNode;
}) {
  const status = (
    <div
      className={`fm-field-map fm-field-map--${kind}`}
      data-planar-status={planarStatus}
      role={kind === "error" ? "alert" : "status"}
    >
      <div className="fm-field-map__status-card">
        {planarStatus === "loading" ? <span aria-hidden="true" className="fm-field-map__spinner" /> : null}
        <p className="fm-field-map__status-message">{message}</p>
        {technical && technical !== message ? (
          <details className="fm-field-map__status-details">
            <summary>Technical details</summary>
            <code>{technical}</code>
          </details>
        ) : null}
      </div>
    </div>
  );
  if (!toolbar) return status;
  return (
    <section className="fm-field-map">
      <header className="fm-field-map__toolbar">{toolbar}</header>
      {status}
      {statusBar}
    </section>
  );
}
