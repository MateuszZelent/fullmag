"use client";

import {
  Activity,
  Compass,
  FileCode2,
  GitBranch,
  Layers,
  RefreshCw,
  Sliders,
  Sparkles,
  Zap,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type {
  SceneSpinTorque,
  SpinTorqueMutationRequest,
  TransportValidationRequest,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  useCurrentTransportsResource,
  useSpinTorquesResource,
  useSpinTransportsResource,
} from "@/kernel/resources/spinAuthoringResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { isUnsupportedSpinAuthoringResource } from "@/shared/domain/physics/spinAuthoringRecognition";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  useInspectorSpecController,
  type InspectorBreadcrumbItem,
  type InspectorSpec,
} from "../../template";
import {
  CURRENT_DENSITY_UNITS,
  LENGTH_UNITS,
  TIME_UNITS,
} from "../model-roots/SpecInspectorHost";
import { reconcileSpinAuthoringDraft } from "../spinAuthoringDraft";
import {
  currentSourceOptions,
  torqueCurrentBindingPatch,
  type TorqueCurrentBinding,
} from "../SpinAuthoringInspectorModel";
import {
  encodeTransportScopeOption,
  parseTransportScopeOption,
  transportScopeOptions,
} from "../TransportCollectionFieldsModel";
import { SceneTimeEnvelopeEditor } from "./TimeEnvelopeEditors";
import {
  buildValidationDetails,
  buildValidationNotices,
  computeTransportLockReason,
  EMPTY_SELECT_SENTINEL,
  evaluateSpinM1Capability,
  executeAuthoringHistoryCommit,
  extractInitialRegionId,
  isEditableSpinTransport,
  type KnownSceneSpinTorque,
  ReadOnlyOpaqueInspector,
  RESOURCE_KEYS,
  ResourceSwitcherBar,
  runPreCommitTransportValidation,
  type SceneCompatibilityOrigin,
  type ScenePrescribedSotDrive,
  type SceneRegionRef,
  type SceneTimeEnvelope,
  type SlonczewskiRealization,
  TRANSPORT_VALIDATION_VERSION,
  TransportTemplateRenderer,
  useAuthoringSceneData,
  useDebouncedTransportValidation,
  useThreeWayConflictState,
  useTransportSessionContext,
} from "./transportShared";

const GLOBAL_TARGET_SENTINEL = "__fm_torque_global_target__";
const NO_OPERATOR_SENTINEL = "__fm_zl_no_operator__";
const NO_FIXED_LAYER_SENTINEL = "__fm_slon_no_fixed_layer__";
const NO_REALIZATION_SENTINEL = "__fm_slon_no_realization__";

export type TorqueKindUi =
  | "zhang_li"
  | "slonczewski"
  | "prescribed_sot"
  | "drift_diffusion_spin_torque"
  | "interface_cpp";

export type SotDriveKindUi =
  | "signed_scalar"
  | "vector_current_source"
  | "legacy_scalar_magnitude"
  | "legacy_current_source_norm";

export type TorqueTimeProfileKind = "constant" | "pulse" | "expression";

/** Computes the right-handed Spin-Hall spin polarization σ̂ = normalize(n̂ × Ĵ). */
export function computeAutoHallPolarization(
  stackNormal: readonly [number, number, number],
  currentDir: readonly [number, number, number],
): [number, number, number] {
  const cx = stackNormal[1] * currentDir[2] - stackNormal[2] * currentDir[1];
  const cy = stackNormal[2] * currentDir[0] - stackNormal[0] * currentDir[2];
  const cz = stackNormal[0] * currentDir[1] - stackNormal[1] * currentDir[0];
  const norm = Math.hypot(cx, cy, cz);
  if (norm <= 1e-12) {
    return Math.abs(stackNormal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  }
  return [
    Number((cx / norm).toPrecision(12)),
    Number((cy / norm).toPrecision(12)),
    Number((cz / norm).toPrecision(12)),
  ];
}

function isVec3Tuple(v: unknown): v is [number, number, number] {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((x) => typeof x === "number" && Number.isFinite(x))
  );
}

function isRegionRefObj(v: unknown): v is SceneRegionRef {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.object_id === "string" &&
    Boolean(r.object_id.trim()) &&
    (r.region_id === undefined ||
      r.region_id === null ||
      typeof r.region_id === "string")
  );
}

export function isSupportedSpinTorqueRecord(resource: SceneSpinTorque): boolean {
  const rec = resource as Record<string, unknown>;
  const kind = rec.kind;
  if (
    kind === "zhang_li" ||
    kind === "slonczewski" ||
    kind === "prescribed_sot"
  ) {
    return !isUnsupportedSpinAuthoringResource("spin_torque", resource);
  }
  if (kind === "drift_diffusion_spin_torque") {
    return (
      typeof rec.id === "string" &&
      Boolean(rec.id.trim()) &&
      typeof rec.solve_id === "string" &&
      Boolean(rec.solve_id.trim()) &&
      isRegionRefObj(rec.target) &&
      typeof rec.schema_version === "string" &&
      typeof rec.formula_version === "string"
    );
  }
  if (kind === "interface_cpp") {
    const hasCurrent =
      (isVec3Tuple(rec.current_density) ? 1 : 0) +
        (typeof rec.current_source === "string" && Boolean(rec.current_source.trim())
          ? 1
          : 0) ===
      1;
    return (
      (rec.id === undefined || typeof rec.id === "string") &&
      hasCurrent &&
      typeof rec.degree === "number" &&
      Number.isFinite(rec.degree) &&
      typeof rec.lambda_asymmetry === "number" &&
      Number.isFinite(rec.lambda_asymmetry) &&
      isVec3Tuple(rec.spin_polarization) &&
      isVec3Tuple(rec.interface_normal)
    );
  }
  if (kind === "spin_orbit_torque") {
    return (
      typeof rec.damping_like_efficiency === "number" &&
      Number.isFinite(rec.damping_like_efficiency) &&
      isVec3Tuple(rec.spin_polarization) &&
      typeof rec.ferromagnet_thickness_m === "number" &&
      Number.isFinite(rec.ferromagnet_thickness_m)
    );
  }
  return false;
}

export interface SpinTorquePanelDraft {
  exists: boolean;
  id: string;
  torqueKind: TorqueKindUi;
  targetMode: "global" | "scoped";
  targetObjectId: string;
  targetRegionId: string;

  // Current binding for zhang_li / slonczewski / interface_cpp
  currentBindingMode: TorqueCurrentBinding;
  currentSource: string;
  currentDensityVec: readonly [number, number, number];

  // Drift-diffusion solve binding
  solveId: string;

  // Shared STT parameters
  degree: number;
  beta: number;
  lambdaAsymmetry: number;
  epsilonPrime: number;
  spinPolarizationVec: readonly [number, number, number];
  stackNormalVec: readonly [number, number, number];
  interfaceNormalVec: readonly [number, number, number];
  hasFreeLayerThickness: boolean;
  freeLayerThicknessM: number;
  fixedLayerPosition: "" | "top" | "bottom";
  realizationMode: "none" | "thin_layer_homogenized" | "custom";
  realizationJson: string;

  // Formula / operator / schema versions
  formulaVersion: string;
  schemaVersion: string;
  operatorVersion: string;
  landeGText: string;

  // Prescribed SOT parameters
  sotDriveKind: SotDriveKindUi;
  signedCurrentDensityApm2: number;
  sigmaHatVec: readonly [number, number, number];
  sotEnvelopeJson: string;
  driveDirectionVec: readonly [number, number, number];
  sotInterfaceNormalVec: readonly [number, number, number];
  legacyScalarMagnitudeApm2: number;
  xiDl: number;
  xiFl: number;
  rawSpinPolarizationText: string;
  compatibilityOriginJson: string;

