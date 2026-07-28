import type { AnalysisWorkbenchSurface } from "@/kernel/workspace/analysisPlotsWorkspace";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

const SURFACES: readonly { id: AnalysisWorkbenchSurface; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "energy", label: "Energy" },
  { id: "dynamics", label: "Dynamics" },
  { id: "convergence", label: "Convergence" },
  { id: "frequency", label: "Frequency" },
];

export function AnalysisSurfaceTabs({ active, onChange }: { active: AnalysisWorkbenchSurface; onChange: (surface: AnalysisWorkbenchSurface) => void }) {
  return (
    <Tabs
      aria-label="Analysis workbench surfaces"
      className="fm-analysis-plots__tabs"
      onValueChange={(value) => onChange(value as AnalysisWorkbenchSurface)}
      value={active}
    >
      <TabsList aria-label="Analysis workbench surfaces" presentation="segmented">
      {SURFACES.map((surface) => (
        <TabsTrigger
          className="fm-analysis-plots__tab"
          key={surface.id}
          value={surface.id}
        >
          {surface.label}
        </TabsTrigger>
      ))}
      </TabsList>
    </Tabs>
  );
}
