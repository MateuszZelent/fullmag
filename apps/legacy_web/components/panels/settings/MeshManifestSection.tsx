"use client";

import { AlertTriangle, CheckCircle2, Layers } from "lucide-react";

import type { MeshWorkspaceSharedDomainManifestState } from "@/lib/session/types";

import { SidebarSection } from "./primitives";

interface MeshManifestSectionProps {
  manifest: MeshWorkspaceSharedDomainManifestState | null | undefined;
  currentSceneRevision: number | null | undefined;
  objectId?: string | null;
}

export default function MeshManifestSection({
  manifest,
  currentSceneRevision,
  objectId = null,
}: MeshManifestSectionProps) {
  if (!manifest) {
    return (
      <SidebarSection title="Mesh Manifest" icon="▦" badge="missing" defaultOpen={false}>
        <div className="rounded-lg border border-dashed border-border/10 bg-card/40 px-3 py-2 text-[0.74rem] leading-relaxed text-muted-foreground">
          No shared-domain mesh manifest is available yet. Build the mesh/grid to materialize
          scene-revision provenance and region mappings.
        </div>
      </SidebarSection>
    );
  }

  const stale =
    currentSceneRevision != null &&
    manifest.source_scene_revision != null &&
    currentSceneRevision !== manifest.source_scene_revision;
  const regions = objectId
    ? manifest.regions.filter((region) => region.source_object_ids.includes(objectId))
    : manifest.regions;

  return (
    <SidebarSection
      title={objectId ? "Object Mesh Manifest" : "Mesh Manifest"}
      icon="▦"
      badge={stale ? "stale" : "current"}
      defaultOpen={true}
    >
      <div
        className={[
          "flex items-start gap-2 rounded-xl border px-3 py-2.5 text-[0.74rem] leading-relaxed",
          stale
            ? "border-warning/25 bg-warning/10 text-warning/90"
            : "border-success/25 bg-success/10 text-success/90",
        ].join(" ")}
      >
        {stale ? <AlertTriangle size={15} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={15} className="mt-0.5 shrink-0" />}
        <div>
          {stale
            ? "This mesh was built from an older scene revision. Build mesh before compute."
            : "This mesh manifest matches the current scene revision."}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <ManifestTile label="Scene rev" value={manifest.source_scene_revision ?? "—"} />
        <ManifestTile label="Current rev" value={currentSceneRevision ?? "—"} />
        <ManifestTile label="Realization rev" value={manifest.geometry_realization_revision ?? "—"} />
        <ManifestTile label="Mode" value={manifest.domain_mesh_mode ?? "—"} />
        <ManifestTile label="Object segments" value={manifest.object_segment_count} />
        <ManifestTile label="Mesh parts" value={manifest.mesh_part_count} />
      </div>

      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2 text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
          <span>Regions</span>
          <span className="font-mono">{regions.length}</span>
        </div>
        {regions.length > 0 ? (
          regions.map((region) => (
            <div
              key={region.region_id}
              className="grid gap-1.5 rounded-lg border border-border/10 bg-card/40 px-3 py-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Layers size={13} className="shrink-0 text-primary/75" />
                  <span className="truncate font-mono text-xs text-foreground">{region.name}</span>
                </div>
                <span className="shrink-0 rounded-md border border-border/10 bg-card/40 px-1.5 py-0.5 font-mono text-[0.58rem] text-muted-foreground">
                  {region.region_id}
                </span>
              </div>
              <div className="grid grid-cols-[88px_1fr] gap-x-2 gap-y-1 text-[0.68rem]">
                <span className="font-semibold uppercase tracking-wider text-muted-foreground">Objects</span>
                <span className="truncate font-mono text-foreground/85">
                  {region.source_object_ids.length > 0 ? region.source_object_ids.join(", ") : "—"}
                </span>
                <span className="font-semibold uppercase tracking-wider text-muted-foreground">Material</span>
                <span className="truncate font-mono text-foreground/85">{region.material_ref || "—"}</span>
                <span className="font-semibold uppercase tracking-wider text-muted-foreground">Parts</span>
                <span className="truncate font-mono text-foreground/85">
                  {region.mesh_part_ids.length > 0 ? region.mesh_part_ids.join(", ") : "—"}
                </span>
                <span className="font-semibold uppercase tracking-wider text-muted-foreground">Elements</span>
                <span className="font-mono text-foreground/85">
                  {region.element_count != null ? region.element_count.toLocaleString() : "—"}
                </span>
              </div>
            </div>
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-border/10 bg-card/40 px-3 py-2 text-[0.74rem] text-muted-foreground">
            {objectId
              ? "No manifest region is mapped to this object."
              : "No mesh regions are reported by the current manifest."}
          </div>
        )}
      </div>
    </SidebarSection>
  );
}

function ManifestTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="grid gap-1 rounded-lg border border-border/10 bg-card/40 px-2.5 py-2">
      <span className="text-[0.6rem] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <span className="truncate font-mono text-xs text-foreground">{String(value)}</span>
    </div>
  );
}
