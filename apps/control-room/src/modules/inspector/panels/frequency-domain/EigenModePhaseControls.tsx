"use client";

import { Pause, Play, RotateCcw } from "lucide-react";

import { Button } from "@/shared/ui/Button";
import { Slider } from "@/shared/ui/Slider";

import { FieldRow } from "../../primitives/FieldRow";

const MIN_PHASE_DEGREES = 0;
const MAX_PHASE_DEGREES = 360;
const TWO_PI = 2 * Math.PI;
const MIN_VISUAL_CYCLE_RATE_HZ = 0.05;
const MAX_VISUAL_CYCLE_RATE_HZ = 10;

export interface EigenModePhaseControlsProps {
  animatePhase: boolean;
  animationRateHz: number;
  disabled: boolean;
  disabledReason?: string | null;
  phaseRad: number;
  onAnimationChange: (next: {
    animatePhase: boolean;
    animationRateHz: number;
  }) => void;
  onSetPhase: (phaseRad: number) => void;
}

export function eigenModePhaseDegreesToRadians(degrees: number): number {
  const boundedDegrees = Math.min(
    MAX_PHASE_DEGREES,
    Math.max(MIN_PHASE_DEGREES, Number.isFinite(degrees) ? degrees : 0),
  );
  return (boundedDegrees * Math.PI) / 180;
}

export function eigenModePhaseRadiansToDegrees(phaseRad: number): number {
  if (!Number.isFinite(phaseRad)) return 0;
  const remainderRad = phaseRad % TWO_PI;
  const wrappedRad = remainderRad < 0 ? remainderRad + TWO_PI : remainderRad;
  if (wrappedRad === 0 && phaseRad > 0) return MAX_PHASE_DEGREES;
  return (wrappedRad * 180) / Math.PI;
}

export function clampEigenModeVisualCycleRateHz(rateHz: number): number {
  return Math.min(
    MAX_VISUAL_CYCLE_RATE_HZ,
    Math.max(
      MIN_VISUAL_CYCLE_RATE_HZ,
      Number.isFinite(rateHz) ? rateHz : 1,
    ),
  );
}

function formatPhaseDegrees(phaseDegrees: number): string {
  return String(Number(phaseDegrees.toFixed(1)));
}

function formatRate(rateHz: number): string {
  return String(Number(clampEigenModeVisualCycleRateHz(rateHz).toFixed(2)));
}

export function EigenModePhaseControls({
  animatePhase,
  animationRateHz,
  disabled,
  disabledReason,
  phaseRad,
  onAnimationChange,
  onSetPhase,
}: EigenModePhaseControlsProps) {
  const phaseDegrees = eigenModePhaseRadiansToDegrees(phaseRad);
  const visualCycleRateHz = clampEigenModeVisualCycleRateHz(animationRateHz);

  return (
    <div
      aria-label="Eigen mode phase controls"
      className="fm-mode-phase-control"
      role="group"
    >
      <FieldRow
        label="Display phase"
        unit="deg"
        value={
          <div className="fm-mode-phase-control__value">
            <output aria-label="Current eigen mode display phase">
              {formatPhaseDegrees(phaseDegrees)}
            </output>
            <Slider
              aria-label="Eigen mode display phase in degrees"
              className="fm-mode-phase-control__slider"
              disabled={disabled}
              max={MAX_PHASE_DEGREES}
              min={MIN_PHASE_DEGREES}
              step={1}
              value={[phaseDegrees]}
              onValueChange={(value) => {
                const [nextDegrees] = value;
                if (nextDegrees !== undefined) {
                  onSetPhase(eigenModePhaseDegreesToRadians(nextDegrees));
                }
              }}
            />
          </div>
        }
      />
      <FieldRow
        label="Visual cycle rate"
        unit="Hz"
        value={
          <div className="fm-mode-phase-control__value">
            <output aria-label="Visual phase cycle rate">
              {formatRate(visualCycleRateHz)}
            </output>
            <Slider
              aria-label="Visual phase cycle rate in Hz"
              className="fm-mode-phase-control__slider"
              disabled={disabled}
              max={MAX_VISUAL_CYCLE_RATE_HZ}
              min={MIN_VISUAL_CYCLE_RATE_HZ}
              step={0.05}
              value={[visualCycleRateHz]}
              onValueChange={(value) => {
                const [nextRateHz] = value;
                if (nextRateHz !== undefined) {
                  onAnimationChange({
                    animatePhase,
                    animationRateHz:
                      clampEigenModeVisualCycleRateHz(nextRateHz),
                  });
                }
              }}
            />
          </div>
        }
      />
      <small className="fm-mode-visualization__presentation-note">
        Visual playback speed only; the scientific eigenfrequency above is
        unchanged.
      </small>
      <div
        aria-label="Eigen mode phase animation"
        className="fm-mode-phase-control__transport"
        role="group"
      >
        <Button
          aria-label={
            animatePhase
              ? "Pause eigen mode phase animation"
              : "Play eigen mode phase animation"
          }
          aria-pressed={animatePhase}
          disabled={disabled}
          size="sm"
          type="button"
          variant={animatePhase ? "primary" : "secondary"}
          onClick={() =>
            onAnimationChange({
              animatePhase: !animatePhase,
              animationRateHz: visualCycleRateHz,
            })
          }
        >
          {animatePhase ? (
            <Pause aria-hidden="true" size={13} />
          ) : (
            <Play aria-hidden="true" size={13} />
          )}
          <span>{animatePhase ? "Pause" : "Play"}</span>
        </Button>
        <Button
          aria-label="Reset eigen mode display phase to zero degrees"
          disabled={disabled}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => onSetPhase(0)}
        >
          <RotateCcw aria-hidden="true" size={13} />
          <span>Reset phase</span>
        </Button>
      </div>
      {disabledReason ? (
        <small
          className="fm-mode-visualization__presentation-note"
          role="status"
        >
          {disabledReason}
        </small>
      ) : null}
    </div>
  );
}
