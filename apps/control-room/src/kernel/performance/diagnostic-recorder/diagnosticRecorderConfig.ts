import type { BrowserFullmagConfig } from "@/kernel/browserFullmagConfig";

import type { DiagnosticRecorderProfile } from "./diagnosticRecorderTypes";

export interface DiagnosticRecorderConfig {
  enabled: boolean;
  maxBytes: number;
  maxRecords: number;
  profile: DiagnosticRecorderProfile;
  scenario: string;
}

export const DEFAULT_DIAGNOSTIC_RECORDER_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_DIAGNOSTIC_RECORDER_MAX_RECORDS = 2_000;
export const DEFAULT_DIAGNOSTIC_RECORDER_PROFILE: DiagnosticRecorderProfile =
  "boot";
export const DEFAULT_DIAGNOSTIC_RECORDER_SCENARIO = "boot";

export function resolveDiagnosticRecorderConfig(
  config: BrowserFullmagConfig | undefined,
): DiagnosticRecorderConfig {
  return {
    enabled: config?.enableDiagnosticRecorder === true,
    maxBytes: normalizePositiveInteger(
      config?.diagnosticRecorderMaxBytes,
      DEFAULT_DIAGNOSTIC_RECORDER_MAX_BYTES,
    ),
    maxRecords: normalizePositiveInteger(
      config?.diagnosticRecorderMaxRecords,
      DEFAULT_DIAGNOSTIC_RECORDER_MAX_RECORDS,
    ),
    profile: normalizeProfile(config?.diagnosticRecorderProfile),
    scenario: normalizeScenario(config?.diagnosticRecorderScenario),
  };
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function normalizeProfile(value: unknown): DiagnosticRecorderProfile {
  if (
    value === "boot" ||
    value === "session" ||
    value === "viewport-3d" ||
    value === "memory-leak" ||
    value === "forensic"
  ) {
    return value;
  }

  return DEFAULT_DIAGNOSTIC_RECORDER_PROFILE;
}

function normalizeScenario(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 80)
    : DEFAULT_DIAGNOSTIC_RECORDER_SCENARIO;
}
