"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import StartHubShell from "./StartHubShell";
import RecentSimulationsSection from "./RecentSimulationsSection";
import OpenActionsSection from "./OpenActionsSection";
import CreateSimulationWizard from "./CreateSimulationWizard";
import ExamplesSection from "./ExamplesSection";
import {
  readRecentSimulations,
  type RecentSimulationEntry,
  upsertRecentSimulation,
} from "@/lib/workspace/recent-simulations";
import {
  normalizeWorkspaceStage,
  searchParamsForLaunchIntent,
  targetPathForLaunchIntent,
  type LaunchIntent,
  type WorkspaceStage,
} from "@/lib/workspace/launch-intent";
import { detectLiveSessionIntent, type DetectedLiveSession } from "@/lib/workspace/launch-intent-live";
import { pickTextFile, stageLaunchTextFile } from "@/lib/workspace/file-access";
import { recordFrontendDebugEvent } from "@/lib/workspace/navigation-debug";

function toIntentFromRecent(entry: RecentSimulationEntry): LaunchIntent {
  return {
    source: "recent",
    entryPath: entry.path,
    entryKind: entry.kind,
    targetStage: normalizeWorkspaceStage(entry.lastStage) ?? "build",
    resumeProjectId: entry.id,
    displayName: entry.name,
    launchAssetId: null,
    metadata: { backend: entry.backend },
  };
}

export default function StartHubPage() {
  const router = useRouter();
  const [recents, setRecents] = useState<RecentSimulationEntry[]>(() => {
    if (typeof window !== "undefined") {
      return readRecentSimulations();
    }
    return [];
  });
  const [liveSession, setLiveSession] = useState<DetectedLiveSession | null>(null);

  // Live session detection remains an async effect as it involves network/process discovery
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      recordFrontendDebugEvent("start-hub", "detect_live_session_start");
      const detected = await detectLiveSessionIntent();
      if (cancelled) return;
      recordFrontendDebugEvent("start-hub", "detect_live_session_complete", {
        detected: Boolean(detected),
        targetStage: detected?.intent.targetStage ?? null,
      });
      setLiveSession(detected);
      if (!detected) return;
      const recentEntry: RecentSimulationEntry = {
        id: detected.intent.resumeProjectId ?? detected.scriptPath ?? "live_current",
        name: detected.name,
        path: detected.scriptPath ?? "<live_session>",
        kind: detected.intent.entryKind,
        backend: detected.backend,
        updatedAtUnixMs: Date.now(),
        lastStage: detected.intent.targetStage,
      };
      setRecents(upsertRecentSimulation(recentEntry));
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const canResumeCurrentSession = useMemo(() => Boolean(liveSession), [liveSession]);

  const openIntent = (intent: LaunchIntent) => {
    const target = targetPathForLaunchIntent(intent);
    const params = searchParamsForLaunchIntent(intent);
    recordFrontendDebugEvent(
      "start-hub",
      "router_push_launch_intent",
      {
        target,
        params: params.toString(),
        source: intent.source,
      },
      { includeStack: true },
    );
    const route = params.toString().length > 0 ? `${target}?${params}` : target;
    router.push(route as Route);
  };

  const handleOpenRecent = (entry: RecentSimulationEntry) => {
    openIntent(toIntentFromRecent(entry));
  };

  const handleOpenSimulation = async () => {
    const file = await pickTextFile();
    if (!file) return;
    const launchAssetId = stageLaunchTextFile(file);
    const intent: LaunchIntent = {
      source: "file_handle",
      entryPath: file.name,
      entryKind: "project",
      targetStage: "build",
      resumeProjectId: null,
      displayName: file.name,
      launchAssetId,
      metadata: { fileName: file.name, size: file.text.length },
    };
    setRecents(upsertRecentSimulation({
      id: `file:${file.name}`,
      name: file.name,
      path: file.name,
      kind: intent.entryKind,
      backend: null,
      updatedAtUnixMs: Date.now(),
      lastStage: intent.targetStage,
    }));
    openIntent(intent);
  };

  const handleOpenScript = async () => {
    const file = await pickTextFile();
    if (!file) return;
    const launchAssetId = stageLaunchTextFile(file);
    const intent: LaunchIntent = {
      source: "file_handle",
      entryPath: file.name,
      entryKind: "script",
      targetStage: "build",
      resumeProjectId: null,
      displayName: file.name,
      launchAssetId,
      metadata: { fileName: file.name, size: file.text.length },
    };
    setRecents(upsertRecentSimulation({
      id: `script:${file.name}`,
      name: file.name,
      path: file.name,
      kind: intent.entryKind,
      backend: null,
      updatedAtUnixMs: Date.now(),
      lastStage: intent.targetStage,
    }));
    openIntent(intent);
  };

  const handleOpenExample = (exampleId = "nanoflower_fem") => {
    const intent: LaunchIntent = {
      source: "example",
      entryPath: exampleId,
      entryKind: "example",
      targetStage: "build",
      resumeProjectId: exampleId,
      displayName: exampleId,
      launchAssetId: null,
      metadata: { exampleId },
    };
    setRecents(upsertRecentSimulation({
      id: `example:${exampleId}`,
      name: exampleId,
      path: exampleId,
      kind: intent.entryKind,
      backend: null,
      updatedAtUnixMs: Date.now(),
      lastStage: intent.targetStage,
    }));
    openIntent(intent);
  };

  const handleResumeCurrentSession = () => {
    if (!liveSession) return;
    openIntent(liveSession.intent);
  };

  const handleCreate = (payload: {
    name: string;
    location: string;
    backend: string;
    stage: WorkspaceStage;
  }) => {
    const entry: RecentSimulationEntry = {
      id: `${payload.name}:${payload.location}`,
      name: payload.name,
      path: `${payload.location}/${payload.name}.py`,
      kind: "project",
      backend: payload.backend,
      updatedAtUnixMs: Date.now(),
      lastStage: payload.stage,
    };
    upsertRecentSimulation(entry);
    openIntent(toIntentFromRecent(entry));
  };

  return (
    <StartHubShell>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="min-w-0 rounded-md border border-border/60 bg-card/45 p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">Recent Projects</h2>
            <button
              type="button"
              className="text-xs font-medium text-primary/80 transition-colors hover:text-primary"
            >
              View all
            </button>
          </div>
          <RecentSimulationsSection entries={recents} onOpenRecent={handleOpenRecent} />
        </aside>

        <main className="flex min-w-0 flex-col gap-6">
          <section className="min-w-0">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">Launch Center</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Start from a template, open a script, or resume an active workspace.
                </p>
              </div>
              <span className="inline-flex items-center gap-2 rounded-md border border-primary/20 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                New session ready
              </span>
            </div>
            <OpenActionsSection
              canResumeCurrentSession={canResumeCurrentSession}
              onResumeCurrentSession={handleResumeCurrentSession}
              onOpenSimulation={handleOpenSimulation}
              onOpenScript={handleOpenScript}
              onOpenExample={() => handleOpenExample("nanoflower_fem")}
            />
          </section>

          <section className="min-w-0">
            <div className="mb-4 flex items-center gap-4">
              <h2 className="text-sm font-semibold text-foreground">Reference Examples</h2>
              <div className="h-px flex-1 bg-border/60" />
            </div>
            <ExamplesSection onOpenExample={handleOpenExample} />
          </section>

          <div className="min-w-0 pb-8">
            <CreateSimulationWizard onCreate={handleCreate} />
          </div>
        </main>
      </div>
    </StartHubShell>
  );
}
