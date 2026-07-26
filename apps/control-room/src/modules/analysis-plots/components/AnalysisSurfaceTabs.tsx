import type { KeyboardEvent } from "react";

import type { AnalysisWorkbenchSurface } from "@/kernel/workspace/analysisPlotsWorkspace";
import { Button } from "@/shared/ui/Button";

const SURFACES: readonly { id: AnalysisWorkbenchSurface; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "energy", label: "Energy" },
  { id: "dynamics", label: "Dynamics" },
  { id: "convergence", label: "Convergence" },
  { id: "frequency", label: "Frequency" },
];

export function AnalysisSurfaceTabs({ active, onChange }: { active: AnalysisWorkbenchSurface; onChange: (surface: AnalysisWorkbenchSurface) => void }) {
  return (
    <div aria-label="Analysis workbench surfaces" className="fm-analysis-plots__tabs" role="tablist">
      {SURFACES.map((surface) => (
        <Button
          aria-selected={active === surface.id}
          className="fm-analysis-plots__tab"
          key={surface.id}
          onClick={() => onChange(surface.id)}
          onKeyDown={handleTabKeyDown}
          role="tab"
          size="sm"
          tabIndex={active === surface.id ? 0 : -1}
          type="button"
          variant={active === surface.id ? "primary" : "secondary"}
        >
          {surface.label}
        </Button>
      ))}
    </div>
  );
}

function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
  const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
  const current = tabs.indexOf(event.currentTarget);
  const target = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : event.key === "ArrowRight" ? tabs[(current + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(current - 1 + tabs.length) % tabs.length] : null;
  if (!target) return;
  event.preventDefault();
  target.focus();
  target.click();
}
