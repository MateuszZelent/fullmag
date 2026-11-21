import type { InspectorDescriptor } from "./inspectorDescriptor";

/** Domain hue of the identity glyph (specs/frontend-v2/09 §1a). */
export function inspectorDomain(
  icon: InspectorDescriptor["icon"],
): "definition" | "geometry" | "mesh" | "study" | "visualization" {
  if (icon === "airbox" || icon === "mesh") return "mesh";
  if (icon === "analysis" || icon === "mode" || icon === "visualization") return "visualization";
  if (icon === "diagnostics") return "definition";
  if (icon === "study") return "study";
  return "geometry";
}

/** The user-facing ID shown in the header: the object ID, else the node ID. */
export function inspectorDisplayId(
  metadata: InspectorDescriptor["metadata"],
): string | undefined {
  return (
    metadata.find((item) => item.label === "Object")?.value ??
    metadata.find((item) => item.label === "Node")?.value
  );
}
