import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComputeNodeInventoryDetails } from "../ComputeNodeInventoryDetails";
import { ComputeNodeInventoryStatus } from "../ComputeNodeInventoryStatus";
import { parseComputeNodeSnapshot, summarizeComputeNodeInventory } from "./computeNodeInventory";
import type { ComputeNodeInventorySummary } from "./types";

const snapshot = {
  schema_version: "compute_node_snapshot.v1",
  node_id: "desktop-host",
  inventory_revision: 7,
  sample: {
    source: "host_os",
    collected_at: "2026-10-13T12:00:00Z",
    freshness: { status: "current" },
  },
  cpu: {
    topology: {
      status: "available",
      value: {
        logical_cpus: [
          { id: 0, socket_id: 0, numa_node_id: 0, core_id: 0 },
          { id: 1, socket_id: 0, numa_node_id: 0, core_id: 0 },
          { id: 4, socket_id: 0, numa_node_id: 1, core_id: 1 },
        ],
      },
    },
    os_constraints: {
      allowed_logical_cpu_ids: { status: "available", value: [0, 1, 4] },
      quota: { status: "available", value: { mode: "limited", capacity_millis: 2000 } },
    },
    effective_capacity_millis: { status: "available", value: 1750 },
  },
  memory: {
    total_bytes: { status: "available", value: 17179869184 },
    available_bytes: { status: "available", value: 8589934592 },
  },
  gpus: {
    status: "available",
    value: [{
      uuid: "GPU-0000abcd",
      name: { status: "unavailable", reason: "source_unavailable", last_known: "NVIDIA Example" },
      pci_id: { status: "available", value: "0000:01:00.0" },
      vram_bytes: { status: "available", value: 8589934592 },
      partition: { status: "available", value: { kind: "full_device" } },
      topology: { status: "available", value: { numa_node_id: 1, pci_root_id: "0000:00" } },
    }],
  },
  enforcement: {
    cpu_affinity: "supported",
    cpu_quota: "advisory",
    memory_cap: "supported",
    gpu_visibility: "supported",
    storage_quota: "unavailable",
  },
};

