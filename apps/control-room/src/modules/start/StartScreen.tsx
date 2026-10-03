"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useProjectDocumentSnapshot } from "@/kernel/persistence/ProjectDocumentStatus";
import { useSessionCollection } from "@/kernel/resources/useSessionCollection";
import type { ModuleProps } from "@/kernel/types";

import { HomeSection } from "./home/HomeSection";
import { LAUNCH_TILES } from "./home/LaunchTiles";
import { ProjectInspector } from "./inspector/ProjectInspector";
import { startActionDisabledReason } from "./model/startCommands";
import { startScreenStore, type StartScreenHost } from "./model/startScreenState";
import { StartRail } from "./rail/StartRail";
import { SectionPlaceholder } from "./sections/SectionPlaceholder";

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
  const { section } = useSyncExternalStore(
    startScreenStore.subscribe,
    startScreenStore.getSnapshot,
    startScreenStore.getServerSnapshot,
  );
  const canCreateProblem = sessions.state === "no-session";

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
    void kernel.commands.execute(commandId, context);
  };

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
      <StartRail compute={null} onRunCommand={runCommand} ref={railRef} section={section} />
      <main className="fm-start__content" id="fm-main-content" ref={mainRef} tabIndex={-1}>
        <div className="fm-start__content-inner">
          {section === "home" ? (
            <HomeSection
              browseDisabledReason={browseDisabledReason}
              disabledReasons={disabledReasons}
              initialFocusRef={initialFocusRef}
              onRunCommand={runCommand}
            />
          ) : (
            <SectionPlaceholder section={section} />
          )}
        </div>
      </main>
      <ProjectInspector section={section} />
    </div>
  );
}
