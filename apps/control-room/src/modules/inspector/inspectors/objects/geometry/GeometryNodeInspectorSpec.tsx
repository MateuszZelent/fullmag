"use client";

import { ArrowDown, ArrowUp, Box, Eye, EyeOff, Grid3X3, Layers, Scissors } from "lucide-react";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import {
  patchObjectGeometryTransaction,
  separateObjectTransaction,
  updateBooleanOperandsTransaction,
} from "@/kernel/authoring/geometryLifecycleCommands";
import { useKernel } from "@/kernel/KernelContext";
import {
  publishCommittedSceneResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionScopedResourceKey } from "@/kernel/resources/useSessionScopedResourceKey";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  geometryGhostVisibilityStore,
  geometryOperandGhostKey,
} from "@/kernel/visualization/geometryGhostVisibilityStore";
import {
  parseCompositeGeometry,
  type NormalizedGeometryOperand,
} from "@/modules/explorer/builders/geometryTreeExplorerNodes";
import { Button } from "@/shared/ui/Button";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import {
  buildObjectSelection,
  buildRootSelection,
} from "../../../panels/model-roots/SpecInspectorHost";
import {
  InspectorTemplate,
  LENGTH_UNITS,
  useInspectorSpecController,
  type InspectorFact,
  type InspectorSpec,
} from "../../../template";

import { Array3DLatticeTableSection } from "./Array3DLatticeTableSection";

