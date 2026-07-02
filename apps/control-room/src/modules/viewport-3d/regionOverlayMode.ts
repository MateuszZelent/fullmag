export type RegionOverlayMode =
  | "off"
  | "auto"
  | "authored"
  | "realized"
  | "both";

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
