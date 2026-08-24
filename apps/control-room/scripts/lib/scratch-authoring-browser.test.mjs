import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import {
  assertScratchScene,
  buildScratchInteractionPatch,
  buildScratchMaterialTransaction,
  buildScratchObjectTransaction,
  buildScratchStudyPatch,
  buildScratchTextureTransaction,
  commandStatusKind,
  finiteSceneRevision,
  isExpectedScratchHttpError,
  publishedMeshRevision,
  sceneAuthoringSummary,
  scratchApiUrl,
  webglHealthFromCanvasRecords,
} from "./scratch-authoring-browser.mjs";

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/scratch-authoring",
);

async function fixture(name) {
  return JSON.parse(await readFile(resolve(fixtureRoot, name), "utf8"));
}

test("scratch fixture transactions preserve one optimistic scene revision chain", async () => {
  const fdm = await fixture("fdm.v1.json");
  assert.equal(finiteSceneRevision({ revision: 12 }), 12);
  assert.deepEqual(buildScratchObjectTransaction(fdm, 12), {
    kind: "create_object",
    base_revision: 12,
    object_id: "x-ferromagnet",
    name: "X ferromagnet",
    region_name: "x-ferromagnet",
    geometry: {
      geometry_kind: "Box",
      geometry_params: { size: [1.6e-7, 8e-8, 1.2e-8] },
    },
    transform: {
      rotation_quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
      translation: [0, 0, 0],
      pivot: [0, 0, 0],
    },
  });
  const materialTransaction = buildScratchMaterialTransaction(fdm, 13);
  assert.equal(materialTransaction.base_revision, 13);
  assert.deepEqual(materialTransaction.properties, {
    Ms: 1.1e6,
    Aex: 1.3e-11,
    alpha: 0.02,
    Dind: 0,
    Dbulk: 0,
  });
  assert.equal(buildScratchTextureTransaction(fdm, 14).kind, "patch_magnetization");
  const study = buildScratchStudyPatch(fdm, 15).merge_patch.study;
  assert.equal(study.fdm.per_magnet["x-ferromagnet"].cell[0], 4e-9);
  assert.equal(study.solver.fixed_timestep, "1e-13");
  assert.equal(study.stages[0].entrypoint_kind, "flat_relax");
  assert.equal(study.stages[0].max_steps, "8");
  assert.deepEqual(buildScratchInteractionPatch(16), {
    base_revision: 16,
    enabled: true,
    present: true,
    params: {},
  });
});

test("FEM scratch patch keeps universe and study mesh in canonical SceneDocument paths", async () => {
  const fem = await fixture("fem.v1.json");
  const patch = buildScratchStudyPatch(fem, 21);
  assert.deepEqual(patch.merge_patch.universe, fem.universe);
  assert.deepEqual(patch.merge_patch.study.universe_mesh, fem.universe);
  assert.deepEqual(patch.merge_patch.study.shared_domain_mesh, fem.mesh);
  assert.deepEqual(patch.merge_patch.study.mesh_defaults, fem.mesh);
  assert.equal(patch.merge_patch.study.shared_domain_mesh.maximum_element_size, "4e-8");
  assert.equal(patch.merge_patch.study.shared_domain_mesh.minimum_element_size, "1.2e-8");
  assert.equal(patch.merge_patch.study_universe_mesh, undefined);
});

