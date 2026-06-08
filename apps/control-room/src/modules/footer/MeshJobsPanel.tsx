"use client";

import { useEffect, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  useMeshBuildCurrent,
  useMeshBuildHistoryResource,
  useMeshBuildLatestSuccessful,
  useMeshSharedDomainManifestResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useEngineLogResource } from "@/kernel/resources/studyRuntimeResources";

import { buildMeshJobsModel, type MeshJobsModel } from "./meshJobsModel";
import { MeshBuildLogConsole } from "./MeshBuildLogConsole";

export function MeshJobsPanel() {
  const kernel = useKernel();
  const [viewportConfirmation, setViewportConfirmation] = useState<{
    meshRevision: number | string;
    rendererId: string;
  } | null>(null);
  const activeBuild = useMeshBuildCurrent();
  const latestBuild = useMeshBuildLatestSuccessful();
  const history = useMeshBuildHistoryResource();
  const sharedDomainManifest = useMeshSharedDomainManifestResource();
  const engineLog = useEngineLogResource();

  useEffect(() => {
    const unsubscribe = kernel.bus.on("mesh:topology-rendered", (event) => {
      setViewportConfirmation({
        meshRevision: event.meshRevision,
        rendererId: event.rendererId,
      });
    });
    return () => {
      unsubscribe();
    };
  }, [kernel.bus]);

  const model = buildMeshJobsModel({
    activeBuild: activeBuild.data as Record<string, unknown> | null,
    engineLog: engineLog.data,
    history: history.data as { history?: Record<string, unknown>[] } | null,
    latestSuccessfulBuild: latestBuild.data as Record<string, unknown> | null,
    loadedMeshRevision: sharedDomainManifest.data?.revision ?? null,
    viewportConfirmation,
  });
  const historyCount = Array.isArray(history.data?.history)
    ? history.data.history.length
    : 0;

  return (
    <MeshJobsPanelView
      activeStatus={activeBuild.status}
      historyCount={historyCount}
      model={model}
    />
  );
}

export function MeshJobsPanelView({
  activeStatus,
  historyCount,
  model,
}: {
  activeStatus: string;
  historyCount: number;
  model: MeshJobsModel;
}) {
  return (
    <div className="fm-footer-mesh-jobs">
      <section className="fm-footer-diagnostics__panel" aria-label="Active mesh build">
        <div className="fm-footer-diagnostics__heading">
          <span>Active Build</span>
          <span className="fm-footer-diagnostics__meta">
            {activeStatus}
          </span>
        </div>
        <output className="fm-footer__empty">
          {model.activeTitle}
        </output>
      </section>

      <section className="fm-footer-diagnostics__panel" aria-label="Mesh build pipeline">
        <div className="fm-footer-diagnostics__heading">
          <span>Pipeline</span>
          <span className="fm-footer-diagnostics__meta">
            {model.phaseRows.length} phases
          </span>
        </div>
        <table className="fm-footer-diagnostics__profile-table">
          <thead>
            <tr className="fm-footer-diagnostics__profile-row fm-footer-diagnostics__profile-row--header">
              <th scope="col">Phase</th>
              <th scope="col">Status</th>
              <th scope="col">Progress</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {model.phaseRows.map((phase) => (
              <tr className="fm-footer-diagnostics__profile-row" key={phase.id}>
                <td>{phase.label}</td>
                <td>{phase.status}</td>
                <td>
                  {phase.progressPercent === null ? "-" : `${phase.progressPercent}%`}
                </td>
                <td>{phase.detail || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="fm-footer-diagnostics__panel" aria-label="Published mesh output">
        <div className="fm-footer-diagnostics__heading">
          <span>Published Output</span>
          <span className="fm-footer-diagnostics__meta">
            resources
          </span>
        </div>
        <table className="fm-footer-diagnostics__profile-table">
          <tbody>
            {model.publishedRows.map((row) => (
              <tr className="fm-footer-diagnostics__profile-row" key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="fm-footer-diagnostics__panel" aria-label="Latest successful mesh">
        <div className="fm-footer-diagnostics__heading">
          <span>Latest Success</span>
          <span className="fm-footer-diagnostics__meta">
            {historyCount} builds
          </span>
        </div>
        <table className="fm-footer-diagnostics__profile-table">
          <tbody>
            {model.latestRows.map((row) => (
              <tr className="fm-footer-diagnostics__profile-row" key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="fm-footer-diagnostics__panel" aria-label="Mesh build history">
        <div className="fm-footer-diagnostics__heading">
          <span>Build History</span>
          <span className="fm-footer-diagnostics__meta">
            {historyCount} builds
          </span>
        </div>
        <table className="fm-footer-diagnostics__profile-table">
          <thead>
            <tr className="fm-footer-diagnostics__profile-row fm-footer-diagnostics__profile-row--header">
              <th scope="col">Mesh</th>
              <th scope="col">Target</th>
              <th scope="col">Reason</th>
              <th scope="col">Nodes</th>
              <th scope="col">Elements</th>
            </tr>
          </thead>
          <tbody>
            {model.historyRows.map((row) => (
              <tr className="fm-footer-diagnostics__profile-row" key={row.id}>
                <td>{row.mesh}</td>
                <td>{row.target}</td>
                <td>{row.reason}</td>
                <td>{row.nodes}</td>
                <td>{row.elements}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="fm-footer-diagnostics__panel" aria-label="Viewport mesh confirmation">
        <div className="fm-footer-diagnostics__heading">
          <span>Viewport Delivery</span>
          <span className="fm-footer-diagnostics__meta">
            diagnostic
          </span>
        </div>
        <table className="fm-footer-diagnostics__profile-table">
          <tbody>
            {model.viewportRows.map((row) => (
              <tr className="fm-footer-diagnostics__profile-row" key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="fm-footer-diagnostics__panel" aria-label="Mesh build log">
        <div className="fm-footer-diagnostics__heading">
          <span>Build Log</span>
          <span className="fm-footer-diagnostics__meta">
            {model.logRows.length} mesh entries
          </span>
        </div>
        <MeshBuildLogConsole rows={model.logRows} />
      </section>
    </div>
  );
}
