"use client";

import type { ReactNode } from "react";
import { Badge } from "@/shared/ui/Badge";
import type { InspectorRowSpec, UnitOption } from "../../../template";
import {
  ANISOTROPY_UNITS,
  DMI_UNITS,
  EXCHANGE_UNITS,
  LENGTH_UNITS,
  MAGNETIZATION_UNITS,
  vectorNorm,
} from "../../../panels/model-roots/SpecInspectorHost";
import type { MaterialFunctionFieldSummary, SceneRegionConflictPolicy } from "../../../panels/region/ObjectRegionMaterialFieldsModel";
import {
  materialFieldRealizationRows,
  useModelMaterialFieldsResourceSafe,
  type RegionConstitutiveOverrideDraft,
  type RegionFieldProfileMode,
  type RegionScalarParamKey,
  type SceneMaterialParameterAssignment,
  type SceneMaterialParameterName,
  type SceneMaterialTransitionScope,
  type SceneRegionFrame,
} from "../../../panels/region/regionInspectorHelpers";

export type ScalarParamDraftFields = {
  [P in RegionScalarParamKey as `${P}Mode`]: RegionFieldProfileMode;
} & {
  [P in RegionScalarParamKey as `${P}Value`]: number;
} & {
  [P in RegionScalarParamKey as `${P}EndValue`]: number;
} & {
  [P in RegionScalarParamKey as `${P}SpanM`]: number;
} & {
  [P in RegionScalarParamKey as `${P}Direction`]: readonly [number, number, number];
} & {
  [P in RegionScalarParamKey as `${P}RadialCenter`]: readonly [number, number, number];
} & {
  [P in RegionScalarParamKey as `${P}RadialRadius`]: number;
} & {
  [P in RegionScalarParamKey as `${P}Frame`]: SceneRegionFrame;
} & {
  [P in RegionScalarParamKey as `${P}Priority`]: number;
} & {
  [P in RegionScalarParamKey as `${P}ConflictPolicy`]: SceneRegionConflictPolicy;
} & {
  [P in RegionScalarParamKey as `${P}AssignmentId`]: string;
};

export interface RegionMaterialOverridesDraft extends ScalarParamDraftFields {
  objectId: string;
  objectName: string;
  regionId: string;
  regionName: string;
  exists: boolean;
  parentMs: number;
  parentAex: number;
  parentAlpha: number;
  parentKu1: number;
  parentKu2: number;
  parentDind: number;
  parentDbulk: number;
  axisOverridden: boolean;
  axisAssignmentId: string;
  anisotropyAxis: readonly [number, number, number];
  axisPriority: number;
  axisConflictPolicy: SceneRegionConflictPolicy;
  regionMaterialOverrides: readonly RegionConstitutiveOverrideDraft[];
  hadAuthoredTransition: boolean;
  transitionKind: "sharp" | "metric" | "mesh_relative";
  transitionWidth: number;
  transitionCells: number;
  transitionScope: SceneMaterialTransitionScope;
  rawFunctionMap: Readonly<
    Partial<Record<RegionScalarParamKey, SceneMaterialParameterAssignment>>
  >;
  functionSummaryMap: Readonly<
    Partial<Record<RegionScalarParamKey, MaterialFunctionFieldSummary>>
  >;
  preservedExtraRegionFields: readonly SceneMaterialParameterAssignment[];
}

export interface ScalarParamUiDescriptor {
  key: RegionScalarParamKey;
  modeLabel: (baseline: RegionMaterialOverridesDraft) => string;
  valueLabel: string;
  endLabel: string;
  symbol: ReactNode;
  endSymbol: ReactNode;
  scalarKind: "quantity" | "number";
  units?: readonly [UnitOption, ...UnitOption[]];
  defaultDisplayUnit?: string;
  min?: number;
  step?: number;
}

