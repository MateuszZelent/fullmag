"use client";

import type { ReactElement } from "react";

import type { JsonObject } from "@/kernel/api/apiTypes";
import { Button } from "@/shared/ui/Button";

import { orthogonalizeAxisGramSchmidt } from "../../../panels/material/ObjectMaterialSpec";
import {
  ANISOTROPY_UNITS,
  FIELD_TESLA_UNITS,
  normalizeVector3,
  vectorNorm,
} from "../../../panels/model-roots/SpecInspectorHost";
import type {
  InspectorActionContext,
  InspectorRowSpec,
} from "../../../template";
import type { PhysicsModuleDraft } from "./physicsShared";

export function buildAnisotropyAndZeemanRows(): InspectorRowSpec<PhysicsModuleDraft>[] {
  return [
    /* Zeeman */
    {
      key: "zeemanVectorT",
      type: "vector3",
      label: "Static external field",
      symbol: (
        <>
          B<sub>ext</sub>
        </>
      ),
      units: FIELD_TESLA_UNITS,
      defaultDisplayUnit: "mT",
      coordinateModes: ["cartesian", "spherical"] as const,
      axisPresets: true,
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "zeeman",
    },
    /* Uniaxial Anisotropy (with Ku2 + Bk = 2*Ku1/Ms readout!) */
    {
      key: "ku1",
      type: "quantity",
      label: "First-order uniaxial constant",
      symbol: (
        <>
          K<sub>u1</sub>
        </>
      ),
      units: ANISOTROPY_UNITS,
      defaultDisplayUnit: "kJ/m\u00b3",
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "uniaxial_anisotropy",
    },
    {
      key: "ku2",
      type: "quantity",
      label: "Second-order uniaxial constant",
      symbol: (
        <>
          K<sub>u2</sub>
        </>
      ),
      units: ANISOTROPY_UNITS,
      defaultDisplayUnit: "kJ/m\u00b3",
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "uniaxial_anisotropy",
    },
    {
      key: "uniaxialAxis",
      type: "vector3",
      label: "Easy / cone symmetry axis",
      symbol: <>{"u\u0302"}</>,
      axisPresets: true,
      normalizeAction: true,
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "uniaxial_anisotropy",
      validate: (vec: readonly [number, number, number]) =>
        vectorNorm(vec) < 1e-12 ? "Uniaxial axis must be non-zero." : null,
    },
    {
      type: "readonly",
      label: "Anisotropy field (Bk = 2·Ku1/Ms)",
      symbol: (
        <>
          B<sub>k</sub>
        </>
      ),
      mono: true,
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "uniaxial_anisotropy",
      format: (d: PhysicsModuleDraft) =>
        d.present &&
        d.enabled &&
        Number.isFinite(d.ku1) &&
        typeof d.materialMs === "number" &&
        Number.isFinite(d.materialMs) &&
        d.materialMs > 0
          ? `${((2 * d.ku1) / d.materialMs).toPrecision(4)} T`
          : "Requires active Ku1 and assigned Ms > 0",
    },
    /* Cubic Anisotropy */
    {
      key: "kc1",
      type: "quantity",
      label: "First-order cubic constant",
      symbol: (
        <>
          K<sub>c1</sub>
        </>
      ),
      units: ANISOTROPY_UNITS,
      defaultDisplayUnit: "kJ/m\u00b3",
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "cubic_anisotropy",
    },
    {
      key: "kc2",
      type: "quantity",
      label: "Second-order cubic constant",
      symbol: (
        <>
          K<sub>c2</sub>
        </>
      ),
      units: ANISOTROPY_UNITS,
      defaultDisplayUnit: "kJ/m\u00b3",
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "cubic_anisotropy",
    },
    {
      key: "kc3",
      type: "quantity",
      label: "Third-order cubic constant",
      symbol: (
        <>
          K<sub>c3</sub>
        </>
      ),
      units: ANISOTROPY_UNITS,
      defaultDisplayUnit: "kJ/m\u00b3",
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "cubic_anisotropy",
    },
    {
      key: "cubicAxis1",
      type: "vector3",
      label: "Crystal axis [100]",
      symbol: (
        <>
          {"c\u0302"}
          <sub>1</sub>
        </>
      ),
      axisPresets: true,
      normalizeAction: true,
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "cubic_anisotropy",
      validate: (vec: readonly [number, number, number]) =>
        vectorNorm(vec) < 1e-12 ? "Axis c1 must be non-zero." : null,
    },
    {
      key: "cubicAxis2",
      type: "vector3",
      label: "Crystal axis [010]",
      symbol: (
        <>
          {"c\u0302"}
          <sub>2</sub>
        </>
      ),
      axisPresets: true,
      normalizeAction: true,
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "cubic_anisotropy",
      validate: (vec: readonly [number, number, number], d: PhysicsModuleDraft) => {
        if (vectorNorm(vec) < 1e-12) return "Axis c2 must be non-zero.";
        const u1 = normalizeVector3(d.cubicAxis1);
        const u2 = normalizeVector3(vec);
        const dot = Math.abs(u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2]);
        return dot > 1e-6 ? "Crystal axes c1 and c2 must be orthogonal." : null;
      },
    },
  ];
}

export function renderCubicAnisotropyFooter(
  ctx: InspectorActionContext<PhysicsModuleDraft>,
): ReactElement | null {
  if (ctx.draft.moduleKind !== "cubic_anisotropy") return null;
  return (
    <Button
      size="sm"
      type="button"
      variant="secondary"
      onClick={() =>
        ctx.setField(
          "cubicAxis2",
          orthogonalizeAxisGramSchmidt(ctx.draft.cubicAxis1, ctx.draft.cubicAxis2),
        )
      }
    >
      Orthogonalize c₂ (Gram-Schmidt)
    </Button>
  );
}

export function buildAnisotropyObjectParams(
  draft: PhysicsModuleDraft,
): JsonObject | null {
  switch (draft.moduleKind) {
    case "uniaxial_anisotropy":
      return {
        ku1: draft.ku1,
        ku2: draft.ku2,
        axis: normalizeVector3(draft.uniaxialAxis, [0, 0, 1]),
      };
    case "cubic_anisotropy":
      return {
        kc1: draft.kc1,
        kc2: draft.kc2,
        kc3: draft.kc3,
        axis1: normalizeVector3(draft.cubicAxis1, [1, 0, 0]),
        axis2: normalizeVector3(draft.cubicAxis2, [0, 1, 0]),
      };
    default:
      return null;
  }
}

export function applyZeemanStudyPatch(
  draft: PhysicsModuleDraft,
  studyPatch: JsonObject,
): boolean {
  if (draft.moduleKind === "zeeman") {
    studyPatch.external_field = draft.enabled ? [...draft.zeemanVectorT] : null;
    return true;
  }
  return false;
}
