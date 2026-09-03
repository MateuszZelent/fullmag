import { describe, expect, it } from "vitest";
import {
  dirtyGraphReducer,
  INITIAL_DIRTY_GRAPH,
} from "../model/dirtyGraph";
import type { DirtyGraphState, DirtyGraphAction } from "../model/dirtyGraph";

function apply(state: DirtyGraphState, ...actions: DirtyGraphAction[]): DirtyGraphState {
  return actions.reduce(dirtyGraphReducer, state);
}

describe("dirtyGraphReducer", () => {
  describe("geometry.changed", () => {
    it("makes mesh and downstream stale", () => {
      // Build a mesh and realize initial state, then run to get results valid
      const built = apply(
        INITIAL_DIRTY_GRAPH,
        { type: "mesh.build.started" },
        { type: "mesh.build.completed", revision: "mesh-1" },
        { type: "initialState.realize.started" },
        { type: "initialState.realize.completed", revision: "is-1" },
        { type: "results.run.started" },
        { type: "results.run.completed", revision: "run-1" },
      );

      const after = apply(built, {
        type: "geometry.changed",
        transactionId: "tx-1",
        label: "Moved object",
      });

      expect(after.mesh.status).toBe("stale");
      expect(after.initialState.status).toBe("stale");
      expect(after.results.status).toBe("stale");
    });

    it("keeps mesh as missing if it was never built", () => {
      const after = apply(INITIAL_DIRTY_GRAPH, {
        type: "geometry.changed",
        transactionId: "tx-1",
        label: "Added object",
      });

      expect(after.mesh.status).toBe("missing");
    });
  });

  describe("magnetization.changed — ADR-005", () => {
    it("does NOT invalidate mesh", () => {
      const built = apply(
        INITIAL_DIRTY_GRAPH,
        { type: "mesh.build.started" },
        { type: "mesh.build.completed", revision: "mesh-1" },
      );

      const after = apply(built, {
        type: "magnetization.changed",
        transactionId: "tx-2",
        label: "Changed to vortex",
      });

      expect(after.mesh.status).toBe("valid");
      expect(after.mesh.revision).toBe("mesh-1");
    });

    it("invalidates initialState", () => {
      const built = apply(
        INITIAL_DIRTY_GRAPH,
        { type: "mesh.build.started" },
        { type: "mesh.build.completed", revision: "mesh-1" },
        { type: "initialState.realize.started" },
        { type: "initialState.realize.completed", revision: "is-1" },
      );

      const after = apply(built, {
        type: "magnetization.changed",
        transactionId: "tx-2",
        label: "Changed to vortex",
      });

      expect(after.initialState.status).toBe("stale");
    });
  });

  describe("mesh lifecycle", () => {
    it("mesh.build.started sets building", () => {
      const after = apply(INITIAL_DIRTY_GRAPH, { type: "mesh.build.started" });
      expect(after.mesh.status).toBe("building");
    });

    it("mesh.build.completed sets valid + stales initialState", () => {
      const after = apply(
        INITIAL_DIRTY_GRAPH,
        { type: "mesh.build.started" },
        { type: "mesh.build.completed", revision: "mesh-1" },
      );
      expect(after.mesh.status).toBe("valid");
      expect(after.mesh.revision).toBe("mesh-1");
      expect(after.initialState.status).toBe("stale");
    });

    it("mesh.build.failed sets error", () => {
      const after = apply(
        INITIAL_DIRTY_GRAPH,
        { type: "mesh.build.started" },
        { type: "mesh.build.failed", error: "Bad geometry" },
      );
      expect(after.mesh.status).toBe("error");
      expect(after.mesh.reason).toBe("Bad geometry");
    });
  });

  describe("initialState lifecycle", () => {
    it("realize.completed sets valid", () => {
      const after = apply(
        INITIAL_DIRTY_GRAPH,
        { type: "mesh.build.started" },
        { type: "mesh.build.completed", revision: "mesh-1" },
        { type: "initialState.realize.started" },
        { type: "initialState.realize.completed", revision: "is-1" },
      );
      expect(after.initialState.status).toBe("valid");
    });

    it("realize.failed sets error", () => {
      const after = apply(
        INITIAL_DIRTY_GRAPH,
        { type: "mesh.build.started" },
        { type: "mesh.build.completed", revision: "mesh-1" },
        { type: "initialState.realize.started" },
        { type: "initialState.realize.failed", error: "OOM" },
      );
      expect(after.initialState.status).toBe("error");
      expect(after.initialState.reason).toBe("OOM");
    });
  });

  describe("physics.changed", () => {
    it("only invalidates results", () => {
      const built = apply(
        INITIAL_DIRTY_GRAPH,
        { type: "mesh.build.started" },
        { type: "mesh.build.completed", revision: "mesh-1" },
        { type: "initialState.realize.started" },
        { type: "initialState.realize.completed", revision: "is-1" },
        { type: "results.run.started" },
        { type: "results.run.completed", revision: "run-1" },
      );

      const after = apply(built, {
        type: "physics.changed",
        transactionId: "tx-3",
        label: "Changed alpha",
      });

      expect(after.mesh.status).toBe("valid");
      expect(after.initialState.status).toBe("valid");
      expect(after.results.status).toBe("stale");
    });
  });

  describe("reset", () => {
    it("returns initial state", () => {
      const modified = apply(
        INITIAL_DIRTY_GRAPH,
        { type: "mesh.build.started" },
        { type: "mesh.build.completed", revision: "mesh-1" },
      );
      const after = apply(modified, { type: "reset" });
      expect(after).toEqual(INITIAL_DIRTY_GRAPH);
    });
  });
});
