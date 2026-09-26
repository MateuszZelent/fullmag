import type { LiveStatusResource } from "../api/apiTypes";

export interface SessionResourceIdentity {
  readonly sessionId: string;
  readonly sessionEpoch: string;
  readonly requestScopeEpoch: string;
}

export function sessionResourceIdentityFromStatus(
  status: LiveStatusResource | null,
): SessionResourceIdentity | null {
  if (!status) return null;
  const sessionId = status.session.session_id?.trim();
  const sessionEpoch = status.session.session_epoch?.trim();
  const requestScopeEpoch = status.session.request_scope_epoch?.trim();
  if (!sessionId || !sessionEpoch || !requestScopeEpoch) return null;
  return { requestScopeEpoch, sessionEpoch, sessionId };
}

export function sessionResourceIdentitiesEqual(
  left: SessionResourceIdentity | null,
  right: SessionResourceIdentity | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.sessionId === right.sessionId &&
      left.sessionEpoch === right.sessionEpoch &&
      left.requestScopeEpoch === right.requestScopeEpoch)
  );
}

export function sessionScopedResourceKey(
  identity: SessionResourceIdentity,
  resourceKey: string,
): string {
  return `${sessionRequestScopeKey(identity)}|${resourceKey}`;
}

export function sessionResourceIdentityKey(
  identity: SessionResourceIdentity,
): string {
  return `${identity.sessionId}\u0000${identity.sessionEpoch}\u0000${identity.requestScopeEpoch}`;
}

export function sessionRequestScopeKey(
  identity: SessionResourceIdentity | null,
): string | null {
  if (!identity) return null;
  return `session=${encodeURIComponent(identity.sessionId)}&epoch=${encodeURIComponent(identity.sessionEpoch)}&request_scope_epoch=${encodeURIComponent(identity.requestScopeEpoch)}`;
}
