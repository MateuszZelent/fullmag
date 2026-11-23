import type {
  CrossSectionPlane,
  CrossSectionQualityMetric,
  DomainMetaResource,
  PlanarMonitorCollectionResource,
  PlanarMonitorCreateRequest,
  PlanarMonitorDeleteRequest,
  PlanarMonitorPatchRequest,
  PlanarMonitorResource,
  RequestOptions,
  SceneResource,
  SliceMeshColorScale,
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";

type PlanarFieldComponent = NonNullable<
  VisualizationStateResource["slice"]
>["component"];
import type {
  DecodedCrossSection,
  DecodedCrossSectionQuality,
} from "@/kernel/api/codecs";
import {
  crossSectionWorkspaceStore,
  planarMonitorCreateRequestFromDraft,
  planarMonitorIdentityForCreate,
  type CrossSectionDraft,
  type CrossSectionFrameExtent,
  type CrossSectionPlot,
  type PlanarMonitor,
  type PlanarMonitorDraft,
  type PlanarMonitorTarget,
} from "@/kernel/workspace/crossSectionWorkspace";
import type { PlanarMonitorFramePreview } from "@/kernel/workspace/planarMonitorFramePreview";
import {
  buildCrossSectionIntersectionStatistics,
  buildCrossSectionQualityStatistics,
  type CrossSectionIntersectionStatistics,
  type CrossSectionQualityStatistics,
} from "@/shared/domain/mesh/crossSectionStatistics";
import { scalarColorPaletteGradientCss } from "@/shared/visualization/scalarColorPalette";

import type { UnitOption } from "../../template";

export type NormalPresetMode = "yz" | "xz" | "xy" | "custom";

export type SliceQuantityKind = "m" | "b_demag" | "h_eff" | "mesh";

export type SliceFieldComponentId =
  | "m_x"
  | "m_y"
  | "m_z"
  | "|m|"
  | "B_x"
  | "B_y"
  | "B_z"
  | "|B|"
  | "H_eff"
  | "E_ex"
  | "E_demag";

export type SliceColormapId =
  | "viridis"
  | "rdbu"
  | "coolwarm"
  | "turbo"
  | "grayscale"
  | "jet"
  | "hot"
  | "plasma"
  | "inferno";

export type SliceRangeMode = "auto" | "manual";

export type SampleGridResolution = "128" | "256" | "512" | "1024";

export interface DomainAxisBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface SliceFormDraft {
  name: string;
  target: string;
  frameExtent: CrossSectionFrameExtent;
  normalMode: NormalPresetMode;
  plane: CrossSectionPlane;
  customNormal: readonly [number, number, number];
  positionM: number;
  positionPercent: number;
  rotationDegrees: number;
  quantity: SliceQuantityKind;
  fieldComponent: SliceFieldComponentId;
  metric: CrossSectionQualityMetric;
  colormap: SliceColormapId;
  rangeMode: SliceRangeMode;
  rangeMin: number;
  rangeMax: number;
  sampleGrid: SampleGridResolution;
  includeWireframe: boolean;
  edgeWidth: number;
  shrinkFactor: number;
  filterExpression: string;
}

export interface CompanionSliceMeta {
  target: string;
  normalMode: NormalPresetMode;
  customNormal: readonly [number, number, number];
  quantity: SliceQuantityKind;
  fieldComponent: SliceFieldComponentId;
  colormap: SliceColormapId;
  rangeMode: SliceRangeMode;
  rangeMin: number;
  rangeMax: number;
  sampleGrid: SampleGridResolution;
  linkedMonitorId: string | null;
}

export const SLICE_LENGTH_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "nm", toSiFactor: 1e-9 },
  { unit: "um", toSiFactor: 1e-6 },
  { unit: "mm", toSiFactor: 1e-3 },
  { unit: "m", toSiFactor: 1 },
];

export const NORMAL_MODE_OPTIONS: readonly {
  label: string;
  value: NormalPresetMode;
}[] = [
  { value: "yz", label: "+X" },
  { value: "xz", label: "+Y" },
  { value: "xy", label: "+Z" },
  { value: "custom", label: "Custom" },
];

export const SLICE_QUANTITY_OPTIONS: readonly {
  label: string;
  value: SliceQuantityKind;
}[] = [
  { value: "m", label: "Magnetization" },
  { value: "b_demag", label: "Demag" },
  { value: "h_eff", label: "Effective" },
  { value: "mesh", label: "Mesh" },
];

