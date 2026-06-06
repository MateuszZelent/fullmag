import type { MeshPolicyDiffRow } from "@/shared/domain/mesh/meshPolicyDiff";

export function MeshBuildParameterDiff({
  rows,
}: {
  rows: readonly MeshPolicyDiffRow[];
}) {
  if (rows.length === 0) {
    return (
      <section className="fm-mesh-build-confirm__section" aria-label="Mesh parameter changes">
        <h3 className="fm-mesh-build-confirm__section-title">Parameter Changes</h3>
        <p className="fm-mesh-build-confirm__empty">No pending policy changes.</p>
      </section>
    );
  }

  return (
    <section className="fm-mesh-build-confirm__section" aria-label="Mesh parameter changes">
      <h3 className="fm-mesh-build-confirm__section-title">Parameter Changes</h3>
      <div className="fm-mesh-build-confirm__diff" role="table">
        <div
          className="fm-mesh-build-confirm__diff-row fm-mesh-build-confirm__diff-row--header"
          role="row"
        >
          <span role="columnheader">Scope</span>
          <span role="columnheader">Parameter</span>
          <span role="columnheader">Current</span>
          <span role="columnheader">New</span>
          <span role="columnheader">Last realized</span>
          <span role="columnheader">Impact</span>
        </div>
        {rows.map((row) => (
          <div
            className="fm-mesh-build-confirm__diff-row"
            data-state={row.state}
            key={`${row.scope}:${row.path}`}
            role="row"
          >
            <span role="cell">{row.scope}</span>
            <span role="cell">{row.label}</span>
            <span role="cell">{row.currentValue}</span>
            <span role="cell">{row.draftValue}</span>
            <span role="cell">{row.realizedValue}</span>
            <span role="cell">{row.impact}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
