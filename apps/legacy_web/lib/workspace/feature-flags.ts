export interface WorkspaceFeatureFlags {
  workspaceV2Enabled: boolean;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return fallback;
}

export function getWorkspaceFeatureFlags(): WorkspaceFeatureFlags {
  const workspaceV2EnabledEnv =
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_WORKSPACE_V2_ENABLED : undefined;
  return {
    // V2 defaults to enabled for final cutover; can be disabled in env for rollback.
    workspaceV2Enabled: parseBooleanEnv(workspaceV2EnabledEnv, true),
  };
}
