"use client";

import { Info } from "lucide-react";
import { useId, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/Popover";
import { Switch } from "@/shared/ui/Switch";

import { TELEMETRY_EXPLANATION, updateNoticeText, type PreferencesState, type UpdateNotice } from "../model/startPreferences";
import { telemetryLabel } from "./TelemetrySwitch.model";

export interface TelemetrySwitchProps {
  readonly state: PreferencesState;
  readonly saving: boolean;
  /** Saves the choice; resolves to a failure message, or null. */
  readonly onChange: (enabled: boolean) => Promise<string | null>;
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
  const [failure, setFailure] = useState<string | null>(null);
  const ready = state.kind === "ready";
  const checked = ready && state.telemetryEnabled;

  const toggle = async () => {
    if (!ready) return;
    setFailure(await onChange(!checked));
  };

  return (
    <span className="fm-start-status__item fm-start-telemetry">
      <Switch
        aria-describedby={textId}
        aria-label="Telemetry"
        checked={checked}
        className="fm-start-switch"
        data-checked={checked}
        disabled={!ready || saving}
        onCheckedChange={() => void toggle()}
      />
      <span id={textId}>{telemetryLabel(state)}</span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            aria-label="About telemetry"
            className="fm-start-status__info"
            type="button"
          >
            <Info aria-hidden="true" size={12} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="fm-start-popover" role="note" side="top">
          {TELEMETRY_EXPLANATION}
        </PopoverContent>
      </Popover>
      <span aria-live="polite" className="fm-start-visually-hidden" role="status">
        {failure ?? ""}
      </span>
      {failure ? <span className="fm-start-telemetry__failure">{failure}</span> : null}
    </span>
  );
}
