"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { Selection } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorSection } from "../../primitives/InspectorSection";
import { VisualizationDebugSampleTable, formatScientific } from "./VisualizationDebugSampleTable";
import type {
  VisualizationDebugPanelModel,
} from "./VisualizationDebugPanelModel";
import {
  allIssues,
  allObservations,
  formatBackendStats,
  formatBytes,
  formatContext,
  formatDrawingBuffer,
  formatDuration,
  formatTimestamp,
  healthDiagnosis,
  latestSnapshotCaptureTime,
  memoryGroups,
  statisticsRows,
  uniqueSnapshots,
  visualizationDebugEmptyStateMessage,
} from "./visualizationDebugPresentation";
import { VisualizationDebugPanelModelAdapter } from "./useVisualizationDebugPanelModel";
import {
  buildVisualizationDebugExport,
  createBrowserVisualizationDebugEvidenceEnvironment,
  createVisualizationDebugEvidenceActions,
  type VisualizationDebugActionFeedback,
  type VisualizationDebugEvidenceActionEnvironment,
  type VisualizationDebugEvidenceActionsFactory,
} from "./visualizationDebugExport";

const STALE_SNAPSHOT_AGE_MS = 30_000;

export function VisualizationDebugPanel({
  actionEnvironment,
  createActions,
  selection,
}: {
  actionEnvironment?: VisualizationDebugEvidenceActionEnvironment;
  createActions?: VisualizationDebugEvidenceActionsFactory;
  selection: Selection;
}) {
  return (
    <VisualizationDebugPanelModelAdapter selection={selection.ref}>
      {(model) => (
        <VisualizationDebugPanelView
          actionEnvironment={actionEnvironment}
          createActions={createActions}
          model={model}
        />
      )}
    </VisualizationDebugPanelModelAdapter>
  );
}

