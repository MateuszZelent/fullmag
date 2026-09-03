"use client";

import type { EigenSpectrumArtifact } from "./eigenTypes";

interface EigenSolverSummaryProps {
  spectrum: EigenSpectrumArtifact | null;
}

function SummaryRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="shrink-0 text-[0.68rem] font-medium text-muted-foreground">{label}</span>
      <span className="text-[0.72rem] text-foreground">{value}</span>
    </div>
  );
}

function TagList({ label, items }: { label: string; items: string[] | undefined }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="py-0.5">
      <span className="text-[0.68rem] font-medium text-muted-foreground">{label}</span>
      <div className="mt-0.5 flex flex-wrap gap-1">
        {items.map((item) => (
          <span
            key={item}
            className="inline-flex rounded bg-muted/60 px-1.5 py-0.5 text-[0.65rem] text-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function includedTermsList(
  terms: EigenSpectrumArtifact["included_terms"],
): string[] {
  if (!terms) return [];
  const out: string[] = [];
  if (terms.exchange) out.push("exchange");
  if (terms.demag) out.push("demag");
  if (terms.zeeman) out.push("zeeman");
  if (terms.interfacial_dmi) out.push("interfacial DMI");
  if (terms.bulk_dmi) out.push("bulk DMI");
  if (terms.surface_anisotropy) out.push("surface anisotropy");
  return out;
}

function formatKVector(k: [number, number, number] | null | undefined): string | null {
  if (!k) return null;
  return `[${k.map((v) => v.toFixed(4)).join(", ")}]`;
}

export default function EigenSolverSummary({ spectrum }: EigenSolverSummaryProps) {
  if (!spectrum) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No eigen summary available.
      </div>
    );
  }

  const terms = includedTermsList(spectrum.included_terms);

  return (
    <div className="space-y-3 text-sm">
      <h3 className="text-[0.78rem] font-semibold text-foreground">Eigensolve Summary</h3>

      <section className="space-y-0.5">
        <h4 className="text-[0.7rem] font-medium text-muted-foreground/80 uppercase tracking-wider">
          Solver
        </h4>
        <SummaryRow label="Operator" value={spectrum.operator?.kind} />
        <SummaryRow label="Solver kind" value={spectrum.solver_kind} />
        <SummaryRow label="Damping policy" value={spectrum.damping_policy} />
        <SummaryRow label="Normalization" value={spectrum.normalization} />
        <SummaryRow label="Notes" value={spectrum.solver_notes} />
      </section>

      <section className="space-y-0.5">
        <h4 className="text-[0.7rem] font-medium text-muted-foreground/80 uppercase tracking-wider">
          Problem
        </h4>
        <SummaryRow label="Mode count" value={String(spectrum.mode_count)} />
        <SummaryRow label="Mesh" value={spectrum.mesh_name ?? undefined} />
        <SummaryRow
          label="Equilibrium"
          value={
            spectrum.equilibrium_source
              ? `${spectrum.equilibrium_source.kind}${spectrum.equilibrium_source.path ? `: ${spectrum.equilibrium_source.path}` : ""}`
              : undefined
          }
        />
        <SummaryRow label="Boundary" value={spectrum.spin_wave_bc} />
        <SummaryRow label="k vector" value={formatKVector(spectrum.k_sampling)} />
        <SummaryRow label="Relaxation steps" value={String(spectrum.relaxation_steps)} />
      </section>

      {terms.length > 0 && (
        <section className="space-y-0.5">
          <h4 className="text-[0.7rem] font-medium text-muted-foreground/80 uppercase tracking-wider">
            Included terms
          </h4>
          <TagList label="" items={terms} />
        </section>
      )}

      <TagList label="Capabilities" items={spectrum.solver_capabilities} />
      <TagList label="Limitations" items={spectrum.solver_limitations} />
    </div>
  );
}
