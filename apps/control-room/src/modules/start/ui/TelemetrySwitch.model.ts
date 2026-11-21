import { TELEMETRY_UNAVAILABLE_TEXT, telemetryStatusText, type PreferencesState } from "../model/startPreferences";

/** The text beside the switch, from the stored choice only. */
export function telemetryLabel(state: PreferencesState): string {
  if (state.kind === "ready") return telemetryStatusText(state.telemetryEnabled);
  if (state.kind === "unavailable") return `${TELEMETRY_UNAVAILABLE_TEXT} — ${state.reason}`;
  return "Reading the telemetry setting…";
}
