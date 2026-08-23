import {
  MESHING_BUILDS_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_CAPABILITIES_PATH,
  MESHING_OBJECT_QUALITY_PATH,
  MESHING_OBJECT_REPORT_PATH,
  MESHING_OBJECT_TOPOLOGY_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_GATES_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_PATH,
  MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH,
  MESHING_SHARED_DOMAIN_REPORT_PATH,
  MESHING_SEMANTICS_PATH,
  MESHING_SUMMARY_PATH,
  MODEL_GEOMETRY_CAPABILITIES_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
} from "../api/apiPaths";
import type { JsonObject, JsonValue, MeshCapabilitiesResource } from "../api/apiTypes";
import type { CommandDetailResource } from "../api/apiTypes";
import type { CommandContext, CommandContribution } from "../commands/commandTypes";
import type { Selection } from "../selection/selectionTypes";
import {
  meshEditorCapabilityBlocks,
  resolveMeshEditorCapabilities,
} from "@/shared/domain/mesh/meshEditorCapabilityModel";
import {
  renderModePatch,
  type VisualizationTargetRef,
} from "../visualization/ObjectVisualizationController";

import {
  awaitMeshCommandTerminal,
  createObjectTransaction,
  deleteObjectTransaction,
  submitObjectMeshBuild,
} from "./geometryLifecycleCommands";
import { invalidateAuthoringMutationDependents } from "./authoringMutationInvalidation";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resourceData(context: CommandContext, resourceKey: string): unknown {
  return context.resourceData?.[resourceKey] ?? null;
}

function sceneBaseRevision(context: CommandContext): number | null {
  const revision = asRecord(resourceData(context, MODEL_SCENE_PATH))?.revision;
  return typeof revision === "number" && Number.isFinite(revision)
    ? revision
    : null;
}

export type MeshCommandLane = "fdm" | "fem" | "unknown";

export const FDM_MESH_COMMAND_NOT_APPLICABLE_REASON =
  "FEM mesh commands are not applicable to an FDM structured-grid session.";

export const UNKNOWN_MESH_COMMAND_LANE_REASON =
  "Session discretization is unresolved; FEM mesh commands remain unavailable until an explicit FEM lane is published.";

/**
 * Resolve the current command lane from the session-status resource only.
 * Missing, auto, or malformed status must never fall through to FEM.
 */
export function resolveMeshCommandLane(
  discretization: unknown,
): MeshCommandLane {
  if (typeof discretization !== "string") return "unknown";
  const normalized = discretization.trim().toLowerCase();
  if (normalized === "fdm") return "fdm";
  if (normalized === "fem") return "fem";
  return "unknown";
}

function meshCommandLane(context: CommandContext): MeshCommandLane {
  const status = asRecord(resourceData(context, SESSION_STATUS_RESOURCE_KEY));
  return resolveMeshCommandLane(asRecord(status?.domain)?.discretization);
}

function femMeshCommandDisabledReason(context: CommandContext): string | null {
  const lane = meshCommandLane(context);
  if (lane === "fdm") return FDM_MESH_COMMAND_NOT_APPLICABLE_REASON;
  if (lane === "unknown") return UNKNOWN_MESH_COMMAND_LANE_REASON;
  return null;
}

function selectedObjectId(context: Pick<CommandContext, "selection">): string | null {
  const selection = context.selection?.get();
  return selection?.ref?.type === "scene-object"
    ? selection.ref.objectId
    : selection?.objectId ?? null;
}

function selectedObjectDisabledReason(
  context: Pick<CommandContext, "selection">,
): string | null {
  return selectedObjectId(context)
    ? null
    : "Select a scene object to use this command.";
}

function isApiAvailable(context: CommandContext): boolean {
  return Boolean(context.api);
}

function disabledWithoutApi(context: CommandContext): string | null {
  return context.api ? null : "Control Room API is not available.";
}

