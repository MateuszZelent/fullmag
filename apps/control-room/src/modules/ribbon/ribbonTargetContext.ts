import { Eye, Settings2 } from "lucide-react";

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

import { C, icon } from "./ribbonCommon";
import {
  RIBBON_INSPECTOR_OPEN_AIRBOX_SETTINGS_COMMAND,
  RIBBON_INSPECTOR_OPEN_VISUALIZATION_COMMAND,
  openVisualizationInspectorCommandInput,
} from "./ribbonCommands";
import type { RibbonAction } from "./ribbonTypes";

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
  fdmMultilayerLayout?: FdmMultilayerLayoutResource | null,
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
  if (target.kind === "fdm-native-layer") {
    const matchedLayer =
      fdmMultilayerLayout?.layers?.find(
        (layer) =>
          target.id === `fdm-native-layer:${encodeURIComponent(layer.layer_id)}` ||
          target.id === layer.layer_id,
      ) ?? null;
    const matchedByLayer = matchedLayer
      ? sceneObjects.find(
          (entry) =>
            entry.id === matchedLayer.object_id ||
            canonicalVisualizationSceneObjectId(entry.id) ===
              canonicalVisualizationSceneObjectId(matchedLayer.object_id),
        ) ?? null
      : null;
    const matchedByLabel =
      matchedByLayer ??
      (target.label
        ? sceneObjects.find((entry) => entry.label === target.label) ?? null
        : null);
    const label =
      matchedByLabel?.label ??
      matchedLayer?.magnet_name ??
      target.label ??
      displayLabelForVisualizationTarget(target);
    return {
      detail:
        matchedByLabel?.role && matchedByLabel.role !== "magnet"
          ? matchedByLabel.role
          : "Object",
      isAirbox: false,
      label,
      objectEntry: matchedByLabel,
      radioValue: matchedByLabel
        ? `object:${matchedByLabel.id}`
        : matchedLayer
          ? `object:${matchedLayer.object_id}`
          : target.id,
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

export function buildViewTargetUtilityActions({
  discretization,
  fdmMultilayerLayout,
  sceneObjects,
  target,
}: {
  discretization: "fdm" | "fem" | "unknown";
  fdmMultilayerLayout?: FdmMultilayerLayoutResource | null;
  sceneObjects: readonly RibbonSceneObjectEntry[];
  target: VisualizationTargetRef | null;
}): RibbonAction[] {
  const summary = activeViewTargetSummary(
    target,
    sceneObjects,
    fdmMultilayerLayout,
  );
  const missingMultilayerAirbox = isFdmMultilayerMissingAirboxCarrier(
    discretization,
    fdmMultilayerLayout,
  );
  const inspectorObjectId =
    !summary.isAirbox &&
    (target?.kind === "object" || target?.kind === "fdm-native-layer")
      ? summary.objectEntry?.id ??
        (target.kind === "object"
          ? canonicalVisualizationSceneObjectId(
              target.id.startsWith("object:")
                ? target.id.slice("object:".length)
                : target.id,
            )
          : fdmMultilayerLayout?.layers?.find(
              (layer) =>
                target.id ===
                `fdm-native-layer:${encodeURIComponent(layer.layer_id)}`,
            )?.object_id ?? null)
      : null;
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

  const actions: RibbonAction[] = [];
  if (openInspectorInput) {
    actions.push({
      id: "view-open-target-inspector",
      icon: icon(Eye),
      label: summary.isAirbox ? "Airbox Viz" : "Object Viz",
      size: "compact",
      iconColor: C.lavender,
      commandId: RIBBON_INSPECTOR_OPEN_VISUALIZATION_COMMAND,
      commandInput: openInspectorInput,
      tooltip: summary.isAirbox
        ? "Open Airbox Visualization in Inspector"
        : `Open ${summary.label} Visualization in Inspector`,
    });
  }
  if (missingMultilayerAirbox) {
    actions.push({
      id: "view-open-airbox-settings",
      icon: icon(Settings2),
      label: "Airbox Settings",
      size: "compact",
      iconColor: C.peach,
      commandId: RIBBON_INSPECTOR_OPEN_AIRBOX_SETTINGS_COMMAND,
      tooltip:
        "FDM Multilayer has no Airbox carrier yet — open Airbox Settings to configure exterior padding",
    });
  }
  return actions;
}

export function resolveMaterialsTargetContext({
  sceneObjects,
  selection,
}: {
  sceneObjects: readonly RibbonSceneObjectEntry[];
  selection?: Selection | null;
}): {
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
  return { targetLabel, targetObject: matched };
}

export function resolvePhysicsTargetLabel({
  sceneObjects,
  selection,
}: {
  sceneObjects: readonly RibbonSceneObjectEntry[];
  selection?: Selection | null;
}): string | null {
  const selectedId = selection?.objectId ?? null;
  if (!selectedId) return null;
  const matched = sceneObjects.find((entry) => entry.id === selectedId);
  return matched?.label ?? selection?.label ?? selectedId;
}
