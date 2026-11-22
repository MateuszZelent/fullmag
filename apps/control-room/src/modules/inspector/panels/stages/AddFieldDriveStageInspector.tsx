"use client";

import { useMemo } from "react";

import type { RegionalFieldDriveResource } from "@/kernel/api/apiTypes";
import {
  milliTeslaToTesla,
  teslaToMilliTesla,
} from "@/shared/domain/physics/fieldDrive";
import { buildSincPulsePreview } from "@/shared/domain/physics/sincPulsePreview";
import { Checkbox } from "@/shared/ui/Checkbox";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Textarea } from "@/shared/ui/Textarea";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  regionalFieldDriveSamplingContext,
  regionalFieldDriveSelectorOptions,
} from "../RegionalFieldDrivePanelModel";
import { SincPulsePreview } from "../SincPulsePreview";
import {
  StageInspectorFrame,
  type StageInspectorFrameProps,
} from "./StageInspectorFrame";
import { SamplingDiagnostics } from "./SamplingDiagnostics";
import { formatEditableNumber } from "./samplingPresentation";
import { resolveStudyWorkflowStateBefore } from "./studyWorkflowState";

const AXES = ["x", "y", "z"] as const;
const EMPTY_SELECT_SENTINEL = "__none__";

const TARGET_LABELS: Record<string, string> = {
  global: "Global domain",
  object: "Object",
  region: "Stable region",
};

const SPATIAL_PROFILE_LABELS: Record<string, string> = {
  geometry_mask: "Geometry mask",
  sinc: "Spatial sinc",
  uniform: "Uniform",
};

const WAVEFORM_LABELS: Record<string, string> = {
  constant: "Constant",
  piecewise_linear: "Piecewise linear",
  pulse: "Rectangular pulse",
  sinc_pulse: "Sinc pulse",
  sinusoidal: "Sinusoidal",
};

const TIME_ORIGIN_LABELS: Record<string, string> = {
  absolute: "Absolute simulation time",
  stage_local: "Stage local",
};

const ACTIVATION_LABELS: Record<string, string> = {
  all_time_evolution: "All following time stages",
  stage_ids: "Selected following runs",
};

const WINDOW_LABELS: Record<string, string> = {
  hann: "Hann",
  none: "None",
};

function resolveOptionLabel(
  items: readonly { id: string; label: string }[],
  id: string,
  emptyLabel: string,
): string {
  return items.find((item) => item.id === id)?.label ?? (id || emptyLabel);
}

