import type {
  MaterialPropertiesResource,
  MaterialReferenceResource,
} from "@/kernel/api/apiTypes";

export interface MaterialLibraryPreset {
  id: string;
  name: string;
  properties: MaterialPropertiesResource;
  references: MaterialReferenceResource[];
  summary: string;
}

/** @deprecated Read catalog entries from the backend material library resource. */
export const MATERIAL_LIBRARY_PRESETS: readonly MaterialLibraryPreset[] = [
  {
    id: "permalloy",
    name: "Permalloy Ni80Fe20",
    properties: { Aex: 1.3e-11, Dbulk: null, Dind: null, Ms: 8.0e5, alpha: 0.01 },
    references: [
      {
        label: "Typical micromagnetic parameters",
        url: "https://doi.org/10.1063/1.3072096",
      },
    ],
    summary: "Soft magnetic NiFe seed for thin-film relaxation and vortex tests.",
  },
  {
    id: "cofeb",
    name: "CoFeB",
    properties: { Aex: 1.5e-11, Dbulk: null, Dind: null, Ms: 1.0e6, alpha: 0.008 },
    references: [
      {
        label: "CoFeB thin-film reference",
        url: "https://doi.org/10.1063/1.2711781",
      },
    ],
    summary: "Common spintronics ferromagnet seed; tune stack-specific damping and DMI.",
  },
  {
    id: "yig",
    name: "YIG",
    properties: { Aex: 3.7e-12, Dbulk: null, Dind: null, Ms: 1.4e5, alpha: 1e-4 },
    references: [
      {
        label: "YIG material reference",
        url: "https://doi.org/10.1109/TMAG.1988.194098",
      },
    ],
    summary: "Low-damping ferrimagnetic insulator seed for spin-wave studies.",
  },
  {
    id: "nickel",
    name: "Ni",
    properties: { Aex: 8.0e-12, Dbulk: null, Dind: null, Ms: 4.85e5, alpha: 0.03 },
    references: [
      {
        label: "Nickel micromagnetic seed",
        url: "https://doi.org/10.1103/RevModPhys.17.15",
      },
    ],
    summary: "Nickel seed values; verify damping for the experimental geometry.",
  },
  {
    id: "iron",
    name: "Fe",
    properties: { Aex: 2.1e-11, Dbulk: null, Dind: null, Ms: 1.7e6, alpha: 0.002 },
    references: [
      {
        label: "Iron material constants",
        url: "https://doi.org/10.1063/1.1724669",
      },
    ],
    summary: "High-moment iron seed; anisotropy should be added explicitly if needed.",
  },
];

export function materialPresetIdToSceneMaterialId(presetId: string): string {
  return `mat:${presetId}`;
}

export function materialNameToId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `mat:${slug || "material"}`;
}


export type MaterialPropertyKey = "Ms" | "Aex" | "alpha" | "Dind" | "Dbulk";
export type MaterialPropertyUnit = "A/m" | "J/m" | "1" | "J/m²";

export interface MaterialPropertyField {
  readonly key: MaterialPropertyKey;
  readonly label: string;
  readonly unit: MaterialPropertyUnit;
}

export const MATERIAL_PROPERTY_FIELDS: readonly MaterialPropertyField[] = [
  { key: "Ms", label: "Ms", unit: "A/m" },
  { key: "Aex", label: "Aex", unit: "J/m" },
  { key: "alpha", label: "alpha", unit: "1" },
  { key: "Dind", label: "Dind", unit: "J/m²" },
  { key: "Dbulk", label: "Dbulk", unit: "J/m²" },
];

export type MaterialPropertiesDraft = Record<MaterialPropertyKey, string>;

export type MaterialPropertiesDraftResult =
  | { properties: MaterialPropertiesResource }
  | { error: string; field: MaterialPropertyKey };

const DECIMAL_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Drafts use SI values, with absence represented separately from numeric zero. */
export function materialPropertiesFromDraft(
  draft: MaterialPropertiesDraft,
): MaterialPropertiesDraftResult {
  const properties: MaterialPropertiesResource = {
    Ms: null,
    Aex: null,
    alpha: 0,
    Dind: null,
    Dbulk: null,
  };
  for (const { key, label } of MATERIAL_PROPERTY_FIELDS) {
    const text = draft[key].trim();
    if (!text) {
      if (key === "alpha") return { error: "alpha is required.", field: key };
      continue;
    }
    const value = Number(text);
    if (!DECIMAL_NUMBER.test(text) || !Number.isFinite(value)) {
      return { error: `${label} must be a finite decimal SI value.`, field: key };
    }
    if (key === "Ms" && value <= 0) {
      return { error: "Ms must be greater than zero when provided.", field: key };
    }
    if ((key === "Aex" || key === "alpha") && value < 0) {
      return { error: `${label} must be zero or greater.`, field: key };
    }
    properties[key] = value;
  }
  return { properties };
}

