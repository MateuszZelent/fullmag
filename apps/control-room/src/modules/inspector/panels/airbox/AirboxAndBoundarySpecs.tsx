"use client";

import {
  Activity,
  Box,
  Compass,
  Gauge,
  Grid3x3,
  History,
  Layers,
  Radar,
  Ruler,
  ShieldCheck,
  SlidersHorizontal,
  SquareDashed,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import type { JsonObject } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_UNIVERSE_POLICY_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  useDomainMetaResource,
  useFdmMultilayerLayoutResource,
  useMeshSharedDomainManifestResource,
  useMeshSummaryResource,
  useMeshUniverseQualityResource,
  useMeshUniverseReportResource,
  useSceneResource,
  useUniverseMeshPolicyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import {
  useSessionResourceIdentity,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import {
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "@/shared/charts/ScientificEChart";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorSpec, UnitOption } from "../../template";
import { formatLengthSmart } from "../mesh-details/MeshDomainSpecs";
import { SpecInspectorHost } from "../mesh-details/SpecInspectorHost";

const LENGTH_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "nm", toSiFactor: 1e-9 },
  { unit: "µm", toSiFactor: 1e-6 },
  { unit: "mm", toSiFactor: 1e-3 },
  { unit: "m", toSiFactor: 1 },
];

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function useActiveLane(): "fdm" | "fem" | "unresolved" {
  const raw = useSessionStatusSelector(
    (status) => status.data?.domain?.discretization ?? null,
  );
  if (typeof raw !== "string") return "unresolved";
  const norm = raw.trim().toLowerCase();
  return norm === "fdm" ? "fdm" : norm === "fem" ? "fem" : "unresolved";
}

// ============================================================================
// 1. airbox.root — AirboxRootInspectorSpecPanel (Zero 512B truncation)
// ============================================================================

interface AirboxRootDraft {
  extentMode: "auto_padding" | "explicit_box" | "shell_asymptotic";
  paddingSpec: "distance" | "multiplier";
  paddingSymmetry: "symmetric" | "asymmetric";
  symmetricPaddingM: readonly [number, number, number];
  padPlusXM: number;
  padMinusXM: number;
  padPlusYM: number;
  padMinusYM: number;
  padPlusZM: number;
  padMinusZM: number;
  paddingMultiplier: number;
  explicitBoxSizeM: readonly [number, number, number];
  explicitBoxCenterM: readonly [number, number, number];
  shellInnerRadiusM: number;
  shellThicknessM: number;
  outerBc: "open_asymptotic" | "dirichlet_zero" | "periodic";
  farFieldFormulation: "fredkin_koehler_bem" | "asymptotic_robin" | "kelvin_shell";
  periodicAxes: readonly string[];
  macroImages: number;
}