export const SLICE_FIELD_COMPONENT_OPTIONS: readonly {
  group: string;
  label: string;
  value: SliceFieldComponentId;
}[] = [
  { value: "m_x", label: "m_x (X component)", group: "Magnetization" },
  { value: "m_y", label: "m_y (Y component)", group: "Magnetization" },
  { value: "m_z", label: "m_z (Z component)", group: "Magnetization" },
  { value: "|m|", label: "|m| (Magnitude)", group: "Magnetization" },
  { value: "B_x", label: "B_x (Demag X)", group: "Magnetic induction" },
  { value: "B_y", label: "B_y (Demag Y)", group: "Magnetic induction" },
  { value: "B_z", label: "B_z (Demag Z)", group: "Magnetic induction" },
  { value: "|B|", label: "|B| (Demag magnitude)", group: "Magnetic induction" },
  { value: "H_eff", label: "H_eff (Effective field)", group: "Effective & energy" },
  { value: "E_ex", label: "E_ex (Exchange energy)", group: "Effective & energy" },
  { value: "E_demag", label: "E_demag (Demag energy)", group: "Effective & energy" },
];

export const QUALITY_METRIC_OPTIONS: readonly {
  label: string;
  value: CrossSectionQualityMetric;
}[] = [
  { value: "skewness", label: "Skewness" },
  { value: "gamma", label: "Gamma (γ)" },
  { value: "sicn", label: "SICN" },
  { value: "volume", label: "Volume" },
  { value: "aspect_ratio", label: "Aspect ratio" },
  { value: "max_angle", label: "Max angle" },
  { value: "min_edge", label: "Min edge" },
];

const HOT_GRADIENT_CSS =
  "linear-gradient(90deg in srgb, rgb(10, 0, 0), rgb(180, 0, 0), rgb(255, 165, 0), rgb(255, 255, 255))";

export const SLICE_COLORMAP_OPTIONS: readonly {
  label: string;
  swatchCss: string;
  value: SliceColormapId;
}[] = [
  {
    value: "viridis",
    label: "Viridis",
    swatchCss: scalarColorPaletteGradientCss("viridis"),
  },
  {
    value: "rdbu",
    label: "RdBu",
    swatchCss: scalarColorPaletteGradientCss("rdbu"),
  },
  {
    value: "coolwarm",
    label: "Coolwarm",
    swatchCss: scalarColorPaletteGradientCss("coolwarm"),
  },
  {
    value: "turbo",
    label: "Turbo",
    swatchCss: scalarColorPaletteGradientCss("turbo"),
  },
  {
    value: "grayscale",
    label: "Grayscale",
    swatchCss: scalarColorPaletteGradientCss("grayscale"),
  },
  {
    value: "jet",
    label: "Jet",
    swatchCss: scalarColorPaletteGradientCss("jet"),
  },
  {
    value: "hot",
    label: "Hot",
    swatchCss: HOT_GRADIENT_CSS,
  },
  {
    value: "plasma",
    label: "Plasma",
    swatchCss: scalarColorPaletteGradientCss("plasma"),
  },
  {
    value: "inferno",
    label: "Inferno",
    swatchCss: scalarColorPaletteGradientCss("inferno"),
  },
];

export const SAMPLE_GRID_OPTIONS: readonly {
  label: string;
  value: SampleGridResolution;
}[] = [
  { value: "128", label: "128 × 128" },
  { value: "256", label: "256 × 256" },
  { value: "512", label: "512 × 512" },
  { value: "1024", label: "1024 × 1024" },
];

export const DEFAULT_DOMAIN_BOUNDS: DomainAxisBounds = {
  min: [-500e-9, -500e-9, -50e-9],
  max: [500e-9, 500e-9, 50e-9],
};

/* ── Companion slice metadata store (lossless per-plot & draft state) ─────── */

const companionStore = new Map<string, CompanionSliceMeta>();
const companionListeners = new Set<() => void>();
const EMPTY_COMPANION_SNAPSHOT: ReadonlyMap<string, CompanionSliceMeta> = new Map();
let companionSnapshot: ReadonlyMap<string, CompanionSliceMeta> = EMPTY_COMPANION_SNAPSHOT;

function emitCompanionChange(): void {
  companionSnapshot =
    companionStore.size === 0 ? EMPTY_COMPANION_SNAPSHOT : new Map(companionStore);
  for (const listener of companionListeners) {
    listener();
  }
}

export function subscribeCompanionSliceMeta(listener: () => void): () => void {
  companionListeners.add(listener);
  return () => companionListeners.delete(listener);
}

