"use client";

import {
  BookOpen,
  Box,
  Compass,
  Layers,
  Magnet,
  Plus,
  Shield,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
} from "react";
import { MODEL_FROZEN_SPINS_PATH } from "@/kernel/api/apiPaths";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { MaterialLibraryDialog } from "@/kernel/layout/MaterialLibraryDialog";
import { useKernel } from "@/kernel/KernelContext";
import { useFrozenSpinsCollectionResource } from "@/kernel/resources/frozenSpinsResources";
import { publishCommittedSceneResource, useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Switch } from "@/shared/ui/Switch";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorFact, InspectorSpec } from "../../template";
import {
  buildBuilderPrimitiveSelection,
  buildObjectSelection,
  buildRootSelection,
  fallbackRevision,
  InspectorShortcutCards,
  SpecInspectorHost,
} from "../../panels/model-roots/SpecInspectorHost";
import { isAirboxSceneObject, isUnscopedFrozenSelector } from "./modelScopeShared";

/* ── 3. ObjectsRootInspectorPanel (`objects.root`) ── */

interface ObjectsRootRow {
  id: string;
  name: string;
  roleLabel: string;
  geometryKind: string;
  materialLabel: string;
  visible: boolean;
  objectRole?: "antenna" | "auxiliary" | "magnet";
}

interface ObjectsRootDraft {
  rows: readonly ObjectsRootRow[];
  magneticCount: number;
  conductorCount: number;
}

const PRIMITIVE_STARTERS: readonly { slug: string; label: string }[] = [
  { slug: "box", label: "Box" },
  { slug: "cylinder", label: "Cylinder" },
  { slug: "ellipsoid", label: "Ellipsoid" },
  { slug: "sphere", label: "Sphere" },
  { slug: "tube", label: "Tube" },
  { slug: "cone", label: "Cone" },
  { slug: "torus", label: "Torus" },
  { slug: "arch_waveguide", label: "Arch Waveguide" },
  { slug: "polygon_extrusion", label: "Polygon Extrusion" },
  { slug: "imported_mesh", label: "Imported Mesh" },
];

