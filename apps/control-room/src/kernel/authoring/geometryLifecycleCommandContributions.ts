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
import type { CommandDetailResource, StructuredCommandRequest } from "../api/apiTypes";
import type { CommandContext, CommandContribution, CommandResult } from "../commands/commandTypes";
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
} from "./geometryLifecycleCommands";
import { invalidateAuthoringMutationDependents } from "./authoringMutationInvalidation";
import { awaitMeshBuildConfirmation, type MeshBuildConfirmCommandId } from "./meshBuildConfirmation";
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
  if (context.api && meshBuildOperations.has(context.api.commands)) return false;
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
  if (context.api && meshBuildOperations.has(context.api.commands)) return false;
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

function authoritativeMeshCommandRevision(detail: CommandDetailResource): number {
  return detail.resource_invalidations!.find((entry) => {
    const key = entry.resource_key;
    return key === "meshing/shared-domain/manifest" || key === "data/domain/topology" ||
      (key.startsWith("meshing/objects/") && key.endsWith("/topology"));
  })!.revision;
}

function invalidateMeshBuildStatus(context: CommandContext, revision: string | number): void {
  context.resources?.invalidate(MESHING_BUILDS_PATH, revision);
  context.resources?.invalidate(MESHING_BUILDS_CURRENT_PATH, revision);
  context.resources?.invalidate(MODEL_READINESS_PATH, revision);
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
    requestId?: string;
    objectId?: string;
    reason: string;
    targetKind: "object_mesh" | "study_domain";
  },
): void {
  context.bus?.emit("mesh:build-submitted", payload);
  focusMeshJobs(context);
}

type MeshBuildRequest = Extract<StructuredCommandRequest, { kind: "mesh_build" }>;
type FdmGridRefreshRequest = Extract<StructuredCommandRequest, { kind: "fdm_grid_refresh" }>;
type ObservableMeshCommandKind = "mesh_build" | "fdm_grid_refresh";
type MeshCommandApi = NonNullable<CommandContext["api"]>["commands"];
interface MeshBuildOperation {
  announced: boolean;
  baseMeshRevision: number | null;
  commandId?: string;
  commandKind: ObservableMeshCommandKind;
  key: string;
  objectId?: string;
  observationPaused: boolean;
  promise?: Promise<CommandResult>;
  reason: string;
  requestId?: string;
  submitted: boolean;
}

// Per-client submission locks retain only identities and live promises, never resource snapshots.
const meshBuildOperations = new WeakMap<MeshCommandApi, MeshBuildOperation>();

function meshCommandKindMatches(actual: string, expected: ObservableMeshCommandKind): boolean {
  return actual === expected || (expected === "mesh_build" && actual === "remesh");
}

async function reconcileMeshSubmission(
  api: MeshCommandApi,
  operation: MeshBuildOperation,
): Promise<string | undefined> {
  const queue = await api.list();
  const candidates = queue.commands.filter((entry) =>
    meshCommandKindMatches(entry.kind, operation.commandKind),
  )
    .sort((left, right) => right.seq - left.seq).slice(0, 8);
  for (const entry of candidates) {
    const detail = await api.detail(entry.command_id);
    if (detail.command_id === entry.command_id && detail.client_intent_id === operation.requestId) {
      return detail.command_id;
    }
  }
  return undefined;
}

async function observeMeshBuildOperation(
  context: CommandContext,
  operation: MeshBuildOperation,
): Promise<CommandResult> {
  const api = context.api!.commands;
  if (!operation.commandId) {
    try {
      operation.commandId = await reconcileMeshSubmission(api, operation);
    } catch {
      const result: CommandResult = {
        message: "Mesh submission acknowledgement was lost. Reconnect to check the existing intent; no duplicate build was submitted.",
        observation: "disconnected", status: "pending",
      };
      context.bus?.emit("mesh:build-observed", { ...result, requestId: operation.requestId });
      return result;
    }
    if (!operation.commandId) {
      const result: CommandResult = {
        message: "Mesh submission is unconfirmed. Check the command history before retrying; no duplicate build was submitted.",
        observation: "publication-unconfirmed", status: "pending",
      };
      context.bus?.emit("mesh:build-observed", { ...result, requestId: operation.requestId });
      return result;
    }
  }

  const commandId = operation.commandId;
  const objectId = operation.objectId;
  if (!operation.announced) {
    invalidateMeshBuildStatus(context, commandId);
    emitMeshBuildSubmitted(context, {
      commandId, objectId, requestId: operation.requestId,
      reason: operation.reason,
      targetKind: objectId ? "object_mesh" : "study_domain",
    });
    operation.announced = true;
  }
  const terminal = await awaitMeshCommandTerminal(api, commandId, { baseMeshRevision: operation.baseMeshRevision });
  let meshRevision: number | undefined;
  if (terminal.status === "completed") {
    meshRevision = authoritativeMeshCommandRevision(terminal.detail);
    if (objectId) invalidateObjectMeshResources(context, objectId, meshRevision);
    else invalidateSharedDomainMeshResources(context, meshRevision);
  } else if (terminal.detail) {
    invalidateMeshBuildStatus(context, terminal.detail.seq);
  }
  const result: CommandResult = {
    commandId,
    ...(terminal.message ? { message: terminal.message } : {}),
    ...(terminal.status === "pending" ? { observation: terminal.observation } : {}),
    status: terminal.status,
  };
  context.bus?.emit("mesh:build-observed", { ...result, meshRevision, requestId: operation.requestId });
  return result;
}

