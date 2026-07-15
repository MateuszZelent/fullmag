import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const openApiUrl = new URL("./generated/openapi-v2.json", import.meta.url);
const generatedTypesUrl = new URL(
  "./generated/openapi-v2-types.ts",
  import.meta.url,
);
const asyncApiUrl = new URL(
  "../../../../../docs/specs/asyncapi/fullmag-live-realtime-v1.json",
  import.meta.url,
);

function generationSchemas(
  value: unknown,
  path: readonly string[] = [],
): Array<{ path: string; schema: Record<string, unknown> }> {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const current = path.at(-1);
  const own =
    current === "generation_id" || current === "domain_generation_id"
      ? [{ path: path.join("."), schema: record }]
      : [];
  return own.concat(
    Object.entries(record).flatMap(([key, child]) =>
      generationSchemas(child, [...path, key]),
    ),
  );
}

describe("exact generation id transport contract", () => {
  it("publishes every OpenAPI and AsyncAPI generation id as a decimal string", () => {
    for (const source of [openApiUrl, asyncApiUrl]) {
      const document = JSON.parse(readFileSync(source, "utf8")) as unknown;
      const schemas = generationSchemas(document);

      expect(schemas.length).toBeGreaterThan(0);
      for (const entry of schemas) {
        const type = entry.schema.type;
        expect(
          type === "string" ||
            (Array.isArray(type) &&
              type.includes("string") &&
              type.every((candidate) => candidate === "string" || candidate === "null")),
          entry.path,
        ).toBe(true);
      }
    }
  });

  it("does not regenerate numeric TypeScript generation identities", () => {
    const generatedTypes = readFileSync(generatedTypesUrl, "utf8");

    expect(generatedTypes).not.toMatch(/\bdomain_generation_id:\s*number\b/);
    expect(generatedTypes).not.toMatch(/\bgeneration_id:\s*number\b/);
  });
});
