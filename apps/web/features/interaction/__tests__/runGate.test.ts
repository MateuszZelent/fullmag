import { describe, expect, it } from "vitest";
import { deriveRunGate } from "../model/runGate";
import { INITIAL_DIRTY_GRAPH, dirtyGraphReducer } from "../model/dirtyGraph";
import type { DirtyGraphState, DirtyGraphAction } from "../model/dirtyGraph";

function apply(state: DirtyGraphState, ...actions: DirtyGraphAction[]): DirtyGraphState {
  return actions.reduce(dirtyGraphReducer, state);
}

describe("deriveRunGate", () => {
  it("blocks run when mesh is missing", () => {
    const gate = deriveRunGate(INITIAL_DIRTY_GRAPH);
    expect(gate.canRun).toBe(false);
    expect(gate.blockers.some((b) => b.id === "mesh.missing")).toBe(true);
  });

  it("blocks run when mesh is stale", () => {
    const built = apply(
      INITIAL_DIRTY_GRAPH,
      { type: "mesh.build.started" },
      { type: "mesh.build.completed", revision: "m1" },
      { type: "initialState.realize.started" },
      { type: "initialState.realize.completed", revision: "is1" },
    );
    const stale = apply(built, {
      type: "geometry.changed",
      transactionId: "tx",
      label: "moved",
    });
    const gate = deriveRunGate(stale);
    expect(gate.canRun).toBe(false);
    expect(gate.blockers.some((b) => b.id === "mesh.stale")).toBe(true);
  });

  it("blocks run when initial state is missing", () => {
    const built = apply(
      INITIAL_DIRTY_GRAPH,
      { type: "mesh.build.started" },
      { type: "mesh.build.completed", revision: "m1" },
    );
    const gate = deriveRunGate(built);
    expect(gate.canRun).toBe(false);
    expect(gate.blockers.some((b) => b.id === "initialState.stale")).toBe(true);
  });

  it("allows run when mesh + initialState are valid", () => {
    const ready = apply(
      INITIAL_DIRTY_GRAPH,
      { type: "mesh.build.started" },
      { type: "mesh.build.completed", revision: "m1" },
      { type: "initialState.realize.started" },
      { type: "initialState.realize.completed", revision: "is1" },
    );
    const gate = deriveRunGate(ready);
    expect(gate.canRun).toBe(true);
    expect(gate.canRelax).toBe(true);
    expect(gate.blockers.filter((b) => b.severity === "error")).toHaveLength(0);
  });

  it("provides action to fix stale mesh", () => {
    const built = apply(
      INITIAL_DIRTY_GRAPH,
      { type: "mesh.build.started" },
      { type: "mesh.build.completed", revision: "m1" },
    );
    const stale = apply(built, {
      type: "geometry.changed",
      transactionId: "tx",
      label: "moved",
    });
    const gate = deriveRunGate(stale);
    const meshBlocker = gate.blockers.find((b) => b.id === "mesh.stale");
    expect(meshBlocker?.action?.commandId).toBe("mesh.build.all");
  });

  it("warns about stale results without blocking", () => {
    const ready = apply(
      INITIAL_DIRTY_GRAPH,
      { type: "mesh.build.started" },
      { type: "mesh.build.completed", revision: "m1" },
      { type: "initialState.realize.started" },
      { type: "initialState.realize.completed", revision: "is1" },
      { type: "results.run.started" },
      { type: "results.run.completed", revision: "r1" },
      { type: "physics.changed", transactionId: "tx", label: "changed alpha" },
    );
    const gate = deriveRunGate(ready);
    expect(gate.canRun).toBe(true); // warning only
    expect(gate.blockers.some((b) => b.id === "results.stale" && b.severity === "warning")).toBe(true);
  });
});
