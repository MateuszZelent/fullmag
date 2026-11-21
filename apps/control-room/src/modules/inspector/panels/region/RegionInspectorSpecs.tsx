"use client";

import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Copy,
  Gauge,
  Grid3x3,
  Layers,
  Magnet,
  Plus,
  RotateCcw,
  Shapes,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  MODEL_MATERIAL_FIELDS_PATH,
  MODEL_REALIZED_REGIONS_PATH,
  MODEL_REGION_DIAGNOSTICS_PATH,
  MODEL_REGIONS_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type {
  AuthoringTransactionRequest,
  FrozenSpinsSelectionExpression,
  SceneResource,
} from "@/kernel/api/apiTypes";

type SceneMaterialParameterAssignment = Extract<
  AuthoringTransactionRequest,
  { kind: "patch_object_material_fields" }
>["fields"][number];
type SceneMaterialParameterName = SceneMaterialParameterAssignment["parameter"];
type SceneObjectRegion = Extract<
  AuthoringTransactionRequest,
  { kind: "create_object_region" }
>["region"];
type SceneRegionShape = SceneObjectRegion["shape"];
type SceneObjectRegionPatch = Extract<
  AuthoringTransactionRequest,
  { kind: "patch_object_region" }
>["patch"];
import { useKernel } from "@/kernel/KernelContext";
import {
  publishCommittedSceneResource,
  useModelRegionDiagnosticsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useActiveLaneCapabilities } from "@/kernel/resources/useActiveLaneCapabilities";
import type { Selection } from "@/kernel/selection/selectionTypes";
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
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorFact,
  InspectorNotice,
  InspectorSpec,
} from "../../template";
import {
  ANISOTROPY_UNITS,
  buildObjectSelection,
  buildRegionSelection,
  buildRootSelection,
  DMI_UNITS,
  EXCHANGE_UNITS,
  fallbackRevision,
  formatLengthAuto,
  InspectorShortcutCards,
  LENGTH_UNITS,
  MAGNETIZATION_UNITS,
  normalizeVector3,
  type SceneObjectItem as SceneObject,
  SpecInspectorHost,
  vectorNorm,
  type InspectorShortcutCardItem,
} from "../model-roots/SpecInspectorHost";
import { SelectionExpressionBuilder } from "../selection/SelectionExpressionBuilder";

/* ── Canonical Mesh Lane Semantics (Single Source of Truth across Region Inspectors) ── */

export type CanonicalRegionMeshLane = "fem" | "fdm" | "pending";

export function resolveCanonicalRegionMeshLane(
  lane: string | null | undefined,
  scene: SceneResource | null | undefined,
): {
  lane: CanonicalRegionMeshLane;
  factValue: string | null;
  diagnosticLabel: string;
} {
  const studyDiscretization = (
    (scene?.study ?? null) as Record<string, unknown> | null
  )?.discretization;
  const resolved = lane ?? (typeof studyDiscretization === "string" ? studyDiscretization : null);
  if (resolved === "fem") {
    return {
      lane: "fem",
      factValue: "FEM conformal / projected",
      diagnosticLabel: "FEM tetrahedral support",
    };
  }
  if (resolved === "fdm") {
    return {
      lane: "fdm",
      factValue: "FDM voxel mask",
      diagnosticLabel: "FDM voxel support",
    };
  }
  return {
    lane: "pending",
    factValue: null,
    diagnosticLabel: "Pending study discretization",
  };
}

function extractSelectionTarget(selection: Selection): {
  objectId: string;
  regionId: string;
} {
  if (selection.ref?.type === "scene-object") {
    return {
      objectId: selection.ref.objectId,
      regionId: selection.ref.regionId ?? "",
    };
  }
  const nodeParts = (selection.nodeId ?? "").split(":");
  const regIdx = nodeParts.indexOf("regions");
  const parsedRegionId = regIdx >= 0 ? (nodeParts[regIdx + 1] ?? "") : "";
  return {
    objectId: selection.objectId ?? "",
    regionId: parsedRegionId,
  };
}

/* ── 1. RegionsCollectionInspectorPanel (`object.regions`) ── */

interface RegionPrecedenceItem {
  id: string;
  name: string;
  shapeKind: string;
  enabled: boolean;
  overrideSummary: string;
  raw: Record<string, unknown>;
}

interface RegionsCollectionDraft {
  objectId: string;
  objectName: string;
  highlightAllVolumes: boolean;
  items: readonly RegionPrecedenceItem[];
}

const REGION_SHAPE_STARTERS: readonly {
  kind: "box" | "cylinder" | "through_disk" | "layer_z_slice" | "half_space" | "boolean_expr";
  label: string;
}[] = [
  { kind: "box", label: "Box Sub-volume" },
  { kind: "cylinder", label: "Cylinder / Pillar" },
  { kind: "through_disk", label: "Through Disk" },
  { kind: "layer_z_slice", label: "Layer Z-Slice" },
  { kind: "half_space", label: "Half-Space" },
  { kind: "boolean_expr", label: "Boolean Selector" },
];

