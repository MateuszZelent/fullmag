export const AIRBOX_TARGET_ID = "airbox" as const;
export const FDM_OUTSIDE_SUPPORT_CARRIER_ID =
  "fdm-universe-outside-support" as const;
export const FDM_AIRBOX_PART_CARRIER_ID = "part:__air__" as const;
export const FDM_AIRBOX_OBJECT_CARRIER_ID = "object:__air__" as const;

const LEGACY_AIRBOX_TARGET_IDS = new Set<string>([
  AIRBOX_TARGET_ID,
  FDM_AIRBOX_OBJECT_CARRIER_ID,
  FDM_AIRBOX_PART_CARRIER_ID,
  FDM_OUTSIDE_SUPPORT_CARRIER_ID,
]);

export function canonicalVisualizationTargetId(targetId: string): string {
  return LEGACY_AIRBOX_TARGET_IDS.has(targetId)
    ? AIRBOX_TARGET_ID
    : targetId;
}

export function isAirboxVisualizationTargetId(targetId: string): boolean {
  return canonicalVisualizationTargetId(targetId) === AIRBOX_TARGET_ID;
}
