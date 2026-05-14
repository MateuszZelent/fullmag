import type { ColorRepresentation } from "three";

export interface Viewport3DColors {
  accent: ColorRepresentation;
  accentStrong?: ColorRepresentation;
  background: ColorRepresentation;
  danger?: ColorRepresentation;
  field: ColorRepresentation;
  mesh: ColorRepresentation;
  panel?: ColorRepresentation;
  panelRaised?: ColorRepresentation;
  success?: ColorRepresentation;
  textPrimary?: ColorRepresentation;
  textSecondary?: ColorRepresentation;
  wire: ColorRepresentation;
}

export const VIEWPORT_3D_FRAMELOOP = "demand" as const;