export function getCompanionSliceMetaSnapshot(): ReadonlyMap<string, CompanionSliceMeta> {
  return companionSnapshot;
}

export function getCompanionSliceMetaServerSnapshot(): ReadonlyMap<string, CompanionSliceMeta> {
  return EMPTY_COMPANION_SNAPSHOT;
}

export function getCompanionSliceMeta(key: string): CompanionSliceMeta | undefined {
  return companionStore.get(key);
}

export function setCompanionSliceMeta(key: string, meta: CompanionSliceMeta): void {
  companionStore.set(key, meta);
  emitCompanionChange();
}

export function deleteCompanionSliceMeta(key: string): void {
  if (companionStore.delete(key)) {
    emitCompanionChange();
  }
}

export function resetCompanionSliceMetaForTests(): void {
  companionStore.clear();
  emitCompanionChange();
}

/* ── Domain bounds & coordinate conversions ──────────────────────────────── */

export function resolveDomainBounds(
  domainMeta: DomainMetaResource | null | undefined,
): DomainAxisBounds {
  const min = domainMeta?.bounds?.min;
  const max = domainMeta?.bounds?.max;
  if (
    Array.isArray(min) &&
    Array.isArray(max) &&
    min.length >= 3 &&
    max.length >= 3 &&
    Number.isFinite(min[0]) &&
    Number.isFinite(min[1]) &&
    Number.isFinite(min[2]) &&
    Number.isFinite(max[0]) &&
    Number.isFinite(max[1]) &&
    Number.isFinite(max[2])
  ) {
    return {
      min: [min[0]!, min[1]!, min[2]!],
      max: [max[0]!, max[1]!, max[2]!],
    };
  }
  return DEFAULT_DOMAIN_BOUNDS;
}

export function axisIndexForPlane(plane: CrossSectionPlane): 0 | 1 | 2 {
  if (plane === "yz") return 0;
  if (plane === "xz") return 1;
  return 2;
}

export function presetNormalForPlane(
  plane: CrossSectionPlane,
): readonly [number, number, number] {
  if (plane === "yz") return [1, 0, 0];
  if (plane === "xz") return [0, 1, 0];
  return [0, 0, 1];
}

export function dominantPlaneFromNormal(
  normal: readonly [number, number, number],
): CrossSectionPlane {
  const ax = Math.abs(normal[0]);
  const ay = Math.abs(normal[1]);
  const az = Math.abs(normal[2]);
  if (ax >= ay && ax >= az) return "yz";
  if (ay >= ax && ay >= az) return "xz";
  return "xy";
}

export function axisRangeForDraft(
  bounds: DomainAxisBounds,
  plane: CrossSectionPlane,
): { minM: number; maxM: number; spanM: number } {
  const idx = axisIndexForPlane(plane);
  const rawMin = bounds.min[idx];
  const rawMax = bounds.max[idx];
  const minM = Math.min(rawMin, rawMax);
  const maxM = Math.max(rawMin, rawMax);
  const spanM = maxM - minM;
  return { minM, maxM, spanM };
}

export function positionMetresFromPercent(
  positionPercent: number,
  bounds: DomainAxisBounds,
  plane: CrossSectionPlane,
): number {
  const { minM, maxM, spanM } = axisRangeForDraft(bounds, plane);
  if (spanM <= 0) return minM;
  const pct = clampNumber(positionPercent, 0, 100);
  return clampNumber(minM + (pct / 100) * spanM, minM, maxM);
}

export function positionPercentFromMetres(
  positionM: number,
  bounds: DomainAxisBounds,
  plane: CrossSectionPlane,
): number {
  const { minM, spanM } = axisRangeForDraft(bounds, plane);
  if (spanM <= 0) return 50;
  return clampNumber(((positionM - minM) / spanM) * 100, 0, 100);
}

export function clampPositionMetres(
  positionM: number,
  bounds: DomainAxisBounds,
  plane: CrossSectionPlane,
): number {
  const { minM, maxM } = axisRangeForDraft(bounds, plane);
  return clampNumber(positionM, minM, maxM);
}

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/* ── Colormap & quantity/component mappings ──────────────────────────────── */

export function toSliceMeshColorScale(
  colormap: SliceColormapId,
): SliceMeshColorScale {
  if (
    colormap === "viridis" ||
    colormap === "jet" ||
    colormap === "hot" ||
    colormap === "coolwarm"
  ) {
    return colormap;
  }
  if (colormap === "rdbu") return "coolwarm";
  if (colormap === "turbo") return "jet";
  return "viridis";
}

