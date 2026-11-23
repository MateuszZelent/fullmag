"use client";

import {
  Activity,
  AlertTriangle,
  Box,
  Layers,
  Ruler,
} from "lucide-react";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import type { useKernel } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";
import type { InspectorSectionSpec } from "../../template";
import type { AirboxMeshPolicyLane } from "../../panels/airbox/airboxMeshPolicyDraft";
import {
  LENGTH_UNITS,
  type useSafeGeometryDiagnosticsResource,
} from "../../panels/airbox/airboxSpecShared";
import type { AirboxMeshParamsDraft } from "./airboxMeshParamsDraft";

type OutsideUniverseDiagnostic = NonNullable<
  ReturnType<typeof useSafeGeometryDiagnosticsResource>["data"]
>["diagnostics"][number];

export interface AirboxEffectivePolicyEntry {
  id: string;
  key: string;
  value: string;
}

export interface BuildAirboxMeshSizingSectionsArgs {
  effectiveEntries: AirboxEffectivePolicyEntry[];
  effectiveLane: AirboxMeshPolicyLane;
  expandDraftToFitObjects: (
    draft: AirboxMeshParamsDraft,
    patchDraft: (partial: Partial<AirboxMeshParamsDraft>) => void,
  ) => void;
  kernel: ReturnType<typeof useKernel>;
  loadEffectiveDefaultsIntoDraft: (
    patchDraft: (partial: Partial<AirboxMeshParamsDraft>) => void,
  ) => void;
  onResetDraftToSaved: () => void;
  outsideUniverseDiagnostics: OutsideUniverseDiagnostic[];
}

