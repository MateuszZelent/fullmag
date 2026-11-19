import type {
  DecodedComplexFieldVector,
  DecodedFdmRegionMembership,
  DecodedFieldVector,
  DecodedTopology,
} from "@/kernel/api/codecs";
import { FMRM_INACTIVE_REGION_ID } from "@/kernel/api/codecs";
import type { AnalysisFieldOverlayState } from "@/kernel/visualization/AnalysisFieldOverlayController";
import type { ModeCompositionFieldLayerSnapshotMap } from "@/kernel/visualization/ModeCompositionFieldLayerController";
import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import {
  EXPORT_3D_INACTIVE_REGION_ID,
  type Export3DAnimationMode,
  type Export3DColorMode,
  type Export3DComplexFieldInput,
  type Export3DComplexRepresentation,
  type Export3DFdmGridTargetInput,
  type Export3DFemMeshTargetInput,
  type Export3DFieldInput,
  type Export3DNumericArray,
  type Export3DRealFieldInput,
  type Export3DRgbTuple,
  type Export3DScalarPalette,
  type Export3DSurfaceGeometryTargetInput,
  type Export3DTargetAppearance,
  type Export3DTargetInput,
  type Export3DVtkVolumeCells,
  buildFieldEntryResolver,
  normalizeExport3DColorMode,
  normalizeExport3DScalarPalette,
} from "@/shared/export-3d";

import { createPrimitiveObjectGeometry } from "../layers/PrimitiveObjectLayerModel";
import type {
  FdmGridRenderDomain,
  FdmMultilayerAirboxRenderView,
  FdmNativeLayerRenderView,
} from "../viewport3dDomainAdapter";
import type {
  Viewport3DMagnetizationTexturePreview,
  Viewport3DPrimitiveRenderModel,
} from "../viewport3dPrimitiveModel";
import {
  FULL_VIEWPORT_3D_TARGET_ID,
  type Viewport3DFieldRenderModel,
  type Viewport3DNodeSelection,
  type Viewport3DTopologyPartRenderModel,
  type Viewport3DTopologyRenderModel,
} from "../viewport3dRenderModel";
import {
  cellEnd,
  cellStart,
  cellType,
  topologyCellCsr,
} from "../viewport3dTopologyCells";

export interface Viewport3DExportFdmSettings {
  readonly activeQuantityId?: string | null;
  readonly opacity?: number | null;
  readonly scalarColorPalette?: string | null;
  readonly shaderColorMode?: string | null;
  readonly shaderMonoColor?: string | null;
  readonly shaderVisible?: boolean;
  readonly surfaceColorSource?: string | null;
  readonly surfaceOpacityPercent?: number | null;
  readonly vectorColorMode?: string | null;
  readonly vectorsVisible?: boolean;
  readonly visible?: boolean;
  readonly wireframeVisible?: boolean;
}

export interface Viewport3DExportAirboxSettings {
  readonly activeQuantityId?: string | null;
  readonly opacity?: number | null;
  readonly scalarColorPalette?: string | null;
  readonly shaderMonoColor?: string | null;
  readonly shaderVisible?: boolean;
  readonly surfaceColorSource?: string | null;
  readonly surfaceOpacityPercent?: number | null;
  readonly vectorColorMode?: string | null;
  readonly vectorsVisible?: boolean;
  readonly visible?: boolean;
  readonly wireframeVisible?: boolean;
}

export interface Viewport3DExportSourceInput {
  readonly airboxSettings?: Viewport3DExportAirboxSettings | null;
  readonly analysisComplexField?: DecodedComplexFieldVector | null;
  readonly analysisOverlay?: AnalysisFieldOverlayState | null;
  readonly domainId?: string | null;
  readonly domainSummary?: string | null;
  readonly fdmAirboxFieldVector?: DecodedFieldVector | null;
  readonly fdmDomain?: FdmGridRenderDomain | null;
  readonly fdmLaneActive?: boolean;
  readonly fdmMultilayerAirboxView?: FdmMultilayerAirboxRenderView | null;
  readonly fdmNativeLayerViews?: readonly FdmNativeLayerRenderView[] | null;
  readonly fdmRegionMembershipBinary?: DecodedFdmRegionMembership | null;
  readonly fdmSettings?: Viewport3DExportFdmSettings | null;
  readonly fieldModel?: Viewport3DFieldRenderModel | null;
  readonly fieldVector?: DecodedFieldVector | null;
  readonly getObjectSettings?: (objectId: string) => VisualizationTargetSettings;
  readonly getPartSettings?: (partId: string) => VisualizationTargetSettings;
  readonly magnetizationTexturePreviews?: ReadonlyMap<
    string,
    Viewport3DMagnetizationTexturePreview
  > | null;
  readonly modeCompositionFieldLayers?: ModeCompositionFieldLayerSnapshotMap | null;
  readonly modeCompositionId?: string | null;
  readonly modeCompositionPhaseByLayerId?: ReadonlyMap<string, number> | null;
  readonly primitiveModel?: Viewport3DPrimitiveRenderModel | null;
  readonly quantityId?: string | null;
  readonly quantityLabel?: string | null;
  readonly scalarColorPalette?: string | null;
  readonly sessionDiscretization?: "fdm" | "fem" | null;
  readonly topology?: DecodedTopology | null;
  readonly topologyModel?: Viewport3DTopologyRenderModel | null;
  readonly vectorColorMode?: string | null;
  readonly visualizationDebugSource?: {
    readonly fullFieldVector?: DecodedFieldVector | null;
  } | null;
}

export interface Viewport3DExportSource {
  readonly defaultAnimationMode: Export3DAnimationMode;
  readonly defaultColorMode: Export3DColorMode;
  readonly defaultPalette: Export3DScalarPalette;
  readonly provenance: Record<string, unknown>;
  readonly quantityId: string | null;
  readonly sourceLabel: string;
  readonly suggestedFilenameStem: string;
  readonly targets: Export3DTargetInput[];
  readonly warnings: readonly string[];
}

type TypedOrNumericVector = Float32Array | Float64Array;

export function sanitizeSlug(raw: string | null | undefined, fallback: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fallback;
  const cleaned = trimmed
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return cleaned || fallback;
}

function isAirboxOrFarAirLabel(
  role: string | null | undefined,
  label: string | null | undefined,
  id?: string | null,
): boolean {
  const haystack = `${role ?? ""} ${label ?? ""} ${id ?? ""}`.toLowerCase();
  return (
    haystack.includes("airbox") ||
    haystack.includes("air_box") ||
    haystack.includes("far_air") ||
    haystack.includes("far-air") ||
    haystack.includes("far_field") ||
    haystack.includes("farfield") ||
    haystack.includes("exterior_air")
  );
}

