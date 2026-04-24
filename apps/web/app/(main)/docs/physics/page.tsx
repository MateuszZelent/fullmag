import Link from "next/link";

const PHYSICS_TOPICS = [
  {
    id: "exchange",
    title: "Exchange and anisotropy",
    status: "published",
    summary:
      "Finite-difference core physics: exchange, uniaxial anisotropy, demagnetization, and external field terms.",
  },
  {
    id: "llg",
    title: "Landau-Lifshitz-Gilbert integration",
    status: "published",
    summary:
      "Time integration controls damping, torque balance, precession step stability, and solver tuning.",
  },
  {
    id: "fem-hybrid",
    title: "FEM + BEM hybrid model",
    status: "draft",
    summary:
      "High-precision FEM/BEM demagnetization for unstructured geometries with complex boundary behavior.",
  },
  {
    id: "eigenmodes",
    title: "Eigenmodes and spin-wave workflows",
    status: "planned",
    summary:
      "Linearized spectral solver for mode extraction in geometry-constrained FDM/FEM experiments.",
  },
] as const;

function statusLabel(status: (typeof PHYSICS_TOPICS)[number]["status"]) {
  return status === "published" ? "Published" : status === "draft" ? "Draft" : "Planned";
}

export default function PhysicsDocsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[1150px] flex-col gap-6 px-5 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/40 pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Documentation
            </p>
            <h1 className="mt-1 text-2xl font-semibold">Physics Documentation</h1>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              This page gives a quick catalog of model families supported in the Fullmag UI.
              It is the first step toward a dedicated documentation hub and follows the same
              scientific model assumptions used by the current runtime.
            </p>
          </div>
          <Link
            href="/workspace"
            className="rounded-md border border-border/50 bg-card/40 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Open Analyze Workspace
          </Link>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {PHYSICS_TOPICS.map((topic) => (
            <article
              key={topic.id}
              className="rounded-md border border-border/50 bg-card/25 p-4"
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="text-[0.9rem] font-semibold tracking-tight">{topic.title}</h2>
                <span className="text-xs text-muted-foreground/90">{statusLabel(topic.status)}</span>
              </div>
              <p className="text-sm text-muted-foreground">{topic.summary}</p>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
