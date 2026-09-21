import { describe, expect, it } from "vitest";
import { initialMeshBuildDialogState, meshBuildDialogReducer as reduce } from "./meshBuildDialogState";

function submitting() {
  let state = reduce(initialMeshBuildDialogState, { type: "request", request: { commandId: "mesh.build-selected", requestId: "request-a", source: "inspector" } });
  state = reduce(state, { type: "submitting" });
  return reduce(state, { type: "accepted", event: { commandId: "command-a", requestId: "request-a", targetKind: "object_mesh", objectId: "object-a", reason: "selected-object" } });
}
const completed = { commandId: "command-a", requestId: "request-a", status: "completed" as const, meshRevision: 11 };

describe("authoritative mesh dialog lifecycle", () => {
  it("does not complete from old, foreign, or early viewport delivery", () => {
    const state = submitting();
    expect(reduce(state, { type: "rendered", revision: 10 }).phase).toBe("submitting");
    expect(reduce(state, { type: "observed", event: { ...completed, commandId: "other" } })).toBe(state);
    expect(reduce(state, { type: "observed", event: { ...completed, requestId: "other" } })).toBe(state);
  });
  it("separates publication from rendering the exact revision", () => {
    let state = reduce(submitting(), { type: "observed", event: completed });
    expect(state.phase).toBe("post-build");
    expect(state.lastCommandStatus).toBe("published");
    state = reduce(state, { type: "rendered", revision: 10 });
    expect(state.lastCommandStatus).toBe("published");
    expect(reduce(state, { type: "rendered", revision: "11" }).lastCommandStatus).toBe("rendered");
  });
  it("never overwrites failure with rendered or late completion", () => {
    const state = reduce(submitting(), { type: "observed", event: { ...completed, status: "failed", message: "Mesher failed" } });
    expect(reduce(state, { type: "rendered", revision: 12 })).toBe(state);
    expect(reduce(state, { type: "observed", event: completed })).toBe(state);
  });
  it("closing observation preserves terminal correlation without reopening", () => {
    const state = reduce(submitting(), { type: "open", open: false });
    const result = reduce(state, { type: "observed", event: completed });
    expect(result.open).toBe(false);
    expect(result.phase).toBe("post-build");
  });
  it("keeps disconnected observation pending until the server result arrives", () => {
    const state = reduce(submitting(), { type: "observed", event: { ...completed, status: "pending", observation: "disconnected" } });
    expect(state.phase).toBe("waiting");
    expect(reduce(state, { type: "observed", event: completed }).phase).toBe("post-build");
  });
});