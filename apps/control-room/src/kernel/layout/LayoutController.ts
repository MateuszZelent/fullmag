import type { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import type { ModuleId, SlotId } from "../types";

import {
  DEFAULT_LAYOUT,
  type BottomPanelTabId,
  type LayoutState,
  type PanelPosition,
  type RibbonTabId,
} from "./layoutTypes";

type LayoutListener = (state: LayoutState) => void;

/**
 * Kernel-owned layout state.
 * Controls active ribbon tab, panel visibility, and slot focus.
 * All mutations emit events on the bus and notify direct subscribers.
 */
export class LayoutController {
  private state: LayoutState = { ...DEFAULT_LAYOUT, panelVisible: { ...DEFAULT_LAYOUT.panelVisible } };
  private readonly listeners = new Set<LayoutListener>();

  constructor(private readonly bus: EventBus<KernelEventMap>) {}

  get(): LayoutState {
    return this.state;
  }

  replace(nextState: LayoutState): void {
    const next: LayoutState = {
      activeBottomPanelTab:
        nextState.activeBottomPanelTab ?? DEFAULT_LAYOUT.activeBottomPanelTab,
      activeModuleTab: nextState.activeModuleTab,
      activeViewportMainModuleId: nextState.activeViewportMainModuleId,
      lastSpatialViewportMainModuleId:
        spatialViewportModule(nextState.activeViewportMainModuleId) ??
        nextState.lastSpatialViewportMainModuleId ??
        this.state.lastSpatialViewportMainModuleId ??
        "viewport-3d",
      focusedSlot: nextState.focusedSlot,
      panelVisible: { ...nextState.panelVisible },
    };
    const layoutChanged =
      this.state.activeBottomPanelTab !== next.activeBottomPanelTab ||
      this.state.activeModuleTab !== next.activeModuleTab ||
      this.state.activeViewportMainModuleId !== next.activeViewportMainModuleId ||
      this.state.lastSpatialViewportMainModuleId !==
        next.lastSpatialViewportMainModuleId ||
      this.state.panelVisible.left !== next.panelVisible.left ||
      this.state.panelVisible.right !== next.panelVisible.right ||
      this.state.panelVisible.bottom !== next.panelVisible.bottom;
    const focusChanged = this.state.focusedSlot !== next.focusedSlot;
    if (!layoutChanged && !focusChanged) return;

    this.state = next;
    if (layoutChanged) this.notify("workspace:layout-changed");
    if (focusChanged) this.notify("workspace:focus-changed");
  }

  setActiveTab(tabId: RibbonTabId): void {
    if (this.state.activeModuleTab === tabId) return;
    this.state = { ...this.state, activeModuleTab: tabId };
    this.notify("workspace:layout-changed");
  }

  setBottomPanelTab(tabId: BottomPanelTabId): void {
    if (this.state.activeBottomPanelTab === tabId) return;
    this.state = { ...this.state, activeBottomPanelTab: tabId };
    this.notify("workspace:layout-changed");
  }

  openBottomPanel(tabId: BottomPanelTabId): void {
    const layoutChanged =
      !this.state.panelVisible.bottom ||
      this.state.activeBottomPanelTab !== tabId;
    const focusChanged = this.state.focusedSlot !== "panel-bottom";
    if (!layoutChanged && !focusChanged) return;

    this.state = {
      ...this.state,
      activeBottomPanelTab: tabId,
      focusedSlot: "panel-bottom",
      panelVisible: this.state.panelVisible.bottom
        ? this.state.panelVisible
        : { ...this.state.panelVisible, bottom: true },
    };
    if (layoutChanged) this.notify("workspace:layout-changed");
    if (focusChanged) this.notify("workspace:focus-changed");
  }

  setActiveViewportMainModule(moduleId: ModuleId): void {
    if (this.state.activeViewportMainModuleId === moduleId) return;
    this.state = {
      ...this.state,
      activeViewportMainModuleId: moduleId,
      lastSpatialViewportMainModuleId:
        spatialViewportModule(moduleId) ??
        this.state.lastSpatialViewportMainModuleId ??
        "viewport-3d",
    };
    this.notify("workspace:layout-changed");
  }

  togglePanel(panel: PanelPosition): void {
    const panelVisible = {
      ...this.state.panelVisible,
      [panel]: !this.state.panelVisible[panel],
    };
    this.state = { ...this.state, panelVisible };
    this.notify("workspace:layout-changed");
  }

  setPanelVisible(panel: PanelPosition, visible: boolean): void {
    if (this.state.panelVisible[panel] === visible) return;
    const panelVisible = { ...this.state.panelVisible, [panel]: visible };
    this.state = { ...this.state, panelVisible };
    this.notify("workspace:layout-changed");
  }

  setFocusedSlot(slotId: SlotId | null): void {
    if (this.state.focusedSlot === slotId) return;
    this.state = { ...this.state, focusedSlot: slotId };
    this.notify("workspace:focus-changed");
  }

  subscribe(listener: LayoutListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(event: "workspace:layout-changed" | "workspace:focus-changed"): void {
    this.bus.emit(event, { state: this.state });

    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

function spatialViewportModule(
  moduleId: ModuleId,
): "field-map" | "viewport-3d" | null {
  if (moduleId === "field-map" || moduleId === "viewport-3d") return moduleId;
  return null;
}
