"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import AppBar from "@/components/shell/AppBar";
import {
  applyFrontendDiagnosticFlags,
  getDefaultFrontendDiagnosticFlags,
  loadFrontendDiagnosticFlagsFromStorage,
  persistFrontendDiagnosticFlags,
  type FrontendDiagnosticFlags,
} from "@/lib/debug/frontendDiagnosticFlags";

type Primitive = boolean | string | number | null;

type FlagEntry = {
  path: string;
  section: string;
  key: string;
  value: Primitive;
};

const LOCKED_PATHS = new Set(["shell.showRibbonBar"]);

const SECTION_LABELS: Record<string, string> = {
  workspace: "Workspace",
  dockCenterTabs: "DockCenter Tabs",
  session: "Session",
  shell: "Shell",
  viewportRouting: "Viewport Routing",
  viewportChrome: "Viewport Chrome",
  viewportCore: "Viewport Core",
  renderDebug: "Render Debug",
  magnetizationAuthoring: "Magnetization Authoring",
  femWrapper: "FEM Wrapper",
  femViewport: "FEM Viewport",
  vectorSurfaceViewport: "VectorSurface Viewport",
};

const DESCRIPTIONS: Record<string, string> = {
  "shell.showRibbonBar": "Always ON. Ribbon bar cannot be disabled.",
  "femViewport.enableSelectionOnlyInteractionMode": "Selection mode: disables camera controls and enables face picking.",
  "femViewport.enableGeometryHoverInteractions": "Hover raycast on mouse move (expensive on large meshes).",
  "viewportCore.frameloopMode": "Render loop mode for viewport canvas.",
  "workspace.standaloneDiagnosticViewportMode": "Standalone diagnostic viewport mode.",
  "workspace.enableWorkspaceTree": "Master kill-switch for entire Workspace tree (Entry -> Shell -> ControlRoom -> Docking).",
  "workspace.enableWorkspaceEntryPage": "Enable WorkspaceEntryPage mount/effects layer.",
  "workspace.enableWorkspaceShell": "Enable WorkspaceShell routing layer.",
  "workspace.enableRunControlRoom": "Enable dynamic RunControlRoom mount from WorkspaceShell.",
  "workspace.enableControlRoomShell": "Enable ControlRoomShell render body inside RunControlRoom.",
  "workspace.enableWorkspaceDockingShell": "Enable WorkspaceDockingShell branch.",
  "workspace.enableDockCenterTabs": "Enable DockCenterTabs content in docking center panel.",
  "workspace.enableDockingTooltipProviders": "Enable TooltipProvider wrappers in docking shell and center tab panel.",
  "workspace.enableWorkspaceGraphBridge": "Enable Graph V2 bridge synchronization from control-room runtime to graph store.",
  "dockCenterTabs.enableInternalTree": "Master switch for internal DockCenterTabs module tree.",
  "dockCenterTabs.enableAutoActivateEffect": "Auto-activate first tab when none is active.",
  "dockCenterTabs.enableEnsureChartsTabEffect": "Auto-create pinned core:charts tab if missing.",
  "dockCenterTabs.enableApplySelectionEffect": "Sync active tab with workspace mode/view/selection.",
  "dockCenterTabs.enableFeatureFlagsLoadingGate": "Block DockCenterTabs rendering until runtime feature flags resolve.",
  "dockCenterTabs.enableTooltipProvider": "Wrap DockCenterTabs UI with TooltipProvider.",
  "dockCenterTabs.enableTabsShell": "Render with Tabs primitive shell (disable for minimal direct content mode).",
  "dockCenterTabs.enableTabsHeader": "Render tab header row and triggers.",
  "dockCenterTabs.enableInlineCloseButton": "Render inline close button inside tab trigger.",
  "dockCenterTabs.enableTabContent": "Render mapped tab content panels.",
  "dockCenterTabs.showPreviewNotices": "Show preview stale/downscale notices above tab content.",
  "dockCenterTabs.enableChartsViewport": "Enable ChartsViewport for chart tabs.",
  "dockCenterTabs.enableAnalyzeViewport": "Enable AnalyzeViewport for analyze/result tabs.",
  "dockCenterTabs.enableViewportCanvas": "Enable ViewportCanvasArea for viewport/result-quantity tabs.",
  "dockCenterTabs.enablePinOverlayButton": "Enable bottom-right Pin/Unpin overlay button in tab panel.",
  "magnetizationAuthoring.enablePresetTextureBackendSync": "Immediately sync preset texture edits to backend scene state.",
  "magnetizationAuthoring.showPresetTextureBackendSyncProgress": "Show progress card for backend texture sync.",
  "magnetizationAuthoring.presetTextureBackendSyncDebounceMs": "Debounce window for texture sync requests (ms).",
  "viewportRouting.enableUnifiedViewportToolbar": "Master switch for unified Row A/Row B toolbar shell.",
  "vectorSurfaceViewport.enableCanvas3D": "Master kill-switch for VectorSurface 3D canvas.",
  "vectorSurfaceViewport.showToolbar": "Enable top-left toolbar shell in VectorSurface viewport.",
  "vectorSurfaceViewport.showTextureModeToolbar": "Enable bottom-center transform mode toolbar (Q/W/E/R).",
};

