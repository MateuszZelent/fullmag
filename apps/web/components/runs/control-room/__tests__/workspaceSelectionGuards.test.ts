import { describe, expect, it } from "vitest";
import {
  resolvePersistedWorkspaceSelection,
  resolveRemoteWorkspaceSelectionHydration,
  workspaceSelectionIdentity,
} from "../workspaceSelectionGuards";

describe("workspaceSelectionGuards", () => {
  it("normalizes missing selection fields into a stable identity", () => {
    expect(workspaceSelectionIdentity({ selected_node_id: "physics-solver" })).toBe(
      JSON.stringify(["physics-solver", null, null]),
    );
    expect(workspaceSelectionIdentity(null)).toBe(JSON.stringify([null, null, null]));
  });

  it("rejects stale backend hydration while a newer local tree click is pending", () => {
    const currentIdentity = workspaceSelectionIdentity({ selected_node_id: "physics-solver" });
    const remoteIdentity = workspaceSelectionIdentity({ selected_node_id: "study-root" });

    expect(
      resolveRemoteWorkspaceSelectionHydration({
        remoteIdentity,
        currentIdentity,
        pendingIdentity: currentIdentity,
      }),
    ).toEqual({ kind: "reject-stale-pending" });
  });

  it("confirms a pending local selection when backend hydration matches it", () => {
    const identity = workspaceSelectionIdentity({ selected_node_id: "objects" });

    expect(
      resolveRemoteWorkspaceSelectionHydration({
        remoteIdentity: identity,
        currentIdentity: identity,
        pendingIdentity: identity,
      }),
    ).toEqual({ kind: "confirm-pending" });
  });

  it("clears a partial pending identity when backend already matches the full current selection", () => {
    const currentIdentity = workspaceSelectionIdentity({
      selected_node_id: "objects/free/object-1",
      selected_object_id: "object-1",
    });
    const partialPendingIdentity = workspaceSelectionIdentity({
      selected_node_id: "objects/free/object-1",
    });

    expect(
      resolveRemoteWorkspaceSelectionHydration({
        remoteIdentity: currentIdentity,
        currentIdentity,
        pendingIdentity: partialPendingIdentity,
      }),
    ).toEqual({ kind: "confirm-pending" });
  });

  it("applies backend hydration when there is no pending local selection", () => {
    expect(
      resolveRemoteWorkspaceSelectionHydration({
        remoteIdentity: workspaceSelectionIdentity({ selected_node_id: "runtime-backend" }),
        currentIdentity: workspaceSelectionIdentity({ selected_node_id: null }),
        pendingIdentity: null,
      }),
    ).toEqual({ kind: "apply" });
  });

  it("accepts persisted responses only when they match the pending selection", () => {
    const pendingIdentity = workspaceSelectionIdentity({ selected_node_id: "study-stage-node:relax" });

    expect(
      resolvePersistedWorkspaceSelection({
        persistedIdentity: pendingIdentity,
        pendingIdentity,
      }),
    ).toEqual({ accepted: true, clearPending: true });

    expect(
      resolvePersistedWorkspaceSelection({
        persistedIdentity: workspaceSelectionIdentity({ selected_node_id: "study-root" }),
        pendingIdentity,
      }),
    ).toEqual({ accepted: false, clearPending: false });
  });
});
