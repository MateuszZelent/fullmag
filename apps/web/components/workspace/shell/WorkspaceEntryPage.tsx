'use client';

import { useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import WorkspaceShell from "./WorkspaceShell";
import type { WorkspaceMode } from "@/components/runs/control-room/context-hooks";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { resolveLaunchIntentFromSearchParams } from "@/lib/workspace/launch-intent";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";
import {
  coreTabIdForWorkspaceRouteSlug,
  type WorkspaceRouteTabSlug,
} from "@/lib/workspace/workspace-route";
import { readStagedLaunchAsset } from "@/lib/workspace/file-access";
import { recordFrontendDebugEvent } from "@/lib/workspace/navigation-debug";

interface WorkspaceEntryPageProps {
  stage: WorkspaceMode;
  initialTabSlug?: WorkspaceRouteTabSlug | null;
}

export default function WorkspaceEntryPage({ stage, initialTabSlug = null }: WorkspaceEntryPageProps) {
  const workspaceTreeEnabled = FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableWorkspaceTree;
  const workspaceEntryEnabled = FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableWorkspaceEntryPage;

  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const intent = useMemo(
    () => resolveLaunchIntentFromSearchParams(new URLSearchParams(queryString)),
    [queryString],
  );
  const effectiveStage = intent.targetStage ?? stage;
  const setLaunchIntent = useWorkspaceStore((state) => state.setLaunchIntent);
  const setActiveProjectId = useWorkspaceStore((state) => state.setActiveProjectId);
  const setCurrentStage = useWorkspaceStore((state) => state.setCurrentStage);
  const setLauncherVisible = useWorkspaceStore((state) => state.setLauncherVisible);
  const activateTab = useWorkspaceStore((state) => state.activateTab);

  useEffect(() => {
    if (!workspaceTreeEnabled || !workspaceEntryEnabled) {
      return;
    }
    const stagedAsset = readStagedLaunchAsset(intent.launchAssetId);
    const enrichedIntent = stagedAsset
      ? {
          ...intent,
          metadata: {
            ...(intent.metadata ?? {}),
            stagedAssetName: stagedAsset.name,
            stagedAssetSize: stagedAsset.text.length,
          },
        }
      : intent;
    recordFrontendDebugEvent("workspace-entry", "mount_stage_entry", {
      stage,
      source: enrichedIntent.source,
      targetStage: enrichedIntent.targetStage,
      entryPath: enrichedIntent.entryPath,
      projectId: enrichedIntent.resumeProjectId,
    });
    setLaunchIntent(enrichedIntent);
    setActiveProjectId(enrichedIntent.resumeProjectId ?? enrichedIntent.entryPath ?? null);
    setCurrentStage(effectiveStage);
    if (initialTabSlug) {
      activateTab(effectiveStage, coreTabIdForWorkspaceRouteSlug(initialTabSlug));
    }
    setLauncherVisible(false);
  }, [
    activateTab,
    effectiveStage,
    initialTabSlug,
    intent,
    setActiveProjectId,
    setCurrentStage,
    setLaunchIntent,
    setLauncherVisible,
    stage,
    workspaceEntryEnabled,
    workspaceTreeEnabled,
  ]);

  if (!workspaceTreeEnabled) {
    return (
      <div className="flex min-h-[50vh] w-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        Workspace disabled by diagnostic flag: <code className="mx-1">workspace.enableWorkspaceTree = false</code>.
      </div>
    );
  }

  if (!workspaceEntryEnabled) {
    return (
      <div className="flex min-h-[50vh] w-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        WorkspaceEntryPage disabled by diagnostic flag: <code className="mx-1">workspace.enableWorkspaceEntryPage = false</code>.
      </div>
    );
  }

  return <WorkspaceShell initialStage={effectiveStage} />;
}
