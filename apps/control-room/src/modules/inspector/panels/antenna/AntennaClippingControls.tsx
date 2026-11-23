"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";

import type { VisualizationStatePatch } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import type { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import {
  RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
  visualizationStateCommandInput,
} from "@/modules/ribbon/public";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Slider } from "@/shared/ui/Slider";
import { Switch } from "@/shared/ui/Switch";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorPropertyRow } from "../../primitives/InspectorPropertyRow";

type ClipPatch = NonNullable<VisualizationStatePatch["clip"]>;

/**
 * Radix-compliant global workspace section clipping control for Antenna visualization.
 * Preserves exact `RIBBON_VISUALIZATION_PATCH_STATE_COMMAND` and `visualizationSync` wiring.
 */
export function AntennaClippingControls({
  resource,
  ownerKey,
}: {
  resource: ReturnType<typeof useVisualizationStateResource>;
  ownerKey: string;
}): ReactNode {
  const kernel = useKernel();
  const version = useSyncExternalStore(
    (listener) => kernel.commands.subscribe(listener),
    () => kernel.commands.getVersion(),
    () => -1,
  );
  const [draft, setDraft] = useState<{ owner: string; value: number } | null>(
    null,
  );
  const [error, setError] = useState<{ owner: string; message: string } | null>(
    null,
  );
  const clip = (resource.optimisticData ?? resource.data)?.clip;
  const context = createCommandContext("inspector", kernel, {
    sourceDetail: "viewport-global-section",
  });
  const available =
    Boolean(clip) &&
    version >= 0 &&
    kernel.commands.isEnabled(
      RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
      context,
    );
  const sync = kernel.visualizationSync.getSnapshot();
  const pending = Boolean(sync.pendingPatch?.clip || sync.inflightPatch?.clip);
  const position =
    draft?.owner === ownerKey ? draft.value : (clip?.position_percent ?? 50);

  const apply = async (patch: ClipPatch) => {
    const result = await kernel.commands.execute(
      RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
      createCommandContext("inspector", kernel, {
        sourceDetail: "viewport-global-section",
      }),
      visualizationStateCommandInput({ clip: patch }),
    );
    setError(
      result.status === "failed"
        ? { owner: ownerKey, message: result.message ?? "Section command failed." }
        : null,
    );
  };

  return (
    <div className="fm-viewport-clipping fm-inspector-stack">
      <p className="fm-inspector-hint">
        Global workspace section. Position is relative to workspace bounds and clips
        geometry and displayed fields without recomputing samples.
      </p>
      <InspectorPropertyRow label="Section enabled">
        <Switch
          aria-label="Section enabled"
          checked={clip?.enabled ?? false}
          disabled={!available}
          onCheckedChange={(enabled) => {
            void apply({ enabled });
          }}
        />
      </InspectorPropertyRow>
      <InspectorPropertyRow label="Section axis">
        <Select
          disabled={!available}
          value={clip?.axis ?? "z"}
          onValueChange={(axis) => {
            void apply({ axis: axis as "x" | "y" | "z", enabled: true });
          }}
        >
          <SelectTrigger aria-label="Section axis">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="fm-inspector-select-content">
            <SelectItem value="x">X normal · YZ plane</SelectItem>
            <SelectItem value="y">Y normal · XZ plane</SelectItem>
            <SelectItem value="z">Z normal · XY plane</SelectItem>
          </SelectContent>
        </Select>
      </InspectorPropertyRow>
      <FieldRow label="Section position" unit="%" value={position.toFixed(1)} />
      <Slider
        aria-label="Section position"
        disabled={!available}
        max={100}
        min={0}
        step={0.5}
        value={[position]}
        valueText={(v) => `${v.toFixed(1)}%`}
        onValueChange={([value]) => {
          if (value !== undefined && Number.isFinite(value)) {
            setDraft({ owner: ownerKey, value });
          }
        }}
        onValueCommit={([value]) => {
          if (
            value !== undefined &&
            Number.isFinite(value) &&
            value >= 0 &&
            value <= 100
          ) {
            void apply({ enabled: true, position_percent: value });
          }
          setDraft(null);
        }}
      />
      <InspectorPropertyRow label="Flip section side">
        <Switch
          aria-label="Flip section side"
          checked={clip?.flipped ?? false}
          disabled={!available}
          onCheckedChange={(flipped) => {
            void apply({ enabled: true, flipped });
          }}
        />
      </InspectorPropertyRow>
      <p className="fm-inspector-hint" role="status">
        {!available
          ? "Shared section state is not active yet."
          : pending
            ? "Saving global section…"
            : "Shared with the viewport and ribbon."}
      </p>
      {error?.owner === ownerKey ? <p role="alert">{error.message}</p> : null}
      {sync.error ? (
        <p role="alert">Global visualization sync: {sync.error.message}</p>
      ) : null}
      {resource.error || resource.refreshError ? (
        <p role="alert">
          Section state: {(resource.error ?? resource.refreshError)?.message}
        </p>
      ) : null}
    </div>
  );
}
