import type { SceneResource } from "@/kernel/api/apiTypes";

type SourceRecord = Record<string, unknown>;
const record = (value: unknown): SourceRecord | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as SourceRecord : null;

/** Resolve explicit source bindings; object names and presentation roles never activate physics. */
export function antennaRegionalSources(scene: SceneResource | null, objectId: string | null): { canonical: SourceRecord | null; legacy: SourceRecord | null } {
  if (!scene || !objectId) return { canonical: null, legacy: null };
  const drives = record(scene.field_drives)?.drives;
  const modules = record(scene.current_modules)?.modules;
  const canonical = Array.isArray(drives) ? drives.map(record).find(drive => {
    const profile = record(drive?.spatial_profile);
    return drive?.kind === "regional" && profile?.kind === "geometry_mask" && profile.object_id === objectId;
  }) ?? null : null;
  const legacy = Array.isArray(modules) ? modules.map(record).find(module => module?.kind === "antenna_field_source"
    && module.model === "prescribed_zeeman_mask" && module.object === objectId) ?? null : null;
  return { canonical, legacy };
}
