"use client";

import { Scissors, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { MODEL_PLANAR_MONITORS_PATH } from "@/kernel/api/apiPaths";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { SessionCommandCancelledError } from "@/kernel/commands/commandSessionScope";
import { useKernel } from "@/kernel/KernelContext";
import {
  useDomainMetaResource,
  useSceneResource,
  useVisualizationStateResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import {
  beginCrossSectionDraft,
  commitCrossSectionDraft,
  crossSectionWorkspaceStore,
  discardCrossSectionDraft,
  isPlanarMonitorRevisionConflict,
  updateCrossSectionDraft,
  type CrossSectionDraft,
} from "@/kernel/workspace/crossSectionWorkspace";
import { planarMonitorFramePreviewStore } from "@/kernel/workspace/planarMonitorFramePreview";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorSpec } from "../../template";
import { SpecInspectorHost } from "../../panels/mesh-details/SpecInspectorHost";
import {
  buildFramePreviewFor3DGizmo,
  buildPlanarMonitorCreatePayload,
  buildPlanarVisualizationPatch,
  buildSliceDraftFromWorkspace,
  buildTargetOptions,
  deleteCompanionSliceMeta,
  getCompanionSliceMeta,
  resolveDomainBounds,
  setCompanionSliceMeta,
  toCompanionSliceMeta,
  toCrossSectionDraft,
  type CompanionSliceMeta,
  type SliceFormDraft,
} from "../../panels/cross-sections/visualizations2DModel";
import {
  useResolvedSessionScopeKey,
  useCrossSectionWorkspace,
  syncCoupledSliceFieldChange,
  buildSharedAuthoringSections,
} from "./visualizations2DShared";

// ═══════════════════════════════════════════════════════════════════════════
// 2. visualizations-2d.draft (+ redirected mesh.cross-section.draft)
// ═══════════════════════════════════════════════════════════════════════════

export function Visualizations2DDraftInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = useResolvedSessionScopeKey();
  const workspace = useCrossSectionWorkspace();
  const domainMetaRes = useDomainMetaResource();
  const sceneRes = useSceneResource();
  const vizState = useVisualizationStateResource();

  const canQueryMonitors =
    kernel?.api === undefined ||
    typeof kernel.api?.model?.planarMonitors?.list === "function";
  const monitors = usePlanarMonitorsResource({ enabled: canQueryMonitors });

  const vizData = vizState.data;
  const vizPlanar = vizData?.planar;
  const domainData = domainMetaRes.data;
  const sceneData = sceneRes.data;
  const monitorsList = monitors.data?.monitors;
  const monitorsSceneRevision = monitors.data?.scene_revision;
  const refetchMonitors = monitors.refetch;
  const workspaceDraft = workspace.draft;

  const [revisionConflict, setRevisionConflict] = useState(false);

  useEffect(() => {
    if (!crossSectionWorkspaceStore.getSnapshot().draft) {
      beginCrossSectionDraft(vizData);
    }
  }, [vizData]);

  const bounds = useMemo(
    () => resolveDomainBounds(domainData),
    [domainData],
  );
  const targetOptions = useMemo(
    () => buildTargetOptions(sceneData),
    [sceneData],
  );

  const draftSessionKey = selection.nodeId ?? "draft";
  const [anchoredDraftState, setAnchoredDraftState] = useState<{
    companion: CompanionSliceMeta | undefined;
    sessionKey: string;
    source: CrossSectionDraft | null;
  }>(() => ({
    companion: getCompanionSliceMeta("draft"),
    sessionKey: draftSessionKey,
    source: workspaceDraft,
  }));

  if (
    anchoredDraftState.sessionKey !== draftSessionKey ||
    (anchoredDraftState.source === null && workspaceDraft !== null)
  ) {
    setAnchoredDraftState({
      companion: getCompanionSliceMeta("draft"),
      sessionKey: draftSessionKey,
      source: workspaceDraft,
    });
  }

  const anchoredSource = anchoredDraftState.source;
  const anchoredCompanion = anchoredDraftState.companion;

  const baseline = useMemo<SliceFormDraft>(
    () =>
      buildSliceDraftFromWorkspace(
        anchoredSource,
        anchoredCompanion,
        bounds,
        "Draft Cross-Section",
        "m",
      ),
    [anchoredCompanion, anchoredSource, bounds],
  );

  const syncLiveDraftPreview = useCallback(
    (nextDraft: SliceFormDraft) => {
      if (!crossSectionWorkspaceStore.getSnapshot().draft) {
        beginCrossSectionDraft(vizData);
      }
      updateCrossSectionDraft(toCrossSectionDraft(nextDraft));
      setCompanionSliceMeta("draft", toCompanionSliceMeta(nextDraft, null));
      planarMonitorFramePreviewStore.set(
        buildFramePreviewFor3DGizmo(nextDraft, bounds, "draft", true),
      );
    },
    [bounds, vizData],
  );

  const handleDraftFieldChange = useCallback(
    <K extends keyof SliceFormDraft & string>(
      key: K,
      value: SliceFormDraft[K],
      helpers: {
        draft: SliceFormDraft;
        patchDraft: (partial: Partial<SliceFormDraft>) => void;
      },
    ) => {
      setRevisionConflict(false);
      const nextDraft = syncCoupledSliceFieldChange(
        key,
        value,
        helpers.draft,
        bounds,
        helpers.patchDraft,
      );
      syncLiveDraftPreview(nextDraft);
    },
    [bounds, syncLiveDraftPreview],
  );

  const handleDiscardDraft = useCallback(() => {
    discardCrossSectionDraft();
    deleteCompanionSliceMeta("draft");
    planarMonitorFramePreviewStore.clear();
    kernel?.selection?.set?.(
      {
        kind: "visualizations-2d.root",
        label: "Visualizations 2D",
        nodeId: "model:visualizations-2d",
        objectId: null,
        ref: null,
      },
      "inspector",
    );
  }, [kernel]);

  const handleApplyDraft = useCallback(
    async (draft: SliceFormDraft): Promise<boolean> => {
      setRevisionConflict(false);
      const hasPlanarCreateApi =
        typeof kernel?.api?.model?.planarMonitors?.create === "function";

      if (hasPlanarCreateApi) {
        const activeCommandScope = kernel?.commands?.getSessionScopeKey?.();
        const operationScopeKey =
          sessionScopeKey ??
          (typeof activeCommandScope === "string" ? activeCommandScope : null);
        if (!operationScopeKey || activeCommandScope === null) {
          throw new Error(
            "Session identity is not ready. Try again after it loads.",
          );
        }

        const initialScope = activeCommandScope ?? operationScopeKey;
        const historyGeneration = kernel?.authoringHistory?.getGeneration?.();
        const isCurrentSessionScope = () =>
          (typeof kernel?.commands?.getSessionScopeKey === "function"
            ? (kernel.commands.getSessionScopeKey() ?? operationScopeKey) ===
              initialScope
            : true) &&
          (historyGeneration === undefined ||
            kernel?.authoringHistory?.getGeneration?.() === historyGeneration);

        try {
          const fetchedDomain =
            typeof kernel.api.data?.domain?.meta === "function"
              ? await kernel.api.data.domain.meta({
                  sessionScopeKey: operationScopeKey,
                })
              : domainData;

          if (!isCurrentSessionScope()) return false;

          const effectiveBounds = resolveDomainBounds(fetchedDomain);
          const existingMonitors = monitorsList ?? [];

          const created = await runAuthoringMutationWithHistory(
            {
              api: kernel.api,
              authoringHistory: kernel.authoringHistory,
              isCurrentSessionScope,
              selection: kernel.selection,
              sessionScopeKey: operationScopeKey,
            },
            `Create planar monitor ${draft.name}`,
            async ({ baseRevision }) => {
              const commitRevision = baseRevision ?? monitorsSceneRevision;
              if (
                typeof commitRevision !== "number" ||
                !Number.isFinite(commitRevision)
              ) {
                throw new Error(
                  "The canonical scene revision is not ready. Reload current monitors before applying.",
                );
              }
              const request = buildPlanarMonitorCreatePayload(
                draft,
                commitRevision,
                effectiveBounds,
                existingMonitors,
              );
              return kernel.api.model.planarMonitors.create(request, {
                sessionScopeKey: operationScopeKey,
              });
            },
          );

          if (!isCurrentSessionScope()) return false;

          if (!crossSectionWorkspaceStore.getSnapshot().draft) {
            beginCrossSectionDraft(vizData);
          }
          updateCrossSectionDraft({
            ...toCrossSectionDraft(draft),
            name: created.monitor.name,
          });
          const committedPlot = commitCrossSectionDraft();
          deleteCompanionSliceMeta("draft");
          planarMonitorFramePreviewStore.clear();

          if (committedPlot) {
            setCompanionSliceMeta(
              committedPlot.id,
              toCompanionSliceMeta(draft, created.monitor.id),
            );
          }

          kernel.visualizationSync?.queuePatch({
            planar: buildPlanarVisualizationPatch(
              draft,
              created.monitor.id,
              vizPlanar,
            ),
          });
          kernel.resources?.invalidate(
            MODEL_PLANAR_MONITORS_PATH,
            created.scene_revision,
          );
          kernel.layout?.setActiveViewportMainModule?.("field-map");
          kernel.layout?.setFocusedSlot?.("viewport-main");
          kernel.layout?.setPanelVisible?.("right", true);

          if (committedPlot) {
            const nodeId = `model:visualizations-2d:${committedPlot.id}`;
            kernel.selection?.set?.(
              {
                kind: "visualizations-2d.plot",
                label: committedPlot.name,
                nodeId,
                objectId: null,
                ref: {
                  kind: "visualizations-2d.plot",
                  nodeId,
                  plotId: committedPlot.id,
                  type: "cross-section-plot",
                  visualizationTargetId: `cross-section:plot:${committedPlot.id}`,
                },
              },
              "inspector",
            );
          } else {
            const nodeId = `model:definitions:planar-monitors:${created.monitor.id}`;
            kernel.selection?.set?.(
              {
                kind: "model.planar.monitor",
                label: created.monitor.name,
                nodeId,
                objectId: null,
                ref: {
                  kind: "model.planar.monitor",
                  monitorId: created.monitor.id,
                  nodeId,
                  type: "planar-monitor",
                  visualizationTargetId: `planar-monitor:${created.monitor.id}`,
                },
              },
              "inspector",
            );
          }
          return true;
        } catch (error) {
          if (error instanceof SessionCommandCancelledError) {
            return false;
          }
          if (isPlanarMonitorRevisionConflict(error)) {
            setRevisionConflict(true);
            throw new Error(
              "The scene changed while this monitor draft was open. Reload the current revision before applying again.",
            );
          }
          throw error instanceof Error
            ? error
            : new Error("Planar monitor creation failed.");
        }
      }

      if (!crossSectionWorkspaceStore.getSnapshot().draft) {
        beginCrossSectionDraft(vizData);
      }
      updateCrossSectionDraft(toCrossSectionDraft(draft));
      const plot = commitCrossSectionDraft();
      deleteCompanionSliceMeta("draft");
      planarMonitorFramePreviewStore.clear();
      if (plot) {
        setCompanionSliceMeta(plot.id, toCompanionSliceMeta(draft, null));
        kernel?.visualizationSync?.queuePatch({
          planar: buildPlanarVisualizationPatch(draft, null, vizPlanar),
        });
        const nodeId = `model:visualizations-2d:${plot.id}`;
        kernel?.selection?.set?.(
          {
            kind: "visualizations-2d.plot",
            label: plot.name,
            nodeId,
            objectId: null,
            ref: {
              kind: "visualizations-2d.plot",
              nodeId,
              plotId: plot.id,
              type: "cross-section-plot",
              visualizationTargetId: `cross-section:plot:${plot.id}`,
            },
          },
          "inspector",
        );
      }
      return Boolean(plot);
    },
    [
      domainData,
      kernel,
      monitorsList,
      monitorsSceneRevision,
      sessionScopeKey,
      vizData,
      vizPlanar,
    ],
  );

  const authoringSections = useMemo(
    () => buildSharedAuthoringSections(bounds, targetOptions),
    [bounds, targetOptions],
  );

  const spec = useMemo<InspectorSpec<SliceFormDraft>>(
    () => ({
      id: "visualizations-2d.draft",
      header: {
        breadcrumbs: [
          {
            id: "viz2d",
            label: "Visualizations 2D",
            selection: {
              kind: "visualizations-2d.root",
              label: "Visualizations 2D",
              nodeId: "model:visualizations-2d",
              objectId: null,
              ref: null,
            },
          },
          { id: "draft", label: "Draft" },
        ],
        primaryHeaderAction: {
          label: "Discard Draft",
          icon: Trash2,
          variant: "secondary",
          onRun: handleDiscardDraft,
        },
      },
      identity: {
        domain: "visualization",
        icon: Scissors,
        title: (d) => d.name || "Draft Cross-Section",
        renameFieldKey: "name",
        kindLabel: "Unsaved 2D cross-section draft",
        entityId: "cross-section:draft",
        statePill: () =>
          revisionConflict
            ? { tone: "err", label: "Revision conflict" }
            : { tone: "warn", label: "Draft" },
      },
      facts: (d) => [
        {
          id: "normal",
          label: "Normal",
          value: d.normalMode === "custom" ? "Custom" : d.plane.toUpperCase(),
        },
        {
          id: "pos",
          label: "Position",
          value: `${(d.positionM * 1e9).toFixed(1)} nm (${d.positionPercent.toFixed(1)}%)`,
        },
        {
          id: "qty",
          label: "Field / Metric",
          value: d.quantity === "mesh" ? d.metric : d.fieldComponent,
        },
        {
          id: "grid",
          label: "Sample grid",
          value: `${d.sampleGrid} × ${d.sampleGrid}`,
        },
      ],
      notices: () =>
        revisionConflict
          ? [
              {
                id: "revision-conflict",
                tone: "warn",
                title: "Scene revision conflict",
                text: "The scene changed while this monitor draft was open. Reload the current revision before applying again.",
                quickFix: {
                  label: "Reload current monitors",
                  onApply: () => {
                    setRevisionConflict(false);
                    refetchMonitors?.();
                  },
                },
              },
            ]
          : [],
      sections: authoringSections,
      commitBar: {
        mode: "staged",
        allowCleanApply: true,
        applyLabel: "Apply monitor",
        cleanMessage: () => "Ready to create planar monitor and 2D slice",
        onApply: handleApplyDraft,
        onRevert: (base) => {
          setRevisionConflict(false);
          syncLiveDraftPreview(base);
        },
      },
    }),
    [
      authoringSections,
      handleApplyDraft,
      handleDiscardDraft,
      refetchMonitors,
      revisionConflict,
      syncLiveDraftPreview,
    ],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleDraftFieldChange}
    />
  );
}
