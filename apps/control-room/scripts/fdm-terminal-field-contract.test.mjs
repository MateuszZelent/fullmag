import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertCompletedTerminalFieldContract,
  assertCompletedTerminalTelemetry,
  assertInteractiveTerminalRun,
  terminalFieldRequestPath,
} from "./fdm-terminal-field-contract.mjs";
import {
  awaitTerminalFieldGeneration,
  exactVisualizationAdoptionMatches,
} from "./smoke-fdm-terminal-webgl-gate.mjs";

const smokeSource = await readFile(
  new URL("./smoke-fdm-terminal-webgl-gate.mjs", import.meta.url),
  "utf8",
);

const finalStep = 4;
const finalTime = 4e-13;

function terminalMetadata(quantityId, domain) {
  return {
    domain,
    domain_generation_id: { run_id: "fdm-terminal", sequence: 7 },
    quantity_id: quantityId,
    source_step: finalStep,
    source_time_seconds: finalTime,
    state: "complete",
  };
}

test("terminal FDM contract requires one completed generation for object and airbox fields", () => {
  const proof = assertCompletedTerminalFieldContract({
    catalog: {
      domain_generation_id: "fdm-terminal",
      quantities: [
        { available: true, domain: "full_domain", quantity_id: "H_demag" },
        { available: true, domain: "full_domain", quantity_id: "H_eff" },
        { available: true, domain: "full_domain", quantity_id: "H_ext" },
        { available: true, domain: "magnetic_only", quantity_id: "eden_demag" },
      ],
    },
    fields: {
      "airbox:H_demag": terminalMetadata("H_demag", "full_domain"),
      "airbox:H_eff": terminalMetadata("H_eff", "full_domain"),
      "object:H_demag": terminalMetadata("H_demag", "full_domain"),
      "object:H_eff": terminalMetadata("H_eff", "full_domain"),
      "object:H_ext": terminalMetadata("H_ext", "full_domain"),
      "object:eden_demag": terminalMetadata("eden_demag", "magnetic_only"),
    },
    finalStep,
    finalTime,
    stageExecution: { stages: [{ status: "completed", step: finalStep, time: finalTime }] },
  });

  assert.equal(proof.generation.run_id, "fdm-terminal");
  assert.equal(proof.generation.sequence, 7);
  assert.equal(proof.final_step, finalStep);
  assert.equal(proof.final_time, finalTime);
});

test("interactive terminal run requires completed-stage provenance before awaiting_command", () => {
  assert.deepEqual(
    assertInteractiveTerminalRun({
      run: { status: "awaiting_command", total_steps: finalStep, solver_time_seconds: finalTime },
      sessionStatus: { solver: { state: "awaiting_command" } },
      stageExecution: {
        runtime_state: "completed",
        active_stage_index: null,
        completed_stage_indexes: [0],
        stages: [{ index: 0, status: "completed" }],
      },
    }),
    { final_step: finalStep, final_time: finalTime },
  );

  assert.throws(
    () => assertInteractiveTerminalRun({
      run: { status: "awaiting_command", total_steps: finalStep, solver_time_seconds: finalTime },
      sessionStatus: { solver: { state: "awaiting_command" } },
      stageExecution: { runtime_state: "completed", active_stage_index: null, completed_stage_indexes: [], stages: [] },
    }),
    /completed terminal stage/,
  );
});

