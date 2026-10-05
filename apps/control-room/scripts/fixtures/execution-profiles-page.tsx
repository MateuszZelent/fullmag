"use client";

import { useSyncExternalStore } from "react";

import { API_INSTANCE_HEADER } from "@/kernel/api/apiInstancePin";
import {
  API_CONTRACT_VERSION_HEADER,
  EXPECTED_API_CONTRACT_VERSION,
  PLATFORM_COMPUTE_PROFILES_PATH,
  PLATFORM_HEALTH_PATH,
  SESSIONS_PATH,
} from "@/kernel/api/apiPaths";
import type {
  ExecutionProfile,
  ExecutionProfileCatalogResource,
  ExecutionProfileVersionResource,
  PublishExecutionProfileRequest,
} from "@/kernel/api/apiTypes";
import { KernelProvider } from "@/kernel/KernelProvider";
import { ExecutionProfilesSettings } from "@/modules/start/sections/ExecutionProfilesSettings";

const API_INSTANCE = "11111111-1111-4111-8111-111111111111";
const ADVANCED_PROFILE: ExecutionProfile = {
  schema_version: "execution_profile.v1",
  profile_id: "exec:advanced-fixture",
  version: "1",
  description: "Advanced resource settings retained by the editor",
  defaults: {
    device: "gpu",
    resources: {
      target: { kind: "local" },
      cpu: {
        threads: 8,
        core_policy: "physical_first",
        affinity: "numa",
        numa_node: 0,
        native_threads: "auto",
        blas_threads: 4,
      },
      gpu: {
        selector: "allow_list",
        device_uuids: ["GPU-fixture-uuid-1"],
        devices_per_task: 1,
        vram_per_device_bytes: 8589934592,
      },
      ram: { reservation_bytes: 17179869184 },
      scratch: { reservation_bytes: 2147483648 },
      parallelism: { kind: "single_process" },
      placement: "pinned",
    },
  },
};

type Fault = "conflict" | "lost_ack" | "unknown";
type FixturePost = { request: PublishExecutionProfileRequest; outcome: Fault | "success" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      [API_INSTANCE_HEADER]: API_INSTANCE,
      [API_CONTRACT_VERSION_HEADER]: EXPECTED_API_CONTRACT_VERSION,
    },
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Controlled HTTP behind the real ControlRoomApi and useResource hook. */
class ExecutionProfilesFixture {
  private readonly originalFetch = globalThis.fetch.bind(globalThis);
  private records: ExecutionProfileVersionResource[] = [];
  private revision = 0;
  private nextFault: Fault | null = null;
  private failedCatalogReads = 0;
  private readonly posts: FixturePost[] = [];
  private readonly requests: Array<{ method: string; path: string; query: string }> = [];
  private readonly publicationLookups: string[] = [];
  private readonly unexpected: string[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v2/")) return this.originalFetch(request);
    const path = url.pathname;
    this.requests.push({ method: request.method, path, query: url.search });
    const pin = request.headers.get(API_INSTANCE_HEADER);
    if (pin !== API_INSTANCE) return this.unexpectedRequest(request, path, url.search);

    if (request.method === "GET" && path === SESSIONS_PATH) {
      return jsonResponse({ schema_version: "fullmag.session-list.v1", sessions: [] });
    }
    if (request.method === "GET" && path === PLATFORM_HEALTH_PATH) {
      return jsonResponse({ active_session: false, api_contract_version: EXPECTED_API_CONTRACT_VERSION, status: "ok", uptime_seconds: 1 });
    }
    if (path === PLATFORM_COMPUTE_PROFILES_PATH && request.method === "GET") {
      const intent = url.searchParams.get("client_intent_id");
      if (intent) this.publicationLookups.push(intent);
      if (this.failedCatalogReads > 0) {
        this.failedCatalogReads -= 1;
        return jsonResponse({ code: "execution_profile_store_unavailable", message: "Fixture catalogue is temporarily unavailable." }, 503);
      }
      return jsonResponse(this.catalogPage(url));
    }
    if (path === PLATFORM_COMPUTE_PROFILES_PATH && request.method === "POST") {
      const body = await request.json() as PublishExecutionProfileRequest;
      const requestCopy = clone(body);
      const fault = this.nextFault;
      this.nextFault = null;
      this.posts.push({ request: requestCopy, outcome: fault ?? "success" });
      if (fault === "conflict") {
        this.revision += 1;
        return jsonResponse({ code: "execution_profile_revision_conflict", message: "Profile catalogue changed. Refresh before publishing." }, 409);
      }
      if (fault === "unknown") throw new TypeError("Fixture publication acknowledgement was lost before commit.");

      const published = this.publish(requestCopy);
      if (published instanceof Response) return published;
      if (fault === "lost_ack") throw new TypeError("Fixture publication acknowledgement was lost after commit.");
      return jsonResponse(published, 201);
    }
    return this.unexpectedRequest(request, path, url.search);
  };