export function AddFieldDriveStageInspector(props: StageInspectorFrameProps) {
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

  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="add_field_drive"
        kindLabel="Add Field Drive"
      />
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
          <Input
            disabled={!drive}
            value={drive?.id ?? ""}
            onChange={(event) =>
              updateDrive((current) => ({ ...current, id: event.target.value }))
            }
          />
        </label>
        <label className="fm-inspector-field">
          <span>Name</span>
          <Input
            disabled={!drive}
            value={drive?.name ?? ""}
            onChange={(event) =>
              updateDrive((current) => ({ ...current, name: event.target.value }))
            }
          />
        </label>
        <label className="fm-inspector-field">
          <span>Enabled</span>
          <Checkbox
            checked={drive?.enabled ?? false}
            disabled={!drive}
            onChange={(event) =>
              updateDrive((current) => ({
                ...current,
                enabled: event.target.checked,
              }))
            }
          />
        </label>
        <FormField
          disabled={!drive}
          label="Amplitude"
          min="0"
          step="0.001"
          type="number"
          unit="mT"
          value={drive ? teslaToMilliTesla(drive.amplitude_B_T) : ""}
          onChange={(event) =>
            updateDrive((current) => ({
              ...current,
              amplitude_B_T: milliTeslaToTesla(Number(event.target.value)),
            }))
          }
        />
        <label className="fm-inspector-field">
          <span>Direction (x, y, z)</span>
          <div className="fm-inspector-vector-row">
            {AXES.map((axis, index) => (
              <Input
                aria-label={`Direction ${axis}`}
                disabled={!drive}
                key={axis}
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
          <Select
            disabled={!drive}
            value={drive?.target.kind ?? "global"}
            onValueChange={(nextValue) =>
              updateDrive((current) => ({
                ...current,
                target:
                  nextValue === "object"
                    ? { kind: "object", object_id: "" }
                    : nextValue === "region"
                      ? { kind: "region", object_id: "", region_id: "" }
                      : { kind: "global" },
              }))
            }
          >
            <SelectTrigger aria-label="Target">
              <SelectValue
                placeholder={TARGET_LABELS[drive?.target.kind ?? "global"]}
              >
                {TARGET_LABELS[drive?.target.kind ?? "global"]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">Global domain</SelectItem>
              <SelectItem value="object">Object</SelectItem>
              <SelectItem value="region">Stable region</SelectItem>
            </SelectContent>
          </Select>
        </label>
        {drive && drive.target.kind !== "global" ? (
          <label className="fm-inspector-field">
            <span>Object</span>
            <Select
              value={drive.target.object_id || EMPTY_SELECT_SENTINEL}
              onValueChange={(nextValue) => {
                const objectId =
                  nextValue === EMPTY_SELECT_SENTINEL ? "" : nextValue;
                updateDrive((current) => {
                  if (current.target.kind === "global") return current;
                  return {
                    ...current,
                    target: current.target.kind === "region"
                      ? {
                          ...current.target,
                          object_id: objectId,
                          region_id: "",
                        }
                      : { ...current.target, object_id: objectId },
                  };
                });
              }}
            >
              <SelectTrigger aria-label="Object">
                <SelectValue
                  placeholder={resolveOptionLabel(
                    selectorOptions.objects,
                    drive.target.object_id,
                    "Select an object",
                  )}
                >
                  {resolveOptionLabel(
                    selectorOptions.objects,
                    drive.target.object_id,
                    "Select an object",
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EMPTY_SELECT_SENTINEL}>Select an object</SelectItem>
                {selectorOptions.objects
                  .filter((object) => object.id !== "")
                  .map((object) => (
                    <SelectItem key={object.id} value={object.id}>
                      {object.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}
        {drive?.target.kind === "region" ? (
          <label className="fm-inspector-field">
            <span>Stable region</span>
            <Select
              value={drive.target.region_id || EMPTY_SELECT_SENTINEL}
              onValueChange={(nextValue) => {
                const regionId =
                  nextValue === EMPTY_SELECT_SENTINEL ? "" : nextValue;
                updateDrive((current) =>
                  current.target.kind === "region"
                    ? {
                        ...current,
                        target: { ...current.target, region_id: regionId },
                      }
                    : current,
                );
              }}
            >
              <SelectTrigger aria-label="Stable region">
                <SelectValue
                  placeholder={resolveOptionLabel(
                    selectorOptions.regionsByObject[drive.target.object_id] ?? [],
                    drive.target.region_id,
                    "Select a region",
                  )}
                >
                  {resolveOptionLabel(
                    selectorOptions.regionsByObject[drive.target.object_id] ?? [],
                    drive.target.region_id,
                    "Select a region",
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EMPTY_SELECT_SENTINEL}>Select a region</SelectItem>
                {(selectorOptions.regionsByObject[drive.target.object_id] ?? [])
                  .filter((region) => region.id !== "")
                  .map((region) => (
                    <SelectItem key={region.id} value={region.id}>
                      {region.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}
        <label className="fm-inspector-field">
          <span>Spatial profile</span>
          <Select
            disabled={!drive}
            value={drive?.spatial_profile.kind ?? "uniform"}
            onValueChange={(nextValue) =>
              updateDrive((current) => ({
                ...current,
                spatial_profile:
                  nextValue === "sinc"
                    ? defaultSpatialSinc()
                    : nextValue === "geometry_mask"
                      ? {
                          envelope: { kind: "uniform" },
                          kind: "geometry_mask",
                          object_id: "",
                        }
                      : { kind: "uniform" },
              }))
            }
          >
            <SelectTrigger aria-label="Spatial profile">
              <SelectValue
                placeholder={
                  SPATIAL_PROFILE_LABELS[drive?.spatial_profile.kind ?? "uniform"]
                }
              >
                {SPATIAL_PROFILE_LABELS[drive?.spatial_profile.kind ?? "uniform"]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="uniform">Uniform</SelectItem>
              <SelectItem value="sinc">Spatial sinc</SelectItem>
              <SelectItem value="geometry_mask">Geometry mask</SelectItem>
            </SelectContent>
          </Select>
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
              <Select
                value={drive.spatial_profile.object_id || EMPTY_SELECT_SENTINEL}
                onValueChange={(nextValue) => {
                  const objectId =
                    nextValue === EMPTY_SELECT_SENTINEL ? "" : nextValue;
                  updateDrive((current) =>
                    current.spatial_profile.kind === "geometry_mask"
                      ? {
                          ...current,
                          spatial_profile: {
                            ...current.spatial_profile,
                            object_id: objectId,
                          },
                        }
                      : current,
                  );
                }}
              >
                <SelectTrigger aria-label="Mask geometry">
                  <SelectValue
                    placeholder={resolveOptionLabel(
                      selectorOptions.objects,
                      drive.spatial_profile.object_id,
                      "Select an object",
                    )}
                  >
                    {resolveOptionLabel(
                      selectorOptions.objects,
                      drive.spatial_profile.object_id,
                      "Select an object",
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EMPTY_SELECT_SENTINEL}>Select an object</SelectItem>
                  {selectorOptions.objects
                    .filter((object) => object.id !== "")
                    .map((object) => (
                      <SelectItem key={object.id} value={object.id}>
                        {object.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </label>
            <label className="fm-inspector-field">
              <span>Envelope</span>
              <Select
                value={drive.spatial_profile.envelope.kind}
                onValueChange={(nextValue) =>
                  updateDrive((current) =>
                    current.spatial_profile.kind === "geometry_mask"
                      ? {
                          ...current,
                          spatial_profile: {
                            ...current.spatial_profile,
                            envelope:
                              nextValue === "sinc"
                                ? defaultSpatialSinc()
                                : { kind: "uniform" },
                          },
                        }
                      : current,
                  )
                }
              >
                <SelectTrigger aria-label="Envelope">
                  <SelectValue
                    placeholder={
                      SPATIAL_PROFILE_LABELS[drive.spatial_profile.envelope.kind] ??
                      drive.spatial_profile.envelope.kind
                    }
                  >
                    {SPATIAL_PROFILE_LABELS[drive.spatial_profile.envelope.kind] ??
                      drive.spatial_profile.envelope.kind}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="uniform">Uniform</SelectItem>
                  <SelectItem value="sinc">Spatial sinc</SelectItem>
                </SelectContent>
              </Select>
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
      </InspectorGroup>

      <InspectorGroup
        title="Waveform & Source FFT"
        badge={drive?.waveform.kind ?? "not configured"}
      >
        <label className="fm-inspector-field">
          <span>Function in time</span>
          <Select
            disabled={!drive}
            value={drive?.waveform.kind ?? "constant"}
            onValueChange={(nextValue) =>
              updateDrive((current) => ({
                ...current,
                waveform: defaultWaveform(nextValue),
              }))
            }
          >
            <SelectTrigger aria-label="Function in time">
              <SelectValue
                placeholder={WAVEFORM_LABELS[drive?.waveform.kind ?? "constant"]}
              >
                {WAVEFORM_LABELS[drive?.waveform.kind ?? "constant"]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="constant">Constant</SelectItem>
              <SelectItem value="sinusoidal">Sinusoidal</SelectItem>
              <SelectItem value="pulse">Rectangular pulse</SelectItem>
              <SelectItem value="piecewise_linear">Piecewise linear</SelectItem>
              <SelectItem value="sinc_pulse">Sinc pulse</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="fm-inspector-field">
          <span>Time origin</span>
          <Select
            disabled={!drive}
            value={drive?.time_origin ?? "stage_local"}
            onValueChange={(nextValue) =>
              updateDrive((current) => ({
                ...current,
                time_origin: nextValue as "absolute" | "stage_local",
              }))
            }
          >
            <SelectTrigger aria-label="Time origin">
              <SelectValue
                placeholder={TIME_ORIGIN_LABELS[drive?.time_origin ?? "stage_local"]}
              >
                {TIME_ORIGIN_LABELS[drive?.time_origin ?? "stage_local"]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stage_local">Stage local</SelectItem>
              <SelectItem value="absolute">Absolute simulation time</SelectItem>
            </SelectContent>
          </Select>
        </label>
        {drive?.waveform.kind === "sinc_pulse" ? (
          <>
            <FieldRow label="Definition" value="a sinc(2 fc (t - t0))" />
            <FormField
              label="Cutoff fc"
              min="0"
              type="number"
              unit="Hz"
              value={formatEditableNumber(drive.waveform.cutoff_hz)}
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
            <FormField
              label="Center t0"
              type="number"
              unit="s"
              value={formatEditableNumber(drive.waveform.t0 ?? 0)}
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
            <label className="fm-inspector-field">
              <span>Waveform amplitude a</span>
              <Input
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
            <Textarea
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
      </InspectorGroup>

      <InspectorGroup
        title="Activation & State Handoff"
        badge={samplingRun?.stageId ?? "no following run"}
      >
        <label className="fm-inspector-field">
          <span>Activation</span>
          <Select
            disabled={!drive}
            value={drive?.activation.kind ?? "all_time_evolution"}
            onValueChange={(nextValue) =>
              updateDrive((current) => ({
                ...current,
                activation:
                  nextValue === "stage_ids"
                    ? { kind: "stage_ids", stage_ids: [] }
                    : { kind: "all_time_evolution" },
              }))
            }
          >
            <SelectTrigger aria-label="Activation">
              <SelectValue
                placeholder={
                  ACTIVATION_LABELS[drive?.activation.kind ?? "all_time_evolution"]
                }
              >
                {ACTIVATION_LABELS[drive?.activation.kind ?? "all_time_evolution"]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all_time_evolution">All following time stages</SelectItem>
              <SelectItem value="stage_ids">Selected following runs</SelectItem>
            </SelectContent>
          </Select>
        </label>
        {drive?.activation.kind === "stage_ids" ? (
          <fieldset className="fm-inspector-field">
            <legend>Following Run stages</legend>
            {subsequentRuns.map(({ candidate: run }) => (
              <label key={run.stageId}>
                <Checkbox
                  checked={activeStageIds.has(run.stageId)}
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
          {AXES.map((axisName, index) => (
            <Input
              aria-label={`Spatial axis ${axisName}`}
              key={axisName}
              step="0.01"
              type="number"
              value={profile.axis[index] ?? 0}
              onChange={(event) => {
                const value = event.currentTarget.valueAsNumber;
                if (!Number.isFinite(value)) return;
                const axis = [...profile.axis];
                axis[index] = value;
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
        <Input
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
        <Select
          value={profile.window ?? "none"}
          onValueChange={(nextValue) => onChange({ ...profile, window: nextValue })}
        >
          <SelectTrigger aria-label="Window">
            <SelectValue
              placeholder={WINDOW_LABELS[profile.window ?? "none"] ?? profile.window ?? "None"}
            >
              {WINDOW_LABELS[profile.window ?? "none"] ?? profile.window ?? "None"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="hann">Hann</SelectItem>
          </SelectContent>
        </Select>
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
      <Input
        type="number"
        value={value}
        onChange={(event) => {
          const value = event.currentTarget.valueAsNumber;
          if (Number.isFinite(value)) onChange(value);
        }}
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
