import type {
  JsonObject,
  ObjectInteractionKind,
  ObjectInteractionPatchRequest,
} from "@/kernel/api/apiTypes";

export const BACKEND_INTERACTION_IDS = [
  "exchange",
  "demag",
  "zeeman",
  "current_transport",
  "spin_torque",
  "interfacial_dmi",
  "bulk_dmi",
  "uniaxial_anisotropy",
  "cubic_anisotropy",
  "oersted_field",
  "magnetoelastic",
] as const;

export type PhysicsInteractionId = (typeof BACKEND_INTERACTION_IDS)[number];

type InteractionAvailability = "object" | "study" | "deferred";
type InteractionScope = "object_or_region" | "global" | "global_or_region";
type InteractionFieldKind = "number" | "select" | "text" | "vector3" | "vector6";

interface InteractionFieldOption {
  label: string;
  value: string;
}

export interface InteractionFieldSpec {
  defaultValue: string | string[];
  description: string;
  id: string;
  kind: InteractionFieldKind;
  label: string;
  options?: InteractionFieldOption[];
  required?: boolean;
  unit: string | null;
}

export interface InteractionSpec {
  availability: InteractionAvailability;
  description: string;
  fields: readonly InteractionFieldSpec[];
  id: PhysicsInteractionId;
  label: string;
  scope: InteractionScope;
  storage: "object_interaction" | "study" | "planner_deferred";
  writableReason?: string;
}

export interface PhysicsInteractionDraft {
  enabled: boolean;
  id: PhysicsInteractionId;
  present: boolean;
  values: Record<string, string | string[]>;
}

export type ObjectInteractionPatchResult =
  | { error: string }
  | { patch: ObjectInteractionPatchRequest };

export type StudyInteractionPatchResult =
  | { error: string }
  | { patch: JsonObject };

const DEMAG_METHOD_OPTIONS: InteractionFieldOption[] = [
  { label: "Auto", value: "auto" },
  { label: "FEM Poisson Robin airbox", value: "poisson_robin" },
  { label: "FEM Poisson Dirichlet airbox", value: "poisson_dirichlet" },
  { label: "FEM BEM", value: "bem" },
  { label: "FEM/BEM Fredkin-Koehler (no airbox)", value: "fredkin_koehler" },
  { label: "FEM FMM", value: "fmm" },
  { label: "FDM multilayer convolution", value: "multilayer_convolution" },
];

