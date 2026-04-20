/* ── Session state merge logic ──
 * Merges incremental SSE snapshots without regressing data. */

import type {
  EngineLogEntry,
  FemLiveMesh,
  LatestFieldFrame,
  LatestFields,
  PreviewState,
  SceneDocument,
  ScalarRow,
  SessionState,
  ScriptBuilderState,
} from "./types";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "../debug/frontendDiagnosticFlags";

function lastScalarStep(rows: ScalarRow[]): number {
  return rows.length > 0 ? rows[rows.length - 1]?.step ?? -1 : -1;
}

function lastLogTimestamp(entries: EngineLogEntry[]): number {
  return entries.length > 0 ? entries[entries.length - 1]?.timestamp_unix_ms ?? -1 : -1;
}

const ENABLE_LIVE_DEBUG_LOGS =
  FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging &&
  typeof process !== "undefined" &&
  process.env.NODE_ENV !== "production";

function previewSequence(preview: PreviewState | null): [number, number, number] {
  if (!preview) return [-1, -1, -1];
  return [preview.config_revision, preview.source_step, preview.source_time];
}

function compareLexicographic(
  lhs: [number, number, number],
  rhs: [number, number, number],
): number {
  for (let i = 0; i < lhs.length; i += 1) {
    if (lhs[i] > rhs[i]) return 1;
    if (lhs[i] < rhs[i]) return -1;
  }
  return 0;
}

function femMeshIdentity(mesh: FemLiveMesh | null): string | null {
  if (!mesh) return null;
  if (mesh.generation_id) return `gen:${mesh.generation_id}`;
  if (mesh.mesh_id) return `mesh:${mesh.mesh_id}`;
  return [
    mesh.nodes.length,
    mesh.elements.length,
    mesh.boundary_faces.length,
  ].join(":");
}

function sameFemMeshIdentity(lhs: FemLiveMesh | null, rhs: FemLiveMesh | null): boolean {
  const left = femMeshIdentity(lhs);
  const right = femMeshIdentity(rhs);
  return left != null && left === right;
}

function samePreviewIdentity(lhs: PreviewState | null, rhs: PreviewState | null): boolean {
  if (!lhs || !rhs || lhs.kind !== rhs.kind) {
    return false;
  }
  if (lhs.kind === "spatial" && rhs.kind === "spatial") {
    return (
      lhs.quantity === rhs.quantity &&
      lhs.component === rhs.component &&
      lhs.spatial_kind === rhs.spatial_kind &&
      compareLexicographic(previewSequence(lhs), previewSequence(rhs)) === 0
    );
  }
  if (lhs.kind === "global_scalar" && rhs.kind === "global_scalar") {
    return (
      lhs.quantity === rhs.quantity &&
      lhs.config_revision === rhs.config_revision &&
      lhs.source_step === rhs.source_step &&
      lhs.source_time === rhs.source_time
    );
  }
  return false;
}

function sameSceneRevision(
  lhs: SceneDocument | null | undefined,
  rhs: SceneDocument | null | undefined,
): boolean {
  return Boolean(lhs && rhs && lhs.revision === rhs.revision);
}

function sameScriptRevision(
  lhs: ScriptBuilderState | null | undefined,
  rhs: ScriptBuilderState | null | undefined,
): boolean {
  return Boolean(lhs && rhs && lhs.revision === rhs.revision);
}

function sameVec3(
  lhs: [number, number, number] | null | undefined,
  rhs: [number, number, number] | null | undefined,
): boolean {
  if (lhs === rhs) {
    return true;
  }
  if (!lhs || !rhs) {
    return lhs == null && rhs == null;
  }
  return lhs[0] === rhs[0] && lhs[1] === rhs[1] && lhs[2] === rhs[2];
}

function sameLatestFieldFrameIdentity(
  lhs: LatestFieldFrame | null | undefined,
  rhs: LatestFieldFrame | null | undefined,
): boolean {
  if (lhs === rhs) {
    return true;
  }
  if (!lhs || !rhs) {
    return false;
  }
  return (
    lhs.quantity_id === rhs.quantity_id &&
    lhs.unit === rhs.unit &&
    lhs.n_comp === rhs.n_comp &&
    sameVec3(lhs.grid, rhs.grid) &&
    lhs.location === rhs.location &&
    lhs.domain === rhs.domain &&
    lhs.field_revision === rhs.field_revision &&
    lhs.source_step === rhs.source_step &&
    lhs.source_time === rhs.source_time &&
    lhs.values.length === rhs.values.length &&
    (lhs.active_mask?.length ?? -1) === (rhs.active_mask?.length ?? -1)
  );
}