export function normalizeSliceColormap(
  raw: string | null | undefined,
  fallback: SliceColormapId = "viridis",
): SliceColormapId {
  const key = raw?.trim().toLowerCase() ?? "";
  if (
    key === "viridis" ||
    key === "rdbu" ||
    key === "coolwarm" ||
    key === "turbo" ||
    key === "grayscale" ||
    key === "jet" ||
    key === "hot" ||
    key === "plasma" ||
    key === "inferno"
  ) {
    return key;
  }
  return fallback;
}

export function defaultComponentForQuantity(
  quantity: SliceQuantityKind,
): SliceFieldComponentId {
  if (quantity === "b_demag") return "|B|";
  if (quantity === "h_eff") return "H_eff";
  return "|m|";
}

export function inferQuantityFromComponent(
  component: SliceFieldComponentId,
): Exclude<SliceQuantityKind, "mesh"> {
  if (
    component === "B_x" ||
    component === "B_y" ||
    component === "B_z" ||
    component === "|B|"
  ) {
    return "b_demag";
  }
  if (component === "H_eff" || component === "E_ex" || component === "E_demag") {
    return "h_eff";
  }
  return "m";
}

export function resolvePlanarQuantityAndComponent(
  quantity: SliceQuantityKind,
  fieldComponent: SliceFieldComponentId,
): { quantityId: string; component: PlanarFieldComponent } {
  if (fieldComponent === "E_ex") {
    return { quantityId: "eden_ex", component: "magnitude" };
  }
  if (fieldComponent === "E_demag") {
    return { quantityId: "eden_demag", component: "magnitude" };
  }
  if (fieldComponent === "H_eff") {
    return { quantityId: "B_eff", component: "magnitude" };
  }
  if (
    fieldComponent === "B_x" ||
    fieldComponent === "B_y" ||
    fieldComponent === "B_z" ||
    fieldComponent === "|B|" ||
    quantity === "b_demag"
  ) {
    const comp: PlanarFieldComponent =
      fieldComponent === "B_x"
        ? "x"
        : fieldComponent === "B_y"
          ? "y"
          : fieldComponent === "B_z"
            ? "z"
            : "magnitude";
    return { quantityId: "B_demag", component: comp };
  }
  if (quantity === "h_eff") {
    return { quantityId: "B_eff", component: "magnitude" };
  }
  const comp: PlanarFieldComponent =
    fieldComponent === "m_x"
      ? "x"
      : fieldComponent === "m_y"
        ? "y"
        : fieldComponent === "m_z"
          ? "z"
          : "magnitude";
  return { quantityId: "m", component: comp };
}

export function buildTargetOptions(
  scene: SceneResource | null | undefined,
): readonly { label: string; value: string }[] {
  const base: { label: string; value: string }[] = [
    { value: "domain", label: "Shared domain" },
    { value: "magnetic_domain", label: "Magnetic domain" },
  ];
  for (const obj of scene?.objects ?? []) {
    if (!obj?.id) continue;
    base.push({
      value: `object:${obj.id}`,
      label: `Object · ${obj.name || obj.id}`,
    });
  }
  return base;
}

export function parseMonitorTarget(targetValue: string): PlanarMonitorTarget {
  if (targetValue.startsWith("object:")) {
    const objectId = targetValue.slice("object:".length).trim();
    if (objectId) {
      return { kind: "object", object_id: objectId };
    }
  }
  if (targetValue === "magnetic_domain") {
    return { kind: "magnetic_domain" };
  }
  return { kind: "domain" };
}

export function serializeMonitorTarget(target: PlanarMonitorTarget): string {
  if (target.kind === "object") return `object:${target.object_id}`;
  if (target.kind === "magnetic_domain") return "magnetic_domain";
  return "domain";
}

/* ── Orthonormal right-handed frame builder for preset + custom normals ──── */

export function normalizeUnitVector(
  vec: readonly [number, number, number],
): [number, number, number] | null {
  const len = Math.hypot(vec[0], vec[1], vec[2]);
  if (!Number.isFinite(len) || len <= 1e-12) return null;
  return [vec[0] / len, vec[1] / len, vec[2] / len];
}

