"use client";

import { useMemo, useState, useSyncExternalStore } from "react";

import type { RegionalFieldDriveResource } from "@/kernel/api/apiTypes";
import { Button } from "@/shared/ui/Button";
import {
  milliTeslaToTesla,
  teslaToMilliTesla,
} from "@/shared/domain/physics/fieldDrive";
import { buildSincPulsePreview } from "@/shared/domain/physics/sincPulsePreview";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { QuantityFieldDraftScope } from "../../primitives/QuantityField";
import {
  createQuantityFieldDraftStore,
  EMPTY_QUANTITY_FIELD_DRAFT_SUMMARY,
  type QuantityFieldDraftStore,
} from "../../primitives/quantityFieldDraftStore";
import {
  regionalFieldDriveSamplingContext,
  regionalFieldDriveSelectorOptions,
} from "../RegionalFieldDrivePanelModel";
import { SincPulsePreview } from "../SincPulsePreview";
import {
  StageInspectorFrame,
  type StageInspectorFrameProps,
} from "./StageInspectorFrame";
import {
  StageNumberField,
  StageNumberTextarea,
  StageOptionalNumberField,
} from "./StageNumericDraftFields";
import { SamplingDiagnostics } from "./SamplingDiagnostics";
import { resolveStudyWorkflowStateBefore } from "./studyWorkflowState";

const AXES = ["x", "y", "z"] as const;

type AddFieldDriveStageInspectorProps = StageInspectorFrameProps & {
  numericDraftStore?: QuantityFieldDraftStore;
};

