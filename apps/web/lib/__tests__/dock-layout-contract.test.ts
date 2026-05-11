import { describe, expect, it } from "vitest";

import type { IJsonBorderNode, IJsonModel, IJsonNode, IJsonTabSetNode } from "flexlayout-react";

import {
  DOCKING_MIN_HEIGHT_BOTTOM_DESKTOP,
  DOCKING_DEFAULT_HEIGHT_BOTTOM_TABLET,
  DOCKING_MIN_WIDTH_LEFT,
  createDefaultDockLayout,
} from "@/components/workspace/docking/dockLayoutDefaults";
import {
  normalizeDockLayoutRuntimeModel,
  parseDockLayoutRecordForPreset,
} from "../workspace/dockLayoutContract";

function collectComponentsFromLayout(model: IJsonModel): Set<string> {
  const found = new Set<string>();

  const visit = (node: IJsonNode) => {
    if (node.type === "tab" && typeof node.component === "string") {
      found.add(node.component);
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        visit(child as IJsonNode);
      }
    }
  };

  visit(model.layout as IJsonNode);
  for (const border of model.borders ?? []) {
    visit(border as IJsonNode);
  }
  return found;
}

function findTabSetByComponent(model: IJsonModel, component: string): IJsonTabSetNode | null {
  let found: IJsonTabSetNode | null = null;

  const visit = (node: unknown) => {
    if (found) return;
    if (!node || typeof node !== "object") return;
    const record = node as Partial<IJsonTabSetNode> & { children?: unknown[] };
    if (
      record.type === "tabset" &&
      record.children?.some(
        (child) =>
          Boolean(child) &&
          typeof child === "object" &&
          (child as { type?: unknown; component?: unknown }).type === "tab" &&
          (child as { component?: unknown }).component === component,
      )
    ) {
      found = node as IJsonTabSetNode;
      return;
    }
    if (Array.isArray(record.children)) {
      for (const child of record.children) {
        visit(child);
      }
    }
  };

  visit(model.layout);
  return found;
}

function findBottomBorder(model: IJsonModel): IJsonBorderNode | null {
  return (model.borders ?? []).find(
    (border) => (border as IJsonBorderNode).location === "bottom",
  ) as IJsonBorderNode | null;
}

function findNestedCenterBottomTabsets(model: IJsonModel): {
  center: IJsonTabSetNode | null;
  bottom: IJsonTabSetNode | null;
} {
  let center: IJsonTabSetNode | null = null;
  let bottom: IJsonTabSetNode | null = null;

  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as Partial<IJsonTabSetNode> & { children?: unknown[] };
    if (record.type === "tabset") {
      const hasComponent = (component: string) =>
        record.children?.some(
          (child) =>
            Boolean(child) &&
            typeof child === "object" &&
            (child as { type?: unknown; component?: unknown }).type === "tab" &&
            (child as { component?: unknown }).component === component,
        ) ?? false;
      if (hasComponent("dock-center")) center = node as IJsonTabSetNode;
      if (hasComponent("dock-bottom")) bottom = node as IJsonTabSetNode;
    }
    if (Array.isArray(record.children)) {
      for (const child of record.children) {
        visit(child);
      }
    }
  };

  visit(model.layout);
  return { center, bottom };
}

