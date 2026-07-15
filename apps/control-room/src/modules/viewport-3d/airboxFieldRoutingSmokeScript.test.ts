import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const smokeScriptUrl = new URL(
  "../../../scripts/smoke-airbox-field-routing.mjs",
  import.meta.url,
);

describe("airbox field routing smoke script", () => {
  it("proves object m and airbox h_demag use scoped field-vector resources", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["smoke:airbox-field-routing"]).toBe(
      "node scripts/smoke-airbox-field-routing.mjs",
    );
    expect(existsSync(smokeScriptUrl)).toBe(true);

    const smokeScript = readFileSync(smokeScriptUrl, "utf8");
    expect(smokeScript).toContain("CONTROL_ROOM_AIRBOX_FIELD_OBJECT_ID");
    expect(smokeScript).toContain("CONTROL_ROOM_AIRBOX_FIELD_OBJECT_QUANTITY_ID");
    expect(smokeScript).toContain("CONTROL_ROOM_AIRBOX_FIELD_AIRBOX_QUANTITY_ID");
    expect(smokeScript).toContain("CONTROL_ROOM_BROWSER_API_BASE_URL");
    expect(smokeScript).toContain("CONTROL_ROOM_BROWSER_HOST_RESOLVER_IP");
    expect(smokeScript).toContain("compute_fields");
    expect(smokeScript).toContain("scope_kind: \"part\"");
    expect(smokeScript).toContain("scope_kind: \"airbox\"");
    expect(smokeScript).toContain("scope_id: airboxPartId");
    expect(smokeScript).toContain(
      "entry.params.scope_id === airboxPartId",
    );
    expect(smokeScript).toContain("!entry.params.scope_id");
    expect(smokeScript).toContain("domain: \"airbox_only\"");
    expect(smokeScript).toContain("forbiddenHdemagFullDomainRequestCount");
    expect(smokeScript).toContain("H_demag used full-domain field-vector requests");
    expect(smokeScript).toContain("status?.session?.session_id");
    expect(smokeScript).toContain("canvas.getContext(\"webgl2\")");
    expect(smokeScript).toContain(
      '[data-node-id="model:airbox:visualization"]',
    );
    expect(smokeScript).toContain("Available air-only nodes");
    expect(smokeScript).toContain("Decoded field samples");
    expect(smokeScript).toContain("Adopted arrows");
    expect(smokeScript).toContain("matchingAirboxFieldRequestCount");
    expect(smokeScript).toContain("x-fullmag-point-count");
    expect(smokeScript).toContain("visualization/state");
    expect(smokeScript).toContain("data/fields/");
    expect(smokeScript).not.toContain("scope_kind=full&scope_id=part%3A__air__");
    expect(smokeScript).toContain("debugFieldRequestDelta");
    expect(smokeScript).toContain("debugIdleFieldRequestDelta");
    expect(smokeScript).toContain("debugIdleFrameDelta");
    expect(smokeScript).toContain("debugIdleScanDelta");
    expect(smokeScript).toContain("debugIdlePublishDelta");
    expect(smokeScript).toContain("assertVisualizationDebugIdleBudgets");
  });
});
