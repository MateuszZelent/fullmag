"use client";

import {
  AlertTriangle,
  Box,
  Compass,
  Eye,
  Grid3x3,
  Ruler,
} from "lucide-react";
import type { InspectorSectionSpec } from "../../template";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";
import type { AirboxMeshPolicyLane } from "../../panels/airbox/airboxMeshPolicyDraft";
import {
  aggregateAirboxBounds,
  type findAirboxParts,
  type findCanonicalAirboxPart,
} from "../../panels/airbox/airboxMeshInspectorModel";
import {
  formatLengthSmart,
  formatTupleSmart,
  LENGTH_UNITS,
  sanitizeStatusText,
  type useSafeAirboxTargetVisualization,
  type useSafeFdmRegionMembershipResource,
  type useSafeGeometryDiagnosticsResource,
} from "../../panels/airbox/airboxSpecShared";
import type { resolveFdmUniverseExtentModel } from "../../panels/airbox/fdmUniverseExtentModel";
import type { buildUniverseDomainPolicyPresentation } from "@/shared/domain/mesh/domainPresentation";
import type { useDomainMetaResource } from "@/kernel/resources/geometryLifecycleResources";
import type { useKernel } from "@/kernel/KernelContext";
import type { AirboxRootDraft } from "./universeShared";

type OutsideUniverseDiagnostic = NonNullable<
  ReturnType<typeof useSafeGeometryDiagnosticsResource>["data"]
>["diagnostics"][number];

type RegionLegendItem = NonNullable<
  ReturnType<typeof useSafeFdmRegionMembershipResource>["data"]
>["region_legend"][number];

export interface BuildAirboxRootSpecSectionsArgs {
  airboxParts: ReturnType<typeof findAirboxParts>;
  carrier: ReturnType<typeof findCanonicalAirboxPart>;
  domainMeta: ReturnType<typeof useDomainMetaResource>;
  domainPolicyPresentation: ReturnType<
    typeof buildUniverseDomainPolicyPresentation
  >;
  effectiveLane: AirboxMeshPolicyLane;
  expandPaddingToFitObjects: (
    draft: AirboxRootDraft,
    patchDraft: (partial: Partial<AirboxRootDraft>) => void,
  ) => void;
  fdmExtentModel: ReturnType<typeof resolveFdmUniverseExtentModel>;
  fdmMembership: ReturnType<typeof useSafeFdmRegionMembershipResource>;
  fdmShape: readonly number[] | undefined;
  fdmSpacing: readonly number[] | undefined;
  kernel: ReturnType<typeof useKernel>;
  outsideUniverseDiagnostics: OutsideUniverseDiagnostic[];
  regionLegend: RegionLegendItem[];
  viz: ReturnType<typeof useSafeAirboxTargetVisualization>;
}

