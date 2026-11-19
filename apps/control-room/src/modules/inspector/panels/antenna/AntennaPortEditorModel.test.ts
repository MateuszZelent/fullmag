import { describe, expect, it } from "vitest";

import type { AuthoringTransactionResponse, KnownSceneCurrentTransport, SceneResource } from "@/kernel/api/apiTypes";
import type { AntennaPortModeResource } from "@/shared/domain/physics/antennaPortValidation";

import {
  acknowledgeAntennaPortDraft, buildAntennaPortTransaction, committedAntennaPortScene,
  createAntennaPortDraft, type AntennaPortDraft,
} from "./AntennaPortEditorModel";

function fixture() {
  const port: AntennaPortModeResource = {
    id: "port", source_object_id: "signal", schema_version: "antenna_port_mode.v2",
    normalization_current_a: 1, current_transport_id: "current",
    branches: [
      { id: "signal", inlet_terminal_ref: "signal-in", outlet_terminal_ref: "signal-out", signed_weight: 1 },
      { id: "return", inlet_terminal_ref: "return-in", outlet_terminal_ref: "return-out", signed_weight: -1 },
    ],
  };
  const transport: KnownSceneCurrentTransport = {
    kind: "current_transport", name: "current", model: "ohmic_poisson", coupling: "one_way",
    domain: [{ object_id: "signal" }, { object_id: "return" }],
    boundaries: ["signal-in", "signal-out", "return-in", "return-out", "return2-in", "return2-out"].map((id) => ({
      id, kind: "equipotential_current_terminal",
      surfaces: [{ object_id: id.startsWith("signal") ? "signal" : "return", surface_id: id, orientation: [1, 0, 0] }],
    })),
  };
  const scene: SceneResource = {
    revision: 7, scene: { id: "session-A", name: "fixture", authoring_schema: "fixture", source_of_truth: "fixture" },
    objects: [{ id: "signal", role: "antenna" }, { id: "return", role: "conductor" }],
    current_transports: [transport, { ...transport, name: "alternative" }],
    antenna_port_modes: [port, { ...structuredClone(port), id: "unrelated" }],
  };
  return { scene, port, draft: { ...createAntennaPortDraft(port, "owner-A", 7), dirty: true } };
}

function applyDraft(scene: SceneResource, draft: AntennaPortDraft): AuthoringTransactionResponse {
  const request = buildAntennaPortTransaction(scene, "signal", "port", draft);
  if (request.kind !== "merge_patch") throw new Error("Expected a merge patch");
  const committed: SceneResource = { ...scene, ...request.merge_patch, revision: draft.baseRevision + 1 };
  return { committed_scene: committed, scene_revision: draft.baseRevision + 1, transaction_kind: "merge_patch" };
}

