export type LaunchSource =
  | "none"
  | "recent"
  | "example"
  | "file_handle"
  | "script_path"
  | "project_path"
  | "electron_cli"
  | "web_query";

export type LaunchEntryKind = "script" | "project" | "example" | null;
export type WorkspaceStage = "build" | "study" | "analyze";

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

function stageFromString(value: string | null): WorkspaceStage | null {
  if (value === "build" || value === "study" || value === "analyze") {
    return value;
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
  const targetStage = stageFromString(params.get("stage"));
  const resumeProjectId = params.get("projectId");
  const displayName = params.get("name");
  const launchAssetId = params.get("asset");
  const hasQueryIntent =
    Boolean(source) ||
    Boolean(entryPath) ||
    Boolean(entryKind) ||
    Boolean(targetStage) ||
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
      source === "electron_cli" ||
      source === "web_query"
        ? source
        : "web_query",
    entryPath,
    entryKind,
    targetStage,
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
