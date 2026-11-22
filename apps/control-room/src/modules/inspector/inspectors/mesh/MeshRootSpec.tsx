"use client";

import { Compass, Grid3x3, Ruler, Settings2 } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import {
  resolveSessionAuthoringDiscretization,
  resolveSessionDiscretization,
} from "@/kernel/resources/sessionDiscretization";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import * as sessionStatusHooks from "@/kernel/resources/useSessionStatus";
import {
  SpecInspectorHost,
  type InspectorNotice,
  type InspectorPanelProps,
  type InspectorSpec,
  type InspectorTone,
} from "@/modules/inspector/shared";
import { Button } from "@/shared/ui/Button";

import { FdmMeshWorkflowCard } from "../../panels/mesh-details/FdmMeshWorkflowCard";
import { resolveMeshTopologyCounts } from "../../panels/mesh-details/meshTopologyCounts";
import { FemMeshReadinessGuideCard } from "../../panels/mesh-guide/FemMeshReadinessGuideCard";
import {
  applyMeshRootFemPolicy,
  buildEffectiveFemDefaultsPatch,
  buildMeshRootBaseline,
  hasAuthoredSceneFdmSizing,
  isMeshRootFdmDraftModified,
  persistMeshRootFdmPolicy,
  resolveEffectiveFdmGridShape,
  type MeshRootDraft,
} from "./meshRootModel";
import {
  asNumber,
  asRecord,
  asString,
  computeExchangeLengthGuard,
  formatLengthSmart,
  LENGTH_UNITS,
  SESSION_STATUS_KEY,
} from "./meshShared";

export type { MeshRootDraft } from "./meshRootModel";