export function ObjectsRootInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();

  const materialsById = useMemo(() => {
    const map = new Map<string, string>();
    for (const mat of scene.data?.materials ?? []) {
      map.set(mat.id, mat.name || mat.id);
    }
    return map;
  }, [scene.data?.materials]);

  const rows = useMemo<readonly ObjectsRootRow[]>(() => {
    return (scene.data?.objects ?? [])
      .filter((o) => !isAirboxSceneObject(o))
      .map((obj) => {
        const geom = (obj.geometry ?? null) as Record<string, unknown> | null;
        const geometryKind =
          (typeof geom?.geometry_kind === "string" && geom.geometry_kind) ||
          (typeof geom?.kind === "string" && geom.kind) ||
          "Solid";
        const rawRole = obj.role?.trim().toLowerCase() ?? "magnet";
        const roleLabel =
          rawRole === "antenna"
            ? "Antenna"
            : rawRole === "conductor"
              ? "Conductor"
              : rawRole === "auxiliary" || rawRole === "spacer_dielectric"
                ? "Dielectric"
                : "Magnetic";
        const matRef = obj.material_ref?.trim() ?? "";
        const materialLabel = matRef ? materialsById.get(matRef) ?? matRef : "Unassigned";
        return {
          id: obj.id,
          name: obj.name?.trim() || obj.id,
          roleLabel,
          geometryKind,
          materialLabel,
          visible: obj.visible !== false,
          objectRole:
            rawRole === "antenna" ? "antenna" : rawRole === "auxiliary" ? "auxiliary" : "magnet",
        };
      });
  }, [materialsById, scene.data?.objects]);

  const baseline = useMemo<ObjectsRootDraft>(() => {
    const magneticCount = rows.filter((r) => r.roleLabel === "Magnetic").length;
    const conductorCount = rows.length - magneticCount;
    return { rows, magneticCount, conductorCount };
  }, [rows]);

  const toggleObjectVisibility = useCallback(
    async (objectId: string, nextVisible: boolean) => {
      const updated = await kernel.api.model.patchObject(objectId, {
        base_revision: scene.data?.revision ?? null,
        visible: nextVisible,
      });
      publishCommittedSceneResource(
        kernel.resources,
        updated,
        fallbackRevision(updated.revision),
      );
    },
    [kernel.api.model, kernel.resources, scene.data?.revision],
  );

  const spec = useMemo<InspectorSpec<ObjectsRootDraft>>(
    () => ({
      id: "model.objects-root",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          { id: "objects", label: "Objects" },
        ],
        canFitView: rows.length > 0,
        searchable: false,
      },
      identity: {
        domain: "geometry",
        icon: Layers,
        title: () => "Objects",
        kindLabel: "Scene object collection",
        entityId: "model:objects",
        statePill: (draft) =>
          draft.rows.length === 0
            ? { tone: "neutral", label: "0 objects" }
            : { tone: "ok", label: `${draft.rows.length} authored` },
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "total", label: "Total", value: String(draft.rows.length) },
        { id: "magnetic", label: "Magnetic", value: String(draft.magneticCount) },
        {
          id: "other",
          label: "Conductors & antennas",
          value: draft.conductorCount > 0 ? String(draft.conductorCount) : null,
        },
      ],
      sections: [
        {
          id: "objects-create",
          title: "Add geometry primitive",
          icon: Plus,
          defaultOpen: true,
          summary: () => "10 parametric & imported primitives",
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="grid grid-cols-2 gap-1.5" data-slot="primitive-creator-grid">
                  {PRIMITIVE_STARTERS.map((prim) => (
                    <Button
                      key={prim.slug}
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        ctx.selectNode(
                          buildBuilderPrimitiveSelection(prim.slug, `New ${prim.label}`),
                        )
                      }
                    >
                      <Plus aria-hidden="true" size={12} />
                      <span className="truncate">{prim.label}</span>
                    </Button>
                  ))}
                </div>
              ),
            },
          ],
        },
        {
          id: "objects-table",
          title: "Authored scene objects",
          icon: Box,
          defaultOpen: true,
          summary: (draft) => `${draft.rows.length} objects`,
          emptyState: (draft) =>
            draft.rows.length === 0
              ? {
                  icon: Box,
                  title: "No objects in session",
                  description:
                    "Choose any primitive above to preview and commit a new 3D object into the scene.",
                  action: {
                    label: "Create Box",
                    onRun: (ctx) =>
                      ctx.selectNode(buildBuilderPrimitiveSelection("box", "New Box")),
                  },
                }
              : null,
          rows: [
            {
              type: "table",
              wide: true,
              showWhen: (d) => d.rows.length > 0,
              rowKey: (rawRow) => (rawRow as ObjectsRootRow).id,
              rows: (d) => d.rows,
              onSelectRow: (rawRow, ctx) => {
                const row = rawRow as ObjectsRootRow;
                ctx.selectNode(
                  buildObjectSelection(row.id, "object.root", row.name, {
                    objectRole: row.objectRole,
                  }),
                );
              },
              columns: [
                {
                  id: "name",
                  header: "Object",
                  renderCell: (rawRow) => {
                    const row = rawRow as ObjectsRootRow;
                    return (
                      <div className="flex flex-col">
                        <span className="font-medium text-[var(--fm-text)]">{row.name}</span>
                        <span className="text-xs text-[var(--fm-text-muted)]">
                          {row.roleLabel} · {row.geometryKind}
                        </span>
                      </div>
                    );
                  },
                },
                {
                  id: "material",
                  header: "Material",
                  renderCell: (rawRow) => (
                    <span className="text-xs text-[var(--fm-text-muted)]">
                      {(rawRow as ObjectsRootRow).materialLabel}
                    </span>
                  ),
                },
                {
                  id: "visible",
                  header: "Visible",
                  align: "right",
                  renderCell: (rawRow) => {
                    const row = rawRow as ObjectsRootRow;
                    return (
                      <Switch
                        aria-label={`Toggle visibility for ${row.name}`}
                        checked={row.visible}
                        onCheckedChange={(checked) => {
                          void toggleObjectVisibility(row.id, checked);
                        }}
                      />
                    );
                  },
                },
              ],
            },
          ],
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Select an object to inspect its geometry, material, regions, or physics",
      },
    }),
    [rows.length, toggleObjectVisibility],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 4. DefinitionsRootInspectorPanel (`definitions.root` + `model.frozen-spins` redirect) ── */

interface SessionMaterialRow {
  id: string;
  name: string;
  msLabel: string;
  usageCount: number;
}

interface UnscopedFrozenRow {
  id: string;
  name: string;
  enabled: boolean;
}

interface DefinitionsRootDraft {
  materials: readonly SessionMaterialRow[];
  monitorCount: number;
  unscopedFrozen: readonly UnscopedFrozenRow[];
}

