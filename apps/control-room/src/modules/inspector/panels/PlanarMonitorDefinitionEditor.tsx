"use client";

import { useId, type ReactNode } from "react";

import type {
  PlanarLengthUnit,
  PlanarMonitor,
  PlanarMonitorDraft,
  PlanarMonitorOperator,
  PlanarMonitorTarget,
} from "@/kernel/workspace/crossSectionWorkspace";
import { convertLength } from "@/kernel/workspace/crossSectionWorkspace";
import { resolvePlanarMonitorPreviewSupport } from "@/kernel/workspace/planarMonitorFramePreview";
import { Input } from "@/shared/ui/Input";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { InspectorPropertyRow } from "../primitives/InspectorPropertyRow";
import { Vector3Field } from "../primitives/Vector3Field";
import {
  type Availability,
  type OperatorKind,
  OPERATORS,
  type PlanarMonitorDefinitionAvailability,
  type TargetKind,
  TARGETS,
} from "./PlanarMonitorDefinitionEditor.model";

type ExtentKind = PlanarMonitor["frame"]["extent"]["kind"];

interface Props {
  availability: PlanarMonitorDefinitionAvailability;
  draft: PlanarMonitorDraft;
  mode?: "create" | "committed";
  pickFaceSlot?: ReactNode;
  onChange: (draft: PlanarMonitorDraft) => void;
}
const EXTENTS: readonly ExtentKind[] = [
  "explicit",
  "target_bounds",
  "magnetic_domain",
  "universe",
];
const LENGTH_UNITS: readonly PlanarLengthUnit[] = ["m", "mm", "um", "nm"];

interface SelectOption<T extends string = string> {
  readonly disabled?: boolean;
  readonly label: string;
  readonly value: T;
}

function PlanarTextField({
  labelText,
  onValueChange,
  readOnly = false,
  type = "text",
  unit,
  value,
}: {
  labelText: string;
  onValueChange: (value: string) => void;
  readOnly?: boolean;
  type?: "text" | "number";
  unit?: string;
  value: string | number;
}) {
  const id = useId();
  return (
    <InspectorPropertyRow
      className="fm-inspector-form-field"
      label={
        <label className="fm-inspector-form-field__label" htmlFor={id}>
          {labelText}
        </label>
      }
      layout="stacked"
    >
      <div className="fm-inspector-form-field__control">
        <Input
          aria-label={labelText}
          id={id}
          readOnly={readOnly}
          type={type}
          value={String(value)}
          onChange={(event) => onValueChange(event.currentTarget.value)}
          onInput={(event) => onValueChange(event.currentTarget.value)}
        />
        {unit ? <span className="fm-inspector-form-field__unit">{unit}</span> : null}
      </div>
    </InspectorPropertyRow>
  );
}

function PlanarSelectField<T extends string>({
  labelText,
  onValueChange,
  options,
  value,
}: {
  labelText: string;
  onValueChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  value: T;
}) {
  const id = useId();
  return (
    <InspectorPropertyRow
      className="fm-inspector-form-field"
      label={
        <label className="fm-inspector-form-field__label" htmlFor={id}>
          {labelText}
        </label>
      }
      layout="stacked"
    >
      <Select value={value} onValueChange={(next) => onValueChange(next as T)}>
        <SelectTrigger aria-label={labelText} id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              disabled={option.disabled}
              key={option.value}
              value={option.value}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </InspectorPropertyRow>
  );
}

