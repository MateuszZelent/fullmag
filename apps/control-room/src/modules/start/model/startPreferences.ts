/**
 * Per-user preferences the status strip shows, read from the workspace
 * database through `GET|PUT /v2/workspace/settings/{key}`.
 *
 * Honesty rules: this build has no telemetry sender and no update channel.
 * `telemetry.enabled` records a choice only, and its text never says data is
 * sent. `update.available` is written by a future updater; until it exists the
 * notice is absent. Nothing here reaches beyond the local backend.
 */

export const TELEMETRY_SETTING_KEY = "telemetry.enabled";
export const UPDATE_SETTING_KEY = "update.available";

export const TELEMETRY_OFF_TEXT = "Telemetry off — this build sends no data";
export const TELEMETRY_ON_TEXT = "Telemetry on — no collector is configured in this build";
export const TELEMETRY_UNAVAILABLE_TEXT = "Telemetry setting unavailable";

export const TELEMETRY_EXPLANATION =
  "Telemetry is a stored preference only. This build has no telemetry sender and no collector, so no usage data leaves this machine whichever way the switch is set. The choice is saved per user in the workspace database so a future build that adds a collector asks nothing new of you. It is off by default.";

export interface SettingAnswer {
  readonly key: string;
  readonly value: unknown;
  readonly isDefault: boolean;
  readonly writable: boolean;
}

export function parseSettingAnswer(raw: unknown): SettingAnswer | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.key !== "string") return undefined;
  return {
    key: record.key,
    value: record.value,
    isDefault: record.is_default === true,
    writable: record.writable === true,
  };
}

/** The stored choice; anything but a boolean reads as the default, off. */
export function telemetryEnabledOf(answer: SettingAnswer | undefined): boolean {
  return answer?.value === true;
}

export function telemetryStatusText(enabled: boolean): string {
  return enabled ? TELEMETRY_ON_TEXT : TELEMETRY_OFF_TEXT;
}

export interface UpdateNotice {
  readonly version?: string;
}

/** The notice an updater stored, or `undefined` (hidden) when nothing is stored. */
export function updateNoticeOf(answer: SettingAnswer | undefined): UpdateNotice | undefined {
  const value = answer?.value;
  if (value === null || value === undefined || value === false) return undefined;
  if (typeof value === "string") return value === "" ? {} : { version: value };
  if (typeof value === "object" && !Array.isArray(value)) {
    const version = (value as Record<string, unknown>).version;
    return typeof version === "string" && version !== "" ? { version } : {};
  }
  return undefined;
}

export function updateNoticeText(notice: UpdateNotice): string {
  return notice.version ? `Update available: ${notice.version}` : "Update available";
}

export type PreferencesState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly telemetryEnabled: boolean;
      readonly update: UpdateNotice | undefined;
    }
  | { readonly kind: "unavailable"; readonly reason: string };
