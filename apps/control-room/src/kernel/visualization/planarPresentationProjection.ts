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
): Planar | null {
  const authoritative = data?.planar;
  if (!authoritative) return null;
  const optimistic = optimisticData?.planar;
  if (!optimistic) return authoritative;

  return {
    ...authoritative,
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
    wireframe_style: optimistic.wireframe_style,
  };
}