export function RegionsCollectionInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const [pendingDelete, setPendingDelete] = useState<RegionPrecedenceItem | null>(null);

  const { objectId } = extractSelectionTarget(selection);
  const sceneObj = useMemo(
    () => scene.data?.objects?.find((o) => o.id === objectId),
    [objectId, scene.data?.objects],
  );

  const items = useMemo<readonly RegionPrecedenceItem[]>(() => {
    const matFields = sceneObj?.material_parameter_fields ?? [];
    return (sceneObj?.regions ?? []).map((reg) => {
      const rec = reg as unknown as Record<string, unknown>;
      const id = String(rec.region_id ?? "");
      const shape = (rec.shape ?? null) as Record<string, unknown> | null;
      const shapeKind = String(shape?.kind ?? "box").replace(/_/g, " ");
      const fieldCount = matFields.filter((f) => f.region_id === id).length;
      const hasMesh = Boolean(rec.mesh_policy);
      const hasTex = Boolean(rec.initial_magnetization || rec.magnetization_ref);
      const badges: string[] = [];
      if (fieldCount > 0) badges.push(`${fieldCount} mat`);
      if (hasMesh) badges.push("mesh");
      if (hasTex) badges.push("texture");
      return {
        id,
        name: String(rec.name ?? id),
        shapeKind,
        enabled: rec.enabled !== false,
        overrideSummary: badges.length > 0 ? badges.join(" · ") : "Inherits object",
        raw: rec,
      };
    });
  }, [sceneObj?.material_parameter_fields, sceneObj?.regions]);

  const baseline = useMemo<RegionsCollectionDraft>(
    () => ({
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Object",
      highlightAllVolumes: false,
      items,
    }),
    [items, objectId, sceneObj?.name],
  );

  const invalidateRegions = useCallback(
    (rev?: number) => {
      const resolvedRev = fallbackRevision(rev);
      kernel.resources.invalidate(MODEL_SCENE_PATH, resolvedRev);
      kernel.resources.invalidate(MODEL_REGIONS_PATH, resolvedRev);
      kernel.resources.invalidate(MODEL_REALIZED_REGIONS_PATH, resolvedRev);
      kernel.resources.invalidate(MODEL_REGION_DIAGNOSTICS_PATH, resolvedRev);
    },
    [kernel.resources],
  );

  const handleCreateRegion = useCallback(
    async (
      starterKind: (typeof REGION_SHAPE_STARTERS)[number]["kind"],
      selectNode: (next: Omit<Selection, "moduleSource">) => void,
    ) => {
      if (!objectId) return;
      const index = items.length + 1;
      const regionId = `reg-${starterKind.replace(/_/g, "-")}-${index}`;
      const name = `Region ${index}`;
      let shape: SceneRegionShape;
      switch (starterKind) {
        case "cylinder":
        case "through_disk":
          shape = {
            kind: "cylinder",
            axis: [0, 0, 1],
            center: [0, 0, 0],
            radius: 25e-9,
            height: 10e-9,
          };
          break;
        case "layer_z_slice":
          shape = { kind: "box", center: [0, 0, 0], size: [1e-6, 1e-6, 5e-9] };
          break;
        case "half_space":
          shape = {
            kind: "csg",
            expression: { kind: "half_space", origin: [0, 0, 0], normal: [1, 0, 0] },
          };
          break;
        case "boolean_expr":
          shape = { kind: "box", center: [0, 0, 0], size: [50e-9, 50e-9, 10e-9] };
          break;
        default:
          shape = { kind: "box", center: [0, 0, 0], size: [50e-9, 50e-9, 10e-9] };
          break;
      }
      const tx = await kernel.api.model.createObjectRegion(
        objectId,
        {
          region_id: regionId,
          name,
          enabled: true,
          shape,
        },
        { baseRevision: scene.data?.revision ?? undefined },
      );
      publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
      invalidateRegions(tx.scene_revision);
      selectNode(buildRegionSelection(objectId, regionId, "object.region", name));
    },
    [invalidateRegions, items.length, kernel.api.model, kernel.resources, objectId, scene.data?.revision],
  );

  const handleReorder = useCallback(
    async (fromIdx: number, toIdx: number) => {
      if (!objectId || toIdx < 0 || toIdx >= items.length) return;
      const nextIds = items.map((it) => it.id);
      const [moved] = nextIds.splice(fromIdx, 1);
      if (!moved) return;
      nextIds.splice(toIdx, 0, moved);
      const tx = await kernel.api.model.commitTransaction({
        base_revision: scene.data?.revision ?? null,
        kind: "reorder_object_regions",
        object_id: objectId,
        region_ids: nextIds,
      });
      publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
      invalidateRegions(tx.scene_revision);
    },
    [invalidateRegions, items, kernel.api.model, kernel.resources, objectId, scene.data?.revision],
  );

  const handleToggleRegion = useCallback(
    async (regionId: string, enabled: boolean) => {
      if (!objectId) return;
      const tx = await kernel.api.model.patchObjectRegion(
        objectId,
        regionId,
        { enabled },
        { baseRevision: scene.data?.revision ?? undefined },
      );
      publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
      invalidateRegions(tx.scene_revision);
    },
    [invalidateRegions, kernel.api.model, kernel.resources, objectId, scene.data?.revision],
  );

  const handleDuplicateRegion = useCallback(
    async (item: RegionPrecedenceItem) => {
      if (!objectId) return;
      const copyId = `${item.id}-copy-${Date.now().toString(36).slice(-4)}`;
      const sourceRegion = sceneObj?.regions?.find((r) => r.region_id === item.id);
      const duplicated: SceneObjectRegion = sourceRegion
        ? {
            ...sourceRegion,
            region_id: copyId,
            name: `${item.name} Copy`,
          }
        : {
            region_id: copyId,
            name: `${item.name} Copy`,
            enabled: item.enabled,
            shape: { kind: "box", center: [0, 0, 0], size: [50e-9, 50e-9, 10e-9] },
          };
      const tx = await kernel.api.model.createObjectRegion(
        objectId,
        duplicated,
        { baseRevision: scene.data?.revision ?? undefined },
      );
      publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
      invalidateRegions(tx.scene_revision);
    },
    [invalidateRegions, kernel.api.model, kernel.resources, objectId, scene.data?.revision, sceneObj?.regions],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete || !objectId) return;
    const targetId = pendingDelete.id;
    setPendingDelete(null);
    const tx = await kernel.api.model.deleteObjectRegion(objectId, targetId, {
      baseRevision: scene.data?.revision ?? undefined,
    });
    publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
    invalidateRegions(tx.scene_revision);
  }, [invalidateRegions, kernel.api.model, kernel.resources, objectId, pendingDelete, scene.data?.revision]);

  const dependentCountForPending = useMemo(() => {
    if (!pendingDelete) return 0;
    const cpls = (scene.data?.couplings ?? []).filter((c) => {
      const rec = c as Record<string, unknown>;
      const a = (rec.endpoint_a ?? rec.side_a ?? null) as Record<string, unknown> | null;
      const b = (rec.endpoint_b ?? rec.side_b ?? null) as Record<string, unknown> | null;
      return a?.region_id === pendingDelete.id || b?.region_id === pendingDelete.id;
    }).length;
    return cpls;
  }, [pendingDelete, scene.data?.couplings]);

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
              ),
            },
            {
              key: "highlightAllVolumes",
              type: "switch",
              label: "Highlight all region volumes in 3D",
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
      handleToggleRegion,
      objectId,
      sceneObj,
    ],
  );

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
              Delete region &ldquo;{pendingDelete?.name ?? ""}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dependentCountForPending > 0
                ? `Warning: ${dependentCountForPending} surface coupling(s) reference this region and will become unresolved.`
                : "This removes the region volume and any local material, mesh, or texture overrides."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirmDelete()}>
              Delete region
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SpecInspectorHost>
  );
}

