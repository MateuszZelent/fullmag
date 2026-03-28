import { Badge } from "@/components/ui/badge";

const docCardStackClass = "mt-[var(--sp-6)] flex flex-col gap-[var(--sp-4)]";

export default function PhysicsDocsPage() {
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Physics Documentation</h1>
        <p className="page-subtitle">
          Auto-rendered reference from docs/physics notes
        </p>
      </div>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Exchange-Only LLG Reference</h2>
        </div>
        <div className="card-body">
          <p className="leading-[var(--leading-relaxed)] text-[var(--text-soft)]">
            Physics documentation from{" "}
            <code className="font-mono text-[length:var(--text-sm)] text-[var(--ide-accent-text)]">
              docs/physics/
            </code>{" "}
            notes will be auto-rendered here. This ensures every physics feature documented
            through the publication-style notes is visible in the web UI.
          </p>
        </div>
      </section>

      <div className={docCardStackClass}>
        <DocCard
          id="0100"
          title="Exchange Energy"
          status="published"
          description="6-neighbor finite-difference Laplacian on a uniform Cartesian grid with Neumann BC."
        />
        <DocCard
          id="0200"
          title="LLG Exchange Reference Engine"
          status="published"
          description="Landau-Lifshitz-Gilbert equation with Heun integrator for the exchange-only case."
        />
        <DocCard
          id="0300"
          title="GPU FDM Precision and Calibration"
          status="draft"
          description="CUDA FDM kernel precision strategy — single vs double, calibration against CPU reference."
        />
      </div>
    </>
  );
}

function DocCard({
  id,
  title,
  status,
  description,
}: {
  id: string;
  title: string;
  status: "published" | "draft";
  description: string;
}) {
  return (
    <section className="card">
      <div className="card-header">
        <div className="flex items-center gap-[var(--sp-3)]">
          <span className="font-mono text-[length:var(--text-xs)] text-[var(--text-muted)]">
            {id}
          </span>
          <h3 className="card-title">{title}</h3>
        </div>
        <Badge variant={status === "published" ? "success" : "warn"}>
          {status}
        </Badge>
      </div>
      <div className="card-body">
        <p className="text-[length:var(--text-base)] text-[var(--text-soft)]">
          {description}
        </p>
      </div>
    </section>
  );
}
