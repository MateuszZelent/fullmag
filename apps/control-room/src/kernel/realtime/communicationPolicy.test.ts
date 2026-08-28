import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  fieldVectorMinRefetchIntervalMs,
  realtimeCommunicationPolicy,
  scalarTelemetryIntervalMs,
  tableRowsMinRefetchIntervalMs,
  updateRealtimeCommunicationPolicy,
} from "./communicationPolicy";

describe("realtimeCommunicationPolicy", () => {
  it("labels producer delivery and diagnostics refresh cadence precisely", () => {
    const dialogSource = readFileSync(
      new URL("../layout/CommunicationPolicyDialog.tsx", import.meta.url),
      "utf8",
    );

    expect(dialogSource).toContain('label: "Scalar delivery ms"');
    expect(dialogSource).toContain('label: "Diagnostics refresh ms"');
    expect(dialogSource).not.toContain('label: "Scalar sample ms"');
    expect(dialogSource).not.toContain('label: "Diagnostics ms"');
  });

  it("applies table row HTTP refetch cadence from realtime policy", () => {
    updateRealtimeCommunicationPolicy({
      field_samples_enabled: false,
      scalar_sample_enabled: true,
      table_rows_min_refetch_ms: 1000,
      field_sample_publish_ms: 2000,
      scalar_telemetry_publish_ms: 200,
    });

    expect(tableRowsMinRefetchIntervalMs()).toBe(1000);
    expect(fieldVectorMinRefetchIntervalMs()).toBe(2000);
    expect(scalarTelemetryIntervalMs()).toBe(200);
    expect(realtimeCommunicationPolicy()).toMatchObject({
      fieldSamplesEnabled: false,
      fieldSamplePublishMs: 2000,
      scalarSampleEnabled: true,
      scalarTelemetryPublishMs: 200,
      tableRowsMinRefetchMs: 1000,
    });
  });
});