test("terminal FDM contract rejects a stale or cross-generation field", () => {
  const fields = {
    "airbox:H_demag": terminalMetadata("H_demag", "full_domain"),
    "airbox:H_eff": terminalMetadata("H_eff", "full_domain"),
    "object:H_demag": terminalMetadata("H_demag", "full_domain"),
    "object:H_eff": terminalMetadata("H_eff", "full_domain"),
    "object:H_ext": terminalMetadata("H_ext", "full_domain"),
    "object:eden_demag": terminalMetadata("eden_demag", "magnetic_only"),
  };
  fields["airbox:H_eff"] = {
    ...fields["airbox:H_eff"],
    source_step: finalStep - 1,
  };

  assert.throws(
    () =>
      assertCompletedTerminalFieldContract({
        catalog: { quantities: [
          { available: true, domain: "full_domain", quantity_id: "H_demag" },
          { available: true, domain: "full_domain", quantity_id: "H_eff" },
          { available: true, domain: "full_domain", quantity_id: "H_ext" },
          { available: true, domain: "magnetic_only", quantity_id: "eden_demag" },
        ] },
        fields,
        finalStep,
        finalTime,
        stageExecution: { status: "completed", step: finalStep, time: finalTime },
      }),
    /source_step/,
  );
});

test("terminal FDM contract rejects a field from a different solver time", () => {
  const fields = {
    "airbox:H_demag": terminalMetadata("H_demag", "full_domain"),
    "airbox:H_eff": terminalMetadata("H_eff", "full_domain"),
    "object:H_demag": terminalMetadata("H_demag", "full_domain"),
    "object:H_eff": terminalMetadata("H_eff", "full_domain"),
    "object:H_ext": terminalMetadata("H_ext", "full_domain"),
    "object:eden_demag": terminalMetadata("eden_demag", "magnetic_only"),
  };
  fields["object:H_eff"] = { ...fields["object:H_eff"], source_time_seconds: finalTime / 2 };

  assert.throws(
    () => assertCompletedTerminalFieldContract({
      catalog: { quantities: [
        { available: true, domain: "full_domain", quantity_id: "H_demag" },
        { available: true, domain: "full_domain", quantity_id: "H_eff" },
        { available: true, domain: "full_domain", quantity_id: "H_ext" },
        { available: true, domain: "magnetic_only", quantity_id: "eden_demag" },
      ] },
      fields,
      finalStep,
      finalTime,
      stageExecution: { status: "completed" },
    }),
    /source_time_seconds/,
  );
});

test("terminal field paths keep object and airbox scopes explicit", () => {
  assert.match(
    terminalFieldRequestPath("H_demag", { scopeId: "smoke_box", scopeKind: "object" }),
    /scope_kind=object/,
  );
  assert.match(
    terminalFieldRequestPath("H_eff", { scopeId: "airbox", scopeKind: "airbox" }),
    /scope_kind=airbox/,
  );
});

test("terminal FDM smoke retries a transient stale generation until coherent", async () => {
  const fields = Object.fromEntries([
    ["object:H_demag", terminalMetadata("H_demag", "full_domain")],
    ["object:H_eff", terminalMetadata("H_eff", "full_domain")],
    ["object:H_ext", terminalMetadata("H_ext", "full_domain")],
    ["object:eden_demag", terminalMetadata("eden_demag", "magnetic_only")],
    ["airbox:H_demag", terminalMetadata("H_demag", "full_domain")],
    ["airbox:H_eff", terminalMetadata("H_eff", "full_domain")],
  ]);
  let attempt = 0;
  const result = await awaitTerminalFieldGeneration({
    fieldEntries: Object.keys(fields).map((key) => key.split(":")),
    finalStep,
    finalTime,
    getJson: async (path) => {
      if (path.endsWith("/data/fields")) return { quantities: [
        { available: true, domain: "full_domain", quantity_id: "H_demag" },
        { available: true, domain: "full_domain", quantity_id: "H_eff" },
        { available: true, domain: "full_domain", quantity_id: "H_ext" },
        { available: true, domain: "magnetic_only", quantity_id: "eden_demag" },
      ] };
      if (attempt++ === 0) throw new Error("/meta: 404");
      const scope = new URL(path, "http://localhost").searchParams.get("scope_kind");
      const quantityId = path.match(/fields\/([^/]+)\/meta/)?.[1];
      return fields[`${scope === "airbox" ? "airbox" : "object"}:${quantityId}`];
    },
    poll: async (_label, probe) => {
      for (let index = 0; index < 3; index += 1) {
        const result = await probe();
        if (result) return result;
      }
      throw new Error("timed out");
    },
    scopes: { object: { scopeKind: "object", scopeId: "smoke_box" }, airbox: { scopeKind: "airbox", scopeId: "airbox" } },
    stageExecution: { stages: [{ status: "completed" }] },
    timeoutMs: 60_000,
  });
  assert.equal(result.terminal.final_time, finalTime);
});

