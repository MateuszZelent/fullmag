import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOpenApiBuildIdentity } from "./normalize-openapi-build-identity.mjs";

test("normalizes volatile build identity in generated OpenAPI artifacts", () => {
  const document = {
    info: { title: "Fullmag" },
    "x-fullmag-build-identity": {
      built_at_utc: "2026-08-23T22:15:56Z",
      git_commit: "a".repeat(40),
      source_snapshot_sha256: "unknown",
      worktree_state: "dirty",
    },
  };

  normalizeOpenApiBuildIdentity(document);

  assert.deepEqual(document["x-fullmag-build-identity"], {
    built_at_utc: "generated-artifact",
    git_commit: "generated-artifact",
    source_snapshot_sha256: "generated-artifact",
    worktree_state: "generated-artifact",
  });
});
