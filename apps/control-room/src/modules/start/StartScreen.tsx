"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { homeView } from "@/kernel/layout/homeView";
import { useProjectDocumentSnapshot } from "@/kernel/persistence/ProjectDocumentStatus";
import { useSessionCollection } from "@/kernel/resources/useSessionCollection";
import { useSessionResourceIdentity, useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import type { ModuleProps } from "@/kernel/types";

import { HomeSection } from "./home/HomeSection";
import { LAUNCH_TILES } from "./home/LaunchTiles";
import { ProjectInspector } from "./inspector/ProjectInspector";
import type { ApiWorkspaceItem } from "./model/workspaceApiTypes";
import { readProjectArchiveAtPath } from "./model/recentIndexHost";
import { scriptSaveAvailable, type ScriptSaver } from "./model/scriptOpen";
import {
  buildFromScriptRequest,
  projectCreateFailureMessage,
  type ProjectCreator,
} from "./model/scriptProject";
import { useAuthorName } from "./model/useAuthorName";
import { useComputeProbe } from "./model/useComputeProbe";
import { useRecentIndex } from "./model/useRecentIndex";
import { useWorkspaceItemDetail, useWorkspaceItems } from "./model/useWorkspaceItems";
import { useWorkspaceScripts } from "./model/useWorkspaceScripts";
import { useWorkspaceSource } from "./model/useWorkspaceSource";
import { workspaceHostAvailable } from "./model/workspaceHost";
import { startActionDisabledReason } from "./model/startCommands";
import { startScreenStore, type StartScreenHost } from "./model/startScreenState";
import { startSettings } from "./model/startSettings";
import type { RecentEntry } from "./model/types";
import { StartRail } from "./rail/StartRail";
import { useStartPreferences } from "./model/useStartPreferences";
import { StartStatusBar } from "./ui/StartStatusBar";
import { AboutSection } from "./sections/AboutSection";
import { DocsSection } from "./sections/DocsSection";
import { ImportSection } from "./sections/ImportSection";
import { LearnSection } from "./sections/LearnSection";
import { SettingsSection } from "./sections/SettingsSection";
import { TemplatesSection } from "./sections/TemplatesSection";

const OPEN_SCRIPT_NEEDS_DESKTOP = "Opening a script needs the desktop app.";

const subscribeNever = () => () => undefined;

const SESSION_UNCONFIRMED =
  "Fullmag could not confirm that no session is running. Retry the session list first.";

/**
 * The launcher shown in place of a workspace. It occupies the body row only,
 * so the menu bar stays mounted and nothing flashes when a project opens.
 */
export function StartScreen({ kernel }: ModuleProps) {
  const sessions = useSessionCollection();
  const sessionIdentity = useSessionResourceIdentity();
  const sessionName = useSessionStatusSelector(
    (status) => status.data?.session?.name ?? null,
    // No session means no status resource to read; do not request one.
    { enabled: sessionIdentity !== null },
  );
  // Subscribing re-renders the tiles when the project controller changes the
  // enablement of workspace.open-project.
  useProjectDocumentSnapshot();
  // The HTTP workspace API is the source of every list when the backend serves
  // it; the desktop host's own data is the fallback, and still serves dialogs,
  // reading and running scripts and revealing files.
  const workspaceApi = useWorkspaceItems();
  const preferences = useStartPreferences();
  const desktopRecent = useRecentIndex();
  const desktopScripts = useWorkspaceScripts();
  const source = useWorkspaceSource(workspaceApi, desktopRecent, desktopScripts);
  const { recent, scripts, results } = source;
  // Server rendering and hydration agree on "no desktop"; the client snapshot
  // then enables the picker.
  const desktop = useSyncExternalStore(subscribeNever, workspaceHostAvailable, () => false);
  const [scriptFlowNotice, setScriptFlowNotice] = useState<string | null>(null);
  const computeProbe = useComputeProbe();
  const { compute } = computeProbe;
  const authorName = useAuthorName();
  const {
    section,
    selectedProjectId,
    selectedScriptId,
    selectedResultId,
    selectedTemplateId,
    openScriptNonce,
  } = useSyncExternalStore(
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
      openScriptDisabledReason: desktop ? null : OPEN_SCRIPT_NEEDS_DESKTOP,
      disabledReason: (commandId, context) =>
        kernel.commands.get(commandId)?.disabledReason?.(context) ?? null,
      execute: (commandId, context) => kernel.commands.execute(commandId, context),
      isEnabled: (commandId, context) => kernel.commands.isEnabled(commandId, context),
    }),
    [canCreateProblem, desktop, kernel.commands],
  );

  // One flow for the tile, the list buttons and the palette command: pick a
  // script, make sure the list shows scripts, and select the result so the
  // inspector describes it. Each request carries a new number; handle it once.
  const handledOpenScript = useRef(openScriptNonce);
  const pickAndOpen = scripts.pickAndOpen;
  useEffect(() => {
    if (openScriptNonce <= handledOpenScript.current) {
      // The store restarts its counter when the screen detaches.
      handledOpenScript.current = openScriptNonce;
      return;
    }
    handledOpenScript.current = openScriptNonce;
    startScreenStore.setSection("home");
    setScriptFlowNotice(null);
    void pickAndOpen().then(({ item, failure }) => {
      if (failure) {
        setScriptFlowNotice(failure);
        return;
      }
      if (!item) return;
      if (startSettings.getSnapshot().recentKind === "project") {
        startSettings.update({ recentKind: "all" });
      }
      startScreenStore.setSelectedScript(item.id);
    });
  }, [openScriptNonce, pickAndOpen]);

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

  // The runtime restores a checkpoint into the open session that owns the run
  // (study.restore-checkpoint -> POST .../persistence/checkpoints/{id}/restore),
  // leaving it paused; the workspace behind Home takes over from there.
  const resumeContinue = async (checkpointId: string, entry: RecentEntry): Promise<string | null> => {
    const result = await kernel.commands.execute(
      "study.restore-checkpoint",
      createCommandContext("menu", kernel, {
        input: { checkpointId },
        sourceDetail: "start-screen",
      }),
    );
    if (result.status === "completed") {
      homeView.close();
      return null;
    }
    return result.message ?? `Could not restore the checkpoint of ${entry.name}.`;
  };

  // Discard deletes the checkpoint through the open session's runtime
  // (study.discard-checkpoint -> DELETE .../persistence/checkpoints/{id}). Home
  // stays up; the refetched catalogue decides what the card offers next.
  const discardContinue = async (checkpointId: string, entry: RecentEntry): Promise<string | null> => {
    const result = await kernel.commands.execute(
      "study.discard-checkpoint",
      createCommandContext("menu", kernel, {
        input: { checkpointId },
        sourceDetail: "start-screen",
      }),
    );
    return result.status === "completed"
      ? null
      : (result.message ?? `Could not discard the checkpoint of ${entry.name}.`);
  };

  // A template or translated .mx3 is a Python script: the host saves it through
  // its native Save dialog, then Home shows the new script selected so its
  // inspector (and Run in new window, which asks for consent itself) is next.
  const saveNew = scripts.saveNew;
  const scriptSaver: ScriptSaver | null = desktop && scriptSaveAvailable()
    ? async (request) => {
        const outcome = await saveNew(request);
        if (outcome.kind === "saved") {
          if (startSettings.getSnapshot().recentKind === "project") {
            startSettings.update({ recentKind: "all" });
          }
          setScriptFlowNotice(null);
          startScreenStore.setSection("home");
          startScreenStore.setSelectedScript(outcome.item.id);
        }
        return outcome;
      }
    : null;

  // Create project: the consent prompt already ran (CreateProjectAction), so
  // the controller may send `consent.executed_by_user`. The new document opens
  // like an opened archive: Home closes and the workspace takes over, where the
  // fidelity banner reports whether the exported scene matches the script.
  const projectDocument = kernel.projectDocument;
  const projectCreator: ProjectCreator | null = projectDocument
    ? async (script) => {
        try {
          const response = await projectDocument.createFromScript(buildFromScriptRequest(script));
          kernel.authoringHistory?.clear();
          homeView.close();
          return {
            kind: "created",
            projectName: response.name,
            fidelity: response.script_import.fidelity,
          };
        } catch (error) {
          return { kind: "failed", message: projectCreateFailureMessage(error) };
        }
      }
    : null;

  // Opening a project and then its saved results: the Results module of the
  // open project is the saved-results viewer (SavedResultsBrowser).
  const openResults = async (entry: RecentEntry): Promise<string | null> => {
    const failure = await openRecent(entry);
    if (failure === null) kernel.layout.setActiveTab("results");
    return failure;
  };

  const selectedScript =
    scripts.state.kind === "ready"
      ? (scripts.state.items.find((item) => item.id === selectedScriptId) ?? null)
      : null;

  const selectedEntry =
    recent.state.kind === "ready"
      ? (recent.state.index.entries.find((e) => e.projectId === selectedProjectId) ?? null)
      : null;

  const selectedResult =
    results.state.kind === "ready" && selectedResultId !== null
      ? (results.state.items.find((item) => item.id === selectedResultId) ?? null)
      : null;

  // The backend reads the selected item's file; only an API item has an id to ask for.
  const selectedApiId =
    source.origin !== "api"
      ? null
      : (selectedEntry?.workspaceId ??
        (typeof selectedScript?.id === "string" ? selectedScript.id : null) ??
        selectedResult?.id ??
        null);
  const itemDetail = useWorkspaceItemDetail(selectedApiId);

  const selectApiItem = (item: ApiWorkspaceItem) => {
    if (item.kind === "project") startScreenStore.setSelectedProject(item.projectId ?? item.id);
    else if (item.kind === "script") startScreenStore.setSelectedScript(item.id);
    else startScreenStore.setSelectedResult(item.id);
  };

  const addByPath =
    source.origin === "api"
      ? async (path: string): Promise<string | null> => {
          const added = await workspaceApi.addByPath(path);
          if ("failure" in added) return added.failure;
          if (startSettings.getSnapshot().recentKind !== "all") {
            startSettings.update({ recentKind: "all" });
          }
          selectApiItem(added.item);
          return null;
        }
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
      <StartRail
        compute={compute}
        computeError={computeProbe.error}
        refreshing={computeProbe.refreshing}
        stale={computeProbe.stale}
        onRefreshCompute={computeProbe.refresh}
        onRunCommand={runCommand}
        ref={railRef}
        section={section}
      />
      <main className="fm-start__content" id="fm-main-content" ref={mainRef} tabIndex={-1}>
        <div className="fm-start__content-inner">
          {section === "home" ? (
            <HomeSection
              browseDisabledReason={browseDisabledReason}
              disabledReasons={disabledReasons}
              initialFocusRef={initialFocusRef}
              name={authorName}
              recent={recent}
              scripts={scripts}
              results={results}
              onAddPath={addByPath}
              canOpenScript={desktop}
              onOpenScript={() => runCommand("start.open-script")}
              scriptFlowNotice={scriptFlowNotice}
              compute={compute}
              onOpenRecent={openRecent}
              onResumeContinue={resumeContinue}
              onDiscardContinue={discardContinue}
              onRunCommand={runCommand}
            />
          ) : section === "templates" ? (
            <TemplatesSection compute={compute} />
          ) : section === "import" ? (
            <ImportSection
              onOpenFile={openFile}
              projectCreator={projectCreator}
              scriptSaver={scriptSaver}
              openDisabledReason={browseDisabledReason}
            />
          ) : section === "docs" ? (
            <DocsSection />
          ) : section === "learn" ? (
            <LearnSection />
          ) : section === "settings" ? (
            <SettingsSection
              compute={compute}
              computeError={computeProbe.error}
              refreshing={computeProbe.refreshing}
              stale={computeProbe.stale}
              onRefreshCompute={computeProbe.refresh}
              recent={recent}
              workspace={workspaceApi}
            />
          ) : (
            <AboutSection compute={compute} index={recent.state} />
          )}
        </div>
      </main>
      <ProjectInspector
        compute={compute}
        detail={itemDetail}
        entry={selectedEntry}
        onOpenResults={openResults}
        onSelectResult={(id) => startScreenStore.setSelectedResult(id)}
        archiveUrl={workspaceApi.archiveUrl}
        onForget={(projectId) => {
          startScreenStore.setSelectedProject(null);
          void recent.forget(projectId);
        }}
        onOpen={openRecent}
        onTogglePin={(projectId, pinned) => void recent.pin(projectId, pinned)}
        openDisabledReason={browseDisabledReason}
        result={selectedResult}
        resultActions={{
          readOnly: scripts.readOnly,
          thumbnailUrl: workspaceApi.thumbnailUrl,
          archiveUrl: workspaceApi.archiveUrl,
          loadFrames: workspaceApi.loadFrames,
          onTogglePin: results.pin,
          onForget: (id) => {
            startScreenStore.setSelectedResult(null);
            void results.forget(id);
          },
          onSelectSource: selectApiItem,
          onOpenResults: async (project) => {
            const entry =
              recent.state.kind === "ready"
                ? recent.state.index.entries.find((e) => e.workspaceId === project.id)
                : undefined;
            return entry
              ? openResults(entry)
              : `${project.name} is not in the project list; refresh the list and try again.`;
          },
        }}
        script={selectedScript}
        scriptActions={{
          readOnly: scripts.readOnly,
          desktopIdOf: scripts.desktopIdOf,
          thumbnailUrl: workspaceApi.thumbnailUrl,
          onSelectResult: (id) => startScreenStore.setSelectedResult(id),
          onOpen: scripts.open,
          onReveal: scripts.reveal,
          onReadText: scripts.readText,
          onRunFinished: () => void scripts.refresh(),
          onTogglePin: scripts.pin,
          onForget: (id) => {
            startScreenStore.setSelectedScript(null);
            void scripts.forget(id);
          },
        }}
        projectCreator={projectCreator}
        scriptSaver={scriptSaver}
        section={section}
        templateId={selectedTemplateId}
        session={recent.state.kind === "ready" ? recent.state.index.continue : undefined}
        index={recent.state}
      />
      <StartStatusBar compute={compute} index={recent.state} preferences={preferences}
        sessionLabel={sessionIdentity ? `Simulation open: ${sessionName ?? "Untitled simulation"}` : "No active session"} />
    </div>
  );
}
