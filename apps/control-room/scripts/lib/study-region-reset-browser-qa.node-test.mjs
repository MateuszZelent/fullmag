import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStageBEnabledTransaction,
  buildStageBRegionObjectTextureResetTransaction,
  fillStageBRegionObjectTextureResetInInspector,
  saveStageBStudyChangeAndWaitForAck,
  setStageBStudyInclusionInInspector,
  validateStageBEnabledExchange,
  validateStageBRegionObjectTextureResetExchange,
} from "./study-region-reset-browser-qa.mjs";

const scopeKey = "session=s1&epoch=e1&request_scope_epoch=api%3A1";
const transactionPath = "/v2/sessions/current/model/transactions";
const assignmentSchema = "fullmag.magnetization-assignments.v1";
const stageNodeId = "model:study:stages:stage:relax-b";

function baselineScene() {
  return {
    revision: 41,
    execution_profile: { id: "profile-fdm-cpu", future_profile_field: { keep: true } },
    objects: [
      { id: "film", name: "Film", role: "magnet", future_object_field: "retained", regions: [
        { region_id: "left-half", name: "Left half", enabled: true,
          shape: { kind: "box", size: [1, 1, 1] }, future_region_field: { keep: 1 } },
        { region_id: "right-half", name: "Right half", enabled: true,
          shape: { kind: "box", size: [1, 1, 1] } },
      ] },
      { id: "air", name: "Air", role: "airbox", regions: [
        { region_id: "left-half", name: "Not a film region", enabled: true },
      ] },
    ],
    study: {
      future_study_field: ["retain"],
      study_pipeline: {
        version: "study_pipeline.v2",
        future_pipeline_field: { retain: true },
        nodes: [{ node_kind: "group", id: "study-root", label: "Study root", enabled: true,
          future_root_field: { retained: true }, children: [
          { node_kind: "primitive", id: "before", stage_kind: "autosave", label: "Before",
            payload: { stage_id: "before", interval: 3, future_before: { keep: true } } },
          { node_kind: "group", id: "ordered-relaxations", label: "Relaxations", enabled: true,
            future_group_field: { retained: true }, children: [
              { node_kind: "primitive", id: "relax-a", stage_kind: "relax", label: "Relax A",
                payload: { stage_id: "relax-a", algorithm: "llg_overdamped", future_a: [1] } },
              { node_kind: "primitive", id: "relax-b", stage_kind: "relax", label: "Relax B",
                payload: { stage_id: "relax-b", algorithm: "projected_gradient_bb",
                  magnetization_assignments: { schema_version: assignmentSchema,
                    assignments: [{ object_id: "film", region_id: null,
                      initializer: { kind: "uniform", direction: [1, 0, 0] } }] },
                  future_b: { retain: ["all"] } } },
              { node_kind: "primitive", id: "relax-c", stage_kind: "relax", label: "Relax C",
                payload: { stage_id: "relax-c", algorithm: "nonlinear_cg", future_c: [3] } },
            ] },
          { node_kind: "primitive", id: "after", stage_kind: "autosave", label: "After",
            payload: { stage_id: "after", interval: 9, future_after: { keep: true } } },
        ] }],
      },
    },
  };
}

function visitNodes(nodes, predicate) {
  for (const node of nodes) {
    if (predicate(node)) return node;
    if (node.node_kind === "group") {
      const found = visitNodes(node.children ?? [], predicate);
      if (found) return found;
    }
  }
  return null;
}

function stageB(scene) {
  return visitNodes(scene.study.study_pipeline.nodes, (node) => node.id === "relax-b");
}

function literalRegionTransaction(scene = baselineScene()) {
  const pipeline = structuredClone(scene.study.study_pipeline);
  const node = visitNodes(pipeline.nodes, (candidate) => candidate.id === "relax-b");
  node.payload.stage_magnetization_assignments = {
    schema_version: assignmentSchema,
    assignments: [{ object_id: "film", region_id: "left-half", initializer: null }],
  };
  pipeline.version = "study_pipeline.v2";
  return { kind: "merge_patch", base_revision: 41, merge_patch: { study: { study_pipeline: pipeline } } };
}

function literalEnabledTransaction(scene, enabled) {
  const pipeline = structuredClone(scene.study.study_pipeline);
  const node = visitNodes(pipeline.nodes, (candidate) => candidate.id === "relax-b");
  node.enabled = enabled;
  return {
    kind: "merge_patch",
    base_revision: scene.revision,
    merge_patch: { study: { study_pipeline: pipeline } },
  };
}

