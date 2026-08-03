import type { AnalysisSurface } from "@/kernel/workspace/analysisViewPreferences";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

const SURFACES: readonly { id: AnalysisSurface; label: string }[] = [
  { id: "dynamics", label: "Dynamics" }, { id: "spectrum", label: "Spectrum" },
  { id: "frequency-response", label: "Frequency Response" }, { id: "eigenmodes", label: "Eigenmodes" },
  { id: "dispersion", label: "Dispersion" }, { id: "hysteresis", label: "Hysteresis" }, { id: "comparison", label: "Comparison" },
];

export function AnalysisSurfaceTabs({ active, onChange }: { active: AnalysisSurface; onChange: (surface: AnalysisSurface) => void }) {
  return <Tabs aria-label="Analysis workbench surfaces" className="fm-analysis-plots__tabs" onValueChange={(value) => onChange(value as AnalysisSurface)} value={active}>
    <TabsList aria-label="Analysis workbench surfaces" presentation="segmented">{SURFACES.map((surface) => <TabsTrigger className="fm-analysis-plots__tab" key={surface.id} value={surface.id}>{surface.label}</TabsTrigger>)}</TabsList>
  </Tabs>;
}
