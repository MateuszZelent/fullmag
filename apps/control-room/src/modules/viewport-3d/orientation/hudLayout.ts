type HudAnchor = [number, number, number];

interface OrientationHudViewport {
  height: number;
  width: number;
}

const ORIENTATION_VIEW_CUBE_MARGIN_PX = 104;
const HSL_REFERENCE_MARGIN_PX = 96;

export function resolveOrientationHudAnchors({
  height,
  width,
}: OrientationHudViewport): {
  hslReference: HudAnchor;
  viewCube: HudAnchor;
} {
  return {
    hslReference: [
      -width / 2 + HSL_REFERENCE_MARGIN_PX,
      -height / 2 + HSL_REFERENCE_MARGIN_PX,
      0,
    ],
    viewCube: [
      width / 2 - ORIENTATION_VIEW_CUBE_MARGIN_PX,
      height / 2 - ORIENTATION_VIEW_CUBE_MARGIN_PX,
      0,
    ],
  };
}
