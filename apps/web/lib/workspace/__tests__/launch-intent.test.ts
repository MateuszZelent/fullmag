import { describe, expect, it } from "vitest";
import {
  normalizeWorkspaceStage,
  resolveLaunchIntentFromSearchParams,
  searchParamsForLaunchIntent,
  type LaunchIntent,
} from "../launch-intent";

describe("launch intent URL contract", () => {
  it("keeps legacy electron_cli links readable as local_live intents", () => {
    const intent = resolveLaunchIntentFromSearchParams(
      new URLSearchParams("source=electron_cli&kind=project&stage=study&projectId=run-1"),
    );

    expect(intent.source).toBe("local_live");
    expect(intent.targetStage).toBeNull();
    expect(intent.resumeProjectId).toBe("run-1");
  });

  it("keeps live status launch URLs clean", () => {
    const intent: LaunchIntent = {
      source: "local_live",
      entryPath: null,
      entryKind: "project",
      targetStage: "build",
      resumeProjectId: "run-session-1",
      displayName: "Live Simulation",
      launchAssetId: null,
      metadata: { detectedBy: "live_status" },
    };

    expect(searchParamsForLaunchIntent(intent).toString()).toBe("");
  });

  it("does not expose legacy stage in live status launch URLs", () => {
    const intent: LaunchIntent = {
      source: "local_live",
      entryPath: null,
      entryKind: "project",
      targetStage: "study",
      resumeProjectId: "run-session-1",
      displayName: "Live Simulation",
      launchAssetId: null,
      metadata: { detectedBy: "live_status" },
    };

    expect(searchParamsForLaunchIntent(intent).toString()).toBe("");
  });

  it("normalizes legacy analyze launch stage to study", () => {
    expect(normalizeWorkspaceStage("analyze")).toBe("study");
    expect(normalizeWorkspaceStage("build")).toBe("build");
    expect(normalizeWorkspaceStage("study")).toBe("study");
    expect(normalizeWorkspaceStage("invalid")).toBeNull();
  });
});
