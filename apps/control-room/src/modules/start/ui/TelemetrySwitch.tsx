"use client";

import { Info } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
  TELEMETRY_EXPLANATION,
  TELEMETRY_UNAVAILABLE_TEXT,
  telemetryStatusText,
  updateNoticeText,
  type PreferencesState,
  type UpdateNotice,
} from "../model/startPreferences";

export interface TelemetrySwitchProps {
  readonly state: PreferencesState;
  readonly saving: boolean;
  /** Saves the choice; resolves to a failure message, or null. */
  readonly onChange: (enabled: boolean) => Promise<string | null>;
}

/** The text beside the switch, from the stored choice only. */
export function telemetryLabel(state: PreferencesState): string {
  if (state.kind === "ready") return telemetryStatusText(state.telemetryEnabled);
  if (state.kind === "unavailable") return `${TELEMETRY_UNAVAILABLE_TEXT} — ${state.reason}`;
  return "Reading the telemetry setting…";
}

/** Shown only when an updater stored `update.available`; absent otherwise. */
export function UpdateNoticeItem({ notice }: { readonly notice: UpdateNotice | undefined }) {
  if (!notice) return null;
  return (
    <span className="fm-start-status__item fm-start-status__update" data-status="update-available">
      {updateNoticeText(notice)}
    </span>
  );
}

export function TelemetrySwitch({ state, saving, onChange }: TelemetrySwitchProps) {
  const textId = useId();
  const popoverId = useId();
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const ready = state.kind === "ready";
  const checked = ready && state.telemetryEnabled;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: MouseEvent) => {
      if (root.current && event.target instanceof Node && !root.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  const toggle = async () => {
    if (!ready) return;
    setFailure(await onChange(!checked));
  };

  return (
    <span className="fm-start-status__item fm-start-telemetry" ref={root}>
      <button
        aria-checked={checked}
        aria-describedby={textId}
        aria-label="Telemetry"
        className="fm-start-switch"
        data-checked={checked}
        disabled={!ready || saving}
        onClick={() => void toggle()}
        role="switch"
        type="button"
      >
        <span aria-hidden="true" className="fm-start-switch__thumb" />
      </button>
      <span id={textId}>{telemetryLabel(state)}</span>
      <button
        aria-controls={popoverId}
        aria-expanded={open}
        aria-label="About telemetry"
        className="fm-start-status__info"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Info aria-hidden="true" size={12} />
      </button>
      {open ? (
        <div className="fm-start-popover" id={popoverId} role="note">
          {TELEMETRY_EXPLANATION}
        </div>
      ) : null}
      <span aria-live="polite" className="fm-start-visually-hidden" role="status">
        {failure ?? ""}
      </span>
      {failure ? <span className="fm-start-telemetry__failure">{failure}</span> : null}
    </span>
  );
}
