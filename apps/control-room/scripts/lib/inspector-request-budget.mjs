import { performance } from "node:perf_hooks";

// Idempotent reads repeat after each document reload; mutation caps remain
// scenario-scoped so a reload cannot hide duplicate authoring writes.
const DOCUMENT_SCOPED_METHODS = new Set(["GET"]);
const HEALTH_ENDPOINT = "v2/platform/health";
const INSPECTOR_HEALTH_INTERVAL_MS = 5_000;
const INSPECTOR_HEALTH_SCHEDULING_TOLERANCE_MS = 100;
const INSPECTOR_HEALTH_MIN_CADENCE_MS =
  INSPECTOR_HEALTH_INTERVAL_MS - INSPECTOR_HEALTH_SCHEDULING_TOLERANCE_MS;

export function createInspectorRequestBudgetState({ apiBase } = {}) {
  const configuredApiBase = apiBase ??
    process.env.CONTROL_ROOM_API_BASE_URL ??
    process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
    "http://localhost:8081";
  const apiBaseUrl = new URL(configuredApiBase);
  apiBaseUrl.search = "";
  apiBaseUrl.hash = "";
  apiBaseUrl.pathname = `${apiBaseUrl.pathname.replace(/\/+$/, "")}/`;

  return {
    apiBase: apiBaseUrl.href.replace(/\/$/, ""),
    cumulativeCounts: new Map(),
    cumulativeHealthCount: 0,
    documentCounts: new Map(),
    documentHealthCount: 0,
    documentId: 0,
    documentLabel: "before-first-document",
    documentStartedAtMs: null,
    expectedHealthUrl: new URL(HEALTH_ENDPOINT, apiBaseUrl).href,
    healthRequests: [],
    lastHealthRequest: null,
    lastHealthRequestAtMs: null,
  };
}

export function resetInspectorDocumentBudget(
  state,
  label,
  nowMs = performance.now(),
) {
  state.documentId += 1;
  state.documentLabel = label;
  state.documentCounts = new Map();
  state.documentHealthCount = 0;
  state.documentStartedAtMs = nowMs;
  state.lastHealthRequest = null;
  state.lastHealthRequestAtMs = null;
  return state.documentId;
}

export function recordInspectorRequestBudget(
  state,
  { atMs, method, requestKey, requestLimit, requestUrl },
) {
  const cumulativeCount = incrementCount(state.cumulativeCounts, requestKey);
  const documentScoped = DOCUMENT_SCOPED_METHODS.has(method);
  const scopedCount = documentScoped
    ? incrementCount(state.documentCounts, requestKey)
    : cumulativeCount;

  if (isConfiguredHealthRequest(state, method, requestUrl)) {
    return recordHealthRequest(state, { atMs, requestUrl });
  }

  return {
    count: scopedCount,
    cumulativeCount,
    documentId: state.documentId,
    exceeded: scopedCount > requestLimit,
    scope: documentScoped ? "document" : "scenario",
  };
}

function recordHealthRequest(state, { atMs, requestUrl }) {
  const count = state.documentHealthCount + 1;
  const cumulativeCount = state.cumulativeHealthCount + 1;
  state.documentHealthCount = count;
  state.cumulativeHealthCount = cumulativeCount;

  const elapsedMs = Number.isFinite(atMs) && Number.isFinite(state.documentStartedAtMs)
    ? atMs - state.documentStartedAtMs
    : null;
  const cadenceMs = Number.isFinite(atMs) && state.lastHealthRequestAtMs !== null
    ? atMs - state.lastHealthRequestAtMs
    : null;
  const validTimestamp = elapsedMs !== null && elapsedMs >= 0 &&
    Number.isFinite(atMs) &&
    (state.lastHealthRequestAtMs === null || atMs >= state.lastHealthRequestAtMs);
  const limit = elapsedMs !== null && elapsedMs >= 0
    ? Math.floor(elapsedMs / INSPECTOR_HEALTH_INTERVAL_MS) + 1
    : 0;
  const violations = [];
  if (!validTimestamp) violations.push("timestamp");
  if (count > limit) violations.push("budget");
  if (cadenceMs !== null && cadenceMs < INSPECTOR_HEALTH_MIN_CADENCE_MS) {
    violations.push("cadence");
  }

  if (validTimestamp) state.lastHealthRequestAtMs = atMs;
  const health = {
    apiBase: state.apiBase,
    atMs,
    cadenceMs,
    count,
    cumulativeCount,
    documentId: state.documentId,
    documentLabel: state.documentLabel,
    elapsedMs,
    endpoint: state.expectedHealthUrl,
    intervalMs: INSPECTOR_HEALTH_INTERVAL_MS,
    limit,
    minimumCadenceMs: INSPECTOR_HEALTH_MIN_CADENCE_MS,
    requestUrl,
    toleranceMs: INSPECTOR_HEALTH_SCHEDULING_TOLERANCE_MS,
    violations,
  };
  state.healthRequests.push(health);
  state.lastHealthRequest = health;

  return {
    count,
    cumulativeCount,
    documentId: state.documentId,
    exceeded: violations.length > 0,
    health,
    limit,
    scope: "document",
  };
}

function isConfiguredHealthRequest(state, method, requestUrl) {
  if (method !== "GET" || typeof requestUrl !== "string") return false;
  try {
    return new URL(requestUrl).href === state.expectedHealthUrl;
  } catch {
    return false;
  }
}

function incrementCount(counts, key) {
  const count = (counts.get(key) ?? 0) + 1;
  counts.set(key, count);
  return count;
}
