import type { JsonObject, OutputStorageSettings, ProjectFromScriptRequest, ProjectFromScriptResource } from "../api/apiTypes";
import { MODEL_READINESS_PATH, MODEL_SCENE_PATH, SESSIONS_PATH, SESSION_CURRENT_PATH } from "../api/apiPaths";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import { newSimulationStorage, simulationTimestamp, suggestedProjectFolder, validateStorageParent, validateStorageSeparation } from "../layout/newProblemStorage";
import { confirmedSessionResourceIdentity, sessionRequestScopeKey, sessionResourceIdentityFromStatus } from "../resources/sessionResourceIdentity";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";
import type { CommandContext } from "../commands/commandTypes";
import type { ProjectArchiveSource } from "./ProjectDocumentController";
import type { KernelApi } from "../types";
import { createProjectAuthoringSessionBinding } from "./ProjectAuthoringSessionBinding";
import { cloneBoundedProjectJsonObject } from "./ProjectDocumentValidation";

/** Import never replaces another workspace, even after a stale Home render. */
export async function createAndActivateScriptProject(kernel: KernelApi, request: ProjectFromScriptRequest) {
  const controller = kernel.projectDocument;
  if (!controller) throw new Error("Project document lifecycle is unavailable.");
  if (controller.getSnapshot().resource?.dirty) throw new Error("Save or close the current project before importing a script.");
  const registry = kernel.pendingForms;
  if (!registry) throw new Error("Inspector draft validation is unavailable.");
  const guard = await registry.prepareTransition({ applyPendingChanges: false });
  const api = kernel.api;
  const apiScope = api.resourceCacheScope;
  const assertCurrent = () => {
    guard.assertCurrent();
    if (api.resourceCacheScope !== apiScope) throw new Error("The API connection changed; import was stopped.");
  };
  const ensureEmpty = async () => {
    assertCurrent();
    if (api.resourceCacheScope !== apiScope) throw new Error("The API connection changed; import was stopped.");
    const collection = await api.sessions.list();
    assertCurrent();
    if (collection.sessions.some((session) => session.current)) throw new Error("Close the current workspace before importing a script.");
  };
  try {
  await ensureEmpty();
  return await controller.createFromScript(request, async (response, beforeSessionCreate, sessionCreateKnown) => {
    return activateProjectScene(kernel, response, { assertCurrent, ensureEmpty, beforeSessionCreate, sessionCreateKnown });
  }, { assertCurrent, finalize: () => {
    assertCurrent();
    registry.clear();
    kernel.authoringHistory?.clear();
  } });
  } finally {
    guard.release();
  }
}