  // Temporal modulation (TimeExpressionIR / pulse)
  timeProfileKind: TorqueTimeProfileKind;
  pulseAmplitude: number;
  pulseTOnS: number;
  pulseTOffS: number;
  exprSource: string;
  exprConstantsJson: string;
  exprEventTimesText: string;
}

function hydrateTorquePanelDraft(
  record: SceneSpinTorque | null,
  initialScope: { objectId: string; regionId?: string | null } | null,
  exists: boolean,
  defaultSolveId: string,
  defaultCurrentSource: string,
): SpinTorquePanelDraft {
  const rec = (record ?? {}) as Record<string, unknown>;
  const rawKind = typeof rec.kind === "string" ? rec.kind : "";

  let torqueKind: TorqueKindUi = "zhang_li";
  if (rawKind === "slonczewski") torqueKind = "slonczewski";
  else if (rawKind === "prescribed_sot" || rawKind === "spin_orbit_torque") {
    torqueKind = "prescribed_sot";
  } else if (rawKind === "drift_diffusion_spin_torque") {
    torqueKind = "drift_diffusion_spin_torque";
  } else if (rawKind === "interface_cpp") {
    torqueKind = "interface_cpp";
  }

  const targetObj = isRegionRefObj(rec.target) ? rec.target : null;
  const hasInitialScope = !record && Boolean(initialScope?.objectId);
  const targetMode: "global" | "scoped" = targetObj
    ? "scoped"
    : hasInitialScope
      ? "scoped"
      : "global";
  const targetObjectId = targetObj?.object_id ?? initialScope?.objectId ?? "";
  const targetRegionId =
    (typeof targetObj?.region_id === "string" ? targetObj.region_id : "") ||
    (hasInitialScope ? (initialScope?.regionId ?? "") : "");

  const hasNamedCurrent =
    typeof rec.current_source === "string" && Boolean(rec.current_source.trim());
  const currentBindingMode: TorqueCurrentBinding = hasNamedCurrent
    ? "current_transport"
    : "prescribed_density";
  const currentSource = hasNamedCurrent
    ? String(rec.current_source)
    : defaultCurrentSource;
  const currentDensityVec: readonly [number, number, number] = isVec3Tuple(
    rec.current_density,
  )
    ? [rec.current_density[0], rec.current_density[1], rec.current_density[2]]
    : [1e11, 0, 0];

  // SOT Drive hydration
  const driveRec =
    rec.drive && typeof rec.drive === "object" && !Array.isArray(rec.drive)
      ? (rec.drive as Record<string, unknown>)
      : null;
  let sotDriveKind: SotDriveKindUi = "signed_scalar";
  if (driveRec?.kind === "vector_current_source") {
    sotDriveKind = "vector_current_source";
  } else if (driveRec?.kind === "legacy_scalar_magnitude") {
    sotDriveKind = "legacy_scalar_magnitude";
  } else if (driveRec?.kind === "legacy_current_source_norm") {
    sotDriveKind = "legacy_current_source_norm";
  }

  const signedCurrentDensityApm2 =
    typeof driveRec?.current_density_Apm2 === "number" &&
    Number.isFinite(driveRec.current_density_Apm2)
      ? driveRec.current_density_Apm2
      : typeof rec.charge_current_density_a_per_m2 === "number" &&
          Number.isFinite(rec.charge_current_density_a_per_m2)
        ? rec.charge_current_density_a_per_m2
        : 1e11;

  const sigmaHatVec: readonly [number, number, number] = isVec3Tuple(
    driveRec?.sigma_hat,
  )
    ? [driveRec.sigma_hat[0], driveRec.sigma_hat[1], driveRec.sigma_hat[2]]
    : isVec3Tuple(rec.spin_polarization)
      ? [
          rec.spin_polarization[0],
          rec.spin_polarization[1],
          rec.spin_polarization[2],
        ]
      : [0, 1, 0];

  const sotEnvelopeObj =
    driveRec?.envelope &&
    typeof driveRec.envelope === "object" &&
    !Array.isArray(driveRec.envelope)
      ? (driveRec.envelope as SceneTimeEnvelope)
      : null;
  const sotEnvelopeJson = sotEnvelopeObj
    ? JSON.stringify(sotEnvelopeObj, null, 2)
    : "{}";

  const driveDirectionVec: readonly [number, number, number] = isVec3Tuple(
    driveRec?.drive_direction,
  )
    ? [
        driveRec.drive_direction[0],
        driveRec.drive_direction[1],
        driveRec.drive_direction[2],
      ]
    : [1, 0, 0];

  const sotInterfaceNormalVec: readonly [number, number, number] = isVec3Tuple(
    driveRec?.interface_normal,
  )
    ? [
        driveRec.interface_normal[0],
        driveRec.interface_normal[1],
        driveRec.interface_normal[2],
      ]
    : [0, 0, 1];

  const sotCurrentSource =
    typeof driveRec?.current_source_id === "string" &&
    driveRec.current_source_id.trim()
      ? driveRec.current_source_id
      : currentSource;

  // Realization hydration
  const realizationObj =
    rec.realization &&
    typeof rec.realization === "object" &&
    !Array.isArray(rec.realization)
      ? (rec.realization as Record<string, unknown>)
      : null;
  const realizationMode: "none" | "thin_layer_homogenized" | "custom" =
    !realizationObj
      ? torqueKind === "slonczewski" && !record
        ? "thin_layer_homogenized"
        : "none"
      : realizationObj.kind === "thin_layer_homogenized" &&
          realizationObj.realization_version ===
            "slonczewski_thin_layer_homogenized.v1"
        ? "thin_layer_homogenized"
        : "custom";

  // Temporal modulation (`time_expression`) hydration
  const timeExprObj =
    rec.time_expression &&
    typeof rec.time_expression === "object" &&
    !Array.isArray(rec.time_expression)
      ? (rec.time_expression as Record<string, unknown>)
      : null;

  let timeProfileKind: TorqueTimeProfileKind = "constant";
  let pulseAmplitude = 1;
  let pulseTOnS = 0;
  let pulseTOffS = 1e-9;
  let exprSource = "sin(2 * pi * f * t)";
  let exprConstantsJson = '{"f": 1e9}';
  let exprEventTimesText = "";

  if (timeExprObj && typeof timeExprObj.source === "string") {
    const consts =
      timeExprObj.constants &&
      typeof timeExprObj.constants === "object" &&
      !Array.isArray(timeExprObj.constants)
        ? (timeExprObj.constants as Record<string, number>)
        : {};
    const events = Array.isArray(timeExprObj.event_times_s)
      ? (timeExprObj.event_times_s as number[])
      : [];

    if (
      timeExprObj.source ===
        "amp * (heaviside(t - t_on) - heaviside(t - t_off))" &&
      typeof consts.t_on === "number" &&
      typeof consts.t_off === "number"
    ) {
      timeProfileKind = "pulse";
      pulseAmplitude = typeof consts.amp === "number" ? consts.amp : 1;
      pulseTOnS = consts.t_on;
      pulseTOffS = consts.t_off;
    } else {
      timeProfileKind = "expression";
      exprSource = timeExprObj.source;
      exprConstantsJson = JSON.stringify(consts);
      exprEventTimesText = events.join(", ");
    }
  } else if (sotEnvelopeObj?.kind === "pulse") {
    timeProfileKind = "pulse";
    pulseAmplitude = sotEnvelopeObj.amplitude;
    pulseTOnS = sotEnvelopeObj.t_on_s;
    pulseTOffS = sotEnvelopeObj.t_off_s;
  }

  const defaultFormula =
    torqueKind === "zhang_li"
      ? hasInitialScope
        ? "zhang_li.fullmag.v1"
        : "zhang_li.legacy_fullmag.v0"
      : torqueKind === "slonczewski"
        ? "slonczewski.fullmag.v2"
        : torqueKind === "prescribed_sot"
          ? "prescribed_sot.fullmag.v1"
          : torqueKind === "drift_diffusion_spin_torque"
            ? "drift_diffusion_spin_torque.fullmag.v1"
            : "";

  const formulaVersion =
    typeof rec.formula_version === "string" && rec.formula_version
      ? rec.formula_version
      : defaultFormula;

  const defaultSchema =
    formulaVersion === "zhang_li.fullmag.v1" ||
    formulaVersion === "zhang_li.mumax3.v1"
      ? "zhang_li_torque.v1"
      : formulaVersion === "slonczewski.fullmag.v2"
        ? "slonczewski_torque.v1"
        : torqueKind === "prescribed_sot"
          ? "prescribed_sot.v1"
          : torqueKind === "drift_diffusion_spin_torque"
            ? "drift_diffusion_spin_torque.v1"
            : "";

  const schemaVersion =
    typeof rec.schema_version === "string" ? rec.schema_version : defaultSchema;

  const operatorVersion =
    typeof rec.operator_version === "string"
      ? rec.operator_version
      : formulaVersion === "zhang_li.fullmag.v1" && !record
        ? "zl_central_reference_v1"
        : "";

  const landeGText =
    typeof rec.lande_g === "number" && Number.isFinite(rec.lande_g)
      ? String(rec.lande_g)
      : formulaVersion === "zhang_li.fullmag.v1" && !record
        ? "2"
        : "";

  const rawThickness =
    typeof rec.free_layer_thickness_m === "number" &&
    Number.isFinite(rec.free_layer_thickness_m)
      ? rec.free_layer_thickness_m
      : typeof rec.ferromagnet_thickness_m === "number" &&
          Number.isFinite(rec.ferromagnet_thickness_m)
        ? rec.ferromagnet_thickness_m
        : null;

  return {
    exists,
    id:
      typeof rec.id === "string" && rec.id.trim() ? rec.id : "spin-torque",
    torqueKind,
    targetMode,
    targetObjectId,
    targetRegionId,
    currentBindingMode,
    currentSource:
      torqueKind === "prescribed_sot" ? sotCurrentSource : currentSource,
    currentDensityVec,
    solveId:
      typeof rec.solve_id === "string" && rec.solve_id.trim()
        ? rec.solve_id
        : defaultSolveId,
    degree:
      typeof rec.degree === "number" && Number.isFinite(rec.degree)
        ? rec.degree
        : 0.5,
    beta:
      typeof rec.beta === "number" && Number.isFinite(rec.beta)
        ? rec.beta
        : 0.02,
    lambdaAsymmetry:
      typeof rec.lambda_asymmetry === "number" &&
      Number.isFinite(rec.lambda_asymmetry)
        ? rec.lambda_asymmetry
        : 1.2,
    epsilonPrime:
      typeof rec.epsilon_prime === "number" && Number.isFinite(rec.epsilon_prime)
        ? rec.epsilon_prime
        : 0,
    spinPolarizationVec: isVec3Tuple(rec.spin_polarization)
      ? [
          rec.spin_polarization[0],
          rec.spin_polarization[1],
          rec.spin_polarization[2],
        ]
      : [0, 0, 1],
    stackNormalVec: isVec3Tuple(rec.stack_normal)
      ? [rec.stack_normal[0], rec.stack_normal[1], rec.stack_normal[2]]
      : [0, 0, 1],
    interfaceNormalVec: isVec3Tuple(rec.interface_normal)
      ? [
          rec.interface_normal[0],
          rec.interface_normal[1],
          rec.interface_normal[2],
        ]
      : [0, 0, 1],
    hasFreeLayerThickness:
      rawThickness !== null ||
      formulaVersion === "slonczewski.fullmag.v2" ||
      torqueKind === "prescribed_sot",
    freeLayerThicknessM: rawThickness ?? 1.2e-9,
    fixedLayerPosition:
      rec.fixed_layer_position === "top" || rec.fixed_layer_position === "bottom"
        ? rec.fixed_layer_position
        : "",
    realizationMode,
    realizationJson: realizationObj ? JSON.stringify(realizationObj) : "",
    formulaVersion,
    schemaVersion,
    operatorVersion,
    landeGText,
    sotDriveKind,
    signedCurrentDensityApm2,
    sigmaHatVec,
    sotEnvelopeJson,
    driveDirectionVec,
    sotInterfaceNormalVec,
    legacyScalarMagnitudeApm2:
      typeof driveRec?.raw_charge_current_density_Apm2 === "number"
        ? driveRec.raw_charge_current_density_Apm2
        : 1e11,
    xiDl:
      typeof rec.xi_dl === "number" && Number.isFinite(rec.xi_dl)
        ? rec.xi_dl
        : typeof rec.damping_like_efficiency === "number"
          ? rec.damping_like_efficiency
          : 0.08,
    xiFl:
      typeof rec.xi_fl === "number" && Number.isFinite(rec.xi_fl)
        ? rec.xi_fl
        : typeof rec.field_like_efficiency === "number"
          ? rec.field_like_efficiency
          : -0.02,
    rawSpinPolarizationText: isVec3Tuple(rec.raw_spin_polarization)
      ? rec.raw_spin_polarization.join(", ")
      : "",
    compatibilityOriginJson: rec.compatibility_origin
      ? JSON.stringify(rec.compatibility_origin)
      : "",
    timeProfileKind,
    pulseAmplitude,
    pulseTOnS,
    pulseTOffS,
    exprSource,
    exprConstantsJson,
    exprEventTimesText,
  };
}

