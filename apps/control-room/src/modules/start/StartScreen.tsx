"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { homeView } from "@/kernel/layout/homeView";
import { useProjectDocumentSnapshot } from "@/kernel/persistence/ProjectDocumentStatus";
import { useSessionCollection } from "@/kernel/resources/useSessionCollection";
import type { ModuleProps } from "@/kernel/types";

import { HomeSection } from "./home/HomeSection";
import { LAUNCH_TILES } from "./home/LaunchTiles";
import { ProjectInspector } from "./inspector/ProjectInspector";
import {
  discardCheckpoint,
  readProjectArchiveAtPath,
  resumeRun,
} from "./model/recentIndexHost";
import { useAuthorName } from "./model/useAuthorName";
import { useComputeProbe } from "./model/useComputeProbe";
import { useRecentIndex } from "./model/useRecentIndex";
import { startActionDisabledReason } from "./model/startCommands";
import { startScreenStore, type StartScreenHost } from "./model/startScreenState";
import type { ContinueSession, RecentEntry } from "./model/types";
import { StartRail } from "./rail/StartRail";
import { StartStatusBar } from "./ui/StartStatusBar";
import { AboutSection } from "./sections/AboutSection";
import { DocsSection } from "./sections/DocsSection";
import { ImportSection } from "./sections/ImportSection";
import { LearnSection } from "./sections/LearnSection";
import { SettingsSection } from "./sections/SettingsSection";
import { TemplatesSection } from "./sections/TemplatesSection";

const SESSION_UNCONFIRMED =
  "Fullmag could not confirm that no session is running. Retry the session list first.";

/**
 * The launcher shown in place of a workspace. It occupies the body row only,
 * so the menu bar stays mounted and nothing flashes when a project opens.
 */
export function StartScreen({ kernel }: ModuleProps) {
  const sessions = useSessionCollection();
  // Subscribing re-renders the tiles when the project controller changes the
  // enablement of workspace.open-project.
  useProjectDocumentSnapshot();
  const recent = useRecentIndex();
  const compute = useComputeProbe();
  const authorName = useAuthorName();
  const { section, selectedProjectId, selectedTemplateId } = useSyncExternalStore(
    startScreenStore.subscribe,
    startScreenStore.getSnapshot,
    startScreenStore.getServerSnapshot,
  );
  // Over an open workspace the tiles still create or open; the problem dialog
  // owns the "replace the current session" confirmation.
  const canCreateProblem = sessions.state === "no-session" || sessions.state === "ready";

  const host = useMemo<StartScreenHost>(
    () => ({
      createProblemDisabledReason: canCreateProblem ? null : SESSION_UNCONFIRMED,
      disabledReason: (commandId, context) =>
        kernel.commands.get(commandId)?.disabledReason?.(context) ?? null,
      execute: (commandId, context) => kernel.commands.execute(commandId, context),
      isEnabled: (commandId, context) => kernel.commands.isEnabled(commandId, context),
    }),
    [canCreateProblem, kernel.commands],
  );

  useEffect(() => {
    const detach = startScreenStore.attach(host);
    // Palette and menus read enablement at render time; tell them it changed.
    kernel.commands.refresh();
    return () => {
      detach();
      kernel.commands.refresh();
    };
  }, [host, kernel.commands]);

  const context = createCommandContext("menu", kernel, {
    sessionScopeKey: null,
    sourceDetail: "start-screen",
  });
  const disabledReasons: Record<string, string | null> = {};
  for (const tile of LAUNCH_TILES) {
    disabledReasons[tile.commandId] = startActionDisabledReason(tile.commandId, host, context);
  }
  const browseDisabledReason = startActionDisabledReason("start.browse", host, context);

  const runCommand = (commandId: string) => {
    void kernel.commands.execute(commandId, context).then((result) => {
      // Opening a project leaves Home; creating one is closed by the session change.
      if (commandId === "start.browse" && result.status === "completed") homeView.close();
    });
  };

  const openArchive = async (
    archive: Awaited<ReturnType<typeof readProjectArchiveAtPath>>,
    failure: string,
  ): Promise<string | null> => {
    if (!archive.ok) return `${failure}: ${archive.reason}`;
    const result = await kernel.commands.execute("workspace.open-project", {
      ...context,
      input: archive.source,
    });
    if (result.status === "completed") homeView.close();
    return result.status === "failed" ? (result.message ?? `${failure}.`) : null;
  };

  const openFile = async (file: File): Promise<string | null> =>
    openArchive(
      { ok: true, source: { bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name } },
      `Could not open ${file.name}`,
    );

  const openRecent = async (entry: RecentEntry): Promise<string | null> => {
    if (entry.status === "missing") {
      return `${entry.name} is no longer at ${entry.path}. Rebuild the index or remove it from the list.`;
    }
    const archive = await readProjectArchiveAtPath(entry.path);
    return openArchive(archive, `Could not open ${entry.name}`);
  };

  const resumeContinue = async (session: ContinueSession, entry: RecentEntry) =>
    openArchive(await resumeRun(session.projectId, session.runId), `Could not resume ${entry.name}`);

  const discardContinue = async (session: ContinueSession): Promise<string | null> => {
    const result = await discardCheckpoint(session.projectId, session.runId);
    if (!result.ok) return `Could not discard the checkpoint: ${result.reason}`;
    await recent.refresh();
    return null;
  };

  const selectedEntry =
    recent.state.kind === "ready"
      ? (recent.state.index.entries.find((e) => e.projectId === selectedProjectId) ?? null)
      : null;

  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const previousSection = useRef(section);

  useEffect(() => {
    initialFocusRef.current?.focus();
  }, []);

  // A section change moves focus to the new content, except when it came from
  // the rail, where the user is still navigating.
  useEffect(() => {
    if (previousSection.current === section) return;
    previousSection.current = section;
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (active && railRef.current?.contains(active)) return;
    mainRef.current?.focus();
  }, [section]);

  return (
    <div className="fm-start" data-section={section}>
      <StartRail compute={compute} onRunCommand={runCommand} ref={railRef} section={section} />
      <main className="fm-start__content" id="fm-main-content" ref={mainRef} tabIndex={-1}>
        <div className="fm-start__content-inner">
          {section === "home" ? (
            <HomeSection
              browseDisabledReason={browseDisabledReason}
              disabledReasons={disabledReasons}
              initialFocusRef={initialFocusRef}
              name={authorName}
              recent={recent}
              onDiscardContinue={discardContinue}
              onOpenRecent={openRecent}
              onResumeContinue={resumeContinue}
              onRunCommand={runCommand}
            />
          ) : section === "templates" ? (
            <TemplatesSection compute={compute} />
          ) : section === "import" ? (
            <ImportSection onOpenFile={openFile} openDisabledReason={browseDisabledReason} />
          ) : section === "docs" ? (
            <DocsSection />
          ) : section === "learn" ? (
            <LearnSection />
          ) : section === "settings" ? (
            <SettingsSection recent={recent} />
          ) : (
            <AboutSection compute={compute} index={recent.state} />
          )}
        </div>
      </main>
      <ProjectInspector
        compute={compute}
        entry={selectedEntry}
        onForget={(projectId) => {
          startScreenStore.setSelectedProject(null);
          void recent.forget(projectId);
        }}
        onOpen={openRecent}
        onTogglePin={(projectId, pinned) => void recent.pin(projectId, pinned)}
        openDisabledReason={browseDisabledReason}
        section={section}
        templateId={selectedTemplateId}
        session={recent.state.kind === "ready" ? recent.state.index.continue : undefined}
      />
      <StartStatusBar compute={compute} index={recent.state} />
    </div>
  );
}
