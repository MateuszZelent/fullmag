import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveDevServerPublicOrigin } from "./dev-server-public-origin.mjs";

test("uses the published host port without changing the listen port", () => {
  assert.equal(resolveDevServerPublicOrigin("localhost", "3100", "3101"), "http://localhost:3101");
});

test("preserves direct launches and IPv6 hosts", () => {
  assert.equal(resolveDevServerPublicOrigin("localhost", "3100"), "http://localhost:3100");
  assert.equal(resolveDevServerPublicOrigin("::1", "3100", "3200"), "http://[::1]:3200");
});

test("rejects invalid published ports", () => {
  for (const port of ["0", "65536", "abc", "3101/path"]) {
    assert.throws(() => resolveDevServerPublicOrigin("localhost", "3100", port), /public port/i);
  }
});
