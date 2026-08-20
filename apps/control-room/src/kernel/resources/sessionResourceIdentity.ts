import type { LiveStatusResource } from "../api/apiTypes";

export interface SessionResourceIdentity {
  readonly sessionId: string;
  readonly sessionEpoch: string;
}

export function sessionResourceIdentityFromStatus(
  status: LiveStatusResource | null,
): SessionResourceIdentity | null {
  if (!status) return null;
  const sessionId = status.session.session_id.trim();
  const sessionEpoch = status.session.session_epoch.trim();
  if (!sessionId || !sessionEpoch) return null;
  return { sessionEpoch, sessionId };
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
      left.sessionEpoch === right.sessionEpoch)
  );
}

export function sessionScopedResourceKey(
  identity: SessionResourceIdentity,
  resourceKey: string,
): string {
  return `session=${encodeURIComponent(identity.sessionId)}&epoch=${encodeURIComponent(identity.sessionEpoch)}|${resourceKey}`;
}
