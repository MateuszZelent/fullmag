"use client";

import { Profiler, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EMPTY_SELECTION, type Selection } from "@/kernel/selection/selectionTypes";
import {
  InspectorEditSessionProvider,
  useRegisterInspectorEditSession,
  type InspectorEditMode,
} from "@/modules/inspector/InspectorEditSession";
import { InspectorShell } from "@/modules/inspector/InspectorShell";
import { InspectorGroup } from "@/modules/inspector/primitives/InspectorGroup";
import { StudyRuntimeSection } from "@/modules/inspector/panels/StudyInspectorPanel";
import {
  resolveStudyInspectorModel,
  studySnapshotFromScene,
} from "@/modules/inspector/panels/StudyInspectorPanelModel";
import {
  resolveInspectorDescriptor,
  type InspectorDescriptor,
} from "@/modules/inspector/inspectorDescriptor";

type Target = "object" | "airbox";
type Mode = InspectorEditMode | null;
type BreadcrumbSelection = NonNullable<InspectorDescriptor["breadcrumbs"][number]["selection"]>;

interface RetryFixtureState {
  currentSession: string;
  hasOriginalRequest: boolean;
  intentId: string | null;
  intentSession: string | null;
  isPending: boolean;
}

interface StudyCommandCall {
  commandId: string;
  input: unknown | null;
}

interface Snapshot {
  applying: boolean;
  applyCalls: number;
  dirty: boolean;
  focusCalls: number;
  lastApplyAck: boolean | null;
  lastResetMode: Mode;
  mode: Mode;
  pending: boolean;
  reactCommits: number;
  resetCalls: number;
  retryableIntentId: string | null;
  retryState: RetryFixtureState;
  studyCommandCalls: StudyCommandCall[];
  target: Target;
  valid: boolean;
}

interface FixtureDriver {
  read: () => Snapshot;
  setDescriptor: (target: Target) => void;
  setMode: (mode: Mode) => void;
  setRetryState: (state: RetryFixtureState) => void;
  setValid: (valid: boolean) => void;
  settleApply: (accepted: boolean) => void;
}

declare global {
  interface Window {
    __fullmagInspectorActionsFixture?: FixtureDriver;
  }
}

function InspectorActionsPanel({
  applying,
  dirty,
  mode,
  onApply,
  onBreadcrumb,
  onFocus,
  onReset,
  onStudyCommand,
  retryState,
  selection,
  valid,
}: {
  applying: boolean;
  dirty: boolean;
  mode: Mode;
  onApply: () => Promise<boolean>;
  onBreadcrumb: (selection: BreadcrumbSelection) => void;
  onFocus: () => void;
  onReset: () => void;
  onStudyCommand: (commandId: string, input?: unknown) => void;
  retryState: RetryFixtureState;
  selection: Selection;
  valid: boolean;
}) {
  const descriptor = useMemo(() => resolveInspectorDescriptor(selection), [selection]);
  const reset = useCallback(() => onReset(), [onReset]);
  const studyModel = useMemo(() => resolveStudyInspectorModel({
    currentRun: null,
    snapshot: studySnapshotFromScene(null),
    solverStatus: null,
    stageExecution: null,
  }), []);
  const retryComputeIntentId = retryState.isPending &&
      retryState.hasOriginalRequest &&
      retryState.currentSession === retryState.intentSession &&
      retryState.intentId?.trim()
    ? retryState.intentId
    : null;
  const commandDisabledReason = (commandId: string) =>
    commandId === "study.retry-compute" && retryComputeIntentId
      ? null
      : commandId === "study.retry-compute"
        ? "No original Compute request is available."
        : "Study commands are disabled in this controlled fixture.";

  useRegisterInspectorEditSession(
    mode,
    applying,
    dirty,
    valid,
    undefined,
    onApply,
    reset,
    { historyMode: "mutation-owned" },
  );

  return (
    <InspectorShell
      descriptor={descriptor}
      onFocus={onFocus}
      onSelectBreadcrumb={onBreadcrumb}
      onToggleVisibility={() => undefined}
    >
      <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
        <InspectorGroup title="Fixture details" collapsible defaultOpen>
          <label className="fm-inspector-field">
            <span>Unchanged fixture field</span>
            <input
              aria-label="Unchanged fixture field"
              className="fm-inspector-input"
              data-testid="inspector-actions-stable-field"
              defaultValue="keep-this-value"
            />
          </label>
          <p>Controlled fixture content keeps the production Inspector scroll viewport measurable while action state changes.</p>
          {Array.from({ length: 24 }, (_, index) => (
            <div
              key={index}
              style={{
                borderBottom: "1px solid var(--fm-border-subtle)",
                minHeight: 44,
                padding: "12px 8px",
              }}
            >
              Fixture detail row {index + 1}
            </div>
          ))}
        </InspectorGroup>
        <StudyRuntimeSection
          commandDisabledReason={commandDisabledReason}
          model={studyModel}
          onOpenCommand={() => undefined}
          retryComputeIntentId={retryComputeIntentId}
          runCommand={onStudyCommand}
          stepValue="Unavailable"
        />
      </div>
    </InspectorShell>
  );
}

