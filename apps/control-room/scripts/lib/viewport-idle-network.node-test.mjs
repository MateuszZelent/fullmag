import assert from "node:assert/strict";
import { test } from "node:test";
import { assertViewportIdleNetwork } from "./viewport-idle-network.mjs";

const apiBase = "http://localhost:8081";
const health = (atMs) => ({ method: "GET", url: `${apiBase}/v2/platform/health`, atMs });
const check = (requests, endMs = 5_100) => assertViewportIdleNetwork({ requests, apiBase, startMs: 100, endMs });

test("keeps viewport requests zero and records a phase-aligned shell heartbeat", () => {
  assert.equal(check([]).viewportRequests, 0);
  assert.equal(check([health(2_000)]).healthRequests.length, 1);
  assert.equal(check([health(100), health(5_100)]).healthRequests.length, 2);
});
test("uses actual observation duration for the shell budget", () => {
  assert.equal(check([health(100), health(5_100), health(10_100)], 10_100).healthRequestBudget, 3);
  assert.throws(() => check([health(100), health(200)], 1_000), /budget/);
});
test("rejects a fast health loop even inside the count budget", () => {
  assert.throws(() => check([health(200), health(300)]), /cadence/);
  assert.throws(() => check([health(100), health(2_500), health(5_100)]), /budget/);
});
test("rejects fields, topology, runtime status, other origins, queries and mutations", () => {
  for (const url of [
    `${apiBase}/v2/sessions/current/data/fields/m`,
    `${apiBase}/v2/sessions/current/data/domain/topology`,
    `${apiBase}/v2/platform/runtime-service`,
    `${apiBase}/v2/platform/health?poll=1`,
    "http://another-host:8081/v2/platform/health",
  ]) assert.throws(() => check([{ ...health(200), url }]), /unexpected resource/);
  assert.throws(() => check([{ ...health(200), method: "POST" }]), /unexpected resource/);
});
test("rejects missing and out-of-window timestamps", () => {
  for (const atMs of [undefined, NaN, 99, 5_101]) assert.throws(() => check([health(atMs)]), /timestamp/);
});
