import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function runMaterialAssignmentDraftCheck() {
const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptsRoot, "..");
const modelPath = resolve(appRoot, "src/modules/inspector/panels/ObjectMaterialPanelModel.ts");
const panelPath = resolve(appRoot, "src/modules/inspector/panels/ObjectMaterialPanel.tsx");
const source = await readFile(modelPath, "utf8");
const executableSource = stripTypeScriptTypes(source, {
  mode: "strip",
  sourceUrl: pathToFileURL(modelPath).href,
});
const model = await import(
  "data:text/javascript;base64," + Buffer.from(executableSource, "utf8").toString("base64")
);
const inspectorDraftStatePath = resolve(appRoot, "src/modules/inspector/panels/inspectorDraftState.ts");
const inspectorDraftStateSource = await readFile(inspectorDraftStatePath, "utf8");
const inspectorDraftState = await import(
  "data:text/javascript;base64," + Buffer.from(
    stripTypeScriptTypes(inspectorDraftStateSource, {
      mode: "strip",
      sourceUrl: pathToFileURL(inspectorDraftStatePath).href,
    }),
    "utf8",
  ).toString("base64")
);

const emptyBase = model.magneticParametersDraftFromResource(null, null);
const assignedScene = {
  revision: 9,
  scene_revision: 9,
  materials: [{
    id: "mat:object",
    name: "Object material",
    properties: {
      Aex: 1.3e-11,
      Dbulk: null,
      Dind: null,
      Ms: 8e5,
      alpha: 0.01,
    },
  }],
};
const committedBase = model.magneticParametersDraftFromSceneResource("mat:object", assignedScene);
assert.ok(committedBase, "the acknowledged assigned scene must contain the committed material");
const committedMaterialResource = model.magneticParameterMaterialResourceFromSceneResource(
  "mat:object",
  assignedScene,
);
assert.deepEqual(committedMaterialResource, {
  id: "mat:object",
  name: "Object material",
  properties: { Aex: 1.3e-11, Dbulk: null, Dind: null, Ms: 8e5, alpha: 0.01 },
  scene_revision: 9,
});
assert.equal(
  model.materialParametersDraftKey("mat:object", committedMaterialResource),
  model.materialParametersDraftKey("mat:object", {
    id: "mat:object",
    name: "Object material",
    properties: { Aex: 1.3e-11, Dbulk: null, Dind: null, Ms: 8e5, alpha: 0.01 },
    scene_revision: 9,
  }),
  "the acknowledged scene key must match the actual material-resource key shape",
);
assert.equal(
  model.magneticParameterMaterialResourceFromSceneResource("mat:object", {
    ...assignedScene,
    materials: [{ ...assignedScene.materials[0], properties: { ...assignedScene.materials[0].properties, Aex: "invalid" } }],
  }),
  null,
  "invalid scene summary values must not be cast into a material resource",
);

const defaultRebase = model.rebaseMagneticParametersDraftAfterAssignment({
  previousBaseDraft: emptyBase,
  draftAtStart: emptyBase,
  currentDraft: emptyBase,
  committedBaseDraft: committedBase,
  startingRevisions: new Map(),
  currentRevisions: new Map(),
});
assert.deepEqual(defaultRebase, committedBase, "an untouched form must adopt the committed material values");
assert.equal(model.magneticParametersDraftDirty(defaultRebase, committedBase), false);

const preExistingDraft = { ...emptyBase, ms: "7.5e5", materialName: "User value" };
const preExistingRevisions = new Map([["ms", 1], ["materialName", 1]]);
const preExistingRebase = model.rebaseMagneticParametersDraftAfterAssignment({
  previousBaseDraft: emptyBase,
  draftAtStart: preExistingDraft,
  currentDraft: preExistingDraft,
  committedBaseDraft: committedBase,
  startingRevisions: preExistingRevisions,
  currentRevisions: preExistingRevisions,
});
assert.equal(preExistingRebase.ms, "7.5e5", "a real pre-existing Ms draft must survive the assignment ACK");
assert.equal(preExistingRebase.materialName, "User value");
assert.equal(preExistingRebase.aex, committedBase.aex, "untouched fields must rebase to the committed material");

