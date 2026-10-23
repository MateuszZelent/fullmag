import assert from "node:assert/strict";

/** Keep viewport/data idle strict while measuring the shell's health monitor separately. */
export function assertViewportIdleNetwork({ requests, apiBase, startMs, endMs }) {
  const intervalMs = 5_000;
  const schedulingToleranceMs = 100;
  assert.ok(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs);
  const expectedUrl = new URL("v2/platform/health", `${apiBase.replace(/\/$/, "")}/`).href;
  const health = [];
  for (const request of requests) {
    assert.ok(Number.isFinite(request.atMs) && request.atMs >= startMs && request.atMs <= endMs,
      "Idle request timestamp is outside the measured window");
    assert.ok(request.method === "GET" && request.url === expectedUrl,
      `Viewport issued unexpected resource requests during idle: ${request.method} ${request.url}`);
    health.push(request);
  }
  const budget = Math.floor((endMs - startMs) / intervalMs) + 1;
  assert.ok(health.length <= budget, `Shell health monitor exceeded idle request budget ${budget}: ${health.length}`);
  for (let index = 1; index < health.length; index += 1) {
    assert.ok(health[index].atMs - health[index - 1].atMs >= intervalMs - schedulingToleranceMs,
      "Shell health monitor exceeded its 5000ms cadence during idle");
  }
  return {
    scope: "zero viewport/data requests; separately bounded shell health monitoring",
    durationMs: endMs - startMs,
    healthIntervalMs: intervalMs,
    schedulingToleranceMs,
    healthRequestBudget: budget,
    healthRequests: health,
    viewportRequests: 0,
  };
}
