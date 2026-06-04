import { describe, expect, it } from "vitest";

import {
  fieldVectorMinRefetchIntervalMs,
  realtimeCommunicationPolicy,
  scalarTelemetryIntervalMs,
  tableRowsMinRefetchIntervalMs,
  updateRealtimeCommunicationPolicy,
} from "./communicationPolicy";

describe("realtimeCommunicationPolicy", () => {
  it("applies table row HTTP refetch cadence from realtime policy", () => {
    updateRealtimeCommunicationPolicy({
      table_rows_min_refetch_ms: 1000,
      field_sample_publish_ms: 2000,
      scalar_telemetry_publish_ms: 200,
    });

    expect(tableRowsMinRefetchIntervalMs()).toBe(1000);
    expect(fieldVectorMinRefetchIntervalMs()).toBe(2000);
    expect(scalarTelemetryIntervalMs()).toBe(200);
    expect(realtimeCommunicationPolicy()).toMatchObject({
      fieldSamplePublishMs: 2000,
      scalarTelemetryPublishMs: 200,
      tableRowsMinRefetchMs: 1000,
    });
  });
});
