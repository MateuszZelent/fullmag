import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REMOVE_DISPERSION_REFERENCE_COMMAND,
} from "@/kernel/analysis-modules/postprocessingCommandContributions";

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
    mocks.definitionsResource.mockReturnValue({
      data: { definitions: [importedDefinition], scene_revision: 17 },
      status: "ready",
    });
    mocks.execute.mockResolvedValue({
      status: "completed",
      message: "Reference Measured branch removed.",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows imported reference metadata and removes the selected definition through CommandRegistry", async () => {
    render(<ImportedDispersionReferenceInspectorPanel selection={selection} />);

    expect(screen.getByText("Imported · not qualified")).toBeTruthy();
    expect(screen.getByText("measured.csv")).toBeTruthy();
    expect(screen.getAllByText("Measured branch").length).toBeGreaterThan(0);
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("rad/um · GHz")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove reference" }));
    await waitFor(() => {
      expect(mocks.execute).toHaveBeenCalledWith(
        REMOVE_DISPERSION_REFERENCE_COMMAND,
        expect.objectContaining({ source: "inspector" }),
        { definitionId: importedDefinition.definition_id },
      );
    });
    expect((await screen.findByRole("status")).textContent).toContain("Reference Measured branch removed.");
  });

  it.each([
    ["missing", []],
    ["stale", [{
      ...importedDefinition,
      data_ref: { ...importedDefinition.data_ref, run_id: "run-foreign" },
    }]],
  ])("fails closed when the selected definition is %s", (_case, definitions) => {
    mocks.definitionsResource.mockReturnValue({
      data: { definitions, scene_revision: 18 },
      status: "ready",
    });

    render(<ImportedDispersionReferenceInspectorPanel selection={selection} />);

    expect(screen.queryByRole("button", { name: "Remove reference" })).toBeNull();
    expect(screen.getByText(_case === "missing"
      ? "This imported reference no longer exists in the current scene."
      : "This reference no longer matches the selected run and stage.")).toBeTruthy();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["idle", "The saved reference definition has not been loaded yet."],
    ["loading", "Loading the saved reference definition."],
    ["stale", "The saved reference definition is stale and cannot be changed."],
    ["error", "The saved reference definition could not be loaded."],
  ] as const)("hides removal when retained definitions are %s", (status, reason) => {
    mocks.definitionsResource.mockReturnValue({
      data: { definitions: [importedDefinition], scene_revision: 18 },
      status,
    });

    render(<ImportedDispersionReferenceInspectorPanel selection={selection} />);

    expect(screen.queryByRole("button", { name: "Remove reference" })).toBeNull();
    expect(screen.queryByText("Imported · not qualified")).toBeNull();
    expect(screen.getByText(reason)).toBeTruthy();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
