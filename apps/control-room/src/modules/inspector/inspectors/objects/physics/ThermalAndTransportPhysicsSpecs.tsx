"use client";

import type {
  JsonObject,
  PhysicsGraphModuleResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { validateBornCubicStability } from "../../../panels/material/ObjectMaterialSpec";
import {
  ELASTIC_MODULUS_UNITS,
  MAGNETOELASTIC_B_UNITS,
  TEMPERATURE_UNITS,
} from "../../../panels/model-roots/SpecInspectorHost";
import type { InspectorRowSpec } from "../../../template";
import { asJsonRecord, type PhysicsModuleDraft } from "./physicsShared";

export interface ScopedModuleLink {
  id: string;
  kind: string;
  label: string;
  selection: Omit<Selection, "moduleSource">;
}

export function buildObjectTransportAndSpinLinks(
  objectId: string,
  modules: readonly PhysicsGraphModuleResource[] | undefined,
): readonly ScopedModuleLink[] {
  const mods = modules ?? [];
  const links: ScopedModuleLink[] = [];
  for (const mod of mods) {
    const kind = String(mod.kind ?? "");
    if (
      kind !== "current_transport" &&
      kind !== "spin_transport" &&
      kind !== "spin_torque" &&
      kind !== "oersted_field"
    ) {
      continue;
    }
    const scopes = Array.isArray(mod.applies_to) ? mod.applies_to : [];
    const targetsObject = scopes.some(
      (s) => "object_id" in s && s.object_id === objectId,
    );
    if (!targetsObject) continue;
    const id = String(mod.id ?? "");
    const label = String(mod.presentation?.label ?? id);
    const nodeId = `model:object:${objectId}:physics:module:${encodeURIComponent(id)}`;
    const selectionItem: Omit<Selection, "moduleSource"> =
      kind === "current_transport"
        ? {
            kind: "physics.current-transport",
            label,
            nodeId,
            objectId,
            ref: {
              currentTransportId: id,
              kind: "physics.current-transport",
              nodeId,
              type: "current-transport",
            },
          }
        : kind === "spin_transport"
          ? {
              kind: "physics.spin-transport",
              label,
              nodeId,
              objectId,
              ref: {
                kind: "physics.spin-transport",
                nodeId,
                spinTransportId: id,
                type: "spin-transport",
              },
            }
          : kind === "spin_torque"
            ? {
                kind: "physics.spin-torque",
                label,
                nodeId,
                objectId,
                ref: {
                  kind: "physics.spin-torque",
                  nodeId,
                  spinTorqueId: id,
                  type: "spin-torque",
                },
              }
            : {
                kind: "physics.oersted-field",
                label,
                nodeId,
                objectId,
                ref: {
                  kind: "physics.oersted-field",
                  nodeId,
                  oerstedFieldId: id,
                  type: "oersted-field",
                },
              };
    links.push({
      id,
      kind,
      label,
      selection: selectionItem,
    });
  }
  return links;
}

export function buildThermalElasticAndPbcRows(
  sceneStudy: unknown,
): InspectorRowSpec<PhysicsModuleDraft>[] {
  return [
    /* Magnetoelastic (with all 6 Voigt strain components!) */
    {
      key: "b1",
      type: "quantity",
      label: "Longitudinal magnetoelastic constant",
      symbol: (
        <>
          B<sub>1</sub>
        </>
      ),
      units: MAGNETOELASTIC_B_UNITS,
      defaultDisplayUnit: "MJ/m\u00b3",
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
    },
    {
      key: "b2",
      type: "quantity",
      label: "Shear magnetoelastic constant",
      symbol: (
        <>
          B<sub>2</sub>
        </>
      ),
      units: MAGNETOELASTIC_B_UNITS,
      defaultDisplayUnit: "MJ/m\u00b3",
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
    },
    {
      key: "c11",
      type: "quantity",
      label: "Cubic stiffness C11",
      symbol: (
        <>
          C<sub>11</sub>
        </>
      ),
      units: ELASTIC_MODULUS_UNITS,
      defaultDisplayUnit: "GPa",
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
      validate: (v: number, d: PhysicsModuleDraft) =>
        validateBornCubicStability(v, d.c12, d.c44),
    },
    {
      key: "c12",
      type: "quantity",
      label: "Cubic stiffness C12",
      symbol: (
        <>
          C<sub>12</sub>
        </>
      ),
      units: ELASTIC_MODULUS_UNITS,
      defaultDisplayUnit: "GPa",
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
      validate: (v: number, d: PhysicsModuleDraft) =>
        validateBornCubicStability(d.c11, v, d.c44),
    },
    {
      key: "c44",
      type: "quantity",
      label: "Shear stiffness C44",
      symbol: (
        <>
          C<sub>44</sub>
        </>
      ),
      units: ELASTIC_MODULUS_UNITS,
      defaultDisplayUnit: "GPa",
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
      validate: (v: number, d: PhysicsModuleDraft) =>
        validateBornCubicStability(d.c11, d.c12, v),
    },
    {
      key: "voigtExx",
      type: "number",
      label: "Prescribed normal strain ε_xx",
      symbol: (
        <>
          &epsilon;<sub>xx</sub>
        </>
      ),
      step: 0.0001,
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
    },
    {
      key: "voigtEyy",
      type: "number",
      label: "Prescribed normal strain ε_yy",
      symbol: (
        <>
          &epsilon;<sub>yy</sub>
        </>
      ),
      step: 0.0001,
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
    },
    {
      key: "voigtEzz",
      type: "number",
      label: "Prescribed normal strain ε_zz",
      symbol: (
        <>
          &epsilon;<sub>zz</sub>
        </>
      ),
      step: 0.0001,
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
    },
    {
      key: "voigtEyz",
      type: "number",
      label: "Prescribed shear strain ε_yz",
      symbol: (
        <>
          &epsilon;<sub>yz</sub>
        </>
      ),
      step: 0.0001,
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
    },
    {
      key: "voigtExz",
      type: "number",
      label: "Prescribed shear strain ε_xz",
      symbol: (
        <>
          &epsilon;<sub>xz</sub>
        </>
      ),
      step: 0.0001,
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
    },
    {
      key: "voigtExy",
      type: "number",
      label: "Prescribed shear strain ε_xy",
      symbol: (
        <>
          &epsilon;<sub>xy</sub>
        </>
      ),
      step: 0.0001,
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "magnetoelastic",
    },
    /* Thermal Noise (`study.thermal_noise`) */
    {
      key: "temperatureK",
      type: "quantity",
      label: "Bath temperature",
      symbol: <>T</>,
      units: TEMPERATURE_UNITS,
      defaultDisplayUnit: "K",
      min: 0,
      minExclusive: true,
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "thermal_noise",
      validate: (v: number, d: PhysicsModuleDraft) =>
        d.enabled && !(v > 0)
          ? "Bath temperature must be strictly positive (T > 0 K)."
          : null,
    },
    {
      key: "thermalSeed",
      type: "text",
      mono: true,
      label: "Deterministic PRNG seed",
      placeholder: "Leave empty for entropy",
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "thermal_noise",
      validate: (v: string, d: PhysicsModuleDraft) => {
        if (!d.enabled || v.trim() === "") return null;
        return /^[1-9][0-9]*$/.test(v.trim())
          ? null
          : "Seed must be a positive decimal integer without leading zeroes (e.g. 42).";
      },
    },
    /* Periodic BC (`study.pbc`) */
    {
      key: "pbcAxes",
      type: "toggles",
      label: "Periodic translation axes",
      structural: true,
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "periodic_bc",
      options: [
        { value: "x", label: "X periodic" },
        { value: "y", label: "Y periodic" },
        { value: "z", label: "Z periodic" },
      ],
      validate: (axes: readonly string[], d: PhysicsModuleDraft) =>
        d.enabled && axes.length === 0
          ? "Select at least one periodic axis (1D, 2D, or 3D)."
          : null,
    },
    {
      key: "pbcDemag",
      type: "segmented",
      label: "Demag boundary kernel",
      structural: true,
      showWhen: (d: PhysicsModuleDraft) => d.moduleKind === "periodic_bc",
      options: [
        { value: "truncated_images", label: "Truncated images" },
        { value: "open", label: "Open (no demag)" },
      ],
      validate: (val: string, d: PhysicsModuleDraft) => {
        const studyRec = asJsonRecord(sceneStudy);
        if (
          d.enabled &&
          d.pbcAxes.length > 0 &&
          studyRec?.demag_enabled !== false &&
          val === "open"
        ) {
          return "Periodic axes with active demagnetization require 'Truncated images'.";
        }
        return null;
      },
    },
    {
      key: "pbcImagesX",
      type: "number",
      integer: true,
      min: 1,
      label: "Image repeats along X",
      showWhen: (d: PhysicsModuleDraft) =>
        d.moduleKind === "periodic_bc" &&
        d.pbcDemag === "truncated_images" &&
        d.pbcAxes.includes("x"),
    },
    {
      key: "pbcImagesY",
      type: "number",
      integer: true,
      min: 1,
      label: "Image repeats along Y",
      showWhen: (d: PhysicsModuleDraft) =>
        d.moduleKind === "periodic_bc" &&
        d.pbcDemag === "truncated_images" &&
        d.pbcAxes.includes("y"),
    },
    {
      key: "pbcImagesZ",
      type: "number",
      integer: true,
      min: 1,
      label: "Image repeats along Z",
      showWhen: (d: PhysicsModuleDraft) =>
        d.moduleKind === "periodic_bc" &&
        d.pbcDemag === "truncated_images" &&
        d.pbcAxes.includes("z"),
    },
  ];
}

export function applyThermalOrPbcStudyPatch(
  draft: PhysicsModuleDraft,
  studyPatch: JsonObject,
): boolean {
  if (draft.moduleKind === "thermal_noise") {
    studyPatch.thermal_noise = draft.enabled
      ? {
          temperature: draft.temperatureK,
          seed: draft.thermalSeed.trim() ? draft.thermalSeed.trim() : null,
        }
      : null;
    return true;
  }
  if (draft.moduleKind === "periodic_bc") {
    studyPatch.pbc = draft.enabled
      ? {
          axes: [
            draft.pbcAxes.includes("x") ? "periodic" : "open",
            draft.pbcAxes.includes("y") ? "periodic" : "open",
            draft.pbcAxes.includes("z") ? "periodic" : "open",
          ],
          demag: draft.pbcDemag,
          ...(draft.pbcDemag === "truncated_images"
            ? {
                image_counts: [
                  draft.pbcAxes.includes("x") ? draft.pbcImagesX : 0,
                  draft.pbcAxes.includes("y") ? draft.pbcImagesY : 0,
                  draft.pbcAxes.includes("z") ? draft.pbcImagesZ : 0,
                ],
              }
            : {}),
        }
      : null;
    return true;
  }
  return false;
}