function buildTimeExpressionPayload(
  draft: SpinTorquePanelDraft,
): Record<string, unknown> | undefined {
  if (draft.timeProfileKind === "constant") return undefined;
  if (draft.timeProfileKind === "pulse") {
    if (
      !Number.isFinite(draft.pulseAmplitude) ||
      !Number.isFinite(draft.pulseTOnS) ||
      !Number.isFinite(draft.pulseTOffS) ||
      draft.pulseTOnS < 0 ||
      draft.pulseTOffS <= draft.pulseTOnS
    ) {
      throw new Error(
        "Pulse temporal modulation requires finite 0 <= t_on < t_off.",
      );
    }
    return {
      source: "amp * (heaviside(t - t_on) - heaviside(t - t_off))",
      constants: {
        amp: draft.pulseAmplitude,
        t_on: draft.pulseTOnS,
        t_off: draft.pulseTOffS,
      },
      event_times_s: [draft.pulseTOnS, draft.pulseTOffS],
    };
  }
  const src = draft.exprSource.trim();
  if (!src) {
    throw new Error("Time expression formula source is required.");
  }
  let constants: Record<string, number> = {};
  if (draft.exprConstantsJson.trim() && draft.exprConstantsJson.trim() !== "{}") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft.exprConstantsJson);
    } catch {
      throw new Error("Time expression constants must be valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Time expression constants must be a JSON object.");
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        throw new Error(`Time expression constant "${k}" must be finite.`);
      }
      constants[k] = n;
    }
  } else {
    constants = {};
  }

  const eventTimes = draft.exprEventTimesText
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((token) => {
      const n = Number(token);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(
          "Time expression event_times_s must be nonnegative finite seconds.",
        );
      }
      return n;
    });
  for (let i = 1; i < eventTimes.length; i += 1) {
    if (eventTimes[i]! <= eventTimes[i - 1]!) {
      throw new Error(
        "Time expression event_times_s must be strictly increasing.",
      );
    }
  }

  return {
    source: src,
    ...(Object.keys(constants).length > 0 ? { constants } : {}),
    ...(eventTimes.length > 0 ? { event_times_s: eventTimes } : {}),
  };
}

