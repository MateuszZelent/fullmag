import { describe, expect, it } from "vitest";

import {
  buildComputeNodePolicyUpdate,
  createComputeNodePolicyDraft,
  formatCpuIds,
} from "./computeNodePolicyDraft";
import type { ComputeNodePolicySummary } from "./types";

const policy: ComputeNodePolicySummary = {
  revision: 4,
  activeWorkers: 2,
  maxParallelWorkers: 8,
  draining: false,
  overBudget: false,
  blockingReasons: [],
  allowedCpuIds: [0, 1, 2, 5],
  allowedGpuUuids: ["GPU-a"],
  cpuReserveMillis: 1500,
  memoryReserveBytes: 2 * 1024 ** 3,
  scratchReserveBytes: 3 * 1024 ** 3,
  gpuVramReserves: { "GPU-a": 1024 ** 3 },
  priorityOrder: [7, 1],
  parallelismPatternCount: 1,
  allowedParallelismPatterns: [{ kind: "single_process" }],
};

describe("compute node policy draft", () => {
  it("round-trips editable budgets and preserves fields without editors", () => {
    const draft = createComputeNodePolicyDraft(policy);
    const result = buildComputeNodePolicyUpdate(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.allowed_cpu_ids).toEqual([0, 1, 2, 5]);
    expect(result.policy.reserved_budget).toEqual({
      cpu_millis: 1500,
      memory_bytes: 2 * 1024 ** 3,
      gpu_memory_bytes: 0,
      storage_bytes: 3 * 1024 ** 3,
    });
    expect(result.policy.reserved_gpu_vram_bytes_by_uuid).toEqual({ "GPU-a": 1024 ** 3 });
    expect(result.policy.priority_order).toEqual([7, 1]);
    expect(result.policy.allowed_parallelism_patterns).toEqual([{ kind: "single_process" }]);
  });

  it("rejects repeated CPU IDs and blank budget fields instead of silently zeroing them", () => {
    const draft = createComputeNodePolicyDraft(policy);
    expect(buildComputeNodePolicyUpdate({ ...draft, allowedCpuIds: "0-2, 2" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("duplicates"),
    });
    expect(buildComputeNodePolicyUpdate({ ...draft, memoryReserveGiB: " " })).toMatchObject({
      ok: false,
      error: expect.stringContaining("required"),
    });
  });

  it("formats sparse and contiguous CPU sets compactly", () => {
    expect(formatCpuIds([8, 2, 3, 4, 0, 8])).toBe("0, 2-4, 8");
  });
});
