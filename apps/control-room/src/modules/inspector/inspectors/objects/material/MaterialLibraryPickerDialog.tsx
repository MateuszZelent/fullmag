"use client";

import { BookOpen, Database, Plus, Search, Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { Input } from "@/shared/ui/Input";

import { ELECTRON_GAMMA_PER_G } from "../../../panels/model-roots/SpecInspectorHost";
import type { InspectorActionContext } from "../../../template";
import {
  type BuiltInReferenceMaterial,
  computeExchangeLengthMeters,
  REFERENCE_MATERIALS_CATALOG,
  suggestNewMaterialId,
  type UnifiedObjectMaterialDraft,
} from "./materialShared";

type PickerCategory =
  | "all"
  | "ferromagnets"
  | "perpendicular-dmi"
  | "low-damping"
  | "conductors";

const PICKER_CATEGORIES: readonly { readonly id: PickerCategory; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "ferromagnets", label: "Ferromagnets" },
  { id: "perpendicular-dmi", label: "Perpendicular / DMI" },
  { id: "low-damping", label: "Low-Damping" },
  { id: "conductors", label: "Conductors" },
];

function matchesCategory(
  preset: BuiltInReferenceMaterial,
  category: PickerCategory,
): boolean {
  switch (category) {
    case "all":
      return true;
    case "ferromagnets":
      return preset.ms > 0;
    case "perpendicular-dmi":
      return (
        preset.ms > 0 &&
        (Math.abs(preset.ku1) > 0 || preset.dind !== 0 || preset.dbulk !== 0)
      );
    case "low-damping":
      return preset.ms > 0 && preset.alpha > 0 && preset.alpha <= 0.005;
    case "conductors":
      return preset.ms <= 0;
  }
}

function resolvePresetBadge(preset: BuiltInReferenceMaterial): {
  label: string;
  variant: "secondary" | "accent" | "default";
} {
  if (preset.ms <= 0) {
    return { label: "Conductor", variant: "default" };
  }
  if (preset.dind !== 0 || preset.dbulk !== 0) {
    return { label: "Chiral / DMI", variant: "accent" };
  }
  if (Math.abs(preset.ku1) > 0) {
    return { label: "Uniaxial / PMA", variant: "accent" };
  }
  if (preset.alpha > 0 && preset.alpha <= 0.001) {
    return { label: "Low-α Ferrimagnet", variant: "secondary" };
  }
  return { label: "Ferromagnet", variant: "secondary" };
}

function formatAlpha(alpha: number): string {
  if (alpha < 0.001) return alpha.toFixed(4);
  if (alpha < 0.01) return alpha.toFixed(3);
  return alpha.toFixed(3).replace(/0$/, "");
}

function formatParamPills(
  preset: BuiltInReferenceMaterial,
): readonly { readonly symbol: string; readonly value: string }[] {
  if (preset.ms <= 0) {
    return [
      { symbol: "σ", value: `${(preset.sigma / 1e6).toFixed(2)} MS/m` },
      { symbol: "ρ", value: `${preset.density.toLocaleString("en-US")} kg/m³` },
    ];
  }

  const pills: { symbol: string; value: string }[] = [
    { symbol: "Ms", value: `${(preset.ms / 1e3).toFixed(0)} kA/m` },
    { symbol: "Aex", value: `${(preset.aex * 1e12).toFixed(1)} pJ/m` },
    { symbol: "α", value: formatAlpha(preset.alpha) },
  ];
  if (Math.abs(preset.ku1) > 0) {
    pills.push({ symbol: "Ku1", value: `${(preset.ku1 / 1e3).toFixed(0)} kJ/m³` });
  }
  if (preset.dind !== 0) {
    pills.push({ symbol: "Dind", value: `${(preset.dind * 1e3).toFixed(1)} mJ/m²` });
  }
  if (Math.abs(preset.kc1) > 0) {
    pills.push({ symbol: "Kc1", value: `${(preset.kc1 / 1e3).toFixed(1)} kJ/m³` });
  }
  return pills;
}

export interface MaterialLibraryPickerDialogProps {
  readonly ctx: InspectorActionContext<UnifiedObjectMaterialDraft>;
  readonly existingIds: ReadonlySet<string>;
  readonly hasActiveModelMaterial: boolean;
  readonly onOpenFullCatalog: () => void;
}