function parseHexRgbColor(hex: string | null | undefined): Export3DRgbTuple | null {
  if (!hex) return null;
  const trimmed = hex.trim();
  const body = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!/^[0-9a-fA-F]{6}$/.test(body)) return null;
  const r = Number.parseInt(body.slice(0, 2), 16) / 255;
  const g = Number.parseInt(body.slice(2, 4), 16) / 255;
  const b = Number.parseInt(body.slice(4, 6), 16) / 255;
  return [r, g, b];
}

export function resolvePaletteFromSettings(
  rawPalette: string | null | undefined,
  fallbackPalette: Export3DScalarPalette,
): Export3DScalarPalette {
  if (!rawPalette) return fallbackPalette;
  const lower = rawPalette.trim().toLowerCase();
  if (lower === "hsv" || lower === "phase" || lower === "twilight") {
    return "twilight";
  }
  return normalizeExport3DScalarPalette(lower);
}

function resolveColorModeFromSettings(
  surfaceColorSource: string | null | undefined,
  vectorColorMode: string | null | undefined,
  field: Export3DFieldInput | null | undefined,
): Export3DColorMode {
  const sourceLower = surfaceColorSource?.trim().toLowerCase() ?? "";
  if (sourceLower === "monochrome") return "monochrome";
  if (sourceLower === "hsl" || sourceLower === "rgb") return "orientation";
  if (sourceLower === "x" || sourceLower === "y" || sourceLower === "z") {
    return sourceLower;
  }
  if (vectorColorMode) {
    return normalizeExport3DColorMode(vectorColorMode);
  }
  if (!field) return "monochrome";
  if (field.componentCount === 1) return "scalar";
  if (field.kind === "complex") return "magnitude";
  return "orientation";
}

function resolveComplexRepresentation(
  raw: string | null | undefined,
): Export3DComplexRepresentation {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "real":
      return "real";
    case "imag":
      return "imag";
    case "abs":
    case "magnitude":
      return "abs";
    case "phase":
      return "phase";
    default:
      return "phase_rotated_real";
  }
}

export function convertRealFieldToExportInput(
  decoded: DecodedFieldVector,
  overrideNodeIndices?: Uint32Array | readonly number[] | null,
): Export3DRealFieldInput {
  const componentCount: 1 | 3 = decoded.nComp === 1 ? 1 : 3;
  const nodeIndices = overrideNodeIndices ?? decoded.nodeIndices ?? null;
  return {
    kind: "real",
    quantityId: decoded.quantityId || "m",
    componentCount,
    values: decoded.values,
    ...(nodeIndices ? { nodeIndices } : {}),
  };
}

export function convertComplexFieldToExportInput(
  decoded: DecodedComplexFieldVector,
  options: {
    readonly amplitudeScale?: number;
    readonly cellOriginM?: readonly [number, number, number] | null;
    readonly complexPhaseRad?: number;
    readonly complexRepresentation?: Export3DComplexRepresentation;
    readonly floquetSpatialConvention?: Export3DComplexFieldInput["floquetSpatialConvention"];
    readonly nodeIndices?: Uint32Array | readonly number[] | null;
    readonly phasorConvention?: Export3DComplexFieldInput["phasorConvention"];
    readonly wavevectorKf?: readonly [number, number, number] | null;
  } = {},
): Export3DComplexFieldInput | null {
  const componentCount: 1 | 3 = decoded.componentCount === 1 ? 1 : 3;
  const maxPairsByValues = Math.floor(decoded.values.length / 2);
  const expectedPairs = decoded.pointCount * componentCount;
  const pairCount =
    expectedPairs > 0
      ? Math.min(expectedPairs, maxPairsByValues)
      : maxPairsByValues;
  if (pairCount <= 0) return null;

  const realValues = new Float64Array(pairCount);
  const imagValues = new Float64Array(pairCount);
  const raw = decoded.values;
  for (let i = 0; i < pairCount; i += 1) {
    realValues[i] = raw[i * 2] ?? 0;
    imagValues[i] = raw[i * 2 + 1] ?? 0;
  }

  const nodeIndices = options.nodeIndices ?? decoded.nodeIndices ?? null;
  return {
    kind: "complex",
    quantityId: decoded.quantityId || "mode",
    componentCount,
    realValues,
    imagValues,
    ...(nodeIndices ? { nodeIndices } : {}),
    ...(options.phasorConvention
      ? { phasorConvention: options.phasorConvention }
      : {}),
    ...(options.floquetSpatialConvention
      ? { floquetSpatialConvention: options.floquetSpatialConvention }
      : {}),
    ...(options.wavevectorKf ? { wavevectorKf: options.wavevectorKf } : {}),
    ...(options.cellOriginM ? { cellOriginM: options.cellOriginM } : {}),
    ...(options.amplitudeScale !== undefined
      ? { amplitudeScale: options.amplitudeScale }
      : {}),
    ...(options.complexRepresentation
      ? { complexRepresentation: options.complexRepresentation }
      : {}),
    ...(options.complexPhaseRad !== undefined &&
    Number.isFinite(options.complexPhaseRad)
      ? { complexPhaseRad: options.complexPhaseRad }
      : {}),
  };
}

function overlayComplexOptions(
  analysisOverlay: AnalysisFieldOverlayState | null | undefined,
): {
  readonly amplitudeScale?: number;
  readonly cellOriginM?: readonly [number, number, number] | null;
  readonly complexPhaseRad?: number;
  readonly complexRepresentation?: Export3DComplexRepresentation;
  readonly floquetSpatialConvention?: Export3DComplexFieldInput["floquetSpatialConvention"];
  readonly phasorConvention?: Export3DComplexFieldInput["phasorConvention"];
  readonly wavevectorKf?: readonly [number, number, number] | null;
} {
  if (!analysisOverlay) return {};
  const ext = analysisOverlay as AnalysisFieldOverlayState & {
    readonly floquetSpatialConvention?: Export3DComplexFieldInput["floquetSpatialConvention"];
    readonly phasorConvention?: Export3DComplexFieldInput["phasorConvention"];
  };
  const queryExt = analysisOverlay.query as
    | (AnalysisFieldOverlayState["query"] & {
        readonly projection?: string | null;
        readonly representation?: string | null;
      })
    | null
    | undefined;
  return {
    ...(ext.phasorConvention ? { phasorConvention: ext.phasorConvention } : {}),
    ...(ext.floquetSpatialConvention
      ? { floquetSpatialConvention: ext.floquetSpatialConvention }
      : {}),
    ...(analysisOverlay.wavevectorKf
      ? { wavevectorKf: analysisOverlay.wavevectorKf }
      : {}),
    ...(analysisOverlay.cellOrigin
      ? { cellOriginM: analysisOverlay.cellOrigin }
      : {}),
    ...(typeof analysisOverlay.appearance?.displayGain === "number" &&
    Number.isFinite(analysisOverlay.appearance.displayGain)
      ? { amplitudeScale: analysisOverlay.appearance.displayGain }
      : {}),
    ...(typeof analysisOverlay.visualizationPhaseRad === "number" &&
    Number.isFinite(analysisOverlay.visualizationPhaseRad)
      ? { complexPhaseRad: analysisOverlay.visualizationPhaseRad }
      : {}),
    complexRepresentation: resolveComplexRepresentation(
      queryExt?.representation ?? queryExt?.projection ?? queryExt?.component,
    ),
  };
}

