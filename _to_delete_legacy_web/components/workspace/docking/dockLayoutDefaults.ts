import type {
  IJsonModel,
  IJsonBorderNode,
  IJsonRowNode,
  IJsonTabSetNode,
} from "flexlayout-react";

export type DockResponsivePreset = "desktop" | "tablet" | "mobile";

export type DockLayoutTemplateId =
  | "default-desktop"
  | "default-tablet"
  | "default-mobile"
  | "analysis-heavy"
  | "inspector-focus"
  | "compact-inspector";

export type DockPanelComponent = "dock-left" | "dock-center" | "dock-right" | "dock-bottom";

export const REQUIRED_DOCK_PANEL_COMPONENTS: DockPanelComponent[] = [
  "dock-left",
  "dock-center",
  "dock-right",
  "dock-bottom",
];

export const DOCKING_MIN_WIDTH_LEFT = 220;
export const DOCKING_MIN_WIDTH_RIGHT = 220;
export const DOCKING_MIN_WIDTH_CENTER = 360;
export const DOCKING_MIN_HEIGHT_BOTTOM_DESKTOP = 84;
export const DOCKING_MIN_HEIGHT_BOTTOM_TABLET = 84;
export const DOCKING_MIN_HEIGHT_BOTTOM_MOBILE = 76;
export const DOCKING_DEFAULT_HEIGHT_BOTTOM_TABLET = 104;
export const DOCKING_DEFAULT_HEIGHT_BOTTOM_MOBILE = 96;
export const DOCKING_DEFAULT_WEIGHT_BOTTOM_DESKTOP = 10;

export function resolveBottomDockMinHeight(
  preset: DockResponsivePreset,
): number {
  switch (preset) {
    case "mobile":
      return DOCKING_MIN_HEIGHT_BOTTOM_MOBILE;
    case "tablet":
      return DOCKING_MIN_HEIGHT_BOTTOM_TABLET;
    default:
      return DOCKING_MIN_HEIGHT_BOTTOM_DESKTOP;
  }
}

export function resolveBottomDockDefaultBorderSize(
  preset: DockResponsivePreset,
): number {
  switch (preset) {
    case "mobile":
      return DOCKING_DEFAULT_HEIGHT_BOTTOM_MOBILE;
    case "tablet":
      return DOCKING_DEFAULT_HEIGHT_BOTTOM_TABLET;
    default:
      return DOCKING_DEFAULT_HEIGHT_BOTTOM_TABLET;
  }
}

export function resolveBottomDockDefaultWeight(
  preset: DockResponsivePreset,
): number {
  void preset;
  return DOCKING_DEFAULT_WEIGHT_BOTTOM_DESKTOP;
}

export interface DockPanelDefaults {
  component: DockPanelComponent;
  label: string;
  preferredWidthPx?: number;
  preferredHeightPx?: number;
}