function exchangeFor({ scene, transaction, mutateCommittedScene, mutateBody, extraWrites = [] }) {
  const requestBody = structuredClone(transaction);
  mutateBody?.(requestBody);
  const committedScene = structuredClone(scene);
  committedScene.revision = scene.revision + 1;
  committedScene.study.study_pipeline = structuredClone(transaction.merge_patch.study.study_pipeline);
  mutateCommittedScene?.(committedScene);
  return {
    scene,
    sceneRevision: scene.revision,
    statusSceneRevision: scene.revision,
    sessionScopeKey: scopeKey,
    writes: [{ method: "POST", path: transactionPath,
      headers: { "x-fullmag-session-scope": scopeKey }, body: requestBody }, ...extraWrites],
    acknowledgement: { status: 200, body: {
      transaction_kind: "merge_patch", scene_revision: scene.revision + 1, committed_scene: committedScene,
    } },
  };
}

function regionExchange(options = {}) {
  const scene = options.scene ?? baselineScene();
  return exchangeFor({ ...options, scene, transaction: literalRegionTransaction(scene) });
}

function enabledExchange({ enabled, scene = baselineScene(), ...options }) {
  return { ...exchangeFor({ ...options, scene, transaction: literalEnabledTransaction(scene, enabled) }), enabled };
}

test("builds the exact left-half object-texture reset and preserves nested groups, payloads, and input", () => {
  const scene = baselineScene();
  const before = structuredClone(scene);
  const transaction = buildStageBRegionObjectTextureResetTransaction({
    scene, sceneRevision: 41, statusSceneRevision: 41,
  });

  assert.deepStrictEqual(transaction, literalRegionTransaction(scene));
  assert.deepStrictEqual(scene, before, "building the request must not mutate the baseline scene");
  const assignment = stageB({ study: { study_pipeline: transaction.merge_patch.study.study_pipeline } })
    .payload.stage_magnetization_assignments.assignments[0];
  assert.deepStrictEqual(assignment, { object_id: "film", region_id: "left-half", initializer: null });
  assert.deepStrictEqual(transaction.merge_patch.study.study_pipeline.nodes[0].children[1].children.map(({ id }) => id),
    ["relax-a", "relax-b", "relax-c"]);
  assert.deepStrictEqual(transaction.merge_patch.study.study_pipeline.nodes[0].children[1].future_group_field,
    { retained: true });
});

test("rejects missing, disabled, duplicate, or wrong-owner left-half regions and duplicate magnets", () => {
  const mutations = [
    (scene) => { scene.objects[0].regions = scene.objects[0].regions.filter(({ region_id }) => region_id !== "left-half"); },
    (scene) => { scene.objects[0].regions[0].enabled = false; },
    (scene) => { scene.objects[0].regions.push(structuredClone(scene.objects[0].regions[0])); },
    (scene) => { scene.objects[0].regions[0].enabled = "yes"; },
    (scene) => {
      scene.objects[0].regions = scene.objects[0].regions.filter(({ region_id }) => region_id !== "left-half");
      scene.objects[1].role = "magnet";
    },
    (scene) => { scene.objects.push(structuredClone(scene.objects[0])); },
  ];
  for (const mutate of mutations) {
    const scene = baselineScene();
    mutate(scene);
    assert.throws(() => buildStageBRegionObjectTextureResetTransaction({ scene }), /region|magnetic object|film/i);
  }
});

test("refuses to replace a pre-existing Stage B local recipe", () => {
  const scene = baselineScene();
  stageB(scene).payload.stage_magnetization_assignments = {
    schema_version: assignmentSchema,
    assignments: [{ object_id: "film", region_id: "right-half", initializer: null }],
  };
  assert.throws(() => buildStageBRegionObjectTextureResetTransaction({ scene }), /already has|local texture/i);
});

test("rejects duplicate and non-ordered canonical A to B to C stages", () => {
  const duplicate = baselineScene();
  const group = duplicate.study.study_pipeline.nodes[0].children[1];
  group.children.push(structuredClone(group.children[1]));
  assert.throws(() => buildStageBRegionObjectTextureResetTransaction({ scene: duplicate }), /exactly one|stage relax-b|duplicate node ID/i);
  assert.throws(() => buildStageBEnabledTransaction({ scene: duplicate, enabled: false }), /exactly one|stage relax-b|duplicate node ID/i);

  const unordered = baselineScene();
  const unorderedGroup = unordered.study.study_pipeline.nodes[0].children[1];
  [unorderedGroup.children[0], unorderedGroup.children[1]] = [unorderedGroup.children[1], unorderedGroup.children[0]];
  assert.throws(() => buildStageBRegionObjectTextureResetTransaction({ scene: unordered }), /order/i);
  assert.throws(() => buildStageBEnabledTransaction({ scene: unordered, enabled: false }), /order/i);
});

