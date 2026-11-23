import {
  LEGACY_SELECTION_KIND_REDIRECTS,
  resolveCanonicalSelection,
  resolveCanonicalSelectionKind,
} from "@/kernel/selection/legacySelectionRedirects";

import { PlaceholderPanel } from "./panels/PlaceholderPanel";
import { MAGNETIC_TEXTURE_ROUTES } from "./routes/magneticTextureRoutes";
import { MESH_ANTENNA_ROUTES } from "./routes/meshAntennaRoutes";
import { MODEL_PHYSICS_ROUTES } from "./routes/modelPhysicsRoutes";
import {
  defineInspectorRoute,
  type InspectorRoute,
  type InspectorRouteId,
} from "./routes/routeTypes";
import {
  CANONICAL_FREQUENCY_DOMAIN_SELECTION_KINDS,
  STUDY_RESULTS_START_ROUTES,
} from "./routes/studyResultsStartRoutes";

export type { InspectorRoute, InspectorRouteId };
export {
  LEGACY_SELECTION_KIND_REDIRECTS,
  resolveCanonicalSelection,
  resolveCanonicalSelectionKind,
};

export const FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS =
  CANONICAL_FREQUENCY_DOMAIN_SELECTION_KINDS;

export const FALLBACK_INSPECTOR_ROUTE: InspectorRoute = defineInspectorRoute({
  component: PlaceholderPanel,
  id: "placeholder",
  selectionKinds: ["*"],
  title: "Selection",
});

/**
 * Canonical 162-route Inspector catalog composed once from the 4 disjoint
 * parallel domain registries (`2 + 31 + 35 + 93 + 1 = 162`).
 */
export const INSPECTOR_ROUTES: readonly InspectorRoute[] = Object.freeze([
  ...MAGNETIC_TEXTURE_ROUTES,
  ...MODEL_PHYSICS_ROUTES,
  ...MESH_ANTENNA_ROUTES,
  ...STUDY_RESULTS_START_ROUTES,
  FALLBACK_INSPECTOR_ROUTE,
]);

const INSPECTOR_ROUTES_BY_KIND = new Map<string, InspectorRoute>();

for (const route of INSPECTOR_ROUTES) {
  if (route === FALLBACK_INSPECTOR_ROUTE) continue;
  for (const kind of route.selectionKinds) {
    if (INSPECTOR_ROUTES_BY_KIND.has(kind)) {
      throw new Error(`Duplicate inspector route for ${kind}`);
    }
    INSPECTOR_ROUTES_BY_KIND.set(kind, route);
  }
}

export function resolveInspectorRoute(
  kind: string,
  options: { followRedirects?: boolean } = {},
): InspectorRoute | null {
  const direct = INSPECTOR_ROUTES_BY_KIND.get(kind);
  if (direct) return direct;
  if (options.followRedirects === false) return null;
  const redirectedKind = LEGACY_SELECTION_KIND_REDIRECTS[kind];
  return redirectedKind
    ? (INSPECTOR_ROUTES_BY_KIND.get(redirectedKind) ?? null)
    : null;
}

export function resolveUnknownInspectorRoute(): InspectorRoute {
  return FALLBACK_INSPECTOR_ROUTE;
}
