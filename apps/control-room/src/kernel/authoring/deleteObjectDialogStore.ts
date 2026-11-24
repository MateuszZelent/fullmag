import type { SceneResource } from "@/kernel/api/apiTypes";

export interface DeleteObjectDialogRequest {
  readonly objectId: string;
  readonly requestId: string;
  readonly scene: SceneResource | null;
}

type Listener = () => void;

interface PendingResolver {
  readonly requestId: string;
  readonly resolve: (confirmed: boolean) => void;
}

let hostCount = 0;
let requestSeq = 0;
let currentRequest: DeleteObjectDialogRequest | null = null;
let pendingResolver: PendingResolver | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function settle(requestId: string | null, confirmed: boolean): void {
  if (!pendingResolver) {
    if (currentRequest !== null) {
      currentRequest = null;
      emit();
    }
    return;
  }
  if (requestId !== null && pendingResolver.requestId !== requestId) {
    return;
  }
  const resolver = pendingResolver;
  pendingResolver = null;
  currentRequest = null;
  emit();
  resolver.resolve(confirmed);
}

/**
 * Workspace-scoped confirmation store for `geometry.delete-object`.
 * When a `DeleteObjectImpactDialogHost` is mounted, every delete entry point
 * (Explorer context menu, Ribbon, keyboard shortcut, Command Palette, Inspector)
 * waits for explicit confirmation in `DeleteObjectImpactDialog`. When no UI host
 * is mounted (e.g. headless command unit tests), confirmation resolves immediately.
 */
export const deleteObjectDialogStore = {
  cancel(requestId?: string): void {
    settle(requestId ?? null, false);
  },

  confirm(requestId?: string): void {
    settle(requestId ?? null, true);
  },

  getServerSnapshot(): DeleteObjectDialogRequest | null {
    return null;
  },

  getSnapshot(): DeleteObjectDialogRequest | null {
    return currentRequest;
  },

  hasHost(): boolean {
    return hostCount > 0;
  },

  registerHost(): () => void {
    hostCount += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      hostCount = Math.max(0, hostCount - 1);
      if (hostCount === 0 && pendingResolver) {
        settle(null, false);
      }
    };
  },

  requestConfirmation({
    objectId,
    scene = null,
  }: {
    objectId: string;
    scene?: SceneResource | null;
  }): Promise<boolean> {
    if (hostCount <= 0) {
      return Promise.resolve(true);
    }
    if (pendingResolver) {
      settle(null, false);
    }
    const requestId = `delete-object-${++requestSeq}`;
    currentRequest = { objectId, requestId, scene };
    return new Promise<boolean>((resolve) => {
      pendingResolver = { requestId, resolve };
      emit();
    });
  },

  reset(): void {
    hostCount = 0;
    settle(null, false);
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