const INTERACTION_SPECS: readonly InteractionSpec[] = [
  {
    availability: "study",
    description:
      "Nearest-neighbour exchange stiffness. The numeric A value is owned by assigned materials; this switch controls whether exchange contributes to H_eff for the authored problem.",
    fields: [],
    id: "exchange",
    label: "Exchange",
    scope: "global",
    storage: "study",
  },
  {
    availability: "study",
    description:
      "Magnetostatic self-interaction. Fullmag treats demagnetization as a global study-level interaction because the field couples all magnetic bodies through the air or convolution domain.",
    fields: [
      {
        defaultValue: "auto",
        description:
          "Requested demag realization. Unsupported future methods remain visible for provenance but may be rejected by the planner.",
        id: "method",
        kind: "select",
        label: "Method",
        options: DEMAG_METHOD_OPTIONS,
        unit: null,
      },
    ],
    id: "demag",
    label: "Demagnetization",
    scope: "global",
    storage: "study",
  },
  {
    availability: "study",
    description:
      "Uniform externally applied magnetic flux density. The Python/script surface expresses this as B_ext in tesla; the planner converts to H_ext where required by a backend.",
    fields: [
      {
        defaultValue: ["0", "0", "0"],
        description: "Uniform external flux density vector [Bx, By, Bz].",
        id: "field",
        kind: "vector3",
        label: "B_ext",
        required: true,
        unit: "T",
      },
    ],
    id: "zeeman",
    label: "Zeeman field",
    scope: "global",
    storage: "study",
  },
  {
    availability: "study",
    description:
      "Typed electric-current transport source used by STT and Oersted authoring workflows. Prescribed density is executable where supported; Ohmic Poisson remains a semantic authoring contract until its runtime lane is qualified.",
    fields: [
      {
        defaultValue: "drive",
        description: "Stable current source name.",
        id: "name",
        kind: "text",
        label: "Name",
        required: true,
        unit: null,
      },
      {
        defaultValue: "prescribed_density",
        description:
          "Current transport realization. Prescribed density is executable in supported lanes; Ohmic Poisson is semantic-only/deferred.",
        id: "model",
        kind: "select",
        label: "Model",
        options: [
          { label: "Prescribed current density", value: "prescribed_density" },
          { label: "Ohmic Poisson", value: "ohmic_poisson" },
        ],
        unit: null,
      },
      {
        defaultValue: "",
        description: "Region where current transport is solved or prescribed.",
        id: "solve_region",
        kind: "text",
        label: "Solve region",
        unit: null,
      },
      {
        defaultValue: ["0", "0", "0"],
        description: "Prescribed electric current density vector.",
        id: "current_density",
        kind: "vector3",
        label: "j",
        unit: "A/m^2",
      },
      {
        defaultValue: "0",
        description: "Electrical conductivity for Ohmic transport.",
        id: "conductivity_s_per_m",
        kind: "number",
        label: "sigma",
        unit: "S/m",
      },
    ],
    id: "current_transport",
    label: "Electric current",
    scope: "global_or_region",
    storage: "study",
  },
  {
    availability: "study",
    description:
      "Typed source-bound Slonczewski, Zhang-Li, and prescribed spin-orbit torque authoring. Unsupported future variants are rejected without mutating the scene.",
    fields: [
      {
        defaultValue: "slonczewski",
        description: "Spin torque model.",
        id: "model",
        kind: "select",
        label: "Model",
        options: [
          { label: "Slonczewski STT", value: "slonczewski" },
          { label: "Zhang-Li STT", value: "zhang_li" },
          { label: "Interface CPP", value: "interface_cpp" },
          { label: "Drift diffusion", value: "drift_diffusion" },
          { label: "Spin-orbit torque", value: "spin_orbit_torque" },
        ],
        unit: null,
      },
      {
        defaultValue: "",
        description:
          "Optional named CurrentTransport source. When empty, inline current-density fields define the drive where supported.",
        id: "current_source",
        kind: "text",
        label: "Current source",
        unit: null,
      },
      {
        defaultValue: ["0", "0", "0"],
        description: "Inline electric current density for torque models.",
        id: "current_density",
        kind: "vector3",
        label: "j",
        unit: "A/m^2",
      },
      {
        defaultValue: ["0", "0", "1"],
        description: "Spin polarization direction.",
        id: "spin_polarization",
        kind: "vector3",
        label: "p",
        unit: null,
      },
      {
        defaultValue: "0.4",
        description: "Torque degree/efficiency parameter.",
        id: "degree",
        kind: "number",
        label: "Degree",
        unit: "1",
      },
      {
        defaultValue: "0",
        description: "Nonadiabatic Zhang-Li beta parameter.",
        id: "beta",
        kind: "number",
        label: "Beta",
        unit: "1",
      },
    ],
    id: "spin_torque",
    label: "Spin torque",
    scope: "object_or_region",
    storage: "study",
  },
  {
    availability: "object",
    description:
      "Interfacial Dzyaloshinskii-Moriya interaction. The editable control room path currently stores the interfacial D constant on the object interaction entry.",
    fields: [
      {
        defaultValue: "1e-3",
        description: "Interfacial DMI constant.",
        id: "dind",
        kind: "number",
        label: "D_ind",
        required: true,
        unit: "J/m^2",
      },
    ],
    id: "interfacial_dmi",
    label: "Interfacial DMI",
    scope: "object_or_region",
    storage: "object_interaction",
  },
  {
    availability: "study",
    description:
      "Bulk DMI is implemented in execution backends and ProblemIR, but the current scene authoring stack does not yet have a safe Python/UI round-trip path.",
    fields: [
      {
        defaultValue: "0",
        description: "Bulk DMI constant.",
        id: "d_bulk",
        kind: "number",
        label: "D_bulk",
        unit: "J/m^3",
      },
    ],
    id: "bulk_dmi",
    label: "Bulk DMI",
    scope: "object_or_region",
    storage: "planner_deferred",
    writableReason:
      "Bulk DMI is backend-supported but not yet writable from the control room.",
  },
  {
    availability: "object",
    description:
      "Uniaxial anisotropy with a user-defined easy axis. K values are energy densities in SI units.",
    fields: [
      {
        defaultValue: "0",
        description: "First-order uniaxial anisotropy constant.",
        id: "ku1",
        kind: "number",
        label: "K_u1",
        required: true,
        unit: "J/m^3",
      },
      {
        defaultValue: "0",
        description: "Second-order uniaxial anisotropy constant when supported.",
        id: "ku2",
        kind: "number",
        label: "K_u2",
        unit: "J/m^3",
      },
      {
        defaultValue: ["0", "0", "1"],
        description: "Easy-axis direction. The backend normalizes the vector.",
        id: "axis",
        kind: "vector3",
        label: "Axis",
        required: true,
        unit: null,
      },
    ],
    id: "uniaxial_anisotropy",
    label: "Uniaxial anisotropy",
    scope: "object_or_region",
    storage: "object_interaction",
  },
  {
    availability: "deferred",
    description:
      "Cubic anisotropy is available in backend plan/runtime structures, but control-room authoring needs canonical material/region round-trip before edits are safe.",
    fields: [
      {
        defaultValue: "0",
        description: "First cubic anisotropy constant.",
        id: "kc1",
        kind: "number",
        label: "K_c1",
        unit: "J/m^3",
      },
      {
        defaultValue: "0",
        description: "Second cubic anisotropy constant.",
        id: "kc2",
        kind: "number",
        label: "K_c2",
        unit: "J/m^3",
      },
      {
        defaultValue: "0",
        description: "Third cubic anisotropy constant.",
        id: "kc3",
        kind: "number",
        label: "K_c3",
        unit: "J/m^3",
      },
      {
        defaultValue: ["1", "0", "0"],
        description: "First cubic crystal axis.",
        id: "axis1",
        kind: "vector3",
        label: "Axis 1",
        unit: null,
      },
      {
        defaultValue: ["0", "1", "0"],
        description: "Second cubic crystal axis.",
        id: "axis2",
        kind: "vector3",
        label: "Axis 2",
        unit: null,
      },
    ],
    id: "cubic_anisotropy",
    label: "Cubic anisotropy",
    scope: "object_or_region",
    storage: "planner_deferred",
    writableReason:
      "Cubic anisotropy is backend-supported but not yet writable from the control room.",
  },
  {
    availability: "study",
    description:
      "Typed Oersted field authoring from a named current-transport source or an analytic cylindrical conductor.",
    fields: [
      {
        defaultValue: "current_transport",
        description:
          "Regional source model. Current transport binds to a solve_region, antenna sources describe RF field drives, and point sources remain a planned source resource.",
        id: "source_mode",
        kind: "select",
        label: "Source mode",
        options: [
          { label: "Current transport solve region", value: "current_transport" },
          { label: "Antenna field source", value: "antenna_field_source" },
          { label: "Point source", value: "point_source" },
        ],
        unit: null,
      },
      {
        defaultValue: "",
        description:
          "Named magnetic or current-carrying region that owns the local source.",
        id: "region_id",
        kind: "text",
        label: "Region ID",
        unit: null,
      },
      {
        defaultValue: "drive",
        description:
          "Stable source name used by current_modules and OerstedField(source=...).",
        id: "source_name",
        kind: "text",
        label: "Source name",
        unit: null,
      },
      {
        defaultValue: ["0", "0", "0"],
        description:
          "Prescribed current density for current_transport source mode.",
        id: "current_density",
        kind: "vector3",
        label: "j",
        unit: "A/m^2",
      },
      {
        defaultValue: "0",
        description: "Current through the source conductor.",
        id: "current",
        kind: "number",
        label: "I",
        unit: "A",
      },
      {
        defaultValue: "0",
        description: "Cylindrical source radius.",
        id: "radius",
        kind: "number",
        label: "Radius",
        unit: "m",
      },
      {
        defaultValue: ["0", "0", "1"],
        description: "Current-flow axis.",
        id: "axis",
        kind: "vector3",
        label: "Axis",
        unit: null,
      },
    ],
    id: "oersted_field",
    label: "Regional field source",
    scope: "global_or_region",
    storage: "study",
  },
  {
    availability: "deferred",
    description:
      "Prescribed-strain magnetoelastic coupling is represented in ProblemIR/backend paths. The browser authoring surface still needs canonical strain-source resources.",
    fields: [
      {
        defaultValue: "0",
        description: "First magnetoelastic coupling constant.",
        id: "b1",
        kind: "number",
        label: "B1",
        unit: "Pa",
      },
      {
        defaultValue: "0",
        description: "Second magnetoelastic coupling constant.",
        id: "b2",
        kind: "number",
        label: "B2",
        unit: "Pa",
      },
      {
        defaultValue: ["0", "0", "0", "0", "0", "0"],
        description: "Uniform strain tensor in Voigt order.",
        id: "strain",
        kind: "vector6",
        label: "epsilon",
        unit: "1",
      },
    ],
    id: "magnetoelastic",
    label: "Magnetoelastic",
    scope: "object_or_region",
    storage: "planner_deferred",
    writableReason:
      "Magnetoelastic coupling is backend-supported but not yet writable from the control room.",
  },
];

