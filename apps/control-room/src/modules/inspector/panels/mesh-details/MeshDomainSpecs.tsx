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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import type {
  AuthoringTransactionRequest,
  JsonObject,
  MeshUniverseConfigResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { restoreMeshHistoryToDraft } from "@/kernel/authoring/meshBuildHistoryRestore";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import * as meshPolicyResourceCache from "@/kernel/resources/meshPolicyResourceCache";
import {
  resolveSessionAuthoringDiscretization,
  resolveSessionDiscretization,
} from "@/kernel/resources/sessionDiscretization";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import * as sessionStatusHooks from "@/kernel/resources/useSessionStatus";
import type { VisualizationRenderMode } from "@/kernel/visualization/ObjectVisualizationController";
import {
  normalizeMeshBuildHistory,
  type MeshBuildHistoryEntry,
} from "@/shared/domain/mesh/meshBuildHistory";
import { resolveMeshBuildFreshness } from "@/shared/domain/mesh/meshBuildFreshness";
import { resolveMeshEditorCapabilities } from "@/shared/domain/mesh/meshEditorCapabilityModel";
import { diffMeshPolicies, type MeshPolicyDiffRow } from "@/shared/domain/mesh/meshPolicyDiff";
import { resolveMeshQualityRefinementState } from "@/shared/domain/mesh/meshQualityRefinement";
import {
  normalizeMeshQualityStatistics,
  type MeshQualityMetric,
  type MeshQualityStatistics,
  type MeshWorstElement,
} from "@/shared/domain/mesh/qualityStatistics";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorNotice,
  InspectorSpec,
  InspectorTone,
  UnitOption,
} from "../../template";
import {
  buildAirboxMeshPolicyReplaceRequest,
  draftFromEffectiveUniverseMeshPolicyResource,
  draftFromUniverseMeshPolicyResource,
  rebaseAirboxMeshPolicyDraft,
} from "../airbox/airboxMeshPolicyDraft";
import { FemMeshReadinessGuideCard } from "../mesh-guide/FemMeshReadinessGuideCard";
import { MeshPartVisualizationPanel } from "../MeshPartVisualizationPanel";
import type { MeshSizeDistributionHoverBin } from "../MeshQualityChart";
import { recordField } from "../MeshResourceView";
import { emitMeshSizeHistogramHover } from "../meshSizeHistogramHover";
import { sizeFieldParamSummary } from "./meshDetailsSectionUtils";
import {
  formatCountClean,
  MeshBuildHistorySpecView,
  MeshEditorCapabilitiesSpecView,
  MeshQualityStatisticsSpecView,
  MixedTopologyProvenanceSpecView,
  OperationStatusesSpecView,
  QualityGatesSpecView,
  sanitizeMeshDisplayText,
  ThinFilmDiagnosticsSpecView,
} from "./MeshQualityAndHistorySpecViews";
import { resolveMixedCertificateQualityPresentation } from "./MeshQualityGatesSection.model";
import { resolveMeshTopologyCounts } from "./meshTopologyCounts";
import { resolveMixedTopologyPresentation } from "./MixedTopologyProvenanceSection.model";
import {
  buildSharedDomainPolicyConfig,
  draftFromEffectiveSharedDomainResource,
  draftFromSharedDomainResource,
  formatPolicyJson,
  type SharedDomainPolicyDraft,
} from "./sharedDomainMeshPolicyDraft";
import { SpecInspectorHost } from "./SpecInspectorHost";
import {
  buildSharedDomainPolicyDiffRows,
  resolveCurrentMixedCertificateQualityPresentation,
  resolveRetainedMeshArtifact,
} from "./useMeshDetailsModel";

export { ObjectMeshInspectorSpecPanel } from "./ObjectMeshSpecPanel";

const MU0 = 4 * Math.PI * 1e-7;

function safeModField<M extends object, K extends keyof M>(
  mod: M,
  key: K,
): M[K] | undefined {
  return key in mod ? mod[key] : undefined;
}

const SESSION_STATUS_KEY =
  safeModField(sessionStatusHooks, "SESSION_STATUS_RESOURCE_KEY") ??
  "/session/status";

const useSafeMeshCapabilitiesResource =
  safeModField(geometryLifecycleResources, "useMeshCapabilitiesResource") ??
  (() =>
    emptyResource<Parameters<typeof resolveMeshEditorCapabilities>[0]>());
const useSafeMeshBuildLatestSuccessful =
  safeModField(geometryLifecycleResources, "useMeshBuildLatestSuccessful") ??
  (() => emptyResource<{ last_build_error?: unknown; last_success?: unknown }>());
const useSafeMeshSharedDomainQualityResource =
  safeModField(
    geometryLifecycleResources,
    "useMeshSharedDomainQualityResource",
  ) ?? (() => emptyResource<{ quality?: unknown }>());

const LENGTH_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "nm", toSiFactor: 1e-9 },
  { unit: "µm", toSiFactor: 1e-6 },
  { unit: "mm", toSiFactor: 1e-3 },
  { unit: "m", toSiFactor: 1 },
];

type JsonRecord = Record<string, unknown>;

function emptyResource<T>() {
  return {
    data: null as T | null,
    error: null,
    refetch: () => Promise.resolve(null),
    revision: 0,
    status: "ready" as const,
  };
}

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

function snapSevenSmooth(n: number): number {
  const start = Math.max(1, Math.round(n));
  for (let candidate = start; candidate <= start * 4 + 8; candidate += 1) {
    let rem = candidate;
    for (const p of [2, 3, 5, 7]) {
      while (rem % p === 0) rem /= p;
    }
    if (rem === 1) return candidate;
  }
  return start;
}

function useActiveLane(): "fdm" | "fem" | "unresolved" {
  const resolved = sessionStatusHooks.useSessionStatusSelector(
    (status) =>
      resolveSessionDiscretization(status.data) ??
      resolveSessionAuthoringDiscretization(status.data),
  );
  return resolved ?? "unresolved";
}

function buildSafeMutationContext(
  kernel: ReturnType<typeof useKernel>,
  sessionScopeKey: string | undefined,
  sourceDetail: string,
) {
  const hasScopeGetter = typeof kernel.commands?.getSessionScopeKey === "function";
  const base = createCommandContext("inspector", kernel, {
    isCurrentSessionScope: sessionScopeKey
      ? hasScopeGetter
        ? () => kernel.commands.getSessionScopeKey?.() === sessionScopeKey
        : () => true
      : () => true,
    sessionScopeKey: sessionScopeKey ?? null,
    sourceDetail,
  });
  return {
    ...base,
    selection:
      typeof kernel.selection?.get === "function" ? kernel.selection : undefined,
  };
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
  growthRate: number;
  curvatureFactor: number;
  narrowRegionResolution: number;
  enableNarrowRegionRefinement: boolean;
  elementsAcrossThickness: number;
  anisotropyLimit: number;
  optimizeMethod: string;
  optimizeQuality: boolean;
}

