"use client";

import { useKernel } from "@/kernel/KernelContext";
import {
  commitCrossSectionDraft,
  updateCrossSectionDraft,
  type CrossSectionDraft,
} from "@/kernel/workspace/crossSectionWorkspace";
import { Button } from "@/shared/ui/Button";

import { MeshResourceEmpty } from "./MeshResourceView";
import { CrossSectionSettingsEditor } from "./CrossSectionSettingsEditor";

export function CrossSectionDraftEditor({
  draft,
}: {
  draft: CrossSectionDraft | null;
}) {
  const kernel = useKernel();

  if (!draft) {
    return <MeshResourceEmpty label="No editable cross-section draft." />;
  }

  const updateDraft = (patch: Partial<CrossSectionDraft>) => {
    updateCrossSectionDraft(patch);
  };
  const commitDraft = () => {
    const plot = commitCrossSectionDraft();
    if (!plot) return;

    const nodeId = `model:visualizations-2d:${plot.id}`;
    kernel.selection.set(
      {
        kind: "mesh.cross-section.plot",
        label: plot.name,
        nodeId,
        objectId: null,
        ref: {
          kind: "mesh.cross-section.plot",
          nodeId,
          plotId: plot.id,
          type: "cross-section-plot",
          visualizationTargetId: `cross-section:plot:${plot.id}`,
        },
      },
      "inspector",
    );
    kernel.layout.setActiveViewportMainModule("cross-section-image");
    kernel.layout.setFocusedSlot("viewport-main");
    kernel.layout.setPanelVisible("right", true);
  };

  return (
    <div className="fm-cross-section-inspector">
      <CrossSectionSettingsEditor
        value={draft}
        onChange={updateDraft}
        action={
          <Button size="sm" type="button" variant="primary" onClick={commitDraft}>
            Generate Image
          </Button>
        }
      />
    </div>
  );
}
