"use client";

import type {
  PlanarLengthUnit,
  PlanarMonitor,
  PlanarMonitorDraft,
  PlanarMonitorOperator,
  PlanarMonitorTarget,
} from "@/kernel/workspace/crossSectionWorkspace";
import { convertLength } from "@/kernel/workspace/crossSectionWorkspace";

import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { Vector3Field } from "../primitives/Vector3Field";

type TargetKind = PlanarMonitorTarget["kind"];
type OperatorKind = PlanarMonitorOperator["kind"];
type ExtentKind = PlanarMonitor["frame"]["extent"]["kind"];
type Availability = { available: boolean; reason: string };

export interface PlanarMonitorDefinitionAvailability {
  operators?: Partial<Record<OperatorKind, Availability>>;
  targets?: Partial<Record<TargetKind, Availability>>;
}

export function planarMonitorDefinitionAvailabilityErrors(
  monitor: PlanarMonitor,
  availability: PlanarMonitorDefinitionAvailability,
): string[] {
  const target = availability.targets?.[monitor.target.kind];
  const operator = availability.operators?.[monitor.operator.kind];
  return [
    ...(target?.available === false ? [target.reason] : []),
    ...(operator?.available === false ? [operator.reason] : []),
  ];
}

interface Props {
  availability: PlanarMonitorDefinitionAvailability;
  draft: PlanarMonitorDraft;
  onChange: (draft: PlanarMonitorDraft) => void;
}

const TARGETS: readonly TargetKind[] = [
  "domain",
  "magnetic_domain",
  "object",
  "region",
];
const OPERATORS: readonly OperatorKind[] = [
  "plane_sample",
  "slab_average",
  "depth_projection",
  "surface_projection",
];
const EXTENTS: readonly ExtentKind[] = [
  "explicit",
  "target_bounds",
  "magnetic_domain",
  "universe",
];
const LENGTH_UNITS: readonly PlanarLengthUnit[] = ["m", "mm", "um", "nm"];

