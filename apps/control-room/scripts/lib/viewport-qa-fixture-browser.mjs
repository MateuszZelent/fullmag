import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  buildScratchMaterialTransaction,
  buildScratchStudyPatch,
  buildScratchTextureTransaction,
  finiteSceneRevision,
} from "./scratch-authoring-browser.mjs";

const QA_OBJECT_ID = "qa-offset-film-mvgw65uf";
const QA_OBJECT_NAME = "QA offset film";
const EXPECTED_FIXTURE_SCHEMA = "scratch-authoring-fixture.v1";
const FIXTURE_URL = new URL("../fixtures/scratch-authoring/fdm.v1.json", import.meta.url);
const TERMINAL_STATES = new Set(["completed", "failed", "rejected", "cancelled"]);

const readFixture = async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
  if (fixture?.schema_version !== EXPECTED_FIXTURE_SCHEMA || fixture?.backend !== "fdm") {
    throw new Error("The tracked FDM scratch fixture has an unsupported schema or backend.");
  }
  return {
    ...fixture,
    object: {
      ...fixture.object,
      id: QA_OBJECT_ID,
      name: QA_OBJECT_NAME,
      region_name: QA_OBJECT_NAME,
    },
    texture: {
      ...fixture.texture,
      id: `texture:${QA_OBJECT_ID}:uniform-y`,
    },
    grid: {
      ...fixture.grid,
      // The preserved 40x30x10 nm QA box requires an exact divisor on every axis.
      default_cell: [2e-9, 2e-9, 2e-9],
      per_magnet: {
        [QA_OBJECT_ID]: { cell: [2e-9, 2e-9, 2e-9] },
      },
    },
  };
};

function assertIdentityShape(identity, label) {
  for (const key of ["session_id", "session_epoch", "request_scope_epoch"]) {
    if (typeof identity?.[key] !== "string" || identity[key].trim() === "") {
      throw new Error(`${label} omitted ${key}.`);
    }
  }
}

function sameIdentity(expected, actual) {
  return expected?.session_id === actual?.session_id
    && expected?.session_epoch === actual?.session_epoch
    && expected?.request_scope_epoch === actual?.request_scope_epoch;
}

function sessionScope(identity) {
  assertIdentityShape(identity, "Expected session identity");
  return [
    `session=${encodeURIComponent(identity.session_id)}`,
    `epoch=${encodeURIComponent(identity.session_epoch)}`,
    `request_scope_epoch=${encodeURIComponent(identity.request_scope_epoch)}`,
  ].join("&");
}

function canonicalUrl(page, path) {
  return new URL(path, new URL(page.url()).origin).toString();
}