export function MeshRootInspectorSpecPanel({ selection }: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionIdentity = sessionStatusHooks.useSessionResourceIdentity();
  const sessionStatusData = sessionStatusHooks.useSessionStatusSelector((s) => s.data);
  const sessionScopeKey = sessionRequestScopeKey(sessionIdentity) ?? undefined;
  const activeLane =
    sessionStatusHooks.useSessionStatusSelector(
      (status) =>
        resolveSessionDiscretization(status.data) ??
        resolveSessionAuthoringDiscretization(status.data),
    ) ?? "unresolved";
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

  const baseline = useMemo<MeshRootDraft>(
    () =>
      buildMeshRootBaseline({
        domainGrid: domainMeta.data?.grid,
        femActive,
        multilayerAvailable: Boolean(multilayer.data?.available),
        sceneData: scene.data,
        sharedPolicyData: sharedPolicy.data,
        universePolicyData: universePolicy.data,
      }),
    [
      domainMeta.data?.grid,
      femActive,
      multilayer.data?.available,
      scene.data,
      sharedPolicy.data,
      universePolicy.data,
    ],
  );

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
  const [fdmBuildError, setFdmBuildError] = useState<string | null>(null);
  const buildingNow = Boolean(activeBuild.data?.active_build);
  const fdmGridBuilt = Boolean(
    domainMeta.data?.grid &&
      Array.isArray(domainMeta.data.grid.shape) &&
      domainMeta.data.grid.shape.every((n) => typeof n === "number" && n > 0),
  );
  const hasAuthoredFdmSizing = useMemo(
    () => hasAuthoredSceneFdmSizing(scene.data),
    [scene.data],
  );

  const persistFdmDiscretizationPolicy = useCallback(
    (draft: MeshRootDraft) =>
      persistMeshRootFdmPolicy({
        draft,
        kernel,
        sceneData: scene.data,
        sessionScopeKey,
        universePolicyData: universePolicy.data,
      }),
    [kernel, scene.data, sessionScopeKey, universePolicy.data],
  );

  const spec = useMemo<InspectorSpec<MeshRootDraft>>(() => {
    const resolveGridShape = (draft: MeshRootDraft) =>
      resolveEffectiveFdmGridShape(scene.data, draft);
    const runBuildFdmGrid = async (draft: MeshRootDraft, base: MeshRootDraft) => {
      setFdmBuildError(null);
      try {
        let latestScene: SceneResource | null = scene.data ?? null;
        if (isMeshRootFdmDraftModified(draft, base) || !hasAuthoredFdmSizing) {
          const committed = await persistFdmDiscretizationPolicy(draft);
          if (committed) latestScene = committed;
        }
        const result = await kernel.commands.execute(
          "grid.build-fdm",
          createCommandContext("inspector", kernel, {
            resourceData: {
              ...(sessionStatusData ? { [SESSION_STATUS_KEY]: sessionStatusData } : {}),
              ...(latestScene
                ? { [geometryLifecycleResources.SCENE_RESOURCE_KEY]: latestScene }
                : {}),
            },
            sessionScopeKey: sessionScopeKey ?? null,
            sourceDetail: "mesh.root",
          }),
        );
        if (result?.status === "failed" && result.message) {
          setFdmBuildError(result.message);
        }
      } catch (err) {
        setFdmBuildError(
          err instanceof Error ? err.message : "Failed to save FDM grid sizing.",
        );
      }
    };
    const runBuildFemMesh = async (sourceDetail: string) => {
      setFdmBuildError(null);
      try {
        const result = await kernel.commands.execute(
          "mesh.build-shared-domain",
          createCommandContext("inspector", kernel, {
            resourceData: {
              ...(sessionStatusData ? { [SESSION_STATUS_KEY]: sessionStatusData } : {}),
              ...(scene.data
                ? { [geometryLifecycleResources.SCENE_RESOURCE_KEY]: scene.data }
                : {}),
            },
            sessionScopeKey: sessionScopeKey ?? null,
            sourceDetail,
          }),
        );
        if (result?.status === "failed" && result.message) {
          setFdmBuildError(result.message);
        }
      } catch (err) {
        setFdmBuildError(
          err instanceof Error ? err.message : "Failed to build shared-domain FEM mesh.",
        );
      }
    };
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
            const shape = resolveGridShape(draft);
            const guard = computeExchangeLengthGuard(scene.data, draft.cellSizeM, shape);
            if (guard?.exceeds) {
              return {
                label: guard.ratio > 1.5 ? "Exchange violation" : "Cell > l_ex",
                tone: guard.ratio > 1.5 ? "err" : "warn",
              };
            }
            if (!fdmGridBuilt) {
              return {
                label: hasAuthoredFdmSizing ? "Not built" : "Not configured",
                tone: "warn",
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
          const shape = resolveGridShape(draft);
          const guard = computeExchangeLengthGuard(scene.data, draft.cellSizeM, shape);
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
              label: fdmGridBuilt ? "Grid" : "Estimated grid",
              value: `${shape[0]} × ${shape[1]} × ${shape[2]}`,
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
        if (fdmBuildError) {
          list.push({
            id: "fdm-build-error",
            text: fdmBuildError,
            title:
              draft.lane === "fem"
                ? "FEM mesh build failed"
                : "FDM grid configuration failed",
            tone: "err",
          });
        }
        if (draft.lane === "fdm") {
          const shape = resolveGridShape(draft);
          const guard = computeExchangeLengthGuard(scene.data, draft.cellSizeM, shape);
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
                await runBuildFemMesh("mesh.root.notice");
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
          icon: Compass,
          id: "fdm-workflow",
          rows: [
            {
              render: (ctx) => {
                const shape = resolveGridShape(ctx.draft);
                return (
                  <FdmMeshWorkflowCard
                    activeCellSizeM={ctx.draft.cellSizeM}
                    activeGridShape={shape}
                    buildBusy={buildingNow}
                    buildError={fdmBuildError}
                    canAutoSaveCellSize
                    cellSizeModified={isMeshRootFdmDraftModified(ctx.draft, ctx.baseline)}
                    domainMeta={domainMeta.data}
                    gridMaterialized={fdmGridBuilt}
                    sceneData={scene.data}
                    sessionScopeKey={sessionScopeKey ?? null}
                    onBuildGrid={() => runBuildFdmGrid(ctx.draft, ctx.baseline)}
                    onFocusCellSize={() => {
                      const inspectorControl = (
                        kernel as unknown as {
                          inspector?: { focusRow?: (rowKey: string) => void };
                        }
                      ).inspector;
                      inspectorControl?.focusRow?.("cellSizeM");
                    }}
                    onSelectNode={(next) => ctx.selectNode(next)}
                  />
                );
              },
              type: "custom",
              wide: true,
            },
          ],
          showWhen: (d) => d.lane === "fdm",
          summary: () => (fdmGridBuilt ? "Grid ready" : "Follow steps 1 → 4"),
          title: "FDM grid workflow",
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
          summary: () => (manifest.data ? "Shared-domain mesh built" : "Follow steps 1 → 6"),
          title: "FEM mesh workflow",
        },
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
          footer: (ctx) => {
            const modified = isMeshRootFdmDraftModified(ctx.draft, ctx.baseline);
            return (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  type="button"
                  variant="primary"
                  onClick={() => {
                    void runBuildFdmGrid(ctx.draft, ctx.baseline);
                  }}
                >
                  {fdmGridBuilt
                    ? modified
                      ? "Save & Re-voxelize Grid"
                      : "Re-voxelize Grid"
                    : modified || !hasAuthoredFdmSizing
                      ? "Save & Build Grid"
                      : "Build Structured Grid"}
                </Button>
              </div>
            );
          },
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
          summary: (d) => {
            const shape = resolveGridShape(d);
            return `${shape[0]} × ${shape[1]} × ${shape[2]} · ${Number((d.cellSizeM[0] * 1e9).toFixed(2))} nm`;
          },
          title: "Global FDM grid sizing",
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
                  ctx.patchDraft(
                    buildEffectiveFemDefaultsPatch(sharedPolicy.data, universePolicy.data),
                  );
                }}
              >
                Load Effective Defaults
              </Button>
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => {
                  void runBuildFemMesh("mesh.root.footer");
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
        allowCleanApply: (d) => d.lane === "fdm" && !hasAuthoredFdmSizing,
        applyLabel: (d) =>
          d.lane === "fdm" && !hasAuthoredFdmSizing ? "Apply Grid Sizing" : "Apply",
        cleanMessage: (d) =>
          d.lane === "fdm"
            ? hasAuthoredFdmSizing
              ? "FDM grid sizing matches session policy"
              : "Review cell size Δ and click Apply Grid Sizing or Build Structured Grid"
            : "FEM shared-domain policy is up to date",
        mode: "staged",
        onApply: async (draft) => {
          if (draft.lane === "fdm") {
            await persistFdmDiscretizationPolicy(draft);
          } else {
            await applyMeshRootFemPolicy({
              draft,
              kernel,
              sessionScopeKey,
              sharedPolicyData: sharedPolicy.data,
              universePolicyData: universePolicy.data,
            });
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
    domainMeta.data,
    fdmBuildError,
    fdmGridBuilt,
    femActive,
    femElements,
    femNodes,
    hasAuthoredFdmSizing,
    kernel,
    manifest.data,
    manifestSourceRev,
    persistFdmDiscretizationPolicy,
    scene.data,
    sceneRev,
    sessionScopeKey,
    sessionStatusData,
    sharedPolicy.data,
    summary.data,
    universePolicy.data,
  ]);

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