export function AddFieldDriveStageInspector(
  props: AddFieldDriveStageInspectorProps,
) {
  const [ownedNumericDraftStore] = useState(createQuantityFieldDraftStore);
  const numericDraftStore = props.numericDraftStore ?? ownedNumericDraftStore;
  const numericDraftSummary = useSyncExternalStore(
    numericDraftStore.subscribe,
    numericDraftStore.getSummary,
    () => EMPTY_QUANTITY_FIELD_DRAFT_SUMMARY,
  );
  const validation =
    numericDraftSummary.pendingCount === 0
      ? props.validation
      : [
          ...props.validation,
          {
            message: numericDraftSummary.invalidLabels[0]
              ? `Finish ${numericDraftSummary.invalidLabels[0]} before applying.`
              : "Commit pending numeric inputs before applying.",
            severity: "error" as const,
          },
        ];
  const draft = props.draft;
  const drive = draft?.kind === "add_field_drive" ? draft.fieldDrive : null;
  const selectorOptions = useMemo(
    () => regionalFieldDriveSelectorOptions(props.scene ?? null),
    [props.scene],
  );
  const solverDtS = useMemo(
    () => regionalFieldDriveSamplingContext(
      props.scene ?? null,
      drive?.activation ?? null,
    ).solverDtS,
    [drive?.activation, props.scene],
  );
  const pipelineDrafts = props.pipelineDrafts ?? [];
  const activeStageIds = useMemo(
    () => new Set(drive?.activation.kind === "stage_ids" ? drive.activation.stage_ids : []),
    [drive],
  );
  const subsequentRuns = pipelineDrafts
    .map((candidate, index) => ({ candidate, index }))
    .slice(props.draftIndex + 1)
    .filter(({ candidate }) => candidate.kind === "run");
  const samplingRunEntry = drive?.activation.kind === "stage_ids"
    ? subsequentRuns.find(({ candidate }) =>
        drive.activation.kind === "stage_ids" &&
        activeStageIds.has(candidate.stageId),
      ) ?? null
    : subsequentRuns[0] ?? null;
  const samplingRun = samplingRunEntry?.candidate ?? null;
  const effectiveWorkflow = samplingRunEntry
    ? resolveStudyWorkflowStateBefore(pipelineDrafts, samplingRunEntry.index)
    : null;
  const samplePeriodS = effectiveWorkflow?.tableAutosave?.samplePeriodS ?? null;
  const durationS = positiveNumber(samplingRun?.untilSeconds);
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

  function commitStageIfReady(): void {
    if (numericDraftStore.getSummary().pendingCount > 0) return;
    props.onCommit();
  }

  const content = (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="add_field_drive"
        kindLabel="Add Field Drive"
        onCommit={commitStageIfReady}
        validation={validation}
      />
      {numericDraftSummary.pendingCount > 0 ? (
        <div className="fm-inspector-field-draft-notice" role="status">
          <FeedbackBanner
            kind="warning"
            message={
              numericDraftSummary.pendingCount +
              " numeric input" +
              (numericDraftSummary.pendingCount === 1 ? " is" : "s are") +
              " still pending. Commit each value with Enter or blur, or discard the pending inputs before applying."
            }
          />
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => numericDraftStore.clear()}
          >
            Discard pending inputs
          </Button>
        </div>
      ) : null}
      <InspectorGroup
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
        <StageNumberField
          disabled={!drive}
          draftKey="fieldDrive.amplitude_B_T"
          label="Amplitude"
          unit="mT"
          value={drive ? teslaToMilliTesla(drive.amplitude_B_T) : 0}
          onCommit={(value) =>
            updateDrive((current) => ({
              ...current,
              amplitude_B_T: milliTeslaToTesla(value),
            }))
          }
        />
        <fieldset className="fm-inspector-field">
          <legend>Direction (x, y, z)</legend>
          <div className="fm-inspector-vector-row">
            {AXES.map((axis, index) => (
              <StageNumberField
                key={axis}
                disabled={!drive}
                draftKey={"fieldDrive.direction." + axis}
                label={"Direction " + axis}
                value={drive?.direction[index] ?? 0}
                onCommit={(value) =>
                  updateDrive((current) => {
                    const direction = [...current.direction];
                    direction[index] = value;
                    return { ...current, direction };
                  })
                }
              />
            ))}
          </div>
        </fieldset>
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
            draftKeyPrefix="spatial_profile.sinc."
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
                draftKeyPrefix="spatial_profile.geometry_mask.envelope.sinc."
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
      </InspectorGroup>

      <InspectorGroup
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
            <StageNumberField
              draftKey="waveform.sinc_pulse.cutoff_hz"
              label="Cutoff fc"
              unit="Hz"
              value={drive.waveform.cutoff_hz}
              onCommit={(value) =>
                updateDrive((current) =>
                  current.waveform.kind === "sinc_pulse"
                    ? {
                        ...current,
                        waveform: {
                          ...current.waveform,
                          cutoff_hz: value,
                        },
                      }
                    : current,
                )
              }
            />
            <StageNumberField
              draftKey="waveform.sinc_pulse.t0"
              label="Center t0"
              unit="s"
              value={drive.waveform.t0 ?? 0}
              onCommit={(value) =>
                updateDrive((current) =>
                  current.waveform.kind === "sinc_pulse"
                    ? {
                        ...current,
                        waveform: {
                          ...current.waveform,
                          t0: value,
                        },
                      }
                    : current,
                )
              }
            />
            <StageNumberField
              draftKey="waveform.sinc_pulse.amplitude"
              label="Waveform amplitude a"
              value={drive.waveform.amplitude ?? 1}
              onCommit={(value) =>
                  updateDrive((current) =>
                    current.waveform.kind === "sinc_pulse"
                      ? {
                          ...current,
                          waveform: {
                            ...current.waveform,
                          amplitude: value,
                          },
                        }
                      : current,
                  )
              }
            />
            {preview ? (
              <>
                <FieldRow
                  label="Effective t_sampling source"
                  value={
                    effectiveWorkflow?.tableAutosave?.sourceStageId ??
                    "no Table autosave ON stage before the target Run"
                  }
                />
                <SincPulsePreview model={preview} solverDtS={solverDtS} />
                <SamplingDiagnostics
                  durationS={durationS}
                  sampling={effectiveWorkflow?.tableAutosave ?? null}
                />
              </>
            ) : null}
          </>
        ) : null}
        {drive?.waveform.kind === "sinusoidal" ? (
          <>
            <StageNumberField
              draftKey="waveform.sinusoidal.frequency_hz"
              label="Frequency (Hz)"
              value={drive.waveform.frequency_hz}
              onCommit={(value) =>
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
            <StageNumberField
              draftKey="waveform.sinusoidal.phase_rad"
              label="Phase (rad)"
              value={drive.waveform.phase_rad ?? 0}
              onCommit={(value) =>
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
            <StageNumberField
              draftKey="waveform.sinusoidal.offset"
              label="Offset"
              value={drive.waveform.offset ?? 0}
              onCommit={(value) =>
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
            <StageNumberField
              draftKey="waveform.pulse.t_on"
              label="On time (s)"
              value={drive.waveform.t_on}
              onCommit={(value) =>
                updateDrive((current) =>
                  current.waveform.kind === "pulse"
                    ? { ...current, waveform: { ...current.waveform, t_on: value } }
                    : current,
                )
              }
            />
            <StageNumberField
              draftKey="waveform.pulse.t_off"
              label="Off time (s)"
              value={drive.waveform.t_off}
              onCommit={(value) =>
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
          <StageNumberTextarea
            draftKey="waveform.piecewise_linear.points"
            label="Points (time, value; one pair per line)"
            points={drive.waveform.points}
            store={numericDraftStore}
            onCommit={(points) =>
              updateDrive((current) =>
                current.waveform.kind === "piecewise_linear"
                  ? { ...current, waveform: { ...current.waveform, points } }
                  : current,
              )
            }
            />
        ) : null}
      </InspectorGroup>

      <InspectorGroup
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
            {subsequentRuns.map(({ candidate: run }) => (
              <label key={run.stageId}>
                <input
                  checked={activeStageIds.has(run.stageId)}
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
      </InspectorGroup>
    </>
  );
  return props.numericDraftStore ? (
    content
  ) : (
    <QuantityFieldDraftScope store={numericDraftStore}>
      {content}
    </QuantityFieldDraftScope>
  );
}

type SpatialSincProfile = Extract<
  RegionalFieldDriveResource["spatial_profile"],
  { kind: "sinc" }
>;

function SpatialSincFields({
  draftKeyPrefix,
  profile,
  onChange,
}: {
  draftKeyPrefix: string;
  profile: SpatialSincProfile;
  onChange: (profile: SpatialSincProfile) => void;
}) {
  return (
    <>
      <fieldset className="fm-inspector-field">
        <legend>Spatial axis (x, y, z)</legend>
        <div className="fm-inspector-vector-row">
          {AXES.map((axisName, index) => (
            <StageNumberField
              key={axisName}
              draftKey={draftKeyPrefix + "axis." + axisName}
              label={"Spatial axis " + axisName}
              value={profile.axis[index] ?? 0}
              onCommit={(value) => {
                const axis = [...profile.axis];
                axis[index] = value;
                onChange({ ...profile, axis });
              }}
            />
          ))}
        </div>
      </fieldset>
      <StageNumberField
        draftKey={draftKeyPrefix + "period_m"}
        label="Spatial period (m)"
        value={profile.period_m}
        onCommit={(period_m) => onChange({ ...profile, period_m })}
      />
      <StageNumberField
        draftKey={draftKeyPrefix + "center_m"}
        label="Spatial center (m)"
        value={profile.center_m ?? 0}
        onCommit={(center_m) => onChange({ ...profile, center_m })}
      />
      <StageOptionalNumberField
        draftKey={draftKeyPrefix + "width_m"}
        label="Spatial width (m, optional)"
        value={profile.width_m ?? null}
        onCommit={(width_m) => onChange({ ...profile, width_m })}
      />
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
