import { describe, expect, it, vi } from "vitest";

import {
  PIN_MODE_VISUALIZATION_COMMAND,
  POSTPROCESSING_DEFINITION_COMMANDS,
} from "./postprocessingCommandContributions";

const fieldId = "analysis:eigen:sample-0001:mode-0000";

function modeSelection() {
  return {
    kind: "results.dispersion.modal.mode_at_k",
    label: "Mode 1",
    ref: {
      analysisRunId: "run-1",
      analysisStageId: "stage-1",
      artifactRevision: 7,
      fieldId,
      sampleId: "sample-0001",
      modeId: "mode-0000",
      type: "frequency-domain" as const,
    },
  };
}

function savedModeDefinition(
  datasetRevision: string,
  optionalOwner: { sampleId?: string; itemId?: string } = {
    sampleId: "sample-0001",
    itemId: "mode-0000",
  },
) {
  return {
    definition_id: `analysis.dispersion:mode-visualization:${fieldId}`,
    revision: 1,
    module_id: "analysis.dispersion",
    module_version: "0.1.0",
    definition_schema: "analysis.dispersion.mode_visualization.v1",
    node_kind: "analysis.dispersion.mode_visualization",
    label: "Mode 1",
    data_ref: {
      run_id: "run-1",
      dataset_id: "stage-1",
      dataset_revision: datasetRevision,
      field_id: fieldId,
      ...(optionalOwner.sampleId !== undefined
        ? { sample_id: optionalOwner.sampleId }
        : {}),
      ...(optionalOwner.itemId !== undefined
        ? { item_id: optionalOwner.itemId }
        : {}),
    },
    settings: { placement: "beside" },
  };
}

function commandContext(
  definitions: readonly ReturnType<typeof savedModeDefinition>[],
  create = vi.fn(),
) {
  const list = vi.fn().mockResolvedValue({ definitions, scene_revision: 11 });
  const invalidate = vi.fn();
  return {
    context: {
      api: { analysis: { postprocessing: { definitions: { list, create } } } },
      selection: { get: () => modeSelection() },
      resources: { invalidate },
    } as never,
    create,
    invalidate,
    list,
  };
}

function pinCommand() {
  return POSTPROCESSING_DEFINITION_COMMANDS.find(
    (command) => command.id === PIN_MODE_VISUALIZATION_COMMAND,
  );
}

describe("pin mode visualization command owner deduplication", () => {
  it("recognizes an existing field-only ID by its complete stored owner", async () => {
    const command = pinCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = commandContext([savedModeDefinition("7")]);

    const result = await command.run(fixture.context);

    expect(result).toEqual({
      message: "This mode visualization is already pinned.",
      status: "completed",
    });
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("allows the same field in a different published dataset revision", async () => {
    const command = pinCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = commandContext([savedModeDefinition("6")]);
    fixture.create.mockResolvedValue({
      definition: { label: "Mode 1" },
      scene_revision: 12,
    });

    await command.run(fixture.context);

    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.create).toHaveBeenCalledWith(expect.objectContaining({
      definition: expect.objectContaining({
        data_ref: expect.objectContaining({
          dataset_id: "stage-1",
          dataset_revision: "7",
          field_id: fieldId,
          run_id: "run-1",
          sample_id: "sample-0001",
          item_id: "mode-0000",
        }),
      }),
    }));
  });

  it.each([
    ["both optional IDs are missing", {}],
    ["one optional ID is missing", { sampleId: "sample-0001" }],
    ["the other optional ID is missing", { itemId: "mode-0000" }],
  ])("refuses to create a duplicate when a legacy owner is ambiguous: %s", async (_label, owner) => {
    const command = pinCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = commandContext([savedModeDefinition("7", owner)]);

    const result = await command.run(fixture.context);

    expect(result).toEqual({
      message:
        "An existing pin and this selection share the same published field owner, but lack enough sample or mode identity to tell whether they are the same mode. Review or remove the existing pin before adding another.",
      status: "failed",
    });
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("keeps an explicit mode conflict distinct despite another missing ID", async () => {
    const command = pinCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = commandContext([
      savedModeDefinition("7", { itemId: "mode-other" }),
    ]);
    fixture.create.mockResolvedValue({
      definition: { label: "Mode 1" },
      scene_revision: 12,
    });

    const result = await command.run(fixture.context);

    expect(result.status).toBe("completed");
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.invalidate).toHaveBeenCalledTimes(1);
  });
});
