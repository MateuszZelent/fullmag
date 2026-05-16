"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import type {
  FemMeshPart,
  MeshEntityViewState,
  MeshEntityViewStateMap,
  MeshQualityStats,
} from "../../../lib/session/types";
import { partMeshTint } from "./femColorUtils";
import { qualityToneClass, qualityLabel } from "./femQualityUtils";

/* ── Types ── */

export interface PartQualitySummary {
  markers: number[];
  domainCount: number;
  stats: MeshQualityStats | null;
}

function isPartVisible(part: FemMeshPart, viewState: MeshEntityViewState | undefined): boolean {
  return viewState?.visible ?? (part.role !== "air" && part.role !== "outer_boundary");
}

function visibilityButtonLabel(visible: boolean): string {
  return visible ? "Visible" : "Hidden";
}

interface FemPartExplorerPanelProps {
  meshParts: FemMeshPart[];
  meshEntityViewState: MeshEntityViewStateMap;
  partQualityById: Map<string, PartQualitySummary>;
  partExplorerGroups: { label: string; parts: FemMeshPart[] }[];
  roleVisibilitySummary: {
    role: FemMeshPart["role"];
    label: string;
    total: number;
    visible: number;
  }[];
  inspectedMeshPart: FemMeshPart | null;
  inspectedPartQuality: PartQualitySummary | null;
  selectedEntityId: string | null;
  focusedEntityId: string | null;
  visiblePartsCount: number;
  onClose: () => void;
  onPartSelect: (partId: string) => void;
  onEntityFocus?: (id: string | null) => void;
  onPatchPart: (partId: string, patch: Partial<MeshEntityViewState>) => void;
  onRoleVisibility: (role: FemMeshPart["role"], visible: boolean) => void;
  className?: string;
  headerAccessory?: ReactNode;
  dragHandleProps?: HTMLAttributes<HTMLElement>;
}

/* ── Part detail card ── */