function reuseLatestFieldsReferences(
  prev: LatestFields,
  next: LatestFields,
): LatestFields {
  const prevKeys = Object.keys(prev.frames);
  const nextKeys = Object.keys(next.frames);
  let changed =
    prevKeys.length !== nextKeys.length ||
    !sameVec3(prev.grid, next.grid);
  const nextFrames: Record<string, LatestFieldFrame> = {};

  for (const key of nextKeys) {
    const nextFrame = next.frames[key];
    const prevFrame = prev.frames[key];
    if (sameLatestFieldFrameIdentity(prevFrame, nextFrame)) {
      nextFrames[key] = prevFrame;
    } else {
      nextFrames[key] = nextFrame;
      changed = true;
    }
  }

  if (!changed && prevKeys.every((key) => key in next.frames)) {
    return prev;
  }

  return {
    frames: nextFrames,
    grid: sameVec3(prev.grid, next.grid) ? prev.grid : next.grid,
  };
}

function syncLatestMagnetizationFrameFromLiveState(
  state: SessionState,
  fallbackFrame?: LatestFieldFrame | null,
) {
  const magnetization = state.live_state?.magnetization;
  if (!magnetization || magnetization.length === 0 || magnetization.length % 3 !== 0) {
    return;
  }

  const nodeCount = magnetization.length / 3;
  const nextGrid: [number, number, number] =
    state.latest_fields.frames.m?.grid ??
    fallbackFrame?.grid ??
    [nodeCount, 1, 1];

  state.latest_fields = {
    ...state.latest_fields,
    grid: state.latest_fields.grid ?? nextGrid,
    frames: {
      ...state.latest_fields.frames,
      m: {
        quantity_id: "m",
        unit: state.latest_fields.frames.m?.unit ?? fallbackFrame?.unit ?? "dimensionless",
        n_comp: 3,
        grid: nextGrid,
        values: magnetization,
        active_mask:
          state.latest_fields.frames.m?.active_mask ??
          fallbackFrame?.active_mask ??
          null,
        location:
          state.latest_fields.frames.m?.location ??
          fallbackFrame?.location ??
          null,
        domain:
          state.latest_fields.frames.m?.domain ??
          fallbackFrame?.domain ??
          "magnetic_only",
        field_revision:
          state.latest_fields.frames.m?.field_revision ??
          fallbackFrame?.field_revision ??
          state.live_state?.step ??
          null,
        source_step:
          state.latest_fields.frames.m?.source_step ??
          fallbackFrame?.source_step ??
          state.live_state?.step ??
          null,
        source_time:
          state.latest_fields.frames.m?.source_time ??
          fallbackFrame?.source_time ??
          state.live_state?.time ??
          null,
      },
    },
  };
}

/**
 * Maximum number of scalar rows retained in the in-memory live window.
 * Rows beyond this limit are trimmed from the front (oldest first).
 * The full history is available from `GET /v1/live/current/scalars`.
 */
const MAX_LIVE_SCALAR_ROWS = 10_000;

export function mergeScalarRowsDelta(
  prevRows: ScalarRow[],
  nextRows: ScalarRow[],
  scalarRowsTotal?: number,
  maxRows: number | null = MAX_LIVE_SCALAR_ROWS,
): ScalarRow[] {
  const prevScalarStep = lastScalarStep(prevRows);
  const nextScalarStep = lastScalarStep(nextRows);

  let result: ScalarRow[];

  if (prevRows.length === 0) {
    result = nextRows;
  } else if (nextRows.length === 0) {
    result =
      (scalarRowsTotal ?? 0) > 0 && prevRows.length > 0
        ? prevRows
        : nextRows;
  } else if (nextScalarStep < prevScalarStep) {
    result = prevRows;
  } else {
    const firstNextStep = nextRows[0]?.step ?? -1;
    const looksLikeFullSnapshot =
      firstNextStep === 0 ||
      nextRows.length >= prevRows.length ||
      nextRows.length === (scalarRowsTotal ?? -1);

    if (looksLikeFullSnapshot && nextScalarStep >= prevScalarStep) {
      result = nextRows;
    } else if (firstNextStep > prevScalarStep) {
      const prevStepSet = new Set(prevRows.map((r) => r.step));
      const genuinelyNew = nextRows.filter((r) => !prevStepSet.has(r.step));
      result = genuinelyNew.length > 0 ? [...prevRows, ...genuinelyNew] : prevRows;
    } else {
      const overlapIndex = prevRows.findIndex((row) => row.step >= firstNextStep);
      if (overlapIndex >= 0 && prevRows[overlapIndex]?.step === firstNextStep) {
        result = [...prevRows.slice(0, overlapIndex), ...nextRows];
      } else {
        result = prevRows;
      }
    }
  }

  // Enforce hard cap on in-memory scalar rows unless the caller opts out.
  if (maxRows != null && result.length > maxRows) {
    return result.slice(result.length - maxRows);
  }
  return result;
}