function findModeCompositionFieldForTarget(
  input: Viewport3DExportSourceInput,
  candidateTargetIds: readonly (string | null | undefined)[],
  objectId: string | null | undefined,
  allowSoleFallback: boolean,
): Export3DComplexFieldInput | null {
  const layers = input.modeCompositionFieldLayers;
  if (!layers || layers.size === 0) return null;

  const normalizedObjectKey = objectId
    ? objectId.startsWith("object:")
      ? objectId
      : `object:${objectId}`
    : null;

  let matchedSnapshot = null;
  for (const key of candidateTargetIds) {
    if (!key) continue;
    const hit = layers.get(key);
    if (hit?.field) {
      matchedSnapshot = hit;
      break;
    }
  }
  if (!matchedSnapshot && normalizedObjectKey) {
    matchedSnapshot = layers.get(normalizedObjectKey) ?? null;
  }
  if (!matchedSnapshot) {
    for (const snap of layers.values()) {
      if (!snap.field || !snap.layer) continue;
      if (
        (snap.layer.target_id &&
          candidateTargetIds.includes(snap.layer.target_id)) ||
        (objectId && snap.layer.object_id === objectId)
      ) {
        matchedSnapshot = snap;
        break;
      }
    }
  }
  if (!matchedSnapshot && allowSoleFallback) {
    const readyLayers = [...layers.values()].filter((s) => Boolean(s.field));
    if (readyLayers.length === 1) {
      matchedSnapshot = readyLayers[0] ?? null;
    }
  }
  if (!matchedSnapshot?.field) return null;

  const layer = matchedSnapshot.layer;
  const phaseRad =
    (layer?.layer_id
      ? input.modeCompositionPhaseByLayerId?.get(layer.layer_id)
      : undefined) ?? layer?.phase_rad;
  return convertComplexFieldToExportInput(matchedSnapshot.field, {
    amplitudeScale: layer?.amplitude_scale,
    complexPhaseRad: phaseRad,
    complexRepresentation: resolveComplexRepresentation(layer?.representation),
    ...overlayComplexOptions(input.analysisOverlay),
  });
}

function resolveSettingsOpacity(
  settings: {
    readonly opacity?: number | null;
    readonly surfaceOpacityPercent?: number | null;
  } | null | undefined,
): number | undefined {
  if (typeof settings?.opacity === "number" && Number.isFinite(settings.opacity)) {
    return settings.opacity;
  }
  if (
    typeof settings?.surfaceOpacityPercent === "number" &&
    Number.isFinite(settings.surfaceOpacityPercent)
  ) {
    return Math.max(0, Math.min(1, settings.surfaceOpacityPercent / 100));
  }
  return undefined;
}

function resolveTargetAppearance(
  settings: {
    readonly monoColor?: string | null;
    readonly opacity?: number | null;
    readonly scalarColorPalette?: string | null;
    readonly shaderMonoColor?: string | null;
    readonly shaderVisible?: boolean;
    readonly surfaceColorSource?: string | null;
    readonly surfaceOpacityPercent?: number | null;
    readonly vectorColorMode?: string | null;
    readonly vectorsVisible?: boolean;
    readonly visible?: boolean;
    readonly wireframeVisible?: boolean;
  } | null | undefined,
  field: Export3DFieldInput | null | undefined,
  fallbackPalette: Export3DScalarPalette,
  fallbackColorMode?: Export3DColorMode,
): Export3DTargetAppearance {
  const palette = resolvePaletteFromSettings(
    settings?.scalarColorPalette,
    fallbackPalette,
  );
  const colorMode =
    settings?.surfaceColorSource || settings?.vectorColorMode
      ? resolveColorModeFromSettings(
          settings?.surfaceColorSource,
          settings?.vectorColorMode,
          field,
        )
      : fallbackColorMode ?? (field ? resolveColorModeFromSettings(null, null, field) : "monochrome");
  const mono = parseHexRgbColor(
    settings?.shaderMonoColor ?? settings?.monoColor,
  );
  const opacity = resolveSettingsOpacity(settings);
  return {
    colorMode,
    colorPalette: palette,
    ...(mono ? { monochromeColor: mono } : {}),
    ...(opacity !== undefined ? { opacity } : {}),
    includeSurface: settings?.shaderVisible ?? true,
    includeWireframe: settings?.wireframeVisible ?? false,
    includeVectors: settings?.vectorsVisible ?? Boolean(field && field.componentCount === 3),
  };
}

function buildNativeLayerActiveMask(
  layerView: FdmNativeLayerRenderView,
  totalCells: number,
): Uint8Array | null {
  if (!layerView.domain.activeMaskPresent || totalCells <= 0) {
    return null;
  }
  const expectedActive = layerView.domain.activeCellCount;
  if (expectedActive >= totalCells) {
    return null;
  }

  let activeIndices: Uint32Array | readonly number[] | null = null;
  if (
    layerView.model?.cellIndices &&
    layerView.model.cellIndices.length === expectedActive
  ) {
    activeIndices = layerView.model.cellIndices;
  } else if (
    layerView.fieldVector?.nodeIndices &&
    layerView.fieldVector.nodeIndices.length === expectedActive
  ) {
    activeIndices = layerView.fieldVector.nodeIndices;
  }
  if (!activeIndices) return null;

  const mask = new Uint8Array(totalCells);
  for (let i = 0; i < activeIndices.length; i += 1) {
    const idx = activeIndices[i] ?? -1;
    if (idx >= 0 && idx < totalCells) {
      mask[idx] = 1;
    }
  }
  return mask;
}

