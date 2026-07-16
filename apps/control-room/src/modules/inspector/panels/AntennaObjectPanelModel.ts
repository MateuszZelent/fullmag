import type { SceneResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";

export interface AntennaObjectPanelModel {
  amplitude: string;
  direction: string;
  mode: "canonical" | "legacy" | "missing";
  objectId: string;
  source: string;
  spatialProfile: string;
  waveform: string;
}

export interface AntennaObjectDraft {
  amplitudeB: string;
  direction: string;
  waveformKind: "constant" | "sinc_pulse" | "sinusoidal";
  sincCutoffHz: string;
  sincT0: string;
  sinusoidalFrequencyHz: string;
}

export interface AntennaObjectDraftPatchResult {
  error: string | null;
  modules: JsonRecord[] | null;
}

export interface AntennaFieldDrivePatchResult {
  drive: JsonRecord | null;
  error: string | null;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberVector(value: unknown): number[] | null {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? value
    : null;
}

function formatVector(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 3) return "unavailable";
  const parts = value.map((entry) =>
    typeof entry === "number" && Number.isFinite(entry)
      ? entry.toExponential(3)
      : String(entry),
  );
  return `(${parts.join(", ")})`;
}

function formatTesla(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toExponential(3)} T`
    : "unavailable";
}

function formatWaveform(value: unknown): string {
  const waveform = asRecord(value);
  if (!waveform) return "constant";
  const kind = asString(waveform.kind) ?? "waveform";
  if (kind === "sinc_pulse") {
    const cutoff = waveform.cutoff_hz;
    const t0 = waveform.t0;
    return `sinc pulse, cutoff ${formatFrequency(cutoff)}, t0 ${formatNumber(t0, "s")}`;
  }
  if (kind === "sinusoidal") {
    return `sin, ${formatFrequency(waveform.frequency_hz)}`;
  }
  return kind;
}

function formatSpatialProfile(value: unknown): string {
  const profile = asRecord(value);
  if (!profile) return "uniform";
  const kind = asString(profile.kind) ?? "uniform";
  if (kind === "sinc") {
    return `sinc, period ${formatNumber(profile.period_m, "m")}`;
  }
  return kind;
}

function formatNumber(value: unknown, unit: string): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toExponential(3)} ${unit}`
    : `unavailable ${unit}`;
}

function formatFrequency(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? formatFrequencyHz(value)
    : "unavailable Hz";
}

function antennaModules(scene: SceneResource | null): JsonRecord[] {
  const sceneRecord = asRecord(scene);
  const currentModules = asRecord(sceneRecord?.current_modules);
  const modules = currentModules?.modules;
  if (!Array.isArray(modules)) return [];
  return modules.flatMap((module) => {
    const entry = asRecord(module);
    return entry ? [entry] : [];
  });
}

function fieldDrives(scene: SceneResource | null): JsonRecord[] {
  const drives = asRecord(asRecord(scene)?.field_drives)?.drives;
  return Array.isArray(drives) ? drives.flatMap((drive) => asRecord(drive) ? [asRecord(drive)!] : []) : [];
}

function legacySourceForObject(
  scene: SceneResource | null,
  objectId: string | null,
): JsonRecord | null {
  if (!objectId) return null;
  return (
    antennaModules(scene).find(
      (module) =>
        asString(module.kind) === "antenna_field_source" &&
        asString(module.model) === "prescribed_zeeman_mask" &&
        asString(module.object) === objectId,
    ) ?? null
  );
}

function canonicalSourceForObject(scene: SceneResource | null, objectId: string | null): JsonRecord | null {
  if (!objectId) return null;
  return fieldDrives(scene).find((drive) => {
    const profile = asRecord(drive.spatial_profile);
    return asString(drive.kind) === "regional" && asString(profile?.kind) === "geometry_mask" && asString(profile?.object_id) === objectId;
  }) ?? null;
}

function sourceForObject(scene: SceneResource | null, objectId: string | null): { kind: "canonical" | "legacy"; source: JsonRecord } | null {
  const canonical = canonicalSourceForObject(scene, objectId);
  if (canonical) return { kind: "canonical", source: canonical };
  const legacy = legacySourceForObject(scene, objectId);
  return legacy ? { kind: "legacy", source: legacy } : null;
}

function sourceField(source: JsonRecord | null): {
  amplitudeB: unknown;
  direction: unknown;
} {
  const field = asRecord(source?.field);
  return {
    amplitudeB: source?.amplitude_B_T ?? source?.B ?? field?.amplitude_B_T,
    direction: source?.direction ?? field?.direction,
  };
}

function compactNumber(value: unknown, fallback: string): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : fallback;
}

export function resolveAntennaObjectDraft(
  selection: Selection,
  scene: SceneResource | null,
): AntennaObjectDraft {
  const objectId =
    selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId;
  const resolved = sourceForObject(scene, objectId);
  const source = resolved?.source ?? null;
  const field = sourceField(source);
  const waveform = asRecord(source?.waveform);
  const waveformKind = asString(waveform?.kind);
  return {
    amplitudeB: compactNumber(field.amplitudeB, "0.001"),
    direction: numberVector(field.direction)?.join(", ") ?? "0, 1, 0",
    waveformKind:
      waveformKind === "sinc_pulse" || waveformKind === "sinusoidal"
        ? waveformKind
        : "constant",
    sincCutoffHz: compactNumber(waveform?.cutoff_hz, "20000000000"),
    sincT0: compactNumber(waveform?.t0, "5e-11"),
    sinusoidalFrequencyHz: compactNumber(waveform?.frequency_hz, "10000000000"),
  };
}

