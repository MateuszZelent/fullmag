"use client";

import {
  Copy,
  Gauge,
  Hammer,
  Layers,
  Shapes,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
} from "react";
import type { FrozenSpinsSelectionExpression } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  useModelRegionDiagnosticsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useActiveLaneCapabilities } from "@/kernel/resources/useActiveLaneCapabilities";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Badge } from "@/shared/ui/Badge";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorFact, InspectorNotice, InspectorSpec } from "../../../template";
import {
  buildObjectSelection,
  buildRegionSelection,
  InspectorShortcutCards,
  LENGTH_UNITS,
  type InspectorShortcutCardItem,
  SpecInspectorHost,
  vectorNorm,
} from "../../../panels/model-roots/SpecInspectorHost";
import { findLastRegionSelection } from "../../../panels/RegionsListPanelModel";
import { SelectionExpressionBuilder } from "../../../panels/selection/SelectionExpressionBuilder";
import {
  cloneRegionForDuplicate,
  executeRegionMutationWithHistory,
  extractRegionDiagnosticsForTarget,
  extractSelectionTarget,
  finalizeRegionAuthoringCommit,
  formatDiagnosticNoticeText,
  formatRegionCapabilityLabel,
  hasRegionTextureOverride,
  parseRegionShapeState,
  resolveCanonicalRegionMeshLane,
  resolveCouplingDependenciesForRegion,
  resolveOwnerBoundsForSceneObject,
  serializeRegionShapeState,
  useModelCouplingsResourceSafe,
  useRegionSessionScopeKey,
  validateShapeAgainstOwnerBounds,
  type RegionShapeMode,
  type SceneObjectRegionPatch,
  type SceneRegionFrame,
} from "../../../panels/region/regionInspectorHelpers";
import { formatVectorSpanAuto } from "./regionShared";

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

    const sortedRegionIds = regions
      .map((r, originalIndex) => {
        const rec = r as unknown as Record<string, unknown>;
        const p =
          typeof rec.priority === "number" && Number.isFinite(rec.priority)
            ? Math.trunc(rec.priority)
            : 0;
        return { id: String(rec.region_id ?? ""), priority: p, originalIndex };
      })
      .sort((a, b) => b.priority - a.priority || a.originalIndex - b.originalIndex)
      .map((entry) => entry.id);
    const sortedIdx = sortedRegionIds.indexOf(regionId);

    return {
      objectId,
      objectName: sceneObj?.name?.trim() || objectId || "Object",
      regionId,
      exists: Boolean(regionRec),
      name: String(regionRec?.name ?? selection.label ?? (regionId || "Region")),
      enabled: regionRec?.enabled !== false,
      priority,
      frame,
      precedenceRank: sortedIdx >= 0 ? sortedIdx + 1 : regionIdx >= 0 ? regionIdx + 1 : 1,
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
    regions,
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
