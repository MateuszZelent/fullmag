'use client';

import { useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import WorkspaceShell from "./WorkspaceShell";
import type { WorkspaceMode } from "@/components/runs/control-room/context-hooks";
import { resolveLaunchIntentFromSearchParams } from "@/lib/workspace/launch-intent";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";
import { readStagedLaunchAsset } from "@/lib/workspace/file-access";
import { recordFrontendDebugEvent } from "@/lib/workspace/navigation-debug";

interface WorkspaceEntryPageProps {
  stage: WorkspaceMode;
}

export default function WorkspaceEntryPage({ stage }: WorkspaceEntryPageProps) {
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

  useEffect(() => {
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
    setLauncherVisible(false);
  }, [
    effectiveStage,
    intent,
    setActiveProjectId,
    setCurrentStage,
    setLaunchIntent,
    setLauncherVisible,
    stage,
  ]);

  return <WorkspaceShell initialStage={effectiveStage} />;
}
