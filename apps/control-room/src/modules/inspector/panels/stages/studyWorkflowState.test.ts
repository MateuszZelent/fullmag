import { describe, expect, it } from "vitest";

import { createDefaultStudyStageDraft } from "../StudyStageAuthoringModel";
import {
  resolveStudyWorkflowStateBefore,
  validateStudyWorkflow,
} from "./studyWorkflowState";

describe("resolveStudyWorkflowStateBefore", () => {
  it("applies visible configuration stages in order and permits Run without saving", () => {
    const firstRun = createDefaultStudyStageDraft("run", 2);
    const tableOn = createDefaultStudyStageDraft("table_autosave", 4);
    const autosaveM = createDefaultStudyStageDraft("autosave", 5);
    const fftOn = createDefaultStudyStageDraft("fft_response", 6);
    const secondRun = createDefaultStudyStageDraft("run", 7);
    const tableOff = {
      ...createDefaultStudyStageDraft("table_autosave", 8),
      tableAutosave: {
        ...createDefaultStudyStageDraft("table_autosave", 8).tableAutosave,
        enabled: false,
      },
    };
    const clearAutosave = {
      ...createDefaultStudyStageDraft("autosave", 9),
      autosave: {
        ...createDefaultStudyStageDraft("autosave", 9).autosave,
        clearAll: true,
        enabled: false,
        quantity: "",
      },
    };
    const fftOff = {
      ...createDefaultStudyStageDraft("fft_response", 10),
      fftResponse: {
        ...createDefaultStudyStageDraft("fft_response", 10).fftResponse,
        enabled: false,
      },
    };
    const thirdRun = createDefaultStudyStageDraft("run", 11);
    const drafts = [
      createDefaultStudyStageDraft("relax", 0),
      createDefaultStudyStageDraft("run", 1),
      firstRun,
      createDefaultStudyStageDraft("relax", 3),
      tableOn,
      autosaveM,
      fftOn,
      secondRun,
      tableOff,
      clearAutosave,
      fftOff,
      thirdRun,
    ];

    expect(resolveStudyWorkflowStateBefore(drafts, 2)).toMatchObject({
      fftResponse: null,
      outputs: [],
      tableAutosave: null,
    });
    expect(resolveStudyWorkflowStateBefore(drafts, 7)).toMatchObject({
      fftResponse: { sourceStageId: fftOn.stageId },
      outputs: [{ quantity: "m", sourceStageId: autosaveM.stageId }],
      tableAutosave: {
        samplePeriodS: 5e-13,
        sourceStageId: tableOn.stageId,
      },
    });
    expect(resolveStudyWorkflowStateBefore(drafts, 11)).toMatchObject({
      fftResponse: null,
      outputs: [],
      tableAutosave: null,
    });
  });

  it("disables one autosave quantity without clearing the remaining outputs", () => {
    const m = createDefaultStudyStageDraft("autosave", 0);
    const hDrive = {
      ...createDefaultStudyStageDraft("autosave", 1),
      autosave: {
        ...createDefaultStudyStageDraft("autosave", 1).autosave,
        everySeconds: "5e-13",
        quantity: "H_drive",
      },
    };
    const mOff = {
      ...createDefaultStudyStageDraft("autosave", 2),
      autosave: {
        ...createDefaultStudyStageDraft("autosave", 2).autosave,
        enabled: false,
        quantity: "m",
      },
    };

    expect(resolveStudyWorkflowStateBefore([m, hDrive, mOff], 3).outputs).toMatchObject([
      {
        everySeconds: 5e-13,
        outputKind: "field",
        quantity: "H_drive",
        sourceStageId: hDrive.stageId,
      },
    ]);
  });

  it("validates FFT clock availability, response quantities, and Nyquist at Run", () => {
    const antenna = createDefaultStudyStageDraft("add_field_drive", 0);
    const fft = createDefaultStudyStageDraft("fft_response", 1);
    const unsampledRun = createDefaultStudyStageDraft("run", 2);
    expect(validateStudyWorkflow([antenna, fft, unsampledRun])).toContainEqual({
      index: 2,
      message:
        "FFT response is ON, but no preceding Table autosave ON stage defines t_sampling.",
      severity: "error",
    });

    const table = {
      ...createDefaultStudyStageDraft("table_autosave", 1),
      tableAutosave: {
        ...createDefaultStudyStageDraft("table_autosave", 1).tableAutosave,
        samplePeriodS: "2e-11",
        tableQuantities: "t, mx, mz",
      },
    };
    const sampledRun = {
      ...createDefaultStudyStageDraft("run", 3),
      untilSeconds: "2e-9",
    };
    const issues = validateStudyWorkflow([antenna, table, fft, sampledRun]);
    expect(issues.map((issue) => issue.message)).toContain(
      "FFT response component my is missing from the active table quantities.",
    );
    expect(issues.map((issue) => issue.message)).toContain(
      "Active t_sampling violates Nyquist for antenna k0-sinc-antenna: 40000000000 Hz cutoff exceeds 25000000000 Hz Nyquist.",
    );
  });

  it("resolves automatic sampling from all sinc drives applicable to the Run", () => {
    const first = createDefaultStudyStageDraft("add_field_drive", 0);
    const secondBase = createDefaultStudyStageDraft("add_field_drive", 1);
    const run = {
      ...createDefaultStudyStageDraft("run", 3),
      stageId: "excite",
      untilSeconds: "2e-9",
    };
    const second = {
      ...secondBase,
      fieldDrive: {
        ...secondBase.fieldDrive,
        activation: { kind: "stage_ids" as const, stage_ids: [run.stageId] },
        id: "high-cutoff",
        waveform: {
          amplitude: 1,
          cutoff_hz: 5e9,
          kind: "sinc_pulse" as const,
          t0: 0,
        },
      },
    };
    const tableBase = createDefaultStudyStageDraft("table_autosave", 2);
    const table = {
      ...tableBase,
      tableAutosave: {
        ...tableBase.tableAutosave,
        samplingMode: "auto_sinc_cutoff" as const,
      },
    };

    const state = resolveStudyWorkflowStateBefore([first, second, table, run], 3);
    expect(state.tableAutosave).toMatchObject({
      autoSampling: {
        maximumCutoffHz: 40e9,
        nyquistGuardFactor: 1.3,
        status: "ready",
      },
      samplePeriodS: 1 / (2 * 1.3 * 40e9),
      samplingMode: "auto_sinc_cutoff",
      sourceDriveIds: ["k0-sinc-antenna", "high-cutoff"],
    });
  });

  it("fails closed when automatic sampling has no active sinc drive for the Run", () => {
    const tableBase = createDefaultStudyStageDraft("table_autosave", 0);
    const table = {
      ...tableBase,
      tableAutosave: {
        ...tableBase.tableAutosave,
        samplingMode: "auto_sinc_cutoff" as const,
      },
    };
    const run = createDefaultStudyStageDraft("run", 1);

    const state = resolveStudyWorkflowStateBefore([table, run], 1);
    expect(state.tableAutosave).toMatchObject({
      autoSampling: { status: "unresolved" },
      samplePeriodS: null,
    });
    expect(validateStudyWorkflow([table, run])).toContainEqual({
      index: 1,
      message:
        "Automatic sampling is unresolved: no active sinc drive with a finite positive cutoff applies to this Run.",
      severity: "error",
    });
  });

  it("blocks an automatic field output without an applicable sinc drive", () => {
    const outputBase = createDefaultStudyStageDraft("autosave", 0);
    const output = {
      ...outputBase,
      autosave: {
        ...outputBase.autosave,
        samplingMode: "auto_sinc_cutoff" as const,
      },
    };
    const run = createDefaultStudyStageDraft("run", 1);

    expect(validateStudyWorkflow([output, run])).toContainEqual({
      index: 1,
      message:
        "Automatic sampling for output m is unresolved: no active sinc drive with a finite positive cutoff applies to this Run.",
      severity: "error",
    });
  });
});