function buildTargetRef(draft: SpinTorquePanelDraft): SceneRegionRef | undefined {
  if (draft.targetMode === "global") return undefined;
  const obj = draft.targetObjectId.trim();
  if (!obj) {
    throw new Error("Select a target object or switch target scope to Global.");
  }
  const reg = draft.targetRegionId.trim();
  return {
    object_id: obj,
    ...(reg ? { region_id: reg } : {}),
  };
}

export function buildSpinTorqueResource(
  draft: SpinTorquePanelDraft,
): SceneSpinTorque {
  const id = draft.id.trim();
  if (!id) throw new Error("Torque ID is required.");

  if (draft.torqueKind === "drift_diffusion_spin_torque") {
    const solveId = draft.solveId.trim();
    if (!solveId) {
      throw new Error("Select a driving SpinTransport solve_id.");
    }
    const target = buildTargetRef({ ...draft, targetMode: "scoped" });
    if (!target) {
      throw new Error("Drift-diffusion spin torque requires a target scope.");
    }
    const built: KnownSceneSpinTorque = {
      kind: "drift_diffusion_spin_torque",
      id,
      solve_id: solveId,
      target,
      schema_version:
        draft.schemaVersion.trim() || "drift_diffusion_spin_torque.v1",
      formula_version:
        draft.formulaVersion.trim() ||
        "drift_diffusion_spin_torque.fullmag.v1",
    };
    return built;
  }

  if (draft.torqueKind === "interface_cpp") {
    if (draft.degree <= 0 || draft.degree > 1) {
      throw new Error("Polarization degree P must be in (0, 1].");
    }
    if (draft.lambdaAsymmetry < 1) {
      throw new Error("Slonczewski/CPP asymmetry Λ must be >= 1.");
    }
    const target = buildTargetRef(draft);
    const timeExpr =
      draft.currentBindingMode === "prescribed_density"
        ? buildTimeExpressionPayload(draft)
        : undefined;
    const currentBinding =
      draft.currentBindingMode === "current_transport"
        ? (() => {
            if (!draft.currentSource.trim()) {
              throw new Error("Select a driving charge transport source.");
            }
            return { current_source: draft.currentSource.trim() };
          })()
        : {
            current_density: [
              draft.currentDensityVec[0],
              draft.currentDensityVec[1],
              draft.currentDensityVec[2],
            ],
          };

    return {
      kind: "interface_cpp",
      id,
      ...currentBinding,
      degree: draft.degree,
      lambda_asymmetry: draft.lambdaAsymmetry,
      epsilon_prime: draft.epsilonPrime,
      spin_polarization: [
        draft.spinPolarizationVec[0],
        draft.spinPolarizationVec[1],
        draft.spinPolarizationVec[2],
      ],
      interface_normal: [
        draft.interfaceNormalVec[0],
        draft.interfaceNormalVec[1],
        draft.interfaceNormalVec[2],
      ],
      ...(target ? { target } : {}),
      ...(timeExpr ? { time_expression: timeExpr } : {}),
    };
  }

  if (draft.torqueKind === "zhang_li") {
    if (draft.degree <= 0 || draft.degree >= 1) {
      throw new Error("Zhang-Li polarization degree P must be in (0, 1).");
    }
    if (draft.beta < 0) {
      throw new Error("Non-adiabaticity β must be >= 0.");
    }
    const formulaVersion = (draft.formulaVersion.trim() ||
      "zhang_li.legacy_fullmag.v0") as
      | "zhang_li.fullmag.v1"
      | "zhang_li.mumax3.v1"
      | "zhang_li.legacy_fullmag.v0";
    const isLegacy = formulaVersion === "zhang_li.legacy_fullmag.v0";
    const target = isLegacy ? undefined : buildTargetRef(draft);
    const currentBinding =
      draft.currentBindingMode === "current_transport"
        ? (() => {
            if (!draft.currentSource.trim()) {
              throw new Error("Select a driving charge transport source.");
            }
            return { current_source: draft.currentSource.trim() };
          })()
        : {
            current_density: [
              draft.currentDensityVec[0],
              draft.currentDensityVec[1],
              draft.currentDensityVec[2],
            ],
          };

    const landeG =
      !isLegacy && draft.landeGText.trim()
        ? (() => {
            const parsed = Number(draft.landeGText);
            if (!Number.isFinite(parsed) || parsed <= 0) {
              throw new Error("Landé g factor must be positive and finite.");
            }
            return parsed;
          })()
        : undefined;

    const operatorVersion =
      !isLegacy && draft.operatorVersion.trim()
        ? (draft.operatorVersion.trim() as
            | "zl_central_reference_v1"
            | "zl_mumax3_central_v1")
        : undefined;

    const built: KnownSceneSpinTorque = {
      kind: "zhang_li",
      id,
      formula_version: formulaVersion,
      ...(!isLegacy && draft.schemaVersion.trim()
        ? { schema_version: draft.schemaVersion.trim() }
        : {}),
      ...(operatorVersion ? { operator_version: operatorVersion } : {}),
      ...(target ? { target } : {}),
      ...currentBinding,
      degree: draft.degree,
      beta: draft.beta,
      ...(landeG !== undefined ? { lande_g: landeG } : {}),
    };
    return built;
  }

  if (draft.torqueKind === "slonczewski") {
    if (draft.degree <= 0 || draft.degree >= 1) {
      throw new Error("Slonczewski polarization degree P must be in (0, 1).");
    }
    if (draft.lambdaAsymmetry < 1) {
      throw new Error("Slonczewski asymmetry Λ must be >= 1.");
    }
    const formulaVersion = (draft.formulaVersion.trim() ||
      "slonczewski.fullmag.v2") as
      | "slonczewski.fullmag.v2"
      | "slonczewski.fullmag.v1"
      | "slonczewski.legacy_fullmag.v0";
    const isLegacy = formulaVersion === "slonczewski.legacy_fullmag.v0";

    const currentBinding =
      draft.currentBindingMode === "current_transport"
        ? (() => {
            if (!draft.currentSource.trim()) {
              throw new Error("Select a driving charge transport source.");
            }
            return { current_source: draft.currentSource.trim() };
          })()
        : {
            current_density: [
              draft.currentDensityVec[0],
              draft.currentDensityVec[1],
              draft.currentDensityVec[2],
            ],
          };

    const realization: SlonczewskiRealization | undefined = isLegacy
      ? undefined
      : draft.realizationMode === "thin_layer_homogenized"
        ? {
            kind: "thin_layer_homogenized",
            realization_version: "slonczewski_thin_layer_homogenized.v1",
          }
        : draft.realizationMode === "custom" && draft.realizationJson.trim()
          ? (JSON.parse(draft.realizationJson) as SlonczewskiRealization)
          : undefined;

    const target = isLegacy ? undefined : buildTargetRef(draft);
    const timeExpr =
      formulaVersion === "slonczewski.fullmag.v2" &&
      draft.currentBindingMode === "prescribed_density"
        ? buildTimeExpressionPayload(draft)
        : undefined;

    const built: KnownSceneSpinTorque = {
      kind: "slonczewski",
      id,
      formula_version: formulaVersion,
      ...(!isLegacy && draft.schemaVersion.trim()
        ? { schema_version: draft.schemaVersion.trim() }
        : {}),
      ...currentBinding,
      degree: draft.degree,
      lambda_asymmetry: draft.lambdaAsymmetry,
      epsilon_prime: draft.epsilonPrime,
      ...(draft.hasFreeLayerThickness
        ? { free_layer_thickness_m: draft.freeLayerThicknessM }
        : {}),
      ...(isLegacy && draft.fixedLayerPosition
        ? { fixed_layer_position: draft.fixedLayerPosition }
        : {}),
      spin_polarization: [
        draft.spinPolarizationVec[0],
        draft.spinPolarizationVec[1],
        draft.spinPolarizationVec[2],
      ],
      ...(!isLegacy
        ? {
            stack_normal: [
              draft.stackNormalVec[0],
              draft.stackNormalVec[1],
              draft.stackNormalVec[2],
            ],
          }
        : {}),
      ...(realization ? { realization } : {}),
      ...(target ? { target } : {}),
      ...(timeExpr ? { time_expression: timeExpr } : {}),
    };
    return built;
  }

  // `prescribed_sot`
  const formulaVersion = (draft.formulaVersion.trim() ||
    "prescribed_sot.fullmag.v1") as
    | "prescribed_sot.fullmag.v1"
    | "prescribed_sot.legacy_fullmag.v0";
  const isLegacySot = formulaVersion === "prescribed_sot.legacy_fullmag.v0";

  let drive: ScenePrescribedSotDrive;
  if (draft.sotDriveKind === "vector_current_source") {
    if (!draft.currentSource.trim()) {
      throw new Error("Select a driving charge transport source for SOT.");
    }
    drive = {
      kind: "vector_current_source",
      current_source_id: draft.currentSource.trim(),
      drive_direction: [
        draft.driveDirectionVec[0],
        draft.driveDirectionVec[1],
        draft.driveDirectionVec[2],
      ],
      interface_normal: [
        draft.sotInterfaceNormalVec[0],
        draft.sotInterfaceNormalVec[1],
        draft.sotInterfaceNormalVec[2],
      ],
    };
  } else if (draft.sotDriveKind === "legacy_scalar_magnitude") {
    drive = {
      kind: "legacy_scalar_magnitude",
      raw_charge_current_density_Apm2: draft.legacyScalarMagnitudeApm2,
    };
  } else if (draft.sotDriveKind === "legacy_current_source_norm") {
    if (!draft.currentSource.trim()) {
      throw new Error("Select a driving charge transport source.");
    }
    drive = {
      kind: "legacy_current_source_norm",
      current_source_id: draft.currentSource.trim(),
    };
  } else {
    let envelope: SceneTimeEnvelope | undefined;
    if (draft.timeProfileKind === "pulse") {
      if (
        !Number.isFinite(draft.pulseTOnS) ||
        !Number.isFinite(draft.pulseTOffS) ||
        draft.pulseTOnS < 0 ||
        draft.pulseTOffS <= draft.pulseTOnS
      ) {
        throw new Error("SOT pulse envelope requires 0 <= t_on_s < t_off_s.");
      }
      envelope = {
        kind: "pulse",
        amplitude: draft.pulseAmplitude,
        t_on_s: draft.pulseTOnS,
        t_off_s: draft.pulseTOffS,
      };
    } else if (
      draft.sotEnvelopeJson.trim() &&
      draft.sotEnvelopeJson.trim() !== "{}"
    ) {
      envelope = JSON.parse(draft.sotEnvelopeJson) as SceneTimeEnvelope;
    }
    drive = {
      kind: "signed_scalar",
      current_density_Apm2: draft.signedCurrentDensityApm2,
      sigma_hat: [
        draft.sigmaHatVec[0],
        draft.sigmaHatVec[1],
        draft.sigmaHatVec[2],
      ],
      ...(envelope ? { envelope } : {}),
    };
  }

  const rawSpinPol =
    isLegacySot && draft.rawSpinPolarizationText.trim()
      ? draft.rawSpinPolarizationText
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number)
      : undefined;
  if (rawSpinPol && (rawSpinPol.length !== 3 || rawSpinPol.some((n) => !Number.isFinite(n)))) {
    throw new Error("Raw spin polarization requires three finite components.");
  }

  const compatibilityOrigin =
    isLegacySot && draft.compatibilityOriginJson.trim()
      ? (JSON.parse(draft.compatibilityOriginJson) as SceneCompatibilityOrigin)
      : undefined;

  const target = isLegacySot ? undefined : buildTargetRef(draft);

  const built: KnownSceneSpinTorque = {
    kind: "prescribed_sot",
    id,
    schema_version: "prescribed_sot.v1",
    formula_version: formulaVersion,
    ...(target ? { target } : {}),
    drive,
    ...(rawSpinPol ? { raw_spin_polarization: rawSpinPol } : {}),
    ...(compatibilityOrigin
      ? { compatibility_origin: compatibilityOrigin }
      : {}),
    xi_dl: draft.xiDl,
    xi_fl: draft.xiFl,
    free_layer_thickness_m: draft.freeLayerThicknessM,
  };
  return built;
}

