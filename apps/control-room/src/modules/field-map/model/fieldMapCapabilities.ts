export interface FieldMapCapability {
  enabled: boolean;
  reasonCode: string | null;
}

export function resolveFieldMapCapabilities(input: {
  meshOverlayAvailable: boolean;
  spatial: boolean;
  vectorComponents: number;
}) {
  const unsupported = (reasonCode: string): FieldMapCapability => ({
    enabled: false,
    reasonCode,
  });
  return {
    contours: input.spatial
      ? { enabled: true, reasonCode: null }
      : unsupported("quantity_not_spatial"),
    mesh: input.meshOverlayAvailable
      ? { enabled: true, reasonCode: null }
      : unsupported("mesh_overlay_unavailable"),
    vectors:
      input.spatial && input.vectorComponents >= 2
        ? { enabled: true, reasonCode: null }
        : unsupported(
            input.spatial ? "quantity_not_vector" : "quantity_not_spatial",
          ),
  };
}
