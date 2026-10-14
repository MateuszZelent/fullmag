import { describe, expect, it, vi } from "vitest";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { AuthoringHistoryController } from "@/kernel/authoring/AuthoringHistoryController";

import {
  ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import { MAX_REFERENCE_POINTS } from "@/shared/domain/analysis/referenceImport";

import {
  IMPORT_DISPERSION_REFERENCE_COMMAND,
  PIN_MODE_VISUALIZATION_COMMAND,
  POSTPROCESSING_DEFINITION_COMMANDS,
  UNPIN_POSTPROCESSING_DEFINITION_COMMAND,
} from "./postprocessingCommandContributions";

const fieldId = "analysis:eigen:sample-0001:mode-0000";

function modeSelection(includeCanonicalDatasetIdentity = true) {
  return {
    kind: "results.dispersion.modal.mode_at_k",
    label: "Mode 1",
    ref: {
      analysisRunId: "run-1",
      analysisStageId: "stage-1",
      artifactRevision: 7,
      ...(includeCanonicalDatasetIdentity
        ? { datasetId: "stage-1", datasetRevision: "7" }
        : {}),
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
  authoringHistory?: AuthoringHistoryController,
  selectedMode = modeSelection(),
) {
  const list = vi.fn().mockResolvedValue({ definitions, scene_revision: 11 });
  const invalidate = vi.fn();
  return {
    context: {
      api: { analysis: { postprocessing: { definitions: { list, create } } } },
      selection: { get: () => selectedMode },
      resources: { invalidate },
      authoringHistory,
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

function referenceCommandContext(input: unknown, list = vi.fn().mockResolvedValue({ definitions: [], scene_revision: 11 })) {
  const create = vi.fn();
  const invalidate = vi.fn();
  return {
    context: {
      api: { analysis: { postprocessing: { definitions: { list, create } } } },
      input,
      selection: {
        get: () => ({
          kind: "results.dispersion",
          label: "Dispersion",
          ref: {
            analysisRunId: "run-1",
            analysisStageId: "stage-1",
            artifactRevision: 7,
            type: "frequency-domain" as const,
          },
        }),
      },
      resources: { invalidate },
    } as never,
    create,
    invalidate,
    list,
  };
}

function referenceCommand() {
  return POSTPROCESSING_DEFINITION_COMMANDS.find(
    (command) => command.id === IMPORT_DISPERSION_REFERENCE_COMMAND,
  );
}

describe("pin mode visualization command owner deduplication", () => {
  it("refuses to pin a field without canonical published dataset identity", async () => {
    const command = pinCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = commandContext([], vi.fn(), undefined, modeSelection(false));

    const result = await command.run(fixture.context);

    expect(result).toEqual({
      message: "The selected field has no canonical published dataset identity.",
      status: "failed",
    });
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

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
    }), undefined);
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
    expectSceneRevisionInvalidations(fixture.invalidate.mock.calls, 12);
  });
});

describe("import dispersion reference command bounds", () => {
  it("preserves valid SI pairs through the existing definitions API command", async () => {
    const command = referenceCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = referenceCommandContext({
      fileName: "reference.csv",
      label: "Reference",
      points: [[3, 9], [-1, 2]],
      sourceUnits: { frequency: "GHz", path: "rad/um" },
    });
    fixture.create.mockResolvedValue({
      definition: { label: "Reference" },
      scene_revision: 12,
    });

    const result = await command.run(fixture.context);

    expect(result).toEqual({ message: "Imported reference Reference.", status: "completed" });
    expect(fixture.create).toHaveBeenCalledWith(expect.objectContaining({
      definition: expect.objectContaining({
        data_ref: { dataset_revision: "7", dataset_id: "stage-1", run_id: "run-1" },
        settings: expect.objectContaining({ points: [[3, 9], [-1, 2]] }),
      }),
      expected_scene_revision: 11,
    }), undefined);
    expectSceneRevisionInvalidations(fixture.invalidate.mock.calls, 12);
  });

  it.each([
    ["oversized points", Array.from({ length: MAX_REFERENCE_POINTS + 1 }, (_, index) => [index, index])],
    ["non-finite point", [[0, 1], [1, Number.NaN]]],
    ["malformed tuple", [[0, 1], [1, 2, 3]]],
  ])("rejects %s before listing or creating stored definitions", async (_label, points) => {
    const command = referenceCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = referenceCommandContext({
      fileName: "reference.csv",
      label: "Reference",
      points,
      sourceUnits: { frequency: "GHz", path: "rad/um" },
    });

    const result = await command.run(fixture.context);

    expect(result.status).toBe("failed");
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("rejects unsupported units without reading or mutating stored definitions", async () => {
    const command = referenceCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = referenceCommandContext({
      fileName: "reference.csv",
      label: "Reference",
      points: [[0, 1], [1, 2]],
      sourceUnits: { frequency: "kHz", path: "rad/m" },
    });

    const result = await command.run(fixture.context);

    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/supported units/);
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("fails closed without WebCrypto SHA-256 and never creates a reference", async () => {
    const command = referenceCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const fixture = referenceCommandContext({
      fileName: "reference.csv",
      label: "Reference",
      points: [[0, 1], [1, 2]],
      sourceUnits: { frequency: "GHz", path: "rad/um" },
    });
    vi.stubGlobal("crypto", { subtle: undefined });

    try {
      const result = await command.run(fixture.context);

      expect(result).toMatchObject({
        message: "Reference import failed: SHA-256 digest is unavailable for reference identity.",
        status: "failed",
      });
      expect(fixture.list).toHaveBeenCalledTimes(1);
      expect(fixture.create).not.toHaveBeenCalled();
      expect(fixture.invalidate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns facade failures as a command result", async () => {
    const command = referenceCommand();
    expect(command).toBeDefined();
    if (!command) return;
    const list = vi.fn().mockRejectedValue(new Error("definitions unavailable"));
    const fixture = referenceCommandContext({
      fileName: "reference.csv",
      label: "Reference",
      points: [[0, 1], [1, 2]],
      sourceUnits: { frequency: "GHz", path: "rad/um" },
    }, list);

    const result = await command.run(fixture.context);

    expect(result).toMatchObject({ message: "Reference import failed: definitions unavailable", status: "failed" });
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });
});

const scopedCommands = [
  IMPORT_DISPERSION_REFERENCE_COMMAND,
  PIN_MODE_VISUALIZATION_COMMAND,
  UNPIN_POSTPROCESSING_DEFINITION_COMMAND,
];

function scopedCommandFixture(commandId: string) {
  let current = true;
  const list = vi.fn().mockResolvedValue({ definitions: [], scene_revision: 11 });
  const mutation = vi.fn().mockResolvedValue(
    commandId === UNPIN_POSTPROCESSING_DEFINITION_COMMAND
      ? { scene_revision: 13 }
      : { definition: { label: "Reference" }, scene_revision: 12 },
  );
  const invalidate = vi.fn();
  const context = {
    api: { analysis: { postprocessing: { definitions: { list, create: mutation, remove: mutation } } } },
    input: commandId === UNPIN_POSTPROCESSING_DEFINITION_COMMAND
      ? { definitionId: "pin-1" }
      : { fileName: "reference.csv", label: "Reference", points: [[0, 1], [1, 2]],
          sourceUnits: { frequency: "GHz", path: "rad/um" } },
    selection: { get: modeSelection },
    resources: { invalidate },
    sessionScopeKey: "session=owner&epoch=captured&request_scope_epoch=request",
    isCurrentSessionScope: () => current,
  };
  const command = POSTPROCESSING_DEFINITION_COMMANDS.find((candidate) => candidate.id === commandId)!;
  return { context, list, mutation, invalidate, command, expire: () => { current = false; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function expectSceneRevisionInvalidations(
  calls: readonly (readonly unknown[])[],
  sceneRevision: number,
): void {
  expect(calls).toEqual([
    [MODEL_SCENE_PATH, sceneRevision],
    [ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH, sceneRevision],
  ]);
}

describe.each(scopedCommands)("postprocessing command session scope: %s", (commandId) => {
  it("forwards the captured scope to both the read and mutation", async () => {
    const fixture = scopedCommandFixture(commandId);
    const result = await fixture.command.run(fixture.context as never);
    const options = { sessionScopeKey: fixture.context.sessionScopeKey };
    expect(result.status).toBe("completed");
    expect(fixture.list).toHaveBeenCalledExactlyOnceWith(options);
    if (commandId === UNPIN_POSTPROCESSING_DEFINITION_COMMAND) {
      expect(fixture.mutation).toHaveBeenCalledExactlyOnceWith("pin-1", { expected_scene_revision: 11 }, options);
    } else {
      expect(fixture.mutation).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ expected_scene_revision: 11 }), options,
      );
    }
    const acknowledgedSceneRevision =
      commandId === UNPIN_POSTPROCESSING_DEFINITION_COMMAND ? 13 : 12;
    expectSceneRevisionInvalidations(
      fixture.invalidate.mock.calls,
      acknowledgedSceneRevision,
    );
  });

  it("does not read or mutate after its captured session has expired", async () => {
    const fixture = scopedCommandFixture(commandId);
    fixture.expire();
    expect((await fixture.command.run(fixture.context as never)).status).toBe("cancelled");
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("does not submit a mutation when the session changes during the read", async () => {
    const fixture = scopedCommandFixture(commandId);
    const read = deferred<{ definitions: []; scene_revision: number }>();
    fixture.list.mockReturnValueOnce(read.promise);
    const result = fixture.command.run(fixture.context as never);
    expect(fixture.list).toHaveBeenCalledTimes(1);
    fixture.expire();
    read.resolve({ definitions: [], scene_revision: 11 });
    expect((await result).status).toBe("cancelled");
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("does not invalidate the new session after an old-session mutation is acknowledged", async () => {
    const fixture = scopedCommandFixture(commandId);
    const acknowledged = deferred<{ definition: { label: string }; scene_revision: number }>();
    const submitted = deferred<void>();
    fixture.mutation.mockImplementationOnce(() => {
      submitted.resolve();
      return acknowledged.promise;
    });
    const result = fixture.command.run(fixture.context as never);
    await submitted.promise;
    fixture.expire();
    acknowledged.resolve({ definition: { label: "Reference" }, scene_revision: 12 });
    expect((await result).status).toBe("cancelled");
    expect(fixture.mutation).toHaveBeenCalledTimes(1);
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });
});

it("does not create an imported reference when the session expires during SHA-256", async () => {
  const fixture = scopedCommandFixture(IMPORT_DISPERSION_REFERENCE_COMMAND);
  const digestStarted = deferred<void>();
  const digestResult = deferred<ArrayBuffer>();
  const digest = vi.fn(() => {
    digestStarted.resolve();
    return digestResult.promise;
  });
  vi.stubGlobal("crypto", { subtle: { digest } });

  try {
    const pending = fixture.command.run(fixture.context as never);
    await digestStarted.promise;
    expect(fixture.list).toHaveBeenCalledExactlyOnceWith({ sessionScopeKey: fixture.context.sessionScopeKey });
    fixture.expire();
    digestResult.resolve(new ArrayBuffer(32));

    expect((await pending).status).toBe("cancelled");
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
  } finally {
    digestResult.resolve(new ArrayBuffer(32));
    vi.unstubAllGlobals();
  }
});

function seededAuthoringHistory() {
  const before = { editor: { marker: "before" }, revision: 10 } satisfies SceneResource;
  const after = { editor: { marker: "after" }, revision: 11 } satisfies SceneResource;
  const history = new AuthoringHistoryController(
    { model: { scene: vi.fn().mockResolvedValue(after), commitTransaction: vi.fn() } },
    { invalidate: vi.fn() } as never,
  );
  history.record({ before, after, label: "Edit geometry", committedRevision: 11 });
  expect(history.canUndo()).toBe(true);
  return history;
}

describe.each(scopedCommands)("postprocessing mutation history invalidation: %s", (commandId) => {
  it("clears revision-stale undo entries after an acknowledged definition mutation", async () => {
    const fixture = scopedCommandFixture(commandId);
    const history = seededAuthoringHistory();
    const generation = history.getGeneration();
    const generationsAtInvalidation: number[] = [];
    fixture.invalidate.mockImplementation(() => {
      generationsAtInvalidation.push(history.getGeneration());
    });
    const result = await fixture.command.run({ ...fixture.context, authoringHistory: history } as never);
    expect(result.status).toBe("completed");
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.getGeneration()).toBe(generation + 1);
    const acknowledgedSceneRevision =
      commandId === UNPIN_POSTPROCESSING_DEFINITION_COMMAND ? 13 : 12;
    expectSceneRevisionInvalidations(
      fixture.invalidate.mock.calls,
      acknowledgedSceneRevision,
    );
    expect(generationsAtInvalidation).toEqual([generation + 1, generation + 1]);
  });

  it("preserves history when the mutation fails before its acknowledgement", async () => {
    const fixture = scopedCommandFixture(commandId);
    const history = seededAuthoringHistory();
    const generation = history.getGeneration();
    fixture.mutation.mockRejectedValueOnce(new Error("mutation rejected"));
    try {
      const result = await fixture.command.run({ ...fixture.context, authoringHistory: history } as never);
      expect(result.status).toBe("failed");
    } catch (error) {
      expect(error).toEqual(new Error("mutation rejected"));
    }
    expect(history.canUndo()).toBe(true);
    expect(history.getGeneration()).toBe(generation);
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });

  it("does not clear history after an acknowledgement for an obsolete session", async () => {
    const fixture = scopedCommandFixture(commandId);
    const history = seededAuthoringHistory();
    const generation = history.getGeneration();
    const acknowledgement = deferred<{ definition: { label: string }; scene_revision: number }>();
    const submitted = deferred<void>();
    fixture.mutation.mockImplementationOnce(() => {
      submitted.resolve();
      return acknowledgement.promise;
    });
    const pending = fixture.command.run({ ...fixture.context, authoringHistory: history } as never);
    await submitted.promise;
    fixture.expire();
    acknowledgement.resolve({ definition: { label: "Reference" }, scene_revision: 12 });
    expect((await pending).status).toBe("cancelled");
    expect(history.canUndo()).toBe(true);
    expect(history.getGeneration()).toBe(generation);
    expect(fixture.invalidate).not.toHaveBeenCalled();
  });
});

it("does not clear authoring history for an already pinned mode", async () => {
  const history = seededAuthoringHistory();
  const fixture = commandContext([savedModeDefinition("7")], vi.fn(), history);
  const command = pinCommand();
  if (!command) throw new Error("Pin command is not registered");
  const result = await command.run(fixture.context);
  expect(result.status).toBe("completed");
  expect(fixture.create).not.toHaveBeenCalled();
  expect(history.canUndo()).toBe(true);
  expect(fixture.invalidate).not.toHaveBeenCalled();
});
