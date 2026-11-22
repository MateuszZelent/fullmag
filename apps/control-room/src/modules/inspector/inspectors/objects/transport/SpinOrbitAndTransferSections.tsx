"use client";

import { Compass, Sliders, Sparkles } from "lucide-react";

import { Button } from "@/shared/ui/Button";
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
  LENGTH_UNITS,
} from "../../../panels/model-roots/SpecInspectorHost";
import { SceneTimeEnvelopeEditor } from "../../../panels/transport/TimeEnvelopeEditors";
import { EMPTY_SELECT_SENTINEL } from "../../../panels/transport/transportShared";
import type { InspectorSectionSpec } from "../../../template";
import {
  computeAutoHallPolarization,
  NO_FIXED_LAYER_SENTINEL,
  NO_OPERATOR_SENTINEL,
  NO_REALIZATION_SENTINEL,
  type SpinTorquePanelDraft,
} from "./transportShared";

export interface SpinOrbitAndTransferSectionOptions {
  currentDropdownOptions: ReadonlyArray<{ value: string; label: string }>;
}

export function buildSpinOrbitAndTransferSections({
  currentDropdownOptions,
}: SpinOrbitAndTransferSectionOptions): InspectorSectionSpec<SpinTorquePanelDraft>[] {
  return [
    {
      id: "stq-zhang-li-params",
      title: "Zhang-Li adiabatic & operator parameters",
      icon: Sliders,
      defaultOpen: true,
      showWhen: (d) => d.torqueKind === "zhang_li",
      rows: [
        {
          type: "number",
          key: "degree",
          label: "Spin polarization degree",
          symbol: "P",
          min: 1e-6,
          max: 0.999999,
          step: 0.05,
          validate: (v) =>
            v <= 0 || v >= 1
              ? "Zhang-Li polarization P must lie strictly in (0, 1)."
              : null,
        },
        {
          type: "number",
          key: "beta",
          label: "Non-adiabaticity parameter",
          symbol: "β",
          min: 0,
          step: 0.01,
        },
        {
          type: "select",
          key: "formulaVersion",
          label: "Zhang-Li formula version",
          options: [
            {
              value: "zhang_li.legacy_fullmag.v0",
              label: "Legacy global (zhang_li.legacy_fullmag.v0)",
            },
            {
              value: "zhang_li.fullmag.v1",
              label: "Canonical FullMag v1 (zhang_li.fullmag.v1)",
            },
            {
              value: "zhang_li.mumax3.v1",
              label: "MuMax3 compatible v1 (zhang_li.mumax3.v1, g=2)",
            },
          ],
        },
        {
          type: "custom",
          wide: true,
          showWhen: (d) => d.formulaVersion !== "zhang_li.legacy_fullmag.v0",
          render: (ctx) => (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-[var(--fm-text-muted)]">
                Spatial gradient operator (operator_version)
              </span>
              <Select
                value={ctx.draft.operatorVersion || NO_OPERATOR_SENTINEL}
                onValueChange={(nextVal) =>
                  ctx.setField(
                    "operatorVersion",
                    nextVal === NO_OPERATOR_SENTINEL ? "" : nextVal,
                  )
                }
              >
                <SelectTrigger aria-label="Zhang-Li operator version">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start" position="popper">
                  <SelectGroup>
                    <SelectItem value={NO_OPERATOR_SENTINEL}>
                      Omit operator_version
                    </SelectItem>
                    <SelectItem value="zl_central_reference_v1">
                      Central reference v1 (zl_central_reference_v1)
                    </SelectItem>
                    <SelectItem value="zl_mumax3_central_v1">
                      MuMax3 central v1 (zl_mumax3_central_v1)
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          ),
        },
        {
          type: "text",
          key: "landeGText",
          label: "Landé g-factor (lande_g)",
          mono: true,
          showWhen: (d) => d.formulaVersion !== "zhang_li.legacy_fullmag.v0",
          validate: (v) =>
            v.trim() && (!Number.isFinite(Number(v)) || Number(v) <= 0)
              ? "Landé g-factor must be positive and finite."
              : null,
        },
        {
          type: "text",
          key: "schemaVersion",
          label: "Schema version",
          mono: true,
          showWhen: (d) => d.formulaVersion !== "zhang_li.legacy_fullmag.v0",
        },
      ],
    },
    {
      id: "stq-slonczewski-params",
      title: "Slonczewski CPP parameters & realization",
      icon: Compass,
      defaultOpen: true,
      showWhen: (d) => d.torqueKind === "slonczewski",
      rows: [
        {
          type: "number",
          key: "degree",
          label: "Spin polarization degree",
          symbol: "P",
          min: 1e-6,
          max: 0.999999,
          step: 0.05,
          validate: (v) =>
            v <= 0 || v >= 1
              ? "Slonczewski polarization P must lie strictly in (0, 1)."
              : null,
        },
        {
          type: "number",
          key: "lambdaAsymmetry",
          label: "Slonczewski asymmetry",
          symbol: "Λ",
          min: 1,
          step: 0.1,
        },
        {
          type: "number",
          key: "epsilonPrime",
          label: "Secondary field-like STT term",
          symbol: "ε'",
          step: 0.01,
        },
        {
          type: "vector3",
          key: "spinPolarizationVec",
          label: "Fixed-layer polarization",
          symbol: "p̂",
          axisPresets: true,
          normalizeAction: true,
        },
        {
          type: "select",
          key: "formulaVersion",
          label: "Slonczewski formula version",
          options: [
            {
              value: "slonczewski.fullmag.v2",
              label: "Canonical thin-layer v2 (slonczewski.fullmag.v2)",
            },
            {
              value: "slonczewski.legacy_fullmag.v0",
              label: "Legacy top/bottom v0 (slonczewski.legacy_fullmag.v0)",
            },
          ],
        },
        {
          type: "vector3",
          key: "stackNormalVec",
          label: "Stack normal",
          symbol: "n̂",
          axisPresets: true,
          normalizeAction: true,
          showWhen: (d) =>
            d.formulaVersion !== "slonczewski.legacy_fullmag.v0",
        },
        {
          type: "switch",
          key: "hasFreeLayerThickness",
          label: "Specify explicit free-layer thickness t_FM",
        },
        {
          type: "quantity",
          key: "freeLayerThicknessM",
          label: "Free-layer thickness",
          symbol: "t_FM",
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.hasFreeLayerThickness,
        },
        {
          type: "custom",
          wide: true,
          showWhen: (d) =>
            d.formulaVersion === "slonczewski.legacy_fullmag.v0",
          render: (ctx) => (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-[var(--fm-text-muted)]">
                Fixed-layer position (fixed_layer_position)
              </span>
              <Select
                value={ctx.draft.fixedLayerPosition || NO_FIXED_LAYER_SENTINEL}
                onValueChange={(nextVal) =>
                  ctx.setField(
                    "fixedLayerPosition",
                    nextVal === NO_FIXED_LAYER_SENTINEL
                      ? ""
                      : (nextVal as "top" | "bottom"),
                  )
                }
              >
                <SelectTrigger aria-label="Fixed-layer position">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start" position="popper">
                  <SelectGroup>
                    <SelectItem value={NO_FIXED_LAYER_SENTINEL}>
                      Select fixed-layer position
                    </SelectItem>
                    <SelectItem value="top">Top fixed layer</SelectItem>
                    <SelectItem value="bottom">Bottom fixed layer</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          ),
        },
        {
          type: "custom",
          wide: true,
          showWhen: (d) =>
            d.formulaVersion !== "slonczewski.legacy_fullmag.v0",
          render: (ctx) => (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-[var(--fm-text-muted)]">
                Spatial realization (realization)
              </span>
              <Select
                value={
                  ctx.draft.realizationMode === "none"
                    ? NO_REALIZATION_SENTINEL
                    : ctx.draft.realizationMode
                }
                onValueChange={(nextVal) =>
                  ctx.setField(
                    "realizationMode",
                    nextVal === NO_REALIZATION_SENTINEL
                      ? "none"
                      : (nextVal as "thin_layer_homogenized" | "custom"),
                  )
                }
              >
                <SelectTrigger aria-label="Slonczewski realization">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start" position="popper">
                  <SelectGroup>
                    <SelectItem value="thin_layer_homogenized">
                      Thin-layer homogenized v1
                    </SelectItem>
                    <SelectItem value={NO_REALIZATION_SENTINEL}>
                      Omit realization
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          ),
        },
        {
          type: "text",
          key: "schemaVersion",
          label: "Schema version",
          mono: true,
          showWhen: (d) =>
            d.formulaVersion !== "slonczewski.legacy_fullmag.v0",
        },
      ],
    },
    {
      id: "stq-interface-cpp-params",
      title: "Interfacial CPP mixing-conductance parameters",
      icon: Compass,
      defaultOpen: true,
      showWhen: (d) => d.torqueKind === "interface_cpp",
      rows: [
        {
          type: "number",
          key: "degree",
          label: "Spin polarization degree",
          symbol: "P",
          min: 1e-6,
          max: 1,
          step: 0.05,
          validate: (v) =>
            v <= 0 || v > 1
              ? "Polarization degree P must lie in (0, 1]."
              : null,
        },
        {
          type: "number",
          key: "lambdaAsymmetry",
          label: "CPP conductance asymmetry",
          symbol: "Λ",
          min: 1,
          step: 0.1,
        },
        {
          type: "number",
          key: "epsilonPrime",
          label: "Secondary field-like term",
          symbol: "ε'",
          step: 0.01,
        },
        {
          type: "vector3",
          key: "spinPolarizationVec",
          label: "Spin polarization vector",
          symbol: "p̂",
          axisPresets: true,
          normalizeAction: true,
        },
        {
          type: "vector3",
          key: "interfaceNormalVec",
          label: "Interface normal",
          symbol: "n̂",
          axisPresets: true,
          normalizeAction: true,
        },
      ],
    },
    {
      id: "stq-prescribed-sot",
      title: "Prescribed spin-orbit torque (SOT) drive & efficiencies",
      icon: Sparkles,
      defaultOpen: true,
      showWhen: (d) => d.torqueKind === "prescribed_sot",
      rows: [
        {
          type: "select",
          key: "formulaVersion",
          label: "Prescribed SOT formula version",
          options: [
            {
              value: "prescribed_sot.fullmag.v1",
              label: "Canonical v1 (prescribed_sot.fullmag.v1)",
            },
            {
              value: "prescribed_sot.legacy_fullmag.v0",
              label: "Legacy compatibility v0 (prescribed_sot.legacy_fullmag.v0)",
            },
          ],
        },
        {
          type: "select",
          key: "sotDriveKind",
          label: "SOT drive formulation (drive.kind)",
          options: [
            {
              value: "signed_scalar",
              label: "Signed scalar current density J_c + σ̂",
            },
            {
              value: "vector_current_source",
              label: "Vector CurrentTransport source + (n̂, d̂)",
            },
            {
              value: "legacy_scalar_magnitude",
              label: "Legacy scalar magnitude",
            },
            {
              value: "legacy_current_source_norm",
              label: "Legacy current source norm",
            },
          ],
        },
        {
          type: "quantity",
          key: "signedCurrentDensityApm2",
          label: "Signed charge current density",
          symbol: "J_c",
          units: CURRENT_DENSITY_UNITS,
          defaultDisplayUnit: "GA/m²",
          showWhen: (d) => d.sotDriveKind === "signed_scalar",
        },
        {
          type: "vector3",
          key: "sigmaHatVec",
          label: "Spin-Hall polarization unit vector",
          symbol: "σ̂",
          axisPresets: true,
          normalizeAction: true,
          showWhen: (d) => d.sotDriveKind === "signed_scalar",
        },
        {
          type: "custom",
          wide: true,
          showWhen: (d) => d.sotDriveKind === "signed_scalar",
          render: (ctx) => (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-[var(--fm-text-muted)]">
                  Spin-Hall cross-product helper (n̂ × d̂)
                </span>
                <Button
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    const autoSigma = computeAutoHallPolarization(
                      ctx.draft.sotInterfaceNormalVec,
                      ctx.draft.driveDirectionVec,
                    );
                    ctx.setField("sigmaHatVec", autoSigma);
                  }}
                >
                  <Sparkles aria-hidden="true" size={12} />
                  <span>Auto Hall σ̂ = n̂ × d̂</span>
                </Button>
              </div>
              <SceneTimeEnvelopeEditor
                label="SOT drive envelope"
                valueJson={ctx.draft.sotEnvelopeJson}
                onChangeJson={(nextJson) =>
                  ctx.setField("sotEnvelopeJson", nextJson)
                }
              />
            </div>
          ),
        },
        {
          type: "custom",
          wide: true,
          showWhen: (d) =>
            d.sotDriveKind === "vector_current_source" ||
            d.sotDriveKind === "legacy_current_source_norm",
          render: (ctx) => (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-[var(--fm-text-muted)]">
                Driving charge transport (current_source_id)
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
                <SelectTrigger aria-label="SOT current source">
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
        {
          type: "vector3",
          key: "driveDirectionVec",
          label: "Reference current drive direction",
          symbol: "d̂",
          axisPresets: true,
          normalizeAction: true,
          showWhen: (d) => d.sotDriveKind === "vector_current_source",
        },
        {
          type: "vector3",
          key: "sotInterfaceNormalVec",
          label: "HM → FM interface normal",
          symbol: "n̂",
          axisPresets: true,
          normalizeAction: true,
          showWhen: (d) => d.sotDriveKind === "vector_current_source",
        },
        {
          type: "quantity",
          key: "legacyScalarMagnitudeApm2",
          label: "Legacy scalar current magnitude",
          symbol: "|J_c|",
          units: CURRENT_DENSITY_UNITS,
          defaultDisplayUnit: "GA/m²",
          showWhen: (d) => d.sotDriveKind === "legacy_scalar_magnitude",
        },
        {
          type: "number",
          key: "xiDl",
          label: "Damping-like SOT efficiency",
          symbol: "ξ_DL",
          step: 0.01,
        },
        {
          type: "number",
          key: "xiFl",
          label: "Field-like SOT efficiency",
          symbol: "ξ_FL",
          step: 0.01,
        },
        {
          type: "quantity",
          key: "freeLayerThicknessM",
          label: "Ferromagnet layer thickness",
          symbol: "t_FM",
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
        },
        {
          type: "text",
          key: "rawSpinPolarizationText",
          label: "Legacy raw spin polarization (px, py, pz)",
          mono: true,
          showWhen: (d) =>
            d.formulaVersion === "prescribed_sot.legacy_fullmag.v0",
        },
        {
          type: "expression",
          key: "compatibilityOriginJson",
          label: "Legacy compatibility origin (JSON)",
          placeholder:
            '{"source_ir_version":"0.2.0","authored_kind":"spin_orbit_torque"}',
          showWhen: (d) =>
            d.formulaVersion === "prescribed_sot.legacy_fullmag.v0",
        },
      ],
    },
  ];
}
