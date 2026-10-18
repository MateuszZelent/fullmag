import { describe, expect, it } from "vitest";

import type { SceneResource } from "@/kernel/api/apiTypes";

import { antennaStageValidationMessages } from "./antennaStageValidation";

const stage = {
  id: "solve-1",
  source_object_id: "antenna-1",
  current_transport_id: "current-1",
  port_mode_ids: ["port-1"],
  target_refs: [{ kind: "global" }],
  outputs: [{ id: "basis-1", quantity: "H_ant_basis" }],
} as NonNullable<SceneResource["antenna_field_solve_stages"]>[number];

describe("antenna field-solve authoring validation", () => {
  it("rejects an empty target list without inventing a target", () => {
    const empty = { ...stage, target_refs: [] };
    expect(antennaStageValidationMessages(empty, null)).toEqual([
      "field solve requires at least one explicitly authored target",
    ]);
    expect(empty.target_refs).toEqual([]);
  });
  it("reports absent transport and port collections in a loaded scene", () => {
    expect(antennaStageValidationMessages(stage, {} as SceneResource)).toEqual([
      "missing current transport 'current-1'",
      "missing port mode 'port-1'",
    ]);
    expect(antennaStageValidationMessages(stage, null)).toEqual([]);
  });

  it("does not mistake an authored view reference for a mesh-exact current view", () => {
    const scene = {
      objects: [{ id: "antenna-1", role: "antenna" }],
      current_transports: [{ name: "current-1", kind: "current_transport", model: "ohmic_poisson",
        domain: [{ object_id: "antenna-1" }],
        boundaries: ["signal-in", "signal-out", "return-in", "return-out"].map(id => ({
          id, kind: "equipotential_current_terminal", surfaces: [{ object_id: "antenna-1", surface_id: id, orientation: [0, 1, 0] }],
        })),
      }],
      antenna_port_modes: [{ id: "port-1", schema_version: "antenna_port_mode.v2", source_object_id: "antenna-1", current_transport_id: "current-1",
        normalization_current_a: 1, branches: [
          { id: "signal", inlet_terminal_ref: "signal-in", outlet_terminal_ref: "signal-out", signed_weight: 1 },
          { id: "return", inlet_terminal_ref: "return-in", outlet_terminal_ref: "return-out", signed_weight: -1 },
        ],
      }],
    } as SceneResource;
    expect(antennaStageValidationMessages(
      { ...stage, conservative_current_view_ref: "current-1:rt0" }, scene,
    )).toEqual([expect.stringContaining("requires a mesh-exact ConservativeCurrentView")]);
    expect(antennaStageValidationMessages(stage, {
      ...scene,
      current_transports: [{ ...scene.current_transports![0], conservative_current_view: { stable_vertex_ids: [1] } }],
    })).toEqual([expect.stringContaining("requires a mesh-exact ConservativeCurrentView")]);
  });

  it("rejects ambiguous port and field-basis cardinality before execution", () => {
    const scene = {
      current_transports: [{ name: "current-1" }],
      antenna_port_modes: [],
    } as unknown as SceneResource;
    expect(antennaStageValidationMessages({
      ...stage,
      port_mode_ids: [],
      outputs: [
        { id: "basis-1", quantity: "H_ant_basis" },
        { id: "basis-2", quantity: "H_ant_basis" },
      ],
    }, scene)).toEqual(expect.arrayContaining([
      "field solve requires exactly one independently normalized port mode",
      "stage must publish exactly one H_ant_basis output",
    ]));
  });
});
