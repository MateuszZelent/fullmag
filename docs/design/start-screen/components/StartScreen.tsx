"use client";

/**
 * Start screen shell — rail | content | inspector.
 *
 * Replaces EmptyWorkspace as the no-session body of WorkspaceShell. It renders
 * into the same grid row, so the window chrome (title bar, menu bar, status
 * bar) is untouched and there is no flash when a project opens.
 *
 * Reference implementation — intended to live at
 * apps/control-room/src/modules/start/StartScreen.tsx
 */

import {
  GraduationCap,
  Home,
  Import,
  Info,
  LayoutGrid,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/shared/utils/className";

import type {
  ComputeEnvironment,
  InspectorTab,
  RecentEntry,
  RecentIndexState,
  StartScreenState,
  StartSection,
} from "./types";

export interface StartScreenProps {
  readonly indexState: RecentIndexState;
  readonly compute?: ComputeEnvironment;
  readonly userName?: string;
  readonly onCommand: (commandId: string, input?: unknown) => void;
  readonly onRebuildIndex: () => void;
}

const SECTIONS: ReadonlyArray<{
  readonly id: StartSection;
  readonly label: string;
  readonly Icon: typeof Home;
  readonly shortcut?: string;
}> = [
  { id: "home", label: "Home", Icon: Home, shortcut: "Ctrl 1" },
  { id: "templates", label: "Templates", Icon: LayoutGrid, shortcut: "Ctrl 2" },
  { id: "import", label: "Import", Icon: Import, shortcut: "Ctrl 3" },
  { id: "learn", label: "Learn", Icon: GraduationCap, shortcut: "Ctrl 4" },
  { id: "settings", label: "Settings", Icon: Settings, shortcut: "Ctrl ," },
  { id: "about", label: "About", Icon: Info },
];

const INITIAL_STATE: StartScreenState = {
  section: "home",
  view: "list",
  filter: "all",
  sort: "lastOpened",
  query: "",
  selectedProjectId: null,
  inspectorTab: "overview",
  inspectorVisible: true,
};

export function StartScreen({
  indexState,
  compute,
  userName,
  onCommand,
  onRebuildIndex,
}: StartScreenProps) {
  const [state, setState] = useState<StartScreenState>(INITIAL_STATE);
  const filterRef = useRef<HTMLInputElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);

  const entries: readonly RecentEntry[] =
    indexState.kind === "ready" ? indexState.index.entries : [];

  const session = indexState.kind === "ready" ? indexState.index.continue : undefined;

  // Select the first entry once the index resolves, so the inspector is never
  // empty on a screen that has projects to show.
  useEffect(() => {
    if (state.selectedProjectId || entries.length === 0) return;
    setState((s) => ({ ...s, selectedProjectId: entries[0]!.projectId }));
  }, [entries, state.selectedProjectId]);

  // Initial focus: the resume button when there is a checkpoint, otherwise the
  // first launch tile. Never the filter field — landing in a text input means
  // the user's first keystroke is swallowed.
  useEffect(() => {
    firstActionRef.current?.focus();
  }, []);

  const setSection = useCallback((section: StartSection) => {
    setState((s) => ({ ...s, section }));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      // "/" focuses the filter, but not while the user is already typing.
      if (event.key === "/" && !typing && state.section === "home") {
        event.preventDefault();
        filterRef.current?.focus();
        return;
      }

      if (!(event.ctrlKey || event.metaKey)) return;

      const index = ["1", "2", "3", "4"].indexOf(event.key);
      if (index >= 0) {
        event.preventDefault();
        setSection(SECTIONS[index]!.id);
        return;
      }

      switch (event.key.toLowerCase()) {
        case "n":
          event.preventDefault();
          onCommand("workspace.new-problem", { solver: event.shiftKey ? "FEM" : "FDM" });
          break;
        case "o":
          event.preventDefault();
          onCommand(event.shiftKey ? "start.quick-switch" : "workspace.open-project");
          break;
        case "t":
          event.preventDefault();
          setSection("templates");
          break;
        case "i":
          event.preventDefault();
          setSection("import");
          break;
        case ",":
          event.preventDefault();
          setSection("settings");
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCommand, setSection, state.section]);

  const selectedEntry = useMemo(
    () => entries.find((e) => e.projectId === state.selectedProjectId) ?? null,
    [entries, state.selectedProjectId],
  );

  return (
    <div
      className={cn(
        "grid min-h-0 bg-fm-app",
        state.inspectorVisible
          ? "grid-cols-[var(--fm-start-rail-width)_minmax(0,1fr)_var(--fm-start-inspector-width)]"
          : "grid-cols-[var(--fm-start-rail-width)_minmax(0,1fr)]",
        // Below 1180px the inspector becomes a sheet opened with Space.
        "max-[1180px]:grid-cols-[var(--fm-start-rail-width)_minmax(0,1fr)]",
      )}
      data-slot="start-screen"
      data-state={indexState.kind}
    >
      <nav
        aria-label="Start screen sections"
        className="flex min-h-0 flex-col border-r border-fm-subtle bg-fm-chrome px-fm-2 py-fm-3"
      >
        <IdentityBlock onSelect={() => setSection("about")} />

        <div className="flex flex-col gap-px">
          {SECTIONS.map(({ id, label, Icon, shortcut }) => {
            const active = state.section === id;
            return (
              <button
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group relative flex h-[30px] w-full items-center gap-fm-2 rounded-fm-md px-fm-2",
                  "text-left font-fm-ui text-fm-sm font-medium text-fm-secondary",
                  "transition-[background-color,color] duration-150",
                  "hover:bg-fm-raised hover:text-fm-primary",
                  active &&
                    "bg-fm-selected text-fm-accent before:absolute before:-left-2 before:top-[7px] before:bottom-[7px] before:w-0.5 before:rounded-r-sm before:bg-fm-accent",
                )}
                key={id}
                onClick={() => setSection(id)}
                type="button"
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span>{label}</span>
                {shortcut && (
                  <kbd
                    className={cn(
                      "ml-auto rounded-fm-xs border border-fm-subtle bg-fm-raised px-1 py-px",
                      "font-fm-ui text-fm-2xs text-fm-muted opacity-0 transition-opacity",
                      "group-hover:opacity-100",
                      active && "opacity-100",
                    )}
                  >
                    {shortcut}
                  </kbd>
                )}
              </button>
            );
          })}
        </div>

        <div className="my-fm-3 h-px bg-fm-subtle" />
        <ComputeEnvironmentWidget compute={compute} onConfigure={() => setSection("settings")} />
      </nav>

      <main
        className="min-h-0 overflow-y-auto overflow-x-hidden"
        id="fm-main-content"
        tabIndex={-1}
      >
        <div className="mx-auto max-w-[var(--fm-start-content-max)] px-fm-6 pb-fm-12 pt-fm-6">
          {/*
            Section bodies live in their own files; the shell only owns layout,
            selection and the keyboard map. See docs/02-implementation-guide.md §2.

            {state.section === "home" && (
              <HomeSection
                entries={entries}
                filterRef={filterRef}
                firstActionRef={firstActionRef}
                indexState={indexState}
                onCommand={onCommand}
                onRebuildIndex={onRebuildIndex}
                onStateChange={setState}
                session={session}
                state={state}
                userName={userName}
              />
            )}
            {state.section === "templates" && <TemplatesSection onCommand={onCommand} />}
            …
          */}
        </div>
      </main>

      {state.inspectorVisible && (
        <aside
          aria-label="Project details"
          className="flex min-h-0 min-w-0 flex-col border-l border-fm-subtle bg-fm-panel max-[1180px]:hidden"
        >
          {/*
            <ProjectInspector
              entry={selectedEntry}
              section={state.section}
              session={session}
              tab={state.inspectorTab}
              onTabChange={(tab: InspectorTab) => setState((s) => ({ ...s, inspectorTab: tab }))}
              onCommand={onCommand}
            />
          */}
        </aside>
      )}
    </div>
  );
}

