import { describe, expect, it } from "vitest";

import type { KnownSceneCurrentTransport, SceneResource } from "@/kernel/api/apiTypes";

import { antennaPortStatus, antennaPortValidationMessages, type AntennaPortModeResource } from "./antennaPortValidation";

function port(): AntennaPortModeResource {
  return {
    id: "port", schema_version: "antenna_port_mode.v2", source_object_id: "signal",
    current_transport_id: "current", normalization_current_a: 1,
    branches: [
      { id: "signal", inlet_terminal_ref: "signal-in", outlet_terminal_ref: "signal-out", signed_weight: 1 },
      { id: "return", inlet_terminal_ref: "return-in", outlet_terminal_ref: "return-out", signed_weight: -1 },
    ],
  };
}

function transport(): KnownSceneCurrentTransport {
  return {
    kind: "current_transport", name: "current", model: "ohmic_poisson", coupling: "one_way",
    domain: [{ object_id: "signal" }, { object_id: "return" }],
    boundaries: ["signal-in", "signal-out", "return-in", "return-out"].map((id) => ({
      id, kind: "equipotential_current_terminal", surfaces: [{ object_id: id.split("-")[0], surface_id: id, orientation: [0, 1, 0] }],
    })),
  };
}

function scene(current = transport()): SceneResource {
  return {
    objects: [{ id: "signal", role: "antenna" }, { id: "return", role: "conductor" }],
    current_transports: [current], antenna_port_modes: [port()],
  };
}

function authored(currentSource: boolean): Record<string, unknown> {
  const observations = ["signal-in", "signal-out", "return-in", "return-out"].map((id) => ({
    [currentSource ? "id" : "observation_id"]: id, object_id: id.split("-")[0],
  }));
  // This is a reference-inventory fixture, never an accepted native source.
  return {
    kind: currentSource ? "external_lead_current" : "isolated_branch_straight_stubs",
    schema_version: currentSource ? "conservative_current_source.v1" : "antenna_external_lead_preparation.v1",
    revision: "reference-fixture",
    [currentSource ? "terminal_observations" : "extensions"]: observations,
    drives: [{ id: "drive", port_mode_ref: "port" }],
  };
}

