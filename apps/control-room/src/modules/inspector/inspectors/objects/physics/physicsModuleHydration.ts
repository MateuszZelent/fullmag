import { createElement } from "react";

import type {
  ObjectInteractionResource,
  PhysicsGraphModuleResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import {
  resolveActiveLaneOperation,
  type useActiveLaneCapabilities,
} from "@/kernel/resources/useActiveLaneCapabilities";
import {
  interactionAvailabilityForDiscretization,
  validateInteractionDraftForDiscretization,
  type InteractionDiscretization,
} from "@/shared/domain/physics/interactions";

import type { SceneObjectItem as SceneObject } from "../../../panels/model-roots/SpecInspectorHost";
import {
  activeLaneOperationIdForModule,
  activeObjectScopedDmiKind,
  asJsonRecord,
  findObjectPhysicsStackEntry,
  formatGraphAppliesTo,
  formatGraphCapability,
  isRestFetchableInteractionKind,
  resolveTargetStudyExchangeEnabled,
  ROTATED_DMI_EXCHANGE_ERROR,
  studyRotatedDmiNumber,
  type CanonicalPhysicsModuleKind,
  type GraphModuleProvenanceSummary,
  type PhysicsModuleDraft,
} from "./physicsShared";

export const effectiveFieldMath = createElement(
  "math",
  {
    display: "block",
    "aria-label":
      "Effective field B eff equals minus one over Ms times variational derivative of energy density E with respect to m",
  },
  createElement(
    "mrow",
    null,
    createElement(
      "msub",
      null,
      createElement("mi", null, "B"),
      createElement("mtext", null, "eff"),
    ),
    createElement("mo", null, "="),
    createElement("mo", null, "\u2212"),
    createElement(
      "mfrac",
      null,
      createElement("mn", null, "1"),
      createElement(
        "msub",
        null,
        createElement("mi", null, "M"),
        createElement("mi", null, "s"),
      ),
    ),
    createElement(
      "mfrac",
      null,
      createElement(
        "mrow",
        null,
        createElement("mo", null, "\u03b4"),
        createElement("mi", null, "\u2130"),
      ),
      createElement(
        "mrow",
        null,
        createElement("mo", null, "\u03b4"),
        createElement("mi", null, "m"),
      ),
    ),
  ),
);

export function hydratePhysicsModuleBaseline(input: {
  matId: string | undefined;
  matProperties: unknown;
  moduleKind: CanonicalPhysicsModuleKind | null;
  objectId: string | null;
  objectInteractionData: ObjectInteractionResource | null | undefined;
  objectInteractionStatus: string;
  physicsActivation: string | undefined;
  physicsGraphModuleCount: number;
  physicsGraphStatus: string;
  physicsModuleId: string | undefined;
  rawKind: string;
  sceneObj: SceneObject | undefined;
  sceneStudy: unknown;
  scopeKind: "global" | "object";
  selectedGraphModule: PhysicsGraphModuleResource | null;
}): PhysicsModuleDraft {
  const {
    matId,
    matProperties,
    moduleKind,
    objectId,
    objectInteractionData,
    objectInteractionStatus,
    physicsActivation,
    physicsGraphModuleCount,
    physicsGraphStatus,
    physicsModuleId,
    rawKind,
    sceneObj,
    sceneStudy,
    scopeKind,
    selectedGraphModule,
  } = input;

  const studyRec = asJsonRecord(sceneStudy) ?? {};
  const props = asJsonRecord(matProperties) ?? {};
  const matched = moduleKind
    ? findObjectPhysicsStackEntry(sceneObj, moduleKind)
    : null;
  const fetchedResource =
    scopeKind === "object" &&
    isRestFetchableInteractionKind(moduleKind) &&
    objectInteractionStatus === "ready" &&
    objectInteractionData
      ? objectInteractionData
      : null;
  const params =
    asJsonRecord(fetchedResource?.params ?? matched?.params ?? matched) ?? {};

  const readV3 = (
    v: unknown,
    fb: readonly [number, number, number],
  ): [number, number, number] =>
    Array.isArray(v) && v.length >= 3
      ? [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0]
      : [fb[0], fb[1], fb[2]];

  const readStrain6 = (
    v: unknown,
  ): [number, number, number, number, number, number] | null =>
    Array.isArray(v) && v.length === 6
      ? [
          Number(v[0]) || 0,
          Number(v[1]) || 0,
          Number(v[2]) || 0,
          Number(v[3]) || 0,
          Number(v[4]) || 0,
          Number(v[5]) || 0,
        ]
      : null;

  const demagRealization =
    typeof studyRec.demag_realization === "string" &&
    studyRec.demag_realization.trim()
      ? studyRec.demag_realization.trim()
      : "auto";
  const extField =
    Array.isArray(studyRec.external_field) &&
    studyRec.external_field.length === 3
      ? readV3(studyRec.external_field, [0, 0, 0])
      : null;
  const rotDmiVal = studyRotatedDmiNumber(studyRec);
  const thermalNoiseRec = asJsonRecord(studyRec.thermal_noise);
  const pbcRec = asJsonRecord(studyRec.pbc);
  const pbcAxesRaw = Array.isArray(pbcRec?.axes) ? pbcRec.axes : null;
  const pbcAxes = pbcAxesRaw
    ? (["x", "y", "z"] as const).filter((_, i) => pbcAxesRaw[i] === "periodic")
    : [];
  const pbcImageCounts =
    Array.isArray(pbcRec?.image_counts) && pbcRec.image_counts.length === 3
      ? [
          Math.max(0, Math.trunc(Number(pbcRec.image_counts[0]) || 0)),
          Math.max(0, Math.trunc(Number(pbcRec.image_counts[1]) || 0)),
          Math.max(0, Math.trunc(Number(pbcRec.image_counts[2]) || 0)),
        ]
      : [10, 10, 10];

  let present = true;
  let enabled = true;
  if (scopeKind === "global") {
    switch (moduleKind) {
      case "exchange":
        present = true;
        enabled = studyRec.exchange_enabled !== false;
        break;
      case "demag":
        present = true;
        enabled = studyRec.demag_enabled !== false;
        break;
      case "zeeman":
        present = true;
        enabled = extField !== null;
        break;
      case "rotated_interfacial_dmi":
        present = true;
        enabled = rotDmiVal !== null;
        break;
      case "thermal_noise":
        present = true;
        enabled = thermalNoiseRec !== null;
        break;
      case "periodic_bc":
        present = true;
        enabled = pbcAxes.length > 0;
        break;
      default:
        present = true;
        enabled = physicsActivation !== "inactive";
    }
  } else if (fetchedResource) {
    present =
      moduleKind === "exchange" || moduleKind === "demag"
        ? true
        : fetchedResource.present;
    enabled = fetchedResource.present
      ? fetchedResource.enabled
      : physicsActivation === "active";
  } else if (matched) {
    present = true;
    enabled = matched.enabled !== false;
  } else if (moduleKind === "exchange" || moduleKind === "demag") {
    present = true;
    enabled = physicsActivation !== "inactive";
  } else {
    present = physicsActivation === "active";
    enabled = physicsActivation === "active";
  }

  if (
    scopeKind === "object" &&
    moduleKind === "exchange" &&
    studyRec.exchange_enabled === false
  ) {
    enabled = false;
  }

  const strain6 = readStrain6(params.strain);
  const provenance: GraphModuleProvenanceSummary | null = selectedGraphModule
    ? {
        id: selectedGraphModule.id,
        kind: selectedGraphModule.kind,
        sourcePath: selectedGraphModule.source_path,
        activation: selectedGraphModule.activation,
        capabilitySummary: formatGraphCapability(
          selectedGraphModule.capability,
        ),
        appliesToSummary: formatGraphAppliesTo(selectedGraphModule),
        dependsOn: selectedGraphModule.depends_on,
      }
    : null;

  const missingFromGraph = Boolean(
    physicsModuleId &&
      physicsGraphStatus === "ready" &&
      physicsGraphModuleCount > 0 &&
      !selectedGraphModule,
  );

  return {
    moduleId: physicsModuleId ?? rawKind,
    rawKind,
    moduleKind,
    scopeKind,
    objectId,
    objectName: sceneObj?.name?.trim() || objectId || "Global Physics",
    present,
    enabled,
    aex: typeof props.Aex === "number" ? props.Aex : 13e-12,
    hasAssignedMaterial: Boolean(matId),
    demagRealization,
    zeemanVectorT: extField ?? readV3(params.field_t, [0, 0, 0.02]),
    ku1: typeof params.ku1 === "number" ? params.ku1 : 0,
    ku2: typeof params.ku2 === "number" ? params.ku2 : 0,
    uniaxialAxis: readV3(params.axis, [0, 0, 1]),
    materialMs: typeof props.Ms === "number" ? props.Ms : null,
    kc1: typeof params.kc1 === "number" ? params.kc1 : 4.8e4,
    kc2: typeof params.kc2 === "number" ? params.kc2 : 5.0e3,
    kc3: typeof params.kc3 === "number" ? params.kc3 : 0,
    cubicAxis1: readV3(params.axis1 ?? params.c1, [1, 0, 0]),
    cubicAxis2: readV3(params.axis2 ?? params.c2, [0, 1, 0]),
    dind:
      typeof params.dind === "number"
        ? params.dind
        : typeof props.Dind === "number"
          ? props.Dind
          : 1.0e-3,
    interfaceNormal: readV3(params.interface_normal, [0, 0, 1]),
    rotatedDmiD: rotDmiVal ?? 0.003,
    dbulk:
      typeof params.dbulk === "number"
        ? params.dbulk
        : typeof props.Dbulk === "number"
          ? props.Dbulk
          : 1.0e-3,
    b1: typeof params.b1 === "number" ? params.b1 : -12.5e6,
    b2: typeof params.b2 === "number" ? params.b2 : -4.3e6,
    c11: typeof params.c11 === "number" ? params.c11 : 210e9,
    c12: typeof params.c12 === "number" ? params.c12 : 130e9,
    c44: typeof params.c44 === "number" ? params.c44 : 80e9,
    voigtExx: strain6
      ? strain6[0]
      : typeof params.exx === "number"
        ? params.exx
        : 0.001,
    voigtEyy: strain6
      ? strain6[1]
      : typeof params.eyy === "number"
        ? params.eyy
        : -0.0005,
    voigtEzz: strain6
      ? strain6[2]
      : typeof params.ezz === "number"
        ? params.ezz
        : 0,
    voigtEyz: strain6
      ? strain6[3]
      : typeof params.eyz === "number"
        ? params.eyz
        : 0,
    voigtExz: strain6
      ? strain6[4]
      : typeof params.exz === "number"
        ? params.exz
        : 0,
    voigtExy: strain6
      ? strain6[5]
      : typeof params.exy === "number"
        ? params.exy
        : 0,
    temperatureK:
      typeof thermalNoiseRec?.temperature === "number"
        ? thermalNoiseRec.temperature
        : 300,
    thermalSeed:
      typeof thermalNoiseRec?.seed === "string"
        ? thermalNoiseRec.seed
        : typeof thermalNoiseRec?.seed === "number"
          ? String(thermalNoiseRec.seed)
          : "",
    pbcAxes: pbcAxes.length > 0 ? pbcAxes : ["x"],
    pbcDemag: pbcRec?.demag === "open" ? "open" : "truncated_images",
    pbcImagesX: pbcImageCounts[0] || 10,
    pbcImagesY: pbcImageCounts[1] || 10,
    pbcImagesZ: pbcImageCounts[2] || 10,
    provenance,
    missingFromGraph,
  };
}

export function evaluatePhysicsModuleConflictOrLaneError(
  d: PhysicsModuleDraft,
  interactionDiscretization: InteractionDiscretization,
  activeLane: ReturnType<typeof useActiveLaneCapabilities>,
  sceneObjects: SceneResource["objects"] | undefined,
  sceneStudy: unknown,
  sceneMaterials?: SceneResource["materials"],
): string | null {
  if (d.moduleKind === null) {
    return `Physics module kind '${d.rawKind}' has no editable authoring schema; displaying graph provenance read-only.`;
  }
  if (interactionDiscretization === "unknown") {
    return "Physics interaction lane is unresolved; resolve FDM or FEM before editing.";
  }
  if (d.moduleKind === "magnetoelastic") {
    const avail = interactionAvailabilityForDiscretization(
      "magnetoelastic",
      interactionDiscretization,
    );
    return (
      avail.reason ??
      "Magnetoelastic coupling is backend-supported in FEM prescribed-strain plans, but browser strain-resource authoring is deferred."
    );
  }
  const opId = activeLaneOperationIdForModule(d.moduleKind);
  if (opId && activeLane) {
    const op = resolveActiveLaneOperation(activeLane, opId);
    if (!op.enabled) return op.reason;
  }
  if (d.moduleKind === "demag" && d.scopeKind === "global") {
    const check = validateInteractionDraftForDiscretization(
      {
        id: "demag",
        enabled: d.enabled,
        present: true,
        values: { method: d.demagRealization },
      },
      interactionDiscretization,
    );
    if (check) return check.error;
  }

  const studyRec = asJsonRecord(sceneStudy);
  if (d.moduleKind === "rotated_interfacial_dmi" && d.enabled) {
    const conflicting = activeObjectScopedDmiKind(sceneObjects);
    if (conflicting) {
      return `Rotated interfacial DMI conflicts with active object-scoped ${conflicting}. Disable or remove the object-scoped DMI before applying the study-level term.`;
    }
    if (d.rotatedDmiD !== 0 && studyRec?.exchange_enabled === false) {
      return ROTATED_DMI_EXCHANGE_ERROR;
    }
  }
  if (
    (d.moduleKind === "interfacial_dmi" || d.moduleKind === "bulk_dmi") &&
    d.scopeKind === "object" &&
    d.present &&
    d.enabled &&
    studyRotatedDmiNumber(studyRec) !== null
  ) {
    return `Object-scoped ${d.moduleKind} conflicts with active study-level rotated interfacial DMI. Disable or remove the study-level term before applying the object-scoped DMI.`;
  }
  if (d.moduleKind === "exchange" && !d.enabled) {
    const disablesStudyExchange =
      d.scopeKind === "global" ||
      (d.objectId !== null &&
        resolveTargetStudyExchangeEnabled({
          objectId: d.objectId,
          nextEnabled: false,
          studyRec,
          sceneObjects,
          sceneMaterials,
        }) === false);
    if (disablesStudyExchange) {
      const rotVal = studyRotatedDmiNumber(studyRec);
      if (rotVal !== null && rotVal !== 0) {
        return ROTATED_DMI_EXCHANGE_ERROR;
      }
    }
  }
  return null;
}
