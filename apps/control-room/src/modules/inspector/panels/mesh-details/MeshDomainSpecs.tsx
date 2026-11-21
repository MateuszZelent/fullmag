"use client";

import {
  Activity,
  Box,
  Compass,
  Gauge,
  Grid3x3,
  History,
  Layers,
  Ruler,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import type { JsonObject } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_SEMANTICS_RESOURCE_KEY,
  MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY,
  MESH_SUMMARY_RESOURCE_KEY,
  MESH_UNIVERSE_POLICY_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  resolveObjectMeshPolicyResourceKey,
  useDomainMetaResource,
  useFdmMultilayerLayoutResource,
  useMeshBuildCurrent,
  useMeshBuildHistoryResource,
  useMeshSemanticsResource,
  useMeshSharedDomainManifestResource,
  useMeshSharedDomainPolicyResource,
  useMeshSharedDomainQualityGatesResource,
  useMeshSharedDomainRealizedSizeFieldsResource,
  useMeshSharedDomainReportResource,
  useMeshSummaryResource,
  useObjectMeshPolicyResource,
  useObjectMeshQualityResource,
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
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorNotice,
  InspectorSpec,
  InspectorTone,
  UnitOption,
} from "../../template";
import { FemMeshReadinessGuideCard } from "../mesh-guide/FemMeshReadinessGuideCard";
import {
  resolveMixedCertificateQualityPresentation,
  type MixedCertificateFamilyGate,
} from "./MeshQualityGatesSection.model";
import { SpecInspectorHost } from "./SpecInspectorHost";

const MU0 = 4 * Math.PI * 1e-7;

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

export function formatLengthSmart(meters: number | null | undefined): string | null {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) return null;
  const abs = Math.abs(meters);
  if (abs === 0) return "0 nm";
  if (abs < 1e-6) return `${Number((meters * 1e9).toFixed(2))} nm`;
  if (abs < 1e-3) return `${Number((meters * 1e6).toFixed(2))} µm`;
  if (abs < 1) return `${Number((meters * 1e3).toFixed(3))} mm`;
  return `${Number(meters.toFixed(4))} m`;
}

export interface ExchangeLengthGuardEvaluation {
  exchangeLengthM: number;
  materialId: string;
  materialName: string;
  maxActiveCellM: number;
  ratio: number;
  recommendedCellM: number;
  exceeds: boolean;
}

function roundFriendlySubNanometerM(targetM: number): number {
  const nm = targetM * 1e9;
  const candidates = [0.5, 1.0, 1.25, 2.0, 2.5, 3.125, 4.0, 5.0, 6.25, 8.0, 10.0];
  let best = Math.max(0.5, Math.floor(nm * 10) / 10);
  for (const candidate of candidates) {
    if (candidate <= nm) {
      best = candidate;
    }
  }
  return best * 1e-9;
}

/**
 * Evaluates the magnetostatic exchange length l_ex = sqrt(2 A_ex / (mu_0 M_s^2))
 * across all materials referenced in the scene and checks max(Delta) against l_ex.
 */
export function computeExchangeLengthGuard(
  scene: unknown,
  spacingM: readonly [number, number, number],
  shape: readonly [number, number, number],
): ExchangeLengthGuardEvaluation | null {
  const sceneRec = asRecord(scene);
  const rawMaterials = Array.isArray(sceneRec?.materials) ? sceneRec.materials : [];
  const rawObjects = Array.isArray(sceneRec?.objects) ? sceneRec.objects : [];
  const usedMaterialIds = new Set<string>();
  for (const rawObj of rawObjects) {
    const obj = asRecord(rawObj);
    const ref = asString(obj?.material_ref);
    if (ref && ref.toLowerCase() !== "unassigned") {
      usedMaterialIds.add(ref);
    }
  }

  let limiting: { id: string; name: string; lexM: number } | null = null;
  for (const entry of rawMaterials) {
    const mat = asRecord(entry);
    if (!mat) continue;
    const id = asString(mat.id) ?? "material";
    if (usedMaterialIds.size > 0 && !usedMaterialIds.has(id)) continue;
    const name = asString(mat.name) ?? id;
    const props = asRecord(mat.properties) ?? mat;
    const ms =
      asNumber(props.ms) ??
      asNumber(props.Ms) ??
      asNumber(props.saturation_magnetization);
    const aex =
      asNumber(props.aex) ??
      asNumber(props.Aex) ??
      asNumber(props.exchange_stiffness);
    if (ms === null || aex === null || ms <= 0 || aex <= 0) continue;
    const lexM = Math.sqrt((2 * aex) / (MU0 * ms * ms));
    if (!Number.isFinite(lexM) || lexM <= 0) continue;
    if (!limiting || lexM < limiting.lexM) {
      limiting = { id, name, lexM };
    }
  }

  if (!limiting) return null;
  const activeSpacings = [
    spacingM[0],
    spacingM[1],
    shape[2] > 1 ? spacingM[2] : 0,
  ].filter((val) => Number.isFinite(val) && val > 0);
  if (activeSpacings.length === 0) return null;

  const maxActiveCellM = Math.max(...activeSpacings);
  const ratio = maxActiveCellM / limiting.lexM;
  const recommendedCellM = roundFriendlySubNanometerM(0.8 * limiting.lexM);

  return {
    exchangeLengthM: limiting.lexM,
    exceeds: maxActiveCellM > limiting.lexM,
    materialId: limiting.id,
    materialName: limiting.name,
    maxActiveCellM,
    ratio,
    recommendedCellM,
  };
}

function useActiveLane(): "fdm" | "fem" | "unresolved" {
  const raw = useSessionStatusSelector(
    (status) => status.data?.domain?.discretization ?? null,
  );
  if (typeof raw !== "string") return "unresolved";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "fdm") return "fdm";
  if (normalized === "fem") return "fem";
  return "unresolved";
}

// ============================================================================
// 1. mesh.root — MeshRootInspectorSpecPanel
// ============================================================================

interface MeshRootDraft {
  lane: "fdm" | "fem";
  zStackMode: "single_3d" | "multilayer";
  sizingMode: "cell_size" | "cell_count";
  cellSizeM: readonly [number, number, number];
  gridCountX: number;
  gridCountY: number;
  gridCountZ: number;
  fftSmoothSnap: boolean;
  hmaxM: number;
  hminM: number;
  elementOrder: "1" | "2";
  growthRate: number;
  curvatureFactor: number;
  generator: string;
  optimizeQuality: boolean;
}

