"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { homeView } from "@/kernel/layout/homeView";
import { instanceTabs, useEmbeddedInstanceTab } from "@/kernel/layout/instanceTabs";
import { useInstanceDiscovery } from "@/kernel/resources/instanceDiscoveryResources";
import { useProjectDocumentSnapshot } from "@/kernel/persistence/ProjectDocumentStatus";
import { createAndActivateScriptProject } from "@/kernel/persistence/ScriptProjectActivation";
import { useSessionCollection } from "@/kernel/resources/useSessionCollection";
import { useSessionResourceIdentity, useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import type { ModuleProps } from "@/kernel/types";
import { Button } from "@/shared/ui/Button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/shared/ui/Sheet";

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
import { useExecutionAvailability } from "./model/executionAvailability";
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

const START_INSPECTOR_MEDIA_QUERY = "(max-width: 1180px)";

function subscribeStartInspectorLayout(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const query = window.matchMedia(START_INSPECTOR_MEDIA_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getStartInspectorLayout(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(START_INSPECTOR_MEDIA_QUERY).matches;
}

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
  const executionAvailability = useExecutionAvailability({
    compute,
    error: computeProbe.error,
    nodeInventory: computeProbe.nodeInventory,
    refreshing: computeProbe.refreshing,
    stale: computeProbe.stale,
  });
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
  // Home lies over the workspace while a session is open; list it so the
  // simulation stays reachable (including sessions a Python script created).
  const activeSessions = useMemo(
    () =>
      (sessions.resource.data?.sessions ?? []).map((entry) => ({
        sessionId: entry.session_id,
        name: entry.name,
        status: entry.status,
        current: entry.current,
      })),
    [sessions.resource.data],
  );
  // Other instances open in tabs of this page; inside another instance's tab
  // the host page owns the tabs, so the section is not offered there.
  const embeddedInTab = useEmbeddedInstanceTab();
  const discovery = useInstanceDiscovery({ enabled: !embeddedInTab });
  const otherInstances = useMemo(
    () =>
      (discovery.data?.instances ?? [])
        .filter((instance) => !instance.is_self)
        .map((instance) => {
          const session =
            instance.sessions.find((entry) => entry.current) ?? instance.sessions[0] ?? null;
          return {
            port: instance.port,
            session: session ? { name: session.name, status: session.status } : null,
          };
        }),
    [discovery.data],
  );
  // An empty collection is a confirmed no-session. A non-empty collection
  // requires a matching current-status identity before replacement can be
  // offered; a ready collection with a failed or mismatched status must stay
  // fail-closed until the user retries.
  const canCreateProblem =
    sessions.state === "no-session" ||
    (sessions.state === "ready" && sessionIdentity !== null);

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
          const response = await createAndActivateScriptProject(kernel, buildFromScriptRequest(script));
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

  // Legacy navigation for callers without the standalone playback command.
  const openResults = async (entry: RecentEntry): Promise<string | null> => {
    const failure = await openRecent(entry);
    if (failure === null) kernel.layout.setActiveTab("results");
    return failure;
  };

  const openSavedPlayback = async (item: ApiWorkspaceItem): Promise<string | null> => {
    const result = await kernel.commands.execute(
      "workspace.open-results-folder",
      createCommandContext("inspector", kernel, {
        feedback: "local",
        input: { itemId: item.id, name: item.name },
        sessionScopeKey: null,
        sourceDetail: "start-screen",
      }),
    );
    if (result.status === "completed") {
      homeView.close();
      return null;
    }
    return result.message ?? `Could not open saved playback for ${item.name}.`;
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
  const showInspector =
    section !== "docs" &&
    (section !== "home" || Boolean(selectedEntry || selectedScript || selectedResult));
  const isCompact = useSyncExternalStore(
    subscribeStartInspectorLayout,
    getStartInspectorLayout,
    () => false,
  );
  const [detailsOpen, setDetailsOpen] = useState(false);

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
    // Lazy Home mounting must not steal focus from a menu the user opened
    // while resources were loading.
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) {
      initialFocusRef.current?.focus();
    }
  }, []);

  // A section change moves focus to the new content, except when it came from
  // the rail, where the user is still navigating, or when DocsSection focuses
  // its own search input.
  useEffect(() => {
    if (previousSection.current === section) return;
    previousSection.current = section;
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (active && railRef.current?.contains(active)) return;
    if (section === "docs") return;
    mainRef.current?.focus();
  }, [section]);

  const projectInspector = showInspector ? (
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
        onOpenPlayback: openSavedPlayback,
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
        executionAvailability,
      }}
      projectCreator={projectCreator}
      scriptSaver={scriptSaver}
      section={section}
      templateId={selectedTemplateId}
      session={recent.state.kind === "ready" ? recent.state.index.continue : undefined}
      index={recent.state}
    />
  ) : null;

  return (
    <Sheet
      open={isCompact && detailsOpen && showInspector}
      onOpenChange={setDetailsOpen}
    >
      <div className="fm-start" data-inspector={showInspector ? "visible" : "hidden"} data-section={section}>
      <StartRail
        compute={compute}
        nodeInventory={computeProbe.nodeInventory}
        computeError={computeProbe.error}
        refreshing={computeProbe.refreshing}
        stale={computeProbe.stale}
        onRefreshCompute={computeProbe.refresh}
        onRunCommand={runCommand}
        ref={railRef}
        section={section}
      />
      <main className="fm-start__content" id="fm-main-content" ref={mainRef} tabIndex={-1}>
        {isCompact && showInspector ? (
          <div className="fm-start__details-action">
            <SheetTrigger asChild>
              <Button data-start-details-trigger size="sm" type="button" variant="secondary">Details</Button>
            </SheetTrigger>
          </div>
        ) : null}
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
              onOpenResult={openSavedPlayback}
              onResumeContinue={resumeContinue}
              onDiscardContinue={discardContinue}
              onRunCommand={runCommand}
              activeSessions={activeSessions}
              onOpenActiveSession={() => runCommand("workspace.return-to-workspace")}
              otherInstances={otherInstances}
              onOpenInstance={embeddedInTab ? undefined : instanceTabs.open}
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
              nodeInventory={computeProbe.nodeInventory}
              canEditNodePolicy={computeProbe.canEditNodePolicy}
              onUpdateNodePolicy={computeProbe.updateNodePolicy}
              canPublishExecutionProfiles={computeProbe.canPublishExecutionProfiles}
              onPublishExecutionProfile={computeProbe.publishExecutionProfile}
              computeError={computeProbe.error}
              refreshing={computeProbe.refreshing}
              stale={computeProbe.stale}
              onRefreshCompute={computeProbe.refresh}
              executionAvailability={executionAvailability}
              recent={recent}
              workspace={workspaceApi}
            />
          ) : (
            <AboutSection compute={compute} index={recent.state} />
          )}
        </div>
      </main>
      {projectInspector ? (
        isCompact ? (
          <SheetContent
            aria-describedby="fm-start-details-description"
            className="fm-start-details-sheet"
            onCloseAutoFocus={(event) => {
              setDetailsOpen(false);
              const trigger = document.querySelector<HTMLElement>("[data-start-details-trigger]");
              if (trigger?.isConnected && trigger.getClientRects().length > 0) return;
              event.preventDefault();
              mainRef.current?.focus();
            }}
            side="right"
          >
            <SheetHeader className="fm-start-details-sheet__header">
              <SheetTitle>Details</SheetTitle>
              <SheetDescription id="fm-start-details-description">
                Context, help, or actions for this section or selection.
              </SheetDescription>
            </SheetHeader>
            {projectInspector}
          </SheetContent>
        ) : projectInspector
      ) : null}
      <StartStatusBar compute={compute} index={recent.state} preferences={preferences}
        sessionLabel={sessionIdentity ? `Simulation open: ${sessionName ?? "Untitled simulation"}` : "No active session"} />
      </div>
    </Sheet>
  );
}
