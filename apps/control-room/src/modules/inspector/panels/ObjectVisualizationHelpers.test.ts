import { describe, expect, it } from "vitest";

import {
  selectObjectVisualizationManifestStatus,
  selectObjectVisualizationPanelSnapshot,
} from "./ObjectVisualizationHelpers";
import { resolveSessionDiscretization } from "@/kernel/resources/sessionDiscretization";

import type { VisualizationTargetRef } from "@/kernel/visualization/ObjectVisualizationController";

describe("selectObjectVisualizationManifestStatus", () => {
  it("fails closed without throwing when a runtime status omits capabilities", () => {
    const status = selectObjectVisualizationManifestStatus({
      data: {
        domain: { discretization: "fdm" },
        resources: {},
      } as never,
    });

    expect(status).toEqual({
      capabilities: { explicit_topology: false },
      domain: { discretization: "fdm" },
      resources: { mesh_revision: undefined },
      session: { session_epoch: "", session_id: "" },
    });
  });

  it("preserves resolved FEM when the projected legacy domain remains FDM", () => {
    const status = selectObjectVisualizationManifestStatus({
      data: {
        capabilities: {
          explicit_topology: false,
          active_lane: { resolved: { discretization: "fem" } },
        },
        domain: { discretization: "fdm" },
        resources: { mesh_revision: 3 },
        session: { session_epoch: 2, session_id: "session-a" },
      },
    } as never);

    expect(resolveSessionDiscretization(status)).toBe("fem");
  });

  it("preserves an explicit unresolved lane instead of falling back to FDM", () => {
    const status = selectObjectVisualizationManifestStatus({
      data: {
        capabilities: {
          explicit_topology: false,
          active_lane: null,
        },
        domain: { discretization: "fdm" },
        resources: { mesh_revision: 3 },
        session: { session_epoch: 2, session_id: "session-a" },
      },
    } as never);

    expect(resolveSessionDiscretization(status)).toBeNull();
  });
});

describe("selectObjectVisualizationPanelSnapshot", () => {
  it("keeps pending target patches in the inspector projection", () => {
    const target: VisualizationTargetRef = {
      id: "object:film",
      kind: "object",
      label: "Film",
    };
    const pending = {
      baseRevision: 3,
      patch: { shaderVisible: true },
      target,
      transactionId: "tx-film-shader",
    } as const;

    const projected = selectObjectVisualizationPanelSnapshot(
      {
        defaults: {},
        overrides: {},
        pendingOverrides: { "object:film": pending },
        version: 4,
      },
      [target],
    );

    expect(projected.pendingOverrides).toEqual({ "object:film": pending });
  });
});
