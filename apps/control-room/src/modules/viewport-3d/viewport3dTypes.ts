import type { ColorRepresentation } from "three";

export interface Viewport3DColors {
  accent: ColorRepresentation;
  background: ColorRepresentation;
  field: ColorRepresentation;
  mesh: ColorRepresentation;
  wire: ColorRepresentation;
}

export const VIEWPORT_3D_FRAMELOOP = "demand" as const;