function buildActiveMaskFromRegionIds(
  regionIds: Uint32Array,
): { readonly activeMask: Uint8Array | null; readonly hasInactive: boolean } {
  let hasInactive = false;
  for (let i = 0; i < regionIds.length; i += 1) {
    const rid = regionIds[i] ?? 0;
    if (rid === FMRM_INACTIVE_REGION_ID || rid === EXPORT_3D_INACTIVE_REGION_ID) {
      hasInactive = true;
      break;
    }
  }
  if (!hasInactive) {
    return { activeMask: null, hasInactive: false };
  }
  const activeMask = new Uint8Array(regionIds.length);
  for (let i = 0; i < regionIds.length; i += 1) {
    const rid = regionIds[i] ?? 0;
    activeMask[i] =
      rid === FMRM_INACTIVE_REGION_ID || rid === EXPORT_3D_INACTIVE_REGION_ID
        ? 0
        : 1;
  }
  return { activeMask, hasInactive: true };
}

function extractFdmTargets(
  input: Viewport3DExportSourceInput,
  defaultPalette: Export3DScalarPalette,
  warnings: string[],
): Export3DFdmGridTargetInput[] {
  const targets: Export3DFdmGridTargetInput[] = [];
  const overlayOpts = overlayComplexOptions(input.analysisOverlay);
  const nativeViews = input.fdmNativeLayerViews ?? [];

  if (nativeViews.length > 0) {
    for (const layerView of nativeViews) {
      if (layerView.settings?.visible === false) continue;
      const { domain } = layerView;
      const [nx, ny, nz] = domain.shape;
      const totalCells = nx * ny * nz;
      if (totalCells <= 0) continue;

      const activeMask = buildNativeLayerActiveMask(layerView, totalCells);
      const modeField = findModeCompositionFieldForTarget(
        input,
        [layerView.target.id, domain.layerId, FULL_VIEWPORT_3D_TARGET_ID],
        domain.objectId,
        nativeViews.length === 1,
      );

      let complexOverlayField: Export3DComplexFieldInput | null = null;
      if (!modeField && input.analysisComplexField) {
        const cf = input.analysisComplexField;
        const matchesLayer =
          (cf.scopeId && (cf.scopeId === domain.layerId || cf.scopeId === layerView.target.id)) ||
          (nativeViews.length === 1 &&
            (cf.pointCount === totalCells || cf.pointCount === domain.activeCellCount));
        if (matchesLayer) {
          complexOverlayField = convertComplexFieldToExportInput(cf, overlayOpts);
        }
      }

      const realField =
        !modeField && !complexOverlayField && layerView.fieldVector
          ? convertRealFieldToExportInput(layerView.fieldVector)
          : null;
      const field = modeField ?? complexOverlayField ?? realField;

      targets.push({
        kind: "fdm_grid",
        id: domain.layerId || layerView.target.id,
        name: domain.magnetName || layerView.target.label || domain.layerId,
        gridShape: domain.shape,
        cellSizeM: domain.spacing,
        originM: domain.origin,
        ...(activeMask ? { activeMask } : {}),
        field,
        appearance: resolveTargetAppearance(
          layerView.settings,
          field,
          defaultPalette,
        ),
      });
    }

    if (
      input.airboxSettings?.visible &&
      input.fdmMultilayerAirboxView &&
      input.fdmMultilayerAirboxView.settings?.visible !== false
    ) {
      const airView = input.fdmMultilayerAirboxView;
      const airField = airView.fieldVector
        ? convertRealFieldToExportInput(airView.fieldVector)
        : null;
      const airOpacity =
        resolveSettingsOpacity(input.airboxSettings) ??
        resolveSettingsOpacity(airView.settings) ??
        0.2;
      targets.push({
        kind: "fdm_grid",
        id: "airbox",
        name: "Airbox",
        gridShape: airView.domain.shape,
        cellSizeM: airView.domain.spacing,
        originM: airView.domain.origin,
        field: airField,
        appearance: {
          ...resolveTargetAppearance(
            airView.settings,
            airField,
            defaultPalette,
          ),
          opacity: airOpacity,
        },
      });
    }

    return targets;
  }

  if (input.fdmDomain && (input.fdmLaneActive ?? true)) {
    const domain = input.fdmDomain;
    const [nx, ny, nz] = domain.shape;
    const totalCells = nx * ny * nz;
    if (totalCells <= 0) return targets;

    const regionIds =
      input.fdmRegionMembershipBinary?.regionIds &&
      input.fdmRegionMembershipBinary.regionIds.length === totalCells
        ? input.fdmRegionMembershipBinary.regionIds
        : null;
    const { activeMask, hasInactive } = regionIds
      ? buildActiveMaskFromRegionIds(regionIds)
      : { activeMask: null, hasInactive: false };

    const modeField = findModeCompositionFieldForTarget(
      input,
      ["fdm-domain", FULL_VIEWPORT_3D_TARGET_ID],
      null,
      true,
    );
    const complexField =
      !modeField && input.analysisComplexField
        ? convertComplexFieldToExportInput(input.analysisComplexField, overlayOpts)
        : null;
    const candidateReal =
      input.fieldVector ?? input.visualizationDebugSource?.fullFieldVector ?? null;
    const realField =
      !modeField && !complexField && candidateReal
        ? convertRealFieldToExportInput(candidateReal)
        : null;
    const field = modeField ?? complexField ?? realField;

    if (!field && !domain.geometryOnly) {
      warnings.push(
        "FDM domain geometry exported without an accepted vector/scalar field carrier.",
      );
    }

    targets.push({
      kind: "fdm_grid",
      id: "fdm-domain",
      name: input.domainId || "FDM Domain",
      gridShape: domain.shape,
      cellSizeM: domain.spacing,
      originM: domain.origin,
      ...(activeMask ? { activeMask } : {}),
      ...(regionIds ? { regionIds } : {}),
      field,
      appearance: resolveTargetAppearance(
        input.fdmSettings,
        field,
        defaultPalette,
      ),
    });

    if (input.airboxSettings?.visible) {
      const airField = input.fdmAirboxFieldVector
        ? convertRealFieldToExportInput(input.fdmAirboxFieldVector)
        : null;
      const airOpacity = resolveSettingsOpacity(input.airboxSettings) ?? 0.2;
      if (hasInactive && activeMask) {
        const airActiveMask = new Uint8Array(totalCells);
        for (let i = 0; i < totalCells; i += 1) {
          airActiveMask[i] = activeMask[i] ? 0 : 1;
        }
        targets.push({
          kind: "fdm_grid",
          id: "fdm-airbox",
          name: "Airbox",
          gridShape: domain.shape,
          cellSizeM: domain.spacing,
          originM: domain.origin,
          activeMask: airActiveMask,
          field: airField,
          appearance: {
            colorMode: airField ? "magnitude" : "monochrome",
            colorPalette: defaultPalette,
            opacity: airOpacity,
            includeSurface: true,
            includeWireframe: false,
            includeVectors: Boolean(airField),
          },
        });
      } else if (airField) {
        targets.push({
          kind: "fdm_grid",
          id: "fdm-airbox",
          name: "Airbox",
          gridShape: domain.shape,
          cellSizeM: domain.spacing,
          originM: domain.origin,
          field: airField,
          appearance: {
            colorMode: "magnitude",
            colorPalette: defaultPalette,
            opacity: airOpacity,
            includeSurface: true,
            includeWireframe: false,
            includeVectors: true,
          },
        });
      }
    }
  }

  return targets;
}