/* ── Rail pieces ────────────────────────────────────────────────────────── */

function IdentityBlock({ onSelect }: { readonly onSelect: () => void }) {
  return (
    <button
      className="flex items-center gap-fm-2 rounded-fm-md px-fm-2 pb-fm-3 pt-fm-1 text-left hover:bg-fm-raised"
      onClick={onSelect}
      type="button"
    >
      <span className="size-[30px] shrink-0 overflow-hidden rounded-fm-md bg-[linear-gradient(135deg,var(--fm-accent),var(--fm-accent-strong))] shadow-fm-sm" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-fm-ui text-fm-md font-[650] leading-none">Fullmag</span>
        <span className="flex items-center gap-1.5 font-fm-mono text-fm-2xs text-fm-muted">
          0.9.3
          <span className="rounded-fm-xs bg-[color-mix(in_srgb,var(--fm-degraded)_18%,transparent)] px-1 py-px font-fm-ui text-[9px] font-semibold uppercase tracking-wider text-fm-degraded">
            beta
          </span>
        </span>
      </span>
    </button>
  );
}

/**
 * The highest-value element on the screen for a simulation tool: it answers
 * "can this machine run what I am about to open?" before anything is opened.
 */
function ComputeEnvironmentWidget({
  compute,
  onConfigure,
}: {
  readonly compute?: ComputeEnvironment;
  readonly onConfigure: () => void;
}) {
  const gpu = compute?.gpus[0];
  const tone = !compute
    ? "loading"
    : !gpu
      ? "degraded"
      : gpu.busyWithRun
        ? "busy"
        : "ready";

  const usedFraction = gpu ? 1 - gpu.vramFreeBytes / gpu.vramTotalBytes : 0;

  return (
    <div className="mt-auto rounded-fm-md border border-fm-subtle bg-fm-panel p-fm-2">
      <p className="px-fm-1 pb-fm-2 font-fm-ui text-fm-2xs font-semibold uppercase tracking-[0.07em] text-fm-muted">
        Compute environment
      </p>

      <div className="flex min-w-0 items-center gap-fm-2 font-fm-ui text-fm-xs text-fm-secondary">
        <span
          aria-hidden="true"
          className={cn(
            "size-[7px] shrink-0 rounded-full",
            tone === "ready" && "bg-fm-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--fm-success)_22%,transparent)]",
            tone === "busy" && "bg-fm-warning shadow-[0_0_0_3px_color-mix(in_srgb,var(--fm-warning)_22%,transparent)]",
            tone === "degraded" && "bg-fm-degraded",
            tone === "loading" && "bg-fm-muted",
          )}
        />
        <span className="truncate font-semibold text-fm-primary">
          {gpu?.name ?? (compute ? "No GPU detected" : "Detecting…")}
        </span>
        {gpu?.cudaVersion && (
          <span className="ml-auto whitespace-nowrap font-fm-mono text-fm-2xs text-fm-muted">
            CUDA {gpu.cudaVersion}
          </span>
        )}
      </div>

      {gpu ? (
        <>
          <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-fm-raised">
            <div
              className="h-full rounded-full bg-fm-accent"
              style={{ width: `${Math.round(usedFraction * 100)}%` }}
            />
          </div>
          <div className="mt-1 flex items-center justify-between font-fm-mono text-fm-2xs text-fm-muted">
            <span>VRAM</span>
            <span>
              {(gpu.vramTotalBytes - gpu.vramFreeBytes) / 1e9 < 10
                ? ((gpu.vramTotalBytes - gpu.vramFreeBytes) / 1e9).toFixed(1)
                : Math.round((gpu.vramTotalBytes - gpu.vramFreeBytes) / 1e9)}{" "}
              / {(gpu.vramTotalBytes / 1e9).toFixed(1)} GB
            </span>
          </div>
        </>
      ) : (
        compute && (
          <p className="mt-1.5 font-fm-ui text-fm-2xs leading-relaxed text-fm-degraded">
            CPU fallback — roughly 40× slower than the GPU backend.
          </p>
        )
      )}

      {compute && (
        <div className="mt-fm-2 flex items-center justify-between font-fm-ui text-fm-xs text-fm-secondary">
          <span>CPU</span>
          <span className="font-fm-mono text-fm-2xs text-fm-muted">{compute.cpuThreads} threads</span>
        </div>
      )}

      <button
        className="mt-fm-2 flex h-6 w-full items-center justify-center gap-1.5 rounded-fm-sm font-fm-ui text-fm-xs text-fm-muted hover:bg-fm-raised hover:text-fm-primary"
        onClick={onConfigure}
        type="button"
      >
        <Settings aria-hidden="true" className="size-3.5" />
        Configure compute
      </button>
    </div>
  );
}