const inFlightDraft = { ...emptyBase, alpha: "0.2" };
const duringRebase = model.rebaseMagneticParametersDraftAfterAssignment({
  previousBaseDraft: emptyBase,
  draftAtStart: emptyBase,
  currentDraft: inFlightDraft,
  committedBaseDraft: committedBase,
  startingRevisions: new Map(),
  currentRevisions: new Map([["alpha", 1]]),
});
assert.equal(duringRebase.alpha, "0.2", "a field edited while the request was pending must survive");
assert.equal(duringRebase.ms, committedBase.ms);

const explicitZeroRevisions = new Map([["dind", 1]]);
const explicitZeroDraft = { ...emptyBase, dind: "0" };
const explicitZeroRebase = model.rebaseMagneticParametersDraftAfterAssignment({
  previousBaseDraft: emptyBase,
  draftAtStart: explicitZeroDraft,
  currentDraft: explicitZeroDraft,
  committedBaseDraft: committedBase,
  startingRevisions: explicitZeroRevisions,
  currentRevisions: explicitZeroRevisions,
});
assert.equal(explicitZeroRebase.dind, "0", "an explicit optional-field zero must survive an empty-to-zero rebase");
assert.equal(model.magneticParametersDraftDirty(explicitZeroRebase, committedBase), true);

const assignmentBaseOverride = {
  baseDraft: committedBase,
  baseKey: "assigned-base-key",
  identityKey: "scope:object:one",
  materialId: "mat:object",
  objectId: "object:one",
  sceneRevision: 9,
  scopeKey: "scope",
  scopeToken: Symbol("scope"),
};
const overrideDecision = (overrides = {}) => model.acknowledgedAssignmentBaseDecision({
  override: assignmentBaseOverride,
  currentSceneBaseKey: assignmentBaseOverride.baseKey,
  currentResourceBaseKey: "stale-base-key",
  currentMaterialId: "mat:object",
  currentObjectId: "object:one",
  currentSceneRevision: 9,
  currentScopeKey: "scope",
  currentScopeToken: assignmentBaseOverride.scopeToken,
  ...overrides,
});
assert.equal(overrideDecision(), "use", "the ACK base stays active while the matching resource is stale");
assert.equal(
  overrideDecision({ currentResourceBaseKey: assignmentBaseOverride.baseKey }),
  "rebase",
  "a matching material hook key confirms the ACK scene base",
);
const newerScene = {
  ...assignedScene,
  revision: 10,
  scene_revision: 10,
  materials: [{
    ...assignedScene.materials[0],
    properties: { ...assignedScene.materials[0].properties, Ms: 9e5 },
  }],
};
const newerSceneMaterial = model.magneticParameterMaterialResourceFromSceneResource("mat:object", newerScene);
assert.ok(newerSceneMaterial);
const newerSceneBase = model.magneticParametersDraftFromResource("mat:object", newerSceneMaterial);
const newerSceneBaseKey = `committed:object:one:10:mat:object:${model.materialParametersDraftKey(
  "mat:object",
  newerSceneMaterial,
)}`;
const staleHookBase = model.magneticParametersDraftFromResource("mat:object", null);
assert.notEqual(staleHookBase.ms, newerSceneBase.ms);
assert.equal(
  overrideDecision({
    currentSceneBaseKey: newerSceneBaseKey,
    currentSceneRevision: 10,
    currentResourceBaseKey: "stale-material-hook-key",
  }),
  "rebase",
  "a newer scene revision rebases from its own validated material while the separate hook is stale",
);
assert.equal(
  overrideDecision({ currentMaterialId: null, currentSceneRevision: 8, currentSceneBaseKey: null }),
  "use",
  "a pre-ACK unassigned scene must not discard the ACK base",
);
assert.equal(
  overrideDecision({ currentMaterialId: "mat:other", currentSceneRevision: 10, currentSceneBaseKey: null }),
  "discard",
  "a later authoritative scene with a conflicting material must discard the ACK base",
);
assert.equal(overrideDecision({ currentObjectId: "object:other" }), "discard");
assert.equal(overrideDecision({ currentScopeKey: "other-scope" }), "discard");