export function buildAirboxMeshSizingSections({
  effectiveEntries,
  effectiveLane,
  expandDraftToFitObjects,
  kernel,
  loadEffectiveDefaultsIntoDraft,
  onResetDraftToSaved,
  outsideUniverseDiagnostics,
}: BuildAirboxMeshSizingSectionsArgs): InspectorSectionSpec<AirboxMeshParamsDraft>[] {
  return [
    {
      defaultOpen: true,
      footer: (ctx) => (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => loadEffectiveDefaultsIntoDraft(ctx.patchDraft)}
          >
            Load Effective Defaults
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              ctx.patchDraft(ctx.baseline);
              onResetDraftToSaved();
            }}
          >
            Reset Draft to Saved
          </Button>
        </div>
      ),
      icon: Ruler,
      id: "exterior-sizing",
      rows: [
        {
          key: "hasAirboxHmax",
          label: "Specify far-field max element size",
          structural: true,
          type: "switch",
        },
        {
          defaultDisplayUnit: "nm",
          key: "airboxHmaxM",
          label: "Max exterior element size",
          min: 1e-12,
          minExclusive: true,
          scrub: "log",
          showWhen: (d) => d.hasAirboxHmax,
          symbol: (
            <>
              h<sub>max,air</sub>
            </>
          ),
          type: "quantity",
          units: LENGTH_UNITS,
          validate: (val, d) =>
            d.hasAirboxHmin && val < d.airboxHminM
              ? "Exterior h_max must be >= interface h_min."
              : null,
        },
        {
          key: "hasAirboxHmin",
          label: "Specify interface min element size",
          structural: true,
          type: "switch",
        },
        {
          defaultDisplayUnit: "nm",
          key: "airboxHminM",
          label: "Min interface element size",
          min: 1e-12,
          minExclusive: true,
          scrub: "log",
          showWhen: (d) => d.hasAirboxHmin,
          symbol: (
            <>
              h<sub>min,air</sub>
            </>
          ),
          type: "quantity",
          units: LENGTH_UNITS,
        },
        {
          key: "gradingChoice",
          label: "Exterior element grading",
          options: [
            { label: "Default", value: "default" },
            { label: "Auto", value: "auto" },
            { label: "Geometric", value: "geometric" },
            { label: "Linear", value: "linear" },
          ],
          type: "segmented",
        },
        {
          key: "hasGrowthRate",
          label: "Specify exterior growth rate",
          structural: true,
          type: "switch",
        },
        {
          key: "growthRate",
          label: "Exterior growth rate",
          max: 10,
          min: 1.01,
          showWhen: (d) => d.hasGrowthRate,
          step: 0.05,
          symbol: (
            <>
              g<sub>air</sub>
            </>
          ),
          type: "number",
        },
      ],
      showWhen: () => effectiveLane === "fem",
      title: "Exterior element sizing & grading",
    },
    {
      defaultOpen: true,
      icon: Activity,
      id: "curvature-narrow-gaps",
      rows: [
        {
          key: "hasCurvatureFactor",
          label: "Enable curved-surface air refinement",
          structural: true,
          type: "switch",
        },
        {
          key: "curvatureFactor",
          label: "Airbox curvature factor",
          max: 10,
          min: 0.01,
          showWhen: (d) => d.hasCurvatureFactor,
          step: 0.05,
          symbol: (
            <>
              &kappa;<sub>air</sub>
            </>
          ),
          type: "number",
          validate: (_val, d) =>
            d.hasCurvatureFactor && !d.hasAirboxHmax
              ? "Curvature factor requires specifying Max exterior element size (h_max,air)."
              : null,
        },
        {
          key: "hasNarrowGapResolution",
          label: "Enable narrow-region air-gap refinement",
          structural: true,
          type: "switch",
        },
        {
          hint: "Target number of elements resolved across narrow air gaps between bodies.",
          key: "narrowGapResolution",
          label: "Elements across narrow air gaps",
          max: 32,
          min: 0.1,
          showWhen: (d) => d.hasNarrowGapResolution,
          step: 0.5,
          symbol: (
            <>
              n<sub>gap</sub>
            </>
          ),
          type: "number",
          validate: (_val, d) =>
            d.hasNarrowGapResolution && !d.hasAirboxHmax
              ? "Narrow-region resolution requires specifying Max exterior element size (h_max,air)."
              : null,
        },
      ],
      showWhen: () => effectiveLane === "fem",
      title: "Curvature & narrow air-gap resolution",
    },
    {
      defaultOpen: effectiveLane === "fdm",
      icon: Box,
      id: "universe-geometry-policy",
      rows: [
        {
          key: "extentMode",
          label: "Domain extent mode",
          options: [
            { label: "Auto Padding", value: "auto" },
            { label: "Manual Box", value: "manual" },
          ],
          structural: true,
          type: "segmented",
        },
        {
          key: "hasPadding",
          label: "Author explicit padding vector",
          structural: true,
          type: "switch",
        },
        {
          defaultDisplayUnit: "nm",
          key: "paddingM",
          label: "Padding (X, Y, Z)",
          showWhen: (d) => d.hasPadding,
          symbol: <>d</>,
          type: "vector3",
          units: LENGTH_UNITS,
          validate: (vec) =>
            vec.some((v) => !Number.isFinite(v) || v < 0)
              ? "Padding components must be finite and >= 0."
              : null,
        },
        {
          defaultDisplayUnit: "nm",
          key: "manualSizeM",
          label: "Manual box size (X, Y, Z)",
          showWhen: (d) => d.extentMode === "manual",
          symbol: <>L</>,
          type: "vector3",
          units: LENGTH_UNITS,
          validate: (vec, d) =>
            d.extentMode === "manual" &&
            vec.some((v) => !Number.isFinite(v) || v <= 0)
              ? "Manual size components must be greater than 0."
              : null,
        },
        {
          key: "hasManualCenter",
          label: "Specify manual box center",
          showWhen: (d) => d.extentMode === "manual",
          structural: true,
          type: "switch",
        },
        {
          defaultDisplayUnit: "nm",
          key: "manualCenterM",
          label: "Manual box center (X, Y, Z)",
          showWhen: (d) => d.extentMode === "manual" && d.hasManualCenter,
          symbol: (
            <>
              r<sub>0</sub>
            </>
          ),
          type: "vector3",
          units: LENGTH_UNITS,
        },
      ],
      title:
        effectiveLane === "fdm"
          ? "Structured-grid universe geometry"
          : "Universe extent geometry",
    },
    {
      defaultOpen: true,
      icon: AlertTriangle,
      id: "outside-universe-recovery",
      rows: [
        {
          render: (ctx) => (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() =>
                  expandDraftToFitObjects(ctx.draft, ctx.patchDraft)
                }
              >
                Expand Padding to Fit Objects
              </Button>
              {ctx.draft.extentMode === "manual" ? (
                <Button
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={() => ctx.setField("extentMode", "auto")}
                >
                  Switch Extent Mode to Auto Padding
                </Button>
              ) : null}
              {ctx.draft.extentMode === "manual" ? (
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => ctx.focusField("manualSizeM")}
                >
                  Adjust manual bounds
                </Button>
              ) : null}
              {outsideUniverseDiagnostics
                .filter((diag) => Boolean(diag.object_id))
                .map((diag) => (
                  <Button
                    key={diag.id}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      ctx.selectNode({
                        kind: "object.root",
                        label: diag.object_id!,
                        nodeId: `model:object:${diag.object_id!}`,
                        objectId: diag.object_id!,
                        ref: {
                          kind: "object.root",
                          nodeId: `model:object:${diag.object_id!}`,
                          objectId: diag.object_id!,
                          type: "scene-object",
                          visualizationTargetId:
                            visualizationTargetIdForSceneObject(
                              diag.object_id!,
                              null,
                            ),
                        },
                      })
                    }
                  >
                    Select object to adjust placement
                  </Button>
                ))}
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() =>
                  kernel.layout?.openBottomPanel?.("diagnostics")
                }
              >
                Open diagnostics
              </Button>
            </div>
          ),
          type: "custom",
          wide: true,
        },
      ],
      showWhen: () => outsideUniverseDiagnostics.length > 0,
      title: "Bounds diagnostics & recovery",
    },
    {
      defaultOpen: false,
      icon: Layers,
      id: "backend-effective-values",
      rows: [
        {
          columns: [
            {
              header: "Policy key",
              id: "k",
              mono: true,
              renderCell: (r) => (r as AirboxEffectivePolicyEntry).key,
            },
            {
              align: "right",
              header: "Backend-effective value",
              id: "v",
              mono: true,
              renderCell: (r) => (r as AirboxEffectivePolicyEntry).value,
            },
          ],
          label: "Backend-effective Values",
          rowKey: (r) => (r as AirboxEffectivePolicyEntry).id,
          rows: () => effectiveEntries,
          type: "table",
          wide: true,
        },
      ],
      title: "Backend-effective Values",
    },
  ];
}
