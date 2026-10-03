import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";

export interface BuildInfo {
  readonly version: string;
  readonly os: string;
  readonly arch: string;
  readonly profile: "debug" | "release";
  readonly projectSchema: string;
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** A build record is only as good as its version; anything else reads as absent. */
export function parseBuildInfo(raw: unknown): BuildInfo | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const version = str(record.version);
  if (!version) return null;
  return {
    version,
    os: str(record.os) ?? "unknown",
    arch: str(record.arch) ?? "unknown",
    profile: record.profile === "debug" ? "debug" : "release",
    projectSchema: str(record.project_schema) ?? "unknown",
  };
}

/** The desktop host's build; `null` in the browser or on a host without the command. */
export async function readBuildInfo(): Promise<BuildInfo | null> {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  try {
    return parseBuildInfo(await invoke<unknown>("app_build_info"));
  } catch {
    return null;
  }
}

export function describeBuild(build: BuildInfo | null): string {
  if (!build) return "not exposed to the renderer";
  return `${build.version} (${build.profile}), ${build.os}/${build.arch}, project schema ${build.projectSchema}`;
}
