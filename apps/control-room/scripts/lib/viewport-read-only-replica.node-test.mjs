import assert from "node:assert/strict";
import { test } from "node:test";
import { installViewportReadOnlyReplica } from "./viewport-read-only-replica.mjs";

async function harness() {
  let handler;
  const reads = [];
  const page = {
    route: async (_pattern, callback) => { handler = callback; },
    request: { get: async (url, { headers }) => {
      reads.push({ url, headers });
      return { body: async () => Buffer.from(headers.range ?? "whole"),
        headers: () => ({ "content-length": "999", "content-encoding": "gzip" }),
        status: () => 206, ok: () => true };
    } },
  };
  const { deniedMutations } = await installViewportReadOnlyReplica(page, { apiBase: "http://data-source/" });
  return { reads, deniedMutations, request: async (method, headers = {}) => {
    let fulfilled;
    await handler({ request: () => ({ method: () => method, headers: () => headers,
      url: () => "http://frontend/v2/sessions/current/meshing/topology" }),
    fulfill: async (response) => { fulfilled = response; } });
    return fulfilled;
  } };
}

test("blocks every mutation before contacting the data source", async () => {
  const proof = await harness();
  for (const method of ["PATCH", "POST", "PUT", "DELETE"]) assert.equal((await proof.request(method)).status, 403);
  assert.equal(proof.reads.length, 0);
  assert.equal(proof.deniedMutations.length, 4);
});

test("freezes each byte range and session scope separately", async () => {
  const proof = await harness();
  const first = { range: "bytes=0-63", "x-fullmag-session-scope": "one" };
  const second = { range: "bytes=64-127", "x-fullmag-session-scope": "one" };
  assert.equal((await proof.request("GET", first)).body.toString(), first.range);
  assert.equal((await proof.request("GET", second)).body.toString(), second.range);
  await proof.request("GET", first);
  await proof.request("GET", { ...first, "x-fullmag-session-scope": "two" });
  assert.equal(proof.reads.length, 3);
  assert.equal(proof.deniedMutations.length, 0);
});
