"use client";

import { Activity, GitBranch, Layers, Zap } from "lucide-react";

import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

import {
  CURRENT_DENSITY_UNITS,
  TIME_UNITS,
} from "../../../panels/model-roots/SpecInspectorHost";
import {
  encodeTransportScopeOption,
  parseTransportScopeOption,
} from "../../../panels/TransportCollectionFieldsModel";
import {
  EMPTY_SELECT_SENTINEL,
  ResourceSwitcherBar,
} from "../../../panels/transport/transportShared";
import type { InspectorSectionSpec } from "../../../template";
import {
  GLOBAL_TARGET_SENTINEL,
  type SpinTorquePanelDraft,
} from "./transportShared";

export interface MechanismAndDriveSectionOptions {
  pinnedByRef: boolean;
  liveDirtySize: number;
  switcherOptions: ReadonlyArray<{ value: string; label: string }>;
  localResourceId: string;
  onSelectLocalResource: (nextId: string) => void;
  scopes: ReadonlyArray<{ objectId: string; regionId: string; label: string }>;
  knownSpinIds: readonly string[];
  currentDropdownOptions: ReadonlyArray<{ value: string; label: string }>;
}

export function buildMechanismAndDriveSections({
  pinnedByRef,
  liveDirtySize,
  switcherOptions,
  localResourceId,
  onSelectLocalResource,
  scopes,
  knownSpinIds,
  currentDropdownOptions,
}: MechanismAndDriveSectionOptions): InspectorSectionSpec<SpinTorquePanelDraft>[] {
  return [
    ...(!pinnedByRef
      ? [
          {
            id: "stq-switcher",
            title: "Resource selection",
            icon: Zap,
            defaultOpen: true,
            rows: [
              {
                type: "custom" as const,
                wide: true,
                render: () => (
                  <ResourceSwitcherBar
                    disabled={liveDirtySize > 0}
                    label="Resource"
                    newOptionLabel="New spin torque"
                    options={switcherOptions}
                    value={localResourceId}
                    onChange={onSelectLocalResource}
                  />
                ),
              },
            ],
          },
        ]
      : []),
    {
      id: "stq-mechanism",
      title: "Torque mechanism & target scope",
      icon: Zap,
      defaultOpen: true,
      rows: [
        {
          type: "text",
          key: "id",
          label: "Torque ID",
          mono: true,
          disabledReason: (d) =>
            d.exists ? "Committed spin torque IDs are immutable." : null,
          validate: (v) => (!v.trim() ? "Torque ID is required." : null),
        },
        {
          type: "select",
          key: "torqueKind",
          label: "Spin torque model",
          options: [
            {
              value: "zhang_li",
              label: "Zhang-Li CIP adiabatic / non-adiabatic STT",
            },
            {
              value: "slonczewski",
              label: "Slonczewski CPP spin-transfer torque",
            },
            {
              value: "prescribed_sot",
              label: "Prescribed spin-orbit torque (SOT: DL + FL)",
            },
            {
              value: "drift_diffusion_spin_torque",
              label: "3D drift-diffusion spin-accumulation torque",
            },
            {
              value: "interface_cpp",
              label: "Interfacial CPP mixing-conductance torque",
            },
          ],
        },
        {
          type: "custom",
          wide: true,
          showWhen: (d) =>
            !(
              (d.torqueKind === "zhang_li" &&
                d.formulaVersion === "zhang_li.legacy_fullmag.v0") ||
              (d.torqueKind === "slonczewski" &&
                d.formulaVersion === "slonczewski.legacy_fullmag.v0") ||
              (d.torqueKind === "prescribed_sot" &&
                d.formulaVersion === "prescribed_sot.legacy_fullmag.v0")
            ),
          render: (ctx) => {
            const isDrift =
              ctx.draft.torqueKind === "drift_diffusion_spin_torque";
            const currentValue =
              ctx.draft.targetMode === "global" && !isDrift
                ? GLOBAL_TARGET_SENTINEL
                : ctx.draft.targetObjectId
                  ? encodeTransportScopeOption(
                      ctx.draft.targetObjectId,
                      ctx.draft.targetRegionId,
                    )
                  : EMPTY_SELECT_SENTINEL;
            const missingScope =
              ctx.draft.targetMode === "scoped" &&
              Boolean(ctx.draft.targetObjectId) &&
              !scopes.some(
                (s) =>
                  s.objectId === ctx.draft.targetObjectId &&
                  s.regionId === ctx.draft.targetRegionId,
              );

            return (
              <div
                className="flex flex-col gap-1.5"
                data-slot="torque-target-scope"
              >
                <span className="text-xs text-[var(--fm-text-muted)]">
                  Target magnetic object / region (target)
                </span>
                <Select
                  value={currentValue}
                  onValueChange={(nextVal) => {
                    if (nextVal === GLOBAL_TARGET_SENTINEL) {
                      ctx.patchDraft({
                        targetMode: "global",
                        targetObjectId: "",
                        targetRegionId: "",
                      });
                      return;
                    }
                    if (nextVal === EMPTY_SELECT_SENTINEL) {
                      ctx.patchDraft({
                        targetMode: "scoped",
                        targetObjectId: "",
                        targetRegionId: "",
                      });
                      return;
                    }
                    const parsed = parseTransportScopeOption(nextVal);
                    if (parsed) {
                      ctx.patchDraft({
                        targetMode: "scoped",
                        targetObjectId: parsed[0],
                        targetRegionId: parsed[1],
                      });
                    }
                  }}
                >
                  <SelectTrigger aria-label="Torque target scope">
                    <SelectValue placeholder="Select target scope" />
                  </SelectTrigger>
                  <SelectContent align="start" position="popper">
                    <SelectGroup>
                      {!isDrift ? (
                        <SelectItem value={GLOBAL_TARGET_SENTINEL}>
                          Global / omit target
                        </SelectItem>
                      ) : (
                        <SelectItem value={EMPTY_SELECT_SENTINEL}>
                          Select target object or region
                        </SelectItem>
                      )}
                      {missingScope ? (
                        <SelectItem value={currentValue}>
                          {ctx.draft.targetRegionId
                            ? `${ctx.draft.targetObjectId} / ${ctx.draft.targetRegionId} (not in scene)`
                            : `${ctx.draft.targetObjectId} (not in scene)`}
                        </SelectItem>
                      ) : null}
                      {scopes.map((s) => (
                        <SelectItem
                          key={`${s.objectId}:${s.regionId}`}
                          value={encodeTransportScopeOption(
                            s.objectId,
                            s.regionId,
                          )}
                        >
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            );
          },
        },
      ],
    },
    {
      id: "stq-drift-diffusion-solve",
      title: "3D spin-accumulation solve binding",
      icon: GitBranch,
      defaultOpen: true,
      showWhen: (d) => d.torqueKind === "drift_diffusion_spin_torque",
      rows: [
        {
          type: "custom",
          wide: true,
          render: (ctx) => {
            const curSolve = ctx.draft.solveId.trim();
            const isMissing =
              Boolean(curSolve) && !knownSpinIds.includes(curSolve);
            return (
              <div
                className="flex flex-col gap-1.5"
                data-slot="dd-solve-binding"
              >
                <span className="text-xs text-[var(--fm-text-muted)]">
                  Driving SpinTransport solve (solve_id)
                </span>
                <Select
                  value={curSolve || EMPTY_SELECT_SENTINEL}
                  onValueChange={(nextVal) =>
                    ctx.setField(
                      "solveId",
                      nextVal === EMPTY_SELECT_SENTINEL ? "" : nextVal,
                    )
                  }
                >
                  <SelectTrigger aria-label="Driving SpinTransport solve">
                    <SelectValue placeholder="Select SpinTransport solve_id" />
                  </SelectTrigger>
                  <SelectContent align="start" position="popper">
                    <SelectGroup>
                      <SelectItem value={EMPTY_SELECT_SENTINEL}>
                        Select SpinTransport solve_id
                      </SelectItem>
                      {isMissing ? (
                        <SelectItem value={curSolve}>
                          {curSolve} (not in scene)
                        </SelectItem>
                      ) : null}
                      {knownSpinIds.map((stId) => (
                        <SelectItem key={stId} value={stId}>
                          {stId}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            );
          },
        },
        {
          type: "text",
          key: "formulaVersion",
          label: "Formula version",
          mono: true,
          validate: (v) => (!v.trim() ? "Formula version is required." : null),
        },
        {
          type: "text",
          key: "schemaVersion",
          label: "Schema version",
          mono: true,
          validate: (v) => (!v.trim() ? "Schema version is required." : null),
        },
      ],
    },
    {
      id: "stq-stt-current",
      title: "Driving current binding",
      icon: Layers,
      defaultOpen: true,
      showWhen: (d) =>
        d.torqueKind === "zhang_li" ||
        d.torqueKind === "slonczewski" ||
        d.torqueKind === "interface_cpp",
      rows: [
        {
          type: "segmented",
          key: "currentBindingMode",
          label: "Current input mode",
          options: [
            { value: "prescribed_density", label: "Inline J_c" },
            { value: "current_transport", label: "CurrentTransport" },
          ],
        },
        {
          type: "vector3",
          key: "currentDensityVec",
          label: "Current density vector",
          symbol: "J_c",
          units: CURRENT_DENSITY_UNITS,
          defaultDisplayUnit: "GA/m²",
          axisPresets: true,
          showWhen: (d) => d.currentBindingMode === "prescribed_density",
        },
        {
          type: "custom",
          wide: true,
          showWhen: (d) => d.currentBindingMode === "current_transport",
          render: (ctx) => (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-[var(--fm-text-muted)]">
                Current source (current_source)
              </span>
              <Select
                value={ctx.draft.currentSource || EMPTY_SELECT_SENTINEL}
                onValueChange={(nextVal) =>
                  ctx.setField(
                    "currentSource",
                    nextVal === EMPTY_SELECT_SENTINEL ? "" : nextVal,
                  )
                }
              >
                <SelectTrigger aria-label="Current source">
                  <SelectValue placeholder="Select charge transport" />
                </SelectTrigger>
                <SelectContent align="start" position="popper">
                  <SelectGroup>
                    <SelectItem value={EMPTY_SELECT_SENTINEL}>
                      Select charge transport
                    </SelectItem>
                    {currentDropdownOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          ),
        },
      ],
    },
  ];
}

export function buildTemporalModulationSection(): InspectorSectionSpec<SpinTorquePanelDraft> {
  return {
    id: "stq-temporal-modulation",
    title: "Temporal drive modulation (pulse / TimeExpressionIR)",
    icon: Activity,
    defaultOpen: true,
    showWhen: (d) =>
      ((d.torqueKind === "slonczewski" &&
        d.formulaVersion === "slonczewski.fullmag.v2") ||
        d.torqueKind === "interface_cpp") &&
      d.currentBindingMode === "prescribed_density",
    rows: [
      {
        type: "segmented",
        key: "timeProfileKind",
        label: "Temporal profile",
        options: [
          { value: "constant", label: "Steady DC" },
          { value: "pulse", label: "Gate pulse" },
          { value: "expression", label: "f(t) Expression" },
        ],
      },
      {
        type: "number",
        key: "pulseAmplitude",
        label: "Pulse scale amplitude",
        step: 0.1,
        showWhen: (d) => d.timeProfileKind === "pulse",
      },
      {
        type: "quantity",
        key: "pulseTOnS",
        label: "Pulse turn-on time",
        symbol: "t_on",
        units: TIME_UNITS,
        defaultDisplayUnit: "ns",
        min: 0,
        showWhen: (d) => d.timeProfileKind === "pulse",
      },
      {
        type: "quantity",
        key: "pulseTOffS",
        label: "Pulse turn-off time",
        symbol: "t_off",
        units: TIME_UNITS,
        defaultDisplayUnit: "ns",
        min: 0,
        minExclusive: true,
        showWhen: (d) => d.timeProfileKind === "pulse",
      },
      {
        type: "expression",
        key: "exprSource",
        label: "Time expression source f(t)",
        placeholder: "sin(2 * pi * f * t)",
        allowedVariables: ["t", "pi"],
        showWhen: (d) => d.timeProfileKind === "expression",
        validate: (v) =>
          !v.trim() ? "Enter a non-empty time expression formula." : null,
      },
      {
        type: "expression",
        key: "exprConstantsJson",
        label: "Expression constants (JSON map)",
        placeholder: '{"f": 4e9, "on": 1e-11}',
        showWhen: (d) => d.timeProfileKind === "expression",
      },
      {
        type: "custom",
        wide: true,
        showWhen: (d) => d.timeProfileKind === "expression",
        render: (ctx) => (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">
              Discontinuity event_times_s (comma-separated seconds)
            </span>
            <Input
              aria-label="Discontinuity event_times_s"
              className="font-mono"
              placeholder="e.g. 1e-11, 5e-11"
              value={ctx.draft.exprEventTimesText}
              onChange={(e) =>
                ctx.setField("exprEventTimesText", e.target.value)
              }
            />
          </div>
        ),
      },
    ],
  };
}
