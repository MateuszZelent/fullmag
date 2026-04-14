import { create } from "zustand";
import type { LaunchIntent } from "./launch-intent";

export type WorkspaceMode = "build" | "study" | "analyze";
export type RightInspectorTab = "selected-submeshes" | "tools" | "console";

export type WorkspaceTabKind =
  | "viewport-3d"
  | "viewport-2d"
  | "viewport-mesh"
  | "viewport-charts"
  | "analyze"
  | "result-spectrum"
  | "result-dispersion"
  | "result-modes"
  | "result-time-traces"
  | "result-vortex-frequency"
  | "result-vortex-trajectory"
  | "result-vortex-orbit"
  | "result-quantity"
  | "result-table";

export interface WorkspaceTab {
  id: string;
  key: string;
  kind: WorkspaceTabKind;
  title: string;
  closable: boolean;
  pinned: boolean;
  keepAlive: boolean;
  payload?: {
    resultWorkspaceId?: string;
    quantityId?: string;
    analyzeDomain?: "eigenmodes" | "vortex";
    analyzeTab?: string;
    viewMode?: "3D" | "2D" | "Mesh" | "Analyze";
  };
}

export interface WorkspaceTabInput {
  id?: string;
  key: string;
  kind: WorkspaceTabKind;
  title: string;
  closable?: boolean;
  pinned?: boolean;
  keepAlive?: boolean;
  payload?: WorkspaceTab["payload"];
}

export type DockLayoutModel = Record<string, unknown>;

interface StageLayoutState {
  leftDock: string | null;
  centerDock: string | null;
  rightDock: string | null;
  bottomDock: string | null;
}

const STAGES: WorkspaceMode[] = ["build", "study", "analyze"];
const DOCKING_STORAGE_KEY = "fullmag.workspace.docking.v1";

function defaultCoreTabs(): WorkspaceTab[] {
  return [
    {
      id: "core:3d",
      key: "core:3d",
      kind: "viewport-3d",
      title: "3D Viewport",
      closable: false,
      pinned: true,
      keepAlive: true,
      payload: { viewMode: "3D" },
    },
    {
      id: "core:2d",
      key: "core:2d",
      kind: "viewport-2d",
      title: "2D Slice",
      closable: false,
      pinned: true,
      keepAlive: true,
      payload: { viewMode: "2D" },
    },
    {
      id: "core:mesh",
      key: "core:mesh",
      kind: "viewport-mesh",
      title: "Mesh Workspace",
      closable: false,
      pinned: true,
      keepAlive: true,
      payload: { viewMode: "Mesh" },
    },
    {
      id: "core:analyze",
      key: "core:analyze",
      kind: "analyze",
      title: "Analyze",
      closable: false,
      pinned: true,
      keepAlive: false,
      payload: { viewMode: "Analyze", analyzeDomain: "eigenmodes", analyzeTab: "spectrum" },
    },
    {
      id: "core:charts",
      key: "core:charts",
      kind: "viewport-charts",
      title: "Charts",
      closable: false,
      pinned: true,
      keepAlive: true,
      payload: { viewMode: "Analyze" },
    },
  ];
}

function cloneTabsByStage(input: Record<WorkspaceMode, WorkspaceTab[]>): Record<WorkspaceMode, WorkspaceTab[]> {
  return {
    build: input.build.map((tab) => ({ ...tab, payload: tab.payload ? { ...tab.payload } : undefined })),
    study: input.study.map((tab) => ({ ...tab, payload: tab.payload ? { ...tab.payload } : undefined })),
    analyze: input.analyze.map((tab) => ({ ...tab, payload: tab.payload ? { ...tab.payload } : undefined })),
  };
}

const DEFAULT_STAGE_LAYOUTS: Record<WorkspaceMode, StageLayoutState> = {
  build: {
    leftDock: "model",
    centerDock: "settings",
    rightDock: "properties",
    bottomDock: "messages",
  },
  study: {
    leftDock: "study-tree",
    centerDock: "viewport-controls",
    rightDock: "solver",
    bottomDock: "jobs",
  },
  analyze: {
    leftDock: "results-tree",
    centerDock: "plots",
    rightDock: "display",
    bottomDock: "charts",
  },
};