  armNextFault(fault: Fault): void {
    this.nextFault = fault;
  }

  failNextCatalogReads(count = 8): void {
    this.failedCatalogReads = count;
  }

  restoreCatalog(): void {
    this.failedCatalogReads = 0;
  }

  seedAdvancedProfile(): void {
    if (this.records.some((record) => record.profile.profile_id === ADVANCED_PROFILE.profile_id)) return;
    this.revision += 1;
    this.records.push(this.versionResource(ADVANCED_PROFILE, "fixture-seed-advanced", this.revision));
  }

  read() {
    return {
      fixture_only: true,
      api_instance: API_INSTANCE,
      revision: this.revision,
      records: clone(this.records),
      posts: clone(this.posts),
      publication_lookups: [...this.publicationLookups],
      requests: clone(this.requests),
      unexpected: [...this.unexpected],
    };
  }

  private catalogPage(url: URL): ExecutionProfileCatalogResource {
    const params = url.searchParams;
    let records = this.records;
    const profileId = params.get("profile_id");
    const version = params.get("version");
    const intent = params.get("client_intent_id");
    if (profileId) records = records.filter(({ profile }) => profile.profile_id === profileId);
    if (version) records = records.filter(({ profile }) => profile.version === version);
    if (intent) records = records.filter((record) => record.client_intent_id === intent);
    const offset = Number(params.get("offset") ?? 0);
    const limit = Number(params.get("limit") ?? 50);
    const entries = records.slice(offset, offset + limit);
    const next = offset + entries.length;
    return {
      schema_version: "execution_profile_catalog.v1",
      revision: this.revision,
      total: records.length,
      offset,
      next_offset: next < records.length ? next : null,
      entries: clone(entries),
    };
  }

  private publish(request: PublishExecutionProfileRequest) {
    const existingIntent = this.records.find((record) => record.client_intent_id === request.client_intent_id);
    if (existingIntent) return { disposition: "existing", revision: this.revision, entry: clone(existingIntent) };
    if (request.expected_revision !== this.revision) {
      return jsonResponse({ code: "execution_profile_revision_conflict", message: "Profile catalogue changed. Refresh before publishing." }, 409);
    }
    if (this.records.some(({ profile }) => profile.profile_id === request.profile.profile_id && profile.version === request.profile.version)) {
      return jsonResponse({ code: "execution_profile_version_conflict", message: "This profile version is immutable. Publish a new version." }, 409);
    }
    this.revision += 1;
    const profile: ExecutionProfile = {
      ...request.profile,
      description: request.profile.description ?? "",
      defaults: request.profile.defaults ?? {},
    };
    const entry = this.versionResource(profile, request.client_intent_id, this.revision);
    this.records.push(entry);
    return { disposition: "published", revision: this.revision, entry: clone(entry) };
  }

  private versionResource(profile: ExecutionProfile, intent: string, revision: number): ExecutionProfileVersionResource {
    return {
      profile: clone(profile),
      profile_sha256: "a".repeat(64),
      client_intent_id: intent,
      published_at: "2026-10-05T12:00:00Z",
      revision,
    };
  }

  private unexpectedRequest(request: Request, path: string, query: string): Response {
    this.unexpected.push(`${request.method} ${path}${query}`);
    return jsonResponse({ code: "fixture_unexpected_request", message: "Unexpected execution-profiles fixture request." }, 404);
  }
}

declare global {
  interface Window { __executionProfilesFixture?: ExecutionProfilesFixture }
}

/** Install controlled fetch before KernelProvider constructs its API client. */
class FixtureBootstrap {
  private ready = false;
  private readonly listeners = new Set<() => void>();
  private restoreFetch: (() => void) | null = null;

  readonly getSnapshot = () => this.ready;
  readonly getServerSnapshot = () => false;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.ready) {
      const original = globalThis.fetch;
      const fixture = window.__executionProfilesFixture ??= new ExecutionProfilesFixture();
      globalThis.fetch = fixture.fetch;
      this.restoreFetch = () => { if (globalThis.fetch === fixture.fetch) globalThis.fetch = original; };
      this.ready = true;
      for (const notify of this.listeners) notify();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.restoreFetch?.();
        this.restoreFetch = null;
        this.ready = false;
      }
    };
  };
}

const bootstrap = new FixtureBootstrap();

export default function ExecutionProfilesFixturePage() {
  const ready = useSyncExternalStore(bootstrap.subscribe, bootstrap.getSnapshot, bootstrap.getServerSnapshot);
  return ready ? <KernelProvider><main className="p-6" data-execution-profiles-fixture="true">
    <p className="sr-only">Controlled HTTP fixture; no solver or runtime is started.</p>
    <ExecutionProfilesSettings />
  </main></KernelProvider> : <p>Initializing controlled browser fixture.</p>;
}
