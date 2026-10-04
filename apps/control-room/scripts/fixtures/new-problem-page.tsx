"use client";

import { useEffect, useMemo, useState } from "react";

import { PendingFormRegistry } from "@/kernel/authoring/PendingFormRegistry";
import { API_INSTANCE_HEADER } from "@/kernel/api/apiInstancePin";
import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import {
  API_CONTRACT_VERSION_HEADER,
  EXPECTED_API_CONTRACT_VERSION,
  PLATFORM_OUTPUT_STORAGE_PATH,
  SESSIONS_PATH,
} from "@/kernel/api/apiPaths";
import type {
  OutputStorageDefaultsResource,
  OutputStorageDefaultsRequest,
} from "@/kernel/api/apiTypes";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { NewProblemDialog } from "@/kernel/layout/NewProblemDialog";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import type { KernelApi } from "@/kernel/types";

const API_PIN = "11111111-1111-4111-8111-111111111111";

type SessionCreateRequest = Parameters<ControlRoomApi["sessions"]["create"]>[0];
type SessionCreateResponse = Awaited<ReturnType<ControlRoomApi["sessions"]["create"]>>;
type FixtureOutcome = "success" | "failure" | "pending";

interface SessionRequest {
  readonly request: SessionCreateRequest;
  readonly outcome: FixtureOutcome;
}

interface FixtureSnapshot {
  readonly storageReads: number;
  readonly storageSaves: readonly OutputStorageDefaultsRequest[];
  readonly sessions: readonly SessionRequest[];
  readonly pendingSession: boolean;
  readonly invalidations: number;
  readonly unexpectedRequests: readonly string[];
  readonly historyClears: number;
}

interface NewProblemFixtureApi {
  read: () => FixtureSnapshot;
  setNextSessionOutcome: (outcome: FixtureOutcome) => void;
  acknowledgeNextSession: () => void;
  failNextStorageSave: () => void;
  failNextStorageRead: () => void;
  refreshStorageDefaults: (patch: Partial<OutputStorageDefaultsRequest>) => void;
}

declare global {
  interface Window {
    __newSimulationFixture?: NewProblemFixtureApi;
  }
}

function defaultStorage(): OutputStorageDefaultsResource {
  return {
    output_parent: "C:\\fullmag\\fixture-results",
    temp_parent: "C:\\fullmag\\fixture-temp",
    data_format: "zarr",
    cleanup: "on_success",
    existing_output: "timestamp",
    supported_formats: ["zarr"],
    hdf5_unavailable_reason: "HDF5 output is unavailable in this runtime fixture.",
  };
}

function sessionResponse(sessionId: string, request: SessionCreateRequest): SessionCreateResponse {
  const execution = {
    backend: request.backend,
    device: "cpu" as const,
    precision: "double" as const,
  };
  return {
    session_id: sessionId,
    status: {
      requested_execution: execution,
      effective_execution: execution,
      fallback: null,
    },
    scene_document: {
      schema_version: "0.3",
      version: "scene.v2",
      revision: 0,
      scene: null,
      objects: [],
    },
    revisions: { scene_revision: 0, state_version: 1 },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      [API_CONTRACT_VERSION_HEADER]: EXPECTED_API_CONTRACT_VERSION,
      [API_INSTANCE_HEADER]: API_PIN,
    },
  });
}

