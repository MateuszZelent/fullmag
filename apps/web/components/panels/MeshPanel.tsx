"use client";

import Panel from "../ui/Panel";
import ReadonlyField from "../ui/ReadonlyField";

/* ── FEM mesh info (from mesh builder / artifacts) ────────────────── */

export interface FemMeshInfo {
  nNodes: number;
  nElements: number;
  nBoundaryFaces: number;
  totalVolume: number;
  feOrder: number;
  quality?: {
    minAR: number;
    maxAR: number;
    meanAR: number;
  };
}

interface MeshPanelProps {
  /** FDM grid dimensions [Nx, Ny, Nz] */
  grid?: number[];
  /** FDM cell size [dx, dy, dz] in meters */
  cellSize?: number[];
  /** FEM mesh info — if present, FEM mode is used */
  femInfo?: FemMeshInfo;
  backend?: string;
  sourceKind?: string | null;
  sourceLabel?: string | null;
  sourcePath?: string | null;
  realizationLabel?: string | null;
  interopTags?: string[];
  hmax?: number | null;
}

const SI_PREFIXES = [
  { threshold: 1,    divisor: 1,    unit: "m" },
  { threshold: 1e-3, divisor: 1e-3, unit: "mm" },
  { threshold: 1e-6, divisor: 1e-6, unit: "µm" },
  { threshold: 1e-9, divisor: 1e-9, unit: "nm" },
  { threshold: 0,    divisor: 1e-12, unit: "pm" },
];

function formatSI(meters: number): { value: string; unit: string } {
  if (meters === 0) return { value: "0", unit: "m" };
  const abs = Math.abs(meters);
  for (const { threshold, divisor, unit } of SI_PREFIXES) {
    if (abs >= threshold) {
      const scaled = meters / divisor;
      const decimals = abs >= 1 ? 3 : Math.max(0, 4 - Math.floor(Math.log10(Math.abs(scaled)) + 1));
      return { value: scaled.toFixed(decimals), unit };
    }
  }
  const last = SI_PREFIXES[SI_PREFIXES.length - 1];
  return { value: (meters / last.divisor).toFixed(3), unit: last.unit };
}

function formatEng(v: number, p = 3): string {
  if (v === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(v)));
  if (exp >= -3 && exp <= 3) return v.toPrecision(p);
  return v.toExponential(p - 1);
}

function Tag({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: "999px",
        border: "1px solid var(--border-subtle)",
        background: "rgba(255,255,255,0.04)",
        padding: "0.28rem 0.6rem",
        fontSize: "0.75rem",
        color: "var(--text-2)",
        letterSpacing: "0.02em",
      }}
    >
      {label}
    </span>
  );
}

/* ── Shared section renderer ──────────────────────────────────────── */

