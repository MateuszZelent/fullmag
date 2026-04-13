/* ── Session state merge logic ──
 * Merges incremental SSE snapshots without regressing data. */

import type {
  EngineLogEntry,
  PreviewState,
  RuntimeCurrentLiveEvent,
  ScalarRow,
  SessionState,
} from "./types";
import { normalizeDisplaySelection, normalizeMeshCommandTarget } from "./normalize";

function lastScalarStep(rows: ScalarRow[]): number {
  return rows.length > 0 ? rows[rows.length - 1]?.step ?? -1 : -1;
}

function lastLogTimestamp(entries: EngineLogEntry[]): number {
  return entries.length > 0 ? entries[entries.length - 1]?.timestamp_unix_ms ?? -1 : -1;
}

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

export function mergeSessionState(prev: SessionState | null, next: SessionState): SessionState {
  if (!next?.session) {
    return prev ?? next;
  }
  if (!prev) {
    return next;
  }
  if (!prev.session) {
    return next;
  }
  if (prev.session.session_id !== next.session.session_id) {
    return next;
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
      command_status: next.command_status ?? prev.command_status,
    };
  }

  const merged: SessionState = { ...next };

  if (!merged.fem_mesh && prev.fem_mesh) {
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
      next.display_selection.revision < prev.display_selection.revision
    )
  ) {
    merged.display_selection = prev.display_selection;
  }

  if (
    prev.preview_config &&
    (
      !next.preview_config ||
      next.preview_config.revision < prev.preview_config.revision
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
  }

  if (
    prev.script_builder &&
    (
      !next.script_builder ||
      next.script_builder.revision < prev.script_builder.revision
    )
  ) {
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
  }

  if (nextScalarStep < prevScalarStep) {
    // Regression guard: backend resent an older step — keep accumulated history.
    merged.scalar_rows = prev.scalar_rows;
  } else if (
    next.scalar_rows.length === 0 &&
    (next.scalar_rows_total ?? 0) > 0 &&
    prev.scalar_rows.length > 0
  ) {
    // Empty delta (no new rows in this broadcast) — keep accumulated history.
    merged.scalar_rows = prev.scalar_rows;
  } else if (next.scalar_rows.length > 0 && nextScalarStep > prevScalarStep) {
    // Determine whether `next.scalar_rows` is a pure delta (all rows newer than prev tip)
    // or a full snapshot that includes history overlapping with prev.
    const firstNextStep = next.scalar_rows[0]?.step ?? -1;
    const isPureDelta = firstNextStep > prevScalarStep;
    if (isPureDelta) {
      // All rows in next are genuinely new — append to accumulated history regardless
      // of relative lengths (handles the case where delta is larger than current accumulation).
      const prevStepSet = new Set(prev.scalar_rows.map((r) => r.step));
      const genuinelyNew = next.scalar_rows.filter((r) => !prevStepSet.has(r.step));
      merged.scalar_rows = genuinelyNew.length > 0
        ? [...prev.scalar_rows, ...genuinelyNew]
        : prev.scalar_rows;
    }
    // else: next starts at or before prevScalarStep → full snapshot; use next as-is
    // (merged.scalar_rows is already set to next.scalar_rows from { ...next }).
  } else if (nextScalarStep === prevScalarStep && next.scalar_rows.length < prev.scalar_rows.length) {
    // Stale V2-injected row: step_update_v2.scalars carried the same step as the
    // accumulated tip but with fewer rows than history — keep accumulated history.
    merged.scalar_rows = prev.scalar_rows;
  } else if (
    next.scalar_rows.length === prev.scalar_rows.length &&
    nextScalarStep === prevScalarStep
  ) {
    // Identical tip — prefer prev to avoid redundant re-renders.
    const prevLast = prev.scalar_rows[prev.scalar_rows.length - 1];
    const nextLast = next.scalar_rows[next.scalar_rows.length - 1];
    if (prevLast?.e_total === nextLast?.e_total && prevLast?.max_dm_dt === nextLast?.max_dm_dt) {
      merged.scalar_rows = prev.scalar_rows;
    }
  }
  // else: next has more rows than prev AND starts before prevScalarStep → full snapshot → use next as-is.

  if (process.env.NODE_ENV !== "production") {
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

  const prevLogTs = lastLogTimestamp(prev.engine_log);
  const nextLogTs = lastLogTimestamp(next.engine_log);
  if (nextLogTs < prevLogTs) {
    merged.engine_log = prev.engine_log;
  } else if (next.engine_log.length === prev.engine_log.length) {
    merged.engine_log = prev.engine_log;
  }

  if (!merged.command_status && prev.command_status) {
    merged.command_status = prev.command_status;
  }
  if (!merged.stage_execution && prev.stage_execution) {
    merged.stage_execution = prev.stage_execution;
  }

  return merged;
}

export function mergeCommandStatusEvent(
  prev: SessionState | null,
  raw: RuntimeCurrentLiveEvent,
): SessionState | null {
  if (!prev || !prev.session || prev.session.session_id !== raw.session_id) {
    return prev;
  }

  if (raw.kind === "command_ack") {
    const displaySelection =
      normalizeDisplaySelection(raw.display_selection) ?? prev.display_selection;
    return {
      ...prev,
      command_status: {
        session_id: raw.session_id,
        seq: Number(raw.seq ?? 0),
        command_id: String(raw.command_id ?? ""),
        command_kind: String(raw.command_kind ?? ""),
        state: "acknowledged",
        issued_at_unix_ms: Number(raw.issued_at_unix_ms ?? 0),
        completed_at_unix_ms: null,
        completion_state: null,
        reason: null,
        display_selection: displaySelection,
        mesh_target: normalizeMeshCommandTarget(raw.mesh_target),
        mesh_reason:
          typeof raw.mesh_reason === "string" && raw.mesh_reason.trim().length > 0
            ? raw.mesh_reason
            : null,
      },
    };
  }

  if (raw.kind === "command_rejected") {
    return {
      ...prev,
      command_status: {
        session_id: raw.session_id,
        seq: null,
        command_id: String(raw.command_id ?? ""),
        command_kind: String(raw.command_kind ?? ""),
        state: "rejected",
        issued_at_unix_ms: Number(raw.issued_at_unix_ms ?? 0),
        completed_at_unix_ms: null,
        completion_state: null,
        reason: String(raw.reason ?? ""),
        display_selection: prev.display_selection,
        mesh_target: normalizeMeshCommandTarget(raw.mesh_target),
        mesh_reason:
          typeof raw.mesh_reason === "string" && raw.mesh_reason.trim().length > 0
            ? raw.mesh_reason
            : null,
      },
    };
  }

  return {
    ...prev,
    command_status: {
      session_id: raw.session_id,
      seq: Number(raw.seq ?? 0),
      command_id: String(raw.command_id ?? ""),
      command_kind: String(raw.command_kind ?? ""),
      state: "completed",
      issued_at_unix_ms: null,
      completed_at_unix_ms: Number(raw.completed_at_unix_ms ?? 0),
      completion_state: String(raw.completion_state ?? ""),
      reason: null,
      display_selection: prev.display_selection,
      mesh_target: normalizeMeshCommandTarget(raw.mesh_target),
      mesh_reason:
        typeof raw.mesh_reason === "string" && raw.mesh_reason.trim().length > 0
          ? raw.mesh_reason
          : null,
    },
  };
}