export function MaterialLibraryPickerDialog({
  ctx,
  existingIds,
  hasActiveModelMaterial,
  onOpenFullCatalog,
}: MaterialLibraryPickerDialogProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<PickerCategory>("all");

  const filteredPresets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return REFERENCE_MATERIALS_CATALOG.filter((preset) => {
      if (!matchesCategory(preset, activeCategory)) return false;
      if (!q) return true;
      return (
        preset.name.toLowerCase().includes(q) ||
        preset.id.toLowerCase().includes(q) ||
        preset.category.toLowerCase().includes(q)
      );
    });
  }, [activeCategory, query]);

  const closePicker = () => {
    setPickerOpen(false);
  };

  const applyPreset = (preset: BuiltInReferenceMaterial) => {
    const generatedId = suggestNewMaterialId(
      `${preset.id}-${ctx.draft.objectId || "obj"}`,
      existingIds,
    );
    const hasPositiveMs = preset.ms > 0;
    ctx.patchDraft({
      materialId: generatedId,
      newMaterialId: generatedId,
      materialName: preset.name,
      pendingNewMaterial: true,
      msSet: hasPositiveMs,
      ms: preset.ms,
      aexSet: hasPositiveMs || preset.aex > 0,
      aex: preset.aex,
      alpha: preset.alpha,
      landeG: preset.landeG,
      gamma: preset.landeG * ELECTRON_GAMMA_PER_G,
      uniaxialEnabled: Math.abs(preset.ku1) > 0 || Math.abs(preset.ku2) > 0,
      ku1: preset.ku1,
      ku2: preset.ku2,
      cubicEnabled: Math.abs(preset.kc1) > 0 || Math.abs(preset.kc2) > 0,
      kc1: preset.kc1,
      kc2: preset.kc2,
      dindSet: preset.dind !== 0,
      dind: preset.dind,
      dbulkSet: preset.dbulk !== 0,
      dbulk: preset.dbulk,
      sigma: preset.sigma,
      density: preset.density,
    });
    setQuery("");
    setActiveCategory("all");
    setPickerOpen(false);
  };

  return (
    <div className="flex flex-wrap gap-1.5" data-slot="material-assignment-actions">
      <Button
        size="sm"
        type="button"
        variant="secondary"
        onClick={() => setPickerOpen(true)}
      >
        <Sparkles aria-hidden="true" size={12} />
        <span>Assign from Library</span>
      </Button>
      <Dialog
        open={pickerOpen}
        onOpenChange={(next) => {
          setPickerOpen(next);
          if (!next) {
            setQuery("");
            setActiveCategory("all");
          }
        }}
      >
        <DialogContent
          className="gap-0 p-0 sm:max-w-2xl w-[min(672px,calc(100vw-2rem))]"
          data-slot="reference-materials-popover"
        >
          <DialogHeader className="relative border-b border-[var(--fm-border-subtle)] bg-[var(--fm-bg-panel)] px-5 py-4 pr-12">
            <div className="flex items-center gap-2">
              <Sparkles
                aria-hidden="true"
                className="shrink-0 text-[var(--fm-accent-text)]"
                size={15}
              />
              <DialogTitle>Assign Reference Material</DialogTitle>
            </div>
            <DialogDescription className="text-xs text-[var(--fm-text-muted)]">
              Stage a curated micromagnetic standard on this object. Click Apply in the Material inspector to commit.
            </DialogDescription>
            <Button
              aria-label="Close reference material picker"
              className="absolute top-3.5 right-3.5"
              size="icon"
              type="button"
              variant="ghost"
              onClick={closePicker}
            >
              <X aria-hidden="true" size={14} />
            </Button>
          </DialogHeader>

          <div className="flex flex-col gap-3 px-5 py-4">
            <div className="flex flex-col gap-2.5">
              <div className="relative flex items-center">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-2.5 text-[var(--fm-text-muted)]"
                  size={14}
                />
                <Input
                  aria-label="Filter reference materials"
                  className="w-full pl-8 pr-8"
                  placeholder="Filter materials (Permalloy, CoFeB, YIG, Cobalt, Pt…)"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query ? (
                  <Button
                    aria-label="Clear filter"
                    className="absolute right-1 h-6 w-6"
                    size="icon"
                    type="button"
                    variant="ghost"
                    onClick={() => setQuery("")}
                  >
                    <X aria-hidden="true" size={12} />
                  </Button>
                ) : null}
              </div>

              <div
                aria-label="Material categories"
                className="flex flex-wrap items-center justify-between gap-2"
                role="group"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  {PICKER_CATEGORIES.map((category) => {
                    const active = activeCategory === category.id;
                    return (
                      <Button
                        key={category.id}
                        aria-pressed={active}
                        className={
                          active
                            ? "h-7 rounded-full border border-[var(--fm-accent)] bg-[var(--fm-accent-soft)] px-2.5 text-xs font-medium text-[var(--fm-accent-text)] hover:bg-[var(--fm-accent-soft)]"
                            : "h-7 rounded-full border border-[var(--fm-border-subtle)] bg-[var(--fm-bg-panel)] px-2.5 text-xs font-normal text-[var(--fm-text-secondary)] hover:border-[var(--fm-border-default)] hover:bg-[var(--fm-bg-hover)] hover:text-[var(--fm-text-primary)]"
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={() => setActiveCategory(category.id)}
                      >
                        {category.label}
                      </Button>
                    );
                  })}
                </div>
                <span className="font-mono text-xs tabular-nums text-[var(--fm-text-muted)]">
                  {filteredPresets.length}{" "}
                  {filteredPresets.length === 1 ? "material" : "materials"}
                </span>
              </div>
            </div>

            <div className="flex max-h-[400px] flex-col gap-2 overflow-y-auto pr-1">
              {filteredPresets.map((preset) => {
                const badge = resolvePresetBadge(preset);
                const lexMeters = computeExchangeLengthMeters(preset.ms, preset.aex);
                const paramPills = formatParamPills(preset);

                return (
                  <Button
                    key={preset.id}
                    className="flex h-auto w-full flex-col items-stretch justify-start gap-2 rounded-lg border border-[var(--fm-border-subtle)] bg-[var(--fm-bg-panel)] px-3.5 py-2.5 text-left transition-colors hover:border-[var(--fm-border-control)] hover:bg-[var(--fm-bg-elevated)] focus-visible:border-[var(--fm-accent)]"
                    data-preset-id={preset.id}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => applyPreset(preset)}
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-semibold text-[var(--fm-text-primary)]">
                          {preset.name}
                        </span>
                        <Badge className="shrink-0" variant={badge.variant}>
                          {badge.label}
                        </Badge>
                      </span>
                      {lexMeters !== null ? (
                        <span className="shrink-0 rounded border border-[var(--fm-border-subtle)] bg-[var(--fm-field-bg)] px-2 py-0.5 font-mono text-xs tabular-nums text-[var(--fm-accent-text)]">
                          l_ex {(lexMeters * 1e9).toFixed(1)} nm
                        </span>
                      ) : (
                        <span className="shrink-0 rounded border border-[var(--fm-border-subtle)] bg-[var(--fm-field-bg)] px-2 py-0.5 font-mono text-xs tabular-nums text-[var(--fm-text-secondary)]">
                          Non-magnetic
                        </span>
                      )}
                    </span>

                    <span className="flex w-full flex-wrap items-center gap-1.5">
                      {paramPills.map((pill) => (
                        <span
                          key={pill.symbol}
                          className="inline-flex items-baseline gap-1 rounded border border-[var(--fm-border-muted)] bg-[var(--fm-field-bg)] px-2 py-0.5 font-mono text-xs tabular-nums"
                        >
                          <span className="text-[var(--fm-text-muted)]">
                            {pill.symbol}
                          </span>
                          <span className="font-medium text-[var(--fm-text-primary)]">
                            {pill.value}
                          </span>
                        </span>
                      ))}
                    </span>
                  </Button>
                );
              })}

              {filteredPresets.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--fm-border-subtle)] bg-[var(--fm-bg-panel)] px-4 py-8 text-center">
                  <p className="text-xs text-[var(--fm-text-muted)]">
                    No reference materials match the current filter
                    {query.trim() ? ` “${query.trim()}”` : ""}.
                  </p>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setQuery("");
                      setActiveCategory("all");
                    }}
                  >
                    Reset filters
                  </Button>
                </div>
              ) : null}
            </div>
          </div>

          <DialogFooter className="items-center justify-between border-t border-[var(--fm-border-subtle)] bg-[var(--fm-bg-panel)] px-5 py-3">
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                closePicker();
                onOpenFullCatalog();
              }}
            >
              <BookOpen aria-hidden="true" size={13} />
              <span>Open Full Material Database…</span>
            </Button>
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={closePicker}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Button
        size="sm"
        type="button"
        variant="secondary"
        onClick={() => {
          const newId = suggestNewMaterialId(
            `custom-${ctx.draft.objectId || "mat"}`,
            existingIds,
          );
          ctx.patchDraft({
            materialId: newId,
            newMaterialId: newId,
            materialName: `Custom (${ctx.draft.objectName})`,
            pendingNewMaterial: true,
          });
        }}
      >
        <Plus aria-hidden="true" size={12} />
        <span>Create Custom</span>
      </Button>

      <Button size="sm" type="button" variant="ghost" onClick={onOpenFullCatalog}>
        <BookOpen aria-hidden="true" size={12} />
        <span>Open Full Catalog</span>
      </Button>

      {hasActiveModelMaterial ? (
        <Button size="sm" type="button" variant="ghost" onClick={onOpenFullCatalog}>
          <Database aria-hidden="true" size={12} />
          <span>Save copy to database</span>
        </Button>
      ) : null}
    </div>
  );
}