function cross3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function buildRightHandedMonitorFrame(
  draft: SliceFormDraft,
  bounds: DomainAxisBounds,
): PlanarMonitor["frame"] {
  const extentKind: PlanarMonitor["frame"]["extent"]["kind"] =
    draft.frameExtent === "universe"
      ? "universe"
      : draft.frameExtent === "magnetic_domain"
        ? "magnetic_domain"
        : "target_bounds";

  const radians = (draft.rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const rotateBasis = (
    u0: readonly [number, number, number],
    v0: readonly [number, number, number],
  ): { u: [number, number, number]; v: [number, number, number] } => ({
    u: [
      cos * u0[0] + sin * v0[0],
      cos * u0[1] + sin * v0[1],
      cos * u0[2] + sin * v0[2],
    ],
    v: [
      cos * v0[0] - sin * u0[0],
      cos * v0[1] - sin * u0[1],
      cos * v0[2] - sin * u0[2],
    ],
  });

  if (draft.normalMode !== "custom") {
    const plane = draft.normalMode;
    const posM = clampPositionMetres(draft.positionM, bounds, plane);
    const base =
      plane === "xy"
        ? {
            normal: [0, 0, 1] as [number, number, number],
            origin: [0, 0, posM] as [number, number, number],
            u0: [1, 0, 0] as const,
            v0: [0, 1, 0] as const,
          }
        : plane === "xz"
          ? {
              normal: [0, -1, 0] as [number, number, number],
              origin: [0, posM, 0] as [number, number, number],
              u0: [1, 0, 0] as const,
              v0: [0, 0, 1] as const,
            }
          : {
              normal: [1, 0, 0] as [number, number, number],
              origin: [posM, 0, 0] as [number, number, number],
              u0: [0, 1, 0] as const,
              v0: [0, 0, 1] as const,
            };
    const { u, v } = rotateBasis(base.u0, base.v0);
    return {
      extent: { kind: extentKind, padding_m: 0 },
      normal: base.normal,
      normalization_version: "planar_frame_v1",
      origin_m: base.origin,
      preset: plane,
      u_axis: u,
      v_axis: v,
    };
  }

  const normal = normalizeUnitVector(draft.customNormal) ?? [0, 0, 1];
  const ref: readonly [number, number, number] =
    Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u0 = normalizeUnitVector(cross3(ref, normal)) ?? [1, 0, 0];
  const v0 = normalizeUnitVector(cross3(normal, u0)) ?? [0, 1, 0];
  const { u, v } = rotateBasis(u0, v0);
  const center: [number, number, number] = [
    0.5 * (bounds.min[0] + bounds.max[0]),
    0.5 * (bounds.min[1] + bounds.max[1]),
    0.5 * (bounds.min[2] + bounds.max[2]),
  ];
  const dominantPlane = dominantPlaneFromNormal(normal);
  const { minM, maxM } = axisRangeForDraft(bounds, dominantPlane);
  const offsetFromCenter =
    clampNumber(draft.positionM, minM, maxM) - 0.5 * (minM + maxM);
  const originM: [number, number, number] = [
    center[0] + normal[0] * offsetFromCenter,
    center[1] + normal[1] * offsetFromCenter,
    center[2] + normal[2] * offsetFromCenter,
  ];

  return {
    extent: { kind: extentKind, padding_m: 0 },
    normal,
    normalization_version: "planar_frame_v1",
    origin_m: originM,
    preset: null,
    u_axis: u,
    v_axis: v,
  };
}

export function buildPlanarMonitorCreatePayload(
  draft: SliceFormDraft,
  expectedSceneRevision: number,
  bounds: DomainAxisBounds,
  existingMonitors: readonly PlanarMonitor[],
): PlanarMonitorCreateRequest {
  const requestedName = draft.name.trim() || "Planar monitor";
  const identity = planarMonitorIdentityForCreate(
    requestedName,
    existingMonitors,
  );

  if (
    draft.normalMode !== "custom" &&
    (draft.target === "domain" || draft.target === "magnetic_domain") &&
    existingMonitors.length === 0
  ) {
    const csDraft: CrossSectionDraft = toCrossSectionDraft(draft);
    const req = planarMonitorCreateRequestFromDraft(
      csDraft,
      expectedSceneRevision,
      bounds,
    );
    return {
      expected_scene_revision: req.expected_scene_revision,
      monitor: {
        ...req.monitor,
        target: parseMonitorTarget(draft.target),
      },
    };
  }

  const monitorDraft: PlanarMonitorDraft = {
    monitor: {
      id: identity.id,
      name: identity.name,
      target: parseMonitorTarget(draft.target),
      operator: { kind: "plane_sample" },
      frame: buildRightHandedMonitorFrame(draft, bounds),
    },
    ui: { displayLengthUnit: "nm" },
  };
  return planarMonitorCreateRequestFromDraft(
    monitorDraft,
    expectedSceneRevision,
  );
}

export function buildPlanarVisualizationPatch(
  draft: SliceFormDraft,
  monitorId: string | null,
  currentPlanar: VisualizationStateResource["planar"] | null | undefined,
): NonNullable<VisualizationStatePatch["planar"]> {
  const gridDim = Number(draft.sampleGrid) || 512;
  const { quantityId, component } = resolvePlanarQuantityAndComponent(
    draft.quantity,
    draft.fieldComponent,
  );
  const baseLayers = currentPlanar?.layers ?? {
    boundaries: false,
    bounds: false,
    contours: false,
    mesh: draft.includeWireframe,
    points: false,
    probes: true,
    raster: true,
    streamlines: false,
    vectors: false,
  };

  return {
    ...(monitorId
      ? { source: { kind: "monitor" as const, monitor_id: monitorId } }
      : {}),
    ...(draft.quantity !== "mesh"
      ? {
          quantity_id: quantityId,
          component,
        }
      : {}),
    colormap: draft.colormap,
    range:
      draft.rangeMode === "manual"
        ? {
            mode: "manual",
            min: draft.rangeMin,
            max: draft.rangeMax,
          }
        : {
            mode: "auto",
            min: null,
            max: null,
          },
    layers: {
      ...baseLayers,
      mesh: draft.includeWireframe,
    },
    resolution: {
      width: gridDim,
      height: gridDim,
      vector_budget: currentPlanar?.resolution?.vector_budget ?? 2_000,
    },
  };
}

export function buildFramePreviewFor3DGizmo(
  draft: SliceFormDraft,
  bounds: DomainAxisBounds,
  monitorId: string,
  isDraft: boolean,
): PlanarMonitorFramePreview {
  const frame = buildRightHandedMonitorFrame(draft, bounds);
  const spanX = Math.max(1e-9, bounds.max[0] - bounds.min[0]);
  const spanY = Math.max(1e-9, bounds.max[1] - bounds.min[1]);
  const spanZ = Math.max(1e-9, bounds.max[2] - bounds.min[2]);
  const halfSpan = 0.5 * Math.max(spanX, spanY, spanZ);
  return {
    boundsUvM: [-halfSpan, halfSpan, -halfSpan, halfSpan],
    isDraft,
    monitorId,
    normal: [frame.normal[0]!, frame.normal[1]!, frame.normal[2]!],
    operator: { kind: "plane_sample" },
    originM: [frame.origin_m[0]!, frame.origin_m[1]!, frame.origin_m[2]!],
    selectable: true,
    uAxis: [frame.u_axis[0]!, frame.u_axis[1]!, frame.u_axis[2]!],
    vAxis: [frame.v_axis[0]!, frame.v_axis[1]!, frame.v_axis[2]!],
    visible: true,
  };
}

export function toCrossSectionDraft(draft: SliceFormDraft): CrossSectionDraft {
  return {
    colorScale: toSliceMeshColorScale(draft.colormap),
    edgeWidth: draft.edgeWidth,
    filterExpression: draft.filterExpression,
    frameExtent: draft.frameExtent,
    id: "draft",
    includeWireframe: draft.includeWireframe,
    metric: draft.metric,
    name: draft.name,
    plane: draft.plane,
    positionPercent: draft.positionPercent,
    rotationDegrees: draft.rotationDegrees,
    shrinkFactor: draft.shrinkFactor,
  };
}

export function toCompanionSliceMeta(
  draft: SliceFormDraft,
  linkedMonitorId: string | null,
): CompanionSliceMeta {
  return {
    colormap: draft.colormap,
    customNormal: draft.customNormal,
    fieldComponent: draft.fieldComponent,
    linkedMonitorId,
    normalMode: draft.normalMode,
    quantity: draft.quantity,
    rangeMax: draft.rangeMax,
    rangeMin: draft.rangeMin,
    rangeMode: draft.rangeMode,
    sampleGrid: draft.sampleGrid,
    target: draft.target,
  };
}

export function buildSliceDraftFromWorkspace(
  source: CrossSectionDraft | CrossSectionPlot | null,
  companion: CompanionSliceMeta | undefined,
  bounds: DomainAxisBounds,
  fallbackName: string,
  defaultQuantity: SliceQuantityKind,
): SliceFormDraft {
  const plane: CrossSectionPlane = source?.plane ?? "xy";
  const positionPercent = source?.positionPercent ?? 50;
  const positionM = positionMetresFromPercent(positionPercent, bounds, plane);
  const isPlot = source !== null && "renderOptions" in source;
  const colorScale = isPlot
    ? source.renderOptions.colorScale
    : (source?.colorScale ?? "viridis");
  const edgeWidth = isPlot
    ? source.renderOptions.edgeWidth
    : (source?.edgeWidth ?? 1.5);
  const includeWireframe = isPlot
    ? source.renderOptions.wireframeVisible
    : (source?.includeWireframe ?? true);
  const shrinkFactor = isPlot
    ? source.renderOptions.shrinkFactor
    : (source?.shrinkFactor ?? 1);
  const filterExpression = isPlot
    ? source.renderOptions.filterExpression
    : (source?.filterExpression ?? "");

  return {
    colormap: companion?.colormap ?? normalizeSliceColormap(colorScale, "viridis"),
    customNormal: companion?.customNormal ?? presetNormalForPlane(plane),
    edgeWidth,
    fieldComponent: companion?.fieldComponent ?? "|m|",
    filterExpression,
    frameExtent: source?.frameExtent ?? "universe",
    includeWireframe,
    metric: source?.metric ?? "skewness",
    name: source?.name ?? fallbackName,
    normalMode: companion?.normalMode ?? plane,
    plane,
    positionM,
    positionPercent,
    quantity: companion?.quantity ?? defaultQuantity,
    rangeMax: companion?.rangeMax ?? 1,
    rangeMin: companion?.rangeMin ?? -1,
    rangeMode: companion?.rangeMode ?? "auto",
    rotationDegrees: source?.rotationDegrees ?? 0,
    sampleGrid: companion?.sampleGrid ?? "512",
    shrinkFactor,
    target: companion?.target ?? "domain",
  };
}

/* ── Cross-section workspace plot removal & monitor delete helper ────────── */

export function removeCrossSectionPlotById(plotId: string): void {
  const state = crossSectionWorkspaceStore.getSnapshot();
  const nextPlots = state.plots.filter((entry) => entry.id !== plotId);
  if (nextPlots.length === state.plots.length) return;
  const nextActivePlotId =
    state.activePlotId === plotId
      ? (nextPlots.at(-1)?.id ?? null)
      : state.activePlotId;
  crossSectionWorkspaceStore.setState({
    ...state,
    activePlotId: nextActivePlotId,
    plots: nextPlots,
  });
  deleteCompanionSliceMeta(plotId);
}

export interface PlanarMonitorsApiCompat {
  create?: (
    request: PlanarMonitorCreateRequest,
    options?: RequestOptions,
  ) => Promise<PlanarMonitorResource>;
  patch?: (
    monitorId: string,
    request: PlanarMonitorPatchRequest,
    options?: RequestOptions,
  ) => Promise<PlanarMonitorResource>;
  remove?: (
    monitorId: string,
    request: PlanarMonitorDeleteRequest,
    options?: RequestOptions,
  ) => Promise<PlanarMonitorCollectionResource>;
  delete?: (
    monitorId: string,
    request: PlanarMonitorDeleteRequest,
    options?: RequestOptions,
  ) => Promise<PlanarMonitorCollectionResource>;
  list?: (options?: RequestOptions) => Promise<PlanarMonitorCollectionResource>;
}

export function resolvePlanarMonitorDeleteFn(
  planarMonitorsApi: PlanarMonitorsApiCompat | undefined,
):
  | ((
      monitorId: string,
      request: PlanarMonitorDeleteRequest,
      options?: RequestOptions,
    ) => Promise<PlanarMonitorCollectionResource>)
  | null {
  if (!planarMonitorsApi) return null;
  if (typeof planarMonitorsApi.remove === "function") {
    return planarMonitorsApi.remove.bind(planarMonitorsApi);
  }
  if (typeof planarMonitorsApi.delete === "function") {
    return planarMonitorsApi.delete.bind(planarMonitorsApi);
  }
  return null;
}

/* ── Rich FEM cross-section intersection & quality statistics ────────────── */

export interface ExtendedCrossSectionStatistics {
  readonly qualityStats: CrossSectionQualityStatistics;
  readonly intersectionStats: CrossSectionIntersectionStatistics;
  readonly triangleCount: number;
  readonly quadCount: number;
  readonly higherPolygonCount: number;
  readonly areaM2: number;
  readonly median: number | null;
  readonly stdDev: number | null;
}

export function isMixedTopologyUnsupportedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "mixed_topology_not_supported"
  );
}

