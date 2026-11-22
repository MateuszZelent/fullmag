"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

import type {
  SceneOerstedTimeDependence,
  SceneTimeEnvelope,
} from "./transportShared";

const NONE_ENVELOPE_MODE = "__fm_envelope_none__";

function EnvelopeScalarInput({
  ariaLabel,
  value,
  unit,
  disabled,
  placeholder,
  optional = false,
  onCommit,
}: {
  ariaLabel: string;
  value: number | null | undefined;
  unit?: string;
  disabled?: boolean;
  placeholder?: string;
  optional?: boolean;
  onCommit: (next: number | undefined) => void;
}) {
  const formatted =
    typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  const [rawText, setRawText] = useState(formatted);
  const latestTextRef = useRef(formatted);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      latestTextRef.current = formatted;
      setRawText(formatted);
    }
  }, [formatted]);

  return (
    <div className="flex items-center gap-1.5">
      <Input
        aria-label={ariaLabel}
        className="font-mono"
        disabled={disabled}
        placeholder={placeholder}
        type="text"
        value={rawText}
        onBlur={() => {
          focusedRef.current = false;
          const trimmed = latestTextRef.current.trim();
          if (!trimmed && optional) {
            onCommit(undefined);
            latestTextRef.current = "";
            setRawText("");
            return;
          }
          const parsed = Number(trimmed);
          if (trimmed && Number.isFinite(parsed)) {
            onCommit(parsed);
            latestTextRef.current = String(parsed);
            setRawText(String(parsed));
          } else {
            latestTextRef.current = formatted;
            setRawText(formatted);
          }
        }}
        onChange={(e) => {
          const next = e.target.value;
          latestTextRef.current = next;
          setRawText(next);
          const trimmed = next.trim();
          if (!trimmed && optional) {
            onCommit(undefined);
            return;
          }
          const parsed = Number(trimmed);
          if (trimmed && Number.isFinite(parsed)) {
            onCommit(parsed);
          }
        }}
        onFocus={() => {
          focusedRef.current = true;
        }}
      />
      {unit ? <Badge variant="secondary">{unit}</Badge> : null}
    </div>
  );
}

function parseEnvelopeJson(valueJson: string): SceneTimeEnvelope | null {
  const trimmed = valueJson.trim();
  if (!trimmed || trimmed === "{}") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "kind" in parsed) {
      return parsed as SceneTimeEnvelope;
    }
  } catch {
    // Keep null fallback for fresh selection.
  }
  return null;
}

function defaultSceneTimeEnvelope(kind: SceneTimeEnvelope["kind"]): SceneTimeEnvelope {
  switch (kind) {
    case "constant":
      return { kind: "constant", value: 1 };
    case "sinusoidal":
      return {
        kind: "sinusoidal",
        amplitude: 1,
        frequency_hz: 1e9,
        phase_rad: 0,
        offset: 0,
      };
    case "pulse":
      return {
        kind: "pulse",
        amplitude: 1,
        t_on_s: 0,
        t_off_s: 1e-9,
      };
    case "piecewise_linear":
      return {
        kind: "piecewise_linear",
        points: [
          { time_s: 0, value: 0 },
          { time_s: 1e-9, value: 1 },
        ],
      };
    case "sinc":
      return {
        kind: "sinc",
        amplitude: 1,
        center_s: 5e-10,
        bandwidth_hz: 10e9,
        offset: 0,
      };
    case "tabulated":
      return {
        kind: "tabulated",
        artifact_ref: "waveform-1",
        interpolation: "linear",
        extrapolation: "zero",
      };
  }
}

