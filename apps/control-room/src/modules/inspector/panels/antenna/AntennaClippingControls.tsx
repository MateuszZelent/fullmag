"use client";

import { useState, useSyncExternalStore } from "react";
import type { VisualizationStatePatch } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import type { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { RIBBON_VISUALIZATION_PATCH_STATE_COMMAND, visualizationStateCommandInput } from "@/modules/ribbon/public";
import { Slider } from "@/shared/ui/Slider";
import { Switch } from "@/shared/ui/Switch";
import { FieldRow } from "../../primitives/FieldRow";
import { FormField } from "../../primitives/FormField";

type ClipPatch = NonNullable<VisualizationStatePatch["clip"]>;

/** The panel owns one global resource subscription; this child owns only a slider gesture. */
export function AntennaClippingControls({ resource, ownerKey }: {
  resource: ReturnType<typeof useVisualizationStateResource>;
  ownerKey: string;
}) {
  const kernel = useKernel();
  const version = useSyncExternalStore(
    (listener) => kernel.commands.subscribe(listener),
    () => kernel.commands.getVersion(),
    () => -1,
  );
  const [draft, setDraft] = useState<{ owner: string; value: number } | null>(null);
  const [error, setError] = useState<{ owner: string; message: string } | null>(null);
  const clip = resource.optimisticData?.clip;
  const context = createCommandContext("inspector", kernel, { sourceDetail: "antenna-global-section" });
  const available = Boolean(clip) && version >= 0 && kernel.commands.isEnabled(RIBBON_VISUALIZATION_PATCH_STATE_COMMAND, context);
  const sync = kernel.visualizationSync.getSnapshot();
  const pending = Boolean(sync.pendingPatch?.clip || sync.inflightPatch?.clip);
  const position = draft?.owner === ownerKey ? draft.value : clip?.position_percent ?? 50;
  const apply = async (patch: ClipPatch) => {
    const result = await kernel.commands.execute(RIBBON_VISUALIZATION_PATCH_STATE_COMMAND,
      createCommandContext("inspector", kernel, { sourceDetail: "antenna-global-section" }), visualizationStateCommandInput({ clip: patch }));
    setError(result.status === "failed" ? { owner: ownerKey, message: result.message ?? "Section command failed." } : null);
  };
  return <div className="fm-antenna-clipping">
    <p className="fm-inspector-field__hint">Global workspace section. Position is relative to workspace bounds. It clips geometry and displayed fields without changing samples or running a new solve.</p>
    <FieldRow label="Section enabled" value={<Switch aria-label="Section enabled" checked={clip?.enabled ?? false} disabled={!available} onCheckedChange={(enabled) => { void apply({ enabled }); }} />} />
    <FormField label="Section axis" type="select" value={clip?.axis ?? "z"} disabled={!available}
      onChange={(event) => { void apply({ axis: event.target.value as "x" | "y" | "z", enabled: true }); }}>
      <option value="x">X normal · YZ plane</option><option value="y">Y normal · XZ plane</option><option value="z">Z normal · XY plane</option>
    </FormField>
    <FieldRow label="Section position" value={position.toFixed(1)} unit="%" />
    <Slider aria-label="Section position" min={0} max={100} step={0.5} value={[position]} disabled={!available}
      onValueChange={([value]) => { if (Number.isFinite(value)) setDraft({ owner: ownerKey, value }); }}
      onValueCommit={([value]) => {
        if (Number.isFinite(value) && value >= 0 && value <= 100) { void apply({ position_percent: value, enabled: true }); }
        setDraft(null);
      }} />
    <FieldRow label="Flip section side" value={<Switch aria-label="Flip section side" checked={clip?.flipped ?? false} disabled={!available} onCheckedChange={(flipped) => { void apply({ flipped, enabled: true }); }} />} />
    <p role="status">{!available ? "Shared section state or command is unavailable." : pending ? "Saving global section…" : "Shared with the viewport and ribbon."}</p>
    {error?.owner === ownerKey ? <p role="alert">{error.message}</p> : null}
    {sync.error ? <p role="alert">Global visualization sync: {sync.error.message}</p> : null}
    {resource.error || resource.refreshError ? <p role="alert">Section state: {(resource.error ?? resource.refreshError)?.message}</p> : null}
  </div>;
}