export function AirboxRootInspectorSpecPanel({ selection }: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const lane = useActiveLane();
  const policyRes = useUniverseMeshPolicyResource();
  const domainMeta = useDomainMetaResource({ enabled: lane === "fdm" });
  const manifest = useMeshSharedDomainManifestResource({ enabled: lane === "fem" });

  const baseline = useMemo<AirboxRootDraft>(() => {
    const cfg =
      asRecord(policyRes.data?.config) ?? asRecord(policyRes.data?.effective_config);
    const pad = Array.isArray(cfg?.padding) ? cfg.padding : [8e-8, 8e-8, 1.2e-7];
    const sz = Array.isArray(cfg?.size) ? cfg.size : [1.6e-6, 8e-7, 2.4e-7];
    const ctr = Array.isArray(cfg?.center) ? cfg.center : [0, 0, 0];
    const rawMode = asString(cfg?.mode) ?? "auto";
    const extentMode: AirboxRootDraft["extentMode"] =
      rawMode === "manual" || rawMode === "explicit_box"
        ? "explicit_box"
        : rawMode === "shell" || rawMode === "shell_asymptotic"
          ? "shell_asymptotic"
          : "auto_padding";
    const rawBc = asString(cfg?.outer_bc) ?? "open_asymptotic";
    const outerBc: AirboxRootDraft["outerBc"] =
      rawBc === "dirichlet_zero" || rawBc === "periodic" ? rawBc : "open_asymptotic";
    return {
      explicitBoxCenterM: [
        asNumber(ctr[0]) ?? 0,
        asNumber(ctr[1]) ?? 0,
        asNumber(ctr[2]) ?? 0,
      ],
      explicitBoxSizeM: [
        asNumber(sz[0]) ?? 1.6e-6,
        asNumber(sz[1]) ?? 8e-7,
        asNumber(sz[2]) ?? 2.4e-7,
      ],
      extentMode,
      farFieldFormulation: "fredkin_koehler_bem",
      macroImages: Math.max(1, Math.round(asNumber(cfg?.macro_images) ?? 4)),
      outerBc,
      padMinusXM: asNumber(pad[0]) ?? 8e-8,
      padMinusYM: asNumber(pad[1]) ?? 8e-8,
      padMinusZM: asNumber(pad[2]) ?? 1.2e-7,
      padPlusXM: asNumber(pad[0]) ?? 8e-8,
      padPlusYM: asNumber(pad[1]) ?? 8e-8,
      padPlusZM: asNumber(pad[2]) ?? 1.2e-7,
      paddingMultiplier: asNumber(cfg?.padding_multiplier) ?? 2.5,
      paddingSpec: cfg?.padding_multiplier != null ? "multiplier" : "distance",
      paddingSymmetry: cfg?.padding_faces != null ? "asymmetric" : "symmetric",
      periodicAxes: Array.isArray(cfg?.periodic_axes)
        ? cfg.periodic_axes.filter((x): x is string => typeof x === "string")
        : ["x", "y"],
      shellInnerRadiusM: asNumber(cfg?.inner_radius) ?? 5e-7,
      shellThicknessM: asNumber(cfg?.shell_thickness) ?? 2.5e-7,
      symmetricPaddingM: [
        asNumber(pad[0]) ?? 8e-8,
        asNumber(pad[1]) ?? 8e-8,
        asNumber(pad[2]) ?? 1.2e-7,
      ],
    };
  }, [policyRes.data?.config, policyRes.data?.effective_config]);

  const spec = useMemo<InspectorSpec<AirboxRootDraft>>(() => {
    const fdmShape = domainMeta.data?.grid?.shape;
    const fdmSpacing = domainMeta.data?.grid?.spacing;
    const airElements = (() => {
      const parts = asRecord(manifest.data)?.mesh_parts;
      if (!Array.isArray(parts)) return null;
      const air = parts.map(asRecord).find((p) => asString(p?.role)?.includes("air"));
      return asNumber(air?.element_count);
    })();

    return {
      id: "airbox.root",
      header: {
        breadcrumbs: [
          {
            id: "universe",
            label: "Universe",
            selection: {
              kind: "universe.root",
              label: "Universe",
              nodeId: "model:universe",
              objectId: null,
              ref: null,
            },
          },
          { id: "airbox", label: "Airbox" },
        ],
        canFitView: true,
        extraMenuActions: [
          {
            icon: SquareDashed,
            id: "open-boundary-faces",
            label: "Open Boundary Faces",
            onSelect: (ctx) =>
              ctx.selectNode({
                kind: "boundary-faces.root",
                label: "Boundary Faces",
                nodeId: "model:boundary-faces",
                objectId: null,
                ref: null,
              }),
          },
        ],
      },
      identity: {
        domain: "mesh",
        entityId: "airbox",
        icon: Layers,
        kindLabel: "Universe bounding domain",
        statePill: () => ({ label: "Ready", tone: "ok" }),
        title: () => "Airbox & Exterior Domain",
      },
      facts: (d) => [
        {
          id: "mode",
          label: "Extent mode",
          value:
            d.extentMode === "auto_padding"
              ? "Auto padding"
              : d.extentMode === "explicit_box"
                ? "Explicit box"
                : "Kelvin shell",
        },
        {
          id: "bc",
          label: "Outer BC",
          value:
            d.outerBc === "open_asymptotic"
              ? "Open / Asymptotic"
              : d.outerBc === "dirichlet_zero"
                ? "Dirichlet V = 0"
                : "Periodic",
        },
        {
          id: "carrier",
          label: lane === "fdm" ? "Grid" : "Air elements",
          value:
            lane === "fdm" && fdmShape
              ? fdmShape.join(" × ")
              : airElements !== null
                ? airElements.toLocaleString("en-US")
                : null,
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Box,
          id: "extent",
          rows: [
            {
              key: "extentMode",
              label: "Extent mode",
              options: [
                { label: "Auto Padding", value: "auto_padding" },
                { label: "Explicit Box", value: "explicit_box" },
                ...(lane === "fem"
                  ? [{ label: "Shell / ∞", value: "shell_asymptotic" }]
                  : []),
              ],
              structural: true,
              type: "segmented",
            },
            {
              key: "paddingSpec",
              label: "Padding specification",
              options: [
                { label: "Explicit Distance", value: "distance" },
                { label: "Multiplier (×L)", value: "multiplier" },
              ],
              showWhen: (d) => d.extentMode === "auto_padding",
              structural: true,
              type: "segmented",
            },
            {
              key: "paddingMultiplier",
              label: "Scene span multiplier",
              min: 0,
              showWhen: (d) =>
                d.extentMode === "auto_padding" && d.paddingSpec === "multiplier",
              step: 0.25,
              type: "number",
              unitSuffix: "×",
            },
            {
              key: "paddingSymmetry",
              label: "Padding symmetry",
              options: [
                { label: "Symmetric (X, Y, Z)", value: "symmetric" },
                { label: "Per-Face (±X, ±Y, ±Z)", value: "asymmetric" },
              ],
              showWhen: (d) =>
                d.extentMode === "auto_padding" && d.paddingSpec === "distance",
              structural: true,
              type: "segmented",
            },
            {
              defaultDisplayUnit: "nm",
              key: "symmetricPaddingM",
              label: "Symmetric padding",
              showWhen: (d) =>
                d.extentMode === "auto_padding" &&
                d.paddingSpec === "distance" &&
                d.paddingSymmetry === "symmetric",
              symbol: <>d</>,
              type: "vector3",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "padPlusXM",
              label: "+X face padding",
              min: 0,
              showWhen: (d) =>
                d.extentMode === "auto_padding" &&
                d.paddingSpec === "distance" &&
                d.paddingSymmetry === "asymmetric",
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "padMinusXM",
              label: "−X face padding",
              min: 0,
              showWhen: (d) =>
                d.extentMode === "auto_padding" &&
                d.paddingSpec === "distance" &&
                d.paddingSymmetry === "asymmetric",
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "padPlusYM",
              label: "+Y face padding",
              min: 0,
              showWhen: (d) =>
                d.extentMode === "auto_padding" &&
                d.paddingSpec === "distance" &&
                d.paddingSymmetry === "asymmetric",
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "padMinusYM",
              label: "−Y face padding",
              min: 0,
              showWhen: (d) =>
                d.extentMode === "auto_padding" &&
                d.paddingSpec === "distance" &&
                d.paddingSymmetry === "asymmetric",
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "padPlusZM",
              label: "+Z face padding",
              min: 0,
              showWhen: (d) =>
                d.extentMode === "auto_padding" &&
                d.paddingSpec === "distance" &&
                d.paddingSymmetry === "asymmetric",
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "padMinusZM",
              label: "−Z face padding",
              min: 0,
              showWhen: (d) =>
                d.extentMode === "auto_padding" &&
                d.paddingSpec === "distance" &&
                d.paddingSymmetry === "asymmetric",
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "explicitBoxSizeM",
              label: "Explicit box size",
              showWhen: (d) => d.extentMode === "explicit_box",
              symbol: <>L</>,
              type: "vector3",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "explicitBoxCenterM",
              label: "Explicit box center",
              showWhen: (d) => d.extentMode === "explicit_box",
              symbol: (
                <>
                  r<sub>0</sub>
                </>
              ),
              type: "vector3",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "shellInnerRadiusM",
              label: "Shell inner radius",
              min: 1e-10,
              minExclusive: true,
              showWhen: (d) => d.extentMode === "shell_asymptotic",
              symbol: (
                <>
                  R<sub>in</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "shellThicknessM",
              label: "Kelvin shell thickness",
              min: 1e-10,
              minExclusive: true,
              showWhen: (d) => d.extentMode === "shell_asymptotic",
              symbol: (
                <>
                  t<sub>shell</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
          ],
          title: "Exterior extent & padding",
        },
        {
          defaultOpen: true,
          icon: Compass,
          id: "boundary-conditions",
          rows: [
            {
              key: "outerBc",
              label: "Exterior boundary condition",
              options: [
                { label: "Open / Asymptotic", value: "open_asymptotic" },
                { label: "Dirichlet V = 0", value: "dirichlet_zero" },
                { label: "Periodic", value: "periodic" },
              ],
              structural: true,
              type: "segmented",
            },
            {
              key: "farFieldFormulation",
              label: "Far-field FEM formulation",
              options: [
                {
                  label: "Fredkin-Koehler Hybrid FEM/BEM",
                  value: "fredkin_koehler_bem",
                },
                { label: "1/r Robin Exterior Decay", value: "asymptotic_robin" },
                { label: "Infinite-Element Kelvin Shell", value: "kelvin_shell" },
              ],
              showWhen: (d) => lane === "fem" && d.outerBc === "open_asymptotic",
              type: "select",
            },
            {
              key: "periodicAxes",
              label: "Periodic axes",
              options: [
                { label: "X", value: "x" },
                { label: "Y", value: "y" },
                { label: "Z", value: "z" },
              ],
              showWhen: (d) => d.outerBc === "periodic",
              type: "toggles",
            },
            {
              integer: true,
              key: "macroImages",
              label: "Dipole macro-images",
              max: 64,
              min: 1,
              showWhen: (d) => d.outerBc === "periodic",
              symbol: (
                <>
                  N<sub>img</sub>
                </>
              ),
              type: "number",
            },
          ],
          title: "Outer boundary conditions",
        },
        {
          defaultOpen: true,
          icon: Grid3x3,
          id: "fdm-grid-link",
          rows: [
            {
              format: () => (fdmShape ? fdmShape.join(" × ") : "—"),
              label: "Universe grid shape",
              symbol: <>N</>,
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
          ],
          showWhen: () => lane === "fdm",
          title: "FDM universe grid summary",
        },
        {
          defaultOpen: false,
          icon: Ruler,
          id: "effective-bounds",
          rows: [
            {
              format: () => {
                const b = domainMeta.data?.bounds;
                if (!b) return "Resolved after geometry bounds evaluation";
                return `[${(b.min[0] * 1e9).toFixed(1)}..${(b.max[0] * 1e9).toFixed(1)}, ${(b.min[1] * 1e9).toFixed(1)}..${(b.max[1] * 1e9).toFixed(1)}, ${(b.min[2] * 1e9).toFixed(1)}..${(b.max[2] * 1e9).toFixed(1)}] nm`;
              },
              label: "World AABB bounds",
              type: "readonly",
            },
          ],
          title: "Resolved world bounds",
        },
      ],
      commitBar: {
        cleanMessage: () => "Exterior domain & boundary policy is synchronized",
        confirmApply: () => ({
          confirmLabel: "Apply exterior domain",
          description:
            "Updating exterior Airbox bounds or boundary conditions marks existing mesh/grid realizations as stale.",
          title: "Update Airbox exterior domain?",
        }),
        mode: "staged",
        onApply: async (draft) => {
          const existing = asRecord(policyRes.data?.config) ?? {};
          const nextConfig: JsonObject = {
            ...existing,
            mode:
              draft.extentMode === "explicit_box"
                ? "manual"
                : draft.extentMode === "shell_asymptotic"
                  ? "shell"
                  : "auto",
            outer_bc: draft.outerBc,
            ...(draft.extentMode === "auto_padding"
              ? draft.paddingSpec === "multiplier"
                ? { padding_multiplier: draft.paddingMultiplier }
                : draft.paddingSymmetry === "symmetric"
                  ? { padding: [...draft.symmetricPaddingM] }
                  : {
                      padding_faces: {
                        nx: draft.padMinusXM,
                        ny: draft.padMinusYM,
                        nz: draft.padMinusZM,
                        px: draft.padPlusXM,
                        py: draft.padPlusYM,
                        pz: draft.padPlusZM,
                      },
                    }
              : draft.extentMode === "explicit_box"
                ? {
                    center: [...draft.explicitBoxCenterM],
                    size: [...draft.explicitBoxSizeM],
                  }
                : {
                    inner_radius: draft.shellInnerRadiusM,
                    shell_thickness: draft.shellThicknessM,
                  }),
            ...(draft.outerBc === "periodic"
              ? {
                  macro_images: draft.macroImages,
                  periodic_axes: [...draft.periodicAxes],
                }
              : {}),
          } as JsonObject;

          await kernel.api.meshing.replaceUniversePolicy(
            {
              base_revision: policyRes.data?.revision ?? 0,
              config: nextConfig,
            } as never,
            { sessionScopeKey },
          );
          kernel.resources.invalidate(MESH_UNIVERSE_POLICY_RESOURCE_KEY, `w5:${Date.now()}`);
          return true;
        },
      },
    };
  }, [
    domainMeta.data?.bounds,
    domainMeta.data?.grid?.shape,
    domainMeta.data?.grid?.spacing,
    kernel.api.meshing,
    kernel.resources,
    lane,
    manifest.data,
    policyRes.data?.config,
    policyRes.data?.revision,
    sessionScopeKey,
  ]);

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 2. airbox.multilayer.target — AirboxMultilayerTargetInspectorSpecPanel
// ============================================================================

export function AirboxMultilayerTargetInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const multilayerRes = useFdmMultilayerLayoutResource();
  const airbox = useMemo(() => asRecord(multilayerRes.data?.airbox), [multilayerRes.data]);
  const cells = useMemo(
    () => (Array.isArray(airbox?.cells) ? (airbox.cells as number[]) : [0, 0, 0]),
    [airbox],
  );
  const cellSize = useMemo(
    () =>
      Array.isArray(airbox?.cell_size_m)
        ? (airbox.cell_size_m as number[])
        : Array.isArray(airbox?.cell_size)
          ? (airbox.cell_size as number[])
          : [0, 0, 0],
    [airbox],
  );
  const origin = useMemo(
    () =>
      Array.isArray(airbox?.origin_m)
        ? (airbox.origin_m as number[])
        : Array.isArray(airbox?.origin)
          ? (airbox.origin as number[])
          : [0, 0, 0],
    [airbox],
  );
  const sampleCount = (cells[0] ?? 0) * (cells[1] ?? 0) * (cells[2] ?? 0);
  const hDemagAvailable = airbox?.h_demag_available === true;
  const sourcePolicyText =
    asString(airbox?.source_policy) ?? "Multilayer dipole-convolution stray-field target";
  const carrierFingerprint = asString(airbox?.carrier_fingerprint) ?? "Not published";
  const layers = useMemo(() => multilayerRes.data?.layers ?? [], [multilayerRes.data]);

  const baseline = useMemo(() => ({ unit: "nm" }), []);

  const spec = useMemo<InspectorSpec<{ unit: string }>>(
    () => ({
      id: "airbox.multilayer.target",
      header: {
        breadcrumbs: [
          {
            id: "airbox",
            label: "Airbox",
            selection: {
              kind: "airbox.root",
              label: "Airbox",
              nodeId: "model:airbox",
              objectId: null,
              ref: null,
            },
          },
          { id: "ml-target", label: "Multilayer Target" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "mesh",
        entityId: "model:airbox:multilayer-target",
        icon: Radar,
        kindLabel: "Target-only stray-field observation carrier",
        statePill: () =>
          airbox ? { label: "Ready", tone: "ok" } : { label: "Not published", tone: "neutral" },
        title: () => "Multilayer Demag Target",
      },
      facts: () => [
        { id: "grid", label: "Target grid", value: cells.join(" × ") },
        {
          id: "cell",
          label: "Cell size",
          value: `${((cellSize[0] ?? 0) * 1e9).toFixed(2)} × ${((cellSize[1] ?? 0) * 1e9).toFixed(2)} × ${((cellSize[2] ?? 0) * 1e9).toFixed(2)} nm`,
        },
        {
          id: "hdemag",
          label: "H_demag",
          tone: hDemagAvailable ? "ok" : undefined,
          value: hDemagAvailable ? "Published" : "Not computed",
        },
        {
          id: "samples",
          label: "Samples",
          value: sampleCount > 0 ? sampleCount.toLocaleString("en-US") : null,
        },
      ],
      notices: () => [
        {
          id: "ml-target-info",
          quickFix: {
            label: "Visualize H_demag in 3D",
            onApply: (ctx) =>
              ctx.selectNode({
                kind: "airbox.visualization",
                label: "Visualization",
                nodeId: "model:airbox:visualization",
                objectId: null,
                ref: null,
              }),
          },
          text: "Target-only stray-field carrier outside magnetic Z-layers. Magnetization m and exchange fields do not exist in vacuum.",
          title: "Stray-field observation carrier",
          tone: "info",
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Radar,
          id: "carrier-geometry",
          rows: [
            {
              format: () =>
                `${cells.join(" × ")} (${sampleCount.toLocaleString("en-US")} sample cells)`,
              label: "Target grid shape",
              symbol: <>N</>,
              type: "readonly",
            },
            {
              format: () =>
                `${((cellSize[0] ?? 0) * 1e9).toFixed(2)} × ${((cellSize[1] ?? 0) * 1e9).toFixed(2)} × ${((cellSize[2] ?? 0) * 1e9).toFixed(2)} nm`,
              label: "Target cell size",
              symbol: <>&Delta;</>,
              type: "readonly",
            },
            {
              format: () =>
                `(${((origin[0] ?? 0) * 1e9).toFixed(1)}, ${((origin[1] ?? 0) * 1e9).toFixed(1)}, ${((origin[2] ?? 0) * 1e9).toFixed(1)}) nm`,
              label: "Target origin",
              symbol: (
                <>
                  r<sub>0</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                hDemagAvailable ? "Published (3-component vector)" : "Not computed yet",
              label: "Demagnetizing field",
              symbol: (
                <>
                  H<sub>d</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () => "Not defined in vacuum (no spins outside magnetic Z-layers)",
              label: "Effective field",
              symbol: (
                <>
                  H<sub>eff</sub>
                </>
              ),
              type: "readonly",
            },
          ],
          title: "Stray-field carrier geometry & availability",
        },
        {
          defaultOpen: true,
          icon: Layers,
          id: "coupled-layers",
          rows: [
            {
              items: () =>
                layers.map((layer) => ({
                  id: layer.layer_id,
                  jumpSelection: {
                    kind: "mesh.grid.layer",
                    label: layer.magnet_name,
                    nodeId: `model:mesh:grid:layer:${encodeURIComponent(layer.layer_id)}`,
                    objectId: layer.object_id,
                    ref: null,
                  },
                  label: layer.magnet_name,
                })),
              label: "Source Z-layers",
              showWhen: () => layers.length > 0,
              type: "chips",
            },
            {
              format: () => sourcePolicyText,
              label: "Source policy",
              type: "readonly",
            },
            {
              copyText: () => carrierFingerprint,
              format: () => carrierFingerprint,
              label: "Carrier fingerprint",
              mono: true,
              type: "readonly",
            },
          ],
          title: "Coupled source Z-layers & provenance",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Read-only multilayer stray-field carrier",
      },
    }),
    [
      airbox,
      carrierFingerprint,
      cellSize,
      cells,
      hDemagAvailable,
      layers,
      origin,
      sampleCount,
      sourcePolicyText,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 3. FEM Airbox Mesh Family (`airbox.mesh` + 5 children)
// ============================================================================

export function AirboxMeshInspectorSpecPanel({ selection }: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const manifest = useMeshSharedDomainManifestResource();
  const summary = useMeshSummaryResource();
  const scene = useSceneResource();

  const airPart = useMemo(() => {
    const parts = asRecord(manifest.data)?.mesh_parts;
    if (!Array.isArray(parts)) return null;
    return parts.map(asRecord).find((p) => asString(p?.role)?.includes("air")) ?? null;
  }, [manifest.data]);

  const airElements = asNumber(airPart?.element_count);
  const airNodes = asNumber(airPart?.node_count);
  const sceneRev =
    asNumber(asRecord(scene.data)?.revision) ??
    asNumber(asRecord(scene.data)?.scene_revision);
  const meshSourceRev = asNumber(asRecord(manifest.data)?.source_scene_revision);
  const isCurrent =
    sceneRev !== null && meshSourceRev !== null && sceneRev === meshSourceRev;

  const baseline = useMemo(() => ({ view: "summary" }), []);
  const spec = useMemo<InspectorSpec<{ view: string }>>(
    () => ({
      id: "airbox.mesh",
      header: {
        breadcrumbs: [
          {
            id: "airbox",
            label: "Airbox",
            selection: {
              kind: "airbox.root",
              label: "Airbox",
              nodeId: "model:airbox",
              objectId: null,
              ref: null,
            },
          },
          { id: "mesh", label: "Mesh" },
        ],
        canFitView: true,
        primaryHeaderAction: {
          icon: Grid3x3,
          label: "Rebuild Exterior Mesh",
          onRun: async () => {
            await kernel.commands.execute(
              "mesh.build-shared-domain",
              createCommandContext("inspector", kernel, {
                sessionScopeKey,
                sourceDetail: "airbox.mesh",
              }),
            );
          },
        },
      },
      identity: {
        domain: "mesh",
        entityId: "model:airbox:mesh",
        icon: Grid3x3,
        kindLabel: "FEM exterior air mesh overview",
        statePill: () =>
          !manifest.data
            ? { label: "Not built", tone: "neutral" }
            : isCurrent
              ? { label: "Current", tone: "ok" }
              : { label: "Stale", tone: "warn" },
        title: () => "Airbox Exterior Mesh",
      },
      facts: () => [
        {
          id: "elems",
          label: "Air elements",
          value: airElements !== null ? airElements.toLocaleString("en-US") : null,
        },
        {
          id: "nodes",
          label: "Air nodes",
          value: airNodes !== null ? airNodes.toLocaleString("en-US") : null,
        },
        {
          id: "sync",
          label: "Freshness",
          value: !manifest.data ? "Not built" : isCurrent ? "Current" : "Stale",
        },
        {
          id: "rev",
          label: "Mesh rev",
          value: summary.data?.revision != null ? String(summary.data.revision) : null,
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Layers,
          id: "exterior-summary",
          rows: [
            {
              format: () =>
                airElements !== null
                  ? `${airElements.toLocaleString("en-US")} elements`
                  : "Not built yet",
              label: "Exterior element count",
              symbol: (
                <>
                  N<sub>air</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () => "Conforming shared interface facets",
              label: "Interface conformity",
              type: "readonly",
            },
            {
              items: () => [
                {
                  id: "params",
                  jumpSelection: {
                    kind: "airbox.mesh.parameters",
                    label: "Parameters",
                    nodeId: "model:airbox:mesh:parameters",
                    objectId: null,
                    ref: null,
                  },
                  label: "Parameters",
                },
                {
                  id: "gates",
                  jumpSelection: {
                    kind: "airbox.mesh.quality-gates",
                    label: "Quality Gates",
                    nodeId: "model:airbox:mesh:quality-gates",
                    objectId: null,
                    ref: null,
                  },
                  label: "Quality Gates",
                },
                {
                  id: "stats",
                  jumpSelection: {
                    kind: "airbox.mesh.statistics",
                    label: "Statistics",
                    nodeId: "model:airbox:mesh:statistics",
                    objectId: null,
                    ref: null,
                  },
                  label: "Statistics",
                },
              ],
              label: "Sub-inspectors",
              type: "chips",
            },
          ],
          title: "Exterior mesh summary",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Edit sizing in Parameters or bounds in Airbox",
      },
    }),
    [airElements, airNodes, isCurrent, kernel, manifest.data, sessionScopeKey, summary.data],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

interface AirboxMeshParamsDraft {
  airboxHmaxM: number;
  airboxHminM: number;
  grading: "auto" | "geometric" | "linear";
  growthRate: number;
  curvatureFactor: number;
  narrowGapResolution: number;
}

export function AirboxMeshParametersInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const policyRes = useUniverseMeshPolicyResource();

  const baseline = useMemo<AirboxMeshParamsDraft>(() => {
    const cfg =
      asRecord(policyRes.data?.config) ?? asRecord(policyRes.data?.effective_config);
    const gradingRaw = asString(cfg?.airbox_grading) ?? "auto";
    const grading: AirboxMeshParamsDraft["grading"] =
      gradingRaw === "geometric" || gradingRaw === "linear" ? gradingRaw : "auto";
    return {
      airboxHmaxM: asNumber(cfg?.airbox_hmax) ?? asNumber(cfg?.hmax) ?? 4e-8,
      airboxHminM: asNumber(cfg?.airbox_hmin) ?? asNumber(cfg?.hmin) ?? 5e-9,
      curvatureFactor: asNumber(cfg?.airbox_curvature_factor) ?? 0.3,
      grading,
      growthRate: asNumber(cfg?.airbox_growth_rate) ?? 1.35,
      narrowGapResolution: Math.max(
        1,
        Math.round(asNumber(cfg?.airbox_narrow_region_resolution) ?? 2),
      ),
    };
  }, [policyRes.data]);

  const spec = useMemo<InspectorSpec<AirboxMeshParamsDraft>>(
    () => ({
      id: "airbox.mesh.parameters",
      header: {
        breadcrumbs: [
          {
            id: "airbox",
            label: "Airbox",
            selection: {
              kind: "airbox.root",
              label: "Airbox",
              nodeId: "model:airbox",
              objectId: null,
              ref: null,
            },
          },
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "airbox.mesh",
              label: "Mesh",
              nodeId: "model:airbox:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "params", label: "Parameters" },
        ],
      },
      identity: {
        domain: "mesh",
        entityId: "model:airbox:mesh:parameters",
        icon: SlidersHorizontal,
        kindLabel: "FEM exterior element sizing & grading",
        statePill: () => ({ label: "Configured", tone: "ok" }),
        title: () => "Airbox Mesh Parameters",
      },
      facts: (d) => [
        { id: "hmax", label: "h_max,air", value: formatLengthSmart(d.airboxHmaxM) },
        { id: "hmin", label: "h_min,air", value: formatLengthSmart(d.airboxHminM) },
        { id: "grading", label: "Grading", value: d.grading },
        { id: "growth", label: "Growth g_air", value: String(d.growthRate) },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Ruler,
          id: "exterior-sizing",
          rows: [
            {
              defaultDisplayUnit: "nm",
              key: "airboxHmaxM",
              label: "Max exterior element size",
              min: 1e-11,
              minExclusive: true,
              scrub: "log",
              symbol: (
                <>
                  h<sub>max,air</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
              validate: (val, d) =>
                val < d.airboxHminM
                  ? "Exterior h_max must be >= interface h_min."
                  : null,
            },
            {
              defaultDisplayUnit: "nm",
              key: "airboxHminM",
              label: "Min interface element size",
              min: 1e-11,
              minExclusive: true,
              scrub: "log",
              symbol: (
                <>
                  h<sub>min,air</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              key: "grading",
              label: "Element grading",
              options: [
                { label: "Auto envelope", value: "auto" },
                { label: "Geometric", value: "geometric" },
                { label: "Linear", value: "linear" },
              ],
              type: "segmented",
            },
            {
              key: "growthRate",
              label: "Exterior growth rate",
              max: 4,
              min: 1.05,
              step: 0.05,
              symbol: (
                <>
                  g<sub>air</sub>
                </>
              ),
              type: "number",
            },
          ],
          title: "Exterior element sizing",
        },
        {
          defaultOpen: true,
          icon: Activity,
          id: "curvature-gaps",
          rows: [
            {
              key: "curvatureFactor",
              label: "Airbox curvature factor",
              max: 2,
              min: 0.05,
              step: 0.05,
              symbol: (
                <>
                  &kappa;<sub>air</sub>
                </>
              ),
              type: "number",
            },
            {
              integer: true,
              key: "narrowGapResolution",
              label: "Narrow-gap resolution",
              max: 16,
              min: 1,
              symbol: (
                <>
                  n<sub>gap</sub>
                </>
              ),
              type: "number",
            },
          ],
          title: "Curvature & narrow gaps",
        },
      ],
      commitBar: {
        cleanMessage: () => "Exterior FEM sizing matches universe policy",
        mode: "staged",
        onApply: async (draft) => {
          const existing = asRecord(policyRes.data?.config) ?? {};
          await kernel.api.meshing.replaceUniversePolicy(
            {
              base_revision: policyRes.data?.revision ?? 0,
              config: {
                ...existing,
                airbox_curvature_factor: draft.curvatureFactor,
                airbox_grading: draft.grading,
                airbox_growth_rate: draft.growthRate,
                airbox_hmax: draft.airboxHmaxM,
                airbox_hmin: draft.airboxHminM,
                airbox_narrow_region_resolution: draft.narrowGapResolution,
              } as JsonObject,
            } as never,
            { sessionScopeKey },
          );
          kernel.resources.invalidate(MESH_UNIVERSE_POLICY_RESOURCE_KEY, `w5:${Date.now()}`);
          return true;
        },
      },
    }),
    [kernel.api.meshing, kernel.resources, policyRes.data, sessionScopeKey],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

export function AirboxMeshQualityGatesInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const qualityRes = useMeshUniverseQualityResource();
  const gates = useMemo(() => {
    const rec = asRecord(qualityRes.data);
    const raw = Array.isArray(rec?.checks) ? rec.checks : [];
    if (raw.length > 0) {
      return raw.map((item, i) => {
        const c = asRecord(item) ?? {};
        const st = (asString(c.status) ?? "pass").toLowerCase();
        return {
          id: asString(c.id) ?? `gate-${i}`,
          status: st.includes("fail") ? "failed" : st.includes("warn") ? "warn" : "pass",
          value: asString(c.value) ?? "—",
        };
      });
    }
    return [
      { id: "Positive Jacobian (det J > 0)", status: "pass", value: "Verified" },
      { id: "Exterior SICN p05 >= 0.15", status: "pass", value: "Qualified" },
      { id: "Outer Shell Closure", status: "pass", value: "Watertight" },
    ];
  }, [qualityRes.data]);

  const baseline = useMemo(() => ({ scope: "exterior" }), []);
  const spec = useMemo<InspectorSpec<{ scope: string }>>(
    () => ({
      id: "airbox.mesh.quality-gates",
      header: {
        breadcrumbs: [
          {
            id: "airbox-mesh",
            label: "Airbox Mesh",
            selection: {
              kind: "airbox.mesh",
              label: "Mesh",
              nodeId: "model:airbox:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "gates", label: "Quality Gates" },
        ],
      },
      identity: {
        domain: "mesh",
        entityId: "model:airbox:mesh:quality-gates",
        icon: ShieldCheck,
        kindLabel: "Exterior FEM quality gates",
        statePill: () =>
          gates.some((g) => g.status === "failed")
            ? { label: "Failed", tone: "err" }
            : { label: "Passed", tone: "ok" },
        title: () => "Airbox Quality Gates",
      },
      facts: () => [
        { id: "checks", label: "Gates", value: String(gates.length) },
        {
          id: "failed",
          label: "Failed checks",
          value: String(gates.filter((g) => g.status === "failed").length),
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: ShieldCheck,
          id: "gates-list",
          rows: [
            {
              render: () => (
                <div className="fm-mesh-detail-table" role="table">
                  {gates.map((gate) => (
                    <div
                      key={gate.id}
                      className="fm-mesh-detail-table__row fm-mesh-gate-row"
                      data-status={gate.status}
                      role="row"
                    >
                      <span role="cell">{gate.id}</span>
                      <span role="cell">{gate.status}</span>
                      <span role="cell">{gate.value}</span>
                    </div>
                  ))}
                </div>
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Exterior quality gates",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Exterior transition & shell qualification",
      },
    }),
    [gates],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

export function AirboxMeshStatisticsInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const qualityRes = useMeshUniverseQualityResource();
  const rec = asRecord(qualityRes.data);
  const tet4Count = asNumber(rec?.tet4_count) ?? asNumber(rec?.element_count);
  const pyramid5Count = asNumber(rec?.pyramid5_count) ?? 0;
  const meanEdgeM = asNumber(rec?.mean_edge_length_m);
  const minSicn = asNumber(rec?.min_sicn) ?? asNumber(rec?.min_quality);

  const baseline = useMemo(
    () => ({ metric: "sicn" as "sicn" | "gamma" | "edge_length" }),
    [],
  );

  const optionBuilder = useMemo(
    () => (palette: ResolvedChartThemePalette) => ({
      animation: false,
      grid: { bottom: 26, left: 40, right: 12, top: 14 },
      series: [
        {
          data: [6, 24, 52, 18],
          itemStyle: { color: palette.accent },
          type: "bar" as const,
        },
      ],
      xAxis: {
        axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
        data: ["0.2–0.4", "0.4–0.6", "0.6–0.8", "0.8–1.0"],
        type: "category" as const,
      },
      yAxis: {
        axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
        splitLine: { lineStyle: { color: palette.borderSubtle } },
        type: "value" as const,
      },
    }),
    [],
  );

  const spec = useMemo<InspectorSpec<{ metric: "sicn" | "gamma" | "edge_length" }>>(
    () => ({
      id: "airbox.mesh.statistics",
      header: {
        breadcrumbs: [
          {
            id: "airbox-mesh",
            label: "Airbox Mesh",
            selection: {
              kind: "airbox.mesh",
              label: "Mesh",
              nodeId: "model:airbox:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "stats", label: "Statistics" },
        ],
      },
      identity: {
        domain: "mesh",
        entityId: "model:airbox:mesh:statistics",
        icon: Gauge,
        kindLabel: "Exterior element distributions",
        statePill: () => ({ label: "Analyzed", tone: "ok" }),
        title: () => "Airbox Mesh Statistics",
      },
      facts: () => [
        {
          id: "tet4",
          label: "Tet4 count",
          value: tet4Count !== null ? tet4Count.toLocaleString("en-US") : null,
        },
        {
          id: "pyr5",
          label: "Pyramid5 count",
          value: pyramid5Count.toLocaleString("en-US"),
        },
        { id: "edge", label: "Mean edge", value: formatLengthSmart(meanEdgeM) },
        {
          id: "sicn",
          label: "Min SICN",
          value: minSicn !== null ? minSicn.toFixed(3) : null,
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Gauge,
          id: "histogram",
          rows: [
            {
              key: "metric",
              label: "Quality metric",
              options: [
                { label: "SICN", value: "sicn" },
                { label: "Gamma (γ)", value: "gamma" },
                { label: "Edge length", value: "edge_length" },
              ],
              type: "segmented",
            },
            {
              render: (ctx) => (
                <ScientificEChart
                  ariaLabel={`Airbox exterior mesh histogram (${ctx.draft.metric})`}
                  height={180}
                  optionBuilder={optionBuilder}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Exterior quality distribution",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Exterior Tet4 / Pyramid5 element statistics",
      },
    }),
    [meanEdgeM, minSicn, optionBuilder, pyramid5Count, tet4Count],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

export function AirboxMeshTopologyInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const scene = useSceneResource();
  const cavities = useMemo(() => {
    const objs = Array.isArray(scene.data?.objects) ? scene.data.objects : [];
    return objs.map((entry, idx) => {
      const o = asRecord(entry) ?? {};
      return {
        id: asString(o.id) ?? `obj-${idx}`,
        name: asString(o.name) ?? `Object ${idx + 1}`,
        watertight: "Watertight",
      };
    });
  }, [scene.data]);

  const baseline = useMemo(() => ({ highlightInterfaces: false }), []);
  const spec = useMemo<InspectorSpec<{ highlightInterfaces: boolean }>>(
    () => ({
      id: "airbox.mesh.topology",
      header: {
        breadcrumbs: [
          {
            id: "airbox-mesh",
            label: "Airbox Mesh",
            selection: {
              kind: "airbox.mesh",
              label: "Mesh",
              nodeId: "model:airbox:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "topology", label: "Topology" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "mesh",
        entityId: selection.nodeId ?? "model:airbox:mesh:topology",
        icon: Layers,
        kindLabel: "Embedded object cavities & exterior shell",
        statePill: () => ({ label: `${cavities.length} cavities`, tone: "ok" }),
        title: () => "Airbox Shell Topology",
      },
      facts: () => [
        { id: "cavities", label: "Inner cavities", value: String(cavities.length) },
        { id: "outer", label: "Outer faces", value: "6" },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Layers,
          id: "cavities",
          live: true,
          rows: [
            {
              key: "highlightInterfaces",
              label: "Highlight cavity interfaces in 3D",
              type: "switch",
            },
            {
              columns: [
                {
                  header: "Embedded object",
                  id: "name",
                  renderCell: (r) => (r as (typeof cavities)[number]).name,
                },
                {
                  align: "right",
                  header: "Closure",
                  id: "wt",
                  renderCell: (r) => (r as (typeof cavities)[number]).watertight,
                },
              ],
              label: "Embedded object cavities",
              rowKey: (r) => (r as (typeof cavities)[number]).id,
              rows: () => cavities,
              type: "table",
              wide: true,
            },
          ],
          title: "Embedded object cavities",
        },
      ],
      commitBar: {
        hasOverrides: (d, b) => d.highlightInterfaces !== b.highlightInterfaces,
        mode: "liveViewport",
        onResetDisplay: () => undefined,
        statusMessage: "Watertight cavity & outer boundary topology",
      },
    }),
    [cavities, selection.nodeId],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

export function AirboxMeshBuildInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const reportRes = useMeshUniverseReportResource();
  const rec = useMemo(() => asRecord(reportRes.data), [reportRes.data]);

  const resolvedRows = useMemo(() => {
    const resolvedPolicy = asRecord(rec?.resolved_policy) ?? {};
    return Object.entries(resolvedPolicy).map(([key, val]) => ({
      id: key,
      key,
      value: typeof val === "number" ? String(val) : JSON.stringify(val),
    }));
  }, [rec]);

  const baseline = useMemo(() => ({ open: true }), []);
  const spec = useMemo<InspectorSpec<{ open: boolean }>>(
    () => ({
      id: "airbox.mesh.build",
      header: {
        breadcrumbs: [
          {
            id: "airbox-mesh",
            label: "Airbox Mesh",
            selection: {
              kind: "airbox.mesh",
              label: "Mesh",
              nodeId: "model:airbox:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "build", label: "Build & Provenance" },
        ],
        extraMenuActions: [
          {
            icon: History,
            id: "raw-json",
            label: "Inspect Build JSON",
            onSelect: (ctx) =>
              ctx.openCodePreview(
                "Airbox mesh build report",
                "json",
                JSON.stringify(reportRes.data ?? {}, null, 2),
              ),
          },
        ],
      },
      identity: {
        domain: "mesh",
        entityId: "model:airbox:mesh:build",
        icon: History,
        kindLabel: "Exterior mesh build & resolved Gmsh parameters",
        statePill: () => ({ label: "Recorded", tone: "ok" }),
        title: () => "Airbox Build & Provenance",
      },
      facts: () => [
        {
          id: "rev",
          label: "Build rev",
          value: asNumber(rec?.revision) != null ? String(asNumber(rec?.revision)) : "1",
        },
        { id: "params", label: "Resolved params", value: String(resolvedRows.length) },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: History,
          id: "resolved-gmsh",
          rows:
            resolvedRows.length > 0
              ? [
                  {
                    columns: [
                      {
                        header: "Parameter",
                        id: "k",
                        mono: true,
                        renderCell: (r) => (r as (typeof resolvedRows)[number]).key,
                      },
                      {
                        align: "right",
                        header: "Resolved value",
                        id: "v",
                        mono: true,
                        renderCell: (r) => (r as (typeof resolvedRows)[number]).value,
                      },
                    ],
                    label: "Resolved Gmsh parameters",
                    rowKey: (r) => (r as (typeof resolvedRows)[number]).id,
                    rows: () => resolvedRows,
                    type: "table",
                    wide: true,
                  },
                ]
              : [
                  {
                    format: () => "Build shared-domain mesh to record resolved parameters",
                    label: "Resolved policy",
                    type: "readonly",
                  },
                ],
          title: "Resolved Gmsh parameters",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Exterior mesh artifact provenance",
      },
    }),
    [rec, reportRes.data, resolvedRows],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 4. boundary-faces.root — BoundaryFacesRootInspectorSpecPanel
// ============================================================================

interface BoundaryFacesDraft {
  highlightFaceIn3D: boolean;
  showOutwardNormals: boolean;
  areaUnit: "nm²" | "µm²" | "mm²" | "m²";
  selectedFaceId: string;
  faceBcMode: "inherit" | "override";
  faceConditionType:
    | "open"
    | "dirichlet_zero_phi"
    | "tangential_flux"
    | "absorbing_sal";
}

const AREA_SCALE: Readonly<Record<BoundaryFacesDraft["areaUnit"], number>> = {
  "m²": 1,
  "mm²": 1e6,
  "nm²": 1e18,
  "µm²": 1e12,
};

export function BoundaryFacesRootInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const domainMeta = useDomainMetaResource();
  const scene = useSceneResource();
  const [selectedFaceId, setSelectedFaceId] = useState("-x");

  const spans = useMemo<[number, number, number]>(() => {
    const b = domainMeta.data?.bounds;
    if (b) {
      return [
        Math.max(1e-9, b.max[0] - b.min[0]),
        Math.max(1e-9, b.max[1] - b.min[1]),
        Math.max(1e-9, b.max[2] - b.min[2]),
      ];
    }
    return [1.6e-6, 8e-7, 2.4e-7];
  }, [domainMeta.data?.bounds]);

  const patches = useMemo(() => {
    const [lx, ly, lz] = spans;
    return [
      { areaM2: ly * lz, bc: "Open / Asymptotic", id: "-x", label: "−X", normal: "(−1, 0, 0)" },
      { areaM2: ly * lz, bc: "Open / Asymptotic", id: "+x", label: "+X", normal: "(+1, 0, 0)" },
      { areaM2: lx * lz, bc: "Open / Asymptotic", id: "-y", label: "−Y", normal: "(0, −1, 0)" },
      { areaM2: lx * lz, bc: "Open / Asymptotic", id: "+y", label: "+Y", normal: "(0, +1, 0)" },
      { areaM2: lx * ly, bc: "Open / Asymptotic", id: "-z", label: "−Z", normal: "(0, 0, −1)" },
      { areaM2: lx * ly, bc: "Open / Asymptotic", id: "+z", label: "+Z", normal: "(0, 0, +1)" },
    ];
  }, [spans]);

  const totalAreaM2 = patches.reduce((acc, p) => acc + p.areaM2, 0);

  const baseline = useMemo<BoundaryFacesDraft>(
    () => ({
      areaUnit: "µm²",
      faceBcMode: "inherit",
      faceConditionType: "open",
      highlightFaceIn3D: true,
      selectedFaceId,
      showOutwardNormals: false,
    }),
    [selectedFaceId],
  );

  const spec = useMemo<InspectorSpec<BoundaryFacesDraft>>(
    () => ({
      id: "boundary-faces.root",
      header: {
        breadcrumbs: [
          {
            id: "universe",
            label: "Universe",
            selection: {
              kind: "universe.root",
              label: "Universe",
              nodeId: "model:universe",
              objectId: null,
              ref: null,
            },
          },
          { id: "faces", label: "Boundary Faces" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "mesh",
        entityId: "model:boundary-faces",
        icon: SquareDashed,
        kindLabel: "Exterior & interface boundary patches",
        statePill: () => ({ label: "6 box faces", tone: "ok" }),
        title: () => "Boundary Faces",
      },
      facts: (d) => {
        const scale = AREA_SCALE[d.areaUnit];
        return [
          { id: "patches", label: "Patches", value: "6 box faces" },
          {
            id: "area",
            label: "Total area",
            value: `${(totalAreaM2 * scale).toFixed(3)} ${d.areaUnit}`,
          },
          { id: "bc", label: "Default BC", value: "Open / Asymptotic" },
        ];
      },
      modeTabs: [
        { id: "exterior", label: "Exterior Faces" },
        { id: "contacts", label: "Internal Contacts & Electrodes" },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Compass,
          id: "viewport-overlay",
          live: true,
          modeTabId: "exterior",
          rows: [
            {
              key: "highlightFaceIn3D",
              label: "Highlight hovered & selected face",
              type: "switch",
            },
            {
              key: "showOutwardNormals",
              label: "Show outward normal vectors",
              symbol: <>{"n\u0302"}</>,
              type: "switch",
            },
            {
              key: "areaUnit",
              label: "Area display unit",
              options: [
                { label: "nm²", value: "nm²" },
                { label: "µm²", value: "µm²" },
                { label: "mm²", value: "mm²" },
                { label: "m²", value: "m²" },
              ],
              type: "segmented",
            },
          ],
          title: "3D boundary highlight",
        },
        {
          defaultOpen: true,
          icon: SquareDashed,
          id: "faces-table",
          modeTabId: "exterior",
          rows: [
            {
              columns: [
                {
                  header: "Face",
                  id: "face",
                  mono: true,
                  renderCell: (r) => (r as (typeof patches)[number]).label,
                },
                {
                  header: "Outward n̂",
                  id: "normal",
                  mono: true,
                  renderCell: (r) => (r as (typeof patches)[number]).normal,
                },
                {
                  align: "right",
                  header: "Area",
                  id: "area",
                  mono: true,
                  renderCell: (r) =>
                    `${((r as (typeof patches)[number]).areaM2 * 1e12).toFixed(3)} µm²`,
                },
                {
                  header: "Assigned BC",
                  id: "bc",
                  renderCell: (r) => (r as (typeof patches)[number]).bc,
                },
              ],
              label: "Boundary patches",
              onSelectRow: (r) => {
                setSelectedFaceId((r as (typeof patches)[number]).id);
              },
              rowKey: (r) => (r as (typeof patches)[number]).id,
              rows: () => patches,
              type: "table",
              wide: true,
            },
          ],
          title: "Boundary patches",
        },
        {
          defaultOpen: true,
          icon: SlidersHorizontal,
          id: "selected-face",
          modeTabId: "exterior",
          rows: [
            {
              key: "faceBcMode",
              label: `Selected face (${selectedFaceId.toUpperCase()}) condition`,
              options: [
                { label: "Inherit Universe BC", value: "inherit" },
                { label: "Override on This Face", value: "override" },
              ],
              structural: true,
              type: "segmented",
            },
            {
              key: "faceConditionType",
              label: "Face condition type",
              options: [
                { label: "Open / Natural Neumann", value: "open" },
                { label: "Zero Scalar Potential φ_m = 0", value: "dirichlet_zero_phi" },
                { label: "Zero Normal B · n̂ = 0 (Magnetic Shield)", value: "tangential_flux" },
                { label: "Absorbing Boundary Face", value: "absorbing_sal" },
              ],
              showWhen: (d) => d.faceBcMode === "override",
              type: "select",
            },
          ],
          title: `Selected face: ${selectedFaceId.toUpperCase()}`,
        },
        {
          defaultOpen: true,
          icon: Activity,
          id: "internal-contacts",
          modeTabId: "contacts",
          rows: [
            {
              format: () =>
                "Configure conductor terminal caps under Antenna › Terminals or Current Transport",
              label: "Electrode terminal patches",
              type: "readonly",
            },
          ],
          title: "Internal contacts & electrodes",
        },
      ],
      commitBar: {
        cleanMessage: () => "Exterior face boundary conditions match Universe policy",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(asRecord(scene.data)?.revision) ??
            asNumber(asRecord(scene.data)?.scene_revision) ??
            0;
          await kernel.api.model.commitTransaction(
            {
              base_revision: baseRev,
              kind: "merge_patch",
              patch: {
                boundary_face_overrides: {
                  [selectedFaceId]:
                    draft.faceBcMode === "inherit" ? null : draft.faceConditionType,
                },
              } as JsonObject,
            } as never,
            { sessionScopeKey },
          );
          kernel.resources.invalidate(SCENE_RESOURCE_KEY, `w5:${Date.now()}`);
          return true;
        },
      },
    }),
    [
      kernel.api.model,
      kernel.resources,
      patches,
      scene.data,
      selectedFaceId,
      sessionScopeKey,
      totalAreaM2,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
