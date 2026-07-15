import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { VISUALIZATION_CLIENT_ACKS_PATH } from "../api/apiPaths";
import type { VisualizationClientAckResource } from "../api/apiTypes";
import {
  resolveVisualizationClientAcksRevision,
  VISUALIZATION_CLIENT_ACKS_RESOURCE_KEY,
} from "./useVisualizationClientAcksResource";

const source = readFileSync(
  join(
    process.cwd(),
    "src/kernel/visualization/useVisualizationClientAcksResource.ts",
  ),
  "utf8",
);

describe("useVisualizationClientAcksResource", () => {
  it("uses the existing typed visualization facade and canonical API path", () => {
    expect(VISUALIZATION_CLIENT_ACKS_RESOURCE_KEY).toBe(
      VISUALIZATION_CLIENT_ACKS_PATH,
    );
    expect(source).toContain("api.visualization.acks({ signal })");
    expect(source).not.toContain(["fetch", "("].join(""));
    expect(source).not.toContain(['"', "/", "v2", "/"].join(""));
  });

  it("uses the viewport-wide ack resource revision", () => {
    const resource: VisualizationClientAckResource = {
      entries: [],
      revision: 17,
    };
    expect(resolveVisualizationClientAcksRevision(resource)).toBe(17);
  });
});
