import type { JsonObject } from "@/kernel/api/apiTypes";
import { AIRBOX_GRADING_MODES, type AirboxMeshPolicyLane } from "../../panels/airbox/airboxMeshPolicyDraft";
import {
  asNumber,
  asString,
  asTuple3,
  type JsonRecord,
} from "../../panels/airbox/airboxSpecShared";
import { FEM_ONLY_POLICY_KEYS } from "./universeShared";

// ============================================================================
// 3.2 airbox.mesh.parameters — AirboxMeshParametersInspectorSpecPanel
// ============================================================================

export interface AirboxMeshParamsDraft {
  extentMode: "auto" | "manual";
  hasPadding: boolean;
  paddingM: readonly [number, number, number];
  manualSizeM: readonly [number, number, number];
  hasManualCenter: boolean;
  manualCenterM: readonly [number, number, number];
  hasAirboxHmax: boolean;
  airboxHmaxM: number;
  hasAirboxHmin: boolean;
  airboxHminM: number;
  gradingChoice: "default" | "auto" | "geometric" | "linear";
  hasGrowthRate: boolean;
  growthRate: number;
  hasCurvatureFactor: boolean;
  curvatureFactor: number;
  hasNarrowGapResolution: boolean;
  narrowGapResolution: number;
}

export function paramsDraftFromConfig(
  config: JsonRecord | null | undefined,
  effective: JsonRecord | null | undefined,
): AirboxMeshParamsDraft {
  const cfg = config ?? {};
  const eff = effective ?? {};
  const rawMode = asString(cfg.mode) ?? asString(eff.mode) ?? "auto";
  const extentMode: "auto" | "manual" = rawMode === "manual" ? "manual" : "auto";

  const authoredPad = asTuple3(cfg.padding);
  const effPad = asTuple3(eff.padding) ?? [8e-8, 8e-8, 1.2e-7];
  const authoredSize = asTuple3(cfg.size);
  const effSize = asTuple3(eff.size) ?? [1.6e-6, 8e-7, 2.4e-7];
  const authoredCenter = asTuple3(cfg.center);
  const effCenter = asTuple3(eff.center) ?? [0, 0, 0];

  const authoredHmax =
    asNumber(cfg.airbox_hmax) ?? asNumber(cfg.maximum_element_size);
  const effHmax =
    asNumber(eff.airbox_hmax) ?? asNumber(eff.maximum_element_size) ?? 4e-8;

  const authoredHmin =
    asNumber(cfg.airbox_hmin) ?? asNumber(cfg.minimum_element_size);
  const effHmin =
    asNumber(eff.airbox_hmin) ?? asNumber(eff.minimum_element_size) ?? 5e-9;

  const hasGrading = Object.prototype.hasOwnProperty.call(cfg, "airbox_grading");
  const rawGrading = asString(cfg.airbox_grading);
  const gradingChoice: AirboxMeshParamsDraft["gradingChoice"] =
    hasGrading &&
    rawGrading &&
    (AIRBOX_GRADING_MODES as readonly string[]).includes(rawGrading)
      ? (rawGrading as "auto" | "geometric" | "linear")
      : "default";

  const authoredGrowth = asNumber(cfg.airbox_growth_rate);
  const effGrowth = asNumber(eff.airbox_growth_rate) ?? 1.3;

  const authoredCurvature =
    asNumber(cfg.airbox_curvature_factor) ?? asNumber(cfg.curvature_factor);
  const effCurvature =
    asNumber(eff.airbox_curvature_factor) ?? asNumber(eff.curvature_factor) ?? 0.3;

  const authoredNarrow =
    asNumber(cfg.airbox_narrow_region_resolution) ??
    asNumber(cfg.narrow_region_resolution);
  const effNarrow =
    asNumber(eff.airbox_narrow_region_resolution) ??
    asNumber(eff.narrow_region_resolution) ??
    2;

  return {
    airboxHmaxM: authoredHmax ?? effHmax,
    airboxHminM: authoredHmin ?? effHmin,
    curvatureFactor: authoredCurvature ?? effCurvature,
    extentMode,
    gradingChoice,
    growthRate: authoredGrowth ?? effGrowth,
    hasAirboxHmax: authoredHmax !== null,
    hasAirboxHmin: authoredHmin !== null,
    hasCurvatureFactor: authoredCurvature !== null,
    hasGrowthRate: authoredGrowth !== null,
    hasManualCenter: authoredCenter !== null,
    hasNarrowGapResolution: authoredNarrow !== null,
    hasPadding: authoredPad !== null,
    manualCenterM: authoredCenter ?? effCenter,
    manualSizeM: authoredSize ?? effSize,
    narrowGapResolution: authoredNarrow ?? effNarrow,
    paddingM: authoredPad ?? effPad,
  };
}

export function buildCanonicalPolicyConfigFromParamsDraft(
  draft: AirboxMeshParamsDraft,
  existingConfig: JsonRecord | null | undefined,
  lane: AirboxMeshPolicyLane,
): JsonObject {
  const next: Record<string, unknown> = {
    ...(existingConfig ?? {}),
    mode: draft.extentMode,
  };

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
    delete next.size;
    delete next.center;
  }

  if (lane === "fdm") {
    for (const key of FEM_ONLY_POLICY_KEYS) {
      delete next[key];
    }
    return next as JsonObject;
  }

  // Canonical FEM keys (clean up legacy aliases so wire state never contradicts)
  delete next.maximum_element_size;
  delete next.minimum_element_size;
  delete next.curvature_factor;
  delete next.narrow_region_resolution;

  if (draft.hasAirboxHmax) {
    next.airbox_hmax = draft.airboxHmaxM;
  } else {
    delete next.airbox_hmax;
  }

  if (draft.hasAirboxHmin) {
    next.airbox_hmin = draft.airboxHminM;
  } else {
    delete next.airbox_hmin;
  }

  if (draft.gradingChoice !== "default") {
    next.airbox_grading = draft.gradingChoice;
  } else {
    delete next.airbox_grading;
  }

  if (draft.hasGrowthRate) {
    next.airbox_growth_rate = draft.growthRate;
  } else {
    delete next.airbox_growth_rate;
  }

  if (draft.hasCurvatureFactor) {
    next.airbox_curvature_factor = draft.curvatureFactor;
  } else {
    delete next.airbox_curvature_factor;
  }

  if (draft.hasNarrowGapResolution) {
    next.airbox_narrow_region_resolution = draft.narrowGapResolution;
  } else {
    delete next.airbox_narrow_region_resolution;
  }

  return next as JsonObject;
}
