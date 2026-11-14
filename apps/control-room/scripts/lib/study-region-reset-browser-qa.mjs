import { isDeepStrictEqual } from "node:util";

import {
  buildStageBUniformXResetTransaction,
  STAGE_B_TEXTURE_SELECTORS,
  TEXTURE_TRANSACTION_PATH,
} from "./study-texture-browser-qa.mjs";

export const STAGE_B_REGION_RESET_SELECTORS = Object.freeze({
  ...STAGE_B_TEXTURE_SELECTORS,
  applyToRegionValue: "left-half",
  textureResetLabel: "Use object texture",
  includeInStudy: "Include this stage in Study",
});

const STAGE_ID = "relax-b";
const OBJECT_ID = "film";
const REGION_ID = "left-half";
const ASSIGNMENT_SCHEMA = "fullmag.magnetization-assignments.v1";

function reject(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function requireMatchingRevisions(scene, sceneRevision, statusSceneRevision) {
  if (!Number.isSafeInteger(sceneRevision) || sceneRevision < 0 ||
      scene?.revision !== sceneRevision || statusSceneRevision !== sceneRevision) {
    reject("The displayed scene and live status revisions must match before editing Stage B.");
  }
}

function flattenPipeline(nodes, ancestorsEnabled = true, output = [], ancestors = [], seenIds = new Set()) {
  if (!Array.isArray(nodes)) reject("The canonical Study pipeline has no nodes array.");
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.id !== "string" || !node.id.trim()) {
      reject("The canonical Study pipeline contains a node without a stable ID.");
    }
    if (seenIds.has(node.id)) reject(`The canonical Study pipeline contains duplicate node ID ${node.id}.`);
    seenIds.add(node.id);
    const enabled = ancestorsEnabled && node.enabled !== false;
    if (node.node_kind === "group") {
      if (node.enabled !== undefined && typeof node.enabled !== "boolean") {
        reject(`Pipeline group ${node.id} has an invalid enabled value.`);
      }
      flattenPipeline(node.children ?? [], enabled, output, [...ancestors, node], seenIds);
    } else if (node.node_kind === "primitive") {
      output.push({ node, enabled, ancestors });
    }
  }
  return output;
}

