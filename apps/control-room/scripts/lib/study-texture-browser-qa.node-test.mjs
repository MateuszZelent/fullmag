import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStageBUniformXResetTransaction,
  validateStageBUniformXResetExchange,
} from "./study-texture-browser-qa.mjs";

function baselineScene() {
  return {
    revision: 41,
    execution_profile: { id: "profile-fdm-cpu", future_profile_field: { keep: true } },
    objects: [
      { id: "film", name: "Film", role: "magnet", future_object_field: "retained" },
      { id: "air", name: "Air", role: "airbox" },
    ],
    study: {
      future_study_field: ["retain"],
      study_pipeline: {
        version: "study_pipeline.v2",
        future_pipeline_field: { retain: true },
        nodes: [{
          node_kind: "group",
          id: "ordered-relaxations",
          label: "Relaxations",
          future_group_field: { retained: true },
          children: [
            { node_kind: "primitive", id: "relax-a", stage_kind: "relax", label: "Relax A",
              payload: { stage_id: "relax-a", algorithm: "llg_overdamped", future_a: [1] } },
            { node_kind: "primitive", id: "relax-b", stage_kind: "relax", label: "Relax B",
              payload: { stage_id: "relax-b", algorithm: "projected_gradient_bb",
                magnetization_assignments: { schema_version: "fullmag.magnetization-assignments.v1",
                  assignments: [{ object_id: "film", region_id: null,
                    initializer: { kind: "uniform", direction: [1, 0, 0] } }] },
                future_b: { retained: true } } },
            { node_kind: "primitive", id: "relax-c", stage_kind: "relax", label: "Relax C",
              payload: { stage_id: "relax-c", algorithm: "nonlinear_cg", future_c: [3] } },
          ],
        }],
      },
    },
  };
}

function literalExpectedTransaction() {
  const scene = baselineScene();
  return {
    kind: "merge_patch",
    base_revision: 41,
    merge_patch: {
      study: {
        study_pipeline: {
          version: "study_pipeline.v2",
          future_pipeline_field: { retain: true },
          nodes: [{
            node_kind: "group",
            id: "ordered-relaxations",
            label: "Relaxations",
            future_group_field: { retained: true },
            children: [
              scene.study.study_pipeline.nodes[0].children[0],
              {
                ...scene.study.study_pipeline.nodes[0].children[1],
                payload: {
                  ...scene.study.study_pipeline.nodes[0].children[1].payload,
                  stage_magnetization_assignments: {
                    schema_version: "fullmag.magnetization-assignments.v1",
                    assignments: [{ object_id: "film", region_id: null, initializer: null }],
                  },
                },
              },
              scene.study.study_pipeline.nodes[0].children[2],
            ],
          }],
        },
      },
    },
  };
}

function successfulExchange({ scene = baselineScene(), mutateRequest, mutateAck } = {}) {
  const expected = literalExpectedTransaction();
  const body = structuredClone(expected);
  mutateRequest?.(body);
  const committedScene = structuredClone(scene);
  committedScene.revision = 42;
  committedScene.study.study_pipeline = structuredClone(expected.merge_patch.study.study_pipeline);
  mutateAck?.(committedScene);
  return {
    scene,
    sceneRevision: 41,
    statusSceneRevision: 41,
    objectId: "film",
    sessionScopeKey: "session=s1&epoch=e1&request_scope_epoch=api%3A1",
    writes: [{
      method: "POST",
      path: "/v2/sessions/current/model/transactions",
      headers: { "x-fullmag-session-scope": "session=s1&epoch=e1&request_scope_epoch=api%3A1" },
      body,
    }],
    acknowledgement: {
      status: 200,
      body: { transaction_kind: "merge_patch", scene_revision: 42, committed_scene: committedScene },
    },
  };
}

test("derives one B-local uniform-X reset and preserves the profile, pipeline, script event, and unknown fields", () => {
  const scene = baselineScene();
  const before = structuredClone(scene);
  const transaction = buildStageBUniformXResetTransaction({
    scene,
    sceneRevision: 41,
    statusSceneRevision: 41,
    objectId: "film",
  });

  assert.deepStrictEqual(transaction, literalExpectedTransaction());
  assert.deepStrictEqual(scene, before, "building the request must not mutate the baseline scene");
  const nodes = transaction.merge_patch.study.study_pipeline.nodes[0].children;
  assert.deepStrictEqual(nodes.map(({ id }) => id), ["relax-a", "relax-b", "relax-c"]);
  assert.equal(nodes[1].payload.algorithm, "projected_gradient_bb");
  assert.deepStrictEqual(nodes[1].payload.magnetization_assignments,
    before.study.study_pipeline?.nodes?.[0]?.children?.[1]?.payload?.magnetization_assignments);
});

test("rejects stale or mismatched revision before deriving a transaction", () => {
  assert.throws(() => buildStageBUniformXResetTransaction({
    scene: baselineScene(), sceneRevision: 41, statusSceneRevision: 40, objectId: "film",
  }), /revision/i);
  const exchange = successfulExchange();
  exchange.writes[0].body.base_revision = 40;
  assert.throws(() => validateStageBUniformXResetExchange(exchange), /request|transaction|revision/i);
});

