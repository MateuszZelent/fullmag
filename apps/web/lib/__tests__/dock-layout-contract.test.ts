import { describe, expect, it } from "vitest";

import type { IJsonBorderNode, IJsonModel, IJsonNode, IJsonTabSetNode } from "flexlayout-react";

import {
  DOCKING_MIN_HEIGHT_BOTTOM,
  DOCKING_MIN_WIDTH_LEFT,
  createDefaultDockLayout,
} from "@/components/workspace/docking/dockLayoutDefaults";
import { parseDockLayoutRecordForPreset } from "../workspace/dockLayoutContract";

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
    if (record.type === "tabset" && record.component === component) {
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

describe("dock layout contract", () => {
  it("replaces invalid payload with default template envelope", () => {
    const repaired = parseDockLayoutRecordForPreset("nonsense", "desktop");
    const defaultModel = createDefaultDockLayout("desktop");

    expect(repaired.dockingLayoutSchemaVersion).toBe(1);
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

    expect(repaired.dockingLayoutSchemaVersion).toBe(1);
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
    expect(repairedBottom?.size ?? 0).toBeGreaterThanOrEqual(DOCKING_MIN_HEIGHT_BOTTOM);
  });
});