export function computeExtendedCrossSectionStatistics(
  crossSection: DecodedCrossSection | null | undefined,
  quality: DecodedCrossSectionQuality | null | undefined,
  threshold = 0.1,
): ExtendedCrossSectionStatistics | null {
  if (!crossSection) return null;

  const samples = Array.from({ length: crossSection.polygonCount }, (_, idx) => ({
    qualityValue: quality?.perElementQuality[idx] ?? null,
    visible: true,
  }));
  const qualityStats = buildCrossSectionQualityStatistics(samples, { threshold });
  const intersectionStats = buildCrossSectionIntersectionStatistics(
    crossSection.intersectionKinds,
  );

  let triangleCount = 0;
  let quadCount = 0;
  let higherPolygonCount = 0;
  let areaM2 = 0;

  const offsets = crossSection.polygonOffsets;
  const verts = crossSection.vertices;
  for (let p = 0; p < crossSection.polygonCount; p += 1) {
    const start = offsets[p] ?? 0;
    const end = offsets[p + 1] ?? start;
    const count = end - start;
    if (count === 3) triangleCount += 1;
    else if (count === 4) quadCount += 1;
    else if (count > 4) higherPolygonCount += 1;

    if (count >= 3 && verts.length >= end * 2) {
      let twiceSignedArea = 0;
      for (let i = 0; i < count; i += 1) {
        const v0 = start + i;
        const v1 = start + ((i + 1) % count);
        const u0 = verts[v0 * 2] ?? 0;
        const w0 = verts[v0 * 2 + 1] ?? 0;
        const u1 = verts[v1 * 2] ?? 0;
        const w1 = verts[v1 * 2 + 1] ?? 0;
        twiceSignedArea += u0 * w1 - u1 * w0;
      }
      areaM2 += 0.5 * Math.abs(twiceSignedArea);
    }
  }

  const finiteQualities: number[] = [];
  for (const sample of samples) {
    if (
      sample.visible &&
      typeof sample.qualityValue === "number" &&
      Number.isFinite(sample.qualityValue)
    ) {
      finiteQualities.push(sample.qualityValue);
    }
  }

  let median: number | null = null;
  let stdDev: number | null = null;
  if (finiteQualities.length > 0) {
    const sorted = finiteQualities.toSorted((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    median =
      sorted.length % 2 === 1
        ? (sorted[mid] ?? null)
        : 0.5 * ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0));

    const mean = qualityStats.mean ?? 0;
    let sumSq = 0;
    for (const q of finiteQualities) {
      const diff = q - mean;
      sumSq += diff * diff;
    }
    stdDev = Math.sqrt(sumSq / finiteQualities.length);
  }

  return {
    areaM2,
    higherPolygonCount,
    intersectionStats,
    median,
    quadCount,
    qualityStats,
    stdDev,
    triangleCount,
  };
}