export function mergeSessionState(prev: SessionState | null, next: SessionState): SessionState {
  // When the sparse WS event omits `session`, carry it forward from prev.
  const effectiveSession = next.session ?? prev?.session ?? null;
  if (!effectiveSession) {
    return prev ?? next;
  }
  if (!prev) {
    return { ...next, session: effectiveSession };
  }
  if (!prev.session) {
    return { ...next, session: effectiveSession };
  }
  if (prev.session.session_id !== effectiveSession.session_id) {
    return { ...next, session: effectiveSession };
  }

  const prevLiveTs = prev.live_state?.updated_at_unix_ms ?? -1;
  const nextLiveTs = next.live_state?.updated_at_unix_ms ?? -1;
  const prevLiveStep = prev.live_state?.step ?? -1;
  const nextLiveStep = next.live_state?.step ?? -1;
  const prevScalarStep = lastScalarStep(prev.scalar_rows);
  const nextScalarStep = lastScalarStep(next.scalar_rows);
  const timelineReset =
    prev.live_state != null &&
    next.live_state != null &&
    nextLiveTs > prevLiveTs &&
    (
      nextLiveStep < prevLiveStep ||
      (prevScalarStep >= 0 && nextScalarStep >= 0 && nextScalarStep < prevScalarStep)
    );

  if (timelineReset) {
    return {
      ...next,
      session: effectiveSession,
      command_status: next.command_status ?? prev.command_status,
    };
  }

  const merged: SessionState = { ...next, session: effectiveSession };
  const prevSceneRevision = prev.scene_document?.revision ?? -1;
  const nextSceneRevision = next.scene_document?.revision ?? -1;
  const sceneRevisionAdvanced = nextSceneRevision > prevSceneRevision;

  // ── Sparse envelope carry-forward ──
  // When the backend omits heavy static fields from a WS delta event,
  // the normalized `next` will have null/empty values.  Carry forward from prev.
  if (!merged.run && prev.run) merged.run = prev.run;
  if (!merged.capabilities && prev.capabilities) merged.capabilities = prev.capabilities;
  if (!merged.metadata && prev.metadata) merged.metadata = prev.metadata;
  if (!merged.mesh_workspace && prev.mesh_workspace) merged.mesh_workspace = prev.mesh_workspace;
  if (merged.artifacts.length === 0 && prev.artifacts.length > 0) merged.artifacts = prev.artifacts;

  if (!merged.fem_mesh && prev.fem_mesh) {
    merged.fem_mesh = prev.fem_mesh;
  } else if (sameFemMeshIdentity(prev.fem_mesh, merged.fem_mesh)) {
    merged.fem_mesh = prev.fem_mesh;
  } else if (
    merged.fem_mesh?.generation_id &&
    prev.fem_mesh?.generation_id &&
    merged.fem_mesh.generation_id !== prev.fem_mesh.generation_id
  ) {
    // New mesh generation: keep the fresh payload and let higher layers reset view state.
  }

  const liveRegressed =
    prev.live_state != null &&
    (
      next.live_state == null ||
      nextLiveTs < prevLiveTs ||
      (nextLiveTs === prevLiveTs && nextLiveStep < prevLiveStep)
    );

  if (liveRegressed) {
    merged.live_state = prev.live_state;
    merged.latest_fields = prev.latest_fields;
    if (prev.fem_mesh) {
      merged.fem_mesh = prev.fem_mesh;
    }
  }

  const prevRunSteps = prev.run?.total_steps ?? -1;
  const nextRunSteps = next.run?.total_steps ?? -1;
  if (prev.run && next.run && nextRunSteps < prevRunSteps) {
    merged.run = prev.run;
  }

  if (
    prev.display_selection &&
    (
      !next.display_selection ||
      next.display_selection.revision <= prev.display_selection.revision
    )
  ) {
    merged.display_selection = prev.display_selection;
  }

  if (
    prev.preview_config &&
    (
      !next.preview_config ||
      next.preview_config.revision <= prev.preview_config.revision
    )
  ) {
    merged.preview_config = prev.preview_config;
  }

  const previewOrdering = compareLexicographic(
    previewSequence(next.preview),
    previewSequence(prev.preview),
  );
  const previewRegressed =
    prev.preview != null &&
    next.preview != null &&
    previewOrdering < 0;
  if (previewRegressed || (prev.preview != null && next.preview == null)) {
    merged.preview = prev.preview;
  } else if (samePreviewIdentity(prev.preview, merged.preview)) {
    merged.preview = prev.preview;
  }

  if (prev.runtime_status && !next.runtime_status) {
    merged.runtime_status = prev.runtime_status;
  }

  if (
    prev.scene_document &&
    (
      !next.scene_document ||
      next.scene_document.revision < prev.scene_document.revision
    )
  ) {
    merged.scene_document = prev.scene_document;
    merged.script_builder = prev.script_builder;
    merged.model_builder_graph = prev.model_builder_graph;
  } else if (sameSceneRevision(prev.scene_document, merged.scene_document)) {
    merged.scene_document = prev.scene_document;
  }

  if (
    prev.script_builder &&
    (
      !next.script_builder ||
      next.script_builder.revision < prev.script_builder.revision
    )
  ) {
    merged.script_builder = prev.script_builder;
  } else if (sameScriptRevision(prev.script_builder, merged.script_builder)) {
    merged.script_builder = prev.script_builder;
  }

  if (
    prev.model_builder_graph &&
    (
      !next.model_builder_graph ||
      next.model_builder_graph.revision < prev.model_builder_graph.revision
    )
  ) {
    merged.model_builder_graph = prev.model_builder_graph;
  } else if (
    prev.model_builder_graph &&
    merged.model_builder_graph &&
    prev.model_builder_graph.revision === merged.model_builder_graph.revision
  ) {
    merged.model_builder_graph = prev.model_builder_graph;
  }

  merged.scalar_rows = mergeScalarRowsDelta(
    prev.scalar_rows,
    next.scalar_rows,
    next.scalar_rows_total,
  );
  // else: next has more rows than prev AND starts before prevScalarStep → full snapshot → use next as-is.

  if (ENABLE_LIVE_DEBUG_LOGS) {
    const v2Step = next.step_update_v2?.scalars?.step ?? null;
    console.debug(
      `[merge] prev=${prev.scalar_rows.length} next_raw=${next.scalar_rows.length}` +
      ` total=${next.scalar_rows_total ?? "?"}` +
      ` v2_step=${v2Step ?? "-"}` +
      ` merged=${merged.scalar_rows.length}` +
      ` prevTip=${prevScalarStep} nextTip=${nextScalarStep}`,
    );
  }

  // Quantities are omitted from WS delta events when unchanged — keep the previous value.
  if (merged.quantities.length === 0 && prev.quantities.length > 0) {
    merged.quantities = prev.quantities;
  }

  // Sparse delta: latest_fields is omitted when unchanged — keep previous.
  if (
    Object.keys(merged.latest_fields.frames).length === 0 &&
    Object.keys(prev.latest_fields.frames).length > 0 &&
    !liveRegressed
  ) {
    merged.latest_fields = prev.latest_fields;
  } else if (Object.keys(prev.latest_fields.frames).length > 0) {
    merged.latest_fields = reuseLatestFieldsReferences(prev.latest_fields, merged.latest_fields);
  }

  const liveStepAdvanced = nextLiveStep > prevLiveStep;

  if (
    merged.live_state?.magnetization &&
    (sceneRevisionAdvanced || liveStepAdvanced || !merged.latest_fields.frames.m)
  ) {
    syncLatestMagnetizationFrameFromLiveState(
      merged,
      prev.latest_fields.frames.m ?? null,
    );
  }

  const prevLogTs = lastLogTimestamp(prev.engine_log);
  const nextLogTs = lastLogTimestamp(next.engine_log);
  if (nextLogTs < prevLogTs) {
    merged.engine_log = prev.engine_log;
  } else if (
    next.engine_log.length === prev.engine_log.length &&
    nextLogTs === prevLogTs
  ) {
    merged.engine_log = prev.engine_log;
  }

  if (!merged.command_status && prev.command_status) {
    merged.command_status = prev.command_status;
  }
  if (!merged.stage_execution && prev.stage_execution) {
    merged.stage_execution = prev.stage_execution;
  }
  if (
    typeof prev.state_version === "number" &&
    (typeof merged.state_version !== "number" || merged.state_version < prev.state_version)
  ) {
    merged.state_version = prev.state_version;
  }

  return merged;
}
