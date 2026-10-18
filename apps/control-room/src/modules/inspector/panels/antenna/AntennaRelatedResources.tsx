import { useState } from "react";
import type { SceneResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { antennaNavigationLinks } from "@/modules/explorer/public";
import { Button } from "@/shared/ui/Button";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { antennaNavigationScene } from "./AntennaNavigationScene";

export function AntennaRelatedResources({ scene, selection, scope, available }: {
  scene: SceneResource | null; selection: Selection; scope: string | null; available: boolean;
}) {
  const kernel = useKernel();
  const [error, setError] = useState<string | null>(null);
  const links = scene ? antennaNavigationLinks(scene, selection) : [];
  if (!links.length) return null;
  return <InspectorGroup title="Related resources">
    {links.map(link => <div key={link.key}>
      <Button type="button" variant="secondary" className="h-auto min-h-fm-control-md w-full justify-start py-2 text-left whitespace-normal break-words" disabled={!available || !link.selection} onClick={() => {
        const current = antennaNavigationScene(kernel, scope);
        const target = current ? antennaNavigationLinks(current, selection).find(item => item.key === link.key) : null;
        if (!target?.selection) { setError("The related resource changed or is unavailable. Refresh the Inspector before navigating."); return; }
        setError(null);
        kernel.selection.set(target.selection, "inspector");
      }}>Open {link.label}{link.selection && link.selection.label !== link.label ? ` · ${link.selection.label}` : ""}</Button>
      {link.reason ? <p className="fm-inspector-hint">{link.reason}</p> : null}
    </div>)}
    {error ? <p role="alert">{error}</p> : null}
  </InspectorGroup>;
}