export function resolveSelectedCrossSectionElement(
  elementIndex: number | null,
  parentElementIds: Uint32Array | null | undefined,
  qualityValues: Float32Array | null | undefined,
): {
  parentElementId: number;
  polygonIndex: number;
  quality: number | null;
} | null {
  if (elementIndex === null || !parentElementIds) return null;

  for (let polygon = 0; polygon < parentElementIds.length; polygon += 1) {
    const parentElementId = parentElementIds[polygon];
    if (parentElementId !== elementIndex) continue;
    return {
      parentElementId,
      polygonIndex: polygon,
      quality: qualityValues?.[polygon] ?? null,
    };
  }

  return {
    parentElementId: elementIndex,
    polygonIndex: -1,
    quality: null,
  };
}

export function formatQualityMetricValue(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(3);
}

export function formatCrossSectionArea(areaM2: number): string {
  if (!Number.isFinite(areaM2) || areaM2 <= 0) return "0 m²";
  if (areaM2 < 1e-12) return `${(areaM2 * 1e18).toFixed(2)} nm²`;
  if (areaM2 < 1e-6) return `${(areaM2 * 1e12).toFixed(2)} um²`;
  if (areaM2 < 1) return `${(areaM2 * 1e6).toFixed(2)} mm²`;
  return `${areaM2.toFixed(3)} m²`;
}

export function formatIntegerCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0";
  return Math.trunc(value).toLocaleString("en-US");
}