async function activateProjectScene(
  kernel: Pick<KernelApi, "api" | "resources">,
  response: Pick<ProjectFromScriptResource, "project_id" | "name" | "scene_document">,
  control: { assertCurrent(): void; ensureEmpty(): Promise<void>; beforeSessionCreate(): void; sessionCreateKnown(): void },
) {
  const api = kernel.api;
  const apiScope = api.resourceCacheScope;
  const { assertCurrent, ensureEmpty, beforeSessionCreate, sessionCreateKnown } = control;
  assertCurrent();
  if (!response.scene_document) throw new Error("The runtime did not return the imported scene. The archive is retained; no workspace was created.");
  const scene = cloneBoundedProjectJsonObject(response.scene_document);
  const study = cloneBoundedProjectJsonObject(scene.study);
  if (scene.version !== "scene.v2" ||
      typeof study.requested_backend !== "string" || !["auto", "fdm", "fem", "hybrid"].includes(study.requested_backend) ||
      typeof study.requested_device !== "string" || !["auto", "cpu", "gpu"].includes(study.requested_device) ||
      typeof study.requested_precision !== "string" || !["single", "double"].includes(study.requested_precision)) {
    throw new Error("The imported scene has invalid execution intent; no workspace was created.");
  }
  let storage = study.output_storage;
  if (storage == null) {
    const defaults = await api.platform.outputStorageDefaults();
    assertCurrent();
    if (validateStorageParent(defaults.output_parent) || !defaults.supported_formats.includes(defaults.data_format)) throw new Error("Choose supported output storage in Settings first.");
    storage = newSimulationStorage(defaults, suggestedProjectFolder(response.name, simulationTimestamp(new Date())));
  }
  const selected = cloneBoundedProjectJsonObject(storage);
  if (typeof selected.output_dir !== "string" || typeof selected.temp_dir !== "string" ||
      validateStorageParent(selected.output_dir) || validateStorageParent(selected.temp_dir) ||
      validateStorageSeparation(selected.output_dir, selected.temp_dir)) throw new Error("Choose separate absolute result and temporary directories.");
  // Backend validation remains authoritative for the complete storage schema.
  scene.study = { ...study, output_storage: selected };
  await ensureEmpty();
  assertCurrent();
  beforeSessionCreate();
  let created: Awaited<ReturnType<typeof api.sessions.create>>;
  try {
    created = await api.sessions.create({
      // This empty scratch establishes authoring state; it does not execute a solver.
      // replace_scene preserves authored intent; preparation resolves it from scene.study.
      name: response.name, backend: study.requested_backend === "fem" ? "fem" : "fdm", device: "cpu", precision: "double",
      replace_current: false, output_storage: selected as OutputStorageSettings,
    });
  } catch (error) {
    // The create handler refuses 400/409 before publication. Network/5xx remain unknown.
    if (error instanceof ControlRoomApiError && (error.status === 400 || error.status === 409)) sessionCreateKnown();
    throw error;
  }
  sessionCreateKnown();
  assertCurrent();
  const revision = `session:${created.session_id}`;
  kernel.resources.invalidate(SESSIONS_PATH, revision);
  kernel.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
  kernel.resources.invalidatePrefix(SESSION_CURRENT_PATH, revision);
  const [collection, status] = await Promise.all([api.sessions.list(), api.sessions.current.status()]);
  assertCurrent();
  const identity = confirmedSessionResourceIdentity(sessionResourceIdentityFromStatus(status), collection);
  if (api.resourceCacheScope !== apiScope || identity?.sessionId !== created.session_id) throw new Error("Created workspace identity is unconfirmed. Import will not be retried.");
  const scope = sessionRequestScopeKey(identity);
  if (!scope) throw new Error("The created workspace has no request scope.");
  const options = { sessionScopeKey: scope };
  const current = await api.model.scene(options);
  assertCurrent();
  if (typeof current.revision !== "number" || !Number.isSafeInteger(current.revision)) throw new Error("The created scene revision is unavailable.");
  const binding = createProjectAuthoringSessionBinding(api, response.project_id, created.session_id);
  await binding.verifyCurrent();
  assertCurrent();
  // Scene and selected storage passed the bounded JSON validator above.
  const committed = await api.model.commitTransaction({ kind: "replace_scene", base_revision: current.revision, scene: scene as JsonObject }, options);
  assertCurrent();
  await binding.verifyCurrent();
  assertCurrent();
  if (committed.transaction_kind !== "replace_scene" || committed.scene_revision !== current.revision + 1) throw new Error("Unexpected scene revision. Import will not be retried.");
  kernel.resources.invalidate(MODEL_SCENE_PATH, String(committed.scene_revision));
  kernel.resources.invalidate(MODEL_READINESS_PATH, String(committed.scene_revision));
  return binding;
}

type ProjectActivationContext = Pick<CommandContext,
  "api" | "pendingForms" | "resources" | "authoringHistory" | "projectDocument">;

/** Only the archive owner's explicit authoring projection can create a workspace. */
export async function openAndActivateAuthoringProject(
  context: ProjectActivationContext,
  source: ProjectArchiveSource,
) {
  const controller = context.projectDocument;
  if (!controller) throw new Error("Project document lifecycle is unavailable.");
  if (controller.getSnapshot().resource?.dirty) throw new Error("Save or close the current project before opening another.");
  const apiScope = context.api?.resourceCacheScope;
  let release: () => void = () => undefined;
  let assertTransition: () => void = () => undefined;
  let finalizeTransition: () => void = () => { throw new Error("No authoring transition was prepared."); };
  const assertCurrent = () => {
    assertTransition();
    if (!context.api || context.api.resourceCacheScope !== apiScope) throw new Error("The API connection changed; opening was stopped.");
  };
  try {
    return await controller.open(source, async (response, beforeSessionCreate, sessionCreateKnown) => {
      const { api, resources, pendingForms: registry } = context;
      if (!api || !resources || !registry) throw new Error("Authoring activation services are unavailable. The archive is retained.");
      const guard = await registry.prepareTransition({ applyPendingChanges: false });
      release = () => guard.release();
      assertTransition = () => guard.assertCurrent();
      finalizeTransition = () => {
        guard.assertCurrent();
        registry.clear();
        context.authoringHistory?.clear();
      };
      assertCurrent();
      const ensureEmpty = async () => {
        assertCurrent();
        const collection = await api.sessions.list();
        assertCurrent();
        if (collection.sessions.some((session) => session.current)) throw new Error("Close the current workspace before opening this authoring project.");
      };
      return activateProjectScene({ api, resources }, {
        project_id: response.project_id, name: response.name, scene_document: response.authoring_scene_document,
      }, { assertCurrent, ensureEmpty, beforeSessionCreate, sessionCreateKnown });
    }, { assertCurrent, finalize: () => { assertCurrent(); finalizeTransition(); } });
  } finally {
    release();
  }
}
