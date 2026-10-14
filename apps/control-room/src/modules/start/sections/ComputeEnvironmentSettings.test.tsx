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
    expect(html).toContain(new Date(sampledAt).toLocaleString());
    expect(html).toContain(`dateTime="${new Date(sampledAt).toISOString()}"`);
  });

  it("keeps resource inventory separate from telemetry and does not imply policy editing", () => {
    const html = renderToStaticMarkup(
      <ComputeEnvironmentSettings compute={undefined} view="resources" />,
    );

    expect(html).toContain("Compute resources");
    expect(html).toContain("No host inventory snapshot is available.");
    expect(html).toContain("it does not change host resource policy");
    expect(html).not.toContain("Not probed");
  });
});
