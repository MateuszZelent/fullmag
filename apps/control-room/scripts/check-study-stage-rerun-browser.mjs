// Run one guarded P22 Study command through the real Control Room context menu.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startBrowserQaLoopbackProxy } from "./lib/browser-qa-loopback-proxy.mjs";
import {
  buildStageBUniformXResetTransaction,
  clickRunStageBOnce,
  fillStageBUniformXResetInInspector,
  saveStageBResetAndWaitForAck,
  selectStageBAuthoredInitialState,
  validateStageBUniformXResetExchange,
} from "./lib/study-texture-browser-qa.mjs";

const schema = "fullmag.docker-dev-study-stage-rerun-result.v1";
const scenario = "study-stage-rerun";
const sessionName = "P22 three Relax stages";
const sessionRoutePath = "/session/p22-three-relax-stages";
const fixtureRuntimePath = "/opt/fullmag/source/examples/interactive_study/fdm_cpu_three_relax_continue.py";
const stageIds = ["relax-a", "relax-b", "relax-c"];
const statusPath = "/v2/sessions/current/status";
const currentSessionPath = "/v2/sessions/current";
const scenePath = "/v2/sessions/current/model/scene";
const commandsPath = "/v2/sessions/current/simulation/commands";
const currentRunPath = "/v2/sessions/current/simulation/runs/current";
const executionPath = "/v2/sessions/current/simulation/stages/execution";
const solverStatusPath = "/v2/sessions/current/simulation/solver/status";
const resultsBasePath = "/v2/sessions/current/simulation/stages/results";
const commandPath = "/v2/sessions/current/simulation/commands";
const modelTransactionsPath = "/v2/sessions/current/model/transactions";
const clientAckPath = "/v2/sessions/current/visualization/client-acks";
const reportDir = "/tmp/fullmag-study-stage-rerun";
const identityKeys = ["session_id", "session_epoch", "request_scope_epoch"];
const regionRevisionKeys = [
  "region_topology_revision",
  "region_membership_revision",
  "region_coefficients_revision",
  "region_initial_state_revision",
];
const sourceFiles = {
  runner: new URL("./check-study-stage-rerun-browser.mjs", import.meta.url),
  loopback_proxy: new URL("./lib/browser-qa-loopback-proxy.mjs", import.meta.url),
  fixture: new URL("file:///opt/fullmag/p22-fixture.py"),
  scene_adapter: new URL("../src/modules/explorer/builders/sceneModelTreeAdapter.ts", import.meta.url),
  tree_view: new URL("../src/modules/explorer/ExplorerTreeView.tsx", import.meta.url),
  study_nodes: new URL("../src/modules/explorer/builders/study/studyExplorerNodes.ts", import.meta.url),
  stage_builder: new URL("../src/modules/explorer/builders/study/studyStageCommon.ts", import.meta.url),
  command_adapter: new URL("../src/kernel/runtime/studyRuntimeCommandAdapters.ts", import.meta.url),
  command_contributions: new URL("../src/kernel/runtime/studyRuntimeCommandContributions.ts", import.meta.url),
  tab_routes: new URL("../src/kernel/layout/tabRoutes.ts", import.meta.url),
  study_compute_input: new URL("../src/kernel/runtime/studyComputeInput.ts", import.meta.url),
};
const materialSourceFiles = {
  object_nodes: new URL("../src/modules/explorer/builders/objectExplorerNodes.ts", import.meta.url),
  material_panel: new URL("../src/modules/inspector/panels/ObjectMaterialPanel.tsx", import.meta.url),
  material_panel_model: new URL("../src/modules/inspector/panels/ObjectMaterialPanelModel.ts", import.meta.url),
  material_edit_session: new URL("../src/modules/inspector/panels/ObjectMaterialPanelEditSession.ts", import.meta.url),
  material_edit_session_bridge: new URL("../src/modules/inspector/panels/ObjectMaterialPanelEditSessionBridge.tsx", import.meta.url),
  authoring_history: new URL("../src/kernel/authoring/authoringHistoryMutation.ts", import.meta.url),
  api_client: new URL("../src/kernel/api/ControlRoomApi.ts", import.meta.url),
  api_paths: new URL("../src/kernel/api/apiPaths.ts", import.meta.url),
};
const fdmCellSourceFiles = {
  study_global_authoring_model: new URL("../src/modules/inspector/panels/StudyGlobalAuthoringModel.ts", import.meta.url),
  study_inspector_panel: new URL("../src/modules/inspector/panels/StudyInspectorPanel.tsx", import.meta.url),
  study_execution_profile_model: new URL("../src/modules/inspector/panels/StudyExecutionProfileModel.ts", import.meta.url),
  geometry_lifecycle_commands: new URL("../src/kernel/authoring/geometryLifecycleCommandContributions.ts", import.meta.url),
  authoring_history: new URL("../src/kernel/authoring/authoringHistoryMutation.ts", import.meta.url),
  api_client: new URL("../src/kernel/api/ControlRoomApi.ts", import.meta.url),
  api_paths: new URL("../src/kernel/api/apiPaths.ts", import.meta.url),
};
const textureSourceFiles = {
  texture_helper: new URL("./lib/study-texture-browser-qa.mjs", import.meta.url),
  stage_inspector_router: new URL("../src/modules/inspector/panels/StudyStageInspectorRouter.tsx", import.meta.url),
  texture_editor: new URL("../src/modules/inspector/panels/stages/StageTextureAssignmentsEditor.tsx", import.meta.url),
  stage_authoring_model: new URL("../src/modules/inspector/panels/StudyStageAuthoringModel.ts", import.meta.url),
  study_inspector_panel: new URL("../src/modules/inspector/panels/StudyInspectorPanel.tsx", import.meta.url),
  initial_state_selector: new URL("../src/modules/inspector/panels/stages/StageInitialStateSelector.tsx", import.meta.url),
  initial_state_model: new URL("../src/kernel/runtime/studyStageInitialState.ts", import.meta.url),
  api_client: new URL("../src/kernel/api/ControlRoomApi.ts", import.meta.url),
};
const targetFdmCell = [1e-9, 2e-9, 2e-9];
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_REQUESTS = 512;
const MAX_REQUEST_PATHS = 128;
const MAX_READS_PER_PATH = 128;
const MAX_CLIENT_ACKS = 16;
const TERMINAL_COMMAND_STATES = new Set(["completed", "failed", "cancelled", "rejected"]);

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (plainRecord(value)) {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sessionScope(session) {
  return "session=" + encodeURIComponent(session.session_id)
    + "&epoch=" + encodeURIComponent(session.session_epoch)
    + "&request_scope_epoch=" + encodeURIComponent(session.request_scope_epoch);
}

export function studyStageCommandForMode(mode, sceneRevision = null) {
  if (mode === "stage-b") {
    return {
      kind: "relax",
      target: { kind: "stage_id", stage_id: "relax-b" },
      initial_state: { kind: "default_for_target" },
    };
  }
  if (mode === "material-stage-a") {
    return {
      kind: "relax",
      target: { kind: "stage_id", stage_id: "relax-a" },
      initial_state: { kind: "default_for_target" },
    };
  }
  if (mode === "texture-stage-b") {
    return {
      kind: "relax",
      target: { kind: "stage_id", stage_id: "relax-b" },
      initial_state: { kind: "authored_initial_state", source: {
        kind: "stage", scene_revision: sceneRevision, stage_id: "relax-b",
      } },
    };
  }
  if (["study", "fdm-cell-study", "texture-study"].includes(mode)) {
    return { kind: "solve", target: { kind: "study" } };
  }
  throw new TypeError("Study stage rerun mode is not one of the fixed profiles");
}

export function studyStageExpectedStageIds(mode, phase) {
  if (!["stage-b", "study", "material-stage-a", "fdm-cell-study", "texture-stage-b", "texture-study"].includes(mode)) {
    throw new TypeError("Study stage rerun mode is not one of the fixed profiles");
  }
  if (phase === "before") return ["study", "texture-study"].includes(mode) ? ["relax-b"]
    : mode === "fdm-cell-study" ? ["relax-a"] : [...stageIds];
  if (phase === "after") return mode === "stage-b" ? ["relax-b"]
    : mode === "material-stage-a" ? ["relax-a"]
      : mode === "texture-stage-b" ? ["relax-b"] : [...stageIds];
  throw new TypeError("Study stage rerun phase must be before or after");
}

export function studyStageMaterialState(scene) {
  assert(plainRecord(scene) && Array.isArray(scene.objects) && Array.isArray(scene.materials),
    "P22 material scene is missing object or material resources");
  const objects = scene.objects.filter((value) => plainRecord(value) && value.name === "film");
  assert.equal(objects.length, 1, "P22 material target film is absent or duplicated");
  const object = objects[0];
  assert(typeof object.id === "string" && object.id.length > 0);
  assert(typeof object.material_ref === "string" && object.material_ref.length > 0,
    "P22 film has no committed material reference");
  assert(typeof object.magnetization_ref === "string" && object.magnetization_ref.length > 0,
    "P22 film has no authored magnetization reference");
  const materials = scene.materials.filter((value) => plainRecord(value) && value.id === object.material_ref);
  assert.equal(materials.length, 1, "P22 film material resource is absent or duplicated");
  const material = materials[0];
  assert(typeof material.name === "string" && material.name.length > 0);
  assert(plainRecord(material.properties), "P22 film material properties are malformed");
  const assets = Array.isArray(scene.magnetization_assets) ? scene.magnetization_assets : [];
  const magnetizationAssets = assets.filter((value) => plainRecord(value) && value.id === object.magnetization_ref);
  assert.equal(magnetizationAssets.length, 1, "P22 authored magnetization asset is absent or duplicated");
  const magnetizationAssetSha256 = createHash("sha256")
    .update(canonical(magnetizationAssets[0])).digest("hex");
  return {
    object_id: object.id,
    material_id: material.id,
    material_name: material.name,
    properties: structuredClone(material.properties),
    magnetization_ref: object.magnetization_ref,
    magnetization_asset_sha256: magnetizationAssetSha256,
  };
}

function studyStageSceneWithoutMaterial(scene, materialId) {
  const projection = structuredClone(scene);
  delete projection.revision;
  delete projection.scene_revision;
  projection.materials = projection.materials.filter((value) => value?.id !== materialId);
  return projection;
}

export function studyStageUnmodifiedSceneSha256(scene, materialId) {
  return createHash("sha256").update(canonical(studyStageSceneWithoutMaterial(scene, materialId))).digest("hex");
}

function studyStageMaterialProjection(scene, materialId) {
  const material = scene.materials.find((value) => value?.id === materialId);
  if (!plainRecord(material) || !plainRecord(material.properties)) return null;
  const projection = structuredClone(material);
  delete projection.properties;
  const otherProperties = {
    ...Object.fromEntries(Object.entries(material.properties)
      .filter(([key]) => key !== "Ms" && key !== "Aex")),
    Dind: material.properties.Dind ?? null,
    Dbulk: material.properties.Dbulk ?? null,
  };
  return { material: projection, otherProperties };
}

export function studyStageMaterialSceneMatches(beforeScene, afterScene) {
  try {
    const before = studyStageMaterialState(beforeScene);
    const after = studyStageMaterialState(afterScene);
    if (before.object_id !== after.object_id || before.material_id !== after.material_id
        || before.material_name !== after.material_name || before.magnetization_ref !== after.magnetization_ref
        || before.magnetization_asset_sha256 !== after.magnetization_asset_sha256
        || after.properties.Ms !== 600000 || after.properties.Aex !== 1e-11
        || after.properties.alpha !== before.properties.alpha
        || (after.properties.Dind ?? null) !== (before.properties.Dind ?? null)
        || (after.properties.Dbulk ?? null) !== (before.properties.Dbulk ?? null)) return false;
    if (canonical(studyStageSceneWithoutMaterial(beforeScene, before.material_id))
        !== canonical(studyStageSceneWithoutMaterial(afterScene, after.material_id))) return false;
    const beforeMaterial = studyStageMaterialProjection(beforeScene, before.material_id);
    const afterMaterial = studyStageMaterialProjection(afterScene, after.material_id);
    if (!beforeMaterial || !afterMaterial
        || canonical(beforeMaterial.material) !== canonical(afterMaterial.material)
        || canonical(beforeMaterial.otherProperties) !== canonical(afterMaterial.otherProperties)) return false;
    return before.properties.Ms === 800000 && before.properties.Aex === 13e-12
      && before.properties.alpha === 0.5
      && (before.properties.Dind ?? null) === null && (before.properties.Dbulk ?? null) === null;
  } catch {
    return false;
  }
}

export function studyStageMaterialRequestAllowed(request, context) {
  try {
    const body = request?.body;
    const before = context?.before;
    if (context.phase !== "material-submit" || context.materialCount !== 0
        || request?.method !== "POST" || request?.path !== modelTransactionsPath
        || request?.scope !== sessionScope(context.session) || !plainRecord(body)
        || canonical(Object.keys(body).sort()) !== canonical(["base_revision", "kind", "material_id", "patch"].sort())
        || body.kind !== "patch_material" || body.material_id !== before.material_id
        || body.base_revision !== context.beforeRevision || !Number.isSafeInteger(context.beforeRevision)
        || !plainRecord(body.patch)
        || canonical(Object.keys(body.patch).sort()) !== canonical(["name", "properties"].sort())
        || body.patch.name !== before.material_name || !plainRecord(body.patch.properties)
        || canonical(Object.keys(body.patch.properties).sort()) !== canonical(["Aex", "Dbulk", "Dind", "Ms", "alpha"].sort())) {
      return false;
    }
    const properties = body.patch.properties;
    return properties.Ms === 600000 && properties.Aex === 1e-11
      && properties.alpha === before.properties.alpha
      && properties.Dind === (before.properties.Dind ?? null)
      && properties.Dbulk === (before.properties.Dbulk ?? null);
  } catch {
    return false;
  }
}

export function studyStageMaterialTransactionOutcome(status, body, beforeScene) {
  try {
    const scene = body?.committed_scene;
    const nextRevision = beforeScene.revision ?? beforeScene.scene_revision;
    if (!Number.isSafeInteger(nextRevision) || !Number.isSafeInteger(status) || status < 200 || status >= 300
        || !plainRecord(body) || body.transaction_kind !== "patch_material"
        || body.scene_revision !== nextRevision + 1 || !plainRecord(scene)
        || (scene.revision ?? scene.scene_revision) !== body.scene_revision
        || !studyStageMaterialSceneMatches(beforeScene, scene)) {
      return { outcome: "unknown", scene_revision: null, material: null };
    }
    return {
      outcome: "accepted",
      scene_revision: body.scene_revision,
      material: studyStageMaterialState(scene),
    };
  } catch {
    return { outcome: "unknown", scene_revision: null, material: null };
  }
}

export function studyStageShouldReadTerminalResources(status, runId) {
  return typeof runId === "string" && runId.length > 0
    && status?.run?.run_id === runId && status?.solver?.state === "awaiting_command";
}

function stripSceneRevision(scene) {
  const projection = structuredClone(scene);
  delete projection.revision;
  delete projection.scene_revision;
  return projection;
}

function sceneWithoutFdmDefaultCell(scene) {
  const projection = stripSceneRevision(scene);
  if (plainRecord(projection.study) && plainRecord(projection.study.fdm)) {
    delete projection.study.fdm.default_cell;
  }
  return projection;
}

function applyJsonMergePatch(target, patch) {
  if (!plainRecord(patch)) return structuredClone(patch);
  const result = plainRecord(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = applyJsonMergePatch(result[key], value);
  }
  return result;
}

function readFdmDefaultCell(scene) {
  assert(plainRecord(scene) && plainRecord(scene.study) && plainRecord(scene.study.fdm),
    "P22 scene omitted its authored FDM grid settings");
  const cell = scene.study.fdm.default_cell;
  assert(Array.isArray(cell) && cell.length === 3
    && cell.every((value) => Number.isFinite(value) && value > 0),
  "P22 FDM default cell is missing or malformed");
  return [...cell];
}

export function studyStageFdmCellState(scene) {
  const cell = readFdmDefaultCell(scene);
  assert.notDeepEqual(cell, targetFdmCell, "P22 FDM default cell already has the requested value");
  return { cell };
}

export function studyStageFdmCellSceneMatches(beforeScene, afterScene) {
  try {
    studyStageFdmCellState(beforeScene);
    if (canonical(readFdmDefaultCell(afterScene)) !== canonical(targetFdmCell)) return false;
    return canonical(sceneWithoutFdmDefaultCell(beforeScene))
      === canonical(sceneWithoutFdmDefaultCell(afterScene));
  } catch {
    return false;
  }
}

export function studyStageFdmCellRequestAllowed(request, context) {
  try {
    const body = request?.body;
    if (context?.phase !== "fdm-cell-submit" || context.transactionCount !== 0
        || request?.method !== "POST" || request?.path !== modelTransactionsPath
        || request?.scope !== sessionScope(context.session) || !plainRecord(body)
        || canonical(Object.keys(body).sort()) !== canonical(["base_revision", "kind", "merge_patch"])
        || body.kind !== "merge_patch" || body.base_revision !== context.beforeRevision
        || !Number.isSafeInteger(context.beforeRevision) || !plainRecord(body.merge_patch)
        || canonical(Object.keys(body.merge_patch)) !== canonical(["study"])
        || !plainRecord(body.merge_patch.study)
        || canonical(Object.keys(body.merge_patch.study).sort()) !== canonical(["fdm"])
        || !plainRecord(body.merge_patch.study.fdm)
        || canonical(Object.keys(body.merge_patch.study.fdm).sort()) !== canonical(["default_cell"])) return false;
    const candidate = applyJsonMergePatch(context.beforeScene, body.merge_patch);
    return studyStageFdmCellSceneMatches(context.beforeScene, candidate)
      && canonical(candidate.study.fdm.default_cell) === canonical(targetFdmCell);
  } catch {
    return false;
  }
}

export function studyStageFdmCellTransactionOutcome(status, body, beforeScene) {
  try {
    const before = studyStageFdmCellState(beforeScene);
    const revision = beforeScene.revision ?? beforeScene.scene_revision;
    const scene = body?.committed_scene;
    if (!Number.isSafeInteger(status) || status < 200 || status >= 300
        || !plainRecord(body) || body.transaction_kind !== "merge_patch"
        || !Number.isSafeInteger(revision) || body.scene_revision !== revision + 1
        || !plainRecord(scene) || (scene.revision ?? scene.scene_revision) !== body.scene_revision
        || !studyStageFdmCellSceneMatches(beforeScene, scene)) {
      return { outcome: "unknown", scene_revision: null, before_cell: before.cell, after_cell: null };
    }
    return { outcome: "accepted", scene_revision: body.scene_revision,
      before_cell: before.cell, after_cell: [...scene.study.fdm.default_cell] };
  } catch {
    return { outcome: "unknown", scene_revision: null, before_cell: null, after_cell: null };
  }
}

export function studyStageFdmGridRefreshRequestAllowed(request, context) {
  try {
    const body = request?.body;
    const intent = body?.client_intent_id;
    return context?.phase === "fdm-grid-submit" && context.refreshCount === 0
      && request?.method === "POST" && request?.path === commandPath
      && request?.scope === sessionScope(context.session) && plainRecord(body)
      && canonical(Object.keys(body).sort()) === canonical(["client_intent_id", "kind", "precondition", "reason"])
      && body.kind === "fdm_grid_refresh" && body.reason === "study_global_commit"
      && plainRecord(body.precondition)
      && canonical(Object.keys(body.precondition).sort()) === canonical(["scene_revision"])
      && body.precondition.scene_revision === context.sceneRevision
      && typeof intent === "string" && /^fdm-grid-refresh-[0-9]+-[0-9]+$/.test(intent)
      && !context.existingIntentIds?.has(intent);
  } catch {
    return false;
  }
}

export function studyStageObserveResponse(promise, label) {
  return promise.then(
    (response) => ({ response, error: null }),
    (error) => ({ response: null, error: label + boundedMessage(error) }),
  );
}

export function studyStageCommandResponseOutcome(status, body) {
  if (Number.isSafeInteger(status) && status >= 200 && status < 300
      && plainRecord(body) && body.accepted === true
      && typeof body.command_id === "string" && body.command_id.length > 0) {
    return { outcome: "accepted", command_id: body.command_id };
  }
  return { outcome: "unknown", command_id: null };
}

export function studyStageExecutionBindingMatches(binding, mode, runId) {
  try {
    if (!plainRecord(binding) || typeof runId !== "string" || !runId
        || binding.run_id !== runId) return false;
    const target = studyStageCommandForMode(mode).target;
    if (canonical(binding.requested_target) !== canonical(target)) return false;
    if (["stage-b", "material-stage-a", "texture-stage-b"].includes(mode)) return binding.step_id === target.stage_id;
    return binding.step_id === undefined || binding.step_id === null;
  } catch {
    return false;
  }
}

export function studyStageRerunRequestAllowed(request, context) {
  try {
    const expected = studyStageCommandForMode(context?.mode, context?.expectedPrecondition?.scene_revision);
    const body = request?.body;
    if (context.phase !== "ui-submit" || context.commandCount !== 0
        || request?.method !== "POST" || request?.path !== commandPath
        || request?.scope !== sessionScope(context.session) || !plainRecord(body)) return false;
    const isStageTarget = ["stage-b", "material-stage-a", "texture-stage-b"].includes(context.mode);
    const expectedKeys = isStageTarget
      ? ["kind", "target", "initial_state", "precondition", "client_intent_id", "reason", "requested_at_unix_ms"]
      : ["kind", "target", "precondition", "client_intent_id", "reason", "requested_at_unix_ms"];
    if (canonical(Object.keys(body).sort()) !== canonical(expectedKeys.sort())) return false;
    if (body.kind !== expected.kind || canonical(body.target) !== canonical(expected.target)
        || (isStageTarget && canonical(body.initial_state) !== canonical(expected.initial_state))
        || canonical(body.precondition) !== canonical(context.expectedPrecondition)) return false;
    if (context.mode === "texture-stage-b" && context.idempotencyKey !== body.client_intent_id) return false;
    return typeof body.client_intent_id === "string"
      && body.client_intent_id.length > 0 && body.client_intent_id.length <= 128
      && body.client_intent_id.startsWith("study:" + (isStageTarget ? "relax" : "solve") + ":")
      && body.reason === "user_requested"
      && Number.isSafeInteger(body.requested_at_unix_ms) && body.requested_at_unix_ms > 0;
  } catch {
    return false;
  }
}

export function studyStageCameraPatchAllowed(request, session) {
  try {
    const body = request?.body;
    if (request?.method !== "PATCH" || request?.path !== "/v2/sessions/current/visualization/state"
        || request?.scope !== sessionScope(session) || !plainRecord(body)
        || canonical(Object.keys(body)) !== canonical(["camera"])) return false;
    const camera = body.camera;
    const keys = ["fov_degrees", "orthographic_scale", "position", "projection", "target", "up"];
    if (!plainRecord(camera) || canonical(Object.keys(camera).sort()) !== canonical(keys)
        || !["orthographic", "perspective"].includes(camera.projection)
        || !Number.isFinite(camera.fov_degrees) || camera.fov_degrees <= 0 || camera.fov_degrees >= 180
        || !(camera.orthographic_scale === null
          || Number.isFinite(camera.orthographic_scale) && camera.orthographic_scale > 0)) return false;
    return [camera.position, camera.target, camera.up].every((vector) =>
      Array.isArray(vector) && vector.length === 3 && vector.every(Number.isFinite));
  } catch {
    return false;
  }
}

export function studyStageRerunClientAckAllowed(request, session) {
  const body = request?.body;
  if (request?.method !== "POST" || request?.path !== clientAckPath
      || request?.scope !== sessionScope(session) || !plainRecord(body)) return false;
  const keys = ["client_id", "client_label", "effective_render_mode", "error", "revision", "status", "viewport_id"];
  if (Object.keys(body).some((key) => !keys.includes(key))
      || typeof body.client_id !== "string" || body.client_id.length < 1 || body.client_id.length > 256
      || !Number.isSafeInteger(body.revision) || body.revision < 0
      || !["applied", "rendered", "failed"].includes(body.status)) return false;
  for (const key of ["client_label", "effective_render_mode", "error", "viewport_id"]) {
    if (body[key] !== undefined && (typeof body[key] !== "string" || body[key].length > 512)) return false;
  }
  return true;
}

export function studyStageResultIdentity(result) {
  assert(plainRecord(result), "Study stage result is not an object");
  const source = result.source;
  assert(plainRecord(source), "Study stage result omitted its scalar-series identity");
  assert(typeof source.run_id === "string" && source.run_id.length > 0);
  for (const key of ["task_id", "step_id", "case_id", "attempt_id"]) {
    assert(typeof source[key] === "string" && source[key].length > 0);
  }
  assert(Number.isSafeInteger(source.ownership_epoch) && source.ownership_epoch >= 0);
  assert(typeof result.authored_stage_id === "string" && stageIds.includes(result.authored_stage_id));
  assert(typeof result.project_id === "string" && result.project_id.length > 0);
  assert(typeof result.study_id === "string" && result.study_id.length > 0);
  assert(typeof result.artifact_id === "string" && result.artifact_id.length > 0);
  assert(/^[0-9a-f]{64}$/.test(result.artifact_sha256));
  assert(typeof result.codec_id === "string" && result.codec_id.length > 0);
  assert(typeof result.codec_version === "string" && result.codec_version.length > 0);
  assert(typeof result.accepted_at === "string" && result.accepted_at.length > 0);
  return {
    project_id: result.project_id,
    study_id: result.study_id,
    source: {
      run_id: source.run_id,
      task_id: source.task_id,
      step_id: source.step_id,
      case_id: source.case_id,
      attempt_id: source.attempt_id,
      ownership_epoch: source.ownership_epoch,
    },
    authored_stage_id: result.authored_stage_id,
    artifact_id: result.artifact_id,
    artifact_sha256: result.artifact_sha256,
    codec_id: result.codec_id,
    codec_version: result.codec_version,
    accepted_at: result.accepted_at,
  };
}

export function studyStageHistoryIdentitiesPreserved(before, after) {
  try {
    const identities = (items) => items.map(studyStageResultIdentity)
      .sort((left, right) => left.authored_stage_id.localeCompare(right.authored_stage_id));
    return canonical(identities(before)) === canonical(identities(after));
  } catch {
    return false;
  }
}

function boundedMessage(error) {
  return String(error?.message ?? error).replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 512);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function deadline(promise, milliseconds, message) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

async function sourceHashes(mode) {
  const files = {
    ...sourceFiles,
    ...(mode === "material-stage-a" ? materialSourceFiles : {}),
    ...(mode === "fdm-cell-study" ? fdmCellSourceFiles : {}),
    ...(["texture-stage-b", "texture-study"].includes(mode) ? textureSourceFiles : {}),
  };
  const entries = await Promise.all(Object.entries(files).map(async ([key, path]) => {
    const raw = await fs.readFile(path);
    assert(raw.length <= MAX_SOURCE_BYTES, "Study stage rerun source exceeds its pin bound");
    return [key, createHash("sha256").update(raw).digest("hex")];
  }));
  return Object.fromEntries(entries);
}

export function readStudyStageSessionIdentity(status, { requireCommandable = true } = {}) {
  const session = status?.session;
  assert(plainRecord(session) && session.name === sessionName, "The current session is not the task-owned P22 fixture");
  for (const key of identityKeys) {
    assert(typeof session[key] === "string" && session[key].length > 0 && session[key].length <= 512,
      "The P22 session omitted its scoped identity");
  }
  assert(status.lifecycle?.connectivity === "connected"
    && status.lifecycle?.session_resource === "active"
    && (!requireCommandable || status.lifecycle?.commandability === "allowed"),
    "The P22 session is disconnected, inactive or not commandable");
  return Object.fromEntries([...identityKeys, "name"].map((key) => [key, session[key]]));
}

function assertSameSession(expected, actual) {
  assert(identityKeys.every((key) => expected?.[key] === actual?.[key])
    && expected?.name === actual?.name, "P22 session identity or request scope changed");
}

function authoredSceneStageIds(scene) {
  const nodes = scene?.study?.study_pipeline?.nodes;
  assert(Array.isArray(nodes), "The committed P22 scene omitted Study pipeline nodes");
  const found = [];
  const visit = (items) => {
    for (const node of items) {
      if (!plainRecord(node)) continue;
      if (node.node_kind === "primitive") {
        const stageId = node.id ?? node.stage_id ?? node.payload?.stage_id;
        if (typeof stageId === "string") found.push(stageId);
      }
      if (Array.isArray(node.children)) visit(node.children);
    }
  };
  visit(nodes);
  assert.deepEqual(found, stageIds, "The committed scene is not the exact three-stage P22 fixture");
  return found;
}

export function validateStudyStageScene(scene) {
  const study = scene?.study;
  assert(plainRecord(study), "The P22 scene omitted its Study request profile");
  assert.equal(study.requested_backend, "fdm", "The current Study request is not FDM");
  assert.equal(study.requested_device, "cpu", "The current Study request is not CPU");
  assert.equal(study.requested_precision, "double", "The current Study request is not double precision");
  const pipeline = study.study_pipeline;
  assert(plainRecord(pipeline) && pipeline.version === "study_pipeline.v1"
    && canonical(Object.keys(pipeline).sort()) === canonical(["nodes", "version"]),
  "The P22 pipeline is not the exact imported Study pipeline");
  const expectedNodes = [
    {
      enabled: true, id: "relax-a", label: "Relax 1", node_kind: "primitive", source: "script_imported",
      stage_kind: "relax",
      payload: {
        adaptive_timestep: null, demag_interval_s: "", energy_tolerance: "", entrypoint_kind: "flat_relax",
        fixed_timestep: "1e-13", integrator: "rk23", kind: "relax", max_relaxation_time_s: "",
        max_steps: "10", relax_algorithm: "llg_overdamped", stage_id: "relax-a",
        torque_tolerance: "0.0001", until_seconds: "",
      },
    },
    {
      enabled: true, id: "relax-b", label: "Relax 2", node_kind: "primitive", source: "script_imported",
      stage_kind: "relax",
      payload: {
        energy_tolerance: "", entrypoint_kind: "flat_relax", kind: "relax", max_steps: "1",
        relax_algorithm: "projected_gradient_bb", stage_id: "relax-b", torque_tolerance: "0.0001",
        until_seconds: "",
      },
    },
    {
      enabled: true, id: "relax-c", label: "Relax 3", node_kind: "primitive", source: "script_imported",
      stage_kind: "relax",
      payload: {
        energy_tolerance: "", entrypoint_kind: "flat_relax", kind: "relax", max_steps: "1",
        relax_algorithm: "nonlinear_cg", stage_id: "relax-c", torque_tolerance: "0.0001",
        until_seconds: "",
      },
    },
  ];
  assert.deepEqual(pipeline.nodes, expectedNodes,
    "The P22 pipeline has an edited, disabled, grouped or additional stage");
  return {
    requested_backend: study.requested_backend,
    requested_device: study.requested_device,
    requested_precision: study.requested_precision,
    pipeline_version: pipeline.version,
    stages: pipeline.nodes.map((node) => ({
      id: node.id,
      enabled: node.enabled,
      node_kind: node.node_kind,
      stage_kind: node.stage_kind,
      relax_algorithm: node.payload.relax_algorithm,
      max_steps: node.payload.max_steps,
    })),
  };
}

/** Validate the one supported v1 -> v2 B-local +X reset without relaxing the imported v1 profile. */
export function studyStageTextureSceneProfile(scene, { allowUnedited = false } = {}) {
  const pipeline = scene?.study?.study_pipeline;
  assert.deepEqual(scene?.study?.fdm?.default_cell, targetFdmCell,
    "The texture profile requires the accepted sixteen-cell FDM cell geometry");
  if (pipeline?.version === "study_pipeline.v1") {
    assert(allowUnedited, "The texture profile requires the acknowledged Stage B reset");
    const profile = validateStudyStageScene(scene);
    return { ...profile, pipeline_version: "study_pipeline.v1", stage_b_texture_reset: null };
  }
  assert(plainRecord(pipeline) && pipeline.version === "study_pipeline.v2",
    "The texture profile requires the exact saved Study pipeline v2");
  const magnets = Array.isArray(scene.objects)
    ? scene.objects.filter((object) => plainRecord(object) && object.role === "magnet") : [];
  assert.equal(magnets.length, 1, "The texture profile requires exactly one magnetic object");
  const objectId = magnets[0].id;
  assert(typeof objectId === "string" && objectId.length > 0);
  const baseline = structuredClone(scene);
  baseline.study.study_pipeline.version = "study_pipeline.v1";
  const b = baseline.study.study_pipeline.nodes.find((node) => node?.id === "relax-b");
  assert(plainRecord(b?.payload) && Object.hasOwn(b.payload, "stage_magnetization_assignments"),
    "The v2 texture profile has no stage-local B reset");
  const assignment = b.payload.stage_magnetization_assignments;
  assert.deepEqual(assignment, {
    schema_version: "fullmag.magnetization-assignments.v1",
    assignments: [{ object_id: objectId, region_id: null, initializer: null }],
  }, "The v2 texture profile has an unexpected B-local assignment");
  delete b.payload.stage_magnetization_assignments;
  const profile = validateStudyStageScene(baseline);
  const revision = baseline.revision ?? baseline.scene_revision;
  const expected = buildStageBUniformXResetTransaction({
    scene: baseline, sceneRevision: revision, statusSceneRevision: revision, objectId,
  }).merge_patch.study.study_pipeline;
  assert.deepEqual(pipeline, expected, "The v2 pipeline differs outside the single Stage B reset");
  return { ...profile, pipeline_version: "study_pipeline.v2",
    stage_b_texture_reset: { stage_id: "relax-b", object_id: objectId, scope: "object", initializer: null } };
}

export function studyStageTextureBaselineState(scene) {
  const material = studyStageMaterialState(scene);
  assert.equal(material.properties.Ms, 600000);
  assert.equal(material.properties.Aex, 1e-11);
  assert.equal(material.properties.alpha, 0.5);
  assert.equal(material.properties.Dind ?? null, null);
  assert.equal(material.properties.Dbulk ?? null, null);
  const asset = scene.magnetization_assets.find((entry) => entry?.id === material.magnetization_ref);
  assert(plainRecord(asset) && asset.kind === "preset_texture" && asset.preset_kind === "uniform"
    && plainRecord(asset.preset_params), "The texture profile requires the accepted uniform +X global m0");
  assert.deepEqual(asset.preset_params.direction, [1, 0, 0],
    "The texture profile global m0 is not uniform +X");
  return {
    material,
    default_cell: [...scene.study.fdm.default_cell],
    global_m0: { object_id: material.object_id, magnetization_ref: material.magnetization_ref,
      asset_sha256: material.magnetization_asset_sha256, preset_kind: asset.preset_kind,
      direction: [...asset.preset_params.direction] },
  };
}

/** Bind an accepted same-domain public result to the immutable A/B result identity. */
export function studyStageTextureCatalogProof(resource, runId, stageId, expectedIdentity, objectId) {
  assert(plainRecord(resource) && Array.isArray(resource.results) && resource.next_cursor == null,
    "P22 texture result catalog page is malformed or incomplete");
  const found = resource.results.filter((result) => result?.authored_stage_id === stageId);
  assert.equal(found.length, 1, "P22 texture result catalog omitted or duplicated the required stage");
  const result = found[0];
  const identity = studyStageResultIdentity(result);
  assert.equal(identity.source.run_id, runId, "P22 texture input result belongs to another run");
  assert.deepEqual(identity, expectedIdentity, "P22 texture input result differs from its immutable run identity");
  assert.equal(result.authored_relation, "matching_authored_input");
  assert.equal(result.domain_relation, "matching_published_layout");
  assert.equal(result.supports_magnetization_input, true);
  assert(typeof objectId === "string" && objectId.length > 0);
  return {
    authored_stage_id: stageId,
    object_id: objectId,
    run_id: runId,
    artifact_id: identity.artifact_id,
    artifact_sha256: identity.artifact_sha256,
    codec_id: identity.codec_id,
    codec_version: identity.codec_version,
    authored_relation: result.authored_relation,
    domain_relation: result.domain_relation,
    supports_magnetization_input: result.supports_magnetization_input,
  };
}

function currentProfile(status, currentRun, currentSession, expectedSources, expectedCellCount = 8) {
  const domain = status?.domain;
  const resources = status?.resources;
  assert(plainRecord(domain) && domain.discretization === "fdm" && domain.cell_count === expectedCellCount,
    "The current P22 domain has the wrong FDM cell count");
  assert(typeof domain.generation_id === "string" && domain.generation_id.length > 0
    && domain.generation_id === resources?.domain_generation_id,
  "P22 domain generation differs from the published resource identity");
  assert(currentRun?.requested_backend === "fdm"
    && currentRun?.requested_device === "cpu"
    && currentRun?.requested_precision === "double",
  "The current run is not the pinned FDM CPU double profile");
  assert(currentSession?.current === true && currentSession?.session_id === status.session.session_id
    && currentSession?.name === sessionName,
  "The current-session resource differs from the pinned P22 session");
  assert(plainRecord(currentSession.script)
    && currentSession.script.path === fixtureRuntimePath
    && currentSession.script.sha256 === expectedSources.fixture,
  "The active script path or source hash differs from the pinned P22 fixture");
  assert(status.session.script?.path === fixtureRuntimePath,
    "The status resource reports a different active P22 script path");
  return {
    domain_discretization: domain.discretization,
    domain_cell_count: domain.cell_count,
    domain_generation_id: domain.generation_id,
    requested_backend: currentRun.requested_backend,
    requested_device: currentRun.requested_device,
    requested_precision: currentRun.requested_precision,
    script_path: currentSession.script.path,
    script_sha256: currentSession.script.sha256,
  };
}

export function studyStageComputePrecondition(status, currentRun, solverStatus, commands) {
  const resources = status?.resources;
  assert(plainRecord(resources), "The P22 status omitted current resource revisions");
  const precondition = {};
  for (const key of regionRevisionKeys) {
    assert(Number.isSafeInteger(resources[key]) && resources[key] >= 0,
      "The P22 status omitted a region revision precondition");
    precondition[key] = resources[key];
  }
  for (const key of ["scene_revision", "mesh_revision"]) {
    assert(Number.isSafeInteger(resources[key]) && resources[key] >= 0,
      "The P22 status omitted a scene or mesh revision precondition");
    precondition[key] = resources[key];
  }
  assert(typeof resources.domain_generation_id === "string" && resources.domain_generation_id.length > 0);
  precondition.domain_generation_id = resources.domain_generation_id;
  assert(status.run?.run_id === currentRun.run_id, "Status and current-run resources disagree");
  precondition.current_run = { kind: "run", run_id: currentRun.run_id };
  assert(solverStatus?.runtime_state === "awaiting_command",
    "Solver status is not awaiting a command before submission");
  precondition.runtime_state = solverStatus.runtime_state;
  assert(Array.isArray(commands?.commands), "Command queue resource is malformed");
  precondition.command_revision = commands.commands.length;
  return precondition;
}

function resultIdentities(resource, runId, expectedIds) {
  assert(plainRecord(resource) && Array.isArray(resource.results), "Study results resource is malformed");
  assert(resource.next_cursor == null, "Study result page is incomplete");
  const identities = resource.results.map(studyStageResultIdentity)
    .sort((left, right) => left.authored_stage_id.localeCompare(right.authored_stage_id));
  assert.deepEqual(identities.map((entry) => entry.authored_stage_id), expectedIds,
    "Study results include a missing, duplicate or extra authored stage");
  assert(identities.every((entry) => entry.source.run_id === runId),
    "Study result source belongs to another run");
  return identities;
}

function executionStageIds(execution, runId, session) {
  assert(plainRecord(execution) && execution.run_id === runId
    && execution.session_id === session.session_id
    && execution.session_epoch === session.session_epoch
    && execution.request_scope_epoch === session.request_scope_epoch,
  "Stage execution resource belongs to another run or session");
  assert(Array.isArray(execution.stages), "Stage execution omitted its stage rows");
  return execution.stages.map((stage) => stage?.stage_id);
}

export function studyStageTerminalScope(execution, authoredIds, expectedExecutedIds) {
  const selected = new Set(expectedExecutedIds);
  assert.equal(selected.size, expectedExecutedIds.length);
  assert.equal(execution.total_stages, authoredIds.length);
  assert.deepEqual(execution.stages.map((row) => row.stage_id), authoredIds,
    "P22 stage view must preserve the authored definitions");
  const expectedStatuses = authoredIds.map((id) => selected.has(id) ? "completed" : "pending");
  assert.deepEqual(execution.stage_statuses, expectedStatuses,
    "P22 current execution includes another or unfinished stage");
  assert.deepEqual(execution.completed_stage_indexes,
    authoredIds.flatMap((id, index) => selected.has(id) ? [index] : []));
  for (const [index, row] of execution.stages.entries()) {
    assert.equal(row.index, index);
    assert.equal(row.status, expectedStatuses[index]);
    if (!selected.has(row.stage_id)) {
      for (const key of ["started_at_unix_ms", "completed_at_unix_ms", "completed_step"]) {
        assert.equal(row[key], undefined, "An unselected stage has execution metadata");
      }
    }
  }
  const executed = execution.stages.filter((row) => row.status === "completed").map((row) => row.stage_id);
  assert.deepEqual(executed, expectedExecutedIds);
  return executed;
}

function assertNoInflightCommands(queue) {
  assert(plainRecord(queue) && Array.isArray(queue.commands), "Simulation command queue is malformed");
  assert(queue.pending_count === 0 && queue.running_count === 0,
    "A Simulation command is pending or running before the P22 action");
  assert(queue.commands.every((command) => TERMINAL_COMMAND_STATES.has(command?.status)),
    "The command queue contains an in-flight or unknown command state");
}

function stableProjection(snapshot) {
  return {
    session: snapshot.session,
    current_run: {
      run_id: snapshot.currentRun.run_id,
      session_id: snapshot.currentRun.session_id,
      revision: snapshot.currentRun.revision,
      status: snapshot.currentRun.status,
      requested_backend: snapshot.currentRun.requested_backend,
      requested_device: snapshot.currentRun.requested_device,
      requested_precision: snapshot.currentRun.requested_precision,
    },
    current_session_script: snapshot.profile,
    resources: {
      ...Object.fromEntries([...regionRevisionKeys, "scene_revision", "mesh_revision", "domain_generation_id",
        "commands_revision", "stages_revision"].map((key) => [key, snapshot.status.resources[key]])),
    },
    solver_state: snapshot.solverStatus.runtime_state,
    commands: { revision: snapshot.commands.revision, count: snapshot.commands.commands.length,
      active_counts: [snapshot.commands.pending_count, snapshot.commands.running_count] },
    execution: {
      run_id: snapshot.execution.run_id,
      revision: snapshot.execution.revision,
      runtime_state: snapshot.execution.runtime_state,
      total_stages: snapshot.execution.total_stages,
      stage_ids: snapshot.stageIds,
      authored_stage_ids: snapshot.sceneStageIds,
      stage_statuses: snapshot.execution.stage_statuses,
      completed_stage_indexes: snapshot.execution.completed_stage_indexes,
    },
    scene_revision: snapshot.scene.revision,
    scene_stage_ids: snapshot.sceneStageIds,
    scene_profile: snapshot.sceneProfile,
    result_identities: snapshot.resultIdentities,
    precondition: snapshot.precondition,
  };
}

export async function runStudyStageRerun() {
  assert.equal(process.env.CONTROL_ROOM_BROWSER_QA_SCENARIO, scenario,
    "Managed Study stage rerun admission is required");
  const mode = process.argv[2];
  studyStageCommandForMode(mode);
  assert.equal(process.argv.length, 3, "The fixed Study stage runner accepts exactly one mode");
  assert.equal(process.env.CONTROL_ROOM_STUDY_STAGE_RERUN_MODE, mode);
  const upstreamUrl = process.env.CONTROL_ROOM_URL;
  const publicUrl = process.env.CONTROL_ROOM_PUBLIC_URL;
  const expectedSources = JSON.parse(process.env.CONTROL_ROOM_STUDY_STAGE_RERUN_SOURCE_SHA256 ?? "null");
  const beforeHashes = await sourceHashes(mode);
  assert.deepEqual(beforeHashes, expectedSources, "Study stage rerun source pins differ");
  const expectedVersion = process.env.CONTROL_ROOM_EXPECTED_PLAYWRIGHT_VERSION;
  const require = createRequire(import.meta.url);
  const playwrightVersion = require("playwright/package.json").version;
  assert.equal(playwrightVersion, expectedVersion);
  const { chromium } = await import("playwright");
  const timeout = Number(process.env.CONTROL_ROOM_BROWSER_QA_TIMEOUT_MS);
  assert(Number.isInteger(timeout) && timeout >= 30_000 && timeout <= 900_000);
  const startedAt = Date.now();
  const cleanupReserveMs = 20_000;
  const timerBudget = () => Math.max(1, timeout - cleanupReserveMs - (Date.now() - startedAt));
  const readCounts = { status: 0, current_session: 0, scene: 0, commands: 0,
    current_run: 0, stage_execution: 0, solver_status: 0, stage_results: 0, command_details: 0 };
  const requestCounts = {};
  const errors = [];
  const violations = [];
  let totalRequests = 0;
  let phase = "preflight";
  let proxy, browser, context, page;
  let session = null;
  let before = null;
  let beforeSnapshot = null;
  let after = null;
  let reloadProof = null;
  let expectedDomainCellCount = 8;
  if (["texture-stage-b", "texture-study"].includes(mode)) expectedDomainCellCount = 16;
  let materialBeforeState = null;
  let materialSourceScene = null;
  let materialReceipt = null;
  let materialRequest = null;
  let materialCount = 0;
  let materialAttemptCount = 0;
  let uiMaterialProven = false;
  let fdmCellBeforeState = null;
  let fdmCellSourceScene = null;
  let fdmMaterialBeforeState = null;
  let fdmCellReceipt = null;
  let fdmCellRequest = null;
  let fdmCellCount = 0;
  let fdmCellAttemptCount = 0;
  let uiFdmCellProven = false;
  let gridRefreshReceipt = null;
  let gridRefreshRequest = null;
  let gridRefreshCount = 0;
  let gridRefreshAttemptCount = 0;
  let uiGridRefreshProven = false;
  let gridRefreshTerminalDetail = null;
  let textureSourceProof = null;
  let textureBaselineState = null;
  let textureSourceScene = null;
  let textureReceipt = null;
  let textureTransactionCount = 0;
  let textureTransactionAttemptCount = 0;
  let uiTextureProven = false;
  let commandCount = 0;
  let commandAttemptCount = 0;
  let clientAckCount = 0;
  const cameraPatchReceipts = [];
  let commandRequest = null;
  let commandReceipt = null;
  let executionBinding = null;
  let executionBindingReads = 0;
  let expectedPrecondition = null;
  let failure = null;
  let outcome = "not-dispatched";
  let publicTerminalProven = false;
  let uiCommandProven = false;
  let historyIdentityPreserved = null;

  function record(method, path) {
    totalRequests++;
    if (totalRequests > MAX_REQUESTS) throw new Error("Study stage rerun request evidence exceeded its bound");
    const key = method + " " + path;
    if (!Object.hasOwn(requestCounts, key) && Object.keys(requestCounts).length >= MAX_REQUEST_PATHS) {
      throw new Error("Study stage rerun API path inventory exceeded its bound");
    }
    requestCounts[key] = (requestCounts[key] ?? 0) + 1;
    if (requestCounts[key] > MAX_READS_PER_PATH) throw new Error("Study stage rerun per-path request budget exceeded");
  }

  async function apiGet(path, expectedSession = session, scoped = true) {
    record("GET", path);
    const response = await page.request.fetch(new URL(path, proxy.origin).href, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(scoped && expectedSession ? { "x-fullmag-session-scope": sessionScope(expectedSession) } : {}),
      },
      timeout: Math.min(10_000, timerBudget()),
    });
    assert(response.ok(), "P22 public API read was not acknowledged: " + path);
    const raw = await response.body();
    assert(raw.length <= MAX_API_BYTES, "P22 public API resource exceeded its size bound");
    return JSON.parse(raw.toString("utf8"));
  }

  async function readResults(runId, expectedSession, expectedStageIds) {
    const path = resultsBasePath + "?run_id=" + encodeURIComponent(runId) + "&limit=100";
    readCounts.stage_results++;
    const resource = await apiGet(path, expectedSession);
    return resultIdentities(resource, runId, expectedStageIds);
  }

  async function readTextureSourceProof(snapshot) {
    const stageId = mode === "texture-stage-b" ? "relax-a" : "relax-b";
    const path = resultsBasePath + "?run_id=" + encodeURIComponent(snapshot.currentRun.run_id) + "&limit=100";
    readCounts.stage_results++;
    const resource = await apiGet(path, snapshot.session);
    assert.equal(resource.scene_revision, snapshot.scene.revision ?? snapshot.scene.scene_revision,
      "P22 texture source catalog is not pinned to the displayed scene revision");
    assert.deepEqual(resource.authored_stage_ids, stageIds,
      "P22 texture source catalog does not contain the exact authored Study stages");
    const expectedIdentity = snapshot.resultIdentities.find((result) => result.authored_stage_id === stageId);
    assert(expectedIdentity, "P22 texture source result identity is absent from the pinned run");
    const magnets = snapshot.scene.objects?.filter((object) => object?.role === "magnet") ?? [];
    assert.equal(magnets.length, 1, "P22 texture source scene does not have exactly one magnetic object");
    return studyStageTextureCatalogProof(resource, snapshot.currentRun.run_id, stageId, expectedIdentity, magnets[0].id);
  }

  async function readSnapshot(expectedSession = null, {
    requireIdle = true,
    expectedStageIds = studyStageExpectedStageIds(mode, "before"),
  } = {}) {
    const status = await apiGet(statusPath, expectedSession, false);
    readCounts.status++;
    const observedSession = readStudyStageSessionIdentity(status);
    if (expectedSession) assertSameSession(expectedSession, observedSession);
    else session = observedSession;
    if (requireIdle) {
      assert.equal(status.solver?.state, "awaiting_command", "P22 status solver is not awaiting a command");
    }
    const currentSession = await apiGet(currentSessionPath, observedSession);
    readCounts.current_session++;
    const scene = await apiGet(scenePath, observedSession);
    readCounts.scene++;
    const commands = await apiGet(commandsPath, observedSession);
    readCounts.commands++;
    const currentRun = await apiGet(currentRunPath, observedSession);
    readCounts.current_run++;
    const execution = await apiGet(executionPath, observedSession);
    readCounts.stage_execution++;
    const solverStatus = await apiGet(solverStatusPath, observedSession);
    readCounts.solver_status++;
    const statusAfter = await apiGet(statusPath, observedSession, false);
    readCounts.status++;
    const sessionAfter = readStudyStageSessionIdentity(statusAfter);
    assertSameSession(observedSession, sessionAfter);
    for (const key of [...regionRevisionKeys, "scene_revision", "mesh_revision", "domain_generation_id",
      "commands_revision", "stages_revision"]) {
      assert.equal(statusAfter.resources?.[key], status.resources?.[key], "P22 status revisions changed during a snapshot");
    }
    if (requireIdle) assert.equal(statusAfter.solver?.state, "awaiting_command");
    assert.equal(currentRun?.session_id, observedSession.session_id,
      "Current run belongs to another P22 session");
    assert(typeof currentRun.run_id === "string" && currentRun.run_id.length > 0);
    assert.equal(currentRun.status, "completed", "P22 baseline run is not terminal-completed");
    assert.equal(statusAfter.run?.run_id, currentRun.run_id,
      "Status and owning current-run resource disagree");
    if (requireIdle) assertNoInflightCommands(commands);
    assert.equal(commands.revision, statusAfter.resources.commands_revision,
      "Command queue revision differs from current status");
    assert.equal(solverStatus?.runtime_state, "awaiting_command",
      "Owning solver status is not awaiting a command");
    const profile = currentProfile(statusAfter, currentRun, currentSession, expectedSources, expectedDomainCellCount);
    const sceneStageIds = authoredSceneStageIds(scene);
    const sceneProfile = ["texture-stage-b", "texture-study"].includes(mode)
      ? studyStageTextureSceneProfile(scene, {
        allowUnedited: mode === "texture-stage-b" && textureTransactionCount === 0,
      })
      : validateStudyStageScene(scene);
    assert.equal(scene.revision, statusAfter.resources.scene_revision,
      "Committed scene revision differs from the P22 status");
    const observedStageIds = executionStageIds(execution, currentRun.run_id, observedSession);
    assert.equal(execution.runtime_state, "completed", "P22 baseline stage execution is not completed");
    assert.deepEqual(observedStageIds, sceneStageIds);
    const completedStageIds = studyStageTerminalScope(execution, sceneStageIds, expectedStageIds);
    const results = await readResults(currentRun.run_id, observedSession, expectedStageIds);
    const expectedResultIds = expectedStageIds;
    assert.deepEqual(results.map((result) => result.authored_stage_id), expectedResultIds,
      "P22 baseline durable results differ from the current stage view");
    const precondition = studyStageComputePrecondition(statusAfter, currentRun, solverStatus, commands);
    const fence = await apiGet(statusPath, observedSession, false);
    readCounts.status++;
    assertSameSession(observedSession, readStudyStageSessionIdentity(fence));
    for (const key of [...regionRevisionKeys, "scene_revision", "mesh_revision", "domain_generation_id",
      "commands_revision", "stages_revision"]) {
      assert.equal(fence.resources?.[key], statusAfter.resources?.[key], "P22 revision fence changed after reads");
    }
    return {
      session: observedSession,
      status: statusAfter,
      currentSession,
      currentRun,
      execution,
      solverStatus,
      commands,
      scene,
      sceneStageIds,
      sceneProfile,
      stageIds: completedStageIds,
      profile,
      resultIdentities: results,
      precondition,
    };
  }

  function summary(snapshot) {
    const value = {
      run_id: snapshot.currentRun.run_id,
      run_status: snapshot.currentRun.status,
      solver_state: snapshot.solverStatus.runtime_state,
      execution_state: snapshot.execution.runtime_state,
      stage_ids: snapshot.stageIds,
      authored_stage_ids: snapshot.sceneStageIds,
      stage_statuses: snapshot.execution.stage_statuses,
      completed_stage_indexes: snapshot.execution.completed_stage_indexes,
      scene_profile: snapshot.sceneProfile,
      profile: snapshot.profile,
      result_identities: snapshot.resultIdentities,
      precondition: snapshot.precondition,
    };
    if (mode === "fdm-cell-study") value.material_state = studyStageMaterialState(snapshot.scene);
    if (["texture-stage-b", "texture-study"].includes(mode)) {
      value.texture_state = studyStageTextureSceneProfile(snapshot.scene, {
        allowUnedited: mode === "texture-stage-b" && textureTransactionCount === 0,
      }).stage_b_texture_reset;
      value.texture_source_proof = textureSourceProof;
      value.texture_baseline_state = studyStageTextureBaselineState(snapshot.scene);
    }
    return value;
  }

  function assertStageRerunSceneUnchanged(snapshot, expectedSession) {
    assertSameSession(expectedSession, snapshot.session);
    assert.deepEqual(snapshot.sceneStageIds, stageIds, "Authored P22 scene changed during the run");
    assert.equal(snapshot.scene.revision, beforeSnapshot?.precondition.scene_revision,
      "P22 scene changed during stage execution");
    assert.equal(snapshot.profile.domain_generation_id, before?.profile.domain_generation_id,
      "P22 domain generation changed during stage execution");
    assert.equal(snapshot.profile.domain_cell_count, expectedDomainCellCount);
    assert.equal(snapshot.profile.domain_discretization, "fdm");
    assert.equal(snapshot.profile.requested_backend, "fdm");
    assert.equal(snapshot.profile.requested_device, "cpu");
    assert.equal(snapshot.profile.requested_precision, "double");
    assert.equal(snapshot.profile.script_sha256, expectedSources.fixture);
    if (mode === "material-stage-a") {
      const material = studyStageMaterialState(snapshot.scene);
      assert.equal(material.object_id, materialBeforeState.object_id);
      assert.equal(material.material_id, materialBeforeState.material_id);
      assert.equal(material.material_name, materialBeforeState.material_name);
      assert.equal(material.properties.Ms, 600000);
      assert.equal(material.properties.Aex, 1e-11);
      assert.equal(material.properties.alpha, materialBeforeState.properties.alpha);
      assert.equal(material.properties.Dind ?? null, materialBeforeState.properties.Dind ?? null);
      assert.equal(material.properties.Dbulk ?? null, materialBeforeState.properties.Dbulk ?? null);
      assert.equal(material.magnetization_ref, materialBeforeState.magnetization_ref);
      assert.equal(material.magnetization_asset_sha256, materialBeforeState.magnetization_asset_sha256);
    }
    if (mode === "fdm-cell-study") {
      const material = studyStageMaterialState(snapshot.scene);
      assert.equal(material.object_id, fdmMaterialBeforeState.object_id);
      assert.equal(material.material_id, fdmMaterialBeforeState.material_id);
      assert.equal(material.material_name, fdmMaterialBeforeState.material_name);
      assert.deepEqual(material.properties, fdmMaterialBeforeState.properties);
      assert.equal(material.magnetization_ref, fdmMaterialBeforeState.magnetization_ref);
      assert.equal(material.magnetization_asset_sha256, fdmMaterialBeforeState.magnetization_asset_sha256);
    }
    if (["texture-stage-b", "texture-study"].includes(mode)) {
      assert.deepEqual(studyStageTextureBaselineState(snapshot.scene), textureBaselineState,
        "The texture compute changed the accepted material, FDM grid or global +X m0");
      assert.equal(snapshot.sceneProfile.pipeline_version, "study_pipeline.v2");
      assert.deepEqual(snapshot.sceneProfile.stage_b_texture_reset,
        { stage_id: "relax-b", object_id: textureBaselineState.material.object_id, scope: "object", initializer: null });
    }
  }

  async function readAfterCommand(expectedSession) {
    const status = await apiGet(statusPath, expectedSession, false);
    readCounts.status++;
    assertSameSession(expectedSession, readStudyStageSessionIdentity(status, { requireCommandable: false }));
    for (const key of ["scene_revision", "mesh_revision", "domain_generation_id", ...regionRevisionKeys]) {
      assert.equal(status.resources?.[key], beforeSnapshot?.status.resources?.[key],
        "P22 authoring/resource precondition changed");
    }
    if (!studyStageShouldReadTerminalResources(status, executionBinding?.run_id)) return { status };
    const currentRun = await apiGet(currentRunPath, expectedSession);
    readCounts.current_run++;
    const execution = await apiGet(executionPath, expectedSession);
    readCounts.stage_execution++;
    const solverStatus = await apiGet(solverStatusPath, expectedSession);
    readCounts.solver_status++;
    const commands = await apiGet(commandsPath, expectedSession);
    readCounts.commands++;
    for (const key of ["scene_revision", "mesh_revision", "domain_generation_id", ...regionRevisionKeys]) {
      assert.equal(status.resources?.[key], beforeSnapshot?.status.resources?.[key],
        "P22 authoring/resource precondition changed");
    }
    return { status, currentRun, execution, solverStatus, commands };
  }

  function retainExecutionBinding(candidate) {
    if (candidate == null) return false;
    assert(studyStageExecutionBindingMatches(candidate, mode, candidate.run_id),
      "The P22 command execution binding has the wrong target or selected step");
    if (executionBinding && canonical(executionBinding) !== canonical(candidate)) {
      throw new Error("The P22 accepted command execution binding changed across public readbacks");
    }
    executionBinding = candidate;
    commandReceipt.execution_binding = candidate;
    return true;
  }

  async function readExecutionBinding(commandId) {
    if (executionBinding) return true;
    if (executionBindingReads >= 8) return false;
    executionBindingReads++;
    const path = commandPath + "/" + encodeURIComponent(commandId);
    record("GET", path);
    readCounts.command_details++;
    const response = await page.request.fetch(new URL(path, proxy.origin).href, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-fullmag-session-scope": sessionScope(session),
      },
      timeout: Math.min(10_000, timerBudget()),
    });
    if (response.status() === 404) return false;
    assert(response.ok(), "P22 command detail read was not acknowledged");
    const raw = await response.body();
    assert(raw.length <= 64 * 1024, "P22 command detail exceeded its size bound");
    const detail = JSON.parse(raw.toString("utf8"));
    assert(plainRecord(detail) && detail.command_id === commandId,
      "P22 command detail belongs to another command");
    return retainExecutionBinding(detail.execution_binding);
  }

  async function writeResult(result) {
    const encoded = JSON.stringify(result);
    assert(Buffer.byteLength(encoded, "utf8") <= MAX_RESULT_BYTES, "Study stage rerun result exceeded its bound");
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(reportDir + "/result.json", encoded);
    process.stdout.write(encoded + "\n");
  }

  try {
    proxy = await startBrowserQaLoopbackProxy(publicUrl, upstreamUrl);
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-angle=swiftshader-webgl"],
    });
    context = await browser.newContext({ viewport: { width: 1440, height: 780 }, serviceWorkers: "block" });
    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => { if (errors.length < 16) errors.push(boundedMessage(error)); });
    page.on("console", (message) => {
      if (message.type() === "error" && errors.length < 16) errors.push(boundedMessage(message.text()));
    });

    const initial = await readSnapshot(null, { requireIdle: true });
    if (mode === "material-stage-a") {
      materialBeforeState = studyStageMaterialState(initial.scene);
      assert.equal(materialBeforeState.properties.Ms, 800000, "P22 fixture Ms baseline differs");
      assert.equal(materialBeforeState.properties.Aex, 13e-12, "P22 fixture Aex baseline differs");
      assert.equal(materialBeforeState.properties.alpha, 0.5, "P22 fixture alpha baseline differs");
      assert.equal(materialBeforeState.properties.Dind ?? null, null, "P22 fixture Dind baseline differs");
      assert.equal(materialBeforeState.properties.Dbulk ?? null, null, "P22 fixture Dbulk baseline differs");
      materialSourceScene = structuredClone(initial.scene);
    }
    if (mode === "fdm-cell-study") {
      fdmMaterialBeforeState = studyStageMaterialState(initial.scene);
      assert.equal(fdmMaterialBeforeState.properties.Ms, 600000,
        "P22 FDM-cell profile requires the accepted material Ms");
      assert.equal(fdmMaterialBeforeState.properties.Aex, 1e-11,
        "P22 FDM-cell profile requires the accepted material Aex");
      assert.equal(fdmMaterialBeforeState.properties.alpha, 0.5, "P22 FDM-cell profile alpha baseline differs");
      assert.equal(fdmMaterialBeforeState.properties.Dind ?? null, null, "P22 FDM-cell profile Dind baseline differs");
      assert.equal(fdmMaterialBeforeState.properties.Dbulk ?? null, null, "P22 FDM-cell profile Dbulk baseline differs");
      fdmCellBeforeState = studyStageFdmCellState(initial.scene);
      fdmCellSourceScene = structuredClone(initial.scene);
      assert.equal(initial.profile.domain_cell_count, 8, "P22 FDM-cell profile must start at eight cells");
    }
    if (["texture-stage-b", "texture-study"].includes(mode)) {
      assert.equal(initial.profile.domain_cell_count, 16, "P22 texture profile requires the qualified sixteen-cell FDM domain");
      if (mode === "texture-stage-b") {
        assert.equal(initial.scene.study.study_pipeline.version, "study_pipeline.v1",
          "Texture-stage-B must start before its one UI-authored texture transaction");
      } else {
        assert.equal(initial.scene.study.study_pipeline.version, "study_pipeline.v2",
          "Texture-study requires the previously acknowledged B-local recipe");
      }
      textureSourceScene = structuredClone(initial.scene);
      textureBaselineState = studyStageTextureBaselineState(initial.scene);
      textureSourceProof = await readTextureSourceProof(initial);
    }
    session = initial.session;
    assert.deepEqual(stableProjection(initial), stableProjection(await readSnapshot(session, { requireIdle: true })),
      "P22 public resources changed between initial bounded snapshots");
    beforeSnapshot = initial;
    before = summary(initial);
    expectedPrecondition = initial.precondition;

    await page.route("**/v2/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const path = url.pathname + url.search;
      try {
        record(method, path);
        if (method === "GET") return route.continue();
        const scope = request.headers()["x-fullmag-session-scope"];
        if (method === "PATCH" && url.pathname === "/v2/sessions/current/visualization/state" && session) {
          const body = request.postDataJSON();
          if (!studyStageCameraPatchAllowed({ method, path, scope, body }, session)
              || cameraPatchReceipts.length >= 4) {
            if (violations.length < 16) violations.push("Rejected an invalid or over-budget camera autosave: "
              + Object.keys(body ?? {}).slice(0, 16).join(","));
            return route.abort();
          }
          cameraPatchReceipts.push({ method, path, scope_header: scope, payload: body });
          return route.continue();
        }
        if (method !== "POST" || !session) {
          if (violations.length < 16) violations.push("Unexpected non-GET API request: " + method + " " + url.pathname);
          return route.abort();
        }
        if (url.pathname === clientAckPath) {
          const body = request.postDataJSON();
          if (!studyStageRerunClientAckAllowed({ method, path, scope, body }, session)
              || ++clientAckCount > MAX_CLIENT_ACKS) {
            if (violations.length < 16) violations.push("Invalid or over-budget visualization client acknowledgement");
            return route.abort();
          }
          return route.continue();
        }
        if (url.pathname === modelTransactionsPath) {
          if (!["fdm-cell-study", "texture-stage-b"].includes(mode)) materialAttemptCount++;
          const body = request.postDataJSON();
          if (mode === "texture-stage-b") {
            textureTransactionAttemptCount++;
            const revision = textureSourceScene?.revision ?? textureSourceScene?.scene_revision;
            const expected = buildStageBUniformXResetTransaction({
              scene: textureSourceScene,
              sceneRevision: revision,
              statusSceneRevision: textureSourceScene?.revision ?? textureSourceScene?.scene_revision,
              objectId: textureSourceProof?.object_id,
            });
            if (phase !== "texture-save-submit" || textureTransactionCount !== 0
                || request.method() !== "POST" || path !== modelTransactionsPath
                || scope !== sessionScope(session) || canonical(body) !== canonical(expected)) {
              if (violations.length < 16) violations.push("Rejected an extra or out-of-scope B texture transaction");
              return route.abort();
            }
            textureTransactionCount++;
            uiTextureProven = true;
            outcome = "unknown";
            phase = "texture-save-dispatched";
            textureReceipt = {
              method, path: url.pathname, scope_header: scope, status: null, payload: body,
              scene_before: textureSourceScene, acknowledgement: null, helper_ack: null,
              ui_saved_ack_proven: false, ui_saved_ack_text: null,
            };
            const response = await route.fetch();
            const raw = await response.body();
            assert(raw.length <= MAX_API_BYTES, "P22 texture transaction acknowledgement exceeded its bound");
            const acknowledgement = JSON.parse(raw.toString("utf8"));
            textureReceipt.status = response.status();
            textureReceipt.acknowledgement = acknowledgement;
            const write = { method: request.method(), path: url.pathname, headers: request.headers(), body };
            const helperAck = validateStageBUniformXResetExchange({
              scene: textureSourceScene,
              sceneRevision: revision,
              statusSceneRevision: revision,
              objectId: textureSourceProof.object_id,
              sessionScopeKey: sessionScope(session),
              writes: [write],
              acknowledgement: { status: response.status(), body: acknowledgement },
            });
            textureReceipt.helper_ack = helperAck;
            phase = "texture-save-acknowledged";
            return route.fulfill({ response });
          }
          if (mode === "material-stage-a") {
            const allowed = studyStageMaterialRequestAllowed({ method, path, scope, body },
              { phase, materialCount, session,
                beforeRevision: materialSourceScene?.revision ?? materialSourceScene?.scene_revision,
                before: materialBeforeState });
            if (!allowed || materialCount !== 0) {
              if (violations.length < 16) violations.push("Rejected a duplicate or out-of-scope material transaction");
              return route.abort();
            }
            materialRequest = request;
            materialReceipt = { method, path: url.pathname, status: null, scope_header: scope,
              payload: body, before_scene_revision: materialSourceScene.revision ?? materialSourceScene.scene_revision,
              material_before: materialBeforeState, acknowledged: false };
            materialCount++;
            uiMaterialProven = true;
            outcome = "unknown";
            phase = "material-dispatched";
            return route.continue();
          }
          if (mode === "fdm-cell-study") {
            fdmCellAttemptCount++;
            const allowed = studyStageFdmCellRequestAllowed({ method, path, scope, body },
              { phase, transactionCount: fdmCellCount, session,
                beforeRevision: fdmCellSourceScene?.revision ?? fdmCellSourceScene?.scene_revision,
                beforeScene: fdmCellSourceScene });
            if (!allowed || fdmCellCount !== 0) {
              if (violations.length < 16) violations.push("Rejected a duplicate or out-of-scope FDM cell transaction");
              return route.abort();
            }
            fdmCellRequest = request;
            fdmCellReceipt = { method, path: url.pathname, status: null, scope_header: scope,
              payload: body, before_scene_revision: fdmCellSourceScene.revision ?? fdmCellSourceScene.scene_revision,
              before_cell: fdmCellBeforeState.cell, acknowledged: false };
            fdmCellCount++;
            uiFdmCellProven = true;
            outcome = "unknown";
            phase = "fdm-cell-dispatched";
            const response = await route.fetch();
            const raw = await response.body();
            assert(raw.length <= 512 * 1024, "P22 FDM cell transaction response exceeded its bound");
            fdmCellReceipt.status = response.status();
            const result = studyStageFdmCellTransactionOutcome(response.status(),
              JSON.parse(raw.toString("utf8")), fdmCellSourceScene);
            if (result.outcome === "accepted") {
              fdmCellReceipt.transaction_kind = "merge_patch";
              fdmCellReceipt.scene_revision = result.scene_revision;
              fdmCellReceipt.after_cell = result.after_cell;
              fdmCellReceipt.acknowledged = true;
              fdmCellReceipt.unmodified_scene_sha256_before = createHash("sha256")
                .update(canonical(sceneWithoutFdmDefaultCell(fdmCellSourceScene))).digest("hex");
              fdmCellReceipt.unmodified_scene_sha256_after = createHash("sha256")
                .update(canonical(sceneWithoutFdmDefaultCell(JSON.parse(raw.toString("utf8")).committed_scene))).digest("hex");
              phase = "fdm-grid-submit";
            } else {
              phase = "fdm-cell-unknown";
            }
            return route.fulfill({ response });
          }
          if (violations.length < 16) violations.push("Rejected an unexpected model transaction");
          return route.abort();
        }
        if (url.pathname === commandPath) {
          const body = request.postDataJSON();
          if (mode === "fdm-cell-study" && body?.kind === "fdm_grid_refresh") {
            gridRefreshAttemptCount++;
            const allowed = studyStageFdmGridRefreshRequestAllowed({ method, path, scope, body }, {
              phase, refreshCount: gridRefreshCount, session,
              sceneRevision: fdmCellReceipt?.scene_revision,
              existingIntentIds: new Set(beforeClick?.commands?.commands
                ?.map((item) => item?.client_intent_id).filter((value) => typeof value === "string") ?? []),
            });
            if (!allowed || gridRefreshCount !== 0) {
              if (violations.length < 16) violations.push("Rejected a duplicate or unscoped automatic FDM grid refresh");
              return route.abort();
            }
            gridRefreshReceipt = { method, path: url.pathname, status: null, scope_header: scope,
              payload: body, accepted: false, terminal_detail: null };
            gridRefreshRequest = request;
            gridRefreshCount++;
            uiGridRefreshProven = true;
            outcome = "unknown";
            phase = "fdm-grid-dispatched";
            const response = await route.fetch();
            const raw = await response.body();
            assert(raw.length <= 64 * 1024, "P22 FDM grid refresh response exceeded its bound");
            gridRefreshReceipt.status = response.status();
            const accepted = studyStageCommandResponseOutcome(response.status(), JSON.parse(raw.toString("utf8")));
            if (accepted.outcome === "accepted") {
              gridRefreshReceipt.accepted = true;
              gridRefreshReceipt.command_id = accepted.command_id;
              phase = "fdm-grid-observing";
            } else {
              phase = "fdm-grid-unknown";
            }
            return route.fulfill({ response });
          }
          commandAttemptCount++;
          const allowed = studyStageRerunRequestAllowed(
            { method, path, scope, body },
            { mode, session, expectedPrecondition, commandCount, phase,
              idempotencyKey: request.headers()["idempotency-key"] },
          );
          if (!allowed || commandCount !== 0) {
            if (violations.length < 16) violations.push("Rejected a duplicate or out-of-scope Study command");
            return route.abort();
          }
          commandRequest = request;
          commandReceipt = { method, path: url.pathname, status: null, scope_header: scope,
            idempotency_key: request.headers()["idempotency-key"] ?? null, payload: body };
          commandCount++;
          uiCommandProven = true;
          outcome = "unknown";
          phase = "command-dispatched";
          return route.continue();
        }
        if (violations.length < 16) violations.push("Rejected unexpected API mutation: " + method + " " + url.pathname);
        return route.abort();
      } catch (error) {
        if (violations.length < 16) violations.push(boundedMessage(error));
        return route.abort().catch(() => undefined);
      }
    });

    await page.goto(new URL("/workspace", proxy.origin).href, {
      waitUntil: "domcontentloaded", timeout: Math.min(90_000, timerBudget()),
    });
    const beforeClick = await readSnapshot(session, { requireIdle: true });
    assert.deepEqual(stableProjection(beforeClick), stableProjection(initial),
      "P22 current run, stage view or history changed before the UI action");
    beforeSnapshot = beforeClick;
    before = summary(beforeClick);
    expectedPrecondition = beforeClick.precondition;

    if (mode === "material-stage-a") {
      const expandParent = async (parentId) => {
        const parent = page.locator('[role="treeitem"][data-node-id="' + parentId + '"]');
        await parent.waitFor({ state: "visible", timeout: Math.min(30_000, timerBudget()) });
        await parent.focus();
        if (await parent.getAttribute("aria-expanded") !== "true") await parent.press("ArrowRight");
      };
      const ownerId = materialBeforeState.object_id;
      const materialNodeId = "model:object:" + ownerId + ":magnetic-parameters:material";
      await expandParent("model:objects");
      await expandParent("model:object:" + ownerId);
      await expandParent("model:object:" + ownerId + ":magnetic-parameters");
      const materialRow = page.locator('[role="treeitem"][data-node-id="' + materialNodeId + '"]');
      await materialRow.waitFor({ state: "visible", timeout: Math.min(30_000, timerBudget()) });
      assert.equal(await materialRow.count(), 1, "The task-owned material Explorer row is absent or duplicated");
      await materialRow.click();

      const nameField = page.locator('input[aria-label="Name"]');
      const msField = page.locator('input[aria-label="Ms"]');
      const aexField = page.locator('input[aria-label="Aex"]');
      const alphaField = page.locator('input[aria-label="alpha"]');
      const dindField = page.locator('input[aria-label="Dind"]');
      const dbulkField = page.locator('input[aria-label="Dbulk"]');
      await msField.waitFor({ state: "visible", timeout: Math.min(15_000, timerBudget()) });
      await page.waitForFunction(() => {
        const input = document.querySelector('input[aria-label="Ms"]');
        return input && !input.disabled && input.value !== "";
      }, null, { timeout: Math.min(15_000, timerBudget()) });
      const unchangedFields = {
        name: await nameField.inputValue(),
        alpha: await alphaField.inputValue(),
        dind: await dindField.inputValue(),
        dbulk: await dbulkField.inputValue(),
      };
      assert.equal(unchangedFields.name, materialBeforeState.material_name);
      assert.equal(Number(await msField.inputValue()), 800000);
      assert.equal(Number(await aexField.inputValue()), 13e-12);
      assert.equal(Number(unchangedFields.alpha), 0.5);
      await msField.fill("600000");
      await aexField.fill("1e-11");
      assert.equal(await nameField.inputValue(), unchangedFields.name);
      assert.equal(await alphaField.inputValue(), unchangedFields.alpha);
      assert.equal(await dindField.inputValue(), unchangedFields.dind);
      assert.equal(await dbulkField.inputValue(), unchangedFields.dbulk);
      const applyParameters = page.getByRole("button", { name: "Apply Parameters", exact: true });
      await applyParameters.waitFor({ state: "visible", timeout: Math.min(15_000, timerBudget()) });
      assert.equal(await applyParameters.isEnabled(), true, "Material Parameters Apply is disabled in the real UI");
      const materialResponseWait = page.waitForResponse((response) => {
        const request = response.request();
        const url = new URL(request.url());
        return request.method() === "POST" && url.pathname === modelTransactionsPath
          && request.headers()["x-fullmag-session-scope"] === sessionScope(session);
      }, { timeout: Math.min(20_000, timerBudget()) }).catch((error) => {
        throw new Error("P22 material transaction response was not observed: " + boundedMessage(error));
      });
      phase = "material-submit";
      await applyParameters.click();
      const materialResponse = await deadline(materialResponseWait, Math.min(20_000, timerBudget()),
        "P22 material transaction response timed out; authoring outcome is unknown");
      if (!materialRequest || materialCount !== 1 || !uiMaterialProven) {
        throw new Error("The real Material Parameters UI did not submit exactly one guarded transaction");
      }
      assert.equal(materialResponse.request(), materialRequest,
        "The observed response was not for the exact guarded material transaction");
      materialReceipt.status = materialResponse.status();
      const materialBody = await materialResponse.body();
      assert(materialBody.length <= 256 * 1024, "P22 material transaction response exceeded its bound");
      const materialAck = JSON.parse(materialBody.toString("utf8"));
      const materialAcceptance = studyStageMaterialTransactionOutcome(
        materialResponse.status(), materialAck, materialSourceScene,
      );
      if (materialAcceptance.outcome !== "accepted") {
        outcome = "unknown";
        throw new Error("The P22 material transaction ACK did not prove the exact committed edit");
      }
      materialReceipt.transaction_kind = materialAck.transaction_kind;
      materialReceipt.scene_revision = materialAcceptance.scene_revision;
      materialReceipt.acknowledged = true;
      materialReceipt.material_after = materialAcceptance.material;
      materialReceipt.unmodified_scene_sha256_before = studyStageUnmodifiedSceneSha256(
        materialSourceScene, materialBeforeState.material_id,
      );
      materialReceipt.unmodified_scene_sha256_after = studyStageUnmodifiedSceneSha256(
        materialAck.committed_scene, materialBeforeState.material_id,
      );
      assert.equal(materialReceipt.unmodified_scene_sha256_after, materialReceipt.unmodified_scene_sha256_before,
        "Material ACK changed authored scene state outside the selected asset");
      phase = "material-acknowledged";

      const postMaterial = await readSnapshot(session, { requireIdle: true });
      assert.equal(postMaterial.currentRun.run_id, beforeClick.currentRun.run_id,
        "Material authoring unexpectedly changed the completed pre-command run");
      assert.equal(postMaterial.scene.revision ?? postMaterial.scene.scene_revision, materialReceipt.scene_revision,
        "Fresh P22 scene revision differs from the material ACK");
      assert(studyStageMaterialSceneMatches(materialSourceScene, postMaterial.scene),
        "Fresh P22 scene differs from the exact material ACK or changed authored m0");
      assert.deepEqual(postMaterial.resultIdentities, beforeClick.resultIdentities,
        "Material authoring changed immutable prior Study result identities");
      assert.deepEqual(postMaterial.stageIds, beforeClick.stageIds,
        "Material authoring changed the prior completed stage scope");
      beforeSnapshot = postMaterial;
      before = summary(postMaterial);
      expectedPrecondition = postMaterial.precondition;
    }

    if (mode === "texture-stage-b") {
      const expandParent = async (parentId) => {
        const parent = page.locator('[role="treeitem"][data-node-id="' + parentId + '"]');
        await parent.waitFor({ state: "visible", timeout: Math.min(30_000, timerBudget()) });
        await parent.focus();
        if (await parent.getAttribute("aria-expanded") !== "true") await parent.press("ArrowRight");
      };
      await expandParent("model:study");
      await expandParent("model:study:stages");
      await fillStageBUniformXResetInInspector(page, { objectId: textureSourceProof.object_id });
      phase = "texture-save-submit";
      const saveAck = await saveStageBResetAndWaitForAck(page, { timeout: Math.min(30_000, timerBudget()) });
      if (!textureReceipt || textureTransactionCount !== 1 || textureTransactionAttemptCount !== 1
          || !uiTextureProven || saveAck.status !== textureReceipt.status
          || canonical(saveAck.body) !== canonical(textureReceipt.acknowledgement)) {
        throw new Error("The real Stage B Inspector did not prove one exact saved reset transaction and ACK");
      }
      textureReceipt.ui_saved_ack_proven = true;
      textureReceipt.ui_saved_ack_text = "Saved stage relax-b.";
      const postTexture = await readSnapshot(session, { requireIdle: true, expectedStageIds: stageIds });
      assert.equal(postTexture.currentRun.run_id, beforeClick.currentRun.run_id,
        "Saving the Stage B recipe unexpectedly replaced the completed ABC run");
      assert.equal(postTexture.scene.revision ?? postTexture.scene.scene_revision,
        textureReceipt.helper_ack.sceneRevision, "Fresh scene revision differs from the exact Stage B save ACK");
      assert.deepEqual(postTexture.resultIdentities, beforeClick.resultIdentities,
        "Saving the Stage B recipe changed an immutable prior result identity");
      assert.deepEqual(postTexture.stageIds, stageIds, "Saving Stage B changed the prior completed ABC scope");
      assert.deepEqual(studyStageTextureBaselineState(postTexture.scene), textureBaselineState,
        "Saving Stage B changed the accepted material, FDM cell geometry or global uniform +X m0");
      const freshAProof = await readTextureSourceProof(postTexture);
      assert.deepEqual(freshAProof, textureSourceProof,
        "The accepted same-domain A source changed while saving the Stage B recipe");
      beforeSnapshot = postTexture;
      before = summary(postTexture);
      expectedPrecondition = postTexture.precondition;
      textureSourceScene = structuredClone(postTexture.scene);
      await selectStageBAuthoredInitialState(page);
      assert.equal(await page.getByLabel("Initial magnetization", { exact: true }).inputValue(), "authored_stage",
        "The Stage B Inspector did not select its saved authored reset input");
      phase = "texture-ready";
    }

    if (mode === "fdm-cell-study") {
      const studyRow = page.locator('[role="treeitem"][data-node-id="model:study"]');
      await studyRow.waitFor({ state: "visible", timeout: Math.min(30_000, timerBudget()) });
      assert.equal(await studyRow.count(), 1, "The task-owned Study Explorer row is absent or duplicated");
      await studyRow.click();
      const cellField = page.locator('input[aria-label="FDM default cell"]');
      await cellField.waitFor({ state: "visible", timeout: Math.min(15_000, timerBudget()) });
      const parseCell = (value) => value.split(",").map((item) => Number(item.trim()));
      assert.deepEqual(parseCell(await cellField.inputValue()), fdmCellBeforeState.cell,
        "Study Inspector FDM default-cell field differs from the committed scene");
      await cellField.fill("1e-9, 2e-9, 2e-9");
      assert.deepEqual(parseCell(await cellField.inputValue()), targetFdmCell,
        "Study Inspector did not retain the exact requested FDM default cell");
      const applyGrid = page.getByRole("button", { name: "Apply Grid", exact: true });
      await applyGrid.waitFor({ state: "visible", timeout: Math.min(15_000, timerBudget()) });
      assert.equal(await applyGrid.isEnabled(), true, "The exact FDM grid edit is not commandable");
      const globalResponseWait = studyStageObserveResponse(page.waitForResponse((response) => {
        const request = response.request();
        const url = new URL(request.url());
        return request.method() === "POST" && url.pathname === modelTransactionsPath
          && request.headers()["x-fullmag-session-scope"] === sessionScope(session);
      }, { timeout: Math.min(20_000, timerBudget()) }),
      "P22 FDM cell merge-patch response was not observed: ");
      const gridResponseWait = studyStageObserveResponse(page.waitForResponse((response) => {
        const request = response.request();
        const url = new URL(request.url());
        if (request.method() !== "POST" || url.pathname !== commandPath
            || request.headers()["x-fullmag-session-scope"] !== sessionScope(session)) return false;
        try { return request.postDataJSON()?.kind === "fdm_grid_refresh"; }
        catch { return false; }
      }, { timeout: Math.min(45_000, timerBudget()) }),
      "P22 automatic FDM grid refresh response was not observed: ");
      phase = "fdm-cell-submit";
      await applyGrid.click();
      const globalObservation = await deadline(globalResponseWait, Math.min(20_000, timerBudget()),
        "P22 FDM cell merge-patch response timed out; authoring outcome is unknown");
      assert(globalObservation.response, globalObservation.error);
      const globalResponse = globalObservation.response;
      if (!fdmCellRequest || fdmCellCount !== 1 || fdmCellAttemptCount !== 1 || !uiFdmCellProven) {
        throw new Error("The real Study Inspector did not submit exactly one guarded FDM cell merge-patch");
      }
      assert.equal(globalResponse.request(), fdmCellRequest,
        "The observed response was not for the exact guarded FDM cell transaction");
      const globalBody = await globalResponse.body();
      assert(globalBody.length <= 512 * 1024, "P22 FDM cell transaction ACK exceeded its bound");
      const globalAck = JSON.parse(globalBody.toString("utf8"));
      assert.equal(studyStageFdmCellTransactionOutcome(globalResponse.status(), globalAck,
        fdmCellSourceScene).outcome, "accepted", "The FDM cell ACK did not prove the exact grid-only scene edit");
      assert.equal(fdmCellReceipt.acknowledged, true, "The FDM cell ACK was not accepted by the write guard");
      assert(["fdm-grid-submit", "fdm-grid-dispatched", "fdm-grid-observing"].includes(phase),
        "Study did not arm its one automatic grid refresh after the ACK");

      const gridObservation = await deadline(gridResponseWait, Math.min(45_000, timerBudget()),
        "P22 automatic FDM grid refresh response timed out; outcome is unknown");
      assert(gridObservation.response, gridObservation.error);
      const gridResponse = gridObservation.response;
      if (!gridRefreshRequest || gridRefreshCount !== 1 || gridRefreshAttemptCount !== 1 || !uiGridRefreshProven) {
        throw new Error("The Study Inspector did not submit exactly one guarded automatic FDM grid refresh");
      }
      assert.equal(gridResponse.request(), gridRefreshRequest,
        "The observed response was not for the exact automatic FDM grid refresh");
      assert.equal(gridRefreshReceipt.accepted, true, "The FDM grid refresh ACK was not accepted");
      assert.equal(gridRefreshReceipt.payload.reason, "study_global_commit");

      const detailPath = commandPath + "/" + encodeURIComponent(gridRefreshReceipt.command_id);
      const detailDeadline = Date.now() + Math.min(90_000, Math.max(1, timerBudget() - 8_000));
      while (Date.now() < detailDeadline) {
        record("GET", detailPath);
        readCounts.command_details++;
        const response = await page.request.fetch(new URL(detailPath, proxy.origin).href, {
          method: "GET", headers: { accept: "application/json", "x-fullmag-session-scope": sessionScope(session) },
          timeout: Math.min(10_000, timerBudget()),
        });
        if (response.status() === 404) {
          await delay(Math.min(1_000, Math.max(0, detailDeadline - Date.now())));
          continue;
        }
        assert(response.ok(), "P22 FDM grid refresh detail read failed");
        const raw = await response.body();
        assert(raw.length <= 64 * 1024, "P22 FDM grid refresh detail exceeded its bound");
        const detail = JSON.parse(raw.toString("utf8"));
        assert.equal(detail.command_id, gridRefreshReceipt.command_id);
        assert.equal(detail.kind, "fdm_grid_refresh");
        assert.equal(detail.client_intent_id, gridRefreshReceipt.payload.client_intent_id);
        assert.equal(detail.reason, "study_global_commit");
        if (detail.status === "completed" && detail.completion_status === "completed") {
          assert(Number.isSafeInteger(detail.seq) && detail.seq >= 0,
            "Completed FDM grid refresh omitted its terminal sequence");
          gridRefreshTerminalDetail = {
            command_id: detail.command_id, kind: detail.kind, status: detail.status,
            completion_status: detail.completion_status, client_intent_id: detail.client_intent_id,
            reason: detail.reason, seq: detail.seq,
          };
          break;
        }
        if (["failed", "cancelled", "rejected"].includes(detail.status)
            || ["failed", "cancelled", "rejected"].includes(detail.completion_status)) {
          throw new Error("The automatic FDM grid refresh reached a failed terminal state");
        }
        await delay(Math.min(500, Math.max(0, detailDeadline - Date.now())));
      }
      assert(gridRefreshTerminalDetail, "The automatic FDM grid refresh did not reach a bounded completed terminal state");
      gridRefreshReceipt.terminal_detail = gridRefreshTerminalDetail;
      const completionMessage = page.getByText(
        "Committed global study settings. FDM grid replan completed; magnetization was reinitialized from the model.",
        { exact: true },
      );
      await completionMessage.waitFor({ state: "visible", timeout: Math.min(20_000, timerBudget()) });

      const readyDeadline = Date.now() + Math.min(60_000, Math.max(1, timerBudget() - 8_000));
      let readyStatus = null;
      let readyScene = null;
      while (Date.now() < readyDeadline) {
        readyStatus = await apiGet(statusPath, session, false);
        readCounts.status++;
        assertSameSession(session, readStudyStageSessionIdentity(readyStatus, { requireCommandable: false }));
        readyScene = await apiGet(scenePath, session);
        readCounts.scene++;
        if (readyStatus.domain?.cell_count === 16
            && typeof readyStatus.domain?.generation_id === "string"
            && readyStatus.domain.generation_id !== beforeClick.profile.domain_generation_id
            && readyStatus.resources?.domain_generation_id === readyStatus.domain.generation_id
            && readyStatus.resources?.scene_revision === fdmCellReceipt.scene_revision
            && (readyScene.revision ?? readyScene.scene_revision) === fdmCellReceipt.scene_revision
            && readyStatus.solver?.state === "awaiting_command") break;
        await delay(Math.min(1_000, Math.max(0, readyDeadline - Date.now())));
      }
      assert(readyStatus?.domain?.cell_count === 16
        && readyStatus.domain.generation_id !== beforeClick.profile.domain_generation_id
        && readyScene && studyStageFdmCellSceneMatches(fdmCellSourceScene, readyScene),
      "The new sixteen-cell FDM domain did not become ready from the exact acknowledged grid policy");
      expectedDomainCellCount = 16;
      const postGrid = await readSnapshot(session, { requireIdle: true, expectedStageIds: ["relax-a"] });
      assert.equal(postGrid.currentRun.run_id, beforeClick.currentRun.run_id,
        "The automatic grid refresh replaced the previous A-only run before Compute Study");
      assert.deepEqual(postGrid.resultIdentities, beforeClick.resultIdentities,
        "The automatic grid refresh changed the prior A-only immutable result identity");
      assert.deepEqual(postGrid.stageIds, ["relax-a"], "The automatic grid refresh changed the completed A-only stage scope");
      const materialAfterGrid = studyStageMaterialState(postGrid.scene);
      assert.equal(materialAfterGrid.magnetization_asset_sha256, fdmMaterialBeforeState.magnetization_asset_sha256,
        "The FDM grid refresh changed the authored m0 asset");
      assert.deepEqual(materialAfterGrid.properties, fdmMaterialBeforeState.properties,
        "The FDM grid refresh changed the accepted material properties");
      gridRefreshReceipt.domain_transition = {
        before_domain_cell_count: beforeClick.profile.domain_cell_count,
        before_domain_generation_id: beforeClick.profile.domain_generation_id,
        ready_domain_cell_count: postGrid.profile.domain_cell_count,
        ready_domain_generation_id: postGrid.profile.domain_generation_id,
        scene_revision: postGrid.scene.revision ?? postGrid.scene.scene_revision,
        preserved_run_id: postGrid.currentRun.run_id,
        preserved_result_identities: postGrid.resultIdentities,
      };
      beforeSnapshot = postGrid;
      before = summary(postGrid);
      expectedPrecondition = postGrid.precondition;
      phase = "fdm-grid-ready";
    }

    let action;
    if (mode === "material-stage-a") {
      const expandParent = async (parentId) => {
        const parent = page.locator('[role="treeitem"][data-node-id="' + parentId + '"]');
        await parent.waitFor({ state: "visible", timeout: Math.min(30_000, timerBudget()) });
        await parent.focus();
        if (await parent.getAttribute("aria-expanded") !== "true") await parent.press("ArrowRight");
      };
      await expandParent("model:study");
      await expandParent("model:study:stages");
      const selectedStage = beforeClick.execution.stages.find((stage) => stage?.stage_id === "relax-a");
      assert(selectedStage, "The fresh completed stage execution omitted the exact Stage A target");
      const row = page.locator('[role="treeitem"][data-node-id="model:study:stages:stage:relax-a"]');
      await row.waitFor({ state: "visible", timeout: Math.min(30_000, timerBudget()) });
      assert.equal(await row.count(), 1, "The authored relax-a Explorer row is absent or duplicated");
      await row.click({ button: "right" });
      action = page.getByRole("menuitem", { name: "Run This Stage", exact: true });
    } else if (mode === "stage-b") {
      const expandParent = async (parentId) => {
        const parent = page.locator('[role="treeitem"][data-node-id="' + parentId + '"]');
        await parent.waitFor({ state: "visible", timeout: Math.min(30_000, timerBudget()) });
        await parent.focus();
        if (await parent.getAttribute("aria-expanded") !== "true") await parent.press("ArrowRight");
      };
      await expandParent("model:study");
      await expandParent("model:study:stages");
      const selectedStage = beforeClick.execution.stages.find((stage) => stage?.stage_id === "relax-b");
      assert(selectedStage, "The fresh completed stage execution omitted the exact Stage B target");
      const row = page.locator('[role="treeitem"][data-node-id="model:study:stages:stage:'
        + selectedStage.stage_id + '"]');
      assert.equal(await row.count(), 1, "The authored relax-b Explorer row is absent or duplicated");
      await row.click({ button: "right" });
      action = page.getByRole("menuitem", { name: "Run This Stage", exact: true });
    } else if (mode === "texture-stage-b") {
      const row = page.locator('[role="treeitem"][data-node-id="model:study:stages:stage:relax-b"]');
      await row.waitFor({ state: "visible", timeout: Math.min(30_000, timerBudget()) });
      assert.equal(await row.count(), 1, "The texture-stage-B Inspector row is absent or duplicated");
      await row.click();
      await selectStageBAuthoredInitialState(page);
      assert.equal(await page.getByLabel("Initial magnetization", { exact: true }).inputValue(), "authored_stage",
        "The real Stage B Inspector does not show the authored-stage initial state");
      action = page.getByRole("button", { name: "Run this stage", exact: true });
    } else {
      const row = page.locator('[role="treeitem"][data-node-id="model:study"]');
      await row.waitFor({ state: "visible", timeout: Math.min(30_000, timerBudget()) });
      assert.equal(await row.count(), 1, "The Study Explorer row is absent or duplicated");
      await row.click({ button: "right" });
      action = page.getByRole("menuitem", { name: "Compute Study", exact: true });
    }
    await action.waitFor({ state: "visible", timeout: Math.min(15_000, timerBudget()) });
    assert.equal(await action.isEnabled(), true, "The pinned P22 command is disabled in the real UI");
    const responseWait = page.waitForResponse(
      (response) => {
        const request = response.request();
        const url = new URL(request.url());
        return request.method() === "POST" && url.pathname === commandPath
          && request.headers()["x-fullmag-session-scope"] === sessionScope(session);
      },
      { timeout: Math.min(20_000, timerBudget()) },
    ).catch((error) => { throw new Error("P22 command response was not observed: " + boundedMessage(error)); });
    phase = "ui-submit";
    if (mode === "texture-stage-b") await clickRunStageBOnce(page);
    else await action.click();
    const commandResponse = await deadline(responseWait, Math.min(20_000, timerBudget()),
      "P22 command response timed out; native outcome is unknown");
    if (!commandRequest || commandCount !== 1 || !uiCommandProven) {
      throw new Error("The real UI did not submit exactly one guarded command");
    }
    assert.equal(commandResponse.request(), commandRequest,
      "The observed response was not for the exact guarded menu command");
    commandReceipt.status = commandResponse.status();
    const commandBody = await commandResponse.body();
    assert(commandBody.length <= 64 * 1024, "P22 command response exceeded its bound");
    const accepted = JSON.parse(commandBody.toString("utf8"));
    const acceptance = studyStageCommandResponseOutcome(commandResponse.status(), accepted);
    if (acceptance.outcome !== "accepted") {
      outcome = "unknown";
      throw new Error("The P22 command response did not establish durable acceptance; outcome is unknown");
    }
    commandReceipt.command_id = acceptance.command_id;
    if (accepted.execution_binding != null) {
      executionBinding = accepted.execution_binding;
      assert(studyStageExecutionBindingMatches(executionBinding, mode, executionBinding.run_id),
        "The accepted P22 command response has a mismatched execution binding");
      commandReceipt.execution_binding = executionBinding;
    }
    phase = "await-terminal";

    const expectedAfterIds = studyStageExpectedStageIds(mode, "after");
    const pollDeadline = Date.now() + Math.max(1, timerBudget() - 8_000);
    let terminal = null;
    while (Date.now() < pollDeadline) {
      if (!executionBinding) {
        await readExecutionBinding(accepted.command_id);
        if (!executionBinding) {
          await delay(Math.min(5_000, Math.max(0, pollDeadline - Date.now())));
          continue;
        }
      }
      const current = await readAfterCommand(session);
      if (!current.currentRun) {
        await delay(Math.min(1_000, Math.max(0, pollDeadline - Date.now())));
        continue;
      }
      const currentRunId = current.currentRun?.run_id;
      const commandState = current.commands?.commands?.find((entry) => entry.command_id === accepted.command_id);
      if (commandState?.execution_binding) retainExecutionBinding(commandState.execution_binding);
      if (currentRunId === executionBinding.run_id && currentRunId !== before.run_id
          && current.status.run?.run_id === currentRunId
          && current.currentRun.status === "completed"
          && current.execution.run_id === currentRunId
          && current.execution.runtime_state === "completed"
          && current.solverStatus.runtime_state === "awaiting_command"
          && current.status.solver?.state === "awaiting_command"
          && (!commandState || TERMINAL_COMMAND_STATES.has(commandState.status))) {
        terminal = current;
        break;
      }
      await delay(Math.min(5_000, Math.max(0, pollDeadline - Date.now())));
    }
    if (!terminal) {
      outcome = "unknown";
      throw new Error("P22 command was submitted but public terminal state was not observed before the bounded deadline");
    }

    assert.notEqual(terminal.currentRun.run_id, before.run_id, "P22 command reused the previous run ID");
    assert(studyStageExecutionBindingMatches(executionBinding, mode, terminal.currentRun.run_id),
      "P22 public terminal run does not match the accepted command execution binding");
    const afterSnapshot = await readSnapshot(session, {
      requireIdle: true,
      expectedStageIds: expectedAfterIds,
    });
    assert.equal(afterSnapshot.currentRun.run_id, terminal.currentRun.run_id,
      "P22 current run changed between terminal poll and result reads");
    assertStageRerunSceneUnchanged(afterSnapshot, session);
    assert.deepEqual(afterSnapshot.stageIds, expectedAfterIds,
      "P22 current stage view includes an unexpected stage");
    const afterOldResults = await readResults(
      before.run_id, session, studyStageExpectedStageIds(mode, "before"),
    );
    const newResults = afterSnapshot.resultIdentities;
    historyIdentityPreserved = studyStageHistoryIdentitiesPreserved(before.result_identities, afterOldResults);
    assert.equal(historyIdentityPreserved, true, "A previous Study result identity changed");
    assert.deepEqual(afterOldResults, before.result_identities,
      "A previous Study run lost or changed its durable result identities");
    assert.deepEqual(newResults.map((entry) => entry.authored_stage_id), expectedAfterIds,
      "New P22 run results contain a stage outside the selected mode");
    after = summary(afterSnapshot);
    after.preserved_prior_result_identities = afterOldResults;
    phase = "reload-observation";
    await page.waitForURL((url) => url.pathname === sessionRoutePath
      && url.origin === proxy.origin && url.search === "",
    { timeout: Math.min(15_000, timerBudget()) });
    const reloadResponse = await page.reload({
      waitUntil: "domcontentloaded", timeout: Math.min(60_000, timerBudget()),
    });
    assert.equal(reloadResponse?.status(), 200, "P22 reload did not return HTTP 200");
    assert.equal(new URL(page.url()).pathname, sessionRoutePath, "P22 reload changed the named session route");
    const home = page.locator('.fm-home-overlay[data-state="home-overlay"]');
    if (await home.isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "Back to simulation", exact: true }).click();
      await home.waitFor({ state: "hidden", timeout: Math.min(15_000, timerBudget()) });
    }
    await page.waitForFunction(() => {
      const viewport = document.querySelector(".fm-viewport-3d");
      const canvas = viewport?.querySelector("canvas");
      const label = viewport?.querySelector('[data-quantity-id="m"][data-field-state="data-ready"]');
      const rect = canvas?.getBoundingClientRect();
      const labelRect = label?.getBoundingClientRect();
      return canvas && rect?.width > 0 && rect?.height > 0
        && labelRect?.width > 0 && labelRect?.height > 0;
    }, null, { timeout: Math.min(30_000, timerBudget()) });
    const canvas = await page.locator(".fm-viewport-3d").evaluate((viewport) => {
      const element = viewport.querySelector("canvas");
      const rect = element.getBoundingClientRect();
      const gl = element.getContext("webgl2") ?? element.getContext("webgl");
      const label = viewport.querySelector('[data-quantity-id="m"]');
      const labelRect = label?.getBoundingClientRect();
      const style = label ? getComputedStyle(label) : null;
      return {
        visible: rect.width > 0 && rect.height > 0,
        context_type: gl?.constructor.name ?? null,
        context_lost: gl?.isContextLost() ?? true,
        drawing_buffer_width: gl?.drawingBufferWidth ?? 0,
        drawing_buffer_height: gl?.drawingBufferHeight ?? 0,
        quantity_id: label?.getAttribute("data-quantity-id") ?? null,
        label_visible: Boolean(labelRect?.width > 0 && labelRect?.height > 0
          && style?.display !== "none" && style?.visibility !== "hidden" && Number(style?.opacity) > 0),
        field_state: label?.getAttribute("data-field-state") ?? null,
        fdm_model_count: Number(viewport.getAttribute("data-fdm-model-count")),
      };
    });
    assert(canvas.visible && !canvas.context_lost
      && ["WebGLRenderingContext", "WebGL2RenderingContext"].includes(canvas.context_type)
      && canvas.drawing_buffer_width > 0 && canvas.drawing_buffer_height > 0,
      "P22 reload lost the visible WebGL drawing buffer");
    assert.equal(canvas.fdm_model_count, afterSnapshot.profile.domain_cell_count);
    const reloaded = await readSnapshot(session, { requireIdle: true, expectedStageIds: expectedAfterIds });
    assert.deepEqual(stableProjection(reloaded), stableProjection(afterSnapshot),
      "P22 reload changed the current run, scene, stage execution or result identities");
    if (["texture-stage-b", "texture-study"].includes(mode)) {
      assert.deepEqual(studyStageTextureBaselineState(reloaded.scene), textureBaselineState,
        "P22 reload changed the texture profile material, grid or global +X m0");
      assert.deepEqual(reloaded.sceneProfile.stage_b_texture_reset,
        { stage_id: "relax-b", object_id: textureBaselineState.material.object_id, scope: "object", initializer: null },
        "P22 reload lost or broadened the acknowledged B-local reset");
    }
    const reloadedHistory = await readResults(before.run_id, session, studyStageExpectedStageIds(mode, "before"));
    assert.deepEqual(reloadedHistory, afterOldResults, "P22 reload changed prior immutable result identities");
    assert.equal(commandCount, 1, "P22 reload dispatched a second command");
    assert.equal(commandAttemptCount, 1, "P22 reload attempted a second command");
    reloadProof = { status: 200, path: sessionRoutePath, run_id: reloaded.currentRun.run_id,
      command_count: commandCount, command_attempt_count: commandAttemptCount,
      stable_projection: true, history_identity_preserved: true, canvas };
    publicTerminalProven = true;
    outcome = "terminal-confirmed";
  } catch (error) {
    failure = boundedMessage(error);
    if (commandCount === 1 || materialCount === 1 || fdmCellCount === 1 || gridRefreshCount === 1
        || textureTransactionCount === 1) {
      outcome = "unknown";
      after = null;
      reloadProof = null;
      historyIdentityPreserved = null;
      publicTerminalProven = false;
    }
  } finally {
    const afterHashes = await sourceHashes(mode).catch((error) => {
      errors.push(boundedMessage(error));
      return null;
    });
    if (JSON.stringify(afterHashes) !== JSON.stringify(beforeHashes)) {
      failure ??= "Study stage rerun proof sources changed during the managed browser operation";
    }
    await context?.close().catch((error) => { errors.push(boundedMessage(error)); });
    await browser?.close().catch((error) => { errors.push(boundedMessage(error)); });
    await proxy?.close().catch((error) => { errors.push(boundedMessage(error)); });
    const result = {
      schema,
      scenario,
      state: failure ? (outcome === "unknown" ? "outcome-unknown" : "failed") : "passed",
      mode,
      failure,
      public_url: publicUrl,
      probe_url: upstreamUrl,
      playwright_version: playwrightVersion,
      browser_gpu_mode: process.env.CONTROL_ROOM_BROWSER_GPU_MODE,
      source_sha256_before: beforeHashes,
      source_sha256_after: afterHashes,
      session_before: session,
      session_after: session,
      before,
      phase,
      material_receipt: materialReceipt,
      material_count: materialCount,
      material_attempt_count: materialAttemptCount,
      ui_material_proven: uiMaterialProven,
      fdm_cell_receipt: fdmCellReceipt,
      fdm_cell_count: fdmCellCount,
      fdm_cell_attempt_count: fdmCellAttemptCount,
      ui_fdm_cell_proven: uiFdmCellProven,
      fdm_material_initial_state: fdmMaterialBeforeState,
      texture_source_proof: textureSourceProof,
      texture_baseline_state: textureBaselineState,
      texture_receipt: textureReceipt,
      texture_transaction_count: textureTransactionCount,
      texture_transaction_attempt_count: textureTransactionAttemptCount,
      ui_texture_proven: uiTextureProven,
      grid_refresh_receipt: gridRefreshReceipt,
      grid_refresh_count: gridRefreshCount,
      grid_refresh_attempt_count: gridRefreshAttemptCount,
      ui_grid_refresh_proven: uiGridRefreshProven,
      command_receipt: commandReceipt,
      command_count: commandCount,
      command_attempt_count: commandAttemptCount,
      client_ack_count: clientAckCount,
      camera_patch_receipts: cameraPatchReceipts,
      ui_command_proven: uiCommandProven,
      after,
      reload_proof: reloadProof,
      history_identity_preserved: historyIdentityPreserved,
      public_terminal_proven: publicTerminalProven,
      native_execution_proven: false,
      field_data_proven: false,
      outcome,
      read_counts: readCounts,
      request_counts: requestCounts,
      total_requests: totalRequests,
      request_limit: MAX_REQUESTS,
      request_path_limit: MAX_REQUEST_PATHS,
      per_path_read_limit: MAX_READS_PER_PATH,
      violations,
      errors,
      proxy_failures: proxy?.failures.slice(0, 16).map(boundedMessage) ?? [],
    };
    if (phase === "preflight" && !session) result.session_after = null;
    await writeResult(result).catch((error) => {
      process.stdout.write(JSON.stringify({ schema, scenario, state: "failed", outcome,
        failure: boundedMessage(error), native_execution_proven: false, field_data_proven: false }) + "\n");
      process.exitCode = 1;
    });
    if (result.state !== "passed") process.exitCode = 1;
    return result;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runStudyStageRerun();
  } catch (error) {
    process.stdout.write(JSON.stringify({
      schema,
      scenario,
      state: "failed",
      mode: process.argv[2] ?? null,
      outcome: "not-dispatched",
      native_execution_proven: false,
      field_data_proven: false,
      failure: boundedMessage(error),
    }) + "\n");
    process.exitCode = 1;
  }
}
