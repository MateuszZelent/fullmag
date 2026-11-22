"use client";

import {
  Check,
  Copy,
  FileCode2,
  RefreshCw,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  KnownSceneCurrentTransport,
  KnownSceneSpinTransport,
  SceneCurrentTransport,
  SceneResource,
  SceneSpinTransport,
  TransportAuthoringCapabilityMap,
  TransportValidationRequest,
  TransportValidationResponse,
} from "@/kernel/api/apiTypes";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import type { components } from "@/kernel/api/generated/openapi-v2-types";
import {
  authoringWriteOptions,
  captureAuthoringMutationFence,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  publishCommittedSceneResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import type { ResourceKey } from "@/kernel/resources/resourceTypes";
import {
  sessionRequestScopeKey,
  type SessionResourceIdentity,
} from "@/kernel/resources/sessionResourceIdentity";
import { invalidateSpinAuthoringResources } from "@/kernel/resources/spinAuthoringResources";
import {
  useSessionResourceIdentity,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { getTransportAuthoringCapability } from "@/shared/domain/physics/transportAuthoringCapabilities";
import {
  isKnownCurrentTransport,
  isKnownSpinTransport,
} from "@/shared/domain/physics/transportRecognition";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

import {
  InspectorTemplate,
  useInspectorSpecController,
  type InspectorBreadcrumbItem,
  type InspectorNotice,
  type InspectorSpec,
  type InspectorSpecController,
} from "../../template";

export type KnownSceneSpinTorque = components["schemas"]["KnownSceneSpinTorque"];
export type KnownSceneOerstedField = components["schemas"]["KnownSceneOerstedField"];
export type SceneSpinInterface = components["schemas"]["SceneSpinInterface"];
export type SceneTimeEnvelope = components["schemas"]["SceneTimeEnvelope"];
export type SceneOerstedTimeDependence =
  components["schemas"]["SceneOerstedTimeDependence"];
export type ScenePrescribedSotDrive =
  components["schemas"]["ScenePrescribedSotDrive"];
export type SceneRegionRef = components["schemas"]["SceneRegionRef"];
export type SlonczewskiRealization =
  components["schemas"]["SlonczewskiRealization"];
export type SceneCompatibilityOrigin =
  components["schemas"]["SceneCompatibilityOrigin"];
export type SceneTimeEnvelopePoint =
  components["schemas"]["SceneTimeEnvelopePoint"];

export interface TransportDetailItem {
  readonly label: string;
  readonly value: string | null | undefined;
  readonly mono?: boolean;
}

export const TRANSPORT_VALIDATION_VERSION = "transport-authoring-validation.v1";
export const NEW_RESOURCE_SENTINEL = "__fm_transport_new__";
export const EMPTY_SELECT_SENTINEL = "__fm_transport_empty__";

export const RESOURCE_KEYS = {
  currentTransport: ["model.current-transports", "model.physics-graph"] as readonly ResourceKey[],
  spinTransport: [
    "model.spin-transports",
    "model.spin-interfaces",
    "model.physics-graph",
  ] as readonly ResourceKey[],
  spinTorque: ["model.spin-torques"] as readonly ResourceKey[],
  oerstedField: ["model.oersted-fields"] as readonly ResourceKey[],
};

export interface TransportSessionSnapshot {
  readonly sessionScopeKey: string | null;
  readonly capabilities: TransportAuthoringCapabilityMap | null;
  readonly hasLiveSessionStatus: boolean;
  readonly probeElement: ReactNode;
}

function LiveSessionStatusProbe({
  onChange,
}: {
  onChange: (
    identity: SessionResourceIdentity | null,
    capabilities: TransportAuthoringCapabilityMap | null,
  ) => void;
}) {
  const identity = useSessionResourceIdentity();
  const capabilities = useSessionStatusSelector(
    (status) => status.data?.capabilities.transport_authoring ?? null,
    { enabled: true },
  );
  useLayoutEffect(() => {
    onChange(identity, capabilities);
  }, [capabilities, identity, onChange]);
  return null;
}

export function useTransportSessionContext(): TransportSessionSnapshot {
  const kernel = useKernel();
  const hasResourceStore =
    typeof (kernel.resources as { getRevision?: unknown })?.getRevision === "function";
  const hasSessionApi = Boolean(
    (kernel.api as { sessions?: unknown })?.sessions,
  );
  const canSubscribeStatus = hasResourceStore || hasSessionApi;

  const [probeState, setProbeState] = useState<{
    identity: SessionResourceIdentity | null;
    capabilities: TransportAuthoringCapabilityMap | null;
    populated: boolean;
  }>({
    identity: null,
    capabilities: null,
    populated: false,
  });

  const handleProbeChange = useCallback(
    (
      identity: SessionResourceIdentity | null,
      capabilities: TransportAuthoringCapabilityMap | null,
    ) => {
      setProbeState((prev) => {
        if (
          prev.populated &&
          JSON.stringify(prev.identity) === JSON.stringify(identity) &&
          JSON.stringify(prev.capabilities) === JSON.stringify(capabilities)
        ) {
          return prev;
        }
        return { identity, capabilities, populated: true };
      });
    },
    [],
  );

  const derivedScopeKey =
    sessionRequestScopeKey(probeState.identity) ??
    kernel.commands?.getSessionScopeKey?.() ??
    null;

  return {
    sessionScopeKey: derivedScopeKey,
    capabilities: probeState.capabilities,
    hasLiveSessionStatus: canSubscribeStatus,
    probeElement: canSubscribeStatus ? (
      <LiveSessionStatusProbe onChange={handleProbeChange} />
    ) : null,
  };
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function isValidSurfaceRef(v: unknown): boolean {
  if (!isPlainObj(v)) return false;
  const keys = Object.keys(v);
  if (keys.some((k) => k !== "object_id" && k !== "surface_id" && k !== "orientation")) {
    return false;
  }
  return (
    typeof v.object_id === "string" &&
    v.object_id.trim().length > 0 &&
    typeof v.surface_id === "string" &&
    v.surface_id.trim().length > 0 &&
    Array.isArray(v.orientation) &&
    v.orientation.length === 3 &&
    v.orientation.every((x) => typeof x === "number" && Number.isFinite(x))
  );
}

function normalizeCurrentForRecognition(value: unknown): SceneCurrentTransport | null {
  if (!isPlainObj(value)) return null;
  if (
    value.external_lead_preparation !== undefined &&
    value.external_lead_preparation !== null &&
    !isPlainObj(value.external_lead_preparation)
  ) {
    return null;
  }
  const clone: Record<string, unknown> = { ...value };
  delete clone.external_lead_preparation;

  if (isPlainObj(clone.structured_current_closure) && Array.isArray(clone.structured_current_closure.source_cuts)) {
    const cuts = clone.structured_current_closure.source_cuts;
    const normalizedCuts: unknown[] = [];
    for (const cut of cuts) {
      if (!isPlainObj(cut) || !isPlainObj(cut.plane)) {
        normalizedCuts.push(cut);
        continue;
      }
      const frame = cut.plane.coordinate_frame;
      if (frame !== undefined && frame !== null && frame !== "world" && frame !== "object") {
        return null;
      }
      const planeClone = { ...cut.plane };
      delete planeClone.coordinate_frame;
      normalizedCuts.push({ ...cut, plane: planeClone });
    }
    clone.structured_current_closure = {
      ...clone.structured_current_closure,
      source_cuts: normalizedCuts,
    };
  }
  return clone as SceneCurrentTransport;
}

function normalizeSpinForRecognition(value: unknown): SceneSpinTransport | null {
  if (!isPlainObj(value)) return null;
  const clone: Record<string, unknown> = { ...value };
  if (Array.isArray(clone.interfaces)) {
    const normalizedIfaces: unknown[] = [];
    for (const iface of clone.interfaces) {
      if (!isPlainObj(iface) || iface.kind !== "mixing_conductance") {
        normalizedIfaces.push(iface);
        continue;
      }
      if (
        iface.normal_surface !== undefined &&
        iface.normal_surface !== null &&
        !isValidSurfaceRef(iface.normal_surface)
      ) {
        return null;
      }
      if (
        iface.ferromagnet_surface !== undefined &&
        iface.ferromagnet_surface !== null &&
        !isValidSurfaceRef(iface.ferromagnet_surface)
      ) {
        return null;
      }
      if (
        iface.g_sml_Spm2 !== undefined &&
        iface.g_sml_Spm2 !== null &&
        (typeof iface.g_sml_Spm2 !== "number" || !Number.isFinite(iface.g_sml_Spm2))
      ) {
        return null;
      }
      const ifaceClone = { ...iface };
      delete ifaceClone.normal_surface;
      delete ifaceClone.ferromagnet_surface;
      delete ifaceClone.g_sml_Spm2;
      normalizedIfaces.push(ifaceClone);
    }
    clone.interfaces = normalizedIfaces;
  }
  return clone as SceneSpinTransport;
}

export function isEditableCurrentTransport(
  value: SceneCurrentTransport,
): value is KnownSceneCurrentTransport {
  const probe = normalizeCurrentForRecognition(value);
  return probe !== null && isKnownCurrentTransport(probe);
}

export function isEditableSpinTransport(
  value: SceneSpinTransport,
): value is KnownSceneSpinTransport {
  const probe = normalizeSpinForRecognition(value);
  return probe !== null && isKnownSpinTransport(probe);
}

export interface TransportCapabilityEvaluation {
  readonly authoring_allowed: boolean;
  readonly status: string;
  readonly reason: string;
}

export function evaluateTransportCapability(
  family: "current_transport" | "spin_transport",
  candidateResource: unknown,
  sceneData: SceneResource | null | undefined,
  session: TransportSessionSnapshot,
): TransportCapabilityEvaluation {
  if (session.capabilities && sceneData) {
    const normalizedCandidate =
      family === "current_transport"
        ? (normalizeCurrentForRecognition(candidateResource) ?? candidateResource)
        : (normalizeSpinForRecognition(candidateResource) ?? candidateResource);
    const normalizedScene: SceneResource = {
      ...sceneData,
      ...(Array.isArray(sceneData.current_transports)
        ? {
            current_transports: sceneData.current_transports.map(
              (item) => normalizeCurrentForRecognition(item) ?? item,
            ),
          }
        : {}),
      ...(Array.isArray(sceneData.spin_transports)
        ? {
            spin_transports: sceneData.spin_transports.map(
              (item) => normalizeSpinForRecognition(item) ?? item,
            ),
          }
        : {}),
    };
    const evaluated = getTransportAuthoringCapability(
      family,
      normalizedCandidate,
      normalizedScene,
      session.capabilities,
    );
    if (evaluated) {
      return {
        authoring_allowed: evaluated.authoring_allowed,
        status: evaluated.status,
        reason: evaluated.reason,
      };
    }
  }
  if (!session.hasLiveSessionStatus) {
    return {
      authoring_allowed: true,
      status: "semantic_only",
      reason: "Semantic authoring enabled.",
    };
  }
  return {
    authoring_allowed: false,
    status: "checking",
    reason: "Transport authoring capabilities are loading or not yet confirmed.",
  };
}

export function evaluateSpinM1Capability(
  session: TransportSessionSnapshot,
): TransportCapabilityEvaluation {
  const m1 = session.capabilities?.m1_one_way_steady;
  if (m1) {
    return {
      authoring_allowed: Boolean(m1.authoring_allowed),
      status: m1.status,
      reason: m1.reason || "M1 one-way steady authoring policy evaluated.",
    };
  }
  if (!session.hasLiveSessionStatus) {
    return {
      authoring_allowed: true,
      status: "semantic_only",
      reason: "Semantic authoring enabled.",
    };
  }
  return {
    authoring_allowed: false,
    status: "checking",
    reason: "Authoring capability status is loading or not yet confirmed.",
  };
}

export interface DebouncedValidationResult {
  readonly validation: TransportValidationResponse | null;
  readonly validationError: string | null;
  readonly buildError: string | null;
  readonly setManualValidation: (
    key: string,
    response: TransportValidationResponse | null,
    error?: string | null,
  ) => void;
  readonly validationKey: string;
}

export function useDebouncedTransportValidation({
  enabled,
  draftSerialized,
  draftKey,
  sceneRevision,
  sessionScopeKey,
  buildRequest,
}: {
  enabled: boolean;
  draftSerialized: string;
  draftKey: string;
  sceneRevision: number | undefined;
  sessionScopeKey: string | null;
  buildRequest: () => TransportValidationRequest;
}): DebouncedValidationResult {
  const kernel = useKernel();
  const validationKey = `${draftKey}:${sceneRevision ?? "none"}:${draftSerialized}`;
  const activeValidationKeyRef = useRef(validationKey);
  useLayoutEffect(() => {
    activeValidationKeyRef.current = validationKey;
  }, [validationKey]);

  const syncBuildCheck = useMemo(() => {
    if (!enabled || sceneRevision === undefined) {
      return { request: null as TransportValidationRequest | null, error: null as string | null };
    }
    try {
      return { request: buildRequest(), error: null };
    } catch (error) {
      return {
        request: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // draftSerialized intentionally triggers re-evaluation on every draft change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sceneRevision, draftSerialized, draftKey]);

  const [state, setState] = useState<{
    key: string;
    response: TransportValidationResponse | null;
    error: string | null;
  }>({ key: "", response: null, error: null });

  const setManualValidation = useCallback(
    (
      key: string,
      response: TransportValidationResponse | null,
      error: string | null = null,
    ) => {
      setState({ key, response, error });
    },
    [],
  );

  useEffect(() => {
    const validateFn = kernel.api.model.validateTransport;
    if (
      !enabled ||
      !sessionScopeKey ||
      sceneRevision === undefined ||
      !syncBuildCheck.request ||
      typeof validateFn !== "function"
    ) {
      return;
    }
    const requestPayload = syncBuildCheck.request;
    const expectedKey = validationKey;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void validateFn(requestPayload, {
        sessionScopeKey,
        signal: controller.signal,
      })
        .then((response) => {
          const currentCommandScope = kernel.commands?.getSessionScopeKey?.();
          const scopeMatches = !currentCommandScope || currentCommandScope === sessionScopeKey;
          if (
            !controller.signal.aborted &&
            scopeMatches &&
            activeValidationKeyRef.current === expectedKey
          ) {
            setState({ key: expectedKey, response, error: null });
          }
        })
        .catch((error: unknown) => {
          const currentCommandScope = kernel.commands?.getSessionScopeKey?.();
          const scopeMatches = !currentCommandScope || currentCommandScope === sessionScopeKey;
          if (
            !controller.signal.aborted &&
            scopeMatches &&
            activeValidationKeyRef.current === expectedKey
          ) {
            setState({
              key: expectedKey,
              response: null,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
    }, 180);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    enabled,
    kernel.api.model.validateTransport,
    kernel.commands,
    sceneRevision,
    sessionScopeKey,
    syncBuildCheck.request,
    validationKey,
  ]);

  const matchesKey = state.key === validationKey;
  return {
    validation: matchesKey ? state.response : null,
    validationError: matchesKey ? state.error : null,
    buildError: syncBuildCheck.error,
    setManualValidation,
    validationKey,
  };
}

export async function runPreCommitTransportValidation({
  validateTransport,
  sessionScopeKey,
  request,
  validationKey,
  setManualValidation,
}: {
  validateTransport:
    | ((
        req: TransportValidationRequest,
        options?: { sessionScopeKey?: string; signal?: AbortSignal },
      ) => Promise<TransportValidationResponse>)
    | undefined;
  sessionScopeKey: string | null;
  request: TransportValidationRequest;
  validationKey?: string;
  setManualValidation?: (
    key: string,
    response: TransportValidationResponse | null,
    error?: string | null,
  ) => void;
}): Promise<TransportValidationResponse | null> {
  if (typeof validateTransport !== "function") return null;
  const checked = await validateTransport(
    request,
    sessionScopeKey ? { sessionScopeKey } : undefined,
  );
  if (validationKey && setManualValidation) {
    setManualValidation(validationKey, checked, null);
  }
  if (!checked.semantic.valid || !checked.execution.authoring_allowed) {
    throw new Error(
      checked.semantic.issues[0]?.message ??
        checked.execution.reason ??
        "Candidate did not pass clone-only transport validation.",
    );
  }
  return checked;
}

export function formatLaneSummary(lane: unknown): string {
  if (!lane || typeof lane !== "object") return "Semantic authoring";
  const rec = lane as Record<string, unknown>;
  const parts = [
    rec.discretization,
    rec.device,
    rec.precision,
    rec.execution_mode ?? rec.mode,
  ].filter((item) => typeof item === "string" && item.trim().length > 0);
  return parts.length > 0 ? parts.join(" · ") : JSON.stringify(lane);
}

export function buildValidationNotices<TDraft>({
  capability,
  validation,
  validationError,
  buildError,
  conflicts,
  hasRevisionConflict,
  onRebase,
  targetMissingMessage,
}: {
  capability: TransportCapabilityEvaluation;
  validation: TransportValidationResponse | null;
  validationError: string | null;
  buildError: string | null;
  conflicts: readonly string[];
  hasRevisionConflict: boolean;
  onRebase: () => void;
  targetMissingMessage?: string | null;
}): InspectorNotice<TDraft>[] {
  const notices: InspectorNotice<TDraft>[] = [];

  if (targetMissingMessage) {
    notices.push({
      id: "target-missing",
      tone: "err",
      title: "Selected target no longer exists",
      text: targetMissingMessage,
    });
  }

  if (conflicts.length > 0 || hasRevisionConflict) {
    const detail =
      conflicts.length > 0
        ? `Server updated overlapping field(s): ${conflicts.join(", ")}. Review and rebase before applying.`
        : "Scene revision advanced before commit (HTTP 409). Refresh and rebase your draft before applying.";
    notices.push({
      id: "revision-conflict",
      tone: "warn",
      title: "Revision conflict detected",
      text: detail,
      quickFix: {
        label: "Rebase Draft",
        onApply: () => onRebase(),
      },
    });
  }

  if (!capability.authoring_allowed) {
    notices.push({
      id: "capability-gate",
      tone: "warn",
      title: "Authoring capability gate",
      text: capability.reason,
    });
  }

  if (buildError) {
    notices.push({
      id: "candidate-build-error",
      tone: "err",
      title: "Draft validation issue",
      text: buildError,
    });
  } else if (validationError) {
    notices.push({
      id: "transport-validation-error",
      tone: "err",
      title: "Clone-only validation failed",
      text: validationError,
    });
  }

  if (validation) {
    for (const issue of validation.semantic.issues) {
      notices.push({
        id: `semantic-${issue.code}-${issue.path}`,
        tone: "err",
        title: issue.path || "Semantic issue",
        text: `${issue.path ? `${issue.path}: ` : ""}${issue.message}`,
      });
    }
    if (!validation.execution.authoring_allowed && validation.execution.reason) {
      notices.push({
        id: "execution-gate",
        tone: "err",
        title: `Qualification: ${validation.execution.qualification}`,
        text: validation.execution.reason,
      });
    } else {
      const reqLane = validation.execution.requested_lane
        ? formatLaneSummary(validation.execution.requested_lane)
        : "semantic authoring";
      const resLane = validation.execution.resolved_lane
        ? formatLaneSummary(validation.execution.resolved_lane)
        : "pending runtime resolution";
      notices.push({
        id: "qualification-status",
        tone: "info",
        title: `Qualification: ${validation.execution.qualification}`,
        text: `Requested lane: ${reqLane} · Resolved lane: ${resLane}${validation.execution.reason ? ` · ${validation.execution.reason}` : ""}`,
      });
    }
  }

  return notices;
}

export function buildValidationDetails(
  capability: TransportCapabilityEvaluation,
  validation: TransportValidationResponse | null,
): TransportDetailItem[] {
  return [
    {
      label: "Qualification",
      value: validation?.execution.qualification ?? capability.status,
      mono: true,
    },
    {
      label: "Requested lane",
      value: validation?.execution.requested_lane
        ? formatLaneSummary(validation.execution.requested_lane)
        : "semantic authoring",
      mono: true,
    },
    {
      label: "Resolved lane",
      value: validation?.execution.resolved_lane
        ? formatLaneSummary(validation.execution.resolved_lane)
        : "not resolved",
      mono: true,
    },
    {
      label: "Execution note",
      value: validation?.execution.reason ?? capability.reason,
    },
  ];
}

export function computeTransportLockReason({
  capability,
  validation,
  validationError,
  buildError,
  hasConflict,
  targetMissingMessage,
  extraLockReason,
}: {
  capability: TransportCapabilityEvaluation;
  validation: TransportValidationResponse | null;
  validationError: string | null;
  buildError: string | null;
  hasConflict: boolean;
  targetMissingMessage?: string | null;
  extraLockReason?: string | null;
}): string | null {
  if (targetMissingMessage) return targetMissingMessage;
  if (extraLockReason) return extraLockReason;
  if (hasConflict) {
    return "Conflicting server revision detected. Click Rebase Draft or Revert before applying.";
  }
  if (!capability.authoring_allowed) return capability.reason;
  if (buildError) return buildError;
  if (validationError) return validationError;
  if (validation && (!validation.semantic.valid || !validation.execution.authoring_allowed)) {
    return (
      validation.semantic.issues[0]?.message ??
      validation.execution.reason ??
      "Candidate is not authoring-ready."
    );
  }
  return null;
}

export function useThreeWayConflictState<TDraft extends object>({
  targetKey,
  serverDraft,
  currentDraft,
  dirtyFields,
  reconcile,
}: {
  targetKey: string;
  serverDraft: TDraft;
  currentDraft: TDraft;
  dirtyFields: ReadonlySet<string>;
  reconcile: (
    server: TDraft,
    local: TDraft,
    baseline: TDraft,
  ) => { draft: TDraft; conflicts: readonly (string | keyof TDraft)[] };
}) {
  const [state, setState] = useState<{
    key: string;
    pinnedBaseline: TDraft;
    httpConflictRevision: number | null;
  }>(() => ({
    key: targetKey,
    pinnedBaseline: serverDraft,
    httpConflictRevision: null,
  }));

  if (state.key !== targetKey) {
    setState({
      key: targetKey,
      pinnedBaseline: serverDraft,
      httpConflictRevision: null,
    });
  }

  const effectivePinnedBaseline = useMemo(() => {
    if (state.key !== targetKey || dirtyFields.size === 0) return serverDraft;
    const merged = { ...serverDraft };
    for (const fieldKey of dirtyFields) {
      if (fieldKey in state.pinnedBaseline) {
        (merged as Record<string, unknown>)[fieldKey] = (
          state.pinnedBaseline as Record<string, unknown>
        )[fieldKey];
      }
    }
    return merged;
  }, [dirtyFields, serverDraft, state.key, state.pinnedBaseline, targetKey]);

  const reconciled = useMemo(() => {
    if (dirtyFields.size === 0) {
      return { draft: serverDraft, conflicts: [] as string[] };
    }
    const result = reconcile(serverDraft, currentDraft, effectivePinnedBaseline);
    return {
      draft: result.draft,
      conflicts: result.conflicts.map((item) => String(item)),
    };
  }, [currentDraft, dirtyFields.size, effectivePinnedBaseline, reconcile, serverDraft]);

  const rebaseDraft = useCallback(() => {
    setState({
      key: targetKey,
      pinnedBaseline: serverDraft,
      httpConflictRevision: null,
    });
  }, [serverDraft, targetKey]);

  const markHttpConflict = useCallback(
    (revision: number) => {
      setState((prev) => ({
        key: targetKey,
        pinnedBaseline: prev.key === targetKey ? prev.pinnedBaseline : serverDraft,
        httpConflictRevision: revision,
      }));
    },
    [serverDraft, targetKey],
  );

  const clearConflict = useCallback(() => {
    setState({
      key: targetKey,
      pinnedBaseline: serverDraft,
      httpConflictRevision: null,
    });
  }, [serverDraft, targetKey]);

  return {
    conflicts: reconciled.conflicts,
    hasRevisionConflict: state.key === targetKey && state.httpConflictRevision !== null,
    hasConflict:
      reconciled.conflicts.length > 0 ||
      (state.key === targetKey && state.httpConflictRevision !== null),
    rebaseDraft,
    markHttpConflict,
    clearConflict,
  };
}

export async function executeAuthoringHistoryCommit<
  TCommit extends { scene_revision: number; committed_scene?: SceneResource },
>({
  kernel,
  sessionScopeKey,
  label,
  submittedRevision,
  resourceKeys,
  onConflict409,
  mutate,
}: {
  kernel: ReturnType<typeof useKernel>;
  sessionScopeKey: string | null;
  label: string;
  submittedRevision: number;
  resourceKeys: readonly ResourceKey[];
  onConflict409?: (revision: number) => void;
  mutate: (args: {
    committedRevision: number;
    requestOptions: { baseRevision?: number; sessionScopeKey?: string } | undefined;
  }) => Promise<TCommit>;
}): Promise<TCommit> {
  const cmdContext = createCommandContext(
    "inspector",
    kernel,
    sessionScopeKey ? { sessionScopeKey } : {},
  );
  const mutationContext = sessionScopeKey
    ? captureAuthoringMutationFence(cmdContext)
    : cmdContext;

  try {
    const commit = await runAuthoringMutationWithHistory(
      mutationContext,
      label,
      async ({ baseRevision }) => {
        if (baseRevision !== null && baseRevision !== submittedRevision) {
          throw new ControlRoomApiError(
            "Scene revision changed before commit; refresh and rebase.",
            409,
          );
        }
        const requestOptions = authoringWriteOptions(
          null,
          mutationContext.sessionScopeKey ?? sessionScopeKey,
        );
        return mutate({ committedRevision: submittedRevision, requestOptions });
      },
      undefined,
      { expectedSceneRevision: submittedRevision },
    );

    if (sessionScopeKey && mutationContext.isCurrentSessionScope?.() === false) {
      throw new Error("Session changed before commit completed.");
    }

    if (commit.committed_scene) {
      publishCommittedSceneResource(
        kernel.resources,
        commit.committed_scene,
        commit.scene_revision,
        undefined,
        false,
        sessionScopeKey ?? undefined,
        kernel.api.resourceCacheScope,
      );
    }
    invalidateSpinAuthoringResources(kernel.resources, commit, resourceKeys);
    return commit;
  } catch (error) {
    if (error instanceof ControlRoomApiError && error.status === 409) {
      onConflict409?.(submittedRevision);
    }
    throw error;
  }
}

export function extractInitialRegionId(selection: Selection): string | null {
  const ref = selection.ref;
  if (!ref) return null;
  if ("regionId" in ref && typeof ref.regionId === "string" && ref.regionId.trim()) {
    return ref.regionId;
  }
  return null;
}

export function useAuthoringSceneData(): SceneResource | null {
  const scene = useSceneResource();
  return scene.data ?? null;
}

/* ── Reusable In-Panel Resource Switcher Bar (Radix Select) ── */

export interface ResourceSwitcherOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export function ResourceSwitcherBar({
  label = "Resource",
  newOptionLabel = "New resource",
  value,
  options,
  disabled,
  onChange,
}: {
  label?: string;
  newOptionLabel?: string;
  value: string;
  options: readonly ResourceSwitcherOption[];
  disabled?: boolean;
  onChange: (nextValue: string) => void;
}) {
  const selectValue = value || NEW_RESOURCE_SENTINEL;
  return (
    <div className="flex flex-col gap-1.5" data-slot="transport-resource-switcher">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--fm-text-muted)]">{label}</span>
        {disabled ? (
          <span className="text-xs text-[var(--fm-text-muted)]" role="status">
            Apply or Revert before switching
          </span>
        ) : null}
      </div>
      <Select
        disabled={disabled}
        value={selectValue}
        onValueChange={(next) => {
          if (disabled) return;
          onChange(next === NEW_RESOURCE_SENTINEL ? "" : next);
        }}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" position="popper">
          <SelectGroup>
            <SelectItem value={NEW_RESOURCE_SENTINEL}>{newOptionLabel}</SelectItem>
            {options.map((opt) => (
              <SelectItem
                key={opt.value}
                disabled={opt.disabled}
                value={opt.value}
              >
                {opt.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

/* ── Controlled Host Connecting `useInspectorSpecController` + `InspectorTemplate` ── */

export function TransportTemplateRenderer<TDraft extends object>({
  spec,
  selection,
  controller,
  onCoupledFieldChange,
  children,
}: {
  spec: InspectorSpec<TDraft>;
  selection: Selection;
  controller: InspectorSpecController<TDraft>;
  onCoupledFieldChange?: <K extends keyof TDraft & string>(
    key: K,
    value: TDraft[K],
    currentDraft: TDraft,
  ) => Partial<TDraft> | null;
  children?: ReactNode;
}) {
  const kernel = useKernel();
  const [codePreview, setCodePreview] = useState<{
    title: string;
    language: "python" | "json";
    code: string;
  } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [statusToast, setStatusToast] = useState<string | null>(null);

  const handleSelectNode = useCallback(
    (next: Omit<Selection, "moduleSource">) => {
      kernel.selection.set(next, "inspector");
    },
    [kernel.selection],
  );

  const handleFitView = useCallback(
    (commandId?: Parameters<typeof kernel.commands.execute>[0]) => {
      const resolvedId = commandId ?? "viewport-3d.fit-selection";
      void kernel.commands.execute(resolvedId, createCommandContext("inspector", kernel));
    },
    [kernel],
  );

  const handleHideInspector = useCallback(() => {
    kernel.layout.setPanelVisible("right", false);
  }, [kernel.layout]);

  const handleOpenCodePreview = useCallback(
    (title: string, language: "python" | "json", code: string) => {
      setCopiedCode(false);
      setCodePreview({ title, language, code });
    },
    [],
  );

  const handleNotify = useCallback((title: string, description?: string) => {
    setStatusToast(description ? `${title}: ${description}` : title);
  }, []);

  const handleFieldChange = useCallback(
    <K extends keyof TDraft & string>(key: K, value: TDraft[K]) => {
      const coupled = onCoupledFieldChange?.(key, value, controller.draft) ?? null;
      if (coupled) {
        controller.patchDraft(coupled);
      } else {
        controller.setField(key, value);
      }
    },
    [controller, onCoupledFieldChange],
  );

  return (
    <>
      <InspectorTemplate
        activeModeTabId={controller.activeModeTabId}
        animationKey={controller.animationKey}
        appliedFlash={controller.appliedFlash}
        applyError={controller.applyError}
        applying={controller.applying}
        baseline={controller.baseline}
        dirtyFields={controller.dirtyFields}
        displayUnits={controller.displayUnits}
        draft={controller.draft}
        forceShowErrors={controller.forceShowErrors}
        invalidFields={controller.invalidFields}
        selection={selection}
        spec={spec}
        touchedFields={controller.touchedFields}
        onActiveModeTabChange={controller.setActiveModeTabId}
        onApply={controller.requestApply}
        onDisplayUnitChange={controller.setDisplayUnit}
        onFieldChange={handleFieldChange}
        onFieldTouch={controller.touchField}
        onFitView={handleFitView}
        onFocusField={(key) => controller.focusField(key as keyof TDraft & string)}
        onHideInspector={handleHideInspector}
        onNotify={handleNotify}
        onOpenCodePreview={handleOpenCodePreview}
        onParseErrorChange={controller.setParseError}
        onPatchDraft={controller.patchDraft}
        onResetDisplay={controller.resetDisplay}
        onRevertAll={controller.revertAll}
        onRevertField={controller.revertField}
        onSelectNode={handleSelectNode}
      />

      {statusToast ? (
        <span className="sr-only" role="status">
          {statusToast}
        </span>
      ) : null}

      {children}

      <Dialog
        open={codePreview !== null}
        onOpenChange={(open) => {
          if (!open) setCodePreview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{codePreview?.title ?? "JSON payload"}</DialogTitle>
            <DialogDescription>
              {codePreview?.language === "python"
                ? "Python authoring snippet"
                : "Lossless JSON scene payload"}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-80 overflow-auto rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-3 font-mono text-xs text-[var(--fm-text)]">
            <code>{codePreview?.code ?? ""}</code>
          </pre>
          <DialogFooter>
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                if (codePreview) {
                  void navigator.clipboard?.writeText(codePreview.code).catch(() => undefined);
                  setCopiedCode(true);
                }
              }}
            >
              {copiedCode ? (
                <Check aria-hidden="true" size={14} />
              ) : (
                <Copy aria-hidden="true" size={14} />
              )}
              <span>{copiedCode ? "Copied" : "Copy"}</span>
            </Button>
            <Button
              size="sm"
              type="button"
              variant="primary"
              onClick={() => setCodePreview(null)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ── Read-Only Lossless Inspector for `UnsupportedAuthoringRecord` ── */

interface ReadOnlyOpaqueDraft {
  readonly title: string;
  readonly jsonPayload: string;
}

export function ReadOnlyOpaqueInspector({
  specId,
  selection,
  breadcrumbs,
  icon,
  heading,
  kindLabel,
  entityId,
  warningText,
  payload,
  switcherNode,
  onRefresh,
}: {
  specId: string;
  selection: Selection;
  breadcrumbs: readonly InspectorBreadcrumbItem[];
  icon: LucideIcon;
  heading: string;
  kindLabel: string;
  entityId?: string;
  warningText: string;
  payload: unknown;
  switcherNode?: ReactNode;
  onRefresh?: () => void;
}) {
  const jsonPayload = useMemo(() => JSON.stringify(payload, null, 2), [payload]);
  const baseline = useMemo<ReadOnlyOpaqueDraft>(
    () => ({ title: heading, jsonPayload }),
    [heading, jsonPayload],
  );

  const spec = useMemo<InspectorSpec<ReadOnlyOpaqueDraft>>(
    () => ({
      id: specId,
      header: {
        breadcrumbs,
        searchable: false,
        extraMenuActions: [
          ...(onRefresh
            ? [
                {
                  id: "refresh-readonly-resource",
                  label: "Refresh resource",
                  icon: RefreshCw,
                  onSelect: () => onRefresh(),
                },
              ]
            : []),
          {
            id: "view-readonly-json",
            label: "View JSON payload",
            icon: FileCode2,
            onSelect: (ctx: { openCodePreview: (t: string, l: "json", c: string) => void }) =>
              ctx.openCodePreview(`${heading} JSON`, "json", jsonPayload),
          },
        ],
      },
      identity: {
        domain: "physics",
        icon,
        title: (d) => d.title,
        kindLabel,
        entityId,
        statePill: () => ({
          tone: "warn",
          label: "Read-only payload",
        }),
      },
      facts: () => [{ id: "mode", label: "Protection", value: "Lossless read-only" }],
      notices: () => [
        {
          id: "opaque-record-warning",
          tone: "warn",
          title: "Unrecognized schema variant",
          text: warningText,
        },
      ],
      sections: [
        ...(switcherNode
          ? [
              {
                id: `${specId}-switcher`,
                title: "Resource selection",
                icon,
                defaultOpen: true,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => switcherNode,
                  },
                ],
              },
            ]
          : []),
        {
          id: `${specId}-opaque-payload`,
          title: "Opaque scene payload (lossless JSON)",
          icon: ShieldAlert,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-col gap-2" data-slot="opaque-readonly-payload">
                  <pre className="max-h-96 overflow-auto rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-3 font-mono text-xs text-[var(--fm-text)]">
                    <code>{ctx.draft.jsonPayload}</code>
                  </pre>
                </div>
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Read-only · Unrecognized variant preserved without mutation",
      },
    }),
    [breadcrumbs, entityId, heading, icon, jsonPayload, kindLabel, onRefresh, specId, switcherNode, warningText],
  );

  const controller = useInspectorSpecController(spec, selection, baseline);
  return (
    <TransportTemplateRenderer
      controller={controller}
      selection={selection}
      spec={spec}
    />
  );
}