export interface GeometryNodeSpecDraft {
  exists: boolean;
  objectId: string;
  objectName: string;
  operandId: string;
  label: string;
  roleBadge: string;
  primitiveKind: string;
  enabled: boolean;
  index: number;
  total: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  radius: number;
  height: number;
  translation: readonly [number, number, number];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function geometryKindOf(geometry: Record<string, unknown>): string {
  const kind = geometry.geometry_kind ?? geometry.kind;
  return typeof kind === "string" && kind.trim().length > 0 ? kind.trim() : "Box";
}

function geometryParamsOf(geometry: Record<string, unknown>): Record<string, unknown> {
  return asRecord(geometry.geometry_params) ?? asRecord(geometry.params) ?? {};
}

export function resolveSelectedOperandId(
  selection: InspectorPanelProps["selection"],
): string | null {
  if (selection.ref?.type === "scene-object") {
    if (selection.ref.operandId) return selection.ref.operandId;
    if (selection.ref.geometryNodeId) return selection.ref.geometryNodeId;
  }
  const parts = selection.nodeId?.split(":geometry:");
  if (parts && parts.length > 1) {
    return parts[1]?.split(":").at(-1) ?? null;
  }
  return null;
}

export function buildGeometryNodeDraft(
  selection: InspectorPanelProps["selection"],
  scene: SceneResource | null | undefined,
): GeometryNodeSpecDraft {
  const objectId =
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId
      : selection.objectId ?? "";
  const operandId = resolveSelectedOperandId(selection) ?? "";
  const sceneObj = scene?.objects?.find((obj) => obj.id === objectId) ?? null;
  const parsed = parseCompositeGeometry(sceneObj?.geometry);
  const operand: NormalizedGeometryOperand | undefined = parsed.operands.find(
    (entry) => entry.operandId === operandId,
  );

  if (!sceneObj || !operand) {
    return {
      exists: false,
      objectId,
      objectName: objectId || "Object",
      operandId,
      label: selection.label ?? "Operand",
      roleBadge: "Node",
      primitiveKind: "Box",
      enabled: true,
      index: 0,
      total: 0,
      sizeX: 100e-9,
      sizeY: 100e-9,
      sizeZ: 10e-9,
      radius: 25e-9,
      height: 20e-9,
      translation: [0, 0, 0],
    };
  }

  const kind = geometryKindOf(operand.geometry);
  const params = geometryParamsOf(operand.geometry);
  const size = Array.isArray(params.size) ? params.size : null;
  const radii = Array.isArray(params.radii) ? params.radii : null;
  const tx = asRecord(operand.transform);
  const tr = Array.isArray(tx?.translation) ? tx.translation : [0, 0, 0];

  return {
    exists: true,
    objectId,
    objectName: typeof sceneObj.name === "string" && sceneObj.name ? sceneObj.name : objectId,
    operandId: operand.operandId,
    label: operand.label,
    roleBadge: operand.roleBadge,
    primitiveKind: kind,
    enabled: operand.enabled,
    index: operand.index,
    total: operand.total,
    sizeX: size ? numberOr(size[0], 100e-9) : radii ? numberOr(radii[0], 50e-9) * 2 : 100e-9,
    sizeY: size ? numberOr(size[1], 100e-9) : radii ? numberOr(radii[1], 50e-9) * 2 : 100e-9,
    sizeZ: size ? numberOr(size[2], 10e-9) : radii ? numberOr(radii[2], 10e-9) * 2 : 10e-9,
    radius: numberOr(params.radius ?? params.radius_bottom ?? params.major_radius, 25e-9),
    height: numberOr(params.height ?? params.length ?? params.thickness, 20e-9),
    translation: [numberOr(tr[0], 0), numberOr(tr[1], 0), numberOr(tr[2], 0)],
  };
}

function patchChildPrimitiveGeometry(
  childGeom: Record<string, unknown>,
  draft: GeometryNodeSpecDraft,
): Record<string, unknown> {
  const childParams = asRecord(childGeom.geometry_params) ?? {};
  const kind = geometryKindOf(childGeom);
  const nextParams: Record<string, unknown> = { ...childParams };
  if (kind === "Box") {
    nextParams.size = [draft.sizeX, draft.sizeY, draft.sizeZ];
  } else if (kind === "Ellipsoid") {
    nextParams.radii = [draft.sizeX / 2, draft.sizeY / 2, draft.sizeZ / 2];
    nextParams.size = [draft.sizeX, draft.sizeY, draft.sizeZ];
  } else if (kind === "Cylinder") {
    nextParams.radius = draft.radius;
    nextParams.height = draft.height;
  } else if (kind === "Sphere") {
    nextParams.radius = draft.radius;
  }
  return {
    ...childGeom,
    geometry_params: nextParams,
  };
}

export function patchOperandInCompositeGeometry(
  rawGeometry: unknown,
  draft: GeometryNodeSpecDraft,
): JsonObject | null {
  const geom = asRecord(rawGeometry);
  if (!geom) return null;
  const params = asRecord(geom.geometry_params);
  if (!params) return null;

  if (Array.isArray(params.operands)) {
    const updatedOperands = params.operands.map((entry, idx) => {
      const rec = asRecord(entry);
      if (!rec) return entry;
      const id = typeof rec.operand_id === "string" ? rec.operand_id : `operand-${idx}`;
      if (id !== draft.operandId) return entry;
      const childGeom = asRecord(rec.geometry) ?? {};
      const prevTransform = asRecord(rec.transform) ?? {};
      return {
        ...rec,
        enabled: draft.enabled,
        geometry: patchChildPrimitiveGeometry(childGeom, draft),
        label: draft.label.trim() || rec.label,
        transform: {
          ...prevTransform,
          translation: [draft.translation[0], draft.translation[1], draft.translation[2]],
        },
      };
    });

    return {
      ...geom,
      geometry_params: {
        ...params,
        operands: updatedOperands,
      },
    } as JsonObject;
  }

  // Backward-compatible legacy 2-operand dicts: { base, tool }, { a, b }, { left, right }
  const legacyPairs: readonly (readonly [string, string])[] = [
    ["base", "tool"],
    ["a", "b"],
    ["left", "right"],
  ];
  for (const [firstKey, secondKey] of legacyPairs) {
    const first = asRecord(params[firstKey]);
    const second = asRecord(params[secondKey]);
    if (!first || !second) continue;
    if (draft.operandId !== firstKey && draft.operandId !== secondKey) {
      return null;
    }
    const targetRaw = draft.operandId === firstKey ? first : second;
    const patchedChild = patchChildPrimitiveGeometry(targetRaw, draft);
    const hasTranslation = draft.translation.some((v) => Math.abs(v) > 1e-15);
    const updatedEntry = hasTranslation
      ? {
          geometry_kind: "Translate",
          geometry_params: {
            child: patchedChild,
            offset: [draft.translation[0], draft.translation[1], draft.translation[2]],
          },
        }
      : patchedChild;
    return {
      ...geom,
      geometry_params: {
        ...params,
        [draft.operandId]: updatedEntry,
      },
    } as JsonObject;
  }

  return null;
}

export function GeometryNodeInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const { sessionIdentity } = useSessionScopedResourceKey(MODEL_SCENE_PATH);
  const scene = useSceneResource();
  const [actionBusy, setActionBusy] = useState(false);
  const ghostKeys = useSyncExternalStore(
    geometryGhostVisibilityStore.subscribe,
    geometryGhostVisibilityStore.getSnapshot,
    geometryGhostVisibilityStore.getServerSnapshot,
  );

