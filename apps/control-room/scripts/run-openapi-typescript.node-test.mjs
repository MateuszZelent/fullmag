import assert from "node:assert/strict";
import { test } from "node:test";
import { registerOpenApiCompilerApi } from "./run-openapi-typescript.mjs";

test("OpenAPI AST generation uses the compatibility API without replacing workspace TypeScript", async () => {
  const workspaceCompiler = await import("typescript");
  const hooks = registerOpenApiCompilerApi();
  try {
    const { default: openapiTS, astToString } = await import("openapi-typescript");
    const output = astToString(await openapiTS({
      openapi: "3.0.3",
      info: { title: "Compiler API regression", version: "1" },
      paths: {
        "/probe": {
          get: {
            responses: {
              "200": {
                description: "Typed observation",
                content: { "application/json": { schema: { $ref: "#/components/schemas/Observation" } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Observation: {
            type: "object",
            required: ["frequency_hz"],
            properties: {
              frequency_hz: { type: "number" },
              mode_id: { type: "string", nullable: true },
            },
          },
        },
      },
    }));
    assert.match(output, /frequency_hz: number/);
    assert.match(output, /mode_id\?: string \| null/);
    assert.match(output, /"\/probe"/);
    assert.equal(await import("typescript"), workspaceCompiler);
  } finally {
    hooks.deregister();
  }
});
