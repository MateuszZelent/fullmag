import type { JsonObject } from "@/kernel/api/apiTypes";
import { airboxEffectiveLengthUnit } from "../../panels/airbox/airboxDisplay.model";
import type { AirboxMeshPolicyLane } from "../../panels/airbox/airboxMeshPolicyDraft";
import {
  asNumber,
  asRecord,
  asString,
  asTuple3,
  formatLengthSmart,
  formatTupleSmart,
  sanitizeStatusText,
  type JsonRecord,
} from "../../panels/airbox/airboxSpecShared";

export const EFFECTIVE_POLICY_KEYS = [
  "mode",
  "airbox_hmax",
  "airbox_hmin",
  "airbox_growth_rate",
  "airbox_grading",
  "airbox_curvature_factor",
  "airbox_narrow_region_resolution",
  "padding",
  "size",
  "center",
] as const;

export const FDM_EFFECTIVE_POLICY_KEYS = ["mode", "padding", "size", "center"] as const;

export const FEM_ONLY_POLICY_KEYS = [
  "airbox_grading",
  "airbox_growth_rate",
  "airbox_hmax",
  "airbox_hmin",
  "airbox_curvature_factor",
  "airbox_narrow_region_resolution",
  "curvature_factor",
  "narrow_region_resolution",
  "maximum_element_size",
  "minimum_element_size",
] as const;

export function formatEffectiveValue(key: string, value: unknown): string {
  if (value === undefined || value === null) return "Not set";
  if (Array.isArray(value)) {
    const tuple = asTuple3(value);
    if (tuple && airboxEffectiveLengthUnit(key) === "m") {
      return formatTupleSmart(tuple);
    }
    return `[${value.map((item) => String(item)).join(", ")}]`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return airboxEffectiveLengthUnit(key) === "m"
      ? formatLengthSmart(value)
      : Number(value.toPrecision(6)).toString();
  }
  if (typeof value === "string") return sanitizeStatusText(value, "Not set");
  return JSON.stringify(value);
}

export function readTargetMetric(
  target: JsonRecord | null | undefined,
  ...keys: string[]
): number | null {
  if (!target) return null;
  for (const key of keys) {
    const num = asNumber(target[key]);
    if (num !== null) return num;
  }
  return null;
}

type DemagFormulationChoice =
  | "auto"
  | "poisson_robin"
  | "poisson_dirichlet"
  | "fredkin_koehler"
  | "bem"
  | "fmm"
  | "single_grid"
  | "multilayer_convolution";

type PbcDemagChoice = "open" | "truncated_images" | "periodic_airbox_k0";

export interface StudyBoundarySlice {
  demagFormulation: DemagFormulationChoice;
  periodicAxes: readonly string[];
  pbcDemag: PbcDemagChoice;
  periodicImagesX: number;
  periodicImagesY: number;
  periodicImagesZ: number;
}

export function readStudyBoundarySlice(
  sceneData: unknown,
  lane: "fdm" | "fem",
): StudyBoundarySlice {
  const study = asRecord(asRecord(sceneData)?.study);
  const rawDemag = asString(study?.demag_realization) ?? "auto";
  const allowedFem: readonly DemagFormulationChoice[] = [
    "auto",
    "poisson_robin",
    "poisson_dirichlet",
    "fredkin_koehler",
    "bem",
    "fmm",
  ];
  const allowedFdm: readonly DemagFormulationChoice[] = [
    "auto",
    "single_grid",
    "multilayer_convolution",
  ];
  const allowed = lane === "fdm" ? allowedFdm : allowedFem;
  const demagFormulation: DemagFormulationChoice = (
    allowed as readonly string[]
  ).includes(rawDemag)
    ? (rawDemag as DemagFormulationChoice)
    : "auto";

  const pbc = asRecord(study?.pbc);
  const axesRaw = Array.isArray(pbc?.axes) ? pbc.axes : ["open", "open", "open"];
  const axisNames = ["x", "y", "z"] as const;
  const periodicAxes: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    if (asString(axesRaw[i]) === "periodic") {
      periodicAxes.push(axisNames[i]!);
    }
  }

  const rawPbcDemag = asString(pbc?.demag) ?? "open";
  const pbcDemag: PbcDemagChoice =
    rawPbcDemag === "truncated_images" || rawPbcDemag === "periodic_airbox_k0"
      ? rawPbcDemag
      : "open";

  const imgCounts = asTuple3(pbc?.image_counts) ?? [4, 4, 1];
  return {
    demagFormulation,
    pbcDemag,
    periodicAxes,
    periodicImagesX: Math.max(0, Math.round(imgCounts[0])),
    periodicImagesY: Math.max(0, Math.round(imgCounts[1])),
    periodicImagesZ: Math.max(0, Math.round(imgCounts[2])),
  };
}

