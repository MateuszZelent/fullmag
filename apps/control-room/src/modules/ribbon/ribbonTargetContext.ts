import { Box, Crosshair, Eye, Grid3X3, Layers3, Magnet, Settings2, Target } from "lucide-react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { FdmMultilayerLayoutResource, SceneResource } from "@/kernel/api/apiTypes";
import type { CommandContext } from "@/kernel/commands/commandTypes";
import {
  canonicalVisualizationSceneObjectId,
  type Selection,
} from "@/kernel/selection/selectionTypes";
import {
  displayLabelForVisualizationTarget,
  isFdmUniverseOutsideSupportTarget,
  type VisualizationTargetRef,
} from "@/kernel/visualization/ObjectVisualizationController";
import { resolveFdmMultilayerAirboxTarget } from "@/shared/domain/mesh/fdmMultilayerAirboxTarget";
import type { SceneObjectPresentationRole } from "@/shared/domain/physics/objectMagneticModel";

import { C, icon, separator } from "./ribbonCommon";
import {
  RIBBON_INSPECTOR_OPEN_AIRBOX_SETTINGS_COMMAND,
  RIBBON_INSPECTOR_OPEN_VISUALIZATION_COMMAND,
  RIBBON_SELECTION_SELECT_TARGET_COMMAND,
  openVisualizationInspectorCommandInput,
  selectRibbonTargetCommandInput,
} from "./ribbonCommands";
import type { RibbonGroup, RibbonMenuNode } from "./ribbonTypes";

export interface RibbonSceneObjectEntry {
  id: string;
  label: string;
  role: SceneObjectPresentationRole;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeRole(value: unknown): SceneObjectPresentationRole {
  if (
    value === "antenna" ||
    value === "magnet" ||
    value === "conductor" ||
    value === "electrode" ||
    value === "auxiliary"
  ) {
    return value;
  }
  return "magnet";
}

export function extractRibbonSceneObjects(
  scene: SceneResource | null | undefined,
  commandContext?: CommandContext,
): RibbonSceneObjectEntry[] {
  const source =
    scene ??
    (commandContext?.resourceData?.[MODEL_SCENE_PATH] as SceneResource | null | undefined);
  const record = asRecord(source);
  const rawObjects = Array.isArray(record?.objects) ? record.objects : [];
  const entries: RibbonSceneObjectEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of rawObjects) {
    const obj = asRecord(candidate);
    const id = typeof obj?.id === "string" ? obj.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name =
      typeof obj?.name === "string" && obj.name.trim().length > 0
        ? obj.name.trim()
        : id;
    entries.push({
      id,
      label: name,
      role: normalizeRole(obj?.role),
    });
  }
  return entries;
}

export function resolveSceneObjectLabel(
  objectId: string | null | undefined,
  sceneObjects: readonly RibbonSceneObjectEntry[],
  fallbackLabel?: string | null,
): string | null {
  if (!objectId) return fallbackLabel ?? null;
  const canonicalId = canonicalVisualizationSceneObjectId(objectId);
  const matched = sceneObjects.find(
    (entry) =>
      entry.id === objectId ||
      canonicalVisualizationSceneObjectId(entry.id) === canonicalId,
  );
  return matched?.label ?? fallbackLabel ?? objectId;
}

export function isAirboxLikeVisualizationTarget(
  target: VisualizationTargetRef | null | undefined,
): boolean {
  return Boolean(
    target &&
      (target.kind === "airbox" || isFdmUniverseOutsideSupportTarget(target)),
  );
}

export function isFdmMultilayerMissingAirboxCarrier(
  discretization: "fdm" | "fem" | "unknown",
  fdmMultilayerLayout: FdmMultilayerLayoutResource | null | undefined,
): boolean {
  if (discretization !== "fdm" || !fdmMultilayerLayout) return false;
  const layers = Array.isArray(fdmMultilayerLayout.layers)
    ? fdmMultilayerLayout.layers
    : [];
  if (layers.length === 0) return false;
  return resolveFdmMultilayerAirboxTarget(fdmMultilayerLayout) === null;
}

