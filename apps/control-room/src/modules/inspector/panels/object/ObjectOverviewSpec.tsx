"use client";

import {
  ArrowRight,
  Box,
  Layers,
  Shield,
} from "lucide-react";
import { useCallback, useMemo } from "react";

import {
  MODEL_FROZEN_SPINS_PATH,
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type { AbsorbingBoundaryConfig } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { resolveObjectExtensionsSectionModel } from "@/kernel/object-extensions/ObjectExtensionsSectionModel";
import { useObjectExtensionActivation } from "@/kernel/object-extensions/useObjectExtensionActivation";
import { useFrozenSpinsCollectionResource } from "@/kernel/resources/frozenSpinsResources";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  publishCommittedSceneResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorFact,
  InspectorNotice,
  InspectorSpec,
  InspectorTone,
} from "../../template";
import {
  buildObjectSelection,
  buildRootSelection,
  fallbackRevision,
  formatSpanAuto,
  formatVolumeAuto,
  InspectorShortcutCards,
  type SceneObjectItem as SceneObject,
  SpecInspectorHost,
  type InspectorShortcutCardItem,
} from "../model-roots/SpecInspectorHost";

/* ── Pure Helpers ── */

type CanonicalObjectRole = "magnetic_body" | "conductor" | "spacer_dielectric" | "antenna";

interface ObjectOverviewDraft {
  objectId: string;
  exists: boolean;
  name: string;
  role: CanonicalObjectRole;
  visible: boolean;
  notes: string;
  geometryKind: string;
  spanText: string | null;
  volumeText: string | null;
  materialLabel: string;
  regionCount: number;
  meshState: { tone: InspectorTone; label: string };
  hasSal: boolean;
  hasFrozenSpins: boolean;
  frozenConstraintId: string | null;
  hasTopologicalCharge: boolean;
  dependentCouplingCount: number;
}

function normalizeRole(sceneObj: SceneObject | undefined): CanonicalObjectRole {
  const raw = sceneObj?.role?.trim().toLowerCase() ?? "magnet";
  if (raw === "antenna") return "antenna";
  if (raw === "conductor") return "conductor";
  if (raw === "auxiliary" || raw === "spacer_dielectric") return "spacer_dielectric";
  return "magnetic_body";
}

function roleToApiValue(role: CanonicalObjectRole): string {
  if (role === "antenna") return "antenna";
  if (role === "conductor") return "conductor";
  if (role === "spacer_dielectric") return "auxiliary";
  return "magnet";
}

function roleKindLabel(role: CanonicalObjectRole): string {
  switch (role) {
    case "antenna":
      return "Antenna object";
    case "conductor":
      return "Conductor object";
    case "spacer_dielectric":
      return "Dielectric spacer";
    default:
      return "Magnetic object";
  }
}

function estimateGeometryMetrics(
  sceneObj: SceneObject | undefined,
): { kind: string; spanText: string | null; volumeText: string | null } {
  const geom = (sceneObj?.geometry ?? null) as Record<string, unknown> | null;
  const kind =
    (typeof geom?.geometry_kind === "string" && geom.geometry_kind) ||
    (typeof geom?.kind === "string" && geom.kind) ||
    "Primitive";
  const params = (geom?.geometry_params ?? null) as Record<string, unknown> | null;
  if (!params) {
    return { kind, spanText: null, volumeText: null };
  }
  const lower = kind.toLowerCase();
  if (lower === "box" && Array.isArray(params.size) && params.size.length >= 3) {
    const sx = Number(params.size[0]) || 0;
    const sy = Number(params.size[1]) || 0;
    const sz = Number(params.size[2]) || 0;
    return {
      kind,
      spanText: formatSpanAuto([sx, sy, sz]),
      volumeText: formatVolumeAuto(sx * sy * sz),
    };
  }
  if (lower === "cylinder" && typeof params.radius === "number" && typeof params.height === "number") {
    const r = params.radius;
    const h = params.height;
    return {
      kind,
      spanText: formatSpanAuto([2 * r, 2 * r, h]),
      volumeText: formatVolumeAuto(Math.PI * r * r * h),
    };
  }
  if (lower === "sphere" && typeof params.radius === "number") {
    const r = params.radius;
    return {
      kind,
      spanText: formatSpanAuto([2 * r, 2 * r, 2 * r]),
      volumeText: formatVolumeAuto((4 / 3) * Math.PI * r * r * r),
    };
  }
  if (
    (lower === "ellipsoid") &&
    Array.isArray(params.radii ?? params.size)
  ) {
    const arr = (params.radii ?? params.size) as unknown[];
    const rx = Number(arr[0]) || 0;
    const ry = Number(arr[1]) || 0;
    const rz = Number(arr[2]) || 0;
    const isRadii = Array.isArray(params.radii);
    const span: [number, number, number] = isRadii ? [2 * rx, 2 * ry, 2 * rz] : [rx, ry, rz];
    const vol = isRadii
      ? (4 / 3) * Math.PI * rx * ry * rz
      : (Math.PI / 6) * rx * ry * rz;
    return {
      kind,
      spanText: formatSpanAuto(span),
      volumeText: formatVolumeAuto(vol),
    };
  }
  if (
    lower === "archwaveguide" ||
    lower === "arch_waveguide"
  ) {
    const l = Number(params.length) || 0;
    const w = Number(params.width) || 0;
    const h = Number(params.height) || 0;
    const ah = Number(params.arch_height) || 0;
    return {
      kind: "ArchWaveguide",
      spanText: l > 0 && w > 0 && h > 0 ? formatSpanAuto([l, w, h + ah]) : null,
      volumeText: l > 0 && w > 0 && h > 0 ? formatVolumeAuto(l * w * h) : null,
    };
  }
  return { kind, spanText: null, volumeText: null };
}

