import type { ExecutionProfile } from "@/kernel/api/apiTypes";

export interface ExecutionProfileDraft {
  profile: ExecutionProfile;
  threads: string;
}

export function newProfileDraft(source?: ExecutionProfile): ExecutionProfileDraft {
  const profile: ExecutionProfile = source
    ? { ...structuredClone(source), version: "" }
    : { schema_version: "execution_profile.v1", profile_id: "", version: "1", description: "", defaults: {} };
  return { profile, threads: String(profile.defaults.resources?.cpu?.threads ?? "") };
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
  if (Object.keys(resources).length) profile.defaults.resources = resources;
  else delete profile.defaults.resources;
  return profile;
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