export function MeshRootInspectorSpecPanel({ selection }: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionIdentity = sessionStatusHooks.useSessionResourceIdentity();
  const sessionScopeKey = sessionRequestScopeKey(sessionIdentity) ?? undefined;
  const activeLane = useActiveLane();
  const femActive = activeLane === "fem";
  const fdmActive = activeLane === "fdm";

  const scene = geometryLifecycleResources.useSceneResource({
    enabled: activeLane !== "unresolved",
  });
  const domainMeta = geometryLifecycleResources.useDomainMetaResource({
    enabled: fdmActive,
  });
  const multilayer = geometryLifecycleResources.useFdmMultilayerLayoutResource({
    enabled: fdmActive,
  });
  const sharedPolicy = geometryLifecycleResources.useMeshSharedDomainPolicyResource({
    enabled: femActive,
  });
  const universePolicy = geometryLifecycleResources.useUniverseMeshPolicyResource({
    enabled: activeLane !== "unresolved",
  });
  const manifest = geometryLifecycleResources.useMeshSharedDomainManifestResource({
    enabled: femActive,
  });
  const activeBuild = geometryLifecycleResources.useMeshBuildCurrent({
    enabled: femActive,
  });
  const summary = geometryLifecycleResources.useMeshSummaryResource({
    enabled: femActive,
  });

  const baseline = useMemo<MeshRootDraft>(() => {
    const grid = domainMeta.data?.grid;
    const studyRec = asRecord(asRecord(scene.data)?.study);
    const fdmRec = asRecord(studyRec?.fdm);
    const demagRec = asRecord(fdmRec?.demag);
    const authoredCell = Array.isArray(fdmRec?.default_cell)
      ? (fdmRec.default_cell as unknown[]).map(asNumber)
      : [];
    const spacing = grid?.spacing ?? [4e-9, 4e-9, 2e-9];
    const shape = grid?.shape ?? [128, 64, 1];
    const commonCells = Array.isArray(demagRec?.common_cells)
      ? (demagRec.common_cells as unknown[]).map(asNumber)
      : Array.isArray(demagRec?.common_cells_xy)
        ? [
            asNumber((demagRec.common_cells_xy as unknown[])[0]),
            asNumber((demagRec.common_cells_xy as unknown[])[1]),
            1,
          ]
        : [];

    const sharedCfg =
      asRecord(sharedPolicy.data?.config) ??
      asRecord(asRecord(sharedPolicy.data)?.effective_config);
    const universeCfg =
      asRecord(universePolicy.data?.config) ??
      asRecord(universePolicy.data?.effective_config);
    const narrowObj =
      asRecord(sharedCfg?.narrow_region_resolution) ??
      asRecord(universeCfg?.narrow_region_resolution);

    const optRaw = sharedCfg?.optimize;
    const optimizeMethod =
      typeof optRaw === "string" && optRaw.trim().length > 0
        ? optRaw.trim()
        : "Netgen";
    const optimizeQuality =
      typeof optRaw === "string"
        ? optRaw.trim().length > 0
        : sharedCfg?.optimize_quality !== false;

    const demagMode = asString(demagRec?.mode);
    const demagStrategy = asString(demagRec?.strategy);
    const isMultilayer =
      demagMode === "two_d_stack" ||
      demagStrategy === "multilayer_convolution" ||
      Boolean(multilayer.data?.available);

    return {
      anisotropyLimit:
        asNumber(narrowObj?.anisotropy_limit) ??
        asNumber(sharedCfg?.anisotropy_limit) ??
        asNumber(universeCfg?.anisotropy_limit) ??
        5,
      cellSizeM: [
        authoredCell[0] && authoredCell[0] > 0
          ? authoredCell[0]
          : spacing[0] && spacing[0] > 0
            ? spacing[0]
            : 4e-9,
        authoredCell[1] && authoredCell[1] > 0
          ? authoredCell[1]
          : spacing[1] && spacing[1] > 0
            ? spacing[1]
            : 4e-9,
        authoredCell[2] && authoredCell[2] > 0
          ? authoredCell[2]
          : spacing[2] && spacing[2] > 0
            ? spacing[2]
            : 2e-9,
      ],
      curvatureFactor:
        asNumber(sharedCfg?.curvature_factor) ??
        asNumber(universeCfg?.airbox_curvature_factor) ??
        0.35,
      elementsAcrossThickness:
        asNumber(narrowObj?.elements_across_thickness) ??
        asNumber(sharedCfg?.elements_across_thickness) ??
        asNumber(universeCfg?.elements_across_thickness) ??
        2,
      enableNarrowRegionRefinement:
        typeof narrowObj?.enable_narrow_region_refinement === "boolean"
          ? narrowObj.enable_narrow_region_refinement
          : typeof sharedCfg?.enable_narrow_region_refinement === "boolean"
            ? (sharedCfg.enable_narrow_region_refinement as boolean)
            : Boolean(
                asNumber(sharedCfg?.narrow_region_resolution) ??
                  asNumber(universeCfg?.airbox_narrow_region_resolution),
              ),
      fftSmoothSnap: typeof demagRec?.explain === "boolean" ? demagRec.explain : true,
      gridCountX:
        commonCells[0] && commonCells[0] > 0
          ? commonCells[0]
          : shape[0] && shape[0] > 0
            ? shape[0]
            : 128,
      gridCountY:
        commonCells[1] && commonCells[1] > 0
          ? commonCells[1]
          : shape[1] && shape[1] > 0
            ? shape[1]
            : 64,
      gridCountZ:
        commonCells[2] && commonCells[2] > 0
          ? commonCells[2]
          : shape[2] && shape[2] > 0
            ? shape[2]
            : 1,
      growthRate:
        asNumber(sharedCfg?.growth_rate) ??
        asNumber(sharedCfg?.maximum_element_growth_rate) ??
        asNumber(universeCfg?.airbox_growth_rate) ??
        1.3,
      hmaxM:
        asNumber(sharedCfg?.hmax) ??
        asNumber(sharedCfg?.maximum_element_size) ??
        asNumber(universeCfg?.airbox_hmax) ??
        5e-9,
      hminM:
        asNumber(sharedCfg?.hmin) ??
        asNumber(sharedCfg?.minimum_element_size) ??
        asNumber(universeCfg?.airbox_hmin) ??
        2e-9,
      lane: femActive ? "fem" : "fdm",
      narrowRegionResolution:
        asNumber(sharedCfg?.narrow_region_resolution) ??
        asNumber(universeCfg?.airbox_narrow_region_resolution) ??
        2,
      optimizeMethod,
      optimizeQuality,
      sizingMode:
        commonCells[0] && !authoredCell[0] ? "cell_count" : "cell_size",
      zStackMode: isMultilayer ? "multilayer" : "single_3d",
    };
  }, [
    domainMeta.data?.grid,
    femActive,
    multilayer.data?.available,
    scene.data,
    sharedPolicy.data,
    universePolicy.data,
  ]);

  const sceneRev =
    asNumber(asRecord(scene.data)?.revision) ??
    asNumber(asRecord(scene.data)?.scene_revision);
  const manifestSourceRev = asNumber(asRecord(manifest.data)?.source_scene_revision);
  const resolvedCounts = resolveMeshTopologyCounts(manifest.data?.topology_counts);
  const femElements =
    resolvedCounts?.element_count ??
    asNumber(asRecord(manifest.data?.topology_counts)?.elements);
  const femNodes =
    resolvedCounts?.node_count ??
    asNumber(asRecord(manifest.data?.topology_counts)?.nodes);
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
                sessionScopeKey: sessionScopeKey ?? null,
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
            ? "Session discretization"
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
          { id: "lane", label: "Lane", value: "FEM" },
          {
            id: "elements",
            label: "Elements",
            value:
              femElements !== null && femElements !== undefined
                ? femElements.toLocaleString("en-US")
                : null,
          },
          {
            id: "nodes",
            label: "Nodes",
            value:
              femNodes !== null && femNodes !== undefined
                ? femNodes.toLocaleString("en-US")
                : null,
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
                    sessionScopeKey: sessionScopeKey ?? null,
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
              format: (d) =>
                d.lane === "fem"
                  ? "FEM (Unstructured Mesh)"
                  : "FDM (Structured Grid)",
              hint: "Assigned by the session simulation mode",
              label: "Session method",
              type: "readonly",
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
              showWhen: (d) => d.sizingMode === "cell_count" && d.zStackMode !== "multilayer",
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
          footer: (ctx) => (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => {
                  const sharedEffective = asRecord(
                    asRecord(sharedPolicy.data)?.effective_config,
                  );
                  const effShared = draftFromEffectiveSharedDomainResource(
                    sharedPolicy.data
                      ? {
                          config:
                            sharedEffective ?? sharedPolicy.data.config ?? null,
                          effective_config: sharedEffective ?? null,
                          revision: sharedPolicy.data.revision,
                        }
                      : null,
                  );
                  const uniResource: MeshUniverseConfigResource =
                    universePolicy.data ?? {
                      config: null,
                      effective_config: null,
                      revision: 0,
                    };
                  const effUni = draftFromEffectiveUniverseMeshPolicyResource({
                    ...uniResource,
                    config:
                      uniResource.effective_config ?? uniResource.config ?? null,
                  });
                  const patch: Partial<MeshRootDraft> = {
                    optimizeMethod: effShared.optimizeMethod || "Netgen",
                    optimizeQuality: effShared.optimize,
                  };
                  const hmax = asNumber(effShared.hMax) ?? asNumber(effUni.airboxHmax);
                  const hmin = asNumber(effShared.hMin) ?? asNumber(effUni.airboxHmin);
                  const growth =
                    asNumber(effShared.growthRate) ?? asNumber(effUni.airboxGrowthRate);
                  const curv =
                    asNumber(effShared.curvatureFactor) ?? asNumber(effUni.curvatureFactor);
                  const narrow =
                    asNumber(effShared.narrowRegionResolution) ??
                    asNumber(effUni.narrowRegionResolution);
                  if (hmax !== null && hmax > 0) patch.hmaxM = hmax;
                  if (hmin !== null && hmin > 0) patch.hminM = hmin;
                  if (growth !== null && growth > 0) patch.growthRate = growth;
                  if (curv !== null && curv > 0) patch.curvatureFactor = curv;
                  if (narrow !== null && narrow > 0) {
                    patch.narrowRegionResolution = narrow;
                    patch.enableNarrowRegionRefinement = true;
                  }
                  ctx.patchDraft(patch);
                }}
              >
                Load Effective Defaults
              </Button>
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => {
                  void kernel.commands.execute(
                    "mesh.build-shared-domain",
                    createCommandContext("inspector", kernel, {
                      sessionScopeKey: sessionScopeKey ?? null,
                      sourceDetail: "mesh.root.footer",
                    }),
                  );
                }}
              >
                Build Shared-Domain Mesh
              </Button>
            </div>
          ),
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
              key: "narrowRegionResolution",
              label: "Narrow region resolution",
              max: 16,
              min: 0.5,
              step: 0.5,
              type: "number",
            },
            {
              key: "enableNarrowRegionRefinement",
              label: "Enable narrow-region refinement",
              structural: true,
              type: "switch",
            },
            {
              integer: true,
              key: "elementsAcrossThickness",
              label: "Elements across thickness",
              max: 16,
              min: 1,
              showWhen: (d) => d.enableNarrowRegionRefinement,
              type: "number",
            },
            {
              key: "anisotropyLimit",
              label: "Anisotropy limit",
              max: 50,
              min: 1,
              showWhen: (d) => d.enableNarrowRegionRefinement,
              step: 0.5,
              type: "number",
            },
            {
              key: "optimizeQuality",
              label: "Optimize tetrahedral quality",
              structural: true,
              type: "switch",
            },
            {
              key: "optimizeMethod",
              label: "Gmsh optimizer",
              options: [
                { label: "Netgen", value: "Netgen" },
                { label: "HighOrder", value: "HighOrder" },
                { label: "Relocate3D", value: "Relocate3D" },
              ],
              showWhen: (d) => d.optimizeQuality,
              type: "select",
            },
          ],
          showWhen: (d) => d.lane === "fem",
          summary: (d) =>
            `h_min ${formatLengthSmart(d.hminM)} → h_max ${formatLengthSmart(d.hmaxM)}`,
          title: "Global FEM sizing & narrow-region resolution",
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
        mode: "staged",
        onApply: async (draft) => {
          const reqOptions = sessionScopeKey ? { sessionScopeKey } : undefined;

          if (draft.lane === "fdm") {
            const nx = draft.fftSmoothSnap
              ? snapSevenSmooth(draft.gridCountX)
              : Math.max(1, Math.round(draft.gridCountX));
            const ny = draft.fftSmoothSnap
              ? snapSevenSmooth(draft.gridCountY)
              : Math.max(1, Math.round(draft.gridCountY));
            const nz = Math.max(1, Math.round(draft.gridCountZ));

            const studyRec = asRecord(asRecord(scene.data)?.study);
            const existingFdm = asRecord(studyRec?.fdm) ?? {};
            const existingDemag = asRecord(existingFdm.demag) ?? {};
            const demagStrategy =
              draft.zStackMode === "multilayer"
                ? "multilayer_convolution"
                : "single_grid";
            const demagMode =
              draft.zStackMode === "multilayer" ? "two_d_stack" : "three_d";

            const fdmPatch: JsonObject = {
              ...(existingFdm as JsonObject),
              default_cell:
                draft.sizingMode === "cell_size" ? [...draft.cellSizeM] : null,
              demag: {
                ...(existingDemag as JsonObject),
                common_cells:
                  draft.sizingMode === "cell_count" &&
                  draft.zStackMode !== "multilayer"
                    ? [nx, ny, nz]
                    : null,
                common_cells_xy:
                  draft.sizingMode === "cell_count" &&
                  draft.zStackMode === "multilayer"
                    ? [nx, ny]
                    : null,
                explain: draft.fftSmoothSnap,
                mode: demagMode,
                strategy: demagStrategy,
              },
            };

            const baseRevision =
              asNumber(asRecord(scene.data)?.revision) ??
              asNumber(asRecord(scene.data)?.scene_revision) ??
              0;
            const mutationCtx = buildSafeMutationContext(
              kernel,
              sessionScopeKey,
              "mesh.root.fdm",
            );
            const committed = await runAuthoringMutationWithHistory(
              mutationCtx,
              "Update FDM discretization policy",
              async (prep) => {
                const tx: AuthoringTransactionRequest = {
                  base_revision: prep.baseRevision ?? baseRevision,
                  kind: "merge_patch",
                  merge_patch: {
                    study: {
                      demag_realization: demagStrategy,
                      fdm: fdmPatch,
                    },
                  },
                };
                return kernel.api.model.commitTransaction(tx, reqOptions);
              },
            );
            const committedScene = asRecord(committed)?.committed_scene as
              | SceneResource
              | undefined;
            if (
              committedScene &&
              geometryLifecycleResources.publishCommittedSceneResource
            ) {
              const committedRev =
                asNumber(asRecord(committedScene)?.revision) ??
                `w5:${Date.now()}`;
              geometryLifecycleResources.publishCommittedSceneResource(
                kernel.resources,
                committedScene,
                committedRev,
                undefined,
                true,
                sessionScopeKey ?? null,
                kernel.api.resourceCacheScope,
              );
            }
            const uniResource: MeshUniverseConfigResource =
              universePolicy.data ?? {
                config: null,
                effective_config: null,
                revision: 0,
              };
            if (uniResource.config !== null && uniResource.config !== undefined) {
              const uniDraft = rebaseAirboxMeshPolicyDraft(
                draftFromUniverseMeshPolicyResource(uniResource),
                universePolicy.data ?? null,
              );
              const builtUni = buildAirboxMeshPolicyReplaceRequest(uniDraft, {
                lane: "fdm",
              });
              if (!("error" in builtUni) && builtUni.request) {
                await kernel.api.meshing.replaceUniversePolicy(
                  builtUni.request,
                  reqOptions,
                );
              }
            }
            invalidateAuthoringMutationDependents(
              kernel.resources,
              "geometry",
              `w5:${Date.now()}`,
            );
            kernel.resources.invalidate(
              geometryLifecycleResources.SCENE_RESOURCE_KEY,
              `w5:${Date.now()}`,
            );
            kernel.resources.invalidate(
              SESSION_STATUS_KEY,
              `w5:${Date.now()}`,
            );
            kernel.resources.invalidate(
              geometryLifecycleResources.MESH_UNIVERSE_POLICY_RESOURCE_KEY,
              `w5:${Date.now()}`,
            );
          } else {
            const baseShared = draftFromSharedDomainResource(sharedPolicy.data ?? null);
            const nextSharedDraft: SharedDomainPolicyDraft = {
              ...baseShared,
              authoredPresent: true,
              curvatureFactor: String(draft.curvatureFactor),
              growthRate: String(draft.growthRate),
              hMax: String(draft.hmaxM),
              hMin: String(draft.hminM),
              narrowRegionResolution: String(draft.narrowRegionResolution),
              optimize: draft.optimizeQuality,
              optimizeMethod: draft.optimizeMethod || "Netgen",
            };
            const builtShared = buildSharedDomainPolicyConfig(nextSharedDraft);
            if (!builtShared.ok) {
              throw new Error(builtShared.error);
            }
            const configPayload: JsonObject = {
              ...builtShared.config,
              ...(draft.enableNarrowRegionRefinement
                ? {
                    anisotropy_limit: draft.anisotropyLimit,
                    elements_across_thickness: draft.elementsAcrossThickness,
                    enable_narrow_region_refinement: true,
                  }
                : {
                    enable_narrow_region_refinement: false,
                  }),
            };

            const nextShared = await kernel.api.meshing.sharedDomain.replacePolicy(
              { config: configPayload },
              reqOptions,
            );
            const nextRev =
              typeof nextShared?.revision === "number"
                ? nextShared.revision
                : `w5:${Date.now()}`;

            if (
              sessionScopeKey &&
              nextShared &&
              typeof nextShared.revision === "number"
            ) {
              meshPolicyResourceCache.publishCommittedMeshPolicyResource?.(
                kernel.resources,
                geometryLifecycleResources.MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY,
                sessionScopeKey,
                nextShared,
                kernel.api.resourceCacheScope,
              );
            }

            const uniResource: MeshUniverseConfigResource =
              universePolicy.data ?? {
                config: null,
                effective_config: null,
                revision: 0,
              };
            if (uniResource.config !== null && uniResource.config !== undefined) {
              const uniDraft = rebaseAirboxMeshPolicyDraft(
                {
                  ...draftFromUniverseMeshPolicyResource(uniResource),
                  narrowRegionResolution: String(draft.narrowRegionResolution),
                },
                universePolicy.data ?? null,
              );
              const builtUni = buildAirboxMeshPolicyReplaceRequest(uniDraft, {
                lane: "fem",
              });
              if (!("error" in builtUni) && builtUni.request) {
                await kernel.api.meshing.replaceUniversePolicy(
                  builtUni.request,
                  reqOptions,
                );
              }
            }

            kernel.resources.invalidate(
              geometryLifecycleResources.MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY,
              nextRev,
            );
            kernel.resources.invalidate(
              geometryLifecycleResources.MESH_SEMANTICS_RESOURCE_KEY,
              nextRev,
            );
            kernel.resources.invalidate(
              geometryLifecycleResources.SCENE_RESOURCE_KEY,
              `mesh-policy:shared-domain:${String(nextRev)}`,
            );
            kernel.resources.invalidate(
              SESSION_STATUS_KEY,
              `mesh-policy:shared-domain:${String(nextRev)}`,
            );
          }
          kernel.resources.invalidate(
            geometryLifecycleResources.MESH_SUMMARY_RESOURCE_KEY,
            `w5:${Date.now()}`,
          );
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
// 3. mesh.shared-domain — MeshSharedDomainInspectorSpecPanel
// ============================================================================

interface SharedDomainSpecDraft {
  hMax: string;
  hMin: string;
  growthRate: string;
  curvatureFactor: string;
  narrowRegionResolution: string;
  optimize: boolean;
  optimizeMethod: string;
  configText: string;
}

export function MeshSharedDomainInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey =
    sessionRequestScopeKey(sessionStatusHooks.useSessionResourceIdentity()) ?? undefined;

  const policy = geometryLifecycleResources.useMeshSharedDomainPolicyResource();
  const manifest = geometryLifecycleResources.useMeshSharedDomainManifestResource();
  const summary = geometryLifecycleResources.useMeshSummaryResource();
  const semantics = geometryLifecycleResources.useMeshSemanticsResource();
  const activeBuild = geometryLifecycleResources.useMeshBuildCurrent();
  const sharedReport = geometryLifecycleResources.useMeshSharedDomainReportResource();
  const capabilities = useSafeMeshCapabilitiesResource();

  const baseline = useMemo<SharedDomainSpecDraft>(() => {
    const parsed = draftFromSharedDomainResource(policy.data ?? null);
    return {
      configText: parsed.configText,
      curvatureFactor: parsed.curvatureFactor,
      growthRate: parsed.growthRate,
      hMax: parsed.hMax,
      hMin: parsed.hMin,
      narrowRegionResolution: parsed.narrowRegionResolution,
      optimize: parsed.optimize,
      optimizeMethod: parsed.optimizeMethod || "Netgen",
    };
  }, [policy.data]);

  const counts = useMemo(
    () => resolveMeshTopologyCounts(manifest.data?.topology_counts),
    [manifest.data?.topology_counts],
  );

  const meshStatistics =
    asRecord(asRecord(semantics.data)?.mesh_build_diagnostics)?.mesh_statistics ??
    asRecord(asRecord(sharedReport.data)?.report)?.mesh_statistics ??
    null;
  const qualityStats = useMemo(
    () => normalizeMeshQualityStatistics(meshStatistics),
    [meshStatistics],
  );

  const mixedTopology = useMemo(
    () =>
      resolveMixedTopologyPresentation({
        buildReport:
          activeBuild.data?.shared_domain_build_report ??
          asRecord(asRecord(semantics.data)?.solver_mesh)?.build_report ??
          asRecord(sharedReport.data)?.report,
        manifest: manifest.data,
        rejectionEvidence: activeBuild.data?.mixed_layer_topology_rejection,
      }),
    [activeBuild.data, manifest.data, semantics.data, sharedReport.data],
  );

  const editorCapabilities = useMemo(
    () => resolveMeshEditorCapabilities(capabilities.data),
    [capabilities.data],
  );

  const handleAfterFieldChange = useCallback(
    <K extends keyof SharedDomainSpecDraft & string>(
      key: K,
      value: SharedDomainSpecDraft[K],
      helpers: {
        draft: SharedDomainSpecDraft;
        patchDraft: (partial: Partial<SharedDomainSpecDraft>) => void;
      },
    ) => {
      if (key === "configText") return;
      const merged: SharedDomainPolicyDraft = {
        authoredPresent: true,
        configText: helpers.draft.configText,
        curvatureFactor: helpers.draft.curvatureFactor,
        growthRate: helpers.draft.growthRate,
        hMax: helpers.draft.hMax,
        hMin: helpers.draft.hMin,
        narrowRegionResolution: helpers.draft.narrowRegionResolution,
        optimize: helpers.draft.optimize,
        optimizeMethod: helpers.draft.optimizeMethod,
        [key]: value,
      };
      const built = buildSharedDomainPolicyConfig(merged);
      if (built.ok) {
        helpers.patchDraft({ configText: formatPolicyJson(built.config) });
      }
    },
    [],
  );

  const spec = useMemo<InspectorSpec<SharedDomainSpecDraft>>(() => {
    const manifestRec = manifest.data;
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
        primaryHeaderAction: {
          icon: Grid3x3,
          label: "Build Shared-Domain Mesh",
          onRun: async () => {
            await kernel.commands.execute(
              "mesh.build-shared-domain",
              createCommandContext("inspector", kernel, {
                sessionScopeKey: sessionScopeKey ?? null,
                sourceDetail: "mesh.shared-domain",
              }),
            );
          },
        },
      },
      identity: {
        domain: "mesh",
        entityId: "model:mesh:shared-domain",
        icon: Layers,
        kindLabel: "Shared-domain FEM assembly",
        statePill: () =>
          manifestRec
            ? { label: "Realized", tone: "ok" }
            : { label: "Not built", tone: "neutral" },
        title: () => "Shared-Domain Mesh",
      },
      facts: (d) => [
        {
          id: "hmax",
          label: "Global h_max",
          value: d.hMax === "auto" ? "Auto" : formatLengthSmart(asNumber(d.hMax)),
        },
        {
          id: "nodes",
          label: "Nodes",
          value:
            counts?.node_count != null
              ? counts.node_count.toLocaleString("en-US")
              : null,
        },
        {
          id: "elements",
          label: "Elements",
          value:
            counts?.element_count != null
              ? counts.element_count.toLocaleString("en-US")
              : null,
        },
        {
          id: "parts",
          label: "Mesh parts",
          value:
            manifestRec?.mesh_parts != null
              ? String(manifestRec.mesh_parts.length)
              : null,
        },
      ],
      sections: [
        {
          defaultOpen: true,
          footer: (ctx) => (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => {
                  const policyEffective = asRecord(
                    asRecord(policy.data)?.effective_config,
                  );
                  const eff = draftFromEffectiveSharedDomainResource(
                    policy.data
                      ? {
                          config: policyEffective ?? policy.data.config ?? null,
                          effective_config: policyEffective ?? null,
                          revision: policy.data.revision,
                        }
                      : null,
                  );
                  ctx.patchDraft({
                    configText: eff.configText,
                    curvatureFactor: eff.curvatureFactor,
                    growthRate: eff.growthRate,
                    hMax: eff.hMax,
                    hMin: eff.hMin,
                    narrowRegionResolution: eff.narrowRegionResolution,
                    optimize: eff.optimize,
                    optimizeMethod: eff.optimizeMethod || "Netgen",
                  });
                }}
              >
                Load Effective Defaults
              </Button>
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => {
                  void kernel.commands.execute(
                    "mesh.build-shared-domain",
                    createCommandContext("inspector", kernel, {
                      sessionScopeKey: sessionScopeKey ?? null,
                      sourceDetail: "mesh.shared-domain.footer",
                    }),
                  );
                }}
              >
                Build Shared-Domain Mesh
              </Button>
            </div>
          ),
          icon: Ruler,
          id: "shared-domain-policy",
          rows: [
            {
              hint: "Positive length in meters or 'auto'",
              key: "hMax",
              label: "Global max element size (m)",
              mono: true,
              placeholder: "e.g. 5e-9 or auto",
              symbol: (
                <>
                  h<sub>max</sub>
                </>
              ),
              type: "text",
            },
            {
              key: "hMin",
              label: "Global min element size (m)",
              mono: true,
              placeholder: "e.g. 1e-9",
              symbol: (
                <>
                  h<sub>min</sub>
                </>
              ),
              type: "text",
            },
            {
              key: "growthRate",
              label: "Element growth rate",
              mono: true,
              placeholder: "e.g. 1.3",
              symbol: <>g</>,
              type: "text",
            },
            {
              key: "curvatureFactor",
              label: "Curvature factor",
              mono: true,
              placeholder: "e.g. 0.2",
              symbol: <>&kappa;</>,
              type: "text",
            },
            {
              key: "narrowRegionResolution",
              label: "Narrow region resolution",
              mono: true,
              placeholder: "e.g. 2",
              type: "text",
            },
            {
              key: "optimize",
              label: "Optimize tetrahedral quality",
              structural: true,
              type: "switch",
            },
            {
              key: "optimizeMethod",
              label: "Gmsh optimizer",
              options: [
                { label: "Netgen", value: "Netgen" },
                { label: "HighOrder", value: "HighOrder" },
                { label: "Relocate3D", value: "Relocate3D" },
              ],
              showWhen: (d) => d.optimize,
              type: "select",
            },
          ],
          title: "Shared-domain mesh policy",
        },
        {
          defaultOpen: true,
          icon: ShieldCheck,
          id: "solver-mesh-identity",
          rows: [
            {
              format: () => manifestRec?.mesh_name ?? "Not built",
              label: "Mesh name",
              type: "readonly",
            },
            {
              format: () => manifestRec?.mesh_id ?? "None",
              label: "Mesh ID",
              mono: true,
              type: "readonly",
            },
            {
              format: () => manifestRec?.generation_id ?? "No generation",
              label: "Generation",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                sanitizeMeshDisplayText(manifestRec?.domain_mesh_mode, "shared-domain"),
              label: "Domain mode",
              type: "readonly",
            },
            {
              format: () =>
                manifestRec?.source_scene_revision != null
                  ? String(manifestRec.source_scene_revision)
                  : "Not published",
              label: "Source scene revision",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                manifestRec?.geometry_realization_revision != null
                  ? String(manifestRec.geometry_realization_revision)
                  : "Not published",
              label: "Geometry realization revision",
              mono: true,
              type: "readonly",
            },
            {
              format: () => String(manifestRec?.mesh_parts?.length ?? 0),
              label: "Mesh parts",
              mono: true,
              type: "readonly",
            },
            {
              format: () => String(manifestRec?.object_segments?.length ?? 0),
              label: "Object segments",
              mono: true,
              type: "readonly",
            },
            {
              format: () => String(manifestRec?.regions?.length ?? 0),
              label: "Regions",
              mono: true,
              type: "readonly",
            },
          ],
          title: "Solver mesh identity",
        },
        {
          defaultOpen: true,
          icon: Layers,
          id: "mesh-counts-extents",
          rows: [
            {
              format: () => formatCountClean(counts?.node_count),
              label: "Nodes",
              mono: true,
              type: "readonly",
            },
            {
              format: () => formatCountClean(counts?.element_count),
              label: "Elements",
              mono: true,
              type: "readonly",
            },
            {
              format: () => formatCountClean(counts?.boundary_face_count),
              label: "Boundary faces",
              mono: true,
              type: "readonly",
            },
            {
              format: () => (counts ? "Shared-domain manifest" : "Not published"),
              label: "Count source",
              type: "readonly",
            },
            {
              format: () =>
                formatLengthSmart(
                  qualityStats?.edgeLength?.min ??
                    asNumber(recordField(asRecord(meshStatistics), "min_edge_length")),
                ) ?? "Not published",
              label: "Min edge",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                formatLengthSmart(
                  qualityStats?.edgeLength?.max ??
                    asNumber(recordField(asRecord(meshStatistics), "max_edge_length")),
                ) ?? "Not published",
              label: "Max edge",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                formatLengthSmart(
                  qualityStats?.edgeLength?.mean ??
                    asNumber(recordField(asRecord(meshStatistics), "mean_edge_length")),
                ) ?? "Not published",
              label: "Mean edge",
              mono: true,
              type: "readonly",
            },
          ],
          title: "Counts & extents",
        },
        {
          defaultOpen: true,
          icon: Activity,
          id: "mixed-topology-provenance",
          rows: [
            {
              render: () => <MixedTopologyProvenanceSpecView model={mixedTopology} />,
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => mixedTopology.visible,
          title: "Mixed-topology provenance",
        },
        {
          defaultOpen: false,
          icon: Box,
          id: "viewport-delivery",
          rows: [
            {
              format: () =>
                summary.data?.revision != null
                  ? String(summary.data.revision)
                  : "Not published",
              label: "Backend mesh revision",
              mono: true,
              type: "readonly",
            },
            {
              format: () => manifestRec?.generation_id ?? "Not published",
              label: "Generation",
              mono: true,
              type: "readonly",
            },
            {
              format: () => sanitizeMeshDisplayText(manifest.status, "ready"),
              label: "Manifest state",
              type: "readonly",
            },
            {
              format: () => "Tracked in Mesh Jobs",
              label: "Viewport acknowledgement",
              type: "readonly",
            },
          ],
          title: "Viewport delivery",
        },
        {
          defaultOpen: false,
          icon: Settings2,
          id: "editor-capabilities",
          rows: [
            {
              render: () => <MeshEditorCapabilitiesSpecView model={editorCapabilities} />,
              type: "custom",
              wide: true,
            },
          ],
          title: "Mesh editor capabilities",
        },
      ],
      commitBar: {
        cleanMessage: () => "Shared-domain mesh policy is synchronized",
        mode: "staged",
        onApply: async (draft) => {
          const built = buildSharedDomainPolicyConfig({
            authoredPresent: true,
            configText: draft.configText,
            curvatureFactor: draft.curvatureFactor,
            growthRate: draft.growthRate,
            hMax: draft.hMax,
            hMin: draft.hMin,
            narrowRegionResolution: draft.narrowRegionResolution,
            optimize: draft.optimize,
            optimizeMethod: draft.optimizeMethod || "Netgen",
          });
          if (!built.ok) {
            throw new Error(built.error);
          }
          const next = await kernel.api.meshing.sharedDomain.replacePolicy(
            { config: built.config },
            sessionScopeKey ? { sessionScopeKey } : undefined,
          );
          const nextRev =
            typeof next?.revision === "number" ? next.revision : `w5:${Date.now()}`;
          if (sessionScopeKey && next && typeof next.revision === "number") {
            meshPolicyResourceCache.publishCommittedMeshPolicyResource?.(
              kernel.resources,
              geometryLifecycleResources.MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY,
              sessionScopeKey,
              next,
              kernel.api.resourceCacheScope,
            );
          }
          kernel.resources.invalidate(
            geometryLifecycleResources.MESH_SHARED_DOMAIN_POLICY_RESOURCE_KEY,
            nextRev,
          );
          kernel.resources.invalidate(
            geometryLifecycleResources.MESH_SEMANTICS_RESOURCE_KEY,
            nextRev,
          );
          kernel.resources.invalidate(
            geometryLifecycleResources.SCENE_RESOURCE_KEY,
            `mesh-policy:shared-domain:${String(nextRev)}`,
          );
          kernel.resources.invalidate(
            SESSION_STATUS_KEY,
            `mesh-policy:shared-domain:${String(nextRev)}`,
          );
          return true;
        },
      },
    };
  }, [
    counts,
    editorCapabilities,
    kernel,
    manifest.data,
    manifest.status,
    meshStatistics,
    mixedTopology,
    policy.data,
    qualityStats,
    sessionScopeKey,
    summary.data,
  ]);

  return (
    <SpecInspectorHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleAfterFieldChange}
    />
  );
}