describe("existing antenna port editor transactions", () => {
  it("patches only port modes and preserves immutable identities, unrelated ports and unknown fields", () => {
    const { scene, port, draft } = fixture();
    Object.assign(port, { future_port: { policy: "retained" } });
    Object.assign(port.branches[0], { future_branch: "retained" });
    draft.currentTransportId = "alternative";
    draft.branches[0].id = "renamed-signal";
    const before = structuredClone(scene);
    const request = buildAntennaPortTransaction(scene, "signal", "port", draft);
    expect(request.kind).toBe("merge_patch");
    if (request.kind !== "merge_patch") throw new Error("Expected merge patch");
    expect(request.base_revision).toBe(7);
    expect(Object.keys(request.merge_patch)).toEqual(["antenna_port_modes"]);
    const ports = request.merge_patch.antenna_port_modes as unknown as AntennaPortModeResource[];
    expect(ports[1]).toEqual(scene.antenna_port_modes![1]);
    expect(ports[0]).toMatchObject({ ...port, current_transport_id: "alternative", branches: [
      { ...port.branches[0], id: "renamed-signal", future_branch: "retained" }, port.branches[1],
    ], future_port: { policy: "retained" } });
    expect(scene).toEqual(before);
  });

  it.each([NaN, Infinity, -1, 7.5, 6, 8])("rejects unavailable or stale base revision %s", (revision) => {
    const { scene, draft } = fixture();
    expect(() => buildAntennaPortTransaction(scene, "signal", "port", { ...draft, baseRevision: revision })).toThrow("explicitly rebase");
  });

  it("rejects missing, locked and ambiguous source/port ownership", () => {
    const { scene, draft } = fixture();
    expect(() => buildAntennaPortTransaction({ ...scene, objects: [] }, "signal", "port", draft)).toThrow("unlocked source");
    expect(() => buildAntennaPortTransaction({ ...scene, objects: [{ id: "signal", role: "antenna", locked: true }] }, "signal", "port", draft)).toThrow("unlocked source");
    expect(() => buildAntennaPortTransaction({ ...scene, objects: [...scene.objects!, scene.objects![0]] }, "signal", "port", draft)).toThrow("unlocked source");
    expect(() => buildAntennaPortTransaction({ ...scene, antenna_port_modes: [] }, "signal", "port", draft)).toThrow("missing, ambiguous");
    expect(() => buildAntennaPortTransaction({ ...scene, antenna_port_modes: [scene.antenna_port_modes![0], scene.antenna_port_modes![0]] }, "signal", "port", draft)).toThrow("missing, ambiguous");
    expect(() => buildAntennaPortTransaction(scene, "return", "port", draft)).toThrow("does not belong");
  });

  it.each(["", " ", "-", "1e", "NaN", "Infinity", "1e309"])("does not coerce an incomplete/nonfinite weight %j", (value) => {
    const { scene, draft } = fixture();
    draft.branches[0].signedWeight = value;
    expect(() => buildAntennaPortTransaction(scene, "signal", "port", draft)).toThrow("finite explicit number");
  });

  it("uses scene-aware validation for selected transport, terminal namespace and weights", () => {
    const { scene, draft } = fixture();
    draft.currentTransportId = "missing";
    expect(() => buildAntennaPortTransaction(scene, "signal", "port", draft)).toThrow("current transport 'missing'");
    draft.currentTransportId = "current";
    draft.branches[0].inletTerminalRef = "missing";
    expect(() => buildAntennaPortTransaction(scene, "signal", "port", draft)).toThrow("does not exist");
    draft.branches[0].inletTerminalRef = "signal-in";
    draft.branches[0].signedWeight = "0";
    expect(() => buildAntennaPortTransaction(scene, "signal", "port", draft)).toThrow("finite and non-zero");
    draft.branches[0].signedWeight = "2";
    expect(() => buildAntennaPortTransaction(scene, "signal", "port", draft)).toThrow("positive branch weights must sum to 1");
  });

  it("adds/removes only explicitly authored branches without creating terminals or normalizing weights", () => {
    const { scene, draft } = fixture();
    draft.branches[1].signedWeight = "-0.5";
    draft.branches.push({ rowKey: "added-0", originalId: null, id: "return2", inletTerminalRef: "return2-in", outletTerminalRef: "return2-out", signedWeight: "-0.5" });
    const response = applyDraft(scene, draft);
    expect(response.committed_scene.antenna_port_modes![0].branches.map((branch) => branch.signed_weight)).toEqual([1, -0.5, -0.5]);
    expect(response.committed_scene.current_transports).toEqual(scene.current_transports);
    const acknowledged = acknowledgeAntennaPortDraft(draft, draft, 8)!;
    expect(acknowledged.branches[2]).toMatchObject({ originalId: "return2", rowKey: "added-0" });
    acknowledged.branches = acknowledged.branches.slice(0, 2);
    acknowledged.branches[1] = { ...acknowledged.branches[1], signedWeight: "-1" };
    expect(applyDraft(response.committed_scene, acknowledged).committed_scene.antenna_port_modes![0].branches).toHaveLength(2);
  });

  it("preserves a newer draft and row keys after a rename ACK; subsequent writes use the acknowledged identity", () => {
    const { scene, draft: submitted } = fixture();
    submitted.branches[0].id = "submitted-id";
    const current = { ...submitted, branches: submitted.branches.map((branch, index) => index ? branch : { ...branch, id: "newer-id" }) };
    const response = applyDraft(scene, submitted);
    const acknowledged = acknowledgeAntennaPortDraft(current, submitted, 8)!;
    expect(acknowledged).toMatchObject({ baseRevision: 8, dirty: true });
    expect(acknowledged.branches[0]).toMatchObject({ rowKey: "original-0", originalId: "submitted-id", id: "newer-id" });
    expect(applyDraft(response.committed_scene, acknowledged).committed_scene.antenna_port_modes![0].branches[0].id).toBe("newer-id");
    expect(acknowledgeAntennaPortDraft(submitted, submitted, 8)?.dirty).toBe(false);
    expect(acknowledgeAntennaPortDraft({ ...current, key: "owner-B" }, submitted, 8)?.key).toBe("owner-B");
    expect(acknowledgeAntennaPortDraft({ ...current, baseRevision: 9 }, submitted, 8)?.baseRevision).toBe(9);
    expect(() => acknowledgeAntennaPortDraft(current, submitted, 7)).toThrow("Invalid port ACK");
  });

  it("rebases branch edits against current unknown fields, but never resurrects a deleted original branch", () => {
    const { scene, draft } = fixture();
    const updated = structuredClone(scene);
    updated.revision = 8;
    Object.assign(updated.antenna_port_modes![0].branches[0], { newer_attribute: "preserved" });
    draft.baseRevision = 8;
    draft.branches[0].id = "renamed";
    expect(applyDraft(updated, draft).committed_scene.antenna_port_modes![0].branches[0]).toMatchObject({ newer_attribute: "preserved", id: "renamed" });
    updated.antenna_port_modes![0].branches.splice(0, 1);
    expect(() => buildAntennaPortTransaction(updated, "signal", "port", draft)).toThrow("Original branch 'signal' changed");
  });

  it("validates ACK scope, revision, port fields and immutable normalization before publication", () => {
    const { scene, port, draft } = fixture();
    const response = applyDraft(scene, draft);
    expect(committedAntennaPortScene(response, draft, "signal", "port", "session-A", port)).toBe(response.committed_scene);
    const check = (patch: (value: AuthoringTransactionResponse) => void) => {
      const value = structuredClone(response); patch(value);
      expect(() => committedAntennaPortScene(value, draft, "signal", "port", "session-A", port)).toThrow();
    };
    check((value) => { value.scene_revision = 7; });
    check((value) => { value.committed_scene.revision = 9; });
    check((value) => { value.committed_scene.scene_revision = 999; });
    check((value) => { value.committed_scene.scene!.id = "session-B"; });
    check((value) => { value.committed_scene.antenna_port_modes = []; });
    check((value) => { value.committed_scene.antenna_port_modes![0].branches[0].id = "other"; });
    check((value) => { value.committed_scene.antenna_port_modes![0].normalization_current_a = 2; });
    check((value) => { value.committed_scene.current_transports = []; });
  });

  it("rejects an ACK that replaces the immutable v3 source-cut normalization and its scene binding", () => {
    const { scene, port } = fixture();
    port.schema_version = "antenna_port_mode.v3";
    port.normalization = { kind: "source_cut_rt0", source_cut_ref: "cut", orientation: "minus_outward" };
    Object.assign(scene.current_transports![0], { conservative_current_source: {
      schema_version: "conservative_current_source.v2", kind: "closed_geometry_potential_jump", object_id: "signal",
      closure: { kind: "closed_geometry", source_cuts: [{ id: "cut" }] },
      terminal_observations: ["signal", "return"].flatMap(part => [
        { id: `${part}-in`, part_id: part, selector: "local_u_min" },
        { id: `${part}-out`, part_id: part, selector: "local_u_max" },
      ]),
    } });
    const draft = { ...createAntennaPortDraft(port, "owner-A", 7), dirty: true };
    const response = applyDraft(scene, draft);
    expect(committedAntennaPortScene(response, draft, "signal", "port", "session-A", port)).toBe(response.committed_scene);
    const changed = structuredClone(response);
    changed.committed_scene.antenna_port_modes![0].normalization!.source_cut_ref = "changed-cut";
    Object.assign(changed.committed_scene.current_transports![0], { conservative_current_source: {
      ...(scene.current_transports![0].conservative_current_source as Record<string, unknown>),
      closure: { kind: "closed_geometry", source_cuts: [{ id: "changed-cut" }] },
    } });
    expect(() => committedAntennaPortScene(changed, draft, "signal", "port", "session-A", port)).toThrow("Port ACK");
  });
});
