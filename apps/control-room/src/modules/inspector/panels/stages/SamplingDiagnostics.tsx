import { resolveHalfOpenSamplingClock } from "@/shared/domain/physics/sincPulsePreview";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import type {
  EffectiveStudyAutosaveOutput,
  EffectiveStudyTableAutosave,
} from "./studyWorkflowState";

type EffectiveSampling =
  | EffectiveStudyAutosaveOutput
  | EffectiveStudyTableAutosave;

export function SamplingDiagnostics({
  durationS,
  sampling,
}: {
  durationS: number | null;
  sampling: EffectiveSampling | null;
}) {
  const periodS = sampling
    ? "samplePeriodS" in sampling
      ? sampling.samplePeriodS
      : sampling.everySeconds
    : null;
  const clock = durationS && periodS
    ? resolveHalfOpenSamplingClock(durationS, periodS)
    : null;
  const auto = sampling?.autoSampling ?? null;

  if (sampling?.samplingMode === "auto_sinc_cutoff" && auto?.status === "unresolved") {
    return (
      <>
        <FieldRow label="Automatic sampling diagnostics" value="unresolved" />
        <FieldRow
          label="Source drives"
          value={sampling.sourceDriveIds.join(", ") || "none applicable"}
        />
        <FeedbackBanner
          kind="warning"
          message={`Automatic sampling is unresolved. ${auto.reason}`}
        />
      </>
    );
  }

  return (
    <>
      <FieldRow
        label="Automatic sampling diagnostics"
        value={
          sampling?.samplingMode === "auto_sinc_cutoff"
            ? "resolved from active sinc drives"
            : "not requested"
        }
      />
      {auto?.status === "ready" ? (
        <>
          <FieldRow
            label="Source drives"
            value={sampling?.sourceDriveIds.join(", ") || "none"}
          />
          <FieldRow
            label="Maximum sinc cutoff"
            value={engineering(auto.maximumCutoffHz, "Hz")}
          />
          <FieldRow label="Nyquist guard" value="1.3 × cutoff (+30%)" />
          <FieldRow
            label="Target Nyquist"
            value={engineering(auto.targetNyquistHz, "Hz")}
          />
          <FieldRow
            label="Sampling frequency"
            value={engineering(auto.samplingFrequencyHz, "Hz")}
          />
        </>
      ) : null}
      <div
        className="fm-sinc-preview__metrics"
        role="list"
        aria-label="Automatic sampling and response FFT parameters"
      >
        <Metric
          label="t_sampling"
          value={periodS ? engineering(periodS, "s") : "not available"}
        />
        <Metric label="N" value={clock ? String(clock.sampleCount) : "not available"} />
        <Metric
          label="df"
          value={clock ? engineering(clock.frequencyResolutionHz, "Hz") : "not available"}
        />
        <Metric
          label="Actual Nyquist"
          value={clock ? engineering(clock.nyquistHz, "Hz") : "not available"}
        />
      </div>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <span role="listitem"><small>{label}</small><strong>{value}</strong></span>;
}

export function engineering(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "invalid";
  if (value === 0) return `0 ${unit}`.trim();
  const exponent = Math.floor(Math.log10(Math.abs(value)) / 3) * 3;
  const prefixes: Record<number, string> = {
    [-15]: "f", [-12]: "p", [-9]: "n", [-6]: "µ", [-3]: "m",
    0: "", 3: "k", 6: "M", 9: "G", 12: "T",
  };
  const prefix = prefixes[exponent];
  return prefix === undefined
    ? `${value.toExponential(3)} ${unit}`.trim()
    : `${(value / 10 ** exponent).toPrecision(4)} ${prefix}${unit}`.trim();
}
