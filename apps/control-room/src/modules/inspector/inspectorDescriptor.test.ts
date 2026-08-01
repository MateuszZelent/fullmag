import { describe, expect, it } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import { resolveInspectorDescriptor } from "./inspectorDescriptor";

function selection(kind: string, label = "Film"): Selection {
  return {
    kind,
    label,
    moduleSource: "explorer",
    nodeId: `node:${kind}`,
    objectId: "film",
    ref: null,
  };
}

describe("resolveInspectorDescriptor", () => {
  it("uses the exact visualization information architecture", () => {
    const descriptor = resolveInspectorDescriptor(
      selection("object.visualization", "Visualization"),
    );

    expect(descriptor.tabs).toEqual([]);
    expect(descriptor.typeLabel).toBe("Display");
  });

  it("uses task-oriented mesh navigation", () => {
    const descriptor = resolveInspectorDescriptor(selection("object.mesh"));

    expect(descriptor.tabs).toEqual([
      { id: "policy", label: "Policy" },
      { id: "quality", label: "Quality" },
      { id: "history", label: "History" },
    ]);
  });

  it.each([
    "object.material",
    "object.mesh",
    "object.region.visualization",
    "study.stage.relax",
    "results.frequency_domain.root",
    "diagnostics.frequency_domain.root",
  ])("never exposes more than four tabs for %s", (kind) => {
    expect(resolveInspectorDescriptor(selection(kind)).tabs.length).toBeLessThanOrEqual(4);
  });

  it("keeps identity concise and limits metadata to four entries", () => {
    const descriptor = resolveInspectorDescriptor(selection("object.material"));

    expect(descriptor.title).toBe("Film");
    expect(descriptor.breadcrumbs.map((item) => item.label)).toEqual([
      "Film",
      "Material",
    ]);
    expect(descriptor.metadata.length).toBeLessThanOrEqual(4);
  });

  it("exposes exact picked mesh-cell identity without coercing the ordinal", () => {
    const descriptor = resolveInspectorDescriptor({
      ...selection("object.root"),
      ref: {
        carrierPartId: "part:film",
        elementFamily: "prism6",
        globalCellOrdinal: "9007199254740993",
        kind: "object.root",
        nodeId: "model:object:film",
        objectId: "film",
        type: "scene-object",
        visualizationTargetId: "object:film",
      },
    });

    expect(descriptor.metadata).toContainEqual({
      label: "Element family",
      value: "prism6",
    });
    expect(descriptor.metadata).toContainEqual({
      label: "Global cell ordinal",
      value: "9007199254740993",
    });
  });

  it.each([
    "object.material",
    "object.geometry",
    "object.physics",
    "object.regions",
    "object.region.material",
    "study.root",
    "study.stage.relax",
  ])("does not render generic tabs for continuous authoring panel %s", (kind) => {
    expect(resolveInspectorDescriptor(selection(kind)).tabs).toEqual([]);
  });

  it("uses an honest empty-selection descriptor", () => {
    const descriptor = resolveInspectorDescriptor({
      kind: null,
      label: null,
      moduleSource: null,
      nodeId: null,
      objectId: null,
      ref: null,
    });

    expect(descriptor.title).toBe("Nothing selected");
    expect(descriptor.tabs).toEqual([]);
    expect(descriptor.status).toBeNull();
  });

  it("provides a navigable Airbox parent breadcrumb", () => {
    const descriptor = resolveInspectorDescriptor({
      kind: "airbox.visualization",
      label: "Visualization",
      moduleSource: "explorer",
      nodeId: "model:airbox:visualization",
      objectId: null,
      ref: {
        kind: "airbox.visualization",
        nodeId: "model:airbox:visualization",
        type: "airbox",
        visualizationTargetId: "airbox",
      },
    });

    expect(descriptor.breadcrumbs[0]).toMatchObject({
      label: "Airbox",
      selection: { kind: "airbox.root", nodeId: "model:airbox" },
    });
  });
});
