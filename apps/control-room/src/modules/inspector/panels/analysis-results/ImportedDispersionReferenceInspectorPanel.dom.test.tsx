import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  REMOVE_DISPERSION_REFERENCE_COMMAND,
} from "@/kernel/analysis-modules/postprocessingCommandContributions";
import {
  findElements,
  installSimulationPreparationTestDom,
  TestElement,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { ImportedDispersionReferenceInspectorPanel } from "./ImportedDispersionReferenceInspectorPanel";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  definitionsResource: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({ commands: { execute: mocks.execute } }),
}));

vi.mock("@/kernel/commands/commandContext", () => ({
  createCommandContext: vi.fn(() => ({ source: "inspector" })),
}));

vi.mock("@/kernel/resources/postprocessingDefinitionResources", () => ({
  usePostprocessingDefinitionsResource: mocks.definitionsResource,
}));

const importedDefinition = {
  definition_id: "reference:definition-1",
  revision: 1,
  module_id: "analysis.dispersion",
  module_version: "0.1.0",
  definition_schema: "analysis.dispersion.reference.v1",
  node_kind: "analysis.dispersion.reference",
  label: "Measured branch",
  data_ref: {
    run_id: "run-7",
    dataset_id: "stage-3",
    dataset_revision: "artifact-r2",
  },
  settings: {
    file_name: "measured.csv",
    path_quantity: "path_coordinate_rad_per_m",
    points: [[0, 1.2e9], [1e6, 1.3e9]],
    source: "imported_table",
    source_units: { frequency: "GHz", path: "rad/um" },
    y_quantity: "frequency_hz",
  },
};

const selection = {
  kind: "analysis.dispersion.reference",
  label: "Measured branch",
  nodeId: "results:run:run-7:comparison:reference-1",
  ref: {
    definitionId: importedDefinition.definition_id,
    kind: "analysis.dispersion.reference",
    nodeId: "results:run:run-7:comparison:reference-1",
    runId: "run-7",
    stageId: "stage-3",
    type: "analysis-reference",
  },
} as never;

describe("ImportedDispersionReferenceInspectorPanel DOM", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.definitionsResource.mockReturnValue({
      data: { definitions: [importedDefinition], scene_revision: 17 },
      status: "ready",
    });
    mocks.execute.mockResolvedValue({
      status: "completed",
      message: "Reference Measured branch removed.",
    });
  });

  it("shows imported reference metadata and removes the selected definition through CommandRegistry", async () => {
    await withRenderedPanel(async (container) => {
      const metricStrip = findElements(
        container,
        (element) => element.getAttribute("data-slot") === "inspector-metric-strip",
      )[0];

      expect(metricStrip?.getAttribute("data-count")).toBe("4");
      expect(metricValue(container, "Status")).toBe("Imported · not qualified");
      expect(metricValue(container, "Points")).toBe("2");
      expect(metricValue(container, "Scene revision")).toBe("17");
      expect(metricValue(container, "Artifact revision")).toBe("artifact-r2");
      expect(container.textContent).toContain("measured.csv");
      expect(container.textContent).toContain("Measured branch");
      expect(container.textContent).toContain("rad/um · GHz");

      await act(async () => {
        findRemoveButton(container).click();
        await Promise.resolve();
      });

      expect(mocks.execute).toHaveBeenCalledWith(
        REMOVE_DISPERSION_REFERENCE_COMMAND,
        expect.objectContaining({ source: "inspector" }),
        { definitionId: importedDefinition.definition_id },
      );
      const feedback = findElements(
        container,
        (element) => element.getAttribute("role") === "status",
      )[0];
      expect(feedback?.textContent).toContain("Reference Measured branch removed.");
    });
  });

  it.each([
    [
      "missing",
      [],
      "This imported reference no longer exists in the current scene.",
    ],
    [
      "owner mismatch",
      [{
        ...importedDefinition,
        data_ref: { ...importedDefinition.data_ref, run_id: "run-foreign" },
      }],
      "This reference no longer matches the selected run and stage.",
    ],
  ])(
    "fails closed when the selected definition is %s",
    async (_case, definitions, reason) => {
      mocks.definitionsResource.mockReturnValue({
        data: { definitions, scene_revision: 18 },
        status: "ready",
      });

      await withRenderedPanel((container) => {
        expect(findRemoveButtons(container)).toHaveLength(0);
        expect(container.textContent).toContain(reason);
        expect(mocks.execute).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    ["idle", "The saved reference definition has not been loaded yet."],
    ["loading", "Loading the saved reference definition."],
    ["stale", "The saved reference definition is stale and cannot be changed."],
    ["error", "The saved reference definition could not be loaded."],
  ] as const)("hides removal when retained definitions are %s", async (status, reason) => {
    mocks.definitionsResource.mockReturnValue({
      data: { definitions: [importedDefinition], scene_revision: 18 },
      status,
    });

    await withRenderedPanel((container) => {
      expect(findRemoveButtons(container)).toHaveLength(0);
      expect(metricValue(container, "Status")).toBe("Unavailable");
      expect(metricValue(container, "Points")).toBe("—");
      expect(metricValue(container, "Artifact revision")).toBe("—");
      expect(container.textContent).not.toContain("Imported · not qualified");
      expect(container.textContent).toContain(reason);
      expect(mocks.execute).not.toHaveBeenCalled();
    });
  });
});

async function withRenderedPanel(
  assertion: (container: TestElement) => void | Promise<void>,
): Promise<void> {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);

  try {
    await act(async () => root.render(
      <ImportedDispersionReferenceInspectorPanel selection={selection} />,
    ));
    await assertion(container);
  } finally {
    await act(async () => root.unmount());
    dom.restore();
  }
}

function metricValue(root: TestNode, label: string): string {
  const card = findElements(root, (element) =>
    element.getAttribute("data-slot") === "inspector-metric" &&
    findElements(element, (child) =>
      child.tagName === "SPAN" &&
      child.getAttribute("class") === "fm-inspector-metric-card__label" &&
      child.textContent.trim() === label,
    ).length === 1,
  )[0];
  if (!card) throw new Error("Missing Inspector metric " + label);

  const value = findElements(
    card,
    (element) =>
      element.tagName === "SPAN" &&
      element.getAttribute("class")
        ?.split(/\s+/)
        .includes("fm-inspector-metric-card__value") === true,
  )[0];
  if (!value) throw new Error("Missing Inspector metric value " + label);
  return value.textContent.trim();
}

function findRemoveButtons(root: TestNode): TestElement[] {
  return findElements(root, (element) =>
    element.tagName === "BUTTON" && element.textContent.includes("Remove reference"),
  );
}

function findRemoveButton(root: TestNode): TestElement {
  const button = findRemoveButtons(root)[0];
  if (!button) throw new Error("Missing Remove reference button");
  return button;
}

