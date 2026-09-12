/**
 * Layer A: Workspace Shell Store
 *
 * Owns ONLY:
 * - panel layout, dimensions, resizable state
 * - sidebar visibility
 * - UI-only preferences NOT tied to any domain
 * - selected diagnostic profiles for UI
 *
 * Does NOT own:
 * - active workspace stage (owned by URL/Router)
 * - run session state
 * - scene / authoring draft
 * - domain selection
 */

import { create } from "zustand";

interface StageLayoutState {
  leftDock: string | null;
  centerDock: string | null;
  rightDock: string | null;
  bottomDock: string | null;
}

type WorkspaceStage = "build" | "study";

interface WorkspaceShellState {
  /** Panel layout per stage */
  stageLayouts: Record<WorkspaceStage, StageLayoutState>;

  /** UI chrome visibility */
  rightInspectorOpen: boolean;
  settingsOpen: boolean;
  physicsDocsOpen: boolean;
  physicsDocsTopic: string | null;
  launcherVisible: boolean;

  /** Active core/contextual tabs (UI shell only) */
  activeCoreTab: string;
  activeContextualTab: string | null;

  /** Actions */
  setLeftDock: (stage: WorkspaceStage, dock: string | null) => void;
  setCenterDock: (stage: WorkspaceStage, dock: string | null) => void;
  setRightDock: (stage: WorkspaceStage, dock: string | null) => void;
  setBottomDock: (stage: WorkspaceStage, dock: string | null) => void;
  setActiveCoreTab: (tab: string) => void;
  setActiveContextualTab: (tab: string | null) => void;
  setRightInspectorOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setPhysicsDocsOpen: (open: boolean, topic?: string | null) => void;
  setLauncherVisible: (visible: boolean) => void;
}

function updateLayout(
  state: WorkspaceShellState,
  stage: WorkspaceStage,
  patch: Partial<StageLayoutState>,
): Record<WorkspaceStage, StageLayoutState> {
  return {
    ...state.stageLayouts,
    [stage]: { ...state.stageLayouts[stage], ...patch },
  };
}

export const useWorkspaceShellStore = create<WorkspaceShellState>((set) => ({
  stageLayouts: {
    build: { leftDock: "model", centerDock: "settings", rightDock: "properties", bottomDock: "messages" },
    study: { leftDock: "study-tree", centerDock: "viewport-controls", rightDock: "solver", bottomDock: "jobs" },
  },
  rightInspectorOpen: false,
  settingsOpen: false,
  physicsDocsOpen: false,
  physicsDocsTopic: null,
  launcherVisible: false,
  activeCoreTab: "Home",
  activeContextualTab: null,
  setLeftDock: (stage, dock) =>
    set((s) => ({ stageLayouts: updateLayout(s, stage, { leftDock: dock }) })),
  setCenterDock: (stage, dock) =>
    set((s) => ({ stageLayouts: updateLayout(s, stage, { centerDock: dock }) })),
  setRightDock: (stage, dock) =>
    set((s) => ({ stageLayouts: updateLayout(s, stage, { rightDock: dock }) })),
  setBottomDock: (stage, dock) =>
    set((s) => ({ stageLayouts: updateLayout(s, stage, { bottomDock: dock }) })),
  setActiveCoreTab: (activeCoreTab) =>
    set((state) => (state.activeCoreTab === activeCoreTab ? state : { activeCoreTab })),
  setActiveContextualTab: (activeContextualTab) =>
    set((state) =>
      state.activeContextualTab === activeContextualTab ? state : { activeContextualTab },
    ),
  setRightInspectorOpen: (rightInspectorOpen) => set({ rightInspectorOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setPhysicsDocsOpen: (physicsDocsOpen, topic = null) =>
    set((s) => ({ physicsDocsOpen, physicsDocsTopic: topic !== undefined ? topic : s.physicsDocsTopic })),
  setLauncherVisible: (launcherVisible) => set({ launcherVisible }),
}));

export function useStageLayout(stage: WorkspaceStage): StageLayoutState {
  return useWorkspaceShellStore((s) => s.stageLayouts[stage]);
}