  const sessionScopeKey =
    sessionRequestScopeKey(sessionIdentity) ?? scene.sessionScopeKey ?? null;
  const baseline = useMemo(
    () => buildGeometryNodeDraft(selection, scene.data),
    [scene.data, selection],
  );
  const ghostVisible = baseline.exists
    ? ghostKeys.has(geometryOperandGhostKey(baseline.objectId, baseline.operandId))
    : false;
  const sceneRevision =
    typeof scene.data?.revision === "number" && Number.isFinite(scene.data.revision)
      ? scene.data.revision
      : null;

  const commitSceneResult = useCallback(
    (response: { committed_scene?: SceneResource; scene_revision?: number }) => {
      const rev = acknowledgedAuthoringSceneRevision(response);
      publishCommittedSceneResource(
        kernel.resources,
        response.committed_scene,
        rev,
        undefined,
        false,
        sessionScopeKey,
        kernel.api.resourceCacheScope,
      );
      invalidateAuthoringMutationDependents(kernel.resources, "geometry", rev);
    },
    [kernel.api.resourceCacheScope, kernel.resources, sessionScopeKey],
  );

  const runQuickAction = useCallback(
    async (
      op: () => Promise<{ committed_scene?: SceneResource; scene_revision?: number }>,
    ) => {
      if (actionBusy || sceneRevision === null) return;
      setActionBusy(true);
      try {
        const response = await op();
        commitSceneResult(response);
      } finally {
        setActionBusy(false);
      }
    },
    [actionBusy, commitSceneResult, sceneRevision],
  );

