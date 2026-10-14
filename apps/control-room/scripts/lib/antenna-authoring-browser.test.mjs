import test from "node:test";
import assert from "node:assert/strict";

import {
  antennaExplorerNodeIds,
  assertAntennaScene,
} from "./antenna-authoring-browser.mjs";

test("assertAntennaScene resolves the authored conductor composition", () => {
  const resolved = assertAntennaScene({
    objects: [{ id: "antenna-1", role: "antenna" }],
    current_transports: [{ name: "antenna-1:current" }],
    antenna_port_modes: [{
      schema_version: "antenna_port_mode.v2",
      id: "antenna-1:port:common",
      source_object_id: "antenna-1",
      branches: [
        { id: "signal", inlet_terminal_ref: "signal_in", outlet_terminal_ref: "signal_out", signed_weight: 1 },
        { id: "return", inlet_terminal_ref: "return_in", outlet_terminal_ref: "return_out", signed_weight: -1 },
      ],
      current_transport_id: "antenna-1:current",
    }],
    antenna_field_solve_stages: [{
      id: "antenna-1:solve-field",
      source_object_id: "antenna-1",
      current_transport_id: "antenna-1:current",
      port_mode_ids: ["antenna-1:port:common"],
      outputs: [{ id: "antenna-1:field-solution", quantity: "H_ant_basis" }],
    }],
  });

  assert.deepEqual(resolved, {
    objectId: "antenna-1",
    portId: "antenna-1:port:common",
    stageId: "antenna-1:solve-field",
    outputId: "antenna-1:field-solution",
    transportId: "antenna-1:current",
  });
});

test("antennaExplorerNodeIds encodes resource ids without changing the object path", () => {
  assert.deepEqual(
    antennaExplorerNodeIds("antenna-1", "port/a", "solve:a"),
    {
      conductor: "model:object:antenna-1:antenna:conductor",
      port: "model:object:antenna-1:antenna:port:port%2Fa",
      solution: "model:object:antenna-1:antenna:solution:solve%3Aa",
    },
  );
});

test("assertAntennaScene rejects a stage without an H_ant_basis output", () => {
  assert.throws(
    () =>
      assertAntennaScene({
        objects: [{ id: "antenna-1", role: "antenna" }],
        antenna_port_modes: [{
          schema_version: "antenna_port_mode.v2",
          id: "port-1",
          source_object_id: "antenna-1",
          branches: [
            { id: "signal", inlet_terminal_ref: "signal_in", outlet_terminal_ref: "signal_out", signed_weight: 1 },
            { id: "return", inlet_terminal_ref: "return_in", outlet_terminal_ref: "return_out", signed_weight: -1 },
          ],
          current_transport_id: "current-1",
        }],
        antenna_field_solve_stages: [{
          id: "solve-1",
          source_object_id: "antenna-1",
          current_transport_id: "current-1",
          port_mode_ids: ["port-1"],
          outputs: [{ id: "other", quantity: "H_demag" }],
        }],
        current_transports: [{ id: "current-1" }],
      }),
    /H_ant_basis/,
  );
});

test("assertAntennaScene rejects an unbalanced microstrip preset", () => {
  assert.throws(
    () => assertAntennaScene({
      objects: [{ id: "antenna-1", role: "antenna" }],
      antenna_port_modes: [{
        schema_version: "antenna_port_mode.v2",
        id: "port-1",
        source_object_id: "antenna-1",
        branches: [
          { id: "signal", inlet_terminal_ref: "signal_in", outlet_terminal_ref: "signal_out", signed_weight: 1 },
          { id: "return", inlet_terminal_ref: "return_in", outlet_terminal_ref: "return_out", signed_weight: 1 },
        ],
      }],
    }),
    /balanced microstrip preset/,
  );
});

test("assertAntennaScene rejects a field solve linked to a different port", () => {
  assert.throws(
    () => assertAntennaScene({
      objects: [{ id: "antenna-1", role: "antenna" }],
      antenna_port_modes: [{
        schema_version: "antenna_port_mode.v2",
        id: "port-1",
        source_object_id: "antenna-1",
        current_transport_id: "current-1",
        branches: [
          { id: "signal", inlet_terminal_ref: "signal_in", outlet_terminal_ref: "signal_out", signed_weight: 1 },
          { id: "return", inlet_terminal_ref: "return_in", outlet_terminal_ref: "return_out", signed_weight: -1 },
        ],
      }],
      antenna_field_solve_stages: [{
        id: "solve-1",
        source_object_id: "antenna-1",
        current_transport_id: "current-1",
        port_mode_ids: ["other-port"],
        outputs: [{ id: "field-1", quantity: "H_ant_basis" }],
      }],
    }),
    /not linked to its port and transport/,
  );
});
