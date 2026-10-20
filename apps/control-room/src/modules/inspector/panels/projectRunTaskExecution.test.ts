import { describe, expect, it } from "vitest";

import { parseProjectRunTaskExecution } from "./projectRunTaskExecution";

const materialization = {
  schema_version: "execution_request.v1",
  profile: {
    schema_version: "execution_profile.v1",
    profile_id: "gpu-sweep",
    version: "3",
    description: "Pinned GPU sweep profile",
    defaults: {},
  },
  profile_sha256: "a".repeat(64),
  requested: {
    backend: "fem",
    device: "gpu",
    precision: "double",
    mode: "strict",
    resources: {
      schema_version: "compute_resources.v1",
      target: { kind: "local" },
      cpu: {
        threads: "auto",
        core_policy: "physical_first",
        affinity: "compact",
        numa_node: 0,
        native_threads: 4,
        blas_threads: "auto",
      },
      gpu: {
        selector: "allow_list",
        device_uuids: ["GPU-0000abcd"],
        devices_per_task: 1,
        vram_per_device_bytes: 8589934592,
      },
      ram: { reservation_bytes: 2147483648 },
      scratch: {},
      parallelism: { kind: "single_process" },
      placement: "balanced",
    },
  },
  layers: [],
  origins: {
    backend: { kind: "profile", location: "profile.defaults.backend" },
    device: { kind: "step", location: "study.steps[step-1].device" },
  },
};

describe("project-run task execution summary", () => {
  it("reads the immutable per-step profile, request, and field origins", () => {
    expect(
      parseProjectRunTaskExecution({
        execution: { step_id: "step-1", materialization },
      }),
    ).toEqual({
      stepId: "step-1",
      materialization: {
        profile: {
          id: "gpu-sweep",
          version: "3",
          sha256: "a".repeat(64),
        },
        backend: "fem",
        device: "gpu",
        precision: "double",
        mode: "strict",
        resources: [
          "Target: local",
          "CPU: Auto threads · native 4 · BLAS Auto · affinity compact · physical_first · NUMA node 0",
          "GPU: allow_list · 1 per task · UUIDs GPU-0000abcd · 8589934592 bytes VRAM/device",
          "RAM reservation: 2147483648 bytes",
          "Scratch reservation: not specified",
          "Parallelism: single process",
          "Placement: balanced",
        ],
        origins: [
          { field: "backend", kind: "profile", location: "profile.defaults.backend" },
          { field: "device", kind: "step", location: "study.steps[step-1].device" },
        ],
      },
    });
  });

  it("preserves historical step identity without inventing a profile snapshot", () => {
    expect(
      parseProjectRunTaskExecution({
        execution: { step_id: "legacy-step" },
      }),
    ).toEqual({ stepId: "legacy-step", materialization: null });
  });

  it("keeps request and origins visible when no reusable profile was pinned", () => {
    expect(
      parseProjectRunTaskExecution({
        execution: {
          step_id: "step-2",
          materialization: {
            ...materialization,
            profile: undefined,
            profile_sha256: undefined,
            origins: {
              backend: { kind: "product_default", location: "product.default" },
              device: { kind: "step", location: "study.steps[step-2].device" },
            },
          },
        },
      }),
    ).toEqual({
      stepId: "step-2",
      materialization: {
        profile: null,
        backend: "fem",
        device: "gpu",
        precision: "double",
        mode: "strict",
        resources: [
          "Target: local",
          "CPU: Auto threads · native 4 · BLAS Auto · affinity compact · physical_first · NUMA node 0",
          "GPU: allow_list · 1 per task · UUIDs GPU-0000abcd · 8589934592 bytes VRAM/device",
          "RAM reservation: 2147483648 bytes",
          "Scratch reservation: not specified",
          "Parallelism: single process",
          "Placement: balanced",
        ],
        origins: [
          { field: "backend", kind: "product_default", location: "product.default" },
          { field: "device", kind: "step", location: "study.steps[step-2].device" },
        ],
      },
    });
  });

  it("rejects malformed hashes and incomplete execution identity", () => {
    expect(
      parseProjectRunTaskExecution({
        execution: {
          step_id: "step-1",
          materialization: { ...materialization, profile_sha256: "bad" },
        },
      }),
    ).toEqual({ stepId: "step-1", materialization: null });
    expect(
      parseProjectRunTaskExecution({ execution: { materialization } }),
    ).toBeNull();
  });
});
