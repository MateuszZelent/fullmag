export type LaunchSource =
  | "none"
  | "recent"
  | "example"
  | "file_handle"
  | "script_path"
  | "project_path"
  | "local_live"
  | "web_query";

export type LaunchEntryKind = "script" | "project" | "example" | null;
export type WorkspaceStage = "build" | "study";

export interface LaunchIntent {
  source: LaunchSource;
  entryPath: string | null;
  entryKind: LaunchEntryKind;
  targetStage: WorkspaceStage | null;
  resumeProjectId: string | null;
  displayName: string | null;
  launchAssetId: string | null;
  metadata: Record<string, unknown> | null;
}

export function emptyLaunchIntent(): LaunchIntent {
  return {
    source: "none",
    entryPath: null,
    entryKind: null,
    targetStage: null,
    resumeProjectId: null,
    displayName: null,
    launchAssetId: null,
    metadata: null,
  };
}

export function normalizeWorkspaceStage(value: unknown): WorkspaceStage | null {
  if (value === "build" || value === "study") {
    return value;
  }
  // Legacy: analyze is a center surface/tab, not a launch/workspace stage.
  if (value === "analyze") {
    return "study";
  }
  return null;
}

function kindFromString(value: string | null): LaunchEntryKind {
  if (value === "script" || value === "project" || value === "example") {
    return value;
  }
  return null;
}

export function resolveLaunchIntentFromSearchParams(
  params: URLSearchParams,
): LaunchIntent {
  const source = params.get("source");
  const entryPath = params.get("path");
  const entryKind = kindFromString(params.get("kind"));
  const resumeProjectId = params.get("projectId");
  const displayName = params.get("name");
  const launchAssetId = params.get("asset");
  const hasQueryIntent =
    Boolean(source) ||
    Boolean(entryPath) ||
    Boolean(entryKind) ||
    Boolean(resumeProjectId) ||
    Boolean(displayName) ||
    Boolean(launchAssetId);

  if (!hasQueryIntent) {
    return emptyLaunchIntent();
  }

  return {
    source:
      source === "recent" ||
      source === "example" ||
      source === "file_handle" ||
      source === "script_path" ||
      source === "project_path" ||
      source === "local_live" ||
      source === "web_query"
        ? source
        : source === "electron_cli"
          ? "local_live"
        : "web_query",
    entryPath,
    entryKind,
    targetStage: null,
    resumeProjectId,
    displayName,
    launchAssetId,
    metadata: null,
  };
}

export function targetPathForLaunchIntent(intent: LaunchIntent): string {
  void intent;
  return "/workspace";
}

function isLiveStatusIntent(intent: LaunchIntent): boolean {
  return intent.source === "local_live" || intent.metadata?.detectedBy === "live_status";
}

export function searchParamsForLaunchIntent(intent: LaunchIntent): URLSearchParams {
  const params = new URLSearchParams();

  if (isLiveStatusIntent(intent)) {
    return params;
  }

  if (intent.source && intent.source !== "none") params.set("source", intent.source);
  if (intent.entryPath) params.set("path", intent.entryPath);
  if (intent.entryKind) params.set("kind", intent.entryKind);
  if (intent.resumeProjectId) params.set("projectId", intent.resumeProjectId);
  if (intent.displayName) params.set("name", intent.displayName);
  if (intent.launchAssetId) params.set("asset", intent.launchAssetId);
  return params;
}