const DEFAULT_WORKSPACE_TABS: Record<WorkspaceMode, WorkspaceTab[]> = {
  build: defaultCoreTabs(),
  study: defaultCoreTabs(),
  analyze: defaultCoreTabs(),
};

const DEFAULT_ACTIVE_WORKSPACE_TAB: Record<WorkspaceMode, string | null> = {
  build: "core:3d",
  study: "core:3d",
  analyze: "core:analyze",
};

const DEFAULT_DOCK_LAYOUTS: Record<WorkspaceMode, DockLayoutModel | null> = {
  build: null,
  study: null,
  analyze: null,
};

interface PersistedDockingState {
  workspaceTabsByStage: Record<WorkspaceMode, WorkspaceTab[]>;
  activeWorkspaceTabByStage: Record<WorkspaceMode, string | null>;
  dockLayoutByStage: Record<WorkspaceMode, DockLayoutModel | null>;
}

export interface WorkspaceUiStateSnapshot {
  version: 1;
  docking: PersistedDockingState;
  currentStage: WorkspaceMode;
  rightInspectorOpen: boolean;
  rightInspectorTab: RightInspectorTab;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePersistedDockingState(raw: string | null): PersistedDockingState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) return null;

    const tabs = parsed.workspaceTabsByStage;
    const active = parsed.activeWorkspaceTabByStage;
    const dock = parsed.dockLayoutByStage;

    if (!isPlainObject(tabs) || !isPlainObject(active) || !isPlainObject(dock)) {
      return null;
    }

    const workspaceTabsByStage: Record<WorkspaceMode, WorkspaceTab[]> = {
      build: Array.isArray(tabs.build) ? (tabs.build as WorkspaceTab[]) : defaultCoreTabs(),
      study: Array.isArray(tabs.study) ? (tabs.study as WorkspaceTab[]) : defaultCoreTabs(),
      analyze: Array.isArray(tabs.analyze) ? (tabs.analyze as WorkspaceTab[]) : defaultCoreTabs(),
    };

    const activeWorkspaceTabByStage: Record<WorkspaceMode, string | null> = {
      build: typeof active.build === "string" ? (active.build as string) : DEFAULT_ACTIVE_WORKSPACE_TAB.build,
      study: typeof active.study === "string" ? (active.study as string) : DEFAULT_ACTIVE_WORKSPACE_TAB.study,
      analyze: typeof active.analyze === "string" ? (active.analyze as string) : DEFAULT_ACTIVE_WORKSPACE_TAB.analyze,
    };

    const dockLayoutByStage: Record<WorkspaceMode, DockLayoutModel | null> = {
      build: isPlainObject(dock.build) ? (dock.build as DockLayoutModel) : null,
      study: isPlainObject(dock.study) ? (dock.study as DockLayoutModel) : null,
      analyze: isPlainObject(dock.analyze) ? (dock.analyze as DockLayoutModel) : null,
    };

    return {
      workspaceTabsByStage,
      activeWorkspaceTabByStage,
      dockLayoutByStage,
    };
  } catch {
    return null;
  }
}

function loadPersistedDockingState(): PersistedDockingState | null {
  if (typeof window === "undefined") {
    return null;
  }
  return parsePersistedDockingState(window.localStorage.getItem(DOCKING_STORAGE_KEY));
}

function persistDockingState(payload: PersistedDockingState): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(DOCKING_STORAGE_KEY, JSON.stringify(payload));
}

function persistDockingFromState(state: WorkspaceStoreState): void {
  persistDockingState({
    workspaceTabsByStage: state.workspaceTabsByStage,
    activeWorkspaceTabByStage: state.activeWorkspaceTabByStage,
    dockLayoutByStage: state.dockLayoutByStage,
  });
}

interface WorkspaceStoreState {
  currentStage: WorkspaceMode;
  activeCoreTab: string;
  activeContextualTab: string | null;
  stageLayouts: Record<WorkspaceMode, StageLayoutState>;
  selectionId: string | null;
  activeProjectId: string | null;
  launcherVisible: boolean;
  launchIntent: LaunchIntent | null;
  rightInspectorOpen: boolean;
  rightInspectorTab: RightInspectorTab;
  settingsOpen: boolean;
  physicsDocsOpen: boolean;
  physicsDocsTopic: string | null;

