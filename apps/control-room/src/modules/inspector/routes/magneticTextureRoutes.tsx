import { MagneticTextureInspectorPanel } from "../panels/magnetic-texture/MagneticTextureInspectorPanel";

import { defineInspectorRoute, type InspectorRoute } from "./routeTypes";

/**
 * Canonical Wave 3 (Volume II) domain route registry: Magnetic Texture subsystem (2 routes).
 */
export const MAGNETIC_TEXTURE_ROUTES: readonly InspectorRoute[] = [
  defineInspectorRoute({
    component: MagneticTextureInspectorPanel,
    id: "object-magnetic-texture",
    selectionKinds: ["object.magnetic-texture"],
    title: "Magnetic Texture",
  }),
  defineInspectorRoute({
    component: MagneticTextureInspectorPanel,
    id: "object-region-texture",
    selectionKinds: ["object.region.texture"],
    title: "Region Texture",
  }),
];
