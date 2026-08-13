export interface PlanarInteraction {
  panU: number;
  panV: number;
  zoom: number;
}

export function fitPlanarInteraction(): PlanarInteraction {
  return { panU: 0, panV: 0, zoom: 1 };
}

export function panPlanarInteraction(
  interaction: PlanarInteraction,
  deltaU: number,
  deltaV: number,
): PlanarInteraction {
  return {
    panU: interaction.panU + deltaU,
    panV: interaction.panV + deltaV,
    zoom: interaction.zoom,
  };
}

export function zoomPlanarInteractionAt(
  bounds: readonly [number, number, number, number],
  interaction: PlanarInteraction,
  u: number,
  v: number,
  zoom: number,
): PlanarInteraction {
  const nextZoom = Math.max(1e-12, zoom);
  const centerU = (bounds[0] + bounds[1]) / 2 + interaction.panU;
  const centerV = (bounds[2] + bounds[3]) / 2 + interaction.panV;
  const nextCenterU = u + (centerU - u) * interaction.zoom / nextZoom;
  const nextCenterV = v + (centerV - v) * interaction.zoom / nextZoom;
  return {
    panU: nextCenterU - (bounds[0] + bounds[1]) / 2,
    panV: nextCenterV - (bounds[2] + bounds[3]) / 2,
    zoom: nextZoom,
  };
}
