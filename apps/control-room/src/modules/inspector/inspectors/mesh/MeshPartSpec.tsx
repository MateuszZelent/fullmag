"use client";

import { Box, Layers, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import type {
  AuthoringTransactionRequest,
  JsonObject,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { useKernel } from "@/kernel/KernelContext";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import * as sessionStatusHooks from "@/kernel/resources/useSessionStatus";
import type { VisualizationRenderMode } from "@/kernel/visualization/ObjectVisualizationController";
import {
  SpecInspectorHost,
  type InspectorPanelProps,
  type InspectorSpec,
} from "@/modules/inspector/shared";
import { Badge } from "@/shared/ui/Badge";

import { MeshPartVisualizationPanel } from "../../panels/MeshPartVisualizationPanel";
import {
  asNumber,
  asRecord,
  asString,
  buildSafeMutationContext,
} from "./meshShared";

export interface UnassignedRootDraft {
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

export interface UnassignedPartDraft {
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