export function PlanarMonitorDefinitionEditor({
  availability,
  draft,
  mode = "create",
  pickFaceSlot,
  onChange,
}: Props) {
  const { monitor, ui } = draft;
  const unit = ui.displayLengthUnit;
  const updateMonitor = (next: PlanarMonitor) => onChange({ ...draft, monitor: next });
  const updateFrame = (frame: PlanarMonitor["frame"]) =>
    updateMonitor({ ...monitor, frame });
  const updateVector = (
    key: "normal" | "origin_m" | "u_axis" | "v_axis",
    index: 0 | 1 | 2,
    value: string,
    length = false,
  ) => {
    const vector = [...monitor.frame[key]] as [number, number, number];
    const numeric = Number(value);
    vector[index] = length ? convertLength(numeric, unit, "m") : numeric;
    updateFrame({ ...monitor.frame, [key]: vector, preset: null });
  };
  const displayVector = (
    key: "normal" | "origin_m" | "u_axis" | "v_axis",
    length = false,
  ): [string, string, string] =>
    monitor.frame[key].map((value) =>
      String(length ? convertLength(value, "m", unit) : value),
    ) as [string, string, string];
  const previewSupport = resolvePlanarMonitorPreviewSupport(monitor.operator);

  return (
    <div className="fm-planar-monitor-definition-editor">
      <InspectorGroup title="Identity">
        <PlanarTextField
          labelText="Monitor ID"
          readOnly={mode === "committed"}
          value={monitor.id}
          onValueChange={(next) => updateMonitor({ ...monitor, id: next })}
        />
        <PlanarTextField
          labelText="Name"
          value={monitor.name}
          onValueChange={(next) => updateMonitor({ ...monitor, name: next })}
        />
        <PlanarSelectField<PlanarLengthUnit>
          labelText="Length unit"
          options={LENGTH_UNITS.map((entry) => ({ label: entry, value: entry }))}
          value={unit}
          onValueChange={(nextUnit) =>
            onChange({
              ...draft,
              ui: { ...ui, displayLengthUnit: nextUnit },
            })
          }
        />
      </InspectorGroup>

      <InspectorGroup title="Target">
        <PlanarSelectField<TargetKind>
          labelText="Target kind"
          options={TARGETS.map((kind) => ({
            disabled: availability.targets?.[kind]?.available === false,
            label: label(kind),
            value: kind,
          }))}
          value={monitor.target.kind}
          onValueChange={(nextKind) =>
            updateMonitor({
              ...monitor,
              target: targetForKind(nextKind),
            })
          }
        />
        {monitor.target.kind === "object" || monitor.target.kind === "region" ? (
          <PlanarTextField
            labelText="Object ID"
            value={monitor.target.object_id}
            onValueChange={(next) =>
              updateMonitor({
                ...monitor,
                target:
                  monitor.target.kind === "region"
                    ? { ...monitor.target, object_id: next }
                    : { kind: "object", object_id: next },
              })
            }
          />
        ) : null}
        {monitor.target.kind === "region" ? (
          <PlanarTextField
            labelText="Region ID"
            value={monitor.target.region_id}
            onValueChange={(next) =>
              updateMonitor({
                ...monitor,
                target: {
                  kind: "region",
                  object_id:
                    monitor.target.kind === "region" ? monitor.target.object_id : "",
                  region_id: next,
                },
              })
            }
          />
        ) : null}
        <AvailabilityReasons entries={availability.targets} kinds={TARGETS} />
      </InspectorGroup>

      <InspectorGroup title="Frame">
        <InspectorPropertyRow
          className="fm-inspector-form-field"
          label={<span className="fm-inspector-form-field__label">Frame preset</span>}
          layout="stacked"
        >
          <SegmentedControl<"xy" | "xz" | "yz" | "arbitrary">
            aria-label="Frame preset"
            columns={4}
            options={[
              { value: "xy", label: "XY (+z)" },
              { value: "xz", label: "XZ (+y)" },
              { value: "yz", label: "YZ (+x)" },
              { value: "arbitrary", label: "Arbitrary" },
            ]}
            value={monitor.frame.preset ?? "arbitrary"}
            onValueChange={(nextPreset) =>
              updateFrame(frameForPreset(nextPreset, monitor.frame))
            }
          />
        </InspectorPropertyRow>
        {pickFaceSlot}
        <Vector3Field
          label="Origin"
          unit={unit}
          values={displayVector("origin_m", true)}
          onChange={(index, value) => updateVector("origin_m", index, value, true)}
        />
        <Vector3Field
          label="Normal"
          values={displayVector("normal")}
          onChange={(index, value) => updateVector("normal", index, value)}
        />
        <Vector3Field
          label="u axis"
          values={displayVector("u_axis")}
          onChange={(index, value) => updateVector("u_axis", index, value)}
        />
        <Vector3Field
          label="v axis"
          values={displayVector("v_axis")}
          onChange={(index, value) => updateVector("v_axis", index, value)}
        />
        <PlanarTextField
          labelText="Normalization version"
          value={monitor.frame.normalization_version}
          onValueChange={(next) =>
            updateFrame({
              ...monitor.frame,
              normalization_version: next,
            })
          }
        />
      </InspectorGroup>

      <InspectorGroup title="Extent">
        <PlanarSelectField<ExtentKind>
          labelText="Extent kind"
          options={EXTENTS.map((kind) => ({ label: label(kind), value: kind }))}
          value={monitor.frame.extent.kind}
          onValueChange={(nextKind) =>
            updateFrame({
              ...monitor.frame,
              extent: extentForKind(nextKind),
            })
          }
        />
        <ExtentFields draft={draft} onChange={onChange} />
      </InspectorGroup>

      <InspectorGroup title="Operator">
        <PlanarSelectField<OperatorKind>
          labelText="Operator kind"
          options={OPERATORS.map((kind) => ({
            disabled: availability.operators?.[kind]?.available === false,
            label: label(kind),
            value: kind,
          }))}
          value={monitor.operator.kind}
          onValueChange={(nextKind) =>
            updateMonitor({
              ...monitor,
              operator: operatorForKind(nextKind),
            })
          }
        />
        <OperatorFields availability={availability} draft={draft} onChange={onChange} />
        {previewSupport.status === "unavailable" ? (
          <FieldRow label="3D preview" value={previewSupport.reason} />
        ) : null}
        <AvailabilityReasons entries={availability.operators} kinds={OPERATORS} />
      </InspectorGroup>
    </div>
  );
}