function markNodeSelection(
  selection: Viewport3DNodeSelection | null | undefined,
  mask: Uint8Array,
  nodeCount: number,
): number {
  if (!selection) return 0;
  let marked = 0;
  const list = selection.nodeIndices ?? selection.node_indices;
  if (list && list.length > 0) {
    for (let i = 0; i < list.length; i += 1) {
      const n = list[i] ?? -1;
      if (n >= 0 && n < nodeCount) {
        if (!mask[n]) marked += 1;
        mask[n] = 1;
      }
    }
    return marked;
  }
  const start = selection.nodeStart ?? selection.node_start;
  const count = selection.nodeCount ?? selection.node_count;
  if (
    typeof start === "number" &&
    typeof count === "number" &&
    start >= 0 &&
    count > 0
  ) {
    const end = Math.min(nodeCount, start + count);
    for (let n = start; n < end; n += 1) {
      if (!mask[n]) marked += 1;
      mask[n] = 1;
    }
  }
  return marked;
}

function collectVolumeCellsForMask(
  topology: DecodedTopology,
  allowedNodes: Uint8Array,
  nodeCount: number,
  elementStart?: number,
  elementCount?: number,
): Export3DVtkVolumeCells | null {
  const csr = topologyCellCsr(topology);
  if (csr.count <= 0) return null;

  const collectRange = (cStart: number, cEnd: number): Export3DVtkVolumeCells | null => {
    const outTypes: number[] = [];
    const outNodes: number[] = [];
    const outOffsets: number[] = [0];
    for (let cell = cStart; cell < cEnd; cell += 1) {
      const start = cellStart(csr, cell);
      const end = cellEnd(csr, cell);
      if (end <= start) continue;
      let valid = true;
      for (let k = start; k < end; k += 1) {
        const node = csr.nodes[k] ?? -1;
        if (node < 0 || node >= nodeCount || !allowedNodes[node]) {
          valid = false;
          break;
        }
      }
      if (!valid) continue;
      outTypes.push(cellType(csr, cell));
      for (let k = start; k < end; k += 1) {
        outNodes.push(csr.nodes[k] ?? 0);
      }
      outOffsets.push(outNodes.length);
    }
    if (outTypes.length === 0) return null;
    return {
      cellCount: outTypes.length,
      cellNodes: Uint32Array.from(outNodes),
      cellOffsets: Uint32Array.from(outOffsets),
      cellTypes: Uint32Array.from(outTypes),
    };
  };

  if (
    typeof elementStart === "number" &&
    typeof elementCount === "number" &&
    elementStart >= 0 &&
    elementCount > 0 &&
    elementStart + elementCount <= csr.count
  ) {
    const ranged = collectRange(elementStart, elementStart + elementCount);
    if (ranged) return ranged;
  }

  return collectRange(0, csr.count);
}

function remapFieldToLocalNodes(
  field: Export3DFieldInput | null,
  localToGlobal: Uint32Array,
  globalNodeCount: number,
): Export3DFieldInput | null {
  if (!field) return null;
  const usedCount = localToGlobal.length;
  const nComp = field.componentCount;

  if (field.kind === "real") {
    const entryCount = Math.floor(field.values.length / nComp);
    const resolveIdx = buildFieldEntryResolver(
      field.nodeIndices,
      entryCount,
      globalNodeCount,
    );
    const out = new Float32Array(usedCount * nComp);
    for (let localIdx = 0; localIdx < usedCount; localIdx += 1) {
      const g = localToGlobal[localIdx] ?? 0;
      const srcIdx = resolveIdx(g);
      if (srcIdx === null) continue;
      for (let c = 0; c < nComp; c += 1) {
        out[localIdx * nComp + c] = field.values[srcIdx * nComp + c] ?? 0;
      }
    }
    return { ...field, values: out, nodeIndices: null };
  }

  if (field.kind === "complex") {
    const entryCount = Math.floor(
      Math.min(field.realValues.length, field.imagValues.length) / nComp,
    );
    const resolveIdx = buildFieldEntryResolver(
      field.nodeIndices,
      entryCount,
      globalNodeCount,
    );
    const realValues = new Float64Array(usedCount * nComp);
    const imagValues = new Float64Array(usedCount * nComp);
    for (let localIdx = 0; localIdx < usedCount; localIdx += 1) {
      const g = localToGlobal[localIdx] ?? 0;
      const srcIdx = resolveIdx(g);
      if (srcIdx === null) continue;
      for (let c = 0; c < nComp; c += 1) {
        realValues[localIdx * nComp + c] =
          field.realValues[srcIdx * nComp + c] ?? 0;
        imagValues[localIdx * nComp + c] =
          field.imagValues[srcIdx * nComp + c] ?? 0;
      }
    }
    return { ...field, realValues, imagValues, nodeIndices: null };
  }

  return field;
}