export function allInteractionSpecs(): readonly InteractionSpec[] {
  return INTERACTION_SPECS;
}

export function findInteractionSpec(
  id: PhysicsInteractionId,
): InteractionSpec | undefined {
  return INTERACTION_SPECS.find((spec) => spec.id === id);
}

export function writableObjectInteractionIds(): ObjectInteractionKind[] {
  const ids: ObjectInteractionKind[] = [];
  for (const spec of INTERACTION_SPECS) {
    if (spec.storage === "object_interaction" && isObjectInteractionKind(spec.id)) {
      ids.push(spec.id);
    }
  }
  return ids;
}

export function defaultDraftForInteraction(
  id: PhysicsInteractionId,
): PhysicsInteractionDraft {
  const spec = requireInteractionSpec(id);
  return {
    enabled: true,
    id,
    present: spec.availability !== "deferred",
    values: Object.fromEntries(
      spec.fields.map((field) => [field.id, field.defaultValue]),
    ),
  };
}

export function draftFromObjectInteractionResource(
  id: ObjectInteractionKind,
  params: JsonObject,
  present: boolean,
  enabled: boolean,
): PhysicsInteractionDraft {
  const base = defaultDraftForInteraction(id);
  return {
    ...base,
    enabled: present ? enabled : base.enabled,
    present,
    values: {
      ...base.values,
      ...valuesFromParams(id, params),
    },
  };
}