const identityKey = "scope:committed:object:one";
const afterAckState = {
  baseKey: assignmentBaseOverride.baseKey,
  dirty: false,
  draft: committedBase,
  identityKey,
};
const staleResourceResolution = inspectorDraftState.resolveInspectorDraftState({
  baseDraft: emptyBase,
  baseKey: "stale-base-key",
  identityKey,
  isDirty: model.magneticParametersDraftDirty,
  state: afterAckState,
});
assert.equal(staleResourceResolution.dirty, false, "the stale resource transition must not mark ACK values dirty");
const effectiveAckResolution = inspectorDraftState.resolveInspectorDraftState({
  baseDraft: assignmentBaseOverride.baseDraft,
  baseKey: assignmentBaseOverride.baseKey,
  identityKey,
  isDirty: model.magneticParametersDraftDirty,
  state: afterAckState,
});
assert.deepEqual(effectiveAckResolution, { dirty: false, draft: committedBase });
const editedAfterAckState = inspectorDraftState.updateInspectorDraftState({
  baseDraft: assignmentBaseOverride.baseDraft,
  baseKey: assignmentBaseOverride.baseKey,
  currentDraft: effectiveAckResolution.draft,
  identityKey,
  isDirty: model.magneticParametersDraftDirty,
  patch: { alpha: "0.2" },
});
const newerResourceDraft = model.rebaseMagneticParametersDraftAfterAssignment({
  previousBaseDraft: assignmentBaseOverride.baseDraft,
  draftAtStart: editedAfterAckState.draft,
  currentDraft: editedAfterAckState.draft,
  committedBaseDraft: newerSceneBase,
  startingRevisions: new Map(),
  currentRevisions: new Map(),
});
assert.equal(newerResourceDraft.alpha, "0.2", "a user edit made after ACK must survive resource catch-up");
assert.equal(newerResourceDraft.ms, newerSceneBase.ms, "a newer scene must replace untouched ACK values");
const newerResolved = inspectorDraftState.resolveInspectorDraftState({
  baseDraft: newerSceneBase,
  baseKey: newerSceneBaseKey,
  identityKey,
  isDirty: model.magneticParametersDraftDirty,
  state: {
    baseKey: newerSceneBaseKey,
    dirty: model.magneticParametersDraftDirty(newerResourceDraft, newerSceneBase),
    draft: newerResourceDraft,
    identityKey,
  },
});
assert.equal(newerResolved.dirty, true);
assert.equal(newerResolved.draft.alpha, "0.2");
for (const field of ["materialName", "materialRef", "ms", "aex", "dind", "dbulk"]) {
  assert.equal(newerResolved.draft[field], newerSceneBase[field], `${field} should remain on the newer scene base`);
}

const createDraft = {
  aex: "1.3e-11",
  alpha: "0.01",
  anisotropyAxis: ["0", "0", "1"],
  ku1: "",
  materialId: "mat:object",
  ms: "8e5",
  name: "Object material",
};
const createResponse = { committed_scene: assignedScene, scene_revision: 8 };
const successfulApi = {
  model: {
    async createMaterial() { return createResponse; },
    async patchObject() { return assignedScene; },
  },
};
const createdAndAssigned = await model.createMaterialThenAssign(
  successfulApi,
  "object:one",
  createDraft,
  7,
);
assert.equal(createdAndAssigned.deferredAnisotropy, null, "the default blank Ku1 is not a pending anisotropy edit");

const deferredDraft = { ...createDraft, ku1: "2.5e5" };
const deferredValidation = model.buildCreateMaterialDraft(deferredDraft);
assert.ok(!("error" in deferredValidation));
assert.equal(deferredValidation.value.anisotropy.ku1, 2.5e5);
const deferredAssignment = await model.createMaterialThenAssign(
  successfulApi,
  "object:one",
  deferredDraft,
  7,
);
assert.equal(deferredAssignment.deferredAnisotropy.ku1, 2.5e5, "a requested Ku1 remains a separate deferred draft");
assert.equal(
  model.magneticParametersDraftDirty(
    model.rebaseMagneticParametersDraftAfterAssignment({
      previousBaseDraft: emptyBase,
      draftAtStart: emptyBase,
      currentDraft: emptyBase,
      committedBaseDraft: committedBase,
      startingRevisions: new Map(),
      currentRevisions: new Map(),
    }),
    committedBase,
  ),
  false,
  "rebasing material parameters must not manufacture a second parameter draft",
);

