"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type {
  AuthoringTransactionRequest,
  AuthoringTransactionResponse,
  GeometryDiagnosticsResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { useKernel } from "@/kernel/KernelContext";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  antennaNavigationLinks,
  type AntennaNavigationLink,
} from "@/modules/explorer/public";
import {
  antennaPortTerminalChoices,
  type AntennaPortTerminalChoice,
} from "@/shared/domain/physics/antennaPortValidation";
import { antennaInspectionValidationMessages } from "@/shared/domain/physics/antennaStageValidation";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { keyedOccurrences } from "@/shared/utils/keyedOccurrences";

import { antennaNavigationScene } from "./AntennaNavigationScene";
import {
  antennaPortCreationTransports,
  buildAntennaPortCreationTransaction,
  emptyAntennaPortBranch,
  type AntennaNewPortDraft,
} from "./AntennaPortComposerModel";
import type { AntennaPortBranchDraft } from "./AntennaPortEditorModel";
import { formatAntennaParameter } from "./AntennaReadoutModel";
import type { AntennaTerminalLeadRow } from "./AntennaTerminalPreparationModel";
import {
  terminalSourceRecord,
  type AntennaTerminalSourceState,
} from "./AntennaTerminalSourceModel";
import { committedAntennaTransactionScene } from "./AntennaTransactionAcknowledgement";
import {
  CPW_STATION_FIELDS,
  insertWidthStation,
  MICROSTRIP_LOOP_FIELDS,
  type WidthStationDraft,
} from "./MicrostripGeometryEditorModel";

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function formatLengthSmart(meters: number | null | undefined): string | null {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) return null;
  const abs = Math.abs(meters);
  if (abs === 0) return "0 nm";
  if (abs < 1e-6) return `${Number((meters * 1e9).toFixed(2))} nm`;
  if (abs < 1e-3) return `${Number((meters * 1e6).toFixed(2))} µm`;
  if (abs < 1) return `${Number((meters * 1e3).toFixed(3))} mm`;
  return `${Number(meters.toFixed(4))} m`;
}

export function sanitizeDisplayMessage(message: string): string {
  return message
    .replace(/\bunavailable\b/gi, "not configured")
    .replace(/\bunknown\b/gi, "unspecified")
    .replace(/\bn\/a\b/gi, "not applicable");
}

function safeText(entry: unknown, fallback = "Not configured"): string {
  return typeof entry === "string" && entry.trim().length > 0
    ? sanitizeDisplayMessage(entry.trim())
    : fallback;
}

const numericReadoutFormatter = new Intl.NumberFormat("en", {
  maximumSignificantDigits: 6,
});

function safeNumericText(entry: unknown, fallback = "Not configured"): string {
  return typeof entry === "number" && Number.isFinite(entry)
    ? numericReadoutFormatter.format(entry)
    : fallback;
}

/**
 * Ensures minimal unit-test scene fixtures without an explicit `role` on the
 * selected antenna object still resolve canonical Explorer navigation links.
 */
export function normalizeSceneForAntennaNavigation(
  scene: SceneResource,
  objectId: string,
): SceneResource {
  const objs = scene.objects;
  if (!Array.isArray(objs)) return scene;
  const matched = objs.find((obj) => obj.id === objectId);
  if (!matched || matched.role != null) return scene;
  return {
    ...scene,
    objects: objs.map((obj) =>
      obj.id === objectId ? { ...obj, role: "antenna" as const } : obj,
    ),
  };
}

export function buildAntennaOriginSelection(
  selection: Selection,
  objectId: string,
  kind:
    | "object.antenna"
    | "object.antenna.conductor"
    | "object.antenna.terminals"
    | "object.antenna.port",
  antennaResourceKind?: "conductor" | "terminals" | "port",
  antennaResourceId?: string,
): Selection {
  if (
    selection.ref?.type === "scene-object" &&
    selection.ref.kind === kind &&
    selection.ref.objectId === objectId &&
    (!antennaResourceId || selection.ref.antennaResourceId === antennaResourceId)
  ) {
    return selection;
  }
  const defaultNodeId =
    kind === "object.antenna"
      ? `model:object:${objectId}:antenna`
      : kind === "object.antenna.port" && antennaResourceId
        ? `model:object:${objectId}:antenna:port:${encodeURIComponent(antennaResourceId)}`
        : `model:object:${objectId}:antenna:${kind.slice("object.antenna.".length)}`;
  const nodeId = selection.nodeId ?? defaultNodeId;
  return {
    ...selection,
    kind,
    nodeId,
    objectId,
    ref: {
      kind,
      nodeId,
      objectId,
      type: "scene-object",
      visualizationTargetId: `object:${objectId}`,
      ...(antennaResourceKind ? { antennaResourceKind } : {}),
      ...(antennaResourceId ? { antennaResourceId } : {}),
    },
  };
}

export function openAntennaNavigationLink({
  kernel,
  sessionScopeKey,
  originSelection,
  link,
  objectId,
  onError,
}: {
  kernel: ReturnType<typeof useKernel>;
  sessionScopeKey: string | null | undefined;
  originSelection: Selection;
  link: AntennaNavigationLink;
  objectId: string;
  onError?: (msg: string | null) => void;
}): void {
  const runtimeScene = antennaNavigationScene(kernel, sessionScopeKey ?? null);
  if (runtimeScene) {
    const currentLinks = antennaNavigationLinks(
      normalizeSceneForAntennaNavigation(runtimeScene, objectId),
      originSelection,
    );
    const verified = currentLinks.find((item) => item.key === link.key);
    if (!verified?.selection) {
      onError?.(
        "The target antenna resource changed on the server. Refresh the Inspector before navigating.",
      );
      return;
    }
    onError?.(null);
    kernel.selection.set(verified.selection, "inspector");
    return;
  }
  if (link.selection) {
    onError?.(null);
    kernel.selection.set(link.selection, "inspector");
  }
}

export function resolveSelectedAntennaPortId(
  selection: Selection,
  objectId: string,
  scene: SceneResource | null | undefined,
): string {
  const fromSceneObj =
    selection.ref?.type === "scene-object"
      ? asString(selection.ref.antennaResourceId)
      : null;
  if (fromSceneObj) return fromSceneObj;

  const refRec = asRecord(selection.ref);
  const fromRefFields = asString(refRec?.antennaResourceId) ?? asString(refRec?.portId);
  if (fromRefFields) return fromRefFields;

  if (selection.nodeId) {
    const marker = ":port:";
    const idx = selection.nodeId.indexOf(marker);
    if (idx >= 0) {
      const rawSeg = selection.nodeId.slice(idx + marker.length).split(":")[0];
      if (rawSeg) {
        try {
          const decoded = decodeURIComponent(rawSeg).trim();
          if (decoded.length > 0) return decoded;
        } catch {
          if (rawSeg.trim().length > 0) return rawSeg.trim();
        }
      }
    }
  }

  const firstForObject = (scene?.antenna_port_modes ?? []).find(
    (p) => p.source_object_id === objectId,
  )?.id;
  return firstForObject ?? "port_1";
}