/* ── 2. ObjectRegionOverviewInspectorPanel (`object.region` + redirected `.geometry`, `.diagnostics`, `.regions`) ── */

type RegionShapeMode =
  | "box"
  | "cylinder"
  | "through_disk"
  | "layer_z_slice"
  | "half_space"
  | "boolean_expr";

interface RegionOverviewDraft {
  objectId: string;
  objectName: string;
  regionId: string;
  exists: boolean;
  name: string;
  enabled: boolean;
  precedenceRank: number;
  totalRegions: number;
  shapeMode: RegionShapeMode;
  center: readonly [number, number, number];
  size: readonly [number, number, number];
  radius: number;
  height: number;
  zMin: number;
  zMax: number;
  halfSpaceOrigin: readonly [number, number, number];
  halfSpaceNormal: readonly [number, number, number];
  selectorExpr: FrozenSpinsSelectionExpression;
  materialOverrideCount: number;
  hasMeshOverride: boolean;
  hasTextureOverride: boolean;
  diagnosticSummary: string;
}

export function ObjectRegionOverviewInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const regionDiagnostics = useModelRegionDiagnosticsResource();
  const activeLane = useActiveLaneCapabilities();

  const { objectId, regionId } = extractSelectionTarget(selection);
  const sceneObj = useMemo(
    () => scene.data?.objects?.find((o) => o.id === objectId),
    [objectId, scene.data?.objects],
  );
  const regions = useMemo(() => sceneObj?.regions ?? [], [sceneObj?.regions]);
  const regionIdx = useMemo(
    () => regions.findIndex((r) => r.region_id === regionId),
    [regionId, regions],
  );
  const regionRec = (regions[regionIdx] ?? null) as Record<string, unknown> | null;

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

  const baseline = useMemo<RegionOverviewDraft>(() => {
    const shape = (regionRec?.shape ?? null) as Record<string, unknown> | null;
    const csgExpr =
      shape?.kind === "csg" && shape.expression && typeof shape.expression === "object"
        ? (shape.expression as Record<string, unknown>)
        : null;
    const rawKind = String(csgExpr?.kind ?? shape?.kind ?? "box");
    const shapeMode: RegionShapeMode =
      rawKind === "cylinder" ||
      rawKind === "through_disk" ||
      rawKind === "layer_z_slice" ||
      rawKind === "half_space" ||
      rawKind === "boolean_expr"
        ? rawKind
        : "box";

    const readV3 = (v: unknown, fb: [number, number, number]): [number, number, number] =>
      Array.isArray(v) && v.length >= 3
        ? [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0]
        : fb;

    const matOverrideCount = (sceneObj?.material_parameter_fields ?? []).filter(
      (f) => f.region_id === regionId,
    ).length;

    const diagItems = (
      (regionDiagnostics.data ?? null) as { items?: Record<string, unknown>[] } | null
    )?.items;
    const matchedDiag = diagItems?.find(
      (d) => d.region_id === regionId && (!d.owner_object || d.owner_object === objectId),
    );
    const diagnosticSummary = matchedDiag?.status
      ? String(matchedDiag.status).replace(/_/g, " ")
      : meshLaneInfo.diagnosticLabel;

    return {
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Object",
      regionId,
      exists: Boolean(regionRec),
      name: String(regionRec?.name ?? selection.label ?? (regionId || "Region")),
      enabled: regionRec?.enabled !== false,
      precedenceRank: regionIdx >= 0 ? regionIdx + 1 : 1,
      totalRegions: regions.length,
      shapeMode,
      center: readV3(shape?.center, [0, 0, 0]),
      size: readV3(shape?.size, [50e-9, 50e-9, 10e-9]),
      radius: typeof shape?.radius === "number" ? shape.radius : 25e-9,
      height: typeof shape?.height === "number" ? shape.height : 10e-9,
      zMin: typeof shape?.z_min === "number" ? shape.z_min : -5e-9,
      zMax: typeof shape?.z_max === "number" ? shape.z_max : 5e-9,
      halfSpaceOrigin: readV3(shape?.origin, [0, 0, 0]),
      halfSpaceNormal: readV3(shape?.normal, [1, 0, 0]),
      selectorExpr:
        shape?.selector && typeof shape.selector === "object"
          ? (shape.selector as FrozenSpinsSelectionExpression)
          : { kind: "in_object", object_id: objectId || "object" },
      materialOverrideCount: matOverrideCount,
      hasMeshOverride: Boolean(regionRec?.mesh_policy),
      hasTextureOverride: Boolean(
        regionRec?.initial_magnetization || regionRec?.magnetization_ref,
      ),
      diagnosticSummary,
    };
  }, [
    meshLaneInfo.diagnosticLabel,
    objectId,
    regionDiagnostics.data,
    regionId,
    regionIdx,
    regionRec,
    regions.length,
    sceneObj?.material_parameter_fields,
    sceneObj?.name,
    selection.label,
  ]);

  const overrideCards = useMemo<readonly InspectorShortcutCardItem[]>(() => {
    if (!objectId || !regionId) return [];
    return [
      {
        id: "reg-material",
        title: "Material Overrides",
        subtitle: "Local Ms, Aex, α, Ku1, Ku2, Kc1 & DMI spatial profiles",
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
        subtitle: "Conformal / projected boundary & local h_max sizing",
        badge: baseline.hasMeshOverride ? "Override" : "Inherited",
        tone: baseline.hasMeshOverride ? "ok" : "neutral",
        selection: buildRegionSelection(objectId, regionId, "object.region.mesh", "Mesh"),
      },
      {
        id: "reg-texture",
        title: "Magnetic Texture",
        subtitle: "Regional m₀ preset or field-file override",
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
        ...(baseline.exists
          ? {
              deleteAction: {
                label: "Delete Region",
                confirmTitle: (d) => `Delete region "${d.name}"?`,
                confirmDescription:
                  "Deleting this region removes its spatial selector and all local material, mesh, and texture overrides.",
                onDelete: async (ctx) => {
                  const tx = await kernel.api.model.deleteObjectRegion(objectId, regionId, {
                    baseRevision: scene.data?.revision ?? undefined,
                  });
                  publishCommittedSceneResource(
                    kernel.resources,
                    tx.committed_scene,
                    tx.scene_revision,
                  );
                  kernel.resources.invalidate(MODEL_REGIONS_PATH, tx.scene_revision);
                  ctx.selectNode(buildObjectSelection(objectId, "object.regions", "Regions"));
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
        { id: "shape", label: "Selector", value: d.shapeMode.replace(/_/g, " ") },
        // Canonical meshLane: omitted when pending (never "unknown"!)
        { id: "support", label: "Support", value: meshLaneInfo.factValue, tone: "info" },
      ],
      modeTabs: [
        { id: "shape", label: "Shape & Precedence", icon: Shapes },
        { id: "diagnostics", label: "Diagnostics", icon: Gauge },
      ],
      notices: (): readonly InspectorNotice<RegionOverviewDraft>[] =>
        meshLaneInfo.lane === "pending"
          ? [
              {
                id: "region-pending-discretization",
                tone: "info",
                title: "Pending study discretization",
                text: "Spatial selector and precedence are authored in ProblemIR and realized once FEM or FDM discretization is selected.",
              },
            ]
          : [],
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
              key: "shapeMode",
              type: "select",
              label: "Volume geometry mode",
              structural: true,
              options: [
                { value: "box", label: "Box sub-volume" },
                { value: "cylinder", label: "Finite cylinder" },
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
              showWhen: (d) => d.shapeMode === "cylinder" || d.shapeMode === "through_disk",
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
              key: "zMin",
              type: "quantity",
              label: "Lower Z bound",
              symbol: <>z<sub>min</sub></>,
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
              symbol: <>z<sub>max</sub></>,
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
                `Rank #${d.precedenceRank} of ${d.totalRegions} (higher index overrides lower index)`,
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Region shape and precedence state match SceneDocument",
        lockReason: (d) => (!d.exists ? "Select an existing authored region." : null),
        onApply: async (draft) => {
          let shape: SceneRegionShape;
          switch (draft.shapeMode) {
            case "cylinder":
              shape = {
                kind: "cylinder",
                axis: [0, 0, 1],
                center: [...draft.center],
                radius: draft.radius,
                height: draft.height,
              };
              break;
            case "through_disk":
              shape = {
                kind: "cylinder",
                axis: [0, 0, 1],
                center: [draft.center[0], draft.center[1], 0],
                radius: draft.radius,
                height: 1,
              };
              break;
            case "layer_z_slice":
              shape = {
                kind: "box",
                center: [0, 0, (draft.zMin + draft.zMax) / 2],
                size: [1, 1, Math.max(draft.zMax - draft.zMin, 1e-12)],
              };
              break;
            case "half_space":
              shape = {
                kind: "csg",
                expression: {
                  kind: "half_space",
                  origin: [...draft.halfSpaceOrigin],
                  normal: normalizeVector3(draft.halfSpaceNormal, [1, 0, 0]),
                },
              };
              break;
            case "boolean_expr":
              shape = {
                kind: "csg",
                expression: {
                  kind: "boolean_expr",
                  selector: draft.selectorExpr,
                },
              };
              break;
            default:
              shape = {
                kind: "box",
                center: [...draft.center],
                size: [...draft.size],
              };
              break;
          }
          const patch: SceneObjectRegionPatch = {
            name: draft.name.trim(),
            enabled: draft.enabled,
            shape,
          };
          const tx = await kernel.api.model.patchObjectRegion(
            objectId,
            regionId,
            patch,
            { baseRevision: scene.data?.revision ?? undefined },
          );
          publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
          kernel.resources.invalidate(MODEL_REGIONS_PATH, tx.scene_revision);
          kernel.resources.invalidate(MODEL_REALIZED_REGIONS_PATH, tx.scene_revision);
          kernel.resources.invalidate(MODEL_REGION_DIAGNOSTICS_PATH, tx.scene_revision);
          return true;
        },
      },
    }),
    [
      baseline.exists,
      baseline.name,
      baseline.objectName,
      kernel.api.model,
      kernel.resources,
      meshLaneInfo.diagnosticLabel,
      meshLaneInfo.factValue,
      meshLaneInfo.lane,
      objectId,
      overrideCards,
      regionId,
      scene.data?.revision,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 3. ObjectRegionMagneticParametersInspectorPanel (`object.region.magnetic-parameters`) ── */

export type RegionFieldProfileMode = "inherited" | "constant" | "linear_gradient" | "radial" | "function";

interface RegionMaterialOverridesDraft {
  objectId: string;
  objectName: string;
  regionId: string;
  regionName: string;
  exists: boolean;
  // Parent object baseline constants for clear "Inherited (<value>)" display
  parentMs: number;
  parentAex: number;
  parentAlpha: number;
  parentKu1: number;
  parentKu2: number;
  parentDind: number;
  parentDbulk: number;
  // Per-parameter override mode & values (including Ku2!)
  msMode: RegionFieldProfileMode;
  msValue: number;
  msEndValue: number;
  msDirection: readonly [number, number, number];
  aexMode: RegionFieldProfileMode;
  aexValue: number;
  alphaMode: RegionFieldProfileMode;
  alphaValue: number;
  ku1Mode: RegionFieldProfileMode;
  ku1Value: number;
  ku2Mode: RegionFieldProfileMode;
  ku2Value: number;
  axisOverridden: boolean;
  anisotropyAxis: readonly [number, number, number];
  dindMode: RegionFieldProfileMode;
  dindValue: number;
  dbulkMode: RegionFieldProfileMode;
  dbulkValue: number;
  transitionKind: "sharp" | "metric_width" | "mesh_relative";
  transitionWidth: number;
  preservedFunctionAssignments: readonly SceneMaterialParameterAssignment[];
}

function readRegionFieldEntry(
  fields: readonly Record<string, unknown>[],
  regionId: string,
  objectId: string,
  paramName: SceneMaterialParameterName,
  fallbackVal: number,
): {
  mode: RegionFieldProfileMode;
  val: number;
  endVal: number;
  dir: [number, number, number];
  rawFunction: SceneMaterialParameterAssignment | null;
} {
  const found = fields.find(
    (f) => f.region_id === regionId && String(f.parameter ?? "").toLowerCase() === paramName,
  );
  if (!found) {
    return {
      mode: "inherited",
      val: fallbackVal,
      endVal: fallbackVal,
      dir: [1, 0, 0],
      rawFunction: null,
    };
  }
  const v = (found.value ?? null) as Record<string, unknown> | null;
  const kind = String(v?.kind ?? "constant");
  if (kind === "function") {
    const fnPayload =
      v?.function && typeof v.function === "object" && !Array.isArray(v.function)
        ? (v.function as Record<string, unknown>)
        : {};
    return {
      mode: "function",
      val: fallbackVal,
      endVal: fallbackVal,
      dir: [1, 0, 0],
      rawFunction: {
        assignment_id:
          typeof found.assignment_id === "string"
            ? found.assignment_id
            : `field-${regionId}-${paramName}`,
        owner_object:
          typeof found.owner_object === "string" ? found.owner_object : objectId,
        parameter: paramName,
        region_id: regionId,
        value: {
          kind: "function",
          function: fnPayload,
          ...(typeof v?.unit === "string" ? { unit: v.unit } : {}),
        },
      },
    };
  }
  if (kind === "linear") {
    const base = typeof v?.base === "number" ? v.base : fallbackVal;
    const gradRaw = Array.isArray(v?.gradient) ? v.gradient : [0, 0, 0];
    const gx = Number(gradRaw[0]) || 0;
    const gy = Number(gradRaw[1]) || 0;
    const gz = Number(gradRaw[2]) || 0;
    const mag = Math.hypot(gx, gy, gz);
    const dir: [number, number, number] =
      mag > 1e-30 ? [gx / mag, gy / mag, gz / mag] : [1, 0, 0];
    return {
      mode: "linear_gradient",
      val: base,
      endVal: base + mag,
      dir,
      rawFunction: null,
    };
  }
  if (kind === "linear_gradient") {
    const dir = Array.isArray(v?.direction) && v.direction.length >= 3
      ? ([Number(v.direction[0]) || 1, Number(v.direction[1]) || 0, Number(v.direction[2]) || 0] as [number, number, number])
      : ([1, 0, 0] as [number, number, number]);
    return {
      mode: "linear_gradient",
      val: typeof v?.start_value === "number" ? v.start_value : fallbackVal,
      endVal: typeof v?.end_value === "number" ? v.end_value : fallbackVal,
      dir,
      rawFunction: null,
    };
  }
  if (kind === "radial") {
    const insideVal =
      typeof v?.inside === "number"
        ? v.inside
        : typeof v?.center_value === "number"
          ? v.center_value
          : fallbackVal;
    const outsideVal =
      typeof v?.outside === "number"
        ? v.outside
        : typeof v?.edge_value === "number"
          ? v.edge_value
          : fallbackVal;
    return {
      mode: "radial",
      val: insideVal,
      endVal: outsideVal,
      dir: [1, 0, 0],
      rawFunction: null,
    };
  }
  return {
    mode: "constant",
    val: typeof v?.value === "number" ? v.value : fallbackVal,
    endVal: fallbackVal,
    dir: [1, 0, 0],
    rawFunction: null,
  };
}

export function ObjectRegionMagneticParametersInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const { objectId, regionId } = extractSelectionTarget(selection);

  const sceneObj = useMemo(
    () => scene.data?.objects?.find((o) => o.id === objectId),
    [objectId, scene.data?.objects],
  );
  const regionObj = useMemo(
    () => sceneObj?.regions?.find((r) => r.region_id === regionId),
    [regionId, sceneObj?.regions],
  );
  const parentMat = useMemo(() => {
    const ref = sceneObj?.material_ref;
    return ref ? scene.data?.materials?.find((m) => m.id === ref) : undefined;
  }, [scene.data?.materials, sceneObj?.material_ref]);

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

    const allFields = (sceneObj?.material_parameter_fields ?? []) as unknown as Record<
      string,
      unknown
    >[];
    const msEntry = readRegionFieldEntry(allFields, regionId, objectId, "ms", parentMs);
    const aexEntry = readRegionFieldEntry(allFields, regionId, objectId, "aex", parentAex);
    const alphaEntry = readRegionFieldEntry(allFields, regionId, objectId, "alpha", parentAlpha);
    const ku1Entry = readRegionFieldEntry(allFields, regionId, objectId, "ku1", parentKu1);
    const ku2Entry = readRegionFieldEntry(allFields, regionId, objectId, "ku2", parentKu2);
    const dindEntry = readRegionFieldEntry(allFields, regionId, objectId, "dind", parentDind);
    const dbulkEntry = readRegionFieldEntry(allFields, regionId, objectId, "dbulk", parentDbulk);

    const axisField = allFields.find(
      (f) => f.region_id === regionId && f.parameter === "anisotropy_axis",
    );
    const axisFieldVal = (axisField?.value ?? null) as Record<string, unknown> | null;
    const axisVal = Array.isArray(axisFieldVal?.value)
      ? axisFieldVal.value
      : axisFieldVal?.direction;
    const parsedAxis: [number, number, number] =
      Array.isArray(axisVal) && axisVal.length >= 3
        ? [Number(axisVal[0]) || 0, Number(axisVal[1]) || 0, Number(axisVal[2]) || 1]
        : [0, 0, 1];

    const preservedFunctions = [
      msEntry.rawFunction,
      aexEntry.rawFunction,
      alphaEntry.rawFunction,
      ku1Entry.rawFunction,
      ku2Entry.rawFunction,
      dindEntry.rawFunction,
      dbulkEntry.rawFunction,
    ].filter((x): x is SceneMaterialParameterAssignment => x !== null);

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
      msMode: msEntry.mode,
      msValue: msEntry.val,
      msEndValue: msEntry.endVal,
      msDirection: msEntry.dir,
      aexMode: aexEntry.mode,
      aexValue: aexEntry.val,
      alphaMode: alphaEntry.mode,
      alphaValue: alphaEntry.val,
      ku1Mode: ku1Entry.mode,
      ku1Value: ku1Entry.val,
      ku2Mode: ku2Entry.mode,
      ku2Value: ku2Entry.val,
      axisOverridden: Boolean(axisField),
      anisotropyAxis: parsedAxis,
      dindMode: dindEntry.mode,
      dindValue: dindEntry.val,
      dbulkMode: dbulkEntry.mode,
      dbulkValue: dbulkEntry.val,
      transitionKind: "sharp",
      transitionWidth: 5e-9,
      preservedFunctionAssignments: preservedFunctions,
    };
  }, [objectId, parentMat?.properties, regionId, regionObj, sceneObj]);

  const countActiveOverrides = (d: RegionMaterialOverridesDraft): number => {
    let n = 0;
    if (d.msMode !== "inherited") n += 1;
    if (d.aexMode !== "inherited") n += 1;
    if (d.alphaMode !== "inherited") n += 1;
    if (d.ku1Mode !== "inherited") n += 1;
    if (d.ku2Mode !== "inherited") n += 1;
    if (d.axisOverridden) n += 1;
    if (d.dindMode !== "inherited") n += 1;
    if (d.dbulkMode !== "inherited") n += 1;
    return n;
  };

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
            onSelect: (ctx) =>
              ctx.patchDraft({
                msMode: "inherited",
                aexMode: "inherited",
                alphaMode: "inherited",
                ku1Mode: "inherited",
                ku2Mode: "inherited",
                axisOverridden: false,
                dindMode: "inherited",
                dbulkMode: "inherited",
              }),
          },
        ],
      },
      identity: {
        domain: "material",
        icon: Magnet,
        title: (d) => `${d.regionName} · Material`,
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
      ],
      sections: [
        {
          id: "region-mat-exchange-damping",
          title: "Magnetization, exchange & damping overrides",
          icon: Magnet,
          defaultOpen: true,
          rows: [
            {
              key: "msMode",
              type: "select",
              label: `Ms (${(baseline.parentMs / 1e3).toFixed(0)} kA/m on Object)`,
              structural: true,
              options: [
                { value: "inherited", label: "Inherited from Object" },
                { value: "constant", label: "Constant regional override" },
                { value: "linear_gradient", label: "Linear spatial gradient" },
                { value: "radial", label: "Radial profile" },
                ...(baseline.msMode === "function"
                  ? [{ value: "function", label: "Python function (preserved)" }]
                  : []),
              ],
            },
            {
              key: "msValue",
              type: "quantity",
              label: "Regional Ms (or start value)",
              symbol: <>M<sub>s</sub></>,
              units: MAGNETIZATION_UNITS,
              defaultDisplayUnit: "kA/m",
              min: 0,
              showWhen: (d) =>
                d.msMode === "constant" ||
                d.msMode === "linear_gradient" ||
                d.msMode === "radial",
            },
            {
              key: "msEndValue",
              type: "quantity",
              label: "Gradient / edge Ms",
              symbol: <>M<sub>s,end</sub></>,
              units: MAGNETIZATION_UNITS,
              defaultDisplayUnit: "kA/m",
              min: 0,
              showWhen: (d) => d.msMode === "linear_gradient" || d.msMode === "radial",
            },
            {
              key: "msDirection",
              type: "vector3",
              label: "Gradient direction",
              axisPresets: true,
              normalizeAction: true,
              showWhen: (d) => d.msMode === "linear_gradient",
            },
            {
              key: "aexMode",
              type: "segmented",
              label: `Aex (${(baseline.parentAex * 1e12).toFixed(1)} pJ/m on Object)`,
              structural: true,
              options: [
                { value: "inherited", label: "Inherited" },
                { value: "constant", label: "Override" },
              ],
            },
            {
              key: "aexValue",
              type: "quantity",
              label: "Regional exchange stiffness",
              symbol: <>A<sub>ex</sub></>,
              units: EXCHANGE_UNITS,
              defaultDisplayUnit: "pJ/m",
              min: 0,
              showWhen: (d) => d.aexMode === "constant",
            },
            {
              key: "alphaMode",
              type: "segmented",
              label: `Gilbert α (${baseline.parentAlpha} on Object)`,
              structural: true,
              options: [
                { value: "inherited", label: "Inherited" },
                { value: "constant", label: "Override" },
              ],
            },
            {
              key: "alphaValue",
              type: "number",
              label: "Regional Gilbert damping",
              symbol: <>&alpha;</>,
              min: 0,
              step: 0.001,
              showWhen: (d) => d.alphaMode === "constant",
            },
          ],
          footer: (ctx) =>
            countActiveOverrides(ctx.draft) > 0 ? (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() =>
                  ctx.patchDraft({
                    msMode: "inherited",
                    aexMode: "inherited",
                    alphaMode: "inherited",
                    ku1Mode: "inherited",
                    ku2Mode: "inherited",
                    axisOverridden: false,
                    dindMode: "inherited",
                    dbulkMode: "inherited",
                  })
                }
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
            {
              key: "ku1Mode",
              type: "segmented",
              label: "First-order uniaxial Ku1",
              structural: true,
              options: [
                { value: "inherited", label: "Inherited" },
                { value: "constant", label: "Override" },
              ],
            },
            {
              key: "ku1Value",
              type: "quantity",
              label: "Regional Ku1",
              symbol: <>K<sub>u1</sub></>,
              units: ANISOTROPY_UNITS,
              defaultDisplayUnit: "kJ/m\u00b3",
              showWhen: (d) => d.ku1Mode === "constant",
            },
            {
              key: "ku2Mode",
              type: "segmented",
              label: "Second-order uniaxial Ku2",
              structural: true,
              options: [
                { value: "inherited", label: "Inherited" },
                { value: "constant", label: "Override" },
              ],
            },
            {
              key: "ku2Value",
              type: "quantity",
              label: "Regional Ku2",
              symbol: <>K<sub>u2</sub></>,
              units: ANISOTROPY_UNITS,
              defaultDisplayUnit: "kJ/m\u00b3",
              showWhen: (d) => d.ku2Mode === "constant",
            },
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
              key: "dindMode",
              type: "segmented",
              label: "Interfacial DMI (Dind)",
              structural: true,
              options: [
                { value: "inherited", label: "Inherited" },
                { value: "constant", label: "Override" },
              ],
            },
            {
              key: "dindValue",
              type: "quantity",
              label: "Regional Dind",
              symbol: <>D<sub>ind</sub></>,
              units: DMI_UNITS,
              defaultDisplayUnit: "mJ/m\u00b2",
              showWhen: (d) => d.dindMode === "constant",
            },
            {
              key: "dbulkMode",
              type: "segmented",
              label: "Bulk DMI (Dbulk)",
              structural: true,
              options: [
                { value: "inherited", label: "Inherited" },
                { value: "constant", label: "Override" },
              ],
            },
            {
              key: "dbulkValue",
              type: "quantity",
              label: "Regional Dbulk",
              symbol: <>D<sub>bulk</sub></>,
              units: DMI_UNITS,
              defaultDisplayUnit: "mJ/m\u00b2",
              showWhen: (d) => d.dbulkMode === "constant",
            },
            {
              key: "transitionKind",
              type: "segmented",
              label: "Boundary transition",
              structural: true,
              options: [
                { value: "sharp", label: "Sharp" },
                { value: "metric_width", label: "Metric width" },
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
              showWhen: (d) => d.transitionKind === "metric_width",
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Regional material assignments match SceneDocument",
        lockReason: (d) => (!d.exists ? "Select an existing authored region." : null),
        onApply: async (draft) => {
          const otherRegionFields: SceneMaterialParameterAssignment[] = (
            sceneObj?.material_parameter_fields ?? []
          ).filter((f) => f.region_id !== regionId);
          const nextRegionFields: SceneMaterialParameterAssignment[] = [
            ...draft.preservedFunctionAssignments,
          ];

          const pushScalar = (
            param: SceneMaterialParameterName,
            unit: string,
            mode: RegionFieldProfileMode,
            val: number,
            endVal = val,
            dir: readonly [number, number, number] = [1, 0, 0],
          ) => {
            if (mode === "inherited" || mode === "function") return;
            const assignmentId = `field-${regionId}-${param}`;
            if (mode === "linear_gradient") {
              const unitDir = normalizeVector3(dir, [1, 0, 0]);
              const delta = endVal - val;
              nextRegionFields.push({
                assignment_id: assignmentId,
                owner_object: objectId,
                region_id: regionId,
                parameter: param,
                value: {
                  kind: "linear",
                  unit,
                  base: val,
                  gradient: [unitDir[0] * delta, unitDir[1] * delta, unitDir[2] * delta],
                },
              });
            } else if (mode === "radial") {
              nextRegionFields.push({
                assignment_id: assignmentId,
                owner_object: objectId,
                region_id: regionId,
                parameter: param,
                value: {
                  kind: "radial",
                  unit,
                  center: [0, 0, 0],
                  inside: val,
                  outside: endVal,
                  radius: 1e-7,
                },
              });
            } else {
              nextRegionFields.push({
                assignment_id: assignmentId,
                owner_object: objectId,
                region_id: regionId,
                parameter: param,
                value: { kind: "constant", unit, value: val },
              });
            }
          };

          pushScalar("ms", "A/m", draft.msMode, draft.msValue, draft.msEndValue, draft.msDirection);
          pushScalar("aex", "J/m", draft.aexMode, draft.aexValue);
          pushScalar("alpha", "dimensionless", draft.alphaMode, draft.alphaValue);
          pushScalar("ku1", "J/m^3", draft.ku1Mode, draft.ku1Value);
          pushScalar("ku2", "J/m^3", draft.ku2Mode, draft.ku2Value);
          pushScalar("dind", "J/m^2", draft.dindMode, draft.dindValue);
          pushScalar("dbulk", "J/m^2", draft.dbulkMode, draft.dbulkValue);

          if (draft.axisOverridden) {
            nextRegionFields.push({
              assignment_id: `field-${regionId}-anisotropy-axis`,
              owner_object: objectId,
              region_id: regionId,
              parameter: "anisotropy_axis",
              value: {
                kind: "constant",
                value: normalizeVector3(draft.anisotropyAxis, [0, 0, 1]),
              },
            });
          }

          const tx = await kernel.api.model.patchObjectMaterialFields(
            objectId,
            [...otherRegionFields, ...nextRegionFields],
            { baseRevision: scene.data?.revision ?? undefined },
          );
          publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
          kernel.resources.invalidate(MODEL_MATERIAL_FIELDS_PATH, tx.scene_revision);
          kernel.resources.invalidate(MODEL_REGIONS_PATH, tx.scene_revision);
          return true;
        },
      },
    }),
    [
      baseline.msMode,
      baseline.objectName,
      baseline.parentAex,
      baseline.parentAlpha,
      baseline.parentMs,
      baseline.regionName,
      kernel.api.model,
      kernel.resources,
      objectId,
      regionId,
      scene.data?.revision,
      sceneObj?.material_parameter_fields,
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
  realizationMode: "inherit" | "conformal" | "project";
  overrideMaxElementSize: boolean;
  maxElementSize: number;
  overlapPolicy: "precedence" | "finest_hmax";
}