  workspaceTabsByStage: Record<WorkspaceMode, WorkspaceTab[]>;
  activeWorkspaceTabByStage: Record<WorkspaceMode, string | null>;
  dockLayoutByStage: Record<WorkspaceMode, DockLayoutModel | null>;

  setCurrentStage: (mode: WorkspaceMode) => void;
  setActiveCoreTab: (tab: string) => void;
  setActiveContextualTab: (tab: string | null) => void;
  setLeftDock: (mode: WorkspaceMode, dock: string | null) => void;
  setCenterDock: (mode: WorkspaceMode, dock: string | null) => void;
  setRightDock: (mode: WorkspaceMode, dock: string | null) => void;
  setBottomDock: (mode: WorkspaceMode, dock: string | null) => void;
  setSelectionId: (id: string | null) => void;
  setActiveProjectId: (id: string | null) => void;
  setLauncherVisible: (visible: boolean) => void;
  setLaunchIntent: (intent: LaunchIntent | null) => void;
  setRightInspectorOpen: (open: boolean) => void;
  setRightInspectorTab: (tab: RightInspectorTab) => void;
  setSettingsOpen: (open: boolean) => void;
  setPhysicsDocsOpen: (open: boolean, topic?: string | null) => void;

  openTab: (stage: WorkspaceMode, tab: WorkspaceTabInput) => string;
  closeTab: (stage: WorkspaceMode, tabId: string) => void;
  activateTab: (stage: WorkspaceMode, tabId: string | null) => void;
  pinTab: (stage: WorkspaceMode, tabId: string, pinned: boolean) => void;
  syncTabsFromArtifacts: (stage: WorkspaceMode, artifactPaths: string[]) => void;
  setDockLayout: (stage: WorkspaceMode, model: DockLayoutModel | null) => void;
  resetDockingState: () => void;
  exportUiStateSnapshot: () => WorkspaceUiStateSnapshot;
  importUiStateSnapshot: (snapshot: unknown) => boolean;
}

function updateStageLayout(
  state: WorkspaceStoreState,
  mode: WorkspaceMode,
  patch: Partial<StageLayoutState>,
): Record<WorkspaceMode, StageLayoutState> {
  return {
    ...state.stageLayouts,
    [mode]: { ...state.stageLayouts[mode], ...patch },
  };
}

const persistedDockingState = loadPersistedDockingState();

function ensureCoreTabsForStage(tabs: WorkspaceTab[] | undefined): WorkspaceTab[] {
  const incoming = Array.isArray(tabs) ? tabs : [];
  const coreTabs = defaultCoreTabs();
  const incomingById = new Map(incoming.map((tab) => [tab.id, tab]));
  const merged: WorkspaceTab[] = coreTabs.map((core) => incomingById.get(core.id) ?? core);
  const extra = incoming.filter((tab) => !coreTabs.some((core) => core.id === tab.id));
  return [...merged, ...extra];
}

function mergedDockingStateFromDefaults(): PersistedDockingState {
  const persistedTabs = persistedDockingState?.workspaceTabsByStage;
  const workspaceTabsByStage: Record<WorkspaceMode, WorkspaceTab[]> = {
    build: ensureCoreTabsForStage(persistedTabs?.build ?? DEFAULT_WORKSPACE_TABS.build),
    study: ensureCoreTabsForStage(persistedTabs?.study ?? DEFAULT_WORKSPACE_TABS.study),
    analyze: ensureCoreTabsForStage(persistedTabs?.analyze ?? DEFAULT_WORKSPACE_TABS.analyze),
  };
  const persistedActive: Partial<Record<WorkspaceMode, string | null>> =
    persistedDockingState?.activeWorkspaceTabByStage ?? {};
  const activeWorkspaceTabByStage: Record<WorkspaceMode, string | null> = {
    build:
      persistedActive.build &&
      workspaceTabsByStage.build.some((tab) => tab.id === persistedActive.build)
        ? persistedActive.build
        : DEFAULT_ACTIVE_WORKSPACE_TAB.build,
    study:
      persistedActive.study &&
      workspaceTabsByStage.study.some((tab) => tab.id === persistedActive.study)
        ? persistedActive.study
        : DEFAULT_ACTIVE_WORKSPACE_TAB.study,
    analyze:
      persistedActive.analyze &&
      workspaceTabsByStage.analyze.some((tab) => tab.id === persistedActive.analyze)
        ? persistedActive.analyze
        : DEFAULT_ACTIVE_WORKSPACE_TAB.analyze,
  };
  return {
    workspaceTabsByStage,
    activeWorkspaceTabByStage,
    dockLayoutByStage: {
      ...DEFAULT_DOCK_LAYOUTS,
      ...(persistedDockingState?.dockLayoutByStage ?? {}),
    },
  };
}