// ============================================================================
// 4. mesh.size-fields — MeshSizeFieldsInspectorSpecPanel
// ============================================================================

interface SizeFieldsDraft {
  sourceFilter: string;
}

export function MeshSizeFieldsInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const sizeFieldsRes =
    geometryLifecycleResources.useMeshSharedDomainRealizedSizeFieldsResource();
  const activeBuild = geometryLifecycleResources.useMeshBuildCurrent();

  const rawFields = useMemo(() => {
    const rec = asRecord(sizeFieldsRes.data);
    const nested = asRecord(rec?.realized_size_fields);
    const list = Array.isArray(nested?.fields)
      ? nested.fields
      : Array.isArray(rec?.fields)
        ? rec.fields
        : Array.isArray(rec?.size_fields)
          ? rec.size_fields
          : [];
    return list.map((item, index) => {
      const r = asRecord(item) ?? {};
      const params = r.params;
      const summary = sizeFieldParamSummary(params);
      const source =
        asString(r.source) ??
        asString(r.owner_object_id) ??
        asString(r.owner) ??
        "shared-domain";
      const objectMatch = source.match(/^(?:object|object_mesh):(.+)$/);
      return {
        id: asString(r.id) ?? `${asString(r.kind) ?? "field"}-${source}-${index}`,
        kind: asString(r.kind) ?? "SizeField",
        objectId: objectMatch?.[1] ?? asString(r.owner_object_id) ?? null,
        paramSummary: summary ?? sanitizeMeshDisplayText(r.reason ?? source, "applied"),
        source,
        status: sanitizeMeshDisplayText(r.status, "applied"),
      };
    });
  }, [sizeFieldsRes.data]);

  const thinFilmDiagnostics = useMemo(
    () =>
      activeBuild.data?.shared_domain_build_report?.thin_film_diagnostics ?? [],
    [activeBuild.data],
  );

  const sourceOptions = useMemo(() => {
    const sources = Array.from(new Set(rawFields.map((f) => f.source)));
    return [
      { label: "All sources", value: "all" },
      ...sources.map((src) => ({ label: src, value: src })),
    ];
  }, [rawFields]);

  const baseline = useMemo<SizeFieldsDraft>(() => ({ sourceFilter: "all" }), []);

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
        kindLabel: "Realized Gmsh size fields & thin-film diagnostics",
        statePill: () =>
          rawFields.length > 0
            ? { label: `${rawFields.length} active`, tone: "ok" }
            : { label: "No fields realized", tone: "neutral" },
        title: () => "Realized Size Fields",
      },
      facts: () => [
        { id: "count", label: "Realized fields", value: String(rawFields.length) },
        {
          id: "sources",
          label: "Distinct sources",
          value: String(Math.max(0, sourceOptions.length - 1)),
        },
        {
          id: "thin-film",
          label: "Thin-film checks",
          value: String(thinFilmDiagnostics.length),
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
              key: "sourceFilter",
              label: "Filter by source",
              options: sourceOptions,
              showWhen: () => rawFields.length > 0,
              type: "select",
            },
            {
              columns: [
                {
                  header: "Kind & source",
                  id: "kind",
                  renderCell: (row) => {
                    const r = row as (typeof rawFields)[number];
                    return `${r.kind} · ${r.source}`;
                  },
                },
                {
                  header: "Status",
                  id: "status",
                  renderCell: (row) => (row as (typeof rawFields)[number]).status,
                },
                {
                  align: "right",
                  header: "Parameters",
                  id: "params",
                  mono: true,
                  renderCell: (row) => (row as (typeof rawFields)[number]).paramSummary,
                },
              ],
              label: "Realized size fields",
              onSelectRow: (row, ctx) => {
                const r = row as (typeof rawFields)[number];
                if (r.objectId) {
                  ctx.selectNode({
                    kind: "object.mesh",
                    label: "Mesh",
                    nodeId: `model:object:${r.objectId}:mesh`,
                    objectId: r.objectId,
                    ref: null,
                  });
                }
              },
              rowKey: (row) => (row as (typeof rawFields)[number]).id,
              rows: (d) =>
                d.sourceFilter === "all"
                  ? rawFields
                  : rawFields.filter((f) => f.source === d.sourceFilter),
              showWhen: () => rawFields.length > 0,
              type: "table",
              wide: true,
            },
          ],
          title: "Realized size fields",
        },
        {
          defaultOpen: true,
          icon: Layers,
          id: "thin-film-diagnostics",
          rows: [
            {
              render: () => (
                <ThinFilmDiagnosticsSpecView diagnostics={thinFilmDiagnostics} />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Thin-film diagnostics",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Click an object-scoped row to edit its source mesh policy",
      },
    }),
    [rawFields, sourceOptions, thinFilmDiagnostics],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 5. mesh.regions — MeshRegionsInspectorSpecPanel
// ============================================================================

interface MeshRegionsDraft {
  selectedPartId: string;
  highlightSelectedPart: boolean;
  deviationFilter: "all" | "deviations_only";
}

interface HierarchyRow {
  id: string;
  depth: number;
  kindLabel: string;
  label: string;
  elementsText: string;
  jumpSelection: {
    kind: string;
    label: string;
    nodeId: string;
    objectId: string | null;
    ref: null;
  } | null;
}

export function MeshRegionsInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const scene = geometryLifecycleResources.useSceneResource();
  const manifest = geometryLifecycleResources.useMeshSharedDomainManifestResource();
  const semantics = geometryLifecycleResources.useMeshSemanticsResource();
  const activeBuild = geometryLifecycleResources.useMeshBuildCurrent();
  const latestBuild = useSafeMeshBuildLatestSuccessful();

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
        regionId: asString(p.region_id),
        role: asString(p.role),
      };
    });
  }, [manifest.data]);

  const hierarchyRows = useMemo<HierarchyRow[]>(() => {
    const rows: HierarchyRow[] = [];
    const objs = Array.isArray(scene.data?.objects) ? scene.data.objects : [];
    const manifestRegions = Array.isArray(manifest.data?.regions)
      ? manifest.data.regions.map(asRecord).filter(Boolean)
      : [];

    for (const rawObj of objs) {
      const obj = asRecord(rawObj);
      const objId = asString(obj?.id);
      if (!objId) continue;
      const objName = asString(obj?.name) ?? objId;
      const objParts = parts.filter((p) => p.ownerId === objId);
      const objElemSum = objParts.reduce((acc, p) => acc + p.elementCount, 0);
      rows.push({
        depth: 0,
        elementsText: objElemSum > 0 ? objElemSum.toLocaleString("en-US") : "—",
        id: `obj:${objId}`,
        jumpSelection: {
          kind: "object.mesh",
          label: `${objName} Mesh`,
          nodeId: `model:object:${objId}:mesh`,
          objectId: objId,
          ref: null,
        },
        kindLabel: "Object",
        label: objName,
      });

      const authoredRegions = Array.isArray(obj?.regions)
        ? obj.regions.map(asRecord).filter(Boolean)
        : [];
      for (const reg of authoredRegions) {
        const regId = asString(reg?.id);
        if (!regId) continue;
        const regName = asString(reg?.name) ?? regId;
        const regParts = objParts.filter((p) => p.regionId === regId);
        const regElems = regParts.reduce((acc, p) => acc + p.elementCount, 0);
        rows.push({
          depth: 1,
          elementsText: regElems > 0 ? regElems.toLocaleString("en-US") : "—",
          id: `reg:${objId}:${regId}`,
          jumpSelection: {
            kind: "object.region.mesh",
            label: `${regName} Mesh`,
            nodeId: `model:object:${objId}:region:${regId}:mesh`,
            objectId: objId,
            ref: null,
          },
          kindLabel: "Region",
          label: `↳ ${regName}`,
        });
      }

      for (const mReg of manifestRegions) {
        if (asString(mReg?.owner_object_id) !== objId) continue;
        const mRegId = asString(mReg?.region_id) ?? asString(mReg?.id);
        if (!mRegId || rows.some((r) => r.id === `reg:${objId}:${mRegId}`)) continue;
        rows.push({
          depth: 1,
          elementsText: formatCountClean(asNumber(mReg?.element_count)),
          id: `mreg:${objId}:${mRegId}`,
          jumpSelection: null,
          kindLabel: "Realized region",
          label: `↳ ${asString(mReg?.label) ?? mRegId}`,
        });
      }

      for (const part of objParts) {
        rows.push({
          depth: 2,
          elementsText: part.elementCount.toLocaleString("en-US"),
          id: `part:${part.id}`,
          jumpSelection: null,
          kindLabel: "Mesh part",
          label: `  ↳ ${part.label}`,
        });
      }
    }

    const exteriorParts = parts.filter((p) => !p.ownerId);
    for (const part of exteriorParts) {
      rows.push({
        depth: 0,
        elementsText: part.elementCount.toLocaleString("en-US"),
        id: `ext:${part.id}`,
        jumpSelection:
          part.role === "airbox"
            ? {
                kind: "airbox.mesh",
                label: "Airbox Mesh",
                nodeId: "model:airbox:mesh",
                objectId: null,
                ref: null,
              }
            : {
                kind: "mesh.unassigned.part",
                label: part.label,
                nodeId: `model:mesh:unassigned:${encodeURIComponent(part.id)}`,
                objectId: null,
                ref: null,
              },
        kindLabel: part.role === "airbox" ? "Airbox" : "Unassigned part",
        label: part.label,
      });
    }
    return rows;
  }, [manifest.data, parts, scene.data]);

  const policyDiffRows = useMemo<MeshPolicyDiffRow[]>(() => {
    const sharedRows = buildSharedDomainPolicyDiffRows({
      activeBuild: activeBuild.data?.active_build,
      latestBuild: latestBuild.data?.last_success,
      semantics: semantics.data,
    });
    const rec = asRecord(semantics.data);
    const configs = Array.isArray(rec?.object_configs) ? rec.object_configs : [];
    const objectRows: MeshPolicyDiffRow[] = [];
    for (const entry of configs) {
      const item = asRecord(entry) ?? {};
      const objId = asString(item.object_id) ?? "object";
      const cfg = asRecord(item.config) as JsonObject | null;
      const eff = asRecord(item.effective_config) as JsonObject | null;
      if (!cfg && !eff) continue;
      const diffed = diffMeshPolicies({
        current: cfg,
        draft: cfg,
        realized: eff,
        scope: "object",
      }).map((row) => ({
        ...row,
        label: `${objId} · ${row.label}`,
      }));
      objectRows.push(...diffed);
    }
    return [...sharedRows, ...objectRows];
  }, [activeBuild.data?.active_build, latestBuild.data?.last_success, semantics.data]);

  const partOptions = useMemo(
    () =>
      parts.length > 0
        ? parts.map((p) => ({ label: p.label, value: p.id }))
        : [{ label: "No mesh parts built", value: "" }],
    [parts],
  );

  const baseline = useMemo<MeshRegionsDraft>(
    () => ({
      deviationFilter: "all",
      highlightSelectedPart: false,
      selectedPartId: parts[0]?.id ?? "",
    }),
    [parts],
  );

  const applyPartHighlight = useCallback(
    (partId: string, highlight: boolean) => {
      if (!kernel.visualization?.patchTarget || !partId) return;
      for (const p of parts) {
        if (p.id === partId && highlight) {
          kernel.visualization.patchTarget(
            { id: p.id, kind: "part", label: p.label },
            { boundsVisible: true, visible: true, wireframeVisible: true },
          );
        } else {
          kernel.visualization.clearTarget?.({
            id: p.id,
            kind: "part",
            label: p.label,
          });
        }
      }
    },
    [kernel.visualization, parts],
  );

  const handleLiveChange = useCallback(
    <K extends keyof MeshRegionsDraft & string>(
      key: K,
      value: MeshRegionsDraft[K],
    ) => {
      if (key === "highlightSelectedPart") {
        applyPartHighlight(parts[0]?.id ?? "", Boolean(value));
      } else if (key === "selectedPartId") {
        applyPartHighlight(String(value), true);
      }
    },
    [applyPartHighlight, parts],
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
        kindLabel: "Region hierarchy, physical parts & policy comparison",
        statePill: () =>
          parts.length > 0
            ? { label: `${parts.length} parts`, tone: "ok" }
            : { label: "Not built", tone: "neutral" },
        title: () => "Mesh Regions & Parts",
      },
      facts: () => [
        { id: "parts", label: "Mesh parts", value: String(parts.length) },
        { id: "hierarchy", label: "Hierarchy nodes", value: String(hierarchyRows.length) },
        {
          id: "diffs",
          label: "Policy diffs",
          value: String(policyDiffRows.filter((r) => r.state !== "unchanged").length),
        },
      ],
      modeTabs: [
        { id: "parts", label: "Hierarchy & Parts" },
        { id: "comparison", label: "Policy Comparison" },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Layers,
          id: "region-hierarchy-section",
          live: true,
          modeTabId: "parts",
          rows: [
            {
              key: "selectedPartId",
              label: "Target part",
              options: partOptions,
              showWhen: () => parts.length > 0,
              type: "select",
            },
            {
              key: "highlightSelectedPart",
              label: "Highlight selected part in 3D",
              type: "switch",
            },
            {
              columns: [
                {
                  header: "Domain / Object / Region / Part",
                  id: "label",
                  renderCell: (r) => (r as HierarchyRow).label,
                },
                {
                  header: "Kind",
                  id: "kind",
                  renderCell: (r) => (r as HierarchyRow).kindLabel,
                },
                {
                  align: "right",
                  header: "Elements",
                  id: "elements",
                  mono: true,
                  renderCell: (r) => (r as HierarchyRow).elementsText,
                },
              ],
              label: "Mesh region & part hierarchy",
              onSelectRow: (r, ctx) => {
                const row = r as HierarchyRow;
                if (row.jumpSelection) {
                  ctx.selectNode(row.jumpSelection);
                }
              },
              rowKey: (r) => (r as HierarchyRow).id,
              rows: () => hierarchyRows,
              showWhen: () => hierarchyRows.length > 0,
              type: "table",
              wide: true,
            },
          ],
          title: "Region & physical part hierarchy",
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
                { label: "Deviations only", value: "deviations_only" },
              ],
              type: "segmented",
            },
            {
              columns: [
                {
                  header: "Parameter",
                  id: "param",
                  renderCell: (r) => {
                    const row = r as MeshPolicyDiffRow;
                    return `${row.scope} · ${row.label}`;
                  },
                },
                {
                  align: "right",
                  header: "Current / Draft",
                  id: "current",
                  mono: true,
                  renderCell: (r) => {
                    const row = r as MeshPolicyDiffRow;
                    return row.currentValue === row.draftValue
                      ? sanitizeMeshDisplayText(row.currentValue, "—")
                      : `${sanitizeMeshDisplayText(row.currentValue, "—")} → ${sanitizeMeshDisplayText(row.draftValue, "—")}`;
                  },
                },
                {
                  align: "right",
                  header: "Realized",
                  id: "realized",
                  mono: true,
                  renderCell: (r) =>
                    sanitizeMeshDisplayText((r as MeshPolicyDiffRow).realizedValue, "—"),
                },
                {
                  align: "right",
                  header: "Impact",
                  id: "impact",
                  renderCell: (r) =>
                    sanitizeMeshDisplayText((r as MeshPolicyDiffRow).impact, "—"),
                },
              ],
              label: "Policy vs realized mesh diff",
              rowKey: (r) => {
                const row = r as MeshPolicyDiffRow;
                return `${row.scope}:${row.path}`;
              },
              rows: (d) =>
                d.deviationFilter === "deviations_only"
                  ? policyDiffRows.filter((r) => r.state !== "unchanged")
                  : policyDiffRows,
              type: "table",
              wide: true,
            },
          ],
          title: "Policy comparison (Current · Draft · Realized · Impact)",
        },
      ],
      commitBar: {
        hasOverrides: (d, b) => d.highlightSelectedPart !== b.highlightSelectedPart,
        mode: "liveViewport",
        onResetDisplay: () => {
          for (const p of parts) {
            kernel.visualization?.clearTarget?.({
              id: p.id,
              kind: "part",
              label: p.label,
            });
          }
        },
        statusMessage: "Live 3D mesh part highlight",
      },
    }),
    [hierarchyRows, kernel.visualization, partOptions, parts, policyDiffRows],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      options={{ onLiveFieldChange: handleLiveChange }}
      selection={selection}
      spec={spec}
      onAfterFieldChange={(key, value, helpers) => {
        if (key === "highlightSelectedPart") {
          applyPartHighlight(helpers.draft.selectedPartId, Boolean(value));
        } else if (key === "selectedPartId" && helpers.draft.highlightSelectedPart) {
          applyPartHighlight(String(value), true);
        }
      }}
    />
  );
}

