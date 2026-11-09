import { sessionRequestScopeKey } from "../resources/sessionResourceIdentity";

export type StudyComputeKind = "solve" | "run" | "relax";

export function isStudyComputeKind(value: unknown): value is StudyComputeKind {
  return value === "solve" || value === "run" || value === "relax";
}

export interface StudyComputeObservation {
  clientIntentId: string;
  kind: StudyComputeKind;
  sessionScopeKey: string;
  requestJson?: string;
}

interface StoredObservation {
  clientIntentId: string;
  kind: StudyComputeKind;
  owner: string;
  requestJson?: string;
}

const MAX_OBSERVATIONS = 16;
const MAX_STORAGE_CHARS = 32_768;
const MAX_STORED_REQUEST_JSON_CHARS = 16_384;

export function logicalSessionOwner(scopeKey: string): string | null {
  const params = new URLSearchParams(scopeKey);
  const sessionId = params.get("session");
  const sessionEpoch = params.get("epoch");
  const requestScopeEpoch = params.get("request_scope_epoch");
  if (!sessionId || !sessionEpoch || !requestScopeEpoch ||
      sessionRequestScopeKey({ sessionId, sessionEpoch, requestScopeEpoch }) !== scopeKey) {
    return null;
  }
  return JSON.stringify([sessionId, sessionEpoch]);
}

function validIntentId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

/** Parse only the immutable request identity needed to authorize an explicit retry. */
export function parseStudyComputeRequestJson(
  requestJson: unknown,
  expected: Pick<StudyComputeObservation, "clientIntentId" | "kind">,
): Record<string, unknown> | null {
  if (typeof requestJson !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(requestJson);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  return request.kind === expected.kind && request.client_intent_id === expected.clientIntentId
    ? request
    : null;
}

function decodeStoredObservation(value: unknown): StoredObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Partial<StoredObservation>;
  if (
    typeof entry.owner !== "string" || entry.owner.length > 1_024 ||
    !validIntentId(entry.clientIntentId) || !isStudyComputeKind(entry.kind)
  ) {
    return null;
  }
  const decoded: StoredObservation = {
    clientIntentId: entry.clientIntentId,
    kind: entry.kind,
    owner: entry.owner,
  };
  if (
    typeof entry.requestJson === "string" &&
    entry.requestJson.length <= MAX_STORED_REQUEST_JSON_CHARS &&
    parseStudyComputeRequestJson(entry.requestJson, decoded)
  ) {
    decoded.requestJson = entry.requestJson;
  }
  return decoded;
}

/**
 * Browser-tab hints to read the durable command ledger after reconnect or
 * reload. Scope by API authority and logical session; retain only a bounded,
 * identity-checked request body for an explicit retry.
 */
export function createStudyComputeObservationStore(
  apiBaseUrl: string,
  getStorage: () => Pick<Storage, "getItem" | "setItem"> = () => window.sessionStorage,
) {
  const key = `fullmag.study-compute-observations.v1:${apiBaseUrl}`;

  function read(): StoredObservation[] {
    try {
      const raw = getStorage().getItem(key);
      if (!raw || raw.length > MAX_STORAGE_CHARS) return [];
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) return [];
      return value.map(decodeStoredObservation)
        .filter((entry): entry is StoredObservation => entry !== null)
        .slice(-MAX_OBSERVATIONS);
    } catch {
      return [];
    }
  }

  function write(entries: StoredObservation[]): void {
    try {
      const bounded = entries.slice(-MAX_OBSERVATIONS);
      let serialized = JSON.stringify(bounded);
      if (serialized.length > MAX_STORAGE_CHARS) {
        // Keep the observation hints even when request bodies would exceed the
        // browser storage budget. The owning controller still holds its request.
        serialized = JSON.stringify(bounded.map(({ clientIntentId, kind, owner }) => ({
          clientIntentId,
          kind,
          owner,
        })));
      }
      if (serialized.length <= MAX_STORAGE_CHARS) getStorage().setItem(key, serialized);
    } catch {
      // Browser storage is optional for the live submission and observation.
    }
  }

  return {
    list(sessionScopeKey: string): StudyComputeObservation[] {
      const owner = logicalSessionOwner(sessionScopeKey);
      if (!owner) return [];
      return read().filter((entry) => entry.owner === owner)
        .map(({ clientIntentId, kind, requestJson }) => ({
          clientIntentId,
          kind,
          sessionScopeKey,
          ...(requestJson === undefined ? {} : { requestJson }),
        }));
    },
    remember(observation: StudyComputeObservation): void {
      const { clientIntentId, kind, sessionScopeKey, requestJson } = observation;
      const owner = logicalSessionOwner(sessionScopeKey);
      if (!owner || owner.length > 1_024 || !validIntentId(clientIntentId) || !isStudyComputeKind(kind)) return;
      const entries = read();
      if (entries.some((entry) => entry.owner === owner && entry.clientIntentId === clientIntentId)) return;
      const stored: StoredObservation = { clientIntentId, kind, owner };
      if (
        typeof requestJson === "string" &&
        requestJson.length <= MAX_STORED_REQUEST_JSON_CHARS &&
        parseStudyComputeRequestJson(requestJson, { clientIntentId, kind })
      ) {
        stored.requestJson = requestJson;
      }
      write([...entries, stored]);
    },
    forget(sessionScopeKey: string, clientIntentId: string): boolean {
      const owner = logicalSessionOwner(sessionScopeKey);
      if (!owner) return false;
      const entries = read();
      const next = entries.filter((entry) => entry.owner !== owner || entry.clientIntentId !== clientIntentId);
      if (next.length === entries.length) return false;
      write(next);
      return true;
    },
  };
}

export type StudyComputeObservationStore = ReturnType<typeof createStudyComputeObservationStore>;
