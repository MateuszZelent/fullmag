"use client";

import { useMemo } from "react";

import type { RegionalFieldDriveResource } from "@/kernel/api/apiTypes";
import {
  milliTeslaToTesla,
  teslaToMilliTesla,
} from "@/shared/domain/physics/fieldDrive";
import { buildSincPulsePreview } from "@/shared/domain/physics/sincPulsePreview";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import {
  regionalFieldDriveSelectorOptions,
} from "../RegionalFieldDrivePanelModel";
import { SincPulsePreview } from "../SincPulsePreview";
import {
  StageInspectorFrame,
  type StageInspectorFrameProps,
} from "./StageInspectorFrame";

export function AddFieldDriveStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft;
  const drive = draft?.kind === "add_field_drive" ? draft.fieldDrive : null;
  const selectorOptions = useMemo(
    () => regionalFieldDriveSelectorOptions(props.scene ?? null),
    [props.scene],
  );
  const subsequentRuns = (props.pipelineDrafts ?? [])
    .slice(props.draftIndex + 1)
    .filter((candidate) => candidate.kind === "run");
  const samplingRun = drive?.activation.kind === "stage_ids"
    ? subsequentRuns.find((candidate) =>
        drive.activation.kind === "stage_ids" &&
        drive.activation.stage_ids.includes(candidate.stageId),
      ) ?? null
    : subsequentRuns[0] ?? null;
  const samplePeriodS = samplingRun?.runSampling.tableAutosaveEnabled
    ? positiveNumber(samplingRun.runSampling.samplePeriodS)
    : null;
  const durationS = positiveNumber(samplingRun?.untilSeconds);
  const solverDtS = samplingRun?.timestepMode === "fixed"
    ? positiveNumber(samplingRun.dt)
    : null;
  const preview = drive?.waveform.kind === "sinc_pulse"
    ? buildSincPulsePreview({
        cutoffHz: drive.waveform.cutoff_hz,
        durationS,
        fieldAmplitudeT: drive.amplitude_B_T,
        samplePeriodS,
        t0S: drive.waveform.t0 ?? 0,
        waveformAmplitude: drive.waveform.amplitude ?? 1,
      })
    : null;

  function setDrive(next: RegionalFieldDriveResource): void {
    props.onUpdateDraft({ fieldDrive: next });
  }

  function updateDrive(
    update: (current: RegionalFieldDriveResource) => RegionalFieldDriveResource,
  ): void {
    if (drive) setDrive(update(drive));
  }

  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="add_field_drive"
        kindLabel="Add Antenna"
      />
      <InspectorSection
        value="add-field-drive"
        title="Regional Field Drive"
        badge="configuration instruction"
      >
        <FieldRow label="Physical duration" value="0 s" />
        <FieldRow
          label="State handoff"
          value="continue in place; preserve relaxed magnetization and domain"
        />
        <label className="fm-inspector-field">
          <span>Drive ID</span>
          <input
            className="fm-inspector-input"
            disabled={!drive}
            value={drive?.id ?? ""}
            onChange={(event) =>
              updateDrive((current) => ({ ...current, id: event.target.value }))
            }
          />
        </label>
        <label className="fm-inspector-field">
          <span>Name</span>
          <input
            className="fm-inspector-input"
            disabled={!drive}
            value={drive?.name ?? ""}
            onChange={(event) =>
              updateDrive((current) => ({ ...current, name: event.target.value }))
            }
          />
        </label>
        <label className="fm-inspector-field">
          <span>Enabled</span>
          <input
            checked={drive?.enabled ?? false}
            disabled={!drive}
            type="checkbox"
            onChange={(event) =>
              updateDrive((current) => ({
                ...current,
                enabled: event.target.checked,
              }))
            }
          />
        </label>
        <label className="fm-inspector-field">
          <span>Amplitude (mT)</span>
          <input
            className="fm-inspector-input"
            disabled={!drive}
            min="0"
            step="0.001"
            type="number"
            value={drive ? teslaToMilliTesla(drive.amplitude_B_T) : ""}
            onChange={(event) =>
              updateDrive((current) => ({
                ...current,
                amplitude_B_T: milliTeslaToTesla(Number(event.target.value)),
              }))
            }
          />
        </label>
        <label className="fm-inspector-field">
          <span>Direction (x, y, z)</span>
          <div className="fm-inspector-vector-row">
            {[0, 1, 2].map((index) => (
              <input
                className="fm-inspector-input"
                disabled={!drive}
                key={index}
                step="0.01"
                type="number"
                value={drive?.direction[index] ?? 0}
                onChange={(event) =>
                  updateDrive((current) => {
                    const direction = [...current.direction];
                    direction[index] = Number(event.target.value);
                    return { ...current, direction };
                  })
                }
              />
            ))}
          </div>
        </label>
        <label className="fm-inspector-field">
          <span>Target</span>
          <select
            className="fm-inspector-input"
            disabled={!drive}
            value={drive?.target.kind ?? "global"}
            onChange={(event) =>
              updateDrive((current) => ({
                ...current,
                target:
                  event.target.value === "object"
                    ? { kind: "object", object_id: "" }
                    : event.target.value === "region"
                      ? { kind: "region", object_id: "", region_id: "" }
                      : { kind: "global" },
              }))
            }
          >
            <option value="global">Global domain</option>
            <option value="object">Object</option>
            <option value="region">Stable region</option>
          </select>
        </label>
        {drive && drive.target.kind !== "global" ? (
          <label className="fm-inspector-field">
            <span>Object</span>
            <select
              className="fm-inspector-input"
              value={drive.target.object_id}
              onChange={(event) =>
                updateDrive((current) => {
                  if (current.target.kind === "global") return current;
                  return {
                    ...current,
                    target: current.target.kind === "region"
                      ? {
                          ...current.target,
                          object_id: event.target.value,
                          region_id: "",
                        }
                      : { ...current.target, object_id: event.target.value },
                  };
                })
              }
            >
              <option value="">Select an object</option>
              {selectorOptions.objects.map((object) => (
                <option key={object.id} value={object.id}>{object.label}</option>
              ))}
            </select>
          </label>
        ) : null}
        {drive?.target.kind === "region" ? (
          <label className="fm-inspector-field">
            <span>Stable region</span>
            <select
              className="fm-inspector-input"
              value={drive.target.region_id}
              onChange={(event) =>
                updateDrive((current) =>
                  current.target.kind === "region"
                    ? {
                        ...current,
                        target: { ...current.target, region_id: event.target.value },
                      }
                    : current,
                )
              }
            >
              <option value="">Select a region</option>
              {(selectorOptions.regionsByObject[drive.target.object_id] ?? []).map(
                (region) => (
                  <option key={region.id} value={region.id}>{region.label}</option>
                ),
              )}
            </select>
          </label>
        ) : null}
        <label className="fm-inspector-field">
          <span>Spatial profile</span>
          <select
            className="fm-inspector-input"
            disabled={!drive}
            value={drive?.spatial_profile.kind ?? "uniform"}
            onChange={(event) =>
              updateDrive((current) => ({
                ...current,
                spatial_profile:
                  event.target.value === "sinc"
                    ? defaultSpatialSinc()
                    : event.target.value === "geometry_mask"
                      ? {
                          envelope: { kind: "uniform" },
                          kind: "geometry_mask",
                          object_id: "",
                        }
                      : { kind: "uniform" },
              }))
            }
          >
            <option value="uniform">Uniform</option>
            <option value="sinc">Spatial sinc</option>
            <option value="geometry_mask">Geometry mask</option>
          </select>
        </label>
        {drive?.spatial_profile.kind === "sinc" ? (
          <SpatialSincFields
            profile={drive.spatial_profile}
            onChange={(profile) =>
              updateDrive((current) => ({ ...current, spatial_profile: profile }))
            }
          />
        ) : null}
        {drive?.spatial_profile.kind === "geometry_mask" ? (
          <>
            <label className="fm-inspector-field">
              <span>Mask geometry</span>
              <select
                className="fm-inspector-input"
                value={drive.spatial_profile.object_id}
                onChange={(event) =>
                  updateDrive((current) =>
                    current.spatial_profile.kind === "geometry_mask"
                      ? {
                          ...current,
                          spatial_profile: {
                            ...current.spatial_profile,
                            object_id: event.target.value,
                          },
                        }
                      : current,
                  )
                }
              >
                <option value="">Select an object</option>
                {selectorOptions.objects.map((object) => (
                  <option key={object.id} value={object.id}>{object.label}</option>
                ))}
              </select>
            </label>
            <label className="fm-inspector-field">
              <span>Envelope</span>
              <select
                className="fm-inspector-input"
                value={drive.spatial_profile.envelope.kind}
                onChange={(event) =>
                  updateDrive((current) =>
                    current.spatial_profile.kind === "geometry_mask"
                      ? {
                          ...current,
                          spatial_profile: {
                            ...current.spatial_profile,
                            envelope:
                              event.target.value === "sinc"
                                ? defaultSpatialSinc()
                                : { kind: "uniform" },
                          },
                        }
                      : current,
                  )
                }
              >
                <option value="uniform">Uniform</option>
                <option value="sinc">Spatial sinc</option>
              </select>
            </label>
            {drive.spatial_profile.envelope.kind === "sinc" ? (
              <SpatialSincFields
                profile={drive.spatial_profile.envelope}
                onChange={(envelope) =>
                  updateDrive((current) =>
                    current.spatial_profile.kind === "geometry_mask"
                      ? {
                          ...current,
                          spatial_profile: {
                            ...current.spatial_profile,
                            envelope,
                          },
                        }
                      : current,
                  )
                }
              />
            ) : null}
          </>
        ) : null}
      </InspectorSection>

      <InspectorSection
        value="add-field-waveform"
        title="Waveform & Source FFT"
        badge={drive?.waveform.kind ?? "not configured"}
      >
        <label className="fm-inspector-field">
          <span>Function in time</span>
          <select
            className="fm-inspector-input"
            disabled={!drive}
            value={drive?.waveform.kind ?? "constant"}
            onChange={(event) =>
              updateDrive((current) => ({
                ...current,
                waveform: defaultWaveform(event.target.value),
              }))
            }
          >
            <option value="constant">Constant</option>
            <option value="sinusoidal">Sinusoidal</option>
            <option value="pulse">Rectangular pulse</option>
            <option value="piecewise_linear">Piecewise linear</option>
            <option value="sinc_pulse">Sinc pulse</option>
          </select>
        </label>
        <label className="fm-inspector-field">
          <span>Time origin</span>
          <select
            className="fm-inspector-input"
            disabled={!drive}
            value={drive?.time_origin ?? "stage_local"}
            onChange={(event) =>
              updateDrive((current) => ({
                ...current,
                time_origin: event.target.value as "absolute" | "stage_local",
              }))
            }
          >
            <option value="stage_local">Stage local</option>
            <option value="absolute">Absolute simulation time</option>
          </select>
        </label>
        {drive?.waveform.kind === "sinc_pulse" ? (
          <>
            <FieldRow label="Definition" value="a sinc(2 fc (t - t0))" />
            <label className="fm-inspector-field">
              <span>Cutoff fc (Hz)</span>
              <input
                className="fm-inspector-input"
                min="0"
                type="number"
                value={drive.waveform.cutoff_hz}
                onChange={(event) =>
                  updateDrive((current) =>
                    current.waveform.kind === "sinc_pulse"
                      ? {
                          ...current,
                          waveform: {
                            ...current.waveform,
                            cutoff_hz: Number(event.target.value),
                          },
                        }
                      : current,
                  )
                }
              />
            </label>
            <label className="fm-inspector-field">
              <span>Center t0 (s)</span>
              <input
                className="fm-inspector-input"
                type="number"
                value={drive.waveform.t0 ?? 0}
                onChange={(event) =>
                  updateDrive((current) =>
                    current.waveform.kind === "sinc_pulse"
                      ? {
                          ...current,
                          waveform: {
                            ...current.waveform,
                            t0: Number(event.target.value),
                          },
                        }
                      : current,
                  )
                }
              />
            </label>
            <label className="fm-inspector-field">
              <span>Waveform amplitude a</span>
              <input
                className="fm-inspector-input"
                type="number"
                value={drive.waveform.amplitude ?? 1}
                onChange={(event) =>
                  updateDrive((current) =>
                    current.waveform.kind === "sinc_pulse"
                      ? {
                          ...current,
                          waveform: {
                            ...current.waveform,
                            amplitude: Number(event.target.value),
                          },
                        }
                      : current,
                  )
                }
              />
            </label>
            {preview ? (
              <SincPulsePreview model={preview} solverDtS={solverDtS} />
            ) : null}
          </>
        ) : null}
        {drive?.waveform.kind === "sinusoidal" ? (
          <>
            <NumberField
              label="Frequency (Hz)"
              value={drive.waveform.frequency_hz}
              onChange={(value) =>
                updateDrive((current) =>
                  current.waveform.kind === "sinusoidal"
                    ? {
                        ...current,
                        waveform: { ...current.waveform, frequency_hz: value },
                      }
                    : current,
                )
              }
            />
            <NumberField
              label="Phase (rad)"
              value={drive.waveform.phase_rad ?? 0}
              onChange={(value) =>
                updateDrive((current) =>
                  current.waveform.kind === "sinusoidal"
                    ? {
                        ...current,
                        waveform: { ...current.waveform, phase_rad: value },
                      }
                    : current,
                )
              }
            />
            <NumberField
              label="Offset"
              value={drive.waveform.offset ?? 0}
              onChange={(value) =>
                updateDrive((current) =>
                  current.waveform.kind === "sinusoidal"
                    ? {
                        ...current,
                        waveform: { ...current.waveform, offset: value },
                      }
                    : current,
                )
              }
            />
          </>
        ) : null}
        {drive?.waveform.kind === "pulse" ? (
          <>
            <NumberField
              label="On time (s)"
              value={drive.waveform.t_on}
              onChange={(value) =>
                updateDrive((current) =>
                  current.waveform.kind === "pulse"
                    ? { ...current, waveform: { ...current.waveform, t_on: value } }
                    : current,
                )
              }
            />
            <NumberField
              label="Off time (s)"
              value={drive.waveform.t_off}
              onChange={(value) =>
                updateDrive((current) =>
                  current.waveform.kind === "pulse"
                    ? { ...current, waveform: { ...current.waveform, t_off: value } }
                    : current,
                )
              }
            />
          </>
        ) : null}
        {drive?.waveform.kind === "piecewise_linear" ? (
          <label className="fm-inspector-field">
            <span>Points (time, value; one pair per line)</span>
            <textarea
              className="fm-inspector-input"
              rows={5}
              value={drive.waveform.points.map((point) => point.join(", ")).join("\n")}
              onChange={(event) => {
                const points = event.target.value
                  .split(/\n+/)
                  .map((line) => line.split(/[ ,;]+/).filter(Boolean).map(Number))
                  .filter((point) => point.length === 2);
                updateDrive((current) =>
                  current.waveform.kind === "piecewise_linear"
                    ? { ...current, waveform: { ...current.waveform, points } }
                    : current,
                );
              }}
            />
          </label>
        ) : null}
      </InspectorSection>

      <InspectorSection
        value="add-field-activation"
        title="Activation & State Handoff"
        badge={samplingRun?.stageId ?? "no following run"}
      >
        <label className="fm-inspector-field">
          <span>Activation</span>
          <select
            className="fm-inspector-input"
            disabled={!drive}
            value={drive?.activation.kind ?? "all_time_evolution"}
            onChange={(event) =>
              updateDrive((current) => ({
                ...current,
                activation:
                  event.target.value === "stage_ids"
                    ? { kind: "stage_ids", stage_ids: [] }
                    : { kind: "all_time_evolution" },
              }))
            }
          >
            <option value="all_time_evolution">All following time stages</option>
            <option value="stage_ids">Selected following runs</option>
          </select>
        </label>
        {drive?.activation.kind === "stage_ids" ? (
          <fieldset className="fm-inspector-field">
            <legend>Following Run stages</legend>
            {subsequentRuns.map((run) => (
              <label key={run.stageId}>
                <input
                  checked={drive.activation.kind === "stage_ids" && drive.activation.stage_ids.includes(run.stageId)}
                  type="checkbox"
                  onChange={(event) =>
                    updateDrive((current) => {
                      if (current.activation.kind !== "stage_ids") return current;
                      const stageIds = event.target.checked
                        ? [...current.activation.stage_ids, run.stageId]
                        : current.activation.stage_ids.filter((id) => id !== run.stageId);
                      return {
                        ...current,
                        activation: { kind: "stage_ids", stage_ids: stageIds },
                      };
                    })
                  }
                /> {run.stageId}
              </label>
            ))}
          </fieldset>
        ) : (
          <FieldRow label="Scope" value="all Run instructions after this action" />
        )}
        <FieldRow label="FFT sampling source" value={samplingRun?.stageId ?? "preview clock"} />
        <FieldRow
          label="Response t_sampling"
          value={samplePeriodS ?? "not declared in following Run"}
          unit={samplePeriodS ? "s" : undefined}
        />
        {subsequentRuns.length === 0 ? (
          <FeedbackBanner
            kind="warning"
            message="Add a following Run instruction. The antenna changes configuration but time integration starts only in that next action."
          />
        ) : null}
      </InspectorSection>
    </>
  );
}