test("rejects a group and primitive reusing the same Stage B node ID", () => {
  const scene = baselineScene();
  scene.study.study_pipeline.nodes[0].children.unshift({
    node_kind: "group", id: "relax-b", children: [],
  });
  assert.throws(() => buildStageBEnabledTransaction({ scene, enabled: false }), /duplicate node ID/i);
  assert.throws(() => buildStageBRegionObjectTextureResetTransaction({ scene }), /duplicate node ID/i);
});

test("builds enable and disable transactions while preserving an existing local assignment", () => {
  const scene = baselineScene();
  const localAssignment = {
    schema_version: assignmentSchema,
    assignments: [{ object_id: "film", region_id: "left-half", initializer: null }],
  };
  stageB(scene).payload.stage_magnetization_assignments = structuredClone(localAssignment);
  const before = structuredClone(scene);
  const disabled = buildStageBEnabledTransaction({ scene, enabled: false });
  assert.deepStrictEqual(disabled, literalEnabledTransaction(scene, false));
  assert.deepStrictEqual(scene, before, "building the request must not mutate the scene");
  const disabledScene = structuredClone(scene);
  disabledScene.revision += 1;
  disabledScene.study.study_pipeline = structuredClone(disabled.merge_patch.study.study_pipeline);
  const enabled = buildStageBEnabledTransaction({ scene: disabledScene, enabled: true });
  assert.deepStrictEqual(enabled, literalEnabledTransaction(disabledScene, true));
  assert.deepStrictEqual(stageB({ study: { study_pipeline: enabled.merge_patch.study.study_pipeline } })
    .payload.stage_magnetization_assignments, localAssignment);
  assert.equal(stageB({ study: { study_pipeline: enabled.merge_patch.study.study_pipeline } }).enabled, true);
});

test("rejects a disabled ancestor and no-op enable or disable saves", () => {
  const disabledAncestor = baselineScene();
  disabledAncestor.study.study_pipeline.nodes[0].enabled = false;
  for (const enabled of [true, false]) {
    assert.throws(() => buildStageBEnabledTransaction({ scene: disabledAncestor, enabled }), /ancestor|parent group/i);
  }
  const alreadyEnabled = baselineScene();
  assert.throws(() => buildStageBEnabledTransaction({ scene: alreadyEnabled, enabled: true }), /no-op|already enabled/i);
  stageB(alreadyEnabled).enabled = false;
  assert.throws(() => buildStageBEnabledTransaction({ scene: alreadyEnabled, enabled: false }), /no-op|already disabled/i);
});

test("accepts exactly one scoped region save with revision plus one and the exact committed scene", () => {
  assert.deepStrictEqual(validateStageBRegionObjectTextureResetExchange(regionExchange()), {
    sceneRevision: 42, stageId: "relax-b", objectId: "film", regionId: "left-half",
  });
});

test("accepts exactly one scoped enable or disable save and preserves a local recipe", () => {
  const scene = baselineScene();
  stageB(scene).payload.stage_magnetization_assignments = {
    schema_version: assignmentSchema,
    assignments: [{ object_id: "film", region_id: "left-half", initializer: null }],
  };
  assert.deepStrictEqual(validateStageBEnabledExchange(enabledExchange({ scene, enabled: false })), {
    sceneRevision: 42, stageId: "relax-b", enabled: false,
  });
});

test("rejects stale revisions, extra writes, wrong scope, wrong target, and ACK drift for region saves", () => {
  const staleRevision = regionExchange();
  staleRevision.writes[0].body.base_revision = 40;
  assert.throws(() => validateStageBRegionObjectTextureResetExchange(staleRevision), /request|revision|transaction/i);

  const extraWrite = regionExchange({ extraWrites: [{ method: "POST", path: "/unrelated", body: {} }] });
  assert.throws(() => validateStageBRegionObjectTextureResetExchange(extraWrite), /exactly one|write/i);

  const wrongScope = regionExchange();
  wrongScope.writes[0].headers["x-fullmag-session-scope"] = "session=other";
  assert.throws(() => validateStageBRegionObjectTextureResetExchange(wrongScope), /scope/i);

  const wrongTarget = regionExchange({ mutateBody(body) {
    const nodes = body.merge_patch.study.study_pipeline.nodes[0].children[1].children;
    nodes[0].payload.stage_magnetization_assignments = nodes[1].payload.stage_magnetization_assignments;
    delete nodes[1].payload.stage_magnetization_assignments;
  } });
  assert.throws(() => validateStageBRegionObjectTextureResetExchange(wrongTarget), /request|transaction|pipeline/i);

  const ackDrift = regionExchange({ mutateCommittedScene(committed) {
    committed.study.study_pipeline.nodes[0].children[1].children[2].payload.future_c.push(99);
  } });
  assert.throws(() => validateStageBRegionObjectTextureResetExchange(ackDrift), /committed scene|ACK|scope/i);
});