export function buildObjectInteractionPatchFromDraft(
  draft: PhysicsInteractionDraft,
): ObjectInteractionPatchResult {
  const spec = requireInteractionSpec(draft.id);
  if (spec.storage !== "object_interaction" || !isObjectInteractionKind(draft.id)) {
    return { error: deferredMessage(spec) };
  }
  if (!draft.present && (draft.id === "exchange" || draft.id === "demag")) {
    return { error: `${spec.label} is required and cannot be removed.` };
  }

  const paramsResult = objectParamsFromDraft(draft);
  if ("error" in paramsResult) return paramsResult;

  return {
    patch: {
      enabled: draft.enabled,
      params: paramsResult.params,
      present: draft.present,
    },
  };
}

export function buildStudyInteractionPatchFromDraft(
  draft: PhysicsInteractionDraft,
): StudyInteractionPatchResult {
  const spec = requireInteractionSpec(draft.id);
  if (spec.storage !== "study") {
    return { error: deferredMessage(spec) };
  }
  if (draft.id === "demag") {
    const method = stringValue(draft.values.method, "auto");
    return {
      patch: {
        study: {
          demag_enabled: draft.enabled && draft.present,
          demag_realization: method === "auto" ? null : method,
        },
      },
    };
  }
  if (draft.id === "exchange") {
    return {
      patch: {
        study: {
          exchange_enabled: draft.enabled && draft.present,
        },
      },
    };
  }
  if (draft.id === "zeeman") {
    const field = parseVector(draft.values.field, 3, "B_ext");
    if ("error" in field) return field;
    return {
      patch: {
        study: {
          external_field: draft.enabled && draft.present ? field.value : null,
        },
      },
    };
  }
  return { error: deferredMessage(spec) };
}