function createFixture() {
  const state: {
    defaults: OutputStorageDefaultsResource;
    storageReads: number;
    storageSaves: OutputStorageDefaultsRequest[];
    sessions: SessionRequest[];
    nextSessionOutcome: FixtureOutcome;
    pendingSessionResolve: ((response: Response) => void) | null;
    failNextStorageRead: boolean;
    failNextStorageSave: boolean;
    invalidations: number;
    unexpectedRequests: string[];
    historyClears: number;
  } = {
    defaults: defaultStorage(),
    storageReads: 0,
    storageSaves: [],
    sessions: [],
    nextSessionOutcome: "success",
    pendingSessionResolve: null,
    failNextStorageRead:
      typeof window !== "undefined" &&
      new URL(window.location.href).searchParams.get("storageError") === "1",
    failNextStorageSave: false,
    invalidations: 0,
    unexpectedRequests: [],
    historyClears: 0,
  };
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const api = new ControlRoomApi({
    baseUrl: "http://127.0.0.1:3258",
    expectedApiInstance: API_PIN,
    maxGetRetries: 0,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === PLATFORM_OUTPUT_STORAGE_PATH) {
        state.storageReads += 1;
        if (state.failNextStorageRead) {
          state.failNextStorageRead = false;
          return jsonResponse(
            {
              code: "fixture_storage_unavailable",
              message: "Fixture storage settings are temporarily unavailable.",
            },
            503,
          );
        }
        return jsonResponse(state.defaults);
      }
      if (request.method === "PUT" && path === PLATFORM_OUTPUT_STORAGE_PATH) {
        const saved = await request.json() as OutputStorageDefaultsRequest;
        state.storageSaves.push(saved);
        if (state.failNextStorageSave) {
          state.failNextStorageSave = false;
          return jsonResponse(
            { code: "fixture_storage_save_failed", message: "Fixture storage defaults save failed." },
            503,
          );
        }
        state.defaults = { ...state.defaults, ...saved };
        return jsonResponse(state.defaults);
      }
      if (request.method === "POST" && path === SESSIONS_PATH) {
        const body = await request.json() as SessionCreateRequest;
        const outcome = state.nextSessionOutcome;
        state.nextSessionOutcome = "success";
        state.sessions.push({ request: body, outcome });
        if (outcome === "failure") {
          return jsonResponse(
            { code: "fixture_session_create_failed", message: "Fixture session create failed." },
            503,
          );
        }
        if (outcome === "pending") {
          return await new Promise<Response>((resolve) => {
            state.pendingSessionResolve = resolve;
          });
        }
        return jsonResponse(sessionResponse(`fixture-session-${state.sessions.length}`, body), 201);
      }
      const unexpected = `${request.method} ${path}`;
      state.unexpectedRequests.push(unexpected);
      return jsonResponse(
        { code: "fixture_unexpected_route", message: `Unexpected fixture request: ${unexpected}` },
        404,
      );
    },
  });
  const pendingForms = new PendingFormRegistry();
  const kernel = {
    api,
    authoringHistory: { clear: () => { state.historyClears += 1; } },
    bus,
    diagnosticRecorder: new DiagnosticRecorderController(),
    pendingForms,
    resources,
  } as unknown as KernelApi;
  return { kernel, resources, state };
}

export default function NewProblemPageFixture() {
  const fixture = useMemo(() => createFixture(), []);
  const [open, setOpen] = useState(true);
  const [hasActiveSession, setHasActiveSession] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);

  useEffect(() => {
    window.__newSimulationFixture = {
      read: () => ({
        storageReads: fixture.state.storageReads,
        storageSaves: [...fixture.state.storageSaves],
        sessions: [...fixture.state.sessions],
        pendingSession: fixture.state.pendingSessionResolve !== null,
        invalidations: fixture.state.invalidations,
        unexpectedRequests: [...fixture.state.unexpectedRequests],
        historyClears: fixture.state.historyClears,
      }),
      setNextSessionOutcome: (outcome) => {
        fixture.state.nextSessionOutcome = outcome;
      },
      acknowledgeNextSession: () => {
        const resolve = fixture.state.pendingSessionResolve;
        fixture.state.pendingSessionResolve = null;
        const last = fixture.state.sessions.at(-1);
        if (resolve && last) {
          resolve(jsonResponse(sessionResponse(`fixture-session-${fixture.state.sessions.length}`, last.request), 201));
        }
      },
      failNextStorageSave: () => {
        fixture.state.failNextStorageSave = true;
      },
      failNextStorageRead: () => {
        fixture.state.failNextStorageRead = true;
        fixture.resources.invalidate(PLATFORM_OUTPUT_STORAGE_PATH, `fixture-read-${++fixture.state.invalidations}`);
      },
      refreshStorageDefaults: (patch) => {
        fixture.state.defaults = { ...fixture.state.defaults, ...patch };
        fixture.resources.invalidate(PLATFORM_OUTPUT_STORAGE_PATH, `fixture-refresh-${++fixture.state.invalidations}`);
      },
    };
    return () => {
      delete window.__newSimulationFixture;
    };
  }, [fixture]);

  const openDialog = (replaceCurrent: boolean) => {
    setHasActiveSession(replaceCurrent);
    setDialogKey((current) => current + 1);
    setOpen(true);
  };

  return (
    <KernelContext.Provider value={fixture.kernel}>
      <main data-new-problem-fixture="true">
        <h1>New simulation browser fixture</h1>
        <p>
          Production dialog, generated v2 client, resource hook, and invalidation
          controller with a deterministic output-storage and session API. No backend
          runtime or solver is started by this page.
        </p>
        <div className="fm-new-problem-fixture__actions">
          <button data-new-problem-open-empty onClick={() => openDialog(false)} type="button">
            Open without an active session
          </button>
          <button data-new-problem-open-replacement onClick={() => openDialog(true)} type="button">
            Open with an active session
          </button>
        </div>
        <NewProblemDialog
          hasActiveSession={hasActiveSession}
          key={dialogKey}
          open={open}
          onOpenChange={setOpen}
        />
      </main>
    </KernelContext.Provider>
  );
}