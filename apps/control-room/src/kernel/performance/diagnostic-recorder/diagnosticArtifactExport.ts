import type { DiagnosticRecorderSnapshot } from "./DiagnosticRecorderController";
import { buildDiagnosticSuspectReport } from "./diagnosticSuspectReport";
import {
  buildDiagnosticViewport3DBuildSummary,
  buildDiagnosticViewport3DVisibleRevisionSummary,
} from "./diagnosticViewport3DSummaries";
import {
  DIAGNOSTIC_ARTIFACT_VERSION,
  type DiagnosticAnyRecord,
  type DiagnosticArtifactV1,
  type DiagnosticManifest,
  redactDiagnosticDetail,
} from "./diagnosticRecorderTypes";

export function buildDiagnosticArtifactV1(
  snapshot: DiagnosticRecorderSnapshot,
  manifestPatch: Partial<DiagnosticManifest> = {},
  now: () => number = Date.now,
): DiagnosticArtifactV1 {
  const artifactWithoutReport: Omit<DiagnosticArtifactV1, "suspectReport"> = {
    artifactVersion: DIAGNOSTIC_ARTIFACT_VERSION,
    manifest: {
      artifactVersion: DIAGNOSTIC_ARTIFACT_VERSION,
      branch: null,
      browserName: null,
      browserVersion: null,
      commit: null,
      createdAtIso: new Date(now()).toISOString(),
      profile: snapshot.profile,
      scenario: snapshot.scenario,
      url: null,
      ...manifestPatch,
    },
    streams: redactStreams(snapshot.streams),
    summary: snapshot.summary,
    viewport3dBuildSummary: buildDiagnosticViewport3DBuildSummary(
      snapshot.streams,
    ),
    viewport3dVisibleRevisionSummary:
      buildDiagnosticViewport3DVisibleRevisionSummary(snapshot.streams),
  };

  return {
    ...artifactWithoutReport,
    suspectReport: buildDiagnosticSuspectReport(artifactWithoutReport, now),
  };
}

export function serializeDiagnosticArtifactJson(
  artifact: DiagnosticArtifactV1,
): string {
  return JSON.stringify(redactArtifact(artifact), null, 2);
}

export function serializeDiagnosticStreamNdjson(
  records: readonly DiagnosticAnyRecord[],
): string {
  return records
    .map((record) => JSON.stringify(redactDiagnosticRecord(record)))
    .join("\n");
}

function redactDiagnosticRecord<TRecord extends DiagnosticAnyRecord>(
  record: TRecord,
): TRecord {
  return {
    ...record,
    detail: redactDiagnosticDetail(record.detail),
  };
}

function redactArtifact(artifact: DiagnosticArtifactV1): DiagnosticArtifactV1 {
  return {
    ...artifact,
    streams: redactStreams(artifact.streams),
  };
}

function redactStreams(
  streams: DiagnosticArtifactV1["streams"],
): DiagnosticArtifactV1["streams"] {
  return {
    browserMetrics: streams.browserMetrics.map(redactDiagnosticRecord),
    console: streams.console.map(redactDiagnosticRecord),
    memory: streams.memory.map(redactDiagnosticRecord),
    performance: streams.performance.map(redactDiagnosticRecord),
    react: streams.react.map(redactDiagnosticRecord),
    requests: streams.requests.map(redactDiagnosticRecord),
    resources: streams.resources.map(redactDiagnosticRecord),
    timeline: streams.timeline.map(redactDiagnosticRecord),
    viewport3dBuild: streams.viewport3dBuild.map(redactDiagnosticRecord),
    viewport3dWorkerPools: streams.viewport3dWorkerPools.map(
      redactDiagnosticRecord,
    ),
    viewport3d: streams.viewport3d.map(redactDiagnosticRecord),
  };
}