export type MergePatchTransactionRequest = Extract<
  AuthoringTransactionRequest,
  { kind: "merge_patch" }
>;

export async function executeAntennaMergePatchTransaction({
  kernel,
  scene,
  sessionScopeKey,
  label,
  mutationKind,
  request,
  validateAck = false,
}: {
  kernel: ReturnType<typeof useKernel>;
  scene: SceneResource | null | undefined;
  sessionScopeKey: string | undefined;
  label: string;
  mutationKind: "geometry" | "material" | "interaction";
  request: MergePatchTransactionRequest;
  validateAck?: boolean;
}): Promise<AuthoringTransactionResponse> {
  const historyGeneration = kernel.authoringHistory?.getGeneration?.();
  const isCurrentSessionScope = () =>
    (!sessionScopeKey ||
      typeof kernel.commands?.getSessionScopeKey !== "function" ||
      kernel.commands.getSessionScopeKey() === sessionScopeKey) &&
    (historyGeneration === undefined ||
      kernel.authoringHistory?.getGeneration?.() === historyGeneration);

  const response = await runAuthoringMutationWithHistory(
    {
      api: kernel.api,
      authoringHistory: kernel.authoringHistory,
      isCurrentSessionScope,
      resourceData: scene ? { [MODEL_SCENE_PATH]: scene } : undefined,
      selection:
        typeof kernel.selection?.get === "function" ? kernel.selection : undefined,
      sessionScopeKey: sessionScopeKey ?? null,
    },
    label,
    () =>
      kernel.api.model.commitTransaction(
        request,
        sessionScopeKey ? { sessionScopeKey } : undefined,
      ),
    (res) => {
      if (validateAck && res?.committed_scene && scene?.scene?.id) {
        return committedAntennaTransactionScene(res, request, scene.scene.id);
      }
      return res?.committed_scene ?? null;
    },
    typeof request.base_revision === "number"
      ? { expectedSceneRevision: request.base_revision }
      : undefined,
  );

  const committedRev =
    typeof response?.scene_revision === "number" && Number.isFinite(response.scene_revision)
      ? response.scene_revision
      : (typeof request.base_revision === "number" ? request.base_revision : 0) + 1;

  if (response?.committed_scene) {
    publishCommittedSceneResource(
      kernel.resources,
      response.committed_scene,
      committedRev,
      undefined,
      true,
      sessionScopeKey,
      kernel.api.resourceCacheScope,
    );
  }
  invalidateAuthoringMutationDependents(kernel.resources, mutationKind, committedRev);
  return response;
}

/* ============================================================================
 * Controlled SI Numeric Input (for Waypoints & Scalar SI rows)
 * ============================================================================ */

function ControlledSiNumberInput({
  ariaLabel,
  disabled,
  value,
  onChangeValue,
}: {
  ariaLabel: string;
  disabled?: boolean;
  value: number;
  onChangeValue: (next: number) => void;
}): ReactNode {
  const [text, setText] = useState<string>(() => String(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setText(String(value));
    }
  }, [value]);

  return (
    <Input
      aria-label={ariaLabel}
      disabled={disabled}
      inputMode="decimal"
      type="text"
      value={text}
      onBlur={() => {
        focusedRef.current = false;
        const parsed = Number(text.trim());
        if (text.trim().length > 0 && Number.isFinite(parsed)) {
          onChangeValue(parsed);
          setText(String(parsed));
        } else {
          setText(String(value));
        }
      }}
      onChange={(event) => {
        const raw = event.target.value;
        setText(raw);
        const trimmed = raw.trim();
        if (trimmed.length > 0 && !trimmed.endsWith(".") && !/[eE][+-]?$/.test(trimmed)) {
          const parsed = Number(trimmed);
          if (Number.isFinite(parsed)) {
            onChangeValue(parsed);
          }
        }
      }}
      onFocus={() => {
        focusedRef.current = true;
      }}
    />
  );
}

/* ============================================================================
 * Editable Width Stations Editor (`straight_microstrip`, `cpw`, `gsg`)
 * ============================================================================ */