describe("dock layout contract", () => {
  it("replaces invalid payload with default template envelope", () => {
    const repaired = parseDockLayoutRecordForPreset("nonsense", "desktop");
    const defaultModel = createDefaultDockLayout("desktop");

    expect(repaired.dockingLayoutSchemaVersion).toBe(2);
    expect(repaired.templateId).toBe("default-desktop");
    expect(repaired.model).toMatchObject(defaultModel);
    expect(repaired.wasRecovered).toBe(true);
  });

  it("migrates legacy schema payload to current version", () => {
    const legacyPayload = {
      dockingLayoutSchemaVersion: 0,
      templateId: "default-desktop",
      model: createDefaultDockLayout("desktop"),
    };

    const repaired = parseDockLayoutRecordForPreset(legacyPayload, "desktop");

    expect(repaired.dockingLayoutSchemaVersion).toBe(2);
    expect(repaired.wasRecovered).toBe(true);
    expect(typeof repaired.lastRepairReason).toBe("string");
  });

  it("injects required dock-right and dock-bottom when missing", () => {
    const raw = {
      layout: {
        type: "row",
        id: "root",
        children: [
          {
            type: "tabset",
            id: "left",
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
            type: "tabset",
            id: "center",
            children: [
              {
                type: "tab",
                id: "dock-center",
                name: "Viewport",
                component: "dock-center",
                enableClose: false,
                enableDrag: false,
              },
            ],
          },
        ],
      },
      borders: [],
      global: { splitterSize: 6 },
    };

    const repaired = parseDockLayoutRecordForPreset(raw, "desktop");
    const components = collectComponentsFromLayout(repaired.model);

    expect(components.has("dock-left")).toBe(true);
    expect(components.has("dock-center")).toBe(true);
    expect(components.has("dock-right")).toBe(true);
    expect(components.has("dock-bottom")).toBe(true);
  });

  it("clamps suspicious minWidth/minHeight to safe minimums", () => {
    const desktopDefault = createDefaultDockLayout("desktop");

    const repaired = parseDockLayoutRecordForPreset(
      {
        global: desktopDefault.global,
        layout: {
          type: "row",
          id: "root",
          children: [
            {
              type: "tabset",
              id: "left",
              minWidth: 10,
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
              type: "tabset",
              id: "center",
              children: [
                {
                  type: "tab",
                  id: "dock-center",
                  name: "Viewport",
                  component: "dock-center",
                  enableClose: false,
                  enableDrag: false,
                },
              ],
            },
          ],
        },
        borders: [
          {
            type: "border",
            location: "right",
            size: 10,
            minSize: 80,
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
            size: 10,
            minSize: 40,
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
      },
      "desktop",
    );

    const repairedLeft = findTabSetByComponent(repaired.model as IJsonModel, "dock-left");
    const repairedBottom = findBottomBorder(repaired.model as IJsonModel);

    expect(repairedLeft?.minWidth ?? 0).toBeGreaterThanOrEqual(DOCKING_MIN_WIDTH_LEFT);
    expect(repairedBottom?.size ?? 0).toBeGreaterThanOrEqual(DOCKING_MIN_HEIGHT_BOTTOM_DESKTOP);
  });

  it("normalizes legacy persisted center and bottom weights to the compact dock defaults", () => {
    const desktopDefault = createDefaultDockLayout("desktop");
    const persisted = JSON.parse(JSON.stringify(desktopDefault)) as IJsonModel;
    const mainColumn = (persisted.layout.children?.[1] ?? null) as
      | { children?: IJsonTabSetNode[] }
      | null;
    const center = mainColumn?.children?.[0];
    const bottom = mainColumn?.children?.[1];
    if (!center || !bottom) {
      throw new Error("default desktop layout shape changed");
    }
    center.weight = 42;
    bottom.weight = 58;

    const repaired = parseDockLayoutRecordForPreset(
      {
        dockingLayoutSchemaVersion: 1,
        templateId: "default-desktop",
        model: persisted,
      },
      "desktop",
    );
    const normalized = findNestedCenterBottomTabsets(repaired.model);

    expect(normalized.center?.weight).toBe(100);
    expect(normalized.bottom?.weight).toBe(10);
    expect(repaired.wasRecovered).toBe(true);
    expect(repaired.lastRepairReason).toBe(
      "Normalized center/bottom dock weights for compact bottom dock defaults.",
    );
  });

  it("normalizes legacy tablet bottom border sizes to the compact responsive default", () => {
    const tabletDefault = createDefaultDockLayout("tablet");
    const persisted = JSON.parse(JSON.stringify(tabletDefault)) as IJsonModel;
    const bottomBorder = findBottomBorder(persisted);
    if (!bottomBorder) {
      throw new Error("default tablet layout shape changed");
    }
    bottomBorder.size = 220;

    const repaired = parseDockLayoutRecordForPreset(
      {
        dockingLayoutSchemaVersion: 1,
        templateId: "default-tablet",
        model: persisted,
      },
      "tablet",
    );

    expect(findBottomBorder(repaired.model)?.size).toBe(DOCKING_DEFAULT_HEIGHT_BOTTOM_TABLET);
    expect(repaired.wasRecovered).toBe(true);
    expect(repaired.lastRepairReason).toBe(
      "Normalized bottom border size for compact responsive defaults.",
    );
  });

  it("does not shrink a live runtime resize back to the legacy default weight", () => {
    const desktopDefault = createDefaultDockLayout("desktop");
    const liveModel = JSON.parse(JSON.stringify(desktopDefault)) as IJsonModel;
    const mainColumn = (liveModel.layout.children?.[1] ?? null) as
      | { children?: IJsonTabSetNode[] }
      | null;
    const center = mainColumn?.children?.[0];
    const bottom = mainColumn?.children?.[1];
    if (!center || !bottom) {
      throw new Error("default desktop layout shape changed");
    }
    center.weight = 100;
    bottom.weight = 24;

    const normalized = normalizeDockLayoutRuntimeModel(liveModel, "desktop");
    const next = findNestedCenterBottomTabsets(normalized.model);

    expect(normalized.changed).toBe(false);
    expect(next.bottom?.weight).toBe(24);
  });
});
