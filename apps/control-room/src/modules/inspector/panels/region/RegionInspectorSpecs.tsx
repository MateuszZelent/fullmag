"use client";

import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Copy,
  Gauge,
  Grid3x3,
  Hammer,
  Layers,
  Magnet,
  Plus,
  RotateCcw,
  Shapes,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { FrozenSpinsSelectionExpression } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  useModelRegionDiagnosticsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useActiveLaneCapabilities } from "@/kernel/resources/useActiveLaneCapabilities";
import {
  visualizationTargetIdForSceneObject,
  type Selection,
} from "@/kernel/selection/selectionTypes";
import {
  mergeVisualizationStateTargetOverride,
  persistentVisualizationTargetPatch,
  resolveVisualizationSettings,
  visualizationTargetKey,
  type ObjectVisualizationSnapshot,
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
} from "@/kernel/visualization/ObjectVisualizationController";
import { normalizeMeshQualityStatistics } from "@/shared/domain/mesh/qualityStatistics";
import { resolveRegionMeshLifecycle } from "@/shared/domain/mesh/regionMeshLifecycle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/AlertDialog";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { DisabledReason } from "@/shared/ui/DisabledReason";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorFact,
  InspectorNotice,
  InspectorRowSpec,
  InspectorSpec,
  UnitOption,
} from "../../template";
import {
  resolveFdmObjectMeshInspectorModel,
  type FdmObjectMeshInspectorResources,
} from "../fdmMeshInspectorModel";
import type { MeshSizeDistributionHoverBin } from "../MeshQualityChart";
import { MeshQualityStatisticsView } from "../MeshQualityStatisticsView";
import { emitMeshSizeHistogramHover } from "../meshSizeHistogramHover";
import {
  ANISOTROPY_UNITS,
  buildObjectSelection,
  buildRegionSelection,
  buildRootSelection,
  DMI_UNITS,
  EXCHANGE_UNITS,
  formatLengthAuto,
  InspectorShortcutCards,
  LENGTH_UNITS,
  MAGNETIZATION_UNITS,
  normalizeVector3,
  type InspectorShortcutCardItem,
  type SceneObjectItem as SceneObject,
  SpecInspectorHost,
  vectorNorm,
} from "../model-roots/SpecInspectorHost";
import { findLastRegionSelection } from "../RegionsListPanelModel";
import { SelectionExpressionBuilder } from "../selection/SelectionExpressionBuilder";
import type {
  MaterialFunctionFieldSummary,
  SceneRegionConflictPolicy,
} from "./ObjectRegionMaterialFieldsModel";
import {
  buildStarterRegionPayload,
  cloneRegionForDuplicate,
  executeRegionMutationWithHistory,
  extractRegionDiagnosticsForTarget,
  extractSelectionTarget,
  finalizeRegionAuthoringCommit,
  formatDiagnosticNoticeText,
  formatRegionCapabilityLabel,
  formatRegionShapeKindLabel,
  hasRegionTextureOverride,
  materialFieldRealizationRows,
  parseRegionConstitutiveOverrides,
  parseRegionMaterialTransition,
  parseRegionScalarFieldParam,
  parseRegionShapeState,
  REGION_SCALAR_PARAM_KEYS,
  REGION_SHAPE_STARTERS,
  resolveCanonicalRegionMeshLane,
  resolveCouplingDependenciesForRegion,
  resolveOwnerBoundsForSceneObject,
  resolveRegionGeometryDefaults,
  serializeRegionConstitutiveOverrides,
  serializeRegionMaterialTransition,
  serializeRegionScalarFieldParam,
  serializeRegionShapeState,
  useDomainMetaResourceSafe,
  useFdmRegionMembershipBinaryResourceSafe,
  useFdmRegionMembershipResourceSafe,
  useMeshBuildCurrentSafe,
  useMeshRegionMembershipResourceSafe,
  useMeshRegionQualityResourceSafe,
  useModelCouplingsResourceSafe,
  useModelMaterialFieldsResourceSafe,
  useRegionSessionScopeKey,
  validateShapeAgainstOwnerBounds,
  type CanonicalRegionMeshLane,
  type RegionConstitutiveOverrideDraft,
  type RegionFieldProfileMode,
  type RegionScalarParamKey,
  type RegionShapeMode,
  type SceneMaterialParameterAssignment,
  type SceneMaterialParameterName,
  type SceneMaterialTransitionScope,
  type SceneObjectRegionPatch,
  type SceneRegionFrame,
  type SceneRegionRealizationPolicy,
} from "./regionInspectorHelpers";

export {
  extractSelectionTarget,
  resolveCanonicalRegionMeshLane,
  type CanonicalRegionMeshLane,
  type RegionFieldProfileMode,
};

const EMPTY_VISUALIZATION_SNAPSHOT: ObjectVisualizationSnapshot = {
  defaults: {},
  overrides: {},
  version: 0,
};

function formatVectorSpanAuto(vec: readonly [number, number, number]): string {
  return `${formatLengthAuto(vec[0])} \u00d7 ${formatLengthAuto(vec[1])} \u00d7 ${formatLengthAuto(vec[2])}`;
}

/* ── 1. RegionsCollectionInspectorPanel (`object.regions`) ── */

interface RegionPrecedenceItem {
  id: string;
  name: string;
  priority: number;
  shapeKind: string;
  enabled: boolean;
  overrideSummary: string;
  couplingCount: number;
  warningCount: number;
  errorCount: number;
  raw: Record<string, unknown>;
}

interface RegionsCollectionDraft {
  objectId: string;
  objectName: string;
  highlightAllVolumes: boolean;
  items: readonly RegionPrecedenceItem[];
}