test("scratch scene summary rejects missing authored physics", async () => {
  const fem = await fixture("fem.v1.json");
  const scene = {
      revision: 9,
      study: {
        requested_backend: "fem",
        exchange_enabled: true,
        demag_enabled: true,
        universe_mesh: fem.universe,
        shared_domain_mesh: fem.mesh,
        stages: [{ stage_id: "relax-scratch" }],
      },
      universe: fem.universe,
      objects: [
        {
          geometry: {
            geometry_kind: "Box",
            geometry_params: fem.object.geometry.params,
          },
          id: "x-ferromagnet",
          material_ref: fem.material.id,
          magnetization_ref: fem.texture.id,
          transform: { translation: fem.object.translation },
        },
      ],
      materials: [
        {
          id: fem.material.id,
          properties: {
            ms: fem.material.Ms,
            aex: fem.material.Aex,
            alpha: fem.material.alpha,
            dind: fem.material.Dind,
            dbulk: fem.material.Dbulk,
          },
        },
      ],
      magnetization_assets: [
        {
          id: fem.texture.id,
          preset_kind: fem.texture.preset_kind,
          preset_params: fem.texture.preset_params,
        },
      ],
    };
    assert.deepEqual(sceneAuthoringSummary(scene, fem), {
      revision: 9,
      object_id: "x-ferromagnet",
      material_ref: fem.material.id,
      magnetization_ref: fem.texture.id,
      geometry_kind: "Box",
      geometry_params: fem.object.geometry.params,
      translation: fem.object.translation,
      material_properties: {
        ms: fem.material.Ms,
        aex: fem.material.Aex,
        alpha: fem.material.alpha,
        dind: fem.material.Dind,
        dbulk: fem.material.Dbulk,
      },
      texture_preset_kind: fem.texture.preset_kind,
      texture_preset_params: fem.texture.preset_params,
      exchange_enabled: true,
      demag_enabled: true,
      stage_ids: ["relax-scratch"],
      fdm_grid: null,
      fem_mesh: fem.mesh,
      universe: fem.universe,
      backend: "fem",
    });
  assert.doesNotThrow(() => assertScratchScene(scene, fem));
  assert.throws(
    () => assertScratchScene({ ...scene, study: { ...scene.study, demag_enabled: false } }, fem),
    /demag/,
  );
});

test("WebGL qualification fails closed on lost or zero-size contexts", () => {
  assert.deepEqual(
    webglHealthFromCanvasRecords([
      { visible: true, contextLost: false, drawingBufferWidth: 640, drawingBufferHeight: 480 },
    ]),
    {
      visible_canvas_count: 1,
      healthy_canvas_count: 1,
      context_lost: false,
      drawing_buffer_nonzero: true,
      records: [
        { visible: true, contextLost: false, drawingBufferWidth: 640, drawingBufferHeight: 480 },
      ],
    },
  );
  const failed = webglHealthFromCanvasRecords([
    { visible: true, contextLost: true, drawingBufferWidth: 0, drawingBufferHeight: 0 },
  ]);
  assert.equal(failed.context_lost, true);
  assert.equal(failed.drawing_buffer_nonzero, false);
  const noCanvas = webglHealthFromCanvasRecords([]);
  assert.equal(noCanvas.visible_canvas_count, 0);
  assert.equal(noCanvas.drawing_buffer_nonzero, false);
});

test("API paths are resolved without silently switching away from the current session", () => {
  assert.equal(
    scratchApiUrl("http://127.0.0.1:8190", "/v2/sessions/current/model/scene"),
    "http://127.0.0.1:8190/v2/sessions/current/model/scene",
  );
});

test("browser smoke allowlists only known optional HTTP responses", () => {
  assert.equal(
    isExpectedScratchHttpError({
      status: 404,
      method: "GET",
      url: "http://127.0.0.1:8765/v2/sessions/current/simulation/preparation",
      body: "",
    }),
    true,
  );
  assert.equal(
    isExpectedScratchHttpError({
      status: 409,
      method: "POST",
      url: "http://127.0.0.1:8765/v2/sessions/current/simulation/commands",
      body: '{"reason":"session_completed_read_only"}',
    }),
    true,
  );
  assert.equal(
    isExpectedScratchHttpError({
      status: 409,
      method: "POST",
      url: "http://127.0.0.1:8765/v2/sessions/current/simulation/commands",
      body: '{"reason":"mesh_out_of_date"}',
    }),
    false,
  );
});

test("command evidence normalizes lifecycle and published mesh revisions", () => {
  assert.equal(commandStatusKind({ status: "running" }), "running");
  assert.equal(commandStatusKind({ status: "", completion_status: "completed" }), "completed");
  assert.equal(
    publishedMeshRevision({
      resource_invalidations: [
        { resource_key: "simulation/commands", revision: 4 },
        { resource_key: "meshing/shared-domain/manifest", revision: 9 },
      ],
    }),
    9,
  );
});
