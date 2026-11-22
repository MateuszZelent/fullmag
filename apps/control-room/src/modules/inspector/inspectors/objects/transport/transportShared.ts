import type { SceneSpinTorque } from "@/kernel/api/apiTypes";
import { isUnsupportedSpinAuthoringResource } from "@/shared/domain/physics/spinAuthoringRecognition";

import { reconcileSpinAuthoringDraft } from "../../../panels/spinAuthoringDraft";
import {
  torqueCurrentBindingPatch,
  type TorqueCurrentBinding,
} from "../../../panels/SpinAuthoringInspectorModel";
import type {
  SceneRegionRef,
  SceneTimeEnvelope,
} from "../../../panels/transport/transportShared";

export const GLOBAL_TARGET_SENTINEL = "__fm_torque_global_target__";
export const NO_OPERATOR_SENTINEL = "__fm_zl_no_operator__";
export const NO_FIXED_LAYER_SENTINEL = "__fm_slon_no_fixed_layer__";
export const NO_REALIZATION_SENTINEL = "__fm_slon_no_realization__";

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

export function isVec3Tuple(v: unknown): v is [number, number, number] {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((x) => typeof x === "number" && Number.isFinite(x))
  );
}

export function isRegionRefObj(v: unknown): v is SceneRegionRef {
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
        (typeof rec.current_source === "string" &&
        Boolean(rec.current_source.trim())
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

export function hydrateTorquePanelDraft(
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
    id: typeof rec.id === "string" && rec.id.trim() ? rec.id : "spin-torque",
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

export function reconcileTorquePanelDraft(
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
    if (
      reconciled.draft[key] !== JSON.stringify(server[key]) &&
      reconciled.draft[key] !== String(server[key])
    ) {
      (next as Record<string, unknown>)[key] = local[key];
    }
  }
  return {
    draft: { ...next, exists: server.exists },
    conflicts: reconciled.conflicts.filter((k) => k !== "exists"),
  };
}

export function computeTorqueCoupledChange<
  K extends keyof SpinTorquePanelDraft & string,
>(
  key: K,
  value: SpinTorquePanelDraft[K],
  current: SpinTorquePanelDraft,
  defaults: { defaultCurrentId: string; defaultSolveId: string },
): Partial<SpinTorquePanelDraft> | null {
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
        solveId: current.solveId || defaults.defaultSolveId,
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
        operatorVersion: current.operatorVersion || "zl_central_reference_v1",
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
      defaults.defaultCurrentId,
    );
    return {
      currentBindingMode: nextMode,
      currentSource: patch.currentSource,
    };
  }
  return null;
}
