"use client";

import { useState } from "react";

import {
  canonicalPresetKind,
  MAGNETIZATION_TEXTURE_CATEGORIES,
  MAGNETIZATION_TEXTURE_PRESETS,
  type MagnetizationTextureCategoryId,
  type MagnetizationTexturePresetId,
} from "@/shared/domain/magnetization-texture/texturePresets";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/ToggleGroup";
import { cn } from "@/shared/utils/className";

import { PresetTileIcon } from "./PresetTileIcons";

export interface PresetGalleryProps {
  value: MagnetizationTexturePresetId;
  disabled?: boolean;
  onSelect: (presetId: MagnetizationTexturePresetId) => void;
}

export function PresetGallery({
  value,
  disabled = false,
  onSelect,
}: PresetGalleryProps) {
  const [activeCategory, setActiveCategory] = useState<MagnetizationTextureCategoryId>("all");
  const normalizedSelected = canonicalPresetKind(value);

  const visiblePresets =
    activeCategory === "all"
      ? MAGNETIZATION_TEXTURE_PRESETS
      : MAGNETIZATION_TEXTURE_PRESETS.filter((preset) => preset.category === activeCategory);

  return (
    <div className="grid min-w-0 gap-2" data-slot="magnetic-preset-gallery">
      {/* 5 category tabs + All (pure UI filter, never dirties staged draft) */}
      <ToggleGroup
        aria-label="Filter texture presets by physical family"
        className="flex flex-wrap gap-1"
        disabled={disabled}
        size="sm"
        type="single"
        value={activeCategory}
        variant="outline"
        onValueChange={(next) => {
          if (next) {
            setActiveCategory(next as MagnetizationTextureCategoryId);
          }
        }}
      >
        {MAGNETIZATION_TEXTURE_CATEGORIES.map((category) => (
          <ToggleGroupItem
            key={category.id}
            className="rounded-full px-2.5 py-1 text-xs font-medium"
            data-preset-category={category.id}
            value={category.id}
          >
            {category.shortLabel}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {/* Accessible roving tile grid of 20 vector SVG presets */}
      <ToggleGroup
        aria-label="Magnetic texture preset"
        className="grid grid-cols-2 @[20rem]/insp:grid-cols-3 @[26rem]/insp:grid-cols-4 gap-1.5"
        disabled={disabled}
        type="single"
        value={normalizedSelected}
        onValueChange={(next) => {
          if (next) {
            onSelect(next as MagnetizationTexturePresetId);
          }
        }}
      >
        {visiblePresets.map((preset) => {
          const isSelected = normalizedSelected === preset.id;
          return (
            <ToggleGroupItem
              key={preset.id}
              className={cn(
                "flex min-h-[68px] flex-col items-center justify-center gap-1 rounded-xl border px-1.5 py-1.5 text-center transition-all",
                isSelected
                  ? "border-[var(--fm-hue-material)] bg-[color-mix(in_oklab,var(--fm-hue-material)_9%,var(--fm-bg-panel-raised))] text-fm-primary shadow-sm"
                  : "border-fm-subtle bg-fm-field text-fm-secondary hover:border-fm-control-border hover:text-fm-primary",
              )}
              data-preset-tile={preset.id}
              value={preset.id}
            >
              <PresetTileIcon presetKind={preset.id} size={36} />
              <span className="text-xs font-medium leading-tight">{preset.label}</span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
    </div>
  );
}
