"use client";

import { useMemo, useState, useEffect } from "react";
import type { TransportContextValue } from "../context-hooks";
import { EMPTY_SCALAR_ROWS } from "../shared";
import type { SessionState, LiveState, ScalarRow } from "../../../../lib/session/types";

// ─── Hook ───────────────────────────────────────────────────────────

export function useControlRoomTransport(state: SessionState | null): TransportContextValue {
  const session = state?.session ?? null;
  const run = state?.run ?? null;
  const liveState = state?.live_state ?? null;
  const scalarRows = state?.scalar_rows ?? EMPTY_SCALAR_ROWS;
  const scalarRowsTotal =
    typeof state?.scalar_rows_total === "number"
      ? state.scalar_rows_total
      : scalarRows.length;
  const preview = state?.preview ?? null;

  const hasSolverTelemetry = useMemo(() => 
    (liveState?.step ?? 0) > 0 ||
    (run?.total_steps ?? 0) > 0 ||
    scalarRows.length > 0 ||
    session?.status === "completed" ||
    session?.status === "failed",
  [liveState?.step, run?.total_steps, scalarRows.length, session?.status]);

  /* Effective solver values (fallback to run manifest when live is stale) */
  const liveIsStale = (liveState?.step ?? 0) === 0 && (run?.total_steps ?? 0) > 0;
  
  const effectiveStep = liveIsStale ? (run?.total_steps ?? 0) : (liveState?.step ?? run?.total_steps ?? 0);
  const effectiveTime = liveIsStale ? (run?.final_time ?? 0) : (liveState?.time ?? run?.final_time ?? 0);
  const effectiveDt = liveIsStale ? 0 : (liveState?.dt ?? 0);
  const effectiveEEx = liveIsStale ? (run?.final_e_ex ?? 0) : (liveState?.e_ex ?? run?.final_e_ex ?? 0);
  const effectiveEDemag = liveIsStale ? (run?.final_e_demag ?? 0) : (liveState?.e_demag ?? run?.final_e_demag ?? 0);
  const effectiveEExt = liveIsStale ? (run?.final_e_ext ?? 0) : (liveState?.e_ext ?? run?.final_e_ext ?? 0);
  const effectiveEAni = liveIsStale ? (run?.final_e_ani ?? 0) : (liveState?.e_ani ?? run?.final_e_ani ?? 0);
  const effectiveEDmi = liveIsStale ? (run?.final_e_dmi ?? 0) : (liveState?.e_dmi ?? run?.final_e_dmi ?? 0);
  const effectiveETotal = liveIsStale ? (run?.final_e_total ?? 0) : (liveState?.e_total ?? run?.final_e_total ?? 0);
  const effectiveDmDt = liveIsStale ? 0 : (liveState?.max_dm_dt ?? 0);
  const latestScalarTorqueT = scalarRows.length > 0 ? (scalarRows[scalarRows.length - 1]?.max_torque_T ?? 0) : 0;
  const effectiveTorqueT = liveIsStale
    ? latestScalarTorqueT
    : (liveState?.max_torque_T ?? latestScalarTorqueT);
  const effectiveHEff = liveIsStale ? 0 : (liveState?.max_h_eff ?? 0);
  const effectiveHDemag = liveIsStale ? 0 : (liveState?.max_h_demag ?? 0);

  const effectiveLiveState = useMemo(() => {
    if (!liveState) return null;
    if (!liveIsStale) return liveState;
    return {
      ...liveState,
      step: effectiveStep, 
      time: effectiveTime, 
      dt: effectiveDt,
      e_ex: effectiveEEx, 
      e_demag: effectiveEDemag, 
      e_ext: effectiveEExt, 
      e_ani: effectiveEAni,
      e_dmi: effectiveEDmi,
      e_total: effectiveETotal,
      max_dm_dt: effectiveDmDt, 
      max_torque_T: effectiveTorqueT,
      max_h_eff: effectiveHEff, 
      max_h_demag: effectiveHDemag,
    } as LiveState;
  }, [liveState, liveIsStale, effectiveStep, effectiveTime, effectiveDt,
      effectiveEEx, effectiveEDemag, effectiveEExt, effectiveEAni, effectiveEDmi, effectiveETotal,
      effectiveDmDt, effectiveTorqueT, effectiveHEff, effectiveHDemag]);

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const isRunning = session?.status === "running" || session?.status === "materializing_script";
    if (!isRunning) return;
    
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [session?.status]);

  /* Status bar */
  const elapsed = useMemo(() => {
    if (!session) return 0;
    if (session.finished_at_unix_ms > session.started_at_unix_ms) {
      return session.finished_at_unix_ms - session.started_at_unix_ms;
    }
    return now - session.started_at_unix_ms;
  }, [session, now]);
  
  const stepsPerSec = useMemo(() => 
    elapsed > 0 ? (effectiveStep / elapsed) * 1000 : 0,
  [elapsed, effectiveStep]);

  /* Sparklines — depend on stable scalarRows ref */
  const eTotalSpark = useMemo(() => scalarRows.slice(-40).map((r: ScalarRow) => r.e_total ?? 0), [scalarRows]);
  const dmDtSpark = useMemo(() => scalarRows.slice(-40).map((r: ScalarRow) => Math.log10(Math.max(r.max_dm_dt ?? 1e-15, 1e-15))), [scalarRows]);
  const dtSpark = useMemo(() => scalarRows.slice(-40).map((r: ScalarRow) => r.solver_dt ?? 0), [scalarRows]);

  // ── Memoize the entire return value ──────────────────────────────
  // Only re-creates the object when an actual value changes, preventing
  // unnecessary re-renders in every consumer component.
  return useMemo((): TransportContextValue => ({
    effectiveStep,
    effectiveTime,
    effectiveDt,
    effectiveDmDt,
    effectiveTorqueT,
    effectiveHEff,
    effectiveHDemag,
    effectiveEEx,
    effectiveEDemag,
    effectiveEExt,
    effectiveEAni,
    effectiveEDmi,
    effectiveETotal,
    elapsed,
    stepsPerSec,
    liveState,
    effectiveLiveState,
    scalarRows,
    scalarRowsTotal,
    dmDtSpark,
    dtSpark,
    eTotalSpark,
    preview,
    selectedVectors: null,
    fieldStats: null,
    hasSolverTelemetry,
  }), [
    effectiveStep, effectiveTime, effectiveDt,
    effectiveDmDt, effectiveTorqueT, effectiveHEff, effectiveHDemag,
    effectiveEEx, effectiveEDemag, effectiveEExt,
    effectiveEAni, effectiveEDmi, effectiveETotal,
    elapsed, stepsPerSec,
    liveState, effectiveLiveState,
    scalarRows, scalarRowsTotal,
    dmDtSpark, dtSpark, eTotalSpark,
    preview,
    hasSolverTelemetry,
  ]);
}