export function ObjectRegionMeshInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const activeLane = useActiveLaneCapabilities();
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

  const baseline = useMemo<RegionMeshPolicyDraft>(() => {
    const policy = (regionRec?.mesh_policy ?? null) as Record<string, unknown> | null;
    const rawMode = String(policy?.realization_policy ?? policy?.mode ?? "inherit");
    const realizationMode =
      rawMode === "conformal" || rawMode === "project" ? rawMode : "inherit";
    const hMax =
      typeof policy?.maximum_element_size === "number" ? policy.maximum_element_size : null;
    return {
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Object",
      regionId,
      regionName: String(regionRec?.name ?? (regionId || "Region")),
      exists: Boolean(regionRec),
      realizationMode,
      overrideMaxElementSize: hMax !== null,
      maxElementSize: hMax ?? 4e-9,
      overlapPolicy:
        policy?.overlap_policy === "finest_hmax" ? "finest_hmax" : "precedence",
    };
  }, [objectId, regionId, regionRec, sceneObj?.name]);

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
      },
      identity: {
        domain: "mesh",
        icon: Grid3x3,
        title: (d) => `${d.regionName} · Mesh`,
        kindLabel: "Regional discretization policy",
        entityId: regionId || undefined,
        statePill: (d) =>
          d.overrideMaxElementSize || d.realizationMode !== "inherit"
            ? { tone: "ok", label: "Override" }
            : { tone: "neutral", label: "Inherited" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "support", label: "Support", value: meshLaneInfo.factValue, tone: "info" },
        {
          id: "hmax",
          label: "Local h_max",
          value: d.overrideMaxElementSize ? formatLengthAuto(d.maxElementSize) : "Inherits Object",
        },
      ],
      notices: (): readonly InspectorNotice<RegionMeshPolicyDraft>[] =>
        meshLaneInfo.lane === "pending"
          ? [
              {
                id: "pending-mesh-lane",
                tone: "info",
                title: "Pending study discretization",
                text: "Authored region mesh overrides are saved in ProblemIR and realized once FEM or FDM discretization is selected on Study.",
              },
            ]
          : [],
      sections: [
        {
          id: "region-mesh-policy",
          title: "Boundary realization & local sizing",
          icon: Grid3x3,
          defaultOpen: true,
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
              key: "overrideMaxElementSize",
              type: "switch",
              label: "Override maximum element size (h_max)",
              structural: true,
            },
            {
              key: "maxElementSize",
              type: "quantity",
              label: "Maximum element size",
              symbol: <>h<sub>max</sub></>,
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.overrideMaxElementSize,
              validate: (v) => (v > 0 ? null : "h_max must be strictly positive."),
            },
            {
              key: "overlapPolicy",
              type: "segmented",
              label: "Overlap conflict resolution",
              options: [
                { value: "precedence", label: "Precedence order" },
                { value: "finest_hmax", label: "Finest h_max wins" },
              ],
            },
          ],
          footer: (ctx) =>
            ctx.draft.overrideMaxElementSize || ctx.draft.realizationMode !== "inherit" ? (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() =>
                  ctx.patchDraft({
                    realizationMode: "inherit",
                    overrideMaxElementSize: false,
                  })
                }
              >
                <RotateCcw aria-hidden="true" size={12} />
                <span>Reset to Inherited</span>
              </Button>
            ) : null,
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Regional mesh policy matches SceneDocument",
        lockReason: (d) => (!d.exists ? "Select an existing authored region." : null),
        onApply: async (draft) => {
          const regionPatch: SceneObjectRegionPatch = {
            realization_policy: draft.realizationMode,
            mesh_policy: draft.overrideMaxElementSize
              ? { maximum_element_size: draft.maxElementSize }
              : null,
          };
          const tx = await kernel.api.model.patchObjectRegion(
            objectId,
            regionId,
            regionPatch,
            { baseRevision: scene.data?.revision ?? undefined },
          );
          publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
          kernel.resources.invalidate(MODEL_REGIONS_PATH, tx.scene_revision);
          kernel.resources.invalidate(MODEL_REALIZED_REGIONS_PATH, tx.scene_revision);
          return true;
        },
      },
    }),
    [
      baseline.objectName,
      baseline.regionName,
      kernel.api.model,
      kernel.resources,
      meshLaneInfo.factValue,
      meshLaneInfo.lane,
      objectId,
      regionId,
      scene.data?.revision,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