export function activeViewTargetSummary(
  target: VisualizationTargetRef | null,
  sceneObjects: readonly RibbonSceneObjectEntry[],
): {
  detail: string;
  isAirbox: boolean;
  label: string;
  objectEntry: RibbonSceneObjectEntry | null;
  radioValue: string;
} {
  if (!target) {
    return {
      detail: "Default",
      isAirbox: false,
      label: "All Objects",
      objectEntry: null,
      radioValue: "__all__",
    };
  }
  if (isAirboxLikeVisualizationTarget(target)) {
    return {
      detail: "Universe",
      isAirbox: true,
      label: "Airbox",
      objectEntry: null,
      radioValue: "airbox",
    };
  }
  const rawId = target.id.startsWith("object:")
    ? target.id.slice("object:".length)
    : target.id;
  const canonicalId = canonicalVisualizationSceneObjectId(rawId);
  const matched =
    sceneObjects.find(
      (entry) =>
        entry.id === rawId ||
        canonicalVisualizationSceneObjectId(entry.id) === canonicalId,
    ) ?? null;
  const label =
    matched?.label ??
    displayLabelForVisualizationTarget(target);
  const detail =
    target.kind === "region"
      ? "Region"
      : target.kind === "part"
        ? "Mesh Part"
        : matched?.role && matched.role !== "magnet"
          ? matched.role
          : "Object";
  return {
    detail,
    isAirbox: false,
    label,
    objectEntry: matched,
    radioValue: target.kind === "object" ? `object:${matched?.id ?? canonicalId}` : target.id,
  };
}

