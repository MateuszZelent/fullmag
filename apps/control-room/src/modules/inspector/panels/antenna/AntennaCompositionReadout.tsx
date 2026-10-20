import { Fingerprint, Activity } from "lucide-react";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { partitionAntennaReadout, type AntennaReadoutRow } from "./AntennaReadoutModel";

function ReadoutRows({ rows }: { rows: AntennaReadoutRow[] }) {
  return rows.map(row => <FieldRow key={row.label} label={row.label} mono={row.mono} unit={row.unit}
    value={<span title={typeof row.value === "string" ? row.value : undefined}>{row.value}</span>} />);
}

export function AntennaCompositionReadout({ title, badge, rows }: {
  title: string; badge: string; rows: AntennaReadoutRow[];
}) {
  const groups = partitionAntennaReadout(rows);
  return <div className="fm-antenna-readout" data-testid="antenna-composition-readout">
    <InspectorGroup title={title} badge={badge}>
      <ReadoutRows rows={groups.parameters} />
      {badge.includes("pending") ? <FeedbackBanner kind="warning" message={badge.startsWith("invalid")
        ? "Complete the antenna stage validation requirements before field solve; an older published result is not current."
        : "To publish H_ant or FFT results, run the configured field-solve/projection stage first."} /> : null}
    </InspectorGroup>
    {groups.runtime.length ? <InspectorGroup title="Execution and publication" icon={<Activity size={14} />}>
      <ReadoutRows rows={groups.runtime} />
    </InspectorGroup> : null}
    {groups.identity.length ? <InspectorGroup title="Identity and provenance" icon={<Fingerprint size={14} />}
      badge={`${groups.identity.length} references`}
      collapsible defaultOpen={false} className="fm-antenna-readout__identity">
      <p className="fm-inspector-hint">Exact resource IDs, source references and content signatures.</p>
      <ReadoutRows rows={groups.identity} />
    </InspectorGroup> : null}
  </div>;
}
