import { STL_UPLOAD_MAX_BYTES } from "../api/transportLimits";
import type {
  ImportSessionAssetRequest,
  JsonObject,
  RequestOptions,
  SessionAssetImportResponse,
} from "../api/apiTypes";
import { bytesToBase64 } from "../persistence/ProjectDocumentController";

export const STL_IMPORT_MAX_BYTES = STL_UPLOAD_MAX_BYTES;

export const STL_LENGTH_UNITS = ["m", "mm", "um", "nm"] as const;
export type StlLengthUnit = (typeof STL_LENGTH_UNITS)[number];

export interface StlFileInput {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ImportedStlSourceApi {
  readonly persistence: {
    readonly assets: {
      import(
        request: ImportSessionAssetRequest,
        options?: RequestOptions,
      ): Promise<SessionAssetImportResponse>;
    };
  };
}

export interface ImportedStlGeometry {
  readonly geometry: JsonObject;
  readonly name: string;
}

const UNIT_TO_METRES: Record<StlLengthUnit, number> = {
  m: 1,
  mm: 1e-3,
  um: 1e-6,
  nm: 1e-9,
};

export function stlScaleToSi(scale: number, units: StlLengthUnit): number | null {
  const effective = scale * UNIT_TO_METRES[units];
  return Number.isFinite(effective) && effective > 0 ? effective : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function validateStlImport(
  fileName: string,
  fileSize: number,
  units: unknown,
  scale: unknown,
): string | null {
  if (!fileName.toLowerCase().endsWith(".stl")) {
    return "Choose an STL file ending in .stl.";
  }
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    return "The STL file is empty or its size is invalid.";
  }
  if (fileSize > STL_IMPORT_MAX_BYTES) {
    return "STL files must be smaller than 96 MiB for the upload transport.";
  }
  if (!STL_LENGTH_UNITS.includes(units as StlLengthUnit)) {
    return "Choose the length unit used by the STL coordinates.";
  }
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) {
    return "Scale must be a finite number greater than zero.";
  }
  if (stlScaleToSi(scale, units as StlLengthUnit) === null) {
    return "The selected unit and scale must produce a finite, positive value in metres.";
  }
  return null;
}

export async function importStlSourceGeometry(
  api: ImportedStlSourceApi,
  file: StlFileInput,
  units: StlLengthUnit,
  scale: number,
  options?: RequestOptions,
): Promise<ImportedStlGeometry> {
  const invalid = validateStlImport(file.name, file.size, units, scale);
  if (invalid) throw new Error(invalid);

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size || bytes.byteLength === 0) {
    throw new Error("The selected STL file could not be read completely.");
  }

  const request: ImportSessionAssetRequest = {
    content_base64: bytesToBase64(bytes),
    file_name: file.name,
    target_realization: "geometry",
  };
  const response = record(await api.persistence.assets.import(request, options));
  const assetId = nonempty(response?.asset_id);
  const storedPath = nonempty(response?.stored_path);
  const digest = nonempty(response?.content_sha256)?.toLowerCase() ?? null;
  if (!assetId || !storedPath || !digest || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("The asset service did not return a content-addressed STL source.");
  }

  const displayName = file.name.replace(/\.stl$/i, "").trim() || "Imported STL";
  return {
    geometry: {
      geometry_kind: "ImportedGeometry",
      geometry_params: {
        format: "stl",
        scale: stlScaleToSi(scale, units)!,
        source: storedPath,
      },
      source_asset: {
        archive_path: "project/assets/" + digest + ".stl",
        asset_id: assetId,
        content_sha256: digest,
      },
    },
    name: displayName,
  };
}
