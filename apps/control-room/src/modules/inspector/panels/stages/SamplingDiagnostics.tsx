import { resolveHalfOpenSamplingClock } from "@/shared/domain/physics/sincPulsePreview";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import type {
  EffectiveStudyAutosaveOutput,
  EffectiveStudyTableAutosave,
} from "./studyWorkflowState";
import { formatEngineering } from "./samplingPresentation";

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
  const automatic = sampling?.samplingMode === "auto_sinc_cutoff";
  const isUnresolved = automatic && auto?.status === "unresolved";
  const stateClass = isUnresolved
    ? "warning"
    : automatic && auto?.status === "ready"
      ? "ready"
      : "manual";

  return (
    <section
      className={`fm-sampling-plan fm-sampling-plan--${stateClass}`}
      aria-label="Sampling plan"
    >
      <header className="fm-sampling-plan__header">
        <div>
          <p>Sampling plan</p>
          <h4>{automatic ? "Automatic from sinc cutoff" : "Explicit sampling cadence"}</h4>
        </div>
        <span className="fm-sampling-plan__status">
          {isUnresolved ? "needs source" : automatic ? "resolved" : sampling ? "manual" : "missing"}
        </span>
      </header>

      <div className="fm-sampling-plan__groups">
        <PlanGroup title="Source">
          <Metric
            label="Mode"
            value={automatic ? "automatic sinc cutoff" : sampling ? "explicit period" : "not configured"}
          />
          <Metric
            label="Source stage"
            value={sampling?.sourceStageId ?? "not available"}
          />
          {automatic ? (
            <Metric
              label="Source drives"
              value={sampling?.sourceDriveIds.join(", ") || "none applicable"}
            />
          ) : null}
        </PlanGroup>

        <PlanGroup title="Clock">
          <Metric
            label="t_sampling"
            value={periodS ? formatEngineering(periodS, "s") : "not available"}
          />
          <Metric
            label="Sampling frequency"
            value={auto?.status === "ready" ? formatEngineering(auto.samplingFrequencyHz, "Hz") : "not available"}
          />
          <Metric label="Duration" value={durationS ? formatEngineering(durationS, "s") : "not available"} />
          <Metric label="N" value={clock ? String(clock.sampleCount) : "not available"} />
        </PlanGroup>

        <PlanGroup title="FFT limits">
          <Metric
            label="Maximum sinc cutoff"
            value={auto?.status === "ready" ? formatEngineering(auto.maximumCutoffHz, "Hz") : "not applicable"}
          />
          <Metric
            label="Target Nyquist"
            value={auto?.status === "ready" ? formatEngineering(auto.targetNyquistHz, "Hz") : "not applicable"}
          />
          <Metric
            label="Nyquist guard"
            value={auto?.status === "ready" ? "1.3 × cutoff (+30%)" : "not applicable"}
          />
          <Metric
            label="Highest represented FFT bin"
            value={
              clock
                ? formatEngineering(
                    Math.floor(clock.sampleCount / 2) * clock.frequencyResolutionHz,
                    "Hz",
                  )
                : "not available"
            }
          />
          <Metric label="Nyquist limit" value={clock ? formatEngineering(clock.nyquistHz, "Hz") : "not available"} />
          <Metric label="df" value={clock ? formatEngineering(clock.frequencyResolutionHz, "Hz") : "not available"} />
        </PlanGroup>
      </div>

      {isUnresolved ? (
        <FeedbackBanner
          kind="warning"
          message={`Automatic sampling is unresolved. ${auto.reason}`}
        />
      ) : null}
    </section>
  );
}

function PlanGroup({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="fm-sampling-plan__group">
      <h5>{title}</h5>
      <div className="fm-sampling-plan__metrics" role="list" aria-label={`${title} sampling parameters`}>
        {children}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <span role="listitem"><small>{label}</small><strong>{value}</strong></span>;
}