describe("antenna port scene-aware authoring validation (no native qualification)", () => {
  it("accepts explicit electrical pairs with a separate return object without mutating authoring", () => {
    const value = scene();
    const before = JSON.stringify(value);
    expect(antennaPortValidationMessages(port(), value)).toEqual([]);
    expect(antennaPortStatus(port(), value)).toBe("ready");
    expect(JSON.stringify(value)).toBe(before);
  });

  it("cannot mark missing scene data or a missing transport ready", () => {
    expect(antennaPortValidationMessages(port(), null)).toContain("scene is unavailable; port references cannot be validated");
    expect(antennaPortStatus(port(), {})).toBe("warning");
    expect(antennaPortValidationMessages(port(), { ...scene(), current_transports: [] }))
      .toContain("current transport 'current' is missing or ambiguous");
  });

  it("rejects ambiguous transport and source identities and non-conductor source roles", () => {
    expect(antennaPortValidationMessages(port(), { ...scene(), current_transports: [transport(), transport()] }))
      .toContain("current transport 'current' is missing or ambiguous");
    expect(antennaPortValidationMessages(port(), { ...scene(), objects: [{ id: "return", role: "conductor" }] }))
      .toContain("source object 'signal' is missing or ambiguous");
    expect(antennaPortValidationMessages(port(), { ...scene(), objects: [{ id: "signal", role: "antenna" }, { id: "signal", role: "conductor" }] }))
      .toContain("source object 'signal' is missing or ambiguous");
    expect(antennaPortValidationMessages(port(), { ...scene(), objects: [{ id: "signal", role: "magnet" }, { id: "return", role: "conductor" }] }))
      .toContain("source object 'signal' must be an authored antenna or conductor");
  });

  it.each([
    { model: "prescribed_density" }, { coupling: "bidirectional" },
    { time_envelope: { kind: "constant", value: 1 } }, { kind: "unknown_transport" },
  ])("does not promote unsupported transport %j", (patch) => {
    const current = { ...transport(), ...patch } as KnownSceneCurrentTransport;
    expect(antennaPortValidationMessages(port(), scene(current)))
      .toContain("current transport 'current' requires static one-way OhmicPoisson authoring");
  });

  it("resolves references by the selected transport, not another transport with matching IDs", () => {
    const current = transport();
    current.boundaries = current.boundaries!.slice(0, 2);
    const value = scene(current);
    value.current_transports!.push({ ...transport(), name: "foreign" });
    expect(antennaPortValidationMessages(port(), value)).toContain(
      "branch 'return' inlet terminal 'return-in' does not exist in CurrentTransport boundaries");
  });

  it("rejects an insulating boundary, ambiguous boundary ID, and a multi-object terminal", () => {
    const current = transport();
    current.boundaries![0] = { ...current.boundaries![0], kind: "insulating" };
    expect(antennaPortStatus(port(), scene(current))).toBe("warning");
    const duplicate = transport();
    duplicate.boundaries!.push(duplicate.boundaries![0]);
    expect(antennaPortValidationMessages(port(), scene(duplicate)))
      .toContain("terminal 'signal-in' is ambiguous in CurrentTransport boundaries");
    const mixed = transport();
    mixed.boundaries![0].surfaces.push({ object_id: "return", surface_id: "other", orientation: [0, 1, 0] });
    expect(antennaPortStatus(port(), scene(mixed))).toBe("warning");
  });

  it("accepts the other two electrical boundary kinds without inventing current normalization", () => {
    const current = transport();
    current.boundaries![0] = { ...current.boundaries![0], kind: "voltage_electrode", potential_V: 0 };
    current.boundaries![1] = { ...current.boundaries![1], kind: "normal_current_electrode", outward_current_density_Apm2: 1 };
    expect(antennaPortStatus(port(), scene(current))).toBe("ready");
  });

  it("rejects pairs split across conductors and positive signal paths on the return object", () => {
    const split = port();
    [split.branches[0].outlet_terminal_ref, split.branches[1].outlet_terminal_ref] =
      [split.branches[1].outlet_terminal_ref, split.branches[0].outlet_terminal_ref];
    expect(antennaPortValidationMessages(split, scene()))
      .toContain("branch 'signal' inlet and outlet must belong to the same conductor object");
    const reversed = port();
    reversed.branches[0].signed_weight = -1;
    reversed.branches[1].signed_weight = 1;
    expect(antennaPortValidationMessages(reversed, scene()))
      .toContain("branch 'return' positive signal path must belong to source object 'signal'");
  });

  it("requires terminal objects in both the scene and transport domain", () => {
    const current = transport();
    current.domain = [{ object_id: "signal" }];
    expect(antennaPortStatus(port(), scene(current))).toBe("warning");
    const value = scene();
    value.objects = [{ id: "signal", role: "antenna" }];
    expect(antennaPortStatus(port(), value)).toBe("warning");
  });

  it.each([true, false])("resolves authored observations instead of boundary IDs (current source=%s)", (currentSource) => {
    const current = transport();
    current.boundaries = [];
    current[currentSource ? "conservative_current_source" : "external_lead_preparation"] = authored(currentSource);
    expect(antennaPortValidationMessages(port(), scene(current))).toEqual([]);
  });

  it("prioritizes current source over preparation without falling back on malformed data", () => {
    const current = transport();
    current.external_lead_preparation = authored(false);
    current.conservative_current_source = { ...authored(true), terminal_observations: [] };
    expect(antennaPortValidationMessages(port(), scene(current))).toContain(
      "current-source terminal_observations is unsupported or malformed; boundary fallback is not allowed");
    current.conservative_current_source = authored(true);
    current.external_lead_preparation = { kind: "future_model" };
    expect(antennaPortValidationMessages(port(), scene(current))).toEqual([]);
  });

  it.each([true, false])("requires one explicit drive per port without inferring or synthesizing it (source=%s)", (currentSource) => {
    const current = transport();
    const request = authored(currentSource);
    current[currentSource ? "conservative_current_source" : "external_lead_preparation"] = request;
    for (const drives of [[], [{ id: "other-drive", port_mode_ref: "other" }],
      [{ id: "a", port_mode_ref: "port" }, { id: "b", port_mode_ref: "port" }]]) {
      request.drives = drives;
      expect(antennaPortValidationMessages(port(), scene(current)))
        .toContain("port 'port' requires exactly one explicitly authored current-source drive");
    }
  });

  it.each([true, false])("rejects wrong schema, kind, duplicate or foreign observation identities (source=%s)", (currentSource) => {
    const key = currentSource ? "conservative_current_source" : "external_lead_preparation";
    for (const patch of [{ kind: "future" }, { schema_version: "future" }, { drives: [null] }]) {
      expect(antennaPortStatus(port(), scene({ ...transport(), [key]: { ...authored(currentSource), ...patch } }))).toBe("warning");
    }
    const request = authored(currentSource);
    const entries = request[currentSource ? "terminal_observations" : "extensions"] as Array<Record<string, unknown>>;
    entries.push({ ...entries[0] });
    expect(antennaPortStatus(port(), scene({ ...transport(), [key]: request }))).toBe("warning");
    entries.pop();
    entries[0].object_id = "foreign";
    expect(antennaPortStatus(port(), scene({ ...transport(), [key]: request }))).toBe("warning");
  });

  it("retains the structural signed-weight and terminal uniqueness checks", () => {
    const invalid = port();
    invalid.branches[1].signed_weight = 0;
    invalid.branches[1].inlet_terminal_ref = "signal-in";
    expect(antennaPortValidationMessages(invalid, scene())).toEqual(expect.arrayContaining([
      "terminal references must be unique", "branch return weight must be finite and non-zero",
      "positive branch weights must sum to 1 and include a return branch", "all branch weights must sum to 0",
    ]));
  });
});
