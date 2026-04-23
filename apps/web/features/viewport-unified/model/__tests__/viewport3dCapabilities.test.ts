import { describe, expect, it } from "vitest";

import {
  controlStateFromCapability,
  resolveViewport3DCapabilities,
} from "../viewport3dCapabilities";

describe("resolveViewport3DCapabilities", () => {
  it("marks preview-dependent capabilities as disabled when preview_3d is unavailable", () => {
    const resolved = resolveViewport3DCapabilities({
      capabilities: null,
    });

    expect(resolved.preview3d.enabled).toBe(false);
    expect(resolved.preview3d.reason).toContain("preview_3d");
    expect(resolved.structuredGrid.enabled).toBe(false);
    expect(resolved.explicitTopology.enabled).toBe(false);
    expect(resolved.clip.enabled).toBe(false);
  });

  it("returns structured_grid and explicit_topology availability independently", () => {
    const resolved = resolveViewport3DCapabilities({
      capabilities: {
        preview_2d: true,
        preview_3d: true,
        structured_grid: true,
        explicit_topology: false,
        binary_fields: true,
        cell_fields: true,
        node_fields: true,
        scalar_history: false,
        eigen_modes: false,
        gpu_telemetry: false,
        algorithms_available: [],
      },
    });

    expect(resolved.preview3d.enabled).toBe(true);
    expect(resolved.structuredGrid.enabled).toBe(true);
    expect(resolved.explicitTopology.enabled).toBe(false);
    expect(resolved.explicitTopology.reason).toContain("explicit_topology");
  });

  it("gates authoring with explicit topology and authoring mode", () => {
    const resolved = resolveViewport3DCapabilities({
      capabilities: {
        preview_2d: true,
        preview_3d: true,
        structured_grid: false,
        explicit_topology: true,
        binary_fields: true,
        cell_fields: true,
        node_fields: true,
        scalar_history: false,
        eigen_modes: false,
        gpu_telemetry: false,
        algorithms_available: [],
      },
      authoringEnabled: false,
    });

    expect(resolved.authoringPrimitives.enabled).toBe(false);
    expect(resolved.authoringPrimitives.reason).toContain("Geometry Authoring");
  });
});

describe("controlStateFromCapability", () => {
  it("maps capability to disabled/inactive control state", () => {
    expect(controlStateFromCapability({ enabled: true })).toBe("inactive");
    expect(controlStateFromCapability({ enabled: false, reason: "x" })).toBe("disabled");
  });
});