export function buildViewTargetContextGroup({
  discretization,
  fdmMultilayerLayout,
  sceneObjects,
  target,
}: {
  discretization: "fdm" | "fem" | "unknown";
  fdmMultilayerLayout?: FdmMultilayerLayoutResource | null;
  sceneObjects: readonly RibbonSceneObjectEntry[];
  target: VisualizationTargetRef | null;
}): RibbonGroup {
  const summary = activeViewTargetSummary(target, sceneObjects);
  const missingMultilayerAirbox = isFdmMultilayerMissingAirboxCarrier(
    discretization,
    fdmMultilayerLayout,
  );
  const radioItems: Array<{
    commandId: string;
    commandInput: unknown;
    label: string;
    value: string;
  }> = [
    {
      value: "__all__",
      label: "All Objects (Default)",
      commandId: RIBBON_SELECTION_SELECT_TARGET_COMMAND,
      commandInput: selectRibbonTargetCommandInput({
        targetKind: "all",
        tab: "view",
      }),
    },
    {
      value: "airbox",
      label: "Airbox (Universe)",
      commandId: RIBBON_SELECTION_SELECT_TARGET_COMMAND,
      commandInput: selectRibbonTargetCommandInput({
        targetKind: "airbox",
        tab: "view",
      }),
    },
    ...sceneObjects.map((entry) => ({
      value: `object:${entry.id}`,
      label: entry.role === "magnet" ? entry.label : `${entry.label} (${entry.role})`,
      commandId: RIBBON_SELECTION_SELECT_TARGET_COMMAND,
      commandInput: selectRibbonTargetCommandInput({
        objectId: entry.id,
        objectLabel: entry.label,
        objectRole: entry.role,
        tab: "view",
        targetKind: "object",
      }),
    })),
  ];

  const targetMenu: RibbonMenuNode[] = [
    {
      type: "label",
      id: "view-target:header",
      label: "Visualization target",
      badge: summary.label,
    },
    {
      type: "radio-group",
      id: "view-target:radio",
      value: summary.radioValue,
      items: radioItems,
    },
    separator("view-target:sep-airbox"),
    {
      type: "item",
      id: "view-target:open-airbox-settings",
      label: "Open Airbox Settings",
      commandId: RIBBON_INSPECTOR_OPEN_AIRBOX_SETTINGS_COMMAND,
      tooltip: missingMultilayerAirbox
        ? "Author an Airbox carrier for FDM Multilayer stray-field visualization"
        : "Open Airbox extent and universe settings in Inspector",
    },
  ];

  const inspectorObjectId =
    !summary.isAirbox && target?.kind === "object"
      ? summary.objectEntry?.id ??
        canonicalVisualizationSceneObjectId(
          target.id.startsWith("object:") ? target.id.slice("object:".length) : target.id,
        )
      : null;
  const canOpenInspector = summary.isAirbox || Boolean(inspectorObjectId);
  const openInspectorInput = summary.isAirbox
    ? openVisualizationInspectorCommandInput({ targetKind: "airbox" })
    : inspectorObjectId
      ? openVisualizationInspectorCommandInput({
          objectId: inspectorObjectId,
          objectLabel: summary.label,
          objectRole: summary.objectEntry?.role,
          targetKind: "object",
        })
      : undefined;

  return {
    id: "view-target-context",
    title: "Target",
    subtitle: summary.label,
    tone: "selection",
    actions: [
      {
        id: "view-target-selector",
        icon: icon(summary.isAirbox ? Box : Target),
        label: summary.label,
        iconColor: summary.isAirbox ? C.blue : C.teal,
        contextMeta: {
          badge: "Target",
          detail: summary.detail,
        },
        tooltip: `Active visualization target: ${summary.label}. Click to switch between All Objects, Airbox, or an individual object.`,
        menu: targetMenu,
      },
      {
        id: "view-target-airbox-shortcut",
        icon: icon(Box),
        label: "Airbox",
        active: summary.isAirbox,
        iconColor: C.blue,
        commandId: RIBBON_SELECTION_SELECT_TARGET_COMMAND,
        commandInput: selectRibbonTargetCommandInput({
          targetKind: "airbox",
          tab: "view",
        }),
        tooltip: "Switch ribbon View target to Airbox (Universe) so Vectors, Wireframe, Bounds & Points control Airbox",
      },
      {
        id: "view-open-target-inspector",
        icon: icon(Eye),
        label: summary.isAirbox
          ? "Airbox Viz"
          : inspectorObjectId
            ? "Object Viz"
            : "Target Viz",
        iconColor: C.lavender,
        disabled: !canOpenInspector,
        commandId: RIBBON_INSPECTOR_OPEN_VISUALIZATION_COMMAND,
        commandInput: openInspectorInput,
        tooltip: summary.isAirbox
          ? "Open Airbox Visualization in Inspector"
          : inspectorObjectId
            ? `Open ${summary.label} Visualization in Inspector`
            : "Select an object or Airbox in Target to open its Visualization Inspector",
      },
      ...(missingMultilayerAirbox
        ? [
            {
              id: "view-open-airbox-settings",
              icon: icon(Settings2),
              label: "Airbox Settings",
              iconColor: C.peach,
              commandId: RIBBON_INSPECTOR_OPEN_AIRBOX_SETTINGS_COMMAND,
              tooltip:
                "FDM Multilayer has no Airbox carrier yet — open Airbox Settings to configure exterior padding",
            },
          ]
        : []),
    ],
  };
}