test("accepts exactly one session-scoped, revision-fenced transaction and its committed scene ACK", () => {
  const exchange = successfulExchange();
  assert.deepStrictEqual(validateStageBUniformXResetExchange(exchange), {
    sceneRevision: 42,
    stageId: "relax-b",
    objectId: "film",
  });
});

test("rejects reset bound to A or C instead of B", () => {
  for (const wrongStageId of ["relax-a", "relax-c"]) {
    const exchange = successfulExchange({
      mutateRequest(body) {
        const children = body.merge_patch.study.study_pipeline.nodes[0].children;
        children.find((node) => node.id === wrongStageId).payload.stage_magnetization_assignments =
          children[1].payload.stage_magnetization_assignments;
        delete children[1].payload.stage_magnetization_assignments;
      },
    });
    assert.throws(() => validateStageBUniformXResetExchange(exchange), /stage|transaction|payload/i);
  }
});

test("rejects extra or non-reset assignments on B", () => {
  for (const mutateRequest of [
    (body) => body.merge_patch.study.study_pipeline.nodes[0].children[1]
      .payload.stage_magnetization_assignments.assignments.push({
        object_id: "film", region_id: "core", initializer: null,
      }),
    (body) => { body.merge_patch.study.study_pipeline.nodes[0].children[1]
      .payload.stage_magnetization_assignments.assignments[0].initializer = { kind: "uniform", direction: [1, 0, 0] }; },
  ]) {
    assert.throws(() => validateStageBUniformXResetExchange(successfulExchange({ mutateRequest })),
      /request|transaction|assignment|reset/i);
  }
});

test("rejects a reset bound to the wrong object or written as an independent script event", () => {
  const wrongObject = successfulExchange({
    mutateRequest(body) {
      body.merge_patch.study.study_pipeline.nodes[0].children[1]
        .payload.stage_magnetization_assignments.assignments[0].object_id = "air";
    },
  });
  assert.throws(() => validateStageBUniformXResetExchange(wrongObject), /request|transaction|object/i);

  const wrongBinding = successfulExchange({
    mutateRequest(body) {
      const payload = body.merge_patch.study.study_pipeline.nodes[0].children[1].payload;
      delete payload.stage_magnetization_assignments;
      payload.magnetization_assignments = {
        schema_version: "fullmag.magnetization-assignments.v1",
        assignments: [{ object_id: "film", region_id: null, initializer: null }],
      };
    },
  });
  assert.throws(() => validateStageBUniformXResetExchange(wrongBinding), /request|transaction|assignment/i);
});

test("rejects dropped unknown fields or edits to another stage in the request", () => {
  for (const mutateRequest of [
    (body) => { delete body.merge_patch.study.study_pipeline.future_pipeline_field; },
    (body) => { delete body.merge_patch.study.study_pipeline.nodes[0].children[0].payload.future_a; },
    (body) => { body.merge_patch.study.study_pipeline.nodes[0].children[2].payload.algorithm = "llg_overdamped"; },
  ]) {
    assert.throws(() => validateStageBUniformXResetExchange(successfulExchange({ mutateRequest })),
      /request|transaction|pipeline/i);
  }
});

test("rejects extra writes, wrong endpoint, or wrong session scope", () => {
  const extraWrite = successfulExchange();
  extraWrite.writes.push({ method: "POST", path: "/v2/sessions/current/model/apply_magnetization" });
  assert.throws(() => validateStageBUniformXResetExchange(extraWrite), /write/i);

  const wrongEndpoint = successfulExchange();
  wrongEndpoint.writes[0].path = "/v2/sessions/current/model/other";
  assert.throws(() => validateStageBUniformXResetExchange(wrongEndpoint), /endpoint|path/i);

  const wrongScope = successfulExchange();
  wrongScope.writes[0].headers["x-fullmag-session-scope"] = "session=other";
  assert.throws(() => validateStageBUniformXResetExchange(wrongScope), /scope/i);
});

test("rejects an ACK whose committed scene omits or changes any baseline field", () => {
  for (const mutateAck of [
    (scene) => { delete scene.execution_profile; },
    (scene) => { scene.study.study_pipeline.nodes[0].children[2].payload.future_c = [99]; },
    (scene) => { scene.study.study_pipeline.nodes[0].children[1].payload.stage_magnetization_assignments = {
      schema_version: "fullmag.magnetization-assignments.v1",
      assignments: [{ object_id: "air", region_id: null, initializer: null }],
    }; },
  ]) {
    assert.throws(() => validateStageBUniformXResetExchange(successfulExchange({ mutateAck })),
      /committed scene|ack|scope|scene/i);
  }
});

test("rejects a revision-fenced request whose normal HTTP ACK reports the wrong revision", () => {
  const exchange = successfulExchange();
  exchange.acknowledgement.body.scene_revision = 43;
  assert.throws(() => validateStageBUniformXResetExchange(exchange), /revision|ack/i);
});


test("rejects a transaction ACK for another mutation kind", () => {
  const exchange = successfulExchange();
  exchange.acknowledgement.body.transaction_kind = "patch_material";
  assert.throws(() => validateStageBUniformXResetExchange(exchange), /ACK|transaction/i);
});