function Section({
  title,
  entries,
}: {
  title: string;
  entries: { label: string; value: string; unit: string }[];
}) {
  return (
    <div style={{ display: "grid", gap: "0.8rem" }}>
      <header
        style={{
          fontSize: "0.76rem",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          color: "var(--text-3)",
        }}
      >
        {title}
      </header>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.min(entries.length, 3)}, minmax(0, 1fr))`,
          gap: "0.8rem",
        }}
      >
        {entries.map((entry) => (
          <ReadonlyField
            key={entry.label}
            label={entry.label}
            value={entry.value}
            unit={entry.unit}
            mono
          />
        ))}
      </div>
    </div>
  );
}

/* ── Main Component ───────────────────────────────────────────────── */

export default function MeshPanel({
  grid,
  cellSize,
  femInfo,
  backend,
  sourceKind,
  sourceLabel,
  sourcePath,
  realizationLabel,
  interopTags = [],
  hmax,
}: MeshPanelProps) {
  const isFem = !!femInfo;
  const effectiveBackend = backend || (isFem ? "fem" : "fdm");

  return (
    <Panel
      title="Geometry & Mesh"
      subtitle={
        isFem
          ? "Current geometry asset and tetrahedral realization for the active FEM run."
          : "Current geometry asset and structured-grid realization for the active FDM run."
      }
      panelId="mesh"
      eyebrow={isFem ? "FEM" : "FDM"}
      actions={<Tag label={effectiveBackend.toUpperCase()} />}
    >
      <div style={{ display: "grid", gap: "1rem" }}>
        <Section
          title="Pipeline"
          entries={[
            {
              label: "Source",
              value: sourceLabel || (isFem ? "prebuilt mesh asset" : "analytic geometry"),
              unit: "",
            },
            {
              label: "Kind",
              value: sourceKind || (isFem ? "mesh_asset" : "structured_grid"),
              unit: "",
            },
            {
              label: "Realization",
              value: realizationLabel || (isFem ? "tetra mesh" : "voxel grid"),
              unit: "",
            },
          ]}
        />

        {sourcePath && (
          <div
            style={{
              display: "grid",
              gap: "0.45rem",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-subtle)",
              background: "rgba(255,255,255,0.03)",
              padding: "0.8rem 0.9rem",
            }}
          >
            <header
              style={{
                fontSize: "0.76rem",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                color: "var(--text-3)",
              }}
            >
              Asset path
            </header>
            <code
              style={{
                display: "block",
                overflowWrap: "anywhere",
                color: "var(--text-2)",
                fontSize: "0.82rem",
              }}
            >
              {sourcePath}
            </code>
          </div>
        )}

        {/* ── FEM mode ──────────────────────────── */}
        {isFem && femInfo && (
          <>
            <Section
              title="Topology"
              entries={[
                { label: "Nodes", value: femInfo.nNodes.toLocaleString(), unit: "" },
                { label: "Elements", value: femInfo.nElements.toLocaleString(), unit: "" },
                { label: "Boundary", value: femInfo.nBoundaryFaces.toLocaleString(), unit: "" },
              ]}
            />
            <Section
              title="Properties"
              entries={[
                { label: "Volume", value: formatEng(femInfo.totalVolume), unit: "m³" },
                { label: "FE Order", value: `P${femInfo.feOrder}`, unit: "" },
                { label: "hmax", value: hmax ? formatSI(hmax).value : "—", unit: hmax ? formatSI(hmax).unit : "" },
              ]}
            />
            {femInfo.quality && (
              <Section
                title="Quality"
                entries={[
                  { label: "Min AR", value: femInfo.quality.minAR.toFixed(2), unit: "" },
                  { label: "Mean AR", value: femInfo.quality.meanAR.toFixed(2), unit: "" },
                  { label: "Max AR", value: femInfo.quality.maxAR.toFixed(2), unit: "" },
                ]}
              />
            )}
          </>
        )}

        {/* ── FDM mode ──────────────────────────── */}
        {!isFem && grid && (
          <>
            {(() => {
              const [Nx, Ny, Nz] = grid.length >= 3 ? grid : [0, 0, 0];
              const [dx, dy, dz] = cellSize && cellSize.length >= 3 ? cellSize : [0, 0, 0];

              return (
                <>
                  <Section
                    title="Grid"
                    entries={[
                      { label: "Nx", value: `${Nx}`, unit: "" },
                      { label: "Ny", value: `${Ny}`, unit: "" },
                      { label: "Nz", value: `${Nz}`, unit: "" },
                    ]}
                  />
                  {(dx || dy || dz) && (
                    <>
                      <Section
                        title="Cell size"
                        entries={[
                          { label: "dx", ...formatSI(dx) },
                          { label: "dy", ...formatSI(dy) },
                          { label: "dz", ...formatSI(dz) },
                        ]}
                      />
                      <Section
                        title="Total size"
                        entries={[
                          { label: "Tx", ...formatSI(Nx * dx) },
                          { label: "Ty", ...formatSI(Ny * dy) },
                          { label: "Tz", ...formatSI(Nz * dz) },
                        ]}
                      />
                    </>
                  )}
                </>
              );
            })()}
          </>
        )}

        {interopTags.length > 0 && (
          <div style={{ display: "grid", gap: "0.7rem" }}>
            <header
              style={{
                fontSize: "0.76rem",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                color: "var(--text-3)",
              }}
            >
              Interoperability
            </header>
            <div style={{ display: "flex", gap: "0.55rem", flexWrap: "wrap" }}>
              {interopTags.map((tag) => (
                <Tag key={tag} label={tag} />
              ))}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
