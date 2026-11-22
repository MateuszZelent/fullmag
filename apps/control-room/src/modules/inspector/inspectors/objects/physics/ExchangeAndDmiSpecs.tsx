"use client";

import type { JsonObject } from "@/kernel/api/apiTypes";

import {
  DMI_UNITS,
  EXCHANGE_UNITS,
  normalizeVector3,
  vectorNorm,
} from "../../../panels/model-roots/SpecInspectorHost";
import type { InspectorRowSpec } from "../../../template";
import type { PhysicsModuleDraft } from "./physicsShared";

export function buildExchangeAndDmiRows(): InspectorRowSpec<PhysicsModuleDraft>[] {
  return [
    /* Exchange */
    {
      type: "readonly",
      label: "Stiffness source",
      showWhen: (d: PhysicsModuleDraft) =>
        d.moduleKind === "exchange" && d.scopeKind === "global",
      format: () =>
        "Numeric A_ex is owned by each object's assigned material; this switch gates global exchange assembly.",
    },
    {
      key: "aex",
      type: "quantity",
      label: "Material exchange stiffness",
      symbol: (
        <>
          A<sub>ex</sub>
        </>
      ),
      units: EXCHANGE_UNITS,
      defaultDisplayUnit: "pJ/m",
      min: 0,
      showWhen: (d: PhysicsModuleDraft) =>
        d.moduleKind === "exchange" && d.scopeKind === "object",
      disabledReason: (d: PhysicsModuleDraft) =>
        !d.hasAssignedMaterial
          ? "Assign a material on Object Material before editing A_ex."
          : null,
    },
    /* Interfacial DMI */
    {
      key: "dind",
      type: "quantity",
      label: "Interfacial DMI constant",
      symbol: (
        <>
          D<sub>ind</sub>
        </>
      ),
      units: DMI_UNITS,
      defaultDisplayUnit: "mJ/m\u00b2",
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "interfacial_dmi",
    },
    {
      key: "interfaceNormal",
      type: "vector3",
      label: "Symmetry-breaking interface normal",
      symbol: <>{"n\u0302"}</>,
      axisPresets: true,
      normalizeAction: true,
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "interfacial_dmi",
      validate: (vec: readonly [number, number, number]) =>
        vectorNorm(vec) < 1e-12 ? "Interface normal must be non-zero." : null,
    },
    /* Rotated Interfacial DMI (`study.rotated_interfacial_dmi: number | null`) */
    {
      key: "rotatedDmiD",
      type: "quantity",
      label: "Rotated interfacial DMI constant",
      symbol: <>D</>,
      hint: "Göbel rotated DMI coefficient (D21 = D32 = D) stored on study.rotated_interfacial_dmi.",
      units: DMI_UNITS,
      defaultDisplayUnit: "mJ/m\u00b2",
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "rotated_interfacial_dmi",
    },
    /* Writable Bulk DMI (`dbulk`) */
    {
      key: "dbulk",
      type: "quantity",
      label: "Bulk DMI constant",
      symbol: (
        <>
          D<sub>bulk</sub>
        </>
      ),
      units: DMI_UNITS,
      defaultDisplayUnit: "mJ/m\u00b2",
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "bulk_dmi",
    },
  ];
}

export function buildExchangeOrDmiObjectParams(
  draft: PhysicsModuleDraft,
): JsonObject | null {
  switch (draft.moduleKind) {
    case "interfacial_dmi":
      return {
        dind: draft.dind,
        interface_normal: normalizeVector3(draft.interfaceNormal, [0, 0, 1]),
      };
    case "bulk_dmi":
      return { dbulk: draft.dbulk };
    default:
      return null;
  }
}

export function applyExchangeOrDmiStudyPatch(
  draft: PhysicsModuleDraft,
  studyRec: Record<string, unknown> | null,
  studyPatch: JsonObject,
): boolean {
  if (draft.moduleKind === "exchange") {
    studyPatch.exchange_enabled = draft.enabled;
    return true;
  }
  if (draft.moduleKind === "rotated_interfacial_dmi") {
    if (!draft.enabled) {
      studyPatch.rotated_interfacial_dmi = null;
      if (studyRec?.rotated_interfacial_dmi_object_ids != null) {
        studyPatch.rotated_interfacial_dmi_object_ids = null;
      }
    } else {
      studyPatch.rotated_interfacial_dmi = draft.rotatedDmiD;
    }
    return true;
  }
  return false;
}
