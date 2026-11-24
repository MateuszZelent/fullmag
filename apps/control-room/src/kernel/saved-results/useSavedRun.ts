"use client";
import { useSyncExternalStore } from "react";
import { useKernel } from "../KernelContext";
import { useProjectDocumentSnapshot } from "../persistence/ProjectDocumentStatus";
import { savedResultScopeMatches } from "./SavedRunController";
const empty = () => null;
const subscribeNever = () => () => undefined;

export function useSavedRunSelection() {
  const { savedRun, api } = useKernel();
  const selection = useSyncExternalStore(savedRun?.subscribe ?? subscribeNever,
    savedRun?.getSnapshot ?? empty, savedRun?.getServerSnapshot ?? empty);
  return selection?.apiScope === api.resourceCacheScope ? selection : null;
}

export function useSavedResultScope() {
  const savedRun = useSavedRunSelection();
  const project = useProjectDocumentSnapshot();
  const scope = {
    projectId: savedRun?.projectId ?? (project.state === "ready" ? project.resource.project_id : null),
    runId: savedRun?.runId ?? null,
  };
  return { ...scope, matches: (selection: { projectId: string; runId: string } | null) => savedResultScopeMatches(scope, selection) };
}