export function DefinitionsRootInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const monitors = usePlanarMonitorsResource();
  const frozenSpins = useFrozenSpinsCollectionResource({ enabled: true });
  const [libraryOpen, setLibraryOpen] = useState(false);

  const materials = useMemo<readonly SessionMaterialRow[]>(() => {
    const objects = scene.data?.objects ?? [];
    return (scene.data?.materials ?? []).map((mat) => {
      const usageCount = objects.filter((o) => o.material_ref === mat.id).length;
      const ms = mat.properties?.Ms;
      const msLabel =
        typeof ms === "number" && Number.isFinite(ms)
          ? `${Number((ms / 1e3).toPrecision(4))} kA/m`
          : `α = ${mat.properties?.alpha ?? 0}`;
      return {
        id: mat.id,
        name: mat.name || mat.id,
        msLabel,
        usageCount,
      };
    });
  }, [scene.data?.materials, scene.data?.objects]);

  const unscopedFrozen = useMemo<readonly UnscopedFrozenRow[]>(() => {
    return (frozenSpins.data?.definitions ?? [])
      .filter((def) => isUnscopedFrozenSelector(def.selector))
      .map((def) => ({
        id: def.id,
        name: def.name || def.id,
        enabled: def.enabled !== false,
      }));
  }, [frozenSpins.data?.definitions]);

  const monitorCount = monitors.data?.monitors?.length ?? 0;

  const baseline = useMemo<DefinitionsRootDraft>(
    () => ({
      materials,
      monitorCount,
      unscopedFrozen,
    }),
    [materials, monitorCount, unscopedFrozen],
  );

  const handleCreateCustomMaterial = useCallback(async () => {
    const index = (scene.data?.materials?.length ?? 0) + 1;
    const matId = `custom-material-${index}-${Date.now().toString(36)}`;
    const tx = await kernel.api.model.createMaterial(
      matId,
      `Custom Material ${index}`,
      { Ms: 8.0e5, Aex: 13e-12, alpha: 0.008 },
      [],
      { baseRevision: scene.data?.revision ?? undefined },
    );
    publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
  }, [kernel.api.model, kernel.resources, scene.data?.materials?.length, scene.data?.revision]);

  const handleCreateGlobalFrozenSpins = useCallback(
    async (selectNode: (next: Omit<Selection, "moduleSource">) => void) => {
      const id = `frozen-global-${Date.now().toString(36)}`;
      const expectedRev = frozenSpins.data?.revision ?? scene.data?.revision ?? 0;
      await kernel.api.model.frozenSpins.create({
        expected_revision: expectedRev,
        definition: {
          id,
          name: "Global Frozen Spins",
          enabled: true,
          schema_version: "fullmag.frozen-spins.v1",
          selector: { kind: "all_magnetic" },
          reference: { kind: "capture_current_at_activation" },
          membership: { kind: "static" },
          activation: { kind: "all_stages" },
        },
      });
      kernel.resources.invalidate(MODEL_FROZEN_SPINS_PATH, fallbackRevision(expectedRev + 1));
      const nodeId = `model:definitions:frozen-spins:${encodeURIComponent(id)}`;
      selectNode({
        kind: "object.frozen-spins",
        label: "Global Frozen Spins",
        nodeId,
        objectId: null,
        ref: null,
      });
    },
    [frozenSpins.data?.revision, kernel.api.model.frozenSpins, kernel.resources, scene.data?.revision],
  );

  const spec = useMemo<InspectorSpec<DefinitionsRootDraft>>(
    () => ({
      id: "model.definitions-root",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          { id: "definitions", label: "Definitions" },
        ],
        searchable: false,
        primaryHeaderAction: {
          label: "Material Library",
          icon: BookOpen,
          onRun: () => setLibraryOpen(true),
        },
      },
      identity: {
        domain: "definition",
        icon: BookOpen,
        title: () => "Definitions",
        kindLabel: "Reusable model definitions",
        entityId: "model:definitions",
        statePill: (draft) => ({
          tone: "ok",
          label: `${draft.materials.length} materials`,
        }),
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "materials", label: "Materials", value: String(draft.materials.length) },
        { id: "monitors", label: "Planar monitors", value: String(draft.monitorCount) },
        {
          id: "frozen",
          label: "Global constraints",
          value: String(draft.unscopedFrozen.length),
        },
      ],
      sections: [
        {
          id: "definitions-materials",
          title: "Session materials",
          icon: Magnet,
          defaultOpen: true,
          summary: (d) => `${d.materials.length} materials in session`,
          emptyState: (d) =>
            d.materials.length === 0
              ? {
                  icon: Magnet,
                  title: "No session materials defined",
                  description:
                    "Create a custom magnetic material or import a curated standard from the Material Library.",
                  action: {
                    label: "Create Custom Material",
                    onRun: () => void handleCreateCustomMaterial(),
                  },
                }
              : null,
          rows: [
            {
              type: "table",
              wide: true,
              showWhen: (d) => d.materials.length > 0,
              rowKey: (rawRow) => (rawRow as SessionMaterialRow).id,
              rows: (d) => d.materials,
              columns: [
                {
                  id: "name",
                  header: "Material",
                  renderCell: (rawRow) => (
                    <span className="font-medium text-[var(--fm-text)]">
                      {(rawRow as SessionMaterialRow).name}
                    </span>
                  ),
                },
                {
                  id: "ms",
                  header: "Summary",
                  mono: true,
                  renderCell: (rawRow) => (rawRow as SessionMaterialRow).msLabel,
                },
                {
                  id: "used",
                  header: "Used by",
                  align: "right",
                  renderCell: (rawRow) =>
                    `${(rawRow as SessionMaterialRow).usageCount} obj`,
                },
              ],
            },
          ],
          footer: () => (
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => void handleCreateCustomMaterial()}
              >
                <Plus aria-hidden="true" size={12} />
                <span>New Custom Material</span>
              </Button>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => setLibraryOpen(true)}
              >
                <BookOpen aria-hidden="true" size={12} />
                <span>Open Material Library</span>
              </Button>
            </div>
          ),
        },
        {
          id: "definitions-monitors",
          title: "Planar monitors",
          icon: Compass,
          defaultOpen: true,
          summary: (d) => `${d.monitorCount} spatial monitors`,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <InspectorShortcutCards
                  items={[
                    {
                      id: "planar-monitors",
                      title: "Planar Monitors",
                      subtitle: "2D slice & midplane observable monitors",
                      badge: `${ctx.draft.monitorCount}`,
                      selection: buildRootSelection(
                        "model.planar.monitors",
                        "model:definitions:planar-monitors",
                        "Planar Monitors",
                      ),
                    },
                  ]}
                  onSelect={ctx.selectNode}
                />
              ),
            },
          ],
          footer: () => (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                void kernel.commands.execute(
                  "planar-monitor.create",
                  createCommandContext("inspector", kernel),
                );
              }}
            >
              <Plus aria-hidden="true" size={12} />
              <span>Add Planar Monitor</span>
            </Button>
          ),
        },
        {
          id: "definitions-frozen-spins",
          title: "Global frozen spins constraints",
          icon: Shield,
          defaultOpen: true,
          summary: (d) => `${d.unscopedFrozen.length} unscoped constraints`,
          rows: [
            {
              type: "table",
              wide: true,
              showWhen: (d) => d.unscopedFrozen.length > 0,
              rowKey: (rawRow) => (rawRow as UnscopedFrozenRow).id,
              rows: (d) => d.unscopedFrozen,
              onSelectRow: (rawRow, ctx) => {
                const row = rawRow as UnscopedFrozenRow;
                ctx.selectNode({
                  kind: "object.frozen-spins",
                  label: row.name,
                  nodeId: `model:definitions:frozen-spins:${encodeURIComponent(row.id)}`,
                  objectId: null,
                  ref: null,
                });
              },
              columns: [
                {
                  id: "name",
                  header: "Constraint",
                  renderCell: (rawRow) => (
                    <span className="font-medium text-[var(--fm-text)]">
                      {(rawRow as UnscopedFrozenRow).name}
                    </span>
                  ),
                },
                {
                  id: "state",
                  header: "State",
                  align: "right",
                  renderCell: (rawRow) => {
                    const row = rawRow as UnscopedFrozenRow;
                    return (
                      <Badge data-tone={row.enabled ? "ok" : "neutral"}>
                        {row.enabled ? "Active" : "Disabled"}
                      </Badge>
                    );
                  },
                },
              ],
            },
          ],
          footer: (ctx) => (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => void handleCreateGlobalFrozenSpins(ctx.selectNode)}
            >
              <Plus aria-hidden="true" size={12} />
              <span>Add Global Frozen Spins</span>
            </Button>
          ),
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Select a definition or open the Material Library to author assets",
      },
    }),
    [handleCreateCustomMaterial, handleCreateGlobalFrozenSpins, kernel],
  );

  return (
    <SpecInspectorHost baseline={baseline} selection={selection} spec={spec}>
      <MaterialLibraryDialog open={libraryOpen} onOpenChange={setLibraryOpen} />
    </SpecInspectorHost>
  );
}