test("terminal FDM smoke reports the last incoherent snapshot after timeout", async () => {
  await assert.rejects(
    awaitTerminalFieldGeneration({
      fieldEntries: [["object", "H_demag"]],
      finalStep,
      finalTime,
      getJson: async (path) => path.endsWith("/data/fields")
        ? { quantities: [] }
        : { source_step: 0, source_time_seconds: 0, state: "stale" },
      poll: async (_label, probe) => { await probe(); throw new Error("timed out"); },
      scopes: { object: { scopeKind: "object", scopeId: "smoke_box" } },
      stageExecution: { stages: [{ status: "completed" }] },
      timeoutMs: 60_000,
    }),
    /last incoherent snapshot|Terminal FDM field generation did not converge/,
  );
});

test("terminal telemetry requires final step/time, a positive dt, and nonzero average magnetization", () => {
  const telemetry = {
    objectMetrics: { has_solver_sample: true, step: finalStep, time_seconds: finalTime, magnetization_average: { mx: 0, my: 1, mz: 0 } },
    tableRows: { columns: ["step", "t", "dt", "mx", "my", "mz"].map((column_id) => ({ column_id })), rows: [[finalStep, finalTime, 1e-13, 0, 1, 0]] },
  };
  assert.equal(assertCompletedTerminalTelemetry({ finalStep, finalTime, ...telemetry }).solver_dt_seconds, 1e-13);
  assert.throws(
    () => assertCompletedTerminalTelemetry({ ...telemetry, finalStep, finalTime, tableRows: { ...telemetry.tableRows, rows: [[finalStep, finalTime, 0, 0, 1, 0]] } }),
    /dt/,
  );
});