// ============================================================================
// 6. mesh.quality — MeshQualityInspectorSpecPanel
// ============================================================================

interface MeshQualityDraft {
  metric: "all" | "sicn" | "gamma" | "skewness" | "aspect_ratio";
}

function adaptQualityGatesStatisticsFallback(
  statsRec: JsonRecord | null,
): MeshQualityStatistics | null {
  if (!statsRec) return null;
  const normalized = normalizeMeshQualityStatistics(statsRec);
  if (normalized && normalized.metrics.length > 0) {
    return normalized;
  }
  const histograms = asRecord(statsRec.histograms);
  if (!histograms) return normalized;

  const metrics: MeshQualityMetric[] = [];
  for (const [id, label] of [
    ["sicn", "SICN"],
    ["gamma", "Gamma (γ)"],
    ["skewness", "Skewness"],
    ["aspect_ratio", "Aspect ratio"],
  ] as const) {
    const histRec = asRecord(histograms[id]);
    const rawBins = Array.isArray(histRec?.bins) ? histRec.bins : null;
    if (!rawBins || rawBins.length === 0) continue;
    const total = rawBins.reduce(
      (acc, b) => acc + (asNumber(asRecord(b)?.count) ?? 0),
      0,
    );
    const threshold = asNumber(histRec?.threshold);
    metrics.push({
      belowThresholdCount: null,
      belowThresholdFraction: null,
      histogram: rawBins.map((b) => {
        const br = asRecord(b) ?? {};
        const lo = asNumber(br.min) ?? asNumber(br.lo);
        const hi = asNumber(br.max) ?? asNumber(br.hi);
        const count = asNumber(br.count) ?? 0;
        return {
          count,
          fraction: total > 0 ? count / total : 0,
          hi,
          label:
            lo !== null && hi !== null
              ? `${lo.toFixed(2)}–${hi.toFixed(2)}`
              : asString(br.label) ?? "bin",
          lo,
        };
      }),
      id: id as MeshQualityMetric["id"],
      label,
      max: asNumber(histRec?.max) ?? null,
      mean: asNumber(histRec?.mean) ?? null,
      min: asNumber(histRec?.min) ?? asNumber(statsRec.min_quality),
      p05: asNumber(histRec?.p05) ?? asNumber(statsRec.p05_quality),
      threshold,
    });
  }

  if (metrics.length === 0) return normalized;
  const meanEdge = asNumber(statsRec.mean_edge_length_m);
  return {
    edgeLength:
      meanEdge !== null
        ? { max: null, mean: meanEdge, min: null, std: null }
        : null,
    elementCount: asNumber(statsRec.element_count),
    meshName: null,
    metrics,
    qualitySource: "quality-gates",
    sizeDistributions: normalized?.sizeDistributions ?? [],
    volumeRatio: null,
    warnings: normalized?.warnings ?? [],
    worstElements: normalized?.worstElements ?? [],
    worstElementsByMetric: normalized?.worstElementsByMetric ?? {
      gamma: [],
      sicn: [],
    },
  };
}