function primitiveCapabilityDisabled(
  context: CommandContext,
  primitiveKind: "box" | "cylinder" | "sphere",
): boolean {
  const capabilities = resourceData(context, MODEL_GEOMETRY_CAPABILITIES_PATH);
  const primitiveKey = primitiveKind.toLowerCase();
  let disabled = false;

  const visit = (value: unknown, keyHint = ""): void => {
    if (disabled) return;
    const key = keyHint.toLowerCase();
    if (typeof value === "boolean" && key === primitiveKey) {
      disabled = !value;
      return;
    }

    const record = asRecord(value);
    if (!record) return;

    const supported =
      record.supported ?? record.enabled ?? record.available ?? record.capable;
    if (key === primitiveKey && typeof supported === "boolean") {
      disabled = !supported;
      return;
    }

    for (const [childKey, child] of Object.entries(record)) {
      visit(child, childKey);
    }
  };

  visit(capabilities);
  return disabled;
}

function primitiveCapabilityDisabledReason(
  primitiveKind: "box" | "cylinder" | "sphere",
): string {
  return `Backend does not expose ${primitiveKind} geometry authoring.`;
}

function recordTargetsObject(record: JsonRecord, objectId: string): boolean {
  const target =
    asString(record.object_id) ??
    asString(record.objectId) ??
    asString(record.target_id) ??
    asString(record.targetId);
  return !target || target === objectId || target === `object:${objectId}`;
}

function recordHasMessage(record: JsonRecord): boolean {
  return Boolean(
    asString(record.message) ??
      asString(record.error) ??
      asString(record.reason) ??
      asString(record.detail),
  );
}

function hasObjectValidationBlocker(
  context: CommandContext,
  objectId: string,
): boolean {
  const validation = resourceData(context, MODEL_GEOMETRY_VALIDATION_PATH);

  const visit = (value: unknown, keyHint = ""): boolean => {
    if (Array.isArray(value)) return value.some((entry) => visit(entry, keyHint));
    const record = asRecord(value);
    if (!record) return false;

    const severity = asString(record.severity)?.toLowerCase();
    const status = asString(record.status)?.toLowerCase();
    const key = keyHint.toLowerCase();
    const blocking =
      record.blocking === true ||
      key.includes("block") ||
      key.includes("error") ||
      severity === "error" ||
      severity === "fatal" ||
      status === "blocked" ||
      status === "invalid";
    if (
      blocking &&
      recordTargetsObject(record, objectId) &&
      recordHasMessage(record)
    ) {
      return true;
    }

    return Object.entries(record).some(([childKey, child]) =>
      visit(child, childKey),
    );
  };

  return visit(validation);
}

function isObjectMeshBuildRunning(
  context: CommandContext,
  objectId: string,
): boolean {
  const activeBuild = resourceData(context, MESHING_BUILDS_CURRENT_PATH);
  const runningStatuses = new Set(["building", "pending", "queued", "running"]);

  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    const record = asRecord(value);
    if (!record) return false;

    const status = asString(record.status)?.toLowerCase();
    const targetKind =
      asString(asRecord(record.mesh_target)?.kind) ??
      asString(asRecord(record.target)?.kind) ??
      asString(record.kind);
    const targetObject =
      asString(record.object_id) ??
      asString(record.objectId) ??
      asString(asRecord(record.mesh_target)?.object_id) ??
      asString(asRecord(record.target)?.object_id);
    if (
      runningStatuses.has(status ?? "") &&
      targetKind === "object_mesh" &&
      targetObject === objectId
    ) {
      return true;
    }

    return Object.values(record).some(visit);
  };

  return visit(activeBuild);
}

function isSharedDomainMeshBuildRunning(context: CommandContext): boolean {
  const activeBuild = resourceData(context, MESHING_BUILDS_CURRENT_PATH);
  const runningStatuses = new Set(["building", "pending", "queued", "running"]);

  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    const record = asRecord(value);
    if (!record) return false;

    const status = asString(record.status)?.toLowerCase();
    const targetKind =
      asString(asRecord(record.mesh_target)?.kind) ??
      asString(asRecord(record.target)?.kind) ??
      asString(record.kind);
    if (
      runningStatuses.has(status ?? "") &&
      (targetKind === "study_domain" || targetKind === "shared_domain")
    ) {
      return true;
    }

    return Object.values(record).some(visit);
  };

  return visit(activeBuild);
}

