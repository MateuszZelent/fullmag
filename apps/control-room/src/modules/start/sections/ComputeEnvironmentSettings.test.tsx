import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComputeEnvironmentSettings } from "./ComputeEnvironmentSettings";

describe("ComputeEnvironmentSettings probe state", () => {
  it("distinguishes an unprobed host from an active probe and defers device resolution", () => {
    const idle = renderToStaticMarkup(<ComputeEnvironmentSettings compute={undefined} />);
    const active = renderToStaticMarkup(
      <ComputeEnvironmentSettings compute={undefined} refreshing />,
    );

    expect(idle).toContain("Not probed");
    expect(idle).toContain("The desktop host supplies the probe.");
    expect(idle).toContain("A concrete device is resolved when a run starts.");
    expect(active).toContain("Reading compute environment");
    expect(active).toContain("Not probed");
  });

  it("shows the timestamp of the latest available telemetry sample", () => {
    const sampledAt = Date.UTC(2026, 9, 13, 12, 34, 0);
    const html = renderToStaticMarkup(
      <ComputeEnvironmentSettings compute={{ gpus: [], cpuThreads: 8, preferredBackend: "cpu", warnings: [], sampledAt }} />,
    );

    expect(html).toContain("Latest available telemetry sample");
    expect(html).toContain(new Date(sampledAt).toLocaleString("en-US"));
    expect(html).toContain(`dateTime="${new Date(sampledAt).toISOString()}"`);
  });

  it("keeps resource inventory separate from telemetry and explains the policy boundary", () => {
    const html = renderToStaticMarkup(
      <ComputeEnvironmentSettings compute={undefined} view="resources" />,
    );

    expect(html).toContain("Compute resources");
    expect(html).toContain("No host inventory snapshot is available.");
    expect(html).toContain("Hardware readings and solver availability remain separate from host admission policy.");
    expect(html).not.toContain("Not probed");
  });

  it("shows experimental runtime qualification and its unavailable reason separately", () => {
    const html = renderToStaticMarkup(
      <ComputeEnvironmentSettings
        compute={{
          gpus: [],
          cpuThreads: 8,
          preferredBackend: "cpu",
          warnings: [],
          runtimeLanes: [
            {
              backend: "FEM",
              device: "CPU",
              availability: "unknown",
              precisions: [],
              diagnostic: {
                kind: "experimental",
                state: "unavailable",
                reason: "Native FEM CPU runtime is unavailable",
              },
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Experimental unavailable");
    expect(html).toContain("Native FEM CPU runtime is unavailable");
    expect(html).toContain('data-state="unknown"');
    expect(html).toContain('data-diagnostic-state="unavailable"');
  });
});
