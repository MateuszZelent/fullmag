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