export function SceneTimeEnvelopeEditor({
  label = "Time envelope",
  valueJson,
  disabled = false,
  onChangeJson,
}: {
  label?: string;
  valueJson: string;
  disabled?: boolean;
  onChangeJson: (nextJson: string) => void;
}) {
  const parsed = parseEnvelopeJson(valueJson);
  const modeValue = parsed?.kind ?? NONE_ENVELOPE_MODE;

  const commitEnvelope = (next: SceneTimeEnvelope | null) => {
    onChangeJson(next ? JSON.stringify(next, null, 2) : "{}");
  };

  return (
    <div className="flex flex-col gap-2.5" data-slot="scene-time-envelope-editor">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-[var(--fm-text-muted)]">{label} kind</span>
        <Select
          disabled={disabled}
          value={modeValue}
          onValueChange={(nextKind) => {
            if (nextKind === NONE_ENVELOPE_MODE) {
              commitEnvelope(null);
            } else {
              commitEnvelope(defaultSceneTimeEnvelope(nextKind as SceneTimeEnvelope["kind"]));
            }
          }}
        >
          <SelectTrigger aria-label={`${label} kind`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" position="popper">
            <SelectGroup>
              <SelectItem value={NONE_ENVELOPE_MODE}>
                Steady DC (no time_envelope)
              </SelectItem>
              <SelectItem value="constant">Constant scale factor</SelectItem>
              <SelectItem value="sinusoidal">Sinusoidal AC harmonic</SelectItem>
              <SelectItem value="pulse">Rectangular gate pulse</SelectItem>
              <SelectItem value="piecewise_linear">Piecewise-linear table</SelectItem>
              <SelectItem value="sinc">Band-limited sinc pulse</SelectItem>
              <SelectItem value="tabulated">Tabulated waveform artifact</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {parsed?.kind === "constant" ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-[var(--fm-text-muted)]">Constant multiplier</span>
          <EnvelopeScalarInput
            ariaLabel={`${label} constant value`}
            disabled={disabled}
            value={parsed.value}
            onCommit={(v) => v !== undefined && commitEnvelope({ ...parsed, value: v })}
          />
        </div>
      ) : null}

      {parsed?.kind === "sinusoidal" ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Amplitude</span>
            <EnvelopeScalarInput
              ariaLabel={`${label} amplitude`}
              disabled={disabled}
              value={parsed.amplitude}
              onCommit={(v) =>
                v !== undefined && commitEnvelope({ ...parsed, amplitude: v })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Frequency</span>
            <EnvelopeScalarInput
              ariaLabel={`${label} frequency_hz`}
              disabled={disabled}
              unit="Hz"
              value={parsed.frequency_hz}
              onCommit={(v) =>
                v !== undefined && commitEnvelope({ ...parsed, frequency_hz: v })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Phase</span>
            <EnvelopeScalarInput
              ariaLabel={`${label} phase_rad`}
              disabled={disabled}
              unit="rad"
              value={parsed.phase_rad}
              onCommit={(v) =>
                v !== undefined && commitEnvelope({ ...parsed, phase_rad: v })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Offset</span>
            <EnvelopeScalarInput
              ariaLabel={`${label} offset`}
              disabled={disabled}
              value={parsed.offset}
              onCommit={(v) =>
                v !== undefined && commitEnvelope({ ...parsed, offset: v })
              }
            />
          </div>
        </div>
      ) : null}

      {parsed?.kind === "pulse" ? (
        <div className="grid grid-cols-1 gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Pulse amplitude</span>
            <EnvelopeScalarInput
              ariaLabel={`${label} pulse amplitude`}
              disabled={disabled}
              value={parsed.amplitude}
              onCommit={(v) =>
                v !== undefined && commitEnvelope({ ...parsed, amplitude: v })
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-[var(--fm-text-muted)]">Turn-on t_on_s</span>
              <EnvelopeScalarInput
                ariaLabel={`${label} t_on_s`}
                disabled={disabled}
                unit="s"
                value={parsed.t_on_s}
                onCommit={(v) =>
                  v !== undefined && commitEnvelope({ ...parsed, t_on_s: v })
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-[var(--fm-text-muted)]">Turn-off t_off_s</span>
              <EnvelopeScalarInput
                ariaLabel={`${label} t_off_s`}
                disabled={disabled}
                unit="s"
                value={parsed.t_off_s}
                onCommit={(v) =>
                  v !== undefined && commitEnvelope({ ...parsed, t_off_s: v })
                }
              />
            </div>
          </div>
        </div>
      ) : null}

      {parsed?.kind === "piecewise_linear" ? (
        <div className="flex flex-col gap-2">
          {parsed.points.map((pt, idx) => (
            <div
              key={`pwl-${idx}`}
              className="flex items-center gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2"
            >
              <div className="flex flex-1 flex-col gap-1">
                <span className="text-xs text-[var(--fm-text-muted)]">t (s)</span>
                <EnvelopeScalarInput
                  ariaLabel={`${label} point ${idx + 1} time_s`}
                  disabled={disabled}
                  value={pt.time_s}
                  onCommit={(v) => {
                    if (v === undefined) return;
                    const nextPts = parsed.points.map((item, j) =>
                      j === idx ? { ...item, time_s: v } : item,
                    );
                    commitEnvelope({ ...parsed, points: nextPts });
                  }}
                />
              </div>
              <div className="flex flex-1 flex-col gap-1">
                <span className="text-xs text-[var(--fm-text-muted)]">Value</span>
                <EnvelopeScalarInput
                  ariaLabel={`${label} point ${idx + 1} value`}
                  disabled={disabled}
                  value={pt.value}
                  onCommit={(v) => {
                    if (v === undefined) return;
                    const nextPts = parsed.points.map((item, j) =>
                      j === idx ? { ...item, value: v } : item,
                    );
                    commitEnvelope({ ...parsed, points: nextPts });
                  }}
                />
              </div>
              {parsed.points.length > 2 ? (
                <Button
                  aria-label={`Remove ${label} point ${idx + 1}`}
                  disabled={disabled}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    commitEnvelope({
                      ...parsed,
                      points: parsed.points.filter((_, j) => j !== idx),
                    })
                  }
                >
                  <Trash2 aria-hidden="true" size={12} />
                </Button>
              ) : null}
            </div>
          ))}
          <Button
            disabled={disabled}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              const lastTime =
                parsed.points[parsed.points.length - 1]?.time_s ?? 0;
              commitEnvelope({
                ...parsed,
                points: [...parsed.points, { time_s: lastTime + 1e-9, value: 0 }],
              });
            }}
          >
            <Plus aria-hidden="true" size={12} />
            <span>Add envelope point</span>
          </Button>
        </div>
      ) : null}

      {parsed?.kind === "sinc" ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Amplitude</span>
            <EnvelopeScalarInput
              ariaLabel={`${label} sinc amplitude`}
              disabled={disabled}
              value={parsed.amplitude}
              onCommit={(v) =>
                v !== undefined && commitEnvelope({ ...parsed, amplitude: v })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Center center_s</span>
            <EnvelopeScalarInput
              ariaLabel={`${label} center_s`}
              disabled={disabled}
              unit="s"
              value={parsed.center_s}
              onCommit={(v) =>
                v !== undefined && commitEnvelope({ ...parsed, center_s: v })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Bandwidth</span>
            <EnvelopeScalarInput
              ariaLabel={`${label} bandwidth_hz`}
              disabled={disabled}
              unit="Hz"
              value={parsed.bandwidth_hz}
              onCommit={(v) =>
                v !== undefined && commitEnvelope({ ...parsed, bandwidth_hz: v })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Offset</span>
            <EnvelopeScalarInput
              ariaLabel={`${label} sinc offset`}
              disabled={disabled}
              value={parsed.offset}
              onCommit={(v) =>
                v !== undefined && commitEnvelope({ ...parsed, offset: v })
              }
            />
          </div>
        </div>
      ) : null}

      {parsed?.kind === "tabulated" ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Artifact reference</span>
            <Input
              aria-label={`${label} artifact_ref`}
              className="font-mono"
              disabled={disabled}
              placeholder="e.g. waveform-artifact-1"
              type="text"
              value={parsed.artifact_ref}
              onChange={(e) =>
                commitEnvelope({ ...parsed, artifact_ref: e.target.value })
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-[var(--fm-text-muted)]">Interpolation</span>
              <Select
                disabled={disabled}
                value={parsed.interpolation}
                onValueChange={(nextVal) =>
                  commitEnvelope({
                    ...parsed,
                    interpolation: nextVal as "linear" | "previous",
                  })
                }
              >
                <SelectTrigger aria-label={`${label} interpolation`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start" position="popper">
                  <SelectGroup>
                    <SelectItem value="linear">Linear</SelectItem>
                    <SelectItem value="previous">Previous (zero-order hold)</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-[var(--fm-text-muted)]">Extrapolation</span>
              <Select
                disabled={disabled}
                value={parsed.extrapolation}
                onValueChange={(nextVal) =>
                  commitEnvelope({
                    ...parsed,
                    extrapolation: nextVal as "zero" | "hold" | "error",
                  })
                }
              >
                <SelectTrigger aria-label={`${label} extrapolation`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start" position="popper">
                  <SelectGroup>
                    <SelectItem value="zero">Zero outside domain</SelectItem>
                    <SelectItem value="hold">Hold endpoint</SelectItem>
                    <SelectItem value="error">Fail outside domain</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">
              Optional bandwidth_hz (Hz)
            </span>
            <EnvelopeScalarInput
              optional
              ariaLabel={`${label} tabulated bandwidth_hz`}
              disabled={disabled}
              placeholder="Optional bandwidth"
              unit="Hz"
              value={parsed.bandwidth_hz ?? undefined}
              onCommit={(v) => {
                const next: SceneTimeEnvelope = {
                  kind: "tabulated",
                  artifact_ref: parsed.artifact_ref,
                  interpolation: parsed.interpolation,
                  extrapolation: parsed.extrapolation,
                  ...(v !== undefined ? { bandwidth_hz: v } : {}),
                };
                commitEnvelope(next);
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── Oersted Cylinder `SceneOerstedTimeDependence` Structured Editor ── */

function parseOerstedTimeJson(valueJson: string): SceneOerstedTimeDependence | null {
  const trimmed = valueJson.trim();
  if (!trimmed || trimmed === "{}") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "kind" in parsed) {
      return parsed as SceneOerstedTimeDependence;
    }
  } catch {
    // Keep null fallback.
  }
  return null;
}

function defaultOerstedTimeDependence(
  kind: SceneOerstedTimeDependence["kind"],
): SceneOerstedTimeDependence {
  switch (kind) {
    case "constant":
      return { kind: "constant" };
    case "sinusoidal":
      return {
        kind: "sinusoidal",
        frequency_hz: 1e9,
        phase_rad: 0,
        offset: 0,
      };
    case "pulse":
      return {
        kind: "pulse",
        t_on: 0,
        t_off: 1e-9,
      };
    case "piecewise_linear":
      return {
        kind: "piecewise_linear",
        points: [
          [0, 0],
          [1e-9, 1],
        ],
      };
    case "sinc_pulse":
      return {
        kind: "sinc_pulse",
        cutoff_hz: 10e9,
        t0: 5e-10,
        amplitude: 1,
      };
  }
}

export function OerstedTimeDependenceEditor({
  valueJson,
  disabled = false,
  onChangeJson,
}: {
  valueJson: string;
  disabled?: boolean;
  onChangeJson: (nextJson: string) => void;
}) {
  const parsed = parseOerstedTimeJson(valueJson);
  const modeValue = parsed?.kind ?? NONE_ENVELOPE_MODE;

  const commitDependence = (next: SceneOerstedTimeDependence | null) => {
    onChangeJson(next ? JSON.stringify(next, null, 2) : "");
  };

  return (
    <div className="flex flex-col gap-2.5" data-slot="oersted-time-dependence-editor">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-[var(--fm-text-muted)]">
          Time dependence (time_dependence)
        </span>
        <Select
          disabled={disabled}
          value={modeValue}
          onValueChange={(nextKind) => {
            if (nextKind === NONE_ENVELOPE_MODE) {
              commitDependence(null);
            } else {
              commitDependence(
                defaultOerstedTimeDependence(
                  nextKind as SceneOerstedTimeDependence["kind"],
                ),
              );
            }
          }}
        >
          <SelectTrigger aria-label="Oersted time dependence kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" position="popper">
            <SelectGroup>
              <SelectItem value={NONE_ENVELOPE_MODE}>
                Steady DC (omit time_dependence)
              </SelectItem>
              <SelectItem value="constant">Explicit constant</SelectItem>
              <SelectItem value="sinusoidal">Sinusoidal AC harmonic</SelectItem>
              <SelectItem value="pulse">Gate pulse (t_on / t_off)</SelectItem>
              <SelectItem value="piecewise_linear">Piecewise-linear table</SelectItem>
              <SelectItem value="sinc_pulse">Sinc pulse (cutoff_hz / t0)</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {parsed?.kind === "sinusoidal" ? (
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Frequency</span>
            <EnvelopeScalarInput
              ariaLabel="Oersted frequency_hz"
              disabled={disabled}
              unit="Hz"
              value={parsed.frequency_hz}
              onCommit={(v) =>
                v !== undefined && commitDependence({ ...parsed, frequency_hz: v })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Phase</span>
            <EnvelopeScalarInput
              ariaLabel="Oersted phase_rad"
              disabled={disabled}
              unit="rad"
              value={parsed.phase_rad}
              onCommit={(v) =>
                v !== undefined && commitDependence({ ...parsed, phase_rad: v })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Offset</span>
            <EnvelopeScalarInput
              ariaLabel="Oersted offset"
              disabled={disabled}
              value={parsed.offset}
              onCommit={(v) =>
                v !== undefined && commitDependence({ ...parsed, offset: v })
              }
            />
          </div>
        </div>
      ) : null}

      {parsed?.kind === "pulse" ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Turn-on t_on</span>
            <EnvelopeScalarInput
              ariaLabel="Oersted pulse t_on"
              disabled={disabled}
              unit="s"
              value={parsed.t_on}
              onCommit={(v) =>
                v !== undefined && commitDependence({ ...parsed, t_on: v })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Turn-off t_off</span>
            <EnvelopeScalarInput
              ariaLabel="Oersted pulse t_off"
              disabled={disabled}
              unit="s"
              value={parsed.t_off}
              onCommit={(v) =>
                v !== undefined && commitDependence({ ...parsed, t_off: v })
              }
            />
          </div>
        </div>
      ) : null}

      {parsed?.kind === "piecewise_linear" ? (
        <div className="flex flex-col gap-2">
          {parsed.points.map((pair, idx) => (
            <div
              key={`oe-pwl-${idx}`}
              className="flex items-center gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2"
            >
              <div className="flex flex-1 flex-col gap-1">
                <span className="text-xs text-[var(--fm-text-muted)]">Time (s)</span>
                <EnvelopeScalarInput
                  ariaLabel={`Oersted point ${idx + 1} time`}
                  disabled={disabled}
                  value={pair[0]}
                  onCommit={(v) => {
                    if (v === undefined) return;
                    const nextPts = parsed.points.map((p, j) =>
                      j === idx ? [v, p[1] ?? 0] : p,
                    );
                    commitDependence({ ...parsed, points: nextPts });
                  }}
                />
              </div>
              <div className="flex flex-1 flex-col gap-1">
                <span className="text-xs text-[var(--fm-text-muted)]">Scale</span>
                <EnvelopeScalarInput
                  ariaLabel={`Oersted point ${idx + 1} scale`}
                  disabled={disabled}
                  value={pair[1]}
                  onCommit={(v) => {
                    if (v === undefined) return;
                    const nextPts = parsed.points.map((p, j) =>
                      j === idx ? [p[0] ?? 0, v] : p,
                    );
                    commitDependence({ ...parsed, points: nextPts });
                  }}
                />
              </div>
              {parsed.points.length > 2 ? (
                <Button
                  aria-label={`Remove Oersted point ${idx + 1}`}
                  disabled={disabled}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    commitDependence({
                      ...parsed,
                      points: parsed.points.filter((_, j) => j !== idx),
                    })
                  }
                >
                  <Trash2 aria-hidden="true" size={12} />
                </Button>
              ) : null}
            </div>
          ))}
          <Button
            disabled={disabled}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              const lastT = parsed.points[parsed.points.length - 1]?.[0] ?? 0;
              commitDependence({
                ...parsed,
                points: [...parsed.points, [lastT + 1e-9, 0]],
              });
            }}
          >
            <Plus aria-hidden="true" size={12} />
            <span>Add waveform point</span>
          </Button>
        </div>
      ) : null}

      {parsed?.kind === "sinc_pulse" ? (
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Cutoff</span>
            <EnvelopeScalarInput
              ariaLabel="Oersted cutoff_hz"
              disabled={disabled}
              unit="Hz"
              value={parsed.cutoff_hz}
              onCommit={(v) =>
                v !== undefined && commitDependence({ ...parsed, cutoff_hz: v })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Center t0</span>
            <EnvelopeScalarInput
              ariaLabel="Oersted t0"
              disabled={disabled}
              unit="s"
              value={parsed.t0}
              onCommit={(v) =>
                v !== undefined && commitDependence({ ...parsed, t0: v })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--fm-text-muted)]">Amplitude</span>
            <EnvelopeScalarInput
              ariaLabel="Oersted amplitude"
              disabled={disabled}
              value={parsed.amplitude}
              onCommit={(v) =>
                v !== undefined && commitDependence({ ...parsed, amplitude: v })
              }
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