export interface DockLayoutTemplate {
  id: DockLayoutTemplateId;
  label: string;
  description: string;
  preset: DockResponsivePreset;
  model: IJsonModel;
  panels: Record<DockPanelComponent, DockPanelDefaults>;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createTabsetNode(params: {
  id: string;
  title: string;
  component: DockPanelComponent;
  weight?: number;
  minWidth?: number;
  minHeight?: number;
}): IJsonTabSetNode {
  return {
    type: "tabset",
    id: params.id,
    weight: params.weight,
    minWidth: params.minWidth,
    minHeight: params.minHeight,
    enableClose: false,
    enableDrag: false,
    children: [
      {
        type: "tab",
        id: params.component,
        name: params.title,
        component: params.component,
        enableClose: false,
        enableDrag: false,
      },
    ],
  };
}

function createBottomPanelTabBorder(
  size: number,
  minSize: number,
  component: DockPanelComponent,
  id: string,
): IJsonBorderNode {
  return {
    type: "border",
    location: "bottom",
    size,
    minSize,
    children: [
      {
        type: "tab",
        id,
        name: "Telemetry",
        component,
        enableClose: false,
        enableDrag: false,
      },
    ],
  };
}

function createRightPanelTabBorder(size: number, component: DockPanelComponent, id: string): IJsonBorderNode {
  return {
    type: "border",
    location: "right",
    size,
    children: [
      {
        type: "tab",
        id,
        name: "Inspector",
        component,
        enableClose: false,
        enableDrag: false,
      },
    ],
  };
}

function createLeftPanelTabBorder(size: number, component: DockPanelComponent, id: string): IJsonBorderNode {
  return {
    type: "border",
    location: "left",
    size,
    children: [
      {
        type: "tab",
        id,
        name: "Explorer",
        component,
        enableClose: false,
        enableDrag: false,
      },
    ],
  };
}

function makeDesktopRootLayout(params: {
  leftWeight: number;
  centerColumnWeight: number;
  rightWeight: number;
  centerWeight: number;
  bottomWeight: number;
  rightBottomInBorder: boolean;
}): IJsonModel {
  const left = createTabsetNode({
    id: "dock-left-tabset",
    title: "Explorer",
    component: "dock-left",
    weight: params.leftWeight,
    minWidth: DOCKING_MIN_WIDTH_LEFT,
  });

  const center = createTabsetNode({
    id: "dock-center-tabset",
    title: "Workspace",
    component: "dock-center",
    weight: params.centerWeight,
    minWidth: DOCKING_MIN_WIDTH_CENTER,
  });

  const bottom = createTabsetNode({
    id: "dock-bottom-tabset",
    title: "Telemetry",
    component: "dock-bottom",
    minHeight: resolveBottomDockMinHeight("desktop"),
    weight: params.bottomWeight,
  });

  const right = createTabsetNode({
    id: "dock-right-tabset",
    title: "Inspector",
    component: "dock-right",
    weight: params.rightWeight,
    minWidth: DOCKING_MIN_WIDTH_RIGHT,
  });

  const layoutChildren: Array<IJsonRowNode | IJsonTabSetNode> = params.rightBottomInBorder
    ? [left, { type: "row", id: "dock-main-column", weight: params.centerColumnWeight, children: [center, bottom] }]
    : [left, { type: "row", id: "dock-main-column", weight: params.centerColumnWeight, children: [center, bottom] }, right];

  const mainRow: IJsonRowNode = {
    type: "row",
    id: "dock-root-row",
    children: layoutChildren,
  };

  return {
    global: {
      splitterSize: 6,
      splitterEnableHandle: true,
      tabEnableClose: true,
      tabEnableRenderOnDemand: false,
      tabSetEnableClose: false,
      tabSetEnableTabStrip: true,
      tabSetEnableDrag: true,
      tabSetEnableMaximize: false,
      tabSetMinWidth: 220,
      tabSetMinHeight: 140,
      enableEdgeDock: true,
      borderAutoSelectTabWhenOpen: true,
      borderEnableDrop: true,
      borderEnableAutoHide: false,
    },
    borders: params.rightBottomInBorder
      ? [
          createRightPanelTabBorder(360, "dock-right", "dock-right"),
          createBottomPanelTabBorder(
            resolveBottomDockDefaultBorderSize("desktop"),
            resolveBottomDockMinHeight("desktop"),
            "dock-bottom",
            "dock-bottom",
          ),
        ]
      : [],
    layout: mainRow,
  };
}

function makeTabletLayout(): IJsonModel {
  const center = createTabsetNode({
    id: "dock-center-tabset",
    title: "Workspace",
    component: "dock-center",
    minWidth: DOCKING_MIN_WIDTH_CENTER,
    minHeight: 140,
    weight: 100,
  });

  const left = createTabsetNode({
    id: "dock-left-tabset",
    title: "Explorer",
    component: "dock-left",
    minWidth: DOCKING_MIN_WIDTH_LEFT,
    weight: 18,
  });

  return {
    global: {
      splitterSize: 6,
      splitterEnableHandle: true,
      tabEnableClose: true,
      tabEnableRenderOnDemand: false,
      tabSetEnableClose: false,
      tabSetEnableTabStrip: true,
      tabSetEnableDrag: true,
      tabSetMinWidth: 180,
      tabSetMinHeight: 140,
      enableEdgeDock: true,
      borderAutoSelectTabWhenOpen: true,
      borderEnableDrop: true,
      borderEnableAutoHide: false,
      borderSize: 320,
    },
    borders: [
      createRightPanelTabBorder(360, "dock-right", "dock-right"),
      createBottomPanelTabBorder(
        resolveBottomDockDefaultBorderSize("tablet"),
        resolveBottomDockMinHeight("tablet"),
        "dock-bottom",
        "dock-bottom",
      ),
    ],
    layout: {
      type: "row",
      id: "dock-root-row",
      children: [left, center],
    } as IJsonRowNode,
  };
}

function makeMobileLayout(): IJsonModel {
  const center = createTabsetNode({
    id: "dock-center-tabset",
    title: "Workspace",
    component: "dock-center",
    minWidth: DOCKING_MIN_WIDTH_CENTER,
    minHeight: 140,
    weight: 100,
  });

  return {
    global: {
      splitterSize: 5,
      splitterEnableHandle: true,
      tabEnableClose: true,
      tabEnableRenderOnDemand: false,
      tabSetEnableClose: false,
      tabSetEnableTabStrip: true,
      tabSetEnableDrag: true,
      tabSetMinWidth: 160,
      tabSetMinHeight: 130,
      enableEdgeDock: true,
      borderAutoSelectTabWhenOpen: true,
      borderEnableDrop: true,
      borderEnableAutoHide: false,
      borderSize: 250,
    },
    borders: [
      createLeftPanelTabBorder(260, "dock-left", "dock-left"),
      createRightPanelTabBorder(280, "dock-right", "dock-right"),
      createBottomPanelTabBorder(
        resolveBottomDockDefaultBorderSize("mobile"),
        resolveBottomDockMinHeight("mobile"),
        "dock-bottom",
        "dock-bottom",
      ),
    ],
    layout: {
      type: "row",
      id: "dock-root-row",
      children: [center],
    } as IJsonRowNode,
  };
}

const DOCK_LAYOUT_TEMPLATES_BY_ID: Record<DockLayoutTemplateId, DockLayoutTemplate> = {
  "default-desktop": {
    id: "default-desktop",
    label: "Domyślny układ desktop",
    description: "Standardowe proporcje 3+ kolumn z dolnym panelem w środku.",
    preset: "desktop",
    model: makeDesktopRootLayout({
      leftWeight: 18,
      centerColumnWeight: 64,
      rightWeight: 20,
      centerWeight: 100,
      bottomWeight: 10,
      rightBottomInBorder: false,
    }),
    panels: {
      "dock-left": {
        component: "dock-left",
        label: "Eksplorator",
        preferredWidthPx: 280,
      },
      "dock-center": {
        component: "dock-center",
        label: "Główny viewport",
        preferredWidthPx: 640,
      },
      "dock-right": {
        component: "dock-right",
        label: "Panel inspektora",
        preferredWidthPx: 320,
      },
      "dock-bottom": {
        component: "dock-bottom",
        label: "Pasek narzędzi",
        preferredHeightPx: 108,
      },
    },
  },
  "analysis-heavy": {
    id: "analysis-heavy",
    label: "Analiza ciężka",
    description: "Szerszy dolny panel telemetry, przydatny przy intensywnym podglądzie.",
    preset: "desktop",
    model: makeDesktopRootLayout({
      leftWeight: 16,
      centerColumnWeight: 58,
      rightWeight: 18,
      centerWeight: 100,
      bottomWeight: 10,
      rightBottomInBorder: false,
    }),
    panels: {
      "dock-left": {
        component: "dock-left",
        label: "Eksplorator",
        preferredWidthPx: 260,
      },
      "dock-center": {
        component: "dock-center",
        label: "Główny viewport",
        preferredWidthPx: 720,
      },
      "dock-right": {
        component: "dock-right",
        label: "Panel inspektora",
        preferredWidthPx: 280,
      },
      "dock-bottom": {
        component: "dock-bottom",
        label: "Pasek analityczny",
        preferredHeightPx: 108,
      },
    },
  },
  "inspector-focus": {
    id: "inspector-focus",
    label: "Akcent inspektora",
    description: "Szerszy lewy panel i większy inspektor po prawej.",
    preset: "desktop",
    model: makeDesktopRootLayout({
      leftWeight: 24,
      centerColumnWeight: 58,
      rightWeight: 18,
      centerWeight: 100,
      bottomWeight: 10,
      rightBottomInBorder: false,
    }),
    panels: {
      "dock-left": {
        component: "dock-left",
        label: "Eksplorator",
        preferredWidthPx: 340,
      },
      "dock-center": {
        component: "dock-center",
        label: "Główny viewport",
        preferredWidthPx: 680,
      },
      "dock-right": {
        component: "dock-right",
        label: "Panel inspektora",
        preferredWidthPx: 360,
      },
      "dock-bottom": {
        component: "dock-bottom",
        label: "Pasek telemetry",
        preferredHeightPx: 108,
      },
    },
  },
  "compact-inspector": {
    id: "compact-inspector",
    label: "Kompaktowy inspektor",
    description: "Węższy panel inspektora i więcej miejsca dla viewportu.",
    preset: "desktop",
    model: makeDesktopRootLayout({
      leftWeight: 18,
      centerColumnWeight: 68,
      rightWeight: 12,
      centerWeight: 100,
      bottomWeight: 10,
      rightBottomInBorder: false,
    }),
    panels: {
      "dock-left": {
        component: "dock-left",
        label: "Eksplorator",
        preferredWidthPx: 240,
      },
      "dock-center": {
        component: "dock-center",
        label: "Główny viewport",
        preferredWidthPx: 760,
      },
      "dock-right": {
        component: "dock-right",
        label: "Panel inspektora",
        preferredWidthPx: 220,
      },
      "dock-bottom": {
        component: "dock-bottom",
        label: "Pasek telemetry",
        preferredHeightPx: 108,
      },
    },
  },
  "default-tablet": {
    id: "default-tablet",
    label: "Domyślny układ tablet",
    description: "Układ desktopowy z panelami brzegowymi po prawej i dołu.",
    preset: "tablet",
    model: makeTabletLayout(),
    panels: {
      "dock-left": {
        component: "dock-left",
        label: "Eksplorator",
      },
      "dock-center": {
        component: "dock-center",
        label: "Główny viewport",
      },
      "dock-right": {
        component: "dock-right",
        label: "Panel inspektora",
      },
      "dock-bottom": {
        component: "dock-bottom",
        label: "Pasek telemetry",
        preferredHeightPx: 104,
      },
    },
  },
  "default-mobile": {
    id: "default-mobile",
    label: "Domyślny układ mobile",
    description: "Centrum w widoku głównym i panele boczne/dół jako panele krawędziowe.",
    preset: "mobile",
    model: makeMobileLayout(),
    panels: {
      "dock-left": {
        component: "dock-left",
        label: "Eksplorator",
      },
      "dock-center": {
        component: "dock-center",
        label: "Główny viewport",
      },
      "dock-right": {
        component: "dock-right",
        label: "Panel inspektora",
      },
      "dock-bottom": {
        component: "dock-bottom",
        label: "Pasek telemetry",
        preferredHeightPx: 96,
      },
    },
  },
};

export function getDockLayoutTemplate(templateId: DockLayoutTemplateId): DockLayoutTemplate {
  return DOCK_LAYOUT_TEMPLATES_BY_ID[templateId];
}

export function getDockLayoutTemplateIds(): DockLayoutTemplateId[] {
  return [
    "default-desktop",
    "default-tablet",
    "default-mobile",
    "analysis-heavy",
    "inspector-focus",
    "compact-inspector",
  ];
}

export function resolveDockLayoutTemplateId(preset: DockResponsivePreset): DockLayoutTemplateId {
  if (preset === "mobile") return "default-mobile";
  if (preset === "tablet") return "default-tablet";
  return "default-desktop";
}

export function createDefaultDockLayout(preset: DockResponsivePreset): IJsonModel {
  return cloneJson(getDockLayoutTemplate(resolveDockLayoutTemplateId(preset)).model);
}

export function resolveDockResponsivePreset(width: number): DockResponsivePreset {
  if (width < 900) return "mobile";
  if (width < 1360) return "tablet";
  return "desktop";
}