function PartInspectorCard({
  part,
  quality,
  isFocused,
  viewState,
  onPatchPart,
  onEntityFocus,
}: {
  part: FemMeshPart;
  quality: PartQualitySummary | null;
  isFocused: boolean;
  viewState: MeshEntityViewState | undefined;
  onPatchPart: (patchArg: Partial<MeshEntityViewState>) => void;
  onEntityFocus?: (id: string | null) => void;
}) {
  const visible = isPartVisible(part, viewState);
  return (
    <div className="mb-3 rounded-2xl border border-primary/18 bg-primary/6 p-3">
      <div className="flex items-start gap-3">
        <button
          type="button"
          className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border border-white/15"
          style={{ backgroundColor: partMeshTint(part) }}
          onClick={() => onPatchPart({ visible: !visible })}
          title={visible ? "Hide part" : "Show part"}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.78rem] font-semibold text-foreground">
            {part.label || part.id}
          </div>
          <div className="mt-1 text-[0.64rem] text-muted-foreground">
            {part.role.replaceAll("_", " ")}
            {part.object_id ? ` · ${part.object_id}` : ""}
          </div>

          {/* Stats grid */}
          <div className="mt-2 grid grid-cols-3 gap-2 text-[0.66rem]">
            {(
              [
                { label: "Tetra", value: part.element_count },
                { label: "Nodes", value: part.node_count },
                { label: "Faces", value: part.boundary_face_count },
              ] as const
            ).map(({ label, value }) => (
              <div
                key={label}
                className="rounded-xl border border-border/18 bg-background/30 px-2.5 py-2"
              >
                <div className="text-muted-foreground">{label}</div>
                <div className="mt-1 font-mono text-foreground">{value.toLocaleString()}</div>
              </div>
            ))}
          </div>

          {/* Quality badges */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[0.58rem] font-semibold uppercase tracking-[0.14em]",
                qualityToneClass(quality?.stats ?? null),
              )}
            >
              {qualityLabel(quality?.stats ?? null)}
            </span>
            {quality?.markers.length ? (
              <span className="rounded-full border border-border/20 bg-background/35 px-2 py-0.5 text-[0.58rem] font-mono text-muted-foreground">
                markers {quality.markers.join(", ")}
              </span>
            ) : null}
            {quality?.domainCount ? (
              <span className="rounded-full border border-border/20 bg-background/35 px-2 py-0.5 text-[0.58rem] font-mono text-muted-foreground">
                {quality.domainCount} quality domain{quality.domainCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>

          {/* Quality metrics */}
          {quality?.stats ? (
            <div className="mt-2 grid grid-cols-2 gap-2 text-[0.64rem]">
              <div className="rounded-xl border border-emerald-400/12 bg-emerald-500/5 px-2.5 py-2">
                <div className="text-muted-foreground">Avg quality</div>
                <div className="mt-1 font-mono text-foreground">
                  {quality.stats.avg_quality.toFixed(3)}
                </div>
              </div>
              <div className="rounded-xl border border-border/18 bg-background/30 px-2.5 py-2">
                <div className="text-muted-foreground">SICN p5</div>
                <div className="mt-1 font-mono text-foreground">
                  {quality.stats.sicn_p5.toFixed(3)}
                </div>
              </div>
              <div className="rounded-xl border border-border/18 bg-background/30 px-2.5 py-2">
                <div className="text-muted-foreground">SICN mean</div>
                <div className="mt-1 font-mono text-foreground">
                  {quality.stats.sicn_mean.toFixed(3)}
                </div>
              </div>
              <div className="rounded-xl border border-border/18 bg-background/30 px-2.5 py-2">
                <div className="text-muted-foreground">Gamma min</div>
                <div className="mt-1 font-mono text-foreground">
                  {quality.stats.gamma_min.toFixed(3)}
                </div>
              </div>
            </div>
          ) : part.element_count > 0 ? (
            <div className="mt-2 rounded-xl border border-border/18 bg-background/30 px-2.5 py-2 text-[0.62rem] text-muted-foreground">
              Quality metrics not yet available. Enable quality extraction before rebuilding to
              inspect SICN and gamma.
            </div>
          ) : (
            <div className="mt-2 rounded-xl border border-border/18 bg-background/30 px-2.5 py-2 text-[0.62rem] text-muted-foreground">
              This part is surface-only — volume tetrahedron quality metrics do not apply.
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <button
            type="button"
            className={cn(
              "rounded-lg border px-2 py-1 text-[0.62rem] font-semibold transition-colors",
              visible
                ? "border-emerald-400/25 bg-emerald-500/12 text-emerald-100"
                : "border-border/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
            onClick={() => onPatchPart({ visible: !visible })}
          >
            {visibilityButtonLabel(visible)}
          </button>
          {onEntityFocus && (
            <button
              type="button"
              className={cn(
                "rounded-lg border px-2 py-1 text-[0.62rem] font-semibold transition-colors",
                isFocused
                  ? "border-cyan-400/30 bg-cyan-500/12 text-cyan-200"
                  : "border-border/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
              onClick={() => onEntityFocus(part.id)}
            >
              Focus
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Part list row ── */

function PartListRow({
  part,
  quality,
  isSelected,
  isFocused,
  viewState,
  onSelect,
  onPatchPart,
  onEntityFocus,
}: {
  part: FemMeshPart;
  quality: PartQualitySummary | null;
  isSelected: boolean;
  isFocused: boolean;
  viewState: MeshEntityViewState | undefined;
  onSelect: () => void;
  onPatchPart: (patch: Partial<MeshEntityViewState>) => void;
  onEntityFocus?: (id: string | null) => void;
}) {
  const tint = partMeshTint(part);
  const visible = isPartVisible(part, viewState);
  return (
    <div
      className={cn(
        "rounded-xl border px-2.5 py-2 transition-colors",
        isSelected
          ? "border-primary/28 bg-primary/8"
          : "border-border/18 bg-background/28 hover:bg-background/40",
      )}
    >
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          className="mt-0.5 h-3 w-3 shrink-0 rounded-full border border-white/15"
          style={{ backgroundColor: tint }}
          onClick={() => onPatchPart({ visible: !visible })}
          title={visible ? "Hide part" : "Show part"}
        />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect}>
          <div className="truncate text-[0.72rem] font-medium text-foreground">
            {part.label || part.id}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-2 text-[0.6rem] font-mono text-muted-foreground">
            <span>{part.element_count.toLocaleString()} el</span>
            <span>{part.node_count.toLocaleString()} n</span>
            {quality?.stats ? (
              <span>SICN p5 {quality.stats.sicn_p5.toFixed(2)}</span>
            ) : null}
            {part.object_id && <span>{part.object_id}</span>}
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            className={cn(
              "rounded-md border px-2 py-1 text-[0.6rem] font-semibold transition-colors",
              visible
                ? "border-emerald-400/25 bg-emerald-500/12 text-emerald-100"
                : "border-border/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
            onClick={() => onPatchPart({ visible: !visible })}
          >
            {visibilityButtonLabel(visible)}
          </button>
          {isSelected && onEntityFocus ? (
            <button
              type="button"
              className={cn(
                "rounded-md border px-2 py-1 text-[0.6rem] font-semibold transition-colors",
                isFocused
                  ? "border-cyan-400/30 bg-cyan-500/12 text-cyan-200"
                  : "border-border/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
              onClick={() => onEntityFocus(part.id)}
            >
              Focus
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ── Panel ── */

export function FemPartExplorerPanel(props: FemPartExplorerPanelProps) {
  const {
    meshParts,
    meshEntityViewState,
    partQualityById,
    partExplorerGroups,
    roleVisibilitySummary,
    inspectedMeshPart,
    inspectedPartQuality,
    selectedEntityId,
    focusedEntityId,
    visiblePartsCount,
    onClose,
    onPartSelect,
    onEntityFocus,
    onPatchPart,
    onRoleVisibility,
    className,
    headerAccessory,
    dragHandleProps,
  } = props;
  const headerLabel = inspectedMeshPart
    ? "Selected submesh"
    : "Mesh parts";

  return (
    <div className={cn("w-full max-w-[264px] max-h-[calc(100%-7rem)] overflow-hidden rounded-2xl border border-border/30 bg-background/88 shadow-xl backdrop-blur-md", className)}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/25 px-3 py-2.5">
        <div>
          <p className="text-[0.62rem] font-semibold tracking-[0.12em] text-muted-foreground">
            {headerLabel}
          </p>
          <p className="text-[0.78rem] font-medium text-foreground">
            {visiblePartsCount}/{meshParts.length} visible parts
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dragHandleProps ? (
            <div {...dragHandleProps}>
              Move
            </div>
          ) : null}
          {headerAccessory}
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[0.65rem] font-semibold text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            onClick={onClose}
          >
            Hide
          </button>
        </div>
      </div>

      {/* Role visibility toggles */}
      <div className="border-b border-border/20 px-3 py-2.5">
        <div className="flex flex-wrap gap-1.5">
          {roleVisibilitySummary.map((entry) => (
            <button
              key={entry.role}
              type="button"
              className="rounded-full border border-border/25 px-2.5 py-1 text-[0.62rem] font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              onClick={() => onRoleVisibility(entry.role, entry.visible !== entry.total)}
            >
              {entry.label} {entry.visible}/{entry.total}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="max-h-[calc(100%-7.5rem)] overflow-y-auto px-3 py-3">
        {/* Selected part inspector */}
        {inspectedMeshPart ? (
          <PartInspectorCard
            part={inspectedMeshPart}
            quality={inspectedPartQuality}
            isFocused={focusedEntityId === inspectedMeshPart.id}
            viewState={meshEntityViewState[inspectedMeshPart.id]}
            onPatchPart={(patch) => onPatchPart(inspectedMeshPart.id, patch)}
            onEntityFocus={onEntityFocus}
          />
        ) : null}

        {/* Part groups */}
        {partExplorerGroups.map((group) => (
          <div key={group.label} className="mb-3">
            <div className="px-1 pb-1.5 text-[0.64rem] font-semibold text-muted-foreground">
              {group.label}
            </div>
            <div className="space-y-1">
              {group.parts.map((part) => (
                <PartListRow
                  key={part.id}
                  part={part}
                  quality={partQualityById.get(part.id) ?? null}
                  isSelected={selectedEntityId === part.id}
                  isFocused={focusedEntityId === part.id}
                  viewState={meshEntityViewState[part.id]}
                  onSelect={() => onPartSelect(part.id)}
                  onPatchPart={(patch) => onPatchPart(part.id, patch)}
                  onEntityFocus={onEntityFocus}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
