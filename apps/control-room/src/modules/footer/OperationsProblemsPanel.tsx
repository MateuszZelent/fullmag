"use client";

import { AlertTriangle, CircleCheckBig, ListChecks } from "lucide-react";

import {
  useGeometryDiagnosticsResource,
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
} from "@/kernel/resources/geometryLifecycleResources";
import { useCommandQueueResource } from "@/kernel/resources/studyRuntimeResources";
import { useSimulationPreparation } from "@/kernel/resources/useSimulationPreparation";

import { MeshJobsPanel } from "./MeshJobsPanel";
import {
  buildOperationsProjection,
  buildProblemsProjection,
  type OperationProjectionRow,
  type OperationsProjectionModel,
  type ProblemProjectionRow,
  type ProblemsProjectionModel,
} from "./operationsProblemsModel";

export function OperationsPanel() {
  const commandQueue = useCommandQueueResource();
  const meshBuild = useMeshBuildCurrent();
  const preparation = useSimulationPreparation();
  const model = buildOperationsProjection({
    commandQueue: commandQueue.data,
    meshBuild: meshBuild.data,
    preparation: preparation.data,
    resources: [
      resourceState("Commands", commandQueue),
      resourceState("Mesh builds", meshBuild),
      resourceState("Preparation", preparation),
    ],
  });

  return (
    <div className="fm-footer-mesh-jobs" data-footer-panel="operations">
      <OperationsPanelView model={model} />
      <MeshJobsPanel />
    </div>
  );
}

export function ProblemsPanel() {
  const commandQueue = useCommandQueueResource();
  const geometryDiagnostics = useGeometryDiagnosticsResource();
  const latestSuccessfulMesh = useMeshBuildLatestSuccessful();
  const meshBuild = useMeshBuildCurrent();
  const preparation = useSimulationPreparation();
  const model = buildProblemsProjection({
    commandQueue: commandQueue.data,
    geometryDiagnostics: geometryDiagnostics.data,
    latestSuccessfulMesh: latestSuccessfulMesh.data,
    meshBuild: meshBuild.data,
    preparation: preparation.data,
    resources: [
      resourceState("Commands", commandQueue),
      resourceState("Geometry diagnostics", geometryDiagnostics),
      resourceState("Latest successful mesh", latestSuccessfulMesh),
      resourceState("Mesh builds", meshBuild),
      resourceState("Preparation", preparation),
    ],
  });

  return (
    <div className="fm-footer-mesh-jobs" data-footer-panel="problems">
      <ProblemsPanelView model={model} />
    </div>
  );
}

function resourceState(
  label: string,
  resource: { error: Error | null; status: string },
) {
  return { error: resource.error, label, status: resource.status };
}

export function OperationsPanelView({
  model,
}: {
  model: OperationsProjectionModel;
}) {
  return (
    <section
      className="fm-footer-diagnostics__panel"
      aria-label="Operations"
    >
      <div className="fm-footer-diagnostics__heading">
        <ListChecks size={14} aria-hidden="true" />
        <span>Operations</span>
        <span className="fm-footer-diagnostics__meta">
          {model.rows.length} published
        </span>
      </div>
      <ProjectionGaps gaps={model.gaps} />
      {model.rows.length > 0 ? (
        <table className="fm-footer-diagnostics__profile-table">
          <thead>
            <tr className="fm-footer-diagnostics__profile-row fm-footer-diagnostics__profile-row--header">
              <th scope="col">Source</th>
              <th scope="col">Operation</th>
              <th scope="col">Status</th>
              <th scope="col">Detail</th>
              <th scope="col">Revision</th>
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (
              <OperationRow key={row.id} row={row} />
            ))}
          </tbody>
        </table>
      ) : (
        <div className="fm-footer__empty" role="status">
          No published operations.
        </div>
      )}
    </section>
  );
}

function OperationRow({ row }: { row: OperationProjectionRow }) {
  return (
    <tr
      className="fm-footer-diagnostics__profile-row"
      data-operation-id={row.id}
    >
      <td>{row.source}</td>
      <td>{row.label}</td>
      <td>{row.status}</td>
      <td>{row.detail}</td>
      <td>{row.revision}</td>
    </tr>
  );
}

export function ProblemsPanelView({
  model,
}: {
  model: ProblemsProjectionModel;
}) {
  return (
    <section
      className="fm-footer-diagnostics__panel"
      aria-label="Problems"
    >
      <div className="fm-footer-diagnostics__heading">
        {model.errorCount > 0 || model.warningCount > 0 ? (
          <AlertTriangle size={14} aria-hidden="true" />
        ) : (
          <CircleCheckBig size={14} aria-hidden="true" />
        )}
        <span>Problems</span>
        <span className="fm-footer-diagnostics__meta">
          {model.errorCount} errors · {model.warningCount} warnings · {model.infoCount} info
        </span>
      </div>
      <ProjectionGaps gaps={model.gaps} />
      {model.rows.length > 0 ? (
        <table className="fm-footer-diagnostics__profile-table">
          <thead>
            <tr className="fm-footer-diagnostics__profile-row fm-footer-diagnostics__profile-row--header">
              <th scope="col">Severity</th>
              <th scope="col">Source</th>
              <th scope="col">Code</th>
              <th scope="col">Message</th>
              <th scope="col">Detail</th>
              <th scope="col">Revision</th>
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (
              <ProblemRow key={row.id} row={row} />
            ))}
          </tbody>
        </table>
      ) : (
        <div className="fm-footer__empty" role="status">
          No published problems.
        </div>
      )}
    </section>
  );
}

function ProblemRow({ row }: { row: ProblemProjectionRow }) {
  return (
    <tr
      className="fm-footer-diagnostics__profile-row"
      data-problem-id={row.id}
      data-severity={row.severity}
    >
      <td>{row.severity}</td>
      <td>{row.source}</td>
      <td>{row.code}</td>
      <td>{row.message}</td>
      <td>{row.detail}</td>
      <td>{row.revision}</td>
    </tr>
  );
}

function ProjectionGaps({ gaps }: { gaps: readonly string[] }) {
  if (gaps.length === 0) return null;
  return (
    <div className="fm-footer-diagnostics__warning" role="status">
      <AlertTriangle size={13} aria-hidden="true" />
      <span>Projection incomplete: {gaps.join(" · ")}</span>
    </div>
  );
}