export const useWorkspaceStore = create<WorkspaceStoreState>((set, get) => {
  const dockingState = mergedDockingStateFromDefaults();

  return {
    currentStage: "analyze",
    activeCoreTab: "Home",
    activeContextualTab: null,
    stageLayouts: DEFAULT_STAGE_LAYOUTS,
    selectionId: null,
    activeProjectId: null,
    launcherVisible: false,
    launchIntent: null,
    rightInspectorOpen: false,
    rightInspectorTab: "console",
    settingsOpen: false,
    physicsDocsOpen: false,
    physicsDocsTopic: null,

    workspaceTabsByStage: dockingState.workspaceTabsByStage,
    activeWorkspaceTabByStage: dockingState.activeWorkspaceTabByStage,
    dockLayoutByStage: dockingState.dockLayoutByStage,

    setCurrentStage: (currentStage) =>
      set((state) => (state.currentStage === currentStage ? state : { currentStage })),
    setActiveCoreTab: (activeCoreTab) =>
      set((state) => (state.activeCoreTab === activeCoreTab ? state : { activeCoreTab })),
    setActiveContextualTab: (activeContextualTab) =>
      set((state) =>
        state.activeContextualTab === activeContextualTab ? state : { activeContextualTab },
      ),
    setLeftDock: (mode, leftDock) =>
      set((state) => ({ stageLayouts: updateStageLayout(state, mode, { leftDock }) })),
    setCenterDock: (mode, centerDock) =>
      set((state) => ({ stageLayouts: updateStageLayout(state, mode, { centerDock }) })),
    setRightDock: (mode, rightDock) =>
      set((state) => ({ stageLayouts: updateStageLayout(state, mode, { rightDock }) })),
    setBottomDock: (mode, bottomDock) =>
      set((state) => ({ stageLayouts: updateStageLayout(state, mode, { bottomDock }) })),
    setSelectionId: (selectionId) => set({ selectionId }),
    setActiveProjectId: (activeProjectId) => set({ activeProjectId }),
    setLauncherVisible: (launcherVisible) => set({ launcherVisible }),
    setLaunchIntent: (launchIntent) => set({ launchIntent }),
    setRightInspectorOpen: (rightInspectorOpen) => set({ rightInspectorOpen }),
    setRightInspectorTab: (rightInspectorTab) => set({ rightInspectorTab }),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    setPhysicsDocsOpen: (physicsDocsOpen, topic = null) =>
      set((state) => ({
        physicsDocsOpen,
        physicsDocsTopic: topic !== undefined ? topic : state.physicsDocsTopic,
      })),

    openTab: (stage, tabInput) => {
      let activeId = tabInput.id ?? `${tabInput.kind}:${Date.now()}`;
      set((state) => {
        const tabs = state.workspaceTabsByStage[stage];
        const existing = tabs.find(
          (tab) => tab.id === tabInput.id || tab.key === tabInput.key,
        );
        if (existing) {
          activeId = existing.id;
          const nextState = {
            activeWorkspaceTabByStage: {
              ...state.activeWorkspaceTabByStage,
              [stage]: existing.id,
            },
          };
          persistDockingFromState({ ...state, ...nextState });
          return nextState;
        }

        const created: WorkspaceTab = {
          id: activeId,
          key: tabInput.key,
          kind: tabInput.kind,
          title: tabInput.title,
          closable: tabInput.closable ?? true,
          pinned: tabInput.pinned ?? false,
          keepAlive: tabInput.keepAlive ?? false,
          payload: tabInput.payload,
        };

        const nextState = {
          workspaceTabsByStage: {
            ...state.workspaceTabsByStage,
            [stage]: [...tabs, created],
          },
          activeWorkspaceTabByStage: {
            ...state.activeWorkspaceTabByStage,
            [stage]: created.id,
          },
        };
        persistDockingFromState({ ...state, ...nextState });
        return nextState;
      });
      return activeId;
    },

    closeTab: (stage, tabId) =>
      set((state) => {
        const tabs = state.workspaceTabsByStage[stage];
        const target = tabs.find((tab) => tab.id === tabId);
        if (!target || !target.closable || target.pinned) {
          return state;
        }

        const filtered = tabs.filter((tab) => tab.id !== tabId);
        const currentActive = state.activeWorkspaceTabByStage[stage];
        const nextActive =
          currentActive === tabId
            ? (filtered[filtered.length - 1]?.id ?? null)
            : currentActive;

        const nextState = {
          workspaceTabsByStage: {
            ...state.workspaceTabsByStage,
            [stage]: filtered,
          },
          activeWorkspaceTabByStage: {
            ...state.activeWorkspaceTabByStage,
            [stage]: nextActive,
          },
        };
        persistDockingFromState({ ...state, ...nextState });
        return nextState;
      }),

    activateTab: (stage, tabId) =>
      set((state) => {
        const tabs = state.workspaceTabsByStage[stage];
        if (tabId != null && !tabs.some((tab) => tab.id === tabId)) {
          return state;
        }
        const nextState = {
          activeWorkspaceTabByStage: {
            ...state.activeWorkspaceTabByStage,
            [stage]: tabId,
          },
        };
        persistDockingFromState({ ...state, ...nextState });
        return nextState;
      }),

    pinTab: (stage, tabId, pinned) =>
      set((state) => {
        const tabs = state.workspaceTabsByStage[stage];
        const nextTabs = tabs.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                pinned,
                closable: pinned ? false : tab.closable,
              }
            : tab,
        );

        const nextState = {
          workspaceTabsByStage: {
            ...state.workspaceTabsByStage,
            [stage]: nextTabs,
          },
        };
        persistDockingFromState({ ...state, ...nextState });
        return nextState;
      }),

    syncTabsFromArtifacts: (stage, artifactPaths) =>
      set((state) => {
        const tabs = state.workspaceTabsByStage[stage];
        const hasSpectrum = artifactPaths.some(
          (path) =>
            path === "eigen/spectrum.json" ||
            path === "eigen/metadata/eigen_summary.json" ||
            path.startsWith("eigen/spectrum"),
        );
        const hasDispersion = artifactPaths.some(
          (path) => path === "eigen/dispersion.json" || path.startsWith("eigen/dispersion"),
        );
        const hasModes = artifactPaths.some((path) => path.startsWith("eigen/modes/"));

        const candidates: WorkspaceTabInput[] = [];
        if (hasSpectrum) {
          candidates.push({
            key: "auto:eigen:spectrum",
            kind: "result-spectrum",
            title: "Eigen Spectrum",
            closable: true,
            keepAlive: false,
            payload: { analyzeDomain: "eigenmodes", analyzeTab: "spectrum" },
          });
        }
        if (hasDispersion) {
          candidates.push({
            key: "auto:eigen:dispersion",
            kind: "result-dispersion",
            title: "Eigen Dispersion",
            closable: true,
            keepAlive: false,
            payload: { analyzeDomain: "eigenmodes", analyzeTab: "dispersion" },
          });
        }
        if (hasModes) {
          candidates.push({
            key: "auto:eigen:modes",
            kind: "result-modes",
            title: "Mode Inspector",
            closable: true,
            keepAlive: false,
            payload: { analyzeDomain: "eigenmodes", analyzeTab: "modes" },
          });
        }

        if (candidates.length === 0) {
          return state;
        }

        const nextTabs = [...tabs];
        for (const candidate of candidates) {
          if (!nextTabs.some((tab) => tab.key === candidate.key)) {
            nextTabs.push({
              id: `auto-tab:${candidate.key}`,
              key: candidate.key,
              kind: candidate.kind,
              title: candidate.title,
              closable: candidate.closable ?? true,
              pinned: candidate.pinned ?? false,
              keepAlive: candidate.keepAlive ?? false,
              payload: candidate.payload,
            });
          }
        }

        if (nextTabs.length === tabs.length) {
          return state;
        }

        const nextState = {
          workspaceTabsByStage: {
            ...state.workspaceTabsByStage,
            [stage]: nextTabs,
          },
        };
        persistDockingFromState({ ...state, ...nextState });
        return nextState;
      }),

    setDockLayout: (stage, model) =>
      set((state) => {
        const nextState = {
          dockLayoutByStage: {
            ...state.dockLayoutByStage,
            [stage]: model,
          },
        };
        persistDockingFromState({ ...state, ...nextState });
        return nextState;
      }),

    resetDockingState: () =>
      set((state) => {
        const nextState = {
          workspaceTabsByStage: cloneTabsByStage(DEFAULT_WORKSPACE_TABS),
          activeWorkspaceTabByStage: { ...DEFAULT_ACTIVE_WORKSPACE_TAB },
          dockLayoutByStage: { ...DEFAULT_DOCK_LAYOUTS },
        };
        persistDockingFromState({ ...state, ...nextState });
        return nextState;
      }),

    exportUiStateSnapshot: () => {
      const state = get();
      return {
        version: 1,
        docking: {
          workspaceTabsByStage: state.workspaceTabsByStage,
          activeWorkspaceTabByStage: state.activeWorkspaceTabByStage,
          dockLayoutByStage: state.dockLayoutByStage,
        },
        currentStage: state.currentStage,
        rightInspectorOpen: state.rightInspectorOpen,
        rightInspectorTab: state.rightInspectorTab,
      };
    },

    importUiStateSnapshot: (snapshot) => {
      if (!isPlainObject(snapshot)) {
        return false;
      }
      const dockingRaw = snapshot.docking;
      const currentStageRaw = snapshot.currentStage;
      const rightInspectorOpenRaw = snapshot.rightInspectorOpen;
      const rightInspectorTabRaw = snapshot.rightInspectorTab;
      if (!isPlainObject(dockingRaw)) {
        return false;
      }
      const persistedDockingState = parsePersistedDockingState(JSON.stringify(dockingRaw));
      if (!persistedDockingState) {
        return false;
      }
      const currentStage: WorkspaceMode =
        currentStageRaw === "build" || currentStageRaw === "study" || currentStageRaw === "analyze"
          ? currentStageRaw
          : "analyze";
      const rightInspectorOpen =
        typeof rightInspectorOpenRaw === "boolean" ? rightInspectorOpenRaw : false;
      const rightInspectorTab: RightInspectorTab =
        rightInspectorTabRaw === "selected-submeshes" ||
        rightInspectorTabRaw === "tools" ||
        rightInspectorTabRaw === "console"
          ? rightInspectorTabRaw
          : "console";

      set((state) => {
        const nextState = {
          workspaceTabsByStage: cloneTabsByStage(persistedDockingState.workspaceTabsByStage),
          activeWorkspaceTabByStage: { ...persistedDockingState.activeWorkspaceTabByStage },
          dockLayoutByStage: { ...persistedDockingState.dockLayoutByStage },
          currentStage,
          rightInspectorOpen,
          rightInspectorTab,
        };
        persistDockingFromState({ ...state, ...nextState });
        return nextState;
      });
      return true;
    },
  };
});

