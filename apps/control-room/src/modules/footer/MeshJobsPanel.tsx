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
    return kernel.bus.on("mesh:topology-rendered", (event) => {
      setViewportConfirmation({
        meshRevision: event.meshRevision,
        rendererId: event.rendererId,
      });
    });
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
        <div className="fm-footer__empty" role="status">
          {model.activeTitle}
        </div>
      </section>

      <section className="fm-footer-diagnostics__panel" aria-label="Mesh build pipeline">
        <div className="fm-footer-diagnostics__heading">
          <span>Pipeline</span>
          <span className="fm-footer-diagnostics__meta">
            {model.phaseRows.length} phases
          </span>
        </div>
        <div className="fm-footer-diagnostics__profile-table" role="table">
          <div
            className="fm-footer-diagnostics__profile-row fm-footer-diagnostics__profile-row--header"
            role="row"
          >
            <span role="columnheader">Phase</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Progress</span>
            <span role="columnheader">Detail</span>
          </div>
          {model.phaseRows.map((phase) => (
            <div className="fm-footer-diagnostics__profile-row" role="row" key={phase.id}>
              <span role="cell">{phase.label}</span>
              <span role="cell">{phase.status}</span>
              <span role="cell">
                {phase.progressPercent === null ? "-" : `${phase.progressPercent}%`}
              </span>
              <span role="cell">{phase.detail || "-"}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="fm-footer-diagnostics__panel" aria-label="Published mesh output">
        <div className="fm-footer-diagnostics__heading">
          <span>Published Output</span>
          <span className="fm-footer-diagnostics__meta">
            resources
          </span>
        </div>
        <div className="fm-footer-diagnostics__profile-table" role="table">
          {model.publishedRows.map((row) => (
            <div className="fm-footer-diagnostics__profile-row" role="row" key={row.label}>
              <span role="cell">{row.label}</span>
              <span role="cell">{row.value}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="fm-footer-diagnostics__panel" aria-label="Latest successful mesh">
        <div className="fm-footer-diagnostics__heading">
          <span>Latest Success</span>
          <span className="fm-footer-diagnostics__meta">
            {historyCount} builds
          </span>
        </div>
        <div className="fm-footer-diagnostics__profile-table" role="table">
          {model.latestRows.map((row) => (
            <div className="fm-footer-diagnostics__profile-row" role="row" key={row.label}>
              <span role="cell">{row.label}</span>
              <span role="cell">{row.value}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="fm-footer-diagnostics__panel" aria-label="Mesh build history">
        <div className="fm-footer-diagnostics__heading">
          <span>Build History</span>
          <span className="fm-footer-diagnostics__meta">
            {historyCount} builds
          </span>
        </div>
        <div className="fm-footer-diagnostics__profile-table" role="table">
          <div
            className="fm-footer-diagnostics__profile-row fm-footer-diagnostics__profile-row--header"
            role="row"
          >
            <span role="columnheader">Mesh</span>
            <span role="columnheader">Target</span>
            <span role="columnheader">Reason</span>
            <span role="columnheader">Nodes</span>
            <span role="columnheader">Elements</span>
          </div>
          {model.historyRows.map((row, index) => (
            <div className="fm-footer-diagnostics__profile-row" role="row" key={`${row.mesh}:${index}`}>
              <span role="cell">{row.mesh}</span>
              <span role="cell">{row.target}</span>
              <span role="cell">{row.reason}</span>
              <span role="cell">{row.nodes}</span>
              <span role="cell">{row.elements}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="fm-footer-diagnostics__panel" aria-label="Viewport mesh confirmation">
        <div className="fm-footer-diagnostics__heading">
          <span>Viewport Delivery</span>
          <span className="fm-footer-diagnostics__meta">
            diagnostic
          </span>
        </div>
        <div className="fm-footer-diagnostics__profile-table" role="table">
          {model.viewportRows.map((row) => (
            <div className="fm-footer-diagnostics__profile-row" role="row" key={row.label}>
              <span role="cell">{row.label}</span>
              <span role="cell">{row.value}</span>
            </div>
          ))}
        </div>
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
