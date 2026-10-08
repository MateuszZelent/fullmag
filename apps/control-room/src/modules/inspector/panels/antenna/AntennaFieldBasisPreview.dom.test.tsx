import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { AntennaFieldSolutionResource } from "@/kernel/api/apiTypes";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

const mocks = vi.hoisted(() => ({
  payload: vi.fn(),
}));

vi.mock("@/kernel/resources/antennaResources", () => ({
  antennaFieldPayloadEtag: () => '"field-payload"',
  useAntennaFieldSolutionPayloadResource: (
    solutionId: string,
    kind: string | null,
    portModeId: string | null,
  ) => {
    mocks.payload(solutionId, kind, portModeId);
    return { data: null, error: null, status: "loading" };
  },
}));

import { AntennaFieldBasisPreview } from "./AntennaFieldBasisPreview";

function solution(solutionId: string, portModeId: string): AntennaFieldSolutionResource {
  return {
    solution_id: solutionId,
    sample_positions: {
      layout: "sample_xyz_interleaved", scalar_type: "float64_le", unit: "m", value_count: 3,
    },
    bases: [{
      port_mode_id: portModeId,
      magnetic_field_per_ampere: {
        layout: "sample_xyz_interleaved", scalar_type: "float64_le", unit: "A/m/A", value_count: 3,
      },
    }],
  } as AntennaFieldSolutionResource;
}

describe("antenna field basis preview selection", () => {
  it("requests the new solution's port when the Inspector changes antenna", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<AntennaFieldBasisPreview solution={solution("a", "port-a")} />));
      expect(mocks.payload).toHaveBeenCalledWith("a", "magnetic_field_per_ampere", "port-a");
      mocks.payload.mockClear();

      await act(async () => root.render(<AntennaFieldBasisPreview solution={solution("b", "port-b")} />));
      expect(mocks.payload).toHaveBeenCalledWith("b", "magnetic_field_per_ampere", "port-b");
      expect(mocks.payload).not.toHaveBeenCalledWith("b", "magnetic_field_per_ampere", "port-a");
      expect(container.textContent).toContain("port-b");
      expect(container.textContent).toContain("Unrecorded (legacy asset)");
      await act(async () => root.render(<AntennaFieldBasisPreview solution={{
        ...solution("c", "port-c"),
        sample_carrier: {
          domain: { kind: "object", object_id: "target-c" },
          carrier_kind: "fem_mesh_asset:target-c", location: "node",
          topology_digest: `sha256:${"4".repeat(64)}`,
        },
      }} />));
      expect(container.textContent).toContain("Object: target-c");
      expect(container.textContent).toContain("fem_mesh_asset:target-c");
      expect(container.textContent).not.toContain("port-b");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
      mocks.payload.mockReset();
    }
  });
});