function ExtentFields({ draft, onChange }: Pick<Props, "draft" | "onChange">) {
  const { monitor, ui } = draft;
  const extent = monitor.frame.extent;
  const unit = ui.displayLengthUnit;
  const update = (next: PlanarMonitor["frame"]["extent"]) =>
    onChange({
      ...draft,
      monitor: { ...monitor, frame: { ...monitor.frame, extent: next } },
    });
  const length = (value: number) => convertLength(value, "m", unit);
  const si = (value: string) => convertLength(Number(value), unit, "m");
  if (extent.kind !== "explicit") {
    return (
      <PlanarTextField
        labelText="Padding"
        type="number"
        unit={unit}
        value={length(extent.padding_m)}
        onValueChange={(next) => update({ ...extent, padding_m: si(next) })}
      />
    );
  }
  return (
    <>
      {(["u_min_m", "u_max_m", "v_min_m", "v_max_m"] as const).map((key) => (
        <PlanarTextField
          key={key}
          labelText={label(key)}
          type="number"
          unit={unit}
          value={length(extent[key])}
          onValueChange={(next) => update({ ...extent, [key]: si(next) })}
        />
      ))}
    </>
  );
}

function OperatorFields({
  availability,
  draft,
  onChange,
}: Pick<Props, "availability" | "draft" | "onChange">) {
  const { monitor, ui } = draft;
  const operator = monitor.operator;
  const update = (next: PlanarMonitorOperator) =>
    onChange({ ...draft, monitor: { ...monitor, operator: next } });
  if (operator.kind === "slab_average") {
    return (
      <PlanarTextField
        labelText="Slab thickness"
        type="number"
        unit={ui.displayLengthUnit}
        value={convertLength(operator.thickness_m, "m", ui.displayLengthUnit)}
        onValueChange={(next) =>
          update({
            kind: "slab_average",
            thickness_m: convertLength(Number(next), ui.displayLengthUnit, "m"),
          })
        }
      />
    );
  }
  if (operator.kind === "depth_projection") {
    return (
      <>
        <PlanarSelectField<typeof operator.reduction>
          labelText="Reduction"
          options={(
            [
              "mean_occupied",
              "thickness_integral",
              "rms",
              "min",
              "max",
              "abs_max",
            ] as const
          ).map((entry) => ({ label: label(entry), value: entry }))}
          value={operator.reduction}
          onValueChange={(nextReduction) =>
            update({
              ...operator,
              reduction: nextReduction,
            })
          }
        />
        <PlanarSelectField<typeof operator.empty_policy>
          labelText="Empty policy"
          options={[
            { label: "Exclude empty", value: "exclude_empty" },
            { label: "Include air as zero", value: "include_air_as_zero" },
          ]}
          value={operator.empty_policy}
          onValueChange={(nextPolicy) =>
            update({
              ...operator,
              empty_policy: nextPolicy,
            })
          }
        />
      </>
    );
  }
  if (operator.kind !== "surface_projection") return null;
  const boundary = operator.boundary;
  return (
    <>
      <PlanarSelectField<typeof boundary.kind>
        labelText="Boundary selector"
        options={(
          ["object_boundary", "region_boundary", "named_surface"] as const
        ).map((kind) => ({
          disabled: availability.surfaceBoundaries?.[kind]?.available === false,
          label: label(kind),
          value: kind,
        }))}
        value={boundary.kind}
        onValueChange={(nextKind) =>
          update({
            ...operator,
            boundary: boundaryForKind(nextKind),
          })
        }
      />
      {boundary.kind === "region_boundary" ? (
        <PlanarTextField
          labelText="Boundary region ID"
          value={boundary.region_id}
          onValueChange={(next) =>
            update({
              ...operator,
              boundary: { ...boundary, region_id: next },
            })
          }
        />
      ) : null}
      {boundary.kind === "named_surface" ? (
        <PlanarTextField
          labelText="Surface ID"
          value={boundary.surface_id}
          onValueChange={(next) =>
            update({
              ...operator,
              boundary: { ...boundary, surface_id: next },
            })
          }
        />
      ) : null}
      <PlanarSelectField<typeof operator.visibility_policy>
        labelText="Visibility policy"
        options={(
          [
            "frontmost",
            "backmost",
            "nearest_to_origin",
            "area_weighted_overlap",
          ] as const
        ).map((entry) => ({ label: label(entry), value: entry }))}
        value={operator.visibility_policy}
        onValueChange={(nextPolicy) =>
          update({
            ...operator,
            visibility_policy: nextPolicy,
          })
        }
      />
      <AvailabilityReasons
        entries={availability.surfaceBoundaries}
        kinds={["object_boundary", "region_boundary", "named_surface"]}
      />
    </>
  );
}

