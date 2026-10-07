"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { API_INSTANCE_HEADER, isApiInstanceId } from "@/kernel/api/apiInstancePin";
import { PLATFORM_DEVELOPMENT_BACKEND_PATH } from "@/kernel/api/apiPaths";
import type {
  DevelopmentBackendResource,
  LiveStatusResource,
  ProjectDocumentResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { sceneDocumentPayload } from "@/kernel/authoring/sceneDocumentPayload";
import { KernelProvider } from "@/kernel/KernelProvider";
import { createProjectAuthoringSessionBinding } from "@/kernel/persistence/ProjectAuthoringSessionBinding";
import type { ProjectDocumentSnapshot } from "@/kernel/persistence/ProjectDocumentController";
import { useProjectDocumentSnapshot } from "@/kernel/persistence/ProjectDocumentStatus";
import { useDevelopmentBackendResource } from "@/kernel/resources/developmentBackendResource";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  sessionResourceIdentitiesEqual,
  sessionResourceIdentityFromStatus,
  type SessionResourceIdentity,
} from "@/kernel/resources/sessionResourceIdentity";
import { WorkspaceShell } from "@/kernel/layout/WorkspaceShell";
import { useKernel } from "@/kernel/KernelContext";

const READY_SCHEMA = "fullmag.development-browser-native-ready.v1";
const BEFORE_SCHEMA = "fullmag.development-browser-before.v1";
const FINISH_SCHEMA = "fullmag.development-browser-finish.v1";
const PRIVATE_PROBE_PATH = "/native-browser-probe";

interface EligibilityProof {
  readonly schema: typeof READY_SCHEMA;
  readonly api_instance_id: string;
  readonly worktree_id: string;
  readonly generation_id: string;
  readonly ready_build_id: string;
  readonly ready_source_sha256: string;
  readonly ui_origin: string;
  readonly nonce: string;
  readonly observed_at_unix_ms: number;
  readonly valid_until_unix_ms: number;
}

interface SceneSummary {
  readonly scene_id: string | null;
  readonly scene_name: string | null;
  readonly revision: number | null;
  readonly object_count: number;
  readonly region_count: number;
  readonly material_count: number;
  readonly objects: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly has_geometry: boolean;
    readonly material_ref: string | null;
    readonly regions: readonly { readonly id: string | null; readonly name: string }[];
  }[];
  readonly materials: readonly { readonly id: string; readonly name: string }[];
}

interface ProjectDocumentProof {
  readonly schema: "fullmag.native-workspace-project-document.v1";
  readonly project_id: string;
  readonly name: string;
  readonly file_name: string;
  readonly revision: number;
  readonly dirty: true;
  readonly archive_base64_sha256: string;
  readonly scene_resource_sha256: string;
  readonly scene_document_sha256: string;
  readonly scene_object_count: number;
  readonly scene_region_count: number;
  readonly scene_material_count: number;
}

interface PreparedDraft {
  readonly api_instance_id: string;
  readonly generation: number;
  readonly session_id: string;
  /** Backend transition counter; distinct from the session resource epoch below. */
  readonly session_epoch: number;
  /** Composite resource identity from LiveStatus.session.session_epoch. */
  readonly session_resource_epoch: string;
  readonly request_scope_epoch: string;
  readonly ready_build_id: string;
  readonly ready_source_sha256: string;
  readonly project_document: ProjectDocumentProof;
  readonly scene_summary: SceneSummary;
}

interface BrowserBaseline extends PreparedDraft {
  readonly nonce: string;
}

type FixtureOperation = "idle" | "preparing" | "finishing";
type ProofState = "waiting" | "eligible" | "unavailable" | "scope-mismatch";

interface FixtureSnapshot {
  readonly proof: EligibilityProof | null;
  readonly proofState: ProofState;
  readonly proofMessage: string;
  readonly operation: FixtureOperation;
  readonly message: string | null;
  readonly preparedDraft: PreparedDraft | null;
  readonly baseline: BrowserBaseline | null;
  readonly beforeAttempted: boolean;
  readonly finishAttempted: boolean;
  readonly finished: boolean;
  readonly finishResponse: unknown | null;
}

const INITIAL_FIXTURE_SNAPSHOT: FixtureSnapshot = {
  proof: null,
  proofState: "waiting",
  proofMessage: "Waiting for the real backend status and private eligibility proof.",
  operation: "idle",
  message: null,
  preparedDraft: null,
  baseline: null,
  beforeAttempted: false,
  finishAttempted: false,
  finished: false,
  finishResponse: null,
};

interface ViewportProof {
  readonly visible: boolean;
  readonly context_lost: boolean | null;
  readonly drawing_buffer_width: number;
  readonly drawing_buffer_height: number;
  readonly ready: boolean;
}

declare global {
  interface Window {
    __nativeWorkspaceRestartFixture?: NativeWorkspaceRestartFixture;
  }
}

