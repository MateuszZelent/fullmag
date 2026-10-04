import type { OutputStorageDefaultsRequest, OutputStorageSettings } from "../api/apiTypes";

export function simulationTimestamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}_${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

export function suggestedProjectFolder(name: string, timestamp: string): string {
  const slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72).toLowerCase();
  return `${slug || "simulation"}_${timestamp}`;
}

export function joinStoragePath(parent: string, child: string): string {
  const separator = parent.includes("\\") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${child}`;
}

export function validateStorageParent(path: string): string | null {
  if (!path.trim()) return "Choose a directory for this simulation.";
  if (path.includes("\0") || /[\r\n]/.test(path)) return "The directory contains an invalid character.";
  if (!/^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(path)) {
    return "Enter an absolute directory on the computer running Fullmag.";
  }
  if (path.split(/[\\/]/).includes("..")) return "The directory cannot contain '..'.";
  return null;
}

export function validateProjectFolder(folder: string): string | null {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(folder) || /[. ]$/.test(folder)) {
    return "Use up to 120 letters, numbers, dots, dashes or underscores for the folder.";
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(folder)) {
    return "This folder name is reserved by the operating system.";
  }
  return null;
}

export function newSimulationStorage(
  defaults: OutputStorageDefaultsRequest,
  folder: string,
): OutputStorageSettings {
  return {
    output_dir: joinStoragePath(joinStoragePath(defaults.output_parent.trim(), folder),
      defaults.data_format === "zarr" ? "results.zarr" : "results"),
    temp_dir: defaults.temp_parent?.trim() || joinStoragePath(defaults.output_parent.trim(), ".fullmag-tmp"),
    data_format: defaults.data_format ?? "zarr",
    cleanup: defaults.cleanup ?? "on_success",
    existing_output: defaults.existing_output ?? "timestamp",
  };
}

export function validateStorageSeparation(output: string, temporary: string): string | null {
  const normalized = (path: string) => {
    const value = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
    return /^(?:[a-zA-Z]:|[\\/]{2})/.test(path) ? value.toLowerCase() : value;
  };
  const result = normalized(output);
  const temp = normalized(temporary);
  return result === temp || result.startsWith(`${temp}/`) || temp.startsWith(`${result}/`)
    ? "Choose a temporary directory separate from the results directory."
    : null;
}
