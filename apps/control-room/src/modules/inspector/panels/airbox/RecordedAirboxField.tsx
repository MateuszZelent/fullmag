"use client";

import {
  antennaInspectionDisplayMatchesOwner,
  useAntennaExternalLeadInspectionResource,
  useAntennaInspectionDisplayResource,
} from "@/kernel/resources/antennaResources";
import { isClosedLoopDisplay } from "@/kernel/resources/antennaClosedLoopInspectionModel";
import { antennaInspectionIntentMatchesOwner } from "@/kernel/visualization/antennaFieldIntent";
import type { ArtifactFieldSelection } from "@/kernel/visualization/artifactFieldSelection";
import { useObjectVisualizationController, useObjectVisualizationSelector } from "@/kernel/visualization/useObjectVisualization";
import { Button } from "@/shared/ui/Button";
import { recordedAirboxFieldIntent } from "./recordedAirboxFieldModel";

export function RecordedAirboxField({ owner }: { owner: ArtifactFieldSelection }) {
  const visualization = useObjectVisualizationController();
  const activeIntent = useObjectVisualizationSelector(snapshot => snapshot.antennaFieldIntent);
  const inspection = useAntennaExternalLeadInspectionResource(owner.runtimeStageId);
  const record = inspection.status === "ready" && !inspection.refreshError ? inspection.data : null;
  const intent = recordedAirboxFieldIntent(owner, record);
  const display = useAntennaInspectionDisplayResource(intent ? record : null);
  const available = Boolean(record && display.status === "ready" && !display.refreshError && display.data &&
    isClosedLoopDisplay(display.data) && display.data.capabilities.display && antennaInspectionDisplayMatchesOwner(record, display.data));
  const active = Boolean(record && activeIntent?.quantity === "magnetic_field" &&
    activeIntent.vectors && antennaInspectionIntentMatchesOwner(activeIntent, record));
  if (!intent) return null;

  return (
    <Button size="sm" variant="secondary" aria-pressed={active} disabled={!available}
      onClick={() => visualization.setAntennaFieldIntent(active ? null : intent)}>
      {active ? "Hide recorded H" : "Show recorded H [A/m]"}
    </Button>
  );
}
