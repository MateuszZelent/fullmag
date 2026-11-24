"use client";

import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Box,
  Eye,
  EyeOff,
  Grid3X3,
  Layers,
  Scissors,
} from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import {
  computeArray3DBudgetStatus,
  computeArray3DInstanceCount,
  defaultArray3DAxes,
  parseArray3DGeometry,
} from "@/kernel/authoring/array3dModel";
import {
  patchObjectGeometryTransaction,
  separateObjectTransaction,
  updateBooleanOperandsTransaction,
} from "@/kernel/authoring/geometryLifecycleCommands";
import { useKernel } from "@/kernel/KernelContext";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionScopedResourceKey } from "@/kernel/resources/useSessionScopedResourceKey";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  geometryGhostVisibilityStore,
  geometryOperandGhostKey,
} from "@/kernel/visualization/geometryGhostVisibilityStore";
import { parseCompositeGeometry } from "@/kernel/authoring/compositeGeometryModel";
import { Button } from "@/shared/ui/Button";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import {
  buildObjectSelection,
  buildRootSelection,
  LENGTH_UNITS,
} from "../../../panels/model-roots/SpecInspectorHost";
import {
  InspectorTemplate,
  useInspectorSpecController,
  type InspectorFact,
  type InspectorSpec,
} from "../../../template";

import {
  Array3DLatticeTableSection,
  resolveArray3DChildBoundsMeters,
  type DisplayLengthUnit,
} from "./Array3DLatticeTableSection";
import { commitGeometryStackTransaction } from "./geometryHistoryRunner";
import {
  extractTransformVectors,
  parseGeometryNodePath,
  patchGeometryNodeAtPath,
  resolveGeometryNodeByPath,
  type GeometryNodeAncestor,
} from "./geometryNodeTreeOps";
import {
  parseSymmetryAxis,
  validateTorusRadii,
  type Array3DDraftConfig,
} from "./geometryShared";