describe("compute-node snapshot inventory", () => {
  it("parses stable host topology and renders explicit last-known GPU identity", () => {
    const parsed = parseComputeNodeSnapshot("desktop-host", snapshot);
    expect(parsed?.cpu.topology.value).toEqual({
      logicalProcessorCount: 3,
      logicalCpuIds: [0, 1, 4],
      socketIds: [0],
      numaNodeIds: [0, 1],
      physicalCoreCount: 2,
    });
    expect(parsed?.gpus.value?.[0].name).toEqual({
      status: "last_known",
      value: "NVIDIA Example",
    });

    const summary: ComputeNodeInventorySummary = {
      hasSnapshot: true,
      nodeCount: 1,
      nodes: [{ nodeId: "desktop-host", state: "current", snapshot: parsed, nodePolicy: null }],
      refreshFailed: false,
      resourceStatus: "ready",
      staleAfterSeconds: 30,
      state: "current",
    };
    const html = renderToStaticMarkup(<ComputeNodeInventoryDetails summary={summary} />);
    expect(html).toContain("Stable host inventory");
    expect(html).toContain("Collected (UTC)");
    expect(html).toContain("Oct 13, 2026, 12:00 PM");
    expect(html).toContain("IDs 0–1, 4");
    expect(html).toContain("Stable UUID · GPU-0000abcd");
    expect(html).toContain("NVIDIA Example · last known");
    expect(html).toContain("Observed capacity");
    expect(html).toContain("GPU visibility enforcement");
  });

  it("keeps node boot availability separate from a fresh sample timestamp", () => {
    const parsed = parseComputeNodeSnapshot("desktop-host", snapshot);
    const summary: ComputeNodeInventorySummary = {
      hasSnapshot: true,
      nodeCount: 1,
      nodes: [{ nodeId: "desktop-host", state: "unavailable", snapshot: parsed, nodePolicy: null }],
      refreshFailed: false,
      resourceStatus: "ready",
      staleAfterSeconds: 30,
      state: "unavailable",
    };

    const html = renderToStaticMarkup(<ComputeNodeInventoryDetails summary={summary} />);
    expect(html).toContain("Unavailable · previous host boot");
    expect(html).toContain("Sample freshness");
    expect(html).toContain("Current sample");
  });

  it("marks retained samples stale only after the API freshness boundary", () => {
    const resource: Parameters<typeof summarizeComputeNodeInventory>[0] = {
      data: {
        schema_version: "compute_nodes.v1",
        state: "current",
        stale_after_seconds: 30,
        nodes: [{ node_id: "desktop-host", state: "current", stale_after_seconds: 30, snapshot }],
      },
      status: "ready" as const,
      refreshError: new Error("host did not respond"),
    };

    const atBoundary = summarizeComputeNodeInventory(
      resource,
      Date.parse("2026-10-13T12:00:30Z"),
    );
    expect(atBoundary.state).toBe("current");
    expect(atBoundary.nodes[0]?.snapshot?.sample.freshness).toBe("current");

    const beyondBoundary = summarizeComputeNodeInventory(
      resource,
      Date.parse("2026-10-13T12:00:30.001Z"),
    );
    expect(beyondBoundary.state).toBe("stale");
    expect(beyondBoundary.nodes[0]?.state).toBe("stale");
    expect(beyondBoundary.nodes[0]?.snapshot?.sample.freshness).toBe("stale");
    const html = renderToStaticMarkup(
      <ComputeNodeInventoryStatus className="inventory-status" summary={beyondBoundary} />,
    );
    expect(html).toContain("Stale · refresh failed");
    expect(html).toContain("older than 30 seconds");
  });

  it("preserves previous-boot unavailability while the retained sample ages", () => {
    const summary = summarizeComputeNodeInventory({
      data: {
        schema_version: "compute_nodes.v1",
        state: "unavailable",
        stale_after_seconds: 30,
        nodes: [{ node_id: "desktop-host", state: "unavailable", stale_after_seconds: 30, snapshot }],
      },
      status: "ready",
      refreshError: null,
    }, Date.parse("2026-10-13T12:00:31Z"));

    expect(summary.state).toBe("unavailable");
    expect(summary.nodes[0]?.state).toBe("unavailable");
    expect(summary.nodes[0]?.snapshot?.sample.freshness).toBe("stale");
  });

  it("renders the revisioned read-only node policy and live admission status", () => {
    const summary = summarizeComputeNodeInventory({
      data: {
        schema_version: "compute_nodes.v1",
        state: "current",
        stale_after_seconds: 30,
        nodes: [{
          node_id: "desktop-host",
          state: "current",
          stale_after_seconds: 30,
          snapshot,
          node_policy: {
            policy: {
              schema_version: "compute_node_policy.v1",
              host_id: "operator-host-id",
              revision: 4,
              allowed_cpu_ids: [0, 2],
              allowed_gpu_uuids: ["GPU-00000000-0000-4000-8000-000000000001"],
              reserved_budget: {
                cpu_millis: 500,
                memory_bytes: 1073741824,
                gpu_memory_bytes: 0,
                storage_bytes: 2147483648,
              },
              reserved_gpu_vram_bytes_by_uuid: {},
              max_parallel_workers: 4,
              priority_order: [0, 10],
              draining: true,
              allowed_parallelism_patterns: [{ kind: "single_process" }],
            },
            status: {
              revision: 4,
              active_workers: 3,
              draining: true,
              over_budget: false,
              blocking_reasons: [],
            },
          },
        }],
      },
      status: "ready",
      refreshError: null,
    });

    expect(summary.nodes[0]?.nodePolicy).toMatchObject({
      revision: 4,
      activeWorkers: 3,
      maxParallelWorkers: 4,
      draining: true,
      overBudget: false,
      allowedCpuIds: [0, 2],
    });
    const html = renderToStaticMarkup(<ComputeNodeInventoryDetails summary={summary} />);
    expect(html).toContain("Admission policy");
    expect(html).toContain("Draining");
    expect(html).toContain("3 / 4");
    expect(html).toContain("CPU reserve");
  });

  it("rejects snapshots with a mismatched host identity or unsupported schema", () => {
    expect(parseComputeNodeSnapshot("another-host", snapshot)).toBeNull();
    expect(parseComputeNodeSnapshot("desktop-host", {
      ...snapshot,
      schema_version: "compute_node_snapshot.v3",
    })).toBeNull();
  });

  it("accepts v2 only when the shared-host owner identity and epoch are present", () => {
    const v2 = {
      ...snapshot,
      schema_version: "compute_node_snapshot.v2",
      host_owner_id: "host-owner-stable",
      host_owner_epoch: 7,
    };

    expect(parseComputeNodeSnapshot("desktop-host", v2)).not.toBeNull();
    expect(parseComputeNodeSnapshot("desktop-host", {
      ...v2,
      host_owner_epoch: 0,
    })).toBeNull();
    expect(parseComputeNodeSnapshot("desktop-host", {
      ...v2,
      host_owner_id: undefined,
    })).toBeNull();
  });
});
