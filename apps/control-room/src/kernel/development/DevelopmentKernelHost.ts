import type { KernelApi } from "../types";
import { isApiInstanceId } from "../api/apiInstancePin";
import { PLATFORM_DEVELOPMENT_BACKEND_PATH } from "../api/apiPaths";
import { sharedResourceRuntimeStore } from "../resources/ResourceRuntimeStore";
import { resourceRuntimeKeyForClientScope } from "../resources/resourceClientScope";
import { createDevelopmentKernelOwners } from "./DevelopmentKernelOwners";

export interface DevelopmentKernelFactoryOptions {
  readonly expectedApiInstance?: string;
  readonly baseUrl?: string;
}

export interface DevelopmentKernelHostSnapshot {
  readonly kernel: KernelApi;
  readonly generation: number;
  readonly paused: boolean;
  readonly publicationError: string | null;
}

/** Imperative owner of mounted kernel generations; never contains model/draft copies. */
export class DevelopmentKernelHost {
  private snapshot: DevelopmentKernelHostSnapshot;
  private readonly listeners = new Set<() => void>();
  private prepared: KernelApi | null = null;
  private preparedCommandRelease: (() => void) | null = null;
  private replacementReleases: Array<() => void> = [];
  private publication: { previous: KernelApi; replacement: KernelApi; failed: boolean; resolve(): void; reject(error: unknown): void } | null = null;
  private resumeRevision = 0;
  private readonly factory: (options: DevelopmentKernelFactoryOptions, host: DevelopmentKernelHost) => KernelApi;

  constructor(factory: (options: DevelopmentKernelFactoryOptions, host: DevelopmentKernelHost) => KernelApi) {
    this.factory = factory;
    this.snapshot = { kernel: factory({}, this), generation: 0, paused: false, publicationError: null };
  }

  getSnapshot = (): DevelopmentKernelHostSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  createOwners(options: { applyPendingChanges: boolean; carryUnsavedDocument: boolean }) {
    const owner = this.snapshot.kernel;
    return createDevelopmentKernelOwners(owner, {
      ...options,
      pauseOldKernel: () => this.pause(owner),
      prepareReplacement: async (apiInstance) => {
        if (this.snapshot.kernel !== owner || !this.snapshot.paused || this.prepared || this.publication) {
          throw new Error("Kernel replacement custody is unavailable.");
        }
        if (!isApiInstanceId(apiInstance) || apiInstance === owner.api.getExpectedApiInstance()) {
          throw new Error("Replacement API pin is invalid.");
        }
        const replacement = this.factory({ expectedApiInstance: apiInstance, baseUrl: owner.api.getBaseUrl() }, this);
        this.preparedCommandRelease = replacement.commands.beginDevelopmentHandoffPause();
        this.prepared = replacement;
        return replacement;
      },
      publishReplacement: async (replacement) => {
        if (replacement !== this.prepared || this.snapshot.kernel !== owner || !this.snapshot.paused || this.publication) {
          throw new Error("Kernel publication does not belong to this handoff.");
        }
        const next = this.prepared;
        const transportRelease = next.api.beginDevelopmentHandoffTransportPause();
        const resourcesRelease = sharedResourceRuntimeStore.beginPauseMatching((key) =>
          resourceRuntimeKeyForClientScope(key, next.api.resourceCacheScope) === key,
        );
        this.replacementReleases = [transportRelease, resourcesRelease, this.preparedCommandRelease!];
        await new Promise<void>((resolve, reject) => {
          this.publication = { previous: owner, replacement: next, failed: false, resolve, reject };
          this.snapshot = { kernel: next, generation: this.snapshot.generation + 1, paused: true, publicationError: null };
          this.notify();
        });
      },
    });
  }

  /** Called by the provider's passive effect, after old connector cleanups. */
  confirmMounted(kernel: KernelApi, commitNavigation?: (previous: KernelApi, replacement: KernelApi) => void): void {
    const publication = this.publication;
    if (!publication || publication.failed || publication.replacement !== kernel || this.snapshot.kernel !== kernel) return;
    try { commitNavigation?.(publication.previous, kernel); }
    catch (error) {
      publication.failed = true;
      this.snapshot = { ...this.snapshot, publicationError: "Replacement navigation could not be committed. Workspace remains protected." };
      this.notify();
      publication.reject(error);
      return;
    }
    publication.previous.api.retireDevelopmentHandoffTransport();
    releaseAll(this.replacementReleases);
    this.replacementReleases = [];
    this.preparedCommandRelease = null;
    this.publication = null;
    this.prepared = null;
    this.snapshot = { ...this.snapshot, paused: false };
    this.notify();
    publication.resolve();
  }

  private pause(owner: KernelApi): () => void {
    if (this.snapshot.kernel !== owner || this.snapshot.paused || this.publication) throw new Error("Kernel is already protected.");
    const camera = owner.cameraRegistry.getSnapshot();
    const visualization = owner.visualizationSync.getSnapshot();
    if (camera.dirty || camera.syncInFlight || camera.error || visualization.error || visualization.pendingPatch || visualization.inflightPatch) {
      throw new Error("Wait for camera and visualization changes to finish before restarting.");
    }
    const releases: Array<() => void> = [];
    try {
      releases.push(owner.commands.beginDevelopmentHandoffPause());
      const scope = owner.api.resourceCacheScope;
      const developmentKey = `${scope}|${PLATFORM_DEVELOPMENT_BACKEND_PATH}`;
      releases.push(sharedResourceRuntimeStore.beginPauseMatching((key) =>
        key !== developmentKey && resourceRuntimeKeyForClientScope(key, scope) === key,
      ));
      releases.push(owner.api.beginDevelopmentHandoffTransportPause());
      owner.cameraRegistry.stop();
      owner.visualizationSync.stop();
      this.snapshot = { ...this.snapshot, paused: true };
      this.notify();
    } catch (error) {
      releaseAll(releases.reverse());
      this.refetchOwner(owner);
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseAll(releases.reverse());
      if (this.snapshot.kernel === owner && !this.publication) {
        this.preparedCommandRelease?.();
        this.preparedCommandRelease = null;
        this.prepared = null;
        this.snapshot = { ...this.snapshot, paused: false };
        this.notify();
        this.refetchOwner(owner);
      }
    };
  }

  private refetchOwner(owner: KernelApi): void {
    owner.resources.invalidateMatching(() => true, `development:resume:${++this.resumeRevision}`);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* Observers cannot change kernel custody. */ }
    }
  }
}

function releaseAll(releases: Array<() => void>): void {
  const errors: unknown[] = [];
  for (const release of releases) {
    try { release(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Kernel pause cleanup is unconfirmed.");
}