function resolveMeshPill(tags: unknown): { tone: InspectorTone; label: string } {
  const list = Array.isArray(tags) ? tags : [];
  if (list.includes("validation:blocked") || list.includes("mesh:failed")) {
    return { tone: "err", label: "Mesh failed" };
  }
  if (list.includes("mesh:building")) {
    return { tone: "live", label: "Meshing" };
  }
  if (list.includes("mesh:dirty")) {
    return { tone: "stale", label: "Mesh stale" };
  }
  if (list.includes("mesh:ready")) {
    return { tone: "ok", label: "Mesh ready" };
  }
  return { tone: "info", label: "Authored" };
}

function buildDefaultSalConfig(objectId: string): AbsorbingBoundaryConfig {
  return {
    layers: [
      {
        id: `sal-${objectId}`,
        enabled: true,
        target_region: objectId,
        alpha_max_delta: 0.5,
        width_m: 25e-9,
        profile: { kind: "polynomial", exponent: 3 },
        geometry: { kind: "outer_contour" },
      },
    ],
  } as unknown as AbsorbingBoundaryConfig;
}

/* ── ObjectOverviewInspectorPanel (`object.root`) ── */

export function ObjectOverviewInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const frozenSpins = useFrozenSpinsCollectionResource({ enabled: true });
  const extensionActivation = useObjectExtensionActivation();

  const objectId =
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId
      : selection.objectId ?? "";

  const sceneObject = useMemo(
    () => scene.data?.objects?.find((entry) => entry.id === objectId),
    [objectId, scene.data?.objects],
  );

  const materialLabel = useMemo(() => {
    const ref = sceneObject?.material_ref?.trim();
    if (!ref) return "Unassigned";
    const found = scene.data?.materials?.find((m) => m.id === ref);
    return found?.name?.trim() || ref;
  }, [scene.data?.materials, sceneObject?.material_ref]);

  const objectFrozen = useMemo(() => {
    return (
      (frozenSpins.data?.definitions ?? []).find((def) => {
        const sel = def.selector as Record<string, unknown> | undefined;
        return sel?.kind === "in_object" && sel.object_id === objectId;
      }) ?? null
    );
  }, [frozenSpins.data?.definitions, objectId]);

  const dependentCouplingCount = useMemo(() => {
    return (scene.data?.couplings ?? []).filter((cpl) => {
      const rec = cpl as unknown as Record<string, unknown>;
      const a = (rec.source ?? rec.endpoint_a ?? rec.side_a ?? null) as Record<
        string,
        unknown
      > | null;
      const b = (rec.target ?? rec.endpoint_b ?? rec.side_b ?? null) as Record<
        string,
        unknown
      > | null;
      return (
        a?.object === objectId ||
        b?.object === objectId ||
        a?.object_id === objectId ||
        b?.object_id === objectId
      );
    }).length;
  }, [objectId, scene.data?.couplings]);

  const extensionsModel = useMemo(
    () => resolveObjectExtensionsSectionModel(selection, extensionActivation.activation),
    [extensionActivation.activation, selection],
  );
  const hasTopologicalCharge = Boolean(
    extensionsModel.extensions.find((ext) => ext.id === "topological_charge")?.enabled,
  );

  const baseline = useMemo<ObjectOverviewDraft>(() => {
    const role = normalizeRole(sceneObject);
    const metrics = estimateGeometryMetrics(sceneObject);
    const salRec = (sceneObject?.absorbing_boundary ?? null) as Record<string, unknown> | null;
    const hasSal = Boolean(
      salRec &&
        (Array.isArray(salRec.layers) ? salRec.layers.length > 0 : Object.keys(salRec).length > 0),
    );
    return {
      objectId,
      exists: Boolean(sceneObject),
      name: sceneObject?.name?.trim() || selection.label || objectId || "Object",
      role,
      visible: sceneObject?.visible !== false,
      notes: sceneObject?.notes ?? "",
      geometryKind: metrics.kind,
      spanText: metrics.spanText,
      volumeText: metrics.volumeText,
      materialLabel,
      regionCount: sceneObject?.regions?.length ?? 0,
      meshState: resolveMeshPill(sceneObject?.tags),
      hasSal,
      hasFrozenSpins: Boolean(objectFrozen && objectFrozen.enabled !== false),
      frozenConstraintId: objectFrozen?.id ?? null,
      hasTopologicalCharge,
      dependentCouplingCount,
    };
  }, [
    dependentCouplingCount,
    hasTopologicalCharge,
    materialLabel,
    objectFrozen,
    objectId,
    sceneObject,
    selection.label,
  ]);

  const handleToggleSal = useCallback(
    async (enabled: boolean) => {
      if (!objectId) return;
      const updated = await kernel.api.model.patchObject(objectId, {
        base_revision: scene.data?.revision ?? null,
        absorbing_boundary: enabled ? buildDefaultSalConfig(objectId) : null,
      });
      publishCommittedSceneResource(
        kernel.resources,
        updated,
        fallbackRevision(updated.revision),
      );
    },
    [kernel.api.model, kernel.resources, objectId, scene.data?.revision],
  );

  const handleToggleFrozenSpins = useCallback(
    async (enabled: boolean) => {
      if (!objectId) return;
      const expectedRev = frozenSpins.data?.revision ?? scene.data?.revision ?? 0;
      if (objectFrozen) {
        await kernel.api.model.frozenSpins.patch(objectFrozen.id, {
          expected_revision: expectedRev,
          definition: { ...objectFrozen, enabled },
        });
      } else if (enabled) {
        const id = `frozen-${objectId}`;
        await kernel.api.model.frozenSpins.create({
          expected_revision: expectedRev,
          definition: {
            id,
            name: `Frozen Spins (${sceneObject?.name ?? objectId})`,
            enabled: true,
            schema_version: "fullmag.frozen-spins.v1",
            selector: { kind: "in_object", object_id: objectId },
            reference: { kind: "capture_current_at_activation" },
            membership: { kind: "static" },
            activation: { kind: "all_stages" },
          },
        });
      }
      kernel.resources.invalidate(MODEL_FROZEN_SPINS_PATH, fallbackRevision(expectedRev + 1));
    },
    [
      frozenSpins.data?.revision,
      kernel.api.model.frozenSpins,
      kernel.resources,
      objectFrozen,
      objectId,
      scene.data?.revision,
      sceneObject?.name,
    ],
  );

  const handleToggleTopologicalCharge = useCallback(
    (enabled: boolean) => {
      if (!objectId) return;
      extensionActivation.setEnabled(objectId, "topological_charge", enabled);
    },
    [extensionActivation, objectId],
  );

  const childCards = useMemo<readonly InspectorShortcutCardItem[]>(() => {
    if (!objectId) return [];
    if (baseline.role === "antenna") {
      return [
        {
          id: "antenna-geometry",
          title: "Geometry",
          subtitle: "Conductor topology & dimensions",
          badge: baseline.geometryKind,
          selection: buildObjectSelection(objectId, "object.antenna.geometry", "Geometry", {
            objectRole: "antenna",
          }),
        },
        {
          id: "antenna-root",
          title: "Antenna",
          subtitle: "Ports, current excitation, field solve & target projection",
          selection: buildObjectSelection(objectId, "object.antenna", "Antenna", {
            objectRole: "antenna",
          }),
        },
        {
          id: "mesh",
          title: "Mesh",
          subtitle: "Object mesh policy & build report",
          badge: baseline.meshState.label,
          tone: baseline.meshState.tone,
          selection: buildObjectSelection(objectId, "object.mesh", "Mesh", {
            objectRole: "antenna",
          }),
        },
        {
          id: "visualization",
          title: "Visualization",
          subtitle: "3D surface, wireframe & field display",
          selection: buildObjectSelection(objectId, "object.visualization", "Visualization", {
            objectRole: "antenna",
          }),
        },
      ];
    }

    const rawInitMag = (sceneObject as Record<string, unknown> | undefined)
      ?.initial_magnetization as Record<string, unknown> | null | undefined;
    const textureKind =
      rawInitMag?.preset_kind ??
      rawInitMag?.kind ??
      (sceneObject?.magnetization_ref ? "Assigned" : "Unassigned");

    return [
      {
        id: "geometry",
        title: "Geometry",
        subtitle: baseline.spanText
          ? `${baseline.geometryKind} · ${baseline.spanText}`
          : `${baseline.geometryKind} shape, transform & CSG`,
        badge: baseline.geometryKind,
        selection: buildObjectSelection(objectId, "object.geometry", "Geometry"),
      },
      {
        id: "material",
        title: "Material",
        subtitle: "Intrinsic magnetic, exchange, anisotropy & transport constants",
        badge: baseline.materialLabel,
        tone: baseline.materialLabel === "Unassigned" ? "warn" : "ok",
        selection: buildObjectSelection(objectId, "object.material", "Material"),
      },
      {
        id: "magnetic-texture",
        title: "Magnetic Texture",
        subtitle: "Initial magnetization m₀ preset, placement & field file",
        badge: String(textureKind),
        selection: buildObjectSelection(objectId, "object.magnetic-texture", "Magnetic Texture"),
      },
      {
        id: "regions",
        title: "Regions",
        subtitle: "Sub-volumes, precedence stack & spatial overrides",
        badge: `${baseline.regionCount}`,
        selection: buildObjectSelection(objectId, "object.regions", "Regions"),
      },
      {
        id: "physics",
        title: "Physics",
        subtitle: "Active Hamiltonian interactions, spin torques & transport",
        selection: buildObjectSelection(objectId, "object.physics", "Physics"),
      },
      {
        id: "mesh",
        title: "Mesh",
        subtitle: "Element sizing policy & discretization quality",
        badge: baseline.meshState.label,
        tone: baseline.meshState.tone,
        selection: buildObjectSelection(objectId, "object.mesh", "Mesh"),
      },
      {
        id: "visualization",
        title: "Visualization",
        subtitle: "Surface shading, vector glyphs & opacity in 3D viewport",
        selection: buildObjectSelection(objectId, "object.visualization", "Visualization"),
      },
    ];
  }, [
    baseline.geometryKind,
    baseline.materialLabel,
    baseline.meshState.label,
    baseline.meshState.tone,
    baseline.regionCount,
    baseline.role,
    baseline.spanText,
    objectId,
    sceneObject,
  ]);

  const spec = useMemo<InspectorSpec<ObjectOverviewDraft>>(
    () => ({
      id: "object.overview",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          {
            id: "objects",
            label: "Objects",
            selection: buildRootSelection("objects.root", "model:objects", "Objects"),
          },
          { id: "object", label: baseline.name },
        ],
        canFitView: baseline.exists,
        searchable: false,
        ...(baseline.exists
          ? {
              deleteAction: {
                label: "Delete Object",
                confirmTitle: (draft) => `Delete object "${draft.name}"?`,
                confirmDescription:
                  baseline.dependentCouplingCount > 0 || baseline.regionCount > 0
                    ? `Deleting "${baseline.name}" removes ${baseline.regionCount} authored region(s) and invalidates ${baseline.dependentCouplingCount} referencing coupling(s).`
                    : `Deleting "${baseline.name}" permanently removes it from the session model.`,
                onDelete: async (ctx) => {
                  const tx = await kernel.api.model.commitTransaction({
                    base_revision: scene.data?.revision ?? null,
                    kind: "delete_object",
                    object_id: objectId,
                  });
                  publishCommittedSceneResource(
                    kernel.resources,
                    tx.committed_scene,
                    tx.scene_revision,
                  );
                  kernel.resources.invalidate(MODEL_GEOMETRY_VALIDATION_PATH, tx.scene_revision);
                  kernel.resources.invalidate(MODEL_READINESS_PATH, tx.scene_revision);
                  ctx.selectNode(buildRootSelection("objects.root", "model:objects", "Objects"));
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "geometry",
        icon: Box,
        title: (draft) => draft.name,
        renameFieldKey: baseline.exists ? "name" : undefined,
        kindLabel: roleKindLabel(baseline.role),
        entityId: objectId || undefined,
        statePill: (draft) =>
          draft.exists ? draft.meshState : { tone: "warn", label: "Not found" },
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "shape", label: "Primitive", value: draft.geometryKind },
        { id: "span", label: "Dimensions", value: draft.spanText },
        { id: "volume", label: "Volume", value: draft.volumeText },
        {
          id: "material",
          label: "Material",
          value: draft.role === "antenna" ? null : draft.materialLabel,
          tone: draft.materialLabel === "Unassigned" ? "warn" : "ok",
        },
      ],
      notices: (draft): readonly InspectorNotice<ObjectOverviewDraft>[] => {
        const list: InspectorNotice<ObjectOverviewDraft>[] = [];
        if (!draft.exists) {
          list.push({
            id: "missing-object",
            tone: "warn",
            title: "Object not present in scene",
            text: "Select an authored object from the Objects branch or create a new primitive.",
            quickFix: {
              label: "Go to Objects",
              onApply: (ctx) =>
                ctx.selectNode(buildRootSelection("objects.root", "model:objects", "Objects")),
            },
          });
          return list;
        }
        if (draft.role === "magnetic_body" && draft.materialLabel === "Unassigned") {
          list.push({
            id: "unassigned-material",
            tone: "warn",
            title: "No magnetic material assigned",
            text: "Assign a library or custom material on the Material child node before running LLG stages.",
            quickFix: {
              label: "Open Material",
              onApply: (ctx) =>
                ctx.selectNode(buildObjectSelection(objectId, "object.material", "Material")),
            },
          });
        }
        return list;
      },
      sections: [
        {
          id: "object-identity",
          title: "Identity & physical role",
          icon: Box,
          defaultOpen: true,
          showWhen: (d) => d.exists,
          summary: (d) => `${roleKindLabel(d.role)} · ${d.visible ? "Visible" : "Hidden"}`,
          rows: [
            {
              key: "name",
              type: "text",
              label: "Object name",
              validate: (val) => (val.trim().length === 0 ? "Object name cannot be empty." : null),
            },
            {
              key: "role",
              type: "select",
              label: "Physical role",
              options: [
                { value: "magnetic_body", label: "Magnetic body (LLG spins)" },
                { value: "conductor", label: "Non-magnetic conductor (charge / spin Hall)" },
                { value: "spacer_dielectric", label: "Dielectric / spacer" },
                ...(baseline.role === "antenna"
                  ? [{ value: "antenna", label: "RF / inductive antenna" }]
                  : []),
              ],
            },
            {
              key: "visible",
              type: "switch",
              label: "Visible in 3D viewport",
            },
            {
              key: "notes",
              type: "textarea",
              label: "Notes",
              rows: 2,
              placeholder: "Optional fabrication, layer stack, or experimental reference notes",
            },
          ],
        },
        {
          id: "object-extensions",
          title: "Constraints & diagnostic extensions",
          icon: Shield,
          defaultOpen: true,
          live: true,
          showWhen: (d) => d.exists && d.role !== "antenna",
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-col gap-1.5" data-slot="object-extension-switches">
                  <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-[var(--fm-text)]">
                          Absorbing boundary (SAL)
                        </span>
                        {ctx.draft.hasSal ? <Badge data-tone="ok">Active</Badge> : null}
                      </div>
                      <p className="truncate text-xs text-[var(--fm-text-muted)]">
                        Spatial α(r) damping ramp suppressing edge spin-wave reflections
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Switch
                        aria-label="Toggle Absorbing boundary (SAL)"
                        checked={ctx.draft.hasSal}
                        onCheckedChange={(checked) => void handleToggleSal(checked)}
                      />
                      {ctx.draft.hasSal ? (
                        <Button
                          aria-label="Configure Absorbing boundary"
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() =>
                            ctx.selectNode(
                              buildObjectSelection(
                                objectId,
                                "object.absorbing-boundary",
                                "Absorbing Boundary",
                              ),
                            )
                          }
                        >
                          <ArrowRight aria-hidden="true" size={12} />
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-[var(--fm-text)]">
                          Frozen spins constraint
                        </span>
                        {ctx.draft.hasFrozenSpins ? <Badge data-tone="ok">Pinned</Badge> : null}
                      </div>
                      <p className="truncate text-xs text-[var(--fm-text-muted)]">
                        Dirichlet spin pinning on object boundary or sub-volume
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Switch
                        aria-label="Toggle Frozen spins constraint"
                        checked={ctx.draft.hasFrozenSpins}
                        onCheckedChange={(checked) => void handleToggleFrozenSpins(checked)}
                      />
                      {ctx.draft.frozenConstraintId ? (
                        <Button
                          aria-label="Configure Frozen spins"
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            const cid = ctx.draft.frozenConstraintId!;
                            const nodeId = `model:object:${objectId}:frozen-spins:${encodeURIComponent(cid)}`;
                            ctx.selectNode({
                              kind: "object.frozen-spins",
                              label: "Frozen Spins",
                              nodeId,
                              objectId,
                              ref: null,
                            });
                          }}
                        >
                          <ArrowRight aria-hidden="true" size={12} />
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-[var(--fm-text)]">
                          Topological charge Q
                        </span>
                        {ctx.draft.hasTopologicalCharge ? (
                          <Badge data-tone="info">Enabled</Badge>
                        ) : null}
                      </div>
                      <p className="truncate text-xs text-[var(--fm-text-muted)]">
                        Berg-Lüscher skyrmion winding number diagnostic on 2D support
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Switch
                        aria-label="Toggle Topological charge Q"
                        checked={ctx.draft.hasTopologicalCharge}
                        onCheckedChange={handleToggleTopologicalCharge}
                      />
                      {ctx.draft.hasTopologicalCharge ? (
                        <Button
                          aria-label="Open Topological charge Q"
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() =>
                            ctx.selectNode(
                              buildObjectSelection(
                                objectId,
                                "object.extension.topological-charge",
                                "Topological Charge",
                                { extensionId: "topological-charge" },
                              ),
                            )
                          }
                        >
                          <ArrowRight aria-hidden="true" size={12} />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ),
            },
          ],
        },
        {
          id: "object-sub-resources",
          title: "Owned sub-resources",
          icon: Layers,
          defaultOpen: true,
          showWhen: (d) => d.exists,
          summary: () => `${childCards.length} child inspectors`,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <InspectorShortcutCards items={childCards} onSelect={ctx.selectNode} />
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () =>
          "Geometry, material, texture, and visualization are edited on their dedicated child nodes",
        lockReason: (d) => (!d.exists ? "Select an existing scene object." : null),
        onApply: async (draft, prev) => {
          if (!objectId) return false;
          let latestRevision = scene.data?.revision ?? null;
          if (draft.name.trim() !== prev.name.trim()) {
            const tx = await kernel.api.model.commitTransaction({
              base_revision: latestRevision,
              kind: "rename_object",
              name: draft.name.trim(),
              object_id: objectId,
            });
            latestRevision = tx.scene_revision;
            publishCommittedSceneResource(
              kernel.resources,
              tx.committed_scene,
              tx.scene_revision,
            );
          }
          if (
            draft.notes !== prev.notes ||
            draft.visible !== prev.visible ||
            draft.role !== prev.role
          ) {
            const updated = await kernel.api.model.patchObject(objectId, {
              base_revision: latestRevision,
              notes: draft.notes,
              visible: draft.visible,
              ...(draft.role !== prev.role ? ({ role: roleToApiValue(draft.role) } as Record<string, unknown>) : {}),
            });
            const rev = fallbackRevision(updated.revision);
            latestRevision = typeof updated.revision === "number" ? updated.revision : latestRevision;
            publishCommittedSceneResource(kernel.resources, updated, rev);
          }
          const finalRev = fallbackRevision(latestRevision);
          kernel.resources.invalidate(MODEL_GEOMETRY_VALIDATION_PATH, finalRev);
          kernel.resources.invalidate(MODEL_GEOMETRY_DIAGNOSTICS_PATH, finalRev);
          kernel.resources.invalidate(MODEL_READINESS_PATH, finalRev);
          kernel.resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, finalRev);
          kernel.resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, finalRev);
          kernel.resources.invalidate(MODEL_SCENE_PATH, finalRev);
          return true;
        },
      },
    }),
    [
      baseline.dependentCouplingCount,
      baseline.exists,
      baseline.name,
      baseline.regionCount,
      baseline.role,
      childCards,
      handleToggleFrozenSpins,
      handleToggleSal,
      handleToggleTopologicalCharge,
      kernel.api.model,
      kernel.resources,
      objectId,
      scene.data?.revision,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
