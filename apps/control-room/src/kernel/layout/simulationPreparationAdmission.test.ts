import { describe, expect, it } from "vitest";

import type { ComputeNodesResource } from "../api/apiTypes";
import {
  CPU_QUOTA_ADMISSION_BLOCKER,
  preparationAdmissionBlocker,
  preparationAwaitsAdmission,
} from "./simulationPreparationAdmission";

function nodes(cpuQuota: string | null): ComputeNodesResource {
  return {
    nodes: [
      {
        node_id: "host-a",
        snapshot: cpuQuota === null ? {} : { enforcement: { cpu_quota: cpuQuota } },
        stale_after_seconds: 30,
        state: "current",
      },
    ],
    schema_version: "compute_nodes.v1",
    stale_after_seconds: 30,
    state: "current",
  };
}

const stage = (id: string) =>
  ({ id, isActive: true }) as unknown as NonNullable<
    Parameters<typeof preparationAwaitsAdmission>[0]["activeStage"]
  >;

describe("preparation admission blocker", () => {
  it("names the missing CPU quota delegation only when the host reports it", () => {
    expect(preparationAdmissionBlocker(nodes("unavailable"))).toBe(
      CPU_QUOTA_ADMISSION_BLOCKER,
    );
    expect(preparationAdmissionBlocker(nodes("supported"))).toBeNull();
    expect(preparationAdmissionBlocker(nodes("advisory"))).toBeNull();
    expect(preparationAdmissionBlocker(nodes(null))).toBeNull();
    expect(preparationAdmissionBlocker(null)).toBeNull();
  });

  it("applies only while a visible startup waits in domain preparation", () => {
    const waiting = { activeStage: stage("domain_preparation"), isTerminal: false, isVisible: true };
    expect(preparationAwaitsAdmission(waiting)).toBe(true);
    expect(preparationAwaitsAdmission({ ...waiting, isTerminal: true })).toBe(false);
    expect(preparationAwaitsAdmission({ ...waiting, isVisible: false })).toBe(false);
    expect(
      preparationAwaitsAdmission({ ...waiting, activeStage: stage("meshing") }),
    ).toBe(false);
  });
});
