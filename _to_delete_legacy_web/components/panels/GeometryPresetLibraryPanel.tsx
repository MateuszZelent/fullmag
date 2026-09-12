"use client";

import { useMemo } from "react";
import { GEOMETRY_PRESET_CATALOG, type GeometryPresetKind } from "@/lib/geometryPresetCatalog";
import { cn } from "@/lib/utils";
import * as Icons from "lucide-react";

interface Props {
  selectedKind?: GeometryPresetKind | null;
  onSelectKind?: (kind: GeometryPresetKind) => void;
  onAssignPreset: (kind: GeometryPresetKind) => void;
}

export default function GeometryPresetLibraryPanel({
  selectedKind = null,
  onSelectKind,
  onAssignPreset,
}: Props) {
  const grouped = useMemo(() => {
    const groups = new Map<string, typeof GEOMETRY_PRESET_CATALOG>();
    for (const descriptor of GEOMETRY_PRESET_CATALOG) {
      const existing = groups.get(descriptor.category) ?? [];
      existing.push(descriptor);
      groups.set(descriptor.category, existing);
    }
    return Array.from(groups.entries());
  }, []);

  return (
    <div className="flex flex-col gap-2">
      {grouped.map(([category, descriptors]) => (
        <div key={category} className="mb-3">
          <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {category.replace(/_/g, " ")}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {descriptors.map((descriptor) => {
              const active = selectedKind === descriptor.kind;
              // @ts-expect-error - dynamic icon from lucide
              const Icon = Icons[descriptor.icon] ?? Icons.Box;

              return (
                <button
                  key={descriptor.kind}
                  type="button"
                  className={cn(
                    "flex flex-col items-start rounded-xl border px-3 py-3 text-left transition-colors",
                    active
                      ? "border-primary/35 bg-primary/10"
                      : "border-border/20 bg-background/35 hover:bg-background/50",
                  )}
                  onClick={() => onSelectKind?.(descriptor.kind)}
                  onDoubleClick={() => onAssignPreset(descriptor.kind)}
                >
                  <div className="flex items-center gap-2">
                    <Icon size={16} className={active ? "text-primary" : "text-muted-foreground"} />
                    <span className="text-sm font-medium text-foreground">
                      {descriptor.label}
                    </span>
                  </div>
                  {descriptor.description && (
                    <div className="mt-1.5 text-[0.65rem] text-muted-foreground leading-tight">
                      {descriptor.description}
                    </div>
                  )}
                  <div className="mt-2 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-primary">
                    Double click to assign
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
