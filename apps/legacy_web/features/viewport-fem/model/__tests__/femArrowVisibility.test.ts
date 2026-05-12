/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it } from "vitest";

import { resolveArrowVisibility } from "../femArrowVisibility";
import type { ResolveArrowVisibilityInput } from "../femArrowVisibility";

function baseInput(overrides?: Partial<ResolveArrowVisibilityInput>): ResolveArrowVisibilityInput {
  return {
    isFemBackend: true,
    effectiveViewMode: "3D",
    femHasFieldData: true,
    meshShowArrows: true,
    diagnosticForceHideArrows: false,
    ...overrides,
  };
}

describe("resolveArrowVisibility", () => {
  it("returns visible when all conditions met", () => {
    const result = resolveArrowVisibility(baseInput());
    expect(result).toEqual({ requested: true, visible: true, reason: null });
  });

  it("returns not_fem_backend when backend is not FEM", () => {
    const result = resolveArrowVisibility(baseInput({ isFemBackend: false }));
    expect(result.visible).toBe(false);
    expect(result.reason).toBe("not_fem_backend");
    expect(result.requested).toBe(true);
  });

  it("returns not_3d_view when view mode is 2D", () => {
    const result = resolveArrowVisibility(baseInput({ effectiveViewMode: "2D" }));
    expect(result.visible).toBe(false);
    expect(result.reason).toBe("not_3d_view");
  });

  it("returns not_3d_view when view mode is Mesh", () => {
    const result = resolveArrowVisibility(baseInput({ effectiveViewMode: "Mesh" }));
    expect(result.visible).toBe(false);
    expect(result.reason).toBe("not_3d_view");
  });

  it("returns no_field_data when field data absent", () => {
    const result = resolveArrowVisibility(baseInput({ femHasFieldData: false }));
    expect(result.visible).toBe(false);
    expect(result.reason).toBe("no_field_data");
  });

  it("returns user_disabled when user toggled off", () => {
    const result = resolveArrowVisibility(baseInput({ meshShowArrows: false }));
    expect(result.visible).toBe(false);
    expect(result.reason).toBe("user_disabled");
    expect(result.requested).toBe(false);
  });

  it("returns diagnostic_force_hidden when flag is set", () => {
    const result = resolveArrowVisibility(baseInput({ diagnosticForceHideArrows: true }));
    expect(result.visible).toBe(false);
    expect(result.reason).toBe("diagnostic_force_hidden");
    expect(result.requested).toBe(true);
  });

  it("diagnostic flag takes priority over user toggle", () => {
    const result = resolveArrowVisibility(
      baseInput({ diagnosticForceHideArrows: true, meshShowArrows: false }),
    );
    expect(result.reason).toBe("diagnostic_force_hidden");
  });

  it("not_fem_backend takes priority over not_3d_view", () => {
    const result = resolveArrowVisibility(
      baseInput({ isFemBackend: false, effectiveViewMode: "2D" }),
    );
    expect(result.reason).toBe("not_fem_backend");
  });
});
