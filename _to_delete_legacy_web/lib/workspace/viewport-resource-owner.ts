import { releaseViewportResourcesByOwner } from "@/lib/debug/viewportResourceManager";

export interface ViewportResourceOwnerSnapshot {
  ownerId: string;
  abortControllers: number;
  cleanupCount: number;
  disposed: boolean;
}

export class ViewportResourceOwner {
  private abortControllers = new Map<string, AbortController>();
  private cleanups = new Map<string, () => void>();
  private disposed = false;

  constructor(public readonly ownerId: string) {}

  createAbortController(key: string): AbortSignal {
    this.assertNotDisposed();
    this.abort(key, "replace-abort-controller");
    const controller = new AbortController();
    this.abortControllers.set(key, controller);
    return controller.signal;
  }

  abort(key: string, reason?: string): void {
    const controller = this.abortControllers.get(key);
    if (!controller) {
      return;
    }
    this.abortControllers.delete(key);
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  }

  registerCleanup(key: string, cleanup: () => void): void {
    this.assertNotDisposed();
    const previous = this.cleanups.get(key);
    if (previous) {
      runCleanup(previous);
    }
    this.cleanups.set(key, cleanup);
  }

  unregisterCleanup(key: string, cleanup?: () => void): void {
    const existing = this.cleanups.get(key);
    if (!existing || (cleanup && existing !== cleanup)) {
      return;
    }
    this.cleanups.delete(key);
  }

  dispose(reason: string): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const [key] of Array.from(this.abortControllers)) {
      this.abort(key, reason);
    }

    for (const cleanup of Array.from(this.cleanups.values())) {
      runCleanup(cleanup);
    }
    this.cleanups.clear();

    releaseViewportResourcesByOwner(this.ownerId);
  }

  snapshot(): ViewportResourceOwnerSnapshot {
    return {
      ownerId: this.ownerId,
      abortControllers: this.abortControllers.size,
      cleanupCount: this.cleanups.size,
      disposed: this.disposed,
    };
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`ViewportResourceOwner ${this.ownerId} is disposed`);
    }
  }
}

const owners = new Map<string, ViewportResourceOwner>();

export function getViewportResourceOwner(ownerId: string): ViewportResourceOwner {
  const existing = owners.get(ownerId);
  if (existing) {
    return existing;
  }
  const owner = new ViewportResourceOwner(ownerId);
  owners.set(ownerId, owner);
  return owner;
}

export function disposeViewportResourceOwner(ownerId: string, reason: string): void {
  const owner = owners.get(ownerId);
  if (!owner) {
    releaseViewportResourcesByOwner(ownerId);
    return;
  }
  owners.delete(ownerId);
  owner.dispose(reason);
}

export function disposeViewportResourceOwnersByPrefix(prefix: string, reason: string): void {
  for (const ownerId of Array.from(owners.keys())) {
    if (ownerId.startsWith(prefix)) {
      disposeViewportResourceOwner(ownerId, reason);
    }
  }
}

export function getViewportResourceOwnerSnapshot(): ViewportResourceOwnerSnapshot[] {
  return Array.from(owners.values()).map((owner) => owner.snapshot());
}

export function workspaceViewportResourceOwnerId(stage: string, tabId: string): string {
  return `workspace:${stage}:${tabId}`;
}

function runCleanup(cleanup: () => void): void {
  try {
    cleanup();
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[ViewportResourceOwner] cleanup failed", error);
    }
  }
}
