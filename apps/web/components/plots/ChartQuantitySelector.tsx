"use client";

/**
 * ChartQuantitySelector — premium header bar for the Charts viewport.
 *
 * Layout:
 * ┌───────────────────────────────────────────────────────────────┐
 * │ [Scope ▾]  Presets: [Energy] [M avg] [Conv] [Δt] [All]      │
 * │ X: [time ▾]   Y: [+ Add]   [badge ✕] [badge ✕] …           │
 * └───────────────────────────────────────────────────────────────┘
 *
 * Accepts dynamic `quantityGroups` built from backend QuantityDescriptor[],
 * falling back to the static catalog when groups are empty.
 */

import { useCallback, useMemo, useState } from "react";
import { Plus, X, ChevronDown, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  type ChartPresetId,
  type ChartState,
  type ChartQuantityGroup,
  CHART_PRESETS,
  FALLBACK_QUANTITY_GROUPS,
  PRESET_ORDER,
  X_AXIS_OPTIONS,
  resolveSeriesEntry,
  seriesColor,
} from "./chartTypes";

// ── Types ────────────────────────────────────────────────────────

interface DomainOption {
  id: string;
  name: string;
}

interface ChartQuantitySelectorProps {
  /** Available ferromagnet objects for domain filtering */
  domains: DomainOption[];
  /** Current chart state */
  chartState: ChartState;
  /** State updater */
  onStateChange: (
    next: ChartState | ((prev: ChartState) => ChartState),
  ) => void;
  /**
   * Dynamically-resolved quantity groups from backend QuantityDescriptor[].
   * Falls back to FALLBACK_QUANTITY_GROUPS when undefined or empty.
   */
  quantityGroups?: ChartQuantityGroup[];
}

// ── Component ────────────────────────────────────────────────────

