export interface ImportFormat {
  readonly id: string;
  readonly label: string;
  readonly extensions: readonly string[];
  /** What survives the import, as the design spec states it. */
  readonly fidelity: string;
  /** Null when this build can read it; otherwise why it cannot yet. */
  readonly unavailableReason: string | null;
}

const NO_IMPORTER = "No importer for this format ships in this build yet.";

export const IMPORT_FORMATS: readonly ImportFormat[] = [
  {
    id: "fms",
    label: "Fullmag",
    extensions: [".fms"],
    fidelity: "Full, including results and history; older schemas are migrated.",
    unavailableReason: null,
  },
  {
    id: "mx3",
    label: "mumax³",
    extensions: [".mx3"],
    fidelity: "Full: grid, regions, material parameters and run script; ext_ calls are flagged.",
    unavailableReason: NO_IMPORTER,
  },
  {
    id: "mif",
    label: "OOMMF",
    extensions: [".mif"],
    fidelity: "Full: geometry, regions and the Oxs_ evolver; custom Tcl is reported, not executed.",
    unavailableReason: NO_IMPORTER,
  },
  {
    id: "mph",
    label: "COMSOL",
    extensions: [".mph"],
    fidelity: "Partial: mesh and materials into an FEM problem; other physics are skipped.",
    unavailableReason: NO_IMPORTER,
  },
  {
    id: "mesh",
    label: "Mesh",
    extensions: [".stl", ".vtk", ".msh"],
    fidelity: "Geometry only.",
    unavailableReason: NO_IMPORTER,
  },
  {
    id: "field",
    label: "Field",
    extensions: [".ovf", ".omf", ".npy"],
    fidelity: "Initial state only.",
    unavailableReason: NO_IMPORTER,
  },
];

export type FileClassification =
  | { readonly kind: "supported"; readonly format: ImportFormat }
  | { readonly kind: "unsupported"; readonly format: ImportFormat; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

const extensionOf = (fileName: string): string => {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot).toLowerCase();
};

/**
 * Decide what a dropped file is. Nothing is read or written here: an unknown or
 * not-yet-supported file is refused with a reason before it can do anything.
 */
export function classifyImportFile(fileName: string): FileClassification {
  const extension = extensionOf(fileName);
  const format = IMPORT_FORMATS.find((f) => f.extensions.includes(extension));
  if (!format) {
    return {
      kind: "unknown",
      reason: extension
        ? `Fullmag does not recognise ${extension} files.`
        : "The file has no extension, so Fullmag cannot tell what it is.",
    };
  }
  if (format.unavailableReason) {
    return {
      kind: "unsupported",
      format,
      reason: `${format.label} (${extension}) cannot be imported yet. ${format.unavailableReason}`,
    };
  }
  return { kind: "supported", format };
}

export const IMPORT_ACCEPT = IMPORT_FORMATS.flatMap((f) => f.extensions).join(",");
