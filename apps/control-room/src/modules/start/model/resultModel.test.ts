import { describe, expect, it } from "vitest";

import { apiItem } from "./__fixtures__/workspaceApi";
import { resultChip, resultSourceName, stageLabel } from "./resultModel";

const item = (status: "ready" | "missing" | "failed" | "migrate" | "readonly" = "ready", meta = {}) =>
  apiItem({ id: "r", kind: "result", status, meta });

describe("resultChip", () => {
  it("lets the folder's own state win", () => {
    expect(resultChip(item("missing"), "completed")).toMatchObject({ status: "missing" });
    expect(resultChip(item("failed"))).toMatchObject({ status: "failed" });
  });

  it.each([
    ["completed", "ready", "Complete"],
    ["ok", "ready", "Complete"],
    ["running", "running", "Running"],
    ["failed", "failed", "Failed"],
    ["partial", "draft", "Incomplete"],
    ["cancelled", "draft", "Incomplete"],
    ["frozen", "draft", "frozen"],
  ])("maps the recorded status %s", (recorded, status, label) => {
    expect(resultChip(item("ready", { status: recorded }))).toMatchObject({ status, label });
  });

  it("prefers a status passed from the detail over the list's meta", () => {
    expect(resultChip(item("ready", { status: "running" }), "completed")).toMatchObject({ label: "Complete" });
  });

  it("shows no chip, rather than a guess, when none was recorded", () => {
    expect(resultChip(item())).toBeNull();
  });
});

describe("result labels", () => {
  it("writes a stage's kind in words", () => {
    expect(stageLabel({ id: "relax" })).toBe("relax");
    expect(stageLabel({ id: "relax", kind: "relaxation" })).toBe("relax (relaxation)");
  });

  it("reads the source name from either meta key", () => {
    expect(resultSourceName(item("ready", { source_name: "sp4" }))).toBe("sp4");
    expect(resultSourceName(item("ready", { source: "sp5" }))).toBe("sp5");
    expect(resultSourceName(item())).toBeUndefined();
  });
});
