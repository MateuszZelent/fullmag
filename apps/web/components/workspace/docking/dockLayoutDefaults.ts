import type { IJsonModel, IJsonRowNode, IJsonTabSetNode } from "flexlayout-react";

export type DockResponsivePreset = "desktop" | "tablet" | "mobile";

function leftTabset(): IJsonTabSetNode {
  return {
    type: "tabset",
    id: "dock-left-tabset",
    weight: 22,
    enableClose: false,
    children: [
      {
        type: "tab",
        id: "dock-left",
        name: "Explorer",
        component: "dock-left",
        enableClose: false,
        enableDrag: false,
      },
    ],
  };
}

function centerTopTabset(): IJsonTabSetNode {
  return {
    type: "tabset",
    id: "dock-center-tabset",
    weight: 78,
    enableClose: false,
    children: [
      {
        type: "tab",
        id: "dock-center",
        name: "Workspace",
        component: "dock-center",
        enableClose: false,
        enableDrag: false,
      },
    ],
  };
}

function rightTabset(): IJsonTabSetNode {
  return {
    type: "tabset",
    id: "dock-right-tabset",
    weight: 22,
    enableClose: false,
    children: [
      {
        type: "tab",
        id: "dock-right",
        name: "Inspector",
        component: "dock-right",
        enableClose: false,
        enableDrag: false,
      },
    ],
  };
}

function bottomTabset(): IJsonTabSetNode {
  return {
    type: "tabset",
    id: "dock-bottom-tabset",
    weight: 22,
    enableClose: false,
    children: [
      {
        type: "tab",
        id: "dock-bottom",
        name: "Telemetry",
        component: "dock-bottom",
        enableClose: false,
        enableDrag: false,
      },
    ],
  };
}

function desktopLayout(): IJsonModel {
  return {
    global: {
      splitterSize: 6,
      splitterEnableHandle: true,
      tabEnableClose: true,
      tabEnableRenderOnDemand: true,
      tabSetEnableClose: false,
      tabSetEnableTabStrip: true,
      tabSetEnableDrag: true,
      tabSetMinWidth: 220,
      tabSetMinHeight: 150,
      enableEdgeDock: true,
    },
    borders: [],
    layout: {
      type: "row",
      id: "dock-root-row",
      children: [
        leftTabset(),
        {
          type: "row",
          id: "dock-main-column",
          weight: 56,
          children: [centerTopTabset(), bottomTabset()],
        },
        rightTabset(),
      ],
    } as IJsonRowNode,
  };
}

function tabletLayout(): IJsonModel {
  return {
    global: {
      splitterSize: 6,
      splitterEnableHandle: true,
      tabEnableClose: true,
      tabEnableRenderOnDemand: true,
      tabSetEnableClose: false,
      tabSetEnableTabStrip: true,
      tabSetEnableDrag: true,
      tabSetMinWidth: 200,
      tabSetMinHeight: 140,
      enableEdgeDock: true,
      borderAutoSelectTabWhenOpen: true,
      borderEnableDrop: true,
      borderEnableAutoHide: false,
      borderSize: 300,
    },
    borders: [
      {
        type: "border",
        location: "right",
        size: 320,
        children: [
          {
            type: "tab",
            id: "dock-right",
            name: "Inspector",
            component: "dock-right",
            enableClose: false,
            enableDrag: false,
          },
        ],
      },
      {
        type: "border",
        location: "bottom",
        size: 280,
        children: [
          {
            type: "tab",
            id: "dock-bottom",
            name: "Telemetry",
            component: "dock-bottom",
            enableClose: false,
            enableDrag: false,
          },
        ],
      },
    ],
    layout: {
      type: "row",
      id: "dock-root-row",
      children: [leftTabset(), centerTopTabset()],
    } as IJsonRowNode,
  };
}

function mobileLayout(): IJsonModel {
  return {
    global: {
      splitterSize: 5,
      splitterEnableHandle: true,
      tabEnableClose: true,
      tabEnableRenderOnDemand: true,
      tabSetEnableClose: false,
      tabSetEnableTabStrip: true,
      tabSetEnableDrag: true,
      tabSetMinWidth: 180,
      tabSetMinHeight: 130,
      enableEdgeDock: true,
      borderAutoSelectTabWhenOpen: true,
      borderEnableDrop: true,
      borderEnableAutoHide: false,
      borderSize: 250,
    },
    borders: [
      {
        type: "border",
        location: "left",
        size: 260,
        children: [
          {
            type: "tab",
            id: "dock-left",
            name: "Explorer",
            component: "dock-left",
            enableClose: false,
            enableDrag: false,
          },
        ],
      },
      {
        type: "border",
        location: "right",
        size: 280,
        children: [
          {
            type: "tab",
            id: "dock-right",
            name: "Inspector",
            component: "dock-right",
            enableClose: false,
            enableDrag: false,
          },
        ],
      },
      {
        type: "border",
        location: "bottom",
        size: 260,
        children: [
          {
            type: "tab",
            id: "dock-bottom",
            name: "Telemetry",
            component: "dock-bottom",
            enableClose: false,
            enableDrag: false,
          },
        ],
      },
    ],
    layout: {
      type: "row",
      id: "dock-root-row",
      children: [centerTopTabset()],
    } as IJsonRowNode,
  };
}

export function resolveDockResponsivePreset(width: number): DockResponsivePreset {
  if (width < 900) return "mobile";
  if (width < 1360) return "tablet";
  return "desktop";
}

export function createDefaultDockLayout(preset: DockResponsivePreset): IJsonModel {
  if (preset === "mobile") return mobileLayout();
  if (preset === "tablet") return tabletLayout();
  return desktopLayout();
}