export function PlanarMonitorDefinitionEditor({ availability, draft, onChange }: Props) {
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
    updateFrame({ ...monitor.frame, [key]: vector });
  };
  const displayVector = (
    key: "normal" | "origin_m" | "u_axis" | "v_axis",
    length = false,
  ): [string, string, string] =>
    monitor.frame[key].map((value) =>
      String(length ? convertLength(value, "m", unit) : value),
    ) as [string, string, string];

  return (
    <div className="fm-planar-monitor-definition-editor">
      <InspectorGroup title="Identity">
        <FormField
          label="Monitor ID"
          type="text"
          value={monitor.id}
          onChange={(event) => updateMonitor({ ...monitor, id: event.currentTarget.value })}
        />
        <FormField
          label="Name"
          type="text"
          value={monitor.name}
          onChange={(event) => updateMonitor({ ...monitor, name: event.currentTarget.value })}
        />
        <FormField
          label="Length unit"
          type="select"
          value={unit}
          onChange={(event) =>
            onChange({
              ...draft,
              ui: { ...ui, displayLengthUnit: event.currentTarget.value as PlanarLengthUnit },
            })
          }
        >
          {LENGTH_UNITS.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </FormField>
      </InspectorGroup>

      <InspectorGroup title="Target">
        <FormField
          label="Target kind"
          type="select"
          value={monitor.target.kind}
          onChange={(event) =>
            updateMonitor({
              ...monitor,
              target: targetForKind(event.currentTarget.value as TargetKind),
            })
          }
        >
          {TARGETS.map((kind) => (
            <option
              key={kind}
              disabled={availability.targets?.[kind]?.available === false}
              value={kind}
            >
              {label(kind)}
            </option>
          ))}
        </FormField>
        {monitor.target.kind === "object" || monitor.target.kind === "region" ? (
          <FormField
            label="Object ID"
            type="text"
            value={monitor.target.object_id}
            onChange={(event) => updateMonitor({
              ...monitor,
              target: monitor.target.kind === "region"
                ? { ...monitor.target, object_id: event.currentTarget.value }
                : { kind: "object", object_id: event.currentTarget.value },
            })}
          />
        ) : null}
        {monitor.target.kind === "region" ? (
          <FormField
            label="Region ID"
            type="text"
            value={monitor.target.region_id}
            onChange={(event) => updateMonitor({
              ...monitor,
              target: {
                kind: "region",
                object_id: monitor.target.kind === "region" ? monitor.target.object_id : "",
                region_id: event.currentTarget.value,
              },
            })}
          />
        ) : null}
        <AvailabilityReasons entries={availability.targets} kinds={TARGETS} />
      </InspectorGroup>

      <InspectorGroup title="Frame">
        <FormField
          label="Frame preset"
          type="select"
          value={monitor.frame.preset ?? "arbitrary"}
          onChange={(event) =>
            updateFrame(frameForPreset(
              event.currentTarget.value as "arbitrary" | "xy" | "xz" | "yz",
              monitor.frame,
            ))
          }
        >
          <option value="xy">XY</option>
          <option value="xz">XZ</option>
          <option value="yz">YZ</option>
          <option value="arbitrary">Arbitrary</option>
        </FormField>
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
        <FormField
          label="Normalization version"
          type="text"
          value={monitor.frame.normalization_version}
          onChange={(event) => updateFrame({
            ...monitor.frame,
            normalization_version: event.currentTarget.value,
          })}
        />
      </InspectorGroup>

      <InspectorGroup title="Extent">
        <FormField
          label="Extent kind"
          type="select"
          value={monitor.frame.extent.kind}
          onChange={(event) => updateFrame({
            ...monitor.frame,
            extent: extentForKind(event.currentTarget.value as ExtentKind),
          })}
        >
          {EXTENTS.map((kind) => <option key={kind} value={kind}>{label(kind)}</option>)}
        </FormField>
        <ExtentFields draft={draft} onChange={onChange} />
      </InspectorGroup>

      <InspectorGroup title="Operator">
        <FormField
          label="Operator kind"
          type="select"
          value={monitor.operator.kind}
          onChange={(event) => updateMonitor({
            ...monitor,
            operator: operatorForKind(event.currentTarget.value as OperatorKind),
          })}
        >
          {OPERATORS.map((kind) => (
            <option
              key={kind}
              disabled={availability.operators?.[kind]?.available === false}
              value={kind}
            >
              {label(kind)}
            </option>
          ))}
        </FormField>
        <OperatorFields draft={draft} onChange={onChange} />
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
    onChange({ ...draft, monitor: { ...monitor, frame: { ...monitor.frame, extent: next } } });
  const length = (value: number) => convertLength(value, "m", unit);
  const si = (value: string) => convertLength(Number(value), unit, "m");
  if (extent.kind !== "explicit") {
    return (
      <FormField
        label="Padding"
        type="number"
        unit={unit}
        value={length(extent.padding_m)}
        onChange={(event) => update({ ...extent, padding_m: si(event.currentTarget.value) })}
      />
    );
  }
  return (
    <>
      {(["u_min_m", "u_max_m", "v_min_m", "v_max_m"] as const).map((key) => (
        <FormField
          key={key}
          label={label(key)}
          type="number"
          unit={unit}
          value={length(extent[key])}
          onChange={(event) => update({ ...extent, [key]: si(event.currentTarget.value) })}
        />
      ))}
    </>
  );
}

function OperatorFields({ draft, onChange }: Pick<Props, "draft" | "onChange">) {
  const { monitor, ui } = draft;
  const operator = monitor.operator;
  const update = (next: PlanarMonitorOperator) =>
    onChange({ ...draft, monitor: { ...monitor, operator: next } });
  if (operator.kind === "slab_average") {
    return (
      <FormField
        label="Slab thickness"
        type="number"
        unit={ui.displayLengthUnit}
        value={convertLength(operator.thickness_m, "m", ui.displayLengthUnit)}
        onChange={(event) => update({
          kind: "slab_average",
          thickness_m: convertLength(Number(event.currentTarget.value), ui.displayLengthUnit, "m"),
        })}
      />
    );
  }
  if (operator.kind === "depth_projection") {
    return (
      <>
        <FormField label="Reduction" type="select" value={operator.reduction} onChange={(event) => update({
          ...operator,
          reduction: event.currentTarget.value as typeof operator.reduction,
        })}>
          {(["mean_occupied", "thickness_integral", "rms", "min", "max", "abs_max"] as const)
            .map((entry) => <option key={entry} value={entry}>{label(entry)}</option>)}
        </FormField>
        <FormField label="Empty policy" type="select" value={operator.empty_policy} onChange={(event) => update({
          ...operator,
          empty_policy: event.currentTarget.value as typeof operator.empty_policy,
        })}>
          <option value="exclude_empty">Exclude empty</option>
          <option value="include_air_as_zero">Include air as zero</option>
        </FormField>
      </>
    );
  }
  if (operator.kind !== "surface_projection") return null;
  const boundary = operator.boundary;
  return (
    <>
      <FormField label="Boundary selector" type="select" value={boundary.kind} onChange={(event) => update({
        ...operator,
        boundary: boundaryForKind(event.currentTarget.value as typeof boundary.kind),
      })}>
        <option value="object_boundary">Object boundary</option>
        <option value="region_boundary">Region boundary</option>
        <option value="named_surface">Named surface</option>
      </FormField>
      {boundary.kind === "region_boundary" ? (
        <FormField label="Boundary region ID" type="text" value={boundary.region_id} onChange={(event) => update({
          ...operator,
          boundary: { ...boundary, region_id: event.currentTarget.value },
        })} />
      ) : null}
      {boundary.kind === "named_surface" ? (
        <FormField label="Surface ID" type="text" value={boundary.surface_id} onChange={(event) => update({
          ...operator,
          boundary: { ...boundary, surface_id: event.currentTarget.value },
        })} />
      ) : null}
      <FormField label="Visibility policy" type="select" value={operator.visibility_policy} onChange={(event) => update({
        ...operator,
        visibility_policy: event.currentTarget.value as typeof operator.visibility_policy,
      })}>
        {(["frontmost", "backmost", "nearest_to_origin", "area_weighted_overlap"] as const)
          .map((entry) => <option key={entry} value={entry}>{label(entry)}</option>)}
      </FormField>
    </>
  );
}

function AvailabilityReasons<K extends string>({ entries, kinds }: {
  entries?: Partial<Record<K, Availability>>;
  kinds: readonly K[];
}) {
  const unavailable = kinds.flatMap((kind) => {
    const state = entries?.[kind];
    return state?.available === false ? [`${label(kind)}: ${state.reason}`] : [];
  });
  if (unavailable.length === 0) return null;
  return <div className="fm-help-text">{unavailable.map((reason) => <p key={reason}>{reason}</p>)}</div>;
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
  if (kind === "depth_projection") return { kind, reduction: "mean_occupied", empty_policy: "exclude_empty" };
  if (kind === "surface_projection") return {
    kind,
    boundary: { kind: "object_boundary" },
    visibility_policy: "frontmost",
  };
  return { kind };
}

function boundaryForKind(kind: "object_boundary" | "region_boundary" | "named_surface") {
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
  const basis = preset === "xy"
    ? { origin_m: [0, 0, position], u_axis: [1, 0, 0], v_axis: [0, 1, 0], normal: [0, 0, 1] }
    : preset === "xz"
      ? { origin_m: [0, position, 0], u_axis: [1, 0, 0], v_axis: [0, 0, 1], normal: [0, -1, 0] }
      : { origin_m: [position, 0, 0], u_axis: [0, 1, 0], v_axis: [0, 0, 1], normal: [1, 0, 0] };
  return { ...frame, ...basis, preset } as PlanarMonitor["frame"];
}

function label(value: string): string {
  return value.replace(/_m$/, " (min/max)").replaceAll("_", " ").replace(/^./, (entry) => entry.toUpperCase());
}
