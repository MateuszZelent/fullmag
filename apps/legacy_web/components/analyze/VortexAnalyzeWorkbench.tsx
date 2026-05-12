"use client";

import { useMemo, useState, useCallback } from "react";
import { Activity, BarChart3, CircleDot, Orbit } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import EmptyState from "@/components/ui/EmptyState";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

import VortexTimeTracePlot from "./VortexTimeTracePlot";
import VortexFrequencyPlot from "./VortexFrequencyPlot";
import VortexTrajectoryPlot from "./VortexTrajectoryPlot";
import VortexOrbitPlot from "./VortexOrbitPlot";
import { computeVortexSpectrum, estimateLinewidth } from "./vortexSpectrum";
import type {
  VortexTimeSample,
  VortexSpectrumConfig,
  VortexSpectrumResult,
  LinewidthResult,
  VortexChannel,
} from "./vortexTypes";
import { DEFAULT_SPECTRUM_CONFIG, VORTEX_CHANNELS } from "./vortexTypes";
import type { AnalyzeTab } from "../runs/control-room/analyzeSelection";

interface VortexAnalyzeWorkbenchProps {
  samples: VortexTimeSample[];
  activeTab: AnalyzeTab;
  onTabChange: (tab: AnalyzeTab) => void;
  selectedChannel?: VortexChannel | null;
}

function fmtGHz(hz: number): string {
  return `${(hz / 1e9).toFixed(4)} GHz`;
}

function fmtMHz(hz: number): string {
  return `${(hz / 1e6).toFixed(1)} MHz`;
}

export default function VortexAnalyzeWorkbench({
  samples,
  activeTab,
  onTabChange,
  selectedChannel,
}: VortexAnalyzeWorkbenchProps) {
  const [spectrumConfig, setSpectrumConfig] =
    useState<VortexSpectrumConfig>(DEFAULT_SPECTRUM_CONFIG);
  const [logScale, setLogScale] = useState(true);

  const spectrum: VortexSpectrumResult | null = useMemo(() => {
    if (samples.length < 4) return null;
    return computeVortexSpectrum(samples, spectrumConfig);
  }, [samples, spectrumConfig]);

  const linewidth: LinewidthResult | null = useMemo(() => {
    if (!spectrum?.peak_frequency_hz || spectrum.frequencies.length === 0)
      return null;
    const ch = spectrum.peak_channel ?? "mx";
    const psd =
      ch === "mx"
        ? spectrum.psd_mx
        : ch === "my"
          ? spectrum.psd_my
          : spectrum.psd_mz;
    return estimateLinewidth(
      spectrum.frequencies,
      psd,
      spectrum.peak_frequency_hz,
    );
  }, [spectrum]);

  const handleDiscardChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val >= 0) {
        setSpectrumConfig((prev) => ({
          ...prev,
          discardTransientS: val * 1e-9,
        }));
      }
    },
    [],
  );

  if (samples.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          title="No time-domain data"
          description="Run a TimeEvolution or Relaxation study to collect mx(t), my(t), mz(t) scalar outputs."
          tone="info"
          compact
        />
      </div>
    );
  }

  const tabValue =
    activeTab === "time-traces" ||
    activeTab === "vortex-trajectory" ||
    activeTab === "vortex-frequency" ||
    activeTab === "vortex-orbit"
      ? activeTab
      : "time-traces";

  const totalTimeNs = samples.length > 1
    ? (samples[samples.length - 1].time - samples[0].time) * 1e9
    : 0;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      {/* Header bar */}
      <div className="shrink-0 border-b border-border/30 bg-card/30 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-sm border border-border/40 bg-muted/50 px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-widest text-muted-foreground">
            Vortex Analysis
          </span>
          <span className="rounded-sm border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[0.62rem] font-bold tracking-widest text-emerald-200">
            {samples.length} samples
          </span>
          <span className="rounded-sm border border-sky-500/25 bg-sky-500/10 px-1.5 py-0.5 text-[0.62rem] font-bold tracking-widest text-sky-200">
            {totalTimeNs.toFixed(2)} ns
          </span>
          {spectrum?.peak_frequency_hz != null && (
            <span className="rounded-sm border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[0.62rem] font-bold tracking-widest text-amber-200">
              f₀ = {fmtGHz(spectrum.peak_frequency_hz)}
            </span>
          )}
          {linewidth && linewidth.fwhm_hz > 0 && (
            <span className="rounded-sm border border-rose-500/25 bg-rose-500/10 px-1.5 py-0.5 text-[0.62rem] font-bold tracking-widest text-rose-200">
              Δf = {fmtMHz(linewidth.fwhm_hz)}
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        value={tabValue}
        onValueChange={(v) => onTabChange(v as AnalyzeTab)}
        className="flex h-full min-h-0 flex-col"
      >
        <div className="shrink-0 border-b border-border/20 px-3 pt-2">
          <TabsList className="h-7 gap-0.5 bg-transparent p-0">
            <TabsTrigger value="time-traces" className="h-7 gap-1 px-3 text-[0.72rem]">
              <Activity size={12} /> Time Traces
            </TabsTrigger>
            <TabsTrigger value="vortex-frequency" className="h-7 gap-1 px-3 text-[0.72rem]">
              <BarChart3 size={12} /> FFT / PSD
            </TabsTrigger>
            <TabsTrigger value="vortex-trajectory" className="h-7 gap-1 px-3 text-[0.72rem]">
              <CircleDot size={12} /> Trajectory
            </TabsTrigger>
            <TabsTrigger value="vortex-orbit" className="h-7 gap-1 px-3 text-[0.72rem]">
              <Orbit size={12} /> Orbit
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="time-traces" className="flex-1 min-h-0 p-3">
          <VortexTimeTracePlot
            samples={samples}
            selectedChannel={selectedChannel ?? undefined}
          />
        </TabsContent>

        <TabsContent value="vortex-frequency" className="flex-1 min-h-0 flex flex-col gap-2 p-3">
          {/* Controls bar */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground mb-1">
            <label className="flex items-center gap-1.5 h-8">
              Discard transient:
              <Input
                type="number"
                min={0}
                step={0.1}
                className="w-20 h-7 text-xs bg-muted/40"
                defaultValue={0}
                onChange={handleDiscardChange}
              />
              <span className="text-muted-foreground/60">ns</span>
            </label>
            <label className="flex items-center gap-1.5 h-8">
              <Switch
                checked={logScale}
                onCheckedChange={setLogScale}
              />
              Log scale
            </label>
            <Select
              value={spectrumConfig.window}
              onValueChange={(val) =>
                setSpectrumConfig((prev) => ({
                  ...prev,
                  window: val as VortexSpectrumConfig["window"],
                }))
              }
            >
              <SelectTrigger className="w-32 h-7 text-xs bg-muted/40">
                <SelectValue placeholder="Window" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hann">Hann</SelectItem>
                <SelectItem value="hamming">Hamming</SelectItem>
                <SelectItem value="blackman">Blackman</SelectItem>
                <SelectItem value="none">None</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 min-h-0">
            <VortexFrequencyPlot
              spectrum={spectrum}
              linewidth={linewidth}
              logScale={logScale}
            />
          </div>
        </TabsContent>

        <TabsContent value="vortex-trajectory" className="flex-1 min-h-0 p-3">
          <VortexTrajectoryPlot samples={samples} />
        </TabsContent>

        <TabsContent value="vortex-orbit" className="flex-1 min-h-0 p-3">
          <VortexOrbitPlot samples={samples} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
