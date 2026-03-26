"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { resolveApiBase } from "../../lib/apiBase";
import Panel from "../ui/Panel";
import Button from "../ui/Button";
import ReadonlyField from "../ui/ReadonlyField";
import StatusBadge from "../ui/StatusBadge";
import SelectField from "../ui/SelectField";

type BackendKind = "fdm" | "fem";
type LocalRealization = "fdm" | "fem";

interface FemMeshLike {
  nodes: [number, number, number][];
  elements: [number, number, number, number][];
  boundary_faces: [number, number, number][];
}

interface BoundsSummary {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

interface ImportedAssetSummary {
  assetId?: string;
  storedPath?: string;
  origin?: "backend" | "browser";
  fileName: string;
  fileBytes: number;
  kind: "stl_surface" | "tet_mesh" | "gmsh_mesh" | "mesh_exchange" | "unknown";
  bounds?: BoundsSummary;
  triangleCount?: number;
  nodeCount?: number;
  elementCount?: number;
  boundaryFaceCount?: number;
  note?: string;
}

interface MeshOperationsPanelProps {
  sessionId?: string | null;
  backend: BackendKind;
  sourceLabel?: string | null;
  sourceKind?: string | null;
  sourcePath?: string | null;
  realizationLabel?: string | null;
  interopTags?: string[];
  grid?: [number, number, number];
  cellSize?: number[];
  totalCells?: number | null;
  activeCells?: number | null;
  femMesh?: FemMeshLike | null;
  femOrder?: number | null;
  femHmax?: number | null;
  artifactDir?: string | null;
}

function formatMeters(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const abs = Math.abs(value);
  if (abs >= 1e-3) return `${(value * 1e3).toFixed(3)} mm`;
  if (abs >= 1e-6) return `${(value * 1e6).toFixed(3)} µm`;
  if (abs >= 1e-9) return `${(value * 1e9).toFixed(3)} nm`;
  return `${value.toExponential(3)} m`;
}

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return Math.round(value).toLocaleString();
}

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${Math.round(value)} B`;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function copyText(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("Clipboard API is not available");
}

function downloadText(filename: string, text: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function inferImportedKind(fileName: string): ImportedAssetSummary["kind"] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".stl")) return "stl_surface";
  if (lower.endsWith(".mesh.json") || lower.endsWith(".json")) return "tet_mesh";
  if (lower.endsWith(".msh")) return "gmsh_mesh";
  if (lower.endsWith(".vtk") || lower.endsWith(".vtu") || lower.endsWith(".xdmf")) return "mesh_exchange";
  return "unknown";
}

function computeBounds(points: Array<[number, number, number]>): BoundsSummary | undefined {
  if (!points.length) {
    return undefined;
  }
  const min: [number, number, number] = [points[0][0], points[0][1], points[0][2]];
  const max: [number, number, number] = [points[0][0], points[0][1], points[0][2]];
  for (const [x, y, z] of points) {
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

function parseMeshJsonSummary(fileName: string, fileBytes: number, payload: unknown): ImportedAssetSummary {
  const record = (payload ?? {}) as Record<string, unknown>;
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  const elements = Array.isArray(record.elements) ? record.elements : [];
  const boundaryFaces = Array.isArray(record.boundary_faces) ? record.boundary_faces : [];
  const points = nodes
    .filter(
      (node): node is [number, number, number] =>
        Array.isArray(node) &&
        node.length >= 3 &&
        typeof node[0] === "number" &&
        typeof node[1] === "number" &&
        typeof node[2] === "number",
    )
    .map((node) => [node[0], node[1], node[2]] as [number, number, number]);

  return {
    fileName,
    fileBytes,
    kind: "tet_mesh",
    nodeCount: nodes.length,
    elementCount: elements.length,
    boundaryFaceCount: boundaryFaces.length,
    bounds: computeBounds(points),
  };
}

function parseAsciiStlSummary(fileName: string, fileBytes: number, text: string): ImportedAssetSummary {
  const vertexRegex = /vertex\s+([+-]?(?:\d+\.?\d*|\d*\.?\d+)(?:[eE][+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\d*\.?\d+)(?:[eE][+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\d*\.?\d+)(?:[eE][+-]?\d+)?)/g;
  const points: Array<[number, number, number]> = [];
  let match: RegExpExecArray | null = vertexRegex.exec(text);
  while (match) {
    points.push([Number(match[1]), Number(match[2]), Number(match[3])]);
    match = vertexRegex.exec(text);
  }
  return {
    fileName,
    fileBytes,
    kind: "stl_surface",
    triangleCount: Math.floor(points.length / 3),
    bounds: computeBounds(points),
  };
}

function parseBinaryStlSummary(fileName: string, fileBytes: number, buffer: ArrayBuffer): ImportedAssetSummary {
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(80, true);
  const points: Array<[number, number, number]> = [];
  let offset = 84;
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    offset += 12;
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
      points.push([
        view.getFloat32(offset, true),
        view.getFloat32(offset + 4, true),
        view.getFloat32(offset + 8, true),
      ]);
      offset += 12;
    }
    offset += 2;
  }
  return {
    fileName,
    fileBytes,
    kind: "stl_surface",
    triangleCount,
    bounds: computeBounds(points),
  };
}

function parseStlSummary(fileName: string, fileBytes: number, buffer: ArrayBuffer, text: string): ImportedAssetSummary {
  if (buffer.byteLength >= 84) {
    const triangleCount = new DataView(buffer).getUint32(80, true);
    if (84 + triangleCount * 50 === buffer.byteLength) {
      return parseBinaryStlSummary(fileName, fileBytes, buffer);
    }
  }
  return parseAsciiStlSummary(fileName, fileBytes, text);
}

function parseMshSummary(fileName: string, fileBytes: number, text: string): ImportedAssetSummary {
  const lines = text.split(/\r?\n/);
  let nodeCount: number | undefined;
  let elementCount: number | undefined;
  let note = "Browser summary supports Gmsh ASCII v2 best; full meshing stays in external tools.";

  const nodesIndex = lines.findIndex((line) => line.trim() === "$Nodes");
  if (nodesIndex >= 0 && lines[nodesIndex + 1]) {
    const parsed = Number(lines[nodesIndex + 1].trim());
    if (Number.isFinite(parsed)) {
      nodeCount = parsed;
    }
  }

  const elementsIndex = lines.findIndex((line) => line.trim() === "$Elements");
  if (elementsIndex >= 0 && lines[elementsIndex + 1]) {
    const parsed = Number(lines[elementsIndex + 1].trim());
    if (Number.isFinite(parsed)) {
      elementCount = parsed;
    }
  }

  if (text.includes("$Entities")) {
    note = "Gmsh v4 detected. Full topology parsing is deferred to the Python meshing pipeline.";
  }

  return {
    fileName,
    fileBytes,
    kind: "gmsh_mesh",
    nodeCount,
    elementCount,
    note,
  };
}

function allowedRealizations(kind: ImportedAssetSummary["kind"]): LocalRealization[] {
  if (kind === "tet_mesh" || kind === "gmsh_mesh" || kind === "mesh_exchange") {
    return ["fem"];
  }
  if (kind === "stl_surface") {
    return ["fdm", "fem"];
  }
  return ["fdm", "fem"];
}

function asciiStlFromMesh(mesh: FemMeshLike, solidName: string): string {
  const lines = [`solid ${solidName}`];
  for (const [ia, ib, ic] of mesh.boundary_faces) {
    const a = mesh.nodes[ia];
    const b = mesh.nodes[ib];
    const c = mesh.nodes[ic];
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const norm = Math.hypot(nx, ny, nz) || 1;
    lines.push(`  facet normal ${nx / norm} ${ny / norm} ${nz / norm}`);
    lines.push("    outer loop");
    lines.push(`      vertex ${a[0]} ${a[1]} ${a[2]}`);
    lines.push(`      vertex ${b[0]} ${b[1]} ${b[2]}`);
    lines.push(`      vertex ${c[0]} ${c[1]} ${c[2]}`);
    lines.push("    endloop");
    lines.push("  endfacet");
  }
  lines.push(`endsolid ${solidName}`);
  return `${lines.join("\n")}\n`;
}

export default function MeshOperationsPanel({
  sessionId,
  backend,
  sourceLabel,
  sourceKind,
  sourcePath,
  realizationLabel,
  interopTags = [],
  grid,
  cellSize,
  totalCells,
  activeCells,
  femMesh,
  femOrder,
  femHmax,
  artifactDir,
}: MeshOperationsPanelProps) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const [importTarget, setImportTarget] = useState<LocalRealization>(backend);
  const [importedAsset, setImportedAsset] = useState<ImportedAssetSummary | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const importEndpoint = sessionId
    ? `${resolveApiBase()}/v1/sessions/${sessionId}/assets/import`
    : `${resolveApiBase()}/v1/live/current/assets/import`;

  const primaryCount = backend === "fem" ? femMesh?.elements.length ?? null : totalCells;
  const primaryCountLabel = backend === "fem" ? "FEM elements" : "FDM cells";
  const secondaryCount = backend === "fem" ? femMesh?.nodes.length ?? null : activeCells;
  const secondaryCountLabel = backend === "fem" ? "FEM nodes" : "Active cells";

  useEffect(() => {
    setImportTarget(backend);
  }, [backend]);

  const femImportSnippet = useMemo(() => {
    if (backend !== "fem") return null;
    const meshPath = sourcePath ?? "/path/to/mesh.mesh.json";
    const order = femOrder ?? 1;
    const hmax = femHmax ?? 5e-9;
    return `fm.DiscretizationHints(fem=fm.FEM(order=${order}, hmax=${hmax}, mesh="${meshPath}"))`;
  }, [backend, sourcePath, femOrder, femHmax]);

  const fdmImportSnippet = useMemo(() => {
    if (backend !== "fdm") return null;
    const [dx, dy, dz] = cellSize && cellSize.length >= 3 ? cellSize : [2e-9, 2e-9, 2e-9];
    return `fm.DiscretizationHints(fdm=fm.FDM(cell=(${dx}, ${dy}, ${dz})))`;
  }, [backend, cellSize]);

  const onCopy = async (value: string, label: string) => {
    try {
      await copyText(value);
      setFeedback(`${label} copied`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Copy failed");
    }
  };

  const onImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setIsImporting(true);
    setFeedback(null);
    try {
      const kind = inferImportedKind(file.name);
      const buffer = await file.arrayBuffer();
      let summary: ImportedAssetSummary;
      try {
        const response = await fetch(importEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            file_name: file.name,
            content_base64: toBase64(buffer),
            target_realization: importTarget,
          }),
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error ?? `Upload failed with status ${response.status}`);
        }

        const payload = await response.json();
        summary = {
          assetId: payload.asset_id,
          storedPath: payload.stored_path,
          origin: "backend",
          fileName: payload.summary.file_name,
          fileBytes: payload.summary.file_bytes,
          kind: payload.summary.kind,
          bounds: payload.summary.bounds ?? undefined,
          triangleCount: payload.summary.triangle_count ?? undefined,
          nodeCount: payload.summary.node_count ?? undefined,
          elementCount: payload.summary.element_count ?? undefined,
          boundaryFaceCount: payload.summary.boundary_face_count ?? undefined,
          note: payload.summary.note ?? undefined,
        };
      } catch (uploadError) {
        const text = await file.text();
        if (kind === "tet_mesh") {
          summary = parseMeshJsonSummary(file.name, file.size, JSON.parse(text));
        } else if (kind === "stl_surface") {
          summary = parseStlSummary(file.name, file.size, buffer, text);
        } else if (kind === "gmsh_mesh") {
          summary = parseMshSummary(file.name, file.size, text);
        } else {
          summary = {
            fileName: file.name,
            fileBytes: file.size,
            kind,
            note: "Backend upload failed, so the panel fell back to browser-only preview metadata.",
          };
        }
        summary.origin = "browser";
        if (uploadError instanceof Error) {
          summary.note = summary.note
            ? `${summary.note} ${uploadError.message}`
            : uploadError.message;
        }
      }
      const realizations = allowedRealizations(summary.kind);
      if (!realizations.includes(importTarget)) {
        setImportTarget(realizations[0]);
      }
      setImportedAsset(summary);
      setFeedback(
        summary.origin === "backend"
          ? `Imported ${file.name} into workspace asset store`
          : `Imported ${file.name} in browser preview mode`,
      );
    } catch (error) {
      setImportedAsset(null);
      setFeedback(error instanceof Error ? error.message : "Import failed");
    } finally {
      setIsImporting(false);
      event.target.value = "";
    }
  };

  const importedOptions = useMemo(() => {
    const realizations = importedAsset ? allowedRealizations(importedAsset.kind) : ["fdm", "fem"];
    return [
      {
        value: "fdm",
        label: "FDM voxelization",
        disabled: !realizations.includes("fdm"),
      },
      {
        value: "fem",
        label: "FEM tet mesh",
        disabled: !realizations.includes("fem"),
      },
    ];
  }, [importedAsset]);

  const importedSnippet = useMemo(() => {
    if (!importedAsset) {
      return null;
    }
    const assetPath = importedAsset.storedPath ?? importedAsset.fileName;
    if (importTarget === "fem") {
      return `mesh_path = "${assetPath}"\nfem = fm.FEM(order=${femOrder ?? 1}, hmax=${femHmax ?? 5e-9}, mesh=mesh_path)\nhints = fm.DiscretizationHints(fem=fem)`;
    }
    return `geom = fm.ImportedGeometry("${assetPath}")\nhints = fm.DiscretizationHints(fdm=fm.FDM(cell=(${cellSize?.[0] ?? 2e-9}, ${cellSize?.[1] ?? 2e-9}, ${cellSize?.[2] ?? 2e-9})))`;
  }, [cellSize, femHmax, femOrder, importTarget, importedAsset]);

  const importedVoxelEstimate = useMemo(() => {
    if (importTarget !== "fdm" || !importedAsset?.bounds || !cellSize || cellSize.length < 3) {
      return null;
    }
    const gridEstimate: [number, number, number] = [
      Math.max(1, Math.ceil(importedAsset.bounds.size[0] / cellSize[0])),
      Math.max(1, Math.ceil(importedAsset.bounds.size[1] / cellSize[1])),
      Math.max(1, Math.ceil(importedAsset.bounds.size[2] / cellSize[2])),
    ];
    return {
      grid: gridEstimate,
      totalCells: gridEstimate[0] * gridEstimate[1] * gridEstimate[2],
    };
  }, [cellSize, importTarget, importedAsset]);

  return (
    <Panel
      title="Mesh Operations"
      subtitle="Asset pipeline, solver counts, and export helpers for the active geometry realization."
      panelId="mesh-ops"
      eyebrow="Geometry IO"
      actions={<StatusBadge label={backend.toUpperCase()} tone="info" />}
    >
      <div style={{ display: "grid", gap: "1rem" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: "0.75rem",
          }}
        >
          <ReadonlyField label={primaryCountLabel} value={formatCount(primaryCount)} mono />
          <ReadonlyField label={secondaryCountLabel} value={formatCount(secondaryCount)} mono />
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: "0.75rem",
          }}
        >
          <ReadonlyField label="Source" value={sourceLabel ?? "—"} />
          <ReadonlyField label="Kind" value={sourceKind ?? "—"} mono />
          <ReadonlyField label="Realization" value={realizationLabel ?? "—"} />
        </div>

        {backend === "fdm" && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: "0.75rem",
            }}
          >
            <ReadonlyField
              label="dx"
              value={formatMeters(cellSize?.[0])}
              mono
            />
            <ReadonlyField
              label="dy"
              value={formatMeters(cellSize?.[1])}
              mono
            />
            <ReadonlyField
              label="dz"
              value={formatMeters(cellSize?.[2])}
              mono
            />
          </div>
        )}

        {backend === "fem" && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: "0.75rem",
            }}
          >
            <ReadonlyField label="FE order" value={femOrder ? `P${femOrder}` : "—"} />
            <ReadonlyField label="hmax" value={formatMeters(femHmax)} mono />
          </div>
        )}

        {sourcePath && (
          <div
            style={{
              display: "grid",
              gap: "0.5rem",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-subtle)",
              background: "rgba(255,255,255,0.03)",
              padding: "0.8rem 0.9rem",
            }}
          >
            <div
              style={{
                fontSize: "0.74rem",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "var(--text-3)",
              }}
            >
              Asset Path
            </div>
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
            <div style={{ display: "flex", gap: "0.55rem", flexWrap: "wrap" }}>
              <Button size="sm" variant="outline" onClick={() => onCopy(sourcePath, "Asset path")}>
                Copy path
              </Button>
              {artifactDir ? (
                <Button size="sm" variant="outline" onClick={() => onCopy(artifactDir, "Artifact dir")}>
                  Copy artifact dir
                </Button>
              ) : null}
            </div>
          </div>
        )}

        <div style={{ display: "grid", gap: "0.65rem" }}>
          <div
            style={{
              fontSize: "0.74rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: "var(--text-3)",
            }}
          >
            Local Import
          </div>
          <div
            style={{
              display: "grid",
              gap: "0.75rem",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-subtle)",
              background: "rgba(255,255,255,0.03)",
              padding: "0.9rem",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(200px, 260px)",
                gap: "0.75rem",
                alignItems: "end",
              }}
            >
              <label
                style={{
                  display: "grid",
                  gap: "0.45rem",
                  color: "var(--text-2)",
                  fontSize: "0.9rem",
                }}
              >
                <span style={{ fontWeight: 600 }}>Asset file</span>
                <input
                  type="file"
                  accept=".stl,.msh,.mesh.json,.json,.vtk,.vtu,.xdmf"
                  onChange={onImportFile}
                  style={{
                    borderRadius: "12px",
                    border: "1px solid var(--border-subtle)",
                    padding: "0.7rem 0.8rem",
                    background: "rgba(6,10,18,0.85)",
                    color: "var(--text-1)",
                  }}
                />
              </label>
              <SelectField
                label="Realization"
                value={importTarget}
                options={importedOptions}
                onchange={(value) => setImportTarget(value as LocalRealization)}
              />
            </div>

            {importedAsset ? (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
                    gap: "0.75rem",
                  }}
                >
                  <ReadonlyField label="Imported file" value={importedAsset.fileName} mono />
                  <ReadonlyField label="Format" value={importedAsset.kind} mono />
                  <ReadonlyField label="Size" value={formatBytes(importedAsset.fileBytes)} mono />
                  <ReadonlyField label="Target" value={importTarget === "fem" ? "FEM tet mesh" : "FDM voxelization"} />
                  <ReadonlyField label="Origin" value={importedAsset.origin === "backend" ? "workspace asset" : "browser fallback"} />
                </div>

                {importedAsset.assetId || importedAsset.storedPath ? (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(180px, 220px) minmax(0, 1fr)",
                      gap: "0.75rem",
                    }}
                  >
                    <ReadonlyField label="Asset id" value={importedAsset.assetId ?? "—"} mono />
                    <ReadonlyField label="Stored path" value={importedAsset.storedPath ?? "—"} mono />
                  </div>
                ) : null}

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                    gap: "0.75rem",
                  }}
                >
                  <ReadonlyField label="Triangles" value={formatCount(importedAsset.triangleCount)} mono />
                  <ReadonlyField label="Nodes" value={formatCount(importedAsset.nodeCount)} mono />
                  <ReadonlyField label="Elements" value={formatCount(importedAsset.elementCount)} mono />
                  <ReadonlyField label="Boundary faces" value={formatCount(importedAsset.boundaryFaceCount)} mono />
                </div>

                {importedAsset.bounds ? (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                      gap: "0.75rem",
                    }}
                  >
                    <ReadonlyField label="Size X" value={formatMeters(importedAsset.bounds.size[0])} mono />
                    <ReadonlyField label="Size Y" value={formatMeters(importedAsset.bounds.size[1])} mono />
                    <ReadonlyField label="Size Z" value={formatMeters(importedAsset.bounds.size[2])} mono />
                  </div>
                ) : null}

                {importedVoxelEstimate ? (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                      gap: "0.75rem",
                    }}
                  >
                    <ReadonlyField
                      label="Estimated FDM grid"
                      value={`${importedVoxelEstimate.grid[0]} × ${importedVoxelEstimate.grid[1]} × ${importedVoxelEstimate.grid[2]}`}
                      mono
                    />
                    <ReadonlyField
                      label="Estimated FDM cells"
                      value={formatCount(importedVoxelEstimate.totalCells)}
                      mono
                    />
                  </div>
                ) : null}

                {importedAsset.note ? (
                  <div
                    style={{
                      fontSize: "0.82rem",
                      color: "var(--text-2)",
                      lineHeight: 1.5,
                    }}
                  >
                    {importedAsset.note}
                  </div>
                ) : null}

                <div style={{ display: "flex", gap: "0.55rem", flexWrap: "wrap" }}>
                  {importedSnippet ? (
                    <Button
                      size="sm"
                      variant="subtle"
                      tone="accent"
                      onClick={() => onCopy(importedSnippet, "Import workflow snippet")}
                    >
                      Copy import workflow
                    </Button>
                  ) : null}
                  {importedAsset.storedPath ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onCopy(importedAsset.storedPath!, "Stored asset path")}
                    >
                      Copy stored path
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      downloadText(
                        `${importedAsset.fileName}.summary.json`,
                        JSON.stringify(
                          {
                            asset: importedAsset,
                            target_realization: importTarget,
                            voxel_estimate: importedVoxelEstimate,
                          },
                          null,
                          2,
                        ),
                        "application/json;charset=utf-8",
                      )
                    }
                  >
                    Download import summary
                  </Button>
                </div>
              </>
            ) : (
              <div
                style={{
                  fontSize: "0.84rem",
                  color: "var(--text-2)",
                  lineHeight: 1.5,
                }}
              >
                Import local `STL`, `MSH`, or `mesh.json` to create a persisted workspace asset and preview how it maps to `FDM voxelization` or `FEM tet mesh`. The backend stores the uploaded file under the current live workspace; browser-only fallback is used only if the API upload fails.
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "grid", gap: "0.65rem" }}>
          <div
            style={{
              fontSize: "0.74rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: "var(--text-3)",
            }}
          >
            Operations
          </div>
          <div style={{ display: "flex", gap: "0.55rem", flexWrap: "wrap" }}>
            {femImportSnippet ? (
              <Button size="sm" variant="subtle" tone="accent" onClick={() => onCopy(femImportSnippet, "FEM snippet")}>
                Copy FEM snippet
              </Button>
            ) : null}
            {fdmImportSnippet ? (
              <Button size="sm" variant="subtle" tone="accent" onClick={() => onCopy(fdmImportSnippet, "FDM snippet")}>
                Copy FDM snippet
              </Button>
            ) : null}
            {backend === "fem" && femMesh ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    downloadText(
                      `${sourceLabel ?? "mesh"}.mesh.json`,
                      JSON.stringify(
                        {
                          mesh_name: sourceLabel ?? "mesh",
                          nodes: femMesh.nodes,
                          elements: femMesh.elements,
                          boundary_faces: femMesh.boundary_faces,
                        },
                        null,
                        2,
                      ),
                      "application/json;charset=utf-8",
                    )
                  }
                >
                  Download mesh.json
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    downloadText(
                      `${sourceLabel ?? "mesh"}.stl`,
                      asciiStlFromMesh(femMesh, sourceLabel ?? "mesh"),
                      "model/stl;charset=utf-8",
                    )
                  }
                >
                  Download STL skin
                </Button>
              </>
            ) : null}
            {backend === "fdm" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  downloadText(
                    `${sourceLabel ?? "grid"}.grid.json`,
                    JSON.stringify(
                      {
                        grid,
                        cell_size: cellSize,
                        total_cells: totalCells,
                        active_cells: activeCells,
                        realization: realizationLabel,
                      },
                      null,
                      2,
                    ),
                    "application/json;charset=utf-8",
                  )
                }
              >
                Download grid summary
              </Button>
            ) : null}
          </div>
        </div>

        {interopTags.length > 0 && (
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {interopTags.map((tag) => (
              <StatusBadge key={tag} label={tag} tone="default" />
            ))}
          </div>
        )}

        {feedback || isImporting ? (
          <div
            style={{
              fontSize: "0.82rem",
              color: "var(--text-2)",
              borderTop: "1px solid var(--border-subtle)",
              paddingTop: "0.6rem",
            }}
          >
            {isImporting ? "Importing asset…" : feedback}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
