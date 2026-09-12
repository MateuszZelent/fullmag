import { describe, expect, it } from "vitest";

import type { QuantityDescriptor } from "@/lib/session/types";
import { resolveViewport3DFieldRoles } from "../viewport3dFieldRoles";

function quantity(
  id: string,
  domain: QuantityDescriptor["domain"],
  dataAvailable = true,
): QuantityDescriptor {
  return {
    id,
    label: id,
    kind: "vector_field",
    unit: "",
    location: "node",
    available: true,
    data_available: dataAvailable,
    interactive_preview: true,
    quick_access_label: id,
    scalar_metric_key: null,
    n_comp: 3,
    domain,
    normalization_hint: "max_abs",
    supports_preview_2d: true,
    supports_preview_3d: true,
    supports_history: false,
    supports_export: true,
  };
}

describe("resolveViewport3DFieldRoles", () => {
  it("uses magnetization for magnetic texture even when an effective field is selected", () => {
    expect(
      resolveViewport3DFieldRoles({
        selectedQuantity: "H_eff",
        quantities: [quantity("m", "magnetic_only"), quantity("H_eff", "full_domain")],
        showQuantity: false,
        showMagneticTexture: true,
        vectorDomainFilter: "auto",
      }),
    ).toMatchObject({
      shaderQuantityId: "m",
      glyphQuantityId: "H_eff",
    });
  });

  it("does not use magnetization for airbox-only vectors", () => {
    expect(
      resolveViewport3DFieldRoles({
        selectedQuantity: "m",
        quantities: [quantity("m", "magnetic_only"), quantity("H_eff", "full_domain")],
        showQuantity: false,
        showMagneticTexture: true,
        vectorDomainFilter: "airbox_only",
      }).glyphQuantityId,
    ).toBe("H_eff");
  });

  it("returns no airbox vector quantity when no full-domain vector field is available", () => {
    expect(
      resolveViewport3DFieldRoles({
        selectedQuantity: "m",
        quantities: [quantity("m", "magnetic_only")],
        showQuantity: false,
        showMagneticTexture: true,
        vectorDomainFilter: "airbox_only",
      }).glyphQuantityId,
    ).toBeNull();
  });
});