export function RegionsCollectionInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const regionDiagnostics = useModelRegionDiagnosticsResource();
  const couplingsResource = useModelCouplingsResourceSafe();
  const activeLane = useActiveLaneCapabilities();
  const sessionScopeKey = useRegionSessionScopeKey(kernel);

  const [pendingDelete, setPendingDelete] = useState<RegionPrecedenceItem | null>(null);
  const [starterName, setStarterName] = useState("");
  const [starterPriorityText, setStarterPriorityText] = useState("0");

  const { objectId } = extractSelectionTarget(selection);
  const sceneObj = useMemo(
    () => scene.data?.objects?.find((o) => o.id === objectId),
    [objectId, scene.data?.objects],
  );
  const ownerBounds = useMemo(
    () => resolveOwnerBoundsForSceneObject(sceneObj),
    [sceneObj],
  );

  const activeLaneKind =
    (activeLane as { lane?: string } | null)?.lane ??
    (activeLane?.source?.kind === "planner" ? activeLane.resolved?.discretization : null);
  const meshLaneInfo = useMemo(
    () =>
      resolveCanonicalRegionMeshLane(
        activeLaneKind === "fem" || activeLaneKind === "fdm" ? activeLaneKind : null,
        scene.data,
      ),
    [activeLaneKind, scene.data],
  );

  const items = useMemo<readonly RegionPrecedenceItem[]>(() => {
    const matFields = sceneObj?.material_parameter_fields ?? [];
    return (sceneObj?.regions ?? []).map((reg) => {
      const rec = reg as unknown as Record<string, unknown>;
      const id = String(rec.region_id ?? "");
      const shapeKind = formatRegionShapeKindLabel(rec.shape);
      const priority =
        typeof rec.priority === "number" && Number.isFinite(rec.priority)
          ? Math.trunc(rec.priority)
          : 0;
      const overrideCount = Array.isArray(rec.material_overrides)
        ? rec.material_overrides.length
        : 0;
      const fieldCount = matFields.filter((f) => f.region_id === id).length;
      const totalMat = overrideCount + fieldCount;
      const hasMesh = Boolean(rec.mesh_policy) ||
        (typeof rec.realization_policy === "string" && rec.realization_policy !== "inherit");
      const hasTex = hasRegionTextureOverride(rec);
      const couplings = resolveCouplingDependenciesForRegion(
        objectId,
        id,
        scene.data?.couplings,
        couplingsResource.data,
      );
      const diags = extractRegionDiagnosticsForTarget(
        regionDiagnostics.data,
        objectId,
        id,
        meshLaneInfo.lane,
      );
      const errorCount = diags.filter((d) => d.severity === "error").length;
      const warningCount = diags.filter((d) => d.severity === "warning").length;

      const badges: string[] = [];
      if (totalMat > 0) badges.push(`${totalMat} mat`);
      if (hasMesh) badges.push("mesh");
      if (hasTex) badges.push("texture");
      if (couplings.length > 0) badges.push(`${couplings.length} coupling`);
      if (errorCount > 0) badges.push(`${errorCount} error`);
      else if (warningCount > 0) badges.push(`${warningCount} warning`);

      return {
        id,
        name: String(rec.name ?? id),
        priority,
        shapeKind,
        enabled: rec.enabled !== false,
        overrideSummary: badges.length > 0 ? badges.join(" \u00b7 ") : "Inherits object",
        couplingCount: couplings.length,
        warningCount,
        errorCount,
        raw: rec,
      };
    });
  }, [
    couplingsResource.data,
    meshLaneInfo.lane,
    objectId,
    regionDiagnostics.data,
    scene.data?.couplings,
    sceneObj?.material_parameter_fields,
    sceneObj?.regions,
  ]);

  const vizSnapshot = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) =>
        typeof kernel.visualization?.subscribe === "function"
          ? kernel.visualization.subscribe(onStoreChange)
          : () => undefined,
      [kernel.visualization],
    ),
    () => kernel.visualization?.getSnapshot?.() ?? EMPTY_VISUALIZATION_SNAPSHOT,
    () => EMPTY_VISUALIZATION_SNAPSHOT,
  );

  const regionTargets = useMemo<readonly VisualizationTargetRef[]>(
    () =>
      objectId
        ? items.map((item) => ({
            id: visualizationTargetIdForSceneObject(objectId, item.id),
            kind: "region",
            label: item.name,
          }))
        : [],
    [items, objectId],
  );

  const highlightAllVolumes = useMemo<boolean>(() => {
    if (regionTargets.length === 0 || !kernel.visualization) return false;
    return regionTargets.every((target) => {
      const settings = resolveVisualizationSettings(vizSnapshot, target);
      return (
        settings.visible &&
        (settings.boundsVisible ||
          settings.wireframeVisible ||
          settings.shaderVisible)
      );
    });
  }, [kernel.visualization, regionTargets, vizSnapshot]);

  const handleToggleHighlightAllVolumes = useCallback(
    (checked: boolean) => {
      if (regionTargets.length === 0) return;
      const patchValue: VisualizationTargetPatch = checked
        ? { visible: true, boundsVisible: true, wireframeVisible: true }
        : { visible: false, boundsVisible: false, wireframeVisible: false };

      for (const target of regionTargets) {
        kernel.visualization?.patchTarget?.(target, patchValue);
      }

      if (typeof kernel.visualizationSync?.queuePatch === "function") {
        let overrides = [] as ReturnType<typeof mergeVisualizationStateTargetOverride>;
        for (const target of regionTargets) {
          overrides = mergeVisualizationStateTargetOverride(
            overrides,
            target,
            patchValue,
          );
        }
        const receipt = kernel.visualizationSync.queuePatch(
          { overrides },
          regionTargets.map((target) => visualizationTargetKey(target)),
        );
        if (receipt?.transactionId) {
          const baseRev =
            typeof kernel.visualizationSync.getSnapshot === "function"
              ? Number(kernel.visualizationSync.getSnapshot().lastRemoteRevision ?? 0)
              : 0;
          const persistent = persistentVisualizationTargetPatch(patchValue);
          for (const target of regionTargets) {
            kernel.visualization?.patchTargetPending?.(
              target,
              persistent,
              Number.isFinite(baseRev) ? baseRev : 0,
              receipt.transactionId,
            );
          }
        }
      }
    },
    [kernel.visualization, kernel.visualizationSync, regionTargets],
  );

  const baseline = useMemo<RegionsCollectionDraft>(
    () => ({
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Object",
      highlightAllVolumes,
      items,
    }),
    [highlightAllVolumes, items, objectId, sceneObj?.name],
  );

  const handleCreateRegion = useCallback(
    async (
      starterKind: RegionShapeMode,
      selectNode: (next: Omit<Selection, "moduleSource">) => void,
    ) => {
      if (!objectId) return;
      const parsedPriority = Number.parseInt(starterPriorityText.trim(), 10);
      const priority = Number.isFinite(parsedPriority) ? parsedPriority : 0;
      const payload = buildStarterRegionPayload({
        customName: starterName,
        existingCount: items.length,
        objectId,
        ownerBounds,
        priority,
        starterKind,
      });

      const tx = await executeRegionMutationWithHistory({
        kernel,
        label: `Create region ${payload.name}`,
        sceneData: scene.data,
        sessionScopeKey,
        sourceDetail: "object-regions-create",
        mutation: async (_prep, writeOpts) =>
          kernel.api.model.createObjectRegion(objectId, payload, writeOpts),
      });

      await finalizeRegionAuthoringCommit({
        committedScene: tx.committed_scene,
        fallbackRev: scene.data?.revision,
        kernel,
        sceneRevision: tx.scene_revision,
        sessionScopeKey,
      });
      setStarterName("");
      selectNode(
        buildRegionSelection(objectId, payload.region_id ?? "", "object.region", payload.name),
      );
    },
    [
      items.length,
      kernel,
      objectId,
      ownerBounds,
      scene.data,
      sessionScopeKey,
      starterName,
      starterPriorityText,
    ],
  );

  const handleReorder = useCallback(
    async (fromIdx: number, toIdx: number) => {
      if (!objectId || toIdx < 0 || toIdx >= items.length) return;
      const nextIds = items.map((it) => it.id);
      const [moved] = nextIds.splice(fromIdx, 1);
      if (!moved) return;
      nextIds.splice(toIdx, 0, moved);

      const tx = await executeRegionMutationWithHistory({
        kernel,
        label: `Reorder regions on ${objectId}`,
        sceneData: scene.data,
        sessionScopeKey,
        sourceDetail: "object-regions-reorder",
        mutation: async (prep, writeOpts) =>
          kernel.api.model.commitTransaction(
            {
              base_revision: prep.baseRevision ?? scene.data?.revision ?? null,
              kind: "reorder_object_regions",
              object_id: objectId,
              region_ids: nextIds,
            },
            writeOpts?.sessionScopeKey
              ? { sessionScopeKey: writeOpts.sessionScopeKey }
              : undefined,
          ),
      });

      await finalizeRegionAuthoringCommit({
        committedScene: tx.committed_scene,
        fallbackRev: scene.data?.revision,
        kernel,
        sceneRevision: tx.scene_revision,
        sessionScopeKey,
      });
    },
    [items, kernel, objectId, scene.data, sessionScopeKey],
  );

  const handleToggleRegion = useCallback(
    async (regionId: string, enabled: boolean) => {
      if (!objectId) return;
      const tx = await executeRegionMutationWithHistory({
        kernel,
        label: `${enabled ? "Enable" : "Disable"} region ${regionId}`,
        sceneData: scene.data,
        sessionScopeKey,
        sourceDetail: "object-regions-toggle",
        mutation: async (_prep, writeOpts) =>
          kernel.api.model.patchObjectRegion(
            objectId,
            regionId,
            { enabled },
            writeOpts,
          ),
      });

      await finalizeRegionAuthoringCommit({
        committedScene: tx.committed_scene,
        fallbackRev: scene.data?.revision,
        kernel,
        sceneRevision: tx.scene_revision,
        sessionScopeKey,
      });
    },
    [kernel, objectId, scene.data, sessionScopeKey],
  );

  const handleDuplicateRegion = useCallback(
    async (item: RegionPrecedenceItem) => {
      if (!objectId) return;
      const copyId = `${item.id}-copy-${Date.now().toString(36).slice(-4)}`;
      const sourceRegion = sceneObj?.regions?.find((r) => r.region_id === item.id);
      const duplicated = cloneRegionForDuplicate(
        sourceRegion,
        copyId,
        `${item.name} Copy`,
        item.enabled,
      );

      const tx = await executeRegionMutationWithHistory({
        kernel,
        label: `Duplicate region ${item.name}`,
        sceneData: scene.data,
        sessionScopeKey,
        sourceDetail: "object-regions-duplicate",
        mutation: async (_prep, writeOpts) =>
          kernel.api.model.createObjectRegion(objectId, duplicated, writeOpts),
      });

      await finalizeRegionAuthoringCommit({
        committedScene: tx.committed_scene,
        fallbackRev: scene.data?.revision,
        kernel,
        sceneRevision: tx.scene_revision,
        sessionScopeKey,
      });
    },
    [kernel, objectId, scene.data, sceneObj?.regions, sessionScopeKey],
  );

  const dependentCouplingsForPending = useMemo(
    () =>
      pendingDelete
        ? resolveCouplingDependenciesForRegion(
            objectId,
            pendingDelete.id,
            scene.data?.couplings,
            couplingsResource.data,
          )
        : [],
    [couplingsResource.data, objectId, pendingDelete, scene.data?.couplings],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete || !objectId) return;
    if (dependentCouplingsForPending.length > 0) return;
    const targetId = pendingDelete.id;
    const targetName = pendingDelete.name;
    setPendingDelete(null);

    const tx = await executeRegionMutationWithHistory({
      kernel,
      label: `Delete region ${targetName}`,
      sceneData: scene.data,
      sessionScopeKey,
      sourceDetail: "object-regions-delete",
      mutation: async (_prep, writeOpts) =>
        kernel.api.model.deleteObjectRegion(objectId, targetId, writeOpts),
    });

    await finalizeRegionAuthoringCommit({
      committedScene: tx.committed_scene,
      fallbackRev: scene.data?.revision,
      kernel,
      sceneRevision: tx.scene_revision,
      sessionScopeKey,
    });
  }, [
    dependentCouplingsForPending.length,
    kernel,
    objectId,
    pendingDelete,
    scene.data,
    sessionScopeKey,
  ]);

  const spec = useMemo<InspectorSpec<RegionsCollectionDraft>>(
    () => ({
      id: "object.regions",
      header: {
        breadcrumbs: [
          {
            id: "objects",
            label: "Objects",
            selection: buildRootSelection("objects.root", "model:objects", "Objects"),
          },
          {
            id: "object",
            label: baseline.objectName,
            selection: buildObjectSelection(objectId, "object.root", baseline.objectName),
          },
          { id: "regions", label: "Regions" },
        ],
        canFitView: Boolean(sceneObj),
        searchable: false,
      },
      identity: {
        domain: "geometry",
        icon: Layers,
        title: () => "Regions",
        kindLabel: "Ordered sub-volume precedence stack",
        entityId: objectId ? `model:object:${objectId}:regions` : undefined,
        statePill: (d) =>
          d.items.length === 0
            ? { tone: "neutral", label: "0 regions" }
            : { tone: "ok", label: `${d.items.length} regions` },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "count", label: "Authored", value: String(d.items.length) },
        {
          id: "active",
          label: "Active",
          value: String(d.items.filter((i) => i.enabled).length),
        },
        { id: "rule", label: "Overlap rule", value: "Higher precedence wins" },
      ],
      sections: [
        {
          id: "regions-create",
          title: "Add sub-volume region",
          icon: Plus,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-col gap-2" data-slot="region-create-controls">
                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="flex flex-col gap-1 text-xs text-[var(--fm-text-muted)]">
                      <span>Initial name</span>
                      <Input
                        aria-label="New region name"
                        placeholder={`Region ${items.length + 1}`}
                        value={starterName}
                        onChange={(e) => setStarterName(e.target.value)}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-[var(--fm-text-muted)]">
                      <span>Initial priority</span>
                      <Input
                        aria-label="New region priority"
                        step={1}
                        type="number"
                        value={starterPriorityText}
                        onChange={(e) => setStarterPriorityText(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5" data-slot="region-starter-tiles">
                    {REGION_SHAPE_STARTERS.map((starter) => (
                      <Button
                        key={starter.kind}
                        size="sm"
                        type="button"
                        variant="secondary"
                        onClick={() => void handleCreateRegion(starter.kind, ctx.selectNode)}
                      >
                        <Plus aria-hidden="true" size={12} />
                        <span>{starter.label}</span>
                      </Button>
                    ))}
                  </div>
                </div>
              ),
            },
            {
              key: "highlightAllVolumes",
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div
                  className="flex items-center justify-between gap-2 py-1"
                  data-slot="region-highlight-all-volumes"
                >
                  <span className="text-xs text-[var(--fm-text)]">
                    Highlight all region volumes in 3D
                  </span>
                  <Switch
                    aria-label="Highlight all region volumes in 3D"
                    checked={ctx.draft.highlightAllVolumes}
                    disabled={ctx.draft.items.length === 0}
                    onCheckedChange={(checked) => handleToggleHighlightAllVolumes(checked)}
                  />
                </div>
              ),
            },
          ],
        },
        {
          id: "regions-precedence-stack",
          title: "Precedence stack (later overrides earlier)",
          icon: Layers,
          defaultOpen: true,
          summary: (d) => `${d.items.length} ordered regions`,
          emptyState: (d) =>
            d.items.length === 0
              ? {
                  icon: Layers,
                  title: "No sub-volume regions authored",
                  description:
                    "Subdivide this object into spatial regions to override material constants, mesh sizing, or magnetic textures locally.",
                }
              : null,
          rows: [
            {
              type: "custom",
              wide: true,
              showWhen: (d) => d.items.length > 0,
              render: (ctx) => (
                <div className="flex flex-col gap-2" data-slot="region-precedence-list">
                  {ctx.draft.items.map((item, idx) => (
                    <div
                      key={item.id}
                      className="fm-region-precedence-card flex flex-col gap-1.5 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2.5"
                      data-region-id={item.id}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge data-tone="info">#{idx + 1}</Badge>
                            <span className="break-words text-xs font-semibold text-[var(--fm-text)]">
                              {item.name}
                            </span>
                            <Badge data-tone="neutral">{item.shapeKind}</Badge>
                            <Badge data-tone="neutral">P{item.priority}</Badge>
                          </div>
                          <p className="mt-0.5 text-xs text-[var(--fm-text-muted)]">
                            {item.overrideSummary}
                          </p>
                        </div>
                        <Switch
                          aria-label={`Enable region ${item.name}`}
                          checked={item.enabled}
                          onCheckedChange={(checked) => void handleToggleRegion(item.id, checked)}
                        />
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-1 pt-1">
                        <div className="flex items-center gap-1">
                          <Button
                            aria-label={`Move ${item.name} up`}
                            disabled={idx === 0}
                            size="icon"
                            type="button"
                            variant="ghost"
                            onClick={() => void handleReorder(idx, idx - 1)}
                          >
                            <ArrowUp aria-hidden="true" size={12} />
                          </Button>
                          <Button
                            aria-label={`Move ${item.name} down`}
                            disabled={idx === ctx.draft.items.length - 1}
                            size="icon"
                            type="button"
                            variant="ghost"
                            onClick={() => void handleReorder(idx, idx + 1)}
                          >
                            <ArrowDown aria-hidden="true" size={12} />
                          </Button>
                          <Button
                            aria-label={`Duplicate ${item.name}`}
                            size="icon"
                            type="button"
                            variant="ghost"
                            onClick={() => void handleDuplicateRegion(item)}
                          >
                            <Copy aria-hidden="true" size={12} />
                          </Button>
                          <Button
                            aria-label={`Delete ${item.name}`}
                            size="icon"
                            type="button"
                            variant="ghost"
                            onClick={() => setPendingDelete(item)}
                          >
                            <Trash2 aria-hidden="true" size={12} />
                          </Button>
                        </div>

                        <Button
                          aria-label={`Open ${item.name}`}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() =>
                            ctx.selectNode(
                              buildRegionSelection(objectId, item.id, "object.region", item.name),
                            )
                          }
                        >
                          <span>Inspect</span>
                          <ArrowRight aria-hidden="true" size={12} />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "immediate",
        statusMessage: () => "Region order and enablement commit immediately to SceneDocument",
      },
    }),
    [
      baseline.objectName,
      handleCreateRegion,
      handleDuplicateRegion,
      handleReorder,
      handleToggleHighlightAllVolumes,
      handleToggleRegion,
      items.length,
      objectId,
      sceneObj,
      starterName,
      starterPriorityText,
    ],
  );

  const couplingGuardMessage = useMemo(() => {
    if (dependentCouplingsForPending.length === 0) return null;
    const refs = dependentCouplingsForPending
      .map((dep) => `${dep.couplingId} (${dep.endpointRole})`)
      .join(", ");
    return `Delete Coupling first: ${dependentCouplingsForPending.length} active coupling(s) [${refs}] reference this region.`;
  }, [dependentCouplingsForPending]);

  return (
    <SpecInspectorHost baseline={baseline} selection={selection} spec={spec}>
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dependentCouplingsForPending.length > 0
                ? `Cannot delete region "${pendingDelete?.name ?? ""}"`
                : `Delete region "${pendingDelete?.name ?? ""}"?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {couplingGuardMessage ??
                "This removes the region volume and any local material, mesh, or texture overrides."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {couplingGuardMessage ? (
              <DisabledReason reason="Delete Coupling first">
                <AlertDialogAction disabled>Delete region</AlertDialogAction>
              </DisabledReason>
            ) : (
              <AlertDialogAction onClick={() => void handleConfirmDelete()}>
                Delete region
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SpecInspectorHost>
  );
}

/* ── 2. ObjectRegionOverviewInspectorPanel (`object.region` + redirected `.geometry`, `.diagnostics`, `.regions`, `.shape`) ── */

interface RegionOverviewDraft {
  objectId: string;
  objectName: string;
  regionId: string;
  exists: boolean;
  name: string;
  enabled: boolean;
  priority: number;
  frame: SceneRegionFrame;
  precedenceRank: number;
  totalRegions: number;
  shapeMode: RegionShapeMode;
  axis: readonly [number, number, number];
  center: readonly [number, number, number];
  size: readonly [number, number, number];
  radius: number;
  height: number;
  zMin: number;
  zMax: number;
  halfSpaceOrigin: readonly [number, number, number];
  halfSpaceNormal: readonly [number, number, number];
  selectorExpr: FrozenSpinsSelectionExpression;
  preservedCsgExpression: Record<string, unknown> | null;
  materialOverrideCount: number;
  hasMeshOverride: boolean;
  hasTextureOverride: boolean;
  diagnosticSummary: string;
}

export function ObjectRegionOverviewInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const regionDiagnostics = useModelRegionDiagnosticsResource();
  const couplingsResource = useModelCouplingsResourceSafe();
  const activeLane = useActiveLaneCapabilities();
  const sessionScopeKey = useRegionSessionScopeKey(kernel);
  const [buildPending, setBuildPending] = useState(false);

  const { objectId, regionId } = extractSelectionTarget(selection);
  const sceneObj = useMemo(
    () => scene.data?.objects?.find((o) => o.id === objectId),
    [objectId, scene.data?.objects],
  );
  const ownerBounds = useMemo(
    () => resolveOwnerBoundsForSceneObject(sceneObj),
    [sceneObj],
  );
  const regions = useMemo(() => sceneObj?.regions ?? [], [sceneObj?.regions]);
  const regionIdx = useMemo(
    () => regions.findIndex((r) => r.region_id === regionId),
    [regionId, regions],
  );
  const regionObj = regions[regionIdx];
  const regionRec = (regionObj ?? null) as Record<string, unknown> | null;

  const activeLaneKind =
    (activeLane as { lane?: string } | null)?.lane ??
    (activeLane?.source?.kind === "planner" ? activeLane.resolved?.discretization : null);
  const meshLaneInfo = useMemo(
    () =>
      resolveCanonicalRegionMeshLane(
        activeLaneKind === "fem" || activeLaneKind === "fdm" ? activeLaneKind : null,
        scene.data,
      ),
    [activeLaneKind, scene.data],
  );

  const laneDiagnostics = useMemo(
    () =>
      extractRegionDiagnosticsForTarget(
        regionDiagnostics.data,
        objectId,
        regionId,
        meshLaneInfo.lane,
      ),
    [meshLaneInfo.lane, objectId, regionDiagnostics.data, regionId],
  );

  const couplingDependencies = useMemo(
    () =>
      resolveCouplingDependenciesForRegion(
        objectId,
        regionId,
        scene.data?.couplings,
        couplingsResource.data,
      ),
    [couplingsResource.data, objectId, regionId, scene.data?.couplings],
  );

  const baseline = useMemo<RegionOverviewDraft>(() => {
    const parsedShape = parseRegionShapeState(regionRec?.shape, objectId, ownerBounds);
    const priority =
      typeof regionRec?.priority === "number" && Number.isFinite(regionRec.priority)
        ? Math.trunc(regionRec.priority)
        : 0;
    const frame: SceneRegionFrame = regionRec?.frame === "world" ? "world" : "object";

    const constitutiveCount = Array.isArray(regionRec?.material_overrides)
      ? regionRec.material_overrides.length
      : 0;
    const fieldCount = (sceneObj?.material_parameter_fields ?? []).filter(
      (f) => f.region_id === regionId,
    ).length;

    const diagRealization =
      laneDiagnostics.find((d) => Boolean(d.realizationStatus))?.realizationStatus ??
      (typeof regionRec?.realization_status === "string"
        ? regionRec.realization_status
        : null);
    const diagnosticSummary = diagRealization
      ? diagRealization.replace(/_/g, " ")
      : meshLaneInfo.diagnosticLabel;

    const hasMeshOverride =
      Boolean(regionRec?.mesh_policy) ||
      (typeof regionRec?.realization_policy === "string" &&
        regionRec.realization_policy !== "inherit");

    return {
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Object",
      regionId,
      exists: Boolean(regionRec),
      name: String(regionRec?.name ?? selection.label ?? (regionId || "Region")),
      enabled: regionRec?.enabled !== false,
      priority,
      frame,
      precedenceRank: regionIdx >= 0 ? regionIdx + 1 : 1,
      totalRegions: regions.length,
      ...parsedShape,
      materialOverrideCount: constitutiveCount + fieldCount,
      hasMeshOverride,
      hasTextureOverride: hasRegionTextureOverride(regionRec),
      diagnosticSummary,
    };
  }, [
    laneDiagnostics,
    meshLaneInfo.diagnosticLabel,
    objectId,
    ownerBounds,
    regionId,
    regionIdx,
    regionRec,
    regions.length,
    sceneObj?.material_parameter_fields,
    sceneObj?.name,
    selection.label,
  ]);

  const applyOverviewDraft = useCallback(
    async (draft: RegionOverviewDraft): Promise<boolean> => {
      const shape = serializeRegionShapeState(draft, ownerBounds, baseline.shapeMode);
      const patch: SceneObjectRegionPatch = {
        name: draft.name.trim(),
        enabled: draft.enabled,
        priority: Math.trunc(draft.priority),
        frame: draft.frame,
        shape,
      };
      const tx = await executeRegionMutationWithHistory({
        kernel,
        label: `Update region ${draft.name.trim() || regionId}`,
        sceneData: scene.data,
        sessionScopeKey,
        sourceDetail: "object-region-overview-apply",
        mutation: async (_prep, writeOpts) =>
          kernel.api.model.patchObjectRegion(objectId, regionId, patch, writeOpts),
      });
      await finalizeRegionAuthoringCommit({
        committedScene: tx.committed_scene,
        fallbackRev: scene.data?.revision,
        kernel,
        sceneRevision: tx.scene_revision,
        sessionScopeKey,
      });
      return true;
    },
    [baseline.shapeMode, kernel, objectId, ownerBounds, regionId, scene.data, sessionScopeKey],
  );

  const handleDuplicateCurrentRegion = useCallback(
    async (selectNode: (next: Omit<Selection, "moduleSource">) => void) => {
      if (!objectId || !regionId) return;
      const copyId = `${regionId}-copy-${Date.now().toString(36).slice(-4)}`;
      const copyName = `${baseline.name} Copy`;
      const duplicated = cloneRegionForDuplicate(
        regionObj,
        copyId,
        copyName,
        baseline.enabled,
      );

      const tx = await executeRegionMutationWithHistory({
        kernel,
        label: `Duplicate region ${baseline.name}`,
        sceneData: scene.data,
        sessionScopeKey,
        sourceDetail: "object-region-duplicate",
        mutation: async (_prep, writeOpts) =>
          kernel.api.model.createObjectRegion(objectId, duplicated, writeOpts),
      });

      await finalizeRegionAuthoringCommit({
        committedScene: tx.committed_scene,
        fallbackRev: scene.data?.revision,
        kernel,
        sceneRevision: tx.scene_revision,
        sessionScopeKey,
      });
      selectNode(buildRegionSelection(objectId, copyId, "object.region", copyName));
    },
    [baseline.enabled, baseline.name, kernel, objectId, regionId, regionObj, scene.data, sessionScopeKey],
  );

  const handleBuildMesh = useCallback(
    async (draft: RegionOverviewDraft) => {
      if (!objectId || !regionId || buildPending) return;
      setBuildPending(true);
      try {
        if (JSON.stringify(draft) !== JSON.stringify(baseline)) {
          await applyOverviewDraft(draft);
        }
        await kernel.commands.execute(
          "mesh.build-shared-domain",
          createCommandContext("inspector", kernel, {
            input: { object_id: objectId, region_id: regionId },
            sessionScopeKey: sessionScopeKey ?? undefined,
            sourceDetail: "object-region-mesh-build",
          }),
        );
      } finally {
        setBuildPending(false);
      }
    },
    [applyOverviewDraft, baseline, buildPending, kernel, objectId, regionId, sessionScopeKey],
  );

  const overrideCards = useMemo<readonly InspectorShortcutCardItem[]>(() => {
    if (!objectId || !regionId) return [];
    return [
      {
        id: "reg-material",
        title: "Material Overrides",
        subtitle: "Local Ms, Aex, \u03b1, Ku1, Ku2, Kc1 & DMI spatial profiles",
        badge:
          baseline.materialOverrideCount > 0
            ? `${baseline.materialOverrideCount} overridden`
            : "Inherited",
        tone: baseline.materialOverrideCount > 0 ? "ok" : "neutral",
        selection: buildRegionSelection(
          objectId,
          regionId,
          "object.region.magnetic-parameters",
          "Material",
        ),
      },
      {
        id: "reg-mesh",
        title: "Mesh Policy",
        subtitle: "Conformal / projected boundary & local sizing policy",
        badge: baseline.hasMeshOverride ? "Override" : "Inherited",
        tone: baseline.hasMeshOverride ? "ok" : "neutral",
        selection: buildRegionSelection(objectId, regionId, "object.region.mesh", "Mesh"),
      },
      {
        id: "reg-texture",
        title: "Magnetic Texture",
        subtitle: "Regional m\u2080 preset or field-file override",
        badge: baseline.hasTextureOverride ? "Override" : "Inherited",
        tone: baseline.hasTextureOverride ? "ok" : "neutral",
        selection: buildRegionSelection(objectId, regionId, "object.region.texture", "Texture"),
      },
      {
        id: "reg-viz",
        title: "Visualization",
        subtitle: "Regional color tint, opacity & vector glyph display",
        selection: buildRegionSelection(
          objectId,
          regionId,
          "object.region.visualization",
          "Visualization",
        ),
      },
    ];
  }, [
    baseline.hasMeshOverride,
    baseline.hasTextureOverride,
    baseline.materialOverrideCount,
    objectId,
    regionId,
  ]);

  const couplingSummaryText = useMemo(() => {
    if (couplingDependencies.length === 0) return "None";
    return couplingDependencies
      .map((dep) => `${dep.couplingId} (${dep.endpointRole}, ${dep.status})`)
      .join(", ");
  }, [couplingDependencies]);

  const spec = useMemo<InspectorSpec<RegionOverviewDraft>>(
    () => ({
      id: "object.region",
      header: {
        breadcrumbs: [
          {
            id: "object",
            label: baseline.objectName,
            selection: buildObjectSelection(objectId, "object.root", baseline.objectName),
          },
          {
            id: "regions",
            label: "Regions",
            selection: buildObjectSelection(objectId, "object.regions", "Regions"),
          },
          { id: "region", label: baseline.name },
        ],
        canFitView: baseline.exists,
        searchable: true,
        ...(baseline.exists && meshLaneInfo.lane === "fem"
          ? {
              primaryHeaderAction: {
                label: buildPending ? "Building Mesh\u2026" : "Build Mesh",
                icon: Hammer,
                disabledReason: buildPending ? "Mesh build is in progress." : undefined,
                onRun: async (ctx) => {
                  await handleBuildMesh(ctx.draft);
                },
              },
            }
          : {}),
        extraMenuActions: baseline.exists
          ? [
              {
                id: "duplicate-region",
                label: "Duplicate Region",
                icon: Copy,
                onSelect: async (ctx) => {
                  await handleDuplicateCurrentRegion(ctx.selectNode);
                },
              },
              ...(meshLaneInfo.lane === "fem"
                ? [
                    {
                      id: "build-region-mesh",
                      label: buildPending ? "Building Mesh\u2026" : "Build Mesh",
                      icon: Hammer,
                      disabledReason: buildPending ? "Mesh build is in progress." : undefined,
                      onSelect: async (ctx: { draft: RegionOverviewDraft }) => {
                        await handleBuildMesh(ctx.draft);
                      },
                    },
                  ]
                : []),
            ]
          : [],
        ...(baseline.exists
          ? {
              deleteAction: {
                label: "Delete Region",
                confirmTitle: (d) =>
                  couplingDependencies.length > 0
                    ? `Cannot delete region "${d.name}"`
                    : `Delete region "${d.name}"?`,
                confirmDescription:
                  couplingDependencies.length > 0
                    ? `Delete Coupling first: active coupling(s) [${couplingSummaryText}] reference this region.`
                    : "Deleting this region removes its spatial selector and all local material, mesh, and texture overrides.",
                onDelete: async (ctx) => {
                  if (couplingDependencies.length > 0) {
                    ctx.notify(
                      "Delete Coupling first",
                      `Active coupling(s) [${couplingSummaryText}] reference this region.`,
                    );
                    return;
                  }
                  const tx = await executeRegionMutationWithHistory({
                    kernel,
                    label: `Delete region ${ctx.draft.name}`,
                    sceneData: scene.data,
                    sessionScopeKey,
                    sourceDetail: "object-region-delete",
                    mutation: async (_prep, writeOpts) =>
                      kernel.api.model.deleteObjectRegion(objectId, regionId, writeOpts),
                  });
                  await finalizeRegionAuthoringCommit({
                    committedScene: tx.committed_scene,
                    fallbackRev: scene.data?.revision,
                    kernel,
                    sceneRevision: tx.scene_revision,
                    sessionScopeKey,
                  });
                  const nextRegion = tx.committed_scene
                    ? findLastRegionSelection(tx.committed_scene, objectId, regionId)
                    : null;
                  ctx.selectNode(
                    nextRegion
                      ? buildRegionSelection(
                          objectId,
                          nextRegion.regionId,
                          "object.region",
                          nextRegion.name,
                        )
                      : buildObjectSelection(objectId, "object.regions", "Regions"),
                  );
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "geometry",
        icon: Shapes,
        title: (d) => d.name,
        renameFieldKey: baseline.exists ? "name" : undefined,
        kindLabel: "Spatial object subregion",
        entityId: regionId || undefined,
        statePill: (d) =>
          !d.exists
            ? { tone: "warn", label: "Not found" }
            : d.enabled
              ? { tone: "ok", label: `Rank #${d.precedenceRank}` }
              : { tone: "degraded", label: "Disabled" },
      },
      facts: (d): readonly InspectorFact[] => [
        {
          id: "precedence",
          label: "Precedence",
          value: d.totalRegions > 0 ? `#${d.precedenceRank} of ${d.totalRegions}` : null,
        },
        { id: "priority", label: "Priority", value: String(d.priority) },
        { id: "shape", label: "Selector", value: d.shapeMode.replace(/_/g, " ") },
        { id: "support", label: "Support", value: meshLaneInfo.factValue, tone: "info" },
      ],
      modeTabs: [
        { id: "shape", label: "Shape & Precedence", icon: Shapes },
        {
          id: "diagnostics",
          label: "Diagnostics",
          icon: Gauge,
          badgeCount: laneDiagnostics.length > 0 ? laneDiagnostics.length : undefined,
        },
      ],
      notices: (d): readonly InspectorNotice<RegionOverviewDraft>[] => {
        const list: InspectorNotice<RegionOverviewDraft>[] = [];
        if (meshLaneInfo.lane === "pending") {
          list.push({
            id: "region-pending-discretization",
            tone: "info",
            title: "Pending study discretization",
            text: "Spatial selector and precedence are authored in ProblemIR and realized once FEM or FDM discretization is selected.",
          });
        }
        const boundsWarn = validateShapeAgainstOwnerBounds(d, ownerBounds);
        if (boundsWarn) {
          list.push({
            id: "region-owner-bounds-clamp",
            tone: "warn",
            title: "Shape exceeds object bounds",
            text: boundsWarn,
          });
        }
        if (couplingDependencies.length > 0) {
          list.push({
            id: "region-coupling-dependencies",
            tone: "info",
            title: "Referenced by physics coupling",
            text: `Active coupling(s) [${couplingSummaryText}] bind to this region. Delete Coupling first before removing the region.`,
          });
        }
        for (const diag of laneDiagnostics) {
          list.push({
            id: `region-diag-${diag.diagnosticId}`,
            tone:
              diag.severity === "error"
                ? "err"
                : diag.severity === "warning"
                  ? "warn"
                  : "info",
            title: diag.code,
            text: formatDiagnosticNoticeText(diag),
          });
        }
        return list;
      },
      sections: [
        {
          id: "region-shape-authoring",
          modeTabId: "shape",
          title: "Spatial volume & selector",
          icon: Shapes,
          defaultOpen: true,
          showWhen: (d) => d.exists,
          rows: [
            {
              key: "name",
              type: "text",
              label: "Region name",
              validate: (v) => (v.trim().length === 0 ? "Region name is required." : null),
            },
            {
              key: "enabled",
              type: "switch",
              label: "Region active in precedence stack",
            },
            {
              key: "priority",
              type: "number",
              label: "Precedence priority",
              integer: true,
              step: 1,
              validate: (v) =>
                !Number.isFinite(v) || !Number.isInteger(v)
                  ? "Priority must be an integer."
                  : null,
            },
            {
              key: "frame",
              type: "segmented",
              label: "Coordinate frame",
              structural: true,
              options: [
                { value: "object", label: "Object local" },
                { value: "world", label: "World" },
              ],
            },
            ...(ownerBounds
              ? [
                  {
                    type: "readonly" as const,
                    label: "Owner object bounds",
                    showWhen: (d: RegionOverviewDraft) => d.frame === "object",
                    format: () => formatVectorSpanAuto(ownerBounds.size),
                  },
                ]
              : []),
            {
              key: "shapeMode",
              type: "select",
              label: "Volume geometry mode",
              structural: true,
              options: [
                { value: "box", label: "Box sub-volume" },
                { value: "cylinder", label: "Finite cylinder" },
                { value: "sphere", label: "Sphere sub-volume" },
                { value: "through_disk", label: "Through-thickness circular disk" },
                { value: "layer_z_slice", label: "Planar Z-slice layer [z_min, z_max]" },
                { value: "half_space", label: "Oriented half-space" },
                { value: "boolean_expr", label: "Boolean selection expression" },
              ],
            },
            {
              key: "center",
              type: "vector3",
              label: "Center (x, y, z)",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) =>
                d.shapeMode === "box" ||
                d.shapeMode === "cylinder" ||
                d.shapeMode === "sphere" ||
                d.shapeMode === "through_disk",
            },
            {
              key: "size",
              type: "vector3",
              label: "Box extents (Lx, Ly, Lz)",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) => d.shapeMode === "box",
              validate: (vec) =>
                vec.some((c) => c <= 0) ? "All box extents must be positive." : null,
            },
            {
              key: "radius",
              type: "quantity",
              label: "Radius",
              symbol: <>R</>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                d.shapeMode === "cylinder" ||
                d.shapeMode === "sphere" ||
                d.shapeMode === "through_disk",
            },
            {
              key: "height",
              type: "quantity",
              label: "Cylinder height",
              symbol: <>h</>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.shapeMode === "cylinder",
            },
            {
              key: "axis",
              type: "vector3",
              label: "Cylinder axis",
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) => d.shapeMode === "cylinder",
              validate: (vec) =>
                vectorNorm(vec) < 1e-12 ? "Cylinder axis must be non-zero." : null,
            },
            {
              key: "zMin",
              type: "quantity",
              label: "Lower Z bound",
              symbol: (
                <>
                  z<sub>min</sub>
                </>
              ),
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) => d.shapeMode === "layer_z_slice",
              validate: (v, d) =>
                v >= d.zMax ? "z_min must be strictly less than z_max." : null,
            },
            {
              key: "zMax",
              type: "quantity",
              label: "Upper Z bound",
              symbol: (
                <>
                  z<sub>max</sub>
                </>
              ),
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) => d.shapeMode === "layer_z_slice",
              validate: (v, d) =>
                v <= d.zMin ? "z_max must be strictly greater than z_min." : null,
            },
            {
              key: "halfSpaceOrigin",
              type: "vector3",
              label: "Plane point",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) => d.shapeMode === "half_space",
            },
            {
              key: "halfSpaceNormal",
              type: "vector3",
              label: "Inward normal",
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) => d.shapeMode === "half_space",
              validate: (vec) =>
                vectorNorm(vec) < 1e-12 ? "Half-space normal must be non-zero." : null,
            },
            {
              type: "custom",
              wide: true,
              showWhen: (d) => d.shapeMode === "boolean_expr",
              render: (ctx) => (
                <SelectionExpressionBuilder
                  expression={ctx.draft.selectorExpr}
                  objectId={objectId}
                  regionId={regionId}
                  onChange={(next) => ctx.setField("selectorExpr", next)}
                />
              ),
            },
          ],
        },
        {
          id: "region-override-shortcuts",
          modeTabId: "shape",
          title: "Regional overrides",
          icon: Layers,
          defaultOpen: true,
          showWhen: (d) => d.exists,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <InspectorShortcutCards items={overrideCards} onSelect={ctx.selectNode} />
              ),
            },
          ],
        },
        {
          id: "region-diagnostics-section",
          modeTabId: "diagnostics",
          title: "Realization & discretization diagnostics",
          icon: Gauge,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Discretization support",
              format: () => meshLaneInfo.diagnosticLabel,
            },
            {
              type: "readonly",
              label: "Realization status",
              format: (d) => d.diagnosticSummary,
            },
            {
              type: "readonly",
              label: "Precedence order",
              format: (d) =>
                `Rank #${d.precedenceRank} of ${d.totalRegions} (priority ${d.priority})`,
            },
            {
              type: "readonly",
              label: "Coordinate frame",
              format: (d) => (d.frame === "world" ? "World" : "Object local"),
            },
            {
              type: "readonly",
              label: "Active couplings",
              format: () => couplingSummaryText,
            },
            {
              type: "readonly",
              label: "Region diagnostics",
              format: () =>
                laneDiagnostics.length === 0
                  ? "0 diagnostics"
                  : `${laneDiagnostics.length} active`,
            },
            ...(laneDiagnostics.length > 0
              ? [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <div
                        className="flex flex-col gap-1.5"
                        data-slot="region-diagnostics-items"
                      >
                        {laneDiagnostics.map((diag) => (
                          <div
                            key={diag.diagnosticId}
                            className="rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2 text-xs"
                            data-diagnostic-code={diag.code}
                            data-diagnostic-severity={diag.severity}
                          >
                            <div className="flex flex-wrap items-center gap-1.5 font-medium text-[var(--fm-text)]">
                              <Badge
                                data-tone={
                                  diag.severity === "error"
                                    ? "err"
                                    : diag.severity === "warning"
                                      ? "warn"
                                      : "info"
                                }
                              >
                                {diag.severity}
                              </Badge>
                              <span>{diag.code}</span>
                              {diag.realizationStatus ? (
                                <Badge data-tone="neutral">{diag.realizationStatus}</Badge>
                              ) : null}
                            </div>
                            <p className="mt-1 text-xs text-[var(--fm-text-muted)]">
                              {diag.message}
                            </p>
                            {diag.capabilityGate ? (
                              <p className="mt-0.5 text-xs text-[var(--fm-warning)]">
                                Capability gate: {formatRegionCapabilityLabel(diag.capabilityGate)}{" "}
                                ({diag.capabilityGate})
                              </p>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ),
                  },
                ]
              : []),
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Region shape and precedence state match SceneDocument",
        lockReason: (d) => (!d.exists ? "Select an existing authored region." : null),
        onApply: applyOverviewDraft,
      },
    }),
    [
      applyOverviewDraft,
      baseline.exists,
      baseline.name,
      baseline.objectName,
      buildPending,
      couplingDependencies.length,
      couplingSummaryText,
      handleBuildMesh,
      handleDuplicateCurrentRegion,
      kernel,
      laneDiagnostics,
      meshLaneInfo.diagnosticLabel,
      meshLaneInfo.factValue,
      meshLaneInfo.lane,
      objectId,
      overrideCards,
      ownerBounds,
      regionId,
      scene.data,
      sessionScopeKey,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 3. ObjectRegionMagneticParametersInspectorPanel (`object.region.magnetic-parameters`) ── */

type ScalarParamDraftFields = {
  [P in RegionScalarParamKey as `${P}Mode`]: RegionFieldProfileMode;
} & {
  [P in RegionScalarParamKey as `${P}Value`]: number;
} & {
  [P in RegionScalarParamKey as `${P}EndValue`]: number;
} & {
  [P in RegionScalarParamKey as `${P}SpanM`]: number;
} & {
  [P in RegionScalarParamKey as `${P}Direction`]: readonly [number, number, number];
} & {
  [P in RegionScalarParamKey as `${P}RadialCenter`]: readonly [number, number, number];
} & {
  [P in RegionScalarParamKey as `${P}RadialRadius`]: number;
} & {
  [P in RegionScalarParamKey as `${P}Frame`]: SceneRegionFrame;
} & {
  [P in RegionScalarParamKey as `${P}Priority`]: number;
} & {
  [P in RegionScalarParamKey as `${P}ConflictPolicy`]: SceneRegionConflictPolicy;
} & {
  [P in RegionScalarParamKey as `${P}AssignmentId`]: string;
};

interface RegionMaterialOverridesDraft extends ScalarParamDraftFields {
  objectId: string;
  objectName: string;
  regionId: string;
  regionName: string;
  exists: boolean;
  parentMs: number;
  parentAex: number;
  parentAlpha: number;
  parentKu1: number;
  parentKu2: number;
  parentDind: number;
  parentDbulk: number;
  axisOverridden: boolean;
  axisAssignmentId: string;
  anisotropyAxis: readonly [number, number, number];
  axisPriority: number;
  axisConflictPolicy: SceneRegionConflictPolicy;
  regionMaterialOverrides: readonly RegionConstitutiveOverrideDraft[];
  hadAuthoredTransition: boolean;
  transitionKind: "sharp" | "metric" | "mesh_relative";
  transitionWidth: number;
  transitionCells: number;
  transitionScope: SceneMaterialTransitionScope;
  rawFunctionMap: Readonly<
    Partial<Record<RegionScalarParamKey, SceneMaterialParameterAssignment>>
  >;
  functionSummaryMap: Readonly<
    Partial<Record<RegionScalarParamKey, MaterialFunctionFieldSummary>>
  >;
  preservedExtraRegionFields: readonly SceneMaterialParameterAssignment[];
}

interface ScalarParamUiDescriptor {
  key: RegionScalarParamKey;
  modeLabel: (baseline: RegionMaterialOverridesDraft) => string;
  valueLabel: string;
  endLabel: string;
  symbol: ReactNode;
  endSymbol: ReactNode;
  scalarKind: "quantity" | "number";
  units?: readonly [UnitOption, ...UnitOption[]];
  defaultDisplayUnit?: string;
  min?: number;
  step?: number;
}

const EXCHANGE_DAMPING_DESCRIPTORS: readonly ScalarParamUiDescriptor[] = [
  {
    key: "ms",
    modeLabel: (b) => `Ms (${(b.parentMs / 1e3).toFixed(0)} kA/m on Object)`,
    valueLabel: "Regional Ms (base / inner)",
    endLabel: "Gradient end / outer Ms",
    symbol: (
      <>
        M<sub>s</sub>
      </>
    ),
    endSymbol: (
      <>
        M<sub>s,end</sub>
      </>
    ),
    scalarKind: "quantity",
    units: MAGNETIZATION_UNITS,
    defaultDisplayUnit: "kA/m",
    min: 0,
  },
  {
    key: "aex",
    modeLabel: (b) => `Aex (${(b.parentAex * 1e12).toFixed(1)} pJ/m on Object)`,
    valueLabel: "Regional exchange stiffness (base / inner)",
    endLabel: "Gradient end / outer Aex",
    symbol: (
      <>
        A<sub>ex</sub>
      </>
    ),
    endSymbol: (
      <>
        A<sub>ex,end</sub>
      </>
    ),
    scalarKind: "quantity",
    units: EXCHANGE_UNITS,
    defaultDisplayUnit: "pJ/m",
    min: 0,
  },
  {
    key: "alpha",
    modeLabel: (b) => `Gilbert \u03b1 (${b.parentAlpha} on Object)`,
    valueLabel: "Regional Gilbert damping (base / inner)",
    endLabel: "Gradient end / outer \u03b1",
    symbol: <>&alpha;</>,
    endSymbol: (
      <>
        &alpha;<sub>end</sub>
      </>
    ),
    scalarKind: "number",
    min: 0,
    step: 0.001,
  },
];

const ANISOTROPY_DMI_DESCRIPTORS: readonly ScalarParamUiDescriptor[] = [
  {
    key: "ku1",
    modeLabel: () => "First-order uniaxial Ku1",
    valueLabel: "Regional Ku1 (base / inner)",
    endLabel: "Gradient end / outer Ku1",
    symbol: (
      <>
        K<sub>u1</sub>
      </>
    ),
    endSymbol: (
      <>
        K<sub>u1,end</sub>
      </>
    ),
    scalarKind: "quantity",
    units: ANISOTROPY_UNITS,
    defaultDisplayUnit: "kJ/m\u00b3",
  },
  {
    key: "ku2",
    modeLabel: () => "Second-order uniaxial Ku2",
    valueLabel: "Regional Ku2 (base / inner)",
    endLabel: "Gradient end / outer Ku2",
    symbol: (
      <>
        K<sub>u2</sub>
      </>
    ),
    endSymbol: (
      <>
        K<sub>u2,end</sub>
      </>
    ),
    scalarKind: "quantity",
    units: ANISOTROPY_UNITS,
    defaultDisplayUnit: "kJ/m\u00b3",
  },
  {
    key: "dind",
    modeLabel: () => "Interfacial DMI (Dind)",
    valueLabel: "Regional Dind (base / inner)",
    endLabel: "Gradient end / outer Dind",
    symbol: (
      <>
        D<sub>ind</sub>
      </>
    ),
    endSymbol: (
      <>
        D<sub>ind,end</sub>
      </>
    ),
    scalarKind: "quantity",
    units: DMI_UNITS,
    defaultDisplayUnit: "mJ/m\u00b2",
  },
  {
    key: "dbulk",
    modeLabel: () => "Bulk DMI (Dbulk)",
    valueLabel: "Regional Dbulk (base / inner)",
    endLabel: "Gradient end / outer Dbulk",
    symbol: (
      <>
        D<sub>bulk</sub>
      </>
    ),
    endSymbol: (
      <>
        D<sub>bulk,end</sub>
      </>
    ),
    scalarKind: "quantity",
    units: DMI_UNITS,
    defaultDisplayUnit: "mJ/m\u00b2",
  },
];

const CONSTITUTIVE_PARAM_OPTIONS: readonly {
  value: SceneMaterialParameterName;
  label: string;
}[] = [
  { value: "ms", label: "Saturation magnetization (Ms, A/m)" },
  { value: "aex", label: "Exchange stiffness (Aex, J/m)" },
  { value: "alpha", label: "Gilbert damping (\u03b1)" },
  { value: "ku1", label: "Uniaxial Ku1 (J/m\u00b3)" },
  { value: "ku2", label: "Second-order Ku2 (J/m\u00b3)" },
  { value: "dind", label: "Interfacial DMI (Dind, J/m\u00b2)" },
  { value: "dbulk", label: "Bulk DMI (Dbulk, J/m\u00b2)" },
  { value: "anisotropy_axis", label: "Uniaxial axis (ux, uy, uz)" },
];

function buildScalarParamRows(
  desc: ScalarParamUiDescriptor,
  baseline: RegionMaterialOverridesDraft,
  femLane: boolean,
  materialFieldsData: ReturnType<typeof useModelMaterialFieldsResourceSafe>["data"],
): InspectorRowSpec<RegionMaterialOverridesDraft>[] {
  const modeKey = `${desc.key}Mode` as const;
  const valKey = `${desc.key}Value` as const;
  const endKey = `${desc.key}EndValue` as const;
  const spanKey = `${desc.key}SpanM` as const;
  const dirKey = `${desc.key}Direction` as const;
  const centerKey = `${desc.key}RadialCenter` as const;
  const radiusKey = `${desc.key}RadialRadius` as const;
  const frameKey = `${desc.key}Frame` as const;
  const prioKey = `${desc.key}Priority` as const;
  const conflictKey = `${desc.key}ConflictPolicy` as const;
  const assignmentKey = `${desc.key}AssignmentId` as const;

  const isEditableActive = (d: RegionMaterialOverridesDraft) =>
    d[modeKey] === "constant" ||
    d[modeKey] === "linear_gradient" ||
    d[modeKey] === "radial";

  const conflictOptions = [
    { value: "higher_priority_wins", label: "Higher priority wins" },
    { value: "error", label: "Report conflict error" },
    ...(femLane ? [{ value: "min_mesh_size_wins", label: "Finest mesh wins" }] : []),
  ];

  const primaryValueRow: InspectorRowSpec<RegionMaterialOverridesDraft> =
    desc.scalarKind === "quantity" && desc.units
      ? {
          key: valKey,
          type: "quantity",
          label: desc.valueLabel,
          symbol: desc.symbol,
          units: desc.units,
          defaultDisplayUnit: desc.defaultDisplayUnit,
          min: desc.min,
          showWhen: isEditableActive,
        }
      : {
          key: valKey,
          type: "number",
          label: desc.valueLabel,
          symbol: desc.symbol,
          min: desc.min,
          step: desc.step,
          showWhen: isEditableActive,
        };

  const secondaryEndRow: InspectorRowSpec<RegionMaterialOverridesDraft> =
    desc.scalarKind === "quantity" && desc.units
      ? {
          key: endKey,
          type: "quantity",
          label: desc.endLabel,
          symbol: desc.endSymbol,
          units: desc.units,
          defaultDisplayUnit: desc.defaultDisplayUnit,
          min: desc.min,
          showWhen: (d) => d[modeKey] === "linear_gradient" || d[modeKey] === "radial",
        }
      : {
          key: endKey,
          type: "number",
          label: desc.endLabel,
          symbol: desc.endSymbol,
          min: desc.min,
          step: desc.step,
          showWhen: (d) => d[modeKey] === "linear_gradient" || d[modeKey] === "radial",
        };

  return [
    {
      key: modeKey,
      type: "select",
      label: desc.modeLabel(baseline),
      structural: true,
      options: [
        { value: "inherited", label: "Inherited from Object" },
        { value: "constant", label: "Constant regional override" },
        { value: "linear_gradient", label: "Linear spatial gradient" },
        { value: "radial", label: "Radial profile" },
        ...(baseline[modeKey] === "function"
          ? [{ value: "function", label: "Python function (preserved)" }]
          : []),
      ],
    },
    primaryValueRow,
    secondaryEndRow,
    {
      key: spanKey,
      type: "quantity",
      label: `${desc.key.toUpperCase()} gradient span`,
      symbol: <>L</>,
      units: LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      min: 0,
      minExclusive: true,
      showWhen: (d) => d[modeKey] === "linear_gradient",
      validate: (v) => (v > 0 ? null : "Gradient span must be strictly positive."),
    },
    {
      key: dirKey,
      type: "vector3",
      label: `${desc.key.toUpperCase()} gradient direction`,
      axisPresets: true,
      normalizeAction: true,
      showWhen: (d) => d[modeKey] === "linear_gradient",
      validate: (vec) =>
        vectorNorm(vec) < 1e-12 ? "Gradient direction must be non-zero." : null,
    },
    {
      key: centerKey,
      type: "vector3",
      label: `${desc.key.toUpperCase()} radial center`,
      units: LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      showWhen: (d) => d[modeKey] === "radial",
    },
    {
      key: radiusKey,
      type: "quantity",
      label: `${desc.key.toUpperCase()} radial radius`,
      symbol: <>R</>,
      units: LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      min: 0,
      minExclusive: true,
      showWhen: (d) => d[modeKey] === "radial",
      validate: (v) => (v > 0 ? null : "Radial radius must be strictly positive."),
    },
    {
      key: frameKey,
      type: "segmented",
      label: `${desc.key.toUpperCase()} field frame`,
      options: [
        { value: "object", label: "Object local" },
        { value: "world", label: "World" },
      ],
      showWhen: (d) => d[modeKey] === "linear_gradient" || d[modeKey] === "radial",
    },
    {
      key: prioKey,
      type: "number",
      label: `${desc.key.toUpperCase()} priority`,
      integer: true,
      step: 1,
      showWhen: isEditableActive,
    },
    {
      key: conflictKey,
      type: "select",
      label: `${desc.key.toUpperCase()} conflict policy`,
      options: conflictOptions,
      showWhen: isEditableActive,
    },
    {
      type: "custom",
      wide: true,
      showWhen: (d) => d[modeKey] === "function",
      render: (ctx) => {
        const summary = ctx.draft.functionSummaryMap[desc.key];
        const rawFn = ctx.draft.rawFunctionMap[desc.key];
        return (
          <div
            className="rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2.5 text-xs"
            data-slot={`region-function-summary-${desc.key}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-1.5 font-medium text-[var(--fm-text)]">
              <span>
                Python function ({summary?.frame ?? "object"} frame, read-only &amp; preserved)
              </span>
              {summary?.unit ? <Badge data-tone="info">{summary.unit}</Badge> : null}
            </div>
            {summary ? (
              <div className="mt-1.5 flex flex-col gap-1 text-xs text-[var(--fm-text-muted)]">
                {summary.definition ? (
                  <div>
                    <span className="font-medium text-[var(--fm-text)]">Definition: </span>
                    <code>def {summary.definition}(x, y, z)</code>
                  </div>
                ) : null}
                <div>
                  <span className="font-medium text-[var(--fm-text)]">Equation: </span>
                  <code>{summary.equation}</code>
                </div>
                {summary.locals.map((loc) => (
                  <div key={loc.name}>
                    <span className="font-medium text-[var(--fm-text)]">{loc.name}: </span>
                    <code>{loc.expression}</code>
                  </div>
                ))}
                {summary.parameters.map((param) => (
                  <div key={param.name}>
                    <span className="font-medium text-[var(--fm-text)]">{param.name}: </span>
                    <code>{String(param.value)}</code>
                  </div>
                ))}
              </div>
            ) : rawFn ? (
              <p className="mt-1 text-xs text-[var(--fm-text-muted)]">
                Custom callable assignment <code>{rawFn.assignment_id}</code> preserved in
                SceneDocument.
              </p>
            ) : null}
          </div>
        );
      },
    },
    {
      type: "custom",
      wide: true,
      showWhen: (d) =>
        femLane &&
        d[modeKey] !== "inherited" &&
        materialFieldRealizationRows(d[assignmentKey], materialFieldsData).length > 0,
      render: (ctx) => {
        const rows = materialFieldRealizationRows(
          ctx.draft[assignmentKey],
          materialFieldsData,
        );
        if (rows.length === 0) return null;
        return (
          <div
            className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2 text-xs"
            data-slot={`region-field-realization-${desc.key}`}
          >
            {rows.map((r) => (
              <div key={r.label} className="flex items-baseline justify-between gap-2">
                <span className="text-[var(--fm-text-muted)]">{r.label}</span>
                <span className="font-mono text-[var(--fm-text)]">{r.value}</span>
              </div>
            ))}
          </div>
        );
      },
    },
  ];
}

export function ObjectRegionMagneticParametersInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const materialFieldsResource = useModelMaterialFieldsResourceSafe();
  const activeLane = useActiveLaneCapabilities();
  const sessionScopeKey = useRegionSessionScopeKey(kernel);
  const { objectId, regionId } = extractSelectionTarget(selection);

  const sceneObj = useMemo(
    () => scene.data?.objects?.find((o) => o.id === objectId),
    [objectId, scene.data?.objects],
  );
  const ownerBounds = useMemo(
    () => resolveOwnerBoundsForSceneObject(sceneObj),
    [sceneObj],
  );
  const regionObj = useMemo(
    () => sceneObj?.regions?.find((r) => r.region_id === regionId),
    [regionId, sceneObj?.regions],
  );
  const parentMat = useMemo(() => {
    const ref = sceneObj?.material_ref;
    return ref ? scene.data?.materials?.find((m) => m.id === ref) : undefined;
  }, [scene.data?.materials, sceneObj?.material_ref]);

  const activeLaneKind =
    (activeLane as { lane?: string } | null)?.lane ??
    (activeLane?.source?.kind === "planner" ? activeLane.resolved?.discretization : null);
  const meshLaneInfo = useMemo(
    () =>
      resolveCanonicalRegionMeshLane(
        activeLaneKind === "fem" || activeLaneKind === "fdm" ? activeLaneKind : null,
        scene.data,
      ),
    [activeLaneKind, scene.data],
  );
  const femLane = meshLaneInfo.lane === "fem";

  const baseline = useMemo<RegionMaterialOverridesDraft>(() => {
    const props = (parentMat?.properties ?? {}) as Record<string, unknown>;
    const parentMs = typeof props.Ms === "number" ? props.Ms : 8.0e5;
    const parentAex = typeof props.Aex === "number" ? props.Aex : 13e-12;
    const parentAlpha = typeof props.alpha === "number" ? props.alpha : 0.008;
    const parentDind = typeof props.Dind === "number" ? props.Dind : 0;
    const parentDbulk = typeof props.Dbulk === "number" ? props.Dbulk : 0;

    const stack = ((sceneObj as unknown as { physics_stack?: Record<string, unknown>[] })
      ?.physics_stack ?? []);
    const uni = stack.find((s) => s.kind === "uniaxial_anisotropy");
    const uniParams = (uni?.params ?? {}) as Record<string, unknown>;
    const parentKu1 = typeof uniParams.ku1 === "number" ? uniParams.ku1 : 0;
    const parentKu2 = typeof uniParams.ku2 === "number" ? uniParams.ku2 : 0;

    const regionRec = (regionObj ?? null) as Record<string, unknown> | null;
    const defaultPriority =
      typeof regionRec?.priority === "number" && Number.isFinite(regionRec.priority)
        ? Math.trunc(regionRec.priority)
        : 0;
    const geomDefaults = resolveRegionGeometryDefaults(regionRec, ownerBounds);

    const assignments = sceneObj?.material_parameter_fields ?? [];
    const parentValues: Record<RegionScalarParamKey, number> = {
      ms: parentMs,
      aex: parentAex,
      alpha: parentAlpha,
      ku1: parentKu1,
      ku2: parentKu2,
      dind: parentDind,
      dbulk: parentDbulk,
    };

    const rawFunctionMap: Partial<
      Record<RegionScalarParamKey, SceneMaterialParameterAssignment>
    > = {};
    const functionSummaryMap: Partial<
      Record<RegionScalarParamKey, MaterialFunctionFieldSummary>
    > = {};
    const scalarEntries = {} as ScalarParamDraftFields;

    for (const key of REGION_SCALAR_PARAM_KEYS) {
      const parsed = parseRegionScalarFieldParam({
        assignments,
        defaultCenter: geomDefaults.defaultCenter,
        defaultPriority,
        defaultRadius: geomDefaults.defaultRadius,
        defaultSpan: geomDefaults.defaultSpan,
        fallbackValue: parentValues[key],
        paramName: key,
        regionId,
      });
      const writable = scalarEntries as Record<string, unknown>;
      writable[`${key}Mode`] = parsed.mode;
      writable[`${key}Value`] = parsed.value;
      writable[`${key}EndValue`] = parsed.endValue;
      writable[`${key}SpanM`] = parsed.spanM;
      writable[`${key}Direction`] = parsed.direction;
      writable[`${key}RadialCenter`] = parsed.radialCenter;
      writable[`${key}RadialRadius`] = parsed.radialRadius;
      writable[`${key}Frame`] = parsed.frame;
      writable[`${key}Priority`] = parsed.priority;
      writable[`${key}ConflictPolicy`] = parsed.conflictPolicy;
      writable[`${key}AssignmentId`] = parsed.assignmentId;
      if (parsed.rawFunction) {
        rawFunctionMap[key] = parsed.rawFunction;
      }
      if (parsed.functionSummary) {
        functionSummaryMap[key] = parsed.functionSummary;
      }
    }

    const axisField = assignments.find(
      (f) => f.region_id === regionId && f.parameter === "anisotropy_axis",
    );
    const axisFieldVal = (axisField?.value ?? null) as Record<string, unknown> | null;
    const rawAxisVec = Array.isArray(axisFieldVal?.value)
      ? axisFieldVal.value
      : axisFieldVal?.direction;
    const parsedAxis: [number, number, number] =
      Array.isArray(rawAxisVec) && rawAxisVec.length >= 3
        ? [
            Number(rawAxisVec[0]) || 0,
            Number(rawAxisVec[1]) || 0,
            Number(rawAxisVec[2]) || 0,
          ]
        : [0, 0, 1];
    const safeAxis = vectorNorm(parsedAxis) > 1e-12 ? parsedAxis : ([0, 0, 1] as const);

    const handledParams = new Set<string>([
      ...REGION_SCALAR_PARAM_KEYS,
      "anisotropy_axis",
    ]);
    const preservedExtraRegionFields = assignments
      .filter((f) => f.region_id === regionId && !handledParams.has(f.parameter))
      .map((f) => structuredClone(f));

    const regionMaterialOverrides = parseRegionConstitutiveOverrides(
      regionObj?.material_overrides,
      defaultPriority,
    );
    const parsedTransition = parseRegionMaterialTransition(regionObj?.material_transition);

    return {
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Object",
      regionId,
      regionName: regionObj?.name?.trim() || regionId || "Region",
      exists: Boolean(regionObj),
      parentMs,
      parentAex,
      parentAlpha,
      parentKu1,
      parentKu2,
      parentDind,
      parentDbulk,
      ...scalarEntries,
      axisOverridden: Boolean(axisField),
      axisAssignmentId:
        axisField?.assignment_id || `field-${regionId}-anisotropy-axis`,
      anisotropyAxis: safeAxis,
      axisPriority:
        typeof axisField?.priority === "number" && Number.isFinite(axisField.priority)
          ? Math.trunc(axisField.priority)
          : defaultPriority,
      axisConflictPolicy:
        axisField?.conflict_policy === "error" ||
        axisField?.conflict_policy === "min_mesh_size_wins"
          ? axisField.conflict_policy
          : "higher_priority_wins",
      regionMaterialOverrides,
      ...parsedTransition,
      rawFunctionMap,
      functionSummaryMap,
      preservedExtraRegionFields,
    };
  }, [objectId, ownerBounds, parentMat?.properties, regionId, regionObj, sceneObj]);

  const countActiveOverrides = useCallback((d: RegionMaterialOverridesDraft): number => {
    let n = d.regionMaterialOverrides.length;
    for (const key of REGION_SCALAR_PARAM_KEYS) {
      if (d[`${key}Mode`] !== "inherited") n += 1;
    }
    if (d.axisOverridden) n += 1;
    return n;
  }, []);

  const resetPatch = useMemo<Partial<RegionMaterialOverridesDraft>>(
    () => ({
      msMode: "inherited",
      aexMode: "inherited",
      alphaMode: "inherited",
      ku1Mode: "inherited",
      ku2Mode: "inherited",
      dindMode: "inherited",
      dbulkMode: "inherited",
      axisOverridden: false,
      regionMaterialOverrides: [],
    }),
    [],
  );

  const spec = useMemo<InspectorSpec<RegionMaterialOverridesDraft>>(
    () => ({
      id: "object.region.magnetic-parameters",
      header: {
        breadcrumbs: [
          {
            id: "object",
            label: baseline.objectName,
            selection: buildObjectSelection(objectId, "object.root", baseline.objectName),
          },
          {
            id: "region",
            label: baseline.regionName,
            selection: buildRegionSelection(
              objectId,
              regionId,
              "object.region",
              baseline.regionName,
            ),
          },
          { id: "material", label: "Material Overrides" },
        ],
        searchable: true,
        extraMenuActions: [
          {
            id: "reset-all-to-object",
            label: "Reset all overrides to Object",
            icon: RotateCcw,
            onSelect: (ctx) => ctx.patchDraft(resetPatch),
          },
        ],
      },
      identity: {
        domain: "material",
        icon: Magnet,
        title: (d) => `${d.regionName} \u00b7 Material`,
        kindLabel: "Regional constitutive overrides",
        entityId: regionId || undefined,
        statePill: (d) => {
          const count = countActiveOverrides(d);
          return count > 0
            ? { tone: "ok", label: `${count} overridden` }
            : { tone: "neutral", label: "Inherited" };
        },
      },
      facts: (d): readonly InspectorFact[] => [
        {
          id: "overrides",
          label: "Active overrides",
          value: `${countActiveOverrides(d)} parameters`,
        },
        {
          id: "parent",
          label: "Base Ms",
          value: `${(d.parentMs / 1e3).toFixed(0)} kA/m`,
        },
        {
          id: "transition",
          label: "Transition",
          value: d.transitionKind.replace(/_/g, " "),
        },
      ],
      sections: [
        {
          id: "region-constitutive-overrides",
          title: "Constitutive region overrides (material_overrides)",
          icon: Magnet,
          defaultOpen: baseline.regionMaterialOverrides.length > 0,
          summary: (d) => `${d.regionMaterialOverrides.length} constitutive`,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => {
                const list = ctx.draft.regionMaterialOverrides;
                const updateItem = (
                  rowId: string,
                  updater: (
                    prev: RegionConstitutiveOverrideDraft,
                  ) => RegionConstitutiveOverrideDraft,
                ) => {
                  ctx.setField(
                    "regionMaterialOverrides",
                    list.map((entry) => (entry.rowId === rowId ? updater(entry) : entry)),
                  );
                };
                return (
                  <div
                    className="flex flex-col gap-2"
                    data-slot="region-constitutive-overrides-list"
                  >
                    {list.length === 0 ? (
                      <p className="text-xs text-[var(--fm-text-muted)]">
                        No direct constitutive entries on region.material_overrides. Use Add
                        Override or configure spatial parameter fields below.
                      </p>
                    ) : null}
                    {list.map((entry) => (
                      <div
                        key={entry.rowId}
                        className="flex flex-col gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2.5 text-xs"
                        data-override-parameter={entry.parameter}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-[var(--fm-text)]">
                            Override: {entry.parameter}
                          </span>
                          <Button
                            aria-label={`Remove constitutive override ${entry.parameter}`}
                            size="icon"
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              ctx.setField(
                                "regionMaterialOverrides",
                                list.filter((it) => it.rowId !== entry.rowId),
                              )
                            }
                          >
                            <Trash2 aria-hidden="true" size={12} />
                          </Button>
                        </div>

                        {entry.preservedOverride ? (
                          <p className="text-xs text-[var(--fm-text-muted)]">
                            Non-constant constitutive override ({entry.preservedOverride.value.kind})
                            preserved verbatim in SceneDocument.
                          </p>
                        ) : (
                          <>
                            <div className="grid grid-cols-2 gap-1.5">
                              <div className="flex flex-col gap-1">
                                <span className="text-[var(--fm-text-muted)]">Parameter</span>
                                <Select
                                  value={entry.parameter}
                                  onValueChange={(nextParam) =>
                                    updateItem(entry.rowId, (prev) => ({
                                      ...prev,
                                      parameter: nextParam as SceneMaterialParameterName,
                                    }))
                                  }
                                >
                                  <SelectTrigger
                                    aria-label={`Constitutive parameter ${entry.rowId}`}
                                    density="compact"
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {CONSTITUTIVE_PARAM_OPTIONS.map((opt) => (
                                      <SelectItem key={opt.value} value={opt.value}>
                                        {opt.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="flex flex-col gap-1">
                                <span className="text-[var(--fm-text-muted)]">Priority</span>
                                <Input
                                  aria-label={`Constitutive priority ${entry.parameter}`}
                                  step={1}
                                  type="number"
                                  value={String(entry.priority)}
                                  onChange={(e) => {
                                    const parsed = Number.parseInt(e.target.value, 10);
                                    if (Number.isFinite(parsed)) {
                                      updateItem(entry.rowId, (prev) => ({
                                        ...prev,
                                        priority: parsed,
                                      }));
                                    }
                                  }}
                                />
                              </div>
                            </div>

                            {entry.parameter === "anisotropy_axis" ? (
                              <div className="flex flex-col gap-1.5">
                                <div className="grid grid-cols-3 gap-1.5">
                                  {(["X", "Y", "Z"] as const).map((axisLabel, axisIdx) => (
                                    <Input
                                      key={axisLabel}
                                      aria-label={`Constitutive axis ${axisLabel}`}
                                      type="number"
                                      value={String(entry.vectorValue[axisIdx])}
                                      onChange={(e) => {
                                        const n = Number(e.target.value);
                                        if (Number.isFinite(n)) {
                                          const nextVec: [number, number, number] = [
                                            ...entry.vectorValue,
                                          ];
                                          nextVec[axisIdx] = n;
                                          updateItem(entry.rowId, (prev) => ({
                                            ...prev,
                                            vectorValue: nextVec,
                                          }));
                                        }
                                      }}
                                    />
                                  ))}
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {(
                                    [
                                      ["+X", [1, 0, 0]],
                                      ["+Y", [0, 1, 0]],
                                      ["+Z", [0, 0, 1]],
                                    ] as const
                                  ).map(([lbl, preset]) => (
                                    <Button
                                      key={lbl}
                                      size="sm"
                                      type="button"
                                      variant="ghost"
                                      onClick={() =>
                                        updateItem(entry.rowId, (prev) => ({
                                          ...prev,
                                          vectorValue: preset,
                                        }))
                                      }
                                    >
                                      {lbl}
                                    </Button>
                                  ))}
                                  <Button
                                    size="sm"
                                    type="button"
                                    variant="ghost"
                                    onClick={() =>
                                      updateItem(entry.rowId, (prev) => ({
                                        ...prev,
                                        vectorValue: normalizeVector3(
                                          prev.vectorValue,
                                          [0, 0, 1],
                                        ),
                                      }))
                                    }
                                  >
                                    Normalize
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <div className="grid grid-cols-2 gap-1.5">
                                <div className="flex flex-col gap-1">
                                  <span className="text-[var(--fm-text-muted)]">SI value</span>
                                  <Input
                                    aria-label={`Constitutive value ${entry.parameter}`}
                                    type="number"
                                    value={String(entry.value)}
                                    onChange={(e) => {
                                      const parsed = Number(e.target.value);
                                      if (Number.isFinite(parsed)) {
                                        updateItem(entry.rowId, (prev) => ({
                                          ...prev,
                                          value: parsed,
                                        }));
                                      }
                                    }}
                                  />
                                </div>
                                <div className="flex flex-col gap-1">
                                  <span className="text-[var(--fm-text-muted)]">
                                    Conflict policy
                                  </span>
                                  <Select
                                    value={entry.conflictPolicy}
                                    onValueChange={(nextPol) =>
                                      updateItem(entry.rowId, (prev) => ({
                                        ...prev,
                                        conflictPolicy: nextPol as SceneRegionConflictPolicy,
                                      }))
                                    }
                                  >
                                    <SelectTrigger
                                      aria-label={`Constitutive conflict policy ${entry.parameter}`}
                                      density="compact"
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="higher_priority_wins">
                                        Higher priority wins
                                      </SelectItem>
                                      <SelectItem value="error">Report conflict error</SelectItem>
                                      {femLane ? (
                                        <SelectItem value="min_mesh_size_wins">
                                          Finest mesh wins
                                        </SelectItem>
                                      ) : null}
                                    </SelectContent>
                                  </Select>
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                    <div>
                      <Button
                        size="sm"
                        type="button"
                        variant="secondary"
                        onClick={() =>
                          ctx.setField("regionMaterialOverrides", [
                            ...list,
                            {
                              rowId: `ovr-new-${Date.now().toString(36)}-${list.length}`,
                              parameter: "ms",
                              value: ctx.draft.parentMs,
                              vectorValue: [0, 0, 1],
                              unit: "A/m",
                              priority: 0,
                              conflictPolicy: "higher_priority_wins",
                            },
                          ])
                        }
                      >
                        <Plus aria-hidden="true" size={12} />
                        <span>Add Constitutive Override</span>
                      </Button>
                    </div>
                  </div>
                );
              },
            },
          ],
        },
        {
          id: "region-mat-exchange-damping",
          title: "Magnetization, exchange & damping overrides",
          icon: Magnet,
          defaultOpen: true,
          rows: EXCHANGE_DAMPING_DESCRIPTORS.flatMap((desc) =>
            buildScalarParamRows(desc, baseline, femLane, materialFieldsResource.data),
          ),
          footer: (ctx) =>
            countActiveOverrides(ctx.draft) > 0 ? (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => ctx.patchDraft(resetPatch)}
              >
                <RotateCcw aria-hidden="true" size={12} />
                <span>Reset to Inherited</span>
              </Button>
            ) : null,
        },
        {
          id: "region-mat-anisotropy-dmi",
          title: "Anisotropy (Ku1, Ku2) & DMI overrides",
          icon: Layers,
          defaultOpen: true,
          rows: [
            ...ANISOTROPY_DMI_DESCRIPTORS.slice(0, 2).flatMap((desc) =>
              buildScalarParamRows(desc, baseline, femLane, materialFieldsResource.data),
            ),
            {
              key: "axisOverridden",
              type: "switch",
              label: "Override uniaxial axis in region",
              structural: true,
            },
            {
              key: "anisotropyAxis",
              type: "vector3",
              label: "Regional uniaxial axis",
              symbol: <>u&#770;</>,
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) => d.axisOverridden,
              validate: (vec) =>
                vectorNorm(vec) < 1e-12 ? "Uniaxial axis must be non-zero." : null,
            },
            {
              key: "axisPriority",
              type: "number",
              label: "Uniaxial axis priority",
              integer: true,
              step: 1,
              showWhen: (d) => d.axisOverridden,
            },
            {
              key: "axisConflictPolicy",
              type: "select",
              label: "Uniaxial axis conflict policy",
              options: [
                { value: "higher_priority_wins", label: "Higher priority wins" },
                { value: "error", label: "Report conflict error" },
                ...(femLane
                  ? [{ value: "min_mesh_size_wins", label: "Finest mesh wins" }]
                  : []),
              ],
              showWhen: (d) => d.axisOverridden,
            },
            ...ANISOTROPY_DMI_DESCRIPTORS.slice(2).flatMap((desc) =>
              buildScalarParamRows(desc, baseline, femLane, materialFieldsResource.data),
            ),
          ],
        },
        {
          id: "region-mat-boundary-transition",
          title: "Boundary transition (material_transition)",
          icon: Layers,
          defaultOpen: true,
          rows: [
            {
              key: "transitionKind",
              type: "segmented",
              label: "Boundary transition",
              structural: true,
              options: [
                { value: "sharp", label: "Sharp" },
                { value: "metric", label: "Metric width" },
                { value: "mesh_relative", label: "Mesh-relative" },
              ],
            },
            {
              key: "transitionWidth",
              type: "quantity",
              label: "Transition width",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.transitionKind === "metric",
            },
            {
              key: "transitionCells",
              type: "number",
              label: "Transition cells",
              integer: true,
              min: 1,
              step: 1,
              showWhen: (d) => d.transitionKind === "mesh_relative",
              validate: (v) =>
                Number.isInteger(v) && v >= 1
                  ? null
                  : "Transition cells must be an integer >= 1.",
            },
            {
              key: "transitionScope",
              type: "segmented",
              label: "Transition scope",
              options: [
                { value: "boundary", label: "Boundary" },
                { value: "inside", label: "Inside" },
                { value: "outside", label: "Outside" },
              ],
              showWhen: (d) =>
                d.transitionKind === "metric" || d.transitionKind === "mesh_relative",
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Regional material assignments match SceneDocument",
        lockReason: (d) => (!d.exists ? "Select an existing authored region." : null),
        onApply: async (draft, base) => {
          const otherRegionFields: SceneMaterialParameterAssignment[] = (
            sceneObj?.material_parameter_fields ?? []
          ).filter((f) => f.region_id !== regionId);

          const nextRegionFields: SceneMaterialParameterAssignment[] = [
            ...draft.preservedExtraRegionFields.map((f) => structuredClone(f)),
          ];

          for (const key of REGION_SCALAR_PARAM_KEYS) {
            const built = serializeRegionScalarFieldParam({
              assignmentId: draft[`${key}AssignmentId`],
              conflictPolicy: draft[`${key}ConflictPolicy`],
              direction: draft[`${key}Direction`],
              endValue: draft[`${key}EndValue`],
              femLane,
              frame: draft[`${key}Frame`],
              mode: draft[`${key}Mode`],
              objectId,
              paramName: key,
              priority: draft[`${key}Priority`],
              radialCenter: draft[`${key}RadialCenter`],
              radialRadius: draft[`${key}RadialRadius`],
              rawFunction: draft.rawFunctionMap[key] ?? null,
              regionId,
              spanM: draft[`${key}SpanM`],
              value: draft[`${key}Value`],
            });
            if (built) {
              nextRegionFields.push(built);
            }
          }

          if (draft.axisOverridden) {
            const resolvedAxisConflict =
              !femLane && draft.axisConflictPolicy === "min_mesh_size_wins"
                ? undefined
                : draft.axisConflictPolicy;
            nextRegionFields.push({
              assignment_id: draft.axisAssignmentId || `field-${regionId}-anisotropy-axis`,
              owner_object: objectId,
              region_id: regionId,
              parameter: "anisotropy_axis",
              priority: Math.trunc(draft.axisPriority),
              ...(resolvedAxisConflict ? { conflict_policy: resolvedAxisConflict } : {}),
              value: {
                kind: "constant",
                unit: null,
                value: normalizeVector3(draft.anisotropyAxis, [0, 0, 1]),
              },
            });
          }

          const nextConstitutive = serializeRegionConstitutiveOverrides(
            draft.regionMaterialOverrides,
            femLane,
          );
          const baseConstitutive = serializeRegionConstitutiveOverrides(
            base.regionMaterialOverrides,
            femLane,
          );
          const constitutiveChanged =
            JSON.stringify(nextConstitutive) !== JSON.stringify(baseConstitutive);
          const transitionChanged =
            draft.transitionKind !== base.transitionKind ||
            draft.transitionWidth !== base.transitionWidth ||
            draft.transitionCells !== base.transitionCells ||
            draft.transitionScope !== base.transitionScope;

          const currentRegionFields = (sceneObj?.material_parameter_fields ?? []).filter(
            (f) => f.region_id === regionId,
          );
          const fieldsChanged =
            JSON.stringify(nextRegionFields) !== JSON.stringify(currentRegionFields) ||
            (!constitutiveChanged && !transitionChanged);

          const outcome = await executeRegionMutationWithHistory({
            kernel,
            label: `Update regional magnetic parameters on ${draft.regionName}`,
            sceneData: scene.data,
            sessionScopeKey,
            sourceDetail: "object-region-magnetic-parameters-apply",
            mutation: async (_prep, writeOpts) => {
              let latestScene = scene.data ?? null;
              let latestRevision = writeOpts?.baseRevision;

              if (constitutiveChanged || transitionChanged) {
                const regionPatch: SceneObjectRegionPatch = {};
                if (constitutiveChanged) {
                  regionPatch.material_overrides = nextConstitutive;
                }
                if (transitionChanged) {
                  regionPatch.material_transition =
                    draft.transitionKind === "sharp" && !draft.hadAuthoredTransition
                      ? { kind: "sharp" }
                      : serializeRegionMaterialTransition(draft);
                }
                const regTx = await kernel.api.model.patchObjectRegion(
                  objectId,
                  regionId,
                  regionPatch,
                  writeOpts,
                );
                latestScene = regTx.committed_scene;
                latestRevision = regTx.scene_revision;
              }

              if (fieldsChanged) {
                const nextOpts =
                  latestRevision !== undefined || sessionScopeKey
                    ? {
                        ...(latestRevision !== undefined
                          ? { baseRevision: latestRevision }
                          : {}),
                        ...(sessionScopeKey ? { sessionScopeKey } : {}),
                      }
                    : undefined;
                const fieldsTx = await kernel.api.model.patchObjectMaterialFields(
                  objectId,
                  [...otherRegionFields, ...nextRegionFields],
                  nextOpts,
                );
                latestScene = fieldsTx.committed_scene;
                latestRevision = fieldsTx.scene_revision;
              }

              return {
                committed_scene: latestScene,
                scene_revision: latestRevision,
              };
            },
          });

          await finalizeRegionAuthoringCommit({
            committedScene: outcome.committed_scene,
            fallbackRev: scene.data?.revision,
            kernel,
            sceneRevision: outcome.scene_revision,
            sessionScopeKey,
          });
          return true;
        },
      },
    }),
    [
      baseline,
      countActiveOverrides,
      femLane,
      kernel,
      materialFieldsResource.data,
      objectId,
      regionId,
      resetPatch,
      scene.data,
      sceneObj?.material_parameter_fields,
      sessionScopeKey,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 4. ObjectRegionMeshInspectorPanel (`object.region.mesh`) ── */

interface RegionMeshPolicyDraft {
  objectId: string;
  objectName: string;
  regionId: string;
  regionName: string;
  exists: boolean;
  realizationMode: SceneRegionRealizationPolicy;
  enableMeshPolicy: boolean;
  maxElementSize: number;
  minElementSize: number;
  transitionDistance: number;
  order: number;
}

export function ObjectRegionMeshInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const activeLane = useActiveLaneCapabilities();
  const sessionScopeKey = useRegionSessionScopeKey(kernel);
  const [buildPending, setBuildPending] = useState(false);

  const { objectId, regionId } = extractSelectionTarget(selection);

  const sceneObj: SceneObject | undefined = useMemo(
    () => scene.data?.objects?.find((o) => o.id === objectId),
    [objectId, scene.data?.objects],
  );
  const regionRec = useMemo(
    () =>
      (sceneObj?.regions?.find((r) => r.region_id === regionId) ?? null) as Record<
        string,
        unknown
      > | null,
    [regionId, sceneObj?.regions],
  );

  const activeLaneKind =
    (activeLane as { lane?: string } | null)?.lane ??
    (activeLane?.source?.kind === "planner" ? activeLane.resolved?.discretization : null);
  const meshLaneInfo = useMemo(
    () =>
      resolveCanonicalRegionMeshLane(
        activeLaneKind === "fem" || activeLaneKind === "fdm" ? activeLaneKind : null,
        scene.data,
      ),
    [activeLaneKind, scene.data],
  );

  const femLane = meshLaneInfo.lane === "fem";
  const fdmLane = meshLaneInfo.lane === "fdm";

  const fdmDomain = useDomainMetaResourceSafe({ enabled: fdmLane });
  const fdmMembership = useFdmRegionMembershipResourceSafe({ enabled: fdmLane });
  const fdmMembershipBinary = useFdmRegionMembershipBinaryResourceSafe(regionId || null, {
    enabled: fdmLane && Boolean(regionRec) && Boolean(regionId),
    ownerObjectId: objectId,
  });
  const fdmResources = useMemo<FdmObjectMeshInspectorResources>(
    () => ({
      binary: fdmMembershipBinary,
      domain: fdmDomain,
      membership: fdmMembership,
    }),
    [fdmDomain, fdmMembership, fdmMembershipBinary],
  );
  const fdmModel = useMemo(
    () =>
      resolveFdmObjectMeshInspectorModel({
        lane: fdmLane ? "fdm" : femLane ? "fem" : "unknown",
        objectId,
        regionId: regionId || null,
        resources: fdmResources,
      }),
    [fdmLane, fdmResources, femLane, objectId, regionId],
  );

  const femMembership = useMeshRegionMembershipResourceSafe(objectId, regionId, {
    enabled: femLane && Boolean(regionRec) && Boolean(regionId),
  });
  const femActiveBuild = useMeshBuildCurrentSafe({
    enabled: femLane && Boolean(regionRec),
  });
  const femQuality = useMeshRegionQualityResourceSafe(regionId, {
    enabled: femLane && Boolean(regionRec) && Boolean(regionId),
  });
  const qualityStatistics = useMemo(
    () => normalizeMeshQualityStatistics(femQuality.data?.quality),
    [femQuality.data?.quality],
  );

  const hoverSizeDistributionBin = useCallback(
    (bin: MeshSizeDistributionHoverBin | null) => {
      emitMeshSizeHistogramHover({
        bin,
        kernel,
        scope: {
          kind: "region",
          meshPartIds: femMembership.data?.mesh_part_ids ?? [],
          objectId,
          regionId,
        },
      });
    },
    [femMembership.data?.mesh_part_ids, kernel, objectId, regionId],
  );

  const baseline = useMemo<RegionMeshPolicyDraft>(() => {
    const policy = (regionRec?.mesh_policy ?? null) as Record<string, unknown> | null;
    const topLevelPolicy =
      typeof regionRec?.realization_policy === "string"
        ? regionRec.realization_policy
        : null;
    const rawMode =
      topLevelPolicy ??
      (typeof policy?.realization_policy === "string"
        ? policy.realization_policy
        : "inherit");
    const realizationMode: SceneRegionRealizationPolicy =
      rawMode === "conformal" || rawMode === "project" ? rawMode : "inherit";

    const resolvedMax =
      typeof policy?.maximum_element_size === "number" && policy.maximum_element_size > 0
        ? policy.maximum_element_size
        : 10e-9;
    const defaultMin = Math.min(1e-9, resolvedMax * 0.5);
    const resolvedMin =
      typeof policy?.minimum_element_size === "number" && policy.minimum_element_size > 0
        ? policy.minimum_element_size
        : defaultMin;
    const resolvedTransition =
      typeof policy?.transition_distance === "number" && policy.transition_distance > 0
        ? policy.transition_distance
        : 50e-9;
    const resolvedOrder =
      typeof policy?.order === "number" && Number.isFinite(policy.order) && policy.order >= 1
        ? Math.round(policy.order)
        : 1;

    return {
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Object",
      regionId,
      regionName: String(regionRec?.name ?? (regionId || "Region")),
      exists: Boolean(regionRec),
      realizationMode,
      enableMeshPolicy: Boolean(policy),
      maxElementSize: resolvedMax,
      minElementSize: resolvedMin,
      transitionDistance: resolvedTransition,
      order: resolvedOrder,
    };
  }, [objectId, regionId, regionRec, sceneObj?.name]);

  const applyMeshDraft = useCallback(
    async (draft: RegionMeshPolicyDraft): Promise<boolean> => {
      const regionPatch: SceneObjectRegionPatch = {
        realization_policy: draft.realizationMode,
        mesh_policy: draft.enableMeshPolicy
          ? {
              maximum_element_size: draft.maxElementSize,
              minimum_element_size: draft.minElementSize,
              transition_distance: draft.transitionDistance,
              order: Math.max(1, Math.round(draft.order)),
            }
          : null,
      };
      const tx = await executeRegionMutationWithHistory({
        kernel,
        label: `Update mesh policy on ${draft.regionName}`,
        sceneData: scene.data,
        sessionScopeKey,
        sourceDetail: "object-region-mesh-apply",
        mutation: async (_prep, writeOpts) =>
          kernel.api.model.patchObjectRegion(objectId, regionId, regionPatch, writeOpts),
      });
      await finalizeRegionAuthoringCommit({
        committedScene: tx.committed_scene,
        fallbackRev: scene.data?.revision,
        kernel,
        sceneRevision: tx.scene_revision,
        sessionScopeKey,
      });
      return true;
    },
    [kernel, objectId, regionId, scene.data, sessionScopeKey],
  );

  const handleBuildRegionMesh = useCallback(
    async (draft: RegionMeshPolicyDraft) => {
      if (!objectId || !regionId || buildPending) return;
      setBuildPending(true);
      try {
        if (JSON.stringify(draft) !== JSON.stringify(baseline)) {
          await applyMeshDraft(draft);
        }
        await kernel.commands.execute(
          "mesh.build-shared-domain",
          createCommandContext("inspector", kernel, {
            input: { object_id: objectId, region_id: regionId },
            sessionScopeKey: sessionScopeKey ?? undefined,
            sourceDetail: "object-region-mesh-build",
          }),
        );
      } finally {
        setBuildPending(false);
      }
    },
    [applyMeshDraft, baseline, buildPending, kernel, objectId, regionId, sessionScopeKey],
  );

  const meshPolicySupported = useMemo(() => {
    if (!femLane) return true;
    const rawLane = activeLane as unknown as Record<string, unknown> | null | undefined;
    const capabilities =
      rawLane && typeof rawLane.capabilities === "object"
        ? (rawLane.capabilities as Record<string, unknown>)
        : null;
    const gates = capabilities?.capability_gates;
    if (!gates || typeof gates !== "object") return true;
    const gate = (gates as Record<string, { status?: string } | undefined>)[
      "regions.mesh_policy"
    ];
    return !gate || gate.status !== "unsupported";
  }, [activeLane, femLane]);

  const spec = useMemo<InspectorSpec<RegionMeshPolicyDraft>>(
    () => ({
      id: "object.region.mesh",
      header: {
        breadcrumbs: [
          {
            id: "object",
            label: baseline.objectName,
            selection: buildObjectSelection(objectId, "object.root", baseline.objectName),
          },
          {
            id: "region",
            label: baseline.regionName,
            selection: buildRegionSelection(
              objectId,
              regionId,
              "object.region",
              baseline.regionName,
            ),
          },
          { id: "mesh", label: "Mesh Policy" },
        ],
        searchable: false,
        ...(baseline.exists && femLane
          ? {
              primaryHeaderAction: {
                label: buildPending ? "Waiting for mesh build\u2026" : "Build Mesh",
                icon: Hammer,
                disabledReason: !meshPolicySupported
                  ? "Region mesh policy is not supported by the resolved backend capability."
                  : buildPending
                    ? "Mesh build is in progress."
                    : undefined,
                onRun: async (ctx) => {
                  await handleBuildRegionMesh(ctx.draft);
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "mesh",
        icon: Grid3x3,
        title: (d) => `${d.regionName} \u00b7 Mesh`,
        kindLabel: "Regional discretization policy",
        entityId: regionId || undefined,
        statePill: (d) =>
          fdmLane
            ? {
                tone: fdmModel.status === "ready" ? "ok" : "info",
                label: fdmModel.status === "ready" ? "FDM Mask" : fdmModel.status,
              }
            : d.enableMeshPolicy || d.realizationMode !== "inherit"
              ? { tone: "ok", label: "Override" }
              : { tone: "neutral", label: "Inherited" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "support", label: "Support", value: meshLaneInfo.factValue, tone: "info" },
        ...(fdmLane
          ? [
              {
                id: "fdm-cells",
                label: "Active cells",
                value:
                  fdmModel.activeCellCount !== null
                    ? fdmModel.activeCellCount.toLocaleString("en-US")
                    : null,
              },
            ]
          : [
              {
                id: "hmax",
                label: "Local h_max",
                value: d.enableMeshPolicy
                  ? formatLengthAuto(d.maxElementSize)
                  : "Inherits Object",
              },
            ]),
      ],
      notices: (): readonly InspectorNotice<RegionMeshPolicyDraft>[] => {
        const list: InspectorNotice<RegionMeshPolicyDraft>[] = [];
        if (meshLaneInfo.lane === "pending") {
          list.push({
            id: "pending-mesh-lane",
            tone: "info",
            title: "Pending study discretization",
            text: "Authored region mesh overrides are saved in ProblemIR and realized once FEM or FDM discretization is selected on Study.",
          });
        }
        if (fdmLane && fdmModel.notice) {
          list.push({
            id: "fdm-region-mesh-notice",
            tone: fdmModel.status === "error" ? "err" : "warn",
            title: "Structured-grid membership",
            text: fdmModel.notice,
          });
        }
        return list;
      },
      sections: [
        {
          id: "region-fdm-membership",
          title: "FDM structured-grid region membership",
          icon: Grid3x3,
          defaultOpen: true,
          showWhen: () => fdmLane,
          summary: () => fdmModel.status,
          rows: [
            {
              type: "readonly",
              label: "Mesh policy",
              format: () => "Execution-plan owned (read-only)",
            },
            {
              type: "readonly",
              label: "Mesh status",
              format: () => fdmModel.status,
            },
            {
              type: "readonly",
              label: "Grid origin",
              format: () =>
                fdmModel.origin ? formatVectorSpanAuto(fdmModel.origin) : "Not materialized",
            },
            {
              type: "readonly",
              label: "Grid spacing",
              format: () =>
                fdmModel.spacing
                  ? formatVectorSpanAuto(fdmModel.spacing)
                  : "Not materialized",
            },
            {
              type: "readonly",
              label: "Grid shape",
              format: () => fdmModel.shape?.join(" \u00d7 ") ?? "Not materialized",
            },
            {
              type: "readonly",
              label: "Total grid cells",
              format: () =>
                fdmModel.totalCells !== null
                  ? fdmModel.totalCells.toLocaleString("en-US")
                  : "Not materialized",
            },
            {
              type: "readonly",
              label: "Cell participation",
              format: () => {
                if (fdmModel.participation === "canonical-mask") {
                  const active = fdmModel.activeCellCount ?? 0;
                  const inactive = fdmModel.inactiveCellCount ?? 0;
                  const total = fdmModel.totalCells ?? 0;
                  const pct =
                    total > 0 ? ` (${((active / total) * 100).toPrecision(3)}%)` : "";
                  return `${active.toLocaleString("en-US")} active${pct} \u00b7 ${inactive.toLocaleString("en-US")} outside support`;
                }
                if (fdmModel.participation === "legacy-ambiguous") {
                  return "Legacy mask is ambiguous; classification withheld";
                }
                if (fdmModel.participation === "descriptor-only") {
                  return "Canonical mask descriptor available; binary mask not loaded";
                }
                return "Not materialized";
              },
            },
            {
              type: "readonly",
              label: "Region metadata",
              format: () =>
                fdmModel.metadata.length > 0
                  ? fdmModel.metadata
                      .map((entry) => `${entry.regionId} (#${entry.numericId})`)
                      .join(", ")
                  : "None for selected region",
            },
            {
              type: "readonly",
              label: "Grid fingerprint",
              mono: true,
              format: () => fdmModel.gridFingerprint ?? "Not materialized",
            },
          ],
        },
        {
          id: "region-mesh-policy",
          title: "Boundary realization & local sizing",
          icon: Grid3x3,
          defaultOpen: true,
          showWhen: () => !fdmLane,
          rows: [
            {
              key: "realizationMode",
              type: "segmented",
              label: "Interface realization",
              options: [
                { value: "inherit", label: "Inherit" },
                { value: "conformal", label: "Conformal" },
                { value: "project", label: "Project" },
              ],
            },
            {
              key: "enableMeshPolicy",
              type: "switch",
              label: "Override regional FEM mesh sizing",
              structural: true,
            },
            {
              key: "maxElementSize",
              type: "quantity",
              label: "Maximum element size",
              symbol: (
                <>
                  h<sub>max</sub>
                </>
              ),
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.enableMeshPolicy,
              validate: (v) => (v > 0 ? null : "h_max must be strictly positive."),
            },
            {
              key: "minElementSize",
              type: "quantity",
              label: "Minimum element size",
              symbol: (
                <>
                  h<sub>min</sub>
                </>
              ),
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.enableMeshPolicy,
              validate: (v, d) => {
                if (v <= 0) return "h_min must be strictly positive.";
                if (v > d.maxElementSize) {
                  return "Minimum element size cannot exceed maximum element size.";
                }
                return null;
              },
            },
            {
              key: "transitionDistance",
              type: "quantity",
              label: "Transition distance",
              symbol: (
                <>
                  d<sub>trans</sub>
                </>
              ),
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.enableMeshPolicy,
              validate: (v) =>
                v > 0 ? null : "Transition distance must be strictly positive.",
            },
            {
              key: "order",
              type: "number",
              label: "Element order",
              integer: true,
              min: 1,
              step: 1,
              showWhen: (d) => d.enableMeshPolicy,
              validate: (v) =>
                Number.isInteger(v) && v >= 1
                  ? null
                  : "Element order must be a positive integer.",
            },
            ...(femLane
              ? [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: (ctx: { draft: RegionMeshPolicyDraft; baseline: RegionMeshPolicyDraft }) => {
                      const isDirty =
                        JSON.stringify(ctx.draft) !== JSON.stringify(ctx.baseline);
                      const lifecycle = resolveRegionMeshLifecycle({
                        build: femActiveBuild.data,
                        draftDirty: isDirty,
                        membership: femMembership.data,
                        policyEnabled: ctx.draft.enableMeshPolicy,
                        supported: meshPolicySupported,
                      });
                      const buildLabel =
                        buildPending || lifecycle.status === "pending"
                          ? "Waiting for mesh build\u2026"
                          : isDirty
                            ? "Apply & Build Mesh"
                            : "Build Mesh";
                      const disabledReason = !meshPolicySupported
                        ? lifecycle.reason
                        : buildPending || lifecycle.status === "pending"
                          ? "A mesh build is currently pending."
                          : null;

                      const buttonEl = (
                        <Button
                          disabled={Boolean(disabledReason)}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => void handleBuildRegionMesh(ctx.draft)}
                        >
                          <Hammer aria-hidden="true" size={12} />
                          <span>{buildLabel}</span>
                        </Button>
                      );

                      return (
                        <div
                          className="flex flex-col gap-1.5 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2.5 text-xs"
                          data-slot="region-fem-mesh-lifecycle"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[var(--fm-text-muted)]">Mesh realization</span>
                            <Badge
                              data-tone={
                                lifecycle.status === "current"
                                  ? "ok"
                                  : lifecycle.status === "failed"
                                    ? "err"
                                    : lifecycle.status === "stale"
                                      ? "warn"
                                      : "info"
                              }
                            >
                              {lifecycle.status}
                            </Badge>
                          </div>
                          <p className="text-xs text-[var(--fm-text-muted)]">
                            {lifecycle.reason}
                          </p>
                          {lifecycle.generationId ? (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[var(--fm-text-muted)]">Mesh generation</span>
                              <span className="font-mono text-[var(--fm-text)]">
                                {lifecycle.generationId}
                              </span>
                            </div>
                          ) : null}
                          {lifecycle.topologyFingerprint ? (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[var(--fm-text-muted)]">
                                Topology fingerprint
                              </span>
                              <span className="font-mono text-[var(--fm-text)]">
                                {lifecycle.topologyFingerprint}
                              </span>
                            </div>
                          ) : null}
                          <div className="pt-1">
                            {disabledReason ? (
                              <DisabledReason reason={disabledReason}>
                                {buttonEl}
                              </DisabledReason>
                            ) : (
                              buttonEl
                            )}
                          </div>
                        </div>
                      );
                    },
                  },
                ]
              : []),
          ],
          footer: (ctx) =>
            ctx.draft.enableMeshPolicy || ctx.draft.realizationMode !== "inherit" ? (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() =>
                  ctx.patchDraft({
                    realizationMode: "inherit",
                    enableMeshPolicy: false,
                  })
                }
              >
                <RotateCcw aria-hidden="true" size={12} />
                <span>Reset to Inherited</span>
              </Button>
            ) : null,
        },
        {
          id: "region-fem-quality-distributions",
          title: "Region Quality Distributions",
          icon: Gauge,
          defaultOpen: true,
          showWhen: () => femLane,
          summary: () =>
            qualityStatistics?.elementCount != null
              ? `${qualityStatistics.elementCount.toLocaleString("en-US")} elements`
              : femQuality.status,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <div data-slot="region-mesh-quality-statistics">
                  <MeshQualityStatisticsView
                    statistics={qualityStatistics}
                    onHoverSizeDistributionBin={hoverSizeDistributionBin}
                  />
                </div>
              ),
            },
          ],
        },
      ],
      commitBar: fdmLane
        ? {
            mode: "readOnly",
            statusMessage: () =>
              "FDM structured-grid region membership is derived from the execution plan",
          }
        : {
            mode: "staged",
            cleanMessage: () => "Regional mesh policy matches SceneDocument",
            lockReason: (d) => (!d.exists ? "Select an existing authored region." : null),
            onApply: applyMeshDraft,
          },
    }),
    [
      applyMeshDraft,
      baseline.exists,
      baseline.objectName,
      baseline.regionName,
      buildPending,
      fdmLane,
      fdmModel,
      femActiveBuild.data,
      femLane,
      femMembership.data,
      femQuality.status,
      handleBuildRegionMesh,
      hoverSizeDistributionBin,
      meshLaneInfo.factValue,
      meshLaneInfo.lane,
      meshPolicySupported,
      objectId,
      qualityStatistics,
      regionId,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
