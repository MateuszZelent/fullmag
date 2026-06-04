import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const smokeScriptUrl = new URL(
  "../../../scripts/smoke-realtime-communication-budget.mjs",
  import.meta.url,
);

describe("realtime communication budget smoke script", () => {
  it("is exposed as a Fullmag-only transport budget smoke", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["smoke:realtime-communication-budget"]).toBe(
      "node scripts/smoke-realtime-communication-budget.mjs",
    );
    expect(existsSync(smokeScriptUrl)).toBe(true);

    const smokeScript = readFileSync(smokeScriptUrl, "utf8");
    expect(smokeScript).toContain("CONTROL_ROOM_COMMUNICATION_WINDOW_MS");
    expect(smokeScript).toContain("CONTROL_ROOM_COMMUNICATION_WARMUP_MS");
    expect(smokeScript).toContain("FULLMAG_WS_PATH");
    expect(smokeScript).toContain(
      ["", "v2", "sessions", "current", "events", "ws"].join("/"),
    );
    expect(smokeScript).toContain("currentSessionPath(request.url())");
    expect(smokeScript).toContain("parsed.origin !== apiBase");
    expect(smokeScript).toContain("pathnameFromUrl(websocket.url()) !== FULLMAG_WS_PATH");
    expect(smokeScript).toContain("scalar.sample websocket telemetry");
    expect(smokeScript).toContain("fieldVectorHttpTxPerMinute");
    expect(smokeScript).toContain("topologyHttpTxPerMinute");
    expect(smokeScript).toContain("CONTROL_ROOM_COMMUNICATION_MAX_SESSION_HTTP_PER_MIN");
    expect(smokeScript).toContain(
      "CONTROL_ROOM_COMMUNICATION_MAX_SCALAR_SAMPLE_WS_PER_MIN",
    );
    expect(smokeScript).toContain(
      "CONTROL_ROOM_COMMUNICATION_REQUIRE_FULLMAG_WS",
    );
    expect(smokeScript).not.toContain("building");
    expect(smokeScript).not.toContain("isrManifest");
  });
});
