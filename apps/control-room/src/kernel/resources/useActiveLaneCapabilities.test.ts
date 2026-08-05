import { describe, expect, it } from "vitest";

import type { LiveStatusResource } from "../api/apiTypes";

import { activeLaneCapabilityFixture } from "./activeLaneCapabilityFixture.testSupport";
import { selectActiveLaneCapabilitySnapshot } from "./useActiveLaneCapabilities";
import {
  resolveActiveLaneOperation,
  resolveActiveLaneOperationPresentation,
} from "./useActiveLaneCapabilities";

const activeLane = activeLaneCapabilityFixture();

describe("active lane capability resource", () => {
  it("reads the planner-owned snapshot from session status without reconstructing lane support", () => {
    const capabilities: LiveStatusResource["capabilities"] = {
      structured_grid: true,
      explicit_topology: false,
      binary_fields: true,
      cell_fields: true,
      node_fields: false,
      scalar_history: true,
      eigen_modes: false,
      gpu_telemetry: true,
      preview_2d: true,
      preview_3d: true,
      algorithms_available: [],
      active_lane: activeLane,
    };
    const status = { data: { capabilities } };

    expect(selectActiveLaneCapabilitySnapshot(status)).toBe(activeLane);
  });

  it("returns null when status has no authoritative active-lane snapshot", () => {
    expect(
      selectActiveLaneCapabilitySnapshot({
        data: null,
      }),
    ).toBeNull();
  });

  it("resolves supported operations and fails closed for missing snapshots", () => {
    expect(resolveActiveLaneOperation(activeLane, "grid_build")).toEqual({
      enabled: true,
      reason_code: "capability_supported",
      state: "supported",
      reason: "Structured-grid operation is supported by the resolved FDM lane.",
      requires: ["discretization:fdm"],
    });
    expect(resolveActiveLaneOperation(null, "grid_build")).toEqual({
      enabled: false,
      reason_code: "capability_stale",
      state: "stale",
      reason: "Active-lane capability snapshot is unavailable.",
      requires: ["planner_capability_snapshot"],
    });
  });

  it.each([
    ["supported", "capability_supported", "supported"],
    ["semantic_only", "capability_semantic_only", "semantic_only"],
    ["deferred", "capability_deferred", "deferred"],
    ["unsupported", "capability_unsupported", "not-applicable"],
    ["stale", "capability_stale", "not-materialized"],
  ] as const)(
    "preserves the %s capability reason code %s and derives %s UI availability",
    (state, reasonCode, presentationState) => {
      const operation = {
        state,
        reason_code: reasonCode,
        reason: `${state} reason`,
        requires: [`state:${state}`],
      };

      expect(resolveActiveLaneOperationPresentation(operation)).toEqual({
        ...operation,
        state: presentationState,
      });
    },
  );
});
