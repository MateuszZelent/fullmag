import type { VisualizationStateResource } from "../api/apiTypes";

type VisualizationState = VisualizationStateResource;
type Planar = NonNullable<VisualizationState["planar"]>;
type FieldLayer = NonNullable<Planar["field_overlays"]>[number];

/**
 * Field layers as the inspector left them (ADR 0080): the optimistic list
 * order, added and removed layers, and every presentation flag show at once.
 * A layer whose sample identity (quantity, component, scope) changed keeps
 * its authoritative identity until the server acknowledges the new sample.
 */
function projectFieldLayers(
  authoritative: readonly FieldLayer[] | null | undefined,
  optimistic: readonly FieldLayer[] | null | undefined,
): FieldLayer[] {
  if (!optimistic) return authoritative ? [...authoritative] : [];
  return optimistic.map((pending) => {
    const layer = authoritative?.find((entry) => entry.id === pending.id);
    if (!layer) return pending;
    const base = pending.quantity_id !== layer.quantity_id || pending.component !== layer.component ||
      JSON.stringify(pending.view_scope) !== JSON.stringify(layer.view_scope)
      ? layer
      : { ...layer, colormap: pending.colormap, range: pending.range };
    return {
      ...base,
      contours_visible: pending.contours_visible,
      mesh_visible: pending.mesh_visible,
      points_visible: pending.points_visible,
      raster_opacity: pending.raster_opacity,
      raster_visible: pending.raster_visible,
      streamlines_visible: pending.streamlines_visible,
      vector_style: pending.vector_style,
      vectors_visible: pending.vectors_visible,
      visible: pending.visible,
    };
  });
}

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
    ...(authoritative.field_overlays || optimistic.field_overlays ? {
      field_overlays: projectFieldLayers(authoritative.field_overlays, optimistic.field_overlays),
    } : {}),
    wireframe_style: optimistic.wireframe_style,
  };
}
