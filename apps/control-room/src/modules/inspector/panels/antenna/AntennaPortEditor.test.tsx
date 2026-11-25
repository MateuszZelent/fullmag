import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { AntennaPortEditor } from "./AntennaPortEditor";

vi.mock("@/kernel/KernelContext", async importOriginal => ({
  ...await importOriginal<typeof import("@/kernel/KernelContext")>(),
  useKernel: () => ({ api: {}, resources: {}, commands: {} }),
}));
vi.mock("@/kernel/resources/useSessionStatus", async importOriginal => ({
  ...await importOriginal<typeof import("@/kernel/resources/useSessionStatus")>(),
  useSessionResourceIdentity: () => ({ sessionId: "session", sessionEpoch: "epoch", requestScopeEpoch: "instance:1" }),
}));

function sceneFixture(): SceneResource {
  const transport = {
    name: "current", kind: "current_transport", model: "ohmic_poisson", coupling: "one_way",
    domain: [{ object_id: "antenna" }], boundaries: [],
  };
  return {
    scene: { id: "scene" }, revision: 1,
    objects: [{ id: "antenna", role: "antenna" }],
    current_transports: [
      transport, { ...transport, name: "alternative" },
      { ...transport, name: "foreign", domain: [{ object_id: "other" }] },
      { ...transport, name: "coupled", coupling: "two_way" },
      { ...transport, name: "timed", time_envelope: { kind: "constant" } },
      { ...transport, name: "duplicate" }, { ...transport, name: "duplicate" },
    ],
    antenna_port_modes: [{
      id: "port", schema_version: "antenna_port_mode.v2", source_object_id: "antenna",
      current_transport_id: "current", normalization_current_a: 1,
      branches: [
        { id: "signal", inlet_terminal_ref: "signal-in", outlet_terminal_ref: "signal-out", signed_weight: 1 },
        { id: "return", inlet_terminal_ref: "return-in", outlet_terminal_ref: "return-out", signed_weight: -1 },
      ],
    }],
  } as unknown as SceneResource;
}
function render(scene: SceneResource) {
  return renderToStaticMarkup(<AntennaPortEditor objectId="antenna" portId="port" scene={scene}
    sceneScopeKey="session=session&epoch=epoch&request_scope_epoch=instance%3A1" status="ready" refetch={() => {}} />);
}
function transportSelect(markup: string) {
  const select = markup.match(/<select[^>]*aria-label="Current transport"[\s\S]*?<\/select>/)?.[0];
  expect(select).toBeDefined();
  return select!;
}

describe("existing antenna port transport picker", () => {
  it("offers existing source transports without free-text IDs or incompatible choices", () => {
    const select = transportSelect(render(sceneFixture()));
    expect(select).toContain('value="current" selected=""');
    expect(select).toContain('value="alternative"');
    for (const name of ["foreign", "coupled", "timed", "duplicate"]) {
      expect(select).not.toContain('value="' + name + '"');
    }
  });

  it("preserves a missing transport as a disabled selected reference without choosing a replacement", () => {
    const scene = sceneFixture();
    scene.antenna_port_modes![0].current_transport_id = "lost";
    const select = transportSelect(render(scene));
    expect(select).toMatch(/<option[^>]*value="lost"[^>]*disabled=""[^>]*selected=""[^>]*>lost · unavailable/);
    expect(select).not.toMatch(/value="alternative"[^>]*selected/);
  });

  it("retains the current closed-loop transport using the same source inventory", () => {
    const scene = sceneFixture();
    Object.assign(scene.antenna_port_modes![0], {
      schema_version: "antenna_port_mode.v3",
      normalization: { kind: "source_cut_rt0", source_cut_ref: "cut", orientation: "minus_outward" },
    });
    Object.assign(scene.current_transports![0], {
      structured_current_closure: { kind: "closed_geometry", schema_version: "structured_current_closure.v2",
        source_cuts: [{ source_cut_id: "cut", region: { object_id: "antenna" } }] },
    });
    expect(transportSelect(render(scene))).toContain('value="current" selected=""');
  });
});