export function useActiveStageLayout(): StageLayoutState {
  return useWorkspaceStore((state) => state.stageLayouts[state.currentStage]);
}

export function useActiveWorkspaceTabs(): WorkspaceTab[] {
  return useWorkspaceStore((state) => state.workspaceTabsByStage[state.currentStage]);
}

export function useActiveWorkspaceTabId(): string | null {
  return useWorkspaceStore((state) => state.activeWorkspaceTabByStage[state.currentStage]);
}

export function coreTabIdForViewMode(mode: "3D" | "2D" | "Mesh" | "Analyze"): string {
  if (mode === "3D") return "core:3d";
  if (mode === "2D") return "core:2d";
  if (mode === "Mesh") return "core:mesh";
  return "core:analyze";
}

export function getDefaultDockingStorageKey(): string {
  return DOCKING_STORAGE_KEY;
}

export function getDefaultWorkspaceTabsByStage(): Record<WorkspaceMode, WorkspaceTab[]> {
  return cloneTabsByStage(DEFAULT_WORKSPACE_TABS);
}

export function getDefaultActiveWorkspaceTabByStage(): Record<WorkspaceMode, string | null> {
  return { ...DEFAULT_ACTIVE_WORKSPACE_TAB };
}

export function getKnownWorkspaceStages(): WorkspaceMode[] {
  return [...STAGES];
}