export function buildFemTargetFromSelection(options: {
  readonly id: string;
  readonly name: string;
  readonly positionsM: TypedOrNumericVector;
  readonly nodeCount: number;
  readonly surfaceIndices: Uint32Array | null;
  readonly topology: DecodedTopology | null | undefined;
  readonly allowedNodes: Uint8Array;
  readonly elementStart?: number;
  readonly elementCount?: number;
  readonly field: Export3DFieldInput | null;
  readonly appearance: Export3DTargetAppearance;
}): Export3DFemMeshTargetInput | null {
  const {
    id,
    name,
    positionsM,
    nodeCount,
    surfaceIndices,
    topology,
    allowedNodes,
    elementStart,
    elementCount,
    field,
    appearance,
  } = options;

  if (nodeCount <= 0 || positionsM.length < nodeCount * 3) return null;

  const usedNodeMask = new Uint8Array(allowedNodes);
  const validSurface: number[] = [];
  if (surfaceIndices && surfaceIndices.length >= 3) {
    const triLimit = surfaceIndices.length - (surfaceIndices.length % 3);
    for (let i = 0; i < triLimit; i += 3) {
      const a = surfaceIndices[i] ?? -1;
      const b = surfaceIndices[i + 1] ?? -1;
      const c = surfaceIndices[i + 2] ?? -1;
      if (
        a >= 0 &&
        a < nodeCount &&
        b >= 0 &&
        b < nodeCount &&
        c >= 0 &&
        c < nodeCount
      ) {
        validSurface.push(a, b, c);
        usedNodeMask[a] = 1;
        usedNodeMask[b] = 1;
        usedNodeMask[c] = 1;
      }
    }
  }

  const volumeCells = topology
    ? collectVolumeCellsForMask(
        topology,
        usedNodeMask,
        nodeCount,
        elementStart,
        elementCount,
      )
    : null;

  if (volumeCells) {
    for (let i = 0; i < volumeCells.cellNodes.length; i += 1) {
      const n = volumeCells.cellNodes[i] ?? -1;
      if (n >= 0 && n < nodeCount) {
        usedNodeMask[n] = 1;
      }
    }
  }

  if (validSurface.length === 0 && !volumeCells) {
    return null;
  }

  let usedCount = 0;
  for (let i = 0; i < nodeCount; i += 1) {
    if (usedNodeMask[i]) usedCount += 1;
  }
  if (usedCount === 0) return null;

  if (usedCount === nodeCount) {
    return {
      kind: "fem_mesh",
      id,
      name,
      positionsM,
      ...(validSurface.length > 0
        ? { surfaceIndices: Uint32Array.from(validSurface) }
        : {}),
      ...(volumeCells ? { volumeCells } : {}),
      field,
      appearance,
    };
  }

  const globalToLocal = new Int32Array(nodeCount).fill(-1);
  const localToGlobal = new Uint32Array(usedCount);
  const compactedPositions = new Float32Array(usedCount * 3);
  let cursor = 0;
  for (let g = 0; g < nodeCount; g += 1) {
    if (!usedNodeMask[g]) continue;
    globalToLocal[g] = cursor;
    localToGlobal[cursor] = g;
    compactedPositions[cursor * 3] = positionsM[g * 3] ?? 0;
    compactedPositions[cursor * 3 + 1] = positionsM[g * 3 + 1] ?? 0;
    compactedPositions[cursor * 3 + 2] = positionsM[g * 3 + 2] ?? 0;
    cursor += 1;
  }

  const mappedSurface =
    validSurface.length > 0 ? new Uint32Array(validSurface.length) : null;
  if (mappedSurface) {
    for (let i = 0; i < validSurface.length; i += 1) {
      const mapped = globalToLocal[validSurface[i] ?? 0];
      mappedSurface[i] = mapped >= 0 ? mapped : 0;
    }
  }

  let mappedVolumeCells: Export3DVtkVolumeCells | null = null;
  if (volumeCells) {
    const mappedNodes = new Uint32Array(volumeCells.cellNodes.length);
    for (let i = 0; i < volumeCells.cellNodes.length; i += 1) {
      const mapped = globalToLocal[volumeCells.cellNodes[i] ?? 0];
      mappedNodes[i] = mapped >= 0 ? mapped : 0;
    }
    mappedVolumeCells = {
      ...volumeCells,
      cellNodes: mappedNodes,
    };
  }

  const mappedField = remapFieldToLocalNodes(field, localToGlobal, nodeCount);

  return {
    kind: "fem_mesh",
    id,
    name,
    positionsM: compactedPositions,
    ...(mappedSurface ? { surfaceIndices: mappedSurface } : {}),
    ...(mappedVolumeCells ? { volumeCells: mappedVolumeCells } : {}),
    nodeIndices: localToGlobal,
    field: mappedField,
    appearance,
  };
}

function resolveFemPartField(
  input: Viewport3DExportSourceInput,
  partModel: Viewport3DTopologyPartRenderModel,
  totalMagneticParts: number,
  nodeCount: number,
  partAllowedNodes: Uint8Array,
): Export3DFieldInput | null {
  const partId = partModel.part.id;
  const objectId = (partModel.part as { readonly object_id?: string | null })
    .object_id;

  const modeField = findModeCompositionFieldForTarget(
    input,
    [partId, FULL_VIEWPORT_3D_TARGET_ID],
    objectId,
    totalMagneticParts === 1,
  );
  if (modeField) return modeField;

  if (input.analysisComplexField) {
    return convertComplexFieldToExportInput(
      input.analysisComplexField,
      overlayComplexOptions(input.analysisOverlay),
    );
  }

  const partBuffer = input.fieldModel?.targetPasses?.get(partId)?.fieldBuffer;
  if (partBuffer?.decodedFieldVector) {
    const vec = partBuffer.decodedFieldVector;
    let overrideIndices: Uint32Array | readonly number[] | null = null;
    if (!vec.nodeIndices && vec.pointCount > 0 && vec.pointCount < nodeCount) {
      if (
        partBuffer.nodeIndices &&
        partBuffer.nodeIndices.length === vec.pointCount
      ) {
        overrideIndices = partBuffer.nodeIndices;
      } else {
        const activeIndices: number[] = [];
        for (let i = 0; i < nodeCount; i += 1) {
          if (partAllowedNodes[i]) activeIndices.push(i);
        }
        if (activeIndices.length === vec.pointCount) {
          overrideIndices = activeIndices;
        }
      }
    }
    return convertRealFieldToExportInput(vec, overrideIndices);
  }

  const globalVec =
    input.fieldVector ?? input.visualizationDebugSource?.fullFieldVector ?? null;
  if (globalVec) {
    return convertRealFieldToExportInput(globalVec);
  }

  return null;
}