function selectedObjectMeshDisabledReason(context: CommandContext): string | null {
  const laneReason = femMeshCommandDisabledReason(context);
  if (laneReason) return laneReason;
  const capabilityReason = meshCapabilityDisabledReason(context, "fem");
  if (capabilityReason) return capabilityReason;
  const objectId = selectedObjectId(context);
  if (!objectId) return "Select a scene object to use this command.";
  if (hasObjectValidationBlocker(context, objectId)) {
    return "Resolve geometry validation blockers before building this mesh.";
  }
  if (isObjectMeshBuildRunning(context, objectId)) {
    return "A mesh build is already running for this object.";
  }
  return null;
}

function meshCapabilityDisabledReason(
  context: CommandContext,
  capability: "fem",
): string | null {
  const laneReason = femMeshCommandDisabledReason(context);
  if (laneReason) return laneReason;
  if (!context.resourceData || !(MESHING_CAPABILITIES_PATH in context.resourceData)) {
    return null;
  }
  const option = resolveMeshEditorCapabilities(
    context.resourceData[MESHING_CAPABILITIES_PATH] as MeshCapabilitiesResource | null,
  ).option(capability);
  return meshEditorCapabilityBlocks(option) ? option.reason : null;
}

function selectedObjectTarget(
  selection: Selection | null | undefined,
): VisualizationTargetRef | null {
  const objectId =
    selection?.ref?.type === "scene-object"
      ? selection.ref.objectId
      : selection?.objectId;
  if (!objectId) return null;

  return {
    id: objectId,
    kind: "object",
    label: selection?.label,
  };
}

function invalidateSceneAuthoringResources(
  context: CommandContext,
  sceneRevision: number,
): void {
  if (context.resources) {
    invalidateAuthoringMutationDependents(
      context.resources,
      "geometry",
      sceneRevision,
    );
  }
}

function objectResourceKey(path: string, objectId: string): string {
  return path.replace("{object_id}", encodeURIComponent(objectId));
}

function invalidateObjectMeshResources(
  context: CommandContext,
  objectId: string,
  revision: string | number,
): void {
  context.resources?.invalidate(MESHING_BUILDS_CURRENT_PATH, revision);
  context.resources?.invalidate(MODEL_READINESS_PATH, revision);
  context.resources?.invalidate(MESHING_SUMMARY_PATH, revision);
  context.resources?.invalidate(MESHING_SEMANTICS_PATH, revision);
  context.resources?.invalidate(MESHING_BUILDS_LATEST_SUCCESSFUL_PATH, revision);
  context.resources?.invalidate(MESHING_SHARED_DOMAIN_MANIFEST_PATH, revision);
  context.resources?.invalidate(
    objectResourceKey(MESHING_OBJECT_TOPOLOGY_PATH, objectId),
    revision,
  );
  context.resources?.invalidate(
    objectResourceKey(MESHING_OBJECT_REPORT_PATH, objectId),
    revision,
  );
  context.resources?.invalidate(
    objectResourceKey(MESHING_OBJECT_QUALITY_PATH, objectId),
    revision,
  );
}

function invalidateSharedDomainMeshResources(
  context: CommandContext,
  revision: string | number,
): void {
  context.resources?.invalidate(MESHING_BUILDS_PATH, revision);
  context.resources?.invalidate(MODEL_READINESS_PATH, revision);
  context.resources?.invalidate(MESHING_SUMMARY_PATH, revision);
  context.resources?.invalidate(MESHING_SEMANTICS_PATH, revision);
  context.resources?.invalidate(MESHING_BUILDS_CURRENT_PATH, revision);
  context.resources?.invalidate(MESHING_BUILDS_LATEST_SUCCESSFUL_PATH, revision);
  context.resources?.invalidate(MESHING_SHARED_DOMAIN_MANIFEST_PATH, revision);
  context.resources?.invalidate(MESHING_SHARED_DOMAIN_REPORT_PATH, revision);
  context.resources?.invalidate(MESHING_SHARED_DOMAIN_QUALITY_PATH, revision);
  context.resources?.invalidate(MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH, revision);
  context.resources?.invalidate(MESHING_SHARED_DOMAIN_QUALITY_GATES_PATH, revision);
  context.resources?.invalidate(
    MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH,
    revision,
  );
  context.resources?.invalidate(MODEL_SCENE_PATH, revision);
}

