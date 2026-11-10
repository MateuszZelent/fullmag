import { isDeepStrictEqual } from "node:util";

export const STAGE_B_TEXTURE_SELECTORS = Object.freeze({
  stageNodeId: "model:study:stages:stage:relax-b",
  fallbackStageName: "Relax 2",
  addTextureChange: "Add texture change",
  magneticObject: "Magnetic object",
  applyTo: "Apply to",
  applyToObjectValue: "",
  texture: "Texture",
  resetToUniformXValue: "reset",
  addToStage: "Add to stage",
  saveStage: "Save stage",
  savedStageAck: "Saved stage relax-b.",
  initialMagnetization: "Initial magnetization",
  authoredStageValue: "authored_stage",
  authoredStageLabel: "Start all objects from this stage's authored state",
  runStage: "Run this stage",
});

export const TEXTURE_TRANSACTION_PATH = "/v2/sessions/current/model/transactions";
const STAGE_ID = "relax-b";
const ASSIGNMENT_SCHEMA = "fullmag.magnetization-assignments.v1";
const singleRunPages = new WeakSet();

function reject(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function flattenPipeline(nodes, ancestorsEnabled = true, output = []) {
  if (!Array.isArray(nodes)) reject("The canonical Study pipeline has no nodes array.");
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.id !== "string" || !node.id.trim()) {
      reject("The canonical Study pipeline contains a node without a stable ID.");
    }
    const enabled = ancestorsEnabled && node.enabled !== false;
    if (node.node_kind === "group") {
      flattenPipeline(node.children ?? [], enabled, output);
    } else if (node.node_kind === "primitive") {
      output.push({ node, enabled });
    }
  }
  return output;
}

function stageTarget(scene, objectId) {
  if (!isRecord(scene) || !Number.isSafeInteger(scene.revision) || scene.revision < 0) {
    reject("A saved scene with an integer revision is required.");
  }
  if (!isRecord(scene.study) || !isRecord(scene.study.study_pipeline)) {
    reject("A canonical Study pipeline is required.");
  }
  const pipeline = scene.study.study_pipeline;
  if (!["study_pipeline.v1", "study_pipeline.v2"].includes(pipeline.version) || !Array.isArray(pipeline.nodes)) {
    reject("The canonical Study pipeline is malformed or unsupported.");
  }
  const stages = flattenPipeline(pipeline.nodes);
  const byId = (id) => stages.filter(({ node }) => node.id === id);
  const chain = ["relax-a", "relax-b", "relax-c"].map((id) => {
    const matches = byId(id);
    if (matches.length !== 1) reject(`Expected exactly one pipeline stage ${id}.`);
    return matches[0];
  });
  const indices = chain.map(({ node }) => stages.findIndex((item) => item.node === node));
  if (!(indices[0] < indices[1] && indices[1] < indices[2])) {
    reject("The authored Relax A → B → C order changed.");
  }
  const target = chain[1];
  if (target.node.stage_kind !== "relax" || !isRecord(target.node.payload)) {
    reject("Stage B must be an authored Relax primitive with an object payload.");
  }
  if (!target.enabled) reject("Stage B or one of its parent groups is disabled.");
  if (Object.hasOwn(target.node.payload, "stage_magnetization_assignments")) {
    reject("Stage B already has a stage-local texture assignment; refusing to replace or duplicate it.");
  }
  const magnets = Array.isArray(scene.objects)
    ? scene.objects.filter((object) => isRecord(object) && object.id === objectId && object.role === "magnet")
    : [];
  if (magnets.length !== 1) reject(`Expected exactly one magnetic object with ID ${objectId}.`);
  return { pipeline, stages, target: target.node };
}

function same(actual, expected) {
  return isDeepStrictEqual(actual, expected);
}

/** Build the one permitted Scene transaction for a whole-object +X reset on B. */
export function buildStageBUniformXResetTransaction({
  scene,
  sceneRevision = scene?.revision,
  statusSceneRevision = sceneRevision,
  objectId = "film",
}) {
  if (!Number.isSafeInteger(sceneRevision) || sceneRevision < 0 ||
      scene?.revision !== sceneRevision || statusSceneRevision !== sceneRevision) {
    reject("The displayed scene and live status revisions must match before editing Stage B.");
  }
  const { pipeline, target } = stageTarget(scene, objectId);
  const nextPipeline = clone(pipeline);
  let patched = 0;
  const visit = (nodes) => nodes.map((node) => {
    if (node.id === STAGE_ID) {
      patched += 1;
      return {
        ...node,
        payload: {
          ...node.payload,
          stage_magnetization_assignments: {
            schema_version: ASSIGNMENT_SCHEMA,
            assignments: [{ object_id: objectId, region_id: null, initializer: null }],
          },
        },
      };
    }
    if (node.node_kind === "group") return { ...node, children: visit(node.children ?? []) };
    return node;
  });
  nextPipeline.version = "study_pipeline.v2";
  nextPipeline.nodes = visit(nextPipeline.nodes);
  if (patched !== 1 || target.id !== STAGE_ID) reject("Could not bind the reset to exactly Stage B.");
  return {
    kind: "merge_patch",
    base_revision: sceneRevision,
    merge_patch: { study: { study_pipeline: nextPipeline } },
  };
}

function expectedCommittedScene(scene, transaction, committedRevision) {
  const expected = clone(scene);
  expected.revision = committedRevision;
  expected.study.study_pipeline = clone(transaction.merge_patch.study.study_pipeline);
  return expected;
}