test("rejects wrong status revision, wrong ACK revision, and unrelated toggle changes", () => {
  const wrongStatus = enabledExchange({ enabled: false });
  wrongStatus.statusSceneRevision -= 1;
  assert.throws(() => validateStageBEnabledExchange(wrongStatus), /revision/i);

  const wrongAck = enabledExchange({ enabled: false });
  wrongAck.acknowledgement.body.scene_revision += 1;
  assert.throws(() => validateStageBEnabledExchange(wrongAck), /revision|ACK/i);

  const unrelated = enabledExchange({ enabled: false, mutateCommittedScene(committed) {
    committed.objects[0].name = "Changed outside Stage B";
  } });
  assert.throws(() => validateStageBEnabledExchange(unrelated), /committed scene|ACK|scope/i);
});

test("selects the exact Stage B region reset controls through ordinary browser interactions", async () => {
  const selected = [];
  const clicked = [];
  const row = { click: async () => clicked.push("Stage B"), waitFor: async () => {},
    getAttribute: async (name) => name === "role" ? "treeitem" : "true" };
  const page = {
    locator: (selector) => { assert.equal(selector, `[data-node-id="${stageNodeId}"]`); return row; },
    getByRole: (role, { name, exact }) => {
      assert.equal(exact, true);
      if (role === "combobox") return { selectOption: async (value) => selected.push([name, value]) };
      assert.equal(role, "button");
      return { click: async () => clicked.push(name) };
    },
  };
  await fillStageBRegionObjectTextureResetInInspector(page);
  assert.deepStrictEqual(selected, [
    ["Magnetic object", "film"],
    ["Apply to", "left-half"],
    ["Texture", { label: "Use object texture" }],
  ]);
  assert.deepStrictEqual(clicked, ["Stage B", "Add texture change", "Add to stage"]);
});

test("sets the Stage B Study checkbox through a click and verifies the requested state", async () => {
  let checked = true;
  let clicks = 0;
  const row = { click: async () => {}, waitFor: async () => {},
    getAttribute: async (name) => name === "role" ? "treeitem" : "true" };
  const checkbox = { waitFor: async () => {}, isChecked: async () => checked,
    click: async () => { checked = !checked; clicks += 1; } };
  const page = {
    locator: () => row,
    getByRole: (role, { name, exact }) => {
      assert.equal(exact, true);
      assert.equal(role, "checkbox");
      assert.equal(name, "Include this stage in Study");
      return checkbox;
    },
  };
  await setStageBStudyInclusionInInspector(page, { enabled: false });
  assert.equal(checked, false);
  assert.equal(clicks, 1);
  await setStageBStudyInclusionInInspector(page, { enabled: false });
  assert.equal(clicks, 1, "already-correct state should not cause a second UI change");
});

test("clicks Save stage and waits for the exact Stage B saved ACK", async () => {
  const actions = [];
  const row = { click: async () => {}, waitFor: async () => {},
    getAttribute: async (name) => name === "role" ? "treeitem" : "true" };
  const response = {
    request: () => ({ method: () => "POST" }),
    url: () => `http://control-room${transactionPath}`,
    status: () => 200,
    json: async () => ({ transaction_kind: "merge_patch", scene_revision: 42 }),
  };
  const page = {
    locator: () => row,
    waitForResponse: async (predicate, options) => {
      assert.equal(options.timeout, 10_000);
      assert.equal(predicate(response), true);
      return response;
    },
    getByRole: (role, { name, exact }) => ({ click: async () => {
      assert.equal(role, "button");
      assert.equal(exact, true);
      assert.equal(name, "Save stage");
      actions.push("save clicked");
    } }),
    getByText: (text, { exact }) => ({ waitFor: async ({ state, timeout }) => {
      assert.equal(text, "Saved stage relax-b.");
      assert.equal(exact, true);
      assert.equal(state, "visible");
      assert.equal(timeout, 10_000);
      actions.push("saved ACK visible");
    } }),
  };
  assert.deepStrictEqual(await saveStageBStudyChangeAndWaitForAck(page, { timeout: 10_000 }), {
    status: 200, body: { transaction_kind: "merge_patch", scene_revision: 42 },
  });
  assert.deepStrictEqual(actions, ["save clicked", "saved ACK visible"]);
});
