import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runMaterialAssignmentDraftCheck } from "./check-material-assignment-draft.mjs";

import {
  assignedMaterialParametersDraft,
  buildMaterialParametersPatch,
  magneticParametersDraftDirty,
  magneticParametersDraftFromResource,
} from "../src/modules/inspector/panels/ObjectMaterialPanelModel.ts";
import {
  resolveInspectorDraftState,
  updateInspectorDraftState,
} from "../src/modules/inspector/panels/inspectorDraftState.ts";

const material = {
  id: "mat:waveguide",
  name: "Waveguide",
  properties: { Aex: 1.3e-11, Ms: 800000, alpha: 0.02, Dind: null, Dbulk: null },
};
const scene = { revision: 23, materials: [material] };
const baseDraft = magneticParametersDraftFromResource("", null);
const committed = assignedMaterialParametersDraft(material.id, scene);
const transition = (patch) => resolveInspectorDraftState({
  baseDraft: committed,
  baseKey: "ack:23",
  identityKey: "object:waveguide",
  isDirty: magneticParametersDraftDirty,
  state: updateInspectorDraftState({
    baseDraft,
    baseKey: "before:21",
    currentDraft: baseDraft,
    identityKey: "object:waveguide",
    isDirty: magneticParametersDraftDirty,
    patch,
  }),
});

// Reproduce the old reference-only ACK before checking the repaired data path.
const legacy = transition({ materialRef: material.id });
assert.equal(legacy.dirty, true);
assert.equal(buildMaterialParametersPatch(legacy.draft).patch.properties.Aex, null);
assert.equal(buildMaterialParametersPatch(legacy.draft).patch.properties.Ms, null);

const acknowledged = transition(committed);
assert.equal(acknowledged.dirty, false);
assert.deepEqual(buildMaterialParametersPatch(acknowledged.draft).patch.properties, material.properties);

// A newer user edit stays dirty, without clearing the other acknowledged fields.
const edited = transition({ ...committed, alpha: "0.07" });
assert.equal(edited.dirty, true);
assert.deepEqual(buildMaterialParametersPatch(edited.draft).patch.properties, {
  ...material.properties, alpha: 0.07,
});

const retryScene = {
  revision: 25,
  materials: [{ ...material, properties: { ...material.properties, Aex: 2e-11 } }],
};
assert.equal(assignedMaterialParametersDraft(material.id, retryScene).aex, "2e-11");
assert.throws(() => assignedMaterialParametersDraft(material.id, { materials: [] }), /acknowledged scene/);

const panel = await readFile(new URL("../src/modules/inspector/panels/ObjectMaterialPanel.tsx", import.meta.url), "utf8");
assert.match(panel, /rebaseAssignedMaterialDraft\(\s*result\.materialId,\s*\[result\.assigned, result\.created\.committed_scene\]/);
assert.match(panel, /rebaseAssignedMaterialDraft\(\s*failure\.error\.materialId,\s*\[assigned, failure\.error\.created\.committed_scene\]/);
assert.doesNotMatch(panel, /mergeDraftPatch\(\{ materialRef:/);
assert.match(panel, /rebaseMagneticParametersDraftAfterAssignment\(\{[\s\S]*?startingRevisions,[\s\S]*?currentRevisions: draftFieldRevisionsRef\.current/);

// Execute the revision comparison independently; source guards below bind its
// reset ordering to the panel. This is not a React scheduling/lifecycle test.
const mergeAtRevisions = (current, patch, revisions, expected) => Object.fromEntries(
  Object.entries({ ...current, ...patch }).map(([field, value]) => [
    field,
    Object.hasOwn(patch, field) &&
      (revisions.get(field) ?? 0) !== (expected.get(field) ?? 0)
      ? current[field]
      : value,
  ]),
);
const legacyRevisions = new Map([["ms", 1]]);
const legacyExpected = new Map(legacyRevisions);
legacyRevisions.clear();
assert.equal(buildMaterialParametersPatch(
  mergeAtRevisions(baseDraft, committed, legacyRevisions, legacyExpected),
).patch.properties.Ms, null);

const revisions = new Map([["ms", 1], ["aex", 2]]);
// A -> B: reset before B's edits and its transaction snapshot.
revisions.clear();
revisions.set("aex", 1);
const expected = new Map(revisions);
revisions.set("alpha", 1);
const merged = mergeAtRevisions(
  { ...baseDraft, aex: "2e-11", alpha: "0.07" }, committed, revisions, expected,
);
assert.equal(merged.ms, "800000");
assert.equal(merged.aex, committed.aex);
assert.equal(merged.alpha, "0.07");
const scopeReset = panel.slice(
  panel.indexOf("if (scopeRef.current.key !== scopeKey)"),
  panel.indexOf("const scope = scopeRef.current;"),
);
assert.match(scopeReset, /draftFieldRevisionsRef\.current\.clear\(\)/);
assert.match(scopeReset, /anisotropyFieldRevisionsRef\.current\.clear\(\)/);
const startPending = panel.slice(panel.indexOf("function startPending("), panel.indexOf("function finishPending("));
assert.doesNotMatch(startPending, /RevisionsRef\.current\.clear/);
assert.match(panel, /scopeRef\.current\.token === scope\.token/);
assert.equal((await runMaterialAssignmentDraftCheck()).status, "passed");
console.log("PASS: legacy null-write and scope-reset counterexamples reproduced; full ACK, per-field merge, current retry ACK, missing asset rejection and reset ordering checked. Browser/React lifecycle NOT VERIFIED.");
