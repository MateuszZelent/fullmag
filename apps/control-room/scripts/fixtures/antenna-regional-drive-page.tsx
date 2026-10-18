"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { MODEL_FIELD_DRIVES_PATH, MODEL_SCENE_PATH, SESSIONS_PATH, SESSION_STATUS_PATH } from "@/kernel/api/apiPaths";
import type { RegionalFieldDriveResource, SceneResource } from "@/kernel/api/apiTypes";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { AuthoringHistoryController } from "@/kernel/authoring/AuthoringHistoryController";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { SelectionController } from "@/kernel/selection/SelectionController";
import { EMPTY_SELECTION } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { InspectorEditSessionProvider, useInspectorEditSession } from "@/modules/inspector/InspectorEditSession";
import { AntennaObjectPanel } from "@/modules/inspector/panels/AntennaObjectPanel";
import { RegionalFieldDrivePanel } from "@/modules/inspector/panels/RegionalFieldDrivePanel";
import { Button } from "@/shared/ui/Button";

const API_INSTANCE = "13131313-1313-4131-8131-131313131313";
const subscribeHydration = () => () => {};
function makeFixture() {
  let scene: SceneResource = { revision: 1, scene_revision: 1, objects: ["antenna-a", "antenna-b"].map(id => ({ id, name: id, role: "antenna" })), field_drives: { drives: [] } };
  const calls: Array<{ method: string; path: string; scope: string | null; body: unknown }> = [], unexpected: string[] = [], pending: Array<() => void> = [];
  const bus = new EventBus<KernelEventMap>(), resources = new ResourceInvalidationController(bus), selection = new SelectionController(bus);
  const diagnostics = new RequestDiagnosticsController(), diagnosticRecorder = new DiagnosticRecorderController({ diagnostics });
  const identity = { sessionId: "regional-fixture", sessionEpoch: "regional-fixture@1", requestScopeEpoch: `${API_INSTANCE}:1` };
  const scope = sessionRequestScopeKey(identity);
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "x-api-contract-version": "1.0.0", "x-fullmag-api-instance": API_INSTANCE } });
  const api = new ControlRoomApi({ baseUrl: "http://antenna-regional.fixture.invalid", expectedApiInstance: API_INSTANCE, diagnostics, maxGetRetries: 0,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init), path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.json() as { base_revision: number; drive: RegionalFieldDriveResource } : null;
      const requestScope = request.headers.get("x-fullmag-session-scope");
      calls.push({ method: request.method, path, scope: requestScope, body });
      if (calls.length > 80) throw new Error("Regional fixture request budget exceeded");
      if (request.method === "GET" && path === SESSIONS_PATH) return json({ schema_version: "1.0", sessions: [{ session_id: identity.sessionId, name: "Regional fixture", current: true, status: "idle" }] });
      if (request.method === "GET" && path === SESSION_STATUS_PATH) return json({ session: { session_id: identity.sessionId, session_epoch: identity.sessionEpoch, request_scope_epoch: identity.requestScopeEpoch, name: "Regional fixture", created_at: "fixture", workspace_root: "fixture" }, resources: { scene_revision: scene.revision }, capabilities: {}, lifecycle: { solver: "idle", session_resource: "active", connectivity: "connected", commandability: "writable" } });
      if (requestScope !== scope) { unexpected.push("foreign scope"); return json({ message: "Owner changed", code: "request_context_stale" }, 409); }
      if (request.method === "GET" && path === MODEL_SCENE_PATH) return json(structuredClone(scene));
      if (request.method === "GET" && path === MODEL_FIELD_DRIVES_PATH) return json({ scene_revision: scene.revision, drives: structuredClone(scene.field_drives?.drives ?? []) });
      if (request.method === "POST" && path === MODEL_FIELD_DRIVES_PATH && body) {
        const captured = structuredClone(body);
        return new Promise<Response>(resolve => pending.push(() => {
          if (captured.base_revision !== scene.revision) { resolve(json({ message: "Scene changed", code: "revision_conflict" }, 409)); return; }
          const revision = (scene.revision ?? 0) + 1;
          scene = { ...scene, revision, scene_revision: revision, field_drives: { drives: [...(scene.field_drives?.drives ?? []), captured.drive] } };
          resolve(json({ transaction_kind: "merge_patch", scene_revision: revision, committed_scene: structuredClone(scene) }));
        }));
      }
      unexpected.push(`${request.method} ${path}`); throw new Error(`Unexpected regional request ${request.method} ${path}`);
    } });
  const authoringHistory = new AuthoringHistoryController(api, resources);
  const kernel = { api, bus, resources, diagnostics, diagnosticRecorder, authoringHistory, selection, commands: { getSessionScopeKey: () => scope } } as unknown as KernelApi;
  const choose = (objectId: string) => selection.set({ ...EMPTY_SELECTION, kind: "object.antenna.regional", objectId, nodeId: `model:object:${objectId}:antenna:regional`, label: "Regional field drive" }, "inspector");
  choose("antenna-a");
  const control = {
    read: () => ({ calls: structuredClone(calls), scene: structuredClone(scene), pending: pending.length, unexpected: [...unexpected], selection: selection.get(), canUndo: authoringHistory.canUndo() }),
    release: () => { const next = pending.shift(); if (!next) throw new Error("No pending regional write"); next(); },
    refresh: () => { const revision = (scene.revision ?? 0) + 1; scene = { ...scene, revision, scene_revision: revision }; resources.invalidate(MODEL_SCENE_PATH, revision); resources.invalidate(MODEL_FIELD_DRIVES_PATH, revision); },
    choose,
    subscribe: (listener: () => void) => selection.subscribe(listener),
    selection: () => selection.get(),
  };
  return { kernel, control };
}
type Fixture = ReturnType<typeof makeFixture>;
declare global { interface Window { __antennaRegionalFixture?: Fixture["control"]; } }
function Editor({ fixture }: { fixture: Fixture }) {
  const selection = useSyncExternalStore(fixture.control.subscribe, fixture.control.selection, fixture.control.selection);
  const session = useInspectorEditSession();
  return <>
    <section data-testid="regional-editor">{selection.ref?.type === "physics-field-drive" ? <RegionalFieldDrivePanel selection={selection} /> : <AntennaObjectPanel selection={selection} />}</section>
    <Button type="button" disabled={!session?.dirty || !session?.valid || session?.applying} onClick={() => void session?.apply()}>Apply regional source</Button>
    <output data-testid="regional-dirty">{String(session?.dirty ?? false)}</output>
  </>;
}
export default function AntennaRegionalDriveFixture() {
  const fixture = useMemo(() => makeFixture(), []);
  const mounted = useSyncExternalStore(subscribeHydration, () => true, () => false);
  useEffect(() => { window.__antennaRegionalFixture = fixture.control; return () => { delete window.__antennaRegionalFixture; }; }, [fixture]);
  return <main className="fm-regional-fixture" style={{ padding: 24, maxWidth: 850 }}>
    <h1>Regional field source authoring</h1><p>Production Inspector and typed API with controlled HTTP; no solver qualification.</p>
    <label>Unrelated draft <input data-testid="regional-unrelated" defaultValue="untouched" /></label>
    {mounted ? <KernelContext.Provider value={fixture.kernel}><InspectorEditSessionProvider><Editor fixture={fixture} /></InspectorEditSessionProvider></KernelContext.Provider> : <p>Loading…</p>}
  </main>;
}