export function buildAntennaCanonicalFieldDrive(
  selection: Selection,
  scene: SceneResource | null,
  draft: AntennaObjectDraft,
): AntennaFieldDrivePatchResult {
  const objectId = selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId;
  const existing = canonicalSourceForObject(scene, objectId);
  if (!existing) return { drive: null, error: "Canonical field drive is not assigned to this antenna." };
  const amplitude = parsePositive(draft.amplitudeB, "Amplitude B"); if (amplitude.error) return {drive:null,error:amplitude.error};
  const direction = parseDirection(draft.direction); if (direction.error) return {drive:null,error:direction.error};
  const waveform = draftWaveform(draft); if (waveform.error) return {drive:null,error:waveform.error};
  return { error: null, drive: {...existing, amplitude_B_T: amplitude.value, direction: direction.value, waveform: waveform.value} };
}

export function buildAntennaLegacyMigrationPatch(
  selection: Selection,
  scene: SceneResource | null,
  draft: AntennaObjectDraft,
): { drives: JsonRecord[] | null; error: string | null; modules: JsonRecord[] | null } {
  const objectId = selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId;
  const legacy = legacySourceForObject(scene, objectId);
  if (!legacy || !objectId) return {drives:null,error:"Legacy antenna source is not assigned.",modules:null};
  const amplitude=parsePositive(draft.amplitudeB,"Amplitude B"); if(amplitude.error)return{drives:null,error:amplitude.error,modules:null};
  const direction=parseDirection(draft.direction); if(direction.error)return{drives:null,error:direction.error,modules:null};
  const waveform=draftWaveform(draft); if(waveform.error)return{drives:null,error:waveform.error,modules:null};
  const id=asString(legacy.id) ?? `${objectId}:H_ant`;
  return {
    error:null,
    drives:[...fieldDrives(scene), {id,name:asString(legacy.name) ?? id,kind:"regional",enabled:true,target:{kind:"global"},amplitude_B_T:amplitude.value,direction:direction.value,spatial_profile:{kind:"geometry_mask",object_id:objectId,envelope:asRecord(legacy.spatial_profile) ?? {kind:"uniform"}},waveform:waveform.value,time_origin:"stage_local",activation:{kind:"all_time_evolution"},migration:{migrated_from:"prescribed_zeeman_mask"}}],
    modules:antennaModules(scene).filter((module)=>module!==legacy),
  };
}

function draftWaveform(draft: AntennaObjectDraft): { error: string | null; value: JsonRecord } {
  if (draft.waveformKind === "sinc_pulse") { const cutoff=parsePositive(draft.sincCutoffHz,"Sinc cutoff"); if(cutoff.error)return{error:cutoff.error,value:{}}; const t0=parseFinite(draft.sincT0,"Sinc t0"); if(t0.error)return{error:t0.error,value:{}}; return{error:null,value:{kind:"sinc_pulse",cutoff_hz:cutoff.value,t0:t0.value,amplitude:1}}; }
  if (draft.waveformKind === "sinusoidal") { const frequency=parsePositive(draft.sinusoidalFrequencyHz,"Sinusoidal frequency"); return frequency.error ? {error:frequency.error,value:{}} : {error:null,value:{kind:"sinusoidal",frequency_hz:frequency.value,phase_rad:0,offset:0}}; }
  return {error:null,value:{kind:"constant"}};
}

function parseFinite(value: string, label: string): { error: string | null; value: number } {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { error: `${label} must be finite.`, value: 0 };
  }
  return { error: null, value: parsed };
}

function parsePositive(value: string, label: string): { error: string | null; value: number } {
  const parsed = parseFinite(value, label);
  if (parsed.error) return parsed;
  if (parsed.value <= 0) {
    return { error: `${label} must be greater than 0.`, value: parsed.value };
  }
  return parsed;
}

function parseDirection(value: string): { error: string | null; value: [number, number, number] } {
  const parts = value.split(/[,\s]+/).flatMap((part) => {
    const trimmed = part.trim();
    return trimmed ? [trimmed] : [];
  });
  if (parts.length !== 3) {
    return { error: "Direction must contain three components.", value: [0, 0, 0] };
  }
  const vector = parts.map(Number);
  if (vector.some((part) => !Number.isFinite(part))) {
    return { error: "Direction components must be finite.", value: [0, 0, 0] };
  }
  if (vector.every((part) => Math.abs(part) <= 1e-30)) {
    return { error: "Direction must be non-zero.", value: [0, 0, 0] };
  }
  return { error: null, value: vector as [number, number, number] };
}

export function resolveAntennaObjectPanelModel(
  selection: Selection,
  scene: SceneResource | null,
): AntennaObjectPanelModel {
  const objectId =
    selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId;
  const resolved = sourceForObject(scene, objectId);
  const source = resolved?.source ?? null;
  const field = sourceField(source);

  if (!objectId || !source) {
    return {
      amplitude: "unavailable",
      direction: "unavailable",
      mode: "missing",
      objectId: objectId ?? "none",
      source: "unassigned",
      spatialProfile: "unavailable",
      waveform: "unavailable",
    };
  }

  return {
    amplitude: formatTesla(field.amplitudeB),
    direction: formatVector(field.direction),
    mode: resolved?.kind ?? "missing",
    objectId,
    source: asString(source.name) ?? "antenna",
    spatialProfile: formatSpatialProfile(source.spatial_profile),
    waveform: formatWaveform(source.waveform),
  };
}