function trackMeshBuildOperation(
  context: CommandContext,
  operation: MeshBuildOperation,
  work: () => Promise<CommandResult>,
): Promise<CommandResult> {
  const api = context.api!.commands;
  operation.promise = work().catch((error: unknown): CommandResult => {
    if (!operation.submitted) {
      meshBuildOperations.delete(api);
      throw error;
    }
    const result: CommandResult = {
      commandId: operation.commandId,
      message: error instanceof Error ? error.message : "Mesh observation was interrupted.",
      observation: "disconnected", status: "pending",
    };
    context.bus?.emit("mesh:build-observed", { ...result, requestId: operation.requestId });
    return result;
  }).then((result) => {
    operation.observationPaused = result.status === "pending";
    if (result.status !== "pending") meshBuildOperations.delete(api);
    return result;
  }).finally(() => { operation.promise = undefined; });
  return operation.promise;
}

/** Resume only the retained command identity or client intent; never confirm or submit another build. */
export function resumeMeshBuildObservation(context: CommandContext): Promise<CommandResult> {
  const operation = context.api ? meshBuildOperations.get(context.api.commands) : undefined;
  if (!operation) return Promise.resolve({ message: "No mesh command observation is available to resume.", status: "cancelled" });
  return operation.promise ?? trackMeshBuildOperation(context, operation, () => observeMeshBuildOperation(context, operation));
}

function requestMeshObservation(context: CommandContext, operation: MeshBuildOperation): void {
  context.bus?.emit("mesh:build-observation-requested", {
    commandId: operation.commandId!,
    requestId: operation.requestId!,
    objectId: operation.objectId,
    targetKind: operation.objectId ? "object_mesh" : "study_domain",
  });
}

/** Rehydrate a mesh observation from its authoritative command resource after reload. */
export async function restoreMeshBuildObservation(
  context: CommandContext,
  commandId: string,
): Promise<CommandResult> {
  const api = context.api?.commands;
  if (!api) return { message: "Control-room API is unavailable.", status: "cancelled" };
  const resumeExisting = (operation: MeshBuildOperation): Promise<CommandResult> => {
    if (operation.commandId !== commandId) return Promise.resolve({
      message: "Another mesh command observation is active. Resolve it before opening this command.",
      status: "failed",
    });
    requestMeshObservation(context, operation);
    return resumeMeshBuildObservation(context);
  };
  const existing = meshBuildOperations.get(api);
  if (existing) return resumeExisting(existing);
  let detail: CommandDetailResource;
  try {
    detail = await api.detail(commandId);
  } catch {
    return { commandId, message: "Mesh command details are unavailable. Reconnect and observe this command again.",
      observation: "disconnected", status: "pending" };
  }
  const commandKind = detail.kind === "fdm_grid_refresh" ? "fdm_grid_refresh" : "mesh_build";
  const validTarget = commandKind === "fdm_grid_refresh" || Boolean(detail.mesh_target);
  if (
    detail.command_id !== commandId ||
    !meshCommandKindMatches(detail.kind, commandKind) ||
    !validTarget
  ) {
    return { commandId, message: "The requested resource does not identify a mesh build with a target.", status: "failed" };
  }
  const concurrent = meshBuildOperations.get(api);
  if (concurrent) return resumeExisting(concurrent);
  const operation: MeshBuildOperation = {
    announced: true,
    baseMeshRevision: null,
    commandId,
    commandKind,
    key: "restored:" + commandId,
    objectId: detail.mesh_target?.kind === "object_mesh" ? detail.mesh_target.object_id : undefined,
    observationPaused: true,
    reason: detail.mesh_reason ?? detail.reason ?? "mesh-observation",
    requestId: detail.client_intent_id ?? "mesh-observe:" + commandId,
    submitted: true,
  };
  meshBuildOperations.set(api, operation);
  requestMeshObservation(context, operation);
  return resumeMeshBuildObservation(context);
}