export const EXCHANGE_DAMPING_DESCRIPTORS: readonly ScalarParamUiDescriptor[] = [
  {
    key: "ms",
    modeLabel: (b) => `Ms (${(b.parentMs / 1e3).toFixed(0)} kA/m on Object)`,
    valueLabel: "Regional Ms (base / inner)",
    endLabel: "Gradient end / outer Ms",
    symbol: (
      <>
        M<sub>s</sub>
      </>
    ),
    endSymbol: (
      <>
        M<sub>s,end</sub>
      </>
    ),
    scalarKind: "quantity",
    units: MAGNETIZATION_UNITS,
    defaultDisplayUnit: "kA/m",
    min: 0,
  },
  {
    key: "aex",
    modeLabel: (b) => `Aex (${(b.parentAex * 1e12).toFixed(1)} pJ/m on Object)`,
    valueLabel: "Regional exchange stiffness (base / inner)",
    endLabel: "Gradient end / outer Aex",
    symbol: (
      <>
        A<sub>ex</sub>
      </>
    ),
    endSymbol: (
      <>
        A<sub>ex,end</sub>
      </>
    ),
    scalarKind: "quantity",
    units: EXCHANGE_UNITS,
    defaultDisplayUnit: "pJ/m",
    min: 0,
  },
  {
    key: "alpha",
    modeLabel: (b) => `Gilbert \u03b1 (${b.parentAlpha} on Object)`,
    valueLabel: "Regional Gilbert damping (base / inner)",
    endLabel: "Gradient end / outer \u03b1",
    symbol: <>&alpha;</>,
    endSymbol: (
      <>
        &alpha;<sub>end</sub>
      </>
    ),
    scalarKind: "number",
    min: 0,
    step: 0.001,
  },
];

export const ANISOTROPY_DMI_DESCRIPTORS: readonly ScalarParamUiDescriptor[] = [
  {
    key: "ku1",
    modeLabel: () => "First-order uniaxial Ku1",
    valueLabel: "Regional Ku1 (base / inner)",
    endLabel: "Gradient end / outer Ku1",
    symbol: (
      <>
        K<sub>u1</sub>
      </>
    ),
    endSymbol: (
      <>
        K<sub>u1,end</sub>
      </>
    ),
    scalarKind: "quantity",
    units: ANISOTROPY_UNITS,
    defaultDisplayUnit: "kJ/m\u00b3",
  },
  {
    key: "ku2",
    modeLabel: () => "Second-order uniaxial Ku2",
    valueLabel: "Regional Ku2 (base / inner)",
    endLabel: "Gradient end / outer Ku2",
    symbol: (
      <>
        K<sub>u2</sub>
      </>
    ),
    endSymbol: (
      <>
        K<sub>u2,end</sub>
      </>
    ),
    scalarKind: "quantity",
    units: ANISOTROPY_UNITS,
    defaultDisplayUnit: "kJ/m\u00b3",
  },
  {
    key: "dind",
    modeLabel: () => "Interfacial DMI (Dind)",
    valueLabel: "Regional Dind (base / inner)",
    endLabel: "Gradient end / outer Dind",
    symbol: (
      <>
        D<sub>ind</sub>
      </>
    ),
    endSymbol: (
      <>
        D<sub>ind,end</sub>
      </>
    ),
    scalarKind: "quantity",
    units: DMI_UNITS,
    defaultDisplayUnit: "mJ/m\u00b2",
  },
  {
    key: "dbulk",
    modeLabel: () => "Bulk DMI (Dbulk)",
    valueLabel: "Regional Dbulk (base / inner)",
    endLabel: "Gradient end / outer Dbulk",
    symbol: (
      <>
        D<sub>bulk</sub>
      </>
    ),
    endSymbol: (
      <>
        D<sub>bulk,end</sub>
      </>
    ),
    scalarKind: "quantity",
    units: DMI_UNITS,
    defaultDisplayUnit: "mJ/m\u00b2",
  },
];

export const CONSTITUTIVE_PARAM_OPTIONS: readonly {
  value: SceneMaterialParameterName;
  label: string;
}[] = [
  { value: "ms", label: "Saturation magnetization (Ms, A/m)" },
  { value: "aex", label: "Exchange stiffness (Aex, J/m)" },
  { value: "alpha", label: "Gilbert damping (\u03b1)" },
  { value: "ku1", label: "Uniaxial Ku1 (J/m\u00b3)" },
  { value: "ku2", label: "Second-order Ku2 (J/m\u00b3)" },
  { value: "dind", label: "Interfacial DMI (Dind, J/m\u00b2)" },
  { value: "dbulk", label: "Bulk DMI (Dbulk, J/m\u00b2)" },
  { value: "anisotropy_axis", label: "Uniaxial axis (ux, uy, uz)" },
];