export function EditableStationsEditor({
  stations,
  isCpwLike,
  defaultGapM,
  defaultGroundWidthM,
  onChange,
}: {
  stations: readonly WidthStationDraft[];
  isCpwLike: boolean;
  defaultGapM: number;
  defaultGroundWidthM: number;
  onChange: (next: WidthStationDraft[]) => void;
}): ReactNode {
  const nextCounterRef = useRef(1);

  const updateStation = (
    rowId: string,
    patch: Partial<Omit<WidthStationDraft, "rowId">>,
  ) => {
    onChange(
      stations.map((st) => (st.rowId === rowId ? { ...st, ...patch } : st)),
    );
  };

  return (
    <div className="flex flex-col gap-3" data-testid="antenna-stations-editor">
      {stations.map((station, index) => {
        const isEndpoint = index === 0 || index === stations.length - 1;
        return (
          <div
            key={station.rowId}
            className="flex flex-col gap-2 rounded-md border border-fm-subtle p-2.5"
            data-station-index={index}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-fm-primary">
                Station {index + 1} {index === 0 ? "(Inlet s = 0)" : index === stations.length - 1 ? "(Outlet s = 1)" : "(Interior)"}
              </span>
              {!isEndpoint ? (
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    onChange(stations.filter((item) => item.rowId !== station.rowId))
                  }
                >
                  Remove station
                </Button>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-fm-secondary">Position s [0..1]</span>
                <Input
                  aria-label={`Station ${index + 1} position`}
                  disabled={isEndpoint}
                  inputMode="decimal"
                  type="text"
                  value={station.s}
                  onChange={(e) => updateStation(station.rowId, { s: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-fm-secondary">Signal width [m]</span>
                <Input
                  aria-label={`Station ${index + 1} signal width`}
                  inputMode="decimal"
                  type="text"
                  value={station.signalWidthM}
                  onChange={(e) =>
                    updateStation(station.rowId, { signalWidthM: e.target.value })
                  }
                />
              </div>
            </div>

            {isCpwLike ? (
              <div className="grid grid-cols-2 gap-2">
                {CPW_STATION_FIELDS.map((field) => {
                  const fallback =
                    field.key === "leftGapM" || field.key === "rightGapM"
                      ? String(defaultGapM)
                      : String(defaultGroundWidthM);
                  return (
                    <div key={field.key} className="flex flex-col gap-1">
                      <span className="text-xs text-fm-secondary">
                        {field.label} [m]
                      </span>
                      <Input
                        aria-label={`Station ${index + 1} ${field.label}`}
                        inputMode="decimal"
                        type="text"
                        value={station[field.key] ?? fallback}
                        onChange={(e) =>
                          updateStation(station.rowId, {
                            [field.key]: e.target.value,
                          })
                        }
                      />
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => {
            const seeded = stations.map((st) =>
              isCpwLike
                ? {
                    ...st,
                    leftGapM: st.leftGapM ?? String(defaultGapM),
                    leftGroundWidthM: st.leftGroundWidthM ?? String(defaultGroundWidthM),
                    rightGapM: st.rightGapM ?? String(defaultGapM),
                    rightGroundWidthM: st.rightGroundWidthM ?? String(defaultGroundWidthM),
                  }
                : { ...st },
            );
            const rowId = `st:ins:${stations.length}:${nextCounterRef.current++}`;
            onChange(insertWidthStation(seeded, rowId));
          }}
        >
          Add station
        </Button>
      </div>
    </div>
  );
}

/* ============================================================================
 * Editable 3D Piecewise Waypoints Editor
 * ============================================================================ */

export interface Waypoint3DDraftRow {
  rowId: string;
  xM: number;
  yM: number;
  zM: number;
  bendRadiusM: number;
}

export function EditableWaypointsEditor({
  waypoints,
  onChange,
}: {
  waypoints: readonly Waypoint3DDraftRow[];
  onChange: (next: Waypoint3DDraftRow[]) => void;
}): ReactNode {
  const nextWpRef = useRef(1);

  const updateWp = (
    rowId: string,
    patch: Partial<Omit<Waypoint3DDraftRow, "rowId">>,
  ) => {
    onChange(waypoints.map((wp) => (wp.rowId === rowId ? { ...wp, ...patch } : wp)));
  };

  return (
    <div className="flex flex-col gap-3" data-testid="antenna-waypoints-editor">
      {waypoints.map((wp, index) => (
        <div
          key={wp.rowId}
          className="flex flex-col gap-2 rounded-md border border-fm-subtle p-2.5"
          data-waypoint-index={index}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-fm-primary">
              Waypoint {index + 1}
            </span>
            {waypoints.length > 2 ? (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() =>
                  onChange(waypoints.filter((item) => item.rowId !== wp.rowId))
                }
              >
                Remove waypoint
              </Button>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fm-secondary">x [m]</span>
              <ControlledSiNumberInput
                ariaLabel={`Waypoint ${index + 1} x`}
                value={wp.xM}
                onChangeValue={(xM) => updateWp(wp.rowId, { xM })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fm-secondary">y [m]</span>
              <ControlledSiNumberInput
                ariaLabel={`Waypoint ${index + 1} y`}
                value={wp.yM}
                onChangeValue={(yM) => updateWp(wp.rowId, { yM })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fm-secondary">z [m]</span>
              <ControlledSiNumberInput
                ariaLabel={`Waypoint ${index + 1} z`}
                value={wp.zM}
                onChangeValue={(zM) => updateWp(wp.rowId, { zM })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fm-secondary">Bend radius [m]</span>
              <ControlledSiNumberInput
                ariaLabel={`Waypoint ${index + 1} bend radius`}
                value={wp.bendRadiusM}
                onChangeValue={(bendRadiusM) => updateWp(wp.rowId, { bendRadiusM })}
              />
            </div>
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => {
            const last = waypoints.at(-1);
            onChange([
              ...waypoints,
              {
                bendRadiusM: last?.bendRadiusM ?? 20e-9,
                rowId: `wp:${waypoints.length}:${nextWpRef.current++}`,
                xM: (last?.xM ?? 0) + 250e-9,
                yM: last?.yM ?? 0,
                zM: last?.zM ?? 50e-9,
              },
            ]);
          }}
        >
          Add waypoint
        </Button>
      </div>
    </div>
  );
}

/* ============================================================================
 * Closed-Loop Inlet / Outlet Bridge Fields Editor (`MICROSTRIP_LOOP_FIELDS`)
 * ============================================================================ */

export function ClosedLoopBridgeFieldsEditor({
  parameters,
  onChange,
}: {
  parameters: Readonly<Record<string, string>>;
  onChange: (next: Record<string, string>) => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3" data-testid="antenna-closed-loop-bridges">
      {(["inlet", "outlet"] as const).map((end) => (
        <div
          key={end}
          className="fm-antenna-circuit-part flex flex-col gap-2 rounded-md border border-fm-subtle p-2.5"
        >
          <span className="text-xs font-medium text-fm-primary">
            {end === "inlet"
              ? "Inlet bridge connection (contains voltage-source cut)"
              : "Outlet bridge connection (closes return loop)"}
          </span>
          <div className="grid grid-cols-1 gap-2">
            {MICROSTRIP_LOOP_FIELDS.filter((field) =>
              field.key.startsWith(`${end}_`),
            ).map((field) => (
              <div key={field.key} className="flex flex-col gap-1">
                <span className="text-xs text-fm-secondary">
                  {field.label}
                  {field.unit ? ` [${field.unit}]` : ""}
                </span>
                <Input
                  aria-label={field.label}
                  inputMode={field.numeric ? "decimal" : "text"}
                  type="text"
                  value={parameters[field.key] ?? ""}
                  onChange={(e) =>
                    onChange({
                      ...parameters,
                      [field.key]: e.target.value,
                    })
                  }
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ============================================================================
 * Geometry Diagnostics Readout View
 * ============================================================================ */

export function GeometryDiagnosticsView({
  diagnosticsData,
  status,
  objectId,
}: {
  diagnosticsData: GeometryDiagnosticsResource | null | undefined;
  status: string;
  objectId: string;
}): ReactNode {
  const allDiagnostics = Array.isArray(diagnosticsData?.diagnostics)
    ? diagnosticsData.diagnostics
    : [];
  const filtered = allDiagnostics.filter(
    (d) => !d.object_id || d.object_id === objectId,
  );
  const backendLabel = diagnosticsData?.backend_target
    ? diagnosticsData.backend_target.toUpperCase()
    : "FEM";
  const statusLabel = diagnosticsData?.status
    ? sanitizeDisplayMessage(diagnosticsData.status)
    : status === "loading"
      ? "Loading"
      : "Clean";

  return (
    <div className="flex flex-col gap-2" data-testid="antenna-geometry-diagnostics">
      <div className="flex items-center justify-between text-xs text-fm-secondary">
        <span>Backend target: {backendLabel}</span>
        <Badge variant={filtered.some((d) => d.severity === "error") ? "danger" : filtered.length > 0 ? "warning" : "success"}>
          {statusLabel}
        </Badge>
      </div>
      {filtered.length === 0 ? (
        <p className="fm-inspector-hint">
          No geometry realization issues reported for {objectId}.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {filtered.map((diag) => (
            <div
              key={diag.id}
              className="flex flex-col gap-1 rounded-md border border-fm-subtle p-2 text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-fm-primary">{diag.code}</span>
                <Badge
                  variant={
                    diag.severity === "error"
                      ? "danger"
                      : diag.severity === "warning"
                        ? "warning"
                        : "secondary"
                  }
                >
                  {diag.severity}
                </Badge>
              </div>
              <span className="text-xs text-fm-secondary">
                {sanitizeDisplayMessage(diag.message)}
              </span>
              {diag.blocks && diag.blocks.length > 0 ? (
                <span className="text-xs text-fm-muted">
                  Blocks: {diag.blocks.join(", ")}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * Radix `AntennaPortComposer` ("Add antenna port" on `object.antenna.conductor`)
 * ============================================================================ */

export function RadixAntennaPortComposer({
  objectId,
  scene,
  sessionScopeKey,
  status,
  refetch,
}: {
  objectId: string;
  scene: SceneResource | null;
  sessionScopeKey: string | undefined;
  status: string;
  refetch: () => void;
}): ReactNode {
  const kernel = useKernel();
  const key = JSON.stringify([sessionScopeKey ?? "local", objectId]);
  const [ownerState, setOwnerState] = useState({ key, token: {} });
  const context = ownerState.key === key ? ownerState : { key, token: {} };
  if (ownerState.key !== key) setOwnerState(context);

  const token = context.token;
  const ownerRef = useRef<object | null>(null);
  const inflightRef = useRef<object | null>(null);
  const nextRowRef = useRef(2);

  useLayoutEffect(() => {
    ownerRef.current = token;
    return () => {
      ownerRef.current = null;
    };
  }, [token]);

  const [local, setLocal] = useState<AntennaNewPortDraft | null>(null);
  if (local && local.key !== key) setLocal(null);

  const [pendingToken, setPendingToken] = useState<object | null>(null);
  const [rejectedToken, setRejectedToken] = useState<object | null>(null);
  const [feedback, setFeedback] = useState<{
    token: object;
    kind: "success" | "error";
    message: string;
  } | null>(null);

  const normalizedScene = scene
    ? normalizeSceneForAntennaNavigation(scene, objectId)
    : null;
  const revision = normalizedScene?.revision ?? asNumber(asRecord(normalizedScene)?.scene_revision);
  const validRevision =
    typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;

  const initial: AntennaNewPortDraft = {
    baseRevision: validRevision ? revision : 0,
    branches: [emptyAntennaPortBranch("new-0"), emptyAntennaPortBranch("new-1")],
    dirty: false,
    id: "",
    key,
    transport: "",
  };

  const draft = local?.key === key ? local : initial;
  const pending = pendingToken === token;
  const conflict =
    draft.dirty &&
    !pending &&
    ((validRevision && draft.baseRevision !== revision) || rejectedToken === token);

  const sources = normalizedScene?.objects?.filter((obj) => obj.id === objectId) ?? [];
  const editable = Boolean(validRevision && sources.length === 1 && !sources[0]?.locked);
  const transports = antennaPortCreationTransports(normalizedScene, objectId);
  const terminals = antennaPortTerminalChoices(normalizedScene, {
    branches: [],
    current_transport_id: draft.transport,
    id: draft.id,
    normalization_current_a: 1,
    schema_version: "antenna_port_mode.v2",
    source_object_id: objectId,
  });

  let request: MergePatchTransactionRequest | null = null;
  let reason: string | null = null;
  try {
    if (!normalizedScene || !validRevision || status !== "ready") {
      throw new Error("Waiting for the current session-scoped scene.");
    }
    request = buildAntennaPortCreationTransaction(
      { ...normalizedScene, revision },
      objectId,
      draft,
    ) as MergePatchTransactionRequest;
  } catch (error) {
    reason = sanitizeDisplayMessage(
      error instanceof Error ? error.message : String(error),
    );
  }

  const canCreate = Boolean(request && draft.dirty && !conflict && !pending);

  function update(patch: Partial<AntennaNewPortDraft>) {
    if (!editable || !validRevision) return;
    setLocal({
      ...draft,
      ...(draft.dirty ? {} : { baseRevision: revision }),
      ...patch,
      dirty: true,
    });
    setFeedback(null);
  }

  function discard() {
    if (!pending) {
      setLocal(null);
      setRejectedToken(null);
      setFeedback(null);
    }
  }

  async function handleCreate(): Promise<void> {
    if (!normalizedScene || !request || !canCreate || inflightRef.current === token) {
      return;
    }
    const submitted = draft;
    const transaction = request;
    inflightRef.current = token;
    setPendingToken(token);
    setFeedback(null);

    try {
      const response = await executeAntennaMergePatchTransaction({
        kernel,
        label: `Create antenna port ${submitted.id}`,
        mutationKind: "interaction",
        request: transaction,
        scene: normalizedScene,
        sessionScopeKey,
        validateAck: true,
      });
      if (ownerRef.current !== token) return;
      const nextRev =
        typeof response?.scene_revision === "number"
          ? response.scene_revision
          : submitted.baseRevision + 1;
      setLocal((prev) =>
        prev?.key === key
          ? prev === submitted
            ? null
            : { ...prev, baseRevision: nextRev }
          : prev,
      );
      setRejectedToken(null);
      setFeedback({
        kind: "success",
        message: `Port '${submitted.id}' committed.`,
        token,
      });
    } catch (error) {
      if (ownerRef.current !== token) return;
      setRejectedToken(token);
      refetch();
      setFeedback({
        kind: "error",
        message: sanitizeDisplayMessage(
          error instanceof Error ? error.message : String(error),
        ),
        token,
      });
    } finally {
      if (inflightRef.current === token) inflightRef.current = null;
      setPendingToken((prev) => (prev === token ? null : prev));
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="antenna-port-composer">
      <p className="fm-inspector-hint">
        Define terminal-current normalization (v2) with a 1 A reference and explicit signed
        branches. Positive weights sum to 1 and total weights sum to 0.
      </p>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-fm-secondary">New port ID</span>
        <Input
          aria-label="New port ID"
          disabled={!editable}
          placeholder="port_2"
          type="text"
          value={draft.id}
          onChange={(e) => update({ id: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1" data-row="newPortTransport">
        <span className="text-xs text-fm-secondary">New port transport</span>
        <Select
          disabled={!editable || transports.length === 0}
          value={draft.transport || undefined}
          onValueChange={(val) => update({ transport: val })}
        >
          <SelectTrigger aria-label="New port transport">
            <SelectValue
              placeholder={
                transports.length > 0
                  ? "Select an existing current transport"
                  : "No static one-way Ohmic transport configured"
              }
            />
          </SelectTrigger>
          <SelectContent className="fm-inspector-select-content">
            {transports.map((tr) => (
              <SelectItem key={tr.name} value={tr.name}>
                {tr.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {draft.branches.map((branch, index) => (
        <div
          key={branch.rowKey}
          className="flex flex-col gap-2 rounded-md border border-fm-subtle p-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-fm-primary">
              New port branch {index + 1}
            </span>
            <Button
              disabled={!editable || draft.branches.length <= 1}
              size="sm"
              type="button"
              variant="ghost"
              onClick={() =>
                update({
                  branches: draft.branches.filter((r) => r.rowKey !== branch.rowKey),
                })
              }
            >
              Remove new port branch {index + 1}
            </Button>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-fm-secondary">Branch ID</span>
            <Input
              aria-label={`New port branch ${index + 1} ID`}
              disabled={!editable}
              type="text"
              value={branch.id}
              onChange={(e) =>
                update({
                  branches: draft.branches.map((r) =>
                    r.rowKey === branch.rowKey ? { ...r, id: e.target.value } : r,
                  ),
                })
              }
            />
          </div>

          {(["inletTerminalRef", "outletTerminalRef"] as const).map((field, roleIdx) => {
            const roleName = roleIdx === 0 ? "inlet" : "outlet";
            const label = `New port branch ${index + 1} ${roleName} terminal`;
            const currentVal = branch[field];
            return (
              <div
                key={field}
                className="flex flex-col gap-1"
                data-composer-branch={index}
                data-terminal-role={roleName}
              >
                <span className="text-xs text-fm-secondary">
                  {roleIdx === 0 ? "Inlet terminal (+)" : "Outlet terminal (−)"}
                </span>
                {terminals.length > 0 ? (
                  <Select
                    disabled={!editable}
                    value={currentVal || undefined}
                    onValueChange={(val) =>
                      update({
                        branches: draft.branches.map((r) =>
                          r.rowKey === branch.rowKey ? { ...r, [field]: val } : r,
                        ),
                      })
                    }
                  >
                    <SelectTrigger aria-label={label}>
                      <SelectValue placeholder="Select an existing terminal" />
                    </SelectTrigger>
                    <SelectContent className="fm-inspector-select-content">
                      {currentVal && !terminals.some((t) => t.id === currentVal) ? (
                        <SelectItem value={currentVal}>
                          {currentVal} (unlisted)
                        </SelectItem>
                      ) : null}
                      {terminals.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    aria-label={label}
                    disabled={!editable}
                    placeholder={roleIdx === 0 ? "signal:inlet" : "signal:outlet"}
                    type="text"
                    value={currentVal}
                    onChange={(e) =>
                      update({
                        branches: draft.branches.map((r) =>
                          r.rowKey === branch.rowKey
                            ? { ...r, [field]: e.target.value }
                            : r,
                        ),
                      })
                    }
                  />
                )}
              </div>
            );
          })}

          <div className="flex flex-col gap-1">
            <span className="text-xs text-fm-secondary">Signed weight</span>
            <Input
              aria-label={`New port branch ${index + 1} signed weight`}
              disabled={!editable}
              inputMode="decimal"
              placeholder={index === 0 ? "1" : "-1"}
              type="text"
              value={branch.signedWeight}
              onChange={(e) =>
                update({
                  branches: draft.branches.map((r) =>
                    r.rowKey === branch.rowKey
                      ? { ...r, signedWeight: e.target.value }
                      : r,
                  ),
                })
              }
            />
          </div>
        </div>
      ))}

      {reason && draft.dirty ? (
        <div className="rounded-md border border-fm-subtle p-2 text-xs text-fm-secondary" role="status">
          {reason}
        </div>
      ) : null}
      {conflict ? (
        <div className="rounded-md border border-fm-subtle p-2 text-xs text-fm-secondary" role="alert">
          Scene changed on the server. Review and rebase or discard this new port draft.
        </div>
      ) : null}
      {feedback?.token === token ? (
        <div
          className="rounded-md border border-fm-subtle p-2 text-xs text-fm-primary"
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </div>
      ) : null}

      <div className="fm-microstrip-station-actions flex flex-wrap gap-2">
        <Button
          disabled={!editable}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() =>
            update({
              branches: [
                ...draft.branches,
                emptyAntennaPortBranch(`new-${nextRowRef.current++}`),
              ],
            })
          }
        >
          Add new port branch
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={refetch}>
          Refresh port sources
        </Button>
        <Button
          disabled={!draft.dirty || pending}
          size="sm"
          type="button"
          variant="ghost"
          onClick={discard}
        >
          Discard new port draft
        </Button>
        {conflict && validRevision ? (
          <Button
            disabled={pending || status !== "ready"}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              setLocal({ ...draft, baseRevision: revision, dirty: true });
              setRejectedToken(null);
            }}
          >
            Rebase new port draft
          </Button>
        ) : null}
        <Button
          disabled={!canCreate}
          size="sm"
          type="button"
          variant="primary"
          onClick={() => void handleCreate()}
        >
          Create port
        </Button>
      </div>
    </div>
  );
}

/* ============================================================================
 * Terminal Source & Port Observations Readout (`antennaTerminalSourceState`)
 * ============================================================================ */

export function TerminalSourceReadoutView({
  model,
  canNavigate,
  onOpenGeometry,
  onOpenPort,
}: {
  model: AntennaTerminalSourceState;
  canNavigate: boolean;
  onOpenGeometry: () => void;
  onOpenPort: (portId: string) => void;
}): ReactNode {
  const topMessages = [...new Set(model.messages)].map(sanitizeDisplayMessage);

  return (
    <div className="flex flex-col gap-3" data-testid="antenna-terminal-source">
      <p className="fm-inspector-hint">
        Source voltage or electrode actuators drive the circuit. Port inlet and outlet
        references observe current; signed branch weights do not impose electrode currents.
      </p>

      {topMessages.map((msg) => (
        <div
          key={msg}
          className="rounded-md border border-fm-subtle p-2 text-xs text-fm-secondary"
          role="status"
        >
          {msg}
        </div>
      ))}

      <div>
        <Button
          disabled={!canNavigate}
          size="sm"
          type="button"
          variant="secondary"
          onClick={onOpenGeometry}
        >
          Open Geometry
        </Button>
      </div>

      {keyedOccurrences(model.sources, (src) => String(src.transport.name)).map(
        ({ item: source, key }) => {
          const sourceTitle =
            source.kind === "authored"
              ? "Authored voltage source"
              : source.kind === "prepared"
                ? "Prepared mesh source"
                : source.kind === "preparation"
                  ? "External electrode transport"
                  : "Explicit current source";
          const sourceBadge =
            source.kind === "authored"
              ? "authored"
              : source.kind === "prepared"
                ? "prepared descriptor"
                : source.kind === "preparation"
                  ? "inspection mode"
                  : "review required";
          const sourceIssues = [...new Set(source.messages)].map(sanitizeDisplayMessage);

          return (
            <div
              key={key}
              className="flex flex-col gap-2 rounded-md border border-fm-subtle p-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-fm-primary">{sourceTitle}</span>
                <Badge variant="secondary">{sourceBadge}</Badge>
              </div>

              <div className="grid grid-cols-2 gap-1.5 text-xs">
                <span className="text-fm-secondary">Current transport</span>
                <span className="font-mono text-fm-primary">
                  {safeText(source.transport.name)}
                </span>
                {source.definition ? (
                  <>
                    <span className="text-fm-secondary">Source schema</span>
                    <span className="font-mono text-fm-primary">
                      {safeText(source.definition.schema_version)}
                    </span>
                  </>
                ) : null}
              </div>

              {sourceIssues.map((issue) => (
                <div
                  key={issue}
                  className="rounded border border-fm-subtle p-1.5 text-xs text-fm-secondary"
                >
                  {issue}
                </div>
              ))}

              {source.kind === "authored" ? (
                <div className="flex flex-col gap-2">
                  <div className="grid grid-cols-2 gap-1.5 text-xs">
                    <span className="text-fm-secondary">Closure ID</span>
                    <span className="font-mono text-fm-primary">
                      {safeText(source.definition?.closure_id)}
                    </span>
                  </div>
                  {keyedOccurrences(source.cuts, (cut) => String(cut.source_cut_id)).map(
                    ({ item: cut, key: cutKey }, cutIdx) => {
                      const plane = terminalSourceRecord(cut.plane);
                      const drive = terminalSourceRecord(cut.drive);
                      const region = terminalSourceRecord(cut.region);
                      const axisText = safeText(plane?.axis, "z");
                      const normalLabel =
                        plane?.normal === "positive_axis"
                          ? `+${axisText}`
                          : plane?.normal === "negative_axis"
                            ? `−${axisText}`
                            : "Not configured";
                      return (
                        <div
                          key={cutKey}
                          className="flex flex-col gap-1 rounded border border-fm-subtle p-2 text-xs"
                        >
                          <span className="font-medium text-fm-primary">
                            Voltage source cut {cutIdx + 1}
                          </span>
                          <div className="grid grid-cols-2 gap-1">
                            <span className="text-fm-secondary">Source cut ID</span>
                            <span className="font-mono">{safeText(cut.source_cut_id)}</span>
                            <span className="text-fm-secondary">Circuit ID</span>
                            <span className="font-mono">{safeText(cut.circuit_id)}</span>
                            <span className="text-fm-secondary">Conductor part</span>
                            <span className="font-mono">{safeText(region?.region_id)}</span>
                            <span className="text-fm-secondary">Drive ID</span>
                            <span className="font-mono">{safeText(drive?.drive_id)}</span>
                            <span className="text-fm-secondary">Potential jump V⁺ − V⁻</span>
                            <span>
                              {formatAntennaParameter(drive?.potential_jump_V, "V")}
                            </span>
                            <span className="text-fm-secondary">Coordinate frame</span>
                            <span>
                              {plane?.coordinate_frame === undefined
                                ? "world (legacy default)"
                                : safeText(plane.coordinate_frame)}
                            </span>
                            <span className="text-fm-secondary">Cut plane offset</span>
                            <span>{formatAntennaParameter(plane?.offset_m, "m")}</span>
                            <span className="text-fm-secondary">Oriented cut normal</span>
                            <span>{normalLabel}</span>
                          </div>
                        </div>
                      );
                    },
                  )}
                </div>
              ) : null}

              {source.kind === "prepared" ? (
                <div className="flex flex-col gap-2">
                  <div className="grid grid-cols-2 gap-1.5 text-xs">
                    <span className="text-fm-secondary">Prepared revision</span>
                    <span className="font-mono">{safeText(source.definition?.revision)}</span>
                    <span className="text-fm-secondary">Mesh digest</span>
                    <span className="font-mono">{safeText(source.definition?.mesh_digest)}</span>
                    <span className="text-fm-secondary">Authored input digest</span>
                    <span className="font-mono">
                      {safeText(source.definition?.authored_input_digest)}
                    </span>
                  </div>
                  {keyedOccurrences(source.cuts, (cut) => String(cut.id)).map(
                    ({ item: cut, key: cutKey }, cutIdx) => (
                      <div
                        key={cutKey}
                        className="flex flex-col gap-1 rounded border border-fm-subtle p-2 text-xs"
                      >
                        <span className="font-medium text-fm-primary">
                          Prepared source cut {cutIdx + 1}
                        </span>
                        <div className="grid grid-cols-2 gap-1">
                          <span className="text-fm-secondary">Source cut ID</span>
                          <span className="font-mono">{safeText(cut.id)}</span>
                          <span className="text-fm-secondary">Prepared potential drop</span>
                          <span>{formatAntennaParameter(cut.potential_drop_v, "V")}</span>
                          <span className="text-fm-secondary">Paired mesh faces</span>
                          <span>
                            {Array.isArray(cut.face_pairs)
                              ? String(cut.face_pairs.length)
                              : "Not materialized"}
                          </span>
                        </div>
                      </div>
                    ),
                  )}
                </div>
              ) : null}

              {keyedOccurrences(source.ports, (port) => port.id).map(
                ({ item: port, key: portKey }, portIdx) => {
                  const norm = terminalSourceRecord(terminalSourceRecord(port)?.normalization);
                  return (
                    <div
                      key={portKey}
                      className="flex flex-col gap-2 rounded border border-fm-subtle p-2 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-fm-primary">
                          Observation port {portIdx + 1} ({safeText(port.id)})
                        </span>
                        <Button
                          disabled={!canNavigate || !asString(port.id)}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => onOpenPort(port.id)}
                        >
                          Open port {safeText(port.id)}
                        </Button>
                      </div>
                      {norm ? (
                        <div className="grid grid-cols-2 gap-1">
                          <span className="text-fm-secondary">Source cut reference</span>
                          <span className="font-mono">{safeText(norm.source_cut_ref)}</span>
                          <span className="text-fm-secondary">Normalization orientation</span>
                          <span className="font-mono">{safeText(norm.orientation)}</span>
                        </div>
                      ) : null}
                      {keyedOccurrences(
                        (Array.isArray(port.branches) ? port.branches : []).filter(
                          (b) => b != null,
                        ),
                        (branch) => branch.id,
                      ).map(({ item: branch, key: brKey }, brOrdinal) => {
                        const sw =
                          asNumber(branch.signed_weight) ??
                          asNumber(asRecord(branch)?.weight);
                        return (
                          <div
                            key={brKey}
                            className="grid grid-cols-2 gap-1 rounded bg-fm-surface p-1.5"
                          >
                            <span className="text-fm-secondary">
                              Observed branch {brOrdinal + 1}
                            </span>
                            <span className="font-mono">{safeText(branch.id)}</span>
                            <span className="text-fm-secondary">Inlet / Outlet</span>
                            <span className="font-mono">
                              {safeText(branch.inlet_terminal_ref)} →{" "}
                              {safeText(branch.outlet_terminal_ref)}
                            </span>
                            <span className="text-fm-secondary">Signed weight</span>
                            <span className="font-mono">{safeNumericText(sw)}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                },
              )}
            </div>
          );
        },
      )}
    </div>
  );
}

/* ============================================================================
 * Per-Cap External Lead Preparation Editor (`object.antenna.terminals`)
 * ============================================================================ */

const DIRECTION_PRESETS: readonly { label: string; vec: [string, string, string] }[] = [
  { label: "+X", vec: ["1", "0", "0"] },
  { label: "−X", vec: ["-1", "0", "0"] },
  { label: "+Y", vec: ["0", "1", "0"] },
  { label: "−Y", vec: ["0", "-1", "0"] },
  { label: "+Z", vec: ["0", "0", "1"] },
  { label: "−Z", vec: ["0", "0", "-1"] },
];

export function TerminalLeadPreparationEditor({
  objectId,
  scene,
  ports,
  portId,
  driveId,
  revision,
  rows,
  disabled,
  onSelectPort,
  onChangeMeta,
  onChangeRow,
}: {
  objectId: string;
  scene: SceneResource | null;
  ports: readonly { id: string }[];
  portId: string;
  driveId: string;
  revision: string;
  rows: readonly AntennaTerminalLeadRow[];
  disabled?: boolean;
  onSelectPort: (portId: string) => void;
  onChangeMeta: (patch: { driveId?: string; revision?: string }) => void;
  onChangeRow: (index: number, patch: Partial<AntennaTerminalLeadRow>) => void;
}): ReactNode {
  const stages = (scene?.antenna_field_solve_stages ?? []).filter(
    (st) => st.source_object_id === objectId,
  );

  return (
    <div className="flex flex-col gap-3" data-testid="antenna-terminal-preparation-editor">
      <p className="fm-inspector-hint">
        Inspection only (external_electrode_truncation). Apply writes explicit straight-stub
        lead preparation and SHA-256 terminal boundary markers to the charge transport.
      </p>

      <div className="flex flex-col gap-1" data-row="terminalPrepPort">
        <span className="text-xs text-fm-secondary">Select port and load caps</span>
        <Select
          disabled={disabled || ports.length === 0}
          value={portId || undefined}
          onValueChange={onSelectPort}
        >
          <SelectTrigger aria-label="Terminal preparation port">
            <SelectValue
              placeholder={
                ports.length > 0
                  ? "Select port and load caps"
                  : "No ports configured on this antenna"
              }
            />
          </SelectTrigger>
          <SelectContent className="fm-inspector-select-content">
            {ports.map((port) => (
              <SelectItem key={port.id} value={port.id}>
                {port.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {portId ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fm-secondary">Drive ID</span>
              <Input
                aria-label="Drive ID"
                disabled={disabled}
                type="text"
                value={driveId}
                onChange={(e) => onChangeMeta({ driveId: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fm-secondary">Preparation revision</span>
              <Input
                aria-label="Preparation revision"
                disabled={disabled}
                placeholder="rev-1"
                type="text"
                value={revision}
                onChange={(e) => onChangeMeta({ revision: e.target.value })}
              />
            </div>
          </div>

          {rows.map((row, index) => (
            <div
              key={row.observationId}
              className="flex flex-col gap-2 rounded-md border border-fm-subtle p-2.5"
              data-cap-observation={row.observationId}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-fm-primary">
                  {row.conductorId} · {row.selector}
                </span>
                <span className="font-mono text-xs text-fm-muted">
                  {row.observationId}
                </span>
              </div>

              <div className="text-xs text-fm-secondary">
                Selector:{" "}
                <span className="font-mono text-fm-primary">
                  antenna_terminal:{row.conductorId}:{row.selector}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-fm-secondary">External actuator ID</span>
                  <Input
                    aria-label={`External actuator ID ${row.observationId}`}
                    disabled={disabled}
                    type="text"
                    value={row.actuatorId}
                    onChange={(e) =>
                      onChangeRow(index, { actuatorId: e.target.value })
                    }
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-fm-secondary">Extrusion layers</span>
                  <Input
                    aria-label={`Extrusion layers ${row.observationId}`}
                    disabled={disabled}
                    inputMode="numeric"
                    type="text"
                    value={row.layers}
                    onChange={(e) => onChangeRow(index, { layers: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-fm-secondary">Lead length [m]</span>
                  <Input
                    aria-label={`Lead length ${row.observationId}`}
                    disabled={disabled}
                    inputMode="decimal"
                    placeholder="200e-9"
                    type="text"
                    value={row.lengthM}
                    onChange={(e) => onChangeRow(index, { lengthM: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-fm-secondary">
                    Lead conductivity [S/m]
                  </span>
                  <Input
                    aria-label={`Lead conductivity ${row.observationId}`}
                    disabled={disabled}
                    inputMode="decimal"
                    placeholder="5.96e7"
                    type="text"
                    value={row.conductivitySpm}
                    onChange={(e) =>
                      onChangeRow(index, { conductivitySpm: e.target.value })
                    }
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-fm-secondary">
                    World outward unit direction [dx, dy, dz]
                  </span>
                  <div className="flex gap-1">
                    {DIRECTION_PRESETS.map((preset) => (
                      <Button
                        key={preset.label}
                        disabled={disabled}
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={() => onChangeRow(index, { direction: [...preset.vec] })}
                      >
                        {preset.label}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(["x", "y", "z"] as const).map((axis, compIdx) => (
                    <Input
                      key={axis}
                      aria-label={`World outward direction ${axis} ${row.observationId}`}
                      disabled={disabled}
                      inputMode="decimal"
                      placeholder={`d${axis}`}
                      type="text"
                      value={row.direction[compIdx]}
                      onChange={(e) => {
                        const nextDir: [string, string, string] = [
                          row.direction[0],
                          row.direction[1],
                          row.direction[2],
                        ];
                        nextDir[compIdx] = e.target.value;
                        onChangeRow(index, { direction: nextDir });
                      }}
                    />
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-xs text-fm-secondary">
                  Signed outward actuator current [A]
                </span>
                <Input
                  aria-label={`Signed outward actuator current ${row.observationId}`}
                  disabled={disabled}
                  inputMode="decimal"
                  placeholder={row.selector === "local_u_min" ? "-0.01" : "0.01"}
                  type="text"
                  value={row.currentA}
                  onChange={(e) => onChangeRow(index, { currentA: e.target.value })}
                />
              </div>
            </div>
          ))}
        </>
      ) : null}

      {stages.length > 0 ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-fm-subtle p-2">
          {stages.map((stage) => (
            <div key={stage.id} className="flex flex-col gap-0.5 text-xs">
              <span className="font-medium text-fm-primary">
                Inspection readiness · {stage.id}
              </span>
              <span className="text-fm-secondary">
                {sanitizeDisplayMessage(
                  antennaInspectionValidationMessages(stage, scene).join(" · "),
                )}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================================
 * Editable Port Branches Editor (`object.antenna.port`)
 * ============================================================================ */

export function EditablePortBranchesEditor({
  branches,
  terminalChoices,
  disabled,
  onChange,
}: {
  branches: readonly AntennaPortBranchDraft[];
  terminalChoices: readonly AntennaPortTerminalChoice[];
  disabled?: boolean;
  onChange: (next: AntennaPortBranchDraft[]) => void;
}): ReactNode {
  const nextRowRef = useRef(1);

  const updateBranch = (
    rowKey: string,
    patch: Partial<Omit<AntennaPortBranchDraft, "rowKey">>,
  ) => {
    onChange(branches.map((br) => (br.rowKey === rowKey ? { ...br, ...patch } : br)));
  };

  return (
    <div className="flex flex-col gap-3" data-testid="antenna-port-branches-editor">
      {branches.map((branch, index) => (
        <div
          key={branch.rowKey}
          className="flex flex-col gap-2 rounded-md border border-fm-subtle p-2.5"
          data-branch-index={index}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-fm-primary">
              Branch {index + 1}
            </span>
            <Button
              aria-label={`Remove port branch ${index + 1}`}
              disabled={disabled || branches.length <= 1}
              size="sm"
              type="button"
              variant="ghost"
              onClick={() =>
                onChange(branches.filter((item) => item.rowKey !== branch.rowKey))
              }
            >
              Remove branch
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fm-secondary">Branch ID</span>
              <Input
                aria-label={`Branch ${index + 1} ID`}
                disabled={disabled}
                type="text"
                value={branch.id}
                onChange={(e) => updateBranch(branch.rowKey, { id: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fm-secondary">Signed weight</span>
              <Input
                aria-label={`Branch ${index + 1} signed weight`}
                disabled={disabled}
                inputMode="decimal"
                type="text"
                value={branch.signedWeight}
                onChange={(e) =>
                  updateBranch(branch.rowKey, { signedWeight: e.target.value })
                }
              />
            </div>
          </div>

          {(["inletTerminalRef", "outletTerminalRef"] as const).map((field, roleIdx) => {
            const roleName = roleIdx === 0 ? "inlet" : "outlet";
            const label = `Branch ${index + 1} ${roleName} terminal`;
            const currentVal = branch[field];
            return (
              <div
                key={field}
                className="flex flex-col gap-1"
                data-editor-branch={index}
                data-terminal-role={roleName}
              >
                <span className="text-xs text-fm-secondary">
                  {roleIdx === 0 ? "Inlet terminal (+)" : "Outlet terminal (−)"}
                </span>
                {terminalChoices.length > 0 ? (
                  <Select
                    disabled={disabled}
                    value={currentVal || undefined}
                    onValueChange={(val) => updateBranch(branch.rowKey, { [field]: val })}
                  >
                    <SelectTrigger aria-label={label}>
                      <SelectValue placeholder="Select an existing terminal" />
                    </SelectTrigger>
                    <SelectContent className="fm-inspector-select-content">
                      {currentVal && !terminalChoices.some((c) => c.id === currentVal) ? (
                        <SelectItem value={currentVal}>
                          {currentVal} (current)
                        </SelectItem>
                      ) : null}
                      {terminalChoices.map((choice) => (
                        <SelectItem key={choice.id} value={choice.id}>
                          {choice.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    aria-label={label}
                    disabled={disabled}
                    type="text"
                    value={currentVal}
                    onChange={(e) =>
                      updateBranch(branch.rowKey, { [field]: e.target.value })
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      ))}

      <div className="flex items-center gap-2">
        <Button
          disabled={disabled}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() =>
            onChange([
              ...branches,
              {
                id: `return_${branches.length}`,
                inletTerminalRef: "",
                originalId: null,
                outletTerminalRef: "",
                rowKey: `added-${branches.length}-${nextRowRef.current++}`,
                signedWeight: "-1",
              },
            ])
          }
        >
          Add branch
        </Button>
      </div>
    </div>
  );
}
