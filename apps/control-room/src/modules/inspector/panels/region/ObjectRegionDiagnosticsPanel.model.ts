import { type RegionSubPanelProps } from "./shared";

export interface ObjectRegionDiagnosticsLaneView {
  realizationPolicy: string;
  realizationStatus: string;
}

export function resolveObjectRegionDiagnosticsLaneView(
  model: Pick<RegionSubPanelProps["model"], "realizationPolicy" | "realizationStatus">,
  meshLane: RegionSubPanelProps["meshLane"] = "unknown",
): ObjectRegionDiagnosticsLaneView {
  if (meshLane === "fdm") {
    return {
      realizationPolicy: "Runtime-derived structured-grid membership",
      realizationStatus: "Runtime-derived structured-grid membership",
    };
  }
  if (meshLane !== "fem") {
    return {
      realizationPolicy: "Withheld until the session discretization is explicit",
      realizationStatus: "Withheld until the session discretization is explicit",
    };
  }
  return {
    realizationPolicy: model.realizationPolicy ?? "inherit",
    realizationStatus: model.realizationStatus ?? "authored",
  };
}
