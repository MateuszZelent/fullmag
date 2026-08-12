import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertCompletedTerminalFieldContract,
  assertCompletedTerminalTelemetry,
  terminalFieldRequestPath,
} from "./fdm-terminal-field-contract.mjs";

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

test("browser smoke forbids manual compute_fields and records screenshots", () => {
  assert.doesNotMatch(smokeSource, /kind\s*:\s*["']compute_fields["']/);
  assert.match(smokeSource, /screenshot\(/);
  assert.match(smokeSource, /assertCompletedTerminalFieldContract/);
  assert.match(smokeSource, /switchRibbonQuantity/);
  assert.match(smokeSource, /switchInspectorQuantity/);
  assert.match(smokeSource, /assertAirboxMagnetizationUnavailable/);
  assert.match(smokeSource, /assertCompletedTerminalTelemetry/);
});
