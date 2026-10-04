import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { isSkipped } from "./bundle-docs.mjs";

const root = join("site", "_build", "html");

test("skips Sphinx sources and build bookkeeping at the site root", () => {
  assert.equal(isSkipped(root, join(root, "_sources")), true);
  assert.equal(isSkipped(root, join(root, "_sources", "index.md.txt")), true);
  assert.equal(isSkipped(root, join(root, ".doctrees", "env.pickle")), true);
  assert.equal(isSkipped(root, join(root, ".buildinfo")), true);
});

test("ships everything a reader or the search needs", () => {
  assert.equal(isSkipped(root, root), false);
  assert.equal(isSkipped(root, join(root, "index.html")), false);
  assert.equal(isSkipped(root, join(root, "searchindex.js")), false);
  assert.equal(isSkipped(root, join(root, "_static", "searchtools.js")), false);
  assert.equal(isSkipped(root, join(root, "physics", "_sources_overview.html")), false);
});

test("matches a directory named like the skipped ones only at the root", () => {
  assert.equal(isSkipped(root, join(root, "physics", "_sources")), false);
});
