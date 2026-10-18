import { describe, expect, it } from "vitest";

import { ControlRoomApiError } from "../api/ControlRoomApi";
import type { CommandDetailResource, ComputeNodesResource } from "../api/apiTypes";
import * as runtimeResources from "./runtimeExplorerResources";

describe("compute-node inventory resource revision", () => {
  it("changes when the published host snapshot changes", () => {
    const makeResource = (inventoryRevision: number): ComputeNodesResource => ({
      schema_version: "compute_nodes.v1",
      state: "current",
      stale_after_seconds: 30,
      nodes: [{
        node_id: "desktop-host",
        state: "current",
        stale_after_seconds: 30,
        snapshot: { inventory_revision: inventoryRevision } as unknown as ComputeNodesResource["nodes"][number]["snapshot"],
      }],
    });
    const resolveRevision = runtimeResources.computeNodesResourceRevision;

    expect(resolveRevision(makeResource(2))).not.toBe(resolveRevision(makeResource(3)));
  });

  it("changes when the operator policy revision changes independently of inventory", () => {
    const makeResource = (revision: number): ComputeNodesResource => ({
      schema_version: "compute_nodes.v1",
      state: "current",
      stale_after_seconds: 30,
      nodes: [{
        node_id: "desktop-host",
        state: "current",
        stale_after_seconds: 30,
        snapshot: { inventory_revision: 2 } as unknown as ComputeNodesResource["nodes"][number]["snapshot"],
        node_policy: {
          policy: { revision } as unknown as NonNullable<
            ComputeNodesResource["nodes"][number]["node_policy"]
          >["policy"],
          status: {
            revision,
            active_workers: 1,
            draining: false,
            over_budget: false,
            blocking_reasons: [],
          },
        },
      }],
    });
    const resolveRevision = runtimeResources.computeNodesResourceRevision;

    expect(resolveRevision(makeResource(3))).not.toBe(resolveRevision(makeResource(4)));
  });
});

describe("runtime Explorer command detail resources", () => {
  it("preserves each command detail revision, missing state, and error independently", async () => {
    const loadRuntimeCommandDetailEntries = (
      runtimeResources as typeof runtimeResources & {
        loadRuntimeCommandDetailEntries?: (
          commandIds: readonly string[],
          load: (commandId: string) => Promise<CommandDetailResource>,
        ) => Promise<unknown[]>;
      }
    ).loadRuntimeCommandDetailEntries;

    expect(loadRuntimeCommandDetailEntries).toBeTypeOf("function");
    if (!loadRuntimeCommandDetailEntries) return;

    const entries = await loadRuntimeCommandDetailEntries(
      ["ready", "missing", "failed"],
      async (commandId) => {
        if (commandId === "missing") {
          throw new ControlRoomApiError("not found", 404);
        }
        if (commandId === "failed") {
          throw new ControlRoomApiError("request failed", 503);
        }
        return {
          command_id: commandId,
          created_at_unix_ms: 1,
          kind: "run",
          seq: 7,
          status: "running",
        };
      },
    );

    expect(entries).toEqual([
      expect.objectContaining({ commandId: "ready", missing: false, revision: 7, status: "ready" }),
      expect.objectContaining({ commandId: "missing", missing: true, revision: null, status: "unavailable" }),
      expect.objectContaining({ commandId: "failed", error: "request failed", missing: false, revision: null, status: "error" }),
    ]);
  });
});
