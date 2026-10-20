"use client";

import { useState } from "react";
import { Activity, Cable, Layers, Radio, Waves, Zap } from "lucide-react";
import { useKernel } from "@/kernel/KernelContext";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { antennaNavigationLinks, type AntennaNavigationLink } from "@/modules/explorer/public";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { FieldRow } from "../../primitives/FieldRow";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { antennaNavigationScene } from "./AntennaNavigationScene";

const sections = [
  { title: "Conductor", prefix: "conductor", icon: Cable, description: "Materials, charge transport and conductor authoring.", empty: "Conductor details are unavailable." },
  { title: "Ports", prefix: "port:", icon: Zap, description: "Terminal branches, signed weights and current normalization.", empty: "No ports configured. Open Conductor to create a port." },
  { title: "Field solves", prefix: "solution:", icon: Activity, description: "Standalone current and antenna-field definitions.", empty: "No field solve configured. Open Conductor to create one." },
  { title: "Projections", prefix: "projection:", icon: Layers, description: "Bindings from a field basis to its receivers.", empty: "No projections configured. Open a Field solve to create a projection and drive." },
  { title: "Current drives", prefix: "drive:", icon: Waves, description: "Current amplitudes, waveforms and stage activation.", empty: "No current drives configured. Open a Field solve to create a projection and drive." },
  { title: "Source spectra", prefix: "spectrum:", icon: Radio, description: "Spatial FFT requests of the antenna source field.", empty: "No source spectra configured. Open a Field solve to create a spectrum request." },
] as const;

/** Composition navigation owns no solver state and never treats definitions as results. */
export function AntennaCompositionSummaryPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const objectId = selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId;
  const objects = scene.data?.objects?.filter(object => object.id === objectId) ?? [];
  const object = objects.length === 1 ? objects[0] : null;
  const links = object && scene.data ? antennaNavigationLinks(scene.data, selection) : [];
  const available = scene.status === "ready" && Boolean(scene.sessionScopeKey) && !scene.error && !scene.refreshError;

  function open(link: AntennaNavigationLink) {
    const current = antennaNavigationScene(kernel, scene.sessionScopeKey);
    const target = current ? antennaNavigationLinks(current, selection).find(item => item.key === link.key) : null;
    if (!target?.selection) {
      setNavigationError("The resource changed or is unavailable. Refresh the Inspector before navigating.");
      return;
    }
    setNavigationError(null);
    kernel.selection.set(target.selection, "inspector");
  }

  function resourceLink(link: AntennaNavigationLink) {
    return <div key={link.key}>
      <Button type="button" variant="secondary" className="h-auto min-h-fm-control-md w-full justify-start py-2 text-left whitespace-normal break-words"
        disabled={!available || !link.selection} onClick={() => open(link)}>
        Open {link.label}{link.selection && link.selection.label !== link.label ? ` · ${link.selection.label}` : ""}
      </Button>
      {link.reason ? <p className="fm-inspector-hint">{link.reason}</p> : null}
    </div>;
  }

  return <div className="fm-inspector-panel" data-inspector-owner="object.antenna" data-testid="antenna-composition-summary">
    <InspectorGroup title="Antenna composition" badge="Authored configuration"
      description="Follow the conductor-to-field workflow. Each resource has its own Inspector.">
      <FieldRow label="Name" value={object?.name || "Unavailable"} />
      <FieldRow label="Object ID" mono value={objectId ?? "None"} />
      <p className="fm-inspector-hint">Configured resources do not establish a completed solve or a published field. Inspect execution and provenance in the individual resource.</p>
    </InspectorGroup>
    {scene.error || scene.refreshError ? <FeedbackBanner kind="error" message={(scene.error ?? scene.refreshError)!.message} />
      : !scene.data ? <p role="status">Loading antenna composition…</p>
        : !object ? <FeedbackBanner kind="warning" message="The selected object is missing or ambiguous in the current scene." /> : null}
    {navigationError ? <FeedbackBanner kind="warning" message={navigationError} /> : null}
    {object ? <>
      {sections.map(({ title, prefix, icon: Icon, description, empty }) => {
        const resources = links.filter(link => prefix === "conductor" ? link.key === prefix : link.key.startsWith(prefix));
        return <InspectorGroup key={prefix} title={title} icon={<Icon size={14} />} badge={prefix === "conductor" ? undefined : `${resources.length} configured`} description={description}>
          {resources.length ? resources.map(resourceLink) : <p className="fm-inspector-hint">{empty}</p>}
        </InspectorGroup>;
      })}
      <InspectorGroup title="Geometry and source definition" description="Edit the physical layout and source cut separately from field results.">
        {links.filter(link => link.key === "geometry" || link.key === "terminals").map(resourceLink)}
      </InspectorGroup>
      <InspectorGroup title="Regional field drive" description="A separate prescribed magnetic-field source; it does not solve conductor current.">
        {links.filter(link => link.key === "regional").map(resourceLink)}
      </InspectorGroup>
    </> : null}
  </div>;
}