function currentMeshRevision(context: CommandContext): number | null {
  const status = asRecord(resourceData(context, SESSION_STATUS_RESOURCE_KEY));
  const resources = asRecord(status?.resources);
  return typeof resources?.mesh_revision === "number"
    ? resources.mesh_revision
    : null;
}

function authoritativeMeshCommandRevision(
  detail: CommandDetailResource,
): number {
  const meshRevision = detail.resource_invalidations?.find((entry) => {
    const key = entry.resource_key;
    return (
      key === "meshing/shared-domain/manifest" ||
      key === "data/domain/topology" ||
      (key.startsWith("meshing/objects/") && key.endsWith("/topology"))
    );
  })?.revision;
  if (meshRevision !== undefined) return meshRevision;

  return (
    detail.resource_invalidations?.find(
      (entry) => entry.resource_key === "meshing/builds/current",
    )?.revision ?? detail.seq
  );
}

function focusMeshJobs(context: CommandContext): void {
  context.layout?.setPanelVisible("bottom", true);
  context.layout?.setFocusedSlot("panel-bottom");
  context.bus?.emit("footer:tab-requested", {
    reason: "mesh-build",
    tab: "mesh",
  });
}

function emitMeshBuildSubmitted(
  context: CommandContext,
  payload: {
    commandId: string;
    objectId?: string;
    reason: string;
    targetKind: "object_mesh" | "study_domain";
  },
): void {
  context.bus?.emit("mesh:build-submitted", payload);
  focusMeshJobs(context);
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const converted = jsonValue(item);
      if (converted !== undefined) items.push(converted);
    }
    return items;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const object: JsonObject = {};
  for (const [key, entry] of Object.entries(record)) {
    const converted = jsonValue(entry);
    if (converted !== undefined) object[key] = converted;
  }
  return object;
}

function jsonObject(value: unknown): JsonObject | null {
  const converted = jsonValue(value);
  return asRecord(converted) ? (converted as JsonObject) : null;
}

function qualityRefinementMeshOptions(input: unknown): JsonObject | null {
  const inputRecord = asRecord(input);
  if (!inputRecord) return null;
  return jsonObject(inputRecord.meshOptions);
}

function openPrimitiveDraft(
  context: CommandContext,
  primitiveKind: "box" | "cylinder" | "sphere",
  draftIdentity: "box" | "thin-film" | "cylinder" | "sphere" = primitiveKind,
): void {
  context.selection?.set(
    {
      kind: "builder.primitive",
      label: draftIdentity === "thin-film" ? "New thin film" : `New ${primitiveKind}`,
      nodeId: `geometry:draft:${draftIdentity}`,
      objectId: null,
      ref: null,
    },
    "geometry-authoring",
  );
}

function primitiveKindFromDraftSelection(
  selection: Selection | null | undefined,
): "box" | "cylinder" | "sphere" {
  const suffix = selection?.nodeId?.split(":").at(-1);
  if (suffix === "cylinder" || suffix === "sphere") return suffix;
  return "box";
}

function sceneObjects(scene: unknown): JsonObject[] {
  const objects = asRecord(scene)?.objects;
  return Array.isArray(objects)
    ? objects.filter((object): object is JsonObject =>
        Boolean(object && typeof object === "object" && !Array.isArray(object)),
      )
    : [];
}