export function buildGeometryTargetContextGroup({
  sceneObjects,
  selection,
}: {
  sceneObjects: readonly RibbonSceneObjectEntry[];
  selection?: Selection | null;
}): RibbonGroup {
  const orderedIds =
    selection?.selectedObjectIds && selection.selectedObjectIds.length > 0
      ? [...selection.selectedObjectIds]
      : selection?.objectId
        ? [selection.objectId]
        : [];
  const isMulti = orderedIds.length >= 2;
  const baseId = orderedIds[0] ?? null;
  const baseLabel = baseId
    ? resolveSceneObjectLabel(baseId, sceneObjects, selection?.label) ?? baseId
    : null;
  const toolLabels = orderedIds
    .slice(1)
    .map((id) => resolveSceneObjectLabel(id, sceneObjects) ?? id);
  const selectorLabel = isMulti
    ? `Base [A]: ${baseLabel} · Tools [B]: ${toolLabels.join(", ")}`
    : baseLabel ?? "None selected";
  const badge = isMulti ? "Boolean CSG" : "Target";
  const detail = isMulti
    ? `${orderedIds.length} objects · A → B`
    : baseLabel
      ? "Single object"
      : "Pick object";

  const menuNodes: RibbonMenuNode[] = [
    {
      type: "label",
      id: "geometry-target:header",
      label: isMulti ? "Boolean CSG Operands" : "Geometry Target",
      badge: isMulti ? `${orderedIds.length} selected` : baseLabel ?? "none",
    },
    ...(isMulti
      ? [
          {
            type: "status" as const,
            id: "geometry-target:base",
            label: "Base [A]",
            value: baseLabel ?? "",
            tone: "success" as const,
          },
          {
            type: "status" as const,
            id: "geometry-target:tools",
            label: "Tools [B]",
            value: toolLabels.join(", "),
            tone: "neutral" as const,
          },
          separator("geometry-target:sep-multi"),
        ]
      : []),
    ...(sceneObjects.length > 0
      ? [
          {
            type: "radio-group" as const,
            id: "geometry-target:radio",
            label: "Select single target",
            value: baseId ? `object:${baseId}` : "",
            items: sceneObjects.map((entry) => ({
              value: `object:${entry.id}`,
              label: entry.role === "magnet" ? entry.label : `${entry.label} (${entry.role})`,
              commandId: RIBBON_SELECTION_SELECT_TARGET_COMMAND,
              commandInput: selectRibbonTargetCommandInput({
                objectId: entry.id,
                objectLabel: entry.label,
                objectRole: entry.role,
                tab: "geometry",
                targetKind: "object",
              }),
            })),
          },
        ]
      : [
          {
            type: "status" as const,
            id: "geometry-target:empty",
            label: "Scene objects",
            value: "Create a shape to target it",
            tone: "neutral" as const,
          },
        ]),
  ];

  return {
    id: "geometry-target-context",
    title: "Target",
    subtitle: isMulti ? `A: ${baseLabel}` : baseLabel ?? "none",
    tone: "selection",
    actions: [
      {
        id: "geometry-target-selector",
        icon: icon(Crosshair),
        label: selectorLabel,
        iconColor: C.green,
        contextMeta: { badge, detail },
        tooltip: isMulti
          ? `Boolean CSG operands — Base [A]: ${baseLabel} · Tools [B]: ${toolLabels.join(", ")}`
          : baseLabel
            ? `Active Geometry target: ${baseLabel}. Shift+Click in Explorer or Viewport to add Tool [B] operands for Boolean CSG.`
            : "No object selected. Pick an object from this menu or click one in Explorer/Viewport.",
        menu: menuNodes,
      },
    ],
  };
}

export function buildMaterialsTargetContextGroup({
  sceneObjects,
  selection,
}: {
  sceneObjects: readonly RibbonSceneObjectEntry[];
  selection?: Selection | null;
}): {
  group: RibbonGroup;
  targetObject: RibbonSceneObjectEntry | null;
  targetLabel: string | null;
} {
  const selectedId = selection?.objectId ?? null;
  const matched: RibbonSceneObjectEntry | null = selectedId
    ? sceneObjects.find((entry) => entry.id === selectedId) ?? {
        id: selectedId,
        label: selection?.label ?? selectedId,
        role: "magnet",
      }
    : null;
  const regionId =
    selection?.ref?.type === "scene-object" ? selection.ref.regionId ?? null : null;
  const targetLabel = matched
    ? regionId
      ? `${matched.label} / ${regionId}`
      : matched.label
    : null;

  const menuNodes: RibbonMenuNode[] = [
    {
      type: "label",
      id: "materials-target:header",
      label: "Material & Texture Target",
      badge: targetLabel ?? "none",
    },
    ...(sceneObjects.length > 0
      ? [
          {
            type: "radio-group" as const,
            id: "materials-target:radio",
            value: matched ? `object:${matched.id}` : "",
            items: sceneObjects.map((entry) => ({
              value: `object:${entry.id}`,
              label: entry.role === "magnet" ? entry.label : `${entry.label} (${entry.role})`,
              disabled: entry.role !== "magnet",
              tooltip:
                entry.role !== "magnet"
                  ? `Non-magnetic object (${entry.role})`
                  : `Target ${entry.label} for Material & Magnetic Texture actions`,
              commandId: RIBBON_SELECTION_SELECT_TARGET_COMMAND,
              commandInput: selectRibbonTargetCommandInput({
                objectId: entry.id,
                objectLabel: entry.label,
                objectRole: entry.role,
                tab: "materials",
                targetKind: "object",
              }),
            })),
          },
        ]
      : [
          {
            type: "status" as const,
            id: "materials-target:empty",
            label: "Objects",
            value: "No authored objects in scene",
          },
        ]),
  ];

  const group: RibbonGroup = {
    id: "materials-target-context",
    title: "Target",
    subtitle: targetLabel ?? "select object",
    tone: "selection",
    actions: [
      {
        id: "materials-target-selector",
        icon: icon(Magnet),
        label: targetLabel ?? "Select object",
        iconColor: "var(--fm-hue-material)",
        contextMeta: {
          badge: "Target",
          detail: regionId ? "Region texture" : matched ? "Magnetic object" : "Pick target",
        },
        tooltip: targetLabel
          ? `Active Materials target: ${targetLabel}. Presets apply immediately (with Undo) to this target.`
          : "Select a magnetic object before applying Material or Magnetic Texture presets.",
        menu: menuNodes,
      },
    ],
  };

  return { group, targetLabel, targetObject: matched };
}

