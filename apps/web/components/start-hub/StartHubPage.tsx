"use client";

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
  targetPathForLaunchIntent,
  type LaunchIntent,
} from "@/lib/workspace/launch-intent";
import { detectLiveSessionIntent, type DetectedLiveSession } from "@/lib/workspace/launch-intent-live";
import { pickTextFile, stageLaunchTextFile } from "@/lib/workspace/file-access";
import { recordFrontendDebugEvent } from "@/lib/workspace/navigation-debug";

function toIntentFromRecent(entry: RecentSimulationEntry): LaunchIntent {
  return {
    source: "recent",
    entryPath: entry.path,
    entryKind: entry.kind,
    targetStage: entry.lastStage ?? "build",
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
    const params = new URLSearchParams();
    if (intent.source) params.set("source", intent.source);
    if (intent.entryPath) params.set("path", intent.entryPath);
    if (intent.entryKind) params.set("kind", intent.entryKind);
    if (intent.targetStage) params.set("stage", intent.targetStage);
    if (intent.resumeProjectId) params.set("projectId", intent.resumeProjectId);
    if (intent.displayName) params.set("name", intent.displayName);
    if (intent.launchAssetId) params.set("asset", intent.launchAssetId);
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
    router.push(route);
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
    stage: "build" | "study" | "analyze";
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
      {/* Sidebar: Recent Projects - High Density HUD */}
      <aside className="flex w-80 shrink-0 flex-col gap-6 overflow-hidden">
        <div className="flex items-end justify-between px-1">
          <h2 className="text-[0.7rem] font-bold uppercase tracking-[0.2em] text-muted-foreground/80">Recent Projects</h2>
          <span className="text-[0.62rem] font-semibold text-primary/60 hover:text-primary cursor-pointer uppercase transition-colors tracking-widest">Voir Tout</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-white/5 scrollbar-track-transparent">
          <RecentSimulationsSection entries={recents} onOpenRecent={handleOpenRecent} />
        </div>
      </aside>

      {/* Main Area: Actions & Examples */}
      <div className="flex min-h-0 flex-1 flex-col gap-10 overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-white/5 scrollbar-track-transparent">
        <section>
          <div className="mb-5 flex items-end justify-between px-1">
            <h2 className="text-[0.7rem] font-bold uppercase tracking-[0.2em] text-muted-foreground/80">Launch Center</h2>
            <span className="flex items-center gap-1.5 text-[0.62rem] font-bold uppercase tracking-widest text-primary/40">
              <span className="h-1 w-1 rounded-full bg-primary/40 animate-pulse" />
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

        <section className="flex-1 pb-10">
          <div className="mb-6 flex items-end justify-between px-1">
            <h2 className="text-[0.7rem] font-bold uppercase tracking-[0.2em] text-muted-foreground/80">Reference Examples</h2>
            <div className="h-px flex-1 mx-4 bg-white/5" />
          </div>
          <ExamplesSection onOpenExample={handleOpenExample} />
        </section>
      </div>

      <CreateSimulationWizard onCreate={handleCreate} />
    </StartHubShell>
  );
}
