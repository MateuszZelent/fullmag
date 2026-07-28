import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_STAGE_AUTOSAVE_DRAFT,
  stageAutosaveDraftFromValue,
  stageAutosaveDraftToValue,
  validateStageAutosaveDraft,
} from "../StageAutosaveDraft";
import {
  createDefaultStudyStageDraft,
  studyStageDraftToSceneStage,
} from "../StudyStageAuthoringModel";
import { StageAutosaveSection } from "./StageAutosaveSection";

describe("StageAutosaveSection", () => {
  it("defaults to disabled continuous Zarr storage on target main", () => {
    expect(DEFAULT_STAGE_AUTOSAVE_DRAFT).toMatchObject({
      enabled: false,
      fields: [],
      format: "zarr",
      layout: "continuous",
      target: "main",
    });
    const html = renderToStaticMarkup(
      <StageAutosaveSection
        draft={DEFAULT_STAGE_AUTOSAVE_DRAFT}
        owner="relax"
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("Stage autosave");
    expect(html).toContain("type=\"checkbox\"");
    expect(html).not.toContain("Add field");
  });

  it("renders target, layout, format, quantities, cadence and multiple fields", () => {
    const html = renderToStaticMarkup(
      <StageAutosaveSection
        owner="run"
        onChange={() => undefined}
        draft={{
          ...DEFAULT_STAGE_AUTOSAVE_DRAFT,
          enabled: true,
          fields: [
            { cadence: "2e-12", quantity: "m" },
            { cadence: "4e-12", quantity: "H_demag" },
          ],
          format: "hdf5",
          layout: "separate",
          tableCadence: "1e-12",
          target: "reversal",
        }}
      />,
    );
    for (const text of ["reversal", "Separate per stage", "HDF5", "Table quantities", "H_demag", "Add field"]) {
      expect(html).toContain(text);
    }
  });

  it("round-trips Relax accepted-step and Run physical-time cadence", () => {
    const relax = stageAutosaveDraftFromValue({
      fields: [{ quantity: "m", every_steps: 20 }],
      format: "zarr",
      layout: "continuous",
      table: { every_steps: 10, quantities: ["step", "mx"] },
      target: "main",
    }, "relax");
    expect(stageAutosaveDraftToValue(relax, "relax")).toEqual({
      fields: [{ every_steps: 20, kind: "field_autosave", quantity: "m" }],
      format: "zarr",
      kind: "stage_autosave",
      layout: "continuous",
      table: {
        every_steps: 10,
        kind: "table_autosave",
        quantities: ["step", "mx"],
        table_id: "default",
      },
      target: "main",
    });

    const run = stageAutosaveDraftFromValue({
      fields: [{ quantity: "m", every_seconds: 2e-12 }],
      format: "hdf5",
      layout: "separate",
      table: { sample_period_s: 1e-12, quantities: ["step", "t"] },
      target: "reversal",
    }, "run");
    expect(stageAutosaveDraftToValue(run, "run")).toMatchObject({
      fields: [{ every_seconds: 2e-12, quantity: "m" }],
      table: { sample_period_s: 1e-12 },
    });
  });

  it("rejects TXT fields and emits exact stage-local transaction JSON", () => {
    const draft = createDefaultStudyStageDraft("run", 0);
    draft.untilSeconds = "4e-12";
    draft.stageAutosave = {
      ...DEFAULT_STAGE_AUTOSAVE_DRAFT,
      enabled: true,
      fields: [{ cadence: "2e-12", quantity: "m" }],
      format: "hdf5",
      layout: "separate",
      tableCadence: "1e-12",
      tableQuantities: "step, t, mx",
      target: "reversal",
    };
    expect(studyStageDraftToSceneStage(draft)).toEqual({
      autosave: {
        fields: [{ every_seconds: 2e-12, kind: "field_autosave", quantity: "m" }],
        format: "hdf5",
        kind: "stage_autosave",
        layout: "separate",
        table: {
          kind: "table_autosave",
          quantities: ["step", "t", "mx"],
          sample_period_s: 1e-12,
          table_id: "default",
        },
        target: "reversal",
      },
      entrypoint_kind: "flat_run",
      kind: "run",
      stage_id: "run-1",
      until_seconds: 4e-12,
    });
    expect(validateStageAutosaveDraft({ ...draft.stageAutosave, format: "txt" }, "run"))
      .toContain("TXT autosave supports scalar tables only; remove field outputs or choose Zarr/HDF5.");
  });
});