function sceneFieldDrives(scene: unknown): JsonObject[] {
  const drives = asRecord(asRecord(scene)?.field_drives)?.drives;
  return Array.isArray(drives)
    ? drives.filter((drive): drive is JsonObject => Boolean(drive && typeof drive === "object" && !Array.isArray(drive)))
    : [];
}

function defaultPrimitiveGeometry(
  primitiveKind: "box" | "cylinder" | "sphere",
): JsonObject {
  if (primitiveKind === "cylinder") {
    const geometryParams: JsonObject = { height: 1e-8, radius: 5e-8 };
    return {
      geometry_kind: "Cylinder",
      geometry_params: geometryParams,
    };
  }
  if (primitiveKind === "sphere") {
    const geometryParams: JsonObject = { radius: 5e-8 };
    return {
      geometry_kind: "Sphere",
      geometry_params: geometryParams,
    };
  }
  const geometryParams: JsonObject = { size: [1e-7, 1e-7, 1e-8] };
  return {
    geometry_kind: "Box",
    geometry_params: geometryParams,
  };
}

function draftObjectId(primitiveKind: string): string {
  return `${primitiveKind}-${Date.now().toString(36)}`;
}

function defaultMicrostripAntennaObject(objectId: string): JsonObject {
  return {
    geometry: {
      geometry_kind: "Box",
      geometry_params: { size: [50e-9, 1e-6, 10e-9] },
    },
    id: objectId,
    locked: false,
    magnetization_ref: null,
    material_ref: "",
    name: "Microstrip antenna",
    physics_stack: [],
    role: "antenna",
    tags: ["role:antenna"],
    transform: {
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      translation: [0, 0, 0],
    },
    visible: true,
  };
}

function defaultMicrostripFieldDrive(objectId: string): JsonObject {
  return {
    activation: { kind: "all_time_evolution" },
    amplitude_B_T: 0.001,
    direction: [0, 1, 0],
    enabled: true,
    id: `${objectId}:H_ant`,
    kind: "regional",
    name: "Microstrip antenna field",
    spatial_profile: { kind: "geometry_mask", object_id: objectId, envelope: { kind: "uniform" } },
    target: { kind: "global" },
    time_origin: "stage_local",
    waveform: { amplitude: 1, cutoff_hz: 20e9, kind: "sinc_pulse", t0: 5e-11 },
  };
}

function selectCommittedObject(
  context: CommandContext,
  objectId: string,
  label: string,
): void {
  context.selection?.set(
    {
      kind: "object.root",
      label,
      nodeId: `model:object:${objectId}`,
      objectId,
      ref: {
        kind: "object.root",
        nodeId: `model:object:${objectId}`,
        objectId,
        type: "scene-object",
        visualizationTargetId: `object:${objectId}`,
      },
    },
    "geometry-authoring",
  );
}

function selectMeshNode(
  context: CommandContext,
  kind:
    | "mesh.root"
    | "mesh.shared-domain"
    | "mesh.builds"
    | "mesh.quality"
    | "mesh.size-fields"
    | "mesh.regions",
  nodeId: string,
  label: string,
): void {
  context.selection?.set(
    {
      kind,
      label,
      nodeId,
      objectId: null,
      ref: null,
    },
    "mesh",
  );
  context.layout?.setActiveTab("mesh");
}

function meshNavigationCommand(
  id: string,
  title: string,
  kind:
    | "mesh.root"
    | "mesh.shared-domain"
    | "mesh.builds"
    | "mesh.quality"
    | "mesh.size-fields"
    | "mesh.regions",
  nodeId: string,
  label: string,
): CommandContribution {
  return {
    id,
    title,
    category: "Mesh",
    group: "mesh",
    scope: "workspace",
    isEnabled: (context) => femMeshCommandDisabledReason(context) === null,
    disabledReason: femMeshCommandDisabledReason,
    run: (context) => {
      const laneReason = femMeshCommandDisabledReason(context);
      if (laneReason) {
        return { message: laneReason, status: "failed" };
      }
      selectMeshNode(context, kind, nodeId, label);
      return { status: "completed" };
    },
  };
}