type SpatialSincProfile = Extract<
  RegionalFieldDriveResource["spatial_profile"],
  { kind: "sinc" }
>;

function SpatialSincFields({
  profile,
  onChange,
}: {
  profile: SpatialSincProfile;
  onChange: (profile: SpatialSincProfile) => void;
}) {
  return (
    <>
      <label className="fm-inspector-field">
        <span>Spatial axis (x, y, z)</span>
        <div className="fm-inspector-vector-row">
          {[0, 1, 2].map((index) => (
            <input
              className="fm-inspector-input"
              key={index}
              step="0.01"
              type="number"
              value={profile.axis[index] ?? 0}
              onChange={(event) => {
                const axis = [...profile.axis];
                axis[index] = Number(event.target.value);
                onChange({ ...profile, axis });
              }}
            />
          ))}
        </div>
      </label>
      <NumberField
        label="Spatial period (m)"
        value={profile.period_m}
        onChange={(period_m) => onChange({ ...profile, period_m })}
      />
      <NumberField
        label="Spatial center (m)"
        value={profile.center_m ?? 0}
        onChange={(center_m) => onChange({ ...profile, center_m })}
      />
      <label className="fm-inspector-field">
        <span>Spatial width (m, optional)</span>
        <input
          className="fm-inspector-input"
          type="number"
          value={profile.width_m ?? ""}
          onChange={(event) =>
            onChange({
              ...profile,
              width_m: event.target.value ? Number(event.target.value) : null,
            })
          }
        />
      </label>
      <label className="fm-inspector-field">
        <span>Window</span>
        <select
          className="fm-inspector-input"
          value={profile.window ?? "none"}
          onChange={(event) => onChange({ ...profile, window: event.target.value })}
        >
          <option value="none">None</option>
          <option value="hann">Hann</option>
        </select>
      </label>
    </>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="fm-inspector-field">
      <span>{label}</span>
      <input
        className="fm-inspector-input"
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function defaultSpatialSinc(): SpatialSincProfile {
  return {
    axis: [1, 0, 0],
    center_m: 0,
    kind: "sinc",
    period_m: 1e-7,
    window: "none",
  };
}

function defaultWaveform(
  kind: string,
): RegionalFieldDriveResource["waveform"] {
  if (kind === "sinusoidal") {
    return { frequency_hz: 1e9, kind: "sinusoidal", offset: 0, phase_rad: 0 };
  }
  if (kind === "pulse") return { kind: "pulse", t_off: 1e-9, t_on: 0 };
  if (kind === "piecewise_linear") {
    return { kind: "piecewise_linear", points: [[0, 0], [1e-9, 1]] };
  }
  if (kind === "sinc_pulse") {
    return { amplitude: 1, cutoff_hz: 40e9, kind: "sinc_pulse", t0: 50e-12 };
  }
  return { kind: "constant" };
}

function positiveNumber(value: string | number | null | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