const ENUM_OPTIONS: Record<string, Array<{ label: string; value: string }>> = {
  "workspace.standaloneDiagnosticViewportMode": [
    { label: "Off", value: "off" },
    { label: "Three", value: "three" },
    { label: "R3F", value: "r3f" },
    { label: "FEM", value: "fem" },
    { label: "FEM Scene", value: "fem-scene" },
  ],
  "viewportCore.frameloopMode": [
    { label: "Always", value: "always" },
    { label: "Demand", value: "demand" },
    { label: "Never", value: "never" },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function flattenFlags(input: unknown, prefix = ""): FlagEntry[] {
  if (!isRecord(input)) return [];
  const entries: FlagEntry[] = [];
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value)) {
      entries.push(...flattenFlags(value, path));
      continue;
    }
    if (
      typeof value === "boolean" ||
      typeof value === "string" ||
      typeof value === "number" ||
      value === null
    ) {
      const [section, ...rest] = path.split(".");
      entries.push({
        path,
        section,
        key: rest.join("."),
        value,
      });
    }
  }
  return entries;
}

function setByPath<T extends object>(target: T, path: string, nextValue: Primitive): T {
  const keys = path.split(".");
  const root: Record<string, unknown> = structuredClone(target) as Record<string, unknown>;
  let cursor: Record<string, unknown> = root;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    const child = cursor[key];
    if (!isRecord(child)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]] = nextValue;
  return root as T;
}

function enforceHardConstraints(next: FrontendDiagnosticFlags): FrontendDiagnosticFlags {
  const cloned = structuredClone(next);
  cloned.shell.showRibbonBar = true;
  return cloned;
}

function labelFor(path: string, key: string): string {
  const pretty = key.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim();
  return pretty.length > 0 ? pretty[0].toUpperCase() + pretty.slice(1) : path;
}

