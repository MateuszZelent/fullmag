export type RegionOverlayMode = "authored" | "realized" | "both";

export function regionOverlayModeShowsAuthored(mode: RegionOverlayMode): boolean {
  return mode === "authored" || mode === "both";
}

export function regionOverlayModeShowsRealized(mode: RegionOverlayMode): boolean {
  return mode === "realized" || mode === "both";
}
