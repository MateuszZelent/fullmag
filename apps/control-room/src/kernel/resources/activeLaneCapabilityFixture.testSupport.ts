import type { LiveStatusResource } from "../api/apiTypes";

export function activeLaneCapabilityFixture(): LiveStatusResource["capabilities"]["active_lane"] {
  return {
    schema_version: "active-lane-capabilities.v2",
    authored: {
      backend: "fdm",
      discretization: "fdm",
      device: "auto",
      precision: "double",
      mode: "strict",
    },
    requested: {
      backend: "fdm",
      discretization: "fdm",
      device: "auto",
      precision: "double",
      mode: "strict",
    },
    resolved: {
      backend: "fdm",
      discretization: "fdm",
      device: "cpu",
      precision: "double",
      mode: "strict",
    },
    source: {
      kind: "planner",
      capability_profile_version: "test-profile",
      engine_id: "fdm_cpu_reference",
      authored_intent: "problem_ir.runtime_selection",
      effective_request: "session.runtime_resolution",
    },
    qualification: {
      status: "not_asserted",
      reason: "Test fixture does not assert scientific qualification.",
    },
    operations: {
      grid_build: {
        state: "supported",
        reason_code: "capability_supported",
        reason: "Structured-grid operation is supported by the resolved FDM lane.",
        requires: ["discretization:fdm"],
      },
    },
  };
}