function extractFemTargets(
  input: Viewport3DExportSourceInput,
  defaultPalette: Export3DScalarPalette,
  warnings: string[],
): Export3DFemMeshTargetInput[] {
  const topologyModel = input.topologyModel;
  const topology = input.topology;
  const positionsM: TypedOrNumericVector | null =
    topologyModel?.positions ?? topology?.positions ?? null;
  if (!positionsM || positionsM.length < 3) return [];

  const nodeCount =
    topologyModel?.nodeCount ??
    topology?.nodeCount ??
    Math.floor(positionsM.length / 3);
  if (nodeCount <= 0) return [];

  const targets: Export3DFemMeshTargetInput[] = [];
  const rawMagneticParts = topologyModel?.magneticParts ?? [];

  const visibleMagneticParts = rawMagneticParts.filter((pm) => {
    const partExt = pm.part as {
      readonly role?: string | null;
      readonly label?: string | null;
    };
    if (isAirboxOrFarAirLabel(partExt.role, partExt.label, pm.part.id)) {
      return false;
    }
    if (input.getPartSettings?.(pm.part.id)?.visible === false) {
      return false;
    }
    return true;
  });

  for (const pm of visibleMagneticParts) {
    const partMask = new Uint8Array(nodeCount);
    const markedCount = markNodeSelection(pm.fullNodeSelection, partMask, nodeCount);
    if (markedCount === 0) {
      markNodeSelection(pm.part, partMask, nodeCount);
    }
    if (pm.surfaceIndices) {
      for (let i = 0; i < pm.surfaceIndices.length; i += 1) {
        const idx = pm.surfaceIndices[i] ?? -1;
        if (idx >= 0 && idx < nodeCount) partMask[idx] = 1;
      }
    }

    const field = resolveFemPartField(
      input,
      pm,
      visibleMagneticParts.length,
      nodeCount,
      partMask,
    );
    const partSettings = input.getPartSettings?.(pm.part.id);
    const partLabel =
      (pm.part as { readonly label?: string | null }).label || pm.part.id;
    const built = buildFemTargetFromSelection({
      id: pm.part.id,
      name: partLabel,
      positionsM,
      nodeCount,
      surfaceIndices: pm.surfaceIndices,
      topology,
      allowedNodes: partMask,
      elementStart: pm.part.element_start,
      elementCount: pm.part.element_count,
      field,
      appearance: resolveTargetAppearance(partSettings, field, defaultPalette),
    });
    if (built) targets.push(built);
  }

  if (
    targets.length === 0 &&
    topologyModel &&
    topologyModel.magneticParts.length === 0 &&
    (topologyModel.fallbackSurfaceIndices.length > 0 || (topology?.cellCount ?? 0) > 0)
  ) {
    const allNodes = new Uint8Array(nodeCount).fill(1);
    const field = input.analysisComplexField
      ? convertComplexFieldToExportInput(
          input.analysisComplexField,
          overlayComplexOptions(input.analysisOverlay),
        )
      : input.fieldVector
        ? convertRealFieldToExportInput(input.fieldVector)
        : null;
    const built = buildFemTargetFromSelection({
      id: input.domainId || "fem-mesh",
      name: input.domainId || "FEM Mesh",
      positionsM,
      nodeCount,
      surfaceIndices: topologyModel.fallbackSurfaceIndices,
      topology,
      allowedNodes: allNodes,
      field,
      appearance: resolveTargetAppearance(null, field, defaultPalette),
    });
    if (built) targets.push(built);
  } else if (targets.length === 0 && !topologyModel && topology) {
    const allNodes = new Uint8Array(nodeCount).fill(1);
    const field = input.analysisComplexField
      ? convertComplexFieldToExportInput(
          input.analysisComplexField,
          overlayComplexOptions(input.analysisOverlay),
        )
      : input.fieldVector
        ? convertRealFieldToExportInput(input.fieldVector)
        : null;
    const built = buildFemTargetFromSelection({
      id: input.domainId || "fem-mesh",
      name: input.domainId || "FEM Mesh",
      positionsM,
      nodeCount,
      surfaceIndices: null,
      topology,
      allowedNodes: allNodes,
      field,
      appearance: resolveTargetAppearance(null, field, defaultPalette),
    });
    if (built) targets.push(built);
  }

  if (input.airboxSettings?.visible && topologyModel?.airboxParts.length) {
    for (const airPm of topologyModel.airboxParts) {
      const partSettings = input.getPartSettings?.(airPm.part.id);
      if (partSettings?.visible === false) continue;
      const airMask = new Uint8Array(nodeCount);
      markNodeSelection(airPm.fullNodeSelection, airMask, nodeCount);
      if (airPm.surfaceIndices) {
        for (let i = 0; i < airPm.surfaceIndices.length; i += 1) {
          const idx = airPm.surfaceIndices[i] ?? -1;
          if (idx >= 0 && idx < nodeCount) airMask[idx] = 1;
        }
      }
      const airField =
        input.fieldModel?.targetPasses?.get(airPm.part.id)?.fieldBuffer
          ?.decodedFieldVector ?? null;
      const field = airField ? convertRealFieldToExportInput(airField) : null;
      const airLabel =
        (airPm.part as { readonly label?: string | null }).label ||
        airPm.part.id;
      const built = buildFemTargetFromSelection({
        id: airPm.part.id,
        name: airLabel,
        positionsM,
        nodeCount,
        surfaceIndices: airPm.surfaceIndices,
        topology,
        allowedNodes: airMask,
        elementStart: airPm.part.element_start,
        elementCount: airPm.part.element_count,
        field,
        appearance: {
          ...resolveTargetAppearance(partSettings, field, defaultPalette),
          opacity:
            resolveSettingsOpacity(input.airboxSettings) ??
            resolveSettingsOpacity(partSettings) ??
            0.2,
        },
      });
      if (built) targets.push(built);
    }
  }

  if (targets.length > 0 && targets.every((t) => !t.field)) {
    warnings.push(
      "FEM mesh exported without an active field solution; geometry only.",
    );
  }

  return targets;
}