test("browser smoke selects canonical Explorer visualization rows before using inspector quantities", () => {
  assert.doesNotMatch(smokeSource, /kind\s*:\s*["']compute_fields["']/);
  assert.match(smokeSource, /screenshot\(/);
  assert.match(smokeSource, /assertCompletedTerminalFieldContract/);
  assert.match(smokeSource, /terminal FDM field generation/);
  assert.match(smokeSource, /switchRibbonQuantity/);
  assert.match(smokeSource, /switchInspectorQuantity/);
  assert.match(smokeSource, /assertAirboxMagnetizationUnavailable/);
  assert.match(smokeSource, /assertCompletedTerminalTelemetry/);
  assert.match(smokeSource, /\/v2\/sessions\/current\/model\/scene/);
  assert.match(smokeSource, /model:object:\$\{sceneObject\.id\}:visualization/);
  assert.match(smokeSource, /model:airbox:visualization/);
  assert.match(smokeSource, /\[role="treeitem"\]\[data-node-id=/);
  assert.match(smokeSource, /aria-selected/);
  assert.match(smokeSource, /data-inspector-owner/);
  assert.match(smokeSource, /getByRole\("heading", \{ name: "Target", exact: true \}\)/);
  assert.match(smokeSource, /locator\('xpath=ancestor::section\[@data-slot="inspector-group"\]\[1\]'\)/);
  assert.doesNotMatch(smokeSource, /locator\('\[data-slot="inspector-group"\]', \{\s*has: inspector\.getByRole\("heading", \{ name: "Target", exact: true \}\)/s);
  assert.match(smokeSource, /Explorer \$\{target\.nodeId\} Target group/);
  assert.match(smokeSource, /Explorer \$\{target\.nodeId\} Target ID/);
  assert.match(smokeSource, /headings=.*owner/);
  assert.doesNotMatch(smokeSource, /getByText\(scope === "airbox" \? "Airbox" : objectId, \{ exact: true \}\)\.first\(\)/);
});

test("browser smoke proves local FDM quantity selection consumes a fresh 2xx field response", () => {
  const inspectorSwitchSource = smokeSource.slice(
    smokeSource.indexOf("async function switchInspectorQuantity"),
    smokeSource.indexOf("async function assertAirboxMagnetizationUnavailable"),
  );

  assert.doesNotMatch(inspectorSwitchSource, /\/visualization\/state/);
  assert.match(inspectorSwitchSource, /quantity\.inputValue\(\)/);
  assert.match(inspectorSwitchSource, /Toggle vector field arrows/);
  assert.match(inspectorSwitchSource, /aria-pressed/);
  assert.match(inspectorSwitchSource, /select\[aria-label="Color source"\]/);
  assert.match(inspectorSwitchSource, /inputValue\(\) === "colormap"/);
  assert.match(inspectorSwitchSource, /waitForScopedFieldResponse/);
  assert.match(smokeSource, /page\.on\("response"/);
  assert.match(smokeSource, /response\.status\(\)/);
  assert.match(smokeSource, /status >= 200 && status < 300/);
  assert.match(smokeSource, /scopeKind: scope === "object" \? "full" : "airbox"/);
  assert.match(smokeSource, /scope\.scopeKind === "full"/);
  assert.match(smokeSource, /url\.searchParams\.has\("scope_id"\)/);
  assert.match(smokeSource, /samples\/vector/);
});

test("browser smoke proves the exact completed response was adopted by the requested render pass", () => {
  assert.match(smokeSource, /await response\.finished\(\)/);
  assert.match(smokeSource, /selectExplorerVisualizationDebugTarget/);
  assert.match(smokeSource, /model:object:\$\{sceneObject\.id\}:visualization:debug/);
  assert.match(smokeSource, /model:airbox:visualization:debug/);
  assert.match(smokeSource, /waitForExactVisualizationDebugEvidence/);
  assert.match(smokeSource, /Raw bounded JSON/);
  assert.match(smokeSource, /requestedFieldBufferId/);
  assert.match(smokeSource, /adoptedFieldBufferId/);
  assert.match(smokeSource, /adoptedResourceKey/);
  assert.match(smokeSource, /adoptedScalarBufferKey/);
  assert.match(smokeSource, /adoptedVectorBuildKey/);
  assert.match(smokeSource, /adoptedVectorItemCount/);
  assert.match(smokeSource, /render\.vectors\.buildKey/);
  assert.match(smokeSource, /render\.surface\.bufferKey/);
  assert.match(smokeSource, /const renderPass = "surface"/);
  assert.match(smokeSource, /renderPass = quantityId === "eden_demag" \? "surface" : "vector-glyph"/);
  assert.match(smokeSource, /adoptionKindForRenderPass\(renderPass\)/);
});

test("browser smoke proves the FDM Airbox target has visible wireframe and vector geometry", () => {
  assert.match(smokeSource, /ensureFdmAirboxWireframe/);
  assert.match(smokeSource, /assertFdmAirboxVectorRender/);
  assert.match(smokeSource, /data-fdm-airbox-target/);
  assert.match(smokeSource, /data-fdm-airbox-wireframe-visible/);
  assert.match(smokeSource, /data-fdm-airbox-vectors-visible/);
  assert.match(smokeSource, /data-fdm-airbox-model-count/);
  assert.match(smokeSource, /data-fdm-airbox-vector-segment-count/);
  assert.match(smokeSource, /getByRole\("radio", \{\s*name: "Wireframe"/s);
  assert.match(smokeSource, /getByRole\("button", \{\s*name: "Toggle target visibility"/s);
  assert.match(smokeSource, /airbox_magnetization: airboxMagnetization, airbox_display: airboxDisplay, airbox_render: airboxRender/);
  assert.match(smokeSource, /airbox_controls: airboxControls/);
  assert.match(smokeSource, /getByRole\("button", \{ name: "Focus", exact: true \}\)/);
});

test("browser smoke rejects historical adoption for a repeated resource key", () => {
  const ribbonSwitchSource = smokeSource.slice(
    smokeSource.indexOf("async function switchRibbonQuantity"),
    smokeSource.indexOf("async function switchInspectorQuantity"),
  );
  const inspectorSwitchSource = smokeSource.slice(
    smokeSource.indexOf("async function switchInspectorQuantity"),
    smokeSource.indexOf("async function assertAirboxMagnetizationUnavailable"),
  );
  const adoptionSource = smokeSource.slice(
    smokeSource.indexOf("async function waitForExactVisualizationDebugEvidence"),
    smokeSource.indexOf("function findExactVisualizationDebugObservation"),
  );
  const exactObservationSource = smokeSource.slice(
    smokeSource.indexOf("function findExactVisualizationDebugObservation"),
    smokeSource.indexOf("async function waitForScopedFieldResponse"),
  );

  assert.match(ribbonSwitchSource, /captureLatestExactVisualizationAdoption/);
  assert.match(inspectorSwitchSource, /captureLatestExactVisualizationAdoption/);
  assert.match(smokeSource, /Date\.now\(\)/);
  assert.match(smokeSource, /response_started_at_ms/);
  assert.match(smokeSource, /response_body_started_at_ms/);
  assert.match(smokeSource, /response_finished_at_ms/);
  assert.match(smokeSource, /pre_switch_adoption_sequence/);
  assert.match(adoptionSource, /exactVisualizationAdoptionMatches/);
  assert.match(smokeSource, /passAdoption\.adoptionSequence\s*<=\s*\(preSwitchAdoptionSequence \?\? 0\)/);
  assert.match(smokeSource, /Math\.max\(switchStartedAtMs, response\.response_started_at_ms\)/);
  assert.doesNotMatch(smokeSource, /adoptedAtMs\s*<\s*response\.response_finished_at_ms/);
  assert.match(exactObservationSource, /passAdoption[\s\S]*latestPassAdoption/);
  assert.match(exactObservationSource, /return latest/);
});

function exactAdoptionFixture() {
  const resourceKey = "/v2/sessions/current/data/fields/H_demag/samples/vector?scope_kind=full";
  return {
    observation: {
      carrier: {
        cache: { dataIdentityMatches: true, etag: '"etag-8"' },
        render: {
          adoption: {
            frameCommitId: "frame-new",
            surface: {
              adoptedAtMs: null,
              adoptedFieldBufferId: null,
              adoptedResourceKey: null,
              adoptedScalarBufferKey: null,
              adoptionSequence: null,
            },
            vector: {
              adoptedAtMs: 2_025,
              adoptedFieldBufferId: "buffer-8",
              adoptedResourceKey: resourceKey,
              adoptedVectorBuildKey: "vector-8",
              adoptedVectorItemCount: 8,
              adoptionSequence: 8,
            },
          },
          requestedFieldBufferId: "buffer-8",
          requestedPasses: ["vector-glyph"],
          surface: { bufferKey: null },
          vectors: { buildKey: "vector-8" },
        },
        request: { resourceKey },
        revisions: {
          domainGenerationId: "generation-8",
          fieldRevision: "8",
          meshTopologyHash: "mesh-8",
        },
      },
      snapshot: { capturedAtMs: 9_999, viewport: { frameCommitId: "frame-new" } },
    },
    preSwitchAdoptionSequence: 7,
    quantityId: "H_demag",
    response: {
      domain_generation_id: "generation-8",
      etag: '"etag-8"',
      field_revision: "8",
      mesh_topology_hash: "mesh-8",
      resource_key: resourceKey,
      response_body_started_at_ms: 2_040,
      response_finished_at_ms: 2_050,
      response_started_at_ms: 2_010,
    },
    switchStartedAtMs: 2_000,
  };
}

test("exact render evidence accepts a new adoption bound to response headers", () => {
  assert.equal(exactVisualizationAdoptionMatches(exactAdoptionFixture()), true);
});

test("exact render evidence rejects cache data that does not match the adopted carrier", () => {
  const fixture = exactAdoptionFixture();
  fixture.observation.carrier.cache.dataIdentityMatches = false;
  assert.equal(exactVisualizationAdoptionMatches(fixture), false);
});

test("exact render evidence accepts a fast valid adoption before body observation finishes", () => {
  const fixture = exactAdoptionFixture();
  fixture.observation.carrier.render.adoption.vector.adoptedAtMs = 2_015;
  fixture.response.response_body_started_at_ms = 2_040;
  fixture.response.response_finished_at_ms = 2_050;
  assert.equal(exactVisualizationAdoptionMatches(fixture), true);
});

test("exact render evidence rejects an adoption from before the switch response", () => {
  const fixture = exactAdoptionFixture();
  fixture.observation.carrier.render.adoption.vector.adoptedAtMs = 2_005;
  assert.equal(exactVisualizationAdoptionMatches(fixture), false);
});

test("exact render evidence rejects a historical adoption republished in a new frame", () => {
  const fixture = exactAdoptionFixture();
  fixture.observation.snapshot = {
    capturedAtMs: 20_000,
    viewport: { frameCommitId: "frame-even-newer" },
  };
  fixture.observation.carrier.render.adoption.vector.adoptionSequence = 7;
  assert.equal(exactVisualizationAdoptionMatches(fixture), false);
});

test("exact surface evidence cannot borrow freshness from a newer vector pass", () => {
  const fixture = exactAdoptionFixture();
  fixture.quantityId = "eden_demag";
  fixture.observation.carrier.render.requestedPasses = ["surface", "vector-glyph"];
  fixture.observation.carrier.render.surface.bufferKey = "scalar-8";
  fixture.observation.carrier.render.adoption.surface = {
    adoptedAtMs: 1_900,
    adoptedFieldBufferId: "buffer-8",
    adoptedResourceKey: fixture.response.resource_key,
    adoptedScalarBufferKey: "scalar-8",
    adoptionSequence: 6,
  };
  assert.equal(exactVisualizationAdoptionMatches(fixture), false);
});

test("exact render evidence rejects mismatched response revision carriers", () => {
  for (const [key, value] of [
    ["etag", '"wrong"'],
    ["field_revision", "9"],
    ["domain_generation_id", "generation-9"],
    ["mesh_topology_hash", "mesh-9"],
  ]) {
    const fixture = exactAdoptionFixture();
    fixture.response[key] = value;
    assert.equal(exactVisualizationAdoptionMatches(fixture), false, key);
  }
});

test("browser smoke rechecks WebGL health after the last field response before evidence capture", () => {
  const finalSwitch = smokeSource.indexOf('setPhase("airbox-field-switches")');
  const postSwitchHealth = smokeSource.indexOf(
    'assertCanvasHealth(canvas, "after final field response")',
  );
  const screenshotPhase = smokeSource.indexOf('setPhase("screenshot")');

  assert.ok(finalSwitch >= 0, "final field switch phase must exist");
  assert.ok(postSwitchHealth > finalSwitch, "WebGL health must be rechecked after final field switching");
  assert.ok(screenshotPhase > postSwitchHealth, "WebGL health must be rechecked immediately before evidence capture");
  assert.match(smokeSource, /!.*visible|visible.*is_context_lost/s);
  assert.match(smokeSource, /is_context_lost/);
  assert.match(smokeSource, /drawing_buffer.*value.*<= 0/s);
});
