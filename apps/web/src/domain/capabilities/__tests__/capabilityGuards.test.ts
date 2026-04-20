import { describe, it, expect } from "vitest";
import {
  shouldFetchTopology,
  shouldFetchCoordinates,
  canShowWireframe,
  canShowGridDimensions,
  getAvailableAlgorithms,
} from "../capabilityGuards";
import type { CapabilityMap } from "../../../api/types";

function makeCaps(overrides?: Partial<CapabilityMap>): CapabilityMap {
  return {
    explicit_topology: false,
    implicit_coordinates: true,
    structured_grid: true,
    binary_field_transport: true,
    binary_topology_transport: false,
    eigen_spectrum: false,
    eigen_dispersion: false,
    frequency_response: false,
    algorithms_available: ["rk45", "euler"],
    discretization: "fdm",
    device: "cpu",
    precision: "double",
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

  // ── shouldFetchCoordinates ───────────────────────────────────────

  it("shouldFetchCoordinates returns true when implicit_coordinates is false", () => {
    expect(
      shouldFetchCoordinates(makeCaps({ implicit_coordinates: false })),
    ).toBe(true);
  });

  it("shouldFetchCoordinates returns false when implicit_coordinates is true", () => {
    expect(
      shouldFetchCoordinates(makeCaps({ implicit_coordinates: true })),
    ).toBe(false);
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
});