function extractPrimitiveFallbackTargets(
  input: Viewport3DExportSourceInput,
  defaultPalette: Export3DScalarPalette,
  warnings: string[],
): {
  readonly targets: Export3DSurfaceGeometryTargetInput[];
  readonly texturePreviewsMeta: Record<string, unknown>[];
} {
  const objects = input.primitiveModel?.objects ?? [];
  const targets: Export3DSurfaceGeometryTargetInput[] = [];
  const texturePreviewsMeta: Record<string, unknown>[] = [];

  for (const obj of objects) {
    const objSettings = input.getObjectSettings?.(obj.objectId);
    if (objSettings?.visible === false) continue;
    if (
      isAirboxOrFarAirLabel(obj.role, obj.label, obj.objectId) &&
      !input.airboxSettings?.visible
    ) {
      continue;
    }

    const geometry = createPrimitiveObjectGeometry(obj);
    try {
      const posAttr = geometry.getAttribute("position");
      if (!posAttr || posAttr.count <= 0) continue;
      if (!geometry.getAttribute("normal")) {
        geometry.computeVertexNormals();
      }
      const normalAttr = geometry.getAttribute("normal");
      const [cx, cy, cz] = obj.bounds.center;

      const positionsM = new Float32Array(posAttr.count * 3);
      for (let i = 0; i < posAttr.count; i += 1) {
        positionsM[i * 3] = posAttr.getX(i) + cx;
        positionsM[i * 3 + 1] = posAttr.getY(i) + cy;
        positionsM[i * 3 + 2] = posAttr.getZ(i) + cz;
      }

      const normals =
        normalAttr && normalAttr.count === posAttr.count
          ? Float32Array.from(normalAttr.array as Export3DNumericArray)
          : null;

      const idxAttr = geometry.getIndex();
      let indices: Uint32Array;
      if (idxAttr && idxAttr.count >= 3) {
        indices = Uint32Array.from(idxAttr.array as ArrayLike<number>);
      } else {
        indices = new Uint32Array(posAttr.count);
        for (let i = 0; i < posAttr.count; i += 1) indices[i] = i;
      }

      const preview =
        obj.magnetizationTexturePreview ??
        input.magnetizationTexturePreviews?.get(obj.objectId) ??
        null;
      if (preview) {
        texturePreviewsMeta.push({
          objectId: obj.objectId,
          assetId: preview.assetId,
          label: preview.label,
          presetKind: preview.presetKind,
          source: preview.source,
          ...(preview.regionId ? { regionId: preview.regionId } : {}),
          ...(preview.pivot ? { pivot: preview.pivot } : {}),
        });
      }

      const defaultRgb: Export3DRgbTuple =
        obj.role === "antenna" ? [0.85, 0.55, 0.25] : [0.42, 0.58, 0.85];
      const previewRgb = parseHexRgbColor(preview?.color);
      const settingsRgb = parseHexRgbColor(objSettings?.shaderMonoColor);

      targets.push({
        kind: "surface_geometry",
        id: obj.objectId,
        name: obj.label || obj.fallbackLabel || obj.objectId,
        positionsM,
        indices,
        ...(normals ? { normals } : {}),
        appearance: {
          colorMode: "monochrome",
          colorPalette: defaultPalette,
          monochromeColor: settingsRgb ?? previewRgb ?? defaultRgb,
          opacity:
            resolveSettingsOpacity(objSettings) ??
            (isAirboxOrFarAirLabel(obj.role, obj.label, obj.objectId)
              ? resolveSettingsOpacity(input.airboxSettings) ?? 0.25
              : 1),
          includeSurface: objSettings?.shaderVisible ?? true,
          includeWireframe: objSettings?.wireframeVisible ?? false,
          includeVectors: false,
        },
      });
    } finally {
      geometry.dispose();
    }
  }

  if (targets.length > 0) {
    warnings.push(
      "Exporting authored geometry preview (no meshed domain or solver field active).",
    );
  }

  return { targets, texturePreviewsMeta };
}

/**
 * Extract 3D export targets, defaults, and provenance from the live 3D viewport scene model.
 */
export function extractViewport3DExportSource(
  input: Viewport3DExportSourceInput,
): Viewport3DExportSource {
  const warnings: string[] = [];
  const defaultPalette = resolvePaletteFromSettings(
    input.analysisOverlay?.appearance?.scalarColorPalette ??
      input.fdmSettings?.scalarColorPalette ??
      input.scalarColorPalette,
    "viridis",
  );

  const fdmTargets = extractFdmTargets(input, defaultPalette, warnings);
  const femTargets =
    fdmTargets.length === 0
      ? extractFemTargets(input, defaultPalette, warnings)
      : [];

  let primitiveMeta: Record<string, unknown>[] = [];
  let targets: Export3DTargetInput[] =
    fdmTargets.length > 0 ? fdmTargets : femTargets;

  if (targets.length === 0 && input.primitiveModel?.objects.length) {
    const fallback = extractPrimitiveFallbackTargets(
      input,
      defaultPalette,
      warnings,
    );
    targets = fallback.targets;
    primitiveMeta = fallback.texturePreviewsMeta;
  }

  const primaryField = targets.find((t) => Boolean(t.field))?.field ?? null;
  const hasComplexField =
    Boolean(input.analysisComplexField) ||
    targets.some((t) => t.field?.kind === "complex");

  const defaultColorMode = resolveColorModeFromSettings(
    input.analysisOverlay?.appearance?.surfaceColorSource ??
      input.fdmSettings?.surfaceColorSource,
    input.vectorColorMode ?? input.fdmSettings?.vectorColorMode,
    primaryField,
  );

  const defaultAnimationMode: Export3DAnimationMode = hasComplexField
    ? "phase_cycle"
    : primaryField?.kind === "frames"
      ? "playback_frames"
      : "static";

  const quantityId =
    primaryField?.quantityId ??
    input.quantityId ??
    input.fdmSettings?.activeQuantityId ??
    null;

  const rawStem =
    input.analysisOverlay?.label ??
    input.modeCompositionId ??
    input.domainId ??
    (quantityId ? `fullmag-${quantityId}` : null) ??
    targets[0]?.name ??
    "fullmag-model";

  const suggestedFilenameStem = sanitizeSlug(rawStem, "fullmag-model");
  const sourceLabel =
    input.analysisOverlay?.label ??
    input.domainSummary ??
    input.quantityLabel ??
    "Live 3D Viewport";

  const provenance: Record<string, unknown> = {
    source: "live-viewport-3d",
    ...(input.sessionDiscretization
      ? { discretization: input.sessionDiscretization }
      : {}),
    ...(input.domainId ? { domainId: input.domainId } : {}),
    ...(quantityId ? { quantityId } : {}),
    ...(input.analysisOverlay
      ? {
          analysisOverlay: {
            fieldId: input.analysisOverlay.fieldId,
            label: input.analysisOverlay.label,
            source: input.analysisOverlay.source,
            ...(input.analysisOverlay.frequencyHz !== undefined
              ? { frequencyHz: input.analysisOverlay.frequencyHz }
              : {}),
            ...(input.analysisOverlay.modeIndex !== undefined
              ? { modeIndex: input.analysisOverlay.modeIndex }
              : {}),
            ...(input.analysisOverlay.wavevectorKf
              ? { wavevectorKf: input.analysisOverlay.wavevectorKf }
              : {}),
          },
        }
      : {}),
    ...(input.modeCompositionId
      ? { modeCompositionId: input.modeCompositionId }
      : {}),
    ...(primitiveMeta.length > 0
      ? { magnetizationTexturePreviews: primitiveMeta }
      : {}),
  };

  return {
    targets,
    suggestedFilenameStem,
    defaultColorMode,
    defaultPalette,
    defaultAnimationMode,
    provenance,
    quantityId,
    sourceLabel,
    warnings,
  };
}