export function buildAirboxRootSpecSections({
  airboxParts,
  carrier,
  domainMeta,
  domainPolicyPresentation,
  effectiveLane,
  expandPaddingToFitObjects,
  fdmExtentModel,
  fdmMembership,
  fdmShape,
  fdmSpacing,
  kernel,
  outsideUniverseDiagnostics,
  regionLegend,
  viz,
}: BuildAirboxRootSpecSectionsArgs): InspectorSectionSpec<AirboxRootDraft>[] {
  return [
    {
      defaultOpen: true,
      icon: Box,
      id: "extent",
      rows: [
        {
          key: "extentMode",
          label: "Extent mode",
          options: [
            { label: "Auto Padding", value: "auto" },
            { label: "Manual Box", value: "manual" },
          ],
          structural: true,
          type: "segmented",
        },
        {
          key: "hasPadding",
          label: "Author explicit exterior padding",
          structural: true,
          type: "switch",
        },
        {
          defaultDisplayUnit: "nm",
          key: "paddingM",
          label: "Exterior padding (X, Y, Z)",
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
              ? "Manual box size components must be greater than 0."
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
      title: "Exterior extent & padding",
    },
    {
      defaultOpen: true,
      icon: AlertTriangle,
      id: "bounds-diagnostics-recovery",
      rows: [
        ...(outsideUniverseDiagnostics.length > 0
          ? outsideUniverseDiagnostics.map((diag) => ({
              format: () =>
                `${diag.code} (${diag.severity})${diag.blocks?.length ? ` · blocks ${diag.blocks.join(", ")}` : ""}`,
              label: diag.object_id
                ? `Outside object (${diag.object_id})`
                : "Bounds diagnostic",
              mono: true,
              type: "readonly" as const,
            }))
          : [
              {
                format: () =>
                  "No GEOMETRY_OBJECT_OUTSIDE_UNIVERSE diagnostics reported on committed scene",
                label: "Geometry containment",
                type: "readonly" as const,
              },
            ]),
        {
          render: (ctx) => (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() =>
                  expandPaddingToFitObjects(ctx.draft, ctx.patchDraft)
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
      showWhen: (d) =>
        outsideUniverseDiagnostics.length > 0 || d.extentMode === "manual",
      title: "Geometry bounds diagnostics & recovery",
    },
    {
      defaultOpen: true,
      icon: Compass,
      id: "boundary-conditions",
      rows: [
        {
          key: "demagFormulation",
          label:
            effectiveLane === "fdm"
              ? "FDM demag realization"
              : "Far-field / exterior demag formulation",
          options:
            effectiveLane === "fdm"
              ? [
                  { label: "Auto (planner-selected)", value: "auto" },
                  {
                    label: "Single-grid zero-padded FFT",
                    value: "single_grid",
                  },
                  {
                    label: "Multilayer dipole convolution",
                    value: "multilayer_convolution",
                  },
                ]
              : [
                  { label: "Auto (planner-selected)", value: "auto" },
                  {
                    label: "Poisson Robin Airbox (1/r decay)",
                    value: "poisson_robin",
                  },
                  {
                    label: "Poisson Dirichlet Airbox (φ = 0)",
                    value: "poisson_dirichlet",
                  },
                  {
                    label: "Fredkin-Koehler Hybrid FEM/BEM",
                    value: "fredkin_koehler",
                  },
                  { label: "Boundary Element (BEM)", value: "bem" },
                  { label: "Fast Multipole (FMM)", value: "fmm" },
                ],
          type: "select",
        },
        {
          key: "periodicAxes",
          label: "Periodic boundary axes (PBC)",
          options: [
            { label: "X (±X)", value: "x" },
            { label: "Y (±Y)", value: "y" },
            { label: "Z (±Z)", value: "z" },
          ],
          structural: true,
          type: "toggles",
        },
        {
          key: "pbcDemag",
          label: "Periodic demag kernel",
          options: [
            { label: "Open demag", value: "open" },
            { label: "Truncated periodic images", value: "truncated_images" },
            { label: "Periodic Airbox k = 0", value: "periodic_airbox_k0" },
          ],
          showWhen: (d) => d.periodicAxes.length > 0,
          structural: true,
          type: "select",
        },
        {
          integer: true,
          key: "periodicImagesX",
          label: "Periodic image repeats (X)",
          max: 64,
          min: 0,
          showWhen: (d) =>
            d.periodicAxes.length > 0 && d.pbcDemag === "truncated_images",
          type: "number",
        },
        {
          integer: true,
          key: "periodicImagesY",
          label: "Periodic image repeats (Y)",
          max: 64,
          min: 0,
          showWhen: (d) =>
            d.periodicAxes.length > 0 && d.pbcDemag === "truncated_images",
          type: "number",
        },
        {
          integer: true,
          key: "periodicImagesZ",
          label: "Periodic image repeats (Z)",
          max: 64,
          min: 0,
          showWhen: (d) =>
            d.periodicAxes.length > 0 && d.pbcDemag === "truncated_images",
          type: "number",
        },
      ],
      title: "Outer boundary & far-field formulation",
    },
    {
      defaultOpen: false,
      footer: () =>
        viz.hasOverrides ? (
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => viz.resetAirboxVisualization()}
          >
            Reset Airbox 3D Display
          </Button>
        ) : null,
      icon: Eye,
      id: "live-3d-display",
      live: true,
      rows: [
        {
          key: "airboxVisible",
          label: "Show Airbox in 3D viewport",
          type: "switch",
        },
        {
          key: "boundsVisible",
          label: "Show Airbox bounding box",
          type: "switch",
        },
        {
          key: "wireframeVisible",
          label: "Show Airbox mesh wireframe",
          type: "switch",
        },
      ],
      title: "3D Airbox display",
    },
    {
      defaultOpen: true,
      icon: Grid3x3,
      id: "fdm-grid-link",
      rows: [
        {
          format: () =>
            fdmExtentModel.universeRole
              ? "Airbox outside magnetic support"
              : "Structured universe carrier",
          label: "Airbox role",
          type: "readonly",
        },
        {
          format: () => (fdmShape ? fdmShape.join(" × ") : "—"),
          label: "Universe grid shape",
          symbol: <>N</>,
          type: "readonly",
        },
        {
          format: () =>
            fdmExtentModel.totalCells !== null
              ? fdmExtentModel.totalCells.toLocaleString("en-US")
              : "—",
          label: "Total grid cells",
          type: "readonly",
        },
        {
          format: () =>
            fdmSpacing
              ? `${formatLengthSmart(fdmSpacing[0])} × ${formatLengthSmart(fdmSpacing[1])} × ${formatLengthSmart(fdmSpacing[2])}`
              : "—",
          label: "Voxel spacing",
          symbol: <>&Delta;</>,
          type: "readonly",
        },
        {
          format: () =>
            fdmMembership.data
              ? "Published with structured grid"
              : "Not materialized",
          label: "Membership mask",
          type: "readonly",
        },
        ...(regionLegend.length > 0
          ? [
              {
                columns: [
                  {
                    header: "Owner",
                    id: "owner",
                    mono: true,
                    renderCell: (r: unknown) =>
                      (r as RegionLegendItem).object_id,
                  },
                  {
                    header: "Region",
                    id: "reg",
                    mono: true,
                    renderCell: (r: unknown) =>
                      (r as RegionLegendItem).region_id,
                  },
                  {
                    align: "right" as const,
                    header: "ID / Priority",
                    id: "num",
                    mono: true,
                    renderCell: (r: unknown) => {
                      const item = r as RegionLegendItem;
                      return `#${item.numeric_id} (p=${item.priority})`;
                    },
                  },
                ],
                label: "Magnetic support owners & regions",
                rowKey: (r: unknown) => {
                  const item = r as RegionLegendItem;
                  return `${item.numeric_id}:${item.object_id}:${item.region_id}`;
                },
                rows: () => regionLegend,
                type: "table" as const,
                wide: true,
              },
            ]
          : []),
      ],
      showWhen: () => effectiveLane === "fdm",
      title: "FDM structured universe summary",
    },
    {
      defaultOpen: false,
      icon: Ruler,
      id: "domain-provenance-links",
      rows: [
        {
          format: () => {
            const b = domainMeta.data?.bounds;
            if (b) {
              return `${formatTupleSmart(b.min)} .. ${formatTupleSmart(b.max)}`;
            }
            const mb = aggregateAirboxBounds(airboxParts);
            if (mb) {
              return `${formatTupleSmart(mb.min)} .. ${formatTupleSmart(mb.max)}`;
            }
            return "Resolved after geometry realization";
          },
          label: "World AABB bounds",
          type: "readonly",
        },
        {
          format: () =>
            sanitizeStatusText(
              domainPolicyPresentation.realization.detail,
              "Pending realization",
            ),
          label: "Realization status",
          type: "readonly",
        },
        ...(effectiveLane === "fem"
          ? [
              {
                copyText: () => carrier?.id ?? null,
                format: () => carrier?.id ?? "Not built",
                label: "Mesh carrier",
                mono: true,
                type: "readonly" as const,
              },
            ]
          : []),
        {
          items: () => [
            ...(effectiveLane === "fem"
              ? [
                  {
                    id: "mesh-params",
                    jumpSelection: {
                      kind: "airbox.mesh.parameters",
                      label: "Mesh Parameters",
                      nodeId: "model:airbox:mesh:parameters",
                      objectId: null,
                      ref: null,
                    },
                    label: "Mesh Parameters",
                  },
                  {
                    id: "mesh-build",
                    jumpSelection: {
                      kind: "airbox.mesh.build",
                      label: "Mesh Build",
                      nodeId: "model:airbox:mesh:build",
                      objectId: null,
                      ref: null,
                    },
                    label: "Mesh Build",
                  },
                ]
              : []),
            {
              id: "viz",
              jumpSelection: {
                kind: "airbox.visualization",
                label: "Visualization",
                nodeId: "model:airbox:visualization",
                objectId: null,
                ref: null,
              },
              label: "Visualization",
            },
            {
              id: "bfaces",
              jumpSelection: {
                kind: "boundary-faces.root",
                label: "Boundary Faces",
                nodeId: "model:boundary-faces",
                objectId: null,
                ref: null,
              },
              label: "Boundary Faces",
            },
          ],
          label: "Related views",
          type: "chips",
        },
      ],
      title: "Resolved world bounds & navigation",
    },
  ];
}