async function apiJson(page, expectedSession, path, {
  method = "GET",
  body,
  timeout,
  scoped = true,
} = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (scoped) headers["x-fullmag-session-scope"] = sessionScope(expectedSession);
  const response = await page.request.fetch(canonicalUrl(page, path), {
    method,
    headers,
    ...(body === undefined ? {} : { data: JSON.stringify(body) }),
    timeout,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 512) };
  }
  if (!response.ok()) {
    const detail = payload?.error?.message ?? payload?.message ?? payload?.error ?? response.statusText();
    const error = new Error(`${method} ${path} returned ${response.status()}: ${String(detail).slice(0, 512)}`);
    error.httpStatus = response.status();
    error.acceptedRunId = String(detail).match(/^accepted run `([^`]+)` is durable/)?.[1] ?? null;
    throw error;
  }
  return payload;
}

function onlyExpectedObject(scene) {
  if (!Array.isArray(scene?.objects) || scene.objects.length !== 1) {
    throw new Error("The current canonical scene must contain exactly one QA object.");
  }
  const object = scene.objects[0];
  if (object?.id !== QA_OBJECT_ID || object?.name !== QA_OBJECT_NAME) {
    throw new Error("The current canonical scene does not contain the expected QA offset film.");
  }
  if (!object.geometry || !object.transform) {
    throw new Error("The QA object has no complete geometry/transform snapshot to preserve.");
  }
  if (scene.study?.requested_backend !== "fdm") {
    throw new Error("The expected QA session is not an FDM authoring scene.");
  }
  return object;
}

function objectAt(scene) {
  return scene.objects?.find((object) => object.id === QA_OBJECT_ID) ?? null;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function materialPropertiesMatch(actual, expected) {
  if (!actual || typeof actual !== "object") return false;
  return ["Ms", "Aex", "alpha", "Dind", "Dbulk"].every((key) => {
    const value = actual[key] ?? actual[key.toLowerCase()];
    return Number(value) === Number(expected[key]);
  });
}

function uniformTextureMatches(asset, expected) {
  const value = asset?.asset ?? asset;
  return value?.preset_kind === expected.preset_kind
    && sameJson(value?.preset_params, expected.preset_params);
}

function assertUnclaimedFixtureState(scene, fixture) {
  const object = onlyExpectedObject(scene);
  const material = scene.materials?.find((entry) => entry.id === fixture.material.id);
  if (material && !materialPropertiesMatch(material.properties, fixture.material)) {
    throw new Error("A conflicting QA material ID already exists; no authoring writes were sent.");
  }
  if (object.material_ref && object.material_ref !== fixture.material.id) {
    throw new Error("The QA object already references another material; no authoring writes were sent.");
  }
  if (object.region_name && object.region_name !== fixture.object.region_name) {
    throw new Error("The QA object already names another region; no authoring writes were sent.");
  }
  if (object.magnetization_ref && object.magnetization_ref !== fixture.texture.id) {
    throw new Error("The QA object already references another magnetization asset; no authoring writes were sent.");
  }
  const texture = scene.magnetization_assets?.find((entry) => entry.id === fixture.texture.id);
  if (texture && !uniformTextureMatches(texture, fixture.texture)) {
    throw new Error("A conflicting QA magnetization asset ID already exists; no authoring writes were sent.");
  }
  return {
    geometry: JSON.stringify(object.geometry),
    transform: JSON.stringify(object.transform),
    materialExists: Boolean(material),
    materialAssigned: object.material_ref === fixture.material.id,
    regionNameAssigned: object.region_name === fixture.object.region_name,
    textureExists: Boolean(texture),
    textureAssigned: object.magnetization_ref === fixture.texture.id,
  };
}

function assertPreservedScene(scene, preserved) {
  const object = onlyExpectedObject(scene);
  if (JSON.stringify(object.geometry) !== preserved.geometry
      || JSON.stringify(object.transform) !== preserved.transform) {
    throw new Error("Authoring changed the QA object's original geometry or transform.");
  }
}

function findSceneRevision(value) {
  const revision = Number(
    value?.scene_revision
      ?? value?.committed_scene?.revision
      ?? value?.revision,
  );
  return Number.isFinite(revision) ? revision : null;
}

async function assertExpectedSession(getSessionIdentity, expectedSession) {
  const actual = await getSessionIdentity();
  assertIdentityShape(actual, "Current status identity");
  if (!sameIdentity(expectedSession, actual)) {
    throw new Error("The current session identity changed; the fixture authoring operation was stopped.");
  }
}

async function readScene(page, expectedSession, getSessionIdentity, timeout) {
  await assertExpectedSession(getSessionIdentity, expectedSession);
  const scene = await apiJson(page, expectedSession, "/v2/sessions/current/model/scene", { timeout });
  await assertExpectedSession(getSessionIdentity, expectedSession);
  return scene;
}

async function assertCurrentSessionListed(page, expectedSession, timeout) {
  const collection = await apiJson(page, expectedSession, "/v2/sessions", {
    timeout,
    scoped: false,
  });
  const current = Array.isArray(collection?.sessions)
    ? collection.sessions.filter((session) => session.current)
    : [];
  if (current.length !== 1 || current[0]?.session_id !== expectedSession.session_id) {
    throw new Error("The session collection did not confirm exactly the expected current session.");
  }
}

async function commitSceneMutation(page, {
  expectedSession,
  getSessionIdentity,
  timeout,
  label,
  path,
  method = "POST",
  makeBody,
  preserved,
  verify,
  steps,
}) {
  const before = await readScene(page, expectedSession, getSessionIdentity, timeout);
  assertPreservedScene(before, preserved);
  const baseRevision = finiteSceneRevision(before);
  await assertExpectedSession(getSessionIdentity, expectedSession);
  const step = {
    label,
    base_revision: baseRevision,
    acknowledged_revision: null,
    observed_revision: null,
    state: "submitted",
  };
  steps.push(step);
  let acknowledgement;
  try {
    acknowledgement = await apiJson(page, expectedSession, path, {
      method,
      body: makeBody(baseRevision),
      timeout,
    });
  } catch (error) {
    step.state = error?.httpStatus === 409 && error.message.includes("your draft has not been applied")
      ? "rejected-no-write" : "outcome-unknown";
    throw error;
  }
  const acknowledgedRevision = findSceneRevision(acknowledgement);
  if (acknowledgedRevision === null || acknowledgedRevision <= baseRevision) {
    step.state = "acknowledgement-invalid";
    throw new Error(`${label} did not acknowledge a newer scene revision.`);
  }
  step.acknowledged_revision = acknowledgedRevision;
  step.state = "acknowledged";
  if (acknowledgement?.committed_scene?.revision !== undefined
      && Number(acknowledgement.committed_scene.revision) !== acknowledgedRevision) {
    throw new Error(`${label} returned inconsistent transaction and committed-scene revisions.`);
  }
  const observed = await readScene(page, expectedSession, getSessionIdentity, timeout);
  const observedRevision = finiteSceneRevision(observed);
  if (observedRevision !== acknowledgedRevision) {
    throw new Error(`${label} ACK revision ${acknowledgedRevision} did not match readback ${observedRevision}.`);
  }
  step.observed_revision = observedRevision;
  assertPreservedScene(observed, preserved);
  if (!verify(observed, acknowledgement)) {
    throw new Error(`${label} was acknowledged but its owning scene resource did not show the requested state.`);
  }
  step.observed_revision = observedRevision;
  step.state = "readback-verified";
  return { scene: observed, acknowledgement, revision: observedRevision };
}

async function readObjectInteraction(page, expectedSession, objectId, kind, timeout) {
  const objectPath = encodeURIComponent(objectId);
  return apiJson(
    page,
    expectedSession,
    `/v2/sessions/current/model/objects/${objectPath}/interactions/${encodeURIComponent(kind)}`,
    { timeout },
  );
}

async function waitCommandTerminal(page, expectedSession, getSessionIdentity, commandId, timeout) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() <= deadline) {
    await assertExpectedSession(getSessionIdentity, expectedSession);
    last = await apiJson(
      page,
      expectedSession,
      `/v2/sessions/current/simulation/commands/${encodeURIComponent(commandId)}`,
      { timeout: Math.min(timeout, 10_000) },
    );
    const status = String(last?.status ?? last?.completion_status ?? "").toLowerCase();
    if (TERMINAL_STATES.has(status)) {
      return { status, detail: last };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
  }
  return { status: "timeout", detail: last };
}

async function submitCommand(page, expectedSession, getSessionIdentity, commands, command, timeout) {
  await assertExpectedSession(getSessionIdentity, expectedSession);
  const scene = await readScene(page, expectedSession, getSessionIdentity, timeout);
  const sceneRevision = finiteSceneRevision(scene);
  if (sceneRevision === null) {
    throw new Error(`The ${command.kind} command has no canonical scene revision to record.`);
  }
  const record = {
    kind: command.kind,
    client_intent_id: command.client_intent_id,
    expected_session: {
      session_id: expectedSession.session_id,
      session_epoch: expectedSession.session_epoch,
      request_scope_epoch: expectedSession.request_scope_epoch,
    },
    scene_revision: sceneRevision,
    request: { ...command },
    state: "attempted",
    command_id: null,
    completion_status: null,
    resource_invalidations: [],
    attempted_at_unix_ms: Date.now(),
  };
  // Keep the submission intent before making the request. A transport failure
  // can happen after the server has accepted the command, so it must not be
  // silently dropped or automatically submitted again.
  commands.push(record);

  let acknowledgement;
  try {
    acknowledgement = await apiJson(
      page,
      expectedSession,
      "/v2/sessions/current/simulation/commands",
      { method: "POST", body: command, timeout },
    );
  } catch (error) {
    record.state = error?.acceptedRunId ? "accepted-preparation-incomplete"
      : error?.httpStatus === 422 ? "rejected-before-ack" : "outcome-unknown";
    record.accepted_run_id = error?.acceptedRunId ?? null;
    record.error = error?.message ?? String(error);
    throw new Error(`${command.kind} command POST ${record.state}: ${record.error}`);
  }
  if (typeof acknowledgement?.command_id === "string") {
    record.command_id = acknowledgement.command_id;
    record.acknowledged_at_unix_ms = Date.now();
  }
  if (acknowledgement?.accepted !== true || typeof acknowledgement.command_id !== "string") {
    record.state = acknowledgement?.accepted === false ? "rejected" : "outcome-unknown";
    record.error = `The ${command.kind} command was not acknowledged with a command ID.`;
    throw new Error(record.error);
  }
  // Record the server identity before any further wait or observation can fail.
  record.state = "acknowledged";

  let terminal;
  try {
    terminal = await waitCommandTerminal(
      page,
      expectedSession,
      getSessionIdentity,
      acknowledgement.command_id,
      timeout,
    );
  } catch (error) {
    record.state = "outcome-unknown";
    record.error = error?.message ?? String(error);
    throw new Error(`${command.kind} command ${acknowledgement.command_id} outcome is unknown: ${record.error}`);
  }
  record.completion_status = terminal.detail?.completion_status ?? terminal.status;
  record.resource_invalidations = terminal.detail?.resource_invalidations ?? [];
  record.terminal_at_unix_ms = terminal.detail?.terminal_at_unix_ms ?? null;
  if (terminal.status !== "completed") {
    const detail = terminal.detail?.error ?? terminal.detail?.reason ?? terminal.status;
    record.state = terminal.status === "timeout" ? "outcome-unknown" : terminal.status;
    record.error = String(detail).slice(0, 512);
    throw new Error(`${command.kind} ended as ${terminal.status}: ${String(detail).slice(0, 512)}`);
  }
  record.state = "completed";
  record.status = terminal.status;
  return record;
}

function verifyMaterial(scene, fixture) {
  const material = scene.materials?.find((entry) => entry.id === fixture.material.id);
  return Boolean(material && materialPropertiesMatch(material.properties, fixture.material));
}

function verifyAssignedMaterial(scene, fixture) {
  return objectAt(scene)?.material_ref === fixture.material.id && verifyMaterial(scene, fixture);
}

function verifyMagnetization(scene, fixture) {
  const texture = scene.magnetization_assets?.find((entry) => entry.id === fixture.texture.id);
  return objectAt(scene)?.magnetization_ref === fixture.texture.id
    && Boolean(texture && uniformTextureMatches(texture, fixture.texture));
}

function verifyStudy(scene, fixture) {
  const study = scene.study;
  const expectedCell = fixture.grid.per_magnet[QA_OBJECT_ID]?.cell;
  return study?.requested_backend === "fdm"
    && study?.requested_device === "cpu"
    && study?.requested_precision === "double"
    && study?.exchange_enabled === true
    && study?.demag_enabled === true
    && sameJson(study?.fdm?.default_cell, fixture.grid.default_cell)
    && sameJson(study?.fdm?.per_object_grid?.[QA_OBJECT_ID]?.cell, expectedCell)
    && study?.stages?.some((stage) => stage.stage_id === "relax-scratch");
}

function commandCounts(commands) {
  return {
    commands_submitted: commands.length,
    commands_acknowledged: commands.filter((command) => command.command_id !== null).length,
    commands_completed: commands.filter((command) => command.state === "completed").length,
  };
}

async function ensureInteraction(page, {
  expectedSession,
  getSessionIdentity,
  timeout,
  kind,
  preserved,
  steps,
}) {
  const objectPath = encodeURIComponent(QA_OBJECT_ID);
  const path = `/v2/sessions/current/model/objects/${objectPath}/interactions/${encodeURIComponent(kind)}`;
  const current = await readObjectInteraction(page, expectedSession, QA_OBJECT_ID, kind, timeout);
  if (current?.enabled === true && current?.present === true) {
    const scene = await readScene(page, expectedSession, getSessionIdentity, timeout);
    assertPreservedScene(scene, preserved);
    if (Number(current.scene_revision) !== finiteSceneRevision(scene)) {
      throw new Error(`${kind} interaction resource is not at the current scene revision.`);
    }
    return scene;
  }
  const mutationAndReadback = commitSceneMutation(page, {
    expectedSession,
    getSessionIdentity,
    timeout,
    label: `Enable ${kind}`,
    path,
    method: "PATCH",
    makeBody: (baseRevision) => ({
      base_revision: baseRevision,
      enabled: true,
      present: true,
      params: {},
    }),
    preserved,
    verify: (scene, acknowledgement) => {
      const interaction = acknowledgement?.interaction ?? acknowledgement;
      return interaction?.object_id === QA_OBJECT_ID
        && interaction?.interaction_kind === kind
        && interaction?.enabled === true
        && interaction?.present === true
        && Number(interaction?.scene_revision) === finiteSceneRevision(scene);
    },
    steps,
  }).then(async (mutation) => ({
    mutation,
    readback: await readObjectInteraction(page, expectedSession, QA_OBJECT_ID, kind, timeout),
  }));
  const { mutation, readback } = await mutationAndReadback;
  if (readback?.enabled !== true || readback?.present !== true
      || Number(readback.scene_revision) !== mutation.revision) {
    throw new Error(`${kind} interaction readback did not confirm the acknowledged revision.`);
  }
  return mutation.scene;
}

/**
 * Author a tiny field-capable FDM fixture inside the already active QA scene.
 * This function never creates/replaces a session and fails closed before any
 * write unless the expected session and sole QA object are both confirmed.
 */
export async function runViewportQaFixtureBrowser(page, {
  expectedSession,
  getSessionIdentity,
  timeout = 30_000,
} = {}) {
  const steps = [];
  const commands = [];
  let commandRunId = null;
  let fixture = null;
  let preserved = null;

  try {
    assertIdentityShape(expectedSession, "Expected session identity");
    if (typeof getSessionIdentity !== "function") {
      throw new Error("getSessionIdentity callback is required.");
    }
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error("A positive finite timeout is required.");
    }
    fixture = await readFixture();
    await assertExpectedSession(getSessionIdentity, expectedSession);
    await assertCurrentSessionListed(page, expectedSession, timeout);
    const initialScene = await readScene(page, expectedSession, getSessionIdentity, timeout);
    preserved = assertUnclaimedFixtureState(initialScene, fixture);
    commandRunId = createHash("sha256").update(JSON.stringify({
      schema: "viewport-qa-fixture.v2", session: expectedSession, fixture,
      geometry: preserved.geometry, transform: preserved.transform,
    })).digest("hex");
  } catch (error) {
    return {
      state: "not-run",
      reason: error?.message ?? String(error),
      writes_sent: 0,
      commands_submitted: 0,
    };
  }

  try {
    assertPreservedScene(await readScene(page, expectedSession, getSessionIdentity, timeout), preserved);
    const existingMaterial = preserved.materialExists;
    if (!existingMaterial) {
      await commitSceneMutation(page, {
        expectedSession,
        getSessionIdentity,
        timeout,
        label: "Create QA CoFeB material",
        path: "/v2/sessions/current/model/transactions",
        makeBody: (baseRevision) => buildScratchMaterialTransaction(fixture, baseRevision),
        preserved,
        verify: (updated) => verifyMaterial(updated, fixture),
        steps,
      });
    }

    if (!preserved.materialAssigned) {
      await commitSceneMutation(page, {
        expectedSession,
        getSessionIdentity,
        timeout,
        label: "Assign QA CoFeB material",
        path: `/v2/sessions/current/model/objects/${encodeURIComponent(QA_OBJECT_ID)}`,
        method: "PATCH",
        makeBody: (baseRevision) => ({
          base_revision: baseRevision,
          material_ref: fixture.material.id,
        }),
        preserved,
        verify: (updated) => verifyAssignedMaterial(updated, fixture),
        steps,
      });
    }

    if (!preserved.regionNameAssigned) {
      await commitSceneMutation(page, {
        expectedSession, getSessionIdentity, timeout,
        label: "Name QA magnetic region",
        path: `/v2/sessions/current/model/objects/${encodeURIComponent(QA_OBJECT_ID)}`,
        method: "PATCH",
        makeBody: (baseRevision) => ({ base_revision: baseRevision, region_name: fixture.object.region_name }),
        preserved,
        verify: (updated) => objectAt(updated)?.region_name === fixture.object.region_name,
        steps,
      });
    }

    if (!preserved.textureExists || !preserved.textureAssigned) {
      await commitSceneMutation(page, {
        expectedSession,
        getSessionIdentity,
        timeout,
        label: "Set QA uniform-Y magnetization",
        path: "/v2/sessions/current/model/transactions",
        makeBody: (baseRevision) => buildScratchTextureTransaction(fixture, baseRevision),
        preserved,
        verify: (updated) => verifyMagnetization(updated, fixture),
        steps,
      });
    }

    await ensureInteraction(page, {
      expectedSession,
      getSessionIdentity,
      timeout,
      kind: "exchange",
      preserved,
      steps,
    });
    await ensureInteraction(page, {
      expectedSession,
      getSessionIdentity,
      timeout,
      kind: "demag",
      preserved,
      steps,
    });

    const currentStudyScene = await readScene(page, expectedSession, getSessionIdentity, timeout);
    assertPreservedScene(currentStudyScene, preserved);
    if (!verifyStudy(currentStudyScene, fixture)) await commitSceneMutation(page, {
      expectedSession,
      getSessionIdentity,
      timeout,
      label: "Set QA FDM study and grid",
      path: "/v2/sessions/current/model/transactions",
      makeBody: (baseRevision) => {
        const transaction = buildScratchStudyPatch(fixture, baseRevision);
        transaction.merge_patch.study.fdm.per_object_grid = transaction.merge_patch.study.fdm.per_magnet;
        delete transaction.merge_patch.study.fdm.per_magnet;
        return transaction;
      },
      preserved,
      verify: (updated) => verifyStudy(updated, fixture),
      steps,
    });

    await submitCommand(page, expectedSession, getSessionIdentity, commands, {
      client_intent_id: `viewport-qa-fixture:${commandRunId}:mesh-build`,
      kind: "mesh_build",
      reason: "viewport_qa_fixture",
      mesh_reason: "shared-domain",
      mesh_target: { kind: "study_domain" },
    }, timeout);

    await submitCommand(page, expectedSession, getSessionIdentity, commands, {
      client_intent_id: `viewport-qa-fixture:${commandRunId}:compute-fields`,
      kind: "compute_fields",
      reason: "field_on_demand",
      requested_at_unix_ms: Date.now(),
      target: { kind: "study" },
    }, timeout);

    await assertExpectedSession(getSessionIdentity, expectedSession);
    const catalog = await apiJson(page, expectedSession, "/v2/sessions/current/data/fields", { timeout });
    const availableSpatialQuantities = [];
    if (Array.isArray(catalog?.quantities)) {
      for (const entry of catalog.quantities) {
        if (entry?.available !== true || entry?.spatial !== true) continue;
        availableSpatialQuantities.push({
          quantity_id: entry.quantity_id,
          field_revision: entry.field_revision,
        });
      }
    }
    if (availableSpatialQuantities.length === 0) {
      throw new Error("compute_fields completed, but data/fields exposed no available spatial field.");
    }
    const finalScene = await readScene(page, expectedSession, getSessionIdentity, timeout);
    assertPreservedScene(finalScene, preserved);
    if (!verifyAssignedMaterial(finalScene, fixture)
        || !verifyMagnetization(finalScene, fixture)
        || !verifyStudy(finalScene, fixture)) {
      throw new Error("The final canonical scene is missing one or more required QA authoring resources.");
    }

    return {
      state: "ready",
      session: {
        session_id: expectedSession.session_id,
        session_epoch: expectedSession.session_epoch,
        request_scope_epoch: expectedSession.request_scope_epoch,
      },
      object_id: QA_OBJECT_ID,
      object_name: QA_OBJECT_NAME,
      backend: "fdm",
      scene_revision: finiteSceneRevision(finalScene),
      geometry_and_transform_preserved: true,
      authoring_steps: steps,
      commands,
      field_catalog_revision: catalog.revision ?? null,
      domain_generation_id: catalog.domain_generation_id ?? null,
      available_spatial_quantities: availableSpatialQuantities,
      writes_sent: steps.length,
      writes_acknowledged: steps.filter((step) => step.acknowledged_revision !== null).length,
      writes_readback_verified: steps.filter((step) => step.state === "readback-verified").length,
      ...commandCounts(commands),
      magnetization_evolved: false,
    };
  } catch (error) {
    return {
      state: "failed",
      reason: error?.message ?? String(error),
      session_id: expectedSession.session_id,
      object_id: QA_OBJECT_ID,
      authoring_steps: steps,
      commands,
      writes_sent: steps.length,
      writes_acknowledged: steps.filter((step) => step.acknowledged_revision !== null).length,
      writes_readback_verified: steps.filter((step) => step.state === "readback-verified").length,
      ...commandCounts(commands),
    };
  }
}
