import type { ExecutionProfile } from "@/kernel/api/apiTypes";

export interface ExecutionProfileDraft {
  profile: ExecutionProfile;
  threads: string;
  ramGiB: string;
  scratchGiB: string;
  vramGiB: string;
}

const BYTES_PER_GIB = 1024 ** 3;

export function newProfileDraft(source?: ExecutionProfile): ExecutionProfileDraft {
  const profile: ExecutionProfile = source
    ? { ...structuredClone(source), version: "" }
    : { schema_version: "execution_profile.v1", profile_id: "", version: "1", description: "", defaults: {} };
  const resources = profile.defaults.resources;
  return {
    profile,
    threads: String(resources?.cpu?.threads ?? ""),
    ramGiB: gibFromBytes(resources?.ram?.reservation_bytes),
    scratchGiB: gibFromBytes(resources?.scratch?.reservation_bytes),
    vramGiB: gibFromBytes(resources?.gpu?.vram_per_device_bytes),
  };
}

export function duplicateProfileDraft(
  source: ExecutionProfile,
  profileId: string,
): ExecutionProfileDraft {
  const draft = newProfileDraft(source);
  return {
    ...draft,
    profile: {
      ...draft.profile,
      profile_id: profileId,
      version: "1",
    },
  };
}

/** Preserve advanced sparse fields when editing the basic profile controls. */
export function profileFromDraft(draft: ExecutionProfileDraft): ExecutionProfile {
  const profile = structuredClone(draft.profile);
  const threads = draft.threads.trim();
  if (threads && threads !== "auto" && (!/^[1-9]\d*$/.test(threads) || Number(threads) > 4294967295)) {
    throw new Error("CPU threads must be Auto or a positive whole number. Leave blank to inherit.");
  }
  if (!profile.profile_id || !profile.version || /[\s\p{Cc}]/u.test(profile.profile_id + profile.version)) {
    throw new Error("Enter a profile ID and version without spaces or control characters.");
  }
  if (profile.version.toLowerCase() === "latest") throw new Error("Choose a fixed version; Latest is not a version.");
  const resources = { ...profile.defaults.resources };
  const cpu = { ...resources.cpu };
  delete cpu.threads;
  if (threads) cpu.threads = threads === "auto" ? "auto" : Number(threads);
  if (Object.keys(cpu).length) resources.cpu = cpu;
  else delete resources.cpu;

  const originalRam = gibFromBytes(profile.defaults.resources?.ram?.reservation_bytes);
  if (draft.ramGiB.trim() !== originalRam) {
    const reservationBytes = bytesFromGiB(draft.ramGiB, "RAM per task");
    const ram = resources.ram && typeof resources.ram === "object" ? { ...resources.ram } : {};
    if (reservationBytes === undefined) delete ram.reservation_bytes;
    else ram.reservation_bytes = reservationBytes;
    if (Object.keys(ram).length) resources.ram = ram;
    else delete resources.ram;
  }

  const originalScratch = gibFromBytes(profile.defaults.resources?.scratch?.reservation_bytes);
  if (draft.scratchGiB.trim() !== originalScratch) {
    const reservationBytes = bytesFromGiB(draft.scratchGiB, "Scratch per task");
    const scratch = resources.scratch && typeof resources.scratch === "object" ? { ...resources.scratch } : {};
    if (reservationBytes === undefined) delete scratch.reservation_bytes;
    else scratch.reservation_bytes = reservationBytes;
    if (Object.keys(scratch).length) resources.scratch = scratch;
    else delete resources.scratch;
  }

  const originalVram = gibFromBytes(profile.defaults.resources?.gpu?.vram_per_device_bytes);
  if (draft.vramGiB.trim() !== originalVram) {
    const reservationBytes = bytesFromGiB(draft.vramGiB, "GPU VRAM per device");
    const gpu = resources.gpu && typeof resources.gpu === "object"
      ? { ...resources.gpu }
      : { selector: "any_compatible" as const, device_uuids: [], devices_per_task: 1 };
    if (reservationBytes === undefined) delete gpu.vram_per_device_bytes;
    else gpu.vram_per_device_bytes = reservationBytes;
    if (Object.keys(gpu).length) resources.gpu = gpu;
    else delete resources.gpu;
  }

  if (Object.keys(resources).length) profile.defaults.resources = resources;
  else delete profile.defaults.resources;
  return profile;
}

function gibFromBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) return "";
  return String(bytes / BYTES_PER_GIB);
}

function bytesFromGiB(input: string, label: string): number | undefined {
  const value = input.trim();
  if (!value) return undefined;
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) {
    throw new Error(`${label} must be a positive GiB value without units or exponent notation.`);
  }
  const gib = Number(value);
  const bytes = Math.round(gib * BYTES_PER_GIB);
  if (!Number.isFinite(gib) || gib <= 0 || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`${label} must be a positive amount that fits in whole bytes.`);
  }
  return bytes;
}

/** Object key order is irrelevant; null reset values and array order are preserved. */
export function sameProfile(left: ExecutionProfile, right: ExecutionProfile): boolean {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]));
    }
    return value;
  };
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}