function runMeshBuildOperation(
  context: CommandContext,
  registryCommandId: MeshBuildConfirmCommandId,
  request: MeshBuildRequest,
): Promise<CommandResult> {
  const api = context.api!.commands;
  const status = asRecord(resourceData(context, SESSION_STATUS_RESOURCE_KEY));
  const sceneRevision = asRecord(status?.resources)?.scene_revision ?? sceneBaseRevision(context);
  const key = JSON.stringify({ scene_revision: sceneRevision, mesh_options: request.mesh_options ?? null, mesh_target: request.mesh_target });
  const previous = meshBuildOperations.get(api);
  if (previous) {
    if (previous.key === key && !previous.observationPaused && previous.promise) return previous.promise;
    return Promise.resolve({
      commandId: previous.commandId,
      message: "An existing mesh build remains active. Observe it before starting another build or configuration.",
      observation: "waiting", status: "pending",
    });
  }
  const operation: MeshBuildOperation = {
    announced: false, baseMeshRevision: currentMeshRevision(context), key,
    commandKind: "mesh_build",
    objectId: request.mesh_target?.kind === "object_mesh" ? request.mesh_target.object_id : undefined,
    observationPaused: false, reason: request.mesh_reason ?? "mesh-build", submitted: false,
  };
  meshBuildOperations.set(api, operation);
  return trackMeshBuildOperation(context, operation, async () => {
    const confirmation = await awaitMeshBuildConfirmation(context, registryCommandId, {
      ...asRecord(context.input), ...request,
    });
    operation.requestId = confirmation.requestId;
    if (!confirmation.confirmed) return { status: "cancelled" };
    operation.baseMeshRevision = confirmation.precondition?.mesh_revision ?? operation.baseMeshRevision;
    operation.submitted = true;
    try {
      const response = await api.submit({
        ...request,
        client_intent_id: operation.requestId,
        ...(confirmation.precondition ? { precondition: confirmation.precondition } : {}),
      });
      if (!response.accepted) {
        const result: CommandResult = {
          commandId: response.command_id,
          message: response.error ?? "Mesh build rejected.", status: "failed",
        };
        context.bus?.emit("mesh:build-observed", { ...result, requestId: operation.requestId });
        return result;
      }
      operation.commandId = response.command_id;
    } catch {
      // A lost POST response cannot prove rejection. Reconcile by intent before any further action.
    }
    return observeMeshBuildOperation(context, operation);
  });
}

let fdmGridRefreshSequence = 0;

/** Submit and observe one atomic FDM grid refresh through its terminal command resource. */
export function runFdmGridRefreshOperation(
  context: CommandContext,
  request: FdmGridRefreshRequest,
): Promise<CommandResult> {
  const api = context.api?.commands;
  if (!api) {
    return Promise.resolve({
      message: "Control-room API is unavailable.",
      status: "cancelled",
    });
  }
  const key = JSON.stringify({
    kind: request.kind,
    precondition: request.precondition ?? null,
    reason: request.reason ?? null,
  });
  const previous = meshBuildOperations.get(api);
  if (previous) {
    if (previous.key === key && !previous.observationPaused && previous.promise) {
      return previous.promise;
    }
    return Promise.resolve({
      commandId: previous.commandId,
      message: "An existing mesh operation remains active. Observe it before starting another grid refresh.",
      observation: "waiting",
      status: "pending",
    });
  }

  const requestId = `fdm-grid-refresh-${Date.now()}-${++fdmGridRefreshSequence}`;
  const operation: MeshBuildOperation = {
    announced: false,
    baseMeshRevision: currentMeshRevision(context),
    commandKind: "fdm_grid_refresh",
    key,
    observationPaused: false,
    reason: request.reason ?? "fdm-grid-refresh",
    requestId,
    submitted: true,
  };
  meshBuildOperations.set(api, operation);
  return trackMeshBuildOperation(context, operation, async () => {
    try {
      const response = await api.submit({ ...request, client_intent_id: requestId });
      if (!response.accepted) {
        const result: CommandResult = {
          commandId: response.command_id,
          message: response.error ?? "FDM grid refresh was rejected.",
          status: "failed",
        };
        context.bus?.emit("mesh:build-observed", { ...result, requestId });
        return result;
      }
      operation.commandId = response.command_id;
    } catch {
      // Reconcile a possibly accepted command by client intent before allowing a retry.
    }
    return observeMeshBuildOperation(context, operation);
  });
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
      context.selection?.get().kind === "builder.primitive" &&
      sceneBaseRevision(context) !== null,
    disabledReason: (context) =>
      context.selection?.get().kind !== "builder.primitive"
        ? "Open a primitive draft before committing."
        : "The canonical scene revision is unavailable. Refetch the scene before committing.",
    run: async (context) => {
      const selection = context.selection?.get();
      const primitiveKind = primitiveKindFromDraftSelection(selection);
      const objectId = draftObjectId(primitiveKind);
      const name = selection?.label ?? `New ${primitiveKind}`;
      const baseRevision = sceneBaseRevision(context);
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }
      if (baseRevision === null) {
        return {
          message: "The canonical scene revision is unavailable. Refetch the scene before committing.",
          status: "failed",
        };
      }

      const response = await createObjectTransaction(context.api, {
        base_revision: baseRevision,
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

      return runMeshBuildOperation(context, "mesh.build-selected", {
        kind: "mesh_build",
        mesh_reason: "selected-object",
        mesh_target: { kind: "object_mesh", object_id: objectId },
      });
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
      return runMeshBuildOperation(context, "mesh.build-shared-domain", {
        kind: "mesh_build",
        mesh_reason: "shared-domain",
        mesh_target: { kind: "study_domain" },
      });
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
      return runMeshBuildOperation(context, "mesh.refine-worst-quality-element", {
        kind: "mesh_build",
        mesh_options: meshOptions,
        mesh_reason: "quality_threshold_refinement",
        mesh_target: { kind: "study_domain" },
      });
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
