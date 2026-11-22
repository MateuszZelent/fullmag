"use client";

import { BookOpen, Database, Plus, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { Input } from "@/shared/ui/Input";

import { ELECTRON_GAMMA_PER_G } from "../../../panels/model-roots/SpecInspectorHost";
import type { InspectorActionContext } from "../../../template";
import {
  type BuiltInReferenceMaterial,
  REFERENCE_MATERIALS_CATALOG,
  suggestNewMaterialId,
  type UnifiedObjectMaterialDraft,
} from "./materialShared";

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
  const filteredPresets = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return REFERENCE_MATERIALS_CATALOG;
    return REFERENCE_MATERIALS_CATALOG.filter(
      (preset) =>
        preset.name.toLowerCase().includes(q) || preset.id.toLowerCase().includes(q),
    );
  }, [query]);

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
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent
          className="sm:max-w-md"
          data-slot="reference-materials-popover"
        >
          <DialogHeader>
            <DialogTitle>Assign Reference Material</DialogTitle>
            <DialogDescription>
              Select a curated micromagnetic standard to stage on this object. Relevant physics interactions (exchange, demag, anisotropy, DMI) activate automatically on Apply.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Input
              aria-label="Filter reference materials"
              placeholder="Filter materials (Permalloy, CoFeB, YIG, Co/Pt…)"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto pr-1">
              {filteredPresets.map((preset) => (
                <Button
                  key={preset.id}
                  className="flex h-auto w-full items-center justify-between rounded-md border border-transparent px-2.5 py-2 text-left text-xs text-[var(--fm-text)] hover:border-[var(--fm-border)] hover:bg-[var(--fm-surface-3)]"
                  data-preset-id={preset.id}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => applyPreset(preset)}
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">{preset.name}</span>
                    <span className="font-mono text-xs text-[var(--fm-text-muted)]">
                      {preset.ms > 0
                        ? `Ms ${(preset.ms / 1e3).toFixed(0)} kA/m · Aex ${(preset.aex * 1e12).toFixed(1)} pJ/m${Math.abs(preset.ku1) > 0 ? ` · Ku1 ${(preset.ku1 / 1e3).toFixed(0)} kJ/m³` : ""}${preset.dind !== 0 ? ` · Dind ${(preset.dind * 1e3).toFixed(1)} mJ/m²` : ""}`
                        : `σ ${(preset.sigma / 1e6).toFixed(1)} MS/m`}
                    </span>
                  </span>
                </Button>
              ))}
              {filteredPresets.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-[var(--fm-text-muted)]">
                  No reference materials match “{query}”.
                </p>
              ) : null}
            </div>
          </div>
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