export function MeshRootInspectorSpecPanel({ selection }: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionIdentity = useSessionResourceIdentity();
  const sessionScopeKey = sessionRequestScopeKey(sessionIdentity) ?? undefined;
  const activeLane = useActiveLane();
  const femActive = activeLane === "fem";
  const fdmActive = activeLane === "fdm";

  const scene = useSceneResource({ enabled: activeLane !== "unresolved" });
  const domainMeta = useDomainMetaResource({ enabled: fdmActive });
  const multilayer = useFdmMultilayerLayoutResource({ enabled: fdmActive });
  const sharedPolicy = useMeshSharedDomainPolicyResource({ enabled: femActive });
  const universePolicy = useUniverseMeshPolicyResource({ enabled: activeLane !== "unresolved" });
  const manifest = useMeshSharedDomainManifestResource({ enabled: femActive });
  const activeBuild = useMeshBuildCurrent({ enabled: femActive });
  const summary = useMeshSummaryResource({ enabled: femActive });

  const baseline = useMemo<MeshRootDraft>(() => {
    const grid = domainMeta.data?.grid;
    const spacing = grid?.spacing ?? [4e-9, 4e-9, 2e-9];
    const shape = grid?.shape ?? [128, 64, 1];
    const sharedCfg =
      asRecord(sharedPolicy.data?.config) ??
      asRecord(asRecord(sharedPolicy.data)?.effective_config);
    return {
      cellSizeM: [
        spacing[0] && spacing[0] > 0 ? spacing[0] : 4e-9,
        spacing[1] && spacing[1] > 0 ? spacing[1] : 4e-9,
        spacing[2] && spacing[2] > 0 ? spacing[2] : 2e-9,
      ],
      curvatureFactor: asNumber(sharedCfg?.curvature_factor) ?? 0.35,
      elementOrder: String(asNumber(sharedCfg?.element_order) ?? 1) === "2" ? "2" : "1",
      fftSmoothSnap: true,
      generator: asString(sharedCfg?.generator) ?? "gmsh",
      gridCountX: shape[0] && shape[0] > 0 ? shape[0] : 128,
      gridCountY: shape[1] && shape[1] > 0 ? shape[1] : 64,
      gridCountZ: shape[2] && shape[2] > 0 ? shape[2] : 1,
      growthRate: asNumber(sharedCfg?.growth_rate) ?? 1.3,
      hmaxM: asNumber(sharedCfg?.maximum_element_size) ?? 5e-9,
      hminM: asNumber(sharedCfg?.minimum_element_size) ?? 2e-9,
      lane: femActive ? "fem" : "fdm",
      optimizeQuality: sharedCfg?.optimize_quality !== false,
      sizingMode: "cell_size",
      zStackMode: multilayer.data?.available ? "multilayer" : "single_3d",
    };
  }, [
    domainMeta.data?.grid,
    femActive,
    multilayer.data?.available,
    sharedPolicy.data,
  ]);

  const sceneRev =
    asNumber(asRecord(scene.data)?.revision) ??
    asNumber(asRecord(scene.data)?.scene_revision);
  const manifestSourceRev = asNumber(asRecord(manifest.data)?.source_scene_revision);
  const topologyCounts = asRecord(asRecord(manifest.data)?.topology_counts);
  const femElements =
    asNumber(topologyCounts?.elements) ?? asNumber(topologyCounts?.tetrahedra);
  const femNodes =
    asNumber(topologyCounts?.nodes) ?? asNumber(topologyCounts?.vertices);
  const buildingNow = Boolean(activeBuild.data?.active_build);

  const spec = useMemo<InspectorSpec<MeshRootDraft>>(() => {
    const hasPriorArtifacts = Boolean(manifest.data || (summary.data?.revision ?? 0) > 0);
    return {
      id: "mesh.root",
      header: {
        breadcrumbs: [
          {
            id: "model",
            label: "Model",
            selection: {
              kind: "model.root",
              label: "Model",
              nodeId: "model:session",
              objectId: null,
              ref: null,
            },
          },
          { id: "mesh", label: "Mesh" },
        ],
        canFitView: true,
        primaryHeaderAction: {
          confirm: hasPriorArtifacts
            ? {
                confirmLabel: femActive ? "Rebuild mesh" : "Re-voxelize grid",
                description:
                  "Rebuilding discretization invalidates downstream mesh-pinned solver states for earlier revisions.",
                title: femActive
                  ? "Rebuild shared-domain FEM mesh?"
                  : "Re-voxelize structured FDM grid?",
              }
            : undefined,
          icon: Grid3x3,
          label: femActive
            ? manifest.data
              ? "Rebuild Mesh"
              : "Build Mesh"
            : "Re-voxelize Grid",
          onRun: async () => {
            const cmd = femActive ? "mesh.build-shared-domain" : "grid.build-fdm";
            await kernel.commands.execute(
              cmd,
              createCommandContext("inspector", kernel, {
                sessionScopeKey,
                sourceDetail: "mesh.root",
              }),
            );
          },
        },
      },
      identity: {
        domain: "mesh",
        entityId: "model:mesh",
        icon: Grid3x3,
        kindLabel:
          activeLane === "unresolved"
            ? "Unresolved discretization"
            : femActive
              ? "Finite element mesh (FEM)"
              : "Finite difference grid (FDM)",
        statePill: (draft) => {
          if (buildingNow) return { label: "Building", tone: "live" };
          if (draft.lane === "fdm") {
            const guard = computeExchangeLengthGuard(scene.data, draft.cellSizeM, [
              draft.gridCountX,
              draft.gridCountY,
              draft.gridCountZ,
            ]);
            if (guard?.exceeds) {
              return {
                label: guard.ratio > 1.5 ? "Exchange violation" : "Cell > l_ex",
                tone: guard.ratio > 1.5 ? "err" : "warn",
              };
            }
            return { label: "Ready", tone: "ok" };
          }
          if (!manifest.data) return { label: "Not built", tone: "neutral" };
          if (sceneRev !== null && manifestSourceRev !== null && manifestSourceRev < sceneRev) {
            return { label: "Stale", tone: "warn" };
          }
          return { label: "Ready", tone: "ok" };
        },
        title: () => "Discretization & Mesh",
      },
      facts: (draft) => {
        if (draft.lane === "fdm") {
          const guard = computeExchangeLengthGuard(scene.data, draft.cellSizeM, [
            draft.gridCountX,
            draft.gridCountY,
            draft.gridCountZ,
          ]);
          const ratioTone: InspectorTone | undefined = guard
            ? guard.ratio <= 1.0
              ? "ok"
              : guard.ratio <= 1.25
                ? "warn"
                : "err"
            : undefined;
          return [
            { id: "lane", label: "Lane", value: "FDM" },
            {
              id: "grid",
              label: "Grid",
              value: `${draft.gridCountX} × ${draft.gridCountY} × ${draft.gridCountZ}`,
            },
            {
              id: "cell",
              label: "Cell",
              value: `${Number((draft.cellSizeM[0] * 1e9).toFixed(2))} × ${Number((draft.cellSizeM[1] * 1e9).toFixed(2))} × ${Number((draft.cellSizeM[2] * 1e9).toFixed(2))} nm`,
            },
            {
              id: "lex-ratio",
              label: "Max Δ / l_ex",
              tone: ratioTone,
              value: guard
                ? `${guard.ratio.toFixed(2)} (l_ex = ${(guard.exchangeLengthM * 1e9).toFixed(2)} nm)`
                : null,
            },
          ];
        }
        return [
          { id: "lane", label: "Lane", value: `FEM (P${draft.elementOrder})` },
          {
            id: "elements",
            label: "Elements",
            value: femElements !== null ? femElements.toLocaleString("en-US") : null,
          },
          {
            id: "nodes",
            label: "Nodes",
            value: femNodes !== null ? femNodes.toLocaleString("en-US") : null,
          },
          {
            id: "hmax",
            label: "Global h_max",
            value: formatLengthSmart(draft.hmaxM),
          },
        ];
      },
      notices: (draft) => {
        const list: InspectorNotice<MeshRootDraft>[] = [];
        if (draft.lane === "fdm") {
          const guard = computeExchangeLengthGuard(scene.data, draft.cellSizeM, [
            draft.gridCountX,
            draft.gridCountY,
            draft.gridCountZ,
          ]);
          if (guard?.exceeds) {
            const maxNm = (guard.maxActiveCellM * 1e9).toFixed(2);
            const lexNm = (guard.exchangeLengthM * 1e9).toFixed(2);
            const recNm = Number((guard.recommendedCellM * 1e9).toFixed(2));
            list.push({
              focusFieldKey: "cellSizeM",
              id: "fdm-lex-guard",
              quickFix: {
                label: `Set Δx, Δy = ${recNm} nm (≤ 0.8 l_ex)`,
                onApply: (ctx) => {
                  ctx.setField("cellSizeM", [
                    guard.recommendedCellM,
                    guard.recommendedCellM,
                    Math.min(ctx.draft.cellSizeM[2], guard.recommendedCellM),
                  ]);
                },
              },
              text: `Cell size Δ = ${maxNm} nm exceeds exchange length l_ex = ${lexNm} nm for material "${guard.materialName}". Artificial spin pinning may occur.`,
              title: "Exchange length guard",
              tone: guard.ratio > 1.5 ? "err" : "warn",
            });
          }
        } else if (
          sceneRev !== null &&
          manifestSourceRev !== null &&
          manifestSourceRev < sceneRev
        ) {
          list.push({
            id: "fem-stale-mesh",
            quickFix: {
              label: "Rebuild Mesh",
              onApply: async () => {
                await kernel.commands.execute(
                  "mesh.build-shared-domain",
                  createCommandContext("inspector", kernel, {
                    sessionScopeKey,
                    sourceDetail: "mesh.root.notice",
                  }),
                );
              },
            },
            text: `Geometry or mesh policy changed since scene revision ${manifestSourceRev} (current revision ${sceneRev}). Rebuild mesh before running solvers.`,
            title: "Shared-domain mesh is stale",
            tone: "warn",
          });
        }
        return list;
      },
      sections: [
        {
          defaultOpen: true,
          icon: Settings2,
          id: "discretization",
          rows: [
            {
              key: "lane",
              label: "Discretization",
              options: [
                { label: "FDM Grid", value: "fdm" },
                { label: "FEM Mesh", value: "fem" },
              ],
              structural: true,
              type: "segmented",
            },
            {
              key: "zStackMode",
              label: "Z-stack mode",
              options: [
                { label: "Single 3D grid", value: "single_3d" },
                { label: "Multilayer Z-slices", value: "multilayer" },
              ],
              showWhen: (d) => d.lane === "fdm",
              type: "segmented",
            },
          ],
          summary: (d) => (d.lane === "fdm" ? "Finite difference grid" : "Finite element mesh"),
          title: "Discretization method",
        },
        {
          defaultOpen: true,
          icon: Grid3x3,
          id: "fdm-sizing",
          rows: [
            {
              key: "sizingMode",
              label: "Sizing definition",
              options: [
                { label: "Cell size Δ", value: "cell_size" },
                { label: "Cell count N", value: "cell_count" },
              ],
              structural: true,
              type: "segmented",
            },
            {
              defaultDisplayUnit: "nm",
              key: "cellSizeM",
              label: "Cell size",
              showWhen: (d) => d.sizingMode === "cell_size",
              symbol: <>&Delta;</>,
              symbolInfo: {
                definition:
                  "Cartesian voxel spacing along x, y, and z. Keep lateral spacing at or below magnetostatic exchange length l_ex.",
                name: "Voxel cell spacing",
                siUnit: "m",
              },
              type: "vector3",
              units: LENGTH_UNITS,
            },
            {
              integer: true,
              key: "gridCountX",
              label: "Cells along X",
              min: 1,
              showWhen: (d) => d.sizingMode === "cell_count",
              symbol: (
                <>
                  N<sub>x</sub>
                </>
              ),
              type: "number",
            },
            {
              integer: true,
              key: "gridCountY",
              label: "Cells along Y",
              min: 1,
              showWhen: (d) => d.sizingMode === "cell_count",
              symbol: (
                <>
                  N<sub>y</sub>
                </>
              ),
              type: "number",
            },
            {
              integer: true,
              key: "gridCountZ",
              label: "Cells along Z",
              min: 1,
              showWhen: (d) => d.sizingMode === "cell_count",
              symbol: (
                <>
                  N<sub>z</sub>
                </>
              ),
              type: "number",
            },
            {
              format: (d) => {
                const guard = computeExchangeLengthGuard(scene.data, d.cellSizeM, [
                  d.gridCountX,
                  d.gridCountY,
                  d.gridCountZ,
                ]);
                return guard
                  ? `${(guard.exchangeLengthM * 1e9).toFixed(2)} nm (${guard.materialName})`
                  : "Assign magnetic material to evaluate l_ex";
              },
              label: "Exchange length",
              symbol: (
                <>
                  l<sub>ex</sub>
                </>
              ),
              type: "readonly",
            },
            {
              key: "fftSmoothSnap",
              label: "Snap N_x, N_y to 7-smooth FFT sizes",
              type: "switch",
            },
          ],
          showWhen: (d) => d.lane === "fdm",
          summary: (d) =>
            `${d.gridCountX} × ${d.gridCountY} × ${d.gridCountZ} · ${(d.cellSizeM[0] * 1e9).toFixed(2)} nm`,
          title: "Global FDM grid sizing",
        },
        {
          defaultOpen: !manifest.data,
          icon: Compass,
          id: "fem-readiness",
          rows: [
            {
              render: () => <FemMeshReadinessGuideCard compact={Boolean(manifest.data)} />,
              type: "custom",
              wide: true,
            },
          ],
          showWhen: (d) => d.lane === "fem",
          summary: () => (manifest.data ? "Shared-domain mesh built" : "Action required"),
          title: "Readiness checklist",
        },
        {
          defaultOpen: true,
          icon: Ruler,
          id: "fem-sizing",
          rows: [
            {
              defaultDisplayUnit: "nm",
              key: "hmaxM",
              label: "Global max element size",
              min: 1e-11,
              minExclusive: true,
              scrub: "log",
              symbol: (
                <>
                  h<sub>max</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
              validate: (val, d) =>
                val < d.hminM ? "h_max must be greater than or equal to h_min." : null,
            },
            {
              defaultDisplayUnit: "nm",
              key: "hminM",
              label: "Global min element size",
              min: 1e-11,
              minExclusive: true,
              scrub: "log",
              symbol: (
                <>
                  h<sub>min</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              key: "elementOrder",
              label: "Element polynomial order",
              options: [
                { label: "P1 Linear", value: "1" },
                { label: "P2 Quadratic", value: "2" },
              ],
              symbol: <>p</>,
              type: "segmented",
            },
            {
              key: "growthRate",
              label: "Size growth rate",
              max: 4,
              min: 1.01,
              step: 0.05,
              symbol: <>g</>,
              type: "number",
            },
            {
              key: "curvatureFactor",
              label: "Curvature refinement factor",
              max: 2,
              min: 0.05,
              step: 0.05,
              symbol: <>&kappa;</>,
              type: "number",
            },
            {
              key: "generator",
              label: "3D mesh generator",
              options: [
                { label: "Gmsh (Delaunay / HXT)", value: "gmsh" },
                { label: "Netgen", value: "netgen" },
                { label: "TetGen", value: "tetgen" },
              ],
              type: "select",
            },
            {
              key: "optimizeQuality",
              label: "Post-mesh quality optimization",
              type: "switch",
            },
          ],
          showWhen: (d) => d.lane === "fem",
          summary: (d) =>
            `h_min ${formatLengthSmart(d.hminM)} → h_max ${formatLengthSmart(d.hmaxM)} · P${d.elementOrder}`,
          title: "Global FEM sizing & generator",
        },
      ],
      details: () => [
        {
          label: "Scene revision",
          mono: true,
          value: sceneRev !== null ? String(sceneRev) : null,
        },
        {
          label: "Mesh revision",
          mono: true,
          value: summary.data?.revision != null ? String(summary.data.revision) : null,
        },
        {
          label: "Mesh ID",
          mono: true,
          value: asString(asRecord(manifest.data)?.mesh_id),
        },
      ],
      commitBar: {
        cleanMessage: (d) =>
          d.lane === "fdm"
            ? "FDM grid sizing matches session policy"
            : "FEM shared-domain policy is up to date",
        confirmApply: (draft, base) =>
          draft.lane !== base.lane
            ? {
                confirmLabel: `Switch to ${draft.lane.toUpperCase()}`,
                description:
                  "Switching discretization lane updates study representation and invalidates lane-specific artifacts.",
                title: `Switch session discretization to ${draft.lane.toUpperCase()}?`,
              }
            : null,
        mode: "staged",
        onApply: async (draft, base) => {
          if (draft.lane !== base.lane) {
            await kernel.api.model.patchStudy(
              { discretization: draft.lane } as never,
              { sessionScopeKey },
            );
          }
          if (draft.lane === "fdm") {
            const existingCfg = asRecord(universePolicy.data?.config) ?? {};
            await kernel.api.meshing.replaceUniversePolicy(
              {
                base_revision: universePolicy.data?.revision ?? 0,
                config: {
                  ...existingCfg,
                  cell_size: [...draft.cellSizeM],
                  fft_smooth_snap: draft.fftSmoothSnap,
                  grid_shape: [draft.gridCountX, draft.gridCountY, draft.gridCountZ],
                } as JsonObject,
              } as never,
              { sessionScopeKey },
            );
            kernel.resources.invalidate(MESH_UNIVERSE_POLICY_RESOURCE_KEY, `w5:${Date.now()}`);
          } else {
            await kernel.api.meshing.sharedDomain.replacePolicy(
              {
                base_revision: sharedPolicy.data?.revision ?? 0,
                config: {
                  curvature_factor: draft.curvatureFactor,
                  element_order: Number(draft.elementOrder),
                  generator: draft.generator,
                  growth_rate: draft.growthRate,
                  maximum_element_size: draft.hmaxM,
                  minimum_element_size: draft.hminM,
                  optimize_quality: draft.optimizeQuality,
                } as JsonObject,
              } as never,
              { sessionScopeKey },
            );
            kernel.resources.invalidate(MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY, `w5:${Date.now()}`);
            kernel.resources.invalidate(MESH_SEMANTICS_RESOURCE_KEY, `w5:${Date.now()}`);
          }
          kernel.resources.invalidate(MESH_SUMMARY_RESOURCE_KEY, `w5:${Date.now()}`);
          return true;
        },
      },
    };
  }, [
    activeLane,
    buildingNow,
    femActive,
    femElements,
    femNodes,
    kernel,
    manifest.data,
    manifestSourceRev,
    scene.data,
    sceneRev,
    sessionScopeKey,
    sharedPolicy.data,
    summary.data,
    universePolicy.data,
  ]);

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 2. object.mesh — ObjectMeshInspectorSpecPanel (Zero DELETE, PUT config: null)
// ============================================================================

interface ObjectMeshDraft {
  policyMode: "inherit" | "custom";
  meshStrategy: "tet_auto" | "swept_prism" | "structured_hex";
  hmaxM: number;
  hminM: number;
  growthRate: number;
  layerCount: number;
  layerProgression: number;
  localBoundaryRefinement: boolean;
  boundaryElementSizeM: number;
}

export function ObjectMeshInspectorSpecPanel({ selection }: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const activeLane = useActiveLane();
  const objectId = selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "";

  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const policyRes = useObjectMeshPolicyResource(objectId, {
    enabled: Boolean(objectId) && activeLane === "fem",
  });
  const qualityRes = useObjectMeshQualityResource(objectId, {
    enabled: Boolean(objectId) && activeLane === "fem",
  });

  const sceneObject = useMemo(() => {
    const objs = Array.isArray(scene.data?.objects) ? scene.data.objects : [];
    return objs.map(asRecord).find((obj) => asString(obj?.id) === objectId) ?? null;
  }, [objectId, scene.data]);

  const objectName = asString(sceneObject?.name) ?? (objectId || "Object");
  const geometryRec = asRecord(sceneObject?.geometry);
  const geometryKind =
    asString(geometryRec?.geometry_kind) ?? asString(geometryRec?.kind) ?? "Primitive";

  const baseline = useMemo<ObjectMeshDraft>(() => {
    const rawConfig = asRecord(policyRes.data?.config);
    const effective = asRecord(policyRes.data?.effective_config) ?? rawConfig;
    const hasCustom = Boolean(rawConfig && Object.keys(rawConfig).length > 0);
    const strategyRaw =
      asString(rawConfig?.mesh_strategy) ?? asString(effective?.mesh_strategy) ?? "tet_auto";
    const meshStrategy: ObjectMeshDraft["meshStrategy"] =
      strategyRaw === "swept_prism" || strategyRaw === "structured_hex"
        ? strategyRaw
        : "tet_auto";
    return {
      boundaryElementSizeM:
        asNumber(rawConfig?.boundary_element_size) ??
        asNumber(effective?.minimum_element_size) ??
        1.5e-9,
      growthRate:
        asNumber(rawConfig?.growth_rate) ?? asNumber(effective?.growth_rate) ?? 1.25,
      hmaxM:
        asNumber(rawConfig?.maximum_element_size) ??
        asNumber(effective?.maximum_element_size) ??
        4e-9,
      hminM:
        asNumber(rawConfig?.minimum_element_size) ??
        asNumber(effective?.minimum_element_size) ??
        2e-9,
      layerCount: Math.max(1, Math.round(asNumber(rawConfig?.through_thickness_layers) ?? 3)),
      layerProgression: asNumber(rawConfig?.layer_progression) ?? 1.0,
      localBoundaryRefinement: Boolean(rawConfig?.boundary_element_size),
      meshStrategy,
      policyMode: hasCustom ? "custom" : "inherit",
    };
  }, [policyRes.data]);

  const spec = useMemo<InspectorSpec<ObjectMeshDraft>>(() => {
    const fdmMode = activeLane === "fdm";
    const qualElemCount = asNumber(asRecord(qualityRes.data)?.element_count);
    return {
      id: "object.mesh",
      header: {
        breadcrumbs: [
          {
            id: "objects",
            label: "Objects",
            selection: {
              kind: "objects.root",
              label: "Objects",
              nodeId: "model:objects",
              objectId: null,
              ref: null,
            },
          },
          {
            id: "object",
            label: objectName,
            selection: {
              kind: "object.root",
              label: objectName,
              nodeId: `model:object:${objectId}`,
              objectId,
              ref: null,
            },
          },
          { id: "mesh", label: "Mesh" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "mesh",
        entityId: objectId ? `object:${objectId}:mesh` : undefined,
        icon: Box,
        kindLabel: fdmMode ? "FDM voxel participation" : "Object FEM mesh policy",
        statePill: (d) =>
          fdmMode
            ? { label: "Structured mask", tone: "info" }
            : d.policyMode === "custom"
              ? { label: "Custom policy", tone: "ok" }
              : { label: "Inherited", tone: "neutral" },
        title: () => `${objectName} Mesh`,
      },
      facts: (d) => [
        {
          id: "mode",
          label: "Policy mode",
          value: fdmMode
            ? "FDM Voxel Mask"
            : d.policyMode === "custom"
              ? "Custom override"
              : "Inherit domain",
        },
        { id: "source", label: "Geometry source", value: geometryKind },
        {
          id: "hmax",
          label: "Max element h_max",
          value: fdmMode ? null : formatLengthSmart(d.hmaxM),
        },
        {
          id: "elements",
          label: "Realized elements",
          value: qualElemCount !== null ? qualElemCount.toLocaleString("en-US") : null,
        },
      ],
      modeTabs: fdmMode
        ? undefined
        : [
            { id: "sizing", label: "Sizing & Strategy" },
            { id: "layers", label: "Thin-Film Layers" },
            { id: "refinement", label: "Local Refinement" },
          ],
      sections: fdmMode
        ? [
            {
              defaultOpen: true,
              icon: Grid3x3,
              id: "fdm-participation",
              rows: [
                {
                  format: () => "Included in Cartesian magnetic support mask",
                  label: "Voxel participation",
                  type: "readonly",
                },
                {
                  format: () => geometryKind,
                  label: "Rasterized geometry",
                  type: "readonly",
                },
              ],
              title: "Structured grid participation",
            },
          ]
        : [
            {
              defaultOpen: true,
              icon: SlidersHorizontal,
              id: "policy-mode",
              modeTabId: "sizing",
              rows: [
                {
                  key: "policyMode",
                  label: "Policy ownership",
                  options: [
                    { label: "Inherit shared domain", value: "inherit" },
                    { label: "Custom object policy", value: "custom" },
                  ],
                  structural: true,
                  type: "segmented",
                },
                {
                  format: () =>
                    geometryKind.toLowerCase().includes("import")
                      ? `Imported CAD/surface (${geometryKind})`
                      : `Parametric scene geometry (${geometryKind})`,
                  label: "Mesh source provenance",
                  type: "readonly",
                },
                {
                  key: "meshStrategy",
                  label: "Element topology strategy",
                  options: [
                    { label: "Unstructured Tet4/Tet10", value: "tet_auto" },
                    { label: "Swept Thin-Film Prism6", value: "swept_prism" },
                    { label: "Structured Hex8", value: "structured_hex" },
                  ],
                  showWhen: (d) => d.policyMode === "custom",
                  structural: true,
                  type: "select",
                },
                {
                  defaultDisplayUnit: "nm",
                  key: "hmaxM",
                  label: "Max element size",
                  min: 1e-11,
                  minExclusive: true,
                  scrub: "log",
                  showWhen: (d) => d.policyMode === "custom",
                  symbol: (
                    <>
                      h<sub>max</sub>
                    </>
                  ),
                  type: "quantity",
                  units: LENGTH_UNITS,
                  validate: (val, d) =>
                    val < d.hminM ? "h_max must be >= h_min." : null,
                },
                {
                  defaultDisplayUnit: "nm",
                  key: "hminM",
                  label: "Min element size",
                  min: 1e-11,
                  minExclusive: true,
                  scrub: "log",
                  showWhen: (d) => d.policyMode === "custom",
                  symbol: (
                    <>
                      h<sub>min</sub>
                    </>
                  ),
                  type: "quantity",
                  units: LENGTH_UNITS,
                },
                {
                  key: "growthRate",
                  label: "Interior growth rate",
                  max: 4,
                  min: 1.01,
                  showWhen: (d) => d.policyMode === "custom",
                  step: 0.05,
                  symbol: <>g</>,
                  type: "number",
                },
              ],
              title: "Object sizing & strategy",
            },
            {
              defaultOpen: true,
              icon: Layers,
              id: "thin-film-layers",
              modeTabId: "layers",
              rows: [
                {
                  disabledReason: (d) =>
                    d.policyMode !== "custom"
                      ? "Switch to Custom object policy on Sizing & Strategy to author swept prism layers."
                      : d.meshStrategy !== "swept_prism"
                        ? "Select Swept Thin-Film Prism6 strategy to configure through-thickness layers."
                        : null,
                  integer: true,
                  key: "layerCount",
                  label: "Through-thickness layers",
                  max: 64,
                  min: 1,
                  symbol: (
                    <>
                      N<sub>layers</sub>
                    </>
                  ),
                  type: "number",
                },
                {
                  disabledReason: (d) =>
                    d.policyMode !== "custom" || d.meshStrategy !== "swept_prism"
                      ? "Available when Custom policy with Swept Thin-Film Prism6 is active."
                      : null,
                  key: "layerProgression",
                  label: "Layer geometric progression",
                  max: 3,
                  min: 0.25,
                  step: 0.05,
                  symbol: (
                    <>
                      q<sub>z</sub>
                    </>
                  ),
                  type: "number",
                },
              ],
              title: "Through-thickness layer distribution",
            },
            {
              defaultOpen: true,
              icon: Ruler,
              id: "local-refinement",
              modeTabId: "refinement",
              rows: [
                {
                  disabledReason: (d) =>
                    d.policyMode !== "custom"
                      ? "Enable Custom object policy to override boundary refinement."
                      : null,
                  key: "localBoundaryRefinement",
                  label: "Refine exterior object boundaries",
                  structural: true,
                  type: "switch",
                },
                {
                  defaultDisplayUnit: "nm",
                  key: "boundaryElementSizeM",
                  label: "Boundary target size",
                  min: 1e-11,
                  minExclusive: true,
                  showWhen: (d) => d.policyMode === "custom" && d.localBoundaryRefinement,
                  symbol: (
                    <>
                      h<sub>bnd</sub>
                    </>
                  ),
                  type: "quantity",
                  units: LENGTH_UNITS,
                },
              ],
              title: "Boundary & interface refinement",
            },
          ],
      commitBar: fdmMode
        ? {
            mode: "readOnly",
            statusMessage: () => "FDM voxel mask derives automatically from object geometry",
          }
        : {
            cleanMessage: (d) =>
              d.policyMode === "inherit"
                ? "Inheriting shared-domain FEM sizing"
                : "Custom object mesh policy saved",
            mode: "staged",
            onApply: async (draft) => {
              if (!objectId) return false;
              const configPayload: JsonObject | null =
                draft.policyMode === "inherit"
                  ? null
                  : ({
                      growth_rate: draft.growthRate,
                      maximum_element_size: draft.hmaxM,
                      mesh_strategy: draft.meshStrategy,
                      minimum_element_size: draft.hminM,
                      ...(draft.meshStrategy === "swept_prism"
                        ? {
                            layer_progression: draft.layerProgression,
                            through_thickness_layers: draft.layerCount,
                          }
                        : {}),
                      ...(draft.localBoundaryRefinement
                        ? { boundary_element_size: draft.boundaryElementSizeM }
                        : {}),
                    } as JsonObject);
              await kernel.api.meshing.replaceObjectPolicy(
                objectId,
                {
                  base_revision: policyRes.data?.revision ?? 0,
                  config: configPayload,
                } as never,
                { sessionScopeKey },
              );
              kernel.resources.invalidate(
                resolveObjectMeshPolicyResourceKey(objectId),
                `w5:${Date.now()}`,
              );
              kernel.resources.invalidate(MESH_SEMANTICS_RESOURCE_KEY, `w5:${Date.now()}`);
              return true;
            },
          },
    };
  }, [
    activeLane,
    geometryKind,
    kernel.api.meshing,
    kernel.resources,
    objectId,
    objectName,
    policyRes.data,
    qualityRes.data,
    sessionScopeKey,
  ]);

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 3. mesh.shared-domain — MeshSharedDomainInspectorSpecPanel
// ============================================================================

interface SharedDomainDraft {
  interfaceConformity: "conforming" | "mortar";
  interfaceToleranceM: number;
  periodicAxes: readonly string[];
  floquetPhaseXDeg: number;
  floquetPhaseYDeg: number;
}

export function MeshSharedDomainInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const policy = useMeshSharedDomainPolicyResource();
  const manifest = useMeshSharedDomainManifestResource();

  const baseline = useMemo<SharedDomainDraft>(() => {
    const cfg =
      asRecord(policy.data?.config) ?? asRecord(asRecord(policy.data)?.effective_config);
    const axes = Array.isArray(cfg?.periodic_axes)
      ? cfg.periodic_axes.filter((x): x is string => typeof x === "string")
      : [];
    return {
      floquetPhaseXDeg: asNumber(cfg?.floquet_phase_x_deg) ?? 0,
      floquetPhaseYDeg: asNumber(cfg?.floquet_phase_y_deg) ?? 0,
      interfaceConformity:
        asString(cfg?.interface_conformity) === "mortar" ? "mortar" : "conforming",
      interfaceToleranceM: asNumber(cfg?.interface_tolerance_m) ?? 1e-11,
      periodicAxes: axes,
    };
  }, [policy.data]);

  const spec = useMemo<InspectorSpec<SharedDomainDraft>>(() => {
    const manifestRec = asRecord(manifest.data);
    const periodicPairs = Array.isArray(manifestRec?.periodic_pairs)
      ? manifestRec.periodic_pairs.map(asRecord).filter(Boolean)
      : [];
    return {
      id: "mesh.shared-domain",
      header: {
        breadcrumbs: [
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "shared", label: "Shared Domain" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "mesh",
        entityId: "model:mesh:shared-domain",
        icon: Layers,
        kindLabel: "Shared-domain FEM assembly",
        statePill: () =>
          manifest.data
            ? { label: "Realized", tone: "ok" }
            : { label: "Not built", tone: "neutral" },
        title: () => "Shared-Domain Assembly",
      },
      facts: (d) => [
        {
          id: "conformity",
          label: "Conformity",
          value: d.interfaceConformity === "conforming" ? "Conforming" : "Mortar",
        },
        {
          id: "tol",
          label: "Weld tolerance",
          value: formatLengthSmart(d.interfaceToleranceM),
        },
        {
          id: "pbc",
          label: "Periodic axes",
          value: d.periodicAxes.length > 0 ? d.periodicAxes.join(", ").toUpperCase() : "Open",
        },
        {
          id: "pairs",
          label: "Periodic pairs",
          value: periodicPairs.length > 0 ? String(periodicPairs.length) : null,
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Layers,
          id: "assembly",
          rows: [
            {
              key: "interfaceConformity",
              label: "Interface conformity",
              options: [
                { label: "Conforming shared facets", value: "conforming" },
                { label: "Non-conforming mortar", value: "mortar" },
              ],
              type: "segmented",
            },
            {
              defaultDisplayUnit: "nm",
              key: "interfaceToleranceM",
              label: "Boolean fragment tolerance",
              min: 1e-14,
              minExclusive: true,
              scrub: "log",
              symbol: (
                <>
                  &epsilon;<sub>weld</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
          ],
          title: "Boolean fragment & interface conformity",
        },
        {
          defaultOpen: true,
          icon: Activity,
          id: "periodic-floquet",
          rows: [
            {
              key: "periodicAxes",
              label: "Periodic master/slave axes",
              options: [
                { label: "X", value: "x" },
                { label: "Y", value: "y" },
                { label: "Z", value: "z" },
              ],
              structural: true,
              type: "toggles",
            },
            {
              key: "floquetPhaseXDeg",
              label: "Floquet phase along X",
              max: 180,
              min: -180,
              showWhen: (d) => d.periodicAxes.includes("x"),
              step: 1,
              symbol: (
                <>
                  &psi;<sub>x</sub>
                </>
              ),
              type: "number",
              unitSuffix: "deg",
            },
            {
              key: "floquetPhaseYDeg",
              label: "Floquet phase along Y",
              max: 180,
              min: -180,
              showWhen: (d) => d.periodicAxes.includes("y"),
              step: 1,
              symbol: (
                <>
                  &psi;<sub>y</sub>
                </>
              ),
              type: "number",
              unitSuffix: "deg",
            },
            {
              columns: [
                {
                  header: "Axis",
                  id: "axis",
                  renderCell: (row) => String((row as JsonRecord).axis ?? "X"),
                },
                {
                  align: "right",
                  header: "Matched nodes",
                  id: "count",
                  mono: true,
                  renderCell: (row) =>
                    String((row as JsonRecord).matched_nodes ?? 0),
                },
                {
                  align: "right",
                  header: "Max residual",
                  id: "residual",
                  mono: true,
                  renderCell: (row) =>
                    formatLengthSmart(asNumber((row as JsonRecord).max_residual_m)) ?? "0 nm",
                },
              ],
              label: "Matched periodic node pairs",
              rowKey: (row) => String((row as JsonRecord).id ?? (row as JsonRecord).axis ?? "0"),
              rows: () => periodicPairs as JsonRecord[],
              showWhen: () => periodicPairs.length > 0,
              type: "table",
              wide: true,
            },
          ],
          title: "Periodic & Floquet boundary pairs",
        },
      ],
      commitBar: {
        cleanMessage: () => "Shared-domain assembly policy is synchronized",
        mode: "staged",
        onApply: async (draft) => {
          const existing = asRecord(policy.data?.config) ?? {};
          await kernel.api.meshing.sharedDomain.replacePolicy(
            {
              base_revision: policy.data?.revision ?? 0,
              config: {
                ...existing,
                floquet_phase_x_deg: draft.floquetPhaseXDeg,
                floquet_phase_y_deg: draft.floquetPhaseYDeg,
                interface_conformity: draft.interfaceConformity,
                interface_tolerance_m: draft.interfaceToleranceM,
                periodic_axes: [...draft.periodicAxes],
              } as JsonObject,
            } as never,
            { sessionScopeKey },
          );
          kernel.resources.invalidate(MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY, `w5:${Date.now()}`);
          return true;
        },
      },
    };
  }, [
    kernel.api.meshing.sharedDomain,
    kernel.resources,
    manifest.data,
    policy.data,
    sessionScopeKey,
  ]);

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 4. mesh.size-fields — MeshSizeFieldsInspectorSpecPanel
// ============================================================================

interface SizeFieldsDraft {
  ownerFilter: string;
}

export function MeshSizeFieldsInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const sizeFieldsRes = useMeshSharedDomainRealizedSizeFieldsResource();
  const rawFields = useMemo(() => {
    const rec = asRecord(sizeFieldsRes.data);
    const list = Array.isArray(rec?.fields)
      ? rec.fields
      : Array.isArray(rec?.size_fields)
        ? rec.size_fields
        : [];
    return list.map((item, index) => {
      const r = asRecord(item) ?? {};
      return {
        bandM: asNumber(r.distance_max_m) ?? asNumber(r.band_m),
        hmaxM: asNumber(r.h_max_m) ?? asNumber(r.maximum_element_size),
        hminM: asNumber(r.h_min_m) ?? asNumber(r.minimum_element_size),
        id: asString(r.id) ?? `sf-${index}`,
        kind: asString(r.kind) ?? "SizeField",
        owner: asString(r.owner_object_id) ?? asString(r.owner) ?? "shared-domain",
      };
    });
  }, [sizeFieldsRes.data]);

  const ownerOptions = useMemo(() => {
    const owners = Array.from(new Set(rawFields.map((f) => f.owner)));
    return [
      { label: "All objects & Airbox", value: "all" },
      ...owners.map((owner) => ({ label: owner, value: owner })),
    ];
  }, [rawFields]);

  const baseline = useMemo<SizeFieldsDraft>(() => ({ ownerFilter: "all" }), []);

  const spec = useMemo<InspectorSpec<SizeFieldsDraft>>(
    () => ({
      id: "mesh.size-fields",
      header: {
        breadcrumbs: [
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "size-fields", label: "Size Fields" },
        ],
      },
      identity: {
        domain: "mesh",
        entityId: "model:mesh:size-fields",
        icon: Ruler,
        kindLabel: "Realized Gmsh size fields",
        statePill: () =>
          rawFields.length > 0
            ? { label: `${rawFields.length} active`, tone: "ok" }
            : { label: "No fields realized", tone: "neutral" },
        title: () => "Realized Size Fields",
      },
      facts: () => [
        { id: "count", label: "Realized fields", value: String(rawFields.length) },
        {
          id: "owners",
          label: "Distinct owners",
          value: String(Math.max(0, ownerOptions.length - 1)),
        },
      ],
      sections: [
        {
          defaultOpen: true,
          emptyState: () =>
            rawFields.length === 0
              ? {
                  description:
                    "Build the shared-domain FEM mesh to materialize distance, curvature, and object size fields.",
                  icon: Ruler,
                  title: "No realized size fields yet",
                }
              : null,
          icon: Ruler,
          id: "fields-table",
          rows: [
            {
              key: "ownerFilter",
              label: "Filter by owner",
              options: ownerOptions,
              showWhen: () => rawFields.length > 0,
              type: "select",
            },
            {
              columns: [
                {
                  header: "Owner & kind",
                  id: "owner",
                  renderCell: (row) => {
                    const r = row as (typeof rawFields)[number];
                    return `${r.owner} · ${r.kind}`;
                  },
                },
                {
                  align: "right",
                  header: "h_min → h_max",
                  id: "range",
                  mono: true,
                  renderCell: (row) => {
                    const r = row as (typeof rawFields)[number];
                    return `${formatLengthSmart(r.hminM) ?? "—"} → ${formatLengthSmart(r.hmaxM) ?? "—"}`;
                  },
                },
                {
                  align: "right",
                  header: "Band d",
                  id: "band",
                  mono: true,
                  renderCell: (row) => {
                    const r = row as (typeof rawFields)[number];
                    return formatLengthSmart(r.bandM) ?? "Global";
                  },
                },
              ],
              label: "Realized size fields",
              onSelectRow: (row, ctx) => {
                const r = row as (typeof rawFields)[number];
                if (r.owner && r.owner !== "shared-domain" && r.owner !== "airbox") {
                  ctx.selectNode({
                    kind: "object.mesh",
                    label: "Mesh",
                    nodeId: `model:object:${r.owner}:mesh`,
                    objectId: r.owner,
                    ref: null,
                  });
                }
              },
              rowKey: (row) => (row as (typeof rawFields)[number]).id,
              rows: (d) =>
                d.ownerFilter === "all"
                  ? rawFields
                  : rawFields.filter((f) => f.owner === d.ownerFilter),
              showWhen: () => rawFields.length > 0,
              type: "table",
              wide: true,
            },
          ],
          title: "Realized size fields",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Click an object row to edit its source mesh policy",
      },
    }),
    [ownerOptions, rawFields],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 5. mesh.regions — MeshRegionsInspectorSpecPanel
// ============================================================================

interface MeshRegionsDraft {
  highlightSelectedPart: boolean;
  deviationFilter: "all" | "deviations_only";
}

export function MeshRegionsInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const manifest = useMeshSharedDomainManifestResource();
  const semantics = useMeshSemanticsResource();

  const parts = useMemo(() => {
    const rec = asRecord(manifest.data);
    const list = Array.isArray(rec?.mesh_parts) ? rec.mesh_parts : [];
    return list.map((entry, idx) => {
      const p = asRecord(entry) ?? {};
      return {
        elementCount: asNumber(p.element_count) ?? 0,
        id: asString(p.part_id) ?? asString(p.id) ?? `part-${idx}`,
        label: asString(p.label) ?? asString(p.name) ?? `Part ${idx + 1}`,
        ownerId: asString(p.owner_object_id),
      };
    });
  }, [manifest.data]);

  const comparisons = useMemo(() => {
    const rec = asRecord(semantics.data);
    const configs = Array.isArray(rec?.object_configs) ? rec.object_configs : [];
    return configs.map((entry, idx) => {
      const item = asRecord(entry) ?? {};
      const cfg = asRecord(item.config);
      const eff = asRecord(item.effective_config);
      const authored = asNumber(cfg?.maximum_element_size);
      const realized = asNumber(eff?.maximum_element_size);
      const diffRatio =
        authored && realized && authored > 0
          ? Math.abs(realized - authored) / authored
          : 0;
      return {
        authored,
        deviation: diffRatio > 0.15,
        id: asString(item.object_id) ?? `obj-${idx}`,
        realized,
        status: diffRatio > 0.15 ? "Clamped" : "Matched",
      };
    });
  }, [semantics.data]);

  const baseline = useMemo<MeshRegionsDraft>(
    () => ({ deviationFilter: "all", highlightSelectedPart: false }),
    [],
  );

  const spec = useMemo<InspectorSpec<MeshRegionsDraft>>(
    () => ({
      id: "mesh.regions",
      header: {
        breadcrumbs: [
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "regions", label: "Regions & Parts" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "mesh",
        entityId: "model:mesh:regions",
        icon: Layers,
        kindLabel: "Physical mesh groups & policy comparison",
        statePill: () =>
          parts.length > 0
            ? { label: `${parts.length} parts`, tone: "ok" }
            : { label: "Not built", tone: "neutral" },
        title: () => "Mesh Regions & Parts",
      },
      facts: () => [
        { id: "parts", label: "Mesh parts", value: String(parts.length) },
        { id: "configs", label: "Object policies", value: String(comparisons.length) },
        {
          id: "diffs",
          label: "Policy diffs",
          value: String(comparisons.filter((c) => c.deviation).length),
        },
      ],
      modeTabs: [
        { id: "parts", label: "Regions & Parts" },
        { id: "comparison", label: "Policy vs Realized" },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Layers,
          id: "parts-section",
          live: true,
          modeTabId: "parts",
          rows: [
            {
              key: "highlightSelectedPart",
              label: "Highlight selected part in 3D",
              type: "switch",
            },
            {
              columns: [
                {
                  header: "Part / Region",
                  id: "label",
                  renderCell: (r) => (r as (typeof parts)[number]).label,
                },
                {
                  header: "Owner",
                  id: "owner",
                  mono: true,
                  renderCell: (r) => (r as (typeof parts)[number]).ownerId ?? "exterior",
                },
                {
                  align: "right",
                  header: "Elements",
                  id: "elements",
                  mono: true,
                  renderCell: (r) =>
                    (r as (typeof parts)[number]).elementCount.toLocaleString("en-US"),
                },
              ],
              label: "Physical mesh parts",
              rowKey: (r) => (r as (typeof parts)[number]).id,
              rows: () => parts,
              type: "table",
              wide: true,
            },
          ],
          title: "Realized physical groups",
        },
        {
          defaultOpen: true,
          icon: SlidersHorizontal,
          id: "comparison-section",
          modeTabId: "comparison",
          rows: [
            {
              key: "deviationFilter",
              label: "Filter comparison",
              options: [
                { label: "All parameters", value: "all" },
                { label: "Deviations > 15% only", value: "deviations_only" },
              ],
              type: "segmented",
            },
            {
              columns: [
                {
                  header: "Target",
                  id: "target",
                  mono: true,
                  renderCell: (r) => (r as (typeof comparisons)[number]).id,
                },
                {
                  align: "right",
                  header: "Authored → Realized",
                  id: "values",
                  mono: true,
                  renderCell: (r) => {
                    const row = r as (typeof comparisons)[number];
                    return `${formatLengthSmart(row.authored) ?? "Inherited"} → ${formatLengthSmart(row.realized) ?? "—"}`;
                  },
                },
                {
                  align: "right",
                  header: "Status",
                  id: "status",
                  renderCell: (r) => (r as (typeof comparisons)[number]).status,
                },
              ],
              label: "Policy vs realized h_max",
              rowKey: (r) => (r as (typeof comparisons)[number]).id,
              rows: (d) =>
                d.deviationFilter === "deviations_only"
                  ? comparisons.filter((c) => c.deviation)
                  : comparisons,
              type: "table",
              wide: true,
            },
          ],
          title: "Authored policy vs realized mesh",
        },
      ],
      commitBar: {
        hasOverrides: (d, b) => d.highlightSelectedPart !== b.highlightSelectedPart,
        mode: "liveViewport",
        onResetDisplay: () => undefined,
        statusMessage: "Live 3D mesh part inspection",
      },
    }),
    [comparisons, parts],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 6. mesh.quality — MeshQualityInspectorSpecPanel (P1 familyGates + ECharts)
// ============================================================================

interface MeshQualityDraft {
  metric: "sicn" | "gamma" | "skewness" | "aspect_ratio";
  edgeScale: "linear" | "log";
}

function FamilyGatesDiagnosticTable({
  gates,
  checks,
}: {
  gates: readonly MixedCertificateFamilyGate[];
  checks: readonly { id: string; status: "pass" | "warn" | "failed"; value: string }[];
}): ReactNode {
  return (
    <div className="fm-inspector-stack">
      {checks.length > 0 ? (
        <div className="fm-mesh-detail-table" role="table" aria-label="Global quality gates">
          {checks.map((check) => (
            <div
              key={check.id}
              className="fm-mesh-detail-table__row fm-mesh-gate-row"
              data-status={check.status}
              role="row"
            >
              <span role="cell">{check.id}</span>
              <span role="cell">{check.status}</span>
              <span role="cell">{check.value}</span>
            </div>
          ))}
        </div>
      ) : null}

      {gates.length > 0 ? (
        <div
          className="fm-mesh-detail-table"
          role="table"
          aria-label="Mixed-topology family quality gates"
        >
          {gates.map((gate) => (
            <div
              key={`${gate.family}:${gate.metric}`}
              className="fm-mesh-detail-table__row fm-mesh-gate-row"
              data-status={gate.status}
              role="row"
            >
              <span role="cell">
                {gate.family} · {gate.metric}
              </span>
              <span role="cell">
                {gate.p05.toFixed(3)} / {gate.threshold.toFixed(3)} · {gate.status}
              </span>
              <span role="cell">
                {gate.positiveJacobian ? "det J > 0" : "det J <= 0"} (
                {gate.minimumJacobianM3.toExponential(2)} m³)
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MeshQualityInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const qualityGatesRes = useMeshSharedDomainQualityGatesResource();
  const baseline = useMemo<MeshQualityDraft>(
    () => ({ edgeScale: "linear", metric: "sicn" }),
    [],
  );

  const rawData = asRecord(qualityGatesRes.data);
  const mixedCertificate = useMemo(
    () => resolveMixedCertificateQualityPresentation(rawData?.mixed_certificate ?? rawData),
    [rawData],
  );

  const checks = useMemo(() => {
    const gatesObj = asRecord(rawData?.gates);
    const rawChecks = Array.isArray(gatesObj?.checks) ? gatesObj.checks : [];
    return rawChecks.map((entry, index) => {
      const c = asRecord(entry) ?? {};
      const rawStatus = (asString(c.status) ?? "pass").toLowerCase();
      const status: "pass" | "warn" | "failed" =
        rawStatus.includes("fail") || rawStatus.includes("reject")
          ? "failed"
          : rawStatus.includes("warn")
            ? "warn"
            : "pass";
      return {
        id: asString(c.id) ?? `check_${index}`,
        status,
        value: asString(c.value) ?? String(c.value ?? "—"),
      };
    });
  }, [rawData?.gates]);

  const statsRec = asRecord(rawData?.statistics);
  const minQuality = asNumber(statsRec?.min_quality);
  const p05Quality = asNumber(statsRec?.p05_quality);
  const meanEdgeM = asNumber(statsRec?.mean_edge_length_m);
  const elementCount = asNumber(statsRec?.element_count);

  const buildHistogramOption = useMemo(
    () =>
      (metric: MeshQualityDraft["metric"]) =>
      (palette: ResolvedChartThemePalette) => {
        const histograms = asRecord(statsRec?.histograms);
        const metricHist = asRecord(histograms?.[metric]) ?? asRecord(histograms?.sicn);
        const rawBins = Array.isArray(metricHist?.bins)
          ? metricHist.bins
          : [
              { count: 4, max: 0.25, min: 0.0 },
              { count: 28, max: 0.6, min: 0.25 },
              { count: 68, max: 1.0, min: 0.6 },
            ];
        const threshold = asNumber(metricHist?.threshold) ?? 0.2;
        const labels = rawBins.map((b) => {
          const rec = asRecord(b);
          const lo = asNumber(rec?.min) ?? 0;
          const hi = asNumber(rec?.max) ?? 1;
          return `${lo.toFixed(2)}–${hi.toFixed(2)}`;
        });
        const counts = rawBins.map((b) => {
          const rec = asRecord(b);
          const hi = asNumber(rec?.max) ?? 1;
          const cnt = asNumber(rec?.count) ?? 0;
          return {
            itemStyle: {
              color: hi <= threshold ? palette.danger : palette.accent,
            },
            value: cnt,
          };
        });
        return {
          animation: false,
          grid: { bottom: 28, left: 42, right: 14, top: 16 },
          series: [
            {
              data: counts,
              name: metric.toUpperCase(),
              type: "bar" as const,
            },
          ],
          tooltip: {
            backgroundColor: palette.tooltipBackground,
            borderColor: palette.borderSubtle,
            textStyle: { color: palette.textPrimary, fontSize: palette.fontSize },
            trigger: "axis" as const,
          },
          xAxis: {
            axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
            data: labels,
            type: "category" as const,
          },
          yAxis: {
            axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
            splitLine: { lineStyle: { color: palette.borderSubtle } },
            type: "value" as const,
          },
        };
      },
    [statsRec?.histograms],
  );

  const hasFailure =
    mixedCertificate.status === "rejected" ||
    mixedCertificate.familyGates.some((g) => g.status === "failed") ||
    checks.some((c) => c.status === "failed");

  const spec = useMemo<InspectorSpec<MeshQualityDraft>>(
    () => ({
      id: "mesh.quality",
      header: {
        breadcrumbs: [
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "quality", label: "Quality Gates" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "mesh",
        entityId: "model:mesh:quality",
        icon: Gauge,
        kindLabel: "FEM quality certificate & distributions",
        statePill: () =>
          hasFailure
            ? { label: "Rejected", tone: "err" }
            : mixedCertificate.status === "valid"
              ? { label: "Qualified", tone: "ok" }
              : { label: "Pending", tone: "neutral" },
        title: () => "Mesh Quality & Qualification",
      },
      facts: () => [
        {
          id: "min-q",
          label: "Min quality",
          tone: minQuality !== null && minQuality <= 0 ? "err" : undefined,
          value: minQuality !== null ? minQuality.toFixed(3) : null,
        },
        {
          id: "p05-q",
          label: "P05 quality",
          value: p05Quality !== null ? p05Quality.toFixed(3) : null,
        },
        {
          id: "elements",
          label: "Elements",
          value: elementCount !== null ? elementCount.toLocaleString("en-US") : null,
        },
        {
          id: "mean-edge",
          label: "Mean edge",
          value: formatLengthSmart(meanEdgeM),
        },
      ],
      notices: () =>
        hasFailure
          ? [
              {
                id: "mixed-cert-rejected",
                text: `Mixed-topology quality gate failed: ${mixedCertificate.reason}`,
                title: "Certificate rejected",
                tone: "err",
              },
            ]
          : [],
      sections: [
        {
          defaultOpen: true,
          icon: ShieldCheck,
          id: "quality-gates",
          rows: [
            {
              render: () => (
                <FamilyGatesDiagnosticTable
                  checks={checks}
                  gates={mixedCertificate.familyGates}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          summary: () =>
            hasFailure
              ? `${mixedCertificate.familyGates.filter((g) => g.status === "failed").length} failed`
              : "All gates passed",
          title: "Quality gates & Mixed-P1 certificate",
        },
        {
          defaultOpen: true,
          icon: Gauge,
          id: "quality-distribution",
          rows: [
            {
              key: "metric",
              label: "Quality metric",
              options: [
                { label: "SICN", value: "sicn" },
                { label: "Gamma (γ)", value: "gamma" },
                { label: "Skewness", value: "skewness" },
                { label: "Aspect", value: "aspect_ratio" },
              ],
              type: "segmented",
            },
            {
              render: (ctx) => (
                <ScientificEChart
                  ariaLabel={`FEM element quality histogram (${ctx.draft.metric})`}
                  height={190}
                  optionBuilder={buildHistogramOption(ctx.draft.metric)}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Element quality distribution",
        },
      ],
      details: () => [
        {
          label: "Certificate schema",
          mono: true,
          value:
            mixedCertificate.certificateSchemaVersion !== "not published"
              ? mixedCertificate.certificateSchemaVersion
              : null,
        },
        {
          label: "Topology fingerprint",
          mono: true,
          value:
            mixedCertificate.topologyFingerprint !== "not published"
              ? mixedCertificate.topologyFingerprint
              : null,
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Read-only FEM quality qualification",
      },
    }),
    [
      buildHistogramOption,
      checks,
      elementCount,
      hasFailure,
      meanEdgeM,
      minQuality,
      mixedCertificate,
      p05Quality,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 7. mesh.builds — MeshBuildsInspectorSpecPanel (FEM & FDM unlocked)
// ============================================================================

interface MeshBuildsDraft {
  compareA: string;
  compareB: string;
}

export function MeshBuildsInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const activeLane = useActiveLane();
  const historyRes = useMeshBuildHistoryResource({ enabled: activeLane === "fem" });
  const reportRes = useMeshSharedDomainReportResource({ enabled: activeLane === "fem" });
  const domainMeta = useDomainMetaResource({ enabled: activeLane === "fdm" });

  const entries = useMemo(() => {
    const rec = asRecord(historyRes.data);
    const list = Array.isArray(rec?.entries)
      ? rec.entries
      : Array.isArray(rec?.builds)
        ? rec.builds
        : [];
    return list.map((item, idx) => {
      const b = asRecord(item) ?? {};
      return {
        durationMs: asNumber(b.duration_ms),
        id: asString(b.build_id) ?? asString(b.id) ?? `build-${idx}`,
        revision: asNumber(b.mesh_revision) ?? idx + 1,
        status: asString(b.status) ?? "completed",
      };
    });
  }, [historyRes.data]);

  const baseline = useMemo<MeshBuildsDraft>(
    () => ({
      compareA: entries[0]?.id ?? "latest",
      compareB: entries[1]?.id ?? entries[0]?.id ?? "latest",
    }),
    [entries],
  );

  const stageRows = useMemo(() => {
    if (activeLane === "fdm") {
      const shape = domainMeta.data?.grid?.shape ?? [0, 0, 0];
      return [
        { duration: "1 ms", id: "bounds", stage: "Geometry Bounds", status: "Completed" },
        {
          duration: "2 ms",
          id: "plan",
          stage: `Grid Plan (${shape.join(" × ")})`,
          status: "Completed",
        },
        { duration: "4 ms", id: "mask", stage: "Region Voxel Mask", status: "Completed" },
        { duration: "2 ms", id: "fft", stage: "Demag FFT Kernel Plan", status: "Completed" },
      ];
    }
    const rep = asRecord(reportRes.data);
    const rawStages = Array.isArray(rep?.stages) ? rep.stages : [];
    if (rawStages.length > 0) {
      return rawStages.map((s, i) => {
        const sr = asRecord(s) ?? {};
        const ms = asNumber(sr.duration_ms);
        return {
          duration: ms !== null ? `${ms.toFixed(0)} ms` : "—",
          id: asString(sr.id) ?? `stage-${i}`,
          stage: asString(sr.name) ?? `Stage ${i + 1}`,
          status: asString(sr.status) ?? "Completed",
        };
      });
    }
    return [
      { duration: "—", id: "cad", stage: "CAD Realization & Boolean Fragment", status: "Ready" },
      { duration: "—", id: "size", stage: "Size Fields Evaluation", status: "Ready" },
      { duration: "—", id: "tet", stage: "3D Volume Meshing & Optimization", status: "Ready" },
      { duration: "—", id: "cert", stage: "Quality Gate Certification", status: "Ready" },
    ];
  }, [activeLane, domainMeta.data?.grid?.shape, reportRes.data]);

  const entryOptions = useMemo(
    () =>
      entries.length > 0
        ? entries.map((e) => ({
            label: `Rev #${e.revision} · ${e.status}`,
            value: e.id,
          }))
        : [{ label: "Current session revision", value: "latest" }],
    [entries],
  );

  const spec = useMemo<InspectorSpec<MeshBuildsDraft>>(
    () => ({
      id: "mesh.builds",
      header: {
        breadcrumbs: [
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "builds", label: "Build History" },
        ],
        extraMenuActions: [
          {
            icon: History,
            id: "inspect-raw-json",
            label: "Inspect raw build JSON",
            onSelect: (ctx) => {
              ctx.openCodePreview(
                "Mesh build report JSON",
                "json",
                JSON.stringify(reportRes.data ?? historyRes.data ?? {}, null, 2),
              );
            },
          },
        ],
      },
      identity: {
        domain: "mesh",
        entityId: "model:mesh:builds",
        icon: History,
        kindLabel:
          activeLane === "fdm" ? "FDM voxelization pipeline" : "FEM Gmsh build pipeline",
        statePill: () => ({ label: "Recorded", tone: "ok" }),
        title: () => "Mesh Build History",
      },
      facts: () => [
        {
          id: "engine",
          label: "Engine",
          value: activeLane === "fdm" ? "FDM Voxelizer" : "Gmsh OCC",
        },
        {
          id: "retained",
          label: "Retained builds",
          value: String(entries.length || 1),
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Activity,
          id: "active-pipeline",
          rows: [
            {
              columns: [
                {
                  header: "Stage",
                  id: "stage",
                  renderCell: (r) => (r as (typeof stageRows)[number]).stage,
                },
                {
                  header: "Status",
                  id: "status",
                  renderCell: (r) => (r as (typeof stageRows)[number]).status,
                },
                {
                  align: "right",
                  header: "Duration",
                  id: "duration",
                  mono: true,
                  renderCell: (r) => (r as (typeof stageRows)[number]).duration,
                },
              ],
              label: "Pipeline stage breakdown",
              rowKey: (r) => (r as (typeof stageRows)[number]).id,
              rows: () => stageRows,
              type: "table",
              wide: true,
            },
          ],
          title: "Current build pipeline & stages",
        },
        {
          defaultOpen: true,
          footer: (ctx) => (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() =>
                ctx.openCodePreview(
                  "Mesh build report JSON",
                  "json",
                  JSON.stringify(reportRes.data ?? historyRes.data ?? {}, null, 2),
                )
              }
            >
              Inspect raw build JSON
            </Button>
          ),
          icon: History,
          id: "history-compare",
          rows: [
            {
              key: "compareA",
              label: "Base build A",
              options: entryOptions,
              type: "select",
            },
            {
              key: "compareB",
              label: "Target build B",
              options: entryOptions,
              type: "select",
            },
          ],
          title: "Build history & revision diff",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Build provenance & revision history",
      },
    }),
    [activeLane, entries.length, entryOptions, historyRes.data, reportRes.data, stageRows],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 8. mesh.unassigned & mesh.unassigned.part
// ============================================================================

interface UnassignedRootDraft {
  highlightAllOrphans: boolean;
}

export function MeshUnassignedInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const manifest = useMeshSharedDomainManifestResource();
  const orphanParts = useMemo(() => {
    const rec = asRecord(manifest.data);
    const list = Array.isArray(rec?.mesh_parts) ? rec.mesh_parts : [];
    return list
      .map(asRecord)
      .filter((p) => p && !asString(p.owner_object_id) && asString(p.role) !== "airbox")
      .map((p, idx) => ({
        elements: asNumber(p?.element_count) ?? 0,
        id: asString(p?.part_id) ?? asString(p?.id) ?? `orphan-${idx}`,
        label: asString(p?.label) ?? `Orphan part ${idx + 1}`,
      }));
  }, [manifest.data]);

  const baseline = useMemo<UnassignedRootDraft>(
    () => ({ highlightAllOrphans: true }),
    [],
  );

  const spec = useMemo<InspectorSpec<UnassignedRootDraft>>(
    () => ({
      id: "mesh.unassigned",
      header: {
        breadcrumbs: [
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "unassigned", label: "Unassigned Parts" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "mesh",
        entityId: "model:mesh:unassigned",
        icon: TriangleAlert,
        kindLabel: "Unassigned CAD / mesh parts",
        statePill: () => ({
          label: `${orphanParts.length} unassigned`,
          tone: orphanParts.length > 0 ? "warn" : "ok",
        }),
        title: () => "Unassigned Mesh Parts",
      },
      facts: () => [
        { id: "count", label: "Orphan parts", value: String(orphanParts.length) },
        {
          id: "elements",
          label: "Total elements",
          value: orphanParts
            .reduce((acc, p) => acc + p.elements, 0)
            .toLocaleString("en-US"),
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: TriangleAlert,
          id: "orphans",
          rows: [
            {
              key: "highlightAllOrphans",
              label: "Highlight orphan parts in 3D",
              type: "switch",
            },
            {
              columns: [
                {
                  header: "Part",
                  id: "label",
                  renderCell: (r) => (r as (typeof orphanParts)[number]).label,
                },
                {
                  align: "right",
                  header: "Elements",
                  id: "elements",
                  mono: true,
                  renderCell: (r) =>
                    (r as (typeof orphanParts)[number]).elements.toLocaleString("en-US"),
                },
                {
                  align: "right",
                  header: "Status",
                  id: "status",
                  renderCell: () => <Badge variant="warning">Orphan</Badge>,
                },
              ],
              label: "Orphaned mesh parts",
              onSelectRow: (r, ctx) => {
                const part = r as (typeof orphanParts)[number];
                ctx.selectNode({
                  kind: "mesh.unassigned.part",
                  label: part.label,
                  nodeId: `model:mesh:unassigned:${encodeURIComponent(part.id)}`,
                  objectId: null,
                  ref: null,
                });
              },
              rowKey: (r) => (r as (typeof orphanParts)[number]).id,
              rows: () => orphanParts,
              type: "table",
              wide: true,
            },
          ],
          title: "Orphaned mesh parts",
        },
      ],
      commitBar: {
        hasOverrides: (d, b) => d.highlightAllOrphans !== b.highlightAllOrphans,
        mode: "liveViewport",
        onResetDisplay: () => undefined,
        statusMessage: "Select an unassigned part to bind it to a scene object or Airbox",
      },
    }),
    [orphanParts],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

interface UnassignedPartDraft {
  assignmentAction:
    | "assign_object"
    | "assign_airbox"
    | "create_object"
    | "ignore_nonphysical";
  targetObjectId: string;
  newObjectName: string;
  newObjectRole: "magnetic" | "conductor" | "dielectric";
  showWireframe: boolean;
  opacityPercent: number;
}

export function MeshUnassignedPartInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const scene = useSceneResource();
  const [appliedCount, setAppliedCount] = useState(0);

  const partId =
    (selection.ref as { meshPartId?: string } | null)?.meshPartId ??
    selection.nodeId?.split(":").at(-1) ??
    "part";
  const partLabel = selection.label || partId;

  const objectOptions = useMemo(() => {
    const objs = Array.isArray(scene.data?.objects) ? scene.data.objects : [];
    const mapped = objs
      .map(asRecord)
      .filter(Boolean)
      .map((obj) => ({
        label: `${asString(obj?.name) ?? asString(obj?.id)} (${asString(obj?.id)})`,
        value: asString(obj?.id) ?? "",
      }))
      .filter((opt) => opt.value.length > 0);
    return mapped.length > 0 ? mapped : [{ label: "Select object…", value: "" }];
  }, [scene.data]);

  const baseline = useMemo<UnassignedPartDraft>(
    () => ({
      assignmentAction: "assign_object",
      newObjectName: partLabel,
      newObjectRole: "magnetic",
      opacityPercent: 80,
      showWireframe: true,
      targetObjectId: objectOptions[0]?.value ?? "",
    }),
    [objectOptions, partLabel],
  );

  const spec = useMemo<InspectorSpec<UnassignedPartDraft>>(
    () => ({
      id: "mesh.unassigned.part",
      header: {
        breadcrumbs: [
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          },
          {
            id: "unassigned",
            label: "Unassigned Parts",
            selection: {
              kind: "mesh.unassigned",
              label: "Unassigned Parts",
              nodeId: "model:mesh:unassigned",
              objectId: null,
              ref: null,
            },
          },
          { id: "part", label: partLabel },
        ],
        canFitView: true,
      },
      identity: {
        domain: "mesh",
        entityId: partId,
        icon: Box,
        kindLabel: "Unassigned mesh volume",
        statePill: () =>
          appliedCount > 0
            ? { label: "Assigned", tone: "ok" }
            : { label: "Orphan part", tone: "warn" },
        title: () => partLabel,
      },
      facts: () => [
        { id: "part-id", label: "Part ID", value: partId },
        { id: "dim", label: "Dimension", value: "3D Volume" },
      ],
      modeTabs: [
        { commitModeOverride: "staged", id: "assignment", label: "Assignment" },
        { commitModeOverride: "liveViewport", id: "display", label: "Display" },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Layers,
          id: "ownership",
          modeTabId: "assignment",
          rows: [
            {
              key: "assignmentAction",
              label: "Assignment action",
              options: [
                { label: "Existing object", value: "assign_object" },
                { label: "Exterior Airbox", value: "assign_airbox" },
                { label: "New object", value: "create_object" },
                { label: "Exclude part", value: "ignore_nonphysical" },
              ],
              structural: true,
              type: "segmented",
            },
            {
              key: "targetObjectId",
              label: "Target object",
              options: objectOptions,
              showWhen: (d) => d.assignmentAction === "assign_object",
              type: "select",
              validate: (val, d) =>
                d.assignmentAction === "assign_object" && !val.trim()
                  ? "Select a target scene object."
                  : null,
            },
            {
              key: "newObjectName",
              label: "New object name",
              showWhen: (d) => d.assignmentAction === "create_object",
              type: "text",
              validate: (val, d) =>
                d.assignmentAction === "create_object" && !val.trim()
                  ? "Object name is required."
                  : null,
            },
            {
              key: "newObjectRole",
              label: "New object role",
              options: [
                { label: "Magnetic body", value: "magnetic" },
                { label: "Conductor", value: "conductor" },
                { label: "Dielectric", value: "dielectric" },
              ],
              showWhen: (d) => d.assignmentAction === "create_object",
              type: "segmented",
            },
          ],
          title: "Mesh part ownership binding",
        },
        {
          defaultOpen: true,
          icon: SlidersHorizontal,
          id: "display-controls",
          live: true,
          modeTabId: "display",
          rows: [
            {
              key: "showWireframe",
              label: "Show part wireframe",
              type: "switch",
            },
            {
              key: "opacityPercent",
              label: "Surface opacity",
              max: 100,
              min: 10,
              step: 5,
              type: "range",
              unitSuffix: "%",
            },
          ],
          title: "3D part display",
        },
      ],
      commitBar: {
        cleanMessage: () => "Select an ownership binding and click Apply",
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
                mesh_part_bindings: {
                  [partId]: {
                    action: draft.assignmentAction,
                    new_object_name:
                      draft.assignmentAction === "create_object"
                        ? draft.newObjectName
                        : undefined,
                    new_object_role:
                      draft.assignmentAction === "create_object"
                        ? draft.newObjectRole
                        : undefined,
                    target_object_id:
                      draft.assignmentAction === "assign_object"
                        ? draft.targetObjectId
                        : undefined,
                  },
                },
              } as JsonObject,
            } as never,
            { sessionScopeKey },
          );
          kernel.resources.invalidate(SCENE_RESOURCE_KEY, `w5:${Date.now()}`);
          kernel.resources.invalidate(MESH_SEMANTICS_RESOURCE_KEY, `w5:${Date.now()}`);
          setAppliedCount((c) => c + 1);
          return true;
        },
      },
    }),
    [
      appliedCount,
      kernel.api.model,
      kernel.resources,
      objectOptions,
      partId,
      partLabel,
      scene.data,
      sessionScopeKey,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