function primitiveDraftCommand(
  id: string,
  title: string,
  primitiveKind: "box" | "cylinder" | "sphere",
  draftIdentity: "box" | "thin-film" | "cylinder" | "sphere" = primitiveKind,
): CommandContribution {
  return {
    id,
    title,
    category: "Geometry",
    group: "geometry",
    scope: "workspace",
    isEnabled: (context) =>
      !primitiveCapabilityDisabled(context, primitiveKind),
    disabledReason: (context) =>
      primitiveCapabilityDisabled(context, primitiveKind)
        ? primitiveCapabilityDisabledReason(primitiveKind)
        : null,
    run: (context) => {
      openPrimitiveDraft(context, primitiveKind, draftIdentity);
      return { status: "completed" };
    },
  };
}

export const GEOMETRY_LIFECYCLE_COMMANDS: CommandContribution[] = [
  primitiveDraftCommand("geometry.add-box", "Add Box", "box"),
  primitiveDraftCommand("geometry.add-thin-film", "Add Thin Film", "box", "thin-film"),
  primitiveDraftCommand("geometry.add-cylinder", "Add Cylinder", "cylinder"),
  primitiveDraftCommand("geometry.add-sphere", "Add Sphere", "sphere"),
  {
    id: "geometry.add-microstrip-antenna",
    title: "Add Microstrip Antenna",
    category: "Geometry",
    group: "geometry",
    scope: "workspace",
    isEnabled: isApiAvailable,
    disabledReason: disabledWithoutApi,
    run: async (context) => {
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }

      const scene = await context.api.model.scene();
      const objectId = draftObjectId("antenna");
      const response = await context.api.model.commitTransaction({
        kind: "merge_patch",
        merge_patch: {
          field_drives: {
            drives: [
              ...sceneFieldDrives(scene),
              defaultMicrostripFieldDrive(objectId),
            ],
          },
          objects: [
            ...sceneObjects(scene),
            defaultMicrostripAntennaObject(objectId),
          ],
        },
      });
      invalidateSceneAuthoringResources(context, response.scene_revision);
      selectCommittedObject(context, objectId, "Microstrip antenna");
      return { message: "Microstrip antenna added.", status: "completed" };
    },
  },
  {
    id: "geometry.commit-object-draft",
    title: "Commit Object Draft",
    category: "Geometry",
    group: "geometry",
    shortcut: "Ctrl+Enter",
    scope: "selection",
    isEnabled: (context) =>
      context.selection?.get().kind === "builder.primitive",
    disabledReason: () => "Open a primitive draft before committing.",
    run: async (context) => {
      const selection = context.selection?.get();
      const primitiveKind = primitiveKindFromDraftSelection(selection);
      const objectId = draftObjectId(primitiveKind);
      const name = selection?.label ?? `New ${primitiveKind}`;
      const baseRevision = sceneBaseRevision(context);
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }

      const response = await createObjectTransaction(context.api, {
        ...(baseRevision !== null ? { base_revision: baseRevision } : {}),
        geometry: defaultPrimitiveGeometry(primitiveKind),
        name,
        object_id: objectId,
        transform: {
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          translation: [0, 0, 0],
        },
      });
      invalidateSceneAuthoringResources(context, response.scene_revision);
      selectCommittedObject(context, objectId, name);
      return { status: "completed" };
    },
  },
  {
    id: "geometry.delete-object",
    title: "Delete Object",
    category: "Geometry",
    group: "geometry",
    scope: "selection",
    isEnabled: (context) => Boolean(selectedObjectId(context)),
    disabledReason: selectedObjectDisabledReason,
    run: async (context) => {
      const objectId = selectedObjectId(context);
      if (!objectId) {
        return { message: "No scene object selected.", status: "failed" };
      }
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }

      const response = await deleteObjectTransaction(context.api, objectId);
      invalidateSceneAuthoringResources(context, response.scene_revision);
      if (context.selection?.get().objectId === objectId) {
        context.selection.clear("geometry-authoring");
      }
      return { status: "completed" };
    },
  },
  {
    id: "geometry.focus-primitive",
    title: "Focus Primitive",
    category: "Geometry",
    group: "geometry",
    shortcut: "F",
    scope: "selection",
    isEnabled: (context) => Boolean(selectedObjectId(context)),
    disabledReason: selectedObjectDisabledReason,
    run: (context) => {
      const target = selectedObjectTarget(context.selection?.get());
      if (!target) {
        return { message: "No scene object selected.", status: "failed" };
      }
      context.visualization?.patchTarget(target, {
        ...renderModePatch("surface+edges"),
        primitiveVisible: true,
      });
      return { status: "completed" };
    },
  },
  {
    id: "mesh.build-selected",
    title: "Build Selected Mesh",
    category: "Mesh",
    group: "mesh",
    shortcut: "Ctrl+B",
    scope: "selection",
    isEnabled: (context) => selectedObjectMeshDisabledReason(context) === null,
    disabledReason: selectedObjectMeshDisabledReason,
    run: async (context) => {
      const laneReason = femMeshCommandDisabledReason(context);
      if (laneReason) {
        return { message: laneReason, status: "failed" };
      }
      const objectId = selectedObjectId(context);
      if (!objectId) {
        return { message: "No scene object selected.", status: "failed" };
      }
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }

      const response = await submitObjectMeshBuild(
        context.api,
        objectId,
        "selected-object",
      );
      if (!response.accepted) {
        return { message: response.error ?? "Mesh build rejected.", status: "failed" };
      }
      const commandId = response.command_id;
      invalidateObjectMeshResources(context, objectId, commandId);
      emitMeshBuildSubmitted(context, {
        commandId,
        objectId,
        reason: "selected-object",
        targetKind: "object_mesh",
      });
      const terminal = await awaitMeshCommandTerminal(
        context.api.commands,
        commandId,
        { baseMeshRevision: currentMeshRevision(context) },
      );
      invalidateObjectMeshResources(
        context,
        objectId,
        authoritativeMeshCommandRevision(terminal.detail),
      );
      return terminal.status === "completed"
        ? { status: "completed" }
        : { message: terminal.message, status: terminal.status };
    },
  },
  {
    id: "mesh.build-shared-domain",
    title: "Build Shared-Domain Mesh",
    category: "Mesh",
    group: "mesh",
    scope: "workspace",
    isEnabled: (context) => meshCapabilityDisabledReason(context, "fem") === null,
    disabledReason: (context) => meshCapabilityDisabledReason(context, "fem"),
    run: async (context) => {
      const laneReason = femMeshCommandDisabledReason(context);
      if (laneReason) {
        return { message: laneReason, status: "failed" };
      }
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }
      const response = await context.api.commands.submit({
        kind: "mesh_build",
        mesh_reason: "shared-domain",
        mesh_target: { kind: "study_domain" },
      });
      if (response.accepted) {
        const commandId = response.command_id;
        invalidateSharedDomainMeshResources(context, commandId);
        emitMeshBuildSubmitted(context, {
          commandId,
          reason: "shared-domain",
          targetKind: "study_domain",
        });
        const terminal = await awaitMeshCommandTerminal(
          context.api.commands,
          commandId,
          { baseMeshRevision: currentMeshRevision(context) },
        );
        invalidateSharedDomainMeshResources(
          context,
          authoritativeMeshCommandRevision(terminal.detail),
        );
        return terminal.status === "completed"
          ? { status: "completed" }
          : { message: terminal.message, status: terminal.status };
      }
      return { message: response.error ?? "Mesh build rejected.", status: "failed" };
    },
  },
  {
    id: "mesh.refine-worst-quality-element",
    title: "Refine Worst Quality Element",
    category: "Mesh",
    group: "mesh",
    scope: "workspace",
    isEnabled: (context) =>
      meshCapabilityDisabledReason(context, "fem") === null &&
      !isSharedDomainMeshBuildRunning(context) &&
      qualityRefinementMeshOptions(context.input) !== null,
    disabledReason: (context) => {
      const capabilityReason = meshCapabilityDisabledReason(context, "fem");
      if (capabilityReason) return capabilityReason;
      if (isSharedDomainMeshBuildRunning(context)) {
        return "A shared-domain mesh build is already running.";
      }
      return "Open Mesh Quality and choose a refinement action.";
    },
    run: async (context) => {
      const laneReason = femMeshCommandDisabledReason(context);
      if (laneReason) {
        return { message: laneReason, status: "failed" };
      }
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }
      const meshOptions = qualityRefinementMeshOptions(context.input);
      if (!meshOptions) {
        return {
          message: "Mesh quality refinement requires a mesh-options payload.",
          status: "failed",
        };
      }
      const response = await context.api.commands.submit({
        kind: "mesh_build",
        mesh_options: meshOptions,
        mesh_reason: "quality_threshold_refinement",
        mesh_target: { kind: "study_domain" },
      });
      if (response.accepted) {
        const commandId = response.command_id;
        invalidateSharedDomainMeshResources(context, commandId);
        const terminal = await awaitMeshCommandTerminal(
          context.api.commands,
          commandId,
          { baseMeshRevision: currentMeshRevision(context) },
        );
        invalidateSharedDomainMeshResources(
          context,
          authoritativeMeshCommandRevision(terminal.detail),
        );
        return terminal.status === "completed"
          ? { status: "completed" }
          : { message: terminal.message, status: terminal.status };
      }
      return { message: response.error ?? "Mesh refinement rejected.", status: "failed" };
    },
  },
  meshNavigationCommand(
    "mesh.open-overview",
    "Open Mesh Overview",
    "mesh.root",
    "model:mesh",
    "Mesh",
  ),
  meshNavigationCommand(
    "mesh.open-shared-domain",
    "Open Shared-Domain Mesh",
    "mesh.shared-domain",
    "model:mesh:shared-domain",
    "Shared-Domain Solver Mesh",
  ),
  meshNavigationCommand(
    "mesh.open-builds",
    "Open Mesh Build Pipeline",
    "mesh.builds",
    "model:mesh:builds",
    "Mesh Build Pipeline",
  ),
  meshNavigationCommand(
    "mesh.open-quality",
    "Open Mesh Quality Gates",
    "mesh.quality",
    "model:mesh:quality",
    "Quality Gates",
  ),
  meshNavigationCommand(
    "mesh.open-size-fields",
    "Open Realized Size Fields",
    "mesh.size-fields",
    "model:mesh:size-fields",
    "Realized Size Fields",
  ),
  meshNavigationCommand(
    "mesh.open-regions",
    "Open Mesh Regions And Parts",
    "mesh.regions",
    "model:mesh:regions",
    "Regions And Mesh Parts",
  ),
  {
    id: "mesh.open-object-report",
    title: "Open Object Mesh Report",
    category: "Mesh",
    group: "mesh",
    scope: "selection",
    isEnabled: (context) =>
      femMeshCommandDisabledReason(context) === null &&
      Boolean(selectedObjectId(context)),
    disabledReason: (context) =>
      femMeshCommandDisabledReason(context) ?? selectedObjectDisabledReason(context),
    run: (context) => {
      const laneReason = femMeshCommandDisabledReason(context);
      if (laneReason) {
        return { message: laneReason, status: "failed" };
      }
      const objectId = selectedObjectId(context);
      if (!objectId) {
        return { message: "No scene object selected.", status: "failed" };
      }
      context.selection?.set(
        {
          kind: "object.mesh",
          label: context.selection.get().label,
          nodeId: `model:object:${objectId}:mesh`,
          objectId,
          ref: {
            kind: "object.mesh",
            nodeId: `model:object:${objectId}:mesh`,
            objectId,
            type: "scene-object",
            visualizationTargetId: `object:${objectId}`,
          },
        },
        "mesh",
      );
      return { status: "completed" };
    },
  },
];
