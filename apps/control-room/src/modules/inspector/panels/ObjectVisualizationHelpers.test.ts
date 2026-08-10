import { describe, expect, it } from "vitest";

import {
  selectObjectVisualizationManifestStatus,
  selectObjectVisualizationPanelSnapshot,
} from "./ObjectVisualizationHelpers";

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
    });
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
