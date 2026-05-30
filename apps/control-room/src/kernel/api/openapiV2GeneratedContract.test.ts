import { describe, expect, it } from "vitest";

import { createOpenApiV2Transport } from "./generated/openapi-v2-client";
import {
  assertOpenApiV2Path,
  openApiV2PathLiterals,
  openApiV2Path,
} from "./generated/openapi-v2-paths";
import * as apiPaths from "./apiPaths";

describe("generated OpenAPI v2 transport", () => {
  it("is generated from the backend v2 resource tree", () => {
    expect(openApiV2PathLiterals).toContain("/v2/sessions/current/status");
    expect(openApiV2PathLiterals).toContain("/v2/sessions/current/model/scene");
    expect(openApiV2PathLiterals).toContain(
      "/v2/sessions/current/simulation/commands",
    );
    expect(openApiV2Path("/v2/sessions/current/status")).toBe(
      "/v2/sessions/current/status",
    );
    expect(() => assertOpenApiV2Path("/not-in-openapi")).toThrow(
      /not present in generated OpenAPI v2/,
    );
  });

  it("exposes an openapi-fetch transport wrapper", async () => {
    const calls: string[] = [];
    const transport = createOpenApiV2Transport({
      baseUrl: "http://127.0.0.1:8765",
      fetch: async (input) => {
        calls.push(input instanceof Request ? input.url : String(input));
        return new Response(
          JSON.stringify({
            api_contract_version: "v2",
            resources: { session: 1 },
            runtime_bundle_version: "dev",
            session: { state: "idle" },
          }),
          { status: 200 },
        );
      },
    });

    const result = await transport.GET(openApiV2Path("/v2/sessions/current/status"));

    expect(result.response.status).toBe(200);
    expect(calls).toEqual([
      "http://127.0.0.1:8765/v2/sessions/current/status",
    ]);
  });

  it("promotes every generated OpenAPI path through the handwritten API path boundary", () => {
    const promotedPaths = new Set(
      Object.values(apiPaths).flatMap((value) =>
        typeof value === "string" && value.startsWith("/v2/") ? [value] : [],
      ),
    );

    expect(
      openApiV2PathLiterals.filter((path) => !promotedPaths.has(path)),
    ).toEqual([]);
  });
});