/** Validate the browser-observed save window: one scoped request and its exact ACK. */
export function validateStageBUniformXResetExchange({
  scene,
  sceneRevision = scene?.revision,
  statusSceneRevision = sceneRevision,
  objectId = "film",
  sessionScopeKey,
  writes,
  acknowledgement,
}) {
  if (typeof sessionScopeKey !== "string" || sessionScopeKey.length === 0) {
    reject("A session scope key is required for the Stage B save.");
  }
  const expected = buildStageBUniformXResetTransaction({ scene, sceneRevision, statusSceneRevision, objectId });
  if (!Array.isArray(writes) || writes.length !== 1) {
    reject("The Stage B save window must contain exactly one write.");
  }
  const [write] = writes;
  if (write.method !== "POST" || write.path !== TEXTURE_TRANSACTION_PATH) {
    reject("The Stage B save used an unexpected endpoint or method.");
  }
  const scopeHeader = Object.entries(write.headers ?? {}).find(([name]) => name.toLowerCase() === "x-fullmag-session-scope")?.[1];
  if (scopeHeader !== sessionScopeKey) reject("The Stage B save used the wrong session scope.");
  if (!same(write.body, expected)) {
    reject("The Stage B request is not the exact revision-fenced, one-reset transaction.");
  }
  if (!isRecord(acknowledgement) || !Number.isInteger(acknowledgement.status) ||
      acknowledgement.status < 200 || acknowledgement.status >= 300) {
    reject("The Stage B transaction did not receive a successful normal HTTP ACK.");
  }
  const body = acknowledgement.body;
  const nextRevision = sceneRevision + 1;
  if (!isRecord(body) || body.transaction_kind !== "merge_patch" || body.scene_revision !== nextRevision ||
      !isRecord(body.committed_scene) || body.committed_scene.revision !== nextRevision) {
    reject("The save ACK does not identify the expected committed scene revision.");
  }
  const expectedScene = expectedCommittedScene(scene, expected, nextRevision);
  if (!same(body.committed_scene, expectedScene)) {
    reject("The committed scene ACK lost unrelated data or changed scope outside Stage B.");
  }
  return { sceneRevision: nextRevision, stageId: STAGE_ID, objectId };
}

function stageBRow(page) {
  return page.locator(`[data-node-id="${STAGE_B_TEXTURE_SELECTORS.stageNodeId}"]`);
}

async function requireStageBSelected(page) {
  const row = stageBRow(page);
  await row.waitFor({ state: "visible" });
  if (await row.getAttribute("role") !== "treeitem" || await row.getAttribute("aria-selected") !== "true") {
    reject("Select the exact Relax B tree item before using its Inspector controls.");
  }
  return row;
}

/** Select B and enter the normal Inspector controls; this function sends no API request. */
export async function fillStageBUniformXResetInInspector(page, { objectId = "film" } = {}) {
  if (typeof objectId !== "string" || objectId.length === 0) reject("A magnetic object ID is required.");
  await stageBRow(page).click();
  await requireStageBSelected(page);
  await page.getByRole("button", { name: STAGE_B_TEXTURE_SELECTORS.addTextureChange, exact: true }).click();
  await page.getByRole("combobox", { name: STAGE_B_TEXTURE_SELECTORS.magneticObject, exact: true }).selectOption(objectId);
  await page.getByRole("combobox", { name: STAGE_B_TEXTURE_SELECTORS.applyTo, exact: true })
    .selectOption(STAGE_B_TEXTURE_SELECTORS.applyToObjectValue);
  await page.getByRole("combobox", { name: STAGE_B_TEXTURE_SELECTORS.texture, exact: true })
    .selectOption(STAGE_B_TEXTURE_SELECTORS.resetToUniformXValue);
  await page.getByRole("button", { name: STAGE_B_TEXTURE_SELECTORS.addToStage, exact: true }).click();
}

/** Click Save stage and wait for both the app's normal transaction response and UI ACK. */
export async function saveStageBResetAndWaitForAck(page, { timeout = 30_000 } = {}) {
  await requireStageBSelected(page);
  const responsePromise = page.waitForResponse((response) => {
    if (response.request().method() !== "POST") return false;
    try {
      return new URL(response.url()).pathname === TEXTURE_TRANSACTION_PATH;
    } catch {
      return false;
    }
  }, { timeout });
  // Keep a failed click or context cleanup from orphaning this pending observer.
  // Awaiting the original promise below still propagates an actual response failure.
  void responsePromise.catch(() => undefined);
  await page.getByRole("button", { name: STAGE_B_TEXTURE_SELECTORS.saveStage, exact: true }).click();
  const response = await responsePromise;
  const body = await response.json();
  await page.getByText(STAGE_B_TEXTURE_SELECTORS.savedStageAck, { exact: true })
    .waitFor({ state: "visible", timeout });
  return { status: response.status(), body };
}

/** Pin the authored B input after the local reset has been saved and acknowledged. */
export async function selectStageBAuthoredInitialState(page) {
  await requireStageBSelected(page);
  const selector = page.getByRole("combobox", { name: STAGE_B_TEXTURE_SELECTORS.initialMagnetization, exact: true });
  await selector.selectOption(STAGE_B_TEXTURE_SELECTORS.authoredStageValue);
}

/** Dispatch one user click on the real Run this stage button; caller owns runtime guards. */
export async function clickRunStageBOnce(page) {
  if (singleRunPages.has(page)) reject("This helper already clicked Run this stage for this page.");
  await requireStageBSelected(page);
  const button = page.getByRole("button", { name: STAGE_B_TEXTURE_SELECTORS.runStage, exact: true });
  await button.waitFor({ state: "visible" });
  singleRunPages.add(page);
  await button.click();
}