export default function ChartQuantitySelector({
  domains,
  chartState,
  onStateChange,
  quantityGroups,
}: ChartQuantitySelectorProps) {
  const [addPopoverOpen, setAddPopoverOpen] = useState(false);
  const multiDomain = domains.length > 1;

  // Use dynamic groups when available, otherwise fallback
  const effectiveGroups = useMemo(
    () =>
      quantityGroups && quantityGroups.length > 0
        ? quantityGroups
        : (FALLBACK_QUANTITY_GROUPS as unknown as ChartQuantityGroup[]),
    [quantityGroups],
  );

  // ── Handlers ─────────────────────────────────────────────────

  const handlePreset = useCallback(
    (presetId: ChartPresetId) => {
      onStateChange((prev) => ({
        ...prev,
        activeSeriesKeys: [...CHART_PRESETS[presetId].yColumns],
        activePreset: presetId,
      }));
    },
    [onStateChange],
  );

  const handleXColumnChange = useCallback(
    (value: string) => {
      onStateChange((prev) => ({ ...prev, xColumn: value }));
    },
    [onStateChange],
  );

  const handleDomainChange = useCallback(
    (value: string) => {
      onStateChange((prev) => ({
        ...prev,
        selectedDomain: value === "__all__" ? null : value,
      }));
    },
    [onStateChange],
  );

  const handleAddSeries = useCallback(
    (key: string) => {
      onStateChange((prev) => {
        if (prev.activeSeriesKeys.includes(key)) return prev;
        return {
          ...prev,
          activeSeriesKeys: [...prev.activeSeriesKeys, key],
          activePreset: null, // custom selection breaks preset
        };
      });
      setAddPopoverOpen(false);
    },
    [onStateChange],
  );

  const handleRemoveSeries = useCallback(
    (key: string) => {
      onStateChange((prev) => ({
        ...prev,
        activeSeriesKeys: prev.activeSeriesKeys.filter((k) => k !== key),
        activePreset: null,
      }));
    },
    [onStateChange],
  );

  // ── Available (not-yet-added) quantities ─────────────────────

  const availableGroups = useMemo(() => {
    const activeSet = new Set(chartState.activeSeriesKeys);
    return effectiveGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => !activeSet.has(item.key)),
      }))
      .filter((group) => group.items.length > 0);
  }, [chartState.activeSeriesKeys, effectiveGroups]);

  const hasAvailable = availableGroups.length > 0;

  // ── Render ───────────────────────────────────────────────────

  return (
    <div className="shrink-0 border-b border-border/30 bg-card/30">
      {/* Row 1: Scope + Presets */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border/15">
        {/* Scope selector */}
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <Select
                  value={chartState.selectedDomain ?? "__all__"}
                  onValueChange={handleDomainChange}
                  disabled={!multiDomain}
                >
                  <SelectTrigger
                    className={cn(
                      "h-7 w-[160px] text-[0.7rem] bg-muted/30 border-border/40",
                      !multiDomain && "opacity-60 cursor-default",
                    )}
                  >
                    <SelectValue placeholder="Scope" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">
                      {multiDomain ? "Universe (all)" : "Universe"}
                    </SelectItem>
                    {domains.map((domain) => (
                      <SelectItem key={domain.id} value={domain.id}>
                        {domain.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </TooltipTrigger>
            {!multiDomain && (
              <TooltipContent side="bottom" className="max-w-[260px] text-xs">
                <p className="font-semibold mb-0.5">Scope: Universe</p>
                <p className="text-muted-foreground">
                  Per-ferromagnet data will be available when multi-domain
                  simulations emit per-object scalar aggregates.
                </p>
              </TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>

        {/* Separator */}
        <div className="h-4 w-px bg-border/30" />

        {/* Preset pills */}
        <div className="flex items-center gap-1">
          <span className="text-[0.6rem] font-semibold uppercase tracking-widest text-muted-foreground/60 mr-0.5">
            Presets
          </span>
          {PRESET_ORDER.map((presetId) => {
            const preset = CHART_PRESETS[presetId];
            const isActive = chartState.activePreset === presetId;
            return (
              <Button
                key={presetId}
                variant={isActive ? "default" : "outline"}
                size="sm"
                className={cn(
                  "h-6 px-2.5 text-[0.65rem] font-semibold tracking-wide transition-all",
                  isActive
                    ? "bg-primary/90 text-primary-foreground shadow-sm shadow-primary/25"
                    : "bg-muted/20 border-border/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
                onClick={() => handlePreset(presetId)}
              >
                <span className="mr-1">{preset.icon}</span>
                {preset.label}
              </Button>
            );
          })}
        </div>
      </div>

      {/* Row 2: X-axis + Y-axis add + active badges */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        {/* X-axis */}
        <div className="flex items-center gap-1.5">
          <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground/70">
            X
          </span>
          <Select
            value={chartState.xColumn}
            onValueChange={handleXColumnChange}
          >
            <SelectTrigger className="h-7 w-[110px] text-[0.7rem] bg-muted/30 border-border/40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {X_AXIS_OPTIONS.map((opt) => (
                <SelectItem key={opt.key} value={opt.key}>
                  {opt.label}
                  {opt.unit ? ` (${opt.unit})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Separator */}
        <div className="h-4 w-px bg-border/30" />

        {/* Y label */}
        <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground/70">
          Y
        </span>

        {/* Add quantity */}
        {hasAvailable && (
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-[0.65rem] font-semibold border-dashed border-border/40 text-muted-foreground hover:text-foreground hover:border-primary/40"
              onClick={() => setAddPopoverOpen(!addPopoverOpen)}
            >
              <Plus size={12} />
              Add
              <ChevronDown
                size={10}
                className={cn(
                  "transition-transform",
                  addPopoverOpen && "rotate-180",
                )}
              />
            </Button>
            {addPopoverOpen && (
              <>
                {/* Backdrop */}
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setAddPopoverOpen(false)}
                />
                {/* Dropdown */}
                <div className="absolute left-0 top-full z-50 mt-1.5 w-[240px] rounded-lg border border-border/50 bg-popover/95 backdrop-blur-xl shadow-xl shadow-black/20 overflow-hidden">
                  <div className="max-h-[340px] overflow-y-auto py-1">
                    {availableGroups.map((group) => (
                      <div key={group.category}>
                        <div className="px-3 pt-2 pb-1 text-[0.58rem] font-bold uppercase tracking-[0.12em] text-muted-foreground/50">
                          {group.label}
                        </div>
                        {group.items.map((item) => (
                          <button
                            key={item.key}
                            type="button"
                            className={cn(
                              "flex w-full items-center gap-2 px-3 py-1.5 text-[0.7rem] text-foreground/80 hover:bg-accent/50 hover:text-foreground transition-colors",
                              !item.scalarNative && "opacity-60",
                            )}
                            onClick={() => handleAddSeries(item.key)}
                            disabled={!item.scalarNative}
                            title={
                              item.scalarNative
                                ? undefined
                                : "History-derived — not yet available (requires backend chart_history)"
                            }
                          >
                            <span className="font-medium">{item.label}</span>
                            {!item.scalarNative && (
                              <Info size={10} className="text-muted-foreground/40 shrink-0" />
                            )}
                            {item.unit && (
                              <span className="ml-auto text-[0.6rem] text-muted-foreground/50">
                                {item.unit}
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* Active series badges */}
        <div className="flex flex-wrap items-center gap-1">
          {chartState.activeSeriesKeys.map((key, i) => {
            const entry = resolveSeriesEntry(key);
            const color = seriesColor(i);
            return (
              <Badge
                key={key}
                variant="outline"
                className="h-6 gap-1 pl-2 pr-1 text-[0.62rem] font-semibold border-border/30 bg-muted/15 hover:bg-muted/30 transition-colors group"
                style={{
                  borderLeftColor: color,
                  borderLeftWidth: 3,
                }}
              >
                <span style={{ color }}>
                  {entry?.label ?? key}
                </span>
                {entry?.unit && (
                  <span className="text-muted-foreground/40 ml-0.5">
                    ({entry.unit})
                  </span>
                )}
                <button
                  type="button"
                  className="ml-0.5 rounded-sm p-0.5 opacity-40 hover:opacity-100 hover:bg-destructive/20 transition-all"
                  onClick={() => handleRemoveSeries(key)}
                  title={`Remove ${entry?.label ?? key}`}
                >
                  <X size={10} />
                </button>
              </Badge>
            );
          })}
        </div>
      </div>
    </div>
  );
}