function reconcileTorquePanelDraft(
  server: SpinTorquePanelDraft,
  local: SpinTorquePanelDraft,
  base: SpinTorquePanelDraft,
): { draft: SpinTorquePanelDraft; conflicts: string[] } {
  const serializeFields = (d: SpinTorquePanelDraft): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(d)) {
      out[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    return out;
  };
  const reconciled = reconcileSpinAuthoringDraft(
    serializeFields(server),
    serializeFields(local),
    serializeFields(base),
  );
  const next = { ...server };
  for (const key of Object.keys(server) as Array<keyof SpinTorquePanelDraft>) {
    if (reconciled.draft[key] !== JSON.stringify(server[key]) && reconciled.draft[key] !== String(server[key])) {
      (next as Record<string, unknown>)[key] = local[key];
    }
  }
  return {
    draft: { ...next, exists: server.exists },
    conflicts: reconciled.conflicts.filter((k) => k !== "exists"),
  };
}

export function SpinTorqueInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const session = useTransportSessionContext();
  const scene = useAuthoringSceneData();
  const torqueRes = useSpinTorquesResource();
  const currentRes = useCurrentTransportsResource();
  const spinRes = useSpinTransportsResource();

  const items = useMemo(() => torqueRes.data?.items ?? [], [torqueRes.data?.items]);
  const currents = useMemo(
    () => currentRes.data?.items ?? [],
    [currentRes.data?.items],
  );
  const spinTransports = useMemo(
    () => spinRes.data?.items ?? [],
    [spinRes.data?.items],
  );
  const sceneRevision = torqueRes.data?.scene_revision;

  const knownSpinIds = useMemo(
    () => spinTransports.filter(isEditableSpinTransport).map((st) => st.id),
    [spinTransports],
  );
  const currentOptsRaw = useMemo(
    () => currentSourceOptions(currents, ""),
    [currents],
  );
  const defaultCurrentId = currentOptsRaw[0]?.value ?? "";
  const defaultSolveId = knownSpinIds[0] ?? "";

  const ref = selection.ref;
  const isExplicitDraft = Boolean(
    ref && "draft" in ref && (ref as { draft?: boolean }).draft === true,
  );
  const pinnedByRef =
    ref?.type === "spin-torque" &&
    !isExplicitDraft &&
    (ref.spinTorqueId != null || ref.spinTorqueIndex != null);

  const [localResourceId, setLocalResourceId] = useState("");
  const [prevSelNodeId, setPrevSelNodeId] = useState(selection.nodeId);
  if (prevSelNodeId !== selection.nodeId) {
    setPrevSelNodeId(selection.nodeId);
    setLocalResourceId("");
  }

  // Positional index pinning guard
  const positionalOnly =
    pinnedByRef &&
    ref?.type === "spin-torque" &&
    !ref.spinTorqueId &&
    ref.spinTorqueIndex !== undefined;

  const selectedRecord = useMemo(() => {
    if (pinnedByRef && ref?.type === "spin-torque") {
      if (ref.spinTorqueId) {
        return (
          items.find(
            (item) => (item as Record<string, unknown>).id === ref.spinTorqueId,
          ) ?? null
        );
      }
      if (ref.spinTorqueIndex !== undefined) {
        return items[ref.spinTorqueIndex] ?? null;
      }
    }
    if (!localResourceId) return null;
    if (localResourceId.startsWith("position:")) {
      const idx = Number.parseInt(
        localResourceId.slice("position:".length),
        10,
      );
      return Number.isInteger(idx) ? (items[idx] ?? null) : null;
    }
    return (
      items.find(
        (item) => (item as Record<string, unknown>).id === localResourceId,
      ) ?? null
    );
  }, [items, localResourceId, pinnedByRef, ref]);

  const [pinnedPositionalState, setPinnedPositionalState] = useState<{
    selKey: string | null;
    pinnedId: string | null;
  }>({ selKey: selection.nodeId, pinnedId: null });
  if (pinnedPositionalState.selKey !== selection.nodeId) {
    setPinnedPositionalState({ selKey: selection.nodeId, pinnedId: null });
  }
  const currentResolvedId =
    selectedRecord &&
    typeof (selectedRecord as Record<string, unknown>).id === "string"
      ? String((selectedRecord as Record<string, unknown>).id)
      : null;
  if (
    positionalOnly &&
    torqueRes.status === "ready" &&
    currentResolvedId &&
    pinnedPositionalState.pinnedId === null
  ) {
    setPinnedPositionalState({
      selKey: selection.nodeId,
      pinnedId: currentResolvedId,
    });
  }
  const positionalIdentityMismatch =
    positionalOnly &&
    pinnedPositionalState.pinnedId !== null &&
    currentResolvedId !== pinnedPositionalState.pinnedId
      ? "Positional spin torque target changed identity after scene reorder. Reselect the target before applying."
      : null;

  const targetMissingMessage =
    (pinnedByRef || Boolean(localResourceId)) &&
    torqueRes.status === "ready" &&
    selectedRecord === null
      ? "The selected spin torque resource is no longer present in the scene."
      : positionalIdentityMismatch;

  const switcherOptions = useMemo(
    () =>
      items.map((item, idx) => {
        const rec = item as Record<string, unknown>;
        const id = typeof rec.id === "string" && rec.id.trim() ? rec.id : "";
        const supported = isSupportedSpinTorqueRecord(item);
        return {
          value: id || `position:${idx}`,
          label: id
            ? supported
              ? id
              : `${id} (read-only)`
            : `Opaque torque record #${idx + 1}`,
        };
      }),
    [items],
  );

  const isOpaqueSelected =
    selectedRecord !== null && !isSupportedSpinTorqueRecord(selectedRecord);
  const supportedSelected =
    selectedRecord !== null && !isOpaqueSelected ? selectedRecord : null;

  const initialScope = useMemo(
    () =>
      !pinnedByRef && !localResourceId && selection.objectId
        ? {
            objectId: selection.objectId,
            regionId: extractInitialRegionId(selection),
          }
        : null,
    [localResourceId, pinnedByRef, selection],
  );

  const breadcrumbs = useMemo<InspectorBreadcrumbItem[]>(
    () => [
      {
        id: "crumb-model",
        label: "Model",
        selection: {
          kind: "model.root",
          label: "Model",
          nodeId: "model:root",
          objectId: null,
          ref: null,
        },
      },
      { id: "crumb-physics", label: "Physics" },
      { id: "crumb-spin-torque", label: "Spin Torque" },
    ],
    [],
  );

  const draftIdentityKey = pinnedByRef
    ? `pinned:${ref?.type === "spin-torque" ? (ref.spinTorqueId ?? `pos:${ref.spinTorqueIndex ?? "none"}`) : selection.nodeId}`
    : `local:${localResourceId || "new"}:${initialScope?.objectId ?? ""}:${initialScope?.regionId ?? ""}`;

  const serverBaseline = useMemo(
    () =>
      hydrateTorquePanelDraft(
        supportedSelected,
        supportedSelected ? null : initialScope,
        supportedSelected !== null,
        defaultSolveId,
        defaultCurrentId,
      ),
    [defaultCurrentId, defaultSolveId, initialScope, supportedSelected],
  );

  const effectiveSelection = useMemo<Selection>(
    () => ({
      ...selection,
      nodeId: `${selection.nodeId}::${draftIdentityKey}`,
    }),
    [draftIdentityKey, selection],
  );

  const [liveDraft, setLiveDraft] =
    useState<SpinTorquePanelDraft>(serverBaseline);
  const [liveDirty, setLiveDirty] = useState<ReadonlySet<string>>(() => new Set());

  const conflictState = useThreeWayConflictState({
    targetKey: draftIdentityKey,
    serverDraft: serverBaseline,
    currentDraft: liveDraft,
    dirtyFields: liveDirty,
    reconcile: reconcileTorquePanelDraft,
  });

  const capability = useMemo(
    () => evaluateSpinM1Capability(session),
    [session],
  );

  const selectedPathId =
    supportedSelected &&
    typeof (supportedSelected as Record<string, unknown>).id === "string"
      ? String((supportedSelected as Record<string, unknown>).id)
      : "";

  const buildValidationReq = useCallback(
    (d: SpinTorquePanelDraft): TransportValidationRequest => {
      if (sceneRevision === undefined) {
        throw new Error("Spin torque catalog is still loading.");
      }
      const resource = buildSpinTorqueResource(d);
      return supportedSelected
        ? {
            validation_version: TRANSPORT_VALIDATION_VERSION,
            base_revision: sceneRevision,
            candidate: {
              kind: "spin_torque",
              operation: "replace",
              path_id: selectedPathId || d.id.trim(),
              resource,
            },
          }
        : {
            validation_version: TRANSPORT_VALIDATION_VERSION,
            base_revision: sceneRevision,
            candidate: {
              kind: "spin_torque",
              operation: "create",
              resource,
            },
          };
    },
    [sceneRevision, selectedPathId, supportedSelected],
  );

  const validationState = useDebouncedTransportValidation({
    enabled: !isOpaqueSelected && targetMissingMessage === null,
    draftSerialized: JSON.stringify(liveDraft),
    draftKey: draftIdentityKey,
    sceneRevision,
    sessionScopeKey: session.sessionScopeKey,
    buildRequest: () => buildValidationReq(liveDraft),
  });

  const handleDelete = useCallback(async () => {
    if (!supportedSelected || !selectedPathId || sceneRevision === undefined) {
      return;
    }
    if (!capability.authoring_allowed) {
      throw new Error(capability.reason);
    }
    await executeAuthoringHistoryCommit({
      kernel,
      sessionScopeKey: session.sessionScopeKey,
      label: `Delete spin torque ${selectedPathId}`,
      submittedRevision: sceneRevision,
      resourceKeys: RESOURCE_KEYS.spinTorque,
      onConflict409: conflictState.markHttpConflict,
      mutate: ({ committedRevision, requestOptions }) =>
        kernel.api.model.deleteSpinTorque(
          selectedPathId,
          { base_revision: committedRevision },
          requestOptions,
        ),
    });
    conflictState.clearConflict();
    if (!pinnedByRef) {
      setLocalResourceId("");
    } else {
      kernel.selection.set(
        {
          kind: "model.root",
          label: "Model",
          nodeId: "model:root",
          objectId: null,
          ref: null,
        },
        "inspector",
      );
    }
  }, [
    capability.authoring_allowed,
    capability.reason,
    conflictState,
    kernel,
    pinnedByRef,
    sceneRevision,
    selectedPathId,
    session.sessionScopeKey,
    supportedSelected,
  ]);

  const handleApply = useCallback(
    async (draft: SpinTorquePanelDraft) => {
      if (sceneRevision === undefined) {
        throw new Error("Spin torque catalog is still loading.");
      }
      if (!capability.authoring_allowed) {
        throw new Error(capability.reason);
      }
      const resource = buildSpinTorqueResource(draft);
      const valReq = buildValidationReq(draft);
      await runPreCommitTransportValidation({
        validateTransport: kernel.api.model.validateTransport,
        sessionScopeKey: session.sessionScopeKey,
        request: valReq,
        validationKey: validationState.validationKey,
        setManualValidation: validationState.setManualValidation,
      });

      const commit = await executeAuthoringHistoryCommit({
        kernel,
        sessionScopeKey: session.sessionScopeKey,
        label: supportedSelected
          ? `Replace spin torque ${selectedPathId}`
          : `Create spin torque ${draft.id.trim()}`,
        submittedRevision: sceneRevision,
        resourceKeys: RESOURCE_KEYS.spinTorque,
        onConflict409: conflictState.markHttpConflict,
        mutate: ({ committedRevision, requestOptions }) => {
          const payload: SpinTorqueMutationRequest = {
            base_revision: committedRevision,
            resource,
          };
          return supportedSelected
            ? kernel.api.model.replaceSpinTorque(
                selectedPathId,
                payload,
                requestOptions,
              )
            : kernel.api.model.createSpinTorque(payload, requestOptions);
        },
      });
      conflictState.clearConflict();

      const committedRec = commit.resource as Record<string, unknown> | undefined;
      const createdId =
        typeof committedRec?.id === "string" && committedRec.id.trim()
          ? committedRec.id
          : draft.id.trim();

      if (!supportedSelected && createdId) {
        setLocalResourceId(createdId);
        kernel.selection.set(
          {
            kind: "physics.spin-torque",
            label: createdId,
            nodeId: `model:physics:spin-torques:${createdId}`,
            objectId: selection.objectId,
            ref: {
              kind: "physics.spin-torque",
              nodeId: `model:physics:spin-torques:${createdId}`,
              spinTorqueId: createdId,
              type: "spin-torque",
            },
          },
          "inspector",
        );
      }
      return true;
    },
    [
      buildValidationReq,
      capability.authoring_allowed,
      capability.reason,
      conflictState,
      kernel,
      sceneRevision,
      selectedPathId,
      selection.objectId,
      session.sessionScopeKey,
      supportedSelected,
      validationState.setManualValidation,
      validationState.validationKey,
    ],
  );

  const scopes = useMemo(() => transportScopeOptions(scene), [scene]);
  const currentDropdownOptions = useMemo(
    () =>
      currentSourceOptions(currents, liveDraft.currentSource).map((opt) => ({
        value: opt.value,
        label: opt.label.replace(/\s*\(unavailable\)$/i, " (not in scene)"),
      })),
    [currents, liveDraft.currentSource],
  );

  const spec = useMemo<InspectorSpec<SpinTorquePanelDraft>>(
    () => ({
      id: "physics.spin-torque",
      header: {
        breadcrumbs,
        searchable: true,
        extraMenuActions: [
          {
            id: "refresh-spin-torques",
            label: "Refresh spin torques",
            icon: RefreshCw,
            onSelect: () => {
              torqueRes.refetch();
              currentRes.refetch();
              spinRes.refetch();
            },
          },
          {
            id: "view-spin-torque-json",
            label: "View JSON payload",
            icon: FileCode2,
            onSelect: (ctx) => {
              try {
                const built = buildSpinTorqueResource(ctx.draft);
                ctx.openCodePreview(
                  `${ctx.draft.id} JSON`,
                  "json",
                  JSON.stringify(built, null, 2),
                );
              } catch {
                ctx.openCodePreview(
                  `${ctx.draft.id} Draft`,
                  "json",
                  JSON.stringify(ctx.draft, null, 2),
                );
              }
            },
          },
        ],
        ...(supportedSelected && selectedPathId && capability.authoring_allowed
          ? {
              deleteAction: {
                label: "Delete Spin Torque",
                confirmTitle: () => `Delete "${selectedPathId}"?`,
                confirmDescription:
                  "Deleting this spin torque removes its current-induced damping-like and field-like torques from the magnetization dynamics.",
                onDelete: handleDelete,
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Zap,
        title: (d) => d.id || "Spin Torque",
        kindLabel: "Current-Induced Spin Torque",
        entityId: selectedPathId || undefined,
        statePill: (d) => ({
          tone: !capability.authoring_allowed
            ? "warn"
            : d.exists
              ? "ok"
              : "info",
          label: !capability.authoring_allowed
            ? capability.status
            : d.exists
              ? d.torqueKind.replace(/_/g, " ")
              : "New draft",
        }),
      },
      facts: (d) => [
        {
          id: "kind",
          label: "Mechanism",
          value:
            d.torqueKind === "prescribed_sot"
              ? "Prescribed SOT"
              : d.torqueKind === "slonczewski"
                ? "Slonczewski"
                : d.torqueKind === "zhang_li"
                  ? "Zhang-Li"
                  : d.torqueKind === "drift_diffusion_spin_torque"
                    ? "Drift-Diffusion"
                    : "Interface CPP",
        },
        ...(d.torqueKind === "prescribed_sot"
          ? [
              {
                id: "sot-eff",
                label: "ξ_DL / ξ_FL",
                value: `${d.xiDl} / ${d.xiFl}`,
                mono: true,
              },
            ]
          : d.torqueKind === "drift_diffusion_spin_torque"
            ? [
                {
                  id: "solve",
                  label: "Spin solve",
                  value: d.solveId || "Unbound",
                  mono: true,
                },
              ]
            : [
                {
                  id: "pol",
                  label: "P",
                  value: String(d.degree),
                  mono: true,
                },
              ]),
      ],
      notices: () =>
        buildValidationNotices({
          capability,
          validation: validationState.validation,
          validationError: validationState.validationError,
          buildError: validationState.buildError,
          conflicts: conflictState.conflicts,
          hasRevisionConflict: conflictState.hasRevisionConflict,
          onRebase: conflictState.rebaseDraft,
          targetMissingMessage,
        }),
      sections: [
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
                        disabled={liveDirty.size > 0}
                        label="Resource"
                        newOptionLabel="New spin torque"
                        options={switcherOptions}
                        value={localResourceId}
                        onChange={setLocalResourceId}
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
              validate: (v) =>
                !v.trim() ? "Torque ID is required." : null,
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
                  <div className="flex flex-col gap-1.5" data-slot="torque-target-scope">
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
                  <div className="flex flex-col gap-1.5" data-slot="dd-solve-binding">
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
              validate: (v) =>
                !v.trim() ? "Formula version is required." : null,
            },
            {
              type: "text",
              key: "schemaVersion",
              label: "Schema version",
              mono: true,
              validate: (v) =>
                !v.trim() ? "Schema version is required." : null,
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
              showWhen: (d) =>
                d.formulaVersion !== "zhang_li.legacy_fullmag.v0",
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
              showWhen: (d) =>
                d.formulaVersion !== "zhang_li.legacy_fullmag.v0",
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
              showWhen: (d) =>
                d.formulaVersion !== "zhang_li.legacy_fullmag.v0",
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
                    value={
                      ctx.draft.fixedLayerPosition || NO_FIXED_LAYER_SENTINEL
                    }
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
        {
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
        },
      ],
      details: () => buildValidationDetails(capability, validationState.validation),
      commitBar: {
        mode: "staged",
        allowCleanApply: (d) => !d.exists,
        applyLabel: (d) => (d.exists ? "Apply" : "Create"),
        cleanMessage: () =>
          sceneRevision !== undefined
            ? `Up to date with scene revision ${sceneRevision}`
            : "Up to date",
        lockReason: () =>
          computeTransportLockReason({
            capability,
            validation: validationState.validation,
            validationError: validationState.validationError,
            buildError: validationState.buildError,
            hasConflict: conflictState.hasConflict,
            targetMissingMessage,
          }),
        onApply: handleApply,
      },
    }),
    [
      breadcrumbs,
      capability,
      conflictState.conflicts,
      conflictState.hasConflict,
      conflictState.hasRevisionConflict,
      conflictState.rebaseDraft,
      currentDropdownOptions,
      currentRes,
      handleApply,
      handleDelete,
      knownSpinIds,
      liveDirty.size,
      localResourceId,
      pinnedByRef,
      sceneRevision,
      scopes,
      selectedPathId,
      spinRes,
      supportedSelected,
      switcherOptions,
      targetMissingMessage,
      torqueRes,
      validationState.buildError,
      validationState.validation,
      validationState.validationError,
    ],
  );

  const controller = useInspectorSpecController(
    spec,
    effectiveSelection,
    serverBaseline,
  );
  if (JSON.stringify(controller.draft) !== JSON.stringify(liveDraft)) {
    setLiveDraft(controller.draft);
  }
  if (controller.dirtyFields.size !== liveDirty.size) {
    setLiveDirty(new Set(controller.dirtyFields));
  }

  const handleCoupledChange = useCallback(
    <K extends keyof SpinTorquePanelDraft & string>(
      key: K,
      value: SpinTorquePanelDraft[K],
      current: SpinTorquePanelDraft,
    ): Partial<SpinTorquePanelDraft> | null => {
      if (key === "torqueKind") {
        const nextKind = value as TorqueKindUi;
        if (nextKind === "zhang_li") {
          const isScoped =
            current.targetMode === "scoped" && Boolean(current.targetObjectId);
          return {
            torqueKind: nextKind,
            formulaVersion: isScoped
              ? "zhang_li.fullmag.v1"
              : "zhang_li.legacy_fullmag.v0",
            schemaVersion: isScoped ? "zhang_li_torque.v1" : "",
            operatorVersion: isScoped ? "zl_central_reference_v1" : "",
            landeGText: isScoped ? "2" : "",
          };
        }
        if (nextKind === "slonczewski") {
          return {
            torqueKind: nextKind,
            formulaVersion: "slonczewski.fullmag.v2",
            schemaVersion: "slonczewski_torque.v1",
            hasFreeLayerThickness: true,
            realizationMode: "thin_layer_homogenized",
            targetMode: current.targetObjectId ? "scoped" : current.targetMode,
          };
        }
        if (nextKind === "prescribed_sot") {
          return {
            torqueKind: nextKind,
            formulaVersion: "prescribed_sot.fullmag.v1",
            schemaVersion: "prescribed_sot.v1",
            hasFreeLayerThickness: true,
          };
        }
        if (nextKind === "drift_diffusion_spin_torque") {
          return {
            torqueKind: nextKind,
            formulaVersion: "drift_diffusion_spin_torque.fullmag.v1",
            schemaVersion: "drift_diffusion_spin_torque.v1",
            solveId: current.solveId || defaultSolveId,
            targetMode: "scoped",
          };
        }
        return {
          torqueKind: "interface_cpp",
        };
      }
      if (key === "formulaVersion") {
        const nextVer = String(value);
        if (nextVer === "zhang_li.fullmag.v1") {
          return {
            formulaVersion: nextVer,
            schemaVersion: "zhang_li_torque.v1",
            operatorVersion:
              current.operatorVersion || "zl_central_reference_v1",
            landeGText: current.landeGText || "2",
            targetMode: "scoped",
          };
        }
        if (nextVer === "zhang_li.mumax3.v1") {
          return {
            formulaVersion: nextVer,
            schemaVersion: "zhang_li_torque.v1",
            operatorVersion: "zl_mumax3_central_v1",
            landeGText: "2",
            targetMode: "scoped",
          };
        }
        if (nextVer === "zhang_li.legacy_fullmag.v0") {
          return {
            formulaVersion: nextVer,
            schemaVersion: "",
            operatorVersion: "",
            landeGText: "",
            targetMode: "global",
          };
        }
        if (nextVer === "slonczewski.legacy_fullmag.v0") {
          return {
            formulaVersion: nextVer,
            schemaVersion: "",
            fixedLayerPosition: current.fixedLayerPosition || "bottom",
            realizationMode: "none",
            targetMode: "global",
          };
        }
        if (nextVer === "slonczewski.fullmag.v2") {
          return {
            formulaVersion: nextVer,
            schemaVersion: "slonczewski_torque.v1",
            fixedLayerPosition: "",
            hasFreeLayerThickness: true,
            realizationMode: "thin_layer_homogenized",
          };
        }
      }
      if (key === "currentBindingMode") {
        const nextMode = value as TorqueCurrentBinding;
        const patch = torqueCurrentBindingPatch(
          {
            currentDensity: current.currentDensityVec.join(", "),
            currentSource: current.currentSource,
          },
          nextMode,
          defaultCurrentId,
        );
        return {
          currentBindingMode: nextMode,
          currentSource: patch.currentSource,
        };
      }
      return null;
    },
    [defaultCurrentId, defaultSolveId],
  );

  if (isOpaqueSelected) {
    const rec = selectedRecord as Record<string, unknown>;
    const opaqueId = typeof rec.id === "string" && rec.id ? rec.id : undefined;
    return (
      <>
        {session.probeElement}
        <ReadOnlyOpaqueInspector
          breadcrumbs={breadcrumbs}
          entityId={opaqueId}
          icon={Zap}
          kindLabel="Current-Induced Spin Torque"
          payload={selectedRecord}
          selection={selection}
          specId="physics.spin-torque"
          switcherNode={
            !pinnedByRef ? (
              <ResourceSwitcherBar
                label="Resource"
                newOptionLabel="New spin torque"
                options={switcherOptions}
                value={localResourceId}
                onChange={setLocalResourceId}
              />
            ) : undefined
          }
          heading={opaqueId ?? "Opaque Spin Torque"}
          warningText="Unrecognized spin torque variant is preserved losslessly and is read-only."
          onRefresh={() => torqueRes.refetch()}
        />
      </>
    );
  }

  return (
    <TransportTemplateRenderer
      controller={controller}
      selection={effectiveSelection}
      spec={spec}
      onCoupledFieldChange={handleCoupledChange}
    >
      {session.probeElement}
    </TransportTemplateRenderer>
  );
}