class NativeWorkspaceRestartFixture {
  private readonly originalFetch: typeof fetch;
  private snapshot: FixtureSnapshot = INITIAL_FIXTURE_SNAPSHOT;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.originalFetch = globalThis.fetch.bind(globalThis);
  }

  readonly getSnapshot = (): FixtureSnapshot => this.snapshot;
  readonly getServerSnapshot = (): FixtureSnapshot => INITIAL_FIXTURE_SNAPSHOT;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly fetch: typeof fetch = async (input, init) => {
    const target = requestTarget(input, init);
    if (target === null
      || target.origin !== window.location.origin
      || target.pathname !== PLATFORM_DEVELOPMENT_BACKEND_PATH
      || target.method !== "GET") {
      return this.originalFetch(input, init);
    }

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    // The private bridge returns a no-store proof. Conditional status requests
    // must reach the real API without a 304 that could reuse a stale candidate.
    headers.delete("If-None-Match");
    headers.delete("If-Modified-Since");
    const request = new Request(input, { ...init, cache: "no-store", headers });
    const response = await this.originalFetch(request);
    if (response.status !== 200) return response;
    const responsePin = response.headers.get(API_INSTANCE_HEADER);
    const baseline = this.snapshot.baseline;
    if (baseline !== null && responsePin !== null && responsePin.length > 0
      && responsePin !== baseline.api_instance_id) {
      return response;
    }

    try {
      const backend: unknown = await response.clone().json();
      const proof = await this.readEligibility();
      const rejection = eligibilityRejection(backend, responsePin, proof);
      if (rejection !== null) {
        this.setProofUnavailable(rejection);
        return response;
      }

      this.acceptProof(proof);
      const body = JSON.stringify({
        ...(backend as DevelopmentBackendResource),
        restart_available: true,
      });
      const overlayHeaders = new Headers(response.headers);
      for (const name of ["content-encoding", "content-length", "etag", "last-modified", "transfer-encoding"]) {
        overlayHeaders.delete(name);
      }
      overlayHeaders.set("Cache-Control", "no-store");
      overlayHeaders.set("Pragma", "no-cache");
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: overlayHeaders,
      });
    } catch (error) {
      this.setProofUnavailable(errorMessage(error));
      return response;
    }
  };

  begin(operation: Exclude<FixtureOperation, "idle">): void {
    this.patch({ operation, message: null });
  }

  failOperation(message: string): void {
    this.patch({ operation: "idle", message });
  }

  setPreparedDraft(preparedDraft: PreparedDraft): void {
    this.patch({ preparedDraft });
  }

  claimBeforeCapture(): void {
    if (this.snapshot.beforeAttempted) {
      throw new Error("The before-capture response is unknown; do not submit it a second time in this run.");
    }
    this.patch({ beforeAttempted: true });
  }

  completeBeforeCapture(baseline: BrowserBaseline): void {
    this.patch({
      baseline,
      operation: "idle",
      message: "The real scene and dirty project draft were captured before restart.",
    });
  }

  claimFinish(): void {
    if (this.snapshot.finishAttempted) {
      throw new Error("The finish response is unknown; do not submit it a second time in this run.");
    }
    this.patch({ finishAttempted: true });
  }

  completeFinish(response: unknown): void {
    this.patch({
      finished: true,
      operation: "idle",
      message: "The browser verified the new API, scene, viewport, and restored dirty draft.",
      finishResponse: response,
    });
  }

  async readEligibility(): Promise<EligibilityProof> {
    const response = await this.originalFetch(new Request(
      new URL(PRIVATE_PROBE_PATH + "/eligibility", window.location.origin),
      { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" } },
    ));
    if (response.status !== 200) {
      const detail = await boundedResponseText(response);
      throw new Error("Private eligibility is unavailable: " + detail);
    }
    const payload: unknown = await response.json();
    const proof = validateEligibilityProof(payload, window.location.origin, Date.now());
    const existing = this.snapshot.proof;
    if (existing !== null && !sameProofScope(existing, proof)) {
      this.patch({
        proofState: "scope-mismatch",
        proofMessage: "The private readiness tuple changed during this browser run.",
      });
      throw new Error("Private readiness tuple changed during this browser run.");
    }
    return proof;
  }

  async postPrivate(operation: "before" | "finish", body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.originalFetch(new Request(
      new URL(PRIVATE_PROBE_PATH + "/" + operation, window.location.origin),
      {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ));
    const text = await boundedResponseText(response);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("The private browser proof returned invalid JSON.");
    }
    if (!response.ok || !isRecord(payload)) {
      const detail = isRecord(payload) && typeof payload.error === "string" ? payload.error : text;
      throw new Error("The private browser proof was not confirmed: " + detail);
    }
    return payload;
  }

  private acceptProof(proof: EligibilityProof): void {
    const existing = this.snapshot.proof;
    if (existing !== null && !sameProofScope(existing, proof)) {
      this.patch({
        proofState: "scope-mismatch",
        proofMessage: "The private readiness tuple changed during this browser run.",
      });
      throw new Error("Private readiness tuple changed during this browser run.");
    }
    this.patch({
      proof,
      proofState: "eligible",
      proofMessage: "Private readiness matches the real pinned API and verified ready build.",
    });
  }

  private setProofUnavailable(message: string): void {
    if (this.snapshot.proofState === "scope-mismatch") return;
    const detail = this.snapshot.baseline === null
      ? message
      : "Private eligibility is no longer active; the real backend status is passed through. " + message;
    this.patch({ proofState: "unavailable", proofMessage: detail.slice(0, 500) });
  }

  private patch(patch: Partial<FixtureSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function requestTarget(input: RequestInfo | URL, init?: RequestInit): { origin: string; pathname: string; method: string } | null {
  try {
    const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const url = new URL(rawUrl, window.location.href);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    return { origin: url.origin, pathname: url.pathname, method };
  } catch {
    return null;
  }
}

function validateEligibilityProof(value: unknown, uiOrigin: string, nowMs: number): EligibilityProof {
  const fields = [
    "schema", "api_instance_id", "worktree_id", "generation_id", "ready_build_id",
    "ready_source_sha256", "ui_origin", "nonce", "observed_at_unix_ms", "valid_until_unix_ms",
  ];
  if (!isRecord(value) || !sameStringSet(Object.keys(value), fields)
    || value.schema !== READY_SCHEMA
    || typeof value.api_instance_id !== "string" || !isApiInstanceId(value.api_instance_id)
    || typeof value.worktree_id !== "string" || value.worktree_id.trim() !== value.worktree_id
    || value.worktree_id.length === 0 || value.worktree_id.length > 256
    || typeof value.generation_id !== "string" || !/^[0-9a-f]{32}$/.test(value.generation_id)
    || typeof value.ready_build_id !== "string" || !/^[0-9a-f]{64}$/.test(value.ready_build_id)
    || typeof value.ready_source_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.ready_source_sha256)
    || typeof value.ui_origin !== "string" || value.ui_origin !== uiOrigin
    || typeof value.nonce !== "string" || !isCanonicalUuid(value.nonce)
    || typeof value.observed_at_unix_ms !== "number" || !Number.isSafeInteger(value.observed_at_unix_ms)
    || typeof value.valid_until_unix_ms !== "number" || !Number.isSafeInteger(value.valid_until_unix_ms)
    || value.valid_until_unix_ms <= value.observed_at_unix_ms
    || value.valid_until_unix_ms - value.observed_at_unix_ms > 1000
    || nowMs < value.observed_at_unix_ms || nowMs >= value.valid_until_unix_ms) {
    throw new Error("Private readiness proof is malformed, mismatched, or expired.");
  }
  return value as unknown as EligibilityProof;
}

function eligibilityRejection(
  value: unknown,
  responsePin: string | null,
  proof: EligibilityProof,
  expectsPrivateOverlay = false,
): string | null {
  if (!isRecord(value)
    || value.configured !== true
    || value.state !== "ready"
    || value.restart_available !== expectsPrivateOverlay
    || responsePin !== proof.api_instance_id) {
    return "The real backend response is not a pinned ready build.";
  }
  const current = value.current_build;
  const ready = value.ready_build;
  const identity = value.workspace_identity;
  if (!isBuildIdentity(current) || !isBuildIdentity(ready)
    || current.source_sha256 === ready.source_sha256
    || ready.id !== proof.ready_build_id
    || ready.source_sha256 !== proof.ready_source_sha256
    || !isRecord(identity)
    || identity.api_instance_id !== proof.api_instance_id
    || typeof identity.session_id !== "string" && identity.session_id !== null
    || typeof identity.session_epoch !== "number" || !Number.isSafeInteger(identity.session_epoch)
    || identity.session_epoch < 0) {
    return "The real backend identity does not match the private ready tuple.";
  }
  return null;
}

function isBuildIdentity(value: unknown): value is { id: string; source_sha256: string } {
  return isRecord(value)
    && typeof value.id === "string" && value.id.trim().length > 0
    && typeof value.source_sha256 === "string" && /^[0-9a-f]{64}$/.test(value.source_sha256);
}

function sameProofScope(left: EligibilityProof, right: EligibilityProof): boolean {
  return left.schema === right.schema
    && left.api_instance_id === right.api_instance_id
    && left.worktree_id === right.worktree_id
    && left.generation_id === right.generation_id
    && left.ready_build_id === right.ready_build_id
    && left.ready_source_sha256 === right.ready_source_sha256
    && left.ui_origin === right.ui_origin
    && left.nonce === right.nonce;
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
    && value !== "00000000-0000-0000-0000-000000000000";
}

function sameStringSet(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && expected.every((field) => actual.includes(field));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) result[key] = sortJson(value[key]);
  return result;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function summarizeScene(scene: SceneResource): SceneSummary {
  const objects = scene.objects ?? [];
  const materials = scene.materials ?? [];
  const regions = objects.flatMap((object) => object.regions ?? []);
  return {
    scene_id: scene.scene?.id ?? null,
    scene_name: scene.scene?.name ?? null,
    revision: scene.scene_revision ?? scene.revision ?? null,
    object_count: objects.length,
    region_count: regions.length,
    material_count: materials.length,
    objects: objects.map((object) => ({
      id: object.id,
      name: object.name ?? null,
      has_geometry: object.geometry != null || object.object_mesh != null,
      material_ref: typeof object.material_ref === "string" ? object.material_ref : null,
      regions: (object.regions ?? []).map((region) => ({
        id: region.region_id ?? null,
        name: region.name,
      })),
    })),
    materials: materials.map((material) => ({ id: material.id, name: material.name })),
  };
}

function assertUsefulScene(scene: SceneResource): SceneSummary {
  const summary = summarizeScene(scene);
  if (summary.object_count === 0 || summary.region_count === 0 || summary.material_count === 0) {
    throw new Error("First add a real object with a region and material in the workspace, then prepare the draft.");
  }
  if (!summary.objects.some((object) => object.has_geometry)) {
    throw new Error("The current scene has no authored geometry. Add geometry in the workspace before preparing the draft.");
  }
  const materialIds = new Set(summary.materials.map((material) => material.id));
  if (!summary.objects.some((object) => object.has_geometry
    && object.regions.length > 0
    && object.material_ref !== null
    && materialIds.has(object.material_ref))) {
    throw new Error("Add a region and an assigned existing material to the same authored object before preparing the draft.");
  }
  return summary;
}

async function projectDocumentProof(
  snapshot: ProjectDocumentSnapshot,
  scene: SceneResource,
): Promise<ProjectDocumentProof> {
  if (snapshot.state !== "ready") throw new Error("The workspace project document is not ready.");
  const resource: ProjectDocumentResource = snapshot.resource;
  if (resource.dirty !== true || !resource.project_id || !resource.archive_base64
    || !Number.isSafeInteger(resource.revision)) {
    throw new Error("The project document is not a nonempty dirty draft.");
  }
  const summary = summarizeScene(scene);
  return {
    schema: "fullmag.native-workspace-project-document.v1",
    project_id: resource.project_id,
    name: resource.name,
    file_name: snapshot.fileName,
    revision: resource.revision,
    dirty: true,
    archive_base64_sha256: await sha256Text(resource.archive_base64),
    scene_resource_sha256: await sha256Text(canonicalJson(scene)),
    scene_document_sha256: await sha256Text(canonicalJson(sceneDocumentPayload(scene))),
    scene_object_count: summary.object_count,
    scene_region_count: summary.region_count,
    scene_material_count: summary.material_count,
  };
}

function assertEligibleCandidate(
  backend: DevelopmentBackendResource,
  proof: EligibilityProof,
  pin: string | null,
  session: SessionResourceIdentity,
): number {
  const rejection = eligibilityRejection(backend, proof.api_instance_id, proof, true);
  if (rejection !== null || pin !== proof.api_instance_id) {
    throw new Error(rejection ?? "The mounted API pin differs from private readiness.");
  }
  const identity = backend.workspace_identity;
  if (!identity || identity.api_instance_id !== pin || identity.session_id !== session.sessionId
    || !Number.isSafeInteger(identity.session_epoch) || identity.session_epoch < 0) {
    throw new Error("The real session identity changed before draft preparation.");
  }
  return identity.session_epoch;
}

function assertSessionResourceIdentity(
  status: LiveStatusResource,
  expected: SessionResourceIdentity,
): void {
  const actual = sessionResourceIdentityFromStatus(status);
  if (!actual || !sessionResourceIdentitiesEqual(actual, expected)) {
    throw new Error("The confirmed session resource scope changed during the browser proof.");
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length > 128 * 1024) throw new Error("The private proof response exceeded its size limit.");
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readViewportProof(): ViewportProof {
  let sawVisibleCanvas = false;
  let last: ViewportProof = {
    visible: false,
    context_lost: null,
    drawing_buffer_width: 0,
    drawing_buffer_height: 0,
    ready: false,
  };
  const containers = document.querySelectorAll<HTMLElement>("[data-viewport-bounds]");
  for (const container of containers) {
    for (const canvas of container.querySelectorAll("canvas")) {
      const rect = canvas.getBoundingClientRect();
      const style = getComputedStyle(canvas);
      const visible = rect.width > 0 && rect.height > 0
        && style.display !== "none" && style.visibility !== "hidden"
        && Number(style.opacity || "1") > 0;
      if (!visible) continue;
      sawVisibleCanvas = true;
      const context = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as
        WebGLRenderingContext | WebGL2RenderingContext | null;
      if (!context) {
        last = { visible: true, context_lost: null, drawing_buffer_width: 0, drawing_buffer_height: 0, ready: false };
        continue;
      }
      const contextLost = context.isContextLost();
      const width = context.drawingBufferWidth;
      const height = context.drawingBufferHeight;
      last = {
        visible: true,
        context_lost: contextLost,
        drawing_buffer_width: width,
        drawing_buffer_height: height,
        ready: !contextLost && width > 0 && height > 0,
      };
      if (last.ready) return last;
    }
  }
  return sawVisibleCanvas ? last : {
    visible: false,
    context_lost: null,
    drawing_buffer_width: 0,
    drawing_buffer_height: 0,
    ready: false,
  };
}

function useViewportProof(): ViewportProof {
  const [snapshot, setSnapshot] = useState<ViewportProof>({
    visible: false,
    context_lost: null,
    drawing_buffer_width: 0,
    drawing_buffer_height: 0,
    ready: false,
  });
  useEffect(() => {
    const refresh = () => {
      const next = readViewportProof();
      setSnapshot((current) => canonicalJson(current) === canonicalJson(next) ? current : next);
    };
    refresh();
    const timer = window.setInterval(refresh, 500);
    window.addEventListener("resize", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", refresh);
    };
  }, []);
  return snapshot;
}

function getFixture(): NativeWorkspaceRestartFixture {
  return window.__nativeWorkspaceRestartFixture ??= new NativeWorkspaceRestartFixture();
}

/** Install the private status overlay before KernelProvider creates API consumers. */
class FixtureBootstrap {
  private ready = false;
  private readonly listeners = new Set<() => void>();
  private restoreFetch: (() => void) | null = null;

  readonly getSnapshot = (): boolean => this.ready;
  readonly getServerSnapshot = (): boolean => false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.ready) {
      const original = globalThis.fetch;
      const fixture = getFixture();
      globalThis.fetch = fixture.fetch;
      this.restoreFetch = () => {
        if (globalThis.fetch === fixture.fetch) globalThis.fetch = original;
      };
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

function NativeWorkspaceRestartFixtureBody() {
  const fixture = getFixture();
  const fixtureSnapshot = useSyncExternalStore(
    fixture.subscribe,
    fixture.getSnapshot,
    fixture.getServerSnapshot,
  );
  const kernel = useKernel();
  const host = kernel.developmentWorkspace!;
  const hostSnapshot = useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
  const backend = useDevelopmentBackendResource();
  const sceneResource = useSceneResource();
  const sessionIdentity = useSessionResourceIdentity();
  const projectSnapshot = useProjectDocumentSnapshot();
  const viewport = useViewportProof();
  const [documentPreviewState, setDocumentPreviewState] = useState<{
    readonly projectSnapshot: ProjectDocumentSnapshot;
    readonly scene: SceneResource;
    readonly proof: ProjectDocumentProof;
  } | null>(null);

  useEffect(() => {
    let current = true;
    if (projectSnapshot.state !== "ready" || !sceneResource.data) {
      return () => { current = false; };
    }
    void projectDocumentProof(projectSnapshot, sceneResource.data).then(
      (proof) => {
        if (current) setDocumentPreviewState({ projectSnapshot, scene: sceneResource.data!, proof });
      },
      () => { if (current) setDocumentPreviewState(null); },
    );
    return () => { current = false; };
  }, [projectSnapshot, sceneResource.data]);

  const documentPreview = documentPreviewState?.projectSnapshot === projectSnapshot
    && documentPreviewState.scene === sceneResource.data
    ? documentPreviewState.proof
    : null;
  const baseline = fixtureSnapshot.baseline;
  const currentPin = kernel.api.getExpectedApiInstance();
  const visibleScene = sceneResource.data ? summarizeScene(sceneResource.data) : null;
  const currentProofMatches = baseline !== null
    && documentPreview !== null
    && canonicalJson(documentPreview) === canonicalJson(baseline.project_document);
  const currentIdentityMatches = baseline !== null
    && currentPin !== null && currentPin !== baseline.api_instance_id
    && hostSnapshot.kernel === kernel
    && hostSnapshot.generation === baseline.generation + 1
    && !hostSnapshot.paused && hostSnapshot.publicationError === null
    && sessionIdentity !== null
    && sessionIdentity.sessionId !== baseline.session_id
    && sessionIdentity.sessionEpoch !== baseline.session_resource_epoch;
  const currentBackendMatches = baseline !== null
    && backend.status === "ready" && backend.data !== null
    && backend.data.workspace_identity?.api_instance_id === currentPin
    && backend.data.workspace_identity?.session_id === sessionIdentity?.sessionId
    && backend.data.workspace_identity?.session_epoch === 1
    && backend.data.current_build?.source_sha256 === baseline.ready_source_sha256
    && backend.data.restart_available === false;
  const canFinish = baseline !== null
    && currentProofMatches && currentIdentityMatches && currentBackendMatches
    && viewport.ready && !fixtureSnapshot.finishAttempted
    && fixtureSnapshot.operation === "idle" && !fixtureSnapshot.finished;

  const setupDraft = async () => {
    fixture.begin("preparing");
    try {
      const initialHost = host.getSnapshot();
      const pin = kernel.api.getExpectedApiInstance();
      if (initialHost.kernel !== kernel || initialHost.paused || initialHost.publicationError || !pin) {
        throw new Error("Wait until the real workspace is mounted and ready.");
      }
      if (fixture.getSnapshot().baseline !== null || fixture.getSnapshot().beforeAttempted) {
        throw new Error("The before-capture has already been attempted in this run.");
      }
      if (!sessionIdentity || !kernel.projectDocument) {
        throw new Error("The workspace needs a confirmed live session and project-document owner.");
      }
      const sceneBefore = await kernel.api.model.scene();
      assertUsefulScene(sceneBefore);
      const [backendBefore, eligibilityBefore, sessionStatusBefore] = await Promise.all([
        kernel.api.platform.developmentBackend(),
        fixture.readEligibility(),
        kernel.api.sessions.current.status(),
      ]);
      assertSessionResourceIdentity(sessionStatusBefore, sessionIdentity);
      const sessionEpoch = assertEligibleCandidate(
        backendBefore,
        eligibilityBefore,
        pin,
        sessionIdentity,
      );

      let prepared = fixture.getSnapshot().preparedDraft;
      if (prepared === null) {
        const existingProject = kernel.projectDocument.getSnapshot();
        if (existingProject.state === "empty") {
          await kernel.projectDocument.create("Native workspace restart draft");
        } else if (existingProject.state !== "ready") {
          throw new Error("Wait until the open project document finishes loading before preparing the draft.");
        }
        const currentProject = kernel.projectDocument.getSnapshot();
        if (currentProject.state !== "ready") {
          throw new Error("The workspace project document could not be prepared.");
        }
        const binding = createProjectAuthoringSessionBinding(
          kernel.api,
          currentProject.resource.project_id,
          sessionIdentity.sessionId,
        );
        kernel.projectDocument.bindAuthoringSession(binding);
        const sceneDocument = await binding.readSceneDocument();
        await kernel.projectDocument.synchronizeAuthoring(sceneDocument, binding.verifyCurrent);
        const sceneAfter = await kernel.api.model.scene();
        const projectDocument = await projectDocumentProof(kernel.projectDocument.getSnapshot(), sceneAfter);
        prepared = {
          api_instance_id: pin,
          generation: initialHost.generation,
          session_id: sessionIdentity.sessionId,
          session_epoch: sessionEpoch,
          session_resource_epoch: sessionIdentity.sessionEpoch,
          request_scope_epoch: sessionIdentity.requestScopeEpoch,
          ready_build_id: eligibilityBefore.ready_build_id,
          ready_source_sha256: eligibilityBefore.ready_source_sha256,
          project_document: projectDocument,
          scene_summary: assertUsefulScene(sceneAfter),
        };
        fixture.setPreparedDraft(prepared);
      } else {
        if (prepared.api_instance_id !== pin || prepared.generation !== initialHost.generation
          || prepared.session_id !== sessionIdentity.sessionId || prepared.session_epoch !== sessionEpoch
          || prepared.session_resource_epoch !== sessionIdentity.sessionEpoch
          || prepared.request_scope_epoch !== sessionIdentity.requestScopeEpoch
          || prepared.ready_build_id !== eligibilityBefore.ready_build_id
          || prepared.ready_source_sha256 !== eligibilityBefore.ready_source_sha256) {
          throw new Error("The prepared draft belongs to a different API, session, or ready build.");
        }
        const currentProject = await projectDocumentProof(kernel.projectDocument.getSnapshot(), sceneBefore);
        if (canonicalJson(currentProject) !== canonicalJson(prepared.project_document)) {
          throw new Error("The project draft or scene changed after preparation. Start a fresh proof run.");
        }
      }

      const latestHost = host.getSnapshot();
      if (latestHost.kernel !== kernel || latestHost.generation !== prepared.generation
        || latestHost.paused || latestHost.publicationError
        || kernel.api.getExpectedApiInstance() !== prepared.api_instance_id) {
        throw new Error("The workspace changed while the dirty draft was being prepared.");
      }
      const latestScene = await kernel.api.model.scene();
      const latestProject = await projectDocumentProof(kernel.projectDocument.getSnapshot(), latestScene);
      if (canonicalJson(latestProject) !== canonicalJson(prepared.project_document)) {
        throw new Error("The real scene or project document changed before the before-capture.");
      }
      const sceneHash = await sha256Text(canonicalJson(latestScene));
      const sceneHashFromDraft = prepared.project_document.scene_resource_sha256;
      if (sceneHash !== sceneHashFromDraft) {
        throw new Error("The canonical scene no longer matches the prepared dirty project draft.");
      }
      const [backendForCapture, freshProof, sessionStatusForCapture] = await Promise.all([
        kernel.api.platform.developmentBackend(),
        fixture.readEligibility(),
        kernel.api.sessions.current.status(),
      ]);
      assertSessionResourceIdentity(sessionStatusForCapture, {
        sessionId: prepared.session_id,
        sessionEpoch: prepared.session_resource_epoch,
        requestScopeEpoch: prepared.request_scope_epoch,
      });
      const sessionEpochForCapture = assertEligibleCandidate(
        backendForCapture,
        freshProof,
        prepared.api_instance_id,
        {
          sessionId: prepared.session_id,
          sessionEpoch: prepared.session_resource_epoch,
          requestScopeEpoch: prepared.request_scope_epoch,
        },
      );
      if (sessionEpochForCapture !== prepared.session_epoch) {
        throw new Error("The backend transition epoch changed before the before-capture.");
      }
      if (freshProof.ready_build_id !== prepared.ready_build_id
        || freshProof.ready_source_sha256 !== prepared.ready_source_sha256) {
        throw new Error("The verified ready build changed while the draft was being prepared.");
      }
      fixture.claimBeforeCapture();
      const captured = await fixture.postPrivate("before", {
        schema: BEFORE_SCHEMA,
        nonce: freshProof.nonce,
        api_instance_id: prepared.api_instance_id,
        project_document_before: prepared.project_document,
      });
      if (captured.captured !== true || captured.object_count !== prepared.project_document.scene_object_count) {
        throw new Error("The parent did not confirm capture of the same nonempty real scene.");
      }
      fixture.completeBeforeCapture({
        ...prepared,
        nonce: freshProof.nonce,
      });
    } catch (error) {
      fixture.failOperation(errorMessage(error));
    }
  };

  const finishProof = async () => {
    const captured = fixture.getSnapshot().baseline;
    fixture.begin("finishing");
    try {
      if (!captured) throw new Error("Prepare and capture the dirty project draft before restarting.");
      if (!currentIdentityMatches || !currentBackendMatches || !currentProofMatches || !viewport.ready) {
        throw new Error("Wait until the new pinned workspace, unchanged draft, and visible live viewport are ready.");
      }
      const newPin = kernel.api.getExpectedApiInstance();
      if (!newPin || newPin === captured.api_instance_id || !sessionIdentity) {
        throw new Error("The replacement API pin and session are not confirmed.");
      }
      const [backendAfter, sessionAfter, sceneAfter] = await Promise.all([
        kernel.api.platform.developmentBackend(),
        kernel.api.sessions.current.status(),
        kernel.api.model.scene(),
      ]);
      const latestHost = host.getSnapshot();
      assertSessionResourceIdentity(sessionAfter, sessionIdentity);
      if (latestHost.kernel !== kernel || latestHost.generation !== captured.generation + 1
        || latestHost.paused || latestHost.publicationError
        || kernel.api.getExpectedApiInstance() !== newPin
        || sessionAfter.session.session_id !== sessionIdentity.sessionId
        || sessionAfter.session.session_epoch !== sessionIdentity.sessionEpoch
        || sessionAfter.session.request_scope_epoch !== sessionIdentity.requestScopeEpoch
        || sessionAfter.session.session_id === captured.session_id
        || sessionAfter.session.session_epoch === captured.session_resource_epoch) {
        throw new Error("The replacement kernel or fresh session changed during final verification.");
      }
      const identityAfter = backendAfter.workspace_identity;
      if (!identityAfter
        || identityAfter.api_instance_id !== newPin
        || identityAfter.session_id !== sessionAfter.session.session_id
        || identityAfter.session_epoch !== 1
        || backendAfter.current_build?.source_sha256 !== captured.ready_source_sha256
        || backendAfter.restart_available !== false) {
        throw new Error("The real replacement API does not report the applied ready build and new workspace.");
      }
      const restoredDocument = await projectDocumentProof(kernel.projectDocument!.getSnapshot(), sceneAfter);
      if (canonicalJson(restoredDocument) !== canonicalJson(captured.project_document)) {
        throw new Error("The restored dirty project document differs from its captured before state.");
      }
      const sceneHash = await sha256Text(canonicalJson(sceneAfter));
      if (sceneHash !== captured.project_document.scene_resource_sha256) {
        throw new Error("The replacement API scene differs from the before-restart canonical scene.");
      }
      const viewportAfter = readViewportProof();
      if (!viewportAfter.ready) {
        throw new Error("The replacement workspace does not have a visible WebGL canvas with a live drawing buffer.");
      }
      fixture.claimFinish();
      const response = await fixture.postPrivate("finish", {
        schema: FINISH_SCHEMA,
        nonce: captured.nonce,
        new_api_instance_id: newPin,
        project_document_before: captured.project_document,
        project_document_after: restoredDocument,
      });
      if (response.verified !== true) throw new Error("The parent did not confirm the browser continuity proof.");
      fixture.completeFinish(response);
    } catch (error) {
      fixture.failOperation(errorMessage(error));
    }
  };

  const currentProjectDiagnostic = documentPreview ?? (projectSnapshot.state === "ready" ? {
    state: projectSnapshot.state,
    project_id: projectSnapshot.resource.project_id,
    revision: projectSnapshot.resource.revision,
    dirty: projectSnapshot.resource.dirty,
    archive_base64_bytes: projectSnapshot.resource.archive_base64.length,
  } : { state: projectSnapshot.state, error: projectSnapshot.error });

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-fm-background text-fm-primary">
      <section className="max-h-[35vh] shrink-0 overflow-auto border-b border-fm-border bg-fm-surface px-5 py-4" data-testid="native-workspace-restart-proof">
        <div className="mx-auto max-w-7xl">
          <p className="m-0 text-fm-xs font-semibold uppercase tracking-wide text-fm-muted">Private native restart check</p>
          <h1 className="mb-2 mt-1 text-fm-xl font-semibold">Keep the real workspace through a backend restart</h1>
          <p className="mb-3 max-w-4xl text-fm-sm text-fm-secondary">
            Use the workspace below to author a real object, region, and material. “Prepare draft” keeps an open project document,
            or creates one from the current session if none is open. Then use the normal backend restart action in the workspace
            banner. When the new workspace is ready, inspect the scene and viewport here and select “Finish proof”.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded border border-fm-border bg-fm-elevated px-3 py-2 text-fm-sm disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="native-workspace-setup-draft"
              disabled={fixtureSnapshot.operation !== "idle" || fixtureSnapshot.baseline !== null
                || fixtureSnapshot.beforeAttempted || fixtureSnapshot.proofState !== "eligible"
                || backend.status !== "ready" || backend.data?.restart_available !== true}
              onClick={() => { void setupDraft(); }}
            >
              Setup draft
            </button>
            <button
              type="button"
              className="rounded border border-fm-border bg-fm-elevated px-3 py-2 text-fm-sm disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="native-workspace-finish-proof"
              disabled={!canFinish}
              onClick={() => { void finishProof(); }}
            >
              Finish proof
            </button>
            <output data-testid="native-workspace-proof-progress" aria-live="polite" className="self-center text-fm-sm">
              {fixtureSnapshot.operation !== "idle" ? "Checking the workspace…" : fixtureSnapshot.message ?? fixtureSnapshot.proofMessage}
            </output>
          </div>
          <div className="mt-3 grid gap-2 text-fm-xs md:grid-cols-2">
            <output
              data-testid="native-workspace-eligibility"
              data-state={fixtureSnapshot.proofState}
              className="break-all rounded border border-fm-border p-2"
            >
              {JSON.stringify({
                proof_state: fixtureSnapshot.proofState,
                message: fixtureSnapshot.proofMessage,
                proof: fixtureSnapshot.proof,
                effective_status: backend.data ? {
                  configured: backend.data.configured,
                  state: backend.data.state,
                  restart_available: backend.data.restart_available,
                  current_build: backend.data.current_build,
                  ready_build: backend.data.ready_build,
                  workspace_identity: backend.data.workspace_identity,
                } : null,
              })}
            </output>
            <output
              data-testid="native-workspace-kernel"
              data-generation={hostSnapshot.generation}
              data-api-instance-id={currentPin ?? ""}
              className="break-all rounded border border-fm-border p-2"
            >
              {JSON.stringify({
                api_instance_id: currentPin,
                generation: hostSnapshot.generation,
                paused: hostSnapshot.paused,
                publication_error: hostSnapshot.publicationError,
                session_id: sessionIdentity?.sessionId ?? null,
                session_resource_epoch: sessionIdentity?.sessionEpoch ?? null,
                request_scope_epoch: sessionIdentity?.requestScopeEpoch ?? null,
                backend_transition_epoch: backend.data?.workspace_identity?.session_epoch ?? null,
              })}
            </output>
            <output
              data-testid="native-workspace-project-document"
              data-state={projectSnapshot.state}
              data-dirty={projectSnapshot.state === "ready" ? String(projectSnapshot.resource.dirty) : "false"}
              className="break-all rounded border border-fm-border p-2"
            >
              {JSON.stringify(currentProjectDiagnostic)}
            </output>
            <output
              data-testid="native-workspace-scene-summary"
              data-state={sceneResource.status}
              data-object-count={visibleScene?.object_count ?? 0}
              className="break-all rounded border border-fm-border p-2"
            >
              {JSON.stringify(visibleScene)}
            </output>
            <output
              data-testid="native-workspace-viewport"
              data-ready={String(viewport.ready)}
              className="break-all rounded border border-fm-border p-2"
            >
              {JSON.stringify(viewport)}
            </output>
            <output
              data-testid="native-workspace-before-snapshot"
              data-captured={String(baseline !== null)}
              className="break-all rounded border border-fm-border p-2"
            >
              {JSON.stringify(baseline)}
            </output>
          </div>
          {fixtureSnapshot.finished ? (
            <output data-testid="native-workspace-finish-receipt" className="mt-2 block text-fm-sm text-fm-success">
              {JSON.stringify(fixture.getSnapshot().finishResponse)}
            </output>
          ) : null}
        </div>
      </section>
      <div className="min-h-0 flex-1 overflow-hidden">
        <WorkspaceShell />
      </div>
    </div>
  );
}

export default function NativeWorkspaceRestartProofPage() {
  const ready = useSyncExternalStore(
    bootstrap.subscribe,
    bootstrap.getSnapshot,
    bootstrap.getServerSnapshot,
  );
  return ready
    ? <KernelProvider><NativeWorkspaceRestartFixtureBody /></KernelProvider>
    : <p className="p-4">Preparing the private native workspace check.</p>;
}