export function buildPhysicsTargetContextGroup({
  sceneObjects,
  selection,
}: {
  sceneObjects: readonly RibbonSceneObjectEntry[];
  selection: Selection;
}): {
  group: RibbonGroup;
  targetLabel: string | null;
} {
  const selectedId = selection.objectId ?? null;
  const matched = selectedId
    ? sceneObjects.find((entry) => entry.id === selectedId) ?? {
        id: selectedId,
        label: selection.label ?? selectedId,
        role: "magnet" as const,
      }
    : null;
  const targetLabel = matched?.label ?? null;

  const menuNodes: RibbonMenuNode[] = [
    {
      type: "label",
      id: "physics-target:header",
      label: "Physics Target",
      badge: targetLabel ?? "Global",
    },
    {
      type: "radio-group",
      id: "physics-target:radio",
      value: matched ? `object:${matched.id}` : "__all__",
      items: [
        {
          value: "__all__",
          label: "Global Model (Demag / Field Drives)",
          commandId: RIBBON_SELECTION_SELECT_TARGET_COMMAND,
          commandInput: selectRibbonTargetCommandInput({
            tab: "physics",
            targetKind: "all",
          }),
        },
        ...sceneObjects.map((entry) => ({
          value: `object:${entry.id}`,
          label: entry.role === "magnet" ? entry.label : `${entry.label} (${entry.role})`,
          commandId: RIBBON_SELECTION_SELECT_TARGET_COMMAND,
          commandInput: selectRibbonTargetCommandInput({
            objectId: entry.id,
            objectLabel: entry.label,
            objectRole: entry.role,
            tab: "physics",
            targetKind: "object",
          }),
        })),
      ],
    },
  ];

  const group: RibbonGroup = {
    id: "physics-target-context",
    title: "Target",
    subtitle: targetLabel ? "Local · Global: Demag" : "Global: Demag",
    tone: "selection",
    actions: [
      {
        id: "physics-target-selector",
        icon: icon(Target),
        label: targetLabel ?? "Global Model",
        iconColor: C.lavender,
        contextMeta: {
          badge: targetLabel ? "Local Target" : "Scope",
          detail: targetLabel ? "Exchange · Ku · DMI" : "Global terms only",
        },
        tooltip: targetLabel
          ? `Local Hamiltonian terms (Exchange, Anisotropy, DMI) target ${targetLabel}. Global Demag applies to the whole model.`
          : "No object selected. Pick a magnetic object to configure local terms (Exchange, Anisotropy, DMI); Global Physics configures Demag & Field Drives.",
        menu: menuNodes,
      },
    ],
  };

  return { group, targetLabel };
}

