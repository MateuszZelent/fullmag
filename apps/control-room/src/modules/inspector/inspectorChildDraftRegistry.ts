interface InspectorChildDraftSession {
  applying?: boolean;
  dirty: boolean;
  profileBound?: boolean;
  valid: boolean;
}

interface InspectorChildDraftStatus {
  applying: boolean;
  dirty: boolean;
  ownerKey: string;
  profileBound: boolean;
  valid: boolean;
}

/** A panel-local registration. Draft values stay in the child that edits them. */
export interface InspectorChildDraftRegistry<Session extends InspectorChildDraftSession> {
  getSession: (ownerKey: string) => Session | null;
  getSnapshot: () => InspectorChildDraftStatus | null;
  getServerSnapshot: () => null;
  publish: (owner: symbol, ownerKey: string, session: Session) => void;
  retire: (owner: symbol) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createInspectorChildDraftRegistry<Session extends InspectorChildDraftSession>():
  InspectorChildDraftRegistry<Session> {
  const listeners = new Set<() => void>();
  let current: { owner: symbol; session: Session } | null = null;
  let status: InspectorChildDraftStatus | null = null;

  const notify = () => {
    listeners.forEach((listener) => listener());
  };

  return {
    getSession: (ownerKey) => status?.ownerKey === ownerKey ? current?.session ?? null : null,
    getSnapshot: () => status,
    getServerSnapshot: () => null,
    publish: (owner, ownerKey, session) => {
      current = { owner, session };
      const applying = session.applying ?? false;
      const profileBound = session.profileBound ?? false;
      if (
        status?.ownerKey === ownerKey &&
        status.applying === applying &&
        status.dirty === session.dirty &&
        status.profileBound === profileBound &&
        status.valid === session.valid
      ) return;
      status = { applying, dirty: session.dirty, ownerKey, profileBound, valid: session.valid };
      notify();
    },
    retire: (owner) => {
      if (current?.owner !== owner) return;
      current = null;
      status = null;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
