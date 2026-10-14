import type { ModelReadinessCheck } from "../api/apiTypes";
import {
  visualizationTargetIdForSceneObject,
  type Selection,
  type SelectionRef,
} from "../selection/selectionTypes";

export type ScratchAuthoringSelection = Pick<
  Selection,
  "kind" | "label" | "nodeId" | "objectId" | "ref"
>;

export type ScratchAuthoringAction =
  | {
      kind: "command";
      commandId: "geometry.add-box" | "mesh.build-shared-domain";
      label: string;
    }
  | {
      kind: "selection";
      label: string;
      selection: ScratchAuthoringSelection;
    }
  | {
      kind: "explorer";
      label: "Open Explorer";
      targetResource: string | null;
    };

const ADD_OBJECT_ACTION: ScratchAuthoringAction = {
  kind: "command",
  commandId: "geometry.add-box",
  label: "Add box",
};

function selection(
  kind: ScratchAuthoringSelection["kind"],
  label: string,
  nodeId: string,
  objectId: string | null = null,
  ref: SelectionRef | null = null,
): ScratchAuthoringAction {
  return {
    kind: "selection",
    label,
    selection: { kind, label, nodeId, objectId, ref },
  };
}

function objectSelection(
  objectId: string,
  kind: "object.material" | "object.magnetic-texture" | "object.physics",
  label: string,
  childId: string,
): ScratchAuthoringAction {
  const nodeId = `model:object:${objectId}:${childId}`;
  const ref: SelectionRef = {
    kind,
    nodeId,
    objectId,
    type: "scene-object",
    visualizationTargetId: visualizationTargetIdForSceneObject(objectId),
  };
  return selection(kind, label, nodeId, objectId, ref);
}

function objectIdFromTargetResource(
  targetResource: string | null | undefined,
): string | null {
  const match = targetResource?.match(/^\/?model\/objects\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    const objectId = decodeURIComponent(match[1]);
    // This existing route is the general interactions destination, not an object ID.
    if (objectId === "interactions") return null;
    return objectId.length > 0 ? objectId : null;
  } catch {
    return null;
  }
}

function explorerAction(targetResource: string | null): ScratchAuthoringAction {
  return {
    kind: "explorer",
    label: "Open Explorer",
    targetResource,
  };
}

function studySelection(
  kind: "study.root" | "study.stages" | "study.execution",
  label: string,
): ScratchAuthoringAction {
  const nodeId =
    kind === "study.root"
      ? "model:study"
      : kind === "study.stages"
        ? "model:study:stages"
        : "model:study:execution";
  const ref: SelectionRef = { kind, nodeId, type: "study" };
  return selection(kind, label, nodeId, null, ref);
}

/** Resolve readiness IDs only to existing command or Inspector routes. */
export function resolveScratchAuthoringAction(
  check: ModelReadinessCheck,
): ScratchAuthoringAction {
  const objectId = objectIdFromTargetResource(check.target_resource);

  switch (check.id) {
    case "method":
      return studySelection("study.root", "Choose study method");
    case "domain":
      return selection("universe.root", "Configure domain", "model:universe");
    case "geometry":
      return ADD_OBJECT_ACTION;
    case "material":
      return objectId
        ? objectSelection(
            objectId,
            "object.material",
            "Material",
            "magnetic-parameters:material",
          )
        : check.target_resource
          ? explorerAction(check.target_resource)
          : ADD_OBJECT_ACTION;
    case "texture":
      return objectId
        ? objectSelection(
            objectId,
            "object.magnetic-texture",
            "Initial magnetization",
            "magnetic-texture",
          )
        : check.target_resource
          ? explorerAction(check.target_resource)
          : ADD_OBJECT_ACTION;
    case "interactions":
      return objectId
        ? objectSelection(
            objectId,
            "object.physics",
            "Physics interaction",
            "magnetic-parameters:exchange",
          )
        : check.target_resource
          ? explorerAction(check.target_resource)
          : ADD_OBJECT_ACTION;
    case "discretization":
      return check.target_resource === "meshing/builds/current"
        ? {
            kind: "command",
            commandId: "mesh.build-shared-domain",
            label: "Build FEM mesh",
          }
        : studySelection("study.root", "Discretization settings");
    case "study":
      return studySelection("study.stages", "Configure study stages");
    case "execution":
      return studySelection("study.execution", "Configure run settings");
    default:
      return explorerAction(check.target_resource ?? null);
  }
}
