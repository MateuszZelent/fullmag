export type RegionOverlayMode =
  | "off"
  | "auto"
  | "authored"
  | "realized"
  | "both";

export type RegionDiagnosticOverlaySource = Exclude<RegionOverlayMode, "off">;

export interface RegionDiagnosticOverlayState {
  source: RegionDiagnosticOverlaySource;
  visible: boolean;
}

export const DEFAULT_REGION_DIAGNOSTIC_OVERLAY_STATE: RegionDiagnosticOverlayState = {
  source: "auto",
  visible: false,
};

export function regionDiagnosticOverlayMode(
  state: RegionDiagnosticOverlayState,
): RegionOverlayMode {
  return state.visible ? state.source : "off";
}

export function regionOverlayModeShowsAuthored(
  mode: RegionOverlayMode,
  hasMeshBackedRegions = false,
): boolean {
  if (mode === "off") return false;
  if (mode === "auto") return !hasMeshBackedRegions;
  return mode === "authored" || mode === "both";
}

export function regionOverlayModeShowsRealized(
  mode: RegionOverlayMode,
  hasMeshBackedRegions = false,
): boolean {
  if (mode === "off") return false;
  if (mode === "auto") return hasMeshBackedRegions;
  return mode === "realized" || mode === "both";
}
