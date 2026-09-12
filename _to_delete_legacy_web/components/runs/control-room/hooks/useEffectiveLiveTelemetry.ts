import { useMemo } from "react";
import type {
  LiveState,
  RunManifest,
  ScalarRow,
} from "@/lib/session/types";

export function preferScalarMetricWhenLiveLooksMissing({
  liveValue,
  scalarValue,
  liveStep,
  scalarStep,
}: {
  liveValue: number | null | undefined;
  scalarValue: number | null | undefined;
  liveStep: number;
  scalarStep: number;
}): number {
  const liveFinite = typeof liveValue === "number" && Number.isFinite(liveValue);
  const scalarFinite = typeof scalarValue === "number" && Number.isFinite(scalarValue);

  if (!scalarFinite) {
    return liveFinite ? Number(liveValue) : 0;
  }
  if (!liveFinite) {
    return Number(scalarValue);
  }
  if (Number(liveValue) === 0 && Number(scalarValue) !== 0 && scalarStep >= liveStep) {
    return Number(scalarValue);
  }
  return Number(liveValue);
}

export function useEffectiveLiveTelemetry({
  liveState,
  run,
  scalarRows,
}: {
  liveState: LiveState | null;
  run: RunManifest | null;
  scalarRows: ScalarRow[];
}) {
  const liveIsStale = (liveState?.step ?? 0) === 0 && (run?.total_steps ?? 0) > 0;
  const latestScalarRow = scalarRows.length > 0 ? scalarRows[scalarRows.length - 1] : null;
  const liveStep = liveState?.step ?? 0;
  const scalarStep = latestScalarRow?.step ?? 0;
  const effectiveStep = liveIsStale ? (run?.total_steps ?? 0) : (liveState?.step ?? run?.total_steps ?? 0);
  const effectiveTime = liveIsStale ? (run?.final_time ?? 0) : (liveState?.time ?? run?.final_time ?? 0);
  const effectiveDt = liveIsStale ? 0 : (liveState?.dt ?? 0);
  const effectiveEEx = liveIsStale ? (run?.final_e_ex ?? 0) : (liveState?.e_ex ?? run?.final_e_ex ?? 0);
  const effectiveEDemag = liveIsStale ? (run?.final_e_demag ?? 0) : (liveState?.e_demag ?? run?.final_e_demag ?? 0);
  const effectiveEExt = liveIsStale ? (run?.final_e_ext ?? 0) : (liveState?.e_ext ?? run?.final_e_ext ?? 0);
  const effectiveEAni = liveIsStale ? (run?.final_e_ani ?? 0) : (liveState?.e_ani ?? run?.final_e_ani ?? 0);
  const effectiveEDmi = liveIsStale ? (run?.final_e_dmi ?? 0) : (liveState?.e_dmi ?? run?.final_e_dmi ?? 0);
  const effectiveETotal = liveIsStale ? (run?.final_e_total ?? 0) : (liveState?.e_total ?? run?.final_e_total ?? 0);
  const effectiveDmDt = liveIsStale
    ? 0
    : preferScalarMetricWhenLiveLooksMissing({
        liveValue: liveState?.max_dm_dt,
        scalarValue: latestScalarRow?.max_dm_dt,
        liveStep,
        scalarStep,
      });
  const latestScalarTorqueT = latestScalarRow?.max_torque_T ?? 0;
  const effectiveTorqueT = liveIsStale
    ? latestScalarTorqueT
    : preferScalarMetricWhenLiveLooksMissing({
        liveValue: liveState?.max_torque_T,
        scalarValue: latestScalarTorqueT,
        liveStep,
        scalarStep,
      });
  const effectiveTorqueApm = liveIsStale
    ? latestScalarRow?.max_torque_Apm ?? 0
    : preferScalarMetricWhenLiveLooksMissing({
        liveValue: liveState?.max_torque_Apm,
        scalarValue: latestScalarRow?.max_torque_Apm,
        liveStep,
        scalarStep,
      });
  const effectiveHEff = liveIsStale
    ? 0
    : preferScalarMetricWhenLiveLooksMissing({
        liveValue: liveState?.max_h_eff,
        scalarValue: latestScalarRow?.max_h_eff,
        liveStep,
        scalarStep,
      });
  const effectiveHDemag = liveIsStale
    ? 0
    : preferScalarMetricWhenLiveLooksMissing({
        liveValue: liveState?.max_h_demag,
        scalarValue: latestScalarRow?.max_h_demag,
        liveStep,
        scalarStep,
      });

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
      max_torque_Apm: effectiveTorqueApm,
      max_torque_T: effectiveTorqueT,
      max_h_eff: effectiveHEff,
      max_h_demag: effectiveHDemag,
    };
  }, [
    effectiveDmDt,
    effectiveDt,
    effectiveEAni,
    effectiveEDemag,
    effectiveEDmi,
    effectiveEEx,
    effectiveEExt,
    effectiveETotal,
    effectiveHDemag,
    effectiveHEff,
    effectiveStep,
    effectiveTime,
    effectiveTorqueApm,
    effectiveTorqueT,
    liveIsStale,
    liveState,
  ]);

  return {
    effectiveDmDt,
    effectiveDt,
    effectiveEAni,
    effectiveEDemag,
    effectiveEDmi,
    effectiveEEx,
    effectiveEExt,
    effectiveETotal,
    effectiveHDemag,
    effectiveHEff,
    effectiveLiveState,
    effectiveStep,
    effectiveTime,
    effectiveTorqueT,
  };
}
