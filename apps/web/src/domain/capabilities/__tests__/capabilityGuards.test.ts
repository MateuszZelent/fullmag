import { describe, it, expect } from "vitest";
import {
  shouldFetchTopology,
  canShowWireframe,
  canShowGridDimensions,
  getAvailableAlgorithms,
  synthesizeCapabilitiesFromDiscretization,
  isFemDiscretization,
  isFdmDiscretization,
  resolveFemDiscretization,
} from "../capabilityGuards";
import type { CapabilityMap } from "../../../api/types";

function makeCaps(overrides?: Partial<CapabilityMap>): CapabilityMap {
  return {
    explicit_topology: false,
    structured_grid: true,
    binary_fields: true,
    cell_fields: true,
    node_fields: false,
    scalar_history: true,
    eigen_modes: false,
    gpu_telemetry: false,
    preview_2d: true,
    preview_3d: true,
    algorithms_available: ["rk45", "euler"],
    ...overrides,
  };
}

describe("capabilityGuards", () => {
  // ── shouldFetchTopology ──────────────────────────────────────────

  it("shouldFetchTopology returns true when explicit_topology is true", () => {
    expect(shouldFetchTopology(makeCaps({ explicit_topology: true }))).toBe(
      true,
    );
  });

  it("shouldFetchTopology returns false when explicit_topology is false", () => {
    expect(shouldFetchTopology(makeCaps({ explicit_topology: false }))).toBe(
      false,
    );
  });

  // ── canShowWireframe ─────────────────────────────────────────────

  it("canShowWireframe depends on explicit_topology", () => {
    expect(canShowWireframe(makeCaps({ explicit_topology: true }))).toBe(true);
    expect(canShowWireframe(makeCaps({ explicit_topology: false }))).toBe(
      false,
    );
  });

  // ── canShowGridDimensions ────────────────────────────────────────

  it("canShowGridDimensions depends on structured_grid", () => {
    expect(canShowGridDimensions(makeCaps({ structured_grid: true }))).toBe(
      true,
    );
    expect(canShowGridDimensions(makeCaps({ structured_grid: false }))).toBe(
      false,
    );
  });

  // ── getAvailableAlgorithms ───────────────────────────────────────

  it("getAvailableAlgorithms returns the list from capabilities", () => {
    const algos = getAvailableAlgorithms(
      makeCaps({ algorithms_available: ["rk45", "euler", "heun"] }),
    );
    expect(algos).toEqual(["rk45", "euler", "heun"]);
  });

  it("getAvailableAlgorithms returns empty list when none available", () => {
    expect(
      getAvailableAlgorithms(makeCaps({ algorithms_available: [] })),
    ).toEqual([]);
  });

  it("synthesizeCapabilitiesFromDiscretization returns FEM-shaped capabilities", () => {
    expect(synthesizeCapabilitiesFromDiscretization(true)).toMatchObject({
      explicit_topology: true,
      structured_grid: false,
      node_fields: true,
      cell_fields: false,
    });
  });

  it("synthesizeCapabilitiesFromDiscretization returns FDM-shaped capabilities", () => {
    expect(synthesizeCapabilitiesFromDiscretization(false)).toMatchObject({
      explicit_topology: false,
      structured_grid: true,
      node_fields: false,
      cell_fields: true,
    });
  });

  it("isFemDiscretization and isFdmDiscretization follow canonical capabilities", () => {
    expect(isFemDiscretization(makeCaps({ explicit_topology: true }))).toBe(
      true,
    );
    expect(isFdmDiscretization(makeCaps({ structured_grid: true }))).toBe(
      true,
    );
  });

  it("resolveFemDiscretization prefers canonical capabilities over legacy fallback", () => {
    expect(
      resolveFemDiscretization(
        makeCaps({ explicit_topology: true, structured_grid: false }),
        false,
      ),
    ).toBe(true);
  });

  it("resolveFemDiscretization falls back to legacy boolean when capabilities are missing", () => {
    expect(resolveFemDiscretization(null, true)).toBe(true);
    expect(resolveFemDiscretization(undefined, false)).toBe(false);
  });
});