export default function FrontendDiagnosticSettingsPage() {
  const router = useRouter();
  const [draft, setDraft] = useState<FrontendDiagnosticFlags>(() =>
    loadFrontendDiagnosticFlagsFromStorage(),
  );

  const grouped = useMemo(() => {
    const flat = flattenFlags(draft);
    const bySection = new Map<string, FlagEntry[]>();
    for (const entry of flat) {
      const current = bySection.get(entry.section) ?? [];
      current.push(entry);
      bySection.set(entry.section, current);
    }
    return Array.from(bySection.entries()).map(([section, entries]) => ({
      section,
      label: SECTION_LABELS[section] ?? section,
      entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    }));
  }, [draft]);

  const hasUnsavedChanges =
    JSON.stringify(draft) !== JSON.stringify(loadFrontendDiagnosticFlagsFromStorage());

  const handleSave = () => {
    const constrained = enforceHardConstraints(draft);
    applyFrontendDiagnosticFlags(constrained);
    persistFrontendDiagnosticFlags(constrained);
    window.location.reload();
  };

  const handleReset = () => {
    const defaults = getDefaultFrontendDiagnosticFlags();
    setDraft(enforceHardConstraints(defaults));
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AppBar
        problemName="Frontend Settings"
        backend="local"
        status="settings"
        connection="connected"
        canSyncScriptBuilder={false}
        scriptSyncBusy={false}
      />

      <div className="mx-auto flex w-full max-w-[1500px] gap-0 px-4 py-4">
        <aside className="sticky top-16 h-[calc(100vh-5rem)] w-72 shrink-0 overflow-auto rounded-l-lg border border-border/50 bg-card/40 p-3">
          <div className="mb-3 text-[0.72rem] font-semibold uppercase tracking-widest text-muted-foreground">Settings</div>
          <div className="space-y-1">
            {grouped.map((section) => (
              <a
                key={section.section}
                href={`#section-${section.section}`}
                className="block rounded px-2 py-1.5 text-sm text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
              >
                {section.label}
              </a>
            ))}
          </div>
        </aside>

        <main className="min-h-[calc(100vh-5rem)] flex-1 overflow-auto rounded-r-lg border-y border-r border-border/50 bg-card/20 p-5">
          <div className="mb-6 flex items-center justify-between gap-4 border-b border-border/40 pb-4">
            <div>
              <h1 className="text-lg font-semibold">Frontend Diagnostic Flags</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                VSCode-style settings panel. Changes are applied after save + page reload.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => router.push("/workspace")}
                className="rounded border border-border/60 px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              >
                Back to Workspace
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="rounded border border-border/60 px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              >
                Reset to Defaults
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="rounded border border-primary/40 bg-primary/15 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
                disabled={!hasUnsavedChanges}
              >
                Save and Reload
              </button>
            </div>
          </div>

          <div className="space-y-8">
            {grouped.map((section) => (
              <section key={section.section} id={`section-${section.section}`} className="space-y-3">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  {section.label}
                </h2>

                <div className="overflow-hidden rounded border border-border/40">
                  {section.entries.map((entry) => {
                    const lock = LOCKED_PATHS.has(entry.path);
                    const enumOptions = ENUM_OPTIONS[entry.path];
                    const desc = DESCRIPTIONS[entry.path] ?? `Path: ${entry.path}`;

                    return (
                      <div
                        key={entry.path}
                        className="flex items-start justify-between gap-4 border-b border-border/30 px-3 py-2 last:border-b-0"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{labelFor(entry.path, entry.key)}</div>
                          <div className="text-xs text-muted-foreground">{desc}</div>
                          <div className="mt-0.5 text-[0.68rem] font-mono text-muted-foreground/80">{entry.path}</div>
                        </div>

                        <div className="shrink-0">
                          {typeof entry.value === "boolean" ? (
                            <label className="inline-flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={entry.value}
                                disabled={lock}
                                onChange={(event) => {
                                  setDraft((prev) =>
                                    setByPath(prev, entry.path, event.target.checked),
                                  );
                                }}
                              />
                              {entry.value ? "ON" : "OFF"}
                            </label>
                          ) : enumOptions ? (
                            <select
                              className="rounded border border-border/60 bg-muted/40 px-2 py-1 text-sm"
                              value={String(entry.value)}
                              disabled={lock}
                              onChange={(event) => {
                                setDraft((prev) =>
                                  setByPath(prev, entry.path, event.target.value),
                                );
                              }}
                            >
                              {enumOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          ) : entry.value === null || typeof entry.value === "number" ? (
                            <input
                              type="number"
                              className="w-28 rounded border border-border/60 bg-muted/40 px-2 py-1 text-sm"
                              value={entry.value ?? ""}
                              placeholder="null"
                              disabled={lock}
                              onChange={(event) => {
                                const raw = event.target.value.trim();
                                const parsed = raw.length === 0 ? null : Number(raw);
                                const nextValue = parsed == null || Number.isNaN(parsed) ? null : parsed;
                                setDraft((prev) =>
                                  setByPath(prev, entry.path, nextValue),
                                );
                              }}
                            />
                          ) : (
                            <input
                              type="text"
                              className="w-40 rounded border border-border/60 bg-muted/40 px-2 py-1 text-sm"
                              value={String(entry.value)}
                              disabled={lock}
                              onChange={(event) => {
                                setDraft((prev) =>
                                  setByPath(prev, entry.path, event.target.value),
                                );
                              }}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
