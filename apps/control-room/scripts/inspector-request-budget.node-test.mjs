import assert from "node:assert/strict";
import test from "node:test";

import {
  createInspectorRequestBudgetState,
  recordInspectorRequestBudget,
  resetInspectorDocumentBudget,
} from "./lib/inspector-request-budget.mjs";

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