function stageBTarget(scene, { requireEnabledTarget = false } = {}) {
  if (!isRecord(scene) || !isRecord(scene.study) || !isRecord(scene.study.study_pipeline)) {
    reject("A canonical Study pipeline is required.");
  }
  const pipeline = scene.study.study_pipeline;
  if (!["study_pipeline.v1", "study_pipeline.v2"].includes(pipeline.version) || !Array.isArray(pipeline.nodes)) {
    reject("The canonical Study pipeline is malformed or unsupported.");
  }
  const stages = flattenPipeline(pipeline.nodes);
  const byId = (id) => stages.filter(({ node }) => node.id === id);
  const chain = ["relax-a", STAGE_ID, "relax-c"].map((id) => {
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
  if (target.ancestors.some((ancestor) => ancestor.enabled === false)) {
    reject("A parent group of Stage B is disabled.");
  }
  if (target.node.enabled !== undefined && typeof target.node.enabled !== "boolean") {
    reject("Stage B has an invalid enabled value.");
  }
  if (requireEnabledTarget && target.node.enabled === false) reject("Stage B is disabled.");
  return { pipeline, stages, target: target.node };
}

function exactSceneAfter(scene, transaction, nextRevision) {
  const expected = clone(scene);
  expected.revision = nextRevision;
  expected.study.study_pipeline = clone(transaction.merge_patch.study.study_pipeline);
  return expected;
}

function validateExchange({
  scene,
  sceneRevision = scene?.revision,
  statusSceneRevision = sceneRevision,
  sessionScopeKey,
  writes,
  acknowledgement,
  expectedTransaction,
}) {
  requireMatchingRevisions(scene, sceneRevision, statusSceneRevision);
  if (typeof sessionScopeKey !== "string" || sessionScopeKey.length === 0) {
    reject("A session scope key is required for the Stage B save.");
  }
  if (!Array.isArray(writes) || writes.length !== 1) {
    reject("The Stage B save window must contain exactly one write.");
  }
  const [write] = writes;
  if (!isRecord(write) || write.method !== "POST" || write.path !== TEXTURE_TRANSACTION_PATH) {
    reject("The Stage B save used an unexpected transaction endpoint or method.");
  }
  const scopeHeaders = Object.entries(isRecord(write.headers) ? write.headers : {})
    .filter(([name]) => name.toLowerCase() === "x-fullmag-session-scope");
  if (scopeHeaders.length !== 1 || scopeHeaders[0][1] !== sessionScopeKey) {
    reject("The Stage B save used the wrong session scope.");
  }
  if (!isDeepStrictEqual(write.body, expectedTransaction)) {
    reject("The Stage B request is not the exact revision-fenced transaction.");
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
  if (!isDeepStrictEqual(body.committed_scene, exactSceneAfter(scene, expectedTransaction, nextRevision))) {
    reject("The committed scene ACK lost unrelated data or changed scope outside Stage B.");
  }
  return nextRevision;
}

/** Build the fixed S46 regional object-texture reset for Relax B. */
export function buildStageBRegionObjectTextureResetTransaction({
  scene,
  sceneRevision = scene?.revision,
  statusSceneRevision = sceneRevision,
}) {
  requireMatchingRevisions(scene, sceneRevision, statusSceneRevision);

  // Validate stable IDs here too; the existing object helper remains the strict request base.
  stageBTarget(scene, { requireEnabledTarget: true });
  const transaction = buildStageBUniformXResetTransaction({
    scene,
    sceneRevision,
    statusSceneRevision,
    objectId: OBJECT_ID,
  });
  const magnets = Array.isArray(scene.objects)
    ? scene.objects.filter((object) => isRecord(object) && object.id === OBJECT_ID && object.role === "magnet")
    : [];
  if (magnets.length !== 1) reject(`Expected exactly one magnetic object with ID ${OBJECT_ID}.`);
  const regions = Array.isArray(magnets[0].regions)
    ? magnets[0].regions.filter((region) => isRecord(region) && region.region_id === REGION_ID)
    : [];
  if (regions.length !== 1) reject(`Expected exactly one ${REGION_ID} region on magnetic object ${OBJECT_ID}.`);
  if (regions[0].enabled !== undefined && typeof regions[0].enabled !== "boolean") {
    reject(`Region ${REGION_ID} on ${OBJECT_ID} has an invalid enabled value.`);
  }
  if (regions[0].enabled === false) reject(`Region ${REGION_ID} on ${OBJECT_ID} is disabled.`);

  const nodes = transaction.merge_patch.study.study_pipeline.nodes;
  const visit = (pipelineNodes) => pipelineNodes.map((node) => {
    if (node.node_kind === "primitive" && node.id === STAGE_ID) {
      const reset = node.payload.stage_magnetization_assignments;
      const assignment = { object_id: OBJECT_ID, region_id: null, initializer: null };
      if (!isDeepStrictEqual(reset, { schema_version: ASSIGNMENT_SCHEMA, assignments: [assignment] })) {
        reject("The whole-object base helper did not produce the exact one-object reset.");
      }
      return {
        ...node,
        payload: {
          ...node.payload,
          stage_magnetization_assignments: {
            schema_version: ASSIGNMENT_SCHEMA,
            assignments: [{ ...assignment, region_id: REGION_ID }],
          },
        },
      };
    }
    if (node.node_kind === "group") return { ...node, children: visit(node.children ?? []) };
    return node;
  });
  transaction.merge_patch.study.study_pipeline.nodes = visit(nodes);
  return transaction;
}

/** Build the exact Stage B enabled toggle, preserving the full pipeline and local recipe. */
export function buildStageBEnabledTransaction({
  scene,
  sceneRevision = scene?.revision,
  statusSceneRevision = sceneRevision,
  enabled,
}) {
  requireMatchingRevisions(scene, sceneRevision, statusSceneRevision);
  if (typeof enabled !== "boolean") reject("A boolean Stage B enabled value is required.");
  const { pipeline, target } = stageBTarget(scene);
  const currentlyEnabled = target.enabled !== false;
  if (currentlyEnabled === enabled) reject(`Stage B is already ${enabled ? "enabled" : "disabled"}; refusing a no-op save.`);
  const nextPipeline = clone(pipeline);
  let changed = 0;
  const visit = (nodes) => nodes.map((node) => {
    if (node.node_kind === "primitive" && node.id === STAGE_ID) {
      changed += 1;
      return { ...node, enabled };
    }
    if (node.node_kind === "group") return { ...node, children: visit(node.children ?? []) };
    return node;
  });
  nextPipeline.nodes = visit(nextPipeline.nodes);
  if (changed !== 1) reject("Could not bind the enabled toggle to exactly Stage B.");
  return {
    kind: "merge_patch",
    base_revision: sceneRevision,
    merge_patch: { study: { study_pipeline: nextPipeline } },
  };
}

/** Validate one observed regional reset POST and its exact committed-scene ACK. */
export function validateStageBRegionObjectTextureResetExchange({
  scene,
  sceneRevision = scene?.revision,
  statusSceneRevision = sceneRevision,
  sessionScopeKey,
  writes,
  acknowledgement,
}) {
  const expectedTransaction = buildStageBRegionObjectTextureResetTransaction({ scene, sceneRevision, statusSceneRevision });
  const nextRevision = validateExchange({
    scene, sceneRevision, statusSceneRevision, sessionScopeKey, writes, acknowledgement, expectedTransaction,
  });
  return { sceneRevision: nextRevision, stageId: STAGE_ID, objectId: OBJECT_ID, regionId: REGION_ID };
}

/** Validate one observed Stage B enabled toggle POST and its exact committed-scene ACK. */
export function validateStageBEnabledExchange({
  scene,
  sceneRevision = scene?.revision,
  statusSceneRevision = sceneRevision,
  enabled,
  sessionScopeKey,
  writes,
  acknowledgement,
}) {
  const expectedTransaction = buildStageBEnabledTransaction({ scene, sceneRevision, statusSceneRevision, enabled });
  const nextRevision = validateExchange({
    scene, sceneRevision, statusSceneRevision, sessionScopeKey, writes, acknowledgement, expectedTransaction,
  });
  return { sceneRevision: nextRevision, stageId: STAGE_ID, enabled };
}

function stageBRow(page) {
  return page.locator(`[data-node-id="${STAGE_B_REGION_RESET_SELECTORS.stageNodeId}"]`);
}

async function requireStageBSelected(page) {
  const row = stageBRow(page);
  await row.waitFor({ state: "visible" });
  if (await row.getAttribute("role") !== "treeitem" || await row.getAttribute("aria-selected") !== "true") {
    reject("Select the exact Relax B tree item before using its Inspector controls.");
  }
  return row;
}

/** Select Relax B and author its fixed left-half Use object texture assignment through the UI. */
export async function fillStageBRegionObjectTextureResetInInspector(page) {
  await stageBRow(page).click();
  await requireStageBSelected(page);
  await page.getByRole("button", { name: STAGE_B_REGION_RESET_SELECTORS.addTextureChange, exact: true }).click();
  await page.getByRole("combobox", { name: STAGE_B_REGION_RESET_SELECTORS.magneticObject, exact: true })
    .selectOption(OBJECT_ID);
  await page.getByRole("combobox", { name: STAGE_B_REGION_RESET_SELECTORS.applyTo, exact: true })
    .selectOption(STAGE_B_REGION_RESET_SELECTORS.applyToRegionValue);
  await page.getByRole("combobox", { name: STAGE_B_REGION_RESET_SELECTORS.texture, exact: true })
    .selectOption({ label: STAGE_B_REGION_RESET_SELECTORS.textureResetLabel });
  await page.getByRole("button", { name: STAGE_B_REGION_RESET_SELECTORS.addToStage, exact: true }).click();
}

/** Set the real Include this stage in Study checkbox with one user click if needed. */
export async function setStageBStudyInclusionInInspector(page, { enabled } = {}) {
  if (typeof enabled !== "boolean") reject("A boolean Stage B Study inclusion value is required.");
  await stageBRow(page).click();
  await requireStageBSelected(page);
  const checkbox = page.getByRole("checkbox", { name: STAGE_B_REGION_RESET_SELECTORS.includeInStudy, exact: true });
  await checkbox.waitFor({ state: "visible" });
  if (await checkbox.isChecked() !== enabled) await checkbox.click();
  if (await checkbox.isChecked() !== enabled) reject("The Stage B Study inclusion checkbox did not reach the requested state.");
}

/** Click Save stage and wait for its exact normal Stage B acknowledgment; sends no direct request. */
export async function saveStageBStudyChangeAndWaitForAck(page, { timeout = 30_000 } = {}) {
  await requireStageBSelected(page);
  const responsePromise = page.waitForResponse((response) => {
    if (response.request().method() !== "POST") return false;
    try {
      return new URL(response.url()).pathname === TEXTURE_TRANSACTION_PATH;
    } catch {
      return false;
    }
  }, { timeout });
  void responsePromise.catch(() => undefined);
  await page.getByRole("button", { name: STAGE_B_REGION_RESET_SELECTORS.saveStage, exact: true }).click();
  const response = await responsePromise;
  const body = await response.json();
  await page.getByText(STAGE_B_REGION_RESET_SELECTORS.savedStageAck, { exact: true })
    .waitFor({ state: "visible", timeout });
  return { status: response.status(), body };
}
