import type { SceneSpinTorque } from "@/kernel/api/apiTypes";

import type {
  KnownSceneSpinTorque,
  SceneCompatibilityOrigin,
  ScenePrescribedSotDrive,
  SceneRegionRef,
  SceneTimeEnvelope,
  SlonczewskiRealization,
} from "../../../panels/transport/transportShared";
import type { SpinTorquePanelDraft } from "./transportShared";

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
  if (
    draft.exprConstantsJson.trim() &&
    draft.exprConstantsJson.trim() !== "{}"
  ) {
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
  if (
    rawSpinPol &&
    (rawSpinPol.length !== 3 || rawSpinPol.some((n) => !Number.isFinite(n)))
  ) {
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