export function buildMeshTargetContextGroup({
  discretization,
  sceneObjects,
  selection,
}: {
  discretization: "fdm" | "fem" | "unknown";
  sceneObjects: readonly RibbonSceneObjectEntry[];
  selection: Selection;
}): RibbonGroup {
  const selectedId = selection.objectId ?? null;
  const matched = selectedId
    ? sceneObjects.find((entry) => entry.id === selectedId) ?? {
        id: selectedId,
        label: selection.label ?? selectedId,
        role: "magnet" as const,
      }
    : null;
  const targetLabel = matched?.label ?? null;
  const isFdm = discretization === "fdm";
  const isUnknown = discretization === "unknown";

  const menuNodes: RibbonMenuNode[] = [
    {
      type: "label",
      id: "mesh-target:header",
      label: isFdm ? "FDM Grid Scope" : "FEM Mesh Target",
      badge: isFdm ? "Shared Grid" : targetLabel ?? "Shared Domain",
    },
    ...(isFdm
      ? [
          {
            type: "status" as const,
            id: "mesh-target:fdm-scope",
            label: "Discretization",
            value: "Shared FDM Grid",
            tone: "success" as const,
          },
          {
            type: "item" as const,
            id: "mesh-target:open-overview",
            label: "Open Mesh Overview",
            commandId: "mesh.open-overview",
          },
        ]
      : isUnknown
        ? [
            {
              type: "status" as const,
              id: "mesh-target:lane-status",
              label: "Discretization",
              value: "Resolving session lane",
              tone: "warning" as const,
            },
          ]
        : sceneObjects.length === 0
          ? [
              {
                type: "status" as const,
                id: "mesh-target:fem-scope",
                label: "Scope",
                value: "Shared Domain",
                tone: "neutral" as const,
              },
            ]
          : []),
    ...(sceneObjects.length > 0
      ? [
          ...(isFdm ? [separator("mesh-target:sep-objects")] : []),
          {
            type: "radio-group" as const,
            id: "mesh-target:radio",
            label: isFdm ? "Inspect object" : "Select mesh target",
            value: matched ? `object:${matched.id}` : "__all__",
            items: [
              {
                value: "__all__",
                label: isFdm ? "Shared FDM Grid" : "Shared Domain (All Objects)",
                commandId: RIBBON_SELECTION_SELECT_TARGET_COMMAND,
                commandInput: selectRibbonTargetCommandInput({
                  tab: "mesh",
                  targetKind: "all",
                }),
              },
              ...sceneObjects.map((entry) => ({
                value: `object:${entry.id}`,
                label: entry.role === "magnet" ? entry.label : `${entry.label} (${entry.role})`,
                commandId: RIBBON_SELECTION_SELECT_TARGET_COMMAND,
                commandInput: selectRibbonTargetCommandInput({
                  objectId: entry.id,
                  objectLabel: entry.label,
                  objectRole: entry.role,
                  tab: "mesh",
                  targetKind: "object",
                }),
              })),
            ],
          },
        ]
      : []),
  ];

  return {
    id: "mesh-target-context",
    title: "Scope",
    subtitle: isFdm ? "Shared FDM Grid" : targetLabel ?? "Shared Domain",
    tone: "selection",
    actions: [
      {
        id: "mesh-scope-selector",
        icon: icon(isFdm ? Grid3X3 : Layers3),
        label: isUnknown
          ? "Resolving lane…"
          : isFdm
            ? "Shared FDM Grid"
            : targetLabel ?? "Shared Domain",
        iconColor: isFdm ? C.green : C.blue,
        contextMeta: {
          badge: isFdm ? "Scope" : targetLabel ? "Target" : "Scope",
          detail: isUnknown
            ? "Waiting for status"
            : isFdm
              ? targetLabel
                ? `Selected: ${targetLabel}`
                : "Structured grid"
              : targetLabel
                ? "Object mesh"
                : "All objects + Airbox",
        },
        tooltip: isFdm
          ? "FDM uses one shared structured grid across all authored objects."
          : targetLabel
            ? `Active FEM mesh target: ${targetLabel}. Build Selected meshes this object; Build All builds the shared domain.`
            : "FEM shared domain mesh scope. Pick an object to target per-object mesh build.",
        menu: menuNodes,
      },
    ],
  };
}
