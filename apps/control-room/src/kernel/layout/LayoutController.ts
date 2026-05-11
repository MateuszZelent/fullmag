import type { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import type { SlotId } from "../types";

import {
  DEFAULT_LAYOUT,
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

  setActiveTab(tabId: RibbonTabId): void {
    if (this.state.activeModuleTab === tabId) return;
    this.state = { ...this.state, activeModuleTab: tabId };
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
