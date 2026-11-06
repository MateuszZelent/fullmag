import { sessionRequestScopeKey } from "../resources/sessionResourceIdentity";

export type StudyComputeKind = "solve" | "run" | "relax";

export function isStudyComputeKind(value: unknown): value is StudyComputeKind {
  return value === "solve" || value === "run" || value === "relax";
}

export interface StudyComputeObservation {
  clientIntentId: string;
  kind: StudyComputeKind;
  sessionScopeKey: string;
}

interface StoredObservation {
  clientIntentId: string;
  kind: StudyComputeKind;
  owner: string;
}

const MAX_OBSERVATIONS = 16;

function logicalSessionOwner(scopeKey: string): string | null {
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

function isStoredObservation(value: unknown): value is StoredObservation {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<StoredObservation>;
  return typeof entry.owner === "string" && entry.owner.length <= 1_024 &&
    validIntentId(entry.clientIntentId) && isStudyComputeKind(entry.kind);
}

/**
 * Browser-tab hints to read the durable command ledger after reconnect or
 * reload. Scope by API authority and logical session. Store no request body.
 */
export function createStudyComputeObservationStore(
  apiBaseUrl: string,
  getStorage: () => Pick<Storage, "getItem" | "setItem"> = () => window.sessionStorage,
) {
  const key = `fullmag.study-compute-observations.v1:${apiBaseUrl}`;

  function read(): StoredObservation[] {
    try {
      const raw = getStorage().getItem(key);
      if (!raw || raw.length > 32_768) return [];
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) return [];
      return value.filter(isStoredObservation).slice(-MAX_OBSERVATIONS);
    } catch {
      return [];
    }
  }

  function write(entries: StoredObservation[]): void {
    try {
      getStorage().setItem(key, JSON.stringify(entries.slice(-MAX_OBSERVATIONS)));
    } catch {
      // Browser storage is optional for the live submission and observation.
    }
  }

  return {
    list(sessionScopeKey: string): StudyComputeObservation[] {
      const owner = logicalSessionOwner(sessionScopeKey);
      if (!owner) return [];
      return read().filter((entry) => entry.owner === owner)
        .map(({ clientIntentId, kind }) => ({ clientIntentId, kind, sessionScopeKey }));
    },
    remember({ clientIntentId, kind, sessionScopeKey }: StudyComputeObservation): void {
      const owner = logicalSessionOwner(sessionScopeKey);
      if (!owner || owner.length > 1_024 || !validIntentId(clientIntentId)) return;
      const entries = read();
      if (entries.some((entry) => entry.owner === owner && entry.clientIntentId === clientIntentId)) return;
      write([...entries, { clientIntentId, kind, owner }]);
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