function AvailabilityReasons<K extends string>({
  entries,
  kinds,
}: {
  entries?: Partial<Record<K, Availability>>;
  kinds: readonly K[];
}) {
  const unavailable = kinds.flatMap((kind) => {
    const state = entries?.[kind];
    return state?.available === false ? [`${label(kind)}: ${state.reason}`] : [];
  });
  if (unavailable.length === 0) return null;
  return (
    <div className="fm-help-text">
      {[...new Set(unavailable)].map((reason) => (
        <p key={reason}>{reason}</p>
      ))}
    </div>
  );
}

function targetForKind(kind: TargetKind): PlanarMonitorTarget {
  if (kind === "object") return { kind, object_id: "" };
  if (kind === "region") return { kind, object_id: "", region_id: "" };
  return { kind };
}

function extentForKind(kind: ExtentKind): PlanarMonitor["frame"]["extent"] {
  return kind === "explicit"
    ? { kind, u_min_m: -50e-9, u_max_m: 50e-9, v_min_m: -50e-9, v_max_m: 50e-9 }
    : { kind, padding_m: 0 };
}

function operatorForKind(kind: OperatorKind): PlanarMonitorOperator {
  if (kind === "slab_average") return { kind, thickness_m: 1e-9 };
  if (kind === "depth_projection") {
    return { kind, reduction: "mean_occupied", empty_policy: "exclude_empty" };
  }
  if (kind === "surface_projection") {
    return {
      kind,
      boundary: { kind: "object_boundary" },
      visibility_policy: "frontmost",
    };
  }
  return { kind };
}

function boundaryForKind(
  kind: "object_boundary" | "region_boundary" | "named_surface",
) {
  if (kind === "region_boundary") return { kind, region_id: "" } as const;
  if (kind === "named_surface") return { kind, surface_id: "" } as const;
  return { kind } as const;
}

function frameForPreset(
  preset: "arbitrary" | "xy" | "xz" | "yz",
  frame: PlanarMonitor["frame"],
): PlanarMonitor["frame"] {
  if (preset === "arbitrary") return { ...frame, preset: null };
  const position = frame.origin_m[preset === "xy" ? 2 : preset === "xz" ? 1 : 0];
  const basis =
    preset === "xy"
      ? {
          origin_m: [0, 0, position],
          u_axis: [1, 0, 0],
          v_axis: [0, 1, 0],
          normal: [0, 0, 1],
        }
      : preset === "xz"
        ? {
            origin_m: [0, position, 0],
            u_axis: [1, 0, 0],
            v_axis: [0, 0, 1],
            normal: [0, -1, 0],
          }
        : {
            origin_m: [position, 0, 0],
            u_axis: [0, 1, 0],
            v_axis: [0, 0, 1],
            normal: [1, 0, 0],
          };
  return { ...frame, ...basis, preset } as PlanarMonitor["frame"];
}

function label(value: string): string {
  return value
    .replace(/_m$/, " (min/max)")
    .replaceAll("_", " ")
    .replace(/^./, (entry) => entry.toUpperCase());
}