export function materialPropertiesToDraft(
  properties: Readonly<MaterialPropertiesResource>,
): MaterialPropertiesDraft {
  const numberText = (value: number | null | undefined): string =>
    typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  return {
    Ms: numberText(properties.Ms),
    Aex: numberText(properties.Aex),
    alpha: numberText(properties.alpha),
    Dind: numberText(properties.Dind),
    Dbulk: numberText(properties.Dbulk),
  };
}

/** A saved baseline remains sufficient after its catalog entry changes or is deleted. */
export interface MaterialSourceSnapshot {
  readonly catalog_id: string;
  readonly catalog_revision: number;
  readonly name: string;
  readonly kind: "builtin" | "custom" | "modified";
  readonly properties: Readonly<MaterialPropertiesResource>;
  readonly references?: readonly MaterialReferenceResource[] | null;
}

export interface MaterialSourcePropertyChange {
  key: MaterialPropertyKey;
  label: string;
  unit: MaterialPropertyUnit;
  before: number | null;
  after: number | null;
}

export interface MaterialSourceReferenceChange {
  key: "references";
  label: "References";
  unit: null;
  before: readonly MaterialReferenceResource[];
  after: readonly MaterialReferenceResource[];
}

export type MaterialSourceChange = MaterialSourcePropertyChange | MaterialSourceReferenceChange;
export type MaterialSourceStatus = "unknown" | "unmodified" | "modified";

const REFERENCE_FIELDS = ["label", "url", "citation"] as const;

function referencesEqual(
  left: readonly MaterialReferenceResource[],
  right: readonly MaterialReferenceResource[],
): boolean {
  return left.length === right.length && left.every((reference, index) =>
    REFERENCE_FIELDS.every((key) => (reference[key] ?? "") === (right[index][key] ?? "")),
  );
}

export function materialSourceChanges(
  properties: Readonly<MaterialPropertiesResource>,
  references: readonly MaterialReferenceResource[] | null | undefined,
  source: MaterialSourceSnapshot | null | undefined,
): MaterialSourceChange[] {
  if (!source) return [];
  const changes: MaterialSourceChange[] = [];
  for (const { key, label, unit } of MATERIAL_PROPERTY_FIELDS) {
    const before = source.properties[key] ?? null;
    const after = properties[key] ?? null;
    if (before !== after) changes.push({ key, label, unit, before, after });
  }
  const baselineReferences = source.references ?? [];
  const currentReferences = references ?? [];
  if (!referencesEqual(baselineReferences, currentReferences)) {
    changes.push({
      key: "references",
      label: "References",
      unit: null,
      before: baselineReferences.map((reference) => ({ ...reference })),
      after: currentReferences.map((reference) => ({ ...reference })),
    });
  }
  return changes;
}

export function materialSourceStatus(
  properties: Readonly<MaterialPropertiesResource>,
  references: readonly MaterialReferenceResource[] | null | undefined,
  source: MaterialSourceSnapshot | null | undefined,
): MaterialSourceStatus {
  if (!source) return "unknown";
  return materialSourceChanges(properties, references, source).length ? "modified" : "unmodified";
}

export function formatMaterialSourceChange(change: MaterialSourceChange): string {
  if (change.key === "references") {
    const referencesText = (references: readonly MaterialReferenceResource[]): string =>
      references.length
        ? references.map((reference) => REFERENCE_FIELDS
          .map((key) => reference[key])
          .filter((value): value is string => typeof value === "string" && value !== "")
          .join(" — ") || "Empty reference").join("; ")
        : "None";
    return `References: ${referencesText(change.before)} → ${referencesText(change.after)}`;
  }
  const valueText = (value: number | null): string => value === null ? "Not set" : String(value);
  return `${change.label}: ${valueText(change.before)} → ${valueText(change.after)} ${change.unit}`;
}
