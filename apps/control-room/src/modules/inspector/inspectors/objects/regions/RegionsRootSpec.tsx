"use client";

import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Copy,
  Layers,
  Plus,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
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
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
} from "@/kernel/visualization/ObjectVisualizationController";
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
import { Switch } from "@/shared/ui/Switch";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorFact, InspectorSpec } from "../../../template";
import {
  buildObjectSelection,
  buildRegionSelection,
  buildRootSelection,
  SpecInspectorHost,
} from "../../../panels/model-roots/SpecInspectorHost";
import {
  buildStarterRegionPayload,
  cloneRegionForDuplicate,
  executeRegionMutationWithHistory,
  extractRegionDiagnosticsForTarget,
  extractSelectionTarget,
  finalizeRegionAuthoringCommit,
  formatRegionShapeKindLabel,
  hasRegionTextureOverride,
  REGION_SHAPE_STARTERS,
  resolveCanonicalRegionMeshLane,
  resolveCouplingDependenciesForRegion,
  resolveOwnerBoundsForSceneObject,
  useModelCouplingsResourceSafe,
  useRegionSessionScopeKey,
  type RegionShapeMode,
} from "../../../panels/region/regionInspectorHelpers";
import {
  assignDescendingPrecedencePriorities,
  EMPTY_VISUALIZATION_SNAPSHOT,
  toJsonValue,
} from "./regionShared";

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
    const mapped = (sceneObj?.regions ?? []).map((reg, originalIndex) => {
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
        originalIndex,
        item: {
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
        },
      };
    });
    mapped.sort(
      (a, b) => b.item.priority - a.item.priority || a.originalIndex - b.originalIndex,
    );
    return mapped.map((entry) => entry.item);
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
      if (!objectId || toIdx < 0 || toIdx >= items.length || fromIdx === toIdx) return;
      const reordered = [...items];
      const [moved] = reordered.splice(fromIdx, 1);
      if (!moved) return;
      reordered.splice(toIdx, 0, moved);
      const nextPriorities = assignDescendingPrecedencePriorities(
        reordered.map((it) => it.priority),
      );

      const tx = await executeRegionMutationWithHistory({
        kernel,
        label: `Update region precedence on ${objectId}`,
        sceneData: scene.data,
        sessionScopeKey,
        sourceDetail: "object-regions-reorder",
        mutation: async (prep, writeOpts) => {
          const baseScene = prep.before ?? scene.data;
          const nextObjects = (baseScene?.objects ?? []).map((obj) => {
            if (obj.id !== objectId) return obj;
            const byId = new Map(
              (obj.regions ?? []).map((reg) => [String(reg.region_id ?? ""), reg]),
            );
            const nextRegions = reordered.flatMap((entry, idx) => {
              const existing = byId.get(entry.id);
              if (!existing) return [];
              return [
                {
                  ...existing,
                  priority: nextPriorities[idx]!,
                },
              ];
            });
            const rawTags = (obj as { tags?: unknown }).tags;
            const hasTagsArray = Array.isArray(rawTags);
            const existingTags = hasTagsArray ? (rawTags as string[]) : [];
            const nextTags = existingTags.includes("mesh:dirty")
              ? existingTags
              : [...existingTags, "mesh:dirty"];
            return {
              ...obj,
              regions: nextRegions,
              ...(hasTagsArray ? { tags: nextTags } : {}),
            };
          });
          return kernel.api.model.commitTransaction(
            {
              base_revision:
                writeOpts?.baseRevision ??
                prep.baseRevision ??
                scene.data?.revision ??
                null,
              kind: "merge_patch",
              merge_patch: {
                objects: toJsonValue(nextObjects),
              },
            },
            writeOpts?.sessionScopeKey
              ? { sessionScopeKey: writeOpts.sessionScopeKey }
              : undefined,
          );
        },
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
          title: "Precedence stack (higher priority wins)",
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
