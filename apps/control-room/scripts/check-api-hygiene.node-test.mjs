import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { findApiHygieneFailures } from "./check-api-hygiene.mjs";

test("rejects direct fetch and hand-built v2 paths in production source", async () => {
  await withFixture(
    {
      "src/production.ts":
        'export const load = () => fetch("/v2/sessions/current/status");\n',
    },
    (root) => {
      const failures = findApiHygieneFailures(root);

      assert.deepEqual(
        failures.map(({ kind, label }) => ({ kind, label })),
        [
          {
            kind: "failure",
            label: "direct fetch outside kernel API",
          },
          {
            kind: "failure",
            label: "hand-built v2 endpoint strings outside API/generated",
          },
        ],
      );
    },
  );
});

test("ignores expected API literals in test and spec files", async () => {
  await withFixture(
    {
      "src/modules/viewport3dResources.test.ts":
        'expect(fetch("/v2/sessions/current/data/fields/m")).toBeDefined();\n',
      "src/hooks/useViewport3DSceneModel.spec.ts":
        'const expectedPath = "/v2/sessions/current/data/fields/m";\n',
    },
    (root) => {
      assert.deepEqual(findApiHygieneFailures(root), []);
    },
  );
});

async function withFixture(files, callback) {
  const root = await mkdtemp(join(tmpdir(), "fullmag-api-hygiene-"));

  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = join(root, relativePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, contents, "utf8");
    }

    await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
