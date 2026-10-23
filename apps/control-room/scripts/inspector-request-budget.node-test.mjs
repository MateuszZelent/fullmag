import assert from "node:assert/strict";
import test from "node:test";

import {
  createInspectorRequestBudgetState,
  recordInspectorRequestBudget,
  resetInspectorDocumentBudget,
} from "./lib/inspector-request-budget.mjs";

const apiBase = "http://configured-api.test:8081";
const healthUrl = `${apiBase}/v2/platform/health`;
const healthRequestKey = "GET /v2/platform/health";

function recordHealth(state, atMs, overrides = {}) {
  const requestUrl = overrides.url ?? healthUrl;
  const method = overrides.method ?? "GET";
  const requestKey = overrides.requestKey ?? `${method} /v2/platform/health`;
  return recordInspectorRequestBudget(state, {
    atMs,
    method,
    requestKey,
    requestLimit: overrides.requestLimit ?? 8,
    requestUrl,
  });
}

test("resets GET budget at a document boundary while retaining cumulative evidence", () => {
  const state = createInspectorRequestBudgetState();
  resetInspectorDocumentBudget(state, "document-1");

  const first = recordInspectorRequestBudget(state, {
    method: "GET",
    requestKey: "GET /v2/sessions/current/model/scene",
    requestLimit: 1,
  });
  assert.deepEqual(first, {
    count: 1,
    cumulativeCount: 1,
    documentId: 1,
    exceeded: false,
    scope: "document",
  });

  resetInspectorDocumentBudget(state, "document-2");
  const second = recordInspectorRequestBudget(state, {
    method: "GET",
    requestKey: "GET /v2/sessions/current/model/scene",
    requestLimit: 1,
  });
  assert.equal(second.count, 1);
  assert.equal(second.cumulativeCount, 2);
  assert.equal(second.documentId, 2);
  assert.equal(second.exceeded, false);
  assert.equal(state.cumulativeCounts.get("GET /v2/sessions/current/model/scene"), 2);
});

test("rejects repeated GETs within one document", () => {
  const state = createInspectorRequestBudgetState();
  resetInspectorDocumentBudget(state, "document-1");

  recordInspectorRequestBudget(state, {
    method: "GET",
    requestKey: "GET /v2/sessions/current/model/scene",
    requestLimit: 1,
  });
  const repeated = recordInspectorRequestBudget(state, {
    method: "GET",
    requestKey: "GET /v2/sessions/current/model/scene",
    requestLimit: 1,
  });

  assert.equal(repeated.count, 2);
  assert.equal(repeated.cumulativeCount, 2);
  assert.equal(repeated.documentId, 1);
  assert.equal(repeated.exceeded, true);
  assert.equal(repeated.scope, "document");
});

test("keeps mutation budgets scenario-scoped across document boundaries", () => {
  const state = createInspectorRequestBudgetState();
  resetInspectorDocumentBudget(state, "document-1");
  const first = recordInspectorRequestBudget(state, {
    method: "POST",
    requestKey: "POST /v2/sessions/current/model/transactions",
    requestLimit: 1,
  });
  resetInspectorDocumentBudget(state, "document-2");
  const second = recordInspectorRequestBudget(state, {
    method: "POST",
    requestKey: "POST /v2/sessions/current/model/transactions",
    requestLimit: 1,
  });

  assert.equal(first.scope, "scenario");
  assert.equal(first.exceeded, false);
  assert.equal(second.scope, "scenario");
  assert.equal(second.count, 2);
  assert.equal(second.cumulativeCount, 2);
  assert.equal(second.exceeded, true);
});

test("allows more than eight exact health polls when the document window permits them", () => {
  const state = createInspectorRequestBudgetState({ apiBase });
  resetInspectorDocumentBudget(state, "long-document", 0);

  let last;
  for (let index = 0; index < 9; index += 1) {
    last = recordHealth(state, index * 5_000);
  }

  assert.equal(last.exceeded, false);
  assert.equal(last.count, 9);
  assert.equal(last.cumulativeCount, 9);
  assert.equal(last.limit, 9);
  assert.equal(last.health.elapsedMs, 40_000);
  assert.equal(last.health.intervalMs, 5_000);
  assert.equal(last.health.toleranceMs, 100);
  assert.equal(last.health.minimumCadenceMs, 4_900);
  assert.equal(last.health.cadenceMs, 5_000);
  assert.deepEqual(last.health.violations, []);
  assert.equal(state.documentCounts.get(healthRequestKey), 9);
  assert.equal(state.cumulativeCounts.get(healthRequestKey), 9);
  assert.equal(state.healthRequests.length, 9);
});

test("bounds the long-window count at 5000ms even when polls meet the 4900ms cadence minimum", () => {
  const state = createInspectorRequestBudgetState({ apiBase });
  resetInspectorDocumentBudget(state, "minimum-cadence-document", 0);

  let last;
  for (let index = 0; index < 9; index += 1) {
    last = recordHealth(state, index * 4_900);
  }

  assert.equal(last.count, 9);
  assert.equal(last.limit, 8);
  assert.equal(last.health.elapsedMs, 39_200);
  assert.equal(last.health.cadenceMs, 4_900);
  assert.deepEqual(last.health.violations, ["budget"]);
  assert.equal(state.healthRequests.length, 9);
});

