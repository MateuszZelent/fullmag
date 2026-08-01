import type { JsonObject, JsonValue } from "../api/apiTypes";
import type { CommandContext } from "../commands/commandTypes";
import {
  DEFAULT_LAYOUT,
  type BottomPanelTabId,
  type LayoutState,
  type PanelPosition,
  type RibbonTabId,
} from "../layout/layoutTypes";
import {
  restoreWorkspaceLayout,
  serializeWorkspaceLayout,
  WORKSPACE_LAYOUT_RESTORED_EVENT,
  WORKSPACE_LAYOUT_STORAGE_KEY,
} from "../layout/layoutModel";
import type { SlotId } from "../types";
import type { ModuleId } from "../types";

const CONTROL_ROOM_UI_STATE_VERSION = 1;

const RIBBON_TABS: readonly RibbonTabId[] = [
  "home",
  "view",
  "definitions",
  "geometry",
  "materials",
  "physics",
  "mesh",
  "study",
  "results",
  "automation",
];

const SLOT_IDS: readonly SlotId[] = [
  "app-menu",
  "ribbon",
  "panel-left",
  "viewport-main",
  "viewport-aux",
  "panel-right",
  "panel-bottom",
  "status-bar",
  "overlay",
];

const PANEL_POSITIONS: readonly PanelPosition[] = ["left", "right", "bottom"];

const BOTTOM_PANEL_TABS: readonly BottomPanelTabId[] = [
  "diagnostics",
  "engine",
  "logs",
  "mesh",
  "telemetry",
];

export function exportControlRoomUiState(
  context: Pick<CommandContext, "layout">,
): JsonObject {
  return {
    kernel_layout: context.layout
      ? layoutStateToJson(context.layout.get())
      : null,
    version: CONTROL_ROOM_UI_STATE_VERSION,
    workspace_layout: readWorkspaceLayoutSnapshot(),
  };
}

export function applyControlRoomUiState(
  context: Pick<CommandContext, "layout">,
  uiState: unknown,
): void {
  const state = asRecord(uiState);
  if (!state) return;

  const layoutState = readLayoutState(
    asRecord(state.kernel_layout) ?? asRecord(state.layout),
  );
  if (layoutState && context.layout) {
    context.layout.replace(layoutState);
  }

  const workspaceLayout = asRecord(state.workspace_layout);
  if (workspaceLayout) {
    writeWorkspaceLayoutSnapshot(workspaceLayout);
  }
}

function layoutStateToJson(state: LayoutState): JsonObject {
  return {
    activeBottomPanelTab: state.activeBottomPanelTab,
    activeModuleTab: state.activeModuleTab,
    activeViewportMainModuleId: state.activeViewportMainModuleId,
    focusedSlot: state.focusedSlot,
    panelVisible: {
      bottom: state.panelVisible.bottom,
      left: state.panelVisible.left,
      right: state.panelVisible.right,
    },
  };
}

function readLayoutState(record: JsonObject | null): LayoutState | null {
  if (!record) return null;

  const activeModuleTab = readRibbonTab(record.activeModuleTab);
  const activeBottomPanelTab = readBottomPanelTab(record.activeBottomPanelTab);
  const activeViewportMainModuleId =
    readModuleId(record.activeViewportMainModuleId) ??
    DEFAULT_LAYOUT.activeViewportMainModuleId;
  const panelVisible = readPanelVisible(asRecord(record.panelVisible));
  const focusedSlot = readFocusedSlot(record.focusedSlot);
  if (!activeModuleTab || !panelVisible) return null;

  return {
    activeBottomPanelTab,
    activeModuleTab,
    activeViewportMainModuleId,
    focusedSlot,
    panelVisible,
  };
}

function readBottomPanelTab(
  value: JsonValue | undefined,
): BottomPanelTabId {
  return typeof value === "string" &&
    BOTTOM_PANEL_TABS.includes(value as BottomPanelTabId)
    ? (value as BottomPanelTabId)
    : DEFAULT_LAYOUT.activeBottomPanelTab;
}

function readPanelVisible(
  record: JsonObject | null,
): LayoutState["panelVisible"] | null {
  if (!record) return null;

  const panelVisible = { ...DEFAULT_LAYOUT.panelVisible };
  for (const panel of PANEL_POSITIONS) {
    const value = record[panel];
    if (typeof value !== "boolean") return null;
    panelVisible[panel] = value;
  }
  return panelVisible;
}

function readRibbonTab(value: JsonValue | undefined): RibbonTabId | null {
  return typeof value === "string" && RIBBON_TABS.includes(value as RibbonTabId)
    ? (value as RibbonTabId)
    : null;
}

function readFocusedSlot(value: JsonValue | undefined): SlotId | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && SLOT_IDS.includes(value as SlotId)
    ? (value as SlotId)
    : null;
}

function readModuleId(value: JsonValue | undefined): ModuleId | null {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null;
}

function readWorkspaceLayoutSnapshot(): JsonObject | null {
  if (typeof window === "undefined") return null;

  try {
    const layout = restoreWorkspaceLayout(
      window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY),
    );
    return parseJsonObject(serializeWorkspaceLayout(layout));
  } catch {
    return null;
  }
}

function writeWorkspaceLayoutSnapshot(snapshot: JsonObject): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      WORKSPACE_LAYOUT_STORAGE_KEY,
      JSON.stringify(snapshot),
    );
    window.dispatchEvent(new Event(WORKSPACE_LAYOUT_RESTORED_EVENT));
  } catch {
    return;
  }
}

function parseJsonObject(value: string): JsonObject | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}
