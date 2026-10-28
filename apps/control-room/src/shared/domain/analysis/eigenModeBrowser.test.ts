import { describe, expect, it } from "vitest";
import type { FrequencyDomainJsonArtifactResource } from "@/kernel/api/apiTypes";
import { buildEigenModeBrowser, modePickerPage, MODE_PICKER_PAGE_SIZE } from "./eigenModeBrowser";

const spectrum = { status: "ready", schema_version: "eigen_spectrum.v2", artifact_path: "eigen/spectrum.v2.json", missing_reason: null,
 run_id: "run-a", stage_id: "eigen", revision: "revision-a", payload: { samples: [
  { sample_index: 7, sample_id: "gamma", path_s: 25e6, modes: [
    { raw_mode_index: 8, frequency_hz: 9e9, k_vector: [0,0,0], mode_id: "gamma-8" },
    { raw_mode_index: 3, frequency_hz: 9e9, k_vector: [0,0,0], mode_id: "gamma-3" } ] },
  { sample_index: 2, sample_id: "negative", path_s: 0, modes: [{ raw_mode_index: 0, frequency_hz: 11e9, k_vector: [0,-10e6,0], mode_id: "negative-0" }] },
 ] } } as FrequencyDomainJsonArtifactResource;

describe("mode browser", () => {
 it("keeps k coordinates, raw indices and degenerate modes separately addressable", () => {
  const data = buildEigenModeBrowser(spectrum, null);
  expect(data.samples.map(s=>s.index)).toEqual([2,7]);
  expect(data.samples[0].label).toBe("kᵧ = -10 rad/µm");
  expect(data.samples[1].label).toBe("Γ · k = 0");
  expect(new Set(data.samples[1].modes.map(m=>m.frequencyLabel)).size).toBe(2);
  const ref=data.samples[1].modes[0].selection.ref;
  expect(ref).toMatchObject({analysisRunId:"run-a",analysisStageId:"eigen",artifactRevision:"revision-a",sampleIndex:7,modeIndex:8,wavevectorKf:[0,0,0]});
  expect(ref).toMatchObject({ kPathCoordinateRadPerM: 25e6 });
  expect(data.samples[0].modes[0].selection.ref).toMatchObject({ kPathCoordinateRadPerM: 0 });
  expect(ref).not.toHaveProperty("fieldId");
  expect(ref).not.toHaveProperty("equilibriumId");
 });
 it("bounds hundreds of choices and keeps search independent of the previous page", () => {
  const items=Array.from({length:601},(_,i)=>({value:String(i),label:`frequency ${i}`}));
  expect(modePickerPage(items,"",0).items).toHaveLength(MODE_PICKER_PAGE_SIZE);
  expect(modePickerPage(items,"",1).items[0].value).toBe("32");
  expect(modePickerPage(items,"frequency 600",18)).toMatchObject({current:0,count:1,pages:1});
  expect(modePickerPage(items,"missing",18).items).toEqual([]);
 });
});
