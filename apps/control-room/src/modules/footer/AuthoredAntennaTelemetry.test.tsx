import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { AuthoredAntennaTelemetry, readAuthoredAntennaStages } from "./AuthoredAntennaTelemetry";

const stage = { kind: "antenna_field_solve", stage_id: "inspect_gsg" };
function scene(nodes: unknown[]): SceneResource {
  return { revision: 1, study: {
    stages: [stage], study_pipeline: { version: "study_pipeline.v1", nodes },
  } } as SceneResource;
}
const node = { id: "queue-1", node_kind: "primitive", stage_kind: "antenna_field_solve", payload: stage };
function markup(data: SceneResource | null, hasRun: boolean | null = false, sceneStatus = "ready") {
  return renderToStaticMarkup(<AuthoredAntennaTelemetry scene={data} sceneStatus={sceneStatus} hasRun={hasRun} />);
}

describe("authored antenna telemetry", () => {
  it("uses the authoritative pipeline rather than a dormant flat list", () => {
    expect(readAuthoredAntennaStages(scene([])).stages).toEqual([]);
    expect(markup(scene([]))).toContain("No antenna stage scheduled");
    expect(markup({ revision: 1, objects: [{ id: "antenna", role: "antenna" }] })).toContain("No antenna stage scheduled");
  });
  it("keeps queue identity separate from definition identity", () => {
    const result = readAuthoredAntennaStages(scene([node]));
    expect(result.stages[0]).toMatchObject({ id: "inspect_gsg", queueId: "queue-1", enabled: true });
  });
  it("honors disabled parent groups", () => {
    const data = scene([{ id: "group", node_kind: "group", enabled: false, children: [node] }]);
    expect(markup(data)).toContain("Antenna stages disabled");
    expect(markup(data)).not.toContain("not started");
  });
  it("reports invalid pipelines rather than resurrecting flat stages", () => {
    expect(markup(scene([node, node]))).toContain("Antenna study needs attention");
    expect(readAuthoredAntennaStages(scene([node, node])).stages).toEqual([]);
  });
  it("does not invent execution progress for an existing run", () => {
    const html = markup(scene([node]), true);
    expect(html).toContain("Antenna execution progress unavailable");
    expect(html).not.toContain("not started");
    expect(html).not.toContain("progressbar");
  });
  it("does not infer a missing run from an unavailable status resource", () => {
    const html = markup(scene([node]), null);
    expect(html).toContain("Antenna execution state unavailable");
    expect(html).not.toContain("not started");
  });
  it("distinguishes unloaded and failed scene resources", () => {
    expect(markup(null, false, "loading")).toContain("Loading antenna study");
    expect(markup(null, false, "error")).toContain("Antenna study could not be loaded");
  });
  it("supports the flat executable study without inferring physics from objects", () => {
    expect(readAuthoredAntennaStages({ revision: 1, study: { stages: [stage] } }).stages).toHaveLength(1);
  });
});
