import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertCompletedTerminalFieldContract,
  assertCompletedTerminalTelemetry,
  assertInteractiveTerminalRun,
  terminalFieldRequestPath,
} from "./fdm-terminal-field-contract.mjs";
import { awaitTerminalFieldGeneration } from "./smoke-fdm-terminal-webgl-gate.mjs";

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
  assert.doesNotMatch(smokeSource, /getByText\(scope === "airbox" \? "Airbox" : objectId, \{ exact: true \}\)\.first\(\)/);
});