export function buildScalarParamRows(
  desc: ScalarParamUiDescriptor,
  baseline: RegionMaterialOverridesDraft,
  femLane: boolean,
  materialFieldsData: ReturnType<typeof useModelMaterialFieldsResourceSafe>["data"],
): InspectorRowSpec<RegionMaterialOverridesDraft>[] {
  const modeKey = `${desc.key}Mode` as const;
  const valKey = `${desc.key}Value` as const;
  const endKey = `${desc.key}EndValue` as const;
  const spanKey = `${desc.key}SpanM` as const;
  const dirKey = `${desc.key}Direction` as const;
  const centerKey = `${desc.key}RadialCenter` as const;
  const radiusKey = `${desc.key}RadialRadius` as const;
  const frameKey = `${desc.key}Frame` as const;
  const prioKey = `${desc.key}Priority` as const;
  const conflictKey = `${desc.key}ConflictPolicy` as const;
  const assignmentKey = `${desc.key}AssignmentId` as const;

  const isEditableActive = (d: RegionMaterialOverridesDraft) =>
    d[modeKey] === "constant" ||
    d[modeKey] === "linear_gradient" ||
    d[modeKey] === "radial";

  const conflictOptions = [
    { value: "higher_priority_wins", label: "Higher priority wins" },
    { value: "error", label: "Report conflict error" },
    ...(femLane ? [{ value: "min_mesh_size_wins", label: "Finest mesh wins" }] : []),
  ];

  const primaryValueRow: InspectorRowSpec<RegionMaterialOverridesDraft> =
    desc.scalarKind === "quantity" && desc.units
      ? {
          key: valKey,
          type: "quantity",
          label: desc.valueLabel,
          symbol: desc.symbol,
          units: desc.units,
          defaultDisplayUnit: desc.defaultDisplayUnit,
          min: desc.min,
          showWhen: isEditableActive,
        }
      : {
          key: valKey,
          type: "number",
          label: desc.valueLabel,
          symbol: desc.symbol,
          min: desc.min,
          step: desc.step,
          showWhen: isEditableActive,
        };

  const secondaryEndRow: InspectorRowSpec<RegionMaterialOverridesDraft> =
    desc.scalarKind === "quantity" && desc.units
      ? {
          key: endKey,
          type: "quantity",
          label: desc.endLabel,
          symbol: desc.endSymbol,
          units: desc.units,
          defaultDisplayUnit: desc.defaultDisplayUnit,
          min: desc.min,
          showWhen: (d) => d[modeKey] === "linear_gradient" || d[modeKey] === "radial",
        }
      : {
          key: endKey,
          type: "number",
          label: desc.endLabel,
          symbol: desc.endSymbol,
          min: desc.min,
          step: desc.step,
          showWhen: (d) => d[modeKey] === "linear_gradient" || d[modeKey] === "radial",
        };

  return [
    {
      key: modeKey,
      type: "select",
      label: desc.modeLabel(baseline),
      structural: true,
      options: [
        { value: "inherited", label: "Inherited from Object" },
        { value: "constant", label: "Constant regional override" },
        { value: "linear_gradient", label: "Linear spatial gradient" },
        { value: "radial", label: "Radial profile" },
        ...(baseline[modeKey] === "function"
          ? [{ value: "function", label: "Python function (preserved)" }]
          : []),
      ],
    },
    primaryValueRow,
    secondaryEndRow,
    {
      key: spanKey,
      type: "quantity",
      label: `${desc.key.toUpperCase()} gradient span`,
      symbol: <>L</>,
      units: LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      min: 0,
      minExclusive: true,
      showWhen: (d) => d[modeKey] === "linear_gradient",
      validate: (v) => (v > 0 ? null : "Gradient span must be strictly positive."),
    },
    {
      key: dirKey,
      type: "vector3",
      label: `${desc.key.toUpperCase()} gradient direction`,
      axisPresets: true,
      normalizeAction: true,
      showWhen: (d) => d[modeKey] === "linear_gradient",
      validate: (vec) =>
        vectorNorm(vec) < 1e-12 ? "Gradient direction must be non-zero." : null,
    },
    {
      key: centerKey,
      type: "vector3",
      label: `${desc.key.toUpperCase()} radial center`,
      units: LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      showWhen: (d) => d[modeKey] === "radial",
    },
    {
      key: radiusKey,
      type: "quantity",
      label: `${desc.key.toUpperCase()} radial radius`,
      symbol: <>R</>,
      units: LENGTH_UNITS,
      defaultDisplayUnit: "nm",
      min: 0,
      minExclusive: true,
      showWhen: (d) => d[modeKey] === "radial",
      validate: (v) => (v > 0 ? null : "Radial radius must be strictly positive."),
    },
    {
      key: frameKey,
      type: "segmented",
      label: `${desc.key.toUpperCase()} field frame`,
      options: [
        { value: "object", label: "Object local" },
        { value: "world", label: "World" },
      ],
      showWhen: (d) => d[modeKey] === "linear_gradient" || d[modeKey] === "radial",
    },
    {
      key: prioKey,
      type: "number",
      label: `${desc.key.toUpperCase()} priority`,
      integer: true,
      step: 1,
      showWhen: isEditableActive,
    },
    {
      key: conflictKey,
      type: "select",
      label: `${desc.key.toUpperCase()} conflict policy`,
      options: conflictOptions,
      showWhen: isEditableActive,
    },
    {
      type: "custom",
      wide: true,
      showWhen: (d) => d[modeKey] === "function",
      render: (ctx) => {
        const summary = ctx.draft.functionSummaryMap[desc.key];
        const rawFn = ctx.draft.rawFunctionMap[desc.key];
        return (
          <div
            className="rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2.5 text-xs"
            data-slot={`region-function-summary-${desc.key}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-1.5 font-medium text-[var(--fm-text)]">
              <span>
                Python function ({summary?.frame ?? "object"} frame, read-only &amp; preserved)
              </span>
              {summary?.unit ? <Badge data-tone="info">{summary.unit}</Badge> : null}
            </div>
            {summary ? (
              <div className="mt-1.5 flex flex-col gap-1 text-xs text-[var(--fm-text-muted)]">
                {summary.definition ? (
                  <div>
                    <span className="font-medium text-[var(--fm-text)]">Definition: </span>
                    <code>def {summary.definition}(x, y, z)</code>
                  </div>
                ) : null}
                <div>
                  <span className="font-medium text-[var(--fm-text)]">Equation: </span>
                  <code>{summary.equation}</code>
                </div>
                {summary.locals.map((loc) => (
                  <div key={loc.name}>
                    <span className="font-medium text-[var(--fm-text)]">{loc.name}: </span>
                    <code>{loc.expression}</code>
                  </div>
                ))}
                {summary.parameters.map((param) => (
                  <div key={param.name}>
                    <span className="font-medium text-[var(--fm-text)]">{param.name}: </span>
                    <code>{String(param.value)}</code>
                  </div>
                ))}
              </div>
            ) : rawFn ? (
              <p className="mt-1 text-xs text-[var(--fm-text-muted)]">
                Custom callable assignment <code>{rawFn.assignment_id}</code> preserved in
                SceneDocument.
              </p>
            ) : null}
          </div>
        );
      },
    },
    {
      type: "custom",
      wide: true,
      showWhen: (d) =>
        femLane &&
        d[modeKey] !== "inherited" &&
        materialFieldRealizationRows(d[assignmentKey], materialFieldsData).length > 0,
      render: (ctx) => {
        const rows = materialFieldRealizationRows(
          ctx.draft[assignmentKey],
          materialFieldsData,
        );
        if (rows.length === 0) return null;
        return (
          <div
            className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2 text-xs"
            data-slot={`region-field-realization-${desc.key}`}
          >
            {rows.map((r) => (
              <div key={r.label} className="flex items-baseline justify-between gap-2">
                <span className="text-[var(--fm-text-muted)]">{r.label}</span>
                <span className="font-mono text-[var(--fm-text)]">{r.value}</span>
              </div>
            ))}
          </div>
        );
      },
    },
  ];
}
