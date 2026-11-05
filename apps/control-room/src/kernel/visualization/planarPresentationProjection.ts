import type { VisualizationStateResource } from "../api/apiTypes";

type VisualizationState = VisualizationStateResource;
type Planar = NonNullable<VisualizationState["planar"]>;

/**
 * Identity controls select data and must wait for the server-owned resource.
 * Presentation controls can render from the shared optimistic patch immediately.
 */
export function projectPlanarPresentationState(
  data: VisualizationState | null | undefined,
  optimisticData: VisualizationState | null | undefined,
  options: {
    /**
     * True when switching between the authoritative and the optimistic
     * component is computed client-side from data already in memory; the
     * component is then presentation, not sample identity (D2D-12).
     */
    clientComponent?: (authoritative: string, optimistic: string) => boolean;
  } = {},
): Planar | null {
  const authoritative = data?.planar;
  if (!authoritative) return null;
  const optimistic = optimisticData?.planar;
  if (!optimistic) return authoritative;

  return {
    ...authoritative,
    component: options.clientComponent?.(authoritative.component, optimistic.component)
      ? optimistic.component
      : authoritative.component,
    visible: optimistic.visible,
    colormap: optimistic.colormap,
    display_unit: optimistic.display_unit,
    interaction: optimistic.interaction,
    layers: optimistic.layers,
    point_style: optimistic.point_style,
    range: optimistic.range,
    raster_opacity: optimistic.raster_opacity,
    vector_style: optimistic.vector_style,
    viewport_colorbar_visible: optimistic.viewport_colorbar_visible,
    target_overrides: optimistic.target_overrides ?? authoritative.target_overrides,
    ...(authoritative.field_overlays ? {
      field_overlays: authoritative.field_overlays.flatMap((layer) => {
        const pending = optimistic.field_overlays?.find((entry) => entry.id === layer.id);
        if (!pending) return optimistic.field_overlays ? [] : [layer];
        if (pending.quantity_id !== layer.quantity_id || pending.component !== layer.component ||
            JSON.stringify(pending.view_scope) !== JSON.stringify(layer.view_scope)) return [layer];
        return [{ ...layer, colormap: pending.colormap, range: pending.range,
          raster_opacity: pending.raster_opacity, raster_visible: pending.raster_visible,
          vectors_visible: pending.vectors_visible, vector_style: pending.vector_style }];
      }),
    } : {}),
    wireframe_style: optimistic.wireframe_style,
  };
}
