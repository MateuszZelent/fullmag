"use client";

import { useState } from "react";
import { X, ChevronRight, BookOpen, Atom, Grid3X3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";

interface DocEntry {
  id: string;
  title: string;
  status: "published" | "draft" | "planned";
  description: string;
  category: string;
}

const PHYSICS_DOCS: DocEntry[] = [
  {
    id: "0100",
    title: "Exchange Energy",
    status: "published",
    category: "FDM Core",
    description: "6-neighbor finite-difference Laplacian on a uniform Cartesian grid with Neumann BC.",
  },
  {
    id: "0200",
    title: "LLG Exchange Reference Engine",
    status: "published",
    category: "FDM Core",
    description: "Landau-Lifshitz-Gilbert equation with Heun integrator for the exchange-only case.",
  },
  {
    id: "0300",
    title: "GPU FDM Precision and Calibration",
    status: "draft",
    category: "FDM Core",
    description: "CUDA FDM kernel precision strategy — single vs double, calibration against CPU reference.",
  },
  {
    id: "0400",
    title: "Demagnetization Field (FDM)",
    status: "published",
    category: "FDM Core",
    description: "FFT-based demagnetization solver on uniform Cartesian grid.",
  },
  {
    id: "0500",
    title: "Zeeman Interaction",
    status: "published",
    category: "FDM Core",
    description: "External field contribution to the effective field in LLG.",
  },
  {
    id: "1000",
    title: "FEM Mesh Generation",
    status: "published",
    category: "FEM",
    description: "Gmsh-based tetrahedral meshing pipeline for magnetic multi-body geometries.",
  },
  {
    id: "1100",
    title: "FEM Demagnetization (Hybrid)",
    status: "published",
    category: "FEM",
    description: "FEM-BEM hybrid approach for magnetostatic demagnetization field in irregular domains.",
  },
  {
    id: "1200",
    title: "FEM Eigenmodes",
    status: "draft",
    category: "FEM",
    description: "Spin-wave eigenmode computation via linearized LLG in FEM formulation.",
  },
];

const CATEGORIES = [...new Set(PHYSICS_DOCS.map((d) => d.category))];

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  "FDM Core": <Atom size={13} />,
  "FEM": <Grid3X3 size={13} />,
};

function StatusBadge({ status }: { status: DocEntry["status"] }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[0.6rem] font-semibold tracking-wider uppercase",
        status === "published" ? "bg-emerald-500/15 text-emerald-400" :
        status === "draft" ? "bg-amber-500/15 text-amber-400" :
        "bg-muted/40 text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}

function DocDetail({ entry }: { entry: DocEntry }) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="text-[0.68rem] font-semibold tracking-widest uppercase text-muted-foreground">{entry.category}</span>
          <h3 className="mt-0.5 text-[1rem] font-semibold text-foreground">{entry.title}</h3>
        </div>
        <StatusBadge status={entry.status} />
      </div>
      <p className="text-[0.82rem] text-muted-foreground leading-relaxed">{entry.description}</p>
      <div className="rounded-lg border border-border/40 bg-card/30 p-3">
        <p className="text-[0.75rem] text-muted-foreground">
          Full reference documentation for <strong className="text-foreground">{entry.title}</strong> is
          compiled from <code className="font-mono text-primary/80 text-[0.7rem]">docs/physics/</code> notes
          and will be auto-rendered here in future versions.
        </p>
      </div>
    </div>
  );
}

function PhysicsDocsDrawerInner({ onClose }: { onClose: () => void }) {
  const topic = useWorkspaceStore((s) => s.physicsDocsTopic);
  const [selected, setSelected] = useState<DocEntry | null>(
    topic ? (PHYSICS_DOCS.find((d) => d.id === topic) ?? PHYSICS_DOCS[0]) : PHYSICS_DOCS[0],
  );
  const [search, setSearch] = useState("");

  const filtered = search.trim()
    ? PHYSICS_DOCS.filter(
        (d) =>
          d.title.toLowerCase().includes(search.toLowerCase()) ||
          d.description.toLowerCase().includes(search.toLowerCase()),
      )
    : PHYSICS_DOCS;

  return (
    <div className="fixed inset-y-0 right-0 z-[180] flex w-[680px] max-w-[95vw] flex-col border-l border-border/60 bg-background shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/40 px-4 py-3 shrink-0">
        <div className="flex items-center gap-2">
          <BookOpen size={15} className="text-muted-foreground" />
          <span className="text-[0.88rem] font-semibold">Physics Reference</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* List */}
        <div className="flex w-56 shrink-0 flex-col border-r border-border/40 overflow-hidden">
          <div className="px-3 pt-3 pb-2 shrink-0">
            <input
              type="search"
              placeholder="Search docs…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-[0.78rem] text-foreground placeholder:text-muted-foreground/60 outline-none focus:ring-1 focus:ring-primary/40"
            />
          </div>
          <div className="flex-1 overflow-auto px-2 pb-3">
            {CATEGORIES.map((cat) => {
              const catDocs = filtered.filter((d) => d.category === cat);
              if (catDocs.length === 0) return null;
              return (
                <div key={cat} className="mb-3">
                  <div className="flex items-center gap-1.5 px-2 py-1 text-[0.67rem] font-semibold uppercase tracking-widest text-muted-foreground">
                    {CATEGORY_ICONS[cat]}
                    {cat}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {catDocs.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => setSelected(d)}
                        className={cn(
                          "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[0.78rem] text-left transition-colors",
                          selected?.id === d.id
                            ? "bg-primary/15 text-primary"
                            : "text-foreground/80 hover:bg-muted/40 hover:text-foreground",
                        )}
                      >
                        <ChevronRight size={11} className="shrink-0 opacity-50" />
                        <span className="truncate">{d.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Detail */}
        <div className="flex-1 overflow-auto">
          {selected ? (
            <DocDetail entry={selected} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a topic from the list
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PhysicsDocsDrawer() {
  const open = useWorkspaceStore((s) => s.physicsDocsOpen);
  const setOpen = useWorkspaceStore((s) => s.setPhysicsDocsOpen);
  if (!open) return null;
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[170] bg-black/30"
        onClick={() => setOpen(false)}
      />
      <PhysicsDocsDrawerInner onClose={() => setOpen(false)} />
    </>
  );
}