  const spec = useMemo<InspectorSpec<GeometryNodeSpecDraft>>(
    () => ({
      id: "geometry-node-inspector",
      chrome: {
        breadcrumbs: [
          {
            id: "objects",
            label: "Objects",
            selection: buildRootSelection("objects.root", "model:objects", "Objects"),
          },
          {
            id: "object",
            label: baseline.objectName,
            selection: buildObjectSelection(
              baseline.objectId,
              "object.root",
              baseline.objectName,
            ),
          },
          {
            id: "geometry",
            label: "Geometry",
            selection: buildObjectSelection(
              baseline.objectId,
              "object.geometry",
              baseline.objectName,
            ),
          },
          {
            id: "node",
            label: baseline.label,
          },
        ],
        canFitView: baseline.exists,
      },
      identity: {
        domain: "geometry",
        icon: Layers,
        title: (draft) => draft.label,
        subtitle: (draft) => `${draft.roleBadge} · ${draft.primitiveKind}`,
        facts: (draft): InspectorFact[] =>
          draft.exists
            ? [
                { label: "Role", value: draft.roleBadge },
                { label: "Primitive", value: draft.primitiveKind },
                { label: "Stack", value: `#${draft.index + 1} / ${draft.total}` },
                { label: "State", value: draft.enabled ? "Active" : "Disabled" },
              ]
            : [{ label: "Status", value: "Node missing" }],
      },
      sections: [
        {
          id: "geometry-node-state",
          title: "Operand state & stack",
          icon: Layers,
          defaultOpen: true,
          rows: [
            {
              key: "label",
              type: "text",
              label: "Operand label",
            },
            {
              key: "enabled",
              type: "switch",
              label: "Include operand in CSG evaluation",
            },
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-[var(--fm-text-secondary)]">
                      Ghost wireframe preview (local viewport only)
                    </span>
                    <div className="flex items-center gap-1.5">
                      {ghostVisible ? <Eye size={13} /> : <EyeOff size={13} />}
                      <Switch
                        aria-label="Toggle ghost wireframe"
                        checked={ghostVisible}
                        disabled={!ctx.draft.exists}
                        onCheckedChange={(checked) =>
                          geometryGhostVisibilityStore.setGhostVisible(
                            ctx.draft.objectId,
                            ctx.draft.operandId,
                            Boolean(checked),
                          )
                        }
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      disabled={
                        actionBusy ||
                        !ctx.draft.exists ||
                        ctx.draft.index === 0 ||
                        sceneRevision === null
                      }
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        const obj = scene.data?.objects?.find(
                          (item) => item.id === ctx.draft.objectId,
                        );
                        const ids = parseCompositeGeometry(obj?.geometry).operands.map(
                          (item) => item.operandId,
                        );
                        if (ctx.draft.index <= 0 || sceneRevision === null) return;
                        const nextIds = [...ids];
                        const [moved] = nextIds.splice(ctx.draft.index, 1);
                        nextIds.splice(ctx.draft.index - 1, 0, moved);
                        void runQuickAction(() =>
                          updateBooleanOperandsTransaction(
                            kernel.api,
                            {
                              base_revision: sceneRevision,
                              object_id: ctx.draft.objectId,
                              reorder_operand_ids: nextIds,
                            },
                            sessionScopeKey ? { sessionScopeKey } : undefined,
                          ),
                        );
                      }}
                    >
                      <ArrowUp size={13} />
                      <span>Move Up</span>
                    </Button>
                    <Button
                      disabled={
                        actionBusy ||
                        !ctx.draft.exists ||
                        ctx.draft.index >= ctx.draft.total - 1 ||
                        sceneRevision === null
                      }
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        const obj = scene.data?.objects?.find(
                          (item) => item.id === ctx.draft.objectId,
                        );
                        const ids = parseCompositeGeometry(obj?.geometry).operands.map(
                          (item) => item.operandId,
                        );
                        if (
                          ctx.draft.index < 0 ||
                          ctx.draft.index >= ids.length - 1 ||
                          sceneRevision === null
                        ) {
                          return;
                        }
                        const nextIds = [...ids];
                        const [moved] = nextIds.splice(ctx.draft.index, 1);
                        nextIds.splice(ctx.draft.index + 1, 0, moved);
                        void runQuickAction(() =>
                          updateBooleanOperandsTransaction(
                            kernel.api,
                            {
                              base_revision: sceneRevision,
                              object_id: ctx.draft.objectId,
                              reorder_operand_ids: nextIds,
                            },
                            sessionScopeKey ? { sessionScopeKey } : undefined,
                          ),
                        );
                      }}
                    >
                      <ArrowDown size={13} />
                      <span>Move Down</span>
                    </Button>
                    <Button
                      disabled={actionBusy || !ctx.draft.exists || sceneRevision === null}
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        if (sceneRevision === null) return;
                        void runQuickAction(() =>
                          separateObjectTransaction(
                            kernel.api,
                            {
                              base_revision: sceneRevision,
                              keep_in_boolean: false,
                              mode: "extract_operand",
                              object_id: ctx.draft.objectId,
                              operand_id: ctx.draft.operandId,
                            },
                            sessionScopeKey ? { sessionScopeKey } : undefined,
                          ),
                        );
                      }}
                    >
                      <Scissors size={13} />
                      <span>Extract as Object</span>
                    </Button>
                  </div>
                </div>
              ),
            },
          ],
        },
        {
          id: "geometry-node-dimensions",
          title: "Operand primitive & local offset",
          icon: Box,
          defaultOpen: true,
          showWhen: (draft) => draft.exists,
          rows: [
            {
              key: "sizeX",
              type: "quantity",
              label: "Extent X",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) => d.primitiveKind === "Box" || d.primitiveKind === "Ellipsoid",
            },
            {
              key: "sizeY",
              type: "quantity",
              label: "Extent Y",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) => d.primitiveKind === "Box" || d.primitiveKind === "Ellipsoid",
            },
            {
              key: "sizeZ",
              type: "quantity",
              label: "Thickness Z",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) => d.primitiveKind === "Box" || d.primitiveKind === "Ellipsoid",
            },
            {
              key: "radius",
              type: "quantity",
              label: "Radius",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) => d.primitiveKind === "Cylinder" || d.primitiveKind === "Sphere",
            },
            {
              key: "height",
              type: "quantity",
              label: "Height",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              showWhen: (d) => d.primitiveKind === "Cylinder",
            },
            {
              key: "translation",
              type: "vector3",
              label: "Local translation",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
            },
          ],
        },
        {
          id: "geometry-node-array-3d",
          title: "Array 3D on operand",
          icon: Grid3X3,
          defaultOpen: false,
          showWhen: (draft) => draft.exists,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <Array3DLatticeTableSection
                  kernel={kernel}
                  objectId={ctx.draft.objectId}
                  sceneData={scene.data}
                  sessionScopeKey={sessionScopeKey}
                  targetOperandId={ctx.draft.operandId}
                />
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Operand matches committed CSG tree",
        lockReason: (d) =>
          !d.exists
            ? "Select an existing CSG operand node in the Geometry Tree."
            : sceneRevision === null
              ? "Refetch the scene before editing operands."
              : null,
        onApply: async (draft) => {
          const obj = scene.data?.objects?.find((item) => item.id === draft.objectId);
          const nextGeometry = patchOperandInCompositeGeometry(obj?.geometry, draft);
          if (!nextGeometry || sceneRevision === null) {
            throw new Error("Could not patch operand in parent composite geometry.");
          }
          const response = await patchObjectGeometryTransaction(
            kernel.api,
            draft.objectId,
            {
              base_revision: sceneRevision,
              geometry: nextGeometry,
            },
            sessionScopeKey ? { sessionScopeKey } : undefined,
          );
          commitSceneResult(response);
          return true;
        },
      },
    }),
    [
      actionBusy,
      baseline.exists,
      baseline.label,
      baseline.objectId,
      baseline.objectName,
      commitSceneResult,
      ghostVisible,
      kernel,
      runQuickAction,
      scene.data,
      sceneRevision,
      sessionScopeKey,
    ],
  );

  const controller = useInspectorSpecController(spec, selection, baseline);
  const handleSelectNode = useCallback(
    (next: Omit<Selection, "moduleSource">) => {
      kernel.selection.set(next, "inspector");
    },
    [kernel.selection],
  );

  return (
    <InspectorTemplate
      activeModeTabId={controller.activeModeTabId}
      animationKey={controller.animationKey}
      appliedFlash={controller.appliedFlash}
      applyError={controller.applyError}
      applying={controller.applying}
      baseline={controller.baseline}
      dirtyFields={controller.dirtyFields}
      displayUnits={controller.displayUnits}
      draft={controller.draft}
      forceShowErrors={controller.forceShowErrors}
      invalidFields={controller.invalidFields}
      selection={selection}
      spec={spec}
      touchedFields={controller.touchedFields}
      onActiveModeTabChange={controller.setActiveModeTabId}
      onApply={controller.requestApply}
      onDisplayUnitChange={controller.setDisplayUnit}
      onFieldChange={controller.setField}
      onFieldTouch={controller.touchField}
      onFocusField={(key) => controller.focusField(key as keyof GeometryNodeSpecDraft & string)}
      onHideInspector={() => kernel.layout.setPanelVisible("right", false)}
      onParseErrorChange={controller.setParseError}
      onPatchDraft={controller.patchDraft}
      onResetDisplay={controller.resetDisplay}
      onRevertAll={controller.revertAll}
      onRevertField={controller.revertField}
      onSelectNode={handleSelectNode}
    />
  );
}