export interface GeometryNodeSpecDraft {
  exists: boolean;
  objectId: string;
  objectName: string;
  operandId: string;
  segmentId: string;
  depth: number;
  canEditOperandMeta: boolean;
  isTopLevelBooleanOperand: boolean;
  isEditablePrimitive: boolean;
  isArray3D: boolean;
  arrayUnitSummary: string | null;
  arrayChildPath: string | null;
  ancestors: readonly GeometryNodeAncestor[];
  label: string;
  roleBadge: string;
  primitiveKind: string;
  symmetryAxis: "x" | "y" | "z";
  enabled: boolean;
  index: number;
  total: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  radius: number;
  height: number;
  bottomRadius: number;
  topRadius: number;
  majorRadius: number;
  minorRadius: number;
  translation: readonly [number, number, number];
  eulerDeg: readonly [number, number, number];
  scale: readonly [number, number, number];
  array3dConfig: Array3DDraftConfig | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function geometryParamsOf(geometry: Record<string, unknown>): Record<string, unknown> {
  return asRecord(geometry.geometry_params) ?? asRecord(geometry.params) ?? {};
}

export function buildGeometryNodeSelection(
  objectId: string,
  nodePath: string,
  label: string,
): Omit<Selection, "moduleSource"> {
  const segments = parseGeometryNodePath(nodePath);
  const segmentId = segments.at(-1) ?? nodePath;
  const nodeId = `model:object:${objectId}:geometry:${segments.join(":")}`;
  return {
    kind: "object.geometry.node",
    label,
    nodeId,
    objectId,
    ref: {
      geometryNodeId: nodePath,
      kind: "object.geometry.node",
      nodeId,
      objectId,
      operandId: segmentId,
      type: "scene-object",
      visualizationTargetId: `object:${objectId}`,
    },
  };
}

export function resolveSelectedOperandId(
  selection: InspectorPanelProps["selection"],
): string | null {
  if (selection.ref?.type === "scene-object") {
    if (selection.ref.geometryNodeId) return selection.ref.geometryNodeId;
    if (selection.ref.operandId) return selection.ref.operandId;
  }
  const parts = selection.nodeId?.split(":geometry:");
  if (parts && parts.length > 1 && parts[1]) {
    const tail = parts[1].trim();
    return tail.length > 0 ? tail.split(":").join("/") : null;
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
  const nodePath = resolveSelectedOperandId(selection) ?? "";
  const sceneObj = scene?.objects?.find((obj) => obj.id === objectId) ?? null;
  const resolved = sceneObj && nodePath ? resolveGeometryNodeByPath(sceneObj.geometry, nodePath) : null;

  if (!sceneObj || !resolved) {
    return {
      exists: false,
      objectId,
      objectName: objectId || "Object",
      operandId: nodePath,
      segmentId: parseGeometryNodePath(nodePath).at(-1) ?? nodePath,
      depth: 0,
      canEditOperandMeta: false,
      isTopLevelBooleanOperand: false,
      isEditablePrimitive: false,
      isArray3D: false,
      arrayUnitSummary: null,
      arrayChildPath: null,
      ancestors: [],
      label: selection.label ?? "Operand",
      roleBadge: "Node",
      primitiveKind: "Box",
      symmetryAxis: "z",
      enabled: true,
      index: 0,
      total: 0,
      sizeX: 100e-9,
      sizeY: 100e-9,
      sizeZ: 10e-9,
      radius: 25e-9,
      height: 20e-9,
      bottomRadius: 50e-9,
      topRadius: 25e-9,
      majorRadius: 80e-9,
      minorRadius: 20e-9,
      translation: [0, 0, 0],
      eulerDeg: [0, 0, 0],
      scale: [1, 1, 1],
      array3dConfig: null,
    };
  }

  const params = geometryParamsOf(resolved.geometry);
  const size = Array.isArray(params.size) ? params.size : null;
  const radii = Array.isArray(params.radii) ? params.radii : null;
  const txVecs = extractTransformVectors(resolved.transform);
  const parsedArray = resolved.isArray3D ? parseArray3DGeometry(resolved.geometry) : null;

  return {
    exists: true,
    objectId,
    objectName: typeof sceneObj.name === "string" && sceneObj.name ? sceneObj.name : objectId,
    operandId: resolved.path,
    segmentId: resolved.segmentId,
    depth: resolved.depth,
    canEditOperandMeta: resolved.canEditOperandMeta,
    isTopLevelBooleanOperand: resolved.isTopLevelBooleanOperand,
    isEditablePrimitive: resolved.isEditablePrimitive,
    isArray3D: resolved.isArray3D,
    arrayUnitSummary: resolved.arrayUnitSummary,
    arrayChildPath: resolved.arrayChildPath,
    ancestors: resolved.ancestors,
    label: resolved.label,
    roleBadge: resolved.roleBadge,
    primitiveKind: resolved.geometryKind,
    symmetryAxis: parseSymmetryAxis(params.axis),
    enabled: resolved.enabled,
    index: resolved.index,
    total: resolved.total,
    sizeX: size ? numberOr(size[0], 100e-9) : radii ? numberOr(radii[0], 50e-9) * 2 : 100e-9,
    sizeY: size ? numberOr(size[1], 100e-9) : radii ? numberOr(radii[1], 50e-9) * 2 : 100e-9,
    sizeZ: size ? numberOr(size[2], 10e-9) : radii ? numberOr(radii[2], 10e-9) * 2 : 10e-9,
    radius: numberOr(params.radius ?? params.radius_bottom ?? params.major_radius, 25e-9),
    height: numberOr(params.height ?? params.length ?? params.thickness, 20e-9),
    bottomRadius: numberOr(params.radius_bottom ?? params.bottom_radius, 50e-9),
    topRadius: numberOr(params.radius_top ?? params.top_radius, 25e-9),
    majorRadius: numberOr(params.major_radius, 80e-9),
    minorRadius: numberOr(params.minor_radius, 20e-9),
    translation: txVecs.translation,
    eulerDeg: txVecs.eulerDeg,
    scale: txVecs.scale,
    array3dConfig: parsedArray
      ? {
          axes: parsedArray.axes,
          mergeOverlapping: parsedArray.mergeOverlapping,
          realization: "modifier_in_object",
        }
      : null,
  };
}

export function patchOperandInCompositeGeometry(
  rawGeometry: unknown,
  draft: GeometryNodeSpecDraft,
): JsonObject | null {
  const shouldPatchArray =
    draft.isArray3D || (draft.array3dConfig !== null && draft.array3dConfig !== undefined);
  return patchGeometryNodeAtPath(rawGeometry, draft.operandId, {
    label: draft.canEditOperandMeta ? draft.label : undefined,
    enabled: draft.canEditOperandMeta ? draft.enabled : undefined,
    symmetryAxis: draft.symmetryAxis,
    sizeX: draft.sizeX,
    sizeY: draft.sizeY,
    sizeZ: draft.sizeZ,
    radius: draft.radius,
    height: draft.height,
    bottomRadius: draft.bottomRadius,
    topRadius: draft.topRadius,
    majorRadius: draft.majorRadius,
    minorRadius: draft.minorRadius,
    translation: draft.translation,
    eulerDeg: draft.eulerDeg,
    scale: draft.scale,
    ...(shouldPatchArray ? { array3dConfig: draft.array3dConfig } : {}),
  });
}

export function GeometryNodeInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const { sessionIdentity } = useSessionScopedResourceKey(MODEL_SCENE_PATH);
  const scene = useSceneResource();
  const [actionBusy, setActionBusy] = useState(false);
  const [arrayUnit, setArrayUnit] = useState<DisplayLengthUnit>("nm");
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

  const sceneObj = useMemo(
    () => scene.data?.objects?.find((item) => item.id === baseline.objectId) ?? null,
    [baseline.objectId, scene.data?.objects],
  );
  const resolvedTargetNode = useMemo(
    () =>
      sceneObj && baseline.operandId
        ? resolveGeometryNodeByPath(sceneObj.geometry, baseline.operandId)
        : null,
    [baseline.operandId, sceneObj],
  );
  const arrayChildBounds = useMemo(
    () => resolveArray3DChildBoundsMeters(sceneObj, resolvedTargetNode?.geometry ?? sceneObj?.geometry),
    [resolvedTargetNode?.geometry, sceneObj],
  );

  const dirtyRef = useRef(false);
  const requestApplyRef = useRef<() => Promise<boolean>>(async () => false);

  const handleSelectNode = useCallback(
    (next: Omit<Selection, "moduleSource">) => {
      kernel.selection.set(next, "inspector");
    },
    [kernel.selection],
  );

  const runQuickAction = useCallback(
    async (
      label: string,
      op: (rev: number) => Promise<{ committed_scene?: SceneResource; scene_revision?: number }>,
    ) => {
      if (actionBusy || sceneRevision === null) return;
      setActionBusy(true);
      try {
        if (dirtyRef.current) {
          const flushed = await requestApplyRef.current();
          if (!flushed) return;
        }
        await commitGeometryStackTransaction({
          kernel,
          label,
          sceneData: scene.data,
          sessionScopeKey,
          execute: ({ baseRevision }) => op(baseRevision ?? sceneRevision),
        });
      } finally {
        setActionBusy(false);
      }
    },
    [actionBusy, kernel, scene.data, sceneRevision, sessionScopeKey],
  );

  const spec = useMemo<InspectorSpec<GeometryNodeSpecDraft>>(
    () => ({
      id: "geometry-node-inspector",
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
          ...baseline.ancestors.map((ancestor, idx) => ({
            id: `ancestor-${idx}`,
            label: ancestor.label,
            selection: buildGeometryNodeSelection(
              baseline.objectId,
              ancestor.path,
              ancestor.label,
            ),
          })),
          {
            id: "node",
            label: baseline.label,
          },
        ],
        canFitView: baseline.exists,
      },
      identity: {
        domain: "geometry",
        icon: baseline.isArray3D ? Grid3X3 : Layers,
        kindLabel: baseline.isArray3D
          ? "Array 3D modifier node"
          : baseline.depth > 0
            ? "Nested geometry node"
            : "CSG geometry operand",
        statePill: (draft) =>
          !draft.exists
            ? { label: "Missing", tone: "warn" }
            : draft.enabled
              ? { label: "Active", tone: "ok" }
              : { label: "Disabled", tone: "stale" },
        title: (draft) => draft.label,
      },
      facts: (draft): readonly InspectorFact[] =>
        draft.exists
          ? [
              { id: "role", label: "Role", value: draft.roleBadge },
              { id: "primitive", label: "Geometry", value: draft.primitiveKind },
              {
                id: "stack",
                label: draft.depth > 0 ? "Depth" : "Stack",
                value:
                  draft.depth > 0
                    ? `Level ${draft.depth + 1} (#${draft.index + 1}/${draft.total})`
                    : `#${draft.index + 1} / ${draft.total}`,
              },
              { id: "state", label: "State", value: draft.enabled ? "Active" : "Disabled" },
            ]
          : [{ id: "status", label: "Status", value: "Node missing" }],
      sections: [
        {
          id: "geometry-node-state",
          title: "Operand state & stack",
          icon: Layers,
          defaultOpen: true,
          showWhen: (draft) =>
            !draft.exists || draft.canEditOperandMeta || draft.isTopLevelBooleanOperand,
          rows: [
            {
              key: "label",
              type: "text",
              label: "Operand label",
              showWhen: (draft) => draft.canEditOperandMeta,
            },
            {
              key: "enabled",
              type: "switch",
              label: "Include operand in CSG evaluation",
              showWhen: (draft) => draft.canEditOperandMeta,
            },
            {
              type: "custom",
              wide: true,
              showWhen: (draft) => draft.isTopLevelBooleanOperand,
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
                    {([-1, 1] as const).map((delta) => {
                      const isUp = delta < 0;
                      const Icon = isUp ? ArrowUp : ArrowDown;
                      const outOfBounds = isUp
                        ? ctx.draft.index <= 0
                        : ctx.draft.index >= ctx.draft.total - 1;
                      return (
                        <Button
                          key={delta}
                          disabled={actionBusy || !ctx.draft.exists || outOfBounds || sceneRevision === null}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            const ids = parseCompositeGeometry(sceneObj?.geometry).operands.map(
                              (item) => item.operandId,
                            );
                            const nextIdx = ctx.draft.index + delta;
                            if (nextIdx < 0 || nextIdx >= ids.length || sceneRevision === null) return;
                            const nextIds = [...ids];
                            const [moved] = nextIds.splice(ctx.draft.index, 1);
                            nextIds.splice(nextIdx, 0, moved);
                            void runQuickAction(
                              `Move operand ${ctx.draft.label} ${isUp ? "up" : "down"}`,
                              (rev) =>
                                updateBooleanOperandsTransaction(
                                  kernel.api,
                                  {
                                    base_revision: rev,
                                    object_id: ctx.draft.objectId,
                                    reorder_operand_ids: nextIds,
                                  },
                                  sessionScopeKey ? { sessionScopeKey } : undefined,
                                ),
                            );
                          }}
                        >
                          <Icon size={13} />
                          <span>{isUp ? "Move Up" : "Move Down"}</span>
                        </Button>
                      );
                    })}
                    <Button
                      disabled={actionBusy || !ctx.draft.exists || sceneRevision === null}
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        if (sceneRevision === null) return;
                        void runQuickAction(
                          `Extract ${ctx.draft.label} as object`,
                          (rev) =>
                            separateObjectTransaction(
                              kernel.api,
                              {
                                base_revision: rev,
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
          title: baseline.isArray3D
            ? "Modifier local transform"
            : "Primitive dimensions & local transform",
          icon: Box,
          defaultOpen: true,
          showWhen: (draft) => draft.exists,
          rows: [
            {
              key: "symmetryAxis",
              type: "segmented",
              label: "Principal axis",
              showWhen: (d) =>
                d.primitiveKind === "Cylinder" ||
                d.primitiveKind === "Cone" ||
                d.primitiveKind === "Torus",
              options: [
                { value: "x", label: "X" },
                { value: "y", label: "Y" },
                { value: "z", label: "Z" },
              ],
            },
            {
              key: "sizeX",
              type: "quantity",
              label: "Extent X",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "Box" || d.primitiveKind === "Ellipsoid",
              validate: (v) => (v > 0 ? null : "Extent X must be strictly positive."),
            },
            {
              key: "sizeY",
              type: "quantity",
              label: "Extent Y",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "Box" || d.primitiveKind === "Ellipsoid",
              validate: (v) => (v > 0 ? null : "Extent Y must be strictly positive."),
            },
            {
              key: "sizeZ",
              type: "quantity",
              label: "Thickness Z",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "Box" || d.primitiveKind === "Ellipsoid",
              validate: (v) => (v > 0 ? null : "Thickness Z must be strictly positive."),
            },
            {
              key: "radius",
              type: "quantity",
              label: "Radius",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "Cylinder" || d.primitiveKind === "Sphere",
              validate: (v) => (v > 0 ? null : "Radius must be strictly positive."),
            },
            {
              key: "bottomRadius",
              type: "quantity",
              label: "Bottom radius",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              showWhen: (d) => d.primitiveKind === "Cone",
              validate: (v, d) =>
                v < 0
                  ? "Bottom radius must be non-negative."
                  : v + d.topRadius <= 0
                    ? "At least one cone radius must be strictly positive."
                    : null,
            },
            {
              key: "topRadius",
              type: "quantity",
              label: "Top radius",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              showWhen: (d) => d.primitiveKind === "Cone",
              validate: (v, d) =>
                v < 0
                  ? "Top radius must be non-negative."
                  : d.bottomRadius + v <= 0
                    ? "At least one cone radius must be strictly positive."
                    : null,
            },
            {
              key: "majorRadius",
              type: "quantity",
              label: "Major radius",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "Torus",
              validate: (v, d) => validateTorusRadii(v, d.minorRadius),
            },
            {
              key: "minorRadius",
              type: "quantity",
              label: "Minor radius",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "Torus",
              validate: (v, d) => validateTorusRadii(d.majorRadius, v),
            },
            {
              key: "height",
              type: "quantity",
              label: "Height",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.primitiveKind === "Cylinder" || d.primitiveKind === "Cone",
              validate: (v) => (v > 0 ? null : "Height must be strictly positive."),
            },
            {
              key: "translation",
              type: "vector3",
              label: "Local translation",
              units: LENGTH_UNITS,
              defaultDisplayUnit: "nm",
            },
            {
              key: "eulerDeg",
              type: "vector3",
              label: "Rotation (Euler XYZ)",
              unitSuffix: "\u00b0",
              axisPresets: true,
            },
            {
              key: "scale",
              type: "vector3",
              label: "Scale (sx, sy, sz)",
              validate: (vec) =>
                vec.some((c) => !Number.isFinite(c) || c <= 0)
                  ? "All scale factors must be strictly positive."
                  : null,
            },
          ],
        },
        {
          id: "geometry-node-array-3d",
          title: baseline.isArray3D ? "Array 3D modifier & base unit" : "Array 3D on operand",
          icon: Grid3X3,
          defaultOpen: baseline.isArray3D,
          showWhen: (draft) =>
            draft.exists && (draft.isTopLevelBooleanOperand || draft.isArray3D),
          rows: [
            {
              type: "custom",
              wide: true,
              showWhen: (draft) => draft.isArray3D && Boolean(draft.arrayChildPath),
              render: (ctx) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--fm-border-subtle)] bg-[var(--fm-surface-subtle)] px-2.5 py-2"
                  data-slot="array3d-unit-jump-bar"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-[var(--fm-text-primary)]">
                      Unit: {ctx.draft.arrayUnitSummary ?? "Base Unit"}
                    </div>
                    <div className="text-xs text-[var(--fm-text-muted)]">
                      Edit dimensions or transform on the repeated unit geometry directly.
                    </div>
                  </div>
                  <Button
                    className="shrink-0 whitespace-nowrap"
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      const childPath = ctx.draft.arrayChildPath;
                      if (!childPath) return;
                      const obj = scene.data?.objects?.find(
                        (item) => item.id === ctx.draft.objectId,
                      );
                      const childResolved = resolveGeometryNodeByPath(obj?.geometry, childPath);
                      handleSelectNode(
                        buildGeometryNodeSelection(
                          ctx.draft.objectId,
                          childPath,
                          childResolved?.label ?? "Unit Geometry",
                        ),
                      );
                    }}
                  >
                    <span>Edit Unit Geometry</span>
                    <ArrowRight aria-hidden="true" size={13} />
                  </Button>
                </div>
              ),
            },
            {
              key: "array3dConfig",
              label: "Array 3D lattice",
              type: "custom",
              wide: true,
              showWhen: (draft) => draft.isTopLevelBooleanOperand || draft.isArray3D,
              validate: (cfg) => {
                const typed = cfg as Array3DDraftConfig | null;
                if (!typed) return null;
                const count = computeArray3DInstanceCount(typed.axes);
                const status = computeArray3DBudgetStatus(count, typed.realization);
                return status.level === "error" ? status.message : null;
              },
              render: (ctx) =>
                ctx.draft.array3dConfig ? (
                  <Array3DLatticeTableSection
                    childBounds={arrayChildBounds}
                    disableExpandToObjects
                    disabled={actionBusy}
                    unit={arrayUnit}
                    value={ctx.draft.array3dConfig}
                    onChange={(nextCfg) => ctx.setField("array3dConfig", nextCfg)}
                    onRemoveModifier={() => ctx.setField("array3dConfig", null)}
                    onUnitChange={setArrayUnit}
                  />
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-[var(--fm-text-muted)]">
                      Repeat this operand along a 1D, 2D, or 3D lattice.
                    </span>
                    <Button
                      className="shrink-0 whitespace-nowrap"
                      disabled={actionBusy || sceneRevision === null}
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        ctx.setField("array3dConfig", {
                          axes: defaultArray3DAxes(),
                          mergeOverlapping: false,
                          realization: "modifier_in_object",
                        })
                      }
                    >
                      <Grid3X3 aria-hidden="true" size={13} />
                      <span>Add Array 3D Modifier</span>
                    </Button>
                  </div>
                ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Geometry node matches committed CSG tree",
        lockReason: (d) =>
          !d.exists
            ? "Select an existing geometry node in the Geometry Tree."
            : sceneRevision === null
              ? "Refetch the scene before editing geometry nodes."
              : null,
        onApply: async (draft) => {
          const obj = scene.data?.objects?.find((item) => item.id === draft.objectId);
          const nextGeometry = patchOperandInCompositeGeometry(obj?.geometry, draft);
          if (!nextGeometry || sceneRevision === null) {
            throw new Error("Could not patch geometry node in parent composite tree.");
          }
          await commitGeometryStackTransaction({
            kernel,
            label: `Edit geometry node ${draft.label}`,
            sceneData: scene.data,
            sessionScopeKey,
            execute: ({ baseRevision }) =>
              patchObjectGeometryTransaction(
                kernel.api,
                draft.objectId,
                {
                  base_revision: baseRevision ?? sceneRevision,
                  geometry: nextGeometry,
                },
                sessionScopeKey ? { sessionScopeKey } : undefined,
              ),
          });
          return true;
        },
      },
    }),
    [
      actionBusy,
      arrayChildBounds,
      arrayUnit,
      baseline.ancestors,
      baseline.depth,
      baseline.exists,
      baseline.isArray3D,
      baseline.label,
      baseline.objectId,
      baseline.objectName,
      ghostVisible,
      handleSelectNode,
      kernel,
      runQuickAction,
      scene.data,
      sceneObj,
      sceneRevision,
      sessionScopeKey,
    ],
  );

  const controller = useInspectorSpecController(spec, selection, baseline);

  useLayoutEffect(() => {
    dirtyRef.current = controller.dirty;
    requestApplyRef.current = controller.requestApply;
  }, [controller.dirty, controller.requestApply]);

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