export default function InspectorActionsPage() {
  const [target, setTarget] = useState<Target>("object");
  const [mode, setMode] = useState<Mode>("staged");
  const [dirty, setDirty] = useState(true);
  const [valid, setValid] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyCalls, setApplyCalls] = useState(0);
  const [resetCalls, setResetCalls] = useState(0);
  const [focusCalls, setFocusCalls] = useState(0);
  const [retryState, setRetryState] = useState<RetryFixtureState>({
    currentSession: "session-a@1",
    hasOriginalRequest: true,
    intentId: "study-compute-a",
    intentSession: "session-a@1",
    isPending: false,
  });
  const [studyCommandCalls, setStudyCommandCalls] = useState<StudyCommandCall[]>([]);
  const [lastApplyAck, setLastApplyAck] = useState<boolean | null>(null);
  const [lastResetMode, setLastResetMode] = useState<Mode>(null);
  const reactCommitCount = useRef(0);
  const pendingResolve = useRef<((accepted: boolean) => void) | null>(null);

  const recordReactCommit = useCallback(() => {
    reactCommitCount.current += 1;
  }, []);

  const selection = useMemo<Selection>(
    () => ({
      ...EMPTY_SELECTION,
      kind: target === "object" ? "object.root" : "airbox.root",
      label: target === "object" ? "Fixture Object" : "Airbox",
      nodeId:
        target === "object"
          ? "model:object:inspector-actions-object"
          : "model:airbox",
      objectId: target === "object" ? "inspector-actions-object" : null,
    }),
    [target],
  );

  const retryableIntentId = retryState.isPending &&
      retryState.hasOriginalRequest &&
      retryState.currentSession === retryState.intentSession &&
      retryState.intentId?.trim()
    ? retryState.intentId
    : null;

  const read = useCallback(
    () => ({
      applying,
      applyCalls,
      dirty,
      focusCalls,
      lastApplyAck,
      lastResetMode,
      mode,
      pending: pendingResolve.current !== null,
      reactCommits: reactCommitCount.current,
      resetCalls,
      retryableIntentId,
      retryState,
      studyCommandCalls,
      target,
      valid,
    }),
    [
      applying,
      applyCalls,
      dirty,
      focusCalls,
      lastApplyAck,
      lastResetMode,
      mode,
      resetCalls,
      retryableIntentId,
      retryState,
      studyCommandCalls,
      target,
      valid,
    ],
  );

  const apply = useCallback(async () => {
    setApplyCalls((count) => count + 1);
    setApplying(true);
    const accepted = await new Promise<boolean>((resolve) => {
      pendingResolve.current = resolve;
    });
    pendingResolve.current = null;
    setApplying(false);
    setLastApplyAck(accepted);
    if (accepted) setDirty(false);
    return accepted;
  }, []);

  const reset = useCallback(() => {
    setResetCalls((count) => count + 1);
    setLastResetMode(mode);
    setDirty(false);
  }, [mode]);

  const focus = useCallback(() => {
    setFocusCalls((count) => count + 1);
  }, []);

  const recordStudyCommand = useCallback((commandId: string, input?: unknown) => {
    setStudyCommandCalls((calls) => [...calls, { commandId, input: input ?? null }]);
  }, []);

  const selectBreadcrumb = useCallback((next: BreadcrumbSelection) => {
    if (next.kind === "airbox.root") setTarget("airbox");
    if (next.kind === "object.root") setTarget("object");
  }, []);

  const setFixtureMode = useCallback((next: Mode) => {
    setMode(next);
    setDirty(next === "staged" || next === "liveViewport");
    setValid(next !== "staged");
    setLastApplyAck(null);
  }, []);

  const settleApply = useCallback((accepted: boolean) => {
    const resolve = pendingResolve.current;
    if (!resolve) throw new Error("There is no pending Apply callback to settle.");
    resolve(accepted);
  }, []);

  useEffect(() => {
    const driver: FixtureDriver = {
      read,
      setDescriptor: setTarget,
      setMode: setFixtureMode,
      setRetryState,
      setValid,
      settleApply,
    };
    window.__fullmagInspectorActionsFixture = driver;
    return () => {
      if (window.__fullmagInspectorActionsFixture === driver) {
        delete window.__fullmagInspectorActionsFixture;
      }
    };
  }, [read, setFixtureMode, setRetryState, settleApply]);

  return (
    <main
      data-testid="inspector-actions-fixture"
      style={{
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        height: "100dvh",
        minHeight: 0,
      }}
    >
      <aside
        aria-label="Fixture model"
        style={{
          alignItems: "center",
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          padding: 8,
        }}
      >
        <strong>Inspector action fixture</strong>
        <span>
          {target === "object" ? "Object selection" : "Airbox selection"} ·{" "}
          {mode ?? "noSession"}
        </span>
      </aside>
      <Profiler id="inspector-actions-production-panel" onRender={recordReactCommit}>
        <InspectorEditSessionProvider>
          <InspectorActionsPanel
            applying={applying}
            dirty={dirty}
            mode={mode}
            onApply={apply}
            onBreadcrumb={selectBreadcrumb}
            onFocus={focus}
            onReset={reset}
            onStudyCommand={recordStudyCommand}
            retryState={retryState}
            selection={selection}
            valid={valid}
          />
        </InspectorEditSessionProvider>
      </Profiler>
    </main>
  );
}