export function MeshQualityInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey =
    sessionRequestScopeKey(sessionStatusHooks.useSessionResourceIdentity()) ?? undefined;
  const currentMeshRevision = sessionStatusHooks.useSessionStatusSelector(
    (s) => s.data?.resources?.mesh_revision ?? null,
  );

  const qualityGatesRes =
    geometryLifecycleResources.useMeshSharedDomainQualityGatesResource();
  const semanticsRes = geometryLifecycleResources.useMeshSemanticsResource();
  const sharedReportRes = geometryLifecycleResources.useMeshSharedDomainReportResource();
  const sharedQualityRes = useSafeMeshSharedDomainQualityResource();
  const manifestRes = geometryLifecycleResources.useMeshSharedDomainManifestResource();
  const summaryRes = geometryLifecycleResources.useMeshSummaryResource();

  const baseline = useMemo<MeshQualityDraft>(() => ({ metric: "all" }), []);

  const rawData = asRecord(qualityGatesRes.data);
  const mixedCertificate = useMemo(() => {
    if (rawData && Object.hasOwn(rawData, "revision")) {
      return resolveCurrentMixedCertificateQualityPresentation({
        currentMeshRevision,
        data: qualityGatesRes.data,
        resourceStatus: qualityGatesRes.status,
      });
    }
    return resolveMixedCertificateQualityPresentation(
      rawData?.mixed_certificate ?? rawData,
    );
  }, [currentMeshRevision, qualityGatesRes.data, qualityGatesRes.status, rawData]);

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
        value: sanitizeMeshDisplayText(c.value, "—"),
      };
    });
  }, [rawData?.gates]);

  const qualityStatistics = useMemo<MeshQualityStatistics | null>(() => {
    const primarySource =
      asRecord(asRecord(semanticsRes.data)?.mesh_build_diagnostics)?.mesh_statistics ??
      asRecord(asRecord(sharedReportRes.data)?.report)?.mesh_statistics ??
      asRecord(sharedQualityRes.data)?.quality ??
      null;
    const normalizedPrimary = normalizeMeshQualityStatistics(primarySource);
    if (normalizedPrimary && normalizedPrimary.metrics.length > 0) {
      return normalizedPrimary;
    }
    return (
      adaptQualityGatesStatisticsFallback(asRecord(rawData?.statistics)) ??
      normalizedPrimary
    );
  }, [rawData?.statistics, semanticsRes.data, sharedQualityRes.data, sharedReportRes.data]);

  const refinementState = useMemo(
    () => resolveMeshQualityRefinementState(qualityStatistics),
    [qualityStatistics],
  );

  useEffect(() => {
    const currentGenerationId = manifestRes.data?.generation_id;
    const currentSelection = kernel.selection?.get?.();
    if (
      currentSelection?.ref?.type === "mesh-quality-element" &&
      currentSelection.ref.generationId &&
      currentGenerationId &&
      currentSelection.ref.generationId !== currentGenerationId
    ) {
      kernel.selection.clear?.("mesh");
    }
  }, [kernel.selection, manifestRes.data?.generation_id]);

  const handleSelectMetric = useCallback(
    (metric: MeshQualityMetric["id"]) => {
      const nodeId = `model:mesh:quality:${metric}`;
      kernel.selection?.set?.(
        {
          kind: "mesh.quality",
          label: `Mesh quality ${metric.toUpperCase()}`,
          nodeId,
          objectId: null,
          ref: {
            kind: "mesh.quality.metric",
            metric,
            nodeId,
            type: "mesh-quality-metric",
            visualizationTargetId: `mesh:quality:metric:${metric}`,
          },
        },
        "mesh",
      );
      kernel.layout?.setActiveTab?.("mesh");
    },
    [kernel.layout, kernel.selection],
  );

  const handleSelectWorstElement = useCallback(
    (element: MeshWorstElement) => {
      const nodeId = `model:mesh:quality:element:${element.elementIndex}`;
      kernel.selection?.set?.(
        {
          kind: "mesh.quality",
          label: `Worst mesh element ${element.elementIndex}`,
          nodeId,
          objectId: null,
          ref: {
            artifactId: manifestRes.data?.mesh_id ?? null,
            centroid: element.centroid,
            elementIndex: element.elementIndex,
            generationId: manifestRes.data?.generation_id ?? null,
            kind: "mesh.quality.element",
            meshRevision: asNumber(summaryRes.data?.revision),
            metric: "gamma",
            nodeId,
            type: "mesh-quality-element",
            visualizationTargetId: `mesh:quality:element:${element.elementIndex}`,
          },
        },
        "mesh",
      );
      kernel.layout?.setActiveTab?.("mesh");
    },
    [
      kernel.layout,
      kernel.selection,
      manifestRes.data?.generation_id,
      manifestRes.data?.mesh_id,
      summaryRes.data?.revision,
    ],
  );

  const handleRefineWorstElement = useCallback(() => {
    if (!refinementState.plan) return;
    void kernel.commands.execute(
      "mesh.refine-worst-quality-element",
      createCommandContext("inspector", kernel, {
        sessionScopeKey: sessionScopeKey ?? null,
        sourceDetail: "mesh.quality",
      }),
      {
        elementIndex: refinementState.plan.elementIndex,
        meshOptions: refinementState.plan.meshOptions,
      },
    );
  }, [kernel, refinementState.plan, sessionScopeKey]);

  const handleHoverSizeBin = useCallback(
    (bin: MeshSizeDistributionHoverBin | null) => {
      emitMeshSizeHistogramHover({
        bin,
        kernel,
        scope: { kind: "all" },
      });
    },
    [kernel],
  );

  const statsRec = asRecord(rawData?.statistics);
  const minQuality =
    qualityStatistics?.metrics[0]?.min ?? asNumber(statsRec?.min_quality);
  const p05Quality =
    qualityStatistics?.metrics[0]?.p05 ?? asNumber(statsRec?.p05_quality);
  const meanEdgeM =
    qualityStatistics?.edgeLength?.mean ?? asNumber(statsRec?.mean_edge_length_m);
  const elementCount =
    qualityStatistics?.elementCount ?? asNumber(statsRec?.element_count);

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
        primaryHeaderAction: refinementState.plan
          ? {
              icon: Gauge,
              label: "Refine worst region",
              onRun: async () => {
                handleRefineWorstElement();
              },
            }
          : undefined,
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
                text: `Mixed-topology quality gate failed: ${sanitizeMeshDisplayText(mixedCertificate.reason)}`,
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
                <QualityGatesSpecView
                  checks={checks}
                  gates={mixedCertificate.familyGates}
                  mixedCertificate={mixedCertificate}
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
              label: "Quality metric filter",
              options: [
                { label: "All", value: "all" },
                { label: "SICN", value: "sicn" },
                { label: "Gamma (γ)", value: "gamma" },
                { label: "Skewness", value: "skewness" },
                { label: "Aspect", value: "aspect_ratio" },
              ],
              type: "segmented",
            },
            {
              render: (ctx) => (
                <MeshQualityStatisticsSpecView
                  activeMetricFilter={ctx.draft.metric}
                  refinementState={refinementState}
                  statistics={qualityStatistics}
                  onHoverSizeDistributionBin={handleHoverSizeBin}
                  onRefineWorstElement={handleRefineWorstElement}
                  onSelectMetric={handleSelectMetric}
                  onSelectWorstElement={handleSelectWorstElement}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Quality distributions, size bins & worst elements",
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
        statusMessage: () => "Interactive FEM quality qualification & heatmap inspection",
      },
    }),
    [
      checks,
      elementCount,
      handleHoverSizeBin,
      handleRefineWorstElement,
      handleSelectMetric,
      handleSelectWorstElement,
      hasFailure,
      meanEdgeM,
      minQuality,
      mixedCertificate,
      p05Quality,
      qualityStatistics,
      refinementState,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 7. mesh.builds — MeshBuildsInspectorSpecPanel
// ============================================================================

interface MeshBuildsDraft {
  compareA: string;
  compareB: string;
}

export function MeshBuildsInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey =
    sessionRequestScopeKey(sessionStatusHooks.useSessionResourceIdentity()) ?? undefined;
  const activeLane = useActiveLane();
  const femMode = activeLane === "fem";

  const activeBuildRes = geometryLifecycleResources.useMeshBuildCurrent({
    enabled: femMode,
  });
  const latestBuildRes = useSafeMeshBuildLatestSuccessful({ enabled: femMode });
  const historyRes = geometryLifecycleResources.useMeshBuildHistoryResource({
    enabled: femMode,
  });
  const reportRes = geometryLifecycleResources.useMeshSharedDomainReportResource({
    enabled: femMode,
  });
  const manifestRes = geometryLifecycleResources.useMeshSharedDomainManifestResource({
    enabled: femMode,
  });
  const summaryRes = geometryLifecycleResources.useMeshSummaryResource({
    enabled: femMode,
  });
  const semanticsRes = geometryLifecycleResources.useMeshSemanticsResource({
    enabled: femMode,
  });
  const sceneRes = geometryLifecycleResources.useSceneResource({
    enabled: femMode,
  });
  const domainMeta = geometryLifecycleResources.useDomainMetaResource({
    enabled: activeLane === "fdm",
  });

  const historyEntries = useMemo(() => {
    const rec = asRecord(historyRes.data);
    return normalizeMeshBuildHistory(
      rec?.history ?? rec?.entries ?? rec?.builds ?? historyRes.data,
    );
  }, [historyRes.data]);

  const baseline = useMemo<MeshBuildsDraft>(
    () => ({
      compareA: historyEntries[0]?.id ?? "latest",
      compareB: historyEntries.at(-1)?.id ?? historyEntries[0]?.id ?? "latest",
    }),
    [historyEntries],
  );

  const lastBuildError =
    activeBuildRes.data?.last_build_error ?? latestBuildRes.data?.last_build_error;
  const retainedArtifact = useMemo(
    () =>
      resolveRetainedMeshArtifact({
        lastBuildError,
        latestSuccess: latestBuildRes.data?.last_success,
        manifest: manifestRes.data,
        meshRevision: summaryRes.data?.revision,
      }),
    [
      lastBuildError,
      latestBuildRes.data?.last_success,
      manifestRes.data,
      summaryRes.data?.revision,
    ],
  );

  const mixedTopology = useMemo(
    () =>
      resolveMixedTopologyPresentation({
        buildReport:
          activeBuildRes.data?.shared_domain_build_report ??
          asRecord(asRecord(semanticsRes.data)?.solver_mesh)?.build_report ??
          asRecord(reportRes.data)?.report,
        manifest: manifestRes.data,
        rejectionEvidence: activeBuildRes.data?.mixed_layer_topology_rejection,
      }),
    [activeBuildRes.data, manifestRes.data, reportRes.data, semanticsRes.data],
  );

  const operationStatuses = useMemo(
    () =>
      activeBuildRes.data?.shared_domain_build_report?.operation_statuses ?? [],
    [activeBuildRes.data],
  );
  const thinFilmDiagnostics = useMemo(
    () =>
      activeBuildRes.data?.shared_domain_build_report?.thin_film_diagnostics ?? [],
    [activeBuildRes.data],
  );

  const freshness = useMemo(() => {
    if (!femMode) return null;
    const sceneRec = asRecord(sceneRes.data);
    const sceneRev =
      asNumber(sceneRec?.revision) ?? asNumber(sceneRec?.scene_revision);
    return resolveMeshBuildFreshness({
      activeBuild: asRecord(activeBuildRes.data?.active_build),
      latestBuild: asRecord(
        activeBuildRes.data?.last_build_summary ?? latestBuildRes.data?.last_success,
      ),
      manifest: manifestRes.data as Record<string, unknown> | null | undefined,
      sceneRevision: sceneRev,
      statusMeshRevision: summaryRes.data?.revision,
    });
  }, [
    activeBuildRes.data?.active_build,
    activeBuildRes.data?.last_build_summary,
    femMode,
    latestBuildRes.data?.last_success,
    manifestRes.data,
    sceneRes.data,
    summaryRes.data?.revision,
  ]);

  const stageRows = useMemo(() => {
    if (activeLane === "fdm") {
      const grid = domainMeta.data?.grid;
      return [
        {
          detail: grid?.shape ? grid.shape.join(" × ") : "Pending",
          id: "fdm-grid",
          stage: "Structured grid realization",
          status: grid ? "Materialized" : "Not materialized",
        },
        {
          detail: grid?.spacing
            ? grid.spacing.map((v) => formatLengthSmart(v) ?? String(v)).join(" × ")
            : "Pending",
          id: "fdm-spacing",
          stage: "Voxel cell spacing",
          status: grid ? "Resolved" : "Pending",
        },
        {
          detail: domainMeta.data?.generation_id ?? "Pending",
          id: "fdm-gen",
          stage: "Domain generation",
          status: domainMeta.data?.generation_id ? "Published" : "Pending",
        },
      ];
    }
    const rep =
      asRecord(activeBuildRes.data?.shared_domain_build_report) ??
      asRecord(asRecord(reportRes.data)?.report) ??
      asRecord(reportRes.data);
    const rawStages = Array.isArray(rep?.stages)
      ? rep.stages
      : Array.isArray(activeBuildRes.data?.mesh_pipeline_status)
        ? (activeBuildRes.data?.mesh_pipeline_status as unknown[])
        : [];
    return rawStages.map((s, i) => {
      const sr = asRecord(s) ?? {};
      const ms = asNumber(sr.duration_ms);
      const sec = asNumber(sr.duration_s) ?? asNumber(sr.duration_seconds);
      return {
        detail:
          ms !== null
            ? `${ms.toFixed(0)} ms`
            : sec !== null
              ? `${sec.toPrecision(3)} s`
              : sanitizeMeshDisplayText(sr.detail ?? sr.message, "—"),
        id: asString(sr.id) ?? asString(sr.phase) ?? `stage-${i}`,
        stage: asString(sr.name) ?? asString(sr.label) ?? asString(sr.phase) ?? `Stage ${i + 1}`,
        status: sanitizeMeshDisplayText(sr.status ?? sr.state, "Recorded"),
      };
    });
  }, [activeBuildRes.data, activeLane, domainMeta.data, reportRes.data]);

  const entryOptions = useMemo(
    () =>
      historyEntries.length > 0
        ? historyEntries.map((e) => ({
            label: `#${e.index + 1} ${e.meshName ?? "mesh"} · ${e.id}`,
            value: e.id,
          }))
        : [{ label: "Current session revision", value: "latest" }],
    [historyEntries],
  );

  const handleBuildSharedDomain = useCallback(async () => {
    const cmd = activeLane === "fdm" ? "grid.build-fdm" : "mesh.build-shared-domain";
    await kernel.commands.execute(
      cmd,
      createCommandContext("inspector", kernel, {
        sessionScopeKey: sessionScopeKey ?? null,
        sourceDetail: "mesh.builds",
      }),
    );
  }, [activeLane, kernel, sessionScopeKey]);

  const handleRestoreEntry = useCallback(
    (entry: MeshBuildHistoryEntry) => {
      restoreMeshHistoryToDraft(kernel, entry);
    },
    [kernel],
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
        primaryHeaderAction: {
          icon: Grid3x3,
          label:
            activeLane === "fdm" ? "Re-voxelize Grid" : "Build Shared-Domain Mesh",
          onRun: handleBuildSharedDomain,
        },
        extraMenuActions: [
          {
            icon: History,
            id: "inspect-raw-json",
            label: "Inspect raw build JSON",
            onSelect: (ctx) => {
              ctx.openCodePreview(
                "Mesh build report JSON",
                "json",
                JSON.stringify(
                  reportRes.data ?? activeBuildRes.data ?? historyRes.data ?? {},
                  null,
                  2,
                ),
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
          activeLane === "fdm" ? "FDM voxelization provenance" : "FEM Gmsh build pipeline",
        statePill: () => {
          if (retainedArtifact) return { label: "Retained after failure", tone: "warn" };
          if (freshness?.state === "stale") return { label: "Stale", tone: "warn" };
          return { label: "Recorded", tone: "ok" };
        },
        title: () => "Mesh Build Pipeline & History",
      },
      facts: () => [
        {
          id: "engine",
          label: "Engine",
          value: activeLane === "fdm" ? "FDM Voxelizer" : "Gmsh OCC",
        },
        {
          id: "retained",
          label: "Recorded builds",
          value: String(historyEntries.length),
        },
        {
          id: "freshness",
          label: "Freshness",
          value: freshness ? sanitizeMeshDisplayText(freshness.state, "current") : null,
        },
      ],
      notices: () => {
        const list: InspectorNotice<MeshBuildsDraft>[] = [];
        if (retainedArtifact?.state === "retained") {
          list.push({
            id: "retained-after-failure",
            text: `Latest mesh build failed (${sanitizeMeshDisplayText(lastBuildError, "build error")}). Workspace retains ${retainedArtifact.meshName ?? retainedArtifact.meshId ?? "published mesh"} at revision ${retainedArtifact.meshRevision ?? "current"}.`,
            title: "Retained published mesh after failed build",
            tone: "warn",
          });
        } else if (lastBuildError) {
          list.push({
            id: "last-build-error",
            text: sanitizeMeshDisplayText(lastBuildError),
            title: "Last mesh build error",
            tone: "err",
          });
        }
        return list;
      },
      sections: [
        {
          defaultOpen: true,
          footer: () => (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                void handleBuildSharedDomain();
              }}
            >
              {activeLane === "fdm" ? "Re-voxelize Grid" : "Build Shared-Domain Mesh"}
            </Button>
          ),
          icon: Activity,
          id: "active-pipeline",
          rows: [
            {
              format: () =>
                lastBuildError
                  ? sanitizeMeshDisplayText(lastBuildError)
                  : "None",
              label: "Last build error",
              type: "readonly",
            },
            {
              format: () =>
                retainedArtifact?.state === "retained"
                  ? `Yes — ${retainedArtifact.meshName ?? retainedArtifact.meshId ?? "published artifact"}`
                  : "Not applicable",
              label: "Retained after failure",
              type: "readonly",
            },
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
                  header: "Detail",
                  id: "detail",
                  mono: true,
                  renderCell: (r) => (r as (typeof stageRows)[number]).detail,
                },
              ],
              label: "Pipeline stages",
              rowKey: (r) => (r as (typeof stageRows)[number]).id,
              rows: () => stageRows,
              showWhen: () => stageRows.length > 0,
              type: "table",
              wide: true,
            },
          ],
          title: "Build pipeline & rollback state",
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
                  JSON.stringify(
                    reportRes.data ?? activeBuildRes.data ?? historyRes.data ?? {},
                    null,
                    2,
                  ),
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
              label: "Base build (Before)",
              options: entryOptions,
              showWhen: () => historyEntries.length >= 2,
              type: "select",
            },
            {
              key: "compareB",
              label: "Target build (After)",
              options: entryOptions,
              showWhen: () => historyEntries.length >= 2,
              type: "select",
            },
            {
              render: (ctx) => (
                <MeshBuildHistorySpecView
                  afterId={ctx.draft.compareB}
                  beforeId={ctx.draft.compareA}
                  entries={historyEntries}
                  onRestore={handleRestoreEntry}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => femMode,
          title: "Build history, revision comparison & policy restore",
        },
        {
          defaultOpen: true,
          icon: Layers,
          id: "builds-mixed-topology",
          rows: [
            {
              render: () => <MixedTopologyProvenanceSpecView model={mixedTopology} />,
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => femMode && mixedTopology.visible,
          title: "Mixed-topology provenance",
        },
        {
          defaultOpen: false,
          icon: Settings2,
          id: "builds-operation-statuses",
          rows: [
            {
              render: () => (
                <OperationStatusesSpecView operationStatuses={operationStatuses} />
              ),
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => femMode,
          title: "Operation statuses",
        },
        {
          defaultOpen: false,
          icon: Ruler,
          id: "builds-thin-film",
          rows: [
            {
              render: () => (
                <ThinFilmDiagnosticsSpecView diagnostics={thinFilmDiagnostics} />
              ),
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => femMode,
          title: "Thin-film diagnostics",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Build provenance, comparison & draft policy restoration",
      },
    }),
    [
      activeBuildRes.data,
      activeLane,
      entryOptions,
      femMode,
      freshness,
      handleBuildSharedDomain,
      handleRestoreEntry,
      historyEntries,
      historyRes.data,
      lastBuildError,
      mixedTopology,
      operationStatuses,
      reportRes.data,
      retainedArtifact,
      stageRows,
      thinFilmDiagnostics,
    ],
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
  const kernel = useKernel();
  const manifest = geometryLifecycleResources.useMeshSharedDomainManifestResource();
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
    () => ({ highlightAllOrphans: false }),
    [],
  );

  const syncOrphansHighlight = useCallback(
    (highlight: boolean) => {
      if (!kernel.visualization?.patchTarget) return;
      for (const part of orphanParts) {
        if (highlight) {
          kernel.visualization.patchTarget(
            { id: part.id, kind: "part", label: part.label },
            { boundsVisible: true, visible: true, wireframeVisible: true },
          );
        } else {
          kernel.visualization.clearTarget?.({
            id: part.id,
            kind: "part",
            label: part.label,
          });
        }
      }
    },
    [kernel.visualization, orphanParts],
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
          live: true,
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
                  ref: {
                    carrierPartId: part.id,
                    kind: "mesh-part",
                    nodeId: `model:mesh:unassigned:${encodeURIComponent(part.id)}`,
                    objectId: null,
                    type: "mesh-part",
                    visualizationTargetId: `mesh-part:${part.id}`,
                  },
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
        onResetDisplay: () => {
          syncOrphansHighlight(false);
        },
        statusMessage: "Select an unassigned part to inspect display or bind ownership",
      },
    }),
    [orphanParts, syncOrphansHighlight],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      options={{
        onLiveFieldChange: (key, value) => {
          if (key === "highlightAllOrphans") {
            syncOrphansHighlight(Boolean(value));
          }
        },
      }}
      selection={selection}
      spec={spec}
    />
  );
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
  visible: boolean;
  renderMode: VisualizationRenderMode;
  showWireframe: boolean;
  showBounds: boolean;
  opacityPercent: number;
}

export function MeshUnassignedPartInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey =
    sessionRequestScopeKey(sessionStatusHooks.useSessionResourceIdentity()) ?? undefined;
  const scene = geometryLifecycleResources.useSceneResource();
  const [appliedCount, setAppliedCount] = useState(0);

  const rawPartId =
    (selection.ref as { carrierPartId?: string; meshPartId?: string } | null)
      ?.carrierPartId ??
    (selection.ref as { carrierPartId?: string; meshPartId?: string } | null)
      ?.meshPartId ??
    selection.nodeId?.split(":").at(-1) ??
    "part";
  const partId = decodeURIComponent(rawPartId);
  const partLabel = selection.label || partId;

  const partTargetRef = useMemo(
    () => ({ id: partId, kind: "part" as const, label: partLabel }),
    [partId, partLabel],
  );

  const partVizSelection = useMemo(
    () => ({
      ...selection,
      ref: {
        carrierPartId: partId,
        kind: "mesh-part" as const,
        nodeId: selection.nodeId ?? `model:mesh:unassigned:${encodeURIComponent(partId)}`,
        objectId: selection.objectId ?? null,
        type: "mesh-part" as const,
        visualizationTargetId: `mesh-part:${partId}`,
      },
    }),
    [partId, selection],
  );

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

  const baseline = useMemo<UnassignedPartDraft>(() => {
    const currentSettings = kernel.visualization?.getSettings?.(partTargetRef);
    return {
      assignmentAction: "assign_object",
      newObjectName: partLabel,
      newObjectRole: "magnetic",
      opacityPercent: currentSettings?.surfaceOpacityPercent ?? 80,
      renderMode: currentSettings?.renderMode ?? "surface",
      showBounds: currentSettings?.boundsVisible ?? false,
      showWireframe: currentSettings?.wireframeVisible ?? true,
      targetObjectId: objectOptions[0]?.value ?? "",
      visible: currentSettings?.visible ?? true,
    };
  }, [kernel.visualization, objectOptions, partLabel, partTargetRef]);

  const handleLivePartDisplayChange = useCallback(
    <K extends keyof UnassignedPartDraft & string>(
      key: K,
      value: UnassignedPartDraft[K],
    ) => {
      if (!kernel.visualization?.patchTarget) return;
      if (key === "visible") {
        kernel.visualization.patchTarget(partTargetRef, { visible: Boolean(value) });
      } else if (key === "renderMode") {
        kernel.visualization.patchTarget(partTargetRef, {
          renderMode: value as VisualizationRenderMode,
        });
      } else if (key === "showWireframe") {
        kernel.visualization.patchTarget(partTargetRef, {
          wireframeVisible: Boolean(value),
        });
      } else if (key === "showBounds") {
        kernel.visualization.patchTarget(partTargetRef, {
          boundsVisible: Boolean(value),
        });
      } else if (key === "opacityPercent") {
        kernel.visualization.patchTarget(partTargetRef, {
          surfaceOpacityPercent: Number(value),
        });
      }
    },
    [kernel.visualization, partTargetRef],
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
        kindLabel: "Mesh-part visualization & ownership",
        statePill: () =>
          appliedCount > 0
            ? { label: "Assigned", tone: "ok" }
            : { label: "Unassigned part", tone: "warn" },
        title: () => partLabel,
      },
      facts: () => [
        { id: "part-id", label: "Part ID", value: partId },
        { id: "dim", label: "Target", value: `mesh-part:${partId}` },
      ],
      modeTabs: [
        { commitModeOverride: "liveViewport", id: "display", label: "3D Display" },
        { commitModeOverride: "staged", id: "assignment", label: "Ownership" },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: SlidersHorizontal,
          id: "display-controls",
          live: true,
          modeTabId: "display",
          rows:
            typeof kernel.visualization?.subscribe === "function"
              ? [
                  {
                    render: () => (
                      <MeshPartVisualizationPanel selection={partVizSelection} />
                    ),
                    type: "custom",
                    wide: true,
                  },
                ]
              : [
                {
                  key: "visible",
                  label: "Part visible in 3D",
                  type: "switch",
                },
                {
                  key: "renderMode",
                  label: "Render mode",
                  options: [
                    { label: "Surface", value: "surface" },
                    { label: "Surface + edges", value: "surface+edges" },
                    { label: "Wireframe", value: "wireframe" },
                    { label: "Points", value: "points" },
                    { label: "Off", value: "off" },
                  ],
                  type: "select",
                },
                {
                  key: "showWireframe",
                  label: "Wireframe overlay",
                  type: "switch",
                },
                {
                  key: "showBounds",
                  label: "Bounding box",
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
          title: "Mesh-part 3D visualization",
        },
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
      ],
      commitBar: {
        cleanMessage: () => "Select an ownership binding and click Apply",
        mode: "staged",
        onApply: async (draft) => {
          const sceneRec = asRecord(scene.data);
          const baseRev =
            asNumber(sceneRec?.revision) ?? asNumber(sceneRec?.scene_revision) ?? 0;
          const existingObjects = Array.isArray(sceneRec?.objects)
            ? (sceneRec.objects as JsonObject[])
            : [];
          const existingEditor = asRecord(sceneRec?.editor) ?? {};
          const existingBindings = asRecord(existingEditor.mesh_part_assignments) ?? {};

          let mergePatch: JsonObject;
          if (draft.assignmentAction === "assign_object") {
            const updatedObjects = existingObjects.map((rawObj) => {
              const obj = asRecord(rawObj);
              if (!obj || asString(obj.id) !== draft.targetObjectId) return rawObj;
              const prevMesh = asRecord(obj.object_mesh) ?? {};
              const prevBound = Array.isArray(prevMesh.bound_mesh_part_ids)
                ? (prevMesh.bound_mesh_part_ids as string[])
                : [];
              const nextBound = Array.from(new Set([...prevBound, partId]));
              return {
                ...rawObj,
                object_mesh: {
                  ...(prevMesh as JsonObject),
                  bound_mesh_part_ids: nextBound,
                },
              } as JsonObject;
            });
            mergePatch = {
              editor: {
                ...(existingEditor as JsonObject),
                mesh_part_assignments: {
                  ...(existingBindings as JsonObject),
                  [partId]: {
                    action: "assign_object",
                    target_object_id: draft.targetObjectId,
                  },
                },
              },
              objects: updatedObjects,
            };
          } else if (draft.assignmentAction === "create_object") {
            const slug =
              draft.newObjectName
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9_-]+/g, "_")
                .replace(/^_+|_+$/g, "") || "part_object";
            const existingIds = new Set(
              existingObjects
                .map((o) => asString(asRecord(o)?.id))
                .filter((x): x is string => Boolean(x)),
            );
            let candidateId = slug;
            let suffix = 2;
            while (existingIds.has(candidateId)) {
              candidateId = `${slug}_${suffix}`;
              suffix += 1;
            }
            const role =
              draft.newObjectRole === "magnetic" ? "magnet" : draft.newObjectRole;
            const createdObject: JsonObject = {
              id: candidateId,
              name: draft.newObjectName.trim(),
              object_mesh: {
                bound_mesh_part_ids: [partId],
              },
              role,
              visible: true,
            };
            mergePatch = {
              editor: {
                ...(existingEditor as JsonObject),
                mesh_part_assignments: {
                  ...(existingBindings as JsonObject),
                  [partId]: {
                    action: "create_object",
                    target_object_id: candidateId,
                  },
                },
              },
              objects: [...existingObjects, createdObject],
            };
          } else if (draft.assignmentAction === "assign_airbox") {
            const existingUniverse = asRecord(sceneRec?.universe) ?? {};
            const prevParts = Array.isArray(existingUniverse.bound_mesh_part_ids)
              ? (existingUniverse.bound_mesh_part_ids as string[])
              : [];
            mergePatch = {
              editor: {
                ...(existingEditor as JsonObject),
                mesh_part_assignments: {
                  ...(existingBindings as JsonObject),
                  [partId]: { action: "assign_airbox" },
                },
              },
              universe: {
                ...(existingUniverse as JsonObject),
                bound_mesh_part_ids: Array.from(new Set([...prevParts, partId])),
              },
            };
          } else {
            mergePatch = {
              editor: {
                ...(existingEditor as JsonObject),
                mesh_part_assignments: {
                  ...(existingBindings as JsonObject),
                  [partId]: { action: "ignore_nonphysical" },
                },
              },
            };
          }

          const reqOptions = sessionScopeKey ? { sessionScopeKey } : undefined;
          const mutationCtx = buildSafeMutationContext(
            kernel,
            sessionScopeKey,
            "mesh.unassigned.part",
          );
          const committed = await runAuthoringMutationWithHistory(
            mutationCtx,
            `Assign mesh part ${partLabel}`,
            async (prep) => {
              const tx: AuthoringTransactionRequest = {
                base_revision: prep.baseRevision ?? baseRev,
                kind: "merge_patch",
                merge_patch: mergePatch,
              };
              return kernel.api.model.commitTransaction(tx, reqOptions);
            },
          );
          const committedScene = asRecord(committed)?.committed_scene as
            | SceneResource
            | undefined;
          if (
            committedScene &&
            geometryLifecycleResources.publishCommittedSceneResource
          ) {
            const committedRev =
              asNumber(asRecord(committedScene)?.revision) ??
              `w5:${Date.now()}`;
            geometryLifecycleResources.publishCommittedSceneResource(
              kernel.resources,
              committedScene,
              committedRev,
              undefined,
              true,
              sessionScopeKey ?? null,
              kernel.api.resourceCacheScope,
            );
          }
          invalidateAuthoringMutationDependents(
            kernel.resources,
            "geometry",
            `w5:${Date.now()}`,
          );
          kernel.resources.invalidate(
            geometryLifecycleResources.SCENE_RESOURCE_KEY,
            `w5:${Date.now()}`,
          );
          kernel.resources.invalidate(
            geometryLifecycleResources.MESH_SEMANTICS_RESOURCE_KEY,
            `w5:${Date.now()}`,
          );
          setAppliedCount((c) => c + 1);
          return true;
        },
      },
    }),
    [
      appliedCount,
      kernel,
      objectOptions,
      partId,
      partLabel,
      partVizSelection,
      scene.data,
      sessionScopeKey,
    ],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      options={{ onLiveFieldChange: handleLivePartDisplayChange }}
      selection={selection}
      spec={spec}
    />
  );
}