test("rejects rapid and duplicate health requests with measured budget and cadence evidence", () => {
  const state = createInspectorRequestBudgetState({ apiBase });
  resetInspectorDocumentBudget(state, "duplicate-health", 100);
  recordHealth(state, 100);

  const duplicate = recordHealth(state, 100);
  assert.equal(duplicate.exceeded, true);
  assert.equal(duplicate.count, 2);
  assert.equal(duplicate.limit, 1);
  assert.equal(duplicate.health.elapsedMs, 0);
  assert.equal(duplicate.health.cadenceMs, 0);
  assert.deepEqual(duplicate.health.violations, ["budget", "cadence"]);

  resetInspectorDocumentBudget(state, "fast-health-loop", 200);
  recordHealth(state, 250);
  const fast = recordHealth(state, 5_149);
  assert.equal(fast.exceeded, true);
  assert.equal(fast.limit, 1);
  assert.equal(fast.health.cadenceMs, 4_899);
  assert.deepEqual(fast.health.violations, ["budget", "cadence"]);
});

test("resets health elapsed time and cadence per document while retaining cumulative counts", () => {
  const state = createInspectorRequestBudgetState({ apiBase });
  resetInspectorDocumentBudget(state, "document-1", 1_000);
  recordHealth(state, 1_000);
  recordHealth(state, 6_000);

  resetInspectorDocumentBudget(state, "document-2", 100_000);
  const nextDocument = recordHealth(state, 100_000);

  assert.equal(nextDocument.documentId, 2);
  assert.equal(nextDocument.count, 1);
  assert.equal(nextDocument.cumulativeCount, 3);
  assert.equal(nextDocument.limit, 1);
  assert.equal(nextDocument.health.elapsedMs, 0);
  assert.equal(nextDocument.health.cadenceMs, null);
  assert.equal(state.documentCounts.get(healthRequestKey), 1);
  assert.equal(state.cumulativeCounts.get(healthRequestKey), 3);
  assert.equal(state.documentHealthCount, 1);
  assert.equal(state.cumulativeHealthCount, 3);
  assert.equal(state.healthRequests.length, 3);
  assert.deepEqual(
    state.healthRequests.map(({ documentId, documentLabel }) => [documentId, documentLabel]),
    [[1, "document-1"], [1, "document-1"], [2, "document-2"]],
  );
});

test("applies the health budget only to the configured exact GET URL", () => {
  const state = createInspectorRequestBudgetState({ apiBase });
  resetInspectorDocumentBudget(state, "exact-endpoint", 0);

  const foreignFirst = recordHealth(state, 0, {
    url: "http://foreign-api.test:8081/v2/platform/health",
  });
  assert.equal(foreignFirst.health, undefined);
  const exact = recordHealth(state, 0);
  assert.equal(exact.health.count, 1);
  assert.equal(exact.count, 1);
  assert.equal(state.documentCounts.get(healthRequestKey), 2);

  for (const request of [
    { url: `${healthUrl}?poll=1`, method: "GET", requestKey: healthRequestKey, scope: "document", expectedCount: 9, requestLimit: 8 },
    { url: "http://foreign-api.test:8081/v2/platform/health", method: "GET", requestKey: healthRequestKey, scope: "document", expectedCount: 9, requestLimit: 8 },
    { url: `${apiBase}/v2/platform/runtime`, method: "GET", requestKey: "GET /v2/platform/runtime", scope: "document", expectedCount: 9, requestLimit: 8 },
    { url: healthUrl, method: "POST", requestKey: "POST /v2/platform/health", scope: "scenario", expectedCount: 2, requestLimit: 1 },
  ]) {
    const candidate = createInspectorRequestBudgetState({ apiBase });
    resetInspectorDocumentBudget(candidate, "non-health-request", 0);
    let result;
    for (let index = 0; index < request.expectedCount; index += 1) {
      result = recordHealth(candidate, index * 5_000, request);
    }
    assert.equal(result.health, undefined, `${request.method} ${request.url} must use its existing budget`);
    assert.equal(result.scope, request.scope);
    assert.equal(result.count, request.expectedCount);
    assert.equal(result.exceeded, true);
  }
});

test("resolves the configured API base by CI environment precedence and default", () => {
  const previousControlRoomApiBaseUrl = process.env.CONTROL_ROOM_API_BASE_URL;
  const previousPublicApiBaseUrl = process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL;
  try {
    process.env.CONTROL_ROOM_API_BASE_URL = "http://control-room-api.test:8081";
    process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL = "http://public-api.test:8081";
    let state = createInspectorRequestBudgetState();
    resetInspectorDocumentBudget(state, "control-room-env", 0);
    assert.ok(recordHealth(state, 0, {
      url: "http://control-room-api.test:8081/v2/platform/health",
    }).health);
    assert.equal(recordHealth(state, 0, {
      url: "http://public-api.test:8081/v2/platform/health",
    }).health, undefined);

    delete process.env.CONTROL_ROOM_API_BASE_URL;
    state = createInspectorRequestBudgetState();
    resetInspectorDocumentBudget(state, "public-env", 0);
    assert.ok(recordHealth(state, 0, {
      url: "http://public-api.test:8081/v2/platform/health",
    }).health);

    delete process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL;
    state = createInspectorRequestBudgetState();
    resetInspectorDocumentBudget(state, "default-api-base", 0);
    assert.ok(recordHealth(state, 0, {
      url: "http://localhost:8081/v2/platform/health",
    }).health);
  } finally {
    if (previousControlRoomApiBaseUrl === undefined) {
      delete process.env.CONTROL_ROOM_API_BASE_URL;
    } else {
      process.env.CONTROL_ROOM_API_BASE_URL = previousControlRoomApiBaseUrl;
    }
    if (previousPublicApiBaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL = previousPublicApiBaseUrl;
    }
  }
});