const failedAssignmentApi = {
  model: {
    async createMaterial() { return createResponse; },
    async patchObject() { throw new Error("assignment rejected"); },
  },
};
let assignmentFailure;
try {
  await model.createMaterialThenAssign(failedAssignmentApi, "object:one", deferredDraft, 7);
  assert.fail("a rejected assignment must not produce a successful assigned result");
} catch (error) {
  assert.ok(error instanceof model.MaterialAssignmentAfterCreateError);
  assert.equal(error.deferredAnisotropy?.ku1, 2.5e5);
  assignmentFailure = error;
}
const retryScene = await assignmentFailure.retry(
  { model: { async patchObject() { return assignedScene; } } },
  9,
);
const retryCommittedBase = model.magneticParametersDraftFromSceneResource(
  assignmentFailure.materialId,
  retryScene,
);
assert.ok(retryCommittedBase, "a successful retry must expose the acknowledged assigned material");
const retryDraftRebase = model.rebaseMagneticParametersDraftAfterAssignment({
  previousBaseDraft: emptyBase,
  draftAtStart: emptyBase,
  currentDraft: emptyBase,
  committedBaseDraft: retryCommittedBase,
  startingRevisions: new Map(),
  currentRevisions: new Map(),
});
assert.equal(model.magneticParametersDraftDirty(retryDraftRebase, retryCommittedBase), false);

const panelSource = await readFile(panelPath, "utf8");
const createStart = panelSource.indexOf("async function createAndAssignMaterial");
const createRebase = panelSource.indexOf("rebaseAssignedMaterialDraft(", createStart);
const createCatch = panelSource.indexOf("} catch (error)", createStart);
assert.ok(createStart >= 0 && createRebase > createStart && createRebase < createCatch);
const createFailureBranch = panelSource.slice(createCatch, panelSource.indexOf("finally", createCatch));
assert.ok(!createFailureBranch.includes("rebaseAssignedMaterialDraft"),
  "material creation without assignment ACK must not rebase as if assigned");

const retryStart = panelSource.indexOf("async function retryFailedAssignment");
const retryRebase = panelSource.indexOf("rebaseAssignedMaterialDraft(", retryStart);
const retryCatch = panelSource.indexOf("} catch (error)", retryStart);
assert.ok(retryStart >= 0 && retryRebase > retryStart && retryRebase < retryCatch,
  "successful retry must use the same acknowledged material rebase");
const retryFailureBranch = panelSource.slice(retryCatch, panelSource.indexOf("finally", retryCatch));
assert.ok(!retryFailureBranch.includes("rebaseAssignedMaterialDraft"),
  "a failed retry must leave its draft unacknowledged");

const result = {
  schema: "fullmag.control-room.check-result.v1",
  check: "material-assignment-draft-reconciliation",
  status: "passed",
  cases: [
    "default-assignment-rebases-to-committed-values",
    "acknowledged-scene-material-validates-before-resource-key",
    "pre-existing-edits-survive",
    "in-flight-field-edit-survives",
    "explicit-zero-optional-field-survives",
    "blank-ku1-is-not-deferred",
    "explicit-ku1-remains-deferred",
    "failed-assignment-remains-retryable",
    "successful-retry-rebases",
    "failure-paths-do-not-acknowledge-draft",
    "stale-resource-does-not-create-false-dirty-state",
    "post-ack-user-edit-survives-resource-catch-up",
    "newer-resource-revision-releases-ack-base",
    "newer-scene-snapshot-wins-over-stale-material-hook",
    "old-unassigned-snapshot-retains-ack-until-confirmed-conflict",
    "scope-and-material-changes-discard-ack-base",
  ],
};

return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runMaterialAssignmentDraftCheck()));
}