function valuesFromParams(
  id: ObjectInteractionKind,
  params: JsonObject,
): Record<string, string | string[]> {
  if (id === "interfacial_dmi") {
    return { dind: stringValue(params.dind, "1e-3") };
  }
  if (id === "uniaxial_anisotropy") {
    return {
      axis: vectorValue(params.axis, ["0", "0", "1"], 3),
      ku1: stringValue(params.ku1, "0"),
      ku2: stringValue(params.ku2, "0"),
    };
  }
  return {};
}

function objectParamsFromDraft(
  draft: PhysicsInteractionDraft,
): { error: string } | { params: JsonObject } {
  if (draft.id === "interfacial_dmi") {
    const dind = parseNumber(draft.values.dind, "D_ind");
    if ("error" in dind) return dind;
    return { params: { dind: dind.value } };
  }
  if (draft.id === "uniaxial_anisotropy") {
    const ku1 = parseNumber(draft.values.ku1, "K_u1");
    if ("error" in ku1) return ku1;
    const ku2 = parseNumber(draft.values.ku2, "K_u2", { allowEmpty: true });
    if ("error" in ku2) return ku2;
    const axis = parseVector(draft.values.axis, 3, "Axis");
    if ("error" in axis) return axis;
    return {
      params: {
        axis: axis.value,
        ku1: ku1.value,
        ku2: ku2.value,
      },
    };
  }
  return { params: {} };
}

function requireInteractionSpec(id: PhysicsInteractionId): InteractionSpec {
  const spec = findInteractionSpec(id);
  if (!spec) throw new Error(`Unknown physics interaction: ${id}`);
  return spec;
}

function deferredMessage(spec: InteractionSpec): string {
  return (
    spec.writableReason ??
    `${spec.label} is not writable from the current control-room authoring surface.`
  );
}

function isObjectInteractionKind(id: string): id is ObjectInteractionKind {
  return (
    id === "exchange" ||
    id === "demag" ||
    id === "interfacial_dmi" ||
    id === "uniaxial_anisotropy"
  );
}

function parseNumber(
  value: string | string[] | undefined,
  label: string,
  options: { allowEmpty?: boolean } = {},
): { error: string } | { value: number } {
  const raw = Array.isArray(value) ? value[0] : value;
  if ((raw === undefined || raw.trim() === "") && options.allowEmpty) {
    return { value: 0 };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return { error: `${label} must be a finite number.` };
  }
  return { value: parsed };
}

function parseVector(
  value: string | string[] | undefined,
  expectedLength: number,
  label: string,
): { error: string } | { value: number[] } {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  if (values.length !== expectedLength) {
    return {
      error: `${label} must contain exactly ${expectedLength} numeric values.`,
    };
  }
  const parsed = values.map((entry) => Number(entry));
  if (!parsed.every(Number.isFinite)) {
    return {
      error: `${label} must contain exactly ${expectedLength} numeric values.`,
    };
  }
  return { value: parsed };
}

function stringValue(
  value: unknown,
  fallback: string,
): string {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value === "string" ? value : fallback;
}

function vectorValue(
  value: unknown,
  fallback: string[],
  expectedLength: number,
): string[] {
  if (!Array.isArray(value) || value.length !== expectedLength) return fallback;
  return value.map((entry) => String(entry));
}
