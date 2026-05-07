import { create } from "zustand";
import type { DockResponsivePreset } from "@/components/workspace/docking/dockLayoutDefaults";
import {
  type DockLayoutByPreset,
  type DockLayoutModel,
  createDefaultDockLayoutByPreset,
  buildDockLayoutEnvelopeForModel,
  parseDockLayoutByPreset,
} from "./dockLayoutContract";
import type { LaunchIntent } from "./launch-intent";
import { resolveWorkspaceTabMountPolicy } from "./workspace-tab-policy";

export type WorkspaceStage = "build" | "study";
export type WorkspaceMode = WorkspaceStage;
export type RightInspectorTab = "properties" | "selected-submeshes" | "tools" | "console";
export type WorkspaceTabMountPolicy = "active-only" | "hidden-mounted";
type LegacyWorkspaceTabLifecycle = "unmount-on-hide" | "warm";

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
  mountPolicy: WorkspaceTabMountPolicy;
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
  mountPolicy?: WorkspaceTabMountPolicy;
  /** @deprecated Migration-only input. Use mountPolicy instead. */
  keepAlive?: boolean;
  /** @deprecated Migration-only input. Use mountPolicy instead. */
  lifecycle?: LegacyWorkspaceTabLifecycle;
  payload?: WorkspaceTab["payload"];
}

type WorkspaceTabNormalizerInput = WorkspaceTabInput & {
  id: string;
  mountPolicy?: WorkspaceTabMountPolicy;
  keepAlive?: boolean;
  lifecycle?: LegacyWorkspaceTabLifecycle;
};

interface StageLayoutState {
  leftDock: string | null;
  centerDock: string | null;
  rightDock: string | null;
  bottomDock: string | null;
}

const STAGES: WorkspaceMode[] = ["build", "study"];
const DOCKING_STORAGE_KEY = "fullmag.workspace.docking.v4";

function defaultCoreTabs(): WorkspaceTab[] {
  return [
    {
      id: "core:3d",
      key: "core:3d",
      kind: "viewport-3d",
      title: "3D Viewport",
      closable: false,
      pinned: true,
      mountPolicy: "active-only",
      payload: { viewMode: "3D" },
    },
    {
      id: "core:2d",
      key: "core:2d",
      kind: "viewport-2d",
      title: "2D Slice 3",
      closable: false,
      pinned: true,
      mountPolicy: "active-only",
      payload: { viewMode: "2D" },
    },
    {
      id: "core:analyze",
      key: "core:analyze",
      kind: "analyze",
      title: "Analyze",
      closable: false,
      pinned: true,
      mountPolicy: "active-only",
      payload: { viewMode: "Analyze", analyzeDomain: "eigenmodes", analyzeTab: "spectrum" },
    },
    {
      id: "core:charts",
      key: "core:charts",
      kind: "viewport-charts",
      title: "2D Plots",
      closable: false,
      pinned: true,
      mountPolicy: "active-only",
      payload: {},
    },
  ];
}

function cloneTabsByStage(input: Record<WorkspaceMode, WorkspaceTab[]>): Record<WorkspaceMode, WorkspaceTab[]> {
  return {
    build: input.build.map((tab) => ({ ...tab, payload: tab.payload ? { ...tab.payload } : undefined })),
    study: input.study.map((tab) => ({ ...tab, payload: tab.payload ? { ...tab.payload } : undefined })),
  };
}

export function normalizeWorkspaceTab(tab: WorkspaceTabNormalizerInput): WorkspaceTab {
  const requestedMountPolicy: WorkspaceTabMountPolicy =
    tab.mountPolicy ?? (tab.lifecycle === "warm" || tab.keepAlive ? "hidden-mounted" : "active-only");
  const mountPolicy = resolveWorkspaceTabMountPolicy({
    kind: tab.kind,
    requestedMountPolicy,
  });
  return {
    id: tab.id,
    key: tab.key,
    kind: tab.kind,
    title: tab.title,
    closable: tab.closable ?? true,
    pinned: tab.pinned ?? false,
    mountPolicy,
    payload: tab.payload ? { ...tab.payload } : undefined,
  };
}

function isDeprecatedWorkspaceTab(tab: WorkspaceTab): boolean {
  return tab.id === "core:mesh" || tab.key === "core:mesh" || tab.kind === "viewport-mesh";
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
};

const DEFAULT_WORKSPACE_TABS: Record<WorkspaceMode, WorkspaceTab[]> = {
  build: defaultCoreTabs(),
  study: defaultCoreTabs(),
};

