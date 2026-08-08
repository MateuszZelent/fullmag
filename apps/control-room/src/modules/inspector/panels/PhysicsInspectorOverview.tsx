"use client";

import {
  Activity,
  CircleAlert,
  GitBranch,
  Layers3,
  Waypoints,
} from "lucide-react";
import type { ReactNode } from "react";

import {
  useRegisterInspectorEditSession,
  type InspectorEditSession,
} from "../InspectorEditSession";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorOverviewFrame } from "../primitives/InspectorOverviewFrame";
import {
  buildPhysicsInspectorOverviewModel,
  physicsInspectorMetrics,
  physicsInspectorScopeLabel,
  physicsInspectorStatusLabel,
  type PhysicsInspectorOverviewModel,
  type PhysicsInspectorOverviewInput,
} from "./PhysicsInspectorOverviewModel";

export interface PhysicsInspectorOverviewProps {
  actions?: ReactNode;
  children?: ReactNode;
  /** Optional staged/live session registered with the InspectorShell action bar. */
  editSession?: InspectorEditSession;
  model: PhysicsInspectorOverviewModel | PhysicsInspectorOverviewInput;
  primary?: ReactNode;
  primaryTitle?: string;
}

/**
 * Registers an overview-owned session without clobbering a session owned by a
 * nested authoring panel. Keeping the hook in a separate component lets the
 * overview omit the bridge entirely for read-only and delegated panels.
 */
function PhysicsInspectorEditSessionBridge({
  session,
}: {
  session: InspectorEditSession;
}) {
  useRegisterInspectorEditSession(
    session.mode,
    session.applying,
    session.dirty,
    session.valid,
    session.lockReason,
    session.apply,
    session.reset,
  );
  return null;
}

function modelValue(value: number | string | null | undefined): string {
  return value === null || value === undefined || value === "" ? "Not available" : String(value);
}

function ScopeSection({ model }: { model: PhysicsInspectorOverviewModel }) {
  const { scope } = model;
  return (
    <div className="fm-physics-scope-ref" data-scope-kind={scope.kind}>
      <span className="fm-physics-scope-ref__kind">{physicsInspectorScopeLabel(scope.kind)}</span>
      <span className="fm-physics-scope-ref__value">{scope.stableRef}</span>
      {scope.objectId ? <FieldRow label="Object" value={scope.objectId} /> : null}
      {scope.regionId ? <FieldRow label="Region" value={scope.regionId} /> : null}
      {scope.sideA || scope.sideB ? (
        <>
          <FieldRow label="Side A" value={scope.sideA ?? "Not available"} />
          <FieldRow label="Side B" value={scope.sideB ?? "Not available"} />
        </>
      ) : null}
    </div>
  );
}

function DependencySection({ model }: { model: PhysicsInspectorOverviewModel }) {
  const dependency = model.dependency;
  const reason = dependency.reason ?? model.statusReason;
  return (
    <div
      className="fm-physics-inspector-status"
      data-state={dependency.status}
      data-slot="physics-inspector-dependency"
    >
      <span className="fm-physics-inspector-status__label">
        {physicsInspectorStatusLabel(dependency.status)}
      </span>
      {dependency.requiredSourceIds.length > 0 ? (
        <FieldRow label="Required sources" value={dependency.requiredSourceIds.join(", ")} />
      ) : (
        <span>No upstream physics module is required.</span>
      )}
      {reason ? <span className="fm-physics-inspector-status__reason">{reason}</span> : null}
    </div>
  );
}

function SolverSection({ model }: { model: PhysicsInspectorOverviewModel }) {
  const execution = model.execution;
  return (
    <div className="grid min-w-0 gap-fm-inspector-control" data-slot="physics-inspector-solver">
      <FieldRow label="Requested lane" value={modelValue(execution.requestedLane)} />
      <FieldRow label="Resolved lane" value={modelValue(execution.resolvedLane)} />
      <FieldRow label="Capability" value={modelValue(execution.capability)} />
      <FieldRow label="Graph revision" value={modelValue(execution.graphRevision)} />
      <FieldRow label="Scene revision" value={modelValue(execution.sceneRevision)} />
    </div>
  );
}

function DiagnosticsSection({ model }: { model: PhysicsInspectorOverviewModel }) {
  const reason = model.statusReason ?? model.dependency.reason ?? null;
  return (
    <div
      className="fm-physics-inspector-status"
      data-source-path={model.source.path ?? undefined}
      data-state={model.status}
      data-slot="physics-inspector-diagnostics"
    >
      <span className="fm-physics-inspector-status__label">
        {physicsInspectorStatusLabel(model.status)}
      </span>
      {reason ? <span className="fm-physics-inspector-status__reason">{reason}</span> : null}
      {model.source.path ? <FieldRow label="Source path" value={model.source.path} /> : null}
    </div>
  );
}

export function PhysicsInspectorOverview({
  actions,
  children,
  editSession,
  model: inputModel,
  primary,
  primaryTitle = "Drive",
}: PhysicsInspectorOverviewProps) {
  const model: PhysicsInspectorOverviewModel = buildPhysicsInspectorOverviewModel(inputModel);
  const body = primary ?? children ?? (
    <FeedbackBanner kind="warning" message="No editable physics module is selected." />
  );
  const values = model.values.length > 0 ? (
    <div className="grid min-w-0 gap-fm-inspector-control">
      {model.values.map((value) => (
        <FieldRow
          key={`${value.label}:${value.unit ?? ""}`}
          label={value.label}
          value={modelValue(value.value)}
          unit={value.unit}
        />
      ))}
    </div>
  ) : null;
  const overview = (
    <InspectorOverviewFrame
      actions={actions}
      className="fm-physics-inspector-overview"
      metrics={physicsInspectorMetrics(model)}
      primary={
        <>
          {body}
          {values}
        </>
      }
      primaryIcon={<Activity size={18} strokeWidth={1.5} />}
      primaryTitle={primaryTitle}
      sections={[
        {
          content: <ScopeSection model={model} />,
          icon: <Layers3 size={16} strokeWidth={1.75} />,
          id: "scope",
          summary: model.scope.label,
          title: "Scope",
        },
        {
          content: <DependencySection model={model} />,
          icon: <GitBranch size={16} strokeWidth={1.75} />,
          id: "dependency",
          summary: physicsInspectorStatusLabel(model.dependency.status),
          title: "Dependency",
        },
        {
          content: <SolverSection model={model} />,
          icon: <Waypoints size={16} strokeWidth={1.75} />,
          id: "solver",
          summary: model.execution.resolvedLane ?? model.execution.requestedLane ?? "Unresolved",
          title: "Solver / Execution",
        },
        {
          content: <DiagnosticsSection model={model} />,
          icon: <CircleAlert size={16} strokeWidth={1.75} />,
          id: "diagnostics",
          summary: physicsInspectorStatusLabel(model.status),
          title: "Diagnostics",
        },
      ]}
    />
  );
  return (
    <>
      {editSession ? <PhysicsInspectorEditSessionBridge session={editSession} /> : null}
      {overview}
    </>
  );
}

export { buildPhysicsInspectorOverviewModel } from "./PhysicsInspectorOverviewModel";
