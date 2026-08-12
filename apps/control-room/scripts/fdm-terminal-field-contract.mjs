const REQUIRED_FIELDS = [
  ["object", "H_demag", "full_domain"],
  ["object", "H_eff", "full_domain"],
  ["object", "H_ext", "full_domain"],
  ["object", "eden_demag", "magnetic_only"],
  ["airbox", "H_demag", "full_domain"],
  ["airbox", "H_eff", "full_domain"],
];

export function terminalFieldRequestPath(quantityId, { scopeId, scopeKind }) {
  const query = new URLSearchParams({
    component: "full",
    scope_id: scopeId,
    scope_kind: scopeKind,
  });
  return `/v2/sessions/current/data/fields/${encodeURIComponent(quantityId)}/meta?${query}`;
}

export function assertInteractiveTerminalRun({ run, sessionStatus, stageExecution }) {
  if (!hasCompletedTerminalStage(stageExecution)) {
    throw new Error("Interactive terminal FDM smoke requires a completed terminal stage execution.");
  }
  if (String(stageExecution?.runtime_state ?? "").toLowerCase() !== "completed") {
    throw new Error(`Interactive terminal stage execution must remain completed, got ${stageExecution?.runtime_state}.`);
  }
  if (stageExecution?.active_stage_index != null) {
    throw new Error("Completed terminal stage execution must not retain an active stage.");
  }
  if (String(run?.status ?? "").toLowerCase() !== "awaiting_command") {
    throw new Error(`Interactive terminal run must be awaiting_command, got ${run?.status}.`);
  }
  if (String(sessionStatus?.solver?.state ?? "").toLowerCase() !== "awaiting_command") {
    throw new Error(`Interactive terminal session must be awaiting_command, got ${sessionStatus?.solver?.state}.`);
  }
  if (!Number.isInteger(run?.total_steps) || run.total_steps < 0 || !Number.isFinite(run?.solver_time_seconds) || run.solver_time_seconds <= 0) {
    throw new Error(`Invalid interactive terminal source coordinates: step=${run?.total_steps} time=${run?.solver_time_seconds}.`);
  }
  return { final_step: run.total_steps, final_time: run.solver_time_seconds };
}

export function assertCompletedTerminalFieldContract({
  catalog,
  fields,
  finalStep,
  finalTime,
  stageExecution,
}) {
  if (!hasCompletedStage(stageExecution)) {
    throw new Error("FDM terminal smoke requires a completed stage execution.");
  }
  if (!Number.isInteger(finalStep) || finalStep < 0 || !Number.isFinite(finalTime) || finalTime <= 0) {
    throw new Error(`Invalid completed FDM source coordinates: step=${finalStep} time=${finalTime}.`);
  }
  const quantities = new Map((catalog?.quantities ?? []).map((value) => [value.quantity_id, value]));
  const generations = [];
  for (const [scope, quantityId, domain] of REQUIRED_FIELDS) {
    const catalogEntry = quantities.get(quantityId);
    if (!catalogEntry?.available || catalogEntry.domain !== domain) {
      throw new Error(`Field catalog does not expose ${quantityId} as available ${domain}.`);
    }
    const field = fields?.[`${scope}:${quantityId}`];
    if (!field || field.state !== "complete") {
      throw new Error(`Terminal ${scope} ${quantityId} field is not complete.`);
    }
    if (field.source_step !== finalStep) {
      throw new Error(`Terminal ${scope} ${quantityId} source_step ${field.source_step} != ${finalStep}.`);
    }
    if (!sameTime(field.source_time_seconds, finalTime)) {
      throw new Error(`Terminal ${scope} ${quantityId} source_time_seconds ${field.source_time_seconds} != ${finalTime}.`);
    }
    const generation = field.field_generation ?? field.domain_generation_id ?? catalog?.domain_generation_id;
    if (generation == null || generation === "") {
      throw new Error(`Terminal ${scope} ${quantityId} lacks a field generation identity.`);
    }
    generations.push(JSON.stringify(generation));
  }
  if (new Set(generations).size !== 1) {
    throw new Error(`Terminal fields span multiple generations: ${generations.join(", ")}.`);
  }
  return {
    final_step: finalStep,
    final_time: finalTime,
    generation: JSON.parse(generations[0]),
    required_fields: REQUIRED_FIELDS.map(([scope, quantityId]) => `${scope}:${quantityId}`),
  };
}

export function assertCompletedTerminalTelemetry({ finalStep, finalTime, objectMetrics, tableRows }) {
  if (!objectMetrics?.has_solver_sample || objectMetrics.step !== finalStep || !sameTime(objectMetrics.time_seconds, finalTime)) {
    throw new Error("Object terminal metrics do not match the completed solver step/time.");
  }
  const average = objectMetrics.magnetization_average;
  if (![average?.mx, average?.my, average?.mz].every(Number.isFinite) || Math.hypot(average.mx, average.my, average.mz) <= 0) {
    throw new Error("Object terminal average magnetization is missing or zero.");
  }
  const columnIndex = new Map((tableRows?.columns ?? []).map((column, index) => [column.column_id, index]));
  const row = tableRows?.rows?.at(-1);
  const step = row?.[columnIndex.get("step")];
  const time = row?.[columnIndex.get("t") ?? columnIndex.get("time")];
  const dt = row?.[columnIndex.get("dt") ?? columnIndex.get("solver_dt")];
  const mx = row?.[columnIndex.get("mx")];
  const my = row?.[columnIndex.get("my")];
  const mz = row?.[columnIndex.get("mz")];
  if (step !== finalStep || !sameTime(time, finalTime) || !Number.isFinite(dt) || dt <= 0 || ![mx, my, mz].every(Number.isFinite) || Math.hypot(mx, my, mz) <= 0) {
    throw new Error("Final table telemetry lacks matching nonzero time, dt, or average magnetization.");
  }
  return { step, time_seconds: time, solver_dt_seconds: dt, magnetization_average: { mx, my, mz } };
}

function hasCompletedStage(value) {
  if (!value || typeof value !== "object") return false;
  if (String(value.status ?? "").toLowerCase() === "completed") return true;
  return Object.values(value).some((entry) =>
    Array.isArray(entry) ? entry.some(hasCompletedStage) : hasCompletedStage(entry),
  );
}

function hasCompletedTerminalStage(value) {
  return Array.isArray(value?.stages)
    && value.stages.some((stage) => String(stage?.status ?? "").toLowerCase() === "completed")
    && Array.isArray(value?.completed_stage_indexes)
    && value.completed_stage_indexes.length > 0;
}

function sameTime(left, right) {
  return Number.isFinite(left) && Math.abs(left - right) <= Math.max(1e-18, Math.abs(right) * 1e-9);
}