const DEFAULT_ACTIVE_WORKSPACE_TAB: Record<WorkspaceMode, string | null> = {
  build: "core:3d",
  study: "core:3d",
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const DEFAULT_DOCK_LAYOUT_BY_PRESET: DockLayoutByPreset = createDefaultDockLayoutByPreset();

function cloneDockLayoutByPreset(value: DockLayoutByPreset): DockLayoutByPreset {
  return cloneJson(value);
}

function cloneDockingStateByPresetMapByStage(
  value: Record<WorkspaceMode, DockLayoutByPreset>,
): Record<WorkspaceMode, DockLayoutByPreset> {
  return {
    build: cloneDockLayoutByPreset(value.build),
    study: cloneDockLayoutByPreset(value.study),
  };
}

interface PersistedDockingState {
  workspaceTabsByStage: Record<WorkspaceMode, WorkspaceTab[]>;
  activeWorkspaceTabByStage: Record<WorkspaceMode, string | null>;
  dockLayoutByStage: Record<WorkspaceMode, DockLayoutByPreset>;
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

    const buildTabs = Array.isArray(tabs.build) ? (tabs.build as WorkspaceTab[]) : defaultCoreTabs();
    const studyTabs = Array.isArray(tabs.study) ? (tabs.study as WorkspaceTab[]) : defaultCoreTabs();
    const legacyAnalyzeTabs = Array.isArray(tabs.analyze) ? (tabs.analyze as WorkspaceTab[]) : [];
    const studyTabsById = new Map(studyTabs.map((tab) => [tab.id, tab]));
    for (const tab of legacyAnalyzeTabs) {
      if (!studyTabsById.has(tab.id)) {
        studyTabsById.set(tab.id, tab);
      }
    }

    const workspaceTabsByStage: Record<WorkspaceMode, WorkspaceTab[]> = {
      build: buildTabs,
      study: Array.from(studyTabsById.values()),
    };

    const activeWorkspaceTabByStage: Record<WorkspaceMode, string | null> = {
      build:
        active.build === "core:mesh"
          ? "core:3d"
          : typeof active.build === "string"
            ? (active.build as string)
            : DEFAULT_ACTIVE_WORKSPACE_TAB.build,
      study:
        active.study === "core:mesh" || active.analyze === "core:mesh"
          ? "core:3d"
          : typeof active.study === "string"
            ? (active.study as string)
            : typeof active.analyze === "string"
              ? (active.analyze as string)
              : DEFAULT_ACTIVE_WORKSPACE_TAB.study,
    };

    const dockLayoutByStage: Record<WorkspaceMode, DockLayoutByPreset> = {
      build: parseDockLayoutByPreset(dock.build),
      study: parseDockLayoutByPreset(dock.study),
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

let pendingDockingPersist: number | null = null;

function persistDockingFromState(state: WorkspaceStoreState): void {
  if (typeof window === "undefined") {
    return;
  }

  if (pendingDockingPersist != null) {
    window.clearTimeout(pendingDockingPersist);
  }

  pendingDockingPersist = window.setTimeout(() => {
    pendingDockingPersist = null;
    persistDockingState({
      workspaceTabsByStage: state.workspaceTabsByStage,
      activeWorkspaceTabByStage: state.activeWorkspaceTabByStage,
      dockLayoutByStage: state.dockLayoutByStage,
    });
  }, 160);
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
  dockLayoutByStage: Record<WorkspaceMode, DockLayoutByPreset>;

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
  setDockLayout: (
    stage: WorkspaceMode,
    preset: DockResponsivePreset,
    model: DockLayoutModel | null,
  ) => void;
  setDockLayoutToDefaultTemplate: (stage: WorkspaceMode, preset: DockResponsivePreset) => void;
  clearDockingLayoutStorage: () => void;
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
  const incoming = Array.isArray(tabs)
    ? tabs.filter((tab) => !isDeprecatedWorkspaceTab(tab))
    : [];
  const coreTabs = defaultCoreTabs();
  const incomingById = new Map(incoming.map((tab) => [tab.id, normalizeWorkspaceTab(tab)]));
  const merged: WorkspaceTab[] = coreTabs.map((core) => {
    const persisted = incomingById.get(core.id);
    if (!persisted) {
      return normalizeWorkspaceTab(core);
    }
    return normalizeWorkspaceTab({
      ...persisted,
      kind: core.kind,
      title: core.title,
      closable: core.closable,
      pinned: core.pinned,
      mountPolicy: core.mountPolicy,
      payload: core.payload,
    });
  });
  const extra = incoming
    .filter((tab) => !coreTabs.some((core) => core.id === tab.id))
    .map((tab) => normalizeWorkspaceTab(tab));
  return [...merged, ...extra];
}

function mergedDockingStateFromDefaults(): PersistedDockingState {
  const persistedTabs = persistedDockingState?.workspaceTabsByStage;
  const workspaceTabsByStage: Record<WorkspaceMode, WorkspaceTab[]> = {
    build: ensureCoreTabsForStage(persistedTabs?.build ?? DEFAULT_WORKSPACE_TABS.build),
    study: ensureCoreTabsForStage(persistedTabs?.study ?? DEFAULT_WORKSPACE_TABS.study),
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
  };
  return {
    workspaceTabsByStage,
    activeWorkspaceTabByStage,
    dockLayoutByStage: {
      build: parseDockLayoutByPreset(persistedDockingState?.dockLayoutByStage.build),
      study: parseDockLayoutByPreset(persistedDockingState?.dockLayoutByStage.study),
    },
  };
}

export const useWorkspaceStore = create<WorkspaceStoreState>((set, get) => {
  const dockingState = mergedDockingStateFromDefaults();

  return {
    currentStage: "study",
    activeCoreTab: "Home",
    activeContextualTab: null,
    stageLayouts: DEFAULT_STAGE_LAYOUTS,
    selectionId: null,
    activeProjectId: null,
    launcherVisible: false,
    launchIntent: null,
    rightInspectorOpen: true,
    rightInspectorTab: "properties",
    settingsOpen: false,
    physicsDocsOpen: false,
    physicsDocsTopic: null,

    workspaceTabsByStage: dockingState.workspaceTabsByStage,
    activeWorkspaceTabByStage: dockingState.activeWorkspaceTabByStage,
    dockLayoutByStage: dockingState.dockLayoutByStage,

    setCurrentStage: (currentStage) =>
      set((state) => {
        return state.currentStage === currentStage ? state : { currentStage };
      }),
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
    setSelectionId: (selectionId) =>
      set((state) => (Object.is(state.selectionId, selectionId) ? state : { selectionId })),
    setActiveProjectId: (activeProjectId) =>
      set((state) => (Object.is(state.activeProjectId, activeProjectId) ? state : { activeProjectId })),
    setLauncherVisible: (launcherVisible) =>
      set((state) => (Object.is(state.launcherVisible, launcherVisible) ? state : { launcherVisible })),
    setLaunchIntent: (launchIntent) =>
      set((state) => (Object.is(state.launchIntent, launchIntent) ? state : { launchIntent })),
    setRightInspectorOpen: (rightInspectorOpen) =>
      set((state) => (Object.is(state.rightInspectorOpen, rightInspectorOpen) ? state : { rightInspectorOpen })),
    setRightInspectorTab: (rightInspectorTab) =>
      set((state) => (Object.is(state.rightInspectorTab, rightInspectorTab) ? state : { rightInspectorTab })),
    setSettingsOpen: (settingsOpen) =>
      set((state) => (Object.is(state.settingsOpen, settingsOpen) ? state : { settingsOpen })),
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
          if (state.activeWorkspaceTabByStage[stage] === existing.id) {
            return state;
          }
          const nextState = {
            activeWorkspaceTabByStage: {
              ...state.activeWorkspaceTabByStage,
              [stage]: existing.id,
            },
          };
          persistDockingFromState({ ...state, ...nextState });
          return nextState;
        }

        const created: WorkspaceTab = normalizeWorkspaceTab({
          id: activeId,
          key: tabInput.key,
          kind: tabInput.kind,
          title: tabInput.title,
          closable: tabInput.closable ?? true,
          pinned: tabInput.pinned ?? false,
          mountPolicy: tabInput.mountPolicy,
          keepAlive: tabInput.keepAlive,
          lifecycle: tabInput.lifecycle,
          payload: tabInput.payload,
        });

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
        if (state.activeWorkspaceTabByStage[stage] === tabId) {
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
            payload: { analyzeDomain: "eigenmodes", analyzeTab: "spectrum" },
          });
        }
        if (hasDispersion) {
          candidates.push({
            key: "auto:eigen:dispersion",
            kind: "result-dispersion",
            title: "Eigen Dispersion",
            closable: true,
            payload: { analyzeDomain: "eigenmodes", analyzeTab: "dispersion" },
          });
        }
        if (hasModes) {
          candidates.push({
            key: "auto:eigen:modes",
            kind: "result-modes",
            title: "Mode Inspector",
            closable: true,
            payload: { analyzeDomain: "eigenmodes", analyzeTab: "modes" },
          });
        }

        if (candidates.length === 0) {
          return state;
        }

        const nextTabs = [...tabs];
        for (const candidate of candidates) {
          if (!nextTabs.some((tab) => tab.key === candidate.key)) {
            nextTabs.push(normalizeWorkspaceTab({
              id: `auto-tab:${candidate.key}`,
              key: candidate.key,
              kind: candidate.kind,
              title: candidate.title,
              closable: candidate.closable ?? true,
              pinned: candidate.pinned ?? false,
              mountPolicy: candidate.mountPolicy,
              keepAlive: candidate.keepAlive,
              lifecycle: candidate.lifecycle,
              payload: candidate.payload,
            }));
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

    setDockLayout: (stage, preset, model) =>
      set((state) => {
        const envelope = buildDockLayoutEnvelopeForModel(model, preset);
        const currentEnvelope = state.dockLayoutByStage[stage][preset];
        if (currentEnvelope) {
          const currentSerialized = JSON.stringify(currentEnvelope.model);
          const nextSerialized = JSON.stringify(envelope.model);
          if (
            currentSerialized === nextSerialized &&
            currentEnvelope.templateId === envelope.templateId &&
            currentEnvelope.dockingLayoutSchemaVersion === envelope.dockingLayoutSchemaVersion
          ) {
            return state;
          }
        }
        const nextState = {
          dockLayoutByStage: {
            ...state.dockLayoutByStage,
            [stage]: {
              ...state.dockLayoutByStage[stage],
              [preset]: envelope,
            },
          },
        };
        persistDockingFromState({ ...state, ...nextState });
        return nextState;
      }),

    setDockLayoutToDefaultTemplate: (stage, preset) =>
      set((state) => {
        const nextState = {
          dockLayoutByStage: {
            ...state.dockLayoutByStage,
            [stage]: {
              ...state.dockLayoutByStage[stage],
              [preset]: cloneDockLayoutByPreset(DEFAULT_DOCK_LAYOUT_BY_PRESET)[preset],
            },
          },
        };
        persistDockingFromState({ ...state, ...nextState });
        return nextState;
      }),

    clearDockingLayoutStorage: () => {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(DOCKING_STORAGE_KEY);
      }
      set((state) => {
        const nextState = {
          dockLayoutByStage: {
            build: cloneDockLayoutByPreset(DEFAULT_DOCK_LAYOUT_BY_PRESET),
            study: cloneDockLayoutByPreset(DEFAULT_DOCK_LAYOUT_BY_PRESET),
          },
        };
        persistDockingFromState({ ...state, ...nextState });
        return nextState;
      });
    },

    resetDockingState: () =>
      set((state) => {
        const nextState = {
          workspaceTabsByStage: cloneTabsByStage(DEFAULT_WORKSPACE_TABS),
          activeWorkspaceTabByStage: { ...DEFAULT_ACTIVE_WORKSPACE_TAB },
          dockLayoutByStage: {
            build: cloneDockLayoutByPreset(DEFAULT_DOCK_LAYOUT_BY_PRESET),
            study: cloneDockLayoutByPreset(DEFAULT_DOCK_LAYOUT_BY_PRESET),
          },
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
        currentStageRaw === "build" || currentStageRaw === "study"
          ? currentStageRaw
          : "study";
      const rightInspectorOpen =
        typeof rightInspectorOpenRaw === "boolean" ? rightInspectorOpenRaw : true;
      const rightInspectorTab: RightInspectorTab =
        rightInspectorTabRaw === "properties" ||
        rightInspectorTabRaw === "selected-submeshes" ||
        rightInspectorTabRaw === "tools" ||
        rightInspectorTabRaw === "console"
          ? rightInspectorTabRaw
          : "properties";

      set((state) => {
        const nextState = {
          dockLayoutByStage: cloneDockingStateByPresetMapByStage(persistedDockingState.dockLayoutByStage),
          workspaceTabsByStage: {
            build: ensureCoreTabsForStage(persistedDockingState.workspaceTabsByStage.build),
            study: ensureCoreTabsForStage(persistedDockingState.workspaceTabsByStage.study),
          },
          activeWorkspaceTabByStage: { ...persistedDockingState.activeWorkspaceTabByStage },
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
  if (mode === "Mesh") return "core:3d";
  return "core:analyze";
}

export function getDefaultDockingStorageKey(): string {
  return DOCKING_STORAGE_KEY;
}

export function getDefaultWorkspaceTabsByStage(): Record<WorkspaceMode, WorkspaceTab[]> {
  return cloneTabsByStage(DEFAULT_WORKSPACE_TABS);
}

export function getDefaultDockingLayoutByPreset(): Record<WorkspaceMode, DockLayoutByPreset> {
  return {
    build: cloneDockLayoutByPreset(DEFAULT_DOCK_LAYOUT_BY_PRESET),
    study: cloneDockLayoutByPreset(DEFAULT_DOCK_LAYOUT_BY_PRESET),
  };
}

export function getDefaultActiveWorkspaceTabByStage(): Record<WorkspaceMode, string | null> {
  return { ...DEFAULT_ACTIVE_WORKSPACE_TAB };
}

export function getKnownWorkspaceStages(): WorkspaceMode[] {
  return [...STAGES];
}