export function buildStudyBoundaryMergePatch(slice: StudyBoundarySlice): JsonObject {
  const hasPeriodicAxis = slice.periodicAxes.length > 0;
  const pbcValue = hasPeriodicAxis
    ? {
        axes: (["x", "y", "z"] as const).map((ax) =>
          slice.periodicAxes.includes(ax) ? "periodic" : "open",
        ),
        demag: slice.pbcDemag,
        ...(slice.pbcDemag === "truncated_images"
          ? {
              image_counts: [
                Math.max(0, Math.round(slice.periodicImagesX)),
                Math.max(0, Math.round(slice.periodicImagesY)),
                Math.max(0, Math.round(slice.periodicImagesZ)),
              ],
            }
          : {}),
      }
    : null;

  return {
    demag_realization:
      slice.demagFormulation === "auto" ? null : slice.demagFormulation,
    pbc: pbcValue,
  } as JsonObject;
}

export function studyBoundaryEquals(
  a: StudyBoundarySlice,
  b: StudyBoundarySlice,
): boolean {
  return (
    a.demagFormulation === b.demagFormulation &&
    a.pbcDemag === b.pbcDemag &&
    a.periodicImagesX === b.periodicImagesX &&
    a.periodicImagesY === b.periodicImagesY &&
    a.periodicImagesZ === b.periodicImagesZ &&
    a.periodicAxes.length === b.periodicAxes.length &&
    a.periodicAxes.every((ax) => b.periodicAxes.includes(ax))
  );
}

export function formatDemagFormulationLabel(
  formulation: DemagFormulationChoice,
  periodicAxes: readonly string[],
): string {
  const periodicSuffix =
    periodicAxes.length > 0
      ? ` · Periodic (${periodicAxes.map((a) => a.toUpperCase()).join(", ")})`
      : "";
  switch (formulation) {
    case "poisson_robin":
      return `Poisson Robin (1/r asymptotic)${periodicSuffix}`;
    case "poisson_dirichlet":
      return `Poisson Dirichlet (φ = 0)${periodicSuffix}`;
    case "fredkin_koehler":
      return `Fredkin-Koehler Hybrid FEM/BEM${periodicSuffix}`;
    case "bem":
      return `Boundary Element (BEM)${periodicSuffix}`;
    case "fmm":
      return `Fast Multipole (FMM)${periodicSuffix}`;
    case "single_grid":
      return `FDM Single-Grid Convolution${periodicSuffix}`;
    case "multilayer_convolution":
      return `FDM Multilayer Convolution${periodicSuffix}`;
    default:
      return periodicAxes.length > 0
        ? `Periodic (${periodicAxes.map((a) => a.toUpperCase()).join(", ")})`
        : "Open / Asymptotic (Auto)";
  }
}

// ============================================================================
// 1. airbox.root — AirboxRootInspectorSpecPanel (100% Canonical Schema Parity)
// ============================================================================

export interface AirboxRootDraft extends StudyBoundarySlice {
  extentMode: "auto" | "manual";
  hasPadding: boolean;
  paddingM: readonly [number, number, number];
  manualSizeM: readonly [number, number, number];
  hasManualCenter: boolean;
  manualCenterM: readonly [number, number, number];
  airboxVisible: boolean;
  boundsVisible: boolean;
  wireframeVisible: boolean;
}

export function buildUniverseConfigFromRootDraft(
  draft: AirboxRootDraft,
  existingConfig: JsonRecord | null | undefined,
  lane: AirboxMeshPolicyLane,
): JsonObject {
  const next: Record<string, unknown> = {
    ...(existingConfig ?? {}),
    mode: draft.extentMode,
  };

  // Padding is valid and preserved in BOTH auto and manual modes
  if (draft.hasPadding) {
    next.padding = [draft.paddingM[0], draft.paddingM[1], draft.paddingM[2]];
  } else {
    delete next.padding;
  }

  if (draft.extentMode === "manual") {
    next.size = [
      draft.manualSizeM[0],
      draft.manualSizeM[1],
      draft.manualSizeM[2],
    ];
    if (draft.hasManualCenter) {
      next.center = [
        draft.manualCenterM[0],
        draft.manualCenterM[1],
        draft.manualCenterM[2],
      ];
    } else {
      delete next.center;
    }
  } else {
    // Switching back to auto clears manual size and center
    delete next.size;
    delete next.center;
  }

  if (lane === "fdm") {
    for (const key of FEM_ONLY_POLICY_KEYS) {
      delete next[key];
    }
  }

  return next as JsonObject;
}

export function universeExtentEquals(a: AirboxRootDraft, b: AirboxRootDraft): boolean {
  return (
    a.extentMode === b.extentMode &&
    a.hasPadding === b.hasPadding &&
    a.paddingM[0] === b.paddingM[0] &&
    a.paddingM[1] === b.paddingM[1] &&
    a.paddingM[2] === b.paddingM[2] &&
    (a.extentMode !== "manual" ||
      (a.manualSizeM[0] === b.manualSizeM[0] &&
        a.manualSizeM[1] === b.manualSizeM[1] &&
        a.manualSizeM[2] === b.manualSizeM[2] &&
        a.hasManualCenter === b.hasManualCenter &&
        (!a.hasManualCenter ||
          (a.manualCenterM[0] === b.manualCenterM[0] &&
            a.manualCenterM[1] === b.manualCenterM[1] &&
            a.manualCenterM[2] === b.manualCenterM[2]))))
  );
}