export function VisualizationDebugPanelView({
  actionEnvironment,
  createActions = createVisualizationDebugEvidenceActions,
  model,
  nowMs,
}: {
  actionEnvironment?: VisualizationDebugEvidenceActionEnvironment;
  createActions?: VisualizationDebugEvidenceActionsFactory;
  model: VisualizationDebugPanelModel;
  nowMs?: number;
}) {
  const [feedback, setFeedback] = useState<VisualizationDebugActionFeedback>(null);
  // Intentionally sampled once for this render. Diagnostics must not add a
  // timer or polling loop merely to age a snapshot.
  // eslint-disable-next-line react-hooks/purity
  const evidenceNowMs = nowMs ?? Date.now();
  const publishFeedback = useCallback(
    (value: VisualizationDebugActionFeedback) => setFeedback(value),
    [],
  );
  const environment = useMemo(
    () => actionEnvironment ?? createBrowserVisualizationDebugEvidenceEnvironment(),
    [actionEnvironment],
  );
  const actions = useMemo(
    () =>
      createActions(model, {
        ...environment,
        feedback: publishFeedback,
      }),
    [createActions, environment, model, publishFeedback],
  );
  useEffect(() => () => actions.dispose(), [actions]);

  const emptyMessage = visualizationDebugEmptyStateMessage(model.state);
  const observations = allObservations(model);
  const snapshots = uniqueSnapshots(model);
  const disposition = model.disposition;
  const latestCapturedAtMs = latestSnapshotCaptureTime(model);
  const ageMs = snapshots.length > 0
    ? Math.max(0, evidenceNowMs - latestCapturedAtMs)
    : 0;
  const stale = snapshots.length > 0 && (
    ageMs > STALE_SNAPSHOT_AGE_MS ||
    allIssues(model).some((issue) => issue.code.includes("stale"))
  );
  const scanning = observations.some(({ carrier }) => carrier.scanState === "scanning");
  const noFieldRequested = observations.length > 0 && observations.every(
    ({ carrier }) => !carrier.request.resourceKey && !carrier.payload,
  );
  const requestFailed = model.issues.some(
    (entry) => entry.code === "field-request-error",
  );
  const rawJson = buildVisualizationDebugExport(model, evidenceNowMs).json;

  return (
    <div className="fm-visualization-debug-panel" data-state={model.state}>
      <InspectorSection title="Health" badge={disposition}>
        {emptyMessage ? (
          <div className="fm-visualization-debug-state" role="status">
            <strong>{emptyMessage.title}</strong>
            <span>{emptyMessage.detail}</span>
          </div>
        ) : (
          <div
            className="fm-visualization-debug-health"
            data-disposition={disposition}
            role="status"
          >
            <strong>{disposition}</strong>
            <span>{healthDiagnosis(disposition)}</span>
            <span>Snapshot age {formatDuration(ageMs)}</span>
          </div>
        )}
        {!emptyMessage && stale ? <FeedbackBanner kind="warning" message="Snapshot is stale." /> : null}
        {!emptyMessage && scanning ? <FeedbackBanner kind="warning" message="Statistics scan in progress." /> : null}
        {!emptyMessage && noFieldRequested ? <FeedbackBanner kind="warning" message="No field requested for this target." /> : null}
        {!emptyMessage && requestFailed ? <FeedbackBanner kind="error" message="Matched field request failed." /> : null}
      </InspectorSection>

      <InspectorSection title="Active target">
        <FieldRow label="Selection kind" value={model.target?.selectionKind ?? "unknown"} />
        <FieldRow label="Target kind" value={model.target?.kind ?? "—"} />
        <FieldRow label="Target ID" value={model.target?.id ?? "—"} />
        <FieldRow label="Target label" value={snapshots[0]?.target.label ?? "—"} />
        <FieldRow label="Carrier IDs" value={snapshots.flatMap((snapshot) => snapshot.target.carrierIds).join(", ") || "—"} />
        <FieldRow label="Registry source" value="canonical visualization registry" />
      </InspectorSection>

      <InspectorSection title="Viewport & carriers" badge={`${model.viewports.length}`}>
        {model.viewports.flatMap((viewport) => [
          <div className="fm-visualization-debug-subsection" key={`${viewport.viewportId}:viewport`}>
            <h4>{viewport.viewportId}</h4>
            <FieldRow label="Committed frame" value={viewport.snapshots.at(-1)?.viewport.frameCommitId ?? "—"} />
            <FieldRow label="Context" value={formatContext(viewport.snapshots.at(-1) ?? null)} />
            <FieldRow label="Drawing buffer" value={formatDrawingBuffer(viewport.snapshots.at(-1) ?? null)} />
            <FieldRow label="Client acknowledgements" value={`${viewport.clientAcks.length} (viewport-wide)`} />
          </div>,
          ...viewport.carriers.map((carrier) => (
            <div className="fm-visualization-debug-subsection" key={`${viewport.viewportId}:${carrier.carrierId}`}>
              <h4>{carrier.carrierId}</h4>
              <FieldRow label="Carrier role" value={carrier.observations[0]?.carrier.carrierRole ?? "—"} />
              <FieldRow label="Observations" value={carrier.observations.length.toLocaleString("en-US")} />
            </div>
          )),
        ])}
      </InspectorSection>

      <InspectorSection title="Request & transport" badge={`${model.transport.length}`}>
        {observations.map(({ carrier, query }, index) => (
          <div className="fm-visualization-debug-subsection" key={`request:${carrier.carrierId}:${index}`}>
            <h4>{carrier.carrierId}</h4>
            <FieldRow label="Planner request ID" value={carrier.request.plannerRequestId ?? "—"} />
            <FieldRow label="Canonical resource key" value={carrier.request.resourceKey ?? "—"} />
            <FieldRow label="Requested component" value={query?.component ?? "—"} />
            <FieldRow label="Geometry scope" value={query?.geometryScope ?? "full"} />
            <FieldRow label="Maximum samples" value={query?.maxSamples?.toLocaleString("en-US") ?? "all"} />
            <FieldRow label="Complex view / phase" value={query?.view ? `${query.view} / ${query.phaseRad ?? "default"}` : "none"} />
          </div>
        ))}
        <div className="fm-visualization-debug-table-wrap">
          <table className="fm-visualization-debug-table" aria-label="Matched field transport requests">
            <thead><tr><th scope="col">Request</th><th scope="col">Path</th><th scope="col">Status</th><th scope="col">Duration</th><th scope="col">Wire bytes</th><th scope="col">ETag</th><th scope="col">Timestamp</th></tr></thead>
            <tbody>{model.transport.slice(0, 8).map((entry) => (
              <tr key={entry.id}><th scope="row">{entry.requestId}</th><td>{entry.path}</td><td>{entry.status ?? entry.outcome}</td><td>{formatDuration(entry.durationMs)}</td><td>{formatBytes(entry.byteLength)}</td><td>{entry.etag ?? "—"}</td><td>{formatTimestamp(entry.timestampMs)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </InspectorSection>

      <InspectorSection title="Backend metadata">
        {observations.map((observation, index) => (
          <div className="fm-visualization-debug-subsection" key={`meta:${observation.carrier.carrierId}:${index}`}>
            <h4>{observation.carrier.carrierId}</h4>
            {observation.backendMeta ? <>
              <FieldRow label="Quantity" value={`${observation.backendMeta.quantity_id} — ${observation.backendMeta.label}`} />
              <FieldRow label="Kind / location" value={`${observation.backendMeta.kind} / ${observation.backendMeta.location}`} />
              <FieldRow label="Components" value={observation.backendMeta.components.toLocaleString("en-US")} />
              <FieldRow label="Field revision" value={String(observation.backendMeta.field_revision)} />
              <FieldRow label="Domain generation" value={observation.backendMeta.domain_generation_id} />
              <FieldRow label="Backend min / max / mean" unit={observation.backendMeta.unit} value={formatBackendStats(observation.backendMeta.stats)} />
            </> : <p className="fm-visualization-debug-empty">Backend metadata is not available for this exact query.</p>}
          </div>
        ))}
      </InspectorSection>

      <InspectorSection title="Decoded payload">
        {observations.map(({ carrier }, index) => (
          <div className="fm-visualization-debug-subsection" key={`payload:${carrier.carrierId}:${index}`}>
            <h4>{carrier.carrierId}</h4>
            {carrier.payload ? <>
              <FieldRow label="Dtype / FMVP" value={`${carrier.payload.dtype} / v${carrier.payload.formatVersion ?? "—"}`} />
              <FieldRow label="Grid" value={carrier.payload.grid.join(" × ")} />
              <FieldRow label="nComp" value={carrier.payload.nComp.toLocaleString("en-US")} />
              <FieldRow label="Decoded component" value={carrier.payload.component ?? "— (not encoded)"} />
              <FieldRow label="Points / values" value={`${carrier.payload.pointCount.toLocaleString("en-US")} / ${carrier.payload.valueCount.toLocaleString("en-US")}`} />
              <FieldRow label="Indexing / node indices" value={`${carrier.payload.indexing} / ${carrier.payload.nodeIndexCount?.toLocaleString("en-US") ?? "—"}`} />
              <FieldRow label="Scope" value={`${carrier.payload.scopeKind ?? "—"}:${carrier.payload.scopeId ?? "—"}`} />
            </> : <p className="fm-visualization-debug-empty">No decoded field payload is available.</p>}
          </div>
        ))}
      </InspectorSection>

      <InspectorSection title="Statistics">
        <div className="fm-visualization-debug-table-wrap">
          <table className="fm-visualization-debug-table" aria-label="Statistics by evidence source">
            <thead><tr><th scope="col">Carrier</th><th scope="col">Source</th><th scope="col">Min</th><th scope="col">Max</th><th scope="col">Mean</th><th scope="col">p01 / p99</th><th scope="col">Unit</th><th scope="col">Finite / non-finite / zero</th></tr></thead>
            <tbody>{statisticsRows(observations).map((row) => <tr key={row.key}><th scope="row">{row.carrierId}</th><td>{row.source}</td><td>{formatScientific(row.min)}</td><td>{formatScientific(row.max)}</td><td>{formatScientific(row.mean)}</td><td>{`${formatScientific(row.p01)} / ${formatScientific(row.p99)}`}</td><td>{row.unit}</td><td>{row.counts}</td></tr>)}</tbody>
          </table>
        </div>
      </InspectorSection>

      <InspectorSection title="Sample values">
        <VisualizationDebugSampleTable model={model} />
      </InspectorSection>

      <InspectorSection title="Memory">
        {memoryGroups(model).map((group) => (
          <div className="fm-visualization-debug-subsection" key={group.ownership}>
            <h4>{group.ownership}</h4>
            {group.rows.map((row) => <FieldRow key={row.renderKey} label={`${row.label} · ${row.source}`} value={formatBytes(row.byteLength)} />)}
            <FieldRow label="Group total" value={formatBytes(group.total)} />
          </div>
        ))}
        <p className="fm-visualization-debug-caption">Shared bytes are excluded from target-owned total.</p>
      </InspectorSection>

      <InspectorSection title="Render passes">
        {observations.map(({ carrier }, index) => (
          <div className="fm-visualization-debug-subsection" key={`render:${carrier.carrierId}:${index}`}>
            <h4>{carrier.carrierId}</h4>
            <FieldRow label="Requested source" value={carrier.request.resourceKey ?? "—"} />
            <FieldRow label="Adopted source" value={carrier.render.adoption.adoptedResourceKey ?? "—"} />
            <FieldRow label="Field buffer" value={`${carrier.render.fieldBufferState} · ${carrier.render.adoption.adoptedFieldBufferId ?? "not adopted"}`} />
            <FieldRow label="Surface" value={`${carrier.render.surface.projectionMode ?? "none"} · ${carrier.render.surface.degradation ?? "not degraded"}`} />
            <FieldRow label="Vectors" value={`${carrier.render.vectors.buildKey ?? "not built"} · ${carrier.render.vectors.segmentCount?.toLocaleString("en-US") ?? "0"} segments · ${carrier.render.vectors.degradation ?? "not degraded"}`} />
          </div>
        ))}
      </InspectorSection>

      <InspectorSection title="Revisions & provenance">
        {observations.map(({ carrier, snapshot }, index) => (
          <div className="fm-visualization-debug-subsection" key={`revision:${carrier.carrierId}:${index}`}>
            <h4>{carrier.carrierId}</h4>
            <FieldRow label="Visualization / field" value={`${carrier.revisions.visualizationRevision ?? "—"} / ${carrier.revisions.fieldRevision ?? "—"}`} />
            <FieldRow label="Topology / domain" value={`${carrier.revisions.topologyRevision ?? "—"} / ${carrier.revisions.domainGenerationId ?? "—"}`} />
            <FieldRow label="Topology hash" value={carrier.revisions.meshTopologyHash ?? "—"} />
            <FieldRow label="Cache ETag" value={carrier.cache.etag ?? "—"} />
            <FieldRow label="Rendered acknowledgement" value={carrier.render.adoption.frameCommitId ?? snapshot.viewport.frameCommitId} />
          </div>
        ))}
      </InspectorSection>

      <InspectorSection title="Detected inconsistencies" badge={`${allIssues(model).length}`}>
        {allIssues(model).length > 0 ? <ul className="fm-visualization-debug-issues">{allIssues(model).map((issue, index) => (
          <li data-severity={issue.severity} key={`${issue.code}:${index}`}><strong>{issue.severity}: {issue.code}</strong><span>{issue.source} — {issue.message}</span><code>{issue.evidence.join(" · ") || "No additional evidence"}</code></li>
        ))}</ul> : <p className="fm-visualization-debug-empty">No inconsistencies were detected.</p>}
      </InspectorSection>

      <InspectorSection title="Evidence export">
        <div className="fm-visualization-debug-actions" role="group" aria-label="Visualization evidence actions">
          <Button className="fm-visualization-debug-action" size="sm" aria-label="Copy snapshot" onClick={() => void actions.copySnapshot()}>Copy snapshot</Button>
          <Button className="fm-visualization-debug-action" size="sm" aria-label="Copy resource key" onClick={() => void actions.copyResourceKey()}>Copy resource key</Button>
          <Button className="fm-visualization-debug-action" size="sm" aria-label="Export JSON" onClick={() => actions.exportJson()}>Export JSON</Button>
        </div>
        {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
        <InspectorSection title="Raw bounded JSON" collapsible defaultCollapsed>
          <pre className="fm-visualization-debug-json"><code>{rawJson}</code></pre>
        </InspectorSection>
      </InspectorSection>
    </div>
  );
}
